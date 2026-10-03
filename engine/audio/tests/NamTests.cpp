#include "Assets.h"
#include "NamModel.h"
#include "Protocol.h"
#include <NAM/lstm.h>
#include <NAM/wavenet.h>
#include <juce_cryptography/juce_cryptography.h>
#include <cmath>
#include <functional>
#include <iostream>

namespace
{
int checks = 0, failures = 0;
void expect(bool condition, const char* label)
{
    ++checks;
    if (!condition) { ++failures; std::cerr << "FAIL: " << label << '\n'; }
}
void rejects(const char* code, const std::function<void()>& operation, const char* label)
{
    bool rejected = false;
    try { operation(); } catch (const toney::ControlError& error) { rejected = error.code == code; }
    expect(rejected, label);
}
juce::var descriptor(const juce::File& file)
{
    return toney::makeObject({{"id", juce::SHA256(file).toHexString()}, {"kind", "nam"}, {"path", file.getFullPathName()}});
}
juce::AudioBuffer<float> signal()
{
    juce::AudioBuffer<float> samples(2, 2048);
    for (int frame = 0; frame < samples.getNumSamples(); ++frame)
    {
        const auto sample = static_cast<float>(0.13 * std::sin(frame * 0.093) + 0.07 * std::sin(frame * 0.177));
        samples.setSample(0, frame, sample); samples.setSample(1, frame, sample * 0.5f);
    }
    return samples;
}
double maxDifference(const juce::AudioBuffer<float>& a, const juce::AudioBuffer<float>& b)
{
    double difference = 0;
    for (int channel = 0; channel < a.getNumChannels(); ++channel)
        for (int frame = 0; frame < a.getNumSamples(); ++frame)
            difference = std::max(difference, std::abs(static_cast<double>(a.getSample(channel, frame) - b.getSample(channel, frame))));
    return difference;
}

// Scalar LSTM equations provide an independent numerical oracle for the
// upstream one-layer smoke fixture, including its exported initial states.
std::vector<float> scalarLstm(const toney::NamModelDefinition& definition, const float* input, int frames)
{
    const int hidden = definition.config["hidden_size"];
    const auto& w = definition.weights;
    const auto matrixCount = 4 * hidden * (1 + hidden), biasOffset = matrixCount;
    std::vector<double> state(hidden), cell(hidden);
    for (int i = 0; i < hidden; ++i) { state[i] = w[biasOffset + 4 * hidden + i]; cell[i] = w[biasOffset + 5 * hidden + i]; }
    const auto headOffset = biasOffset + 6 * hidden;
    const auto step = [&](double sample) {
        std::vector<double> gates(4 * hidden);
        for (int row = 0; row < 4 * hidden; ++row)
        {
            gates[row] = w[biasOffset + row] + w[row * (hidden + 1)] * sample;
            for (int i = 0; i < hidden; ++i) gates[row] += w[row * (hidden + 1) + 1 + i] * state[i];
        }
        const auto sigmoid = [](double value) { return 1.0 / (1.0 + std::exp(-value)); };
        for (int i = 0; i < hidden; ++i)
        {
            cell[i] = sigmoid(gates[hidden + i]) * cell[i] + sigmoid(gates[i]) * std::tanh(gates[2 * hidden + i]);
            state[i] = sigmoid(gates[3 * hidden + i]) * std::tanh(cell[i]);
        }
        double output = w[headOffset + hidden];
        for (int i = 0; i < hidden; ++i) output += w[headOffset + i] * state[i];
        return static_cast<float>(output);
    };
    const auto prewarm = static_cast<int>(std::ceil(0.5 * definition.sampleRate / 512)) * 512;
    for (int frame = 0; frame < prewarm; ++frame) step(0);
    std::vector<float> result(frames);
    for (int frame = 0; frame < frames; ++frame) result[frame] = step(input[frame]);
    return result;
}
}

int main()
{
    const auto directory = juce::File::getSpecialLocation(juce::File::tempDirectory).getNonexistentChildFile("toney-nam-tests", "", false);
    if (!directory.createDirectory()) return 2;
    try
    {
        for (const auto* name : {"wavenet.nam", "lstm.nam"})
        {
            const auto file = juce::File(TONEY_NAM_FIXTURES).getChildFile(name);
            const auto asset = toney::loadAsset(descriptor(file));
            expect(asset.neural != nullptr && asset.info["modelVersion"].toString() == "0.5.4", "official NAM smoke fixture inspected");
            expect(static_cast<int>(asset.info["channels"]) == 1 && static_cast<double>(asset.info["sampleRate"]) == 48000, "NAM inspection reports model rate/mono architecture");
            auto input = signal(), actual = input;
            toney::processNam(actual, 48000, *asset.neural);
            auto repeated = input; toney::processNam(repeated, 48000, *asset.neural);
            expect(maxDifference(actual, repeated) == 0, "NAM state resets deterministically per render");
            auto reference = input;
            for (int channel = 0; channel < input.getNumChannels(); ++channel)
            {
                auto weights = asset.neural->weights;
                auto processor = asset.neural->architecture == "LSTM"
                    ? nam::lstm::Factory(asset.neural->config, weights, 48000)
                    : nam::wavenet::Factory(asset.neural->config, weights, 48000);
                processor->Reset(48000, 512);
                for (int offset = 0; offset < input.getNumSamples(); offset += 512)
                    processor->process(input.getWritePointer(channel, offset), reference.getWritePointer(channel, offset), 512);
            }
            expect(maxDifference(actual, reference) < 1e-7, "NAM wrapper matches direct official inference sample for sample");
            expect(maxDifference(actual, input) > 0.01, "NAM executes the learned network rather than a passthrough");
            if (asset.neural->architecture == "LSTM")
            {
                const auto independent = scalarLstm(*asset.neural, input.getReadPointer(0), input.getNumSamples());
                double error = 0;
                for (int frame = 0; frame < input.getNumSamples(); ++frame) error = std::max(error, std::abs(static_cast<double>(actual.getSample(0, frame) - independent[frame])));
                expect(error < 2e-6, "official LSTM output matches independent scalar equations");
            }
            auto converted = input;
            toney::processNam(converted, 44100, *asset.neural);
            expect(converted.getNumChannels() == 2 && converted.getNumSamples() == input.getNumSamples(), "NAM resampling preserves recording channels/frame count");
            bool finite = true;
            for (int channel = 0; channel < 2; ++channel)
                for (int frame = 0; frame < converted.getNumSamples(); ++frame) finite = finite && std::isfinite(converted.getSample(channel, frame));
            expect(finite, "NAM rate-converted output is finite");

            const auto base = nlohmann::json::parse(file.loadFileAsString().toStdString());
            const auto mutated = directory.getChildFile("mutation.nam");
            auto changed = base; changed["weights"].erase(changed["weights"].end() - 1); mutated.replaceWithText(changed.dump());
            rejects("ASSET_INVALID", [&] { toney::inspectAsset(descriptor(mutated)); }, "short weights rejected before unsafe upstream iteration");
            changed = base; changed["weights"].push_back(0); mutated.replaceWithText(changed.dump());
            rejects("ASSET_INVALID", [&] { toney::inspectAsset(descriptor(mutated)); }, "extra weights rejected before construction");
            changed = base; changed["version"] = "0.7.0"; mutated.replaceWithText(changed.dump());
            rejects("ASSET_UNSUPPORTED", [&] { toney::inspectAsset(descriptor(mutated)); }, "unsupported NAM format version rejected");
            changed = base; changed["weights"][0] = "not-a-number"; mutated.replaceWithText(changed.dump());
            rejects("ASSET_INVALID", [&] { toney::inspectAsset(descriptor(mutated)); }, "non-numeric weight rejected");
            changed = base; changed.erase("sample_rate"); mutated.replaceWithText(changed.dump());
            expect(static_cast<double>(toney::inspectAsset(descriptor(mutated))["sampleRate"]) == 48000, "missing model rate uses documented 48000 Hz assumption");
            changed = base; changed["sample_rate"] = 48000.5; mutated.replaceWithText(changed.dump());
            expect(static_cast<double>(toney::inspectAsset(descriptor(mutated))["sampleRate"]) == 48000.5, "finite fractional model sample rate preserved");
            changed = base; changed["config"]["in_channels"] = 2; mutated.replaceWithText(changed.dump());
            rejects("ASSET_UNSUPPORTED", [&] { toney::inspectAsset(descriptor(mutated)); }, "advanced multi-channel model rejected");
        }
        const auto malformed = directory.getChildFile("bad.nam"); malformed.replaceWithText("{\"version\":\"0.5.4\",\"version\":\"0.5.3\"}");
        rejects("ASSET_INVALID", [&] { toney::inspectAsset(descriptor(malformed)); }, "duplicate model JSON fields rejected");
        malformed.replaceWithText("{\"weights\":[1e9999]}");
        rejects("ASSET_INVALID", [&] { toney::inspectAsset(descriptor(malformed)); }, "non-finite JSON number rejected");
        auto large = nlohmann::json::parse(juce::File(TONEY_NAM_FIXTURES).getChildFile("wavenet.nam").loadFileAsString().toStdString());
        large["config"]["layers"][0]["dilations"][0] = 2147483647; malformed.replaceWithText(large.dump());
        rejects("ASSET_UNSUPPORTED", [&] { toney::inspectAsset(descriptor(malformed)); }, "absurd receptive field rejected before buffer allocation");
    }
    catch (const std::exception& error) { ++failures; std::cerr << "Unexpected test error: " << error.what() << '\n'; }
    directory.deleteRecursively();
    std::cout << checks << " native NAM checks; " << failures << " failed.\n";
    return failures == 0 ? 0 : 1;
}
