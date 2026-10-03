import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_INTENT } from '../core';
import { createChatGPTInterpretRequest } from '../core/native/chatgpt';
import { desktopChatGPTTransport, disconnectChatGPT, getChatGPTStatus, refreshChatGPTModels, signInChatGPT } from '../apps/desktop/src/native/chatgpt';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => mocks);

beforeEach(() => { mocks.isTauri.mockReturnValue(true); mocks.invoke.mockImplementation(async (_name, { request }) => ({ ...request, status: 'disconnected', models: [] })); });
afterEach(() => vi.resetAllMocks());

describe('ChatGPT desktop bridge', () => {
  it('calls only the fixed native command with a versioned correlated request', async () => {
    for (const [action, command] of [[signInChatGPT, 'native_chatgpt_sign_in'], [getChatGPTStatus, 'native_chatgpt_status'], [refreshChatGPTModels, 'native_chatgpt_models'], [disconnectChatGPT, 'native_chatgpt_disconnect']] as const) {
      const result = await action();
      expect(mocks.invoke).toHaveBeenLastCalledWith(command, { request: { protocolVersion: 1, requestId: result.requestId } });
    }
  });
  it('rejects browser use before invocation and malformed disconnect responses', async () => {
    mocks.isTauri.mockReturnValue(false);
    await expect(signInChatGPT()).rejects.toMatchObject({ code: 'DESKTOP_REQUIRED' });
    expect(mocks.invoke).not.toHaveBeenCalled();
    mocks.isTauri.mockReturnValue(true);
    mocks.invoke.mockImplementation(async (_name, { request }) => ({ ...request, status: 'connected', models: [] }));
    await expect(disconnectChatGPT()).rejects.toMatchObject({ code: 'INVALID_NATIVE_RESPONSE' });
  });
  it('preserves the remote revocation warning after local disconnect', async () => {
    mocks.invoke.mockImplementation(async (_name, { request }) => ({ ...request, status: 'error', models: [], error: { code: 'CHATGPT_REVOCATION_UNCONFIRMED', message: 'Signed out locally. Disconnect Toney in ChatGPT Settings.', requestId: request.requestId } }));
    expect((await disconnectChatGPT()).error?.code).toBe('CHATGPT_REVOCATION_UNCONFIRMED');
  });
  it('preserves native failure codes and rejects mismatched native error correlation', async () => {
    mocks.invoke.mockRejectedValue({ code: 'CHATGPT_USAGE_LIMIT', message: 'Plan limit reached' });
    await expect(getChatGPTStatus()).rejects.toMatchObject({ code: 'CHATGPT_USAGE_LIMIT', message: 'Plan limit reached' });
    mocks.invoke.mockRejectedValue({ code: 'FAILED', message: 'Failed', requestId: 'another-request' });
    await expect(getChatGPTStatus()).rejects.toMatchObject({ code: 'INVALID_NATIVE_RESPONSE' });
  });
  it('sends interpretation context with no credential or API endpoint argument', async () => {
    const request = createChatGPTInterpretRequest('account-model', { prompt: 'clear chords', baseline: DEFAULT_INTENT });
    mocks.invoke.mockResolvedValue({});
    await desktopChatGPTTransport(request);
    expect(mocks.invoke).toHaveBeenCalledWith('native_chatgpt_interpret', { request });
    expect(JSON.stringify(request)).not.toMatch(/token|https:|audio/);
  });
});
