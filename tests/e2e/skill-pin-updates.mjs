// End-to-end, PARITEIT 7.3 (0.4.4): a TeamBot update brings a newer pin in its own skill catalogue → Mijn skills and the
// skill itself say so calmly, with what changed; updating stays a click in the comparison, with the usual checks.
// Real server (desktop mode, temp data) and UI build in Edge headless; GitHub is a fake served from the catalogue test
// fixtures (tests/fixtures/curated/acme-skills v1 → v2). Also as the paired phone (402 px, touch).
// Usage: npm run build:ui && node --import tsx tests/e2e/skill-pin-updates.mjs   (TEAMBOT_E2E_BROWSER=chrome|msedge)
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

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-pin-home-'));
Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') });
delete process.env.TEAMBOT_DATA;
delete process.env.TEAMBOT_OFFLINE;

const { createApp } = await import('./server.mjs');
const { gitBlobSha } = await import('../../server/modules/skills/curated-source.ts');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-pin-'));
const app = await createApp({ dataDir: dir, port: Number(process.env.TEAMBOT_E2E_PORT) || 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const pcToken = app.ctx.auth.ensureLocalOwner();

// ---- a fake GitHub with two commits of the fixture repository
const C1 = '1111111111111111111111111111111111111111';
const C2 = '2222222222222222222222222222222222222222';
const REPO = 'acme/skills';
const FX = path.resolve('tests/fixtures/curated/acme-skills');
const filesOf = (d) => {
  const out = new Map();
  const walk = (x) => {
    for (const e of fs.readdirSync(x, { withFileTypes: true })) {
      const full = path.join(x, e.name);
      if (e.isDirectory()) walk(full);
      else out.set(path.relative(d, full).split(path.sep).join('/'), fs.readFileSync(full));
    }
  };
  walk(d);
  return out;
};
const commits = new Map([
  [C1, filesOf(path.join(FX, 'v1'))],
  [C2, filesOf(path.join(FX, 'v2'))],
]);
const ok = (url, body) => ({ status: 200, contentType: '', url, body: Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)), headers: {} });
app.ctx.services.skills.setFetcher(async (url) => {
  let m = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/git\/trees\/([0-9a-f]{40})\?recursive=1$/.exec(url);
  if (m && m[1] === REPO && commits.has(m[2])) return ok(url, { sha: m[2], tree: [...commits.get(m[2])].map(([p, b]) => ({ path: p, mode: '100644', type: 'blob', sha: gitBlobSha(b), size: b.length })), truncated: false });
  m = /^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/([0-9a-f]{40})\/(.+)$/.exec(url);
  if (m && m[1] === REPO && commits.has(m[2])) {
    const b = commits.get(m[2]).get(m[3].split('/').map(decodeURIComponent).join('/'));
    return b ? ok(url, b) : { status: 404, contentType: '', url, body: Buffer.alloc(0), headers: {} };
  }
  if (url === `https://github.com/${REPO}/archive/HEAD.zip`) return { status: 302, contentType: '', url, body: Buffer.alloc(0), headers: { location: `https://codeload.github.com/${REPO}/zip/${C1}` } };
  throw new Error(`onverwacht netwerkverzoek: ${url}`);
});
const SOURCE = (commit, extra = {}) => ({
  id: 'acme',
  repo: REPO,
  commit,
  commitDate: '2026-11-01',
  owner: 'acme',
  publisher: 'Acme Test',
  license: 'MIT',
  verifiedAt: '2026-11-09',
  note: 'Testbron.',
  skills: [
    { path: 'skills/good', pack: 'Test', category: 'Test', note: 'Een goede skill.' },
    { path: 'skills/scripted', pack: 'Test', category: 'Test', note: 'Met een script.', scripts: true },
  ],
  ...extra,
});
app.ctx.services.skills.setCuratedSources([SOURCE(C1)]);

const errors = [];
const axe = async (page, where) => {
  await page.addScriptTag({ content: axeSource });
  const r = await page.evaluate(async () => (await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] })).violations.map((v) => `${v.id}: ${v.nodes.length}`));
  if (r.length) fail(`${where}: toegankelijkheid: ${r.join(', ')}`);
};

try {
  const call = async (token, method, p, body) => {
    const r = await fetch(app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const good = (await call(pcToken, 'POST', '/skills/curated/install', { id: 'acme/skills/good' })).body;
  const scripted = (await call(pcToken, 'POST', '/skills/curated/install', { id: 'acme/skills/scripted' })).body;
  if (!good.skillId || !scripted.skillId) throw new Error(`installeren mislukt: ${JSON.stringify(good)}`);
  // A TeamBot update ships a newer pin.
  app.ctx.services.skills.setCuratedSources([SOURCE(C2, { commitDate: '2026-11-08', pinNote: 'De stappen staan nu in de goede volgorde.' })]);
  step('twee catalogusskills geïnstalleerd op de oude vastgezette versie; de catalogus zet er een nieuwere vast');

  // ================================================================ the paired phone first: it only looks
  const ticket = await call(pcToken, 'POST', '/mobile/pair', { baseUrl: app.url });
  const secret = new URLSearchParams(new URL(ticket.body.url).hash.slice(1)).get('t');
  const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TeamBotiOS/0.4.2';
  const claim = await fetch(`${app.url}/api/public/mobile/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA }, body: JSON.stringify({ secret, name: 'iPhone', platform: 'ios', client: 'ios-app' }) });
  const phoneToken = (await claim.json()).token;
  const phoneCtx = await browser.newContext({ viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true, userAgent: UA, locale: 'nl-NL', bypassCSP: true });
  await phoneCtx.addInitScript((t) => localStorage.setItem('tb_token', t), phoneToken);
  const phone = await phoneCtx.newPage();
  phone.on('pageerror', (e) => errors.push(`telefoon: ${e.message}`));
  await phone.goto(`${app.url}/#/m/skills/mine`);
  const pBanner = phone.getByRole('region', { name: /nieuwe versie in de TeamBot-catalogus/i });
  await pBanner.waitFor({ timeout: 15000 });
  const pText = await pBanner.innerText();
  if (!/good/.test(pText) || /scripted/.test(pText)) fail(`telefoon: melding noemt niet alleen "good": ${pText}`);
  if (!/De stappen staan nu in de goede volgorde\./.test(pText) || !/2 bestanden anders/.test(pText)) fail(`telefoon: wat er verandert ontbreekt: ${pText}`);
  const wide = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (wide) fail('telefoon: Mijn skills schuift opzij');
  await phone.getByRole('link', { name: /good/ }).first().tap();
  await phone.getByText('De TeamBot-catalogus heeft een nieuwere versie van deze skill.').waitFor({ timeout: 10000 });
  await axe(phone, 'telefoon, skill');
  step('telefoon (402 px): rustige melding met de datum, wat er anders is en welke bestanden; op de skill zelf ook; schuift niet opzij');

  // ================================================================ the computer: look, compare, update with a click
  const pcCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'nl-NL', bypassCSP: true });
  const pc = await pcCtx.newPage();
  pc.on('pageerror', (e) => errors.push(`computer: ${e.message}`));
  await pc.goto(`${app.url}/#token=${pcToken}`);
  await pc.evaluate(() => (location.hash = '#/m/skills/mine'));
  const banner = pc.getByRole('region', { name: /nieuwe versie in de TeamBot-catalogus/i });
  await banner.waitFor({ timeout: 15000 });
  await pc.getByText('Update beschikbaar').first().waitFor({ timeout: 5000 });
  if ((await pc.getByText('Update beschikbaar').count()) !== 1) fail('computer: "Update beschikbaar" staat er niet precies één keer (scripted veranderde niet)');
  await axe(pc, 'computer, Mijn skills');
  await banner.getByRole('button', { name: 'Bekijk wat er verandert in good' }).click();
  const dialog = pc.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByText('Er verandert niets tot jij op Bijwerken klikt.', { exact: false }).waitFor({ timeout: 10000 });
  const before = (await call(pcToken, 'GET', `/skills/${good.skillId}`)).body.source.commit;
  if (before !== C1) fail(`bekijken veranderde al iets: ${before}`);
  await dialog.getByRole('button', { name: 'Bijwerken' }).click();
  for (let i = 0; i < 100 && (await call(pcToken, 'GET', `/skills/${good.skillId}`)).body.source.commit !== C2; i++) await pc.waitForTimeout(100);
  if ((await call(pcToken, 'GET', `/skills/${good.skillId}`)).body.source.commit !== C2) fail('na Bijwerken: nog de oude versie');
  if (await dialog.isVisible().catch(() => false)) await pc.keyboard.press('Escape');
  await banner.waitFor({ state: 'detached', timeout: 10000 }).catch(() => fail('na bijwerken: de melding blijft staan'));
  step('computer: melding en "Update beschikbaar" alleen bij de veranderde skill, vergelijken verandert niets, Bijwerken met één klik, daarna is de melding weg');

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
console.log(process.exitCode ? 'MISLUKT' : 'OK: nieuwere catalogusversie rustig gemeld, bijwerken blijft een klik');
