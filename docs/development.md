# Development workflow

Work in short vertical slices: describe acceptance criteria, implement, test meaningful behavior, inspect the interactive result, fix failures, record evidence, and commit. Pause at a user-testable checkpoint.

## Required checks

Before marking an implementation checkpoint complete, run lint, typecheck, tests, and the production build. Check the workbench manually in a browser. Record commands and outcomes in `docs/checkpoints.md`. Regression tests must cover behavior and failure boundaries rather than duplicate implementation.

```sh
npm run check
```

The GitHub Actions workflow runs the same checks on pull requests and pushes to main. The workflow is committed locally; its first hosted run occurs after the repository is pushed.

For browser review, run `npm run dev` and open `http://127.0.0.1:5173`. Check a full desktop viewport and the narrow development side panel. Exercise generation, manual-edit/refinement preservation, playback, export/import, and a failed model request. Review audio using the same DI source. No audio quality claim should be based only on synthetic demo output.

## Commit discipline

Commit documentation first, then cohesive implementation steps, then verification/repairs. Keep the working tree understandable. Do not commit dependencies, model weights, recordings, generated builds, or private traces. Push only when requested.

## Error traceability

Agent results and failures carry trace IDs and stage events. Error messages show actionable context without replacing the current rig. Reproduction reports should include the trace export, prompt, current ToneSpec, selected provider, browser/runtime, and observed behavior. Imported presets are untrusted input and must be validated.

## Review discipline

Clearly distinguish working capabilities, experimental approximations, and future work. Keep schema changes versioned. Manual controls own authoritative rig values. Preserve audio-engine isolation when adding inference. Update architecture decisions when a boundary changes.

## Desktop checks

```sh
npm run native:build
npm run desktop:check
npm run check
npm run desktop:build
```

CMake may be selected with `CMAKE`; an existing JUCE 8.0.14 checkout with `JUCE_PATH`. The native README documents the SDK headers workaround observed on the development machine. Build outputs, fetched dependencies, target-specific helper binaries, and generated Tauri files are ignored.

The macOS CI job builds the real helper before testing language/catalog agreement and building the desktop bundle. Device counts are not CI assertions: headless systems may have no devices. Tests never open audio streams. Hosted CI execution remains unverified until pushed.

For interactive acceptance, open the bundled app, generate/refine a rig, refresh devices, validate it, then change a control and check the stale-validation notice. Export and re-import a preset using the native dialog, render/play/export a WAV, and try local Ollama with Vite stopped. Confirm failures preserve the rig and appear in Diagnostics. Record any unverified checks explicitly; a successful bundle build does not prove GUI behavior.

For a native audition without controlling the desktop GUI, `npm run native:audition` writes repeatable dry/bypass/crunch/spacious WAVs and matching presets to an ignored build folder and prints their absolute paths. An optional JSON preset argument adds a render of that rig. `tests/native-render.test.ts` invokes the real helper with generated mono/stereo PCM fixtures and inspects actual output WAVs; these tests skip only in the web-only CI job where the helper is absent.
