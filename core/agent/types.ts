import { INTENT_PATHS, type IntentPath, type ToneIntent, type ToneSpec } from '../tone/types';
import type { NativeAssetDescriptor } from '../native/assets';
import { object, validateToneIntent } from '../tone/validation';

export interface AgentTrace {
  id: string;
  provider: string;
  startedAt: string;
  events: { stage: string; durationMs: number; detail: string }[];
}

export interface GearRecommendation { role: 'pedal' | 'amp' | 'cab'; label: string; rationale: string; searchQuery: string; localAssetId?: string; builtinType?: 'chorus' | 'delay' | 'reverb' }
export interface MixSetting { nodeId: string; mix: number }

export interface AgentResult { tone: ToneSpec; intent: ToneIntent; message: string; explanation?: string; warnings: string[]; trace: AgentTrace; recommendations?: GearRecommendation[] }
export interface AgentRequest { prompt: string; currentTone?: ToneSpec; previousIntent?: ToneIntent; availableAssets?: NativeAssetDescriptor[] }
export interface ProviderRequest { prompt: string; baseline: ToneIntent; currentTone?: ToneSpec }
export interface Interpretation {
  intent: ToneIntent;
  changedPaths: IntentPath[];
  warnings: string[];
  issues: ('muddy' | 'harsh')[];
  explanation?: string;
  mixSettings?: MixSetting[];
  gearRecommendations?: GearRecommendation[];
}
export interface IntentProvider { readonly name: string; interpret(request: ProviderRequest): Promise<Interpretation> }

export class AgentError extends Error {
  constructor(readonly code: string, message: string, readonly trace: AgentTrace, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentError';
  }
}

/** Shared strict interpretation boundary for cloud output and custom providers. */
export function validateInterpretation(input: unknown): Interpretation {
  const value = object(input, 'interpretation');
  const required = ['intent', 'changedPaths', 'warnings', 'issues'];
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && key !== 'explanation' && key !== 'mixSettings' && key !== 'gearRecommendations')) throw new Error('Provider returned unexpected interpretation fields.');
  const intent = validateToneIntent(value.intent);
  if (!Array.isArray(value.changedPaths) || value.changedPaths.length > INTENT_PATHS.length || new Set(value.changedPaths).size !== value.changedPaths.length || value.changedPaths.some((path: unknown) => !INTENT_PATHS.includes(path as IntentPath))) throw new Error('Provider returned unsupported intent paths.');
  if (!Array.isArray(value.warnings) || value.warnings.length > 20 || value.warnings.some((warning: unknown) => typeof warning !== 'string' || warning.length > 2000)) throw new Error('Provider returned invalid warnings.');
  if (!Array.isArray(value.issues) || value.issues.length > 2 || new Set(value.issues).size !== value.issues.length || value.issues.some((issue: unknown) => issue !== 'muddy' && issue !== 'harsh')) throw new Error('Provider returned unsupported engineering issues.');
  if (Object.hasOwn(value, 'explanation') && (typeof value.explanation !== 'string' || !value.explanation.trim() || value.explanation.length > 2000 || Array.from(value.explanation).some((character) => { const code = character.charCodeAt(0); return code < 32 && ![9, 10, 13].includes(code) || code === 127; }))) throw new Error('Provider returned an invalid engineering explanation.');
  let mixSettings: MixSetting[] | undefined;
  if (Object.hasOwn(value, 'mixSettings')) {
    if (!Array.isArray(value.mixSettings) || value.mixSettings.length > 24) throw new Error('Provider returned invalid mix settings.');
    const seen = new Set<string>();
    mixSettings = value.mixSettings.map((input: unknown) => {
      const row = object(input, 'mixSetting');
      if (Object.keys(row).length !== 2 || typeof row.nodeId !== 'string' || !row.nodeId.trim() || row.nodeId.length > 100 || seen.has(row.nodeId) || typeof row.mix !== 'number' || !Number.isFinite(row.mix) || row.mix < 0 || row.mix > 1) throw new Error('Provider returned invalid or duplicate mix settings.');
      seen.add(row.nodeId);
      return { nodeId: row.nodeId, mix: row.mix };
    });
  }
  let gearRecommendations: GearRecommendation[] | undefined;
  if (Object.hasOwn(value, 'gearRecommendations')) {
    if (!Array.isArray(value.gearRecommendations) || value.gearRecommendations.length > 8) throw new Error('Provider returned invalid gear recommendations.');
    gearRecommendations = value.gearRecommendations.map((input: unknown) => {
      const row = object(input, 'gearRecommendation');
      if (Object.keys(row).some((key) => !['role', 'label', 'rationale', 'searchQuery', 'builtinType'].includes(key)) || !['pedal', 'amp', 'cab'].includes(String(row.role)) || ['label', 'rationale', 'searchQuery'].some((key) => typeof row[key] !== 'string' || !(row[key] as string).trim() || (row[key] as string).length > 600 || Array.from(row[key] as string).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) || row.builtinType != null && (row.role !== 'pedal' || !['chorus', 'delay', 'reverb'].includes(String(row.builtinType)))) throw new Error('Provider returned unsupported gear recommendations.');
      return { role: row.role as GearRecommendation['role'], label: row.label as string, rationale: row.rationale as string, searchQuery: row.searchQuery as string, ...(typeof row.builtinType === 'string' ? { builtinType: row.builtinType as GearRecommendation['builtinType'] } : {}) };
    });
  }
  return { intent, changedPaths: value.changedPaths as IntentPath[], warnings: value.warnings as string[], issues: value.issues as ('muddy' | 'harsh')[], ...(mixSettings ? { mixSettings } : {}), ...(gearRecommendations ? { gearRecommendations } : {}), ...(typeof value.explanation === 'string' ? { explanation: value.explanation.trim() } : {}) };
}
