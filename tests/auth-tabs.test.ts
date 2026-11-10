// The start screen without a session (practice test 0.4.4): a phone that opens the desktop app's address saw
// "Inloggen" with e-mail and password first (the desktop owner has neither) and "Account maken" (never possible there).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authTabs } from '../ui/src/shell/authTabs.js';

test('desktop app: pairing first, no sign-up; a server: log in first', () => {
  assert.deepEqual(authTabs({ mode: 'desktop', allowSignup: false }), { tabs: ['pair', 'login'], shown: 'pair' });
  assert.equal(authTabs({ mode: 'desktop', allowSignup: false }, { chosen: 'login' }).shown, 'login', 'the owner can still pick Inloggen');
  assert.equal(authTabs({ mode: 'desktop', allowSignup: false }, { chosen: 'signup' }).shown, 'pair', 'an invite link on the desktop app shows pairing');
  assert.deepEqual(authTabs({ mode: 'server', allowSignup: false }), { tabs: ['login', 'signup', 'pair'], shown: 'login' });
  assert.equal(authTabs({ mode: 'server' }, { chosen: 'signup' }).shown, 'signup', 'an invite link opens Account maken');
  assert.equal(authTabs({ mode: 'server' }, { chosen: 'pair' }).shown, 'pair');
  // SSO required: no password accounts are made here.
  assert.deepEqual(authTabs({ mode: 'server' }, { ssoOnly: true, chosen: 'signup' }), { tabs: ['login', 'pair'], shown: 'login' });
  // Before the status is known: the server layout (nothing is hidden that might be needed).
  assert.equal(authTabs(null).shown, 'login');
});
