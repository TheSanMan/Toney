# ADR 007 — Explicit live guitar monitoring

Status: accepted for implementation, 2026-10-03.

## Scope

The desktop workbench opens a selected audio interface only after **Start live guitar**. One chosen mono guitar channel runs through the current builtin or NAM pedal → amp → cabinet chain, including EQ, chorus, delay and reverb. The processed mono signal feeds the first two output channels. Input is never recorded or sent to the agent.

The UI provides input/output device selection, input channel, sample rate, buffer size, input/output trims, meters, actual device latency estimates, callback performance and explicit Stop. Default output trim is −12 dB. **Apply current rig** prepares and switches a new graph; edits and agent work preserve the playing graph until applied. Device configuration changes require stopping first.

## Boundaries

- The existing single-request helper remains available for offline rendering and discovery. A private `--live` mode accepts bounded, correlated newline JSON commands and owns the audio device until Stop, EOF or process termination.
- Rust serializes session control, stages local assets privately, bounds requests/replies and kills the child on app exit or transport failure. The browser cannot supply local asset paths or start the private helper directly.
- The control thread validates the complete rig and loads/prepares models, filters, delay lines and convolution before publishing a graph. The callback processes bounded blocks with persistent state, fixed buffers and no logging, JSON, files, model inference requests or graph destruction.
- Graph ownership stays on the control thread. A short crossfade joins old/new graphs; the old graph is reclaimed only after callback acknowledgment. A failed update preserves the running graph.
- Live NAM requires the device rate to match every enabled capture's training rate. This first slice rejects incompatible rates rather than changing the learned circuit's timing. Offline resampling remains available for audition files.
- Output is attenuation-trimmed and bounded; invalid numeric DSP output silences the stream and reports a correlated fault. Device loss or configuration changes stop monitoring and require an explicit restart.

## Verification and acceptance

Headless tests cover persistent DSP across block boundaries, NAM pedal/amp independence, cabinet IR, allocation checks, finite bounded output, strict session contracts, asset privacy, child cleanup and reply correlation. They do not open hardware streams. Frontend/Rust/native gates and a packaged build precede the checkpoint.

Final hardware acceptance needs a guitar and interface: choose its instrument input and wired output, turn off the interface's direct monitor to hear only the processed signal, start, observe the input meter, listen, apply a change, then stop and verify input closes. Test permission denial and unplug/replug. Report actual latency, dropouts and trace IDs; synthetic timing is not a hardware latency measurement.
