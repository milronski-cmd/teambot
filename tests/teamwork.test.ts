import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppHandle } from '../server/app.js';
import { CALL_NAME, FIND_NAME } from '../server/tools/selection.js';
import { startTestApp, type TestApp } from './helpers.js';
import { msgs, reopen, runsOf, settle, team, until, type BotStep } from './team-mock.js';

// These tests are about ordinary colleagues: without this the first bot would be the main bot (teams `autoMain`,
// covered in works-right-away.test.ts), which hears about its team in its own section.
process.env.TEAMBOT_TEST_NO_AUTO_MAIN = '1';

/**
 * Bots work as a team (live, 10–11 nov: one bot message in a whole night, its result was the worker's narration, the
 * main bot parked real work as "te doen" for itself): the asker gets the final answer, always hears the outcome, a
 * long job is not cut off, a task given to a bot starts that bot, and a restart loses nothing.
 */

const deleg = (t: { app: AppHandle }) => t.app.ctx.store.all<any>('SELECT * FROM room_delegations ORDER BY created_at').map((r: any) => t.app.ctx.store.decode<any>('room_delegations', r));
const ownerId = (t: { app: AppHandle }) => t.app.ctx.auth.owner()!.id;
const mainChat = (t: { app: AppHandle }, agentId: string) => t.app.ctx.chat.threadForAgent(ownerId(t), agentId);
const notes = (t: TestApp, threadId: string) => msgs(t, threadId).filter((x) => x.role === 'system' && x.parts.kind === 'delegation_result');
const followUps = (t: { app: AppHandle }, threadId: string) => t.app.ctx.store.all<any>("SELECT * FROM runs WHERE thread_id = ? AND json_extract(meta, '$.team.kind') = 'followup' ORDER BY created_at", threadId);
const toolOut = (t: TestApp, threadId: string) => msgs(t, threadId).filter((x) => x.role === 'tool').map((x) => x.content);

test('the asker gets the final answer of a CLI worker, not what it said between its steps', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const bo = await m.cliBot('Bo');
    const cy = await m.cliBot('Cy');
    const final = 'Eindresultaat: in 4 sitemaps ontbreken samen 4.212 pagina’s. Bewijs: sitemap-rapport.md.';
    m.script(
      'Ada',
      { toolCalls: [{ name: 'delegate_task', args: { bot: 'Bo', task: 'Controleer de sitemaps van de 4 leadsites.', expected_output: 'Klaar als: aantal ontbrekende pagina’s per site' } }, { name: 'ask_bot', args: { bot: 'Cy', message: 'Wie is de leadkoper van Voorbeeldsite?' } }] },
      { text: 'Ik heb het uitgezet.' },
      { text: 'Verwerkt.' },
      { text: 'Verwerkt.' },
    );
    // Like Claude Code: text between the steps, then the answer. One message holds all of it.
    m.script('Bo', { parts: ['Ik ga de sitemaps ophalen.', { kind: 'tool', title: 'Opende 4 sitemaps' }, 'Nog een controleronde.', { kind: 'tool', title: 'Telde de pagina’s' }, final] });
    m.script('Cy', { parts: ['Even zoeken.', { kind: 'tool', title: 'Zocht in de kennisbank' }, 'Er is geen leadkoper gekoppeld.'] });
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Kijk de leadsites na.' });
    await settle(t);

    const ds = deleg(t);
    const dBo = ds.find((d) => d.to_agent_id === bo.id)!;
    const dCy = ds.find((d) => d.to_agent_id === cy.id)!;
    assert.equal(dBo.status, 'done');
    assert.equal(dBo.result, final, 'the stored result is the final answer');
    assert.equal(dCy.result, 'Er is geen leadkoper gekoppeld.');
    assert.ok(dBo.delivered && dCy.delivered);
    // The worker's own conversation still shows everything it said.
    const boMsg = msgs(t, dBo.thread_id).find((x) => x.role === 'assistant' && x.author_id === bo.id)!;
    assert.match(boMsg.content, /Nog een controleronde\./);
    assert.equal(boMsg.parts.answer, final);
    // Ada: a note per result with the answer only, and she was woken to work with it.
    const ns = notes(t, th.id);
    assert.equal(ns.length, 2);
    const nBo = ns.find((n) => /Resultaat van de gedelegeerde taak van Bo/.test(n.content))!;
    assert.ok(nBo.content.includes(final));
    assert.doesNotMatch(nBo.content, /controleronde|Ik ga de sitemaps ophalen/);
    const nCy = ns.find((n) => /Cy antwoordde op je bericht/.test(n.content))!;
    assert.match(nCy.content, /Er is geen leadkoper gekoppeld\./);
    assert.doesNotMatch(nCy.content, /Even zoeken/);
    const fu = followUps(t, th.id);
    assert.ok(fu.length >= 1 && fu.every((r) => r.status === 'done'), 'Ada got a follow-up turn');

    // The same with a worker on an API engine that really uses a tool before it answers.
    const dex = await m.bot('Dex');
    m.script('Ada', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Dex', task: 'Kijk wat er op het takenbord staat.', expected_output: 'Klaar als: lijst van open taken' } }] }, { text: 'Uitgezet bij Dex.' }, { text: 'Dank, verwerkt.' });
    m.script('Dex', { text: 'Ik kijk op het bord.', toolCalls: [{ name: 'task_list', args: {} }] }, { text: 'Dex klaar: het takenbord is leeg.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Laat Dex het bord nakijken.' });
    await settle(t);
    const dDex = deleg(t).find((d) => d.to_agent_id === dex.id)!;
    assert.equal(dDex.result, 'Dex klaar: het takenbord is leeg.');
    assert.ok(msgs(t, dDex.thread_id).some((x) => x.role === 'tool' && /Geen taken gevonden/.test(x.content)), 'Dex used a tool');
    const nDex = notes(t, th.id).at(-1)!;
    assert.match(nDex.content, /Resultaat van de gedelegeerde taak van Dex[\s\S]*Dex klaar: het takenbord is leeg\./);
    assert.doesNotMatch(nDex.content, /Ik kijk op het bord/);
    const last = followUps(t, th.id).at(-1)!;
    assert.equal(last.status, 'done');
    assert.equal(last.input_message_id, nDex.id, 'the result is the input of the follow-up turn');
    assert.equal(msgs(t, th.id).filter((x) => x.role === 'assistant').at(-1)!.content, 'Dank, verwerkt.');
  } finally {
    await t.close();
  }
});

test('the asker always hears the outcome: an error and a failed "only tell" wake it, also at the turn cap; a stop by the owner is a note without a turn', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const bo = await m.bot('Bo');
    await m.bot('Cy');
    // A tight turn cap: the root turn and the subtask use it up. The way back must still get through.
    await t.api('PUT', '/rooms/defaults', { maxTurnsPerMessage: 2 });

    // 1. The worker's engine fails.
    m.script('Ada', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Bo', task: 'Bouw de pagina', expected_output: 'link' } }] }, { text: 'Uitgezet.' }, { text: 'Bo kon het niet; ik meld het.' });
    m.script('Bo', { error: 'model kapot', errorStatus: 400 });
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Laat Bo de pagina bouwen.' });
    await settle(t);
    let d = deleg(t).at(-1)!;
    assert.equal(d.status, 'error');
    assert.ok(d.error, 'the reason is kept');
    assert.ok(d.delivered);
    let n = notes(t, th.id).at(-1)!;
    assert.match(n.content, /Resultaat van de gedelegeerde taak van Bo \(fout\)[\s\S]*Niet gelukt: /);
    assert.equal(followUps(t, th.id).length, 1, 'the follow-up turn is not refused by the turn cap');
    assert.equal(followUps(t, th.id)[0].status, 'done');
    assert.ok(!msgs(t, th.id).some((x) => x.role === 'event' && /Maximum van 2 botbeurten/.test(x.content)));

    // 2. The owner stops the worker halfway: his stop starts nothing. Ada finds a note and reads it at her next turn
    //    (the whole rule: tests/owner-stop.test.ts).
    m.script('Ada', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Bo', task: 'Langzame klus', expected_output: 'iets' } }] }, { text: 'Uitgezet.' });
    m.script('Bo', { text: 'nooit', delayMs: 20_000 });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Nog een klus.' });
    const running = await until(() => deleg(t).find((x) => x.task === 'Langzame klus' && x.status === 'running'));
    await t.waitIdle(th.id);
    t.app.ctx.runs.cancel(running.run_id, 'Gestopt door gebruiker');
    await settle(t);
    d = deleg(t).find((x) => x.id === running.id)!;
    assert.equal(d.status, 'cancelled');
    assert.ok(d.delivered);
    assert.match(msgs(t, th.id).filter((x) => x.parts.kind === 'delegation_cancelled').at(-1)!.content, /^Gestopt door de eigenaar: het werk dat je aan Bo gaf \(“Langzame klus”\)\. Het is niet af en blijft van Bo\./);
    assert.equal(followUps(t, th.id).length, 1, 'no turn because of a stop by the owner');

    // 3. "Only tell" (reply=false): a note without a turn when it went well, a turn when it failed.
    m.script('Ada', { toolCalls: [{ name: 'ask_bot', args: { bot: 'Cy', message: 'Ruim de oude feiten op.', reply: false } }] }, { text: 'Gemeld.' });
    m.script('Cy', { text: 'Opgeruimd: 200 feiten vervallen.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Laat Cy opruimen.' });
    await settle(t);
    n = notes(t, th.id).at(-1)!;
    assert.match(n.content, /Cy heeft je melding afgehandeld:[\s\S]*200 feiten vervallen/);
    assert.equal(followUps(t, th.id).length, 1, 'no turn for a notification that went well');
    m.script('Ada', { toolCalls: [{ name: 'ask_bot', args: { bot: 'Cy', message: 'Ruim de rest op.', reply: false } }] }, { text: 'Gemeld.' }, { text: 'Cy kon het niet.' });
    m.script('Cy', { error: 'geen toegang', errorStatus: 400 });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Laat Cy de rest opruimen.' });
    await settle(t);
    n = notes(t, th.id).at(-1)!;
    assert.match(n.content, /Cy kon je bericht niet afhandelen \(fout\)[\s\S]*Niet gelukt: /);
    assert.equal(followUps(t, th.id).length, 2, 'a notification that failed wakes its sender');
    assert.ok(deleg(t).every((x) => x.delivered), 'nothing is left undelivered');
  } finally {
    await t.close();
  }
});

test('a long job is not cut off: no time limit by default, an owner-set limit and a dead engine still end it with the reason', async () => {
  const t = await startTestApp();
  const delays: number[] = [];
  const orig = globalThis.setTimeout;
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    await m.bot('Bo');
    const dex = await m.cliBot('Dex');
    const th = await t.api('POST', '/threads', { agentId: ada.id });

    // 1. Default: no timer of 10 or 15 minutes (the old turn and subtask time-outs) is set for the worker's turn.
    // (Only timers of the work between bots count: another part of TeamBot may have a timer of its own that long.)
    (globalThis as any).setTimeout = (fn: any, ms?: number, ...a: any[]) => {
      if (/modules[\\/]rooms[\\/]/.test(new Error().stack || '')) delays.push(Number(ms) || 0);
      return (orig as any)(fn, ms, ...a);
    };
    m.script('Ada', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Bo', task: 'Grote klus', expected_output: 'rapport' } }] }, { text: 'Uitgezet.' }, { text: 'Verwerkt.' });
    m.script('Bo', { text: 'Bo: grote klus af', delayMs: 1200 });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Geef Bo de grote klus.' });
    await settle(t);
    globalThis.setTimeout = orig;
    assert.equal(deleg(t).at(-1)!.status, 'done');
    assert.ok(!delays.some((d) => d === 600_000 || d === 900_000), 'no 10- or 15-minute cut-off timer');
    const limits = (await t.api('GET', '/rooms/defaults')) as any;
    assert.equal((limits.limits || limits).delegationTimeoutSec, 0);

    // 2. A turn whose engine process is gone is dead: it is stopped and the asker hears why. A working turn is left alone.
    m.script('Ada', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Dex', task: 'Klus op een CLI', expected_output: 'iets' } }] }, { text: 'Uitgezet.' }, { text: 'Dex viel weg; ik meld het.' });
    m.script('Dex', { text: 'nooit', delayMs: 30_000 });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Geef Dex een klus.' });
    const dd = await until(() => deleg(t).find((x) => x.to_agent_id === dex.id && x.status === 'running'));
    await t.waitIdle(th.id);
    const rooms = t.app.ctx.services.rooms;
    // (No clock of its own: the one planner looks once a minute; that look is what is called here.)
    assert.ok((t.app.ctx.services.routines.engine.planner as any).entries.has('rooms-dead'), 'registered with the planner');
    assert.equal(rooms.watchDead(), 0, 'a turn that works is never stopped, however long it takes');
    assert.equal(rooms.watchDead(Date.now() + 6 * 3600_000), 0, 'not after six hours either');
    const pulse = t.app.ctx.runs.pulse as any;
    const info = pulse.info.bind(pulse);
    pulse.info = (id: string) => (id === dd.run_id ? { ...info(id), process: 'gone', lastActivityAt: Date.now() - 11 * 60_000 } : info(id));
    assert.equal(rooms.watchDead(), 1);
    await settle(t);
    pulse.info = info;
    const dead = deleg(t).find((x) => x.id === dd.id)!;
    assert.equal(dead.status, 'timeout');
    assert.match(notes(t, th.id).at(-1)!.content, /time-out[\s\S]*Niet gelukt: Time-out: het programma van Dex is gestopt zonder resultaat/);
    assert.equal(followUps(t, th.id).at(-1)!.status, 'done');

    // 3. The owner can still set a limit himself; then the job is cut and the asker hears it.
    await t.api('PUT', '/rooms/defaults', { delegationTimeoutSec: 1 });
    m.script('Ada', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Bo', task: 'Te trage klus', expected_output: 'iets' } }] }, { text: 'Uitgezet.' }, { text: 'Bo was te laat.' });
    m.script('Bo', { text: 'nooit', delayMs: 20_000 });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Nog een klus voor Bo.' });
    await settle(t);
    assert.equal(deleg(t).at(-1)!.status, 'timeout');
    assert.match(notes(t, th.id).at(-1)!.content, /Niet gelukt: Time-out: Bo gaf binnen 1 s geen resultaat/);
  } finally {
    globalThis.setTimeout = orig;
    await t.close();
  }
});

test('a task given to a bot starts that bot and its outcome comes back; the owner is found by the words a bot uses', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const bo = await m.bot('Bo', { role: 'SEO-specialist' });
    const cy = await m.bot('Cy', { role: 'Beheerder leadsites' });
    const dex = await m.bot('Dex');
    const th = await t.api('POST', '/threads', { agentId: ada.id });

    // 1. A bot makes a task with a colleague as owner: the colleague starts, the maker hears the outcome.
    m.script('Ada', { toolCalls: [{ name: 'task_create', args: { title: 'Sitemaps van 4 leadsites aanvullen', description: 'Duizenden pagina’s ontbreken.', owner: 'Bo', done_when: 'Alle pagina’s staan in de sitemaps.' } }] }, { text: 'Staat bij Bo.' }, { text: 'Bo heeft het gedaan.' });
    m.script('Bo', { text: 'Sitemaps aangevuld voor 4 sites. Bewijs: sitemap.xml.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'De sitemaps zijn onvolledig.' });
    await settle(t);
    assert.match(toolOut(t, th.id)[0], /Taak aangemaakt[\s\S]*eigenaar: Bo[\s\S]*Bo begint aan deze taak/);
    const task1 = (await t.api('GET', '/rooms/tasks')).find((x: any) => x.title === 'Sitemaps van 4 leadsites aanvullen');
    const d1 = deleg(t).find((d) => d.task_id === task1.id)!;
    assert.equal(d1.to_agent_id, bo.id);
    assert.equal(d1.status, 'done');
    const boChat = mainChat(t, bo.id);
    const brief = msgs(t, boChat.id).find((x) => x.parts.kind === 'bot_ask')!;
    assert.equal(brief.parts.taskId, task1.id);
    assert.match(brief.content, /^Taak van Ada voor jou op het takenbord: “Sitemaps van 4 leadsites aanvullen”[\s\S]*Duizenden pagina’s ontbreken\.[\s\S]*Klaar als: Alle pagina’s staan in de sitemaps\.[\s\S]*Begin er nu aan/);
    assert.equal(runsOf(t, boChat.id, bo.id).length, 1, 'Bo was started');
    const n1 = notes(t, th.id).at(-1)!;
    assert.match(n1.content, /Bo meldt over de taak die je gaf:[\s\S]*Sitemaps aangevuld voor 4 sites[\s\S]*staat nu op: Te doen\. Hij is dus nog niet af/);
    assert.equal(followUps(t, th.id).length, 1);

    // 2. An existing task is given to another bot with task_update: that bot starts.
    const loose = await t.api('POST', '/rooms/tasks', { title: 'Leadkoper zoeken voor Voorbeeldsite' });
    assert.equal(loose.started, null);
    m.script('Ada', { toolCalls: [{ name: 'task_update', args: { id: loose.id, owner: 'de beheerder leadsites' } }] }, { text: 'Bij Cy gelegd.' }, { text: 'Cy is bezig.' });
    m.script('Cy', { text: 'Ik zoek een leadkoper; drie kandidaten gemaild.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Voorbeeldsite heeft geen leadkoper.' });
    await settle(t);
    assert.match(toolOut(t, th.id).at(-1)!, /Bijgewerkt[\s\S]*eigenaar: Cy[\s\S]*Cy begint aan deze taak/);
    assert.equal(runsOf(t, mainChat(t, cy.id).id, cy.id).length, 1);
    assert.match(notes(t, th.id).at(-1)!.content, /Cy meldt over de taak die je gaf:[\s\S]*drie kandidaten gemaild/);

    // 3. Parked with the bot itself: it hears to start or to give it to a colleague. "eigenaar" is the person.
    m.script('Ada', { toolCalls: [{ name: 'task_create', args: { title: 'Feeds nalopen', owner: 'mij' } }] }, { toolCalls: [{ name: 'task_create', args: { title: 'Btw-id opzoeken', owner: 'de eigenaar' } }] }, { text: 'Genoteerd.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Noteer dit.' });
    await settle(t);
    const out = toolOut(t, th.id);
    assert.match(out.at(-2)!, /eigenaar: Ada[\s\S]*Je bent zelf eigenaar[\s\S]*Bo \(SEO-specialist\)/);
    const me = t.app.ctx.store.user(ownerId(t))!;
    assert.ok(out.at(-1)!.includes(`eigenaar: ${me.name}`), '"de eigenaar" is the person the bots work for');
    assert.ok(!out.at(-1)!.includes('Onbekende eigenaar'));

    // 4. The person gives a task to a bot: the bot starts in its own chat.
    m.script('Dex', { text: 'Dex: begonnen aan de feed.' });
    const mine = await t.api('POST', '/rooms/tasks', { title: 'Feed controleren', ownerType: 'agent', ownerId: dex.id });
    assert.equal(mine.started?.agentName, 'Dex');
    await settle(t);
    const dexChat = mainChat(t, dex.id);
    assert.match(msgs(t, dexChat.id).find((x) => x.parts.kind === 'task_assigned')!.content, /^Taak voor jou op het takenbord: “Feed controleren”/);
    assert.equal(runsOf(t, dexChat.id, dex.id).length, 1);
    // …and with a change of owner on the board.
    m.script('Bo', { text: 'Bo: feed opgepakt.' });
    const moved = await t.api('PATCH', `/rooms/tasks/${mine.id}`, { ownerType: 'agent', ownerId: bo.id });
    assert.equal(moved.started?.agentName, 'Bo');
    await settle(t);
    assert.ok(msgs(t, boChat.id).some((x) => x.parts.kind === 'task_assigned'));

    // 5. The bot that got task 1 gives up later, in its own chat: the maker (Ada) hears it as a new turn.
    m.script('Bo', { toolCalls: [{ name: 'task_done', args: { id: task1.id, outcome: 'cannot', reason: 'Geen toegang tot de server van de leadsites.' } }] }, { text: 'Gemeld.' });
    m.script('Ada', { text: 'Ik regel toegang.' });
    await t.api('POST', `/threads/${boChat.id}/messages`, { content: 'Hoe staat het met de sitemaps?' });
    await settle(t);
    const n5 = notes(t, th.id).at(-1)!;
    assert.match(n5.content, /Bo kon de taak die je gaf niet doen[\s\S]*Geen toegang tot de server van de leadsites\.[\s\S]*staat nu op: Geblokkeerd/);
    assert.equal(followUps(t, th.id).at(-1)!.status, 'done');
    assert.ok(deleg(t).every((x) => x.delivered));
  } finally {
    await t.close();
  }
});

test('every bot with colleagues knows them, always has delegate_task and reaches the other team tools', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const solo = await m.bot('Solo');
    const th0 = await t.api('POST', '/threads', { agentId: solo.id });
    await t.say(th0.id, 'hoi');
    assert.doesNotMatch(m.calls.at(-1)!.req.system, /Samenwerken met je team/, 'a bot without colleagues hears nothing about a team');

    await m.bot('Radar', { role: 'Beheerder leadsites: techniek, leadroute en onderhoud' });
    await m.bot('Vindbaar', { role: 'SEO-specialist' });
    await t.say(th0.id, 'en nu?');
    const req = m.calls.at(-1)!.req;
    assert.match(req.system, /## Samenwerken met je team[\s\S]*- Radar — Beheerder leadsites: techniek, leadroute en onderhoud\n- Vindbaar — SEO-specialist/);
    assert.match(req.system, /delegate_task[\s\S]*ask_bot[\s\S]*Zet werk nooit als "te doen" bij jezelf/);
    // Handing work to a colleague is always in the list (tools/selection.ts); the other team tools are found on demand,
    // and the tool that finds them says so.
    const names = (req.tools || []).map((x: any) => x.name);
    assert.ok(names.includes('delegate_task') && names.includes('ask_bot'), 'work and a question for a colleague are sent with every call');
    const find = (req.tools || []).find((x: any) => x.name === FIND_NAME)!;
    const agent = t.app.ctx.store.agent(solo.id)!;
    const thread = t.app.ctx.store.thread(th0.id)!;
    const all = (await t.app.ctx.tools.forAgent(agent, thread)).map((x) => x.name);
    for (const n of ['task_create', 'task_update', 'delegation_status', 'message_bot']) assert.ok(all.includes(n) && !names.includes(n) && names.includes(CALL_NAME) && new RegExp(`collega-bots en takenbord: [^;]*\\b${n}\\b`).test(find.description), `${n} is named in tools_find and reached through tools_call`);
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------- restart

test('a restart loses nothing: a result that waited is delivered, a subtask that was cut off goes on', async () => {
  const t = await startTestApp();
  let r2: Awaited<ReturnType<typeof reopen>> | null = null;
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const bo = await m.bot('Bo');
    const cy = await m.bot('Cy');
    // Ada stays busy after delegating: Bo's result is held for her. Cy is still working when TeamBot closes.
    m.script(
      'Ada',
      { toolCalls: [{ name: 'delegate_task', args: { bot: 'Bo', task: 'Schrijf het rapport', expected_output: 'rapport.md' } }, { name: 'delegate_task', args: { bot: 'Cy', task: 'Herstel de leadroute', expected_output: 'bewijs' } }] },
      { text: 'nog bezig', delayMs: 60_000 },
    );
    m.script('Bo', { text: 'Bo: rapport.md staat klaar.' });
    m.script('Cy', { text: 'nooit', delayMs: 60_000 });
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Zet het team aan het werk.' });
    const held = await until(() => deleg(t).find((d) => d.to_agent_id === bo.id && d.status === 'done'), 10_000);
    assert.equal(held.delivered, false, 'Ada is busy: the result waits');
    await until(() => deleg(t).find((d) => d.to_agent_id === cy.id && d.status === 'running'));
    assert.equal(notes(t, th.id).length, 0);
    await t.app.close();

    const scripts = new Map<string, BotStep[]>([
      ['Ada', [{ text: 'Rapport van Bo verwerkt.' }, { text: 'Leadroute van Cy verwerkt.' }]],
      ['Cy', [{ text: 'Cy: leadroute hersteld, testaanvraag kwam aan.' }]],
    ]);
    r2 = await reopen(t, scripts);
    const store = r2.app.ctx.store;
    const all = () => deleg(r2!);
    await until(() => all().every((d) => d.status === 'done' && d.delivered), 15_000);
    await settle(r2);
    const after = store.messages(th.id, { limit: 1000 }).filter((x) => x.role === 'system' && x.parts.kind === 'delegation_result');
    assert.ok(after.some((n) => /rapport\.md staat klaar/.test(n.content)), 'the held result was delivered after the restart');
    assert.ok(after.some((n) => /leadroute hersteld, testaanvraag kwam aan/.test(n.content)), 'the cut-off subtask went on and its result came back');
    const dCy = all().find((d) => d.to_agent_id === cy.id)!;
    assert.ok(store.messages(dCy.thread_id, { limit: 100 }).some((x) => x.role === 'system' && /TeamBot is opnieuw gestart terwijl je aan deze opdracht van Ada werkte/.test(x.content)));
    const fu = followUps(r2, th.id);
    assert.ok(fu.length >= 1 && fu.every((r) => r.status === 'done'), 'Ada was woken with the results');
    assert.doesNotMatch(after.map((n) => n.content).join('\n'), /geen automatische vervolgbeurt/);
  } finally {
    if (r2) await r2.close();
    else await t.close();
  }
});
