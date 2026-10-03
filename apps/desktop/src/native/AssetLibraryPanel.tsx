import { useEffect, useRef, useState } from 'react';
import { getNodeDefinition, type AssetRef, type ToneSpec } from '../../../../core';
import type { NativeAssetDescriptor, NativeAssetInfo } from '../../../../core/native/assets';
import { NativeError } from '../../../../core/native/protocol';
import { importNativeAsset, isDesktop, listNativeAssets } from './bridge';
import type { NativeDiagnostic } from './AudioDevicesPanel';
import { Tone3000Panel } from './Tone3000Panel';

function describe(info: NativeAssetInfo): string {
  const rate = `${(info.sampleRate / 1000).toFixed(1)} kHz`;
  return info.assetKind === 'ir'
    ? `${rate} · ${info.channels === 1 ? 'mono' : 'stereo'} · ${(info.frames / info.sampleRate * 1000).toFixed(1)} ms`
    : `${info.architecture} · ${rate} · model ${info.modelVersion}`;
}

export function AssetLibraryPanel({ tone, locked, onSelect, onDiagnostic }: {
  tone: ToneSpec; locked: boolean;
  onSelect: (nodeId: string, asset?: AssetRef) => void;
  onDiagnostic: (diagnostic: NativeDiagnostic) => void;
}) {
  const desktop = isDesktop();
  const [assets, setAssets] = useState<NativeAssetDescriptor[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [libraryWarnings, setLibraryWarnings] = useState<string[]>([]);
  const irInput = useRef<HTMLInputElement>(null);
  const namInput = useRef<HTMLInputElement>(null);

  function reportError(operation: string, reason: unknown, start: number) {
    const failure = reason instanceof NativeError ? reason : new NativeError('ASSET_LIBRARY_FAILED', String(reason), 'unavailable');
    setError(`${failure.code}: ${failure.message} · ${failure.requestId}`);
    onDiagnostic({ operation, requestId: failure.requestId, durationMs: Math.round(performance.now() - start), error: { code: failure.code, message: failure.message } });
  }

  async function refresh() {
    setWorking(true); setError('');
    const start = performance.now();
    try {
      const result = await listNativeAssets();
      setAssets(result.assets);
      setLibraryWarnings(result.diagnostics.map((item) => `${item.code}: ${item.message}`));
      onDiagnostic({ operation: 'asset-library', requestId: result.requestId,
        durationMs: Math.round(performance.now() - start), result: { assets: result.assets, diagnostics: result.diagnostics } });
    } catch (reason) { reportError('asset-library', reason, start); }
    finally { setWorking(false); }
  }

  async function importFile(kind: 'ir' | 'nam', file?: File) {
    if (!file) return;
    setWorking(true); setError(''); setStatus('');
    const start = performance.now();
    try {
      const imported = await importNativeAsset(kind, file);
      setAssets((current) => [...current.filter((item) => item.asset.id !== imported.asset.id), { asset: imported.asset, info: imported.info, ...(imported.source ? { source: imported.source } : {}) }]);
      setStatus(`${imported.asset.name} imported. Select it for a pedal, amp or cabinet below.`);
      onDiagnostic({ operation: 'asset-import', requestId: imported.requestId,
        durationMs: Math.round(performance.now() - start), result: { asset: imported.asset, info: imported.info } });
    } catch (reason) { reportError('asset-import', reason, start); }
    finally {
      setWorking(false);
      const input = kind === 'ir' ? irInput.current : namInput.current;
      if (input) input.value = '';
    }
  }

  useEffect(() => {
    if (desktop) void refresh();
    // Imports and the explicit refresh button update the inventory after mount.
  }, []);

  return <section className="native-panel asset-panel">
    <div className="native-heading"><div><span className="eyebrow">NAM AMPS & PEDALS · CABINET IRS</span>
      <p>{desktop ? 'Download community models or import captures, then use them in any rig.' : 'Open Toney desktop to download and hear NAM captures and cabinet IRs.'}</p></div>
      <span className="native-status">{working ? 'CHECKING ASSET…' : `${assets.length} LOCAL ASSETS`}</span>
    </div>
    <Tone3000Panel locked={locked || working}
      onDownloaded={(descriptor) => setAssets((current) => [...current.filter((item) => item.asset.id !== descriptor.asset.id), descriptor])}
      onDiagnostic={onDiagnostic} />
    {desktop && <div className="native-actions">
      <button disabled={locked || working} onClick={() => namInput.current?.click()}>Import NAM model</button>
      <button disabled={locked || working} onClick={() => irInput.current?.click()}>Import cabinet IR</button>
      <button disabled={locked || working} onClick={() => void refresh()}>Refresh library</button>
    </div>}
    <div className="asset-selectors">{tone.chain.filter((node) => node.type === 'drive' || node.type === 'amp' || node.type === 'cab').map((node) => {
      const kind = node.type === 'cab' ? 'ir' : 'nam';
      const choices = assets.filter((item) => item.asset.kind === kind);
      const selected = choices.find((item) => item.asset.id === node.asset?.id);
      return <div className="asset-slot" key={node.id}>
        <label htmlFor={`asset-${node.id}`}>{node.type === 'drive' ? 'Pedal' : node.type === 'amp' ? 'Amp' : 'Cabinet'} model
          <select id={`asset-${node.id}`} value={node.asset?.id ?? ''} disabled={locked || working}
            onChange={(event) => onSelect(node.id, choices.find((item) => item.asset.id === event.target.value)?.asset)}>
            <option value="">{node.type === 'drive' ? 'Builtin preview drive' : node.type === 'amp' ? 'Builtin preview amp' : 'Builtin cabinet filter'}</option>
            {node.asset && !selected && <option value={node.asset.id} disabled>Missing on this device · {node.asset.name}</option>}
            {choices.map((item) => <option key={item.asset.id} value={item.asset.id}>{item.asset.name}</option>)}
          </select>
        </label>
        <small>{selected ? describe(selected.info) : node.asset ? 'Reimport the same file to restore this reference, or select the builtin model.' : `${getNodeDefinition(node).name} · no imported file required`}</small>
        {selected?.source && <small>TONE3000 · {selected.source.toneName} · {selected.source.creator} · {selected.source.license}</small>}
        {node.model === 'nam' && <small>{node.type === 'drive' ? 'Input/output trims are −12 to +12 dB. Tone is post-capture EQ (−6 to +6 dB). First NAM pedal selection starts neutral; choose Builtin preview drive to compare, or bypass to hear the amp alone.' : 'Gain controls input trim; master controls output trim (−12 to +12 dB). Bass, mid and treble shape the captured sound with external EQ.'}</small>}
      </div>;
    })}</div>
    <p className="preview-note">NAM: classic mono WaveNet and LSTM captures, file version 0.5.0–0.5.4, up to 32 MiB. Cabinet IR: mono/stereo WAV, up to 2 seconds and 8 MiB. Presets reference files by content; importing a preset does not import its audio or model files.</p>
    {status && <p className="asset-status" role="status">{status}</p>}
    {libraryWarnings.map((warning, index) => <p className="native-error" key={`${index}-${warning}`}>{warning}</p>)}
    {error && <p className="native-error" role="alert">{error}</p>}
    <input className="hidden-input" ref={namInput} type="file" accept=".nam" aria-label="NAM model file" onChange={(event) => void importFile('nam', event.target.files?.[0])} />
    <input className="hidden-input" ref={irInput} type="file" accept=".wav,audio/wav" aria-label="Cabinet IR file" onChange={(event) => void importFile('ir', event.target.files?.[0])} />
  </section>;
}
