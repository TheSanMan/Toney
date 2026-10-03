#include "EffectProcessing.h"
#include "Protocol.h"
#include "Assets.h"
#include <juce_dsp/juce_dsp.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <vector>

namespace toney
{
namespace
{
using Coefficients = juce::dsp::IIR::Coefficients<float>;
constexpr double pi = 3.14159265358979323846;

double parameter(const juce::var& node, const char* name) { return static_cast<double>(node["parameters"][name]); }
double frequency(double hz, double sampleRate) { return std::min(hz, sampleRate * 0.45); }

void filter(juce::AudioBuffer<float>& samples, const Coefficients::Ptr& coefficients)
{
    for (int channel = 0; channel < samples.getNumChannels(); ++channel)
    {
        juce::dsp::IIR::Filter<float> processor(coefficients);
        auto* data = samples.getWritePointer(channel);
        for (int frame = 0; frame < samples.getNumSamples(); ++frame) data[frame] = processor.processSample(data[frame]);
    }
}

void compress(juce::AudioBuffer<float>& samples, double sampleRate, const juce::var& node)
{
    const auto amount = parameter(node, "amount");
    const auto attack = std::exp(-1.0 / (sampleRate * (0.002 + parameter(node, "attack") * 0.06)));
    const auto release = std::exp(-1.0 / (sampleRate * 0.16));
    const auto threshold = juce::Decibels::decibelsToGain(-8.0 - amount * 28.0);
    const auto ratio = 1.0 + amount * 9.0;
    double envelope = 0;
    // One envelope/gain for both channels avoids shifting stereo balance.
    for (int frame = 0; frame < samples.getNumSamples(); ++frame)
    {
        double inputPeak = 0;
        for (int channel = 0; channel < samples.getNumChannels(); ++channel)
            inputPeak = std::max(inputPeak, std::abs(static_cast<double>(samples.getSample(channel, frame))));
        const auto coefficient = inputPeak > envelope ? attack : release;
        envelope = coefficient * envelope + (1.0 - coefficient) * inputPeak;
        const auto reduction = envelope > threshold ? std::pow(threshold / envelope, 1.0 - 1.0 / ratio) : 1.0;
        for (int channel = 0; channel < samples.getNumChannels(); ++channel)
            samples.setSample(channel, frame, samples.getSample(channel, frame) * static_cast<float>(reduction * (1.0 + amount * 1.4)));
    }
}

void saturate(juce::AudioBuffer<float>& samples, double gain, double level)
{
    const auto normalization = std::tanh(gain);
    for (int channel = 0; channel < samples.getNumChannels(); ++channel)
    {
        auto* data = samples.getWritePointer(channel);
        for (int frame = 0; frame < samples.getNumSamples(); ++frame)
            data[frame] = static_cast<float>(std::tanh(static_cast<double>(data[frame]) * gain) / normalization * level);
    }
}

class DelayMemory
{
public:
    explicit DelayMemory(int length) : data(static_cast<std::size_t>(length), 0) {}
    float read(double delay) const
    {
        auto position = static_cast<double>(index) - delay;
        while (position < 0) position += static_cast<double>(data.size());
        const auto left = static_cast<std::size_t>(position) % data.size();
        const auto right = (left + 1) % data.size();
        const auto fraction = static_cast<float>(position - std::floor(position));
        return data[left] + (data[right] - data[left]) * fraction;
    }
    void push(float sample)
    {
        data[index] = sample;
        index = (index + 1) % data.size();
    }
private:
    std::vector<float> data;
    std::size_t index = 0;
};

void modulation(juce::AudioBuffer<float>& samples, double sampleRate, const juce::var& node)
{
    const auto mix = parameter(node, "mix");
    const auto depth = parameter(node, "depth");
    const auto rate = parameter(node, "rate");
    for (int channel = 0; channel < samples.getNumChannels(); ++channel)
    {
        DelayMemory delay(static_cast<int>(std::ceil(sampleRate * 0.03)) + 2);
        auto* data = samples.getWritePointer(channel);
        for (int frame = 0; frame < samples.getNumSamples(); ++frame)
        {
            const auto delayFrames = sampleRate * (0.018 + std::sin(2 * pi * rate * frame / sampleRate) * depth * 0.007);
            const auto wet = delay.read(delayFrames);
            delay.push(data[frame]);
            data[frame] = static_cast<float>(data[frame] * (1 - mix) + wet * mix);
        }
    }
}

void echo(juce::AudioBuffer<float>& samples, double sampleRate, const juce::var& node)
{
    const auto delayFrames = parameter(node, "time") * sampleRate;
    const auto feedback = parameter(node, "feedback");
    const auto mix = parameter(node, "mix");
    for (int channel = 0; channel < samples.getNumChannels(); ++channel)
    {
        DelayMemory delay(static_cast<int>(std::ceil(delayFrames)) + 2);
        juce::dsp::IIR::Filter<float> lowpass(Coefficients::makeLowPass(sampleRate, frequency(4500, sampleRate)));
        auto* data = samples.getWritePointer(channel);
        for (int frame = 0; frame < samples.getNumSamples(); ++frame)
        {
            const auto wet = delay.read(delayFrames);
            delay.push(static_cast<float>(data[frame] + lowpass.processSample(wet) * feedback));
            data[frame] = static_cast<float>(data[frame] * (1 - mix) + wet * mix);
        }
    }
}

void room(juce::AudioBuffer<float>& samples, double sampleRate, const juce::var& node)
{
    // A small Schroeder room: four parallel damped combs then two allpass stages.
    // The decay knob is an approximate RT60, not a measured room or cabinet IR.
    const std::array<double, 4> seconds {0.0297, 0.0371, 0.0411, 0.0437};
    const auto decay = parameter(node, "decay");
    const auto mix = parameter(node, "mix");
    for (int channel = 0; channel < samples.getNumChannels(); ++channel)
    {
        std::vector<DelayMemory> combs;
        std::array<double, 4> frames {}, feedback {}, damping {};
        for (std::size_t i = 0; i < seconds.size(); ++i)
        {
            frames[i] = std::round(seconds[i] * sampleRate);
            feedback[i] = std::pow(10.0, -3.0 * frames[i] / sampleRate / decay);
            combs.emplace_back(static_cast<int>(frames[i]) + 1);
        }
        std::array<DelayMemory, 2> allpass {DelayMemory(static_cast<int>(std::round(sampleRate * 0.005)) + 1),
                                          DelayMemory(static_cast<int>(std::round(sampleRate * 0.0017)) + 1)};
        const std::array<double, 2> allpassFrames {std::round(sampleRate * 0.005), std::round(sampleRate * 0.0017)};
        juce::dsp::IIR::Filter<float> lowpass(Coefficients::makeLowPass(sampleRate, frequency(5500, sampleRate)));
        auto* data = samples.getWritePointer(channel);
        for (int frame = 0; frame < samples.getNumSamples(); ++frame)
        {
            double wet = 0;
            for (std::size_t i = 0; i < combs.size(); ++i)
            {
                const auto delayed = combs[i].read(frames[i]);
                damping[i] += 0.45 * (delayed - damping[i]);
                combs[i].push(static_cast<float>(data[frame] + damping[i] * feedback[i]));
                wet += delayed * 0.25;
            }
            for (std::size_t i = 0; i < allpass.size(); ++i)
            {
                const auto delayed = allpass[i].read(allpassFrames[i]);
                const auto output = delayed - wet * 0.5;
                allpass[i].push(static_cast<float>(wet + output * 0.5));
                wet = output;
            }
            data[frame] = static_cast<float>(data[frame] * (1 - mix) + lowpass.processSample(static_cast<float>(wet)) * mix);
        }
    }
}
}

double renderTailSeconds(const juce::var& tone, const AssetLibrary* assets)
{
    double tail = 0;
    for (const auto& node : *tone["chain"].getArray())
    {
        if (!static_cast<bool>(node["enabled"])) continue;
        const auto type = node["type"].toString();
        if (node["model"].toString() == "cab_ir")
        {
            if (assets == nullptr) throw ControlError("ASSET_MISSING", "Cabinet IR is unavailable.");
            const auto& impulse = *assets->get(node["asset"]["id"].toString()).impulse;
            tail += (impulse.samples.getNumSamples() - 1.0) / impulse.sampleRate;
        }
        if (type == "delay" && parameter(node, "mix") > 0)
        {
            const auto feedback = parameter(node, "feedback");
            const auto repeats = feedback > 0 ? std::ceil(std::log(0.0001) / std::log(feedback)) : 1;
            tail += parameter(node, "time") * repeats + 0.05;
        }
        else if (type == "reverb" && parameter(node, "mix") > 0) tail += parameter(node, "decay") + 0.07;
        else if (type == "chorus" && parameter(node, "mix") > 0) tail += 0.03;
        else if (type != "compressor" && type != "chorus" && type != "delay" && type != "reverb") tail += 0.05;
    }
    return std::min(12.0, tail);
}

void processEffects(juce::AudioBuffer<float>& samples, double sampleRate, const juce::var& tone, const AssetLibrary* assets)
{
    for (const auto& node : *tone["chain"].getArray())
    {
        if (!static_cast<bool>(node["enabled"])) continue;
        const auto type = node["type"].toString();
        if (node["model"].toString() == "cab_ir")
        {
            if (assets == nullptr) throw ControlError("ASSET_MISSING", "Cabinet IR is unavailable.");
            convolveImpulse(samples, sampleRate, assets->get(node["asset"]["id"].toString()));
            filter(samples, Coefficients::makePeakFilter(sampleRate, frequency(145, sampleRate), 1.1f, juce::Decibels::decibelsToGain(static_cast<float>(parameter(node, "resonance") * 5))));
            filter(samples, Coefficients::makeHighShelf(sampleRate, frequency(3200, sampleRate), 0.707f, juce::Decibels::decibelsToGain(static_cast<float>((parameter(node, "brightness") - 0.5) * 12))));
        }
        else if (node["model"].toString() == "nam") throw ControlError("ASSET_UNSUPPORTED", "Neural processing is unavailable in this milestone.");
        else if (type == "compressor") compress(samples, sampleRate, node);
        else if (type == "drive")
        {
            const auto gain = parameter(node, "gain");
            saturate(samples, 1 + gain * gain * 55, 0.12 + parameter(node, "level") * 0.7);
            filter(samples, Coefficients::makeLowPass(sampleRate, frequency(1400 + parameter(node, "tone") * 7200, sampleRate)));
        }
        else if (type == "amp")
        {
            filter(samples, Coefficients::makeLowShelf(sampleRate, frequency(180, sampleRate), 0.707f, juce::Decibels::decibelsToGain(static_cast<float>((parameter(node, "bass") - 0.5) * 20))));
            filter(samples, Coefficients::makePeakFilter(sampleRate, frequency(850, sampleRate), 0.8f, juce::Decibels::decibelsToGain(static_cast<float>((parameter(node, "mid") - 0.5) * 18))));
            filter(samples, Coefficients::makeHighShelf(sampleRate, frequency(2600, sampleRate), 0.707f, juce::Decibels::decibelsToGain(static_cast<float>((parameter(node, "treble") - 0.5) * 20))));
            const auto gain = parameter(node, "gain");
            saturate(samples, 1 + gain * gain * 24, 0.1 + parameter(node, "master") * 0.6);
        }
        else if (type == "cab")
        {
            filter(samples, Coefficients::makeHighPass(sampleRate, frequency(75, sampleRate)));
            filter(samples, Coefficients::makePeakFilter(sampleRate, frequency(145, sampleRate), 1.1f, juce::Decibels::decibelsToGain(static_cast<float>(parameter(node, "resonance") * 5))));
            filter(samples, Coefficients::makeLowPass(sampleRate, frequency(2000 + parameter(node, "brightness") * 4500, sampleRate), 0.65f));
        }
        else if (type == "eq")
        {
            filter(samples, Coefficients::makeLowShelf(sampleRate, frequency(200, sampleRate), 0.707f, juce::Decibels::decibelsToGain(static_cast<float>(parameter(node, "lowDb")))));
            filter(samples, Coefficients::makePeakFilter(sampleRate, frequency(1000, sampleRate), 0.707f, juce::Decibels::decibelsToGain(static_cast<float>(parameter(node, "midDb")))));
            filter(samples, Coefficients::makeHighShelf(sampleRate, frequency(3200, sampleRate), 0.707f, juce::Decibels::decibelsToGain(static_cast<float>(parameter(node, "highDb")))));
        }
        else if (type == "chorus") modulation(samples, sampleRate, node);
        else if (type == "delay") echo(samples, sampleRate, node);
        else if (type == "reverb") room(samples, sampleRate, node);
        else throw ControlError("AUDIO_RENDER_FAILED", "Unsupported native processor.");
    }
}
}
