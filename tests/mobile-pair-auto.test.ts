// 0.4.5 "app downloaded, paired with the QR code, done": Instellingen › Telefoon is one card whose QR code is there
// right away. POST /mobile/pair { baseUrl: 'auto' } switches the TeamBot connection (iroh) on and puts a ready https
// address (Tailscale Serve) in the code as well; the phone opens on "Wacht op jou" when something waits.
// Offline: no relays and no lookup service (the iroh endpoint only binds local sockets).
process.env.TEAMBOT_IROH_PRESET = 'offline';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTestApp, type TestApp } from './helpers.js';
import { iosAppUrl, type Mobile } from '../server/modules/mobile/index.js';

const mobileOf = (t: TestApp): Mobile => t.app.ctx.services.mobile.instance;
const fragment = (url: string) => new URLSearchParams(url.slice(url.indexOf('#') + 1));
const noTailscale = async () => ({ installed: false, running: false, ips: [], dnsName: null, detail: 'Tailscale niet gevonden' });

test('pairing auto: the TeamBot connection goes on by itself, the code is for the iPhone app', async () => {
  const t = await startTestApp();
  const m = mobileOf(t);
  m.tailscaleProbe = noTailscale;
  m.serveTargets = async () => [];
  try {
    assert.equal(m.iroh.status().running, false, 'off on a fresh install');
    const tk = await t.api('POST', '/mobile/pair', { baseUrl: 'auto' });
    assert.ok(tk.url.startsWith('teambot://pair#t='), tk.url);
    assert.equal(tk.via, 'iroh');
    assert.equal(tk.auto.kind, 'iroh');
    assert.equal(m.iroh.status().running, true, 'switched on when pairing');
    assert.equal(fragment(tk.url).get('n'), m.iroh.link()!.id, 'the code pins this computer’s key');
    assert.ok(t.app.ctx.store.one("SELECT id FROM audit WHERE kind = 'mobile.iroh.enabled'"), 'switching it on is in the audit log');
    // Again (the page is opened again): still the TeamBot connection, the old code is no longer valid.
    const again = await t.api('POST', '/mobile/pair', { baseUrl: 'auto' });
    assert.equal(again.via, 'iroh');
    assert.equal((await t.api('GET', `/mobile/pair/${tk.id}`)).status, 'cancelled');

    // Switched off on purpose (Meer opties › Bereikbaarheid): the card does not switch it on again behind your back.
    await t.api('PUT', '/mobile/iroh', { enabled: false });
    assert.equal(m.iroh.status().running, false);
    await assert.rejects(t.api('POST', '/mobile/pair', { baseUrl: 'auto' }), /TeamBot-verbinding staat uit/);
    assert.equal(m.iroh.status().running, false, 'still off');
    // Choosing it again (Meer opties › QR-code met een ander adres › TeamBot-verbinding) is the owner's own choice.
    await t.api('POST', '/mobile/pair', { baseUrl: 'iroh' });
    assert.equal(m.iroh.status().running, true);
    assert.equal((await t.api('POST', '/mobile/pair', { baseUrl: 'auto' })).via, 'iroh', 'automatic again after that');
  } finally {
    await t.close();
  }
});

test('pairing auto: with Tailscale https ready the code carries that address plus the key; a phone pairs with it and opens on Wacht op jou when something waits', async () => {
  const t = await startTestApp();
  const m = mobileOf(t);
  m.tailscaleProbe = async () => ({ installed: true, running: true, ips: ['100.101.102.103'], dnsName: 'sanne-pc.tail1234.ts.net', detail: 'Verbonden' });
  try {
    // Tailscale Serve publishes the private phone gateway (what "Telefoon via Tailscale instellen" sets up).
    await t.api('PUT', '/mobile/gateway', { enabled: true, bind: 'loopback', port: 0, acknowledge: true });
    m.serveTargets = async () => [`http://127.0.0.1:${m.gateway.state.port}`];
    const reach = await t.api('GET', '/mobile/reachability');
    assert.ok(reach.candidates.find((c: any) => c.kind === 'tailscale-https')?.ready, JSON.stringify(reach.candidates));
    assert.deepEqual(reach.app, { ios: null }, 'no public app link set: the card points to TestFlight');

    const tk = await t.api('POST', '/mobile/pair', { baseUrl: 'auto' });
    assert.ok(tk.url.startsWith('https://sanne-pc.tail1234.ts.net/api/public/mobile/pair#t='), tk.url);
    assert.equal(tk.via, 'both', 'the owner’s Tailscale keeps working, the TeamBot connection is there for when it does not');
    assert.equal(tk.auto.kind, 'tailscale-https');
    assert.equal(fragment(tk.url).get('n'), m.iroh.link()!.id);

    // The stand-in iPhone app claims the code.
    const claim = await fetch(`${t.app.url}/api/public/mobile/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: fragment(tk.url).get('t'), name: 'iPhone van Sanne', platform: 'ios', client: 'ios-app' }),
    });
    assert.equal(claim.status, 200);
    const { token } = await claim.json();
    assert.equal((await t.api('GET', `/mobile/pair/${tk.id}`)).status, 'used');
    const status = async () => (await (await fetch(`${t.app.url}/api/mobile/status`, { headers: { authorization: `Bearer ${token}` } })).json()).home;
    assert.equal(await status(), null, 'nothing waits: Chats');

    const ctx = t.app.ctx;
    const owner = ctx.auth.owner()!;
    const bot = await t.agent({ name: 'Pieter' });
    const th = ctx.chat.threadForAgent(owner.id, bot.id);
    const id = `apr_${crypto.randomBytes(6).toString('hex')}`;
    ctx.store.insert('approvals', { id, user_id: owner.id, agent_id: bot.id, run_id: null, thread_id: th.id, kind: 'tool', tool: 'write_file', input: {}, summary: 'Offerte opslaan', risk: 'write', options: null, status: 'pending', created_at: new Date().toISOString() });
    assert.equal(await status(), '#/inbox', 'something waits: the iPhone app opens on Wacht op jou');
    ctx.store.exec("UPDATE approvals SET status = 'approved' WHERE id = ?", id);
    assert.equal(await status(), null);
  } finally {
    await t.close();
  }
});

test('pairing auto: without the TeamBot connection and without an address, a plain reason (Meer opties has the choices)', async () => {
  const t = await startTestApp();
  const m = mobileOf(t);
  m.tailscaleProbe = noTailscale;
  m.serveTargets = async () => [];
  const real = m.iroh.status.bind(m.iroh);
  m.iroh.status = () => ({ ...real(), available: false });
  try {
    await assert.rejects(t.api('POST', '/mobile/pair', { baseUrl: 'auto' }), /kan deze computer nog niet bereiken.*Meer opties/);
    assert.equal(m.iroh.link(), null, 'not switched on');
    // An address that works now (here the public address of this server, plain http): it goes in the code.
    t.app.ctx.config.publicUrl = 'http://teambot.voorbeeld.nl:4868';
    const tk = await t.api('POST', '/mobile/pair', { baseUrl: 'auto' });
    assert.equal(tk.via, 'address');
    assert.equal(tk.base_url, 'http://teambot.voorbeeld.nl:4868');
    assert.equal(tk.auto.kind, 'public');
    assert.ok(tk.url.startsWith('http://teambot.voorbeeld.nl:4868/api/public/mobile/pair#t='), tk.url);
  } finally {
    await t.close();
  }
});

test('the iPhone app link: https only', () => {
  assert.equal(iosAppUrl(''), null);
  assert.equal(iosAppUrl(undefined), null);
  assert.equal(iosAppUrl('http://testflight.apple.com/join/abc'), null);
  assert.equal(iosAppUrl('https://u:p@testflight.apple.com/join/abc'), null);
  assert.equal(iosAppUrl('javascript:alert(1)'), null);
  assert.equal(iosAppUrl(' https://testflight.apple.com/join/AbCd1234 '), 'https://testflight.apple.com/join/AbCd1234');
});
