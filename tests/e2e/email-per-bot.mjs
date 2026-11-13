// "Een e-mailadres per bot" as the owner sees it (TeamBot 0.4.4, P10): an e-mail channel on his own mailbox with plus
// addressing shows the address of each bot (jij+baas@…, jij+schrijver@…) on the Kanalen page and on the channel itself,
// also on a paired phone; a mail to jij+schrijver@… lands in Schrijver's conversation. No real mailbox: the real e-mail
// adapter without IMAP (mails in through handleRaw, out through nodemailer's JSON transport).
// Edge/Chrome headless, temp data dir, a free port (TEAMBOT_E2E_PORT to fix one; never 4747/4748). axe WCAG 2.2 AA.
// Usage: npm run build:ui && node --import tsx tests/e2e/email-per-bot.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const nodemailer = require('nodemailer');
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const { createApp } = await import('./server.mjs');
const { mockAdapter } = await import('../helpers.ts');
const { emailAdapter, emailTransport } = await import('../../server/modules/channels/adapters/email.ts');

const step = (s) => console.log(`• ${s}`);
const fail = (s) => {
  console.error(`✗ ${s}`);
  process.exitCode = 1;
};
const port = Number(process.env.TEAMBOT_E2E_PORT) || 0;
if (port === 4747 || port === 4748) throw new Error('4747/4748 zijn van de geïnstalleerde TeamBot');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-e2e-mailplus-'));
const app = await createApp({ dataDir: dir, port, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();
app.ctx.providers.registerKind({ id: 'mock', label: 'Testmodel', type: 'api', billing: 'local', needsKey: false, description: 'e2e', models: ['mock-1'], defaultModel: 'mock-1', create: () => mockAdapter([], []) });
const prov = app.ctx.providers.create(owner.id, { kind: 'mock', name: 'Testmodel' });
const baas = app.ctx.store.createAgent(owner.id, { name: 'Baas', role: 'Test', provider_id: prov.id, model: 'mock-1', access_mode: 'auto' });
const schrijver = app.ctx.store.createAgent(owner.id, { name: 'Schrijver', role: 'Test', provider_id: prov.id, model: 'mock-1', access_mode: 'auto' });
const sent = [];
emailTransport.create = () => {
  const tr = nodemailer.createTransport({ jsonTransport: true });
  return { sendMail: async (o) => sent.push(JSON.parse((await tr.sendMail(o)).message)) };
};
let rt = null;
app.ctx.services.channels.registerAdapter({
  ...emailAdapter,
  create(ctx) {
    rt = emailAdapter.create(ctx);
    rt.start = async () => 'connected';
    rt.stop = async () => {};
    return rt;
  },
});
const api = async (method, p, body, tok = token) => {
  const r = await fetch(`${app.url}/api${p}`, { method, headers: { authorization: `Bearer ${tok}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};
const b = await api('POST', '/channels/bindings', { adapter: 'email', name: 'Mijn mail', agent_id: baas.id, config: { preset: 'gmail', address: 'jij@gmail.com', plusAddressing: true }, secrets: { password: 'app-wachtwoord-1234' } });
await api('POST', `/channels/bindings/${b.id}/senders`, { external_id: 'jij@gmail.com', label: 'Sanne', is_owner: true });
step(`TeamBot op ${app.url}`);

async function axeOn(page, sel, name) {
  await page.addScriptTag({ content: axeSource });
  const v = await page.evaluate(async (s) => {
    // @ts-ignore
    const r = await window.axe.run({ include: [[s]] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
    return r.violations.map((x) => `${x.id}: ${x.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`);
  }, sel);
  if (v.length) fail(`a11y ${name}: ${v.join(' | ')}`);
}

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const errors = [];
try {
  // A mail from the owner to Schrijver's address: Schrijver's conversation, answered from that address.
  const raw = ['From: Sanne <jij@gmail.com>', 'To: jij+schrijver@gmail.com', 'Subject: Nieuwsbrief', 'Message-ID: <e2e-1@gmail.com>', 'Authentication-Results: mx.google.com; dmarc=pass', 'Content-Type: text/plain; charset=utf-8', '', 'Schrijf een stukje.'].join('\r\n');
  await rt.handleRaw(Buffer.from(raw), 1, 100);
  const end = Date.now() + 15_000;
  while (Date.now() < end && !sent.length) await new Promise((r) => setTimeout(r, 100));
  const conv = app.ctx.store.one('SELECT thread_id FROM channel_conversations WHERE binding_id = ? AND external_id = ?', b.id, '<e2e-1@gmail.com>');
  if (!conv?.thread_id || app.ctx.store.thread(conv.thread_id)?.agent_id !== schrijver.id) fail('mail aan jij+schrijver@ kwam niet bij Schrijver');
  if (sent[0]?.from?.address !== 'jij+schrijver@gmail.com') fail(`antwoord niet vanaf het adres van de bot (${JSON.stringify(sent[0]?.from)})`);
  step('mail aan jij+schrijver@gmail.com: gesprek met Schrijver, antwoord vanaf jij+schrijver@gmail.com');

  for (const scheme of ['light', 'dark']) {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme, bypassCSP: true })).newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !/favicon|401 \(Unauthorized\)/.test(m.text()) && errors.push(m.text()));
    await page.goto(`${app.url}/#token=${token}`);
    await page.waitForTimeout(600);
    await page.goto(`${app.url}/#/m/channels`);
    const list = page.locator('[data-testid="bot-addresses"]').first();
    await list.waitFor({ timeout: 10000 });
    const text = (await list.textContent()) || '';
    if (!text.includes('jij+baas@gmail.com') || !text.includes('jij+schrijver@gmail.com')) fail(`Kanalen (${scheme}): niet elk adres staat er: ${text}`);
    await axeOn(page, '[data-testid="bot-addresses"]', `kanalen (${scheme})`);
    await page.goto(`${app.url}/#/m/channels/${b.id}`);
    await page.getByText('E-mailadres per bot', { exact: true }).waitFor({ timeout: 10000 });
    if (!(await page.getByText(/Verzenden als/).count())) fail('kanaal: de Gmail-uitleg (Verzenden als) ontbreekt');
    await page.context().close();
  }
  step('Kanalen en het kanaal zelf: het adres van elke bot, met de Gmail-uitleg; licht en donker, axe schoon');

  const ticket = await api('POST', '/mobile/pair', { baseUrl: app.url });
  const secret = new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('t');
  const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TeamBotiOS/0.4.4';
  const claimed = await (await fetch(`${app.url}/api/public/mobile/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA }, body: JSON.stringify({ secret, name: 'iPhone', platform: 'ios', client: 'ios-app' }) })).json();
  const phoneCtx = await browser.newContext({ viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true, userAgent: UA, colorScheme: 'dark', bypassCSP: true });
  await phoneCtx.addInitScript((t) => localStorage.setItem('tb_token', t), claimed.token);
  const phone = await phoneCtx.newPage();
  const phoneFails = [];
  phone.on('pageerror', (e) => phoneFails.push(e.message));
  await phone.goto(`${app.url}/#/m/channels`);
  await phone.locator('[data-testid="bot-addresses"]').first().waitFor({ timeout: 10000 });
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) fail(`telefoon: de pagina schuift ${overflow}px opzij`);
  await axeOn(phone, '[data-testid="bot-addresses"]', 'telefoon');
  if (phoneFails.length) fail(`telefoon: ${phoneFails.join('; ')}`);
  step('gekoppelde telefoon: de adressen per bot op Kanalen, niets schuift opzij, axe schoon');
  if (errors.length) fail(`paginafouten: ${errors.join(' | ')}`);
} catch (e) {
  fail(String(e?.stack || e));
} finally {
  await browser.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
if (!process.exitCode) step('klaar: alles geslaagd');
