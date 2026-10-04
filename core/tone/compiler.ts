import { EFFECT_CATALOG } from './catalog';
import { cloneTone, createInitialTone, createNode, revised } from './operations';
import { DEFAULT_INTENT, type IntentPath, type NodeType, type ToneIntent, type ToneSpec } from './types';
import { validateToneIntent, validateToneSpec } from './validation';

const clamp = (value: number, min = 0, max = 1): number => Math.min(max, Math.max(min, value));
const round = (value: number): number => Math.round(value * 1000) / 1000;

export function inferIntentFromTone(tone: ToneSpec, previousIntent?: ToneIntent): ToneIntent {
  const rig = validateToneSpec(tone);
  const prior = previousIntent ? validateToneIntent(previousIntent) : undefined;
  const intent = structuredClone(DEFAULT_INTENT);
  const enabled = (type: NodeType) => rig.chain.filter((node) => node.type === type && node.enabled && (node.mix ?? 1) > 0);
  const get = (type: NodeType, key: string, fallback: number): number => {
    const node = enabled(type)[0];
    return node ? node.parameters[key] ?? fallback : fallback;
  };
  const blended = (type: NodeType, key: string, dry: number): number => {
    const node = enabled(type)[0];
    return node ? dry + ((node.parameters[key] ?? dry) - dry) * (node.mix ?? 1) : dry;
  };
  intent.character.brightness = blended('cab', 'brightness', 0.5);
  intent.character.warmth = blended('amp', 'bass', 0.5);
  const knownGain = enabled('drive').filter((node) => node.model !== 'nam').reduce((sum, node) => sum + (node.parameters.gain ?? 0) * (node.mix ?? 1), 0)
    + enabled('amp').filter((node) => node.model !== 'nam').reduce((sum, node) => sum + (node.parameters.gain ?? 0) * (node.mix ?? 1), 0);
  const captures = rig.chain.filter((node) => node.enabled && node.model === 'nam' && (node.mix ?? 1) > 0);
  // Capture input trim does not reveal saturation. Preserve known conversational
  // intent when available; otherwise use a conservative unknown-capture baseline.
  const capturedAmount = captures.length ? (prior?.distortion.amount ?? DEFAULT_INTENT.distortion.amount) * Math.max(...captures.map((node) => node.mix ?? 1)) : 0;
  intent.distortion.amount = clamp(Math.max(knownGain / 1.5, capturedAmount));
  intent.distortion.texture = intent.distortion.amount < 0.1 ? 'clean' : intent.distortion.amount < 0.5 ? 'crunch' : prior?.distortion.texture === 'smooth' ? 'smooth' : 'gritty';
  intent.character.aggression = intent.distortion.amount;
  intent.character.sustain = blended('compressor', 'amount', 0);
  intent.character.width = clamp(blended('chorus', 'mix', 0) / 0.45);
  intent.dynamics.compression = blended('compressor', 'amount', 0);
  intent.dynamics.transientPreservation = get('compressor', 'attack', 0.7);
  intent.space.reverb = blended('reverb', 'mix', 0);
  intent.space.delay = blended('delay', 'mix', 0);
  intent.references = prior?.references ?? [];
  return intent;
}

export interface CompileOptions {
  currentTone?: ToneSpec;
  baseline: ToneIntent;
  changedPaths: readonly IntentPath[];
  issues?: readonly ('muddy' | 'harsh')[];
  traceId: string;
  replaceCharacter?: boolean;
  mixSettings?: readonly { nodeId: string; mix: number }[];
}

export interface CompileResult { tone: ToneSpec; changes: string[] }

export function compileTone(input: ToneIntent, options: CompileOptions): CompileResult {
  const intent = validateToneIntent(input);
  const baseline = validateToneIntent(options.baseline);
  const tone = options.currentTone ? cloneTone(options.currentTone) : createInitialTone();
  const changes: string[] = [];
  const refining = options.currentTone !== undefined;
  const active = (path: IntentPath): boolean => !refining || options.changedPaths.includes(path);
  const ensure = (type: NodeType): void => {
    if (tone.chain.some((node) => node.type === type)) return;
    const order = Object.keys(EFFECT_CATALOG) as NodeType[];
    const position = tone.chain.findIndex((node) => order.indexOf(node.type) > order.indexOf(type));
    tone.chain.splice(position < 0 ? tone.chain.length : position, 0, createNode(type));
    changes.push(`Added independent ${type} stage`);
  };
  if (refining) {
    if (options.changedPaths.includes('character.width') && intent.character.width > 0) ensure('chorus');
    if (options.changedPaths.includes('space.delay') && intent.space.delay > 0) ensure('delay');
    if (options.changedPaths.includes('space.reverb') && intent.space.reverb > 0) ensure('reverb');
    if (options.changedPaths.includes('distortion.amount') && intent.distortion.amount > 0.25) ensure('drive');
    if (options.changedPaths.some((path) => path.startsWith('dynamics.'))) ensure('compressor');
  }
  const set = (type: NodeType, key: string, value: number, delta?: number): void => {
    const definition = EFFECT_CATALOG[type].parameters[key];
    if (!definition) throw new Error(`Compiler has no definition for ${type}.${key}`);
    // Existing order, duplicate effects, bypass states, and node identities are authoritative.
    for (const node of tone.chain.filter((entry) => entry.type === type)) {
      // Gain on a NAM capture is input trim, not an original amplifier gain knob.
      if (node.model === 'nam' && (key === 'gain' || key === 'level')) continue;
      const old = node.parameters[key];
      if (old === undefined) throw new Error(`Compiler missing parameter ${type}.${key}`);
      // Perceptual wet intent is audible after the stage blend. A stage left
      // fully dry by the direct-sound action must become audible when space is requested.
      const stageMix = node.mix ?? 1;
      const restoringWet = key === 'mix' && stageMix === 0 && value > 0;
      if (restoringWet) { node.mix = 1; changes.push(`${node.id}.mix: 0 → 1`); }
      const adjustment = key === 'mix' && stageMix > 0 ? (delta ?? 0) / stageMix : delta;
      const next = round(clamp(restoringWet ? value : refining && !options.replaceCharacter && adjustment !== undefined ? old + adjustment : value, definition.min, definition.max));
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
  if (intent.distortion.amount <= 0.1 && active('distortion.amount')) {
    for (const node of tone.chain.filter((entry) => entry.type === 'drive' && entry.enabled && (entry.model === 'nam' || options.replaceCharacter))) {
      node.enabled = false;
      changes.push(`Bypassed drive stage ${node.asset?.name ?? node.id} for the clean request`);
    }
  }
  for (const setting of options.mixSettings ?? []) {
    const node = tone.chain.find((entry) => entry.id === setting.nodeId);
    if (!node) throw new Error(`Mix target ${setting.nodeId} is not in the current rig`);
    if (!Number.isFinite(setting.mix) || setting.mix < 0 || setting.mix > 1) throw new Error('Mix must be between 0 and 1');
    if ((node.mix ?? 1) !== setting.mix) {
      node.mix = setting.mix;
      changes.push(`${node.id}.mix: ${setting.mix}`);
    }
  }
  tone.metadata.traceId = options.traceId;
  if (!refining || options.currentTone?.metadata.source === 'initial') tone.name = `${intent.distortion.texture === 'clean' ? 'Clean' : intent.distortion.texture === 'smooth' ? 'Singing' : 'Crunch'} ${intent.character.brightness < 0.4 ? 'and dark' : intent.character.brightness > 0.65 ? 'and bright' : 'and balanced'} rig`;
  return { tone: revised(tone, 'agent'), changes };
}
