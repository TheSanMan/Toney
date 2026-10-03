#include "NamModel.h"
#include "Protocol.h"
#include "Resampling.h"
#include <NAM/lstm.h>
#include <NAM/wavenet.h>
#include <NAM/version.h>
#include <cmath>

namespace toney
{
static_assert(NEURAL_AMP_MODELER_DSP_VERSION_MAJOR == 0 && NEURAL_AMP_MODELER_DSP_VERSION_MINOR == 3
              && NEURAL_AMP_MODELER_DSP_VERSION_PATCH == 0, "Toney requires its pinned official NAM core version.");

std::unique_ptr<nam::DSP> createNamProcessor(const NamModelDefinition& definition)
{
    auto weights = definition.weights;
    std::unique_ptr<nam::DSP> processor;
    if (definition.architecture == "LSTM") processor = nam::lstm::Factory(definition.config, weights, definition.sampleRate);
    else if (definition.architecture == "WaveNet") processor = nam::wavenet::Factory(definition.config, weights, definition.sampleRate);
    else throw ControlError("ASSET_UNSUPPORTED", "Unsupported NAM architecture.");
    // Each new instance starts from exported initial state. Reset performs the
    // official prewarm at model rate before the first source sample is processed.
    processor->Reset(definition.sampleRate, 512);
    return processor;
}

void processNam(juce::AudioBuffer<float>& samples, double sourceRate, const NamModelDefinition& definition)
{
    const auto frames = samples.getNumSamples();
    auto atModelRate = resampleBuffer(samples, sourceRate, definition.sampleRate);
    juce::AudioBuffer<float> modeled(samples.getNumChannels(), atModelRate.getNumSamples());
    for (int channel = 0; channel < samples.getNumChannels(); ++channel)
    {
        auto processor = createNamProcessor(definition); // Independent state for each source channel.
        for (int offset = 0; offset < atModelRate.getNumSamples(); offset += 512)
        {
            const auto count = std::min(512, atModelRate.getNumSamples() - offset);
            processor->process(atModelRate.getWritePointer(channel, offset), modeled.getWritePointer(channel, offset), count);
        }
    }
    for (int channel = 0; channel < modeled.getNumChannels(); ++channel)
        for (int frame = 0; frame < modeled.getNumSamples(); ++frame)
            if (!std::isfinite(modeled.getSample(channel, frame)))
                throw ControlError("AUDIO_RENDER_FAILED", "NAM inference produced non-finite audio; choose another model.");
    samples = resampleBuffer(modeled, definition.sampleRate, sourceRate, frames);
}
}
