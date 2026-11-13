import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { engineNote, engineRank, rankChoices, type EngineChoice } from '../ui/src/pages/newbot/choices.js';

/** TeamBot 0.4, package A: a new bot is three questions, and a new installation starts empty. */

const choice = (key: string, kind: string, type: 'api' | 'cli', billing?: any, group?: string): EngineChoice => {
  const f = { kind, type, billing, group };
  return { key, providerId: key.slice(2), kind, label: kind, model: '', note: engineNote(f), rank: engineRank(f) };
};

test('"Welk model?": own subscriptions first, then OpenCode free, then a local model, then free API tiers, then paid keys', () => {
  const list = [
    choice('p:openai', 'openai', 'api', 'paid'),
    choice('p:ollama', 'ollama', 'api', 'local', 'local'),
    choice('p:groq', 'groq', 'api', 'free', 'free'),
    choice('p:opencode', 'opencode', 'cli', 'free'),
    choice('p:codex', 'codex-cli', 'cli', 'subscription'),
    choice('p:claude', 'claude-code', 'cli', 'subscription'),
    choice('p:lms', 'lmstudio', 'api'),
  ];
  assert.deepEqual(
    rankChoices(list).map((c) => c.kind),
    ['claude-code', 'codex-cli', 'opencode', 'lmstudio', 'ollama', 'groq', 'openai'],
  );
  assert.equal(engineNote({ kind: 'claude-code', type: 'cli', billing: 'subscription' }), 'met je eigen abonnement');
  assert.equal(engineNote({ kind: 'opencode', type: 'cli', billing: 'free' }), 'gratis modellen, geen account nodig');
  assert.equal(engineNote({ kind: 'ollama', type: 'api' }), 'gratis, draait op deze pc');
  assert.equal(engineNote({ kind: 'openai', type: 'api' }), 'met je eigen sleutel');
  // The engine the user (or the server's own ranking, which knows logins) made the default comes first.
  assert.equal(rankChoices(list, 'ollama')[0].kind, 'ollama');
  assert.equal(rankChoices(list, 'onbekend')[0].kind, 'claude-code');
});

test('a fresh installation has no bots, teams, groups, skills, routines or tasks until the owner makes them', async () => {
  const t = await startTestApp();
  try {
    // startTestApp connects the test engine (like "Maak je eerste bot" connects the AI found on this PC); nothing else.
    assert.deepEqual(await t.api('GET', '/agents'), []);
    assert.deepEqual(await t.api('GET', '/rooms/teams'), []);
    assert.deepEqual(await t.api('GET', '/rooms'), []);
    assert.deepEqual(await t.api('GET', '/skills'), []);
    assert.deepEqual(await t.api('GET', '/routines'), []);
    assert.deepEqual(await t.api('GET', '/rooms/tasks'), []);
    assert.deepEqual(await t.api('GET', '/teamdata/tasks'), []);
  } finally {
    await t.close();
  }
});

test('the three answers (name, one sentence, engine) make a bot that knows its task and answers', async () => {
  const t = await startTestApp();
  try {
    // What the new-bot page sends: the answers and the default tools, model '' (engine default). No instructions: those
    // are the owner's own text, and a new bot starts with none.
    const a = await t.api('POST', '/agents', { name: 'Mila', description: 'Helpt me met korte vragen over mijn webshop.', provider_id: t.providerId, model: '', access_mode: 'ask', tool_groups: ['files', 'web', 'memory', 'team', 'skills', 'routines'] });
    assert.equal(a.name, 'Mila');
    assert.equal(a.instructions, '');
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: 'Hoi! Ik help je met vragen over je webshop.' });
    const msgs = await t.say(th.id, 'Hoi Mila, wat kun je voor me doen?');
    const reply = msgs.filter((m: any) => m.role === 'assistant').pop();
    assert.equal(reply?.content, 'Hoi! Ik help je met vragen over je webshop.');
    // The sentence is the bot's task; how every bot works (honest, no made-up result, ask when a task is unclear) is
    // TeamBot's own base prompt, not text in the owner's instructions.
    const sys = JSON.stringify(t.requests.at(-1)?.system ?? t.requests.at(-1));
    assert.match(sys, /Helpt me met korte vragen over mijn webshop/);
    assert.match(sys, /verzin geen resultaat/);
    assert.match(sys, /Vraag door als een opdracht onduidelijk is/);
    assert.doesNotMatch(sys, /## Jouw instructies/);
    // The engine default was used (mock-1), not an empty model.
    assert.equal(t.requests.at(-1)?.model, 'mock-1');
  } finally {
    await t.close();
  }
});
