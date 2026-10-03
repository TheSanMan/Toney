import { collectToneAssets, validateToneSpec, type ToneSpec } from '../../../../core';

/** Browser audition DSP. This is an approximation, not NAM or measured cabinet IRs. */
export const DEMO_SAMPLE_RATE = 44_100;
export const DEMO_DURATION_SECONDS = 6;

export class PreviewCapabilityError extends Error {
  readonly code = 'NATIVE_ASSETS_REQUIRED';
  constructor(readonly assetIds: string[]) {
    super('Imported IR and NAM models require native rendering. Open Toney desktop to audition this rig, or bypass the imported models.');
    this.name = 'PreviewCapabilityError';
  }
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4_294_967_296;
  };
}

/** A repeatable, dry plucked-string phrase used to compare recipes fairly. */
export function createDemoSamples(sampleRate = DEMO_SAMPLE_RATE): Float32Array {
  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
    throw new Error('Demo sample rate must be an integer between 8000 and 192000 Hz.');
  }
  const samples = new Float32Array(sampleRate * DEMO_DURATION_SECONDS);
  const noise = random(0x746f6e65);
  const notes = [40, 47, 52, 55, 40, 47, 50, 54, 43, 50, 55, 59, 45, 52, 57, 59];
  for (let noteIndex = 0; noteIndex < notes.length; noteIndex++) {
    const midi = notes[noteIndex];
    if (midi === undefined) continue;
    const frequency = 440 * 2 ** ((midi - 69) / 12);
    const start = Math.floor((0.08 + noteIndex * 0.3) * sampleRate);
    const length = Math.min(Math.floor(1.25 * sampleRate), samples.length - start);
    for (let i = 0; i < length; i++) {
      const time = i / sampleRate;
      const attack = Math.min(1, time / 0.004);
      let value = 0;
      for (let harmonic = 1; harmonic <= 10; harmonic++) {
        const phase = 2 * Math.PI * frequency * harmonic * time;
        value += Math.sin(phase + harmonic * 0.17) * Math.exp(-time * (2.8 + harmonic * 0.65)) / harmonic;
      }
      value += (noise() * 2 - 1) * Math.exp(-time * 95) * 0.12;
      const position = start + i;
      samples[position] = (samples[position] ?? 0) + value * attack * 0.23;
    }
  }
  normalizeSamples([samples], 0.42);
  return samples;
}

/** Peak control shares one gain across channels so stereo balance is preserved. */
export function normalizeSamples(channels: readonly Float32Array[], targetPeak = 0.85): number {
  if (!Number.isFinite(targetPeak) || targetPeak <= 0 || targetPeak > 1) {
    throw new Error('Target peak must be greater than zero and at most one.');
  }
  let peak = 0;
  for (const channel of channels) {
    for (const value of channel) {
      if (!Number.isFinite(value)) throw new Error('Audio contains non-finite samples.');
      peak = Math.max(peak, Math.abs(value));
    }
  }
  if (peak === 0) return 1;
  const gain = targetPeak / peak;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) channel[i] = (channel[i] ?? 0) * gain;
  }
  return gain;
}

/** Only attenuate peaks; preserve the user's drive level and amp master choices. */
export function limitSamples(channels: readonly Float32Array[], ceiling = 0.85): number {
  if (!Number.isFinite(ceiling) || ceiling <= 0 || ceiling > 1) {
    throw new Error('Peak ceiling must be greater than zero and at most one.');
  }
  let peak = 0;
  for (const channel of channels) {
    for (const value of channel) {
      if (!Number.isFinite(value)) throw new Error('Audio contains non-finite samples.');
      peak = Math.max(peak, Math.abs(value));
    }
  }
  return peak > ceiling ? normalizeSamples(channels, ceiling) : 1;
}

export function createDemoBuffer(context: BaseAudioContext): AudioBuffer {
  const samples = createDemoSamples(context.sampleRate);
  const buffer = context.createBuffer(1, samples.length, context.sampleRate);
  buffer.getChannelData(0).set(samples);
  return buffer;
}

function saturationCurve(gain: number): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(4096);
  for (let i = 0; i < curve.length; i++) {
    const x = i * 2 / (curve.length - 1) - 1;
    curve[i] = Math.tanh(x * gain) / Math.tanh(gain);
  }
  return curve;
}

function filter(context: BaseAudioContext, type: BiquadFilterType, frequency: number, gain = 0, q = 0.7): BiquadFilterNode {
  const node = context.createBiquadFilter();
  node.type = type;
  node.frequency.value = frequency;
  node.gain.value = gain;
  node.Q.value = q;
  return node;
}

function chain(input: AudioNode, ...nodes: AudioNode[]): AudioNode {
  let output = input;
  for (const node of nodes) {
    output.connect(node);
    output = node;
  }
  return output;
}

function mixed(context: BaseAudioContext, input: AudioNode, wetInput: AudioNode, wetOutput: AudioNode, mix: number): AudioNode {
  const dry = context.createGain();
  const wet = context.createGain();
  const output = context.createGain();
  dry.gain.value = 1 - mix;
  wet.gain.value = mix;
  chain(input, dry, output);
  input.connect(wetInput);
  chain(wetOutput, wet, output);
  return output;
}

/** Seeded synthetic room response; never presented as a measured cabinet IR. */
export function createReverbSamples(sampleRate: number, decay: number, seed: number): Float32Array {
  const seconds = clamp(decay, 0.2, 5);
  const samples = new Float32Array(Math.ceil(sampleRate * seconds));
  const noise = random(seed);
  for (let i = 0; i < samples.length; i++) {
    const time = i / sampleRate;
    const fadeIn = Math.min(1, time / 0.008);
    samples[i] = (noise() * 2 - 1) * Math.exp(-time * 5 / seconds) * fadeIn * 0.018 / Math.sqrt(seconds);
  }
  return samples;
}

type ToneNode = ToneSpec['chain'][number];

function processNode(context: OfflineAudioContext, input: AudioNode, node: ToneNode): AudioNode {
  const p = (name: string, fallback: number, min = 0, max = 1) => clamp(node.parameters[name] ?? fallback, min, max);
  switch (node.type) {
    case 'compressor': {
      const compressor = context.createDynamicsCompressor();
      const amount = p('amount', 0.3);
      compressor.threshold.value = -8 - amount * 28;
      compressor.ratio.value = 1 + amount * 9;
      compressor.knee.value = 14;
      compressor.attack.value = 0.002 + p('attack', 0.4) * 0.06;
      compressor.release.value = 0.16;
      const makeup = context.createGain();
      makeup.gain.value = 1 + amount * 1.4;
      return chain(input, compressor, makeup);
    }
    case 'drive': {
      const drive = context.createWaveShaper();
      drive.curve = saturationCurve(1 + p('gain', 0.4) ** 2 * 55);
      drive.oversample = '2x';
      const tone = filter(context, 'lowpass', 1400 + p('tone', 0.5) * 7200);
      const level = context.createGain();
      level.gain.value = 0.12 + p('level', 0.5) * 0.7;
      return chain(input, drive, tone, level);
    }
    case 'amp': {
      const bass = filter(context, 'lowshelf', 180, (p('bass', 0.5) - 0.5) * 20);
      const mid = filter(context, 'peaking', 850, (p('mid', 0.5) - 0.5) * 18, 0.8);
      const treble = filter(context, 'highshelf', 2600, (p('treble', 0.5) - 0.5) * 20);
      const amp = context.createWaveShaper();
      amp.curve = saturationCurve(1 + p('gain', 0.25) ** 2 * 24);
      amp.oversample = '2x';
      const master = context.createGain();
      master.gain.value = 0.1 + p('master', 0.5) * 0.6;
      return chain(input, bass, mid, treble, amp, master);
    }
    case 'cab':
      return chain(input, filter(context, 'highpass', 75), filter(context, 'peaking', 145, p('resonance', 0.4) * 5, 1.1), filter(context, 'lowpass', 2000 + p('brightness', 0.5) * 4500, 0, 0.65));
    case 'eq':
      return chain(input, filter(context, 'lowshelf', 200, p('lowDb', 0, -12, 12)), filter(context, 'peaking', 1000, p('midDb', 0, -12, 12)), filter(context, 'highshelf', 3200, p('highDb', 0, -12, 12)));
    case 'chorus': {
      const delay = context.createDelay(0.1);
      delay.delayTime.value = 0.018;
      const oscillator = context.createOscillator();
      oscillator.frequency.value = p('rate', 0.8, 0.1, 5);
      const depth = context.createGain();
      depth.gain.value = p('depth', 0.4) * 0.007;
      oscillator.connect(depth);
      depth.connect(delay.delayTime);
      oscillator.start();
      return mixed(context, input, delay, delay, p('mix', 0.3));
    }
    case 'delay': {
      const delay = context.createDelay(1);
      delay.delayTime.value = p('time', 0.32, 0.05, 1);
      const feedback = context.createGain();
      feedback.gain.value = p('feedback', 0.3, 0, 0.8);
      const lowpass = filter(context, 'lowpass', 4500);
      chain(delay, lowpass, feedback, delay);
      return mixed(context, input, delay, delay, p('mix', 0.25));
    }
    case 'reverb': {
      const convolver = context.createConvolver();
      const decay = p('decay', 1.5, 0.2, 5);
      const impulse = context.createBuffer(2, Math.ceil(context.sampleRate * decay), context.sampleRate);
      impulse.getChannelData(0).set(createReverbSamples(context.sampleRate, decay, 0x726f6f6d));
      impulse.getChannelData(1).set(createReverbSamples(context.sampleRate, decay, 0x726f6f6e));
      convolver.normalize = false;
      convolver.buffer = impulse;
      const lowpass = filter(context, 'lowpass', 5500);
      convolver.connect(lowpass);
      return mixed(context, input, convolver, lowpass, p('mix', 0.2));
    }
  }
  throw new Error(`Unsupported audio effect: ${String(node.type)}`);
}

/** Offline rendering is deterministic and includes audible delay/reverb tails. */
export async function renderTone(tone: ToneSpec, input?: AudioBuffer): Promise<AudioBuffer> {
  const validated = validateToneSpec(tone);
  const assets = collectToneAssets(validated);
  if (assets.length > 0) throw new PreviewCapabilityError(assets.map((asset) => asset.id));
  if (typeof OfflineAudioContext === 'undefined') {
    throw new Error('Audio preview requires a browser with OfflineAudioContext support.');
  }
  if (input && (input.numberOfChannels < 1 || input.numberOfChannels > 2 || input.length === 0)) {
    throw new Error('Import a non-empty mono or stereo audio file.');
  }
  if (input) {
    let peak = 0;
    for (let c = 0; c < input.numberOfChannels; c++) {
      for (const sample of input.getChannelData(c)) {
        if (!Number.isFinite(sample)) throw new Error('Imported audio contains invalid samples.');
        peak = Math.max(peak, Math.abs(sample));
      }
    }
    if (peak < 1e-7) throw new Error('Imported audio is silent. Choose a recording with an audible DI signal.');
  }
  const sampleRate = input?.sampleRate ?? DEMO_SAMPLE_RATE;
  const duration = input?.duration ?? DEMO_DURATION_SECONDS;
  const enabled = validated.chain.filter(node => node.enabled);
  let tail = 0;
  for (const node of enabled) {
    if (node.type === 'reverb') tail += clamp(node.parameters.decay ?? 1.5, 0.2, 5);
    if (node.type === 'delay') {
      const feedback = clamp(node.parameters.feedback ?? 0.3, 0, 0.8);
      const repeats = feedback > 0 ? Math.ceil(Math.log(0.001) / Math.log(feedback)) : 1;
      tail += clamp(node.parameters.time ?? 0.32, 0.05, 1) * repeats;
    }
    if (node.type === 'chorus') tail += 0.03;
  }
  const context = new OfflineAudioContext(2, Math.ceil((duration + Math.min(12, tail) + 0.05) * sampleRate), sampleRate);
  const source = context.createBufferSource();
  source.buffer = input ?? createDemoBuffer(context);
  let output: AudioNode = source;
  for (const node of enabled) output = processNode(context, output, node);
  output.connect(context.destination);
  source.start();
  const rendered = await context.startRendering();
  const channels = Array.from({ length: rendered.numberOfChannels }, (_, index) => rendered.getChannelData(index));
  // Attenuate only: automatic loudness boosts would cancel master/level controls.
  limitSamples(channels, 0.85);
  return rendered;
}

/** Standard interleaved 16-bit PCM WAV, suitable for downloading auditions. */
export function bufferToWav(buffer: AudioBuffer): Blob {
  const channels = buffer.numberOfChannels;
  if (!Number.isInteger(channels) || channels < 1 || channels > 2) throw new Error('WAV export supports mono or stereo audio.');
  const bytes = new ArrayBuffer(44 + buffer.length * channels * 2);
  const view = new DataView(bytes);
  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeText(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, buffer.length * channels * 2, true);
  const data = Array.from({ length: channels }, (_, index) => buffer.getChannelData(index));
  let offset = 44;
  for (let frame = 0; frame < buffer.length; frame++) {
    for (const channel of data) {
      const value = channel[frame] ?? 0;
      if (!Number.isFinite(value)) throw new Error('WAV export contains non-finite samples.');
      const sample = clamp(value, -1, 1);
      view.setInt16(offset, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
      offset += 2;
    }
  }
  return new Blob([bytes], { type: 'audio/wav' });
}
