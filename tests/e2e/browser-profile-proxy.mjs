// Proxy per browser profile as the owner uses it (TeamBot 0.4.4): Computers › Browserprofielen › Proxy… on one
// profile (address, login, test, save), the list says "Via proxy …", the login never shows; another profile keeps no
// proxy; removing it again; on a paired phone the list shows the proxy but no Proxy… button and no failing request.
// Edge/Chrome headless, temp data dir, a free port (TEAMBOT_E2E_PORT to fix one; never 4747/4748).
// Usage: npm run build:ui && node --import tsx tests/e2e/browser-profile-proxy.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const { createApp } = await import('../../server/app.ts');
const { axeCheck } = await import('./axe-check.mjs');

const step = (s) => console.log(`• ${s}`);
const fail = (s) => {
  console.error(`✗ ${s}`);
  process.exitCode = 1;
};
const PW = 'Proxy-E2E-Geheim-4k9';
const port = Number(process.env.TEAMBOT_E2E_PORT) || 0;
if (port === 4747 || port === 4748) throw new Error('4747/4748 zijn van de geïnstalleerde TeamBot');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-e2e-profileproxy-'));
const app = await createApp({ dataDir: dir, port, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();
const svc = app.ctx.services.computers._service;
const marketing = svc.createSharedProfile(owner.id, 'Marketing', null);
svc.createSharedProfile(owner.id, 'Support', null);
step(`TeamBot op ${app.url}`);

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, bypassCSP: true })).newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  // the SOCKS address below is refused on purpose (400)
  page.on('console', (m) => m.type() === 'error' && !/favicon|401 \(Unauthorized\)|400 \(Bad Request\)/.test(m.text()) && errors.push(m.text()));
  await page.goto(`${app.url}/#token=${token}`);
  await page.waitForTimeout(600);
  await page.goto(`${app.url}/#/m/browser`);
  // "Proxy…" is in the "⋯" menu of the profile's row.
  const row = page.locator('li', { hasText: 'Marketing' });
  const openProxy = async () => {
    await row.getByRole('button', { name: /^Meer opties voor/ }).click();
    await row.getByRole('menuitem', { name: 'Proxy…' }).click();
  };
  await openProxy();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Adres van de proxy').fill('socks5://proxy:1080');
  await dlg.getByRole('button', { name: 'Opslaan' }).click();
  // 0.4.4: SOCKS works for all of TeamBot (Netwerk en proxy), a profile's own proxy stays HTTP(S).
  await page.getByText(/kan alleen een HTTP- of HTTPS-proxy gebruiken, geen SOCKS/).first().waitFor({ timeout: 8000 });
  step('een SOCKS-adres wordt in gewone taal geweigerd');
  await dlg.getByLabel('Adres van de proxy').fill('http://127.0.0.1:9');
  await dlg.getByRole('button', { name: 'Testen' }).click();
  await dlg.getByRole('status').waitFor({ timeout: 20000 });
  step(`Testen met een proxy die niet antwoordt: “${(await dlg.getByRole('status').innerText()).slice(0, 80)}”`);
  await dlg.getByLabel('Adres van de proxy').fill('proxy.bedrijf.nl:8080');
  await dlg.getByLabel('Gebruikersnaam (optioneel)').fill('jan');
  await dlg.getByLabel('Wachtwoord (optioneel)').fill(PW);
  await dlg.getByRole('button', { name: 'Opslaan' }).click();
  await row.getByText('Via proxy proxy.bedrijf.nl:8080, met inloggegevens').waitFor({ timeout: 8000 });
  if ((await page.content()).includes(PW)) fail('het wachtwoord van de proxy staat in de pagina');
  if (await page.locator('li', { hasText: 'Support' }).getByText(/Via proxy/).count()) fail('het andere profiel kreeg ook een proxy');
  if (svc.profileUpstream(marketing.id)?.label !== 'proxy.bedrijf.nl:8080') fail('de browser van het profiel gebruikt de proxy niet');
  const a11yList = await axeCheck(page);
  if (a11yList.length) fail(`Computers met proxy (toegankelijkheid): ${a11yList.join(' | ')}`);
  step('Marketing: “Via proxy proxy.bedrijf.nl:8080, met inloggegevens”; Support zonder proxy; wachtwoord nergens in de pagina');

  // open again: the login is kept (write-only), then remove the proxy
  await openProxy();
  if ((await dlg.getByLabel('Adres van de proxy').inputValue()) !== 'http://proxy.bedrijf.nl:8080') fail('het adres staat niet in het venster');
  if (!(await dlg.getByText('Er zijn inloggegevens opgeslagen. Leeg laten houdt ze.').count())) fail('het venster zegt niet dat er inloggegevens zijn');
  if ((await dlg.getByLabel('Wachtwoord (optioneel)').inputValue()) !== '') fail('het wachtwoord wordt weer getoond');
  const a11yDlg = await axeCheck(page);
  if (a11yDlg.length) fail(`venster Proxy (toegankelijkheid): ${a11yDlg.join(' | ')}`);
  await dlg.getByRole('button', { name: 'Proxy weghalen' }).click();
  await row.getByText(/Via proxy/).waitFor({ state: 'detached', timeout: 8000 });
  if (svc.profileUpstream(marketing.id) !== null) fail('de proxy is niet weggehaald');
  if (app.ctx.store.all("SELECT id FROM secrets WHERE name LIKE 'browser-proxy:%'").length) fail('de inloggegevens bleven bewaard');
  step('opnieuw geopend: adres staat er, wachtwoord niet; “Proxy weghalen” haalt adres en inloggegevens weg; axe: geen ernstige problemen (lijst en venster)');

  // paired phone: sees the proxy, but sets it only on the computer
  await fetch(`${app.url}/api/computers/profiles/${marketing.id}/proxy`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ url: 'http://proxy.bedrijf.nl:8080' }) });
  const ticket = await (await fetch(`${app.url}/api/mobile/pair`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ baseUrl: app.url }) })).json();
  const secret = new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('t');
  const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TeamBotiOS/0.4.4';
  const claimed = await (await fetch(`${app.url}/api/public/mobile/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA }, body: JSON.stringify({ secret, name: 'iPhone', platform: 'ios', client: 'ios-app' }) })).json();
  const phoneCtx = await browser.newContext({ viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true, userAgent: UA });
  await phoneCtx.addInitScript((t) => localStorage.setItem('tb_token', t), claimed.token);
  const phone = await phoneCtx.newPage();
  const phoneFails = [];
  phone.on('pageerror', (e) => phoneFails.push(e.message));
  phone.on('response', (r) => r.url().includes('/api/') && r.status() >= 400 && !r.url().includes('/vault') && phoneFails.push(`verzoek ${r.url()} → ${r.status()}`));
  await phone.goto(`${app.url}/#/m/browser`);
  const prow = phone.locator('li', { hasText: 'Marketing' });
  await prow.getByText('Via proxy proxy.bedrijf.nl:8080').waitFor({ timeout: 10000 });
  await prow.getByRole('button', { name: /^Meer opties voor/ }).click();
  if (await prow.getByRole('menuitem', { name: 'Proxy…' }).count()) fail('telefoon: de knop Proxy… staat er (die kan daar alleen mislukken)');
  if (phoneFails.length) fail(`telefoon: ${phoneFails.join('; ')}`);
  const deny = await fetch(`${app.url}/api/computers/profiles/${marketing.id}/proxy`, { method: 'PUT', headers: { authorization: `Bearer ${claimed.token}`, 'content-type': 'application/json', 'user-agent': UA }, body: JSON.stringify({ url: '' }) });
  if (deny.status !== 403) fail(`telefoon mocht de proxy instellen (${deny.status})`);
  step('gekoppelde telefoon: ziet “Via proxy …”, geen knop Proxy…, geen mislukte verzoeken; de API geeft 403');
  if (errors.length) fail(`paginafouten: ${errors.join(' | ')}`);
} catch (e) {
  fail(String(e?.stack || e));
} finally {
  await browser.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
if (!process.exitCode) step('klaar: alles geslaagd');
