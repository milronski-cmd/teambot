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
    // Done is done: no work for the sake of being busy; then the fixed tasks, then maintenance.
    assert.match(asked, /er ligt geen werk op je naam\. Klaar is klaar: je zoekt geen werk om bezig te zijn\./);
    assert.match(asked, /in een vaste taak zit[\s\S]*Daarna is je vak in onderhoud/);
    assert.match(asked, /task_create/, 'bigger work goes on the board, where the loop picks it up');
    assert.match(asked, /Jouw stand .*je hebt nog geen eigen cijfer op het dashboard.*er loopt geen experiment van jou.*kies het ene getal/s, 'the turn is measured by a number of its own');
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
    assert.doesNotMatch(asked, /Klaar is klaar: je zoekt geen werk/);
  } finally {
    work.initiative = false;
    await t.close();
  }
});

test('a turn of own initiative brings the stand: own number, experiments that are due, and nothing to judge is maintenance', async () => {
  const env = await setup();
  const { t, work } = env;
  try {
    const ctx = t.app.ctx;
    const userId = ctx.auth.owner()!.id;
    const sem = await t.agent({ name: 'Sem', role: 'Technische SEO', tool_groups: ['team'] });
    const baas = await t.agent({ name: 'Baas', role: 'Leiding' });
    await t.agent({ name: 'Pen', role: 'Schrijver' });
    const td = ctx.services.teamdata;
    await td.ensure(userId);
    const own = { role: 'system', parts: { work: { refs: ['own:1'] } } } as any;
    const day = (n: number) => new Date(env.clock.now + n * 86_400_000).toISOString().slice(0, 10);
    const fresh = new Date(env.clock.now - 3_600_000).toISOString().slice(0, 16).replace('T', ' ');
    const old = new Date(env.clock.now - 4 * 86_400_000).toISOString().slice(0, 16).replace('T', ' ');

    // Not a turn of own initiative: nothing.
    assert.equal(await work.stand(sem.id, { role: 'system', parts: { work: { refs: ['tk::1'] } } } as any), null);
    assert.equal(await work.stand(sem.id, { role: 'user', content: 'hoi' } as any), null);

    // A number that is old: measure first. An experiment that is due goes before everything.
    await td.write(userId, [
      { sql: "INSERT INTO dashboard (sleutel, groep, titel, waarde, eenheid, bot, bijgewerkt) VALUES ('seo-aanvragen', 'SEO', 'Aanvragen uit zoekverkeer', '12', 'per week', 'Sem', ?)", params: [old] },
      { sql: "INSERT INTO experimenten (hypothese, meting, beginwaarde, meetdatum, eigenaar, status) VALUES ('Een kortere titel geeft meer klikken', 'klikken per week', '40', ?, 'Sem', 'loopt')", params: [day(-1)] },
    ]);
    let said = (await work.stand(sem.id, own))!;
    assert.match(said, /cijfer “Aanvragen uit zoekverkeer”: 12 per week/);
    assert.match(said, /experiment 1: Een kortere titel geeft meer klikken \(meetdatum \d{4}-\d\d-\d\d, NU te beoordelen\)/);
    assert.match(said, /Meet eerst je cijfer opnieuw/);
    assert.match(said, /Een experiment dat te beoordelen is gaat voor: .*bewezen of werkt_niet/);

    // Number fresh, experiment still running: nothing to judge, the bot only maintains.
    await td.write(userId, [
      { sql: "UPDATE dashboard SET bijgewerkt = ? WHERE sleutel = 'seo-aanvragen'", params: [fresh] },
      { sql: 'UPDATE experimenten SET meetdatum = ? WHERE id = 1', params: [day(5)] },
    ]);
    said = (await work.stand(sem.id, own))!;
    assert.match(said, /Je cijfer is bij en je experiment loopt nog: er valt nu niets te beoordelen\. Herstel alleen wat kapot is of achterloopt/);
    assert.doesNotMatch(said, /Meet eerst|kies het ene getal/);

    // The main bot gets the team: who has no number, what is due, and the request for opportunities with their yield.
    await td.write(userId, [{ sql: 'UPDATE experimenten SET meetdatum = ? WHERE id = 1', params: [day(-2)] }]);
    ctx.services.teams.setMain?.(userId, baas.id);
    const lead = (await work.stand(baas.id, own))!;
    assert.match(lead, /^Stand van het team/);
    assert.match(lead, /cijfers op het dashboard: 1\. Zonder eigen cijfer: Pen/);
    assert.match(lead, /experimenten die lopen: 1, nu te beoordelen: 1\. Kansen die wachten: 0/);
    assert.match(lead, /experiment 1 van Sem/);
    assert.match(lead, /kom zelf met kansen: hoogstens drie per ronde.*wat het de eigenaar oplevert/s);
    // The main bot gets it on every work turn; another bot only on a turn of own initiative.
    assert.match((await work.stand(baas.id, { role: 'system', parts: { work: { refs: ['tk::1'] } } } as any)) || '', /^Stand van het team/);
  } finally {
    await t.close();
  }
});
