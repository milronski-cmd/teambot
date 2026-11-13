// Taskbar badge (B-67) with real Electron, without stealing focus: the badge code runs in Electron with a HIDDEN
// window (never shown or focused), no tray icon, and a temporary data folder. The overlay and tray images are written
// as PNG files to look at (the real taskbar is not touched), together with the preview sheet of scripts/badge-preview.mjs.
// Then the page side in a headless browser: what the real UI sends to the desktop bridge (unread chat, a question that
// waits, all read), without spam.
//   node --import tsx tests/e2e/badge-check.mjs [folder for the images]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const shots = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'teambot-badge'));
fs.mkdirSync(shots, { recursive: true });
const work = path.resolve('.data', `e2e-badge-${Date.now()}`); // inside the project: the bundle finds node_modules
fs.mkdirSync(work, { recursive: true });
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-badge-'));
const external = [...Object.keys(pkg.dependencies || {}), 'electron'];
await build({ bundle: true, platform: 'node', target: 'node22', external, logLevel: 'silent', format: 'esm', entryPoints: ['tests/e2e/badge-electron.ts'], outfile: path.join(work, 'main.mjs'), banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } });

let failed = false;
await new Promise((resolve) => {
  const child = spawn(require('electron'), [path.join(work, 'main.mjs')], { env: { ...process.env, TB_BADGE_DIR: data, TB_BADGE_SHOTS: shots, TB_BADGE_ICON: path.resolve('build/icon.png'), ELECTRON_ENABLE_LOGGING: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0; ) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.startsWith('@@')) continue;
      const m = JSON.parse(line.slice(2));
      if (m.check) {
        if (!m.ok) failed = true;
        console.log(`${m.ok ? '✔' : '✖'} ${m.check}${m.detail && !m.ok ? ` — ${m.detail}` : ''}`);
      }
    }
  });
  child.stderr.on('data', () => {});
  const t = setTimeout(() => (child.kill(), (failed = true), console.log('✖ Electron reageerde niet binnen 60 s')), 60_000);
  child.on('exit', (code) => (clearTimeout(t), code && (failed = true), resolve()));
});
fs.rmSync(work, { recursive: true, force: true });
fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

// ---- the page side: what the real UI sends to the desktop bridge (headless browser, TEMP data folder) ----
const { createApp } = await import('./server.mjs');
const { chromium } = require('playwright-core');
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-badge-ui-'));
const app = await createApp({ dataDir: dir2, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();
const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const ok = (name, cond, detail = '') => {
  if (!cond) failed = true;
  console.log(`${cond ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};
try {
  const res = await fetch(`${app.url}/api/agents`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Badgebot' }) });
  const agent = await res.json();
  const thread = app.ctx.chat.threadForAgent(owner.id, agent.id);
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  // The bridge the Electron preload adds, recording what the page sends.
  await page.addInitScript(() => {
    window.__badge = [];
    window.teambotDesktop = { isDesktop: true, setBadge: (c) => window.__badge.push(c) };
  });
  await page.goto(`${app.url}/#token=${token}`);
  await page.waitForFunction(() => !!document.querySelector('nav'), null, { timeout: 20000 });
  await page.evaluate(() => (location.hash = '#/settings'));
  await page.waitForTimeout(500);
  // The bot writes while the owner looks at another page (an open chat would count as read).
  app.ctx.chat.addAgentMessage(thread, app.ctx.store.agent(agent.id), 'Ik heb nieuws voor je.');
  const last = () => page.evaluate(() => window.__badge.at(-1) || null);
  const waitFor = (w, u) => page.waitForFunction(([w, u]) => { const l = window.__badge.at(-1); return !!l && l.waiting === w && l.unread === u; }, [w, u], { timeout: 8000 }).then(() => true, () => false);
  ok('ongelezen chat telt mee', await waitFor(0, 1), JSON.stringify(await last()));
  const q = app.ctx.broker.request({ userId: owner.id, agent: app.ctx.store.agent(agent.id), thread, run: null, kind: 'question', tool: 'ask_user', input: { question: 'Mag ik?' }, summary: 'Mag ik?', risk: 'read' });
  q.catch(() => {});
  ok('een vraag van de bot telt als "wacht op jou" (die chat niet dubbel)', await waitFor(1, 0), JSON.stringify(await last()));
  await page.evaluate((id) => (location.hash = `#/t/${id}`), thread.id);
  await page.waitForTimeout(800);
  const apr = app.ctx.store.one("SELECT id FROM approvals WHERE status = 'pending'");
  app.ctx.broker.resolve(apr.id, owner.id, 'deny');
  ok('alles gelezen en beantwoord: badge weg', await waitFor(0, 0), JSON.stringify(await last()));
  // The window goes to the tray with this chat open; a new message there still counts until the owner looks again.
  const setVisible = (v) => page.evaluate((v) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (v ? 'visible' : 'hidden') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, v);
  await setVisible(false);
  app.ctx.chat.addAgentMessage(thread, app.ctx.store.agent(agent.id), 'Nog iets, terwijl je weg was.');
  ok('verborgen venster: nieuw bericht in de open chat telt als ongelezen', await waitFor(0, 1), JSON.stringify(await last()));
  await setVisible(true);
  ok('weer zichtbaar: gelezen, badge weg', await waitFor(0, 0), JSON.stringify(await last()));
  const calls = await page.evaluate(() => window.__badge.length);
  ok('geen spam: alleen bij een verandering verstuurd', calls <= 6, `${calls} keer`);
  await page.close();
} finally {
  await browser.close();
  await app.close();
  fs.rmSync(dir2, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

execFileSync(process.execPath, ['--import', 'tsx', 'scripts/badge-preview.mjs', shots], { stdio: 'inherit' });
console.log(`Afbeeldingen: ${shots}`);
process.exit(failed ? 1 : 0);
