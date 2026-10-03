#include "Assets.h"
#include "Protocol.h"
#include "NamModel.h"
#include <juce_cryptography/juce_cryptography.h>
#include <set>
#include <array>
#include <cmath>

namespace toney
{
LoadedAsset loadAsset(const juce::var& descriptor)
{
    const auto* fields = descriptor.getDynamicObject();
    if (fields == nullptr || fields->getProperties().size() != 3 || !fields->hasProperty("id")
        || !fields->hasProperty("kind") || !fields->hasProperty("path"))
        throw ControlError("ASSET_INVALID", "Asset descriptor requires exactly id, kind, and path.");
    const auto id = descriptor["id"].toString(), kind = descriptor["kind"].toString(), path = descriptor["path"].toString();
    if (!descriptor["id"].isString() || id.length() != 64 || !id.containsOnly("0123456789abcdef")
        || !descriptor["kind"].isString() || (kind != "ir" && kind != "nam")
        || !descriptor["path"].isString() || path.isEmpty() || path.length() > 4096 || !juce::File::isAbsolutePath(path))
        throw ControlError("ASSET_INVALID", "Asset descriptor contains invalid fields.");
    const juce::File file(path);
    if (!file.existsAsFile()) throw ControlError("ASSET_MISSING", "Required audio asset is missing; import it again.");
    const auto limit = kind == "ir" ? 8 * 1024 * 1024 : 32 * 1024 * 1024;
    if (file.getSize() < 1 || file.getSize() > limit) throw ControlError("ASSET_INVALID", "Asset exceeds its supported file size limit.");
    juce::FileInputStream input(file);
    if (input.failedToOpen()) throw ControlError("ASSET_MISSING", "Required audio asset is unreadable; import it again.");
    if (juce::SHA256(input).toHexString() != id) throw ControlError("ASSET_CORRUPT", "Audio asset hash does not match its identifier; import the original asset again.");
    LoadedAsset asset {id, kind, file, {}, {}};
    if (kind == "ir")
    {
        try { asset.impulse = std::make_unique<DecodedWave>(readWave(file, 8 * 1024 * 1024, 2)); }
        catch (const ControlError&) { throw ControlError("ASSET_INVALID", "IR must be a finite audible mono or stereo WAV, 8000–96000 Hz, at most 2 seconds and 8 MiB."); }
        asset.info = makeObject({{"kind", "asset-info"}, {"id", id}, {"assetKind", kind},
                                  {"sampleRate", asset.impulse->sampleRate}, {"channels", asset.impulse->samples.getNumChannels()},
                                  {"frames", asset.impulse->samples.getNumSamples()}});
    }
    else
    {
        asset.neural = readNamModel(file);
        try
        {
            auto processor = createNamProcessor(*asset.neural);
            std::array<float, 64> silence {}, output {};
            processor->process(silence.data(), output.data(), 64);
            for (const auto sample : output)
                if (!std::isfinite(sample)) throw ControlError("ASSET_INVALID", "NAM model produces non-finite audio after prewarm.");
        }
        catch (const ControlError&) { throw; }
        catch (const std::exception&) { throw ControlError("ASSET_INVALID", "NAM model cannot initialize safely with its configuration and weights."); }
        asset.info = makeObject({{"kind", "asset-info"}, {"id", id}, {"assetKind", kind},
                                 {"sampleRate", asset.neural->sampleRate}, {"channels", 1},
                                 {"architecture", juce::String(asset.neural->architecture)}, {"modelVersion", juce::String(asset.neural->modelVersion)}});
    }
    return asset;
}

juce::var inspectAsset(const juce::var& descriptor) { return loadAsset(descriptor).info; }

AssetLibrary::AssetLibrary(const juce::var& tone, const juce::var& supplied)
{
    std::map<juce::String, juce::String> required;
    for (const auto& node : *tone["chain"].getArray())
        if (static_cast<bool>(node["enabled"]) && node.getDynamicObject()->hasProperty("asset"))
        {
            const auto id = node["asset"]["id"].toString(), kind = node["asset"]["kind"].toString();
            if (required.count(id) && required[id] != kind) throw ControlError("ASSET_INVALID", "One asset ID cannot have multiple kinds.");
            required[id] = kind;
        }
    if (!supplied.isVoid() && (!supplied.isArray() || supplied.getArray()->size() > 32))
        throw ControlError("ASSET_INVALID", "Render assets must be an array with at most 32 entries.");
    if (supplied.isArray())
        for (const auto& descriptor : *supplied.getArray())
        {
            const auto id = descriptor["id"].toString();
            if (assets.count(id) || !required.count(id)) throw ControlError("ASSET_INVALID", "Render contains duplicate or unreferenced asset IDs.");
            auto asset = loadAsset(descriptor);
            if (asset.kind != required[id]) throw ControlError("ASSET_INVALID", "Render asset kind does not match the rig.");
            assets.emplace(id, std::move(asset));
        }
    for (const auto& entry : required)
        if (!assets.count(entry.first)) throw ControlError("ASSET_MISSING", "A required rig asset is missing; import it again or bypass its node.");
}

const LoadedAsset& AssetLibrary::get(const juce::String& id) const
{
    const auto found = assets.find(id);
    if (found == assets.end()) throw ControlError("ASSET_MISSING", "Required rig asset is unavailable.");
    return found->second;
}
}
