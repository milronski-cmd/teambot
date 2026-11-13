/**
 * One setting per thing (duplication audit, 12 nov): where two values said the same thing, there is one now.
 *  - "Standaardmodel": the default model of the default AI connection; the choice under Instellingen is written there;
 *  - the loop guard: the bot editor shows the server's real defaults (shared/loopGuard.ts);
 *  - the step limit of a CLI bot: the lower of its own limit and the one a routine sets for its run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent } from '../server/core/types.js';
import { startTestApp } from './helpers.js';
import { loopLimits } from '../server/agent/loops.js';
import { applyRunOverride } from '../server/agent/runner.js';
import { cliOptions } from '../server/modules/cli-agents/context.js';
import { LOOP_DEFAULTS, LOOP_RANGE } from '../shared/loopGuard.js';

test('one default model: a choice under Instellingen is the connection’s default model, and both screens read the same value', async () => {
  const t = await startTestApp();
  try {
    const ctx = t.app.ctx;
    const userId = ctx.auth.owner()!.id;
    const own = () => ctx.store.getSetting<string>(userId, 'defaultModel', '');
    const conn = () => ctx.providers.config(t.providerId)!.config?.defaultModel;
    await t.api('PUT', '/settings', { defaultProvider: t.providerId, defaultModel: '' });
    assert.equal((await t.api('GET', '/settings')).defaultModel, conn() || '', 'nothing chosen: the connection’s own');

    const s = await t.api('PUT', '/settings', { defaultModel: 'mock-2' });
    assert.deepEqual([s.defaultModel, conn(), own()], ['mock-2', 'mock-2', ''], 'written to the connection, no second value kept');
    assert.equal((await t.api('GET', '/settings')).defaultModel, 'mock-2');
    // "Als standaard" on the connection's card sends the connection's own model: the same value, nothing new.
    await t.api('PUT', '/settings', { defaultProvider: t.providerId, defaultModel: 'mock-2' });
    assert.deepEqual([conn(), own()], ['mock-2', '']);
    // A value an older version stored keeps working until the next choice, and is then folded in.
    ctx.store.setSetting(userId, 'defaultModel', 'mock-oud');
    assert.equal((await t.api('GET', '/settings')).defaultModel, 'mock-oud');
    await t.api('PUT', '/settings', { defaultModel: 'mock-3' });
    assert.deepEqual([conn(), own()], ['mock-3', '']);
    // Keys that were stored and read nowhere are no longer stored.
    await t.api('PUT', '/settings', { theme: 'dark', onboarded: true });
    assert.deepEqual([ctx.store.getSetting(userId, 'theme', null), ctx.store.getSetting(userId, 'onboarded', null)], [null, null]);
  } finally {
    await t.close();
  }
});

test('the loop guard has one set of defaults, and a CLI bot’s step limit is the lower of its own and the routine’s', () => {
  const bot = (settings: any, access_mode = 'auto') => ({ id: 'a', name: 'Bot', access_mode, settings, tool_policy: {}, tool_groups: [] }) as unknown as Agent;
  assert.deepEqual(loopLimits(bot({})), { ...LOOP_DEFAULTS });
  assert.deepEqual(loopLimits(bot({ quality: { loopGuard: { on: true } } })), { ...LOOP_DEFAULTS }, 'switched on in the editor without numbers: still the defaults');
  assert.deepEqual(loopLimits(bot({ quality: { loopGuard: { repeat: 1, idle: 5000 } } })), { repeat: LOOP_RANGE.repeat[0], idle: LOOP_RANGE.idle[1] });

  assert.equal(cliOptions(bot({ cli: { maxTurns: 200 } })).maxTurns, 200);
  assert.equal(cliOptions(bot({ maxTurns: 15 })).maxTurns, 15);
  assert.equal(cliOptions(bot({ cli: { maxTurns: 200 }, maxTurns: 15 })).maxTurns, 15, 'the lower one');
  assert.equal(cliOptions(bot({ cli: { maxTurns: 10 }, maxTurns: 15 })).maxTurns, 10);
  // A routine's own limit for its run (runner.ts) holds for a CLI bot with a higher limit of its own.
  assert.equal(cliOptions(applyRunOverride(bot({ cli: { maxTurns: 200 } }), { max_turns: 5 })).maxTurns, 5);
  assert.equal(cliOptions(applyRunOverride(bot({ cli: { maxTurns: 3 } }), { max_turns: 5 })).maxTurns, 3);
});
