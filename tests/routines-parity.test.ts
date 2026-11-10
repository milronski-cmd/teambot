import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers.js';
import { createRoutinesModule } from '../server/modules/routines/index.js';
import type { RoutineEngine } from '../server/modules/routines/engine.js';
import * as S from '../server/modules/routines/schedule.js';
import { isQuotaWindow, isUsageLimit, parseDuration, parseLimitReset } from '../server/modules/routines/limits.js';

/** Routines on OpenBot level: monthly schedules, wait for an engine limit reset, main chat, delivery, chains. */

const TZ = 'Europe/Amsterdam';
const iso = (ms: number) => new Date(ms).toISOString();
const at = (s: string) => Date.parse(s);

interface Env {
  t: TestApp;
  engine: RoutineEngine;
  clock: { now: number };
  events: any[];
}

async function setup(start = '2026-11-09T10:00:00Z'): Promise<Env> {
  const clock = { now: Date.parse(start) };
  const t = await startTestApp({ modules: [createRoutinesModule({ clock: () => clock.now, tickMs: 0 })] });
  const engine: RoutineEngine = t.app.ctx.services.routines.engine;
  const events: any[] = [];
  t.app.ctx.events.subscribe((e) => events.push(e));
  return { t, engine, clock, events };
}

const run = (env: Env, id: string) => env.engine.getRun(id)!;
const mk = (env: Env, agentId: string, extra: any = {}) => env.t.api('POST', '/routines', { name: 'R', agent_id: agentId, prompt: 'Doe het werk.', timezone: TZ, schedule: { kind: 'none' }, ...extra });

// ---------------------------------------------------------------------------- monthly schedules

test('monthly schedules: day of month, last (work)day, nth weekday, quarters — DST and other zones', () => {
  const now = at('2026-11-07T12:00:00Z');
  const next = (s: any, from: string, n = 1, tz = TZ) => S.nextRuns(S.normalizeSchedule({ kind: 'monthly', ...s }, tz, now), tz, at(from), n).map(iso);
  // The 31st falls on the last day of shorter months (also February in a leap year).
  assert.deepEqual(next({ days: [31], times: ['09:00'] }, '2027-01-31T12:00:00Z', 3), ['2027-02-28T08:00:00.000Z', '2027-03-31T07:00:00.000Z', '2027-04-30T07:00:00.000Z']);
  assert.deepEqual(next({ days: [31], times: ['09:00'] }, '2028-02-01T00:00:00Z'), ['2028-02-29T08:00:00.000Z']);
  // Last day / last and first workday (Mon–Fri): Jan 2027 ends on a Sunday, Nov 2026 starts on a Sunday.
  assert.deepEqual(next({ days: ['L'], times: ['17:00'] }, '2026-11-07T12:00:00Z'), ['2026-11-30T16:00:00.000Z']);
  assert.deepEqual(next({ days: ['LW'], times: ['17:00'] }, '2026-12-31T17:00:00Z'), ['2027-01-29T16:00:00.000Z']);
  assert.deepEqual(next({ days: ['FW'], times: ['08:30'] }, '2026-10-31T00:00:00Z'), ['2026-11-02T07:30:00.000Z']);
  // nth weekday: first Monday, third Wednesday, last Friday.
  assert.deepEqual(next({ days: ['1MO'], times: ['09:00'] }, '2026-11-07T12:00:00Z'), ['2026-12-07T08:00:00.000Z']);
  assert.deepEqual(next({ days: ['3WE'], times: ['09:00'] }, '2026-11-01T00:00:00Z'), ['2026-11-18T08:00:00.000Z']);
  assert.deepEqual(next({ days: ['-1FR'], times: ['16:00'] }, '2026-11-01T00:00:00Z'), ['2026-11-27T15:00:00.000Z']);
  // Several days and times per month, chronological.
  assert.deepEqual(next({ days: [15, 1], times: ['18:00', '09:00'] }, '2026-11-07T12:00:00Z', 3), ['2026-11-15T08:00:00.000Z', '2026-11-15T17:00:00.000Z', '2026-12-01T08:00:00.000Z']);
  // Quarterly: only January, April, July, October.
  assert.deepEqual(next({ days: [1], times: ['09:00'], months: [1, 4, 7, 10] }, '2026-11-07T12:00:00Z', 2), ['2027-01-01T08:00:00.000Z', '2027-04-01T07:00:00.000Z']);
  // DST in Europe/Amsterdam: 09:00 stays 09:00 local (CET +1 → CEST +2 → CET).
  assert.deepEqual(next({ days: ['L'], times: ['09:00'] }, '2026-02-01T00:00:00Z', 3), ['2026-02-28T08:00:00.000Z', '2026-03-31T07:00:00.000Z', '2026-04-30T07:00:00.000Z']);
  assert.deepEqual(next({ days: ['L'], times: ['09:00'] }, '2026-10-01T00:00:00Z'), ['2026-10-31T08:00:00.000Z']);
  // Last Sunday 02:30 does not exist on 29 March 2026 (moves to 03:30 CEST) and exists twice on 25 October (first one).
  assert.deepEqual(next({ days: ['-1SU'], times: ['02:30'] }, '2026-03-01T00:00:00Z'), ['2026-03-29T01:30:00.000Z']);
  assert.deepEqual(next({ days: ['-1SU'], times: ['02:30'] }, '2026-10-01T00:00:00Z'), ['2026-10-25T00:30:00.000Z']);
  // Another zone: New York switches on 1 November 2026 and 14 March 2027.
  assert.deepEqual(next({ days: [1], times: ['09:00'] }, '2026-10-15T00:00:00Z', 6, 'America/New_York'), [
    '2026-11-01T14:00:00.000Z',
    '2026-12-01T14:00:00.000Z',
    '2027-01-01T14:00:00.000Z',
    '2027-02-01T14:00:00.000Z',
    '2027-03-01T14:00:00.000Z',
    '2027-04-01T13:00:00.000Z',
  ]);
  // Validation and Dutch descriptions.
  assert.throws(() => S.normalizeSchedule({ kind: 'monthly', days: [32], times: ['09:00'] }, TZ, now), /dag van de maand/);
  assert.throws(() => S.normalizeSchedule({ kind: 'monthly', days: ['5MO'], times: ['09:00'], months: [2] }, TZ, at('2027-03-01T00:00:00Z')), (e: any) => e instanceof S.ScheduleError || /nooit/.test(e.message));
  assert.throws(() => S.normalizeSchedule({ kind: 'monthly', days: [1], times: [] }, TZ, now), /tijd/);
  const d = (s: any) => S.describeSchedule(S.normalizeSchedule({ kind: 'monthly', ...s }, TZ, now), TZ);
  assert.equal(d({ days: ['LW'], times: ['17:00'] }), 'Elke maand op de laatste werkdag om 17:00');
  assert.equal(d({ days: ['laatste vr'], times: ['16:00'] }), 'Elke maand op de laatste vrijdag om 16:00');
  assert.equal(d({ days: ['1ma'], times: ['09:00'] }), 'Elke maand op de eerste maandag om 09:00');
  assert.equal(d({ days: [1, 15], times: ['09:00'], months: [1, 4, 7, 10] }), 'In jan, apr, jul en okt op de 1e en de 15e om 09:00');
  assert.ok(S.runsPerDay(S.normalizeSchedule({ kind: 'monthly', days: [1], times: ['09:00'] }, TZ, now), TZ, now) < 1);
});

// ---------------------------------------------------------------------------- limit texts

test('engine limit texts: recognised, and the reset time is found (epoch, clock + zone, relative, dates)', () => {
  const now = at('2026-11-07T12:00:00Z'); // 13:00 in Amsterdam
  assert.equal(parseLimitReset('Claude AI usage limit reached|1762534800', at('2025-11-01T00:00:00Z')), 1762534800000);
  assert.equal(iso(parseLimitReset("5-hour limit reached ∙ resets 5pm (Europe/Amsterdam)", now)!), '2026-11-07T16:00:00.000Z');
  assert.equal(iso(parseLimitReset("You've hit your limit · resets 5pm", now, TZ)!), '2026-11-07T16:00:00.000Z');
  // Past that time today → tomorrow.
  assert.equal(iso(parseLimitReset("You've hit your limit · resets 5pm", at('2026-11-07T17:30:00Z'), TZ)!), '2026-11-08T16:00:00.000Z');
  assert.equal(iso(parseLimitReset('Limit reached. Resets at 17:30.', now, TZ)!), '2026-11-07T16:30:00.000Z');
  assert.equal(parseLimitReset('Rate limit reached for gpt-x. Please try again in 6m12.5s. Visit …', now), now + 372_500);
  assert.equal(parseLimitReset("You've hit your usage limit. Upgrade to Pro or try again in 2 hours 13 minutes.", now), now + (2 * 60 + 13) * 60_000);
  assert.equal(parseLimitReset('429 Too Many Requests (Retry-After: 120)', now), now + 120_000);
  assert.equal(parseLimitReset('Anthropic: 429 rate_limit_error (limiet bereikt of tegoed op) (opnieuw mogelijk over 45 s)', now), now + 45_000);
  assert.equal(iso(parseLimitReset("You've hit your usage limit. Try again at Nov 10th, 2026 3:25 PM.", now, TZ)!), '2026-11-10T14:25:00.000Z');
  assert.equal(iso(parseLimitReset('weekly limit reached, resets Nov 10, 9am', now, TZ)!), '2026-11-10T08:00:00.000Z');
  assert.equal(iso(parseLimitReset('quota exceeded; reset at 2026-11-07T18:00:00Z', now)!), '2026-11-07T18:00:00.000Z');
  assert.equal(parseLimitReset('Mock: 429 rate limited', now), null);
  assert.equal(parseDuration('4 days 3 hours'), (4 * 24 + 3) * 3_600_000);
  // What is (and is not) an engine limit.
  assert.ok(isUsageLimit('Mock: 429 rate limited'));
  assert.ok(!isQuotaWindow('Mock: 429 rate limited'));
  assert.ok(isQuotaWindow('Gebruikslimiet van je Claude-abonnement of account bereikt. Probeer het later opnieuw. Claude AI usage limit reached|1762534800'));
  assert.ok(!isUsageLimit('Daglimiet van $2.00 bereikt (vandaag $2.10 gebruikt).'));
  assert.ok(!isUsageLimit('OpenAI: 429 You exceeded your current quota, please check your plan and billing details.'));
  assert.ok(!isUsageLimit('Iets anders ging mis'));
});

// ---------------------------------------------------------------------------- wait for the reset

test('limit policy "wait": the run waits for the reset (no attempt used), other routines on that engine wait without calling it', async () => {
  const env = await setup('2026-11-09T10:00:00Z'); // 11:00 in Amsterdam
  try {
    const a = await env.t.agent();
    const r1 = await mk(env, a.id, { name: 'Een' });
    const r2 = await mk(env, a.id, { name: 'Twee' });
    env.t.script.push({ error: { message: "Mock: 429 You've hit your usage limit · resets 3pm (Europe/Amsterdam)", status: 429 } }, { text: 'gelukt na reset' }, { text: 'twee ook' });
    const rr1 = await env.t.api('POST', `/routines/${r1.id}/run`, {});
    await env.engine.idle();
    let row = run(env, rr1.id);
    assert.equal(row.status, 'retrying');
    assert.equal(row.attempt, 1, 'a limit wait does not use up a retry');
    assert.equal(row.next_retry_at, '2026-11-09T14:00:15.000Z');
    assert.equal(row.meta.limitWait.count, 1);
    assert.ok(env.t.app.ctx.store.messages(row.thread_id!).some((m) => m.role === 'event' && /wacht tot/.test(m.content)));
    // Another routine on the same engine waits right away, without calling the engine again.
    const rr2 = await env.t.api('POST', `/routines/${r2.id}/run`, {});
    await env.engine.idle();
    assert.equal(run(env, rr2.id).status, 'retrying');
    assert.ok(run(env, rr2.id).meta.limitWait);
    assert.equal(env.t.requests.length, 1);
    // One notification for both.
    assert.equal(env.events.filter((e) => e.type === 'notification' && /Limiet van de AI-engine/.test(e.data.title)).length, 1);
    // The overview shows them as waiting.
    const sum = await env.t.api('GET', '/routines/runs/summary');
    assert.equal(sum.waiting.length, 2);
    assert.equal(sum.counts.retrying, 2);
    // Not before the reset …
    env.clock.now = at('2026-11-09T13:59:00Z');
    env.engine.tick();
    await env.engine.idle();
    assert.equal(run(env, rr1.id).status, 'retrying');
    // … and after it both continue.
    env.clock.now = at('2026-11-09T14:01:00Z');
    env.engine.tick();
    await env.engine.idle();
    row = run(env, rr1.id);
    assert.equal(row.status, 'done');
    assert.equal(row.summary, 'gelukt na reset');
    assert.equal(run(env, rr2.id).status, 'done');
    assert.equal(env.t.requests.length, 3);
    assert.ok(env.t.app.ctx.store.messages(row.thread_id!).some((m) => /De limiet is voorbij/.test(m.content)));
  } finally {
    await env.t.close();
  }
});

test('limit policy "skip" and the maximum waiting time; a short rate limit first uses the normal retries', async () => {
  const env = await setup('2026-11-09T10:00:00Z');
  try {
    const a = await env.t.agent();
    const skip = await mk(env, a.id, { name: 'Overslaan', options: { limitPolicy: 'skip' } });
    env.t.script.push({ error: { message: 'Mock: 429 usage limit reached, try again in 3 hours', status: 429 } });
    const rs = await env.t.api('POST', `/routines/${skip.id}/run`, {});
    await env.engine.idle();
    assert.equal(run(env, rs.id).status, 'skipped');
    assert.match(run(env, rs.id).summary, /limiet van de AI-engine/);
    assert.equal(env.engine.routine(skip.id)!.fail_count, 0);

    // Waiting longer than allowed (reset in 3 days, max 2 hours) → a normal failure.
    env.clock.now = at('2026-11-09T18:00:00Z'); // past the block of the first engine limit
    const far = await mk(env, a.id, { name: 'Te lang', options: { maxLimitWaitHours: 2, retries: 0 } });
    env.t.script.push({ error: { message: 'Mock: 429 weekly limit reached, try again in 3 days', status: 429 } });
    const rf = await env.t.api('POST', `/routines/${far.id}/run`, {});
    await env.engine.idle();
    assert.equal(run(env, rf.id).status, 'error');
    assert.match(run(env, rf.id).error!, /nog steeds niet gelukt/);

    // A plain 429 without a reset time: backoff retry first (as before), then waiting instead of failing.
    env.clock.now = at('2026-11-14T10:00:00Z');
    const plain = await mk(env, a.id, { name: 'Kort', options: { retries: 1 } });
    env.t.script.push({ error: { message: 'Mock: 429 rate limited', status: 429 } }, { error: { message: 'Mock: 429 rate limited', status: 429 } }, { text: 'eindelijk' });
    const rp = await env.t.api('POST', `/routines/${plain.id}/run`, {});
    await env.engine.idle();
    assert.equal(run(env, rp.id).status, 'retrying');
    assert.equal(run(env, rp.id).attempt, 2);
    assert.ok(!run(env, rp.id).meta.limitWait);
    env.clock.now += 3_600_000;
    env.engine.tick();
    await env.engine.idle();
    assert.equal(run(env, rp.id).status, 'retrying');
    assert.equal(run(env, rp.id).meta.limitWait.count, 1, 'retries used up: now it waits (15 min)');
    env.clock.now += 20 * 60_000;
    env.engine.tick();
    await env.engine.idle();
    assert.equal(run(env, rp.id).status, 'done');
  } finally {
    await env.t.close();
  }
});

// ---------------------------------------------------------------------------- main chat, delivery, chains

test('run in the main chat: keeps the chat context, quiet runs disappear from the chat, deleting never removes the chat', async () => {
  const env = await setup();
  try {
    const a = await env.t.agent();
    const main = await env.t.api('POST', '/threads', { agentId: a.id });
    env.t.script.push({ text: 'Hallo Sanne' });
    await env.t.say(main.id, 'Onthoud: de klant heet Jansen.');
    const r = await mk(env, a.id, { name: 'Ochtend', options: { runIn: 'main' } });
    env.t.script.push({ text: 'Goedemorgen, Jansen belt om 10:00.' });
    const rr = await env.t.api('POST', `/routines/${r.id}/run`, {});
    await env.engine.idle();
    const row = run(env, rr.id);
    assert.equal(row.status, 'done');
    assert.equal(row.thread_id, main.id, 'ran in the main chat');
    assert.equal(env.engine.routine(r.id)!.thread_id, null);
    // The routine turn saw the earlier chat (no fresh context) and got the quiet-path instructions.
    const req = env.t.requests.at(-1)!;
    assert.match(JSON.stringify(req.messages), /klant heet Jansen/);
    assert.match(JSON.stringify(req.messages), /routine_no_update/);
    assert.ok(req.tools.some((x) => x.name === 'routine_no_update'), 'quiet-path tool offered in the main chat');
    assert.equal(env.t.app.ctx.store.messages(main.id).filter((m) => m.role === 'assistant').at(-1)!.content, 'Goedemorgen, Jansen belt om 10:00.');
    // A quiet run leaves no trace in the chat (receipt only).
    env.t.script.push({ toolCalls: [{ name: 'routine_no_update', args: { reason: 'niets nieuws' } }] }, { text: 'Niets te melden.' });
    const before = env.t.app.ctx.store.messages(main.id).length;
    const rq = await env.t.api('POST', `/routines/${r.id}/run`, {});
    await env.engine.idle();
    assert.equal(run(env, rq.id).status, 'no_update');
    assert.equal(env.t.app.ctx.store.messages(main.id).length, before);
    // Outside a routine run the tool is not offered in the main chat.
    assert.ok(!(await env.t.app.ctx.tools.forAgent(env.t.app.ctx.store.agent(a.id)!, env.t.app.ctx.store.thread(main.id)!)).some((x) => x.name === 'routine_no_update'));
    await env.t.api('DELETE', `/routines/${r.id}?deleteThread=1`);
    assert.ok(env.t.app.ctx.store.thread(main.id));
  } finally {
    await env.t.close();
  }
});

test('deliver the result to a chat app (recorded on the receipt), and routine chains A → B with loop protection', async () => {
  const env = await setup();
  try {
    const sent: any[] = [];
    let fail = false;
    env.t.app.ctx.services.channels = {
      bindings: () => [{ id: 'cb_1', name: 'Mijn Telegram', adapter: 'telegram', enabled: true }],
      manager: { conversation: (id: string) => (id === 'cv_1' ? { id: 'cv_1', binding_id: 'cb_1', title: 'Sanne' } : null), conversations: () => [{ id: 'cv_1', title: 'Sanne', is_private: true }] },
      deliver: async (o: any) => {
        if (fail) throw new Error('Kanaal is niet verbonden');
        sent.push(o);
        return ['m1'];
      },
    };
    const a = await env.t.agent();
    // a channel that is gone (or not yours) simply means "don't forward"; an unknown conversation is refused
    const gone = await mk(env, a.id, { options: { deliver: { bindingId: 'cb_x', to: 'owner' } } });
    assert.equal(gone.options.deliver, null);
    await assert.rejects(mk(env, a.id, { options: { deliver: { bindingId: 'cb_1', to: 'cv_9' } } }), /bestaat niet/);

    const b = await mk(env, a.id, { name: 'B · rapport' });
    const ra = await mk(env, a.id, { name: 'A · cijfers', options: { deliver: { bindingId: 'cb_1', to: 'owner', errors: true }, then: { routineId: b.id, on: 'done', passResult: true } } });
    // B → A would close a loop: refused when it is set up, with the loop named (A-73).
    await assert.rejects(env.t.api('PATCH', `/routines/${b.id}`, { options: { then: { routineId: ra.id, on: 'always' } } }), /Dit maakt een kring: B · rapport → A · cijfers → B · rapport/);
    await assert.rejects(env.t.api('PATCH', `/routines/${ra.id}`, { options: { then: { routineId: ra.id } } }), /zichzelf/);
    // Longer loops too (C → A when A → B → C), also when a bot sets it up through its routine tools (same validation).
    const c = await mk(env, a.id, { name: 'C · archief' });
    await env.t.api('PATCH', `/routines/${b.id}`, { options: { then: { routineId: c.id, on: 'always' } } });
    await assert.rejects(env.t.api('PATCH', `/routines/${c.id}`, { options: { then: { routineId: ra.id } } }), /kring: C · archief → A · cijfers → B · rapport → C · archief/);
    await env.t.api('PATCH', `/routines/${b.id}`, { options: { then: null } });
    // A loop that already exists in old data (saved before this check) is still stopped at run time: the safety net.
    const bRow = env.t.app.ctx.store.get<any>('routines', b.id);
    env.t.app.ctx.store.update('routines', b.id, { options: { ...bRow.options, then: { routineId: ra.id, on: 'always', passResult: true } } });
    env.t.script.push({ text: 'Omzet vandaag: 1234 euro' }, { text: 'Rapport klaar op basis van 1234 euro' });
    const rr = await env.t.api('POST', `/routines/${ra.id}/run`, {});
    await env.engine.idle();
    const rowA = run(env, rr.id);
    assert.equal(rowA.status, 'done');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].bindingId, 'cb_1');
    assert.equal(sent[0].owner, true);
    assert.match(sent[0].text, /A · cijfers/);
    assert.match(sent[0].text, /1234 euro/);
    assert.equal(rowA.meta.delivery.status, 'sent');
    // B started after A, with A's result as quoted data.
    const rowsB = env.t.app.ctx.store.all<any>('SELECT * FROM routine_runs WHERE routine_id = ?', b.id).map((x) => env.t.app.ctx.store.decode('routine_runs', x));
    assert.equal(rowsB.length, 1);
    assert.equal(rowsB[0].trigger, 'chain');
    assert.equal(rowsB[0].status, 'done');
    assert.equal(rowA.meta.next.runId, rowsB[0].id);
    const bInput = env.t.app.ctx.store.message(rowsB[0].message_id)!.content;
    assert.match(bInput, /Gestart nadat routine “A · cijfers” klaar was/);
    assert.match(bInput, /Omzet vandaag: 1234 euro/);
    assert.match(bInput, /extern_data/);
    // B → A again would be a loop: stopped and recorded on B's receipt; A ran exactly once.
    assert.match(rowsB[0].meta.next.error, /lus/);
    assert.equal(env.t.app.ctx.store.all('SELECT id FROM routine_runs WHERE routine_id = ?', ra.id).length, 1);

    // A failed delivery is recorded and shown, the run itself stays done.
    fail = true;
    env.t.script.push({ text: 'weer cijfers' }, { text: 'weer rapport' });
    const rr2 = await env.t.api('POST', `/routines/${ra.id}/run`, {});
    await env.engine.idle();
    const row2 = run(env, rr2.id);
    assert.equal(row2.status, 'done');
    assert.equal(row2.meta.delivery.status, 'failed');
    assert.match(row2.meta.delivery.error, /niet verbonden/);
    assert.ok(env.t.app.ctx.store.messages(row2.thread_id!).some((m) => /niet doorgestuurd/.test(m.content)));
    // A quiet A (niets nieuws) does not start B when the chain says "only after a result".
    env.t.script.push({ text: 'ROUTINE_NO_UPDATE' });
    const before = env.t.app.ctx.store.all('SELECT id FROM routine_runs WHERE routine_id = ?', b.id).length;
    await env.t.api('POST', `/routines/${ra.id}/run`, {});
    await env.engine.idle();
    assert.equal(env.t.app.ctx.store.all('SELECT id FROM routine_runs WHERE routine_id = ?', b.id).length, before);
  } finally {
    await env.t.close();
  }
});
