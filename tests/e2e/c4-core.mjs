// End-to-end: core gaps from acceptance round 3 (A-08, A-35, A-58, Q-02 and the later round-4 items).
// A paused (archived) bot's face has its status text; code blocks and code files get syntax colours (light + dark);
// the side panel lists the bot's own files of the conversation (preview) and its steps (no "Nog geen tools gebruikt"
// for a CLI bot); "Wat … zag en deed" per bot; the "Naar de inhoud" skip link; bot actions only in the chat menu (the
// editor links there). Desktop 1360×880 and phone 390×844; no console errors.
// Usage: npm run build:ui && node --import tsx tests/e2e/c4-core.mjs   (TEAMBOT_E2E_SHOTS=<dir> for screenshots)
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
const shots = process.env.TEAMBOT_E2E_SHOTS || '';
if (shots) fs.mkdirSync(shots, { recursive: true });
// A short pause first: tabs and menus fade in (150 ms).
const shot = async (page, name) => shots && (await page.waitForTimeout(450), await page.screenshot({ path: path.join(shots, `${name}.png`) }));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-c4-core-'));
const app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();

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
      onEvent({ type: 'text', delta: 'Oké.' });
      return { text: 'Oké.', toolCalls: [], usage: { input: 10, output: 5 }, stop: 'end', model: req.model };
    },
  }),
});
const api = async (method, p, body) => {
  const res = await fetch(app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${j.error}`);
  return j;
};
await api('PUT', '/settings', { onboarded: true });
const prov = await api('POST', '/providers', { kind: 'e2emock' });
const mk = (name, extra = {}) => api('POST', '/agents', { name, provider_id: prov.id, model: 'e2e-1', access_mode: 'ask', ...extra });
const mila = await mk('Mila', { role: 'Codeerhulp' });
const slaap = await mk('Slaapkop', { role: 'Oude helper' });
await api('PATCH', `/agents/${slaap.id}`, { archived: true });

// A conversation as a CLI bot leaves it: steps with facts, a file it wrote in its folder, a code block, an approval.
const ws = mila.workspace;
fs.mkdirSync(path.join(ws, 'scripts'), { recursive: true });
fs.writeFileSync(path.join(ws, 'scripts', 'tel.py'), 'import sys\n\n\ndef tel(woorden):\n    """Tel de woorden."""\n    return len(woorden.split())  # simpel\n\n\nprint(tel(sys.argv[1]))\n');
const th = await api('POST', '/threads', { agentId: mila.id });
const now = () => new Date().toISOString();
app.ctx.store.createMessage({ thread_id: th.id, role: 'user', author_type: 'user', author_id: owner.id, author_name: owner.name, content: 'Schrijf een script dat woorden telt.' });
app.ctx.store.createMessage({
  thread_id: th.id,
  role: 'assistant',
  author_type: 'agent',
  author_id: mila.id,
  author_name: 'Mila',
  status: 'done',
  content: 'Ik heb `scripts/tel.py` gemaakt:\n\n```python\nimport sys\n\ndef tel(woorden):\n    return len(woorden.split())  # simpel\n\nprint(tel(sys.argv[1]))\n```\n\nEn zo start je het:\n\n```\npython scripts/tel.py "een twee drie"\n```',
  parts: {
    model: 'default',
    activity: [
      { kind: 'tool', title: 'Las een webpagina: https://example.org/python-tips', ts: now(), facts: [{ op: 'web', target: 'https://example.org/python-tips' }] },
      { kind: 'tool', title: 'Schreef scripts/tel.py', ts: now(), facts: [{ op: 'write', target: path.join(ws, 'scripts', 'tel.py') }] },
      { kind: 'tool', title: 'Voerde uit: python scripts/tel.py "een twee drie"', ts: now(), facts: [{ op: 'exec', target: 'python scripts/tel.py "een twee drie"' }] },
    ],
  },
});
app.ctx.store.insert('approvals', { id: 'apr_c4e2e', user_id: owner.id, agent_id: mila.id, thread_id: th.id, kind: 'tool', tool: 'Write', input: {}, summary: 'Bestand schrijven: scripts/tel.py', risk: 'write', status: 'approved', created_at: now() });

// This test checks the side panel's activity tab (steps) and the phone's "Activiteit, bestanden en details": those are expert panels, shown with Instellingen › Geavanceerd tonen (settings.ui.advanced).
app.ctx.store.setSetting(owner.id, 'ui', { ...(app.ctx.store.settings(owner.id).ui || {}), advanced: true });
const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const errors = [];
const watch = (page) => page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED|404 \(Not Found\)/.test(m.text()) && errors.push(m.text()));
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
try {
  const ctxb = await browser.newContext({ viewport: { width: 1360, height: 880 } });
  const page = await ctxb.newPage();
  watch(page);
  await page.goto(`${app.url}/#token=${token}`);
  await page.goto(`${app.url}/#/t/${th.id}`);
  await page.getByRole('textbox', { name: 'Bericht' }).waitFor({ timeout: 10000 });

  // Q-02: "Naar de inhoud" is the first Tab stop of a freshly opened page; in a chat it lands in the message box.
  const pk = await browser.newPage({ viewport: { width: 1360, height: 880 } });
  watch(pk);
  await pk.goto(`${app.url}/#token=${token}`);
  await pk.goto(`${app.url}/#/agents`);
  await pk.getByRole('heading', { name: 'Alle bots' }).waitFor({ timeout: 8000 });
  await pk.reload();
  await pk.getByRole('heading', { name: 'Alle bots' }).waitFor({ timeout: 8000 });
  await pk.keyboard.press('Tab');
  const first = await pk.evaluate(() => document.activeElement?.textContent?.trim());
  if (first !== 'Naar de inhoud') fail(`eerste Tab-stop is "${first}", niet "Naar de inhoud"`);
  await shot(pk, 'c4-q02-skiplink');
  await pk.keyboard.press('Enter');
  if ((await pk.evaluate(() => document.activeElement?.id)) !== 'inhoud') fail('skiplink zet de focus niet op de inhoud');
  await pk.keyboard.press('Tab');
  const next = await pk.evaluate(() => !!document.activeElement?.closest('main'));
  if (!next) fail('Tab na de skiplink gaat niet verder in de inhoud');
  await pk.close();
  await page.getByRole('link', { name: 'Naar de inhoud' }).focus();
  await page.keyboard.press('Enter');
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  if (focused !== 'Bericht') fail(`na de skiplink staat de focus op "${focused}", niet in het berichtveld`);
  step('Q-02: skiplink "Naar de inhoud" is de eerste Tab-stop; in een chat gaat hij naar het berichtveld');

  // A-35: syntax colours in the chat (tagged block coloured, plain command block too as a guess, or plain text).
  const kw = page.locator('.md pre code.hljs .hljs-keyword').first();
  await kw.waitFor({ timeout: 8000 }).catch(() => fail('codeblok zonder syntaxkleuring'));
  const colLight = await kw.evaluate((e) => getComputedStyle(e).color);
  await page.locator('.md pre').first().scrollIntoViewIfNeeded();
  await shot(page, 'c4-a35-code-licht');
  // A-58: the side panel lists the CLI bot's steps (no "Nog geen tools gebruikt").
  await page.getByRole('button', { name: 'Zijpaneel' }).click();
  await page.getByText('Stappen in dit gesprek').waitFor({ timeout: 5000 });
  if (await page.getByText('Nog geen tools gebruikt').count()) fail('zijpaneel zegt nog "Nog geen tools gebruikt"');
  for (const s of ['Schreef scripts/tel.py', 'Voerde uit: python scripts/tel.py']) if (!(await page.getByRole('complementary').or(page.locator('body')).getByText(s, { exact: false }).count())) fail(`stap "${s}" niet in het zijpaneel`);
  await shot(page, 'c4-a58-zijpaneel-stappen');
  // A-35: the bot's own file in Zijpaneel › Bestanden, with a coloured preview.
  // With "Geavanceerd tonen" (on in this test) the panel has tabs and opens on Activiteit; Bestanden is the next tab.
  await page.getByRole('button', { name: 'Zijpaneel sluiten' }).waitFor({ timeout: 5000 });
  await page.getByRole('tab', { name: 'Bestanden', exact: true }).click();
  await page.getByRole('list', { name: 'Gemaakt of gewijzigd door Mila' }).waitFor({ timeout: 5000 });
  const fileBtn = page.getByRole('button', { name: /tel\.py/ }).first();
  await fileBtn.waitFor({ timeout: 5000 }).catch(() => fail('tel.py staat niet onder Bestanden'));
  await shot(page, 'c4-a35-zijpaneel-bestanden');
  await fileBtn.click();
  const dlg = page.getByRole('dialog');
  await dlg.locator('pre code.hljs .hljs-keyword').first().waitFor({ timeout: 8000 }).catch(() => fail('bestandsvoorbeeld zonder syntaxkleuring'));
  if (!(await dlg.getByRole('link', { name: /Downloaden/ }).count())) fail('voorbeeld zonder Downloaden');
  await shot(page, 'c4-a35-voorbeeld-licht');
  await page.keyboard.press('Escape');
  step('A-35/A-58: codeblok gekleurd, zijpaneel toont stappen en eigen bestand met gekleurd voorbeeld');

  // A-58: "Wat Mila zag en deed" from the chat menu.
  await page.getByRole('button', { name: 'Meer opties' }).click();
  await page.getByRole('link', { name: 'Wat Mila zag en deed' }).click();
  await page.getByRole('heading', { name: 'Wat Mila zag en deed' }).waitFor({ timeout: 8000 });
  for (const s of ['tel.py', 'https://example.org/python-tips', 'python scripts/tel.py "een twee drie"', 'Bestand schrijven: scripts/tel.py', 'toegestaan']) if (!(await page.getByText(s, { exact: false }).count())) fail(`"Wat Mila zag en deed" mist "${s}"`);
  await shot(page, 'c4-a58-gezien-en-gedaan');
  step('A-58: per bot bestanden, webpagina, opdracht en goedkeuring');

  // A-08: an archived (paused) bot has its status text on the card.
  await page.goto(`${app.url}/#/agents`);
  await page.getByText('Archief', { exact: true }).click();
  const card = page.locator('div.group').filter({ hasText: 'Slaapkop' }).first();
  await card.waitFor({ timeout: 5000 });
  if (!(await card.getByText('gepauzeerd').count())) fail('gearchiveerde bot zonder statustekst "gepauzeerd"');
  await shot(page, 'c4-a08-archief');
  step('A-08: gearchiveerde bot: slapend gezicht met "gepauzeerd"');

  // Q-02: the bot page has the bot actions themselves (the owner asked for them on 10 November; before, a button led to the chat menu).
  await page.goto(`${app.url}/#/agents/${mila.id}`);
  await page.getByRole('heading', { name: 'Beheer' }).waitFor({ timeout: 8000 });
  await page.getByRole('heading', { name: 'Beheer' }).scrollIntoViewIfNeeded();
  await shot(page, 'c4-q02-editor-beheer');
  for (const name of ['Dupliceren', 'Archiveren', 'Verwijderen…']) if (!(await page.getByRole('button', { name, exact: true }).count())) fail(`bot-pagina mist de knop ${name}`);
  step('Q-02: dupliceren, archiveren en verwijderen staan op de bot-pagina');

  // A-76: "Houd de pc wakker …" — without a desktop shell honest and not switchable; with one (a stand-in blocker
  // here; the real Electron one: npm run power:check) the option works and the sidebar says why the pc stays awake.
  await page.goto(`${app.url}/#/settings/general?meer=1`);
  const awake = page.getByRole('switch', { name: /Houd de pc wakker/ }).or(page.getByLabel(/Houd de pc wakker/)).first();
  await awake.waitFor({ timeout: 8000 });
  if (!(await page.getByText('Kan alleen in de desktop-app van TeamBot').count())) fail('zonder desktop-app geen eerlijke uitleg bij "pc wakker houden"');
  if (!(await awake.isDisabled())) fail('"pc wakker houden" is aan te zetten zonder desktop-app');
  const held = [];
  const detachPower = app.ctx.services.power.attach({ set: (a, r) => held.push([a, r]) });
  await page.reload();
  await awake.waitFor({ timeout: 8000 });
  if (await awake.isDisabled()) fail('"pc wakker houden" blijft uit te schakelen met desktop-app');
  await awake.click();
  await page.getByText('Nu niet nodig').waitFor({ timeout: 5000 }).catch(() => fail('geen status na aanzetten'));
  const soon = new Date(Date.now() + 12 * 60_000).toISOString();
  app.ctx.store.insert('routines', { id: 'rt_c4wake', user_id: owner.id, agent_id: mila.id, name: 'Ochtendnieuws', prompt: 'x', status: 'active', schedule: { kind: 'none' }, timezone: 'Europe/Amsterdam', options: {}, next_run_at: soon, created_at: now(), updated_at: now() });
  app.ctx.services.power.evaluate();
  await page.getByRole('status').filter({ hasText: 'Pc blijft wakker' }).waitFor({ timeout: 5000 }).catch(() => fail('zijbalk toont niet dat de pc wakker blijft'));
  if (!held.some(([a]) => a)) fail('blocker niet aangezet');
  await page.getByText('Nu wakker: routine “Ochtendnieuws”', { exact: false }).scrollIntoViewIfNeeded();
  await shot(page, 'c4-a76-pc-wakker');
  step('A-76: optie standaard uit, eerlijk zonder desktop-app, aan → zijbalk "Pc blijft wakker · routine …"');

  // A-78: a waitpoint (as wait_for sets it) on the routines page, and the calendar (month, a day, week).
  const engine = app.ctx.services.routines.engine;
  await api('POST', '/routines', { name: 'Werkdagoverzicht', agent_id: mila.id, prompt: 'Vat de dag samen.', timezone: 'Europe/Amsterdam', schedule: { kind: 'weekly', days: ['ma', 'di', 'wo', 'do', 'vr'], times: ['08:30'] } });
  const wp = await engine.createWaitpoint(owner.id, mila, th.id, { kind: 'file', path: 'scripts', pattern: '*.csv', timeoutMinutes: 180, then: 'Lees de nieuwe cijfers en vat ze samen.' });
  await page.goto(`${app.url}/#/m/routines`);
  const wcard = page.locator('div').filter({ has: page.getByRole('link', { name: wp.routine.name }) }).filter({ hasText: 'Wachtpunt' }).first();
  await wcard.waitFor({ timeout: 8000 }).catch(() => fail('wachtpunt niet als "Wachtpunt" op de routinepagina'));
  if (!(await page.getByText(/Wacht op een nieuw bestand “\*\.csv” in scripts · uiterlijk/).count())) fail('wachtpunt zonder "Wacht op … uiterlijk …"');
  await shot(page, 'c4-a78-wachtpunt');
  await page.getByTestId('auto-more').click();
  await page.getByRole('menuitem', { name: 'Kalender' }).click();
  await page.getByRole('radio', { name: 'Maand', exact: true }).waitFor({ timeout: 8000 });
  const todayBtn = page.getByRole('button', { name: new RegExp(`^${new Date().toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' })}:`) });
  await todayBtn.waitFor({ timeout: 5000 }).catch(() => fail('kalender: vandaag niet in de maand'));
  if (!(await page.getByText('Werkdagoverzicht').count()) && !(await page.getByText(wp.routine.name).count())) fail('kalender toont geen geplande runs');
  await shot(page, 'c4-a78-kalender-maand');
  await page.getByRole('radio', { name: 'Week', exact: true }).click();
  await page.getByText(wp.routine.name).first().waitFor({ timeout: 5000 }).catch(() => fail('kalender (week): wachtpunt niet zichtbaar'));
  await shot(page, 'c4-a78-kalender-week');
  step('A-78: wachtpunt op de routinepagina; kalender per maand en week met geplande runs');

  // A-14: a team from a template (preview, then one button makes the bots and the group).
  await page.goto(`${app.url}/#/m/rooms`);
  await page.getByRole('button', { name: 'Nieuwe groep' }).first().click();
  await page.getByRole('tab', { name: 'Uit een sjabloon' }).click();
  await page.getByRole('radio', { name: /Onderzoek en schrijven/ }).click();
  await page.getByText('lead', { exact: true }).first().waitFor({ timeout: 8000 }).catch(() => fail('sjabloon: geen voorbeeld met lead'));
  for (const n of ['Redacteur', 'Onderzoeker', 'Schrijver']) if (!(await page.getByRole('dialog').getByText(n, { exact: true }).count())) fail(`sjabloon-voorbeeld mist ${n}`);
  await shot(page, 'c4-a14-sjabloon-voorbeeld');
  const agentsBefore = (await api('GET', '/agents')).length;
  await page.getByRole('dialog').getByRole('button', { name: 'Groepschat maken' }).click();
  await page.waitForURL(/#\/t\//, { timeout: 10000 }).catch(() => fail('na "Groep maken" geen groepsgesprek'));
  const roomsNow = await api('GET', '/rooms');
  const made = roomsNow.find((x) => x.name === 'Onderzoek en schrijven');
  if (!made) fail('team uit sjabloon: geen groep');
  if ((await api('GET', '/agents')).length !== agentsBefore + 3) fail('team uit sjabloon: niet precies 3 nieuwe bots');
  await shot(page, 'c4-a14-team-gemaakt');
  step('A-14: team uit sjabloon: voorbeeld, daarna 3 bots en een groep met lead');

  // A-63: export that group as a team package and import it (preview first).
  const pkgRes = await fetch(`${app.url}/api/rooms/${made.id}/package`, { headers: { authorization: `Bearer ${token}` } });
  const pkgText = await pkgRes.text();
  if (!/teambot\.team\/v1/.test(pkgText) || /workspaces|sk-/.test(pkgText)) fail('export: geen schoon teampakket');
  await page.goto(`${app.url}/#/m/rooms/groep/${made.id}`);
  await page.getByRole('button', { name: 'Meer opties', exact: true }).click({ timeout: 8000 }).catch(() => {});
  await page.getByRole('menuitem', { name: /Exporteren als team/ }).waitFor({ timeout: 8000 }).catch(() => fail('groep: geen "Exporteren als team"'));
  await shot(page, 'c4-a63-exporteren');
  await page.keyboard.press('Escape');
  const pkgFile = path.join(dir, 'Onderzoek_en_schrijven.teambot-team.json');
  fs.writeFileSync(pkgFile, pkgText);
  await page.goto(`${app.url}/#/m/rooms`);
  await page.getByRole('button', { name: 'Nieuwe groep' }).first().click();
  await page.getByRole('tab', { name: 'Importeren' }).click();
  await page.locator('input[type=file][accept*="json"]').last().setInputFiles(pkgFile);
  await page.getByRole('dialog').getByText('Redacteur', { exact: true }).waitFor({ timeout: 8000 }).catch(() => fail('import: geen voorbeeld'));
  if (!(await page.getByRole('dialog').getByText(/Komt niet mee: gesprekken/).count())) fail('import: voorbeeld zegt niet wat er niet meekomt');
  await shot(page, 'c4-a63-import-voorbeeld');
  await page.getByRole('dialog').getByRole('button', { name: 'Importeren', exact: true }).click();
  await page.waitForURL(/#\/t\//, { timeout: 10000 }).catch(() => fail('na "Groep importeren" geen groepsgesprek'));
  if ((await api('GET', '/rooms')).filter((x) => x.name === 'Onderzoek en schrijven').length !== 2) fail('import: geen tweede groep');
  step('A-63: groep exporteren als teampakket en weer importeren met voorbeeld');
  await ctxb.close();

  // Dark theme: the code colours change with the theme.
  const dark = await browser.newContext({ viewport: { width: 1360, height: 880 }, colorScheme: 'dark' });
  const pd = await dark.newPage();
  watch(pd);
  await pd.goto(`${app.url}/#token=${token}`);
  await pd.evaluate(() => localStorage.setItem('tb_theme', 'dark'));
  await pd.goto(`${app.url}/#/t/${th.id}`);
  const kwd = pd.locator('.md pre code.hljs .hljs-keyword').first();
  await kwd.waitFor({ timeout: 8000 });
  const colDark = await kwd.evaluate((e) => getComputedStyle(e).color);
  if (colDark === colLight) fail(`syntaxkleur gelijk in licht en donker (${colDark})`);
  await pd.locator('.md pre').first().scrollIntoViewIfNeeded();
  await shot(pd, 'c4-a35-code-donker');
  step(`A-35: kleuren volgen het thema (licht ${colLight}, donker ${colDark})`);
  await dark.close();

  // Phone.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p2 = await phone.newPage();
  watch(p2);
  await p2.goto(`${app.url}/#token=${token}`);
  await p2.goto(`${app.url}/#/t/${th.id}`);
  await p2.locator('.md pre code.hljs').first().waitFor({ timeout: 8000 });
  await p2.getByRole('button', { name: 'Meer opties' }).click();
  await p2.getByRole('button', { name: 'Activiteit, bestanden en details' }).click();
  await p2.getByRole('button', { name: 'Zijpaneel sluiten' }).waitFor({ timeout: 5000 });
  await p2.getByRole('tab', { name: 'Bestanden', exact: true }).click();
  await p2.getByRole('button', { name: /tel\.py/ }).first().waitFor({ timeout: 5000 }).catch(() => fail('telefoon: tel.py niet onder Bestanden'));
  if ((await overflow(p2)) > 1) fail('telefoon: overloop in het zijpaneel');
  await shot(p2, 'c4-a35-telefoon-bestanden');
  await p2.goto(`${app.url}/#/m/seen/${mila.id}`);
  await p2.getByRole('heading', { name: 'Wat Mila zag en deed' }).waitFor({ timeout: 8000 });
  if ((await overflow(p2)) > 1) fail('telefoon: overloop op "zag en deed"');
  await shot(p2, 'c4-a58-telefoon');
  await p2.goto(`${app.url}/#/agents`);
  await p2.getByText('Archief', { exact: true }).click();
  await p2.locator('div.group').filter({ hasText: 'Slaapkop' }).getByText('gepauzeerd').waitFor({ timeout: 5000 }).catch(() => fail('telefoon: archiefkaart zonder statustekst'));
  await shot(p2, 'c4-a08-telefoon-archief');
  await p2.goto(`${app.url}/#/settings/general?meer=1`);
  const pcCard = p2.getByRole('heading', { name: 'Pc en routines' });
  await pcCard.waitFor({ timeout: 8000 });
  await pcCard.scrollIntoViewIfNeeded();
  if ((await overflow(p2)) > 1) fail('telefoon: overloop bij "Pc en routines"');
  await shot(p2, 'c4-a76-telefoon');
  detachPower();
  await p2.goto(`${app.url}/#/m/routines/kalender`);
  await p2.getByRole('radio', { name: 'Maand', exact: true }).waitFor({ timeout: 8000 });
  // On a phone the calendar is an agenda: each day lists its planned runs by name.
  await p2.getByRole('link', { name: 'Werkdagoverzicht' }).first().waitFor({ timeout: 5000 }).catch(() => fail('telefoon: kalender zonder geplande runs'));
  if ((await overflow(p2)) > 1) fail('telefoon: overloop in de kalender');
  await shot(p2, 'c4-a78-telefoon-kalender');
  await p2.getByRole('radio', { name: 'Week', exact: true }).click();
  await p2.waitForTimeout(300);
  if ((await overflow(p2)) > 1) fail('telefoon: overloop in de weekweergave');
  await shot(p2, 'c4-a78-telefoon-week');
  await p2.goto(`${app.url}/#/m/rooms`);
  await p2.getByRole('button', { name: 'Nieuwe groep' }).first().click();
  await p2.getByRole('tab', { name: 'Uit een sjabloon' }).click();
  await p2.getByRole('radio', { name: /Klantenservice/ }).click();
  await p2.getByRole('dialog').getByText('Coördinator', { exact: true }).waitFor({ timeout: 8000 }).catch(() => fail('telefoon: sjabloon-voorbeeld ontbreekt'));
  if ((await overflow(p2)) > 1) fail('telefoon: overloop bij teamsjabloon');
  await shot(p2, 'c4-a14-telefoon-sjabloon');
  await p2.keyboard.press('Escape');
  step('telefoon: bestanden in het zijpaneel, "zag en deed", archiefkaart en "Pc en routines" zonder overloop');
  await phone.close();
} catch (e) {
  fail(e.stack || e.message);
} finally {
  await browser.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
if (errors.length) fail('console-fouten:\n  ' + errors.join('\n  '));
console.log(process.exitCode ? 'E2E C4-CORE MISLUKT' : 'E2E C4-CORE GESLAAGD');
