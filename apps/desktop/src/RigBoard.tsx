import { useState } from 'react';
import { getNodeDefinition, setNodeEnabled, setToneAsset, setToneParameter, type NodeType, type ToneSpec } from '../../../core';
import { appendToneNode, removeToneNode, moveToneNode, setToneNodeMix, cloneTone, revised } from '../../../core/tone/operations';
import type { NativeAssetDescriptor } from '../../../core/native/assets';

const PEDALS: NodeType[] = ['drive', 'compressor', 'eq', 'chorus', 'delay', 'reverb'];

export function RigBoard({ tone, assets, locked, onChange, onBrowse }: {
  tone: ToneSpec; assets: NativeAssetDescriptor[]; locked: boolean;
  onChange: (tone: ToneSpec) => void; onBrowse: () => void;
}) {
  const [selectedId, setSelectedId] = useState('');
  const [addType, setAddType] = useState<NodeType>('drive');
  const [error, setError] = useState('');
  const selected = tone.chain.find((node) => node.id === selectedId) ?? tone.chain[0];
  function change(operation: () => ToneSpec) {
    try { onChange(operation()); setError(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not change this stage.'); }
  }
  const definition = getNodeDefinition(selected);
  const choices = assets.filter((item) => item.asset.kind === (selected.type === 'cab' ? 'ir' : 'nam'));
  const hasAssetSlot = ['drive', 'amp', 'cab'].includes(selected.type);
  return <div className="board-workspace">
    <div className="board-toolbar"><span>Guitar → pedals → amp → cabinet → effects</span>
      <label className="sr-only" htmlFor="add-effect">Add effect type</label>
      <select id="add-effect" value={addType} disabled={locked} onChange={(event) => setAddType(event.target.value as NodeType)}>
        {PEDALS.map((type) => <option key={type} value={type}>{type === 'drive' ? 'Drive / NAM pedal' : type[0].toUpperCase() + type.slice(1)}</option>)}
      </select>
      <button disabled={locked || tone.chain.length >= 32} onClick={() => change(() => {
        const next = appendToneNode(tone, addType);
        setSelectedId(next.chain.find((node) => !tone.chain.some((current) => current.id === node.id))?.id ?? '');
        return next;
      })}>+ Add stage</button><button onClick={onBrowse}>Browse gear</button>
    </div>
    <div className="chain-rack" aria-label="Signal chain">{tone.chain.map((node, index) => <div key={node.id} className={`stage-card stage-${node.type} ${node.enabled ? '' : 'stage-bypassed'} ${selected.id === node.id ? 'selected' : ''}`}>
      <button className="stage-select" aria-pressed={selected.id === node.id} onClick={() => setSelectedId(node.id)}>
        <span className="stage-number">{String(index + 1).padStart(2, '0')} <i className={node.enabled ? 'lit' : ''} /></span>
        <strong>{node.asset?.name ?? getNodeDefinition(node).name}</strong>
        <small>{node.model === 'nam' ? 'NAM capture' : node.model === 'cab_ir' ? 'Cabinet IR' : node.type} · {Math.round((node.mix ?? 1) * 100)}% wet</small>
      </button>
      <button className="stage-bypass" disabled={locked} aria-pressed={node.enabled} onClick={() => change(() => setNodeEnabled(tone, node.id, !node.enabled))}>{node.enabled ? 'On' : 'Bypassed'}</button>
    </div>)}</div>
    <section className="stage-inspector" aria-label="Selected stage controls">
      <div className="inspector-heading"><div><span className="eyebrow">SELECTED STAGE</span><h3>{selected.asset?.name ?? definition.name}</h3><p>{selected.model === 'nam' ? 'Capture trims and external EQ · the original captured settings stay fixed' : 'Dial in this stage or ask your tone engineer to change its mix.'}</p></div>
        <div className="inspector-actions"><button disabled={locked || tone.chain[0].id === selected.id} aria-label="Move stage earlier" onClick={() => change(() => moveToneNode(tone, selected.id, -1))}>← Earlier</button>
          <button disabled={locked || tone.chain.at(-1)?.id === selected.id} aria-label="Move stage later" onClick={() => change(() => moveToneNode(tone, selected.id, 1))}>Later →</button>
          {!['amp', 'cab'].includes(selected.type) && <button disabled={locked} onClick={() => change(() => removeToneNode(tone, selected.id))}>Remove</button>}</div>
      </div>
      <div className="inspector-controls">{Object.entries(definition.parameters).map(([key, parameter]) => {
        const captureTrim = selected.model === 'nam' && ['gain', 'master', 'level', 'tone'].includes(key);
        const display = captureTrim ? (selected.parameters[key] - 0.5) * (key === 'tone' ? 12 : 24) : selected.parameters[key];
        return <label key={key}>{parameter.label}<output>{display.toFixed(2)} {captureTrim ? 'dB' : parameter.unit ?? ''}</output>
          <input type="range" min={parameter.min} max={parameter.max} step="0.001" value={selected.parameters[key]} disabled={locked}
            aria-label={`${definition.name} ${parameter.label}`} onChange={(event) => change(() => setToneParameter(tone, selected.id, key, Number(event.target.value)))} /></label>;
      })}
        <label>Stage wet / dry<output>{Math.round((selected.mix ?? 1) * 100)}% wet</output>
          <input aria-label="Stage wet dry mix" type="range" min="0" max="1" step="0.01" value={selected.mix ?? 1} disabled={locked} onChange={(event) => change(() => setToneNodeMix(tone, selected.id, Number(event.target.value)))} /></label>
      </div>
      {hasAssetSlot && <label className="inspector-asset">{selected.type === 'cab' ? 'Cabinet IR' : selected.type === 'amp' ? 'Amp capture' : 'Pedal capture'}
        <select value={selected.asset?.id ?? ''} disabled={locked} onChange={(event) => change(() => setToneAsset(tone, selected.id, choices.find((item) => item.asset.id === event.target.value)?.asset))}>
          <option value="">Built-in {selected.type === 'drive' ? 'drive' : selected.type === 'amp' ? 'amp' : 'cabinet filter'}</option>
          {selected.asset && !choices.some((item) => item.asset.id === selected.asset?.id) && <option value={selected.asset.id} disabled>Missing · {selected.asset.name}</option>}
          {choices.map((item) => <option key={item.asset.id} value={item.asset.id}>{item.asset.name}</option>)}
        </select></label>}
      {(selected.model === 'nam' || selected.model === 'cab_ir') && <button className="capture-neutral" disabled={locked} onClick={() => change(() => {
        const next = cloneTone(tone);
        const node = next.chain.find((item) => item.id === selected.id)!;
        for (const key of Object.keys(node.parameters)) node.parameters[key] = key === 'resonance' ? 0 : 0.5;
        return revised(next, 'manual');
      })}>Reset capture trims / EQ to neutral</button>}
      {selected.type === 'chorus' && <p className="preview-note">Chorus needs a moving delay line. Use this modulation stage alongside a NAM fuzz or drive capture.</p>}
      {error && <p role="alert" className="native-error">{error}</p>}
    </section>
  </div>;
}
