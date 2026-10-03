import { mkdirSync, copyFileSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const build = join(root, 'engine/audio/build');
const cmake = process.env.CMAKE ?? 'cmake';
const ctest = cmake.includes('/') ? join(dirname(cmake), 'ctest') : 'ctest';

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw new Error(`Cannot run ${command}: ${result.error.message}. Install CMake and a C++ toolchain.`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(cmake, ['-S', 'engine/audio', '-B', build, '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_TESTING=ON',
  ...(process.env.JUCE_PATH ? [`-DJUCE_PATH=${process.env.JUCE_PATH}`] : []),
  ...(process.env.NAM_PATH ? [`-DNAM_PATH=${process.env.NAM_PATH}`] : [])]);
run(cmake, ['--build', build, '--parallel', String(Math.min(4, availableParallelism()))]);
run(ctest, ['--test-dir', build, '--output-on-failure']);
const host = spawnSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' });
if (host.error || host.status !== 0 || !host.stdout.trim()) throw new Error('Rust is required to determine the sidecar architecture. Install the Rust toolchain.');
const extension = process.platform === 'win32' ? '.exe' : '';
const destination = join(root, 'apps/desktop/src-tauri/binaries', `toney-engine-${host.stdout.trim()}${extension}`);
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(join(build, `bin/toney-engine${extension}`), destination);
chmodSync(destination, 0o755);
console.log(`Native helper verified and staged: ${destination}`);
