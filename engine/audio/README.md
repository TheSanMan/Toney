# Native engine control helper

This checkpoint adds a JUCE 8.0.14 C++17 helper for real device enumeration and independent ToneSpec validation. It does not process audio or apply a rig. Device queries scan names/defaults without opening input or output streams.

## Build and test

Use CMake 3.22+ and a C++ compiler with the platform SDK installed:

```sh
cmake -S engine/audio -B engine/audio/build -G Ninja -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=ON
cmake --build engine/audio/build
ctest --test-dir engine/audio/build --output-on-failure
```

CMake fetches the official JUCE tag `8.0.14` into the ignored build directory. For an existing checkout of that version, add `-DJUCE_PATH=/absolute/path/to/JUCE`. The executable is `engine/audio/build/bin/toney-engine`. JUCE is dual licensed; see the upstream license in its checkout and resolve distribution terms before shipping.

On the tested macOS Command Line Tools installation, AppleClang's default C++ header directory was incomplete. If the compiler reports `algorithm file not found` while those headers are present inside the SDK, this local environment workaround applies to both the helper and JUCE's build tools:

```sh
TONEY_SDK_PATH="$(xcrun --show-sdk-path)"
CPLUS_INCLUDE_PATH="$TONEY_SDK_PATH/usr/include/c++/v1" npm run native:build
```

For reuse of an existing verified JUCE source checkout:

```sh
TONEY_SDK_PATH="$(xcrun --show-sdk-path)"
CPLUS_INCLUDE_PATH="$TONEY_SDK_PATH/usr/include/c++/v1" JUCE_PATH=/absolute/path/to/JUCE npm run native:build
```

## Protocol version 1

The helper reads one UTF-8 JSON line (at most 1 MiB and 64 levels of nesting) from stdin, writes exactly one compact JSON response line to stdout, and exits. `requestId` contains 1–128 ASCII letters, digits, hyphens, underscores, periods, or colons. Empty/malformed requests receive a structured error; an invalid request without a usable ID has `requestId: ""`. Error messages are sanitized and never contain raw parser output. The desktop caller owns process timeouts and records the correlation ID in diagnostics. `tone` is accepted only for `validate_tone_spec`.

```json
{"protocolVersion":1,"requestId":"inspect-001","command":"get_engine_info"}
```

```json
{"protocolVersion":1,"requestId":"inspect-001","ok":true,"result":{"kind":"engine-info","engineVersion":"0.2.0","backend":"JUCE","capabilities":["device-enumeration","rig-validation"]}}
```

Commands:

- `get_engine_info` reports implemented capabilities.
- `get_audio_devices` returns `{kind:"audio-devices", devices:[{id,name,kind,backend,isDefault}]}`. `kind` is `input` or `output`. IDs identify this enumeration result; they are not persistent hardware identifiers. Empty inventories are legitimate. No sample rates, buffer sizes, latency measurements, or routing state are invented.
- `validate_tone_spec` requires a `tone` following `core/tone/types.ts`. It returns `{kind:"rig-valid",toneId,revision,nodeCount,activeNodeCount}`. This confirms schema/catalog validity only, not renderability by an implemented native DSP chain.

Failures use `{protocolVersion:1,requestId,ok:false,error:{code,message}}`. Stable codes include `INVALID_REQUEST`, `UNSUPPORTED_PROTOCOL`, `UNKNOWN_COMMAND`, `INVALID_TONE_SPEC`, `REQUEST_TOO_LARGE`, and `INTERNAL_ERROR`.

The native validator checks all current effect types/model IDs, complete parameter sets and ranges, node IDs, bypass booleans, schema/revision limits, metadata, and unexpected fields. Keep its catalog synchronized with `core/tone/catalog.ts`; the hardware-independent CTest covers every effect and malformed requests. The application integration should also send a freshly compiled ToneSpec to catch contract drift across the two runtimes.
