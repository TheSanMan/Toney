import type { IntentPath, ToneIntent, ToneSpec } from '../tone/types';

export interface AgentTrace {
  id: string;
  provider: string;
  startedAt: string;
  events: { stage: string; durationMs: number; detail: string }[];
}

export interface AgentResult { tone: ToneSpec; intent: ToneIntent; message: string; warnings: string[]; trace: AgentTrace }
export interface AgentRequest { prompt: string; currentTone?: ToneSpec; previousIntent?: ToneIntent }
export interface ProviderRequest { prompt: string; baseline: ToneIntent; currentTone?: ToneSpec }
export interface Interpretation {
  intent: ToneIntent;
  changedPaths: IntentPath[];
  warnings: string[];
  issues: ('muddy' | 'harsh')[];
}
export interface IntentProvider { readonly name: string; interpret(request: ProviderRequest): Promise<Interpretation> }

export class AgentError extends Error {
  constructor(readonly code: string, message: string, readonly trace: AgentTrace, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentError';
  }
}
