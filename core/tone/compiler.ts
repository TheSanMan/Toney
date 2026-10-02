import { EFFECT_CATALOG } from './catalog';
import { cloneTone, createInitialTone, revised } from './operations';
import { DEFAULT_INTENT, type IntentPath, type NodeType, type ToneIntent, type ToneSpec } from './types';
import { validateToneIntent, validateToneSpec } from './validation';

const clamp = (value: number, min = 0, max = 1): number => Math.min(max, Math.max(min, value));
const round = (value: number): number => Math.round(value * 1000) / 1000;

export function inferIntentFromTone(tone: ToneSpec): ToneIntent {
  const rig = validateToneSpec(tone);
  const intent = structuredClone(DEFAULT_INTENT);
  const get = (type: NodeType, key: string, fallback: number): number => rig.chain.find((node) => node.type === type)?.parameters[key] ?? fallback;
  intent.character.brightness = get('cab', 'brightness', 0.5);
  intent.character.warmth = get('amp', 'bass', 0.5);
  intent.distortion.amount = clamp((get('drive', 'gain', 0.15) + get('amp', 'gain', 0.25)) / 1.5);
  intent.character.aggression = intent.distortion.amount;
  intent.character.sustain = get('compressor', 'amount', 0.2);
  intent.character.width = clamp(get('chorus', 'mix', 0) / 0.45);
  intent.dynamics.compression = get('compressor', 'amount', 0.2);
  intent.dynamics.transientPreservation = get('compressor', 'attack', 0.7);
  intent.space.reverb = get('reverb', 'mix', 0.12);
  intent.space.delay = get('delay', 'mix', 0);
  return intent;
}

export interface CompileOptions {
  currentTone?: ToneSpec;
  baseline: ToneIntent;
  changedPaths: readonly IntentPath[];
  issues?: readonly ('muddy' | 'harsh')[];
  traceId: string;
}

export interface CompileResult { tone: ToneSpec; changes: string[] }

export function compileTone(input: ToneIntent, options: CompileOptions): CompileResult {
  const intent = validateToneIntent(input);
  const baseline = validateToneIntent(options.baseline);
  const tone = options.currentTone ? cloneTone(options.currentTone) : createInitialTone();
  const changes: string[] = [];
  const refining = options.currentTone !== undefined;
  const active = (path: IntentPath): boolean => !refining || options.changedPaths.includes(path);
  const set = (type: NodeType, key: string, value: number, delta?: number): void => {
    const definition = EFFECT_CATALOG[type].parameters[key];
    if (!definition) throw new Error(`Compiler has no definition for ${type}.${key}`);
    // Existing order, duplicate effects, bypass states, and node identities are authoritative.
    for (const node of tone.chain.filter((entry) => entry.type === type)) {
      const old = node.parameters[key];
      if (old === undefined) throw new Error(`Compiler missing parameter ${type}.${key}`);
      const next = round(clamp(refining && delta !== undefined ? old + delta : value, definition.min, definition.max));
      if (next !== old) { node.parameters[key] = next; changes.push(`${type}.${key}: ${old} → ${next}`); }
    }
  };

  if (active('distortion.amount')) {
    const delta = intent.distortion.amount - baseline.distortion.amount;
    set('drive', 'gain', intent.distortion.amount * 0.8, delta * 0.8);
    set('amp', 'gain', 0.05 + intent.distortion.amount * 0.7, delta * 0.7);
  }
  if (active('character.aggression')) {
    const delta = intent.character.aggression - baseline.character.aggression;
    set('amp', 'mid', 0.45 + intent.character.aggression * 0.2, delta * 0.2);
  }
  if (active('character.brightness')) {
    const delta = intent.character.brightness - baseline.character.brightness;
    set('drive', 'tone', intent.character.brightness, delta);
    set('amp', 'treble', 0.15 + intent.character.brightness * 0.7, delta * 0.7);
    set('cab', 'brightness', intent.character.brightness, delta);
    set('eq', 'highDb', (intent.character.brightness - 0.5) * 8, delta * 8);
  }
  if (active('character.warmth')) {
    const delta = intent.character.warmth - baseline.character.warmth;
    set('amp', 'bass', 0.25 + intent.character.warmth * 0.45, delta * 0.45);
    set('cab', 'resonance', 0.15 + intent.character.warmth * 0.4, delta * 0.4);
  }
  if (active('dynamics.compression') || active('character.sustain')) {
    const amount = Math.max(intent.dynamics.compression, intent.character.sustain * 0.55);
    const oldAmount = Math.max(baseline.dynamics.compression, baseline.character.sustain * 0.55);
    set('compressor', 'amount', amount, amount - oldAmount);
  }
  if (active('dynamics.transientPreservation')) set('compressor', 'attack', intent.dynamics.transientPreservation, intent.dynamics.transientPreservation - baseline.dynamics.transientPreservation);
  if (active('character.width')) {
    const delta = intent.character.width - baseline.character.width;
    set('chorus', 'mix', intent.character.width * 0.45, delta * 0.45);
    set('chorus', 'depth', 0.15 + intent.character.width * 0.5, delta * 0.5);
  }
  if (active('space.delay')) {
    const delta = intent.space.delay - baseline.space.delay;
    set('delay', 'mix', intent.space.delay, delta);
    set('delay', 'feedback', 0.15 + intent.space.delay * 0.45, delta * 0.45);
  }
  if (active('space.reverb')) {
    const delta = intent.space.reverb - baseline.space.reverb;
    set('reverb', 'mix', intent.space.reverb, delta);
    set('reverb', 'decay', 0.5 + intent.space.reverb * 4, delta * 4);
  }
  if (active('character.clarity') && !options.issues?.includes('muddy')) {
    const delta = intent.character.clarity - baseline.character.clarity;
    set('eq', 'lowDb', -intent.character.clarity * 2, -delta * 2);
    if (!refining) {
      // Chord definition limits excessive gain on newly generated rigs.
      const drive = tone.chain.find((node) => node.type === 'drive');
      if (drive) set('drive', 'gain', Math.min(drive.parameters.gain ?? 0, 1 - intent.character.clarity * 0.25));
    }
  }
  if (options.issues?.includes('muddy') && refining) {
    const enabled = (type: NodeType, key: string): number => tone.chain.find((node) => node.type === type && node.enabled)?.parameters[key] ?? 0;
    // One major change: first inspect the strongest plausible cause in the current rig.
    if (enabled('reverb', 'mix') > 0.35) set('reverb', 'mix', 0, -0.16);
    else if (enabled('drive', 'gain') > 0.65) set('drive', 'gain', 0, -0.13);
    else if (enabled('compressor', 'amount') > 0.65) set('compressor', 'amount', 0, -0.15);
    else set('eq', 'lowDb', 0, -2);
  }
  tone.metadata.traceId = options.traceId;
  if (!refining || options.currentTone?.metadata.source === 'initial') tone.name = `${intent.distortion.texture === 'clean' ? 'Clean' : intent.distortion.texture === 'smooth' ? 'Singing' : 'Crunch'} ${intent.character.brightness < 0.4 ? 'and dark' : intent.character.brightness > 0.65 ? 'and bright' : 'and balanced'} rig`;
  return { tone: revised(tone, 'agent'), changes };
}
