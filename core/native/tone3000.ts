import type { AssetRef } from '../tone/types';
import { validateNativeAssetDescriptor, validateTone3000SourceUrl, type NativeAssetDescriptor } from './assets';
import { NativeError } from './protocol';

export interface Tone3000Request { protocolVersion: 1; requestId: string }
export interface Tone3000SelectRequest extends Tone3000Request { kind: AssetRef['kind'] }
export interface Tone3000DownloadRequest extends Tone3000Request { modelId: number }
export interface Tone3000Model { id: number; name: string }
export interface Tone3000Selection { toneId: number; name: string; creator: string; license: string; url: string; models: Tone3000Model[] }
export interface Tone3000Failure { code: string; message: string }
export type Tone3000Status = Tone3000Request & (
  | { status: 'idle'; kind?: never; selection?: never; error?: never }
  | { status: 'authorizing' | 'loading'; kind: AssetRef['kind']; selection?: never; error?: never }
  | { status: 'ready'; kind: AssetRef['kind']; selection: Tone3000Selection; error?: never }
  | { status: 'error'; kind?: AssetRef['kind']; selection?: never; error: Tone3000Failure }
);
export interface Tone3000DownloadResult extends Tone3000Request { descriptor: NativeAssetDescriptor }

function invalid(requestId: string): never {
  throw new NativeError('INVALID_NATIVE_RESPONSE', 'TONE3000 returned invalid or mismatched local selection metadata.', requestId);
}
function object(input: unknown, requestId: string, required: string[], optional: string[] = []): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid(requestId);
  const value = input as Record<string, unknown>;
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) return invalid(requestId);
  return value;
}
function positiveId(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function text(value: unknown, max = 200): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= max; }
function kind(value: unknown): value is AssetRef['kind'] { return value === 'ir' || value === 'nam'; }

export function createTone3000Request(): Tone3000Request {
  return { protocolVersion: 1, requestId: `tone3000_${crypto.randomUUID()}` };
}
export function createTone3000SelectRequest(assetKind: AssetRef['kind']): Tone3000SelectRequest {
  const request = createTone3000Request();
  if (!kind(assetKind)) throw new NativeError('INVALID_TONE3000_REQUEST', 'Select NAM or IR.', request.requestId);
  return { ...request, kind: assetKind };
}
export function createTone3000DownloadRequest(modelId: number): Tone3000DownloadRequest {
  const request = createTone3000Request();
  if (!positiveId(modelId)) throw new NativeError('INVALID_TONE3000_REQUEST', 'Choose a valid model from the current selection.', request.requestId);
  return { ...request, modelId };
}

function selection(input: unknown, requestId: string): Tone3000Selection {
  const value = object(input, requestId, ['toneId', 'name', 'creator', 'license', 'url', 'models']);
  if (!positiveId(value.toneId) || !text(value.name) || !text(value.creator) || !text(value.license)
    || !Array.isArray(value.models) || value.models.length < 1 || value.models.length > 128) return invalid(requestId);
  const ids = new Set<number>();
  const models = value.models.map((inputModel: unknown) => {
    const model = object(inputModel, requestId, ['id', 'name']);
    if (!positiveId(model.id) || !text(model.name) || ids.has(model.id)) return invalid(requestId);
    ids.add(model.id);
    return { id: model.id, name: model.name };
  });
  return { toneId: value.toneId, name: value.name, creator: value.creator, license: value.license,
    url: validateTone3000SourceUrl(value.url, requestId), models };
}

export function validateTone3000Status(request: Tone3000Request, input: unknown): Tone3000Status {
  const value = object(input, request.requestId, ['protocolVersion', 'requestId', 'status'], ['kind', 'selection', 'error']);
  if (value.protocolVersion !== 1 || value.requestId !== request.requestId) return invalid(request.requestId);
  const base: Tone3000Request = { protocolVersion: 1, requestId: request.requestId };
  switch (value.status) {
    case 'idle':
      if (Object.hasOwn(value, 'kind') || Object.hasOwn(value, 'selection') || Object.hasOwn(value, 'error')) return invalid(request.requestId);
      return { ...base, status: 'idle' };
    case 'authorizing': case 'loading':
      if (!kind(value.kind) || Object.hasOwn(value, 'selection') || Object.hasOwn(value, 'error')) return invalid(request.requestId);
      return { ...base, status: value.status, kind: value.kind };
    case 'ready':
      if (!kind(value.kind) || Object.hasOwn(value, 'error')) return invalid(request.requestId);
      return { ...base, status: 'ready', kind: value.kind, selection: selection(value.selection, request.requestId) };
    case 'error': {
      if ((Object.hasOwn(value, 'kind') && !kind(value.kind)) || Object.hasOwn(value, 'selection')) return invalid(request.requestId);
      const error = object(value.error, request.requestId, ['code', 'message']);
      if (!text(error.code) || !text(error.message, 2000)) return invalid(request.requestId);
      return { ...base, status: 'error', ...(kind(value.kind) ? { kind: value.kind } : {}), error: { code: error.code, message: error.message } };
    }
    default: return invalid(request.requestId);
  }
}

export function validateTone3000DownloadResponse(request: Tone3000DownloadRequest, input: unknown): Tone3000DownloadResult {
  const value = object(input, request.requestId, ['protocolVersion', 'requestId', 'descriptor']);
  if (value.protocolVersion !== 1 || value.requestId !== request.requestId) return invalid(request.requestId);
  const descriptor = validateNativeAssetDescriptor(value.descriptor, request.requestId);
  if (!descriptor.source || descriptor.source.modelId !== request.modelId) return invalid(request.requestId);
  return { protocolVersion: 1, requestId: request.requestId, descriptor };
}
