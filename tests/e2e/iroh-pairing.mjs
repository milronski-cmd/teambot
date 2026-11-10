// Pairing from the one card "Telefoon koppelen" (0.4.5) in the real web app, on a fresh desktop install (Edge headless):
// Instellingen › Telefoon shows the QR code right away, without a choice first; TeamBot switched the TeamBot
// connection (iroh) on by itself. A Node stand-in for the iPhone app (tests/iroh-phone.ts) scans the code, dials the
// computer's key over iroh and claims it; step 3 says "Verbonden: iPhone van Sanne" live and Gekoppelde telefoons
// lists it. Opened again, the card says it is connected and makes no new code by itself. Under Meer opties: another
// address, Tailscale, Bereikbaarheid with the connection and the last phone, the switch turns it off, and under
// Geavanceerd the own relay field. axe-core WCAG 2.2 A/AA light and dark, and the card at phone width.
// Offline: no relays (TEAMBOT_IROH_PRESET=offline), the phone dials the computer's direct addresses.
// Usage: npm run build:ui && node --import tsx tests/e2e/iroh-pairing.mjs   (TEAMBOT_E2E_PORT=<port>, free port by default)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const failures = [];
const fail = (s) => (failures.push(s), console.error(`✗ ${s}`));
const step = (s) => console.log(`• ${s}`);

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-iroh-pair-home-'));
Object.assign(process.env, { APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), TEAMBOT_IROH_PRESET: 'offline' });
delete process.env.TEAMBOT_DATA;
const { createApp } = await import('../../server/app.ts');
const { startIrohPhone } = await import('../iroh-phone.ts');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-iroh-pair-'));
const app = await createApp({ dataDir: dir, port: Number(process.env.TEAMBOT_E2E_PORT) || 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
if (!app.ctx.config.uiDir) throw new Error('Bouw eerst de interface: npm run build:ui');
const pcToken = app.ctx.auth.ensureLocalOwner();
const mobile = app.ctx.services.mobile.instance;
const pc = async (method, p, body) => {
  const r = await fetch(`${app.url}/api${p}`, { method, headers: { authorization: `Bearer ${pcToken}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status}`);
  return r.json();
};
// No Tailscale on the test computer (this pc may have it): the card picks the TeamBot connection.
mobile.tailscaleProbe = async () => ({ installed: false, running: false, ips: [], dnsName: null, detail: 'Tailscale niet gevonden' });
mobile.serveTargets = async () => [];

async function axe(page, name) {
  await page.addScriptTag({ content: axeSource });
  const v = await page.evaluate(async () => {
    // @ts-ignore
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
    return r.violations.map((x) => `${x.id}: ${x.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`);
  });
  if (v.length) fail(`a11y ${name}: ${v.join(' | ')}`);
}

let phone;
try {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: 'nl-NL', colorScheme: 'light', bypassCSP: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let pairPosts = 0;
  page.on('request', (r) => r.url().endsWith('/api/mobile/pair') && r.method() === 'POST' && pairPosts++);
  await page.goto(`${app.url}/#token=${pcToken}`);
  await page.waitForTimeout(800);

  // ---- 1. the card: QR code right away, no choices
  const made = page.waitForResponse((r) => r.url().endsWith('/api/mobile/pair') && r.request().method() === 'POST', { timeout: 20000 });
  await page.goto(`${app.url}/#/settings/mobile-telefoon`);
  const card = page.getByTestId('pair-card');
  await card.waitFor({ timeout: 15000 });
  const heads = (await card.getByRole('heading').allInnerTexts()).map((h) => h.replace(/\s+/g, ' ').trim());
  const want = ['Telefoon koppelen', 'Stap 1: Haal de app', 'Stap 2: Scan de QR-code', 'Stap 3: Verbonden'];
  if (want.some((w) => !heads.includes(w))) fail(`kaart: de drie stappen ontbreken (${heads.join(' | ')})`);
  const ticket = await (await made).json();
  if (ticket.error) fail(`QR-code maken: ${ticket.error}`);
  await card.getByRole('img', { name: 'QR-code om je telefoon te koppelen' }).waitFor({ timeout: 10000 }).catch(() => fail('kaart: geen QR-code meteen'));
  if (await card.getByRole('radio').count()) fail('kaart: eerst kiezen (keuzerondjes) voor de QR-code');
  if (await card.getByRole('button', { name: 'QR-code maken' }).count()) fail('kaart: eerst op QR-code maken klikken');
  if (!ticket.url?.startsWith('teambot://pair#t=')) fail(`QR-code is geen TeamBot-verbinding: ${ticket.url}`);
  if (ticket.auto?.kind !== 'iroh') fail(`TeamBot koos niet zelf de TeamBot-verbinding: ${JSON.stringify(ticket.auto)}`);
  if (!mobile.iroh.status().running) fail('de TeamBot-verbinding ging niet vanzelf aan bij het koppelen');
  await card.getByText('Open TeamBot op je iPhone en tik op Scan de QR-code', { exact: false }).waitFor({ timeout: 5000 }).catch(() => fail('kaart: geen uitleg voor de iPhone-app'));
  const appLink = card.getByRole('link', { name: /TestFlight voor de iPhone-app/ });
  if (!(await appLink.count())) fail('stap 1: geen link naar de iPhone-app (TestFlight)');
  else if ((await appLink.getAttribute('href')) !== 'https://apps.apple.com/app/testflight/id899247664') fail(`stap 1: link ${await appLink.getAttribute('href')}`);
  await card.getByText('Wacht tot je telefoon de code scant', { exact: false }).waitFor({ timeout: 5000 }).catch(() => fail('stap 3: niet gezegd dat de kaart op de telefoon wacht'));
  step('Telefoon koppelen: één kaart, QR-code meteen (zonder kiezen), TeamBot-verbinding vanzelf aan, stap 1 met TestFlight');
  await axe(page, 'telefoon-kaart (licht)');

  // ---- 2. the stand-in iPhone scans: dial the key in the code, claim over iroh
  const frag = new URLSearchParams(ticket.url.slice(ticket.url.indexOf('#') + 1));
  const id = frag.get('n');
  if (!id) fail('QR-code zonder sleutel van de computer');
  phone = await startIrohPhone({ id, direct: mobile.iroh.addr()?.direct || [] }, { offline: true, timeoutMs: 10000 });
  const claim = await fetch(phone.base + '/api/public/mobile/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 TeamBotiOS/0.4.5' },
    body: JSON.stringify({ secret: frag.get('t'), name: 'iPhone van Sanne', platform: 'ios', client: 'ios-app' }),
  });
  if (claim.status !== 200) fail(`koppelen via de TeamBot-verbinding: ${claim.status} ${await claim.text()}`);
  await card.getByTestId('pair-status').getByText('Verbonden: iPhone van Sanne').waitFor({ timeout: 10000 }).catch(() => fail('stap 3: niet live "Verbonden: iPhone van Sanne"'));
  await page.getByTestId('paired-phones').getByText('iPhone van Sanne').waitFor({ timeout: 8000 }).catch(() => fail('Gekoppelde telefoons: de iPhone staat er niet bij'));
  step(`stand-in iPhone gekoppeld vanaf de kaart via de TeamBot-verbinding (verbinden ${phone.connectMs} ms, ${phone.path()}); stap 3 zegt live Verbonden`);
  await axe(page, 'telefoon-kaart verbonden (licht)');

  // ---- 3. opened again: connected, no new code by itself; one click for another phone
  const before = pairPosts;
  await page.reload();
  await card.waitFor({ timeout: 15000 });
  await card.getByTestId('pair-status').getByText('Verbonden: iPhone van Sanne', { exact: false }).waitFor({ timeout: 8000 }).catch(() => fail('opnieuw geopend: stap 3 zegt niet dat de iPhone verbonden is'));
  const another = card.getByRole('button', { name: 'Nog een telefoon koppelen' });
  await another.waitFor({ timeout: 5000 }).catch(() => fail('opnieuw geopend: geen knop Nog een telefoon koppelen'));
  await page.waitForTimeout(500);
  if (pairPosts !== before) fail('opnieuw geopend met een gekoppelde telefoon: toch vanzelf een nieuwe code gemaakt');
  step('opnieuw geopend: Verbonden: iPhone van Sanne, geen nieuwe code vanzelf, Nog een telefoon koppelen');

  // ---- 4. Meer opties: another address, Tailscale, Bereikbaarheid (the connection with the last phone)
  const more = page.getByTestId('more-options');
  await more.locator('summary').click();
  // 0.4.5: the address is a dropdown ("Adres voor je telefoon") that applies at once; it follows the code in the card.
  const address = more.getByTestId('pair-address');
  await address.waitFor({ timeout: 10000 }).catch(() => fail('Meer opties: geen keuzemenu voor het adres'));
  // TeamBot's own dropdown (components/Listbox.tsx): the button shows the choice, the list opens with its options.
  const listOptions = page.locator('[role="listbox"] [role="option"]');
  await address.click();
  const addressOptions = (await listOptions.allInnerTexts().catch(() => [])).map((o) => o.trim());
  await page.keyboard.press('Escape');
  if (!addressOptions.some((o) => /TeamBot-verbinding/.test(o))) fail(`Meer opties: geen keuze voor een ander adres (TeamBot-verbinding): ${addressOptions.join(' | ')}`);
  const shownChoice = await address.innerText().catch(() => '');
  if (!/Automatisch/.test(shownChoice)) fail(`Meer opties: het adres volgt de code niet (Automatisch verwacht): ${shownChoice}`);
  if (await more.getByRole('radio', { name: /TeamBot-verbinding/ }).count()) fail('Meer opties: nog keuzerondjes voor het adres in plaats van een keuzemenu');
  if (!(await more.getByRole('heading', { name: 'Tailscale' }).count())) fail('Meer opties: Tailscale ontbreekt');
  if (!(await more.getByRole('switch', { name: /Aan|Uit/ }).count())) fail('Meer opties: geen schakelaars bij Bereikbaarheid');
  await more.getByRole('button', { name: 'Opnieuw controleren' }).click();
  const block = more.getByTestId('iroh-block');
  await block.getByText(/Laatste telefoon/).waitFor({ timeout: 5000 }).catch(() => fail('Bereikbaarheid: TeamBot-verbinding zonder de laatste telefoon'));
  if (await page.getByLabel('Eigen relay-server').count()) fail('veld voor een eigen relay-server zichtbaar zonder Geavanceerd');
  step('Meer opties: ander adres, Tailscale en Bereikbaarheid (TeamBot-verbinding aan, met de laatste telefoon)');

  // a code for the iPhone app with the address chosen there: the card shows it
  const irohLabel = addressOptions.find((o) => /TeamBot-verbinding/.test(o)) || 'TeamBot-verbinding';
  const chosen = page.waitForResponse((r) => r.url().endsWith('/api/mobile/pair') && r.request().method() === 'POST');
  await address.click();
  await listOptions.filter({ hasText: irohLabel }).first().click();
  const t2 = await (await chosen).json();
  if (!t2.url?.startsWith('teambot://pair#t=')) fail(`Meer opties: code met het gekozen adres: ${t2.url}`);
  await card.getByRole('img', { name: 'QR-code om je telefoon te koppelen' }).waitFor({ timeout: 5000 }).catch(() => fail('Meer opties: de kaart toont de nieuwe code niet'));
  if (!/TeamBot-verbinding/.test(await address.innerText())) fail('Meer opties: het keuzemenu toont het gekozen adres niet');
  step('Meer opties: een adres kiezen maakt meteen een code met dat adres in de kaart');

  // dark theme
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(200);
  await axe(page, 'telefoon met Meer opties (donker)');

  // switch off from the computer
  await block.getByRole('switch').click();
  await page.getByText('TeamBot-verbinding uit').first().waitFor({ timeout: 5000 });
  if (mobile.iroh.status().running) fail('de schakelaar zette de TeamBot-verbinding niet uit');
  step('schakelaar zet de TeamBot-verbinding uit');

  // Geavanceerd: own relay
  const res = await fetch(`${app.url}/api/settings`, { method: 'PUT', headers: { authorization: `Bearer ${pcToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ ui: { advanced: true } }) });
  if (!res.ok) fail(`Geavanceerd tonen: ${res.status}`);
  await page.reload();
  await page.getByTestId('more-options').locator('summary').click();
  const relay = page.getByLabel('Eigen relay-server');
  await relay.waitFor({ timeout: 10000 }).catch(() => fail('veld voor een eigen relay-server ontbreekt onder Geavanceerd'));
  if (await relay.count()) {
    await relay.fill('https://relay.voorbeeld.nl');
    await page.locator('div', { has: relay }).getByRole('button', { name: 'Opslaan' }).last().click();
    await page.getByText('Eigen relay-server opgeslagen').first().waitFor({ timeout: 5000 });
    if (mobile.iroh.settings().relay !== 'https://relay.voorbeeld.nl/') fail(`eigen relay niet opgeslagen: ${mobile.iroh.settings().relay}`);
    step('Geavanceerd: eigen relay-server opgeslagen');
    await axe(page, 'telefoon geavanceerd (donker)');
  }
  if (errors.length) fail(`paginafouten: ${errors.join(' | ')}`);
  await ctx.close();

  // ---- 5. the card at phone width (a small laptop window or 400% zoom): fits, QR code readable. The connection was
  // switched off on purpose above: the card says so plainly instead of switching it on again behind the owner's back.
  const small = await browser.newContext({ viewport: { width: 360, height: 780 }, locale: 'nl-NL', colorScheme: 'dark', bypassCSP: true });
  const sp = await small.newPage();
  await sp.goto(`${app.url}/#token=${pcToken}`);
  await sp.waitForTimeout(800);
  await sp.goto(`${app.url}/#/settings/mobile-telefoon`);
  const sc = sp.getByTestId('pair-card');
  await sc.getByRole('button', { name: 'Nog een telefoon koppelen' }).click({ timeout: 15000 });
  await sc.getByText('De TeamBot-verbinding staat uit.', { exact: false }).waitFor({ timeout: 10000 }).catch(() => fail('uitgezet: de kaart zegt niet dat de TeamBot-verbinding uit staat'));
  if (mobile.iroh.status().running) fail('uitgezet: de kaart zette de TeamBot-verbinding stilletjes weer aan');
  step('uitgezet door de eigenaar: de kaart zegt het gewoon en zet hem niet stilletjes weer aan');
  await pc('PUT', '/mobile/iroh', { enabled: true });
  await sc.getByRole('button', { name: 'Opnieuw proberen' }).click();
  const qr = sc.getByRole('img', { name: 'QR-code om je telefoon te koppelen' });
  await qr.waitFor({ timeout: 10000 }).catch(() => fail('360 px: geen QR-code na Nog een telefoon koppelen'));
  const box = await qr.boundingBox();
  if (!box || box.width < 180) fail(`360 px: QR-code te klein (${box?.width} px)`);
  const over = await sp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over > 1) fail(`360 px: de pagina schuift ${over} px opzij`);
  await axe(sp, 'telefoon-kaart 360 px (donker)');
  step(`360 px: de kaart past, QR-code ${Math.round(box?.width || 0)} px`);
  await small.close();
} catch (e) {
  fail(e.stack || e.message);
} finally {
  await phone?.close().catch(() => undefined);
  await browser.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}
console.log(failures.length ? `MISLUKT (${failures.length})` : 'OK');
process.exit(failures.length ? 1 : 0);
