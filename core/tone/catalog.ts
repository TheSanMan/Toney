import type { EffectDefinition, NodeType, ParameterDefinition, ToneNode } from './types';

const knob = (label: string, defaultValue: number): ParameterDefinition => ({ label, min: 0, max: 1, default: defaultValue });
const eq = (label: string): ParameterDefinition => ({ label, min: -12, max: 12, default: 0, unit: 'dB' });

export const EFFECT_CATALOG: Record<NodeType, EffectDefinition> = {
  compressor: { name: 'Compressor', model: 'builtin_compressor', parameters: { amount: knob('Amount', 0.2), attack: knob('Pick attack', 0.7) } },
  drive: { name: 'Drive', model: 'builtin_drive', parameters: { gain: knob('Gain', 0.15), tone: knob('Tone', 0.5), level: knob('Level', 0.6) } },
  amp: { name: 'Amp', model: 'builtin_amp', parameters: { gain: knob('Gain', 0.25), bass: knob('Bass', 0.5), mid: knob('Mid', 0.55), treble: knob('Treble', 0.5), master: knob('Master', 0.65) } },
  cab: { name: 'Cabinet', model: 'builtin_cab', parameters: { brightness: knob('Brightness', 0.5), resonance: knob('Resonance', 0.35) } },
  eq: { name: 'EQ', model: 'builtin_eq', parameters: { lowDb: eq('Low'), midDb: eq('Mid'), highDb: eq('High') } },
  chorus: { name: 'Chorus', model: 'builtin_chorus', parameters: { rate: { label: 'Rate', min: 0.1, max: 5, default: 0.8, unit: 'Hz' }, depth: knob('Depth', 0.3), mix: knob('Mix', 0) } },
  delay: { name: 'Delay', model: 'builtin_delay', parameters: { time: { label: 'Time', min: 0.05, max: 1, default: 0.3, unit: 's' }, feedback: { label: 'Feedback', min: 0, max: 0.8, default: 0.25 }, mix: knob('Mix', 0) } },
  reverb: { name: 'Reverb', model: 'builtin_reverb', parameters: { decay: { label: 'Decay', min: 0.2, max: 5, default: 1.2, unit: 's' }, mix: knob('Mix', 0.12) } },
};

/** External processing retains the same parameter contract; these controls surround the imported model. */
export function getNodeDefinition(node: ToneNode): EffectDefinition {
  const definition = EFFECT_CATALOG[node.type];
  if (node.type === 'amp' && node.model === 'nam') return {
    ...definition, name: 'NAM amp', model: 'nam', parameters: {
      ...definition.parameters,
      gain: { ...definition.parameters.gain, label: 'Input trim' },
      master: { ...definition.parameters.master, label: 'Output trim' },
    },
  };
  if (node.type === 'cab' && node.model === 'cab_ir') return {
    ...definition, name: 'Cabinet IR', model: 'cab_ir', parameters: {
      ...definition.parameters,
      brightness: { ...definition.parameters.brightness, label: 'IR brightness' },
      resonance: { ...definition.parameters.resonance, label: 'IR resonance' },
    },
  };
  return definition;
}
