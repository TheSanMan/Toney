#include "LiveSession.h"
#include "Assets.h"
#include "JsonSyntax.h"
#include <algorithm>
#include <cmath>
#include <set>

namespace toney
{
#if JUCE_MAC
void requestLiveInputPermission();
#else
void requestLiveInputPermission() {}
#endif
static_assert(std::atomic<float>::is_always_lock_free && std::atomic<juce::int64>::is_always_lock_free
              && std::atomic<RealtimeProcessor*>::is_always_lock_free, "Live metrics must be lock free.");

LiveAudioCallback::LiveAudioCallback(double sampleRate, int bufferSize, int inputChannel)
    : rate(sampleRate), buffer(bufferSize), channel(inputChannel), fadeLength(static_cast<int>(sampleRate * 0.02)) {}
void LiveAudioCallback::publish(RealtimeProcessor* graph) noexcept { published.store(graph, std::memory_order_release); }
RealtimeProcessor* LiveAudioCallback::completed() const noexcept { return acknowledged.load(std::memory_order_acquire); }
void LiveAudioCallback::expectStop() noexcept { stopping.store(true); }
void LiveAudioCallback::audioDeviceAboutToStart(juce::AudioIODevice* device)
{
    if (device->getCurrentSampleRate() != rate || device->getCurrentBufferSizeSamples() != buffer)
        fault.store(2);
}
void LiveAudioCallback::audioDeviceStopped() { if (!stopping.load()) fault.store(1); }
void LiveAudioCallback::audioDeviceError(const juce::String&) { fault.store(1); }

void LiveAudioCallback::audioDeviceIOCallbackWithContext(const float* const* inputs, int inputCount,
    float* const* outputs, int outputCount, int frames, const juce::AudioIODeviceCallbackContext&)
{
    const auto start = juce::Time::getHighResolutionTicks();
    for (int c = 0; c < outputCount; ++c)
        if (outputs[c] != nullptr) juce::FloatVectorOperations::clear(outputs[c], frames);
    if (frames <= 0 || fault.load() != 0 || stopping.load()) return;
    if (channel >= inputCount || inputs[channel] == nullptr) { fault.store(3); return; }
    auto* next = published.load(std::memory_order_acquire);
    if (next == nullptr) return;
    if (next != current)
    {
        previous = current;
        current = next;
        fadeRemaining = fadeLength;
    }
    float inPeak = 0, outPeak = 0;
    for (int offset = 0; offset < frames; offset += 512)
    {
        const auto count = std::min(512, frames - offset);
        const auto* input = inputs[channel] + offset;
        for (int i = 0; i < count; ++i)
        {
            if (!std::isfinite(input[i]))
            {
                fault.store(4);
                for (int c = 0; c < outputCount; ++c)
                    if (outputs[c] != nullptr) juce::FloatVectorOperations::clear(outputs[c], frames);
                return;
            }
            inPeak = std::max(inPeak, std::abs(input[i]));
        }
        current->process(input, wet.data(), count);
        if (previous != nullptr && fadeRemaining > 0) previous->process(input, oldWet.data(), count);
        if (current->failed() || (previous != nullptr && previous->failed()))
        {
            fault.store(4);
            for (int c = 0; c < outputCount; ++c)
                if (outputs[c] != nullptr) juce::FloatVectorOperations::clear(outputs[c], frames);
            return;
        }
        for (int i = 0; i < count; ++i)
        {
            auto sample = wet[static_cast<std::size_t>(i)];
            if (fadeRemaining > 0)
            {
                const auto fraction = 1.0f - static_cast<float>(fadeRemaining) / static_cast<float>(fadeLength);
                const auto old = previous != nullptr ? oldWet[static_cast<std::size_t>(i)] : 0.0f;
                sample = old * (1.0f - fraction) + sample * fraction;
                --fadeRemaining;
            }
            outPeak = std::max(outPeak, std::abs(sample));
            // The first two active hardware outputs carry identical mono guitar.
            for (int c = 0; c < std::min(outputCount, 2); ++c)
                if (outputs[c] != nullptr) outputs[c][offset + i] = sample;
        }
        if (fadeRemaining == 0) previous = nullptr;
    }
    if (fadeRemaining == 0) acknowledged.store(current, std::memory_order_release);
    const auto decay = static_cast<float>(std::exp(-frames / (rate * 0.35)));
    inputPeak.store(std::max(inPeak, inputPeak.load() * decay));
    outputPeak.store(std::max(outPeak, outputPeak.load() * decay));
    const auto elapsed = juce::Time::highResolutionTicksToSeconds(juce::Time::getHighResolutionTicks() - start);
    const auto load = static_cast<float>(elapsed * rate / frames);
    cpuLoad.store(cpuLoad.load() * 0.9f + load * 0.1f);
    if (load > 1) overruns.fetch_add(1);
    callbackCount.fetch_add(1);
}

namespace
{
void fields(const juce::var& object, const std::set<juce::String>& allowed)
{
    if (object.getDynamicObject() == nullptr) throw ControlError("INVALID_REQUEST", "Expected an object.");
    for (const auto& item : object.getDynamicObject()->getProperties())
        if (allowed.count(item.name.toString()) == 0) throw ControlError("INVALID_REQUEST", "Unknown live control field.");
}
double number(const juce::var& object, const char* key, double minimum, double maximum, bool integer = false)
{
    const auto value = object[key];
    if (!value.isInt() && !value.isInt64() && !value.isDouble())
        throw ControlError("INVALID_REQUEST", juce::String(key) + " must be numeric.");
    const auto n = static_cast<double>(value);
    if (!std::isfinite(n) || n < minimum || n > maximum || (integer && std::floor(n) != n))
        throw ControlError("INVALID_REQUEST", juce::String(key) + " is outside the supported live range.");
    return n;
}
juce::String text(const juce::var& object, const char* key)
{
    const auto value = object[key];
    if (!value.isString() || value.toString().isEmpty() || value.toString().length() > 1024)
        throw ControlError("INVALID_REQUEST", juce::String(key) + " must be a nonempty device ID.");
    return value.toString();
}
struct DeviceChoice { juce::AudioIODeviceType* type; juce::String name; };
void validateLiveTone(const juce::var& tone)
{
    validateTone(tone);
    int neural = 0, cabinets = 0;
    for (const auto& node : *tone["chain"].getArray())
        if (static_cast<bool>(node["enabled"]))
        {
            if (node["model"].toString() == "nam") ++neural;
            if (node["model"].toString() == "cab_ir") ++cabinets;
        }
    if (neural > 5 || cabinets > 1)
        throw ControlError("LIVE_RIG_TOO_COMPLEX", "Live rigs support up to five NAM nodes (four pedals and an amp) and one cabinet IR. Bypass extra capture nodes before starting.");
}
DeviceChoice resolve(juce::OwnedArray<juce::AudioIODeviceType>& types, const juce::String& id, bool input)
{
    for (auto* type : types)
    {
        type->scanForDevices();
        const auto names = type->getDeviceNames(input);
        for (int i = 0; i < names.size(); ++i)
            if (id == type->getTypeName() + (input ? ":input:" : ":output:") + juce::String(i) + ":" + names[i])
                return {type, names[i]};
    }
    throw ControlError("LIVE_DEVICE_NOT_FOUND", "The selected device changed or disconnected. Rescan and select it again.");
}
}

struct LiveSession::Impl
{
    juce::OwnedArray<juce::AudioIODeviceType> types;
    std::unique_ptr<juce::AudioIODevice> device;
    std::unique_ptr<RealtimeProcessor> graph, retired;
    std::unique_ptr<LiveAudioCallback> callback;
    juce::String state {"stopped"}, toneId, inputId, outputId, errorCode, errorMessage;
    juce::int64 revision = 0;
    double rate = 0, latency = 0;
    int buffer = 0, channel = 0, inputChannels = 0, outputChannels = 0;

    void close()
    {
        if (callback) callback->expectStop();
        if (device) { device->stop(); device->close(); }
        device.reset();
        // stop() has joined the callback before graph reclamation.
        retired.reset(); graph.reset();
    }
    void clear()
    {
        close(); callback.reset(); state = "stopped";
        toneId.clear(); inputId.clear(); outputId.clear(); errorCode.clear(); errorMessage.clear();
        revision = 0; rate = 0; latency = 0; buffer = 0; channel = 0; inputChannels = 0; outputChannels = 0;
    }
    void collect() { if (retired && callback->completed() == graph.get()) retired.reset(); }
    juce::var status()
    {
        if (callback && state == "running")
        {
            if (callback->fault.load() != 0)
            {
                const auto fault = callback->fault.load();
                errorCode = fault == 4 ? "LIVE_DSP_FAILED" : fault == 2 ? "LIVE_DEVICE_CHANGED" : "LIVE_DEVICE_LOST";
                errorMessage = fault == 4 ? "Audio processing produced invalid samples. Monitoring stopped."
                    : "The audio device stopped or changed. Rescan, check permission and restart monitoring.";
                close(); state = "error";
            }
            else collect();
        }
        return makeObject({{"kind", "live-status"}, {"state", state}, {"toneId", toneId}, {"revision", revision},
            {"sampleRate", rate}, {"bufferSize", buffer}, {"inputDeviceId", inputId}, {"outputDeviceId", outputId},
            {"inputChannel", channel}, {"inputChannels", inputChannels}, {"outputChannels", outputChannels},
            {"inputPeak", callback ? callback->inputPeak.load() : 0.0f}, {"outputPeak", callback ? callback->outputPeak.load() : 0.0f},
            {"callbackCount", callback ? callback->callbackCount.load() : juce::int64(0)},
            {"overruns", callback ? callback->overruns.load() : juce::int64(0)},
            {"cpuLoad", callback ? callback->cpuLoad.load() : 0.0f}, {"latencyMs", latency},
            {"errorCode", errorCode}, {"errorMessage", errorMessage}});
    }
    void start(const juce::var& request)
    {
        if (state == "running") throw ControlError("LIVE_ALREADY_RUNNING", "Stop monitoring before changing the audio device.");
        validateLiveTone(request["tone"]);
        const auto live = request["live"];
        fields(live, {"inputDeviceId", "outputDeviceId", "inputChannel", "sampleRate", "bufferSize", "inputGainDb", "outputGainDb", "assets"});
        const auto newInput = text(live, "inputDeviceId"), newOutput = text(live, "outputDeviceId");
        const auto newChannel = static_cast<int>(number(live, "inputChannel", 0, 31, true));
        const auto newRate = number(live, "sampleRate", 44100, 96000, true);
        const auto newBuffer = static_cast<int>(number(live, "bufferSize", 64, 512, true));
        if ((newRate != 44100 && newRate != 48000 && newRate != 96000)
            || (newBuffer != 64 && newBuffer != 128 && newBuffer != 256 && newBuffer != 512))
            throw ControlError("INVALID_REQUEST", "Unsupported sample rate or buffer size.");
        const auto inGain = number(live, "inputGainDb", -24, 24), outGain = number(live, "outputGainDb", -60, 0);
        AssetLibrary assets(request["tone"], live["assets"]);
        auto prepared = std::make_unique<RealtimeProcessor>(request["tone"], newRate, &assets, inGain, outGain);
        if (types.isEmpty()) { juce::AudioDeviceManager inventory; inventory.createAudioDeviceTypes(types); }
        const auto input = resolve(types, newInput, true), output = resolve(types, newOutput, false);
        if (input.type != output.type) throw ControlError("LIVE_DEVICE_BACKEND_MISMATCH", "Choose input and output from the same audio backend.");
        std::unique_ptr<juce::AudioIODevice> selected(input.type->createDevice(output.name, input.name));
        if (!selected) throw ControlError("LIVE_DEVICE_OPEN_FAILED", "Could not create the selected audio device.");
        const auto inputs = selected->getInputChannelNames().size(), outputs = selected->getOutputChannelNames().size();
        if (newChannel >= inputs || outputs < 1) throw ControlError("LIVE_CHANNEL_UNAVAILABLE", "Choose an available instrument input and a device with audio output.");
        if (!selected->getAvailableSampleRates().contains(newRate))
            throw ControlError("LIVE_SAMPLE_RATE_UNSUPPORTED", "The selected device does not support this sample rate.");
        if (!selected->getAvailableBufferSizes().contains(newBuffer))
            throw ControlError("LIVE_BUFFER_SIZE_UNSUPPORTED", "The selected device does not support this buffer size. Try 256 or 512 frames.");
        // Enable inputs through the chosen channel to keep array indexing stable
        // across JUCE backends that pack active channels. Only that channel is read.
        juce::BigInteger inputBits, outputBits;
        inputBits.setRange(0, newChannel + 1, true);
        outputBits.setRange(0, std::min(2, outputs), true);
        requestLiveInputPermission();
        const auto error = selected->open(inputBits, outputBits, newRate, newBuffer);
        if (error.isNotEmpty()) { selected->close(); throw ControlError("LIVE_DEVICE_OPEN_FAILED", "Could not open the selected input/output. Check microphone permission, device connection and other audio apps."); }
        if (selected->getCurrentSampleRate() != newRate || selected->getCurrentBufferSizeSamples() != newBuffer
            || !selected->getActiveInputChannels()[newChannel] || selected->getActiveOutputChannels().isZero())
        {
            selected->close(); throw ControlError("LIVE_DEVICE_CONFIGURATION_FAILED", "The device did not accept the requested channels, sample rate or buffer size.");
        }
        clear();
        graph = std::move(prepared);
        callback = std::make_unique<LiveAudioCallback>(newRate, newBuffer, newChannel);
        callback->publish(graph.get());
        rate = newRate; buffer = newBuffer; channel = newChannel; inputChannels = inputs; outputChannels = std::min(2, outputs);
        toneId = request["tone"]["id"].toString(); revision = static_cast<juce::int64>(request["tone"]["revision"]);
        inputId = newInput; outputId = newOutput;
        latency = (selected->getInputLatencyInSamples() + selected->getOutputLatencyInSamples()
            + graph->latencySamples() + buffer) * 1000.0 / rate;
        device = std::move(selected); state = "running";
        device->start(callback.get());
        if (!device->isPlaying()) { clear(); throw ControlError("LIVE_DEVICE_START_FAILED", "The audio device could not start. Check microphone permission and retry."); }
    }
    void update(const juce::var& request)
    {
        status();
        if (state != "running") throw ControlError("LIVE_NOT_RUNNING", "Start live monitoring before applying a rig.");
        collect();
        if (retired) throw ControlError("LIVE_UPDATE_PENDING", "The previous rig is still switching. Try again shortly.");
        validateLiveTone(request["tone"]);
        const auto live = request["live"];
        fields(live, {"inputGainDb", "outputGainDb", "assets"});
        const auto inGain = number(live, "inputGainDb", -24, 24), outGain = number(live, "outputGainDb", -60, 0);
        AssetLibrary assets(request["tone"], live["assets"]);
        auto prepared = std::make_unique<RealtimeProcessor>(request["tone"], rate, &assets, inGain, outGain);
        retired = std::move(graph); graph = std::move(prepared);
        callback->publish(graph.get());
        toneId = request["tone"]["id"].toString(); revision = static_cast<juce::int64>(request["tone"]["revision"]);
    }
};

LiveSession::LiveSession() : impl(std::make_unique<Impl>()) {}
LiveSession::~LiveSession() { impl->close(); }
juce::var LiveSession::handle(const juce::String& json)
{
    juce::String id;
    try
    {
        if (json.getNumBytesAsUTF8() > maxRequestBytes) throw ControlError("REQUEST_TOO_LARGE", "Request exceeds 1 MiB.");
        std::string safe;
        juce::var request;
        if (!hasValidJsonSyntax(json.toStdString(), safe) || juce::JSON::parse(juce::String(safe), request).failed())
            throw ControlError("INVALID_REQUEST", "Expected a valid live request.");
        fields(request, {"protocolVersion", "requestId", "command", "tone", "live"});
        if (!request["requestId"].isString() || request["requestId"].toString().isEmpty()
            || request["requestId"].toString().length() > 128
            || !request["requestId"].toString().containsOnly("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.:"))
            throw ControlError("INVALID_REQUEST", "Invalid requestId.");
        id = request["requestId"].toString();
        number(request, "protocolVersion", 1, 1, true);
        if (!request["command"].isString()) throw ControlError("INVALID_REQUEST", "Expected a live command.");
        const auto command = request["command"].toString();
        if (command != "start_live" && command != "update_live" && command != "get_live_status" && command != "stop_live")
            throw ControlError("UNKNOWN_COMMAND", "Unsupported live command.");
        if (command == "get_live_status" || command == "stop_live")
        {
            if (request.hasProperty("tone") || request.hasProperty("live"))
                throw ControlError("INVALID_REQUEST", "Status and Stop forbid rig/configuration fields.");
            if (command == "stop_live") impl->clear();
        }
        else if (command == "start_live") impl->start(request);
        else impl->update(request);
        return makeObject({{"protocolVersion", protocolVersion}, {"requestId", id}, {"ok", true}, {"result", impl->status()}});
    }
    catch (const ControlError& error) { return errorResponse(id, error.code, error.message); }
    catch (...) { return errorResponse(id, "LIVE_CONTROL_FAILED", "Live audio control failed. Stop and retry monitoring."); }
}
}
