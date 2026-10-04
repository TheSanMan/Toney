import type { NativeAssetDescriptor } from '../native/assets';
import type { ToneIntent } from '../tone/types';
import type { GearRecommendation } from './types';

/** Text-based starting points, never claims about an artist's actual recorded rig. */
export function recommendGear(intent: ToneIntent, assets: readonly NativeAssetDescriptor[] = []): GearRecommendation[] {
  const clean = intent.distortion.amount < 0.25;
  const heavy = intent.distortion.amount > 0.7;
  const suggestions: GearRecommendation[] = [
    { role: 'amp', label: clean ? intent.character.width > 0.3 ? 'Roland JC-120 style clean amp' : intent.character.brightness > 0.65 ? 'Vox AC30 style clean amp' : 'Fender Twin style clean amp' : heavy ? 'Mesa Rectifier / 5150 style amp' : 'Marshall JTM45 style breakup amp',
      rationale: clean ? 'Preserve note separation and let modulation provide the movement.' : heavy ? 'Keep low end controlled; choose a capture with the desired amount of distortion.' : 'A low-gain capture retains pick dynamics without stacking unnecessary distortion.',
      searchQuery: clean ? intent.character.width > 0.3 ? 'Roland JC120 clean' : intent.character.brightness > 0.65 ? 'Vox AC30 clean low gain' : 'Fender Twin clean' : heavy ? '5150 tight high gain' : 'Marshall JTM45 low gain' },
    { role: 'cab', label: clean ? 'Jensen / Alnico open-back 2×12 IR' : 'Celestion V30 4×12 cabinet IR',
      rationale: 'Audition an IR before adding more EQ; avoid a second cabinet filter if the amp capture already includes a speaker.',
      searchQuery: clean ? 'Jensen open back 2x12 cabinet' : 'V30 4x12 cabinet' },
  ];
  if (intent.character.width > 0.25) suggestions.unshift({ role: 'pedal', label: 'Chorus after the amp', rationale: 'Use the built-in time-varying chorus for movement; standard NAM captures are static and cannot recreate a moving chorus or delay.', searchQuery: '', builtinType: 'chorus' });
  if (intent.distortion.amount > 0.4) suggestions.unshift({ role: 'pedal', label: heavy ? 'Big Muff / Fuzz Face style pedal' : 'Blues Driver / Tube Screamer style pedal', rationale: 'Add a separate pedal stage before the amp. Blend its output with node mix; capture gain knobs adjust input trim, not the original pedal settings.', searchQuery: heavy ? 'Big Muff fuzz pedal' : 'Blues Driver low gain pedal' });
  for (const suggestion of suggestions) {
    // Metadata only supports a conservative name match, not sonic quality ranking.
    const words = suggestion.role === 'cab' ? ['cab', 'speaker', 'ir'] : suggestion.role === 'amp' ? clean ? ['clean', 'low gain'] : heavy ? ['high gain', 'metal'] : ['crunch', 'breakup'] : heavy ? ['fuzz', 'distortion'] : ['overdrive', 'boost'];
    if (suggestion.label.startsWith('Chorus')) continue;
    const candidate = assets.find(({ asset, source }) => {
      const name = `${asset.name} ${source?.toneName ?? ''}`.toLowerCase();
      if (asset.kind !== (suggestion.role === 'cab' ? 'ir' : 'nam')) return false;
      if (suggestion.role === 'amp' && /\b(?:pedal|fuzz|overdrive|boost)\b/.test(name)) return false;
      return words.some((word) => name.includes(word));
    });
    if (candidate) { suggestion.localAssetId = candidate.asset.id; suggestion.label = candidate.asset.name; suggestion.rationale += ' Already in your library; matched by description, so audition it.'; }
  }
  return suggestions;
}
