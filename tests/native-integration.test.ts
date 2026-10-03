import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createInitialTone, EFFECT_CATALOG, validateToneSpec } from '../core';
import { createNativeRequest, validateNativeResponse } from '../core/native/protocol';

const executable = fileURLToPath(new URL('../engine/audio/build/bin/toney-engine', import.meta.url));
// The web-only CI job has no C++ toolchain; the macOS job builds this first.
describe.skipIf(!existsSync(executable))('TypeScript ↔ native helper integration', () => {
  function exchange(input: unknown) {
    const result = spawnSync(executable, [], { input: `${JSON.stringify(input)}\n`, encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    return JSON.parse(result.stdout);
  }

  it('correlates real engine information and generated rig acknowledgements', () => {
    const info = createNativeRequest('get_engine_info');
    expect(validateNativeResponse(info, exchange(info))).toMatchObject({ kind: 'engine-info', backend: 'JUCE', engineVersion: '0.5.0' });
    const tone = createInitialTone();
    tone.chain[0]!.enabled = false;
    const request = createNativeRequest('validate_tone_spec', tone);
    expect(validateNativeResponse(request, exchange(request))).toMatchObject({ kind: 'rig-valid', activeNodeCount: tone.chain.length - 1 });
  });

  it('agrees on every catalog parameter boundary and out-of-range rejection', () => {
    for (const [type, definition] of Object.entries(EFFECT_CATALOG)) {
      for (const [key, range] of Object.entries(definition.parameters)) {
        for (const value of [range.min, range.max, range.min - 0.01, range.max + 0.01]) {
          const tone = createInitialTone();
          tone.chain.find((node) => node.type === type)!.parameters[key] = value;
          const response = exchange({ protocolVersion: 1, requestId: 'catalog-boundary', command: 'validate_tone_spec', tone });
          const accepted = value >= range.min && value <= range.max;
          expect(response.ok, `${type}.${key}=${value}`).toBe(accepted);
          if (accepted) expect(() => validateToneSpec(tone)).not.toThrow();
          else {
            expect(() => validateToneSpec(tone)).toThrow();
            expect(response.error.code).toBe('INVALID_TONE_SPEC');
          }
        }
      }
    }
  });

  it('rejects malformed imported rigs in both languages', () => {
    for (const mutate of [
      (tone: ReturnType<typeof createInitialTone>) => { tone.chain[1]!.id = tone.chain[0]!.id; },
      (tone: ReturnType<typeof createInitialTone>) => { tone.chain[0]!.model = 'unknown-model'; },
      (tone: ReturnType<typeof createInitialTone>) => { tone.chain[0]!.parameters.unknown = 0.5; },
      (tone: ReturnType<typeof createInitialTone>) => { tone.revision = 0.5; },
    ]) {
      const tone = createInitialTone(); mutate(tone);
      expect(() => validateToneSpec(tone)).toThrow();
      expect(exchange({ protocolVersion: 1, requestId: 'invalid-import', command: 'validate_tone_spec', tone })).toMatchObject({ ok: false, error: { code: 'INVALID_TONE_SPEC' } });
    }
  });
});
