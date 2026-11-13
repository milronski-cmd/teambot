/**
 * "Alles stoppen" and what TeamBot itself would start later at a model's cost (new-user check, 12 nov: six minutes
 * after the stop the review of an earlier conversation started by itself and made a model call; four more waited). The
 * stop goes through the one planner (routines/planner.ts): every source drops what it has queued for that owner, and
 * until his next turn no source starts work of TeamBot's own for him. What he planned himself keeps its time
 * (tests/owner-stop.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { sleep, until } from './team-mock.js';
import { modules as allModules } from '../server/modules/index.js';
import { createRoutinesModule } from '../server/modules/routines/index.js';
import { setShortCallFake } from '../server/agent/short-call.js';
import type { Planned } from '../server/modules/routines/planner.js';

process.env.TEAMBOT_TEST_NO_AUTO_MAIN = '1';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

/** Every module, the planner on the test's clock: a Monday at 05:00 at least two days from now (all real times are past). */
async function install() {
  let day = Math.floor((Date.now() + 2 * DAY) / DAY) * DAY;
  while (new Date(day).getUTCDay() !== 1) day += DAY;
  const clock = { now: day + 5 * HOUR };
  const t = await startTestApp({ modules: allModules.map((m) => (m.id === 'routines' ? createRoutinesModule({ clock: () => clock.now, tickMs: 0 }) : m)) });
  const ctx = t.app.ctx;
  const userId = ctx.auth.owner()!.id;
  ctx.store.setSetting(userId, 'timezone', 'UTC');
  const engine = ctx.services.routines.engine;
  const settle = async () => {
    for (let i = 0; i < 40; i++) {
      await engine.idle();
      await ctx.services.routines.work.idle();
      if (!ctx.runs.activeRuns().length) break;
      await sleep(25);
    }
  };
  return {
    t,
    ctx,
    userId,
    engine,
    clock,
    day,
    settle,
    /** Let the planner's clock run to this moment, a look every `step`. */
    async to(ms: number, step = MIN) {
      while (clock.now < ms) {
        clock.now = Math.min(ms, clock.now + step);
        engine.tick();
        await settle();
      }
    },
    planned: async (): Promise<string[]> => ((await t.api('GET', '/routines/planned')).planned as Planned[]).filter((p) => p.kind !== 'backup').map((p) => `${p.kind}:${p.id}`).sort(),
  };
}

test('"Alles stoppen": a conversation waiting for its memory review and a second look waiting for a limit never start by themselves; the next turn in that conversation reads it after all', async () => {
  const e = await install();
  const reviews: string[] = [];
  setShortCallFake((system, prompt) => (/Je bent het geheugen van TeamBot/.test(system) ? (reviews.push(prompt), 'NIETS') : ''));
  try {
    const { t, ctx, userId, day } = e;
    const bot = await t.agent({ name: 'Bo' });
    // (The test's model costs money: the review reads with the bot's own model only when the owner chose that.)
    await t.api('PUT', '/memory/settings', { extractor: 'model' });
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    t.script.push({ text: 'Goed.' });
    await t.say(th.id, 'Ik werk deze maand aan een nieuwe website voor de bakkerij.');
    const job = () => ctx.store.one<any>('SELECT status, dirty FROM memory_learn WHERE thread_id = ?', th.id);
    assert.equal(job()?.status, 'pending', 'the conversation waits for its review');
    // A second look at a task that waits for a usage limit (quality): one model call at its time.
    const ts = iso(day);
    ctx.store.exec(
      "INSERT INTO quality_tasks (id, user_id, kind, ref, title, reported_by, reported_at, check_state, open, recheck_at, created_at, updated_at) VALUES ('q1', ?, 'room', 't1', 'Sitemap nalopen', ?, ?, 'review', 1, ?, ?, ?)",
      userId,
      bot.id,
      ts,
      iso(day + 5 * HOUR + 30 * MIN),
      ts,
      ts,
    );
    assert.deepEqual(await e.planned(), [`learning:review:${th.id}`, 'recheck:recheck:room:t1'], 'both are in "Wat start vanzelf"');
    const calls = t.requests.length;

    await t.api('POST', '/stop-all', {});
    assert.deepEqual(await e.planned(), [], 'nothing of before the stop will start by itself');
    // An hour of looks (the review was due at once, the second look at half past five): nothing starts.
    await e.to(day + 6 * HOUR, 5 * MIN);
    assert.deepEqual(reviews, [], 'no memory review after the stop');
    assert.equal(t.requests.length, calls, 'no model call at all');
    assert.equal(job()?.status, 'idle');
    const q = ctx.store.one<any>("SELECT recheck_at, check_state, check_reason FROM quality_tasks WHERE id = 'q1'");
    assert.deepEqual([q.recheck_at, q.check_state], [null, 'review'], 'the task waits for the owner');
    assert.match(q.check_reason, /je hebt alles gestopt/);

    // His next turn in that conversation: its review reads what was said before the stop too.
    t.script.push({ text: 'Mooi.' });
    await t.say(th.id, 'De bakkerij wil ook een webwinkel.');
    await e.to(day + 6 * HOUR + 30 * MIN, 5 * MIN);
    await until(() => reviews.length === 1);
    assert.match(reviews[0], /nieuwe website voor de bakkerij/);
    assert.match(reviews[0], /ook een webwinkel/);
  } finally {
    setShortCallFake(null);
    await e.t.close();
  }
});

test('"Alles stoppen" while no bot is busy: work that lies on the board is not picked up by itself; the owner\'s next turn ends the hold', async () => {
  const e = await install();
  try {
    const { t, ctx, userId, day } = e;
    const work = ctx.services.routines.work;
    work.enabled = true;
    const bo = await t.agent({ name: 'Bo' });
    const runs = () => ctx.store.all<any>('SELECT agent_id, trigger, status FROM runs WHERE agent_id = ? ORDER BY created_at, rowid', bo.id);
    // The board gives Bo its task in a turn of its own; Bo answers without finishing it, so the work lies there.
    t.script.push({ text: 'Ik kijk er zo naar.' });
    await t.api('POST', '/rooms/tasks', { title: 'Planning bijwerken', owner: 'Bo' });
    await until(() => runs().some((r) => r.status === 'done'));
    await e.settle();
    const n = runs().length;
    assert.ok((await e.planned()).some((p) => p.startsWith('work:')), 'the work loop has it planned');

    // Nothing runs at the moment of the stop: there is no run to cancel, and still nothing starts afterwards.
    assert.equal((await t.api('POST', '/stop-all', {})).stopped, 0);
    await e.to(day + 6 * HOUR, 5 * MIN);
    assert.equal(runs().length, n, `nothing started after the stop: ${runs().slice(n).map((r) => r.trigger).join(', ')}`);
    assert.equal(ctx.services.routines.engine.planner.held(userId), true);
    assert.deepEqual(await e.planned(), []);
    assert.equal((await work.views(userId)).find((v: any) => v.agentId === bo.id).waits, 'je hebt alles gestopt');

    // He writes to a bot again: the hold is over, and the work loop goes on.
    t.script.push({ text: 'Hallo.' }, { text: 'Bijgewerkt.' });
    const chat = ctx.chat.threadForAgent(userId, bo.id);
    await t.say(chat.id, 'Hallo Bo.');
    assert.equal(ctx.services.routines.engine.planner.held(userId), false);
  } finally {
    await e.t.close();
  }
});
