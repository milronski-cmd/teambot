// "Geschiedenis wissen" for a bot or a group (OpenBot 0.64 parity): the conversations go — messages, their files,
// engine sessions, summaries — while the bot or group, memories, routines and tasks stay; owner-only on a server;
// applied again after restoring an older backup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp } from './helpers.js';
import { createApp } from '../server/app.js';
import { now } from '../server/core/db.js';

const countOf = (t: any, sql: string, ...p: any[]) => Number(t.app.ctx.store.one(sql, ...p)?.n || 0);

test('a bot\'s history: conversations, files and sessions go; the bot, memories, routines, tasks and other bots stay', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ name: 'Ada', tool_groups: ['files', 'web', 'memory', 'team', 'routines'] });
    const b = await t.agent({ name: 'Bob' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    // The bot shows a page (an HTML attachment) and answers; a second conversation with the same bot.
    t.script.push({ toolCalls: [{ name: 'show_html', args: { title: 'Rapport', html: '<h1>Kwartaal</h1><p>Omzet steeg met zebrapaard</p>' } }] }, { text: 'Het rapport staat klaar.' });
    await t.say(th.id, 'Maak een rapport over zebrapaard');
    const th2 = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: 'Tweede antwoord' });
    await t.say(th2.id, 'Nog een vraag');
    const att = t.app.ctx.store.one<any>('SELECT * FROM attachments WHERE thread_id = ?', th.id);
    assert.ok(att && fs.existsSync(att.path), 'the page is an attachment on disk');
    // A file the owner sent, forwarded into Bob's chat: still used there, so it stays.
    const up = await fetch(`${t.app.url}/api/attachments?name=notitie.txt&threadId=${th2.id}`, { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': 'text/plain' }, body: 'gedeelde notitie' }).then((r) => r.json());
    t.script.push({ text: 'Gezien' });
    await t.api('POST', `/threads/${th2.id}/messages`, { content: 'Hier is een notitie', attachments: [up.id] });
    await t.waitIdle(th2.id);
    const bobThread = await t.api('POST', '/threads', { agentId: b.id });
    const msg = t.app.ctx.store.messages(th2.id).find((m) => m.parts?.attachments?.some((x: any) => x.id === up.id))!;
    t.script.push({ text: 'Bob antwoordt' });
    await t.api('POST', `/messages/${msg.id}/forward`, { threadId: bobThread.id });
    await t.waitIdle(bobThread.id);
    // An engine session (Claude Code/Codex) of the bot in that conversation, a memory of the bot, a routine, a task.
    t.app.ctx.store.exec("INSERT INTO cli_sessions (thread_id, agent_id, provider_id, user_id, cli, session_id, created_at, updated_at) VALUES (?, ?, 'p', ?, 'claude', 'sess-1', ?, ?)", th.id, a.id, a.user_id, now(), now());
    await t.api('POST', '/memory/items', { content: 'Ada schrijft rapporten altijd in het Nederlands', scope: 'agent', agentId: a.id });
    await t.api('POST', '/routines', { name: 'Ochtend', agent_id: a.id, prompt: 'Vat het nieuws samen', schedule: { kind: 'none' } });
    const room = await t.api('POST', '/rooms', { name: 'Team', agentIds: [a.id, b.id] });
    await t.api('POST', '/rooms/tasks', { roomId: room.room.id, title: 'Offerte nakijken', ownerType: 'agent', ownerId: a.id });

    const p = await t.api('GET', `/agents/${a.id}/history`);
    assert.equal(p.threads, 2);
    assert.ok(p.messages >= 4, 'messages counted: ' + p.messages);
    assert.equal(p.files, 1, 'the page goes, the forwarded note stays: ' + JSON.stringify(p));
    assert.equal(p.running, 0);
    assert.ok(p.stays.memories >= 1 && p.stays.routines === 1 && p.stays.groups === 1, JSON.stringify(p.stays));
    assert.equal(typeof p.backups, 'number');

    const r = await t.api('DELETE', `/agents/${a.id}/history`);
    assert.equal(r.ok, true);
    assert.equal(r.threads, 2);
    const st = t.app.ctx.store;
    assert.equal(st.thread(th.id), null, 'conversation gone');
    assert.equal(st.thread(th2.id), null);
    assert.equal(countOf(t, 'SELECT COUNT(*) n FROM messages WHERE thread_id IN (?, ?)', th.id, th2.id), 0);
    assert.equal(st.one('SELECT id FROM attachments WHERE id = ?', att.id), undefined, 'attachment row gone');
    assert.ok(!fs.existsSync(att.path), 'attachment file gone');
    assert.ok(st.one('SELECT id FROM attachments WHERE id = ?', up.id) && fs.existsSync(st.one<any>('SELECT path FROM attachments WHERE id = ?', up.id)!.path), 'a file still used in another conversation stays');
    assert.equal(countOf(t, 'SELECT COUNT(*) n FROM cli_sessions WHERE thread_id = ?', th.id), 0, 'engine session gone (never resumed with the old conversation)');
    assert.equal(st.search(a.user_id, 'zebrapaard', 10).length, 0, 'not findable anymore');
    // what stays
    assert.ok(st.agent(a.id), 'bot stays');
    assert.ok(st.thread(bobThread.id) && st.messages(bobThread.id).length >= 2, "Bob's conversation stays");
    assert.ok(countOf(t, "SELECT COUNT(*) n FROM memory_items WHERE agent_id = ? AND status = 'active'", a.id) >= 1, 'memory stays');
    assert.equal(countOf(t, 'SELECT COUNT(*) n FROM routines WHERE agent_id = ?', a.id), 1, 'routine stays');
    assert.equal(countOf(t, 'SELECT COUNT(*) n FROM room_tasks WHERE room_id = ?', room.room.id), 1, 'task stays');
    assert.ok(st.thread(room.threadId), 'group conversation stays');
    assert.equal(countOf(t, "SELECT COUNT(*) n FROM audit WHERE kind = 'history.deleted' AND agent_id = ?", a.id), 1, 'audited');
    assert.equal(countOf(t, "SELECT COUNT(*) n FROM history_purges WHERE scope = 'agent' AND ref_id = ?", a.id), 1, 'kept for a restore');
    // The bot simply goes on in a new conversation.
    const fresh = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: 'Nieuw begin' });
    const after = await t.say(fresh.id, 'Hallo');
    assert.ok(after.some((m) => m.content === 'Nieuw begin'));
    const p2 = await t.api('GET', `/agents/${a.id}/history`);
    assert.equal(p2.threads, 1, 'only the new conversation');
  } finally {
    await t.close();
  }
});

test("a group's history: its conversation is emptied, conversations between the bots go, group, bots and tasks stay", async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ name: 'Ada' });
    const b = await t.agent({ name: 'Bob' });
    const r = await t.api('POST', '/rooms', { name: 'Kwartaal', agentIds: [a.id, b.id], mode: 'lead' });
    const roomId = r.room.id;
    t.script.push({ text: 'Begrepen, ik pak het op met nijlpaardsoep' });
    await t.say(r.threadId, 'Plan het kwartaal');
    // A conversation between the bots inside the group (a subtask).
    const sub = t.app.ctx.store.createThread({ user_id: a.user_id, agent_id: b.id, room_id: roomId, kind: 'delegation', title: 'Subtaak' });
    t.app.ctx.store.createMessage({ thread_id: sub.id, role: 'assistant', author_type: 'agent', author_id: b.id, author_name: 'Bob', content: 'Deelresultaat' });
    t.app.ctx.store.update('threads', r.threadId, { meta: { ...t.app.ctx.store.thread(r.threadId)!.meta, summary: 'oude samenvatting', summaryUpTo: 3 }, provider_state: { session: 'x' } });
    await t.api('POST', '/rooms/tasks', { roomId, title: 'Begroting' });

    const p = await t.api('GET', `/rooms/${roomId}/history`);
    assert.equal(p.threads, 1, 'one conversation between the bots');
    assert.ok(p.messages >= 3, JSON.stringify(p));
    assert.equal(p.stays.bots, 2);
    assert.equal(p.stays.tasks, 1);

    const res = await t.api('DELETE', `/rooms/${roomId}/history`);
    assert.equal(res.ok, true);
    const st = t.app.ctx.store;
    const main = st.thread(r.threadId)!;
    assert.ok(main, 'the group keeps its own conversation');
    assert.equal(st.messages(r.threadId).length, 0, 'emptied');
    assert.equal(main.meta.summary, undefined, 'no summary of the old conversation');
    assert.equal(main.meta.roomId, roomId, 'group link stays');
    assert.deepEqual(main.provider_state, {}, 'no engine state of the old conversation');
    assert.equal(st.thread(sub.id), null, 'conversation between the bots gone');
    assert.equal(st.search(a.user_id, 'nijlpaardsoep', 10).length, 0);
    assert.ok(st.one('SELECT id FROM rooms WHERE id = ?', roomId), 'group stays');
    assert.equal(countOf(t, "SELECT COUNT(*) n FROM room_members WHERE room_id = ? AND kind = 'agent'", roomId), 2, 'bots stay');
    assert.equal(countOf(t, 'SELECT COUNT(*) n FROM room_tasks WHERE room_id = ?', roomId), 1, 'task stays');
    // The group simply goes on.
    t.script.push({ text: 'Opnieuw begonnen' });
    const after = await t.say(r.threadId, 'Nieuwe start');
    assert.ok(after.some((m) => m.content === 'Opnieuw begonnen'));
  } finally {
    await t.close();
  }
});

test('on a server only the owner of the installation may delete history; never someone else\'s bot or group', async () => {
  const t = await startTestApp({ mode: 'server' });
  try {
    const ownBot = await t.agent({ name: 'Eigen' });
    const m = t.app.ctx.auth.createUser({ name: 'Lid', email: 'lid@test.local', password: 'geheim1234', role: 'member' });
    const tok = t.app.ctx.auth.createSession(m.id, 'web', 'x').token;
    const as = (method: string, p: string) => fetch(`${t.app.url}/api${p}`, { method, headers: { authorization: `Bearer ${tok}` } });
    const memberBot = t.app.ctx.store.createAgent(m.id, { name: 'Van het lid', provider_id: t.providerId, model: 'mock-1' });
    const res = await as('DELETE', `/agents/${memberBot.id}/history`);
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /Alleen de eigenaar van deze TeamBot-server/);
    assert.equal((await as('GET', `/agents/${memberBot.id}/history`)).status, 403);
    // The owner, but not of this bot: not found (and never another person's conversations).
    assert.ok([403, 404].includes((await fetch(`${t.app.url}/api/agents/${memberBot.id}/history`, { method: 'DELETE', headers: { authorization: `Bearer ${t.token}` } })).status));
    assert.equal((await t.api('GET', `/agents/${ownBot.id}/history`)).threads, 0);
    const r = await t.api('POST', '/rooms', { name: 'G', agentIds: [ownBot.id] });
    assert.equal((await as('DELETE', `/rooms/${r.room.id}/history`)).status, 403);
    assert.equal((await t.api('DELETE', `/rooms/${r.room.id}/history`)).ok, true);
  } finally {
    await t.close();
  }
});

test('after restoring an older backup the deleted history is deleted again', async () => {
  const t = await startTestApp();
  const dir = t.dir;
  let botId = '';
  let threadId = '';
  try {
    const a = await t.agent({ name: 'Ada' });
    botId = a.id;
    const th = await t.api('POST', '/threads', { agentId: a.id });
    threadId = th.id;
    t.script.push({ text: 'Geheim antwoord over flamingoboot' });
    await t.say(th.id, 'Vertel over flamingoboot');
    const backup = (await t.api('POST', '/backups', { wait: true })).backup;
    await t.api('DELETE', `/agents/${a.id}/history`);
    assert.equal(t.app.ctx.store.thread(th.id), null);
    await t.api('POST', `/backups/${backup.name}/restore`);
    await t.app.close();
  } catch (e) {
    await t.app.close().catch(() => {});
    throw e;
  }
  const app2 = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
  try {
    assert.ok(app2.ctx.store.agent(botId), 'the bot is back from the backup');
    assert.equal(app2.ctx.store.thread(threadId), null, 'its old conversation is deleted again');
    assert.equal(app2.ctx.store.search(app2.ctx.store.agent(botId)!.user_id, 'flamingoboot', 10).length, 0);
    assert.ok(!fs.existsSync(path.join(dir, 'restore-history.json')), 'carry-over file consumed');
    assert.equal(Number(app2.ctx.store.one<any>("SELECT COUNT(*) n FROM history_purges WHERE ref_id = ?", botId)?.n || 0), 1, 'the rule is kept for a next restore');
    assert.equal(Number(app2.ctx.store.one<any>("SELECT COUNT(*) n FROM audit WHERE kind = 'history.reapplied'")?.n || 0), 1);
  } finally {
    await app2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('files on disk: only what lies inside the data folder is deleted — a folder boundary, any letter case on Windows, never the folder itself', async () => {
  const { insideDataDir } = await import('../server/modules/history/purge.js');
  const data = path.resolve('tmp-data', 'TeamBot');
  assert.equal(insideDataDir(data, path.join(data, 'attachments', 'a.png')), true);
  assert.equal(insideDataDir(data + path.sep, path.join(data, 'voice', 'x.wav')), true);
  assert.equal(insideDataDir(data, `${data}-oud${path.sep}a.png`), false, 'a folder whose name only starts the same');
  assert.equal(insideDataDir(data, `${data}2${path.sep}a.png`), false);
  assert.equal(insideDataDir(data, path.join(data, '..', 'elders', 'a.png')), false, 'climbs out with ..');
  assert.equal(insideDataDir(data, data), false, 'never the data folder itself');
  assert.equal(insideDataDir(data, ''), false);
  assert.equal(insideDataDir(data, null), false);
  assert.equal(insideDataDir(data, path.join(data.toUpperCase(), 'attachments', 'a.png')), process.platform === 'win32', 'Windows paths compare whatever the case');
});
