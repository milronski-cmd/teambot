import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { msgs, settle, team, until } from './team-mock.js';

/** A message typed while the bot's question card is open is the answer (OpenBot-style), not a blocked queue item. */

test('a message typed while a question card is open is the answer (plain Enter), also for a form', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    m.script('Ada', { toolCalls: [{ name: 'ask_user', args: { question: 'Welke kleur?', options: ['rood', 'blauw'] } }] }, { text: 'Dan wordt het herfstkleurig.' });
    await t.api('POST', `/threads/${th.id}/queue`, { content: 'kies een kleur' });
    await until(() => t.app.ctx.store.one("SELECT id FROM approvals WHERE thread_id = ? AND status = 'pending' AND kind = 'question'", th.id));
    const r = await t.api('POST', `/threads/${th.id}/queue`, { content: 'herfstkleuren' });
    assert.equal(r.mode, 'answered', 'not queued behind the question');
    assert.equal(r.queue.items.length, 0);
    await settle(t);
    assert.match(msgs(t, th.id).filter((x) => x.role === 'tool').at(-1)!.content, /Antwoord van de gebruiker: herfstkleuren/);

    // A form answered with a sentence in the chat: the bot is told it is a chat answer, not JSON.
    m.script('Ada', { toolCalls: [{ name: 'ask_form', args: { title: 'Je gegevens', fields: [{ name: 'naam', label: 'Naam' }, { name: 'seizoen', label: 'Seizoen' }] } }] }, { text: 'Dank je.' });
    await t.api('POST', `/threads/${th.id}/queue`, { content: 'vul iets in' });
    await until(() => t.app.ctx.store.one("SELECT id FROM approvals WHERE thread_id = ? AND status = 'pending' AND tool = 'ask_form'", th.id));
    const f = await t.api('POST', `/threads/${th.id}/queue`, { content: 'Sanne, herfst' });
    assert.equal(f.mode, 'answered');
    await settle(t);
    assert.match(msgs(t, th.id).filter((x) => x.role === 'tool').at(-1)!.content, /antwoordde in de chat: Sanne, herfst/);

    // A tool approval (not a question) still waits: the message is queued as before.
    m.script('Ada', { toolCalls: [{ name: 'write_file', args: { path: 'a.txt', content: 'x' } }] }, { text: 'klaar' });
    await t.api('PATCH', `/agents/${ada.id}`, { access_mode: 'ask', tool_groups: ['files'] });
    await t.api('POST', `/threads/${th.id}/queue`, { content: 'schrijf a.txt' });
    await until(() => t.app.ctx.store.one("SELECT id FROM approvals WHERE thread_id = ? AND status = 'pending' AND kind = 'tool'", th.id));
    const q = await t.api('POST', `/threads/${th.id}/queue`, { content: 'en daarna dit' });
    assert.equal(q.mode, 'queued');
    const apr = t.app.ctx.store.one<any>("SELECT id FROM approvals WHERE thread_id = ? AND status = 'pending'", th.id);
    await t.api('POST', `/approvals/${apr.id}`, { decision: 'deny' });
    await settle(t);
  } finally {
    await t.close();
  }
});

test('CLI engine: a question the CLI asks (e.g. ask_user over MCP) is answered by the next typed message; a queued message as well, without interrupting', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const bob = await m.cliBot('Bob');
    const th = await t.api('POST', '/threads', { agentId: bob.id });
    m.script('Bob', { text: 'klaar', delayMs: 1500 }, { text: 'ok', delayMs: 1500 });
    await t.api('POST', `/threads/${th.id}/queue`, { content: 'begin' });
    const run = await until(() => t.app.ctx.store.one<any>("SELECT * FROM runs WHERE thread_id = ? AND status = 'running'", th.id));
    // What the TeamBot MCP server does when the CLI calls ask_user during its turn.
    const ask = () =>
      t.app.ctx.broker.request({ userId: run.user_id, agent: t.app.ctx.store.agent(bob.id), thread: t.app.ctx.store.thread(th.id), run: t.app.ctx.store.run(run.id), kind: 'question', tool: 'ask_user', input: { question: 'Welke map?' }, summary: 'Welke map?', risk: 'read' });
    const first = ask();
    await until(() => t.app.ctx.store.one("SELECT 1 FROM runs WHERE id = ? AND status = 'waiting'", run.id));
    const r = await t.api('POST', `/threads/${th.id}/queue`, { content: 'De map Offertes' });
    assert.equal(r.mode, 'answered');
    assert.equal((await first).answer, 'De map Offertes');

    // A message that was already queued, then sent with the lightning button (steer without interrupt) answers too.
    const queued = await t.api('POST', `/threads/${th.id}/queue`, { content: 'De map Facturen' });
    assert.equal(queued.mode, 'queued');
    const second = ask();
    await until(() => t.app.ctx.store.one("SELECT 1 FROM runs WHERE id = ? AND status = 'waiting'", run.id));
    const s = await t.api('POST', `/threads/${th.id}/queue/${queued.item.id}/steer`, { interrupt: false });
    assert.equal(s.mode, 'answered');
    assert.equal((await second).answer, 'De map Facturen');
    assert.notEqual(t.app.ctx.store.run(run.id)!.status, 'cancelled', 'the turn was not interrupted');
    await settle(t);
  } finally {
    await t.close();
  }
});
