// End-to-end: the Kluis card that appears when several logins of the vault fit one site (server/modules/browser/tools.ts
// asks "Met welk account?"; a login the owner gave his bots is filled in without a card). The card says it is a choice,
// not a permission: "vraagt welk account", "Inloggen en onthouden", "Niet nu", never "toestemming" or "Altijd
// toestaan". Real server (desktop mode, temp data), real UI build, Edge headless; the card is the server's own question
// (the same request tools.ts makes). Then the Kluis lists the remembered choice in the same words.
// Usage: npm run build:ui && node --import tsx tests/e2e/vault-choice.mjs   (TEAMBOT_E2E_BROWSER=chrome|msedge)
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

// The browser starts with the real profile folders; TeamBot itself gets a temporary home (never the owner's own data).
const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-vault-choice-home-'));
Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') });
delete process.env.TEAMBOT_DATA;

const { createApp } = await import('./server.mjs');
const { VAULT_LOGIN_TOOL, VAULT_SELF, VAULT_NOT_NOW } = await import('../../server/modules/browser/tools.ts');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-vault-choice-'));
const app = await createApp({ dataDir: dir, port: Number(process.env.TEAMBOT_E2E_PORT) || 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();

try {
  const call = async (method, p, body) => {
    const r = await fetch(app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(json)}`);
    return json;
  };
  const made = await call('POST', '/agents', { name: 'Ada' });
  const agent = app.ctx.store.agent(made.id || made.agent?.id);
  const thread = app.ctx.chat.threadForAgent(owner.id, agent.id);
  const origin = 'https://winkel.example';
  const shop = await call('POST', '/computers/vault', { label: 'Winkel', origins: origin, username: 'inkoop@bedrijf.example', password: 'geheim-1' });
  const books = await call('POST', '/computers/vault', { label: 'Winkel (boekhouding)', origins: origin, username: 'boekhouding@bedrijf.example', password: 'geheim-2' });

  // The question tools.ts asks when two logins fit the page.
  const accounts = [shop, books].map((e) => ({ id: e.id, label: e.label, account: e.username, totp: false, option: `Inloggen als ${e.username}` }));
  const answered = app.ctx.broker.request({
    userId: owner.id,
    agent,
    thread,
    run: null,
    kind: 'question',
    tool: VAULT_LOGIN_TOOL,
    input: { site: 'winkel.example', origin, agentId: agent.id, reason: 'de bestelling controleren', accounts },
    summary: 'Ada wil inloggen op winkel.example. Met welk account?',
    risk: 'read',
    options: [...accounts.map((x) => x.option), VAULT_SELF, VAULT_NOT_NOW],
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${app.url}/#token=${token}`);
  await page.waitForFunction(() => !!document.querySelector('nav'), null, { timeout: 20000 });
  await page.evaluate((id) => (location.hash = `#/t/${id}`), thread.id);
  const card = page.getByRole('group', { name: 'Inloggen met de kluis' });
  await card.waitFor({ timeout: 15000 }).catch(() => fail('de kaart van de kluis verschijnt niet in het gesprek'));
  const text = (await card.innerText()).replace(/\s+/g, ' ');
  if (!/Ada vraagt welk account/.test(text)) fail(`kop zegt niet "Ada vraagt welk account": ${text}`);
  if (!/Met welk account\?/.test(text)) fail(`de vraag "Met welk account?" ontbreekt: ${text}`);
  if (/toestemming|Altijd toestaan|Weigeren/i.test(text)) fail(`de kaart vraagt nog om toestemming: ${text}`);
  for (const name of ['Inloggen', 'Inloggen en onthouden', 'Zelf inloggen', 'Niet nu'])
    if (!(await card.getByRole('button', { name, exact: true }).count())) fail(`knop "${name}" ontbreekt: ${text}`);
  step(`kaart: ${text.slice(0, 160)}…`);

  // Choose the second account and remember it.
  await card.getByText('boekhouding@bedrijf.example').click();
  await card.getByRole('button', { name: 'Inloggen en onthouden', exact: true }).click();
  const r = await Promise.race([answered, new Promise((res) => setTimeout(() => res(null), 10000))]);
  if (!r) fail('de keuze kwam niet bij de server aan');
  else if (!r.approved || r.answer !== accounts[1].option || !r.always) fail(`verkeerde keuze doorgegeven: ${JSON.stringify(r)}`);
  else step('"Inloggen en onthouden" met het tweede account: de server krijgt dat account, onthouden');

  // The Kluis says what was remembered, in the same words (tools.ts adds this grant after "always").
  app.ctx.services.computers._service.vault.addGrant(owner.id, books.id, agent.id, origin);
  await page.evaluate(() => (location.hash = '#/m/browser/kluis'));
  const remembered = page.getByText('Account onthouden voor:');
  await remembered.waitFor({ timeout: 10000 }).catch(() => fail('de Kluis zegt niet voor wie het account onthouden is'));
  if (!(await page.getByRole('button', { name: 'Niet meer onthouden voor Ada' }).count())) fail('knop "Niet meer onthouden voor Ada" ontbreekt in de Kluis');
  if (await page.getByText(/Altijd toegestaan/).count()) fail('de Kluis zegt nog "Altijd toegestaan"');
  await page.getByRole('button', { name: 'Niet meer onthouden voor Ada' }).click();
  await page.getByText('Vergeten: TeamBot vraagt weer welk account').waitFor({ timeout: 10000 }).catch(() => fail('geen melding na "Niet meer onthouden"'));
  if (app.ctx.services.computers._service.vault.hasGrant(books.id, agent.id, origin)) fail('de onthouden keuze staat er nog');
  else step('Kluis: "Account onthouden voor: Ada · winkel.example", en "Niet meer onthouden" haalt het weg');
} catch (e) {
  fail(e?.stack || String(e));
} finally {
  await browser.close().catch(() => {});
  await app.close?.();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
if (!process.exitCode) console.log('✓ vault-choice: de kaart vraagt welk account, niet om toestemming');
process.exit(process.exitCode || 0);
