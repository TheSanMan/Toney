# Third-party dependencies

Toney uses React, Vite, TypeScript, Vitest, ESLint, Tauri, and Rust crates recorded in the npm and Cargo lockfiles. Their upstream licenses continue to apply.

## JUCE 8.0.14

The native helper uses the official [JUCE source](https://github.com/juce-framework/JUCE/tree/8.0.14). Its modules are dual licensed under AGPLv3 and the commercial JUCE licence, as recorded in the pinned [upstream license](https://github.com/juce-framework/JUCE/blob/8.0.14/LICENSE.md). This repository does not declare a commercial JUCE license or settle Toney's release licensing. Preserve the upstream license and bundled dependency notices in the fetched checkout; resolve the release license and notice requirements before distribution.

The CMake build fetches source into an ignored build directory. Generated desktop bundles and helper executables are development artifacts, not repository source files or published releases.
