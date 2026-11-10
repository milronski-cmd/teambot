// "Wacht op jou" in a real browser: a bot's note contradicts what the owner wrote himself, so memory asks one short
// question ("Wat klopt?"). The card shows the new and the old note; "Het nieuwe klopt" replaces the old one (history
// kept) and the card is gone. No failed requests or page errors.
// Usage: npm run build:ui && node --import tsx tests/e2e/memory-conflict-inbox.mjs   (TEAMBOT_E2E_BROWSER, TEAMBOT_E2E_PORT)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

let failed = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? '✔' : '✖'} ${name}${detail && !cond ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-mem-inbox-home-'));
Object.assign(process.env, { APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') });
delete process.env.TEAMBOT_DATA;
const { createApp } = await import('../../server/app.ts');
const { mockAdapter } = await import('../helpers.ts');
const { writeCandidate } = await import('../../server/modules/memory/pipeline.ts');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-mem-inbox-'));
const app = await createApp({ dataDir: dir, port: Number(process.env.TEAMBOT_E2E_PORT) || 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const u = app.ctx.auth.owner().id;
app.ctx.providers.registerKind({ id: 'mock', label: 'Testmodel', type: 'api', group: 'local', billing: 'local', needsKey: false, description: 'e2e', models: ['mock-1'], defaultModel: 'mock-1', create: () => mockAdapter([], []) });
const call = async (method, p, body) => {
  const r = await fetch(app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status}: ${j.error}`);
  return j;
};
const prov = await call('POST', '/providers', { kind: 'mock' });
const bot = await call('POST', '/agents', { name: 'Mila', provider_id: prov.id, model: 'mock-1', access_mode: 'ask', tool_groups: ['memory'] });
const svc = app.ctx.services.memory.svc;
const OLD = 'De webshop gebruikt het thema Dawn';
const NEW = 'De webshop gebruikt het thema Sense';
writeCandidate(svc, { userId: u, content: OLD, scope: 'agent', agentId: bot.id, key: 'thema webshop', source: { kind: 'user', trust: 'user' }, origin: 'user_ui', createdBy: 'user' });
const c = writeCandidate(svc, { userId: u, content: NEW, scope: 'agent', agentId: bot.id, key: 'thema webshop', source: { kind: 'tool', ref: 'run', trust: 'agent' }, origin: 'tool', createdBy: 'agent', createdByAgent: bot.id });
ok('the bot’s note against the owner’s own words is a question, not an overwrite', c.action === 'conflict');

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'nl-NL', bypassCSP: true });
  await ctx.addInitScript(([t]) => {
    if (!sessionStorage.getItem('tb_init')) {
      sessionStorage.setItem('tb_init', '1');
      localStorage.setItem('tb_token', t);
      localStorage.setItem('tb_lang', 'nl');
    }
  }, [token]);
  const page = await ctx.newPage();
  const errors = [];
  const bad = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text()) && errors.push(m.text()));
  page.on('response', (r) => {
    const p = new URL(r.url());
    if (p.pathname.startsWith('/api/') && r.status() >= 400) bad.push(`${r.status()} ${r.request().method()} ${p.pathname}`);
  });
  await page.goto(`${app.url}/#/inbox`);
  const card = page.getByRole('group', { name: 'Wat klopt?' });
  await card.waitFor({ timeout: 20000 });
  ok('the card is under "Wacht op jou"', (await card.count()) === 1);
  ok('it shows the new note', (await card.getByText(NEW).count()) === 1);
  ok('and the note that was there', (await card.getByText(OLD).count()) === 1);
  ok('the section has its heading with the count', (await page.locator('#inbox-memory').innerText()).includes('1'));
  if (process.env.TEAMBOT_E2E_SHOT) await page.screenshot({ path: process.env.TEAMBOT_E2E_SHOT });
  await card.getByRole('button', { name: 'Het nieuwe klopt' }).click();
  await card.waitFor({ state: 'detached', timeout: 10000 });
  ok('after the answer the card is gone', (await page.getByRole('group', { name: 'Wat klopt?' }).count()) === 0);
  const rows = app.ctx.store.all("SELECT content, status FROM memory_items WHERE agent_id = ? ORDER BY created_at", bot.id);
  ok('the new note holds, the old one is history', rows.find((r) => r.content === NEW)?.status === 'active' && rows.find((r) => r.content === OLD)?.status === 'superseded', JSON.stringify(rows));
  ok('no page errors', !errors.length, errors.join(' | '));
  ok('no failed requests', !bad.length, bad.join(' | '));
  await ctx.close();
} finally {
  await browser.close();
  await app.close();
}
console.log(failed ? `\n${failed} mislukt` : '\nalles goed');
process.exit(failed ? 1 : 0);
