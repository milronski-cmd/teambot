// "Sleutels voor scripts" as the owner uses it (TeamBot 0.4.3): in the bot editor he adds SHOPIFY_TOKEN for one bot,
// sees it listed (never the value), the bot runs a command that prints it and the chat shows only [verborgen: …],
// he takes it away again; Kluis lists every key (new value, delete) and Skills › Veiligheid says that trusted scripts
// get the bot's keys (0.4.4); on a paired phone the same section only says that this is done on the computer.
// Edge/Chrome headless, temp data dir, a free port (TEAMBOT_E2E_PORT to fix one; never 4747/4748).
// Usage: npm run build:ui && node --import tsx tests/e2e/script-keys.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const { createApp } = await import('../../server/app.ts');
const { mockAdapter } = await import('../helpers.ts');
const { axeCheck } = await import('./axe-check.mjs');

const step = (s) => console.log(`• ${s}`);
const fail = (s) => {
  console.error(`✗ ${s}`);
  process.exitCode = 1;
};
const VALUE = 'shpat_' + 'e2eW8x7Y6z5A4b3C2d1';
const port = Number(process.env.TEAMBOT_E2E_PORT) || 0;
if (port === 4747 || port === 4748) throw new Error('4747/4748 zijn van de geïnstalleerde TeamBot');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-e2e-scriptkeys-'));
const app = await createApp({ dataDir: dir, port, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();
const script = [];
app.ctx.providers.registerKind({ id: 'mock', label: 'Testmodel', type: 'api', billing: 'local', needsKey: false, description: 'e2e', models: ['mock-1'], defaultModel: 'mock-1', create: () => mockAdapter(script, []) });
const prov = app.ctx.providers.create(owner.id, { kind: 'mock', name: 'Testmodel' });
const bot = app.ctx.store.createAgent(owner.id, { name: 'Winkelbot', role: 'Test', provider_id: prov.id, model: 'mock-1', access_mode: 'auto', tool_groups: ['shell'] });
step(`TeamBot op ${app.url}`);

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, bypassCSP: true })).newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/favicon|401 \(Unauthorized\)/.test(m.text()) && errors.push(m.text()));
  await page.goto(`${app.url}/#token=${token}`);
  await page.waitForTimeout(600);
  await page.goto(`${app.url}/#/agents/${bot.id}/edit`);
  await page.getByRole('button', { name: /^Sleutels voor scripts/ }).first().click();
  await page.getByRole('button', { name: 'Sleutel toevoegen' }).click();
  await page.getByPlaceholder('SHOPIFY_TOKEN').fill('shopify token');
  await page.getByLabel('Sleutel of wachtwoord').fill(VALUE);
  await page.getByPlaceholder('Bijvoorbeeld: webwinkel Shopify').fill('Webwinkel');
  await page.locator('[data-testid="script-keys"] button[type="submit"]').click();
  await page.locator('[data-testid="script-keys"]').getByText('SHOPIFY_TOKEN', { exact: true }).waitFor({ timeout: 8000 });
  const html = await page.content();
  if (html.includes(VALUE)) fail('de waarde staat in de pagina');
  if (!(await page.locator('[data-testid="script-keys"]').getByText('klaar').count())) fail('de sleutel staat niet als klaar');
  step('bot-editor: SHOPIFY_TOKEN toegevoegd (naam omgezet), staat als “klaar”, waarde nergens in de pagina');

  // the bot uses it: the command prints the key, the chat only shows the name
  const th = app.ctx.chat.threadForAgent(owner.id, bot.id);
  const cmd = process.platform === 'win32' ? 'Write-Output "sleutel=$env:SHOPIFY_TOKEN"' : 'echo "sleutel=$SHOPIFY_TOKEN"';
  script.push({ toolCalls: [{ name: 'run_command', args: { command: cmd } }] }, { text: 'Gedaan.' });
  await fetch(`${app.url}/api/threads/${th.id}/messages`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ content: 'gebruik de sleutel' }) });
  const end = Date.now() + 30_000;
  while (Date.now() < end && app.ctx.store.all("SELECT id FROM runs WHERE thread_id = ? AND status IN ('queued','running','waiting')", th.id).length) await new Promise((r) => setTimeout(r, 100));
  const tool = app.ctx.store.messages(th.id).find((m) => m.role === 'tool');
  if (!tool || !/sleutel=\[verborgen: \$SHOPIFY_TOKEN\]/.test(tool.content)) fail(`opdracht-uitvoer niet afgeschermd: ${tool?.content}`);
  await page.goto(`${app.url}/#/t/${th.id}`);
  await page.getByText('Gedaan.').first().waitFor({ timeout: 15000 });
  if ((await page.content()).includes(VALUE)) fail('de waarde staat in de chat');
  step('de bot draaide een opdracht die de sleutel afdrukt: in de chat en het transcript alleen [verborgen: $SHOPIFY_TOKEN]');

  // take it away
  await page.goto(`${app.url}/#/agents/${bot.id}/edit`);
  await page.waitForTimeout(800);
  // the editor remembers the open section
  if (!(await page.locator('[data-testid="script-keys"]').isVisible())) await page.getByRole('button', { name: /^Sleutels voor scripts/ }).first().click();
  await page.locator('[data-testid="script-keys"]').getByRole('button', { name: 'Weghalen' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Weghalen' }).click();
  await page.locator('[data-testid="script-keys"]').getByText('Deze bot heeft nog geen sleutels voor scripts.').waitFor({ timeout: 8000 });
  step('weggehaald: de bot heeft geen sleutels meer (de sleutel zelf blijft bewaard om aan een andere bot te geven)');

  // Kluis: one list of every script key (0.4.4): who gets it, last used, a new value, delete
  await page.goto(`${app.url}/#/m/browser/kluis`);
  const ov = page.locator('[data-testid="script-keys-overview"]');
  await ov.getByText('SHOPIFY_TOKEN', { exact: true }).waitFor({ timeout: 8000 });
  if (!(await ov.getByText('Nog bij geen enkele bot').count())) fail('Kluis: de sleutel staat niet als “nog bij geen enkele bot”');
  if (!(await ov.getByText(/laatst gebruikt/).count())) fail('Kluis: “laatst gebruikt” ontbreekt');
  if ((await page.content()).includes(VALUE)) fail('Kluis: de waarde staat in de pagina');
  const a11yList = await axeCheck(page);
  if (a11yList.length) fail(`Kluis (toegankelijkheid): ${a11yList.join(' | ')}`);
  await ov.getByRole('button', { name: 'Nieuwe waarde' }).click();
  await page.getByRole('dialog').getByLabel('Nieuwe sleutel of wachtwoord').waitFor();
  const a11yModal = await axeCheck(page);
  if (a11yModal.length) fail(`Kluis › Nieuwe waarde (toegankelijkheid): ${a11yModal.join(' | ')}`);
  await page.getByRole('dialog').getByLabel('Nieuwe sleutel of wachtwoord').fill(VALUE + 'nieuw');
  await page.getByRole('dialog').getByRole('button', { name: 'Opslaan' }).click();
  await page.getByText('Nieuwe waarde opgeslagen').first().waitFor({ timeout: 8000 });
  const renewed = app.ctx.services.scriptKeys.scrub(owner.id, `x=${VALUE}nieuw`);
  if (!renewed.includes('[verborgen: $SHOPIFY_TOKEN]')) fail('Kluis: de nieuwe waarde wordt niet afgeschermd');
  step('Kluis: SHOPIFY_TOKEN in het overzicht (bij geen bot, laatst gebruikt), nieuwe waarde opgeslagen, waarde nergens in de pagina; axe: geen ernstige problemen (lijst en venster)');
  await ov.getByRole('button', { name: 'Sleutel SHOPIFY_TOKEN verwijderen' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Verwijderen' }).click();
  await ov.getByText('Nog geen sleutels voor scripts').waitFor({ timeout: 8000 });
  step('Kluis: sleutel verwijderd, het overzicht is leeg');

  // Skills › Veiligheid: trusting scripts says that they also get the bot's script keys
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addFile('tool/SKILL.md', Buffer.from('---\nname: scripttool\ndescription: Heeft een script.\n---\n\nGebruik scripts/run.py.\n'));
  zip.addFile('tool/scripts/run.py', Buffer.from('print("hallo")'));
  const auth = { authorization: `Bearer ${token}` };
  const up = await (await fetch(`${app.url}/api/skills/import/zip?name=x.zip`, { method: 'POST', headers: { ...auth, 'content-type': 'application/zip' }, body: new Uint8Array(zip.toBuffer()) })).json();
  const done = await (await fetch(`${app.url}/api/skills/import/commit`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ stagingId: up.stagingId }) })).json();
  await page.goto(`${app.url}/#/m/skills/mine/${done.results[0].skillId}`);
  await page.getByRole('tab', { name: 'Veiligheid' }).click();
  await page.getByText(/maar wel de sleutels voor scripts die je de bot hebt gegeven/).waitFor({ timeout: 8000 });
  await page.getByRole('button', { name: 'Vertrouw deze skill…' }).click();
  await page.getByText(/een vertrouwd script krijgt ook de sleutels voor scripts van de bot/).waitFor({ timeout: 8000 });
  await page.keyboard.press('Escape');
  step('Skills › Veiligheid: de uitleg en het vertrouw-venster zeggen dat vertrouwde scripts de sleutels voor scripts van de bot krijgen');

  // the paired phone: the section says calmly it is done on the computer
  const ticket = await (await fetch(`${app.url}/api/mobile/pair`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ baseUrl: app.url }) })).json();
  const secret = new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('t');
  const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TeamBotiOS/0.4.3';
  const claimed = await (await fetch(`${app.url}/api/public/mobile/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA }, body: JSON.stringify({ secret, name: 'iPhone', platform: 'ios', client: 'ios-app' }) })).json();
  const phoneCtx = await browser.newContext({ viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true, userAgent: UA });
  await phoneCtx.addInitScript((t) => localStorage.setItem('tb_token', t), claimed.token);
  const phone = await phoneCtx.newPage();
  const phoneFails = [];
  phone.on('pageerror', (e) => phoneFails.push(e.message));
  phone.on('response', (r) => r.url().includes('/api/script-keys') && phoneFails.push(`verzoek ${r.url()} → ${r.status()}`));
  await phone.goto(`${app.url}/#/agents/${bot.id}/edit`);
  await phone.getByRole('button', { name: /^Sleutels voor scripts/ }).first().click();
  await phone.getByText('Sleutels voor scripts beheer je op je computer.').waitFor({ timeout: 8000 });
  if (phoneFails.length) fail(`telefoon: ${phoneFails.join('; ')}`);
  const deny = await fetch(`${app.url}/api/script-keys`, { headers: { authorization: `Bearer ${claimed.token}` } });
  if (deny.status !== 403) fail(`telefoon mocht /script-keys openen (${deny.status})`);
  step('gekoppelde telefoon: de sectie zegt rustig “beheer je op je computer”, geen mislukte verzoeken; de API geeft 403');
  await phone.goto(`${app.url}/#/m/browser/kluis`);
  await phone.getByText('De kluis met wachtwoorden open je alleen op je computer.').waitFor({ timeout: 8000 });
  if (await phone.locator('[data-testid="script-keys-overview"]').count()) fail('telefoon: het sleuteloverzicht staat in de Kluis');
  if (phoneFails.length) fail(`telefoon (Kluis): ${phoneFails.join('; ')}`);
  step('gekoppelde telefoon › Kluis: geen sleuteloverzicht en geen verzoeken naar /script-keys');
  if (errors.length) fail(`paginafouten: ${errors.join(' | ')}`);
} catch (e) {
  fail(String(e?.stack || e));
} finally {
  await browser.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
if (!process.exitCode) step('klaar: alles geslaagd');
