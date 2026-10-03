# Native engine control helper

## Asset schema and cabinet IRs

Schema 1 retains built-in rigs. Schema 2 adds optional node `asset:{id,kind,name}` references, where `id` is the lowercase SHA-256 of the file bytes. `cab_ir` on a cabinet requires `kind:"ir"`; `nam` on an amp requires `kind:"nam"`. Built-in models forbid asset fields. Bypassed asset nodes need no staged file; every enabled reference must resolve to a supplied, hash-verified file. Missing or corrupt assets fail without a substitute sound.

`inspect_asset` accepts an internal `asset:{id,kind,path}` and reports `{kind:"asset-info",id,assetKind,sampleRate,channels,frames}` for an IR. `render_audio` accepts optional `render.assets:[{id,kind,path}]`; these absolute paths are supplied by the Rust asset library, never by frontend requests. Duplicate, unreferenced, mismatched, missing, and corrupt entries are rejected.

IR inputs must be audible finite mono/stereo WAV, 8000–96000 Hz, at most two seconds and 8 MiB. Rendering uses actual zero-latency JUCE convolution without trimming or loudness normalization. Centered windowed-sinc conversion aligns an IR to the recording sample rate; kernel-density gain compensation preserves convolution gain across sample rates. A mono IR processes both source channels independently. A stereo IR uses corresponding source channels; for a mono recording its two kernels are averaged, preserving the recording's channel count. Cabinet brightness and resonance remain external tone filters. The IR's frame duration contributes to the capped render tail.

Asset errors use `ASSET_INVALID`, `ASSET_UNSUPPORTED`, `ASSET_MISSING`, and `ASSET_CORRUPT` with actionable sanitized messages.

The JUCE 8.0.14 C++17 helper provides real device enumeration, independent ToneSpec validation, and deterministic offline WAV rendering through all eight built-in effects. Device queries scan names/defaults without opening input or output streams. Rendering processes a file without audio hardware; these approximate effects do not implement NAM models, measured cabinet IRs, or realtime guitar input.

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

The helper reads one UTF-8 JSON line (at most 1 MiB and 64 levels of nesting) from stdin, writes exactly one compact JSON response line to stdout, and exits. `requestId` contains 1–128 ASCII letters, digits, hyphens, underscores, periods, or colons. Empty/malformed requests receive a structured error; an invalid request without a usable ID has `requestId: ""`. Error messages are sanitized and never contain raw parser output. The desktop caller owns process timeouts and records the correlation ID in diagnostics. `tone` is accepted only for `validate_tone_spec` and `render_audio`; `render` is accepted only for `render_audio`.

```json
{"protocolVersion":1,"requestId":"inspect-001","command":"get_engine_info"}
```

```json
{"protocolVersion":1,"requestId":"inspect-001","ok":true,"result":{"kind":"engine-info","engineVersion":"0.3.0","backend":"JUCE","capabilities":["device-enumeration","rig-validation","offline-render"]}}
```

Commands:

- `get_engine_info` reports implemented capabilities.
- `get_audio_devices` returns `{kind:"audio-devices", devices:[{id,name,kind,backend,isDefault}]}`. `kind` is `input` or `output`. IDs identify this enumeration result; they are not persistent hardware identifiers. Empty inventories are legitimate. No sample rates, buffer sizes, latency measurements, or routing state are invented.
- `validate_tone_spec` requires a `tone` following `core/tone/types.ts`. It returns `{kind:"rig-valid",toneId,revision,nodeCount,activeNodeCount}`. This confirms schema/catalog validity without rendering audio.
- `render_audio` requires a valid `tone` and exactly `render:{inputPath,outputPath}`. Both paths are absolute paths created by the Rust bridge inside an isolated temporary directory; the frontend cannot inject paths. It returns `{kind:"audio-render",toneId,revision,sampleRate,channels,inputFrames,outputFrames,peak,attenuationDb,engineVersion:"0.3.0"}`. The bridge owns cleanup and sends the resulting bytes to the frontend.

Failures use `{protocolVersion:1,requestId,ok:false,error:{code,message}}`. Stable codes include `INVALID_REQUEST`, `UNSUPPORTED_PROTOCOL`, `UNKNOWN_COMMAND`, `INVALID_TONE_SPEC`, `REQUEST_TOO_LARGE`, and `INTERNAL_ERROR`.

The native validator checks all current effect types/model IDs, complete parameter sets and ranges, node IDs, bypass booleans, schema/revision limits, metadata, and unexpected fields. Keep its catalog synchronized with `core/tone/catalog.ts`; the hardware-independent CTests cover every effect, every knob, WAV I/O, bypass identity, deterministic rendering, headroom, tails, and malformed requests. Application integration tests also exercise the actual helper to detect drift across runtimes.

## Offline DSP and file limits

Input is RIFF/WAVE PCM (8/16/24/32-bit) or IEEE float32, mono or stereo, at an integer sample rate from 8000 through 96000 Hz. RIFF chunks and declared payload sizes are checked before decoding; truncated files, unsupported encodings, silent recordings, and non-finite samples are rejected. Input limits are 90 seconds and 32 MiB. Rendering preserves the sample rate and channel count. Output is PCM16 WAV, bounded at 32 MiB, created exclusively so an existing destination is never overwritten. Processing/writing failures remove partial output created by that request.

The chain uses a linked envelope compressor, nonlinear drive and amp with tone filters, a filtered cabinet approximation, three-band EQ, modulated delay chorus, filtered feedback delay, and a four-comb/two-allpass Schroeder room. Every catalog parameter controls its processor. No random seed, clock, hardware, or inference participates in rendering.

`inputFrames` records the exact decoded source length. `outputFrames` includes the source plus a calculated tail (up to 12 seconds total). Fully bypassed chains retain the source frame count and signal, allowing PCM16 quantization and necessary headroom attenuation. Long feedback tails are truncated at the cap. Silent wet mixes add no time-effect tail. Channels receive the same processor settings; a linked compressor envelope and shared final headroom gain preserve stereo balance.

Final peak control only attenuates to a ceiling of 0.85; it never increases a quiet signal. `attenuationDb` is the signed applied gain in dB (zero or negative). `peak` is the post-attenuation float peak; PCM16 output differs by at most quantization tolerance. Native render failures use `INVALID_RENDER_REQUEST`, `AUDIO_INPUT_INVALID`, `AUDIO_INPUT_TOO_LARGE`, `AUDIO_OUTPUT_TOO_LARGE`, `AUDIO_OUTPUT_EXISTS`, or `AUDIO_RENDER_FAILED` with sanitized messages.
