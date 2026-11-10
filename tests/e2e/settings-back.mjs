// Instellingen: always a way back (10 nov). On the wide screen a round arrow next to "Instellingen" that leaves the
// settings to where you were; on a narrow screen "Terug" above the list, and from a page back to the list.
// Usage: npm run build:ui && node --import tsx tests/e2e/settings-back.mjs [screenshot-dir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'tb-settings-back-shots-'));

let failed = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? '✔' : '✖'} ${name}${detail && !cond ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-back-home-'));
Object.assign(process.env, { APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') });
delete process.env.TEAMBOT_DATA;
const { createApp } = await import('../../server/app.ts');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-back-'));
const app = await createApp({ dataDir: dir, port: Number(process.env.TEAMBOT_E2E_PORT) || 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();

const open = async (viewport) => {
  const ctx = await browser.newContext({ viewport, locale: 'nl-NL', bypassCSP: true });
  await ctx.addInitScript(([t]) => {
    if (!sessionStorage.getItem('tb_init')) {
      sessionStorage.setItem('tb_init', '1');
      localStorage.setItem('tb_token', t);
      localStorage.setItem('tb_lang', 'nl');
      localStorage.setItem('tb_theme', 'light');
    }
  }, [token]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return { ctx, page, errors };
};
const hash = (page) => page.evaluate(() => location.hash);

try {
  // ---- wide: from Taken into Instellingen, a second settings page, then back to Taken
  {
    const { ctx, page, errors } = await open({ width: 1400, height: 860 });
    await page.goto(`${app.url}/#/tasks`);
    await page.waitForTimeout(1500);
    await page.evaluate(() => (location.hash = '#/settings'));
    const back = page.getByRole('link', { name: 'Terug', exact: true });
    await back.waitFor({ timeout: 15000 });
    ok('breed: pijltje terug naast Instellingen', await back.isVisible());
    await page.screenshot({ path: path.join(shots, 'breed-instellingen.png') });
    await page.evaluate(() => (location.hash = '#/settings/usage'));
    await page.waitForTimeout(600);
    ok('breed: het pijltje staat er ook op een andere instellingenpagina', await back.isVisible());
    ok('breed: het wijst naar waar je was (Taken)', (await back.getAttribute('href')) === '#/tasks', String(await back.getAttribute('href')));
    await back.click();
    await page.waitForTimeout(600);
    ok('breed: klikken brengt je terug naar Taken', (await hash(page)) === '#/tasks', await hash(page));
    ok('breed: geen fouten in de pagina', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
  // ---- narrow: the list has "Terug"; a page goes back to the list
  {
    const { ctx, page, errors } = await open({ width: 420, height: 860 });
    await page.goto(`${app.url}/#/`);
    await page.waitForTimeout(1500);
    await page.evaluate(() => (location.hash = '#/settings'));
    const back = page.getByRole('link', { name: 'Terug', exact: true });
    await back.waitFor({ timeout: 15000 });
    ok('smal: Terug boven de lijst', await back.isVisible());
    await page.screenshot({ path: path.join(shots, 'smal-lijst.png') });
    await page.evaluate(() => (location.hash = '#/settings/general'));
    const toList = page.locator('a[href="#/settings"]:visible').first();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(shots, 'smal-pagina.png') });
    await toList.waitFor({ timeout: 15000 });
    await toList.click();
    await page.waitForTimeout(600);
    ok('smal: van een pagina terug naar de lijst', (await hash(page)) === '#/settings', await hash(page));
    await page.getByRole('link', { name: 'Terug', exact: true }).click();
    await page.waitForTimeout(600);
    ok('smal: en van de lijst terug naar waar je was', ['#/', ''].includes(await hash(page)), await hash(page));
    ok('smal: geen fouten in de pagina', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
} finally {
  await browser.close();
  await app.close?.();
}
console.log(`Schermafbeeldingen: ${shots}`);
process.exit(failed ? 1 : 0);
