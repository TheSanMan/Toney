#pragma once
#include <string>

namespace toney
{
// JUCE's JSON reader also accepts some JavaScript syntax and ignores trailing
// text. Validate the wire grammar and bound nesting before handing it to JUCE.
bool hasValidJsonSyntax(const std::string& input, std::string& safeToParse);
}
