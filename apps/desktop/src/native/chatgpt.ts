import { invoke, isTauri } from '@tauri-apps/api/core';
import { createChatGPTRequest, validateChatGPTStatus, type ChatGPTRequest, type ChatGPTStatus } from '../../../../core/native/chatgpt';
import type { ChatGPTTransport } from '../../../../core/agent/chatgpt';
import { NativeError } from '../../../../core/native/protocol';

async function command(name: string, request: ChatGPTRequest): Promise<unknown> {
  if (!isTauri()) throw new NativeError('DESKTOP_REQUIRED', 'Open Toney desktop to sign in with ChatGPT.', request.requestId);
  try { return await invoke(name, { request }); }
  catch (error: unknown) {
    const value = typeof error === 'object' && error !== null ? error as Record<string, unknown> : undefined;
    const code = typeof value?.code === 'string' ? value.code : 'CHATGPT_COMMAND_FAILED';
    const message = typeof value?.message === 'string' ? value.message : 'The ChatGPT native request failed. Retry or sign in again.';
    if (typeof value?.requestId === 'string' && value.requestId !== request.requestId) throw new NativeError('INVALID_NATIVE_RESPONSE', 'ChatGPT returned an error for another request.', request.requestId);
    throw new NativeError(code, message, request.requestId);
  }
}
async function statusCommand(name: string): Promise<ChatGPTStatus> {
  const request = createChatGPTRequest();
  return validateChatGPTStatus(request, await command(name, request));
}
export const signInChatGPT = (): Promise<ChatGPTStatus> => statusCommand('native_chatgpt_sign_in');
export const getChatGPTStatus = (): Promise<ChatGPTStatus> => statusCommand('native_chatgpt_status');
export const refreshChatGPTModels = (): Promise<ChatGPTStatus> => statusCommand('native_chatgpt_models');
export async function disconnectChatGPT(): Promise<ChatGPTStatus> {
  const result = await statusCommand('native_chatgpt_disconnect');
  if (result.status !== 'disconnected' && !(result.status === 'error' && result.error?.code === 'CHATGPT_REVOCATION_UNCONFIRMED')) throw new NativeError('INVALID_NATIVE_RESPONSE', 'ChatGPT disconnect did not clear the native session.', result.requestId);
  return result;
}
export const desktopChatGPTTransport: ChatGPTTransport = (request) => command('native_chatgpt_interpret', request);
