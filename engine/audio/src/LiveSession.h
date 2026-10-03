#pragma once
#include "Protocol.h"
#include "RealtimeProcessing.h"
#include <juce_audio_devices/juce_audio_devices.h>
#include <array>
#include <atomic>
#include <memory>

namespace toney
{
// Graph pointers are borrowed; control owns and retires them after completed().
// This class is also exercised with synthetic callback buffers without hardware.
class LiveAudioCallback final : public juce::AudioIODeviceCallback
{
public:
    LiveAudioCallback(double sampleRate, int bufferSize, int inputChannel);
    void publish(RealtimeProcessor* graph) noexcept;
    RealtimeProcessor* completed() const noexcept;
    void expectStop() noexcept;
    void audioDeviceIOCallbackWithContext(const float* const*, int, float* const*, int, int,
                                          const juce::AudioIODeviceCallbackContext&) override;
    void audioDeviceAboutToStart(juce::AudioIODevice*) override;
    void audioDeviceStopped() override;
    void audioDeviceError(const juce::String&) override;
    std::atomic<int> fault {0};
    std::atomic<float> inputPeak {0}, outputPeak {0}, cpuLoad {0};
    std::atomic<juce::int64> callbackCount {0}, overruns {0};
private:
    const double rate;
    const int buffer, channel, fadeLength;
    std::atomic<bool> stopping {false};
    std::atomic<RealtimeProcessor*> published {nullptr}, acknowledged {nullptr};
    RealtimeProcessor* current = nullptr;
    RealtimeProcessor* previous = nullptr;
    int fadeRemaining = 0;
    std::array<float, 512> wet {}, oldWet {};
};

// All methods/destruction run on one serialized control thread. EOF destroys it.
class LiveSession
{
public:
    LiveSession();
    ~LiveSession();
    juce::var handle(const juce::String& json);
private:
    struct Impl;
    std::unique_ptr<Impl> impl;
};
}
