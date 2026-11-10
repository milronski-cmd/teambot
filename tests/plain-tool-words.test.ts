// Bots and step titles describe what happened in plain words, never with internal tool ids (acceptance round 4,
// Q-03: a bot wrote "rehearsal_finish" and "plan_update" in its answer).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainStep, toolLabel } from '../shared/toolLabels.js';
import { PLAIN_TOOLS_PROMPT } from '../server/agent/runner.js';
import { startTestApp } from './helpers.js';

test('step titles: no "(tool_id)", an id alone gets its words, file names stay', () => {
  assert.equal(plainStep('Wachtte op een gebeurtenis (wait_for)'), 'Wachtte op een gebeurtenis');
  assert.equal(plainStep('rehearsal_finish'), 'Rondde het oefenen af');
  assert.equal(plainStep('team_query'), 'Las in de teamtabellen');
  assert.equal(plainStep('Gebruikte memory_search voor je vraag'), 'Gebruikte een hulpmiddel voor je vraag');
  assert.equal(plainStep('Schreef my_notes.txt'), 'Schreef my_notes.txt');
  assert.equal(plainStep('Las src/my_module/index.ts'), 'Las src/my_module/index.ts');
  assert.equal(plainStep('Las een webpagina'), 'Las een webpagina');
  assert.equal(toolLabel({ name: 'some_new_tool' }, false), 'Gebruikte een hulpmiddel');
  assert.equal(toolLabel({ name: 'some_new_tool' }, true), 'Gebruikt een hulpmiddel');
});

test('every engine reads the plain-words rule in the shared system prompt', async () => {
  assert.match(PLAIN_TOOLS_PROMPT, /gewone woorden/);
  assert.match(PLAIN_TOOLS_PROMPT, /interne naam van een tool/);
  // No real tool id as the example: a prompt may only name tools the bot has (tests/cli-tools.test.ts).
  assert.doesNotMatch(PLAIN_TOOLS_PROMPT, /rehearsal_|memory_|plan_update/);
  const t = await startTestApp();
  try {
    const a = await t.agent();
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const sys = await t.app.ctx.services.runner.systemPrompt(t.app.ctx.store.agent(a.id)!, t.app.ctx.store.thread(th.id)!);
    assert.ok(sys.includes(PLAIN_TOOLS_PROMPT));
  } finally {
    await t.close();
  }
});
