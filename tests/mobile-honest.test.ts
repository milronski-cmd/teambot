// What the phone pages say is true and sends nobody down a dead end. Notifications in the iPhone app go through Apple
// (APNs) with a key that belongs with the app, from whoever ships it: a user never needs an Apple account of their own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Apns } from '../server/modules/mobile/apns.js';

test('iPhone-app notifications without a key: no Apple account or key asked of the user', () => {
  for (const k of ['TEAMBOT_APNS_KEY_FILE', 'TEAMBOT_APNS_KEY_ID', 'TEAMBOT_APNS_TEAM_ID']) delete process.env[k];
  const s = new Apns({} as any).status();
  assert.equal(s.configured, false);
  assert.doesNotMatch(s.detail, /Developer|account|\.p8/i, s.detail);
  assert.match(s.detail, /nog niet actief.*hoeft niets te doen/, s.detail);
});
