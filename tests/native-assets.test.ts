import { describe, expect, it } from 'vitest';
import {
  createNativeAssetImportRequest, createNativeAssetListRequest, validateNativeAssetImportResponse,
  validateNativeAssetInfo, validateNativeAssetListResponse,
  type NativeAssetDescriptor, type NativeAssetInfo,
} from '../core/native/assets';
import type { AssetRef } from '../core';

const ir: AssetRef = { id: 'a'.repeat(64), kind: 'ir', name: 'first.wav' };
const nam: AssetRef = { id: 'b'.repeat(64), kind: 'nam', name: 'amp.nam' };
const irInfo: NativeAssetInfo = { kind: 'asset-info', id: ir.id, assetKind: 'ir', sampleRate: 48000, channels: 2, frames: 1024 };
const namInfo: NativeAssetInfo = { kind: 'asset-info', id: nam.id, assetKind: 'nam', sampleRate: 48000, channels: 1, architecture: 'WaveNet', modelVersion: '0.5.4' };

describe('native asset import contract', () => {
  it('accepts correlated inspection and persistent metadata while retaining the first name', () => {
    const request = createNativeAssetImportRequest('ir', 'renamed.wav');
    const input = { response: { protocolVersion: 1, requestId: request.requestId, ok: true, result: irInfo }, asset: ir, info: irInfo };
    expect(validateNativeAssetImportResponse(request, ir.id, input)).toEqual({ asset: ir, info: irInfo });
  });

  it('rejects hash/kind/correlation mismatches and metadata disagreement', () => {
    const request = createNativeAssetImportRequest('ir', 'first.wav');
    const input = { response: { protocolVersion: 1, requestId: request.requestId, ok: true, result: irInfo }, asset: ir, info: irInfo };
    expect(() => validateNativeAssetImportResponse(request, 'c'.repeat(64), input)).toThrow('invalid or mismatched');
    expect(() => validateNativeAssetImportResponse(request, ir.id, { ...input, response: { ...input.response, requestId: 'other' } })).toThrow('mismatched');
    expect(() => validateNativeAssetImportResponse(request, ir.id, { ...input, response: { ...input.response, protocolVersion: 2 } })).toThrow('mismatched');
    expect(() => validateNativeAssetImportResponse(request, ir.id, { ...input, info: { ...irInfo, frames: 1 } })).toThrow('mismatched');
    expect(() => validateNativeAssetImportResponse(request, nam.id, { response: { ...input.response, result: namInfo }, asset: nam, info: namInfo })).toThrow('mismatched');
  });

  it('requires strict descriptors, error contracts, and valid import names', () => {
    const request = createNativeAssetImportRequest('ir', 'first.wav');
    const failure = { response: { protocolVersion: 1, requestId: request.requestId, ok: false, error: { code: 'ASSET_INVALID', message: 'Invalid impulse.' } }, asset: ir, info: irInfo };
    expect(() => validateNativeAssetImportResponse(request, ir.id, failure)).toThrow('Invalid impulse.');
    expect(() => validateNativeAssetImportResponse(request, ir.id, { ...failure, response: { ...failure.response, error: { code: 1, message: 'bad' } } })).toThrow('mismatched');
    expect(() => validateNativeAssetImportResponse(request, ir.id, { ...failure, path: '/tmp/cab.wav' })).toThrow('mismatched');
    expect(() => createNativeAssetImportRequest('ir', '../first.wav')).toThrow('basename');
  });
});

describe('asset inspection metadata', () => {
  it('accepts supported IR and NAM metadata', () => {
    expect(validateNativeAssetInfo(irInfo, ir, 'test')).toEqual(irInfo);
    expect(validateNativeAssetInfo(namInfo, nam, 'test')).toEqual(namInfo);
    expect(validateNativeAssetInfo({ ...namInfo, architecture: 'LSTM' }, nam, 'test')).toMatchObject({ architecture: 'LSTM' });
  });

  it('rejects unsafe counts, unsupported models and arbitrary/path fields', () => {
    for (const extra of [{ id: nam.id }, { assetKind: 'nam' }, { sampleRate: Infinity }, { sampleRate: 7999 }, { sampleRate: 96001 }, { channels: 3 }, { frames: 0 }, { frames: 96001 }, { frames: 1.5 }, { architecture: 'WaveNet' }, { path: '/tmp/ir.wav' }]) {
      expect(() => validateNativeAssetInfo({ ...irInfo, ...extra }, ir, 'test')).toThrow('mismatched');
    }
    for (const extra of [{ channels: 2 }, { architecture: 'Transformer' }, { modelVersion: '1.0.0' }, { modelVersion: '0.5.unknown' }, { frames: 10 }]) {
      expect(() => validateNativeAssetInfo({ ...namInfo, ...extra }, nam, 'test')).toThrow('mismatched');
    }
  });
});

describe('correlated asset library inventory', () => {
  it('preserves usable entries alongside repair diagnostics', () => {
    const request = createNativeAssetListRequest();
    const assets: NativeAssetDescriptor[] = [{ asset: ir, info: irInfo }, { asset: nam, info: namInfo }];
    const diagnostics = [{ id: 'invalid-directory', code: 'ASSET_DESCRIPTOR_INVALID', message: 'Restore the descriptor.' }, { id: 'library', code: 'ASSET_LIBRARY_LIMIT', message: 'Listing stopped at 128 entries.' }];
    expect(validateNativeAssetListResponse(request, { ...request, assets, diagnostics })).toEqual({ assets, diagnostics });
  });

  it('rejects stale correlation, malformed metadata, duplicates and oversized arrays', () => {
    const request = createNativeAssetListRequest();
    const entry = { asset: ir, info: irInfo };
    expect(() => validateNativeAssetListResponse(request, { ...request, requestId: 'stale', assets: [], diagnostics: [] })).toThrow('mismatched');
    expect(() => validateNativeAssetListResponse(request, { ...request, assets: [entry, entry], diagnostics: [] })).toThrow('mismatched');
    expect(() => validateNativeAssetListResponse(request, { ...request, assets: Array.from({ length: 129 }, () => entry), diagnostics: [] })).toThrow('mismatched');
    expect(() => validateNativeAssetListResponse(request, { ...request, assets: [], diagnostics: Array.from({ length: 130 }, () => ({ id: 'x', code: 'x', message: 'x' })) })).toThrow('mismatched');
    expect(() => validateNativeAssetListResponse(request, { ...request, assets: [entry], diagnostics: [{ id: 'x', code: 'x', message: 10 }] })).toThrow('mismatched');
    expect(() => validateNativeAssetListResponse(request, { ...request, assets: [{ ...entry, asset: { ...ir, id: 'bad' } }], diagnostics: [] })).toThrow('mismatched');
    expect(() => validateNativeAssetListResponse(request, { ...request, assets: [], diagnostics: [], path: '/tmp/library' })).toThrow('mismatched');
  });
});
