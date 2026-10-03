export type NodeType = 'compressor' | 'drive' | 'amp' | 'cab' | 'eq' | 'chorus' | 'delay' | 'reverb';

export interface ToneIntent {
  character: { brightness: number; warmth: number; aggression: number; clarity: number; sustain: number; width: number };
  distortion: { amount: number; texture: 'clean' | 'crunch' | 'gritty' | 'smooth' };
  dynamics: { compression: number; transientPreservation: number };
  space: { reverb: number; delay: number };
  references: string[];
}

export type IntentPath =
  | `character.${keyof ToneIntent['character']}`
  | `distortion.${keyof ToneIntent['distortion']}`
  | `dynamics.${keyof ToneIntent['dynamics']}`
  | `space.${keyof ToneIntent['space']}`;

export interface AssetRef {
  /** SHA-256 of the locally imported asset bytes, never a filesystem path. */
  id: string;
  kind: 'ir' | 'nam';
  name: string;
}

export interface ToneNode {
  id: string;
  type: NodeType;
  model: string;
  enabled: boolean;
  parameters: Record<string, number>;
  asset?: AssetRef;
}

export interface ToneSpec {
  schemaVersion: 2;
  id: string;
  name: string;
  revision: number;
  chain: ToneNode[];
  metadata: { createdAt: string; updatedAt: string; source: string; traceId?: string };
}

export interface ParameterDefinition { label: string; min: number; max: number; default: number; unit?: string }
export interface EffectDefinition { name: string; model: string; parameters: Record<string, ParameterDefinition> }

export const INTENT_PATHS: readonly IntentPath[] = [
  'character.brightness', 'character.warmth', 'character.aggression', 'character.clarity',
  'character.sustain', 'character.width', 'distortion.amount', 'distortion.texture',
  'dynamics.compression', 'dynamics.transientPreservation', 'space.reverb', 'space.delay',
];

export const DEFAULT_INTENT: ToneIntent = {
  character: { brightness: 0.5, warmth: 0.5, aggression: 0.25, clarity: 0.65, sustain: 0.3, width: 0.1 },
  distortion: { amount: 0.2, texture: 'crunch' },
  dynamics: { compression: 0.2, transientPreservation: 0.7 },
  space: { reverb: 0.12, delay: 0 },
  references: [],
};
