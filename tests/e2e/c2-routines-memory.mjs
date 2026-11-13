// Routines and memory details in a real browser (synthetic data, no real engine needed):
//  a  a loop in a routine chain is refused when it is set up (picker marks it, old data shows the loop)
//  b  rotating a webhook secret: "Direct ongeldig" by default, or a short overlap with "Nu intrekken"
//  c  a contradicting memory lands in Te beoordelen with old vs new and three choices
//  d  "Importeren uit Markdown": two .md files become dossiers (preview first; a secret file is refused)
//  e  a review interval per memory item; a due item shows up as "Klopt dit nog?"
// Usage: npm run build:ui && node --import tsx tests/e2e/c2-routines-memory.mjs   [TEAMBOT_E2E_SHOTS=<dir>]
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const { createApp } = await import('./server.mjs');

const step = (s) => console.log(`• ${s}`);
const fail = (s) => {
  console.error(`✗ ${s}`);
  process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = process.env.TEAMBOT_E2E_SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-c2-rm-'));
const app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();

// A local fake engine (no network): it just acknowledges.
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
      // A routine that has nothing new answers with the quiet token (step f).
      const text = JSON.stringify(req.messages || []).includes('NIETS-NIEUWS-TEST') ? 'ROUTINE_NO_UPDATE' : 'Genoteerd.';
      onEvent({ type: 'text', delta: text });
      return { text, toolCalls: [], usage: { input: 5, output: 3 }, stop: 'end', model: req.model };
    },
  }),
});
const prov = app.ctx.providers.create(owner.id, { kind: 'fake' });
app.ctx.store.setSetting(owner.id, 'defaultProvider', prov.id);
const bot = app.ctx.store.createAgent(owner.id, { name: 'Planner', role: 'Plant en onthoudt', provider_id: prov.id, model: 'fake-1', access_mode: 'ask', tool_groups: ['memory', 'routines'] });

const api = async (method, p, body) => {
  const res = await fetch(`${app.url}/api${p}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${j.error}`);
  return j;
};
const apiStatus = async (method, p, body) => {
  const res = await fetch(`${app.url}/api${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const hook = async (id, secret) => {
  const body = JSON.stringify({ type: 'deploy', n: crypto.randomUUID() });
  const t = Math.floor(Date.now() / 1000);
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const res = await fetch(`${app.url}/api/public/hooks/${id}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-teambot-timestamp': String(t), 'x-teambot-signature': sig, 'x-teambot-delivery': crypto.randomUUID() }, body });
  return res.status;
};
const idle = async (threadId, ms = 10_000) => {
  const t0 = Date.now();
  await sleep(50);
  while (Date.now() - t0 < ms) {
    if (!app.ctx.store.all("SELECT id FROM runs WHERE thread_id = ? AND status IN ('queued','running','waiting')", threadId).length) return;
    await sleep(40);
  }
  throw new Error('bot werd niet klaar');
};

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const errors = [];
const DESK = { width: 1360, height: 880 };
const PHONE = { width: 390, height: 844 };
try {
  const ctxDesk = await browser.newContext({ viewport: DESK });
  const page = await ctxDesk.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED/.test(m.text()) && errors.push(m.text()));
  const ctxPhone = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const phone = await ctxPhone.newPage();
  phone.on('pageerror', (e) => errors.push('telefoon: ' + e.message));
  phone.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED/.test(m.text()) && errors.push('telefoon: ' + m.text()));
  const shot = async (p, name) => {
    if (shots) await p.screenshot({ path: path.join(shots, `${name}.png`), fullPage: false });
  };
  // A fresh page load per screen (no toasts from the previous step in the screenshots).
  const go = async (p, hash) => {
    await p.goto('about:blank');
    await p.goto(`${app.url}/${hash}`);
    await p.waitForTimeout(700);
  };
  // Sign in once per device (the token is kept by the app).
  for (const p of [page, phone]) {
    await p.goto(`${app.url}/#token=${token}`);
    await p.waitForFunction(() => !location.hash.includes('token='), null, { timeout: 15000 });
  }
  const noOverflow = async (p, what) => {
    const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (over > 1) fail(`${what}: horizontale overloop ${over}px op 390 px`);
  };

  // ------------------------------------------------------------------ a: chain loop
  const mk = (name, extra = {}) => api('POST', '/routines', { name, agent_id: bot.id, prompt: 'Doe het werk.', timezone: 'Europe/Amsterdam', schedule: { kind: 'none' }, options: { notify: 'never' }, ...extra });
  const ra = await mk('Cijfers ophalen');
  const rb = await mk('Rapport maken');
  await api('PATCH', `/routines/${ra.id}`, { options: { then: { routineId: rb.id, on: 'done', passResult: true } } });
  const refused = await apiStatus('PATCH', `/routines/${rb.id}`, { options: { then: { routineId: ra.id } } });
  if (refused.status !== 400 || !/Dit maakt een kring: Rapport maken → Cijfers ophalen → Rapport maken/.test(refused.body.error || '')) fail(`a: kring niet geweigerd bij instellen (${refused.status} ${refused.body.error})`);
  await go(page, `#/m/routines/r/${rb.id}?tab=settings`);
  // "Daarna starten" is in the fold "Uitvoering" (which opens by itself once the routine has a chain).
  await page.getByTestId('routine-run').locator('summary').click();
  const picker = page.getByRole('combobox', { name: 'Daarna starten' });
  await picker.waitFor({ timeout: 10000 });
  const opt = picker.locator('option', { hasText: 'Cijfers ophalen' });
  if (!(await opt.isDisabled()) || !/maakt een kring, kan niet/.test(await opt.innerText())) fail('a: keuze die een kring maakt staat niet uit in de keuzelijst');
  // Screenshot with the list unfolded (a native list is not captured otherwise).
  const handle = await picker.elementHandle();
  await handle.evaluate((el) => ((el.size = 3), el.scrollIntoView({ block: 'center' })));
  await shot(page, 'c2-6a-keten-keuze-uit-desktop');
  await handle.evaluate((el) => (el.size = 0));
  // Old data (saved before the check) with B → A: the editor names the loop.
  const rowB = app.ctx.store.get('routines', rb.id);
  app.ctx.store.update('routines', rb.id, { options: { ...rowB.options, then: { routineId: ra.id, on: 'done', passResult: true } } });
  await go(page, `#/m/routines/r/${rb.id}?tab=settings`);
  const alertBox = page.getByRole('alert').filter({ hasText: 'Dit maakt een kring: Rapport maken → Cijfers ophalen → Rapport maken.' });
  await alertBox.waitFor({ timeout: 8000 }).catch(() => fail('a: editor toont de kring in oude data niet'));
  await alertBox.scrollIntoViewIfNeeded().catch(() => {});
  await shot(page, 'c2-6a-keten-kring-desktop');
  await go(phone, `#/m/routines/r/${rb.id}?tab=settings`);
  await phone.getByRole('alert').filter({ hasText: 'Dit maakt een kring' }).scrollIntoViewIfNeeded().catch(() => fail('a: telefoon toont de kring niet'));
  await shot(phone, 'c2-6a-keten-kring-telefoon');
  await noOverflow(phone, 'a');
  app.ctx.store.update('routines', rb.id, { options: { ...rowB.options, then: null } });
  step('a: kring A → B → A geweigerd bij instellen; keuzelijst zet hem uit; oude kring wordt benoemd');

  // ------------------------------------------------------------------ b: webhook secret rotation
  const created = await api('POST', `/routines/${ra.id}/triggers`, { kind: 'webhook', preset: 'hmac', name: 'Deploy-webhook' });
  const trg = created.trigger;
  const first = created.secret;
  if ((await hook(trg.id, first)) !== 202) fail('b: eerste geheim werkt niet');
  await go(page, `#/m/routines/r/${ra.id}?tab=triggers`);
  await page.getByRole('button', { name: 'Geheim roteren' }).click({ timeout: 10000 });
  const dlg = page.getByRole('dialog', { name: 'Geheim roteren' });
  const grace = dlg.getByRole('combobox', { name: 'Overgangstijd voor het oude geheim' });
  if ((await grace.inputValue()) !== '0') fail('b: standaard is niet "Direct ongeldig"');
  await shot(page, 'c2-6b-roteren-direct-desktop');
  await dlg.getByRole('button', { name: 'Nieuw geheim maken' }).click();
  const once = page.getByRole('dialog', { name: 'Nieuw geheim' });
  await once.waitFor({ timeout: 8000 });
  const second = await once.getByRole('textbox', { name: 'Geheim' }).inputValue();
  await page.keyboard.press('Escape');
  if ((await hook(trg.id, first)) !== 401) fail('b: oud geheim werkt nog direct na roteren');
  if ((await hook(trg.id, second)) !== 202) fail('b: nieuw geheim werkt niet');
  // Rotate again with a 15-minute overlap: the card says until when, "Nu intrekken" ends it.
  await page.getByRole('button', { name: 'Geheim roteren' }).click();
  await page.getByRole('dialog', { name: 'Geheim roteren' }).getByRole('combobox', { name: 'Overgangstijd voor het oude geheim' }).selectOption('15');
  await page.getByRole('dialog', { name: 'Geheim roteren' }).getByRole('button', { name: 'Nieuw geheim maken' }).click();
  await page.getByRole('dialog', { name: 'Nieuw geheim' }).waitFor({ timeout: 8000 });
  await page.keyboard.press('Escape');
  // "tot 14:20", or with the day in front when the 15 minutes run past midnight ("tot vr 13 nov 00:10").
  const banner = page.getByRole('status').filter({ hasText: /Oud geheim werkt nog tot .*\d{2}:\d{2}/ });
  await banner.waitFor({ timeout: 8000 }).catch(() => fail('b: kaart toont niet tot wanneer het oude geheim werkt'));
  if ((await hook(trg.id, second)) !== 202) fail('b: oud geheim werkt niet binnen de gekozen overgangstijd');
  await shot(page, 'c2-6b-oud-geheim-tot-desktop');
  await go(phone, `#/m/routines/r/${ra.id}?tab=triggers`);
  await phone.getByText(/Oud geheim werkt nog tot/).waitFor({ timeout: 8000 }).catch(() => fail('b: telefoon toont de overgangstijd niet'));
  await phone.getByText(/Oud geheim werkt nog tot/).evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => {});
  await shot(phone, 'c2-6b-oud-geheim-tot-telefoon');
  await noOverflow(phone, 'b');
  await banner.getByRole('button', { name: 'Nu intrekken' }).click();
  await page.getByText('Het oude geheim werkt niet meer').waitFor({ timeout: 5000 }).catch(() => fail('b: geen bevestiging na Nu intrekken'));
  if ((await hook(trg.id, second)) !== 401) fail('b: oud geheim werkt nog na Nu intrekken');
  if (!app.ctx.store.one("SELECT id FROM audit WHERE kind = 'routine.trigger.previous_secret_revoked'")) fail('b: intrekken niet in het logboek');
  step('b: roteren maakt het oude geheim direct ongeldig; met 15 min overgang "Oud geheim werkt nog tot …" en "Nu intrekken"');

  // ------------------------------------------------------------------ c: contradiction → review
  const th = await api('POST', '/threads', { agentId: bot.id });
  await api('POST', `/threads/${th.id}/messages`, { content: 'Onthoud dat mijn kat Mo heet' });
  await idle(th.id);
  await api('POST', `/threads/${th.id}/messages`, { content: 'Onthoud dat mijn kat Max heet' });
  await idle(th.id);
  const items = (await api('GET', '/memory/items?scope=about_you&status=all')).items;
  const max = items.find((i) => /Max/.test(i.content));
  const mo = items.find((i) => /Mo\b/.test(i.content));
  if (max?.status !== 'proposed' || mo?.status !== 'active') fail(`c: tegenspraak niet in de wachtrij (Max: ${max?.status}, Mo: ${mo?.status})`);
  await go(page, `#/t/${th.id}`);
  await page.getByText(/Botst met wat er al staat — eerst beoordelen/).first().waitFor({ timeout: 8000 }).catch(() => fail('c: onder het bericht staat niet dat het botst'));
  await shot(page, 'c2-6c-chat-botst-desktop');
  await go(page, '#/m/memory/beoordelen');
  const card = page.locator('div.rounded-2xl, div[class*="Card"], div').filter({ hasText: 'Oud — nu bewaard' }).filter({ has: page.getByRole('button', { name: 'Beide houden' }) }).last();
  await card.waitFor({ timeout: 8000 }).catch(() => fail('c: geen kaart met oud en nieuw in Te beoordelen'));
  for (const b of ['Nieuwe bewaren (oude vervangen)', 'Oude houden', 'Beide houden']) if (!(await page.getByRole('button', { name: b }).count())) fail(`c: knop "${b}" ontbreekt`);
  await shot(page, 'c2-6c-beoordelen-desktop');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(300);
  await shot(page, 'c2-6c-beoordelen-donker-desktop');
  await page.emulateMedia({ colorScheme: 'light' });
  await go(phone, '#/m/memory/beoordelen');
  await phone.getByRole('button', { name: 'Nieuwe bewaren (oude vervangen)' }).first().evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => fail('c: telefoon toont de kaart niet'));
  await shot(phone, 'c2-6c-beoordelen-telefoon');
  await noOverflow(phone, 'c');
  await page.getByRole('button', { name: 'Nieuwe bewaren (oude vervangen)' }).first().click();
  await sleep(600);
  const after = (await api('GET', '/memory/items?scope=about_you&status=all')).items;
  if (after.find((i) => i.id === max.id)?.status !== 'active' || after.find((i) => i.id === mo.id)?.status !== 'superseded') fail('c: "Nieuwe bewaren" vervangt het oude niet');
  await go(page, '#/m/memory/opslag?meer=1');
  const conflictSel = page.getByRole('combobox', { name: 'Bij tegenspraak' });
  await conflictSel.waitFor({ timeout: 8000 }).catch(() => fail('c: instelling "Bij tegenspraak" ontbreekt'));
  if ((await conflictSel.inputValue()) !== 'ask') fail('c: standaard is niet "Eerst aan mij vragen"');
  await conflictSel.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await shot(page, 'c2-6c-instelling-desktop');
  step('c: tegenspraak in Te beoordelen met oud/nieuw en drie keuzes; instelling "Bij tegenspraak" (standaard eerst vragen)');

  // ------------------------------------------------------------------ d: Markdown dossiers
  const mdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-c2-md-'));
  const f1 = path.join(mdDir, 'verbouwing-keuken.md');
  const f2 = path.join(mdDir, 'Klant_Bouwmaat.md');
  const f3 = path.join(mdDir, 'wifi.md');
  fs.writeFileSync(f1, '# Verbouwing keuken\n\nNieuwe keuken met kookeiland, aannemer Jansen, start in week 11.\n\n## Offerte\n- € 18.400\n');
  fs.writeFileSync(f2, 'Klant sinds 2021; bestelt elke maand kozijnen.\n\n- Contact: Petra\n');
  fs.writeFileSync(f3, '# Thuisnetwerk\n\nHet wachtwoord is Zomer2026!Huis\n');
  // Every note belongs to a dossier now (the owner, lessons, a bot's work notes …): what the earlier parts wrote is
  // already in dossiers. The import is judged by what it adds to those.
  const dossiersBefore = new Set((await api('GET', '/memory/dossiers')).map((d) => d.id));
  await go(page, '#/m/memory/dossiers');
  await page.getByRole('button', { name: 'Meer acties bij dossiers' }).click({ timeout: 10000 });
  await page.getByRole('menuitem', { name: 'Importeren uit Markdown' }).click({ timeout: 10000 });
  const imp = page.getByRole('dialog', { name: 'Importeren uit Markdown' });
  await imp.locator('input[type=file][aria-label="Markdown-bestanden kiezen"]').setInputFiles([f1, f2, f3]);
  const prevList = imp.getByRole('list', { name: 'Voorbeeld van de import' });
  await prevList.waitFor({ timeout: 8000 });
  await imp.getByText('Verbouwing keuken').waitFor({ timeout: 5000 });
  if (!(await prevList.getByText('Geweigerd').count())) fail('d: bestand met wachtwoord niet geweigerd in het voorbeeld');
  {
    const extra = (await api('GET', '/memory/dossiers')).filter((d) => !dossiersBefore.has(d.id));
    if (extra.length) fail(`d: voorbeeld maakte al dossiers (${extra.map((d) => d.title).join(', ')})`);
  }
  await shot(page, 'c2-6d-voorbeeld-desktop');
  await imp.getByRole('button', { name: 'Importeren (2)' }).click();
  await imp.getByRole('list', { name: 'Resultaat van de import' }).waitFor({ timeout: 8000 });
  await shot(page, 'c2-6d-resultaat-desktop');
  await imp.getByRole('button', { name: 'Klaar' }).click();
  const dossiers = (await api('GET', '/memory/dossiers')).filter((d) => !dossiersBefore.has(d.id));
  const titles = dossiers.map((d) => d.title).sort();
  if (JSON.stringify(titles) !== JSON.stringify(['Klant Bouwmaat', 'Verbouwing keuken'])) fail(`d: verkeerde dossiers: ${titles.join(', ')}`);
  const full = await api('GET', `/memory/dossiers/${dossiers.find((d) => d.title === 'Verbouwing keuken').id}`);
  if (!full.sources.some((s) => s.title === 'Geïmporteerd uit verbouwing-keuken.md')) fail('d: bron "Geïmporteerd uit …" ontbreekt');
  await go(phone, '#/m/memory/dossiers');
  await phone.getByRole('button', { name: 'Meer acties bij dossiers' }).click({ timeout: 10000 });
  await phone.getByRole('menuitem', { name: 'Importeren uit Markdown' }).click({ timeout: 10000 });
  await phone.getByRole('dialog', { name: 'Importeren uit Markdown' }).locator('input[type=file][aria-label="Markdown-bestanden kiezen"]').setInputFiles([f1, f2]);
  await phone.getByRole('list', { name: 'Voorbeeld van de import' }).getByText('Bestaat al').first().waitFor({ timeout: 8000 }).catch(() => fail('d: dubbel niet gemeld'));
  await shot(phone, 'c2-6d-dubbel-telefoon');
  await noOverflow(phone, 'd');
  await phone.keyboard.press('Escape');
  fs.rmSync(mdDir, { recursive: true, force: true });
  step('d: twee .md-bestanden → dossiers met bron; voorbeeld eerst; wachtwoord geweigerd; dubbel gemeld');

  // ------------------------------------------------------------------ e: review interval
  const fact = (await api('POST', '/memory/items', { content: 'Ik woon in Haarlem', scope: 'about_you', key: 'woonplaats' })).item;
  await go(page, `#/m/memory/item/${fact.id}`);
  const every = page.getByRole('combobox', { name: 'Hoe vaak nakijken' });
  await every.waitFor({ timeout: 8000 });
  await every.selectOption('90');
  await page.getByText(/nakijken op /).first().waitFor({ timeout: 5000 }).catch(() => fail('e: datum "nakijken op" niet zichtbaar'));
  const row = app.ctx.store.get('memory_items', fact.id);
  if (row.review_every_days !== 90 || Math.round((Date.parse(row.review_at) - Date.now()) / 864e5) !== 90) fail('e: interval elke 3 maanden niet bewaard');
  await shot(page, 'c2-6e-interval-desktop');
  // Due now (as if three months passed): "Klopt dit nog?" in Te beoordelen.
  app.ctx.store.update('memory_items', fact.id, { review_at: new Date(Date.now() - 60_000).toISOString() });
  await go(page, '#/m/memory/beoordelen');
  await page.getByRole('heading', { name: /Klopt dit nog\? \(1\)/ }).waitFor({ timeout: 8000 }).catch(() => fail('e: item komt niet terug als "Klopt dit nog?"'));
  for (const b of ['Klopt nog', 'Aanpassen', 'Vergeten']) if (!(await page.getByRole('button', { name: b, exact: true }).count())) fail(`e: knop "${b}" ontbreekt`);
  await page.getByRole('heading', { name: /Klopt dit nog\?/ }).scrollIntoViewIfNeeded();
  await shot(page, 'c2-6e-klopt-dit-nog-desktop');
  await go(phone, '#/m/memory/beoordelen');
  await phone.getByRole('heading', { name: /Klopt dit nog\?/ }).scrollIntoViewIfNeeded().catch(() => fail('e: telefoon toont "Klopt dit nog?" niet'));
  await shot(phone, 'c2-6e-klopt-dit-nog-telefoon');
  await noOverflow(phone, 'e');
  await page.getByRole('button', { name: 'Klopt nog', exact: true }).click();
  await sleep(600);
  const conf = app.ctx.store.get('memory_items', fact.id);
  if (Math.round((Date.parse(conf.review_at) - Date.now()) / 864e5) !== 90) fail('e: "Klopt nog" plant niet over 3 maanden opnieuw');
  await go(page, '#/m/memory/opslag?meer=1');
  const def = page.getByRole('combobox', { name: 'Standaard nakijken' });
  await def.waitFor({ timeout: 8000 }).catch(() => fail('e: standaard-interval ontbreekt in Opslag'));
  await def.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await shot(page, 'c2-6e-standaard-desktop');
  step('e: "Elke 3 maanden" per item met datum; due → "Klopt dit nog?" met Klopt nog / Aanpassen / Vergeten; standaard in Opslag');

  // ------------------------------------------------------------------ f: a quiet run leaves no token in the sidebar
  // Acceptance round 3: after a quiet routine run the sidebar preview of the bot read "ROUTINE_NO_UPDATE" (the
  // streamed text stayed there when the run's messages were hidden).
  const quiet = await mk('Stille controle', { prompt: 'NIETS-NIEUWS-TEST: kijk of er iets nieuws is.' });
  await go(page, '#/');
  await api('POST', `/routines/${quiet.id}/run`);
  for (let i = 0; i < 40; i++) {
    const runs = await api('GET', `/routines/${quiet.id}/runs`);
    const list = Array.isArray(runs) ? runs : runs.runs || runs.items || [];
    if (list.some((x) => x.status === 'no_update')) break;
    if (i === 39) fail('f: stille run niet als "niets nieuws" afgerond');
    await sleep(250);
  }
  await sleep(1500);
  const side = await page.locator('nav').first().innerText();
  if (/ROUTINE_NO_UPDATE/.test(side)) fail('f: de zijbalk toont "ROUTINE_NO_UPDATE" na een stille run');
  await shot(page, 'c2-6f-stille-run-zijbalk');
  step('f: een stille routinerun laat geen ROUTINE_NO_UPDATE achter in de zijbalk');
} catch (e) {
  fail(e.stack || e.message);
} finally {
  await browser.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
if (errors.length) fail('console-fouten:\n  ' + errors.join('\n  '));
console.log(process.exitCode ? 'E2E MISLUKT' : 'E2E GESLAAGD');
