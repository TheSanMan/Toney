#include "Protocol.h"
#include "EffectProcessing.h"
#include "WaveFiles.h"
#include <cmath>
#include <iostream>
#include <limits>
#include <vector>

namespace
{
int failures = 0, checks = 0, sequence = 0;
constexpr int sampleRate = 44100;
constexpr double pi = 3.14159265358979323846;
juce::File directory;

void expect(bool condition, const juce::String& label)
{
    ++checks;
    if (!condition) { ++failures; std::cerr << "FAIL: " << label << '\n'; }
}

juce::File uniqueFile() { return directory.getChildFile("render-" + juce::String(++sequence) + ".wav"); }

juce::var fixture()
{
    return juce::JSON::parse(R"({"schemaVersion":1,"id":"render-tone","name":"Native DSP fixture","revision":3,
      "chain":[
        {"id":"compressor","type":"compressor","model":"builtin_compressor","enabled":true,"parameters":{"amount":0.6,"attack":0.4}},
        {"id":"drive","type":"drive","model":"builtin_drive","enabled":true,"parameters":{"gain":0.4,"tone":0.5,"level":0.5}},
        {"id":"amp","type":"amp","model":"builtin_amp","enabled":true,"parameters":{"gain":0.3,"bass":0.5,"mid":0.55,"treble":0.5,"master":0.6}},
        {"id":"cab","type":"cab","model":"builtin_cab","enabled":true,"parameters":{"brightness":0.5,"resonance":0.4}},
        {"id":"eq","type":"eq","model":"builtin_eq","enabled":true,"parameters":{"lowDb":0,"midDb":0,"highDb":0}},
        {"id":"chorus","type":"chorus","model":"builtin_chorus","enabled":true,"parameters":{"rate":0.8,"depth":0.4,"mix":0.3}},
        {"id":"delay","type":"delay","model":"builtin_delay","enabled":true,"parameters":{"time":0.12,"feedback":0.4,"mix":0.25}},
        {"id":"reverb","type":"reverb","model":"builtin_reverb","enabled":true,"parameters":{"decay":1.2,"mix":0.2}}
      ],"metadata":{"createdAt":"2026-10-02T10:00:00Z","updatedAt":"2026-10-02T10:00:00Z","source":"test"}})");
}

juce::var bypass()
{
    auto tone = fixture();
    for (auto& node : *tone.getDynamicObject()->getProperties().getVarPointer("chain")->getArray())
        node.getDynamicObject()->setProperty("enabled", false);
    return tone;
}

juce::var single(const juce::String& type)
{
    auto tone = fixture();
    for (const auto& node : *tone["chain"].getArray())
        if (node["type"].toString() == type)
        {
            tone.getDynamicObject()->setProperty("chain", juce::Array<juce::var>{node});
            return tone;
        }
    throw std::runtime_error("fixture type missing");
}

juce::var options(const juce::File& input, const juce::File& output)
{
    return toney::makeObject({{"inputPath", input.getFullPathName()}, {"outputPath", output.getFullPathName()}});
}

juce::AudioBuffer<float> signal(int channels = 2, int frames = sampleRate / 2)
{
    juce::AudioBuffer<float> buffer(channels, frames);
    for (int channel = 0; channel < channels; ++channel)
        for (int frame = 0; frame < frames; ++frame)
        {
            const auto time = static_cast<double>(frame) / sampleRate;
            const auto pulse = frame % 7000 < 110 ? 0.35 : 0.0;
            const auto sample = (0.1 * std::sin(2 * pi * 112 * time) + 0.09 * std::sin(2 * pi * 970 * time)
                                  + 0.06 * std::sin(2 * pi * 4100 * time) + pulse) * (channel == 0 ? 1.0 : 0.5);
            buffer.setSample(channel, frame, static_cast<float>(sample));
        }
    return buffer;
}

double difference(const juce::AudioBuffer<float>& a, const juce::AudioBuffer<float>& b, int frames)
{
    double total = 0;
    for (int channel = 0; channel < a.getNumChannels(); ++channel)
        for (int frame = 0; frame < frames; ++frame)
        {
            const auto delta = a.getSample(channel, frame) - b.getSample(channel, frame);
            total += delta * delta;
        }
    return total / (frames * a.getNumChannels());
}

void rejects(const juce::String& expected, const juce::var& tone, const juce::var& render, const char* label)
{
    bool rejected = false;
    try { toney::renderAudio(tone, render); }
    catch (const toney::ControlError& error) { rejected = error.code == expected; }
    expect(rejected, label);
}

void floatWave(const juce::File& file, float value)
{
    auto output = file.createOutputStream();
    output->write("RIFF", 4); output->writeInt(40); output->write("WAVEfmt ", 8);
    output->writeInt(16); output->writeShort(3); output->writeShort(1);
    output->writeInt(sampleRate); output->writeInt(sampleRate * 4);
    output->writeShort(4); output->writeShort(32); output->write("data", 4);
    output->writeInt(4); output->writeFloat(value);
}
}

int main()
{
    directory = juce::File::getSpecialLocation(juce::File::tempDirectory).getNonexistentChildFile("toney-native-tests", "", false);
    if (!directory.createDirectory()) return 2;
    try
    {
        const auto source = signal();
        const auto input = uniqueFile();
        toney::writeWaveExclusive(input, source, sampleRate);
        const auto decoded = toney::readWave(input);
        expect(decoded.sampleRate == sampleRate && decoded.samples.getNumChannels() == 2, "PCM16 WAV decoding preserves sample rate and channels");
        expect(difference(source, decoded.samples, source.getNumSamples()) < 2e-9, "PCM16 source quantization bounded");
        const auto identityOutput = uniqueFile();
        const auto identity = toney::renderAudio(bypass(), options(input, identityOutput));
        const auto identityDecoded = toney::readWave(identityOutput);
        expect(identity["kind"].toString() == "audio-render" && identity["engineVersion"].toString() == "0.3.0", "discriminated render metadata/version");
        expect(static_cast<int>(identity["inputFrames"]) == source.getNumSamples() && static_cast<int>(identity["outputFrames"]) == source.getNumSamples(), "bypass has exact source/end frame count");
        expect(static_cast<double>(identity["attenuationDb"]) == 0, "quiet recording is never boosted");
        expect(difference(decoded.samples, identityDecoded.samples, source.getNumSamples()) < 2e-9, "bypass preserves source identity and stereo balance");

        const auto outputA = uniqueFile(), outputB = uniqueFile();
        const auto rendered = toney::renderAudio(fixture(), options(input, outputA));
        toney::renderAudio(fixture(), options(input, outputB));
        juce::MemoryBlock bytesA, bytesB;
        outputA.loadFileAsData(bytesA); outputB.loadFileAsData(bytesB);
        expect(bytesA == bytesB, "all eight effects are byte-deterministic");
        expect(static_cast<int>(rendered["outputFrames"]) > source.getNumSamples(), "time effects include end tails");
        expect(static_cast<int>(rendered["outputFrames"]) <= source.getNumSamples() + sampleRate * 12, "tail capped at twelve seconds");
        expect(outputA.getSize() <= toney::maxWaveBytes, "WAV byte budget respected");
        const auto ambient = toney::readWave(outputA);
        double peak = 0, tailEnergy = 0;
        for (int channel = 0; channel < ambient.samples.getNumChannels(); ++channel)
            for (int frame = 0; frame < ambient.samples.getNumSamples(); ++frame)
            {
                const auto value = ambient.samples.getSample(channel, frame);
                peak = std::max(peak, std::abs(static_cast<double>(value)));
                if (frame >= source.getNumSamples()) tailEnergy += value * value;
            }
        expect(peak <= 0.8501 && std::abs(peak - static_cast<double>(rendered["peak"])) < 0.0001, "headroom and measured PCM peak match metadata");
        expect(tailEnergy > 0.001, "reported tail contains audible energy");

        // Every exposed knob changes an appropriate multi-frequency/transient source.
        const std::vector<std::pair<juce::String, std::vector<std::tuple<const char*, double, double>>>> controls {
            {"compressor", {{"amount", 0, 1}, {"attack", 0, 1}}},
            {"drive", {{"gain", 0, 1}, {"tone", 0, 1}, {"level", 0, 1}}},
            {"amp", {{"gain", 0, 1}, {"bass", 0, 1}, {"mid", 0, 1}, {"treble", 0, 1}, {"master", 0, 1}}},
            {"cab", {{"brightness", 0, 1}, {"resonance", 0, 1}}},
            {"eq", {{"lowDb", -12, 12}, {"midDb", -12, 12}, {"highDb", -12, 12}}},
            {"chorus", {{"rate", 0.1, 5}, {"depth", 0, 1}, {"mix", 0, 1}}},
            {"delay", {{"time", 0.05, 1}, {"feedback", 0, 0.8}, {"mix", 0, 1}}},
            {"reverb", {{"decay", 0.2, 5}, {"mix", 0, 1}}},
        };
        for (const auto& group : controls)
            for (const auto& control : group.second)
            {
                auto low = single(group.first), high = single(group.first);
                low["chain"][0]["parameters"].getDynamicObject()->setProperty(std::get<0>(control), std::get<1>(control));
                high["chain"][0]["parameters"].getDynamicObject()->setProperty(std::get<0>(control), std::get<2>(control));
                auto lowSamples = signal(), highSamples = signal();
                toney::processEffects(lowSamples, sampleRate, low); toney::processEffects(highSamples, sampleRate, high);
                expect(difference(lowSamples, highSamples, source.getNumSamples()) > 1e-8, group.first + "." + std::get<0>(control) + " affects samples");
            }

        auto loud = signal(); loud.applyGain(3);
        const auto loudInput = uniqueFile();
        // Floating WAV retains overs above nominal PCM amplitude for headroom testing.
        floatWave(loudInput, 1.5f);
        const auto loudOutput = uniqueFile();
        const auto loudResult = toney::renderAudio(bypass(), options(loudInput, loudOutput));
        expect(static_cast<double>(loudResult["attenuationDb"]) < 0 && static_cast<double>(loudResult["peak"]) <= 0.85, "attenuation-only headroom ceiling");
        const auto mono = toney::readWave(loudOutput);
        expect(mono.samples.getNumChannels() == 1 && mono.samples.getNumSamples() == 1, "mono bypass preserves channels/frame count");

        auto longDelay = single("delay");
        longDelay["chain"][0]["parameters"].getDynamicObject()->setProperty("time", 1);
        longDelay["chain"][0]["parameters"].getDynamicObject()->setProperty("feedback", 0.8);
        expect(toney::renderTailSeconds(longDelay) == 12, "long feedback tail is capped");
        rejects("AUDIO_INPUT_INVALID", bypass(), options(uniqueFile(), uniqueFile()), "missing input rejected");
        rejects("INVALID_RENDER_REQUEST", bypass(), juce::var(), "missing render paths rejected");
        rejects("AUDIO_OUTPUT_EXISTS", bypass(), options(input, identityOutput), "existing output rejected");
        juce::MemoryBlock unchanged; identityOutput.loadFileAsData(unchanged);
        expect(unchanged.getSize() > 44, "existing output remains intact");
        const auto silentInput = uniqueFile(); floatWave(silentInput, 0);
        rejects("AUDIO_INPUT_INVALID", bypass(), options(silentInput, uniqueFile()), "silent input rejected");
        const auto nanInput = uniqueFile(); floatWave(nanInput, std::numeric_limits<float>::quiet_NaN());
        rejects("AUDIO_INPUT_INVALID", bypass(), options(nanInput, uniqueFile()), "nonfinite float input rejected");
        const auto truncated = uniqueFile();
        unchanged.reset(); input.loadFileAsData(unchanged); truncated.replaceWithData(unchanged.getData(), unchanged.getSize() - 2);
        rejects("AUDIO_INPUT_INVALID", bypass(), options(truncated, uniqueFile()), "truncated declared WAV data rejected");
        const auto tooLong = uniqueFile();
        juce::AudioBuffer<float> longSamples(1, 8000 * 91); longSamples.clear(); longSamples.setSample(0, 0, 0.1f);
        toney::writeWaveExclusive(tooLong, longSamples, 8000);
        rejects("AUDIO_INPUT_TOO_LARGE", bypass(), options(tooLong, uniqueFile()), "duration limit rejected");
        const auto tooManyBytes = uniqueFile();
        {
            auto sparse = tooManyBytes.createOutputStream();
            sparse->setPosition(toney::maxWaveBytes); sparse->writeByte(0);
        }
        rejects("AUDIO_INPUT_TOO_LARGE", bypass(), options(tooManyBytes, uniqueFile()), "32 MiB input budget rejected before decoding");
        // At 96 kHz this source fits both input limits; its wet tail does not fit
        // the PCM16 output budget. Reject before processing or creating output.
        const auto nearBudget = uniqueFile(), oversizeOutput = uniqueFile();
        juce::AudioBuffer<float> nearSamples(2, 96000 * 80); nearSamples.clear(); nearSamples.setSample(0, 0, 0.1f);
        toney::writeWaveExclusive(nearBudget, nearSamples, 96000);
        rejects("AUDIO_OUTPUT_TOO_LARGE", longDelay, options(nearBudget, oversizeOutput), "32 MiB output budget includes effect tail");
        expect(!oversizeOutput.exists(), "oversize render creates no partial output");
    }
    catch (const std::exception& error) { ++failures; std::cerr << "Unexpected test error: " << error.what() << '\n'; }
    directory.deleteRecursively();
    std::cout << checks << " native render checks; " << failures << " failed.\n";
    return failures == 0 ? 0 : 1;
}
