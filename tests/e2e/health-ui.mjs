// Instellingen › Hoe gaat het met TeamBot? (17.1) in a real browser: on the computer and on a paired phone (device
// session, 402 px), the coloured line, "Meer informatie" with the numbers, no console errors, axe-core WCAG 2.2 A/AA
// in light and dark. Then a real 1.3 s block of the server turns the line orange (after the start-up minutes).
// Usage: npm run build:ui && node --import tsx tests/e2e/health-ui.mjs   (TEAMBOT_E2E_BROWSER=chrome|msedge)
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const { startTestApp } = await import('../helpers.ts');

const failures = [];
const fail = (s) => (failures.push(s), console.error(`✗ ${s}`));
const step = (s) => console.log(`• ${s}`);

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const t = await startTestApp();
try {
  const ticket = await t.api('POST', '/mobile/pair', { baseUrl: t.app.url });
  const secret = new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('t');
  const claimed = await (await fetch(`${t.app.url}/api/public/mobile/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret, name: 'Telefoon', platform: 'ios', client: 'ios-app' }) })).json();
  if (!claimed.token) throw new Error('koppelen mislukt');

  async function check(label, { viewport, token, phone, scheme }) {
    const ctx = await browser.newContext({ viewport, colorScheme: scheme, locale: 'nl-NL', isMobile: !!phone, hasTouch: !!phone, bypassCSP: true });
    await ctx.addInitScript(([tok, isPhone]) => {
      localStorage.setItem('tb_lang', 'nl');
      if (isPhone) localStorage.setItem('tb_token', tok);
    }, [token, !!phone]);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text()) && errors.push(m.text()));
    page.on('response', (r) => r.url().includes('/api/health') && r.status() >= 400 && errors.push(`${r.status()} ${r.url()}`));
    await page.goto(`${t.app.url}/${phone ? '' : `#token=${token}`}`);
    await page.waitForTimeout(800);
    await page.evaluate(() => (location.hash = '#/settings/health-status'));
    const head = page.getByRole('heading', { name: 'Alles loopt soepel' });
    await head.waitFor({ timeout: 15_000 }).catch(() => fail(`${label}: kop "Alles loopt soepel" niet gezien`));
    if (!(await page.locator('[data-level="ok"]').count())) fail(`${label}: groene lijn ontbreekt`);
    const more = page.getByRole('button', { name: 'Meer informatie' });
    await more.click();
    if ((await more.getAttribute('aria-expanded')) !== 'true') fail(`${label}: Meer informatie gaat niet open`);
    for (const row of ['Stilstand (langer dan 1 seconde)', 'Geheugen', 'Open verbindingen, bestanden en timers', 'Taken die nu lopen']) if (!(await page.getByText(row, { exact: true }).count())) fail(`${label}: rij "${row}" ontbreekt`);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (wide) fail(`${label}: de pagina schuift zijwaarts`);
    await page.addScriptTag({ content: axeSource });
    const res = await page.evaluate(async () => (await window.axe.run(document.querySelector('#hoe-gaat-het') || document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] })).violations.map((v) => `${v.id}: ${v.nodes.length}`));
    if (res.length) fail(`${label}: axe ${res.join(', ')}`);
    if (errors.length) fail(`${label}: fouten ${errors.join(' | ')}`);
    step(`${label}: groene lijn, Meer informatie met de cijfers, axe schoon`);
    await ctx.close();
    return page;
  }
  await check('computer, licht', { viewport: { width: 1360, height: 900 }, token: t.token, scheme: 'light' });
  await check('computer, donker', { viewport: { width: 1360, height: 900 }, token: t.token, scheme: 'dark' });
  await check('telefoon (apparaatsessie), donker', { viewport: { width: 402, height: 874 }, token: claimed.token, phone: true, scheme: 'dark' });

  // A real block of the server, after the start-up minutes: the line turns orange with the reason in words.
  const meter = t.app.ctx.services.health.meter();
  meter.totals.startedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const end = performance.now() + 1300;
  while (performance.now() < end) {
    /* block the server's event loop */
  }
  await new Promise((r) => setTimeout(r, 300));
  const h = await t.api('GET', '/health');
  if (h.level !== 'warn' || h.reasons[0]?.code !== 'stalls1s') fail(`na 1,3 s blokkade: ${h.level} ${JSON.stringify(h.reasons)}`);
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: 'nl-NL' });
  await ctx.addInitScript(() => localStorage.setItem('tb_lang', 'nl'));
  const page = await ctx.newPage();
  await page.goto(`${t.app.url}/#token=${t.token}`);
  await page.waitForTimeout(800);
  await page.evaluate(() => (location.hash = '#/settings/health-status'));
  await page.getByRole('heading', { name: 'TeamBot hapert soms' }).waitFor({ timeout: 15_000 }).catch(() => fail('oranje kop niet gezien'));
  if (!(await page.getByText(/langer dan een seconde stil/).count())) fail('de reden staat er niet in woorden');
  if (!(await page.locator('[data-level="warn"]').count())) fail('oranje lijn ontbreekt');
  step('na een echte blokkade van 1,3 s: oranje lijn met de reden in gewone woorden');
  await ctx.close();
} finally {
  await browser.close();
  await t.close();
}
console.log(failures.length ? `\n${failures.length} fout(en)` : '\nHoe gaat het met TeamBot?: alles in orde');
process.exit(failures.length ? 1 : 0);
