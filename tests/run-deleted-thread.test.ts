// A conversation (or its bot) deleted while the bot is still working in it: the run's row is gone when the run ends.
// The end of a run must still tell whoever waits for it and start the next queued run, without an unhandled error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';

const until = async (fn: () => any, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 30));
  }
};

test('deleting a conversation while its bot waits for an answer ends the run cleanly', async () => {
  const t = await startTestApp();
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const a = await t.api('POST', '/agents', { name: 'Ada', provider_id: t.providerId, model: 'mock', access_mode: 'auto' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const ctx = t.app.ctx;
    t.script.push({ toolCalls: [{ name: 'ask_user', args: { question: 'Welke map?' } }] });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'ruim op' });
    await until(async () => (await t.api('GET', '/approvals')).some((x: any) => x.kind === 'question'));
    const run = ctx.runs.activeRuns()[0];
    const waited = ctx.runs.waitFor(run.id, 5000);

    await t.api('DELETE', `/threads/${th.id}`);
    const fin = await waited;
    assert.equal(fin.id, run.id);
    assert.equal(fin.status, 'cancelled', 'whoever waited for the run hears that it is over');
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(unhandled.map(String), [], 'no unhandled error');
    assert.equal(ctx.runs.isBusy(th.id, a.id), false);

    // The bot works again in a new conversation.
    const th2 = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: 'Hallo.' });
    await t.api('POST', `/threads/${th2.id}/messages`, { content: 'hoi' });
    await until(() => ctx.store.messages(th2.id, { limit: 10 }).some((m) => m.role === 'assistant' && m.status === 'done'));
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await t.close();
  }
});
