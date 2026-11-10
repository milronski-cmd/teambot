import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp, type TestApp } from './helpers.js';
import { createRoutinesModule } from '../server/modules/routines/index.js';
import type { RoutineEngine } from '../server/modules/routines/engine.js';

// A-78: wait_for ("laat me weten als …") — a waitpoint fires once on its event (a file, a chat message, a webhook, a
// moment) or when it times out, and the bot continues in the conversation that set it. Plus the routine calendar.

interface Env {
  t: TestApp;
  engine: RoutineEngine;
  clock: { now: number };
  events: any[];
}

async function setup(start = '2026-11-09T07:00:00Z'): Promise<Env> {
  const clock = { now: Date.parse(start) };
  const t = await startTestApp({ modules: [createRoutinesModule({ clock: () => clock.now, tickMs: 0 })] });
  const engine: RoutineEngine = t.app.ctx.services.routines.engine;
  const events: any[] = [];
  t.app.ctx.events.subscribe((e) => events.push(e));
  return { t, engine, clock, events };
}

const msgs = (env: Env, threadId: string) => env.t.app.ctx.store.messages(threadId);
const routineOf = (env: Env, id: string) => env.t.app.ctx.store.decode<any>('routines', env.t.app.ctx.store.get('routines', id));

async function setWait(env: Env, args: any) {
  const a = await env.t.agent({ name: 'Wachter', access_mode: 'auto', tool_groups: ['files', 'routines'] });
  const th = await env.t.api('POST', '/threads', { agentId: a.id });
  env.t.script.push({ toolCalls: [{ name: 'wait_for', args }] }, { text: 'Ik laat het weten.' });
  const out = await env.t.say(th.id, 'Laat me weten als het rapport binnen is.');
  const tool = out.find((m: any) => m.role === 'tool');
  return { a, th, tool, routineId: tool?.parts?.toolResult?.data?.routineId || env.t.app.ctx.store.one<any>('SELECT id FROM routines ORDER BY created_at DESC LIMIT 1')?.id };
}

test('wait_for file: fires once when the file appears, in the same conversation, then stops listening', async () => {
  const env = await setup();
  try {
    const { a, th, tool, routineId } = await setWait(env, { event: 'file', path: 'uploads', pattern: '*.pdf', timeout_minutes: 600, then: 'Vat het nieuwe rapport samen.' });
    assert.match(tool.content, /Wachtpunt gezet: ik ga in dit gesprek verder zodra een nieuw bestand “\*\.pdf” in uploads er is/);
    const r0 = routineOf(env, routineId);
    assert.equal(r0.options.waitpoint.kind, 'file');
    assert.equal(r0.options.waitpoint.threadId, th.id);
    assert.equal(r0.status, 'active');
    const trg = env.engine.triggersOf(routineId)[0];
    assert.equal(trg.kind, 'folder');
    // Baseline (folder empty), then the file arrives.
    fs.mkdirSync(path.join(a.workspace, 'uploads'), { recursive: true });
    await env.t.api('POST', `/routines/triggers/${trg.id}/test`, {});
    const f = path.join(a.workspace, 'uploads', 'kwartaal.pdf');
    fs.writeFileSync(f, '%PDF-1.4 x');
    // The folder watcher waits until a file has been quiet for 3 s (still being written otherwise).
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(f, old, old);
    env.t.script.push({ text: 'Het rapport is binnen: kwartaal.pdf.' });
    await env.t.api('POST', `/routines/triggers/${trg.id}/test`, {});
    await env.engine.idle();
    await env.t.waitIdle(th.id);
    const r1 = routineOf(env, routineId);
    assert.equal(r1.status, 'completed', 'fired once');
    assert.equal(r1.options.waitpoint.how, 'event');
    assert.ok(r1.options.waitpoint.firedAt);
    assert.equal(env.engine.triggersOf(routineId)[0].enabled, false, 'stops listening');
    const list = msgs(env, th.id);
    const input = list.find((m) => m.parts?.routine?.id === routineId)!;
    assert.match(input.content, /Wachtpunt “.*” ging af: een nieuw bestand “\*\.pdf” in uploads \(map gewijzigd\)/);
    assert.match(input.content, /Vat het nieuwe rapport samen\./);
    assert.match(input.content, /kwartaal\.pdf/, 'the event data comes along (as untrusted data)');
    assert.equal(list.at(-1)!.content, 'Het rapport is binnen: kwartaal.pdf.', 'the bot continued in the conversation that set it');
    assert.equal(env.t.app.ctx.store.all('SELECT id FROM threads WHERE kind = ?', 'routine').length, 0, 'no separate routine thread');
    // A second file: nothing happens any more.
    fs.writeFileSync(path.join(a.workspace, 'uploads', 'nog-een.pdf'), '%PDF-1.4 y');
    await env.t.api('POST', `/routines/triggers/${trg.id}/test`, {}).catch(() => {});
    await env.engine.idle();
    assert.equal(env.t.app.ctx.store.all('SELECT id FROM routine_runs WHERE routine_id = ?', routineId).length, 1);
  } finally {
    await env.t.close();
  }
});

test('wait_for file on a folder that does not exist yet: the folder is made empty, so the first file in it fires', async () => {
  // Found live (A-78): "laat me weten als er een .csv in inbox komt" with no inbox yet never fired; the first check
  // after the owner created the folder took the new file as its starting point.
  const env = await setup();
  try {
    const { a, routineId } = await setWait(env, { event: 'file', path: 'inbox', pattern: '*.csv', timeout_minutes: 60, then: 'Vat het samen.' });
    assert.ok(fs.statSync(path.join(a.workspace, 'inbox')).isDirectory(), 'the watched folder exists right away');
    const trg = env.engine.triggersOf(routineId)[0];
    await env.t.api('POST', `/routines/triggers/${trg.id}/test`, {}); // the first check: an empty starting point
    const f = path.join(a.workspace, 'inbox', 'verkoop.csv');
    fs.writeFileSync(f, 'product,aantal\nappels,120\n');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(f, old, old);
    env.t.script.push({ text: 'Er kwam een csv binnen.' });
    await env.t.api('POST', `/routines/triggers/${trg.id}/test`, {});
    await env.engine.idle();
    assert.equal(routineOf(env, routineId).status, 'completed', 'fired on the first file');
  } finally {
    await env.t.close();
  }
});

test('wait_for: an event that does not happen in time ends with "verlopen"; a moment fires on time; an existing file needs no wait', async () => {
  const env = await setup();
  try {
    // Timeout (webhook that never comes): after 30 minutes the bot continues with "verlopen".
    const w = await setWait(env, { event: 'webhook', timeout_minutes: 30, then: 'Meld of de betaling binnen is.' });
    assert.match(w.tool.content, /het geheime token staat bij dit wachtpunt op de Routines-pagina/);
    assert.doesNotMatch(w.tool.content, /[A-Za-z0-9_-]{32,}/, 'the bot never sees the token');
    env.clock.now += 31 * 60_000;
    env.t.script.push({ text: 'Er is nog geen betaling binnen.' });
    env.engine.tick();
    await env.engine.idle();
    await env.t.waitIdle(w.th.id);
    const rw = routineOf(env, w.routineId);
    assert.equal(rw.status, 'completed');
    assert.equal(rw.options.waitpoint.how, 'timeout');
    const input = msgs(env, w.th.id).find((m) => m.parts?.routine?.id === w.routineId)!;
    assert.match(input.content, /Wachtpunt “.*” is verlopen: een webhook gebeurde niet vóór/);
    assert.equal(env.engine.triggersOf(w.routineId)[0].enabled, false);

    // A moment: "om 11:30 vandaag".
    const m = await setWait(env, { event: 'time', at: '2026-11-09T11:30', then: 'Herinner de gebruiker aan het telefoontje.' });
    assert.match(m.tool.content, /ik ga in dit gesprek verder op ma 9 nov/);
    env.clock.now = Date.parse('2026-11-09T10:31:00Z');
    env.t.script.push({ text: 'Tijd voor het telefoontje!' });
    env.engine.tick();
    await env.engine.idle();
    await env.t.waitIdle(m.th.id);
    const rm = routineOf(env, m.routineId);
    assert.equal(rm.options.waitpoint.how, 'event');
    assert.match(msgs(env, m.th.id).find((x) => x.parts?.routine?.id === m.routineId)!.content, /Wachtpunt “.*”: het is ma 9 nov/);

    // The file is already there: no waitpoint, continue right away.
    const a = await env.t.agent({ name: 'Snel', access_mode: 'auto', tool_groups: ['files', 'routines'] });
    fs.mkdirSync(path.join(a.workspace, 'in'), { recursive: true });
    fs.writeFileSync(path.join(a.workspace, 'in', 'offerte.pdf'), 'x');
    const th = await env.t.api('POST', '/threads', { agentId: a.id });
    const before = env.t.app.ctx.store.all('SELECT id FROM routines').length;
    env.t.script.push({ toolCalls: [{ name: 'wait_for', args: { event: 'file', path: 'in', pattern: '*.pdf', then: 'Lees hem.' } }] }, { text: 'ok' });
    const out = await env.t.say(th.id, 'wacht op de offerte');
    assert.match(out.find((x: any) => x.role === 'tool').content, /Niet nodig om te wachten: “offerte\.pdf” staat er al/);
    assert.equal(env.t.app.ctx.store.all('SELECT id FROM routines').length, before);
  } finally {
    await env.t.close();
  }
});

test('in "Vraagt toestemming" setting a waitpoint is one clear card; outside the bot\'s folders it is refused', async () => {
  const env = await setup();
  try {
    const a = await env.t.agent({ name: 'Voorzichtig', access_mode: 'ask', tool_groups: ['files', 'routines'] });
    const th = await env.t.api('POST', '/threads', { agentId: a.id });
    env.t.script.push({ toolCalls: [{ name: 'wait_for', args: { event: 'file', path: '../../', pattern: '*', then: 'x' } }] }, { text: 'ok' });
    await env.t.api('POST', `/threads/${th.id}/messages`, { content: 'wacht' });
    let ap: any;
    for (let i = 0; i < 100 && !ap; i++) {
      await new Promise((r) => setTimeout(r, 20));
      ap = (await env.t.api('GET', '/approvals'))[0];
    }
    assert.match(ap.summary, /^Wachtpunt zetten: wachten op een bestand “\*” in \.\.\/\.\.\/ \(uiterlijk 24 uur\) — daarna: x$/);
    await env.t.api('POST', `/approvals/${ap.id}`, { decision: 'approve' });
    await env.t.waitIdle(th.id);
    const tool = msgs(env, th.id).find((m) => m.role === 'tool')!;
    assert.match(tool.content, /Kon het wachtpunt niet zetten: .*buiten/);
  } finally {
    await env.t.close();
  }
});

test('calendar: planned runs per routine in the range and the runs that happened, with status', async () => {
  const env = await setup('2026-11-09T07:00:00Z'); // Monday 08:00 in Amsterdam
  try {
    const a = await env.t.agent();
    const r = await env.t.api('POST', '/routines', { name: 'Werkdagen', agent_id: a.id, prompt: 'x', timezone: 'Europe/Amsterdam', schedule: { kind: 'weekly', days: ['ma', 'di', 'wo', 'do', 'vr'], times: ['09:00'] } });
    await env.t.api('POST', '/routines', { name: 'Elke minuut', agent_id: a.id, prompt: 'x', timezone: 'Europe/Amsterdam', schedule: { kind: 'interval', everyMinutes: 1 } });
    env.t.script.push({ text: 'Gedaan.' });
    await env.t.api('POST', `/routines/${r.id}/run`, {});
    await env.engine.idle();
    const cal = await env.t.api('GET', `/routines/calendar?from=${encodeURIComponent('2026-11-09T00:00:00Z')}&to=${encodeURIComponent('2026-11-16T00:00:00Z')}`);
    const werk = cal.planned.filter((p: any) => p.name === 'Werkdagen').map((p: any) => p.at);
    assert.deepEqual(werk, ['2026-11-09T08:00:00.000Z', '2026-11-10T08:00:00.000Z', '2026-11-11T08:00:00.000Z', '2026-11-12T08:00:00.000Z', '2026-11-13T08:00:00.000Z']);
    assert.ok(cal.capped.length === 1, 'an every-minute routine is capped, not 10 000 entries');
    assert.equal(cal.runs.length, 1);
    assert.equal(cal.runs[0].name, 'Werkdagen');
    assert.equal(cal.runs[0].status, 'done');
    await assert.rejects(env.t.api('GET', '/routines/calendar?from=x&to=y'), /400/);
  } finally {
    await env.t.close();
  }
});
