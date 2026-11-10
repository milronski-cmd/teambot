// The floating status window (B-69) and TeamBot's own Windows notification (B-67) with real Electron: the desktop code
// (desktop/status.ts) with TeamBot's server and the built UI, in a temporary data folder (TEAMBOT_DATA), with fake
// engines. Bots work, wait for approvals and finish; the window appears in "auto", shows faces and text, updates live,
// lets you approve and answer, and hides when all is quiet. The owner's desktop is left alone: no main window, no tray
// icon, the status window is transparent and click-through, notifications are recorded instead of shown.
//   npm run build && npm run status:check      (TEAMBOT_E2E_SHOTS=<folder> for the captured window)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const preload = path.resolve('dist/desktop/preload.cjs');
if (!fs.existsSync(preload) || !fs.existsSync(path.resolve('dist/ui/index.html'))) {
  console.log('✖ Eerst bouwen: npm run build');
  process.exit(1);
}
const work = path.resolve('.data', `e2e-status-${Date.now()}`); // inside the project: the bundle finds node_modules
fs.mkdirSync(work, { recursive: true });
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-status-'));
// A copy of the UI outside the project (a worktree path with a dot-folder cannot be served with sendFile).
fs.cpSync(path.resolve('dist/ui'), path.join(data, 'ui'), { recursive: true });
const shots = process.env.TEAMBOT_E2E_SHOTS ? path.resolve(process.env.TEAMBOT_E2E_SHOTS) : '';
if (shots) fs.mkdirSync(shots, { recursive: true });
const external = [...Object.keys(pkg.dependencies || {}), 'electron'];
await build({ bundle: true, platform: 'node', target: 'node22', external, logLevel: 'silent', format: 'esm', entryPoints: ['tests/e2e/status-electron.ts'], outfile: path.join(work, 'main.mjs'), banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } });

let failed = false;
let checks = 0;
await new Promise((resolve) => {
  const env = { ...process.env, TEAMBOT_DATA: data, TEAMBOT_UI_DIR: path.join(data, 'ui'), TB_STATUS_PRELOAD: preload, TB_STATUS_SHOTS: shots, ELECTRON_ENABLE_LOGGING: '' };
  const child = spawn(require('electron'), [path.join(work, 'main.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const t = setTimeout(() => (child.kill(), (failed = true), console.log('✖ Electron reageerde niet binnen 150 s')), 150_000);
  child.on('exit', (code) => {
    clearTimeout(t);
    if (code) {
      failed = true;
      if (!checks) console.log(err.slice(-2000));
    }
    if (!checks) {
      console.log(`Electron stopte met code ${code}`, err.slice(-3000));
    }
    resolve();
  });
});
if (!process.env.TB_KEEP) fs.rmSync(work, { recursive: true, force: true });
fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
if (!checks) failed = true;
console.log(failed ? 'STATUS-CHECK MISLUKT' : `STATUS-CHECK GESLAAGD (${checks} controles)`);
process.exitCode = failed ? 1 : 0;
