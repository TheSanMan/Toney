import { useEffect, useRef, useState } from 'react';
import type { ToneSpec } from '../../../../core';
import type { DeviceInventory } from '../../../../core/native/protocol';
import { NativeError } from '../../../../core/native/protocol';
import type { LiveConfiguration, LiveOperation, LiveStatus } from '../../../../core/native/live';
import type { NativeDiagnostic } from './AudioDevicesPanel';
import { isDesktop, liveRequest } from './bridge';

// A rejected operation must release the queue so Stop and subsequent recovery still work.
export function createLiveQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T,>(operation: () => Promise<T>): Promise<T> => {
    const next = tail.then(operation);
    tail = next.catch(() => undefined);
    return next;
  };
}

export function LiveInputPanel({ tone, inventory, locked, onDiagnostic, onMonitoringChange }: {
  tone: ToneSpec; inventory?: DeviceInventory; locked: boolean;
  onDiagnostic: (diagnostic: NativeDiagnostic) => void; onMonitoringChange: (active: boolean) => void;
}) {
  const desktop = isDesktop();
  const [settings, setSettings] = useState<LiveConfiguration>({ inputDeviceId: '', outputDeviceId: '', inputChannel: 0,
    sampleRate: 48000, bufferSize: 128, inputGainDb: 0, outputGainDb: -12 });
  const [status, setStatus] = useState<LiveStatus>();
  const [appliedGains, setAppliedGains] = useState<{ inputGainDb: number; outputGainDb: number }>();
  const [working, setWorking] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  const queue = useRef(createLiveQueue());
  const callbacks = useRef({ onDiagnostic, onMonitoringChange });
  callbacks.current = { onDiagnostic, onMonitoringChange };
  const errorReported = useRef('');
  const mounted = useRef(true);
  const generation = useRef(0);
  const starting = useRef(false);
  const running = status?.state === 'running';
  const current = running && status.toneId === tone.id && status.revision === tone.revision
    && appliedGains?.inputGainDb === settings.inputGainDb && appliedGains.outputGainDb === settings.outputGainDb;

  function accept(result: LiveStatus, requestId: string, durationMs: number) {
    setStatus(result);
    callbacks.current.onMonitoringChange(result.state === 'running' || starting.current);
    if (result.state === 'error') {
      const signature = `${result.errorCode}:${result.errorMessage}`;
      setError(`${result.errorCode}: ${result.errorMessage} · ${requestId}`);
      if (errorReported.current !== signature) {
        errorReported.current = signature;
        callbacks.current.onDiagnostic({ operation: 'live-status', requestId, durationMs,
          error: { code: result.errorCode, message: result.errorMessage } });
      }
    } else errorReported.current = '';
  }

  useEffect(() => {
    if (!desktop) return;
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const poll = async () => {
      const start = performance.now();
      const epoch = generation.current;
      try {
        const response = await queue.current(() => liveRequest('status'));
        if (!cancelled && epoch === generation.current) accept(response.result, response.requestId, Math.round(performance.now() - start));
      } catch (reason) {
        if (!cancelled && epoch === generation.current) {
          const failure = reason instanceof NativeError ? reason : new NativeError('LIVE_STATUS_FAILED', String(reason), 'unavailable');
          if (errorReported.current !== failure.code) {
            errorReported.current = failure.code;
            setError(`${failure.code}: ${failure.message} · ${failure.requestId}`);
            callbacks.current.onDiagnostic({ operation: 'live-status', requestId: failure.requestId,
              durationMs: Math.round(performance.now() - start), error: { code: failure.code, message: failure.message } });
          }
        }
      } finally { if (!cancelled) timer = setTimeout(() => void poll(), 500); }
    };
    void poll();
    return () => {
      cancelled = true; mounted.current = false;
      if (timer) clearTimeout(timer);
      // Rust also stops the child on application exit. Unmounting never leaves monitoring running.
      generation.current += 1;
      void liveRequest('stop').catch(() => undefined);
    };
  }, []);

  async function control(operation: Exclude<LiveOperation, 'status'>) {
    const epoch = operation === 'stop' ? ++generation.current : generation.current;
    if (operation === 'stop') setStopping(true);
    else setWorking(true);
    setError('');
    if (operation === 'start') { starting.current = true; callbacks.current.onMonitoringChange(true); }
    if (operation === 'stop') starting.current = false;
    const start = performance.now();
    try {
      const request = () => liveRequest(operation, operation === 'stop' ? undefined : tone,
        operation === 'stop' ? undefined : operation === 'start' ? settings
          : { inputGainDb: settings.inputGainDb, outputGainDb: settings.outputGainDb });
      // Stop bypasses the UI queue and Rust kills the helper before waiting on IPC.
      const response = await (operation === 'stop' ? request() : queue.current(() => {
        if (epoch !== generation.current) throw new NativeError('LIVE_CANCELLED', 'Live operation cancelled.', 'cancelled');
        return request();
      }));
      if (!mounted.current || epoch !== generation.current) return;
      if (operation === 'start') starting.current = false;
      if (operation === 'stop') { setWorking(false); setAppliedGains(undefined); }
      else setAppliedGains({ inputGainDb: settings.inputGainDb, outputGainDb: settings.outputGainDb });
      accept(response.result, response.requestId, Math.round(performance.now() - start));
      callbacks.current.onDiagnostic({ operation: `live-${operation}`, requestId: response.requestId,
        durationMs: Math.round(performance.now() - start), result: response.result });
    } catch (reason) {
      if (!mounted.current || epoch !== generation.current) return;
      const failure = reason instanceof NativeError ? reason : new NativeError('LIVE_COMMAND_FAILED', String(reason), 'unavailable');
      setError(`${failure.code}: ${failure.message} · ${failure.requestId}`);
      callbacks.current.onDiagnostic({ operation: `live-${operation}`, requestId: failure.requestId,
        durationMs: Math.round(performance.now() - start), error: { code: failure.code, message: failure.message } });
      if (operation === 'start') { starting.current = false; callbacks.current.onMonitoringChange(false); }
    } finally {
      if (mounted.current && epoch === generation.current) { if (operation === 'stop') setStopping(false); else setWorking(false); }
    }
  }

  const set = <K extends keyof LiveConfiguration>(key: K, value: LiveConfiguration[K]) => setSettings((previous) => ({ ...previous, [key]: value }));
  const frozen = working || stopping || running;
  const missingDevice = !inventory?.devices.some((device) => device.kind === 'input' && device.id === settings.inputDeviceId)
    || !inventory.devices.some((device) => device.kind === 'output' && device.id === settings.outputDeviceId);

  return <div className="live-input-panel">
    <div className="native-heading"><div><span className="eyebrow">LIVE GUITAR</span>
      <p>{desktop ? 'Guitar → interface instrument input → Toney → interface headphones' : 'Live guitar input requires the Toney desktop app.'}</p></div>
      <span className={`native-status ${running ? 'ready' : ''}`}>{running ? `LIVE · R${status.revision}` : 'INPUT CLOSED'}</span>
    </div>
    {desktop ? <>
      <p className="preview-note">Connect your guitar to an audio interface’s instrument / Hi-Z input. Choose its input and headphone output below. Turn the interface’s direct monitor off to hear only Toney. Allow microphone access when macOS asks.</p>
      <div className="live-settings">
        {(['input', 'output'] as const).map((kind) => <label key={kind}>{kind === 'input' ? 'Guitar input device' : 'Headphone output device'}
          <select value={settings[`${kind}DeviceId`]} disabled={frozen} onChange={(event) => set(`${kind}DeviceId`, event.target.value)}>
            <option value="">Choose {kind} device…</option>
            {inventory?.devices.filter((device) => device.kind === kind).map((device) => <option key={device.id} value={device.id}>{device.name} · {device.backend}</option>)}
          </select></label>)}
        <label>Guitar input channel<input type="number" min="1" max="32" step="1" value={settings.inputChannel + 1} disabled={frozen}
          onChange={(event) => set('inputChannel', Number(event.target.value) - 1)} /></label>
        <label>Sample rate<select value={settings.sampleRate} disabled={frozen} onChange={(event) => set('sampleRate', Number(event.target.value) as LiveConfiguration['sampleRate'])}>
          {[44100, 48000, 96000].map((rate) => <option key={rate} value={rate}>{rate / 1000} kHz</option>)}</select></label>
        <label>Buffer<select value={settings.bufferSize} disabled={frozen} onChange={(event) => set('bufferSize', Number(event.target.value) as LiveConfiguration['bufferSize'])}>
          {[64, 128, 256, 512].map((size) => <option key={size} value={size}>{size} samples</option>)}</select></label>
        <label>Input trim · {settings.inputGainDb} dB<input type="range" min="-24" max="24" step="1" value={settings.inputGainDb} disabled={working || stopping}
          onChange={(event) => set('inputGainDb', Number(event.target.value))} /></label>
        <label>Output volume · {settings.outputGainDb} dB<input type="range" min="-60" max="0" step="1" value={settings.outputGainDb} disabled={working || stopping}
          onChange={(event) => set('outputGainDb', Number(event.target.value))} /></label>
      </div>
      <div className="native-actions">
        <button className="primary" disabled={locked || frozen || missingDevice} onClick={() => void control('start')}>Start live guitar</button>
        <button disabled={stopping || (!running && !working && status?.state !== 'error')} onClick={() => void control('stop')}>{stopping ? 'Stopping…' : 'Stop live guitar'}</button>
        <button disabled={!running || locked || working || stopping} onClick={() => void control('update')}>{working && running ? 'Applying…' : 'Apply current rig + gains'}</button>
        <span className={current ? 'validated' : ''}>{running ? (current ? `Playing revision ${status.revision}` : `Playing revision ${status.revision} · settings changed, press Apply`) : (working ? 'Preparing audio…' : 'Input opens only when you press Start')}</span>
      </div>
      {running && <>
        <div className="live-meters">{(['input', 'output'] as const).map((kind) => {
          const peak = status[`${kind}Peak`];
          return <label key={kind}>{kind === 'input' ? 'Input' : 'Output'} · {peak > 0 ? `${(20 * Math.log10(peak)).toFixed(1)} dBFS` : '−∞ dBFS'}{kind === 'input' && peak >= 0.99 ? ' · CLIPPING' : kind === 'output' && peak >= 0.8499 ? ' · LEVEL CEILING' : ''}
            <meter aria-label={`${kind} signal level`} min={0} max={1} low={0.01} high={0.9} optimum={0.5} value={Math.min(peak, 1)} /></label>;
        })}</div>
        <p className="preview-note">Actual: {status.sampleRate / 1000} kHz · {status.bufferSize} samples · {status.latencyMs.toFixed(1)} ms estimated device + buffer latency · {(status.cpuLoad * 100).toFixed(1)}% callback load · {status.overruns} deadline overruns. Mono guitar feeds the output channels.</p>
        {status.overruns > 0 && <p className="native-error">Audio has missed its processing deadline. Stop, choose a larger buffer, and start again if you hear clicks.</p>}
        {status.outputPeak >= 0.8499 && <p className="preview-note">Output is reaching the level ceiling. Lower Output volume and press Apply to reduce clipping.</p>}
      </>}
      <p className="preview-note">Device and channel changes require Stop → Start. Rig and gain changes take effect when you press Apply. NAM captures must match the live sample rate; 48 kHz is typical.</p>
      {error && <p className="native-error" role="alert">{error}</p>}
    </> : <p className="preview-note">In desktop, choose your audio interface, press Start live guitar, then play. The browser workbench can audition recordings and the demo phrase.</p>}
  </div>;
}
