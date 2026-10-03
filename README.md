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

## Working checkpoint: desktop control foundation

This repository begins with a small, runnable vertical slice, following the requested agent-first development order:

- A local interpreter turns everyday descriptions into a validated `ToneIntent`.
- A deterministic compiler creates or refines a validated `ToneSpec`.
- A guitar-oriented React workbench shows the chain and allows manual edits.
- An offline browser audio preview makes the result audible using a synthetic plucked-string phrase or an imported clean DI file.
- Local version history, preset export/import, and request traces support iteration and diagnosis.

A Tauri macOS desktop app now packages the same workbench with a JUCE helper for real audio device discovery and independent rig validation. Preset, WAV, and diagnostic exports use native save dialogs. Its audio audition still uses Web Audio; native DSP, NAM, cabinet IRs, and realtime guitar input are subsequent checkpoints.

## Development

Development requires Node.js 22 or later and npm. The eventual packaged application will include its runtimes.

```sh
cd /Users/sanjeetpanigrahi/Desktop/WorkFiles/Toney
npm ci
npm run dev
```

Open [the local workbench](http://127.0.0.1:5173). The server binds only to this machine. Use `npm run check` to run lint, typecheck, tests, and the production build. `npm run test:watch` runs tests while editing.

### Try the tone agent

1. Pick **Dark grunge** and click **Dial in my tone**.
2. Click **Hear this rig**. If your browser blocks automatic playback, press the audio player's play button. Compare with **Dry source**.
3. Adjust a knob or bypass a pedal, then ask “make it wider.” The agent refines the current manual settings.
4. Use **New rig** to start fresh; try **Clean funk** or **Dreamy ambient** and listen to the difference.
5. Import a mono/stereo clean guitar DI clip (up to 90 seconds/50 MB) for a more useful audition. WAV is the safest choice; other decoding formats depend on your browser.
6. Save a JSON preset, export a rendered WAV, or snapshot the rig into local history. Generated tones and snapshots are retained in browser storage; manual edits need a snapshot or preset export to survive a reload.
7. Open **Diagnostics** to inspect stage timings and export the exact request, starting rig, and trace ID.

Some embedded browsers block file downloads. If a preset does not download, open **Diagnostics → Current preset JSON** and copy it into a `.json` file, or use the workbench in your normal browser. Local snapshots remain available in the embedded workbench.

### Optional local model

The default **Offline tone rules** provider is deterministic domain logic, not an LLM. It supports common gain, brightness, dynamics, space, and style descriptions and reports unrecognized language.

To use an installed Ollama model, start Ollama, select **Local model · Ollama**, and enter its installed model name. The development server proxies requests only to `127.0.0.1:11434`. No weights are downloaded automatically. `llama3:latest` was successfully tested on the development machine; model output is schema-validated and failures do not replace the current rig. There is a 45-second inference timeout.

The browser Ollama proxy is part of `npm run dev`; a static build or `npm run preview` provides the offline rules workbench only. The desktop app connects through Rust directly to the same fixed local endpoint, with bounded requests/responses and no redirects. This native transport is implemented and contract-tested; integrated desktop inference still needs interactive verification.

### Run the desktop app

Build requirements: macOS, Node.js 22+, Rust 1.90+, CMake 3.22+, and Xcode Command Line Tools. The native helper fetches the pinned official JUCE 8.0.14 source on its first build.

```sh
npm run desktop:dev
# Or build a development .app with its frontend and helper bundled:
npm run desktop:build
```

The app is created at `apps/desktop/src-tauri/target/debug/bundle/macos/Toney.app`. It is a local development bundle; signing, notarization, and distribution are later work. `npm run desktop:check` runs Rust formatting, tests, and Clippy. `npm run native:build` runs C++ contract tests and stages the helper; `npm run check` then also tests TypeScript/native catalog agreement. Those integration tests explicitly skip when the helper has not been built.

For a CMake executable outside PATH, set `CMAKE=/absolute/path/to/cmake`. See [native build instructions](engine/audio/README.md) for the tested macOS SDK header workaround and an optional existing JUCE checkout.

In **Audio devices**, refresh devices and validate the current rig. Device scanning does not open microphone or output streams. Validation confirms schema/catalog acceptance; it does not install a running DSP graph. Adjusting the rig marks the previous validation as outdated. Diagnostics include operation IDs, timings, and error codes.

Checkpoint 003 has passed build and automated checks, including real device enumeration. Desktop GUI, native save-dialog delivery, WKWebView playback, and packaged Ollama interaction require user review because Computer Use permissions were unavailable during verification.

## Checkpoints

1. **Repository foundation:** README, architecture, development workflow, and checkpoint criteria.
2. **Tone agent workbench:** intent → rig → audible preview, manual edits, contextual refinement, validation, tests, and traces.
3. **Desktop control foundation:** Tauri bundle, audio device enumeration, native rig validation, native saves, and local inference transport.
4. **Native offline audio:** render a DI through native DSP, validate WAV output, and compare against the preview contract.
5. **Local inference and audio quality:** evaluate models, NAM and cabinet IR support, reliable generation and refinement.
6. **Realtime playing:** audio interface input, smoothing, meters, and device lifecycle testing.

Later work adds audio analysis, candidate search, reference matching, preferences, plugin hosting, and optional research. Each checkpoint must remain runnable and be committed before review. See [architecture](docs/architecture.md), [development workflow](docs/development.md), and [checkpoint log](docs/checkpoints.md).

## Privacy

Core generation and audio preview run locally. Optional model inference must use an explicitly selected local provider. Audio recordings are not uploaded. Diagnostic exports include prompts and rigs, so keep them private as appropriate. Network research is a later, opt-in capability.

The original [product proposal](docs/product-proposal.md) is preserved for reference. The current checkpoint follows the direct request to start with the agent; native audio processing phases are still outstanding.
