#pragma once
#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>
#include <NAM/dsp.h>
#include <json.hpp>
#include <memory>

namespace toney
{
struct NamModelDefinition
{
    nlohmann::json config;
    std::vector<float> weights;
    std::string architecture, modelVersion;
    double sampleRate;
};
std::shared_ptr<const NamModelDefinition> readNamModel(const juce::File& file);
std::unique_ptr<nam::DSP> createNamProcessor(const NamModelDefinition& definition);
void processNam(juce::AudioBuffer<float>& samples, double sourceRate, const NamModelDefinition& definition);
}
