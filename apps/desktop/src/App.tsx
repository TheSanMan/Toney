import { useEffect, useRef, useState } from 'react';
import {
  AgentError, getNodeDefinition, OllamaProvider, ToneAgent, createInitialTone, collectToneAssets,
  setNodeEnabled, setToneParameter, setToneAsset, validateToneSpec,
  type AgentTrace, type ToneIntent, type ToneNode, type ToneSpec,
} from '../../../core';
import { bufferToWav, createDemoBuffer, renderTone } from './audio/preview';
import { desktopOllamaTransport, exportNativeFile, isDesktop, renderNativeAudio } from './native/bridge';
import { NativeError } from '../../../core/native/protocol';
import { AudioDevicesPanel, type NativeDiagnostic } from './native/AudioDevicesPanel';
import { AssetLibraryPanel } from './native/AssetLibraryPanel';

const STORAGE_KEY = 'toney.workbench.v1';
const EXAMPLES = [
  'Warm edge-of-breakup blues with strong pick attack',
  'Dark 90s grunge crunch, dry, with clear chords',
  'Bright clean funk with a tight attack',
  'Dreamy ambient clean, wide and spacious',
  'Saturated singing lead with good sustain',
];

function readHistory(): ToneSpec[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.slice(-20).map(validateToneSpec);
  } catch { return []; }
}

async function download(name: string, value: Blob) {
  if (isDesktop()) return exportNativeFile(name, value);
  const url = URL.createObjectURL(value);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function Knob({ label, accessibleLabel, value, min, max, unit, displayValue, disabled, onChange }: {
  label: string; value: number; min: number; max: number; unit?: string;
  accessibleLabel: string;
  displayValue?: number;
  disabled: boolean; onChange: (value: number) => void;
}) {
  const position = (value - min) / (max - min);
  return <label className="knob-control">
    <span className="knob" style={{ transform: `rotate(${-135 + position * 270}deg)` }}><i /></span>
    <input type="range" min={min} max={max} step={0.001} value={value}
      disabled={disabled} aria-label={accessibleLabel} onChange={(event) => onChange(Number(event.target.value))} />
    <span className="knob-label">{label}</span>
    <span className="knob-value">{(displayValue ?? value).toFixed(2)}{unit ? ` ${unit}` : ''}</span>
  </label>;
}

function Pedal({ node, busy, change, bypass }: {
  node: ToneNode; busy: boolean;
  change: (key: string, value: number) => void; bypass: () => void;
}) {
  const effect = getNodeDefinition(node);
  return <article className={`pedal pedal-${node.type} ${node.enabled ? '' : 'bypassed'}`}>
    <div className="pedal-top"><span className={`led ${node.enabled ? 'lit' : ''}`} />
      <span className="model-tag">{node.model === 'nam' ? 'NAM CAPTURE' : node.model === 'cab_ir' ? 'CABINET IR' : node.type === 'amp' ? 'PREVIEW AMP' : node.type === 'cab' ? 'CAB FILTER' : 'BUILT IN'}</span></div>
    <h3>{effect.name}</h3>
    {node.asset && <span className="pedal-asset" title={node.asset.name}>{node.asset.name}</span>}
    <div className="knobs">{Object.entries(effect.parameters).map(([key, definition]) =>
      <Knob key={key} {...definition} value={node.parameters[key]} disabled={busy}
        displayValue={node.model === 'nam' && (key === 'gain' || key === 'master') ? (node.parameters[key] - 0.5) * 24 : undefined}
        unit={node.model === 'nam' && (key === 'gain' || key === 'master') ? 'dB' : definition.unit}
        accessibleLabel={`${effect.name} ${definition.label}`} onChange={(value) => change(key, value)} />,
    )}</div>
    <button className="footswitch" disabled={busy} onClick={bypass} aria-pressed={node.enabled}
      aria-label={`${node.enabled ? 'Bypass' : 'Enable'} ${effect.name}`}><span /></button>
    <span className="pedal-status">{node.enabled ? 'ENGAGED' : 'BYPASSED'}</span>
  </article>;
}

export function App() {
  const [history, setHistory] = useState<ToneSpec[]>(readHistory);
  const [tone, setTone] = useState<ToneSpec>(() => history.at(-1) ?? createInitialTone());
  const [intent, setIntent] = useState<ToneIntent>();
  const [prompt, setPrompt] = useState(EXAMPLES[0]);
  const [provider, setProvider] = useState('offline');
  const [model, setModel] = useState('llama3:latest');
  const [busy, setBusy] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [message, setMessage] = useState('Describe the sound you have in mind. I’ll build a rig you can hear and dial in.');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [trace, setTrace] = useState<AgentTrace>();
  const [lastRequest, setLastRequest] = useState<{ prompt: string; currentTone: ToneSpec; provider: string; model: string }>();
  const [source, setSource] = useState<AudioBuffer>();
  const [sourceName, setSourceName] = useState('Built-in plucked-string phrase');
  const [audioUrl, setAudioUrl] = useState('');
  const [renderedWav, setRenderedWav] = useState<Blob>();
  const [renderBackend, setRenderBackend] = useState(() => isDesktop() ? 'native' : 'browser');
  const [listenMode, setListenMode] = useState('');
  const [diagnostics, setDiagnostics] = useState(false);
  const [nativeDiagnostics, setNativeDiagnostics] = useState<NativeDiagnostic[]>([]);
  const [saveStatus, setSaveStatus] = useState('');
  const audio = useRef<HTMLAudioElement>(null);
  const presetInput = useRef<HTMLInputElement>(null);
  const diInput = useRef<HTMLInputElement>(null);
  const locked = busy || rendering;
  const desktop = isDesktop();

  async function saveFile(name: string, value: Blob) {
    setError(''); setSaveStatus('');
    try {
      const saved = await download(name, value);
      if (desktop) setSaveStatus(saved ? `${name} saved` : 'Save cancelled');
    } catch (reason) {
      const message = typeof reason === 'object' && reason !== null && 'message' in reason ? String(reason.message) : String(reason);
      setError(`File export: ${message}`);
    }
  }

  function saveJSON(name: string, value: unknown) {
    void saveFile(name, new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  }

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(history)); }
    catch { setError('Local history could not be saved. Export your preset to keep a copy.'); }
  }, [history]);

  useEffect(() => {
    audio.current?.pause();
    setAudioUrl('');
    setRenderedWav(undefined);
    setListenMode('');
  }, [tone, source]);

  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);

  function keep(next: ToneSpec) {
    setTone(next);
    setHistory((items) => [...items, next].slice(-20));
  }

  async function generate() {
    setBusy(true);
    setError('');
    setLastRequest({ prompt, currentTone: tone, provider, model });
    try {
      const agent = new ToneAgent(provider === 'ollama' ? new OllamaProvider(model.trim(), desktop ? desktopOllamaTransport : undefined) : undefined);
      const result = await agent.run({ prompt, currentTone: tone, previousIntent: intent });
      keep(result.tone);
      setIntent(result.intent);
      setMessage(result.message);
      setWarnings(result.warnings);
      setTrace(result.trace);
    } catch (reason) {
      if (reason instanceof AgentError) {
        setTrace(reason.trace);
        setError(`${reason.code}: ${reason.message} · Trace ${reason.trace.id}`);
      } else setError(reason instanceof Error ? reason.message : 'The tone request failed.');
    } finally { setBusy(false); }
  }

  async function listen(dry = false) {
    setRendering(true);
    setError('');
    audio.current?.pause();
    const native = !dry && renderBackend === 'native';
    const start = performance.now();
    try {
      let wav: Blob;
      let description = dry ? 'Dry source' : `Browser rig · r${tone.revision}`;
      if (dry) {
        if (source) wav = bufferToWav(source);
        else {
          const context = new AudioContext({ sampleRate: 44_100 });
          wav = bufferToWav(createDemoBuffer(context));
          await context.close();
        }
      } else if (native) {
        let input: Blob;
        if (source) input = bufferToWav(source);
        else {
          const context = new AudioContext({ sampleRate: 44_100 });
          input = bufferToWav(createDemoBuffer(context));
          await context.close();
        }
        const rendered = await renderNativeAudio(tone, input);
        wav = rendered.wav;
        description = `Native rig · r${tone.revision} · ${rendered.result.attenuationDb.toFixed(1)} dB headroom attenuation`;
        setNativeDiagnostics((items) => [...items, { operation: 'offline-render', requestId: rendered.requestId,
          durationMs: Math.round(performance.now() - start), result: { ...rendered.result, sourceName, assets: collectToneAssets(tone) } }].slice(-20));
      } else wav = bufferToWav(await renderTone(tone, source));
      const url = URL.createObjectURL(wav);
      setRenderedWav(wav);
      setAudioUrl(url);
      setListenMode(description);
      if (audio.current) {
        audio.current.src = url;
        try { await audio.current.play(); }
        catch { setListenMode(`${description} · press play below`); }
      }
    } catch (reason) {
      if (reason instanceof NativeError) {
        setError(`${reason.code}: ${reason.message} · ${reason.requestId}`);
        setNativeDiagnostics((items) => [...items, { operation: 'offline-render', requestId: reason.requestId,
          durationMs: Math.round(performance.now() - start), error: { code: reason.code, message: reason.message } }].slice(-20));
      } else setError(`Audio preview: ${reason instanceof Error ? reason.message : 'Rendering failed.'}`);
    } finally { setRendering(false); }
  }

  async function importPreset(file?: File) {
    if (!file) return;
    setError('');
    try {
      if (file.size > 1_000_000) throw new Error('Preset exceeds the 1 MB limit.');
      const data: unknown = JSON.parse(await file.text());
      keep(validateToneSpec(data));
      setIntent(undefined);
      setMessage('Your preset is loaded. Manual settings are the starting point for the next refinement.');
    } catch (reason) { setError(`Preset import: ${reason instanceof Error ? reason.message : 'Invalid preset.'}`); }
    if (presetInput.current) presetInput.current.value = '';
  }

  async function importDI(file?: File) {
    if (!file) return;
    setRendering(true);
    setError('');
    const context = new AudioContext();
    try {
      if (file.size > 50_000_000) throw new Error('Choose a clip under 50 MB.');
      const decoded = await context.decodeAudioData(await file.arrayBuffer());
      if (decoded.duration > 90) throw new Error('Choose a clean DI clip of 90 seconds or less.');
      setSource(decoded);
      setSourceName(file.name);
    } catch (reason) { setError(`DI import: ${reason instanceof Error ? reason.message : 'Audio could not be decoded.'}`); }
    finally { await context.close(); setRendering(false); }
    if (diInput.current) diInput.current.value = '';
  }

  return <div className="app-shell">
    <header className="app-header">
      <a className="wordmark" href="#">toney<span>●</span></a>
      <span className="tagline">YOUR TONE, DIALED IN.</span>
      <div className="local-badge"><span /> {desktop ? 'LOCAL DESKTOP' : 'LOCAL WORKBENCH'} <b>06</b></div>
    </header>
    <main className="workspace">
      <aside className="engineer-panel">
        <div className="eyebrow">THE TONE ENGINEER</div>
        <h1>What’s your<br /><em>sound?</em></h1>
        <p className="intro">A little grit. A little space. Something entirely yours.</p>
        <form onSubmit={(event) => { event.preventDefault(); void generate(); }}>
          <label className="sr-only" htmlFor="tone-prompt">Describe or refine your tone</label>
          <textarea id="tone-prompt" value={prompt} maxLength={2000} disabled={locked}
            onChange={(event) => setPrompt(event.target.value)} placeholder="Describe a tone, or tell me what to change…" />
          <button className="primary generate" disabled={locked || !prompt.trim()} type="submit">
            {busy ? 'Dialing it in…' : 'Dial in my tone'} <span>↗</span>
          </button>
        </form>
        <div className="example-title">START WITH A FEELING</div>
        <div className="examples">{EXAMPLES.map((example, index) =>
          <button key={example} disabled={locked} onClick={() => setPrompt(example)}>
            {['Warm blues', 'Dark grunge', 'Clean funk', 'Dreamy ambient', 'Singing lead'][index]} <span>↗</span>
          </button>,
        )}</div>
        <div className="engineer-note" aria-live="polite"><span className="note-symbol">t.</span><p>{message}</p></div>
        {warnings.length > 0 && <div className="warnings">{warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>}
        <div className="provider-settings">
          <label htmlFor="provider">Interpretation</label>
          <select id="provider" value={provider} disabled={locked} onChange={(event) => setProvider(event.target.value)}>
            <option value="offline">Offline tone rules</option><option value="ollama">Local model · Ollama</option>
          </select>
          {provider === 'ollama' && <label className="model-field">Installed model
            <input value={model} disabled={locked} onChange={(event) => setModel(event.target.value)} />
            <small>Uses Ollama on this machine. First response may take longer while the model loads.</small>
          </label>}
          <small>{provider === 'offline' ? 'Deterministic interpretation · no LLM required' : 'Prompts go only to local Ollama'}</small>
        </div>
      </aside>

      <section className="rig-panel">
        <div className="rig-heading"><div><div className="eyebrow">ON THE BOARD</div><h2>{tone.name}</h2></div>
          <div className="rig-actions"><button disabled={locked} onClick={() => {
            setTone(createInitialTone()); setIntent(undefined); setWarnings([]);
            setMessage('A fresh starting rig. Describe the sound you want to build.');
          }}>New rig</button><button disabled={locked} onClick={() => presetInput.current?.click()}>Load preset</button>
            <button disabled={locked} onClick={() => saveJSON('toney-preset.json', tone)}>Save preset ↓</button></div></div>
        {saveStatus && <p className="save-status" role="status">{saveStatus}</p>}
        <div className="signal-strip"><span>INPUT</span>{tone.chain.map((node) => <span key={node.id} className={node.enabled ? 'active' : ''}>
          <i />{getNodeDefinition(node).name}</span>)}<span>OUTPUT ↗</span></div>
        <div className="pedalboard">{tone.chain.map((node) => <Pedal key={node.id} node={node} busy={locked}
          change={(key, value) => setTone(setToneParameter(tone, node.id, key, value))}
          bypass={() => setTone(setNodeEnabled(tone, node.id, !node.enabled))} />)}</div>

        <AssetLibraryPanel tone={tone} locked={locked}
          onSelect={(nodeId, asset) => setTone((current) => setToneAsset(current, nodeId, asset))}
          onDiagnostic={(diagnostic) => setNativeDiagnostics((items) => [...items, diagnostic].slice(-20))} />
        <AudioDevicesPanel tone={tone} locked={locked} onDiagnostic={(diagnostic) => setNativeDiagnostics((items) => [...items, diagnostic].slice(-20))} />
        <section className="listening-panel">
          <div className="listening-heading"><div className="eyebrow">HEAR THE DIFFERENCE</div>
            <label className="render-backend">Render with <select aria-label="Audio rendering backend" value={renderBackend} disabled={locked} onChange={(event) => setRenderBackend(event.target.value)}>
              <option value="browser">Browser preview</option><option value="native" disabled={!desktop}>Native DSP + NAM / IR{desktop ? '' : ' · desktop required'}</option>
            </select></label></div>
          <div className="listen-row"><div className="source-info"><span className="waveform">▂▅▃▇▂▅▆▃▁▅▃▇▅▂▆▃▁</span><strong>{sourceName}</strong></div>
            <button disabled={locked} onClick={() => diInput.current?.click()}>Import clean DI</button>
            {source && <button disabled={locked} onClick={() => { setSource(undefined); setSourceName('Built-in plucked-string phrase'); }}>Use demo</button>}
          </div>
          <div className="playback-row"><button disabled={locked} onClick={() => void listen(true)}>▷ Dry source</button>
            <button className="primary" disabled={locked} onClick={() => void listen()}>{rendering ? 'Rendering…' : '▶ Hear this rig'}</button>
            {renderedWav && <button disabled={locked} onClick={() => void saveFile('toney-preview.wav', renderedWav)}>Export WAV ↓</button>}
            <span>{listenMode}</span>
          </div>
          <audio ref={audio} controls src={audioUrl || undefined} aria-label="Tone preview" />
          <p className="preview-note">Synthetic plucked strings by default. Import your guitar DI for a useful audition. Imported NAM captures and cabinet IRs require native rendering in the desktop app. Browser preview supports builtin effects. Live guitar input comes later.</p>
        </section>
        <section className="history-panel"><div className="history-heading"><span className="eyebrow">TONE HISTORY</span>
          <button disabled={locked} onClick={() => setHistory((items) => [...items, tone].slice(-20))}>Snapshot current rig +</button></div>
          {history.length === 0 ? <p className="empty-history">Your first tone starts here. Generated tones and snapshots stay on this device.</p>
            : <div className="versions">{history.map((version, index) => <button key={`${version.id}-${index}`} disabled={locked}
              onClick={() => { setTone(version); setIntent(undefined); setMessage('History restored. I’ll refine this version with your next request.'); }}>
              <span>{String(index + 1).padStart(2, '0')}</span>{version.name}<small>r{version.revision}</small></button>)}</div>}
        </section>
      </section>
    </main>
    {error && <div className="error-banner" role="alert"><strong>Something needs attention</strong><span>{error}</span><button onClick={() => setError('')}>Dismiss</button></div>}
    <footer><span><i /> LOCAL SESSION · {tone.chain.filter((node) => node.enabled).length} EFFECTS ENGAGED</span>
      <button onClick={() => setDiagnostics(!diagnostics)}>{diagnostics ? 'Close' : 'Open'} diagnostics {trace ? `· ${trace.id.slice(0, 8)}` : ''}</button></footer>
    {diagnostics && <section className="diagnostics"><div className="history-heading"><h3>Request diagnostics</h3>
      <button onClick={() => saveJSON('toney-diagnostics.json', { trace, request: lastRequest, nativeDiagnostics, currentTone: tone, error })}>Export trace ↓</button></div>
      <p>Exports include your prompt and rig. Diagnostics remain on this device.</p><pre>{JSON.stringify(trace ?? { status: 'No agent request yet.' }, null, 2)}</pre>
      {nativeDiagnostics.length > 0 && <details><summary>Native requests</summary><pre>{JSON.stringify(nativeDiagnostics, null, 2)}</pre></details>}
      <details><summary>Current preset JSON</summary><p>If your browser blocks downloads, copy this text into a JSON file.</p>
        <textarea aria-label="Current preset JSON" readOnly value={JSON.stringify(tone, null, 2)} rows={12} /></details>
    </section>}
    <input className="hidden-input" ref={presetInput} type="file" accept=".json,application/json" onChange={(event) => void importPreset(event.target.files?.[0])} />
    <input className="hidden-input" ref={diInput} type="file" accept="audio/*,.wav,.aiff,.flac" onChange={(event) => void importDI(event.target.files?.[0])} />
  </div>;
}
