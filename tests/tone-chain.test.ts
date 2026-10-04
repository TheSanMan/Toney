import { describe, expect, it } from 'vitest';
import { appendToneNode, createInitialTone, moveToneNode, removeToneNode, setToneAsset, setToneNodeMix, validateToneSpec } from '../core';

const fuzz = { id: 'a'.repeat(64), kind: 'nam' as const, name: 'fuzz.nam' };
const boost = { id: 'b'.repeat(64), kind: 'nam' as const, name: 'boost.nam' };

describe('independent pedal stages and mixes', () => {
  it('keeps independently assignable NAM pedals, amp and builtin chorus', () => {
    const initial = createInitialTone();
    const withFuzz = appendToneNode(initial, 'drive', fuzz);
    const tone = appendToneNode(withFuzz, 'drive', boost);
    const captures = tone.chain.filter((node) => node.model === 'nam');
    expect(captures.map((node) => node.asset?.id)).toEqual([fuzz.id, boost.id]);
    expect(captures[0]?.id).not.toBe(captures[1]?.id);
    expect(tone.chain.findIndex((node) => node.asset?.id === boost.id)).toBeLessThan(tone.chain.findIndex((node) => node.type === 'amp'));
    expect(tone.chain.find((node) => node.type === 'chorus')?.model).toBe('builtin_chorus');
    expect(initial.chain).toHaveLength(8);
    expect(initial.chain.find((node) => node.type === 'reverb')?.parameters.mix).toBe(0);
    expect(initial.chain.find((node) => node.type === 'delay')?.parameters.mix).toBe(0);
    expect(tone.revision).toBe(2);
  });
  it('moves/removes only a selected stage and validates bounds', () => {
    const tone = appendToneNode(createInitialTone(), 'drive', fuzz);
    const id = tone.chain.find((node) => node.asset)?.id;
    if (!id) throw new Error('Missing capture');
    const mixed = setToneNodeMix(tone, id, 0.3);
    expect(mixed.chain.find((node) => node.id === id)?.mix).toBe(0.3);
    expect(tone.chain.find((node) => node.id === id)?.mix).toBeUndefined();
    const moved = moveToneNode(mixed, id, 1);
    expect(moved.chain.findIndex((node) => node.id === id)).toBe(tone.chain.findIndex((node) => node.id === id) + 1);
    expect(removeToneNode(moved, id).chain.some((node) => node.id === id)).toBe(false);
    expect(() => setToneNodeMix(tone, id, 1.01)).toThrow('mix');
    expect(() => validateToneSpec({ ...tone, chain: [{ ...tone.chain[0], mix: Number.NaN }] })).toThrow('mix');
    expect(() => removeToneNode({ ...tone, chain: [tone.chain[0]!] }, tone.chain[0]!.id)).toThrow('at least one');
  });
  it('loads captures with neutral surrounding controls', () => {
    const tone = createInitialTone();
    const amp = tone.chain.find((node) => node.type === 'amp')!;
    expect(setToneAsset(tone, amp.id, fuzz).chain.find((node) => node.id === amp.id)?.parameters).toEqual({ gain: 0.5, bass: 0.5, mid: 0.5, treble: 0.5, master: 0.5 });
    const cab = tone.chain.find((node) => node.type === 'cab')!;
    expect(setToneAsset(tone, cab.id, { ...fuzz, kind: 'ir', name: 'cab.wav' }).chain.find((node) => node.id === cab.id)?.parameters).toEqual({ brightness: 0.5, resonance: 0 });
  });
});
