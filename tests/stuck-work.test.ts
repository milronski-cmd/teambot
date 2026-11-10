// 0.4.4 P2 "Niets blijft stil liggen": the main bot reports stuck work once (server/modules/teams/stuck.ts), and a
// routine checks its connections before it starts (server/modules/routines/preflight.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers.js';
import { newId, now } from '../server/core/db.js';

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

async function setup() {
  const t = await startTestApp();
  const ctx = t.app.ctx;
  const owner = ctx.auth.owner()!;
  const main = await t.agent({ name: 'Baas' });
  const pieter = await t.agent({ name: 'Pieter' });
  const svc = ctx.services.teams._service;
  const team = svc.create(owner.id, { name: 'Marketing' });
  svc.setHome(owner.id, team.id, pieter.id);
  ctx.services.teams.setMain(owner.id, main.id);
  return { t, ctx, owner, main, pieter, team, stuck: ctx.services.teams.stuck };
}

function approval(t: TestApp, userId: string, agentId: string, threadId: string, o: { kind?: string; summary: string; createdAt: string }) {
  const id = newId('apr_');
  t.app.ctx.store.insert('approvals', { id, user_id: userId, agent_id: agentId, run_id: null, thread_id: threadId, kind: o.kind || 'tool', tool: 'write_file', input: {}, summary: o.summary, risk: 'write', options: null, status: 'pending', created_at: o.createdAt });
  return id;
}

const mainMessages = (t: TestApp, mainThreadId: string) => t.app.ctx.store.messages(mainThreadId).filter((m) => m.role === 'assistant' && (m.parts as any)?.stuck);

test('stuck work: an approval that waits over 30 minutes is told once, in plain words, with team and where to answer', async () => {
  const { t, ctx, owner, main, pieter, stuck } = await setup();
  try {
    const th = ctx.chat.threadForAgent(owner.id, pieter.id);
    approval(t, owner.id, pieter.id, th.id, { summary: 'Mail aan Karin versturen', createdAt: ago(10 * 60_000) });
    assert.deepEqual(stuck.tick(), [], 'ten minutes is not stuck yet');
    const old = approval(t, owner.id, pieter.id, th.id, { summary: 'Offerte opslaan in Offertes', createdAt: ago(35 * 60_000) });
    const notes: any[] = [];
    const off = ctx.events.subscribe((e) => e.type === 'notification' && notes.push(e.data));
    const written = stuck.tick();
    off();
    assert.equal(written.length, 1);
    const mt = ctx.chat.threadForAgent(owner.id, main.id);
    const msgs = mainMessages(t, mt.id);
    assert.equal(msgs.length, 1);
    const m = msgs[0];
    assert.equal(m.author_id, main.id, 'the main bot writes it, in its own chat');
    assert.match(m.content, /Pieter in team Marketing wacht al 3[5-6] minuten op je goedkeuring: “Offerte opslaan in Offertes”\. Je antwoordt in Wacht op jou\./);
    assert.deepEqual((m.parts as any).stuck.items, [{ ref: `apr:${old}`, kind: 'approval', link: '#/inbox', retry: false }]);
    // Never decided by the bot: the approval still waits for the owner.
    assert.equal(ctx.store.get<any>('approvals', old).status, 'pending');
    assert.ok(notes.some((n) => n.title === 'Baas: er ligt werk stil' && n.link === `#/t/${mt.id}`));
    // Once per item.
    assert.deepEqual(stuck.tick(), []);
    assert.equal(mainMessages(t, mt.id).length, 1);
    // No model call was made for this.
    assert.equal(t.requests.length, 0);
  } finally {
    await t.close();
  }
});

test('stuck work: a broken task gets Opnieuw proberen, which retries it once; a task in the main chat is left out', async () => {
  const { t, ctx, owner, main, pieter, stuck } = await setup();
  try {
    t.script.push({ error: { message: 'boom', status: 400 } });
    const th = ctx.chat.threadForAgent(owner.id, pieter.id);
    await t.say(th.id, 'Maak de nieuwsbrief');
    let run = ctx.store.one<any>("SELECT * FROM runs WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1", th.id);
    if (run.status !== 'error') {
      ctx.store.exec("UPDATE runs SET status = 'error', error = 'Er ging iets mis bij de AI-engine' WHERE id = ?", run.id);
    }
    // Just failed: you may still be looking at it. Five minutes later it counts.
    assert.deepEqual(stuck.tick(), []);
    ctx.store.exec('UPDATE runs SET created_at = ?, finished_at = ? WHERE id = ?', ago(7 * 60_000), ago(6 * 60_000), run.id);
    // The main bot's own failed task is not reported (you see it in that chat already).
    const mt = ctx.chat.threadForAgent(owner.id, main.id);
    ctx.store.insert('runs', { id: newId('run_'), thread_id: mt.id, agent_id: main.id, user_id: owner.id, status: 'error', trigger: 'user', input_message_id: null, error: 'x', usage: {}, meta: {}, created_at: ago(8 * 60_000), started_at: null, finished_at: ago(8 * 60_000) });
    assert.equal(stuck.tick().length, 1);
    const [m] = mainMessages(t, mt.id);
    assert.match(m.content, /^Het werk van Pieter in team Marketing is vastgelopen: .+ Je kunt het opnieuw proberen of het gesprek openen\.$/s);
    const item = (m.parts as any).stuck.items[0];
    assert.deepEqual({ ref: item.ref, kind: item.kind, retry: item.retry, link: item.link }, { ref: `run:${run.id}`, kind: 'error', retry: true, link: `#/t/${th.id}` });

    t.script.push({ text: 'Nieuwsbrief klaar.' });
    const r = await t.api('POST', '/teams/stuck/retry', { messageId: m.id, ref: item.ref });
    assert.ok(r.run?.id);
    await t.waitIdle(th.id);
    run = ctx.store.get<any>('runs', r.run.id);
    assert.equal(run.trigger, 'retry');
    assert.equal(run.status, 'done');
    const upd = ctx.store.messages(mt.id).find((x) => x.id === m.id)!;
    assert.ok((upd.parts as any).stuck.items[0].retriedAt, 'the button is gone after one click');
    await assert.rejects(t.api('POST', '/teams/stuck/retry', { messageId: m.id, ref: item.ref }), /al opnieuw gestart/);
    await assert.rejects(t.api('POST', '/teams/stuck/retry', { messageId: m.id, ref: 'apr:x' }), /niet opnieuw proberen/);
  } finally {
    await t.close();
  }
});

test('stuck work: nothing without a main bot; a planned automatic retry is not stuck', async () => {
  const { t, ctx, owner, main, pieter, stuck } = await setup();
  try {
    const th = ctx.chat.threadForAgent(owner.id, pieter.id);
    ctx.store.insert('runs', { id: newId('run_'), thread_id: th.id, agent_id: pieter.id, user_id: owner.id, status: 'error', trigger: 'user', input_message_id: null, error: 'limit', usage: {}, meta: { limitRetryAt: now() }, created_at: ago(20 * 60_000), started_at: null, finished_at: ago(20 * 60_000) });
    assert.deepEqual(stuck.tick(), []);
    ctx.services.teams.clearMain(owner.id);
    approval(t, owner.id, pieter.id, th.id, { summary: 'Iets', createdAt: ago(60 * 60_000) });
    assert.deepEqual(stuck.tick(), []);
    assert.equal(ctx.store.messages(ctx.chat.threadForAgent(owner.id, main.id).id).length, 0);
  } finally {
    await t.close();
  }
});

test('check before the start: a routine with an expired app login does not run, gets a receipt and one notification', async () => {
  const { t, ctx, owner, main, pieter, stuck } = await setup();
  try {
    const engine = ctx.services.routines.engine;
    const r = await t.api('POST', '/routines', { name: 'Agenda samenvatten', agent_id: pieter.id, prompt: 'Vat mijn agenda samen.', schedule: { kind: 'none' } });
    // An app (MCP) bound to Pieter whose login expired.
    const connId = newId('mcp_');
    const ts = now();
    ctx.store.exec(
      "INSERT INTO mcp_connections (id, user_id, name, label, slug, transport, url, enabled, verified_at, status, oauth, created_at, updated_at) VALUES (?, ?, 'agenda', 'Agenda', 'agenda', 'http', 'https://example.com/mcp', 1, ?, 'auth_required', ?, ?, ?)",
      connId,
      owner.id,
      ts,
      JSON.stringify({ status: 'expired' }),
      ts,
      ts,
    );
    ctx.store.exec('INSERT INTO mcp_bindings (agent_id, connection_id, user_id, created_at) VALUES (?, ?, ?, ?)', pieter.id, connId, owner.id, ts);
    const notes: any[] = [];
    const off = ctx.events.subscribe((e) => e.type === 'notification' && notes.push(e.data));
    const rr = engine.manualRun(engine.routine(r.id), 'manual');
    for (let i = 0; i < 100 && engine.getRun(rr.id)?.status !== 'error'; i++) await new Promise((res) => setTimeout(res, 20));
    off();
    const fin = ctx.store.decode<any>('routine_runs', ctx.store.one('SELECT * FROM routine_runs WHERE id = ?', rr.id));
    assert.equal(fin.status, 'error');
    assert.match(fin.error, /^Kon niet: koppeling verlopen\. De login van Agenda is verlopen\. Log opnieuw in bij Apps\.$/);
    assert.equal(fin.summary, 'Kon niet: koppeling verlopen');
    assert.deepEqual(fin.meta.preflight.blockers.map((b: any) => [b.kind, b.id, b.link]), [['app', connId, '#/m/mcp']]);
    assert.equal(fin.run_id, null, 'the bot was not started');
    assert.equal(t.requests.length, 0, 'no model call');
    const n = notes.filter((x) => x.kind === 'routine');
    assert.equal(n.length, 1);
    assert.equal(n[0].title, 'Routine “Agenda samenvatten” kon niet starten: koppeling verlopen');
    assert.match(n[0].ref, /^preflight:/);
    // A second blocked run is the same notification line with a count, not a second line.
    const rr2 = engine.manualRun(engine.routine(r.id), 'manual');
    for (let i = 0; i < 100 && engine.getRun(rr2.id)?.status !== 'error'; i++) await new Promise((res) => setTimeout(res, 20));
    const rows = ctx.store.all<any>("SELECT count FROM notifications WHERE ref LIKE 'preflight:%'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].count, 2);
    // And the main bot reports the failed routine once, with Nog een keer as the owner's click.
    ctx.store.exec('UPDATE routine_runs SET created_at = ?, finished_at = ?', ago(10 * 60_000), ago(10 * 60_000));
    ctx.store.exec('UPDATE routine_runs SET created_at = ?, finished_at = ? WHERE id = ?', ago(9 * 60_000), ago(9 * 60_000), rr2.id);
    assert.equal(stuck.tick().length, 1);
    const [m] = mainMessages(t, ctx.chat.threadForAgent(owner.id, main.id).id);
    assert.match(m.content, /Routine “Agenda samenvatten” van Pieter in team Marketing is mislukt: Kon niet: koppeling verlopen/);
    assert.ok(m.content.includes('Het bonnetje staat bij Routines.'));
  } finally {
    await t.close();
  }
});

test('check before the start: a channel that is off stops the delivery routine; a healthy routine runs as before', async () => {
  const { t, ctx, pieter } = await setup();
  try {
    const engine = ctx.services.routines.engine;
    const { preflight } = await import('../server/modules/routines/preflight.js');
    const r = await t.api('POST', '/routines', { name: 'Gewoon', agent_id: pieter.id, prompt: 'Zeg hallo.', schedule: { kind: 'none' } });
    assert.deepEqual(preflight(ctx, engine.routine(r.id), ctx.store.agent(pieter.id)!), []);
    // A routine limited to other tool groups never uses the apps.
    const routine = engine.routine(r.id);
    const fake = { ...routine, options: { ...routine.options, deliver: { bindingId: 'chb_weg', to: 'owner', withFiles: false } } };
    const b = preflight(ctx, fake, ctx.store.agent(pieter.id)!);
    assert.equal(b.length, 1);
    assert.equal(b[0].kind, 'channel');
    assert.equal(b[0].text, 'Het kanaal waar het resultaat heen gaat, bestaat niet meer.');
  } finally {
    await t.close();
  }
});
