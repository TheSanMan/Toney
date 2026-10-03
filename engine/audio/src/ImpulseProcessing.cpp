#include "Assets.h"
#include "Protocol.h"
#include "Resampling.h"
#include <juce_dsp/juce_dsp.h>

namespace toney
{
void convolveImpulse(juce::AudioBuffer<float>& samples, double sampleRate, const LoadedAsset& asset)
{
    if (!asset.impulse) throw ControlError("ASSET_INVALID", "Cabinet convolution requires an IR asset.");
    auto impulse = asset.impulse->samples;
    if (samples.getNumChannels() == 1 && impulse.getNumChannels() == 2)
    {
        for (int frame = 0; frame < impulse.getNumSamples(); ++frame)
            impulse.setSample(0, frame, (impulse.getSample(0, frame) + impulse.getSample(1, frame)) * 0.5f);
        impulse.setSize(1, impulse.getNumSamples(), true);
    }
    if (asset.impulse->sampleRate != sampleRate)
    {
        impulse = resampleBuffer(impulse, asset.impulse->sampleRate, sampleRate);
        // Compensate only for discrete-kernel sample density, not loudness.
        impulse.applyGain(static_cast<float>(asset.impulse->sampleRate / sampleRate));
    }
    juce::dsp::Convolution convolution(juce::dsp::Convolution::Latency{0});
    convolution.loadImpulseResponse(std::move(impulse), sampleRate,
                                   juce::dsp::Convolution::Stereo::yes, juce::dsp::Convolution::Trim::no,
                                   juce::dsp::Convolution::Normalise::no);
    constexpr juce::uint32 blockSize = 512;
    convolution.prepare({sampleRate, blockSize, static_cast<juce::uint32>(samples.getNumChannels())});
    convolution.reset();
    if (convolution.getLatency() != 0) throw ControlError("AUDIO_RENDER_FAILED", "Unexpected cabinet convolution latency.");
    auto block = juce::dsp::AudioBlock<float>(samples);
    for (std::size_t offset = 0; offset < static_cast<std::size_t>(samples.getNumSamples()); offset += blockSize)
    {
        auto part = block.getSubBlock(offset, std::min<std::size_t>(blockSize, samples.getNumSamples() - offset));
        convolution.process(juce::dsp::ProcessContextReplacing<float>(part));
    }
}
}
