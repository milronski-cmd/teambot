import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp } from './helpers.js';
import { buildHistory } from '../server/agent/history.js';
import { validateArgs } from '../server/agent/runner.js';
import { resolveInWorkspace } from '../server/tools/builtin/files.js';
import { all, migrate } from '../server/core/db.js';
import { coreMigrations } from '../server/core/migrations.js';

test('chat round trip with streaming text', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent();
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: 'Hallo daar!' });
    const msgs = await t.say(th.id, 'Hoi');
    const last = msgs[msgs.length - 1];
    assert.equal(last.role, 'assistant');
    assert.equal(last.content, 'Hallo daar!');
    assert.equal(last.status, 'done');
    // per-turn context is frozen into the user message
    assert.match(msgs[0].parts.context, /Huidige datum/);
    // system prompt is stable (no timestamp)
    assert.doesNotMatch(t.requests[0].system, /Huidige datum/);
  } finally {
    await t.close();
  }
});

test('tool loop in auto mode writes inside workspace', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ tool_groups: ['files'] });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ toolCalls: [{ name: 'write_file', args: { path: 'x/hello.txt', content: 'hoi' } }] }, { text: 'Klaar' });
    const msgs = await t.say(th.id, 'schrijf');
    assert.equal(fs.readFileSync(path.join(a.workspace, 'x', 'hello.txt'), 'utf8'), 'hoi');
    const tool = msgs.find((m) => m.role === 'tool');
    assert.ok(tool);
    assert.match(tool!.content, /Aangemaakt/);
    assert.equal(msgs[msgs.length - 1].content, 'Klaar');
    // second request contained the tool result
    assert.equal(t.requests[1].messages.at(-1)!.role, 'tool');
  } finally {
    await t.close();
  }
});

test('ask mode waits for approval, deny is reported to the model', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ access_mode: 'ask', tool_groups: ['files'] });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ toolCalls: [{ name: 'write_file', args: { path: 'a.txt', content: '1' } }] }, { text: 'ok' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'doe het' });
    let pending: any[] = [];
    for (let i = 0; i < 100 && !pending.length; i++) {
      await new Promise((r) => setTimeout(r, 20));
      pending = await t.api('GET', '/approvals');
    }
    assert.equal(pending.length, 1);
    assert.equal(pending[0].tool, 'write_file');
    await t.api('POST', `/approvals/${pending[0].id}`, { decision: 'deny' });
    await t.waitIdle(th.id);
    assert.equal(fs.existsSync(path.join(a.workspace, 'a.txt')), false);
    const tool = t.app.ctx.store.messages(th.id).find((m) => m.role === 'tool');
    assert.match(tool!.content, /geweigerd/i);
  } finally {
    await t.close();
  }
});

test('readonly mode denies writes without asking', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ access_mode: 'readonly', tool_groups: ['files'] });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ toolCalls: [{ name: 'write_file', args: { path: 'a.txt', content: '1' } }] }, { text: 'ok' });
    const msgs = await t.say(th.id, 'x');
    assert.match(msgs.find((m) => m.role === 'tool')!.content, /Geweigerd/);
    assert.equal((await t.api('GET', '/approvals')).length, 0);
  } finally {
    await t.close();
  }
});

test('workspace escape is blocked', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent();
    assert.throws(() => resolveInWorkspace(a, '../../etc/passwd'), /buiten/);
    assert.throws(() => resolveInWorkspace(a, path.resolve(t.dir, 'master.key')), /buiten|beschermd/);
    assert.throws(() => resolveInWorkspace(a, '.env'), /beschermd/);
    assert.ok(resolveInWorkspace(a, 'sub/ok.txt').startsWith(a.workspace));
  } finally {
    await t.close();
  }
});

test('fallback engine on outage is visible', async () => {
  const t = await startTestApp();
  try {
    const p2 = await t.api('POST', '/providers', { kind: 'mock', name: 'Backup' });
    const a = await t.agent({ fallback: { provider_id: p2.id, model: 'mock-1' } });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ error: { message: 'overloaded', status: 529 } }, { text: 'van backup' });
    const msgs = await t.say(th.id, 'x');
    assert.equal(msgs.at(-1)!.content, 'van backup');
    assert.ok(msgs.some((m) => m.role === 'event' && /backup/i.test(m.content)));
  } finally {
    await t.close();
  }
});

test('history repairs missing tool results and hides other agents tool traffic', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent();
    const b = await t.agent({ name: 'Ander' });
    const s = t.app.ctx.store;
    const th = s.createThread({ user_id: a.user_id, agent_id: a.id, kind: 'room' });
    s.createMessage({ thread_id: th.id, role: 'user', author_type: 'user', author_name: 'Sanne', content: 'hoi' });
    s.createMessage({ thread_id: th.id, role: 'assistant', author_type: 'agent', author_id: a.id, author_name: a.name, content: '', parts: { toolCalls: [{ id: 'c1', name: 'list_files', args: {} }] } });
    s.createMessage({ thread_id: th.id, role: 'assistant', author_type: 'agent', author_id: b.id, author_name: 'Ander', content: 'ik ben er ook' });
    s.createMessage({ thread_id: th.id, role: 'tool', author_type: 'agent', author_id: b.id, content: 'geheim', parts: { toolResult: { toolCallId: 'zz', name: 'x' } } });
    const { messages } = buildHistory(t.app.ctx, a, th);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[1].role, 'assistant');
    assert.equal(messages[2].role, 'tool'); // synthesized
    assert.match(String(messages[2].content), /Onderbroken/);
    assert.ok(messages.some((m) => typeof m.content === 'string' && m.content.startsWith('[Ander]: ik ben er ook')));
    assert.ok(!messages.some((m) => m.content === 'geheim'));
  } finally {
    await t.close();
  }
});

// Acceptance round 6 (B-51): a local Ollama bot saw "[bijlage: spraakmemo-….wav (audio/wav …)]" and answered "Ik kan je
// audio-bestanden niet afspelen", while the transcript stood right above it.
test('history: a voice memo with a transcript is said to be the words above, not an audio file to play', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent();
    const s = t.app.ctx.store;
    const th = s.createThread({ user_id: a.user_id, agent_id: a.id, kind: 'chat' });
    const att = (name: string, mime: string) => {
      const file = path.join(t.dir, name);
      fs.writeFileSync(file, Buffer.alloc(2048));
      const id = `att_${name.replace(/\W/g, '')}`;
      s.insert('attachments', { id, user_id: a.user_id, thread_id: th.id, name, mime, size: 2048, path: file, created_at: new Date().toISOString() });
      return { id, name, mime, size: 2048 };
    };
    const memo = att('spraakmemo-1.wav', 'audio/wav');
    s.createMessage({ thread_id: th.id, role: 'user', author_type: 'user', author_name: 'Sanne', content: 'Zet melk op de boodschappenlijst.', parts: { voice: true, attachments: [memo] } });
    const empty = att('spraakmemo-2.wav', 'audio/wav');
    s.createMessage({ thread_id: th.id, role: 'user', author_type: 'user', author_name: 'Sanne', content: '(spraakmemo)', parts: { voice: true, attachments: [empty] } });
    const song = att('liedje.mp3', 'audio/mpeg');
    s.createMessage({ thread_id: th.id, role: 'user', author_type: 'user', author_name: 'Sanne', content: 'Wat vind je van dit liedje?', parts: { attachments: [song] } });
    const wa = att('PTT-1.ogg', 'audio/ogg');
    s.createMessage({ thread_id: th.id, role: 'user', author_type: 'user', author_name: 'Sanne', content: '[Spraakbericht, automatisch uitgeschreven (kan fouten bevatten): “Bel de garage.”]', parts: { attachments: [wa] } });
    const texts = buildHistory(t.app.ctx, a, th).messages.map((m) => String(m.content));
    const all = texts.join('\n\n');
    assert.match(all, /Zet melk op de boodschappenlijst\.\n\n\[spraakmemo — de tekst hierboven is wat de gebruiker zei; je hoeft het audiobestand niet af te spelen\]/);
    assert.doesNotMatch(all, /bijlage: spraakmemo-1\.wav/, 'no audio file to deal with');
    assert.match(all, /bijlage: spraakmemo-2\.wav/, 'a memo without words stays an attachment');
    assert.match(all, /bijlage: liedje\.mp3/, 'a song is no voice memo');
    assert.match(all, /“Bel de garage\.”\]\n\n\[spraakmemo — de tekst hierboven/, 'a voice note from a chat app too');
    assert.doesNotMatch(all, /bijlage: PTT-1\.ogg/);
  } finally {
    await t.close();
  }
});

test('stop cancels a running thread and restart marks in-flight runs interrupted', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ access_mode: 'ask', tool_groups: ['files'] });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ toolCalls: [{ name: 'write_file', args: { path: 'a.txt', content: '1' } }] });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'x' });
    await new Promise((r) => setTimeout(r, 200));
    const stopped = await t.api('POST', `/threads/${th.id}/stop`, {});
    assert.equal(stopped.stopped, 1);
    await t.waitIdle(th.id);
    const run = t.app.ctx.store.all('SELECT status FROM runs WHERE thread_id = ?', th.id)[0];
    assert.equal(run.status, 'cancelled');
  } finally {
    await t.close();
  }
});

test('validateArgs catches missing and wrongly typed args', () => {
  const schema = { type: 'object', properties: { path: { type: 'string' }, n: { type: 'number' } }, required: ['path'] };
  assert.match(validateArgs(schema, {})!, /path/);
  assert.match(validateArgs(schema, { path: 1 })!, /string/);
  assert.equal(validateArgs(schema, { path: 'a', n: 2 }), null);
});

test('secrets never leave the API and auth is required', async () => {
  const t = await startTestApp();
  try {
    const p = await t.api('POST', '/providers', { kind: 'openai', apiKey: 'sk-test-1234567890abcdefghij' });
    const list = await t.api('GET', '/providers');
    assert.ok(!JSON.stringify(list).includes('sk-test-1234567890'));
    assert.equal(list.find((x: any) => x.id === p.id).hasKey, true);
    const res = await fetch(t.app.url + '/api/agents');
    assert.equal(res.status, 401);
  } finally {
    await t.close();
  }
});

test('performance indexes exist after migrating, also on a database that already had some of them', async () => {
  const t = await startTestApp();
  try {
    const { db } = t.app.ctx;
    const names = () => new Set(all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'index'").map((r) => r.name));
    const firstColumn = (index: string) => all<{ name: string }>(db, `PRAGMA index_info(${index})`)[0]?.name;
    const wanted = { messages_run: 'run_id', runs_input_message: 'input_message_id', runs_created: 'created_at', threads_parent: 'parent_id', attachments_thread: 'thread_id' };
    for (const [index, column] of Object.entries(wanted)) assert.equal(firstColumn(index), column, index);
    const plan = all<{ detail: string }>(db, 'EXPLAIN QUERY PLAN SELECT MAX(seq) FROM messages WHERE run_id = ?', 'x').map((r) => r.detail).join(' ');
    assert.match(plan, /messages_run/);

    // The migration runs again while three of the five indexes are already there (IF NOT EXISTS): no error.
    db.exec("DROP INDEX runs_created; DROP INDEX threads_parent; DELETE FROM _migrations WHERE id = 'core-perf-indexes-001'");
    migrate(db, coreMigrations);
    for (const index of Object.keys(wanted)) assert.ok(names().has(index), index);
    assert.equal(all(db, "SELECT id FROM _migrations WHERE id = 'core-perf-indexes-001'").length, 1);
  } finally {
    await t.close();
  }
});

test('thread list: the preview of every thread comes from its newest message that is not deleted', async () => {
  const t = await startTestApp();
  try {
    const { store } = t.app.ctx;
    const a = await t.agent();
    const mk = async (title: string) => (await t.api('POST', '/threads', { agentId: a.id, title })).id as string;
    const msg = (thread_id: string, content: string, extra: any = {}) => store.createMessage({ thread_id, role: 'assistant', author_type: 'agent', author_id: a.id, author_name: 'Testbot', content, ...extra });

    const empty = await mk('leeg');
    const long = await mk('lang');
    msg(long, 'eerste');
    const longText = '😀'.repeat(100) + 'x'.repeat(200);
    msg(long, longText);
    const deleted = await mk('verwijderd');
    msg(deleted, 'blijft staan');
    store.updateMessage(msg(deleted, 'weg').id, { deleted: true });
    const budget = await mk('daglimiet');
    msg(budget, 'Daglimiet bereikt', { status: 'error', parts: { budget: { resetAt: '2030-01-02T00:00:00.000Z' } } });
    const failed = await mk('fout');
    msg(failed, 'Mislukt', { status: 'error' });
    const done = await mk('klaar');
    msg(done, 'Gelukt', { parts: { budget: { resetAt: '2030-01-02T00:00:00.000Z' } } });

    const list: any[] = await t.api('GET', '/threads');
    const last = (id: string) => list.find((x) => x.id === id).last;
    const keys = ['content', 'author_name', 'created_at', 'role', 'status'];
    assert.equal(list.length, 6);
    assert.equal(last(empty), null);
    assert.equal(last(long).content, longText.slice(0, 140));
    assert.equal(last(deleted).content, 'blijft staan');
    assert.deepEqual(last(budget), { content: 'Daglimiet bereikt', author_name: 'Testbot', created_at: store.lastMessage(budget)!.created_at, role: 'assistant', status: 'error', budgetUntil: '2030-01-02T00:00:00.000Z' });
    assert.deepEqual(Object.keys(last(failed)), keys);
    assert.equal(last(failed).status, 'error');
    // A budget stop counts only on a failed answer.
    assert.deepEqual(Object.keys(last(done)), keys);
    // The same as the newest message read one thread at a time.
    for (const th of list) {
      const m = store.lastMessage(th.id);
      assert.deepEqual(th.last && keys.map((k) => th.last[k]), m && [m.content.slice(0, 140), m.author_name, m.created_at, m.role, m.status]);
    }
    assert.equal((await t.api('GET', `/threads?agentId=${a.id}&limit=2`)).length, 2);
  } finally {
    await t.close();
  }
});
