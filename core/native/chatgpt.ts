import { validateInterpretation, type Interpretation, type ProviderRequest } from '../agent/types';
import { validateToneIntent, validateToneSpec } from '../tone/validation';
import { NativeError } from './protocol';

export interface ChatGPTRequest { protocolVersion: 1; requestId: string }
export interface ChatGPTModel { slug: string; displayName: string }
export interface ChatGPTStatus extends ChatGPTRequest {
  status: 'disconnected' | 'authorizing' | 'connected' | 'error';
  account?: { email?: string };
  models: ChatGPTModel[];
  error?: { code: string; message: string; requestId: string };
}
export interface ChatGPTInterpretRequest extends ChatGPTRequest, ProviderRequest { model: string }
export interface ChatGPTInterpretResponse extends ChatGPTRequest { model: string; interpretation: Interpretation }

const text = (value: unknown, limit = 200): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
function invalid(id: string): never { throw new NativeError('INVALID_NATIVE_RESPONSE', 'ChatGPT returned invalid or mismatched native metadata.', id); }
function object(input: unknown, id: string, required: string[], optional: string[] = []): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid(id);
  const value = input as Record<string, unknown>;
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) return invalid(id);
  return value;
}
function envelope(request: ChatGPTRequest, value: Record<string, unknown>): void {
  if (value.protocolVersion !== 1 || value.requestId !== request.requestId) invalid(request.requestId);
}
export function createChatGPTRequest(): ChatGPTRequest { return { protocolVersion: 1, requestId: `chatgpt_${crypto.randomUUID()}` }; }
export function createChatGPTInterpretRequest(model: string, input: ProviderRequest): ChatGPTInterpretRequest {
  const request = createChatGPTRequest();
  if (!text(model) || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 2000) throw new NativeError('INVALID_CHATGPT_REQUEST', 'Choose a discovered model and enter a tone description of 1–2000 characters.', request.requestId);
  return { ...request, model, prompt: input.prompt, baseline: validateToneIntent(input.baseline), ...(input.currentTone ? { currentTone: validateToneSpec(input.currentTone) } : {}) };
}
export function validateChatGPTStatus(request: ChatGPTRequest, input: unknown): ChatGPTStatus {
  const value = object(input, request.requestId, ['protocolVersion', 'requestId', 'status', 'models'], ['account', 'error']);
  envelope(request, value);
  if (!['disconnected', 'authorizing', 'connected', 'error'].includes(String(value.status)) || !Array.isArray(value.models) || value.models.length > 128) return invalid(request.requestId);
  const slugs = new Set<string>();
  const models = value.models.map((item: unknown) => {
    const model = object(item, request.requestId, ['slug', 'displayName']);
    if (!text(model.slug) || !text(model.displayName) || slugs.has(model.slug)) return invalid(request.requestId);
    slugs.add(model.slug);
    return { slug: model.slug, displayName: model.displayName };
  });
  const result: ChatGPTStatus = { ...request, status: value.status as ChatGPTStatus['status'], models };
  if (Object.hasOwn(value, 'account')) {
    const account = object(value.account, request.requestId, [], ['email']);
    if (Object.hasOwn(account, 'email') && !text(account.email, 320)) return invalid(request.requestId);
    result.account = typeof account.email === 'string' ? { email: account.email } : {};
  }
  if (value.status === 'error') {
    const error = object(value.error, request.requestId, ['code', 'message', 'requestId']);
    if (!text(error.code) || !text(error.message, 2000) || error.requestId !== request.requestId) return invalid(request.requestId);
    result.error = { code: error.code, message: error.message, requestId: request.requestId };
  } else if (Object.hasOwn(value, 'error')) return invalid(request.requestId);
  if ((value.status === 'disconnected' || value.status === 'authorizing') && (Object.hasOwn(value, 'account') || models.length !== 0)) return invalid(request.requestId);
  return result;
}
export function validateChatGPTInterpretResponse(request: ChatGPTInterpretRequest, input: unknown): ChatGPTInterpretResponse {
  const value = object(input, request.requestId, ['protocolVersion', 'requestId', 'model', 'interpretation']);
  envelope(request, value);
  if (value.model !== request.model) return invalid(request.requestId);
  try { return { protocolVersion: 1, requestId: request.requestId, model: request.model, interpretation: validateInterpretation(value.interpretation) }; }
  catch (error: unknown) { throw new NativeError('INVALID_CHATGPT_INTERPRETATION', error instanceof Error ? error.message : 'ChatGPT returned invalid tone intent. The rig was not changed.', request.requestId); }
}

/** Preference applies only to model slugs returned for the active account. */
export function bestAvailableChatGPTModel(models: ChatGPTModel[]): string {
  return ['gpt-6-astra', 'gpt-6.1-sol'].find((slug) => models.some((model) => model.slug === slug)) ?? models[0]?.slug ?? '';
}
export function selectChatGPTModel(models: ChatGPTModel[], selected = ''): string {
  return models.some((model) => model.slug === selected) ? selected : bestAvailableChatGPTModel(models);
}
