# Toney

Toney is a local-first guitar tone engineer. Describe a sound in plain language, inspect and edit the resulting rig, listen, and refine it with feedback.

## Product direction

The intended product is a downloadable macOS application built with React, TypeScript, and Tauri, with an independent C++/JUCE audio engine. Windows support follows later. The agent stays outside the realtime audio path.

```text
User intent → ToneIntent → deterministic tone compiler → ToneSpec → audio engine
                                  ↑                       ↑
                            available gear          manual edits
```

`ToneSpec` is the authoritative rig shared by the agent, controls, history, persistence, and audio processing. Manual edits become the input to subsequent agent requests.

## Working checkpoint: NAM pedals and ChatGPT tone engineer

This repository begins with a small, runnable vertical slice, following the requested agent-first development order:

- ChatGPT sign-in uses your eligible plan and discovered models to interpret descriptions into validated `ToneIntent`; explicit offline rules and local Ollama remain available.
- A deterministic compiler creates or refines a validated `ToneSpec`.
- A guitar-oriented React workbench shows the chain and allows manual edits.
- An offline browser audio preview makes the result audible using a synthetic plucked-string phrase or an imported clean DI file.
- Local version history, preset export/import, and request traces support iteration and diagnosis.

The Tauri macOS desktop app packages the workbench with a JUCE helper for real device discovery, independent rig validation, and offline audio rendering through eight builtin effects. Preset, WAV, and diagnostic exports use native save dialogs. Choose native DSP or browser preview to audition the same source. Native rendering also supports imported Neural Amp Modeler captures and measured cabinet IRs. Realtime guitar input is a later checkpoint.

## Development

Development requires Node.js 22 or later and npm. The eventual packaged application will include its runtimes.

```sh
cd /Users/sanjeetpanigrahi/Desktop/WorkFiles/Toney
npm ci
npm run dev
```

Open [the local workbench](http://127.0.0.1:5173). The server binds only to this machine. Use `npm run check` to run lint, typecheck, tests, and the production build. `npm run test:watch` runs tests while editing.

### Try the tone agent

1. In desktop, choose **Continue with ChatGPT** and approve plan usage in your browser. The app discovers available models and prefers GPT-6 Astra when listed, then GPT-6.1 Sol. Choose **Offline tone rules** to try the workbench without sign-in. Pick **Dark grunge** and click **Dial in my tone**.
2. In the desktop app, select **Native DSP + NAM / IR** under **Render with**, then click **Hear this rig**. Switch to **Browser preview** to compare. In the browser harness only browser preview is available. If automatic playback is blocked, press the player's play button. Compare with **Dry source**.
3. Adjust a knob or bypass a pedal, then ask “make it wider.” The agent refines the current manual settings.
4. Use **New rig** to start fresh; try **Clean funk** or **Dreamy ambient** and listen to the difference.
5. Import a mono/stereo clean guitar DI clip (up to 90 seconds/50 MB) for a more useful audition. WAV is the safest choice; other decoding formats depend on your browser.
6. Save a JSON preset, export a rendered WAV, or snapshot the rig into local history. Generated tones and snapshots are retained in browser storage; manual edits need a snapshot or preset export to survive a reload.
7. Open **Diagnostics** to inspect stage timings and export the exact request, starting rig, and trace ID.

Some embedded browsers block file downloads. If a preset does not download, open **Diagnostics → Current preset JSON** and copy it into a `.json` file, or use the workbench in your normal browser. Local snapshots remain available in the embedded workbench.

### ChatGPT account and model

The default desktop interpretation provider is **ChatGPT · your plan**. Native OAuth uses the documented locally hosted/open-source flow with PKCE and verified ID tokens. No API key or client secret is required. The picker lists models returned for the signed-in account; your explicit choice is preserved while available. Toney cannot guarantee unlimited model usage. Plus plan requests share a five-hour allowance across apps, and account permission controls may impose additional caps. See [official account and session documentation](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).

Only the description, perceptual baseline and current rig descriptor go to OpenAI. Guitar audio stays local; this provider cannot hear it or use your ChatGPT conversations/memory. A validated, completed response changes the rig through the existing deterministic compiler and includes an engineering explanation. It does not yet search for captures or render competing candidates automatically. Errors preserve the current rig and include trace/native request IDs; no provider is substituted silently.

Credentials are persisted by Rust outside the repo using owner-only protected files, not macOS Keychain. **Disconnect** removes local tokens and attempts remote revocation. One saved account registration is supported; **Reconnect ChatGPT** reuses it. Live authorization/catalog/inference is a user acceptance step. See [ADR 006](docs/adr-006-chatgpt-agent.md) for security and preview constraints.

### Optional local model

The optional **Offline tone rules** provider is deterministic domain logic. It supports common gain, brightness, dynamics, space, and style descriptions and reports unrecognized language.

To use an installed Ollama model, start Ollama, select **Local model · Ollama**, and enter its installed model name. The development server proxies requests only to `127.0.0.1:11434`. No weights are downloaded automatically. `llama3:latest` was successfully tested on the development machine; model output is schema-validated and failures do not replace the current rig. There is a 45-second inference timeout.

The browser Ollama proxy is part of `npm run dev`; a static build or `npm run preview` provides the offline rules workbench only. The desktop app connects through Rust directly to the same fixed local endpoint, with bounded requests/responses and no redirects. This native transport is implemented and contract-tested; integrated desktop inference still needs interactive verification.

### Run the desktop app

Build requirements: macOS, Node.js 22+, Rust 1.90+, CMake 3.22+, and Xcode Command Line Tools. The native helper fetches pinned official JUCE 8.0.14 and NeuralAmpModelerCore 0.3.0 sources on its first build, including the pinned Eigen dependency.

```sh
npm run desktop:dev
# Or build a development .app with its frontend and helper bundled:
npm run desktop:build
```

The app is created at `apps/desktop/src-tauri/target/debug/bundle/macos/Toney.app`. It is a local development bundle; signing, notarization, and distribution are later work. `npm run desktop:check` runs Rust formatting, tests, and Clippy. `npm run native:build` runs C++ contract tests and stages the helper; `npm run check` then also tests TypeScript/native catalog agreement. Those integration tests explicitly skip when the helper has not been built.

For a CMake executable outside PATH, set `CMAKE=/absolute/path/to/cmake`. See [native build instructions](engine/audio/README.md) for the tested macOS SDK header workaround and an optional existing JUCE checkout.

In **Audio devices**, refresh devices and validate the current rig. Device scanning does not open microphone or output streams. Validation confirms schema/catalog acceptance; it does not install a running DSP graph. Adjusting the rig marks the previous validation as outdated. Diagnostics include operation IDs, timings, and error codes.

Native rendering supports nonempty mono/stereo WAV staging at 8000–96000 Hz, up to 90 seconds and 32 MiB, with output at most 32 MiB and effect tails capped at 12 seconds. The workbench decodes an imported DI using Web Audio, then stages PCM16 for the native helper. Rendering preserves source sample rate/channel count, adds effect tails, and attenuates excessive peaks without boosting quiet rigs. Native exports retain the original engine WAV bytes. Errors include request IDs and preserve the current rig and previous audition.

To hear native processing without GUI automation:

```sh
npm run native:audition
# Optional: audition a preset exported from the workbench against the same phrase:
npm run native:audition -- /absolute/path/to/preset.json
```

The command prints paths to dry, bypass, crunch, and spacious WAVs plus their rigs in the ignored native build directory. Each run uses a separate folder. The generated phrase is synthetic; bring your own guitar DI for quality decisions.

### Try NAM and cabinet IRs

1. Open the desktop app. Under **NAM amps & pedals · cabinet IRs**, choose **Browse amp models**, **Browse NAM pedals** or **Browse cabinet IRs**. TONE3000 opens in your system browser for sign-in, browsing, and audition. Selecting a tone returns to Toney.
2. Choose a model variant and **Download to local library**. Then select it using **Amp model** or **Cabinet model**. You can also import your own `.nam` capture or cabinet `.wav` file. Downloads and imports add files to the library; selection applies them to the rig.
3. Choose **Native DSP + NAM / IR**, then **Hear this rig**. Compare with **Dry source**, bypass a node, or select its builtin model to compare processing on the same DI.
4. NAM pedals replace the Drive block before the amp. First selection starts with neutral trims/EQ. Pedal gain/level are input/output trims (−12 to +12 dB), and tone is an external shelf (−6 to +6 dB). Choose **Builtin preview drive** or bypass the pedal for comparison. Classic captures suit drive/boost/fuzz, not complete delay/reverb/modulation simulations.
5. NAM amp gain/master are input/output trims from −12 to +12 dB, centered at 0.5. Bass/mid/treble are external EQ around the fixed capture. They do not recreate the captured amp's physical controls.
5. Snapshot/save a preset, restart, and reuse the imported files from the durable local library. On another device, reimport the same files; a missing file is shown explicitly and blocks rendering of its enabled node. Bypassed missing nodes do not block audition.
6. Open **Diagnostics** to export the asset IDs, selected rig, render statistics, request IDs and errors. File contents are not included in traces or presets.

Supported NAM files are classic mono WaveNet and LSTM captures with file version 0.5.0–0.5.4, up to 32 MiB. Advanced, conditioned, multi-input/output and unknown architectures are rejected. Captures run at their declared sample rate; models without a rate use 48 kHz. Source audio is resampled for inference and returned at its original rate and channel count. Each source channel gets independent model state. These are offline auditions, not realtime latency measurements.

Cabinet IRs must be nonempty mono/stereo WAVs at 8–96 kHz, up to two seconds/8 MiB, with finite, nonzero samples. They are convolved without trimming or normalization; source channel count is preserved. Stereo IR channels are averaged for mono sources. IR brightness/resonance controls apply additional filters.

TONE3000 sign-in uses OAuth PKCE and the publishable application identifier supplied for this prototype. Account tokens stay in native memory; reconnect after an app restart. Downloaded assets, creator credits, and licenses persist locally and work offline. If redirect URIs are restricted in your TONE3000 settings, register `toney://tone3000/callback`. This callback requires the bundled macOS app to be registered with the OS; use the desktop bundle for this flow. Model downloads follow at most three HTTPS redirects, strip account credentials on storage delegation, and pin publicly resolved delivery addresses. Every file still passes native model inspection before installation. No secret key is needed. See [the integration decision](docs/adr-005-tone3000-selection.md) for the boundaries and terms.

The browser harness supports builtin effects and preset editing. TONE3000 downloads and enabled imported NAM/IR processing require the desktop app. A preset stores SHA-256 content references, never filesystem paths or embedded weights. Models are downloaded only on explicit request and are not bundled with Toney.

## Checkpoints

1. **Repository foundation:** README, architecture, development workflow, and checkpoint criteria.
2. **Tone agent workbench:** intent → rig → audible preview, manual edits, contextual refinement, validation, tests, and traces.
3. **Desktop control foundation:** Tauri bundle, audio device enumeration, native rig validation, native saves, and local inference transport.
4. **Native offline audio:** native builtin DSP, bounded WAV input/output, browser/native comparison controls, deterministic audio tests, and artifact traces.
5. **Cabinet IR integration:** durable asset library, content references, validated convolution and missing-file diagnostics.
6. **Neural amp integration:** official NAM inference, bounded capture validation, independent states and sample-rate conversion.
7. **TONE3000 selection:** account authorization, compatible hosted tone browsing, explicit variant downloads, and durable creator/license metadata.
8. **NAM pedals + ChatGPT:** safe file redirects, drive captures before the amp, native ChatGPT plan sign-in/model discovery, validated interpretation and useful explanations.
8. **Realtime playing:** audio interface input, smoothing, meters, and device lifecycle testing.

Later work adds audio analysis, candidate search, reference matching, preferences, plugin hosting, and optional research. Each checkpoint must remain runnable and be committed before review. See [architecture](docs/architecture.md), [development workflow](docs/development.md), and [checkpoint log](docs/checkpoints.md).

## Privacy

Core generation and audio preview run locally. Optional inference uses the selected provider: local Ollama or opt-in ChatGPT plan usage. ChatGPT sends the description and rig settings to OpenAI. Audio recordings are not uploaded. TONE3000 browsing, sign-in, and requested downloads use its online service; installed assets work offline. Diagnostic exports include prompts, rigs, and asset attribution, so keep them private as appropriate. Credentials are excluded.

The original [product proposal](docs/product-proposal.md) is preserved for reference. The current checkpoint follows the requested agent-first order; live input, audio analysis and distribution remain outstanding.

### Audition imported models without the GUI

```sh
npm run native:models
# Or use your actual captures and optional clean DI WAV:
npm run native:models -- /absolute/capture.nam /absolute/cab.wav /absolute/clean-di.wav
```

The command writes dry, bypass, NAM, IR and combined WAVs plus matching presets into a unique ignored build folder. With no arguments it uses a licensed upstream neural test fixture and a synthetic IR: these test loading and inference, not guitar amp quality. The paths printed by the command let you open the comparisons in a player or import the copied assets and preset into Toney.
