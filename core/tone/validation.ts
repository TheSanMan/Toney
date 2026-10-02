import { EFFECT_CATALOG } from './catalog';
import type { NodeType, ToneIntent, ToneSpec } from './types';

export class ToneValidationError extends Error {
  readonly code = 'INVALID_TONE_SPEC';
  constructor(readonly path: string, reason: string) {
    super(`${path}: ${reason}`);
    this.name = 'ToneValidationError';
  }
}

export function object(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new ToneValidationError(path, 'expected an object');
  return input as Record<string, unknown>;
}

export function text(input: unknown, path: string): string {
  if (typeof input !== 'string' || input.trim().length === 0 || input.length > 500) throw new ToneValidationError(path, 'expected a nonempty string of at most 500 characters');
  return input;
}

export function number(input: unknown, path: string, min: number, max: number): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < min || input > max) throw new ToneValidationError(path, `expected a finite number between ${min} and ${max}`);
  return input;
}

function keys(value: Record<string, unknown>, expected: string[], path: string, optional: string[] = []): void {
  const invalid = Object.keys(value).find((key) => !expected.includes(key) && !optional.includes(key));
  if (invalid) throw new ToneValidationError(`${path}.${invalid}`, 'unknown field');
  const missing = expected.find((key) => !(key in value));
  if (missing) throw new ToneValidationError(`${path}.${missing}`, 'required field missing');
}

function timestamp(input: unknown, path: string): string {
  const value = text(input, path);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) throw new ToneValidationError(path, 'expected an ISO timestamp');
  return value;
}

export function validateToneSpec(input: unknown): ToneSpec {
  const value = object(input, 'tone');
  keys(value, ['schemaVersion', 'id', 'name', 'revision', 'chain', 'metadata'], 'tone');
  if (value.schemaVersion !== 1) throw new ToneValidationError('tone.schemaVersion', 'only schema version 1 is supported');
  const revision = number(value.revision, 'tone.revision', 0, Number.MAX_SAFE_INTEGER);
  if (!Number.isInteger(revision)) throw new ToneValidationError('tone.revision', 'expected an integer');
  if (!Array.isArray(value.chain) || value.chain.length < 1 || value.chain.length > 32) throw new ToneValidationError('tone.chain', 'expected between 1 and 32 nodes');
  const ids = new Set<string>();
  const chain = value.chain.map((inputNode: unknown, index: number) => {
    const path = `tone.chain[${index}]`;
    const node = object(inputNode, path);
    keys(node, ['id', 'type', 'model', 'enabled', 'parameters'], path);
    const id = text(node.id, `${path}.id`);
    if (ids.has(id)) throw new ToneValidationError(`${path}.id`, 'duplicate node ID');
    ids.add(id);
    const typeName = text(node.type, `${path}.type`);
    if (!Object.hasOwn(EFFECT_CATALOG, typeName)) throw new ToneValidationError(`${path}.type`, 'unsupported effect type');
    const type = typeName as NodeType;
    const definition = EFFECT_CATALOG[type];
    if (node.model !== definition.model) throw new ToneValidationError(`${path}.model`, `supported model is ${definition.model}`);
    if (typeof node.enabled !== 'boolean') throw new ToneValidationError(`${path}.enabled`, 'expected a boolean');
    const params = object(node.parameters, `${path}.parameters`);
    keys(params, Object.keys(definition.parameters), `${path}.parameters`);
    const parameters = Object.fromEntries(Object.entries(definition.parameters).map(([key, parameter]) => [key, number(params[key], `${path}.parameters.${key}`, parameter.min, parameter.max)]));
    return { id, type, model: definition.model, enabled: node.enabled, parameters };
  });
  const metadata = object(value.metadata, 'tone.metadata');
  keys(metadata, ['createdAt', 'updatedAt', 'source'], 'tone.metadata', ['traceId']);
  return {
    schemaVersion: 1, id: text(value.id, 'tone.id'), name: text(value.name, 'tone.name'), revision, chain,
    metadata: { createdAt: timestamp(metadata.createdAt, 'tone.metadata.createdAt'), updatedAt: timestamp(metadata.updatedAt, 'tone.metadata.updatedAt'), source: text(metadata.source, 'tone.metadata.source'), ...(metadata.traceId !== undefined ? { traceId: text(metadata.traceId, 'tone.metadata.traceId') } : {}) },
  };
}

export function validateToneIntent(input: unknown): ToneIntent {
  const value = object(input, 'intent');
  keys(value, ['character', 'distortion', 'dynamics', 'space', 'references'], 'intent');
  const character = object(value.character, 'intent.character');
  const dynamics = object(value.dynamics, 'intent.dynamics');
  const space = object(value.space, 'intent.space');
  const distortion = object(value.distortion, 'intent.distortion');
  keys(character, ['brightness', 'warmth', 'aggression', 'clarity', 'sustain', 'width'], 'intent.character');
  keys(dynamics, ['compression', 'transientPreservation'], 'intent.dynamics');
  keys(space, ['reverb', 'delay'], 'intent.space');
  keys(distortion, ['amount', 'texture'], 'intent.distortion');
  if (!['clean', 'crunch', 'gritty', 'smooth'].includes(String(distortion.texture))) throw new ToneValidationError('intent.distortion.texture', 'expected clean, crunch, gritty, or smooth');
  if (!Array.isArray(value.references) || value.references.length > 10) throw new ToneValidationError('intent.references', 'expected an array with at most ten references');
  const norm = (group: Record<string, unknown>, key: string, path: string) => number(group[key], `${path}.${key}`, 0, 1);
  return {
    character: { brightness: norm(character, 'brightness', 'intent.character'), warmth: norm(character, 'warmth', 'intent.character'), aggression: norm(character, 'aggression', 'intent.character'), clarity: norm(character, 'clarity', 'intent.character'), sustain: norm(character, 'sustain', 'intent.character'), width: norm(character, 'width', 'intent.character') },
    distortion: { amount: norm(distortion, 'amount', 'intent.distortion'), texture: distortion.texture as ToneIntent['distortion']['texture'] },
    dynamics: { compression: norm(dynamics, 'compression', 'intent.dynamics'), transientPreservation: norm(dynamics, 'transientPreservation', 'intent.dynamics') },
    space: { reverb: norm(space, 'reverb', 'intent.space'), delay: norm(space, 'delay', 'intent.space') },
    references: value.references.map((reference: unknown, index: number) => text(reference, `intent.references[${index}]`)),
  };
}
