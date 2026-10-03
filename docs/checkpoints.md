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

## 003 — Desktop control foundation

Implemented and committed:

- Tauri 2 macOS desktop shell with bundled frontend and architecture-specific JUCE 8.0.14 helper.
- Real audio device discovery without opening streams; independent native ToneSpec validation.
- Versioned JSON IPC, request/revision correlation, bounded messages, strict UTF-8/JSON parsing, subprocess timeout/cleanup, and structured errors.
- Audio devices UI, explicit refresh/validate actions, stale validation notice, and diagnostic operation IDs/timings.
- Native save dialogs for preset/WAV/diagnostics. Same-directory atomic writes preserve existing files on write failure and clean temporary files.
- Rust transport to fixed loopback Ollama endpoint, with no redirects/proxy, bounded text-only requests/responses, and 45-second deadline.
- Native build/dev/check commands, desktop CI job, source icon, and dependency/license notices.

Verification on 2026-10-02 (America/Chicago):

- `npm run native:build` passed with CMake 4.4.3, Rust 1.97.1, JUCE 8.0.14 checkout, and the documented SDK header workaround. CTest passes its contract suite with 84 assertions. Helper staged for Apple Silicon macOS.
- `npm run check`: ESLint, TypeScript, 33 tests across five files, production build all pass. Native integration tests ran without skips; every effect parameter minimum/maximum and out-of-range rejection agrees between TypeScript and the actual C++ executable.
- Rust formatting, seven tests, and Clippy with warnings denied pass. Atomic export tests include an injected failure after a partial temporary write, proving the original preset remains intact.
- Direct real-device scan of the staged helper returned nine CoreAudio devices (four inputs/five outputs), correlated response and clean stderr. Earlier scans returned six; system device inventory can change. No stream was opened.
- Final local development `Toney.app` bundle rebuilt with the atomic export fix and current helper. Bundled helper identity verified against staged executable.
- Computer Use reported “Computer Use permissions are not granted.” Desktop GUI, native save-dialog delivery, WKWebView playback, and packaged live Ollama inference remain unverified interactively. No desktop screenshot is available.
- Hosted CI configuration added; hosted execution remains pending a push. Commits are local.

Checkpoint pause: automated native boundary verified; desktop acceptance remains available for user interaction. Open `apps/desktop/src-tauri/target/debug/bundle/macos/Toney.app`, generate a tone, refresh devices, validate it, move a knob and revalidate, save/re-import a preset, audition/export WAV, and try Ollama with the Vite server stopped.

Next: native offline DSP rendering from a clean DI WAV, with deterministic output checks, bypass behavior, finite samples/headroom, and artifact error tracing. Native rendering precedes opening realtime streams. Current audition remains Web Audio; device discovery and schema acceptance do not establish native DSP or latency.
