import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';

test('an answer remembers which connection wrote it, also with two connections of the same kind', async () => {
  const t = await startTestApp();
  try {
    const second = await t.api('POST', '/providers', { kind: 'mock', name: 'Mock op de laptop' });
    assert.equal(second.name, 'Mock op de laptop');
    const a = await t.agent({ provider_id: second.id });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: 'Hallo!' });
    const answer = (await t.say(th.id, 'Hoi')).filter((m) => m.role === 'assistant').at(-1)!;
    // The kind alone ("mock") matches both connections; the footer shows the one that answered.
    assert.equal(answer.parts.provider, 'mock');
    assert.equal(answer.parts.providerId, second.id);
    assert.equal(answer.parts.providerName, 'Mock op de laptop');
  } finally {
    await t.close();
  }
});
