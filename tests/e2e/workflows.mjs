// Workflows (PARITEIT 9.8) as the owner uses them: the page with ready-made examples, "Gebruiken" picks his own bots
// per step, a change in the editor is a new version, "Starten" with an input, the run page live (the checker sends the
// text back once), the approval card on the run page and in "Wacht op jou", "Akkoord, ga door", the result, the
// message in the bell, Ctrl+K finds the page, "Niet akkoord" stops a run, and the same pages on a phone.
// axe-core WCAG 2.2 A/AA on the three pages. Edge/Chrome headless, temp data dir, temp APPDATA and home.
// Usage: npm run build:ui && node --import tsx tests/e2e/workflows.mjs
//   TEAMBOT_E2E_PORT (never 4747/4748), TEAMBOT_E2E_SHOTS=<dir> for screenshots, TEAMBOT_UI_DIR=<built ui>.
// A built UI inside a folder named .claude is not served by Express: the script then copies dist/ui to the temp dir.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const step = (s) => console.log(`• ${s}`);
const fail = (s) => {
  console.error(`✗ ${s}`);
  process.exitCode = 1;
};
const port = Number(process.env.TEAMBOT_E2E_PORT) || 0;
if (port === 4747 || port === 4748) throw new Error('4747/4748 zijn van de geïnstalleerde TeamBot');
const killer = setTimeout(() => (console.error('workflows e2e: time-out na 4 minuten'), process.exit(2)), 240_000);
killer.unref();

// The browser keeps this computer's own environment; only the server gets the temporary folders.
const parentEnv = { ...process.env };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-e2e-workflows-'));
const tmp = (p) => {
  const d = path.join(dir, p);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
Object.assign(process.env, { TEAMBOT_DATA: tmp('data'), APPDATA: tmp('appdata'), LOCALAPPDATA: tmp('localappdata'), USERPROFILE: tmp('home'), HOME: tmp('home'), TEAMBOT_OPENBOT_DIR: tmp('no-openbot'), TEAMBOT_OPENBOT_HOME: tmp('home') });
if (!process.env.TEAMBOT_UI_DIR && path.resolve('dist/ui').includes(`${path.sep}.claude${path.sep}`)) {
  fs.cpSync(path.resolve('dist/ui'), path.join(dir, 'ui'), { recursive: true });
  process.env.TEAMBOT_UI_DIR = path.join(dir, 'ui');
}

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true, env: parentEnv });
const { createApp } = await import('../../server/app.ts');
const app = await createApp({ dataDir: process.env.TEAMBOT_DATA, port, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();

// A fake engine that answers by the step it is asked to do; the checker rejects the first text and accepts the second.
let checks = 0;
const TEXT2 = '# Stadsfiets Rood\n\nEen lichte stadsfiets met zeven versnellingen, een stille naafdynamo en een bagagedrager voor 25 kilo. Gemaakt voor elke dag, bij elk weer.';
const answer = (asked) => {
  if (/Zoekwoorden en concurrenten/.test(asked)) return 'Hoofdzoekwoord: rode stadsfiets. Bijzoekwoorden: stadsfiets dames, fiets 7 versnellingen. Titel: Rode stadsfiets kopen.';
  if (/Producttekst schrijven/.test(asked)) return /AFGEKEURD/.test(asked) ? TEXT2 : 'Rode fiets. Goed.';
  if (/Kwaliteitscontrole/.test(asked)) return ++checks === 1 ? 'AFGEKEURD: de tekst is te kort en noemt geen eigenschappen.' : `AKKOORD\n\n${TEXT2}`;
  if (/Klaarzetten in de webshop/.test(asked)) return 'De pagina staat klaar als concept in de webshop: Stadsfiets Rood.';
  return 'Gedaan.';
};
app.ctx.providers.registerKind({
  id: 'mock',
  label: 'Testmodel',
  type: 'api',
  billing: 'local',
  needsKey: false,
  description: 'e2e',
  models: ['mock-1'],
  defaultModel: 'mock-1',
  create: () => ({
    kind: 'mock',
    async listModels() {
      return [{ id: 'mock-1' }];
    },
    async test() {
      return { ok: true, detail: 'mock' };
    },
    async chat(req, _signal, onEvent) {
      const last = [...req.messages].reverse().find((m) => m.role === 'user');
      const text = answer(typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content));
      await new Promise((r) => setTimeout(r, 250));
      onEvent({ type: 'text', delta: text });
      return { text, toolCalls: [], usage: { input: 10, output: 5 }, stop: 'end', model: req.model };
    },
  }),
});
const call = async (method, p, body) => {
  const r = await fetch(`${app.url}/api${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};
const prov = await call('POST', '/providers', { kind: 'mock', name: 'Testmodel' });
const bots = {};
for (const [name, role] of [['Baas', 'Hoofdbot'], ['SEO & Content', 'Zoekwoorden en teksten'], ['Content Kwaliteit', 'Controleert teksten'], ['Bouwer Sites', 'Bouwt en beheert de webshop'], ['Ads & Shopping', 'Google Ads en Merchant Center']])
  bots[name] = await call('POST', '/agents', { name, role, provider_id: prov.id, model: 'mock-1', access_mode: 'auto' });
const SHOTS = process.env.TEAMBOT_E2E_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const shot = async (page, name) => SHOTS && (await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }));
step(`TeamBot op ${app.url}`);

const errors = [];
const axe = async (page, where) => {
  await page.addScriptTag({ content: axeSource });
  const v = await page.evaluate(async () => {
    // @ts-ignore
    const r = await window.axe.run(document.querySelector('main') || document.body, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
    return r.violations.map((x) => `${x.id}: ${x.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`);
  });
  if (v.length) fail(`a11y ${where}: ${v.join(' | ')}`);
};
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'nl-NL', bypassCSP: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/favicon|401 \(Unauthorized\)/.test(m.text()) && errors.push(m.text()));
  page.on('dialog', (d) => (errors.push(`browserdialoog: ${d.message()}`), d.dismiss().catch(() => {})));
  await page.goto(`${app.url}/#token=${token}`);
  await page.waitForTimeout(800);

  // 1. Ctrl+K finds the page.
  await page.keyboard.press('Control+k');
  await page.keyboard.type('workflow');
  const hit = page.getByRole('option', { name: /Workflows/ }).first();
  await hit.waitFor({ timeout: 8000 }).catch(() => fail('Ctrl+K vindt “Workflows” niet'));
  await hit.click().catch(() => {});
  await page.getByRole('heading', { name: 'Workflows', level: 1 }).waitFor({ timeout: 8000 });
  await page.getByText('Nog geen workflows').waitFor({ timeout: 5000 });
  await page.getByText('Productpagina van idee tot live').waitFor({ timeout: 5000 });
  await shot(page, '1-workflows-leeg-met-voorbeelden');
  await axe(page, 'overzicht');
  step('Ctrl+K › “workflow” opent de pagina: lege staat met vier voorbeelden');

  // 2. Use an example: the owner's own bots are filled in per step.
  await page.locator('div', { hasText: /^Productpagina van idee tot live/ }).getByRole('button', { name: 'Gebruiken' }).first().click();
  await page.getByRole('heading', { name: 'Productpagina van idee tot live', level: 1 }).waitFor({ timeout: 8000 });
  const stepCard = (n) => page.locator(`[data-step="${n}"]`);
  await stepCard(7).waitFor({ timeout: 5000 });
  const chosen = async (n) => stepCard(n).getByLabel('Welke bot').evaluate((el) => el.options[el.selectedIndex].text);
  const picks = [await chosen(1), await chosen(2), await chosen(3), await chosen(6)];
  if (picks.join('|') !== 'SEO & Content|SEO & Content|Content Kwaliteit|Bouwer Sites') fail(`bots per stap: ${picks.join('|')}`);
  await shot(page, '2-editor-uit-voorbeeld');
  await axe(page, 'editor');
  step(`voorbeeld gebruikt: 7 stappen, bots gekozen op naam (${picks.join(', ')})`);

  // 3. A change is a new version; the earlier one can be put back.
  await stepCard(5).getByLabel('Wat moet je weten voor je akkoord geeft?').fill('Lees de tekst goed. Daarna gaat hij naar de webshop.');
  await page.getByRole('button', { name: 'Opslaan' }).click();
  await page.getByText('Eerdere versies').waitFor({ timeout: 8000 });
  await page.getByText('Eerdere versies').click(); // a fold: open it to see the versions
  await page.getByText('Versie 2', { exact: true }).waitFor({ timeout: 5000 });
  const wf = (await call('GET', '/workflows')).workflows[0];
  if (wf.version !== 2 || wf.steps[4].note !== 'Lees de tekst goed. Daarna gaat hij naar de webshop.') fail(`na opslaan: versie ${wf.version}, ${JSON.stringify(wf.steps[4])}`);
  step('stap 5 aangepast en opgeslagen: versie 2, versie 1 staat bij “Eerdere versies”');

  // 4. Start with an input; the run page shows the steps live.
  await page.getByRole('button', { name: 'Starten' }).first().click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Waar moet de workflow mee werken?').fill('Stadsfiets Rood, 7 versnellingen, naafdynamo');
  await dlg.getByRole('button', { name: 'Starten' }).click();
  await page.waitForURL(/#\/m\/workflows\/run\//, { timeout: 8000 });
  const card = page.getByRole('group', { name: 'Akkoord voor een workflow' });
  await card.waitFor({ timeout: 30_000 });
  await page.getByText('Nee, terug naar stap 2: Producttekst schrijven').waitFor({ timeout: 5000 });
  const titles = await page.locator('ol > li[data-trace] span.font-semibold').allTextContents();
  const want = ['1. Zoekwoorden en concurrenten', '2. Producttekst schrijven', '3. Kwaliteitscontrole', '4. Goedgekeurd door de controle?', '2. Producttekst schrijven', '3. Kwaliteitscontrole', '4. Goedgekeurd door de controle?', '5. Jouw akkoord'];
  if (titles.map((s) => s.trim()).join('|') !== want.join('|')) fail(`stappen op de runpagina: ${titles.join('|')}`);
  if (!(await card.getByText('zeven versnellingen', { exact: false }).count())) fail('de kaart toont de tekst niet waar je akkoord op geeft');
  if (!(await card.getByText('Lees de tekst goed. Daarna gaat hij naar de webshop.').count())) fail('de kaart toont de toelichting van de stap niet');
  if (!(await page.getByText('Wacht op jou').count())) fail('status “Wacht op jou” ontbreekt');
  await shot(page, '3-run-wacht-op-akkoord');
  await axe(page, 'run');
  step('gestart: de controle stuurde de tekst één keer terug, daarna wacht de run op jouw akkoord met de tekst erbij');

  // 5. The same card is in "Wacht op jou".
  const runUrl = page.url();
  await page.goto(`${app.url}/#/inbox`);
  const inboxCard = page.getByRole('group', { name: 'Akkoord voor een workflow' });
  await inboxCard.waitFor({ timeout: 8000 }).catch(() => fail('de kaart staat niet in Wacht op jou'));
  await shot(page, '4-wacht-op-jou');
  await inboxCard.getByRole('link', { name: 'naar de run' }).click();
  await page.waitForURL(/#\/m\/workflows\/run\//, { timeout: 5000 });
  if (page.url() !== runUrl) fail('“naar de run” opent een andere pagina');
  step('“Wacht op jou” toont dezelfde kaart; “naar de run” brengt je terug');

  // 6. Approve: the last bot does its step, the result is shown and told.
  await page.getByRole('group', { name: 'Akkoord voor een workflow' }).getByRole('button', { name: 'Akkoord, ga door' }).click();
  await page.getByText('Resultaat', { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByText('De pagina staat klaar als concept in de webshop: Stadsfiets Rood.').first().waitFor({ timeout: 5000 });
  if (await page.getByRole('group', { name: 'Akkoord voor een workflow' }).count()) fail('de kaart staat er nog na het akkoord');
  await shot(page, '5-run-klaar');
  const runs = (await call('GET', `/workflows/${wf.id}/runs`)).runs;
  if (runs.length !== 1 || runs[0].status !== 'done') fail(`runs: ${JSON.stringify(runs)}`);
  const notes = await call('GET', '/notifications');
  const list = Array.isArray(notes) ? notes : notes.items || notes.notifications || [];
  if (!list.some((n) => /Productpagina van idee tot live/.test(n.title || ''))) fail(`geen melding van de workflow: ${JSON.stringify(list.map((n) => n.title))}`);
  step('akkoord gegeven: stap 6 gedaan, resultaat op de pagina en een melding in de bel');

  // 7. The work of a step opens as a conversation of that bot, with a way back to the run.
  await page.getByRole('link', { name: 'Bekijk het werk' }).first().click();
  await page.waitForURL(/#\/t\//, { timeout: 5000 });
  await page.getByText('Stap van een workflow', { exact: false }).first().waitFor({ timeout: 8000 }).catch(() => fail('het gesprek van de stap toont de link naar de run niet'));
  step('“Bekijk het werk” opent het gesprek van die bot met een link terug naar de run');

  // 8. The overview: last run, and a second run that the owner does not approve.
  await page.goto(`${app.url}/#/m/workflows`);
  await page.getByText('Klaar', { exact: true }).first().waitFor({ timeout: 8000 });
  await shot(page, '6-overzicht-met-run');
  checks = 1; // the checker accepts at once this time
  await page.getByRole('button', { name: 'Starten' }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Starten' }).click();
  const card2 = page.getByRole('group', { name: 'Akkoord voor een workflow' });
  await card2.waitFor({ timeout: 30_000 });
  await card2.getByRole('button', { name: 'Niet akkoord, stop' }).click();
  await page.getByText('Niet goedgekeurd bij “Jouw akkoord”.').waitFor({ timeout: 8000 });
  const after = (await call('GET', `/workflows/${wf.id}/runs`)).runs;
  if (after[0].status !== 'stopped') fail(`na niet akkoord: ${after[0].status}`);
  const denied = await call('GET', `/workflow-runs/${after[0].id}`);
  if (denied.trace.at(-1).status !== 'denied' || denied.trace.some((x) => x.title === 'Klaarzetten in de webshop')) fail(`stap 6 liep toch na “Niet akkoord”: ${denied.trace.map((x) => `${x.title}:${x.status}`).join(', ')}`);
  if (await page.locator('ol > li[data-trace]').getByText('Klaarzetten in de webshop').count()) fail('de runpagina toont stap 6 als gedaan na “Niet akkoord”');
  step('tweede run: “Niet akkoord, stop” stopt de run; de stap erna is niet gedaan');

  // 9. Build one by hand.
  await page.goto(`${app.url}/#/m/workflows/w/nieuw`);
  await page.getByLabel('Naam', { exact: true }).fill('Ads nakijken');
  await page.getByRole('button', { name: 'Bot', exact: true }).click();
  await stepCard(1).getByLabel('Welke bot').selectOption({ label: 'Ads & Shopping' });
  await stepCard(1).getByLabel('Naam van de stap').fill('Cijfers');
  await stepCard(1).getByLabel('Wat moet de bot doen?').fill('Bekijk de campagnes van deze week.');
  await page.getByRole('button', { name: 'Jouw akkoord', exact: true }).click();
  await page.getByRole('button', { name: 'Opslaan' }).click();
  await page.waitForURL(/#\/m\/workflows\/w\/wfl_/, { timeout: 8000 });
  await page.getByLabel('Vanzelf starten').selectOption('weekly');
  await page.getByRole('button', { name: 'vr', exact: true }).click();
  await page.getByRole('button', { name: 'Opslaan' }).click();
  await page.waitForTimeout(600);
  const mine = (await call('GET', '/workflows')).workflows.find((w) => w.name === 'Ads nakijken');
  if (!mine || mine.steps.length !== 2 || mine.schedule.kind !== 'weekly' || mine.schedule.days.join() !== '1,5' || !mine.nextRun) fail(`eigen workflow: ${JSON.stringify(mine)}`);
  await shot(page, '7-eigen-workflow-met-schema');
  step('zelf een workflow gemaakt (bot + akkoord) met een schema op maandag en vrijdag: de volgende run is bekend');

  // 10. Phone.
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'nl-NL', bypassCSP: true, isMobile: true, hasTouch: true })).newPage();
  phone.on('pageerror', (e) => errors.push(`telefoon: ${e.message}`));
  await phone.goto(`${app.url}/#token=${token}`);
  await phone.waitForTimeout(600);
  await phone.goto(`${app.url}/#/m/workflows`);
  await phone.getByRole('heading', { name: 'Workflows', level: 1 }).waitFor({ timeout: 8000 });
  await phone.getByText('Ads nakijken').waitFor({ timeout: 5000 });
  const wide = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (wide) fail('telefoon: het overzicht schuift opzij');
  if (SHOTS) await phone.screenshot({ path: path.join(SHOTS, '8-telefoon-overzicht.png') });
  await phone.goto(runUrl);
  await phone.getByText('Resultaat', { exact: true }).waitFor({ timeout: 8000 });
  if (await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) fail('telefoon: de runpagina schuift opzij');
  if (SHOTS) await phone.screenshot({ path: path.join(SHOTS, '9-telefoon-run.png') });
  step('telefoonbreedte: overzicht en runpagina passen zonder opzij schuiven');

  if (errors.length) fail(`paginafouten: ${[...new Set(errors)].slice(0, 5).join(' | ')}`);
} catch (e) {
  fail(String(e?.stack || e));
} finally {
  await browser.close().catch(() => {});
  await app.close().catch(() => {});
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}
console.log(process.exitCode ? '✗ workflows e2e: MISLUKT' : '✔ workflows e2e: geslaagd');
process.exit(process.exitCode || 0);
