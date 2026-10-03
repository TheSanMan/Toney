import { validateAssetRef, type AssetRef } from '../index';
import { NativeError } from './protocol';

export type NativeAssetInfo =
  | { kind: 'asset-info'; id: string; assetKind: 'ir'; sampleRate: number; channels: 1 | 2; frames: number }
  | { kind: 'asset-info'; id: string; assetKind: 'nam'; sampleRate: number; channels: 1; architecture: 'WaveNet' | 'LSTM'; modelVersion: string };
export interface NativeAssetSource {
  provider: 'tone3000'; toneId: number; modelId: number; toneName: string; creator: string; license: string; url: string;
}
export interface NativeAssetDescriptor { asset: AssetRef; info: NativeAssetInfo; source?: NativeAssetSource }
export interface NativeAssetDiagnostic { id: string; code: string; message: string }
export interface NativeAssetInventory { assets: NativeAssetDescriptor[]; diagnostics: NativeAssetDiagnostic[] }
export interface NativeAssetListRequest { protocolVersion: 1; requestId: string }
export interface NativeAssetImportRequest extends NativeAssetListRequest { kind: AssetRef['kind']; name: string }

export const ASSET_SIZE_LIMITS: Record<AssetRef['kind'], number> = { ir: 8 * 1024 * 1024, nam: 32 * 1024 * 1024 };

function invalid(requestId: string): never {
  throw new NativeError('INVALID_NATIVE_RESPONSE', 'The native asset library returned invalid or mismatched metadata.', requestId);
}
function record(value: unknown, requestId: string, fields: string[], optional: string[] = []): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid(requestId);
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((field) => !fields.includes(field) && !optional.includes(field)) || fields.some((field) => !Object.hasOwn(input, field))) return invalid(requestId);
  return input;
}
function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

export function createNativeAssetListRequest(): NativeAssetListRequest {
  return { protocolVersion: 1, requestId: `assets_${crypto.randomUUID()}` };
}

export function createNativeAssetImportRequest(kind: AssetRef['kind'], name: string): NativeAssetImportRequest {
  const request = createNativeAssetListRequest();
  try { validateAssetRef({ id: '0'.repeat(64), kind, name }); }
  catch (error: unknown) { throw new NativeError('ASSET_IMPORT_INVALID', error instanceof Error ? error.message : 'Invalid asset kind or name.', request.requestId); }
  return { ...request, kind, name };
}

export function validateNativeAssetInfo(input: unknown, asset: AssetRef, requestId: string): NativeAssetInfo {
  const fields = asset.kind === 'ir'
    ? ['kind', 'id', 'assetKind', 'sampleRate', 'channels', 'frames']
    : ['kind', 'id', 'assetKind', 'sampleRate', 'channels', 'architecture', 'modelVersion'];
  const info = record(input, requestId, fields);
  if (info.kind !== 'asset-info' || info.id !== asset.id || info.assetKind !== asset.kind
    || typeof info.sampleRate !== 'number' || !Number.isFinite(info.sampleRate) || info.sampleRate < 8000 || info.sampleRate > 96000) return invalid(requestId);
  if (asset.kind === 'ir') {
    if ((info.channels !== 1 && info.channels !== 2) || typeof info.frames !== 'number' || !Number.isSafeInteger(info.frames)
      || info.frames <= 0 || info.frames > info.sampleRate * 2) return invalid(requestId);
    return { kind: 'asset-info', id: asset.id, assetKind: 'ir', sampleRate: info.sampleRate, channels: info.channels, frames: info.frames };
  }
  if (info.channels !== 1 || (info.architecture !== 'WaveNet' && info.architecture !== 'LSTM')
    || !text(info.modelVersion, 30) || !/^0\.5\.[0-4]$/.test(info.modelVersion)) return invalid(requestId);
  return { kind: 'asset-info', id: asset.id, assetKind: 'nam', sampleRate: info.sampleRate, channels: 1, architecture: info.architecture, modelVersion: info.modelVersion };
}

export function validateTone3000SourceUrl(input: unknown, requestId: string): string {
  if (!text(input, 2048) || [...input].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return invalid(requestId);
  let url: URL;
  try { url = new URL(input); } catch { return invalid(requestId); }
  if (url.protocol !== 'https:' || !['tone3000.com', 'www.tone3000.com'].includes(url.hostname)
    || url.username || url.password || url.port || url.search || url.hash || input.trim() !== input) return invalid(requestId);
  return input;
}

export function validateNativeAssetSource(input: unknown, requestId: string): NativeAssetSource {
  const source = record(input, requestId, ['provider', 'toneId', 'modelId', 'toneName', 'creator', 'license', 'url']);
  const id = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  if (source.provider !== 'tone3000' || !id(source.toneId) || !id(source.modelId)
    || !text(source.toneName, 200) || !text(source.creator, 200) || !text(source.license, 200)) return invalid(requestId);
  return { provider: 'tone3000', toneId: source.toneId, modelId: source.modelId, toneName: source.toneName,
    creator: source.creator, license: source.license, url: validateTone3000SourceUrl(source.url, requestId) };
}

export function validateNativeAssetDescriptor(input: unknown, requestId: string): NativeAssetDescriptor {
  const value = record(input, requestId, ['asset', 'info'], ['source']);
  let asset: AssetRef;
  try { asset = validateAssetRef(value.asset); }
  catch { return invalid(requestId); }
  return { asset, info: validateNativeAssetInfo(value.info, asset, requestId),
    ...(Object.hasOwn(value, 'source') ? { source: validateNativeAssetSource(value.source, requestId) } : {}) };
}

export function validateNativeAssetImportResponse(request: NativeAssetImportRequest, expectedId: string, input: unknown): NativeAssetDescriptor {
  const output = record(input, request.requestId, ['response', 'asset', 'info'], ['source']);
  if (typeof output.response !== 'object' || output.response === null || Array.isArray(output.response)) return invalid(request.requestId);
  const response = output.response as Record<string, unknown>;
  if (response.protocolVersion !== 1 || response.requestId !== request.requestId || typeof response.ok !== 'boolean') return invalid(request.requestId);
  if (!response.ok) {
    const error = record(response.error, request.requestId, ['code', 'message']);
    if (!text(error.code, 200) || !text(error.message, 2000)) return invalid(request.requestId);
    throw new NativeError(error.code, error.message, request.requestId);
  }
  record(response, request.requestId, ['protocolVersion', 'requestId', 'ok', 'result']);
  const saved = validateNativeAssetDescriptor({ asset: output.asset, info: output.info,
    ...(Object.hasOwn(output, 'source') ? { source: output.source } : {}) }, request.requestId);
  // Same-content imports keep the original library name; only bytes and kind determine identity.
  if (saved.asset.id !== expectedId || saved.asset.kind !== request.kind) return invalid(request.requestId);
  const inspected = validateNativeAssetInfo(response.result, saved.asset, request.requestId);
  if (JSON.stringify(inspected) !== JSON.stringify(saved.info)) return invalid(request.requestId);
  return saved;
}

export function validateNativeAssetListResponse(request: NativeAssetListRequest, input: unknown): NativeAssetInventory {
  const output = record(input, request.requestId, ['protocolVersion', 'requestId', 'assets', 'diagnostics']);
  if (output.protocolVersion !== 1 || output.requestId !== request.requestId || !Array.isArray(output.assets)
    || output.assets.length > 128 || !Array.isArray(output.diagnostics) || output.diagnostics.length > 129) return invalid(request.requestId);
  const ids = new Set<string>();
  const assets = output.assets.map((entry: unknown) => {
    const item = validateNativeAssetDescriptor(entry, request.requestId);
    if (ids.has(item.asset.id)) return invalid(request.requestId);
    ids.add(item.asset.id);
    return item;
  });
  const diagnostics = output.diagnostics.map((entry: unknown) => {
    const diagnostic = record(entry, request.requestId, ['id', 'code', 'message']);
    // IDs can describe malformed library directory names, rather than valid content hashes.
    if (!text(diagnostic.id, 200) || !text(diagnostic.code, 200) || !text(diagnostic.message, 2000)) return invalid(request.requestId);
    return { id: diagnostic.id, code: diagnostic.code, message: diagnostic.message };
  });
  return { assets, diagnostics };
}
