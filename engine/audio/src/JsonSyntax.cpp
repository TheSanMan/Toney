#include "JsonSyntax.h"
#include <juce_core/juce_core.h>
#include <cmath>
#include <iomanip>
#include <locale>
#include <sstream>
#include <string_view>
#include <vector>

namespace toney
{
namespace
{
class SyntaxReader
{
public:
    explicit SyntaxReader(const std::string& input) : input(input) {}

    bool read(std::string& safeToParse)
    {
        if (!value(0)) return false;
        whitespace();
        if (offset != input.size()) return false;
        std::size_t copied = 0;
        for (const auto& replacement : replacements)
        {
            safeToParse.append(input, copied, replacement.start - copied);
            safeToParse += replacement.text;
            copied = replacement.end;
        }
        safeToParse.append(input, copied, input.size() - copied);
        return true;
    }

private:
    const std::string& input;
    std::size_t offset = 0;
    struct Replacement { std::size_t start; std::size_t end; std::string text; };
    std::vector<Replacement> replacements;

    char peek() const { return offset < input.size() ? input[offset] : '\0'; }
    bool take(char character)
    {
        if (peek() != character) return false;
        ++offset;
        return true;
    }

    void whitespace()
    {
        while (peek() == ' ' || peek() == '\t' || peek() == '\r' || peek() == '\n') ++offset;
    }

    bool digit() const { return peek() >= '0' && peek() <= '9'; }

    bool literal(std::string_view token)
    {
        if (input.compare(offset, token.size(), token) != 0) return false;
        offset += token.size();
        return true;
    }

    bool string()
    {
        if (!take('"')) return false;
        while (offset < input.size())
        {
            const auto character = static_cast<unsigned char>(input[offset++]);
            if (character == '"') return true;
            if (character < 0x20) return false;
            if (character != '\\') continue;
            if (offset == input.size()) return false;
            const auto escape = input[offset++];
            if (escape == 'u')
            {
                for (int i = 0; i < 4; ++i)
                {
                    const char hex = peek();
                    if (!((hex >= '0' && hex <= '9') || (hex >= 'a' && hex <= 'f') || (hex >= 'A' && hex <= 'F'))) return false;
                    ++offset;
                }
            }
            else if (escape != '"' && escape != '\\' && escape != '/' && escape != 'b'
                     && escape != 'f' && escape != 'n' && escape != 'r' && escape != 't') return false;
        }
        return false;
    }

    bool number()
    {
        const auto start = offset;
        take('-');
        const auto prefixStart = offset;
        if (!take('0'))
        {
            if (peek() < '1' || peek() > '9') return false;
            while (digit()) ++offset;
        }
        const auto prefixLength = offset - prefixStart;
        if (take('.'))
        {
            if (!digit()) return false;
            while (digit()) ++offset;
        }
        if (take('e') || take('E'))
        {
            if (!take('+')) take('-');
            if (!digit()) return false;
            while (digit()) ++offset;
        }
        // JUCE accumulates integer prefixes in signed int64 before noticing
        // a decimal/exponent. Normalize large prefixes to a scientific double
        // first, preserving JavaScript's numeric semantics without overflow.
        if (prefixLength > 18)
        {
            const auto token = input.substr(start, offset - start);
            const auto parsed = juce::String(token).getDoubleValue();
            std::ostringstream replacement;
            replacement.imbue(std::locale::classic());
            if (std::isfinite(parsed)) replacement << std::scientific << std::setprecision(17) << parsed;
            else replacement << "null"; // No supported field accepts a non-finite value.
            replacements.push_back({start, offset, replacement.str()});
        }
        return true;
    }

    bool container(bool isObject, unsigned depth)
    {
        const char end = isObject ? '}' : ']';
        ++offset;
        whitespace();
        if (take(end)) return true;
        do
        {
            whitespace();
            if (isObject)
            {
                if (!string()) return false;
                whitespace();
                if (!take(':')) return false;
            }
            if (!value(depth + 1)) return false;
            whitespace();
            if (take(end)) return true;
        } while (take(','));
        return false;
    }

    bool value(unsigned depth)
    {
        if (depth > 64) return false;
        whitespace();
        switch (peek())
        {
            case '{': return container(true, depth);
            case '[': return container(false, depth);
            case '"': return string();
            case 't': return literal("true");
            case 'f': return literal("false");
            case 'n': return literal("null");
            default: return number();
        }
    }
};
}

bool hasValidJsonSyntax(const std::string& input, std::string& safeToParse)
{
    safeToParse.clear();
    return SyntaxReader(input).read(safeToParse);
}
}
