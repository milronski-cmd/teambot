// The owner's iPhone on a fresh install (TeamBot 0.4.2): everything he does on the computer, done from a paired phone.
// The phone pairs through the real flow (the computer makes a QR ticket, the phone claims it as the iPhone app does) and
// then loads the web app with its own device token, exactly as the iOS app's WKWebView does (token in localStorage
// before the page starts, the app's user agent, touch, an iPhone 17 Pro screen). Nothing is set up behind the phone's
// back except what the test needs from outside (the scripted test model and one usage report).
// Steps: empty first screen and empty pages → first bot with the three questions (connecting the AI found on the pc) →
// a message and its answer → an approval card approved from "Wacht op jou" → Taken, Routines, Geheugen, Marktplaats,
// Instellingen (each also used: a task, a routine, a memory, a setting) → the voice call screen → the usage bar →
// a second team and switching → computer-only things show their reason calmly. On every screen: dark theme by default,
// no text field below 16 px (iOS zooms in on those), no sideways scrolling at 390–430 px, tap targets of the shell
// at least 44 px, no failed requests or console errors, and axe-core WCAG 2.2 A/AA (contrast) in dark.
// Usage: npm run build:ui && node --import tsx tests/e2e/phone-owner.mjs   (TEAMBOT_E2E_SHOTS=<dir> for screenshots,
//        TEAMBOT_E2E_PORT=<port> for a fixed port, TEAMBOT_E2E_BROWSER=chrome|msedge)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const step = (s) => console.log(`• ${s}`);
const failures = [];
const fail = (s) => {
  failures.push(s);
  console.error(`✗ ${s}`);
  process.exitCode = 1;
};
const SHOTS = process.env.TEAMBOT_E2E_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if (await fn()) return true;
    } catch {
      /* not there yet */
    }
    if (Date.now() > end) return fail(`time-out: ${what}`), false;
    await sleep(100);
  }
};
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

// The browser starts first (it needs this PC's normal environment), then TeamBot gets an empty one: nothing of this PC
// (no real Claude Code, Codex, OpenCode, Ollama, no AppData of the owner's TeamBot) is found, used or changed.
const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-phone-owner-home-'));
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
delete process.env.HERMES_HOME;
delete process.env.TEAMBOT_HERMES_HOME;

const { createApp } = await import('./server.mjs');
const { mockAdapter } = await import('../helpers.ts');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-phone-owner-'));
const app = await createApp({ dataDir: dir, port: Number(process.env.TEAMBOT_E2E_PORT) || 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
// The computer: TeamBot's own desktop owner (only used for what the owner does on the pc: making the QR ticket).
const pcToken = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();
// The installed app's update flow (desktop/update-flow.ts) without a channel yet, as 0.4.4 ships: the phone sees the
// calm status and Automatisch bijwerken; nothing is looked up, downloaded or installed (a fake updater).
{
  const { UpdateFlow } = await import('../../desktop/update-flow.ts');
  const { EventEmitter } = await import('node:events');
  const fakeUpdater = Object.assign(new EventEmitter(), { autoDownload: false, autoInstallOnAppQuit: false, allowDowngrade: false, logger: null, setFeedURL() {}, async checkForUpdates() {}, async downloadUpdate() {}, quitAndInstall() {} });
  const flow = new UpdateFlow({ updater: fakeUpdater, version: app.ctx.config.version, packaged: true, configDir: path.join(dir, 'electron'), dataDir: dir, env: {}, builtIn: null, timing: { firstCheckMs: 3600_000 } });
  app.ctx.services.appUpdate = { info: () => flow.info(), check: () => flow.check(), download: () => flow.download(), installNow: () => flow.installNow(), save: (p) => flow.save(p) };
  flow.start();
}
for (const k of app.ctx.providers.kinds.values()) if (k.detect) k.detect = async () => ({ installed: false, detail: 'e2e' });
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
const call = async (token, method, p, body, headers = {}) => {
  const r = await fetch(app.url + '/api' + p, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
};
const pc = async (method, p, body) => {
  const r = await call(pcToken, method, p, body);
  if (r.status >= 400) throw new Error(`${method} ${p} → ${r.status}: ${r.body.error}`);
  return r.body;
};
step(`TeamBot op ${app.url} (lege datamap ${dir})`);

// ---------------------------------------------------------------- pairing, as the owner does it
// On the computer: Instellingen › Telefoon › QR-code. On the iPhone: the app scans it and claims the ticket.
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TeamBotiOS/0.4.2';
const ticket = await pc('POST', '/mobile/pair', { baseUrl: app.url });
const secret = new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('t');
const claimed = await call(null, 'POST', '/public/mobile/claim', { secret, name: 'iPhone van Sanne', platform: 'ios', client: 'ios-app' }, { 'user-agent': IOS_UA });
if (claimed.status !== 200 || !claimed.body.token) throw new Error(`koppelen mislukt: ${claimed.status} ${JSON.stringify(claimed.body)}`);
const phoneToken = claimed.body.token;
const me = await call(phoneToken, 'GET', '/me');
if (me.body.session?.kind !== 'device') fail(`de telefoon heeft geen apparaatsessie maar ${me.body.session?.kind}`);
const devices = await pc('GET', '/mobile/devices');
if (!devices.some((d) => d.name === 'iPhone van Sanne' && d.client === 'ios-app' && d.status === 'active')) fail('de iPhone staat niet als actieve iPhone-app in de apparatenlijst');
step('gekoppeld via de echte QR-koppeling: de iPhone-app heeft een eigen apparaatsleutel (sessie "device")');

// The 0.4.1 denylist stays: a phone never hands out access, reveals secrets or exports everything.
for (const [method, p, body] of [
  ['GET', '/secrets'],
  ['GET', '/sessions'],
  ['GET', '/export'],
  ['GET', '/memory/export'],
  ['GET', '/admin/users'],
  ['POST', '/mobile/pair', { baseUrl: app.url }],
  ['GET', '/mobile/devices'],
  ['PUT', '/mobile/gateway', { enabled: true, acknowledge: true }],
  ['GET', '/computers/vault'],
  ['POST', '/pairing', {}],
  // 0.4.4: where TeamBot fetches its own updates (the status and Automatisch bijwerken do work on the phone).
  ['PUT', '/app-update/channel', { channel: 'https://ander.voorbeeld.nl/' }],
]) {
  const r = await call(phoneToken, method, p, body);
  if (r.status !== 403 || r.body.code !== 'mobile_denied' || !/computer/.test(r.body.error || '')) fail(`alleen-op-de-computer: ${method} ${p} gaf ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
}
step('alleen op de computer (0.4.1): sleutels, sessies, export, beheer, koppelen, apparaten, telefoontoegang en de kluis geven 403 met een uitleg');

// ---------------------------------------------------------------- the phone: iPhone 17 Pro, the app's web view
const VIEW = { width: 402, height: 874 };
const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IOS_UA, locale: 'nl-NL', bypassCSP: true });
// What WebShellView.bootstrapScript does: the token from the Keychain into the page's storage before it starts, and a
// fetch hook that tells the app about a 401 (recorded here: it must never happen).
await ctx.addInitScript((t) => {
  try {
    if (localStorage.getItem('tb_token') !== t) {
      localStorage.removeItem('tb_urlkey');
      localStorage.setItem('tb_token', t);
    }
  } catch {}
  window.__nativeWords = [];
  window.webkit = { messageHandlers: { teambot: { postMessage: (w) => window.__nativeWords.push(String(w)) } } };
  const f = window.fetch;
  window.fetch = function () {
    return f.apply(this, arguments).then((r) => {
      try {
        if (r.status === 401 && /\/api\/(?!public\/)/.test(r.url)) window.webkit.messageHandlers.teambot.postMessage('unauthorized');
      } catch {}
      return r;
    });
  };
}, phoneToken);
const page = await ctx.newPage();
const errors = [];
const failed = [];
let expected = []; // requests that may fail on purpose right now (computer-only checks)
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text()) && errors.push(m.text()));
page.on('dialog', (d) => (errors.push(`onverwacht browserdialoog: ${d.message()}`), d.dismiss().catch(() => {})));
page.on('response', (r) => {
  const u = new URL(r.url());
  if (!u.pathname.startsWith('/api/') || r.status() < 400) return;
  const what = `${r.status()} ${r.request().method()} ${u.pathname}`;
  if (!expected.some((re) => re.test(what))) failed.push(what);
});

const shot = async (name) => SHOTS && (await page.waitForTimeout(250), await page.screenshot({ path: path.join(SHOTS, `telefoon-${name}.png`) }));
const tap = async (loc) => {
  // Coming back to Meer from Taken (0.4.2), the rows are drawn once more right after the page shows: a row found
  // just before that is gone. Find it again (at most twice); any other error counts at once.
  for (let i = 0; ; i++) {
    try {
      await loc.scrollIntoViewIfNeeded();
      await loc.tap();
      return;
    } catch (e) {
      if (i >= 2 || !/not attached to the DOM/.test(String(e?.message))) throw e;
      await page.waitForTimeout(300);
    }
  }
};
const typeInto = async (loc, text) => {
  await tap(loc);
  await page.keyboard.type(text);
};
const main = page.locator('#inhoud');
const tabs = page.getByRole('navigation', { name: 'Hoofdmenu' });
// A tab's name may carry its count ("Wacht op jou 1").
const tab = (name) => tabs.getByRole('link', { name: new RegExp(`^(\\d+ )?${name}$`) });
const go = async (hash) => {
  await page.evaluate((h) => (location.hash = h), hash);
  await page.waitForTimeout(500);
};

/** Every check that holds on every phone screen. */
async function screen(name, { axe = true, empty = false } = {}) {
  await page.waitForTimeout(600);
  const info = await page.evaluate(() => {
    const visible = (e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
    };
    const fields = [...document.querySelectorAll('input, textarea, select')]
      .filter((e) => visible(e) && !['checkbox', 'radio', 'range', 'file', 'hidden', 'color', 'button', 'submit', 'reset', 'image'].includes(e.type))
      .map((e) => ({ name: e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.name || e.id || e.tagName, size: parseFloat(getComputedStyle(e).fontSize) }));
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      dark: document.documentElement.classList.contains('dark'),
      small: fields.filter((f) => f.size < 16),
      fields: fields.length,
      text: document.body.innerText,
      redToasts: [...document.querySelectorAll('[aria-live] .bg-danger, [aria-live] [class*="bg-danger"]')].map((e) => e.textContent),
    };
  });
  if (info.overflow > 1) fail(`${name}: de pagina schuift ${info.overflow}px opzij`);
  if (!info.dark) fail(`${name}: niet het donkere thema (standaard op de telefoon)`);
  if (info.small.length) fail(`${name}: tekstvelden kleiner dan 16px (iOS zoomt dan in): ${info.small.map((f) => `${f.name} ${f.size}px`).join(', ')}`);
  if (empty && /niet beschikbaar/i.test(info.text)) fail(`${name}: zegt "niet beschikbaar"`);
  if (info.redToasts.length) fail(`${name}: rode foutmelding: ${info.redToasts.join(' | ')}`);
  if (failed.length) fail(`${name}: mislukte verzoeken: ${failed.splice(0).join(', ')}`);
  if (errors.length) fail(`${name}: paginafouten: ${errors.splice(0).join(' | ')}`);
  if (axe) {
    await page.addScriptTag({ content: axeSource });
    const v = await page.evaluate(async () => {
      // @ts-ignore
      const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
      return r.violations.map((x) => `${x.id}: ${x.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`);
    });
    if (v.length) fail(`a11y (donker) ${name}: ${v.join(' | ')}`);
  }
  await shot(name.replace(/[^a-z0-9]+/gi, '-').toLowerCase());
  return info;
}
/** A shell control: at least 44 × 44 px (Apple's minimum for a finger). */
async function bigEnough(loc, what) {
  const box = await loc.boundingBox();
  if (!box) return fail(`${what}: niet in beeld`);
  if (box.height < 43.5 || box.width < 43.5) fail(`${what}: ${Math.round(box.width)}×${Math.round(box.height)}px, kleiner dan 44 px`);
}

try {
  // ================================================================ 1. fresh install: the empty first screen
  await page.goto(app.url + '/');
  await main.getByText('Welkom bij TeamBot').waitFor({ timeout: 20000 });
  // 0.4.2: three plain ways in; the AI found on this PC has the one main button.
  const first = main.getByRole('button', { name: 'Testmodel gebruiken' });
  await first.waitFor({ timeout: 20000 });
  const meta = await page.evaluate(() => document.querySelector('meta[name="viewport"]')?.getAttribute('content') || '');
  if (!/width=device-width/.test(meta) || !/initial-scale=1/.test(meta) || !/viewport-fit=cover/.test(meta)) fail(`viewport-meta: ${meta}`);
  if (/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\D|$)/.test(meta)) fail(`viewport-meta zet zoomen uit (toegankelijkheid): ${meta}`);
  if ((await page.evaluate(() => localStorage.getItem('tb_theme'))) !== null) fail('thema: er staat al een keuze opgeslagen zonder dat de eigenaar koos');
  await screen('welkom', { empty: true });
  await bigEnough(tab('Chats'), 'tab Chats');
  await bigEnough(tab('Wacht op jou'), 'tab Wacht op jou');
  await bigEnough(tab('Meer'), 'tab Meer');
  if ((await tabs.getByRole('link').count()) !== 3) fail(`onderbalk: ${await tabs.getByRole('link').count()} tabs, verwacht 3 (Chats, Wacht op jou, Meer)`);
  step('lege eerste scherm: "Welkom bij TeamBot" met één knop, donker thema, drie tabs, viewport-meta goed (zoomen blijft mogelijk)');

  // The other screens are calm and useful while there is no bot yet.
  await tap(tab('Wacht op jou'));
  await page.waitForURL(/#\/inbox/);
  await screen('leeg-wacht-op-jou', { empty: true });
  await tap(tab('Meer'));
  await page.waitForURL(/#\/more/);
  await main.getByRole('heading', { name: 'Meer' }).waitFor();
  await screen('leeg-meer', { empty: true });
  for (const [row, hash] of [
    ['Taken', /#\/tasks/],
    ['Routines', /#\/m\/routines/],
    ['Geheugen', /#\/m\/memory/],
    // 0.4.5: "Nu bezig" is a place of its own (the sidebar on the computer, Meer on the phone).
    ['Nu bezig', /#\/m\/usage\/status/],
  ]) {
    await tap(tab('Meer'));
    await tap(main.getByRole('navigation', { name: 'Meer' }).getByRole('link', { name: row, exact: true }));
    await page.waitForURL(hash);
    await screen(`leeg-${row}`, { empty: true });
  }
  await tap(tab('Chats'));
  await first.waitFor({ timeout: 10000 });
  step('zonder bot: Wacht op jou, Meer, Taken, Routines en Geheugen zijn rustig en bruikbaar, nergens "niet beschikbaar"');

  // ================================================================ 2. the first bot: three questions, found AI
  await tap(first);
  // 0.4.5: a ready first bot right away; the three questions are optional behind "Aanpassen".
  await page.waitForURL(/#\/start/, { timeout: 15000 });
  const ready = page.getByTestId('first-bot-ready');
  await ready.waitFor({ timeout: 20000 });
  await screen('eerste-bot-klaar');
  await tap(ready.getByRole('button', { name: 'Aanpassen' }));
  const q = page.getByTestId('first-bot-edit');
  await q.waitFor({ timeout: 10000 });
  const engine = q.getByRole('radio', { name: /Testmodel/ });
  await until(async () => (await engine.count()) && (await engine.isChecked()), 10000, 'nieuwe bot: het gevonden model is niet voorgesteld');
  const asked = await q.locator('label[data-i18n="label"], legend').allInnerTexts();
  if (asked.slice(0, 3).join(' | ') !== 'Hoe heet je bot? | Wat doet hij? | Welk model gebruikt hij?') fail(`nieuwe bot: de eerste vragen zijn ${JSON.stringify(asked)}`);
  if ((await q.getByRole('button', { name: 'Opslaan' }).count()) !== 1) fail('aanpassen: niet precies één knop "Opslaan"');
  await screen('drie-vragen');
  await q.getByLabel('Hoe heet je bot?').fill('');
  await typeInto(q.getByLabel('Hoe heet je bot?'), 'Mila');
  await q.getByLabel('Wat doet hij?').fill('');
  await typeInto(q.getByLabel('Wat doet hij?'), 'Helpt me met korte vragen over mijn webshop.');
  await tap(q.getByRole('button', { name: 'Opslaan' }));
  await ready.getByRole('heading', { name: 'Mila staat klaar' }).waitFor({ timeout: 15000 });
  await tap(ready.getByRole('button', { name: 'Begin met praten' }));
  // the last step, "Koppel je telefoon", is not offered on a paired phone itself
  const later = page.getByTestId('first-bot-phone').getByRole('button', { name: 'Later' });
  await Promise.race([later.waitFor({ timeout: 10000 }).then(() => tap(later)), page.waitForURL(/#\/t\//, { timeout: 10000 })]).catch(() => {});
  await page.waitForURL(/#\/t\//, { timeout: 15000 });
  const mila = app.ctx.store.agents(owner.id).find((a) => a.name === 'Mila');
  if (!mila) throw new Error('de bot Mila is niet aangemaakt vanaf de telefoon');
  if (app.ctx.providers.config(mila.provider_id)?.kind !== 'mock') fail('eerste bot: gebruikt niet de gevonden AI (Testmodel)');
  if (mila.description !== 'Helpt me met korte vragen over mijn webshop.') fail(`eerste bot: taak niet bewaard (${mila.description})`);
  step('eerste bot vanaf de telefoon: drie vragen, de gevonden AI gekoppeld, chat opent');

  // ================================================================ 3. a message and its answer
  const box = page.getByRole('textbox', { name: 'Bericht' });
  await box.waitFor({ timeout: 10000 });
  await page.waitForTimeout(400);
  await screen('chat-leeg');
  const send = page.getByRole('button', { name: 'Versturen' });
  await bigEnough(send, 'knop Versturen');
  await bigEnough(page.getByRole('link', { name: 'Terug naar chats' }), 'knop Terug naar chats');
  await bigEnough(page.getByRole('button', { name: 'Bestand toevoegen' }), 'knop Bestand toevoegen');
  // Every control in the chat header and next to the message box: at least 44 × 44 px.
  const tiny = await page.evaluate(() => {
    const ta = document.querySelector('textarea[aria-label="Bericht"]');
    const els = [...document.querySelectorAll('#inhoud header button, #inhoud header a'), ...(ta ? ta.parentElement.querySelectorAll('button') : [])];
    return els
      .map((e) => ({ e, r: e.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.width < 43.5 || r.height < 43.5))
      .map(({ e, r }) => `${e.getAttribute('aria-label') || e.textContent.trim() || e.tagName} ${Math.round(r.width)}×${Math.round(r.height)}`);
  });
  if (tiny.length) fail(`chat: te kleine knoppen in de kop of naast het invoerveld: ${tiny.join(', ')}`);
  const composer = await box.evaluate((e) => {
    const r = e.getBoundingClientRect();
    return { bottom: r.bottom, vh: window.innerHeight, size: parseFloat(getComputedStyle(e).fontSize), pb: parseFloat(getComputedStyle(e.closest('.rounded-bubble').parentElement).paddingBottom) };
  });
  if (composer.size < 16) fail(`invoerveld: ${composer.size}px (iOS zoomt in)`);
  if (composer.bottom > composer.vh - 8) fail(`invoerveld plakt tegen de onderrand (${composer.bottom} van ${composer.vh})`);
  script.push({ text: 'Ik help je graag met je webshop. Waar wil je beginnen?' });
  await typeInto(box, 'Hoi Mila, wat kun je voor me doen?');
  await tap(send);
  await page.locator('[id^="m-"]').getByText('Ik help je graag met je webshop. Waar wil je beginnen?').waitFor({ timeout: 30000 });
  if ((await page.evaluate(() => window.visualViewport?.scale ?? 1)) !== 1) fail('na tikken in het invoerveld is de pagina ingezoomd');
  await screen('chat-antwoord');
  step('bericht versturen met de knop: het antwoord komt, het invoerveld is 16px en niets zoomt in');

  // Practice test 0.4.4: a long message makes the input grow (several lines); the newest message stays in view above
  // it, and after sending the chat follows the long answer to its end (it streamed on below the screen, behind
  // "Naar nieuwste").
  const gap = () =>
    page.evaluate(() => {
      const el = document.querySelector('.scroll-thin.relative.min-h-0.flex-1.overflow-y-auto');
      return el ? Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) : -1;
    });
  const steps = (n) => Array.from({ length: n }, (_, i) => `${i + 1}. Stap ${i + 1} voor de webshop`).join('\n');
  script.push({ text: `Eerst dit:\n\n${steps(16)}\n\nDaarna kijken we verder.` });
  await typeInto(box, 'Wat moet ik eerst doen?');
  await tap(send);
  await page.locator('[id^="m-"]').getByText('Daarna kijken we verder.').waitFor({ timeout: 30000 });
  await page.waitForTimeout(400);
  const h0 = await box.evaluate((e) => e.getBoundingClientRect().height);
  await typeInto(box, 'Ik wil een lange vraag stellen over mijn webshop: de levering, de voorraad, de prijzen en de producttekst van de nieuwe fiets. Wat heb je daarvoor van mij nodig?');
  await page.waitForTimeout(300);
  const h1 = await box.evaluate((e) => e.getBoundingClientRect().height);
  if (h1 < h0 + 20) fail(`lang bericht: het invoerveld groeit niet mee (${Math.round(h0)} → ${Math.round(h1)} px)`);
  const typingGap = await gap();
  if (typingGap > 4) fail(`lang bericht typen: het nieuwste bericht verdwijnt achter het groeiende invoerveld (${typingGap} px)`);
  script.push({ text: 'Goed plan. Dit zijn de stappen:\n\n' + Array.from({ length: 14 }, (_, i) => `${i + 1}. Stap ${i + 1} voor de webshop`).join('\n') + '\n\nZal ik beginnen?' });
  await tap(send);
  await page.locator('[id^="m-"]').getByText('Zal ik beginnen?').waitFor({ timeout: 30000 });
  await page.waitForTimeout(600);
  const answerGap = await gap();
  if (answerGap > 80 || (await page.getByRole('button', { name: 'Naar nieuwste' }).count())) fail(`lang antwoord: de chat volgt het antwoord niet tot het eind (${answerGap} px onder beeld)`);
  step('lang bericht: het invoerveld groeit, het nieuwste bericht blijft zichtbaar en de chat volgt het lange antwoord');

  // The keyboard (iOS keeps the layout viewport; the app follows the visual viewport): the composer stays right above it.
  await page.evaluate(() => {
    const vv = window.visualViewport;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => 874 - 336 });
    vv.dispatchEvent(new Event('resize'));
  });
  await page.waitForTimeout(300);
  const kb = await box.evaluate((e) => {
    const r = e.getBoundingClientRect();
    const wrap = e.closest('.safe-bottom, [class*="pb-"]');
    return { bottom: r.bottom, top: r.top, kb: document.documentElement.classList.contains('tb-keyboard') };
  });
  if (!(kb.bottom <= 874 - 336 && kb.top > 300)) fail(`toetsenbord open: invoerveld niet vlak boven het toetsenbord (${Math.round(kb.top)}–${Math.round(kb.bottom)}, toetsenbord vanaf ${874 - 336})`);
  if (!kb.kb) fail('toetsenbord open: de app weet het niet (geen tb-keyboard)');
  await shot('chat-toetsenbord');
  // 0.4.3, the owner in the iPhone app: "als ik iets typ, komt die balk in het midden van het beeldscherm". The app's
  // web view also scrolls the visible part down to reveal the field (visualViewport.offsetTop > 0): the composer must
  // still end right above the keyboard, i.e. at offsetTop + the visible height, not at the visible height alone.
  const OFFSET = 336;
  await page.evaluate((off) => {
    const vv = window.visualViewport;
    Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => off });
    vv.dispatchEvent(new Event('scroll'));
  }, OFFSET);
  await page.waitForTimeout(300);
  const panned = await box.evaluate((e) => {
    const r = e.getBoundingClientRect();
    return { bottom: r.bottom, top: r.top, tabs: !!document.querySelector('nav[aria-label="Hoofdmenu"]') };
  });
  const visTop = OFFSET;
  const visBottom = OFFSET + (874 - 336);
  if (!(panned.bottom <= visBottom && panned.bottom >= visBottom - 90)) fail(`toetsenbord open en beeld verschoven (offsetTop ${OFFSET}): invoerveld onderkant op ${Math.round(panned.bottom)}, verwacht vlak boven het toetsenbord (${visBottom - 90}–${visBottom}); op het scherm staat het op ${Math.round(panned.bottom - visTop)} van ${874 - 336}`);
  const header = await page.getByRole('link', { name: 'Terug naar chats' }).boundingBox();
  if (!header || header.y < visTop - 1) fail(`toetsenbord open en beeld verschoven: de kop van de chat valt boven het zichtbare deel (${header && Math.round(header.y)} < ${visTop})`);
  await shot('chat-toetsenbord-verschoven');
  // 0.4.4, the owner: "typen gaat heel vreemd". While you type, the visual viewport reports again and again (the
  // suggestion bar, the reveal scroll) without anything having changed: the app then does nothing, and with the
  // keyboard open it never scrolls the page itself (that works against the web view's own reveal scroll).
  const calm = await page.evaluate(async () => {
    const vv = window.visualViewport;
    let scrolls = 0;
    let writes = 0;
    const real = window.scrollTo;
    window.scrollTo = (...a) => (scrolls++, real.apply(window, a));
    const seen = new MutationObserver((l) => (writes += l.length));
    seen.observe(document.documentElement, { attributes: true });
    seen.observe(document.getElementById('root'), { attributes: true });
    for (let i = 0; i < 30; i++) vv.dispatchEvent(new Event(i % 2 ? 'scroll' : 'resize'));
    await new Promise((r) => setTimeout(r, 250));
    seen.disconnect();
    window.scrollTo = real;
    return { scrolls, writes };
  });
  if (calm.scrolls || calm.writes) fail(`toetsenbord open, 30 meldingen zonder verandering: de app schoof de pagina ${calm.scrolls} keer en paste ${calm.writes} keer zijn maten aan (verwacht 0 en 0)`);
  await page.evaluate(() => {
    const vv = window.visualViewport;
    delete vv.height;
    delete vv.offsetTop;
    vv.dispatchEvent(new Event('resize'));
  });
  await page.waitForTimeout(200);
  const closed = await box.evaluate((e) => e.getBoundingClientRect().bottom);
  if (closed < 874 - 160) fail(`toetsenbord dicht: het invoerveld staat niet meer onderaan (${Math.round(closed)})`);
  step('toetsenbord open: het invoerveld staat direct boven het toetsenbord, ook als de app het beeld omhoog schuift (offsetTop)');

  // ================================================================ 4. an approval card, approved on the phone
  // New bots start on Automatisch (they work on by themselves): for the card, this bot asks first, set on the computer.
  await pc('PATCH', `/agents/${mila.id}`, { access_mode: 'ask' });
  script.push({ text: 'Ik zet het lijstje in een bestand.', toolCalls: [{ name: 'write_file', args: { path: 'boodschappen.txt', content: 'melk, brood, koffie' } }] });
  script.push({ text: 'Klaar: het lijstje staat in boodschappen.txt.' });
  await typeInto(box, 'Zet mijn boodschappenlijst in een bestand.');
  await tap(send);
  const card = page.getByRole('group', { name: 'Goedkeuring nodig' });
  await card.waitFor({ timeout: 20000 });
  if (await card.getByRole('button', { name: 'Altijd toestaan voor deze bot' }).count()) fail('goedkeuring op de telefoon: knop "Altijd toestaan" staat er (kan alleen op de computer)');
  // 0.4.5: three clear choices on the computer (Eén keer / Overslaan / Altijd), two on the phone.
  const choices = (await card.getByRole('button').allInnerTexts()).map((x) => x.trim()).filter((x) => ['Eén keer', 'Overslaan', 'Altijd'].includes(x));
  if (choices.join(',') !== 'Eén keer,Overslaan') fail(`goedkeuring op de telefoon: niet de twee knoppen Eén keer en Overslaan (${choices.join(', ')})`);
  if (!(await card.getByText('Altijd toestaan kies je op je computer.').count())) fail('goedkeuring op de telefoon: de reden waarom "Altijd toestaan" er niet staat ontbreekt');
  await screen('chat-goedkeuring');
  // Back to the list: the phone says something waits, the tab shows the count.
  await tap(page.getByRole('link', { name: 'Terug naar chats' }));
  await main.getByText('Er wacht één vraag op jou').waitFor({ timeout: 8000 }).catch(() => fail('Chats: geen melding dat er iets op je wacht'));
  if (!/1/.test(await tab('Wacht op jou').innerText())) fail('tab Wacht op jou: geen teller');
  // 0.4.5: the app opened again while something waits starts on "Wacht op jou" (the web app and the iPhone app's start
  // page from GET /api/mobile/status); with nothing waiting it opened on Chats (step 1).
  await page.goto(app.url + '/');
  await page.waitForURL(/#\/inbox/, { timeout: 10000 }).catch(() => fail('de app opent niet op Wacht op jou terwijl er iets wacht'));
  const home = (await call(phoneToken, 'GET', '/mobile/status')).body.home;
  if (home !== '#/inbox') fail(`iPhone-app: startpagina ${home} terwijl er iets wacht`);
  step('de app opnieuw geopend terwijl er iets wacht: hij opent op Wacht op jou (ook de startpagina van de iPhone-app)');
  await go('#/');
  await page.waitForTimeout(600);
  if (!/^#\/?$/.test(await page.evaluate(() => location.hash))) fail('terug naar Chats: de app springt opnieuw naar Wacht op jou');
  await tap(tab('Wacht op jou'));
  await page.waitForURL(/#\/inbox/);
  const inboxCard = main.getByRole('group', { name: 'Goedkeuring nodig' });
  await inboxCard.waitFor({ timeout: 8000 });
  await screen('wacht-op-jou');
  const approve = inboxCard.getByRole('button', { name: 'Eén keer toestaan' });
  await bigEnough(approve, 'knop Eén keer toestaan');
  // 0.4.4 (PARITEIT 15.1, web): the phone's notification of this approval goes away once it is handled.
  const aprId = app.ctx.store.all("SELECT id FROM approvals WHERE user_id = ? AND status = 'pending'", owner.id)[0]?.id;
  await ctx.grantPermissions(['notifications'], { origin: app.url });
  const aprNotes = () => page.evaluate(() => navigator.serviceWorker.ready.then((r) => r.getNotifications()).then((l) => l.map((n) => n.tag)));
  await page.evaluate((tag) => navigator.serviceWorker.ready.then((r) => r.showNotification('Mila vraagt toestemming', { tag })), `apr-${aprId}`);
  if (!(await aprNotes()).includes(`apr-${aprId}`)) fail('telefoon: de melding van de goedkeuring staat er niet');
  await tap(approve);
  await until(async () => !(await aprNotes()).includes(`apr-${aprId}`), 8000, 'telefoon: de melding van de goedkeuring blijft staan na goedkeuren');
  await ctx.clearPermissions();
  const thread = app.ctx.store.threads(owner.id).find((t) => t.agent_id === mila.id);
  await until(() => app.ctx.store.messages(thread.id).some((m) => m.role === 'assistant' && /boodschappen\.txt/.test(m.content) && m.status === 'done'), 20000, 'na goedkeuren: de bot maakt zijn werk niet af');
  const decided = app.ctx.store.all("SELECT status FROM approvals WHERE user_id = ? ORDER BY created_at DESC LIMIT 1", owner.id)[0];
  if (decided?.status !== 'approved') fail(`goedkeuring: status ${decided?.status}`);
  await until(async () => !(await main.getByRole('group', { name: 'Goedkeuring nodig' }).count()), 8000, 'Wacht op jou: de kaart blijft staan na goedkeuren');
  await screen('wacht-op-jou-leeg');
  await tap(tab('Chats'));
  await tap(main.getByRole('link', { name: /Mila/ }).first());
  await page.locator('[id^="m-"]').getByText('Klaar: het lijstje staat in boodschappen.txt.').waitFor({ timeout: 10000 });
  step('goedkeuring: kaart in de chat (zonder "Altijd toestaan", met de reden), teller op de tab, goedgekeurd in Wacht op jou (de melding ervan verdwijnt), de bot maakt het af');

  // ================================================================ 5. the voice call screen (no microphone needed)
  const callBtn = page.getByRole('button', { name: 'Live praten' });
  await bigEnough(callBtn, 'knop Live praten');
  await tap(callBtn);
  const callDlg = page.getByRole('dialog', { name: 'Praten met Mila' });
  await callDlg.waitFor({ timeout: 8000 });
  await callDlg.getByText('Je praat met een AI', { exact: false }).waitFor({ timeout: 8000 }).catch(() => fail('belscherm: laadt niet'));
  // The owner's phone may fetch the free speech recognition onto his pc (before 0.4.2 it said "ask the owner of the pc").
  if (await callDlg.getByText('vraag de eigenaar', { exact: false }).count()) fail('belscherm: zegt de eigenaar zelf dat hij "de eigenaar van de TeamBot-pc" moet vragen');
  // 0.4.4: no grey buttons; step 0 explains the choices and offers "Klaarmaken en bellen" (download only after a yes).
  if (!(await page.getByRole('button', { name: 'Klaarmaken en bellen' }).count())) fail('belscherm: geen knop "Klaarmaken en bellen"');
  if (!(await callDlg.getByText('Eénmalige download', { exact: false }).count())) fail('belscherm: het gratis pad noemt de eenmalige download niet');
  // 0.4.4: the free live call (full duplex on the pc) is offered too; not ready yet, with the reason in plain words.
  const duplexChoice = callDlg.getByRole('radio', { name: /Live gesprek, gratis/ });
  if (!(await duplexChoice.count())) fail('belscherm: geen keuze voor het gratis live gesprek');
  else if (!(await duplexChoice.innerText()).includes('Nog niet klaar')) fail('belscherm: het gratis live gesprek zegt niet waarom het nog niet kan');
  const milaId = (await call(phoneToken, 'GET', '/agents')).body.find?.((a) => a.name === 'Mila')?.id;
  const dx = await call(phoneToken, 'POST', '/voice/duplex/calls', { agentId: milaId });
  if (dx.status !== 409) fail(`telefoon: gratis live gesprek zonder modellen gaf ${dx.status} in plaats van 409 met een reden`);
  await screen('bellen');
  await tap(callDlg.getByRole('button', { name: 'Annuleren' }));
  await until(async () => !(await page.getByRole('dialog').count()), 4000, 'belscherm sluit niet');
  step('belscherm opent vanaf de chat en sluit weer');

  // ================================================================ 6. the usage bar
  // What a free source reports (OpenCode, Groq …), as another module does with ctx.services.usage.reportSource.
  app.ctx.services.usage.reportSource({ id: 'groq', label: 'Groq', status: 'available', userId: owner.id, kind: 'free', note: '1.000 verzoeken per dag' });
  await tap(page.getByRole('link', { name: 'Terug naar chats' }));
  await tap(tab('Meer'));
  await page.waitForURL(/#\/more/);
  const usage = main.getByRole('region', { name: 'Gebruik' });
  await usage.waitFor({ timeout: 10000 }).catch(() => fail('Meer: de gebruiksbalk staat er niet'));
  if (!(await usage.getByText('Groq').count())) fail('gebruiksbalk: de gratis bron Groq ontbreekt');
  await screen('meer');
  for (const row of ['Nu bezig', 'Taken', 'Routines', 'Geheugen', 'Marktplaats', 'Instellingen']) await bigEnough(main.getByRole('navigation', { name: 'Meer' }).getByRole('link', { name: row, exact: true }), `Meer › ${row}`);
  step('gebruiksbalk bovenaan Meer met de gratis bron; alle rijen van Meer zijn groot genoeg');

  // ================================================================ 7. Taken, Routines, Geheugen, Marktplaats, Instellingen — and use them
  const meer = async (row, hash) => {
    await tap(tab('Meer'));
    await page.waitForURL(/#\/more/);
    await tap(main.getByRole('navigation', { name: 'Meer' }).getByRole('link', { name: row, exact: true }));
    await page.waitForURL(hash, { timeout: 10000 });
    await page.waitForTimeout(400);
  };
  await meer('Taken', /#\/tasks/);
  await main.getByRole('heading', { name: 'Taken', exact: true }).waitFor({ timeout: 10000 });
  await tap(main.getByRole('button', { name: 'Nieuwe taak' }).first());
  await typeInto(page.getByRole('dialog').getByRole('textbox', { name: 'Nieuwe taak' }), 'Offerte opvragen');
  await tap(page.getByRole('dialog').getByRole('button', { name: 'Toevoegen' }));
  await until(async () => (await call(phoneToken, 'GET', '/rooms/tasks')).body.some?.((t) => t.title === 'Offerte opvragen'), 8000, 'Taken: nieuwe taak niet bewaard');
  await main.getByText('Offerte opvragen').first().waitFor({ timeout: 8000 });
  await screen('taken');
  // Zoeken on the phone finds the task (0.4.5; it used to find no tasks) and opens it on the board.
  await go('#/search?q=opvragen%20offerte');
  const taskHit = page.getByRole('group', { name: 'Taken' }).getByRole('option', { name: /Offerte opvragen/ });
  await taskHit.waitFor({ timeout: 8000 }).catch(() => fail('Zoeken op de telefoon: de taak "Offerte opvragen" staat niet onder Taken'));
  if (await taskHit.count()) {
    await tap(taskHit.first());
    await page.waitForURL(/#\/tasks\?open=b%3A/, { timeout: 8000 }).catch(() => fail(`Zoeken op de telefoon: de taak opent niet op het bord (${page.url()})`));
    await page.getByRole('dialog', { name: /Offerte opvragen/ }).waitFor({ timeout: 8000 }).catch(() => fail('Zoeken op de telefoon: het taakvenster opent niet'));
    await page.keyboard.press('Escape');
    step('Zoeken op de telefoon vindt de taak en opent hem');
  }

  await meer('Routines', /#\/m\/routines/);
  await tap(main.getByRole('button', { name: 'Nieuw', exact: true }).first());
  await tap(page.getByRole('dialog').getByRole('button', { name: /Elke dag of week iets laten doen/ }));
  await page.waitForURL(/#\/m\/routines\/r\/new/);
  await main.getByRole('heading', { name: 'Nieuwe routine' }).waitFor({ timeout: 10000 });
  await typeInto(main.getByLabel('Naam', { exact: true }), 'Ochtendoverzicht');
  await typeInto(main.getByPlaceholder(/Vat de belangrijkste nieuwe e-mails/), 'Vertel me elke ochtend wat er vandaag op de planning staat.');
  await screen('nieuwe-routine');
  await tap(main.getByRole('button', { name: 'Routine aanmaken' }));
  await page.waitForURL(/#\/m\/routines\/r\/(?!new)/, { timeout: 10000 });
  const routines = (await call(phoneToken, 'GET', '/routines')).body;
  if (!Array.isArray(routines) || !routines.some((r) => r.name === 'Ochtendoverzicht' && r.agent_id === mila.id)) fail(`routine niet bewaard (${JSON.stringify(routines).slice(0, 160)})`);
  await screen('routine');
  // Kosten vooraf (0.4.4, P3): "Belangrijk" aan → the estimate shows, labelled as an estimate, readable on the phone.
  const morning = routines.find?.((r) => r.name === 'Ochtendoverzicht');
  if (morning) await go(`#/m/routines/r/${morning.id}?tab=settings`);
  await main.getByRole('switch', { name: 'Belangrijk' }).first().waitFor({ timeout: 10000 });
  await tap(main.getByRole('switch', { name: 'Belangrijk' }).first());
  const estimate = main.locator('[data-testid="cost-estimate"]');
  await estimate.waitFor({ timeout: 8000 }).catch(() => fail('routine: Belangrijk aan, maar geen kostenschatting'));
  if (!/schatting/.test((await estimate.textContent().catch(() => '')) || '')) fail('kostenschatting: het woord "schatting" ontbreekt');
  if (!/Kost geen geld/.test((await estimate.textContent().catch(() => '')) || '')) fail('kostenschatting: een model op de eigen computer kost geen geld, dat staat er niet');
  await screen('routine-kostenschatting');
  await tap(main.getByRole('switch', { name: 'Belangrijk' }).first());
  step('kostenschatting in de routine-editor op de telefoon (Belangrijk aan): "schatting", geen geld bij een eigen model');

  await meer('Geheugen', /#\/m\/memory/);
  // Adding a memory by hand is rare: "Zelf iets toevoegen" behind the page's "Meer opties".
  await tap(main.getByRole('button', { name: 'Meer opties', exact: true }).first());
  await tap(page.getByRole('menuitem', { name: 'Zelf iets toevoegen' }));
  await typeInto(page.getByRole('dialog', { name: 'Nieuwe herinnering' }).getByLabel('Inhoud'), 'Ik ben op maandag niet bereikbaar.');
  await tap(page.getByRole('dialog', { name: 'Nieuwe herinnering' }).getByRole('button', { name: 'Opslaan', exact: true }));
  await until(() => app.ctx.store.all('SELECT * FROM memory_items WHERE user_id = ?', owner.id).some((m) => /maandag/.test(JSON.stringify(m))), 8000, 'Geheugen: niet onthouden');
  await screen('geheugen');

  await meer('Marktplaats', /#\/m\/skills/);
  await page.waitForTimeout(800);
  await screen('marktplaats');

  await meer('Instellingen', /#\/settings/);
  await main.getByRole('heading', { name: 'Instellingen', exact: true }).waitFor({ timeout: 10000 });
  await screen('instellingen');
  // Your name is on the row "Taal en uiterlijk" (was Algemeen; Uiterlijk is part of it now). On the phone a row has
  // its one line under the title ("Naam, taal, thema en kleur.").
  await tap(main.getByRole('link', { name: /^Taal en uiterlijk\b/ }));
  await page.waitForURL(/#\/settings\/general/);
  const nameBox = main.getByRole('textbox', { name: 'Je naam' });
  await nameBox.waitFor();
  await nameBox.fill('');
  await typeInto(nameBox, 'Sanne');
  // 0.4.5: a setting saves at once (here: Enter, or leaving the field), with a small "Opgeslagen".
  await page.keyboard.press('Enter');
  await main.getByTestId('saved-note').filter({ hasText: 'Opgeslagen' }).first().waitFor({ timeout: 8000 }).catch(() => fail('Instellingen: geen "Opgeslagen" na het wijzigen van de naam'));
  await until(async () => (await call(phoneToken, 'GET', '/me')).body.user?.name === 'Sanne', 8000, 'Instellingen: naam niet opgeslagen');
  // Theme (Instellingen › Taal en uiterlijk; the old link #/settings/appearance opens it): dark is the phone's default
  // and shows as chosen; an explicit choice always wins (also after a restart).
  await go('#/settings/appearance');
  const themeGroup = main.getByRole('radiogroup', { name: 'Thema' });
  if ((await themeGroup.getByRole('radio', { name: 'Donker' }).getAttribute('aria-checked')) !== 'true') fail('thema: "Donker" staat niet aan als standaard op de telefoon');
  await screen('instellingen-algemeen');
  await tap(themeGroup.getByRole('radio', { name: 'Licht' }));
  if (await page.evaluate(() => document.documentElement.classList.contains('dark'))) fail('thema: "Licht" kiezen werkt niet op de telefoon');
  await page.reload();
  await main.getByRole('radiogroup', { name: 'Thema' }).waitFor({ timeout: 15000 });
  if (await page.evaluate(() => document.documentElement.classList.contains('dark'))) fail('thema: de eigen keuze "Licht" wint niet van de telefoonstandaard na opnieuw openen');
  await tap(main.getByRole('radiogroup', { name: 'Thema' }).getByRole('radio', { name: 'Donker' }));
  if (!(await page.evaluate(() => document.documentElement.classList.contains('dark')))) fail('thema: terug naar "Donker" werkt niet');
  step('Taken (taak toegevoegd), Routines (routine gemaakt), Geheugen (iets onthouden), Marktplaats, Instellingen (naam gewijzigd; thema: donker standaard, eigen keuze wint)');

  // ================================================================ 8. two teams: made from the "+" on Chats, switch on the phone
  await tap(tab('Chats'));
  const plus = main.getByRole('button', { name: 'Nieuw', exact: true });
  await bigEnough(plus, '"+" op Chats');
  await tap(plus);
  const plusMenu = page.getByRole('menu', { name: 'Nieuw' });
  await plusMenu.waitFor({ timeout: 5000 }).catch(() => fail('"+" op Chats: geen menu'));
  for (const it of await plusMenu.getByRole('menuitem').all()) await bigEnough(it, `"+" › ${(await it.innerText()).trim()}`);
  await screen('plus-menu', { axe: true });
  await tap(plusMenu.getByRole('menuitem', { name: 'Nieuw team' }));
  const teamDlg = page.getByRole('dialog', { name: 'Nieuw team' });
  await teamDlg.waitFor({ timeout: 8000 });
  await typeInto(teamDlg.getByLabel('Naam'), 'Bakkerij');
  // With the keyboard open, the sheet's button stays above it.
  await page.evaluate(() => {
    const vv = window.visualViewport;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => 874 - 336 });
    vv.dispatchEvent(new Event('resize'));
  });
  await page.waitForTimeout(300);
  const make = teamDlg.getByRole('button', { name: 'Team maken' });
  const mb = await make.boundingBox();
  if (!mb || mb.y + mb.height > 874 - 336) fail(`toetsenbord open in een venster: knop "Team maken" valt achter het toetsenbord (${mb && Math.round(mb.y + mb.height)} > ${874 - 336})`);
  await shot('team-toetsenbord');
  await page.evaluate(() => {
    const vv = window.visualViewport;
    delete vv.height;
    vv.dispatchEvent(new Event('resize'));
  });
  await screen('nieuw-team', { axe: true });
  await tap(make);
  await until(async () => (await call(phoneToken, 'GET', '/teams')).body.some?.((t) => t.name === 'Bakkerij'), 8000, 'tweede team niet gemaakt');
  await tap(tab('Chats'));
  const switcher = main.getByTestId('team-switcher').getByRole('button').first();
  await switcher.waitFor({ timeout: 8000 }).catch(() => fail('twee teams: de teamkiezer staat niet op Chats'));
  await bigEnough(switcher, 'teamkiezer');
  await tap(switcher);
  await tap(page.getByRole('menuitemradio', { name: /Bakkerij/ }));
  await main.getByText('Nog geen bots in Bakkerij.', { exact: false }).waitFor({ timeout: 5000 }).catch(() => fail('Bakkerij gekozen: de lijst zegt niet dat dit team nog leeg is'));
  await screen('team-bakkerij');
  await tap(switcher);
  await tap(page.getByRole('menuitemradio', { name: /Mijn team/ }));
  await main.getByRole('link', { name: /Mila/ }).first().waitFor({ timeout: 5000 }).catch(() => fail('terug naar Mijn team: Mila staat niet in de lijst'));
  step('tweede team gemaakt op de telefoon via "+" › Nieuw team (knop blijft boven het toetsenbord), wisselen met de teamkiezer');

  // ================================================================ 8b. folders for chats (0.4.4, PARITEIT 4.2)
  // On a phone there is no dragging: the chat menu's "Verplaats naar map…" files a chat; the folder opens and closes
  // in Chats with a finger-sized button, and closing it is remembered.
  {
    const noor = (await call(phoneToken, 'POST', '/agents', { name: 'Noor', role: 'Klantenservice', provider_id: mila.provider_id, model: mila.model, access_mode: 'auto' })).body;
    await go(`#/t/${app.ctx.chat.threadForAgent(owner.id, noor.id).id}`);
    await tap(main.getByRole('button', { name: 'Meer opties' }));
    await tap(page.getByRole('button', { name: 'Meer acties', exact: true }));
    await tap(page.getByRole('button', { name: 'Verplaats naar map…' }));
    const dlg = page.getByRole('dialog', { name: 'Noor verplaatsen naar een map' });
    await dlg.waitFor({ timeout: 8000 });
    await typeInto(dlg.getByLabel('Nieuwe map', { exact: true }), 'Klanten');
    await screen('verplaats-naar-map');
    await tap(dlg.getByRole('button', { name: 'Maken' }));
    const folders = async () => (await call(phoneToken, 'GET', '/chat-folders')).body.folders || [];
    await until(async () => (await folders())[0]?.items?.length === 1, 8000, 'map niet gemaakt vanaf de telefoon');
    await tap(page.getByRole('link', { name: 'Terug naar chats' }));
    const folder = main.getByRole('group', { name: 'Map Klanten' });
    await folder.getByRole('link', { name: /Noor/ }).first().waitFor({ timeout: 8000 }).catch(() => fail('telefoon: Noor staat niet in de map Klanten'));
    const toggle = folder.locator('button[aria-controls]');
    await bigEnough(toggle, 'map Klanten open- en dichtklappen');
    await bigEnough(folder.getByRole('button', { name: 'Opties voor de map Klanten' }), 'opties van de map');
    await screen('chats-met-map');
    await tap(toggle);
    await until(async () => (await folders())[0]?.collapsed === true, 5000, 'dichtklappen van de map niet onthouden');
    if (await folder.getByRole('link', { name: /Noor/ }).count()) fail('telefoon: de dichte map toont Noor nog');
    await tap(toggle);
    step('mappen voor chats op de telefoon: Verplaats naar map… met een nieuwe map, de map staat in Chats, dichtklappen onthouden, grote knoppen');
  }

  // ================================================================ 8c. own rules in plain words (P6)
  // On the phone a stricter rule is added as on the computer; a looser one (and removing a strict one) says calmly
  // that it is done on the computer, and Toevoegen stays off.
  // The bot page: ?tab=meer opens Meer mogelijkheden; the own rules are its row "Eigen regels en rechten, precies".
  await go(`#/agents/${mila.id}?tab=meer&meer=1`);
  const rightsRow = main.locator('[data-section="core:rights"] h3 button');
  await rightsRow.waitFor({ timeout: 10000 }).catch(() => fail('bot-editor op de telefoon: geen rij "Eigen regels en rechten, precies" onder Meer mogelijkheden'));
  if ((await rightsRow.getAttribute('aria-expanded').catch(() => 'true')) !== 'true') await tap(rightsRow);
  const ownRules = main.getByTestId('own-rules');
  await ownRules.waitFor({ timeout: 10000 }).catch(() => fail('bot-editor op de telefoon: geen Eigen regels onder Meer mogelijkheden › Eigen regels en rechten'));
  const ruleInput = ownRules.getByRole('textbox', { name: 'Nieuwe regel' });
  await typeInto(ruleInput, 'Mail nooit naar klanten zonder mij te vragen');
  await ownRules.getByTestId('rule-preview').getByText('Eerst vragen').waitFor({ timeout: 8000 }).catch(() => fail('regel op de telefoon: geen voorbeeld van wat TeamBot ervan maakt'));
  const addRule = ownRules.getByRole('button', { name: 'Toevoegen' });
  await tap(addRule);
  await ownRules.getByTestId('own-rule').filter({ hasText: 'Mail nooit naar klanten' }).waitFor({ timeout: 8000 }).catch(() => fail('regel op de telefoon: strengere regel niet toegevoegd'));
  if (!app.ctx.store.all('SELECT id FROM bot_rules WHERE agent_id = ? AND effect = ?', mila.id, 'ask').length) fail('regel op de telefoon: niet opgeslagen');
  if (!(await ownRules.getByText('Weghalen doe je op je computer', { exact: false }).count())) fail('regel op de telefoon: niet gezegd dat weghalen op de computer gebeurt');
  await ruleInput.fill('Mag altijd bestanden maken in de map Offertes');
  await ownRules.getByText('Een regel die de bot meer laat doen, voeg je toe op je computer.').waitFor({ timeout: 8000 }).catch(() => fail('regel op de telefoon: geen uitleg dat een lossere regel op de computer gaat'));
  if (!(await addRule.isDisabled())) fail('regel op de telefoon: Toevoegen staat aan voor een regel die de bot meer laat doen');
  await screen('eigen-regels');
  await ruleInput.fill('');
  const loosen = await call(phoneToken, 'POST', '/bot-rules/loosen', { agentId: mila.id, text: 'Mag altijd bestanden maken in de map Offertes' });
  if (loosen.status !== 403 || loosen.body.code !== 'mobile_denied') fail(`regel losser maken op de telefoon gaf ${loosen.status}`);
  step('eigen regels op de telefoon: strenger toevoegen kan, losser maken en weghalen zegt rustig "op je computer"');

  // ================================================================ 9. computer-only: the reason, calmly
  expected = [/^403 GET \/api\/(sessions|secrets)$/];
  // 0.4.4 P8: the desktop app says the owner sits at the pc (checked on this page below).
  app.ctx.services.mobile.reportPresence(owner.id, { idleSeconds: 2, locked: false });
  await go('#/settings/mobile-telefoon');
  await main.getByText('Dit apparaat').first().waitFor({ timeout: 8000 });
  if (!(await main.getByText('Koppelen, beheer en sleutels bekijken kan alleen op je computer.', { exact: false }).count())) fail('Telefoon: niet gezegd dat koppelen op de computer gebeurt');
  if (await main.getByText('beperkte toegang', { exact: false }).count()) fail('Telefoon: oude tekst "beperkte toegang" (sinds 0.4.1 kan de telefoon bijna alles)');
  await screen('instellingen-telefoon');
  // 0.4.4 P8: the phone gets alerts only when you are away from the pc; "Altijd ook op de telefoon" sends both.
  const always = main.getByRole('switch', { name: 'Altijd ook op de telefoon' });
  await always.waitFor({ timeout: 8000 }).catch(() => fail('Telefoon: schakelaar "Altijd ook op de telefoon" ontbreekt'));
  if (!(await main.getByText('Je zit nu achter de pc: meldingen komen alleen op Windows.', { exact: false }).count())) fail('Telefoon: niet gezegd dat meldingen nu alleen op Windows komen');
  await tap(always);
  await until(() => app.ctx.store.getSetting(owner.id, 'mobilePush', {})?.alwaysPhone === true, 5000, 'Altijd ook op de telefoon niet opgeslagen');
  await main.getByText('Meldingen gaan naar de pc én naar je telefoon', { exact: false }).waitFor({ timeout: 5000 }).catch(() => fail('Telefoon: uitleg bij Altijd ook op de telefoon ontbreekt'));
  await screen('instellingen-telefoon-meldingen');
  await tap(always);
  step('meldingen op de goede plek: achter de pc alleen Windows, Altijd ook op de telefoon aan en weer uit');
  await go('#/settings/security');
  await main.getByText('Inlogsessies beheer je op je computer.').waitFor({ timeout: 8000 }).catch(() => fail('Beveiliging: geen uitleg bij de sessies'));
  await main.getByText('Opgeslagen sleutels bekijken kan alleen op je computer.').waitFor({ timeout: 8000 }).catch(() => fail('Beveiliging: geen uitleg bij de opgeslagen geheimen'));
  await screen('instellingen-beveiliging');
  await go('#/settings/backups');
  await main.getByText('Al je gegevens exporteren kan alleen op je computer.').waitFor({ timeout: 8000 }).catch(() => fail('Back-ups: geen uitleg bij exporteren'));
  if (await main.getByRole('link', { name: 'Exporteren' }).count()) fail('Back-ups: knop Exporteren op de telefoon (geeft 403)');
  // Updates of TeamBot (0.4.4): the status on the phone, calm without a channel, and Automatisch bijwerken works here.
  const upd = main.getByTestId('app-update');
  await upd.getByText('Nieuwe versies van TeamBot krijg je met de volgende installer.').waitFor({ timeout: 8000 }).catch(() => fail('Back-ups: de updatestatus staat niet op de telefoon'));
  const autoSel = upd.getByLabel('Automatisch bijwerken');
  if ((await autoSel.getAttribute('data-value').catch(() => '')) !== 'on') fail('Back-ups: Automatisch bijwerken niet zichtbaar of niet standaard aan op de telefoon');
  // TeamBot's own dropdown (components/Listbox.tsx): open it and tap the option.
  await tap(autoSel);
  await tap(page.locator('[role="listbox"] [role="option"][data-value="notify"]')).catch(() => fail('Back-ups: Automatisch bijwerken niet te kiezen op de telefoon'));
  for (let i = 0; i < 30 && (await call(phoneToken, 'GET', '/app-update')).body.auto !== 'notify'; i++) await sleep(100);
  if ((await call(phoneToken, 'GET', '/app-update')).body.auto !== 'notify') fail('Back-ups: "Alleen melden" vanaf de telefoon niet opgeslagen');
  await screen('instellingen-back-ups');
  await go('#/settings/data');
  await main.getByRole('heading', { name: 'Privacy en gegevens' }).first().waitFor({ timeout: 8000 });
  if (await main.getByText('Diagnosebestand downloaden').count()) fail('Gegevens: diagnosebestand downloaden op de telefoon (kan alleen op de computer)');
  if (await main.getByText('· Node', { exact: false }).count()) fail('Gegevens: lege regel Platform op de telefoon');
  await screen('instellingen-gegevens');
  await go('#/m/browser/kluis');
  await main.getByText('De kluis met wachtwoorden open je alleen op je computer.').waitFor({ timeout: 8000 }).catch(() => fail('Kluis: geen uitleg'));
  if (await main.getByRole('button', { name: 'Login toevoegen' }).count()) fail('Kluis: knop "Login toevoegen" op de telefoon (kan alleen op de computer)');
  await screen('kluis');
  expected = [];
  step('alleen-op-de-computer: Telefoon, Beveiliging, Back-ups en Kluis zeggen rustig waarom, zonder rode fouten of knoppen die niet werken; de updatestatus en Automatisch bijwerken werken op de telefoon, het updatekanaal niet');

  // ================================================================ 9b. overstappen uit Hermes Agent (0.4.4, PARITEIT 1.7)
  // From the phone, the owner reads a (fake) Hermes folder on his computer, imports it and undoes it again; Grok Bot
  // says plainly that there is nothing to import.
  {
    const { makeHermesFixture } = await import('../fixtures/hermes/fixture.ts');
    const hx = makeHermesFixture();
    try {
      await go('#/m/openbot-import?bron=hermes');
      await main.getByText('Hermes Agent niet gevonden in de standaardmap').waitFor({ timeout: 8000 });
      await main.getByRole('textbox', { name: 'Hermes-map' }).fill(hx.home);
      await tap(main.getByRole('button', { name: 'Hermes inlezen' }));
      await main.getByText('Dit is een voorvertoning', { exact: false }).waitFor({ timeout: 15000 });
      await screen('overstappen-hermes');
      await tap(main.getByRole('button', { name: 'Importeren', exact: true }));
      await main.getByText('Je Hermes-bots zijn overgenomen').waitFor({ timeout: 15000 });
      const names = (await pc('GET', '/agents')).map((a) => a.name);
      if (!names.includes('Hermes') || !names.includes('Schrijver')) fail(`Hermes: bots niet overgenomen (${names.join(', ')})`);
      await tap(main.getByRole('button', { name: 'Import ongedaan maken' }));
      await tap(page.getByRole('dialog').getByRole('button', { name: 'Ongedaan maken' }));
      await main.getByText('De import is ongedaan gemaakt').waitFor({ timeout: 15000 });
      if ((await pc('GET', '/agents')).some((a) => a.name === 'Schrijver')) fail('Hermes: ongedaan maken liet de bots staan');
      await tap(main.getByRole('tab', { name: 'Grok Bot' }));
      await main.getByText('Grok Bot kun je niet importeren.').waitFor({ timeout: 8000 });
      await screen('overstappen-grok');
    } finally {
      hx.cleanup();
    }
  }
  step('overstappen uit Hermes Agent op de telefoon: map inlezen, voorbeeld, importeren, ongedaan maken; Grok Bot zegt eerlijk dat er niets te importeren is');

  // ================================================================ 10. every page of the app, as the phone (0.4.3)
  // Lesson from 0.4.1: the owner could not even send a message from his phone, because nobody tested as a phone. Every
  // row of Instellingen (with "Geavanceerd tonen" on, so the expert rows show too), every module page and the detail
  // pages of what the phone made above open without a failed request, an error toast (red or grey), a page error, a red
  // error note or "niet beschikbaar". A computer-only place (policy.ts COMPUTER_ONLY) says so with its calm note and
  // does not even ask the server.
  const st = (await call(phoneToken, 'GET', '/settings')).body;
  await call(phoneToken, 'PUT', '/settings', { ui: { ...(st.ui || {}), advanced: true } });
  await page.reload();
  await tabs.waitFor({ timeout: 15000 });
  await go('#/settings');
  const settingsNav = main.getByRole('navigation', { name: 'Instellingen' });
  await settingsNav.waitFor({ timeout: 10000 });
  const mainRows = await settingsNav.locator('a[href^="#/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  // One list, every row opens one thing: what you set yourself, then "Van je bots", then Meer mogelijkheden (the one
  // place for everything optional). No overview pages in between.
  const WANT_ROWS = ['#/settings/providers', '#/settings/telefoon', '#/settings/general', '#/settings/regels', '#/settings/veilig', '#/settings/slot', '#/agents', '#/settings/teams', '#/m/memory/', '#/m/channels/', '#/m/mcp/', '#/m/folders/', '#/settings/meer'];
  if (mainRows.join(' ') !== WANT_ROWS.join(' ')) fail(`Instellingen op de telefoon: de regels zijn ${mainRows.join(', ')}; verwacht ${WANT_ROWS.join(', ')}`);
  // Everything else hangs under its row: "Meer" under the row's page, or the overview of Meer mogelijkheden (all of it).
  const settingRows = [...mainRows];
  for (const row of mainRows) {
    await go(row);
    await page.waitForTimeout(500);
    settingRows.push(...(await main.locator('nav[aria-label="Meer"] a[href^="#/"], nav[aria-label="Onderdelen"] a[href^="#/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')))));
  }
  if (!settingRows.includes('#/settings/network-proxy')) fail('Meer mogelijkheden op de telefoon: Netwerk en proxy ontbreekt');
  // Module pages straight from the UI modules' sources (`{ path: 'x', title: … }`), so a new page is swept too.
  const modDir = fileURLToPath(new URL('../../ui/src/modules', import.meta.url));
  const modulePages = fs
    .readdirSync(modDir)
    .filter((m) => fs.existsSync(path.join(modDir, m, 'index.tsx')))
    .flatMap((m) => [...fs.readFileSync(path.join(modDir, m, 'index.tsx'), 'utf8').matchAll(/\{\s*path:\s*'([^']*)',\s*title:/g)].map((x) => `#/m/${m}/${x[1]}`));
  const routine = (await call(phoneToken, 'GET', '/routines')).body.find?.((r) => r.name === 'Ochtendoverzicht');
  const memory = app.ctx.store.all('SELECT id FROM memory_items WHERE user_id = ? LIMIT 1', owner.id)[0];
  // Pages that need an id: the detail of what the phone made above (a page without its id is not a page).
  const channel = await call(phoneToken, 'POST', '/channels/bindings', { adapter: 'webhook', name: 'Eigen app', agent_id: mila.id, enabled: false, config: { replyMode: 'none' }, secrets: { signingSecret: 'telefoon-webhook-geheim-0123456789' } });
  if (channel.status !== 200 || !channel.body.id) fail(`kanaal maken op de telefoon: ${channel.status} ${JSON.stringify(channel.body).slice(0, 160)}`);
  const withId = {
    '#/m/routines/r': routine && `#/m/routines/r/${routine.id}`,
    '#/m/memory/item': memory && `#/m/memory/item/${memory.id}`,
    '#/m/seen/': `#/m/seen/${mila.id}`,
    '#/m/rooms/groep': null,
    '#/m/mcp/c': null,
  };
  const sweepPages = [
    ...new Set([
      '#/',
      `#/t/${thread.id}`,
      `#/a/${mila.id}`,
      '#/agents',
      `#/agents/${mila.id}`,
      '#/agents/new',
      '#/inbox',
      '#/tasks',
      '#/more',
      '#/search',
      '#/search?q=melk',
      ...settingRows,
      ...(channel.body.id ? [`#/m/channels/${channel.body.id}`] : []),
      ...modulePages.map((h) => (h in withId ? withId[h] : h)).filter(Boolean),
    ]),
  ];
  let swept = 0;
  for (const h of sweepPages) {
    await go(h);
    await page.waitForTimeout(700);
    const seen = await page.evaluate(() => {
      const visible = (e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
      };
      const m = document.querySelector('#inhoud');
      return {
        text: m?.innerText || '',
        toasts: [...document.querySelectorAll('[aria-live="polite"].fixed > *')].filter(visible).map((e) => e.textContent.trim()).filter(Boolean),
        danger: [...(m?.querySelectorAll('[class*="bg-danger-soft"], [role="alert"]') || [])].filter(visible).map((e) => e.textContent.trim()).filter((x) => x && x !== 'Met gevolgen'),
        // ("Met gevolgen" is the badge of a logbook line, e.g. a new bot that started on Volledige toegang: not an error.)
        // A download or link the server refuses for a phone (policy.ts COMPUTER_ONLY) is a dead button.
        deadLinks: [...(m?.querySelectorAll('a[href*="/api/"]') || [])].filter(visible).map((a) => new URL(a.href).pathname).filter((p) => /^\/api\/(admin|export|memory\/export|secrets|computers\/vault|sessions)(\/|$)/.test(p)),
      };
    });
    const where = `elke pagina ${h}`;
    if (/Pagina niet gevonden/.test(seen.text)) fail(`${where}: "Pagina niet gevonden"`);
    if (/niet beschikbaar/i.test(seen.text)) fail(`${where}: zegt "niet beschikbaar": ${seen.text.match(/[^\n]*niet beschikbaar[^\n]*/i)?.[0].slice(0, 160)}`);
    if (/undefined|NaN|\[object Object\]/.test(seen.text)) fail(`${where}: toont "${seen.text.match(/[^\n]*(undefined|NaN|\[object Object\])[^\n]*/)?.[0].slice(0, 120)}"`);
    if (seen.toasts.length) fail(`${where}: melding bij het openen: ${seen.toasts.join(' | ').slice(0, 200)}`);
    if (seen.danger.length) fail(`${where}: rode foutmelding: ${seen.danger.join(' | ').slice(0, 200)}`);
    if (seen.deadLinks.length) fail(`${where}: link naar iets wat alleen op de computer kan: ${seen.deadLinks.join(', ')}`);
    if (failed.length) fail(`${where}: mislukte verzoeken: ${failed.splice(0).join(', ')}`);
    if (errors.length) fail(`${where}: paginafouten: ${errors.splice(0).join(' | ').slice(0, 300)}`);
    swept++;
  }
  // A channel's Toegang tab on the phone: no "Dit ben ik" / "Voor mezelf" switches the server refuses, but the reason.
  if (channel.body.id) {
    await go(`#/m/channels/${channel.body.id}`);
    await tap(main.getByRole('tab', { name: /^Toegang/ }));
    await main.getByText('Een afzender als jezelf markeren', { exact: false }).waitFor({ timeout: 8000 }).catch(() => fail('Kanaal › Toegang: geen uitleg dat "Dit ben ik" op de computer gebeurt'));
    if (await main.getByText('Dit ben ik', { exact: true }).count()) fail('Kanaal › Toegang: schakelaar "Dit ben ik" op de telefoon (de server weigert dat)');
    if (await main.getByText('Voor mezelf', { exact: true }).count()) fail('Kanaal › Toegang: schakelaar "Voor mezelf" op de telefoon (de server weigert dat)');
    await screen('kanaal-toegang');
  }
  await call(phoneToken, 'PUT', '/settings', { ui: { ...(st.ui || {}), advanced: false } });
  await go('#/');
  await page.reload();
  await tabs.waitFor({ timeout: 15000 });
  step(`elke pagina als telefoon (${swept} pagina's: alle rijen van Instellingen met Geavanceerd tonen, alle modulepagina's, de details): geen mislukte verzoeken, foutmeldingen of "niet beschikbaar"`);

  // ================================================================ 11. widths 390 and 430, no sideways scrolling
  for (const width of [390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    for (const h of ['#/', `#/t/${thread.id}`, '#/inbox', '#/more', '#/tasks', '#/m/routines/', '#/m/memory/', '#/m/skills/', '#/settings', '#/settings/general', '#/agents/new']) {
      await go(h);
      await page.waitForTimeout(400);
      const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (o > 1) fail(`${width}px: ${h} schuift ${o}px opzij`);
    }
  }
  step('390 en 430 px: geen enkel scherm schuift opzij');

  if ((await page.evaluate(() => window.__nativeWords)).includes('unauthorized')) fail('de app kreeg ergens een 401 (zou de koppeling laten controleren)');

  // ================================================================ 12. the desktop default stays as it was
  const desk = await browser.newContext({ viewport: { width: 1360, height: 880 }, colorScheme: 'light', locale: 'nl-NL' });
  const dp = await desk.newPage();
  await dp.goto(`${app.url}/#token=${pcToken}`);
  await dp.waitForTimeout(1500);
  if (await dp.evaluate(() => document.documentElement.classList.contains('dark'))) fail('computer: het thema werd donker zonder keuze (moet het systeem volgen)');
  const deskField = await dp.evaluate(() => {
    const e = document.querySelector('textarea[aria-label="Bericht"]');
    return e ? parseFloat(getComputedStyle(e).fontSize) : null;
  });
  if (deskField !== null && deskField !== 15) fail(`computer: invoerveld ${deskField}px (hoort 15px te blijven)`);
  await desk.close();
  step('computer: thema volgt het systeem zoals altijd, lettergrootte ongewijzigd');
} catch (e) {
  fail(e.stack || e.message);
  await shot('fout').catch(() => {});
} finally {
  await browser.close();
  await app.close();
  for (const d of [dir, home]) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* left in the temp folder */
    }
  }
}
if (errors.length) fail('console-fouten:\n  ' + errors.join('\n  '));
console.log(failures.length ? `TELEFOON (EIGENAAR) MISLUKT: ${failures.length} bevinding(en)` : 'TELEFOON (EIGENAAR) GESLAAGD');
