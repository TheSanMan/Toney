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

## First checkpoint: an interactive tone agent

This repository begins with a small, runnable vertical slice, following the requested agent-first development order:

- A local interpreter turns everyday descriptions into a validated `ToneIntent`.
- A deterministic compiler creates or refines a validated `ToneSpec`.
- A guitar-oriented React workbench shows the chain and allows manual edits.
- An offline browser audio preview makes the result audible using a synthetic plucked-string phrase or an imported clean DI file.
- Local version history, preset export/import, and request traces support iteration and diagnosis.

The browser workbench is a development harness for the future desktop app. Its effects and synthetic source are audition tools; they are not a production native amp simulator, neural amp model, cabinet IR, or low-latency guitar input. Realtime device handling, Tauri packaging, and the native engine are subsequent checkpoints.

## Development

The setup and commands will be completed with the first working checkpoint. Development requires Node.js 22 or later and npm. The eventual packaged application will include its runtimes.

## Checkpoints

1. **Repository foundation:** README, architecture, development workflow, and checkpoint criteria.
2. **Tone agent workbench:** intent → rig → audible preview, manual edits, contextual refinement, validation, tests, and traces.
3. **Native audio foundation:** desktop shell, audio device enumeration, native offline DSP, DI workflow, and parity against the preview contract.
4. **Local inference and audio quality:** evaluate models, NAM and cabinet IR support, reliable generation and refinement.
5. **Realtime playing:** audio interface input, smoothing, meters, and device lifecycle testing.

Later work adds audio analysis, candidate search, reference matching, preferences, plugin hosting, and optional research. Each checkpoint must remain runnable and be committed before review. See [architecture](docs/architecture.md), [development workflow](docs/development.md), and [checkpoint log](docs/checkpoints.md).

## Privacy

Core generation and audio preview run locally. Optional model inference must use an explicitly selected local provider. Audio recordings are not uploaded. Network research is a later, opt-in capability.
