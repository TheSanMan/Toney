#include "NamModel.h"
#include "Protocol.h"
#include <cmath>
#include <set>

namespace toney
{
namespace
{
using Json = nlohmann::json;
[[noreturn]] void invalid(const char* message) { throw ControlError("ASSET_INVALID", message); }
[[noreturn]] void unsupported(const char* message) { throw ControlError("ASSET_UNSUPPORTED", message); }
void keys(const Json& object, const std::set<std::string>& required, const std::set<std::string>& optional = {})
{
    if (!object.is_object()) invalid("NAM configuration must contain objects with the required fields.");
    for (const auto& entry : object.items())
        if (!required.count(entry.key()) && !optional.count(entry.key()))
            unsupported("NAM contains an unsupported advanced configuration field. Use a classic mono WaveNet A1 or LSTM model.");
    for (const auto& key : required) if (!object.contains(key)) invalid("NAM configuration is missing a required field.");
}
int integer(const Json& value, int min, int max)
{
    if (!value.is_number()) invalid("NAM configuration dimensions must be bounded integers.");
    const auto number = value.get<double>();
    if (!std::isfinite(number) || number != std::floor(number) || number < min || number > max)
        unsupported("NAM network dimensions exceed the supported offline model limits.");
    return static_cast<int>(number);
}
bool boolean(const Json& value)
{
    if (!value.is_boolean()) invalid("NAM gating and bias fields must be booleans.");
    return value.get<bool>();
}
double finite(const Json& value)
{
    if (!value.is_number()) invalid("NAM numeric fields must be finite numbers.");
    const auto number = value.get<double>();
    if (!std::isfinite(number) || std::abs(number) > 1e6) invalid("NAM numeric fields are non-finite or exceed supported magnitude limits.");
    return number;
}

std::size_t lstmWeights(const Json& config)
{
    keys(config, {"input_size", "hidden_size", "num_layers"});
    const auto input = integer(config["input_size"], 1, 1);
    const auto hidden = integer(config["hidden_size"], 1, 128);
    const auto layers = integer(config["num_layers"], 1, 4);
    std::size_t count = hidden + 1;
    for (int layer = 0; layer < layers; ++layer)
        count += static_cast<std::size_t>(4 * hidden) * ((layer == 0 ? input : hidden) + hidden) + 6 * hidden;
    return count;
}

std::size_t wavenetWeights(const Json& config)
{
    keys(config, {"layers", "head", "head_scale"});
    if (!config["head"].is_null()) unsupported("NAM WaveNet output heads are unsupported; export a classic A1 model with a null head.");
    finite(config["head_scale"]);
    const auto& layers = config["layers"];
    if (!layers.is_array() || layers.empty() || layers.size() > 4) unsupported("NAM WaveNet must have one to four layer arrays.");
    std::size_t count = 1, memoryBytes = 0;
    int previousChannels = 1, previousHead = 0, totalLayers = 0;
    for (std::size_t index = 0; index < layers.size(); ++index)
    {
        const auto& layer = layers[index];
        keys(layer, {"input_size", "condition_size", "head_size", "channels", "kernel_size", "dilations", "activation", "gated", "head_bias"});
        const auto input = integer(layer["input_size"], 1, 32);
        const auto condition = integer(layer["condition_size"], 1, 1);
        const auto channels = integer(layer["channels"], 1, 32);
        const auto head = integer(layer["head_size"], 1, 32);
        const auto kernel = integer(layer["kernel_size"], 1, 8);
        if (input != previousChannels || (index > 0 && channels != previousHead) || (index + 1 == layers.size() && head != 1))
            unsupported("NAM WaveNet layer transitions must match and its input/output must be mono.");
        previousChannels = channels; previousHead = head;
        const auto gated = boolean(layer["gated"]), headBias = boolean(layer["head_bias"]);
        static const std::set<std::string> activations {"Tanh", "Hardtanh", "Fasttanh", "ReLU", "LeakyReLU", "Sigmoid"};
        if (!layer["activation"].is_string() || !activations.count(layer["activation"].get<std::string>()))
            unsupported("NAM uses an unsupported activation function.");
        const auto& dilations = layer["dilations"];
        if (!dilations.is_array() || dilations.empty() || dilations.size() > 32) unsupported("NAM WaveNet layer count exceeds supported limits.");
        totalLayers += static_cast<int>(dilations.size());
        if (totalLayers > 32) unsupported("NAM WaveNet supports at most 32 dilated layers.");
        int receptive = 1;
        for (const auto& dilation : dilations) receptive += (kernel - 1) * integer(dilation, 1, 16384);
        if (receptive > 16384) unsupported("NAM WaveNet receptive field exceeds 16384 samples.");
        memoryBytes += static_cast<std::size_t>(channels) * dilations.size() * (65536 + receptive - 1) * sizeof(float);
        if (memoryBytes > 128 * 1024 * 1024) unsupported("NAM WaveNet working memory exceeds the 128 MiB model limit.");
        const auto expanded = channels * (gated ? 2 : 1);
        count += input * channels + channels * head + (headBias ? head : 0);
        count += dilations.size() * (static_cast<std::size_t>(expanded) * channels * kernel + expanded
                                    + condition * expanded + channels * channels + channels);
    }
    return count;
}
}

std::shared_ptr<const NamModelDefinition> readNamModel(const juce::File& file)
{
    try
    {
        std::size_t nodes = 0;
        std::map<int, std::set<std::string>> objectKeys;
        const auto callback = [&](int depth, Json::parse_event_t event, Json& value) {
            if (depth > 64 || ++nodes > 2200000) unsupported("NAM JSON nesting or element count exceeds supported limits.");
            if (event == Json::parse_event_t::object_start) objectKeys[depth + 1].clear();
            if (event == Json::parse_event_t::key && !objectKeys[depth].insert(value.get<std::string>()).second)
                invalid("NAM JSON contains duplicate object fields.");
            if (event == Json::parse_event_t::value && value.is_number_float() && !std::isfinite(value.get<double>()))
                invalid("NAM JSON contains a non-finite numeric value.");
            return true;
        };
        auto document = Json::parse(file.loadFileAsString().toStdString(), callback);
        keys(document, {"version", "architecture", "config", "weights"}, {"metadata", "sample_rate"});
        if (!document["version"].is_string()) invalid("NAM model version is missing or invalid.");
        const auto version = document["version"].get<std::string>();
        if (version != "0.5.0" && version != "0.5.1" && version != "0.5.2" && version != "0.5.3" && version != "0.5.4")
            unsupported("NAM model file version is unsupported. Use a classic mono WaveNet A1 or LSTM .nam file, version 0.5.0–0.5.4.");
        if (!document["architecture"].is_string()) invalid("NAM architecture is missing or invalid.");
        const auto architecture = document["architecture"].get<std::string>();
        std::size_t requiredWeights;
        if (architecture == "LSTM") requiredWeights = lstmWeights(document["config"]);
        else if (architecture == "WaveNet") requiredWeights = wavenetWeights(document["config"]);
        else unsupported("NAM architecture is unsupported. Choose a classic mono WaveNet A1 or LSTM model.");
        const auto& weights = document["weights"];
        if (!weights.is_array() || weights.size() != requiredWeights || weights.size() > 2000000)
            invalid("NAM weight count does not match the network configuration.");
        const auto rate = document.contains("sample_rate") ? finite(document["sample_rate"]) : 48000.0;
        if (rate < 8000 || rate > 96000) unsupported("NAM sample rate must be between 8000 and 96000 Hz.");
        auto definition = std::make_shared<NamModelDefinition>();
        definition->config = document["config"]; definition->architecture = architecture;
        definition->modelVersion = version; definition->sampleRate = rate;
        definition->weights.reserve(requiredWeights);
        for (const auto& weight : weights) definition->weights.push_back(static_cast<float>(finite(weight)));
        return definition;
    }
    catch (const ControlError&) { throw; }
    catch (const std::exception&) { throw ControlError("ASSET_INVALID", "NAM file is not a supported complete JSON model."); }
}
}
