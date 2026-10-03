import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mode = process.argv[2];
if (!['dev', 'build'].includes(mode)) throw new Error('Use desktop.mjs dev or desktop.mjs build.');
let vite;
let desktop;

function run(command, args, cwd = root) {
  const child = spawn(command, args, { cwd, stdio: 'inherit' });
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  return child;
}

function cleanup() { vite?.kill(); desktop?.kill(); }
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });
process.on('exit', cleanup);

if (mode === 'dev') {
  async function isToney() {
    try {
      const response = await fetch('http://127.0.0.1:5173/', { signal: AbortSignal.timeout(1000) });
      if (!response.ok) return false;
      const html = await response.text();
      if (!html.includes('<title>Toney')) throw new Error('Port 5173 is already serving another project. Stop it before starting Toney.');
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.includes('another project')) throw error;
      return false;
    }
  }
  if (!(await isToney())) {
    vite = run(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1']);
    let ready = false;
    for (let attempt = 0; attempt < 40 && vite.exitCode === null; attempt++) {
      if (await isToney()) { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) { cleanup(); throw new Error('Toney’s local UI server did not become ready.'); }
  }
}

desktop = run(process.execPath, [join(root, 'node_modules/@tauri-apps/cli/tauri.js'),
  ...(mode === 'build' ? ['build', '--debug', '--bundles', 'app'] : ['dev'])], join(root, 'apps/desktop'));
desktop.on('exit', (code) => { vite?.kill(); process.exitCode = code ?? 1; });
