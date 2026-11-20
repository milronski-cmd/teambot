// The bank through the screens, in an empty data folder, against a local stand-in for Enable Banking:
//   node --import tsx tests/e2e/bank.mjs
// Apps › Bank: fill in the application, choose a bank, give permission "at the bank" (the stand-in sends the code back),
// see the accounts with masked numbers, and press Test. Needs `npm run build:ui` first. Screenshots in SHOTS_DIR.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const ROOT = path.resolve(process.env.TEAMBOT_E2E_DIR || '.data/bank-e2e');
const SHOTS = process.env.SHOTS_DIR || path.join(ROOT, 'shots');
const dir = path.join(ROOT, 'run');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
process.env.XDG_DOCUMENTS_DIR = path.join(ROOT, 'documents');
fs.mkdirSync(process.env.XDG_DOCUMENTS_DIR, { recursive: true });
process.env.TEAMBOT_TEST_NO_STARTER_RULES = '1';

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const APP_ID = '1a2b3c4d-1234-5678-9abc-1a2b3c4d5e6f';
const auths = [];
const bank = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = new URL(req.url || '/', 'http://x');
    const p = url.pathname;
    const json = (code, v) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(v)));
    if (p === '/aspsps') return json(200, { aspsps: ['ABN AMRO', 'ING', 'Rabobank', 'bunq', 'Knab'].map((name) => ({ name, country: url.searchParams.get('country'), logo: '', psu_types: ['personal', 'business'], auth_methods: [], maximum_consent_validity: 180 * 86400, beta: false })) });
    if (p === '/auth') return (auths.push(JSON.parse(body)), json(200, { url: 'https://auth.enablebanking.com/ais/start?sessionid=s1', authorization_id: 'a1' }));
    if (p === '/sessions' && req.method === 'POST')
      return json(200, { session_id: 'sess-1', aspsp: { name: 'Rabobank', country: 'NL' }, access: { valid_until: new Date(Date.now() + 180 * 86400_000).toISOString() }, accounts: [{ uid: 'acc-1', account_id: { iban: 'NL91RABO0417164300' }, name: 'Zakelijke rekening', currency: 'EUR' }, { uid: 'acc-2', account_id: { iban: 'NL02RABO0123456789' }, name: 'Spaarrekening', currency: 'EUR' }] });
    if (/\/accounts\/acc-\d\/balances/.test(p)) return json(200, { balances: [{ name: 'Booked', balance_amount: { currency: 'EUR', amount: '1234.56' }, balance_type: 'CLBD' }] });
    if (req.method === 'DELETE') return json(200, { message: 'OK' });
    json(404, { error: 'NOT_FOUND', message: p, code: 404 });
  });
});
await new Promise((r) => bank.listen(0, '127.0.0.1', r));
process.env.TEAMBOT_BANK_BASE = `http://127.0.0.1:${bank.address().port}`;

const { createApp } = await import('./server.mjs');
const app = await createApp({ dataDir: dir, port: Number(process.env.PORT || 4793), host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const shot = async (name) => {
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SHOTS, `bank-${name}.png`), fullPage: true });
    console.log(`  schermafbeelding: bank-${name}.png`);
  };
  await page.goto(`${app.url}/#token=${token}`);
  await page.waitForTimeout(1500);
  await page.goto(`${app.url}/#/m/mcp`);
  const card = page.getByTestId('bank-card');
  await card.waitFor({ timeout: 15000 });
  check('Apps toont de kaart Bank', /Alleen lezen, nooit betalen/.test(await card.innerText()));
  await shot('1-kaart');

  await page.getByTestId('bank-start').click();
  await page.getByTestId('bank-app-form').waitFor();
  check('het formulier noemt het terugkeeradres van TeamBot', /\/api\/public\/mcp\/bank\/callback/.test(await page.getByTestId('bank-app-form').locator('input[readonly]').first().inputValue()));
  await shot('2-applicatie');
  await page.getByLabel('Applicatie-ID').fill(APP_ID);
  await page.getByLabel('Sleutel van de applicatie').fill(PEM);
  await page.getByTestId('bank-app-save').click();
  await page.getByTestId('bank-link-form').waitFor({ timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="bank-choice"] option').length > 3);
  await shot('3-bank-kiezen');
  await page.getByTestId('bank-choice').selectOption('Rabobank');
  // The bank's own page opens in a new window; the stand-in has no page, so that window is closed again.
  page.context().on('page', (p) => p.close().catch(() => {}));
  await page.getByTestId('bank-link').click();
  await page.getByTestId('bank-waiting').waitFor({ timeout: 15000 });
  await shot('4-wachten');
  check('de bank kreeg het adres van TeamBot en de gekozen bank', auths.length === 1 && auths[0].aspsp.name === 'Rabobank' && /\/api\/public\/mcp\/bank\/callback$/.test(auths[0].redirect_url));
  // The owner said yes at the bank: the bank sends him back to TeamBot with a code.
  const back = await fetch(`${auths[0].redirect_url}?code=code-1&state=${auths[0].state}`);
  check('terug van de bank: gekoppeld', back.status === 200 && /Rabobank is gekoppeld/.test(await back.text()));
  await page.getByTestId('bank-links').waitFor({ timeout: 15000 });
  const text = await card.innerText();
  check('de kaart toont de rekeningen met afgeschermd nummer', /Zakelijke rekening/.test(text) && /NL91 •••• 4300/.test(text) && !/NL91RABO0417164300/.test(text), text.replace(/\s+/g, ' ').slice(0, 200));
  await shot('5-gekoppeld');
  await card.getByRole('button', { name: 'Test', exact: true }).click();
  await page.getByText('Verbinding werkt: het saldo is gelezen.').waitFor({ timeout: 20000 });
  check('Test leest het saldo', true);
  await shot('6-test');
} catch (e) {
  check('de schermronde liep door', false, String(e?.message || e).split('\n')[0]);
} finally {
  await browser.close();
  await app.close();
  bank.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}
