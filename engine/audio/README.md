# Native engine control helper

The JUCE 8.0.14 C++17 helper provides device enumeration, independent ToneSpec validation, offline WAV rendering, cabinet IR convolution, NAM neural inference and explicit live guitar monitoring. Device queries scan names/defaults without opening streams; offline rendering needs no hardware. Only the private persistent `--live` session can open input/output.

## Live monitoring

`--live` runs a JUCE event loop plus a serialized control thread. Correlated protocol-v1 newline requests use `start_live`, `update_live`, `get_live_status`, and `stop_live`. Start supplies `tone` and `live:{inputDeviceId,outputDeviceId,inputChannel,sampleRate,bufferSize,inputGainDb,outputGainDb,assets}`; Update supplies tone and only trims/assets. Status/Stop accept no rig/config fields. Replies use `result.kind:"live-status"` and report playing revision, selected devices, actual device rate/buffer, meters, callback load, deadline overruns and estimated latency. Rust privately supplies asset paths and owns child lifetime; EOF closes input.

The selected mono input passes a prepared persistent graph and feeds the first two outputs. Block sizes up to 512 are processed directly; larger backend callbacks are split using fixed scratch arrays. Preparation/asset loading and destruction stay off the callback. A 20 ms startup ramp/crossfade handles graph publication; the control thread retains the prior graph until the callback acknowledges the transition. Failed validation leaves the current graph running. Apply restarts effect tails. Output is capped at ±0.85; nonfinite processing latches silence and a fault. Device stop/rate/buffer changes mute and require restarting. The control status poll closes faulted devices.

All enabled NAM captures must match the device rate; there is no live resampler in this slice. Up to five neural nodes and one IR bound live graph resources. Each stage supports an optional 0–1 wet/dry `mix` (omitted means fully processed). NAM inference and live IR convolution add zero algorithmic block delay; modulation and impulse response timing remain part of the effect. Selecting a new amp/pedal capture or cabinet IR uses neutral surrounding trims and EQ. Clean builtin amp gain is linear at zero; live output has a continuous soft overload knee instead of flat hard clipping. New rigs start with dry space controls. CPU load is measured callback duration / buffer duration, smoothed over callbacks; deadline overruns count this callback's elapsed deadlines, not all driver/device XRuns. Latency is the device's input/output reports plus one buffer and DSP latency, not a physical round-trip measurement.

NAM remains pinned to the official source revision. `cmake/NamRealtime.cmake` makes a build-local copy with exact-match allocation repairs: LSTM hidden states use views, LSTM matmul writes into prepared storage, and gated WaveNet's 1×1 input accepts a strided view. The upstream checkout is untouched. Tests retain the independent scalar LSTM oracle and sequential offline comparisons, and audit real macOS allocator calls on the processing thread. Official fixtures plus generated multilayer LSTM/gated WaveNet fixtures cover persistent state and allocation behavior. Synthetic fixtures establish implementation behavior, not subjective gear quality or hardware performance.

## Asset schema and cabinet IRs

Schema 1 retains built-in rigs. Schema 2 adds optional node `asset:{id,kind,name}` references, where `id` is the lowercase SHA-256 of the file bytes. `cab_ir` on a cabinet requires `kind:"ir"`; `nam` on an amp or drive requires `kind:"nam"`. Built-in models forbid asset fields. Bypassed asset nodes need no staged file; every enabled reference must resolve to a supplied, hash-verified file. Missing or corrupt assets fail without a substitute sound.

`inspect_asset` accepts an internal `asset:{id,kind,path}` and reports `{kind:"asset-info",id,assetKind,sampleRate,channels,frames}` for an IR. `render_audio` accepts optional `render.assets:[{id,kind,path}]`; these absolute paths are supplied by the Rust asset library, never by frontend requests. Duplicate, unreferenced, mismatched, missing, and corrupt entries are rejected.

IR inputs must be audible finite mono/stereo WAV, 8000–96000 Hz, at most two seconds and 8 MiB. Rendering uses actual zero-latency JUCE convolution without trimming or loudness normalization. Centered windowed-sinc conversion aligns an IR to the recording sample rate; kernel-density gain compensation preserves convolution gain across sample rates. A mono IR processes both source channels independently. A stereo IR uses corresponding source channels; for a mono recording its two kernels are averaged, preserving the recording's channel count. Cabinet brightness and resonance remain external tone filters. The IR's frame duration contributes to the capped render tail.

Asset errors use `ASSET_INVALID`, `ASSET_UNSUPPORTED`, `ASSET_MISSING`, and `ASSET_CORRUPT` with actionable sanitized messages.

## Neural amp models

The native helper compiles actual official NeuralAmpModelerCore v0.3.0 inference, pinned at `e5cc355746866bed85cd48ab3e92513dc8cf7a8b`. Eigen is pinned to its official submodule `87300c93cae6a8afd9a4f8aa8d9d5c5324cf02e1`; nlohmann/json 3.12.0 is the single header included in that NAM commit. CMake fetches them into the ignored build directory. For an existing checkout, use `NAM_PATH=/absolute/path/to/NeuralAmpModelerCore`; it must be at that commit with `git submodule update --init Dependencies/eigen` completed. The build verifies both Git revisions and enables `EIGEN_MPL2_ONLY`. Upstream source trees and generated bundles are not committed. See `THIRD_PARTY_NOTICES.md` for license notices.

Supported `.nam` file versions are exactly **0.5.0 through 0.5.4**, with classic mono **WaveNet A1** or **LSTM** architectures. Newer A2, conditioned, multi-IO, output-head, slimmable, and other configurations fail with a clear unsupported-model error. There is no substitute saturation curve when a model cannot load. These limits describe Toney's current integration, not the full range of upstream NAM models.

Models must be at most 32 MiB, contain finite numeric weights/configuration, and provide the exact weight count implied by their dimensions. Preflight occurs before the upstream constructors iterate weights. JSON nesting is capped at 64 levels and parse events at 2.2 million; weight and executable configuration magnitudes are bounded at one million, with at most two million weights. WaveNet supports 1–4 arrays, up to 32 channels/32 total dilated layers, kernels 1–8, receptive fields up to 16384 samples, and calculated working buffers up to 128 MiB. It checks matching array transitions, mono input/output, recognized activations, and boolean gating/bias fields. LSTM supports mono input, 1–4 layers, and hidden sizes 1–128. Unknown advanced configuration fields, duplicate JSON fields, and unsafe counts are rejected. Inspection initializes and prewarms the model and checks finite output before the Rust library installs it.

NAM `inspect_asset` returns `{kind:"asset-info",id,assetKind:"nam",sampleRate,channels:1,architecture,modelVersion}`. Its finite model sample rate may be fractional in the range 8000–96000 Hz. A missing `sample_rate` uses the explicit 48000 Hz assumption. The recording is converted to model rate with centered windowed-sinc interpolation, processed by the official network, and converted back with the exact recording channel/frame count preserved. A fresh model instance is reset and officially prewarmed for each source channel and render; stereo channels use independent network state. Model metadata does not silently normalize loudness.

The amp's `gain` and `master` knobs are respectively input and output trims from -12 to +12 dB via `(value - 0.5) * 24`. Bass/mid/treble remain external EQ after network inference. A drive node can run a separate NAM pedal before the amp: its `gain` and `level` apply the same input/output trim range, and `tone` applies an external 2500 Hz high shelf from -6 to +6 dB via `(value - 0.5) * 12`. At 0.5 the shelf is neutral. These controls do not change the physical knob settings inside a captured model. First switching a builtin drive to NAM sets all three controls to 0.5; switching between NAM captures retains current controls. Amp selection behavior is unchanged.

Pedal and amp network instances are independent even when they share the same hash-addressed asset. Each block and source channel starts with fresh model state; bypassing the pedal omits only its stage and file requirement. Final shared attenuation-only headroom still applies. Inference is offline; no realtime latency claim is made. Pedal captures use the same supported classic NAM formats; modulation, delay, reverb, A2 and parametric captures remain outside this integration.

CTest loads the official `example_models/wavenet.nam` (131 weights) and `example_models/lstm.nam` (70 weights) from the pinned source checkout. These MIT engineering fixtures are not bundled production amp or pedal captures. Tests compare native processing against direct official factory inference, independently check the LSTM scalar equations, verify repeated state resets and sample-rate conversion, and exercise invalid weights/configurations before unsafe construction. Pedal tests compare a stereo pedal/amp chain against two fresh sequential network calls, verify signed trim gains and audible post-EQ changes, and exercise actual-helper pedal/amp/IR rendering, bypass and missing-file failures.

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
CPLUS_INCLUDE_PATH="$TONEY_SDK_PATH/usr/include/c++/v1" JUCE_PATH=/absolute/path/to/JUCE NAM_PATH=/absolute/path/to/NeuralAmpModelerCore npm run native:build
```

## Protocol version 1

The helper reads one UTF-8 JSON line (at most 1 MiB and 64 levels of nesting) from stdin, writes exactly one compact JSON response line to stdout, and exits. `requestId` contains 1–128 ASCII letters, digits, hyphens, underscores, periods, or colons. Empty/malformed requests receive a structured error; an invalid request without a usable ID has `requestId: ""`. Error messages are sanitized and never contain raw parser output. The desktop caller owns process timeouts and records the correlation ID in diagnostics. `tone` is accepted only for `validate_tone_spec` and `render_audio`; `render` is accepted only for `render_audio`.

```json
{"protocolVersion":1,"requestId":"inspect-001","command":"get_engine_info"}
```

```json
{"protocolVersion":1,"requestId":"inspect-001","ok":true,"result":{"kind":"engine-info","engineVersion":"0.6.0","backend":"JUCE","capabilities":["device-enumeration","rig-validation","offline-render","cabinet-ir","neural-amp","live-guitar"]}}
```

Commands:

- `get_engine_info` reports engine version 0.6.0 and implemented capabilities.
- `inspect_asset` validates a hash-addressed internal asset descriptor and reports its measured IR format or supported NAM architecture/model rate before library installation.
- `get_audio_devices` returns `{kind:"audio-devices", devices:[{id,name,kind,backend,isDefault}]}`. `kind` is `input` or `output`. IDs identify this enumeration result; they are not persistent hardware identifiers. Empty inventories are legitimate. No sample rates, buffer sizes, latency measurements, or routing state are invented.
- `validate_tone_spec` requires a `tone` following `core/tone/types.ts`. It returns `{kind:"rig-valid",toneId,revision,nodeCount,activeNodeCount}`. This confirms schema/catalog validity without rendering audio.
- `render_audio` requires a valid `tone` and `render:{inputPath,outputPath,assets?}`. Both paths are absolute paths created by the Rust bridge inside an isolated temporary directory; the frontend cannot inject paths. Optional `assets` contains the library-resolved `{id,kind,path}` descriptors for enabled asset nodes. It returns `{kind:"audio-render",toneId,revision,sampleRate,channels,inputFrames,outputFrames,peak,attenuationDb,engineVersion:"0.5.0"}`. The bridge owns cleanup and sends the resulting bytes to the frontend.

Failures use `{protocolVersion:1,requestId,ok:false,error:{code,message}}`. Stable codes include `INVALID_REQUEST`, `UNSUPPORTED_PROTOCOL`, `UNKNOWN_COMMAND`, `INVALID_TONE_SPEC`, `REQUEST_TOO_LARGE`, and `INTERNAL_ERROR`.

The native validator checks all current effect types/model IDs, complete parameter sets and ranges, node IDs, bypass booleans, schema/revision limits, metadata, and unexpected fields. Keep its catalog synchronized with `core/tone/catalog.ts`; the hardware-independent CTests cover every effect, every knob, WAV I/O, bypass identity, deterministic rendering, headroom, tails, and malformed requests. Application integration tests also exercise the actual helper to detect drift across runtimes.

## Offline DSP and file limits

Input is RIFF/WAVE PCM (8/16/24/32-bit) or IEEE float32, mono or stereo, at an integer sample rate from 8000 through 96000 Hz. RIFF chunks and declared payload sizes are checked before decoding; truncated files, unsupported encodings, silent recordings, and non-finite samples are rejected. Input limits are 90 seconds and 32 MiB. Rendering preserves the sample rate and channel count. Output is PCM16 WAV, bounded at 32 MiB, created exclusively so an existing destination is never overwritten. Processing/writing failures remove partial output created by that request.

The chain uses a linked envelope compressor, nonlinear drive and amp with tone filters, a filtered cabinet approximation, three-band EQ, modulated delay chorus, filtered feedback delay, and a four-comb/two-allpass Schroeder room. Every catalog parameter controls its processor. Imported cabinet nodes use real convolution and imported amp nodes use official NAM inference as described above. Rendering is deterministic and independent of random seeds, clocks, audio hardware, and agent inference.

`inputFrames` records the exact decoded source length. `outputFrames` includes the source plus a calculated tail (up to 12 seconds total). Fully bypassed chains retain the source frame count and signal, allowing PCM16 quantization and necessary headroom attenuation. Long feedback tails are truncated at the cap. Silent wet mixes add no time-effect tail. Channels receive the same processor settings; a linked compressor envelope and shared final headroom gain preserve stereo balance.

Final peak control only attenuates to a ceiling of 0.85; it never increases a quiet signal. `attenuationDb` is the signed applied gain in dB (zero or negative). `peak` is the post-attenuation float peak; PCM16 output differs by at most quantization tolerance. Native render failures use `INVALID_RENDER_REQUEST`, `AUDIO_INPUT_INVALID`, `AUDIO_INPUT_TOO_LARGE`, `AUDIO_OUTPUT_TOO_LARGE`, `AUDIO_OUTPUT_EXISTS`, or `AUDIO_RENDER_FAILED` with sanitized messages.
