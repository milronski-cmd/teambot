// Mappen voor chats (PARITEIT 4.2, TeamBot 0.4.4) as the owner uses them on the computer: "Verplaats naar map…" in a
// chat's menu with a new folder, dragging a second chat onto the folder, closing the folder (still closed after a
// reload), dragging a chat back out onto the list, renaming and deleting the folder (the chats stay), and a folder
// showing only in its own team. axe-core WCAG 2.2 A/AA on the list with a folder.
// Edge/Chrome headless, temp data dir, a free port (TEAMBOT_E2E_PORT to fix one; never 4747/4748).
// Usage: npm run build:ui && node --import tsx tests/e2e/chat-folders.mjs   (TEAMBOT_E2E_SHOTS=<dir> for screenshots)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const step = (s) => console.log(`• ${s}`);
const fail = (s) => {
  console.error(`✗ ${s}`);
  process.exitCode = 1;
};
const port = Number(process.env.TEAMBOT_E2E_PORT) || 0;
if (port === 4747 || port === 4748) throw new Error('4747/4748 zijn van de geïnstalleerde TeamBot');
const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-e2e-chatfolders-'));
const { createApp } = await import('../../server/app.ts');
const { mockAdapter } = await import('../helpers.ts');
const app = await createApp({ dataDir: dir, port, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();
app.ctx.providers.registerKind({ id: 'mock', label: 'Testmodel', type: 'api', billing: 'local', needsKey: false, description: 'e2e', models: ['mock-1'], defaultModel: 'mock-1', create: () => mockAdapter([], []) });
const call = async (method, p, body) => {
  const r = await fetch(`${app.url}/api${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};
const prov = await call('POST', '/providers', { kind: 'mock', name: 'Testmodel' });
const bots = {};
for (const name of ['Ada', 'Bas', 'Cor']) bots[name] = await call('POST', '/agents', { name, role: 'Test', provider_id: prov.id, model: 'mock-1', access_mode: 'auto' });
const threadOf = (name) => app.ctx.chat.threadForAgent(owner.id, bots[name].id);
const SHOTS = process.env.TEAMBOT_E2E_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const folders = async () => (await call('GET', '/chat-folders')).folders;
step(`TeamBot op ${app.url}`);

const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'nl-NL', bypassCSP: true })).newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/favicon|401 \(Unauthorized\)/.test(m.text()) && errors.push(m.text()));
  page.on('dialog', (d) => (errors.push(`browserdialoog: ${d.message()}`), d.dismiss().catch(() => {})));
  await page.goto(`${app.url}/#token=${token}`);
  await page.waitForTimeout(600);
  const side = page.locator('aside').first();
  const row = (name) => side.getByRole('link', { name: new RegExp(`^${name}\\b`) }).first();
  const folder = (name) => side.getByRole('group', { name: `Map ${name}` });
  const toggleOf = (name) => folder(name).locator('button[aria-controls]');

  // 1. "Verplaats naar map…" in Ada's chat: a new folder, Ada in it.
  await page.goto(`${app.url}/#/t/${threadOf('Ada').id}`);
  await page.getByRole('button', { name: 'Meer opties' }).click();
  await page.getByRole('button', { name: 'Meer acties', exact: true }).click();
  await page.getByRole('button', { name: 'Verplaats naar map…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Ada verplaatsen naar een map' });
  await dlg.waitFor({ timeout: 8000 });
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'verplaats-naar-map.png') });
  await dlg.getByText('Nog geen mappen in dit team.', { exact: false }).waitFor({ timeout: 5000 });
  await dlg.getByLabel('Nieuwe map', { exact: true }).fill('Klanten');
  await dlg.getByRole('button', { name: 'Maken' }).click();
  await folder('Klanten').waitFor({ timeout: 8000 });
  await folder('Klanten').getByRole('link', { name: /^Ada\b/ }).waitFor({ timeout: 5000 });
  let f = await folders();
  if (f.length !== 1 || f[0].items.length !== 1 || f[0].items[0].id !== bots.Ada.id) fail(`na Verplaats naar map: ${JSON.stringify(f)}`);
  step('chatmenu › Verplaats naar map… › nieuwe map “Klanten”: Ada staat in de map in de lijst');

  // axe on the list with a folder (light theme, desktop).
  await page.addScriptTag({ content: axeSource });
  const v = await page.evaluate(async () => {
    // @ts-ignore
    const r = await window.axe.run(document.querySelector('aside'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
    return r.violations.map((x) => `${x.id}: ${x.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`);
  });
  if (v.length) fail(`a11y zijbalk met map: ${v.join(' | ')}`);

  // 2. Drag Bas onto the folder.
  await row('Bas').dragTo(toggleOf('Klanten'));
  await folder('Klanten').getByRole('link', { name: /^Bas\b/ }).waitFor({ timeout: 5000 }).catch(() => fail('slepen: Bas staat niet in de map'));
  f = await folders();
  if (f[0]?.items.length !== 2) fail(`na slepen: ${JSON.stringify(f)}`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'chat-mappen.png') });
  step('Bas naar de map gesleept: de map heeft twee chats (ook op de server)');

  // 3. Close the folder: remembered after a reload.
  const toggle = toggleOf('Klanten');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') fail('de map staat niet open');
  await toggle.click();
  await page.waitForTimeout(300);
  if (await folder('Klanten').getByRole('link', { name: /^Ada\b/ }).count()) fail('dichte map toont nog Ada');
  await page.reload();
  await folder('Klanten').waitFor({ timeout: 8000 });
  if ((await toggleOf('Klanten').getAttribute('aria-expanded')) !== 'false') fail('na herladen staat de map weer open');
  if (await side.getByRole('link', { name: /^Ada\b/ }).count()) fail('na herladen: Ada staat zichtbaar terwijl de map dicht is');
  await toggleOf('Klanten').click();
  await folder('Klanten').getByRole('link', { name: /^Ada\b/ }).waitFor({ timeout: 5000 });
  step('map dichtgeklapt: blijft dicht na herladen (onthouden op de server), weer opengeklapt');

  // 4. Drag Bas back out onto the list.
  await folder('Klanten').getByRole('link', { name: /^Bas\b/ }).dragTo(row('Cor'));
  await page.waitForTimeout(400);
  f = await folders();
  if (f[0]?.items.length !== 1) fail(`uit de map slepen: ${JSON.stringify(f)}`);
  if (await folder('Klanten').getByRole('link', { name: /^Bas\b/ }).count()) fail('Bas staat nog in de map');
  step('Bas uit de map terug naar de lijst gesleept');

  // 5. Rename and the team view.
  await folder('Klanten').getByRole('button', { name: 'Opties voor de map Klanten' }).click();
  await page.getByRole('menuitem', { name: 'Naam wijzigen…' }).click();
  const ren = page.getByRole('dialog', { name: 'Naam van de map' });
  await ren.getByLabel('Naam van de map').fill('Vaste klanten');
  await ren.getByRole('button', { name: 'Opslaan' }).click();
  await folder('Vaste klanten').waitFor({ timeout: 5000 });
  const sales = await call('POST', '/teams', { name: 'Verkoop' });
  await page.evaluate((id) => localStorage.setItem('tb.team', id), sales.id);
  await page.reload();
  await page.waitForTimeout(1200);
  if (await folder('Vaste klanten').count()) fail('team Verkoop gekozen: de map van Mijn team staat in de lijst');
  // With several teams "Alle teams" lists the bots per team, without folders (a folder belongs to one team): choose
  // the folder's own team again.
  const homeTeam = (await folders())[0].teamId;
  await page.evaluate((id) => localStorage.setItem('tb.team', id), homeTeam);
  await page.reload();
  await folder('Vaste klanten').waitFor({ timeout: 8000 });
  step('naam gewijzigd in “Vaste klanten”; met team Verkoop gekozen staat de map niet in de lijst');

  // 6. Delete: the chats stay.
  await folder('Vaste klanten').getByRole('button', { name: 'Opties voor de map Vaste klanten' }).click();
  await page.getByRole('menuitem', { name: 'Map verwijderen…' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Map verwijderen' }).click();
  await page.waitForTimeout(500);
  if (await folder('Vaste klanten').count()) fail('de map staat er nog');
  if (!(await row('Ada').count())) fail('na verwijderen van de map: Ada staat niet meer in de lijst');
  if ((await folders()).length) fail('de map bestaat nog op de server');
  if (!app.ctx.store.agent(bots.Ada.id)) fail('Ada is weg');
  step('map verwijderd: Ada staat weer gewoon in de lijst, er is niets gewist');
  if (errors.length) fail(`paginafouten: ${errors.join(' | ')}`);
} catch (e) {
  fail(String(e?.stack || e));
} finally {
  await browser.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
if (!process.exitCode) step('klaar: alles geslaagd');
