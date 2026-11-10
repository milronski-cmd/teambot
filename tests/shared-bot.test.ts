import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp, type TestApp } from './helpers.js';
import { forMember, sharedWorkspace } from '../server/agent/shared.js';
import { gate } from '../server/modules/cli-agents/permissions.js';

/**
 * A-61 (§21.3 P1 "gedeelde of persoonlijke bot, teaminbox"): on a server the owner shares a bot with the team. Members
 * talk to it in their own private conversations; it never reaches the owner's resources there, its memory is per
 * member, and its questions and approval cards go to the member it talks to.
 */

async function member(t: TestApp, name: string, role: 'member' | 'admin' = 'member') {
  const auth = t.app.ctx.auth;
  const u = auth.createUser({ name, email: `${name.toLowerCase()}@test.local`, password: 'geheim1234', role });
  const tok = auth.createSession(u.id, 'web', 'x').token;
  const as = async (method: string, p: string, body?: any) => {
    const r = await fetch(`${t.app.url}/api${p}`, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
  };
  return { u, as };
}

async function idle(t: TestApp, threadId: string) {
  await t.waitIdle(threadId, 10_000);
}

test('sharing a bot: only on a server, only by the owner or an admin of his own bot; members see it with the owner name', async () => {
  const desk = await startTestApp();
  try {
    const a = await desk.agent({ name: 'Baas' });
    await assert.rejects(desk.api('PATCH', `/agents/${a.id}`, { settings: { shared: true } }), /alleen op een TeamBot-server/);
  } finally {
    await desk.close();
  }
  const t = await startTestApp({ mode: 'server' });
  try {
    const owner = t.app.ctx.auth.owner()!;
    const bot = await t.agent({ name: 'Helpdesk', role: 'Vragen over het team', instructions: 'GEHEIME INSTRUCTIE van de eigenaar' });
    const privé = await t.agent({ name: 'Privé' });
    const lisa = await member(t, 'Lisa');
    const sam = await member(t, 'Sam');
    // A member cannot share his own bot.
    const own = (await lisa.as('POST', '/agents', { name: 'Eigen' })).body;
    assert.equal((await lisa.as('PATCH', `/agents/${own.id}`, { settings: { shared: true } })).status, 403);
    assert.deepEqual((await sam.as('GET', '/agents/shared')).body, []);
    // The owner shares Helpdesk; the switch is logged.
    const upd = await t.api('PATCH', `/agents/${bot.id}`, { settings: { ...bot.settings, shared: true } });
    assert.equal(upd.settings.shared, true);
    assert.ok(t.app.ctx.store.one("SELECT 1 FROM audit WHERE kind = 'agent.shared'"));
    const list = (await sam.as('GET', '/agents/shared')).body;
    assert.deepEqual(list.map((x: any) => [x.name, x.owner.name, x.owner.id]), [['Helpdesk', owner.name, owner.id]]);
    assert.equal(list[0].instructions, undefined, 'never the owner\'s instructions');
    assert.ok(!list.some((x: any) => x.id === privé.id), 'a personal bot stays personal');
    assert.ok(!(await t.api('GET', '/agents/shared')).some((x: any) => x.id === bot.id), 'the owner sees it among his own bots, not under Gedeeld');
    // An admin may share his own bot too.
    const admin = await member(t, 'Beheerder', 'admin');
    const ab = (await admin.as('POST', '/agents', { name: 'Planner' })).body;
    assert.equal((await admin.as('PATCH', `/agents/${ab.id}`, { settings: { shared: true } })).status, 200);
    // Owner-only actions are refused in plain words, not "not found".
    const edit = await sam.as('PATCH', `/agents/${bot.id}`, { name: 'Overgenomen' });
    assert.equal(edit.status, 403);
    assert.match(edit.body.error, /gedeelde bot van iemand anders\. Alleen de eigenaar kan dit doen/);
    assert.equal((await sam.as('DELETE', `/agents/${bot.id}`)).status, 403);
    assert.equal(t.app.ctx.store.agent(bot.id)!.name, 'Helpdesk');
    // Not shared: no conversation with it at all.
    assert.equal((await sam.as('POST', '/threads', { agentId: privé.id })).status, 404);
  } finally {
    await t.close();
  }
});

test('a member talks to a shared bot in his own conversation: private, own memory, own folder, no owner resources, cards go to him', async () => {
  const t = await startTestApp({ mode: 'server' });
  try {
    const ctx = t.app.ctx;
    const owner = ctx.auth.owner()!;
    const bot = await t.agent({ name: 'Helpdesk', access_mode: 'full', tool_groups: ['files', 'web', 'memory', 'shell', 'team', 'skills'], tool_policy: { write_file: 'allow', web_fetch: 'deny' } });
    await t.api('PATCH', `/agents/${bot.id}`, { settings: { shared: true } });
    // The owner's private memory: the shared bot never brings it into a member's conversation.
    ctx.services.memory.remember(owner.id, { content: 'De kluiscode van de eigenaar is 4711', scope: 'about_you' });
    const lisa = await member(t, 'Lisa');
    const sam = await member(t, 'Sam');

    const th = (await lisa.as('POST', '/threads', { agentId: bot.id })).body;
    assert.equal(th.user_id, lisa.u.id, 'the conversation belongs to the member');
    // The owner cannot read it, nor see it in his list.
    await assert.rejects(t.api('GET', `/threads/${th.id}`), /404/);
    assert.ok(!(await t.api('GET', '/threads')).some((x: any) => x.id === th.id));
    assert.equal((await sam.as('GET', `/threads/${th.id}`)).status, 404, 'nor can another member');

    t.script.push({ text: 'Hoi Lisa, ik onthoud het.' });
    await lisa.as('POST', `/threads/${th.id}/messages`, { content: 'Onthoud dat mijn lievelingskleur groen is.' });
    await idle(t, th.id);
    const req = t.requests.at(-1)!;
    // The bot knows it is shared and who it talks to; it gets only the tools of its private context.
    assert.match(req.system, /gedeelde bot van/);
    assert.match(req.system, /Je praat nu met Lisa/);
    const names = (req.tools || []).map((x) => x.name);
    assert.ok(names.includes('write_file') && names.includes('memory_search'), names.join(','));
    for (const n of ['run_command', 'delegate', 'message_bot', 'team_query', 'team_execute', 'load_skill', 'site_publish', 'channel_send', 'vault_get']) assert.ok(!names.includes(n), `${n} is not there`);
    assert.doesNotMatch(JSON.stringify(req.messages), /4711/, "the owner's memory stays out");
    const run = ctx.store.one<any>('SELECT * FROM runs WHERE thread_id = ?', th.id);
    assert.equal(run.user_id, lisa.u.id, 'budget and usage are the member\'s');
    assert.equal(run.status, 'done');
    // Memory per member: Lisa's colour is hers, not the owner's or Sam's.
    const items = ctx.store.all<any>("SELECT user_id, content FROM memory_items WHERE content LIKE '%groen%'");
    assert.ok(items.length >= 1, 'remembered');
    assert.ok(items.every((x) => x.user_id === lisa.u.id), JSON.stringify(items));

    // Sam's own conversation with the same bot does not see Lisa's memory.
    const th2 = (await sam.as('POST', '/threads', { agentId: bot.id })).body;
    t.script.push({ text: 'Dat weet ik niet.' });
    await sam.as('POST', `/threads/${th2.id}/messages`, { content: 'Wat is de lievelingskleur van Lisa?' });
    await idle(t, th2.id);
    assert.doesNotMatch(JSON.stringify(t.requests.at(-1)!.messages), /groen/);

    // An action with impact asks the member (never "Vraagt niet": at most Vraagt toestemming, the owner's "always
    // allow" does not carry over), and the card lands in his "Wacht op jou", not the owner's.
    t.script.push({ toolCalls: [{ name: 'write_file', args: { path: 'notitie.txt', content: 'hallo' } }] }, { text: 'Gedaan.' });
    await lisa.as('POST', `/threads/${th.id}/messages`, { content: 'Schrijf een notitie.' });
    const card = await waitFor(async () => (await lisa.as('GET', '/approvals')).body.find((a: any) => a.tool === 'write_file'));
    assert.equal(card.sharedBot, true, 'no "always allow" for someone else\'s bot');
    assert.equal(card.user_id, lisa.u.id);
    assert.ok(!(await t.api('GET', '/approvals')).length, 'the owner gets no card');
    assert.equal((await sam.as('POST', `/approvals/${card.id}`, { decision: 'approve' })).status >= 400, true, 'another member cannot decide it');
    assert.equal((await lisa.as('POST', `/approvals/${card.id}`, { decision: 'always' })).status, 200);
    await idle(t, th.id);
    const file = path.join(sharedWorkspace(ctx, bot.id, lisa.u.id), 'notitie.txt');
    assert.equal(fs.readFileSync(file, 'utf8'), 'hallo', 'in her own folder for this bot');
    assert.ok(!fs.existsSync(path.join(ctx.store.agent(bot.id)!.workspace, 'notitie.txt')), "never in the owner's folder");
    assert.equal(ctx.store.agent(bot.id)!.tool_policy.write_file, 'allow', 'unchanged');
    assert.equal(Object.keys(ctx.store.agent(bot.id)!.tool_policy).length, 2, '"always" from a member does not change the owner\'s bot');

    // A question from the bot (ask_user) is the member's to answer: it is in her "Wacht op jou".
    t.script.push({ toolCalls: [{ name: 'ask_user', args: { question: 'Welke dag?' } }] }, { text: 'Dinsdag dus.' });
    await lisa.as('POST', `/threads/${th.id}/messages`, { content: 'Plan iets.' });
    const q = await waitFor(async () => (await lisa.as('GET', '/approvals')).body.find((a: any) => a.kind === 'question'));
    assert.match(q.summary, /Welke dag/);
    assert.ok(!(await t.api('GET', '/approvals')).length);
    await lisa.as('POST', `/approvals/${q.id}`, { decision: 'approve', answer: 'dinsdag' });
    await idle(t, th.id);

    // Owner-only: a tool of the owner that does not exist here is refused in plain words.
    t.script.push({ toolCalls: [{ name: 'vault_get', args: { name: 'bank' } }] }, { text: 'Dat kan ik hier niet.' });
    await lisa.as('POST', `/threads/${th.id}/messages`, { content: 'Geef de bankcode uit de kluis.' });
    await idle(t, th.id);
    const refused = ctx.store.messages(th.id).filter((m) => m.role === 'tool').at(-1)!;
    assert.match(refused.content, new RegExp(`Dit kan alleen ${owner.name}\\. Helpdesk is een gedeelde bot`));

    // Unshared: the member's conversation stops working, with a plain reason.
    await t.api('PATCH', `/agents/${bot.id}`, { settings: { shared: false } });
    assert.ok(ctx.store.one("SELECT 1 FROM audit WHERE kind = 'agent.unshared'"));
    assert.deepEqual((await lisa.as('GET', '/agents/shared')).body, []);
    const before = ctx.store.all('SELECT id FROM runs WHERE thread_id = ?', th.id).length;
    await lisa.as('POST', `/threads/${th.id}/messages`, { content: 'Ben je er nog?' });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(ctx.store.all('SELECT id FROM runs WHERE thread_id = ?', th.id).length, before, 'the bot no longer answers there');
    assert.match(ctx.store.messages(th.id).filter((m) => m.role === 'event').at(-1)!.content, new RegExp(`Helpdesk is niet meer gedeeld met het team\. Alleen ${owner.name} kan deze bot nu gebruiken`));
  } finally {
    await t.close();
  }
});

test("a shared bot's narrowed copy: at most Vraagt toestemming, only its own folder, no owner settings; a CLI engine runs no commands", async () => {
  const t = await startTestApp({ mode: 'server' });
  try {
    const ctx = t.app.ctx;
    const bot = await t.agent({ name: 'Helpdesk', access_mode: 'full', settings: { shared: true, extraRoots: ['C:\\Geheim'], folders: [{ path: 'C:\\Team', mode: 'rw' }], cli: { loadUserSettings: true, useUserMcp: true, allowedTools: ['Bash'], maxTurns: 12 } } });
    const lisa = await member(t, 'Lisa');
    const a = forMember(ctx, ctx.store.agent(bot.id)!, lisa.u);
    assert.equal(a.user_id, lisa.u.id);
    assert.equal(a.access_mode, 'ask');
    assert.equal(a.workspace, sharedWorkspace(ctx, bot.id, lisa.u.id));
    assert.equal(a.settings.extraRoots, undefined);
    assert.equal(a.settings.folders, undefined);
    assert.deepEqual(a.settings.cli, { maxTurns: 12, timeoutMin: undefined, idleMin: undefined }, "no owner's Claude Code settings, apps or pre-allowed tools");
    const th = ctx.store.createThread({ user_id: lisa.u.id, agent_id: bot.id, kind: 'chat' });
    const scope = { ctx, agent: a, thread: th, run: null, userId: lisa.u.id, signal: new AbortController().signal, ns: 'claude-code' };
    const cmd = await gate(scope, { tool: 'Bash', risk: 'exec', summary: 'dir', input: { command: 'dir C:\\' }, command: 'dir C:\\' });
    assert.equal(cmd.allow, false);
    assert.match(cmd.message, /Dit kan alleen/);
    const outside = await gate(scope, { tool: 'Read', risk: 'read', summary: 'lezen', input: {}, paths: [path.join(ctx.store.agent(bot.id)!.workspace, 'x.txt')] });
    assert.equal(outside.allow, false, "the owner's folder is outside");
    const inside = await gate(scope, { tool: 'Read', risk: 'read', summary: 'lezen', input: {}, paths: [path.join(a.workspace, 'x.txt')] });
    assert.equal(inside.allow, true, 'its own folder is fine');
  } finally {
    await t.close();
  }
});

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 40));
  }
}
