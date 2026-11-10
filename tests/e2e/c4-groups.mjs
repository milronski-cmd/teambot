// End-to-end (A-60): a group's task board, its shared files and a chat-app channel bound to the group, through the UI
// with a scripted engine. The lead creates/finishes tasks and reads/writes group files with its team tools; people add
// files and move tasks; a message from a chat app reaches the group and the lead's answer goes back. Desktop 1360×880
// and phone 390×844; no console errors.
// Usage: npm run build:ui && node --import tsx tests/e2e/c4-groups.mjs   (TEAMBOT_E2E_SHOTS=<dir> for screenshots)
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
const shot = async (page, name) => shots && (await page.waitForTimeout(450), await page.screenshot({ path: path.join(shots, `${name}.png`) }));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-c4-groups-'));
const app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();

// A scripted engine: each step is a text or tool calls (one step per model call).
const script = [];
let lastReq = null;
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
      lastReq = req;
      const s = script.shift() || { text: 'Oké.' };
      if (s.text) onEvent({ type: 'text', delta: s.text });
      const toolCalls = (s.toolCalls || []).map((c, i) => ({ id: `call_${Date.now()}_${i}`, name: c.name, args: c.args }));
      return { text: s.text || '', toolCalls, usage: { input: 10, output: 5 }, stop: toolCalls.length ? 'tool_use' : 'end', model: req.model };
    },
  }),
});

// A chat app that only exists in this test (like WhatsApp or Telegram): it records what TeamBot sends back.
const sent = [];
let channelCtx = null;
app.ctx.services.channels.registerAdapter({
  id: 'nepchat',
  label: 'Nepchat',
  description: 'test',
  needsPublicUrl: () => false,
  approveViaChannel: true,
  maxText: 2000,
  secretFields: [{ key: 'token', label: 'Token', required: true }],
  validate: () => ({}),
  test: async () => ({ ok: true, detail: 'ok', info: { botName: 'nepbot' } }),
  create(ctx) {
    channelCtx = ctx;
    return {
      async start() {
        return 'connected';
      },
      async stop() {},
      async send(conv, out) {
        sent.push({ conv: conv.external_id, text: out.text });
        return [`out${sent.length}`];
      },
      async sendTo(target) {
        return { conversationId: target, title: target, private: true, ids: ['x'] };
      },
      async typing() {},
    };
  },
});

const api = async (method, p, body) => {
  const res = await fetch(app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${j.error}`);
  return j;
};
const until = async (fn, ms = 10000, what = 'voorwaarde') => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`time-out: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
const idle = (threadId) => until(() => !app.ctx.store.all("SELECT id FROM runs WHERE thread_id = ? AND status IN ('queued','running','waiting')", threadId).length, 15000, 'runs klaar');

await api('PUT', '/settings', { onboarded: true });
const prov = await api('POST', '/providers', { kind: 'e2emock' });
const mk = (name, extra = {}) => api('POST', '/agents', { name, provider_id: prov.id, model: 'e2e-1', access_mode: 'auto', tool_groups: ['team', 'files', 'memory'], ...extra });
const ada = await mk('Ada', { role: 'Teamleider' });
const bo = await mk('Bo', { role: 'Inkoper' });
const made = await api('POST', '/rooms', { name: 'Inkoopteam', agentIds: [ada.id, bo.id], mode: 'lead', leadAgentId: ada.id, instructions: 'Vergelijk altijd drie offertes.' });
const room = made.room;
const threadId = made.threadId;

// This test opens the side panel's Team tab: those are expert panels, shown with Instellingen › Geavanceerd tonen (settings.ui.advanced).
app.ctx.store.setSetting(app.ctx.auth.owner().id, 'ui', { ...(app.ctx.store.settings(app.ctx.auth.owner().id).ui || {}), advanced: true });
const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const errors = [];
const watch = (page) => page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED|404 \(Not Found\)/.test(m.text()) && errors.push(m.text()));
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const send = async (page, text) => {
  const box = page.getByRole('textbox', { name: 'Bericht' });
  await box.fill(text);
  await box.press('Enter');
};
try {
  const ctxb = await browser.newContext({ viewport: { width: 1360, height: 880 } });
  const page = await ctxb.newPage();
  watch(page);
  await page.goto(`${app.url}/#token=${token}`);

  // 1. Task board: a person adds a task; the lead finishes it from the group chat; the board updates live.
  const board = await ctxb.newPage();
  watch(board);
  await board.goto(`${app.url}/#/m/rooms/taken`);
  await board.getByRole('button', { name: 'Nieuwe taak' }).first().click();
  await board.getByRole('textbox', { name: 'Nieuwe taak' }).fill('Drie offertes voor zonnepanelen opvragen');
  await board.getByRole('combobox', { name: 'Voor welke groep' }).selectOption({ label: 'Inkoopteam' });
  await board.getByRole('button', { name: 'Toevoegen' }).click();
  const taskCard = board.getByText('Drie offertes voor zonnepanelen opvragen');
  await taskCard.waitFor({ timeout: 8000 });
  const task = (await api('GET', '/rooms/tasks')).find((t) => t.title.startsWith('Drie offertes'));
  script.push(
    { toolCalls: [{ name: 'task_create', args: { title: 'Offertes vergelijken', owner: 'Bo', status: 'doing' } }] },
    // A bot's "klaar" needs evidence and passes the second look (quality module); that check is one scripted call.
    { toolCalls: [{ name: 'task_update', args: { id: task.id, status: 'done', result: 'Drie offertes binnen: € 3.950, € 4.200 en € 4.480.', evidence: ['Offertes van leverancier A, B en C ontvangen per mail'] } }] },
    { text: '{"verdict":"klaar","reason":"Drie offertes met bedragen zijn gemeld."}' },
    { text: 'Taak bijgewerkt en een nieuwe taak voor Bo gezet.' },
  );
  await page.goto(`${app.url}/#/t/${threadId}`);
  await send(page, 'Werk het takenbord bij.');
  await idle(threadId);
  await board.getByText('Drie offertes binnen: € 3.950').waitFor({ timeout: 8000 }).catch(() => fail('takenbord: resultaat van de lead niet live zichtbaar'));
  await board.getByText('Offertes vergelijken').waitFor({ timeout: 8000 }).catch(() => fail('takenbord: nieuwe taak van de lead niet zichtbaar'));
  const done = board.getByRole('region', { name: /^Klaar: / }).filter({ hasText: 'Drie offertes voor zonnepanelen' });
  if (!(await done.count())) fail('takenbord: taak staat niet in "Klaar"');
  // Moving a card: the "⋯" menu of the card (dragging it to another column does the same).
  await board.getByRole('button', { name: 'Acties voor Offertes vergelijken' }).click();
  await board.getByRole('menuitemradio', { name: 'Te controleren' }).click();
  await until(async () => (await api('GET', '/rooms/tasks')).find((t) => t.title === 'Offertes vergelijken')?.status === 'review', 5000, 'status door mens');
  await shot(board, 'c4-a60-takenbord');
  step('A-60 takenbord: mens voegt toe, lead rondt af en maakt een taak (live), mens verplaatst');

  // 2. Group files: a person adds a file; the lead reads it and writes a summary; both show in the list and preview.
  await page.goto(`${app.url}/#/m/rooms/groep/${room.id}?tab=bestanden`);
  await page.getByRole('button', { name: 'Bestand toevoegen' }).waitFor({ timeout: 8000 });
  const up = path.join(dir, 'prijslijst.txt');
  fs.writeFileSync(up, 'Leverancier A: € 3.950\nLeverancier B: € 4.200\nLeverancier C: € 4.480\n');
  await page.locator('input[type=file][aria-label="Bestanden kiezen"]').setInputFiles(up);
  await page.getByRole('list', { name: 'Groepsbestanden' }).getByText('prijslijst.txt').waitFor({ timeout: 8000 });
  script.push(
    { toolCalls: [{ name: 'room_file_read', args: { path: 'prijslijst.txt' } }] },
    { toolCalls: [{ name: 'room_file_write', args: { path: 'samenvatting.md', content: '# Samenvatting\n\n- Goedkoopst: **Leverancier A** (€ 3.950)\n- Verschil met C: € 530\n' } }] },
    { text: 'De samenvatting staat in de groepsmap.' },
  );
  const pageFiles = await ctxb.newPage();
  watch(pageFiles);
  await pageFiles.goto(`${app.url}/#/m/rooms/groep/${room.id}?tab=bestanden`);
  await pageFiles.getByRole('list', { name: 'Groepsbestanden' }).getByText('prijslijst.txt').waitFor({ timeout: 8000 });
  await page.goto(`${app.url}/#/t/${threadId}`);
  await send(page, 'Lees de prijslijst en zet een samenvatting in de groepsmap.');
  await idle(threadId);
  const toolMsg = app.ctx.store.messages(threadId).find((m) => m.role === 'tool' && /groepsbestand pad="prijslijst.txt"/.test(m.content));
  if (!toolMsg || !/Leverancier C: € 4\.480/.test(toolMsg.content)) fail('groepsbestand: de lead las de prijslijst niet');
  await pageFiles.getByRole('list', { name: 'Groepsbestanden' }).getByText('samenvatting.md').waitFor({ timeout: 8000 }).catch(() => fail('groepsbestand van de lead niet live in de lijst'));
  await pageFiles.getByRole('button', { name: /^samenvatting\.md \d/ }).click();
  await pageFiles.getByRole('dialog').getByText('Leverancier A').waitFor({ timeout: 8000 }).catch(() => fail('voorbeeld van samenvatting.md toont de inhoud niet'));
  await shot(pageFiles, 'c4-a60-groepsbestanden');
  await pageFiles.keyboard.press('Escape');
  // The same files in the side panel of the group chat (read + preview; managing is in the group settings).
  await page.getByRole('button', { name: 'Zijpaneel' }).click();
  await page.getByRole('tab', { name: 'Team' }).click();
  await page.getByText('Groepsbestanden', { exact: false }).first().waitFor({ timeout: 5000 });
  if (!(await page.getByRole('complementary').or(page.locator('body')).getByText('samenvatting.md').count())) fail('zijpaneel: groepsbestanden ontbreken');
  await shot(page, 'c4-a60-zijpaneel-groepsbestanden');
  step('A-60 groepsbestanden: mens uploadt, lead leest en schrijft, lijst live, voorbeeld en zijpaneel');

  // 3. A chat app bound to the group: the message reaches the group, the lead answers, the answer goes back.
  const binding = await api('POST', '/channels/bindings', { adapter: 'nepchat', name: 'Nepchat', room_id: room.id, config: {}, secrets: { token: 'nep-token-123456789' } });
  await until(() => channelCtx && app.ctx.store.get('channel_bindings', binding.id)?.status === 'connected', 5000, 'kanaal verbonden');
  await api('POST', `/channels/bindings/${binding.id}/senders`, { external_id: 'u-jan', label: 'Jan' });
  await page.goto(`${app.url}/#/m/channels`);
  await page.getByText(/groep Inkoopteam/).first().waitFor({ timeout: 8000 }).catch(() => fail('kanalenpagina zegt niet dat de groep antwoordt'));
  await shot(page, 'c4-a60-kanaal-groep');
  script.push({ text: 'Hoi Jan, leverancier A is het goedkoopst (€ 3.950).' });
  const r = await channelCtx.receive({ messageId: 'n1', conversation: { id: 'chat-jan', title: 'Jan', private: true }, sender: { id: 'u-jan', name: 'Jan' }, text: 'Welke offerte is het goedkoopst?', timestamp: Date.now() });
  if (r.status !== 'ok') fail(`kanaal: bericht niet aangenomen (${r.status})`);
  const ct = app.ctx.store.thread(r.threadId);
  if (ct?.room_id !== room.id) fail('kanaalgesprek hoort niet bij de groep');
  await idle(r.threadId);
  await until(() => sent.some((x) => /leverancier A is het goedkoopst/.test(x.text)), 8000, 'antwoord terug naar de chat-app').catch(() => fail('antwoord van de groep kwam niet terug in de chat-app'));
  const answers = app.ctx.store.messages(r.threadId).filter((m) => m.role === 'assistant' && m.content);
  if (answers.length !== 1 || answers[0].author_id !== ada.id) fail('kanaal: niet precies één antwoord van de lead');
  await page.goto(`${app.url}/#/t/${r.threadId}`);
  await page.getByText('Welke offerte is het goedkoopst?').waitFor({ timeout: 8000 }).catch(() => fail('kanaalgesprek niet te openen in TeamBot'));
  await shot(page, 'c4-a60-kanaalgesprek');
  step('A-60 kanaal aan de groep: bericht komt binnen, lead antwoordt, antwoord gaat terug');

  // 4. Organisation: a team with a chief of staff, a department under it, a member's title and whom they report to;
  //    the group is linked to the team and its bots get the org chart in their instructions.
  await page.goto(`${app.url}/#/m/rooms/organisatie`);
  await page.getByRole('button', { name: 'Eerste afdeling maken' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Naam').fill('Inkoop');
  await dlg.getByLabel('Chief of staff').selectOption({ label: 'Ada' });
  await dlg.getByRole('button', { name: 'Bo' }).click();
  await dlg.getByRole('button', { name: 'Afdeling maken' }).click();
  await page.getByText('chief of staff: Ada').waitFor({ timeout: 8000 });
  const team = (await api('GET', '/rooms/teams')).find((t) => t.name === 'Inkoop');
  if (!team || team.chief_agent_id !== ada.id) fail('organisatie: chief of staff niet opgeslagen');
  const boRow = team?.members.find((m) => m.agent_id === bo.id);
  if (!boRow || boRow.reports_to !== ada.id) fail('organisatie: Bo rapporteert niet aan Ada');
  if ((await page.getByRole('combobox', { name: 'Bo rapporteert aan' }).inputValue()) !== ada.id) fail('organisatie: "rapporteert aan" niet zichtbaar');
  await page.getByRole('textbox', { name: 'Functie van Bo' }).fill('Inkoper zonnepanelen');
  await page.getByRole('textbox', { name: 'Functie van Bo' }).press('Tab');
  await until(async () => (await api('GET', '/rooms/teams')).find((t) => t.name === 'Inkoop')?.members.find((m) => m.agent_id === bo.id)?.title === 'Inkoper zonnepanelen', 5000, 'functie opgeslagen');
  await page.getByRole('button', { name: 'Afdeling eronder' }).click();
  await page.getByRole('dialog').getByLabel('Naam').fill('Zonnepanelen');
  if ((await page.getByRole('dialog').getByLabel('Valt onder').inputValue()) !== team.id) fail('organisatie: "Afdeling eronder" kiest het team niet voor');
  await page.getByRole('dialog').getByRole('button', { name: 'Afdeling maken' }).click();
  await page.getByText('Afdeling van Inkoop').waitFor({ timeout: 8000 });
  const sub = (await api('GET', '/rooms/teams')).find((t) => t.name === 'Zonnepanelen');
  if (sub?.parent_id !== team.id) fail('organisatie: afdeling hangt niet onder Inkoop');
  await shot(page, 'c4-a60-organisatie');
  await page.goto(`${app.url}/#/m/rooms/groep/${room.id}`);
  await page.getByLabel('Hoort bij afdeling').selectOption({ label: 'Inkoop' });
  await page.getByRole('button', { name: 'Opslaan' }).click();
  await until(async () => (await api('GET', `/rooms/${room.id}`)).team_id === team.id, 5000, 'groep aan team');
  script.push({ text: 'Ik vraag het aan Bo.' });
  await page.goto(`${app.url}/#/t/${threadId}`);
  await send(page, 'Wie doet de zonnepanelen?');
  await idle(threadId);
  const sys = JSON.stringify(lastReq || {});
  if (!sys.includes('Team: Inkoop') || !sys.includes('rapporteert aan Ada') || !sys.includes('Inkoper zonnepanelen')) fail('organisatie: het organigram zit niet in de instructies van de lead');
  step('A-60 organisatie: team met chief of staff, afdeling eronder, functie en rapportagelijn; groep aan het team; organigram in de instructies');
  await ctxb.close();

  // Phone: task board, group files and the channel conversation without overflow.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p2 = await phone.newPage();
  watch(p2);
  await p2.goto(`${app.url}/#token=${token}`);
  await p2.goto(`${app.url}/#/m/rooms/taken`);
  await p2.getByText('Offertes vergelijken').waitFor({ timeout: 8000 });
  if ((await overflow(p2)) > 1) fail('telefoon: overloop op het takenbord');
  await shot(p2, 'c4-a60-telefoon-takenbord');
  await p2.goto(`${app.url}/#/m/rooms/groep/${room.id}?tab=bestanden`);
  await p2.getByRole('list', { name: 'Groepsbestanden' }).getByText('samenvatting.md').waitFor({ timeout: 8000 });
  if ((await overflow(p2)) > 1) fail('telefoon: overloop bij groepsbestanden');
  await shot(p2, 'c4-a60-telefoon-bestanden');
  await p2.goto(`${app.url}/#/m/rooms/organisatie`);
  await p2.getByText('Afdeling van Inkoop').waitFor({ timeout: 8000 });
  if ((await overflow(p2)) > 1) fail('telefoon: overloop bij organisatie');
  await shot(p2, 'c4-a60-telefoon-organisatie');
  step('telefoon: takenbord, groepsbestanden en organisatie zonder overloop');
  await phone.close();
} catch (e) {
  fail(e.stack || e.message);
} finally {
  await browser.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
if (errors.length) fail('console-fouten:\n  ' + errors.join('\n  '));
console.log(process.exitCode ? 'E2E C4-GROUPS MISLUKT' : 'E2E C4-GROUPS GESLAAGD');
