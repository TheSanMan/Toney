import { useEffect, useRef, useState } from 'react';
import {
  AgentError, ChatGPTProvider, OllamaProvider, ToneAgent, createInitialTone, collectToneAssets,
  setToneAsset, validateToneSpec,
  type AgentTrace, type ToneIntent, type ToneSpec, type GearRecommendation,
} from '../../../core';
import { RigBoard } from './RigBoard';
import { appendToneNode, cloneTone, revised } from '../../../core/tone/operations';
import type { NativeAssetDescriptor } from '../../../core/native/assets';
import type { Tone3000Target } from '../../../core/native/tone3000';
import { bufferToWav, createDemoBuffer, renderTone } from './audio/preview';
import { desktopOllamaTransport, exportNativeFile, isDesktop, renderNativeAudio } from './native/bridge';
import { NativeError } from '../../../core/native/protocol';
import { AudioDevicesPanel, type NativeDiagnostic } from './native/AudioDevicesPanel';
import { AssetLibraryPanel } from './native/AssetLibraryPanel';
import { ChatGPTPanel } from './native/ChatGPTPanel';
import { desktopChatGPTTransport } from './native/chatgpt';
import { selectChatGPTModel, type ChatGPTStatus } from '../../../core/native/chatgpt';

const STORAGE_KEY = 'toney.workbench.v1';
const CURRENT_TONE_KEY = 'toney.current-tone.v1';
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

function readCurrentTone(fallback: ToneSpec): ToneSpec {
  try {
    const raw = localStorage.getItem(CURRENT_TONE_KEY);
    return raw ? validateToneSpec(JSON.parse(raw)) : fallback;
  } catch { return fallback; }
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

export function App() {
  const [view, setView] = useState<'board' | 'gear' | 'audition' | 'history'>('board');
  const [assets, setAssets] = useState<NativeAssetDescriptor[]>([]);
  const [recommendations, setRecommendations] = useState<GearRecommendation[]>([]);
  const [browseRequest, setBrowseRequest] = useState<{ target: Tone3000Target; query: string; id: string }>();
  const [explanation, setExplanation] = useState('');
  const [history, setHistory] = useState<ToneSpec[]>(readHistory);
  const [tone, setTone] = useState<ToneSpec>(() => readCurrentTone(history.at(-1) ?? createInitialTone()));
  const [intent, setIntent] = useState<ToneIntent>();
  const [prompt, setPrompt] = useState(EXAMPLES[0]);
  const [provider, setProvider] = useState('chatgpt');
  const [chatgptModel, setChatGPTModel] = useState('');
  const [chatgptStatus, setChatGPTStatus] = useState<ChatGPTStatus>();
  const [model, setModel] = useState('llama3:latest');
  const [busy, setBusy] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [liveMonitoring, setLiveMonitoring] = useState(false);
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
    try { localStorage.setItem(CURRENT_TONE_KEY, JSON.stringify(tone)); }
    catch { setError('Current rig could not be saved on this device. Export your preset to keep it.'); }
  }, [tone]);

  useEffect(() => {
    audio.current?.pause();
    audio.current?.removeAttribute('src');
    audio.current?.load();
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
    setLastRequest({ prompt, currentTone: tone, provider, model: provider === 'chatgpt' ? chatgptModel : model });
    try {
      if (provider === 'chatgpt' && (chatgptStatus?.status !== 'connected' || !chatgptStatus.models.some((item) => item.slug === chatgptModel))) throw new Error('Continue with ChatGPT and choose an available model before dialing in your tone.');
      const agent = new ToneAgent(provider === 'chatgpt' ? new ChatGPTProvider(chatgptModel, desktopChatGPTTransport) : provider === 'ollama' ? new OllamaProvider(model.trim(), desktop ? desktopOllamaTransport : undefined) : undefined);
      const result = await agent.run({ prompt, currentTone: tone, previousIntent: intent, availableAssets: assets });
      keep(result.tone);
      setIntent(result.intent);
      setRecommendations(result.recommendations ?? []);
      setExplanation(result.explanation ?? '');
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

  function browseRecommendation(item: GearRecommendation) {
    setView('gear');
    setBrowseRequest({ target: item.role === 'pedal' ? 'drive' : item.role, query: item.searchQuery, id: crypto.randomUUID() });
  }

  function useRecommendedAsset(item: GearRecommendation) {
    const asset = assets.find((entry) => entry.asset.id === item.localAssetId)?.asset;
    if (!asset) return;
    try {
      const node = tone.chain.find((entry) => entry.type === (item.role === 'pedal' ? 'drive' : item.role));
      setTone(item.role === 'pedal' ? appendToneNode(tone, 'drive', asset) : node ? setToneAsset(tone, node.id, asset) : tone);
      setView('board');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not use this model.'); }
  }

  function makeDirect() {
    setTone((current) => {
      const next = cloneTone(current);
      for (const node of next.chain) if (node.type === 'reverb' || node.type === 'delay') {
        node.parameters.mix = 0;
        node.enabled = false;
      }
      return revised(next, 'manual');
    });
    setMessage('Reverb and delay are off. Your amp, cabinet and pedal sound stay in place. Press Apply while playing to hear the direct tone.');
    setExplanation('');
  }

  return <div className="app-shell desktop-shell">
    <header className="app-header">
      <a className="wordmark" href="#">toney<span>●</span></a>
      <span className="session-title">{tone.name}<small>Revision {tone.revision} · saved on this device</small></span>
      <div className="rig-actions"><button disabled={locked} onClick={() => {
        setTone(createInitialTone()); setIntent(undefined); setRecommendations([]); setWarnings([]); setExplanation('');
        setMessage('A fresh starting rig. Describe the sound you want to build.');
      }}>New rig</button><button disabled={locked} onClick={() => presetInput.current?.click()}>Open preset</button>
        <button disabled={locked} onClick={() => saveJSON('toney-preset.json', tone)}>Save preset</button></div>
      <div className={`session-live ${liveMonitoring ? 'active' : ''}`}><i />{liveMonitoring ? 'LIVE GUITAR' : 'INPUT CLOSED'}</div>
    </header>
    <main className="workspace">
      <aside className="engineer-panel">
        <div className="eyebrow">TONE ENGINEER</div><h1>Find your sound.</h1>
        <form onSubmit={(event) => { event.preventDefault(); void generate(); }}>
          <label htmlFor="tone-prompt">Song, sound, or a change to your rig</label>
          <textarea id="tone-prompt" value={prompt} maxLength={2000} disabled={locked}
            onChange={(event) => setPrompt(event.target.value)} placeholder="Clean, chiming guitar like What Once Was by Her’s. Subtle chorus, no fuzz…" />
          <button className="primary generate" disabled={locked || !prompt.trim() || (provider === 'chatgpt' && (chatgptStatus?.status !== 'connected' || !chatgptModel))} type="submit">
            {busy ? 'Building your tone…' : 'Build / refine tone'} <span>↗</span>
          </button>
        </form>
        <div className="examples">{EXAMPLES.map((example, index) => <button key={example} disabled={locked} onClick={() => setPrompt(example)}>{['Warm blues', 'Dark grunge', 'Clean funk', 'Dreamy clean', 'Singing lead'][index]}</button>)}</div>
        <div className="engineer-note" aria-live="polite"><span className="note-symbol">t.</span><p>{message}</p></div>
        {explanation && explanation !== message && <p className="engineering-explanation">{explanation}</p>}
        {warnings.length > 0 && <details className="warnings"><summary>{warnings.length} tone notes</summary>{warnings.map((warning) => <p key={warning}>{warning}</p>)}</details>}
        {recommendations.length > 0 && <section className="gear-recommendations"><h3>Gear for this sound</h3>{recommendations.map((item, index) => <article key={`${item.role}-${index}`}>
          <span className="eyebrow">{item.role}</span><strong>{item.label}</strong><p>{item.rationale}</p>
          <div>{item.builtinType ? <button disabled={locked} onClick={() => {
            try { setTone(appendToneNode(tone, item.builtinType!)); setView('board'); }
            catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not add this effect.'); }
          }}>Add {item.builtinType} stage</button> : <>{item.localAssetId && <button disabled={locked} onClick={() => useRecommendedAsset(item)}>Use local model</button>}<button disabled={locked} onClick={() => browseRecommendation(item)}>Find on TONE3000 ↗</button></>}</div>
        </article>)}</section>}
        <details className="agent-connection" open={provider === 'chatgpt' && chatgptStatus?.status !== 'connected'}><summary>Agent connection · {provider === 'chatgpt' ? (chatgptStatus?.status === 'connected' ? 'ChatGPT connected' : 'Connect ChatGPT') : provider === 'offline' ? 'Offline' : 'Ollama'}</summary>
        <div className="provider-settings">
          <label htmlFor="provider">Interpretation</label>
          <select id="provider" value={provider} disabled={locked} onChange={(event) => setProvider(event.target.value)}>
            <option value="chatgpt">ChatGPT · your plan</option><option value="offline">Offline tone rules</option><option value="ollama">Local model · Ollama</option>
          </select>
          {provider === 'ollama' && <label className="model-field">Installed model
            <input value={model} disabled={locked} onChange={(event) => setModel(event.target.value)} />
            <small>Uses Ollama on this machine. First response may take longer while the model loads.</small>
          </label>}
          <small>{provider === 'offline' ? 'Deterministic interpretation · no LLM required' : provider === 'ollama' ? 'Prompts go only to local Ollama' : 'Cloud inference · sign-in required'}</small>
          {provider === 'chatgpt' && <ChatGPTPanel locked={locked} model={chatgptModel} onModel={setChatGPTModel} onStatus={(status) => {
            setChatGPTStatus(status);
            setChatGPTModel((current) => selectChatGPTModel(status.models, current));
          }} />}
        </div>
        </details>
      </aside>
      <section className="rig-panel">
        <nav className="workspace-tabs" aria-label="Workspace">{(['board', 'gear', 'audition', 'history'] as const).map((tab) => <button key={tab} aria-pressed={view === tab} onClick={() => setView(tab)}>{({board:'Pedalboard',gear:'Gear library',audition:'Audition',history:'History'})[tab]}</button>)}<span>{tone.chain.filter((node) => node.enabled).length} stages on</span></nav>
        {saveStatus && <p className="save-status" role="status">{saveStatus}</p>}
        <div className="workspace-content">
          <div hidden={view !== 'board'}><RigBoard tone={tone} assets={assets} locked={locked} onChange={setTone} onBrowse={() => setView('gear')} /></div>
          <div hidden={view !== 'gear'}><AssetLibraryPanel tone={tone} locked={locked} browseRequest={browseRequest} onAssets={setAssets}
            onSelect={(nodeId, asset) => setTone((current) => setToneAsset(current, nodeId, asset))}
            onDiagnostic={(diagnostic) => setNativeDiagnostics((items) => [...items, diagnostic].slice(-20))} /></div>
          <div hidden={view !== 'audition'}>
        <section className="listening-panel">
          <div className="listening-heading"><div className="eyebrow">HEAR THE DIFFERENCE</div>
            <label className="render-backend">Render with <select aria-label="Audio rendering backend" value={renderBackend} disabled={locked} onChange={(event) => setRenderBackend(event.target.value)}>
              <option value="browser">Browser preview</option><option value="native" disabled={!desktop}>Native DSP + NAM / IR{desktop ? '' : ' · desktop required'}</option>
            </select></label></div>
          <div className="listen-row"><div className="source-info"><span className="waveform">▂▅▃▇▂▅▆▃▁▅▃▇▅▂▆▃▁</span><strong>{sourceName}</strong></div>
            <button disabled={locked} onClick={() => diInput.current?.click()}>Import clean DI</button>
            {source && <button disabled={locked} onClick={() => { setSource(undefined); setSourceName('Built-in plucked-string phrase'); }}>Use demo</button>}
          </div>
          <div className="playback-row"><button disabled={locked || liveMonitoring} onClick={() => void listen(true)}>▷ Dry source</button>
            <button className="primary" disabled={locked || liveMonitoring} onClick={() => void listen()}>{rendering ? 'Rendering…' : '▶ Hear this rig'}</button>
            {renderedWav && <button disabled={locked} onClick={() => void saveFile('toney-preview.wav', renderedWav)}>Export WAV ↓</button>}
            <span>{listenMode}</span>
          </div>
          <audio ref={audio} controls={!liveMonitoring} src={liveMonitoring ? undefined : audioUrl || undefined} aria-label="Tone preview" />
          <p className="preview-note">Synthetic plucked strings by default. Import your guitar DI for a useful audition. Imported NAM captures and cabinet IRs require native rendering in the desktop app. Browser preview supports builtin effects. {liveMonitoring ? 'Stop live guitar to audition recordings.' : 'Use Live guitar above to play through your audio interface.'}</p>
        </section>
          </div><div hidden={view !== 'history'}>
        <section className="history-panel"><div className="history-heading"><span className="eyebrow">TONE HISTORY</span>
          <button disabled={locked} onClick={() => setHistory((items) => [...items, tone].slice(-20))}>Snapshot current rig +</button></div>
          {history.length === 0 ? <p className="empty-history">Your first tone starts here. Generated tones and snapshots stay on this device.</p>
            : <div className="versions">{history.map((version, index) => <button key={`${version.id}-${index}`} disabled={locked}
              onClick={() => { setTone(version); setIntent(undefined); setMessage('History restored. I’ll refine this version with your next request.'); }}>
              <span>{String(index + 1).padStart(2, '0')}</span>{version.name}<small>r{version.revision}</small></button>)}</div>}
        </section>
          </div>
        </div>
        <div className="play-dock"><AudioDevicesPanel tone={tone} locked={locked} onDirect={makeDirect} onDiagnostic={(diagnostic) => setNativeDiagnostics((items) => [...items, diagnostic].slice(-20))}
          onMonitoringChange={(active) => { if (active) audio.current?.pause(); setLiveMonitoring(active); }} /></div>
      </section>
    </main>
    {error && <div className="error-banner" role="alert"><strong>Something needs attention</strong><span>{error}</span><button onClick={() => setError('')}>Dismiss</button></div>}
    <footer><span><i /> {desktop ? 'DESKTOP' : 'BROWSER PREVIEW'} · Guitar → interface Hi-Z input → Toney → headphones</span><button onClick={() => setDiagnostics(!diagnostics)}>{diagnostics ? 'Close' : 'Open'} diagnostics {trace ? `· ${trace.id.slice(0, 8)}` : ''}</button></footer>
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
