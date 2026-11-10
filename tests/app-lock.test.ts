import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FREE_TRIES, hashPin, registerFailure, shouldLockAfterHidden, triesLeft, userVerified, validPin, verifyPin, waitMs } from '../ui/src/shell/lockCore.js';

/** App lock on this device (A-91): PIN hash, lock delay, back-off after wrong tries, WebAuthn user verification. */

test('PIN: only 4-8 digits; stored as a salted hash that verifies only the right PIN', async () => {
  assert.equal(validPin('123'), false);
  assert.equal(validPin('1234'), true);
  assert.equal(validPin('12345678'), true);
  assert.equal(validPin('123456789'), false);
  assert.equal(validPin('12a4'), false);
  await assert.rejects(() => hashPin('12'));

  const a = await hashPin('482915', 1000);
  const b = await hashPin('482915', 1000);
  assert.equal(a.length, 6);
  assert.notEqual(a.salt, b.salt, 'a fresh salt each time');
  assert.notEqual(a.hash, b.hash);
  assert.ok(!JSON.stringify(a).includes('482915'), 'the PIN itself is never stored');
  assert.equal(await verifyPin('482915', a), true);
  assert.equal(await verifyPin('482916', a), false);
  assert.equal(await verifyPin('48291', a), false);
  assert.equal(await verifyPin('', a), false);
});

test('locks again after the chosen time in the background', () => {
  const t0 = 1_000_000;
  assert.equal(shouldLockAfterHidden(0, null, t0), false, 'never hidden: no lock');
  assert.equal(shouldLockAfterHidden(0, t0, t0 + 10), true, '"meteen": any time away locks');
  assert.equal(shouldLockAfterHidden(1, t0, t0 + 59_000), false);
  assert.equal(shouldLockAfterHidden(1, t0, t0 + 60_000), true);
  assert.equal(shouldLockAfterHidden(15, t0, t0 + 14 * 60_000), false);
  assert.equal(shouldLockAfterHidden(15, t0, t0 + 15 * 60_000), true);
});

test('after 5 wrong tries a short pause that grows, at most 5 minutes', () => {
  const now = 5_000_000;
  let s = { fails: 0, until: 0 };
  for (let i = 1; i < FREE_TRIES; i++) {
    s = registerFailure(s, now);
    assert.equal(waitMs(s, now), 0, `try ${i}: no pause yet`);
    assert.equal(triesLeft(s), FREE_TRIES - i);
  }
  s = registerFailure(s, now);
  assert.equal(waitMs(s, now), 30_000, 'fifth wrong try: 30 s');
  assert.equal(waitMs(s, now + 30_000), 0);
  s = registerFailure(s, now);
  assert.equal(waitMs(s, now), 60_000, 'then 60 s');
  for (let i = 0; i < 10; i++) s = registerFailure(s, now);
  assert.equal(waitMs(s, now), 5 * 60_000, 'never more than 5 minutes');
});

test('WebAuthn: only an assertion with the user-verified flag unlocks', () => {
  const data = new Uint8Array(37);
  data[32] = 0x01; // user present only
  assert.equal(userVerified(data), false);
  data[32] = 0x05; // present + verified
  assert.equal(userVerified(data), true);
  assert.equal(userVerified(new Uint8Array(10)), false);
});
