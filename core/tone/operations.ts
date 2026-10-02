import { EFFECT_CATALOG } from './catalog';
import type { NodeType, ToneNode, ToneSpec } from './types';
import { number, ToneValidationError, validateToneSpec } from './validation';

export const newId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;
export const cloneTone = (tone: ToneSpec): ToneSpec => validateToneSpec(tone);

export function createNode(type: NodeType): ToneNode {
  const effect = EFFECT_CATALOG[type];
  return { id: newId(type), type, model: effect.model, enabled: true, parameters: Object.fromEntries(Object.entries(effect.parameters).map(([key, parameter]) => [key, parameter.default])) };
}

export function createInitialTone(): ToneSpec {
  const now = new Date().toISOString();
  return { schemaVersion: 1, id: newId('tone'), name: 'Starting rig', revision: 0, chain: (Object.keys(EFFECT_CATALOG) as NodeType[]).map(createNode), metadata: { createdAt: now, updatedAt: now, source: 'initial' } };
}

export function revised(tone: ToneSpec, source: string): ToneSpec {
  tone.revision += 1;
  tone.metadata.updatedAt = new Date().toISOString();
  tone.metadata.source = source;
  return validateToneSpec(tone);
}

export function setToneParameter(input: ToneSpec, nodeId: string, parameter: string, value: number): ToneSpec {
  const tone = cloneTone(input);
  const node = tone.chain.find((entry) => entry.id === nodeId);
  if (!node) throw new ToneValidationError('nodeId', `unknown node ${nodeId}`);
  if (!Object.hasOwn(EFFECT_CATALOG[node.type].parameters, parameter)) throw new ToneValidationError('parameter', `unknown parameter ${parameter} for ${node.type}`);
  const definition = EFFECT_CATALOG[node.type].parameters[parameter];
  if (!definition) throw new ToneValidationError('parameter', 'unknown parameter');
  node.parameters[parameter] = number(value, `parameter.${parameter}`, definition.min, definition.max);
  return revised(tone, 'manual');
}

export function setNodeEnabled(input: ToneSpec, nodeId: string, enabled: boolean): ToneSpec {
  const tone = cloneTone(input);
  const node = tone.chain.find((entry) => entry.id === nodeId);
  if (!node) throw new ToneValidationError('nodeId', `unknown node ${nodeId}`);
  if (typeof enabled !== 'boolean') throw new ToneValidationError('enabled', 'expected a boolean');
  node.enabled = enabled;
  return revised(tone, 'manual');
}
