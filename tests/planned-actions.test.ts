// "Wat start vanzelf" (12 nov 2026): every row of the one list has an action that works. Two rows had none:
//  - work that lies ready for a bot: "Nu niet" parks that list (POST /api/proactive/work/:agentId/park). The loop
//    leaves it alone until the list changes or the owner takes it up again; the row opens the task board or the
//    bot's chat;
//  - a specialist's learning round: switched on and off from the list with the specialist's own route
//    (PUT /api/specialists/:id with learnOn).
// The other rows keep theirs (a routine and a reminder are paused with the routine's route).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers.js';
import { modules as allModules } from '../server/modules/index.js';
import { createRoutinesModule } from '../server/modules/routines/index.js';
import type { RoutineEngine } from '../server/modules/routines/engine.js';
import type { Planned } from '../server/modules/routines/planner.js';
import type { WorkLoop } from '../server/modules/routines/duties/work.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

/** TeamBot with every module and nothing set; the planner's clock is the test's (a Monday 05:00 UTC, in the future). */
async function install() {
  let day = Math.floor((Date.now() + 2 * DAY) / DAY) * DAY;
  while (new Date(day).getUTCDay() !== 1) day += DAY;
  const clock = { now: day + 5 * HOUR };
  const t: TestApp = await startTestApp({ modules: allModules.map((m) => (m.id === 'routines' ? createRoutinesModule({ clock: () => clock.now, tickMs: 0 }) : m)) });
  const ctx = t.app.ctx;
  ctx.services.specialists?.setOptions?.({ hostDelayMs: 0, fetch: async () => { throw new Error('geen netwerk in tests'); }, search: async () => [] });
  const engine: RoutineEngine = ctx.services.routines.engine;
  const work: WorkLoop = ctx.services.routines.work;
  work.enabled = true;
  const userId = ctx.auth.owner()!.id;
  ctx.store.setSetting(userId, 'timezone', 'UTC');
  const settle = async () => {
    for (let quiet = 0, i = 0; quiet < 2 && i < 400; i++) {
      await engine.idle();
      await work.idle();
      const busy = ctx.runs.activeRuns().length;
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
    userId,
    clock,
    day,
    settle,
    tick,
    async to(ms: number, step = MIN) {
      while (clock.now < ms) {
        clock.now = Math.min(ms, clock.now + step);
        await tick();
      }
      await tick();
    },
    // (Without the automatic backup of the installation, backups/index.ts: it is in the list too, and not about bots.)
    planned: async (): Promise<Planned[]> => (await t.api('GET', '/routines/planned')).planned.filter((p: Planned) => p.kind !== 'backup'),
    workRuns: (agentId: string) => ctx.store.all<any>("SELECT id FROM runs WHERE agent_id = ? AND trigger = 'work'", agentId).length,
    async tool(agent: { id: string }, name: string, args: any): Promise<string> {
      const th = ctx.chat.threadForAgent(userId, agent.id);
      t.script.push({ toolCalls: [{ name, args }] }, { text: 'Gedaan.' });
      const msgs = await t.say(th.id, 'Doe dit voor mij.');
      return String(msgs.filter((m: any) => m.role === 'tool').at(-1)?.content || '');
    },
  };
}

test('work that lies ready: "nu niet" parks the list, a change in the work or "weer oppakken" starts it again', async () => {
  const e = await install();
  try {
    const { t, day } = e;
    await t.agent({ name: 'Eerste' });
    const bo = await t.agent({ name: 'Bo', access_mode: 'full' });
    const at = (h: number, m = 0) => day + h * HOUR + m * MIN;
    const work = async () => ((await t.api('GET', '/proactive/work')).work as any[]).find((w) => w.agentId === bo.id);
    const row = async () => (await e.planned()).find((p) => p.kind === 'work');

    // A routine and a reminder: rows with the routine's own pause.
    const routine = await t.api('POST', '/routines', { name: 'Elk uur de post', prompt: 'Kijk of er post is.', agent_id: bo.id, schedule: { kind: 'interval', everyMinutes: 600 } });
    assert.match(await e.tool(bo, 'reminder_set', { text: 'De tandarts bellen', at: iso(at(30)).slice(0, 16) }), /Herinnering gezet/);
    const kinds = (await e.planned()).map((p) => p.kind).sort();
    assert.deepEqual(kinds, ['reminder', 'routine']);

    // A task on Bo's name. The board hands it over at once (the bot answers without finishing it); then it lies there.
    await t.api('POST', '/rooms/tasks', { title: 'Sitemap nalopen', owner: 'Bo' });
    await e.settle();
    let w = await row();
    assert.deepEqual([w?.id, w?.agentId, w?.at, w?.model, w?.title], [`work:${bo.id}`, bo.id, null, true, 'Werk dat klaarligt voor Bo: 1 punt']);
    assert.equal(w?.link, '#/tasks', 'the row opens the task board: this work is a task on it');
    assert.equal((await work()).parked, false);

    // "Nu niet": it leaves the list of what starts, nothing is started for it, and the Werk view says why.
    const before = e.workRuns(bo.id);
    const parked = await t.api('POST', `/proactive/work/${bo.id}/park`, { parked: true });
    assert.equal(parked.parked, true);
    assert.equal(await row(), undefined, 'a parked list will not start, so it is not in the list');
    assert.deepEqual([(await work()).parked, (await work()).waits], [true, 'je hebt dit werk geparkeerd; het gaat verder zodra er iets verandert']);
    await e.to(at(5, 10));
    await e.to(at(30), HOUR);
    assert.equal(e.workRuns(bo.id), before, 'no work turn for a parked list, also not a day later');
    assert.equal((await t.api('POST', `/proactive/work/${bo.id}/park`, { parked: true })).parked, true, 'asked twice: still parked, nothing else changes');
    assert.equal(e.workRuns(bo.id), before);

    // "Weer oppakken": the list counts as new and the bot gets its turn at the next look.
    t.script.push({ text: 'De sitemap mist twee pagina’s; ik kon ze niet toevoegen.' });
    assert.equal((await t.api('POST', `/proactive/work/${bo.id}/park`, { parked: false })).parked, false);
    assert.equal((await row())?.at, null, 'back in the list: as soon as the bot is free');
    await e.to(at(30, 3));
    assert.equal(e.workRuns(bo.id), before + 1, 'the work turn ran');

    // Parked again, and then the work changes (a second task): the changed list starts by itself.
    await t.api('POST', `/proactive/work/${bo.id}/park`, { parked: true });
    assert.equal(await row(), undefined);
    await t.api('POST', '/rooms/tasks', { title: 'Robots.txt nalopen', owner: 'Bo' });
    await e.settle();
    assert.equal((await work()).parked, false, 'a changed list is not the list that was parked');
    await e.to(at(30, 8));
    assert.equal(e.workRuns(bo.id), before + 2, 'the changed list was picked up');

    // A bot of somebody else, or a bot with nothing to do: refused in words.
    await assert.rejects(t.api('POST', '/proactive/work/agt_bestaat_niet/park', { parked: true }), /Bot niet gevonden/);
    const idle = await t.agent({ name: 'Pen' });
    await assert.rejects(t.api('POST', `/proactive/work/${idle.id}/park`, { parked: true }), /Er ligt nu geen werk klaar voor Pen/);

    // The routine's row still pauses with the routine's own route.
    await t.api('POST', `/routines/${routine.id}/pause`, {});
    assert.equal((await e.planned()).some((p) => p.kind === 'routine'), false);
  } finally {
    await e.t.close();
  }
});

test('a learning round is switched on and off with the specialist’s own route, and the list follows', async () => {
  const e = await install();
  try {
    const { t } = e;
    await t.agent({ name: 'Eerste' });
    const seo = await t.agent({ name: 'Vindbaar', role: 'SEO-specialist: technische SEO en zoekwoorden' });
    const learning = async () => (await e.planned()).filter((p) => p.kind === 'learning');
    const listed = async () => ((await t.api('GET', '/specialists')) as any[]).find((s) => s.agentId === seo.id);

    // Off: not in the list of what starts; the specialists list is what the page offers "Aanzetten" for.
    assert.deepEqual(await learning(), []);
    const off = await listed();
    assert.deepEqual([off.enabled, !!off.field, off.learnOn], [true, true, false]);

    // Aanzetten.
    await t.api('PUT', `/specialists/${seo.id}`, { learnOn: true });
    const on = await learning();
    assert.deepEqual(on.map((p) => [p.id, p.agentId, p.model, p.title, p.link]), [[`learn:${seo.id}`, seo.id, true, 'Leerronde van Vindbaar', `#/m/specialists/${seo.id}`]]);
    assert.ok(on[0].at, 'with the time of the next round');
    assert.equal((await listed()).learnOn, true);

    // Uitzetten.
    await t.api('PUT', `/specialists/${seo.id}`, { learnOn: false });
    assert.deepEqual(await learning(), []);
    assert.equal((await listed()).learnOn, false);
  } finally {
    await e.t.close();
  }
});
