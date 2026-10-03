# Architecture

## Checkpoint 1 decision: agent-first vertical slice

The product proposal recommends proving manual native audio before adding the agent. The current development instruction explicitly requests a functioning agent first. This checkpoint therefore builds a small interactive workbench with audible preview while preserving the native audio boundary. It does not claim to complete the proposal's Phase 0 or Phase 1 acceptance criteria.

## Boundaries

- `core/tone`: versioned ToneIntent and ToneSpec contracts, gear catalog, validation, compiler, and typed manual operations.
- `core/agent`: provider abstraction, offline interpreter, optional local model adapter, request orchestration, and structured traces.
- `apps/desktop/src`: React workbench, canonical rig state, local development history, preset import/export, and error feedback.
- `apps/desktop/src/audio`: deterministic offline Web Audio preview adapter alongside the native audition bridge. No inference runs during audio processing.
- `core/native`: versioned desktop command/response contracts and correlation checks.
- `apps/desktop/src-tauri`: Rust shell, bounded helper lifecycle, native saves, and fixed-endpoint Ollama transport.
- `engine/audio`: JUCE device discovery, independent rig validation, and deterministic offline WAV processing through builtin effects, measured cabinet convolution and official NAM inference.
- `knowledge`: editable tone-engineering procedures. Only procedures actually used by the compiler belong here.
- `tests`: important contract, engineering, refinement, and failure-path coverage.

The domain shares TypeScript contracts in-process. The desktop/native control boundary uses protocol version 1 messages with request IDs; Rust and C++ independently validate requests, and TypeScript correlates acknowledgements to the canonical rig revision. The helper handles one request and exits. Rendering stages bytes in a private Rust-owned directory and returns correlated metadata plus bounded WAV bytes. Frontend input cannot specify file paths. See [ADR 002](adr-002-desktop-control-boundary.md) and [ADR 003](adr-003-native-offline-rendering.md). A native engine must validate incoming ToneSpecs, apply control-thread updates, and smooth parameters without allocating, logging, blocking, or running inference in its audio callback.

## First dependencies

React and TypeScript provide the UI and typed domain. Vite serves and builds the development workbench. Vitest checks deterministic domain logic and failure paths; ESLint and TypeScript enforce code quality. Web Audio is the preview runtime. A local model provider is optional; no model weights are bundled or downloaded automatically.

## Engineering assumptions and limitations

The offline interpreter is deterministic domain logic, not an LLM, and must expose uncertainty for language it cannot understand. The local model interface must validate structured responses before compilation. Known artist references are broad stylistic starting points, not verified reproductions of recorded equipment.

The preview uses simple nonlinear shaping and cabinet filtering. It is useful for hearing parameter differences, while native rendering can use imported NAM captures and measured cabinet IRs. A synthetic phrase is not recorded guitar DI. User-provided DI is the better quality assessment input. Browser decoding depends on the platform. Browser latency is not evidence of native realtime performance.

## Shared rig and history

All controls and agent operations use one ToneSpec. Refinements start from its current values and preserve unrelated edits, bypass states, and node identities. ToneSpec schema version 2 adds SHA-256 asset references; builtin version 1 presets migrate on TypeScript import. ToneIntent remains version 1. Import validates versions, node models, parameter keys/ranges, identifiers, and finite numeric values. A failed request leaves the current rig intact.

Every generation has a trace ID, provider, stages, timing, and warnings. Errors include a stable code and trace ID. Diagnostics are available for local export. Keep diagnostic data on the control side; a future realtime callback never logs.

## Deferred architecture

SQLite, live streams, source separation, and plugin hosting are introduced when their next vertical slice can be tested. Do not create empty subsystems or fake capability indicators. Decide JUCE distribution/licensing and native IPC packaging before shipping a native build.

## Native offline audio

All eight builtin nodes process the source in canonical chain order; bypassed nodes do not process it. Native rendering preserves mono/stereo source channels, bounds tail duration/output bytes, rejects unsupported or non-finite audio, and applies shared attenuation only above the peak ceiling. PCM16 artifacts are independently inspected in TypeScript against sample rate, channels, frame counts, and peak diagnostics before playback.

The native saturation does not currently oversample, and the native room uses a deterministic algorithmic reverb. The browser uses its own Web Audio algorithms, including a synthetic convolution response. They are audible approximations with contract agreement; they do not promise sample parity, measured equipment fidelity, stereo expansion from mono, or realtime performance.

## Imported audio assets

The Rust shell owns a durable, content-addressed local asset library. Imports are bounded, hashed and inspected by the actual helper before atomic persistence. The frontend receives safe names, content IDs and model/audio metadata. Render requests carry asset references; Rust verifies stored bytes, stages private copies and supplies trusted helper paths. Enabled references must resolve; there is no substitute processing on missing/corrupt/unsupported files. Browser rendering rejects enabled external assets. See [ADR 004](adr-004-imported-audio-assets.md).

The official NAM runtime is pinned separately from the `.nam` file format. Capture validation bounds allocations and checks exact finite weight counts before invoking upstream factories. Each source channel owns fresh state, is prewarmed, and processes at the model's sample rate. The existing fixed capture receives input/output trim and external EQ; it has no invented physical amp controls. Imported IR convolution preserves alignment and amplitude without normalization. Neither offline subsystem establishes realtime callback safety or latency.
