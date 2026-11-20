// Own initiative: a bot with nothing on its name looks for work itself, within its role (duties/work.ts).
// Seen 20 nov 2026 with a team of 17 bots: between two requests of the owner most of the team stood still, and the
// bots only noted what was wrong instead of taking it up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './proactive-helpers.js';
import { INITIATIVE_IDLE_MS, INITIATIVE_QUIET_MS } from '../server/modules/routines/duties/work.js';
import { NO_UPDATE_TOKEN } from '../server/modules/routines/engine.js';

process.env.TEAMBOT_TEST_NO_AUTO_MAIN = '1';

test('a bot with nothing on its name looks for work itself after standing still, does it, and is left alone when there is nothing', async () => {
  const env = await setup();
  const { t, work } = env;
  work.initiative = true;
  try {
    const sem = await t.agent({ name: 'Sem', role: 'Technische SEO', tool_groups: ['team'] });
    const ctx = t.app.ctx;
    const runs = () => ctx.store.all<any>("SELECT * FROM runs WHERE agent_id = ? AND trigger = 'work' ORDER BY rowid", sem.id);

    // Never did anything and has no work: it starts looking at once.
    t.script.push({ text: 'Ik heb de sitemap nagelopen en twee dode links hersteld. Het rapport staat in mijn map.' });
    assert.equal(await env.workNow(), 1, 'a turn of own initiative');
    assert.equal(runs().length, 1);
    const asked = JSON.stringify(t.requests.at(-1)!.messages);
    assert.match(asked, /er ligt geen werk op je naam\. Dan zoek je het zelf, binnen je eigen vak/);
    assert.match(asked, /task_create/, 'bigger work goes on the board, where the loop picks it up');
    assert.match(asked, /geld uitgeven, een eerste bericht aan een nieuw contact/, 'the owner’s yes where his rules ask for it');

    // It just worked: not again right away.
    assert.equal(await env.workNow(), 0, 'not twice in a row');
    env.clock.now += INITIATIVE_IDLE_MS - 60_000;
    assert.equal(await env.workNow(), 0, 'not before it has stood still for a while');

    // Stood still long enough: it looks again. This time there is nothing worth doing, and it says only that.
    env.clock.now += 2 * 60_000 + INITIATIVE_IDLE_MS;
    t.script.push({ text: NO_UPDATE_TOKEN });
    assert.equal(await env.workNow(), 1);
    assert.equal(runs().length, 2);
    // Nothing found: left alone for hours, no pointless turns.
    env.clock.now += INITIATIVE_IDLE_MS + 60_000;
    assert.equal(await env.workNow(), 0, 'left alone after finding nothing');
    env.clock.now += INITIATIVE_QUIET_MS;
    t.script.push({ text: 'Nu wel iets gevonden en gedaan.' });
    assert.equal(await env.workNow(), 1, 'and again after the quiet hours');

    // The owner can switch it off, for everyone or for one bot.
    env.clock.now += INITIATIVE_IDLE_MS + 60_000;
    await t.api('PUT', '/proactive/settings', { initiative: false });
    assert.equal(await env.workNow(), 0, 'switched off by the owner');
    await t.api('PUT', '/proactive/settings', { initiative: true });
    ctx.store.updateAgent(sem.id, { settings: { ...ctx.store.agent(sem.id)!.settings, initiative: false } });
    assert.equal(await env.workNow(), 0, 'switched off for this bot');
  } finally {
    work.initiative = false;
    await t.close();
  }
});

test('real work goes first: a bot with a task on its name gets that task, not a turn of own initiative', async () => {
  const env = await setup();
  const { t, work } = env;
  work.initiative = true;
  try {
    const sem = await t.agent({ name: 'Sem', role: 'Technische SEO', tool_groups: ['team'] });
    const ctx = t.app.ctx;
    const now = new Date(env.clock.now).toISOString();
    ctx.store.insert('room_tasks', { id: 'tsk_own_1', user_id: sem.user_id, room_id: null, title: 'Sitemap repareren', description: '', status: 'todo', owner_type: 'agent', owner_id: sem.id, created_by: sem.user_id, created_at: now, updated_at: now } as any);
    t.script.push({ text: 'De sitemap is gerepareerd.' });
    assert.equal(await env.workNow(), 1);
    const asked = JSON.stringify(t.requests.at(-1)!.messages);
    assert.match(asked, /Sitemap repareren/);
    assert.doesNotMatch(asked, /Dan zoek je het zelf/);
  } finally {
    work.initiative = false;
    await t.close();
  }
});
