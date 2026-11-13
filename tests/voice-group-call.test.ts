import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';

// B-56: a group voice call appears in the call history (Instellingen › Spraak) with the group's name and its turns.
test('group voice call: recorded on the group thread, listed with the group name, ended with the number of turns', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ name: 'Assistent' });
    const b = await t.agent({ name: 'Onderzoeker' });
    const room = await t.api('POST', '/rooms', { name: 'Fietsteam', mode: 'lead', agentIds: [a.id, b.id] });
    const threadId = room.thread_id || room.threadId;
    // A call starts only when it can hear you: here the browser's own speech recognition.
    await t.api('PUT', '/voice/settings', { stt: { engine: 'browser' } });
    const call = await t.api('POST', '/voice/calls', { threadId, group: true });
    assert.equal(call.mode, 'group');
    assert.equal(call.thread_id, threadId);
    assert.ok([a.id, b.id].includes(call.agent_id), 'a bot of the group is the call bot');
    const ended = await t.api('POST', `/voice/calls/${call.id}/end`, { turns: 2 });
    assert.equal(ended.status, 'ended');
    assert.equal(ended.asks, 2);
    const list = await t.api('GET', '/voice/calls');
    assert.equal(list[0].id, call.id);
    assert.equal(list[0].group, 'Fietsteam');
    // The group chat gets a short line about the call.
    const th = await t.api('GET', `/threads/${threadId}?limit=5`);
    assert.ok(th.messages.some((m: any) => /^Groepsgesprek · .* · 2 beurten/.test(m.content || '')), 'event line in the group chat');
    // Not a group thread → refused; a one-to-one call is unchanged.
    const solo = await t.api('POST', '/threads', { agentId: a.id });
    await assert.rejects(t.api('POST', '/voice/calls', { threadId: solo.id, group: true }), /geen groepsgesprek/);
    const one = await t.api('POST', '/voice/calls', { agentId: a.id, threadId: solo.id });
    assert.equal(one.mode, 'agent');
    // Acceptance round 6 (B-53/B-56): a group without a lead ("alleen op vermelding") was never recorded (404).
    const mention = await t.api('POST', '/rooms', { name: 'Kookclub', mode: 'mention', agentIds: [b.id, a.id] });
    const mt = mention.thread_id || mention.threadId;
    const mcall = await t.api('POST', '/voice/calls', { threadId: mt, group: true });
    assert.equal(mcall.mode, 'group');
    assert.equal(mcall.agent_id, b.id, 'the first bot of the group');
    await t.api('POST', `/voice/calls/${mcall.id}/end`, { turns: 1 });
    assert.equal((await t.api('GET', '/voice/calls')).find((c: any) => c.id === mcall.id)?.group, 'Kookclub');
  } finally {
    await t.close();
  }
});
