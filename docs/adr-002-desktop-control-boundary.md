# ADR 002: Desktop shell and native control boundary

Status: accepted for checkpoint 003.

## Scope

Turn the working tone-agent workbench into a local macOS desktop application. Prove real device discovery, cross-language rig validation, native file saving, and packaged local inference before adding native rendering or live audio.

## Decision

Use Tauri 2 for the window and trusted native commands. Bundle a C++/JUCE control helper as an external binary. The helper receives one bounded, versioned JSON-line request and returns one correlated JSON-line response. Each invocation is isolated and has a deadline. The current checkpoint has no realtime callback or active DSP graph.

The helper implements `get_engine_info`, `get_audio_devices`, and `validate_tone_spec`. Device discovery scans actual system device names without opening an input stream. Rig validation mirrors schema version 1, supported models, finite parameter ranges, identifiers, and bypass flags. A validation acknowledgement means the rig is structurally valid, not that it has been loaded into a running audio engine.

The desktop Rust commands own sidecar execution, fixed-loopback Ollama transport, and user-selected save dialogs. The frontend cannot provide executable paths, arbitrary filesystem destinations, or network endpoints. Browser development retains its existing local harness and validated TypeScript contracts.

## Protocol

Requests carry `protocolVersion: 1`, a `requestId`, and a supported command. A tone is required only for rig validation. Responses echo the version and request ID and contain either a discriminated result or an error code/message. Limits and mismatched responses fail visibly. The UI retains its canonical ToneSpec on failures.

## Packaging and dependencies

Pin JUCE 8.0.14 in CMake. Use Tauri 2, its shell/dialog plugins on the Rust side, and the frontend API package. Development needs a C++ toolchain, CMake, Rust, Node.js, and npm. The generated macOS application includes its frontend and helper executable; users of that local build do not need those toolchains.

The build script copies the helper with the architecture suffix expected by Tauri. The repository excludes compiled binaries and dependency source trees. Model weights remain optional and are not downloaded automatically.

## Consequences

This creates a testable native boundary without claiming realtime audio stability. Subsequent work adds offline native DSP rendering behind the protocol, then a long-lived control process and realtime-safe graph updates. Browser audition quality does not establish native engine quality or device latency.

The first app bundle is a development build. Signing, notarization, distributable installers, and product licensing remain release work. Preserve the JUCE source license and choose compatible distribution terms before shipping externally.

## Sources

- [Tauri external binary packaging and architecture naming](https://v2.tauri.app/develop/sidecar/)
- [Tauri native save dialogs](https://v2.tauri.app/plugin/dialog/)
- [JUCE releases](https://github.com/juce-framework/JUCE/releases)
- [Pinned JUCE source license](https://github.com/juce-framework/JUCE/blob/8.0.14/LICENSE.md)
