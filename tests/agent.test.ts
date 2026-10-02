import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentError, createInitialTone, DEFAULT_INTENT, OllamaProvider, setNodeEnabled, setToneParameter, ToneAgent, type IntentProvider, type ToneSpec } from '../core';

function parameter(tone: ToneSpec, type: string, key: string): number {
  const value = tone.chain.find((node) => node.type === type)?.parameters[key];
  if (value === undefined) throw new Error(`Missing ${type}.${key}`);
  return value;
}

describe('offline tone agent', () => {
  it('produces materially different clean, grunge and ambient rigs with traceable stages', async () => {
    const agent = new ToneAgent();
    const clean = await agent.run({ prompt: 'bright clean funk' });
    const grunge = await agent.run({ prompt: 'dark 90s grunge, fairly dry with definition' });
    const ambient = await agent.run({ prompt: 'dreamy ambient clean' });
    expect(parameter(clean.tone, 'drive', 'gain')).toBeLessThan(parameter(grunge.tone, 'drive', 'gain'));
    expect(parameter(clean.tone, 'cab', 'brightness')).toBeGreaterThan(parameter(grunge.tone, 'cab', 'brightness'));
    expect(parameter(ambient.tone, 'reverb', 'mix')).toBeGreaterThan(parameter(grunge.tone, 'reverb', 'mix'));
    expect(parameter(ambient.tone, 'chorus', 'mix')).toBeGreaterThan(parameter(clean.tone, 'chorus', 'mix'));
    expect(grunge.trace.events.map((event) => event.stage)).toEqual(['request-validation', 'interpretation', 'compilation', 'output-validation']);
    expect(grunge.tone.metadata.traceId).toBe(grunge.trace.id);
  });

  it('preserves manual edits, IDs, ordering and bypass states on a width-only refinement', async () => {
    const agent = new ToneAgent();
    const first = await agent.run({ prompt: 'warm crunchy blues' });
    const drive = first.tone.chain.find((node) => node.type === 'drive');
    const chorus = first.tone.chain.find((node) => node.type === 'chorus');
    if (!drive || !chorus) throw new Error('Missing effects');
    const edited = setNodeEnabled(setToneParameter(first.tone, drive.id, 'gain', 0.31), chorus.id, false);
    const result = await agent.run({ prompt: 'Great, now make it wider', currentTone: edited, previousIntent: first.intent });
    expect(parameter(result.tone, 'drive', 'gain')).toBe(0.31);
    expect(result.tone.chain.map((node) => node.id)).toEqual(edited.chain.map((node) => node.id));
    expect(result.tone.chain.find((node) => node.id === chorus.id)?.enabled).toBe(false);
    expect(parameter(result.tone, 'chorus', 'mix')).toBeGreaterThan(parameter(edited, 'chorus', 'mix'));
    expect(edited.chain.find((node) => node.id === chorus.id)?.parameters.mix).toBe(parameter(first.tone, 'chorus', 'mix'));
  });

  it('handles comparative and negated requests in both directions', async () => {
    const agent = new ToneAgent();
    const initial = createInitialTone();
    const less = await agent.run({ prompt: 'less gain and less reverb', currentTone: initial });
    const more = await agent.run({ prompt: 'more gain and more reverb', currentTone: initial });
    expect(parameter(less.tone, 'drive', 'gain')).toBeLessThan(parameter(initial, 'drive', 'gain'));
    expect(parameter(more.tone, 'drive', 'gain')).toBeGreaterThan(parameter(initial, 'drive', 'gain'));
    expect(parameter(less.tone, 'reverb', 'mix')).toBeLessThan(parameter(initial, 'reverb', 'mix'));
    expect(parameter(more.tone, 'reverb', 'mix')).toBeGreaterThan(parameter(initial, 'reverb', 'mix'));
    const notDark = await agent.run({ prompt: 'not dark', currentTone: initial });
    expect(parameter(notDark.tone, 'cab', 'brightness')).toBeGreaterThan(parameter(initial, 'cab', 'brightness'));
    const dry = await agent.run({ prompt: 'no reverb and no delay', currentTone: more.tone });
    expect(parameter(dry.tone, 'reverb', 'mix')).toBe(0);
    expect(parameter(dry.tone, 'delay', 'mix')).toBe(0);
  });

  it('identifies a plausible muddy source in the current rig and makes one major change', async () => {
    const agent = new ToneAgent();
    const first = await agent.run({ prompt: 'dreamy ambient' });
    const result = await agent.run({ prompt: 'the chords are too muddy', currentTone: first.tone });
    expect(parameter(result.tone, 'reverb', 'mix')).toBeLessThan(parameter(first.tone, 'reverb', 'mix'));
    expect(parameter(result.tone, 'eq', 'lowDb')).toBe(parameter(first.tone, 'eq', 'lowDb'));
    expect(parameter(result.tone, 'drive', 'gain')).toBe(parameter(first.tone, 'drive', 'gain'));
    expect(result.message).toContain('plausible');
  });

  it('keeps an existing rig when language is unrecognized and warns about unverified references', async () => {
    const agent = new ToneAgent();
    const initial = createInitialTone();
    const unknown = await agent.run({ prompt: 'quantum banana', currentTone: initial });
    expect(unknown.tone).toEqual(initial);
    expect(unknown.warnings).toHaveLength(1);
    const reference = await agent.run({ prompt: 'dark Nirvana-style crunch' });
    expect(reference.warnings.join(' ')).toContain('not been verified');
    expect(reference.intent.references).toContain('Nirvana');
  });

  it('does not change pick controls when asked to keep the pick attack', async () => {
    const agent = new ToneAgent();
    const initial = createInitialTone();
    const result = await agent.run({ prompt: 'make it softer but keep the pick attack', currentTone: initial });
    expect(parameter(result.tone, 'compressor', 'attack')).toBe(parameter(initial, 'compressor', 'attack'));
    expect(parameter(result.tone, 'compressor', 'amount')).toBe(parameter(initial, 'compressor', 'amount'));
  });

  it('does not apply engineering corrections to explicitly negated defects', async () => {
    const agent = new ToneAgent();
    const initial = createInitialTone();
    for (const prompt of ['it is not muddy', 'it is not harsh', "the chords aren't muddy"]) {
      const result = await agent.run({ prompt, currentTone: initial });
      expect(result.tone).toEqual(initial);
      expect(result.trace.events.at(-1)?.detail).toContain('No understood change');
    }
  });

  it('preserves clarity when increasing sustain without losing definition', async () => {
    const agent = new ToneAgent();
    const initial = createInitialTone();
    const result = await agent.run({ prompt: 'more sustain without losing definition', currentTone: initial });
    expect(parameter(result.tone, 'eq', 'lowDb')).toBe(parameter(initial, 'eq', 'lowDb'));
    expect(parameter(result.tone, 'compressor', 'amount')).toBeGreaterThan(parameter(initial, 'compressor', 'amount'));
  });

  it('names a generated initial workbench rig even when currentTone is supplied', async () => {
    const result = await new ToneAgent().run({ prompt: 'dark grunge', currentTone: createInitialTone() });
    expect(result.tone.name).toContain('dark');
    expect(result.tone.chain.every((node) => node.enabled)).toBe(true);
  });

  it('isolates invalid input and provider failures with a stable code and trace', async () => {
    await expect(new ToneAgent().run({ prompt: ' ' })).rejects.toMatchObject({ code: 'INVALID_REQUEST', trace: { provider: 'Offline tone interpreter' } });
    const provider: IntentProvider = { name: 'Failing provider', interpret: async () => { throw new Error('Model unavailable'); } };
    try { await new ToneAgent(provider).run({ prompt: 'clean' }); throw new Error('Expected failure'); }
    catch (error: unknown) {
      expect(error).toBeInstanceOf(AgentError);
      if (!(error instanceof AgentError)) throw error;
      expect(error.code).toBe('INTENT_PROVIDER_FAILED');
      expect(error.trace.id).toMatch(/^trace_/);
      expect(error.trace.events.at(-1)?.detail).toContain('Model unavailable');
    }
  });
});

describe('local model boundary', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('accepts valid structured intent through the local-only proxy', async () => {
    const response = { intent: DEFAULT_INTENT, changedPaths: ['character.width'], warnings: [], issues: [] };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ message: { content: JSON.stringify(response) } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await new ToneAgent(new OllamaProvider('local-model')).run({ prompt: 'wide' });
    expect(result.trace.provider).toBe('Local Ollama (local-model)');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/ollama/chat');
  });

  it('rejects malformed JSON, invalid intent and unavailable models without fallback', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const agent = new ToneAgent(new OllamaProvider('local-model'));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: 'not json' } }), { status: 200 }));
    await expect(agent.run({ prompt: 'clean' })).rejects.toMatchObject({ code: 'INTENT_PROVIDER_FAILED', message: expect.stringContaining('malformed JSON') });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: JSON.stringify({ intent: { ...DEFAULT_INTENT, space: { reverb: 3, delay: 0 } }, changedPaths: [], warnings: [], issues: [] }) } }), { status: 200 }));
    await expect(agent.run({ prompt: 'clean' })).rejects.toMatchObject({ code: 'INTENT_PROVIDER_FAILED', message: expect.stringContaining('reverb') });
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 404 }));
    await expect(agent.run({ prompt: 'clean' })).rejects.toMatchObject({ message: expect.stringContaining('HTTP 404') });
    fetchMock.mockRejectedValueOnce(new TypeError('Connection refused'));
    await expect(agent.run({ prompt: 'clean' })).rejects.toMatchObject({ message: expect.stringContaining('Cannot reach local Ollama') });
  });
});
