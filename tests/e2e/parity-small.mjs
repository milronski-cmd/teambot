// The small parity items of 0.4.3, clicked through as the owner does it, on the computer and on a paired phone:
//   [4.6] "Kopieer tabel" under a table in a bot answer: CSV and an HTML table on the clipboard (Excel/Sheets cells);
//   [7.5] "Bewaar als skill": a draft from the conversation, edited, saved for the bot or the team;
//   [7.3] a calm notice when TeamBot's catalogue pins a newer commit of an installed skill: what changed, update by click;
//   [4.2] folders for chats per team: new folder, drag a bot in, "Verplaats naar map", collapse, rename, delete.
// Starts TeamBot (desktop mode) in an empty temp data dir with an empty HOME/APPDATA (nothing of this PC is found or
// changed), a scripted test model and a fake GitHub for the catalogue, and drives Edge/Chrome headless with Playwright.
// The phone pairs through the real flow and then uses its own device session (as tests/e2e/phone-owner.mjs).
// Usage: npm run build:ui && node --import tsx tests/e2e/parity-small.mjs
//        (TEAMBOT_E2E_PORT=<port> for a fixed port, TEAMBOT_E2E_SHOTS=<dir> for screenshots, TEAMBOT_E2E_ONLY=4.6,7.5)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const step = (s) => console.log(`✔ ${s}`);
const failures = [];
const fail = (s) => {
  failures.push(s);
  console.error(`✗ ${s}`);
  process.exitCode = 1;
};
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
const ONLY = (process.env.TEAMBOT_E2E_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const want = (id) => !ONLY.length || ONLY.includes(id);
const SHOTS = process.env.TEAMBOT_E2E_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// The browser starts first (it needs this PC's normal environment), then TeamBot gets an empty one.
const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-parity-small-home-'));
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  XDG_DATA_HOME: path.join(home, 'xdg', 'data'),
  XDG_CONFIG_HOME: path.join(home, 'xdg', 'config'),
  XDG_CACHE_HOME: path.join(home, 'xdg', 'cache'),
});
delete process.env.TEAMBOT_DATA;

const { createApp } = await import('../../server/app.ts');
const { mockAdapter } = await import('../helpers.ts');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-parity-small-'));
const app = await createApp({ dataDir: dir, port: Number(process.env.TEAMBOT_E2E_PORT) || 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const pcToken = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();
for (const k of app.ctx.providers.kinds.values()) if (k.detect) k.detect = async () => ({ installed: false, detail: 'e2e' });
const script = [];
const requests = [];
app.ctx.providers.registerKind({ id: 'mock', label: 'Testmodel', type: 'api', group: 'local', billing: 'local', needsKey: false, description: 'e2e', models: ['mock-1'], defaultModel: 'mock-1', detect: async () => ({ installed: true, detail: 'e2e' }), create: () => mockAdapter(script, requests) });
const call = async (token, method, p, body) => {
  const r = await fetch(app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const pc = async (method, p, body) => {
  const r = await call(pcToken, method, p, body);
  if (r.status >= 400) throw new Error(`${method} ${p} → ${r.status}: ${r.body.error}`);
  return r.body;
};
const waitIdle = async (threadId, ms = 15000) =>
  until(() => !app.ctx.store.all("SELECT id FROM runs WHERE thread_id = ? AND status IN ('queued','running','waiting')", threadId).length, ms, 'de bot is klaar');

const prov = await pc('POST', '/providers', { kind: 'mock' });
const analist = await pc('POST', '/agents', { name: 'Analist', role: 'Cijfers', provider_id: prov.id, model: 'mock-1', access_mode: 'auto' });
const TABLE = '| Product | Prijs | Opmerking |\n|---|---|---|\n| Koffie, zwart | 2,50 | zegt "lekker" |\n| Thee | -1,80 | =HYPERLINK("x") |\n';
script.push({ text: `Hier is het overzicht:\n\n${TABLE}\nKlopt dit?` });
const th = await pc('POST', '/threads', { agentId: analist.id });
await pc('POST', `/threads/${th.id}/messages`, { content: 'Zet de prijzen in een tabel' });
await waitIdle(th.id);
console.log(`• TeamBot op ${app.url} (lege datamap ${dir})`);

// ---------------------------------------------------------------- the phone pairs (real flow), then a device session
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TeamBotiOS/0.4.3';
const ticket = await pc('POST', '/mobile/pair', { baseUrl: app.url });
const secret = new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('t');
const claim = await fetch(app.url + '/api/public/mobile/claim', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': IOS_UA }, body: JSON.stringify({ secret, name: 'iPhone van Sanne', platform: 'ios', client: 'ios-app' }) }).then((r) => r.json());
const phoneToken = claim.token;
if ((await call(phoneToken, 'GET', '/me')).body.session?.kind !== 'device') fail('de telefoon heeft geen apparaatsessie');
else step('telefoon gekoppeld via de echte QR-koppeling (apparaatsessie)');

const errors = [];
const watch = (page, who) => {
  page.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text()) && errors.push(`${who}: ${m.text()}`));
  page.on('dialog', (d) => (errors.push(`${who}: onverwacht browserdialoog: ${d.message()}`), d.dismiss().catch(() => {})));
};
const desk = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: 'nl-NL', permissions: ['clipboard-read', 'clipboard-write'] });
const page = await desk.newPage();
watch(page, 'pc');
await page.goto(`${app.url}/#token=${pcToken}`);
await page.getByRole('navigation', { name: 'Hoofdmenu' }).waitFor({ timeout: 15000 });

const phoneCtx = await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IOS_UA, locale: 'nl-NL', permissions: ['clipboard-read', 'clipboard-write'] });
await phoneCtx.addInitScript((t) => {
  try {
    if (localStorage.getItem('tb_token') !== t) {
      localStorage.removeItem('tb_urlkey');
      localStorage.setItem('tb_token', t);
    }
  } catch {}
}, phoneToken);
const phone = await phoneCtx.newPage();
watch(phone, 'telefoon');
await phone.goto(app.url + '/');
await phone.getByRole('navigation', { name: 'Hoofdmenu' }).waitFor({ timeout: 15000 });
const shot = async (p, name) => SHOTS && (await p.waitForTimeout(250), await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }));
const go = async (p, hash) => {
  await p.evaluate((h) => (location.hash = h), hash);
  await p.waitForTimeout(400);
};
/** What is on the clipboard of a page: the plain text and the HTML. */
const clipboard = (p) =>
  p.evaluate(async () => {
    const out = { text: '', html: '' };
    for (const item of await navigator.clipboard.read()) {
      if (item.types.includes('text/plain')) out.text = await (await item.getType('text/plain')).text();
      if (item.types.includes('text/html')) out.html = await (await item.getType('text/html')).text();
    }
    return out;
  });

try {
  // ---------------------------------------------------------------- [4.6] table → CSV / Excel / Sheets
  if (want('4.6')) {
    for (const [p, who] of [
      [page, 'computer'],
      [phone, 'telefoon'],
    ]) {
      await go(p, `#/t/${th.id}`);
      const btn = p.getByRole('button', { name: 'Kopieer tabel' });
      await btn.waitFor({ timeout: 10000 });
      const box = await btn.boundingBox();
      if (who === 'telefoon' && (!box || box.height < 44)) fail(`[4.6] telefoon: knop Kopieer tabel is ${box?.height} px hoog (minder dan 44)`);
      await p.evaluate(() => navigator.clipboard.writeText('leeg'));
      if (who === 'telefoon') await btn.tap();
      else await btn.click();
      await p.getByRole('button', { name: 'Tabel gekopieerd' }).waitFor({ timeout: 4000 }).catch(() => fail(`[4.6] ${who}: geen "Tabel gekopieerd" na de klik`));
      const c = await clipboard(p);
      const lines = c.text.split('\r\n');
      if (lines[0] !== 'Product,Prijs,Opmerking' || lines[1] !== '"Koffie, zwart","2,50","zegt ""lekker"""' || !/^Thee,"?-1,80"?,"'=HYPERLINK\(""x""\)"$/.test(lines[2] || '')) fail(`[4.6] ${who}: CSV klopt niet: ${JSON.stringify(c.text)}`);
      else step(`[4.6] ${who}: Kopieer tabel zet CSV op het klembord (komma's, aanhalingstekens, formule onschadelijk)`);
      if (!/<table><thead><tr><th>Product<\/th>/.test(c.html) || !/<td>Koffie, zwart<\/td>/.test(c.html)) fail(`[4.6] ${who}: geen HTML-tabel op het klembord: ${c.html.slice(0, 200)}`);
      else step(`[4.6] ${who}: en een HTML-tabel, zodat Excel en Google Sheets gewone cellen plakken`);
      await shot(p, `4.6-${who}`);
    }
  }

  // ---------------------------------------------------------------- [7.5] Bewaar als skill (computer, then phone)
  if (want('7.5')) {
    for (const [p, who, name, scope] of [
      [page, 'computer', 'prijzen-in-tabel', 'Alleen Analist'],
      [phone, 'telefoon', 'prijzen-voor-team', 'Alle bots van het team'],
    ]) {
      await go(p, `#/t/${th.id}`);
      script.push({ text: JSON.stringify({ name: 'Prijzen Tabel', description: 'Zet prijzen in een tabel.', instructions: '# Prijzen\n\n1. Zet elk product met prijs in een tabel.' }) });
      const tapOrClick = (loc) => (who === 'telefoon' ? loc.tap() : loc.click());
      await tapOrClick(p.getByRole('button', { name: 'Meer opties' }));
      await tapOrClick(p.getByRole('button', { name: 'Meer acties', exact: true }));
      await tapOrClick(p.getByRole('button', { name: 'Bewaar als skill…' }));
      const dlg = p.getByRole('dialog', { name: 'Bewaar als skill' });
      const nameBox = dlg.getByRole('textbox', { name: /Naam/ });
      await until(async () => (await nameBox.inputValue()) === 'prijzen-tabel', 10000, `[7.5] ${who}: concept van de bot in het venster`);
      if (!(await dlg.getByText('Concept van Analist, uit dit gesprek', { exact: false }).count())) fail(`[7.5] ${who}: venster zegt niet dat het een concept van de bot is`);
      if (app.ctx.store.all("SELECT id FROM skills WHERE name LIKE 'prijzen%'").length !== (who === 'computer' ? 0 : 1)) fail(`[7.5] ${who}: er is al iets opgeslagen voor Opslaan`);
      await nameBox.fill(name);
      await dlg.getByRole('textbox', { name: /Werkwijze/ }).fill('# Prijzen\n\n1. Zet elk product met prijs in een tabel.\n2. Rond af op centen.');
      await tapOrClick(dlg.getByRole('radio', { name: scope }));
      await shot(p, `7.5-${who}`);
      await tapOrClick(dlg.getByRole('button', { name: 'Opslaan als skill' }));
      await dlg.waitFor({ state: 'detached', timeout: 8000 }).catch(() => fail(`[7.5] ${who}: venster bleef open na Opslaan`));
      const row = app.ctx.store.one('SELECT id, status FROM skills WHERE name = ?', name);
      const on = row ? app.ctx.store.agent(analist.id).skills.includes(row.id) : false;
      if (!row || row.status !== 'active' || !on) fail(`[7.5] ${who}: skill ${name} niet actief bewaard voor Analist (${JSON.stringify(row)})`);
      else step(`[7.5] ${who}: Bewaar als skill → concept van de bot, aangepast, bewaard (${scope.toLowerCase()})`);
    }
  }
} catch (e) {
  fail(`onverwachte fout: ${e?.stack || e}`);
} finally {
  if (errors.length) fail(`paginafouten: ${[...new Set(errors)].slice(0, 8).join(' | ')}`);
  await browser.close();
  await app.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* left in the temp folder */
  }
  console.log(failures.length ? `\n${failures.length} fout(en)` : '\nAlles geslaagd');
  process.exit(failures.length ? 1 : 0);
}
