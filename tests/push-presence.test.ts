// 0.4.4 P8 "Meldingen op de goede plek": at the pc only the Windows notification; the phone gets alerts once you are
// away (3 minutes without input since 0.4.5, was 30 s; or the screen locked); "Altijd ook op de telefoon" sends to both
// (server/modules/mobile/presence.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTestApp, type TestApp } from './helpers.js';
import { b64u, decryptPayload } from '../server/modules/mobile/webpush.js';
import { AWAY_AFTER_S, Presence, STALE_MS, phoneGets, whereIs } from '../server/modules/mobile/presence.js';

test('presence: at the pc, away after 3 minutes or with the screen locked, unknown without a fresh report', () => {
  const t0 = Date.parse('2026-11-09T10:00:00Z');
  assert.equal(AWAY_AFTER_S, 180, '0.4.5: three minutes away from the pc before the phone gets alerts');
  assert.equal(whereIs(null, t0), 'unknown');
  assert.equal(whereIs({ idleSeconds: 2, locked: false, at: t0 }, t0), 'pc');
  // Reading a long answer for a minute or two is still "at the pc" (it was "away" after 30 s before 0.4.5).
  assert.equal(whereIs({ idleSeconds: 45, locked: false, at: t0 }, t0), 'pc');
  assert.equal(whereIs({ idleSeconds: 170, locked: false, at: t0 }, t0), 'pc');
  assert.equal(whereIs({ idleSeconds: AWAY_AFTER_S, locked: false, at: t0 }, t0), 'away');
  assert.equal(whereIs({ idleSeconds: 0, locked: true, at: t0 }, t0), 'away');
  // A report a few seconds old counts those seconds as idle too.
  assert.equal(whereIs({ idleSeconds: AWAY_AFTER_S - 4, locked: false, at: t0 }, t0 + 5000), 'away');
  assert.equal(whereIs({ idleSeconds: 0, locked: false, at: t0 }, t0 + STALE_MS + 1), 'unknown');

  // Where an alert goes.
  assert.equal(phoneGets({ where: 'pc', alwaysPhone: false, approval: true, online: true }), false);
  assert.equal(phoneGets({ where: 'away', alwaysPhone: false, approval: false, online: true }), true);
  assert.equal(phoneGets({ where: 'pc', alwaysPhone: true, approval: true, online: true }), true, 'Altijd ook op de telefoon');
  assert.equal(phoneGets({ where: 'pc', alwaysPhone: true, approval: false, online: true }), false, 'as before: the rest only when TeamBot is not open');
  assert.equal(phoneGets({ where: 'unknown', alwaysPhone: false, approval: true, online: true }), true, 'no desktop app: as before');
  assert.equal(phoneGets({ where: 'unknown', alwaysPhone: false, approval: false, online: false }), true);

  const p = new Presence();
  let now = t0;
  p.clock = () => now;
  const away: string[] = [];
  p.onAway((u) => away.push(u));
  p.report('u1', { idleSeconds: 1, locked: false });
  p.report('u1', { idleSeconds: 40, locked: false });
  assert.deepEqual(away, [], '40 s still is at the pc');
  p.report('u1', { idleSeconds: 190, locked: false });
  p.report('u1', { idleSeconds: 200, locked: false });
  assert.deepEqual(away, ['u1'], 'one transition, one call');
  now += 1000;
  p.report('u1', { idleSeconds: 0, locked: false });
  p.report('u1', { idleSeconds: 0, locked: true });
  assert.deepEqual(away, ['u1', 'u1']);
  assert.deepEqual(p.view('u1'), { where: 'away', locked: true, awayAfterSeconds: 180 });
});

function subscriber() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { priv: ecdh.getPrivateKey(), p256dh: b64u.enc(ecdh.getPublicKey()), auth: b64u.enc(crypto.randomBytes(16)) };
}

async function phone(t: TestApp) {
  const ticket = await t.api('POST', '/mobile/pair', { baseUrl: t.app.url });
  const secret = new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('t');
  const claimed = await (await fetch(`${t.app.url}/api/public/mobile/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret, name: 'iPhone', platform: 'ios', client: 'ios-app' }) })).json();
  const s = subscriber();
  const r = await fetch(`${t.app.url}/api/mobile/push/subscribe`, { method: 'POST', headers: { authorization: `Bearer ${claimed.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/sanne', keys: { p256dh: s.p256dh, auth: s.auth } } }) });
  assert.equal(r.status, 200);
  return s;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('push: at the pc the phone stays quiet, a held approval follows you when you walk away, Altijd ook op de telefoon sends both', async () => {
  const t = await startTestApp();
  try {
    const ctx = t.app.ctx;
    const ownerId = ctx.auth.owner()!.id;
    const m = ctx.services.mobile.instance;
    const sent: any[] = [];
    const s = await phone(t);
    m.push.transport = async (_url: string, init: any) => {
      sent.push(JSON.parse(decryptPayload(init.body, s.priv, s.p256dh, s.auth).toString()));
      return { status: 201 };
    };
    const bot = await t.agent({ name: 'Pieter' });
    const th = ctx.chat.threadForAgent(ownerId, bot.id);
    const ask = (summary: string) => {
      const id = `apr_${crypto.randomBytes(6).toString('hex')}`;
      ctx.store.insert('approvals', { id, user_id: ownerId, agent_id: bot.id, run_id: null, thread_id: th.id, kind: 'tool', tool: 'write_file', input: {}, summary, risk: 'write', options: null, status: 'pending', created_at: new Date().toISOString() });
      ctx.events.emit(ownerId, 'notification', { title: 'Pieter vraagt toestemming', body: summary, link: `#/t/${th.id}`, kind: 'approval', approvalId: id, agentId: bot.id });
      return id;
    };

    // At the pc: nothing to the phone, not even an approval.
    ctx.services.mobile.reportPresence(ownerId, { idleSeconds: 3, locked: false });
    assert.equal((await t.api('GET', '/mobile/push')).presence.where, 'pc');
    const held = ask('Offerte opslaan');
    ctx.events.emit(ownerId, 'notification', { title: 'Pieter', body: 'Rapport klaar', link: `#/t/${th.id}`, kind: 'agent', agentId: bot.id });
    await sleep(150);
    assert.equal(sent.length, 0);

    // You lock the screen: the held approval goes to the phone after all.
    ctx.services.mobile.reportPresence(ownerId, { idleSeconds: 0, locked: true });
    for (let i = 0; i < 50 && !sent.length; i++) await sleep(20);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, 'approval');
    assert.equal(sent[0].tag, `apr-${held}`);
    // Away: also the other alerts, although TeamBot is open (the desktop window counts as online).
    ctx.events.emit(ownerId, 'notification', { title: 'Pieter', body: 'Tweede rapport', link: `#/t/${th.id}`, kind: 'agent', agentId: bot.id });
    for (let i = 0; i < 50 && sent.length < 2; i++) await sleep(20);
    assert.equal(sent[1]?.body, 'Tweede rapport');

    // Back at the pc; an approval that was decided before you left is not pushed afterwards.
    ctx.services.mobile.reportPresence(ownerId, { idleSeconds: 0, locked: false });
    const decided = ask('Al beslist');
    ctx.store.exec("UPDATE approvals SET status = 'approved' WHERE id = ?", decided);
    ctx.services.mobile.reportPresence(ownerId, { idleSeconds: 45, locked: false });
    await sleep(150);
    assert.equal(sent.length, 2, '45 s without input is still at the pc: no push');
    ctx.services.mobile.reportPresence(ownerId, { idleSeconds: 200, locked: false });
    await sleep(150);
    assert.equal(sent.length, 2, 'walking away later does not push an approval that was already decided');

    // Altijd ook op de telefoon: an approval at the pc goes to both.
    ctx.services.mobile.reportPresence(ownerId, { idleSeconds: 0, locked: false });
    const prefs = await t.api('PUT', '/mobile/push/prefs', { alwaysPhone: true });
    assert.equal(prefs.alwaysPhone, true);
    ask('Mail versturen');
    for (let i = 0; i < 50 && sent.length < 3; i++) await sleep(20);
    assert.equal(sent[2]?.body, 'Mail versturen');
  } finally {
    await t.close();
  }
});
