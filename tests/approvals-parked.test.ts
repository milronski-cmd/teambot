import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp } from './helpers.js';
import { PARKED_TEXT } from '../server/tools/broker.js';

/**
 * A bot does not stand still for its owner. A request he has not answered after a short while is parked: the card
 * stays open for him, the bot hears that it must go on with its other work, and when he decides later the bot gets a
 * turn for exactly that (the identical request then passes once without a second card).
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => T | Promise<T>, ms = 8000): Promise<NonNullable<T>> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    await sleep(20);
  }
  throw new Error('condition not met in time');
}

test('an unanswered request is parked: the bot works on, the card stays, and the later decision reaches the bot', async () => {
  const t = await startTestApp();
  try {
    const ctx = t.app.ctx;
    ctx.broker.parkMs = 60;
    const bot = await t.agent({ name: 'Klusser', access_mode: 'ask', tool_groups: ['files'] });
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    const ws = ctx.store.agent(bot.id)!.workspace;
    fs.mkdirSync(ws, { recursive: true });
    const write = { name: 'write_file', args: { path: 'notitie.txt', content: 'hallo' } };

    // 1. The bot asks, nobody answers: it is told to go on, and its turn ends normally.
    t.script.push({ toolCalls: [write] }, { text: 'Ik ga door met de rest.' });
    await t.say(th.id, 'Schrijf een notitie en doe daarna de rest');
    await t.waitIdle(th.id);
    const first = ctx.store.one<any>('SELECT * FROM runs WHERE thread_id = ? ORDER BY created_at LIMIT 1', th.id);
    assert.equal(first.status, 'done', 'the turn went on and ended');
    const told = ctx.store.all<any>("SELECT content FROM messages WHERE thread_id = ? AND role = 'tool'", th.id).map((m) => m.content).join('\n');
    assert.ok(told.includes(PARKED_TEXT), 'the bot heard that the request waits for its owner');
    assert.ok(!fs.existsSync(path.join(ws, 'notitie.txt')), 'nothing was written without his yes');
    let open = (await t.api('GET', '/approvals')).filter((a: any) => a.tool === 'write_file');
    assert.equal(open.length, 1, 'the card is still there for the owner after the turn ended');
    assert.ok(open[0].parked_at && open[0].status === 'pending');

    // 2. Asking the very same thing again makes no second card and no second wait.
    t.script.push({ toolCalls: [write] }, { text: 'Wacht nog.' });
    await t.say(th.id, 'Probeer het nog eens');
    await t.waitIdle(th.id);
    open = (await t.api('GET', '/approvals')).filter((a: any) => a.tool === 'write_file');
    assert.equal(open.length, 1, 'still one card');

    // 3. A restart keeps it: it is the owner's.
    ctx.broker.expireStale();
    assert.equal(ctx.store.get<any>('approvals', open[0].id).status, 'pending');

    // 4. He allows it later: the bot gets a turn for it, and the same request passes without a new card.
    t.script.push({ toolCalls: [write] }, { text: 'Notitie geschreven.' });
    await t.api('POST', `/approvals/${open[0].id}`, { decision: 'approve' });
    await until(() => fs.existsSync(path.join(ws, 'notitie.txt')));
    await t.waitIdle(th.id);
    const resumed = ctx.store.one<any>("SELECT * FROM runs WHERE thread_id = ? AND trigger = 'resume'", th.id);
    assert.equal(resumed?.status, 'done', 'a turn of its own for the decision');
    assert.match(ctx.store.message(resumed.input_message_id)!.content, /gaf toestemming voor wat je eerder vroeg/);
    assert.equal((await t.api('GET', '/approvals')).length, 0, 'nothing waits any more');
  } finally {
    await t.close();
  }
});

test('answered in time: nothing is parked', async () => {
  const t = await startTestApp();
  try {
    const ctx = t.app.ctx;
    ctx.broker.parkMs = 5000;
    const bot = await t.agent({ name: 'Klusser', access_mode: 'ask', tool_groups: ['files'] });
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    const ws = ctx.store.agent(bot.id)!.workspace;
    fs.mkdirSync(ws, { recursive: true });
    t.script.push({ toolCalls: [{ name: 'write_file', args: { path: 'a.txt', content: 'a' } }] }, { text: 'Klaar.' });
    const said = t.say(th.id, 'Schrijf a.txt');
    const card = await until(async () => (await t.api('GET', '/approvals'))[0]);
    await t.api('POST', `/approvals/${card.id}`, { decision: 'approve' });
    await said;
    await t.waitIdle(th.id);
    assert.ok(fs.existsSync(path.join(ws, 'a.txt')));
    assert.equal(ctx.store.get<any>('approvals', card.id).parked_at ?? null, null);
  } finally {
    await t.close();
  }
});
