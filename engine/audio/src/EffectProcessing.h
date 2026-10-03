#pragma once
#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

namespace toney
{
// Deterministic approximate offline DSP. This has no audio-device callback.
double renderTailSeconds(const juce::var& validatedTone);
void processEffects(juce::AudioBuffer<float>& samples, double sampleRate, const juce::var& validatedTone);
}
