import { EFFECT_CATALOG } from './catalog';
import type { AssetRef, NodeType, ToneNode, ToneSpec } from './types';
import { number, ToneValidationError, validateAssetRef, validateToneSpec } from './validation';

export const newId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;
export const cloneTone = (tone: ToneSpec): ToneSpec => validateToneSpec(tone);

export function createNode(type: NodeType): ToneNode {
  const effect = EFFECT_CATALOG[type];
  return { id: newId(type), type, model: effect.model, enabled: true, parameters: Object.fromEntries(Object.entries(effect.parameters).map(([key, parameter]) => [key, parameter.default])) };
}

export function createInitialTone(): ToneSpec {
  const now = new Date().toISOString();
  return { schemaVersion: 2, id: newId('tone'), name: 'Starting rig', revision: 0, chain: (Object.keys(EFFECT_CATALOG) as NodeType[]).map(createNode), metadata: { createdAt: now, updatedAt: now, source: 'initial' } };
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

/** The local library resolves bytes independently; a ToneSpec stores portable references only. */
export function setToneAsset(input: ToneSpec, nodeId: string, inputAsset: AssetRef | undefined): ToneSpec {
  const tone = cloneTone(input);
  const node = tone.chain.find((entry) => entry.id === nodeId);
  if (!node) throw new ToneValidationError('nodeId', `unknown node ${nodeId}`);
  if (node.type !== 'drive' && node.type !== 'amp' && node.type !== 'cab') throw new ToneValidationError('nodeId', 'only drive, amp and cab nodes support external assets');
  if (inputAsset === undefined) {
    delete node.asset;
    node.model = EFFECT_CATALOG[node.type].model;
  } else {
    const asset = validateAssetRef(inputAsset);
    if (asset.kind !== (node.type === 'cab' ? 'ir' : 'nam')) throw new ToneValidationError('asset.kind', `${node.type} requires ${node.type === 'cab' ? 'an IR' : 'a NAM'} asset`);
    // Builtin distortion gain/level have different meanings from capture trims.
    // First pedal selection auditions the exported capture at unity gain and EQ.
    if (node.type === 'drive' && node.model !== 'nam') node.parameters = { gain: 0.5, tone: 0.5, level: 0.5 };
    node.asset = asset;
    node.model = node.type === 'cab' ? 'cab_ir' : 'nam';
  }
  return revised(tone, 'manual');
}

/** Disabled assets need not exist locally to render the rest of the rig. */
export function collectToneAssets(input: ToneSpec): AssetRef[] {
  const tone = validateToneSpec(input);
  const assets = new Map<string, AssetRef>();
  for (const node of tone.chain) {
    if (node.enabled && node.asset) assets.set(`${node.asset.kind}:${node.asset.id}`, node.asset);
  }
  return [...assets.values()];
}
