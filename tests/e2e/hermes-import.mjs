// "Overstappen uit Hermes Agent" as the owner uses it (TeamBot 0.4.4, PARITEIT 1.7): from Instellingen › Overstappen to
// the import screen, choose Hermes Agent, read a fake Hermes folder (tests/fixtures/hermes; never a real one), see what
// comes over (keys never), import, find the bots, undo; Grok Bot says plainly there is nothing to import. Also at 360 px.
// Edge/Chrome headless, temp data dir and HOME, a free port (TEAMBOT_E2E_PORT to fix one; never 4747/4748).
// Usage: npm run build:ui && node --import tsx tests/e2e/hermes-import.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const step = (s) => console.log(`• ${s}`);
const fail = (s) => {
  console.error(`✗ ${s}`);
  process.exitCode = 1;
};
const port = Number(process.env.TEAMBOT_E2E_PORT) || 0;
if (port === 4747 || port === 4748) throw new Error('4747/4748 zijn van de geïnstalleerde TeamBot');

// The browser first (it needs this PC's environment), then TeamBot with an empty HOME: no real ~/.hermes is ever read.
const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-e2e-hermes-home-'));
Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') });
delete process.env.HERMES_HOME;
delete process.env.TEAMBOT_HERMES_HOME;
delete process.env.TEAMBOT_DATA;

const { createApp } = await import('./server.mjs');
const { HERMES_DECOYS, makeHermesFixture, snapshotFolder } = await import('../fixtures/hermes/fixture.ts');
const hx = makeHermesFixture();
const before = snapshotFolder(hx.home);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-e2e-hermes-'));
const app = await createApp({ dataDir: dir, port, host: '127.0.0.1', mode: 'desktop', quiet: true });
for (const k of app.ctx.providers.kinds.values()) if (k.detect) k.detect = async () => ({ installed: false, detail: 'e2e' });
const token = app.ctx.auth.ensureLocalOwner();
const api = async (method, p) => (await fetch(`${app.url}/api${p}`, { method, headers: { authorization: `Bearer ${token}` } })).json();
step(`TeamBot op ${app.url}`);
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const errors = [];
const failed = [];
async function check(page, name) {
  await page.waitForTimeout(400);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) fail(`${name}: de pagina schuift ${overflow}px opzij`);
  await page.addScriptTag({ content: axeSource });
  const v = await page.evaluate(async () => {
    // @ts-ignore
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
    return r.violations.map((x) => `${x.id}: ${x.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`);
  });
  if (v.length) fail(`a11y ${name}: ${v.join(' | ')}`);
  if (failed.length) fail(`${name}: mislukte verzoeken: ${failed.splice(0).join(', ')}`);
  if (errors.length) fail(`${name}: paginafouten: ${errors.splice(0).join(' | ')}`);
}

try {
  for (const [label, viewport] of [
    ['computer', { width: 1280, height: 900 }],
    ['360 px', { width: 360, height: 800 }],
  ]) {
    const page = await (await browser.newContext({ viewport, locale: 'nl-NL', bypassCSP: true })).newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !/favicon|401 \(Unauthorized\)/.test(m.text()) && errors.push(m.text()));
    page.on('response', (r) => new URL(r.url()).pathname.startsWith('/api/') && r.status() >= 400 && failed.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`));
    await page.goto(`${app.url}/#token=${token}`);
    await page.waitForTimeout(600);

    // Instellingen › Overstappen: the way in, with Grok Bot said plainly.
    await page.goto(`${app.url}/#/settings/openbot-import-overstappen`);
    // The other apps are in the fold "Uit een andere app" (open by itself when there is no OpenBot).
    await page.getByTestId('more-options').first().waitFor({ state: 'attached', timeout: 10000 });
    await page.evaluate(() => document.querySelectorAll('[data-testid="more-options"]').forEach((x) => (x.open = true)));
    await page.getByText('Grok Bot kun je niet importeren: het heeft geen export en bewaart niets op je computer.', { exact: false }).first().waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: 'Overstappen uit Hermes Agent' }).click();
    await page.getByRole('heading', { name: 'Overstappen uit Hermes Agent' }).waitFor({ timeout: 10000 });
    await page.getByText('Hermes Agent niet gevonden in de standaardmap').waitFor({ timeout: 10000 });
    await check(page, `${label}: Hermes, niets gevonden`);
    step(`${label}: Instellingen › Overstappen noemt Hermes Agent en zegt dat Grok Bot niet kan; het importscherm vindt geen Hermes in de (lege) standaardmap`);

    // Read the fake folder, see what comes over.
    await page.getByRole('textbox', { name: 'Hermes-map' }).fill(hx.home);
    await page.getByRole('button', { name: 'Hermes inlezen' }).click();
    await page.getByText('Dit is een voorvertoning', { exact: false }).waitFor({ timeout: 15000 });
    const text = await page.locator('body').innerText();
    for (const want of ['Hermes', 'Schrijver', 'factuur-check', 'van Hermes zelf (MIT)', 'Ochtendbriefing', 'staan uit tot jij ze aanzet', 'Sleutels, tokens en logins (.env, auth.json)']) if (!text.includes(want)) fail(`${label}: voorbeeld mist "${want}"`);
    if (/anthropic\/claude-opus/.test(text)) fail(`${label}: ruwe modelcode in het voorbeeld`);
    const html = await page.content();
    for (const d of HERMES_DECOYS) if (html.includes(d)) fail(`${label}: een sleutel uit Hermes staat in de pagina`);
    await check(page, `${label}: Hermes-voorbeeld`);
    step(`${label}: voorbeeld met 2 bots, skills (eigen aan, die van Hermes zelf uit), geplande taken die uit komen, wat niet meekomt; geen sleutel in de pagina`);

    // Import, then undo.
    await page.getByRole('button', { name: 'Importeren', exact: true }).click();
    await page.getByText('Je Hermes-bots zijn overgenomen').waitFor({ timeout: 15000 });
    const names = (await api('GET', '/agents')).map((a) => a.name).sort();
    if (names.join() !== 'Hermes,Schrijver') fail(`${label}: bots na import: ${names.join(', ')}`);
    const routines = await api('GET', '/routines');
    if (routines.length !== 4 || routines.some((r) => r.status !== 'paused')) fail(`${label}: routines: ${routines.map((r) => `${r.name}=${r.status}`).join(', ')}`);
    await check(page, `${label}: Hermes overgenomen`);
    await page.getByRole('button', { name: 'Import ongedaan maken' }).click();
    await page.getByRole('dialog').getByText('Dit haalt weg wat de import uit Hermes Agent in TeamBot heeft gemaakt:').waitFor({ timeout: 10000 });
    await check(page, `${label}: ongedaan maken`);
    await page.getByRole('dialog').getByRole('button', { name: 'Ongedaan maken' }).click();
    await page.getByText('De import is ongedaan gemaakt').waitFor({ timeout: 15000 });
    await page.getByText('Hermes Agent zelf is niet veranderd.', { exact: false }).waitFor({ timeout: 5000 });
    if ((await api('GET', '/agents')).length) fail(`${label}: na ongedaan maken staan er nog bots`);
    step(`${label}: importeren maakt 2 bots en 4 routines die uit staan; ongedaan maken haalt alles weg`);

    // Grok Bot.
    await page.getByRole('tab', { name: 'Grok Bot' }).click();
    await page.getByText('Grok Bot kun je niet importeren.').waitFor({ timeout: 5000 });
    await page.getByText('Grok Bot heeft geen exportfunctie en bewaart niets op je computer', { exact: false }).waitFor({ timeout: 5000 });
    await check(page, `${label}: Grok Bot`);
    // OpenBot stays the default tab, as before.
    await page.getByRole('tab', { name: 'OpenBot' }).click();
    await page.getByRole('heading', { name: 'Overstappen uit OpenBot' }).waitFor({ timeout: 5000 });
    step(`${label}: Grok Bot zegt eerlijk dat er niets te importeren is (geen export, niets op de computer); OpenBot blijft het eerste tabblad`);
    await page.context().close();
  }
  const after = snapshotFolder(hx.home);
  if (after.size !== before.size || [...before].some(([f, h]) => after.get(f) !== h)) fail('de Hermes-map is veranderd');
  else step('de Hermes-map is niet aangeraakt (alle bestanden en tijden gelijk)');
} catch (e) {
  fail(String(e?.stack || e));
} finally {
  await browser.close();
  await app.close();
  hx.cleanup();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
if (!process.exitCode) step('klaar: alles geslaagd');
