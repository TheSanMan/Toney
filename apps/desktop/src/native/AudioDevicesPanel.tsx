import { useEffect, useState } from 'react';
import type { ToneSpec } from '../../../../core';
import { NativeError, type DeviceInventory, type EngineInfo, type RigValidation } from '../../../../core/native/protocol';
import { isDesktop, nativeRequest } from './bridge';
import { LiveInputPanel } from './LiveInputPanel';

export interface NativeDiagnostic {
  operation: string;
  requestId: string;
  durationMs: number;
  result?: unknown;
  error?: { code: string; message: string };
}

export function AudioDevicesPanel({ tone, locked, onDiagnostic, onMonitoringChange }: {
  tone: ToneSpec; locked: boolean; onDiagnostic: (diagnostic: NativeDiagnostic) => void;
  onMonitoringChange: (active: boolean) => void;
}) {
  const desktop = isDesktop();
  const [info, setInfo] = useState<EngineInfo>();
  const [inventory, setInventory] = useState<DeviceInventory>();
  const [validation, setValidation] = useState<RigValidation>();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  async function refresh() {
    setWorking(true); setError('');
    const start = performance.now();
    try {
      const responses = await Promise.all([nativeRequest('get_engine_info'), nativeRequest('get_audio_devices')]);
      for (const response of responses) {
        if (response.result.kind === 'engine-info') setInfo(response.result);
        if (response.result.kind === 'audio-devices') setInventory(response.result);
        onDiagnostic({ operation: 'device-discovery', requestId: response.requestId, durationMs: Math.round(performance.now() - start), result: response.result });
      }
    } catch (reason) { reportError('device-discovery', reason, start); }
    finally { setWorking(false); }
  }

  function reportError(operation: string, reason: unknown, start: number) {
    const failure = reason instanceof NativeError ? reason : new NativeError('NATIVE_COMMAND_FAILED', String(reason), 'unavailable');
    setError(`${failure.message} · ${failure.requestId}`);
    onDiagnostic({ operation, requestId: failure.requestId, durationMs: Math.round(performance.now() - start), error: { code: failure.code, message: failure.message } });
  }

  async function validate() {
    setWorking(true); setError('');
    const start = performance.now();
    try {
      const response = await nativeRequest('validate_tone_spec', tone);
      if (response.result.kind !== 'rig-valid') throw new Error('Unexpected native validation result.');
      setValidation(response.result);
      onDiagnostic({ operation: 'rig-validation', requestId: response.requestId, durationMs: Math.round(performance.now() - start), result: response.result });
    } catch (reason) { reportError('rig-validation', reason, start); }
    finally { setWorking(false); }
  }

  useEffect(() => {
    // Discovery never opens an input stream. Explicit refresh remains available after failures.
    if (desktop) void refresh();
    // Run once per mount; canonical rig changes do not rescan audio devices.
  }, []);

  const currentValidated = validation?.toneId === tone.id && validation.revision === tone.revision;
  return <section className="native-panel">
    <div className="native-heading"><div><span className="eyebrow">AUDIO DEVICES</span>
      <p>{desktop ? 'Select your guitar interface below · discovery keeps input closed' : 'Open the desktop app for system audio devices'}</p></div>
      <span className={`native-status ${info ? 'ready' : ''}`}>{desktop ? (info ? 'NATIVE CONTROL READY' : (error ? 'NATIVE CONTROL UNAVAILABLE' : 'CHECKING NATIVE CONTROL')) : 'BROWSER AUDITION'}</span>
    </div>
    {desktop && <>
      <div className="device-groups">{(['input', 'output'] as const).map((kind) => <div className="device-group" key={kind}>
        <span>{kind === 'input' ? 'INPUTS' : 'OUTPUTS'}</span>
        {inventory ? (inventory.devices.filter((device) => device.kind === kind).length === 0
          ? <p>No {kind} devices found.</p> : inventory.devices.filter((device) => device.kind === kind).map((device) =>
            <div className="device-row" key={device.id}><strong>{device.name}</strong><small>{device.isDefault ? 'SYSTEM DEFAULT' : device.backend}</small></div>))
          : <p>{working ? 'Scanning devices…' : 'Device scan unavailable.'}</p>}
      </div>)}</div>
      <div className="native-actions"><button disabled={locked || working} onClick={() => void refresh()}>Refresh devices</button>
        <button disabled={locked || working} onClick={() => void validate()}>Validate current rig</button>
        <span className={currentValidated ? 'validated' : ''}>{currentValidated ? `Native schema check passed · revision ${tone.revision}` : (validation ? 'Rig changed · validate the current revision' : 'Current rig has not been validated natively')}</span>
      </div>
      {error && <p className="native-error" role="alert">{error}</p>}
    </>}
    <LiveInputPanel tone={tone} inventory={inventory} locked={locked} onDiagnostic={onDiagnostic} onMonitoringChange={onMonitoringChange} />
  </section>;
}
