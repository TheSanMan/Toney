#pragma once

#include <juce_core/juce_core.h>
#include <cstddef>
#include <stdexcept>

namespace toney
{
constexpr std::size_t maxRequestBytes = 1024 * 1024;
constexpr int protocolVersion = 1;

class ControlError final : public std::runtime_error
{
public:
    ControlError(juce::String code, juce::String message);
    const juce::String code;
    const juce::String message;
};

// One request is handled on the control thread. This never configures an audio stream.
juce::var handleRequest(const juce::String& json);
juce::var errorResponse(const juce::String& requestId, const juce::String& code,
                        const juce::String& message);
juce::var enumerateDevices();
juce::var validateTone(const juce::var& tone);
juce::var renderAudio(const juce::var& tone, const juce::var& render);
juce::var makeObject(std::initializer_list<std::pair<juce::Identifier, juce::var>> fields);
}
