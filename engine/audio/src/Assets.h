#pragma once
#include "WaveFiles.h"
#include <map>
#include <memory>

namespace toney
{
struct LoadedAsset
{
    juce::String id, kind;
    juce::File path;
    juce::var info;
    std::unique_ptr<DecodedWave> impulse;
};
LoadedAsset loadAsset(const juce::var& descriptor);
juce::var inspectAsset(const juce::var& descriptor);
class AssetLibrary
{
public:
    AssetLibrary(const juce::var& tone, const juce::var& supplied);
    const LoadedAsset& get(const juce::String& id) const;
private:
    std::map<juce::String, LoadedAsset> assets;
};
void convolveImpulse(juce::AudioBuffer<float>& samples, double sampleRate, const LoadedAsset& asset);
}
