// Bureaublad op afstand (parity 11.7) in the real built app: switched on at the computer, used from a paired iPhone
// (touch: tap, double tap, hold, drag, two-finger scroll, pinch, keyboard, screens, quality, watch only, the idle
// warning) and from a browser on another PC (mouse, wheel, keyboard), then stopped with the Stop of the indicator.
// The screen driver is a dry run: the "desktop" is a picture this test draws itself (two made-up monitors), and every
// click, key or scroll is only recorded — nothing ever reaches the real mouse, keyboard or screen of this PC.
// On every phone screen: dark, no text field below 16 px, no sideways scrolling, axe-core WCAG 2.2 A/AA.
// Usage: npm run build:ui && npm run remote:check   (TEAMBOT_E2E_SHOTS=<dir> screenshots, TEAMBOT_E2E_PORT=<port>)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const step = (s) => console.log(`• ${s}`);
const failures = [];
const fail = (s) => {
  failures.push(s);
  console.error(`✗ ${s}`);
  process.exitCode = 1;
};
const SHOTS = process.env.TEAMBOT_E2E_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not there yet */
    }
    if (Date.now() > end) return fail(`time-out: ${what}`), null;
    await sleep(80);
  }
};
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-remote-home-'));
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  XDG_DATA_HOME: path.join(home, 'xdg', 'data'),
  XDG_CONFIG_HOME: path.join(home, 'xdg', 'config'),
  XDG_CACHE_HOME: path.join(home, 'xdg', 'cache'),
  PATH: path.dirname(process.execPath),
});
delete process.env.Path;
delete process.env.TEAMBOT_DATA;

// ---------------------------------------------------------------- the made-up desktop (drawn by the browser, never the PC's)
const MONITORS = [
  { index: 0, x: 0, y: 0, w: 1920, h: 1080, primary: true, dpi: 96 },
  { index: 1, x: 1920, y: 0, w: 1280, h: 1024, primary: false, dpi: 96 },
];
async function fakeDesktop(w, h, label, color) {
  const p = await browser.newPage({ viewport: { width: w, height: h } });
  await p.setContent(`<body style="margin:0;background:${color};font:48px sans-serif;color:#fff"><div style="position:absolute;left:40px;top:40px">${label}</div><div style="position:absolute;right:0;bottom:0;width:100%;height:60px;background:#1e293b"></div><div style="position:absolute;left:30%;top:30%;width:40%;height:40%;background:#f8fafc;color:#111;padding:20px">Kladblok — testvenster</div></body>`);
  const buf = await p.screenshot({ type: 'jpeg', quality: 60 });
  await p.close();
  return buf;
}
const FRAMES = [await fakeDesktop(1920, 1080, 'Testbureaublad — scherm 1', '#0f766e'), await fakeDesktop(1280, 1024, 'Testbureaublad — scherm 2', '#7c3aed')];
// a screen that keeps changing (a video, someone typing): every picture is new, so the speed of the connection counts
const MOVING = [await fakeDesktop(1920, 1080, 'Testbureaublad — beweegt 1', '#0f766e'), await fakeDesktop(1920, 1080, 'Testbureaublad — beweegt 2', '#115e59')];
let moving = false;
let tick = 0;
const calls = [];
const INPUT = new Set(['click', 'move', 'drag', 'scroll', 'type', 'key', 'focus', 'launch']);
const dryRun = {
  async call(action, input) {
    calls.push({ action, input, at: Date.now() });
    if (action === 'monitors') return { monitors: MONITORS };
    if (action === 'shot') {
      const m = MONITORS.find((x) => x.x === input.area.x && x.y === input.area.y) || MONITORS[0];
      fs.writeFileSync(input.out, moving && m.index === 0 ? MOVING[tick++ % 2] : FRAMES[m.index]);
      return { cursor: { x: m.x + Math.round(m.w / 2), y: m.y + Math.round(m.h / 2) }, windows: [], hidden: 0 };
    }
    return { ok: true };
  },
  kill() {},
};
const inputs = () => calls.filter((c) => INPUT.has(c.action));
const shots = () => calls.filter((c) => c.action === 'shot');

const { createApp } = await import('../../server/app.ts');
const { indicatorView } = await import('../../server/modules/remote-desktop/indicator.ts');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-remote-'));
const app = await createApp({ dataDir: dir, port: Number(process.env.TEAMBOT_E2E_PORT) || 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const pcToken = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();
for (const k of app.ctx.providers.kinds.values()) if (k.detect) k.detect = async () => ({ installed: false, detail: 'e2e' });
const rd = app.ctx.services.remoteDesktop;
const svc = rd._service;
svc.setDriver(dryRun);
// what the desktop app does: the bar with Stop on the screen (here only recorded)
const detach = rd.attachIndicator();
const bar = [];
rd.onState((s) => bar.push(indicatorView(s.sessions)));
const lastBar = () => bar.at(-1);

const call = async (token, method, p, body, headers = {}) => {
  const r = await fetch(app.url + '/api' + p, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
};
step(`TeamBot op ${app.url} (lege datamap ${dir}), schermhulp in proefmodus`);

const errors = [];
let expected = [];
const failed = [];
function watch(page, who) {
  page.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text()) && errors.push(`${who}: ${m.text()}`));
  page.on('dialog', (d) => (errors.push(`${who}: onverwacht browserdialoog: ${d.message()}`), d.dismiss().catch(() => {})));
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith('/api/') || r.status() < 400) return;
    const what = `${r.status()} ${r.request().method()} ${u.pathname}`;
    if (!expected.some((re) => re.test(what))) failed.push(`${who}: ${what}`);
  });
}

async function checks(page, name, { axe = true, dark = true } = {}) {
  await page.waitForTimeout(500);
  const info = await page.evaluate(() => {
    const visible = (e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
    };
    const fields = [...document.querySelectorAll('input, textarea, select')]
      .filter((e) => visible(e) && !['checkbox', 'radio', 'range', 'file', 'hidden', 'color', 'button', 'submit', 'reset', 'image'].includes(e.type))
      .map((e) => ({ name: e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.name || e.tagName, size: parseFloat(getComputedStyle(e).fontSize) }));
    const bg = getComputedStyle(document.querySelector('.dark') || document.body).backgroundColor;
    return { overflow: document.documentElement.scrollWidth - window.innerWidth, dark: document.documentElement.classList.contains('dark') || !!document.querySelector('.dark'), bg, small: fields.filter((f) => f.size < 16), red: [...document.querySelectorAll('[aria-live] .bg-danger, [aria-live] [class*="bg-danger"]')].map((e) => e.textContent) };
  });
  if (info.overflow > 1) fail(`${name}: de pagina schuift ${info.overflow}px opzij`);
  if (dark && !info.dark) fail(`${name}: niet donker`);
  if (dark && info.small.length) fail(`${name}: tekstvelden kleiner dan 16px (iOS zoomt dan in): ${info.small.map((f) => `${f.name} ${f.size}px`).join(', ')}`);
  if (info.red.length) fail(`${name}: rode foutmelding: ${info.red.join(' | ')}`);
  if (failed.length) fail(`${name}: mislukte verzoeken: ${failed.splice(0).join(', ')}`);
  if (errors.length) fail(`${name}: paginafouten: ${errors.splice(0).join(' | ')}`);
  if (axe) {
    await page.addScriptTag({ content: axeSource });
    const v = await page.evaluate(async () => {
      // @ts-ignore
      const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
      return r.violations.map((x) => `${x.id}: ${x.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`);
    });
    if (v.length) fail(`a11y ${name}: ${v.join(' | ')}`);
  }
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`) });
}

const go = async (page, hash, ms = 600) => {
  await page.evaluate((h) => (location.hash = h), hash);
  await page.waitForTimeout(ms);
};
/** The picture of the desktop on the page and a point on it (0..1) in page pixels. */
const frameBox = async (page) => {
  const img = page.getByTestId('remote-frame');
  await img.waitFor({ timeout: 10_000 });
  await until(() => img.evaluate((e) => e.complete && e.naturalWidth > 0), 5000, 'het beeld is geladen');
  return img.boundingBox();
};
const at = (b, x, y) => [b.x + x * b.width, b.y + y * b.height];
const near = (a, b, tol = 10) => Math.abs(a - b) <= tol;

try {
  // ================================================================ 1. at the computer: off by default, switched on there
  const pc = await browser.newContext({ viewport: { width: 1360, height: 880 }, colorScheme: 'light', locale: 'nl-NL', bypassCSP: true });
  const pcPage = await pc.newPage();
  watch(pcPage, 'computer');
  await pcPage.goto(`${app.url}/#token=${pcToken}`);
  await pcPage.waitForTimeout(1200);
  // Reached from Instellingen › Telefoon (0.4.4: not a row of its own, so Instellingen stays short).
  await go(pcPage, '#/settings/mobile-telefoon', 900);
  if (!(await pcPage.getByRole('link', { name: 'Bureaublad op afstand' }).count())) fail('Instellingen › Telefoon: geen link "Bureaublad op afstand"');
  await go(pcPage, '#/m/remote-desktop', 900);
  await pcPage.getByText('Staat uit', { exact: true }).waitFor({ timeout: 8000 });
  const sw = pcPage.getByRole('switch', { name: 'Bureaublad op afstand toestaan' });
  if ((await sw.getAttribute('aria-checked')) !== 'false') fail('computer: de schakelaar staat niet standaard uit');
  await checks(pcPage, 'computer-uit', { dark: false });
  await sw.click();
  const confirm = pcPage.getByRole('alertdialog');
  await confirm.waitFor({ timeout: 5000 });
  if (!/balk met Stop/.test(await confirm.innerText())) fail('computer: de bevestiging zegt niet dat er een stopbalk komt');
  await confirm.getByRole('button', { name: 'Aanzetten' }).click();
  await pcPage.getByText('Staat aan', { exact: true }).waitFor({ timeout: 5000 });
  if (!(await call(pcToken, 'GET', '/remote-desktop')).body.enabled) fail('computer: aanzetten is niet opgeslagen');
  await checks(pcPage, 'computer-aan', { dark: false });
  step('computer: standaard uit, aangezet met de schakelaar en een bevestiging die de stopbalk noemt; vindbaar in Instellingen');

  // ================================================================ 2. pair the iPhone (real flow)
  const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TeamBotiOS/0.4.4';
  const ticket = (await call(pcToken, 'POST', '/mobile/pair', { baseUrl: app.url })).body;
  const secret = new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('t');
  const claimed = await call(null, 'POST', '/public/mobile/claim', { secret, name: 'iPhone van Sanne', platform: 'ios', client: 'ios-app' }, { 'user-agent': IOS_UA });
  const phoneToken = claimed.body.token;
  if (!phoneToken) throw new Error('koppelen mislukt');
  const denied = await call(phoneToken, 'PUT', '/remote-desktop/switch', { enabled: false, control: true });
  if (denied.status !== 403 || denied.body.code !== 'mobile_denied') fail(`telefoon: instellen gaf ${denied.status} ${denied.body.code} (hoort alleen op de computer)`);

  const phone = await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IOS_UA, locale: 'nl-NL', bypassCSP: true });
  await phone.addInitScript((t) => {
    try {
      localStorage.setItem('tb_token', t);
    } catch {}
  }, phoneToken);
  const page = await phone.newPage();
  watch(page, 'telefoon');
  const cdp = await phone.newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id, radiusX: 3, radiusY: 3, force: 1 })) });
  await page.goto(app.url + '/');
  await page.waitForTimeout(1500);
  await go(page, '#/m/remote-desktop', 900);
  await page.getByText('Staat aan', { exact: true }).waitFor({ timeout: 8000 });
  if (await page.getByRole('switch', { name: 'Bureaublad op afstand toestaan' }).count()) fail('telefoon: de aan/uit-schakelaar staat op de telefoon (hoort alleen op de computer)');
  await checks(page, 'telefoon-status');
  step('telefoon (iPhone-app): status "Staat aan", geen schakelaar (instellen alleen op de computer, 403 mobile_denied), wel "Bureaublad openen"');

  // ================================================================ 3. the viewer on the phone
  await page.getByRole('button', { name: 'Bureaublad openen' }).tap();
  let b = await frameBox(page);
  if (!(await until(() => /#\/m\/remote-desktop\/live/.test(page.url()), 3000, 'de viewer opent'))) throw new Error('geen viewer');
  if (Math.abs(b.width / b.height - 16 / 9) > 0.02) fail(`het beeld heeft niet de verhouding van het scherm: ${b.width}×${b.height}`);
  await checks(page, 'telefoon-viewer');
  await until(() => lastBar()?.title === 'iPhone van Sanne kijkt mee op deze computer', 3000, 'de balk op de pc zegt wie meekijkt');
  const sh = shots().at(-1).input;
  if (sh.policy?.owner !== true || sh.fast !== true) fail('beelden: niet met het eigenaarsbeleid');
  step(`viewer: live beeld in de juiste verhouding (${Math.round(b.width)}×${Math.round(b.height)}), donker, toegankelijk; de pc toont "${lastBar()?.title}" met Stop`);

  // tap = click
  let n = inputs().length;
  await touch('touchStart', [at(b, 0.25, 0.5)]);
  await touch('touchEnd', []);
  const click = await until(() => inputs().slice(n).find((c) => c.action === 'click'), 3000, 'tik → klik');
  if (click && !(near(click.input.x, 480) && near(click.input.y, 540) && click.input.button === 'left' && click.input.count === 1)) fail(`tik: klik op ${click.input.x},${click.input.y} ${click.input.button} ×${click.input.count} (verwacht 480,540 links)`);
  await until(() => /bedient deze computer/.test(lastBar()?.title || ''), 3000, 'de balk zegt "bedient"');
  await sleep(600);
  // double tap
  n = inputs().length;
  for (let i = 0; i < 2; i++) {
    await touch('touchStart', [at(b, 0.5, 0.25)]);
    await touch('touchEnd', []);
    await sleep(120);
  }
  const dbl = await until(() => inputs().slice(n).find((c) => c.action === 'click' && c.input.count === 2), 3000, 'twee keer tikken → dubbelklik');
  if (dbl && !(near(dbl.input.x, 960) && near(dbl.input.y, 270))) fail(`dubbelklik op ${dbl.input.x},${dbl.input.y}`);
  await sleep(600);
  // hold = right click
  n = inputs().length;
  await touch('touchStart', [at(b, 0.75, 0.75)]);
  await sleep(800);
  await touch('touchEnd', []);
  const right = await until(() => inputs().slice(n).find((c) => c.action === 'click' && c.input.button === 'right'), 3000, 'vasthouden → rechtsklik');
  if (right && !(near(right.input.x, 1440) && near(right.input.y, 810))) fail(`rechtsklik op ${right.input.x},${right.input.y}`);
  await sleep(500);
  // one-finger drag (not zoomed) = drag with the mouse
  n = inputs().length;
  await touch('touchStart', [at(b, 0.2, 0.2)]);
  for (let i = 1; i <= 8; i++) await touch('touchMove', [at(b, 0.2 + (0.4 * i) / 8, 0.2 + (0.2 * i) / 8)]);
  await touch('touchEnd', []);
  const drag = await until(() => inputs().slice(n).find((c) => c.action === 'drag'), 3000, 'slepen → slepen met de muis');
  if (drag && !(near(drag.input.x, 384) && near(drag.input.y, 216) && near(drag.input.x2, 1152) && near(drag.input.y2, 432))) fail(`slepen: ${JSON.stringify([drag.input.x, drag.input.y, drag.input.x2, drag.input.y2])}`);
  // two fingers up = scroll down
  n = inputs().length;
  await touch('touchStart', [at(b, 0.4, 0.7), at(b, 0.6, 0.7)]);
  for (let i = 1; i <= 12; i++) await touch('touchMove', [[at(b, 0.4, 0.7)[0], at(b, 0.4, 0.7)[1] - i * 8], [at(b, 0.6, 0.7)[0], at(b, 0.6, 0.7)[1] - i * 8]]);
  await touch('touchEnd', []);
  const scroll = await until(() => inputs().slice(n).filter((c) => c.action === 'scroll'), 3000, 'twee vingers → scrollen');
  const notches = (scroll || []).reduce((s, c) => s + c.input.dy, 0);
  if (!(notches >= 2)) fail(`scrollen: ${notches} stappen omlaag (verwacht ≥2)`);
  if (inputs().slice(n).some((c) => c.action !== 'scroll')) fail('twee vingers gaven ook een klik of sleep');
  // pinch = zoom on the phone, nothing on the computer
  n = inputs().length;
  const c0 = at(b, 0.5, 0.5);
  await touch('touchStart', [[c0[0] - 30, c0[1]], [c0[0] + 30, c0[1]]]);
  for (let i = 1; i <= 10; i++) await touch('touchMove', [[c0[0] - 30 - i * 9, c0[1]], [c0[0] + 30 + i * 9, c0[1]]]);
  await touch('touchEnd', []);
  await sleep(400);
  const zb = await page.getByTestId('remote-frame').boundingBox();
  if (!(zb.width > b.width * 1.8)) fail(`knijpen: niet ingezoomd (${Math.round(b.width)} → ${Math.round(zb.width)} px)`);
  if (inputs().length !== n) fail('knijpen stuurde iets naar de computer');
  // zoomed in, a quick one-finger drag pans the picture
  await touch('touchStart', [[200, 400]]);
  for (let i = 1; i <= 5; i++) await touch('touchMove', [[200 + i * 15, 400]]);
  await touch('touchEnd', []);
  await sleep(200);
  if (inputs().length !== n) fail('ingezoomd verschuiven stuurde iets naar de computer');
  if (await page.getByText('Alleen kijken staat aan').count()) fail('melding "alleen kijken" zonder reden');
  await checks(page, 'telefoon-ingezoomd');
  await page.getByRole('button', { name: 'Hele scherm tonen' }).tap();
  await sleep(300);
  b = await frameBox(page);
  step('aanraken: tik = klik, twee keer tikken = dubbelklik, vasthouden = rechtsklik, slepen = slepen, twee vingers = scrollen, knijpen = zoomen (alleen op de telefoon), ingezoomd verschuiven');

  // ================================================================ 4. keyboard
  await page.getByRole('button', { name: 'Toetsenbord' }).tap();
  const field = page.getByRole('textbox', { name: 'Typ op de computer' });
  await field.waitFor({ timeout: 3000 });
  const fs16 = await field.evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  if (fs16 < 16) fail(`toetsenbordveld ${fs16}px (iOS zoomt in)`);
  n = inputs().length;
  await field.focus();
  await page.keyboard.type('hallo', { delay: 40 });
  await until(() => inputs().slice(n).filter((c) => c.action === 'type').map((c) => c.input.text).join('') === 'hallo', 4000, 'typen komt aan als "hallo"');
  await page.keyboard.press('Backspace');
  await until(() => inputs().slice(n).some((c) => c.action === 'key' && JSON.stringify(c.input.combos) === '[[8]]'), 3000, 'Backspace');
  await page.keyboard.press('Enter');
  await until(() => inputs().slice(n).some((c) => c.action === 'key' && JSON.stringify(c.input.combos) === '[[13]]'), 3000, 'Enter');
  for (const [label, want] of [
    ['Alt+Tab', '[[18,9]]'],
    ['Ctrl+V', '[[17,86]]'],
    ['Esc', '[[27]]'],
  ]) {
    const k = inputs().length;
    await page.getByRole('toolbar', { name: 'Toetsen' }).getByRole('button', { name: label, exact: true }).tap();
    await until(() => inputs().slice(k).some((c) => c.action === 'key' && JSON.stringify(c.input.combos) === want), 3000, `toets ${label}`);
  }
  await checks(page, 'telefoon-toetsenbord');
  await page.getByRole('button', { name: 'Toetsenbord sluiten' }).tap();
  step(`toetsenbord: veld van ${fs16}px, "hallo" getypt, Backspace, Enter, Alt+Tab, Ctrl+V en Esc als knoppen`);

  // ================================================================ 4b. a slow connection: the picture gets smaller by itself
  const before = shots().at(-1).input.outW;
  await cdp.send('Network.enable');
  moving = true;
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 300, downloadThroughput: 25 * 1024, uploadThroughput: 25 * 1024 });
  const slowAt = shots().length;
  const smaller = await until(() => shots().slice(slowAt).some((c) => c.input.outW <= 1024), 25_000, 'trage verbinding → kleiner beeld');
  const pill = await page.getByTestId('remote-status').innerText().catch(() => '');
  if (!/Trage verbinding/.test(pill)) fail(`trage verbinding: de statusregel zegt "${pill}"`);
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  moving = false;
  if (smaller) step(`trage verbinding (25 kB/s, 300 ms): beeld van ${before} naar ${shots().at(-1).input.outW} px breed, statusregel "${pill}"`);

  // ================================================================ 5. other screen, quality, watch only, idle warning
  await page.getByRole('combobox', { name: 'Scherm' }).selectOption({ label: 'Scherm 2' });
  await until(() => shots().at(-1).input.area.x === 1920, 4000, 'beelden van scherm 2');
  await sleep(500);
  b = await frameBox(page);
  if (Math.abs(b.width / b.height - 1280 / 1024) > 0.02) fail(`scherm 2: verhouding ${b.width}×${b.height}`);
  n = inputs().length;
  await touch('touchStart', [at(b, 0.5, 0.5)]);
  await touch('touchEnd', []);
  const c2 = await until(() => inputs().slice(n).find((c) => c.action === 'click'), 3000, 'klik op scherm 2');
  if (c2 && !(near(c2.input.x, 2560) && near(c2.input.y, 512))) fail(`scherm 2: klik op ${c2.input.x},${c2.input.y} (verwacht 2560,512)`);

  await page.getByRole('button', { name: 'Opties' }).tap();
  const dlg = page.getByRole('dialog', { name: 'Opties' });
  await dlg.waitFor({ timeout: 3000 });
  await checks(page, 'telefoon-opties');
  await dlg.getByRole('combobox', { name: 'Beeldkwaliteit' }).selectOption('saver');
  await dlg.getByRole('switch').click();
  await page.getByRole('button', { name: 'Sluiten' }).tap();
  await until(() => shots().at(-1).input.outW === 720, 4000, 'zuinig: kleiner beeld (720 px)');
  await sleep(600);
  n = inputs().length;
  await touch('touchStart', [at(b, 0.3, 0.3)]);
  await touch('touchEnd', []);
  await page.getByText('Alleen kijken staat aan', { exact: false }).first().waitFor({ timeout: 3000 }).catch(() => fail('alleen kijken: geen uitleg bij een tik'));
  await sleep(300);
  if (inputs().length !== n) fail('alleen kijken: een tik kwam toch op de computer aan');
  await page.getByRole('button', { name: 'Opties' }).tap();
  await dlg.getByRole('switch').click();
  await dlg.getByRole('combobox', { name: 'Beeldkwaliteit' }).selectOption('auto');
  await page.getByRole('button', { name: 'Sluiten' }).tap();

  // nine and a half minutes without input (of the ten): the warning a minute before the stop
  for (const x of svc.sessions.values()) x.lastActiveAt -= 9.5 * 60_000;
  await page
    .getByRole('button', { name: 'Ik ben er nog' })
    .waitFor({ timeout: 6000 })
    .catch(async (e) => {
      console.error(await page.locator('body').innerText());
      throw e;
    });
  await checks(page, 'telefoon-bijna-gestopt');
  await page.getByRole('button', { name: 'Ik ben er nog' }).tap();
  await until(async () => !(await page.getByRole('button', { name: 'Ik ben er nog' }).count()), 6000, '"Ik ben er nog" houdt de sessie open');
  step('scherm 2 gekozen (klik op de juiste pixel), kwaliteit "Zuinig" geeft kleinere beelden, alleen kijken stuurt niets, een minuut voor het vanzelf stoppen: "Ik ben er nog"');

  // ================================================================ 6. a browser on another PC (mouse and keyboard)
  const laptopToken = app.ctx.auth.createSession(owner.id, 'web', 'Laptop').token;
  const laptop = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark', locale: 'nl-NL', bypassCSP: true, extraHTTPHeaders: { 'x-forwarded-for': '192.168.1.20' } });
  await laptop.addInitScript((t) => {
    try {
      localStorage.setItem('tb_token', t);
    } catch {}
  }, laptopToken);
  const lp = await laptop.newPage();
  watch(lp, 'andere pc');
  await lp.goto(app.url + '/');
  await lp.waitForTimeout(1200);
  await go(lp, '#/m/remote-desktop', 900);
  await lp.getByText('Staat aan', { exact: true }).waitFor({ timeout: 8000 });
  if (await lp.getByRole('switch', { name: 'Bureaublad op afstand toestaan' }).count()) fail('andere pc: de schakelaar staat er (aanzetten hoort alleen op de computer zelf)');
  expected = [/^403 PUT \/api\/remote-desktop\/switch$/];
  const far = await lp.evaluate(async () => (await fetch('/api/remote-desktop/switch', { method: 'PUT', headers: { authorization: `Bearer ${localStorage.getItem('tb_token')}`, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) })).json());
  if (far.code !== 'remote_here_only') fail(`andere pc: instellen gaf ${JSON.stringify(far)}`);
  expected = [];
  await lp.getByRole('button', { name: 'Bureaublad openen' }).click();
  let lb = await frameBox(lp);
  await until(() => lastBar()?.title === '2 apparaten kijken mee op deze computer', 3000, 'de balk telt twee apparaten');
  await checks(lp, 'andere-pc-viewer', { dark: false });
  const mouse = async (x, y, o = {}) => {
    const [px, py] = at(lb, x, y);
    await lp.mouse.click(px, py, o);
  };
  n = inputs().length;
  await mouse(0.5, 0.5);
  const mc = await until(() => inputs().slice(n).find((c) => c.action === 'click'), 3000, 'muisklik');
  if (mc && !(near(mc.input.x, 960, 4) && near(mc.input.y, 540, 4))) fail(`muisklik op ${mc.input.x},${mc.input.y}`);
  n = inputs().length;
  await mouse(0.25, 0.25, { button: 'right' });
  const mr = await until(() => inputs().slice(n).find((c) => c.action === 'click' && c.input.button === 'right'), 3000, 'rechtermuisknop');
  if (mr && !(near(mr.input.x, 480, 4) && near(mr.input.y, 270, 4))) fail(`rechtsklik op ${mr.input.x},${mr.input.y}`);
  n = inputs().length;
  await lp.mouse.move(...at(lb, 0.5, 0.5));
  await lp.mouse.wheel(0, 300);
  const mw = await until(() => inputs().slice(n).filter((c) => c.action === 'scroll').reduce((s, c) => s + c.input.dy, 0) >= 3, 3000, 'scrollwiel');
  if (!mw) fail('scrollwiel kwam niet aan');
  n = inputs().length;
  await lp.mouse.move(...at(lb, 0.1, 0.1));
  await lp.mouse.down();
  for (let i = 1; i <= 6; i++) await lp.mouse.move(...at(lb, 0.1 + i * 0.05, 0.1 + i * 0.05));
  await lp.mouse.up();
  const md = await until(() => inputs().slice(n).find((c) => c.action === 'drag'), 3000, 'slepen met de muis');
  if (md && !(near(md.input.x, 192, 4) && near(md.input.x2, 768, 4))) fail(`slepen met de muis: ${md.input.x} → ${md.input.x2}`);
  n = inputs().length;
  await lp.keyboard.type('ok');
  await lp.keyboard.press('Control+c');
  await until(() => inputs().slice(n).filter((c) => c.action === 'type').map((c) => c.input.text).join('') === 'ok', 3000, 'typen met een echt toetsenbord');
  await until(() => inputs().slice(n).some((c) => c.action === 'key' && JSON.stringify(c.input.combos) === '[[17,67]]'), 3000, 'Ctrl+C met een echt toetsenbord');
  await lp.keyboard.press('Shift+Escape');
  const focusOut = await lp.evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent || '');
  if (!/Stop/.test(focusOut)) fail(`Shift+Esc zet de focus niet terug op de knoppen (nu: ${focusOut})`);
  step('andere pc: geen schakelaar (403 remote_here_only), klikken, rechtsklikken, scrollwiel, slepen, typen en Ctrl+C met muis en toetsenbord; Shift+Esc terug naar de knoppen; de balk zegt "2 apparaten"');

  // ================================================================ 7. Stop on the computer
  expected = [/^410 GET \/api\/remote-desktop\/sessions\/[^/]+(\/frame)?$/, /^404 /, /^410 POST /];
  const r = rd.stopFromComputer('stopknop');
  if (r.ended !== 2 || !r.wasOn) fail(`stop: ${JSON.stringify(r)}`);
  await page.getByText('Gestopt op de computer', { exact: false }).first().waitFor({ timeout: 6000 }).catch(() => fail('telefoon: geen uitleg na Stop op de computer'));
  if (await page.getByRole('button', { name: 'Opnieuw verbinden' }).count()) fail('telefoon: "Opnieuw verbinden" na Stop (het staat uit)');
  await lp
    .getByRole('alert')
    .getByText('Gestopt op de computer', { exact: false })
    .waitFor({ timeout: 6000 })
    .catch(async () => fail(`andere pc: geen uitleg na Stop (${(await lp.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 300)}; verborgen: ${await lp.evaluate(() => document.hidden)})`));
  await until(() => lastBar() === null, 3000, 'de balk verdwijnt');
  await checks(page, 'telefoon-gestopt');
  await page.getByRole('button', { name: 'Terug', exact: true }).tap();
  await page
    .getByText('Staat uit', { exact: true })
    .waitFor({ timeout: 6000 })
    .catch(async (e) => {
      console.error(page.url(), (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 400));
      throw e;
    });
  if (!(await page.getByText('Aanzetten kan alleen op de computer zelf', { exact: false }).count())) fail('telefoon: zegt niet waar je het weer aanzet');
  expected = [];
  await checks(page, 'telefoon-uit');
  step('Stop op de computer: beide sessies weg, de balk verdwijnt, de telefoon zegt rustig waarom en dat aanzetten alleen op de computer kan');

  // ================================================================ 8. the security log
  const kinds = app.ctx.store.all("SELECT kind FROM audit WHERE kind LIKE 'remote_desktop.%' ORDER BY id").map((x) => x.kind);
  const count = (k) => kinds.filter((x) => x === k).length;
  if (count('remote_desktop.on') !== 1 || count('remote_desktop.start') < 2 || count('remote_desktop.end') !== count('remote_desktop.start') || count('remote_desktop.off') !== 1) fail(`logboek: ${kinds.join(', ')}`);
  if (inputs().some((c) => c.input.policy?.owner !== true && c.action !== 'move')) fail('invoer zonder eigenaarsbeleid');
  step(`logboek: ${count('remote_desktop.start')} sessies met begin en einde, aan en uit; ${inputs().length} acties alleen naar de proef-schermhulp`);
  detach();
  await pc.close();
  await phone.close();
  await laptop.close();
} catch (e) {
  fail(e.stack || e.message);
} finally {
  await browser.close();
  await app.close();
  for (const d of [dir, home]) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* left in the temp folder */
    }
  }
}
if (errors.length) fail('console-fouten:\n  ' + errors.join('\n  '));
console.log(failures.length ? `BUREAUBLAD OP AFSTAND MISLUKT: ${failures.length} bevinding(en)` : 'BUREAUBLAD OP AFSTAND GESLAAGD');
