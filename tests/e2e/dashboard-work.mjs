// The dashboard as the owner's workplace, through the screen, in an empty data folder:
//   node --import tsx tests/e2e/dashboard-work.mjs
// The mail and the money come from stand-ins at the page (the routes themselves: tests/mcp-google.test.ts and
// tests/mcp-bank.test.ts). Checked: every part is there, a part that is not connected says how to connect it, a mail
// opens and an answer goes out, the tiles of the bots still show. Needs `npm run build:ui` first.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const ROOT = path.resolve(process.env.TEAMBOT_E2E_DIR || '.data/dashboard-e2e');
const SHOTS = process.env.SHOTS_DIR || path.join(ROOT, 'shots');
const dir = path.join(ROOT, 'run');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
process.env.XDG_DOCUMENTS_DIR = path.join(ROOT, 'documents');
fs.mkdirSync(process.env.XDG_DOCUMENTS_DIR, { recursive: true });
process.env.TEAMBOT_TEST_NO_STARTER_RULES = '1';

const { createApp } = await import('./server.mjs');
const app = await createApp({ dataDir: dir, port: Number(process.env.PORT || 4794), host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const api = async (method, p, body) => {
  const res = await fetch(app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${j.error}`);
  return j;
};
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const MAIL = [
  { id: 'm1', thread: 't1', from: 'Jan de Vries <jan@klant.test>', to: 'ik@voorbeeld.nl', subject: 'Levering van bestelling 2041', date: new Date(Date.now() - 20 * 60_000).toUTCString(), unread: true, snippet: 'Kunnen jullie morgen nog leveren? Ik heb de onderdelen donderdag nodig.' },
  { id: 'm2', thread: 't2', from: 'Sanne Bakker <sanne@partner.test>', to: 'ik@voorbeeld.nl', subject: 'Offerte voor de nieuwe site', date: new Date(Date.now() - 3 * 3600_000).toUTCString(), unread: true, snippet: 'In de bijlage vind je de offerte. Laat je weten of dit past?' },
  { id: 'm3', thread: 't3', from: 'Boekhouder <info@boekhouder.test>', to: 'ik@voorbeeld.nl', subject: 'Btw-aangifte derde kwartaal', date: new Date(Date.now() - 26 * 3600_000).toUTCString(), unread: false, snippet: 'De aangifte staat klaar ter controle.' },
];
const BANK = {
  status: 'on',
  from: '2026-11-06',
  to: '2026-11-20',
  accounts: [
    { bank: 'Rabobank', name: 'Zakelijke rekening', iban: 'NL91 •••• 4300', currency: 'EUR', balances: [{ name: 'geboekt', amount: 12480.55, currency: 'EUR' }] },
    { bank: 'Rabobank', name: 'Spaarrekening', iban: 'NL02 •••• 6789', currency: 'EUR', balances: [{ name: 'geboekt', amount: 9000, currency: 'EUR' }] },
  ],
  transactions: [
    { date: '2026-11-19', amount: 250, currency: 'EUR', counterparty: 'Klant B.V.', description: 'Order 2041', status: 'geboekt', account: 'Zakelijke rekening' },
    { date: '2026-11-18', amount: -59, currency: 'EUR', counterparty: 'TransIP B.V.', description: 'Factuur 2026-118', status: 'geboekt', account: 'Zakelijke rekening' },
    { date: '2026-11-17', amount: -412.3, currency: 'EUR', counterparty: 'Belastingdienst', description: 'Loonheffing oktober', status: 'geboekt', account: 'Zakelijke rekening' },
  ],
};

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || 'msedge', headless: true });
try {
  const prov = await api('POST', '/providers', { kind: 'ollama', config: { baseUrl: 'http://127.0.0.1:11434' } });
  await api('POST', '/agents', { name: 'Ada', role: 'Klantenservice', provider_id: prov.id, model: 'x' });
  await api('POST', '/agents', { name: 'Bo', role: 'Boekhouding', provider_id: prov.id, model: 'x' });
  const page = await browser.newPage({ viewport: { width: 1360, height: 1100 } });
  const shot = async (name) => {
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SHOTS, `dashboard-${name}.png`) });
    console.log(`  schermafbeelding: dashboard-${name}.png`);
  };
  await page.goto(`${app.url}/#token=${token}`);
  await page.waitForTimeout(1500);

  // Nothing connected yet: every part says how to connect it, nothing is an error.
  await page.goto(`${app.url}/#/dashboard`);
  await page.getByTestId('dashboard-mail').waitFor({ timeout: 15000 });
  await page.waitForTimeout(1500);
  const empty = await page.locator('main, body').first().innerText();
  check('zonder koppelingen: Post wijst naar Apps', /Gmail is niet gekoppeld/.test(empty));
  check('zonder koppelingen: Geld zegt hoe je de bank koppelt', /Koppel je bank/.test(empty) && /Alleen lezen, nooit betalen/.test(empty));
  check('Wacht op jou, Team en Cijfers staan er', /Wacht op jou/.test(empty) && /Niets dat op je wacht/.test(empty) && /Staat stil:/.test(empty) && /Cijfers/.test(empty));
  check('Wacht op jou is alleen een teller met een link, geen kaarten', (await page.getByTestId('dashboard-stat-waiting').getAttribute('href')) === '#/inbox' && (await page.getByRole('group', { name: 'Goedkeuring nodig' }).count()) === 0);
  check('Gekoppelde apps staat erop en zegt hoe je koppelt', /Gekoppelde apps/.test(empty) && /Nog geen apps gekoppeld/.test(empty));
  await shot('1-leeg');

  // With mail and a bank (stand-ins at the page).
  let sent = null;
  await page.route('**/api/mcp/google/mail?*', (r) => r.fulfill({ json: { messages: MAIL } }));
  await page.route('**/api/mcp/google/mail/m1', (r) => r.fulfill({ json: { ...MAIL[0], messageId: '<abc@klant.test>', attachments: [], body: 'Hallo,\n\nKunnen jullie morgen nog leveren? Ik heb de onderdelen donderdag nodig.\n\nGroet,\nJan' } }));
  await page.route('**/api/mcp/google/mail/send', (r) => ((sent = r.request().postDataJSON()), r.fulfill({ json: { ok: true, id: 's1' } })));
  await page.route('**/api/mcp/bank/overview*', (r) => r.fulfill({ json: BANK }));
  await page.reload();
  await page.getByTestId('dashboard-mail-row').first().waitFor({ timeout: 15000 });
  await page.getByTestId('dashboard-account').first().waitFor({ timeout: 15000 });
  const full = await page.locator('body').innerText();
  check('Post toont de inbox met afzender en onderwerp', /Jan de Vries/.test(full) && /Levering van bestelling 2041/.test(full) && /Sanne Bakker/.test(full));
  check('Geld toont saldo per rekening, het totaal en de mutaties', /12\.480,55|12,480\.55/.test(full) && /Samen/.test(full) && /TransIP B\.V\./.test(full) && /NL91 •••• 4300/.test(full), '');
  await shot('2-gevuld');

  await page.getByTestId('dashboard-mail-row').first().click();
  await page.getByTestId('dashboard-mail-open').waitFor({ timeout: 10000 });
  check('een mail opent met de hele tekst', /Ik heb de onderdelen donderdag nodig/.test(await page.getByTestId('dashboard-mail-open').innerText()));
  await page.getByPlaceholder('Typ je antwoord…').fill('Ja, morgen voor twaalf uur is hij er.');
  await shot('3-mail-open');
  await page.getByTestId('dashboard-mail-send').click();
  await page.getByText('Je antwoord is verstuurd').waitFor({ timeout: 10000 });
  check('het antwoord gaat naar de afzender, in hetzelfde gesprek', sent && sent.to === 'jan@klant.test' && sent.subject === 'Re: Levering van bestelling 2041' && sent.thread === 't1' && sent.inReplyTo === '<abc@klant.test>', JSON.stringify(sent || {}).slice(0, 160));
  check('daarna staat de lijst er weer', (await page.getByTestId('dashboard-mail-row').count()) === 3);

  // Connected apps as a board: the name, how it stands, one click to open it (the list as the server gives it).
  await page.route('**/api/mcp/connections', (r) =>
    r.fulfill({ json: [
      { id: 'mcp_a', name: 'Google', label: '', enabled: true, status: 'connected', last_error: null, transport: 'builtin' },
      { id: 'mcp_b', name: 'Lighthouse (snelheid en SEO meten)', label: '', enabled: true, status: 'stopped', last_error: null, transport: 'stdio' },
      { id: 'mcp_c', name: 'Boekhouding', label: '', enabled: true, status: 'error', last_error: 'time-out', transport: 'http' },
      { id: 'mcp_d', name: 'Oude koppeling', label: '', enabled: false, status: 'stopped', last_error: null, transport: 'stdio' },
    ] }),
  );
  await page.reload();
  await page.getByTestId('dashboard-app').first().waitFor({ timeout: 15000 });
  const apps = await page.getByTestId('dashboard-apps').innerText();
  check('apps staan er als tegels met hun stand', /Google\s+Verbonden/.test(apps) && /Lighthouse\s+Klaar voor gebruik/.test(apps) && /Boekhouding\s+Werkt niet/.test(apps) && /Oude koppeling\s+Uit/.test(apps) && /Apps die werken: 2 van 4/.test(apps), apps.split('\n').join(' | ').slice(0, 200));
  check('de teller bovenaan telt ze', /4\s+2 van 4 werken/.test(await page.getByTestId('dashboard-stat-apps').innerText()));
  check('een tegel opent de app', (await page.getByTestId('dashboard-app').first().getAttribute('href')) === '#/m/mcp/c/mcp_a');
  await page.getByTestId('dashboard-apps').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, 'dashboard-4-apps.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('op telefoonbreedte schuift niets opzij', wide <= 1, `overschot ${wide}px`);
} catch (e) {
  check('de schermronde liep door', false, String(e?.message || e).split('\n')[0]);
} finally {
  await browser.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}
