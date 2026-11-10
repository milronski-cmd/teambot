import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { toggleAll, toggleOne } from '../ui/src/lib/botPick.js';

// One bot picker (components/BotPicker.tsx) for skills, apps, tokens and groups, with "Alle bots". Before, skills used
// chips and apps checkboxes, and a skill had to be switched on bot by bot.

test('bot picker: "Alle bots" selects every bot or clears them; single keeps one', () => {
  assert.deepEqual(toggleAll([], ['a', 'b', 'c']), ['a', 'b', 'c']);
  assert.deepEqual(toggleAll(['b'], ['a', 'b', 'c']).sort(), ['a', 'b', 'c']);
  assert.deepEqual(toggleAll(['a', 'b', 'c'], ['a', 'b', 'c']), []);
  assert.deepEqual(toggleAll(['x', 'a', 'b'], ['a', 'b']), ['x'], 'ids outside the list (e.g. archived bots) stay');
  assert.deepEqual(toggleAll([], []), []);
  assert.deepEqual(toggleOne(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(toggleOne(['a', 'b'], 'a'), ['b']);
  assert.deepEqual(toggleOne(['a'], 'b', true), ['b']);
  assert.deepEqual(toggleOne(['b'], 'b', true), []);
});

test('skills: one request puts a skill on all bots (or takes it off), archived and foreign bots untouched', async () => {
  const t = await startTestApp();
  try {
    const pv = await t.api('POST', '/skills/import/preview', { kind: 'paste', text: '---\nname: offerte\ndescription: Maakt een offerte.\n---\n\n# Offerte\n\nLees de aanvraag, reken de uren uit en schrijf een nette offerte.\n' });
    const skillId = (await t.api('POST', '/skills/import/commit', { stagingId: pv.stagingId })).results[0].skillId;
    const a = await t.agent({ name: 'Een' });
    const b = await t.agent({ name: 'Twee' });
    const archived = await t.agent({ name: 'Oud' });
    await t.api('PATCH', `/agents/${archived.id}`, { archived: true });
    const all = await t.api('PUT', `/skills/${skillId}/agents`, { agentIds: [a.id, b.id] });
    assert.deepEqual(all.agentIds.sort(), [a.id, b.id].sort());
    assert.equal(all.changed, 2);
    assert.ok((await t.api('GET', `/agents/${b.id}`)).skills.includes(skillId));
    assert.equal((await t.api('GET', `/agents/${archived.id}`)).skills.includes(skillId), false);
    const one = await t.api('PUT', `/skills/${skillId}/agents`, { agentIds: [b.id] });
    assert.deepEqual(one.agentIds, [b.id]);
    assert.equal((await t.api('GET', `/agents/${a.id}`)).skills.includes(skillId), false);
    // Unknown bot ids are ignored; an unknown skill or a missing list is refused.
    assert.deepEqual((await t.api('PUT', `/skills/${skillId}/agents`, { agentIds: [b.id, 'agt_bestaat_niet'] })).agentIds, [b.id]);
    await assert.rejects(t.api('PUT', '/skills/skl_onbekend/agents', { agentIds: [] }), /404/);
    await assert.rejects(t.api('PUT', `/skills/${skillId}/agents`, {}), /400/);
  } finally {
    await t.close();
  }
});
