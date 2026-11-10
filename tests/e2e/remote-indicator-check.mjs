// The stop bar of remote desktop (desktop/remote-indicator.ts) in real Electron: it appears when someone watches, says
// who, never takes focus, sits top-centre on the main screen, follows "kijkt mee" → "bedient", and its Stop ends every
// session and switches remote desktop off. Temporary data folder, dry-run screen driver; the bar is transparent and
// click-through while the check runs, Stop is pressed in the page, notifications are recorded (tests/e2e/remote-electron.ts).
//   npm run build && npm run remote:indicator
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const work = path.resolve('.data', `e2e-remote-${Date.now()}`); // inside the project: the bundle finds node_modules
fs.mkdirSync(work, { recursive: true });
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-remote-bar-'));
const external = [...Object.keys(pkg.dependencies || {}), 'electron'];
await build({ bundle: true, platform: 'node', target: 'node22', external, logLevel: 'silent', format: 'esm', entryPoints: ['tests/e2e/remote-electron.ts'], outfile: path.join(work, 'main.mjs'), banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } });

let failed = false;
let checks = 0;
await new Promise((resolve) => {
  const env = { ...process.env, TEAMBOT_DATA: data, ELECTRON_ENABLE_LOGGING: '' };
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
      }
    }
  });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  const t = setTimeout(() => (child.kill(), (failed = true), console.log('✖ Electron reageerde niet binnen 90 s')), 90_000);
  child.on('exit', (code) => {
    clearTimeout(t);
    if (code || !checks) {
      failed = true;
      console.log(`Electron stopte met code ${code}`, err.slice(-2000));
    }
    resolve();
  });
});
fs.rmSync(work, { recursive: true, force: true });
fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log(failed ? 'STOPBALK MISLUKT' : `STOPBALK GESLAAGD (${checks} controles)`);
process.exitCode = failed ? 1 : 0;
