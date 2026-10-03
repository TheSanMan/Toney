# ADR 003: Native offline audio rendering

Status: accepted for checkpoint 004.

## Scope

Render the current canonical rig against the same demo or imported clean DI used by the browser audition. Deliver a native WAV that can be played, compared, and saved. The eight existing builtin models remain approximate effects; this checkpoint has no NAM, measured cabinet IR, or realtime input.

## Boundary

The frontend submits a validated ToneSpec, correlated request ID, and a bounded WAV byte array to a dedicated Rust command. Rust creates a private temporary directory, stages `input.wav`, and asks the bundled helper to render to its own `output.wav`. Paths never originate in frontend input. General control commands cannot accept render requests or arbitrary file paths.

The helper independently validates the rig and source. It reports source/output frame counts, sample rate, channels, peak, attenuation, engine version, and rig revision. Rust bounds and reads only the expected WAV output, then removes temporary files. The frontend validates the response and decoded audio metadata before playing it. A failure preserves the rig and previous audition.

## Limits and verification

Support nonempty mono/stereo WAV sources at integer sample rates from 8000 to 96000 Hz, at most 90 seconds and 32 MiB. Output is at most 32 MiB with tails capped at 12 seconds. Rendering has a 60-second process deadline. Large sources fail explicitly instead of bypassing bounds. Audio contains finite values; shared attenuation only controls peaks above 0.85 and preserves channel balance. All-bypassed processing preserves source samples within PCM quantization.

Tests cover actual WAV input/output, deterministic results, effect and bypass behavior, tails, headroom, malformed sources, language/rig correlation, and temporary-file cleanup. Browser and native algorithms may differ; compare audible behavior and contract agreement, without claiming sample parity or guitar realism.

## Next boundary

Realtime audio needs a persistent engine, callback-safe graph updates, parameter smoothing, device lifecycle handling, and latency measurements. Offline rendering is independent of system audio streams.
