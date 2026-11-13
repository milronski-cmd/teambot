import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { answers, msgs, runsOf, settle, team, until } from './team-mock.js';

/** Asynchronous bot-to-bot messages (ask_bot): A asks B without waiting, B answers in its own chat, A is woken. */

const deleg = (t: any) => t.app.ctx.store.all('SELECT * FROM room_delegations ORDER BY created_at').map((r: any) => t.app.ctx.store.decode('room_delegations', r));
const mainChat = (t: any, agentId: string) => t.app.ctx.chat.threadForAgent(t.app.ctx.auth.owner().id, agentId);

test('ask_bot: the lead asks two bots in parallel, keeps working, and is woken once with both answers', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const baas = await m.bot('Baas');
    const ops = await m.bot('Operations');
    const ks = await m.bot('Klantenservice');
    m.script(
      'Baas',
      { toolCalls: [{ name: 'ask_bot', args: { bot: 'Operations', message: 'Hoeveel orders staan er open?' } }, { name: 'ask_bot', args: { bot: 'Klantenservice', message: 'Hoeveel tickets zijn er?' } }] },
      // The lead keeps working (answers arrive meanwhile and are held, not injected mid-turn).
      { text: 'Ik heb het team gevraagd.', delayMs: 400 },
      { text: 'Samenvatting: 12 orders en 3 tickets.' },
    );
    m.script('Operations', { text: '12 orders open', delayMs: 50 });
    m.script('Klantenservice', { text: '3 tickets', delayMs: 120 });
    const th = await t.api('POST', '/threads', { agentId: baas.id });
    const t0 = Date.now();
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Hoe staan we ervoor?' });
    // Both colleagues start while the lead's turn is still running: nobody waits for anybody.
    await until(() => m.calls.filter((c) => c.bot === 'Operations' || c.bot === 'Klantenservice').length === 2);
    assert.ok(t.app.ctx.store.one("SELECT id FROM runs WHERE thread_id = ? AND status = 'running'", th.id), 'Baas is still in its first turn');
    await settle(t);
    assert.ok(Date.now() - t0 < 5000);

    const ds = deleg(t);
    assert.equal(ds.length, 2);
    assert.ok(ds.every((d: any) => d.kind === 'ask' && d.status === 'done' && d.delivered));
    // Each bot answered in its own main chat, visibly ("Baas vraagt …" / reply / "Antwoord teruggestuurd").
    for (const [bot, answer] of [
      [ops, '12 orders open'],
      [ks, '3 tickets'],
    ] as const) {
      const chat = mainChat(t, bot.id);
      assert.equal(chat.kind, 'chat');
      const list = msgs(t, chat.id);
      const ask = list.find((x) => x.role === 'user' && x.parts.kind === 'bot_ask')!;
      assert.equal(ask.author_name, 'Baas');
      assert.match(ask.content, /^Baas vraagt:/);
      assert.equal(answers(t, chat.id).at(-1)!.content, answer);
      assert.ok(list.some((x) => x.role === 'event' && /Antwoord teruggestuurd naar Baas/.test(x.content)));
      // The recipient knew who asked and that its answer goes back (frozen turn context).
      assert.match(ask.parts.context || '', /komt van de bot Baas/);
    }
    // The lead: one note per answer, ONE follow-up turn for both.
    const notes = msgs(t, th.id).filter((x) => x.role === 'system' && x.parts.kind === 'delegation_result');
    assert.equal(notes.length, 2);
    assert.ok(notes.some((n) => /Operations antwoordde/.test(n.content) && /12 orders open/.test(n.content)));
    assert.ok(notes.some((n) => /Klantenservice antwoordde/.test(n.content) && /3 tickets/.test(n.content)));
    const baasRuns = runsOf(t, th.id, baas.id);
    assert.equal(baasRuns.length, 2, 'initial turn + one bundled follow-up');
    assert.equal(JSON.parse(baasRuns[1].meta).team.kind, 'followup');
    assert.equal(answers(t, th.id).at(-1)!.content, 'Samenvatting: 12 orders en 3 tickets.');
    // The follow-up saw both answers.
    const lastReq = m.calls.filter((c) => c.bot === 'Baas').at(-1)!;
    assert.match(JSON.stringify(lastReq.req.messages), /12 orders open/);
    assert.match(JSON.stringify(lastReq.req.messages), /3 tickets/);
    // The tool call returned immediately (non-blocking) and the tool card can find the requests.
    const tool = msgs(t, th.id).find((x) => x.role === 'tool')!;
    assert.match(tool.content, /Bericht verstuurd aan Operations/);
    const call = msgs(t, th.id).find((x) => x.parts.toolCalls?.length)!.parts.toolCalls![0];
    const byCall = await t.api('GET', `/rooms/delegations/by-call/${call.id}`);
    assert.equal(byCall[0].toName, 'Operations');
  } finally {
    await t.close();
  }
});

test('ask_bot: a busy recipient gets the message after its current turn; answers wake a CLI sender too', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const baas = await m.cliBot('Baas');
    const ops = await m.bot('Operations');
    // Operations is busy with the owner in its own chat.
    m.script('Operations', { text: 'Klaar met jouw vraag', delayMs: 300 }, { text: 'Antwoord voor Baas: alles op schema' });
    const opsChat = await t.api('POST', '/threads', { agentId: ops.id });
    await t.api('POST', `/threads/${opsChat.id}/messages`, { content: 'Werk het voorraadoverzicht bij' });
    await until(() => t.app.ctx.store.one("SELECT id FROM runs WHERE thread_id = ? AND status = 'running'", opsChat.id));
    // Baas (a CLI engine; CLI bots get these tools through the MCP bridge) asks while Operations works.
    const baasChat = await t.api('POST', '/threads', { agentId: baas.id });
    const s = t.app.ctx.store;
    const brun = t.app.ctx.runs.enqueue({ threadId: baasChat.id, agentId: baas.id, userId: baas.user_id, trigger: 'test' });
    m.script('Baas', { text: 'Bezig', delayMs: 50 }, { text: 'Top, dank je.' });
    await until(() => s.run(brun.id)?.status === 'running');
    const tool = t.app.ctx.tools.get('ask_bot')!;
    const out: any = await tool.run({ bot: 'Operations', message: 'Ligt de levering op schema?' }, { ctx: t.app.ctx, agent: s.agent(baas.id)!, thread: s.thread(baasChat.id)!, run: s.run(brun.id)!, userId: baas.user_id, signal: new AbortController().signal, toolCallId: 'cli_call_1', progress() {} });
    assert.match(out.text, /nog met iets anders bezig/);
    const d = deleg(t)[0];
    assert.equal(d.status, 'queued');
    assert.equal(d.run_id, null, 'held until Operations is free');
    assert.equal((await t.api('GET', `/rooms/delegations/${d.id}`)).statusLabel, 'wacht tot Operations vrij is');
    await settle(t);
    const fin = deleg(t)[0];
    assert.equal(fin.status, 'done');
    assert.equal(fin.result, 'Antwoord voor Baas: alles op schema');
    // Order in Operations' chat: owner question, answer, then Baas's message, answer.
    const opsMsgs = msgs(t, opsChat.id).filter((x) => x.role === 'user' || x.role === 'assistant');
    assert.deepEqual(
      opsMsgs.map((x) => `${x.role}:${x.author_name}`),
      ['user:' + s.user(baas.user_id)!.name, 'assistant:Operations', 'user:Baas', 'assistant:Operations'],
    );
    // The CLI sender was woken in its own conversation with the answer in its prompt.
    const wake = m.cliCalls.filter((c) => c.bot === 'Baas').at(-1)!;
    assert.match(wake.req.prompt, /Operations antwoordde/);
    assert.match(wake.req.prompt, /alles op schema/);
    assert.equal(answers(t, baasChat.id).at(-1)!.content, 'Top, dank je.');
  } finally {
    await t.close();
  }
});

test('ask_bot loop protection: no asking back (cycle), depth, ping-pong rate per pair and a chain budget', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const a = await m.bot('Ada');
    await m.bot('Bo');
    await m.bot('Cy');
    await m.bot('Dex');
    await t.api('PUT', '/rooms/defaults', { maxDelegationDepth: 2, maxAsksPerPairPerHour: 2 });
    m.script(
      'Ada',
      {
        toolCalls: [
          { name: 'ask_bot', args: { bot: 'Bo', message: 'vraag 1' } },
          { name: 'ask_bot', args: { bot: 'Bo', message: 'vraag 2', reply: false } },
          { name: 'ask_bot', args: { bot: 'Bo', message: 'vraag 3' } },
        ],
      },
      { text: 'verstuurd' },
      { text: 'verwerkt' },
    );
    // Bo tries to ask Ada back (cycle) and passes work on to Cy; Cy tries Dex (too deep).
    m.script('Bo', { toolCalls: [{ name: 'ask_bot', args: { bot: 'Ada', message: 'terug?' } }, { name: 'ask_bot', args: { bot: 'Cy', message: 'check' } }] }, { text: 'Bo: 1' }, { text: 'Bo: 2' }, { text: 'Bo: Cy zegt ok' });
    m.script('Cy', { toolCalls: [{ name: 'ask_bot', args: { bot: 'Dex', message: 'nog dieper' } }] }, { text: 'Cy: ok' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'go' });
    await settle(t);
    const tools = t.app.ctx.store.all<any>("SELECT author_name, content FROM messages WHERE role = 'tool' ORDER BY created_at, seq");
    const of = (who: string) => tools.filter((x) => x.author_name === who).map((x) => x.content);
    assert.match(of('Ada')[0], /Bericht verstuurd aan Bo/);
    assert.match(of('Ada')[1], /Bericht verstuurd aan Bo/);
    assert.match(of('Ada')[2], /heen-en-weer/);
    assert.match(of('Bo')[0], /lus te voorkomen/);
    assert.match(of('Bo')[1], /Bericht verstuurd aan Cy/);
    assert.match(of('Cy')[0], /delegatiediepte van 2/);
    assert.equal(m.calls.filter((c) => c.bot === 'Dex').length, 0);
    // Two messages reached Bo; only the one with reply=true woke Ada. The notification did not, but Ada is still told
    // how it ended: a note in her conversation, without a turn.
    const toBo = deleg(t).filter((d: any) => d.to_agent_id !== a.id && d.task.startsWith('vraag'));
    assert.equal(toBo.length, 2);
    assert.ok(toBo.every((d: any) => d.status === 'done'));
    const notes = msgs(t, th.id).filter((x) => x.parts.kind === 'delegation_result');
    assert.equal(notes.length, 2);
    assert.equal(notes.filter((x) => /heeft je melding afgehandeld/.test(x.content)).length, 1);
    assert.equal(t.app.ctx.store.all<any>("SELECT id FROM runs WHERE thread_id = ? AND json_extract(meta, '$.team.kind') = 'followup'", th.id).length, 1, 'one follow-up turn: only for the question');

    // Chain budget: a tiny token cap stops further messages in the same chain.
    await t.api('PUT', '/rooms/defaults', { maxChainTokens: 10, maxAsksPerPairPerHour: 50 });
    m.script('Ada', { toolCalls: [{ name: 'ask_bot', args: { bot: 'Cy', message: 'nog iets' } }] }, { text: 'ok' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'nog een ronde' });
    await settle(t);
    assert.match(t.app.ctx.store.all<any>("SELECT content FROM messages WHERE role = 'tool' AND author_name = 'Ada' ORDER BY seq").at(-1).content, /Tokenbudget van deze keten/);
  } finally {
    await t.close();
  }
});

test('ask_bot is cancellable: withdrawn messages are never delivered and nobody is woken', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const a = await m.bot('Ada');
    const bo = await m.bot('Bo');
    // Bo is busy; Ada sends two messages and withdraws them all.
    m.script('Bo', { text: 'lang werk', delayMs: 300 });
    const boChat = await t.api('POST', '/threads', { agentId: bo.id });
    await t.api('POST', `/threads/${boChat.id}/messages`, { content: 'doe iets langs' });
    m.script('Ada', { toolCalls: [{ name: 'ask_bot', args: { bot: 'Bo', message: 'een' } }, { name: 'ask_bot', args: { bot: 'Bo', message: 'twee' } }] }, { toolCalls: [{ name: 'delegation_cancel', args: { all: true } }] }, { text: 'ingetrokken' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'go' });
    await settle(t);
    const ds = deleg(t);
    assert.equal(ds.length, 2);
    assert.ok(ds.every((d: any) => d.status === 'cancelled' && d.delivered));
    assert.ok(!msgs(t, boChat.id).some((x) => x.parts.kind === 'bot_ask'), 'never posted to Bo');
    assert.equal(runsOf(t, th.id, a.id).length, 1, 'Ada was not woken');
    assert.match(t.app.ctx.store.all<any>("SELECT content FROM messages WHERE role = 'tool' AND author_name = 'Ada' ORDER BY seq").at(-1).content, /ingetrokken/);

    // The owner withdraws a running one from the UI; the sender finds a note but gets no extra turn.
    m.script('Bo', { text: 'traag', delayMs: 400 });
    m.script('Ada', { toolCalls: [{ name: 'ask_bot', args: { bot: 'Bo', message: 'drie' } }] }, { text: 'gevraagd' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'nog eens' });
    const d3 = await until(() => deleg(t).find((d: any) => d.task === 'drie' && d.run_id));
    await until(() => t.app.ctx.store.run(d3.run_id)?.status === 'running');
    await t.api('POST', `/rooms/delegations/${d3.id}/cancel`, {});
    await settle(t);
    const fin = deleg(t).find((d: any) => d.id === d3.id);
    assert.equal(fin.status, 'cancelled');
    assert.equal(runsOf(t, th.id, a.id).length, 2);
    assert.ok(msgs(t, th.id).some((x) => x.role === 'system' && /trok het bericht/.test(x.content)));

    // Stopping the sender withdraws the messages it sent in that turn.
    m.script('Bo', { text: 'bezig', delayMs: 400 });
    await t.api('POST', `/threads/${boChat.id}/messages`, { content: 'weer werk' });
    m.script('Ada', { toolCalls: [{ name: 'ask_bot', args: { bot: 'Bo', message: 'vier' } }] }, { text: 'denkt na', delayMs: 2000 });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'laatste' });
    await until(() => deleg(t).some((d: any) => d.task === 'vier'));
    await t.api('POST', `/threads/${th.id}/stop`, {});
    await settle(t);
    const d4 = deleg(t).find((d: any) => d.task === 'vier');
    assert.equal(d4.status, 'cancelled');
    assert.ok(!msgs(t, boChat.id).some((x) => x.content.includes('vier')));
  } finally {
    await t.close();
  }
});
