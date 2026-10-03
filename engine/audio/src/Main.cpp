#include "Protocol.h"
#include <iostream>
#include <string>

int main(int argc, char**)
{
    if (argc != 1)
    {
        std::cerr << "toney-engine accepts one JSON line on stdin. Run CTest for contract tests.\n";
        return 2;
    }

    // Bound allocation before parsing, including malformed input. One process
    // handles exactly one request so desktop IPC has an unambiguous lifecycle.
    std::string line;
    line.reserve(4096);
    char character;
    while (std::cin.get(character) && character != '\n')
    {
        if (line.size() == toney::maxRequestBytes)
        {
            const auto response = toney::errorResponse("", "REQUEST_TOO_LARGE", "Request exceeds the 1 MiB limit.");
            std::cout << juce::JSON::toString(response, true).toStdString() << '\n';
            return 0;
        }
        line.push_back(character);
    }
    const bool validEncoding = line.find('\0') == std::string::npos
        && juce::CharPointer_UTF8::isValidString(line.data(), static_cast<int>(line.size()));
    const auto response = validEncoding
        ? toney::handleRequest(juce::String::fromUTF8(line.data(), static_cast<int>(line.size())))
        : toney::errorResponse("", "INVALID_REQUEST", "Expected a UTF-8 JSON request.");
    std::cout << juce::JSON::toString(response, true).toStdString() << '\n';
    return 0;
}
