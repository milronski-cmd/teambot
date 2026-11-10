import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_RESERVES, reservesPatch } from '../ui/src/pages/agentReserves.js';
import { MAX_FALLBACKS } from '../server/agent/fallback.js';

/** Parity 0.4.2: the bot editor keeps all five reserve engines (OpenBot: an ordered list; the editor cut it to three). */

test('the editor offers as many reserves as the server accepts', () => {
  assert.equal(MAX_RESERVES, MAX_FALLBACKS);
  assert.equal(MAX_RESERVES, 5);
});

test('a fourth and fifth reserve are kept, in order; the first is also the legacy fallback', () => {
  const list = ['a', 'b', 'c', 'd', 'e'].map((p) => ({ provider_id: `prv_${p}`, model: '' }));
  const patch = reservesPatch({ onLimit: 'fallback' }, list);
  assert.deepEqual(patch.settings.fallbacks.map((r: any) => r.provider_id), ['prv_a', 'prv_b', 'prv_c', 'prv_d', 'prv_e']);
  assert.equal(patch.settings.onLimit, 'fallback', 'other settings stay');
  assert.deepEqual(patch.fallback, { provider_id: 'prv_a', model: '' });
});

test('more than five or empty slots: at most five, empty ones dropped; no reserves = no fallback', () => {
  const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((p) => ({ provider_id: `prv_${p}`, model: 'm' }));
  assert.equal(reservesPatch(undefined, six).settings.fallbacks.length, 5);
  assert.deepEqual(reservesPatch(undefined, [{ provider_id: '', model: '' }, { provider_id: 'prv_x', model: '' }]).settings.fallbacks, [{ provider_id: 'prv_x', model: '' }]);
  assert.equal(reservesPatch({}, []).fallback, null);
});
