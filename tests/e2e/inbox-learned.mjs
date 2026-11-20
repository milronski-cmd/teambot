// "Wacht op jou › Geleerd" through the screen, in an empty data folder:
//   node --import tsx tests/e2e/inbox-learned.mjs
// Per bot what it asked and what the owner answered; he corrects an answer and lets one be forgotten.
// Needs `npm run build:ui` first.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const ROOT = path.resolve(process.env.TEAMBOT_E2E_DIR || '.data/inbox-learned-e2e');
const SHOTS = process.env.SHOTS_DIR || path.join(ROOT, 'shots');
const dir = path.join(ROOT, 'run');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
process.env.XDG_DOCUMENTS_DIR = path.join(ROOT, 'documents');
fs.mkdirSync(process.env.XDG_DOCUMENTS_DIR, { recursive: true });
process.env.TEAMBOT_TEST_NO_STARTER_RULES = '1';

const { createApp } = await import('./server.mjs');
const app = await createApp({ dataDir: dir, port: Number(process.env.PORT || 4797), host: '127.0.0.1', mode: 'desktop', quiet: true });
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
  const kim = await api('POST', '/agents', { name: 'Kim', role: 'Klantenservice', provider_id: prov.id, model: 'x' });
  const bo = await api('POST', '/agents', { name: 'Bo', role: 'Boekhouding', provider_id: prov.id, model: 'x' });
  const store = app.ctx.store;
  const owner = app.ctx.auth.owner();
  let n = 0;
  const row = (agent, question, o = {}) => {
    const ts = new Date(Date.now() - (10 - n++) * 60_000).toISOString();
    store.insert('approvals', { id: `apr_${Math.random().toString(36).slice(2, 12)}`, user_id: owner.id, agent_id: agent.id, run_id: null, thread_id: null, kind: 'question', tool: 'ask_user', input: { question }, summary: question, risk: 'read', options: null, status: 'approved', answer: null, decided_at: ts, created_at: ts, ...o });
  };
  row(kim, 'Mag een klant retourneren na 30 dagen als de verpakking nog dicht is?', { answer: 'Ja, tot 60 dagen als de verpakking dicht is.' });
  row(kim, 'Welke toon gebruik ik bij een klacht over een late levering?', { answer: 'Eerst excuses, dan de nieuwe leverdatum. Geen korting aanbieden zonder mij.' });
  row(kim, 'Mag ik een vervangend product sturen zonder dat het oude terug is?', { status: 'pending', decided_at: null });
  row(bo, 'Op welke dag boek ik de btw-aangifte in?', { answer: 'Altijd de 20e van de maand.' });

  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  await page.goto(`${app.url}/#token=${token}`);
  await page.waitForTimeout(1500);
  await page.goto(`${app.url}/#/inbox`);
  await page.getByRole('radio', { name: 'Geleerd' }).or(page.getByRole('button', { name: 'Geleerd' })).or(page.getByRole('tab', { name: 'Geleerd' })).first().click();
  const ofKim = page.getByRole('group', { name: 'Wat Kim van je leerde' });
  await ofKim.waitFor({ timeout: 15000 });
  const text = await ofKim.innerText();
  check('per bot staat wat hij vroeg en wat jij antwoordde', /retourneren na 30 dagen/.test(text) && /tot 60 dagen/.test(text) && /Geen korting aanbieden/.test(text));
  check('de regel telt antwoorden en wat nog op je wacht', /2 antwoorden onthouden/.test(text) && /1 vraag wacht op jou/.test(text), text.split('\n').slice(0, 3).join(' | '));
  check('een andere bot heeft zijn eigen blok', (await page.getByRole('group', { name: 'Wat Bo van je leerde' }).innerText()).includes('20e van de maand'));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, 'geleerd-1.png') });

  // Correct an answer: the stored answer is the new one.
  const item = ofKim.getByRole('listitem').filter({ hasText: 'retourneren na 30 dagen' });
  await item.getByRole('button', { name: 'Verbeteren' }).click();
  await item.getByRole('textbox').fill('Ja, tot 90 dagen.');
  await page.screenshot({ path: path.join(SHOTS, 'geleerd-2-verbeteren.png') });
  await item.getByRole('button', { name: 'Opslaan' }).click();
  await ofKim.getByText('Ja, tot 90 dagen.').waitFor({ timeout: 10000 });
  const stored = store.one("SELECT answer FROM approvals WHERE summary LIKE 'Mag een klant retourneren%'");
  check('verbeteren slaat het nieuwe antwoord op', stored.answer === 'Ja, tot 90 dagen.', stored.answer);

  // Forget one: it leaves the list and no longer counts.
  await ofKim.getByRole('listitem').filter({ hasText: 'late levering' }).getByRole('button', { name: 'Vergeten' }).click();
  await ofKim.getByText('1 antwoord onthouden').waitFor({ timeout: 10000 });
  const gone = store.one("SELECT forgotten_at FROM approvals WHERE summary LIKE 'Welke toon%'");
  check('vergeten haalt het antwoord uit de lijst', !!gone.forgotten_at && !(await ofKim.innerText()).includes('late levering'));
  await page.screenshot({ path: path.join(SHOTS, 'geleerd-3.png') });

  // Phone width: nothing runs off the screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('op telefoonbreedte schuift niets opzij', wide <= 1, `overschot ${wide}px`);
  await page.screenshot({ path: path.join(SHOTS, 'geleerd-4-telefoon.png') });
} catch (e) {
  check('de schermronde liep door', false, String(e?.message || e).split('\n')[0]);
} finally {
  await browser.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}
