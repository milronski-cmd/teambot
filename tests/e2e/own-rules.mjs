// Own rules in plain words (package P6) in a real browser on the computer: the bot editor › Wat mag de bot? shows
// "Eigen regels"; the owner types "Mail nooit naar klanten zonder mij te vragen", sees what TeamBot makes of it before
// saving, adds it, adds "Mag altijd bestanden maken in de map Offertes" (a looser rule, computer only), sees the team's
// rules under the bot, and removes a rule. The Broker then really asks/refuses (checked on the server). axe-core (WCAG
// 2.x AA) in light and dark, no failed requests or page errors, no sideways scrolling at 360 px.
// The phone side (stricter rules yes, looser rules "op je computer") is a step of tests/e2e/phone-owner.mjs.
// Usage: npm run build:ui && node --import tsx tests/e2e/own-rules.mjs   (TEAMBOT_E2E_BROWSER=chrome|msedge, TEAMBOT_E2E_PORT)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

let failed = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? '✔' : '✖'} ${name}${detail && !cond ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-own-rules-home-'));
Object.assign(process.env, { APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') });
delete process.env.TEAMBOT_DATA;
const { createApp } = await import('../../server/app.ts');
const { mockAdapter } = await import('../helpers.ts');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-own-rules-'));
const app = await createApp({ dataDir: dir, port: Number(process.env.TEAMBOT_E2E_PORT) || 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();
app.ctx.providers.registerKind({ id: 'mock', label: 'Testmodel', type: 'api', group: 'local', billing: 'local', needsKey: false, description: 'e2e', models: ['mock-1'], defaultModel: 'mock-1', create: () => mockAdapter([], []) });
const call = async (method, p, body) => {
  const r = await fetch(app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status}: ${j.error}`);
  return j;
};
const prov = await call('POST', '/providers', { kind: 'mock' });
const bot = await call('POST', '/agents', { name: 'Mila', provider_id: prov.id, model: 'mock-1', access_mode: 'ask', tool_groups: ['files'] });
const teamId = app.ctx.services.teams.teamOf(bot.id);
await call('POST', '/bot-rules', { teamId, text: 'Verwijder nooit bestanden' });

const axe = async (page, what) => {
  await page.addScriptTag({ content: axeSource });
  const v = await page.evaluate(async () => {
    // @ts-ignore
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
    return r.violations.map((x) => `${x.id}: ${x.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`);
  });
  ok(`a11y ${what}`, !v.length, v.join(' | '));
};

try {
  for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'nl-NL', bypassCSP: true });
    await ctx.addInitScript(([t, th]) => {
      if (!sessionStorage.getItem('tb_init')) {
        sessionStorage.setItem('tb_init', '1');
        localStorage.setItem('tb_token', t);
        localStorage.setItem('tb_lang', 'nl');
        localStorage.setItem('tb_theme', th);
      }
    }, [token, theme]);
    const page = await ctx.newPage();
    const errors = [];
    const bad = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text()) && errors.push(m.text()));
    page.on('dialog', (d) => (errors.push(`browserdialoog: ${d.message()}`), d.dismiss().catch(() => {})));
    page.on('response', (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith('/api/') && r.status() >= 400) bad.push(`${r.status()} ${r.request().method()} ${u.pathname}`);
    });
    // "Wat mag de bot?" is on the tab Meer of the bot page; Eigen regels sits behind its "Meer opties".
    const openRules = async () => {
      await page.getByRole('tab', { name: /^Meer/ }).click();
      await page.locator('h2', { hasText: 'Wat mag de bot?' }).locator('xpath=..').locator('details > summary').first().click();
    };
    await page.goto(`${app.url}/#/agents/${bot.id}`);
    await openRules();
    const rules = page.getByTestId('own-rules');
    await rules.waitFor({ timeout: 20000 });
    ok(`${theme}: Eigen regels staat onder Wat mag de bot?`, (await page.locator('h2', { hasText: 'Wat mag de bot?' }).locator('xpath=..').getByTestId('own-rules').count()) === 1);
    ok(`${theme}: de teamregel staat er, alleen-lezen`, (await rules.getByTestId('own-rule').filter({ hasText: 'Verwijder nooit bestanden' }).count()) === 1 && (await rules.getByText('Ook deze regels gelden, van team', { exact: false }).count()) === 1);

    if (theme === 'light') {
      ok('zonder eigen regels: voorbeelden om te kiezen', (await rules.getByRole('group', { name: 'Voorbeelden' }).getByRole('button').count()) === 3);
      await rules.getByRole('button', { name: 'Mail nooit naar klanten zonder mij te vragen' }).click();
      const input = rules.getByRole('textbox', { name: 'Nieuwe regel' });
      ok('een voorbeeld vult het veld', (await input.inputValue()) === 'Mail nooit naar klanten zonder mij te vragen');
      const pv = rules.getByTestId('rule-preview');
      await pv.getByText('Zo legt TeamBot het vast', { exact: false }).waitFor({ timeout: 8000 });
      const pvText = await pv.innerText();
      ok('voorbeeld vóór opslaan: eerst vragen, versturen, e-mail, alleen naar anderen', /Eerst vragen/.test(pvText) && /versturen/.test(pvText) && /e-mail/.test(pvText) && /anderen dan jou/.test(pvText), pvText);
      await rules.getByRole('button', { name: 'Toevoegen' }).click();
      await rules.getByTestId('own-rule').filter({ hasText: 'Mail nooit naar klanten' }).waitFor({ timeout: 8000 });
      // a looser rule (computer only), typed
      await input.fill('Mag altijd bestanden maken in de map Offertes');
      await pv.getByText('Mag zonder vragen').waitFor({ timeout: 8000 });
      await input.press('Enter');
      await rules.getByTestId('own-rule').filter({ hasText: 'map Offertes' }).waitFor({ timeout: 8000 });
      // an unclear one says why
      await input.fill('Offertes');
      await pv.getByText('Ik zie niet wat de bot moet doen', { exact: false }).waitFor({ timeout: 8000 });
      ok('onduidelijke regel: Toevoegen staat uit', await rules.getByRole('button', { name: 'Toevoegen' }).isDisabled());
      await input.fill('');
      // enforced on the server, not only in the prompt
      const a = app.ctx.store.agent(bot.id);
      ok('de Broker laat schrijven in Offertes toe zonder vragen', app.ctx.broker.decide(a, { name: 'write_file', risk: 'write' }, { path: 'Offertes/klant.md' }) === 'allow');
      ok('… en vraagt elders nog steeds', app.ctx.broker.decide(a, { name: 'write_file', risk: 'write' }, { path: 'Facturen/f.md' }) === 'ask');
      ok('de teamregel weigert verwijderen', app.ctx.broker.decide({ ...a, access_mode: 'full' }, { name: 'delete_file', risk: 'danger', impact: 'local' }, { path: 'x.txt' }) === 'deny');
      await axe(page, 'bot-editor met regels (licht)');
      // remove the looser rule again
      const row = rules.getByTestId('own-rule').filter({ hasText: 'map Offertes' });
      await row.getByRole('button', { name: /Regel weghalen/ }).click();
      await row.waitFor({ state: 'detached', timeout: 8000 });
      ok('regel weghalen werkt', !app.ctx.store.all("SELECT id FROM bot_rules WHERE text LIKE '%Offertes%'").length);

      // the team page: the same card for every bot of the team
      await page.goto(`${app.url}/#/m/teams/${teamId}`);
      await page.getByTestId('team-fold-rules').locator('summary').click({ timeout: 15000 });
      const teamRules = page.getByTestId('own-rules');
      await teamRules.waitFor({ timeout: 15000 });
      ok('teampagina: Regels voor alle bots van dit team', (await teamRules.getByText('Regels voor alle bots van dit team').count()) === 1 && (await teamRules.getByTestId('own-rule').filter({ hasText: 'Verwijder nooit bestanden' }).count()) === 1);
      await axe(page, 'teampagina met regels (licht)');

      // a phone-wide window: no sideways scrolling
      await page.setViewportSize({ width: 360, height: 800 });
      await page.goto(`${app.url}/#/agents/${bot.id}`);
      await openRules();
      await page.getByTestId('own-rules').waitFor({ timeout: 15000 });
      await page.waitForTimeout(400);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      ok('360 px: niet opzij schuiven', over <= 1, `${over}px`);
    } else {
      await rules.getByTestId('own-rule').filter({ hasText: 'Mail nooit naar klanten' }).waitFor({ timeout: 8000 });
      await rules.getByRole('textbox', { name: 'Nieuwe regel' }).fill('Mag altijd bestanden maken in de map Offertes');
      await rules.getByTestId('rule-preview').getByText('Mag zonder vragen').waitFor({ timeout: 8000 });
      await axe(page, 'bot-editor met regels en voorbeeld (donker)');
      await rules.getByRole('textbox', { name: 'Nieuwe regel' }).fill('');
    }
    ok(`${theme}: geen paginafouten`, !errors.length, errors.join(' | '));
    ok(`${theme}: geen mislukte verzoeken`, !bad.length, bad.join(', '));
    await ctx.close();
  }
} catch (e) {
  failed++;
  console.error('✖', e);
} finally {
  await browser.close();
  await app.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {}
  if (owner) console.log(failed ? `\n${failed} controle(s) mislukt` : '\nAlles in orde');
  process.exit(failed ? 1 : 0);
}
