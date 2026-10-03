# Checkpoint log

## 001 — Repository foundation

- Defined the local-first product direction, canonical ToneSpec, and agent/audio separation.
- Recorded the agent-first ordering requested for this session and the preview's limits.
- Defined short commits, required validation, interactive review, and diagnostic expectations.
- Repository inspection: no existing implementation or local AGENTS.md; initial tree contained only README.md.

Next: implement and verify the interactive tone-agent workbench.

## 002 — Interactive tone-agent workbench

Working:

- Strict version 1 ToneIntent/ToneSpec contracts, catalog, range/model validation, immutable manual operations, and contextual compiler.
- Offline domain interpreter with comparisons, scoped negation, style starting points, and uncertainty warnings.
- Optional local Ollama provider with structured output validation and a 45-second timeout.
- React pedalboard with authoritative knobs/bypass, contextual refinement, snapshots/history, preset import, and diagnostic JSON fallback for embedded browsers that block downloads.
- Actual offline preview DSP for eight nodes, synthetic dry phrase, mono/stereo DI decoding, delay/reverb tails, attenuation-only output headroom, and WAV serialization.
- Trace IDs, stage durations, stable error codes, and reproducible request snapshots. Failed model requests preserve the current rig.

Verification on 2026-10-02 (America/Chicago):

- `npm ci --offline --cache /private/tmp/toney-npm-cache`: reproducible install; zero dependency vulnerabilities reported.
- `npm run check`: ESLint, strict TypeScript, all 25 tests across three files, and production build passed.
- Browser at narrow panel and 1440px desktop width: generation, pedal layout, audio rendering and playback verified.
- Edited Drive gain to 0.42 and bypassed it, then requested “make it wider”: gain and bypass remained authoritative; chorus changed.
- Live `llama3:latest` request made the rig warmer while retaining gain and pick controls.
- Nonexistent model returned HTTP 404 with trace `trace_1904486c-c626-4428-8e84-e7aa936bb5f6`; current rig and history stayed intact.
- Imported a generated two-second mono WAV fixture successfully; its filename appeared as the selected source. No real guitar recording was available for a listening-quality judgment.
- Captured visible current preset JSON, started a new rig, and imported that file: 0.42 drive gain and its bypass state were restored.
- Embedded browser did not expose a completed file-download event. Added a visible preset JSON fallback and documented using a normal browser for download testing. WAV bytes are covered by serialization tests; native download delivery still needs ordinary-browser verification.

Limits: browser approximation, no measured cabinet IR or NAM, no realtime guitar input, no native desktop bundle, no audio analysis/closed-loop optimization. Local history is browser storage; generated tones and snapshots survive reload, unsnapshotted knob changes do not.

Checkpoint pause: ready for user interaction. Next checkpoint should improve tone interpretation and audition quality from user feedback, then introduce the desktop/native audio boundary in a separate runnable slice.
