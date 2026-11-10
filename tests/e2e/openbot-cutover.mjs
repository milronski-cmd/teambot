// End-to-end: Instellingen › Algemeen › Overstappen (switching over from OpenBot, step by step) in the real UI.
// A synthetic OpenBot (made-up data, built at test time) on a free port, Edge/Chrome headless: the six steps with
// their status, OpenBot looked at (read-only), import with channels and routines paused (nothing connects), the
// bots ticked off as checked, the routines on once OpenBot no longer runs them, axe (WCAG A/AA) in light and dark,
// no horizontal scroll at 360 px, no console errors.
// Usage: npm run build:ui && npm run cutover:check   (TEAMBOT_E2E_BROWSER=chrome|msedge, default msedge on Windows)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const { makeOpenBotTeamFixture } = await import('../fixtures/openbot-team-fixture.ts');
const { DatabaseSync } = await import('node:sqlite');

const step = (s) => console.log(`• ${s}`);
const fail = (s) => {
  console.error(`✗ ${s}`);
  process.exitCode = 1;
};

// ---- a synthetic OpenBot with a Telegram channel (owner's bot) and a run marker that says "stopped" ----
const fx = makeOpenBotTeamFixture({ workspaceName: 'Testteam' });
{
  const db = new DatabaseSync(path.join(fx.dataDir, 'openbot.db'));
  db.prepare('UPDATE projection_messaging_connections SET orchestrator_agent_id = ? WHERE connection_id = ?').run(fx.team.baas, 'c1');
  db.close();
  fs.writeFileSync(path.join(fx.dataDir, 'openbot-run-marker-v1.json'), JSON.stringify({ version: 1, appVersion: 'test', heartbeatAt: Date.now() - 3_600_000, state: 'stopped' }));
}
process.env.TEAMBOT_OPENBOT_DIR = fx.dataDir;
process.env.TEAMBOT_OPENBOT_HOME = fx.home;
const before = fx.hashes();

const { createApp } = await import('../../server/app.ts');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-e2e-cutover-'));
const app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const api = async (method, p, body) => {
  const res = await fetch(app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${j.error}`);
  return j;
};
step(`TeamBot op ${app.url}, OpenBot (nagemaakt) in ${fx.root}`);

const axe = async (page, label) => {
  await page.addScriptTag({ content: axeSource });
  const v = await page.evaluate(async () => {
    // @ts-ignore
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
    return r.violations.map((x) => `${x.id} (${x.impact}): ${x.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(', ')}`);
  });
  if (v.length) fail(`a11y ${label}: ${v.join(' | ')}`);
  else step(`a11y schoon: ${label}`);
};

const stepCard = (page, n) => page.locator(`li[aria-label^="Stap ${n}:"]`);
const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, bypassCSP: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED/.test(m.text()) && errors.push(m.text()));
  await page.goto(`${app.url}/#token=${token}`);
  await page.waitForTimeout(600);
  await page.evaluate(() => (location.hash = '#/settings/openbot-import-overstappen'));
  await page.getByText('Overstappen van OpenBot, stap voor stap').waitFor({ timeout: 15000 });
  await page.locator('li[aria-label^="Stap "]').first().waitFor({ timeout: 10000 });
  const n = await page.locator('li[aria-label^="Stap "]').count();
  if (n !== 6) fail(`6 stappen verwacht, ${n} gezien`);
  else step('zes stappen: back-up, importeren, naast elkaar, kanalen, routines, terug');
  if (!(await stepCard(page, 1).getByText('Nu', { exact: true }).count())) fail('stap 1 (back-up) hoort "Nu" te zijn');
  if (!(await stepCard(page, 2).getByText('Later', { exact: true }).count())) fail('stap 2 (importeren) hoort "Later" te zijn vóór de back-up');
  await axe(page, 'Overstappen, voor de import (licht)');

  // Step 1: a TeamBot backup (TeamBot sees it itself), then the owner confirms the OpenBot backup (TeamBot cannot see it).
  if (!(await stepCard(page, 1).getByText('TeamBot: nog geen back-up.').count())) fail('stap 1 hoort te zeggen dat er nog geen TeamBot-back-up is');
  await app.ctx.services.backups.make({ kind: 'manual' });
  await stepCard(page, 1).getByRole('checkbox', { name: 'Ik heb OpenBot geback-upt' }).click();
  await stepCard(page, 2).getByText('Nu', { exact: true }).waitFor({ timeout: 5000 });
  if (!(await stepCard(page, 1).getByText(/TeamBot: laatste back-up/).count())) fail('stap 1 hoort de nieuwe TeamBot-back-up te tonen');
  step('OpenBot-back-up afgevinkt: importeren is nu aan de beurt');

  // Step 2: import as proposed (channels and routines paused), the way the import page sends it.
  const plan = await api('POST', '/openbot-import/preview');
  await api('POST', '/openbot-import/commit', {
    stagingId: plan.stagingId,
    team: plan.team.choice,
    mainBot: plan.roles.main,
    lead: plan.roles.lead,
    specialists: Object.fromEntries(plan.roles.specialists.map((s) => [s.key, { selected: s.selected, field: s.field, sources: s.sources }])),
    bots: Object.fromEntries(plan.bots.map((b) => [b.key, { selected: b.selected, workspace: b.workspace.default }])),
    routines: plan.routines.filter((r) => r.selected).map((r) => r.key),
    channels: (plan.channels || []).filter((c) => c.selected).map((c) => c.key),
    skills: plan.skills.filter((s) => s.selected).map((s) => s.key),
    memories: 'active',
    shared: plan.shared.selected,
    teamData: !!plan.teamData?.selected,
  });
  const live = app.ctx.services.channels.manager.allEnabled().length;
  if (live) fail(`${live} kanalen staan aan na de import (moet 0 zijn)`);
  const notPaused = app.ctx.store.all("SELECT id FROM routines WHERE status != 'paused'").length;
  if (notPaused) fail(`${notPaused} routines staan aan na de import (moet 0 zijn)`);
  else step('import: kanalen en routines op pauze, niets verbonden');

  await page.reload();
  await page.getByText('Overstappen van OpenBot, stap voor stap').waitFor({ timeout: 15000 });
  await stepCard(page, 2).getByText('Klaar', { exact: true }).waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'OpenBot bekijken' }).click();
  await page.getByText(/OpenBot draait niet/).waitFor({ timeout: 10000 });
  step('OpenBot bekeken (alleen lezen): draait niet');
  const tg = stepCard(page, 4).locator('li', { hasText: 'Telegram' });
  if (!(await tg.getByText('Nog in OpenBot').count())) fail('het Telegram-kanaal hoort "Nog in OpenBot" te tonen');
  else step('kanaal Telegram: nog in OpenBot, in TeamBot uit');

  // Step 3: the bots checked.
  await stepCard(page, 3).getByRole('checkbox', { name: 'Mijn bots werken goed in TeamBot' }).click();
  await stepCard(page, 3).getByText('Klaar', { exact: true }).waitFor({ timeout: 5000 });
  step('naast elkaar gecontroleerd afgevinkt');

  // Step 5: routines on (OpenBot does not run): the ones that were on in OpenBot, never the customer routine.
  await stepCard(page, 5).getByRole('button', { name: 'Zet de routines aan' }).click();
  await stepCard(page, 5).getByRole('status').waitFor({ timeout: 10000 });
  const on = app.ctx.store.all("SELECT name FROM routines WHERE status = 'active'").map((r) => r.name);
  if (!on.includes('Dagoverzicht')) fail('Dagoverzicht hoort aan te staan');
  if (on.includes('Inbox-ronde') || on.includes('Avondcontrole')) fail('klantenservice of een routine die in OpenBot uit stond, staat aan');
  else step(`routines aangezet: ${on.length} (klantenservice blijft uit)`);
  if (app.ctx.services.channels.manager.allEnabled().length) fail('een kanaal staat aan zonder dat de eigenaar het overzette');
  await axe(page, 'Overstappen, na de import (licht)');

  // Dark theme and phone width.
  const dark = await browser.newContext({ viewport: { width: 360, height: 780 }, colorScheme: "dark", bypassCSP: true });
  const p2 = await dark.newPage();
  p2.on('pageerror', (e) => errors.push(e.message));
  await p2.goto(`${app.url}/#token=${token}`);
  await p2.waitForTimeout(600);
  await p2.evaluate(() => (location.hash = '#/settings/openbot-import-overstappen'));
  await p2.locator('li[aria-label^="Stap "]').first().waitFor({ timeout: 15000 });
  await axe(p2, 'Overstappen (donker, 360 px)');
  const wide = await p2.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (wide > 1) fail(`360 px: de pagina scrolt ${wide}px horizontaal`);
  else step('360 px: geen horizontaal scrollen');
  await dark.close();

  if (errors.length) fail('console-fouten: ' + errors.slice(0, 3).join(' | '));
  const after = fx.hashes();
  if (JSON.stringify(after) !== JSON.stringify(before)) fail('OpenBot-bestanden zijn veranderd');
  else step('OpenBot byte-identiek');
} catch (e) {
  fail(e?.stack || String(e));
} finally {
  await browser.close();
  await app.close();
  for (const f of [() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }), () => fx.cleanup()]) {
    try {
      f();
    } catch {
      /* a temp folder Windows still holds: left for the OS to clean */
    }
  }
}
if (!process.exitCode) step('Overstappen: alles in orde');
