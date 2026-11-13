import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppHandle } from '../server/app.js';
import { stoppedByOwner } from '../server/agent/runs.js';
import { RoomService } from '../server/modules/rooms/service.js';
import { modules as allModules } from '../server/modules/index.js';
import { createRoutinesModule } from '../server/modules/routines/index.js';
import { startTestApp, type TestApp } from './helpers.js';
import { msgs, reopen, runsOf, settle, sleep, team, until, type BotStep } from './team-mock.js';

/**
 * A stop by the owner starts nothing (live, 12 nov: after "Alles stoppen" TeamBot woke the main bot twice with "niet
 * gelukt: Alles gestopt"; it took the stopped task away from its colleague and marked it blocked, while the task itself
 * stayed on "Bezig" with nobody working). The rule, the same for "Alles stoppen" and for stopping one bot:
 *  - nothing starts by itself because of the stop: no follow-up turn, no next bot message, no pick-up by the work loop,
 *    no check-in, and after a restart no resumed subtask and nothing reported as stuck;
 *  - the outcome is not lost: the bot that gave the work finds a note and reads it at its next turn;
 *  - the task is "Te doen" again and still its owner's, so starting it again is one step.
 * A real outcome (done, an error, a time-out) still wakes the bot that asked: tests/teamwork.test.ts.
 */

// An explicit main bot where the test needs one; the first bot is not made main by itself.
process.env.TEAMBOT_TEST_NO_AUTO_MAIN = '1';

type App = { app: AppHandle };
const deleg = (t: App) => t.app.ctx.store.all<any>('SELECT * FROM room_delegations ORDER BY created_at, rowid').map((r: any) => t.app.ctx.store.decode<any>('room_delegations', r));
const allRuns = (t: App) => t.app.ctx.store.all<any>('SELECT * FROM runs ORDER BY created_at, rowid');
const ownerId = (t: App) => t.app.ctx.auth.owner()!.id;
const notesOf = (t: App, threadId: string, kind: string) => t.app.ctx.store.messages(threadId, { limit: 1000 }).filter((x) => x.role === 'system' && x.parts.kind === kind);
const stopNotes = (t: App, threadId: string) => notesOf(t, threadId, 'delegation_cancelled');
const resultNotes = (t: App, threadId: string) => notesOf(t, threadId, 'delegation_result');
const task = async (t: TestApp, id: string) => (await t.api('GET', '/rooms/tasks')).find((x: any) => x.id === id);
const toolOut = (t: TestApp, threadId: string) => msgs(t, threadId).filter((x) => x.role === 'tool').map((x) => x.content);

/** Nothing is running, and nothing starts in the moments after either. */
async function quiet(t: App) {
  await settle(t);
  await sleep(300);
  await settle(t);
}

test('"Alles stoppen": no turn starts afterwards, the task is "Te doen" again and still the colleague\'s, the main bot hears it at its next turn', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    await t.api('PUT', `/teams/main/${ada.id}`);
    const bo = await m.bot('Bo');
    const cy = await m.bot('Cy');
    const store = t.app.ctx.store;
    const boardTask = () => store.one<any>("SELECT id FROM room_tasks WHERE title = 'Planning bijwerken'");

    // The main bot hands out two pieces of work and ends its turn; both colleagues are working.
    m.script(
      'Ada',
      { toolCalls: [{ name: 'delegate_task', args: { bot: 'Bo', task: 'Zoek uit waarom het formulier niet werkt.', expected_output: 'Klaar als: de oorzaak met bewijs' } }, { name: 'task_create', args: { title: 'Planning bijwerken', owner: 'Cy', done_when: 'De planning staat in planning.md' } }] },
      { text: 'Uitgezet bij Bo en Cy.' },
    );
    m.script('Bo', { text: 'nooit', delayMs: 30_000 });
    m.script(
      'Cy',
      {
        get toolCalls() {
          return [{ name: 'task_claim', args: { id: boardTask().id } }];
        },
      },
      { text: 'nooit', delayMs: 30_000 },
    );
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Zet het team aan het werk.' });
    await t.waitIdle(th.id);
    await until(() => deleg(t).length === 2 && deleg(t).every((d) => d.status === 'running'));
    const id = boardTask().id;
    await until(async () => (await task(t, id)).quality.claim?.agentId === cy.id);
    let tk = await task(t, id);
    assert.equal(tk.statusLabel, 'Bezig');
    assert.equal(allRuns(t).length, 3, 'Ada, Bo and Cy');

    // The owner presses "Alles stoppen".
    const r = await t.api('POST', '/stop-all', {});
    assert.equal(r.stopped, 2);
    await quiet(t);

    // 1. Nothing started because of it.
    const runs = allRuns(t);
    assert.equal(runs.length, 3, `no new run after the stop (${runs.map((x) => x.trigger).join(', ')})`);
    assert.ok(!runs.some((x) => x.trigger === 'team:followup'), 'no follow-up turn');
    assert.equal(runsOf(t, th.id).length, 1, 'the main bot was not woken');
    assert.ok(runs.filter((x) => x.agent_id !== ada.id).every((x) => x.status === 'cancelled' && x.error === 'Alles gestopt'));
    const ds = deleg(t);
    assert.ok(ds.every((d) => d.status === 'cancelled' && d.error === 'Alles gestopt' && d.delivered), 'both outcomes are told, nothing still waits');

    // 2. The task is shown as it is: nobody works on it, and it is still Cy's.
    tk = await task(t, id);
    assert.equal(tk.status, 'todo');
    assert.equal(tk.statusLabel, 'Te doen');
    assert.equal(tk.ownerName, 'Cy');
    assert.equal(tk.quality.claim, null, 'no "Cy werkt eraan" any more');
    // Starting it again is one step for the owner: "Hervatten" is offered in Cy's own chat, where the task came in.
    const cyChat = t.app.ctx.chat.threadForAgent(ownerId(t), cy.id);
    assert.equal((await t.api('GET', `/threads/${cyChat.id}`)).resumeReason, 'stopped');

    // 3. The work loop does not pick the stopped task up either, also not when the owner has been away for a while.
    const { work, engine } = t.app.ctx.services.routines;
    const realNow = engine.now;
    engine.now = () => Date.now() + 6 * 60_000;
    work.enabled = true;
    try {
      assert.equal(await work.tick(), 0, 'no work turn for a bot the owner stopped');
      const view = (await work.views(ownerId(t))).find((v: any) => v.agentId === cy.id);
      assert.equal(view.items.length, 1, 'the task is still on its list');
      assert.equal(view.waits, 'je hebt deze bot gestopt');
    } finally {
      work.enabled = false;
      engine.now = realNow;
      await work.idle();
    }
    await quiet(t);
    assert.equal(allRuns(t).length, 3);

    // 4. The outcome is not lost: a note per piece in the main bot's conversation, in TeamBot's own words.
    const notes = stopNotes(t, th.id).map((n) => n.content);
    assert.equal(notes.length, 2);
    const nBo = notes.find((n) => n.includes('Bo'))!;
    const nCy = notes.find((n) => n.includes('Cy'))!;
    // Facts only (what, not finished, whose, how it is given again); what the bot does with them is not TeamBot's to say.
    assert.equal(nBo, 'Gestopt door de eigenaar: het werk dat je aan Bo gaf (“Zoek uit waarom het formulier niet werkt.”). Het is niet af en blijft van Bo. Opnieuw geven kan met delegate_task.');
    assert.equal(nCy, `Gestopt door de eigenaar: de taak “Planning bijwerken” die je aan Cy gaf. De taak is niet af, staat op Te doen en blijft van Cy. Opnieuw starten kan met task_update (id ${id}, owner Cy).`);
    assert.equal(resultNotes(t, th.id).length, 0, 'no "niet gelukt: Alles gestopt"');

    // 5. At its next turn, started by the owner, the main bot reads what was stopped.
    let seen = '';
    m.script('Ada', { text: 'Bo en Cy zijn door jou gestopt; hun werk ligt klaar om opnieuw te starten.', check: (req) => (seen = JSON.stringify(req.messages)) });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Wat is de stand?' });
    await quiet(t);
    assert.match(seen, /\[Systeem\]: Gestopt door de eigenaar: het werk dat je aan Bo gaf/);
    assert.match(seen, /\[Systeem\]: Gestopt door de eigenaar: de taak “Planning bijwerken” die je aan Cy gaf\. De taak is niet af, staat op Te doen en blijft van Cy/);
    assert.equal(allRuns(t).length, 4, 'only the turn the owner asked for');

    // 6. Starting again is one step: the main bot gives the task to Cy again, Cy starts, and that outcome wakes it.
    m.script('Ada', { toolCalls: [{ name: 'task_update', args: { id, owner: 'Cy' } }] }, { text: 'Cy gaat verder.' }, { text: 'Cy heeft geantwoord.' });
    m.script('Cy', { text: 'Cy: de planning staat in planning.md.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Laat Cy verdergaan met de planning.' });
    await quiet(t);
    assert.match(toolOut(t, th.id).at(-1)!, /Bijgewerkt[\s\S]*eigenaar: Cy[\s\S]*Cy begint aan deze taak/);
    const again = deleg(t).at(-1)!;
    assert.equal(again.task_id, id);
    assert.equal(again.status, 'done');
    assert.match(resultNotes(t, th.id).at(-1)!.content, /Cy meldt over de taak die je gaf:[\s\S]*de planning staat in planning\.md/);
    assert.equal(allRuns(t).filter((x) => x.trigger === 'team:followup').length, 1, 'a real outcome still wakes the bot that gave the work');
  } finally {
    await t.close();
  }
});

test('stopping one bot follows the same rule; "Hervatten" in its conversation finishes the work and the result goes back', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const bo = await m.bot('Bo');
    const th = await t.api('POST', '/threads', { agentId: ada.id });

    // 1. The owner stops the colleague in its own subtask conversation.
    m.script('Ada', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Bo', task: 'Schrijf het verslag van het overleg.', expected_output: 'verslag.md' } }] }, { text: 'Uitgezet bij Bo.' });
    m.script('Bo', { text: 'nooit', delayMs: 30_000 });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Laat Bo het verslag schrijven.' });
    const d = await until(() => deleg(t).find((x) => x.status === 'running'));
    await t.waitIdle(th.id);
    assert.equal((await t.api('POST', `/threads/${d.thread_id}/stop`, {})).stopped, 1);
    await quiet(t);
    assert.equal(deleg(t)[0].status, 'cancelled');
    assert.equal(deleg(t)[0].error, 'Gestopt door gebruiker');
    assert.equal(runsOf(t, th.id).length, 1, 'Ada was not woken');
    assert.match(stopNotes(t, th.id)[0].content, /^Gestopt door de eigenaar: het werk dat je aan Bo gaf \(“Schrijf het verslag van het overleg\.”\)/);
    assert.equal(resultNotes(t, th.id).length, 0);

    // A bot on a CLI engine keeps its own session: it gets the note with the prompt of its next turn.
    await t.api('PATCH', `/agents/${ada.id}`, { provider_id: m.cliProviderId, model: 'cli-1' });
    m.script('Ada', { text: 'Bo is door jou gestopt; het verslag ligt nog bij hem.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Hoe staat het ervoor?' });
    await quiet(t);
    assert.match(m.cliCalls.at(-1)!.req.prompt, /Nieuwe berichten in het gesprek sinds je laatste antwoord:\n\[TeamBot\]: Gestopt door de eigenaar: het werk dat je aan Bo gaf \(“Schrijf het verslag van het overleg\.”\)\. Het is niet af en blijft van Bo\./);
    assert.equal(runsOf(t, th.id).length, 2, 'the owner started that turn, nothing else did');
    await t.api('PATCH', `/agents/${ada.id}`, { provider_id: m.apiProviderId, model: 'mock-1' });

    // 2. One step for the owner: "Hervatten" in Bo's conversation. Bo finishes, and that result wakes Ada as always.
    const view = await t.api('GET', `/threads/${d.thread_id}`);
    assert.equal(view.resumeReason, 'stopped');
    m.script('Bo', { text: 'Bo: verslag.md is geschreven.' });
    m.script('Ada', { text: 'Het verslag van Bo is binnen.' });
    await t.api('POST', `/threads/${d.thread_id}/resume`, {});
    await quiet(t);
    const fin = deleg(t)[0];
    assert.equal(fin.status, 'done');
    assert.equal(fin.result, 'Bo: verslag.md is geschreven.');
    // (It is a delegated result like any other, so it gets the second look too; the verdict is not what this test is about.)
    assert.match(resultNotes(t, th.id).at(-1)!.content, /Resultaat van de gedelegeerde taak van Bo \((?:klaar|te controleren)\)[\s\S]*verslag\.md is geschreven/);
    assert.equal(runsOf(t, th.id).filter((x) => x.trigger === 'team:followup').length, 1);

    // 3. The owner stops the bot that gave the work while its turn is still going: what it started in that turn stops
    //    with it, nobody is woken, and it finds the notes at its next turn.
    m.script('Ada', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Bo', task: 'Maak de actielijst.', expected_output: 'actielijst.md' } }] }, { text: 'nog bezig', delayMs: 30_000 });
    m.script('Bo', { text: 'nooit', delayMs: 30_000 });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Laat Bo de actielijst maken.' });
    await until(() => deleg(t).find((x) => x.task === 'Maak de actielijst.' && x.status === 'running'));
    const before = allRuns(t).length;
    await t.api('POST', `/threads/${th.id}/stop`, {});
    await quiet(t);
    assert.equal(allRuns(t).length, before, 'nothing started after the stop');
    const d3 = deleg(t).find((x) => x.task === 'Maak de actielijst.')!;
    assert.equal(d3.status, 'cancelled');
    assert.ok(stoppedByOwner(d3), d3.error);
    assert.ok(d3.delivered);
    assert.match(stopNotes(t, th.id).at(-1)!.content, /het werk dat je aan Bo gaf \(“Maak de actielijst\.”\)/);
    assert.equal(runsOf(t, d3.thread_id, bo.id).at(-1)!.status, 'cancelled');
  } finally {
    await t.close();
  }
});

test('"Alles stoppen" in a chain and with work in the queue: the stop goes up the chain, a waiting bot message never starts, a finished result waits', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const bo = await m.bot('Bo');
    const cy = await m.bot('Cy');
    const dex = await m.bot('Dex');
    const th = await t.api('POST', '/threads', { agentId: ada.id });

    // 1. Ada → Bo → Cy. Bo ended its turn and waits for Cy; only Cy is working when the owner stops everything.
    m.script('Ada', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Bo', task: 'Lever het kwartaalrapport op.', expected_output: 'rapport.md' } }] }, { text: 'Uitgezet bij Bo.' });
    m.script('Bo', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Cy', task: 'Reken de cijfers door.', expected_output: 'cijfers.md' } }] }, { text: 'Cy rekent; ik wacht.' });
    m.script('Cy', { text: 'nooit', delayMs: 30_000 });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Laat het kwartaalrapport maken.' });
    const dCy = await until(() => deleg(t).find((x) => x.to_agent_id === cy.id && x.status === 'running'));
    await until(() => !t.app.ctx.store.all("SELECT id FROM runs WHERE agent_id != ? AND status IN ('queued','running','waiting')", cy.id).length);
    const before = allRuns(t).length;
    assert.equal((await t.api('POST', '/stop-all', {})).stopped, 1);
    await quiet(t);
    assert.equal(allRuns(t).length, before, 'no follow-up turn for Bo or Ada');
    const [dBo, dCy2] = [deleg(t).find((x) => x.to_agent_id === bo.id)!, deleg(t).find((x) => x.id === dCy.id)!];
    assert.equal(dCy2.status, 'cancelled');
    assert.equal(dBo.status, 'cancelled', 'the subtask that waited only for the stopped work is stopped with it');
    assert.equal(dBo.error, 'Alles gestopt');
    assert.ok(deleg(t).every((x) => x.delivered), 'nothing is left waiting');
    assert.match(stopNotes(t, dBo.thread_id)[0].content, /het werk dat je aan Cy gaf \(“Reken de cijfers door\.”\)/);
    assert.match(stopNotes(t, th.id)[0].content, /het werk dat je aan Bo gaf \(“Lever het kwartaalrapport op\.”\)/);

    // 2. Dex is busy for the owner. Ada, still in her turn, has Bo's finished answer waiting and a message for Dex in
    //    the queue. The owner stops everything.
    const dexChat = await t.api('POST', '/threads', { agentId: dex.id });
    m.script('Dex', { text: 'nooit', delayMs: 30_000 });
    await t.api('POST', `/threads/${dexChat.id}/messages`, { content: 'Doe iets langs.' });
    await until(() => runsOf(t, dexChat.id, dex.id).some((x) => x.status === 'running'));
    m.script('Ada', { toolCalls: [{ name: 'ask_bot', args: { bot: 'Bo', message: 'Hoeveel pagina’s heeft het rapport?' } }, { name: 'ask_bot', args: { bot: 'Dex', message: 'Zet de cijfers in een tabel.' } }] }, { text: 'nog bezig', delayMs: 30_000 });
    m.script('Bo', { text: 'Bo: het rapport heeft 12 pagina’s.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Vraag het Bo en Dex.' });
    const held = await until(() => deleg(t).find((x) => x.task.startsWith('Hoeveel') && x.status === 'done'));
    assert.equal(held.delivered, false, 'Ada is busy: the answer waits');
    const queued = deleg(t).find((x) => x.task.startsWith('Zet de cijfers'))!;
    assert.equal(queued.status, 'queued');
    assert.equal(queued.run_id, null, 'Dex is busy: the message waits');
    const n = allRuns(t).length;
    // (This time the way "Alle bots stoppen" in the system tray does it: the same stop, without the route.)
    assert.equal(t.app.ctx.runs.stopAll(ownerId(t)), 2);
    await quiet(t);
    assert.equal(allRuns(t).length, n, 'the stop frees Ada and Dex, and still nothing starts');
    const q2 = deleg(t).find((x) => x.id === queued.id)!;
    assert.equal(q2.status, 'cancelled');
    assert.equal(q2.error, 'Alles gestopt');
    assert.ok(!msgs(t, dexChat.id).some((x) => x.content.includes('Zet de cijfers')), 'never posted to Dex');
    assert.equal(stopNotes(t, th.id).at(-1)!.content, 'Gestopt door de eigenaar: je bericht aan Dex (“Zet de cijfers in een tabel.”). Er komt geen antwoord op. Opnieuw sturen kan.');
    assert.equal(deleg(t).find((x) => x.id === held.id)!.delivered, false, 'the finished answer still waits; it is not lost');

    // The owner writes again: Ada answers, and then gets the answer that was waiting, as always.
    m.script('Ada', { text: 'Ik was gestopt.' }, { text: 'Bo zegt: 12 pagina’s.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Ga maar verder.' });
    await quiet(t);
    assert.ok(deleg(t).every((x) => x.delivered));
    assert.match(resultNotes(t, th.id).at(-1)!.content, /Bo antwoordde op je bericht:[\s\S]*12 pagina’s/);
    assert.equal(msgs(t, th.id).filter((x) => x.role === 'assistant').at(-1)!.content, 'Bo zegt: 12 pagina’s.');

    // 3. A broadcast: Bo has answered, Cy is still working when the owner stops everything. His stop completes the
    //    broadcast, so nobody is woken; the note has Bo's answer and says Cy was stopped.
    m.script('Ada', { toolCalls: [{ name: 'broadcast', args: { bots: ['Bo', 'Cy'], message: 'Wat is jullie stand?' } }] }, { text: 'Gevraagd aan Bo en Cy.' });
    m.script('Bo', { text: 'Bo: het rapport is af.' });
    m.script('Cy', { text: 'nooit', delayMs: 30_000 });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Vraag iedereen naar de stand.' });
    await until(() => deleg(t).some((x) => x.kind === 'broadcast' && x.to_agent_id === bo.id && x.status === 'done') && deleg(t).some((x) => x.kind === 'broadcast' && x.to_agent_id === cy.id && x.status === 'running'));
    await t.waitIdle(th.id);
    const b = allRuns(t).length;
    assert.equal((await t.api('POST', '/stop-all', {})).stopped, 1);
    await quiet(t);
    assert.equal(allRuns(t).length, b, 'no follow-up turn for a broadcast the owner stopped');
    const bc = msgs(t, th.id).filter((x) => x.parts.kind === 'broadcast_result').at(-1)!.content;
    assert.equal(bc, 'Gestopt door de eigenaar: je broadcast, voordat iedereen klaar was.\n- Bo: klaar — Bo: het rapport is af.\n- Cy: gestopt door de eigenaar');
    assert.ok(deleg(t).every((x) => x.delivered));
  } finally {
    await t.close();
  }
});

test('a restart starts nothing the owner stopped: no resumed subtask, no follow-up, no waiting bot message, nothing reported as stuck', async () => {
  const t = await startTestApp();
  let r2: Awaited<ReturnType<typeof reopen>> | null = null;
  const startDelay = RoomService.START_DELAY_MS;
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    await t.api('PUT', `/teams/main/${ada.id}`);
    const bo = await m.bot('Bo');
    const cy = await m.bot('Cy');
    const dex = await m.bot('Dex');
    const store = t.app.ctx.store;

    // Dex is busy for the owner. Ada gives Bo a subtask, asks Cy something in Cy's own chat, and leaves a message for Dex.
    const dexChat = await t.api('POST', '/threads', { agentId: dex.id });
    m.script('Dex', { text: 'nooit', delayMs: 30_000 });
    await t.api('POST', `/threads/${dexChat.id}/messages`, { content: 'Doe iets langs.' });
    await until(() => runsOf(t, dexChat.id, dex.id).some((x) => x.status === 'running'));
    m.script(
      'Ada',
      { toolCalls: [{ name: 'delegate_task', args: { bot: 'Bo', task: 'Schrijf het verslag.', expected_output: 'verslag.md' } }, { name: 'ask_bot', args: { bot: 'Cy', message: 'Reken de cijfers door.' } }, { name: 'ask_bot', args: { bot: 'Dex', message: 'Zet de cijfers in een tabel.' } }] },
      { text: 'Uitgezet.' },
    );
    m.script('Bo', { text: 'nooit', delayMs: 30_000 });
    m.script('Cy', { text: 'nooit', delayMs: 30_000 });
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Zet het team aan het werk.' });
    await t.waitIdle(th.id);
    const dBo = await until(() => deleg(t).find((d) => d.to_agent_id === bo.id && d.status === 'running'));
    const dCy = await until(() => deleg(t).find((d) => d.to_agent_id === cy.id && d.status === 'running'));
    const dDex = deleg(t).find((d) => d.to_agent_id === dex.id)!;
    assert.equal(dDex.run_id, null, 'Dex is busy: the message waits');

    // The owner stops the three bots one by one, each in its own conversation.
    for (const threadId of [dexChat.id, dBo.thread_id, dCy.thread_id]) assert.equal((await t.api('POST', `/threads/${threadId}/stop`, {})).stopped, 1);
    await quiet(t);
    const before = allRuns(t).length;
    assert.equal(stopNotes(t, th.id).length, 2);
    assert.equal(deleg(t).find((d) => d.id === dDex.id)!.status, 'queued', 'the message for the stopped bot does not start because of the stop');
    assert.equal(store.run(dCy.run_id)!.meta.ownerStop, 'Gestopt door gebruiker', 'the stop was written down the moment the owner pressed it');

    // TeamBot is closed right after the stops, before everything was written down: Bo's subtask and Cy's question
    // still count as busy, and Cy's turn had not wound down yet (only the owner's stop was noted on it).
    for (const d of [dBo, dCy]) store.exec("UPDATE room_delegations SET status = 'running', delivered = 0, error = NULL, finished_at = NULL WHERE id = ?", d.id);
    store.exec("UPDATE runs SET status = 'running', error = NULL, finished_at = NULL WHERE id = ?", dCy.run_id);
    await t.app.close();

    RoomService.START_DELAY_MS = 50;
    r2 = await reopen(t, new Map<string, BotStep[]>());
    const s2 = r2.app.ctx.store;
    await until(() => deleg(r2!).filter((d) => d.id === dBo.id || d.id === dCy.id).every((d) => d.status === 'cancelled' && d.delivered), 15_000);
    await quiet(r2);
    assert.equal(allRuns(r2).length, before, `nothing started after the restart: ${allRuns(r2).slice(before).map((x) => x.trigger).join(', ')}`);
    // Cy's turn is the owner's stop, not an interruption that asks to be resumed.
    assert.equal(s2.run(dCy.run_id)!.status, 'cancelled');
    assert.equal(s2.run(dCy.run_id)!.error, 'Gestopt door gebruiker');
    assert.ok(!s2.messages(dCy.thread_id, { limit: 200 }).some((x) => /onderbroken door een herstart/.test(x.content)));
    // Bo's subtask is not started again, and Ada is told as before: a note, no turn.
    assert.ok(!s2.messages(dBo.thread_id, { limit: 200 }).some((x) => /TeamBot is opnieuw gestart/.test(x.content)));
    assert.equal(stopNotes(r2, th.id).length, 4, 'told once more, because the bookkeeping was rewound');
    assert.equal(resultNotes(r2, th.id).length, 0, 'no "niet gelukt"');
    assert.equal(r2.app.ctx.services.rooms.flushPending(), 0, 'nothing waits to be delivered with a turn');
    assert.equal(deleg(r2).find((d) => d.id === dDex.id)!.status, 'queued', 'the waiting message still waits');
    // The main bot's notifier of stuck work does not call what the owner stopped stuck.
    const stuck = r2.app.ctx.services.teams.stuck;
    stuck.clock = () => Date.now() + 10 * 60_000;
    assert.deepEqual(stuck.tick(), []);
    assert.equal(allRuns(r2).length, before);

    // Nothing is lost: the owner writes to Dex again; Dex answers him and then takes the message that waited.
    const res = await fetch(`${r2.app.url}/api/threads/${dexChat.id}/messages`, { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Ga maar verder.' }) });
    assert.equal(res.status, 200);
    await until(() => deleg(r2!).find((d) => d.id === dDex.id)?.status === 'done', 10_000);
    await quiet(r2);
    assert.match(resultNotes(r2, th.id).at(-1)!.content, /Dex antwoordde op je bericht/);
    assert.ok(deleg(r2).every((d) => d.delivered));
  } finally {
    RoomService.START_DELAY_MS = startDelay;
    if (r2) await r2.close();
    else await t.close();
  }
});

test('the main bot does not come to the owner by itself right after he stopped it; at its next hour it does', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    await t.api('PUT', `/teams/main/${ada.id}`);
    const userId = ownerId(t);
    const store = t.app.ctx.store;
    store.setSetting(userId, 'timezone', 'UTC');
    // The owner has the check-in on (a fresh install has it off: tests/planner.test.ts).
    await t.api('PUT', '/proactive/checkin', { enabled: true });
    const HOUR = 3600_000;
    const DAY = 24 * HOUR;
    // A Monday to Wednesday at 09:05 (the check-in is at 09:00), at least two days from now.
    let day = Math.floor((Date.now() + 2 * DAY) / DAY) * DAY;
    while (![1, 2, 3].includes(new Date(day).getUTCDay())) day += DAY;
    const clock = { now: day + 9 * HOUR + 5 * 60_000 };
    const checkin = t.app.ctx.services.teams.checkin;
    checkin.clock = () => clock.now;
    const iso = (ms: number) => new Date(ms).toISOString();

    // The owner stopped the main bot a minute ago.
    m.script('Ada', { text: 'nooit', delayMs: 30_000 });
    const th = t.app.ctx.chat.threadForAgent(userId, ada.id);
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Maak het weekoverzicht.' });
    await until(() => runsOf(t, th.id, ada.id).some((x) => x.status === 'running'));
    await t.api('POST', `/threads/${th.id}/stop`, {});
    await quiet(t);
    const stopped = runsOf(t, th.id, ada.id)[0];
    store.exec('UPDATE runs SET created_at = ?, started_at = ?, finished_at = ? WHERE id = ?', iso(clock.now - 120_000), iso(clock.now - 120_000), iso(clock.now - 60_000), stopped.id);
    assert.equal(t.app.ctx.runs.ownerStopped(ada.id), clock.now - 60_000);
    assert.equal(await checkin.consider(userId), null, 'his stop does not free the way for the check-in');
    await quiet(t);
    assert.equal(allRuns(t).length, 1);

    // The next working day at the same hour the check-in comes as always; with that turn the main bot is on again.
    clock.now += DAY;
    m.script('Ada', { text: 'Goedemorgen. Gisteren heb je mij gestopt; er is sindsdien niets veranderd.' });
    const start = await checkin.consider(userId);
    assert.equal(start?.reason, 'morning', 'the check-in of the next day starts');
    await start!.done;
    await quiet(t);
    assert.deepEqual(allRuns(t).map((x) => [x.trigger, x.status]).sort(), [['checkin', 'done'], ['user', 'cancelled']]);
  } finally {
    await t.close();
  }
});

test('"Alles stoppen" also stops a workflow between its steps and drops a retry that was planned', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const bo = await m.bot('Bo');
    const cy = await m.bot('Cy');
    const store = t.app.ctx.store;
    // A workflow of two steps; Bo is busy with the first.
    const wf = await t.api('POST', '/workflows', {
      name: 'Verslag',
      steps: [
        { id: 'schrijf', kind: 'bot', title: 'Schrijven', agentId: bo.id, prompt: 'Schrijf het verslag.' },
        { id: 'lees', kind: 'bot', title: 'Nalezen', agentId: cy.id, prompt: 'Lees na: {{vorige}}' },
      ],
    });
    m.script('Bo', { text: 'nooit', delayMs: 30_000 });
    const run = await t.api('POST', `/workflows/${wf.id}/run`, {});
    await until(() => allRuns(t).some((x) => x.agent_id === bo.id && x.status === 'running'));
    // A message that hit its usage limit and would be answered again by itself after the reset.
    const eva = await t.agent({ name: 'Eva', settings: { onLimit: 'wait' } });
    const th = await t.api('POST', '/threads', { agentId: eva.id });
    t.script.push({ error: { message: 'Rate limit reached. Try again in 20 minutes.', status: 429 } });
    await t.say(th.id, 'Vat dit samen.');
    const failed = allRuns(t).find((x) => x.agent_id === eva.id)!;
    assert.ok(JSON.parse(failed.meta).limitRetryAt, 'a retry is planned');
    const n = allRuns(t).length;

    assert.equal((await t.api('POST', '/stop-all', {})).stopped, 1);
    await quiet(t);
    const wr = await t.api('GET', `/workflow-runs/${run.id}`);
    assert.equal(wr.status, 'stopped', 'stopped, not "liep vast"');
    assert.equal(wr.error, 'Gestopt door jou.');
    assert.equal(allRuns(t).find((x) => x.agent_id === bo.id)!.error, 'Alles gestopt');
    assert.ok(!allRuns(t).some((x) => x.agent_id === cy.id), 'the next step never started');
    assert.equal(store.run(failed.id)!.meta.limitRetried, true, 'the planned retry is dropped');
    assert.ok(msgs(t, th.id).some((x) => x.role === 'event' && /^Je hebt alles gestopt: er wordt niet meer vanzelf opnieuw geprobeerd\./.test(x.content)));
    // Also when its moment comes.
    t.script.push({ text: 'mag niet meer beantwoord worden' });
    t.app.ctx.services.runner.armRetry(failed.id, Date.now() + 10);
    await sleep(150);
    await quiet(t);
    assert.equal(allRuns(t).length, n, 'nothing started after the stop');
    assert.equal(t.script.length, 1, 'the retry never asked the model');
  } finally {
    await t.close();
  }
});

test('"Alles stoppen" and the planner: what it started stops, the work loop starts nothing afterwards (also not for a bot that was not busy), and what the owner planned himself keeps its time', async () => {
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  // A Monday on the planner's own clock, at least two days from now (every real timestamp is in the past on it).
  let day = Math.floor((Date.now() + 2 * DAY) / DAY) * DAY;
  while (new Date(day).getUTCDay() !== 1) day += DAY;
  const clock = { now: day + 5 * HOUR + 50 * MIN };
  const t = await startTestApp({ modules: allModules.map((m) => (m.id === 'routines' ? createRoutinesModule({ clock: () => clock.now, tickMs: 0 }) : m)) });
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    await t.api('PUT', `/teams/main/${ada.id}`);
    const bo = await m.bot('Bo');
    const cy = await m.bot('Cy');
    const dex = await m.bot('Dex');
    const ctx = t.app.ctx;
    const userId = ownerId(t);
    ctx.store.setSetting(userId, 'timezone', 'UTC');
    const { engine, work } = ctx.services.routines;
    work.enabled = true;
    const iso = (ms: number) => new Date(ms).toISOString();
    /** One look of the planner at this moment (everything with a time hangs on this one clock). */
    const look = async (ms: number) => {
      clock.now = ms;
      engine.tick();
      await sleep(80);
    };
    // (The automatic backup of the installation is in the list too; this is about the bots.)
    const planned = async () => ((await t.api('GET', '/routines/planned')).planned as any[]).filter((p) => p.kind !== 'backup').map((p) => [p.kind, p.agentId, p.at]);

    // The owner planned a routine for Cy (every hour, from 06:00) and gave Bo a task. At 06:00 the planner starts both.
    const routine = await t.api('POST', '/routines', { name: 'Elk uur de post', prompt: 'Kijk of er post is.', agent_id: cy.id, schedule: { kind: 'interval', everyMinutes: 60, anchor: iso(day + 6 * HOUR) } });
    // (The board gives a bot its new task at once, in a turn of its own; here each bot answers without finishing it,
    // so the task stays open and is work that lies there for the planner's work loop.)
    const told = (botId: string) => until(() => allRuns(t).some((x) => x.agent_id === botId && x.trigger === 'user' && x.status === 'done'));
    await t.api('POST', '/rooms/tasks', { title: 'Planning bijwerken', owner: 'Bo' });
    await told(bo.id);
    m.script('Bo', { text: 'nooit', delayMs: 30_000 });
    m.script('Cy', { text: 'nooit', delayMs: 30_000 });
    await look(day + 6 * HOUR);
    await until(() => allRuns(t).filter((x) => x.status === 'running').length === 2);
    assert.deepEqual(allRuns(t).filter((x) => x.status === 'running').map((x) => [x.trigger, x.agent_id]).sort(), [['routine', cy.id], ['work', bo.id]].sort(), 'both started by the planner');
    // A task for Dex comes in a moment before the stop: Dex is not busy at the stop and is never stopped itself.
    await t.api('POST', '/rooms/tasks', { title: 'Offerte nalopen', owner: 'Dex' });
    await told(dex.id);
    const n = allRuns(t).length;

    assert.equal((await t.api('POST', '/stop-all', {})).stopped, 2);
    await quiet(t);
    // Nothing starts: not at the look the new task asked for, not a minute later, not in the rest of the hour.
    for (const ms of [3_000, MIN, 2 * MIN, 30 * MIN, 59 * MIN]) {
      await look(day + 6 * HOUR + ms);
      await quiet(t);
    }
    assert.equal(allRuns(t).length, n, `nothing started after the stop: ${allRuns(t).slice(n).map((x) => x.trigger).join(', ')}`);
    assert.deepEqual(allRuns(t).filter((x) => x.status === 'cancelled').map((x) => [x.trigger, x.error]).sort(), [['routine', 'Alles gestopt'], ['work', 'Alles gestopt']]);
    assert.equal(ctx.store.one<any>('SELECT status FROM routine_runs WHERE routine_id = ?', routine.id).status, 'cancelled', 'the routine run is stopped, not retried');
    const views: any[] = await work.views(userId);
    assert.equal(views.find((v) => v.agentId === bo.id).waits, 'je hebt deze bot gestopt');
    assert.equal(views.find((v) => v.agentId === dex.id).waits, 'je hebt alles gestopt', 'also the bot that was not busy');
    // The one list says the same: no work will start by itself; the routine he planned himself keeps its time.
    assert.deepEqual(await planned(), [['routine', cy.id, iso(day + 7 * HOUR)]]);

    // 07:00: what he planned comes at its time. With that first turn after the stop the loop goes on for the bot
    // that was never stopped; the bot he stopped stays stopped until its own next turn.
    m.script('Cy', { text: 'Geen post.' });
    m.script('Dex', { text: 'De offerte klopt.' });
    await look(day + 7 * HOUR);
    await quiet(t);
    await look(day + 7 * HOUR + MIN);
    await quiet(t);
    assert.deepEqual(allRuns(t).slice(n).map((x) => [x.trigger, x.agent_id, x.status]).sort(), [['routine', cy.id, 'done'], ['work', dex.id, 'done']].sort());
    assert.equal((await work.views(userId)).find((v: any) => v.agentId === bo.id).waits, 'je hebt deze bot gestopt');

    // Bo goes on after its own next turn: the owner writes to it; its task is in the list again, with the time of its next try.
    m.script('Bo', { text: 'Ik ben er weer.' });
    const boChat = ctx.chat.threadForAgent(userId, bo.id);
    await t.api('POST', `/threads/${boChat.id}/messages`, { content: 'Ga maar weer verder.' });
    await quiet(t);
    const again = (await planned()).find((p) => p[0] === 'work' && p[1] === bo.id);
    assert.ok(again && again[2], 'the next try of Bo’s work is planned, with its time');
  } finally {
    await t.close();
  }
});

test('what counts as a stop by the owner: his own stop buttons, not a time-out, a limit or an interruption', () => {
  const stop = (error: string | null, status = 'cancelled') => stoppedByOwner({ status, error });
  for (const reason of ['Gestopt door gebruiker', 'Alles gestopt', 'Subtaak gestopt door Sam', 'Gestopt via Telegram', 'Noodstop (app)', 'Noodstop door gebruiker', 'Geannuleerd door gebruiker'])
    assert.equal(stop(reason), true, reason);
  // A stopped group (or a bot paused in it) has its own rule: it waits until the owner resumes it, and then goes on.
  for (const reason of ['Time-out: Bo gaf binnen 60 s geen resultaat', 'Onderbroken door nieuw bericht', 'Onderbroken om bij te sturen', 'Server gestopt', 'Bot verwijderd', 'Gesprek verwijderd', 'Groep gestopt: gestopt door Sam', 'Bo gepauzeerd door Sam', 'Groep gestopt: kostenplafond bereikt', 'Maximum van 3 stappen per beurt in deze groep bereikt', 'Gestopt: de opdrachtgever werd gestopt', 'Ingetrokken door Ada', null])
    assert.equal(stop(reason), false, String(reason));
  assert.equal(stop('Alles gestopt', 'error'), false);
  assert.equal(stoppedByOwner(null), false);
});
