# Architecture

## Checkpoint 1 decision: agent-first vertical slice

The product proposal recommends proving manual native audio before adding the agent. The current development instruction explicitly requests a functioning agent first. This checkpoint therefore builds a small interactive workbench with audible preview while preserving the native audio boundary. It does not claim to complete the proposal's Phase 0 or Phase 1 acceptance criteria.

## Boundaries

- `core/tone`: versioned ToneIntent and ToneSpec contracts, gear catalog, validation, compiler, and typed manual operations.
- `core/agent`: provider abstraction, offline interpreter, optional local model adapter, request orchestration, and structured traces.
- `apps/desktop/src`: React workbench, canonical rig state, local development history, preset import/export, and error feedback.
- `apps/desktop/src/audio`: deterministic offline Web Audio preview adapter. No inference runs during audio processing.
- `core/native`: versioned desktop command/response contracts and correlation checks.
- `apps/desktop/src-tauri`: Rust shell, bounded helper lifecycle, native saves, and fixed-endpoint Ollama transport.
- `engine/audio`: JUCE device discovery and independent rig validation; no audio processing yet.
- `knowledge`: editable tone-engineering procedures. Only procedures actually used by the compiler belong here.
- `tests`: important contract, engineering, refinement, and failure-path coverage.

The domain shares TypeScript contracts in-process. The desktop/native control boundary uses protocol version 1 messages with request IDs; Rust and C++ independently validate requests, and TypeScript correlates acknowledgements to the canonical rig revision. The helper currently handles one request and exits. See [ADR 002](adr-002-desktop-control-boundary.md). A native engine must validate incoming ToneSpecs, apply control-thread updates, and smooth parameters without allocating, logging, blocking, or running inference in its audio callback.

## First dependencies

React and TypeScript provide the UI and typed domain. Vite serves and builds the development workbench. Vitest checks deterministic domain logic and failure paths; ESLint and TypeScript enforce code quality. Web Audio is the preview runtime. A local model provider is optional; no model weights are bundled or downloaded automatically.

## Engineering assumptions and limitations

The offline interpreter is deterministic domain logic, not an LLM, and must expose uncertainty for language it cannot understand. The local model interface must validate structured responses before compilation. Known artist references are broad stylistic starting points, not verified reproductions of recorded equipment.

The preview uses simple nonlinear shaping and cabinet filtering. It is useful for hearing parameter differences, but realistic amps require the later NAM/native work. A synthetic phrase is not recorded guitar DI. User-provided DI is the better quality assessment input. Browser decoding depends on the platform. Browser latency is not evidence of native realtime performance.

## Shared rig and history

All controls and agent operations use one ToneSpec. Refinements start from its current values and preserve unrelated edits, bypass states, and node identities. Schema version 1 is explicit. Import validates versions, node models, parameter keys/ranges, identifiers, and finite numeric values. A failed request leaves the current rig intact.

Every generation has a trace ID, provider, stages, timing, and warnings. Errors include a stable code and trace ID. Diagnostics are available for local export. Keep diagnostic data on the control side; a future realtime callback never logs.

## Deferred architecture

SQLite, native DSP, NAM, IR convolution, live streams, source separation, and plugin hosting are introduced when their next vertical slice can be tested. Do not create empty subsystems or fake capability indicators. Decide JUCE distribution/licensing and native IPC packaging before shipping a native build.
