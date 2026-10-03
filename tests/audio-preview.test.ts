import { describe, expect, it } from 'vitest';
import { bufferToWav, createDemoSamples, createReverbSamples, limitSamples, normalizeSamples, renderTone } from '../apps/desktop/src/audio/preview';
import { createInitialTone, setNodeEnabled, setToneAsset } from '../core';

function rms(samples: Float32Array): number {
  return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
}

function audioBuffer(channels: Float32Array<ArrayBuffer>[], sampleRate = 44100): AudioBuffer {
  const length = channels[0]?.length ?? 0;
  return {
    numberOfChannels: channels.length,
    sampleRate,
    length,
    duration: length / sampleRate,
    getChannelData: (channel: number) => {
      const data = channels[channel];
      if (!data) throw new Error('Unknown channel');
      return data;
    },
    copyFromChannel: (destination: Float32Array, channel: number, start = 0) => {
      destination.set(channels[channel]?.subarray(start, start + destination.length) ?? []);
    },
    copyToChannel: (source: Float32Array, channel: number, start = 0) => {
      channels[channel]?.set(source, start);
    },
  };
}

describe('deterministic audition signal', () => {
  it('provides six seconds of repeatable plucked audio with headroom and a quiet ending', () => {
    const samples = createDemoSamples();
    expect(samples.length).toBe(6 * 44100);
    expect(samples).toEqual(createDemoSamples());
    expect(rms(samples)).toBeGreaterThan(0.025);
    const peak = samples.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
    expect(peak).toBeCloseTo(0.42, 6);
    expect(rms(samples.subarray(samples.length - 4410))).toBeLessThan(0.001);
    expect([...samples].every(Number.isFinite)).toBe(true);
  });

  it('respects supported sample rates and rejects invalid ones', () => {
    expect(createDemoSamples(48000).length).toBe(288000);
    expect(() => createDemoSamples(0)).toThrow('sample rate');
    expect(() => createDemoSamples(Number.NaN)).toThrow('sample rate');
  });

  it('preserves stereo balance and polarity while giving samples safe headroom', () => {
    const left = new Float32Array([2, -2, 0]);
    const right = new Float32Array([1, -1, 0]);
    expect(normalizeSamples([left, right])).toBeCloseTo(0.425);
    expect(left[0]).toBeCloseTo(0.85);
    expect(left[1]).toBeCloseTo(-0.85);
    expect(right[0]).toBeCloseTo(0.425);
    expect(right[1]).toBeCloseTo(-0.425);
    expect(normalizeSamples([new Float32Array(5)])).toBe(1);
    expect(() => normalizeSamples([new Float32Array([Number.NaN])])).toThrow('non-finite');
    expect(() => normalizeSamples([left], 2)).toThrow('Target peak');
  });

  it('does not undo quieter level settings and attenuates only unsafe peaks', () => {
    const quiet = new Float32Array([0.1, -0.2]);
    const normal = new Float32Array([0.4, -0.8]);
    expect(limitSamples([quiet])).toBe(1);
    expect(limitSamples([normal])).toBe(1);
    expect(quiet[0]).toBeCloseTo(0.1);
    expect(normal[0]).toBeCloseTo(0.4);
    const loud = new Float32Array([1.7, -0.85]);
    expect(limitSamples([loud])).toBeCloseTo(0.5);
    expect(loud[0]).toBeCloseTo(0.85);
    expect(loud[1]).toBeCloseTo(-0.425);
    expect(() => limitSamples([new Float32Array([Infinity])])).toThrow('non-finite');
    expect(() => limitSamples([quiet], 0)).toThrow('ceiling');
  });

  it('uses reproducible stereo room responses that decay over time', () => {
    const impulse = createReverbSamples(44100, 2, 42);
    expect(impulse.length).toBe(88200);
    expect(impulse).toEqual(createReverbSamples(44100, 2, 42));
    expect(impulse).not.toEqual(createReverbSamples(44100, 2, 43));
    expect(rms(impulse.subarray(1000, 11000))).toBeGreaterThan(rms(impulse.subarray(72000, 82000)) * 20);
    expect(Math.abs(impulse[0] ?? 1)).toBe(0);
  });
});

describe('WAV export', () => {
  it('writes a standard stereo PCM header and interleaves signed channel samples', async () => {
    const buffer = audioBuffer([new Float32Array([-1, 0, 1]), new Float32Array([0.5, -0.5, 0])], 48000);
    const blob = bufferToWav(buffer);
    const bytes = await blob.arrayBuffer();
    const view = new DataView(bytes);
    const text = (start: number, length: number) => new TextDecoder().decode(new Uint8Array(bytes, start, length));
    expect(blob.type).toBe('audio/wav');
    expect(bytes.byteLength).toBe(56);
    expect(text(0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(48);
    expect(text(8, 4)).toBe('WAVE');
    expect(text(12, 4)).toBe('fmt ');
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint32(28, true)).toBe(192000);
    expect(view.getUint16(32, true)).toBe(4);
    expect(view.getUint16(34, true)).toBe(16);
    expect(text(36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(12);
    expect(Array.from({ length: 6 }, (_, i) => view.getInt16(44 + i * 2, true))).toEqual([-32768, 16384, 0, -16384, 32767, 0]);
  });

  it('clamps out-of-range samples and exports mono correctly', async () => {
    const bytes = await bufferToWav(audioBuffer([new Float32Array([-2, 2])])).arrayBuffer();
    const view = new DataView(bytes);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(40, true)).toBe(4);
    expect(view.getInt16(44, true)).toBe(-32768);
    expect(view.getInt16(46, true)).toBe(32767);
    expect(() => bufferToWav(audioBuffer([]))).toThrow('mono or stereo');
    expect(() => bufferToWav(audioBuffer([new Float32Array([Number.NaN])]))).toThrow('non-finite');
  });
});

describe('browser capability errors', () => {
  it('requires native rendering for enabled external models before creating a browser audio graph', async () => {
    const initial = createInitialTone();
    for (const type of ['amp', 'cab'] as const) {
      const entry = initial.chain.find((node) => node.type === type);
      if (!entry) throw new Error('Missing model node');
      const asset = { id: 'a'.repeat(64), kind: type === 'amp' ? 'nam' as const : 'ir' as const, name: type === 'amp' ? 'amp.nam' : 'cab.wav' };
      const selected = setToneAsset(initial, entry.id, asset);
      await expect(renderTone(selected)).rejects.toMatchObject({ code: 'NATIVE_ASSETS_REQUIRED', assetIds: [asset.id] });
      await expect(renderTone(setNodeEnabled(selected, entry.id, false))).rejects.toThrow('OfflineAudioContext');
    }
  });

  it('fails explicitly when browser audio is unavailable', async () => {
    await expect(renderTone(createInitialTone())).rejects.toThrow('OfflineAudioContext');
  });

  it('validates malformed recipes before attempting audio rendering', async () => {
    const tone = createInitialTone();
    const amp = tone.chain.find(node => node.type === 'amp');
    if (!amp) throw new Error('Starting rig is missing amp');
    amp.parameters.master = Number.NaN;
    await expect(renderTone(tone)).rejects.toMatchObject({ code: 'INVALID_TONE_SPEC', path: expect.stringContaining('master') });
  });
});
