// "Kosten vooraf" as the owner uses it (TeamBot 0.4.4, P3): a heavy routine on an engine whose 5-hour window is almost
// full shows a cost estimate (money and the share of the window, labelled "schatting") in the routine editor and offers
// "Start na de reset om …"; clicking it plans one run after the reset. The same for an important task in the task
// window (the bot gets the task then, as a one-time routine). On a paired phone the estimate reads the same, without
// sideways scrolling. axe-core WCAG 2.2 A/AA on the estimate in light and dark.
// Edge/Chrome headless, temp data dir, a free port (TEAMBOT_E2E_PORT to fix one; never 4747/4748).
// Usage: npm run build:ui && node --import tsx tests/e2e/cost-estimate.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const { createApp } = await import('./server.mjs');
const { mockAdapter } = await import('../helpers.ts');

const step = (s) => console.log(`• ${s}`);
const fail = (s) => {
  console.error(`✗ ${s}`);
  process.exitCode = 1;
};
const port = Number(process.env.TEAMBOT_E2E_PORT) || 0;
if (port === 4747 || port === 4748) throw new Error('4747/4748 zijn van de geïnstalleerde TeamBot');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-e2e-cost-'));
const app = await createApp({ dataDir: dir, port, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();
const script = [];
app.ctx.providers.registerKind({ id: 'mock', label: 'Testmodel', type: 'api', billing: 'paid', needsKey: false, description: 'e2e', models: ['mock-1'], defaultModel: 'mock-1', create: () => mockAdapter(script, []) });
// Own prices (USD per 1M tokens): one run of 10 + 5 tokens costs $0.10.
const prov = app.ctx.providers.create(owner.id, { kind: 'mock', name: 'Testmodel', config: { prices: { '*': [6000, 8000] } } });
const bot = app.ctx.store.createAgent(owner.id, { name: 'Zwaar', role: 'Test', provider_id: prov.id, model: 'mock-1', access_mode: 'auto' });
const api = async (method, p, body, tok = token) => {
  const r = await fetch(`${app.url}/api${p}`, { method, headers: { authorization: `Bearer ${tok}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};
// Two earlier runs of the bot, then a 5-hour window at 95% (the engine's own report).
const th = app.ctx.chat.threadForAgent(owner.id, bot.id);
for (const text of ['een', 'twee']) {
  await api('POST', `/threads/${th.id}/messages`, { content: text });
  const end = Date.now() + 15_000;
  await new Promise((r) => setTimeout(r, 50));
  while (Date.now() < end && app.ctx.store.all("SELECT id FROM runs WHERE thread_id = ? AND status IN ('queued','running','waiting')", th.id).length) await new Promise((r) => setTimeout(r, 50));
}
const resetsAt = Date.now() + 2 * 3600_000;
app.ctx.services.usage.report(prov.id, { windows: [{ id: 'five_hour', label: 'Sessie (5 uur)', usedPercent: 95, resetsAt, level: 'warn', at: Date.now() }], source: 'stream', at: Date.now() });
const routine = await api('POST', '/routines', { name: 'Kwartaalrapport', agent_id: bot.id, prompt: 'maak het kwartaalrapport', schedule: { kind: 'none' }, options: { important: true } });
const task = await api('POST', '/rooms/tasks', { title: 'Jaarverslag', ownerType: 'agent', ownerId: bot.id, important: true });
step(`TeamBot op ${app.url}`);

async function axeOn(page, name) {
  await page.addScriptTag({ content: axeSource });
  const v = await page.evaluate(async () => {
    // @ts-ignore
    const r = await window.axe.run({ include: [['[data-testid="cost-estimate"]']] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
    return r.violations.map((x) => `${x.id}: ${x.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`);
  });
  if (v.length) fail(`a11y ${name}: ${v.join(' | ')}`);
}

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const errors = [];
try {
  for (const scheme of ['light', 'dark']) {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme, bypassCSP: true })).newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !/favicon|401 \(Unauthorized\)/.test(m.text()) && errors.push(m.text()));
    await page.goto(`${app.url}/#token=${token}`);
    await page.waitForTimeout(600);
    await page.goto(`${app.url}/#/m/routines/r/${routine.id}?tab=settings`);
    const est = page.locator('[data-testid="cost-estimate"]');
    await est.waitFor({ timeout: 10000 });
    const text = (await est.textContent()) || '';
    if (!/schatting/.test(text)) fail(`routine (${scheme}): het label "schatting" ontbreekt`);
    if (!/Kost ongeveer (US)?\$\s?0[.,]10 per keer/.test(text)) fail(`routine (${scheme}): geen bedrag per keer: ${text}`);
    if (!/van je venster “5 uur”, en er is nog 5\s?% over/.test(text)) fail(`routine (${scheme}): het deel van het 5-uursvenster staat er niet: ${text}`);
    await axeOn(page, `routine-editor (${scheme})`);
    if (scheme === 'light') {
      await est.getByRole('button', { name: /^Start na de reset/ }).click();
      await est.getByRole('status').getByText(/Ingepland/).waitFor({ timeout: 8000 });
      const rr = app.ctx.store.one("SELECT next_retry_at FROM routine_runs WHERE routine_id = ? AND status = 'retrying'", routine.id);
      if (!rr || Math.abs(Date.parse(rr.next_retry_at) - (resetsAt + 60_000)) > 2000) fail(`routine: geen run ingepland na de reset (${JSON.stringify(rr)})`);
      step('routine-editor: bedrag per keer en deel van het 5-uursvenster (schatting); "Start na de reset" plant één run om de reset + 1 minuut');

      await page.goto(`${app.url}/#/tasks`);
      await page.getByRole('article', { name: 'Jaarverslag' }).getByRole('button').first().click();
      const dlg = page.getByRole('dialog');
      const tEst = dlg.locator('[data-testid="cost-estimate"]');
      await tEst.waitFor({ timeout: 8000 });
      await axeOn(page, 'taakvenster');
      await tEst.getByRole('button', { name: /^Start na de reset/ }).click();
      await tEst.getByRole('status').getByText(/Ingepland/).waitFor({ timeout: 8000 });
      const r = (await api('GET', '/routines')).find((x) => x.name === 'Taak: Jaarverslag');
      if (!r || r.schedule?.kind !== 'once' || r.options?.important !== true || !r.prompt.includes(task.id)) fail(`taak: geen eenmalige routine voor de taak (${JSON.stringify(r)?.slice(0, 200)})`);
      step('taakvenster (Belangrijk): dezelfde schatting; "Start na de reset" maakt een eenmalige, belangrijke routine voor de bot');
    } else step('donker thema: de schatting is leesbaar (axe WCAG 2.2 AA)');
    await page.context().close();
  }

  // The paired phone: the same estimate in the routine editor, nothing sideways.
  const ticket = await api('POST', '/mobile/pair', { baseUrl: app.url });
  const secret = new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('t');
  const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TeamBotiOS/0.4.4';
  const claimed = await (await fetch(`${app.url}/api/public/mobile/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA }, body: JSON.stringify({ secret, name: 'iPhone', platform: 'ios', client: 'ios-app' }) })).json();
  const phoneCtx = await browser.newContext({ viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true, userAgent: UA, colorScheme: 'dark', bypassCSP: true });
  await phoneCtx.addInitScript((t) => localStorage.setItem('tb_token', t), claimed.token);
  const phone = await phoneCtx.newPage();
  const phoneFails = [];
  phone.on('pageerror', (e) => phoneFails.push(e.message));
  phone.on('response', (r) => r.url().includes('/api/usage/estimate') && r.status() >= 400 && phoneFails.push(`verzoek ${r.url()} → ${r.status()}`));
  await phone.goto(`${app.url}/#/m/routines/r/${routine.id}?tab=settings`);
  const pEst = phone.locator('[data-testid="cost-estimate"]');
  await pEst.waitFor({ timeout: 10000 });
  if (!/schatting/.test((await pEst.textContent()) || '')) fail('telefoon: het label "schatting" ontbreekt');
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) fail(`telefoon: de pagina schuift ${overflow}px opzij`);
  await axeOn(phone, 'telefoon');
  if (phoneFails.length) fail(`telefoon: ${phoneFails.join('; ')}`);
  step('gekoppelde telefoon: dezelfde schatting in de routine-editor, niets schuift opzij, axe schoon');
  if (errors.length) fail(`paginafouten: ${errors.join(' | ')}`);
} catch (e) {
  fail(String(e?.stack || e));
} finally {
  await browser.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
if (!process.exitCode) step('klaar: alles geslaagd');
