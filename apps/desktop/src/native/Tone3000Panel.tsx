import { useEffect, useRef, useState } from 'react';
import type { NativeAssetDescriptor } from '../../../../core/native/assets';
import type { Tone3000Status, Tone3000Target } from '../../../../core/native/tone3000';
import { NativeError } from '../../../../core/native/protocol';
import { isDesktop } from './bridge';
import { cancelTone3000, downloadTone3000, getTone3000Status, selectTone3000 } from './tone3000';
import type { NativeDiagnostic } from './AudioDevicesPanel';

export function Tone3000Panel({ locked, onDownloaded, onDiagnostic, browseRequest }: {
  locked: boolean;
  onDownloaded: (descriptor: NativeAssetDescriptor) => void;
  onDiagnostic: (diagnostic: NativeDiagnostic) => void;
  browseRequest?: { target: Tone3000Target; query: string; id: string };
}) {
  const [state, setState] = useState<Tone3000Status>();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [modelId, setModelId] = useState<number>();
  const operation = useRef(0);
  const mounted = useRef(true);
  const lastBrowseRequest = useRef<string | undefined>(undefined);
  const desktop = isDesktop();
  const waiting = state?.status === 'authorizing' || state?.status === 'loading';

  function report(name: string, reason: unknown, start: number) {
    const failure = reason instanceof NativeError ? reason : new NativeError('TONE3000_FAILED', 'TONE3000 could not complete this operation.', 'unavailable');
    setError(`${failure.code}: ${failure.message} · ${failure.requestId}`);
    onDiagnostic({ operation: name, requestId: failure.requestId, durationMs: Math.round(performance.now() - start), error: { code: failure.code, message: failure.message } });
  }

  useEffect(() => {
    mounted.current = true;
    if (!desktop) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const generation = operation.current;
      try {
        const next = await getTone3000Status();
        if (!stopped && generation === operation.current) setState(next);
      } catch {
        // Explicit actions show correlated failures; background polling stays quiet.
      }
      if (!stopped) timer = setTimeout(() => void poll(), 2000);
    }
    void poll();
    return () => { stopped = true; mounted.current = false; clearTimeout(timer); };
  }, [desktop]);

  async function browse(target: Tone3000Target) {
    const kind = target === 'cab' ? 'ir' : 'nam';
    operation.current += 1;
    setWorking(true); setError(''); setMessage(''); setModelId(undefined);
    const start = performance.now();
    try {
      const next = await selectTone3000(kind, target);
      if (!mounted.current) return;
      setState(next);
      onDiagnostic({ operation: 'tone3000-select', requestId: next.requestId, durationMs: Math.round(performance.now() - start), result: { status: next.status, kind, target } });
    } catch (reason) { if (mounted.current) report('tone3000-select', reason, start); }
    finally { if (mounted.current) setWorking(false); }
  }

  useEffect(() => {
    if (!browseRequest || lastBrowseRequest.current === browseRequest.id || !desktop || locked || working || waiting) return;
    lastBrowseRequest.current = browseRequest.id;
    void browse(browseRequest.target);
    // An explicit recommendation click initiates one selection; catalog searches
    // are entered in TONE3000 because Select does not document a query parameter.
  }, [browseRequest, desktop, locked, working, waiting]);

  async function cancel() {
    operation.current += 1;
    setWorking(true); setError(''); setMessage('');
    const start = performance.now();
    try { setState(await cancelTone3000()); setModelId(undefined); }
    catch (reason) { report('tone3000-cancel', reason, start); }
    finally { setWorking(false); }
  }

  async function download(id: number) {
    operation.current += 1;
    setWorking(true); setError(''); setMessage('');
    const start = performance.now();
    try {
      const result = await downloadTone3000(id);
      if (!mounted.current) return;
      onDownloaded(result.descriptor);
      setMessage(`${result.descriptor.asset.name} is ready offline. Choose it in the pedal, amp or cabinet selector below.`);
      onDiagnostic({ operation: 'tone3000-download', requestId: result.requestId, durationMs: Math.round(performance.now() - start), result: { asset: result.descriptor.asset, source: result.descriptor.source } });
    } catch (reason) { if (mounted.current) report('tone3000-download', reason, start); }
    finally { if (mounted.current) setWorking(false); }
  }

  const selection = state?.selection;
  const selectedId = selection?.models.some((model) => model.id === modelId) ? modelId : selection?.models[0]?.id;
  return <div className="tone3000-panel">
    <div className="tone3000-heading"><img src="/tone3000-logo.svg" alt="TONE3000" width="210" height="32" /><span>AMP & PEDAL CAPTURES · CABINET IRS</span></div>
    <p>Browse and audition gear in Toney's TONE3000 window. Sign in once in that window, choose a capture, then download it into your offline library.</p>
    {browseRequest && <p className="asset-status">Recommended search: <strong>{browseRequest.query}</strong>. Enter this in the catalog search.</p>}
    <div className="native-actions">
      <button disabled={!desktop || locked || working || waiting} onClick={() => void browse('amp')}>Browse amps</button>
      <button disabled={!desktop || locked || working || waiting} onClick={() => void browse('drive')}>Browse NAM pedals</button>
      <button disabled={!desktop || locked || working || waiting} onClick={() => void browse('cab')}>Browse cabinets</button>
      {desktop && state && state.status !== 'idle' && <button disabled={locked || working} onClick={() => void cancel()}>Close selection / disconnect</button>}
    </div>
    {!desktop && <small>Open Toney desktop to connect your TONE3000 account and download models.</small>}
    {waiting && <p className="asset-status" role="status">{state.status === 'authorizing' ? 'The TONE3000 window is open. Preview and select a capture there; close that window or cancel here to return.' : 'Loading the selected tone and its model variants…'}</p>}
    {selection && <div className="tone3000-selection">
      <strong>{selection.name}</strong>
      <small>{state?.target === 'drive' ? 'Pedal · NAM A1' : state?.kind === 'nam' ? 'Amp · NAM A1' : 'Cabinet · IR'} · {selection.creator} · {selection.license}</small>
      <label>Model variant<select disabled={locked || working} value={selectedId ?? ''} onChange={(event) => setModelId(Number(event.target.value))}>
        {selection.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
      </select></label>
      <button className="primary" disabled={locked || working || !selectedId} onClick={() => selectedId && void download(selectedId)}>{working ? 'Downloading and checking…' : 'Download to local library'}</button>
      <small>Creator credit and license are saved with the model. Download only the variants you want to use.</small>
    </div>}
    {state?.error && <p className="native-error" role="alert">{state.error.code}: {state.error.message} · {state.requestId}</p>}
    {message && <p className="asset-status" role="status">{message}</p>}
    {error && <p className="native-error" role="alert">{error}</p>}
    <small>Powered by TONE3000 · Supported A1 NAM captures and cabinet IRs. Use dynamic effects such as chorus alongside captures; A2 and parametric captures are not supported yet.</small>
  </div>;
}
