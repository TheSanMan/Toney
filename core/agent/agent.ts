import { compileTone, inferIntentFromTone } from '../tone/compiler';
import { newId } from '../tone/operations';
import { DEFAULT_INTENT } from '../tone/types';
import { validateToneIntent, validateToneSpec } from '../tone/validation';
import { DeterministicProvider } from './interpreter';
import { AgentError, validateInterpretation, type AgentRequest, type AgentResult, type AgentTrace, type IntentProvider } from './types';

export class ToneAgent {
  constructor(private readonly provider: IntentProvider = new DeterministicProvider()) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    const trace: AgentTrace = { id: newId('trace'), provider: this.provider.name, startedAt: new Date().toISOString(), events: [] };
    let stage = 'request-validation';
    let start = performance.now();
    const event = (detail: string): void => { trace.events.push({ stage, durationMs: Math.round((performance.now() - start) * 100) / 100, detail }); };
    try {
      if (typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.length > 2000) throw new Error('Enter a tone description between 1 and 2000 characters.');
      const currentTone = request.currentTone ? validateToneSpec(request.currentTone) : undefined;
      if (request.previousIntent) validateToneIntent(request.previousIntent);
      // Current controls take precedence over the previous conversational intent.
      const baseline = currentTone ? inferIntentFromTone(currentTone) : structuredClone(DEFAULT_INTENT);
      event(currentTone ? `Refining rig ${currentTone.id} revision ${currentTone.revision}` : 'Creating a new rig');
      stage = 'interpretation'; start = performance.now();
      const result = validateInterpretation(await this.provider.interpret({ prompt: request.prompt, baseline, ...(currentTone ? { currentTone } : {}) }));
      const intent = validateToneIntent(result.intent);
      event(`Validated intent; requested fields: ${result.changedPaths.join(', ') || 'none'}`);
      stage = 'compilation'; start = performance.now();
      if (currentTone && result.changedPaths.length === 0 && result.issues.length === 0) {
        event('No understood change; kept the current rig and revision.');
        return { tone: currentTone, intent, message: result.explanation ?? 'I kept the current rig. Describe a specific change to gain, brightness, dynamics, or space.', ...(result.explanation ? { explanation: result.explanation } : {}), warnings: result.warnings, trace };
      }
      const compiled = compileTone(intent, { baseline, changedPaths: result.changedPaths, issues: result.issues, traceId: trace.id, ...(currentTone ? { currentTone } : {}) });
      event(compiled.changes.join('; ') || 'No parameter changes were needed.');
      stage = 'output-validation'; start = performance.now();
      const tone = validateToneSpec(compiled.tone);
      event(`Schema v${tone.schemaVersion} rig with ${tone.chain.length} nodes; revision ${tone.revision}`);
      const requested = result.changedPaths;
      const descriptions: string[] = [];
      if (result.issues.includes('muddy')) descriptions.push('I adjusted the strongest plausible source of muddiness in this rig.');
      else if (requested.includes('distortion.amount')) descriptions.push(intent.distortion.amount < baseline.distortion.amount ? 'I backed off the gain.' : 'I added drive and sustain.');
      if (requested.includes('character.brightness')) descriptions.push(intent.character.brightness < baseline.character.brightness ? 'I softened the top end.' : 'I added some top-end bite.');
      if (requested.includes('character.warmth')) descriptions.push(intent.character.warmth > baseline.character.warmth ? 'I added warmth through the amp and cabinet.' : 'I tightened the low end.');
      if (requested.includes('character.width')) descriptions.push('I adjusted chorus width.');
      if (requested.some((path) => path.startsWith('space.'))) descriptions.push('I adjusted the delay and room around the notes.');
      if (requested.some((path) => path.startsWith('dynamics.'))) descriptions.push('I adjusted the compression and pick response.');
      return { tone, intent, message: result.explanation ?? (descriptions.join(' ') || 'I built a balanced starting rig. Audition it and tell me what needs changing.'), ...(result.explanation ? { explanation: result.explanation } : {}), warnings: result.warnings, trace };
    } catch (error: unknown) {
      const failure = typeof error === 'object' && error !== null ? error as { code?: unknown; requestId?: unknown } : undefined;
      const correlation = typeof failure?.requestId === 'string' ? ` · Native request ${failure.requestId}` : '';
      const causeCode = typeof failure?.code === 'string' ? `${failure.code}: ` : '';
      event(`Failed: ${causeCode}${error instanceof Error ? error.message : 'Unknown error'}${correlation}`);
      const code = stage === 'request-validation' ? 'INVALID_REQUEST' : stage === 'interpretation' ? 'INTENT_PROVIDER_FAILED' : 'TONE_COMPILATION_FAILED';
      throw new AgentError(code, error instanceof Error ? error.message : 'The tone request failed.', trace, { cause: error });
    }
  }
}
