#include "RealtimeProcessing.h"
#include "Assets.h"
#include "NamModel.h"
#include "Protocol.h"
#include "Resampling.h"
#include <juce_dsp/juce_dsp.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <vector>

namespace toney
{
namespace
{
using Coefficients = juce::dsp::IIR::Coefficients<float>;
constexpr double pi = 3.14159265358979323846;
double parameter(const juce::var& node, const char* name) { return static_cast<double>(node["parameters"][name]); }
double frequency(double hz, double sr) { return std::min(hz, sr * 0.45); }
float dbGain(double db) { return juce::Decibels::decibelsToGain(static_cast<float>(db)); }
struct Node
{
    virtual ~Node() = default;
    virtual void process(float* samples, int frames) noexcept = 0;
};
// Every wet/dry stage owns its processing and preallocated dry scratch. Current
// NAM processors and zero-latency IR convolution add no algorithmic block delay;
// chorus/echo musical delay remains deliberately unaligned with the dry signal.
struct Blend final : Node
{
    Blend(std::vector<std::unique_ptr<Node>> processors, double value)
        : nodes(std::move(processors)), mix(static_cast<float>(value)) {}
    void process(float* samples, int frames) noexcept override
    {
        std::copy_n(samples, frames, dry.data());
        for (const auto& node : nodes) node->process(samples, frames);
        for (int i = 0; i < frames; ++i) samples[i] = dry[static_cast<std::size_t>(i)] * (1 - mix) + samples[i] * mix;
    }
    std::vector<std::unique_ptr<Node>> nodes;
    float mix;
    std::array<float, RealtimeProcessor::maxBlockSize> dry{};
};
struct Gain final : Node
{
    explicit Gain(float value) : gain(value) {}
    void process(float* samples, int frames) noexcept override
    { for (int i = 0; i < frames; ++i) samples[i] *= gain; }
    float gain;
};
struct Filter final : Node
{
    explicit Filter(const Coefficients::Ptr& coefficients) : filter(coefficients) { filter.reset(); }
    void process(float* samples, int frames) noexcept override
    { for (int i = 0; i < frames; ++i) samples[i] = filter.processSample(samples[i]); }
    juce::dsp::IIR::Filter<float> filter;
};
struct Saturation final : Node
{
    Saturation(double gainValue, double levelValue) : gain(gainValue), level(levelValue), normalization(std::tanh(gainValue)), blend(std::min(1.0, gainValue - 1.0)) {}
    void process(float* samples, int frames) noexcept override
    {
        for (int i = 0; i < frames; ++i)
        {
            const auto dry = static_cast<double>(samples[i]);
            const auto saturated = std::tanh(dry * gain) / normalization;
            samples[i] = static_cast<float>((dry + blend * (saturated - dry)) * level);
        }
    }
    double gain, level, normalization, blend;
};
struct Compressor final : Node
{
    Compressor(double sr, const juce::var& node)
        : attack(std::exp(-1.0 / (sr * (0.002 + parameter(node, "attack") * 0.06)))),
          release(std::exp(-1.0 / (sr * 0.16))), threshold(dbGain(-8 - parameter(node, "amount") * 28)),
          exponent(1.0 - 1.0 / (1 + parameter(node, "amount") * 9)), makeup(1 + parameter(node, "amount") * 1.4) {}
    void process(float* samples, int frames) noexcept override
    {
        for (int i = 0; i < frames; ++i)
        {
            const auto peak = std::abs(static_cast<double>(samples[i]));
            const auto coefficient = peak > envelope ? attack : release;
            envelope = coefficient * envelope + (1 - coefficient) * peak;
            const auto reduction = envelope > threshold ? std::pow(threshold / envelope, exponent) : 1.0;
            samples[i] *= static_cast<float>(reduction * makeup);
        }
    }
    double attack, release, threshold, exponent, makeup, envelope = 0;
};
class DelayMemory
{
public:
    explicit DelayMemory(int length) : data(static_cast<std::size_t>(length), 0) {}
    float read(double delay) const noexcept
    {
        auto position = static_cast<double>(index) - delay;
        while (position < 0) position += static_cast<double>(data.size());
        const auto left = static_cast<std::size_t>(position) % data.size();
        const auto right = (left + 1) % data.size();
        return data[left] + (data[right] - data[left]) * static_cast<float>(position - std::floor(position));
    }
    void push(float sample) noexcept { data[index] = sample; index = (index + 1) % data.size(); }
private:
    std::vector<float> data;
    std::size_t index = 0;
};
struct Chorus final : Node
{
    Chorus(double sr, const juce::var& node) : delay(static_cast<int>(std::ceil(sr * 0.03)) + 2),
        base(sr * 0.018), depth(sr * parameter(node, "depth") * 0.007), step(2 * pi * parameter(node, "rate") / sr), mix(parameter(node, "mix")) {}
    void process(float* samples, int frames) noexcept override
    {
        for (int i = 0; i < frames; ++i)
        {
            const auto wet = delay.read(base + std::sin(phase) * depth);
            delay.push(samples[i]);
            samples[i] = static_cast<float>(samples[i] * (1 - mix) + wet * mix);
            phase += step;
            if (phase >= 2 * pi) phase -= 2 * pi;
        }
    }
    DelayMemory delay;
    double base, depth, step, mix, phase = 0;
};
struct Echo final : Node
{
    Echo(double sr, const juce::var& node) : delay(static_cast<int>(std::ceil(parameter(node, "time") * sr)) + 2),
        lowpass(Coefficients::makeLowPass(sr, frequency(4500, sr))), delayFrames(parameter(node, "time") * sr),
        feedback(parameter(node, "feedback")), mix(parameter(node, "mix")) { lowpass.reset(); }
    void process(float* samples, int frames) noexcept override
    {
        for (int i = 0; i < frames; ++i)
        {
            const auto wet = delay.read(delayFrames);
            delay.push(static_cast<float>(samples[i] + lowpass.processSample(wet) * feedback));
            samples[i] = static_cast<float>(samples[i] * (1 - mix) + wet * mix);
        }
    }
    DelayMemory delay;
    juce::dsp::IIR::Filter<float> lowpass;
    double delayFrames, feedback, mix;
};
struct Room final : Node
{
    Room(double sr, const juce::var& node)
        : allpass{DelayMemory(static_cast<int>(std::round(sr * 0.005)) + 1), DelayMemory(static_cast<int>(std::round(sr * 0.0017)) + 1)},
          allpassFrames{std::round(sr * 0.005), std::round(sr * 0.0017)},
          lowpass(Coefficients::makeLowPass(sr, frequency(5500, sr))), mix(parameter(node, "mix"))
    {
        constexpr std::array<double, 4> seconds{0.0297, 0.0371, 0.0411, 0.0437};
        combs.reserve(4);
        for (std::size_t i = 0; i < 4; ++i)
        {
            delayFrames[i] = std::round(seconds[i] * sr);
            feedback[i] = std::pow(10.0, -3.0 * delayFrames[i] / sr / parameter(node, "decay"));
            combs.emplace_back(static_cast<int>(delayFrames[i]) + 1);
        }
        lowpass.reset();
    }
    void process(float* samples, int frames) noexcept override
    {
        for (int frame = 0; frame < frames; ++frame)
        {
            double wet = 0;
            for (std::size_t i = 0; i < 4; ++i)
            {
                const auto delayed = combs[i].read(delayFrames[i]);
                damping[i] += 0.45 * (delayed - damping[i]);
                combs[i].push(static_cast<float>(samples[frame] + damping[i] * feedback[i]));
                wet += delayed * 0.25;
            }
            for (std::size_t i = 0; i < 2; ++i)
            {
                const auto delayed = allpass[i].read(allpassFrames[i]);
                const auto output = delayed - wet * 0.5;
                allpass[i].push(static_cast<float>(wet + output * 0.5));
                wet = output;
            }
            samples[frame] = static_cast<float>(samples[frame] * (1 - mix) + lowpass.processSample(static_cast<float>(wet)) * mix);
        }
    }
    std::vector<DelayMemory> combs;
    std::array<double, 4> delayFrames{}, feedback{}, damping{};
    std::array<DelayMemory, 2> allpass;
    std::array<double, 2> allpassFrames;
    juce::dsp::IIR::Filter<float> lowpass;
    double mix;
};
struct Neural final : Node
{
    explicit Neural(const NamModelDefinition& definition) : processor(createNamProcessor(definition)) {}
    void process(float* samples, int frames) noexcept override
    {
        processor->process(samples, scratch.data(), frames);
        std::copy_n(scratch.data(), frames, samples);
    }
    std::unique_ptr<nam::DSP> processor;
    std::array<float, RealtimeProcessor::maxBlockSize> scratch{};
};
struct Cabinet final : Node
{
    Cabinet(double sr, const LoadedAsset& asset) : convolution(juce::dsp::Convolution::Latency{0})
    {
        if (!asset.impulse) throw ControlError("ASSET_INVALID", "Cabinet convolution requires an IR asset.");
        auto impulse = asset.impulse->samples;
        if (impulse.getNumChannels() == 2)
        {
            for (int frame = 0; frame < impulse.getNumSamples(); ++frame)
                impulse.setSample(0, frame, (impulse.getSample(0, frame) + impulse.getSample(1, frame)) * 0.5f);
            impulse.setSize(1, impulse.getNumSamples(), true);
        }
        if (asset.impulse->sampleRate != sr)
        {
            impulse = resampleBuffer(impulse, asset.impulse->sampleRate, sr);
            impulse.applyGain(static_cast<float>(asset.impulse->sampleRate / sr));
        }
        convolution.loadImpulseResponse(std::move(impulse), sr, juce::dsp::Convolution::Stereo::no,
                                        juce::dsp::Convolution::Trim::no, juce::dsp::Convolution::Normalise::no);
        // JUCE prepare drains pending IR messages and builds its engine here.
        // No IR is replaced on the live graph; graph replacement is external.
        convolution.prepare({sr, RealtimeProcessor::maxBlockSize, 1});
        convolution.reset();
    }
    void process(float* samples, int frames) noexcept override
    {
        float* channels[]{samples};
        juce::dsp::AudioBlock<float> block(channels, 1, static_cast<std::size_t>(frames));
        convolution.process(juce::dsp::ProcessContextReplacing<float>(block));
    }
    juce::dsp::Convolution convolution;
};
}

class RealtimeProcessor::Impl
{
public:
    Impl(const juce::var& tone, double sr, const AssetLibrary* assets, double inputDb, double outputDb)
    {
        if (!std::isfinite(sr) || sr < 8000 || sr > 192000 || !std::isfinite(inputDb) || !std::isfinite(outputDb)
            || inputDb < -24 || inputDb > 24 || outputDb < -60 || outputDb > 0)
            throw ControlError("INVALID_LIVE_REQUEST", "Invalid live sample rate or trim.");
        validateTone(tone);
        gain(dbGain(inputDb));
        for (const auto& node : *tone["chain"].getArray())
        {
            if (!static_cast<bool>(node["enabled"])) continue;
            const auto stageStart = nodes.size();
            const auto type = node["type"].toString();
            const auto model = node["model"].toString();
            if (model == "nam")
            {
                if (!assets) throw ControlError("ASSET_MISSING", "Neural model is unavailable.");
                const auto& definition = assets->get(node["asset"]["id"].toString()).neural;
                if (!definition) throw ControlError("ASSET_INVALID", "Neural processing requires a NAM model.");
                if (definition->sampleRate != sr)
                    throw ControlError("LIVE_SAMPLE_RATE_MISMATCH", "Live NAM playback requires " + juce::String(definition->sampleRate) + " Hz. Select that sample rate for your audio interface.");
                gain(dbGain((parameter(node, "gain") - 0.5) * 24));
                nodes.push_back(std::make_unique<Neural>(*definition));
                if (type == "drive")
                {
                    filter(Coefficients::makeHighShelf(sr, frequency(2500, sr), 0.707f, dbGain((parameter(node, "tone") - 0.5) * 12)));
                    gain(dbGain((parameter(node, "level") - 0.5) * 24));
                }
                else { ampEq(node, sr); gain(dbGain((parameter(node, "master") - 0.5) * 24)); }
            }
            else if (model == "cab_ir")
            {
                if (!assets) throw ControlError("ASSET_MISSING", "Cabinet IR is unavailable.");
                auto cabinet = std::make_unique<Cabinet>(sr, assets->get(node["asset"]["id"].toString()));
                if (cabinet->convolution.getLatency() != 0)
                    throw ControlError("LIVE_PROCESSING_FAILED", "Live cabinet mixing requires zero-latency convolution.");
                latency += cabinet->convolution.getLatency();
                nodes.push_back(std::move(cabinet));
                filter(Coefficients::makePeakFilter(sr, frequency(145, sr), 1.1f, dbGain(parameter(node, "resonance") * 5)));
                filter(Coefficients::makeHighShelf(sr, frequency(3200, sr), 0.707f, dbGain((parameter(node, "brightness") - 0.5) * 12)));
            }
            else if (type == "compressor") nodes.push_back(std::make_unique<Compressor>(sr, node));
            else if (type == "drive")
            {
                const auto value = parameter(node, "gain");
                nodes.push_back(std::make_unique<Saturation>(1 + value * value * 55, 0.12 + parameter(node, "level") * 0.7));
                filter(Coefficients::makeLowPass(sr, frequency(1400 + parameter(node, "tone") * 7200, sr)));
            }
            else if (type == "amp")
            {
                ampEq(node, sr);
                const auto value = parameter(node, "gain");
                nodes.push_back(std::make_unique<Saturation>(1 + value * value * 24, 0.1 + parameter(node, "master") * 0.6));
            }
            else if (type == "cab")
            {
                filter(Coefficients::makeHighPass(sr, frequency(75, sr)));
                filter(Coefficients::makePeakFilter(sr, frequency(145, sr), 1.1f, dbGain(parameter(node, "resonance") * 5)));
                filter(Coefficients::makeLowPass(sr, frequency(2000 + parameter(node, "brightness") * 4500, sr), 0.65f));
            }
            else if (type == "eq")
            {
                filter(Coefficients::makeLowShelf(sr, frequency(200, sr), 0.707f, dbGain(parameter(node, "lowDb"))));
                filter(Coefficients::makePeakFilter(sr, frequency(1000, sr), 0.707f, dbGain(parameter(node, "midDb"))));
                filter(Coefficients::makeHighShelf(sr, frequency(3200, sr), 0.707f, dbGain(parameter(node, "highDb"))));
            }
            else if (type == "chorus") nodes.push_back(std::make_unique<Chorus>(sr, node));
            else if (type == "delay") nodes.push_back(std::make_unique<Echo>(sr, node));
            else if (type == "reverb") nodes.push_back(std::make_unique<Room>(sr, node));
            else throw ControlError("LIVE_PROCESSING_FAILED", "Unsupported live processor.");
            const auto mix = node.getDynamicObject()->hasProperty("mix") ? static_cast<double>(node["mix"]) : 1.0;
            if (mix < 1.0)
            {
                std::vector<std::unique_ptr<Node>> stage;
                stage.reserve(nodes.size() - stageStart);
                for (auto index = stageStart; index < nodes.size(); ++index) stage.push_back(std::move(nodes[index]));
                nodes.resize(stageStart);
                nodes.push_back(std::make_unique<Blend>(std::move(stage), mix));
            }
        }
        gain(dbGain(outputDb));
    }
    void gain(float value) { nodes.push_back(std::make_unique<Gain>(value)); }
    void filter(const Coefficients::Ptr& coefficients) { nodes.push_back(std::make_unique<Filter>(coefficients)); }
    void ampEq(const juce::var& node, double sr)
    {
        if (parameter(node, "bass") != 0.5) filter(Coefficients::makeLowShelf(sr, frequency(180, sr), 0.707f, dbGain((parameter(node, "bass") - 0.5) * 20)));
        if (parameter(node, "mid") != 0.5) filter(Coefficients::makePeakFilter(sr, frequency(850, sr), 0.8f, dbGain((parameter(node, "mid") - 0.5) * 18)));
        if (parameter(node, "treble") != 0.5) filter(Coefficients::makeHighShelf(sr, frequency(2600, sr), 0.707f, dbGain((parameter(node, "treble") - 0.5) * 20)));
    }
    std::vector<std::unique_ptr<Node>> nodes;
    std::array<float, maxBlockSize> work{};
    std::atomic<bool> fault{false};
    int latency = 0;
};
RealtimeProcessor::RealtimeProcessor(const juce::var& tone, double sr, const AssetLibrary* assets, double inputDb, double outputDb)
    : impl(std::make_unique<Impl>(tone, sr, assets, inputDb, outputDb)) {}
RealtimeProcessor::~RealtimeProcessor() = default;
bool RealtimeProcessor::failed() const noexcept { return impl->fault.load(std::memory_order_relaxed); }
int RealtimeProcessor::latencySamples() const noexcept { return impl->latency; }
void RealtimeProcessor::process(const float* input, float* output, int frames) noexcept
{
    if (frames <= 0) return;
    if (output == nullptr) { impl->fault.store(true, std::memory_order_relaxed); return; }
    if (frames > maxBlockSize || input == nullptr || failed())
    {
        impl->fault.store(true, std::memory_order_relaxed);
        std::fill_n(output, frames, 0.0f);
        return;
    }
    for (int i = 0; i < frames; ++i)
    {
        if (!std::isfinite(input[i]))
        {
            impl->fault.store(true, std::memory_order_relaxed);
            std::fill_n(output, frames, 0.0f);
            return;
        }
        impl->work[static_cast<std::size_t>(i)] = input[i];
    }
    const juce::ScopedNoDenormals noDenormals;
    for (const auto& node : impl->nodes) node->process(impl->work.data(), frames);
    for (int i = 0; i < frames; ++i)
    {
        const auto value = impl->work[static_cast<std::size_t>(i)];
        if (!std::isfinite(value))
        {
            impl->fault.store(true, std::memory_order_relaxed);
            std::fill_n(output, frames, 0.0f);
            return;
        }
        // A continuous soft knee avoids the old flat-topped ±0.85 clipping.
        // Below 0.70 the signal is untouched; overload approaches ±0.85.
        const auto magnitude = std::abs(value);
        output[i] = magnitude <= 0.70f ? value
            : std::copysign(0.70f + 0.15f * std::tanh((magnitude - 0.70f) / 0.15f), value);
    }
}
}
