import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http2 from 'node:http2';
import { WebSocket } from 'ws';
import { startTestApp, type TestApp } from './helpers.js';
import { b64u, decryptPayload, encryptPayload, generateVapidKeys, vapidAuthorization, assertPushEndpoint } from '../server/modules/mobile/webpush.js';
import type { Mobile } from '../server/modules/mobile/index.js';
import { uniqueDeviceName } from '../server/modules/mobile/pairing.js';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const mobileOf = (t: TestApp): Mobile => t.app.ctx.services.mobile.instance;

async function call(base: string, token: string | null, method: string, p: string, body?: any, headers: Record<string, string> = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, body: json, text };
}

async function newTicket(t: TestApp) {
  return t.api('POST', '/mobile/pair', { baseUrl: 'http://192.168.1.5:4748' });
}
const secretOf = (ticket: any) => new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('t')!;

async function pair(t: TestApp, name = 'Test-iPhone') {
  const ticket = await newTicket(t);
  const r = await call(t.app.url, null, 'POST', '/api/public/mobile/claim', { secret: secretOf(ticket), name }, { 'user-agent': IPHONE_UA });
  assert.equal(r.status, 200, r.text);
  return { ticket, token: r.body.token as string, deviceId: r.body.device.id as string };
}

function subscriber() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { priv: ecdh.getPrivateKey(), p256dh: b64u.enc(ecdh.getPublicKey()), auth: b64u.enc(crypto.randomBytes(16)) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await sleep(15);
  }
}

// ---------------------------------------------------------------- crypto

test('web push encryption matches RFC 8291 example and round-trips', () => {
  const out = encryptPayload(Buffer.from('When I grow up, I want to be a watermelon'), 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg', {
    salt: b64u.dec('DGv6ra1nlYgDCS1FRnbzlw'),
    asPrivate: b64u.dec('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
  });
  assert.equal(
    b64u.enc(out),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  );
  const s = subscriber();
  const msg = encryptPayload(Buffer.from('{"title":"Hoi"}'), s.p256dh, s.auth);
  assert.equal(decryptPayload(msg, s.priv, s.p256dh, s.auth).toString(), '{"title":"Hoi"}');
});

test('VAPID header is a valid ES256 JWT for the push origin; unknown push hosts are refused', () => {
  const keys = generateVapidKeys();
  const h = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 'mailto:a@b.nl');
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(h)!;
  assert.ok(m);
  assert.equal(m[2], keys.publicKey);
  const [hd, cl, sig] = m[1].split('.');
  const claims = JSON.parse(b64u.dec(cl).toString());
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, 'mailto:a@b.nl');
  const pub = b64u.dec(keys.publicKey);
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u.enc(pub.subarray(1, 33)), y: b64u.enc(pub.subarray(33)) }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${hd}.${cl}`), { key, dsaEncoding: 'ieee-p1363' }, b64u.dec(sig)));
  assert.ok(!h.includes(keys.privateKey));
  for (const bad of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://evil.example/x', 'https://fcm.googleapis.com.evil.example/x', 'https://u:p@web.push.apple.com/x']) assert.throws(() => assertPushEndpoint(bad), bad);
  assert.ok(assertPushEndpoint('https://web.push.apple.com/QGx'));
});

// ---------------------------------------------------------------- pairing

test('QR pairing ticket is single-use, expires, and a new ticket invalidates the old one', async () => {
  const t = await startTestApp();
  try {
    const ticket = await newTicket(t);
    assert.match(ticket.url, /^http:\/\/192\.168\.1\.5:4748\/api\/public\/mobile\/pair#t=[A-Za-z0-9_-]{43}$/);
    assert.match(ticket.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.match(ticket.qr, /^data:image\/svg\+xml;base64,/);
    assert.ok(Date.parse(ticket.expires_at) - Date.now() <= 300_000 && Date.parse(ticket.expires_at) - Date.now() > 290_000);
    // the pairing page never contains the secret (it lives in the URL fragment only)
    const page = await call(t.app.url, null, 'GET', '/api/public/mobile/pair');
    assert.equal(page.status, 200);
    assert.ok(!page.text.includes(secretOf(ticket)));
    const res = await fetch(t.app.url + '/api/public/mobile/pair');
    assert.match(res.headers.get('content-security-policy') || '', /script-src 'nonce-/);
    assert.equal(res.headers.get('cache-control'), 'no-store');

    const first = await call(t.app.url, null, 'POST', '/api/public/mobile/claim', { secret: secretOf(ticket), name: 'Telefoon A' }, { 'user-agent': IPHONE_UA });
    assert.equal(first.status, 200);
    assert.ok(first.body.token);
    const second = await call(t.app.url, null, 'POST', '/api/public/mobile/claim', { secret: secretOf(ticket), name: 'Telefoon B' });
    assert.equal(second.status, 400);
    const byCode = await call(t.app.url, null, 'POST', '/api/public/mobile/claim', { code: ticket.code });
    assert.equal(byCode.status, 400);
    assert.equal((await t.api('GET', `/mobile/pair/${ticket.id}`)).status, 'used');

    // expired
    const t2 = await newTicket(t);
    t.app.ctx.store.exec('UPDATE mobile_pair_tickets SET expires_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), t2.id);
    assert.equal((await call(t.app.url, null, 'POST', '/api/public/mobile/claim', { secret: secretOf(t2) })).status, 400);
    assert.equal((await t.api('GET', `/mobile/pair/${t2.id}`)).status, 'expired');

    // new ticket cancels the previous (also its code in the core table)
    const t3 = await newTicket(t);
    const t4 = await newTicket(t);
    assert.equal((await call(t.app.url, null, 'POST', '/api/public/mobile/claim', { secret: secretOf(t3) })).status, 400);
    assert.equal((await call(t.app.url, null, 'POST', '/api/public/pair', { code: t3.code })).status, 400);
    assert.equal((await call(t.app.url, null, 'POST', '/api/public/mobile/claim', { code: t4.code.toLowerCase(), name: 'Met code' })).status, 200);

    const devices = await t.api('GET', '/mobile/devices');
    assert.equal(devices.length, 2);
    const a = devices.find((d: any) => d.name === 'Telefoon A');
    assert.equal(a.platform, 'ios');
    assert.equal(a.status, 'active');
  } finally {
    await t.close();
  }
});

test('the short code also works in the shell login tab (core /api/public/pair) and still pairs only one device', async () => {
  const t = await startTestApp();
  try {
    const ticket = await newTicket(t);
    const android = { 'user-agent': 'Mozilla/5.0 (Linux; Android 15; Pixel 9)' };
    const r = await call(t.app.url, null, 'POST', '/api/public/pair', { code: ticket.code, deviceName: 'Pixel' }, android);
    assert.equal(r.status, 200, r.text);
    // QR secret of the same ticket is now dead
    assert.equal((await call(t.app.url, null, 'POST', '/api/public/mobile/claim', { secret: secretOf(ticket) })).status, 400);
    // the core-paired device is restricted too and gets its metadata on first use
    assert.equal((await call(t.app.url, r.body.token, 'GET', '/api/secrets', undefined, android)).status, 403);
    assert.equal((await call(t.app.url, r.body.token, 'GET', '/api/threads')).status, 200);
    const dev = (await t.api('GET', '/mobile/devices')).find((d: any) => d.name === 'Pixel');
    assert.equal(dev.platform, 'android');
    assert.equal((await t.api('GET', `/mobile/pair/${ticket.id}`)).status, 'used');
  } finally {
    await t.close();
  }
});

test('pairing attempts are rate limited per address', async () => {
  const t = await startTestApp();
  try {
    const ticket = await newTicket(t);
    for (let i = 0; i < 5; i++) assert.equal((await call(t.app.url, null, 'POST', '/api/public/mobile/claim', { secret: crypto.randomBytes(32).toString('base64url') })).status, 400);
    const blocked = await call(t.app.url, null, 'POST', '/api/public/mobile/claim', { secret: secretOf(ticket) });
    assert.equal(blocked.status, 429);
    // the ticket was not consumed by the blocked attempt
    assert.equal((await t.api('GET', `/mobile/pair/${ticket.id}`)).status, 'waiting');
    // too many tickets per user
    let last = 200;
    for (let i = 0; i < 16 && last === 200; i++) last = (await call(t.app.url, t.token, 'POST', '/api/mobile/pair', { baseUrl: 'http://10.0.0.2:4748' })).status;
    assert.equal(last, 429);
    // bad base urls are refused
    for (const baseUrl of ['javascript:alert(1)', 'http://a:b@x.nl', 'http://x.nl/pad', 'ftp://x.nl']) assert.equal((await call(t.app.url, t.token, 'POST', '/api/mobile/pair', { baseUrl })).status, 400, baseUrl);
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------- default-deny device access

test('device token may chat but gets 403 on secrets, providers, admin, export and pairing', async () => {
  const t = await startTestApp();
  try {
    const agent = await t.agent();
    const th = await t.api('POST', '/threads', { agentId: agent.id });
    await t.api('PUT', '/secrets/github', { value: 'ghp_' + 'x'.repeat(36) });
    await t.api('PATCH', `/providers/${t.providerId}`, { config: { headers: { 'x-api-key': 'supersecretheader' } } }).catch(() => undefined);
    const { token } = await pair(t);
    const D = (m: string, p: string, b?: any) => call(t.app.url, token, m, '/api' + p, b);

    // allowed: chat
    assert.equal((await D('GET', '/me')).status, 200);
    assert.equal((await D('GET', '/threads')).status, 200);
    assert.equal((await D('GET', `/threads/${th.id}`)).status, 200);
    t.script.push({ text: 'Hallo telefoon' });
    assert.equal((await D('POST', `/threads/${th.id}/messages`, { content: 'hoi vanaf de telefoon' })).status, 200);
    await t.waitIdle(th.id);
    assert.equal((await D('POST', `/threads/${th.id}/stop`, {})).status, 200);
    assert.equal((await D('GET', '/approvals')).status, 200);
    assert.equal((await D('GET', '/runs')).status, 200);
    assert.equal((await D('GET', '/search?q=telefoon')).status, 200);
    assert.equal((await D('GET', '/agents')).status, 200);
    assert.equal((await D('GET', '/settings')).status, 200);
    assert.equal((await D('PUT', '/settings', { theme: 'dark' })).status, 200);
    assert.equal((await D('GET', '/mobile/devices/self')).body.device.name, 'Test-iPhone');

    // providers: reduced view without base url / config / key state
    const prov = await D('GET', '/providers');
    assert.equal(prov.status, 200);
    assert.ok(!prov.text.includes('supersecretheader'));
    assert.deepEqual(prov.body[0].config, {});

    // Since 0.4.1 the owner's phone can do what the computer can (make bots, connect AI, settings, …).
    for (const [m, p, b] of [
      ['GET', '/provider-kinds?detect=1'],
      ['POST', '/agents', { name: 'Telefoonbot' }],
      ['PATCH', `/agents/${agent.id}`, { name: 'Andere naam' }],
      ['PUT', '/settings', { dailyBudgetUsd: 25 }],
      ['GET', '/audit'],
      ['GET', '/rooms/defaults'],
      ['GET', '/agents/templates'],
    ] as [string, string, any?][]) {
      const r = await D(m, p, b);
      assert.notEqual(r.status, 403, `${m} ${p} is allowed on the phone → ${r.status} ${r.text?.slice(0, 120)}`);
    }
    // Still computer-only: handing out access, revealing secrets, full export, reachability, account credentials.
    for (const [m, p, b] of [
      ['GET', '/secrets'],
      ['PUT', '/secrets/x', { value: 'y' }],
      ['DELETE', '/secrets/github'],
      ['GET', '/SECRETS'],
      ['GET', '/Admin/Users'],
      ['GET', '/admin/users'],
      ['GET', '/admin/settings'],
      ['POST', '/admin/invites', {}],
      ['GET', '/export'],
      ['GET', '/sessions'],
      ['POST', '/pairing'],
      ['POST', '/mobile/pair', { baseUrl: 'http://1.2.3.4' }],
      ['GET', '/mobile/devices'],
      ['PUT', '/mobile/gateway', { enabled: true }],
      ['PATCH', '/me', { password: 'nieuwwachtwoord' }],
      // handing a stored secret to a bot's scripts (module script-keys)
      ['GET', '/script-keys'],
      ['POST', '/script-keys', { name: 'SHOPIFY_TOKEN', value: 'x'.repeat(20) }],
      ['DELETE', '/script-keys/sk_x/grants/agent/a_x'],
      // own rules (module botrules): a rule that lets a bot do more, or removing a rule, makes it looser
      ['POST', '/bot-rules/loosen', { agentId: agent.id, text: 'Mag altijd bestanden maken in de map Offertes' }],
      ['DELETE', '/bot-rules/loosen/rule_x'],
    ] as [string, string, any?][]) {
      const r = await D(m, p, b);
      assert.equal(r.status, 403, `${m} ${p} → ${r.status}`);
    }
    // "always allow" is not possible from a phone; approve once is
    const apr = { id: 'apr_test', user_id: t.app.ctx.auth.owner()!.id, kind: 'tool', tool: 'write_file', input: {}, summary: 'x', risk: 'write', status: 'pending', created_at: new Date().toISOString() };
    t.app.ctx.store.insert('approvals', apr);
    assert.equal((await D('POST', '/approvals/apr_test', { decision: 'always' })).status, 403);
    assert.equal((await D('POST', '/approvals/apr_test', { decision: 'approve' })).status, 200);

    // a new module route works on the phone without opting in (only the computer-only list is closed)
    t.app.ctx.api.get('/demo-mobile', (_req, res) => res.json({ ok: true }));
    assert.equal((await D('GET', '/demo-mobile')).status, 200);
    t.app.ctx.services.mobile.allowRoute('GET', '/demo-mobile');
    assert.equal((await D('GET', '/demo-mobile')).status, 200);
    // the desktop session is unaffected
    assert.equal((await call(t.app.url, t.token, 'GET', '/api/secrets')).status, 200);
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------- revoke

test('revoking a device blocks REST and closes its WebSocket immediately', async () => {
  const t = await startTestApp();
  try {
    const { token, deviceId } = await pair(t);
    const other = await pair(t, 'Tweede telefoon');
    const wsUrl = (tok: string) => t.app.url.replace(/^http/, 'ws') + t.signed('/ws', tok);
    const ws = new WebSocket(wsUrl(token));
    const ws2 = new WebSocket(wsUrl(other.token));
    const hello = (w: WebSocket) => new Promise<void>((resolve, reject) => {
      w.once('message', () => resolve());
      w.once('error', reject);
    });
    await Promise.all([hello(ws), hello(ws2)]);
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    const started = Date.now();
    await t.api('POST', `/mobile/devices/${deviceId}/revoke`, {});
    assert.equal(await closed, 4401);
    assert.ok(Date.now() - started < 1500);
    assert.equal((await call(t.app.url, token, 'GET', '/api/me')).status, 401);
    // cannot reconnect
    const again = new WebSocket(wsUrl(token));
    const res = await new Promise<string>((resolve) => {
      again.once('open', () => resolve('open'));
      again.once('error', () => resolve('rejected'));
      again.once('unexpected-response', (_req, r) => resolve('http ' + r.statusCode));
    });
    assert.notEqual(res, 'open');
    // the other device keeps working
    assert.equal(ws2.readyState, WebSocket.OPEN);
    assert.equal((await call(t.app.url, other.token, 'GET', '/api/me')).status, 200);
    ws2.close();
    const list = await t.api('GET', '/mobile/devices');
    assert.equal(list.find((d: any) => d.id === deviceId).status, 'revoked');
    // revoking via the core sessions list closes sockets too
    const ws3 = new WebSocket(wsUrl(other.token));
    await hello(ws3);
    const closed3 = new Promise<number>((resolve) => ws3.once('close', (code) => resolve(code)));
    await t.api('DELETE', `/sessions/${other.deviceId}`);
    assert.equal(await closed3, 4401);
    // a phone can unpair itself
    const third = await pair(t, 'Derde');
    assert.equal((await call(t.app.url, third.token, 'DELETE', '/api/mobile/devices/self')).status, 200);
    assert.equal((await call(t.app.url, third.token, 'GET', '/api/me')).status, 401);
  } finally {
    await t.close();
  }
});

test('device names: unique helper adds a number for a name that is already taken', () => {
  assert.equal(uniqueDeviceName('Telefoon', []), 'Telefoon');
  assert.equal(uniqueDeviceName('Telefoon', ['telefoon']), 'Telefoon 2');
  assert.equal(uniqueDeviceName('Telefoon', ['Telefoon', 'Telefoon 2']), 'Telefoon 3');
  assert.equal(uniqueDeviceName('iPhone 2', ['iPhone', 'iPhone 2']), 'iPhone 3');
  assert.equal(uniqueDeviceName('  ', ['Telefoon']), 'Telefoon 2');
});

test('every paired phone gets its own name, also next to a revoked one, and revoking renames nothing', async () => {
  const t = await startTestApp();
  try {
    const desktopUa = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
    const claim = async (name?: string, headers: Record<string, string> = desktopUa) => {
      const ticket = await newTicket(t);
      const r = await call(t.app.url, null, 'POST', '/api/public/mobile/claim', { secret: secretOf(ticket), ...(name !== undefined ? { name } : {}) }, headers);
      assert.equal(r.status, 200, r.text);
      return r.body.device as { id: string; name: string };
    };
    const a = await claim('Telefoon');
    const b = await claim('Telefoon');
    assert.equal(a.name, 'Telefoon');
    assert.equal(b.name, 'Telefoon 2');
    await t.api('POST', `/mobile/devices/${a.id}/revoke`, {});
    const c = await claim(); // no name typed: the default for this platform, numbered when taken
    assert.equal(c.name, 'Telefoon 3');
    const iphone = await claim(undefined, { 'user-agent': IPHONE_UA });
    assert.equal(iphone.name, 'iPhone');
    const names = Object.fromEntries((await t.api('GET', '/mobile/devices')).map((d: any) => [d.id, d.name]));
    assert.deepEqual([names[a.id], names[b.id], names[c.id], names[iphone.id]], ['Telefoon', 'Telefoon 2', 'Telefoon 3', 'iPhone']);
    // a phone paired with the short code in the login tab gets a free name too
    const ticket = await newTicket(t);
    const r = await call(t.app.url, null, 'POST', '/api/public/pair', { code: ticket.code }, desktopUa);
    assert.equal(r.status, 200, r.text);
    assert.equal((await call(t.app.url, r.body.token, 'GET', '/api/threads', undefined, desktopUa)).status, 200);
    const all = (await t.api('GET', '/mobile/devices')).map((d: any) => d.name);
    assert.equal(new Set(all).size, all.length, all.join(', '));
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------- push

test('push subscriptions are per user; events reach only the owner; private VAPID key never leaves the server', async () => {
  const t = await startTestApp();
  try {
    const m = mobileOf(t);
    m.tailscaleProbe = async (ips) => ({ installed: false, running: false, ips, dnsName: null, detail: 'test' });
    const sent: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
    m.push.transport = async (url, init) => {
      sent.push({ url, headers: init.headers, body: init.body });
      return { status: 201 };
    };
    const ownerId = t.app.ctx.auth.owner()!.id;
    const b = t.app.ctx.auth.createUser({ name: 'Vriend', email: 'vriend@example.com', password: 'wachtwoord1' });
    const tokB = t.app.ctx.auth.createSession(b.id, 'web', 'Browser van B').token;
    const A = subscriber();
    const B = subscriber();
    const epA = 'https://fcm.googleapis.com/fcm/send/owner-endpoint';
    const epB = 'https://web.push.apple.com/vriend-endpoint';

    const { token: phoneA } = await pair(t);
    assert.equal((await call(t.app.url, phoneA, 'POST', '/api/mobile/push/subscribe', { subscription: { endpoint: epA, keys: { p256dh: A.p256dh, auth: A.auth } } })).status, 200);
    assert.equal((await call(t.app.url, tokB, 'POST', '/api/mobile/push/subscribe', { subscription: { endpoint: epB, keys: { p256dh: B.p256dh, auth: B.auth } } })).status, 200);
    // SSRF guard on endpoints
    assert.equal((await call(t.app.url, tokB, 'POST', '/api/mobile/push/subscribe', { subscription: { endpoint: 'https://127.0.0.1:4747/api/secrets', keys: { p256dh: B.p256dh, auth: B.auth } } })).status, 400);

    const listB = await call(t.app.url, tokB, 'GET', '/api/mobile/push');
    assert.equal(listB.body.subscriptions.length, 1);
    assert.equal(listB.body.subscriptions[0].label, 'Browser van B');
    assert.ok(!listB.text.includes('owner-endpoint') && !listB.text.includes('vriend-endpoint'));
    // B cannot remove A's subscription
    await call(t.app.url, tokB, 'POST', '/api/mobile/push/unsubscribe', { endpoint: epA });
    assert.equal((await t.api('GET', '/mobile/push')).subscriptions.length, 1);

    // notification for A (A offline) → only A's endpoint, decryptable by A only
    t.app.ctx.events.emit(ownerId, 'notification', { title: 'Klaar', body: 'Rapport staat klaar', link: '#/t/abc', kind: 'agent' });
    await until(() => sent.length === 1);
    assert.equal(sent[0].url, epA);
    const payload = JSON.parse(decryptPayload(sent[0].body, A.priv, A.p256dh, A.auth).toString());
    assert.equal(payload.title, 'Klaar');
    assert.equal(payload.link, '#/t/abc');
    assert.throws(() => decryptPayload(sent[0].body, B.priv, B.p256dh, B.auth));
    assert.equal(sent[0].headers['content-encoding'], 'aes128gcm');

    // unsafe links are neutralised
    t.app.ctx.events.emit(ownerId, 'notification', { title: 'x', body: 'y', link: 'https://evil.example', kind: 'agent' });
    await until(() => sent.length === 2);
    assert.equal(JSON.parse(decryptPayload(sent[1].body, A.priv, A.p256dh, A.auth).toString()).link, '#/');

    // owner online: agent notifications are skipped, approvals still pushed (and never auto-approve)
    const ws = new WebSocket(t.app.url.replace(/^http/, 'ws') + t.signed('/ws'));
    await new Promise((r) => ws.once('message', r));
    t.app.ctx.events.emit(ownerId, 'notification', { title: 'skip', body: 'skip', link: '#/', kind: 'agent' });
    t.app.ctx.events.emit(ownerId, 'notification', { title: 'Bot vraagt toestemming', body: 'Bestand schrijven', link: '#/t/abc', kind: 'approval', approvalId: 'apr_1' });
    await until(() => sent.length === 3);
    await sleep(50);
    assert.equal(sent.length, 3);
    assert.equal(sent[2].headers.urgency, 'high');
    assert.equal(JSON.parse(decryptPayload(sent[2].body, A.priv, A.p256dh, A.auth).toString()).kind, 'approval');
    ws.close();
    await sleep(50);

    // run finished while offline → push with the agent name
    const agent = await t.agent({ name: 'Onderzoeker' });
    const th = await t.api('POST', '/threads', { agentId: agent.id });
    t.script.push({ text: 'Samenvatting klaar' });
    await t.say(th.id, 'vat samen');
    await until(() => sent.some((s) => JSON.parse(decryptPayload(s.body, A.priv, A.p256dh, A.auth).toString()).kind === 'run'));
    const run = sent.map((s) => JSON.parse(decryptPayload(s.body, A.priv, A.p256dh, A.auth).toString())).find((p) => p.kind === 'run');
    assert.equal(run.title, 'Onderzoeker is klaar');
    assert.equal(run.body, 'Samenvatting klaar');

    // preview off → no content on the lock screen
    await t.api('PUT', '/mobile/push/prefs', { preview: false });
    const before = sent.length;
    t.app.ctx.events.emit(ownerId, 'notification', { title: 'Geheim', body: 'Inhoud', link: '#/', kind: 'agent' });
    await until(() => sent.length === before + 1);
    const hidden = JSON.parse(decryptPayload(sent[before].body, A.priv, A.p256dh, A.auth).toString());
    assert.equal(hidden.title, 'TeamBot');
    assert.ok(!JSON.stringify(hidden).includes('Geheim'));

    // test push + gone subscription is cleaned up
    m.push.transport = async () => ({ status: 410 });
    const tst = await t.api('POST', '/mobile/push/test', {});
    assert.equal(tst.failed, 1);
    assert.equal((await t.api('GET', '/mobile/push')).subscriptions.length, 0);

    // the private VAPID key is in the encrypted secrets store and in no API answer
    const vapid = JSON.parse(t.app.ctx.secrets.getByName('', 'mobile:vapid')!);
    assert.ok(vapid.privateKey.length > 30);
    const enc = t.app.ctx.store.one<any>("SELECT value_enc FROM secrets WHERE user_id = '' AND name = 'mobile:vapid'");
    assert.ok(!enc.value_enc.includes(vapid.privateKey));
    const bodies = [];
    for (const p of ['/mobile/push', '/mobile/reachability', '/mobile/devices', '/secrets', '/settings', '/admin/settings', '/export', '/audit', '/system']) {
      const r = await call(t.app.url, t.token, 'GET', '/api' + p);
      assert.equal(r.status, 200, p);
      bodies.push(r.text);
    }
    bodies.push((await call(t.app.url, phoneA, 'GET', '/api/mobile/push')).text, (await call(t.app.url, tokB, 'GET', '/api/mobile/push')).text);
    for (const txt of bodies) assert.ok(!txt.includes(vapid.privateKey));
    assert.equal(JSON.parse(bodies[0]).publicKey, vapid.publicKey);
    // revoking a device removes its push subscription
    const phone2 = await pair(t, 'Nog een');
    await call(t.app.url, phone2.token, 'POST', '/api/mobile/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/p2', keys: { p256dh: A.p256dh, auth: A.auth } } });
    assert.equal(t.app.ctx.store.all('SELECT id FROM mobile_push_subs WHERE session_id = ?', phone2.deviceId).length, 1);
    await t.api('POST', `/mobile/devices/${phone2.deviceId}/revoke`, {});
    assert.equal(t.app.ctx.store.all('SELECT id FROM mobile_push_subs WHERE session_id = ?', phone2.deviceId).length, 0);
  } finally {
    await t.close();
  }
});

test('APNs sender (native iOS app) signs a token JWT and targets only the device owner', async () => {
  const t = await startTestApp();
  const got: { path: string; headers: http2.IncomingHttpHeaders; body: string }[] = [];
  const h2 = http2.createServer();
  h2.on('stream', (stream: http2.ServerHttp2Stream, headers) => {
    let body = '';
    stream.on('data', (c) => (body += c));
    stream.on('end', () => {
      got.push({ path: String(headers[':path']), headers, body });
      stream.respond({ ':status': 200 });
      stream.end();
    });
  });
  await new Promise<void>((r) => h2.listen(0, '127.0.0.1', () => r()));
  try {
    const port = (h2.address() as any).port;
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const m = mobileOf(t);
    m.apns.configure({ keyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string, keyId: 'KEY123', teamId: 'TEAM42', topic: 'app.teambot.companion', host: `http://127.0.0.1:${port}` });
    const { token } = await pair(t);
    const apnsToken = 'ab'.repeat(32);
    assert.equal((await call(t.app.url, token, 'POST', '/api/mobile/devices/self/apns', { token: apnsToken, environment: 'sandbox' })).status, 200);
    assert.equal((await call(t.app.url, token, 'POST', '/api/mobile/devices/self/apns', { token: 'not-hex' })).status, 400);
    assert.equal((await call(t.app.url, t.token, 'POST', '/api/mobile/devices/self/apns', { token: apnsToken })).status, 400);
    const stored = t.app.ctx.store.one<any>('SELECT apns_enc FROM mobile_devices');
    assert.ok(!stored.apns_enc.includes(apnsToken));

    t.app.ctx.events.emit(t.app.ctx.auth.owner()!.id, 'notification', { title: 'Vraag', body: 'Mag ik?', link: '#/inbox', kind: 'approval', approvalId: 'apr_9' });
    await until(() => got.length === 1);
    assert.equal(got[0].path, `/3/device/${apnsToken}`);
    assert.equal(got[0].headers['apns-topic'], 'app.teambot.companion');
    assert.equal(got[0].headers['apns-priority'], '10');
    const jwt = String(got[0].headers.authorization).replace(/^bearer /, '');
    const [hd, cl, sig] = jwt.split('.');
    assert.equal(JSON.parse(b64u.dec(hd).toString()).kid, 'KEY123');
    assert.equal(JSON.parse(b64u.dec(cl).toString()).iss, 'TEAM42');
    assert.ok(crypto.verify('sha256', Buffer.from(`${hd}.${cl}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, b64u.dec(sig)));
    const body = JSON.parse(got[0].body);
    assert.equal(body.aps.alert.title, 'Vraag');
    assert.equal(body.link, '#/inbox');
    // another user's event never reaches this device
    const b = t.app.ctx.auth.createUser({ name: 'B', email: 'b@example.com', password: 'wachtwoord1' });
    t.app.ctx.events.emit(b.id, 'notification', { title: 'x', body: 'y', link: '#/', kind: 'approval', approvalId: 'apr_x' });
    await sleep(100);
    assert.equal(got.length, 1);
  } finally {
    await new Promise<void>((r) => h2.close(() => r()));
    await t.close();
  }
});

// ---------------------------------------------------------------- gateway

test('phone gateway forwards only pairing routes, static shell and device tokens', async () => {
  const t = await startTestApp();
  try {
    const m = mobileOf(t);
    m.tailscaleProbe = async (ips) => ({ installed: false, running: false, ips, dnsName: null, detail: 'test' });
    assert.equal((await call(t.app.url, t.token, 'PUT', '/api/mobile/gateway', { enabled: true, bind: 'loopback', port: 0 })).status, 400); // needs acknowledge
    const reach = await t.api('PUT', '/mobile/gateway', { enabled: true, bind: 'loopback', port: 0, acknowledge: true });
    assert.equal(reach.gateway.running, true, JSON.stringify(reach.gateway));
    assert.equal(reach.tunnelTarget, `http://127.0.0.1:${reach.gateway.port}`);
    const gw = `http://127.0.0.1:${reach.gateway.port}`;
    const { token } = await pair(t);

    assert.equal((await call(gw, t.token, 'GET', '/api/me')).status, 403); // desktop owner token never works via the gateway
    assert.equal((await call(gw, t.token, 'GET', '/API/secrets')).status, 403);
    assert.equal((await call(gw, t.token, 'GET', '/api/public/../secrets')).status, 403);
    assert.equal((await call(gw, null, 'POST', '/api/public/setup', { password: 'x'.repeat(10) })).status, 403);
    assert.equal((await call(gw, null, 'POST', '/api/public/login', {})).status, 403);
    assert.equal((await call(gw, token, 'GET', '/api/me')).status, 200);
    assert.equal((await call(gw, token, 'GET', '/api/secrets')).status, 403); // device policy still applies
    assert.equal((await call(gw, null, 'GET', '/api/public/mobile/pair')).status, 200);
    assert.equal((await call(gw, null, 'GET', '/api/public/status')).status, 200);
    assert.equal((await call(gw, null, 'GET', '/')).status, 200);
    assert.equal((await call(gw, null, 'POST', '/')).status, 405);
    // pairing through the gateway works (a client-sent X-Forwarded-For is replaced by the real address)
    const ticket = await newTicket(t);
    const viaGw = await call(gw, null, 'POST', '/api/public/mobile/claim', { secret: secretOf(ticket), name: 'Via wifi' }, { 'x-forwarded-for': '6.6.6.6' });
    assert.equal(viaGw.status, 200);

    const ws = (tok: string) =>
      new Promise<string>((resolve) => {
        const w = new WebSocket(gw.replace('http', 'ws') + t.signed('/ws', tok));
        w.once('message', () => {
          w.close();
          resolve('hello');
        });
        w.once('error', () => resolve('rejected'));
        w.once('unexpected-response', (_q, r) => resolve('http ' + r.statusCode));
      });
    assert.equal(await ws(token), 'hello');
    assert.notEqual(await ws(t.token), 'hello');

    // a revoked phone gets 401 through the gateway too (so the app signs out instead of showing errors)
    const gwPhone = await pair(t, 'Wordt ingetrokken');
    assert.equal((await call(gw, gwPhone.token, 'GET', '/api/me')).status, 200);
    await t.api('POST', `/mobile/devices/${gwPhone.deviceId}/revoke`, {});
    assert.equal((await call(gw, gwPhone.token, 'GET', '/api/me')).status, 401);
    assert.equal(await ws(gwPhone.token), 'http 401');
    assert.equal((await call(gw, null, 'GET', '/api/threads')).status, 401);

    const off = await t.api('PUT', '/mobile/gateway', { enabled: false });
    assert.equal(off.gateway.running, false);
    const after = await fetch(gw + '/api/public/status').then(() => 'up', () => 'down');
    assert.equal(after, 'down');
  } finally {
    await t.close();
  }
});

test('one-click Tailscale https: loopback gateway, served target, ready address first; refused without Tailscale or ack', async () => {
  const t = await startTestApp();
  try {
    const m = mobileOf(t);
    let served: string[] = [];
    const runs: string[] = [];
    m.tailscaleProbe = async (ips) => ({ installed: true, running: false, ips, dnsName: 'pc.tail1234.ts.net', detail: 'test' });
    m.serveTargets = async () => served;
    // any free port (port+1 of a random test port can be taken while many suites run)
    t.app.ctx.store.setSetting('', 'mobileGateway', { enabled: false, bind: 'all', port: 0 });
    m.serveRun = async (target) => {
      runs.push(target);
      served = [target];
      return { ok: true, detail: 'ok' };
    };
    assert.equal((await call(t.app.url, t.token, 'POST', '/api/mobile/tailscale-https', {})).status, 400); // needs acknowledge
    assert.equal((await call(t.app.url, t.token, 'POST', '/api/mobile/tailscale-https', { acknowledge: true })).status, 400); // not connected
    assert.equal(runs.length, 0);

    m.tailscaleProbe = async (ips) => ({ installed: true, running: true, ips, dnsName: 'pc.tail1234.ts.net', detail: 'test' });
    const before = await t.api('GET', '/mobile/reachability');
    assert.equal(before.candidates.find((c: any) => c.kind === 'tailscale-https')?.ready, false);

    const r = await t.api('POST', '/mobile/tailscale-https', { acknowledge: true });
    assert.equal(r.gateway.running, true);
    assert.equal(r.gateway.bind, 'loopback'); // nothing listens on the LAN
    assert.equal(r.gateway.address, '127.0.0.1');
    assert.deepEqual(runs, [`http://127.0.0.1:${r.gateway.port}`]);
    assert.equal(r.serve.url, 'https://pc.tail1234.ts.net');
    assert.equal(r.candidates[0].kind, 'tailscale-https');
    assert.equal(r.candidates[0].ready, true);
    assert.equal(r.candidates[0].secure, true);
    // the port is pinned so the address survives a restart
    assert.equal(m.gatewaySettings().port, r.gateway.port);

    const { token } = await pair(t);
    assert.equal((await call(t.app.url, token, 'POST', '/api/mobile/tailscale-https', { acknowledge: true })).status, 403); // phones can't change it

    m.serveRun = async () => ({ ok: false, detail: 'Zet eerst https aan voor je tailnet: https://login.tailscale.com/x' });
    const fail = await call(t.app.url, t.token, 'POST', '/api/mobile/tailscale-https', { acknowledge: true });
    assert.equal(fail.status, 400);
    assert.match(JSON.stringify(fail.body ?? fail), /https aan/);
  } finally {
    await t.close();
  }
});

test("push texts follow the owner's interface language (the lock screen is not translated by the page)", async () => {
  const t = await startTestApp();
  try {
    const m = mobileOf(t);
    m.tailscaleProbe = async (ips) => ({ installed: false, running: false, ips, dnsName: null, detail: 'test' });
    const sent: Buffer[] = [];
    m.push.transport = async (_url, init) => {
      sent.push(init.body);
      return { status: 201 };
    };
    const ownerId = t.app.ctx.auth.owner()!.id;
    const A = subscriber();
    const { token: phone } = await pair(t);
    assert.equal((await call(t.app.url, phone, 'POST', '/api/mobile/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/de', keys: { p256dh: A.p256dh, auth: A.auth } } })).status, 200);
    const open = (b: Buffer) => JSON.parse(decryptPayload(b, A.priv, A.p256dh, A.auth).toString());
    t.app.ctx.store.setSetting(ownerId, 'language', 'de');

    // A finished run: "{0} is klaar" in German, the bot's own answer as it is.
    const agent = await t.agent({ name: 'Onderzoeker' });
    const th = await t.api('POST', '/threads', { agentId: agent.id });
    t.script.push({ text: 'Zusammenfassung fertig' });
    await t.say(th.id, 'fasse zusammen');
    await until(() => sent.some((s) => open(s).kind === 'run'));
    const run = sent.map(open).find((p) => p.kind === 'run');
    assert.equal(run.title, 'Onderzoeker ist fertig');
    assert.equal(run.body, 'Zusammenfassung fertig');

    // A TeamBot notification (Dutch source text) arrives translated.
    // (the memory's own notice, server/modules/memory/dossier-auto.ts)
    t.app.ctx.events.emit(ownerId, 'notification', { title: 'Dossier voorgesteld', body: 'Onderzoeker stelt een dossier voor: “Klanten” (kwam in meer gesprekken terug). Eén klik in Geheugen › Dossiers.', link: '#/m/memory/dossiers', kind: 'memory' });
    await until(() => sent.some((s) => open(s).link === '#/m/memory/dossiers'));
    const mem = sent.map(open).find((p) => p.link === '#/m/memory/dossiers');
    assert.notEqual(mem.title, 'Dossier voorgesteld', 'title translated');
    assert.match(mem.body, /Onderzoeker/);
    assert.doesNotMatch(mem.body, /stelt een dossier voor|Eén klik/, `body translated: ${mem.body}`);

    // Without previews: the generic texts in German too.
    await t.api('PUT', '/mobile/push/prefs', { preview: false });
    const before = sent.length;
    t.app.ctx.events.emit(ownerId, 'notification', { title: 'Geheim', body: 'Inhoud', link: '#/t/x', kind: 'approval', approvalId: 'apr_9' });
    await until(() => sent.length > before);
    const hidden = open(sent[before]);
    assert.equal(hidden.title, 'TeamBot');
    assert.equal(hidden.body, 'Ein Bot wartet auf deine Antwort');

    // A Dutch user: unchanged.
    t.app.ctx.store.setSetting(ownerId, 'language', 'nl');
    t.app.ctx.events.emit(ownerId, 'notification', { title: 'Geheim', body: 'Inhoud', link: '#/t/y', kind: 'approval', approvalId: 'apr_10' });
    await until(() => sent.length > before + 1);
    assert.equal(open(sent[before + 1]).body, 'Een bot wacht op je antwoord');
  } finally {
    await t.close();
  }
});
