import { useState } from 'react';
import type { RigBank, SavedRig } from '../../../core/tone/rig-bank';

interface Props {
  bank: RigBank; activeId?: string; dirty: boolean; locked: boolean; storageError?: string;
  onSave: (name: string) => void; onOverwrite: (id: string) => void; onRename: (id: string, name: string) => void;
  onAssign: (id: string, slot?: number) => void; onRemove: (id: string) => void; onRecall: (id: string) => void;
}

function SavedRigCard({ rig, active, dirty, locked, onRecall, onOverwrite, onRename, onAssign, onRemove }: {
  rig: SavedRig; active: boolean; dirty: boolean; locked: boolean;
  onRecall: Props['onRecall']; onOverwrite: Props['onOverwrite']; onRename: Props['onRename'];
  onAssign: Props['onAssign']; onRemove: Props['onRemove'];
}) {
  const [name, setName] = useState(rig.name);
  const captures = rig.tone.chain.filter((node) => node.asset);
  return <article className={`saved-rig ${active ? 'selected' : ''}`}>
    <div className="saved-rig-title"><strong>{rig.name}</strong><small>{active ? dirty ? 'Selected · edited' : 'Selected' : `${rig.tone.chain.filter((node) => node.enabled).length} stages on`}</small></div>
    <p>{captures.length ? captures.map((node) => `${node.enabled ? '' : '(bypassed) '}${node.asset!.name}`).join(' → ') : 'Builtin effects · no external captures'}</p>
    <div className="saved-rig-actions"><button className="primary" disabled={locked} onClick={() => onRecall(rig.id)}>Play this rig</button>
      <label>Keyboard slot<select aria-label={`Keyboard slot for ${rig.name}`} value={rig.slot ?? ''} disabled={locked} onChange={(event) => onAssign(rig.id, event.target.value ? Number(event.target.value) : undefined)}>
        <option value="">Unassigned</option>{Array.from({ length: 9 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}
      </select></label>
      <button disabled={locked} onClick={() => { if (window.confirm(`Replace “${rig.name}” with the current pedalboard and its exact capture settings?`)) onOverwrite(rig.id); }}>Replace with current</button>
    </div>
    <details><summary>Manage saved rig</summary><div className="saved-rig-actions">
      <label>Name<input aria-label={`Rename ${rig.name}`} value={name} maxLength={80} disabled={locked} onChange={(event) => setName(event.target.value)} /></label>
      <button disabled={locked || !name.trim() || name.trim() === rig.name} onClick={() => onRename(rig.id, name)}>Rename</button>
      <button disabled={locked} onClick={() => { if (window.confirm(`Remove “${rig.name}” from saved rigs? You can undo this until the next bank edit.`)) onRemove(rig.id); }}>Remove</button>
    </div></details>
  </article>;
}

export function RigBankPanel(props: Props) {
  const [name, setName] = useState('');
  return <section className="rig-bank-panel">
    <div className="eyebrow">SAVED RIGS</div><h2>Your pedalboard, ready to recall.</h2>
    <p>Save the exact amp, pedals, cabinet, settings and blends. Downloaded model files stay in your local library.</p>
    <form className="save-rig-form" onSubmit={(event) => { event.preventDefault(); props.onSave(name); }}>
      <label>Rig name<input aria-label="New saved rig name" placeholder="Clean chorus, verse fuzz, solo…" maxLength={80} value={name} disabled={props.locked || !!props.storageError} onChange={(event) => setName(event.target.value)} /></label>
      <button className="primary" disabled={props.locked || !!props.storageError || !name.trim()}>Save current as new rig</button>
      {props.activeId && <button type="button" disabled={props.locked || !!props.storageError || !props.dirty} onClick={() => props.onOverwrite(props.activeId!)}>Update selected rig</button>}
    </form>
    <p className="preview-note">Assign slots 1–9, then press a number or click its button to switch. Live playback applies the saved rig automatically with a short crossfade. Capture loading can delay a switch; the previous rig plays during preparation. Keyboard bindings are ignored while typing.</p>
    {props.storageError && <p className="native-error" role="alert">{props.storageError} Existing saved data has been left intact.</p>}
    {!props.bank.rigs.length && <p className="empty-history">No saved rigs yet. Set up your sound on the pedalboard, then save it here.</p>}
    <div className="saved-rigs">{props.bank.rigs.map((rig) => <SavedRigCard key={rig.id} rig={rig} active={props.activeId === rig.id} dirty={props.dirty} locked={props.locked || !!props.storageError}
      onRecall={props.onRecall} onOverwrite={props.onOverwrite} onRename={props.onRename} onAssign={props.onAssign} onRemove={props.onRemove} />)}</div>
  </section>;
}
