import { describe, expect, it } from 'vitest';
import { ChatGPTProvider, DEFAULT_INTENT, ToneAgent, createInitialTone, validateInterpretation } from '../core';
import { bestAvailableChatGPTModel, selectChatGPTModel, createChatGPTInterpretRequest, createChatGPTRequest, validateChatGPTInterpretResponse, validateChatGPTStatus } from '../core/native/chatgpt';
import { NativeError } from '../core/native/protocol';

const interpretation = () => ({ intent: structuredClone(DEFAULT_INTENT), changedPaths: ['character.width'], warnings: [], issues: [], explanation: 'A little chorus adds spread while the dry center preserves a clear pick attack. Audition the balance with your guitar.' });
const models = [{ slug: 'server-first', displayName: 'First account choice' }, { slug: 'server-second', displayName: 'Second account choice' }];

describe('ChatGPT native contracts', () => {
  it('prefers Astra only when discovered, falls back to Sol then server order, and preserves user choices', () => {
    const sol = { slug: 'gpt-6.1-sol', displayName: 'Sol' };
    const astra = { slug: 'gpt-6-astra', displayName: 'Astra' };
    expect(bestAvailableChatGPTModel([...models, sol, astra])).toBe(astra.slug);
    expect(bestAvailableChatGPTModel([...models, sol])).toBe(sol.slug);
    expect(bestAvailableChatGPTModel(models)).toBe(models[0].slug);
    expect(bestAvailableChatGPTModel([])).toBe('');
    expect(selectChatGPTModel([...models, astra], models[1].slug)).toBe(models[1].slug);
    expect(selectChatGPTModel([...models, astra], 'removed-model')).toBe(astra.slug);
  });
  it('keeps the live account catalog order and accepts only public account data', () => {
    const request = createChatGPTRequest();
    const value = { ...request, status: 'connected', account: { email: 'player@example.com' }, models };
    expect(validateChatGPTStatus(request, value).models).toEqual(models);
    expect(() => validateChatGPTStatus(request, { ...value, access_token: 'secret' })).toThrow(NativeError);
    expect(() => validateChatGPTStatus(request, { ...value, account: { email: 'player@example.com', idToken: 'secret' } })).toThrow(NativeError);
  });
  it('rejects unmatched version/ID, duplicate models, oversized catalogs and invalid state fields', () => {
    const request = createChatGPTRequest();
    const value = { ...request, status: 'connected', models };
    for (const bad of [
      { ...value, protocolVersion: 2 }, { ...value, requestId: 'other' },
      { ...value, models: [models[0], models[0]] },
      { ...value, models: Array.from({ length: 129 }, (_, index) => ({ slug: `m${index}`, displayName: 'Model' })) },
      { ...value, status: 'disconnected' }, { ...value, status: 'authorizing', account: {} },
      { ...value, models: [{ slug: 'm', displayName: '' }] }, { ...value, error: null },
    ]) expect(() => validateChatGPTStatus(request, bad)).toThrow(NativeError);
  });
  it('correlates native status errors and preserves an actionable usage failure', () => {
    const request = createChatGPTRequest();
    const value = { ...request, status: 'error', models: [], error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'ChatGPT plan usage limit reached. Try again after it resets.', requestId: request.requestId } };
    expect(validateChatGPTStatus(request, value).error?.code).toBe(value.error.code);
    expect(() => validateChatGPTStatus(request, { ...value, error: { ...value.error, requestId: 'other' } })).toThrow(NativeError);
  });
  it('correlates completed inference with the selected model and validates intent', () => {
    const request = createChatGPTInterpretRequest('server-first', { prompt: 'Make it wider', baseline: DEFAULT_INTENT });
    const response = { protocolVersion: 1, requestId: request.requestId, model: request.model, interpretation: interpretation() };
    expect(validateChatGPTInterpretResponse(request, response).interpretation.explanation).toContain('dry center');
    for (const bad of [
      { ...response, requestId: 'other' }, { ...response, model: 'unselected-model' },
      { ...response, interpretation: { ...interpretation(), changedPaths: ['shell.exec'] } },
      { ...response, interpretation: { ...interpretation(), explanation: 'x'.repeat(2001) } },
      { ...response, interpretation: { ...interpretation(), secret: 'token' } },
      { ...response, interpretation: { ...interpretation(), issues: ['muddy', 'muddy'] } },
    ]) expect(() => validateChatGPTInterpretResponse(request, bad)).toThrow(NativeError);
  });
  it('validates requests before transport and sends only textual tone context', () => {
    expect(() => createChatGPTInterpretRequest('', { prompt: 'wide', baseline: DEFAULT_INTENT })).toThrow(NativeError);
    expect(() => createChatGPTInterpretRequest('m', { prompt: 'x'.repeat(2001), baseline: DEFAULT_INTENT })).toThrow(NativeError);
    const request = createChatGPTInterpretRequest('m', { prompt: 'wide', baseline: DEFAULT_INTENT, currentTone: createInitialTone() });
    expect(Object.keys(request).sort()).toEqual(['baseline', 'currentTone', 'model', 'prompt', 'protocolVersion', 'requestId']);
  });
});

describe('ChatGPT tone provider', () => {
  it('compiles structured intent and displays the validated engineering explanation', async () => {
    const provider = new ChatGPTProvider('server-first', async (request) => {
      const value = interpretation();
      value.intent.character.width = Math.min(1, request.baseline.character.width + .2);
      return { protocolVersion: 1, requestId: request.requestId, model: request.model, interpretation: value };
    });
    const tone = createInitialTone();
    const result = await new ToneAgent(provider).run({ prompt: 'a little wider', currentTone: tone });
    expect(result.tone.revision).toBe(tone.revision + 1);
    expect(result.message).toBe(result.explanation);
    expect(result.trace.provider).toBe('ChatGPT (server-first)');
    expect(result.tone.chain.map((node) => node.id)).toEqual(tone.chain.map((node) => node.id));
  });
  it('does not substitute offline rules after a plan usage limit error', async () => {
    const provider = new ChatGPTProvider('m', async (request) => { throw new NativeError('CHATGPT_USAGE_LIMIT', 'ChatGPT plan usage limit reached.', request.requestId); });
    try {
      await new ToneAgent(provider).run({ prompt: 'bright' });
      throw new Error('Expected usage failure');
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'INTENT_PROVIDER_FAILED', message: 'ChatGPT plan usage limit reached.', trace: { provider: 'ChatGPT (m)' } });
      const trace = (error as { trace: { events: { detail: string }[] } }).trace;
      expect(trace.events.at(-1)?.detail).toMatch(/CHATGPT_USAGE_LIMIT.*Native request chatgpt_/);
    }
  });
  it('keeps a current rig for advisory responses with no changes and rejects malformed explanations', async () => {
    const value = { ...interpretation(), changedPaths: [] };
    const provider = new ChatGPTProvider('m', async (request) => ({ protocolVersion: 1, requestId: request.requestId, model: request.model, interpretation: value }));
    const tone = createInitialTone();
    const result = await new ToneAgent(provider).run({ prompt: 'Explain this rig', currentTone: tone });
    expect(result.tone).toEqual(tone);
    expect(result.message).toBe(value.explanation);
    expect(() => validateInterpretation({ ...value, explanation: '\u0000bad' })).toThrow();
    expect(() => validateInterpretation({ ...value, explanation: null })).toThrow();
  });
});
