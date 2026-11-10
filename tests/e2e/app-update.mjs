// Automatic updates in Instellingen › Back-ups (parity 16.2), as the owner sees them on the computer, in Edge headless
// on a free port. The desktop app's update flow (desktop/update-flow.ts) runs with a fake electron-updater (the same
// events; nothing is downloaded or installed) and a channel built into "the release"; the server's /api/app-update is
// the real one. Steps: the calm status → Nu controleren finds 99.5.0, Automatisch bijwerken (on) downloads it and the
// page says what it waits for (you are at the computer) → Alleen melden → Nu bijwerken installs at once (a stub) →
// Geavanceerd: the update channel typed and saved. No console errors or failed requests; axe-core WCAG 2.2 AA.
// The same card on a paired phone is in tests/e2e/phone-owner.mjs. The real electron-updater against a local feed is
// tests/update-feed.test.ts.
// Usage: npm run build:ui && node --import tsx tests/e2e/app-update.mjs   (TEAMBOT_E2E_PORT, TEAMBOT_E2E_SHOTS=<dir>)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const step = (s) => console.log(`• ${s}`);
const fail = (s) => {
  console.error(`✗ ${s}`);
  process.exitCode = 1;
};
const SHOTS = process.env.TEAMBOT_E2E_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

// The browser first (it needs this PC's environment), then TeamBot in an empty one (never the owner's AppData).
const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-app-update-home-'));
Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') });
delete process.env.TEAMBOT_DATA;
delete process.env.TEAMBOT_UPDATE_URL;
delete process.env.TEAMBOT_UPDATE_CHANNEL;

const { createApp } = await import('../../server/app.ts');
const { UpdateFlow } = await import('../../desktop/update-flow.ts');
const { updateBlockers } = await import('../../server/modules/backups/app-update.ts');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-app-update-'));
const app = await createApp({ dataDir: dir, port: Number(process.env.TEAMBOT_E2E_PORT) || 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();

/** Plays electron-updater (same events), with version 99.5.0 on the channel. */
class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowDowngrade = true;
  logger = null;
  installs = 0;
  feed = null;
  setFeedURL(o) {
    this.feed = o;
  }
  async checkForUpdates() {
    this.emit('checking-for-update');
    await new Promise((r) => setTimeout(r, 200));
    this.emit('update-available', { version: '99.5.0' });
  }
  async downloadUpdate() {
    for (const p of [30, 70]) {
      await new Promise((r) => setTimeout(r, 150));
      this.emit('download-progress', { percent: p });
    }
    this.emit('update-downloaded', { version: '99.5.0', files: [{ url: 'TeamBot-Setup-99.5.0.exe' }] });
  }
  quitAndInstall() {
    this.installs++;
  }
}
const fake = new FakeUpdater();
const quits = [];
const flow = new UpdateFlow({
  updater: fake,
  version: app.ctx.config.version,
  packaged: true,
  configDir: path.join(dir, 'electron'),
  dataDir: dir,
  platform: 'win32',
  env: {},
  builtIn: { provider: 'generic', url: 'https://downloads.voorbeeld.nl/teambot/' },
  // The owner is at the computer (keyboard a moment ago): an automatic install waits.
  idleFacts: () => ({ busy: updateBlockers(app.ctx), userIdleSeconds: 3 }),
  timing: { firstCheckMs: 3600_000, idlePollMs: 200 },
  onChange: () => app.ctx.events.emit(owner.id, 'app-update.changed', {}),
});
flow.requestQuit = () => quits.push(flow.state.version);
app.ctx.services.appUpdate = { info: () => flow.info(), check: () => flow.check(), download: () => flow.download(), installNow: () => flow.installNow(), save: (p) => flow.save(p) };
flow.start();
const api = async (method, p, body) => {
  const r = await fetch(app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};
step(`TeamBot op ${app.url} (lege datamap ${dir})`);

// bypassCSP only so axe-core can be injected (as in the other e2e checks).
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'nl-NL', bypassCSP: true });
const page = await ctx.newPage();
const errors = [];
const failed = [];
page.on('pageerror', (e) => errors.push(String(e?.message || e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('response', (r) => r.status() >= 400 && failed.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`));
const shot = async (n) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${n}.png`), fullPage: true });
const main = page.locator('#inhoud');
const card = main.getByTestId('app-update');
const wait = (text, what, ms = 8000) => card.getByText(text, { exact: false }).first().waitFor({ timeout: ms }).then(() => true, () => (fail(what), false));
async function axe(name) {
  await page.addScriptTag({ content: axeSource });
  const v = await page.evaluate(async () => {
    // @ts-ignore
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
    return r.violations.map((x) => `${x.id}: ${x.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`);
  });
  if (v.length) fail(`a11y ${name}: ${v.join(' | ')}`);
}

try {
  await page.goto(`${app.url}/#token=${token}`);
  await page.waitForTimeout(800);
  await page.evaluate(() => (location.hash = '#/settings/backups'));
  await card.waitFor({ timeout: 15000 });
  await wait('TeamBot kijkt eens per dag of er een nieuwe versie is.', 'rustige stand: niet gezegd dat TeamBot eens per dag kijkt');
  const sel = card.getByLabel('Automatisch bijwerken');
  // TeamBot's own dropdown (components/Listbox.tsx): the button carries the value, the options have data-value.
  if ((await sel.getAttribute('data-value')) !== 'on') fail('Automatisch bijwerken staat niet standaard aan');
  if (await card.getByLabel('Adres van het updatekanaal').count()) fail('het updatekanaal staat in beeld zonder Geavanceerd');
  await axe('back-ups');
  await shot('updates-rustig');
  step('Back-ups › Updates: rustig ("kijkt eens per dag"), Automatisch bijwerken staat aan, het kanaal zit onder Geavanceerd');

  await card.getByRole('button', { name: 'Nu controleren' }).click();
  await wait('Versie 99.5.0 staat klaar.', 'Nu controleren: 99.5.0 niet vanzelf gedownload', 10000);
  await wait('TeamBot wacht nog, want je gebruikt de computer.', 'niet gezegd waarop de update wacht');
  if (quits.length) fail('geïnstalleerd terwijl de eigenaar aan de computer zit');
  await shot('updates-wacht');
  step('Nu controleren → 99.5.0 op de achtergrond gedownload; de pagina zegt: wacht nog, want je gebruikt de computer');

  await sel.click();
  await page.locator('[role="listbox"] [role="option"][data-value="notify"]').click();
  await wait('TeamBot installeert hem als je op Nu bijwerken klikt of TeamBot afsluit.', 'Alleen melden: uitleg ontbreekt');
  if ((await api('GET', '/app-update')).auto !== 'notify') fail('Alleen melden niet opgeslagen');
  await card.getByRole('button', { name: 'Nu bijwerken' }).click();
  for (let i = 0; i < 40 && !quits.length; i++) await page.waitForTimeout(100);
  if (quits.join() !== '99.5.0') fail(`Nu bijwerken: niet geïnstalleerd (${quits.join() || 'niets'})`);
  if (fake.installs) fail('quitAndInstall zonder back-up vooraf (dat doet will-quit pas)');
  step('Alleen melden opgeslagen; Nu bijwerken installeert meteen (geen taak loopt; de eigenaar vroeg het), via afsluiten met back-up vooraf');

  const st = await api('GET', '/settings');
  await api('PUT', '/settings', { ui: { ...(st.ui || {}), advanced: true } });
  await page.reload();
  await page.evaluate(() => (location.hash = '#/settings/backups'));
  await card.waitFor({ timeout: 15000 });
  const field = card.getByLabel('Adres van het updatekanaal');
  await field.waitFor({ timeout: 8000 }).catch(() => fail('Geavanceerd: geen veld voor het updatekanaal'));
  await wait('Ingebouwd in deze versie: https://downloads.voorbeeld.nl/teambot/', 'Geavanceerd: niet gezegd welk kanaal in deze versie zit');
  await field.fill('http://downloads.voorbeeld.nl/');
  await card.getByRole('button', { name: 'Opslaan' }).click();
  await page.getByText('Het updatekanaal moet https gebruiken', { exact: false }).first().waitFor({ timeout: 5000 }).catch(() => fail('geen uitleg bij een adres zonder https'));
  const refused = failed.indexOf('400 PUT /api/app-update/channel');
  if (refused < 0) fail('het adres zonder https werd niet geweigerd door de server');
  else failed.splice(refused, 1);
  errors.length = 0; // the toast of the refused address is expected; the 400 is in the console
  await field.fill('github:teambot-app/teambot');
  await card.getByRole('button', { name: 'Opslaan' }).click();
  for (let i = 0; i < 30 && (await api('GET', '/app-update')).channel.source !== 'saved'; i++) await page.waitForTimeout(100);
  const v = await api('GET', '/app-update');
  if (v.channel.source !== 'saved' || v.channel.text !== 'github.com/teambot-app/teambot') fail(`kanaal niet opgeslagen: ${JSON.stringify(v.channel)}`);
  if (fake.feed?.provider !== 'github') fail('electron-updater kreeg GitHub Releases niet');
  await axe('back-ups geavanceerd');
  await shot('updates-kanaal');
  step('Geavanceerd: een adres zonder https wordt rustig geweigerd; github:teambot-app/teambot opgeslagen (GitHub Releases)');

  if (failed.length) fail(`mislukte verzoeken: ${failed.join(', ')}`);
  if (errors.length) fail(`paginafouten: ${errors.join(' | ')}`);
} catch (e) {
  fail(String(e?.stack || e));
} finally {
  flow.stop();
  await browser.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
if (!process.exitCode) step('geslaagd');
