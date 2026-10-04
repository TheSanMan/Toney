import { explicitMixSettings } from '../core/agent/mix';
import { recommendGear } from '../core/agent/recommendations';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentError, createInitialTone, DEFAULT_INTENT, OllamaProvider, setNodeEnabled, setToneParameter, ToneAgent, type IntentProvider, type ToneSpec, appendToneNode, setToneAsset, removeToneNode, inferIntentFromTone, setToneNodeMix } from '../core';

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
    const verb = initial.chain.find((node) => node.type === 'reverb');
    if (!verb) throw new Error('Missing reverb');
    verb.parameters.mix = 0.3;
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

  it('replaces incompatible fuzz with an approximate clean Her’s reference rather than nudging it', async () => {
    const agent = new ToneAgent();
    const fuzz = await agent.run({ prompt: 'heavy fuzzy metal' });
    const result = await agent.run({ prompt: "make it sound like What Once Was by Her's", currentTone: fuzz.tone });
    expect(result.intent.distortion.texture).toBe('clean');
    expect(parameter(result.tone, 'drive', 'gain')).toBeLessThan(0.1);
    expect(result.tone.chain.find((node) => node.type === 'drive')?.enabled).toBe(false);
    expect(parameter(result.tone, 'chorus', 'mix')).toBeGreaterThan(0.2);
    expect(result.warnings.join(' ')).toContain('not been verified');
    expect(result.recommendations?.some((row) => row.role === 'amp' && row.label.includes('clean amp'))).toBe(true);
  });

  it('guards a cloud planner from stereotyping the named clean reference as fuzz', async () => {
    const provider: IntentProvider = { name: 'Biased planner', interpret: async ({ baseline }) => ({ intent: { ...baseline, distortion: { amount: 0.9, texture: 'gritty' } }, changedPaths: ['distortion.amount'], warnings: [], issues: [], explanation: 'Fuzzy drive.' }) };
    const agent = new ToneAgent(provider);
    const clean = await agent.run({ prompt: "What Once Was by Her's", currentTone: createInitialTone() });
    expect(clean.intent.distortion.amount).toBe(0.04);
    expect(clean.message).not.toContain('Fuzzy');
    const deliberate = await agent.run({ prompt: "a fuzzy version of What Once Was by Her's" });
    expect(deliberate.intent.distortion.amount).toBe(0.9);
  });

  it('executes validated model mixes for one independent stage while preserving neighboring stages', async () => {
    const first = createInitialTone();
    const tone = appendToneNode(first, 'drive');
    const target = tone.chain.at(-1);
    if (!target) throw new Error('Missing target');
    const provider: IntentProvider = { name: 'Mix planner', interpret: async ({ baseline }) => ({ intent: baseline, changedPaths: [], warnings: [], issues: [], mixSettings: [{ nodeId: target.id, mix: 0.2 }] }) };
    const result = await new ToneAgent(provider).run({ prompt: 'blend the last fuzz gently', currentTone: tone });
    expect(result.tone.chain.find((node) => node.id === target.id)?.mix).toBe(0.2);
    expect(result.tone.chain.find((node) => node.id === first.chain[1]?.id)?.mix).toBeUndefined();
    expect(result.trace.events.find((event) => event.stage === 'compilation')?.detail).toContain(target.id);
  });

  it('executes exact wet/dry percentages and refuses ambiguous duplicated pedal names', async () => {
    const tone = createInitialTone();
    const wet = await new ToneAgent().run({ prompt: 'chorus mix 30%', currentTone: tone });
    expect(wet.tone.chain.find((node) => node.type === 'chorus')?.mix).toBe(0.3);
    const dry = await new ToneAgent().run({ prompt: 'chorus mix 70% dry', currentTone: tone });
    expect(dry.tone.chain.find((node) => node.type === 'chorus')?.mix).toBeCloseTo(0.3);
    const duplicate = appendToneNode(tone, 'drive');
    const ambiguous = await new ToneAgent().run({ prompt: 'fuzz blend 20%', currentTone: duplicate });
    expect(ambiguous.tone.chain.filter((node) => node.type === 'drive').every((node) => node.mix === undefined)).toBe(true);
    expect(ambiguous.warnings.join(' ')).toContain('duplicate');
  });

  it('prioritizes a named capture over generic fuzz cues when two drive stages exist', async () => {
    const initial = createInitialTone();
    const tone = appendToneNode(initial, 'drive', { kind: 'nam', id: 'a'.repeat(64), name: 'Fuzz capture.nam' });
    const capture = tone.chain.find((node) => node.asset);
    if (!capture) throw new Error('Missing capture');
    for (const prompt of ['blend Fuzz capture.nam to 30% wet', 'blend Fuzz capture to 30% wet']) {
      const directives = explicitMixSettings(prompt, tone);
      expect(directives.settings).toEqual([{ nodeId: capture.id, mix: 0.3 }]);
      expect(directives.warnings).toEqual([]);
      const result = await new ToneAgent().run({ prompt, currentTone: tone });
      expect(result.tone.chain.find((node) => node.id === capture.id)?.mix).toBe(0.3);
      expect(result.tone.chain.find((node) => node.id === initial.chain[1]?.id)).toEqual(initial.chain[1]);
      expect(result.tone.chain.find((node) => node.type === 'amp')).toEqual(initial.chain.find((node) => node.type === 'amp'));
      expect(result.warnings).toEqual([]);
    }
  });

  it('retains separate requests to add fuzz before a named mix clause', async () => {
    const tone = createInitialTone();
    const result = await new ToneAgent().run({ prompt: 'add fuzz and blend chorus to 30% wet', currentTone: tone });
    expect(parameter(result.tone, 'drive', 'gain')).toBeGreaterThan(parameter(tone, 'drive', 'gain'));
    expect(result.tone.chain.find((node) => node.type === 'chorus')?.mix).toBe(0.3);
  });

  it('bypasses a captured fuzz for a clean reference without pretending its trim is a gain knob', async () => {
    const tone = createInitialTone();
    const drive = tone.chain.find((node) => node.type === 'drive');
    if (!drive) throw new Error('Missing pedal');
    const captured = setToneAsset(tone, drive.id, { kind: 'nam', id: 'a'.repeat(64), name: 'Fuzz capture' });
    const result = await new ToneAgent().run({ prompt: "What Once Was by Her's", currentTone: captured });
    expect(result.tone.chain.find((node) => node.id === drive.id)?.enabled).toBe(false);
    expect(result.tone.chain.find((node) => node.id === drive.id)?.parameters.gain).toBe(0.5);
  });

  it('removes room reflections for direct headphone feedback without adding chorus', async () => {
    const agent = new ToneAgent();
    const roomy = await agent.run({ prompt: 'dreamy ambient with lots of reverb' });
    const direct = await agent.run({ prompt: 'sounds like in a room, make it close/direct in my headphones', currentTone: roomy.tone });
    expect(parameter(direct.tone, 'reverb', 'mix')).toBe(0);
    expect(parameter(direct.tone, 'delay', 'mix')).toBe(0);
    expect(direct.tone.chain.find((node) => node.type === 'reverb')?.mix).toBe(0);
    expect(parameter(direct.tone, 'chorus', 'mix')).toBe(parameter(roomy.tone, 'chorus', 'mix'));
    expect(direct.message).toContain('direct monitoring');
    const restored = await agent.run({ prompt: 'more reverb', currentTone: direct.tone, previousIntent: direct.intent });
    expect(restored.tone.chain.find((node) => node.type === 'reverb')?.mix).toBe(1);
    expect(parameter(restored.tone, 'reverb', 'mix')).toBeGreaterThan(0);
  });

  it('adds a missing requested chorus as an independent stage without replacing a fuzz capture', async () => {
    const tone = createInitialTone();
    const chorus = tone.chain.find((node) => node.type === 'chorus');
    const drive = tone.chain.find((node) => node.type === 'drive');
    if (!chorus || !drive) throw new Error('Missing stages');
    const fuzz = setToneAsset(removeToneNode(tone, chorus.id), drive.id, { kind: 'nam', id: 'a'.repeat(64), name: 'Big Muff fuzz' });
    const result = await new ToneAgent().run({ prompt: 'add chorus movement', currentTone: fuzz });
    expect(result.tone.chain.find((node) => node.type === 'chorus')?.id).not.toBe(chorus.id);
    expect(result.tone.chain.find((node) => node.id === drive.id)?.asset?.id).toBe('a'.repeat(64));
  });

  it('accepts concrete model gear advice and rejects invented library IDs', async () => {
    const recommendation = { role: 'amp' as const, label: 'Fender Twin style', rationale: 'Clean headroom.', searchQuery: 'Fender Twin clean' };
    const provider: IntentProvider = { name: 'Gear planner', interpret: async ({ baseline }) => ({ intent: baseline, changedPaths: [], warnings: [], issues: [], gearRecommendations: [recommendation] }) };
    const result = await new ToneAgent(provider).run({ prompt: 'recommend a clean amp', currentTone: createInitialTone() });
    expect(result.recommendations?.[0]?.searchQuery).toBe('Fender Twin clean');
    const invented: IntentProvider = { name: 'Invented gear', interpret: async ({ baseline }) => ({ intent: baseline, changedPaths: [], warnings: [], issues: [], gearRecommendations: [{ ...recommendation, localAssetId: 'invented' }] }) };
    await expect(new ToneAgent(invented).run({ prompt: 'recommend amp' })).rejects.toMatchObject({ code: 'INTENT_PROVIDER_FAILED' });
  });

  it('derives refinement intent from audible stages and never treats capture trim as distortion', () => {
    const tone = createInitialTone();
    const drive = tone.chain.find((node) => node.type === 'drive');
    const amp = tone.chain.find((node) => node.type === 'amp');
    const verb = tone.chain.find((node) => node.type === 'reverb');
    if (!drive || !amp || !verb) throw new Error('Missing stages');
    const capture = setToneAsset(setToneAsset(tone, drive.id, { kind: 'nam', id: 'a'.repeat(64), name: 'Pedal' }), amp.id, { kind: 'nam', id: 'b'.repeat(64), name: 'Amp' });
    const loudTrim = setToneParameter(setToneParameter(capture, drive.id, 'gain', 1), amp.id, 'gain', 1);
    expect(inferIntentFromTone(loudTrim).distortion.amount).toBe(0.2);
    const clean = { ...DEFAULT_INTENT, distortion: { amount: 0.04, texture: 'clean' as const } };
    expect(inferIntentFromTone(loudTrim, clean).distortion.amount).toBe(0.04);
    const bypassed = setNodeEnabled(setNodeEnabled(loudTrim, drive.id, false), amp.id, false);
    expect(inferIntentFromTone(bypassed).distortion.amount).toBe(0);
    const wet = setToneParameter(tone, verb.id, 'mix', 0.5);
    expect(inferIntentFromTone(setToneNodeMix(wet, verb.id, 0)).space.reverb).toBe(0);
    expect(inferIntentFromTone(setToneNodeMix(wet, verb.id, 0.3)).space.reverb).toBeCloseTo(0.15);
  });

  it('grounds recommended local IDs in the supplied library and never recommends a clean pedal as an amp', () => {
    const intent = { ...DEFAULT_INTENT, distortion: { amount: 0.04, texture: 'clean' as const } };
    const assets = [
      { asset: { id: 'a'.repeat(64), kind: 'nam' as const, name: 'Clean boost pedal' }, info: { kind: 'asset-info' as const, id: 'a'.repeat(64), assetKind: 'nam' as const, sampleRate: 48000, channels: 1 as const, architecture: 'LSTM' as const, modelVersion: '0.5.4' } },
      { asset: { id: 'b'.repeat(64), kind: 'nam' as const, name: 'Clean combo amp' }, info: { kind: 'asset-info' as const, id: 'b'.repeat(64), assetKind: 'nam' as const, sampleRate: 48000, channels: 1 as const, architecture: 'LSTM' as const, modelVersion: '0.5.4' } },
    ];
    expect(recommendGear(intent, assets).find((row) => row.role === 'amp')?.localAssetId).toBe('b'.repeat(64));
    expect(recommendGear(intent).every((row) => row.localAssetId === undefined)).toBe(true);
  });

  it('rejects invented mix targets and invalid mix values with traceable errors', async () => {
    for (const setting of [{ nodeId: 'invented', mix: 0.2 }, { nodeId: 'invented', mix: 1.2 }]) {
      const provider: IntentProvider = { name: 'Bad mix planner', interpret: async ({ baseline }) => ({ intent: baseline, changedPaths: [], warnings: [], issues: [], mixSettings: [setting] }) };
      await expect(new ToneAgent(provider).run({ prompt: 'mix', currentTone: createInitialTone() })).rejects.toBeInstanceOf(AgentError);
    }
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

  it('uses the injected desktop transport without making a browser request', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const transport = vi.fn(async (body: string, signal: AbortSignal) => {
      const payload = JSON.parse(body) as { model: string; stream: boolean };
      expect(payload.model).toBe('installed-model');
      expect(payload.stream).toBe(false);
      expect(signal.aborted).toBe(false);
      return new Response(JSON.stringify({ message: { content: JSON.stringify({
        intent: DEFAULT_INTENT, changedPaths: ['character.width'], warnings: [], issues: [],
      }) } }), { status: 200 });
    });
    const result = await new ToneAgent(new OllamaProvider('installed-model', transport)).run({ prompt: 'wide' });
    expect(result.trace.provider).toContain('installed-model');
    expect(transport).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
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
