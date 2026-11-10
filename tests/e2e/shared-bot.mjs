// End-to-end (A-61, §21.3 P1 "gedeelde of persoonlijke bot, teaminbox"): a TeamBot server with its owner and two
// members. The owner shares a bot with the team in the bot editor; a member finds it under "Gedeeld" with the owner's
// name, talks to it in his own conversation, and the bot's approval card lands in HIS "Wacht op jou" (without
// "Altijd toestaan"); the owner and the other member cannot open that conversation. Fake engine, TEMP data.
// Usage: npm run build:ui && node --import tsx tests/e2e/shared-bot.mjs   (TEAMBOT_E2E_SHOTS=<dir> for screenshots)
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
const shot = async (page, name) => shots && (await page.waitForTimeout(400), await page.screenshot({ path: path.join(shots, `${name}.png`) }));
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const axe = async (page, where) => {
  await page.addScriptTag({ content: axeSource });
  const v = await page.evaluate(async () => {
    // @ts-ignore
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
    return r.violations.map((x) => `${x.id}: ${x.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(', ')}`);
  });
  if (v.length) fail(`a11y ${where}: ${v.join(' | ')}`);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-shared-bot-'));
const app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'server', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();
// The fake engine: the first question makes the bot want to write a note (an approval), then it answers.
let step2 = 0;
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
      const last = req.messages.at(-1);
      if (last?.role === 'user' && /notitie/.test(JSON.stringify(last.content)) && step2++ === 0)
        return { text: '', toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'notitie.txt', content: 'Vergadering om 10 uur' } }], usage: { input: 10, output: 5 }, stop: 'tool_use', model: req.model };
      onEvent({ type: 'text', delta: 'De notitie staat klaar.' });
      return { text: 'De notitie staat klaar.', toolCalls: [], usage: { input: 10, output: 5 }, stop: 'end', model: req.model };
    },
  }),
});
const call = async (tok, method, p, body) => {
  const res = await fetch(app.url + '/api' + p, { method, headers: { authorization: `Bearer ${tok}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, body: j };
};
const api = async (method, p, body) => {
  const r = await call(token, method, p, body);
  if (r.status >= 400) throw new Error(`${method} ${p}: ${r.status} ${r.body.error}`);
  return r.body;
};
await api('PUT', '/settings', { onboarded: true });
const prov = await api('POST', '/providers', { kind: 'e2emock' });
const bot = await api('POST', '/agents', { name: 'Helpdesk', role: 'Vragen van het team', provider_id: prov.id, model: 'e2e-1', access_mode: 'auto', tool_groups: ['files', 'web', 'memory'] });
const people = [];
for (const name of ['Lisa', 'Sam']) {
  const u = app.ctx.auth.createUser({ name, email: `${name.toLowerCase()}@test.local`, password: 'geheim1234', role: 'member' });
  const tok = app.ctx.auth.createSession(u.id, 'web', 'e2e').token;
  await call(tok, 'PUT', '/settings', { onboarded: true });
  people.push({ u, tok });
}
const [lisa, sam] = people;

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const errors = [];
const watch = (page) => page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED|40[34] \(|Failed to load resource/.test(m.text()) && errors.push(m.text()));
try {
  // ---- the owner shares the bot in the bot editor ----
  const op = await browser.newPage({ viewport: { width: 1360, height: 880 }, bypassCSP: true });
  watch(op);
  await op.goto(`${app.url}/#token=${token}`);
  await op.goto(`${app.url}/#/agents/${bot.id}`);
  // "Delen met het team" is a closed section on the tab Meer (behind "Meer opties").
  await op.getByRole('tab', { name: /^Meer/ }).click();
  await op.evaluate(() => document.querySelectorAll('details').forEach((x) => (x.open = true)));
  const secBtn = op.getByRole('button', { name: /Delen met het team/ });
  await secBtn.waitFor({ timeout: 20000 });
  if ((await secBtn.getAttribute('aria-expanded')) !== 'true') await secBtn.click();
  const share = op.getByTestId('share-with-team');
  await share.getByText('Gedeeld met het team').click();
  await shot(op, 'f2-shared-1-editor');
  await axe(op, 'bot-editor met delen');
  await op.getByRole('button', { name: /^Opslaan/ }).first().click();
  for (let i = 0; i < 50 && app.ctx.store.agent(bot.id).settings?.shared !== true; i++) await op.waitForTimeout(100);
  if (app.ctx.store.agent(bot.id).settings?.shared !== true) fail('delen: de schakelaar in de bot-editor deelde de bot niet');
  else step('eigenaar: "Gedeeld met het team" aangezet in de bot-editor');
  await op.getByText('gedeeld met het team', { exact: true }).first().waitFor({ timeout: 10000 });
  step('eigenaar: in zijn lijst staat "gedeeld met het team" bij de bot');

  // ---- a member finds it under "Gedeeld" with the owner's name and talks to it ----
  const lp = await browser.newPage({ viewport: { width: 1360, height: 880 }, bypassCSP: true });
  watch(lp);
  await lp.goto(`${app.url}/#token=${lisa.tok}`);
  await lp.goto(`${app.url}/#/`);
  const sharedList = lp.getByTestId('shared-bots');
  await sharedList.waitFor({ timeout: 20000 });
  const listText = await sharedList.innerText();
  if (!/Gedeeld/i.test(listText) || !/Helpdesk/.test(listText) || !new RegExp(`van ${owner.name}`).test(listText)) fail('lid: "Gedeeld" mist de bot of de naam van de eigenaar: ' + listText);
  await sharedList.getByRole('link', { name: /Helpdesk/ }).click();
  await lp.getByText(`gedeeld door ${owner.name}`).first().waitFor({ timeout: 15000 });
  if (!(await lp.getByText('alleen jij ziet dit gesprek').count())) fail('lid: de kop zegt niet dat het gesprek alleen van hem is');
  step(`lid: Helpdesk onder "Gedeeld" (van ${owner.name}); eigen gesprek geopend`);
  await lp.getByRole('textbox', { name: /Bericht/ }).fill('Maak een notitie voor de vergadering.');
  await lp.keyboard.press('Enter');
  const card = lp.getByRole('button', { name: /Eén keer toestaan/ });
  await card.waitFor({ timeout: 20000 });
  if (await lp.getByRole('button', { name: /Altijd toestaan/ }).count()) fail('lid: de kaart biedt "Altijd toestaan" voor de bot van een ander');
  await shot(lp, 'f2-shared-2-member-chat');
  await axe(lp, 'gesprek van een lid met een gedeelde bot');
  // His "Wacht op jou", not the owner's.
  const lisaInbox = (await call(lisa.tok, 'GET', '/approvals')).body;
  const ownerInbox = (await call(token, 'GET', '/approvals')).body;
  if (lisaInbox.length !== 1 || ownerInbox.length !== 0) fail(`teaminbox: lid ${lisaInbox.length}, eigenaar ${ownerInbox.length} (verwacht 1 en 0)`);
  else step('de goedkeuringskaart staat bij het lid in "Wacht op jou", niet bij de eigenaar');
  await card.click();
  await lp.getByText('De notitie staat klaar.').first().waitFor({ timeout: 20000 });
  const file = path.join(dir, 'shared-bots', bot.id, lisa.u.id, 'notitie.txt');
  if (!fs.existsSync(file)) fail('lid: de notitie staat niet in de eigen map van het lid');
  if (fs.existsSync(path.join(bot.workspace, 'notitie.txt'))) fail('lid: de notitie kwam in de map van de eigenaar');
  step('na toestemming schreef de bot in de eigen map van het lid');

  // ---- privacy: the owner and the other member cannot open it ----
  const th = app.ctx.store.one("SELECT id FROM threads WHERE user_id = ? AND agent_id = ?", lisa.u.id, bot.id);
  const asOwner = await call(token, 'GET', `/threads/${th.id}`);
  const asSam = await call(sam.tok, 'GET', `/threads/${th.id}`);
  if (asOwner.status !== 404 || asSam.status !== 404) fail(`privacy: eigenaar ${asOwner.status}, ander lid ${asSam.status} (verwacht 404)`);
  const ownerThreads = (await call(token, 'GET', '/threads')).body;
  if (ownerThreads.some((x) => x.id === th.id)) fail('privacy: het gesprek van het lid staat in de lijst van de eigenaar');
  else step('de eigenaar en het andere lid kunnen het gesprek niet openen');
  // Owner-only: editing the bot is refused in plain words.
  const edit = await call(lisa.tok, 'PATCH', `/agents/${bot.id}`, { name: 'Van mij' });
  if (edit.status !== 403 || !/Alleen de eigenaar kan dit doen/.test(edit.body.error || '')) fail('lid kon de gedeelde bot aanpassen of kreeg geen uitleg: ' + edit.status);
  else step('aanpassen door een lid: geweigerd met uitleg');

  // ---- phone width ----
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, bypassCSP: true });
  watch(phone);
  await phone.goto(`${app.url}/#token=${sam.tok}`);
  await phone.goto(`${app.url}/#/`);
  await phone.getByTestId('shared-bots').waitFor({ timeout: 20000 });
  const fits = await phone.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  if (!fits) fail('telefoon: lijst breder dan het scherm');
  await shot(phone, 'f2-shared-3-phone');
  step('telefoon: "Gedeeld" past op 390 px');
  if (errors.length) fail('console-fouten: ' + errors.slice(0, 5).join(' | '));
} catch (e) {
  fail(String(e?.stack || e));
} finally {
  await browser.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
if (!process.exitCode) console.log('gedeelde bot: alles groen');
