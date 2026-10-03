import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const executable = join(root, 'engine/audio/build/bin', `toney-engine${process.platform === 'win32' ? '.exe' : ''}`);
if (!existsSync(executable)) throw new Error('Build the native engine first with npm run native:build.');
const directory = join(root, 'engine/audio/build/auditions', `session-${Date.now()}-${randomUUID().slice(0, 8)}`);
mkdirSync(directory, { recursive: true });

const sampleRate = 44100;
const frames = sampleRate * 6;
const samples = new Float64Array(frames);
const notes = [40, 47, 52, 55, 40, 47, 50, 54, 43, 50, 55, 59, 45, 52, 57, 59];
for (const [index, midi] of notes.entries()) {
  const start = Math.round((0.08 + index * 0.3) * sampleRate);
  const frequency = 440 * 2 ** ((midi - 69) / 12);
  for (let i = 0; i < sampleRate * 1.2 && start + i < frames; i++) {
    const time = i / sampleRate;
    let value = 0;
    for (let harmonic = 1; harmonic <= 8; harmonic++) {
      value += Math.sin(2 * Math.PI * frequency * harmonic * time) * Math.exp(-time * (3 + harmonic * 0.6)) / harmonic;
    }
    samples[start + i] += value * Math.min(1, time / 0.004) * 0.22;
  }
}
const source = Buffer.alloc(44 + frames * 2);
source.write('RIFF', 0);
source.writeUInt32LE(source.length - 8, 4);
source.write('WAVEfmt ', 8);
source.writeUInt32LE(16, 16);
source.writeUInt16LE(1, 20);
source.writeUInt16LE(1, 22);
source.writeUInt32LE(sampleRate, 24);
source.writeUInt32LE(sampleRate * 2, 28);
source.writeUInt16LE(2, 32);
source.writeUInt16LE(16, 34);
source.write('data', 36);
source.writeUInt32LE(frames * 2, 40);
for (let i = 0; i < frames; i++) source.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
const inputPath = join(directory, 'dry-source.wav');
writeFileSync(inputPath, source);

function tone(kind) {
  const definitions = [
    ['compressor', { amount: 0.2, attack: 0.7 }],
    ['drive', { gain: 0.7, tone: 0.5, level: 0.6 }],
    ['amp', { gain: kind === 'crunch' ? 0.7 : 0.05, bass: 0.5, mid: 0.55, treble: 0.5, master: 0.65 }],
    ['cab', { brightness: 0.5, resonance: 0.35 }],
    ['eq', { lowDb: 0, midDb: 0, highDb: 0 }],
    ['chorus', { rate: 0.8, depth: 0.3, mix: 0.25 }],
    ['delay', { time: 0.3, feedback: 0.35, mix: 0.3 }],
    ['reverb', { decay: 2.2, mix: 0.35 }],
  ];
  const enabled = kind === 'bypass' ? [] : kind === 'crunch' ? ['drive', 'amp', 'cab'] : ['amp', 'cab', 'chorus', 'delay', 'reverb'];
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, id: `audition-${kind}`, name: `Native ${kind}`, revision: 0,
    chain: definitions.map(([type, parameters]) => ({ id: `audition-${type}`, type, model: `builtin_${type}`, enabled: enabled.includes(type), parameters })),
    metadata: { createdAt: now, updatedAt: now, source: 'native-audition' },
  };
}

function render(rig, name) {
  const outputPath = join(directory, `${name}.wav`);
  const requestId = `audition-${randomUUID()}`;
  const request = { protocolVersion: 1, requestId, command: 'render_audio', tone: rig, render: { inputPath, outputPath } };
  const run = spawnSync(executable, [], { input: `${JSON.stringify(request)}\n`, encoding: 'utf8', timeout: 30000 });
  if (run.error || run.status !== 0) throw new Error(run.error?.message ?? run.stderr ?? 'Native helper failed.');
  const response = JSON.parse(run.stdout);
  if (response.requestId !== requestId || response.protocolVersion !== 1 || response.ok !== true || response.result?.kind !== 'audio-render') {
    throw new Error(response.error?.message ?? 'Native helper returned a mismatched response. Rebuild it with npm run native:build.');
  }
  writeFileSync(join(directory, `${name}.tone.json`), `${JSON.stringify(rig, null, 2)}\n`);
  console.log(`${name}: ${outputPath} (${response.result.outputFrames} frames, peak ${response.result.peak.toFixed(3)}, ${response.result.attenuationDb.toFixed(2)} dB attenuation)`);
}

for (const kind of ['bypass', 'crunch', 'spacious']) render(tone(kind), `native-${kind}`);
if (process.argv[2]) render(JSON.parse(readFileSync(resolve(process.argv[2]), 'utf8')), 'native-imported-rig');
console.log(`Dry source: ${inputPath}\nOpen the WAV files in your preferred player to compare the same phrase. All processing used the native helper without audio hardware.`);
