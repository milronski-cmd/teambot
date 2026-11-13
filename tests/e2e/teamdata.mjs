// Teamwerk in a real browser (synthetic data): a bot puts a decision in the team database, the owner answers it on a
// phone under "Wacht op jou", the answer is written back and the bot is woken; the task board, log search and table
// browser work; no horizontal scrolling on phone and tablet; no serious axe findings on the Teamwerk pages.
// Usage: npm run build:ui && npm run teamdata:check   [TEAMBOT_TEAMDATA_SHOTS=<dir>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright-core');
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const { createApp } = await import('./server.mjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-teamdata-'));
const app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();
const shots = process.env.TEAMBOT_TEAMDATA_SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(50);
  }
  return null;
}

// A fake engine: the first turn writes a decision with team_execute, later turns confirm the owner's answer.
const seen = [];
app.ctx.providers.registerKind({
  id: 'fake',
  label: 'Fake',
  type: 'api',
  needsKey: false,
  description: 'test',
  models: ['fake-1'],
  defaultModel: 'fake-1',
  create: () => ({
    kind: 'fake',
    async listModels() {
      return [{ id: 'fake-1' }];
    },
    async test() {
      return { ok: true, detail: 'fake' };
    },
    async chat(req, _signal, onEvent) {
      const last = [...req.messages].reverse().find((m) => m.role === 'user');
      const text = typeof last?.content === 'string' ? last.content : '';
      seen.push(text);
      if (/Zet de beslissing klaar/.test(text) && !req.messages.some((m) => m.role === 'tool')) {
        return {
          text: '',
          toolCalls: [{ id: 'c1', name: 'team_execute', args: { sql: 'INSERT INTO beslissingen (vraag, uitleg, opties, gevraagd_door) VALUES (?, ?, ?, ?)', params: ['Accu terugbetalen of eerst ophalen?', 'Klant wacht al 5 dagen; de accu is van lage waarde.', '["Terugbetalen (advies)", "Eerst laten ophalen", "Niet doen"]', 'Operations'] } }],
          usage: { input: 5, output: 5 },
          stop: 'tool_use',
          model: req.model,
        };
      }
      const reply = /Mijn keuze: (.+)/.exec(text)?.[1] ? `Ik ga verder met: ${/Mijn keuze: (.+)/.exec(text)[1]}` : 'Klaargezet.';
      onEvent({ type: 'text', delta: reply });
      return { text: reply, toolCalls: [], usage: { input: 5, output: 5 }, stop: 'end', model: req.model };
    },
  }),
});
const prov = app.ctx.providers.create(owner.id, { kind: 'fake' });
const ops = app.ctx.store.createAgent(owner.id, { name: 'Operations', provider_id: prov.id, model: 'fake-1', access_mode: 'full', tool_groups: ['team', 'memory'], role: 'Test' });
app.ctx.store.createAgent(owner.id, { name: 'SEO & Content', role: 'Test' });
const svc = app.ctx.services.teamdata;
await svc.write(owner.id, [
  { sql: 'INSERT INTO taken (titel, eigenaar, aangevraagd_door, site, status, resultaat, bewijs) VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)', params: ['Bing opschonen: 26 oude URL’s', 'SEO & Content', 'Operations', 'voorbeeld.nl', 'wacht_op_sanne', 'Onderzocht; besluit nodig.', 'https://example.com/bewijs', 'Inkoopprijzen aanvullen', 'Operations', 'Operations', 'winkel.nl', 'bezig', null, null] },
  { sql: "WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 80) INSERT INTO logboek (agent, site, wat, waarom, bewijs, terugdraaien) SELECT CASE WHEN i % 2 = 0 THEN 'Operations' ELSE 'SEO & Content' END, 'voorbeeld.nl', CASE WHEN i = 13 THEN 'Robots-meta aangepast voor Discover' ELSE 'Wijziging ' || i END, 'onderhoud', 'commit abc' || i, 'git revert abc' || i FROM c" },
  { sql: 'INSERT INTO gebeurtenissen (soort, dossier, bron, samenvatting) VALUES (?, ?, ?, ?)', params: ['klantbericht', 'Klanten/Voorbeeld', 'Operations', 'Vraagt naar de retour van een accu.'] },
  { sql: 'INSERT INTO experimenten (vak, hypothese, meetdatum, eigenaar, status) VALUES (?, ?, ?, ?, ?)', params: ['SEO', 'Betere titels geven meer klikken.', '2026-12-04', 'SEO & Content', 'loopt'] },
]);

// This test opens every Teamwerk tab, the tables included: those are expert panels, shown with Instellingen › Geavanceerd tonen (settings.ui.advanced).
app.ctx.store.setSetting(owner.id, 'ui', { ...(app.ctx.store.settings(owner.id).ui || {}), advanced: true });
const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const fits = (p) => p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
try {
  // ---------------- the bot asks ----------------
  const chat = app.ctx.chat.threadForAgent(owner.id, ops.id);
  await app.ctx.chat.postUserMessage({ thread: chat, user: owner, content: 'Zet de beslissing klaar voor de accu.' });
  const asked = await until(async () => (await svc.decisions(owner.id)).find((d) => d.vraag.startsWith('Accu')));
  check('bot zet een beslissing klaar via team_execute', !!asked && asked.asker?.name === 'Operations', asked ? `#${asked.id}` : 'niet gevonden');

  // ---------------- phone: answer it under "Wacht op jou" ----------------
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await phone.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${app.url}/#token=${token}`);
  await page.waitForTimeout(900);
  await page.evaluate(() => (location.hash = '#/inbox'));
  await page.waitForSelector('text=Accu terugbetalen of eerst ophalen?', { timeout: 10_000 });
  const badge = await page.locator('nav[aria-label="Hoofdmenu"] a[href="#/inbox"]').innerText();
  check('telefoon: tab "Wacht op jou" telt de beslissing mee', /1/.test(badge), JSON.stringify(badge));
  const card = page.locator('article', { hasText: 'Accu terugbetalen of eerst ophalen?' });
  check('telefoon: opties als knoppen', (await card.getByRole('radio').count()) === 3);
  await card.getByRole('radio', { name: /Eerst laten ophalen/ }).click();
  await card.getByLabel('Toelichting (optioneel)').fill('vóór vrijdag');
  if (shots) await page.screenshot({ path: path.join(shots, 'telefoon-beslissing.png') });
  await card.getByRole('button', { name: /^Kies/ }).click();
  await page.waitForSelector('text=/Opgeslagen\\. Operations/', { timeout: 10_000 });
  const row = (await svc.rows(owner.id, 'SELECT status, antwoord FROM beslissingen WHERE id = ?', [asked.id]))[0];
  check('keuze teruggeschreven in de tabel', row?.status === 'gekozen' && row?.antwoord === 'Eerst laten ophalen — vóór vrijdag', JSON.stringify(row));
  const woke = await until(() => app.ctx.store.messages(chat.id).find((m) => m.role === 'assistant' && /Ik ga verder met: Eerst laten ophalen/.test(m.content)));
  check('vragende bot gewekt met het antwoord in zijn eigen chat', !!woke);
  check('kaart verdwijnt uit Wacht op jou', (await page.locator('text=Accu terugbetalen of eerst ophalen?').count()) === 0);
  check('telefoon: wachtende taak zichtbaar in Wacht op jou', (await page.locator('text=/1 taak wacht op jou/').count()) === 1);

  // Every Teamwerk tab on the phone: no horizontal scrolling.
  const bad = [];
  for (const tab of ['taken', 'beslissingen', 'logboek', 'gebeurtenissen', 'experimenten', 'tabellen']) {
    await page.evaluate((t) => (location.hash = `#/m/teamdata/${t}`), tab);
    await page.waitForTimeout(500);
    if (!(await fits(page))) bad.push(tab);
    if (shots) await page.screenshot({ path: path.join(shots, `telefoon-${tab}.png`) });
  }
  check('telefoon: Teamwerk zonder horizontaal scrollen', !bad.length, bad.join(', '));
  check('geen paginafouten op de telefoon', errors.length === 0, errors.join(' | ').slice(0, 200));
  await phone.close();

  // ---------------- desktop: task board, log search, tables ----------------
  const desk = await browser.newContext({ viewport: { width: 1360, height: 900 }, bypassCSP: true });
  const d = await desk.newPage();
  await d.goto(`${app.url}/#token=${token}`);
  await d.waitForTimeout(800);
  await d.evaluate(() => (location.hash = '#/m/teamdata/taken'));
  await d.waitForSelector('text=Bing opschonen', { timeout: 10_000 });
  await d.getByRole('button', { name: /Bing opschonen/ }).click();
  const dialog = d.getByRole('dialog');
  check('taak opent met resultaat en bewijs', (await dialog.locator('a[href="https://example.com/bewijs"]').count()) === 1);
  await dialog.getByRole('combobox').selectOption('klaar');
  await dialog.getByRole('button', { name: 'Opslaan' }).click();
  const task = await until(async () => (await svc.rows(owner.id, "SELECT status FROM taken WHERE titel LIKE 'Bing%'"))[0]?.status === 'klaar');
  check('eigenaar zet de taakstatus', !!task);

  await d.getByRole('tab', { name: /Logboek/ }).click();
  await d.waitForSelector('text=80 wijzigingen');
  await d.getByLabel('Logboek doorzoeken').fill('discover robots');
  await d.waitForSelector('text=1 wijzigingen', { timeout: 5000 }).catch(() => {});
  const items = await d.locator('main li').count();
  check('logboek zoeken vindt de juiste wijziging', items === 1 && (await d.locator('text=Robots-meta aangepast voor Discover').count()) === 1, `${items} resultaten`);
  await d.getByRole('tab', { name: /Tabellen/ }).click();
  await d.getByRole('button', { name: /logboek/ }).click();
  await d.waitForSelector('table');
  check('tabelweergave toont rijen', (await d.locator('tbody tr').count()) === 50);

  // axe on every tab (light and dark).
  const findings = [];
  for (const scheme of ['light', 'dark']) {
    await d.emulateMedia({ colorScheme: scheme });
    for (const tab of ['taken', 'beslissingen', 'logboek', 'gebeurtenissen', 'experimenten', 'tabellen']) {
      await d.evaluate((t) => (location.hash = `#/m/teamdata/${t}`), tab);
      await d.waitForTimeout(450);
      await d.addScriptTag({ content: axeSource });
      const v = await d.evaluate(async () => {
        // @ts-ignore
        const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
        return r.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.target.join(' ')}`);
      });
      for (const x of v) findings.push(`${scheme}/${tab} ${x}`);
    }
  }
  check('geen ernstige toegankelijkheidsfouten op Teamwerk', !findings.length, findings.slice(0, 5).join(' | '));
  await desk.close();

  // ---------------- tablet ----------------
  const tab = await browser.newContext({ ...devices['iPad Pro 11'] });
  const tp = await tab.newPage();
  await tp.goto(`${app.url}/#token=${token}`);
  await tp.waitForTimeout(700);
  const badTab = [];
  for (const h of ['/inbox', '/m/teamdata/taken', '/m/teamdata/logboek', '/m/teamdata/tabellen']) {
    await tp.evaluate((x) => (location.hash = x), '#' + h);
    await tp.waitForTimeout(450);
    if (!(await fits(tp))) badTab.push(h);
  }
  check('iPad: Teamwerk zonder horizontaal scrollen', !badTab.length, badTab.join(', '));
  await tab.close();
} catch (e) {
  check('onverwachte fout', false, e.message);
} finally {
  await browser.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} geslaagd`);
process.exit(failed ? 1 : 0);
