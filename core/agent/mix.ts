import type { ToneSpec } from '../tone/types';
import type { MixSetting } from './types';

/** Explicit percentages are executed even when a model omits them. Ambiguous duplicates are not guessed. */
export function explicitMixSettings(prompt: string, tone?: ToneSpec): { settings: MixSetting[]; warnings: string[] } {
  if (!tone) return { settings: [], warnings: [] };
  const settings = new Map<string, MixSetting>();
  const warnings: string[] = [];
  for (const clause of prompt.toLowerCase().split(/[,;]|\band\b/)) {
    const match = /\b(\d{1,3}(?:\.\d+)?)\s*%/.exec(clause);
    if (!match || !/\b(?:mix|wet|dry|blend|parallel)\b/.test(clause)) continue;
    const percent = Number(match[1]);
    if (percent > 100) { warnings.push('Mix must be between 0% and 100%; I kept that stage unchanged.'); continue; }
    // A named stage is more specific than 'fuzz' or 'drive' elsewhere in its name.
    // Keep duplicate named captures ambiguous rather than picking the first one.
    const idMatches = tone.chain.filter((node) => clause.includes(node.id.toLowerCase()));
    const exactNames = tone.chain.filter((node) => node.asset && clause.includes(node.asset.name.toLowerCase()));
    const stemNames = tone.chain.filter((node) => {
      const stem = node.asset?.name.toLowerCase().replace(/\.(?:nam|wav)$/i, '').trim();
      return stem !== undefined && stem.length >= 4 && clause.includes(stem);
    });
    const candidates = idMatches.length ? idMatches : exactNames.length ? exactNames : stemNames.length ? stemNames
      : tone.chain.filter((node) => new RegExp(`\\b${node.type}\\b`).test(clause) || node.type === 'drive' && /\b(?:fuzz|distortion|overdrive)\b/.test(clause));
    if (candidates.length !== 1) { warnings.push('Name one specific pedal or effect for that mix percentage; duplicate stages were left unchanged.'); continue; }
    const node = candidates[0];
    if (node) settings.set(node.id, { nodeId: node.id, mix: /\b\d+(?:\.\d+)?\s*%\s*dry\b/.test(clause) ? 1 - percent / 100 : percent / 100 });
  }
  return { settings: [...settings.values()], warnings };
}
