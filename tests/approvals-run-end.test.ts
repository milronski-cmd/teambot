import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * An approval (or question) belongs to the run that asked it. When that run ends for good (done, error, cancelled)
 * without the owner deciding, the card must leave "Wacht op jou": status 'expired' plus an approval.updated event.
 * An interrupted run (crash/restart) is the exception: its approval stays open so deciding it can resume the work.
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

/** A pending approval row for `runId`, as one left behind by a run that moved on or ended without it being answered. */
function openApproval(t: TestApp, threadId: string, agentId: string, runId: string, id: string) {
  const ctx = t.app.ctx;
  const th = ctx.store.thread(threadId)!;
  ctx.store.insert('approvals', {
    id,
    user_id: th.user_id,
    agent_id: agentId,
    thread_id: threadId,
    run_id: runId,
    kind: 'tool',
    tool: 'write_file',
    input: { path: 'x.txt', content: 'x' },
    summary: 'Schrijf x.txt',
    risk: 'danger',
    options: null,
    status: 'pending',
    created_at: new Date().toISOString(),
  });
}

test('an open approval expires, with an approval.updated event, as soon as its run ends', async () => {
  const t = await startTestApp();
  try {
    const bot = await t.agent({ name: 'Klusser' });
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    const updates: any[] = [];
    t.app.ctx.events.on('approval.updated', (e) => updates.push(e.data));
    // While the run is busy, an approval of this run is left open.
    t.script.push({
      text: 'Klaar.',
      check: () => {
        const run = t.app.ctx.store.one<any>("SELECT id FROM runs WHERE thread_id = ? AND status = 'running'", th.id);
        openApproval(t, th.id, bot.id, run.id, 'apr_test_run_end');
      },
    });
    await t.say(th.id, 'Doe iets');
    await t.waitIdle(th.id);
    const run = t.app.ctx.store.one<any>('SELECT id, status FROM runs WHERE thread_id = ?', th.id);
    assert.equal(run.status, 'done');
    const apr = t.app.ctx.store.get<any>('approvals', 'apr_test_run_end');
    assert.equal(apr.status, 'expired');
    assert.ok(apr.decided_at, 'decided_at is set');
    const ev = await until(() => updates.find((u) => u.id === 'apr_test_run_end'));
    assert.equal(ev.status, 'expired');
    // The card is gone from the list the app shows under "Wacht op jou".
    const open = await t.api('GET', '/approvals');
    assert.equal(open.filter((a: any) => a.id === 'apr_test_run_end').length, 0);
  } finally {
    await t.close();
  }
});

test('also when the run fails: the open approval expires', async () => {
  const t = await startTestApp();
  try {
    const bot = await t.agent({ name: 'Klusser' });
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    t.script.push({
      error: { message: 'kapot', status: 400 },
      check: () => {
        const run = t.app.ctx.store.one<any>("SELECT id FROM runs WHERE thread_id = ? AND status = 'running'", th.id);
        openApproval(t, th.id, bot.id, run.id, 'apr_test_run_error');
      },
    });
    await t.say(th.id, 'Doe iets').catch(() => {});
    await t.waitIdle(th.id);
    assert.equal(t.app.ctx.store.one<any>('SELECT status FROM runs WHERE thread_id = ?', th.id).status, 'error');
    assert.equal(t.app.ctx.store.get<any>('approvals', 'apr_test_run_error').status, 'expired');
  } finally {
    await t.close();
  }
});

test('expireForRun leaves approvals of an interrupted run (crash recovery) and of other runs alone', async () => {
  const t = await startTestApp();
  try {
    const bot = await t.agent({ name: 'Klusser' });
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    await t.say(th.id, 'Eerste beurt');
    const run = t.app.ctx.store.one<any>('SELECT id FROM runs WHERE thread_id = ?', th.id);
    const ctx = t.app.ctx;
    openApproval(t, th.id, bot.id, run.id, 'apr_test_interrupted');
    ctx.store.updateRun(run.id, { status: 'interrupted' });
    ctx.store.update('approvals', 'apr_test_interrupted', { interrupted_at: new Date().toISOString() });
    assert.equal(ctx.broker.expireForRun(run.id), 0);
    assert.equal(ctx.store.get<any>('approvals', 'apr_test_interrupted').status, 'pending');
    // A run that is still going is not touched either.
    ctx.store.updateRun(run.id, { status: 'running' });
    assert.equal(ctx.broker.expireForRun(run.id), 0);
    assert.equal(ctx.store.get<any>('approvals', 'apr_test_interrupted').status, 'pending');
    // Once it really ends, it expires.
    ctx.store.updateRun(run.id, { status: 'cancelled', finished_at: new Date().toISOString() });
    assert.equal(ctx.broker.expireForRun(run.id), 1);
    assert.equal(ctx.store.get<any>('approvals', 'apr_test_interrupted').status, 'expired');
  } finally {
    await t.close();
  }
});
