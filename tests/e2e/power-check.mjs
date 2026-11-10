// "Houd de pc wakker terwijl routines of taken lopen" (A-76) with real Electron: the desktop code holds and releases
// Electron's powerSaveBlocker exactly as the server says, without a window or tray icon, in a temporary data folder.
//   node --import tsx tests/e2e/power-check.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const work = path.resolve('.data', `e2e-power-${Date.now()}`); // inside the project: the bundle finds node_modules
fs.mkdirSync(work, { recursive: true });
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-power-'));
const external = [...Object.keys(pkg.dependencies || {}), 'electron'];
await build({ bundle: true, platform: 'node', target: 'node22', external, logLevel: 'silent', format: 'esm', entryPoints: ['tests/e2e/power-electron.ts'], outfile: path.join(work, 'main.mjs'), banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } });

let failed = false;
let checks = 0;
await new Promise((resolve) => {
  const child = spawn(require('electron'), [path.join(work, 'main.mjs')], { env: { ...process.env, TB_POWER_DIR: data, ELECTRON_ENABLE_LOGGING: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0; ) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.startsWith('@@')) continue;
      const m = JSON.parse(line.slice(2));
      if (m.check) {
        checks++;
        if (!m.ok) failed = true;
        console.log(`${m.ok ? '✔' : '✖'} ${m.check}${m.detail && !m.ok ? ` — ${m.detail}` : ''}`);
      } else if (m.note) console.log(`• ${m.note}`);
    }
  });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  const t = setTimeout(() => (child.kill(), (failed = true), console.log('✖ Electron reageerde niet binnen 90 s')), 90_000);
  child.on('exit', (code) => {
    clearTimeout(t);
    if (code) {
      failed = true;
      if (!checks) console.log(err.slice(-2000));
    }
    resolve();
  });
});
fs.rmSync(work, { recursive: true, force: true });
fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
if (!checks) failed = true;
console.log(failed ? 'POWER-CHECK MISLUKT' : 'POWER-CHECK GESLAAGD');
process.exitCode = failed ? 1 : 0;
