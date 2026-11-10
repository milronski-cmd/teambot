import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { createPowerModule, awakeReason } from '../server/modules/power/index.js';
import routines from '../server/modules/routines/index.js';

// A-76: "Houd de pc wakker terwijl routines of taken lopen" — off by default; with a desktop blocker attached it holds
// exactly while a task runs, a routine runs/waits for a retry, or a routine starts within half an hour.

const iso = (ms: number) => new Date(ms).toISOString();

test('off by default, honest without a desktop shell, holds the blocker only while something runs or is about to', async () => {
  const power = createPowerModule({ tickMs: 60_000 });
  const t = await startTestApp({ modules: [routines, power] });
  try {
    const st = t.app.ctx.store;
    const owner = t.app.ctx.auth.owner()!;
    // No desktop shell (server, browser): shown, not switchable to "on".
    let s = await t.api('GET', '/power');
    assert.deepEqual(s, { available: false, enabled: false, active: false, reason: null });

    const calls: [boolean, string | null][] = [];
    const events: any[] = [];
    t.app.ctx.events.subscribe((e) => e.type === 'power.state' && events.push(e.data));
    const detach = t.app.ctx.services.power.attach({ set: (a: boolean, r: string | null) => calls.push([a, r]) });
    s = await t.api('GET', '/power');
    assert.equal(s.available, true);
    assert.equal(s.enabled, false, 'off by default');

    // Something is about to run, but the option is off: the computer may sleep.
    const a = await t.agent({ name: 'Nachtwacht' });
    st.insert('routines', { id: 'rt_test1', user_id: owner.id, agent_id: a.id, name: 'Ochtendnieuws', prompt: 'x', status: 'active', schedule: { kind: 'none' }, timezone: 'Europe/Amsterdam', options: {}, next_run_at: iso(Date.now() + 10 * 60_000), created_at: iso(Date.now()), updated_at: iso(Date.now()) });
    s = t.app.ctx.services.power.evaluate();
    assert.equal(s.active, false);
    assert.match(String(s.reason), /routine “Ochtendnieuws” start om \d\d:\d\d/);
    assert.ok(!calls.some(([x]) => x), 'blocker not held while the option is off');

    // On: held, with the reason (tray + sidebar).
    s = await t.api('PUT', '/power', { enabled: true });
    assert.equal(s.active, true);
    assert.deepEqual(calls.at(-1)?.[0], true);
    assert.match(String(calls.at(-1)?.[1]), /Ochtendnieuws/);
    assert.ok(events.some((e) => e.active === true), 'the UI hears it (power.state)');

    // The routine moves to tomorrow: nothing runs → released.
    st.exec('UPDATE routines SET next_run_at = ? WHERE id = ?', iso(Date.now() + 20 * 3600_000), 'rt_test1');
    s = t.app.ctx.services.power.evaluate();
    assert.equal(s.active, false);
    assert.deepEqual(calls.at(-1), [false, null]);

    // A task runs (a chat turn, a routine run): held again; done: released.
    const th = await t.api('POST', '/threads', { agentId: a.id });
    st.insert('runs', { id: 'run_power1', user_id: owner.id, agent_id: a.id, thread_id: th.id, status: 'running', trigger: 'user', created_at: iso(Date.now()) });
    assert.equal(awakeReason(t.app.ctx), '1 taak loopt');
    assert.equal(t.app.ctx.services.power.evaluate().active, true);
    st.exec("UPDATE runs SET status = 'done' WHERE id = ?", 'run_power1');
    assert.equal(t.app.ctx.services.power.evaluate().active, false);

    // A routine run waiting for its next attempt also counts.
    st.insert('routine_runs', { id: 'rr_power1', routine_id: 'rt_test1', user_id: owner.id, run_key: 'k1', status: 'retrying', trigger: 'schedule', created_at: iso(Date.now()) });
    assert.equal(awakeReason(t.app.ctx), 'een routine loopt');

    // Off again: released; detaching (app quits) releases too.
    s = await t.api('PUT', '/power', { enabled: false });
    assert.equal(s.active, false);
    assert.deepEqual(calls.at(-1), [false, null]);
    await t.api('PUT', '/power', { enabled: true });
    assert.equal(calls.at(-1)?.[0], true);
    detach();
    assert.deepEqual(calls.at(-1), [false, null]);
    assert.equal((await t.api('GET', '/power')).available, false);
  } finally {
    await t.close();
  }
});

test('only an owner or admin switches it', async () => {
  const power = createPowerModule({ tickMs: 60_000 });
  const t = await startTestApp({ modules: [power], mode: 'server' });
  try {
    const m = t.app.ctx.auth.createUser({ name: 'Lid', email: 'lid@test.local', password: 'geheim1234', role: 'member' });
    const s = t.app.ctx.auth.createSession(m.id, 'web', 'x');
    const r = await fetch(`${t.app.url}/api/power`, { method: 'PUT', headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
    assert.equal(r.status, 403);
  } finally {
    await t.close();
  }
});
