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
    expect(() => validateToneSpec({ ...tone, schemaVersion: 1, chain: [{ ...node(tone, 'drive'), model: 'nam' }] })).toThrow('model');
  });

  it('round trips SHA-256 references for the exact supported external models', () => {
    const irTone = validateToneSpec(importedNode('cab', 'cab_ir', ir));
    const namTone = validateToneSpec(importedNode('amp', 'nam', nam));
    const pedalTone = validateToneSpec(importedNode('drive', 'nam', nam));
    expect(node(irTone, 'cab').asset).toEqual(ir);
    expect(node(namTone, 'amp').asset).toEqual(nam);
    expect(node(pedalTone, 'drive').asset).toEqual(nam);
    expect(validateToneSpec(JSON.parse(JSON.stringify(irTone)) as unknown)).toEqual(irTone);
    expect(validateToneSpec(JSON.parse(JSON.stringify(namTone)) as unknown)).toEqual(namTone);
    expect(validateToneSpec(JSON.parse(JSON.stringify(pedalTone)) as unknown)).toEqual(pedalTone);
  });

  it('requires an asset and the correct kind, and forbids refs on builtin or unrelated nodes', () => {
    expect(() => validateToneSpec(importedNode('cab', 'cab_ir'))).toThrow('asset');
    expect(() => validateToneSpec(importedNode('amp', 'nam'))).toThrow('asset');
    expect(() => validateToneSpec(importedNode('cab', 'cab_ir', nam))).toThrow('kind');
    expect(() => validateToneSpec(importedNode('amp', 'nam', ir))).toThrow('kind');
    expect(() => validateToneSpec(importedNode('drive', 'nam'))).toThrow('asset');
    expect(() => validateToneSpec(importedNode('drive', 'nam', ir))).toThrow('kind');
    expect(() => validateToneSpec(importedNode('chorus', 'nam', nam))).toThrow('model');
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

  it('selects assets at neutral capture controls and preserves identity, bypass and later capture edits', () => {
    const original = createInitialTone();
    const originalCab = node(original, 'cab');
    const manual = setNodeEnabled(setToneParameter(original, originalCab.id, 'brightness', 0.31), originalCab.id, false);
    const selected = setToneAsset(manual, originalCab.id, ir);
    expect(selected.revision).toBe(manual.revision + 1);
    expect(selected.metadata.source).toBe('manual');
    expect(node(selected, 'cab')).toEqual({ ...node(manual, 'cab'), model: 'cab_ir', asset: ir, parameters: { brightness: 0.5, resonance: 0 } });
    const tuned = setToneParameter(selected, originalCab.id, 'brightness', 0.28);
    expect(node(setToneAsset(tuned, originalCab.id, { ...ir, id: 'c'.repeat(64) }), 'cab').parameters).toEqual(node(tuned, 'cab').parameters);
    expect(node(manual, 'cab').asset).toBeUndefined();
    const cleared = setToneAsset(selected, originalCab.id, undefined);
    expect(cleared.revision).toBe(selected.revision + 1);
    expect(node(cleared, 'cab')).toEqual({ ...node(manual, 'cab'), parameters: { brightness: 0.5, resonance: 0 } });
    expect(node(selected, 'cab').asset).toEqual(ir);
    const selectedAmp = setToneAsset(original, node(original, 'amp').id, nam);
    expect(node(selectedAmp, 'amp').model).toBe('nam');
    expect(node(setToneAsset(selectedAmp, node(selectedAmp, 'amp').id, undefined), 'amp').model).toBe(EFFECT_CATALOG.amp.model);
  });

  it('rejects invalid selection operations without touching the input rig', () => {
    const tone = createInitialTone();
    const before = JSON.stringify(tone);
    expect(() => setToneAsset(tone, 'missing-node', ir)).toThrow('unknown node');
    expect(() => setToneAsset(tone, node(tone, 'drive').id, ir)).toThrow('requires a NAM');
    expect(() => setToneAsset(tone, node(tone, 'eq').id, nam)).toThrow('only drive, amp and cab');
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
    const pedal = node(setToneAsset(initial, node(initial, 'drive').id, nam), 'drive');
    expect(getNodeDefinition(pedal)).toMatchObject({ name: 'NAM pedal', model: 'nam', parameters: {
      gain: { label: 'Input trim' }, tone: { label: 'Post-capture tone' }, level: { label: 'Output trim' },
    } });
    expect(EFFECT_CATALOG.amp.parameters.gain?.label).toBe('Gain');
    expect(getNodeDefinition(node(initial, 'amp'))).toBe(EFFECT_CATALOG.amp);
  });

  it('selects a pedal independently of the amp and preserves both through refinements and bypass', async () => {
    const initial = createInitialTone();
    const pedalAsset = { ...nam, id: 'c'.repeat(64), name: 'Fuzz pedal.nam' };
    const pedalId = node(initial, 'drive').id;
    const ampId = node(initial, 'amp').id;
    const selected = setToneAsset(setToneAsset(initial, ampId, nam), pedalId, pedalAsset);
    expect(node(selected, 'drive').parameters).toEqual({ gain: 0.5, tone: 0.5, level: 0.5 });
    expect(node(selected, 'drive').id).toBe(pedalId);
    const bypassedSelection = setToneAsset(setNodeEnabled(initial, pedalId, false), pedalId, pedalAsset);
    expect(node(bypassedSelection, 'drive')).toMatchObject({ id: pedalId, enabled: false, parameters: { gain: 0.5, tone: 0.5, level: 0.5 } });
    expect(bypassedSelection.chain.map(node => node.id)).toEqual(initial.chain.map(node => node.id));
    expect(node(initial, 'drive').parameters).toEqual({ gain: 0.15, tone: 0.5, level: 0.6 });
    const edited = setToneParameter(selected, pedalId, 'level', 0.44);
    const alternate = setToneAsset(edited, pedalId, { ...pedalAsset, id: 'd'.repeat(64) });
    expect(node(alternate, 'drive').parameters).toEqual(node(edited, 'drive').parameters);
    expect(collectToneAssets(edited)).toEqual([pedalAsset, nam]);
    const wider = await new ToneAgent().run({ prompt: 'make it wider', currentTone: edited });
    expect(node(wider.tone, 'drive')).toEqual(node(edited, 'drive'));
    expect(node(wider.tone, 'amp')).toEqual(node(edited, 'amp'));
    const darker = await new ToneAgent().run({ prompt: 'darker and less gain', currentTone: wider.tone });
    expect(node(darker.tone, 'drive')).toMatchObject({ model: 'nam', asset: pedalAsset, parameters: { level: 0.44 } });
    expect(node(darker.tone, 'drive').parameters.tone).toBeLessThan(node(wider.tone, 'drive').parameters.tone ?? 0);
    const bypass = setNodeEnabled(darker.tone, pedalId, false);
    expect(collectToneAssets(bypass)).toEqual([nam]);
    expect(node(setToneAsset(bypass, pedalId, undefined), 'drive')).toMatchObject({ model: 'builtin_drive', enabled: false });
    expect(node(edited, 'drive').asset).toEqual(pedalAsset);
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
    // A fixed capture's input trim is calibration, not the original amp gain knob.
    expect(node(darker.tone, 'amp').parameters.gain).toBe(node(wider.tone, 'amp').parameters.gain);
    expect(node(darker.tone, 'amp').parameters.treble).toBeLessThan(node(wider.tone, 'amp').parameters.treble ?? 0);
    expect(node(darker.tone, 'cab').model).toBe('cab_ir');
    expect(node(darker.tone, 'cab').asset).toEqual(ir);
    expect(node(darker.tone, 'cab').enabled).toBe(false);
    expect(darker.tone.chain.map((entry) => entry.id)).toEqual(edited.chain.map((entry) => entry.id));
  });
});
