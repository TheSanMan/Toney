# Development workflow

Work in short vertical slices: describe acceptance criteria, implement, test meaningful behavior, inspect the interactive result, fix failures, record evidence, and commit. Pause at a user-testable checkpoint.

## Required checks

Before marking an implementation checkpoint complete, run lint, typecheck, tests, and the production build. Check the workbench manually in a browser. Record commands and outcomes in `docs/checkpoints.md`. Regression tests must cover behavior and failure boundaries rather than duplicate implementation.

## Commit discipline

Commit documentation first, then cohesive implementation steps, then verification/repairs. Keep the working tree understandable. Do not commit dependencies, model weights, recordings, generated builds, or private traces. Push only when requested.

## Error traceability

Agent results and failures carry trace IDs and stage events. Error messages show actionable context without replacing the current rig. Reproduction reports should include the trace export, prompt, current ToneSpec, selected provider, browser/runtime, and observed behavior. Imported presets are untrusted input and must be validated.

## Review discipline

Clearly distinguish working capabilities, experimental approximations, and future work. Keep schema changes versioned. Manual controls own authoritative rig values. Preserve audio-engine isolation when adding inference. Update architecture decisions when a boundary changes.
