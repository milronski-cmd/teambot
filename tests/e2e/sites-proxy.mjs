// End-to-end check + screenshots for "Websites" (B-28) and "Netwerk en proxy" (B-33).
// Starts TeamBot (desktop mode, temp data dir) with a scripted mock model and a local test proxy, then drives
// headless Edge/Chrome: approval card → publish → Websites page → the published site (sandbox checks) → proxy settings
// (wrong login, right login, save). Desktop 1360 px and phone 390×844; no horizontal scroll on the phone.
// Usage: npm run build:ui && node --import tsx tests/e2e/sites-proxy.mjs   (SHOTS_DIR=<folder> for the screenshots)
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.TEAMBOT_SITES_PORT = '0';
process.env.TEAMBOT_SITES_HOST = '127.0.0.1'; // never 0.0.0.0 here (no firewall prompt)
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const { createApp } = await import('./server.mjs');
const { mockAdapter } = await import('../helpers.ts');

const OUT = process.env.SHOTS_DIR || path.join(process.cwd(), '.data', 'shots');
fs.mkdirSync(OUT, { recursive: true });
const step = (s) => console.log(`• ${s}`);
const fail = (s) => {
  console.error(`✗ ${s}`);
  process.exitCode = 1;
};

// ---- a local target + test proxy (Basic login kantoor / Herfst-2026!) ----
const target = http.createServer((req, res) => res.end(`<h1>Via de proxy</h1><p>${req.headers.host}${req.url}</p>`));
await new Promise((r) => target.listen(0, '127.0.0.1', r));
const proxySeen = [];
const want = 'Basic ' + Buffer.from('kantoor:Herfst-2026!').toString('base64');
const direct = new http.Agent();
const proxy = http.createServer((req, res) => {
  proxySeen.push(req.url);
  if (req.headers['proxy-authorization'] !== want) {
    res.writeHead(407, { 'proxy-authenticate': 'Basic realm="kantoor"' });
    return res.end();
  }
  const u = new URL(req.url);
  const up = http.request({ agent: direct, host: '127.0.0.1', port: target.address().port, path: u.pathname + u.search, method: req.method, headers: req.headers }, (r) => (res.writeHead(r.statusCode, r.headers), r.pipe(res)));
  up.on('error', () => (res.writeHead(502), res.end()));
  req.pipe(up);
});
proxy.on('connect', (req, sock) => {
  proxySeen.push('CONNECT ' + req.url);
  if (req.headers['proxy-authorization'] !== want) return sock.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
  const up = net.connect(target.address().port, '127.0.0.1', () => (sock.write('HTTP/1.1 200 OK\r\n\r\n'), up.pipe(sock), sock.pipe(up)));
  up.on('error', () => sock.destroy());
  sock.on('error', () => up.destroy());
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;

// ---- TeamBot with a scripted model ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-e2e-sites-'));
const app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const script = [];
app.ctx.providers.registerKind({ id: 'mock', label: 'Testmodel', type: 'api', needsKey: false, description: 'test', models: ['mock-1'], defaultModel: 'mock-1', create: () => mockAdapter(script, []) });
const token = app.ctx.auth.ensureLocalOwner();
const call = async (method, p, body) => {
  const r = await fetch(app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p}: ${j.error}`);
  return j;
};
const prov = await call('POST', '/providers', { kind: 'mock' });
const bot = await call('POST', '/agents', { name: 'Webbouwer', role: 'Maakt kleine websites', provider_id: prov.id, model: 'mock-1', access_mode: 'ask' });
const owner = app.ctx.store.users()[0];
step(`TeamBot op ${app.url}, testproxy op ${proxyUrl}, data in ${dir}`);

// The site the bot "made" (with a small self-check of the sandbox).
const site = path.join(bot.workspace, 'weekmenu');
fs.mkdirSync(site, { recursive: true });
fs.writeFileSync(
  path.join(site, 'index.html'),
  `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Weekmenu</title><link rel="stylesheet" href="style.css"></head>
<body><main><p class="kicker">Week 45 · voor 4 personen</p><h1>Weekmenu</h1>
<ol class="days"><li><b>Maandag</b><span>Pompoensoep met zuurdesembrood</span></li><li><b>Dinsdag</b><span>Ovenschotel met prei en aardappel</span></li><li><b>Woensdag</b><span>Pasta pesto met geroosterde tomaat</span></li><li><b>Donderdag</b><span>Linzencurry met rijst</span></li><li><b>Vrijdag</b><span>Zelfgemaakte pizza</span></li></ol>
<section class="check"><h2>Afscherming (zelftest)</h2><ul id="checks"></ul></section></main><script src="app.js"></script></body></html>`,
);
fs.writeFileSync(
  path.join(site, 'style.css'),
  `body{margin:0;font-family:system-ui,sans-serif;background:#f6f3ee;color:#1f2328}main{max-width:40rem;margin:0 auto;padding:2.5rem 1.25rem}h1{font-size:2.4rem;margin:.2rem 0 1.5rem}.kicker{color:#8a6d3b;font-weight:600;margin:0}
.days{list-style:none;padding:0;display:grid;gap:.6rem}.days li{background:#fff;border-radius:14px;padding:.9rem 1.1rem;display:flex;gap:1rem;box-shadow:0 1px 2px #0001}.days b{min-width:6.5rem}
.check{margin-top:2rem;background:#fff;border-radius:14px;padding:1rem 1.2rem}.check h2{font-size:1rem;margin:0 0 .5rem}.check li{margin:.25rem 0}.ok{color:#1a7f37}.bad{color:#cf222e;font-weight:700}`,
);
fs.writeFileSync(path.join(site, 'data.json'), JSON.stringify({ items: 5 }));
fs.writeFileSync(
  path.join(site, 'app.js'),
  `const out=document.getElementById('checks');const add=(t,ok)=>{const li=document.createElement('li');li.textContent=(ok?'✔ ':'✘ ')+t;li.className=ok?'ok':'bad';out.appendChild(li)};
try{localStorage.setItem('x','1');add('Kan iets opslaan in localStorage',false)}catch(e){add('Geen toegang tot localStorage',true)}
try{const c=document.cookie;add(c?'Ziet cookies: '+c:'Ziet geen cookies',!c)}catch(e){add('Geen toegang tot cookies',true)}
fetch(${JSON.stringify(app.url + '/api/me')},{credentials:'include'}).then(r=>add('TeamBot-API bereikbaar ('+r.status+')',false)).catch(()=>add('TeamBot-API niet bereikbaar',true));
fetch('data.json').then(r=>r.json()).then(j=>add('Eigen data.json geladen ('+j.items+' dagen)',true)).catch(()=>add('Eigen data.json niet geladen',false));`,
);
fs.writeFileSync(path.join(site, '.env'), 'GEHEIM=1');
fs.writeFileSync(path.join(site, 'notities-wachtwoorden.txt'), 'x');

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const errors = [];
const watch = (page, label) => {
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED|status of 40[134]/.test(m.text()) && errors.push(`${label}: ${m.text()}`));
};
const noOverflow = async (page, label) => {
  const o = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, w: innerWidth, wide: [...document.querySelectorAll('main *, [role=dialog] *, .scroll-thin *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(e).position !== 'fixed').slice(0, 3).map((e) => e.tagName + '.' + String(e.className).slice(0, 40)) }));
  if (o.doc > o.w) fail(`${label}: horizontale scroll (${o.doc} > ${o.w})`);
  else step(`${label}: geen horizontale scroll op ${o.w} px`);
};
const shot = async (page, name) => {
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, name) });
  step(`screenshot ${name}`);
};

try {
  const desk = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  watch(desk, 'desktop');
  await desk.goto(`${app.url}/#token=${token}`);
  await desk.waitForTimeout(800);

  // ---- 1. the bot asks to publish ----
  const th = await call('POST', '/threads', { agentId: bot.id });
  script.push({ text: 'De site staat klaar in de map weekmenu. Mag ik hem publiceren?', toolCalls: [{ name: 'site_publish', args: { path: 'weekmenu', title: 'Weekmenu week 45', reach: 'local', expires_days: 7 } }] }, { text: 'Klaar! Je weekmenu staat online. De link staat hierboven en op de pagina Websites.' });
  await call('POST', `/threads/${th.id}/messages`, { content: 'Maak een website met ons weekmenu en publiceer hem.' });
  await desk.goto(`${app.url}/#/t/${th.id}`);
  const card = desk.getByRole('group', { name: 'Website publiceren' });
  await card.waitFor({ timeout: 15000 });
  await card.getByText(/bestanden ·/).waitFor({ timeout: 10000 });
  const cardText = await card.innerText();
  for (const want of ['wil een website publiceren', 'weekmenu', '4 bestanden', 'Alleen deze computer', 'Na 7 dagen', 'Gaan niet mee', 'Publiceren', 'Weigeren']) if (!cardText.includes(want)) fail(`goedkeuringskaart mist "${want}": ${cardText}`);
  if (/Altijd toestaan/.test(cardText)) fail('goedkeuringskaart biedt "Altijd toestaan"');
  if ((await call('GET', '/sites')).sites.length) fail('site al online vóór goedkeuring');
  else step('goedkeuringskaart zichtbaar, nog niets gepubliceerd');
  await shot(desk, 'site-approval-desktop.png');
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  watch(phone, 'telefoon');
  await phone.goto(`${app.url}/#token=${token}`);
  await phone.waitForTimeout(600);
  await phone.goto(`${app.url}/#/t/${th.id}`);
  const pcard = phone.getByRole('group', { name: 'Website publiceren' });
  await pcard.waitFor({ timeout: 15000 });
  await pcard.getByText(/bestanden ·/).waitFor({ timeout: 10000 });
  await pcard.scrollIntoViewIfNeeded();
  await shot(phone, 'site-approval-phone.png');
  await noOverflow(phone, 'telefoon gesprek met kaart');

  // ---- 2. approve → online ----
  await card.getByRole('button', { name: 'Publiceren' }).click();
  await desk.getByRole('main').getByText('Klaar! Je weekmenu staat online.').waitFor({ timeout: 15000 });
  const { sites } = await call('GET', '/sites');
  if (sites.length !== 1 || sites[0].state !== 'live') fail('site niet online na goedkeuring');
  const live = sites[0];
  step(`gepubliceerd: ${live.urls[0].url}`);
  await shot(desk, 'site-chat-done-desktop.png');

  // more sites for a realistic list: one stopped, one on the network (if this computer has a LAN address)
  const svc = app.ctx.services.sites;
  const agent = app.ctx.store.agent(bot.id);
  const old = path.join(bot.workspace, 'verjaardag');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'index.html'), '<h1>Uitnodiging verjaardag</h1>');
  const r2 = await svc.publish({ userId: owner.id, agent, folder: old, title: 'Uitnodiging verjaardag', reach: 'local', expiresDays: 0, by: 'bot' });
  await svc.stop(r2.site, 'owner');
  if (svc.info(owner).lan.length) {
    const album = path.join(bot.workspace, 'fotoalbum');
    fs.mkdirSync(album, { recursive: true });
    fs.writeFileSync(path.join(album, 'index.html'), '<h1>Fotoalbum</h1>');
    fs.writeFileSync(path.join(album, 'foto.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await svc.publish({ userId: owner.id, agent, folder: album, title: 'Fotoalbum zomer', reach: 'lan', expiresDays: 30, by: 'bot' });
  }

  // ---- 3. Websites page ----
  await desk.goto(`${app.url}/#/m/sites/`);
  await desk.getByText('Weekmenu week 45').waitFor({ timeout: 10000 });
  const pageText = await desk.locator('main, body').first().innerText();
  for (const want of ['niet op het openbare internet', 'Online', 'Gestopt', 'Link kopiëren']) if (!pageText.includes(want)) fail(`Websites-pagina mist "${want}"`);
  await shot(desk, 'site-list-desktop.png');
  await phone.goto(`${app.url}/#/m/sites/`);
  await phone.getByText('Weekmenu week 45').waitFor({ timeout: 10000 });
  await shot(phone, 'site-list-phone.png');
  await noOverflow(phone, 'telefoon Websites');
  await phone.getByText('Weekmenu week 45').scrollIntoViewIfNeeded();
  await phone.locator('h2', { hasText: 'Weekmenu week 45' }).evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await shot(phone, 'site-list-phone-2.png');
  // republish dialog
  // Opnieuw publiceren and Stoppen are in the "⋯" menu of the site.
  await desk.locator('div.rounded-card', { has: desk.locator('h2', { hasText: 'Weekmenu week 45' }) }).getByRole('button', { name: /^Meer opties voor/ }).click();
  if (!(await desk.getByRole('menuitem', { name: 'Stoppen' }).count())) fail('Websites: "Stoppen" ontbreekt in het menu van de site');
  await desk.getByRole('menuitem', { name: 'Opnieuw publiceren' }).click();
  await desk.getByRole('dialog').waitFor();
  await shot(desk, 'site-republish-desktop.png');
  await desk.getByRole('dialog').getByRole('button', { name: 'Annuleren' }).click();

  // ---- 4. the published site itself: sandboxed, no cookies/storage, no TeamBot API ----
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await ctx.addCookies([{ name: 'tb_token', value: token, domain: '127.0.0.1', path: '/' }]);
  const sp = await ctx.newPage();
  await sp.goto(live.urls[0].url);
  await sp.waitForFunction(() => document.querySelectorAll('#checks li').length >= 4, null, { timeout: 10000 });
  const checks = await sp.locator('#checks li').allInnerTexts();
  step('zelftest van de site: ' + checks.join(' | '));
  if (checks.some((c) => c.startsWith('✘'))) fail('de site kon iets wat niet mag: ' + checks.join(' | '));
  await shot(sp, 'site-page-desktop.png');
  const spp = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
  await spp.goto(live.urls[0].url);
  await spp.waitForFunction(() => document.querySelectorAll('#checks li').length >= 4, null, { timeout: 10000 });
  await shot(spp, 'site-page-phone.png');
  // after "Stoppen" the link is dead
  await call('POST', `/sites/${r2.site.id}/republish`, {});
  const before = (await call('GET', '/sites')).sites.find((s) => s.title === 'Uitnodiging verjaardag');
  const deadUrl = before.urls[0].url;
  await call('POST', `/sites/${before.id}/stop`);
  const dead = await sp.goto(deadUrl);
  if (dead?.status() !== 404) fail(`gestopte site gaf ${dead?.status()} in plaats van 404`);
  else step('gestopte site → 404');

  // ---- 5. proxy settings ----
  await desk.goto(`${app.url}/#/settings/network-proxy`);
  await desk.getByText('Proxy voor uitgaand verkeer').waitFor({ timeout: 10000 });
  await shot(desk, 'proxy-settings-desktop.png');
  await desk.getByRole('switch').first().click();
  await desk.getByLabel('Adres van de proxy').fill(proxyUrl);
  await desk.getByLabel('Gebruikersnaam').fill('kantoor');
  await desk.getByLabel('Wachtwoord').fill('verkeerd');
  await desk.getByLabel('Testadres').fill('http://example.com/');
  await desk.getByRole('button', { name: 'Verbinding testen' }).click();
  const res = desk.getByRole('status');
  await res.waitFor({ timeout: 15000 });
  const failText = await res.innerText();
  if (!/weigert de gebruikersnaam of het wachtwoord \(407\)/.test(failText)) fail('verkeerd wachtwoord: ' + failText);
  else step('verkeerd wachtwoord: ' + failText);
  await res.scrollIntoViewIfNeeded();
  await shot(desk, 'proxy-test-fail-desktop.png');
  await desk.getByLabel('Wachtwoord').fill('Herfst-2026!');
  await desk.getByRole('button', { name: 'Verbinding testen' }).click();
  await desk.getByText(/^Gelukt: example\.com bereikt via de proxy/).waitFor({ timeout: 15000 });
  step('goed wachtwoord: ' + (await desk.getByRole('status').innerText()));
  await shot(desk, 'proxy-test-ok-desktop.png');
  await desk.getByRole('button', { name: 'Opslaan' }).click();
  await desk.getByText('Inloggegevens zijn versleuteld opgeslagen').waitFor({ timeout: 10000 });
  const v = await call('GET', '/admin/network/proxy');
  if (!v.active || !v.hasAuth || JSON.stringify(v).includes('Herfst')) fail('proxy niet actief of wachtwoord zichtbaar: ' + JSON.stringify(v));
  // TeamBot's own traffic now goes through the proxy
  const n = proxySeen.length;
  const via = await (await fetch('http://intranet-test.example/')).text().catch((e) => String(e));
  if (proxySeen.length !== n + 1 || !/Via de proxy/.test(via)) fail('fetch ging niet via de proxy');
  else step('uitgaand verkeer van TeamBot gaat via de proxy (geteld)');
  await desk.getByText(/^Proxy actief:/).waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});
  await desk.getByText('Proxy voor uitgaand verkeer').evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await shot(desk, 'proxy-active-desktop.png');
  await phone.goto(`${app.url}/#/settings/network-proxy`);
  await phone.getByText('Proxy voor uitgaand verkeer').waitFor({ timeout: 10000 });
  await shot(phone, 'proxy-settings-phone.png');
  await noOverflow(phone, 'telefoon proxy');
  await phone.getByLabel('Testadres').fill('http://example.com/');
  await phone.getByRole('button', { name: 'Verbinding testen' }).click();
  await phone.getByText(/^Gelukt: example\.com/).waitFor({ timeout: 15000 });
  await phone.getByRole('status').scrollIntoViewIfNeeded();
  await shot(phone, 'proxy-test-phone.png');
  await phone.getByText('Wat gaat via de proxy?').evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await shot(phone, 'proxy-what-phone.png');
  await noOverflow(phone, 'telefoon proxy (onder)');
  // members never: the tab is admin-only (desktop mode = owner). Since 12 Nov it is one row under Instellingen › Meer
  // mogelijkheden › Deze computer for everyone, and always found by the filter.
  await phone.goto(`${app.url}/#/settings`);
  await phone.getByLabel('Zoek een instelling').fill('proxy');
  await phone.getByRole('link', { name: /Netwerk en proxy/ }).waitFor({ timeout: 10000 });
  step('telefoon: het zoekvak in Instellingen vindt "Netwerk en proxy"');
  // switch the proxy off again
  await call('PUT', '/admin/network/proxy', { enabled: false });

  if (errors.length) fail('console-fouten:\n  ' + errors.join('\n  '));
  else step('geen console-fouten');
} catch (e) {
  fail(e?.stack || String(e));
} finally {
  await browser.close();
  await app.close();
  proxy.close();
  target.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* temp */
  }
}
console.log(process.exitCode ? '✗ sites-proxy e2e mislukt' : `✓ sites-proxy e2e geslaagd — screenshots in ${OUT}`);
process.exit(process.exitCode || 0);
