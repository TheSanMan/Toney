import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelTone3000, downloadTone3000, getTone3000Status, selectTone3000 } from '../apps/desktop/src/native/tone3000';
import type { Tone3000Request, Tone3000SelectRequest, Tone3000DownloadRequest } from '../core/native/tone3000';

const tauri = vi.hoisted(() => ({ invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(), isTauri: vi.fn<() => boolean>() }));
vi.mock('@tauri-apps/api/core', () => tauri);

beforeEach(() => { tauri.invoke.mockReset(); tauri.isTauri.mockReturnValue(true); });

describe('TONE3000 desktop bridge', () => {
  it('correlates the pedal target independently from its NAM asset kind', async () => {
    tauri.invoke.mockImplementation(async (_command, args) => {
      const { request } = args as { request: Tone3000SelectRequest };
      expect(request.target).toBe('drive');
      return { ...request, status: 'authorizing' };
    });
    expect(await selectTone3000('nam', 'drive')).toMatchObject({ target: 'drive', kind: 'nam' });
    tauri.invoke.mockImplementation(async (_command, args) => {
      const { request } = args as { request: Tone3000SelectRequest };
      return { ...request, status: 'authorizing', target: 'amp' };
    });
    await expect(selectTone3000('nam', 'drive')).rejects.toMatchObject({ code: 'INVALID_NATIVE_RESPONSE' });
  });
  it('keeps selection and status requests inside the local native session', async () => {
    tauri.invoke.mockImplementation(async (command, args) => {
      const { request } = args as { request: Tone3000SelectRequest };
      expect(command).toBe('native_tone3000_select');
      expect(request.kind).toBe('nam');
      return { protocolVersion: 1, requestId: request.requestId, status: 'authorizing', kind: 'nam' };
    });
    expect((await selectTone3000('nam')).status).toBe('authorizing');
    tauri.invoke.mockImplementation(async (command, args) => {
      const { request } = args as { request: Tone3000Request };
      expect(command).toBe('native_tone3000_status');
      expect(Object.keys(request)).toEqual(['protocolVersion', 'requestId']);
      return { ...request, status: 'error', kind: 'nam', error: { code: 'AUTH_EXPIRED', message: 'Select a tone again.' } };
    });
    expect(await getTone3000Status()).toMatchObject({ status: 'error', error: { code: 'AUTH_EXPIRED' } });
  });

  it('requires a correlated idle result on cancellation', async () => {
    tauri.invoke.mockImplementation(async (command, args) => {
      expect(command).toBe('native_tone3000_cancel');
      const { request } = args as { request: Tone3000Request };
      return { ...request, status: 'idle' };
    });
    expect((await cancelTone3000()).status).toBe('idle');
    tauri.invoke.mockImplementation(async (_command, args) => {
      const { request } = args as { request: Tone3000Request };
      return { ...request, status: 'loading', kind: 'nam' };
    });
    await expect(cancelTone3000()).rejects.toMatchObject({ code: 'INVALID_NATIVE_RESPONSE' });
  });

  it('downloads only a requested model through native transport and validates persisted provenance', async () => {
    tauri.invoke.mockImplementation(async (command, args) => {
      expect(command).toBe('native_tone3000_download');
      const { request } = args as { request: Tone3000DownloadRequest };
      expect(request.modelId).toBe(34);
      const id = 'a'.repeat(64);
      return { protocolVersion: 1, requestId: request.requestId, descriptor: {
        asset: { id, kind: 'nam', name: 'amp.nam' },
        info: { kind: 'asset-info', id, assetKind: 'nam', sampleRate: 48000, channels: 1, architecture: 'WaveNet', modelVersion: '0.5.4' },
        source: { provider: 'tone3000', toneId: 12, modelId: 34, toneName: 'Amp', creator: 'Player', license: 'CC BY 4.0', url: 'https://tone3000.com/tones/amp' },
      } };
    });
    expect((await downloadTone3000(34)).descriptor.source?.modelId).toBe(34);
    const invocationCount = tauri.invoke.mock.calls.length;
    await expect(downloadTone3000(-1)).rejects.toMatchObject({ code: 'INVALID_TONE3000_REQUEST' });
    expect(tauri.invoke.mock.calls.length).toBe(invocationCount);
  });

  it('rejects stale results and wrong asset kinds while normalizing native failures with the local request ID', async () => {
    tauri.invoke.mockResolvedValueOnce({ protocolVersion: 1, requestId: 'stale', status: 'idle' });
    await expect(getTone3000Status()).rejects.toMatchObject({ code: 'INVALID_NATIVE_RESPONSE' });
    tauri.invoke.mockImplementation(async (_command, args) => {
      const { request } = args as { request: Tone3000Request };
      return { ...request, status: 'authorizing', kind: 'ir' };
    });
    await expect(selectTone3000('nam')).rejects.toMatchObject({ code: 'INVALID_NATIVE_RESPONSE' });
    tauri.invoke.mockRejectedValueOnce({ code: 'TONE3000_TIMEOUT', message: 'Authorization timed out.', requestId: 'untrusted-other-id' });
    await expect(getTone3000Status()).rejects.toMatchObject({ code: 'TONE3000_TIMEOUT', message: 'Authorization timed out.', requestId: expect.stringMatching(/^tone3000_/) });
  });

  it('requires desktop without invoking remote or native operations in the browser', async () => {
    tauri.isTauri.mockReturnValue(false);
    await expect(selectTone3000('nam')).rejects.toMatchObject({ code: 'DESKTOP_REQUIRED' });
    await expect(getTone3000Status()).rejects.toMatchObject({ code: 'DESKTOP_REQUIRED' });
    await expect(cancelTone3000()).rejects.toMatchObject({ code: 'DESKTOP_REQUIRED' });
    await expect(downloadTone3000(34)).rejects.toMatchObject({ code: 'DESKTOP_REQUIRED' });
    expect(tauri.invoke).not.toHaveBeenCalled();
  });
});
