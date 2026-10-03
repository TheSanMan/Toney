import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createInitialTone } from '../core';
import { createLiveRequest, validateLiveResponse, type LiveConfiguration, type LiveRequest } from '../core/native/live';
import { NativeError } from '../core/native/protocol';
import { createLiveQueue, LiveInputPanel } from '../apps/desktop/src/native/LiveInputPanel';
import { liveRequest } from '../apps/desktop/src/native/bridge';

const transport = vi.hoisted(() => ({ desktop: false, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => transport.desktop, invoke: transport.invoke }));
const settings: LiveConfiguration = { inputDeviceId: 'CoreAudio:input:0:Interface', outputDeviceId: 'CoreAudio:output:0:Interface',
  inputChannel: 1, sampleRate: 48000, bufferSize: 128, inputGainDb: 0, outputGainDb: -12 };
function envelope(request: LiveRequest, running = true) {
  return { protocolVersion: 1, requestId: request.requestId, ok: true, result: { kind: 'live-status', state: running ? 'running' : 'stopped',
    toneId: running ? request.tone?.id : '', revision: running ? request.tone?.revision : 0,
    sampleRate: running ? 48000 : 0, bufferSize: running ? 128 : 0, inputDeviceId: running ? settings.inputDeviceId : '',
    outputDeviceId: running ? settings.outputDeviceId : '', inputChannel: running ? 1 : 0, inputChannels: running ? 2 : 0,
    outputChannels: running ? 2 : 0, inputPeak: 0, outputPeak: 0, callbackCount: 0, overruns: 0, cpuLoad: 0, latencyMs: 0,
    errorCode: '', errorMessage: '' } };
}

describe('live input contract and controls', () => {
  it('validates configuration and strips arbitrary paths/assets at the frontend boundary', () => {
    const request = createLiveRequest('start', createInitialTone(), { ...settings, assets: [{ path: '/secret' }] } as LiveConfiguration);
    expect(request.live).toEqual(settings);
    for (const change of [{ inputChannel: -1 }, { inputChannel: 32 }, { inputChannel: 0.5 }, { sampleRate: 12345 },
      { bufferSize: 1 }, { inputGainDb: Infinity }, { outputGainDb: 1 }, { inputDeviceId: '' }]) {
      expect(() => createLiveRequest('start', createInitialTone(), { ...settings, ...change } as LiveConfiguration)).toThrow(NativeError);
    }
  });
  it('keeps status/stop path-free and limits updates to tone and trims', () => {
    expect(createLiveRequest('stop')).toEqual({ protocolVersion: 1, requestId: expect.stringMatching(/^live_/) });
    expect(() => createLiveRequest('status', createInitialTone())).toThrow();
    expect(createLiveRequest('update', createInitialTone(), settings).live).toEqual({ inputGainDb: 0, outputGainDb: -12 });
  });
  it('requires rig, request, actual device and rate acknowledgments to match', () => {
    const request = createLiveRequest('start', createInitialTone(), settings);
    const reply = envelope(request);
    expect(validateLiveResponse('start', request, reply).state).toBe('running');
    for (const change of [{ revision: 999 }, { toneId: 'other' }, { sampleRate: 44100 }, { bufferSize: 256 },
      { inputDeviceId: 'microphone' }, { outputDeviceId: 'speakers' }, { inputChannel: 0 }, { outputPeak: NaN },
      { outputPeak: 1 }, { cpuLoad: -1 }, { callbackCount: 0.5 }]) {
      expect(() => validateLiveResponse('start', request, { ...reply, result: { ...reply.result, ...change } })).toThrow(NativeError);
    }
    expect(() => validateLiveResponse('start', request, { ...reply, requestId: 'other' })).toThrow();
  });
  it('propagates correlated device faults and rejects unreported error states', () => {
    const request = createLiveRequest('status');
    expect(() => validateLiveResponse('status', request, { protocolVersion: 1, requestId: request.requestId, ok: false,
      error: { code: 'LIVE_DEVICE_LOST', message: 'Reconnect the interface.' } })).toThrow('Reconnect');
    const error = envelope(request, false); error.result.state = 'error';
    expect(() => validateLiveResponse('status', request, error)).toThrow();
    expect(validateLiveResponse('status', request, { ...error, result: { ...error.result, errorCode: 'LIVE_DEVICE_LOST', errorMessage: 'Restart.' } }).state).toBe('error');
  });
  it('serializes pending operations and recovers its queue after failure', async () => {
    const queue = createLiveQueue();
    const order: string[] = [];
    const failed = queue(async () => { order.push('start'); throw new Error('device fault'); });
    const recovered = queue(async () => { order.push('status'); return 'stopped'; });
    await expect(failed).rejects.toThrow('device fault');
    await expect(recovered).resolves.toBe('stopped');
    expect(order).toEqual(['start', 'status']);
  });
  it('never invokes microphone control from the browser and provides desktop instructions', async () => {
    transport.desktop = false; transport.invoke.mockReset();
    await expect(liveRequest('start', createInitialTone(), settings)).rejects.toMatchObject({ code: 'DESKTOP_REQUIRED' });
    expect(transport.invoke).not.toHaveBeenCalled();
    const markup = renderToStaticMarkup(createElement(LiveInputPanel, { tone: createInitialTone(), locked: false,
      onDiagnostic: () => undefined, onMonitoringChange: () => undefined }));
    expect(markup).toContain('requires the Toney desktop app');
    expect(markup).toContain('INPUT CLOSED');
    expect(markup).not.toContain('<meter');
  });
  it('desktop rendering leaves Start disabled until explicit device selections', () => {
    transport.desktop = true;
    const markup = renderToStaticMarkup(createElement(LiveInputPanel, { tone: createInitialTone(), locked: false,
      inventory: { kind: 'audio-devices', devices: [{ id: settings.inputDeviceId, kind: 'input', name: 'Interface', backend: 'CoreAudio', isDefault: true }] },
      onDiagnostic: () => undefined, onMonitoringChange: () => undefined }));
    expect(markup).toContain('Start live guitar');
    expect(markup).toContain('Choose output device');
    expect(markup).toContain('Output volume · -12 dB');
    expect(transport.invoke).not.toHaveBeenCalled();
    transport.desktop = false;
  });
  it('uses typed native commands and rejects a forged reply before displaying meters', async () => {
    transport.desktop = true;
    transport.invoke.mockImplementation(async (_command, { request }: { request: LiveRequest }) => envelope(request));
    expect((await liveRequest('start', createInitialTone(), settings)).result.state).toBe('running');
    expect(transport.invoke).toHaveBeenCalledWith('native_live_start', { request: expect.objectContaining({ live: settings }) });
    transport.invoke.mockResolvedValue({ protocolVersion: 1, requestId: 'forged', ok: true });
    await expect(liveRequest('status')).rejects.toMatchObject({ code: 'INVALID_LIVE_RESPONSE' });
    expect(transport.invoke).toHaveBeenLastCalledWith('native_live_stop', { request: expect.objectContaining({ protocolVersion: 1 }) });
    transport.desktop = false; transport.invoke.mockReset();
  });
});

const helper = fileURLToPath(new URL('../engine/audio/build/bin/toney-engine', import.meta.url));
describe.skipIf(!existsSync(helper))('real persistent live helper without hardware', () => {
  it('answers multiple correlated status/stop commands then exits on EOF', () => {
    const requests = ['status', 'stop', 'status'].map((operation) => createLiveRequest(operation as 'status' | 'stop'));
    const commands = requests.map((request, index) => ({ ...request, command: index === 1 ? 'stop_live' : 'get_live_status' }));
    const result = spawnSync(helper, ['--live'], { input: `${commands.map((command) => JSON.stringify(command)).join('\n')}\n`, encoding: 'utf8', timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    const replies = result.stdout.trim().split('\n').map((line: string) => JSON.parse(line) as unknown);
    expect(replies).toHaveLength(3);
    replies.forEach((reply, index) => expect(validateLiveResponse(index === 1 ? 'stop' : 'status', requests[index], reply).state).toBe('stopped'));
  });
});
