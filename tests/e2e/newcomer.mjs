// Newcomer test (TeamBot 0.4, package A): someone who never saw TeamBot makes a first bot and gets an answer, without a
// manual, in under 2 minutes. Fresh temporary data folder and an empty HOME/APPDATA/PATH, so nothing of this PC is
// found, used or changed; the only AI is the test engine, which says it is "found on this PC" and needs no key (like
// Ollama would). Counts the clicks and seconds from the first screen to the first answer.
// Then the one task board (#/tasks) with a task from each place bots keep tasks, live updates and moving cards, the
// old link Groepen › Takenbord, and phone width without sideways scrolling. No console errors.
// Teams (A3): with one team nothing about teams is in view; a second team made in Instellingen › Teams brings the team
// switcher, and a new bot made while that team is chosen lands in it.
// TeamBot 0.4.2 ("simpeler"): the first screen offers three ways in (Claude or ChatGPT subscription, an API key, free),
// each in at most 2 clicks to a ready first bot (0.4.5: own werkplek and browser, the three questions optional behind
// "Aanpassen", last step "Koppel je telefoon"), with one main button and no jargon; the first-run desktop counts its
// sidebar places (at most 6) and settings rows (one list: at most 7 rows you set yourself, then "Van je bots", and last
// the one row "Meer mogelijkheden"; no Geavanceerd). Besides the free engine found here, two more fresh
// installs: an API key pasted into one field (recognised as Anthropic, checked, stored encrypted) and a Claude
// subscription whose vendor program is on this PC but not logged in (one click "Inloggen"; the login in the vendor's own
// window is simulated by the test program, the terminal itself is never opened).
// The first bot starts empty: only the name Assistent, with name and role in view to change right there (no extra
// step), no fixed role, task or instructions; the line under its werkplek follows its access level (also on the bot
// page). Last, the first screen as real PCs have it: nothing installed, Claude Code, Ollama (a stand-in), an OpenBot
// installation and their mixes; each with exactly one main button, and a clear "Installeren" where a program is missing.
// Usage: npm run build:ui && npm run newcomer:check   (TEAMBOT_E2E_SHOTS=<dir> for screenshots)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'cli-agents-fake-claude.mjs');

const step = (s) => console.log(`• ${s}`);
const fail = (s) => {
  console.error(`✗ ${s}`);
  process.exitCode = 1;
};
const SHOTS = process.env.TEAMBOT_E2E_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const shot = async (page, name) => SHOTS && (await page.waitForTimeout(300), await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }));
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
/** WCAG 2.x A/AA (axe-core) on what is on screen now; violations fail the run. */
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const axe = async (page, where) => {
  // New cards and rows fade in (.tb-in, 160 ms): measure the colours once they stand still.
  await page.waitForTimeout(250);
  await page.addScriptTag({ content: axeSource });
  const v = await page.evaluate(async () => {
    // @ts-ignore
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
    return r.violations.map((x) => `${x.id}: ${x.nodes.slice(0, 2).map((n) => `${n.target.join(' ')}${n.any?.[0]?.message ? ` (${n.any[0].message})` : ''}`).join(', ')}`);
  });
  if (v.length) fail(`a11y ${where}: ${v.join(' | ')}`);
};
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) return fail(`time-out: ${what}`), false;
    await new Promise((r) => setTimeout(r, 100));
  }
};

/** Words a normal person should not meet on the first screen or in the list of settings. */
const JARGON = /\b(tailscale|poort|port|cli|mcp|providers?|engines?|tokens?|localhost|127\.0\.0\.1|connectors?)\b/i;

/** The main buttons on screen, by what they say to a screen reader (aria-label) or on the button itself. */
const mainButtons = (page) => page.locator('#inhoud button.bg-btn').evaluateAll((els) => els.filter((e) => e.offsetWidth || e.offsetHeight).map((e) => (e.getAttribute('aria-label') || e.innerText).trim()));

/** The first screen: three plain ways in, exactly one main button (`primaryText`), no ports, Tailscale or jargon. */
const welcomeChecks = async (page, primaryText) => {
  const main = page.locator('#inhoud');
  // The subscription card has looked on this PC (it decides which button is the main one).
  await main.getByTestId('start-claude-code').waitFor({ timeout: 20000 });
  for (const h of ['Ik heb Claude of ChatGPT', 'Ik heb een API-sleutel', 'Gratis beginnen']) if (!(await main.getByRole('heading', { name: h }).count())) fail(`welkom: "${h}" ontbreekt`);
  // Everything this PC has is looked at (subscriptions, engines, OpenBot): the one main button settles on what fits.
  const one = async () => {
    const b = await mainButtons(page);
    return b.length === 1 && b[0].includes(primaryText);
  };
  for (let end = Date.now() + 15000; !(await one()) && Date.now() < end; ) await page.waitForTimeout(150);
  await page.waitForTimeout(600);
  const primary = await mainButtons(page);
  if (primary.length !== 1 || !primary[0].includes(primaryText)) fail(`welkom: ${primary.length} hoofdknoppen (${primary.join(' | ')}), verwacht één: ${primaryText}`);
  const text = (await main.innerText()).replace(/\s+/g, ' ');
  const bad = text.match(new RegExp(JARGON.source, 'gi'));
  if (bad) fail(`welkom: vakjargon op het eerste scherm: ${[...new Set(bad)].join(', ')}`);
};

/** First-run desktop: the places in the sidebar (bots not counted) and the settings groups and rows. */
const countCalm = async (page) => {
  const side = page.getByRole('navigation', { name: 'Hoofdmenu' });
  const r = await side.evaluate((nav) => {
    const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const own = (el) => !el.closest('[aria-label="Bots en groepen"], [aria-label="Vastgezette bots"]');
    const links = [...nav.querySelectorAll('a[href^="#/"]')].filter(vis).filter(own).map((a) => (a.getAttribute('aria-label') || a.textContent || '').trim().replace(/\s+/g, ' '));
    const controls = [...nav.querySelectorAll('a, button, input')].filter(vis).filter(own).length;
    return { links, controls };
  });
  await page.evaluate(() => (location.hash = '#/settings'));
  const nav = page.getByRole('navigation', { name: 'Instellingen' });
  await nav.waitFor({ timeout: 10000 });
  await page.waitForTimeout(300);
  const groups = await nav.getByRole('heading').allInnerTexts();
  const rows = (await nav.locator('a').allInnerTexts()).map((x) => x.trim());
  // The second part of the list, under one small title: what the bots have (not settings you choose).
  const botRows = (await nav.getByRole('group', { name: 'Van je bots' }).locator('a').allInnerTexts().catch(() => [])).map((x) => x.trim());
  return { links: r.links.length, linkNames: r.links, controls: r.controls, groups: groups.length, groupNames: groups, rows: rows.length, rowNames: rows, botRows, jargon: rows.filter((x) => JARGON.test(x)) };
};

// The browser starts first (it needs this PC's normal environment), then TeamBot gets an empty one.
const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-newcomer-home-'));
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  XDG_DATA_HOME: path.join(home, 'xdg', 'data'),
  XDG_CONFIG_HOME: path.join(home, 'xdg', 'config'),
  XDG_CACHE_HOME: path.join(home, 'xdg', 'cache'),
  // The Documents folder (team folder, werkplekken) is the empty home's too, whatever the shell running this had set.
  XDG_DOCUMENTS_DIR: path.join(home, 'Documents'),
  PATH: path.dirname(process.execPath),
});
delete process.env.Path;

const { createApp } = await import('./server.mjs');
// "Installeren" for Ollama never runs the real installer here: a stand-in plan that the test sets where it clicks it
// (`standIn.plan`; null elsewhere, so a click there only gets the plain refusal).
const { modules } = await import('../../server/modules/index.ts');
const { createLocalModelsModule } = await import('../../server/modules/local-models/index.ts');
const standIn = { plan: null };
const mods = modules.map((m) => (m.id === 'local-models' ? createLocalModelsModule({ installPlan: () => standIn.plan, installWaitMs: 3000 }) : m));
const { mockAdapter } = await import('../helpers.ts');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-newcomer-'));
const app = await createApp({ dataDir: dir, port: Number(process.env.TEAMBOT_E2E_PORT) || 0, host: '127.0.0.1', mode: 'desktop', quiet: true, modules: mods });
const token = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();
// Nothing on this PC is ever found (no real Claude Code, Codex, OpenCode or Ollama): only the test engine.
for (const k of app.ctx.providers.kinds.values()) if (k.detect) k.detect = async () => ({ installed: false, detail: 'e2e' });
// Local servers are asked over HTTP too (the local-models card, package Q): point them at a closed port, so an Ollama or
// LM Studio that runs on this PC is not found (and not touched) either.
for (const k of app.ctx.providers.kinds.values()) if (typeof k.baseUrl === 'string' && /\/\/(127\.0\.0\.1|localhost)[:/]/.test(k.baseUrl)) k.baseUrl = 'http://127.0.0.1:9/v1';
const script = [];
const requests = [];
app.ctx.providers.registerKind({
  id: 'mock',
  label: 'Testmodel',
  type: 'api',
  group: 'local',
  billing: 'local',
  needsKey: false,
  description: 'e2e',
  models: ['mock-1'],
  defaultModel: 'mock-1',
  detect: async () => ({ installed: true, detail: 'e2e' }),
  create: () => mockAdapter(script, requests),
});
const api = async (method, p, body) => {
  const r = await fetch(app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status}: ${j.error}`);
  return j;
};
step(`TeamBot op ${app.url} (lege datamap ${dir})`);

const errors = [];
const watch = (page) => {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED/.test(m.text()) && errors.push(m.text()));
  page.on('dialog', (d) => (errors.push(`onverwacht browserdialoog: ${d.message()}`), d.dismiss().catch(() => {})));
};

// ---------------------------------------------------------------- more fresh installs (section 5)
const extra = [];
const extraDirs = [];

/** Another fresh install in its own temporary folder: nothing found on this PC, `prepare` adds what the path needs. */
async function freshStart(name, prepare) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `tb-newcomer-${name}-`));
  extraDirs.push(d);
  const a = await createApp({ dataDir: d, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true, modules: mods });
  extra.push(a);
  const tok = a.ctx.auth.ensureLocalOwner();
  const own = a.ctx.auth.owner();
  for (const k of a.ctx.providers.kinds.values()) if (k.detect) k.detect = async () => ({ installed: false, detail: 'e2e' });
  for (const k of a.ctx.providers.kinds.values()) if (typeof k.baseUrl === 'string' && /\/\/(127\.0\.0\.1|localhost)[:/]/.test(k.baseUrl)) k.baseUrl = 'http://127.0.0.1:9/v1';
  const s = { a, tok, own, dir: d, script: [], requests: [] };
  await prepare?.(s);
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 880 }, locale: 'nl-NL', bypassCSP: true });
  const page = await ctx.newPage();
  watch(page);
  const counter = { clicks: 0 };
  const click = async (loc) => (counter.clicks++, await loc.click());
  return { ...s, ctx, page, counter, click };
}

/**
 * From the ready first bot to the first answer (0.4.5, like OpenBot): right after connecting the AI the bot is there,
 * with "Aanpassen" for the three questions; "Begin met praten", the last step "Koppel je telefoon" (here: Later), chat.
 */
async function readyToAnswer(s, { kind, answer, t0, label, rename }) {
  const { page } = s;
  await page.waitForURL(/#\/start/, { timeout: 30000 });
  const ready = page.getByTestId('first-bot-ready');
  await ready.waitFor({ timeout: 20000 });
  const toReady = s.counter.clicks;
  if (!(await ready.getByRole('button', { name: 'Aanpassen' }).count())) fail(`${label}: geen "Aanpassen" bij de klaargezette bot`);
  const bot = s.a.ctx.store.agents(s.own.id)[0];
  if (s.a.ctx.providers.config(bot?.provider_id)?.kind !== kind) fail(`${label}: de klaargezette bot gebruikt niet de gekoppelde AI (${kind})`);
  // Another name, typed right on this screen, and straight on: no extra step to save it.
  if (rename) {
    const field = ready.getByTestId('first-bot-name-role').getByLabel('Naam', { exact: true });
    if (await field.count()) await s.click(field), await field.fill(rename);
    else fail(`${label}: de naam staat niet in beeld om te wijzigen`);
  }
  await s.click(ready.getByRole('button', { name: 'Begin met praten' }));
  const phone = page.getByTestId('first-bot-phone');
  await phone.waitFor({ timeout: 10000 });
  if (rename) {
    const now = s.a.ctx.store.agent(bot.id);
    if (now?.name !== rename || path.basename(now.workspace || '') !== rename) fail(`${label}: de naam die in beeld werd getypt is niet bewaard (${now?.name}, werkplek ${now?.workspace} met ${JSON.stringify(fs.existsSync(now?.workspace || '') ? fs.readdirSync(now.workspace) : null)})`);
  }
  if (!(await phone.getByRole('button', { name: 'Koppel je telefoon' }).count())) fail(`${label}: de laatste stap biedt "Koppel je telefoon" niet aan`);
  await s.click(phone.getByRole('button', { name: 'Later' }));
  await page.waitForURL(/#\/t\//, { timeout: 15000 });
  const box = page.getByRole('textbox', { name: 'Bericht' });
  await box.waitFor({ timeout: 10000 });
  await page.waitForTimeout(300);
  if (!(await box.evaluate((el) => el === document.activeElement))) await s.click(box);
  await page.keyboard.type('Hoi, wat kun je?');
  await page.keyboard.press('Enter');
  await page.locator('[id^="m-"]').getByText(answer).first().waitFor({ timeout: 45000 });
  const secs = (Date.now() - t0) / 1000;
  console.log(`NIEUWKOMER (${label}): ${toReady} ${toReady === 1 ? 'klik' : 'klikken'} tot een klaargezette bot; in totaal ${s.counter.clicks} klikken, ${secs.toFixed(1)} s van het eerste scherm tot het eerste antwoord`);
  if (toReady > 2) fail(`${label}: ${toReady} klikken tot een klaargezette bot, doel hoogstens 2`);
  if (secs >= 120) fail(`${label}: ${secs.toFixed(1)} s, doel onder 2 minuten`);
}

/** "Ik heb een API-sleutel": one field; the key is recognised (Anthropic), checked for free and stored encrypted. */
async function keyPath() {
  const KEY = `sk-ant-api03-${'NieuwkomerSleutel'.repeat(5)}-e2eAA`;
  const used = [];
  const s = await freshStart('sleutel', (x) => {
    // Anthropic's adapter is the test engine here: no network, but it sees the key TeamBot hands it.
    x.a.ctx.providers.kind('anthropic').create = (_cfg, key) => (used.push(key), mockAdapter(x.script, x.requests));
  });
  const { page } = s;
  await page.goto(`${s.a.url}/#token=${s.tok}`);
  await page.getByText('Welkom bij TeamBot').waitFor({ timeout: 20000 });
  const t0 = Date.now();
  const field = page.getByLabel('API-sleutel');
  await field.waitFor({ timeout: 20000 });
  await welcomeChecks(page, 'Gratis starten');
  await s.click(field);
  await page.keyboard.type(KEY);
  await page.getByText('Herkend: Anthropic').waitFor({ timeout: 5000 }).catch(() => fail('sleutel: niet herkend als Anthropic'));
  await shot(page, 'nieuwkomer-10-sleutel');
  await page.keyboard.press('Enter');
  s.script.push({ text: 'Hallo! Ik beantwoord je korte vragen.' });
  await readyToAnswer(s, { kind: 'anthropic', answer: 'Hallo! Ik beantwoord je korte vragen.', t0, label: 'API-sleutel', rename: 'Noor' });
  const provs = s.a.ctx.providers.list(s.own.id);
  const p = provs.find((x) => x.kind === 'anthropic');
  if (!p?.secret_id) fail('sleutel: geen Anthropic-koppeling met een opgeslagen sleutel');
  if (!used.length || used.some((k) => k !== KEY)) fail('sleutel: de dienst kreeg niet precies de geplakte sleutel');
  // Stored encrypted: the key itself is in no file of the data folder (database, log, anything).
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name));
  };
  walk(s.dir);
  const leaks = files.filter((f) => fs.readFileSync(f).includes(KEY));
  if (leaks.length) fail(`sleutel: staat leesbaar in ${leaks.map((f) => path.relative(s.dir, f)).join(', ')}`);
  step(`API-sleutel: één veld, herkend als Anthropic, gratis getest, versleuteld bewaard (niet leesbaar in ${files.length} bestanden), daarna meteen een klaargezette bot en het antwoord`);
  await s.ctx.close();
}

/**
 * "Ik heb Claude of ChatGPT": Claude Code (the test program) is on this PC but not logged in. One click "Inloggen"
 * would open the vendor's own login window; here that request is answered by the test and the login is simulated by
 * the test program's login file. TeamBot sees the login by itself and goes on to the questions with Claude Code.
 */
async function subscriptionPath() {
  const loginFile = path.join(home, 'claude-ingelogd');
  process.env.FAKE_CLAUDE_LOGIN_FILE = loginFile;
  const s = await freshStart('abonnement', (x) => {
    // Only the test program counts as Claude Code; Codex is not here (and the owner's own programs are never looked at).
    x.a.ctx.store.setSetting(x.own.id, 'cliAgents', { paths: { 'claude-code': FAKE_CLAUDE, 'codex-cli': path.join(x.dir, 'geen-codex.exe') }, unsafe: {} });
  });
  const { page } = s;
  let terminal = 0;
  await page.route('**/api/cli-agents/claude-code/login/terminal', (r) => (terminal++, r.fulfill({ json: { ok: true } })));
  await page.goto(`${s.a.url}/#token=${s.tok}`);
  await page.getByText('Welkom bij TeamBot').waitFor({ timeout: 20000 });
  const t0 = Date.now();
  const login = page.getByRole('button', { name: 'Inloggen bij Claude' });
  await login.waitFor({ timeout: 20000 });
  await welcomeChecks(page, 'Inloggen');
  await s.click(login);
  await page.getByText('Log in in het venster van Claude').waitFor({ timeout: 5000 }).catch(() => fail('abonnement: geen uitleg na "Inloggen"'));
  await shot(page, 'nieuwkomer-11-abonnement-inloggen');
  if (terminal !== 1) fail(`abonnement: het inlogvenster van de maker werd ${terminal} keer gevraagd`);
  // The person logs in in Claude Code's own window (simulated): TeamBot notices it and goes on by itself.
  fs.writeFileSync(loginFile, 'ingelogd');
  await readyToAnswer(s, { kind: 'claude-code', answer: 'Hallo van Claude', t0, label: 'abonnement' });
  const p = s.a.ctx.providers.list(s.own.id).find((x) => x.kind === 'claude-code');
  if (!p || p.secret_id) fail('abonnement: Claude Code niet gekoppeld, of er is toch een sleutel bewaard');
  step('abonnement: Claude Code op deze pc, één klik "Inloggen" (het venster van de maker), TeamBot zet na het inloggen zelf een bot klaar; geen sleutel of token bewaard');
  delete process.env.FAKE_CLAUDE_LOGIN_FILE;
  await s.ctx.close();
}

/** A stand-in for Ollama with one small model (its own API, on a free port): TeamBot finds it as on a real PC. */
async function fakeOllama({ listen = true } = {}) {
  const http = await import('node:http');
  const model = { name: 'qwen3:1.7b', model: 'qwen3:1.7b', size: 1_359_296_000, digest: 'e2e-qwen3', details: { family: 'qwen3', parameter_size: '2.0B', quantization_level: 'Q4_K_M' } };
  const info = { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960, 'qwen3.block_count': 28, 'qwen3.attention.head_count': 16, 'qwen3.attention.head_count_kv': 8, 'qwen3.embedding_length': 2048, 'qwen3.attention.key_length': 128, 'qwen3.attention.value_length': 128 };
  const srv = http.createServer((req, res) => {
    const send = (j, status = 200) => (res.writeHead(status, { 'content-type': 'application/json' }), res.end(JSON.stringify(j)));
    const p = (req.url || '').split('?')[0];
    if (p === '/OllamaSetup.exe') return res.writeHead(200, { 'content-type': 'application/octet-stream' }), res.end(Buffer.alloc(1024));
    if (p === '/api/version') return send({ version: '0.12.6' });
    if (p === '/api/tags') return send({ models: [model] });
    if (p === '/api/ps') return send({ models: [] });
    if (p === '/api/show') return send({ capabilities: ['completion', 'tools', 'thinking'], model_info: info, details: model.details });
    if (p === '/v1/models') return send({ object: 'list', data: [{ id: model.name, object: 'model', owned_by: 'library' }] });
    send({ error: 'niet in deze test' }, 404);
  });
  // Not listening yet (`listen: false`): an Ollama that is not on this pc until the stand-in installer starts it.
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  if (!listen) await new Promise((r) => srv.close(r));
  const base = `http://127.0.0.1:${port}/v1`;
  return { base, start: () => new Promise((r) => srv.listen(port, '127.0.0.1', r)), close: () => new Promise((r) => (srv.listening ? srv.close(r) : r())) };
}

/**
 * The first screen as real PCs have it (a checker found two main buttons there): nothing installed, Claude Code,
 * Ollama, an OpenBot installation, and their mixes. Each time exactly one main button; every other way in is a quiet
 * choice with its own button, and a way in whose program is missing says "Installeren" (or "Koppelen" for a key).
 * Nothing here is installed or opened for real: Claude Code is the test program, Ollama a stand-in on a free port,
 * OpenBot an empty data file in the empty home folder of this test.
 */
async function startScreens() {
  const ollama = await fakeOllama();
  // The name on Ollama's choice is its name in TeamBot ("Ollama (lokaal)").
  const useOllama = `${app.ctx.providers.kind('ollama').label} gebruiken`;
  const obDir = path.join(home, 'AppData', 'Roaming', 'OpenBot');
  const situation = async (name, { claude, local, openbot }, check) => {
    if (openbot) fs.mkdirSync(obDir, { recursive: true }), fs.writeFileSync(path.join(obDir, 'openbot.db'), '');
    const s = await freshStart(`start-${name}`, (x) => {
      // Claude Code (logged in) is the test program; Codex is never here. Without Claude: neither is.
      x.a.ctx.store.setSetting(x.own.id, 'cliAgents', { paths: { 'claude-code': claude ? FAKE_CLAUDE : path.join(x.dir, 'geen-claude.exe'), 'codex-cli': path.join(x.dir, 'geen-codex.exe') }, unsafe: {} });
      if (local) Object.assign(x.a.ctx.providers.kind('ollama'), { baseUrl: ollama.base, detect: async () => ({ installed: true, version: '0.12.6', detail: 'e2e', baseUrl: ollama.base }) });
    });
    try {
      // Never the real download page of Ollama.
      await s.ctx.route('https://ollama.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<title>Ollama</title>' }));
      // TeamBot keeps what it found on this pc for a few seconds (server/api/providers.ts): with Ollama here, open the
      // first screen once a fresh look finds it, as it would on a pc where it has been running all along.
      if (local) {
        const sees = async () => ((await (await fetch(`${s.a.url}/api/provider-kinds?detect=1`, { headers: { authorization: `Bearer ${s.tok}` } })).json()) || []).some((k) => k.id === 'ollama' && k.status?.installed);
        await until(sees, 30000, `${name}: TeamBot vindt de stand-in van Ollama niet`);
      }
      await s.page.goto(`${s.a.url}/#token=${s.tok}`);
      await s.page.getByText('Welkom bij TeamBot').waitFor({ timeout: 20000 });
      await check(s);
      await shot(s.page, `nieuwkomer-start-${name}`);
    } finally {
      await s.ctx.close();
      fs.rmSync(obDir, { recursive: true, force: true });
    }
  };
  const main = (s) => s.page.locator('#inhoud');
  const quiet = async (s, name, where) => {
    const b = main(s).getByRole('button', { name, exact: true });
    if (!(await b.count())) return fail(`${where}: geen knop "${name}"`);
    if (/\bbg-btn\b/.test((await b.first().getAttribute('class')) || '')) fail(`${where}: "${name}" is een tweede hoofdknop`);
  };
  const openbotOffer = (s) => main(s).getByRole('button', { name: 'Bekijken wat er overkomt' }).waitFor({ timeout: 15000 }).catch(() => fail('OpenBot op de pc: het aanbod om over te zetten ontbreekt'));
  const localCard = async (s, where) => {
    // The card with the local models: its advice is a quiet button here.
    await main(s).getByTestId('local-models-advice').waitFor({ timeout: 30000 }).catch(() => fail(`${where}: geen advies over lokale modellen`));
    await quiet(s, 'Gebruik voor nieuwe bots', where);
  };
  // Without Ollama first (TeamBot keeps what it found on this PC for a few seconds); then nothing at all, where Ollama
  // gets installed; from then on the stand-in runs, for the situations with Ollama.
  await situation('claude', { claude: true }, async (s) => {
    await welcomeChecks(s.page, 'Claude gebruiken');
    await quiet(s, 'Gratis starten', 'Claude Code');
  });
  await situation('openbot', { openbot: true }, async (s) => {
    await openbotOffer(s);
    await welcomeChecks(s.page, 'Bekijken wat er overkomt');
    await quiet(s, 'Gratis starten', 'OpenBot');
  });
  await situation('claude-openbot', { claude: true, openbot: true }, async (s) => {
    await openbotOffer(s);
    await welcomeChecks(s.page, 'Bekijken wat er overkomt');
    await quiet(s, 'Claude gebruiken', 'Claude Code en OpenBot');
  });
  await situation('niets', {}, async (s) => {
    await welcomeChecks(s.page, 'Gratis starten');
    // Every way in that misses its program says how to get it, right there.
    for (const [row, want] of [
      ['start-claude-code', /installeren/i],
      ['start-codex-cli', /installeren/i],
    ])
      if (!(await main(s).getByTestId(row).getByRole('button', { name: want }).or(main(s).getByTestId(row).getByRole('link', { name: want })).count())) fail(`niets op de pc: ${row} biedt geen Installeren`);
    await quiet(s, 'Koppelen', 'niets op de pc');
    await quiet(s, 'Ollama installeren', 'niets op de pc');
    await axe(s.page, 'welkom, niets op de pc');
    // "Installeren" installs Ollama itself, connects it, and the choice becomes "Gebruiken" without another step. Here the
    // installer is a stand-in (nothing is downloaded from ollama.com or installed on this pc): it starts an Ollama that
    // was not there before.
    const later = await fakeOllama({ listen: false });
    const kind = s.a.ctx.providers.kind('ollama');
    kind.baseUrl = later.base;
    const did = [];
    standIn.plan = {
      url: ollama.base.replace(/\/v1$/, '/OllamaSetup.exe'),
      file: 'OllamaSetup.exe',
      verify: async () => (did.push('verify'), true),
      install: async () => {
        did.push('install');
        await later.start();
        kind.detect = async () => ({ installed: true, version: '0.12.6', detail: 'e2e', baseUrl: later.base });
      },
      start: async () => void did.push('start'),
    };
    await main(s).getByRole('button', { name: 'Ollama installeren' }).click();
    await main(s).getByRole('button', { name: useOllama }).waitFor({ timeout: 45000 }).catch(() => fail('niets op de pc: Ollama geïnstalleerd, maar de keuze werd niet vanzelf "Gebruiken"'));
    if (did.join(',') !== 'verify,install') fail(`niets op de pc: de installatie liep niet zoals verwacht (${did.join(', ')})`);
    await welcomeChecks(s.page, useOllama);
    standIn.plan = null;
    await later.close();
    step('eerste scherm, niets op de pc: één hoofdknop (Gratis starten); Claude en ChatGPT met Installeren, een sleutel met Koppelen, Ollama met Installeren; Installeren zet Ollama klaar en koppelt het (hier een stand-in), en de keuze wordt vanzelf "Ollama gebruiken"');
  });
  await situation('ollama', { local: true }, async (s) => {
    await welcomeChecks(s.page, useOllama);
    await localCard(s, 'Ollama');
    await quiet(s, 'Gratis starten', 'Ollama');
    await welcomeChecks(s.page, useOllama);
  });
  await situation('claude-ollama', { claude: true, local: true }, async (s) => {
    await localCard(s, 'Claude Code en Ollama');
    await welcomeChecks(s.page, 'Claude gebruiken');
    await quiet(s, useOllama, 'Claude Code en Ollama');
  });
  await situation('ollama-openbot', { local: true, openbot: true }, async (s) => {
    await openbotOffer(s);
    await localCard(s, 'Ollama en OpenBot');
    await welcomeChecks(s.page, 'Bekijken wat er overkomt');
    await quiet(s, useOllama, 'Ollama en OpenBot');
  });
  await situation('alles', { claude: true, local: true, openbot: true }, async (s) => {
    await openbotOffer(s);
    await localCard(s, 'alles');
    await welcomeChecks(s.page, 'Bekijken wat er overkomt');
    for (const b of ['Claude gebruiken', useOllama, 'Gratis starten', 'Koppelen']) await quiet(s, b, 'alles op de pc');
    await axe(s.page, 'welkom, alles op de pc');
    await shot(s.page, 'nieuwkomer-start-alles-openbot');
    // "Niet nu" on the OpenBot offer: the main button goes to the best AI.
    await main(s).getByRole('button', { name: 'Niet nu' }).click();
    await welcomeChecks(s.page, 'Claude gebruiken');
  });
  await ollama.close();
  step('eerste scherm op echte pc\'s: één hoofdknop bij Claude Code, Ollama, OpenBot en elke combinatie (OpenBot overzetten gaat voor; "Niet nu" geeft de hoofdknop aan Claude); de rest zijn rustige keuzes met hun eigen knop');
}

try {
  // ---------------------------------------------------------------- 0. empty: nothing installed before the owner chooses
  const empty = await Promise.all(['/agents', '/rooms', '/rooms/teams', '/skills', '/routines', '/rooms/tasks', '/teamdata/tasks', '/providers'].map(async (p) => [p, (await api('GET', p)).length]));
  const notEmpty = empty.filter(([, n]) => n);
  if (notEmpty.length) fail(`nieuwe installatie is niet leeg: ${notEmpty.map(([p, n]) => `${p} ${n}`).join(', ')}`);
  else step('nieuwe installatie is leeg: geen bots, groepen, teams, skills, routines, taken of gekoppelde AI');

  // Phone first (no clicks counted): the welcome fits at 390 px.
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'nl-NL', bypassCSP: true });
  const ph = await phoneCtx.newPage();
  watch(ph);
  await ph.goto(`${app.url}/#token=${token}`);
  await ph.getByText('Welkom bij TeamBot').waitFor({ timeout: 20000 });
  await ph.getByRole('button', { name: 'Testmodel gebruiken' }).waitFor({ timeout: 20000 });
  if ((await overflow(ph)) > 1) fail('telefoon: welkomstscherm schuift opzij');
  await axe(ph, 'welkom (telefoon)');
  await shot(ph, 'nieuwkomer-0-welkom-telefoon');
  // Straight to "Nieuwe bot" (not via the welcome): the AI found here is offered, and connected only on "Bot aanmaken".
  await ph.goto(`${app.url}/#/agents/new`);
  // One quiet line says which AI the bot gets; the choice itself is under "Meer opties".
  await ph.getByTestId('new-bot-engine').getByText(/Testmodel/).waitFor({ timeout: 15000 }).catch(() => fail('nieuwe bot zonder koppeling: de gevonden AI wordt niet genoemd'));
  await ph.getByTestId('new-bot-engine').getByRole('button', { name: 'Wijzigen' }).click();
  const found = ph.getByRole('radio', { name: /Testmodel.*gevonden op deze pc/ });
  await found.waitFor({ timeout: 15000 }).catch(() => fail('nieuwe bot zonder koppeling: de gevonden AI wordt niet aangeboden'));
  if (!(await found.isChecked().catch(() => false))) fail('nieuwe bot zonder koppeling: de gevonden AI is niet voorgesteld');
  if ((await overflow(ph)) > 1) fail('telefoon: Nieuwe bot schuift opzij');
  if ((await api('GET', '/providers')).length) fail('nieuwe bot: kijken koppelde al iets, zonder dat de gebruiker iets koos');
  await ph.close();

  // ---------------------------------------------------------------- 1. the newcomer: first screen → first answer
  const ctxb = await browser.newContext({ viewport: { width: 1360, height: 880 }, locale: 'nl-NL', bypassCSP: true });
  const page = await ctxb.newPage();
  watch(page);
  let clicks = 0;
  let typed = 0;
  const click = async (loc) => (clicks++, await loc.click());
  const type = async (loc, text) => {
    // A field that does not have the focus yet costs a click, as it does for a person.
    if (!(await loc.evaluate((el) => el === document.activeElement))) await click(loc);
    typed++;
    await page.keyboard.type(text);
  };

  await page.goto(`${app.url}/#token=${token}`);
  await page.getByText('Welkom bij TeamBot').waitFor({ timeout: 20000 });
  // The clock runs from the first screen (also while TeamBot looks for AI on this PC) to the first answer.
  const t0 = Date.now();
  const main = page.locator('#inhoud');
  const go = main.getByRole('button', { name: 'Testmodel gebruiken' });
  await go.waitFor({ timeout: 20000 });
  await welcomeChecks(page, 'Testmodel gebruiken');
  if (!(await main.getByText('Testmodel', { exact: true }).count())) fail('welkom: de gevonden AI (Testmodel) staat er niet bij');
  if (!(await main.getByText('gratis, draait op deze pc').count())) fail('welkom: niet gezegd wat de gevonden AI kost');
  await shot(page, 'nieuwkomer-1-welkom');
  step('welkom: drie manieren om te beginnen (abonnement, API-sleutel, gratis), één hoofdknop: Testmodel gebruiken');

  // A calm desktop on the first run: few places in the sidebar, a short list of plain settings groups.
  const calm = await countCalm(page);
  console.log(`RUSTIG: zijbalk ${calm.links} plekken (${calm.linkNames.join(', ')}), ${calm.controls} knoppen en velden; instellingen ${calm.groups} groepen, ${calm.rows} regels (${calm.rowNames.join(', ')})`);
  if (calm.links > 6) fail(`zijbalk: ${calm.links} plekken, doel hoogstens 6 (${calm.linkNames.join(', ')})`);
  // "Het moet cleaner": one list where each row opens one thing. First what you set yourself (at most 7 rows), then
  // under the one small title "Van je bots" what your bots have, and last the ONE row for everything optional.
  if (calm.groups) fail(`instellingen: ${calm.groups} groepstitels (${calm.groupNames.join(', ')}), doel geen`);
  const ownRows = calm.rows - calm.botRows.length - 1;
  if (ownRows > 7) fail(`instellingen: ${ownRows} regels om zelf in te stellen, doel hoogstens 7 (${calm.rowNames.join(', ')})`);
  if (!calm.botRows.length || calm.botRows.length > 6) fail(`instellingen: "Van je bots" heeft ${calm.botRows.length} regels, verwacht 1 tot 6 (${calm.botRows.join(', ')})`);
  if (calm.rowNames.includes('Geavanceerd')) fail('instellingen: de oude regel Geavanceerd staat er nog');
  // Meer mogelijkheden is the ONE place for everything optional: exactly once, and last.
  if (calm.rowNames.filter((r) => r === 'Meer mogelijkheden').length !== 1 || calm.rowNames.at(-1) !== 'Meer mogelijkheden') fail(`instellingen: Meer mogelijkheden hoort precies één keer onderaan te staan (${calm.rowNames.join(', ')})`);
  if (calm.jargon.length) fail(`instellingen: vakjargon in de lijst: ${calm.jargon.join(', ')}`);
  await page.goto(`${app.url}/#/`);
  await go.waitFor({ timeout: 20000 });

  await click(go);
  // 0.4.5 (like OpenBot): right after connecting the AI a first bot is ready, with its own werkplek and browser.
  await page.waitForURL(/#\/start/, { timeout: 15000 });
  const ready = page.getByTestId('first-bot-ready');
  await ready.waitFor({ timeout: 20000 });
  const toQuestions = clicks;
  if (!(await ready.getByRole('heading', { name: 'Assistent staat klaar' }).count())) fail(`eerste bot: niet "Assistent staat klaar" (${(await ready.innerText()).slice(0, 120)})`);
  const desk = page.getByTestId('bot-workplace');
  const deskText = (await desk.innerText().catch(() => '')).replace(/\s+/g, ' ');
  if (!/Werkplek:/.test(deskText) || !deskText.includes(path.join('TeamBot', 'Teammap', 'Assistent'))) fail(`eerste bot: geen werkplek onder de teammap getoond (${deskText})`);
  if (!(await ready.getByText('Eigen browser:').count())) fail('eerste bot: de eigen browser wordt niet genoemd');
  // The bot starts on "Volledige toegang": the line under its werkplek says what that means, never "asks first".
  if (/vraagt de bot eerst toestemming/.test(deskText) || !/hele computer, zonder te vragen/.test(deskText)) fail(`eerste bot: de regel bij de werkplek past niet bij Volledige toegang (${deskText})`);
  // Name and role in view right away, to change without an extra step; the bot starts empty (no role, task or rules).
  const nameRole = ready.getByTestId('first-bot-name-role');
  const inlineName = nameRole.getByLabel('Naam', { exact: true });
  const inlineRole = nameRole.getByLabel('Rol (mag leeg blijven)');
  if ((await inlineName.inputValue().catch(() => '')) !== 'Assistent' || (await inlineRole.inputValue().catch(() => 'x')) !== '') fail('eerste bot: naam (Assistent) en een lege rol staan niet meteen in beeld');
  const first = app.ctx.store.agents(owner.id)[0];
  if (first?.role || first?.description || first?.instructions) fail(`eerste bot: begint niet leeg (rol "${first?.role}", taak "${first?.description}", instructies "${first?.instructions}")`);
  await axe(page, 'eerste bot klaar');
  await shot(page, 'nieuwkomer-2-bot-klaar');
  step(`eerste bot: na ${toQuestions} klik meteen klaar (Assistent, rol leeg, geen vaste instructies), naam en rol meteen te wijzigen, met een eigen werkplek (${deskText.replace(/^.*Werkplek: /, '').slice(0, 80)}) en een eigen browser`);
  // The role typed right there is saved without a button (leaving the field, or going on).
  if (await inlineRole.count()) await type(inlineRole, 'Webshophulp');
  // The three questions are optional: "Aanpassen".
  await click(ready.getByRole('button', { name: 'Aanpassen' }));
  const q = page.getByTestId('first-bot-edit');
  await q.waitFor({ timeout: 10000 });
  const name = q.getByLabel('Hoe heet je bot?');
  const what = q.getByLabel('Wat doet hij?');
  const engine = q.getByRole('radio', { name: /Testmodel/ });
  await until(async () => (await engine.count()) && (await engine.isChecked()), 10000, 'het gevonden model is niet voorgesteld');
  // Exactly the three questions.
  const asked = await q.locator('label[data-i18n="label"], legend').allInnerTexts();
  if (asked.join(' | ') !== 'Hoe heet je bot? | Wat doet hij? | Welk model gebruikt hij?') fail(`aanpassen: vragen zijn ${JSON.stringify(asked)}`);
  if (await page.getByLabel('Instructies').count()) fail('aanpassen: instructies zichtbaar');
  await shot(page, 'nieuwkomer-3-aanpassen');
  step('aanpassen (optioneel): de drie vragen (naam, wat hij doet, welk model: Testmodel voorgesteld)');

  await click(name);
  await name.fill('Mila');
  typed++;
  await click(what);
  await what.fill('Helpt me met korte vragen over mijn webshop.');
  typed++;
  await click(q.getByRole('button', { name: 'Opslaan' }));
  await ready.getByRole('heading', { name: 'Mila staat klaar' }).waitFor({ timeout: 10000 });
  await until(async () => (await desk.innerText().catch(() => '')).includes(path.join('Teammap', 'Mila')), 5000, 'aanpassen: de lege werkplek kreeg de nieuwe naam niet');
  await click(ready.getByRole('button', { name: 'Begin met praten' }));
  const phoneStep = page.getByTestId('first-bot-phone');
  await phoneStep.waitFor({ timeout: 10000 });
  if (!(await phoneStep.getByRole('heading', { name: 'Koppel je telefoon' }).count()) || !(await phoneStep.getByRole('button', { name: 'Koppel je telefoon' }).count())) fail('laatste stap: "Koppel je telefoon" ontbreekt');
  await axe(page, 'koppel je telefoon');
  await shot(page, 'nieuwkomer-4-koppel-je-telefoon');
  await click(phoneStep.getByRole('button', { name: 'Later' }));
  await page.waitForURL(/#\/t\//, { timeout: 15000 });
  const box = page.getByRole('textbox', { name: 'Bericht' });
  await box.waitFor({ timeout: 10000 });
  await page.waitForTimeout(300); // the thread finishes loading; the composer is not re-mounted while typing
  script.push({ text: 'Ik help je graag met je webshop. Waar wil je beginnen?' });
  await type(box, 'Hoi Mila, wat kun je voor me doen?');
  await page.keyboard.press('Enter');
  await page.locator('[id^="m-"]').getByText('Ik help je graag met je webshop. Waar wil je beginnen?').waitFor({ timeout: 30000 });
  const secs = (Date.now() - t0) / 1000;
  await shot(page, 'nieuwkomer-3-eerste-antwoord');
  console.log(`NIEUWKOMER (gratis, gevonden op deze pc): ${toQuestions} klik tot een klaargezette bot; in totaal ${clicks} klikken (met Aanpassen), ${typed} velden getypt, ${secs.toFixed(1)} s van het eerste scherm tot het eerste antwoord`);
  if (toQuestions > 2) fail(`nieuwkomer: ${toQuestions} klikken tot een klaargezette bot, doel hoogstens 2`);
  if (secs >= 120) fail(`nieuwkomer: ${secs.toFixed(1)} s, doel onder 2 minuten`);

  const mila = app.ctx.store.agents(owner.id).find((a) => a.name === 'Mila');
  const prov = mila && app.ctx.providers.config(mila.provider_id);
  if (!mila) fail('nieuwkomer: bot Mila niet aangemaakt');
  else {
    if (mila.description !== 'Helpt me met korte vragen over mijn webshop.') fail(`nieuwkomer: wat de bot doet is niet bewaard (${mila.description})`);
    if (prov?.kind !== 'mock') fail(`nieuwkomer: bot gebruikt ${prov?.kind}, niet het gevonden Testmodel`);
    if (mila.access_mode !== 'full') fail(`nieuwkomer: toegang ${mila.access_mode}, verwacht "Volledige toegang"`);
    if (mila.role !== 'Webshophulp') fail(`nieuwkomer: de rol die in beeld werd getypt is niet bewaard (${mila.role})`);
    // Instructions are the owner's own text (empty here); how every bot works is TeamBot's base prompt.
    if (mila.instructions) fail(`nieuwkomer: instructies die de eigenaar niet schreef (${mila.instructions})`);
    if (!/verzin geen resultaat/.test(requests.at(-1)?.system || '')) fail('nieuwkomer: de werkregels van TeamBot ontbreken in wat de bot leest');
    if (!requests.at(-1)?.system?.includes('Helpt me met korte vragen over mijn webshop.')) fail('nieuwkomer: de bot kreeg zijn taak niet mee');
    // its own computer, right away: a werkplek under the team folder (made by the first run) and its own browser. This
    // run has its own data folder, so its Teammap lies in it (modules/folders documentsFor), never in Documents.
    const teamFolder = path.join(dir, 'Documents', 'TeamBot', 'Teammap');
    if (path.resolve(mila.workspace) !== path.resolve(teamFolder, 'Mila') || !fs.existsSync(mila.workspace)) fail(`nieuwkomer: werkplek is ${mila.workspace}, verwacht ${path.join(teamFolder, 'Mila')}`);
    if (fs.existsSync(path.join(teamFolder, 'Assistent'))) fail('nieuwkomer: de oude, lege werkplek Assistent bleef achter');
    if (!['files', 'shell', 'browser'].every((g) => mila.tool_groups.includes(g))) fail(`nieuwkomer: bot mist bestanden, terminal of browser (${mila.tool_groups.join(', ')})`);
    // "Volledige toegang" on the owner's own Windows pc is the whole computer (mode host: its own browser and the
    // desktop); elsewhere its own browser. Both give the bot its own browser.
    const comp = await api('GET', `/computers/${mila.id}`);
    if (!['browser', 'host'].includes(comp.config.mode)) fail(`nieuwkomer: computermodus ${comp.config.mode}, verwacht een eigen browser`);
  }
  step('de bot kent zijn taak, gebruikt het gevonden model, start op Volledige toegang (de eigenaar zelf; verzenden, betalen en wat niet terug kan vraagt hij altijd) en heeft een eigen werkplek en browser');

  // The last step's "Koppel je telefoon" opens the phone card with the QR code (Instellingen › Telefoon).
  await page.goto(`${app.url}/#/start`);
  await page.getByTestId('first-bot-ready').getByRole('button', { name: 'Begin met praten' }).click();
  await page.getByTestId('first-bot-phone').getByRole('button', { name: 'Koppel je telefoon' }).click();
  await page.waitForURL(/#\/settings\/mobile-telefoon/, { timeout: 10000 }).catch(() => fail('"Koppel je telefoon" opent de telefoonkaart niet'));
  if ((await api('GET', '/agents')).length !== 1) fail('terug naar de eerste stap maakte een tweede bot');
  step('"Koppel je telefoon" opent de telefoonkaart (Instellingen › Telefoon); terugkomen maakt geen tweede bot');

  // One team: it exists (Mila's), but nothing about teams is in view.
  const firstTeams = await api('GET', '/teams');
  if (firstTeams.length !== 1 || firstTeams[0].name !== 'Mijn team' || !firstTeams[0].bots.some((b) => b.name === 'Mila')) fail(`één team: verwacht Mijn team met Mila (${JSON.stringify(firstTeams.map((t) => [t.name, t.bots.map((b) => b.name)]))})`);
  if (await page.getByTestId('team-switcher').count()) fail('één team: de teamkiezer staat in beeld');
  step('één team (Mijn team, vanzelf gemaakt) en geen teamkiezer in beeld');

  // ---------------------------------------------------------------- 2. one task board (#/tasks)
  const own = await api('POST', '/rooms/tasks', { title: 'Offerte opvragen', ownerType: 'agent', ownerId: mila.id, status: 'doing' });
  await app.ctx.services.teamdata.write(owner.id, [{ sql: 'INSERT INTO taken (titel, eigenaar, aangevraagd_door, site, status, resultaat, bewijs) VALUES (?, ?, ?, ?, ?, ?, ?)', params: ['Bing opschonen', 'Mila', 'Mila', 'voorbeeld.nl', 'wacht_op_eigenaar', 'Onderzocht; besluit nodig.', 'https://example.com/bewijs'] }]);
  // From the sidebar once it has "Taken" (package A1), else by its link.
  const tasksLink = page.locator('a[href="#/tasks"]');
  if (await tasksLink.count()) await tasksLink.first().click();
  else await page.goto(`${app.url}/#/tasks`);
  await page.waitForURL(/#\/tasks/, { timeout: 5000 });
  await page.getByRole('heading', { name: 'Taken', exact: true }).waitFor({ timeout: 10000 });
  const region = (label) => page.getByRole('region', { name: new RegExp(`^${label}: `) });
  for (const c of ['Te doen', 'Bezig', 'Te controleren', 'Klaar', 'Geblokkeerd']) if (!(await region(c).count())) fail(`takenbord: kolom ${c} ontbreekt`);
  await region('Bezig').getByText('Offerte opvragen').waitFor({ timeout: 8000 }).catch(() => fail('takenbord: taak van het bord niet in "Bezig"'));
  await region('Te controleren').getByText('Bing opschonen').waitFor({ timeout: 8000 }).catch(() => fail('takenbord: taak uit de teamdatabase niet in "Te controleren"'));
  if (!(await region('Te controleren').getByText('Wacht op jou').count())) fail('takenbord: "Wacht op jou" ontbreekt bij een taak die op de eigenaar wacht');
  if (await page.getByTestId('team-filter-note').count()) fail('één team: het takenbord noemt een team');
  await axe(page, 'takenbord');
  await shot(page, 'nieuwkomer-4-takenbord');
  step('takenbord: vijf kolommen; een taak van het bord en een uit de teamdatabase staan elk in hun kolom');

  // Live: a bot adds a task while the board is open.
  await api('POST', '/rooms/tasks', { title: 'Productfoto’s nalopen', ownerType: 'agent', ownerId: mila.id });
  await region('Te doen').getByText('Productfoto’s nalopen').waitFor({ timeout: 8000 }).catch(() => fail('takenbord: nieuwe taak niet live zichtbaar'));
  // Moving cards writes the right status in each place.
  // Through the "⋯" menu of the card (dragging it to another column does the same).
  const moveTo = async (title, column) => {
    await page.getByRole('button', { name: `Acties voor ${title}` }).click();
    await page.getByRole('menuitemradio', { name: column }).click();
  };
  await moveTo('Offerte opvragen', 'Klaar');
  await until(async () => (await api('GET', '/rooms/tasks')).find((t) => t.id === own.id)?.status === 'done', 5000, 'status van het bord niet bijgewerkt');
  await moveTo('Bing opschonen', 'Klaar');
  await until(async () => (await api('GET', '/teamdata/tasks')).find((t) => t.titel === 'Bing opschonen')?.status === 'klaar', 5000, 'status in de teamdatabase niet "klaar"');
  await region('Klaar').getByText('Bing opschonen').waitFor({ timeout: 8000 }).catch(() => fail('takenbord: verplaatste taak niet in "Klaar"'));
  // Details: result and evidence, with a clickable link.
  await region('Klaar').getByRole('button', { name: /^Bing opschonen/ }).click();
  const dlg = page.getByRole('dialog', { name: 'Bing opschonen' });
  await dlg.waitFor({ timeout: 5000 });
  if (!(await dlg.getByRole('link', { name: 'https://example.com/bewijs' }).count())) fail('takenbord: bewijs niet als link in de details');
  if (!(await dlg.getByText('Onderzocht; besluit nodig.').count())) fail('takenbord: resultaat ontbreekt in de details');
  await axe(page, 'taakdetails');
  await shot(page, 'nieuwkomer-5-taak-details');
  await page.keyboard.press('Escape');
  step('takenbord: live bijgewerkt, verplaatsen schrijft de juiste status (bord en teamdatabase), details met resultaat en bewijs');

  // The old link (Groepen › Takenbord) shows the same one board.
  await page.goto(`${app.url}/#/m/rooms/taken`);
  await region('Klaar').getByText('Offerte opvragen').waitFor({ timeout: 8000 }).catch(() => fail('oude link #/m/rooms/taken toont niet hetzelfde bord'));
  step('Groepen › Takenbord (#/m/rooms/taken) toont hetzelfde bord');

  // ---------------------------------------------------------------- 3. a second bot: an example, "Meer opties"
  await page.goto(`${app.url}/#/agents/new`);
  const q2 = page.getByTestId('new-bot-questions');
  await q2.waitFor({ timeout: 10000 });
  if ((await page.getByRole('heading', { level: 1 }).innerText()) !== 'Nieuwe bot') fail('tweede bot: kop is niet "Nieuwe bot"');
  // A name, a role if you like, done: two fields and one button.
  await q2.getByLabel('Naam', { exact: true }).fill('Rik');
  await q2.getByRole('group', { name: 'Voorbeelden' }).getByRole('button', { name: 'Onderzoeker' }).click();
  if ((await q2.getByLabel('Naam', { exact: true }).inputValue()) !== 'Rik') fail('voorbeeld: overschreef een zelf getypte naam');
  if ((await q2.getByLabel(/^Rol/).inputValue()) !== 'Onderzoeker') fail('voorbeeld: vulde de rol niet in');
  const fields = await q2.locator('input[type="text"], input:not([type]), textarea').count();
  if (fields !== 2) fail(`nieuwe bot: ${fields} velden, doel 2 (naam en rol)`);
  await page.getByTestId('more-options').locator('summary').click();
  if (!(await page.getByRole('radio', { name: /Testmodel/ }).count())) fail('Meer opties: de keuze van de AI ontbreekt');
  if (await page.getByLabel('Instructies').count()) fail('nieuwe bot: instructies horen op de pagina van de bot, niet hier');
  await axe(page, 'nieuwe bot met Meer opties open');
  await shot(page, 'nieuwkomer-7-meer-opties');
  await page.getByRole('button', { name: 'Bot aanmaken' }).click();
  await page.waitForURL(/#\/t\//, { timeout: 15000 });
  let rik = app.ctx.store.agents(owner.id).find((a) => a.name === 'Rik');
  const rikOk = rik && rik.role === 'Onderzoeker' && /deelvragen/.test(rik.instructions) && rik.access_mode === 'full' && app.ctx.providers.config(rik.provider_id)?.kind === 'mock' && rik.tool_groups.includes('team');
  if (!rikOk) fail(`tweede bot: niet goed bewaard (${JSON.stringify(rik && { role: rik.role, access: rik.access_mode, provider: rik.provider_id, tools: rik.tool_groups })})`);
  // The bot's own page: three tabs, the rest of what the old long form held. "Laat AI de instructies schrijven" (from the
  // role and the short description) changes the instructions only.
  await page.goto(`${app.url}/#/agents/${rik.id}`);
  await page.getByLabel('Naam', { exact: true }).waitFor({ timeout: 10000 });
  // One page, no tabs: name, role, AI, model, instructions and one choice; the rest in one closed fold "Geavanceerd".
  if (await page.locator('main [role="tab"]').count()) fail('botpagina: er zijn nog tabbladen');
  for (const h of ['AI en model', 'Instructies', 'Wat mag de bot?', 'Beheer']) if (!(await page.getByRole('heading', { name: h, exact: true }).count())) fail(`botpagina: "${h}" ontbreekt`);
  if ((await page.locator('main details').count()) !== 1 || (await page.locator('main details[open]').count())) fail('botpagina: niet precies één dichte uitklap (Geavanceerd)');
  // What is not known about the model is left out (no rows of "onbekend").
  if (/:\s*onbekend/i.test(await page.locator('[data-tab="overzicht"]').innerText())) fail('botpagina: er staat een regel met "onbekend"');
  await axe(page, 'botpagina');
  if (await page.locator('[data-section="teams:teams"]').count()) fail('één team: onderdeel Teams op de botpagina');
  const instr = page.getByLabel('Instructies');
  await instr.waitFor({ timeout: 5000 });
  script.push({ text: JSON.stringify({ name: 'Zoeker', role: 'Bronnenspeurder', description: 'Iets anders', instructions: '- Zoek altijd drie bronnen.', tool_groups: ['web'], provider_id: 'nep', access_mode: 'full' }) });
  await page.getByRole('button', { name: 'Laat AI de instructies schrijven' }).click();
  await until(async () => /drie bronnen/.test(await instr.inputValue()), 8000, 'AI schreef de instructies niet');
  await axe(page, 'botpagina › Instructies');
  await shot(page, 'nieuwkomer-7b-botpagina');
  await page.getByRole('button', { name: 'Opslaan' }).first().click();
  await until(async () => /drie bronnen/.test(app.ctx.store.agents(owner.id).find((a) => a.name === 'Rik')?.instructions || ''), 8000, 'botpagina: de instructies zijn niet opgeslagen');
  rik = app.ctx.store.agents(owner.id).find((a) => a.name === 'Rik');
  if (rik.role !== 'Onderzoeker' || rik.access_mode !== 'full' || !rik.tool_groups.includes('team')) fail('AI-instructies: rol, toegang of tools van de gebruiker overschreven');
  step('tweede bot: naam, rol uit een voorbeeld, klaar; de botpagina is één pagina zonder tabbladen, zonder "onbekend"; AI schrijft de instructies, de rest blijft');

  // ---------------------------------------------------------------- 3b. a second team, from the "+" in the sidebar
  // (0.4.4: the "+" was a link to Nieuwe bot only; with one team there was no way to a team from it.)
  const side = page.getByRole('navigation', { name: 'Hoofdmenu' });
  const plus = side.getByRole('button', { name: 'Nieuw', exact: true });
  await plus.click();
  const plusMenu = page.getByRole('menu', { name: 'Nieuw' });
  const plusItems = (await plusMenu.getByRole('menuitem').allInnerTexts()).map((x) => x.trim());
  if (plusItems.join(',') !== 'Nieuwe bot,Nieuwe groepschat,Nieuw team,Team uit een sjabloon') fail(`"+": niet Nieuwe bot, Nieuwe groepschat, Nieuw team en Team uit een sjabloon (${plusItems.join(', ')})`);
  await axe(page, '"+"-menu open');
  await shot(page, 'nieuwkomer-8a-plus-menu');
  await plusMenu.getByRole('menuitem', { name: 'Nieuw team' }).click();
  const teamDlg = page.getByRole('dialog', { name: 'Nieuw team' });
  await teamDlg.getByLabel('Naam').fill('Bakkerij');
  await teamDlg.getByRole('button', { name: 'Team maken' }).click();
  await until(async () => (await api('GET', '/teams')).some((t) => t.name === 'Bakkerij'), 8000, '"+" › Nieuw team: het team is niet gemaakt');
  const switcher = side.getByTestId('team-switcher').getByRole('button').first();
  await switcher.waitFor({ timeout: 8000 }).catch(() => fail('tweede team: de teamkiezer verschijnt niet'));
  await switcher.click();
  await axe(page, 'teamkiezer open');
  await shot(page, 'nieuwkomer-8-teamkiezer');
  await page.getByRole('menuitemradio', { name: /Bakkerij/ }).click();
  await side.getByText('Nog geen bots in Bakkerij.', { exact: false }).waitFor({ timeout: 5000 }).catch(() => fail('Bakkerij gekozen: de chatlijst zegt niet dat dit team nog leeg is'));
  if (await side.getByRole('list', { name: 'Bots en groepen' }).getByText('Mila').count()) fail('Bakkerij gekozen: Mila (Mijn team) staat nog in de chatlijst');
  // A new bot while Bakkerij is chosen lands in Bakkerij.
  await plus.click();
  await page.getByRole('menu', { name: 'Nieuw' }).getByRole('menuitem', { name: 'Nieuwe bot' }).click();
  const q3 = page.getByTestId('new-bot-questions');
  await q3.waitFor({ timeout: 10000 });
  await q3.getByLabel('Naam', { exact: true }).fill('Bram');
  await page.getByRole('button', { name: 'Bot aanmaken' }).click();
  await page.waitForURL(/#\/t\//, { timeout: 15000 });
  const bram = app.ctx.store.agents(owner.id).find((a) => a.name === 'Bram');
  const bakkerij = (await api('GET', '/teams')).find((t) => t.name === 'Bakkerij');
  if (!bram || !bakkerij?.bots.some((b) => b.id === bram.id)) fail(`nieuwe bot met Bakkerij gekozen: niet in Bakkerij (${JSON.stringify((await api('GET', '/teams')).map((t) => [t.name, t.bots.map((b) => b.name)]))})`);
  if (!(await side.getByRole('list', { name: 'Bots en groepen' }).getByText('Bram').count())) fail('Bakkerij: Bram staat niet in de chatlijst');
  await shot(page, 'nieuwkomer-9-bakkerij');
  step('"+" biedt Nieuwe bot, Nieuwe groepschat, Nieuw team en Team uit een sjabloon; tweede team via "+" › Nieuw team: de teamkiezer verschijnt; Bakkerij kiezen filtert de chats; een nieuwe bot komt in Bakkerij');

  // The bot page: the line under the werkplek follows the level chosen under "Wat mag de bot?" (not saved here).
  await page.goto(`${app.url}/#/agents/${bram.id}`);
  await page.getByLabel('Naam', { exact: true }).waitFor({ timeout: 10000 });
  const canRow = page.locator('[data-section="core:can"]');
  if (!(await canRow.isVisible())) await page.getByTestId('bot-advanced').locator('summary').first().click();
  await canRow.locator('h3 button').click();
  const botDesk = canRow.getByTestId('bot-workplace');
  await botDesk.waitFor({ timeout: 8000 });
  const lineAt = async (level, want) => {
    if (level) {
      await page.locator('[data-testid="access-choice"] [role="combobox"]').click();
      await page.locator('[role="listbox"] [role="option"]', { hasText: level }).first().click();
    }
    await until(async () => want.test(await botDesk.innerText()), 5000, `botpagina: de regel bij de werkplek past niet bij ${level || 'Volledige toegang'} (${await botDesk.innerText()})`);
  };
  await lineAt('', /hele computer, zonder te vragen/);
  await lineAt('Automatisch', /Daarbuiten vraagt de bot eerst toestemming/);
  await lineAt('Vraagt toestemming', /Voordat de bot iets wijzigt, vraagt hij je akkoord/);
  await lineAt('Alleen lezen', /lezen en zoeken, niets wijzigen/);
  await shot(page, 'nieuwkomer-9b-botpagina-werkplek');
  step('botpagina: de regel bij de werkplek volgt het niveau (Volledige toegang: hele computer zonder te vragen; Automatisch: daarbuiten vraagt hij; Vraagt toestemming; Alleen lezen)');

  // ---------------------------------------------------------------- 4. phone width
  const p2 = await phoneCtx.newPage();
  watch(p2);
  await p2.goto(`${app.url}/#token=${token}`);
  for (const h of ['/agents/new', '/tasks']) {
    await p2.goto(`${app.url}/#${h}`);
    await p2.waitForTimeout(900);
    if ((await overflow(p2)) > 1) fail(`telefoon: ${h} schuift opzij`);
    await axe(p2, `${h} (telefoon)`);
  }
  await p2.getByRole('group', { name: 'Kolom' }).waitFor({ timeout: 5000 }).catch(() => fail('telefoon: takenbord zonder kolomkeuze'));
  await shot(p2, 'nieuwkomer-6-takenbord-telefoon');
  // The narrowest phones (320 px).
  await p2.setViewportSize({ width: 320, height: 700 });
  for (const h of ['/agents/new', '/tasks']) {
    await p2.goto(`${app.url}/#${h}`);
    await p2.waitForTimeout(700);
    if ((await overflow(p2)) > 1) fail(`telefoon 320 px: ${h} schuift opzij`);
  }
  step('telefoon (390 px): nieuwe bot en takenbord zonder opzij schuiven, één kolom tegelijk');
  await phoneCtx.close();
  await ctxb.close();

  // ---------------------------------------------------------------- 5. two more fresh installs: an API key, a subscription
  await keyPath();
  await subscriptionPath();
  // ---------------------------------------------------------------- 6. the first screen as real PCs have it
  await startScreens();
} catch (e) {
  fail(e.stack || e.message);
} finally {
  await browser.close();
  await app.close();
  for (const x of extra) await x.close().catch(() => {});
  for (const d of [dir, home, ...extraDirs]) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* left in the temp folder */
    }
  }
}
if (errors.length) fail('console-fouten:\n  ' + errors.join('\n  '));
console.log(process.exitCode ? 'NIEUWKOMER MISLUKT' : 'NIEUWKOMER GESLAAGD');
// Every TeamBot of this check is closed: end here, so a clock a module left behind cannot change the outcome.
process.exit(process.exitCode || 0);
