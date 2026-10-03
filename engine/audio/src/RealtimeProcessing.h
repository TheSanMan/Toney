#pragma once
#include <juce_core/juce_core.h>
#include <memory>

namespace toney
{
class AssetLibrary;
// A prepared mono graph. Construction and destruction belong to the control
// thread. process() owns its persistent state on the audio thread exclusively.
class RealtimeProcessor final
{
public:
    static constexpr int maxBlockSize = 512;
    RealtimeProcessor(const juce::var& validatedTone, double sampleRate,
                      const AssetLibrary* assets, double inputGainDb, double outputGainDb);
    ~RealtimeProcessor();
    void process(const float* input, float* output, int frames) noexcept;
    bool failed() const noexcept;
    int latencySamples() const noexcept;
    RealtimeProcessor(const RealtimeProcessor&) = delete;
    RealtimeProcessor& operator=(const RealtimeProcessor&) = delete;
private:
    class Impl;
    std::unique_ptr<Impl> impl;
};
}
