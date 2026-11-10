// iPhone app (plan 0.4 §I): honest status per link, consent list (App Review 5.1.2(i)), pairing that survives a switch
// between wifi and Tailscale, and re-pairing that never touches conversations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTestApp, type TestApp } from './helpers.js';
import type { Mobile } from '../server/modules/mobile/index.js';
import { helloMessage, helloProof, privacyVersion } from '../server/modules/mobile/status.js';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TeamBotiOS/0.4.0';
const mobileOf = (t: TestApp): Mobile => t.app.ctx.services.mobile.instance;
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

async function call(base: string, token: string | null, method: string, p: string, body?: any) {
  const res = await fetch(base + p, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), 'user-agent': IPHONE_UA },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, body: json, text, headers: res.headers };
}

async function pair(t: TestApp, name = 'iPhone van Sanne') {
  const ticket = await t.api('POST', '/mobile/pair', { baseUrl: 'http://192.168.1.5:4818' });
  const secret = new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('t')!;
  const r = await call(t.app.url, null, 'POST', '/api/public/mobile/claim', { secret, name, platform: 'ios', client: 'ios-app' });
  assert.equal(r.status, 200, r.text);
  return { token: r.body.token as string, deviceId: r.body.device.id as string };
}

const nonce = () => crypto.randomBytes(16).toString('base64url');
const hello = (base: string, device: string, n = nonce()) => call(base, null, 'POST', '/api/public/mobile/hello', { device, nonce: n });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('hello proves "this is your TeamBot" without a token: HMAC with the token hash, states active/revoked/unknown', async () => {
  const t = await startTestApp();
  try {
    const { token, deviceId } = await pair(t);
    const n = nonce();
    const a = await hello(t.app.url, deviceId, n);
    assert.equal(a.status, 200, a.text);
    assert.equal(a.headers.get('cache-control'), 'no-store');
    assert.equal(a.body.teambot, 1);
    assert.equal(a.body.device, 'active');
    assert.match(a.body.instance, /^tbi_[A-Za-z0-9_-]{16,}$/);
    // The phone checks the proof with the SHA-256 of its own token; the token itself never travels.
    assert.equal(a.body.proof, helloProof(sha(token), helloMessage(a.body.instance, deviceId, n, 'active')));
    assert.ok(!a.text.includes(token));
    // A proof is bound to the nonce and the state: replaying it for another nonce or state does not verify.
    assert.notEqual(a.body.proof, helloProof(sha(token), helloMessage(a.body.instance, deviceId, nonce(), 'active')));
    assert.notEqual(a.body.proof, helloProof(sha(token), helloMessage(a.body.instance, deviceId, n, 'revoked')));
    // Same TeamBot = same instance id on every call (and after a restart: it is stored).
    assert.equal((await hello(t.app.url, deviceId)).body.instance, a.body.instance);
    assert.equal(t.app.ctx.store.getSetting('', 'mobileInstance', ''), a.body.instance);

    // Unknown device: no proof, so a stranger learns nothing and the app cannot be tricked into forgetting its key.
    const u = await hello(t.app.url, 'ses_doesnotexist000000');
    assert.equal(u.body.device, 'unknown');
    assert.equal(u.body.proof, null);
    // A computer session is not a phone.
    const desktop = t.app.ctx.store.one<{ id: string }>("SELECT id FROM sessions WHERE kind = 'desktop'")!;
    assert.equal((await hello(t.app.url, desktop.id)).body.device, 'unknown');

    // Revoked: still a valid proof, so the app may trust "ingetrokken" and forget its key.
    await t.api('POST', `/mobile/devices/${deviceId}/revoke`, {});
    const n2 = nonce();
    const r = await hello(t.app.url, deviceId, n2);
    assert.equal(r.body.device, 'revoked');
    assert.equal(r.body.proof, helloProof(sha(token), helloMessage(r.body.instance, deviceId, n2, 'revoked')));

    // Bad input
    assert.equal((await call(t.app.url, null, 'POST', '/api/public/mobile/hello', { device: deviceId, nonce: 'kort' })).status, 400);
    assert.equal((await call(t.app.url, null, 'POST', '/api/public/mobile/hello', { device: '../../x', nonce: nonce() })).status, 400);
    assert.equal((await call(t.app.url, null, 'POST', '/api/public/mobile/hello', {})).status, 400);
  } finally {
    await t.close();
  }
});

test('hello is rate limited per address', async () => {
  const t = await startTestApp();
  try {
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await hello(t.app.url, 'ses_unknown00000000000')).status;
    assert.equal(last, 429);
  } finally {
    await t.close();
  }
});

test('status: device, instance, addresses of this TeamBot (wifi, Tailscale, https), keep-awake, privacy version; only for the phone itself', async () => {
  const t = await startTestApp();
  try {
    const m = mobileOf(t);
    let served: string[] = [];
    m.tailscaleProbe = async (ips) => ({ installed: true, running: true, ips, dnsName: 'pc.tail1234.ts.net', detail: 'test' });
    m.serveTargets = async () => served;
    const { token, deviceId } = await pair(t);
    const D = (p: string) => call(t.app.url, token, 'GET', '/api' + p);

    const s = await D('/mobile/status');
    assert.equal(s.status, 200, s.text);
    assert.equal(s.headers.get('cache-control'), 'no-store');
    assert.deepEqual(s.body.device, { id: deviceId, name: 'iPhone van Sanne' });
    assert.equal(s.body.instance, (await hello(t.app.url, deviceId)).body.instance);
    assert.equal(s.body.home, null);
    assert.deepEqual(s.body.power, { available: false, keepAwake: false }); // no desktop shell in tests: honest "not available"
    assert.equal(s.body.privacy.version, (await D('/mobile/privacy')).body.version);
    assert.ok(Array.isArray(s.body.addresses));
    assert.ok(!s.text.includes(token));

    // Phone access for a tunnel / Tailscale Serve (loopback only: tests never open a port on the network).
    const reach = await t.api('PUT', '/mobile/gateway', { enabled: true, bind: 'loopback', port: 0, acknowledge: true });
    assert.equal(reach.gateway.running, true, JSON.stringify(reach.gateway));
    const port = reach.gateway.port;
    const gw = `http://127.0.0.1:${port}`;
    const viaGw = await call(gw, token, 'GET', '/api/mobile/status');
    assert.equal(viaGw.status, 200, viaGw.text);
    assert.deepEqual(viaGw.body.addresses.filter((a: any) => a.kind === 'lan' || a.kind === 'tailscale'), [], 'loopback: nothing on the LAN');
    // The hello works through the gateway without a token (it is a public pairing route).
    assert.equal((await hello(gw, deviceId)).body.device, 'active');

    // Phone access on all networks (simulated state, no real 0.0.0.0 listener): every LAN and Tailscale address of
    // this pc on the gateway port.
    const real = { ...m.gateway.state };
    m.gateway.state = { running: true, address: '0.0.0.0', port: 45999, error: null };
    const all = await D('/mobile/status');
    for (const a of all.body.addresses) {
      assert.ok(['lan', 'tailscale', 'tailscale-https', 'public'].includes(a.kind), a.kind);
      if (a.kind === 'lan' || a.kind === 'tailscale') assert.match(a.url, /^http:\/\/[0-9.]+:45999$/);
      assert.equal(a.secure, a.url.startsWith('https:'));
    }
    m.gateway.state = real;

    // Tailscale Serve publishes the gateway: after the background look-up the https address comes first.
    served = [`http://127.0.0.1:${port}`];
    (m.status as any).https.at = 0;
    await D('/mobile/status');
    let first = '';
    for (let i = 0; i < 100 && first !== 'https://pc.tail1234.ts.net'; i++) {
      await sleep(10);
      first = (await D('/mobile/status')).body.addresses[0]?.url || '';
    }
    assert.equal(first, 'https://pc.tail1234.ts.net');

    // The start page hook (wave 2: the main bot); only an in-app route is passed on.
    t.app.ctx.services.mobileHome = () => '#/t/thr_main';
    assert.equal((await D('/mobile/status')).body.home, '#/t/thr_main');
    t.app.ctx.services.mobileHome = () => 'https://evil.example/';
    assert.equal((await D('/mobile/status')).body.home, null);
    delete t.app.ctx.services.mobileHome;

    // The phone may read status and privacy, but still nothing of the computer side.
    assert.equal((await D('/mobile/reachability')).status, 403);
    assert.equal((await call(t.app.url, token, 'PUT', '/api/mobile/gateway', { enabled: false })).status, 403);

    // A revoked phone gets 401 (the app then checks the hello before it forgets its key).
    await t.api('POST', `/mobile/devices/${deviceId}/revoke`, {});
    assert.equal((await D('/mobile/status')).status, 401);
    await t.api('PUT', '/mobile/gateway', { enabled: false });
  } finally {
    await t.close();
  }
});

test('status: a member (not admin) never gets the LAN or Tailscale addresses of the pc', async () => {
  const t = await startTestApp();
  try {
    const m = mobileOf(t);
    m.tailscaleProbe = async (ips) => ({ installed: false, running: false, ips, dnsName: null, detail: 'test' });
    const member = t.app.ctx.auth.createUser({ name: 'Lid', role: 'member' });
    const ticket = await m.pairing.createTicket(member, 'https://teambot.example.nl');
    const secret = new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('t')!;
    const claimed = await call(t.app.url, null, 'POST', '/api/public/mobile/claim', { secret, name: 'Telefoon lid', platform: 'ios', client: 'ios-app' });
    assert.equal(claimed.status, 200, claimed.text);
    // Simulated "phone access on all networks" (tests never open a port on the network).
    m.gateway.state = { running: true, address: '0.0.0.0', port: 45999, error: null };
    const s = await call(t.app.url, claimed.body.token, 'GET', '/api/mobile/status');
    assert.equal(s.status, 200, s.text);
    assert.deepEqual(s.body.addresses.filter((a: any) => a.kind === 'lan' || a.kind === 'tailscale'), []);
    // The owner's own phone does get them (when this pc has a LAN or Tailscale address at all).
    const ownerPhone = await pair(t);
    const o = await call(t.app.url, ownerPhone.token, 'GET', '/api/mobile/status');
    assert.ok(o.body.addresses.every((a: any) => a.kind !== 'lan' || a.url.endsWith(':45999')));
    m.gateway.state = { running: false, address: null, port: null, error: null };
  } finally {
    await t.close();
  }
});

test('privacy: every enabled AI service with its company, what data goes there, which bots use it; local ones marked', async () => {
  const t = await startTestApp();
  try {
    const ctx = t.app.ctx;
    const owner = ctx.auth.owner()!;
    const agent = await t.agent({ name: 'Hoofdbot' });
    const claude = ctx.providers.create(owner.id, { kind: 'anthropic', apiKey: 'sk-ant-test-' + 'x'.repeat(20) });
    const own = ctx.providers.create(owner.id, { kind: 'openai-compatible', name: 'Mijn server', base_url: 'https://llm.example.com:8443/v1?key=geheim' });
    const lan = ctx.providers.create(owner.id, { kind: 'openai-compatible', name: 'Thuisserver', base_url: 'http://192.168.1.40:8000/v1' });
    const off = ctx.providers.create(owner.id, { kind: 'openrouter', apiKey: 'sk-or-test-' + 'x'.repeat(20) });
    ctx.store.update('providers', off.id, { enabled: false });
    await t.api('PATCH', `/agents/${agent.id}`, { settings: { fallbacks: [{ provider_id: claude.id, model: 'claude-x' }] } });
    const { token } = await pair(t);
    const P = async () => (await call(t.app.url, token, 'GET', '/api/mobile/privacy')).body;

    const p = await P();
    const by = (id: string) => p.providers.find((x: any) => x.id === id);
    assert.equal(by(off.id), undefined, 'a disabled engine gets nothing');
    assert.deepEqual(by(t.providerId).bots, ['Hoofdbot']);
    assert.deepEqual(by(t.providerId).data, ['chat']);
    assert.equal(by(claude.id).vendor, 'Anthropic');
    assert.equal(by(claude.id).local, false);
    assert.deepEqual(by(claude.id).bots, ['Hoofdbot'], 'reserve engines count');
    assert.equal(by(own.id).host, 'llm.example.com', 'only the host, never the path or a key in the address');
    assert.equal(by(own.id).forwards, true);
    assert.ok(!JSON.stringify(p).includes('geheim'));
    assert.equal(by(lan.id).local, true, 'own network: stays home');
    assert.equal(by(lan.id).host, null);

    // Voice: recordings to a provider only when speech recognition or calls use it.
    ctx.store.setSetting(owner.id, 'voice', { stt: { engine: 'provider', providerId: claude.id }, call: { engine: 'local' }, tts: { engine: 'local' } });
    const v = await P();
    assert.deepEqual(v.providers.find((x: any) => x.id === claude.id).data, ['chat', 'voice']);
    assert.notEqual(v.version, p.version, 'new kind of data: ask again');

    // Renaming a bot or adding a local engine does not ask again; a new company does.
    await t.api('PATCH', `/agents/${agent.id}`, { name: 'Baas' });
    ctx.providers.create(owner.id, { kind: 'openai-compatible', name: 'Laptop', base_url: 'http://127.0.0.1:11434/v1' });
    assert.equal((await P()).version, v.version);
    ctx.providers.create(owner.id, { kind: 'openai-compatible', name: 'Ander bedrijf', base_url: 'https://api.other.example/v1' });
    assert.notEqual((await P()).version, v.version);

    // The version function itself: order does not matter, local entries do not count.
    const groq = ctx.providers.create(owner.id, { kind: 'groq', apiKey: 'gsk_test' + 'x'.repeat(40) });
    const g = (await P()).providers.find((x: any) => x.id === groq.id);
    assert.equal(g.vendor, 'Groq');
    assert.equal(g.free, true, 'free tier: the app repeats "some free services may use what you send"');
    assert.equal(by(claude.id).free, false);

    const a = { id: '1', vendor: 'A', service: 'a', local: false, host: null, forwards: false, free: false, data: ['chat' as const], bots: [] };
    const b = { ...a, id: '2', vendor: 'B' };
    const l = { ...a, id: '3', vendor: 'L', local: true };
    assert.equal(privacyVersion([a, b]), privacyVersion([b, a, l]));
  } finally {
    await t.close();
  }
});

test('re-pairing never touches conversations: the chat from the old phone key is still there with the new key', async () => {
  const t = await startTestApp();
  try {
    const agent = await t.agent();
    const first = await pair(t, 'iPhone');
    const th = await call(t.app.url, first.token, 'POST', '/api/threads', { agentId: agent.id });
    assert.equal(th.status, 200, th.text);
    t.script.push({ text: 'Antwoord voor de telefoon' });
    assert.equal((await call(t.app.url, first.token, 'POST', `/api/threads/${th.body.id}/messages`, { content: 'bericht vanaf de telefoon' })).status, 200);
    await t.waitIdle(th.body.id);

    // The phone unpairs itself (or the pc revokes it): its key stops working …
    assert.equal((await call(t.app.url, first.token, 'DELETE', '/api/mobile/devices/self')).status, 200);
    assert.equal((await call(t.app.url, first.token, 'GET', '/api/threads')).status, 401);
    // … and pairing again gives a new key that sees the same conversation, untouched.
    const second = await pair(t, 'iPhone');
    const list = await call(t.app.url, second.token, 'GET', '/api/threads');
    assert.ok(list.body.some((x: any) => x.id === th.body.id));
    const got = await call(t.app.url, second.token, 'GET', `/api/threads/${th.body.id}`);
    const texts = got.body.messages.map((x: any) => x.content);
    assert.ok(texts.includes('bericht vanaf de telefoon'));
    assert.ok(texts.includes('Antwoord voor de telefoon'));
  } finally {
    await t.close();
  }
});

test('proof test vector shared with the iPhone app (TeamBotTests/HelloProofTests.swift)', () => {
  const message = helloMessage('tbi_testinstance0000', 'ses_0123456789abcdef', 'nonce-0123456789abcdef', 'active');
  assert.equal(message, 'teambot-hello/1|tbi_testinstance0000|ses_0123456789abcdef|nonce-0123456789abcdef|active');
  assert.equal(helloProof(sha('token-voor-de-test'), message), VECTOR);
});

const VECTOR = '0f3bf427eaa4c1bb4a8bd4a33a501978b87cbbfb6e638e73e77612b9d5d7ce0f';
