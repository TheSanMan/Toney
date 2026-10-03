import { validateToneSpec, type ToneSpec } from '../index';

export type NativeCommand = 'get_engine_info' | 'get_audio_devices' | 'validate_tone_spec';
export interface NativeRequest { protocolVersion: 1; requestId: string; command: NativeCommand; tone?: ToneSpec }
export interface NativeAudioDevice { id: string; name: string; kind: 'input' | 'output'; backend: string; isDefault: boolean }
export interface EngineInfo { kind: 'engine-info'; engineVersion: string; backend: string; capabilities: string[] }
export interface DeviceInventory { kind: 'audio-devices'; devices: NativeAudioDevice[] }
export interface RigValidation { kind: 'rig-valid'; toneId: string; revision: number; nodeCount: number; activeNodeCount: number }
export type NativeResult = EngineInfo | DeviceInventory | RigValidation;

export class NativeError extends Error {
  constructor(readonly code: string, message: string, readonly requestId: string) {
    super(message); this.name = 'NativeError';
  }
}

export function createNativeRequest(command: NativeCommand, tone?: ToneSpec): NativeRequest {
  const requestId = `native_${crypto.randomUUID()}`;
  if (command === 'validate_tone_spec') {
    if (!tone) throw new NativeError('INVALID_NATIVE_REQUEST', 'A rig is required for validation.', requestId);
    return { protocolVersion: 1, requestId, command, tone: validateToneSpec(tone) };
  }
  if (tone) throw new NativeError('INVALID_NATIVE_REQUEST', 'This operation does not accept a rig.', requestId);
  return { protocolVersion: 1, requestId, command };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 1000; }
function count(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }

export function validateNativeResponse(request: NativeRequest, input: unknown): NativeResult {
  const invalid = (): never => { throw new NativeError('INVALID_NATIVE_RESPONSE', 'The native helper returned an invalid or mismatched response.', request.requestId); };
  if (!record(input) || input.protocolVersion !== 1 || input.requestId !== request.requestId || typeof input.ok !== 'boolean') return invalid();
  if (!input.ok) {
    if (!record(input.error) || !text(input.error.code) || !text(input.error.message)) return invalid();
    throw new NativeError(input.error.code, input.error.message, request.requestId);
  }
  const result = input.result;
  if (!record(result)) return invalid();
  switch (request.command) {
    case 'get_engine_info':
      if (result.kind !== 'engine-info' || !text(result.engineVersion) || !text(result.backend)
        || !Array.isArray(result.capabilities) || result.capabilities.some((item) => !text(item))) return invalid();
      return { kind: 'engine-info', engineVersion: result.engineVersion, backend: result.backend, capabilities: result.capabilities as string[] };
    case 'get_audio_devices': {
      if (result.kind !== 'audio-devices' || !Array.isArray(result.devices) || result.devices.length > 256) return invalid();
      const devices: NativeAudioDevice[] = [];
      const ids = new Set<string>();
      for (const device of result.devices) {
        if (!record(device) || !text(device.id) || ids.has(device.id) || !text(device.name) || !text(device.backend)
          || !['input', 'output'].includes(String(device.kind)) || typeof device.isDefault !== 'boolean') return invalid();
        ids.add(device.id);
        devices.push({ id: device.id, name: device.name, backend: device.backend, kind: device.kind as 'input' | 'output', isDefault: device.isDefault });
      }
      return { kind: 'audio-devices', devices };
    }
    case 'validate_tone_spec':
      if (result.kind !== 'rig-valid' || !text(result.toneId) || !count(result.revision) || !count(result.nodeCount)
        || !count(result.activeNodeCount) || result.activeNodeCount > result.nodeCount || !request.tone
        || result.toneId !== request.tone.id || result.revision !== request.tone.revision
        || result.nodeCount !== request.tone.chain.length || result.activeNodeCount !== request.tone.chain.filter((node) => node.enabled).length) return invalid();
      return { kind: 'rig-valid', toneId: result.toneId, revision: result.revision, nodeCount: result.nodeCount, activeNodeCount: result.activeNodeCount };
  }
}
