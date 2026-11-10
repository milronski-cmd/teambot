// End-to-end check of the extension screens that the acceptance test found lacking (release gate, runs with npm run e2e):
//   1. bot editor: one "Opslaan" also stores the Computer section (Eigen server/SSH), a typed folder that was not
//      added yet, a sticky "Niet opgeslagen" bar, and leaving with unsaved changes asks first (no silent loss);
//   2. one bot picker with "Alle bots" for skills (Mijn skills › Bots) and apps (connector detail);
//   3. OAuth login of a connector in one click (fake OAuth server: discovery, registration, PKCE, callback);
//   4. Mijn skills › "Controleer op updates", and the warning before installing a skill that only points to another.
// Starts TeamBot (desktop mode, temp data dir) and drives Edge/Chrome headless with Playwright.
// Usage: npm run build:ui && node --import tsx tests/e2e/extensions-ui.mjs   (TEAMBOT_UI_DIR=… for another build)
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const { createApp } = await import('../../server/app.ts');
const { createFixtureServer } = await import('../mcp-fixture-server.ts');
const { NodeStreamableHTTPServerTransport } = await import('@modelcontextprotocol/node');

const step = (s) => console.log(`• ${s}`);
const fail = (s) => {
  console.error(`✗ ${s}`);
  process.exitCode = 1;
};
const shots = process.env.TB_SHOTS_DIR || path.resolve('.data/e2e-shots/extensions-ui');
fs.mkdirSync(shots, { recursive: true });

// ---- a tiny OAuth 2.1 server + MCP endpoint (like a real remote connector such as Notion) ----
const st = { base: '', codes: new Map(), access: new Set(), authorizeHits: 0 };
const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const readBody = (req) => new Promise((r) => {
  let s = '';
  req.on('data', (d) => (s += d));
  req.on('end', () => r(s));
});
const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const oauth = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', st.base);
  const body = await readBody(req);
  const p = url.pathname;
  if (p.startsWith('/.well-known/oauth-protected-resource')) return json(res, { resource: st.base + '/mcp', authorization_servers: [st.base], scopes_supported: ['notes:read'] });
  if (p === '/.well-known/oauth-authorization-server')
    return json(res, { issuer: st.base, authorization_endpoint: st.base + '/authorize', token_endpoint: st.base + '/token', registration_endpoint: st.base + '/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
  if (p === '/register' && req.method === 'POST') return json(res, { ...JSON.parse(body), client_id: 'client-e2e' }, 201);
  if (p === '/authorize') {
    st.authorizeHits++;
    const q = url.searchParams;
    const code = 'code-' + crypto.randomBytes(6).toString('hex');
    st.codes.set(code, { challenge: q.get('code_challenge') || '', redirect: q.get('redirect_uri') || '' });
    const to = new URL(q.get('redirect_uri'));
    to.searchParams.set('code', code);
    to.searchParams.set('state', q.get('state') || '');
    res.writeHead(302, { location: to.href });
    return res.end();
  }
  if (p === '/token' && req.method === 'POST') {
    const f = new URLSearchParams(body);
    const c = st.codes.get(f.get('code') || '');
    st.codes.delete(f.get('code') || '');
    if (!c || b64url(crypto.createHash('sha256').update(f.get('code_verifier') || '').digest()) !== c.challenge) return json(res, { error: 'invalid_grant' }, 400);
    const at = 'at-' + crypto.randomBytes(8).toString('hex');
    st.access.add(at);
    return json(res, { access_token: at, refresh_token: 'rt-x', token_type: 'Bearer', expires_in: 3600, scope: 'notes:read' });
  }
  if (p === '/mcp') {
    const auth = String(req.headers.authorization || '');
    if (!auth.startsWith('Bearer ') || !st.access.has(auth.slice(7))) {
      res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${st.base}/.well-known/oauth-protected-resource/mcp"`, 'content-type': 'application/json' });
      return res.end('{"error":"unauthorized"}');
    }
    const server = createFixtureServer();
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => (transport.close(), server.close()));
    await server.connect(transport);
    return transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => oauth.listen(0, '127.0.0.1', r));
st.base = `http://127.0.0.1:${oauth.address().port}`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-e2e-ext-'));
const extraFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-e2e-kennis-'));
const app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();
const prov = app.ctx.providers.create(owner.id, { kind: 'ollama', name: 'Ollama' });
const mk = (name) => app.ctx.store.createAgent(owner.id, { name, role: 'Test', provider_id: prov.id, model: 'llama3', access_mode: 'ask' });
const bots = [mk('Assistent'), mk('Onderzoeker'), mk('Schrijver')];
const api = async (method, p, body) => {
  const r = await fetch(`${app.url}/api${p}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status}: ${j.error}`);
  return j;
};
step(`TeamBot op ${app.url}, nep-OAuth op ${st.base}`);

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const errors = [];
try {
  const ctxB = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctxB.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED|401 \(Unauthorized\)/.test(m.text()) && errors.push(m.text()));
  page.on('dialog', (d) => {
    errors.push(`onverwacht browserdialoog: ${d.message()}`);
    d.dismiss().catch(() => {});
  });
  await page.goto(`${app.url}/#token=${token}`);
  await page.waitForTimeout(800);

  // ---------------------------------------------------------------- 1. bot editor: no silent loss
  const bot = bots[0];
  const sectionBtn = (title) => page.getByRole('button', { name: new RegExp(`^${title.replace(/[()&]/g, '.')}`) });
  const scrollHeight = () => page.evaluate(() => Math.max(...[...document.querySelectorAll('main .scroll-thin')].map((e) => e.scrollHeight)));
  // Open a tab; the old names (Kunnen …) are parts of Meer now, with their rare sections behind "Meer opties".
  const tab = async (name) => {
    await page.getByRole('tab', { name: new RegExp(`^${['Overzicht', 'Instructies'].includes(name) ? name : 'Meer'}( niet opgeslagen)?$`) }).click();
    await page.evaluate(() => document.querySelectorAll('details').forEach((x) => (x.open = true)));
    await page.waitForTimeout(400);
  };
  await page.goto(`${app.url}/#/agents/${bot.id}`);
  await page.getByRole('tab', { name: 'Overzicht' }).waitFor({ timeout: 15000 });
  await page.waitForTimeout(1200);
  // Simple at first glance: five tabs, the essentials in view, every other option in a closed section (a title and one
  // line) on the tab it belongs to.
  const tabs = (await page.getByRole('tab').allInnerTexts()).map((x) => x.trim());
  if (tabs.join(' | ') !== 'Overzicht | Instructies | Meer') fail(`botpagina: tabbladen zijn ${JSON.stringify(tabs)}`);
  for (const l of ['Naam', 'AI', 'Model']) if (!(await page.getByLabel(l, { exact: true }).count())) fail(`botpagina › Overzicht: "${l}" staat niet vooraan`);
  const heights = {};
  let sections = 0;
  for (const t of tabs) {
    await tab(t);
    heights[t] = await scrollHeight();
    const cards = await page.evaluate(() => [...document.querySelectorAll('main [data-tab]:not([hidden]) [data-section]')].map((e) => ({ id: e.getAttribute('data-section'), h: Math.round(e.getBoundingClientRect().height) })));
    sections += cards.length;
    const tall = cards.filter((c) => c.h > 140);
    if (tall.length) fail(`botpagina › ${t}: niet elke sectie staat dicht (${JSON.stringify(tall)})`);
  }
  if (!sections) fail('botpagina: geen dichte secties gevonden');
  if (Math.max(...Object.values(heights)) > 2600) fail(`botpagina: een tabblad is te lang (${JSON.stringify(heights)})`);
  else step(`botpagina: vijf tabbladen, het langste ${Math.max(...Object.values(heights))}px hoog, ${sections} dichte secties`);
  await tab('Instructies');
  if (!(await page.getByLabel('Instructies', { exact: true }).count())) fail('botpagina › Instructies: het veld Instructies ontbreekt');
  await tab('Kunnen');
  for (const t of ['Tools', 'Computer & bestanden', 'Werkmap en mappen']) if ((await sectionBtn(t).getAttribute('aria-expanded')) !== 'false') fail(`botpagina: "${t}" staat niet dicht`);
  if (await page.getByText('Per tool instellen').count()) fail('botpagina: beleid per tool is zichtbaar zonder Tools te openen');
  await page.screenshot({ path: path.join(shots, 'editor-eenvoudig.png'), fullPage: false });
  if (await page.getByText('Niet opgeslagen:').count()) fail('editor: "Niet opgeslagen" zonder dat er iets is gewijzigd');
  await sectionBtn('Computer & bestanden').click();
  await page.getByRole('radiogroup', { name: 'Computermodus' }).waitFor({ timeout: 15000 });
  await page.getByRole('radio', { name: /Eigen server \(SSH\)/ }).click();
  await page.getByLabel('Adres van de server').fill('vps.example.nl');
  await page.getByLabel('Gebruikersnaam').fill('teambot');
  await page.getByRole('status').filter({ hasText: 'Niet opgeslagen: Computer & bestanden' }).waitFor({ timeout: 5000 }).catch(() => fail('editor: plakbalk noemt de computerinstellingen niet'));
  if (await page.getByRole('button', { name: 'Computer opslaan' }).count()) fail('editor: er is nog een aparte knop "Computer opslaan"');
  // A typed folder that was never "added" is added by Opslaan as well.
  await sectionBtn('Werkmap en mappen').click();
  await page.getByLabel('Map toevoegen').fill(extraFolder);
  await tab('Overzicht');
  await page.getByLabel('Naam', { exact: true }).fill('Assistent Pro');
  await tab('Kunnen');
  // Closing a section with unsaved changes keeps them and marks the closed header.
  await sectionBtn('Computer & bestanden').click();
  await page.waitForTimeout(300);
  if (!(await page.locator('[data-section="browser:computer"]').getByText('Niet opgeslagen').count())) fail('editor: dichtgeklapte sectie met wijzigingen heeft geen "Niet opgeslagen"');
  const bar = await page.getByRole('status').filter({ hasText: 'Niet opgeslagen:' }).first().innerText();
  if (!/Naam/.test(bar) || !/Computer & bestanden/.test(bar) || !/Mappen/.test(bar)) fail(`editor: plakbalk mist iets: ${bar}`);
  else step(`plakbalk: ${bar.replace(/\s+/g, ' ').trim()}`);
  await page.screenshot({ path: path.join(shots, 'editor-niet-opgeslagen.png') });

  // Leaving asks first; Annuleren keeps everything.
  await page.getByRole('link', { name: /Terug naar Assistent/ }).click();
  const leave = page.getByRole('dialog', { name: 'Wijzigingen opslaan?' });
  await leave.waitFor({ timeout: 5000 }).catch(() => fail('editor: weggaan met wijzigingen vraagt niets'));
  await page.screenshot({ path: path.join(shots, 'editor-weggaan.png') });
  await leave.getByRole('button', { name: 'Annuleren' }).click();
  if (!page.url().includes(`/agents/${bot.id}`)) fail(`editor: na Annuleren niet meer in de editor (${page.url()})`);
  await sectionBtn('Computer & bestanden').click();
  if ((await page.getByLabel('Adres van de server').inputValue()) !== 'vps.example.nl') fail('editor: ingevulde waarde weg na Annuleren of dichtklappen');
  await sectionBtn('Computer & bestanden').click();
  step('weggaan met wijzigingen vraagt eerst; Annuleren houdt alles');

  // One Opslaan stores the bot, the computer section and the typed folder.
  await page.getByRole('button', { name: 'Opslaan', exact: true }).first().click();
  await page.getByText('Opgeslagen', { exact: true }).first().waitFor({ timeout: 10000 }).catch(() => fail('editor: geen melding "Opgeslagen"'));
  await page.waitForTimeout(800);
  const cfg = await api('GET', `/computers/${bot.id}`);
  const saved = app.ctx.store.agent(bot.id);
  if (cfg.config.mode !== 'remote' || cfg.config.remote.host !== 'vps.example.nl' || cfg.config.remote.username !== 'teambot') fail(`editor: computer niet opgeslagen (${JSON.stringify({ mode: cfg.config.mode, remote: cfg.config.remote })})`);
  if (saved.name !== 'Assistent Pro') fail('editor: naam niet opgeslagen');
  if (!(saved.settings?.folders || []).some((f) => path.resolve(f.path).toLowerCase() === path.resolve(extraFolder).toLowerCase())) fail(`editor: getypte map niet toegevoegd (${JSON.stringify(saved.settings?.folders)})`);
  if (await page.getByText('Niet opgeslagen:').count()) fail('editor: plakbalk blijft staan na opslaan');
  step('één Opslaan bewaart naam, computer (SSH) en de getypte map');
  await page.reload();
  await page.getByRole('tab', { name: 'Overzicht' }).waitFor({ timeout: 15000 });
  await tab('Kunnen');
  // Which sections you opened is remembered (per browser): "Werkmap en mappen" open, "Computer" closed.
  if ((await sectionBtn('Werkmap en mappen').getAttribute('aria-expanded')) !== 'true' || (await sectionBtn('Computer & bestanden').getAttribute('aria-expanded')) !== 'false') fail('editor: open/dicht wordt niet onthouden na herladen');
  else step('open en dichte secties worden onthouden na herladen');
  await sectionBtn('Computer & bestanden').click();
  await page.getByRole('radiogroup', { name: 'Computermodus' }).waitFor({ timeout: 15000 });
  await page.waitForTimeout(800);
  if ((await page.getByRole('radio', { name: /Eigen server \(SSH\)/ }).getAttribute('aria-checked')) !== 'true') fail('editor: na herladen staat de modus niet meer op Eigen server');
  // "Niet opslaan" really leaves without saving.
  await page.getByLabel('Gebruikersnaam').fill('iemand-anders');
  await page.getByRole('link', { name: /Terug naar/ }).click();
  await page.getByRole('dialog', { name: 'Wijzigingen opslaan?' }).getByRole('button', { name: 'Niet opslaan' }).click();
  await page.waitForURL(/#\/a\//, { timeout: 10000 }).catch(() => fail('editor: "Niet opslaan" gaat niet weg'));
  if ((await api('GET', `/computers/${bot.id}`)).config.remote.username !== 'teambot') fail('editor: "Niet opslaan" heeft toch opgeslagen');
  step('herladen houdt de keuze; "Niet opslaan" gaat weg zonder op te slaan');

  // ---------------------------------------------------------------- 2. one bot picker with "Alle bots"
  const pv = await api('POST', '/skills/import/preview', { kind: 'paste', text: '---\nname: offerte\ndescription: Maakt een offerte.\n---\n\n# Offerte\n\nLees de aanvraag, reken de uren uit en schrijf een nette offerte met prijs, planning en voorwaarden. Vraag na wat onduidelijk is.\n' });
  const skillId = (await api('POST', '/skills/import/commit', { stagingId: pv.stagingId })).results[0].skillId;
  await page.goto(`${app.url}/#/m/skills/mine/${skillId}`);
  await page.getByRole('tab', { name: /^Bots/ }).click();
  await page.getByRole('button', { name: /Alle bots/ }).click();
  await page.getByText(/Ingeschakeld bij 3 bots/).waitFor({ timeout: 10000 }).catch(() => fail('skills: "Alle bots" meldt niets'));
  await page.waitForTimeout(400);
  if (!bots.every((b) => (app.ctx.store.agent(b.id).skills || []).includes(skillId))) fail('skills: niet bij alle bots ingeschakeld');
  else step('Mijn skills › Bots: "Alle bots" zet de skill bij alle 3 bots aan');
  await page.screenshot({ path: path.join(shots, 'skill-alle-bots.png') });

  // ---------------------------------------------------------------- 3. OAuth in one click (+ the same picker for apps)
  const conn = await api('POST', '/mcp/connections', { catalog_id: 'custom', name: 'Notities', transport: 'http', url: st.base + '/mcp', auth: 'oauth', allow_private: true });
  await page.goto(`${app.url}/#/m/mcp/c/${conn.id}`);
  await page.getByRole('button', { name: 'Inloggen', exact: true }).click({ timeout: 15000 });
  const login = page.getByRole('button', { name: /^Inloggen bij 127\.0\.0\.1/ });
  await login.waitFor({ timeout: 15000 });
  if (await page.getByText('Doorgaan naar inloggen').count()) fail('oauth: de oude tussenstap staat er nog');
  const popupP = ctxB.waitForEvent('page', { timeout: 10000 });
  await login.click();
  const popup = await popupP.catch(() => null);
  if (!popup) fail('oauth: één klik opent geen inlogvenster');
  await page.getByText('Ingelogd', { exact: true }).first().waitFor({ timeout: 15000 }).catch(() => fail('oauth: na één klik niet ingelogd'));
  if (st.authorizeHits !== 1) fail(`oauth: inlogpagina ${st.authorizeHits}× geopend`);
  let c2 = null;
  for (let i = 0; i < 30 && c2?.oauth?.status !== 'connected'; i++) {
    c2 = await api('GET', `/mcp/connections/${conn.id}`);
    if (c2.oauth?.status !== 'connected') await page.waitForTimeout(300);
  }
  if (c2?.oauth?.status !== 'connected') fail(`oauth: koppeling niet verbonden (${c2?.oauth?.status})`);
  else step('OAuth: één klik opent de inlogpagina en de koppeling is verbonden');
  await popup?.close().catch(() => {});
  // Apps use the same picker: "Alle bots" binds the app to every bot.
  await page.getByRole('button', { name: /Alle bots/ }).click({ timeout: 10000 });
  await page.waitForTimeout(800);
  const bound = (await api('GET', `/mcp/connections/${conn.id}`)).agents || [];
  if (bound.length !== 3) fail(`apps: "Alle bots" koppelt ${bound.length} bots`);
  else step('Apps: dezelfde bot-kiezer, "Alle bots" koppelt de app aan alle 3 bots');
  await page.screenshot({ path: path.join(shots, 'app-alle-bots.png') });

  // ---------------------------------------------------------------- 4. skills: check for updates + thin warning
  await page.goto(`${app.url}/#/m/skills/mine`);
  // Rarely needed, so it is in the page's "Meer opties".
  await page.getByTestId('myskills-more').click({ timeout: 10000 });
  await page.getByRole('menuitem', { name: 'Controleer op updates' }).click({ timeout: 10000 });
  await page.getByText(/Gecontroleerd .*geen updates/).waitFor({ timeout: 10000 }).catch(() => fail('skills: "Controleer op updates" toont geen uitkomst'));
  step('Mijn skills: "Controleer op updates" geeft een uitkomst');
  await page.getByRole('button', { name: 'Importeren' }).click();
  const imp = page.getByRole('dialog');
  await imp.getByLabel('Inhoud van SKILL.md').fill('---\nname: grill-me\ndescription: Interview me relentlessly about a plan.\n---\n\nCall the Skill tool with grilling.\n');
  await imp.getByRole('button', { name: 'Voorvertoning' }).click();
  await imp.getByText(/Deze skill doet zelf weinig: hij verwijst alleen naar de skill “grilling”/).waitFor({ timeout: 10000 }).catch(() => fail('skills: geen waarschuwing voor een skill die alleen verwijst'));
  step('import: "Deze skill doet zelf weinig" vóór het installeren');
  await page.screenshot({ path: path.join(shots, 'skill-doet-weinig.png') });
  // After installing, the dialog no longer says "Er is nog niets geïnstalleerd" next to "Klaar".
  const nothingYet = imp.getByText('Er is nog niets geïnstalleerd', { exact: false });
  if (!(await nothingYet.count())) fail('import: de uitleg "Er is nog niets geïnstalleerd" ontbreekt vóór het installeren');
  await imp.getByRole('button', { name: /^Installeren$|skills installeren/ }).last().click();
  await imp.getByText(/Klaar\. Je vindt de skills onder Mijn skills\./).waitFor({ timeout: 10000 }).catch(() => fail('import: geen "Klaar" na installeren'));
  if (await nothingYet.count()) fail('import: na installeren staat er nog "Er is nog niets geïnstalleerd"');
  else step('import: na installeren alleen "Klaar", niet meer "Er is nog niets geïnstalleerd"');
  await page.keyboard.press('Escape');

  // ---------------------------------------------------------------- 5. restore dialog says what will happen
  // Only files made after the snapshot: the dialog must not claim "Er is niets te herstellen" while the switch
  // deletes them, and the list title follows the switch.
  {
    const b = bots[2];
    const ws = app.ctx.store.agent(b.id).workspace;
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'oud.txt'), 'oud');
    await api('POST', `/computers/${b.id}/snapshots`, { label: 'Voor de klus' });
    fs.writeFileSync(path.join(ws, 'later.txt'), 'later gemaakt');
    // Without a rehearsal the side panel only shows the files of the conversation; the snapshots (Wijzigingen) are an
    // expert panel, shown with "Geavanceerd tonen" (settings.ui.advanced).
    const uiBefore = app.ctx.store.settings(owner.id).ui || {};
    app.ctx.store.setSetting(owner.id, 'ui', { ...uiBefore, advanced: true });
    await page.reload();
    await page.setViewportSize({ width: 1500, height: 950 });
    await page.goto(`${app.url}/#/a/${b.id}`);
    await page.waitForURL(/#\/t\//, { timeout: 15000 });
    await page.waitForTimeout(800);
    if (!(await page.getByRole('tab', { name: 'Wijzigingen' }).count())) await page.getByRole('button', { name: /Zijpaneel|Details|zijpaneel/ }).first().click();
    await page.getByRole('tab', { name: 'Wijzigingen' }).click();
    await page.getByRole('button', { name: /Herstel/ }).first().click();
    const rd = page.getByRole('dialog');
    await rd.getByText('later.txt').waitFor({ timeout: 10000 });
    if (await rd.getByText('Er is niets te herstellen').count()) fail('herstellen: "Er is niets te herstellen" terwijl er later gemaakte bestanden weg kunnen');
    await rd.getByText(/Verwijder ook het later gemaakte bestand/).click();
    if (!(await rd.getByText('Later gemaakt (wordt verwijderd)').count())) fail('herstellen: de lijsttitel zegt niet dat de later gemaakte bestanden weggaan');
    else step('herstellen: geen "niets te herstellen" naast later gemaakte bestanden; de titel volgt de schakelaar');
    await page.screenshot({ path: path.join(shots, 'herstellen-later-gemaakt.png') });
    await page.keyboard.press('Escape');
    app.ctx.store.setSetting(owner.id, 'ui', uiBefore);
    await page.reload();
  }

  // ---------------------------------------------------------------- 6. paid voice shows its price
  // A bot that reads aloud with an OpenAI voice: the model hint shows the price per minute, also for a model that
  // OpenAI will stop (that notice used to replace the price).
  {
    const oai = app.ctx.providers.create(owner.id, { kind: 'openai', name: 'OpenAI', apiKey: 'sk-e2e-niet-echt' });
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.goto(`${app.url}/#/agents/${bots[1].id}`);
    await page.waitForTimeout(1200);
    await tab('Instructies');
    if (!(await page.getByLabel('Voorlezen met').count())) for (const b of await page.getByRole('button', { name: /^(Stem|Spraak)/ }).all()) await b.click().catch(() => {});
    // TeamBot's own dropdown (components/Listbox.tsx): open it, the options carry data-value.
    const optionsOf = async (box) => {
      await box.click();
      const vals = await page.locator('[role="listbox"] [role="option"]').evaluateAll((os) => os.map((o) => o.getAttribute('data-value')));
      await page.keyboard.press('Escape');
      return vals;
    };
    const pick = async (box, value) => (await box.click(), await page.locator(`[role="listbox"] [role="option"][data-value="${value}"]`).click());
    await pick(page.getByLabel('Voorlezen met').first(), 'provider');
    const voiceBox = page.getByLabel('Voorlezen met').first().locator('xpath=ancestor::div[contains(@class,"space-y-3")][1]');
    const provSel = voiceBox.getByLabel('Provider');
    await provSel.waitFor({ timeout: 10000 }).catch(() => {});
    const provOpts = await optionsOf(provSel);
    if (provOpts.includes(oai.id)) await pick(provSel, oai.id);
    const modelSel = voiceBox.getByLabel('Model');
    const models = await optionsOf(modelSel);
    let priced = 0;
    for (const m of models) {
      await pick(modelSel, m);
      const hint = (await modelSel.locator('xpath=ancestor::*[.//label][1]').innerText()).replace(/\n/g, ' ');
      if (/per minuut spraak/.test(hint)) priced++;
      else if (/stopt hiermee/.test(hint)) fail(`voorlezen: model ${m} toont alleen de stopdatum, geen prijs`);
    }
    if (!priced) fail('voorlezen: geen enkel OpenAI-stemmodel toont een prijs per minuut');
    else step(`voorlezen met een OpenAI-stem: ${priced} van ${models.length} modellen tonen de prijs per minuut (ook als OpenAI ermee stopt)`);
    await page.screenshot({ path: path.join(shots, 'stem-prijs.png') });
    await page.goto(`${app.url}/#/`);
    await page.getByRole('button', { name: 'Niet opslaan' }).click({ timeout: 3000 }).catch(() => {});
  }

  // ---------------------------------------------------------------- 7. "Daglimiet bereikt … Instellingen › Kosten" leads to the field
  await page.goto(`${app.url}/#/settings/usage`);
  await page.getByRole('link', { name: 'Aanpassen' }).click({ timeout: 10000 }).catch(() => fail('kosten: geen link "Aanpassen" bij het dagbudget'));
  await page.getByLabel('Dagbudget in USD').waitFor({ timeout: 5000 }).then(
    () => step('Instellingen › Kosten: "Aanpassen" bij het dagbudget opent het veld'),
    () => fail('kosten: "Aanpassen" opent het dagbudget-veld niet'),
  );

  // ---------------------------------------------------------------- phone width
  await page.setViewportSize({ width: 390, height: 800 });
  for (const h of [`/agents/${bots[1].id}`, `/m/skills/mine/${skillId}`, `/m/mcp/c/${conn.id}`, '/m/skills/mine']) {
    await page.goto(`${app.url}/#${h}`);
    await page.waitForTimeout(900);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (over > 1) fail(`horizontale overflow ${over}px op ${h} (390 px)`);
  }
  // The sticky bar on a phone.
  await page.goto(`${app.url}/#/agents/${bots[1].id}`);
  await page.getByLabel('Naam', { exact: true }).fill('Onderzoeker 2');
  await page.getByRole('status').filter({ hasText: 'Niet opgeslagen' }).waitFor({ timeout: 5000 }).catch(() => fail('telefoon: geen plakbalk'));
  await page.screenshot({ path: path.join(shots, 'telefoon-editor.png') });
  await page.getByRole('status').filter({ hasText: 'Niet opgeslagen' }).getByRole('button', { name: 'Opslaan' }).click();
  // Wait for the save itself (a busy machine needs more than a fixed 800 ms).
  for (let i = 0; i < 25 && app.ctx.store.agent(bots[1].id).name !== 'Onderzoeker 2'; i++) await page.waitForTimeout(200);
  if (app.ctx.store.agent(bots[1].id).name !== 'Onderzoeker 2') fail('telefoon: Opslaan in de plakbalk bewaart niet');
  step('telefoonbreedte zonder horizontale overflow; plakbalk werkt');
  step(`schermafbeeldingen: ${shots}`);
} catch (e) {
  fail(e.stack || e.message);
} finally {
  await browser.close();
  await app.close();
  oauth.closeAllConnections?.();
  oauth.close();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(extraFolder, { recursive: true, force: true });
}
if (errors.length) fail('console-fouten:\n  ' + errors.join('\n  '));
console.log(process.exitCode ? 'E2E UITBREIDINGEN MISLUKT' : 'E2E UITBREIDINGEN GESLAAGD');
