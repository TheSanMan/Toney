import { invoke, isTauri } from '@tauri-apps/api/core';
import type { AssetRef } from '../../../../core';
import { NativeError } from '../../../../core/native/protocol';
import {
  createTone3000DownloadRequest, createTone3000Request, createTone3000SelectRequest,
  validateTone3000DownloadResponse, validateTone3000Status,
  type Tone3000DownloadResult, type Tone3000Request, type Tone3000Status,
  type Tone3000Target,
} from '../../../../core/native/tone3000';

async function localCommand(command: string, request: Tone3000Request): Promise<unknown> {
  if (!isTauri()) throw new NativeError('DESKTOP_REQUIRED', 'Open Toney desktop to select a model from TONE3000.', request.requestId);
  try { return await invoke(command, { request }); }
  catch (error: unknown) {
    if (error instanceof NativeError) throw error;
    const value = typeof error === 'object' && error !== null ? error as Record<string, unknown> : undefined;
    const code = typeof value?.code === 'string' ? value.code : 'TONE3000_COMMAND_FAILED';
    const message = typeof value?.message === 'string' ? value.message : error instanceof Error ? error.message : 'The TONE3000 native request failed.';
    throw new NativeError(code, message, request.requestId);
  }
}

export async function selectTone3000(kind: AssetRef['kind'], target: Tone3000Target = kind === 'nam' ? 'amp' : 'cab'): Promise<Tone3000Status> {
  const request = createTone3000SelectRequest(kind, target);
  const status = validateTone3000Status(request, await localCommand('native_tone3000_select', request));
  if (status.kind !== undefined && status.kind !== kind) throw new NativeError('INVALID_NATIVE_RESPONSE', 'TONE3000 selection does not match the requested asset kind.', request.requestId);
  if (status.kind !== undefined && (status.target ?? (status.kind === 'nam' ? 'amp' : 'cab')) !== target) throw new NativeError('INVALID_NATIVE_RESPONSE', 'TONE3000 selection does not match the requested signal block.', request.requestId);
  return status;
}

/** This asks the local native session for status; it does not poll the remote API. */
export async function getTone3000Status(): Promise<Tone3000Status> {
  const request = createTone3000Request();
  return validateTone3000Status(request, await localCommand('native_tone3000_status', request));
}

export async function cancelTone3000(): Promise<Tone3000Status> {
  const request = createTone3000Request();
  const status = validateTone3000Status(request, await localCommand('native_tone3000_cancel', request));
  if (status.status !== 'idle') throw new NativeError('INVALID_NATIVE_RESPONSE', 'TONE3000 cancellation did not clear the local selection session.', request.requestId);
  return status;
}

export async function downloadTone3000(modelId: number): Promise<Tone3000DownloadResult> {
  const request = createTone3000DownloadRequest(modelId);
  return validateTone3000DownloadResponse(request, await localCommand('native_tone3000_download', request));
}
