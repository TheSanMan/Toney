import { invoke, isTauri } from '@tauri-apps/api/core';
import { createNativeRequest, createNativeRenderRequest, NativeError, validateNativeResponse, type NativeCommand, type NativeResult, type AudioRenderResult } from '../../../../core/native/protocol';
import { inspectPcmWav } from '../../../../core/native/wav';
import type { AssetRef, ToneSpec } from '../../../../core';
import {
  ASSET_SIZE_LIMITS, createNativeAssetImportRequest, createNativeAssetListRequest,
  validateNativeAssetImportResponse, validateNativeAssetListResponse,
  type NativeAssetDescriptor, type NativeAssetInventory,
} from '../../../../core/native/assets';

export const isDesktop = (): boolean => isTauri();

export async function importNativeAsset(kind: AssetRef['kind'], file: File): Promise<{ requestId: string } & NativeAssetDescriptor> {
  const request = createNativeAssetImportRequest(kind, file.name);
  try {
    if (!isDesktop()) throw new NativeError('DESKTOP_REQUIRED', 'Open Toney desktop to import IR and NAM assets.', request.requestId);
    if (file.size <= 0 || file.size > ASSET_SIZE_LIMITS[kind]) throw new NativeError('ASSET_TOO_LARGE', `Choose a nonempty ${kind === 'ir' ? 'IR WAV up to 8 MiB' : 'NAM model up to 32 MiB'}.`, request.requestId);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength !== file.size) throw new NativeError('ASSET_IMPORT_INVALID', 'The selected asset bytes do not match its file size.', request.requestId);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const expectedId = Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const output: unknown = await invoke('native_import_asset', { request: { ...request, data: Array.from(bytes) } });
    return { requestId: request.requestId, ...validateNativeAssetImportResponse(request, expectedId, output) };
  } catch (error: unknown) { throw correlatedError(error, request.requestId); }
}

export async function listNativeAssets(): Promise<{ requestId: string } & NativeAssetInventory> {
  const request = createNativeAssetListRequest();
  try {
    if (!isDesktop()) throw new NativeError('DESKTOP_REQUIRED', 'Open Toney desktop to access the local asset library.', request.requestId);
    const output: unknown = await invoke('native_list_assets', { request });
    return { requestId: request.requestId, ...validateNativeAssetListResponse(request, output) };
  } catch (error: unknown) { throw correlatedError(error, request.requestId); }
}

function correlatedError(error: unknown, requestId: string): NativeError {
  if (error instanceof NativeError) return error;
  const detail = typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error);
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'NATIVE_COMMAND_FAILED';
  return new NativeError(code, detail, requestId);
}

export async function nativeRequest(command: NativeCommand, tone?: ToneSpec): Promise<{ requestId: string; result: NativeResult }> {
  const request = createNativeRequest(command, tone);
  if (!isDesktop()) throw new NativeError('DESKTOP_REQUIRED', 'Open the Toney desktop app to access native audio controls.', request.requestId);
  try {
    const input: unknown = await invoke('native_engine_request', { request });
    return { requestId: request.requestId, result: validateNativeResponse(request, input) };
  } catch (error) {
    throw correlatedError(error, request.requestId);
  }
}

export async function renderNativeAudio(tone: ToneSpec, input: Blob): Promise<{ requestId: string; result: AudioRenderResult; wav: Blob }> {
  const request = createNativeRenderRequest(tone);
  try {
    if (!isDesktop()) throw new NativeError('DESKTOP_REQUIRED', 'Open Toney desktop for native rendering.', request.requestId);
    if (input.size > 32 * 1024 * 1024) throw new Error('Native audio source must be at most 32 MiB.');
    const bytes = new Uint8Array(await input.arrayBuffer());
    const source = inspectPcmWav(bytes);
    if (source.frames > source.sampleRate * 90) throw new Error('Native audio source must be 90 seconds or less.');
    const output: unknown = await invoke('native_render_audio', { request: { protocolVersion: request.protocolVersion,
      requestId: request.requestId, tone: request.tone, data: Array.from(bytes) } });
    if (typeof output !== 'object' || output === null || !('response' in output) || !('data' in output)) throw new Error('Native render returned an invalid envelope.');
    const result = validateNativeResponse(request, output.response);
    if (result.kind !== 'audio-render' || result.sampleRate !== source.sampleRate || result.channels !== source.channels || result.inputFrames !== source.frames) throw new Error('Native render does not match the selected source.');
    if (!Array.isArray(output.data) || output.data.length > 32 * 1024 * 1024
      || output.data.some((value: unknown) => typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255)) throw new Error('Native render returned invalid WAV bytes.');
    const wavBytes = Uint8Array.from(output.data as number[]);
    const audio = inspectPcmWav(wavBytes);
    if (audio.sampleRate !== result.sampleRate || audio.channels !== result.channels || audio.frames !== result.outputFrames
      || audio.peak > 0.8501 || Math.abs(audio.peak - result.peak) > 0.0001) throw new Error('Native WAV does not match its render diagnostics.');
    return { requestId: request.requestId, result, wav: new Blob([wavBytes], { type: 'audio/wav' }) };
  } catch (error) { throw correlatedError(error, request.requestId); }
}

export async function exportNativeFile(name: string, value: Blob): Promise<boolean> {
  if (value.size > 32_000_000) throw new Error('Native file export supports files up to 32 MB.');
  const data = Array.from(new Uint8Array(await value.arrayBuffer()));
  const result = await invoke<{ saved: boolean; path?: string }>('native_export_file', { request: { name, data } });
  return result.saved;
}

export async function desktopOllamaTransport(body: string, signal: AbortSignal): Promise<Response> {
  if (signal.aborted) throw new Error('Local model request cancelled.');
  const result = await invoke<{ status: number; body: unknown }>('native_ollama_chat', { payload: JSON.parse(body) as unknown });
  if (signal.aborted) throw new Error('Local model request cancelled.');
  return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'Content-Type': 'application/json' } });
}
