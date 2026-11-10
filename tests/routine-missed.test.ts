// "Gemist terwijl je pc uit stond" (plan 0.4 §G): after a pc that was off for days, one honest list per period —
// which routines missed how many runs (first and last), and what TeamBot did (caught up once, or skipped) — plus one
// notification, on top of the existing per-routine choice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTestApp } from './helpers.js';
import { createApp } from '../server/app.js';
import { createRoutinesModule } from '../server/modules/routines/index.js';
import type { RoutineEngine } from '../server/modules/routines/engine.js';
import * as S from '../server/modules/routines/schedule.js';
import notifications from '../server/modules/notifications/index.js';

const TZ = 'Europe/Amsterdam';

test('a pc off for three days: one period, an exact count per routine, caught up or skipped as chosen, one notification', async () => {
  const clock = { now: Date.parse('2026-11-09T05:00:00Z') }; // Monday 06:00 in Amsterdam
  const mk = () => createRoutinesModule({ clock: () => clock.now, tickMs: 0 });
  const t = await startTestApp({ modules: [mk()] });
  let app2: Awaited<ReturnType<typeof createApp>> | null = null;
  try {
    const a = await t.agent();
    const daily = await t.api('POST', '/routines', { name: 'Dagstart', agent_id: a.id, prompt: 'Goedemorgen.', timezone: TZ, schedule: { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], times: ['08:00'] }, options: { missedPolicy: 'skip' } });
    const hourly = await t.api('POST', '/routines', { name: 'Inbox', agent_id: a.id, prompt: 'Check de inbox.', timezone: TZ, schedule: { kind: 'interval', everyMinutes: 60 }, options: { missedPolicy: 'catchup' } });
    const weekly = await t.api('POST', '/routines', { name: 'Weekplan', agent_id: a.id, prompt: 'Maak het weekplan.', timezone: TZ, schedule: { kind: 'weekly', days: ['ma'], times: ['09:00'] }, options: { missedPolicy: 'catchup' } });
    const later = await t.api('POST', '/routines', { name: 'Vrijdag', agent_id: a.id, prompt: 'Vrijdagborrel.', timezone: TZ, schedule: { kind: 'weekly', days: ['vr'], times: ['16:00'] } });
    const e1: RoutineEngine = t.app.ctx.services.routines.engine;
    e1.tick(); // the heartbeat of a running TeamBot
    await e1.idle();
    await t.app.close(); // the pc goes off on Monday at 06:00 …

    clock.now = Date.parse('2026-11-12T09:30:00Z'); // … and comes back on Thursday at 10:30
    const events: any[] = [];
    // With the notification centre, so the notification sent while starting up is kept.
    app2 = await createApp({ dataDir: t.dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true, modules: [mk(), notifications] });
    app2.ctx.providers.registerKind({ id: 'mock', label: 'Mock', type: 'api', needsKey: false, description: 'test', models: ['mock-1'], defaultModel: 'mock-1', create: () => ({ kind: 'mock', listModels: async () => [], test: async () => ({ ok: true }), chat: async (_r: any, _s: any, on: any) => (on({ type: 'text', delta: 'Ingehaald: 3 mails beantwoord.' }), { text: 'Ingehaald: 3 mails beantwoord.', toolCalls: [], usage: { input: 1, output: 1 }, stop: 'end' }) }) } as any);
    app2.ctx.events.subscribe((e) => events.push(e));
    const e2: RoutineEngine = app2.ctx.services.routines.engine;
    // start() already ran its first tick; the routines' catch-up runs happen now.
    await e2.idle();

    const userId = a.user_id;
    const list = e2.watch.missedList(userId, clock.now - 30 * 86_400_000);
    assert.equal(list.periods.length, 1, 'one period without TeamBot');
    const p = list.periods[0];
    assert.equal(p.kind, 'off');
    assert.equal(p.from, '2026-11-09T05:00:00.000Z', 'from the last heartbeat');
    assert.equal(p.to, '2026-11-12T09:30:00.000Z', 'to the start');
    const by = Object.fromEntries(p.items.map((i: any) => [i.name, i]));
    assert.deepEqual(Object.keys(by).sort(), ['Dagstart', 'Inbox', 'Weekplan'], 'Vrijdag had nothing due');

    // Dagstart: Monday, Tuesday, Wednesday and Thursday 08:00 — skipped as chosen.
    assert.equal(by.Dagstart.count, 4);
    assert.equal(by.Dagstart.first, '2026-11-09T07:00:00.000Z');
    assert.equal(by.Dagstart.last, '2026-11-12T07:00:00.000Z');
    assert.equal(by.Dagstart.outcome, 'skipped');
    assert.equal(by.Dagstart.status, 'missed');

    // Inbox: every hour from Monday 07:00 to Thursday 10:00, exactly as the schedule says; caught up once.
    const r = e2.routine(hourly.id)!;
    const expected = S.occurrencesBetween(r.schedule, TZ, Date.parse('2026-11-09T05:00:01Z'), clock.now);
    assert.equal(by.Inbox.count, expected.count);
    assert.equal(by.Inbox.count, 76);
    assert.equal(by.Inbox.outcome, 'caught_up');
    assert.equal(by.Inbox.status, 'done');
    assert.equal(by.Inbox.result, 'answer');
    assert.equal(by.Inbox.last, new Date(expected.last!).toISOString());

    // Weekplan: Monday 09:00 only; caught up once.
    assert.equal(by.Weekplan.count, 1);
    assert.equal(by.Weekplan.first, '2026-11-09T08:00:00.000Z');
    assert.equal(by.Weekplan.outcome, 'caught_up');
    assert.equal(p.routines, 3);
    assert.equal(p.runs, 81);

    // One notification for the whole period, not one per routine.
    const notes = app2.ctx.store.all<any>("SELECT * FROM notifications WHERE title = 'Gemist terwijl je pc uit stond'");
    assert.equal(notes.length, 1);
    assert.equal(notes[0].body, '3 routines: 81 geplande runs gemist sinds ma 9 nov, 06:00 (TeamBot draaide niet). 2 worden nu ingehaald, 1 overgeslagen.');
    assert.equal(notes[0].link, '#/m/routines?gemist=1');
    assert.equal(notes[0].important, 1, 'important: it alerts even when a bot is set to "only important"');
    assert.equal(events.filter((e) => e.type === 'notification' && e.data.title === 'Gemist terwijl je pc uit stond').length, 0, 'and not again later');
    // The watchdog does not repeat these as "niet gedraaid": they are covered.
    clock.now += 20 * 60_000;
    e2.tick();
    await e2.idle();
    assert.equal(app2.ctx.store.all("SELECT id FROM routine_runs WHERE json_extract(meta, '$.notRun') = 1").length, 0);
    assert.equal(e2.routine(later.id)!.next_run_at, '2026-11-13T15:00:00.000Z');

    // Through the API, and "gezien".
    const tok = app2.ctx.auth.ensureLocalOwner();
    const get = async (p2: string, method = 'GET') => (await fetch(`${app2!.url}/api${p2}`, { method, headers: { authorization: `Bearer ${tok}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }, body: method === 'POST' ? '{}' : undefined })).json();
    const api = await get('/routines/missed');
    assert.equal(api.periods.length, 1);
    assert.equal(api.seenAt, null);
    await get('/routines/missed/seen', 'POST');
    assert.ok((await get('/routines/missed')).seenAt);
    assert.ok(daily && weekly);
  } finally {
    if (app2) await app2.close();
    fs.rmSync(t.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('asleep while TeamBot runs: the gap between two ticks is a period too, with the missed runs in it', async () => {
  const clock = { now: Date.parse('2026-11-09T06:00:00Z') };
  const t = await startTestApp({ modules: [createRoutinesModule({ clock: () => clock.now, tickMs: 0 })] });
  try {
    const engine: RoutineEngine = t.app.ctx.services.routines.engine;
    const a = await t.agent();
    await t.api('POST', '/routines', { name: 'Elk kwartier', agent_id: a.id, prompt: 'x', timezone: TZ, schedule: { kind: 'interval', everyMinutes: 15 }, options: { missedPolicy: 'skip' } });
    engine.tick();
    clock.now += 90 * 60_000; // the laptop lid was closed for an hour and a half
    engine.tick();
    await engine.idle();
    const list = engine.watch.missedList(a.user_id, clock.now - 86_400_000);
    assert.equal(list.periods.length, 1);
    assert.equal(list.periods[0].kind, 'sleep');
    assert.equal(list.periods[0].items[0].count, 6);
    assert.equal(list.periods[0].items[0].outcome, 'skipped');
  } finally {
    await t.close();
  }
});
