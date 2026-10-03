#include "Protocol.h"
#include <functional>
#include <iostream>
#include <limits>

namespace
{
int failures = 0;
int checks = 0;

void expect(bool condition, const char* label)
{
    ++checks;
    if (!condition)
    {
        ++failures;
        std::cerr << "FAIL: " << label << '\n';
    }
}

juce::var fixture()
{
    // Cover every current catalog model and non-normalized parameter range.
    return juce::JSON::parse(R"({
      "schemaVersion":1,"id":"test-tone","name":"Control contract fixture","revision":7,
      "chain":[
        {"id":"compressor","type":"compressor","model":"builtin_compressor","enabled":true,"parameters":{"amount":0.2,"attack":0.7}},
        {"id":"drive","type":"drive","model":"builtin_drive","enabled":true,"parameters":{"gain":0.15,"tone":0.5,"level":0.6}},
        {"id":"amp","type":"amp","model":"builtin_amp","enabled":true,"parameters":{"gain":0.25,"bass":0.5,"mid":0.55,"treble":0.5,"master":0.65}},
        {"id":"cab","type":"cab","model":"builtin_cab","enabled":true,"parameters":{"brightness":0.5,"resonance":0.35}},
        {"id":"eq","type":"eq","model":"builtin_eq","enabled":true,"parameters":{"lowDb":-12,"midDb":0,"highDb":12}},
        {"id":"chorus","type":"chorus","model":"builtin_chorus","enabled":false,"parameters":{"rate":5,"depth":0.3,"mix":0}},
        {"id":"delay","type":"delay","model":"builtin_delay","enabled":false,"parameters":{"time":0.05,"feedback":0.8,"mix":0}},
        {"id":"reverb","type":"reverb","model":"builtin_reverb","enabled":true,"parameters":{"decay":5,"mix":0.12}}
      ],"metadata":{"createdAt":"2026-10-02T10:00:00.000Z","updatedAt":"2026-10-02T11:00:00-05:00","source":"manual","traceId":"fixture-trace"}
    })");
}

juce::var request(const juce::String& command, const juce::var& tone = {})
{
    auto result = toney::makeObject({{"protocolVersion", 1}, {"requestId", "test-request"}, {"command", command}});
    if (command == "validate_tone_spec") result.getDynamicObject()->setProperty("tone", tone);
    return result;
}

juce::var run(const juce::var& value)
{
    return toney::handleRequest(juce::JSON::toString(value, true));
}

void rejects(const char* label, const std::function<void(juce::var&)>& mutate)
{
    auto tone = fixture();
    mutate(tone);
    const auto response = run(request("validate_tone_spec", tone));
    expect(!static_cast<bool>(response["ok"]) && response["error"]["code"].toString() == "INVALID_TONE_SPEC", label);
    expect(response["requestId"].toString() == "test-request", "failure preserves correlation ID");
}

juce::var& node(juce::var& tone, int index = 0)
{
    return tone.getDynamicObject()->getProperties().getVarPointer("chain")->getArray()->getReference(index);
}
}

int main()
{
    const auto info = run(request("get_engine_info"));
    expect(static_cast<bool>(info["ok"]), "engine info succeeds");
    expect(info["result"]["backend"].toString() == "JUCE", "native backend disclosed");
    expect(info["result"]["engineVersion"].toString() == "0.4.0", "engine version");
    expect(info["result"]["capabilities"].getArray()->size() == 4, "only implemented capabilities advertised");

    const auto valid = run(request("validate_tone_spec", fixture()));
    expect(static_cast<bool>(valid["ok"]), "full catalog fixture accepted");
    expect(valid["result"]["kind"].toString() == "rig-valid", "discriminated rig result");
    expect(static_cast<int>(valid["result"]["nodeCount"]) == 8, "node count");
    expect(static_cast<int>(valid["result"]["activeNodeCount"]) == 6, "bypass state counted");
    expect(static_cast<int>(valid["result"]["revision"]) == 7, "revision echoed");

    rejects("unsupported schema", [](auto& tone) { tone.getDynamicObject()->setProperty("schemaVersion", 3); });
    rejects("boolean schema rejected", [](auto& tone) { tone.getDynamicObject()->setProperty("schemaVersion", true); });
    rejects("fractional revision", [](auto& tone) { tone.getDynamicObject()->setProperty("revision", 1.5); });
    rejects("unsafe revision", [](auto& tone) { tone.getDynamicObject()->setProperty("revision", 9007199254740992.0); });
    rejects("blank tone ID", [](auto& tone) { tone.getDynamicObject()->setProperty("id", " "); });
    rejects("unknown tone field", [](auto& tone) { tone.getDynamicObject()->setProperty("unexpected", 1); });
    rejects("duplicate node ID", [](auto& tone) { node(tone, 1).getDynamicObject()->setProperty("id", "compressor"); });
    rejects("unsupported effect", [](auto& tone) { node(tone).getDynamicObject()->setProperty("type", "flanger"); });
    rejects("unsupported model", [](auto& tone) { node(tone).getDynamicObject()->setProperty("model", "builtin_drive"); });
    rejects("enabled must be boolean", [](auto& tone) { node(tone).getDynamicObject()->setProperty("enabled", 1); });
    rejects("unknown node field", [](auto& tone) { node(tone).getDynamicObject()->setProperty("unknown", 1); });
    rejects("missing parameter", [](auto& tone) { node(tone)["parameters"].getDynamicObject()->removeProperty("attack"); });
    rejects("unknown parameter", [](auto& tone) { node(tone)["parameters"].getDynamicObject()->setProperty("extra", 0); });
    rejects("out of range parameter", [](auto& tone) { node(tone)["parameters"].getDynamicObject()->setProperty("amount", 1.01); });
    rejects("string parameter", [](auto& tone) { node(tone)["parameters"].getDynamicObject()->setProperty("amount", "0.2"); });
    rejects("boolean parameter", [](auto& tone) { node(tone)["parameters"].getDynamicObject()->setProperty("amount", true); });
    rejects("eq range", [](auto& tone) { node(tone, 4)["parameters"].getDynamicObject()->setProperty("highDb", 12.01); });
    rejects("chorus range", [](auto& tone) { node(tone, 5)["parameters"].getDynamicObject()->setProperty("rate", 0.01); });
    rejects("delay feedback range", [](auto& tone) { node(tone, 6)["parameters"].getDynamicObject()->setProperty("feedback", 0.81); });
    rejects("reverb decay range", [](auto& tone) { node(tone, 7)["parameters"].getDynamicObject()->setProperty("decay", 5.01); });
    rejects("empty chain", [](auto& tone) { tone.getDynamicObject()->setProperty("chain", juce::Array<juce::var>{}); });
    rejects("chain maximum", [](auto& tone) {
        juce::Array<juce::var> chain;
        for (int i = 0; i < 33; ++i) chain.add(node(tone));
        tone.getDynamicObject()->setProperty("chain", chain);
    });
    rejects("timestamp invalid date", [](auto& tone) { tone["metadata"].getDynamicObject()->setProperty("createdAt", "2026-13-02T00:00:00Z"); });
    rejects("timestamp invalid time", [](auto& tone) { tone["metadata"].getDynamicObject()->setProperty("createdAt", "2026-10-02T25:00:00Z"); });
    rejects("empty metadata source", [](auto& tone) { tone["metadata"].getDynamicObject()->setProperty("source", ""); });
    rejects("null trace ID", [](auto& tone) { tone["metadata"].getDynamicObject()->setProperty("traceId", juce::var()); });
    rejects("unknown metadata field", [](auto& tone) { tone["metadata"].getDynamicObject()->setProperty("token", "secret"); });

    // Direct invocation is needed because non-finite values cannot be JSON encoded.
    auto nonfinite = fixture();
    node(nonfinite)["parameters"].getDynamicObject()->setProperty("amount", std::numeric_limits<double>::infinity());
    bool nonfiniteRejected = false;
    try { toney::validateTone(nonfinite); }
    catch (const toney::ControlError& error) { nonfiniteRejected = error.code == "INVALID_TONE_SPEC"; }
    expect(nonfiniteRejected, "nonfinite parameter rejected before DSP");

    expect(toney::handleRequest("not json")["error"]["code"].toString() == "INVALID_REQUEST", "malformed JSON sanitized");
    expect(toney::handleRequest("[]")["error"]["code"].toString() == "INVALID_REQUEST", "array request rejected");
    expect(toney::handleRequest("{} trailing")["error"]["code"].toString() == "INVALID_REQUEST", "trailing input rejected");
    expect(toney::handleRequest("{\"requestId\":'test'}")["error"]["code"].toString() == "INVALID_REQUEST", "JavaScript single quotes rejected");
    expect(toney::handleRequest("{\"requestId\":\"test\",}")["error"]["code"].toString() == "INVALID_REQUEST", "trailing comma rejected");
    expect(toney::handleRequest("{\"protocolVersion\":01}")["error"]["code"].toString() == "INVALID_REQUEST", "leading zero rejected");
    const auto deepJson = juce::String::repeatedString("[", 66) + "0" + juce::String::repeatedString("]", 66);
    expect(toney::handleRequest(deepJson)["error"]["code"].toString() == "INVALID_REQUEST", "deep nesting rejected before JUCE recursion");
    expect(run(request("unknown"))["error"]["code"].toString() == "UNKNOWN_COMMAND", "unknown command rejected");
    auto version = request("get_engine_info");
    version.getDynamicObject()->setProperty("protocolVersion", 2);
    expect(run(version)["error"]["code"].toString() == "UNSUPPORTED_PROTOCOL", "protocol version checked");
    version.getDynamicObject()->setProperty("protocolVersion", true);
    expect(run(version)["error"]["code"].toString() == "UNSUPPORTED_PROTOCOL", "boolean protocol version rejected");
    expect(toney::handleRequest(R"({"protocolVersion":18446744073709551617,"requestId":"safe","command":"get_engine_info"})")["error"]["code"].toString()
           == "UNSUPPORTED_PROTOCOL", "large integer cannot wrap to protocol version one");
    expect(static_cast<bool>(toney::handleRequest(R"({"protocolVersion":1000000000000000000e-18,"requestId":"safe","command":"get_engine_info"})")["ok"]),
           "large mantissa with bounded value accepted");
    auto extra = request("get_engine_info");
    extra.getDynamicObject()->setProperty("extra", true);
    expect(run(extra)["error"]["code"].toString() == "INVALID_REQUEST", "unknown request field rejected");
    auto inappropriateTone = request("get_engine_info");
    inappropriateTone.getDynamicObject()->setProperty("tone", fixture());
    expect(run(inappropriateTone)["error"]["code"].toString() == "INVALID_REQUEST", "info request rejects tone");
    inappropriateTone.getDynamicObject()->setProperty("command", "get_audio_devices");
    expect(run(inappropriateTone)["error"]["code"].toString() == "INVALID_REQUEST", "device request rejects tone before hardware scan");
    auto invalidId = request("get_engine_info");
    for (const auto& id : {juce::String(""), juce::String("has space"), juce::String("injection\n"), juce::String::repeatedString("x", 129)})
    {
        invalidId.getDynamicObject()->setProperty("requestId", id);
        expect(run(invalidId)["error"]["code"].toString() == "INVALID_REQUEST", "invalid correlation ID rejected");
    }
    const juce::String tooLarge = juce::String::repeatedString("x", static_cast<int>(toney::maxRequestBytes + 1));
    expect(toney::handleRequest(tooLarge)["error"]["code"].toString() == "REQUEST_TOO_LARGE", "request size bounded");

    std::cout << checks << " native contract checks; " << failures << " failed.\n";
    return failures == 0 ? 0 : 1;
}
