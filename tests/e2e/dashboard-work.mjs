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

  // The start screen is the home screen of an operating system: a menu bar, widgets, a dock with the apps, and an app
  // that opens as a window.
  const go = async (id) => {
    await page.goto(`${app.url}/#/dashboard${id ? `/${id}` : ''}`);
    await page.getByTestId('dashboard-dock').waitFor({ timeout: 15000 });
    await page.waitForTimeout(400);
  };

  // Nothing connected yet: every block says how to connect it, nothing is an error.
  await go('');
  await page.getByTestId('dashboard-mail').waitFor({ timeout: 15000 });
  await page.waitForTimeout(1500);
  const empty = await page.locator('main, body').first().innerText();
  check('zonder koppelingen: Post wijst naar Apps', /Gmail is niet gekoppeld/.test(empty));
  check('zonder koppelingen: Geld zegt hoe je de bank koppelt', /Koppel je bank/.test(empty) && /Alleen lezen, nooit betalen/.test(empty));
  check('Wacht op jou, Team en Cijfers staan er', /Wacht op jou/.test(empty) && /Niets dat op je wacht/.test(empty) && /Staat stil:/.test(empty) && /Cijfers/.test(empty));
  check('Wacht op jou is alleen een teller met een link, geen kaarten', (await page.getByTestId('dashboard-stat-waiting').getAttribute('href')) === '#/inbox' && (await page.getByRole('group', { name: 'Goedkeuring nodig' }).count()) === 0);
  check('Gekoppelde apps staat erop en zegt hoe je koppelt', /Gekoppelde apps/.test(empty) && /Nog geen apps gekoppeld/.test(empty));
  check('het dock toont de zeven apps met Overzicht gekozen, en de weg naar Wacht op jou en Taken', (await page.locator('[data-testid^="dashboard-app-"]').count()) === 7 && (await page.getByTestId('dashboard-app-home').getAttribute('aria-current')) === 'page' && (await page.getByTestId('dashboard-place-wacht').getAttribute('href')) === '#/inbox' && (await page.getByTestId('dashboard-place-taken').getAttribute('href')) === '#/tasks');
  const bar = await page.getByTestId('dashboard-menubar').innerText();
  check('de menubalk zegt waar je bent en hoe laat het is', /TeamBot/.test(bar) && /Overzicht/.test(bar) && /\d{1,2}[:.]\d{2}/.test(bar), bar.replace(/\s+/g, ' '));
  const homeBox = await page.getByTestId('dashboard-home').boundingBox();
  check('het startscherm gebruikt het hele venster: de lijst met bots maakt plaats', homeBox.width > 1150 && (await page.getByText('Nog geen gesprek').count()) === 0, `breedte ${Math.round(homeBox.width)}`);
  check('bovenaan staat een begroeting met de bots, de dag en de tijd', (await page.getByTestId('dashboard-hero').count()) === 1 && /Goede|Goed/.test(await page.getByTestId('dashboard-hero').innerText()) && /\d{1,2}[:.]\d{2}/.test(await page.getByTestId('dashboard-hero').innerText()));
  check('Taken en Verbruik staan op het startscherm', /Er staat niets open/.test(empty) && (await page.getByTestId('dashboard-usage').count()) === 1);
  await shot('1-leeg');

  // With mail and a bank (stand-ins at the page).
  let sent = null;
  await page.route('**/api/mcp/google/mail?*', (r) => r.fulfill({ json: { messages: MAIL } }));
  await page.route('**/api/mcp/google/mail/m1', (r) => r.fulfill({ json: { ...MAIL[0], messageId: '<abc@klant.test>', attachments: [], body: 'Hallo,\n\nKunnen jullie morgen nog leveren? Ik heb de onderdelen donderdag nodig.\n\nGroet,\nJan' } }));
  await page.route('**/api/mcp/google/mail/send', (r) => ((sent = r.request().postDataJSON()), r.fulfill({ json: { ok: true, id: 's1' } })));
  await page.route('**/api/mcp/bank/overview*', (r) => r.fulfill({ json: BANK }));
  await page.reload();
  await page.getByTestId('dashboard-mail-row').first().waitFor({ timeout: 15000 });
  await page.getByTestId('dashboard-money-total').waitFor({ timeout: 15000 });
  const start = await page.locator('body').innerText();
  check('het startscherm toont de laatste post', /Jan de Vries/.test(start) && /Levering van bestelling 2041/.test(start) && /Sanne Bakker/.test(start));
  check('en je geld als één bedrag met zijn verloop, zonder de lijst met mutaties', /21\.480,55|21,480\.55/.test(start) && /Samen op 2 rekeningen/.test(start) && (await page.getByTestId('dashboard-money-course').count()) === 1 && (await page.getByTestId('dashboard-transactions').count()) === 0);
  await shot('2-start');

  // A block opens its app: Post, whole.
  await page.getByTestId('dashboard-mail-row').first().click();
  await page.getByTestId('dashboard-mail-search').waitFor({ timeout: 10000 });
  check('een bericht op het startscherm opent de app Post, als venster', /#\/dashboard\/post$/.test(page.url()) && (await page.getByTestId('dashboard-app-post').getAttribute('aria-current')) === 'page' && /Post/.test(await page.getByTestId('dashboard-window').locator('h1').innerText()));
  await page.getByTestId('dashboard-mail-row').first().click();
  await page.getByTestId('dashboard-mail-open').waitFor({ timeout: 10000 });
  check('een mail opent met de hele tekst', /Ik heb de onderdelen donderdag nodig/.test(await page.getByTestId('dashboard-mail-open').innerText()));
  await page.getByPlaceholder('Typ je antwoord…').fill('Ja, morgen voor twaalf uur is hij er.');
  await shot('3-mail-open');
  await page.getByTestId('dashboard-mail-send').click();
  await page.getByText('Je antwoord is verstuurd').waitFor({ timeout: 10000 });
  check('het antwoord gaat naar de afzender, in hetzelfde gesprek', sent && sent.to === 'jan@klant.test' && sent.subject === 'Re: Levering van bestelling 2041' && sent.thread === 't1' && sent.inReplyTo === '<abc@klant.test>', JSON.stringify(sent || {}).slice(0, 160));
  check('daarna staat de lijst er weer', (await page.getByTestId('dashboard-mail-row').count()) === 3);

  // A new mail of his own, and what went out.
  await page.getByTestId('dashboard-mail-new').click();
  const form = page.getByTestId('dashboard-mail-compose');
  await form.waitFor({ timeout: 10000 });
  check('een nieuwe mail schrijven: aan, onderwerp, bericht en versturen', (await form.getByRole('textbox').count()) === 3 && (await form.getByTestId('dashboard-mail-send-new').isDisabled()));
  await form.getByRole('button', { name: 'Annuleren' }).click();
  check('Inbox en Verzonden staan naast elkaar, met zoeken', (await page.getByTestId('dashboard-mail').getByText('Verzonden').count()) > 0 && (await page.getByTestId('dashboard-mail-search').count()) === 1);

  // Another mailbox of his own: connected with its address and password, then read and written from that address.
  let boxSent = null;
  let boxMade = null;
  await page.route('**/api/mcp/mailboxes', (r) => (r.request().method() === 'POST' ? ((boxMade = r.request().postDataJSON()), r.fulfill({ json: { boxes: [{ id: 'mb_1', address: 'info@zaak.test' }] } })) : r.fulfill({ json: { boxes: [] } })));
  await page.route('**/api/mcp/mailboxes/mb_1/mail?*', (r) => r.fulfill({ json: { messages: [{ id: 'inbox:5', thread: '', from: 'Piet Bos <piet@leverancier.test>', to: 'info@zaak.test', subject: 'Levertijd van de banden', date: new Date(Date.now() - 3600_000).toISOString(), unread: true, snippet: 'De levering komt dinsdag.' }] } }));
  await page.route('**/api/mcp/mailboxes/mb_1/mail/send', (r) => ((boxSent = r.request().postDataJSON()), r.fulfill({ json: { ok: true, id: 's2' } })));
  await page.getByTestId('dashboard-mail-add').click();
  const connect = page.getByTestId('dashboard-mail-connect');
  await connect.waitFor({ timeout: 10000 });
  await connect.getByRole('textbox').first().fill('info@zaak.test');
  await connect.locator('input[type=password]').fill('proef-wachtwoord');
  await page.getByTestId('dashboard-mail-connect-save').click();
  await page.getByText('Levertijd van de banden').waitFor({ timeout: 10000 });
  check('een eigen postvak koppelen: adres en wachtwoord, daarna staat zijn post er', boxMade?.address === 'info@zaak.test' && (await page.getByTestId('dashboard-mail-account').inputValue()) === 'mb_1');
  await page.getByTestId('dashboard-mail-new').click();
  const from = page.getByTestId('dashboard-mail-compose');
  await from.waitFor({ timeout: 10000 });
  check('een nieuwe mail zegt vanaf welk adres hij gaat', /Vanaf info@zaak\.test/.test(await from.innerText()));
  const fields = from.getByRole('textbox');
  await fields.nth(0).fill('piet@leverancier.test');
  await fields.nth(1).fill('Dinsdag is goed');
  await fields.nth(2).fill('Prima, tot dinsdag.');
  await page.getByTestId('dashboard-mail-send-new').click();
  await page.getByText('Levertijd van de banden').waitFor({ timeout: 10000 });
  check('en gaat vanaf dat postvak de deur uit', boxSent?.to === 'piet@leverancier.test' && boxSent?.body === 'Prima, tot dinsdag.');
  await shot('4-post');
  await page.unroute('**/api/mcp/mailboxes');

  // A window closes back to the home screen.
  await page.getByTestId('dashboard-window-close').click();
  await page.getByTestId('dashboard-home').waitFor({ timeout: 10000 });
  check('het venster sluit terug naar het startscherm', /#\/dashboard$/.test(page.url()) && (await page.getByTestId('dashboard-window').count()) === 0);

  // The app Geld: every account, the balance per day, and the transactions. Opened from the dock.
  await page.getByTestId('dashboard-app-geld').click();
  await page.getByTestId('dashboard-window').waitFor({ timeout: 10000 });
  await page.getByTestId('dashboard-account').first().waitFor({ timeout: 15000 });
  const geld = await page.locator('body').innerText();
  check('Geld toont saldo per rekening, het totaal en de mutaties', /12\.480,55|12,480\.55/.test(geld) && /Samen/.test(geld) && /TransIP B\.V\./.test(geld) && /NL91 •••• 4300/.test(geld), '');
  const course = page.getByTestId('dashboard-money-course');
  await course.waitFor({ timeout: 10000 });
  const svg = course.locator('svg');
  const box = await svg.boundingBox();
  await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2);
  const tip = await page.getByTestId('dashboard-money-tip').innerText();
  check('het saldo per dag staat als lijn, en een dag is af te lezen', /21\.480,55|21,480\.55/.test(tip.replace(/\s/g, '')), tip.replace(/\s+/g, ' '));
  check('met wat erbij kwam en eraf ging in de periode', /Bijgeschreven[\s\S]*250[\s\S]*Afgeschreven[\s\S]*471,30|Afgeschreven[\s\S]*471\.30/.test(await course.innerText()), (await course.innerText()).replace(/\s+/g, ' ').slice(-120));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await shot('5-geld');

  // The numbers the bots keep: one that changed shows its course, a budget with a limit is a meter.
  const td = app.ctx.services.teamdata;
  const uid = app.ctx.auth.owner().id;
  const put = (v) => td.write(uid, [{ sql: "INSERT INTO dashboard (sleutel, groep, titel, waarde, eenheid, bot, toelichting) VALUES ('aanvragen', 'Leads', 'Aanvragen deze week', ?, 'aanvragen', 'Ada', 'Geteld uit het formulier van de site, zonder proefaanvragen. Vorige week waren het er vier; de stijging komt van de nieuwe knop bovenaan de pagina en van twee advertenties die sinds maandag lopen.') ON CONFLICT(sleutel) DO UPDATE SET waarde = excluded.waarde", params: [v] }]);
  for (const v of ['4', '6', '5', '9', '12']) {
    await put(v);
    await td.dashboard(uid);
  }
  await td.write(uid, [
    { sql: "INSERT INTO dashboard (sleutel, groep, titel, waarde, eenheid, bot) VALUES ('omzet', 'Omzet', 'Omzet deze week', '1.240', 'euro', 'Bo')" },
    { sql: "INSERT INTO dashboard (sleutel, groep, titel, waarde, maximum, eenheid, bot) VALUES ('hosting-budget', 'Kosten', 'Hosting: extra budget deze maand', '19,55', '23', 'dollar', 'Bo')" },
    { sql: "INSERT INTO dashboard (sleutel, groep, titel, waarde, maximum, eenheid, bot) VALUES ('bouwminuten', 'Kosten', 'Bouwminuten deze maand', '640', '2000', 'minuten', 'Bo')" },
  ]);
  await go('cijfers');
  await page.reload();
  await page.getByTestId('dashboard-course').first().waitFor({ timeout: 15000 });
  check('een meter staat niet tussen de cijfers', (await page.getByTestId('dashboard-numbers').getByText('Hosting: extra budget deze maand').count()) === 0 && (await page.getByTestId('dashboard-tile').count()) === 2);
  check('een cijfer dat steeg toont dat naast het getal', /\+8/.test(await page.getByTestId('dashboard-trend').first().innerText()));
  const tile = await page.getByTestId('dashboard-tile').first().innerText();
  check('een cijfer dat veranderde toont zijn verloop', /Aanvragen deze week/.test(tile) && /\+8 sinds/.test(tile), tile.replace(/\s+/g, ' ').slice(0, 160));
  // A long explanation stays two lines until he asks for all of it.
  const note = page.getByTestId('dashboard-tile-note').first();
  const short = (await note.boundingBox()).height;
  await page.getByTestId('dashboard-tile-more').first().click();
  check('een lange toelichting staat ingeklapt en klapt uit met Meer lezen', (await note.boundingBox()).height > short + 10, `${short}`);
  await page.getByTestId('dashboard-tile-more').first().click();
  await shot('6-cijfers');

  await go('verbruik');
  const usage = page.getByTestId('dashboard-usage');
  await usage.getByTestId('dashboard-meter').first().waitFor({ timeout: 10000 });
  const meterText = (await usage.innerText()).replace(/\s+/g, ' ');
  check('een budget met een grens staat als meter onder Verbruik: wat er gebruikt is van wat, en "bijna op" in woorden', (await usage.getByTestId('dashboard-meter').count()) === 2 && /19,55 van 23 dollar/.test(meterText) && /Bijna op: 85/.test(meterText) && /640 van 2000 minuten/.test(meterText), meterText.slice(0, 200));
  await shot('7-verbruik');

  // Back on the start screen: the numbers small with their course, the meters, and everything else at a glance.
  await go('');
  await page.getByTestId('dashboard-kpi').first().waitFor({ timeout: 15000 });
  check('het startscherm toont de cijfers klein, het cijfer dat bewoog eerst met zijn lijn', (await page.getByTestId('dashboard-kpi').count()) === 2 && /Aanvragen deze week/.test(await page.getByTestId('dashboard-kpi').first().innerText()) && (await page.getByTestId('dashboard-spark').count()) === 1);
  check('en de meters, zonder ze tussen de cijfers te zetten', (await page.getByTestId('dashboard-usage').getByTestId('dashboard-meter').count()) === 2 && (await page.getByTestId('dashboard-numbers').getByText('Hosting: extra budget deze maand').count()) === 0);
  await page.getByTestId('dashboard-kpi').first().click();
  await page.getByTestId('dashboard-tile').first().waitFor({ timeout: 10000 });
  check('een cijfer op het startscherm opent de app Cijfers', /#\/dashboard\/cijfers$/.test(page.url()));

  // Connected apps as a board: the name, how it stands, one click to open it (the list as the server gives it).
  await page.route('**/api/mcp/connections', (r) =>
    r.fulfill({ json: [
      { id: 'mcp_a', name: 'Google', label: '', enabled: true, status: 'connected', last_error: null, transport: 'builtin' },
      { id: 'mcp_b', name: 'Lighthouse (snelheid en SEO meten)', label: '', enabled: true, status: 'stopped', last_error: null, transport: 'stdio' },
      { id: 'mcp_c', name: 'Boekhouding', label: '', enabled: true, status: 'error', last_error: 'time-out', transport: 'http' },
      { id: 'mcp_d', name: 'Oude koppeling', label: '', enabled: false, status: 'stopped', last_error: null, transport: 'stdio' },
    ] }),
  );
  await go('apps');
  await page.reload();
  await page.getByTestId('dashboard-app').first().waitFor({ timeout: 15000 });
  const apps = await page.getByTestId('dashboard-apps').innerText();
  check('apps staan er als tegels met hun stand', /Google\s+Verbonden/.test(apps) && /Lighthouse\s+Klaar voor gebruik/.test(apps) && /Boekhouding\s+Werkt niet/.test(apps) && /Oude koppeling\s+Uit/.test(apps) && /Apps die werken: 2 van 4/.test(apps), apps.split('\n').join(' | ').slice(0, 200));
  check('een tegel opent de app', (await page.getByTestId('dashboard-app').first().getAttribute('href')) === '#/m/mcp/c/mcp_a');
  await go('');
  await page.getByTestId('dashboard-app').first().waitFor({ timeout: 15000 });
  check('de teller bovenaan telt ze', /4\s+2 van 4 werken/.test(await page.getByTestId('dashboard-stat-apps').innerText()));
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(SHOTS, 'dashboard-8-start-vol.png'), fullPage: false });
  console.log('  schermafbeelding: dashboard-8-start-vol.png');
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
