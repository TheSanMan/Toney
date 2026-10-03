#include "Protocol.h"
#include <cmath>
#include <map>
#include <regex>
#include <set>
#include <vector>

namespace toney
{
namespace
{
using Range = std::pair<double, double>;
using Parameters = std::map<juce::String, Range>;
struct Definition { juce::String model; Parameters parameters; };

// These ranges and models are the native counterpart of core/tone/catalog.ts.
const std::map<juce::String, Definition> catalog {
    {"compressor", {"builtin_compressor", {{"amount", {0, 1}}, {"attack", {0, 1}}}}},
    {"drive", {"builtin_drive", {{"gain", {0, 1}}, {"tone", {0, 1}}, {"level", {0, 1}}}}},
    {"amp", {"builtin_amp", {{"gain", {0, 1}}, {"bass", {0, 1}}, {"mid", {0, 1}}, {"treble", {0, 1}}, {"master", {0, 1}}}}},
    {"cab", {"builtin_cab", {{"brightness", {0, 1}}, {"resonance", {0, 1}}}}},
    {"eq", {"builtin_eq", {{"lowDb", {-12, 12}}, {"midDb", {-12, 12}}, {"highDb", {-12, 12}}}}},
    {"chorus", {"builtin_chorus", {{"rate", {0.1, 5}}, {"depth", {0, 1}}, {"mix", {0, 1}}}}},
    {"delay", {"builtin_delay", {{"time", {0.05, 1}}, {"feedback", {0, 0.8}}, {"mix", {0, 1}}}}},
    {"reverb", {"builtin_reverb", {{"decay", {0.2, 5}}, {"mix", {0, 1}}}}},
};

[[noreturn]] void invalid(const juce::String& path, const juce::String& reason)
{
    throw ControlError("INVALID_TONE_SPEC", path + ": " + reason);
}

void object(const juce::var& value, const juce::String& path)
{
    if (value.getDynamicObject() == nullptr)
        invalid(path, "expected an object");
}

void keys(const juce::var& value, const std::set<juce::String>& required,
          const juce::String& path, const std::set<juce::String>& optional = {})
{
    object(value, path);
    const auto& fields = value.getDynamicObject()->getProperties();
    for (const auto& property : fields)
        if (required.count(property.name.toString()) == 0 && optional.count(property.name.toString()) == 0)
            invalid(path, "unknown field"); // Do not reflect arbitrary input keys into diagnostics.
    for (const auto& key : required)
        if (!fields.contains(juce::Identifier(key)))
            invalid(path + "." + key, "required field missing");
}

juce::String text(const juce::var& value, const juce::String& path)
{
    if (!value.isString())
        invalid(path, "expected a nonempty string of at most 500 characters");
    const auto result = value.toString();
    // JavaScript counts UTF-16 code units; match it for supplementary characters.
    auto pointer = result.toUTF16();
    int units = 0;
    while (*pointer.getAddress() != 0)
    {
        ++units;
        pointer = juce::CharPointer_UTF16(pointer.getAddress() + 1);
    }
    if (result.trim().isEmpty() || units > 500)
        invalid(path, "expected a nonempty string of at most 500 characters");
    return result;
}

double number(const juce::var& value, const juce::String& path, double min, double max)
{
    if (!value.isInt() && !value.isInt64() && !value.isDouble())
        invalid(path, "expected a finite number in the supported range");
    const auto result = static_cast<double>(value);
    if (!std::isfinite(result) || result < min || result > max)
        invalid(path, "expected a finite number in the supported range");
    return result;
}

void timestamp(const juce::var& value, const juce::String& path)
{
    const auto string = text(value, path).toStdString();
    // The existing schema requires a four-digit ISO date with a time. Accept
    // seconds/fractions, an optional timezone, and the ISO end-of-day 24:00 form.
    static const std::regex iso(
        R"(^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?(?:Z|([+-])([0-9]{2}):?([0-9]{2}))?$)");
    std::smatch matches;
    if (!std::regex_match(string, matches, iso))
        invalid(path, "expected an ISO timestamp");
    const auto integer = [&matches](int index) { return matches[index].matched ? std::stoi(matches[index].str()) : 0; };
    const auto month = integer(2), day = integer(3), hour = integer(4), minute = integer(5), second = integer(6);
    const auto fractionNonzero = matches[7].matched && matches[7].str().find_first_not_of('0') != std::string::npos;
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 24 || minute > 59 || second > 59
        || (hour == 24 && (minute != 0 || second != 0 || fractionNonzero))
        || integer(9) > 23 || integer(10) > 59)
        invalid(path, "expected an ISO timestamp");
}
}

juce::var validateTone(const juce::var& tone)
{
    keys(tone, {"schemaVersion", "id", "name", "revision", "chain", "metadata"}, "tone");
    const auto schema = number(tone["schemaVersion"], "tone.schemaVersion", 1, 2);
    if (schema != 1 && schema != 2) invalid("tone.schemaVersion", "only schema versions 1 and 2 are supported");
    const auto toneId = text(tone["id"], "tone.id");
    text(tone["name"], "tone.name");
    const auto revision = number(tone["revision"], "tone.revision", 0, 9007199254740991.0);
    if (std::floor(revision) != revision)
        invalid("tone.revision", "expected an integer");

    const auto* chain = tone["chain"].getArray();
    if (chain == nullptr || chain->size() < 1 || chain->size() > 32)
        invalid("tone.chain", "expected between 1 and 32 nodes");
    std::set<juce::String> ids;
    int activeNodes = 0;
    for (int index = 0; index < chain->size(); ++index)
    {
        const auto& node = (*chain)[index];
        const auto path = "tone.chain[" + juce::String(index) + "]";
        keys(node, {"id", "type", "model", "enabled", "parameters"}, path, schema == 2 ? std::set<juce::String>{"asset"} : std::set<juce::String>{});
        if (!ids.insert(text(node["id"], path + ".id")).second)
            invalid(path + ".id", "duplicate node ID");
        const auto type = text(node["type"], path + ".type");
        const auto found = catalog.find(type);
        if (found == catalog.end())
            invalid(path + ".type", "unsupported effect type");
        const auto& definition = found->second;
        const auto model = node["model"].toString();
        const bool ir = schema == 2 && type == "cab" && model == "cab_ir";
        const bool nam = schema == 2 && type == "amp" && model == "nam";
        if (!node["model"].isString() || (model != definition.model && !ir && !nam))
            invalid(path + ".model", "unsupported model for effect type");
        if (ir || nam)
        {
            const auto asset = node["asset"];
            keys(asset, {"id", "kind", "name"}, path + ".asset");
            const auto id = text(asset["id"], path + ".asset.id");
            if (id.length() != 64 || !id.containsOnly("0123456789abcdef")) invalid(path + ".asset.id", "expected a lowercase SHA-256 identifier");
            if (!asset["kind"].isString() || asset["kind"].toString() != (ir ? "ir" : "nam")) invalid(path + ".asset.kind", "asset kind does not match the model");
            text(asset["name"], path + ".asset.name");
        }
        else if (node.getDynamicObject()->hasProperty("asset")) invalid(path + ".asset", "builtin models forbid assets");
        if (!node["enabled"].isBool())
            invalid(path + ".enabled", "expected a boolean");
        if (static_cast<bool>(node["enabled"]))
            ++activeNodes;

        std::set<juce::String> parameterNames;
        for (const auto& parameter : definition.parameters)
            parameterNames.insert(parameter.first);
        const auto parameters = node["parameters"];
        keys(parameters, parameterNames, path + ".parameters");
        for (const auto& parameter : definition.parameters)
            number(parameters[juce::Identifier(parameter.first)], path + ".parameters." + parameter.first,
                   parameter.second.first, parameter.second.second);
    }

    const auto metadata = tone["metadata"];
    keys(metadata, {"createdAt", "updatedAt", "source"}, "tone.metadata", {"traceId"});
    timestamp(metadata["createdAt"], "tone.metadata.createdAt");
    timestamp(metadata["updatedAt"], "tone.metadata.updatedAt");
    text(metadata["source"], "tone.metadata.source");
    if (metadata.getDynamicObject()->hasProperty("traceId"))
        text(metadata["traceId"], "tone.metadata.traceId");

    return makeObject({{"kind", "rig-valid"}, {"toneId", toneId},
                       {"revision", static_cast<juce::int64>(revision)},
                       {"nodeCount", chain->size()}, {"activeNodeCount", activeNodes}});
}
}
