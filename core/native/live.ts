import { validateToneSpec, type ToneSpec } from '../index';
import { NativeError } from './protocol';

export type LiveOperation = 'start' | 'update' | 'status' | 'stop';
export interface LiveGains { inputGainDb: number; outputGainDb: number }
export interface LiveConfiguration extends LiveGains {
  inputDeviceId: string; outputDeviceId: string; inputChannel: number;
  sampleRate: 44100 | 48000 | 96000; bufferSize: 64 | 128 | 256 | 512;
}
export interface LiveRequest { protocolVersion: 1; requestId: string; tone?: ToneSpec; live?: LiveConfiguration | LiveGains }
export interface LiveStatus {
  kind: 'live-status'; state: 'stopped' | 'running' | 'error'; toneId: string; revision: number;
  sampleRate: number; bufferSize: number; inputDeviceId: string; outputDeviceId: string;
  inputChannel: number; inputChannels: number; outputChannels: number;
  inputPeak: number; outputPeak: number; callbackCount: number; overruns: number;
  cpuLoad: number; latencyMs: number; errorCode: string; errorMessage: string;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const bounded = (value: unknown, minimum: number, maximum: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
const integer = (value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number => bounded(value, minimum, maximum) && Number.isSafeInteger(value);
const text = (value: unknown, maximum = 1000): value is string => typeof value === 'string' && value.length <= maximum;

export function createLiveRequest(operation: LiveOperation, tone?: ToneSpec, configuration?: LiveConfiguration | LiveGains): LiveRequest {
  const requestId = `live_${crypto.randomUUID()}`;
  const invalid = (): never => { throw new NativeError('INVALID_LIVE_REQUEST', 'Choose valid live audio devices, channel, sample rate, buffer and gain settings.', requestId); };
  if (operation === 'status' || operation === 'stop') {
    if (tone || configuration) return invalid();
    return { protocolVersion: 1, requestId };
  }
  if (!tone || !configuration || !bounded(configuration.inputGainDb, -24, 24) || !bounded(configuration.outputGainDb, -60, 0)) return invalid();
  const live: LiveGains = { inputGainDb: configuration.inputGainDb, outputGainDb: configuration.outputGainDb };
  if (operation === 'start') {
    if (!('inputDeviceId' in configuration) || !text(configuration.inputDeviceId) || !configuration.inputDeviceId
      || !text(configuration.outputDeviceId) || !configuration.outputDeviceId || !integer(configuration.inputChannel, 0, 31)
      || ![44100, 48000, 96000].includes(configuration.sampleRate) || ![64, 128, 256, 512].includes(configuration.bufferSize)) return invalid();
    return { protocolVersion: 1, requestId, tone: validateToneSpec(tone), live: { ...live,
      inputDeviceId: configuration.inputDeviceId, outputDeviceId: configuration.outputDeviceId,
      inputChannel: configuration.inputChannel, sampleRate: configuration.sampleRate, bufferSize: configuration.bufferSize } };
  }
  return { protocolVersion: 1, requestId, tone: validateToneSpec(tone), live };
}

export function validateLiveResponse(operation: LiveOperation, request: LiveRequest, input: unknown): LiveStatus {
  const invalid = (): never => { throw new NativeError('INVALID_LIVE_RESPONSE', 'The live engine returned an invalid or mismatched response.', request.requestId); };
  if (!record(input) || input.protocolVersion !== 1 || input.requestId !== request.requestId || typeof input.ok !== 'boolean') return invalid();
  if (!input.ok) {
    if (!record(input.error) || !text(input.error.code) || !input.error.code || !text(input.error.message, 8000) || !input.error.message) return invalid();
    throw new NativeError(input.error.code, input.error.message, request.requestId);
  }
  const result = input.result;
  if (!record(result) || result.kind !== 'live-status' || !['stopped', 'running', 'error'].includes(String(result.state))
    || !text(result.toneId) || !integer(result.revision) || !integer(result.sampleRate, 0, 192000) || !integer(result.bufferSize, 0, 8192)
    || !text(result.inputDeviceId) || !text(result.outputDeviceId) || !integer(result.inputChannel, 0, 31)
    || !integer(result.inputChannels, 0, 64) || !integer(result.outputChannels, 0, 64)
    || !bounded(result.inputPeak, 0, 1e6) || !bounded(result.outputPeak, 0, 0.8501)
    || !integer(result.callbackCount) || !integer(result.overruns) || !bounded(result.cpuLoad, 0, 1000)
    || !bounded(result.latencyMs, 0, 60000) || !text(result.errorCode) || !text(result.errorMessage, 8000)) return invalid();
  if (result.state === 'running' && (!result.toneId || !result.inputDeviceId || !result.outputDeviceId
    || result.sampleRate < 8000 || !result.bufferSize || result.inputChannel >= result.inputChannels || !result.outputChannels)) return invalid();
  if (result.state === 'error' && (!result.errorCode || !result.errorMessage)) return invalid();
  if ((operation === 'start' || operation === 'update') && result.state === 'error')
    throw new NativeError(result.errorCode, result.errorMessage, request.requestId);
  if ((operation === 'start' || operation === 'update') && (result.state !== 'running'
    || result.toneId !== request.tone?.id || result.revision !== request.tone.revision)) return invalid();
  if (operation === 'start' && request.live && 'inputDeviceId' in request.live
    && (result.inputDeviceId !== request.live.inputDeviceId || result.outputDeviceId !== request.live.outputDeviceId
      || result.inputChannel !== request.live.inputChannel || result.sampleRate !== request.live.sampleRate
      || result.bufferSize !== request.live.bufferSize)) return invalid();
  if (operation === 'stop' && result.state !== 'stopped') return invalid();
  // Every field is checked above; copy only the public contract, never arbitrary helper fields.
  return {
    kind: 'live-status', state: result.state as LiveStatus['state'], toneId: result.toneId, revision: result.revision,
    sampleRate: result.sampleRate, bufferSize: result.bufferSize, inputDeviceId: result.inputDeviceId, outputDeviceId: result.outputDeviceId,
    inputChannel: result.inputChannel, inputChannels: result.inputChannels, outputChannels: result.outputChannels,
    inputPeak: result.inputPeak, outputPeak: result.outputPeak, callbackCount: result.callbackCount, overruns: result.overruns,
    cpuLoad: result.cpuLoad, latencyMs: result.latencyMs, errorCode: result.errorCode, errorMessage: result.errorMessage,
  };
}
