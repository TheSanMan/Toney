import { useEffect, useRef, useState } from 'react';
import { selectChatGPTModel, type ChatGPTStatus } from '../../../../core/native/chatgpt';
import { NativeError } from '../../../../core/native/protocol';
import { isDesktop } from './bridge';
import { disconnectChatGPT, getChatGPTStatus, refreshChatGPTModels, signInChatGPT } from './chatgpt';
import './chatgpt.css';

export function ChatGPTPanel({ locked, model, onModel, onStatus }: {
  locked: boolean; model: string; onModel: (model: string) => void; onStatus: (status: ChatGPTStatus) => void;
}) {
  const [state, setState] = useState<ChatGPTStatus>();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const callbacks = useRef({ onStatus });
  const operation = useRef(0);
  const mounted = useRef(true);
  const desktop = isDesktop();
  useEffect(() => { callbacks.current = { onStatus }; }, [onStatus]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; operation.current += 1; }; }, []);
  useEffect(() => {
    if (!desktop) return;
    let stopped = false;
    let discovered = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const generation = operation.current;
      try {
        let next = await getChatGPTStatus();
        if (!stopped && generation === operation.current && next.status === 'connected' && next.models.length === 0 && !discovered) {
          discovered = true;
          next = await refreshChatGPTModels();
        }
        if (!stopped && generation === operation.current) { setState(next); callbacks.current.onStatus(next); }
      } catch { /* Explicit controls report failures without repeated background alerts. */ }
      if (!stopped) timer = setTimeout(() => void poll(), 2000);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [desktop]);

  async function act(action: () => Promise<ChatGPTStatus>) {
    const generation = ++operation.current;
    setWorking(true); setError('');
    try {
      const next = await action();
      if (!mounted.current || generation !== operation.current) return;
      setState(next); callbacks.current.onStatus(next);
    } catch (reason: unknown) {
      if (!mounted.current || generation !== operation.current) return;
      setError(reason instanceof NativeError ? `${reason.code}: ${reason.message} · ${reason.requestId}` : 'ChatGPT could not complete this operation. Retry sign-in.');
    } finally { if (mounted.current && generation === operation.current) setWorking(false); }
  }
  const connected = state?.status === 'connected';
  const waiting = state?.status === 'authorizing';
  const selected = selectChatGPTModel(state?.models ?? [], model);
  return <section className="chatgpt-panel" aria-label="ChatGPT account and model">
    <strong>ChatGPT tone engineer</strong>
    <p>Use your ChatGPT plan to interpret your request and explain the changes. Your prompt and rig settings go to OpenAI when you dial in a tone. Guitar audio stays on this device.</p>
    {!desktop && <p>Open Toney desktop to sign in with ChatGPT.</p>}
    <div className="chatgpt-actions">
      <button disabled={!desktop || locked || working || waiting} onClick={() => void act(signInChatGPT)}>{connected ? 'Reconnect ChatGPT' : 'Continue with ChatGPT'}</button>
      {(connected || waiting || state?.status === 'error') && <button disabled={locked || working} onClick={() => void act(disconnectChatGPT)}>{waiting ? 'Cancel sign-in' : 'Disconnect'}</button>}
    </div>
    {waiting && <p role="status">Finish sign-in in your browser. Toney will update automatically.</p>}
    {connected && <>
      <small>Signed in{state.account?.email ? ` as ${state.account.email}` : ''}</small>
      <label>Available model<select value={selected} disabled={locked || working || !selected} onChange={(event) => onModel(event.target.value)}>
        {!state.models.length && <option value="">No models available</option>}
        {state.models.map((item) => <option key={item.slug} value={item.slug}>{item.displayName}</option>)}
      </select></label>
      <button disabled={locked || working} onClick={() => void act(refreshChatGPTModels)}>Refresh available models</button>
      {!state.models.length && <p role="status">No available models were discovered. Refresh the catalog or sign in again.</p>}
      <small>Prefers GPT-6 Astra when available, then GPT-6.1 Sol, then your account’s first available model. Your selected model is kept while available.</small>
    </>}
    {state?.error && <p className="chatgpt-error" role="alert">{state.error.code}: {state.error.message} · {state.requestId}</p>}
    {error && <p className="chatgpt-error" role="alert">{error}</p>}
    <small>ChatGPT plan limits apply and are shared across apps. Toney cannot guarantee unlimited usage or access to a particular model. Offline rules and local Ollama are available in Interpretation.</small>
  </section>;
}
