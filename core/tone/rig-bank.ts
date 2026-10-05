import { validateNativeAssetDescriptor, type NativeAssetDescriptor } from '../native/assets';
import type { ToneSpec } from './types';
import { validateToneSpec } from './validation';

export const RIG_BANK_STORAGE_KEY = 'toney.rig-bank.v1';
export const MAX_SAVED_RIGS = 64;
export const MAX_RIG_BANK_BYTES = 4 * 1024 * 1024;
export interface SavedRig {
  id: string;
  name: string;
  tone: ToneSpec;
  /** Referenced library metadata, including creator/license; audio/model bytes stay in the library. */
  assets: NativeAssetDescriptor[];
  createdAt: string;
  updatedAt: string;
  slot?: number;
}
export interface RigBank { schemaVersion: 1; rigs: SavedRig[] }
export interface RigSwitchCommand { type: 'recall-slot'; slot: number; source: 'keyboard' | 'hardware' | 'ui' }
export class RigBankError extends Error {
  readonly code = 'INVALID_RIG_BANK';
  constructor(message: string) { super(message); this.name = 'RigBankError'; }
}
function fail(message: string): never { throw new RigBankError(message); }
function record(value: unknown, fields: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Expected a rig bank object.');
  const obj = value as Record<string, unknown>;
  if (fields.some((field) => !Object.hasOwn(obj, field)) || Object.keys(obj).some((field) => !fields.includes(field) && !optional.includes(field))) return fail('Unexpected or missing rig bank fields.');
  return obj;
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return fail('Rig names must contain 1 to 80 characters without control characters.');
  return value.trim();
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) return fail('Invalid saved rig ID.');
  return value;
}
function time(value: unknown): string {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) return fail('Invalid saved rig timestamp.');
  return value;
}
function slotNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 9) return fail('Switch slots must be between 1 and 9.');
  return value;
}
function descriptors(input: unknown, tone: ToneSpec): NativeAssetDescriptor[] {
  if (!Array.isArray(input) || input.length > 32) return fail('Expected at most 32 referenced asset descriptors.');
  const referenced = new Map(tone.chain.filter((node) => node.asset).map((node) => [node.asset!.id, node.asset!.kind]));
  const seen = new Set<string>();
  return input.map((entry: unknown) => {
    const descriptor = validateNativeAssetDescriptor(entry, 'rig-bank');
    if (seen.has(descriptor.asset.id) || referenced.get(descriptor.asset.id) !== descriptor.asset.kind) return fail('Rig metadata has duplicate or unreferenced assets.');
    seen.add(descriptor.asset.id);
    return descriptor;
  });
}
export function validateRigBank(input: unknown): RigBank {
  try {
    const bank = record(input, ['schemaVersion', 'rigs']);
    if (bank.schemaVersion !== 1 || !Array.isArray(bank.rigs) || bank.rigs.length > MAX_SAVED_RIGS) return fail('Unsupported or oversized rig bank.');
    const ids = new Set<string>();
    const slots = new Set<number>();
    const rigs = bank.rigs.map((entry: unknown): SavedRig => {
      const value = record(entry, ['id', 'name', 'tone', 'assets', 'createdAt', 'updatedAt'], ['slot']);
      const rigId = id(value.id);
      const tone = validateToneSpec(value.tone);
      const slot = value.slot === undefined ? undefined : slotNumber(value.slot);
      if (ids.has(rigId) || (slot !== undefined && slots.has(slot))) return fail('Duplicate saved rig ID or switch slot.');
      ids.add(rigId);
      if (slot !== undefined) slots.add(slot);
      return { id: rigId, name: name(value.name), tone, assets: descriptors(value.assets, tone), createdAt: time(value.createdAt), updatedAt: time(value.updatedAt), ...(slot !== undefined ? { slot } : {}) };
    });
    return { schemaVersion: 1, rigs };
  } catch (error: unknown) {
    if (error instanceof RigBankError) throw error;
    return fail(error instanceof Error ? `Invalid saved rig: ${error.message}` : 'Invalid saved rig.');
  }
}
export function createRigBank(): RigBank { return { schemaVersion: 1, rigs: [] }; }
/** Corruption throws; callers must keep the original bytes instead of replacing them with an empty bank. */
export function readRigBank(serialized: string | null): RigBank {
  if (serialized === null) return createRigBank();
  if (new TextEncoder().encode(serialized).byteLength > MAX_RIG_BANK_BYTES) return fail('Saved rig bank exceeds 4 MiB.');
  try { return validateRigBank(JSON.parse(serialized) as unknown); }
  catch (error: unknown) { if (error instanceof RigBankError) throw error; return fail('Saved rig bank contains invalid JSON.'); }
}
export function serializeRigBank(bank: RigBank): string {
  const serialized = JSON.stringify(validateRigBank(bank));
  if (new TextEncoder().encode(serialized).byteLength > MAX_RIG_BANK_BYTES) return fail('Saved rig bank exceeds 4 MiB.');
  return serialized;
}
function snapshot(toneInput: ToneSpec, assets: NativeAssetDescriptor[] = []): Pick<SavedRig, 'tone' | 'assets'> {
  const tone = validateToneSpec(toneInput);
  const ids = new Set(tone.chain.flatMap((node) => node.asset ? [node.asset.id] : []));
  return { tone, assets: descriptors(assets.filter((asset) => ids.has(asset.asset.id)), tone) };
}
interface RigSnapshotInput { tone: ToneSpec; assets?: NativeAssetDescriptor[]; now?: string }
export function saveRigAs(bankInput: RigBank, input: RigSnapshotInput & { name: string; id?: string }): RigBank {
  const bank = validateRigBank(bankInput);
  if (bank.rigs.length >= MAX_SAVED_RIGS) return fail('Rig bank is full (64 rigs).');
  const rigId = id(input.id ?? `rig_${crypto.randomUUID()}`);
  if (bank.rigs.some((rig) => rig.id === rigId)) return fail('Save as requires a new rig ID. Use overwrite explicitly.');
  const now = time(input.now ?? new Date().toISOString());
  return { schemaVersion: 1, rigs: [...bank.rigs, { id: rigId, name: name(input.name), ...snapshot(input.tone, input.assets), createdAt: now, updatedAt: now }] };
}
export function overwriteRig(bankInput: RigBank, rigId: string, input: RigSnapshotInput & { name?: string }): RigBank {
  const bank = validateRigBank(bankInput);
  if (!bank.rigs.some((rig) => rig.id === rigId)) return fail('Saved rig does not exist.');
  return { ...bank, rigs: bank.rigs.map((rig) => rig.id === rigId ? { ...rig, ...snapshot(input.tone, input.assets ?? rig.assets), name: input.name === undefined ? rig.name : name(input.name), updatedAt: time(input.now ?? new Date().toISOString()) } : rig) };
}
export function renameRig(bankInput: RigBank, rigId: string, newName: string): RigBank {
  const bank = validateRigBank(bankInput);
  if (!bank.rigs.some((rig) => rig.id === rigId)) return fail('Saved rig does not exist.');
  return { ...bank, rigs: bank.rigs.map((rig) => rig.id === rigId ? { ...rig, name: name(newName), updatedAt: new Date().toISOString() } : rig) };
}
export function deleteRig(bankInput: RigBank, rigId: string): RigBank {
  const bank = validateRigBank(bankInput);
  if (!bank.rigs.some((rig) => rig.id === rigId)) return fail('Saved rig does not exist.');
  return { ...bank, rigs: bank.rigs.filter((rig) => rig.id !== rigId) };
}
export function assignRigSlot(bankInput: RigBank, rigId: string, slot?: number): RigBank {
  const bank = validateRigBank(bankInput);
  if (!bank.rigs.some((rig) => rig.id === rigId)) return fail('Saved rig does not exist.');
  if (slot !== undefined) slotNumber(slot);
  return { ...bank, rigs: bank.rigs.map((rig) => {
    if (rig.id !== rigId && (slot === undefined || rig.slot !== slot)) return rig;
    const { slot: _previous, ...rest } = rig;
    void _previous;
    return rig.id === rigId && slot !== undefined ? { ...rest, slot } : rest;
  }) };
}
export function recallRig(bank: RigBank, rigId: string): SavedRig {
  const rig = validateRigBank(bank).rigs.find((entry) => entry.id === rigId);
  return rig ?? fail('Saved rig does not exist.');
}
/** A shared command boundary for future footswitch adapters; no MIDI/device assumptions. */
export function resolveRigSwitchCommand(bank: RigBank, command: RigSwitchCommand): SavedRig | undefined {
  if (command.type !== 'recall-slot' || !['keyboard', 'hardware', 'ui'].includes(command.source)) return fail('Unsupported rig switch command.');
  const slot = slotNumber(command.slot);
  return validateRigBank(bank).rigs.find((rig) => rig.slot === slot);
}
export interface RigKeyboardEvent {
  code: string; repeat?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; isComposing?: boolean; defaultPrevented?: boolean;
  target?: EventTarget | null;
}
export function rigSwitchCommandFromKeyboard(event: RigKeyboardEvent): RigSwitchCommand | undefined {
  if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing || event.defaultPrevented) return undefined;
  // Structural detection also works across embedded-window DOM realms and in tests.
  const target = event.target as (EventTarget & { tagName?: string; isContentEditable?: boolean; closest?: (selector: string) => unknown }) | null | undefined;
  if (target && (/^(INPUT|TEXTAREA|SELECT)$/i.test(target.tagName ?? '') || target.isContentEditable || target.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])'))) return undefined;
  const match = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
  return match ? { type: 'recall-slot', slot: Number(match[1]), source: 'keyboard' } : undefined;
}
