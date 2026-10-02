# Tone engineering procedures

The first checkpoint uses the procedures below in `core/tone/compiler.ts` and the stylistic cues in `core/agent/interpreter.ts`. These are deterministic heuristics, not audio measurements. Revisions to these procedures must be accompanied by compiler changes and tests.

## Fix a muddy rig

Inspect the enabled chain and make one major change per request:

1. If reverb mix exceeds 0.35, reduce it by 0.16 to limit room buildup.
2. Otherwise, if drive gain exceeds 0.65, reduce it by 0.13 for chord separation.
3. Otherwise, if compression exceeds 0.65, reduce it by 0.15.
4. Otherwise, reduce low EQ by 2 dB.

These checks identify plausible causes in the current rig. They do not assert that spectral energy was measured. Bypassed effects are ignored when choosing the cause. Audition after the change and refine again if needed.

## Control harshness

Lower drive tone, amp treble, cabinet brightness, and high EQ together; add modest warmth. This changes the requested brightness and warmth dimensions while preserving unrelated manual values and bypass states.

## Preserve pick attack

Favor a slower compressor attack control and moderate compression. A request to “keep” attack during refinement protects the current settings. Sustain can increase compression while pick preservation stays authoritative.

## Build clear distorted chords

Control gain on newly generated rigs, avoid excessive low EQ, and keep ambience restrained when requested. During refinement, touch only requested dimensions; a width change does not regenerate gain or level settings.

## Styles and references

Offline styles include grunge, blues, funk, ambient/shoegaze, and metal. Nirvana, Hendrix, and Little Wing are broad style associations. They do not identify actual recording equipment, match reference audio, or verify a recorded rig.
