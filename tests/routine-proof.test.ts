// Routines with proof (plan 0.4 §G): "klaar" is only geslaagd with a result; a failing routine and a run that never
// happened are reported within 5 minutes; nothing fails silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp, type TestApp } from './helpers.js';
import { createRoutinesModule } from '../server/modules/routines/index.js';
import type { RoutineEngine } from '../server/modules/routines/engine.js';
import { gatherProof, isBareClaim } from '../server/modules/routines/proof.js';

const TZ = 'Europe/Amsterdam';

interface Env {
  t: TestApp;
  engine: RoutineEngine;
  clock: { now: number };
  events: any[];
  notes(): any[];
}

async function setup(start = '2026-11-09T06:00:00Z'): Promise<Env> {
  const clock = { now: Date.parse(start) };
  const t = await startTestApp({ modules: [createRoutinesModule({ clock: () => clock.now, tickMs: 0 })] });
  const engine: RoutineEngine = t.app.ctx.services.routines.engine;
  const events: any[] = [];
  t.app.ctx.events.subscribe((e) => events.push(e));
  return { t, engine, clock, events, notes: () => events.filter((e) => e.type === 'notification' && e.data.kind === 'routine').map((e) => ({ ...e.data, at: e.at })) };
}

const runsOf = (env: Env, routineId: string) => env.t.app.ctx.store.all<any>('SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY created_at', routineId).map((r) => env.t.app.ctx.store.decode('routine_runs', r));

async function runNow(env: Env, routineId: string) {
  const rr = await env.t.api('POST', `/routines/${routineId}/run`, { test: false });
  await env.engine.idle();
  return env.engine.getRun(rr.id)!;
}

test('the answer itself: a bare "klaar" is no result, a reminder or summary is', () => {
  for (const s of ['Klaar.', 'Klaar!', 'Gedaan ✅', 'OK', '✅', 'Taak uitgevoerd.', 'De taak is afgerond', 'Done!', '', 'a']) assert.equal(isBareClaim(s), true, s);
  for (const s of ['Vergeet de container niet!', 'Het weer morgen: 12 graden en regen.', 'ingehaald', '3 nieuwe berichten in je feed: …']) assert.equal(isBareClaim(s), false, s);
});

test('"klaar" without any result shows zonder resultaat, with a notification; a real answer is geslaagd', async () => {
  const env = await setup();
  try {
    const a = await env.t.agent();
    const r = await env.t.api('POST', '/routines', { name: 'Rapport', agent_id: a.id, prompt: 'Maak het weekrapport.', timezone: TZ, schedule: { kind: 'none' } });

    env.t.script.push({ text: 'Klaar!' });
    let rr = await runNow(env, r.id);
    assert.equal(rr.status, 'done', 'the engine finished without an error …');
    assert.equal(rr.meta.proof.result, 'none', '… but there is no result');
    assert.match(rr.meta.proof.reason, /maar er is geen resultaat: geen bestand, bericht of taak, en geen inhoudelijk antwoord/);
    let routine = env.engine.routine(r.id)!;
    assert.equal(routine.last_status, 'no_result');
    let n = env.notes().at(-1);
    assert.equal(n.title, 'Routine “Rapport”: zonder resultaat');
    assert.equal(n.level, 'warn', 'counts as important (alerts even when only important ones do)');

    // The bot says it saved a file, but never wrote one: still no result, and the receipt says what is missing.
    env.t.script.push({ text: 'Ik heb het weekrapport opgeslagen als weekrapport.md.' });
    rr = await runNow(env, r.id);
    assert.equal(rr.meta.proof.result, 'none');
    assert.deepEqual(rr.meta.proof.claims, ['een opgeslagen bestand']);
    assert.match(rr.meta.proof.reason, /meldde een opgeslagen bestand, maar TeamBot zag dat niet gebeuren/);

    // A real answer is the result of a reminder or summary routine.
    env.t.script.push({ text: 'Weekrapport: 12 nieuwe klanten, 3 offertes open, omzet 4.200 euro.' });
    rr = await runNow(env, r.id);
    assert.equal(rr.meta.proof.result, 'answer');
    routine = env.engine.routine(r.id)!;
    assert.equal(routine.last_status, 'done');
    n = env.notes().at(-1);
    assert.equal(n.title, 'Rapport');

    // History filter and the overview count tell them apart.
    const none = await env.t.api('GET', `/routines/${r.id}/runs?status=no_result`);
    assert.equal(none.length, 2);
    const ok = await env.t.api('GET', `/routines/${r.id}/runs?status=done`);
    assert.equal(ok.length, 1);
    const sum = await env.t.api('GET', '/routines/runs/summary?hours=24');
    assert.equal(sum.counts.no_result, 2);
    assert.equal(sum.counts.done, 1);
    const att = await env.t.api('GET', '/routines/attention?hours=24');
    assert.equal(att.items.filter((i: any) => i.kind === 'no_result').length, 2);
  } finally {
    await env.t.close();
  }
});

test('a written file, a sent message or a created task is proof; a file a CLI wrote on its own counts too', async () => {
  const env = await setup();
  try {
    const a = await env.t.agent({ tool_groups: ['files'] });
    const r = await env.t.api('POST', '/routines', { name: 'Notulen', agent_id: a.id, prompt: 'Schrijf de notulen.', timezone: TZ, schedule: { kind: 'none' } });
    env.t.script.push({ toolCalls: [{ name: 'write_file', args: { path: 'notulen.md', content: '# Notulen' } }] }, { text: 'Klaar.' });
    let rr = await runNow(env, r.id);
    assert.equal(rr.meta.proof.result, 'proven');
    assert.deepEqual(rr.meta.proof.items, [{ kind: 'file', text: 'notulen.md geschreven' }]);
    assert.equal(env.engine.routine(r.id)!.last_status, 'done');

    env.t.script.push({ toolCalls: [{ name: 'notify_user', args: { title: 'Notulen', message: 'Staan klaar' } }] }, { text: 'Gemeld.' });
    rr = await runNow(env, r.id);
    assert.equal(rr.meta.proof.result, 'proven');
    assert.deepEqual(rr.meta.proof.items, [{ kind: 'message', text: 'Melding: Staan klaar' }], 'the file of the previous run does not count again');

    // Like Claude Code writing a file itself: no TeamBot tool, but the bot's folder shows the change.
    const ws = env.t.app.ctx.store.agent(a.id)!.workspace;
    env.t.script.push({ text: 'Klaar.', check: () => fs.writeFileSync(path.join(ws, 'zelf-geschreven.md'), 'x') });
    rr = await runNow(env, r.id);
    assert.equal(rr.meta.proof.result, 'proven');
    assert.deepEqual(rr.meta.proof.items, [{ kind: 'file', text: 'zelf-geschreven.md gewijzigd' }]);
  } finally {
    await env.t.close();
  }
});

test('a deliberately failing routine produces a notification within 5 minutes (first failure, not after the last retry)', async () => {
  const env = await setup('2026-11-09T06:58:00Z'); // 07:58 in Amsterdam
  try {
    const a = await env.t.agent();
    const r = await env.t.api('POST', '/routines', { name: 'Ochtendrapport', agent_id: a.id, prompt: 'Vat mijn ochtend samen.', timezone: TZ, schedule: { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], times: ['08:00'] }, options: { retries: 2 } });
    env.t.script.push({ error: { message: 'Mock: 503 unavailable', status: 503 } });
    env.clock.now = Date.parse('2026-11-09T07:00:05Z');
    env.engine.tick();
    await env.engine.idle();
    const rr = runsOf(env, r.id)[0];
    assert.equal(rr.status, 'retrying', 'it will try again …');
    const n = env.notes().find((x) => x.title === 'Routine “Ochtendrapport” mislukt');
    assert.ok(n, '… but the owner hears about it now');
    assert.equal(n.level, 'error');
    assert.match(n.body, /Nieuwe poging 2 van 3 om/);
    assert.ok(env.clock.now - Date.parse('2026-11-09T07:00:00Z') < 5 * 60_000, 'within 5 minutes of the planned time');

    // A bot that no longer exists: the run cannot even start, and that is said too.
    const b = await env.t.agent({ name: 'Weg' });
    const r2 = await env.t.api('POST', '/routines', { name: 'Zonder bot', agent_id: b.id, prompt: 'x', timezone: TZ, schedule: { kind: 'none' } });
    env.t.app.ctx.store.exec('UPDATE routines SET agent_id = ? WHERE id = ?', 'agt_bestaatniet', r2.id);
    await env.t.api('POST', `/routines/${r2.id}/run`, { test: false });
    await env.engine.idle();
    assert.ok(env.notes().some((x) => x.title === 'Routine “Zonder bot” mislukt' && /bestaat niet meer/.test(x.body)));
  } finally {
    await env.t.close();
  }
});

test('watchdog: a scheduled run that did not happen is reported ("verwacht om 08:00, niet gedraaid"), once, within 5 minutes', async () => {
  const env = await setup('2026-11-09T06:00:00Z');
  try {
    const a = await env.t.agent();
    const daily = { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], times: ['08:00'] };
    const r = await env.t.api('POST', '/routines', { name: 'Ochtend', agent_id: a.id, prompt: 'Goedemorgen zeggen.', timezone: TZ, schedule: daily });
    const ok = await env.t.api('POST', '/routines', { name: 'Gewoon', agent_id: a.id, prompt: 'Iets zeggen.', timezone: TZ, schedule: daily });
    assert.equal(r.next_run_at, '2026-11-09T07:00:00.000Z');
    // A planner bug: the next run of "Ochtend" was moved past today's 08:00.
    env.t.app.ctx.store.update('routines', r.id, { next_run_at: '2026-11-10T07:00:00.000Z' });
    env.t.script.push({ text: 'Goedemorgen, er staan 2 afspraken in je agenda.' });
    env.clock.now = Date.parse('2026-11-09T07:00:10Z');
    env.engine.tick(); // "Gewoon" runs normally
    await env.engine.idle();
    env.clock.now = Date.parse('2026-11-09T07:04:00Z');
    env.engine.tick();
    assert.equal(runsOf(env, r.id).length, 0, 'not yet: 4 minutes late is still in time');
    env.clock.now = Date.parse('2026-11-09T07:05:30Z');
    env.engine.tick();
    await env.engine.idle();
    const rows = runsOf(env, r.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'missed');
    assert.equal(rows[0].meta.notRun, true);
    assert.equal(rows[0].scheduled_for, '2026-11-09T07:00:00.000Z');
    assert.match(rows[0].summary, /^Verwacht om 08:00 \(ma 9 nov\), niet gedraaid\. De planner sloeg deze run over\./);
    const n = env.notes().filter((x) => /niet gedraaid/.test(x.title));
    assert.equal(n.length, 1);
    assert.equal(n[0].title, 'Routine “Ochtend” niet gedraaid');
    assert.equal(n[0].body, 'Verwacht om 08:00 (ma 9 nov), niet gedraaid.');
    assert.equal(n[0].level, 'error');
    assert.equal(runsOf(env, ok.id).filter((x) => x.status === 'missed').length, 0, 'a run that did happen is never reported');
    // Later checks do not report it again.
    env.clock.now = Date.parse('2026-11-09T07:30:00Z');
    env.engine.tick();
    env.clock.now = Date.parse('2026-11-09T08:30:00Z');
    env.engine.tick();
    assert.equal(runsOf(env, r.id).length, 1);
    assert.equal(env.notes().filter((x) => /niet gedraaid/.test(x.title)).length, 1);
    const att = await env.t.api('GET', '/routines/attention?hours=24');
    assert.ok(att.items.some((i: any) => i.kind === 'not_run' && i.name === 'Ochtend'));
    await env.t.api('POST', '/routines/attention/seen', {});
    assert.ok((await env.t.api('GET', '/routines/attention?hours=24')).seenAt);
  } finally {
    await env.t.close();
  }
});

test('watchdog stays quiet for paused routines, the noodrem and runs that were caught up or skipped', async () => {
  const env = await setup('2026-11-09T06:00:00Z');
  try {
    const a = await env.t.agent();
    const hourly = { kind: 'interval', everyMinutes: 60 };
    const p = await env.t.api('POST', '/routines', { name: 'Gepauzeerd', agent_id: a.id, prompt: 'x', timezone: TZ, schedule: hourly });
    await env.t.api('POST', `/routines/${p.id}/pause`, {});
    const s = await env.t.api('POST', '/routines', { name: 'Overslaan', agent_id: a.id, prompt: 'x', timezone: TZ, schedule: hourly, options: { missedPolicy: 'skip' } });
    // TeamBot "slept" for 3 hours: the skip receipt covers all those runs.
    env.clock.now = Date.parse('2026-11-09T09:20:00Z');
    env.engine.tick();
    await env.engine.idle();
    env.clock.now = Date.parse('2026-11-09T09:40:00Z');
    env.engine.tick();
    await env.engine.idle();
    assert.equal(runsOf(env, p.id).length, 0);
    const rows = runsOf(env, s.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'missed');
    assert.equal(rows[0].meta.notRun, undefined, 'the skip receipt, not a watchdog one');
    assert.equal(env.notes().filter((x) => /niet gedraaid/.test(x.title)).length, 0);
  } finally {
    await env.t.close();
  }
});

test('watchdog: a routine paused for a day and resumed is not reported for the runs during the pause', async () => {
  const env = await setup('2026-11-09T06:00:00Z');
  try {
    const a = await env.t.agent();
    const r = await env.t.api('POST', '/routines', { name: 'Pauze', agent_id: a.id, prompt: 'x', timezone: TZ, schedule: { kind: 'interval', everyMinutes: 60 } });
    env.clock.now += 2 * 60_000;
    env.engine.tick(); // watched from here on
    await env.t.api('POST', `/routines/${r.id}/pause`, {});
    for (let h = 1; h <= 26; h++) {
      env.clock.now += 3_600_000;
      env.engine.tick();
    }
    await env.t.api('POST', `/routines/${r.id}/resume`, {});
    env.t.script.push({ text: 'Gedaan: 3 punten bijgewerkt in het overzicht.' });
    for (let m = 1; m <= 90; m += 10) {
      env.clock.now += 10 * 60_000;
      env.engine.tick();
      await env.engine.idle();
    }
    assert.equal(runsOf(env, r.id).filter((x) => x.meta?.notRun).length, 0);
    // The global noodrem the same way.
    await env.t.api('PUT', '/routines/settings', { paused: true });
    for (let h = 1; h <= 5; h++) {
      env.clock.now += 3_600_000;
      env.engine.tick();
    }
    await env.t.api('PUT', '/routines/settings', { paused: false });
    env.clock.now += 20 * 60_000;
    env.engine.tick();
    env.clock.now += 20 * 60_000;
    env.engine.tick();
    await env.engine.idle();
    assert.equal(runsOf(env, r.id).filter((x) => x.meta?.notRun).length, 0);
    assert.equal(env.notes().filter((x) => /niet gedraaid/.test(x.title)).length, 0);
  } finally {
    await env.t.close();
  }
});

test('Alles stoppen also cancels a routine run that waits for its next attempt (nothing starts again later)', async () => {
  const env = await setup();
  try {
    const a = await env.t.agent();
    const r = await env.t.api('POST', '/routines', { name: 'Herhaler', agent_id: a.id, prompt: 'x', timezone: TZ, schedule: { kind: 'none' } });
    env.t.script.push({ error: { message: 'Mock: 503 unavailable', status: 503 } }, { text: 'mag niet meer draaien' });
    const rr = await runNow(env, r.id);
    assert.equal(rr.status, 'retrying');
    await env.t.api('POST', '/stop-all', {});
    assert.equal(env.engine.getRun(rr.id)!.status, 'cancelled');
    assert.equal(env.engine.getRun(rr.id)!.error, 'Alles gestopt');
    env.clock.now += 2 * 3_600_000;
    env.engine.tick();
    await env.engine.idle();
    assert.equal(env.engine.getRun(rr.id)!.status, 'cancelled');
    assert.equal(env.t.script.length, 1, 'the second attempt was never made');
  } finally {
    await env.t.close();
  }
});

test('proof only counts what this bot did during the run', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent();
    // Saying what was not done is no claim that it was: a full report with such a sentence is an answer.
    const said = (text: string) => gatherProof(t.app.ctx, t.app.ctx.store.agent(a.id)!, { fromMs: Date.now(), toMs: Date.now(), text });
    assert.deepEqual([said('Alle 11 sites geven status 200. Ik heb niets gewijzigd en geen testleads verstuurd.').result, said('Ik heb het rapport niet verstuurd.').claims], ['answer', []]);
    assert.deepEqual(said('Alle sites zijn groen. Ik heb het rapport naar de klant verstuurd.').claims, ['een verstuurd bericht']);
    const b = await t.agent({ name: 'Ander' });
    const agent = t.app.ctx.store.agent(a.id)!;
    const from = Date.now();
    t.app.ctx.audit(a.user_id, 'tool.call', { tool: 'channel_send', summary: 'Bericht aan Jan', error: false, denied: false, risk: 'danger' }, b.id);
    t.app.ctx.audit(a.user_id, 'tool.call', { tool: 'channel_send', summary: 'Mislukt bericht', error: true, denied: false, risk: 'danger' }, a.id);
    t.app.ctx.audit(a.user_id, 'tool.call', { tool: 'web_search', summary: 'Zoeken', error: false, denied: false, risk: 'read' }, a.id);
    let p = gatherProof(t.app.ctx, agent, { fromMs: from, toMs: Date.now(), text: 'Klaar' });
    assert.equal(p.result, 'none', 'another bot, a failed call and a search are no proof');
    t.app.ctx.audit(a.user_id, 'tool.call', { tool: 'task_create', summary: 'Taak: offerte nabellen', error: false, denied: false, risk: 'write' }, a.id);
    p = gatherProof(t.app.ctx, agent, { fromMs: from, toMs: Date.now(), text: 'Klaar' });
    assert.equal(p.result, 'proven');
    assert.deepEqual(p.items, [{ kind: 'task', text: 'Taak: offerte nabellen' }]);
  } finally {
    await t.close();
  }
});
