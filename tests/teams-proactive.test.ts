import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers.js';
import rooms from '../server/modules/rooms/index.js';
import skills from '../server/modules/skills/index.js';
import routines from '../server/modules/routines/index.js';
import memory from '../server/modules/memory/index.js';
import teams from '../server/modules/teams/index.js';
import type { CheckIn } from '../server/modules/teams/proactive.js';

// These tests are about bots that are not the main bot: without this the first bot would be it (teams `autoMain`,
// covered in works-right-away.test.ts).
process.env.TEAMBOT_TEST_NO_AUTO_MAIN = '1';

// "De hoofdbot komt naar je toe": the main bot's check-in (server/modules/teams/proactive.ts). It is off until the
// owner turns it on (tests/planner.test.ts: a fresh install starts nothing); in these tests he has (`setup`). The
// tests look at chosen moments themselves (`at`), on the check-in's own clock.

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** A Monday–Wednesday at 00:00 UTC, at least two days from now (so every real timestamp is long ago on this clock). */
function workday(): number {
  let d = Math.floor((Date.now() + 2 * DAY) / DAY) * DAY;
  while (![1, 2, 3].includes(new Date(d).getUTCDay())) d += DAY;
  return d;
}

interface Env {
  t: TestApp;
  userId: string;
  checkin: CheckIn;
  clock: { now: number };
  day: number;
  main: any;
  /** The main bot's chat (what the owner sees). */
  chat(): any[];
  /** One minute of the timer at this moment; the check-in it started is over when this returns. */
  at(ms: number): Promise<number>;
}

async function setup(o: { main?: boolean; on?: boolean } = {}): Promise<Env> {
  const t = await startTestApp({ modules: [memory, skills, routines, teams, rooms] });
  const ctx = t.app.ctx;
  const userId = ctx.auth.owner()!.id;
  ctx.store.setSetting(userId, 'timezone', 'UTC');
  if (o.on !== false) await t.api('PUT', '/proactive/checkin', { enabled: true });
  const day = workday();
  const clock = { now: day + 6 * HOUR };
  const checkin: CheckIn = ctx.services.teams.checkin;
  checkin.clock = () => clock.now;
  ctx.services.teams.briefing.clock = () => clock.now;
  let main: any = null;
  if (o.main !== false) {
    main = await t.agent({ name: 'Baas' });
    await t.api('PUT', `/teams/main/${main.id}`);
  }
  return {
    t,
    userId,
    checkin,
    clock,
    day,
    main,
    chat: () => (main ? ctx.store.messages(ctx.chat.threadForAgent(userId, main.id).id) : []),
    async at(ms) {
      clock.now = ms;
      const started = await checkin.tick();
      await checkin.idle();
      return started.length;
    },
  };
}

test('morning check-in: once per working day at the hour, in the main bot’s chat, with the facts and the instruction', async () => {
  const e = await setup();
  try {
    assert.deepEqual(await e.t.api('GET', '/proactive/checkin'), { enabled: true, time: '09:00', last: null }, 'switched on: at 09:00 unless another hour is given');
    assert.equal(await e.at(e.day + 8 * HOUR + 59 * 60_000), 0, 'not before the hour');
    assert.equal(e.t.requests.length, 0);

    e.t.script.push({ text: 'Goedemorgen. Er ligt niets stil. Zal ik een team voor je webshop opzetten?' });
    assert.equal(await e.at(e.day + 9 * HOUR + 5 * 60_000), 1);
    let msgs = e.chat();
    assert.deepEqual(msgs.map((m) => m.role), ['system', 'assistant']);
    assert.equal(msgs[0].content, 'Check-in van de ochtend.');
    assert.equal(msgs[1].author_id, e.main.id);
    assert.match(msgs[1].content, /Zal ik een team/);
    const req = JSON.stringify(e.t.requests.at(-1));
    assert.match(req, /Check-in van de ochtend: de eigenaar heeft nu niets gevraagd/);
    assert.match(req, /Sinds de vorige check-in/);
    assert.match(req, /hoogstens ÉÉN vraag of doe ÉÉN concreet voorstel, en alleen voor iets waar zijn ja echt voor nodig is/);
    assert.match(req, /Wat je zelf kunt doen of bij een bot kunt uitzetten, doe je nu, in deze beurt/, 'the main bot works; it does not ask first');
    // (The owner's goals — projects and open tasks — are in the instruction when the team database is loaded: tests/work-loop.test.ts.)
    assert.match(req, /ROUTINE_NO_UPDATE/);
    assert.equal(e.t.app.ctx.store.one<any>('SELECT trigger FROM runs ORDER BY created_at DESC LIMIT 1')!.trigger, 'checkin');
    assert.equal((await e.t.api('GET', '/proactive/checkin')).last.said, true);

    // The same day: never again, also after the four hours.
    assert.equal(await e.at(e.day + 9 * HOUR + 6 * 60_000), 0);
    assert.equal(await e.at(e.day + 11 * HOUR), 0);
    assert.equal(await e.at(e.day + 14 * HOUR), 0);
    assert.equal(e.t.requests.length, 1);

    // The next working day: again, once.
    e.t.script.push({ text: 'Goedemorgen. Zal ik de routines van je team aanzetten?' });
    assert.equal(await e.at(e.day + DAY + 9 * HOUR), 1);
    assert.equal(await e.at(e.day + DAY + 9 * HOUR + 60_000), 0);
    msgs = e.chat();
    assert.equal(msgs.filter((m) => m.role === 'assistant').length, 2);

    // Not in the weekend.
    let sat = e.day;
    while (new Date(sat).getUTCDay() !== 6) sat += DAY;
    assert.equal(await e.at(sat + 9 * HOUR + 5 * 60_000), 0);
    assert.equal(e.t.requests.length, 2);
  } finally {
    await e.t.close();
  }
});

test('off until the owner turns it on: with a main bot and an AI, no check-in starts at the hour or when something needs him', async () => {
  const e = await setup({ on: false });
  try {
    assert.deepEqual(await e.t.api('GET', '/proactive/checkin'), { enabled: false, time: '09:00', last: null }, 'a fresh install: off');
    assert.equal(e.t.app.ctx.store.getSetting(e.userId, 'proactive.checkin', null), null, 'nothing was written for him');
    await e.t.api('POST', '/teams', { name: 'Webshop' });
    assert.ok(e.checkin.needs(e.userId).some((n) => n.kind === 'profile'), 'there is something it would come for');
    assert.equal(await e.at(e.day + 9 * HOUR + 5 * 60_000), 0, 'not at the hour');
    assert.equal(await e.at(e.day + 15 * HOUR), 0, 'not in between');
    assert.equal(await e.at(e.day + DAY + 9 * HOUR + 5 * 60_000), 0, 'not the next day');
    assert.equal(e.t.requests.length, 0, 'no model call');
    assert.equal(e.t.app.ctx.store.all('SELECT id FROM runs').length, 0);
    assert.deepEqual(e.chat(), []);
    assert.deepEqual(e.checkin.planned(e.userId), [], 'and nothing of it is planned');

    // The owner turns it on (he tells his main bot, which uses this route): from then on it comes, and it is planned.
    await e.t.api('PUT', '/proactive/checkin', { enabled: true, time: '10:00' });
    e.clock.now = e.day + DAY + 9 * HOUR + 6 * 60_000;
    const [p] = e.checkin.planned(e.userId);
    assert.deepEqual([p.kind, p.agentId, p.at, p.model], ['checkin', e.main.id, new Date(e.day + DAY + 10 * HOUR).toISOString(), true]);
    e.t.script.push({ text: 'Goedemorgen. Team Webshop heeft nog geen profiel.' });
    assert.equal(await e.at(e.day + DAY + 10 * HOUR + 60_000), 1);
    assert.equal(new Date(e.checkin.planned(e.userId)[0].at!).getTime() > e.clock.now, true, 'done for today: the next one is a later working day');
  } finally {
    await e.t.close();
  }
});

test('no main bot, or a main bot without an AI: no check-in', async () => {
  const e = await setup({ main: false });
  try {
    const bot = await e.t.agent({ name: 'Gewone bot' });
    assert.equal(await e.at(e.day + 9 * HOUR + 5 * 60_000), 0, 'no main bot');
    // A main bot whose AI is gone.
    await e.t.api('PUT', `/teams/main/${bot.id}`);
    const store = e.t.app.ctx.store;
    store.updateAgent(bot.id, { provider_id: 'weg' } as any);
    assert.equal(await e.at(e.day + 9 * HOUR + 6 * 60_000), 0, 'no AI connected');
    assert.equal(e.t.requests.length, 0);
    assert.equal(store.all('SELECT id FROM runs').length, 0);
    // The AI is back within the morning: the check-in still comes.
    store.updateAgent(bot.id, { provider_id: e.t.providerId } as any);
    e.t.script.push({ text: 'Goedemorgen. Zal ik een eerste team voor je maken?' });
    assert.equal(await e.at(e.day + 9 * HOUR + 7 * 60_000), 1);
  } finally {
    await e.t.close();
  }
});

test('switched on before any bot exists: the check-in stays in "Wat start vanzelf" (waiting for a main bot), so it can be switched off there', async () => {
  const e = await setup({ main: false });
  try {
    assert.equal((await e.t.api('GET', '/proactive/checkin')).enabled, true);
    // The page shows it under "Staat uit" only while it is off, so on and without a main bot it must be in the list.
    const rows = (await e.t.api('GET', '/routines/planned')).planned.filter((p: any) => p.kind === 'checkin');
    assert.deepEqual(rows.map((p: any) => [p.id, p.agentId, p.at, p.model, p.title]), [['checkin', null, null, true, 'Check-in van de hoofdbot: begint zodra er een hoofdbot met AI is']]);
    assert.equal(await e.at(e.day + 9 * HOUR + 5 * 60_000), 0, 'and it does not start without one');
    // With a main bot it has its hour again.
    const bot = await e.t.agent({ name: 'Baas' });
    await e.t.api('PUT', `/teams/main/${bot.id}`);
    const [p] = e.checkin.planned(e.userId);
    assert.deepEqual([p.agentId, p.title, !!p.at], [bot.id, 'Check-in van Baas', true]);
    // Off: gone from the list (the page then shows it under "Staat uit").
    await e.t.api('PUT', '/proactive/checkin', { enabled: false });
    assert.deepEqual(e.checkin.planned(e.userId), []);
  } finally {
    await e.t.close();
  }
});

test('nothing to report: the bot answers with the no-update token and no message appears', async () => {
  const e = await setup();
  try {
    const notes: any[] = [];
    e.t.app.ctx.events.subscribe((ev: any) => ev.type === 'notification' && notes.push(ev.data));
    e.t.script.push({ text: 'ROUTINE_NO_UPDATE' });
    assert.equal(await e.at(e.day + 9 * HOUR + 60_000), 1);
    assert.equal(e.t.requests.length, 1, 'the bot was asked');
    assert.deepEqual(e.chat(), [], 'the chat stays empty: no line from TeamBot and no empty message');
    assert.equal(notes.length, 0, 'no notification');
    assert.equal((await e.t.api('GET', '/proactive/checkin')).last.said, false);
    // It counts as today's check-in: not asked again a minute later.
    assert.equal(await e.at(e.day + 9 * HOUR + 2 * 60_000), 0);
    assert.equal(e.t.requests.length, 1);
    // A later conversation does not carry the hidden turn.
    e.t.script.push({ text: 'Hallo!' });
    const thread = e.t.app.ctx.chat.threadForAgent(e.userId, e.main.id);
    await e.t.say(thread.id, 'Hoi');
    assert.doesNotMatch(JSON.stringify(e.t.requests.at(-1)!.messages), /ROUTINE_NO_UPDATE|Check-in van de ochtend/);
  } finally {
    await e.t.close();
  }
});

test('guards: not while the owner is talking with the main bot, not while it is busy', async () => {
  const e = await setup();
  try {
    const store = e.t.app.ctx.store;
    const thread = e.t.app.ctx.chat.threadForAgent(e.userId, e.main.id);
    e.t.script.push({ text: 'Dag!' });
    await e.t.say(thread.id, 'Even iets anders');
    const nine = e.day + 9 * HOUR;
    // The owner wrote 4 minutes before the hour.
    store.exec("UPDATE messages SET created_at = ? WHERE thread_id = ? AND role = 'user'", new Date(nine - 4 * 60_000).toISOString(), thread.id);
    assert.equal(await e.at(nine), 0, 'the owner is in the middle of a conversation');
    assert.equal(await e.at(nine + 5 * 60_000), 0, 'still within ten minutes');
    assert.equal(e.t.requests.length, 1);

    // A run of the main bot is going (anywhere): wait.
    const busy = store.createRun({ thread_id: thread.id, agent_id: e.main.id, user_id: e.userId, trigger: 'user', input_message_id: null } as any);
    store.updateRun(busy.id, { status: 'running' } as any);
    assert.equal(await e.at(nine + 7 * 60_000), 0, 'the main bot is busy');
    store.updateRun(busy.id, { status: 'done' } as any);

    // Free again, still in the morning: now it comes.
    e.t.script.push({ text: 'Goedemorgen. Zal ik …?' });
    assert.equal(await e.at(nine + 8 * 60_000), 1);
    assert.equal(e.chat().at(-1)!.content, 'Goedemorgen. Zal ik …?');
  } finally {
    await e.t.close();
  }
});

test('something needs the owner: a check-in outside the morning, once per thing, and never within four hours of the last one', async () => {
  const e = await setup();
  try {
    const nine = e.day + 9 * HOUR;
    e.t.script.push({ text: 'Goedemorgen. Alles loopt.' });
    assert.equal(await e.at(nine), 1);

    // A team without a profile appears after the morning check-in (made long ago on this clock).
    await e.t.api('POST', '/teams', { name: 'Webshop' });
    assert.ok(e.checkin.needs(e.userId).some((n) => n.team === 'Webshop' && n.kind === 'profile'));
    assert.equal(await e.at(nine + HOUR), 0, 'within four hours of the morning check-in');
    assert.equal(await e.at(nine + 3 * HOUR + 59 * 60_000), 0);
    assert.equal(e.t.requests.length, 1);

    e.t.script.push({ text: 'Team Webshop heeft nog geen profiel. Zal ik je er een paar vragen over stellen?' });
    assert.equal(await e.at(nine + 4 * HOUR + 60_000), 1);
    const req = JSON.stringify(e.t.requests.at(-1));
    assert.match(req, /Check-in: er is iets dat de aandacht van de eigenaar nodig heeft/);
    assert.match(req, /Team “Webshop”:/);
    assert.match(req, /Team “Webshop”:\\nNog niet ingericht:\\n- het bedrijfsprofiel is nog leeg \([^()]*\) \(nieuw\)/);
    const msgs = e.chat();
    assert.equal(msgs.at(-2)!.content, 'Check-in: er is iets dat je aandacht nodig heeft.');
    assert.match(msgs.at(-1)!.content, /Zal ik je er een paar vragen/);

    // The same thing does not start a second check-in, also after four hours; a new thing does, but not at night.
    assert.equal(await e.at(nine + 9 * HOUR), 0);
    await e.t.api('POST', '/teams', { name: 'Privé' });
    assert.equal(await e.at(nine + 14 * HOUR), 0, '23:00: not at night');
    assert.equal(e.t.requests.length, 2);

    // The next morning it is in the morning check-in, the old one marked as told before.
    e.t.script.push({ text: 'Goedemorgen. Zal ik team Privé inrichten?' });
    assert.equal(await e.at(nine + DAY), 1);
    const next = JSON.stringify(e.t.requests.at(-1));
    assert.match(next, /Team “Webshop”:\\nNog niet ingericht:\\n- het bedrijfsprofiel is nog leeg \([^()]*\) \(al eerder genoemd\)/);
    assert.match(next, /Team “Privé”:\\nNog niet ingericht:\\n- het bedrijfsprofiel is nog leeg \([^()]*\) \(nieuw\)/);
  } finally {
    await e.t.close();
  }
});

test('settings: switching it off stops it, another hour moves it; while it is on the overview is not posted on its own', async () => {
  const e = await setup();
  try {
    const briefing = e.t.app.ctx.services.teams.briefing;
    const nine = e.day + 9 * HOUR;
    assert.equal(e.checkin.handles(e.userId), true);
    assert.deepEqual(await (e.clock.now = nine, briefing.tick()), [], 'the overview goes through the check-in');

    assert.deepEqual(await e.t.api('PUT', '/proactive/checkin', { enabled: false }), { enabled: false, time: '09:00', last: null });
    assert.deepEqual(e.t.app.ctx.store.getSetting(e.userId, 'proactive.checkin', null), { enabled: false, time: '09:00' });
    await e.t.api('POST', '/teams', { name: 'Webshop' });
    assert.equal(await e.at(nine + 60_000), 0, 'off: no morning check-in');
    assert.equal(await e.at(nine + 5 * HOUR), 0, 'off: also not when something needs him');
    assert.equal(e.t.requests.length, 0);
    assert.equal(e.checkin.handles(e.userId), false, 'off: the overview of briefing.ts is on its own again');

    // On again at another hour (the next day): not at 09:00, but at 10:30.
    assert.equal((await e.t.api('PUT', '/proactive/checkin', { enabled: true, time: '10:30' })).time, '10:30');
    await assert.rejects(e.t.api('PUT', '/proactive/checkin', { time: 'half elf' }), /UU:MM/);
    assert.equal(await e.at(nine + DAY + 60_000), 0);
    e.t.script.push({ text: 'Goedemorgen. Zal ik team Webshop inrichten?' });
    assert.equal(await e.at(nine + DAY + 90 * 60_000), 1);
    assert.equal(e.chat().at(-1)!.content, 'Goedemorgen. Zal ik team Webshop inrichten?');
  } finally {
    await e.t.close();
  }
});
