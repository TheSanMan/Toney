import { INTENT_PATHS, type IntentPath } from '../tone/types';
import { object, validateToneIntent } from '../tone/validation';
import type { IntentProvider, Interpretation, ProviderRequest } from './types';

const numeric = { type: 'number', minimum: 0, maximum: 1 };
const group = (names: string[]): Record<string, unknown> => ({ type: 'object', additionalProperties: false, required: names, properties: Object.fromEntries(names.map((name) => [name, numeric])) });

export const OLLAMA_INTENT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['intent', 'changedPaths', 'warnings', 'issues'],
  properties: {
    intent: {
      type: 'object', additionalProperties: false, required: ['character', 'distortion', 'dynamics', 'space', 'references'],
      properties: {
        character: group(['brightness', 'warmth', 'aggression', 'clarity', 'sustain', 'width']),
        distortion: { type: 'object', additionalProperties: false, required: ['amount', 'texture'], properties: { amount: numeric, texture: { type: 'string', enum: ['clean', 'crunch', 'gritty', 'smooth'] } } },
        dynamics: group(['compression', 'transientPreservation']),
        space: group(['reverb', 'delay']),
        references: { type: 'array', maxItems: 10, items: { type: 'string' } },
      },
    },
    changedPaths: { type: 'array', uniqueItems: true, items: { type: 'string', enum: INTENT_PATHS } },
    warnings: { type: 'array', items: { type: 'string' } },
    issues: { type: 'array', uniqueItems: true, items: { type: 'string', enum: ['muddy', 'harsh'] } },
  },
};

export type OllamaTransport = (body: string, signal: AbortSignal) => Promise<Response>;

const browserTransport: OllamaTransport = (body, signal) => fetch('/api/ollama/chat', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body,
});

export class OllamaProvider implements IntentProvider {
  readonly name: string;
  constructor(private readonly model: string, private readonly transport: OllamaTransport = browserTransport) {
    if (!model.trim() || model.length > 200) throw new Error('Select an installed Ollama model.');
    this.name = `Local Ollama (${model})`;
  }

  async interpret(request: ProviderRequest): Promise<Interpretation> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    try {
      let response: Response;
      try {
        response = await this.transport(JSON.stringify({ model: this.model, stream: false, format: OLLAMA_INTENT_SCHEMA, options: { temperature: 0 }, messages: [
            { role: 'system', content: 'You are a guitar tone engineer. Translate the request into the provided perceptual intent schema. Values are 0 to 1. This is local inference. Return only structured JSON. Baseline is derived from current manual controls and is authoritative. For refinement, change only requested intent fields, list exactly those fields in changedPaths, and preserve all others. Never claim to have measured audio or verified an artist rig. If language is ambiguous, provide warnings. References are broad style cues. Use issues muddy or harsh only when the user requests those corrections. Never emit DSP parameter calls.' },
            { role: 'user', content: JSON.stringify({ prompt: request.prompt, baseline: request.baseline, mode: request.currentTone ? 'refine' : 'generate', ...(request.currentTone ? { currentTone: request.currentTone } : {}) }) },
          ] }), controller.signal);
      } catch (error: unknown) {
        throw new Error(controller.signal.aborted ? 'Local Ollama inference timed out after 45 seconds.' : 'Cannot reach local Ollama. Start Ollama and use an installed model.', { cause: error });
      }
      if (!response.ok) throw new Error(`Local Ollama returned HTTP ${response.status}. Check that the selected model is installed and the local service is running.`);
      const envelope = object(await response.json() as unknown, 'ollama');
      const message = object(envelope.message, 'ollama.message');
      if (typeof message.content !== 'string') throw new Error('Local Ollama returned no structured message content.');
      let parsed: unknown;
      try { parsed = JSON.parse(message.content) as unknown; }
      catch (error: unknown) { throw new Error('Local Ollama returned malformed JSON; the rig has not been changed.', { cause: error }); }
      const value = object(parsed, 'interpretation');
      const intent = validateToneIntent(value.intent);
      if (!Array.isArray(value.changedPaths) || value.changedPaths.some((path: unknown) => typeof path !== 'string' || !INTENT_PATHS.includes(path as IntentPath))) throw new Error('Local Ollama returned unsupported intent field names.');
      if (!Array.isArray(value.warnings) || value.warnings.some((warning: unknown) => typeof warning !== 'string' || warning.length > 2000)) throw new Error('Local Ollama returned malformed warnings.');
      if (!Array.isArray(value.issues) || value.issues.some((issue: unknown) => issue !== 'muddy' && issue !== 'harsh')) throw new Error('Local Ollama returned unsupported engineering issues.');
      return { intent, changedPaths: value.changedPaths as IntentPath[], warnings: value.warnings as string[], issues: value.issues as ('muddy' | 'harsh')[] };
    } finally { clearTimeout(timeout); }
  }
}
