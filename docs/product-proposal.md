# Toney

## Project Summary

Toney is a downloadable, local-first desktop application that acts as an intelligent guitar tone engineer.

The core experience is:

1. The user describes a guitar tone in normal language.
2. Toney interprets the musical and perceptual intent.
3. Toney constructs a real guitar signal chain using amps, cabinets, pedals, EQ, modulation, delay, reverb, and other effects.
4. The user can see and manually edit that chain through an intuitive guitar-oriented pedalboard interface.
5. Toney can render and evaluate the resulting audio.
6. Toney can refine the tone based on:
   - its own audio analysis,
   - a reference recording,
   - and user feedback.
7. Once the user likes the rig, they can plug their guitar into an audio interface and play through it with low latency.

The long-term objective is for Toney to feel like a skilled guitar engineer sitting next to the player and dialing in a rig, not like a chatbot that outputs arbitrary knob values.

The application should eventually support third-party VST3/AU plugins, neural amp models, tone matching from reference audio, user preference learning, and optional internet research.

The project should remain local-first and inexpensive to operate. Core functionality should not require recurring cloud inference costs.

---

# Product Philosophy

Toney should follow these principles.

## 1. The AI does not sit in the realtime audio path

This is the most important architectural constraint.

The LLM may decide:

- which pedal to add,
- which amp model to use,
- how much gain to use,
- whether to cut presence,
- whether more compression is needed,
- how to modify an existing rig,

but the actual guitar signal must be processed by deterministic native DSP code.

Conceptually:

User intent → Toney Agent → ToneSpec → Native Audio Engine → Sound

NOT:

Guitar audio → LLM → Sound

The AI may take hundreds of milliseconds or seconds to think.

The audio engine must operate continuously with millisecond-level latency.

---

## 2. Toney should understand nontechnical language

The user should not need to know guitar engineering terminology.

Valid prompts include:

- "Make it darker and crunchier."
- "I want a 90s grunge sound."
- "Make it softer but keep the pick attack."
- "It sounds too sterile."
- "Give it more bite."
- "The chords are muddy."
- "I want something dreamy."
- "Make the notes sing more."
- "It feels too aggressive."
- "Give me something like the Little Wing kind of feel."
- "Give me that dark Nirvana-style crunch."
- "Huge but not washed out."
- "I want sustain without losing definition."

The system should translate perceptual descriptions into technical audio decisions.

For example:

"muddy" should NOT simply map to "reduce bass."

It should trigger reasoning about possible causes such as:

- excessive low-mid content,
- too much distortion,
- cabinet choice,
- excessive reverb,
- excessive compression,
- poor EQ interaction,
- gain staging.

Toney should analyze the current rig and determine the most plausible cause.

---

## 3. The user and Toney collaboratively edit the same rig

The user must always be able to manually adjust the rig.

If Toney sets:

Drive = 7.2

and the user manually changes it to:

Drive = 5.8

then 5.8 becomes the authoritative value.

If the user then says:

"Great, now make it wider."

Toney must operate on the manually edited rig.

There should not be separate hidden "AI state" and "UI state."

There should be one shared canonical representation of the tone.

---

## 4. Core operation should be local

Prefer:

- local LLM,
- local DSP,
- local neural amp models,
- local audio analysis,
- local database,
- local reference processing.

Optional internet functionality may be added later for:

- researching artist rigs,
- finding tone information,
- searching model libraries,
- metadata lookup,
- software updates.

Core tone generation should still work offline.

---

# Major System Architecture

Toney should consist of several clearly separated systems.

## Desktop UI

Recommended stack:

- React
- TypeScript
- Tauri

Responsibilities:

- tone prompt input,
- conversational refinement,
- visual pedalboard,
- amp/cab display,
- pedal controls,
- drag-and-drop chain editing,
- manual knobs,
- bypass controls,
- input/output meters,
- audio device selection,
- A/B comparison,
- tone history,
- preset management,
- reference audio selection,
- waveform/region selection,
- settings.

The UI should feel like premium guitar software rather than a developer tool.

Avoid generic forms full of sliders.

Prefer pedals, amp panels, signal flow, knobs, meters, tactile controls, and visually understandable routing.

---

# Toney Agent

The Tone Agent is responsible for understanding the user and making high-level tone-engineering decisions.

Recommended initial local inference architecture:

- llama.cpp
- a strong open-source instruct/tool-use model in approximately the 4B–9B range
- start with Qwen3.5-class models or another current strong local model
- quantized GGUF where appropriate
- Metal acceleration on Apple Silicon where available

Do not tightly couple the architecture to a single LLM.

Create a provider abstraction such as:

LLMProvider

with potential implementations:

- LlamaCppProvider
- OllamaProvider
- FutureCloudProvider

The rest of the application should not care which model is being used.

---

# Tone Intent

The LLM should NOT directly generate plugin-specific parameter calls as the primary representation.

The first major transformation should be:

Natural language → ToneIntent

ToneIntent represents what the user wants perceptually and musically.

Example conceptual structure:

{
  "character": {
    "brightness": 0.35,
    "warmth": 0.72,
    "aggression": 0.68,
    "clarity": 0.52,
    "sustain": 0.66,
    "width": 0.20
  },

  "distortion": {
    "amount": 0.62,
    "texture": "gritty"
  },

  "dynamics": {
    "compression": 0.45,
    "transient_preservation": 0.68
  },

  "space": {
    "reverb": 0.12,
    "delay": 0.04
  },

  "references": [
    {
      "artist": "Nirvana",
      "style": "grunge"
    }
  ]
}

Exact schema may evolve.

Do not overfit the schema prematurely.

The important point is to create a semantic intermediate layer between language and DSP.

---

# ToneSpec

ToneSpec is the canonical executable representation of a guitar rig.

Everything in Toney should eventually operate around ToneSpec.

ToneSpec should describe:

- ordered signal-chain nodes,
- effect types,
- model identifiers,
- parameters,
- bypass states,
- routing,
- metadata,
- generation history.

Conceptual example:

{
  "id": "...",

  "chain": [
    {
      "id": "gate1",
      "type": "noise_gate",
      "model": "builtin",
      "enabled": true,
      "parameters": {
        "threshold_db": -52
      }
    },

    {
      "id": "drive1",
      "type": "drive",
      "model": "rat_like",
      "enabled": true,
      "parameters": {
        "drive": 0.52,
        "tone": 0.38,
        "level": 0.71
      }
    },

    {
      "id": "amp1",
      "type": "amp",
      "model": "nam://model_id",
      "enabled": true,
      "parameters": {
        "input_gain": 0.61
      }
    },

    {
      "id": "cab1",
      "type": "cab",
      "model": "ir://cab_id",
      "enabled": true,
      "parameters": {}
    },

    {
      "id": "eq1",
      "type": "eq",
      "model": "builtin_parametric",
      "parameters": {
        "presence_db": -2.4
      }
    },

    {
      "id": "room1",
      "type": "reverb",
      "model": "builtin_room",
      "parameters": {
        "mix": 0.09,
        "decay": 0.27
      }
    }
  ]
}

ToneSpec is effectively Toney's DSP intermediate representation.

Use it as the bridge between:

- AI,
- UI,
- presets,
- realtime engine,
- offline rendering,
- history,
- A/B comparisons.

---

# Tone Compiler

Create a component whose job is approximately:

ToneIntent + available gear + current rig → ToneSpec

The agent should reason about musical intent and available capabilities.

For example:

Input:

"Dark crunchy grunge tone, fairly dry, chords should still have definition."

Possible interpretation:

- medium-high distortion,
- gritty rather than smooth distortion,
- controlled top end,
- modest compression,
- restrained ambience,
- reasonably strong mids,
- avoid excessive gain that destroys chord separation.

The Tone Compiler should then choose an appropriate chain.

Do not bake every decision into the LLM.

Over time, some tone-engineering rules should live in deterministic code and domain knowledge.

---

# Tone Knowledge / Skills

Create reusable guitar-domain knowledge for the agent.

Examples:

skills/
  fix-harsh-tone/
  fix-muddy-tone/
  increase-sustain/
  preserve-pick-attack/
  build-clean-tone/
  build-edge-of-breakup-tone/
  build-high-gain-tone/
  build-ambient-tone/
  grunge/
  blues/
  shoegaze/

A skill might describe a procedure.

Example:

fix-muddy-tone:

1. Inspect low-mid spectral energy.
2. Inspect gain level.
3. Inspect cabinet response.
4. Inspect reverb buildup.
5. Inspect compression.
6. Prefer identifying the cause instead of blindly removing bass.
7. Make one major change at a time.
8. Render again.
9. Compare against previous output.

These skills should be usable by the Tone Agent.

Keep skills simple and editable.

---

# Agent Tools

The Tone Agent should eventually interact with the system through explicit tools.

Examples:

list_available_effects()

list_available_amps()

list_available_cabs()

inspect_effect(effect_id)

inspect_plugin(plugin_id)

create_chain()

add_effect()

remove_effect()

move_effect()

set_parameter()

bypass_effect()

render_reference_clip()

analyze_audio()

compare_candidates()

compare_to_reference()

save_tone()

load_tone()

search_tone_knowledge()

search_external_tone_information()

The agent should not directly mutate random application state.

Prefer explicit typed operations.

---

# Native Realtime Audio Engine

Realtime audio is a core product requirement.

Recommended stack:

- C++
- JUCE

Responsibilities:

- audio device enumeration,
- audio interface input,
- audio output,
- sample-rate management,
- buffer-size management,
- realtime DSP graph,
- pedal DSP,
- amp processing,
- cabinet IR convolution,
- parameter smoothing,
- plugin hosting,
- NAM inference,
- metering,
- bypass,
- realtime-safe state updates.

The audio engine should run independently from the LLM.

The audio callback must:

- never block,
- never call an LLM,
- never perform network requests,
- never perform database operations,
- avoid heap allocations where possible,
- avoid mutex contention where possible,
- avoid logging on the realtime thread.

The realtime thread should be treated as the most important thread in the application.

If AI work is expensive, slow down the AI.

Never sacrifice audio stability for agent responsiveness.

---

# Audio Targets

Support at least:

- 44.1 kHz
- 48 kHz

Later:

- 88.2 kHz
- 96 kHz

Use 32-bit floating-point processing internally unless there is a strong reason otherwise.

Allow configurable audio buffer sizes.

Typical options:

- 32
- 64
- 128
- 256
- 512 samples

Target a user experience where a capable audio interface at a reasonable buffer size feels effectively immediate.

Do not promise a fixed latency because actual latency depends on:

- hardware,
- audio interface,
- drivers,
- sample rate,
- buffer size,
- DSP graph,
- plugins.

Expose estimated or measured round-trip latency in the UI when possible.

---

# Parameter Smoothing

When Toney modifies a parameter while audio is running, avoid discontinuous jumps.

Example:

presence:

0.63 → 0.47

should be ramped smoothly.

This avoids:

- clicks,
- pops,
- zipper noise.

The UI can update immediately while the DSP engine interpolates the actual value over a short period.

---

# Built-In Effects

Do not attempt to build every possible guitar effect initially.

Start with a minimal useful palette.

Suggested early effects:

- input gain,
- noise gate,
- compressor,
- overdrive/distortion,
- EQ,
- amplifier,
- cabinet IR,
- chorus,
- delay,
- reverb.

The first goal is not to compete with every commercial plugin.

The first goal is to create enough expressive range for the Tone Agent to produce convincing tones.

---

# Amp Modeling

Use Neural Amp Modeler-compatible models where practical.

Do not attempt to implement realistic tube amp simulation from first principles in the first version.

Treat neural amp models as one possible node in ToneSpec.

Example:

{
  "type": "amp",
  "engine": "nam",
  "model": "path/to/model.nam"
}

Build abstractions so amp engines can evolve later.

Possible future engines:

- NAM
- AIDA-X-compatible models
- custom amp DSP
- third-party VST amp simulator

---

# Cabinet Modeling

Use impulse-response convolution.

ToneSpec should allow:

- cabinet IR selection,
- bypass,
- mix,
- future microphone/cab metadata.

Ensure the IR processing is realtime-safe.

---

# Third-Party Plugin Support

Later support:

- VST3
- Audio Units on macOS

Toney should eventually be able to scan installed plugins and expose their parameters to the agent.

Conceptually:

Installed plugin:
AwesomeDelay.vst3

Discovered parameters:

- delay_time
- feedback
- mix
- modulation_depth
- modulation_rate
- filter
- stereo_width

The agent can then manipulate the plugin through a generic parameter schema.

The long-term goal is:

Toney can intelligently operate plugins it was never explicitly programmed for.

Do NOT prioritize this before built-in signal-chain generation works reliably.

Plugin hosting and plugin isolation can become substantial engineering projects.

Potential future architecture:

Main audio engine
  → isolated plugin host process
  → third-party VST

so a broken plugin does not kill Toney.

---

# Desktop Application

Use Tauri rather than building the product as a website.

Primary target initially:

macOS

Then later:

Windows

The application should eventually install like normal desktop software.

Example:

Toney.dmg
→ drag to Applications
→ Toney.app

Do not require the user to install:

- Python,
- Node,
- JUCE,
- llama.cpp,
- development dependencies.

Development architecture may contain multiple runtimes, but release packaging should hide this complexity.

---

# Process Architecture

Prefer separation between major responsibilities.

Conceptually:

Process 1:
Toney Desktop UI
- Tauri
- React
- TypeScript

Process 2:
Toney Core
- agent
- local LLM
- tone compiler
- optimizer
- reference analysis
- database
- knowledge
- optional web research

Process 3:
Realtime Audio Engine
- C++
- JUCE
- audio I/O
- DSP
- NAM
- plugin hosting

Communication should use explicit IPC/message schemas.

Avoid tightly coupling arbitrary modules across processes.

---

# Tone Generation Flow

The primary workflow should eventually look like:

User description
→ Tone Agent
→ ToneIntent
→ Tone Compiler
→ candidate ToneSpec
→ audio render
→ audio analysis
→ refine ToneSpec
→ return final ToneSpec
→ realtime playback

For the first implementation, not every stage needs to exist.

Build vertical slices progressively.

---

# Self-Listening / Closed Loop

A major feature is that Toney should evaluate its own output instead of making a single blind guess.

Maintain a clean DI reference clip.

Whenever Toney wants to test a candidate rig:

Clean DI
→ candidate ToneSpec
→ offline render
→ analysis
→ score
→ refine

The exact same input should be used when comparing candidate rigs.

This reduces variation caused by performance differences.

---

# Audio Analysis

Initial deterministic analysis should include useful measurable properties such as:

- RMS,
- peak level,
- crest factor,
- dynamic range,
- spectral centroid,
- spectral rolloff,
- spectral bandwidth,
- low-frequency energy,
- low-mid energy,
- mid energy,
- upper-mid energy,
- high-frequency energy,
- sustain characteristics,
- attack envelope,
- decay envelope.

Use these as evidence.

Examples:

"too bright"
may correspond to increased spectral centroid / high-frequency energy.

"too compressed"
may correspond to reduced crest factor and reduced dynamic range.

"needs more sustain"
may correspond to envelope decay behavior.

Do not pretend these measurements perfectly capture subjective tone.

Use them as signals.

---

# Audio-Language Embeddings

Later, integrate an audio-language model such as CLAP or another current open model.

Concept:

text:
"dark crunchy grunge guitar"

→ embedding A

rendered audio:
candidate.wav

→ embedding B

→ semantic similarity

Do not treat CLAP similarity as objective truth.

Use it as one component of a broader evaluation function.

---

# Candidate Search / Optimization

Eventually, Toney should generate multiple candidate rigs instead of betting everything on one set of settings.

Example:

Prompt:
"Warm edge-of-breakup tone with strong attack."

Candidate A
Candidate B
Candidate C
Candidate D

Render each candidate with the same DI.

Analyze each.

Score.

Keep promising candidates.

Mutate parameters.

Repeat for a limited number of generations.

Potential optimization strategies:

- random search,
- guided random search,
- evolutionary optimization,
- Bayesian optimization,
- gradient-free parameter optimization.

Start simple.

Do not introduce an elaborate optimizer until audio generation and scoring work.

---

# Tone Score

Eventually combine multiple signals.

Conceptually:

ToneScore =
semantic similarity
+ DSP feature alignment
+ reference similarity
+ user preference
+ explicit user feedback

Do not hard-code arbitrary weights permanently.

Treat the scoring system as something to evaluate experimentally.

---

# User Feedback Loop

Human judgment remains authoritative.

Example:

Toney generates Rig A.

User says:

"Almost, but too fuzzy and I'm losing chord definition."

Toney should interpret that feedback in the context of:

- current ToneSpec,
- current audio analysis,
- previous ToneIntent,
- previous user edits.

Then create a refined ToneSpec.

Maintain version history.

Example:

Tone v1
→ too bright

Tone v2
→ better but too compressed

Tone v3
→ almost perfect

Tone v4
→ saved

Allow quick A/B comparison between versions.

---

# Preference Learning

Later, store user preference data locally.

Examples:

The user repeatedly asks for:

- less brightness,
- moderate compression,
- lower presence,
- plate reverb,
- less extreme gain,
- stronger mids.

This should gradually influence future generations.

Do not implement a complicated recommendation model initially.

Start with simple preference statistics and history.

Store locally in SQLite.

The user should be able to reset preference history.

---

# Reference Audio

Users should eventually be able to:

1. import an audio file,
2. select a region,
3. tell Toney something like:
   "I want the guitar sound here,"
4. have Toney attempt to recreate that tone.

Supported first:

- WAV
- AIFF
- FLAC
- common imported audio formats if decoding libraries allow

The initial reference-audio workflow should be based on user-supplied files.

---

# Source Separation

Full songs contain:

- vocals,
- guitar,
- drums,
- bass,
- keyboards,
- effects,
- mastering.

Toney cannot directly compare a complete mastered song to a dry guitar signal.

Use a source-separation model such as Demucs or another current high-quality open model to attempt guitar extraction.

Workflow:

song
→ source separation
→ guitar stem
→ analyze guitar stem
→ derive reference target
→ optimize user's guitar rig toward target

Source separation will not be perfect.

The UI should communicate uncertainty rather than pretending isolation is exact.

---

# Reference + Language

Reference audio should be combinable with natural language.

Example:

"I want this sound, but warmer and less distorted."

Inputs:

reference tone
+
text modifier

Output:

modified target ToneIntent

This is an important long-term UX goal.

---

# Streaming-Service Integration

Treat streaming integrations as optional later work.

Do not make Spotify or another provider foundational to the architecture.

Create an abstraction such as:

ReferenceSource

with possible implementations:

- LocalFileReferenceSource
- RecordedClipReferenceSource
- StreamingMetadataReferenceSource
- FutureLicensedAudioReferenceSource

For streaming services, respect platform rules around:

- DRM,
- raw audio access,
- content analysis,
- AI ingestion,
- playback modification.

Do not assume Toney can obtain raw PCM audio from a streaming provider.

Streaming integration can still be useful for:

- song search,
- playback control,
- timestamps,
- artist/title metadata,
- research context.

---

# Optional Internet Research

Toney may later use web research when a user references:

- a specific song,
- an artist,
- a recording,
- a known guitarist,
- a famous rig.

Example:

User:
"Give me the guitar tone from the verse of X."

Toney may research:

- guitarist equipment,
- amp used,
- known pedal chain,
- studio setup,
- pickup type,
- known interviews,
- credible gear references.

This should supplement—not replace—audio reasoning.

Architecture:

local interpretation
→ determine whether knowledge is sufficient
→ optionally research
→ incorporate evidence
→ generate rig

Internet access should be optional.

---

# UX Principles

The interface should feel guitar-first.

Avoid making chat the entire application.

Chat should be one control surface among several.

Primary UI should contain:

- current signal chain,
- pedalboard,
- amp/cab,
- input/output status,
- audio device,
- latency information,
- saved tones,
- A/B controls.

Possible main layout:

Left:
Toney conversation

Center:
visual signal chain

Bottom:
audio meters / interface / latency

Right or expandable:
detailed pedal controls

---

# Pedal UI

Effects should look and behave like familiar guitar gear.

A pedal can contain:

- name,
- enabled LED,
- bypass switch,
- physical-style knobs,
- model/type,
- optional advanced controls.

The user should be able to:

- turn knobs,
- bypass,
- reorder,
- delete,
- add,
- duplicate where appropriate.

Changes must update ToneSpec immediately.

---

# Toney Personality

Toney should have a subtle guitar-engineer personality.

Good:

"I pulled some presence out and backed off the drive a little. Chords should stay clearer now."

Bad:

"Tone generation completed successfully."

Avoid excessive anthropomorphism or chatter.

Toney should be concise while still explaining meaningful tone changes.

---

# Persistence

Use SQLite initially.

Store:

- tones,
- ToneSpecs,
- tone versions,
- user preferences,
- locally discovered plugins,
- favorite tones,
- recent projects,
- analysis metadata.

Do not create a cloud account system initially.

---

# File Structure

Use a monorepo-style layout.

Suggested starting point:

toney/

  apps/
    desktop/
      src/
      src-tauri/

  engine/
    audio/
      CMakeLists.txt
      src/
      include/

  core/
    agent/
    tone/
    analysis/
    reference/
    storage/

  models/
    README.md

  knowledge/
    tone/
    genres/
    effects/
    skills/

  assets/
    icons/
    demo-audio/

  tests/

  docs/

  README.md

The exact layout may evolve.

Favor clear subsystem boundaries over premature abstraction.

---

# Coding Standards

General:

- keep code readable,
- prefer typed interfaces,
- avoid hidden global state,
- write tests for important deterministic logic,
- isolate experimental ML code from stable production code,
- document architecture decisions,
- avoid giant files,
- avoid unnecessary frameworks,
- avoid implementing speculative abstractions with no current use.

TypeScript:

- strict mode,
- avoid `any`,
- use schemas/types for IPC.

C++:

- modern C++,
- RAII,
- realtime-safety considerations documented,
- isolate JUCE-specific code from core domain representations where practical.

Python, if used during experimentation:

- typed where reasonable,
- do not make production packaging depend on Python unless explicitly chosen later.

---

# IPC

Define explicit versionable messages.

Examples:

SetToneSpec

SetParameter

GetAudioDevices

SetAudioDevice

SetBufferSize

SetSampleRate

StartAudio

StopAudio

GetMeters

RenderOffline

LoadNAMModel

ScanPlugins

Avoid passing arbitrary JSON blobs everywhere.

Use typed contracts.

---

# Failure Isolation

Design for future robustness.

Possible failure domains:

- local LLM crash,
- model-loading failure,
- malformed plugin,
- source-separation OOM,
- unsupported audio device,
- audio-device disconnection,
- missing NAM model,
- missing IR,
- corrupted preset.

A failure in the AI subsystem should not corrupt saved ToneSpecs.

A background analysis process should not destabilize realtime playback.

---

# Security / Privacy

Default:

- prompts stay local,
- user audio stays local,
- tones stay local.

Internet research should clearly indicate when network access is used.

Do not silently upload user guitar recordings.

---

# Performance Priorities

Priority order during live playback:

1. realtime audio thread
2. audio control / device management
3. UI responsiveness
4. agent inference
5. audio analysis
6. background optimization
7. internet research

If necessary, suspend expensive background analysis during realtime playback.

---

# Development Plan

DO NOT attempt to build the entire final product immediately.

Build vertical slices.

---

# Phase 0 — Repository Foundation

Goal:

Create a clean repository with:

- Tauri desktop application,
- React/TypeScript UI,
- C++ JUCE audio-engine skeleton,
- IPC layer,
- basic tests,
- documentation.

Acceptance:

- desktop window opens,
- UI can communicate with native backend,
- audio devices can be enumerated,
- architecture is documented.

---

# Phase 1 — Manual Audio Rig

NO AI.

Goal:

Prove Toney can sound good before adding intelligence.

Implement:

- audio file import,
- clean DI playback,
- offline processing,
- basic signal chain,
- manual controls,
- pedalboard UI.

Start with:

- input gain,
- compressor,
- distortion/overdrive,
- EQ,
- delay,
- reverb.

Then add:

- NAM amp,
- cabinet IR.

Acceptance:

User can:

1. import clean guitar DI,
2. manually construct/edit a chain,
3. render or preview it,
4. hear high-quality processed audio,
5. save ToneSpec,
6. reload ToneSpec.

This phase is essential.

Do not start Phase 2 until this works reliably.

---

# Phase 2 — ToneSpec and Tone Compiler

Formalize:

- ToneIntent,
- ToneSpec,
- effect schemas,
- parameter ranges,
- validation,
- serialization.

Implement deterministic helpers for:

- creating a chain,
- changing parameters,
- validation,
- versioning.

Acceptance:

Any valid ToneSpec can:

- be serialized,
- loaded,
- displayed in UI,
- executed by audio engine.

---

# Phase 3 — Local Tone Agent

Integrate local LLM.

Goal:

Prompt:

"Warm crunchy blues tone with good sustain."

Produces:

ToneIntent
→ ToneSpec

Do not allow unrestricted LLM output.

Use structured output validation.

Acceptance:

Several example prompts create materially different and sensible chains.

Example prompts:

- warm edge-of-breakup blues,
- dark 90s grunge,
- bright clean funk,
- dreamy ambient clean,
- saturated singing lead.

---

# Phase 4 — Conversational Refinement

Implement follow-up modifications.

Examples:

"less gain"

"make it darker"

"more spacious"

"too muddy"

"more attack"

The agent must modify the current ToneSpec rather than regenerate unrelated rigs.

Manual edits must remain authoritative.

Add tone version history.

Acceptance:

User can:

1. generate tone,
2. manually edit it,
3. request another change,
4. Toney modifies the manually edited version.

---

# Phase 5 — Realtime Guitar Input

Implement:

- audio interface input,
- audio interface output,
- sample-rate configuration,
- buffer-size configuration,
- realtime signal chain,
- parameter smoothing,
- meters.

Acceptance:

User can connect a guitar through an audio interface and play through current ToneSpec with stable low-latency audio.

Do extensive testing for:

- dropouts,
- clicks,
- parameter changes,
- device switching.

---

# Phase 6 — Audio Analysis

Add deterministic audio analysis.

Use fixed DI clips for comparison.

Acceptance:

Toney can quantify properties such as:

- brightness,
- spectral balance,
- crest factor,
- dynamic range,
- attack,
- sustain.

Expose analysis internally.

Do not overexpose technical numbers to normal users.

---

# Phase 7 — Closed-Loop Tone Search

Implement candidate generation and scoring.

Initial simple algorithm:

1. create N candidate ToneSpecs,
2. render same DI,
3. analyze,
4. score against ToneIntent,
5. keep top candidates,
6. perturb selected parameters,
7. repeat a small number of iterations.

Start simple.

Acceptance:

Closed-loop refinement should improve a meaningful set of test prompts compared with one-shot generation.

Create an evaluation harness.

---

# Phase 8 — Audio-Language Model

Integrate CLAP or another suitable open model.

Use text/audio similarity as an additional signal.

Do not replace deterministic analysis.

Evaluate whether it improves results.

If not, remove or reduce its role.

---

# Phase 9 — Reference Audio

Implement:

- import song/audio,
- waveform display,
- region selection,
- source separation,
- guitar stem analysis,
- reference target extraction,
- tone matching.

Acceptance:

User can select a guitar segment from a local audio file and Toney can attempt to approximate its tone.

---

# Phase 10 — Preference Learning

Track:

- saved tones,
- rejected tones,
- A/B decisions,
- repeated corrections.

Use lightweight local preference learning first.

Acceptance:

Repeated user preferences subtly affect new tone generation.

Provide reset controls.

---

# Phase 11 — Third-Party Plugin Control

Implement plugin scanning and generic plugin parameter introspection.

Then allow Toney to use third-party effects.

Do not assume every plugin behaves correctly.

Add isolation later if necessary.

---

# Phase 12 — Optional Internet Research

Add internet research only after local tone generation is strong.

Use it when references would benefit from external context.

Never make web access mandatory.

---

# Important Non-Goals for Early Versions

Do NOT initially:

- build cloud accounts,
- build social sharing,
- build a marketplace,
- support every DAW,
- create a VST version of Toney itself,
- support every OS,
- implement custom neural amp training,
- recreate commercial amp models from scratch,
- build every pedal,
- add Spotify raw audio analysis,
- write a giant multi-agent framework,
- optimize prematurely,
- train a custom foundation model.

Focus on the core magic:

User language
→ good rig
→ good audio
→ iterative improvement
→ realtime playing.

---

# Development Philosophy for Codex

When implementing this repository:

1. Inspect existing architecture before editing.
2. Do not rewrite working systems unnecessarily.
3. Prefer incremental, testable changes.
4. Run relevant tests after modifications.
5. Run lint/typecheck/build before considering a task complete.
6. Keep architecture documentation up to date.
7. Do not add dependencies casually.
8. Explain major architectural decisions in ADRs or docs.
9. Do not silently change public schemas.
10. Preserve realtime safety in audio code.
11. Do not mix experimental code directly into the stable audio path.
12. Avoid placeholder implementations presented as complete functionality.
13. When functionality is mocked, label it clearly.
14. Prefer working vertical slices over broad scaffolding.
15. Keep the application runnable after each major milestone.

---

# First Concrete Objective

Begin with Phase 0 and Phase 1 only.

The initial milestone is NOT "build the AI agent."

The initial milestone is:

A beautiful desktop Toney application where the user can import a clean DI guitar recording, construct and edit a real signal chain visually, process the recording through that signal chain, hear the output, and save/load the resulting ToneSpec.

Architecture must already leave clean extension points for:

- the Tone Agent,
- local LLM,
- realtime guitar input,
- NAM,
- audio analysis,
- reference matching,
- optimization,
- plugin hosting.

But do not implement all of those before the basic audio product works.

Before writing significant code:

1. inspect the repository,
2. propose the concrete Phase 0/1 architecture,
3. identify dependencies,
4. identify any risky technical assumptions,
5. write/update architecture documentation,
6. then implement incrementally.

When choosing between a clever abstraction and a simple implementation that clearly supports the next few milestones, choose the simple implementation.

The goal is to build Toney into a serious, high-quality guitar product—not a demo whose architecture collapses once realtime audio and AI are added.