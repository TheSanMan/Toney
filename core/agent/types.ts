import { INTENT_PATHS, type IntentPath, type ToneIntent, type ToneSpec } from '../tone/types';
import { object, validateToneIntent } from '../tone/validation';

export interface AgentTrace {
  id: string;
  provider: string;
  startedAt: string;
  events: { stage: string; durationMs: number; detail: string }[];
}

export interface AgentResult { tone: ToneSpec; intent: ToneIntent; message: string; explanation?: string; warnings: string[]; trace: AgentTrace }
export interface AgentRequest { prompt: string; currentTone?: ToneSpec; previousIntent?: ToneIntent }
export interface ProviderRequest { prompt: string; baseline: ToneIntent; currentTone?: ToneSpec }
export interface Interpretation {
  intent: ToneIntent;
  changedPaths: IntentPath[];
  warnings: string[];
  issues: ('muddy' | 'harsh')[];
  explanation?: string;
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
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && key !== 'explanation')) throw new Error('Provider returned unexpected interpretation fields.');
  const intent = validateToneIntent(value.intent);
  if (!Array.isArray(value.changedPaths) || value.changedPaths.length > INTENT_PATHS.length || new Set(value.changedPaths).size !== value.changedPaths.length || value.changedPaths.some((path: unknown) => !INTENT_PATHS.includes(path as IntentPath))) throw new Error('Provider returned unsupported intent paths.');
  if (!Array.isArray(value.warnings) || value.warnings.length > 20 || value.warnings.some((warning: unknown) => typeof warning !== 'string' || warning.length > 2000)) throw new Error('Provider returned invalid warnings.');
  if (!Array.isArray(value.issues) || value.issues.length > 2 || new Set(value.issues).size !== value.issues.length || value.issues.some((issue: unknown) => issue !== 'muddy' && issue !== 'harsh')) throw new Error('Provider returned unsupported engineering issues.');
  if (Object.hasOwn(value, 'explanation') && (typeof value.explanation !== 'string' || !value.explanation.trim() || value.explanation.length > 2000 || Array.from(value.explanation).some((character) => { const code = character.charCodeAt(0); return code < 32 && ![9, 10, 13].includes(code) || code === 127; }))) throw new Error('Provider returned an invalid engineering explanation.');
  return { intent, changedPaths: value.changedPaths as IntentPath[], warnings: value.warnings as string[], issues: value.issues as ('muddy' | 'harsh')[], ...(typeof value.explanation === 'string' ? { explanation: value.explanation.trim() } : {}) };
}
