// Offline: no relays and no lookup service; the phone dials the computer's direct addresses (see iroh-phone.ts).
process.env.TEAMBOT_IROH_PRESET = 'offline';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startTestApp, type TestApp } from './helpers.js';
import type { Mobile } from '../server/modules/mobile/index.js';
import { irohLib, normalizeRelayUrl, peerAddress } from '../server/modules/mobile/iroh.js';
import { startIrohPhone } from './iroh-phone.js';

const mobileOf = (t: TestApp): Mobile => t.app.ctx.services.mobile.instance;
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TeamBotiOS/0.4.4';

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
const fragment = (url: string) => new URLSearchParams(url.slice(url.indexOf('#') + 1));

test('iroh: the native part loads on this computer', () => {
  assert.ok(irohLib(), 'the prebuilt @number0/iroh binary must load here (Windows x64)');
});

test('iroh: relay addresses and phone addresses', () => {
  assert.equal(normalizeRelayUrl(''), null);
  assert.equal(normalizeRelayUrl(' https://relay.voorbeeld.nl '), 'https://relay.voorbeeld.nl/');
  assert.equal(normalizeRelayUrl('http://127.0.0.1:3340'), 'http://127.0.0.1:3340/');
  assert.throws(() => normalizeRelayUrl('http://relay.voorbeeld.nl'), /https/);
  assert.throws(() => normalizeRelayUrl('https://u:p@relay.voorbeeld.nl'));
  assert.throws(() => normalizeRelayUrl('https://relay.voorbeeld.nl/pad'));
  const a = peerAddress('abc');
  assert.match(a, /^fd7e(:[0-9a-f]{4}){7}$/);
  assert.equal(a, peerAddress('abc'));
  assert.notEqual(a, peerAddress('abd'));
});

test('iroh: off by default, on from the computer, QR carries the key, phone works through the gateway rules', async () => {
  const t = await startTestApp();
  const m = mobileOf(t);
  const phones: { close(): Promise<void> }[] = [];
  try {
    // off until chosen
    let reach = await t.api('GET', '/mobile/reachability');
    assert.equal(reach.iroh.enabled, false);
    assert.equal(reach.iroh.running, false);
    const cand = reach.candidates.find((c: any) => c.kind === 'iroh');
    assert.ok(cand && !cand.ready && reach.candidates[0].kind === 'iroh', JSON.stringify(reach.candidates));

    // a QR code for the TeamBot connection turns it on (making the code is the choice)
    const ticket = await t.api('POST', '/mobile/pair', { baseUrl: 'iroh' });
    assert.ok(ticket.url.startsWith('teambot://pair#t='), ticket.url);
    assert.equal(ticket.via, 'iroh');
    assert.equal(ticket.shellLink, null);
    reach = await t.api('GET', '/mobile/reachability');
    assert.equal(reach.iroh.running, true, JSON.stringify(reach.iroh));
    const id = reach.iroh.id as string;
    assert.equal(fragment(ticket.url).get('n'), id);
    assert.equal(fragment(ticket.url).get('r'), null); // n0 relays: the app finds them itself
    // a wifi QR code also carries the key now (the app falls back to the TeamBot connection)
    const lanTicket = await t.api('POST', '/mobile/pair', { baseUrl: 'http://192.168.1.5:4748' });
    assert.equal(fragment(lanTicket.url).get('n'), id);
    assert.equal(lanTicket.via, 'both');

    // the phone dials the key
    const addr = m.iroh.addr()!;
    assert.ok(addr.direct.length > 0, 'direct addresses');
    const phone = await startIrohPhone({ id, direct: addr.direct }, { offline: true });
    phones.push(phone);
    console.log(`# iroh offline: verbonden in ${phone.connectMs} ms, pad ${phone.path()}`);
    assert.equal(phone.path(), 'direct');

    // public pairing routes pass, the rest of /api/public does not
    const hello = await call(phone.base, null, 'POST', '/api/public/mobile/hello', { device: 'abcd1234', nonce: 'n'.repeat(20) });
    assert.equal(hello.status, 200, hello.text);
    assert.equal(hello.body.device, 'unknown');
    assert.equal((await call(phone.base, null, 'POST', '/api/public/hooks/x', {})).status, 403);
    // the desktop owner token never works over the TeamBot connection
    assert.equal((await call(phone.base, t.token, 'GET', '/api/me')).status, 403);
    assert.equal((await call(phone.base, null, 'GET', '/api/me')).status, 401);

    // pair over the TeamBot connection (the newest QR code: one open ticket per user)
    const fresh = await t.api('POST', '/mobile/pair', { baseUrl: 'iroh' });
    const claim = await call(phone.base, null, 'POST', '/api/public/mobile/claim', { secret: fragment(fresh.url).get('t'), name: 'iPhone onderweg', platform: 'ios', client: 'ios-app' }, { 'user-agent': IPHONE_UA });
    assert.equal(claim.status, 200, claim.text);
    const token = claim.body.token as string;
    assert.equal((await t.api('GET', `/mobile/pair/${fresh.id}`)).status, 'used');

    // a device session: same rules as on wifi
    const st = await call(phone.base, token, 'GET', '/api/mobile/status');
    assert.equal(st.status, 200, st.text);
    assert.deepEqual(st.body.iroh, { id, relay: null });
    assert.equal((await call(phone.base, token, 'GET', '/api/me')).status, 200);
    assert.equal((await call(phone.base, token, 'PUT', '/api/mobile/iroh', { enabled: false })).status, 403); // computer-only
    assert.equal((await call(phone.base, token, 'GET', '/api/mobile/reachability')).status, 403);
    assert.equal((await call(phone.base, token, 'POST', '/api/mobile/pair', { baseUrl: 'iroh' })).status, 403);
    // also from the computer's own address a phone cannot switch it
    assert.equal((await call(t.app.url, token, 'PUT', '/api/mobile/iroh', { enabled: false })).status, 403);

    // each phone gets its own stable address (rate limits, audit), never the client-sent one
    t.app.ctx.publicApi.get('/mobile/test-ip', (req, res) => res.json({ ip: req.ip }));
    const ip = await call(phone.base, null, 'GET', '/api/public/mobile/test-ip', undefined, { 'x-forwarded-for': '6.6.6.6' });
    assert.match(ip.body.ip, /^fd7e:/, ip.text);

    // the web app shell and the live WebSocket (signed URL, like the app makes it)
    const key = await call(phone.base, token, 'GET', '/api/auth/url-key');
    assert.equal(key.status, 200, key.text);
    const ws = new WebSocket(phone.base.replace('http:', 'ws:') + t.signed('/ws', token));
    const first = await new Promise<any>((resolve, reject) => {
      ws.once('message', (d) => resolve(JSON.parse(String(d))));
      ws.once('error', reject);
      setTimeout(() => reject(new Error('geen WebSocket-antwoord')), 5000);
    });
    assert.equal(first.type, 'hello');
    ws.close();
    // an unsigned socket is refused by the gateway
    const bad = new WebSocket(phone.base.replace('http:', 'ws:') + '/ws');
    const code = await new Promise<string>((resolve) => {
      bad.once('unexpected-response', (_req, res) => resolve(String(res.statusCode)));
      bad.once('error', (e) => resolve(String(e.message)));
    });
    assert.match(code, /401|403/);

    // revoking the phone works over the TeamBot connection too
    const devices = await t.api('GET', '/mobile/devices');
    await t.api('POST', `/mobile/devices/${devices[0].id}/revoke`);
    assert.equal((await call(phone.base, token, 'GET', '/api/me')).status, 401);

    // the key survives a restart (the QR code in the phone keeps working)
    await m.iroh.stop();
    await m.iroh.apply();
    assert.equal(m.iroh.status().id, id);

    // own relay (Geavanceerd): only https; saved and shown
    assert.equal((await call(t.app.url, t.token, 'PUT', '/api/mobile/iroh', { relay: 'http://relay.voorbeeld.nl' })).status, 400);
    reach = await t.api('PUT', '/mobile/iroh', { relay: 'https://relay.voorbeeld.nl' });
    assert.equal(reach.iroh.relay.own, 'https://relay.voorbeeld.nl/');
    const own = await t.api('POST', '/mobile/pair', { baseUrl: 'iroh' });
    assert.equal(fragment(own.url).get('r'), 'https://relay.voorbeeld.nl/');
    reach = await t.api('PUT', '/mobile/iroh', { relay: '' });
    assert.equal(reach.iroh.relay.own, null);

    // off again: the phone can no longer reach the computer this way
    reach = await t.api('PUT', '/mobile/iroh', { enabled: false });
    assert.equal(reach.iroh.running, false);
    assert.equal(reach.candidates.find((c: any) => c.kind === 'iroh').ready, false);
    const dial = await startIrohPhone({ id, direct: addr.direct }, { offline: true, timeoutMs: 3000 }).then(
      (p) => (phones.push(p), 'verbonden'),
      () => 'geen verbinding',
    );
    assert.equal(dial, 'geen verbinding');
    const audit = t.app.ctx.store.all<{ kind: string }>("SELECT kind FROM audit WHERE kind LIKE 'mobile.iroh.%'").map((r) => r.kind);
    assert.deepEqual(audit.slice(0, 1), ['mobile.iroh.enabled']);
    assert.ok(audit.includes('mobile.iroh.disabled'));
  } finally {
    for (const p of phones) await p.close().catch(() => undefined);
    await t.close();
  }
});
