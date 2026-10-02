import { describe, expect, it } from 'vitest';
import { createInitialTone, setNodeEnabled, setToneParameter, validateToneIntent, validateToneSpec, DEFAULT_INTENT } from '../core';

describe('canonical tone contract', () => {
  it('round trips complete versioned rigs through JSON', () => {
    const tone = createInitialTone();
    expect(validateToneSpec(JSON.parse(JSON.stringify(tone)) as unknown)).toEqual(tone);
    expect(tone.chain.map((node) => node.type)).toEqual(['compressor', 'drive', 'amp', 'cab', 'eq', 'chorus', 'delay', 'reverb']);
  });

  it('rejects unsupported versions, models, unknown fields and invalid ranges', () => {
    const tone = createInitialTone();
    expect(() => validateToneSpec({ ...tone, schemaVersion: 2 })).toThrow('schemaVersion');
    const drive = tone.chain.find((node) => node.type === 'drive');
    if (!drive) throw new Error('Missing drive');
    expect(() => validateToneSpec({ ...tone, chain: [{ ...drive, model: 'imaginary_amp' }] })).toThrow('model');
    expect(() => validateToneSpec({ ...tone, chain: [{ ...drive, parameters: { ...drive.parameters, gain: Number.NaN } }] })).toThrow('gain');
    expect(() => validateToneSpec({ ...tone, chain: [{ ...drive, parameters: { ...drive.parameters, gain: 1.01 } }] })).toThrow('gain');
    expect(() => validateToneSpec({ ...tone, chain: [{ ...drive, parameters: { ...drive.parameters, undocumented: 1 } }] })).toThrow('unknown field');
    expect(() => validateToneSpec({ ...tone, chain: [drive, drive] })).toThrow('duplicate node');
    expect(() => validateToneSpec({ ...tone, revision: 1.5 })).toThrow('integer');
  });

  it('validates semantic intent before it reaches compilation', () => {
    expect(validateToneIntent(DEFAULT_INTENT)).toEqual(DEFAULT_INTENT);
    expect(() => validateToneIntent({ ...DEFAULT_INTENT, character: { ...DEFAULT_INTENT.character, brightness: -1 } })).toThrow('brightness');
    expect(() => validateToneIntent({ ...DEFAULT_INTENT, distortion: { amount: 0.5, texture: 'invented' } })).toThrow('texture');
  });

  it('manual edits are immutable, revisioned and constrained to known parameters', () => {
    const original = createInitialTone();
    const amp = original.chain.find((node) => node.type === 'amp');
    if (!amp) throw new Error('Missing amp');
    const edited = setToneParameter(original, amp.id, 'master', 0.42);
    expect(original.chain.find((node) => node.id === amp.id)?.parameters.master).toBe(0.65);
    expect(edited.chain.find((node) => node.id === amp.id)?.parameters.master).toBe(0.42);
    expect(edited.revision).toBe(1);
    expect(setNodeEnabled(edited, amp.id, false).chain.find((node) => node.id === amp.id)?.enabled).toBe(false);
    expect(() => setToneParameter(original, amp.id, 'master', 1.5)).toThrow('master');
    expect(() => setToneParameter(original, amp.id, 'invented', 0.5)).toThrow('unknown parameter');
    expect(() => setNodeEnabled(original, 'unknown-node', false)).toThrow('unknown node');
  });
});
