#include "Protocol.h"
#include "EffectProcessing.h"
#include "WaveFiles.h"
#include "Assets.h"
#include <algorithm>
#include <cmath>

namespace toney
{
namespace
{
juce::File path(const juce::var& render, const char* key)
{
    const auto value = render[key];
    if (!value.isString() || value.toString().isEmpty() || value.toString().length() > 4096
        || !juce::File::isAbsolutePath(value.toString()))
        throw ControlError("INVALID_RENDER_REQUEST", "Render paths must be nonempty absolute local file paths.");
    return juce::File(value.toString());
}
}

juce::var renderAudio(const juce::var& tone, const juce::var& render)
{
    const auto validation = validateTone(tone);
    const auto* options = render.getDynamicObject();
    if (options == nullptr || !options->hasProperty("inputPath") || !options->hasProperty("outputPath")
        || (options->getProperties().size() != 2 && !(options->getProperties().size() == 3 && options->hasProperty("assets"))))
        throw ControlError("INVALID_RENDER_REQUEST", "Render requires inputPath, outputPath, and optional assets.");
    const AssetLibrary assets(tone, render["assets"]);
    const auto input = path(render, "inputPath"), output = path(render, "outputPath");
    if (output.exists()) throw ControlError("AUDIO_OUTPUT_EXISTS", "Output already exists; it was not overwritten.");
    auto source = readWave(input);
    const auto inputFrames = source.samples.getNumSamples();
    const auto tailFrames = static_cast<int>(std::ceil(renderTailSeconds(tone, &assets) * source.sampleRate));
    const auto outputFrames = inputFrames + tailFrames;
    if (static_cast<juce::int64>(outputFrames) * source.samples.getNumChannels() * 2 + 4096 > maxWaveBytes)
        throw ControlError("AUDIO_OUTPUT_TOO_LARGE", "Rendered PCM16 WAV exceeds the 32 MiB limit.");
    const auto channels = source.samples.getNumChannels();
    source.samples.setSize(channels, outputFrames, true, true);
    processEffects(source.samples, source.sampleRate, tone, &assets);
    double rawPeak = 0;
    for (int channel = 0; channel < channels; ++channel)
        for (int frame = 0; frame < outputFrames; ++frame)
        {
            const auto value = source.samples.getSample(channel, frame);
            if (!std::isfinite(value)) throw ControlError("AUDIO_RENDER_FAILED", "Native processing produced non-finite samples.");
            rawPeak = std::max(rawPeak, std::abs(static_cast<double>(value)));
        }
    const auto gain = rawPeak > 0.85 ? 0.85 / rawPeak : 1.0;
    if (gain < 1) source.samples.applyGain(static_cast<float>(gain));
    writeWaveExclusive(output, source.samples, source.sampleRate);
    return makeObject({{"kind", "audio-render"}, {"toneId", validation["toneId"]}, {"revision", validation["revision"]},
                       {"sampleRate", source.sampleRate}, {"channels", channels}, {"inputFrames", inputFrames},
                       {"outputFrames", outputFrames}, {"peak", rawPeak * gain},
                       {"attenuationDb", gain < 1 ? 20.0 * std::log10(gain) : 0.0}, {"engineVersion", "0.5.0"}});
}
}
