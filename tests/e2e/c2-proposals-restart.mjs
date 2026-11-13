// End-to-end (release gate): a lead's hire proposal and an approval that survives a crash, in the real UI.
//  A. A group lead proposes a new member → card in "Wacht op jou" (counted in the badge) and in the group chat;
//     approve from the chat card → the bot exists only now; decline from Wacht op jou on the phone → nothing created.
//  B. A bot waits for approval, a message waits in the queue, TeamBot "crashes" (the rows are left as a hard kill
//     leaves them) and restarts on the same data → the approval is back with the run and the queue, says so,
//     offers "Toestaan en hervatten" (no "Altijd"); approving resumes the run and the file is written exactly once.
// Mock engine only (no real AI). Usage: npm run build:ui && node --import tsx tests/e2e/c2-proposals-restart.mjs
// TEAMBOT_UI_DIR=<built ui> to use another build, TEAMBOT_E2E_SHOTS=<dir> for screenshots (desktop + phone).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright-core');
const { createApp } = await import('./server.mjs');
const { mockAdapter } = await import('../helpers.ts');

const step = (s) => console.log(`• ${s}`);
let failed = 0;
const fail = (s) => {
  console.error(`✗ ${s}`);
  failed++;
  process.exitCode = 1;
};
const check = (ok, s) => (ok ? step(s) : fail(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = process.env.TEAMBOT_E2E_SHOTS || '';
if (shots) fs.mkdirSync(shots, { recursive: true });
const shot = async (page, name) => shots && page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: false });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-c2-e2e-'));
const script = [];
const requests = [];
const kind = () => ({ id: 'mock', label: 'Mock', type: 'api', needsKey: false, description: 'test', models: ['mock-1'], defaultModel: 'mock-1', create: () => mockAdapter(script, requests) });

async function boot() {
  const app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
  app.ctx.providers.registerKind(kind());
  const token = app.ctx.auth.ensureLocalOwner();
  const api = async (method, p, body) => {
    const res = await fetch(app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${j.error}`);
    return j;
  };
  return { app, token, api };
}
async function idle(app, threadId, ms = 10_000) {
  const start = Date.now();
  await sleep(60);
  while (Date.now() - start < ms) {
    if (!app.ctx.store.all("SELECT id FROM runs WHERE thread_id = ? AND status IN ('queued','running','waiting')", threadId).length) return;
    await sleep(30);
  }
  throw new Error('runs did not finish');
}
async function until(fn, ms = 10_000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(40);
  }
  throw new Error('condition not met in time');
}
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

let { app, token, api } = await boot();
step(`TeamBot op ${app.url} (data ${dir})`);
const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const errors = [];
const watch = (page) => {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED|WebSocket/.test(m.text()) && errors.push(m.text()));
};

try {
  const prov = await api('POST', '/providers', { kind: 'mock' });
  await api('PUT', '/settings', { onboarded: true, defaultProvider: prov.id });
  const bot = (name, extra = {}) => api('POST', '/agents', { name, provider_id: prov.id, model: 'mock-1', access_mode: 'ask', ...extra });
  const ada = await bot('Ada', { role: 'Hoofdredacteur', tool_groups: ['team'] });
  const bo = await bot('Bo', { role: 'Schrijver' });
  const made = await api('POST', '/rooms', { name: 'Redactie', agentIds: [ada.id, bo.id], mode: 'lead', leadAgentId: ada.id });
  const roomThread = made.threadId;

  // ---------------------------------------------------------------- A. hire proposal
  script.push(
    { toolCalls: [{ name: 'propose_member', args: { name: 'Eva', role: 'Copywriter', description: 'Schrijft korte, heldere teksten.', instructions: 'Schrijf teksten voor de nieuwsbrief.', reason: 'We missen iemand voor de teksten van de nieuwsbrief.' } }] },
    { text: 'Ik stel Eva voor als copywriter.' },
  );
  await api('POST', `/threads/${roomThread}/messages`, { content: 'Wie missen we nog in het team?' });
  await idle(app, roomThread);
  check((await api('GET', '/rooms/proposals')).filter((p) => p.status === 'pending').length === 1, 'lead heeft een voorstel gedaan (wacht op goedkeuring)');

  const desk = await browser.newContext({ viewport: { width: 1360, height: 880 } });
  const page = await desk.newPage();
  watch(page);
  await page.goto(`${app.url}/#token=${token}`);
  await page.getByRole('navigation').first().waitFor({ timeout: 15000 }).catch(() => {});
  await page.goto(`${app.url}/#/inbox`);
  const inboxCard = page.getByRole('group', { name: /Voorstel: Eva toevoegen aan Redactie/ });
  await inboxCard.waitFor({ timeout: 10000 });
  check(await page.getByRole('heading', { name: /Nieuwe teamleden/ }).isVisible(), 'Wacht op jou: sectie "Nieuwe teamleden"');
  check((await inboxCard.innerText()).includes('Bestaat pas na jouw akkoord'), 'kaart zegt dat de bot pas na akkoord bestaat');
  const badge = await page.locator('a[href="#/inbox"]').first().innerText();
  check(/1/.test(badge), `zijbalk telt het voorstel mee (${badge.replace(/\s+/g, ' ').trim()})`);
  check(!/prop_|null|undefined/.test(await inboxCard.innerText()), 'geen ids of null op de kaart');
  await shot(page, 'c2-2-wacht-op-jou-desktop');

  await page.goto(`${app.url}/#/t/${roomThread}`);
  const chatCard = page.getByRole('group', { name: /Voorstel: Eva toevoegen aan Redactie/ });
  await chatCard.waitFor({ timeout: 10000 });
  check(await chatCard.getByRole('button', { name: 'Goedkeuren' }).isVisible(), 'groepschat: voorstel als kaart met Goedkeuren');
  check(!(await api('GET', '/agents')).some((a) => a.name === 'Eva'), 'Eva bestaat nog niet vóór akkoord');
  await chatCard.getByRole('button', { name: 'Voorgesteld profiel bekijken' }).click();
  await shot(page, 'c2-2-groepschat-kaart-desktop');
  if (shots) {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(200);
    await shot(page, 'c2-2-groepschat-kaart-donker');
    await page.emulateMedia({ colorScheme: 'light' });
  }
  await chatCard.getByRole('button', { name: 'Goedkeuren' }).click();
  await chatCard.getByText('Goedgekeurd').waitFor({ timeout: 10000 });
  const eva = (await api('GET', '/agents')).find((a) => a.name === 'Eva');
  check(!!eva, 'na akkoord bestaat Eva');
  check((await api('GET', `/rooms/${made.room.id}`)).bots.some((b) => b.agentId === eva?.id), 'Eva is lid van de groep');
  check(await chatCard.getByRole('link', { name: /Chat met Eva/ }).isVisible(), 'kaart toont de uitkomst met link naar de chat van Eva');
  await page.waitForTimeout(400);
  await shot(page, 'c2-2-groepschat-goedgekeurd-desktop');
  await page.goto(`${app.url}/#/inbox`);
  await page.getByText('Niets dat op je wacht').waitFor({ timeout: 10000 });
  step('Wacht op jou is weer leeg');
  await page.goto(`${app.url}/#/m/rooms/`);
  await page.getByRole('heading', { name: 'Groepschats' }).first().waitFor();
  check(!(await page.getByText('Voorstellen voor nieuwe teamleden').count()), 'Groepen: geen open voorstel meer');

  // Second proposal: decline on the phone from Wacht op jou; the group chat card follows live.
  script.push({ toolCalls: [{ name: 'propose_member', args: { name: 'Fien', role: 'Fotograaf', reason: 'Beelden bij de artikelen.' } }] }, { text: 'En Fien voor de foto’s.' });
  await api('POST', `/threads/${roomThread}/messages`, { content: 'En voor de beelden?' });
  await idle(app, roomThread);
  const phoneCtx = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 390, height: 844 } });
  const phone = await phoneCtx.newPage();
  watch(phone);
  await phone.goto(`${app.url}/#token=${token}`);
  await phone.goto(`${app.url}/#/t/${roomThread}`);
  const phoneChat = phone.getByRole('group', { name: /Voorstel: Fien toevoegen/ });
  await phoneChat.waitFor({ timeout: 10000 });
  await phoneChat.scrollIntoViewIfNeeded();
  check(await noOverflow(phone), 'telefoon: groepschat met kaart zonder horizontaal scrollen');
  await shot(phone, 'c2-2-groepschat-kaart-telefoon');
  await phone.goto(`${app.url}/#/inbox`);
  const phoneCard = phone.getByRole('group', { name: /Voorstel: Fien toevoegen/ });
  await phoneCard.waitFor({ timeout: 10000 });
  const tab = await phone.getByRole('navigation', { name: 'Hoofdmenu' }).innerText();
  check(/Wacht op jou\s*1|1\s*Wacht op jou/.test(tab.replace(/\n/g, ' ')), 'telefoon: tabblad Wacht op jou telt het voorstel');
  const h = await phoneCard.getByRole('button', { name: 'Afwijzen' }).boundingBox();
  check(h && h.height >= 44, `telefoon: knoppen ≥ 44 px (${Math.round(h?.height || 0)} px)`);
  check(await noOverflow(phone), 'telefoon: Wacht op jou zonder horizontaal scrollen');
  await shot(phone, 'c2-2-wacht-op-jou-telefoon');
  await phoneCard.getByRole('button', { name: 'Afwijzen' }).click();
  await phone.getByText('Niets dat op je wacht').waitFor({ timeout: 10000 });
  check(!(await api('GET', '/agents')).some((a) => a.name === 'Fien'), 'afgewezen: Fien is niet aangemaakt');
  await page.goto(`${app.url}/#/t/${roomThread}`);
  await page.getByRole('group', { name: /Voorstel: Fien toevoegen/ }).getByText('Afgewezen').waitFor({ timeout: 10000 });
  step('desktop: kaart in de groepschat toont "Afgewezen"');
  await desk.close();
  await phoneCtx.close();

  // ---------------------------------------------------------------- B. approval survives a crash
  const writer = await bot('Schrijver', { role: 'Notities', tool_groups: ['files'] });
  const th = await api('POST', '/threads', { agentId: writer.id });
  const WRITE = { path: 'na-herstart.txt', content: 'hallo na de herstart' };
  script.push({ toolCalls: [{ name: 'write_file', args: WRITE }] });
  await api('POST', `/threads/${th.id}/messages`, { content: 'Schrijf na-herstart.txt' });
  const apr = await until(() => app.ctx.store.one("SELECT * FROM approvals WHERE thread_id = ? AND status = 'pending'", th.id));
  await api('POST', `/threads/${th.id}/queue`, { content: 'Vat daarna samen wat je deed', mode: 'queue' });
  const p1 = await (await browser.newContext({ viewport: { width: 1360, height: 880 } })).newPage();
  watch(p1);
  await p1.goto(`${app.url}/#token=${token}`);
  await p1.goto(`${app.url}/#/t/${th.id}`);
  await p1.getByRole('group', { name: 'Goedkeuring nodig' }).waitFor({ timeout: 10000 });
  await shot(p1, 'c2-3-voor-crash-desktop');
  await p1.context().close();
  // "Crash": TeamBot stops while the bot waits; put the rows back as a hard kill leaves them.
  await app.close();
  const db = new DatabaseSync(path.join(dir, 'teambot.db'));
  db.prepare("UPDATE approvals SET status = 'pending', decided_at = NULL, decided_by = NULL WHERE id = ?").run(apr.id);
  db.prepare("UPDATE runs SET status = 'waiting', finished_at = NULL, error = NULL WHERE id = ?").run(apr.run_id);
  db.close();
  ({ app, token, api } = await boot());
  step(`herstart op ${app.url}`);
  check(app.ctx.store.run(apr.run_id).status === 'interrupted', 'run staat op onderbroken (niet vanzelf herhaald)');

  const d2 = await browser.newContext({ viewport: { width: 1360, height: 880 } });
  const p2 = await d2.newPage();
  watch(p2);
  await p2.goto(`${app.url}/#token=${token}`);
  await p2.goto(`${app.url}/#/inbox`);
  const back = p2.getByRole('group', { name: 'Goedkeuring nodig' });
  await back.waitFor({ timeout: 10000 });
  const txt = await back.innerText();
  check(txt.includes('Onderbroken door een herstart'), 'Wacht op jou: goedkeuring is terug en zegt dat ze door een herstart werd onderbroken');
  check(await back.getByRole('button', { name: 'Toestaan en hervatten' }).isVisible(), 'knop "Toestaan en hervatten"');
  check(!(await back.getByRole('button', { name: /Altijd toestaan/ }).count()), 'geen "Altijd toestaan" na een herstart');
  await shot(p2, 'c2-3-na-herstart-wacht-op-jou-desktop');
  await p2.goto(`${app.url}/#/t/${th.id}`);
  const inChat = p2.getByRole('group', { name: 'Goedkeuring nodig' });
  await inChat.waitFor({ timeout: 10000 });
  check(await p2.getByRole('region', { name: 'Wachtrij' }).isVisible(), 'de wachtrij (1) staat er nog');
  check(await p2.getByText(/De goedkeuring staat nog open/).isVisible(), 'chat-melding: de goedkeuring staat nog open');
  await shot(p2, 'c2-3-na-herstart-chat-desktop');

  const phone2Ctx = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 390, height: 844 } });
  const phone2 = await phone2Ctx.newPage();
  watch(phone2);
  await phone2.goto(`${app.url}/#token=${token}`);
  await phone2.goto(`${app.url}/#/inbox`);
  await phone2.getByRole('group', { name: 'Goedkeuring nodig' }).waitFor({ timeout: 10000 });
  check(await noOverflow(phone2), 'telefoon: goedkeuring na herstart zonder horizontaal scrollen');
  await shot(phone2, 'c2-3-na-herstart-telefoon');
  await phone2Ctx.close();

  script.push({ toolCalls: [{ name: 'write_file', args: WRITE }] }, { text: 'Klaar: na-herstart.txt staat in je werkmap.' });
  await inChat.getByRole('button', { name: 'Toestaan en hervatten' }).click();
  await idle(app, th.id);
  const file = path.join(writer.workspace, WRITE.path);
  check(fs.existsSync(file) && fs.readFileSync(file, 'utf8') === WRITE.content, 'na toestaan: het bestand is geschreven');
  check(app.ctx.store.one("SELECT COUNT(*) n FROM approvals WHERE thread_id = ?", th.id).n === 1, 'geen tweede goedkeuringskaart (zelfde actie niet opnieuw gevraagd)');
  check(app.ctx.store.all("SELECT kind FROM audit WHERE kind = 'file.write'").length === 1, 'het bestand is precies één keer geschreven');
  await p2.getByRole('paragraph').filter({ hasText: 'Klaar: na-herstart.txt staat in je werkmap.' }).waitFor({ timeout: 10000 });
  check(!(await p2.getByRole('group', { name: 'Goedkeuring nodig' }).count()), 'kaart is weg uit de chat');
  check((await api('GET', `/threads/${th.id}/queue`)).items.length === 1, 'wachtrij wacht nog op "Doorgaan" (niets vanzelf verstuurd)');
  await shot(p2, 'c2-3-na-goedkeuren-desktop');
  await d2.close();

  if (errors.length) fail('console-/paginafouten: ' + errors.slice(0, 5).join(' | '));
  else step('geen console-fouten');
} catch (e) {
  fail(e?.stack || String(e));
} finally {
  await browser.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `✗ c2-proposals-restart: ${failed} fout(en)` : '✓ c2-proposals-restart geslaagd');
