// Back-ups › "Kopie op een tweede plek" in a real browser (Edge headless on Windows): choose a folder (a stand-in for a
// USB drive) and a password, make a backup and an encrypted copy, lose the local backup, take the copy back with the
// password (a wrong one first) and restore it with the normal restore; after a restart the old data is back. axe-core
// (WCAG 2.x AA) on the page in light and dark.
// Usage: npm run build:ui && node --import tsx tests/e2e/backups-offsite.mjs   (TEAMBOT_E2E_BROWSER=chrome|msedge)
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

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-offsite-home-'));
Object.assign(process.env, { APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') });
delete process.env.TEAMBOT_DATA;
const { createApp } = await import('./server.mjs');
const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-offsite-'));
const usb = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-offsite-usb-'));
const PW = 'paarse olifant op de fiets';
let app = await createApp({ dataDir: dir, port: Number(process.env.TEAMBOT_E2E_PORT) || 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const api = (method, p, body) => fetch(`${app.url}/api${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

try {
  const agent = await api('POST', '/agents', { name: 'Voor de kopie' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'nl-NL', bypassCSP: true });
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
  await page.goto(`${app.url}/#/settings/backups-app`);
  await page.getByRole('heading', { name: 'Kopie op een tweede plek' }).waitFor({ timeout: 20000 });
  ok('de kaart staat op de bestaande Back-ups-pagina', true);

  // Set up: folder and password (too short first).
  await page.locator('[aria-labelledby="offsite-title"]').getByRole('button', { name: 'Instellen', exact: true }).click();
  await page.getByLabel('Map voor de kopieën').fill(usb);
  await page.getByLabel('Wachtwoord (minstens 12 tekens)').fill('kort');
  ok('te kort wachtwoord: uitleg, Opslaan uit', (await page.getByText('Minstens 12 tekens.').count()) === 1 && (await page.getByRole('button', { name: 'Opslaan' }).isDisabled()));
  await page.getByLabel('Wachtwoord (minstens 12 tekens)').fill(PW);
  await page.getByLabel('Herhaal het wachtwoord').fill(PW);
  await page.getByRole('button', { name: 'Opslaan' }).click();
  await page.getByRole('button', { name: 'Nu een kopie maken' }).waitFor({ timeout: 10000 });
  ok('opgeslagen: knop "Nu een kopie maken" en de schakelaar verschijnen', (await page.getByRole('switch', { name: 'Na elke back-up ook een versleutelde kopie maken' }).count()) === 1);

  // A backup, then a copy.
  await page.getByRole('button', { name: 'Nu een back-up maken' }).click();
  await page.getByRole('button', { name: 'Terugzetten' }).first().waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Nu een kopie maken' }).click();
  await page.getByRole('heading', { name: 'Kopieën op de tweede plek' }).waitFor({ timeout: 30000 });
  const files = fs.readdirSync(path.join(usb, 'TeamBot-backups')).filter((f) => f.endsWith('.teambotbackup'));
  ok('een versleuteld bestand op de tweede plek', files.length >= 1, files.join(', '));
  ok('er staat geen leesbare tekst in', !fs.readFileSync(path.join(usb, 'TeamBot-backups', files[0])).includes(Buffer.from('Voor de kopie')));
  ok('laatste kopie wordt gemeld', (await page.getByText(/^Laatste kopie: /).count()) === 1);

  // axe on the page, light and dark (the theme as the app sets it, after a reload: no colours halfway a transition).
  const axeFail = [];
  for (const theme of ['light', 'dark']) {
    await page.evaluate((th) => localStorage.setItem('tb_theme', th), theme);
    await page.reload();
    await page.getByRole('heading', { name: 'Kopieën op de tweede plek' }).waitFor({ timeout: 20000 });
    await page.waitForTimeout(700);
    await page.addScriptTag({ content: axeSource });
    const res = await page.evaluate(async () => {
      const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } });
      return r.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')}`);
    });
    if (res.length) axeFail.push(`${theme}: ${res.join('; ')}`);
  }
  await page.evaluate(() => localStorage.setItem('tb_theme', 'light'));
  ok('axe WCAG AA op Back-ups (licht en donker)', !axeFail.length, axeFail.join(' ‖ '));

  // The disk of this computer breaks: the local backup is gone and the data changed.
  await api('PATCH', `/agents/${agent.id}`, { name: 'Na de kopie' });
  for (const b of (await api('GET', '/backups')).items) await api('DELETE', `/backups/${b.name}`);
  await page.reload();
  await page.getByRole('heading', { name: 'Kopieën op de tweede plek' }).waitFor({ timeout: 20000 });
  ok('geen lokale back-ups meer', (await page.getByText('Nog geen back-ups.').count()) === 1);

  // Take the copy back: a wrong password first.
  await page.locator('[aria-labelledby="offsite-title"]').getByRole('button', { name: 'Terugzetten' }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Kopie openen' });
  await dlg.getByLabel('Wachtwoord van de kopie').fill('niet het goede wachtwoord');
  await dlg.getByRole('button', { name: 'Openen' }).click();
  await page.getByText(/Het wachtwoord klopt niet/).first().waitFor({ timeout: 20000 });
  ok('verkeerd wachtwoord: duidelijke melding, er verandert niets', (await api('GET', '/backups')).items.length === 0);
  await dlg.getByLabel('Wachtwoord van de kopie').fill(PW);
  await dlg.getByRole('button', { name: 'Openen' }).click();
  // Then the normal restore question.
  const confirm = page.getByRole('alertdialog').filter({ hasText: 'terugzetten?' });
  await confirm.waitFor({ timeout: 20000 }).catch(async (e) => {
    console.log((await page.locator("body").innerText()).slice(-2500));
    throw e;
  });
  await confirm.getByRole('button', { name: 'Terugzetten' }).click();
  await page.getByText(/Een back-up staat klaar om terug te zetten/).waitFor({ timeout: 20000 });
  ok('goed wachtwoord: de back-up staat klaar om terug te zetten', true);
  ok('geen fouten op de pagina', !errors.length, errors.slice(0, 3).join(' | '));
  await ctx.close();

  // Restart: the old data is back.
  await app.close();
  app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
  ok('na het opnieuw starten is de oude stand terug', app.ctx.store.agent(agent.id)?.name === 'Voor de kopie', app.ctx.store.agent(agent.id)?.name);
} catch (e) {
  failed++;
  console.log(`✖ ${e?.stack || e}`);
} finally {
  await browser.close();
  await app.close?.();
  for (const d of [dir, usb, home]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(failed ? `✖ ${failed} mislukt` : '✔ back-up op een tweede plek werkt in de browser, terugzetten ook');
process.exit(failed ? 1 : 0);
