// Status reactions in chat apps as the owner uses them (TeamBot 0.4.4): Kanalen › <kanaal> › Toegang has the switch
// "Reacties als status op berichten" (on by default) for a channel with reactions; turning it off is saved and the bot
// no longer reacts; a channel without reactions (webhook) has no such switch; the Slack guide names reactions:write.
// Also as a paired phone: the switch is there and works, no failing requests.
// Edge/Chrome headless, temp data dir, a free port (TEAMBOT_E2E_PORT to fix one; never 4747/4748).
// Usage: npm run build:ui && node --import tsx tests/e2e/channel-reactions.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const { createApp } = await import('../../server/app.ts');
const { mockAdapter } = await import('../helpers.ts');
const { axeCheck } = await import('./axe-check.mjs');

const step = (s) => console.log(`• ${s}`);
const fail = (s) => {
  console.error(`✗ ${s}`);
  process.exitCode = 1;
};
const port = Number(process.env.TEAMBOT_E2E_PORT) || 0;
if (port === 4747 || port === 4748) throw new Error('4747/4748 zijn van de geïnstalleerde TeamBot');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-e2e-reactions-'));
const app = await createApp({ dataDir: dir, port, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();
const script = [];
app.ctx.providers.registerKind({ id: 'mock', label: 'Testmodel', type: 'api', billing: 'local', needsKey: false, description: 'e2e', models: ['mock-1'], defaultModel: 'mock-1', create: () => mockAdapter(script, []) });
const prov = app.ctx.providers.create(owner.id, { kind: 'mock', name: 'Testmodel' });
const bot = app.ctx.store.createAgent(owner.id, { name: 'Chatbot', role: 'Test', provider_id: prov.id, model: 'mock-1', access_mode: 'auto', tool_groups: [] });
// a chat app test double with reactions (never a real account)
const reacts = [];
let actx = null;
app.ctx.services.channels.registerAdapter({
  id: 'nepchat',
  label: 'Nepchat',
  description: 'test',
  needsPublicUrl: () => false,
  approveViaChannel: true,
  maxText: 1000,
  reactions: true,
  secretFields: [{ key: 'token', label: 'Token', required: true }],
  validate: () => ({}),
  test: async () => ({ ok: true, detail: 'ok' }),
  create(ctx) {
    actx = ctx;
    return { start: async () => 'connected', stop: async () => {}, send: async () => ['o1'], react: async (_c, to, status) => void reacts.push(`${to}:${status}`) };
  },
});
const api = async (method, p, body, tk = token) => (await fetch(`${app.url}/api${p}`, { method, headers: { authorization: `Bearer ${tk}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
const chan = await api('POST', '/channels/bindings', { adapter: 'nepchat', name: 'Nepchat', agent_id: bot.id, secrets: { token: 'nep-token-0123456789' } });
await api('POST', `/channels/bindings/${chan.id}/senders`, { external_id: 'u1', label: 'Jan' });
const hook = await api('POST', '/channels/bindings', { adapter: 'webhook', name: 'Eigen app', agent_id: bot.id, enabled: false, config: { replyMode: 'none' }, secrets: { signingSecret: 'webhook-geheim-0123456789abcdef' } });
step(`TeamBot op ${app.url}`);

const waitFor = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const errors = [];
try {
  if (!(await waitFor(() => actx))) throw new Error('nepchat niet gestart');
  script.push({ text: 'Hoi Jan' });
  await actx.receive({ messageId: 'e1', conversation: { id: 'c1', title: 'Jan', private: true }, sender: { id: 'u1', name: 'Jan' }, text: 'Hallo', reactTo: 'M1' });
  if (!(await waitFor(() => reacts.includes('M1:done')))) fail(`geen 👀 en klaar-reactie: ${reacts.join(', ')}`);
  else step('bericht in de chat-app: de bot zet 👀 en daarna “klaar” (testdubbel)');

  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, bypassCSP: true })).newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/favicon|401 \(Unauthorized\)/.test(m.text()) && errors.push(m.text()));
  await page.goto(`${app.url}/#token=${token}`);
  await page.waitForTimeout(600);
  await page.goto(`${app.url}/#/m/channels/${chan.id}`);
  await page.getByRole('tab', { name: /^Toegang/ }).click();
  const sw = page.getByRole('switch', { name: 'Reacties als status op berichten' });
  await sw.waitFor({ timeout: 8000 });
  if ((await sw.getAttribute('aria-checked')) !== 'true') fail('de schakelaar staat niet standaard aan');
  if (!(await page.getByText('De bot zet 👀 op je bericht zodra hij begint').count())) fail('uitleg bij de schakelaar ontbreekt');
  const a11yList = await axeCheck(page);
  if (a11yList.length) fail(`Kanaal › Toegang (toegankelijkheid): ${a11yList.join(' | ')}`);
  await sw.click();
  await page.getByRole('button', { name: 'Opslaan' }).first().click();
  if (!(await waitFor(async () => (await api('GET', `/channels/bindings/${chan.id}`)).config.reactions === false))) fail('uitzetten is niet opgeslagen');
  script.push({ text: 'Stil' });
  await actx.receive({ messageId: 'e2', conversation: { id: 'c1', title: 'Jan', private: true }, sender: { id: 'u1', name: 'Jan' }, text: 'Nog eens', reactTo: 'M2' });
  await new Promise((r) => setTimeout(r, 1200));
  if (reacts.some((r) => r.startsWith('M2:'))) fail('de bot reageerde nog terwijl het uit staat');
  step('Toegang: “Reacties als status op berichten” staat standaard aan (axe: geen ernstige problemen); uitgezet en opgeslagen, daarna geen reacties meer');

  await page.goto(`${app.url}/#/m/channels/${hook.id}`);
  await page.getByRole('tab', { name: /^Toegang/ }).click();
  await page.getByRole('switch', { name: 'Korte melding sturen als de bot vastloopt' }).waitFor({ timeout: 8000 });
  if (await page.getByRole('switch', { name: 'Reacties als status op berichten' }).count()) fail('webhook-kanaal heeft een reactie-schakelaar (kan daar niet)');
  step('een kanaal zonder reacties (webhook) heeft geen schakelaar');

  // the Slack setup text names reactions:write
  await page.goto(`${app.url}/#/m/channels/nieuw`);
  await page.getByText('Slack', { exact: true }).first().click();
  await page.getByText(/reactions:write/).first().waitFor({ timeout: 8000 });
  step('Slack-uitleg noemt de scope reactions:write');

  // paired phone: the switch is there and works
  const ticket = await api('POST', '/mobile/pair', { baseUrl: app.url });
  const secret = new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('t');
  const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TeamBotiOS/0.4.4';
  const claimed = await (await fetch(`${app.url}/api/public/mobile/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA }, body: JSON.stringify({ secret, name: 'iPhone', platform: 'ios', client: 'ios-app' }) })).json();
  const phoneCtx = await browser.newContext({ viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true, userAgent: UA });
  await phoneCtx.addInitScript((t) => localStorage.setItem('tb_token', t), claimed.token);
  const phone = await phoneCtx.newPage();
  const phoneFails = [];
  phone.on('pageerror', (e) => phoneFails.push(e.message));
  phone.on('response', (r) => r.url().includes('/api/') && r.status() >= 400 && phoneFails.push(`verzoek ${r.url()} → ${r.status()}`));
  await phone.goto(`${app.url}/#/m/channels/${chan.id}`);
  await phone.getByRole('tab', { name: /^Toegang/ }).tap();
  const psw = phone.getByRole('switch', { name: 'Reacties als status op berichten' });
  await psw.waitFor({ timeout: 8000 });
  if ((await psw.getAttribute('aria-checked')) !== 'false') fail('telefoon: de schakelaar toont niet dat het uit staat');
  await psw.tap();
  await phone.getByRole('button', { name: 'Opslaan' }).first().tap();
  if (!(await waitFor(async () => (await api('GET', `/channels/bindings/${chan.id}`)).config.reactions === true))) fail('telefoon: weer aanzetten is niet opgeslagen');
  if (phoneFails.length) fail(`telefoon: ${phoneFails.join('; ')}`);
  step('gekoppelde telefoon: de schakelaar staat er, weer aangezet en opgeslagen, geen mislukte verzoeken');
  if (errors.length) fail(`paginafouten: ${errors.join(' | ')}`);
} catch (e) {
  fail(String(e?.stack || e));
} finally {
  await browser.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
if (!process.exitCode) step('klaar: alles geslaagd');
