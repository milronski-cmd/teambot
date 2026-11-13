// Routines that work as they say (12 nov 2026, found by an independent check on a fresh install):
//  - a change really changes the SAME routine, through the chat (my_routines change) and the API: `times` alone moves
//    the time and keeps the days; a field a routine does not have is refused, never logged as changed; the bot is told
//    what the routine is now;
//  - a pause says who paused it; a paused routine is not planned (the page lists it under "Staat uit");
//  - a reminder a bot sets has no built-in limit of runs a day (the limit stays a setting, off by default);
//  - "Wat start vanzelf" lists everything that does work by itself: the automatic backup, a second look that waits for
//    a usage limit, and the one download of the search model are sources of the one planner, at their time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers.js';
import { modules as allModules } from '../server/modules/index.js';
import { createRoutinesModule } from '../server/modules/routines/index.js';
import { migrations } from '../server/modules/routines/schema.js';
import { fetchesModelBySelf, searchModelSource } from '../server/modules/memory/index.js';
import type { RoutineEngine } from '../server/modules/routines/engine.js';
import type { Planned } from '../server/modules/routines/planner.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const WORKDAYS = [1, 2, 3, 4, 5];

async function setup() {
  const t: TestApp = await startTestApp();
  const ctx = t.app.ctx;
  const userId = ctx.auth.owner()!.id;
  ctx.store.setSetting(userId, 'timezone', 'UTC');
  const bot = await t.agent({ name: 'Rik' });
  const routine = (): Promise<any> => t.api('POST', '/routines', { name: 'Dagstart', prompt: 'Zeg goedemorgen.', agent_id: bot.id, timezone: 'UTC', schedule: { kind: 'weekly', days: WORKDAYS, times: ['09:00'] } });
  /** The owner asks his bot something in the chat; the bot calls this tool. What the tool answered. */
  const ask = async (tool: string, args: any): Promise<string> => {
    const th = ctx.chat.threadForAgent(userId, bot.id);
    t.script.push({ toolCalls: [{ name: tool, args }] }, { text: 'Gedaan.' });
    const msgs = await t.say(th.id, 'Zet die routine voortaan op 9:30 in plaats van 9:00.');
    return String(msgs.filter((m: any) => m.role === 'tool').at(-1)?.content || '');
  };
  const updates = () => ctx.store.all<any>("SELECT data FROM audit WHERE kind = 'routine.updated' ORDER BY rowid").map((x) => JSON.parse(x.data));
  return { t, ctx, userId, bot, routine, ask, updates };
}

test('a change through the API changes the same routine: times alone moves the time and keeps the days; an unknown field is refused and nothing is logged', async () => {
  const e = await setup();
  try {
    const r = await e.routine();
    const moved = await e.t.api('PATCH', `/routines/${r.id}`, { times: ['10:00'] });
    assert.equal(moved.id, r.id, 'the same routine');
    assert.deepEqual(moved.schedule, { kind: 'weekly', days: WORKDAYS, times: ['10:00'] });
    assert.equal(new Date(moved.next_run_at).getUTCHours(), 10, 'and its next run is at the new time');
    assert.deepEqual(e.updates().map((x) => x.fields), [['schedule']], 'the log names what really changed');

    // Fields a routine does not have: refused with what can be changed, nothing changed, nothing logged.
    for (const body of [{ schedule_time: '11:00' }, { tijd: '11:00', name: 'Ochtend' }]) {
      await assert.rejects(e.t.api('PATCH', `/routines/${r.id}`, body), /400: Een routine heeft geen velde?n? .*Er is niets veranderd\. Wat je kunt veranderen: name, prompt, times/);
    }
    await assert.rejects(e.t.api('PATCH', `/routines/${r.id}`, { status: 'paused' }), /400: De status verander je met pauzeren of aanzetten/);
    await assert.rejects(e.t.api('PATCH', `/routines/${r.id}`, { scheduleText: 'elke dag om 11:00' }), /400: scheduleText volgt uit de rest/);
    const now = await e.t.api('GET', `/routines/${r.id}`);
    assert.deepEqual([now.name, now.schedule.times, now.status], ['Dagstart', ['10:00'], 'active']);
    assert.equal(e.updates().length, 1, 'a refused change is never logged as changed');

    // What a bot read and sends back unchanged may come along; only the new field counts.
    const { triggers: _t, ...read } = now;
    const renamed = await e.t.api('PATCH', `/routines/${r.id}`, { ...read, name: 'Ochtendgroet' });
    assert.deepEqual([renamed.id, renamed.name, renamed.schedule.times], [r.id, 'Ochtendgroet', ['10:00']]);
    assert.deepEqual(e.updates().at(-1).fields, ['name']);
    // Nothing different: nothing written, nothing logged.
    await e.t.api('PATCH', `/routines/${r.id}`, { times: ['10:00'] });
    assert.equal(e.updates().length, 2);
    // The whole schedule still works as before (the routine editor sends it so); both ways at once is refused.
    const days = await e.t.api('PATCH', `/routines/${r.id}`, { schedule: { kind: 'weekly', days: [1, 3], times: ['08:15'] } });
    assert.deepEqual(days.schedule, { kind: 'weekly', days: [1, 3], times: ['08:15'] });
    await assert.rejects(e.t.api('PATCH', `/routines/${r.id}`, { schedule: { kind: 'weekly', days: [2], times: ['08:15'] }, times: ['09:00'] }), /400: Geef het schema óf als schedule/);
    // Other flat forms: days alone keep the time; once keeps its date when only the time changes.
    assert.deepEqual((await e.t.api('PATCH', `/routines/${r.id}`, { days: ['di', 'do'] })).schedule, { kind: 'weekly', days: [2, 4], times: ['08:15'] });
    const once = await e.t.api('POST', '/routines', { name: 'Eenmalig', prompt: 'Bel terug.', agent_id: e.bot.id, timezone: 'UTC', schedule: { kind: 'once', at: '2099-03-04T09:00' } });
    assert.deepEqual((await e.t.api('PATCH', `/routines/${once.id}`, { times: ['14:30'] })).schedule, { kind: 'once', at: '2099-03-04T14:30' });
  } finally {
    await e.t.close();
  }
});

test('"Zet die routine voortaan op 9:30": the bot changes the same routine in the chat, is told what it is now, and a wrong field changes nothing', async () => {
  const e = await setup();
  try {
    const r = await e.routine();
    // The tool says its shape: a small model finds times in it.
    const def = (await e.ctx.tools.forAgent(e.ctx.store.agent(e.bot.id)!, e.ctx.chat.threadForAgent(e.userId, e.bot.id))).find((x: any) => x.name === 'my_routines')!;
    assert.match(def.description, /\{"times":\["09:30"\]\}/);
    assert.ok((def.parameters as any).properties.fields.properties.times, 'fields names times');

    const said = await e.ask('my_routines', { action: 'change', routine: 'Dagstart', fields: { times: ['09:30'] } });
    assert.match(said, /^Routine “Dagstart” is aangepast \(dezelfde routine\): .*09:30/);
    let now = await e.t.api('GET', `/routines/${r.id}`);
    assert.deepEqual([now.id, now.schedule.times, now.schedule.days], [r.id, ['09:30'], WORKDAYS]);
    assert.equal(e.ctx.store.one<any>('SELECT COUNT(*) n FROM routines')!.n, 1, 'no second routine');

    // The way the bot called it on the fresh install: schedule_kind with days and times.
    assert.match(await e.ask('my_routines', { action: 'change', routine: 'Dagstart', fields: { schedule_kind: 'weekly', days: ['ma', 'wo'], times: ['09:45'] } }), /is aangepast/);
    now = await e.t.api('GET', `/routines/${r.id}`);
    assert.deepEqual([now.id, now.schedule.days, now.schedule.times], [r.id, [1, 3], ['09:45']]);
    // A schedule field next to fields instead of in it counts the same.
    await e.ask('my_routines', { action: 'change', routine: 'Dagstart', times: ['10:15'] });
    assert.deepEqual((await e.t.api('GET', `/routines/${r.id}`)).schedule.times, ['10:15']);

    // A field a routine does not have: the bot hears it, and nothing changed.
    const before = e.updates().length;
    const wrong = await e.ask('my_routines', { action: 'change', routine: 'Dagstart', fields: { tijd: '11:00' } });
    assert.match(wrong, /Niet gelukt \(routine “Dagstart”\): Een routine heeft geen veld tijd\. Er is niets veranderd/);
    assert.deepEqual((await e.t.api('GET', `/routines/${r.id}`)).schedule.times, ['10:15']);
    assert.equal(e.updates().length, before);
    // The same time again: the bot is told nothing changed, not that it did.
    assert.match(await e.ask('my_routines', { action: 'change', routine: 'Dagstart', fields: { times: ['10:15'] } }), /^Er is niets veranderd aan routine “Dagstart”: hij staat al zo/);
  } finally {
    await e.t.close();
  }
});

test('a pause says who paused it: the owner on the page, the bot by its name in the chat; a paused routine is not planned', async () => {
  const e = await setup();
  try {
    const r = await e.routine();
    assert.match(await e.ask('my_routines', { action: 'pause', routine: 'Dagstart' }), /staat op pauze/);
    let now = await e.t.api('GET', `/routines/${r.id}`);
    assert.deepEqual([now.status, now.paused_reason], ['paused', 'Gepauzeerd door Rik']);
    assert.ok(!(await e.t.api('GET', '/routines/planned')).planned.some((p: Planned) => p.id === r.id));
    // Aanzetten (what "Staat uit" does), and the owner pauses it himself.
    await e.t.api('POST', `/routines/${r.id}/resume`, {});
    assert.ok((await e.t.api('GET', '/routines/planned')).planned.some((p: Planned) => p.id === r.id));
    now = await e.t.api('POST', `/routines/${r.id}/pause`, {});
    assert.deepEqual([now.status, now.paused_reason], ['paused', 'Gepauzeerd door gebruiker']);
  } finally {
    await e.t.close();
  }
});

test('a reminder a bot sets has no built-in limit of runs a day; an old reminder with the old limit loses it, a limit set on a routine stays', async () => {
  const e = await setup();
  try {
    assert.match(await e.ask('reminder_set', { text: 'Bel de tandarts.', in_minutes: 30 }), /Herinnering gezet/);
    const rem = e.ctx.store.one<any>("SELECT options FROM routines WHERE json_extract(options, '$.reminder') IS NOT NULL")!;
    assert.equal(JSON.parse(rem.options).maxRunsPerDay, 0, 'no limit');

    // An install from before: a reminder with the old 50, and a routine whose owner chose 50 himself.
    const own = await e.routine();
    await e.t.api('PATCH', `/routines/${own.id}`, { options: { maxRunsPerDay: 50 } });
    e.ctx.store.exec("UPDATE routines SET options = json_set(options, '$.maxRunsPerDay', 50) WHERE json_extract(options, '$.reminder') IS NOT NULL");
    e.ctx.store.exec(migrations.find((m) => m.id === 'routines-004')!.sql);
    const limits = e.ctx.store.all<any>("SELECT json_extract(options, '$.reminder') IS NOT NULL rem, json_extract(options, '$.maxRunsPerDay') n FROM routines ORDER BY rem");
    assert.deepEqual(limits.map((x) => [x.rem, x.n]), [[0, 50], [1, 0]]);
  } finally {
    await e.t.close();
  }
});

/** A fresh install on the planner's own clock (a look when the test says so), every module as in the app. */
async function onClock() {
  let d = Math.floor((Date.now() + 2 * 86_400_000) / 86_400_000) * 86_400_000;
  const clock = { now: d + 5 * HOUR };
  const t: TestApp = await startTestApp({ modules: allModules.map((m) => (m.id === 'routines' ? createRoutinesModule({ clock: () => clock.now, tickMs: 0 }) : m)) });
  const ctx = t.app.ctx;
  const userId = ctx.auth.owner()!.id;
  const engine: RoutineEngine = ctx.services.routines.engine;
  const planned = async (): Promise<Planned[]> => (await t.api('GET', '/routines/planned')).planned;
  const to = async (ms: number) => {
    clock.now = ms;
    engine.tick();
    await engine.idle();
  };
  return { t, ctx, userId, engine, clock, planned, to, start: clock.now };
}

test('"Wat start vanzelf" lists the automatic backup: two minutes after start, then a day later; it calls no model, and it goes from the list when it is off', async () => {
  const e = await onClock();
  try {
    const backups = () => e.ctx.services.backups.list().filter((b: any) => b.kind === 'auto').length;
    let list = await e.planned();
    assert.deepEqual(list.map((p) => [p.kind, p.title, p.model, p.at, p.link]), [['backup', 'Automatische back-up van je gegevens', false, new Date(e.start + 2 * MIN).toISOString(), '#/settings/backups-app']]);
    await e.to(e.start + MIN);
    assert.equal(backups(), 0, 'not before its time');
    await e.to(e.start + 2 * MIN);
    assert.equal(backups(), 1, 'made by the one planner at the time the list said');
    list = await e.planned();
    assert.equal(list[0].at, new Date(e.start + 2 * MIN + 23 * HOUR).toISOString(), 'the next one a day later, at a look of the planner');
    await e.to(e.start + 3 * HOUR);
    assert.equal(backups(), 1, 'one a day');
    assert.equal(e.t.requests.length, 0, 'no model call');
    await e.t.api('PUT', '/backups/settings', { auto: false });
    assert.deepEqual(await e.planned(), [], 'off: not in the list');
  } finally {
    await e.t.close();
  }
});

test('"Wat start vanzelf" lists a second look that waits for a usage limit, and the planner starts it at that time', async () => {
  const e = await onClock();
  try {
    const bot = await e.t.agent({ name: 'Bo' });
    const at = e.start + 3 * HOUR;
    const ts = new Date(e.start).toISOString();
    e.ctx.store.exec(
      "INSERT INTO quality_tasks (id, user_id, kind, ref, title, reported_by, reported_at, check_state, open, recheck_at, created_at, updated_at) VALUES ('q1', ?, 'room', 't1', 'Sitemap nalopen', ?, ?, 'review', 1, ?, ?, ?)",
      e.userId,
      bot.id,
      ts,
      new Date(at).toISOString(),
      ts,
      ts,
    );
    const looks: number[] = [];
    e.ctx.services.quality.recheckDue = async (now: number) => (looks.push(now), 0);
    const p = (await e.planned()).find((x) => x.kind === 'recheck')!;
    assert.deepEqual([p.id, p.title, p.agentId, p.model, p.link], ['recheck:room:t1', 'Tweede controle: Sitemap nalopen', bot.id, true, `#/tasks?open=${encodeURIComponent('b:t1')}`]);
    assert.ok(Date.parse(p.at!) >= at && Date.parse(p.at!) < at + MIN, p.at!);
    await e.to(at + MIN);
    assert.ok(looks.includes(at + MIN), 'the one planner looked for it at its time');
    assert.equal(e.engine.planner.has('quality-recheck'), true);
  } finally {
    await e.t.close();
  }
});

test('"Wat start vanzelf" lists the one download of the search model (what, how big, when), and the planner starts it once', async () => {
  const e = await onClock();
  try {
    const sem = e.ctx.services.memory.semantic;
    const calls: string[] = [];
    // (No real download in a test: the model is "not there yet", and fetching it is only recorded.)
    sem.builtinStatus = () => ({ state: 'absent', bytes: 124_000_000 });
    sem.enableBuiltin = (userId: string) => (calls.push(userId), sem.builtinStatus());
    const planner = e.engine.planner;
    planner.register(searchModelSource(e.ctx, e.ctx.services.memory.svc, planner));
    const p = (await e.planned()).find((x) => x.kind === 'download')!;
    assert.deepEqual([p.title, p.model, p.at, p.link], ['Zoekmodel voor slim zoeken downloaden (eenmalig, ± 124 MB)', false, new Date(e.start + 2 * MIN).toISOString(), '#/m/memory/opslag']);
    await e.to(e.start + 2 * MIN);
    assert.deepEqual(calls, [e.userId], 'started at the time the list said');
    assert.ok(!(await e.planned()).some((x) => x.kind === 'download'), 'and then no longer planned');
    await e.to(e.start + 3 * HOUR);
    assert.equal(calls.length, 1, 'once');
  } finally {
    await e.t.close();
  }
});

test('the search model is not planned when the owner said "niet nu" or switched slim zoeken off', async () => {
  const e = await onClock();
  try {
    const sem = e.ctx.services.memory.semantic;
    const calls: string[] = [];
    sem.builtinStatus = () => ({ state: 'absent', bytes: 124_000_000 });
    sem.enableBuiltin = (userId: string) => (calls.push(userId), sem.builtinStatus());
    e.engine.planner.register(searchModelSource(e.ctx, e.ctx.services.memory.svc, e.engine.planner));
    e.ctx.store.setSetting(e.userId, 'memory.builtinOffer', { at: new Date().toISOString(), action: 'later' });
    assert.ok(!(await e.planned()).some((x) => x.kind === 'download'), '"niet nu"');
    await e.to(e.start + 2 * MIN);
    e.ctx.store.setSetting(e.userId, 'memory.builtinOffer', null);
    e.ctx.services.memory.svc.saveUserSettings(e.userId, { semantic: 'off' });
    assert.ok(!(await e.planned()).some((x) => x.kind === 'download'), 'slim zoeken off');
    await e.to(e.start + 3 * HOUR);
    assert.deepEqual(calls, [], 'never fetched');
  } finally {
    await e.t.close();
  }
});

test('a test or trial server never fetches the search model by itself: the unit-test runner and TEAMBOT_NO_AUTO_DOWNLOAD=1 skip it the same way', async () => {
  assert.equal(fetchesModelBySelf({}), true, 'an installed TeamBot');
  assert.equal(fetchesModelBySelf({ NODE_TEST_CONTEXT: 'child-v8' }), false, 'node --test');
  assert.equal(fetchesModelBySelf({ TEAMBOT_NO_AUTO_DOWNLOAD: '1' }), false, 'an e2e or trial server');
  assert.equal(fetchesModelBySelf({ TEAMBOT_NO_AUTO_DOWNLOAD: '0' }), true);
  // The module asks exactly that: in this run (node --test) it plans no download, although the model is not there.
  const e = await onClock();
  try {
    e.ctx.services.memory.semantic.builtinStatus = () => ({ state: 'absent', bytes: 124_000_000 });
    assert.ok(!(await e.planned()).some((x) => x.kind === 'download'));
  } finally {
    await e.t.close();
  }
});
