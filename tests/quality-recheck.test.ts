/**
 * The second look meets its engine's usage limit (praktijktest 0.4.4: OpenCode's free daily limit after ±6 short
 * tasks; the task stayed "Te controleren" and was never checked again). Now: the next engine of the chain checks it at
 * once; without one the task says plainly when TeamBot tries again, and it does so by itself after the reset.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mockAdapter, startTestApp, type TestApp } from './helpers.js';
import { recheckAt, RECHECK_WAIT_MS } from '../server/modules/quality/verify.js';
import { MAX_RECHECKS } from '../server/modules/quality/service.js';

const LIMIT = { message: 'Free usage limit reached. Upgrade or try again later.', status: 429 };

async function setup(t: TestApp) {
  const a = await t.agent({ name: 'Schrijver', tool_groups: ['team', 'files'] });
  const th = await t.api('POST', '/threads', { agentId: a.id });
  const ws = t.app.ctx.store.agent(a.id)!.workspace;
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'ebike.md'), 'De e-bike rijdt 80 km op één lading.\nHij weegt 22 kilo.\n');
  return { a, th };
}

const task = async (t: TestApp, id: string) => (await t.api('GET', '/rooms/tasks')).find((x: any) => x.id === id);
const row = (t: TestApp, id: string) => t.app.ctx.store.one<any>("SELECT * FROM quality_tasks WHERE kind = 'room' AND ref = ?", id);

test('recheckAt: just after a known reset, else 30 minutes doubling (at most 8 hours)', () => {
  const now = Date.parse('2026-11-09T22:00:00Z');
  assert.equal(recheckAt(now + 3600_000, 0, now), now + 3600_000 + 60_000);
  assert.equal(recheckAt(null, 0, now), now + RECHECK_WAIT_MS);
  assert.equal(recheckAt(null, 2, now), now + 4 * RECHECK_WAIT_MS);
  assert.equal(recheckAt(null, 9, now), now + 8 * 3600_000);
});

test('the check waits for the limit: "te controleren" with the time, then TeamBot checks again by itself', async () => {
  const t = await startTestApp();
  try {
    const { th } = await setup(t);
    const tk = await t.api('POST', '/rooms/tasks', { title: 'Producttekst e-bike', doneWhen: 'ebike.md met twee zinnen' });
    t.script.push(
      { toolCalls: [{ name: 'task_done', args: { id: tk.id, result: 'Twee zinnen geschreven.', evidence: ['ebike.md'] } }] },
      { error: LIMIT },
      { text: 'Gemeld.' },
    );
    await t.say(th.id, 'Meld de producttekst af');
    const waiting = await task(t, tk.id);
    assert.equal(waiting.status, 'review');
    assert.match(waiting.quality.check.reason, /^Nog niet gecontroleerd: de gratis limiet van .+ is bereikt\. TeamBot controleert het vanzelf opnieuw rond \S+/);
    const r = row(t, tk.id);
    assert.ok(r.recheck_at && Date.parse(r.recheck_at) > Date.now(), 'a time to try again');
    const out = t.app.ctx.store.messages(th.id).filter((m) => m.role === 'tool' && m.parts?.toolResult?.name === 'task_done').at(-1)!.content;
    assert.match(out, /Je hoeft hiervoor niets te doen/, 'the bot is not told to fix its work');

    // Not yet due: nothing runs.
    assert.equal(await t.app.ctx.services.quality.recheckDue(Date.now()), 0);
    // After the reset: checked again, the task goes to klaar, the owner hears it.
    const notes: any[] = [];
    const off = t.app.ctx.events.on('notification', (e) => void notes.push(e.data));
    t.script.push({ text: '{"verdict":"klaar","reason":"ebike.md heeft twee zinnen over de e-bike."}' });
    assert.equal(await t.app.ctx.services.quality.recheckDue(Date.now() + 9 * 3600_000), 1);
    off();
    const done = await task(t, tk.id);
    assert.equal(done.status, 'done');
    assert.equal(done.quality.check.state, 'passed');
    assert.equal(done.quality.open, false);
    assert.equal(row(t, tk.id).recheck_at, null);
    assert.ok(notes.some((n) => /Gecontroleerd en klaar: Producttekst e-bike/.test(n.title)), JSON.stringify(notes));

    // Still at the limit: later again; after MAX_RECHECKS tries the owner checks it himself, in plain words.
    const tk2 = await t.api('POST', '/rooms/tasks', { title: 'Tweede tekst' });
    t.script.push({ toolCalls: [{ name: 'task_done', args: { id: tk2.id, result: 'Klaar.', evidence: ['ebike.md'] } }] }, { error: LIMIT }, { text: 'Gemeld.' });
    await t.say(th.id, 'Meld de tweede tekst af');
    t.script.push({ error: LIMIT });
    await t.app.ctx.services.quality.recheckDue(Date.now() + 9 * 3600_000);
    const again = row(t, tk2.id);
    assert.equal(again.recheck_n, 1);
    assert.ok(again.recheck_at, 'planned again');
    t.app.ctx.store.exec("UPDATE quality_tasks SET recheck_n = ? WHERE kind = 'room' AND ref = ?", MAX_RECHECKS - 1, tk2.id);
    t.script.push({ error: LIMIT });
    await t.app.ctx.services.quality.recheckDue(Date.now() + 24 * 3600_000);
    const last = await task(t, tk2.id);
    assert.equal(last.status, 'review');
    assert.match(last.quality.check.reason, /^Niet automatisch gecontroleerd: de gratis limiet van .+ bleef bereikt\. Kijk het zelf na\.$/);
    assert.equal(row(t, tk2.id).recheck_at, null, 'no more tries');

    // The owner decided before the time came: no second look later.
    const tk3 = await t.api('POST', '/rooms/tasks', { title: 'Derde tekst' });
    t.script.push({ toolCalls: [{ name: 'task_done', args: { id: tk3.id, result: 'Klaar.', evidence: ['ebike.md'] } }] }, { error: LIMIT }, { text: 'Gemeld.' });
    await t.say(th.id, 'Meld de derde tekst af');
    await t.api('POST', `/rooms/tasks/${tk3.id}/approve`);
    const n = t.requests.length;
    assert.equal(await t.app.ctx.services.quality.recheckDue(Date.now() + 9 * 3600_000), 0);
    assert.equal(t.requests.length, n);
    assert.equal((await task(t, tk3.id)).quality.check.state, 'owner');
  } finally {
    await t.close();
  }
});

test('the check at the limit goes to the next free option at once (a model on this computer), and says so', async () => {
  const t = await startTestApp();
  try {
    t.app.ctx.providers.registerKind({ id: 'mocklocal', label: 'Lokaal', type: 'api', billing: 'local', needsKey: false, description: 'test', models: ['qwen3:4b'], defaultModel: 'qwen3:4b', create: () => mockAdapter(t.script, t.requests) });
    const local = await t.api('POST', '/providers', { kind: 'mocklocal', name: 'Lokaal (test)', config: { defaultModel: 'qwen3:4b' } });
    const { th } = await setup(t);
    const tk = await t.api('POST', '/rooms/tasks', { title: 'Producttekst e-bike', doneWhen: 'ebike.md met twee zinnen' });
    t.script.push(
      { toolCalls: [{ name: 'task_done', args: { id: tk.id, result: 'Twee zinnen geschreven.', evidence: ['ebike.md'] } }] },
      { error: LIMIT },
      { text: '{"verdict":"klaar","reason":"ebike.md heeft twee zinnen."}' },
      { text: 'Gemeld.' },
    );
    await t.say(th.id, 'Meld de producttekst af');
    const done = await task(t, tk.id);
    assert.equal(done.status, 'done', JSON.stringify(done.quality));
    assert.equal(done.quality.check.state, 'passed');
    assert.match(done.quality.check.reason, /\(Gecontroleerd met Lokaal \(test\) · qwen3:4b, omdat de gratis limiet van .+ bereikt is\.\)$/);
    assert.match(done.quality.check.engine, /Lokaal \(test\)/);
    assert.equal(t.requests.at(-2)!.model, 'qwen3:4b', 'the check ran on the local model');
    assert.equal(row(t, tk.id).recheck_at, null);
    void local;
  } finally {
    await t.close();
  }
});

test('team database: a task whose check waited for the limit goes from wacht_op_controle to klaar after the reset', async () => {
  const t = await startTestApp();
  try {
    const { th } = await setup(t);
    t.script.push(
      { toolCalls: [{ name: 'team_execute', args: { sql: "INSERT INTO taken (titel, eigenaar, status) VALUES (?, ?, 'bezig')", params: ['Producttekst', 'Schrijver'] } }] },
      { toolCalls: [{ name: 'team_execute', args: { sql: "UPDATE taken SET status = 'klaar', resultaat = ?, bewijs = ? WHERE id = 1", params: ['Twee zinnen', 'ebike.md'] } }] },
      { error: LIMIT },
      { text: 'ok' },
    );
    await t.say(th.id, 'schrijf de tekst');
    assert.equal((await t.api('GET', '/teamdata/tasks'))[0].status, 'wacht_op_controle');
    const out = t.app.ctx.store.messages(th.id).filter((m) => m.role === 'tool' && m.parts?.toolResult?.name === 'team_execute').at(-1)!.content;
    assert.match(out, /Nog niet gecontroleerd: de gratis limiet van .+ is bereikt\. TeamBot controleert het vanzelf opnieuw rond/);
    assert.match(out, /Je hoeft hiervoor niets te doen/);

    t.script.push({ text: '{"verdict":"klaar","reason":"ebike.md heeft twee zinnen."}' });
    assert.equal(await t.app.ctx.services.quality.recheckDue(Date.now() + 9 * 3600_000), 1);
    assert.equal((await t.api('GET', '/teamdata/tasks'))[0].status, 'klaar');
    assert.equal((await t.api('GET', '/quality/inbox')).tasks.length, 0);
  } finally {
    await t.close();
  }
});

test('a delegated subtask whose check meets the limit says plainly that the owner checks it (no promise of later)', async () => {
  const t = await startTestApp();
  try {
    const owner = t.app.ctx.auth.owner()!;
    const { a } = await setup(t);
    t.script.push({ error: LIMIT });
    const v = await t.app.ctx.services.quality.checkDelegation({ userId: owner.id, delegationId: 'dlg_test', worker: t.app.ctx.store.agent(a.id), task: 'Twee zinnen over de e-bike', expected: 'twee zinnen', result: 'De e-bike rijdt 80 km. Hij weegt 22 kilo.', runId: null });
    assert.equal(v.state, 'review');
    assert.match(v.reason, /^Niet automatisch gecontroleerd: de gratis limiet van .+ is bereikt\. Kijk het zelf na\.$/);
    assert.equal(t.app.ctx.store.one<any>("SELECT recheck_at FROM quality_tasks WHERE kind = 'delegation' AND ref = 'dlg_test'").recheck_at, null);
  } finally {
    await t.close();
  }
});

test('a look without a verdict is done again by TeamBot itself: at once, then later; a task that still says so from before gets its look now', async () => {
  const t = await startTestApp();
  try {
    const { th } = await setup(t);
    const tk = await t.api('POST', '/rooms/tasks', { title: 'Producttekst e-bike', doneWhen: 'ebike.md met twee zinnen' });
    // The checker answers twice with something that is no verdict (live: "Error: Reached max turns (1)").
    t.script.push({ toolCalls: [{ name: 'task_done', args: { id: tk.id, result: 'Twee zinnen geschreven.', evidence: ['ebike.md'] } }] }, { text: 'Ik kijk even in het bestand.' }, { text: 'Nog even.' }, { text: 'Gemeld.' });
    await t.say(th.id, 'Meld de producttekst af');
    const waiting = await task(t, tk.id);
    assert.equal(waiting.status, 'review');
    assert.match(waiting.quality.check.reason, /^Nog niet gecontroleerd: de controle gaf geen duidelijk antwoord\. TeamBot controleert het vanzelf opnieuw rond \S+/);
    assert.ok(row(t, tk.id).recheck_at, 'a time to try again, not a job for the owner');
    t.script.push({ text: '{"verdict":"klaar","reason":"ebike.md heeft twee zinnen."}' });
    assert.equal(await t.app.ctx.services.quality.recheckDue(Date.now() + 9 * 3600_000), 1);
    assert.equal((await task(t, tk.id)).status, 'done');

    // A task from before this repair: it says "geen duidelijk antwoord" and nothing would ever look again.
    const old = await t.api('POST', '/rooms/tasks', { title: 'Oude taak', doneWhen: 'ebike.md bestaat' });
    t.script.push({ toolCalls: [{ name: 'task_done', args: { id: old.id, result: 'Bestand staat er.', evidence: ['ebike.md'] } }] }, { text: '{"verdict":"te_controleren","reason":"twijfel"}' }, { text: 'Gemeld.' });
    await t.say(th.id, 'Meld de oude taak af');
    t.app.ctx.store.update('quality_tasks', row(t, old.id).id, { check_reason: 'De controle gaf geen duidelijk antwoord; kijk het zelf na.', recheck_input: {} });
    assert.equal(t.app.ctx.services.quality.svc.retryUnclear(), 1);
    t.script.push({ text: '{"verdict":"klaar","reason":"ebike.md bestaat."}' });
    assert.equal(await t.app.ctx.services.quality.recheckDue(Date.now() + 1000), 1);
    assert.equal((await task(t, old.id)).status, 'done', 'checked with what the task on the board says the bot reported');
    assert.match(JSON.stringify(t.requests.at(-1)!.messages), /Bestand staat er\./);
  } finally {
    await t.close();
  }
});
