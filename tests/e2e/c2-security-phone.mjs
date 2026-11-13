// End-to-end: the security log in plain words (A-84) and the phone (A-85, A-86, A-91).
// Real UI + real server (desktop mode, temp data) + a fake OpenAI-compatible model, driven with Playwright (Edge):
//  - Instellingen › Meer mogelijkheden › Beveiliging › Logboek, walked as a person does it: sentences (wie, wat, wanneer, goedgekeurd door), no raw kinds/JSON/ids,
//    category filter, search, bot filter, phone width (390/320 px) and dark theme;
//  - phone: "Alles stoppen" always in reach (also when nothing runs), "Privacy en gegevens" from the settings,
//    app lock with PIN and with device biometrics (CDP virtual authenticator), wrong PIN + back-off, unlocking never
//    approves anything, turning the lock off asks to unlock first.
// Usage: npx vite build && node --import tsx tests/e2e/c2-security-phone.mjs
//        (TEAMBOT_UI_DIR = another build; TEAMBOT_E2E_SHOTS = folder for screenshots; TEAMBOT_E2E_BROWSER=chrome|msedge)
import http from 'node:http';
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
const SHOTS = process.env.TEAMBOT_E2E_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, name) });

// ---- fake model: a user turn asks to write a file (named in the message), a tool result gets a short answer;
//      a message with LANG keeps the turn busy until it is stopped.
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', async () => {
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'nep-model' }] }));
    const j = JSON.parse(body || '{}');
    const msgs = j.messages || [];
    const last = msgs[msgs.length - 1] || {};
    const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content || '');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (last.role === 'user' && text.includes('LANG')) {
      send({ id: 'l', choices: [{ index: 0, delta: { role: 'assistant', content: 'Ik ben bezig' } }] });
      await new Promise((r) => {
        const t = setTimeout(r, 25_000);
        res.on('close', () => (clearTimeout(t), r()));
      });
      return res.end();
    }
    if (last.role === 'user') {
      const file = (text.match(/(\w+\.txt)/) || [, 'e2e.txt'])[1];
      send({ id: 'c1', choices: [{ index: 0, delta: { role: 'assistant', content: 'Ik schrijf het bestand. ' } }] });
      send({ id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: file, content: 'hallo' }) } }] } }] });
      send({ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    } else {
      send({ id: 'c2', choices: [{ index: 0, delta: { content: 'Klaar.' } }] });
      send({ id: 'c2', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 2 } });
    }
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const fakeUrl = `http://127.0.0.1:${fake.address().port}/v1`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-c2-sec-'));
const app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();
const api = async (method, p, body) => {
  const r = await fetch(`${app.url}/api${p}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${j.error || ''}`);
  return j;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 15000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(50);
  }
  throw new Error(`time-out: ${what}`);
};
const pending = () => app.ctx.store.all("SELECT * FROM approvals WHERE status = 'pending' AND user_id = ?", owner.id);
const idle = (threadId) => until(() => !app.ctx.store.all("SELECT id FROM runs WHERE thread_id = ? AND status IN ('queued','running','waiting')", threadId).length, 'run klaar');
step(`TeamBot op ${app.url} (data: ${dir}), nep-model op ${fakeUrl}`);

// ---- realistic log: provider, bots, an approved and a refused write, a secret, an edit, a deleted bot
const prov = await api('POST', '/providers', { kind: 'openai-compatible', name: 'Nepmodel', base_url: fakeUrl, config: { defaultModel: 'nep-model' } });
const bot = await api('POST', '/agents', { name: 'Codeerhulp', provider_id: prov.id, model: 'nep-model', access_mode: 'ask', tool_groups: ['files'] });
const th = await api('POST', '/threads', { agentId: bot.id });
await api('POST', `/threads/${th.id}/messages`, { content: 'Schrijf goed.txt' });
const a1 = await until(() => pending()[0], 'goedkeuring 1');
await api('POST', `/approvals/${a1.id}`, { decision: 'approve' });
await idle(th.id);
await api('POST', `/threads/${th.id}/messages`, { content: 'Schrijf fout.txt' });
const a2 = await until(() => pending()[0], 'goedkeuring 2');
await api('POST', `/approvals/${a2.id}`, { decision: 'deny' });
await idle(th.id);
await api('PUT', '/secrets/e2e_sleutel', { value: 'zeer-geheim-e2e' });
await api('PATCH', `/agents/${bot.id}`, { instructions: 'Wees kort en vriendelijk.' });
const weg = await api('POST', '/agents', { name: 'Tijdelijk', provider_id: prov.id, model: 'nep-model' });
await api('DELETE', `/agents/${weg.id}`);
step('logboek gevuld via echte acties (goedgekeurd, geweigerd, geheim, wijziging, verwijderde bot)');

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const errors = [];
const watch = (page) => {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED|NotAllowedError/.test(m.text()) && errors.push(m.text()));
};
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
/**
 * The way a person goes to the log: Instellingen (in the sidebar; on a phone via the tab Meer), the row Meer
 * mogelijkheden, Beveiliging, and there the fold Logboek at the bottom.
 */
async function walkToLog(p, phone) {
  if (phone) {
    await p.getByRole('navigation', { name: 'Hoofdmenu' }).getByRole('link', { name: /^(\d+ )?Meer$/ }).tap();
    await p.getByRole('main').getByRole('navigation', { name: 'Meer' }).getByRole('link', { name: 'Instellingen', exact: true }).tap();
  } else await p.locator('aside a[href="#/settings"]').first().click();
  const go = (loc) => (phone ? loc.tap() : loc.click());
  await go(p.getByRole('navigation', { name: 'Instellingen' }).getByRole('link', { name: /^Meer mogelijkheden/ }).first());
  await go(p.getByRole('main').getByRole('link', { name: /^Beveiliging/ }).first());
  await p.waitForURL(/#\/settings\/security$/, { timeout: 8000 }).catch(() => fail(`${phone ? 'telefoon' : 'computer'}: Meer mogelijkheden › Beveiliging opent de beveiliging niet`));
  const fold = p.getByRole('main').locator('summary', { hasText: 'Logboek' });
  await fold.scrollIntoViewIfNeeded();
  await go(fold);
}
try {
  // ================= item 1: the log (desktop) =================
  const desk = await browser.newContext({ viewport: { width: 1360, height: 880 } });
  const page = await desk.newPage();
  watch(page);
  await page.goto(`${app.url}/#token=${token}`);
  await page.waitForTimeout(800);
  // The log is one fold ("Logboek") at the bottom of Beveiliging (Meer mogelijkheden).
  await walkToLog(page, false);
  const log =page.getByRole('list', { name: 'Gebeurtenissen' });
  await log.waitFor({ timeout: 15000 });
  const text = await log.innerText();
  for (const raw of ['tool.call', 'agent.created', 'approval.approved', 'cli.permission', 'file.write', '{"', 'null', 'undefined', 'apr_', 'ag_', 'write_file'])
    if (text.includes(raw)) fail(`logboek toont technische tekst "${raw}"`);
  const want = [
    'Jij hebt de bot “Codeerhulp” gemaakt.',
    'Codeerhulp schreef een bestand: goed.txt (5 tekens).',
    'Jij hebt Codeerhulp toestemming gegeven: goed.txt (5 tekens).',
    'Codeerhulp wilde een bestand schrijven: fout.txt (5 tekens).',
    'Jij hebt een verzoek van Codeerhulp geweigerd: fout.txt (5 tekens).',
    'Jij hebt het geheim “e2e_sleutel” opgeslagen',
    'Jij hebt Codeerhulp aangepast: instructies.',
    'Jij hebt de bot “Tijdelijk” verwijderd',
    'Jij hebt de AI-provider “Nepmodel” gekoppeld.',
  ];
  for (const w of want) if (!text.includes(w)) fail(`logboek mist de zin: ${w}`);
  for (const b of ['Goedgekeurd door jou', 'Geweigerd door jou']) if (!text.includes(b)) fail(`logboek mist "${b}"`);
  if (text.includes('zeer-geheim-e2e')) fail('de waarde van een geheim staat in het logboek');
  const timeTitle = await log.locator('time').first().getAttribute('title');
  if (!timeTitle || !/\d{4}/.test(timeTitle)) fail('tijdstip zonder volledige datum bij aanwijzen');
  if (text.includes('Codeerhulp heeft een bestand geschreven: goed.txt.')) fail('logboek: dezelfde schrijfactie staat er twee keer in');
  step('logboek: één zin per gebeurtenis met wie, wat, wanneer en wie het goedkeurde; geen ruwe soort, JSON of ids; één regel per actie');
  await page.getByRole('heading', { name: 'Logboek', exact: true }).scrollIntoViewIfNeeded();
  await page.evaluate(() => document.getElementById('tb-audit-title')?.scrollIntoView({ block: 'start' }));
  await shot(page, 'c2-1-logboek-overzicht.png');

  // Category filter
  await page.getByRole('group', { name: 'Soort gebeurtenis' }).getByRole('button', { name: /^Goedkeuringen/ }).click();
  await page.waitForTimeout(200);
  const approvalsOnly = await log.innerText();
  if (!approvalsOnly.includes('Geweigerd door jou') || approvalsOnly.includes('“Codeerhulp” gemaakt')) fail('filter Goedkeuringen toont niet alleen goedkeuringen');
  await log.scrollIntoViewIfNeeded();
  await shot(page, 'c2-1-logboek-filter.png');
  await page.getByRole('group', { name: 'Soort gebeurtenis' }).getByRole('button', { name: /^Alles/ }).click();
  // Search over the sentences
  await page.getByLabel('Zoeken in het logboek').fill('geheim');
  await page.waitForTimeout(500);
  const found = await log.locator('li').filter({ hasText: /\S/ }).allInnerTexts();
  if (!found.length || found.some((t) => !/geheim/i.test(t))) fail(`zoeken op "geheim" geeft andere regels: ${found.join(' | ')}`);
  await shot(page, 'c2-1-logboek-zoeken.png');
  await page.getByLabel('Zoeken in het logboek').fill('');
  // Bot filter (server side)
  await page.getByLabel('Filter op bot').selectOption({ label: 'Codeerhulp' });
  await page.waitForTimeout(600);
  const botRows = await log.innerText();
  if (botRows.includes('Nepmodel') || !botRows.includes('Codeerhulp')) fail('botfilter toont regels van andere bots of instellingen');
  await page.getByLabel('Filter op bot').selectOption({ value: '' });
  step('logboek: filter per soort, zoeken in de zinnen en filter per bot');
  // "Privacy en gegevens" from the security settings
  if (!(await page.getByRole('link', { name: /^Privacy en gegevens$/ }).count())) fail('beveiliging: link "Privacy en gegevens" ontbreekt');
  // Dark theme
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => localStorage.setItem('tb_theme', 'dark'));
  await page.reload();
  // (A reload shows the page as it opens: the fold is closed again.)
  await page.getByRole('main').locator('summary', { hasText: 'Logboek' }).click();
  await log.waitFor({ timeout: 10000 });
  await page.evaluate(() => document.getElementById('tb-audit-title')?.scrollIntoView({ block: 'start' }));
  await shot(page, 'c2-1-logboek-donker.png');
  await page.evaluate(() => localStorage.removeItem('tb_theme'));
  await page.emulateMedia({ colorScheme: 'light' });
  await desk.close();

  // ================= phone =================
  // The phone opens TeamBot by a name (localhost here, the Tailscale name in real life): WebAuthn refuses IP addresses.
  const base = app.url.replace('127.0.0.1', 'localhost');
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const p = await phone.newPage();
  watch(p);
  await p.goto(`${base}/#token=${token}`);
  await p.waitForTimeout(800);
  // Log on the phone: Meer › Instellingen › Meer mogelijkheden › Beveiliging › Logboek
  await walkToLog(p, true);
  await p.getByRole('list', { name: 'Gebeurtenissen' }).waitFor({ timeout: 10000 });
  if ((await overflow(p)) > 1) fail('logboek: horizontale overflow op 390 px');
  await p.getByRole('list', { name: 'Gebeurtenissen' }).scrollIntoViewIfNeeded();
  await shot(p, 'c2-1-logboek-telefoon.png');
  await p.setViewportSize({ width: 320, height: 640 });
  await p.waitForTimeout(300);
  if ((await overflow(p)) > 1) fail('logboek: horizontale overflow op 320 px');
  await p.setViewportSize({ width: 390, height: 844 });
  step('logboek op de telefoon (390 en 320 px) zonder horizontaal scrollen');

  // "Privacy en gegevens" from the settings list on the phone: under the row Meer mogelijkheden (two taps)
  await p.goto(`${base}/#/settings`);
  await p.getByRole('main').getByRole('link', { name: /^Meer mogelijkheden/ }).click();
  const dataLink = p.getByRole('link', { name: /^Privacy en gegevens/ }).first();
  await dataLink.waitFor({ timeout: 8000 }).catch(() => fail('instellingen (telefoon): "Privacy en gegevens" ontbreekt'));
  await shot(p, 'c2-4-data-link-instellingen.png');
  await dataLink.click();
  await p.getByRole('heading', { name: 'Privacy en gegevens' }).first().waitFor({ timeout: 8000 }).catch(() => fail('"Privacy en gegevens" opent de uitleg niet'));
  await p.getByText(dir.replace(/\\/g, '\\'), { exact: false }).first().waitFor({ timeout: 8000 }).catch(() => fail('de datamap staat niet in de uitleg'));
  await p.evaluate(() => document.getElementById('waar-staat-mijn-data')?.scrollIntoView({ block: 'start' }));
  await shot(p, 'c2-4-data-uitleg.png');
  step('telefoon: "Privacy en gegevens" vanuit Instellingen, met de datamap');

  // "Alles stoppen" always in reach — nothing running
  await p.goto(`${base}/#/more`);
  const idleStop = p.getByRole('button', { name: /Alles stoppen.*er loopt niets/ });
  await idleStop.waitFor({ timeout: 8000 }).catch(() => fail('Meer: "Alles stoppen" verdwijnt als er niets loopt'));
  await shot(p, 'c2-4-alles-stoppen-niets.png');
  await idleStop.click();
  await p.getByText('Er liep niets; alles staat al stil').waitFor({ timeout: 5000 }).catch(() => fail('Alles stoppen zonder taken: geen duidelijke melding'));
  // … and while a bot works
  const runner = await api('POST', '/agents', { name: 'Doorwerker', provider_id: prov.id, model: 'nep-model', access_mode: 'auto', tool_groups: [] });
  const th2 = await api('POST', '/threads', { agentId: runner.id });
  await api('POST', `/threads/${th2.id}/messages`, { content: 'Doe iets LANG' });
  await until(() => app.ctx.store.one("SELECT id FROM runs WHERE thread_id = ? AND status = 'running'", th2.id), 'lange run');
  await p.goto(`${base}/#/`);
  // "1 taak" / "2 taken" (the label no longer says "taak/taken")
  const compact = p.getByRole('button', { name: /^Alles stoppen \(\d+ (taak|taken) bezig\)/ });
  await compact.waitFor({ timeout: 8000 }).catch(async () => fail(`Chats: geen stopknop in de kop terwijl een bot werkt (runs: ${JSON.stringify(app.ctx.store.all('SELECT status, error FROM runs WHERE thread_id = ?', th2.id))}, ui: ${await p.evaluate(() => document.title)})`));
  await shot(p, 'c2-4-alles-stoppen-chats-bezig.png');
  await p.goto(`${base}/#/more`);
  const busyStop = p.getByRole('button', { name: /^Alles stoppen \(\d+\)$/ });
  await busyStop.waitFor({ timeout: 8000 }).catch(async (e) => {
    throw new Error(`Meer: geen "Alles stoppen (n)" tijdens werk; knoppen: ${(await p.getByRole('button').allInnerTexts()).join(' | ')}`);
  });
  await shot(p, 'c2-4-alles-stoppen-bezig.png');
  await busyStop.click();
  await until(() => !app.ctx.store.one("SELECT id FROM runs WHERE thread_id = ? AND status IN ('queued','running','waiting')", th2.id), 'run gestopt', 5000).catch(() => fail('Alles stoppen stopte de lopende taak niet'));
  await p.getByRole('button', { name: /Alles stoppen.*er loopt niets/ }).waitFor({ timeout: 8000 }).catch(() => fail('na stoppen: knop toont niet dat er niets meer loopt'));
  step('telefoon: "Alles stoppen" altijd in Meer (ook zonder taken), in de kop van Chats zodra er iets loopt; stopt direct');

  // One question stays open: unlocking the app must never approve it.
  await api('POST', `/threads/${th.id}/messages`, { content: 'Schrijf open.txt' });
  const openNow = await until(() => pending()[0], 'open goedkeuring');


  // ---- app lock: PIN + device biometrics (virtual platform authenticator)
  const cdp = await phone.newCDPSession(p);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: false, hasUserVerification: true, isUserVerified: true } });
  // The lock has its own row in the settings list: Vergrendeling.
  await p.goto(`${base}/#/settings`);
  await p.getByRole('main').getByRole('link', { name: /^Vergrendeling/ }).click();
  await p.waitForURL(/#\/settings\/slot/, { timeout: 8000 }).catch(() => fail('instellingen (telefoon): de rij Vergrendeling opent de vergrendeling niet'));
  await p.waitForTimeout(4500); // let earlier toasts go before the screenshot
  await p.getByRole('button', { name: 'Vergrendeling instellen' }).click();
  const dlg = p.getByRole('dialog', { name: 'App-vergrendeling instellen' });
  await dlg.getByLabel('Pincode').fill('482915');
  await dlg.getByLabel('Nog een keer').fill('482915');
  const bioToggle = dlg.getByRole('switch', { name: 'Ook ontgrendelen met vingerafdruk of gezicht' });
  await bioToggle.waitFor({ timeout: 5000 });
  await until(async () => !(await bioToggle.isDisabled()), 'biometrie beschikbaar', 5000).catch(() => fail('biometrie niet aangeboden terwijl het apparaat het kan'));
  await bioToggle.click();
  await until(async () => (await bioToggle.getAttribute('aria-checked')) === 'true', 'schakelaar aan', 3000).catch(() => fail('schakelaar voor vingerafdruk of gezicht gaat niet aan'));
  await p.waitForTimeout(400); // the switch animates
  await shot(p, 'c2-4-vergrendeling-instellen.png');
  await dlg.getByRole('button', { name: 'Aanzetten' }).click();
  await p.getByText(/Aan · pincode \(6 cijfers\) en vingerafdruk of gezicht/).waitFor({ timeout: 8000 }).catch(async () => fail(`vergrendeling: niet aangezet met pincode en biometrie (${(await dlg.count()) ? (await dlg.innerText()).slice(-400) : "dialoog dicht"})`));
  const stored = await p.evaluate(() => localStorage.getItem('tb_applock') || '');
  if (!stored || stored.includes('482915')) fail('vergrendeling: de pincode zelf staat in de opslag van het apparaat');
  if (stored.includes(token)) fail('vergrendeling: een kopie van het token staat in de lock-opslag');
  await shot(p, 'c2-4-vergrendeling-aan.png');
  step('app-vergrendeling ingesteld: pincode (alleen als hash) en vingerafdruk/gezicht (virtuele authenticator)');

  // Start = locked; nothing of the app is visible behind the lock
  await p.reload();
  const lock = p.getByTestId('app-lock');
  await lock.waitFor({ timeout: 8000 }).catch(() => fail('na herstart is de app niet vergrendeld'));
  if (await p.getByRole('navigation', { name: 'Hoofdmenu' }).count()) fail('vergrendeld: de app is achter het slot nog zichtbaar');
  if (!(await lock.getByRole('button', { name: 'Ontgrendelen met vingerafdruk of gezicht' }).count())) fail('vergrendeld: knop voor vingerafdruk of gezicht ontbreekt');
  const keyH = await lock.getByRole('button', { name: '5', exact: true }).evaluate((el) => el.getBoundingClientRect().height);
  if (keyH < 44) fail(`vergrendeld: cijfertoetsen ${keyH}px (< 44)`);
  await shot(p, 'c2-4-vergrendeld-pin.png');
  // Wrong PIN
  for (const d of '111111') await lock.getByRole('button', { name: d, exact: true }).click();
  await lock.getByText(/Onjuiste pincode\. Nog 4 pogingen/).waitFor({ timeout: 5000 }).catch(() => fail('onjuiste pincode: geen duidelijke melding'));
  await shot(p, 'c2-4-onjuiste-pin.png');
  // Right PIN
  for (const d of '482915') await lock.getByRole('button', { name: d, exact: true }).click();
  await lock.waitFor({ state: 'detached', timeout: 8000 }).catch(() => fail('juiste pincode ontgrendelt niet'));
  if (app.ctx.store.get('approvals', openNow.id)?.status !== 'pending') fail('ontgrendelen heeft een open goedkeuring afgehandeld');
  step('vergrendeld bij openen; onjuiste pincode gemeld; juiste pincode ontgrendelt; open goedkeuring blijft open');

  // Deep link (as from a notification) while locked, then unlock with biometrics
  await p.goto(`${base}/#/inbox`);
  await p.reload();
  await lock.waitFor({ timeout: 8000 });
  if (await p.getByText('Wacht op jou', { exact: true }).count()) fail('vergrendeld: diepe link toont de inhoud achter het slot');
  await shot(p, 'c2-4-vergrendeld-biometrie.png');
  await lock.getByRole('button', { name: 'Ontgrendelen met vingerafdruk of gezicht' }).click();
  await lock.waitFor({ state: 'detached', timeout: 8000 }).catch(() => fail('vingerafdruk/gezicht ontgrendelt niet'));
  await p.getByRole('heading', { name: 'Wacht op jou' }).waitFor({ timeout: 8000 }).catch(() => fail('na ontgrendelen: niet op de pagina van de link'));
  if (app.ctx.store.get('approvals', openNow.id)?.status !== 'pending') fail('ontgrendelen met biometrie heeft iets goedgekeurd');
  step('diepe link achter het slot; ontgrendelen met vingerafdruk/gezicht; niets goedgekeurd');

  // Back-off after 5 wrong tries
  await p.reload();
  await lock.waitFor({ timeout: 8000 });
  for (let i = 0; i < 5; i++) for (const d of '000000') await lock.getByRole('button', { name: d, exact: true }).click();
  await lock.getByText(/Probeer het over \d+ seconden opnieuw/).waitFor({ timeout: 5000 }).catch(() => fail('na 5 foute pogingen geen wachttijd'));
  if (!(await lock.getByRole('button', { name: '1', exact: true }).isDisabled())) fail('tijdens de wachttijd zijn de cijfertoetsen niet uitgeschakeld');
  await shot(p, 'c2-4-te-vaak.png');
  await p.reload();
  await lock.waitFor({ timeout: 8000 });
  if (!(await lock.getByText(/Probeer het over \d+ seconden opnieuw/).count())) fail('herladen omzeilt de wachttijd');
  // "PIN vergeten?" explains logging out and re-pairing (not executed here)
  await lock.getByRole('button', { name: /Pincode vergeten\? Log uit op dit apparaat/ }).click();
  await lock.getByText(/koppel je daarna opnieuw met de QR-code/).waitFor({ timeout: 5000 }).catch(() => fail('"Pincode vergeten?" legt niet uit wat er gebeurt'));
  await shot(p, 'c2-4-pin-vergeten.png');
  await lock.getByRole('button', { name: 'Terug' }).click();
  step('na 5 foute pogingen een korte wachttijd die herladen niet omzeilt; "Pincode vergeten?" legt uitloggen en opnieuw koppelen uit');
  await lock.getByRole('button', { name: 'Ontgrendelen met vingerafdruk of gezicht' }).click();
  await lock.waitFor({ state: 'detached', timeout: 8000 });

  // Turning it off asks to unlock first
  await p.goto(`${base}/#/settings/slot`);
  await p.getByRole('button', { name: 'Vergrendeling uitzetten' }).click();
  const confirm = p.getByTestId('app-lock');
  await confirm.getByRole('heading', { name: 'Bevestig om de vergrendeling uit te zetten' }).waitFor({ timeout: 5000 }).catch(() => fail('uitzetten vraagt niet eerst om te ontgrendelen'));
  await shot(p, 'c2-4-uitzetten-bevestigen.png');
  await confirm.getByRole('button', { name: 'Annuleren' }).click();
  if (!(await p.getByText(/Aan · pincode/).count())) fail('annuleren zette de vergrendeling toch uit');
  await p.getByRole('button', { name: 'Vergrendeling uitzetten' }).click();
  await p.evaluate(() => localStorage.removeItem('tb_applock_fails'));
  await p.getByTestId('app-lock').getByRole('button', { name: 'Ontgrendelen met vingerafdruk of gezicht' }).click();
  await p.getByRole('button', { name: 'Vergrendeling instellen' }).waitFor({ timeout: 8000 }).catch(() => fail('vergrendeling niet uitgezet na bevestigen'));
  if (await p.evaluate(() => localStorage.getItem('tb_applock'))) fail('na uitzetten staat de vergrendeling nog in de opslag');
  step('uitzetten vraagt eerst om te ontgrendelen (annuleren laat hem aan)');
  await phone.close();
} catch (e) {
  fail(e.stack || e.message);
} finally {
  await browser.close();
  await app.close();
  fake.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
if (errors.length) fail('console-fouten:\n  ' + errors.join('\n  '));
console.log(process.exitCode ? 'E2E MISLUKT' : 'E2E GESLAAGD');
