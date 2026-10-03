# Third-party dependencies

Toney uses React, Vite, TypeScript, Vitest, ESLint, Tauri, and Rust crates recorded in the npm and Cargo lockfiles. Their upstream licenses continue to apply.

## JUCE 8.0.14

The native helper uses the official [JUCE source](https://github.com/juce-framework/JUCE/tree/8.0.14). Its modules are dual licensed under AGPLv3 and the commercial JUCE licence, as recorded in the pinned [upstream license](https://github.com/juce-framework/JUCE/blob/8.0.14/LICENSE.md). This repository does not declare a commercial JUCE license or settle Toney's release licensing. Preserve the upstream license and bundled dependency notices in the fetched checkout; resolve the release license and notice requirements before distribution.

The CMake build fetches source into an ignored build directory. Generated desktop bundles and helper executables are development artifacts, not repository source files or published releases.

## NeuralAmpModelerCore

Native NAM inference compiles the official [NeuralAmpModelerCore v0.3.0 source](https://github.com/sdatkinson/NeuralAmpModelerCore/tree/e5cc355746866bed85cd48ab3e92513dc8cf7a8b), pinned to immutable commit `e5cc355746866bed85cd48ab3e92513dc8cf7a8b`. Its WaveNet and LSTM code and upstream example models used by tests are covered by the repository's MIT license. The examples are engineering smoke fixtures, not curated production amp captures. Importing a separate user's `.nam` file does not grant rights to redistribute that capture; its own terms continue to apply.

MIT License

Copyright (c) 2023-2025 Steven Atkinson

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Eigen

NAM's official Eigen submodule is pinned to [`87300c93cae6a8afd9a4f8aa8d9d5c5324cf02e1`](https://gitlab.com/libeigen/eigen/-/tree/87300c93cae6a8afd9a4f8aa8d9d5c5324cf02e1). Eigen is principally licensed under the [Mozilla Public License 2.0](https://gitlab.com/libeigen/eigen/-/blob/87300c93cae6a8afd9a4f8aa8d9d5c5324cf02e1/COPYING.MPL2). Toney defines `EIGEN_MPL2_ONLY` to exclude modules that require other licenses. Preserve the full `COPYING.MPL2` license and individual upstream source copyright notices in source/dependency distributions; provide the covered source and licensing information required by MPL 2.0 when distributing executable artifacts. These fetched headers are unmodified.

## JSON for Modern C++

The pinned NAM source contains nlohmann/json 3.12.0 as a bundled single header at `Dependencies/nlohmann/json.hpp`; its exact bytes are pinned by the NAM commit above. [JSON for Modern C++](https://github.com/nlohmann/json/tree/v3.12.0) is licensed under MIT.

Copyright (c) 2013-2025 Niels Lohmann

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
