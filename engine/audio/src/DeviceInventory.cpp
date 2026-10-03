#include "Protocol.h"
#include <juce_audio_devices/juce_audio_devices.h>

namespace toney
{
juce::var enumerateDevices()
{
    // Creating/scanning device types queries names only. Do not initialise the
    // manager, create devices, or open streams: those belong to a later slice.
    juce::AudioDeviceManager manager;
    juce::OwnedArray<juce::AudioIODeviceType> types;
    manager.createAudioDeviceTypes(types);
    juce::Array<juce::var> devices;
    for (auto* type : types)
    {
        type->scanForDevices();
        const auto backend = type->getTypeName();
        for (const bool input : {true, false})
        {
            const auto names = type->getDeviceNames(input);
            const auto defaultIndex = type->getDefaultDeviceIndex(input);
            for (int index = 0; index < names.size(); ++index)
            {
                const juce::String kind = input ? "input" : "output";
                // A deterministic control identifier, not a persistent hardware UID.
                const auto id = backend + ":" + kind + ":" + juce::String(index) + ":" + names[index];
                devices.add(makeObject({{"id", id}, {"name", names[index]}, {"kind", kind},
                                        {"backend", backend}, {"isDefault", index == defaultIndex}}));
            }
        }
    }
    return makeObject({{"kind", "audio-devices"}, {"devices", devices}});
}
}
