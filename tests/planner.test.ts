// One planner for everything that starts by itself (12 nov 2026). Next to the routine engine every part had its own
// clock: the work loop, three 60-second clocks of the main bot (check-in, overview, stuck work), a cron job per
// workflow and a ten-minute clock of the specialists. The check-in and the overview were on without anyone asking.
// Now there is one clock (the routine engine's, server/modules/routines/planner.ts) and one list. These tests hold:
//  - a fresh install with bots and nothing set up starts nothing, however long it is left alone: no run, no model
//    call, no message, and nothing is planned;
//  - what somebody set up (a routine, a reminder, a wait point, a workflow on a schedule, a task with an owner, the
//    check-in, the overview, a learning round) is started by that one planner at its time and is in the one list;
//  - an install that existed keeps what it had (the one-time migration writes the old defaults down).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers.js';
import { reopen } from './team-mock.js';
import { modules as allModules } from '../server/modules/index.js';
import { createRoutinesModule } from '../server/modules/routines/index.js';
import type { RoutineEngine } from '../server/modules/routines/engine.js';
import type { Planned } from '../server/modules/routines/planner.js';
import type { WorkLoop } from '../server/modules/routines/duties/work.js';
import { checkinSettings } from '../server/modules/teams/proactive.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
/** 'JJJJ-MM-DDTUU:MM' of a moment (the owner's time zone is UTC in these tests). */
const local = (ms: number) => iso(ms).slice(0, 16);

/** A Monday at 00:00 UTC, at least two days from now: every real timestamp is in the past on the planner's clock. */
function monday(): number {
  let d = Math.floor((Date.now() + 2 * DAY) / DAY) * DAY;
  while (new Date(d).getUTCDay() !== 1) d += DAY;
  return d;
}

/**
 * TeamBot as a new user gets it: every module, nothing set. Only the planner's clock is the test's (it starts Monday
 * 05:00), and the work loop is on like in the app (under the test runner it is off unless a test turns it on).
 */
async function install() {
  const day = monday();
  const clock = { now: day + 5 * HOUR };
  const t: TestApp = await startTestApp({ modules: allModules.map((m) => (m.id === 'routines' ? createRoutinesModule({ clock: () => clock.now, tickMs: 0 }) : m)) });
  const ctx = t.app.ctx;
  // (No network in a test: a specialist's sources are never fetched.)
  ctx.services.specialists?.setOptions?.({ hostDelayMs: 0, fetch: async () => { throw new Error('geen netwerk in tests'); }, search: async () => [] });
  const engine: RoutineEngine = ctx.services.routines.engine;
  const work: WorkLoop = ctx.services.routines.work;
  work.enabled = true;
  const userId = ctx.auth.owner()!.id;
  ctx.store.setSetting(userId, 'timezone', 'UTC');
  const notes: any[] = [];
  ctx.events.subscribe((e: any) => e.type === 'notification' && notes.push(e.data));
  /** Everything a look started is over (routine runs, work turns, check-ins, workflow steps). */
  const settle = async () => {
    for (let quiet = 0, i = 0; quiet < 2 && i < 400; i++) {
      await engine.idle();
      await work.idle();
      await ctx.services.teams.checkin.idle();
      const busy = ctx.runs.activeRuns().length + ctx.services.workflows.activeRuns(userId).length;
      quiet = busy ? 0 : quiet + 1;
      if (busy) await new Promise((r) => setTimeout(r, 25));
    }
  };
  const tick = async () => {
    engine.tick();
    await settle();
  };
  return {
    t,
    ctx,
    engine,
    work,
    userId,
    clock,
    day,
    notes,
    tick,
    settle,
    /** Let the planner's clock run to this moment, a look every `step`. */
    async to(ms: number, step = MIN) {
      while (clock.now < ms) {
        clock.now = Math.min(ms, clock.now + step);
        await tick();
      }
      await tick();
    },
    runs: () => ctx.store.all<any>('SELECT id, agent_id, trigger, status FROM runs ORDER BY created_at, rowid'),
    /** What is planned for the bots (the automatic backup of the installation is in the list too: see the first test). */
    planned: async (): Promise<Planned[]> => (await t.api('GET', '/routines/planned')).planned.filter((p: Planned) => p.kind !== 'backup'),
    /** A tool call of a bot in a chat turn the owner started ("zet een herinnering …"). */
    async tool(agent: { id: string }, name: string, args: any): Promise<string> {
      const th = ctx.chat.threadForAgent(userId, agent.id);
      t.script.push({ toolCalls: [{ name, args }] }, { text: 'Gedaan.' });
      const msgs = await t.say(th.id, 'Doe dit voor mij.');
      return String(msgs.filter((m: any) => m.role === 'tool').at(-1)?.content || '');
    },
  };
}

test('a fresh install with bots and nothing set up: days pass and nothing starts — no run, no model call, no message, nothing planned', async () => {
  const e = await install();
  try {
    const { ctx, userId } = e;
    // Three bots as the app makes them. The first one is the main bot by itself; one has a role that names a field.
    const main = await e.t.agent({ name: 'Eerste' });
    const seo = await e.t.agent({ name: 'Vindbaar', role: 'SEO-specialist: technische SEO en zoekwoorden' });
    await e.t.agent({ name: 'Pen', role: 'Contentschrijver' });
    assert.equal(ctx.services.teams.mainOf(userId), main.id, 'there is a main bot with an AI: the check-in could run');
    assert.equal(ctx.services.specialists.isSpecialist(seo.id), true, 'and a specialist that could learn');
    // What used to be on by itself is off, and nothing was written for the owner.
    assert.deepEqual(checkinSettings(ctx, userId), { enabled: false, time: '09:00' });
    assert.equal(ctx.services.routines.duties.settings(userId).briefing, 'uit');
    assert.equal(ctx.store.getSetting(userId, 'proactive.checkin', null), null);
    assert.equal(ctx.store.getSetting(userId, 'proactive', null), null);

    // Three working days and nights of the one clock, a look every five minutes.
    await e.to(e.day + 3 * DAY + 5 * HOUR, 5 * MIN);
    // And each former clock at a moment it used to act (Thursday 09:05), asked directly.
    e.clock.now = e.day + 3 * DAY + 9 * HOUR + 5 * MIN;
    assert.deepEqual(await ctx.services.teams.checkin.tick(), [], 'no check-in');
    assert.deepEqual(await ctx.services.teams.briefing.tick(), [], 'no overview');
    assert.deepEqual(ctx.services.teams.stuck.tick(), [], 'nothing stuck to report');
    assert.equal(await ctx.services.specialists.svc.roundsDue(e.clock.now), 0, 'no learning round');
    assert.equal(await e.work.tick(), 0, 'no work turn');
    await e.tick();

    assert.deepEqual(e.runs(), [], 'not a single run');
    assert.equal(e.t.requests.length, 0, 'not a single model call');
    for (const table of ['messages', 'routines', 'routine_runs', 'workflow_runs', 'specialist_rounds']) assert.equal(ctx.store.one<any>(`SELECT COUNT(*) n FROM ${table}`)!.n, 0, table);
    assert.deepEqual(e.notes, [], 'no notification');
    assert.deepEqual(await e.planned(), [], 'and nothing is planned for the bots');
    // What TeamBot does by itself for the installation is in the same list: the automatic backup, without a model call.
    const all: Planned[] = (await e.t.api('GET', '/routines/planned')).planned;
    assert.deepEqual(all.map((p) => [p.kind, p.model, p.agentId]), [['backup', false, null]]);
    assert.ok(ctx.services.backups.list().some((b: any) => b.kind === 'auto'), 'and it was made, on the same clock');
    // Every part that has a time is a source of the one planner.
    for (const id of ['duties', 'work', 'checkin', 'briefing', 'stuck', 'workflows', 'specialists', 'backups', 'quality-recheck']) assert.equal(e.engine.planner.has(id), true, id);
  } finally {
    await e.t.close();
  }
});

test('one planner: a routine, a reminder, a wait point, a workflow on a schedule and work for a task each start at their time, and all are in the one list', async () => {
  const e = await install();
  try {
    const { ctx, userId, day } = e;
    await e.t.agent({ name: 'Eerste' });
    const bo = await e.t.agent({ name: 'Bo', access_mode: 'full' });
    const at = (h: number, m = 0) => day + h * HOUR + m * MIN;
    const of = (list: Planned[], kind: string) => list.filter((p) => p.kind === kind);
    assert.deepEqual(await e.planned(), []);

    // What the owner (or a bot on his word) sets up, at 05:00.
    const routine = await e.t.api('POST', '/routines', { name: 'Elk uur de post', prompt: 'Kijk of er post is.', agent_id: bo.id, schedule: { kind: 'interval', everyMinutes: 60 } });
    assert.match(await e.tool(bo, 'reminder_set', { text: 'De tandarts bellen', at: local(at(6, 30)) }), /Herinnering gezet/);
    assert.match(await e.tool(bo, 'wait_for', { event: 'time', at: local(at(7)), then: 'Zeg dat het zeven uur is.' }), /wachtpunt|Wachtpunt/i);
    const wf = await e.t.api('POST', '/workflows', { name: 'Dagrapport', steps: [{ kind: 'bot', title: 'Schrijven', agentId: bo.id, prompt: 'Schrijf het dagrapport.' }], schedule: { kind: 'daily', time: '08:00' } });
    assert.equal(wf.nextRun, iso(at(8)), 'the workflow says the same time as the list');
    const before = e.runs().length;
    assert.equal(before, 2, 'the two turns in which the owner asked');

    let list = await e.planned();
    assert.deepEqual(
      list.map((p) => [p.kind, p.title, p.at, p.model, p.agentId]),
      [
        ['routine', 'Elk uur de post', iso(at(6)), true, bo.id],
        ['reminder', 'Herinnering: De tandarts bellen', iso(at(6, 30)), false, bo.id],
        ['waitpoint', list[2].title, iso(at(7)), true, bo.id],
        ['workflow', 'Dagrapport', iso(at(8)), true, bo.id],
      ],
      'everything that starts by itself, soonest first, with whether it costs model calls',
    );
    assert.equal(list[0].id, routine.id);
    assert.equal(list[3].id, wf.id);

    // Nothing starts before its time.
    await e.to(at(5, 59));
    assert.equal(e.runs().length, before);

    // 06:00 the routine (and every hour after that).
    e.t.script.push({ text: 'Geen post.' });
    await e.to(at(6, 1));
    assert.deepEqual(e.runs().slice(before).map((r) => [r.trigger, r.status, r.agent_id]), [['routine', 'done', bo.id]]);
    assert.equal(of(await e.planned(), 'routine')[0].at, iso(at(7)));

    // 06:30 the reminder: TeamBot tells it itself, without a model call, and it leaves the list.
    const calls = e.t.requests.length;
    await e.to(at(6, 31));
    assert.equal(e.t.requests.length, calls, 'a reminder costs no model call');
    assert.ok(e.notes.some((n) => /De tandarts bellen/.test(`${n.title} ${n.body}`)), 'the owner is told');
    assert.deepEqual(of(await e.planned(), 'reminder'), []);

    // 07:00 the wait point (in the conversation that set it) and the routine's second run.
    e.t.script.push({ text: 'Het is zeven uur.' }, { text: 'Geen post.' });
    await e.to(at(7, 1));
    assert.equal(e.runs().filter((r) => r.trigger === 'routine').length, 3);
    assert.deepEqual(of(await e.planned(), 'waitpoint'), [], 'a wait point fires once');

    // 08:00 the workflow, started by the planner ("Schema"), not by a clock of its own.
    e.t.script.push({ text: 'Geen post.' }, { text: 'Dagrapport: alles loopt.' });
    await e.to(at(8, 1));
    const wr = ctx.store.all<any>('SELECT "trigger", started_by, status FROM workflow_runs');
    assert.deepEqual(wr.map((x) => [x.trigger, x.started_by, x.status]), [['schedule', 'Schema', 'done']]);
    assert.equal(e.runs().filter((r) => r.trigger === 'workflow').length, 1);
    assert.equal(of(await e.planned(), 'workflow')[0].at, iso(at(8) + DAY), 'tomorrow again');
    // Off: it leaves the list and does not start.
    assert.equal((await e.t.api('PATCH', `/workflows/${wf.id}`, { enabled: false })).nextRun, null);
    assert.deepEqual(of(await e.planned(), 'workflow'), []);
    await e.t.api('POST', `/routines/${routine.id}/pause`, {});
    assert.deepEqual(of(await e.planned(), 'routine'), [], 'a paused routine is not planned');

    // Work for a task. The board hands a new task to its bot at once (a turn of its own: rooms/board.ts); here the bot
    // answers without finishing it. From then on it is work that lies there: in the list, and picked up at the
    // planner's next look.
    await e.t.api('POST', '/rooms/tasks', { title: 'Sitemap nalopen', owner: 'Bo' });
    await e.settle();
    const n = e.runs().length;
    list = await e.planned();
    assert.deepEqual(list.map((p) => [p.kind, p.id, p.at, p.model, p.title]), [['work', `work:${bo.id}`, null, true, 'Werk dat klaarligt voor Bo: 1 punt']]);
    e.t.script.push({ text: 'De sitemap mist twee pagina’s; ik kon ze niet toevoegen.' });
    await e.to(at(8, 3));
    assert.deepEqual(e.runs().slice(n).map((r) => [r.trigger, r.status, r.agent_id]), [['work', 'done', bo.id]]);
    assert.match(JSON.stringify(e.t.requests.at(-1)!.messages), /Op jouw naam:[\s\S]*Sitemap nalopen/);
    // The same list is not started again at every look: its next try has a time, and that is what the list says.
    await e.to(at(9));
    assert.equal(e.runs().length, n + 1, 'no second turn for the same list an hour later');
    const [again] = of(await e.planned(), 'work');
    assert.ok(again.at && Date.parse(again.at) > at(24), `the next try is planned: ${again.at}`);
  } finally {
    await e.t.close();
  }
});

test('the main bot’s own messages and a learning round are planned only after the owner turned them on, and then come from the same planner', async () => {
  const e = await install();
  try {
    const { ctx, userId, day } = e;
    const main = await e.t.agent({ name: 'Eerste' });
    const seo = await e.t.agent({ name: 'Vindbaar', role: 'SEO-specialist: technische SEO en zoekwoorden' });
    const at = (h: number, m = 0) => day + h * HOUR + m * MIN;
    assert.deepEqual(await e.planned(), []);

    // The overview (no model): on at the main bot's hour.
    await e.t.api('PUT', '/proactive/settings', { briefing: 'dag' });
    let list = await e.planned();
    assert.deepEqual(list.map((p) => [p.kind, p.at, p.model, p.agentId]), [['briefing', iso(at(9)), false, main.id]]);

    // The check-in (a turn of the main bot): on, at half past seven. It brings the overview itself: one message, not two.
    await e.t.api('PUT', '/proactive/checkin', { enabled: true, time: '07:30' });
    list = await e.planned();
    assert.deepEqual(list.map((p) => [p.kind, p.at, p.model, p.agentId, p.title]), [['checkin', iso(at(7, 30)), true, main.id, 'Check-in van Eerste']]);
    await e.to(at(7, 29));
    assert.deepEqual(e.runs(), [], 'not before its hour');
    e.t.script.push({ text: 'Goedemorgen. Er ligt niets stil.' });
    await e.to(at(7, 32));
    assert.deepEqual(e.runs().map((r) => [r.trigger, r.status, r.agent_id]), [['checkin', 'done', main.id]], 'started by the planner at its hour');
    assert.equal((await e.planned())[0].at, iso(at(7, 30) + DAY), 'tomorrow again');
    await e.to(at(12));
    assert.equal(e.runs().length, 1, 'once a day');

    // Off again: nothing of it is planned, and the next morning nothing comes.
    await e.t.api('PUT', '/proactive/checkin', { enabled: false });
    await e.t.api('PUT', '/proactive/settings', { briefing: 'uit' });
    assert.deepEqual(await e.planned(), []);
    await e.to(at(24 + 10), 5 * MIN);
    assert.equal(e.runs().length, 1);
    assert.equal(e.t.requests.length, 1);

    // A specialist's learning round: planned once it is switched on (with a source to learn from).
    await e.t.api('PUT', `/specialists/${seo.id}`, { learnOn: true, sources: [{ kind: 'web', target: 'https://voorbeeld.test/nieuws', label: 'Nieuws' }] });
    const learn = (await e.planned()).filter((p) => p.kind === 'learning');
    assert.deepEqual(learn.map((p) => [p.id, p.agentId, p.model, p.title]), [[`learn:${seo.id}`, seo.id, true, 'Leerronde van Vindbaar']]);
    assert.ok(learn[0].at);
    assert.equal(ctx.services.specialists.svc.nextRoundAt(ctx.services.specialists.profile(seo.id)), learn[0].at);
    void userId;
  } finally {
    await e.t.close();
  }
});

test('an install that existed keeps what it had: the old defaults (check-in on, overview daily at its own hour) are written down once', async () => {
  const e = await install();
  let r2: Awaited<ReturnType<typeof reopen>> | null = null;
  try {
    const store = e.ctx.store;
    const userId = e.userId;
    await e.t.agent({ name: 'Eerste' });
    // Make it the install of before the update: the migration has not run, and the owner never chose anything …
    store.exec("DELETE FROM _migrations WHERE id = 'routines-003'");
    store.exec("DELETE FROM settings WHERE user_id = ? AND key IN ('proactive', 'proactive.checkin')", userId);
    await e.t.app.close();
    r2 = await reopen(e.t, new Map());
    let s2 = r2.app.ctx.store;
    assert.deepEqual(checkinSettings(r2.app.ctx, userId), { enabled: true, time: '09:00' }, 'the check-in stays on');
    assert.equal(r2.app.ctx.services.routines.duties.settings(userId).briefing, 'dag', 'the overview stays daily');
    await r2.app.close();

    // … or he had switched the check-in off and kept the overview, which came at 07:15.
    const again = await reopen(e.t, new Map());
    r2 = again;
    s2 = again.app.ctx.store;
    s2.exec("DELETE FROM _migrations WHERE id = 'routines-003'");
    s2.setSetting(userId, 'proactive.checkin', { enabled: false, time: '10:00' });
    s2.setSetting(userId, 'proactive', { runsPerDay: 5, briefingTime: '07:15' });
    await again.app.close();
    r2 = await reopen(e.t, new Map());
    assert.deepEqual(checkinSettings(r2.app.ctx, userId), { enabled: false, time: '07:15' }, 'still off; the one hour is the hour his overview had');
    const set = r2.app.ctx.services.routines.duties.settings(userId);
    assert.deepEqual([set.briefing, set.runsPerDay], ['dag', 5], 'what he had set stays');
    assert.equal(r2.app.ctx.store.getSetting<any>(userId, 'proactive', {}).briefingTime, '07:15', 'nothing is removed from what was stored');
  } finally {
    if (r2) await r2.close();
    else await e.t.close();
  }
});
