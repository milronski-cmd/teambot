// End-to-end: chat gaps from acceptance round 2 (A-09/A-10/A-13/A-20/A-24/A-27/A-28/A-34).
// Hervatten after a manual stop, the busy choice above the composer, export as Markdown and JSON from the chat menu,
// earlier versions of an edited message, bot history with a word diff, bot actions in the chat menu (duplicate,
// archive, delete with counts), own bot order (drag + arrows), honest notices for zip/mp4 and link previews only on
// click (also for your own messages). Desktop 1360×880 and phone 390×844; no console errors.
// Usage: npm run build:ui && node --import tsx tests/e2e/c2-chat.mjs   (TEAMBOT_E2E_SHOTS=<dir> for screenshots)
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
const shots = process.env.TEAMBOT_E2E_SHOTS || '';
if (shots) fs.mkdirSync(shots, { recursive: true });
const shot = async (page, name) => shots && (await page.screenshot({ path: path.join(shots, `${name}.png`) }));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-c2-chat-'));
const app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();

// In-process fake engine: each answer can take a while (abortable), so stop/busy states are visible.
const script = [];
const wait = (ms, signal) =>
  new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), rej(signal.reason || new Error('aborted'))), { once: true });
  });
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
    async chat(req, signal, onEvent) {
      const s = script.shift() || { text: 'Oké.' };
      if (s.delayMs) {
        onEvent({ type: 'text', delta: 'Ik begin… ' });
        await wait(s.delayMs, signal);
      }
      onEvent({ type: 'text', delta: s.text });
      return { text: (s.delayMs ? 'Ik begin… ' : '') + s.text, toolCalls: [], usage: { input: 10, output: 5 }, stop: 'end', model: req.model };
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
const mila = await mk('Mila', { role: 'Schrijfhulp', instructions: 'Schrijf kort en vriendelijk.\nGebruik eenvoudige woorden.' });
const bas = await mk('Bas', { role: 'Onderzoeker' });
const cor = await mk('Cor', { role: 'Planner' });
const idle = async (threadId, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (!app.ctx.store.all("SELECT id FROM runs WHERE thread_id = ? AND status IN ('queued','running','waiting')", threadId).length) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('bot werd niet klaar');
};

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const errors = [];
try {
  const ctxb = await browser.newContext({ viewport: { width: 1360, height: 880 }, acceptDownloads: true });
  const page = await ctxb.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED|404 \(Not Found\)/.test(m.text()) && errors.push(m.text()));
  const previewCalls = [];
  page.on('request', (r) => r.url().includes('/api/link-preview') && previewCalls.push(r.url()));
  await page.goto(`${app.url}/#token=${token}`);
  await page.goto(`${app.url}/#/a/${mila.id}`);
  await page.waitForURL(/#\/t\//, { timeout: 15000 });
  const threadId = page.url().split('#/t/')[1];
  const composer = page.getByLabel('Bericht');

  // ---- busy choice + stop + Hervatten (A-20) ----
  script.push({ text: 'klaar met de lange taak', delayMs: 8000 }, { text: 'Ik ga verder waar ik was.' });
  await composer.fill('Schrijf een lang verhaal');
  await page.keyboard.press('Enter');
  // No choice up front: a message sent while the bot works waits in the queue, with an arrow to send it now.
  await page.getByRole('button', { name: 'Stoppen', exact: true }).waitFor({ timeout: 10000 }).catch(() => fail('bezig: bot werkt niet'));
  await composer.fill('En daarna dit');
  await page.keyboard.press('Enter');
  const qbar = page.getByRole('region', { name: 'Wachtrij' });
  await qbar.waitFor({ timeout: 10000 }).catch(() => fail('bezig: bericht staat niet in de wachtrij'));
  if (await page.getByRole('radiogroup', { name: /Nieuw bericht terwijl/ }).count()) fail('bezig: de keuzebalk wachtrij/bijsturen/onderbreken staat er nog');
  if ((await qbar.getByRole('button', { name: 'Nu sturen' }).count()) !== 1) fail('bezig: geen pijl "Nu sturen" bij het wachtende bericht');
  await shot(page, 'c2-5b-bezig-wachtrij');
  await qbar.getByRole('button', { name: 'Meer' }).click();
  if (!(await qbar.getByRole('button', { name: 'Onderbreken' }).count())) fail('bezig: "Onderbreken" niet bereikbaar onder Meer');
  await qbar.getByRole('button', { name: 'Uit de wachtrij halen' }).click();
  await qbar.waitFor({ state: 'detached', timeout: 5000 }).catch(() => fail('bezig: wachtrij niet leeg na verwijderen'));
  step('bezig: bericht gaat vanzelf in de wachtrij, met pijl "Nu sturen"; Onderbreken onder Meer');
  await page.getByRole('button', { name: 'Stoppen', exact: true }).click();
  const resumeBar = page.getByRole('status').filter({ hasText: 'Je hebt Mila gestopt.' });
  await resumeBar.waitFor({ timeout: 8000 }).catch(() => fail('stoppen: geen "Hervatten" na handmatig stoppen'));
  await shot(page, 'c2-5a-gestopt-hervatten');
  await resumeBar.getByRole('button', { name: 'Hervatten' }).click();
  await page.locator('[id^="m-"]').getByText('Ik ga verder waar ik was.').waitFor({ timeout: 10000 }).catch(() => fail('hervatten: bot ging niet verder'));
  await idle(threadId);
  const lastRun = app.ctx.store.one('SELECT trigger FROM runs WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', threadId);
  if (lastRun?.trigger !== 'resume') fail('hervatten: laatste beurt is geen hervatting');
  if (await resumeBar.count()) fail('hervatten: balk blijft staan na hervatten');
  step('stoppen → "Je hebt Mila gestopt. Hervatten" → bot gaat verder (nieuwe beurt, geen dubbele)');

  // ---- edited message versions (A-34) ----
  // By id: while editing, the text sits in a textarea (not in the text content the filter looks at).
  const mineId = await page.locator('[id^="m-"]').filter({ hasText: 'Schrijf een lang verhaal' }).first().getAttribute('id');
  const mine = page.locator(`[id="${mineId}"]`);
  await mine.hover();
  await mine.getByRole('button', { name: 'Meer' }).click();
  await page.getByRole('button', { name: 'Bewerken' }).click();
  await mine.locator('textarea').fill('Schrijf een kort verhaal over de herfst');
  await mine.getByRole('button', { name: 'Opslaan', exact: true }).click();
  await page.waitForTimeout(400);
  await mine.hover();
  await mine.getByRole('button', { name: 'Meer' }).click();
  await page.getByRole('button', { name: 'Bewerken' }).click();
  await mine.locator('textarea').fill('Schrijf een kort verhaal over de lente');
  await mine.getByRole('button', { name: 'Opslaan', exact: true }).click();
  await mine.getByRole('button', { name: /bewerkt/ }).click({ timeout: 5000 });
  const vdlg = page.getByRole('dialog', { name: 'Eerdere versies van dit bericht' });
  await vdlg.waitFor({ timeout: 5000 });
  for (const t of ['Nu', 'Origineel']) if (!(await vdlg.getByText(t, { exact: true }).count())) fail(`versies: "${t}" ontbreekt`);
  if (!(await vdlg.locator('del').filter({ hasText: 'herfst' }).count()) || !(await vdlg.locator('ins').filter({ hasText: 'lente' }).count())) fail('versies: verschil herfst → lente niet gemarkeerd');
  await shot(page, 'c2-5d-berichtversies');
  await page.keyboard.press('Escape');
  step('bewerkt bericht: "bewerkt" opent alle eerdere versies met gemarkeerd verschil');

  // ---- chat menu: export MD + JSON, bot actions (A-28, A-09) ----
  // The first list is short (about seven rows, two headings); the rest is one step further, in a submenu.
  await page.getByRole('button', { name: 'Meer opties' }).click();
  await shot(page, 'c2-5f-chatmenu');
  const menuRows = await page.getByRole('button', { name: 'Meer opties' }).locator('xpath=following-sibling::div').locator('a[href], button').count();
  if (menuRows > 9) fail(`menu: de eerste lijst is te lang (${menuRows} regels)`);
  await page.getByRole('button', { name: 'Bot beheren', exact: true }).click();
  for (const n of ['Bot vastzetten (bovenaan)', 'Bot dupliceren', 'Bot archiveren', 'Bot verwijderen…']) if (!(await page.getByRole('button', { name: n }).count())) fail(`menu: "${n}" ontbreekt`);
  await shot(page, 'c2-5f-chatmenu-bot');
  await page.getByRole('button', { name: /Terug.*Bot beheren/ }).click();
  await page.getByRole('button', { name: 'Exporteren', exact: true }).click();
  for (const n of ['Exporteren als Markdown', 'Exporteren als JSON']) if (!(await page.getByRole('link', { name: n }).count())) fail(`menu: "${n}" ontbreekt`);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.getByRole('link', { name: 'Exporteren als JSON' }).click()]);
  const jpath = path.join(dir, 'export.json');
  await dl.saveAs(jpath);
  const j = JSON.parse(fs.readFileSync(jpath, 'utf8'));
  if (j.format !== 'teambot.thread/v1' || !j.messages.some((m) => m.content.includes('lente') && m.parts.versions?.length === 2)) fail('export JSON: onvolledig (versies ontbreken)');
  if (JSON.stringify(j).includes(token)) fail('export JSON: bevat het sessietoken');
  await page.getByRole('button', { name: 'Meer opties' }).click();
  await page.getByRole('button', { name: 'Exporteren', exact: true }).click();
  const [dl2] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.getByRole('link', { name: 'Exporteren als Markdown' }).click()]);
  const mpath = path.join(dir, 'export.md');
  await dl2.saveAs(mpath);
  if (!/Ik ga verder waar ik was/.test(fs.readFileSync(mpath, 'utf8'))) fail('export MD: antwoord ontbreekt');
  step('chatmenu: exporteren als Markdown én JSON (met versies, zonder token)');
  // duplicate
  await page.getByRole('button', { name: 'Meer opties' }).click();
  await page.getByRole('button', { name: 'Bot beheren', exact: true }).click();
  await page.getByRole('button', { name: 'Bot dupliceren' }).click();
  await page.waitForURL(/#\/agents\/ag_/, { timeout: 8000 }).catch(() => fail('dupliceren: editor van de kopie opent niet'));
  const copy = app.ctx.store.agents(owner.id).find((a) => a.name === 'Mila (kopie)');
  if (!copy) fail('dupliceren: geen kopie');
  else if (app.ctx.store.all('SELECT id FROM threads WHERE agent_id = ?', copy.id).length) fail('dupliceren: kopie heeft gesprekken');
  // delete dialog with counts (cancel), then archive the copy from its chat
  await page.goto(`${app.url}/#/t/${threadId}`);
  await page.getByRole('button', { name: 'Meer opties' }).click();
  await page.getByRole('button', { name: 'Bot beheren', exact: true }).click();
  await page.getByRole('button', { name: 'Bot verwijderen…' }).click();
  const ddlg = page.getByRole('dialog', { name: 'Mila verwijderen?' });
  await ddlg.getByText(/1 gesprek met \d+ berichten/).waitFor({ timeout: 8000 }).catch(() => fail('verwijderen: dialoog noemt geen aantallen'));
  if (!(await ddlg.getByText('Dit blijft').count())) fail('verwijderen: "Dit blijft" ontbreekt');
  await shot(page, 'c2-5f-verwijderen-aantallen');
  await ddlg.getByRole('button', { name: 'Annuleren' }).click();
  await page.goto(`${app.url}/#/a/${copy.id}`);
  await page.waitForURL(/#\/t\//, { timeout: 8000 });
  await page.getByRole('button', { name: 'Meer opties' }).click();
  await page.getByRole('button', { name: 'Bot beheren', exact: true }).click();
  await page.getByRole('button', { name: 'Bot archiveren' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Archiveren' }).click();
  await page.waitForTimeout(500);
  if (!app.ctx.store.agent(copy.id)?.archived) fail('archiveren vanuit de chat werkte niet');
  step('chatmenu: dupliceren (zonder gesprekken), verwijderen met aantallen (wat gaat weg, wat blijft), archiveren');

  // ---- attachments the app cannot show (A-24/A-25) + link preview only on click (A-27) ----
  await page.goto(`${app.url}/#/t/${threadId}`);
  await page.waitForTimeout(500);
  // A .zip is unpacked for the bot now (no notice); another archive and a video still get one.
  const zip = path.join(dir, 'fotos.7z');
  const mp4 = path.join(dir, 'filmpje.mp4');
  fs.writeFileSync(zip, Buffer.from('377abcaf271c', 'hex'));
  fs.writeFileSync(mp4, Buffer.alloc(64));
  await page.locator('input[type=file]').setInputFiles([zip, mp4]);
  const note = page.getByRole('status').filter({ hasText: 'TeamBot pakt alleen zip-bestanden uit' });
  await note.waitFor({ timeout: 8000 }).catch(() => fail('bijlagen: geen melding voor het archief in het invoerveld'));
  if (!(await page.getByText(/filmpje\.mp4.*De bot kan het beeld van een video niet bekijken/).count())) fail('bijlagen: geen melding voor mp4');
  await shot(page, 'c2-5h-bijlagen-melding');
  script.push({ text: 'Ik heb de bestanden ontvangen.' });
  await composer.fill('Hier zijn de bestanden, zie ook https://example.com/info');
  await page.keyboard.press('Enter');
  await page.locator('[id^="m-"]').getByText('Ik heb de bestanden ontvangen.').waitFor({ timeout: 10000 });
  const sent = page.locator('[id^="m-"]').filter({ hasText: 'Hier zijn de bestanden' });
  if (!(await sent.getByText('Archief:').count()) || !(await sent.getByText('Video:').count())) fail('bijlagen: verzonden bericht toont de melding niet');
  await page.waitForTimeout(800);
  if (previewCalls.length) fail(`linkvoorbeeld: server haalde de URL van je eigen bericht vanzelf op (${previewCalls.length}×)`);
  if (!(await sent.getByRole('button', { name: 'Linkvoorbeeld tonen' }).count())) fail('linkvoorbeeld: knop ontbreekt bij eigen bericht');
  await shot(page, 'c2-5h-bijlagen-verzonden');
  step('7z/mp4: duidelijke melding vóór en na versturen; linkvoorbeeld van eigen bericht pas na klik (0 serververzoeken)');

  // ---- bot history with a readable diff (A-13) ----
  await api('PATCH', `/agents/${mila.id}`, { instructions: 'Schrijf kort en zakelijk.\nGebruik eenvoudige woorden.' });
  await api('PATCH', `/agents/${mila.id}`, { instructions: 'Schrijf kort en zakelijk.\nGebruik eenvoudige woorden.\nSluit af met een vraag.', role: 'Schrijfcoach' });
  await page.goto(`${app.url}/#/agents/${mila.id}`);
  const histBtn = page.getByRole('button', { name: /^Geschiedenis/ });
  // Geschiedenis is a closed section of the bot page, inside "Geavanceerd".
  await page.evaluate(() => document.querySelectorAll('details').forEach((x) => (x.open = true)));
  await histBtn.first().click();
  await page.getByRole('button', { name: /gewijzigd: instructies$/ }).click();
  const hist = page.locator('[data-section="core:history"]');
  await hist.locator('del').filter({ hasText: 'vriendelijk' }).first().waitFor({ timeout: 5000 }).catch(() => fail('geschiedenis: woord-diff (vriendelijk → zakelijk) ontbreekt'));
  if (!(await hist.locator('ins').filter({ hasText: 'zakelijk' }).count())) fail('geschiedenis: toegevoegd woord niet gemarkeerd');
  await hist.locator('[data-section="core:history"] li, li').first().scrollIntoViewIfNeeded().catch(() => {});
  await shot(page, 'c2-5e-geschiedenis-diff');
  await hist.getByRole('button', { name: 'Vergelijken met nu' }).last().click();
  await hist.getByText('Zo verschilt de versie van vóór deze wijziging van de bot nu.').waitFor({ timeout: 5000 }).catch(() => fail('geschiedenis: vergelijken met nu werkt niet'));
  if (!(await hist.getByText('Was', { exact: true }).count()) && !(await hist.locator('ins').filter({ hasText: 'Sluit' }).count())) fail('geschiedenis: vergelijking met nu toont geen verschil');
  await shot(page, 'c2-5e-vergelijken-met-nu');
  step('bot-geschiedenis: leesbare woord-diff per wijziging en "Vergelijken met nu"');

  // ---- own bot order, drag in the sidebar (A-10) ----
  await page.goto(`${app.url}/#/`);
  await page.getByRole('button', { name: 'Volgorde van de bots' }).click();
  await page.getByRole('menuitem', { name: /Volgorde aanpassen/ }).click();
  const list = page.getByRole('list', { name: 'Volgorde van de bots' });
  await list.waitFor({ timeout: 5000 });
  const names = async () => (await list.locator('li').allInnerTexts()).map((t) => t.trim().split('\n')[0]);
  const before = await names();
  // drag the last bot to the top with the mouse
  const lastGrip = list.locator('li').last().getByRole('button', { name: /verplaatsen/ });
  const firstRow = list.locator('li').first();
  const g = await lastGrip.boundingBox();
  const f = await firstRow.boundingBox();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2, f.y + 4, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const after = await names();
  if (after[0] !== before[before.length - 1]) fail(`volgorde: slepen werkte niet (${before.join(',')} → ${after.join(',')})`);
  await shot(page, 'c2-5g-volgorde-slepen');
  // arrows: move the (new) first one down
  await list.locator('li').first().getByRole('button', { name: /omlaag$/ }).click();
  await page.waitForTimeout(500);
  const after2 = await names();
  await page.getByRole('button', { name: 'Klaar' }).click();
  await page.waitForTimeout(500);
  const sorted = app.ctx.store.agents(owner.id).filter((a) => !a.archived).sort((a, b) => a.sort - b.sort).map((a) => a.name);
  if (sorted.join(',') !== after2.join(',')) fail(`volgorde: niet bewaard (${sorted.join(',')} vs ${after2.join(',')})`);
  if (app.ctx.store.settings(owner.id).ui?.botOrder !== 'manual') fail('volgorde: lijst niet op "Eigen volgorde" gezet');
  // The main bot always stands on top, in "Vastgezet" (above every team); the list under it follows the own order.
  const pinnedNames = (await page.getByRole('group', { name: 'Vastgezette bots' }).locator('li').allInnerTexts().catch(() => [])).map((t) => t.trim().split('\n')[0]);
  const sidebarNames = (await page.getByRole('list', { name: 'Bots en groepen' }).locator('li').allInnerTexts()).map((t) => t.trim().split('\n')[0]);
  const inList = after2.filter((n) => sidebarNames.some((s) => s.startsWith(n)));
  const shownOrder = sidebarNames.map((s) => after2.find((n) => s.startsWith(n))).filter(Boolean);
  if (inList.length + pinnedNames.filter((p) => after2.some((n) => p.startsWith(n))).length !== after2.length) fail(`volgorde: niet elke bot staat in de zijbalk (${after2.join(',')} vs vastgezet ${pinnedNames.join(',')} + ${sidebarNames.join(',')})`);
  if (shownOrder.join(',') !== inList.join(',')) fail(`volgorde: zijbalk volgt de eigen volgorde niet (${shownOrder.join(',')} vs ${inList.join(',')})`);
  await shot(page, 'c2-5g-zijbalk-eigen-volgorde');
  step(`eigen volgorde: slepen en pijlen, bewaard (${after2.join(' → ')}), zijbalk volgt`);

  // ---- phone ----
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p2 = await phone.newPage();
  p2.on('pageerror', (e) => errors.push(e.message));
  p2.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED|404 \(Not Found\)/.test(m.text()) && errors.push(m.text()));
  await p2.goto(`${app.url}/#token=${token}`);
  await p2.goto(`${app.url}/#/`);
  await p2.getByRole('button', { name: 'Volgorde van de bots' }).waitFor({ timeout: 8000 }).catch(() => fail('telefoon: knop Volgorde ontbreekt'));
  await p2.getByRole('button', { name: 'Volgorde van de bots' }).click();
  await p2.getByRole('menuitem', { name: /Volgorde aanpassen/ }).click();
  const box = await p2.getByRole('list', { name: 'Volgorde van de bots' }).locator('li').first().getByRole('button', { name: /omlaag$/ }).boundingBox();
  if (!box || box.height < 44) fail(`telefoon: pijlknoppen kleiner dan 44 px (${box?.height})`);
  await shot(p2, 'c2-5g-telefoon-volgorde');
  await p2.getByRole('button', { name: 'Klaar' }).click();
  await p2.goto(`${app.url}/#/t/${threadId}`);
  script.push({ text: 'lang antwoord op de telefoon', delayMs: 5000 });
  await p2.getByLabel('Bericht').fill('Nog een taak');
  await p2.getByRole('button', { name: 'Versturen' }).click();
  await p2.getByRole('button', { name: 'Stoppen', exact: true }).waitFor({ timeout: 8000 }).catch(() => fail('telefoon: bot werkt niet'));
  await p2.getByLabel('Bericht').fill('En nog iets');
  await p2.getByRole('button', { name: 'Versturen' }).click();
  const pq = p2.getByRole('region', { name: 'Wachtrij' });
  await pq.waitFor({ timeout: 8000 }).catch(() => fail('telefoon: bericht staat niet in de wachtrij'));
  const rb = await pq.getByRole('button', { name: 'Nu sturen' }).boundingBox();
  if (!rb || rb.height < 44) fail(`telefoon: pijl "Nu sturen" kleiner dan 44 px (${rb?.height})`);
  const over = await p2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over > 1) fail(`telefoon: horizontale overflow ${over}px in de chat`);
  await shot(p2, 'c2-5b-telefoon-bezig-wachtrij');
  await pq.getByRole('button', { name: 'Uit de wachtrij halen' }).click();
  await pq.waitFor({ state: 'detached', timeout: 5000 }).catch(() => fail('telefoon: wachtrij niet leeg na verwijderen'));
  await p2.getByRole('button', { name: 'Stoppen', exact: true }).click();
  await p2.getByRole('status').filter({ hasText: 'Je hebt Mila gestopt.' }).waitFor({ timeout: 8000 }).catch(() => fail('telefoon: Hervatten na stoppen ontbreekt'));
  await shot(p2, 'c2-5a-telefoon-hervatten');
  await p2.getByRole('button', { name: 'Meer opties' }).click();
  await shot(p2, 'c2-5f-telefoon-chatmenu');
  await p2.keyboard.press('Escape');
  const msg = p2.locator('[id^="m-"]').filter({ hasText: 'Schrijf een kort verhaal over de lente' }).first();
  await msg.getByRole('button', { name: /bewerkt/ }).click();
  await p2.getByRole('dialog', { name: 'Eerdere versies van dit bericht' }).waitFor({ timeout: 5000 }).catch(() => fail('telefoon: versies openen niet'));
  const over2 = await p2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over2 > 1) fail(`telefoon: horizontale overflow ${over2}px bij versies`);
  await shot(p2, 'c2-5d-telefoon-versies');
  await p2.keyboard.press('Escape');
  await p2.goto(`${app.url}/#/agents/${mila.id}`);
  const ph = p2.getByRole('button', { name: /^Geschiedenis/ });
  await p2.evaluate(() => document.querySelectorAll('details').forEach((x) => (x.open = true)));
  await ph.first().click();
  await p2.getByRole('button', { name: /gewijzigd: instructies$/ }).click();
  await p2.waitForTimeout(300);
  const over3 = await p2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over3 > 1) fail(`telefoon: horizontale overflow ${over3}px in de geschiedenis`);
  await p2.locator('[data-section="core:history"] del').first().scrollIntoViewIfNeeded();
  await shot(p2, 'c2-5e-telefoon-geschiedenis');
  step('telefoon: volgorde (44 px), bezig-keuze, hervatten, chatmenu, versies en geschiedenis zonder overloop');
  await phone.close();
} catch (e) {
  fail(e.stack || e.message);
} finally {
  await browser.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
if (errors.length) fail('console-fouten:\n  ' + errors.join('\n  '));
console.log(process.exitCode ? 'E2E C2-CHAT MISLUKT' : 'E2E C2-CHAT GESLAAGD');
