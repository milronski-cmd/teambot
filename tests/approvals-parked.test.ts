import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp } from './helpers.js';
import { PARKED_TEXT, revisedKey } from '../server/tools/broker.js';

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

test('several decisions in a row while the bot is busy: one turn hears them all, not a turn per decision', async () => {
  const t = await startTestApp();
  try {
    const ctx = t.app.ctx;
    ctx.broker.parkMs = 60;
    const bot = await t.agent({ name: 'Klusser', access_mode: 'ask', tool_groups: ['files'] });
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    const ws = ctx.store.agent(bot.id)!.workspace;
    fs.mkdirSync(ws, { recursive: true });
    const write = (n: number) => ({ name: 'write_file', args: { path: `brief-${n}.txt`, content: `brief ${n}` } });
    // Three requests nobody answers: three cards.
    t.script.push({ toolCalls: [write(1)] }, { toolCalls: [write(2)] }, { toolCalls: [write(3)] }, { text: 'Drie brieven wachten op je.' });
    await t.say(th.id, 'Schrijf drie brieven');
    await t.waitIdle(th.id);
    const open = (await t.api('GET', '/approvals')).filter((a: any) => a.tool === 'write_file');
    assert.equal(open.length, 3);
    // The owner says yes to all three, one click after the other. The first starts a turn; the other two arrive while it runs.
    const [a1, a2, a3] = [1, 2, 3].map((n) => open.find((a: any) => String(a.summary).includes(`brief-${n}.txt`)));
    t.script.push({ toolCalls: [write(1)] }, { text: 'Brief 1 geschreven.' }, { toolCalls: [write(2), write(3)] }, { text: 'Brief 2 en 3 geschreven.' });
    const me = ctx.auth.owner()!.id;
    for (const a of [a1, a2, a3]) ctx.broker.resolve(a.id, me, 'approve');
    await until(() => [1, 2, 3].every((n) => fs.existsSync(path.join(ws, `brief-${n}.txt`))));
    await t.waitIdle(th.id);
    const resumes = ctx.store.all<any>("SELECT * FROM runs WHERE thread_id = ? AND trigger = 'resume' ORDER BY created_at, rowid", th.id);
    assert.equal(resumes.length, 2, 'one turn for the first decision, one for the two that came while it ran');
    const second = ctx.store.message(resumes[1].input_message_id)!;
    assert.equal((second.content.match(/gaf toestemming voor wat je eerder vroeg/g) || []).length, 2, 'both decisions in one message');
    assert.equal((second.parts as any).resumedFrom.approvalIds.length, 2);
    assert.equal((await t.api('GET', '/approvals')).length, 0);
  } finally {
    await t.close();
  }
});

test('the same request with its text rewritten replaces the card that waits: one card, the newest version', async () => {
  const mail = (body: string, to = 'jan@example.com') => ({ to, subject: 'Re: Offerte', thread: 't1', body });
  const a = 'Beste Jan, '.padEnd(400, 'a');
  const b = 'Beste Jan, '.padEnd(380, 'b');
  assert.equal(revisedKey(mail(a)), revisedKey(mail(b)));
  assert.notEqual(revisedKey(mail(a)), revisedKey(mail(a, 'piet@example.com')));
  assert.equal(revisedKey({ path: 'a.txt', content: 'kort' }), null, 'no long text: only an identical request is the same');
  assert.equal(revisedKey({ body: a }), null, 'nothing to tell requests apart');

  const t = await startTestApp();
  try {
    const ctx = t.app.ctx;
    ctx.broker.parkMs = 60;
    const bot = await t.agent({ name: 'Klusser', access_mode: 'ask', tool_groups: ['files'] });
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    fs.mkdirSync(ctx.store.agent(bot.id)!.workspace, { recursive: true });
    const write = (content: string, file = 'brief.txt') => ({ name: 'write_file', args: { path: file, content } });
    t.script.push({ toolCalls: [write(a)] }, { text: 'Ik ga door.' });
    await t.say(th.id, 'Schrijf de brief');
    await t.waitIdle(th.id);
    t.script.push({ toolCalls: [write(b)] }, { text: 'Ik ga door.' });
    await t.say(th.id, 'Maak hem iets korter');
    await t.waitIdle(th.id);
    t.script.push({ toolCalls: [write(a, 'andere.txt')] }, { text: 'Ik ga door.' });
    await t.say(th.id, 'En nog een andere brief');
    await t.waitIdle(th.id);
    const open = (await t.api('GET', '/approvals')).filter((x: any) => x.tool === 'write_file');
    assert.deepEqual(open.map((x: any) => [x.input.path, x.input.content.length]).sort(), [['andere.txt', 400], ['brief.txt', 380]]);
    assert.equal(ctx.store.all<any>("SELECT id FROM approvals WHERE status = 'expired'").length, 1, 'the older version lapsed');
  } finally {
    await t.close();
  }
});
