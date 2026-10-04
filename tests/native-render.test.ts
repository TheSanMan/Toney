import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInitialTone, type ToneSpec } from '../core';
import { createNativeRenderRequest, validateNativeResponse, type AudioRenderResult } from '../core/native/protocol';
import { inspectPcmWav } from '../core/native/wav';

const executable = fileURLToPath(new URL(`../engine/audio/build/bin/toney-engine${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));

interface Wav {
  sampleRate: number;
  channels: number;
  frames: number;
  samples: Int16Array;
}

/** Deliberately includes an odd-length padded chunk; PCM need not begin at byte 44. */
function sourceWav(): Buffer {
  const sampleRate = 44100;
  const frames = Math.floor(sampleRate * 0.3);
  const dataSize = frames * 2 * 2;
  const bytes = Buffer.alloc(56 + dataSize);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVE', 8);
  bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 4, 28);
  bytes.writeUInt16LE(4, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('JUNK', 36);
  bytes.writeUInt32LE(3, 40);
  bytes.write('DI!', 44);
  bytes.write('data', 48);
  bytes.writeUInt32LE(dataSize, 52);
  for (let frame = 0; frame < frames; frame++) {
    const time = frame / sampleRate;
    const envelope = Math.min(1, time / 0.004) * Math.exp(-time * 6);
    const left = (Math.sin(2 * Math.PI * 110 * time) + 0.4 * Math.sin(2 * Math.PI * 330 * time)) * envelope * 0.32;
    const right = (Math.sin(2 * Math.PI * 164.81 * time) + 0.3 * Math.sin(2 * Math.PI * 494.43 * time)) * envelope * 0.23;
    bytes.writeInt16LE(Math.round(left * 32767), 56 + frame * 4);
    bytes.writeInt16LE(Math.round(right * 32767), 58 + frame * 4);
  }
  return bytes;
}

function parseWav(bytes: Buffer): Wav {
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
  expect(bytes.toString('ascii', 8, 12)).toBe('WAVE');
  expect(bytes.readUInt32LE(4) + 8).toBe(bytes.length);
  let sampleRate = 0;
  let channels = 0;
  let data: Buffer | undefined;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    expect(start + length).toBeLessThanOrEqual(bytes.length);
    if (kind === 'fmt ') {
      expect(length).toBeGreaterThanOrEqual(16);
      expect(bytes.readUInt16LE(start)).toBe(1);
      channels = bytes.readUInt16LE(start + 2);
      sampleRate = bytes.readUInt32LE(start + 4);
      expect(bytes.readUInt16LE(start + 14)).toBe(16);
      expect(bytes.readUInt16LE(start + 12)).toBe(channels * 2);
      expect(bytes.readUInt32LE(start + 8)).toBe(sampleRate * channels * 2);
    }
    if (kind === 'data') data = bytes.subarray(start, start + length);
    offset = start + length + (length % 2);
  }
  if (!data || channels < 1 || sampleRate < 8000) throw new Error('Invalid PCM WAV fixture/output');
  expect(data.length % (channels * 2)).toBe(0);
  const samples = Int16Array.from({ length: data.length / 2 }, (_, index) => data.readInt16LE(index * 2));
  return { sampleRate, channels, frames: samples.length / channels, samples };
}

function peak(samples: Int16Array): number {
  return samples.reduce((maximum, sample) => Math.max(maximum, Math.abs(sample) / 32768), 0);
}

function rmsDifference(left: Int16Array, right: Int16Array, length: number): number {
  let energy = 0;
  for (let i = 0; i < length; i++) energy += (((left[i] ?? 0) - (right[i] ?? 0)) / 32768) ** 2;
  return Math.sqrt(energy / length);
}

function rig(kind: 'bypass' | 'clean' | 'drive' | 'ambient'): ToneSpec {
  const tone = createInitialTone();
  tone.name = `Native ${kind}`;
  for (const node of tone.chain) {
    node.enabled = false;
    if (kind === 'clean' && (node.type === 'amp' || node.type === 'cab')) {
      node.enabled = true;
      if (node.type === 'amp') node.parameters.gain = 0.04;
    }
    if (kind === 'drive' && ['drive', 'amp', 'cab'].includes(node.type)) {
      node.enabled = true;
      if (node.type === 'drive' || node.type === 'amp') node.parameters.gain = 0.85;
    }
    if (kind === 'ambient' && node.type === 'delay') {
      node.enabled = true;
      node.parameters.time = 0.12;
      node.parameters.feedback = 0.45;
      node.parameters.mix = 0.4;
    }
    if (kind === 'ambient' && node.type === 'reverb') {
      node.enabled = true;
      node.parameters.decay = 0.6;
      node.parameters.mix = 0.45;
    }
  }
  return tone;
}

// Web CI intentionally omits the native binary; native CI builds it before running Vitest.
describe.skipIf(!existsSync(executable))('Native offline WAV rendering', () => {
  let directory = '';
  let inputPath = '';
  const source = sourceWav();
  const original = parseWav(source);

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'toney-render-test-'));
    inputPath = join(directory, 'dry with spaces.wav');
    writeFileSync(inputPath, source);
  });

  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  function exchange(tone: ToneSpec, input: string, output: string) {
    const request = createNativeRenderRequest(tone);
    const result = spawnSync(executable, [], {
      input: `${JSON.stringify({ ...request, render: { inputPath: input, outputPath: output } })}\n`,
      encoding: 'utf8', timeout: 10000, maxBuffer: 256 * 1024,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const response: unknown = JSON.parse(result.stdout);
    return { request, response };
  }

  function render(tone: ToneSpec, name: string): { bytes: Buffer; wav: Wav; result: AudioRenderResult } {
    const outputPath = join(directory, `${name}.wav`);
    const { request, response } = exchange(tone, inputPath, outputPath);
    const result = validateNativeResponse(request, response);
    if (result.kind !== 'audio-render') throw new Error('Expected audio-render result');
    const bytes = readFileSync(outputPath);
    const wav = parseWav(bytes);
    const artifact = inspectPcmWav(bytes);
    expect(artifact).toMatchObject({ sampleRate: result.sampleRate, channels: result.channels, frames: result.outputFrames });
    expect(Math.abs(artifact.peak - result.peak)).toBeLessThanOrEqual(0.0001);
    expect(result).toMatchObject({
      engineVersion: '0.7.0', toneId: tone.id, revision: tone.revision,
      sampleRate: wav.sampleRate, channels: wav.channels,
      inputFrames: original.frames, outputFrames: wav.frames,
    });
    expect(wav.sampleRate).toBe(original.sampleRate);
    expect(wav.channels).toBe(original.channels);
    expect(result.peak).toBeCloseTo(peak(wav.samples), 4);
    expect(result.attenuationDb).toBeLessThanOrEqual(0);
    expect(peak(wav.samples)).toBeLessThanOrEqual(0.8501);
    expect(wav.frames).toBeLessThanOrEqual(original.frames + original.sampleRate * 12);
    return { bytes, wav, result };
  }

  it('correlates render metadata and preserves all-bypassed stereo PCM within one LSB without adding a tail', () => {
    const { wav, result } = render(rig('bypass'), 'bypass');
    expect(wav.frames).toBe(original.frames);
    expect(result.attenuationDb).toBe(0);
    for (let i = 0; i < original.samples.length; i++) {
      expect(Math.abs((wav.samples[i] ?? 0) - (original.samples[i] ?? 0))).toBeLessThanOrEqual(1);
    }
  });

  it('renders exactly reproducible ambient WAV bytes on repeat requests', () => {
    const tone = rig('ambient');
    const first = render(tone, 'ambient-repeat-1');
    const second = render(tone, 'ambient-repeat-2');
    expect(second.bytes).toEqual(first.bytes);
    expect(first.wav.frames).toBeGreaterThan(original.frames);
  });

  it('produces materially different clean, driven, and ambient audio with bounded audible tails and headroom', () => {
    const clean = render(rig('clean'), 'clean');
    const drive = render(rig('drive'), 'drive');
    const ambient = render(rig('ambient'), 'ambient');
    expect(rmsDifference(clean.wav.samples, drive.wav.samples, original.samples.length)).toBeGreaterThan(0.02);
    expect(rmsDifference(clean.wav.samples, ambient.wav.samples, original.samples.length)).toBeGreaterThan(0.02);
    expect(rmsDifference(drive.wav.samples, ambient.wav.samples, original.samples.length)).toBeGreaterThan(0.02);
    expect(peak(ambient.wav.samples.subarray(original.samples.length))).toBeGreaterThan(0.001);
    expect(ambient.wav.frames).toBeGreaterThan(clean.wav.frames);
  });

  it('rejects missing, truncated, and unsupported input while preserving an existing destination', () => {
    const destination = join(directory, 'existing.wav');
    const sentinel = Buffer.from('existing user recording must survive');
    const truncated = join(directory, 'truncated.wav');
    writeFileSync(truncated, source.subarray(0, source.length - 20));
    const unsupported = join(directory, 'unsupported.wav');
    const nonPcm = Buffer.from(source);
    nonPcm.writeUInt16LE(0x1234, 20);
    writeFileSync(unsupported, nonPcm);
    for (const [index, badInput] of [join(directory, 'missing.wav'), truncated, unsupported].entries()) {
      const absentDestination = join(directory, `failure-${index}.wav`);
      const failed = exchange(rig('bypass'), badInput, absentDestination);
      expect(failed.response).toMatchObject({
        protocolVersion: 1, requestId: failed.request.requestId, ok: false,
        error: { code: 'AUDIO_INPUT_INVALID', message: expect.any(String) },
      });
      expect(existsSync(absentDestination)).toBe(false);
      writeFileSync(destination, sentinel);
      const { request, response } = exchange(rig('bypass'), badInput, destination);
      expect(response).toMatchObject({
        protocolVersion: 1, requestId: request.requestId, ok: false,
        error: { code: expect.any(String), message: expect.any(String) },
      });
      expect(() => validateNativeResponse(request, response)).toThrow();
      expect(readFileSync(destination)).toEqual(sentinel);
    }
    const existing = exchange(rig('bypass'), inputPath, destination);
    expect(existing.response).toMatchObject({ ok: false, error: { code: 'AUDIO_OUTPUT_EXISTS' } });
    expect(readFileSync(destination)).toEqual(sentinel);
  });
});
