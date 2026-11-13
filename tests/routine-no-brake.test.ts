// Routines without a built-in brake, and a new routine that never skips what it was given (12 nov 2026):
//  - making a routine through the API takes the same fields as changing one (one check in engine.ts, routineInput): a
//    field it does not take is refused with what can be given, nothing is made and nothing is logged; the flat schedule
//    of routine_create (times, days, schedule_kind …) works here too; a new routine may start paused;
//  - no fixed caps: more than 200 routines, more than 100 reminders per bot, more than 20 triggers per routine, more
//    than 20 runs waiting for one routine, a chain of more than 5 routines. Each is a setting of Standaarden voor
//    routines, off (0) by default; once set it holds and says where it is set. A chain never comes back to a routine
//    that already ran in it: that guard stays, it is a protection, not a limit;
//  - a routine run has no time limit by default (was 30 minutes): a long run shows as running and Alles stoppen stops
//    it; a time limit is a setting of the routine. No maximum of projects in the sprint (was 3): a setting.
//  - after failed runs in a row a routine pauses itself (a protection against using up the owner's AI on something
//    broken; it stays) and the owner is told why, with one Aanzetten to turn it back on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownerTurn, startTestApp } from './helpers.js';
import { createRoutinesModule } from '../server/modules/routines/index.js';
import { migrations } from '../server/modules/routines/schema.js';
import type { RoutineEngine } from '../server/modules/routines/engine.js';

const WHERE = /Instellingen › Meer mogelijkheden › Standaarden voor routines/;
const until = async (fn: () => boolean, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) if (fn()) return;
  throw new Error('timeout');
};

async function setup() {
  const clock = { now: Date.parse('2026-11-12T10:00:00Z') };
  const t = await startTestApp({ modules: [createRoutinesModule({ clock: () => clock.now, tickMs: 0 })] });
  const ctx = t.app.ctx;
  const engine: RoutineEngine = ctx.services.routines.engine;
  const userId = ctx.auth.owner()!.id;
  ctx.store.setSetting(userId, 'timezone', 'UTC');
  const bot = await t.agent({ name: 'Rik' });
  const base = { prompt: 'Doe het werk.', agent_id: bot.id, timezone: 'UTC' };
  const make = (name: string, extra: any = {}): Promise<any> => t.api('POST', '/routines', { name, ...base, schedule: { kind: 'none' }, ...extra });
  const created = () => ctx.store.all<any>("SELECT data FROM audit WHERE kind = 'routine.created' ORDER BY rowid").map((x) => JSON.parse(x.data));
  const count = () => ctx.store.one<{ n: number }>('SELECT COUNT(*) n FROM routines')!.n;
  return { t, ctx, engine, userId, bot, base, make, created, count };
}

test('making a routine through the API takes the fields a change takes: an unknown field is refused with what can be given, nothing is made or logged', async () => {
  const e = await setup();
  try {
    const weekly = { kind: 'weekly', days: [1], times: ['09:00'] };
    // A field a routine does not take, a setting outside options, a field that follows from the rest: refused, not skipped.
    for (const extra of [{ tijd: '09:00' }, { schedule_time: '09:00' }, { notify: 'never' }, { id: 'rtn_eigen' }]) {
      await assert.rejects(e.t.api('POST', '/routines', { name: 'Dagstart', ...e.base, schedule: weekly, ...extra }), /400: Een nieuwe routine neemt het veld \w+ niet aan\. Er is geen routine gemaakt\. Wat je kunt meegeven: name, prompt, times/);
    }
    await assert.rejects(e.t.api('POST', '/routines', { name: 'Dagstart', ...e.base, schedule: weekly, tijd: '09:00', dag: 'ma' }), /400: Een nieuwe routine neemt de velden tijd, dag niet aan/);
    await assert.rejects(e.t.api('POST', '/routines', { name: 'Dagstart', ...e.base, schedule: weekly, status: 'draft' }), /400: Een nieuwe routine staat aan \(status active\) of op pauze \(status paused\)\. Er is geen routine gemaakt\./);
    await assert.rejects(e.t.api('POST', '/routines', { name: 'Dagstart', ...e.base, schedule: weekly, times: ['10:00'] }), /400: Geef het schema óf als schedule, óf met times, days en schedule_kind, niet allebei\. Er is geen routine gemaakt\./);
    assert.equal(e.count(), 0, 'nothing was made');
    assert.equal(e.created().length, 0, 'nothing was logged as made');

    // The flat schedule of routine_create, the same as for a change: days with times, or schedule_kind.
    const flat = await e.t.api('POST', '/routines', { name: 'Dagstart', ...e.base, days: ['ma', 'wo'], times: ['09:30'] });
    assert.deepEqual(flat.schedule, { kind: 'weekly', days: [1, 3], times: ['09:30'] });
    const daily = await e.t.api('POST', '/routines', { name: 'Elke dag', ...e.base, schedule_kind: 'daily', times: ['07:00'] });
    assert.deepEqual(daily.schedule, { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], times: ['07:00'] });
    // The whole schedule works as before (the routine editor sends it so); a new routine may start paused.
    const paused = await e.make('Later', { status: 'paused', schedule: { kind: 'interval', everyMinutes: 60 } });
    assert.deepEqual([paused.status, paused.schedule.everyMinutes], ['paused', 60]);
    const on = await e.make('Aan', { status: 'active' });
    assert.equal(on.status, 'active');
    assert.equal(e.created().length, 4);
  } finally {
    await e.t.close();
  }
});

test('more than 200 routines: no built-in maximum; the owner may set one under Standaarden voor routines', async () => {
  const e = await setup();
  try {
    for (let i = 0; i < 200; i++) e.engine.create(e.userId, { name: `Routine ${i}`, ...e.base, schedule: { kind: 'none' } });
    const r201 = await e.make('Nummer 201');
    assert.equal(e.count(), 201, r201.id);
    assert.equal((await e.t.api('GET', '/routines/settings')).maxRoutines, 0, 'a setting, off by default');
    // Set, it holds, and says where it is set.
    assert.equal((await e.t.api('PUT', '/routines/settings', { maxRoutines: 202 })).maxRoutines, 202);
    await e.make('Nummer 202');
    await assert.rejects(e.make('Nummer 203'), (err: Error) => /400: Het maximum van 202 routines is bereikt\. Er is geen routine gemaakt/.test(err.message) && WHERE.test(err.message));
    assert.equal(e.count(), 202);
    await e.t.api('PUT', '/routines/settings', { maxRoutines: 0 });
    await e.make('Nummer 203');
    assert.equal(e.count(), 203);
  } finally {
    await e.t.close();
  }
});

test('more than 100 reminders for one bot: no built-in maximum; the owner may set one', async () => {
  const e = await setup();
  try {
    const tool = e.ctx.tools.get('reminder_set')!;
    const tc: any = { ctx: e.ctx, agent: e.ctx.store.agent(e.bot.id)!, thread: e.ctx.chat.threadForAgent(e.userId, e.bot.id), run: ownerTurn(e.ctx, e.userId, e.bot.id), userId: e.userId, signal: new AbortController().signal, toolCallId: 'c1', progress() {} };
    const set = async (i: number) => (await tool.run({ text: `Bel klant ${i} terug`, in_minutes: 10 + i }, tc)) as any;
    for (let i = 1; i <= 101; i++) {
      const out = await set(i);
      assert.ok(!out.isError, `reminder ${i}: ${out.text}`);
    }
    assert.equal((await e.t.api('GET', '/routines/settings')).maxRemindersPerBot, 0, 'a setting, off by default');
    await e.t.api('PUT', '/routines/settings', { maxRemindersPerBot: 102 });
    assert.ok(!(await set(102)).isError);
    const over = await set(103);
    assert.equal(over.isError, true);
    assert.match(over.text, /^Er staan al 102 herinneringen klaar bij deze bot: meer staat de eigenaar niet toe/);
    assert.match(over.text, WHERE);
    assert.equal(e.engine.routinesOf(e.userId, e.bot.id).filter((r) => r.options.reminder).length, 102);
  } finally {
    await e.t.close();
  }
});

test('more than 20 triggers on one routine: no built-in maximum; the owner may set one', async () => {
  const e = await setup();
  try {
    const r = await e.make('Meldingen');
    for (let i = 1; i <= 21; i++) await e.t.api('POST', `/routines/${r.id}/triggers`, { kind: 'webhook', preset: 'token', name: `Melding ${i}` });
    assert.equal(e.engine.triggersOf(r.id).length, 21);
    assert.equal((await e.t.api('GET', '/routines/settings')).maxTriggersPerRoutine, 0, 'a setting, off by default');
    await e.t.api('PUT', '/routines/settings', { maxTriggersPerRoutine: 22 });
    await e.t.api('POST', `/routines/${r.id}/triggers`, { kind: 'webhook', preset: 'token', name: 'Melding 22' });
    await assert.rejects(e.t.api('POST', `/routines/${r.id}/triggers`, { kind: 'webhook', preset: 'token', name: 'Melding 23' }), (err: Error) => /400: Deze routine heeft al 22 triggers, het maximum\./.test(err.message) && WHERE.test(err.message));
    assert.equal(e.engine.triggersOf(r.id).length, 22);
  } finally {
    await e.t.close();
  }
});

test('more than 20 runs waiting for one routine: none is dropped by itself; the owner may set a maximum', async () => {
  const e = await setup();
  try {
    // Runs that wait for the routine (here: events faster than it works through them) are never dropped by themselves.
    const r = await e.make('Meldingen');
    const routine = e.engine.routine(r.id)!;
    const claim = (i: number) => e.engine.claim({ routine, key: `${r.id}@melding@${i}`, trigger: 'webhook' })!;
    for (let i = 1; i <= 21; i++) assert.equal(claim(i).status, 'pending', `run ${i} waits its turn`);
    assert.equal((await e.t.api('GET', '/routines/settings')).maxQueuedRuns, 0, 'a setting, off by default');
    await e.t.api('PUT', '/routines/settings', { maxQueuedRuns: 21 });
    const over = claim(22);
    assert.equal(over.status, 'skipped');
    assert.match(over.summary, /^Overgeslagen: er staan al 21 runs in de wachtrij van deze routine, het maximum/);
    assert.match(over.summary, WHERE);
  } finally {
    await e.t.close();
  }
});

test('a chain of six routines runs to the end; a limit on its length is a setting; a chain never comes back to a routine', async () => {
  const e = await setup();
  try {
    const rs: any[] = [];
    for (const n of ['A', 'B', 'C', 'D', 'E', 'F']) rs.push(await e.make(n));
    for (let i = 0; i < 5; i++) await e.t.api('PATCH', `/routines/${rs[i].id}`, { options: { then: { routineId: rs[i + 1].id, on: 'always', passResult: false } } });
    const runs = (r: any) => e.ctx.store.all<any>('SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY created_at', r.id).map((x) => e.ctx.store.decode<any>('routine_runs', x));
    await e.t.api('POST', `/routines/${rs[0].id}/run`, {});
    await e.engine.idle();
    assert.deepEqual(rs.map((r) => runs(r).length), [1, 1, 1, 1, 1, 1], 'all six ran, F too (the old cap stopped after five)');
    assert.equal(runs(rs[4])[0].meta.next.runId, runs(rs[5])[0].id);
    assert.equal((await e.t.api('GET', '/routines/settings')).maxChain, 0, 'a setting, off by default');

    // The owner sets a length: the chain stops there and says why.
    await e.t.api('PUT', '/routines/settings', { maxChain: 3 });
    await e.t.api('POST', `/routines/${rs[0].id}/run`, {});
    await e.engine.idle();
    assert.deepEqual(rs.map((r) => runs(r).length), [2, 2, 2, 1, 1, 1]);
    const stopped = runs(rs[2])[1].meta.next.error;
    assert.match(stopped, /^Keten gestopt na 3 routines: het maximum/);
    assert.match(stopped, WHERE);

    // Without a length limit, a loop in old data (F → A, saved before the check when it is set up) still stops: the
    // guard against a chain that comes back to a routine stays.
    await e.t.api('PUT', '/routines/settings', { maxChain: 0 });
    const f = e.ctx.store.get<any>('routines', rs[5].id);
    e.ctx.store.update('routines', rs[5].id, { options: { ...f.options, then: { routineId: rs[0].id, on: 'always', passResult: false } } });
    await e.t.api('POST', `/routines/${rs[0].id}/run`, {});
    await e.engine.idle();
    assert.deepEqual(rs.map((r) => runs(r).length), [3, 3, 3, 2, 2, 2], 'A did not start again');
    assert.match(runs(rs[5])[1].meta.next.error, /lus/);
  } finally {
    await e.t.close();
  }
});

test('a routine run has no time limit by default: a long run shows as running and Alles stoppen stops it; a time limit is a setting', async () => {
  const e = await setup();
  try {
    assert.equal((await e.t.api('GET', '/routines/meta')).defaults.timeoutMinutes, 0, 'no time limit by default');
    // An AI that keeps working on it: the run ends only when it is stopped.
    e.ctx.providers.registerKind({
      id: 'lang',
      label: 'Lang',
      type: 'api',
      needsKey: false,
      description: 'test',
      models: ['lang-1'],
      defaultModel: 'lang-1',
      create: () => ({
        kind: 'lang',
        listModels: async () => [{ id: 'lang-1' }],
        test: async () => ({ ok: true, detail: 'test' }),
        chat: (_req: any, signal: AbortSignal) => new Promise<never>((_ok, fail) => signal.addEventListener('abort', () => fail(Object.assign(new Error('afgebroken'), { name: 'AbortError' })), { once: true })),
      }),
    } as any);
    const prov = await e.t.api('POST', '/providers', { kind: 'lang' });
    const worker = await e.t.agent({ name: 'Lang', provider_id: prov.id, model: 'lang-1' });
    const r = await e.t.api('POST', '/routines', { name: 'Groot rapport', ...e.base, agent_id: worker.id, schedule: { kind: 'none' } });
    assert.equal(r.options.timeoutMinutes, 0);
    // A time limit the owner sets is kept as given; 0 is none again.
    assert.equal((await e.t.api('PATCH', `/routines/${r.id}`, { options: { timeoutMinutes: 90 } })).options.timeoutMinutes, 90);
    assert.equal((await e.t.api('PATCH', `/routines/${r.id}`, { options: { timeoutMinutes: 0 } })).options.timeoutMinutes, 0);

    const rr = e.engine.claim({ routine: e.engine.routine(r.id)!, key: `${r.id}@lang`, trigger: 'webhook' })!;
    e.engine.pump();
    await until(() => e.engine.getRun(rr.id)?.status === 'running');
    assert.deepEqual((await e.t.api('GET', `/routines/${r.id}`)).activeRun, { id: rr.id, status: 'running' }, 'the routine page shows it as running');
    assert.equal((await e.t.api('GET', `/routines/runs/${rr.id}`)).status, 'running', 'and its receipt');
    assert.equal(e.ctx.store.run(e.engine.getRun(rr.id)!.run_id!)!.status, 'running', 'and its conversation');

    // Alles stoppen stops it; that is not a failure of the routine.
    assert.ok((await e.t.api('POST', '/stop-all', {})).stopped >= 1);
    await e.engine.idle();
    const done = e.engine.getRun(rr.id)!;
    assert.deepEqual([done.status, done.error], ['cancelled', 'Alles gestopt']);
    const after = await e.t.api('GET', `/routines/${r.id}`);
    assert.deepEqual([after.status, after.fail_count, after.activeRun], ['active', 0, null]);
  } finally {
    await e.t.close();
  }
});

test('after three failed runs in a row a routine pauses itself and says why and how to turn it back on; Aanzetten turns it on', async () => {
  const e = await setup();
  try {
    const notes: any[] = [];
    e.ctx.events.subscribe((ev: any) => ev.type === 'notification' && notes.push(ev.data));
    const r = await e.make('Dagrapport');
    for (let i = 1; i <= 3; i++) {
      e.t.script.push({ error: { message: 'Het rapportbestand is onleesbaar', status: 400 } });
      e.engine.claim({ routine: e.engine.routine(r.id)!, key: `${r.id}@fout@${i}`, trigger: 'webhook' });
      e.engine.pump();
      await e.engine.idle();
    }
    const now = await e.t.api('GET', `/routines/${r.id}`);
    assert.equal(now.status, 'paused');
    assert.match(now.paused_reason, /^Automatisch gepauzeerd na 3 mislukte runs op rij\. Laatste fout: .*onleesbaar/);
    const note = notes.find((n) => n.title === 'Routine “Dagrapport” gepauzeerd');
    assert.ok(note, notes.map((n) => n.title).join(' | '));
    assert.equal(note.link, `#/m/routines/r/${r.id}`, 'it opens the routine, where Aanzetten is');
    assert.match(note.body, /^Gepauzeerd na 3 mislukte runs op rij, zodat hij niet blijft mislukken\. Zet hem weer aan met Aanzetten zodra het probleem is opgelost\. Laatste fout: .*onleesbaar/);
    const on = await e.t.api('POST', `/routines/${r.id}/resume`, {});
    assert.deepEqual([on.status, on.fail_count, on.paused_reason], ['active', 0, null]);
  } finally {
    await e.t.close();
  }
});

test('projects: no maximum in the sprint by default; the owner may set one, and a waiting project moves up once it no longer holds', async () => {
  const t = await startTestApp();
  try {
    await t.agent({ name: 'Sem', role: 'SEO' });
    for (const n of ['A', 'B', 'C', 'D']) assert.equal((await t.api('POST', '/proactive/projects', { naam: `Project ${n}`, doel: 'x' })).project.status, 'sprint', `Project ${n} (the old maximum was 3)`);
    assert.equal((await t.api('GET', '/proactive/settings')).settings.maxSprint, 0, 'a setting, off by default');
    await t.api('PUT', '/proactive/settings', { maxSprint: 4 });
    const e5 = await t.api('POST', '/proactive/projects', { naam: 'Project E', doel: 'x' });
    assert.equal(e5.project.status, 'wacht');
    assert.match(e5.note, /wacht: er zitten al 4 projecten in de sprint/);
    await t.api('PUT', '/proactive/settings', { maxSprint: 0 });
    const list = (await t.api('GET', '/proactive/projects')).projects;
    assert.equal(list.find((p: any) => p.naam === 'Project E').status, 'sprint');
  } finally {
    await t.close();
  }
});

test('what was the old default becomes "none": 30 minutes per routine run and 3 projects in the sprint; a value the owner chose stays', async () => {
  const e = await setup();
  try {
    const old = await e.make('Oud', { options: { timeoutMinutes: 30 } });
    const own = await e.make('Eigen keuze', { options: { timeoutMinutes: 45 } });
    // As 0.4.4 stored them: the old default written into the routine, and into the proactive settings.
    e.ctx.store.update('routines', old.id, { options: { ...e.engine.routine(old.id)!.options, timeoutMinutes: 30 } });
    e.ctx.store.setSetting(e.userId, 'proactive', { runsPerDay: 0, cheapFirst: false, maxSprint: 3, briefing: 'uit', interests: '' });
    e.ctx.store.setSetting('ander', 'proactive', { runsPerDay: 0, cheapFirst: false, maxSprint: 2, briefing: 'uit', interests: '' });
    // Statement by statement (store.exec runs one; the migration runner runs the whole text).
    for (const sql of migrations.find((m) => m.id === 'routines-005')!.sql.split(';').filter((x) => x.trim())) e.ctx.store.exec(sql);
    assert.deepEqual([e.engine.routine(old.id)!.options.timeoutMinutes, e.engine.routine(own.id)!.options.timeoutMinutes], [0, 45]);
    assert.deepEqual([e.ctx.store.getSetting<any>(e.userId, 'proactive', {}).maxSprint, e.ctx.store.getSetting<any>('ander', 'proactive', {}).maxSprint], [0, 2]);
  } finally {
    await e.t.close();
  }
});
