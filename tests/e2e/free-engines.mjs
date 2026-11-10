// Instellingen › Gratis modellen (TeamBot 0.4.4): every free option is on the page with one clear button, on the
// computer and on a paired phone. The owner's report (0.4.3): "OpenCode enzo staan niet bij gratis modellen, kan ze
// niet inschakelen" — OpenCode and Ollama only appeared as a passive line once connected, without any switch.
// Steps (Edge headless, an empty TeamBot on port 4850 with its own data folder and APPDATA, nothing of this PC):
//  1. nothing connected: OpenCode ("Installeren", one click) and Ollama ("Installeren" → the steps) are listed, next to
//     the cloud sources (Groq, OpenRouter, Cloudflare, Z.ai, Kilo);
//  2. OpenCode found on this computer (path set as in Instellingen › CLI-agents): "Aanzetten" connects it on a free
//     model and puts it in the free chain; "Uitzetten" takes it out, "Aanzetten" brings it back;
//  3. Ollama starts: "Opnieuw controleren" → "Aanzetten" connects it (a stand-in Ollama, no model runs);
//  4. a paired phone (the real QR pairing): OpenCode added the way a user does at AI-diensten is on the page, on, and
//     "Uitzetten" / "Aanzetten" work from the phone; no sideways scrolling at 402 px.
// No failed requests and no console errors anywhere.
// Usage: npm run build:ui && node --import tsx tests/e2e/free-engines.mjs
//        (TEAMBOT_E2E_SHOTS=<dir> for screenshots, TEAMBOT_E2E_PORT=<port> (default 4850), TEAMBOT_E2E_BROWSER=chrome|msedge)
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const FAKE_ACP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'cli-agents-fake-acp.mjs');

const step = (s) => console.log(`• ${s}`);
const failures = [];
const fail = (s) => {
  failures.push(s);
  console.error(`✗ ${s}`);
  process.exitCode = 1;
};
const check = (ok, s, detail = '') => (ok ? step(s) : fail(`${s}${detail ? ` (${detail})` : ''}`));
const SHOTS = process.env.TEAMBOT_E2E_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// The browser starts first (it needs this PC's normal environment), then TeamBot gets an empty one: no OpenCode,
// Ollama or AppData of this PC (not the owner's TeamBot, not OpenBot's runtimes) is found, used or changed.
const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-free-engines-home-'));
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  XDG_DATA_HOME: path.join(home, 'xdg', 'data'),
  XDG_CONFIG_HOME: path.join(home, 'xdg', 'config'),
  XDG_CACHE_HOME: path.join(home, 'xdg', 'cache'),
  PATH: path.dirname(process.execPath),
});
delete process.env.Path;
delete process.env.TEAMBOT_DATA;

// A stand-in Ollama (version and model list only; this test never asks it for an answer).
let ollamaUrl = '';
const ollama = http.createServer((req, res) => {
  const send = (x) => (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify(x)));
  if (req.url === '/api/version') return send({ version: '0.40.15' });
  if (req.url === '/api/tags') return send({ models: [{ name: 'qwen3:4b', digest: 'q', details: { parameter_size: '4B', context_length: 40960 }, capabilities: ['completion', 'tools'] }] });
  if (req.url === '/api/ps') return send({ models: [] });
  if (req.url === '/api/show') return send({ model_info: {}, capabilities: ['completion', 'tools'] });
  if (req.url === '/v1/models') return send({ data: [{ id: 'qwen3:4b' }] });
  res.writeHead(404).end();
});

const { createApp } = await import('../../server/app.ts');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-free-engines-'));
const app = await createApp({ dataDir: dir, port: Number(process.env.TEAMBOT_E2E_PORT) || 4850, host: '127.0.0.1', mode: 'desktop', quiet: true });
const pcToken = app.ctx.auth.ensureLocalOwner();
let ollamaHere = false;
for (const k of app.ctx.providers.kinds.values()) {
  if (k.id === 'ollama') k.detect = async () => (ollamaHere ? { installed: true, baseUrl: ollamaUrl + '/v1', detail: 'e2e' } : { installed: false, detail: 'e2e' });
  else if (k.detect && k.type !== 'cli') k.detect = async () => ({ installed: false, detail: 'e2e' });
  if (typeof k.baseUrl === 'string' && /\/\/(127\.0\.0\.1|localhost)[:/]/.test(k.baseUrl)) k.baseUrl = 'http://127.0.0.1:9/v1';
}
const call = async (token, method, p, body, headers = {}) => {
  const r = await fetch(app.url + '/api' + p, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const pc = async (method, p, body) => {
  const r = await call(pcToken, method, p, body);
  if (r.status >= 400) throw new Error(`${method} ${p} → ${r.status}: ${r.body.error}`);
  return r.body;
};
const inChain = async (kind) => (await pc('GET', '/free-models/candidates')).some((c) => c.providerKind === kind);
step(`TeamBot op ${app.url} (lege datamap ${dir})`);

const errors = [];
const failed = [];
const watch = (page, who) => {
  page.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text()) && errors.push(`${who}: ${m.text()}`));
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/') && r.status() >= 400) failed.push(`${who}: ${r.status()} ${r.request().method()} ${u.pathname}`);
  });
};
const withToken = (t) => async (ctx) =>
  ctx.addInitScript((tok) => {
    try {
      localStorage.setItem('tb_token', tok);
    } catch {}
  }, t);
const shot = async (page, name) => SHOTS && (await page.waitForTimeout(250), await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }));
const row = (page, kind) => page.getByTestId(`free-engine-${kind}`);
const button = (page, kind, name) => row(page, kind).getByRole('button', { name, exact: true });
const open = async (page) => {
  const url = app.url + '/#/settings/free-models-gratis';
  // The same address again only changes the hash: load the page anew, as the owner does with F5.
  if (page.url() === url) await page.reload();
  else await page.goto(url);
  await page.getByTestId('free-engines').waitFor({ timeout: 20_000 });
};

try {
  // ---------------------------------------------------------------- 1. on the computer, nothing connected
  const desk = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'nl-NL' });
  await withToken(pcToken)(desk);
  const page = await desk.newPage();
  watch(page, 'computer');
  await open(page);
  check(await row(page, 'opencode').isVisible(), 'OpenCode staat op de pagina, ook zonder koppeling');
  check((await row(page, 'opencode').innerText()).includes('Staat op deze pc') === false, 'OpenCode staat niet op deze pc: geen label');
  check(await button(page, 'opencode', 'Installeren').isVisible(), 'OpenCode: knop Installeren (TeamBot zet zijn eigen kopie neer)');
  check(await row(page, 'ollama').isVisible(), 'Ollama staat op de pagina, ook zonder koppeling');
  check((await row(page, 'ollama').getByRole('link', { name: /Ollama downloaden/ }).getAttribute('href')) === 'https://ollama.com/download', 'Ollama: één link naar de download, geen terminalopdrachten');
  for (const l of ['Groq', 'OpenRouter', 'Cloudflare Workers AI', 'Z.ai GLM', 'Kilo Gateway']) check(await page.locator('span.font-semibold', { hasText: new RegExp(`^${l.replace('.', '\\.')}$`) }).count(), `${l} staat er ook (gratis account online)`);
  await shot(page, 'gratis-1-niets-gekoppeld');

  // ---------------------------------------------------------------- 2. OpenCode on this computer: Aanzetten
  await pc('PUT', '/cli-agents/paths/opencode', { path: FAKE_ACP });
  await open(page);
  check((await row(page, 'opencode').innerText()).includes('Staat op deze pc'), 'OpenCode gevonden: de pagina zegt het');
  await button(page, 'opencode', 'Aanzetten').click();
  await button(page, 'opencode', 'Uitzetten').waitFor({ timeout: 20_000 });
  check(/gratis model/.test(await row(page, 'opencode').innerText()), 'na Aanzetten: OpenCode staat aan met zijn gratis modellen');
  check(await inChain('opencode'), 'OpenCode zit nu in de gratis keten');
  const oc = (await pc('GET', '/providers')).find((p) => p.kind === 'opencode');
  check(oc?.config?.defaultModel === 'opencode/big-pickle', 'gekoppeld op een gratis model', oc?.config?.defaultModel);
  await shot(page, 'gratis-2-opencode-aan');
  await button(page, 'opencode', 'Uitzetten').click();
  await button(page, 'opencode', 'Aanzetten').waitFor({ timeout: 10_000 });
  check(!(await inChain('opencode')), 'Uitzetten: uit de keten, en OpenCode blijft op de pagina met Aanzetten');
  await button(page, 'opencode', 'Aanzetten').click();
  await button(page, 'opencode', 'Uitzetten').waitFor({ timeout: 20_000 });
  check(await inChain('opencode'), 'Aanzetten: weer in de keten');

  // ---------------------------------------------------------------- 3. Ollama starts
  await new Promise((r) => ollama.listen(0, '127.0.0.1', r));
  ollamaUrl = `http://127.0.0.1:${ollama.address().port}`;
  ollamaHere = true;
  await row(page, 'ollama').getByRole('button', { name: 'Opnieuw controleren' }).click();
  await button(page, 'ollama', 'Aanzetten').waitFor({ timeout: 10_000 });
  await button(page, 'ollama', 'Aanzetten').click();
  await button(page, 'ollama', 'Uitzetten').waitFor({ timeout: 20_000 });
  check(await inChain('ollama'), 'Ollama: Opnieuw controleren → Aanzetten → lokaal in de keten');
  await shot(page, 'gratis-3-ollama-aan');
  await desk.close();

  // ---------------------------------------------------------------- 4. the paired phone
  // OpenCode again, now added the way a user does it at AI-diensten (the 0.4.3 situation: connected, no switch).
  await pc('DELETE', `/providers/${oc.id}`);
  await pc('POST', '/providers', { kind: 'opencode', name: 'OpenCode' });
  const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TeamBotiOS/0.4.4';
  const ticket = await pc('POST', '/mobile/pair', { baseUrl: app.url });
  const secret = new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('t');
  const claimed = await call(null, 'POST', '/public/mobile/claim', { secret, name: 'iPhone van Sanne', platform: 'ios', client: 'ios-app' }, { 'user-agent': IOS_UA });
  if (claimed.status !== 200 || !claimed.body.token) throw new Error(`koppelen mislukt: ${claimed.status}`);
  step('telefoon gekoppeld via de echte QR-koppeling');
  const phone = await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IOS_UA, locale: 'nl-NL' });
  await withToken(claimed.body.token)(phone);
  const pp = await phone.newPage();
  watch(pp, 'telefoon');
  await open(pp);
  await button(pp, 'opencode', 'Uitzetten').waitFor({ timeout: 20_000 });
  check(true, 'telefoon: OpenCode (gekoppeld bij AI-diensten) staat bij de gratis modellen en staat aan');
  check(await button(pp, 'ollama', 'Uitzetten').isVisible(), 'telefoon: Ollama staat er ook, aan');
  await button(pp, 'opencode', 'Uitzetten').tap();
  await button(pp, 'opencode', 'Aanzetten').waitFor({ timeout: 10_000 });
  check(!(await inChain('opencode')), 'telefoon: Uitzetten werkt');
  await button(pp, 'opencode', 'Aanzetten').tap();
  await button(pp, 'opencode', 'Uitzetten').waitFor({ timeout: 20_000 });
  check(await inChain('opencode'), 'telefoon: Aanzetten werkt');
  const wide = await pp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(wide <= 1, 'telefoon: niet zijwaarts scrollen op 402 px', `${wide}px`);
  await shot(pp, 'gratis-4-telefoon');
  await phone.close();
} catch (e) {
  fail(e.stack || e.message);
} finally {
  await browser.close();
  await app.close();
  ollama.close();
  for (const d of [dir, home]) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* left in the temp folder */
    }
  }
}
if (failed.length) fail('mislukte verzoeken:\n  ' + failed.join('\n  '));
if (errors.length) fail('console-fouten:\n  ' + errors.join('\n  '));
console.log(failures.length ? `GRATIS MODELLEN MISLUKT: ${failures.length} bevinding(en)` : 'GRATIS MODELLEN GESLAAGD');
