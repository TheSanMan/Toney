import { describe, expect, it } from 'vitest';
import { createInitialTone } from '../core';
import { createNativeRequest, createNativeRenderRequest, validateNativeResponse } from '../core/native/protocol';

describe('native control boundary', () => {
  it('rejects mismatched request IDs, protocol versions and wrong result types', () => {
    const request = createNativeRequest('get_audio_devices');
    const result = { kind: 'audio-devices', devices: [] };
    expect(validateNativeResponse(request, { protocolVersion: 1, requestId: request.requestId, ok: true, result })).toEqual(result);
    for (const response of [
      { protocolVersion: 2, requestId: request.requestId, ok: true, result },
      { protocolVersion: 1, requestId: 'stale-request', ok: true, result },
      { protocolVersion: 1, requestId: request.requestId, ok: true, result: { kind: 'engine-info' } },
    ]) expect(() => validateNativeResponse(request, response)).toThrow('mismatched response');
  });
  it('validates real device descriptors and rejects duplicate IDs or malformed flags', () => {
    const request = createNativeRequest('get_audio_devices');
    const device = { id: 'core-audio:out:test', name: 'Test speaker', kind: 'output', backend: 'CoreAudio', isDefault: true };
    const response = (devices: unknown[]) => ({ protocolVersion: 1, requestId: request.requestId, ok: true, result: { kind: 'audio-devices', devices } });
    expect(validateNativeResponse(request, response([device]))).toEqual({ kind: 'audio-devices', devices: [device] });
    expect(() => validateNativeResponse(request, response([device, device]))).toThrow();
    expect(() => validateNativeResponse(request, response([{ ...device, isDefault: 'true' }]))).toThrow();
  });
  it('correlates a native rig acknowledgement with its canonical revision and bypass states', () => {
    const tone = createInitialTone();
    tone.chain[0]!.enabled = false;
    const request = createNativeRequest('validate_tone_spec', tone);
    const result = { kind: 'rig-valid', toneId: tone.id, revision: tone.revision, nodeCount: tone.chain.length, activeNodeCount: tone.chain.length - 1 };
    const response = { protocolVersion: 1, requestId: request.requestId, ok: true, result };
    expect(validateNativeResponse(request, response)).toEqual(result);
    expect(() => validateNativeResponse(request, { ...response, result: { ...result, revision: tone.revision + 1 } })).toThrow();
    expect(() => validateNativeResponse(request, { ...response, result: { ...result, activeNodeCount: tone.chain.length } })).toThrow();
  });
  it('preserves native error codes and correlation for diagnosis', () => {
    const request = createNativeRequest('get_engine_info');
    expect(() => validateNativeResponse(request, { protocolVersion: 1, requestId: request.requestId, ok: false, error: { code: 'DEVICE_SCAN_FAILED', message: 'Device scan failed' } })).toThrowError(expect.objectContaining({ code: 'DEVICE_SCAN_FAILED', requestId: request.requestId }));
    expect(() => createNativeRequest('validate_tone_spec')).toThrow('A rig is required');
    expect(() => createNativeRequest('get_audio_devices', createInitialTone())).toThrow('does not accept a rig');
  });
  it('accepts only bounded, finite render metadata for the requested rig revision', () => {
    const tone = createInitialTone();
    const request = createNativeRenderRequest(tone);
    const result = { kind: 'audio-render', toneId: tone.id, revision: tone.revision, sampleRate: 44100, channels: 2,
      inputFrames: 44100, outputFrames: 88200, peak: 0.5, attenuationDb: 0, engineVersion: '0.3.0' };
    const response = { protocolVersion: 1, requestId: request.requestId, ok: true, result };
    expect(validateNativeResponse(request, response)).toEqual(result);
    for (const change of [
      { toneId: 'other-rig' }, { revision: tone.revision + 1 }, { sampleRate: 192000 }, { channels: '2' },
      { inputFrames: 0 }, { inputFrames: 44100 * 91 }, { outputFrames: 44099 }, { outputFrames: 44100 * 14 },
      { peak: 1 }, { peak: Number.NaN }, { attenuationDb: 0.1 }, { attenuationDb: -Infinity },
    ]) expect(() => validateNativeResponse(request, { ...response, result: { ...result, ...change } })).toThrow('mismatched response');
    expect(() => validateNativeResponse(request, { ...response, result: { ...result, sampleRate: 96000, inputFrames: 96000 * 90, outputFrames: 96000 * 90 } })).toThrow();
  });
});
