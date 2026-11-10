import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeClaim } from '../ui/src/modules/quality/claim.js';

// Practice test 0.4.4: a task the bot reported (waiting for the owner, "Te controleren") said "Schrijver werkt eraan".
test('a task card says "<bot> werkt eraan" only while that bot has not reported the task since it claimed it', () => {
  const claim = { agentId: 'ag_1', name: 'Schrijver', at: '2026-11-09T12:28:37.860Z' };
  assert.deepEqual(activeClaim({ claim, reportedBy: null }), claim, 'claimed, not reported: working on it');
  assert.equal(activeClaim({ claim, reportedBy: { agentId: 'ag_1', name: 'Schrijver', at: '2026-11-09T12:30:12.496Z' } }), null, 'reported after the claim: waits for the owner');
  assert.deepEqual(activeClaim({ claim: { ...claim, at: '2026-11-09T12:40:00.000Z' }, reportedBy: { agentId: 'ag_1', name: 'Schrijver', at: '2026-11-09T12:30:12.496Z' } }), { ...claim, at: '2026-11-09T12:40:00.000Z' }, 'claimed again to fix it: working on it again');
  assert.deepEqual(activeClaim({ claim, reportedBy: { agentId: 'ag_2', name: 'Bo', at: '2026-11-09T12:30:12.496Z' } }), claim, 'another bot reported: the claim still stands');
  assert.equal(activeClaim(null), null);
});
