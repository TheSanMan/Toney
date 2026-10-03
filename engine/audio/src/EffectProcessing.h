#pragma once
#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

namespace toney
{
class AssetLibrary;
// Deterministic approximate offline DSP. This has no audio-device callback.
double renderTailSeconds(const juce::var& validatedTone, const AssetLibrary* assets = nullptr);
void processEffects(juce::AudioBuffer<float>& samples, double sampleRate, const juce::var& validatedTone, const AssetLibrary* assets = nullptr);
}
