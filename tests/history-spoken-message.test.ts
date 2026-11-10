// A message TeamBot puts in the chat in the bot's name without a model call (the daily overview, a reminder) while
// that bot's tool call waits for approval. Live in 0.4.4: the result of the approved call was dropped as "Onderbroken"
// and the conversation ended on the bot's own words, which Anthropic refuses (400, "must end with a user message").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { toAnthropicMessages } from '../server/providers/anthropic.js';

const until = async (fn: () => any, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 30));
  }
};

test('an overview posted while a tool call waits for approval does not cut the call off from its result', async () => {
  const t = await startTestApp();
  try {
    const a = await t.api('POST', '/agents', { name: 'Ada', provider_id: t.providerId, model: 'mock', access_mode: 'auto' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ toolCalls: [{ name: 'ask_user', args: { question: 'Welke map?' } }] }, { text: 'Klaar.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'ruim op' });
    const ask = await until(async () => (await t.api('GET', '/approvals')).find((x: any) => x.kind === 'question'));
    const ctx = t.app.ctx;
    ctx.chat.addAgentMessage(ctx.store.thread(th.id)!, ctx.store.agent(a.id)!, 'Overzicht: 1 toestemming wacht op jou');
    await t.api('POST', `/approvals/${ask.id}`, { decision: 'approve', answer: 'De map Documenten' });
    await until(() => !ctx.runs.activeRuns().length);

    assert.equal(t.requests.length, 2, 'the model was called again after the answer');
    const msgs = t.requests[1].messages;
    const call = msgs.find((m) => m.role === 'assistant' && m.toolCalls?.length)!;
    const result = msgs.find((m) => m.role === 'tool' && m.toolCallId === call.toolCalls![0].id)!;
    assert.ok(result, 'the call has its result');
    assert.doesNotMatch(String(result.content), /Onderbroken/, 'the real result, not a made-up interruption');
    assert.match(String(result.content), /Documenten/);
    assert.notEqual(msgs.at(-1)!.role, 'assistant', 'the conversation does not end on the bot\'s own words');
    const note = msgs.find((m) => m.role === 'user' && /Overzicht: 1 toestemming/.test(String(m.content)));
    assert.ok(note, 'the overview is still there, as a note');
    assert.ok(msgs.indexOf(note!) > msgs.indexOf(result), 'after the result');
    assert.equal(toAnthropicMessages(msgs, false).at(-1).role, 'user');
    const last = ctx.store.messages(th.id, { limit: 50 }).at(-1)!;
    assert.equal(last.status, 'done');
    assert.equal(last.content, 'Klaar.');
  } finally {
    await t.close();
  }
});

test('an overview as the last message: a retry still ends on a user turn', async () => {
  const t = await startTestApp();
  try {
    const a = await t.api('POST', '/agents', { name: 'Ada', provider_id: t.providerId, model: 'mock', access_mode: 'auto' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const ctx = t.app.ctx;
    t.script.push({ text: 'Hallo.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'hoi' });
    await until(() => t.requests.length === 1 && !ctx.runs.activeRuns().length);
    ctx.chat.addAgentMessage(ctx.store.thread(th.id)!, ctx.store.agent(a.id)!, 'Herinnering: bel de leverancier');
    const user = ctx.store.messages(th.id, { limit: 50 }).find((m) => m.role === 'user')!;
    t.script.push({ text: 'Goed.' });
    ctx.chat.startAgent(ctx.store.thread(th.id)!, a.id, user.id, 'resume');
    await until(() => t.requests.length === 2 && !ctx.runs.activeRuns().length);
    const msgs = t.requests[1].messages;
    assert.equal(msgs.at(-1)!.role, 'user');
    assert.match(String(msgs.at(-1)!.content), /Herinnering: bel de leverancier/);
  } finally {
    await t.close();
  }
});
