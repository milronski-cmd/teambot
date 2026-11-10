// "Netwerkadressen" only when TeamBot listens beyond this computer (practice test 0.4.4: the desktop app listed
// http://192.168.x.x:4747, which opens nowhere because it listens on 127.0.0.1 only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shownLanUrls } from '../ui/src/pages/lanUrls.js';

test('network addresses are shown only when they can be opened', () => {
  const lanUrls = ['http://192.168.1.20:4747', 'http://100.84.0.1:4747'];
  for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.0.0.2']) assert.deepEqual(shownLanUrls({ host, lanUrls }), [], host);
  for (const host of ['0.0.0.0', '::', '192.168.1.20']) assert.deepEqual(shownLanUrls({ host, lanUrls }), lanUrls, host);
  assert.deepEqual(shownLanUrls({ host: '0.0.0.0' }), []);
  // A member gets neither (no host, no addresses).
  assert.deepEqual(shownLanUrls({}), []);
});
