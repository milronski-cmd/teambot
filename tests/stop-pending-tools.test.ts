// Stop while the bot works through several tool calls of one step: the calls that never started must not stay
// "pending" (the chat shows a pending call without a result as still running, for ever).
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

test('stop during the first of three tool calls: the other two are closed, each with a result', async () => {
  const t = await startTestApp();
  try {
    const a = await t.api('POST', '/agents', { name: 'Ada', provider_id: t.providerId, model: 'mock', access_mode: 'auto' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({
      toolCalls: [
        { name: 'ask_user', args: { question: 'Welke map?' } },
        { name: 'list_files', args: {} },
        { name: 'list_files', args: { path: '.' } },
      ],
    });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'ruim op' });
    await until(async () => (await t.api('GET', '/approvals')).some((x: any) => x.kind === 'question'));
    await t.api('POST', `/threads/${th.id}/stop`);
    await until(() => !t.app.ctx.runs.activeRuns().length);
    const rows = t.app.ctx.store.messages(th.id, { limit: 50 });
    const calls = rows.find((m) => m.parts?.toolCalls?.length)!.parts.toolCalls!;
    assert.equal(calls.length, 3);
    assert.ok(calls.every((c) => c.status !== 'pending' && c.status !== 'running'), `no call left open: ${calls.map((c) => c.status).join(', ')}`);
    const results = rows.filter((m) => m.role === 'tool').map((m) => m.parts.toolResult!.toolCallId);
    assert.deepEqual(results.sort(), calls.map((c) => c.id).sort(), 'every call has its result');
    assert.match(rows.find((m) => m.parts?.toolResult?.toolCallId === calls[2].id)!.content, /Onderbroken/);
  } finally {
    await t.close();
  }
});
