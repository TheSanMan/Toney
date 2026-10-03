# ADR 004: imported NAM captures and cabinet IRs

## Decision

Use ToneSpec version 2 to reference local assets by SHA-256 content ID, kind (`nam` or `ir`) and safe basename. Builtin version 1 presets migrate at the TypeScript boundary; external models require version 2. Amp and cabinet nodes retain their existing parameter contract and carry references only for their respective external models.

The desktop shell owns import, storage and resolution. The frontend supplies bounded bytes, a safe name and kind; it cannot choose paths. Rust hashes and privately stages the bytes, then asks the native helper to inspect the actual file. Only accepted files are atomically installed in the durable app data library. Same-content imports preserve the original descriptor. Listing reports corrupt entries as diagnostics. Render resolves enabled references, verifies file content, privately stages copies and passes trusted paths to the helper. Missing, modified or unsupported assets are explicit correlated failures.

Use pinned official NeuralAmpModelerCore 0.3.0 and classic mono WaveNet/LSTM 0.5.x captures. Before upstream construction, validate finite configuration and weights, exact expected weight counts, and bounded memory/receptive fields. Unsupported versions, conditioning and multi-input/output models fail explicitly. Source channels have independent fresh model states; inference uses the model rate (48 kHz when absent) and resamples to the source rate. Gain and master are external input/output trims; bass/mid/treble are external EQ around a fixed capture.

Use JUCE convolution for cabinet IRs with bounded WAV decoding, sample-rate conversion and zero-latency impulse alignment. Do not trim or normalize imported impulses. Preserve source channels; average stereo IR channels for mono sources. Apply brightness/resonance shaping after convolution. Output still uses the existing shared attenuation-only peak ceiling.

Browser audition accepts builtin processing only. Enabled external models require native rendering. Bypassed external nodes require no asset resolution. Agent refinements preserve selected references, node identities, bypass state and unrelated manual parameters.

## Consequences

- Presets are portable references, not asset bundles. Users reimport the same files on another machine.
- The library survives application restarts and stays local. Model weights and recordings never belong in Git or diagnostic exports.
- Limits: library 128 entries; IR 8 MiB/two seconds/mono or stereo/8–96 kHz; NAM 32 MiB/classic mono architectures. Untrusted native allocations remain bounded before inference.
- Automated checks must use actual convolution and official neural inference, including numerical references, determinism, channel isolation, missing/corrupt assets and sample-rate conversion. Bundle checks must exercise its actual helper.
- Offline correctness does not establish realtime performance. No stream, input device lifecycle or signing/distribution claim is introduced here.
