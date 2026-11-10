// End-to-end (OpenBot 0.64/0.65 parity), desktop 1360 px and phone 390 px, Edge/Chrome headless:
//   1. pages a bot made open as tabs in a panel next to the chat (several, select, close, full screen), still in the
//      sandbox (opaque origin, no TeamBot, no storage, no network); selected text → "Citeren" → quote in the composer;
//   2. "Antwoordstijl: Natuurlijk / Zakelijk" in the bot editor reaches the model's instructions;
//   3. "Geschiedenis wissen" of a bot and of a group: dialog with what goes and what stays, then really gone.
// Fake engine in-process, TEMP data. Usage: npm run build:ui && node --import tsx tests/e2e/history-pages.mjs
// (TB_SHOTS_DIR=<dir> for screenshots, TB_E2E_PORT=<port> for a fixed port).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const { createApp } = await import('../../server/app.ts');

const step = (s) => console.log(`• ${s}`);
const fail = (s) => {
  console.error(`✗ ${s}`);
  process.exitCode = 1;
};
const shots = process.env.TB_SHOTS_DIR || '';
if (shots) fs.mkdirSync(shots, { recursive: true });
const shot = async (page, name) => shots && (await page.waitForTimeout(300), await page.screenshot({ path: path.join(shots, `${name}.png`) }));
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const axe = async (page, where) => {
  // evaluate (not a script tag): the app's own CSP stays on, as for a real user
  await page.evaluate(axeSource);
  const v = await page.evaluate(async () => {
    // @ts-ignore
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
    return r.violations.map((x) => `${x.id}: ${x.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`);
  });
  if (v.length) fail(`a11y ${where}: ${v.join(' | ')}`);
  else step(`a11y ${where}: 0 bevindingen`);
};
const until = async (fn, what, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  fail(`time-out: ${what}`);
  return false;
};

const PAGE1 = '<!doctype html><html><head><style>body{font:16px sans-serif;padding:16px}</style></head><body><h1>Kwartaalrapport</h1><p id="omzet">De omzet steeg met twaalf procent.</p><p>Tweede alinea.</p></body></html>';
const PAGE2 = '<!doctype html><html><body><h1>Planning</h1><p>Week 12: levering.</p></body></html>';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-e2e-history-pages-'));
const app = await createApp({ dataDir: dir, port: Number(process.env.TB_E2E_PORT) || 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();
const systems = [];
app.ctx.providers.registerKind({
  id: 'e2emock',
  label: 'Testengine',
  type: 'api',
  needsKey: false,
  description: 'e2e',
  models: ['e2e-1'],
  defaultModel: 'e2e-1',
  create: () => ({
    kind: 'e2emock',
    async listModels() {
      return [{ id: 'e2e-1' }];
    },
    async test() {
      return { ok: true, detail: 'ok' };
    },
    async chat(req, _signal, onEvent) {
      systems.push(req.system || '');
      const last = req.messages.at(-1);
      const said = JSON.stringify(last?.content || '');
      const done = { usage: { input: 10, output: 5 }, model: req.model };
      if (last?.role === 'user' && /rapport/i.test(said)) return { text: '', toolCalls: [{ id: 'c' + Date.now(), name: 'show_html', args: { title: 'Kwartaalrapport', html: PAGE1 } }], stop: 'tool_use', ...done };
      if (last?.role === 'user' && /planning/i.test(said)) return { text: '', toolCalls: [{ id: 'c' + Date.now(), name: 'show_html', args: { title: 'Planning', html: PAGE2 } }], stop: 'tool_use', ...done };
      const text = last?.role === 'tool' ? 'De pagina staat klaar.' : 'Prima, ik help je.';
      onEvent({ type: 'text', delta: text });
      return { text, toolCalls: [], stop: 'end', ...done };
    },
  }),
});
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const api = async (method, p, body) => {
  const r = await fetch(`${app.url}/api${p}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${j.error}`);
  return j;
};
await api('PUT', '/settings', { onboarded: true });
const prov = await api('POST', '/providers', { kind: 'e2emock' });
const bot = await api('POST', '/agents', { name: 'Rapportbot', role: 'Rapporten', provider_id: prov.id, model: 'e2e-1', access_mode: 'auto' });
const bot2 = await api('POST', '/agents', { name: 'Planner', role: 'Planning', provider_id: prov.id, model: 'e2e-1', access_mode: 'auto' });

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const errors = [];
const watch = (page) => page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED|40[34] \(|Failed to load resource|Content Security Policy/.test(m.text()) && errors.push(m.text()));
const idle = async (threadId) => until(() => !app.ctx.store.all("SELECT id FROM runs WHERE thread_id = ? AND status IN ('queued','running','waiting')", threadId).length, 'bot klaar');
const send = async (page, text) => {
  const box = page.getByRole('textbox', { name: 'Bericht' });
  await box.fill(text);
  await box.press('Enter');
};
const noOverflow = async (page, where) => {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  if (w > 392) fail(`${where}: horizontaal scrollen op 390 px (${w})`);
};
/** Select the text of one element inside a page in the sandbox (as a user would drag over it). */
const selectIn = async (frameEl, selector) => {
  const frame = await frameEl.contentFrame();
  await frame.evaluate((sel) => {
    const r = document.createRange();
    r.selectNodeContents(document.querySelector(sel));
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }, selector);
  return frame;
};

try {
  // ======================= desktop =======================
  const page = await browser.newPage({ viewport: { width: 1360, height: 880 } });
  watch(page);
  await page.goto(`${app.url}/#token=${token}`);
  await page.goto(`${app.url}/#/a/${bot.id}`);
  await page.getByRole('textbox', { name: 'Bericht' }).waitFor({ timeout: 20000 });
  const threadId = await until(() => /#\/t\//.test(page.url()), 'chat open').then(() => page.url().split('#/t/')[1]);
  await send(page, 'Maak een rapport van het kwartaal');
  await idle(threadId);
  const inline = page.locator('main iframe[title="Kwartaalrapport.html"], iframe[title="Kwartaalrapport.html"]').first();
  await inline.waitFor({ timeout: 15000 });
  if ((await inline.getAttribute('sandbox')) !== 'allow-scripts') fail('pagina in de chat: sandbox is niet precies "allow-scripts"');
  await page.getByRole('button', { name: 'Naast de chat' }).first().click();
  const panel = page.locator('aside[data-pages]');
  await panel.waitFor({ state: 'visible', timeout: 10000 });
  step('pagina geopend naast de chat');
  await send(page, 'En nu de planning');
  await idle(threadId);
  await page.locator('iframe[title="Planning.html"]').first().waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Naast de chat' }).last().click();
  await until(async () => (await panel.locator('iframe').count()) === 2, 'twee tabbladen');
  const tab1 = panel.getByRole('button', { name: 'Kwartaalrapport.html', exact: true });
  const tab2 = panel.getByRole('button', { name: 'Planning.html', exact: true });
  if ((await tab2.getAttribute('aria-pressed')) !== 'true') fail('het nieuwe tabblad is niet actief');
  await tab1.click();
  if ((await tab1.getAttribute('aria-pressed')) !== 'true') fail('wisselen van tabblad werkt niet');
  else step('twee tabbladen, wisselen werkt');
  const pBox = await panel.boundingBox();
  if (!pBox || pBox.width < 360 || pBox.x < 500) fail(`paneel staat niet naast de chat: ${JSON.stringify(pBox)}`);
  await shot(page, 'd1-paneel-twee-tabs');

  // the sandbox: opaque origin, no TeamBot window, no storage, no network
  const frameEl = panel.locator('iframe[title="Kwartaalrapport.html"]');
  const frame = await (await frameEl.elementHandle()).contentFrame();
  const sec = await frame.evaluate(async () => {
    const o = { origin: self.origin, parent: 'open', storage: 'open', fetch: 'open', cookie: '' };
    try {
      o.cookie = document.cookie || '';
    } catch {
      /* sandboxed: no cookies at all */
    }
    try {
      void parent.document.title;
    } catch {
      o.parent = 'blocked';
    }
    try {
      localStorage.setItem('x', '1');
    } catch {
      o.storage = 'blocked';
    }
    try {
      await fetch('/api/agents');
    } catch {
      o.fetch = 'blocked';
    }
    return o;
  });
  if (sec.origin !== 'null' || sec.parent !== 'blocked' || sec.storage !== 'blocked' || sec.fetch !== 'blocked' || sec.cookie) fail('sandbox lekt: ' + JSON.stringify(sec));
  else step('pagina in het paneel: geen toegang tot TeamBot, opslag of netwerk');

  // "Citeren"
  await selectIn(await frameEl.elementHandle(), '#omzet');
  const quote = panel.getByRole('button', { name: 'Citeren' });
  await quote.waitFor({ timeout: 5000 });
  const qBox = await quote.boundingBox();
  const fBox = await frameEl.boundingBox();
  if (!qBox || !fBox || qBox.y < fBox.y || qBox.y > fBox.y + 120) fail(`Citeren staat niet bij de selectie: ${JSON.stringify({ qBox, fBox })}`);
  await shot(page, 'd2-citeren');
  await quote.click();
  const val = await page.getByRole('textbox', { name: 'Bericht' }).inputValue();
  if (!val.startsWith('> De omzet steeg met twaalf procent.')) fail('citaat niet in het bericht: ' + JSON.stringify(val));
  else step('geselecteerde tekst geciteerd in het bericht');
  // a page cannot fake a quote from another frame, and a message from the window itself is ignored
  await page.evaluate(() => window.postMessage({ tb: 'selection', text: 'nep', rect: null }, '*'));
  await page.waitForTimeout(300);
  if (await quote.isVisible()) fail('een bericht van buiten de pagina toonde Citeren');
  // sent: the quote shows as a quote block above the question
  await page.getByRole('textbox', { name: 'Bericht' }).press('End');
  await page.getByRole('textbox', { name: 'Bericht' }).type('Klopt dit?');
  await page.getByRole('textbox', { name: 'Bericht' }).press('Enter');
  await idle(threadId);
  const bq = page.locator('blockquote', { hasText: 'De omzet steeg met twaalf procent.' });
  await bq.first().waitFor({ timeout: 10000 });
  const sentText = app.ctx.store.messages(threadId).filter((m) => m.role === 'user').at(-1).content;
  if (sentText !== '> De omzet steeg met twaalf procent.\n\nKlopt dit?') fail('verstuurd citaat: ' + JSON.stringify(sentText));
  else step('citaat verstuurd en als citaatblok getoond');

  // full screen and back, close a tab, close and reopen the panel
  await panel.getByRole('button', { name: 'Volledig scherm' }).click();
  const fullBox = await panel.boundingBox();
  if (!fullBox || fullBox.width < 1300 || fullBox.height < 850) fail('volledig scherm vult het venster niet: ' + JSON.stringify(fullBox));
  await shot(page, 'd3-volledig-scherm');
  await page.keyboard.press('Escape');
  await until(async () => ((await panel.boundingBox())?.width || 0) < 1000, 'Esc: terug naast de chat');
  step('volledig scherm en terug (Esc)');
  await axe(page, 'chat met paginapaneel');
  await panel.getByRole('button', { name: 'Planning.html sluiten' }).click();
  await until(async () => (await panel.locator('iframe').count()) === 1, 'tabblad gesloten');
  await panel.getByRole('button', { name: 'Paginapaneel sluiten' }).click();
  await until(async () => !(await panel.isVisible()), 'paneel dicht');
  await page.getByRole('button', { name: 'Pagina naast de chat' }).click();
  await panel.waitFor({ state: 'visible' });
  step('tabblad sluiten, paneel sluiten en weer openen');

  // ---- answer style ----
  // Antwoordstijl is a row on the tab Instructies of the bot page.
  await page.goto(`${app.url}/#/agents/${bot.id}`);
  await page.getByRole('tab', { name: 'Instructies' }).click();
  const legend = page.getByText('Antwoordstijl', { exact: true });
  await legend.waitFor({ timeout: 15000 });
  if (!(await page.getByRole('radio', { name: 'Natuurlijk' }).isChecked())) fail('standaard staat Natuurlijk niet aan');
  await page.getByText('Zakelijk', { exact: true }).click();
  await axe(page, 'bot-editor met antwoordstijl');
  await shot(page, 'd4-antwoordstijl');
  await page.getByRole('button', { name: /^Opslaan/ }).first().click();
  await until(() => app.ctx.store.agent(bot.id).settings?.answerStyle === 'business', 'antwoordstijl opgeslagen');
  // the editor itself must know it is saved too (otherwise leaving asks "Wijzigingen opslaan?")
  await page.getByText('Niet opgeslagen:').waitFor({ state: 'detached', timeout: 10000 });
  const before = systems.length;
  await api('POST', `/threads/${threadId}/messages`, { content: 'Vergelijk twee opties' });
  await idle(threadId);
  if (!systems.slice(before).some((s) => s.includes('## Antwoordstijl') && /kopjes en opsommingen/.test(s))) fail('de antwoordstijl zat niet in de instructies van het model');
  else step('Zakelijk opgeslagen en in de instructies van het model');

  // ---- delete the bot's history ----
  const files = app.ctx.store.all('SELECT path FROM attachments WHERE thread_id = ?', threadId).map((r) => r.path);
  await page.goto(`${app.url}/#/t/${threadId}`);
  await page.getByRole('button', { name: 'Meer opties' }).click();
  await page.getByRole('button', { name: 'Bot beheren', exact: true }).click();
  await page.getByRole('button', { name: 'Geschiedenis wissen…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Geschiedenis van Rapportbot wissen?' });
  await dlg.getByText('Dit gaat weg').waitFor({ timeout: 10000 });
  const dlgText = await dlg.innerText();
  for (const want of ['1 gesprek met', '2 bestanden uit de gesprekken', 'Dit blijft', 'de bot zelf']) if (!dlgText.includes(want)) fail(`dialoog mist "${want}": ${dlgText}`);
  await axe(page, 'dialoog geschiedenis wissen');
  await shot(page, 'd5-geschiedenis-wissen');
  await dlg.getByRole('button', { name: 'Geschiedenis wissen' }).click();
  await until(() => !app.ctx.store.thread(threadId), 'gesprek gewist');
  await until(() => /#\/t\//.test(page.url()) && !page.url().includes(threadId), 'nieuw, leeg gesprek');
  if (files.some((f) => fs.existsSync(f))) fail('bestanden van het gesprek staan nog op schijf');
  if (!app.ctx.store.agent(bot.id)) fail('de bot zelf is weg');
  else step('geschiedenis van de bot gewist; de bot opent in een nieuw, leeg gesprek');

  // ---- delete a group's history ----
  const room = await api('POST', '/rooms', { name: 'Kwartaalteam', agentIds: [bot.id, bot2.id], mode: 'lead' });
  await api('POST', `/threads/${room.threadId}/messages`, { content: 'Plan het kwartaal' });
  await idle(room.threadId);
  await page.goto(`${app.url}/#/t/${room.threadId}`);
  await page.getByText('Plan het kwartaal').first().waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Meer opties' }).click();
  await page.getByRole('button', { name: 'Geschiedenis van de groep wissen…' }).click();
  const gd = page.getByRole('dialog', { name: 'Geschiedenis van de groep Kwartaalteam wissen?' });
  await gd.getByText('het groepsgesprek met', { exact: false }).waitFor({ timeout: 10000 });
  await gd.getByRole('button', { name: 'Geschiedenis wissen' }).click();
  await until(async () => (await page.getByText('Plan het kwartaal').count()) === 0, 'groepsgesprek leeg');
  if (app.ctx.store.messages(room.threadId).length) fail('groepsgesprek niet leeg op de server');
  if (!app.ctx.store.one('SELECT id FROM rooms WHERE id = ?', room.room.id)) fail('de groep zelf is weg');
  else step('geschiedenis van de groep gewist; de groep blijft');
  await page.close();

  // ======================= phone 390 px =======================
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const ph = await ctx2.newPage();
  watch(ph);
  await ph.goto(`${app.url}/#token=${token}`);
  await ph.goto(`${app.url}/#/a/${bot.id}`);
  await ph.getByRole('textbox', { name: 'Bericht' }).waitFor({ timeout: 20000 });
  const pThread = await until(() => /#\/t\//.test(ph.url()), 'chat open (telefoon)').then(() => ph.url().split('#/t/')[1]);
  await send(ph, 'Maak een rapport');
  await idle(pThread);
  await ph.locator('iframe[title="Kwartaalrapport.html"]').first().waitFor({ timeout: 15000 });
  await noOverflow(ph, 'chat met pagina');
  await ph.getByRole('button', { name: 'Groot openen' }).first().tap();
  const sheet = ph.getByRole('dialog', { name: "Pagina's van de bot" });
  await sheet.waitFor({ timeout: 10000 });
  const sBox = await sheet.boundingBox();
  if (!sBox || sBox.width < 388 || sBox.height < 800) fail('pagina op de telefoon is niet schermvullend: ' + JSON.stringify(sBox));
  await noOverflow(ph, 'paginapaneel');
  await shot(ph, 'p1-pagina-groot');
  await selectIn(await sheet.locator('iframe').first().elementHandle(), '#omzet');
  await sheet.getByRole('button', { name: 'Citeren' }).tap();
  await until(async () => !(await sheet.isVisible()), 'na Citeren terug naar het gesprek');
  const pv = await ph.getByRole('textbox', { name: 'Bericht' }).inputValue();
  if (!pv.startsWith('> De omzet steeg')) fail('telefoon: citaat niet in het bericht: ' + JSON.stringify(pv));
  else step('telefoon: pagina schermvullend, Citeren zet de tekst in het bericht');
  await shot(ph, 'p2-citaat-in-bericht');
  await ph.getByRole('button', { name: 'Meer opties' }).tap();
  await ph.getByRole('button', { name: 'Bot beheren', exact: true }).tap();
  await ph.getByRole('button', { name: 'Geschiedenis wissen…' }).tap();
  const pd = ph.getByRole('dialog', { name: 'Geschiedenis van Rapportbot wissen?' });
  await pd.getByText('Dit gaat weg').waitFor({ timeout: 10000 });
  await noOverflow(ph, 'dialoog geschiedenis wissen');
  await shot(ph, 'p3-geschiedenis-dialoog');
  await pd.getByRole('button', { name: 'Annuleren' }).tap();
  await ph.goto(`${app.url}/#/agents/${bot.id}`);
  await ph.getByRole('tab', { name: 'Instructies' }).tap();
  await ph.getByText('Antwoordstijl', { exact: true }).waitFor({ timeout: 15000 });
  await ph.getByText('Antwoordstijl', { exact: true }).scrollIntoViewIfNeeded();
  await noOverflow(ph, 'bot-editor');
  await shot(ph, 'p4-antwoordstijl');
  step('telefoon: dialoog en antwoordstijl passen op 390 px');
  await ctx2.close();

  if (errors.length) fail('fouten in de console: ' + errors.slice(0, 5).join(' | '));
} catch (e) {
  fail(e?.stack || String(e));
  if (shots) for (const p of browser.contexts().flatMap((c) => c.pages())) await p.screenshot({ path: path.join(shots, `fout-${Date.now()}.png`) }).catch(() => {});
} finally {
  await browser.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
if (!process.exitCode) console.log('✓ geschiedenis wissen, pagina naast de chat en antwoordstijl: alles in orde');
