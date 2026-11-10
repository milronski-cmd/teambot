// End-to-end, PARITEIT 15.1 for the web (0.4.4): a browser or phone-app notification for an approval or a question goes
// away once it is handled elsewhere. Real server (desktop mode, temp data), real UI build and the real service worker
// (ui/public/sw.js) in Edge headless; the pushes are the server's own payloads (captured at its push transport and
// decrypted), handed to the service worker through CDP (ServiceWorker.deliverPushMessage) as the push service would.
//  1. paired Android phone, app closed: an approval push shows a notification; the owner approves it on the computer
//     (Wacht op jou) → the server's close push takes it away and shows nothing.
//  2. computer browser tab: an approval notification is showing; the question is answered on the phone → the page
//     hears it and closes it.
//  3. as on an iPhone (no close push): the phone app is opened again → notifications of approvals that no longer wait
//     are closed, one that still waits stays.
// Usage: npm run build:ui && node --import tsx tests/e2e/web-notes.mjs   (TEAMBOT_E2E_BROWSER=chrome|msedge)
import crypto from 'node:crypto';
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if (await fn()) return true;
    } catch {
      /* not yet */
    }
    if (Date.now() > end) return fail(`time-out: ${what}`), false;
    await sleep(100);
  }
};

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-web-notes-home-'));
Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') });
delete process.env.TEAMBOT_DATA;

const { createApp } = await import('../../server/app.ts');
const { b64u, decryptPayload } = await import('../../server/modules/mobile/webpush.ts');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-web-notes-'));
const app = await createApp({ dataDir: dir, port: Number(process.env.TEAMBOT_E2E_PORT) || 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const pcToken = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();
const errors = [];

try {
  const call = async (token, method, p, body, headers = {}) => {
    const r = await fetch(app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const bot = await call(pcToken, 'POST', '/agents', { name: 'Ada' });
  const agent = app.ctx.store.agent(bot.body.id || bot.body.agent?.id);
  if (!agent) throw new Error(`bot maken mislukt: ${JSON.stringify(bot.body)}`);
  const ask = (kind, summary) =>
    app.ctx.broker.request({ userId: owner.id, agent, thread: null, run: null, kind, tool: kind === 'question' ? 'ask_user' : 'write_file', input: kind === 'question' ? { question: summary } : { path: 'a.txt' }, summary, risk: 'write' });
  const pendingIds = () => app.ctx.store.all("SELECT id FROM approvals WHERE user_id = ? AND status = 'pending' ORDER BY created_at", owner.id).map((r) => r.id);

  // ---- the paired Android phone (the real QR claim), its push subscription with keys this test holds
  const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36';
  const ticket = await call(pcToken, 'POST', '/mobile/pair', { baseUrl: app.url });
  const secret = new URLSearchParams(new URL(ticket.body.url).hash.slice(1)).get('t');
  const claim = await fetch(`${app.url}/api/public/mobile/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': ANDROID_UA }, body: JSON.stringify({ secret, name: 'Pixel van Sanne' }) });
  const phoneToken = (await claim.json()).token;
  if (!phoneToken) throw new Error('koppelen mislukt');
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const keys = { p256dh: b64u.enc(ecdh.getPublicKey()), auth: b64u.enc(crypto.randomBytes(16)) };
  const sub = await call(phoneToken, 'POST', '/mobile/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/pixel-e2e', keys } });
  if (sub.status !== 200) throw new Error(`push-abonnement: ${sub.status}`);
  const pushes = [];
  app.ctx.services.mobile.instance.push.transport = async (_url, init) => {
    pushes.push(decryptPayload(init.body, ecdh.getPrivateKey(), keys.p256dh, keys.auth).toString());
    return { status: 201 };
  };
  step('Android-telefoon gekoppeld met een pushabonnement; de pushberichten van de server worden opgevangen');

  const phoneCtx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, userAgent: ANDROID_UA, locale: 'nl-NL' });
  await phoneCtx.grantPermissions(['notifications'], { origin: app.url });
  await phoneCtx.addInitScript((t) => {
    try {
      localStorage.setItem('tb_token', t);
    } catch {}
  }, phoneToken);
  const phone = await phoneCtx.newPage();
  phone.on('pageerror', (e) => errors.push(`telefoon: ${e.message}`));
  await phone.goto(app.url + '/');
  await phone.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  const shown = (page) => page.evaluate(() => navigator.serviceWorker.ready.then((r) => r.getNotifications()).then((l) => l.map((n) => n.tag)));
  // The push service's side: CDP hands a payload to the phone's service worker.
  const cdp = await phoneCtx.newCDPSession(phone);
  let regId = '';
  cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => {
    for (const r of e.registrations) if (!r.isDeleted && r.scopeURL.startsWith(app.url)) regId = r.registrationId;
  });
  await cdp.send('ServiceWorker.enable');
  await until(() => regId, 5000, 'geen service worker op de telefoon');
  const deliver = (data) => cdp.send('ServiceWorker.deliverPushMessage', { origin: app.url, registrationId: regId, data });

  // ================================================================ 1. phone app closed, approved on the computer
  // The app is closed: the tab shows a plain file of the same site (no app, no live connection, the worker stays).
  await phone.goto(app.url + '/manifest.webmanifest').catch(() => phone.goto(app.url + '/icon-192.png'));
  const decided = ask('tool', 'a.txt schrijven');
  await until(() => pushes.length === 1, 5000, 'geen push voor de goedkeuring');
  const apr = pendingIds()[0];
  const first = JSON.parse(pushes[0]);
  if (first.kind !== 'approval' || first.tag !== `apr-${apr}`) fail(`push: ${pushes[0]}`);
  await deliver(pushes[0]);
  await until(async () => (await shown(phone)).includes(`apr-${apr}`), 5000, 'de telefoon toont de goedkeuring niet');

  const pcCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'nl-NL' });
  await pcCtx.grantPermissions(['notifications'], { origin: app.url });
  const pc = await pcCtx.newPage();
  pc.on('pageerror', (e) => errors.push(`computer: ${e.message}`));
  await pc.goto(`${app.url}/#token=${pcToken}`);
  await pc.evaluate(() => (location.hash = '#/inbox'));
  const card = pc.getByRole('group', { name: 'Goedkeuring nodig' });
  await card.first().waitFor({ timeout: 15000 });
  await card.first().getByRole('button', { name: 'Eén keer toestaan' }).click();
  await decided;
  await until(() => pushes.length === 2, 5000, 'geen sluit-push na goedkeuren op de computer');
  const close = JSON.parse(pushes[1] || '{}');
  if (close.kind !== 'close' || close.tag !== `apr-${apr}`) fail(`sluit-push: ${pushes[1]}`);
  await deliver(pushes[1]);
  await until(async () => (await shown(phone)).length === 0, 5000, 'de melding op de telefoon blijft staan');
  step('telefoon, app dicht: goedkeuring op de computer gegeven → de melding op de telefoon verdwijnt, er komt niets nieuws');

  // ================================================================ 2. computer tab, answered on the phone
  await pc.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  const answered = ask('question', 'Welke map?');
  await until(() => pendingIds().length === 1, 5000, 'geen vraag');
  const q = pendingIds()[0];
  // What this browser shows for the question (a push, or the page's own notification while the tab is in the background).
  await pc.evaluate((tag) => navigator.serviceWorker.ready.then((r) => r.showNotification('Ada heeft een vraag', { body: 'Welke map?', tag })), `apr-${q}`);
  await until(async () => (await shown(pc)).includes(`apr-${q}`), 5000, 'de computer toont de vraag niet');
  const r = await call(phoneToken, 'POST', `/approvals/${q}`, { decision: 'approve', answer: 'Facturen' });
  if (r.status !== 200) fail(`antwoord vanaf de telefoon: ${r.status}`);
  await answered;
  await until(async () => !(await shown(pc)).includes(`apr-${q}`), 5000, 'de melding op de computer blijft staan na antwoorden op de telefoon');
  step('computer: vraag beantwoord op de telefoon → de melding in de browser verdwijnt');

  // ================================================================ 3. as on an iPhone: no close push, closed on opening
  pushes.length = 0;
  const later = ask('tool', 'b.txt schrijven');
  const waits = ask('tool', 'c.txt schrijven');
  await until(() => pushes.length === 2 && pendingIds().length === 2, 5000, 'geen pushes voor twee goedkeuringen');
  const [done, still] = pendingIds();
  for (const p of pushes) await deliver(p);
  await until(async () => (await shown(phone)).length === 2, 5000, 'de telefoon toont de twee goedkeuringen niet');
  await call(pcToken, 'POST', `/approvals/${done}`, { decision: 'deny' });
  await later;
  // The close push is not delivered (Apple sends none); the owner opens the app.
  await phone.goto(app.url + '/');
  await until(async () => {
    const tags = await shown(phone);
    return !tags.includes(`apr-${done}`) && tags.includes(`apr-${still}`);
  }, 8000, 'bij openen: de afgehandelde melding blijft staan, of de wachtende verdwijnt');
  step('telefoon zonder sluit-push (zoals iPhone): app openen → de afgehandelde melding verdwijnt, de wachtende blijft');
  await call(pcToken, 'POST', `/approvals/${still}`, { decision: 'deny' });
  await waits;
  await until(async () => (await shown(phone)).length === 0, 5000, 'de laatste melding verdwijnt niet terwijl de app open is');

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
console.log(process.exitCode ? 'MISLUKT' : 'OK: meldingen verdwijnen als het elders is afgehandeld');
