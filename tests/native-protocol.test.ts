import { describe, expect, it } from 'vitest';
import { createInitialTone } from '../core';
import { createNativeRequest, validateNativeResponse } from '../core/native/protocol';

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
});
