import { describe, expect, it } from 'vitest';
import { createInitialTone, setToneAsset } from '../core';
import type { NativeAssetDescriptor } from '../core/native/assets';
import { assignRigSlot, createRigBank, deleteRig, MAX_RIG_BANK_BYTES, overwriteRig, readRigBank, recallRig, renameRig, resolveRigSwitchCommand, rigSwitchCommandFromKeyboard, saveRigAs, serializeRigBank, type RigKeyboardEvent } from '../core/tone/rig-bank';

const stamp = '2026-10-04T12:00:00.000Z';
const asset: NativeAssetDescriptor = {
  asset: { id: 'a'.repeat(64), kind: 'nam', name: 'Fuzz.nam' },
  info: { kind: 'asset-info', id: 'a'.repeat(64), assetKind: 'nam', sampleRate: 48000, channels: 1, architecture: 'WaveNet', modelVersion: '0.5.4' },
  source: { provider: 'tone3000', toneId: 123, modelId: 456, toneName: 'Fuzz Capture', creator: 'Creator', license: 'T3K', url: 'https://www.tone3000.com/tones/fuzz-capture' },
};
function rigTone() {
  const tone = createInitialTone();
  const drive = tone.chain.find((node) => node.type === 'drive')!;
  const capture = setToneAsset(tone, drive.id, asset.asset);
  capture.chain.reverse();
  const node = capture.chain.find((entry) => entry.id === drive.id)!;
  node.enabled = false;
  node.mix = 0.37;
  node.parameters.gain = 0.43;
  return capture;
}
function bankWithTwo() {
  const one = saveRigAs(createRigBank(), { name: ' Clean ', tone: createInitialTone(), id: 'clean', now: stamp });
  return saveRigAs(one, { name: 'Fuzz + chorus', tone: rigTone(), assets: [asset], id: 'fuzz', now: stamp });
}
describe('saved rig bank', () => {
  it('round trips exact captured asset identity/provenance, stage order, mix and bypass state', () => {
    const tone = rigTone();
    const bank = saveRigAs(createRigBank(), { name: '  Fuzz combo  ', tone, assets: [asset], id: 'fuzz', now: stamp });
    const saved = recallRig(readRigBank(serializeRigBank(bank)), 'fuzz');
    expect(saved.name).toBe('Fuzz combo');
    expect(saved.tone).toEqual(tone);
    expect(saved.assets).toEqual([asset]);
    expect(saved.tone.chain.find((node) => node.asset)?.mix).toBe(0.37);
    expect(saved.tone.chain.find((node) => node.asset)?.enabled).toBe(false);
  });
  it('does not alias edits into stored tones or provenance and recalls separate snapshots', () => {
    const tone = rigTone();
    const descriptor = structuredClone(asset);
    const bank = saveRigAs(createRigBank(), { name: 'Fuzz', tone, assets: [descriptor], id: 'fuzz', now: stamp });
    tone.chain[0].parameters.mix = 1;
    descriptor.source!.creator = 'Changed';
    const recalled = recallRig(bank, 'fuzz');
    recalled.tone.chain[0].parameters.mix = 0.9;
    recalled.assets[0].source!.creator = 'Also changed';
    expect(bank.rigs[0].tone.chain[0].parameters.mix).toBe(0);
    expect(bank.rigs[0].assets[0].source!.creator).toBe('Creator');
  });
  it('requires explicit overwrite, preserving stable ID, creation time and slot', () => {
    const bank = assignRigSlot(bankWithTwo(), 'clean', 2);
    expect(() => saveRigAs(bank, { name: 'Other', tone: rigTone(), id: 'clean' })).toThrow('overwrite');
    const replacement = rigTone();
    const changed = overwriteRig(bank, 'clean', { tone: replacement, assets: [asset], now: '2026-10-05T12:00:00.000Z' });
    expect(changed.rigs[0]).toMatchObject({ id: 'clean', name: 'Clean', createdAt: stamp, updatedAt: '2026-10-05T12:00:00.000Z', slot: 2 });
    expect(changed.rigs[0].tone).toEqual(replacement);
    expect(bank.rigs[0].tone).not.toEqual(changed.rigs[0].tone);
    expect(renameRig(changed, 'clean', '  New name ').rigs[0].name).toBe('New name');
    expect(deleteRig(changed, 'clean').rigs.map((entry) => entry.id)).toEqual(['fuzz']);
    expect(() => overwriteRig(bank, 'absent', { tone: rigTone() })).toThrow('does not exist');
  });
  it('moves a unique slot binding and routes UI/hardware/keyboard through the same recall command', () => {
    let bank = assignRigSlot(bankWithTwo(), 'clean', 1);
    bank = assignRigSlot(bank, 'fuzz', 1);
    expect(bank.rigs[0].slot).toBeUndefined();
    expect(bank.rigs[1].slot).toBe(1);
    for (const source of ['ui', 'hardware', 'keyboard'] as const) expect(resolveRigSwitchCommand(bank, { type: 'recall-slot', slot: 1, source })?.id).toBe('fuzz');
    expect(resolveRigSwitchCommand(bank, { type: 'recall-slot', slot: 9, source: 'ui' })).toBeUndefined();
    expect(assignRigSlot(bank, 'fuzz').rigs[1].slot).toBeUndefined();
    expect(() => assignRigSlot(bank, 'clean', 10)).toThrow('between 1 and 9');
  });
  it('rejects corruption as a whole rather than returning a partial or empty bank', () => {
    const bank = bankWithTwo();
    expect(readRigBank(null)).toEqual(createRigBank());
    for (const raw of ['', '{', '{}', JSON.stringify({ ...bank, schemaVersion: 2 }), JSON.stringify({ ...bank, rigs: [bank.rigs[0], bank.rigs[0]] })]) expect(() => readRigBank(raw)).toThrow();
    const duplicateSlots = { ...bank, rigs: bank.rigs.map((entry) => ({ ...entry, slot: 1 })) };
    expect(() => readRigBank(JSON.stringify(duplicateSlots))).toThrow('Duplicate');
    const badTone = structuredClone(bank);
    badTone.rigs[1].tone.chain[0].parameters.mix = 2;
    expect(() => readRigBank(JSON.stringify(badTone))).toThrow('Invalid saved rig');
    const badSource = structuredClone(bank);
    badSource.rigs[1].assets[0].source!.url = 'https://example.com/phishing';
    expect(() => readRigBank(JSON.stringify(badSource))).toThrow('Invalid saved rig');
    expect(serializeRigBank(bank)).toBe(serializeRigBank(readRigBank(serializeRigBank(bank))));
  });
  it('enforces rig count, name and serialized byte bounds', () => {
    let bank = createRigBank();
    for (let i = 0; i < 64; i++) bank = saveRigAs(bank, { name: `Rig ${i}`, tone: createInitialTone(), id: `rig_${i}`, now: stamp });
    expect(() => saveRigAs(bank, { name: 'Rig 65', tone: createInitialTone() })).toThrow('full');
    for (const name of ['', ' ', 'x'.repeat(81), 'line\nbreak']) expect(() => saveRigAs(createRigBank(), { name, tone: createInitialTone() })).toThrow('1 to 80');
    expect(() => readRigBank(' '.repeat(MAX_RIG_BANK_BYTES + 1))).toThrow('4 MiB');
    expect(() => readRigBank('€'.repeat(Math.ceil(MAX_RIG_BANK_BYTES / 3)))).toThrow('4 MiB');
  });
});
describe('rig keyboard command adapter', () => {
  it('accepts number-row and number-pad keys with identical semantic commands', () => {
    for (let slot = 1; slot <= 9; slot++) for (const code of [`Digit${slot}`, `Numpad${slot}`]) expect(rigSwitchCommandFromKeyboard({ code })).toEqual({ type: 'recall-slot', source: 'keyboard', slot });
    for (const code of ['Digit0', 'Numpad0', 'KeyA', 'Enter']) expect(rigSwitchCommandFromKeyboard({ code })).toBeUndefined();
  });
  it('ignores repeated, modified, composing, consumed or editable-target events', () => {
    for (const guard of ['repeat', 'altKey', 'ctrlKey', 'metaKey', 'shiftKey', 'isComposing', 'defaultPrevented']) expect(rigSwitchCommandFromKeyboard({ code: 'Digit1', [guard]: true })).toBeUndefined();
    for (const target of [{ tagName: 'INPUT' }, { tagName: 'textarea' }, { tagName: 'SELECT' }, { tagName: 'SPAN', isContentEditable: true }, { tagName: 'SPAN', closest: () => ({ tagName: 'DIV' }) }]) expect(rigSwitchCommandFromKeyboard({ code: 'Digit1', target: target as unknown as RigKeyboardEvent['target'] })).toBeUndefined();
    expect(rigSwitchCommandFromKeyboard({ code: 'Digit1', target: { tagName: 'BUTTON', closest: () => null } as unknown as RigKeyboardEvent['target'] })?.slot).toBe(1);
  });
});
