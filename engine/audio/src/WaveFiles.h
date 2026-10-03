#pragma once
#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

namespace toney
{
constexpr juce::int64 maxWaveBytes = 32 * 1024 * 1024;
struct DecodedWave { juce::AudioBuffer<float> samples; int sampleRate; };
DecodedWave readWave(const juce::File& input);
void writeWaveExclusive(const juce::File& output, const juce::AudioBuffer<float>& samples, int sampleRate);
}
