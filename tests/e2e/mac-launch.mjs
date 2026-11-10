// LIVE check of the first start of the packaged macOS app, the Mac counterpart of first-launch.mjs. It starts the packed
// TeamBot.app (electron-builder's release/mac-arm64 or release/mac) with its own home folder, data folder and port,
// and checks what a person sees:
//   1. the window opens on the start page and then loads the interface from 127.0.0.1;
//   2. the first screen is drawn (a screenshot of it is kept);
//   3. TeamBot listens on 127.0.0.1 only;
//   4. the native parts load in the packed app: the local API answers and the app keeps running.
// Usage: npm run dist:mac && npm run mac-launch:check [-- --app <folder with TeamBot.app>] [--out <folder for screenshots>]
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.platform !== 'darwin') {
  console.log('Alleen op macOS.');
  process.exit(0);
}
const root = process.cwd();
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const folder = arg('--app') ? path.resolve(arg('--app')) : ['mac-arm64', 'mac', 'mac-universal'].map((d) => path.join(root, 'release', d)).find((d) => fs.existsSync(path.join(d, 'TeamBot.app')));
const exe = folder ? path.join(folder, 'TeamBot.app', 'Contents', 'MacOS', 'TeamBot') : '';
if (!exe || !fs.existsSync(exe)) {
  console.error('Geen TeamBot.app gevonden. Bouw eerst: npm run dist:mac');
  process.exit(2);
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-mac-launch-'));
const out = arg('--out') ? path.resolve(arg('--out')) : work;
fs.mkdirSync(out, { recursive: true });
const APP_PORT = Number(process.env.TEAMBOT_FIRST_LAUNCH_PORT) || 47913;
const CDP_PORT = APP_PORT + 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? '  ok  ' : '  FOUT'} ${what}`);
  if (!ok) failures.push(what);
};

async function pages() {
  try {
    return (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(3000) })).json()).filter((t) => t.type === 'page');
  } catch {
    return [];
  }
}
async function cdp(target, method, params = {}) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const open = await Promise.race([new Promise((res) => ((ws.onopen = () => res(true)), (ws.onerror = () => res(false)))), sleep(5000).then(() => false)]);
  if (!open) {
    try {
      ws.close();
    } catch {}
    return null;
  }
  const r = await Promise.race([
    new Promise((res) => {
      ws.onmessage = (m) => {
        const d = JSON.parse(m.data);
        if (d.id === 1) res(d.result);
      };
      ws.send(JSON.stringify({ id: 1, method, params }));
    }),
    sleep(6000).then(() => null),
  ]);
  ws.close();
  return r;
}
const text = async (t) => (await cdp(t, 'Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""', returnByValue: true }))?.result?.value ?? null;
const shot = async (t, file) => {
  const r = await cdp(t, 'Page.captureScreenshot', { format: 'png' });
  if (r?.data) fs.writeFileSync(path.join(out, file), Buffer.from(r.data, 'base64'));
};

// Its own data folder, but the real home folder: the macOS keychain (safeStorage) lives there, and without one the
// app waits forever on a system dialog.
const dataDir = path.join(work, 'TeamBot');
fs.mkdirSync(dataDir, { recursive: true });
const env = { ...process.env, TEAMBOT_DATA: dataDir, TEAMBOT_PORT: String(APP_PORT) };
for (const k of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'TEAMBOT_UPDATE_URL', 'TEAMBOT_UPDATE_TEST', 'TEAMBOT_HOST', 'TEAMBOT_MASTER_KEY']) delete env[k];
const logFile = path.join(out, 'app-output.log');
const logFd = fs.openSync(logFile, 'w');
const t0 = Date.now();
const child = spawn(exe, [`--remote-debugging-port=${CDP_PORT}`], { env, stdio: ['ignore', logFd, logFd] });
let exited = null;
child.on('exit', (code, signal) => (exited = { code, signal }));
// Never hang: after two minutes say where the check was, show the app's own output and stop.
let at = 'waiting for the window';
const step = (what) => {
  at = what;
  console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)} s] ${what}`);
};
setTimeout(async () => {
  console.error(`\nFOUT: the check did not finish within 120 s (it was at: ${at}).`);
  console.error(`Pages: ${JSON.stringify((await pages()).map((t) => t.url.slice(0, 80)))}`);
  try {
    console.error(fs.readFileSync(logFile, 'utf8').split('\n').slice(-60).join('\n'));
  } catch {}
  try {
    child.kill('SIGKILL');
  } catch {}
  process.exit(1);
}, 120_000).unref();

try {
  let start = null;
  let ui = null;
  step(`started ${exe} (pid ${child.pid})`);
  for (const until = Date.now() + 60_000; Date.now() < until && !ui && !exited; await sleep(100)) {
    for (const t of await pages()) {
      if (start === null && t.url.startsWith('data:text/html')) {
        start = Date.now() - t0;
        step('start page seen, taking a screenshot');
        await shot(t, 'mac-start-page.png');
        step('waiting for the interface');
      }
      if (t.url.startsWith(`http://127.0.0.1:${APP_PORT}/`)) ui = { t, at: Date.now() - t0 };
    }
  }
  check(!exited, exited ? `the app stopped by itself (code ${exited.code}, signal ${exited.signal})` : 'the app starts and keeps running');
  check(start !== null, `the window opens on the start page (${start} ms)`);
  check(!!ui, `then the interface loads in the same window (${ui?.at} ms)`);
  if (ui) {
    step('interface loaded, reading the first screen');
    let body = '';
    for (let i = 0; i < 100 && body.length < 40; i++) (await sleep(200), (body = (await text(ui.t)) || ''));
    check(body.length >= 40, `the first screen is drawn: ${JSON.stringify(body.slice(0, 160))}`);
    await sleep(1000);
    await shot(ui.t, 'mac-first-screen.png');

    step('listing the listening ports');
    let listen = '';
    try {
      listen = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 15_000 });
    } catch (e) {
      listen = String(e.stdout || '');
    }
    const mine = listen.split('\n').filter((l) => /^TeamBot/.test(l) && !l.includes(`:${CDP_PORT} `));
    const addrs = mine.map((l) => l.trim().split(/\s+/).slice(-2)[0]);
    check(addrs.length > 0 && addrs.every((a) => /^(127\.0\.0\.1|\[::1\]):/.test(a)), `listens on 127.0.0.1 only: ${addrs.join(' ') || '(nothing)'}`);

    step('asking the local server');
    let health = null;
    for (const p of ['/healthz']) {
      try {
        const r = await fetch(`http://127.0.0.1:${APP_PORT}${p}`, { signal: AbortSignal.timeout(5000) });
        if (r.ok) {
          health = `${p} → ${r.status}`;
          break;
        }
      } catch {}
    }
    check(!!health, `the local server answers (${health})`);
    check(fs.existsSync(path.join(dataDir, 'teambot.db')), 'the database is created in the data folder');
    await sleep(3000);
    check(!exited, 'still running after the first screen');
  }
} finally {
  step('stopping the app');
  child.kill();
  await sleep(1500);
  if (!exited) child.kill('SIGKILL');
  fs.closeSync(logFd);
}
const tail = fs.readFileSync(logFile, 'utf8').split('\n').slice(-40).join('\n');
if (failures.length) console.log(`\nLast output of the app:\n${tail}`);
console.log(`\nScreenshots and log: ${out}`);
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('\nmacOS start: all checks passed.');
process.exit(0);
