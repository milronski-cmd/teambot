import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTestApp, type TestApp } from './helpers.js';
import { createRoutinesModule } from '../server/modules/routines/index.js';
import type { RoutineEngine } from '../server/modules/routines/engine.js';
import { checkPresetSecret, describeDelivery, standardSignature, verifySignature, WEBHOOK_PRESETS } from '../server/modules/routines/triggers.js';

/** Routine trigger preset "Standard Webhooks" (PARITEIT 9.5): own implementation of the open spec with node:crypto. */

// The example of the spec and of the reference libraries (standard-webhooks/standard-webhooks).
const VECTOR = {
  secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  ts: 1614265330,
  payload: '{"test": 2432232314}',
  signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
};

const verify = (headers: Record<string, string>, o: { secret?: string; raw?: string; nowSec?: number } = {}) =>
  verifySignature({ preset: 'standard', secret: o.secret ?? VECTOR.secret, raw: Buffer.from(o.raw ?? VECTOR.payload), headers, query: {}, nowSec: o.nowSec ?? VECTOR.ts });
const vectorHeaders = (over: Record<string, string> = {}) => ({ 'webhook-id': VECTOR.id, 'webhook-timestamp': String(VECTOR.ts), 'webhook-signature': VECTOR.signature, ...over });

test('standard webhooks: the spec example signs and verifies; tampering, replays and missing headers are refused', () => {
  assert.ok(WEBHOOK_PRESETS.some((p) => p.id === 'standard' && !p.generatesSecret), 'preset listed; the sender makes the secret');
  assert.equal(standardSignature(VECTOR.secret, VECTOR.id, VECTOR.ts, Buffer.from(VECTOR.payload)), VECTOR.signature);
  assert.equal(verify(vectorHeaders()), null);
  // One to several space-separated signatures (key rotation at the sender): one valid one is enough.
  assert.equal(verify(vectorHeaders({ 'webhook-signature': `v1,Zm91dA== v1a,bm9wZQ== ${VECTOR.signature}` })), null);
  // Svix sends the same headers with the svix- prefix.
  assert.equal(verify({ 'svix-id': VECTOR.id, 'svix-timestamp': String(VECTOR.ts), 'svix-signature': VECTOR.signature }), null);
  // The whole secret as UTF-8 key, as some senders use it.
  const utf8 = 'v1,' + crypto.createHmac('sha256', 'whsec_eigen-afzender-geheim').update(`${VECTOR.id}.${VECTOR.ts}.${VECTOR.payload}`).digest('base64');
  assert.equal(verify(vectorHeaders({ 'webhook-signature': utf8 }), { secret: 'whsec_eigen-afzender-geheim' }), null);

  assert.equal(verify(vectorHeaders(), { raw: '{"test": 2432232315}' }), 'Onjuiste handtekening', 'other body');
  assert.equal(verify(vectorHeaders({ 'webhook-id': 'msg_ander' })), 'Onjuiste handtekening', 'other id');
  assert.equal(verify(vectorHeaders(), { secret: 'whsec_' + Buffer.alloc(24, 7).toString('base64') }), 'Onjuiste handtekening', 'other secret');
  assert.equal(verify(vectorHeaders({ 'webhook-signature': VECTOR.signature.replace('v1,', 'v2,') })), 'Onjuiste handtekening', 'unknown version');
  assert.match(verify(vectorHeaders(), { nowSec: VECTOR.ts + 301 })!, /replay/);
  assert.match(verify(vectorHeaders(), { nowSec: VECTOR.ts - 301 })!, /replay/, 'from the future');
  assert.equal(verify(vectorHeaders(), { nowSec: VECTOR.ts + 299 }), null, 'within 5 minutes');
  assert.match(verify({ 'webhook-id': VECTOR.id, 'webhook-timestamp': String(VECTOR.ts) })!, /ontbreekt/);
  assert.equal(verify(vectorHeaders({ 'webhook-timestamp': '1614265330.5' })), 'Ongeldige webhook-timestamp');
  assert.equal(verify(vectorHeaders({ 'webhook-id': 'msg met spatie' })), 'Ongeldige webhook-id');

  // Dedupe on webhook-id, event type from the body.
  const d = describeDelivery('standard', { 'webhook-id': 'msg_1' }, { type: 'user.created', data: {} }, Buffer.from(''));
  assert.deepEqual(d, { event: 'user.created', deliveryId: 'msg_1' });
});

test('standard webhooks: asymmetric v1a (ed25519) with the sender’s public key; a secret key is refused', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const whpk = 'whpk_' + raw.toString('base64');
  const sign = (body: string) => 'v1a,' + crypto.sign(null, Buffer.from(`${VECTOR.id}.${VECTOR.ts}.${body}`), privateKey).toString('base64');
  assert.equal(verify(vectorHeaders({ 'webhook-signature': sign(VECTOR.payload) }), { secret: whpk }), null);
  assert.equal(verify(vectorHeaders({ 'webhook-signature': sign('{"anders":1}') }), { secret: whpk }), 'Onjuiste handtekening');
  // A symmetric v1 signature never passes for a public key (and the other way round).
  assert.equal(verify(vectorHeaders(), { secret: whpk }), 'Onjuiste handtekening');
  assert.equal(checkPresetSecret('standard', whpk), null);
  assert.match(checkPresetSecret('standard', 'whsk_' + raw.toString('base64'))!, /publieke sleutel/);
  assert.match(checkPresetSecret('standard', 'whpk_kort')!, /niet geldig/);
  assert.equal(checkPresetSecret('stripe', 'whsk_iets'), null, 'other presets unchanged');
});

interface Env {
  t: TestApp;
  engine: RoutineEngine;
  clock: { now: number };
}
async function hook(env: Env, id: string, body: string, headers: Record<string, string>) {
  const res = await fetch(`${env.t.app.url}/api/public/hooks/${id}`, { method: 'POST', headers, body });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

test('standard webhooks over HTTP: a routine starts once per webhook-id, a wrong signature is refused, the test payload works', async () => {
  const clock = { now: Date.parse('2026-11-09T07:00:00Z') };
  const t = await startTestApp({ modules: [createRoutinesModule({ clock: () => clock.now, tickMs: 0 })] });
  const env: Env = { t, engine: t.app.ctx.services.routines.engine, clock };
  try {
    const a = await t.agent();
    const r = await t.api('POST', '/routines', { name: 'Nieuwe klant', agent_id: a.id, prompt: 'Heet de nieuwe klant welkom.', timezone: 'Europe/Amsterdam', schedule: { kind: 'none' } });
    // A secret key of the sender is refused before anything is made.
    const wrong = await fetch(`${t.app.url}/api/routines/${r.id}/triggers`, { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'webhook', preset: 'standard', secret: 'whsk_' + Buffer.alloc(32, 1).toString('base64') }) });
    assert.equal(wrong.status, 400);
    assert.equal(t.app.ctx.store.all('SELECT id FROM routine_triggers').length, 0);

    const secret = 'whsec_' + crypto.randomBytes(24).toString('base64');
    const created = await t.api('POST', `/routines/${r.id}/triggers`, { kind: 'webhook', preset: 'standard', secret });
    assert.equal(created.secret, undefined, 'the sender’s secret is never sent back');
    assert.equal(created.trigger.preset, 'standard');
    const trg = created.trigger;
    const nowSec = () => Math.floor(clock.now / 1000);
    const body = JSON.stringify({ type: 'user.created', timestamp: '2026-11-09T07:00:00Z', data: { email: 'klant@example.com' } });
    const headers = (id: string, o: { ts?: number; key?: string } = {}) => {
      const ts = o.ts ?? nowSec();
      return { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': standardSignature(o.key ?? secret, id, ts, Buffer.from(body)) };
    };

    assert.equal((await hook(env, trg.id, body, headers('msg_1', { key: 'whsec_' + crypto.randomBytes(24).toString('base64') }))).status, 401);
    assert.equal((await hook(env, trg.id, body, headers('msg_1', { ts: nowSec() - 600 }))).status, 401);
    t.script.push({ text: 'Welkom gestuurd' });
    assert.equal((await hook(env, trg.id, body, headers('msg_1'))).status, 202);
    await env.engine.idle();
    // A retry has the same webhook-id with a new timestamp and signature: no second run.
    clock.now += 30_000;
    const again = await hook(env, trg.id, body, headers('msg_1'));
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    const runs = t.app.ctx.store.all<any>('SELECT * FROM routine_runs WHERE routine_id = ?', r.id);
    assert.equal(runs.length, 1);
    const events = await t.api('GET', `/routines/triggers/${trg.id}/events`);
    assert.ok(events.some((e: any) => e.status === 'accepted' && /user\.created/.test(`${e.event} ${e.summary || ''}`)), 'event type from the body');
    assert.ok(events.some((e: any) => e.status === 'rejected'));
    assert.ok(events.some((e: any) => e.status === 'duplicate'));

    // "Testpayload sturen" signs with the stored secret and goes through the same check.
    t.script.push({ text: 'test ontvangen' });
    const test = await t.api('POST', `/routines/triggers/${trg.id}/test`, { payload: '{"type":"teambot.test"}' });
    assert.equal(test.status, 202);
    await env.engine.idle();

    // With the sender's public key TeamBot cannot sign a test itself, and says so.
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const whpk = 'whpk_' + Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('base64');
    await t.api('PUT', `/routines/triggers/${trg.id}/secret`, { value: whpk });
    const res = await fetch(`${t.app.url}/api/routines/triggers/${trg.id}/test`, { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as any).error, /publieke sleutel/);
    // The secret never shows up in the trigger view, the events or the audit log.
    const view = JSON.stringify(await t.api('GET', `/routines/triggers/${trg.id}`)) + JSON.stringify(events) + JSON.stringify(t.app.ctx.store.all('SELECT data FROM audit'));
    assert.ok(!view.includes(secret.slice(6, 30)) && !view.includes(whpk.slice(5, 30)));
  } finally {
    await t.close();
  }
});
