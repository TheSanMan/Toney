#include "Assets.h"
#include "EffectProcessing.h"
#include "Protocol.h"
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
juce::var descriptor(const juce::File& file, const char* kind = "ir")
{
    return toney::makeObject({{"id", juce::SHA256(file).toHexString()}, {"kind", kind}, {"path", file.getFullPathName()}});
}
juce::var tone(const juce::String& id)
{
    auto value = juce::JSON::parse(R"({"schemaVersion":2,"id":"ir-tone","name":"IR test","revision":0,
      "chain":[{"id":"cab","type":"cab","model":"cab_ir","enabled":true,"parameters":{"brightness":0.5,"resonance":0},
      "asset":{"id":"placeholder","kind":"ir","name":"test.wav"}}],
      "metadata":{"createdAt":"2026-10-03T10:00:00Z","updatedAt":"2026-10-03T10:00:00Z","source":"test"}})");
    value["chain"][0]["asset"].getDynamicObject()->setProperty("id", id);
    return value;
}
}

int main()
{
    const auto directory = juce::File::getSpecialLocation(juce::File::tempDirectory).getNonexistentChildFile("toney-assets-test", "", false);
    if (!directory.createDirectory()) return 2;
    try
    {
        const auto file = directory.getChildFile("cab.wav");
        juce::AudioBuffer<float> kernel(1, 64); kernel.clear(); kernel.setSample(0, 0, 0.3f); kernel.setSample(0, 10, 0.6f); kernel.setSample(0, 30, 0.1f);
        toney::writeWaveExclusive(file, kernel, 24000);
        const auto ref = descriptor(file);
        const auto asset = toney::loadAsset(ref);
        expect(asset.info["kind"].toString() == "asset-info" && asset.info["assetKind"].toString() == "ir", "IR inspection discriminator");
        expect(static_cast<int>(asset.info["sampleRate"]) == 24000 && static_cast<int>(asset.info["frames"]) == 64 && static_cast<int>(asset.info["channels"]) == 1, "IR inspection reports measured format");
        auto rig = tone(ref["id"].toString());
        expect(toney::validateTone(rig)["kind"].toString() == "rig-valid", "schema2 IR rig accepted");
        toney::AssetLibrary library(rig, juce::Array<juce::var>{ref});
        juce::AudioBuffer<float> source(2, 512); source.clear(); source.setSample(0, 0, 0.5f); source.setSample(1, 0, 0.25f);
        toney::convolveImpulse(source, 24000, asset);
        double maximumError = 0;
        for (int channel = 0; channel < 2; ++channel)
            for (int frame = 0; frame < 512; ++frame)
            {
                const auto expected = frame < 64 ? asset.impulse->samples.getSample(0, frame) * (channel == 0 ? 0.5f : 0.25f) : 0;
                maximumError = std::max(maximumError, std::abs(static_cast<double>(source.getSample(channel, frame) - expected)));
            }
        expect(maximumError < 1e-5, "real convolution matches direct discrete impulse response without normalization");
        expect(std::abs(source.getSample(0, 10) - 2 * source.getSample(1, 10)) < 1e-6, "mono IR preserves stereo source balance");
        juce::AudioBuffer<float> resampled(1, 512); resampled.clear(); resampled.setSample(0, 0, 0.5f);
        toney::convolveImpulse(resampled, 48000, asset);
        expect(std::abs(resampled.getSample(0, 20)) > 0.1 && std::abs(resampled.getSample(0, 10)) < 0.01, "IR sample rate conversion preserves tap time");
        expect(toney::renderTailSeconds(rig, &library) > 63.0 / 24000, "IR frame length contributes render tail");
        const auto stereoFile = directory.getChildFile("stereo.wav");
        juce::AudioBuffer<float> stereo(2, 32); stereo.clear(); stereo.setSample(0, 0, 0.2f); stereo.setSample(1, 0, 0.6f);
        toney::writeWaveExclusive(stereoFile, stereo, 24000);
        const auto stereoAsset = toney::loadAsset(descriptor(stereoFile));
        juce::AudioBuffer<float> mono(1, 256); mono.clear(); mono.setSample(0, 0, 0.5f);
        toney::convolveImpulse(mono, 24000, stereoAsset);
        expect(std::abs(mono.getSample(0, 0) - 0.2f) < 0.0001, "stereo IR folds by averaging for mono source");
        auto corrupt = ref; corrupt.getDynamicObject()->setProperty("id", juce::String::repeatedString("0", 64));
        rejects("ASSET_CORRUPT", [&] { toney::inspectAsset(corrupt); }, "hash mismatch has no fallback");
        const auto missing = toney::makeObject({{"id", asset.id}, {"kind", "ir"}, {"path", directory.getChildFile("missing.wav").getFullPathName()}});
        rejects("ASSET_MISSING", [&] { toney::inspectAsset(missing); }, "missing file rejected");
        rejects("ASSET_MISSING", [&] { toney::AssetLibrary absent(rig, juce::Array<juce::var>{}); }, "enabled IR requires staged asset");
        rejects("ASSET_INVALID", [&] { toney::AssetLibrary duplicates(rig, juce::Array<juce::var>{descriptor(file), descriptor(file)}); }, "duplicate render assets rejected");
        rig["chain"][0].getDynamicObject()->setProperty("enabled", false);
        toney::AssetLibrary bypassed(rig, {});
        expect(toney::renderTailSeconds(rig, &bypassed) == 0, "bypassed IR needs no file and contributes no tail");
        auto legacy = tone(asset.id); legacy.getDynamicObject()->setProperty("schemaVersion", 1);
        rejects("INVALID_TONE_SPEC", [&] { toney::validateTone(legacy); }, "schema1 forbids asset models");
        auto builtin = tone(asset.id); builtin["chain"][0].getDynamicObject()->setProperty("model", "builtin_cab");
        rejects("INVALID_TONE_SPEC", [&] { toney::validateTone(builtin); }, "builtin model forbids asset metadata");
        const auto oversized = directory.getChildFile("long-ir.wav");
        juce::AudioBuffer<float> longKernel(1, 24000 * 2 + 1); longKernel.clear(); longKernel.setSample(0, 0, 0.1f);
        toney::writeWaveExclusive(oversized, longKernel, 24000);
        rejects("ASSET_INVALID", [&] { toney::inspectAsset(descriptor(oversized)); }, "IR duration bounded before convolution");
    }
    catch (const std::exception& error) { ++failures; std::cerr << "Unexpected error: " << error.what() << '\n'; }
    directory.deleteRecursively();
    std::cout << checks << " native asset checks; " << failures << " failed.\n";
    return failures == 0 ? 0 : 1;
}
