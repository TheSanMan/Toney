import { describe, expect, it } from 'vitest';
import { createNativeAssetImportRequest, createNativeAssetListRequest, validateNativeAssetDescriptor, validateNativeAssetImportResponse, validateNativeAssetListResponse, type NativeAssetDescriptor, type NativeAssetSource } from '../core/native/assets';
import { createTone3000DownloadRequest, createTone3000Request, createTone3000SelectRequest, validateTone3000DownloadResponse, validateTone3000Status, type Tone3000Selection } from '../core/native/tone3000';

const source: NativeAssetSource = { provider: 'tone3000', toneId: 12, modelId: 34, toneName: 'Studio amp', creator: 'Player', license: 'CC BY 4.0', url: 'https://www.tone3000.com/tones/studio-amp' };
const selection: Tone3000Selection = { toneId: source.toneId, name: source.toneName, creator: source.creator, license: source.license, url: source.url, models: [{ id: source.modelId, name: 'Amp capture.nam' }] };
const descriptor: NativeAssetDescriptor = {
  asset: { id: 'a'.repeat(64), kind: 'nam', name: 'Original amp.nam' },
  info: { kind: 'asset-info', id: 'a'.repeat(64), assetKind: 'nam', sampleRate: 48000, channels: 1, architecture: 'WaveNet', modelVersion: '0.5.4' }, source,
};

describe('TONE3000 local session contract', () => {
  it('validates local authorization/loading/selection/error states and clears on idle', () => {
    const request = createTone3000Request();
    for (const status of ['authorizing', 'loading'] as const) expect(validateTone3000Status(request, { ...request, status, kind: 'nam' })).toMatchObject({ status, kind: 'nam' });
    expect(validateTone3000Status(request, { ...request, status: 'ready', kind: 'nam', selection })).toMatchObject({ status: 'ready', selection });
    expect(validateTone3000Status(request, { ...request, status: 'error', kind: 'nam', error: { code: 'AUTH_EXPIRED', message: 'Select a tone again.' } })).toMatchObject({ status: 'error', error: { code: 'AUTH_EXPIRED' } });
    expect(validateTone3000Status(request, { ...request, status: 'idle' })).toEqual({ ...request, status: 'idle' });
  });

  it('keeps request-only fields out of normalized idle status', () => {
    const request = createTone3000SelectRequest('nam');
    expect(validateTone3000Status(request, { protocolVersion: 1, requestId: request.requestId, status: 'idle' })).toEqual({ protocolVersion: 1, requestId: request.requestId, status: 'idle' });
  });

  it('rejects mismatched requests, malformed IDs, duplicate models and exposed auth/download fields', () => {
    const request = createTone3000Request();
    const ready = { ...request, status: 'ready', kind: 'nam', selection };
    expect(() => validateTone3000Status(request, { ...ready, requestId: 'stale' })).toThrow('mismatched');
    expect(() => validateTone3000Status(request, { ...ready, protocolVersion: 2 })).toThrow('mismatched');
    expect(() => validateTone3000Status(request, { ...ready, token: 'sensitive' })).toThrow('mismatched');
    for (const malformed of [{ toneId: 0 }, { toneId: 1.5 }, { toneId: Number.MAX_SAFE_INTEGER + 1 }, { models: [] }, { models: [{ id: -1, name: 'bad' }] }, { models: [selection.models[0], selection.models[0]] }, { models: [{ id: 1, name: 'model', downloadUrl: 'https://example.com/private' }] }]) {
      expect(() => validateTone3000Status(request, { ...ready, selection: { ...selection, ...malformed } })).toThrow('mismatched');
    }
    for (const modelId of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) expect(() => createTone3000DownloadRequest(modelId)).toThrow('valid model');
  });

  it('rejects contradictory error/selection states and requires bounded human feedback', () => {
    const request = createTone3000Request();
    for (const invalid of [
      { status: 'idle', kind: 'nam' }, { status: 'loading', selection, kind: 'nam' }, { status: 'authorizing' },
      { status: 'ready', kind: 'nam', selection, error: { code: 'FAILED', message: 'bad' } },
      { status: 'error' }, { status: 'error', selection, error: { code: 'FAILED', message: 'bad' } },
      { status: 'error', error: { code: 'FAILED', message: '' } },
      { status: 'error', error: { code: 'FAILED', message: 'x'.repeat(2001) } }, { status: 'unknown' },
    ]) expect(() => validateTone3000Status(request, { ...request, ...invalid })).toThrow('mismatched');
  });
});

describe('bounded public source provenance', () => {
  it('allows existing local assets, and preserves optional source on listing and same-content manual reimport', () => {
    const local = { asset: descriptor.asset, info: descriptor.info };
    expect(validateNativeAssetDescriptor(local, 'local')).toEqual(local);
    const listRequest = createNativeAssetListRequest();
    expect(validateNativeAssetListResponse(listRequest, { ...listRequest, assets: [descriptor], diagnostics: [] }).assets[0]?.source).toEqual(source);
    const importRequest = createNativeAssetImportRequest('nam', 'Renamed amp.nam');
    const imported = validateNativeAssetImportResponse(importRequest, descriptor.asset.id, {
      response: { protocolVersion: 1, requestId: importRequest.requestId, ok: true, result: descriptor.info }, ...descriptor,
    });
    expect(imported.source).toEqual(source);
    expect(imported.asset.name).toBe('Original amp.nam');
  });

  it('rejects arbitrary providers, invalid IDs, unbounded metadata and nonpublic URL destinations', () => {
    for (const malformed of [{ provider: 'elsewhere' }, { toneId: 0 }, { modelId: 1.5 }, { creator: '' }, { license: 'x'.repeat(201) }, { downloadUrl: 'https://example.com/private' }]) {
      expect(() => validateNativeAssetDescriptor({ ...descriptor, source: { ...source, ...malformed } }, 'test')).toThrow('mismatched');
    }
    for (const url of ['http://tone3000.com/tones/1', 'https://tone3000.com.evil.test/tones/1', 'https://evil.test/tone3000.com', 'https://token@tone3000.com/tones/1', 'https://tone3000.com:8443/tones/1', 'https://tone3000.com/tones/1?token=secret', 'https://tone3000.com/tones/1#secret', 'https://tone3000.com/ton\nes/1', 'https://tone3000.com/tones/1 ']) {
      expect(() => validateNativeAssetDescriptor({ ...descriptor, source: { ...source, url } }, 'test')).toThrow('mismatched');
    }
    expect(() => validateNativeAssetDescriptor({ ...descriptor, source: null }, 'test')).toThrow('mismatched');
  });

  it('requires download provenance and the selected model ID without exposing raw download URLs', () => {
    const request = createTone3000DownloadRequest(source.modelId);
    const response = { protocolVersion: 1, requestId: request.requestId, descriptor };
    expect(validateTone3000DownloadResponse(request, response).descriptor.source).toEqual(source);
    expect(() => validateTone3000DownloadResponse(request, { ...response, requestId: 'stale' })).toThrow('mismatched');
    expect(() => validateTone3000DownloadResponse(request, { ...response, descriptor: { asset: descriptor.asset, info: descriptor.info } })).toThrow('mismatched');
    expect(() => validateTone3000DownloadResponse(request, { ...response, descriptor: { ...descriptor, source: { ...source, modelId: 35 } } })).toThrow('mismatched');
    expect(() => validateTone3000DownloadResponse(request, { ...response, descriptor: { ...descriptor, downloadUrl: 'https://example.com/private' } })).toThrow('mismatched');
  });
});
