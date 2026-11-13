// 0.4.4 "niets blijft stil liggen" in a real browser, on the computer (light and dark) and on a paired phone (device
// session, 402 px, dark): P2 the main bot's message about stuck work with Naar Wacht op jou and Opnieuw proberen (which
// really retries), P8 "Altijd ook op de telefoon" with where you are, P14 the card Wachter buiten de app with its switch.
// Every screen: no console errors or failed requests, no sideways scrolling, axe-core WCAG 2.2 A/AA.
// Usage: npm run build:ui && node --import tsx tests/e2e/care-ui.mjs   (TEAMBOT_TEST_PORT=<port>, TEAMBOT_E2E_BROWSER=chrome|msedge)
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const { startTestApp } = await import('../helpers.ts');
const { newId } = await import('../../server/core/db.ts');

const failures = [];
const fail = (s) => (failures.push(s), console.error(`✗ ${s}`));
const step = (s) => console.log(`• ${s}`);
const ago = (ms) => new Date(Date.now() - ms).toISOString();

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const t = await startTestApp();
try {
  const ctx = t.app.ctx;
  const owner = ctx.auth.owner();
  const main = await t.agent({ name: 'Baas' });
  const pieter = await t.agent({ name: 'Pieter' });
  const svc = ctx.services.teams._service;
  const team = svc.create(owner.id, { name: 'Marketing' });
  svc.setHome(owner.id, team.id, pieter.id);
  ctx.services.teams.setMain(owner.id, main.id);
  // Stuck: an approval waiting 40 minutes, and a task of Pieter that broke 10 minutes ago.
  const pt = ctx.chat.threadForAgent(owner.id, pieter.id);
  ctx.store.insert('approvals', { id: newId('apr_'), user_id: owner.id, agent_id: pieter.id, run_id: null, thread_id: pt.id, kind: 'tool', tool: 'write_file', input: {}, summary: 'Offerte opslaan in Offertes', risk: 'write', options: null, status: 'pending', created_at: ago(40 * 60_000) });
  t.script.push({ error: { message: 'boom', status: 400 } });
  await t.say(pt.id, 'Maak de nieuwsbrief');
  ctx.store.exec("UPDATE runs SET status = 'error', created_at = ?, finished_at = ? WHERE thread_id = ?", ago(11 * 60_000), ago(10 * 60_000), pt.id);
  if (ctx.services.teams.stuck.tick().length !== 1) fail('de hoofdbot schreef geen bericht over vastgelopen werk');
  const mt = ctx.chat.threadForAgent(owner.id, main.id);
  ctx.services.mobile.reportPresence(owner.id, { idleSeconds: 1, locked: false });

  const ticket = await t.api('POST', '/mobile/pair', { baseUrl: t.app.url });
  const secret = new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('t');
  const claimed = await (await fetch(`${t.app.url}/api/public/mobile/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret, name: 'Telefoon', platform: 'ios', client: 'ios-app' }) })).json();
  if (!claimed.token) throw new Error('koppelen mislukt');

  async function open(label, { viewport, token, phone, scheme }) {
    const bctx = await browser.newContext({ viewport, colorScheme: scheme, locale: 'nl-NL', isMobile: !!phone, hasTouch: !!phone, bypassCSP: true });
    await bctx.addInitScript(([tok, isPhone]) => {
      localStorage.setItem('tb_lang', 'nl');
      if (isPhone) localStorage.setItem('tb_token', tok);
    }, [token, !!phone]);
    const page = await bctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text()) && errors.push(m.text()));
    page.on('response', (r) => r.url().includes('/api/') && r.status() >= 400 && !/\/api\/(sessions|secrets)/.test(r.url()) && errors.push(`${r.status()} ${r.url()}`));
    await page.goto(`${t.app.url}/${phone ? '' : `#token=${token}`}`);
    await page.waitForTimeout(800);
    const go = async (hash) => {
      await page.evaluate((h) => (location.hash = h), hash);
      await page.waitForTimeout(600);
    };
    const check = async (where, scope) => {
      if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) fail(`${label} ${where}: de pagina schuift zijwaarts`);
      await page.addScriptTag({ content: axeSource });
      const res = await page.evaluate(async (sel) => (await window.axe.run(document.querySelector(sel) || document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] })).violations.map((v) => `${v.id}: ${v.nodes.length}`), scope);
      if (res.length) fail(`${label} ${where}: axe ${res.join(', ')}`);
    };
    return { page, bctx, errors, go, check };
  }

  async function round(label, o) {
    const { page, bctx, errors, go, check } = await open(label, o);
    // P2: the main bot's message in its own chat.
    await go(`#/t/${mt.id}`);
    const msg = page.getByText(/Pieter in team Marketing wacht al \d+ minuten op je goedkeuring: “Offerte opslaan in Offertes”/);
    await msg.first().waitFor({ timeout: 15_000 }).catch(() => fail(`${label}: bericht over de wachtende goedkeuring niet gezien`));
    if (!(await page.getByText(/Het werk van Pieter in team Marketing is vastgelopen/).count())) fail(`${label}: vastgelopen taak niet in het bericht`);
    if (!(await page.getByRole('link', { name: 'Naar Wacht op jou' }).count())) fail(`${label}: link Naar Wacht op jou ontbreekt`);
    const retry = page.getByRole('button', { name: 'Opnieuw proberen' });
    if (!o.phone && !(await retry.count())) fail(`${label}: knop Opnieuw proberen ontbreekt`);
    await check('vastgelopen werk', '[data-stuck]');
    step(`${label}: de hoofdbot meldt het vastgelopen werk, met Naar Wacht op jou${o.phone ? '' : ' en Opnieuw proberen'}`);

    // P8: where alerts go.
    await go('#/settings/mobile-telefoon');
    const always = page.getByRole('switch', { name: 'Altijd ook op de telefoon' });
    await always.waitFor({ timeout: 10_000 }).catch(() => fail(`${label}: schakelaar Altijd ook op de telefoon ontbreekt`));
    if (!(await page.getByText('Je zit nu achter de pc: meldingen komen alleen op Windows.', { exact: false }).count())) fail(`${label}: niet gezegd waar meldingen nu komen`);
    await check('meldingen', '[data-presence]');
    step(`${label}: Altijd ook op de telefoon, met "je zit nu achter de pc"`);

    // P14: the watchdog card (computer only).
    await go('#/settings/health-status');
    await page.getByRole('heading', { name: 'Alles loopt soepel' }).waitFor({ timeout: 15_000 }).catch(() => fail(`${label}: Status van TeamBot laadt niet`));
    const card = page.getByRole('heading', { name: 'Wachter buiten de app' });
    if (o.phone) {
      if (await card.count()) fail(`${label}: de wachter (pc) staat op de telefoon`);
    } else {
      await card.waitFor({ timeout: 5000 }).catch(() => fail(`${label}: kaart Wachter buiten de app ontbreekt`));
      if (!(await page.getByText('De wachter heeft nog niet gekeken.', { exact: false }).count())) fail(`${label}: geen uitleg dat de wachter nog niet keek`);
      await check('wachter', '#wachter');
    }
    step(`${label}: Status van TeamBot ${o.phone ? 'zonder de wachter van de pc' : 'met Wachter buiten de app'}`);
    if (errors.length) fail(`${label}: fouten ${errors.join(' | ')}`);
    return { page, bctx };
  }

  (await round('computer, licht', { viewport: { width: 1360, height: 900 }, token: t.token, scheme: 'light' })).bctx.close();
  (await round('telefoon (apparaatsessie), donker', { viewport: { width: 402, height: 874 }, token: claimed.token, phone: true, scheme: 'dark' })).bctx.close();
  const { page, bctx } = await round('computer, donker', { viewport: { width: 1360, height: 900 }, token: t.token, scheme: 'dark' });

  // Used, not only seen: Opnieuw proberen really starts Pieter again, once; the switches are stored.
  t.script.push({ text: 'Nieuwsbrief klaar.' });
  await page.evaluate((h) => (location.hash = h), `#/t/${mt.id}`);
  await page.getByRole('button', { name: 'Opnieuw proberen' }).click();
  await page.getByText('Opnieuw gestart').first().waitFor({ timeout: 10_000 }).catch(() => fail('na Opnieuw proberen: geen "Opnieuw gestart"'));
  await t.waitIdle(pt.id);
  const retried = ctx.store.one("SELECT status FROM runs WHERE thread_id = ? AND trigger = 'retry'", pt.id);
  if (retried?.status !== 'done') fail(`Opnieuw proberen: de taak liep niet opnieuw (${retried?.status})`);
  step('Opnieuw proberen gebruikt: Pieter deed het werk opnieuw, de knop is weg');
  await page.evaluate((h) => (location.hash = h), '#/settings/mobile-telefoon');
  await page.getByRole('switch', { name: 'Altijd ook op de telefoon' }).click();
  await page.waitForTimeout(500);
  if (ctx.store.getSetting(owner.id, 'mobilePush', {})?.alwaysPhone !== true) fail('Altijd ook op de telefoon niet opgeslagen');
  await page.evaluate((h) => (location.hash = h), '#/settings/health-status');
  const sw = page.getByRole('switch', { name: 'Meld het als TeamBot niet draait of vastloopt' });
  await sw.waitFor({ timeout: 10_000 });
  await sw.click();
  await page.waitForTimeout(500);
  if ((await t.api('GET', '/health')).watchdog.notify !== false) fail('de schakelaar van de wachter is niet opgeslagen');
  step('Altijd ook op de telefoon en de schakelaar van de wachter: aangeklikt en opgeslagen');
  await bctx.close();
} finally {
  await browser.close();
  await t.close();
}
console.log(failures.length ? `\n${failures.length} fout(en)` : '\nNiets blijft stil liggen (P2, P8, P14): alles in orde');
process.exit(failures.length ? 1 : 0);
