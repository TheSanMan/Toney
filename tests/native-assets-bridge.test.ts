import { beforeEach, describe, expect, it, vi } from 'vitest';
import { importNativeAsset, listNativeAssets } from '../apps/desktop/src/native/bridge';
import type { NativeAssetImportRequest, NativeAssetListRequest } from '../core/native/assets';

const tauri = vi.hoisted(() => ({ invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(), isTauri: vi.fn<() => boolean>() }));
vi.mock('@tauri-apps/api/core', () => tauri);
const hash = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

beforeEach(() => { tauri.invoke.mockReset(); tauri.isTauri.mockReturnValue(true); });

describe('desktop asset bridge', () => {
  it('hashes original bytes and accepts a retained name from same-content reimport', async () => {
    tauri.invoke.mockImplementation(async (command, args) => {
      expect(command).toBe('native_import_asset');
      const { request } = args as { request: NativeAssetImportRequest & { data: number[] } };
      expect(request.data).toEqual([97, 98, 99]);
      expect(request.name).toBe('renamed.wav');
      const info = { kind: 'asset-info', id: hash, assetKind: 'ir', sampleRate: 48000, channels: 1, frames: 16 };
      return { response: { protocolVersion: 1, requestId: request.requestId, ok: true, result: info }, asset: { id: hash, kind: 'ir', name: 'original.wav' }, info };
    });
    const result = await importNativeAsset('ir', new File(['abc'], 'renamed.wav'));
    expect(result.asset.name).toBe('original.wav');
    expect(result.asset.id).toBe(hash);
    expect(result.requestId).toMatch(/^assets_/);
  });

  it('rejects empty/oversized files before reading or invoking the native command', async () => {
    for (const [kind, size] of [['ir', 0], ['ir', 8 * 1024 * 1024 + 1], ['nam', 32 * 1024 * 1024 + 1]] as const) {
      const arrayBuffer = vi.fn<() => Promise<ArrayBuffer>>();
      const file = { name: kind === 'ir' ? 'cab.wav' : 'amp.nam', size, arrayBuffer } as unknown as File;
      await expect(importNativeAsset(kind, file)).rejects.toMatchObject({ code: 'ASSET_TOO_LARGE', requestId: expect.stringMatching(/^assets_/) });
      expect(arrayBuffer).not.toHaveBeenCalled();
    }
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it('rejects a mismatched returned hash and keeps native failure correlation', async () => {
    tauri.invoke.mockImplementation(async (_command, args) => {
      const { request } = args as { request: NativeAssetImportRequest };
      const id = 'a'.repeat(64);
      const info = { kind: 'asset-info', id, assetKind: 'ir', sampleRate: 48000, channels: 1, frames: 16 };
      return { response: { protocolVersion: 1, requestId: request.requestId, ok: true, result: info }, asset: { id, kind: 'ir', name: 'cab.wav' }, info };
    });
    await expect(importNativeAsset('ir', new File(['abc'], 'cab.wav'))).rejects.toMatchObject({ code: 'INVALID_NATIVE_RESPONSE', requestId: expect.stringMatching(/^assets_/) });
    tauri.invoke.mockRejectedValueOnce({ code: 'ASSET_INVALID', message: 'Invalid model.' });
    await expect(importNativeAsset('nam', new File(['abc'], 'amp.nam'))).rejects.toMatchObject({ code: 'ASSET_INVALID', requestId: expect.stringMatching(/^assets_/) });
  });

  it('correlates library listing and rejects a stale response', async () => {
    tauri.invoke.mockImplementation(async (command, args) => {
      expect(command).toBe('native_list_assets');
      const { request } = args as { request: NativeAssetListRequest };
      return { ...request, assets: [], diagnostics: [] };
    });
    const result = await listNativeAssets();
    expect(result.assets).toEqual([]);
    expect(result.requestId).toMatch(/^assets_/);
    tauri.invoke.mockResolvedValueOnce({ protocolVersion: 1, requestId: 'stale', assets: [], diagnostics: [] });
    await expect(listNativeAssets()).rejects.toMatchObject({ code: 'INVALID_NATIVE_RESPONSE' });
  });

  it('requires desktop before accessing asset files or the library', async () => {
    tauri.isTauri.mockReturnValue(false);
    await expect(importNativeAsset('ir', new File(['abc'], 'cab.wav'))).rejects.toMatchObject({ code: 'DESKTOP_REQUIRED' });
    await expect(listNativeAssets()).rejects.toMatchObject({ code: 'DESKTOP_REQUIRED' });
    expect(tauri.invoke).not.toHaveBeenCalled();
  });
});
