#pragma once
#include <juce_audio_basics/juce_audio_basics.h>

namespace toney
{
// Offline, centered windowed-sinc interpolation. Out-of-range input is zero;
// no artificial latency or automatic level normalization is introduced.
juce::AudioBuffer<float> resampleBuffer(const juce::AudioBuffer<float>& source, double sourceRate,
                                      double destinationRate, int destinationFrames = -1);
}
