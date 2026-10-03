import { describe, expect, it } from 'vitest';
import {
  collectToneAssets, createInitialTone, EFFECT_CATALOG, getNodeDefinition,
  setNodeEnabled, setToneAsset, setToneParameter, ToneAgent, validateAssetRef, validateToneSpec,
  type AssetRef, type NodeType, type ToneNode, type ToneSpec,
} from '../core';

const ir: AssetRef = { id: 'a'.repeat(64), kind: 'ir', name: 'Vintage 2x12.wav' };
const nam: AssetRef = { id: 'b'.repeat(64), kind: 'nam', name: 'Studio amp.nam' };

function node(tone: ToneSpec, type: NodeType): ToneNode {
  const found = tone.chain.find((entry) => entry.type === type);
  if (!found) throw new Error(`Missing ${type}`);
  return found;
}

function importedNode(type: NodeType, model: string, asset?: unknown): unknown {
  const tone = createInitialTone();
  return { ...tone, chain: [{ ...node(tone, type), model, ...(asset !== undefined ? { asset } : {}) }] };
}

describe('portable local asset contract', () => {
  it('creates v2 rigs and migrates v1 builtin exports without changing identity or parameters', () => {
    const tone = createInitialTone();
    expect(tone.schemaVersion).toBe(2);
    const legacy = { ...tone, schemaVersion: 1 };
    const migrated = validateToneSpec(legacy);
    expect(migrated).toEqual(tone);
    expect(legacy.schemaVersion).toBe(1);
    expect(migrated.revision).toBe(tone.revision);
    expect(migrated.chain).toEqual(tone.chain);
  });

  it('restricts schema v1 to its original builtin model contract', () => {
    const tone = createInitialTone();
    const cab = node(tone, 'cab');
    expect(() => validateToneSpec({ ...tone, schemaVersion: 1, chain: [{ ...cab, asset: ir }] })).toThrow('asset');
    expect(() => validateToneSpec({ ...tone, schemaVersion: 1, chain: [{ ...cab, model: 'cab_ir' }] })).toThrow('model');
    expect(() => validateToneSpec({ ...tone, schemaVersion: 1, chain: [{ ...node(tone, 'amp'), model: 'nam' }] })).toThrow('model');
  });

  it('round trips SHA-256 references for the exact supported external models', () => {
    const irTone = validateToneSpec(importedNode('cab', 'cab_ir', ir));
    const namTone = validateToneSpec(importedNode('amp', 'nam', nam));
    expect(node(irTone, 'cab').asset).toEqual(ir);
    expect(node(namTone, 'amp').asset).toEqual(nam);
    expect(validateToneSpec(JSON.parse(JSON.stringify(irTone)) as unknown)).toEqual(irTone);
    expect(validateToneSpec(JSON.parse(JSON.stringify(namTone)) as unknown)).toEqual(namTone);
  });

  it('requires an asset and the correct kind, and forbids refs on builtin or unrelated nodes', () => {
    expect(() => validateToneSpec(importedNode('cab', 'cab_ir'))).toThrow('asset');
    expect(() => validateToneSpec(importedNode('amp', 'nam'))).toThrow('asset');
    expect(() => validateToneSpec(importedNode('cab', 'cab_ir', nam))).toThrow('kind');
    expect(() => validateToneSpec(importedNode('amp', 'nam', ir))).toThrow('kind');
    expect(() => validateToneSpec(importedNode('cab', EFFECT_CATALOG.cab.model, ir))).toThrow('builtin');
    expect(() => validateToneSpec(importedNode('drive', EFFECT_CATALOG.drive.model, ir))).toThrow('builtin');
    expect(() => validateToneSpec(importedNode('drive', 'cab_ir', ir))).toThrow('model');
    expect(() => validateToneSpec(importedNode('cab', 'ir://file.wav', ir))).toThrow('model');
    expect(() => validateToneSpec(importedNode('amp', 'nam://file.nam', nam))).toThrow('model');
  });

  it('validates hashes, names and fields without accepting filesystem paths', () => {
    for (const id of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), '../amp.nam']) {
      expect(() => validateAssetRef({ ...ir, id })).toThrow('id');
    }
    for (const name of ['', ' ', '.', '..', '../cab.wav', 'folder/cab.wav', 'folder\\cab.wav', 'C:cab.wav', 'a..wav', 'x'.repeat(201), 'cab\u0000.wav', 'cab\n.wav', 'cab\u007f.wav', 'cab\u0085.wav']) {
      expect(() => validateAssetRef({ ...ir, name })).toThrow('name');
    }
    expect(() => validateAssetRef({ ...ir, kind: 'plugin' })).toThrow('kind');
    expect(() => validateAssetRef({ ...ir, path: '/tmp/cab.wav' })).toThrow('unknown field');
    expect(() => validateAssetRef({ id: ir.id, kind: 'ir' })).toThrow('name');
    expect(validateAssetRef({ ...ir, name: 'x'.repeat(200) }).name).toHaveLength(200);
    expect(validateAssetRef({ ...ir, name: '暖かいキャビネット.wav' }).name).toBe('暖かいキャビネット.wav');
  });

  it('selects and clears assets immutably while preserving controls, identity and bypass state', () => {
    const original = createInitialTone();
    const originalCab = node(original, 'cab');
    const manual = setNodeEnabled(setToneParameter(original, originalCab.id, 'brightness', 0.31), originalCab.id, false);
    const selected = setToneAsset(manual, originalCab.id, ir);
    expect(selected.revision).toBe(manual.revision + 1);
    expect(selected.metadata.source).toBe('manual');
    expect(node(selected, 'cab')).toEqual({ ...node(manual, 'cab'), model: 'cab_ir', asset: ir });
    expect(node(manual, 'cab').asset).toBeUndefined();
    const cleared = setToneAsset(selected, originalCab.id, undefined);
    expect(cleared.revision).toBe(selected.revision + 1);
    expect(node(cleared, 'cab')).toEqual(node(manual, 'cab'));
    expect(node(selected, 'cab').asset).toEqual(ir);
    const selectedAmp = setToneAsset(original, node(original, 'amp').id, nam);
    expect(node(selectedAmp, 'amp').model).toBe('nam');
    expect(node(setToneAsset(selectedAmp, node(selectedAmp, 'amp').id, undefined), 'amp').model).toBe(EFFECT_CATALOG.amp.model);
  });

  it('rejects invalid selection operations without touching the input rig', () => {
    const tone = createInitialTone();
    const before = JSON.stringify(tone);
    expect(() => setToneAsset(tone, 'missing-node', ir)).toThrow('unknown node');
    expect(() => setToneAsset(tone, node(tone, 'drive').id, ir)).toThrow('only amp and cab');
    expect(() => setToneAsset(tone, node(tone, 'cab').id, nam)).toThrow('requires an IR');
    expect(() => setToneAsset(tone, node(tone, 'amp').id, ir)).toThrow('requires a NAM');
    expect(() => setToneAsset(tone, node(tone, 'cab').id, { ...ir, id: 'bad' })).toThrow('SHA-256');
    expect(JSON.stringify(tone)).toBe(before);
  });

  it('collects unique enabled refs and does not require a library to validate missing assets', () => {
    const initial = createInitialTone();
    const selected = setToneAsset(setToneAsset(initial, node(initial, 'cab').id, ir), node(initial, 'amp').id, nam);
    const cab = node(selected, 'cab');
    const duplicate = { ...selected, chain: [...selected.chain, { ...cab, id: 'second-cab' }] };
    expect(collectToneAssets(duplicate)).toEqual([nam, ir]);
    const ampBypassed = setNodeEnabled(duplicate, node(duplicate, 'amp').id, false);
    expect(collectToneAssets(ampBypassed)).toEqual([ir]);
    const allBypassed = setNodeEnabled(setNodeEnabled(ampBypassed, cab.id, false), 'second-cab', false);
    expect(collectToneAssets(allBypassed)).toEqual([]);
    expect(validateToneSpec(allBypassed)).toEqual(allBypassed);
    expect(collectToneAssets(createInitialTone())).toEqual([]);
    const refs = collectToneAssets(duplicate);
    const first = refs[0];
    if (!first) throw new Error('Missing ref');
    first.name = 'Changed name.nam';
    expect(node(duplicate, 'amp').asset?.name).toBe(nam.name);
  });

  it('labels model trim and external IR controls without modifying builtin catalog definitions', () => {
    const initial = createInitialTone();
    const amp = node(setToneAsset(initial, node(initial, 'amp').id, nam), 'amp');
    const cab = node(setToneAsset(initial, node(initial, 'cab').id, ir), 'cab');
    const ampDefinition = getNodeDefinition(amp);
    expect(ampDefinition.parameters.gain?.label).toBe('Input trim');
    expect(ampDefinition.parameters.master?.label).toBe('Output trim');
    expect(ampDefinition.parameters.gain?.min).toBe(EFFECT_CATALOG.amp.parameters.gain?.min);
    expect(getNodeDefinition(cab).parameters.brightness?.label).toBe('IR brightness');
    expect(EFFECT_CATALOG.amp.parameters.gain?.label).toBe('Gain');
    expect(getNodeDefinition(node(initial, 'amp'))).toBe(EFFECT_CATALOG.amp);
  });

  it('preserves external model selection and bypass states across contextual refinement', async () => {
    const initial = createInitialTone();
    const ampId = node(initial, 'amp').id;
    const cabId = node(initial, 'cab').id;
    const selected = setToneAsset(setToneAsset(initial, cabId, ir), ampId, nam);
    const edited = setNodeEnabled(setToneParameter(selected, ampId, 'master', 0.41), cabId, false);
    const wider = await new ToneAgent().run({ prompt: 'make it wider', currentTone: edited });
    expect(node(wider.tone, 'amp')).toEqual(node(edited, 'amp'));
    expect(node(wider.tone, 'cab')).toEqual(node(edited, 'cab'));
    const darker = await new ToneAgent().run({ prompt: 'darker and less gain', currentTone: wider.tone });
    expect(node(darker.tone, 'amp').model).toBe('nam');
    expect(node(darker.tone, 'amp').asset).toEqual(nam);
    expect(node(darker.tone, 'amp').parameters.master).toBe(0.41);
    expect(node(darker.tone, 'amp').parameters.gain).toBeLessThan(node(wider.tone, 'amp').parameters.gain ?? 0);
    expect(node(darker.tone, 'cab').model).toBe('cab_ir');
    expect(node(darker.tone, 'cab').asset).toEqual(ir);
    expect(node(darker.tone, 'cab').enabled).toBe(false);
    expect(darker.tone.chain.map((entry) => entry.id)).toEqual(edited.chain.map((entry) => entry.id));
  });
});
