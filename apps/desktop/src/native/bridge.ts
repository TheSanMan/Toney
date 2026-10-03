import { invoke, isTauri } from '@tauri-apps/api/core';
import { createNativeRequest, NativeError, validateNativeResponse, type NativeCommand, type NativeResult } from '../../../../core/native/protocol';
import type { ToneSpec } from '../../../../core';

export const isDesktop = (): boolean => isTauri();

export async function nativeRequest(command: NativeCommand, tone?: ToneSpec): Promise<{ requestId: string; result: NativeResult }> {
  const request = createNativeRequest(command, tone);
  if (!isDesktop()) throw new NativeError('DESKTOP_REQUIRED', 'Open the Toney desktop app to access native audio controls.', request.requestId);
  try {
    const input: unknown = await invoke('native_engine_request', { request });
    return { requestId: request.requestId, result: validateNativeResponse(request, input) };
  } catch (error) {
    if (error instanceof NativeError) throw error;
    const detail = typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error);
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'NATIVE_COMMAND_FAILED';
    throw new NativeError(code, detail, request.requestId);
  }
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
