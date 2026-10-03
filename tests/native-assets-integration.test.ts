import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInitialTone, type AssetRef, type ToneSpec } from '../core';
import { validateNativeAssetInfo } from '../core/native/assets';
import { createNativeRenderRequest, validateNativeResponse } from '../core/native/protocol';
import { inspectPcmWav } from '../core/native/wav';

const build = fileURLToPath(new URL('../engine/audio/build/', import.meta.url));
const executable = join(build, 'bin', `toney-engine${process.platform === 'win32' ? '.exe' : ''}`);
interface Descriptor { id: string; kind: AssetRef['kind']; path: string }

function pcm(samples: Float32Array, sampleRate: number): Buffer {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36);
  bytes.writeUInt32LE(samples.length * 2, 40);
  for (const [index, value] of samples.entries()) bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + index * 2);
  return bytes;
}

function namSource(): string {
  const cache = existsSync(join(build, 'CMakeCache.txt')) ? readFileSync(join(build, 'CMakeCache.txt'), 'utf8') : '';
  return process.env.NAM_PATH ?? cache.match(/^NAM_PATH:PATH=(.+)$/m)?.[1]
    ?? cache.match(/^toney_nam_SOURCE_DIR:STATIC=(.+)$/m)?.[1] ?? join(build, '_deps/toney_nam-src');
}

// No C++ binary is expected on web-only CI; native CI fetches the pinned official fixtures.
describe.skipIf(!existsSync(executable))('Actual native NAM and cabinet asset integration', () => {
  let directory = '';
  let inputPath = '';
  let wavenet: Descriptor;
  let lstm: Descriptor;
  let ir: Descriptor;

  function descriptor(kind: Descriptor['kind'], path: string): Descriptor {
    return { kind, path, id: createHash('sha256').update(readFileSync(path)).digest('hex') };
  }

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'toney-native-assets-'));
    inputPath = join(directory, 'dry.wav');
    const dry = Float32Array.from({ length: 2205 }, (_, i) => Math.sin(i * 2 * Math.PI * 173 / 44100) * 0.25 * Math.exp(-i / 1400));
    writeFileSync(inputPath, pcm(dry, 44100));
    const impulse = new Float32Array(256);
    impulse[0] = 0.65; impulse[16] = -0.12; impulse[90] = 0.05;
    const irPath = join(directory, 'synthetic-cab.wav');
    writeFileSync(irPath, pcm(impulse, 24000));
    ir = descriptor('ir', irPath);
    wavenet = descriptor('nam', join(namSource(), 'example_models/wavenet.nam'));
    lstm = descriptor('nam', join(namSource(), 'example_models/lstm.nam'));
  });
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  function exchange(request: object): unknown {
    const process = spawnSync(executable, [], { input: `${JSON.stringify(request)}\n`, encoding: 'utf8', timeout: 20000, maxBuffer: 256 * 1024 });
    expect(process.error).toBeUndefined(); expect(process.status).toBe(0); expect(process.stderr).toBe('');
    return JSON.parse(process.stdout) as unknown;
  }

  function rig(assets: Descriptor[], enabled = true): ToneSpec {
    const tone = createInitialTone();
    for (const node of tone.chain) {
      node.enabled = false;
      const asset = assets.find(value => value.kind === (node.type === 'amp' ? 'nam' : node.type === 'cab' ? 'ir' : undefined));
      if (asset) {
        node.enabled = enabled;
        node.model = asset.kind === 'nam' ? 'nam' : 'cab_ir';
        node.asset = { id: asset.id, kind: asset.kind, name: asset.kind === 'nam' ? 'upstream-test-fixture.nam' : 'synthetic-cab.wav' };
      }
    }
    return tone;
  }

  function render(tone: ToneSpec, descriptors: Descriptor[], outputPath: string) {
    const request = createNativeRenderRequest(tone);
    const response = exchange({ ...request, render: { inputPath, outputPath, assets: descriptors } });
    const result = validateNativeResponse(request, response);
    if (result.kind !== 'audio-render') throw new Error('Expected rendered audio');
    const bytes = readFileSync(outputPath);
    const wave = inspectPcmWav(bytes);
    expect(result).toMatchObject({ kind: 'audio-render', engineVersion: '0.5.0', toneId: tone.id, revision: tone.revision,
      sampleRate: 44100, channels: 1, inputFrames: 2205, outputFrames: wave.frames });
    expect(wave.sampleRate).toBe(result.sampleRate); expect(wave.channels).toBe(result.channels);
    expect(Math.abs(wave.peak - result.peak)).toBeLessThanOrEqual(0.0001);
    expect(wave.peak).toBeLessThanOrEqual(0.8501);
    expect(Number.isFinite(result.peak) && Number.isFinite(result.attenuationDb)).toBe(true);
    return { bytes, wave };
  }

  it('inspects both official NAM architectures and an IR with correlated production-validated metadata', () => {
    for (const [asset, architecture] of [[wavenet, 'WaveNet'], [lstm, 'LSTM'], [ir, undefined]] as const) {
      const requestId = `inspect-${asset.kind}-${architecture ?? 'cab'}`;
      const response = exchange({ protocolVersion: 1, requestId, command: 'inspect_asset', asset });
      expect(response).toMatchObject({ protocolVersion: 1, requestId, ok: true, result: { id: asset.id, assetKind: asset.kind } });
      if (typeof response !== 'object' || response === null || !('result' in response)) throw new Error('Missing inspection result');
      const info = validateNativeAssetInfo(response.result, { id: asset.id, kind: asset.kind, name: 'test asset' }, requestId);
      if (architecture) expect(info).toMatchObject({ architecture, modelVersion: '0.5.4', sampleRate: 48000, channels: 1 });
      else expect(info).toMatchObject({ frames: 256, sampleRate: 24000, channels: 1 });
    }
  });

  it('renders IR, each NAM architecture, and a combined chain through the production PCM validator', () => {
    for (const [index, assets] of [[ir], [wavenet], [lstm], [wavenet, ir]].entries()) {
      const rendered = render(rig(assets), assets, join(directory, `asset-render-${index}.wav`));
      expect(rendered.wave.frames).toBeGreaterThanOrEqual(2205);
      expect(rendered.wave.peak).toBeGreaterThan(0);
      expect(rendered.bytes.equals(readFileSync(inputPath))).toBe(false);
    }
  });

  it('renders repeatable combined NAM/IR bytes with fresh native state', () => {
    const tone = rig([wavenet, ir]);
    const first = render(tone, [wavenet, ir], join(directory, 'repeat-first.wav'));
    const second = render(tone, [wavenet, ir], join(directory, 'repeat-second.wav'));
    expect(second.bytes).toEqual(first.bytes);
  });

  it('renders a separate NAM pedal before NAM amp and IR, with deterministic independent state', () => {
    const tone = rig([lstm, ir]);
    const pedal = tone.chain.find(node => node.type === 'drive');
    if (!pedal) throw new Error('Missing pedal block');
    pedal.model = 'nam'; pedal.enabled = true;
    pedal.parameters = { gain: 0.5, tone: 0.5, level: 0.5 };
    pedal.asset = { id: wavenet.id, kind: 'nam', name: 'upstream-pedal-fixture.nam' };
    const enabled = render(tone, [wavenet, lstm, ir], join(directory, 'pedal-amp-cab.wav'));
    const repeat = render(tone, [wavenet, lstm, ir], join(directory, 'pedal-amp-cab-repeat.wav'));
    expect(repeat.bytes).toEqual(enabled.bytes);
    pedal.enabled = false;
    const bypassed = render(tone, [lstm, ir], join(directory, 'pedal-bypassed.wav'));
    expect(bypassed.bytes).not.toEqual(enabled.bytes);
    expect(bypassed.wave.peak).toBeGreaterThan(0);
    pedal.enabled = true;
    const request = createNativeRenderRequest(tone);
    const outputPath = join(directory, 'missing-pedal.wav');
    const response = exchange({ ...request, render: { inputPath, outputPath, assets: [lstm, ir] } });
    expect(response).toMatchObject({ protocolVersion: 1, requestId: request.requestId, ok: false, error: { code: 'ASSET_MISSING' } });
    expect(() => validateNativeResponse(request, response)).toThrow();
    expect(existsSync(outputPath)).toBe(false);
  });

  it('allows missing assets when bypassed and reports a correlated error when enabled', () => {
    const tone = rig([wavenet, ir], false);
    const bypass = render(tone, [], join(directory, 'missing-bypassed.wav'));
    expect(bypass.wave.frames).toBe(2205);
    for (const node of tone.chain) if (node.asset) node.enabled = true;
    const request = createNativeRenderRequest(tone);
    const outputPath = join(directory, 'missing-enabled.wav');
    const response = exchange({ ...request, render: { inputPath, outputPath, assets: [] } });
    expect(response).toMatchObject({ protocolVersion: 1, requestId: request.requestId, ok: false, error: { code: 'ASSET_MISSING' } });
    expect(() => validateNativeResponse(request, response)).toThrow(); expect(existsSync(outputPath)).toBe(false);
  });

  it('rejects changed asset bytes without replacing an existing user destination', () => {
    const corrupted = join(directory, 'changed-model.nam');
    writeFileSync(corrupted, Buffer.concat([readFileSync(wavenet.path), Buffer.from('\n ')]));
    const outputPath = join(directory, 'preserve.wav');
    const existing = Buffer.from('user output must survive asset mismatch');
    writeFileSync(outputPath, existing);
    const tone = rig([wavenet]);
    const request = createNativeRenderRequest(tone);
    const response = exchange({ ...request, render: { inputPath, outputPath, assets: [{ ...wavenet, path: corrupted }] } });
    expect(response).toMatchObject({ protocolVersion: 1, requestId: request.requestId, ok: false, error: { code: 'ASSET_CORRUPT' } });
    expect(() => validateNativeResponse(request, response)).toThrow();
    expect(readFileSync(outputPath)).toEqual(existing);
  });
});
