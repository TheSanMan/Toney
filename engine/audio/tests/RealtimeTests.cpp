#include "RealtimeProcessing.h"
#include "LiveSession.h"
#include "EffectProcessing.h"
#include "Assets.h"
#include "WaveFiles.h"
#include <juce_cryptography/juce_cryptography.h>
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <limits>
#include <new>
#include <vector>
#include <json.hpp>
#if JUCE_MAC
#include <dlfcn.h>
#include <cstdint>
#include <pthread.h>
#endif

namespace {
std::atomic<bool> audit {false};
std::atomic<int> allocations {0};
#if JUCE_MAC
pthread_t auditedThread;
#endif
bool audited() {
#if JUCE_MAC
    return audit.load() && pthread_equal(pthread_self(), auditedThread);
#else
    return audit.load();
#endif
}
}
#if JUCE_MAC
// Test-only Apple allocator hook also observes Eigen's malloc/aligned allocations.
// Production engine does not install hooks or depend on this private symbol.
using MallocLogger = void(std::uint32_t, std::uintptr_t, std::uintptr_t, std::uintptr_t, std::uintptr_t, std::uint32_t);
MallocLogger* previousLogger = nullptr;
void countMalloc(std::uint32_t type, std::uintptr_t a, std::uintptr_t b, std::uintptr_t c, std::uintptr_t result, std::uint32_t skip)
{
    if (audited() && (type & 2u) != 0) ++allocations;
    if (previousLogger) previousLogger(type, a, b, c, result, skip);
}
#endif
void* operator new(std::size_t size) { if (audited()) ++allocations; if (auto* p = std::malloc(size ? size : 1)) return p; throw std::bad_alloc(); }
void* operator new[](std::size_t size) { return ::operator new(size); }
void operator delete(void* value) noexcept { std::free(value); }
void operator delete[](void* value) noexcept { std::free(value); }

namespace
{
int checks = 0, failures = 0;
void expect(bool ok, const char* label) { ++checks; if (!ok) { ++failures; std::cerr << "FAIL: " << label << '\n'; } }
juce::var fixture()
{
    return juce::JSON::parse(R"({"schemaVersion":2,"id":"live-test","name":"Realtime fixture","revision":7,
      "chain":[
      {"id":"compressor","type":"compressor","model":"builtin_compressor","enabled":true,"parameters":{"amount":0.2,"attack":0.7}},
      {"id":"drive","type":"drive","model":"builtin_drive","enabled":true,"parameters":{"gain":0.15,"tone":0.5,"level":0.6}},
      {"id":"amp","type":"amp","model":"builtin_amp","enabled":true,"parameters":{"gain":0.25,"bass":0.5,"mid":0.55,"treble":0.5,"master":0.65}},
      {"id":"cab","type":"cab","model":"builtin_cab","enabled":true,"parameters":{"brightness":0.5,"resonance":0.35}},
      {"id":"eq","type":"eq","model":"builtin_eq","enabled":true,"parameters":{"lowDb":-3,"midDb":0,"highDb":2}},
      {"id":"chorus","type":"chorus","model":"builtin_chorus","enabled":true,"parameters":{"rate":1.5,"depth":0.3,"mix":0.2}},
      {"id":"delay","type":"delay","model":"builtin_delay","enabled":true,"parameters":{"time":0.05,"feedback":0.4,"mix":0.2}},
      {"id":"reverb","type":"reverb","model":"builtin_reverb","enabled":true,"parameters":{"decay":1.5,"mix":0.12}}],
      "metadata":{"createdAt":"2026-10-03T10:00:00Z","updatedAt":"2026-10-03T10:00:00Z","source":"test"}})");
}
juce::var dry()
{
    auto tone = fixture();
    for (auto& node : *tone["chain"].getArray()) node.getDynamicObject()->setProperty("enabled", false);
    return tone;
}
double difference(const std::vector<float>& a, const std::vector<float>& b)
{
    double result = 0;
    for (std::size_t i = 0; i < a.size(); ++i) result = std::max(result, std::abs(static_cast<double>(a[i] - b[i])));
    return result;
}
std::vector<float> render(toney::RealtimeProcessor& processor, const std::vector<float>& input, int block)
{
    std::vector<float> output(input.size());
    for (int offset = 0; offset < static_cast<int>(input.size()); offset += block)
    {
        audit = true;
        processor.process(input.data() + offset, output.data() + offset, std::min(block, static_cast<int>(input.size()) - offset));
        audit = false;
    }
    return output;
}
juce::var descriptor(const juce::File& file, const char* kind)
{ return toney::makeObject({{"id", juce::SHA256(file).toHexString()}, {"kind", kind}, {"path", file.getFullPathName()}}); }
juce::var request(const char* command) { return toney::makeObject({{"protocolVersion", 1}, {"requestId", "live-contract"}, {"command", command}}); }
}

int main()
{
#if JUCE_MAC
    auto** logger = reinterpret_cast<MallocLogger**>(dlsym(RTLD_DEFAULT, "malloc_logger"));
    if (!logger) { std::cerr << "Allocator audit unavailable.\n"; return 2; }
    auditedThread = pthread_self();
    previousLogger = *logger; *logger = countMalloc;
    const auto mallocFunction = reinterpret_cast<void* (*)(std::size_t)>(dlsym(RTLD_DEFAULT, "malloc"));
    audit = true; auto* probe = mallocFunction(64); audit = false;
    expect(allocations > 0, "macOS audit detects plain malloc outside operator new");
    std::free(probe); allocations = 0;
#endif
    const auto directory = juce::File::getSpecialLocation(juce::File::tempDirectory).getNonexistentChildFile("toney-live-tests", "", false);
    directory.createDirectory();
    try
    {
        std::vector<float> signal(8192);
        for (std::size_t i = 0; i < signal.size(); ++i) signal[i] = static_cast<float>(0.15 * std::sin(i * 0.093) + 0.05 * std::sin(i * 0.177));
        toney::RealtimeProcessor a(fixture(), 48000, nullptr, 0, -12), b(fixture(), 48000, nullptr, 0, -12);
        const auto output = render(a, signal, 512), fragmented = render(b, signal, 73);
        expect(difference(output, fragmented) < 1e-6, "all effects preserve state across different callback partitions");
        expect(difference(output, signal) > 0.01, "builtin graph changes guitar signal");
        expect(allocations == 0, "builtin processing has no C++ heap allocations");
        toney::RealtimeProcessor bypass(dry(), 48000, nullptr, 6, -6);
        expect(difference(render(bypass, signal, 128), signal) < 1e-7, "bypass preserves input with compensating signed trims");
        toney::RealtimeProcessor silent(fixture(), 48000, nullptr, 0, -12);
        expect(difference(render(silent, std::vector<float>(8192), 128), std::vector<float>(8192)) == 0, "fresh builtin graph is silent for silent input");
        toney::RealtimeProcessor clipped(dry(), 48000, nullptr, 24, 0);
        const auto bounded = render(clipped, std::vector<float>(512, 10), 128);
        expect(std::all_of(bounded.begin(), bounded.end(), [](float x) { return std::isfinite(x) && x <= 0.85f; }), "live output remains finite and bounded");
        std::array<float, 512> invalid{}, invalidOut{};
        invalid[10] = std::numeric_limits<float>::quiet_NaN();
        clipped.process(invalid.data(), invalidOut.data(), 128);
        expect(clipped.failed() && std::all_of(invalidOut.begin(), invalidOut.end(), [](float x) { return x == 0; }), "nonfinite input latches fault and silences whole block");

        // Exercise allocations hidden by the tiny official fixtures: multilayer
        // LSTM hidden-state views and gated WaveNet's strided matrix input.
        nlohmann::json multi{{"version", "0.5.4"}, {"sample_rate", 48000}, {"architecture", "LSTM"},
            {"config", {{"input_size", 1}, {"hidden_size", 32}, {"num_layers", 2}}}};
        std::vector<float> multiWeights(33 + 128 * 33 + 192 + 128 * 64 + 192);
        for (std::size_t i = 0; i < multiWeights.size(); ++i) multiWeights[i] = static_cast<float>(0.02 * std::sin(i * 0.37));
        multi["weights"] = multiWeights;
        directory.getChildFile("multilayer.nam").replaceWithText(multi.dump());
        auto gated = nlohmann::json::parse(R"({"version":"0.5.4","sample_rate":48000,"architecture":"WaveNet",
          "config":{"head":null,"head_scale":0.05,"layers":[{"input_size":1,"condition_size":1,"head_size":1,"channels":16,
          "kernel_size":3,"dilations":[1,2,4,8],"activation":"Tanh","gated":true,"head_bias":true}]}})");
        std::vector<float> gatedWeights(1 + 16 + 16 + 1 + 4 * (32 * 16 * 3 + 32 + 32 + 16 * 16 + 16));
        for (std::size_t i = 0; i < gatedWeights.size(); ++i) gatedWeights[i] = static_cast<float>(0.03 * std::sin(i * 0.37));
        gated["weights"] = gatedWeights;
        directory.getChildFile("gated.nam").replaceWithText(gated.dump());
        for (const auto* name : {"lstm.nam", "wavenet.nam", "multilayer.nam", "gated.nam"})
        {
            auto tone = dry();
            auto modelFile = directory.getChildFile(name);
            if (!modelFile.existsAsFile()) modelFile = juce::File(TONEY_NAM_FIXTURES).getChildFile(name);
            const auto asset = descriptor(modelFile, "nam");
            for (int index : {1, 2})
            {
                auto& node = tone["chain"].getArray()->getReference(index);
                node.getDynamicObject()->setProperty("model", "nam");
                node.getDynamicObject()->setProperty("enabled", true);
                node.getDynamicObject()->setProperty("asset", toney::makeObject({{"id", asset["id"]}, {"kind", "nam"}, {"name", name}}));
                const auto keys = node["parameters"].getDynamicObject()->getProperties();
                for (const auto& parameter : keys) node["parameters"].getDynamicObject()->setProperty(parameter.name, 0.5);
            }
            toney::AssetLibrary library(tone, juce::Array<juce::var>{asset});
            toney::RealtimeProcessor neural(tone, 48000, &library, 0, 0), neuralFragments(tone, 48000, &library, 0, 0);
            const auto modeled = render(neural, signal, 128), pieces = render(neuralFragments, signal, 73);
            if (allocations != 0) std::cerr << name << " callback allocations: " << allocations.load() << '\n';
            expect(allocations == 0, "NAM callbacks do not allocate with variable block sizes");
            allocations = 0;
            expect(difference(modeled, pieces) < 1e-6, "NAM pedal/amp state persists across arbitrary block lengths");
            juce::AudioBuffer<float> reference(1, static_cast<int>(signal.size()));
            std::copy(signal.begin(), signal.end(), reference.getWritePointer(0));
            toney::processEffects(reference, 48000, tone, &library);
            std::vector<float> oracle(reference.getReadPointer(0), reference.getReadPointer(0) + signal.size());
            for (auto& x : oracle) x = std::clamp(x, -0.85f, 0.85f);
            expect(difference(modeled, oracle) < 1e-6, "live independent NAM nodes match offline sequential inference");
            bool rejected = false;
            try { toney::RealtimeProcessor mismatch(tone, 44100, &library, 0, 0); }
            catch (const toney::ControlError& error) { rejected = error.code == "LIVE_SAMPLE_RATE_MISMATCH"; }
            expect(rejected, "NAM device-rate mismatch fails before callback");
            expect(!neural.failed(), "actual NAM output is finite");
        }
        auto irTone = dry();
        juce::AudioBuffer<float> impulse(1, 256); impulse.clear(); impulse.setSample(0, 0, 0.5f); impulse.setSample(0, 150, 0.2f);
        const auto irFile = directory.getChildFile("cab.wav"); toney::writeWaveExclusive(irFile, impulse, 48000);
        const auto irAsset = descriptor(irFile, "ir");
        auto& cabinet = irTone["chain"].getArray()->getReference(3);
        cabinet.getDynamicObject()->setProperty("model", "cab_ir"); cabinet.getDynamicObject()->setProperty("enabled", true);
        cabinet.getDynamicObject()->setProperty("asset", toney::makeObject({{"id", irAsset["id"]}, {"kind", "ir"}, {"name", "cab.wav"}}));
        cabinet["parameters"].getDynamicObject()->setProperty("resonance", 0);
        toney::AssetLibrary irLibrary(irTone, juce::Array<juce::var>{irAsset});
        toney::RealtimeProcessor ir(irTone, 48000, &irLibrary, 0, 0), irParts(irTone, 48000, &irLibrary, 0, 0);
        const auto cabbed = render(ir, signal, 128);
        const auto irDifference = difference(cabbed, render(irParts, signal, 73));
        // Different FFT partitions round floats differently (error below -100 dBFS).
        expect(irDifference < 1e-5, "IR state persists across callback partitions within FFT roundoff");
        const auto& kernel = irLibrary.get(irAsset["id"].toString()).impulse->samples;
        std::vector<float> scalar(signal.size());
        for (std::size_t i = 0; i < signal.size(); ++i)
            for (int k = 0; k < kernel.getNumSamples() && static_cast<std::size_t>(k) <= i; ++k)
                scalar[i] += signal[i - static_cast<std::size_t>(k)] * kernel.getSample(0, k);
        expect(difference(cabbed, scalar) < 1e-5, "streaming IR matches independent scalar convolution");
        expect(difference(cabbed, signal) > 0.01, "prepared cabinet IR actually processes samples");
        expect(ir.latencySamples() == 0 && !ir.failed(), "cabinet reports actual zero convolution latency");
        expect(allocations == 0, "NAM/IR and builtin processing have no C++ heap allocations");

        toney::RealtimeProcessor first(dry(), 48000, nullptr, 0, -12), replacement(dry(), 48000, nullptr, 0, -24);
        toney::LiveAudioCallback callback(48000, 128, 1);
        std::array<float, 2048> in{}, other{}, left{}, right{}, unused{}; in.fill(0.5f); other.fill(0.01f); unused.fill(10);
        const float* inputs[]{other.data(), in.data()}; float* outputs[]{left.data(), right.data(), unused.data()};
        callback.publish(&first);
        audit = true;
        callback.audioDeviceIOCallbackWithContext(inputs, 2, outputs, 3, 2048, {});
        audit = false;
        expect(callback.completed() == &first && left[0] == 0 && left[2047] > 0.12f, "start ramps from silence and acknowledges prepared graph");
        expect(left == right && unused[0] == 0, "chosen mono input feeds first two outputs and clears unused outputs");
        expect(std::abs(callback.inputPeak.load() - 0.5f) < 1e-7 && callback.callbackCount.load() == 1, "callback metrics use chosen channel and actual processed blocks");
        callback.publish(&replacement);
        callback.audioDeviceIOCallbackWithContext(inputs, 2, outputs, 3, 128, {});
        expect(callback.completed() == &first, "old graph retained until crossfade finishes");
        callback.audioDeviceIOCallbackWithContext(inputs, 2, outputs, 3, 2048, {});
        expect(callback.completed() == &replacement && left[2047] < 0.032f, "rig replacement crossfades and safely acknowledges retirement");
        in[600] = std::numeric_limits<float>::infinity();
        callback.audioDeviceIOCallbackWithContext(inputs, 2, outputs, 3, 2048, {});
        expect(callback.fault.load() == 4 && std::all_of(left.begin(), left.end(), [](float x) { return x == 0; }), "fault after an earlier chunk silences the complete hardware block");
        expect(allocations == 0, "synthetic hardware callback performs no C++ heap allocations");

        toney::LiveSession session;
        const auto status = session.handle(juce::JSON::toString(request("get_live_status")));
        expect(static_cast<bool>(status["ok"]) && status["result"]["state"].toString() == "stopped", "session status never opens hardware");
        const auto update = session.handle(juce::JSON::toString(request("update_live")));
        expect(update["error"]["code"].toString() == "LIVE_NOT_RUNNING" && update["requestId"].toString() == "live-contract", "update without session has correlated failure");
        auto bad = request("get_live_status"); bad.getDynamicObject()->setProperty("live", toney::makeObject({}));
        expect(session.handle(juce::JSON::toString(bad))["error"]["code"].toString() == "INVALID_REQUEST", "status rejects configuration injection");
        auto invalidStart = request("start_live"); invalidStart.getDynamicObject()->setProperty("tone", fixture());
        invalidStart.getDynamicObject()->setProperty("live", toney::makeObject({{"inputDeviceId", "x"}, {"outputDeviceId", "x"}, {"inputChannel", 32}, {"sampleRate", 48000}, {"bufferSize", 128}, {"inputGainDb", 0}, {"outputGainDb", -12}}));
        expect(session.handle(juce::JSON::toString(invalidStart))["error"]["code"].toString() == "INVALID_REQUEST", "invalid channel fails before device access");
        expect(static_cast<bool>(session.handle(juce::JSON::toString(request("stop_live")))["ok"]), "Stop is idempotent without hardware");
    }
    catch (const std::exception& error) { audit = false; ++failures; std::cerr << "Unexpected: " << error.what() << '\n'; }
    directory.deleteRecursively();
#if JUCE_MAC
    *logger = previousLogger;
#endif
    std::cout << checks << " live audio checks; " << failures << " failed.\n";
    return failures == 0 ? 0 : 1;
}
