#include "Protocol.h"
#include "JsonSyntax.h"
#include <set>

namespace toney
{
static_assert(JUCE_MAJOR_VERSION == 8 && JUCE_MINOR_VERSION == 0 && JUCE_BUILDNUMBER == 14,
              "Toney's native control helper requires pinned JUCE 8.0.14.");
ControlError::ControlError(juce::String errorCode, juce::String errorMessage)
    : std::runtime_error(errorMessage.toStdString()),
      code(std::move(errorCode)), message(std::move(errorMessage)) {}

juce::var makeObject(std::initializer_list<std::pair<juce::Identifier, juce::var>> fields)
{
    auto object = std::make_unique<juce::DynamicObject>();
    for (const auto& field : fields)
        object->setProperty(field.first, field.second);
    return juce::var(object.release());
}

juce::var errorResponse(const juce::String& requestId, const juce::String& code,
                        const juce::String& message)
{
    return makeObject({{"protocolVersion", protocolVersion}, {"requestId", requestId},
                       {"ok", false}, {"error", makeObject({{"code", code}, {"message", message}})}});
}

juce::var handleRequest(const juce::String& json)
{
    juce::String requestId;
    try
    {
        if (json.getNumBytesAsUTF8() > maxRequestBytes)
            throw ControlError("REQUEST_TOO_LARGE", "Request exceeds the 1 MiB limit.");
        juce::var request;
        std::string safeToParse;
        if (!hasValidJsonSyntax(json.toStdString(), safeToParse)
            || juce::JSON::parse(juce::String(safeToParse), request).failed()
            || request.getDynamicObject() == nullptr)
            throw ControlError("INVALID_REQUEST", "Expected a JSON request object.");

        const auto id = request["requestId"];
        if (!id.isString() || id.toString().isEmpty() || id.toString().length() > 128
            || !id.toString().containsOnly("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.:"))
            throw ControlError("INVALID_REQUEST", "requestId must contain 1 to 128 ASCII letters, digits, hyphens, underscores, periods, or colons.");
        requestId = id.toString();

        const auto version = request["protocolVersion"];
        if ((!version.isInt() && !version.isInt64() && !version.isDouble())
            || static_cast<double>(version) != protocolVersion)
            throw ControlError("UNSUPPORTED_PROTOCOL", "Only protocol version 1 is supported.");

        const std::set<juce::String> allowed {"protocolVersion", "requestId", "command", "tone", "render"};
        for (const auto& property : request.getDynamicObject()->getProperties())
            if (allowed.count(property.name.toString()) == 0)
                throw ControlError("INVALID_REQUEST", "Request contains an unknown field.");

        if (!request["command"].isString())
            throw ControlError("INVALID_REQUEST", "command must be a string.");
        const auto command = request["command"].toString();
        if ((command == "get_engine_info" || command == "get_audio_devices")
            && request.getDynamicObject()->hasProperty("tone"))
            throw ControlError("INVALID_REQUEST", "tone is only accepted by tone validation and audio rendering.");
        if (command != "render_audio" && request.getDynamicObject()->hasProperty("render"))
            throw ControlError("INVALID_REQUEST", "render is only accepted by render_audio.");
        juce::var result;
        if (command == "get_engine_info")
            result = makeObject({{"kind", "engine-info"}, {"engineVersion", "0.3.0"},
                                 {"backend", "JUCE"},
                                 {"capabilities", juce::Array<juce::var>{"device-enumeration", "rig-validation", "offline-render"}}});
        else if (command == "get_audio_devices")
            result = enumerateDevices();
        else if (command == "validate_tone_spec")
            result = validateTone(request["tone"]);
        else if (command == "render_audio")
            result = renderAudio(request["tone"], request["render"]);
        else
            throw ControlError("UNKNOWN_COMMAND", "Unsupported engine command.");

        return makeObject({{"protocolVersion", protocolVersion}, {"requestId", requestId},
                           {"ok", true}, {"result", result}});
    }
    catch (const ControlError& error)
    {
        return errorResponse(requestId, error.code, error.message);
    }
    catch (const std::exception&)
    {
        return errorResponse(requestId, "INTERNAL_ERROR", "Native control request failed.");
    }
    catch (...)
    {
        return errorResponse(requestId, "INTERNAL_ERROR", "Native control request failed.");
    }
}
}
