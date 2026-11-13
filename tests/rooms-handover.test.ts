import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AppHandle } from '../server/app.js';
import { cliPrompt } from '../server/agent/prompt.js';
import { stoppedByOwner } from '../server/agent/runs.js';
import { PermissionBridge, type StdioServer } from '../server/modules/cli-agents/bridge.js';
import { makeScope, stoppedTaskNote } from '../server/modules/cli-agents/context.js';
import { teambotTools } from '../server/modules/cli-agents/toolhost.js';
import { RoomService } from '../server/modules/rooms/service.js';
import { startTestApp, type TestApp } from './helpers.js';
import { startFakeOllama } from './memory-fake-ollama.js';
import { msgs, reopen, runsOf, settle, sleep, team, until, type BotStep } from './team-mock.js';

/**
 * Work a bot gives to another bot is one record with one life cycle (gevraagd → bezig → terug / niet gelukt / gestopt
 * door de eigenaar), whatever tool gave it: delegate_task, message_bot, ask_bot, broadcast or a task on the board with
 * an owner. The outcome comes back one way: at the end of the receiver's turn, to the bot that gave it.
 */

process.env.TEAMBOT_TEST_NO_AUTO_MAIN = '1';

type App = { app: AppHandle };
const deleg = (t: App) => t.app.ctx.store.all<any>('SELECT * FROM room_delegations ORDER BY created_at, rowid').map((r: any) => t.app.ctx.store.decode<any>('room_delegations', r));
const allRuns = (t: App) => t.app.ctx.store.all<any>('SELECT * FROM runs ORDER BY created_at, rowid');
const notesOf = (t: App, threadId: string, kind: string) => t.app.ctx.store.messages(threadId, { limit: 1000 }).filter((x) => x.role === 'system' && x.parts.kind === kind);
const stopNotes = (t: App, threadId: string) => notesOf(t, threadId, 'delegation_cancelled');
const resultNotes = (t: App, threadId: string) => notesOf(t, threadId, 'delegation_result');
const toolOut = (t: TestApp, threadId: string) => msgs(t, threadId).filter((x) => x.role === 'tool').map((x) => x.content);
const running = (t: App, agentId: string) => t.app.ctx.store.all<any>("SELECT id FROM runs WHERE agent_id = ? AND status = 'running'", agentId).length > 0;

/** Nothing is running, and nothing starts in the moments after either. */
async function quiet(t: App) {
  await settle(t);
  await sleep(300);
  await settle(t);
}

test('"Alles stoppen" while the giver is still in its own turn: it reads what it had given to whom, that the owner stopped it and how to give it again', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const bo = await m.bot('Bo');
    const cy = await m.bot('Cy');
    const store = t.app.ctx.store;
    const th = await t.api('POST', '/threads', { agentId: ada.id });

    // 1. The giver waits inside its turn for the colleague (the call is still in flight) when the owner stops everything.
    m.script('Ada', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Bo', task: 'Zoek uit waarom het formulier niet werkt.', expected_output: 'de oorzaak', wait: true, wait_seconds: 600 } }] });
    m.script('Bo', { text: 'nooit', delayMs: 30_000 });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Laat Bo het formulier uitzoeken.' });
    const d1 = await until(() => deleg(t).find((x) => x.to_agent_id === bo.id && x.status === 'running'));
    assert.ok(running(t, ada.id), 'the giver is still in its own turn');
    let n = allRuns(t).length;
    assert.equal((await t.api('POST', '/stop-all', {})).stopped, 2);
    await quiet(t);
    assert.equal(allRuns(t).length, n, 'nothing started because of the stop');
    let d = deleg(t).find((x) => x.id === d1.id)!;
    assert.equal(d.status, 'cancelled');
    assert.equal(d.error, 'Alles gestopt');
    assert.ok(d.delivered, 'told, nothing still waits');
    // The call itself does not say "not handed over": the work was with the colleague.
    assert.match(toolOut(t, th.id).at(-1)!, /^Gestopt door de eigenaar terwijl je op Bo wachtte\. Het werk was al aan Bo gegeven/);
    assert.equal(stopNotes(t, th.id).length, 1);
    assert.equal(
      stopNotes(t, th.id)[0].content,
      'Gestopt door de eigenaar: het werk dat je aan Bo gaf (“Zoek uit waarom het formulier niet werkt.”). Het doorgeven was gelukt voordat de eigenaar ook jouw beurt stopte. Het is niet af en blijft van Bo. Opnieuw geven kan met delegate_task.',
    );
    assert.equal(resultNotes(t, th.id).length, 0, 'no "niet gelukt"');

    // A CLI engine keeps its own session, and that session never saw the outcome of the call that was cut off: the
    // line it gets with its next turn says the work did arrive (asked here for a turn that would start now).
    const stoppedRun = runsOf(t, th.id, ada.id).at(-1)!;
    const probe = store.createRun({ thread_id: th.id, agent_id: ada.id, user_id: stoppedRun.user_id, trigger: 'user', input_message_id: null, meta: {} });
    const cliNote = stoppedTaskNote(t.app.ctx, { threadId: th.id, agentId: ada.id, runId: probe.id });
    store.exec('DELETE FROM runs WHERE id = ?', probe.id);
    assert.match(cliNote, /^\[TeamBot\] De eigenaar heeft je vorige taak gestopt\./);
    assert.match(cliNote, /Wat je in die beurt al aan een collega had gegeven, is aangekomen en met jouw beurt gestopt/);

    // At its next turn the giver reads the note.
    let seen = '';
    m.script('Ada', { text: 'Ik had het aan Bo gegeven; jij hebt ons beiden gestopt.', check: (req) => (seen = JSON.stringify(req.messages)) });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Had je het doorgegeven?' });
    await quiet(t);
    assert.match(seen, /\[Systeem\]: Gestopt door de eigenaar: het werk dat je aan Bo gaf \(“Zoek uit waarom het formulier niet werkt\.”\)\. Het doorgeven was gelukt/);
    assert.equal(runsOf(t, th.id, ada.id).length, 2, 'only the turn the owner asked for');

    // 2. The giver did not wait, but its turn was still going (the colleague already working) when the owner stopped
    //    everything: the same note.
    m.script('Ada', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Bo', task: 'Maak de actielijst.', expected_output: 'actielijst.md' } }, { name: 'task_create', args: { title: 'Planning bijwerken', owner: 'Cy', done_when: 'De planning staat in planning.md' } }] }, { text: 'nog bezig', delayMs: 30_000 });
    m.script('Bo', { text: 'nooit', delayMs: 30_000 });
    m.script('Cy', { text: 'nooit', delayMs: 30_000 });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Zet Bo en Cy aan het werk.' });
    await until(() => deleg(t).filter((x) => x.status === 'running').length === 2);
    assert.ok(running(t, ada.id));
    n = allRuns(t).length;
    assert.equal((await t.api('POST', '/stop-all', {})).stopped, 3);
    await quiet(t);
    assert.equal(allRuns(t).length, n, 'nothing started because of the stop');
    assert.ok(deleg(t).every((x) => stoppedByOwner(x) && x.delivered));
    const two = stopNotes(t, th.id).slice(-2).map((x) => x.content);
    const taskId = store.one<any>("SELECT id FROM room_tasks WHERE title = 'Planning bijwerken'").id;
    assert.ok(two.includes('Gestopt door de eigenaar: het werk dat je aan Bo gaf (“Maak de actielijst.”). Het doorgeven was gelukt voordat de eigenaar ook jouw beurt stopte. Het is niet af en blijft van Bo. Opnieuw geven kan met delegate_task.'), two.join('\n'));
    assert.ok(two.includes(`Gestopt door de eigenaar: de taak “Planning bijwerken” die je aan Cy gaf. Het doorgeven was gelukt voordat de eigenaar ook jouw beurt stopte. De taak is niet af, staat op Te doen en blijft van Cy. Opnieuw starten kan met task_update (id ${taskId}, owner Cy).`), two.join('\n'));

    // 3. Only the giver is stopped while it waits for the colleague: what it gave in that turn stops with it, by the
    //    owner's hand, and the note says so.
    m.script('Ada', { toolCalls: [{ name: 'message_bot', args: { bot: 'Bo', message: 'Hoeveel regels heeft de actielijst?' } }] });
    m.script('Bo', { text: 'nooit', delayMs: 30_000 });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Vraag het Bo.' });
    const d3 = await until(() => deleg(t).find((x) => x.kind === 'message' && x.status === 'running'));
    n = allRuns(t).length;
    assert.equal((await t.api('POST', `/threads/${th.id}/stop`, {})).stopped, 1);
    await quiet(t);
    assert.equal(allRuns(t).length, n);
    d = deleg(t).find((x) => x.id === d3.id)!;
    assert.ok(stoppedByOwner(d), `${d.status}: ${d.error}`);
    assert.ok(d.delivered);
    assert.equal(stopNotes(t, th.id).at(-1)!.content, 'Gestopt door de eigenaar: je bericht aan Bo (“Hoeveel regels heeft de actielijst?”). Het was aangekomen voordat de eigenaar ook jouw beurt stopte. Er komt geen antwoord op. Opnieuw sturen kan.');
    assert.equal(resultNotes(t, th.id).length, 0);
  } finally {
    await t.close();
  }
});

test('a task on the board for a colleague is a hop in the same chain: its outcome goes back up, a stop goes down, and the loop rule holds for it', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const bo = await m.bot('Bo');
    const cy = await m.bot('Cy');
    const store = t.app.ctx.store;
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    const byTask = (title: string) => deleg(t).find((x) => x.task_id && store.one<any>('SELECT title FROM room_tasks WHERE id = ?', x.task_id)?.title === title)!;

    // 1. Ada gives Bo a job; Bo puts part of it on the board for Cy. One chain: Ada hears Bo's answer when Cy is done.
    m.script('Ada', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Bo', task: 'Lever het kwartaalrapport op.', expected_output: 'rapport.md' } }] }, { text: 'Uitgezet bij Bo.' }, { text: 'Het rapport is binnen.' });
    m.script('Bo', { toolCalls: [{ name: 'task_create', args: { title: 'Cijfers doorrekenen', owner: 'Cy', done_when: 'De cijfers staan in cijfers.md' } }] }, { text: 'Cy rekent; ik wacht.' }, { text: 'Bo: rapport.md is af, met de cijfers van Cy.' });
    m.script('Cy', { text: 'Cy: de cijfers staan in cijfers.md.', delayMs: 300 });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Laat het kwartaalrapport maken.' });
    const dTask = await until(() => byTask('Cijfers doorrekenen'));
    const dBo = deleg(t).find((x) => x.to_agent_id === bo.id)!;
    assert.equal(dTask.chain_id, dBo.chain_id, 'the task is part of the chain it was given in');
    assert.deepEqual(dTask.path, [ada.id, bo.id, cy.id]);
    assert.equal(dTask.depth, 2);
    assert.equal(resultNotes(t, th.id).length, 0, 'Bo still waits for Cy: nothing went up yet');
    await quiet(t);
    assert.ok(deleg(t).every((x) => x.status === 'done' && x.delivered));
    assert.match(resultNotes(t, dBo.thread_id)[0].content, /Cy meldt over de taak die je gaf:[\s\S]*cijfers\.md/);
    assert.equal(resultNotes(t, th.id).length, 1);
    assert.match(resultNotes(t, th.id)[0].content, /Resultaat van de gedelegeerde taak van Bo[\s\S]*met de cijfers van Cy/);
    assert.equal(msgs(t, th.id).filter((x) => x.role === 'assistant').at(-1)!.content, 'Het rapport is binnen.');

    // 2. A stop of the owner goes down and up the same chain: Cy works on a task Bo gave, Bo waits, Ada is idle.
    m.script('Ada', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Bo', task: 'Lever het jaarrapport op.', expected_output: 'jaar.md' } }] }, { text: 'Uitgezet bij Bo.' });
    m.script('Bo', { toolCalls: [{ name: 'task_create', args: { title: 'Jaarcijfers doorrekenen', owner: 'Cy', done_when: 'De cijfers staan in jaar-cijfers.md' } }] }, { text: 'Cy rekent; ik wacht.' });
    m.script('Cy', { text: 'nooit', delayMs: 30_000 });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Laat het jaarrapport maken.' });
    await until(() => byTask('Jaarcijfers doorrekenen')?.status === 'running');
    await until(() => !store.all("SELECT id FROM runs WHERE agent_id != ? AND status IN ('queued','running','waiting')", cy.id).length);
    const n = allRuns(t).length;
    assert.equal((await t.api('POST', '/stop-all', {})).stopped, 1);
    await quiet(t);
    assert.equal(allRuns(t).length, n, 'no follow-up turn for Bo or Ada');
    const dBo2 = deleg(t).find((x) => x.task === 'Lever het jaarrapport op.')!;
    assert.ok(stoppedByOwner(byTask('Jaarcijfers doorrekenen')));
    assert.ok(stoppedByOwner(dBo2), 'the subtask that waited only for the stopped task is stopped with it');
    assert.ok(deleg(t).every((x) => x.delivered));
    assert.match(stopNotes(t, dBo2.thread_id).at(-1)!.content, /^Gestopt door de eigenaar: de taak “Jaarcijfers doorrekenen” die je aan Cy gaf\. De taak is niet af, staat op Te doen en blijft van Cy\./);
    assert.match(stopNotes(t, th.id).at(-1)!.content, /^Gestopt door de eigenaar: het werk dat je aan Bo gaf \(“Lever het jaarrapport op\.”\)/);

    // 3. The loop rule is the same as for every other way of giving work: a task for a bot that is already in the chain
    //    is put on the board, but does not start that bot.
    m.script('Ada', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Bo', task: 'Controleer de planning.', expected_output: 'een oordeel' } }] }, { text: 'Uitgezet bij Bo.' }, { text: 'Bo heeft geantwoord.' });
    m.script('Bo', { toolCalls: [{ name: 'task_create', args: { title: 'Planning nalopen', owner: 'Ada', done_when: 'Ada heeft de planning gezien' } }] }, { text: 'Bo: de planning klopt; ik heb een taak voor Ada op het bord gezet.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Laat Bo de planning controleren.' });
    await quiet(t);
    const dBo3 = deleg(t).find((x) => x.task === 'Controleer de planning.')!;
    const out = toolOut(t, dBo3.thread_id).at(-1)!;
    assert.match(out, /Taak aangemaakt:[\s\S]*Ada is NIET gestart met deze taak: Geweigerd om een lus te voorkomen: Ada zit al in deze keten \(Ada → Bo → Ada\)/);
    const tk = store.one<any>("SELECT * FROM room_tasks WHERE title = 'Planning nalopen'");
    assert.equal(tk.owner_id, ada.id, 'the task is on the board, with its owner');
    assert.equal(byTask('Planning nalopen'), undefined, 'no request was made for it');
    assert.equal(dBo3.status, 'done');
  } finally {
    await t.close();
  }
});

test('one task on the board gives one start: the hand-over starts the colleague, and the work loop leaves the task alone while that hand-over runs or its outcome waits for the giver', async () => {
  const t = await startTestApp();
  const { work, engine } = t.app.ctx.services.routines;
  const realNow = engine.now;
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const bo = await m.bot('Bo');
    const store = t.app.ctx.store;
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    const turnsOfBo = () => allRuns(t).filter((x) => x.agent_id === bo.id);
    const onList = async () => ((await work.views(ada.user_id)).find((v: any) => v.agentId === bo.id)?.items || []).map((i: any) => i.kind);

    // Ada gives Bo a task and stays busy in her own turn. Bo's turn ends, and the task is not finished yet.
    m.script('Ada', { toolCalls: [{ name: 'task_create', args: { title: 'Planning bijwerken', owner: 'Bo', done_when: 'De planning staat in planning.md' } }] }, { text: 'nog bezig', delayMs: 30_000 });
    m.script('Bo', { text: 'Bo: ik ben begonnen; de rest volgt.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Laat Bo de planning bijwerken.' });
    const d = await until(() => deleg(t).find((x) => x.status === 'done'));
    await until(() => !store.all("SELECT id FROM runs WHERE agent_id = ? AND status IN ('queued','running','waiting')", bo.id).length);
    assert.equal(d.delivered, false, 'Ada is busy: the outcome of the hand-over waits for her');
    assert.equal(store.one<any>("SELECT status FROM room_tasks WHERE title = 'Planning bijwerken'").status, 'todo', 'the task is still open');
    assert.equal(turnsOfBo().length, 1, 'the hand-over started Bo, once');

    // The work loop looks, also when it has been quiet for a while: the task is in a hand-over, so it starts nothing.
    engine.now = () => Date.now() + 6 * 60_000;
    work.enabled = true;
    assert.deepEqual(await onList(), [], 'the task is not the work loop’s to start');
    assert.equal(await work.tick(), 0, 'no second start while the outcome waits for the giver');
    await work.idle();
    assert.equal(turnsOfBo().length, 1);

    // The giver is told (her turn ends; here the owner stops it). From then on the open task is work that lies there,
    // and the work loop may pick it up like any other task of that bot.
    engine.now = realNow;
    work.enabled = false;
    await t.api('POST', `/threads/${th.id}/stop`, {});
    m.script('Ada', { text: 'Bo is begonnen.' }, { text: 'Ik volg het op.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Hoe staat het?' });
    await quiet(t);
    assert.ok(deleg(t).every((x) => x.delivered), 'the giver has the outcome');
    assert.match(resultNotes(t, th.id).at(-1)!.content, /Bo meldt over de taak die je gaf:[\s\S]*De taak “Planning bijwerken” staat nu op: Te doen\. Hij is dus nog niet af/);
    work.enabled = true;
    assert.deepEqual(await onList(), ['task']);
  } finally {
    work.enabled = false;
    engine.now = realNow;
    await work.idle();
    await t.close();
  }
});

// ---------------------------------------------------------------- one way back, also where repair paths used to be

test('one way back: a crash and a usage limit wake the giver with the reason, work finished after all still comes back, a wait that ran out and an archived giver lose nothing', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    await m.bot('Bo', { settings: { onLimit: 'wait' } });
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    const followUps = () => runsOf(t, th.id, ada.id).filter((x) => x.trigger === 'team:followup');
    const rec = (id: string) => deleg(t).find((x) => x.id === id)!;

    // 1. The receiver's turn crashes: the giver is woken with the reason. The owner presses "Opnieuw proberen" in the
    //    subtask conversation: the work is finished after all, and comes back the same way.
    m.script('Ada', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Bo', task: 'Schrijf het verslag.', expected_output: 'verslag.md' } }] }, { text: 'Uitgezet bij Bo.' }, { text: 'Bo liep vast.' });
    m.script('Bo', { error: 'model kapot', errorStatus: 400 });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Laat Bo het verslag schrijven.' });
    await quiet(t);
    let d = deleg(t).at(-1)!;
    assert.equal(d.status, 'error');
    assert.ok(d.delivered);
    assert.match(resultNotes(t, th.id).at(-1)!.content, /Resultaat van de gedelegeerde taak van Bo \(fout\)[\s\S]*Niet gelukt: /);
    assert.equal(followUps().length, 1);
    m.script('Bo', { text: 'Bo: verslag.md is geschreven.' });
    m.script('Ada', { text: 'Het verslag is er alsnog.' });
    await t.api('POST', `/threads/${d.thread_id}/retry`, {});
    await quiet(t);
    d = rec(d.id);
    assert.equal(d.status, 'done');
    assert.equal(d.result, 'Bo: verslag.md is geschreven.');
    assert.equal(d.error, null);
    assert.ok(d.delivered);
    assert.match(resultNotes(t, th.id).at(-1)!.content, /Resultaat van de gedelegeerde taak van Bo \((?:klaar|te controleren)\)[\s\S]*verslag\.md is geschreven/);
    assert.equal(followUps().length, 2, 'the giver is woken with the result');
    assert.ok(msgs(t, d.thread_id).some((x) => x.role === 'event' && x.content === 'Resultaat teruggestuurd naar Ada (klaar).'));

    // 2. The receiver hits a usage limit: the giver hears it, with the reason. When TeamBot tries again after the
    //    reset and it works, that result comes back too.
    m.script('Ada', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Bo', task: 'Vat het verslag samen.', expected_output: 'drie regels' } }] }, { text: 'Uitgezet bij Bo.' }, { text: 'Bo zit aan zijn limiet.' });
    m.script('Bo', { error: 'Rate limit reached. Try again in 20 minutes.', errorStatus: 429 });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Laat Bo het samenvatten.' });
    await quiet(t);
    d = deleg(t).at(-1)!;
    assert.equal(d.status, 'error');
    assert.ok(d.delivered);
    assert.match(resultNotes(t, th.id).at(-1)!.content, /Resultaat van de gedelegeerde taak van Bo \(fout\)[\s\S]*Niet gelukt: /);
    assert.equal(followUps().length, 3);
    const failed = t.app.ctx.store.run(d.run_id)!;
    assert.ok(failed.meta.limitRetryAt, 'TeamBot tries again after the reset');
    m.script('Bo', { text: 'Bo: de samenvatting staat in drie regels.' });
    m.script('Ada', { text: 'De samenvatting is binnen.' });
    t.app.ctx.services.runner.armRetry(failed.id, Date.now() + 10);
    await until(() => rec(d.id).status === 'done');
    await quiet(t);
    assert.ok(rec(d.id).delivered);
    assert.match(resultNotes(t, th.id).at(-1)!.content, /Resultaat van de gedelegeerde taak van Bo \((?:klaar|te controleren)\)[\s\S]*drie regels/);
    assert.equal(followUps().length, 4);

    // 3. The giver waits inside its turn and the wait runs out: the outcome comes the normal way, a note and a turn.
    m.script('Ada', { toolCalls: [{ name: 'message_bot', args: { bot: 'Bo', message: 'Hoeveel regels heeft het verslag?', wait_seconds: 5 } }] }, { text: 'Bo is nog bezig; ik rond af.' }, { text: 'Bo zegt: 40 regels.' });
    m.script('Bo', { text: 'Bo: 40 regels.', delayMs: 6000 });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Vraag het Bo.' });
    await settle(t, 30_000);
    await quiet(t);
    assert.match(toolOut(t, th.id).at(-1)!, /^Bo is na 5 s nog bezig/);
    d = deleg(t).at(-1)!;
    assert.equal(d.status, 'done');
    assert.ok(d.delivered);
    assert.match(resultNotes(t, th.id).at(-1)!.content, /Antwoord van Bo \(klaar\)[\s\S]*40 regels/);
    assert.equal(msgs(t, th.id).filter((x) => x.role === 'assistant').at(-1)!.content, 'Bo zegt: 40 regels.');
    assert.equal(followUps().length, 5);

    // 4. The giver is archived while the receiver works: a bot that is gone is not woken, and nothing keeps waiting.
    m.script('Ada', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Bo', task: 'Ruim de map op.', expected_output: 'een lijst' } }] }, { text: 'Uitgezet bij Bo.' });
    m.script('Bo', { text: 'Bo: de map is opgeruimd.', delayMs: 500 });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Laat Bo opruimen.' });
    await until(() => deleg(t).at(-1)!.task === 'Ruim de map op.' && deleg(t).at(-1)!.status === 'running');
    await t.waitIdle(th.id);
    await t.api('PATCH', `/agents/${ada.id}`, { archived: true });
    await quiet(t);
    d = deleg(t).at(-1)!;
    assert.equal(d.status, 'done');
    assert.equal(d.result, 'Bo: de map is opgeruimd.');
    assert.ok(d.delivered, 'nothing keeps waiting for a giver that is gone');
    assert.equal(followUps().length, 5, 'an archived bot is not woken');
    assert.ok(!resultNotes(t, th.id).some((x) => /de map is opgeruimd/.test(x.content)));
  } finally {
    await t.close();
  }
});

test('a restart while the giver waited inside its turn: the work goes on, and its outcome comes back as a note and a turn', async () => {
  const t = await startTestApp();
  let r2: Awaited<ReturnType<typeof reopen>> | null = null;
  const startDelay = RoomService.START_DELAY_MS;
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    await m.bot('Bo');
    m.script('Ada', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Bo', task: 'Herstel de leadroute.', expected_output: 'bewijs', wait: true, wait_seconds: 600 } }] });
    m.script('Bo', { text: 'nooit', delayMs: 60_000 });
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Laat Bo de leadroute herstellen.' });
    const d = await until(() => deleg(t).find((x) => x.status === 'running'));
    assert.equal(d.wait, true);
    assert.equal(d.follow_up, true, 'what was asked for does not change: the outcome always comes back');
    await t.app.close();

    RoomService.START_DELAY_MS = 50;
    r2 = await reopen(t, new Map<string, BotStep[]>([['Bo', [{ text: 'Bo: leadroute hersteld.' }]], ['Ada', [{ text: 'Leadroute van Bo verwerkt.' }]]]));
    await until(() => deleg(r2!).every((x) => x.status === 'done' && x.delivered), 15_000);
    await settle(r2);
    const after = deleg(r2)[0];
    assert.equal(after.wait, true, 'the record was not rewritten for the restart');
    assert.match(resultNotes(r2, th.id).at(-1)!.content, /Resultaat van de gedelegeerde taak van Bo \((?:klaar|te controleren)\)[\s\S]*leadroute hersteld/);
    const fu = r2.app.ctx.store.all<any>("SELECT status FROM runs WHERE thread_id = ? AND trigger = 'team:followup'", th.id);
    assert.deepEqual(fu.map((x) => x.status), ['done'], 'the giver was woken once, with the result');
  } finally {
    RoomService.START_DELAY_MS = startDelay;
    if (r2) await r2.close();
    else await t.close();
  }
});

// ---------------------------------------------------------------- every kind of engine

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(here, 'fixtures', `cli-agents-fake-${name}.mjs`);

test('the receiver on every kind of engine brings its outcome back the same way: Claude Code, Codex, an ACP agent, a CLI loop, a model over an API and a local model', async () => {
  const t = await startTestApp();
  const local = await startFakeOllama();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const on = async (name: string, kind: string, config: any) => {
      const p = await t.api('POST', '/providers', { kind, config });
      return t.api('POST', '/agents', { name, provider_id: p.id, model: '', access_mode: 'auto' });
    };
    await on('Cleo', 'claude-code', { path: fixture('claude') });
    await on('Dex', 'codex-cli', { path: fixture('codex') });
    await on('Ace', 'acp-custom', { command: fixture('acp'), args: [] });
    await m.cliBot('Kit');
    await m.bot('Bo');
    // A local model (Ollama): the scripted server answers every request with the same text.
    local.chat.push(...Array(6).fill('Lo: hallo.'));
    const lp = await t.api('POST', '/providers', { kind: 'ollama', base_url: local.url + '/v1' });
    await t.api('POST', '/agents', { name: 'Lo', provider_id: lp.id, model: 'qwen-test:latest', access_mode: 'auto' });
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    const give = (bot: string, task: string) => ({ name: 'delegate_task', args: { bot, task, expected_output: 'een antwoord' } });
    const note = (bot: string) => resultNotes(t, th.id).filter((x) => x.content.includes(`van ${bot} `)).at(-1)?.content || '';

    // 1. Each of them finishes its turn: the answer of that turn is the result, and the giver is woken with it.
    m.script('Ada', { toolCalls: ['Cleo', 'Dex', 'Ace', 'Kit', 'Bo', 'Lo'].map((b) => give(b, 'Zeg hallo.')) }, { text: 'Uitgezet bij zes collega’s.' });
    m.script('Kit', { parts: ['Ik kijk even.', { kind: 'tool', title: 'Bestand lezen' }, 'Kit: hallo.'] });
    m.script('Bo', { text: 'Bo: hallo.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Laat iedereen hallo zeggen.' });
    await until(() => deleg(t).length === 6 && deleg(t).every((x) => x.status !== 'queued' && x.status !== 'running' && x.delivered), 60_000);
    await settle(t, 30_000);
    const by = (name: string) => deleg(t).filter((x) => t.app.ctx.store.agent(x.to_agent_id)!.name === name).at(-1)!;
    for (const [bot, text] of [['Cleo', 'Hallo van Claude'], ['Dex', 'Hallo van Codex'], ['Ace', 'Hoi van ACP'], ['Kit', 'Kit: hallo.'], ['Bo', 'Bo: hallo.'], ['Lo', 'Lo: hallo.']] as const) {
      assert.equal(by(bot).status, 'done', `${bot}: ${by(bot).error}`);
      assert.equal(by(bot).result, text, bot);
      assert.match(note(bot), new RegExp(`Resultaat van de gedelegeerde taak van ${bot} \\((?:klaar|te controleren)\\)`), bot);
    }
    assert.ok(runsOf(t, th.id, ada.id).some((x) => x.trigger === 'team:followup' && x.status === 'done'), 'the giver was woken');

    // 2. "Alles stoppen" while they work: the same note for every engine, and nothing starts.
    m.script('Ada', { toolCalls: [give('Cleo', 'SCENARIO:silent'), give('Ace', 'SCENARIO:hang'), give('Kit', 'Lange klus.'), give('Bo', 'Lange klus.')] }, { text: 'Uitgezet.' });
    m.script('Kit', { text: 'nooit', delayMs: 60_000 });
    m.script('Bo', { text: 'nooit', delayMs: 60_000 });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Lange klussen.' });
    await until(() => deleg(t).filter((x) => x.status === 'running').length === 4, 30_000);
    await t.waitIdle(th.id);
    const n = allRuns(t).length;
    assert.equal((await t.api('POST', '/stop-all', {})).stopped, 4);
    await settle(t, 30_000);
    await quiet(t);
    assert.equal(allRuns(t).length, n, 'nothing started because of the stop');
    const stopped = deleg(t).slice(-4);
    assert.ok(stopped.every((x) => stoppedByOwner(x) && x.delivered), stopped.map((x) => `${x.status}: ${x.error}`).join(' | '));
    const sn = stopNotes(t, th.id).slice(-4).map((x) => x.content);
    for (const bot of ['Cleo', 'Ace', 'Kit', 'Bo']) assert.ok(sn.some((x) => x.startsWith(`Gestopt door de eigenaar: het werk dat je aan ${bot} gaf (`) && x.endsWith(`Het is niet af en blijft van ${bot}. Opnieuw geven kan met delegate_task.`)), bot);
  } finally {
    await local.close();
    await t.close();
  }
});

test('a turn that fails on a CLI engine comes back with the reason: the program crashes, the subscription is at its limit, the CLI loop reports an error', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const p = await t.api('POST', '/providers', { kind: 'claude-code', config: { path: fixture('claude') } });
    await t.api('POST', '/agents', { name: 'Cleo', provider_id: p.id, model: '', access_mode: 'auto' });
    await m.cliBot('Kit');
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    const followUps = () => runsOf(t, th.id, ada.id).filter((x) => x.trigger === 'team:followup');
    let n = 0;
    for (const [bot, task, reason] of [
      ['Cleo', 'SCENARIO:crash', /Claude Code stopte onverwacht/],
      ['Cleo', 'SCENARIO:limithit', /Gebruikslimiet van je Claude-abonnement of account bereikt/],
      ['Kit', 'Doe iets.', /het programma gaf een fout/],
    ] as const) {
      m.script('Ada', { toolCalls: [{ name: 'delegate_task', args: { bot, task, expected_output: 'een antwoord' } }] }, { text: 'Uitgezet.' });
      if (bot === 'Kit') m.script('Kit', { error: 'het programma gaf een fout' });
      await t.api('POST', `/threads/${th.id}/messages`, { content: 'Geef het door.' });
      await until(() => deleg(t).length === n + 1 && deleg(t).every((x) => x.delivered), 30_000);
      await settle(t, 30_000);
      const d = deleg(t).at(-1)!;
      assert.equal(d.status, 'error', `${bot} ${task}`);
      assert.match(d.error, reason);
      assert.match(resultNotes(t, th.id).at(-1)!.content, new RegExp(`Resultaat van de gedelegeerde taak van ${bot} \\(fout\\)[\\s\\S]*Niet gelukt: `));
      assert.equal(followUps().length, ++n, 'the giver is woken with the reason');
    }
  } finally {
    await t.close();
  }
});

/** A minimal MCP stdio client for TeamBot's bridge: what Claude Code, Codex or an ACP agent does to use a TeamBot tool. */
function bridgeClient(srv: StdioServer) {
  const child = spawn(srv.command, srv.args, { env: { ...process.env, ...srv.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map<number, (m: any) => void>();
  readline.createInterface({ input: child.stdout! }).on('line', (l) => {
    const msg = JSON.parse(l);
    pending.get(msg.id)?.(msg);
  });
  let id = 0;
  const req = (method: string, params: any = {}) =>
    new Promise<any>((resolve) => {
      pending.set(++id, resolve);
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  return { req, call: (name: string, args: any) => req('tools/call', { name, arguments: args }), close: () => void child.kill() };
}

test('the giver on every CLI engine (Claude Code, Codex, ACP): its call over the bridge is one record, and after "Alles stoppen" its next turn says what was given to whom', async () => {
  const t = await startTestApp();
  const bridge = new PermissionBridge(t.dir);
  const clients: ReturnType<typeof bridgeClient>[] = [];
  try {
    const m = await team(t);
    const ctx = t.app.ctx;
    const store = ctx.store;
    await m.bot('Bo');
    await bridge.ensure();
    for (const engine of ['claude', 'codex', 'acp'] as const) {
      // A turn of the giver as a CLI engine runs it: its TeamBot tools are on the bridge, and the CLI calls them there.
      const giver = await m.cliBot(`Gever-${engine}`);
      const th = await t.api('POST', '/threads', { agentId: giver.id });
      const input = store.createMessage({ thread_id: th.id, role: 'user', author_type: 'user', author_id: giver.user_id, author_name: 'Ik', content: 'Laat Bo het uitzoeken.' } as any);
      const run = store.createRun({ thread_id: th.id, agent_id: giver.id, user_id: giver.user_id, status: 'running', trigger: 'user', input_message_id: input.id, meta: {} });
      const ac = new AbortController();
      const scope = makeScope(ctx, ctx.providers.config(m.cliProviderId)!, { model: '', system: '', prompt: input.content, attachments: [], workspace: giver.workspace, accessMode: giver.access_mode, agentId: giver.id, threadId: th.id, runId: run.id, userId: giver.user_id }, ac.signal, () => {});
      const reg = bridge.register({ tools: teambotTools(scope, { engine, hold: () => {} }) }, path.join(t.dir, 'cli-agents', 'runs', run.id));
      const c = bridgeClient(bridge.stdioServer(reg, { tools: true }));
      clients.push(c);
      await c.req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
      const listed = ((await c.req('tools/list')).result.tools as any[]).map((x) => x.name);
      for (const name of ['delegate_task', 'ask_bot']) assert.ok(listed.includes(name), `${engine}: ${name} is listed`);

      // The CLI gives work and waits for it inside its turn; the colleague is working when the owner stops everything.
      m.script('Bo', { text: 'nooit', delayMs: 60_000 });
      const task = `Zoek het uit voor ${engine}.`;
      const call = c.call('delegate_task', { bot: 'Bo', task, expected_output: 'de oorzaak', wait: true, wait_seconds: 600 });
      const d = await until(() => deleg(t).find((x) => x.task === task && x.status === 'running'));
      assert.equal(d.parent_run_id, run.id, engine);
      assert.equal(d.from_agent_id, giver.id, engine);
      const n = allRuns(t).length;
      // (What the run queue does for a turn it runs: stop it with the owner's reason, then write the turn down as stopped.)
      ac.abort(new Error('Alles gestopt'));
      assert.equal(ctx.runs.stopAll(giver.user_id), 1, 'the colleague');
      ctx.events.emit(giver.user_id, 'run.updated', store.updateRun(run.id, { status: 'cancelled', error: 'Alles gestopt', finished_at: new Date().toISOString() }));
      const out = await call;
      assert.equal(out.result.isError, true, engine);
      assert.match(out.result.content[0].text, /^Gestopt door de eigenaar terwijl je op Bo wachtte\. Het werk was al aan Bo gegeven/, engine);
      await quiet(t);
      assert.equal(allRuns(t).length, n, `${engine}: nothing started because of the stop`);
      const fin = deleg(t).find((x) => x.id === d.id)!;
      assert.ok(stoppedByOwner(fin) && fin.delivered, `${engine}: ${fin.status} ${fin.error}`);
      assert.equal(stopNotes(t, th.id).length, 1, engine);
      assert.equal(stopNotes(t, th.id)[0].content, `Gestopt door de eigenaar: het werk dat je aan Bo gaf (“${task}”). Het doorgeven was gelukt voordat de eigenaar ook jouw beurt stopte. Het is niet af en blijft van Bo. Opnieuw geven kan met delegate_task.`);

      // The next turn of that CLI: its session never saw the outcome of the call; the prompt it gets says it.
      const next = store.createMessage({ thread_id: th.id, role: 'user', author_type: 'user', author_id: giver.user_id, author_name: 'Ik', content: 'Had je het doorgegeven?' } as any);
      const probe = store.createRun({ thread_id: th.id, agent_id: giver.id, user_id: giver.user_id, trigger: 'user', input_message_id: next.id, meta: {} });
      const prompt = stoppedTaskNote(ctx, { threadId: th.id, agentId: giver.id, runId: probe.id }) + cliPrompt(ctx, store.agent(giver.id)!, store.thread(th.id)!, next);
      store.exec('DELETE FROM runs WHERE id = ?', probe.id);
      assert.match(prompt, /^\[TeamBot\] De eigenaar heeft je vorige taak gestopt\.[^\n]* Wat je in die beurt al aan een collega had gegeven, is aangekomen en met jouw beurt gestopt/, engine);
      assert.match(prompt, /\[TeamBot\]: Gestopt door de eigenaar: het werk dat je aan Bo gaf \(“Zoek het uit voor \w+\.”\)\. Het doorgeven was gelukt/, engine);
      assert.match(prompt, /Had je het doorgegeven\?$/, engine);
      // A call that still arrives after the stop gives nothing away.
      const late = await c.call('delegate_task', { bot: 'Bo', task: 'Te laat.', expected_output: 'niets' });
      assert.equal(late.result.isError, true, engine);
      assert.ok(!deleg(t).some((x) => x.task === 'Te laat.'), `${engine}: nothing is given after the stop`);
      reg.dispose();
    }
  } finally {
    for (const c of clients) c.close();
    bridge.stop();
    await t.close();
  }
});
