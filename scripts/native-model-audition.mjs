import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const build = join(root, 'engine/audio/build');
const executable = join(build, 'bin', `toney-engine${process.platform === 'win32' ? '.exe' : ''}`);
if (!existsSync(executable)) throw new Error('Build the native engine first with npm run native:build.');
const arguments_ = process.argv.slice(2);
if (arguments_.length !== 0 && arguments_.length !== 2 && arguments_.length !== 3) {
  throw new Error('Usage: npm run native:models -- /absolute/capture.nam /absolute/cab.wav [source.wav]. With no arguments, use upstream test fixtures.');
}
const cache = existsSync(join(build, 'CMakeCache.txt')) ? readFileSync(join(build, 'CMakeCache.txt'), 'utf8') : '';
const namSource = process.env.NAM_PATH || cache.match(/^NAM_PATH:PATH=(.+)$/m)?.[1]
  || cache.match(/^toney_nam_SOURCE_DIR:STATIC=(.+)$/m)?.[1] || join(build, '_deps/toney_nam-src');
const modelPath = arguments_[0] ? resolve(arguments_[0]) : join(namSource, 'example_models/wavenet.nam');
if (!existsSync(modelPath)) throw new Error(`NAM model is missing: ${modelPath}. Build with the pinned official NAM dependency, or supply your own supported model and IR.`);
const directory = join(build, 'auditions', `models-${Date.now()}-${randomUUID().slice(0, 8)}`);
mkdirSync(directory, { recursive: true });

function pcm(samples, sampleRate) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36);
  bytes.writeUInt32LE(samples.length * 2, 40);
  for (const [index, value] of samples.entries()) bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + index * 2);
  return bytes;
}

const inputPath = join(directory, 'dry-source.wav');
if (arguments_[2]) copyFileSync(resolve(arguments_[2]), inputPath);
else {
  const sampleRate = 48000;
  const samples = new Float64Array(sampleRate * 2);
  for (const [index, midi] of [40, 47, 52, 55].entries()) {
    const start = Math.round((0.08 + index * 0.3) * sampleRate);
    const frequency = 440 * 2 ** ((midi - 69) / 12);
    for (let frame = 0; frame < sampleRate && start + frame < samples.length; frame++) {
      const time = frame / sampleRate;
      let sample = 0;
      for (let harmonic = 1; harmonic <= 8; harmonic++) sample += Math.sin(2 * Math.PI * frequency * harmonic * time) * Math.exp(-time * (3 + harmonic * 0.6)) / harmonic;
      samples[start + frame] += sample * Math.min(1, time / 0.004) * 0.22;
    }
  }
  writeFileSync(inputPath, pcm(samples, sampleRate));
}

const copiedNam = join(directory, 'capture.nam');
const copiedIr = join(directory, 'cab.wav');
copyFileSync(modelPath, copiedNam);
if (arguments_[1]) copyFileSync(resolve(arguments_[1]), copiedIr);
else {
  const impulse = Float64Array.from({ length: 1024 }, (_, index) => index === 0 ? 0.5 : 0.08 * Math.exp(-index / 180) * Math.cos(index * 0.32));
  writeFileSync(copiedIr, pcm(impulse, 48000));
  console.log('Using an official upstream NAM test fixture and synthetic test IR. These demonstrate loading and rendering; they are not a captured guitar amp or cabinet.');
}

function asset(kind, path, name) {
  return { descriptor: { id: createHash('sha256').update(readFileSync(path)).digest('hex'), kind, path }, name };
}
const nam = asset('nam', copiedNam, arguments_[0] ? basename(modelPath) : 'upstream-wavenet-test-fixture.nam');
const ir = asset('ir', copiedIr, arguments_[1] ? basename(arguments_[1]) : 'synthetic-test-ir.wav');

function exchange(request) {
  const run = spawnSync(executable, [], { input: `${JSON.stringify(request)}\n`, encoding: 'utf8', timeout: 60000, maxBuffer: 256 * 1024 });
  if (run.error || run.status !== 0) throw new Error(run.error?.message ?? run.stderr ?? 'Native helper failed.');
  const response = JSON.parse(run.stdout);
  if (response.protocolVersion !== 1 || response.requestId !== request.requestId) throw new Error('Native helper response does not match the request.');
  if (response.ok !== true) throw new Error(`[${response.error?.code ?? 'NATIVE_ERROR'}] ${response.error?.message ?? 'Native helper failed.'}`);
  return response.result;
}

for (const imported of [nam, ir]) {
  const info = exchange({ protocolVersion: 1, requestId: `inspect-${randomUUID()}`, command: 'inspect_asset', asset: imported.descriptor });
  if (info.kind !== 'asset-info' || info.id !== imported.descriptor.id || info.assetKind !== imported.descriptor.kind) throw new Error('Native helper returned mismatched asset metadata.');
  console.log(`${imported.name}: ${info.architecture ?? 'IR'}, ${info.sampleRate} Hz, ${info.modelVersion ? `NAM ${info.modelVersion}` : `${info.frames} frames`}`);
}

function tone(kind) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2, id: `models-${kind}`, name: `Native ${kind} audition`, revision: 0,
    chain: [
      { id: 'amp', type: 'amp', model: 'nam', enabled: kind === 'nam' || kind === 'combined',
        parameters: { gain: 0.25, bass: 0.5, mid: 0.55, treble: 0.5, master: 0.65 }, asset: { id: nam.descriptor.id, kind: 'nam', name: nam.name } },
      { id: 'cab', type: 'cab', model: 'cab_ir', enabled: kind === 'ir' || kind === 'combined',
        parameters: { brightness: 0.5, resonance: 0.35 }, asset: { id: ir.descriptor.id, kind: 'ir', name: ir.name } },
    ],
    metadata: { createdAt: now, updatedAt: now, source: 'native-model-audition' },
  };
}

for (const kind of ['bypass', 'nam', 'ir', 'combined']) {
  const rig = tone(kind);
  const assets = rig.chain.filter(node => node.enabled).map(node => node.type === 'amp' ? nam.descriptor : ir.descriptor);
  const outputPath = join(directory, `native-${kind}.wav`);
  const result = exchange({ protocolVersion: 1, requestId: `render-${randomUUID()}`, command: 'render_audio', tone: rig, render: { inputPath, outputPath, assets } });
  if (result.kind !== 'audio-render' || result.toneId !== rig.id || result.revision !== rig.revision || !Number.isFinite(result.peak) || result.peak > 0.8501) throw new Error('Native helper returned invalid render metadata.');
  writeFileSync(join(directory, `native-${kind}.tone.json`), `${JSON.stringify(rig, null, 2)}\n`);
  writeFileSync(join(directory, `native-${kind}.assets.json`), `${JSON.stringify(assets, null, 2)}\n`);
  console.log(`${kind}: ${outputPath} (${result.sampleRate} Hz, ${result.channels} channel(s), peak ${result.peak.toFixed(4)})`);
}
console.log(`Dry source: ${inputPath}\nAll WAVs, matching presets, and local asset mappings are saved in ${directory}. Open the WAVs in a player to compare the same source. Native inference ran without audio hardware.`);
