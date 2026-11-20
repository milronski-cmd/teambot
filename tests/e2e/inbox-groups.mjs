// "Wacht op jou" through the screen, in an empty data folder:
//   node --import tsx tests/e2e/inbox-groups.mjs
// Several requests of one bot for the same action are one block with a line per request; a line opens its own card,
// where it is decided; a single request keeps its own card. The requests are real ones, made with the broker.
// Needs `npm run build:ui` first.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const ROOT = path.resolve(process.env.TEAMBOT_E2E_DIR || '.data/inbox-groups-e2e');
const SHOTS = process.env.SHOTS_DIR || path.join(ROOT, 'shots');
const dir = path.join(ROOT, 'run');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
process.env.XDG_DOCUMENTS_DIR = path.join(ROOT, 'documents');
fs.mkdirSync(process.env.XDG_DOCUMENTS_DIR, { recursive: true });
process.env.TEAMBOT_TEST_NO_STARTER_RULES = '1';

const { createApp } = await import('./server.mjs');
const app = await createApp({ dataDir: dir, port: Number(process.env.PORT || 4796), host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const api = async (method, p, body) => {
  const res = await fetch(app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${j.error}`);
  return j;
};
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || 'msedge', headless: true });
try {
  const prov = await api('POST', '/providers', { kind: 'ollama', config: { baseUrl: 'http://127.0.0.1:11434' } });
  const post = await api('POST', '/agents', { name: 'Postvak', role: 'Mail', provider_id: prov.id, model: 'x' });
  const bo = await api('POST', '/agents', { name: 'Bo', role: 'Boekhouding', provider_id: prov.id, model: 'x' });
  const store = app.ctx.store;
  const owner = app.ctx.auth.owner();
  const ask = (agent, tool, summary) => {
    const ts = new Date().toISOString();
    store.insert('approvals', { id: `apr_${Math.random().toString(36).slice(2, 12)}`, user_id: owner.id, agent_id: agent.id, run_id: null, thread_id: null, kind: 'tool', tool, input: {}, summary, risk: 'danger', options: null, status: 'pending', answer: null, parked_at: ts, created_at: ts });
  };
  const people = ['de redactie van Bouwblad', 'Sanne van de installateur', 'de webwinkel in Zwolle', 'Jan van de dakdekker'];
  people.forEach((p, n) => ask(post, 'mcp_google_gmail_send', `Google · gmail_send: to: ${p} · subject: Re: Vermelding op de site (${n + 1}) · body: Hallo, dank voor je bericht. We nemen je vermelding graag op als …`));
  ask(bo, 'write_file', 'Schrijven: kwartaal.csv (120 tekens)');

  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  await page.goto(`${app.url}/#token=${token}`);
  await page.waitForTimeout(1500);
  await page.goto(`${app.url}/#/inbox`);
  await page.getByRole('group', { name: /4 verzoeken van Postvak/ }).waitFor({ timeout: 15000 });
  const group = page.getByRole('group', { name: /4 verzoeken van Postvak/ });
  const text = await group.innerText();
  check('vier mails van één bot staan in één blok', /Postvak wil 4 keer/.test(text));
  check('elke mail heeft zijn eigen regel met ontvanger en onderwerp', people.every((p) => text.includes(p)) && /Vermelding op de site \(4\)/.test(text));
  check('er is geen knop die alles tegelijk toestaat', !/alles toestaan|alle 4 toestaan/i.test(text) && (await group.getByRole('button', { name: /^(Toestaan|Eén keer|Eén keer toestaan)$/ }).count()) === 0);
  check('het losse verzoek van een andere bot houdt zijn eigen kaart', (await page.getByRole('group', { name: 'Goedkeuring nodig' }).count()) === 1);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, 'inbox-1-blok.png') });

  // A line opens its own card; deciding there takes that request away and leaves the others.
  await group.getByRole('button', { name: /Sanne van de installateur/ }).click();
  const card = group.getByRole('group', { name: 'Goedkeuring nodig' });
  await card.waitFor({ timeout: 10000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, 'inbox-2-regel-open.png') });
  await card.getByRole('button', { name: /Overslaan|Niet toestaan/ }).click();
  await page.getByRole('group', { name: /3 verzoeken van Postvak/ }).waitFor({ timeout: 10000 });
  const left = store.all("SELECT status FROM approvals WHERE agent_id = ? ORDER BY created_at, rowid", post.id).map((r) => r.status).sort();
  check('één regel beslist: de andere drie wachten nog', left.join(',') === 'denied,pending,pending,pending', left.join(','));
} catch (e) {
  check('de schermronde liep door', false, String(e?.message || e).split('\n')[0]);
} finally {
  await browser.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}
