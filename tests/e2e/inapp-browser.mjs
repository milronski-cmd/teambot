// The bots' own browsers INSIDE TeamBot (0.4.5), with real Electron and a temporary data folder: every browser tool,
// the live view, "Neem over", downloads, uploads, dialogs, popups, two separate profiles, the network policy, memory
// per bot, and never a window on the screen. Then the full browser panel flow (browser-dock.mjs) on this engine.
//   node tests/e2e/inapp-browser.mjs            (TB_INAPP_DOCK=0 skips the browser-panel flow)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const work = path.resolve('.data', `e2e-inapp-${Date.now()}`); // inside the project: the bundle finds node_modules
fs.mkdirSync(work, { recursive: true });
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-inapp-'));
const external = [...Object.keys(pkg.dependencies || {}), 'electron', '@anthropic-ai/sdk'];
await build({
  bundle: true,
  platform: 'node',
  target: 'node22',
  external,
  logLevel: 'silent',
  format: 'esm',
  entryPoints: ['tests/e2e/inapp-browser-electron.ts'],
  outfile: path.join(work, 'main.mjs'),
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});

let failed = false;
let passed = 0;
let total = 0;
const memory = {};
await new Promise((resolve) => {
  // an empty APPDATA: nothing of an installed TeamBot (or the owner's own data) is read or written; temporary folders
  // (also those of browser-dock.mjs) stay inside this test's folder, which goes after Electron has closed
  const appdata = path.join(data, 'appdata');
  const tmp = path.join(data, 'tmp');
  for (const d of [appdata, tmp]) fs.mkdirSync(d, { recursive: true });
  const child = spawn(require('electron'), [path.join(work, 'main.mjs')], {
    cwd: process.cwd(),
    env: { ...process.env, APPDATA: appdata, TEMP: tmp, TMP: tmp, TEAMBOT_DOCK_SHOTS: path.join(data, 'shots'), TB_INAPP_DIR: data, ELECTRON_ENABLE_LOGGING: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0; ) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.startsWith('@@')) {
        const m = JSON.parse(line.slice(2));
        if (m.check) {
          total++;
          if (m.ok) passed++;
          else failed = true;
          const detail = m.ok ? String(m.detail || '').split('\n')[0].slice(0, 100) : m.detail;
          console.log(`${m.ok ? '✔' : '✖'} ${m.check}${detail ? ` — ${detail}` : ''}`);
        } else if (m.section) console.log(`\n— ${m.section} —`);
        else if (m.memory) Object.assign(memory, m.memory);
      } else if (/^[✔✖]|controles geslaagd/.test(line)) {
        console.log(line);
        if (line.startsWith('✖')) failed = true;
      }
    }
  });
  let err = '';
  child.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
  const t = setTimeout(() => (child.kill(), (failed = true), console.log('✖ Electron reageerde niet binnen 6 minuten')), 360_000);
  child.on('exit', (code) => {
    clearTimeout(t);
    if (code) {
      failed = true;
      if (err.trim()) console.log(err.trim().split('\n').slice(-15).join('\n'));
    }
    resolve();
  });
});
fs.rmSync(work, { recursive: true, force: true });
fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
if (Object.keys(memory).length) console.log(`\nGeheugen per bot-browser: ${Object.entries(memory).map(([k, v]) => `${k} ${v} MB`).join(', ')}`);
console.log(`${passed}/${total} controles (ingebouwde browser) geslaagd.`);
process.exitCode = failed ? 1 : 0;
