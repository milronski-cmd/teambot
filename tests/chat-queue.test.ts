import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { startTestApp } from './helpers.js';
import { answers, msgs, runsOf, settle, sleep, team, until } from './team-mock.js';

/** Chat queue (edit/reorder/delete while the bot works) and steering of the running turn. */

const userTexts = (t: any, threadId: string) => msgs(t, threadId).filter((m) => m.role === 'user').map((m) => m.content);
const running = (t: any, threadId: string) => t.app.ctx.store.one("SELECT * FROM runs WHERE thread_id = ? AND status = 'running'", threadId);

test('queue: messages sent while the bot works wait outside the transcript; edit, reorder and delete; one turn each', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    m.script('Ada', { text: 'antwoord 1', delayMs: 300 }, { text: 'antwoord 2' }, { text: 'antwoord 3' });
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    const first = await t.api('POST', `/threads/${th.id}/queue`, { content: 'eerste' });
    assert.equal(first.mode, 'sent');
    await until(() => running(t, th.id));
    const r2 = await t.api('POST', `/threads/${th.id}/queue`, { content: 'twee' });
    const r3 = await t.api('POST', `/threads/${th.id}/queue`, { content: 'drie' });
    const r4 = await t.api('POST', `/threads/${th.id}/queue`, { content: 'vier' });
    assert.deepEqual([r2.mode, r3.mode, r4.mode], ['queued', 'queued', 'queued']);
    assert.equal(r4.queue.items.length, 3);
    assert.equal(r4.queue.busy, true);
    // Queued messages are not in the transcript yet, so the running turn never half-sees them.
    assert.deepEqual(userTexts(t, th.id), ['eerste']);
    await t.api('PATCH', `/threads/${th.id}/queue/${r3.item.id}`, { content: 'drie (bewerkt)' });
    await t.api('POST', `/threads/${th.id}/queue/${r4.item.id}/move`, { to: 0 });
    const v = await t.api('DELETE', `/threads/${th.id}/queue/${r2.item.id}`);
    assert.deepEqual(v.items.map((x: any) => x.content), ['vier', 'drie (bewerkt)']);
    await settle(t);
    assert.deepEqual(userTexts(t, th.id), ['eerste', 'vier', 'drie (bewerkt)']);
    assert.equal(runsOf(t, th.id).length, 3, 'one turn per message');
    // Every turn ended on its own message: nothing was answered twice.
    const reqs = m.calls.filter((c) => c.bot === 'Ada').map((c) => c.req.messages.at(-1)!.content);
    assert.deepEqual(reqs.map((x) => String(x).split('\n')[0]), ['eerste', 'vier', 'drie (bewerkt)']);
    assert.equal((await t.api('GET', `/threads/${th.id}/queue`)).items.length, 0);
  } finally {
    await t.close();
  }
});

test('steering an API turn: a model call still writing starts again with the message; during a tool at the next call; one turn', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    let toolRunning = false;
    t.app.ctx.tools.register({
      name: 'slow_scan',
      group: 'core',
      risk: 'read',
      description: 'test: a tool that takes a while',
      parameters: { type: 'object', properties: {} },
      async run() {
        toolRunning = true;
        await new Promise((r) => setTimeout(r, 300));
        toolRunning = false;
        return 'gescand';
      },
    });
    // 1) Steering while a tool of the step runs: the next model call sees the message after the tool result.
    m.script(
      'Ada',
      { toolCalls: [{ name: 'slow_scan', args: {} }] },
      {
        text: 'aangepast',
        check: (req) => {
          const s = JSON.stringify(req.messages);
          assert.match(s, /gebruik de map docs/);
          // Order: tool result first, then the steering message (tool pairing intact).
          const roles = req.messages.map((x) => x.role);
          assert.equal(roles.at(-1), 'user');
          assert.equal(roles.at(-2), 'tool');
        },
      },
    );
    await t.api('POST', `/threads/${th.id}/queue`, { content: 'maak een overzicht' });
    await until(() => toolRunning);
    const s1 = await t.api('POST', `/threads/${th.id}/steer`, { content: 'gebruik de map docs' });
    assert.equal(s1.mode, 'steered');
    await settle(t);
    assert.equal(runsOf(t, th.id).length, 1);
    assert.equal(answers(t, th.id).at(-1)!.content, 'aangepast');
    assert.equal(msgs(t, th.id).find((x) => x.content === 'gebruik de map docs')!.parts.steer.runId, runsOf(t, th.id)[0].id);
    assert.equal(msgs(t, th.id).filter((x) => x.role === 'tool').length, 1, 'the tool ran once');

    // 2) Steering while the model is still writing its answer (A-21): that model call stops and starts again with the
    //    message in it, in the same turn. Nothing written yet: the attempt disappears.
    const before = m.calls.length;
    m.script('Ada', { text: 'het lange eerste antwoord', delayMs: 4000 }, { text: 'met bijsturing', check: (req) => assert.match(String(req.messages.at(-1)!.content), /korter graag/) });
    const t0 = Date.now();
    await t.api('POST', `/threads/${th.id}/queue`, { content: 'schrijf een tekst' });
    await until(() => m.calls.length > before);
    await t.api('POST', `/threads/${th.id}/steer`, { content: 'korter graag' });
    await settle(t);
    assert.ok(Date.now() - t0 < 3000, 'the first model call was stopped, not waited for');
    assert.equal(runsOf(t, th.id).length, 2, 'one turn for the steered message');
    assert.equal(answers(t, th.id).at(-1)!.content, 'met bijsturing');
    assert.ok(!answers(t, th.id).some((x) => x.content === 'het lange eerste antwoord'), 'the first answer was never finished');
    const run2 = runsOf(t, th.id)[1];
    const attempt = t.app.ctx.store.all<any>("SELECT * FROM messages WHERE run_id = ? AND role = 'assistant' ORDER BY seq", run2.id);
    assert.equal(attempt.length, 2);
    assert.equal(attempt[0].deleted, 1, 'the empty attempt is gone');
    assert.equal(JSON.parse(attempt[0].parts).steered, true);
    // Order in the chat: question, steer message (marked), answer.
    const visible = msgs(t, th.id).filter((x) => !x.deleted && x.seq > attempt[0].seq - 2 && x.role !== 'event');
    assert.deepEqual(visible.map((x) => x.content), ['schrijf een tekst', 'korter graag', 'met bijsturing']);
    assert.equal(visible[1].parts.steer.runId, run2.id);

    // 3) Steering after a half answer: the half stays visible marked as interrupted, but the model does not get it as
    //    its own answer; no tool of that step ran.
    const before3 = m.calls.length;
    m.script(
      'Ada',
      { lead: 'De geschiedenis van de fiets begint', text: ' in 1817 met …', toolCalls: [{ name: 'slow_scan', args: {} }], delayMs: 4000 },
      {
        text: 'Kort: de fiets is uit 1817.',
        check: (req) => {
          const s = JSON.stringify(req.messages);
          assert.match(String(req.messages.at(-1)!.content), /alleen het jaartal/);
          assert.doesNotMatch(s, /De geschiedenis van de fiets begint/);
        },
      },
    );
    const tools3 = msgs(t, th.id).filter((x) => x.role === 'tool').length;
    await t.api('POST', `/threads/${th.id}/queue`, { content: 'vertel over de fiets' });
    await until(() => m.calls.length > before3 && msgs(t, th.id).some((x) => x.role === 'assistant' && x.status === 'streaming'));
    await sleep(120);
    // The bot's own rule "Bijsturen" (busy_policy steer) with a plain send does the same as the steer arrow.
    await t.api('PATCH', `/agents/${ada.id}`, { busy_policy: 'steer' });
    const s3a = await t.api('POST', `/threads/${th.id}/queue`, { content: 'alleen het jaartal' });
    assert.equal(s3a.mode, 'steered');
    await settle(t);
    const run3 = runsOf(t, th.id)[2];
    const own3 = t.app.ctx.store.messages(th.id, { limit: 1000 }).filter((x) => x.run_id === run3.id && x.role === 'assistant');
    assert.equal(own3[0].status, 'cancelled');
    assert.equal(own3[0].parts.steered, true);
    assert.match(own3[0].content, /De geschiedenis van de fiets begint/);
    assert.equal(own3[0].parts.toolCalls, undefined, 'the aborted step has no tool calls');
    assert.equal(msgs(t, th.id).filter((x) => x.role === 'tool').length, tools3, 'no tool ran for the aborted step');
    assert.equal(answers(t, th.id).at(-1)!.content, 'Kort: de fiets is uit 1817.');

    // 3) A message while the bot waits for an answer (ask_user) is the answer.
    m.script('Ada', { toolCalls: [{ name: 'ask_user', args: { question: 'Welke kleur?' } }] }, { text: 'Dan wordt het blauw.' });
    await t.api('POST', `/threads/${th.id}/queue`, { content: 'kies een kleur' });
    await until(() => t.app.ctx.store.one("SELECT id FROM runs WHERE thread_id = ? AND status = 'waiting'", th.id));
    const s3 = await t.api('POST', `/threads/${th.id}/queue`, { content: 'blauw', mode: 'steer' });
    assert.equal(s3.mode, 'answered');
    await settle(t);
    assert.match(msgs(t, th.id).filter((x) => x.role === 'tool').at(-1)!.content, /Antwoord van de gebruiker: blauw/);
    assert.equal(answers(t, th.id).at(-1)!.content, 'Dan wordt het blauw.');
  } finally {
    await t.close();
  }
});

test('steering a CLI turn: front of the queue, or interrupt (the session resumes); stop pauses the queue', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const cli = await m.cliBot('Cli');
    const th = await t.api('POST', '/threads', { agentId: cli.id });
    m.script('Cli', { text: 'lang werk', delayMs: 500 }, { text: 'na bijsturing' }, { text: 'later gedaan' });
    await t.api('POST', `/threads/${th.id}/queue`, { content: 'start' });
    await until(() => running(t, th.id));
    await t.api('POST', `/threads/${th.id}/queue`, { content: 'later' });
    const q = await t.api('GET', `/threads/${th.id}/queue`);
    assert.equal(q.engine, 'cli');
    assert.equal(q.canSteer, false);
    const s = await t.api('POST', `/threads/${th.id}/steer`, { content: 'stuur bij' });
    assert.equal(s.mode, 'queued');
    assert.match(s.reason, /Onderbreken/);
    assert.deepEqual(s.queue.items.map((x: any) => x.content), ['stuur bij', 'later']);
    // Interrupt: the turn stops and the message goes out now; the CLI session continues with its context.
    const i = await t.api('POST', `/threads/${th.id}/queue/${s.item.id}/steer`, { interrupt: true });
    assert.equal(i.mode, 'interrupted');
    await settle(t);
    const runs = runsOf(t, th.id);
    assert.deepEqual(runs.map((r: any) => r.status), ['cancelled', 'done', 'done']);
    assert.deepEqual(userTexts(t, th.id), ['start', 'stuur bij', 'later']);
    const second = m.cliCalls.filter((c) => c.bot === 'Cli')[1];
    assert.equal(second.req.sessionId, 'sess-Cli');
    assert.match(second.req.prompt, /stuur bij/);

    // Stop pauses the queue; nothing is sent until "Doorgaan".
    m.script('Cli', { text: 'weer lang', delayMs: 2000 }, { text: 'hervat' });
    await t.api('POST', `/threads/${th.id}/queue`, { content: 'nog een' });
    await until(() => running(t, th.id));
    await t.api('POST', `/threads/${th.id}/queue`, { content: 'wacht' });
    await t.api('POST', `/threads/${th.id}/stop`, {});
    await settle(t);
    const paused = await t.api('GET', `/threads/${th.id}/queue`);
    assert.equal(paused.paused, true);
    assert.match(paused.pausedReason, /Gestopt/);
    assert.ok(!userTexts(t, th.id).includes('wacht'));
    await t.api('POST', `/threads/${th.id}/queue/resume`, {});
    await settle(t);
    assert.equal(userTexts(t, th.id).at(-1), 'wacht');
    assert.equal(answers(t, th.id).at(-1)!.content, 'hervat');
    assert.equal((await t.api('GET', `/threads/${th.id}/queue`)).paused, false);
  } finally {
    await t.close();
  }
});

test('queue survives a restart paused (never sent blindly) and only works in 1-on-1 chats', async () => {
  const t = await startTestApp();
  let app2: Awaited<ReturnType<typeof createApp>> | null = null;
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    m.script('Ada', { text: 'traag', delayMs: 3000 });
    await t.api('POST', `/threads/${th.id}/queue`, { content: 'een' });
    await until(() => running(t, th.id));
    await t.api('POST', `/threads/${th.id}/queue`, { content: 'na herstart' });
    const room = await t.api('POST', '/rooms', { name: 'Groep', agentIds: [ada.id] });
    await assert.rejects(t.api('POST', `/threads/${room.threadId}/queue`, { content: 'x' }), /chat met één bot/);
    await t.app.close();
    app2 = await createApp({ dataDir: t.dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
    const view = app2.ctx.services.queue.view(app2.ctx.store.thread(th.id));
    assert.equal(view.paused, true);
    assert.match(view.pausedReason, /herstart/);
    assert.deepEqual(view.items.map((x: any) => x.content), ['na herstart']);
    assert.ok(!app2.ctx.store.messages(th.id).some((x) => x.content === 'na herstart'));
  } finally {
    if (app2) await app2.close();
    const fs = await import('node:fs');
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});
