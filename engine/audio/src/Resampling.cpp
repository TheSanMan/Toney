#include "Resampling.h"
#include <array>
#include <cmath>
#include <vector>

namespace toney
{
juce::AudioBuffer<float> resampleBuffer(const juce::AudioBuffer<float>& source, double sourceRate,
                                      double destinationRate, int destinationFrames)
{
    if (destinationFrames < 0) destinationFrames = std::max(1, static_cast<int>(std::ceil(source.getNumSamples() * destinationRate / sourceRate)));
    if (sourceRate == destinationRate && destinationFrames == source.getNumSamples()) return source;
    constexpr int half = 16, taps = 32, phases = 1024;
    constexpr double pi = 3.14159265358979323846;
    const auto cutoff = std::min(1.0, destinationRate / sourceRate) * 0.94;
    std::vector<std::array<float, taps>> table(phases);
    for (int phase = 0; phase < phases; ++phase)
    {
        double sum = 0;
        for (int tap = 0; tap < taps; ++tap)
        {
            const auto distance = (tap - half + 1) - static_cast<double>(phase) / phases;
            const auto argument = pi * distance * cutoff;
            const auto sinc = std::abs(argument) < 1e-12 ? 1.0 : std::sin(argument) / argument;
            const auto window = 0.5 + 0.5 * std::cos(pi * distance / half);
            const auto coefficient = cutoff * sinc * window;
            table[phase][tap] = static_cast<float>(coefficient);
            sum += coefficient;
        }
        for (auto& coefficient : table[phase]) coefficient = static_cast<float>(coefficient / sum);
    }
    juce::AudioBuffer<float> output(source.getNumChannels(), destinationFrames);
    for (int frame = 0; frame < destinationFrames; ++frame)
    {
        const auto position = frame * sourceRate / destinationRate;
        const auto base = static_cast<int>(std::floor(position));
        const auto phase = std::min(phases - 1, static_cast<int>((position - base) * phases));
        for (int channel = 0; channel < source.getNumChannels(); ++channel)
        {
            double value = 0;
            for (int tap = 0; tap < taps; ++tap)
            {
                const auto sourceFrame = base + tap - half + 1;
                if (sourceFrame >= 0 && sourceFrame < source.getNumSamples())
                    value += source.getSample(channel, sourceFrame) * table[phase][tap];
            }
            output.setSample(channel, frame, static_cast<float>(value));
        }
    }
    return output;
}
}
