#include "Protocol.h"
#include "LiveSession.h"
#include <juce_events/juce_events.h>
#include <iostream>
#include <string>
#include <thread>

namespace
{
bool readLine(std::string& line)
{
    line.clear();
    char character;
    while (std::cin.get(character))
    {
        if (character == '\n') return true;
        if (line.size() == toney::maxRequestBytes)
        {
            std::cout << juce::JSON::toString(toney::errorResponse("", "REQUEST_TOO_LARGE", "Request exceeds the 1 MiB limit."), true).toStdString() << std::endl;
            return false;
        }
        line.push_back(character);
    }
    return !line.empty();
}
}

int main(int argc, char** argv)
{
    if (argc == 2 && std::string(argv[1]) == "--live")
    {
        // CoreAudio device notifications and JUCE timers need a live event loop.
        // Blocking stdin/JSON/model preparation stay on a separate control thread.
        juce::ScopedJuceInitialiser_GUI events;
        std::thread control([] {
            {
                toney::LiveSession session;
                std::string line;
                line.reserve(4096);
                while (readLine(line))
                {
                    const bool valid = line.find('\0') == std::string::npos
                        && juce::CharPointer_UTF8::isValidString(line.data(), static_cast<int>(line.size()));
                    const auto response = valid ? session.handle(juce::String::fromUTF8(line.data(), static_cast<int>(line.size())))
                        : toney::errorResponse("", "INVALID_REQUEST", "Expected a UTF-8 JSON request.");
                    std::cout << juce::JSON::toString(response, true).toStdString() << std::endl;
                }
            } // EOF closes input and joins its callback before stopping events.
            juce::MessageManager::callAsync([] { juce::MessageManager::getInstance()->stopDispatchLoop(); });
        });
        juce::MessageManager::getInstance()->runDispatchLoop();
        control.join();
        return 0;
    }
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
