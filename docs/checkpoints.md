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

## 004 — Native offline audio audition

Implemented:

- JUCE native processing for compressor, drive, amp, cabinet filter, EQ, chorus, delay, and algorithmic reverb in canonical chain order. All 23 catalog knobs control the signal; bypassed nodes do not process it.
- Independent ToneSpec/source validation, bounded WAV decoding/writing, source/channel/sample-rate preservation, capped effect tails, and attenuation-only shared peak control.
- Dedicated Rust render command stages input/output in a private temporary directory; frontend cannot supply paths. A 60-second subprocess deadline and bounded output protect the control path. Success/error/timeout cleanup owns the request files.
- Browser/native backend selector, exact native WAV playback/export, correlated rig/source/render metadata in Diagnostics, and preserved rig/audition on failure.
- A `native:audition` command creates repeatable dry/bypass/crunch/spacious WAVs and matching presets; an optional exported preset argument adds a render of that rig.

Verification on 2026-10-02 (America/Chicago):

- Native build/staging passed with the pinned JUCE 8.0.14 and documented SDK workaround. CTest suites pass 84 control assertions and 49 rendering assertions.
- Native tests cover every effect and catalog knob, full-chain byte determinism, mono/stereo bypass fidelity, finite/headroom/tail behavior, malformed/truncated/unsupported/silent/non-finite inputs, duration/size limits, and existing-output preservation.
- Rust formatting, 12 tests, and Clippy with warnings denied pass, including private staging/cleanup, injected paths, bounded bytes, regular output files, and WAV envelope checks.
- `npm run check`: ESLint, TypeScript, all 40 tests across seven files (no native skips), and production build pass. Actual-helper tests verify padded RIFF chunks, PCM16 artifacts, recipe contrasts, and production frontend artifact inspection against native metadata.
- Browser harness at the existing narrow panel: backend selector and desktop requirement inspected; rendered current rig, exposed WAV export, and verified player duration 8.300 seconds, advancing playback, no audio error. Screenshot recorded at `/private/tmp/toney-checkpoint-004-browser.jpg`.
- `npm run native:audition` produced a six-second source/bypass; crunch output 271216 frames, peak 0.850 and -2.93 dB attenuation; spacious output 491716 frames, peak 0.211 and no attenuation. Files are generated in the ignored native build auditions folder.
- Local desktop app rebuilt with engine 0.3.0; bundled helper identity and a real bundled-helper WAV render verified independently. Desktop native GUI remains unverified because native Computer Use permissions were unavailable. Browser controls and real executable tests do not establish WKWebView/native-dialog behavior.
- Checkpoint003 was pushed to `origin/main`; its hosted GitHub Actions run passed: https://github.com/TheSanMan/Toney/actions/runs/37085068762. Checkpoint004 is committed and pushed after its local gates; record hosted status separately when available.

Limits: approximate builtin effects, no native saturation oversampling, algorithmic room instead of a measured IR, no mono-to-stereo expansion, PCM16 workbench staging, no measured real guitar quality, no NAM/IR loading or realtime stream. Browser/native DSP algorithms differ; tests prove contracts/behavior, not sample parity.

Checkpoint pause: open the rebuilt desktop app, select Native builtin DSP, import a clean DI or use the demo, render/play/export, then compare Browser preview on the same source. The CLI audition gives audible native artifacts without GUI automation. Review one short slice before choosing the next tone-quality component.

Next: measured cabinet IR loading and convolution with validated assets, audible A/B, missing-asset diagnostics, and preset asset references; NAM and realtime input follow their own acceptance checkpoints.

## 005 — Imported cabinet IRs

Implemented:

- ToneSpec v2 content references with safe names and SHA-256 IDs; builtin v1 presets migrate at import. Typed selection preserves manual knobs and bypass states; agent refinement preserves selected models.
- Durable Rust asset library with actual-helper inspection before atomic persistence, bounded inventories, diagnostic repair messages and hash-verified private render staging. Frontend calls cannot supply paths.
- Measured cabinet convolution without trimming or normalization, aligned sample-rate conversion, stereo handling that preserves source channels, and existing peak/tail bounds.
- Model library controls, explicit missing-file state, builtin restoration and native-only external processing.

Verification on 2026-10-03 (America/Chicago):

- IR native build passed 84 control, 49 render and 16 asset assertions. An impulse render matches direct discrete convolution within 1e-5; converted tap timing, stereo-to-mono averaging, SHA mismatch, missing/duplicate assets and bounds were exercised.
- Frontend domain/asset/bridge suites passed 49 selected tests; lint and strict TypeScript passed. Tests include malformed metadata, response correlation/hash mismatches, unsafe files and native-only browser processing.
- Rust asset checkpoint passed 20 tests and Clippy. Its headless Tauri test harness invokes the real JUCE helper to inspect/import/persist/reopen/stage/render a WAV IR, and rejects malformed imports without library entries.
- Browser regression review imported a v2 preset with an absent NAM reference, showed its filename/missing state and trim labels, refused enabled external-model playback, preserved the reference through “make it wider”, rendered successfully after bypass, and restored the builtin model through its selector.
- Historical checkpoint004 hosted CI passed at https://github.com/TheSanMan/Toney/actions/runs/37086061234.

The user requested continuation through NAM integration, so work proceeds directly to checkpoint006 without pausing here. Native GUI testing remains pending Computer Use permissions; these headless tests do not establish WKWebView or native-dialog behavior.

## 006 — Neural amp models

Acceptance criteria:

- Import and persist supported classic mono WaveNet/LSTM captures; reject unsupported, incomplete or unsafe configurations before upstream construction.
- Run the pinned official NAM inference implementation at the model sample rate, with independent channel state and deterministic renders.
- Preserve source sample rate/channel count, apply explicit trim and external EQ, and produce finite bounded WAV artifacts with correlated diagnostics.
- Exercise the real helper and Rust transport, rebuild the bundled app, create an easy CLI audition, pass required gates and push the checkpoint.

Implemented and verified on 2026-10-03 (America/Chicago):

- Official NeuralAmpModelerCore v0.3.0 inference pinned at `e5cc355746866bed85cd48ab3e92513dc8cf7a8b`, with pinned Eigen and JSON dependencies. Supported files are classic mono WaveNet A1/LSTM, exactly versions 0.5.0–0.5.4; unsupported versions/configurations fail explicitly.
- Preflight validates exact finite weights, bounded dimensions/memory/receptive fields, duplicate JSON and unsafe counts before upstream constructors. Each render/channel starts fresh, uses official reset/prewarm, processes at capture rate (48 kHz when absent) and resamples to source rate.
- NAM input/output trims and external EQ are labeled explicitly; the fixed capture has no invented physical controls. Presets/refinements retain selected models; imports and render errors carry correlation IDs and preserve the current rig.
- All four CTest suites passed: 84 control + 49 render + 16 IR asset + 32 NAM assertions = 181. WaveNet/LSTM match direct official factory inference samplewise within 1e-7. An independent scalar LSTM oracle agrees within 2e-6. Tests include rate conversion, stereo state isolation, repeat determinism and malformed/unsupported models.
- `npm run check` passed ESLint, strict TypeScript, all 68 tests across 11 files with no native skips, and the production Vite build. Actual-helper asset tests use production metadata/WAV validators, inspect both official fixtures, render NAM/IR/combined, verify bypass/missing/hash behavior, repeat bytes and preserve existing output on failure.
- Final Rust formatting, all 21 tests and Clippy with warnings denied passed. Headless Tauri tests exercise the real helper for both IR and NAM import → inspection → atomic persistence → library reopen → private resolution → WAV render, and reject unsupported 0.5.5 without installing another entry. Tests locate licensed fixtures from the pinned fetched dependency; no weights are committed.
- `npm run native:models` passed in default WaveNet fixture mode and explicit LSTM/IR/source mode. Default artifacts are in `engine/audio/build/auditions/models-1791039900649-b5a76ee2`. The CLI clearly labels fixture/synthetic inputs and accepts real user captures and clean DI.
- Final local development Toney.app rebuilt successfully (55.20 MiB) with frontend and engine0.5.0. Its bundled helper SHA-256 matches the staged helper. Real NAM-only, IR-only and combined WAV renders through the bundled executable were byte-identical to corresponding standalone helper artifacts. Combined output: 48000 Hz, mono, 96000 source frames, 101823 output frames, peak 0.08584, no attenuation. Bundle proof artifacts: `/private/tmp/toney-packaged-models-4gkz8gli`.
- Browser controls reviewed at the narrow development panel; screenshot `/private/tmp/toney-checkpoint-006-model-controls.jpg`. Enabled missing NAM playback fails with the native requirement, bypass allows builtin rendering, refinement preserves selected reference/trim parameters, and builtin restoration works.

Limits: offline processing only; no live guitar stream, realtime latency claim, advanced/conditioned NAM architecture support, stereo expansion, or listening-quality judgment from real guitar recordings. Native GUI/save-dialog/WKWebView import/playback and packaged Ollama interaction remain unverified because Computer Use permissions were unavailable. Official macOS setup guidance was provided to the user; headless tests and bundled-helper artifacts do not establish GUI acceptance. The bundle is for local development, not a signed/notarized release.

Checkpoint pause: open the rebuilt Toney.app, import your supported `.nam` and cabinet `.wav`, select them, import a clean DI, choose Native DSP + NAM / IR, render/play/export and compare bypass/builtin processing. Alternatively use `npm run native:models -- /absolute/capture.nam /absolute/cab.wav /absolute/clean-di.wav` for audible artifacts without GUI automation. NAM integration is complete at this checkpoint; realtime input remains the next separate component. Hosted CI status is recorded after pushing.

## 007 — TONE3000 selection and local model delivery

Implemented for the personal prototype on 2026-10-03 (America/Chicago):

- Embedded the supplied publishable application identifier; no secret API key is needed or stored.
- Native OAuth PKCE S256 with secure random state, a ten-minute pending selection, exact callback destination/field checks, single-use code handling, and cancellation/generation checks.
- macOS `toney://tone3000/callback` scheme registered in the app bundle. Native OS URL events handle callbacks without broadcasting OAuth codes to the frontend.
- Hosted browsing/audition through `select_tone`: amp/NAM/A1 and cabinet/IR filters. Only the selected tone and up to 128 variants are fetched; each file download requires an explicit user action.
- Session tokens stay in Rust memory, with proactive refresh before an expired-token download. Closing the selection disconnects locally; restarting requires reconnection. Installed files persist offline.
- HTTPS fixed-origin API transport, no proxies or redirects, bounded streamed responses, sanitized errors, and no account credentials or delivery URLs in frontend responses/traces. An undocumented file redirect fails explicitly rather than forwarding credentials.
- Downloads pass the real helper's existing asset inspection before SHA-256 content-addressed installation. Creator, license, tone/model IDs, title and source page survive library reopening and identical-content local reimport.
- Desktop controls show the selected pack and model variants, download status, stable errors/request IDs, and persisted attribution beside loaded amp/cabinet selectors. Downloads add to the library; applying to a rig remains an explicit choice.
- Official unmodified TONE3000 full logo, README instructions, third-party notices and ADR 005. The browser harness shows a desktop requirement for account/download actions.

Verification:

- `npm run check`: ESLint, strict TypeScript, 80 tests in 13 files, and production build passed. Includes strict native envelopes, rejected secret/download fields, request correlation, malformed provider metadata, and bridge errors.
- Rust tests: 29 passed, including real NAM/IR helper import-render tests, callback replay/state/expiry/cancellation, PKCE/catalog constraints, delivery-origin restrictions, bounded byte accumulation, token exclusion and durable provenance. Formatting and Clippy with warnings denied passed.
- Local macOS development bundle rebuilt successfully (56.16 MiB). Inspected its actual Info.plist: `CFBundleURLTypes` contains `toney`; the bundled helper retains SHA-256 `8a3b8c2d363051285fc9489128fb23cd9ec7c7b55bf7bf2582f340045bdc1727`. Official logo present in the production web build.
- Browser review at narrow panel width confirmed the new controls, explicit desktop restriction, persisted missing-asset behavior and correctly loaded official SVG. Screenshot: `/private/tmp/toney-tone3000-panel.png`.
- Live account authorization, OS callback delivery, and a production TONE3000 file download remain unverified. These require the user to sign in and select a tone in the rebuilt desktop app. Unit fixtures are not live API evidence. Native GUI automation remains unverified after the previously reported macOS Computer Use permission block.

Checkpoint pause: open `apps/desktop/src-tauri/target/debug/bundle/macos/Toney.app`; choose **Browse amp models**, sign in on TONE3000, select a capture, then **Download to local library**. Choose the downloaded entry under **Amp model**, select **Native DSP + NAM / IR**, and **Hear this rig**. Repeat with **Browse cabinet IRs**. If restricted redirect URIs are configured on TONE3000, add `toney://tone3000/callback`. Record any error code/request ID from the panel or diagnostic export.

Remaining limits: classic NAM A1 file support only; no NAM pedal block or A2 runtime, no live guitar stream, session-only sign-in, and no public/commercial integration sign-off. Full production tone artwork/avatar/detail presentation is a later UI checkpoint; downloaded capture rights remain governed by each creator's license. If real delivery uses a CDN redirect, verify and support its actual origin before declaring live download acceptance complete.
