// End-to-end (0.4.5): "De marktplaats voor skills moet duidelijk zijn." The Marktplaats opens on what fits your bots
// (a SEO bot gets the SEO skill), Skills shows subjects as tiles plus one search box, a card has one sentence,
// "Gratis", the licence and one button "Toevoegen": one click, and every bot of the team can use it. The checks stay;
// on the card they are one "Gecontroleerd" with the details behind (i). Also as the paired phone (402 px, touch).
// Real server (desktop mode, temp data) and UI build in Edge headless; GitHub is a fake served from the catalogue test
// fixtures (tests/fixtures/curated/acme-skills v1), the MCP register is not reachable (no network in tests).
// Usage: npm run build:ui && node --import tsx tests/e2e/market-clear.mjs   (TEAMBOT_E2E_SHOTS=<dir> for screenshots)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const step = (s) => console.log(`• ${s}`);
const fail = (s) => {
  console.error(`✗ ${s}`);
  process.exitCode = 1;
};
const SHOTS = process.env.TEAMBOT_E2E_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-market-home-'));
Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') });
delete process.env.TEAMBOT_DATA;
delete process.env.TEAMBOT_OFFLINE;

const { createApp } = await import('./server.mjs');
const { gitBlobSha } = await import('../../server/modules/skills/curated-source.ts');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-market-'));
const app = await createApp({ dataDir: dir, port: Number(process.env.TEAMBOT_E2E_PORT) || 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const pcToken = app.ctx.auth.ensureLocalOwner();

// ---- a fake GitHub with one commit of the fixture repository; the register answers nothing
const C1 = '1111111111111111111111111111111111111111';
const REPO = 'acme/skills';
const FX = path.resolve('tests/fixtures/curated/acme-skills/v1');
const files = new Map();
const walk = (x) => {
  for (const e of fs.readdirSync(x, { withFileTypes: true })) {
    const full = path.join(x, e.name);
    if (e.isDirectory()) walk(full);
    else files.set(path.relative(FX, full).split(path.sep).join('/'), fs.readFileSync(full));
  }
};
walk(FX);
const ok = (url, body) => ({ status: 200, contentType: '', url, body: Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)), headers: {} });
app.ctx.services.skills.setFetcher(async (url) => {
  let m = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/git\/trees\/([0-9a-f]{40})\?recursive=1$/.exec(url);
  if (m && m[1] === REPO && m[2] === C1) return ok(url, { sha: C1, tree: [...files].map(([p, b]) => ({ path: p, mode: '100644', type: 'blob', sha: gitBlobSha(b), size: b.length })), truncated: false });
  m = /^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/([0-9a-f]{40})\/(.+)$/.exec(url);
  if (m && m[1] === REPO && m[2] === C1) {
    const b = files.get(m[3].split('/').map(decodeURIComponent).join('/'));
    return b ? ok(url, b) : { status: 404, contentType: '', url, body: Buffer.alloc(0), headers: {} };
  }
  throw new Error(`onverwacht netwerkverzoek: ${url}`);
});
app.ctx.services.mcp?.setRegistryFetcher?.(async (url) => {
  throw new Error(`geen netwerk in deze test: ${url}`);
});
// Packs and categories as other catalogue files may name them: fixed groups and one category of its own.
const source = (id, skills) => ({ id, repo: REPO, stars: 1234, commit: C1, commitDate: '2026-11-01', owner: 'acme', publisher: 'Acme Test', license: 'MIT', verifiedAt: '2026-11-09', note: 'Testbron.', skills });
app.ctx.services.skills.setCuratedSources([
  source('acme', [
    { path: 'skills/good', pack: 'SEO', category: 'SEO', note: 'Controleert hoe goed je site gevonden wordt.' },
    { path: 'skills/scripted', pack: 'Klantenservice', category: 'Klantenservice', note: 'Beantwoordt klantvragen netjes.', scripts: true },
  ]),
  source('acme-more', [{ path: 'skills/good', pack: 'Hobby', category: 'Tuinieren', note: 'Een skill in een eigen categorie.' }]),
]);

const errors = [];
const axe = async (page, where) => {
  // Buttons change colour with a short transition: measure once it stands still.
  await page.waitForTimeout(300);
  await page.addScriptTag({ content: axeSource });
  const r = await page.evaluate(async () => (await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] })).violations.map((v) => `${v.id}: ${v.nodes.length} (${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(", ")})`));
  if (r.length) fail(`${where}: toegankelijkheid: ${r.join(', ')}`);
};
const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });

try {
  const call = async (token, method, p, body) => {
    const r = await fetch(app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  // Like after the first screen (welcome/FirstBot.tsx): a Teammap, and every bot made after it gets its own werkplek
  // there (Teammap\<bot>), not a folder in TeamBot's data. With this test's own data folder, that Teammap lies in it.
  const tf = (await call(pcToken, 'GET', '/folders/team')).body;
  if (!path.resolve(tf.suggestion || '').startsWith(path.resolve(dir) + path.sep)) fail(`Teammap: voorstel buiten de eigen gegevensmap van deze test (${tf.suggestion})`);
  await call(pcToken, 'PUT', '/folders/team', { path: tf.suggestion, create: true, label: 'Teammap' });
  const seo = (await call(pcToken, 'POST', '/agents', { name: 'Vindbot', role: 'SEO-specialist', description: 'Zorgt dat de website goed gevonden wordt.' })).body;
  const help = (await call(pcToken, 'POST', '/agents', { name: 'Hulpbot', role: 'Klantenservice', description: 'Beantwoordt vragen van klanten.' })).body;
  if (!seo.id || !help.id) throw new Error(`bots maken mislukt: ${JSON.stringify(seo)}`);
  for (const b of [seo, help]) if (path.resolve(path.dirname(b.workspace)) !== path.resolve(tf.suggestion)) fail(`${b.name}: geen eigen werkplek in de Teammap (${b.workspace})`);
  // What a bot has right now (no per-bot switch: an installed skill is there for the whole team). The field is
  // `enabled` since the one rule for what a bot has (library enabledFor; it was `usable`).
  const skillsOf = async (id) => (await call(pcToken, 'GET', `/skills/agents/${id}`)).body.enabled || [];
  // And where the engine itself looks: a skill folder in the bot's work folder (.claude/skills and .agents/skills),
  // listed in TeamBot's own list file there.
  const inWorkFolder = (bot, skillId) =>
    ['.claude/skills', '.agents/skills'].every((place) => {
      try {
        const list = JSON.parse(fs.readFileSync(path.join(bot.workspace, ...place.split('/'), '.teambot-skills.json'), 'utf8'));
        const name = Object.keys(list.skills || {}).find((n) => list.skills[n].id === skillId);
        return !!name && fs.existsSync(path.join(bot.workspace, ...place.split('/'), name, 'SKILL.md'));
      } catch {
        return false;
      }
    });

  // ================================================================ the computer
  const pcCtx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'nl-NL', bypassCSP: true });
  const pc = await pcCtx.newPage();
  pc.on('pageerror', (e) => errors.push(`computer: ${e.message}`));
  await pc.goto(`${app.url}/#token=${pcToken}`);
  await pc.evaluate(() => (location.hash = '#/m/skills/'));
  const main = pc.locator('#inhoud');
  await main.getByRole('link', { name: 'Aanbevolen', exact: true }).waitFor({ timeout: 15000 });
  if ((await main.getByRole('link', { name: 'Aanbevolen', exact: true }).getAttribute('aria-current')) !== 'page') fail('Marktplaats opent niet op "Aanbevolen voor je bots"');
  const forSeo = main.locator(`[data-rec-bot="${seo.id}"]`);
  await forSeo.waitFor({ timeout: 10000 }).catch(() => fail('Aanbevolen: geen lijst voor de SEO-bot'));
  if (!(await forSeo.locator('[data-skill="acme/skills/good"]').count())) fail('Aanbevolen: de SEO-skill staat niet bij de SEO-bot');
  if (await forSeo.locator('[data-skill="acme/skills/scripted"]').count()) fail('Aanbevolen: de klantenservice-skill staat bij de SEO-bot');
  const forHelp = main.locator(`[data-rec-bot="${help.id}"]`);
  if (!(await forHelp.locator('[data-skill="acme/skills/scripted"]').count())) fail('Aanbevolen: de klantenservice-skill staat niet bij Hulpbot');
  await shot(pc, 'aanbevolen-computer');
  await axe(pc, 'computer, Aanbevolen');
  step('Marktplaats opent op "Aanbevolen voor je bots": SEO-bot → SEO-skill, Hulpbot → klantenservice-skill');

  await main.getByRole('link', { name: 'Alles', exact: true }).click();
  const tiles = main.getByRole('group', { name: 'Onderwerpen' });
  await tiles.waitFor({ timeout: 10000 });
  const tileText = await tiles.innerText();
  for (const t of ['Alles', 'Marketing en SEO', 'Klantenservice en verkoop', 'Tuinieren']) if (!tileText.includes(t)) fail(`Skills: tegel "${t}" ontbreekt (${tileText.replace(/\s+/g, ' ')})`);
  if (!(await main.getByRole('searchbox', { name: 'Zoek een skill' }).count())) fail('Skills: geen zoekvak');
  await tiles.getByRole('button', { name: /Klantenservice en verkoop/ }).click();
  await sleep(150);
  const cards = main.locator('[data-card="curated"]');
  if ((await cards.count()) !== 1 || !(await main.locator('[data-skill="acme/skills/scripted"]').count())) fail(`Skills: tegel Klantenservice filtert niet (${await cards.count()} kaarten)`);
  await tiles.getByRole('button', { name: /Marketing en SEO/ }).click();
  await sleep(150);
  const card = main.locator('[data-skill="acme/skills/good"]');
  if ((await cards.count()) !== 1 || !(await card.count())) fail('Skills: tegel Marketing en SEO filtert niet');
  const cardText = await card.innerText();
  // The card is calm: one signal and one button. Licence and platform are in the details and behind "Gecontroleerd".
  for (const t of ['Gecontroleerd', 'Toevoegen']) if (!cardText.includes(t)) fail(`kaart: "${t}" ontbreekt (${cardText.replace(/\s+/g, ' ')})`);
  for (const t of ['MIT', 'Werkt op Windows']) if (cardText.includes(t)) fail(`kaart: "${t}" hoort in de details, niet op de kaart`);
  if ((await card.getByRole('button').filter({ hasText: /^Toevoegen$/ }).count()) !== 1) fail('kaart: niet precies één knop Toevoegen');
  await card.getByRole('button', { name: 'Wat is gecontroleerd?' }).click();
  const info = pc.getByRole('dialog', { name: 'Wat TeamBot controleert' });
  await info.waitFor({ timeout: 5000 });
  const infoText = await info.innerText();
  if (!/Licentie: MIT/.test(infoText) || !/Veiligheidsscan/.test(infoText) || !/Uitgever/.test(infoText)) fail(`(i): licentie, scan of uitgever ontbreekt: ${infoText}`);
  await pc.keyboard.press('Escape');
  await info.waitFor({ state: 'detached', timeout: 5000 });
  step('Skills: tegels per onderwerp (ook een eigen categorie), zoekvak, kaart met Gratis, licentie, Windows, Gecontroleerd (i) en één knop Toevoegen');

  const cardSource = await card.innerText();
  if (!cardSource.includes('acme/skills') || !/1,2k/.test(cardSource)) fail(`kaart: bron of sterren ontbreken (${cardSource.replace(/\s+/g, ' ')})`);
  await card.getByRole('button', { name: 'Toevoegen' }).click();
  // One click: no dialog, no choice per bot.
  await card.getByText('Toegevoegd').waitFor({ timeout: 15000 }).catch(() => fail('kaart: "Toegevoegd" na één klik ontbreekt'));
  if (await pc.getByRole('dialog').count()) fail('Toevoegen: er opent nog een venster (moet één klik zijn)');
  const good = (await call(pcToken, 'GET', '/skills/curated')).body.items.find((i) => i.id === 'acme/skills/good');
  if (!good?.installed) fail('Toevoegen: de skill is niet toegevoegd');
  else
    for (const b of [seo, help]) {
      if (!(await skillsOf(b.id)).includes(good.installed.skillId)) fail(`Toevoegen: ${b.name} kan de skill niet laden`);
      if (!inWorkFolder(b, good.installed.skillId)) fail(`Toevoegen: de skill staat niet als map in de werkmap van ${b.name} (${b.workspace})`);
    }
  await shot(pc, 'skills-computer');
  await axe(pc, 'computer, Skills');
  step('Toevoegen is één klik: de kaart zegt "Toegevoegd" en beide bots kunnen de skill laden (ook als map in hun werkmap), zonder iets per bot te kiezen');

  // The page of one skill: the way back, where it comes from, what the bot reads.
  await card.getByRole('button', { name: /Good/i }).first().click();
  const skillPage = pc.locator('[data-skill-page="acme/skills/good"]');
  await skillPage.waitFor({ timeout: 15000 }).catch(() => fail('skillpagina opent niet'));
  if (!(await main.getByRole('link', { name: 'Marktplaats' }).count())) fail('skillpagina: geen pijl terug naar de Marktplaats');
  const pageText = await skillPage.innerText();
  for (const t of ['acme/skills', 'Wat de bot leest', 'Herkomst en controle', 'MIT']) if (!pageText.includes(t)) fail(`skillpagina: "${t}" ontbreekt`);
  await shot(pc, 'skill-pagina-computer');
  await axe(pc, 'computer, skillpagina');
  await main.getByRole('link', { name: 'Marktplaats' }).click();
  await tiles.waitFor({ timeout: 10000 }).catch(() => fail('pijl terug: de lijst komt niet terug'));
  if (!(await main.getByRole('button', { name: 'Toevoegen via link' }).count())) fail('Marktplaats: knop "Toevoegen via link" ontbreekt');
  step('Skillpagina met pijl terug, bron, licentie en de instructies; "Toevoegen via link" staat op de marktplaats');

  // ================================================================ the paired phone
  const ticket = await call(pcToken, 'POST', '/mobile/pair', { baseUrl: app.url });
  const secret = new URLSearchParams(new URL(ticket.body.url).hash.slice(1)).get('t');
  const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TeamBotiOS/0.4.2';
  const claim = await fetch(`${app.url}/api/public/mobile/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA }, body: JSON.stringify({ secret, name: 'iPhone', platform: 'ios', client: 'ios-app' }) });
  const phoneToken = (await claim.json()).token;
  const phoneCtx = await browser.newContext({ viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true, userAgent: UA, locale: 'nl-NL', bypassCSP: true });
  await phoneCtx.addInitScript((t) => localStorage.setItem('tb_token', t), phoneToken);
  const phone = await phoneCtx.newPage();
  phone.on('pageerror', (e) => errors.push(`telefoon: ${e.message}`));
  await phone.goto(`${app.url}/#/m/skills/skills`);
  const pm = phone.locator('#inhoud');
  const pTiles = pm.getByRole('group', { name: 'Onderwerpen' });
  await pTiles.waitFor({ timeout: 15000 });
  if (await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) fail('telefoon: Marktplaats schuift opzij');
  await pTiles.getByRole('button', { name: /Klantenservice en verkoop/ }).tap();
  const pCard = pm.locator('[data-skill="acme/skills/scripted"]');
  await pCard.getByRole('button', { name: 'Toevoegen' }).tap();
  await pCard.getByText('Toegevoegd').waitFor({ timeout: 15000 }).catch(() => fail('telefoon: "Toegevoegd" ontbreekt'));
  const scripted = (await call(pcToken, 'GET', '/skills/curated')).body.items.find((i) => i.id === 'acme/skills/scripted');
  if (!scripted?.installed) fail('telefoon: de skill is niet toegevoegd');
  else {
    for (const b of [seo, help]) {
      if (!(await skillsOf(b.id)).includes(scripted.installed.skillId)) fail(`telefoon: ${b.name} kan de skill niet laden`);
      if (!inWorkFolder(b, scripted.installed.skillId)) fail(`telefoon: de skill staat niet als map in de werkmap van ${b.name}`);
    }
    // One click and it works, scripts included (7913f96d): a script runs at the bot's own level, like any command.
    if (!scripted.installed.trusted) fail('telefoon: de scripts van een skill staan uit na toevoegen');
  }
  if (await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) fail('telefoon: Skills schuift opzij');
  await shot(phone, 'skills-telefoon');
  await axe(phone, 'telefoon, Skills');
  await phone.evaluate(() => (location.hash = '#/m/skills/'));
  await pm.getByRole('link', { name: 'Aanbevolen', exact: true }).waitFor({ timeout: 10000 });
  await sleep(500);
  if (await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) fail('telefoon: Aanbevolen schuift opzij');
  await shot(phone, 'aanbevolen-telefoon');
  await axe(phone, 'telefoon, Aanbevolen');
  step('telefoon (402 px): tegel Klantenservice, Toevoegen in één tik: beide bots kunnen de skill laden, scripts staan meteen aan; schuift niet opzij');

  // Removed: the skill folder goes from the werkplek of every bot; the werkplek itself stays.
  if (good?.installed) {
    const folders = [seo, help].flatMap((b) =>
      ['.claude/skills', '.agents/skills'].map((place) => {
        const list = JSON.parse(fs.readFileSync(path.join(b.workspace, ...place.split('/'), '.teambot-skills.json'), 'utf8'));
        return path.join(b.workspace, ...place.split('/'), Object.keys(list.skills).find((n) => list.skills[n].id === good.installed.skillId));
      }),
    );
    const del = await call(pcToken, 'DELETE', `/skills/${good.installed.skillId}`);
    if (del.status !== 200) fail(`verwijderen: ${del.status} ${JSON.stringify(del.body)}`);
    for (const f of folders) if (fs.existsSync(f)) fail(`verwijderen: de skillmap staat nog in de werkplek (${f})`);
    for (const b of [seo, help]) if (!fs.existsSync(b.workspace)) fail(`verwijderen: de werkplek van ${b.name} is weg`);
    step('Verwijderen: de skillmap gaat uit de werkplek van elke bot in de Teammap; de werkplek blijft');
  }

  if (errors.length) fail(`fouten op de pagina: ${errors.join(' | ')}`);
  await pcCtx.close();
  await phoneCtx.close();
} catch (e) {
  fail(String(e?.stack || e));
} finally {
  await browser.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}
console.log(process.exitCode ? 'MISLUKT' : 'OK: Marktplaats duidelijk: tegels, zoeken, één klik Toevoegen voor het hele team, skillpagina met pijl terug');
