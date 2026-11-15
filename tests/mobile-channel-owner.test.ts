// 0.4.2: a paired phone manages chat channels, but making someone an owner of a channel (or an owner pairing code)
// hands out access and stays on the computer (server/modules/mobile/policy.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DevicePolicy } from '../server/modules/mobile/policy.js';

const policy = new DevicePolicy({ services: {}, providers: {}, config: {} } as any);
const who = { user: { id: 'u1' }, session: { kind: 'device' } } as any;
const run = (method: string, path: string, body?: any) => {
  try {
    policy.policy({ method, path, body } as any, {} as any, who);
    return 'allowed';
  } catch (e: any) {
    return e?.status === 403 ? 'denied' : `error ${e?.message}`;
  }
};

test('phone: adding a normal channel sender is allowed, making an owner is not', () => {
  assert.equal(run('POST', '/channels/bindings/cb_12ab/senders', { external_id: '316', is_owner: false }), 'allowed');
  assert.equal(run('POST', '/channels/bindings/cb_12ab/senders', { external_id: '316', is_owner: true }), 'denied');
  assert.equal(run('PATCH', '/channels/bindings/cb_12ab/senders/cs_9x', { label: 'Jan' }), 'allowed');
  assert.equal(run('PATCH', '/channels/bindings/cb_12ab/senders/cs_9x', { is_owner: true }), 'denied');
});

test('phone: a normal pairing code is allowed, an owner pairing code is not', () => {
  assert.equal(run('POST', '/channels/bindings/cb_12ab/pair-codes', { label: 'klant' }), 'allowed');
  assert.equal(run('POST', '/channels/bindings/cb_12ab/pair-codes', { owner: true }), 'denied');
});

test('phone: the computer-only list still holds', () => {
  assert.equal(run('GET', '/mobile/devices'), 'denied');
  assert.equal(run('GET', '/Sessions'), 'denied');
  // since 15 nov the owner's phone may do the rest, secrets and admin included
  assert.equal(run('GET', '/secrets'), 'allowed');
  assert.equal(run('GET', '/Admin/Users'), 'allowed');
  assert.equal(run('POST', '/agents', { name: 'x' }), 'allowed');
});

test('phone (15 nov): pairing a new device, other devices and sessions stay on the computer, with a calm reason', () => {
  for (const [method, path] of [
    ['POST', '/mobile/pair'],
    ['POST', '/mobile/devices/dev_x/revoke'],
    ['DELETE', '/sessions/sess_x'],
  ]) {
    try {
      policy.policy({ method, path, body: {} } as any, {} as any, who);
      assert.fail(`${method} ${path} was allowed`);
    } catch (e: any) {
      assert.equal(e?.status, 403);
      assert.equal(e?.code, 'mobile_denied');
      assert.match(e.message, /op je computer/);
    }
  }
  // The phone's own entry and its status stay available; who can reach the computer is the phone's too (15 nov).
  assert.equal(run('GET', '/mobile/devices/self'), 'allowed');
  assert.equal(run('GET', '/mobile/status'), 'allowed');
  assert.equal(run('GET', '/mobile/reachability'), 'allowed');
  assert.equal(run('POST', '/mobile/tailscale-https'), 'allowed');
});
