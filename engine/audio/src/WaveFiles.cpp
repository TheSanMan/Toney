#include "WaveFiles.h"
#include "Protocol.h"
#include <juce_audio_formats/juce_audio_formats.h>
#include <cerrno>
#include <cmath>
#include <cstdio>
#include <memory>

namespace toney
{
namespace
{
[[noreturn]] void invalidWave() { throw ControlError("AUDIO_INPUT_INVALID", "Input must be a complete supported mono or stereo WAV recording."); }

void inspectChunks(juce::FileInputStream& input, juce::int64 fileBytes)
{
    char signature[4];
    if (input.read(signature, 4) != 4 || std::string(signature, 4) != "RIFF") invalidWave();
    const auto riffBytes = static_cast<juce::uint32>(input.readInt());
    if (static_cast<juce::int64>(riffBytes) + 8 > fileBytes || riffBytes < 36) invalidWave();
    if (input.read(signature, 4) != 4 || std::string(signature, 4) != "WAVE") invalidWave();
    const auto end = static_cast<juce::int64>(riffBytes) + 8;
    bool formatFound = false, dataFound = false;
    int alignment = 0;
    juce::uint32 dataBytes = 0;
    while (input.getPosition() < end)
    {
        if (end - input.getPosition() < 8 || input.read(signature, 4) != 4) invalidWave();
        const auto bytes = static_cast<juce::uint32>(input.readInt());
        const auto start = input.getPosition();
        const auto paddedEnd = start + bytes + (bytes & 1u);
        if (paddedEnd > end) invalidWave();
        const auto name = std::string(signature, 4);
        if (name == "fmt ")
        {
            if (formatFound || bytes < 16) invalidWave();
            formatFound = true;
            auto encoding = static_cast<juce::uint16>(input.readShort());
            const auto channels = static_cast<juce::uint16>(input.readShort());
            const auto sampleRate = static_cast<juce::uint32>(input.readInt());
            const auto bytesPerSecond = static_cast<juce::uint32>(input.readInt());
            alignment = static_cast<juce::uint16>(input.readShort());
            const auto bits = static_cast<juce::uint16>(input.readShort());
            if (encoding == 0xfffe)
            {
                if (bytes < 40 || static_cast<juce::uint16>(input.readShort()) < 22) invalidWave();
                input.skipNextBytes(6); // Valid bits and speaker mask; JUCE validates the full GUID.
                encoding = static_cast<juce::uint16>(input.readShort());
            }
            const bool pcm = encoding == 1 && (bits == 8 || bits == 16 || bits == 24 || bits == 32);
            const bool floating = encoding == 3 && bits == 32;
            if ((!pcm && !floating) || channels < 1 || channels > 2 || sampleRate < 8000 || sampleRate > 96000
                || alignment != channels * (bits / 8) || bytesPerSecond != sampleRate * static_cast<juce::uint32>(alignment)) invalidWave();
        }
        else if (name == "data")
        {
            if (dataFound || bytes == 0) invalidWave();
            dataFound = true;
            dataBytes = bytes;
        }
        if (!input.setPosition(paddedEnd)) invalidWave();
    }
    if (!formatFound || !dataFound || alignment == 0 || dataBytes % static_cast<juce::uint32>(alignment) != 0) invalidWave();
    input.setPosition(0);
}

class ExclusiveOutput final : public juce::OutputStream
{
public:
    explicit ExclusiveOutput(const juce::File& file)
    {
#if JUCE_WINDOWS
        handle = _wfopen(file.getFullPathName().toWideCharPointer(), L"wbx");
#else
        handle = std::fopen(file.getFullPathName().toRawUTF8(), "wbx");
#endif
        if (handle == nullptr)
            throw ControlError(errno == EEXIST ? "AUDIO_OUTPUT_EXISTS" : "AUDIO_RENDER_FAILED",
                               errno == EEXIST ? "Output already exists; it was not overwritten." : "Cannot create the native WAV output.");
    }
    ~ExclusiveOutput() override { if (handle != nullptr) std::fclose(handle); }
    void flush() override { if (std::fflush(handle) != 0) failed = true; }
    bool write(const void* data, std::size_t bytes) override
    {
        if (bytes > static_cast<std::size_t>(maxWaveBytes) || getPosition() + static_cast<juce::int64>(bytes) > maxWaveBytes)
        {
            failed = true;
            return false;
        }
        if (std::fwrite(data, 1, bytes, handle) != bytes) failed = true;
        return !failed;
    }
    juce::int64 getPosition() override { return static_cast<juce::int64>(std::ftell(handle)); }
    bool setPosition(juce::int64 position) override
    {
        if (position < 0 || position > maxWaveBytes || std::fseek(handle, static_cast<long>(position), SEEK_SET) != 0) failed = true;
        return !failed;
    }
    bool hasFailed() const { return failed; }
private:
    std::FILE* handle = nullptr;
    bool failed = false;
};
}

DecodedWave readWave(const juce::File& file)
{
    if (!file.existsAsFile()) throw ControlError("AUDIO_INPUT_INVALID", "Input recording is missing or unreadable.");
    const auto bytes = file.getSize();
    if (bytes > maxWaveBytes) throw ControlError("AUDIO_INPUT_TOO_LARGE", "Input WAV exceeds the 32 MiB limit.");
    if (bytes < 44) invalidWave();
    auto input = std::make_unique<juce::FileInputStream>(file);
    if (input->failedToOpen()) invalidWave();
    inspectChunks(*input, bytes);
    juce::WavAudioFormat format;
    std::unique_ptr<juce::AudioFormatReader> reader(format.createReaderFor(input.release(), true));
    if (!reader || reader->numChannels < 1 || reader->numChannels > 2 || !std::isfinite(reader->sampleRate)
        || reader->sampleRate != std::floor(reader->sampleRate) || reader->sampleRate < 8000 || reader->sampleRate > 96000
        || reader->lengthInSamples < 1) invalidWave();
    if (reader->lengthInSamples > reader->sampleRate * 90)
        throw ControlError("AUDIO_INPUT_TOO_LARGE", "Input recording exceeds the 90 second limit.");
    DecodedWave decoded {juce::AudioBuffer<float>(static_cast<int>(reader->numChannels), static_cast<int>(reader->lengthInSamples)), static_cast<int>(reader->sampleRate)};
    if (!reader->read(&decoded.samples, 0, decoded.samples.getNumSamples(), 0, true, true)) invalidWave();
    double peak = 0;
    for (int channel = 0; channel < decoded.samples.getNumChannels(); ++channel)
        for (int frame = 0; frame < decoded.samples.getNumSamples(); ++frame)
        {
            if (!std::isfinite(decoded.samples.getSample(channel, frame)))
                throw ControlError("AUDIO_INPUT_INVALID", "Input recording contains non-finite samples.");
            peak = std::max(peak, std::abs(static_cast<double>(decoded.samples.getSample(channel, frame))));
        }
    if (peak < 1e-7) throw ControlError("AUDIO_INPUT_INVALID", "Input recording is silent; choose an audible guitar DI recording.");
    return decoded;
}

void writeWaveExclusive(const juce::File& output, const juce::AudioBuffer<float>& samples, int sampleRate)
{
    // JUCE writes a small format header plus interleaved PCM16 data. Reserve a
    // bounded header allowance and check the actual finalized file as well.
    const auto estimatedBytes = static_cast<juce::int64>(samples.getNumSamples()) * samples.getNumChannels() * 2 + 4096;
    if (estimatedBytes > maxWaveBytes)
        throw ControlError("AUDIO_OUTPUT_TOO_LARGE", "Rendered PCM16 WAV exceeds the 32 MiB limit.");
    std::unique_ptr<juce::OutputStream> stream = std::make_unique<ExclusiveOutput>(output);
    auto* state = static_cast<ExclusiveOutput*>(stream.get());
    try
    {
        juce::WavAudioFormat format;
        auto writer = format.createWriterFor(stream, juce::AudioFormatWriterOptions{}.withSampleRate(sampleRate)
                                              .withNumChannels(samples.getNumChannels()).withBitsPerSample(16));
        if (!writer || !writer->writeFromAudioSampleBuffer(samples, 0, samples.getNumSamples()))
            throw ControlError("AUDIO_RENDER_FAILED", "Cannot write the native WAV output.");
        writer->flush();
        if (state->hasFailed()) throw ControlError("AUDIO_RENDER_FAILED", "Cannot finalize the native WAV output.");
        writer.reset();
        if (output.getSize() > maxWaveBytes) throw ControlError("AUDIO_OUTPUT_TOO_LARGE", "Rendered WAV exceeds the 32 MiB limit.");
    }
    catch (...)
    {
        stream.reset();
        output.deleteFile(); // This path was created exclusively by this call.
        throw;
    }
}
}
