// "Nu bezig" (0.4.5) in a real browser, with two bots really at work (a test model that keeps working and says what it
// does, like a model calling tools) and a real headless bot browser on a small local shop:
//  - the computer: "Nu bezig" is a fixed place in the sidebar (its own page, not inside Instellingen); every working
//    bot with its current step, updated live; a small live picture of the browser of the bot that uses one; Bekijken
//    (the chat with the browser next to it), Overnemen (you get control, the live view opens), Stoppen (the run stops);
//  - the phone (the paired iPhone app's web view): the same overview, Bekijken opens the browser as a sheet.
// Checks: no page errors, no sideways scrolling on the phone, axe-core WCAG 2.2 A/AA light and dark.
// Usage: npm run build:ui && node --import tsx tests/e2e/now-busy.mjs   (TEAMBOT_E2E_PORT=<port>, free port by default)
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const failures = [];
const fail = (s) => (failures.push(s), console.error(`✗ ${s}`));
const step = (s) => console.log(`• ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await fn().catch(() => false)) return true;
  return false;
};

// ---- a small local shop for the bot's browser
const site = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html lang="nl"><head><title>Groene Winkel</title></head><body style="margin:0;font:16px system-ui;background:#14532d;color:#fff"><h1 style="padding:24px">Groene Winkel</h1><p style="padding:0 24px">Kamerplanten</p></body></html>');
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const shop = `http://127.0.0.1:${site.address().port}/`;

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-now-home-'));
Object.assign(process.env, { APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), TEAMBOT_BROWSER_HEADLESS_ONLY: '1', TEAMBOT_IROH_PRESET: 'offline' });
delete process.env.TEAMBOT_DATA;
const { createApp } = await import('./server.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-now-'));
const app = await createApp({ dataDir: dir, port: Number(process.env.TEAMBOT_E2E_PORT) || 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
if (!app.ctx.config.uiDir) throw new Error('Bouw eerst de interface: npm run build:ui');
const token = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();
const call = async (tok, method, p, body, headers = {}) => {
  const r = await fetch(app.url + '/api' + p, { method, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${j.error || ''}`);
  return j;
};
const pc = (method, p, body) => call(token, method, p, body);

// A test model that keeps working until it is stopped and says what it does (the runner turns that into the step).
const STEPS = ['Opent de winkel', 'Zoekt naar kamerplanten', 'Vergelijkt drie planten'];
app.ctx.providers.registerKind({
  id: 'slow',
  label: 'Traag testmodel',
  type: 'api',
  group: 'local',
  billing: 'local',
  needsKey: false,
  description: 'e2e',
  models: ['slow-1'],
  defaultModel: 'slow-1',
  detect: async () => ({ installed: true, detail: 'e2e' }),
  create: () => ({
    kind: 'slow',
    async listModels() {
      return [{ id: 'slow-1' }];
    },
    async test() {
      return { ok: true, detail: 'e2e' };
    },
    async chat(_req, signal, onEvent) {
      let n = 0;
      onEvent({ type: 'status', text: STEPS[0] });
      const t = setInterval(() => onEvent({ type: 'status', text: STEPS[++n % STEPS.length] }), 1200);
      try {
        await new Promise((_, reject) => {
          if (signal.aborted) return reject(signal.reason || new Error('Gestopt'));
          signal.addEventListener('abort', () => reject(signal.reason || new Error('Gestopt')));
        });
      } finally {
        clearInterval(t);
      }
    },
  }),
});
const prov = app.ctx.providers.create(owner.id, { kind: 'slow', name: 'Traag testmodel' });
const surfer = app.ctx.store.createAgent(owner.id, { name: 'Surfer', avatar: '', role: 'Zoekt in webwinkels', provider_id: prov.id, model: 'slow-1', tool_groups: [] });
const writer = app.ctx.store.createAgent(owner.id, { name: 'Schrijver', avatar: '', role: 'Schrijft teksten', provider_id: prov.id, model: 'slow-1', tool_groups: [] });
await pc('PUT', `/computers/${surfer.id}/config`, { mode: 'browser', allow_private: true });
await pc('POST', `/computers/${surfer.id}/browser/start`, { url: shop });
const ts = await pc('POST', '/threads', { agentId: surfer.id });
const tw = await pc('POST', '/threads', { agentId: writer.id });
await pc('POST', `/threads/${ts.id}/messages`, { content: 'Zoek een mooie kamerplant in de Groene Winkel.' });
await pc('POST', `/threads/${tw.id}/messages`, { content: 'Schrijf een nieuwsbrief over kamerplanten.' });
const running = () => app.ctx.runs.activeRuns(owner.id).filter((r) => r.status === 'running').length;
if (!(await until(async () => running() === 2, 10000))) fail(`twee bots aan het werk verwacht, er lopen er ${running()}`);

// A paired iPhone (the real QR flow), for the phone part.
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TeamBotiOS/0.4.5';
const ticket = await pc('POST', '/mobile/pair', { baseUrl: app.url });
const claimed = await call(null, 'POST', '/public/mobile/claim', { secret: new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('t'), name: 'iPhone van Sanne', platform: 'ios', client: 'ios-app' }, { 'user-agent': IOS_UA });

async function axe(page, name) {
  await page.addScriptTag({ content: axeSource });
  const v = await page.evaluate(async () => {
    // @ts-ignore
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
    return r.violations.map((x) => `${x.id}: ${x.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`);
  });
  if (v.length) fail(`a11y ${name}: ${v.join(' | ')}`);
}
const frameShown = (row) => row.locator('[data-testid="now-thumb"] img').evaluate((i) => i.complete && i.naturalWidth > 0);

try {
  // ================================================================ the computer
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: 'nl-NL', colorScheme: 'light', bypassCSP: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${app.url}/#token=${token}`);
  await page.waitForTimeout(1000);
  const side = page.getByRole('navigation', { name: 'Hoofdmenu' });
  // Nu bezig is reached from Taken (the sidebar keeps at most six fixed places).
  await side.getByRole('link', { name: 'Taken', exact: true }).click();
  await page.locator('main a[href="#/m/usage/status"]').first().click();
  await page.waitForURL(/#\/m\/usage\/status/);
  if (await page.getByRole('navigation', { name: 'Instellingen' }).count()) fail('Nu bezig staat binnen Instellingen in plaats van op een eigen plek');
  const rows = page.getByTestId('now-run');
  await until(async () => (await rows.count()) === 2, 10000);
  if ((await rows.count()) !== 2) fail(`Nu bezig: ${await rows.count()} bots, verwacht 2`);
  const sRow = rows.filter({ has: page.getByText('Surfer', { exact: true }) });
  const wRow = rows.filter({ has: page.getByText('Schrijver', { exact: true }) });
  step('zijbalk › Nu bezig: een eigen plek met de twee bots die werken');

  // the current step, live
  const stepOf = (row) => row.getByTestId('now-step').innerText();
  if (!(await until(async () => STEPS.includes((await stepOf(sRow)).trim()), 8000))) fail(`stap van Surfer: "${await stepOf(sRow)}"`);
  const first = (await stepOf(sRow)).trim();
  if (!(await until(async () => STEPS.includes((await stepOf(sRow)).trim()) && (await stepOf(sRow)).trim() !== first, 6000))) fail('de stap van Surfer verandert niet live');
  step(`de huidige stap, live: "${first}" → "${(await stepOf(sRow)).trim()}"`);

  // the live picture of the browser, only for the bot that uses one
  if (!(await until(() => frameShown(sRow), 15000))) fail('geen live beeld van de browser van Surfer');
  if (await wRow.getByTestId('now-thumb').count()) fail('Schrijver heeft geen browser maar wel een beeld');
  if (await wRow.getByRole('button', { name: /overnemen/i }).count()) fail('Schrijver: Overnemen zonder browser');
  for (const b of ['Bekijken', 'Stoppen', 'Overnemen']) if (!(await sRow.getByRole('button', { name: new RegExp(b, 'i') }).count())) fail(`Surfer: knop ${b} ontbreekt`);
  const src1 = await sRow.locator('[data-testid="now-thumb"] img').getAttribute('src');
  await page.waitForTimeout(3500);
  if ((await sRow.locator('[data-testid="now-thumb"] img').getAttribute('src')) === src1) fail('het beeld van de browser ververst niet');
  step('klein live beeld van de browser van Surfer (ververst), met Bekijken / Stoppen / Overnemen; Schrijver zonder beeld');
  await axe(page, 'Nu bezig (licht)');

  // Overnemen: you get control, the chat with the live view opens
  await sRow.getByRole('button', { name: /overnemen/i }).click();
  await page.waitForURL(new RegExp(`#/t/${ts.id}`), { timeout: 8000 }).catch(() => fail('Overnemen: het gesprek van Surfer opent niet'));
  await page.getByRole('heading', { name: 'Browser van Surfer' }).waitFor({ timeout: 10000 }).catch(() => fail('Overnemen: het live beeld van de browser opent niet'));
  const ctl = (await pc('GET', `/computers/${surfer.id}`)).status.controller;
  if (ctl?.kind !== 'user') fail(`Overnemen: de bediening is niet bij jou (${JSON.stringify(ctl)})`);
  await page.evaluate(() => (location.hash = '#/m/usage/status'));
  await sRow.getByText('Jij hebt de bediening').waitFor({ timeout: 8000 }).catch(() => fail('Nu bezig: niet gezegd dat jij de bediening hebt'));
  if (await sRow.getByRole('button', { name: /overnemen/i }).count()) fail('Nu bezig: Overnemen terwijl jij de bediening al hebt');
  await pc('POST', `/computers/${surfer.id}/release`, {});
  step('Overnemen: jij krijgt de bediening en het live beeld opent naast de chat; Nu bezig zegt "Jij hebt de bediening"');

  // Bekijken: the chat of a bot without a browser
  await wRow.getByRole('button', { name: /bekijken/i }).click();
  await page.waitForURL(new RegExp(`#/t/${tw.id}`), { timeout: 8000 }).catch(() => fail('Bekijken: het gesprek van Schrijver opent niet'));
  await page.evaluate(() => (location.hash = '#/m/usage/status'));
  await wRow.waitFor({ timeout: 8000 });
  // Stoppen: the run stops, the bot leaves the overview
  await wRow.getByRole('button', { name: /stoppen/i }).click();
  if (!(await until(async () => !app.ctx.runs.activeRuns(owner.id).some((r) => r.agent_id === writer.id), 8000))) fail('Stoppen: Schrijver werkt door');
  if (!(await until(async () => (await rows.count()) === 1, 8000))) fail('Stoppen: Schrijver blijft in Nu bezig staan');
  step('Bekijken opent het gesprek; Stoppen stopt Schrijver en hij verdwijnt uit Nu bezig');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(300);
  await axe(page, 'Nu bezig (donker)');
  if (errors.length) fail(`paginafouten (computer): ${errors.join(' | ')}`);
  await ctx.close();

  // ================================================================ the phone (the iPhone app's web view)
  const pctx = await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IOS_UA, locale: 'nl-NL', colorScheme: 'dark', bypassCSP: true });
  await pctx.addInitScript((t) => localStorage.setItem('tb_token', t), claimed.token);
  const pp = await pctx.newPage();
  const perr = [];
  pp.on('pageerror', (e) => perr.push(e.message));
  await pp.goto(`${app.url}/#/m/usage/status`);
  const prow = pp.getByTestId('now-run').filter({ has: pp.getByText('Surfer', { exact: true }) });
  await prow.waitFor({ timeout: 15000 }).catch(() => fail('telefoon: Surfer staat niet in Nu bezig'));
  if (!(await until(() => frameShown(prow), 15000))) fail('telefoon: geen live beeld van de browser');
  const over = await pp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over > 1) fail(`telefoon: Nu bezig schuift ${over}px opzij`);
  await axe(pp, 'Nu bezig telefoon (donker)');
  await prow.getByRole('button', { name: 'Surfer bekijken', exact: true }).tap();
  await pp.getByRole('dialog', { name: 'Browser van de bot' }).waitFor({ timeout: 10000 }).catch(() => fail('telefoon: Bekijken opent de browser van de bot niet'));
  if (perr.length) fail(`paginafouten (telefoon): ${perr.join(' | ')}`);
  step('telefoon: hetzelfde overzicht met live beeld, Bekijken opent de browser als blad');
  await pctx.close();
} catch (e) {
  fail(e.stack || e.message);
} finally {
  await pc('POST', '/stop-all', {}).catch(() => undefined);
  await browser.close();
  await app.close();
  site.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
console.log(failures.length ? `MISLUKT (${failures.length})` : 'OK');
process.exit(failures.length ? 1 : 0);
