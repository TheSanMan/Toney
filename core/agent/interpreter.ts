import { INTENT_PATHS, type IntentPath, type ToneIntent } from '../tone/types';
import type { IntentProvider, Interpretation, ProviderRequest } from './types';

type Values = Partial<Record<IntentPath, number | ToneIntent['distortion']['texture']>>;
interface Rule { pattern: RegExp; values: Values; issue?: 'muddy' | 'harsh' }

const PROFILES: Rule[] = [
  { pattern: /\b(?:grunge|nirvana|90s|nineties)\b/g, values: { 'distortion.amount': 0.7, 'distortion.texture': 'gritty', 'character.brightness': 0.32, 'character.aggression': 0.65, 'character.clarity': 0.65, 'space.reverb': 0.1, 'space.delay': 0 } },
  { pattern: /\b(?:blues|bluesy|little wing|hendrix)\b/g, values: { 'distortion.amount': 0.36, 'distortion.texture': 'crunch', 'character.warmth': 0.72, 'character.sustain': 0.55, 'dynamics.transientPreservation': 0.8, 'space.reverb': 0.14 } },
  { pattern: /\b(?:funk|funky)\b/g, values: { 'distortion.amount': 0.05, 'distortion.texture': 'clean', 'character.brightness': 0.75, 'character.clarity': 0.88, 'dynamics.compression': 0.35, 'dynamics.transientPreservation': 0.85, 'space.reverb': 0.05 } },
  { pattern: /\b(?:ambient|dreamy|shoegaze)\b/g, values: { 'distortion.amount': 0.12, 'distortion.texture': 'clean', 'character.brightness': 0.45, 'character.width': 0.7, 'space.reverb': 0.42, 'space.delay': 0.26 } },
  { pattern: /\b(?:metal|heavy rock)\b/g, values: { 'distortion.amount': 0.87, 'distortion.texture': 'gritty', 'character.aggression': 0.85, 'character.clarity': 0.7, 'space.reverb': 0.08 } },
];

const RULES: Rule[] = [
  { pattern: /\b(?:dark(?:er)?|warm(?:er)?|mellow)\b/g, values: { 'character.brightness': 0.25, 'character.warmth': 0.75 } },
  { pattern: /\b(?:bright(?:er)?|bite|sparkle|sparkly|crisp|treble)\b/g, values: { 'character.brightness': 0.8 } },
  { pattern: /\b(?:clean|cleaner)\b/g, values: { 'distortion.amount': 0.06, 'distortion.texture': 'clean', 'character.clarity': 0.85 } },
  { pattern: /\b(?:edge of breakup|edge-of-breakup)\b/g, values: { 'distortion.amount': 0.3, 'distortion.texture': 'crunch' } },
  { pattern: /\b(?:crunch(?:y|ier)?|gritty|grit)\b/g, values: { 'distortion.amount': 0.58, 'distortion.texture': 'gritty' } },
  { pattern: /\b(?:gain|drive|distortion|distorted|saturated|saturation)\b/g, values: { 'distortion.amount': 0.75 } },
  { pattern: /\b(?:singing|sing|sustain|lead|smooth)\b/g, values: { 'character.sustain': 0.78, 'distortion.amount': 0.65, 'distortion.texture': 'smooth' } },
  { pattern: /\b(?:soft(?:er)?|gentle|gentler)\b/g, values: { 'character.aggression': 0.15, 'distortion.amount': 0.2 } },
  { pattern: /\b(?:aggressive|aggression|attacky)\b/g, values: { 'character.aggression': 0.8, 'distortion.amount': 0.75 } },
  { pattern: /\b(?:wide(?:r)?|width|stereo|huge)\b/g, values: { 'character.width': 0.75 } },
  { pattern: /\b(?:dry|drier|tight)\b/g, values: { 'space.reverb': 0.02, 'space.delay': 0 } },
  { pattern: /\b(?:spacious|space|roomy|wet|reverb|ambience)\b/g, values: { 'space.reverb': 0.38 } },
  { pattern: /\b(?:delay|echo)\b/g, values: { 'space.delay': 0.3 } },
  { pattern: /\b(?:compressed|compression|compress)\b/g, values: { 'dynamics.compression': 0.65 } },
  { pattern: /\b(?:pick attack|attack|transients|dynamic|dynamics|responsive)\b/g, values: { 'dynamics.transientPreservation': 0.85, 'dynamics.compression': 0.2 } },
  { pattern: /\b(?:clear(?:er)?|clarity|definition|defined|articulate|separation)\b/g, values: { 'character.clarity': 0.85 } },
  { pattern: /\b(?:muddy|mud|muddiness)\b/g, values: { 'character.clarity': 0.85 }, issue: 'muddy' },
  { pattern: /\b(?:harsh|harshness|fizzy|fizz|sterile)\b/g, values: { 'character.brightness': 0.3, 'character.warmth': 0.7 }, issue: 'harsh' },
  { pattern: /\b(?:washed out|washy)\b/g, values: { 'space.reverb': 0.08, 'space.delay': 0.05 } },
];

function getNumber(intent: ToneIntent, path: IntentPath): number {
  const [group, key] = path.split('.');
  if (!group || !key) throw new Error(`Invalid intent path ${path}`);
  const values = intent[group as keyof Omit<ToneIntent, 'references'>] as unknown as Record<string, unknown>;
  const value = values[key];
  if (typeof value !== 'number') throw new Error(`Expected numeric intent path ${path}`);
  return value;
}

function setValue(intent: ToneIntent, path: IntentPath, value: number | ToneIntent['distortion']['texture']): void {
  const [group, key] = path.split('.');
  if (!group || !key) throw new Error(`Invalid intent path ${path}`);
  const values = intent[group as keyof Omit<ToneIntent, 'references'>] as unknown as Record<string, unknown>;
  values[key] = value;
}

export class DeterministicProvider implements IntentProvider {
  readonly name = 'Offline tone interpreter';

  async interpret(request: ProviderRequest): Promise<Interpretation> {
    const prompt = request.prompt.toLowerCase().replace(/[’']/g, "'");
    const intent = structuredClone(request.baseline);
    const changed = new Set<IntentPath>();
    const issues = new Set<'muddy' | 'harsh'>();
    const warnings: string[] = [];
    let matched = 0;
    const apply = (rule: Rule, profile: boolean): void => {
      for (const match of prompt.matchAll(rule.pattern)) {
        matched += 1;
        // Scope modifiers to the closest clause and the three words before this cue.
        const preceding = prompt.slice(0, match.index).split(/[,.;]|\b(?:but|and)\b/).at(-1) ?? '';
        const nearby = preceding.split(/\s+/).filter(Boolean).slice(-3).join(' ');
        const negated = /\b(?:not|no|without|don't|avoid|less|reduce|lower|decrease|too)\b/.test(nearby);
        const increasing = /\b(?:more|increase|extra)\b/.test(nearby);
        const preserving = /\b(?:keep|preserve|retain)\b/.test(nearby) || /\b(?:without|not) losing\b/.test(nearby);
        if (rule.issue && /\b(?:not|isn't|aren't|never)\b/.test(nearby)) continue;
        if (profile && negated) { warnings.push(`A negated style reference (${match[0]}) needs a more specific tone description.`); continue; }
        if (rule.issue) issues.add(rule.issue);
        for (const path of INTENT_PATHS) {
          const target = rule.values[path];
          if (target === undefined) continue;
          if (preserving && request.currentTone) continue;
          if (typeof target === 'string') {
            if (!negated) { setValue(intent, path, target); changed.add(path); }
            continue;
          }
          const current = getNumber(intent, path);
          // Defect descriptions (muddy, harsh, washed out) already encode a corrective direction.
          const corrective = rule.issue !== undefined || match[0] === 'washed out' || match[0] === 'washy';
          const desired = negated && !corrective ? 1 - target : target;
          let next = desired;
          if (request.currentTone && !profile) {
            let direction = target >= 0.5 ? 1 : -1;
            if (path.startsWith('space.') && !/^(?:dry|drier|tight|washed out|washy)$/.test(match[0])) direction = 1;
            if (negated && !corrective) direction *= -1;
            next = Math.max(0, Math.min(1, current + direction * (increasing ? 0.22 : 0.18)));
          }
          // No reverb/delay is an explicit zero request, including during refinement.
          if (/\b(?:no|without)\b/.test(nearby) && (path === 'space.reverb' || path === 'space.delay' || path === 'distortion.amount') && !corrective) next = 0;
          setValue(intent, path, Math.round(next * 1000) / 1000);
          changed.add(path);
        }
      }
    };
    for (const profile of PROFILES) apply(profile, true);
    for (const rule of RULES) apply(rule, false);
    if (/\b(?:nirvana|hendrix|little wing)\b/.test(prompt)) {
      intent.references = [...new Set([...intent.references, ...['Nirvana', 'Hendrix', 'Little Wing'].filter((reference) => prompt.includes(reference.toLowerCase()))])].slice(0, 10);
      warnings.push('Artist and song references use broad stylistic cues; recorded equipment and the reference audio have not been verified.');
    }
    if (matched === 0) warnings.push('I could not identify a supported tone direction. Try clean, crunchy, darker, brighter, more delay, less gain, wider, or too muddy.');
    if (/\b(?:like|style|sound of|tone of)\b/.test(prompt) && !/\b(?:nirvana|hendrix|little wing|grunge|blues|funk|ambient|metal|shoegaze)\b/.test(prompt)) warnings.push('This named reference is not in the offline style knowledge. Describe its gain, brightness, dynamics, and space for a more reliable result.');
    return { intent, changedPaths: [...changed], warnings, issues: [...issues] };
  }
}
