// What a user or a bot wrote stays as written in another interface language; TeamBot's own words are translated.
// In English, in an empty install with a scripted AI (no real model):
//   - a Dutch chat title in the chat header and in the list of a bot's conversations stays exactly as written (it
//     became "Every werkdag at 9:00 zoek je…");
//   - a bot's role "Onderzoeker" under its name stays (it became "Researcher");
//   - the note of a hand-off: one line in English for the owner, the colleague's answer as written and rendered
//     (no raw **markdown**, no grey oval), nothing meant for the bot ("Neem dit niet over als klaar", "delegate_task");
//   - "Wat start vanzelf": TeamBot's words in English, the chat title in a row as written;
//   - the line next to a tool step ("Broadcast aan Pen: …", "Taak aan Pen: …"): TeamBot's words in English, what the
//     bot wrote as written (the whole line stayed Dutch);
//   - the tooltip on a bot's row in the desktop sidebar: its last message as written.
//
// Usage: npm run build:ui && node --import tsx tests/e2e/own-words.mjs
//        (TEAMBOT_UI_DIR = another build; TEAMBOT_E2E_SHOTS = folder for screenshots, TEAMBOT_E2E_SHOT_PREFIX = name
//         prefix; TEAMBOT_E2E_DIR = an empty folder for the data; TEAMBOT_E2E_PORT; TEAMBOT_E2E_BROWSER=chrome|msedge)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const results = [];
const check = (name, ok, detail = '') => {
  results.push(!!ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const SHOTS = process.env.TEAMBOT_E2E_SHOTS || '';
const PREFIX = process.env.TEAMBOT_E2E_SHOT_PREFIX || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not there yet */
    }
  }
  return null;
};

// The browser first (it needs this pc's own environment), then TeamBot in an empty one.
const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const base = process.env.TEAMBOT_E2E_DIR ? path.resolve(process.env.TEAMBOT_E2E_DIR) : fs.mkdtempSync(path.join(os.tmpdir(), 'tb-own-words-'));
const home = path.join(base, 'home');
fs.mkdirSync(home, { recursive: true });
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  XDG_DATA_HOME: path.join(home, 'xdg', 'data'),
  XDG_CONFIG_HOME: path.join(home, 'xdg', 'config'),
  XDG_CACHE_HOME: path.join(home, 'xdg', 'cache'),
  XDG_DOCUMENTS_DIR: path.join(home, 'Documents'),
  PATH: path.dirname(process.execPath),
  TEAMBOT_TEST_NO_STARTER_RULES: '1',
  TEAMBOT_TEST_NO_AUTO_MAIN: '1',
});
delete process.env.Path;
delete process.env.TEAMBOT_DATA;

const { createApp } = await import('./server.mjs');
const app = await createApp({ dataDir: path.join(base, 'data'), port: Number(process.env.TEAMBOT_E2E_PORT) || 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();
for (const k of app.ctx.providers.kinds.values()) if (k.detect) k.detect = async () => ({ installed: false, detail: 'e2e' });
console.log(`• TeamBot op ${app.url} (lege datamap ${base})`);

// ---------------------------------------------------------------- a scripted AI on this computer
// Vos passes work on to Pen when asked; Pen answers in markdown, or takes long for the work the owner stops.
const textOf = (m) => (typeof m?.content === 'string' ? m.content : (m?.content || []).map((p) => p.text || '').join(' '));
const botOf = (system) => /^Je bent (.+?)(?: — |, een AI-agent)/.exec(system || '')?.[1] || '?';
const ANSWER = '**Klaar**: de lijst staat in `lijst.md`.\n\n- drie nieuwe berichten\n- geen spam';
let seq = 0;
app.ctx.providers.registerKind({
  id: 'mock',
  label: 'Testmodel',
  type: 'api',
  needsKey: false,
  description: 'e2e',
  billing: 'local',
  models: ['mock-1'],
  defaultModel: 'mock-1',
  create: () => ({
    kind: 'mock',
    async listModels() {
      return [{ id: 'mock-1' }];
    },
    async test() {
      return { ok: true, detail: 'e2e' };
    },
    async chat(req, signal, onEvent) {
      const bot = botOf(req.system);
      const last = req.messages.at(-1);
      const said = last?.role === 'user' ? textOf(last) : '';
      const call = (name, args) => ({ text: '', toolCalls: [{ id: `call_${++seq}`, name, args }], usage: { input: 10, output: 5 }, stop: 'tool_use', model: req.model });
      if (bot === 'Vos' && /GEEF DOOR/.test(said)) return call('delegate_task', { bot: 'Pen', task: 'Zoek de nieuwe berichten van vandaag op.', expected_output: 'een lijst' });
      if (bot === 'Vos' && /GEEF LANG DOOR/.test(said)) return call('delegate_task', { bot: 'Pen', task: 'Lees alle oude berichten na.', expected_output: 'een samenvatting' });
      if (bot === 'Vos' && /STUUR IEDEREEN/.test(said)) return call('broadcast', { bots: ['Pen'], message: TITLE, follow_up: false });
      let text = 'Gedaan.';
      // Vos's words after the message to the team: a sentence the page translator would half translate.
      if (bot === 'Vos' && last?.role === 'tool' && /STUUR IEDEREEN/.test(JSON.stringify(req.messages))) text = TITLE;
      if (bot === 'Pen' && /nieuwe berichten van vandaag/.test(JSON.stringify(req.messages))) text = ANSWER;
      // (only for that task itself, not for a later message whose remembered context names it)
      if (bot === 'Pen' && /oude berichten na/.test(said.split('<context>')[0])) await new Promise((res) => signal.addEventListener('abort', res, { once: true }));
      onEvent({ type: 'text', delta: text });
      return { text, toolCalls: [], usage: { input: 10, output: 5 }, stop: 'end', model: req.model };
    },
  }),
});
const api = async (method, p, body) => {
  const r = await fetch(app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status}: ${j.error}`);
  return j;
};
const store = app.ctx.store;
const idle = () => until(() => !store.all("SELECT id FROM runs WHERE status IN ('queued','running','waiting')").length, 20_000);

const TITLE = 'Elke werkdag om 9:00 zoek je nieuwe berichten op';
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: 'en-GB' });
await ctx.addInitScript(() => localStorage.setItem('tb_lang', 'en'));
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${PREFIX}${name}.png`) });
/** The visible text of the page's main part (what a person reads). */
const textIn = (sel) => page.locator(sel).first().innerText();

try {
  store.setSetting(owner.id, 'language', 'en');
  const prov = await api('POST', '/providers', { kind: 'mock' });
  const vos = await api('POST', '/agents', { name: 'Vos', provider_id: prov.id, model: 'mock-1', access_mode: 'auto' });
  const pen = await api('POST', '/agents', { name: 'Pen', role: 'Onderzoeker', provider_id: prov.id, model: 'mock-1', access_mode: 'auto' });
  const th = await api('POST', '/threads', { agentId: vos.id });
  await api('PATCH', `/threads/${th.id}`, { title: TITLE });
  // Vos passes work on to Pen; Pen's answer comes back as a note in this chat, then Vos's follow-up turn.
  await api('POST', `/threads/${th.id}/messages`, { content: 'GEEF DOOR aan Pen.' });
  await until(() => store.messages(th.id, { limit: 200 }).some((m) => m.role === 'system' && m.parts?.kind === 'delegation_result'), 20_000);
  await idle();
  // A second piece of work that the owner stops ("Alles stoppen").
  await api('POST', `/threads/${th.id}/messages`, { content: 'GEEF LANG DOOR aan Pen.' });
  await until(() => store.all("SELECT r.id FROM runs r JOIN agents a ON a.id = r.agent_id WHERE a.name = 'Pen' AND r.status = 'running'").length, 20_000);
  await api('POST', '/stop-all', {});
  await until(() => store.messages(th.id, { limit: 200 }).some((m) => m.role === 'system' && m.parts?.kind === 'delegation_cancelled'), 20_000);
  await idle();
  // "Alles stoppen" also dropped the conversation's memory review; the owner's next message queues it again.
  await api('POST', `/threads/${th.id}/messages`, { content: 'Dank je.' });
  await idle();
  await until(async () => (await api('GET', '/routines/planned')).planned.some((p) => p.id === `review:${th.id}`), 10_000);
  // A message to the whole team: a tool step whose line has the bot's own words in it.
  const since = new Date().toISOString();
  await api('POST', `/threads/${th.id}/messages`, { content: 'STUUR IEDEREEN een bericht.' });
  await until(() => store.all("SELECT r.id FROM runs r JOIN agents a ON a.id = r.agent_id WHERE a.name = 'Pen' AND r.status = 'done' AND r.created_at > ?", since).length, 20_000);
  await idle();
  const note = store.messages(th.id, { limit: 200 }).find((m) => m.parts?.kind === 'delegation_result');
  console.log(`• De notitie voor de bot: ${JSON.stringify(note?.content.slice(0, 160))}`);

  // ---------------------------------------------------------------- the chat with Vos, in English
  await page.goto(`${app.url}/#token=${token}`);
  await until(async () => (await page.evaluate(() => document.documentElement.lang)) === 'en', 15_000);
  await page.goto(`${app.url}/#/t/${th.id}`);
  await page.locator('#inhoud, main').first().waitFor({ timeout: 15_000 });
  await until(async () => (await page.getByText('Klaar', { exact: false }).count()) > 0, 15_000);
  await page.waitForTimeout(1200);
  const head = await textIn('header');
  check('chat header: the Dutch chat title as written', head.includes(TITLE) && !/Every werkdag/.test(head), JSON.stringify(head.slice(0, 200)));
  const chat = await page.locator('main').first().innerText();
  const result = page.locator('[data-testid="system-note"][data-kind="delegation_result"]');
  const resultText = (await result.count()) ? await result.first().innerText() : '';
  check('hand-off note: one English line for the owner ("Result from Pen")', /Result from Pen/.test(resultText), JSON.stringify(resultText.slice(0, 200)));
  check('hand-off note: Pen’s answer as written and rendered (bold, a list, no ** markers)', (await result.locator('strong', { hasText: 'Klaar' }).count()) === 1 && (await result.locator('li').count()) === 2 && /drie nieuwe berichten/.test(resultText) && !chat.includes('**'), JSON.stringify(resultText));
  check('hand-off note: nothing meant for the bot (no tool names, no "Neem dit niet over")', !/delegate_task|task_update|Neem dit niet over|Do not take this over/i.test(chat), '');
  check('hand-off note: never half translated ("Result from de gedelegeerde taak")', !/Result from de|de gedelegeerde taak/.test(chat), '');
  // (rounded-full on a block of several lines: a radius of at least half its height)
  const oval = await page.evaluate(() => [...document.querySelectorAll('main *')].some((el) => { const r = el.getBoundingClientRect(); return r.height > 40 && parseFloat(getComputedStyle(el).borderTopLeftRadius) >= r.height / 2 && el.textContent.includes('Klaar'); }));
  check('hand-off note: no large oval background', !oval, '');
  const stopped = page.locator('[data-testid="system-note"][data-kind="delegation_cancelled"]');
  const stoppedText = (await stopped.count()) ? await stopped.first().innerText() : '';
  check('stopped work: a plain line with the task as Vos wrote it, no tool names', /Lees alle oude berichten na\./.test(stoppedText) && !/delegate_task|Opnieuw geven/.test(stoppedText), JSON.stringify(stoppedText));
  // The line next to a tool step: TeamBot's words in English, the message and the task exactly as Vos wrote them.
  const chip = async (label) => {
    const b = page.locator('main button', { hasText: label }).first();
    return (await b.count()) ? (await b.innerText()).replace(/\s+/g, ' ').trim() : '';
  };
  const sent = await chip('Sent the team a message');
  check('tool step: “Broadcast to Pen:” in English, the message as written', sent.includes(`Broadcast to Pen: ${TITLE}`) && !/Every werkdag|Broadcast aan/.test(sent), JSON.stringify(sent));
  const given = await chip('Asked another bot for help');
  const givenOwn = await page.locator('main button', { hasText: 'Asked another bot for help' }).first().locator('[translate="no"] bdi').allInnerTexts().catch(() => []);
  check('tool step: the task Vos gave Pen as written, apart from TeamBot’s words', givenOwn.includes('Zoek de nieuwe berichten van vandaag op.') && givenOwn.includes('Pen'), JSON.stringify({ given, givenOwn }));
  // "Taak aan {0}: {1}" is new: in English once the translator has added it, until then the Dutch template.
  const en = JSON.parse(fs.readFileSync(path.join('ui', 'src', 'i18n', 'en.json'), 'utf8'));
  const tpl = en['Taak aan {0}: {1}'];
  const want = tpl ? tpl.replace('{0}', 'Pen').replace('{1}', 'Zoek de nieuwe berichten van vandaag op.') : 'Taak aan Pen: Zoek de nieuwe berichten van vandaag op.';
  if (!tpl) console.log('• "Taak aan {0}: {1}" staat nog niet in en.json (vertaler): de template blijft Nederlands, de waarden apart');
  check('tool step: “Taak aan {0}: {1}” in the dictionary’s English, never half translated', given.endsWith(want) && !/Search the new|Zoek the/.test(given), JSON.stringify(given));
  const tip = await page.locator(`a[href="#/t/${th.id}"][title]`).filter({ hasText: /^Vos$/ }).first().getAttribute('title').catch(() => null);
  check('sidebar: the tooltip on Vos’s row is its last message as written', tip === TITLE, JSON.stringify(tip));
  await page.locator('main button', { hasText: 'Sent the team a message' }).first().scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(300);
  await shot('stap-regels');
  await page.locator('[data-kind="delegation_result"], [data-testid="system-note"]').first().scrollIntoViewIfNeeded().catch(() => {});
  await page.getByText('GEEF DOOR aan Pen.').first().scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(300);
  await shot('chat-vos');

  // The list of Vos's conversations (the bot's name in the header opens it).
  await page.locator('header').getByRole('button', { name: /Vos/ }).first().click();
  await page.waitForTimeout(500);
  const pop = (await page.locator(`header a[href="#/t/${th.id}"]`).allInnerTexts()).join(' | ');
  check('conversation list: the Dutch chat title as written', pop.includes(TITLE) && !/Every werkdag/.test(pop), JSON.stringify(pop.slice(0, 300)));
  await shot('gesprekken-vos');
  await page.keyboard.press('Escape');

  // ---------------------------------------------------------------- Pen: its role under its name
  await page.goto(`${app.url}/#/a/${pen.id}`);
  await page.waitForTimeout(1500);
  const penHead = await textIn('header');
  check('header of Pen: the role "Onderzoeker" as written', /Onderzoeker/.test(penHead) && !/Researcher/.test(penHead), JSON.stringify(penHead.slice(0, 200)));
  await shot('kop-pen');

  // ---------------------------------------------------------------- Wat start vanzelf
  await page.goto(`${app.url}/#/settings/vanzelf`);
  const list = page.getByTestId('planned-list');
  await list.waitFor({ timeout: 15_000 });
  await until(async () => (await list.locator('li').count()) > 0, 10_000);
  await page.waitForTimeout(800);
  const rows = await list.locator('li').evaluateAll((ls) => ls.map((l) => l.innerText.replace(/\s+/g, ' ').trim()));
  console.log(`• Wat start vanzelf: ${JSON.stringify(rows)}`);
  const review = rows.find((r) => /for memory/.test(r) || /nalezen/.test(r)) || '';
  check('"Wat start vanzelf": the memory row in English with the chat title as written', /^Reviewing chat “Elke werkdag om 9:00 zoek je nieuwe ber…” for memory/.test(review), JSON.stringify(review));
  const dutch = rows.filter((r) => /\b(Gesprek|nalezen|geheugen|Nieuwe poging|Tweede controle|Automatische back-up|gebruikt AI|kost niets|Aanpassen|Bekijken|Pauzeren|zodra het kan)\b/.test(r));
  check('"Wat start vanzelf": every row in English', rows.length > 0 && dutch.length === 0, JSON.stringify(dutch));
  await shot('wat-start-vanzelf');

  // ---------------------------------------------------------------- the list of bots on a phone: Pen's line is its role
  const phone = await ctx.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  phone.on('pageerror', (e) => errors.push(e.message));
  await phone.goto(`${app.url}/#/`);
  await until(async () => (await phone.locator(`a[href="#/a/${pen.id}"], a[href^="#/t/"]`).filter({ hasText: 'Pen' }).count()) > 0, 15_000);
  await phone.waitForTimeout(1000);
  const penRow = (await phone.locator('a').filter({ hasText: /^Pen/ }).allInnerTexts()).join(' | ');
  check('bot list on a phone: Pen’s line is its role "Onderzoeker" as written', /Onderzoeker/.test(penRow) && !/Researcher/.test(penRow), JSON.stringify(penRow));
  if (SHOTS) await phone.screenshot({ path: path.join(SHOTS, `${PREFIX}lijst-telefoon.png`) });

  check('no errors on the page', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('the check ran to the end', false, e?.stack || String(e));
} finally {
  await browser.close();
  await app.close();
  if (!process.env.TEAMBOT_E2E_DIR) fs.rmSync(base, { recursive: true, force: true });
}
const failed = results.filter((x) => !x).length;
console.log(failed ? `\n${failed} van ${results.length} controles mislukt` : `\nAlle ${results.length} controles gelukt`);
process.exit(failed ? 1 : 0);
