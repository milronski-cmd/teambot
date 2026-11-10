/**
 * A bot's own usage cap (0.4.5): spend or tokens per day or week, on every engine (also a free or subscription one).
 * Reached → the bot pauses with one plain message (the same stop as the daily budget: BudgetError, meta.budget), and
 * works again in the next period. Uses the usage log the runner already writes (server/modules/usage/cap.ts).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockAdapter, startTestApp } from './helpers.js';
import { capOf, periodEnd, periodStart } from '../server/modules/usage/cap.js';

test('capOf and the periods: a day from midnight, a week from Monday', () => {
  assert.equal(capOf({ settings: {} } as any), null);
  assert.equal(capOf({ settings: { usageCap: { kind: 'usd', amount: 0 } } } as any), null, 'zero is no cap');
  assert.equal(capOf({ settings: { usageCap: { kind: 'euro', amount: 3 } } } as any), null);
  assert.deepEqual(capOf({ settings: { usageCap: { kind: 'tokens', amount: '1500.4', period: 'week' } } } as any), { kind: 'tokens', amount: 1500, period: 'week' });
  assert.deepEqual(capOf({ settings: { usageCap: { kind: 'usd', amount: 2.345 } } } as any), { kind: 'usd', amount: 2.35, period: 'day' });
  const wed = new Date(2026, 10, 11, 15, 30); // Wednesday 11 November 2026, 15:30 local
  assert.deepEqual([periodStart('day', wed).getDate(), periodStart('day', wed).getHours()], [11, 0]);
  assert.deepEqual([periodStart('week', wed).getDate(), periodStart('week', wed).getDay()], [9, 1], 'Monday 9 November');
  assert.equal(periodEnd('week', wed).getDate(), 16);
  assert.equal(periodEnd('day', wed).getDate(), 12);
  const sun = new Date(2026, 10, 15, 23, 0);
  assert.equal(periodStart('week', sun).getDate(), 9, 'Sunday still belongs to the week of Monday the 9th');
});

test('a token cap pauses the bot with one plain message, also on a free engine; the next day it works again', async () => {
  const t = await startTestApp();
  try {
    // A free engine: the owner's daily budget never stops it, the bot's own token cap does.
    t.app.ctx.providers.registerKind({ id: 'mockfree', label: 'Gratis (test)', type: 'api', billing: 'free', needsKey: false, description: 'test', models: ['llama'], defaultModel: 'llama', create: () => mockAdapter(t.script, t.requests) });
    const free = await t.api('POST', '/providers', { kind: 'mockfree', name: 'Gratis (test)' });
    const bot = await t.agent({ name: 'Zuinig', provider_id: free.id, model: 'llama', settings: { usageCap: { kind: 'tokens', amount: 20, period: 'day' } } });
    const th = await t.api('POST', '/threads', { agentId: bot.id });

    t.script.push({ text: 'Eén.' }, { text: 'Twee.' });
    await t.say(th.id, 'Hallo'); // 15 tokens (the mock reports 10 in, 5 out)
    await t.say(th.id, 'Nog eens'); // 15 → 30: it was under the cap before the call
    const before = t.requests.length;
    const msgs = await t.say(th.id, 'En nog een keer');
    assert.equal(t.requests.length, before, 'no model call once the cap is reached');
    const stop = msgs.filter((m) => m.role === 'assistant').at(-1)!;
    assert.equal(stop.status, 'error');
    assert.ok(stop.parts.budget?.cap, 'a budget stop of the bot itself');
    assert.equal(stop.parts.budget.cap.agentId, bot.id);
    assert.match(stop.parts.error, /^Zuinig heeft zijn eigen limiet bereikt: vandaag zijn 30 van 20 tokens gebruikt\. Om \d\d:\d\d begint een nieuwe dag en werkt de bot weer\. Wil je eerder verder, verhoog dan de gebruikslimiet in de instellingen van de bot\.$/);
    const run = t.app.ctx.store.run(stop.run_id!)!;
    assert.equal(run.status, 'error');
    assert.ok(run.meta?.budget?.resetAt, 'the bot shows when it works again');

    const status = await t.api('GET', `/usage/bots/${bot.id}/cap`);
    assert.equal(status.reached, true);
    assert.equal(status.used.tokens, 30);
    assert.deepEqual(status.cap, { kind: 'tokens', amount: 20, period: 'day' });

    // The next day: yesterday's usage no longer counts.
    t.app.ctx.store.exec("UPDATE usage_log SET created_at = '2020-01-01T00:00:00.000Z' WHERE agent_id = ?", bot.id);
    t.script.push({ text: 'Weer aan het werk.' });
    const again = await t.say(th.id, 'Nieuwe dag');
    assert.equal(again.filter((m) => m.role === 'assistant').at(-1)!.content, 'Weer aan het werk.');

    // Without a cap nothing changes; another bot is not paused by this one.
    const other = await t.agent({ name: 'Ander', provider_id: free.id, model: 'llama' });
    const th2 = await t.api('POST', '/threads', { agentId: other.id });
    t.script.push({ text: 'Ik werk gewoon.' });
    const o = await t.say(th2.id, 'Hoi');
    assert.equal(o.filter((m) => m.role === 'assistant').at(-1)!.content, 'Ik werk gewoon.');
  } finally {
    await t.close();
  }
});

test('a spend cap per week counts what the bot spent this week (usage log), with the week in the message', async () => {
  const t = await startTestApp();
  try {
    const owner = t.app.ctx.auth.owner()!;
    const bot = await t.agent({ name: 'Inkoper', settings: { usageCap: { kind: 'usd', amount: 0.4, period: 'week' } } });
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    t.app.ctx.store.insert('usage_log', { user_id: owner.id, agent_id: bot.id, provider_id: t.providerId, model: 'mock-1', input: 0, output: 0, cost: 0.5, created_at: new Date().toISOString() });
    const before = t.requests.length;
    const msgs = await t.say(th.id, 'Zoek een leverancier');
    assert.equal(t.requests.length, before);
    const stop = msgs.filter((m) => m.role === 'assistant').at(-1)!;
    assert.match(stop.parts.error, /^Inkoper heeft zijn eigen limiet bereikt: deze week is .*0,50 van .*0,40 gebruikt\. Op maandag \d\d:\d\d begint een nieuwe week en werkt de bot weer\./);
    assert.equal(new Date(stop.parts.budget.resetAt).getDay(), 1, 'Monday');

    // Raised in the bot's settings: it works again at once.
    await t.api('PATCH', `/agents/${bot.id}`, { settings: { usageCap: { kind: 'usd', amount: 5, period: 'week' } } });
    t.script.push({ text: 'Gevonden.' });
    const ok = await t.say(th.id, 'Probeer opnieuw');
    assert.equal(ok.filter((m) => m.role === 'assistant').at(-1)!.content, 'Gevonden.');
    assert.equal((await t.api('GET', `/usage/bots/${bot.id}/cap`)).reached, false);
  } finally {
    await t.close();
  }
});
