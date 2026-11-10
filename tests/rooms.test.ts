import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp, type TestApp } from './helpers.js';
import type { ChatRequest, ChatResult, StreamEvent } from '../server/core/types.js';
import { buildHistory } from '../server/agent/history.js';
import { cleanLimits, findMentions } from '../server/modules/rooms/routing.js';

// ---------------------------------------------------------------- multi-bot mock provider

interface BotStep {
  text?: string;
  toolCalls?: { name: string; args: any }[];
  delayMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let callSeq = 0;

/** One mock provider that serves several bots: each bot (by name in the system prompt) has its own script. */
async function team(t: TestApp) {
  const scripts = new Map<string, BotStep[]>();
  const calls: { bot: string; req: ChatRequest; at: number }[] = [];
  t.app.ctx.providers.registerKind({
    id: 'mockteam',
    label: 'Mock team',
    type: 'api',
    needsKey: false,
    description: 'test',
    models: ['mock-1'],
    defaultModel: 'mock-1',
    create: () => ({
      kind: 'mockteam',
      async listModels() {
        return [{ id: 'mock-1' }];
      },
      async test() {
        return { ok: true, detail: 'mock' };
      },
      async chat(req: ChatRequest, signal: AbortSignal, onEvent: (e: StreamEvent) => void): Promise<ChatResult> {
        const bot = /^Je bent (.+?)(?: — |, een AI-agent)/.exec(req.system)?.[1] || '?';
        calls.push({ bot, req, at: Date.now() });
        const step = scripts.get(bot)?.shift();
        if (step?.delayMs)
          await new Promise<void>((res, rej) => {
            const tm = setTimeout(res, step.delayMs);
            signal.addEventListener('abort', () => (clearTimeout(tm), rej(signal.reason || new Error('aborted'))), { once: true });
          });
        const text = step ? step.text ?? '' : `${bot}: ok`;
        if (text) onEvent({ type: 'text', delta: text });
        const toolCalls = (step?.toolCalls || []).map((c) => ({ id: `call_${++callSeq}`, name: c.name, args: c.args }));
        return { text, toolCalls, usage: { input: 10, output: 5 }, stop: toolCalls.length ? 'tool_use' : 'end', model: req.model };
      },
    }),
  });
  const prov = await t.api('POST', '/providers', { kind: 'mockteam' });
  return {
    scripts,
    calls,
    bot: (name: string, data: any = {}) => t.api('POST', '/agents', { name, provider_id: prov.id, model: 'mock-1', access_mode: 'auto', ...data }),
    script(name: string, ...steps: BotStep[]) {
      scripts.set(name, [...(scripts.get(name) || []), ...steps]);
    },
    /** All request text a bot received (system excluded). */
    seen(name: string) {
      return calls.filter((c) => c.bot === name).map((c) => JSON.stringify(c.req.messages));
    },
  };
}

/** Wait until no run is active anywhere (follow-ups are enqueued right after a run ends, so require quiet ticks). */
async function settle(t: TestApp, ms = 10_000) {
  const start = Date.now();
  let quiet = 0;
  while (Date.now() - start < ms) {
    const busy = t.app.ctx.store.all("SELECT id FROM runs WHERE status IN ('queued','running','waiting')");
    if (!busy.length) {
      if (++quiet >= 4) return;
    } else quiet = 0;
    await sleep(25);
  }
  throw new Error('timeout waiting for runs to settle');
}

async function until(fn: () => any, ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(20);
  }
  throw new Error('condition not met in time');
}

function asUser(t: TestApp, name: string) {
  const u = t.app.ctx.auth.createUser({ name, email: `${name.toLowerCase()}@example.test`, password: 'wachtwoord123' });
  const { token } = t.app.ctx.auth.createSession(u.id);
  const call = async (method: string, p: string, body?: any): Promise<any> => {
    const res = await fetch(t.app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`${method} ${p} -> ${res.status}: ${(j as any).error}`), { status: res.status });
    return j;
  };
  return { user: u, api: call, status: async (method: string, p: string, body?: any) => call(method, p, body).then(() => 200, (e) => e.status as number) };
}

const msgs = (t: TestApp, threadId: string) => t.app.ctx.store.messages(threadId, { limit: 1000 });
const answers = (t: TestApp, threadId: string) => msgs(t, threadId).filter((m) => m.role === 'assistant' && m.content);
const runsOf = (t: TestApp, threadId: string) => t.app.ctx.store.all<any>('SELECT * FROM runs WHERE thread_id = ? ORDER BY created_at', threadId);

async function room(t: TestApp, data: any) {
  const r = await t.api('POST', '/rooms', data);
  assert.ok(r.threadId, 'room create returns the thread id');
  return { id: r.room.id as string, thread: r.threadId as string, view: r.room };
}

// ---------------------------------------------------------------- pure helpers

test('mention parsing: names, multi-word, @iedereen, code is ignored', () => {
  const people = [
    { id: 'a', name: 'Ada' },
    { id: 'b', name: 'Data Analist' },
    { id: 'c', name: 'Bo' },
  ];
  assert.deepEqual(findMentions('Hoi @ada en @Data Analist!', people).ids, ['a', 'b']);
  assert.deepEqual(findMentions('vraag voor @data_analist.', people).ids, ['b']);
  assert.equal(findMentions('@iedereen kijk even', people).all, true);
  assert.equal(findMentions('@all', people).all, true);
  assert.deepEqual(findMentions('mail naar x@bo.nl', people).ids, []);
  assert.deepEqual(findMentions('```\n@Bo\n```  en `@Ada`', people).ids, []);
  assert.deepEqual(findMentions('Bo, wil jij dit doen?', people, { leading: true }).ids, ['c']);
  assert.deepEqual(findMentions('Bo, wil jij dit doen?', people).ids, []);
  assert.deepEqual(cleanLimits({ maxTurnsPerMessage: 999, maxCostUsd: '1.5', bogus: 1 }), { maxTurnsPerMessage: 50, maxCostUsd: 1.5 });
});

test('history keeps a tool result paired when another participant spoke in between', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ name: 'A' });
    const s = t.app.ctx.store;
    const th = s.createThread({ user_id: a.user_id, kind: 'room', room_id: 'room_x' });
    s.createMessage({ thread_id: th.id, role: 'user', author_type: 'user', author_name: 'Sanne', content: 'start' });
    s.createMessage({ thread_id: th.id, role: 'assistant', author_type: 'agent', author_id: a.id, author_name: 'A', content: '', parts: { toolCalls: [{ id: 'c1', name: 'list_files', args: {} }] } });
    s.createMessage({ thread_id: th.id, role: 'assistant', author_type: 'agent', author_id: 'other', author_name: 'B', content: 'tussendoor' });
    s.createMessage({ thread_id: th.id, role: 'tool', author_type: 'agent', author_id: a.id, author_name: 'A', content: 'echt resultaat', parts: { toolResult: { toolCallId: 'c1', name: 'list_files' } } });
    const { messages } = buildHistory(t.app.ctx, a, th);
    assert.equal(messages[1].role, 'assistant');
    assert.equal(messages[2].role, 'tool');
    assert.equal(messages[2].content, 'echt resultaat');
    assert.equal(messages[3].content, '[B]: tussendoor');
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------- routing per mode

test('lead mode: lead answers, @mention and reply target other bots, thread id is returned', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const bo = await m.bot('Bo');
    const r = await room(t, { name: 'Kern', agentIds: [ada.id, bo.id], mode: 'lead', leadAgentId: ada.id });
    const th = t.app.ctx.store.thread(r.thread)!;
    assert.equal(th.kind, 'room');
    assert.equal(th.room_id, r.id);
    await t.api('POST', `/threads/${r.thread}/messages`, { content: 'Wat gaan we doen?' });
    await settle(t);
    assert.deepEqual(answers(t, r.thread).map((x) => x.author_name), ['Ada']);
    await t.api('POST', `/threads/${r.thread}/messages`, { content: '@Bo wat vind jij?' });
    await settle(t);
    assert.deepEqual(answers(t, r.thread).map((x) => x.author_name), ['Ada', 'Bo']);
    const boMsg = answers(t, r.thread).at(-1)!;
    await t.api('POST', `/threads/${r.thread}/messages`, { content: 'Leg uit', replyTo: boMsg.id });
    await settle(t);
    assert.deepEqual(answers(t, r.thread).map((x) => x.author_name), ['Ada', 'Bo', 'Bo']);
    // Every bot keeps its own model/permissions: the room prompt tells each bot who it is.
    assert.match(m.calls.find((c) => c.bot === 'Bo')!.req.system, /Groepsgesprek “Kern”/);
    assert.match(m.calls.find((c) => c.bot === 'Ada')!.req.system, /Jij bent de lead/);
  } finally {
    await t.close();
  }
});

test('mention-only mode: nobody answers without a mention; @iedereen wakes everyone', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const bo = await m.bot('Bo');
    const r = await room(t, { name: 'Stil', agentIds: [ada.id, bo.id], mode: 'mention' });
    await t.api('POST', `/threads/${r.thread}/messages`, { content: 'zomaar iets' });
    await settle(t);
    assert.equal(runsOf(t, r.thread).length, 0);
    assert.ok(msgs(t, r.thread).some((x) => x.role === 'event' && /Niemand aangesproken/.test(x.content)));
    await t.api('POST', `/threads/${r.thread}/messages`, { content: '@iedereen stel je voor' });
    await settle(t);
    assert.deepEqual(answers(t, r.thread).map((x) => x.author_name).sort(), ['Ada', 'Bo']);
  } finally {
    await t.close();
  }
});

test('everyone mode runs bots in parallel as separate runs', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const bo = await m.bot('Bo');
    m.script('Ada', { text: 'Ada hier', delayMs: 300 });
    m.script('Bo', { text: 'Bo hier', delayMs: 300 });
    const r = await room(t, { name: 'Allen', agentIds: [ada.id, bo.id], mode: 'everyone' });
    await t.api('POST', `/threads/${r.thread}/messages`, { content: 'Hallo allemaal' });
    await until(() => t.app.ctx.store.all("SELECT id FROM runs WHERE thread_id = ? AND status = 'running'", r.thread).length === 2);
    await settle(t);
    const runs = runsOf(t, r.thread);
    assert.equal(runs.length, 2);
    assert.notEqual(runs[0].agent_id, runs[1].agent_id);
    assert.ok(runs.every((x: any) => x.status === 'done'));
  } finally {
    await t.close();
  }
});

test('round robin: bots answer one after another and each sees the earlier contributions', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ids = [];
    for (const n of ['Ada', 'Bo', 'Cy']) ids.push((await m.bot(n)).id);
    m.script('Ada', { text: 'idee-van-Ada' });
    m.script('Bo', { text: 'idee-van-Bo' });
    m.script('Cy', { text: 'idee-van-Cy' });
    const r = await room(t, { name: 'Rondje', agentIds: ids, mode: 'round_robin' });
    await t.api('POST', `/threads/${r.thread}/messages`, { content: 'Brainstorm: naam voor het product' });
    await settle(t);
    assert.deepEqual(answers(t, r.thread).map((x) => x.author_name), ['Ada', 'Bo', 'Cy']);
    const [bo] = m.seen('Bo');
    const [cy] = m.seen('Cy');
    assert.match(bo, /\[Ada\]: idee-van-Ada/);
    assert.match(cy, /\[Ada\]: idee-van-Ada/);
    assert.match(cy, /\[Bo\]: idee-van-Bo/);
    const runs = runsOf(t, r.thread);
    assert.ok(runs[1].started_at >= runs[0].finished_at, 'Bo starts after Ada finished');
    assert.ok(runs[2].started_at >= runs[1].finished_at, 'Cy starts after Bo finished');
  } finally {
    await t.close();
  }
});

test('turn cap per message stops a sequence', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ids = [];
    for (const n of ['Ada', 'Bo', 'Cy']) ids.push((await m.bot(n)).id);
    const r = await room(t, { name: 'Kort', agentIds: ids, mode: 'round_robin', limits: { maxTurnsPerMessage: 2 } });
    await t.api('POST', `/threads/${r.thread}/messages`, { content: 'Ronde' });
    await settle(t);
    assert.deepEqual(answers(t, r.thread).map((x) => x.author_name), ['Ada', 'Bo']);
    assert.ok(msgs(t, r.thread).some((x) => x.role === 'event' && /Maximum van 2 botbeurten/.test(x.content)));
  } finally {
    await t.close();
  }
});

test('bot @mentions wake other members but A→B→A loops are prevented', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const bo = await m.bot('Bo');
    m.script('Ada', { text: '@Bo kun jij de cijfers checken?' });
    m.script('Bo', { text: '@Ada gedaan, klopt.' });
    const r = await room(t, { name: 'Lus', agentIds: [ada.id, bo.id], mode: 'lead', leadAgentId: ada.id });
    await t.api('POST', `/threads/${r.thread}/messages`, { content: 'Controleer het rapport' });
    await settle(t);
    assert.deepEqual(answers(t, r.thread).map((x) => x.author_name), ['Ada', 'Bo']);
    assert.ok(msgs(t, r.thread).some((x) => x.role === 'event' && /Lus voorkomen/.test(x.content)));
    const bRun = runsOf(t, r.thread).find((x: any) => x.agent_id === bo.id);
    assert.deepEqual(JSON.parse(bRun.meta).team.path, [ada.id, bo.id]);
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------- orchestration tools

test('async delegation to a non-member: subthread, result back as event + follow-up turn', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const bo = await m.bot('Bo');
    const dex = await m.bot('Dex');
    m.script('Ada', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Dex', task: 'Zoek de prijs van X', expected_output: 'Eén bedrag' } }] }, { text: 'Ik heb Dex gevraagd.' }, { text: 'Samenvatting: X kost 10 euro.' });
    m.script('Dex', { text: 'resultaat: 10 euro' });
    const r = await room(t, { name: 'Inkoop', agentIds: [ada.id, bo.id], mode: 'lead', leadAgentId: ada.id });
    await t.api('POST', `/threads/${r.thread}/messages`, { content: 'Wat kost X?' });
    await settle(t);
    const d = t.app.ctx.store.one<any>('SELECT * FROM room_delegations');
    assert.equal(d.status, 'done');
    assert.equal(d.result, 'resultaat: 10 euro');
    const sub = t.app.ctx.store.thread(d.thread_id)!;
    assert.equal(sub.kind, 'delegation');
    assert.equal(sub.parent_id, r.thread);
    assert.equal(sub.room_id, r.id);
    assert.match(m.calls.find((c) => c.bot === 'Dex')!.req.system, /Gedelegeerde subtaak/);
    // Dex is not a visible member of the room.
    const view = await t.api('GET', `/rooms/${r.id}`);
    assert.ok(!view.bots.some((b: any) => b.agentId === dex.id));
    const room1 = msgs(t, r.thread);
    assert.ok(room1.some((x) => x.role === 'system' && /resultaat: 10 euro/.test(x.content) && x.parts.kind === 'delegation_result'));
    assert.equal(answers(t, r.thread).at(-1)!.content, 'Samenvatting: X kost 10 euro.');
    // The tool card can look up the delegation by tool call id.
    const call = room1.find((x) => x.parts.toolCalls?.length)!.parts.toolCalls![0];
    const byCall = await t.api('GET', `/rooms/delegations/by-call/${call.id}`);
    assert.equal(byCall[0].status, 'done');
    assert.equal(byCall[0].toName, 'Dex');
  } finally {
    await t.close();
  }
});

test('waiting delegation in a 1-on-1 chat returns the result; cycles and depth are refused', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    await m.bot('Bo');
    await m.bot('Cy');
    await t.api('PUT', '/rooms/defaults', { maxDelegationDepth: 2 });
    m.script('Ada', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Bo', task: 'Reken 6*7', expected_output: 'getal', wait: true } }] }, { text: 'Klaar' });
    m.script(
      'Bo',
      { toolCalls: [{ name: 'delegate_task', args: { bot: 'Ada', task: 'doe jij het', expected_output: 'x', wait: true } }] },
      { toolCalls: [{ name: 'delegate_task', args: { bot: 'Cy', task: 'check', expected_output: 'ok', wait: true } }] },
      { text: '42' },
    );
    m.script('Cy', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Bo', task: 'terug', expected_output: 'x' } }] }, { toolCalls: [{ name: 'message_bot', args: { bot: 'Dex', message: 'hoi' } }] }, { text: 'gecontroleerd' });
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Hoeveel is 6*7?' });
    await settle(t);
    const adaTool = msgs(t, th.id).find((x) => x.role === 'tool')!;
    assert.match(adaTool.content, /Resultaat van Bo/);
    assert.match(adaTool.content, /42/);
    const subs = t.app.ctx.store.all<any>("SELECT * FROM threads WHERE kind = 'delegation' ORDER BY created_at");
    const boThread = subs.find((x: any) => x.agent_id !== null && JSON.parse(x.meta).delegation.to === t.app.ctx.store.agents(ada.user_id).find((a) => a.name === 'Bo')!.id)!;
    const boTools = msgs(t, boThread.id).filter((x) => x.role === 'tool');
    assert.match(boTools[0].content, /lus te voorkomen/);
    assert.match(boTools[1].content, /Resultaat van Cy/);
    const cyThread = subs.find((x: any) => JSON.parse(x.meta).delegation.to === t.app.ctx.store.agents(ada.user_id).find((a) => a.name === 'Cy')!.id)!;
    const cyTools = msgs(t, cyThread.id).filter((x) => x.role === 'tool');
    assert.match(cyTools[0].content, /lus te voorkomen/);
    assert.match(cyTools[1].content, /Onbekende bot|delegatiediepte/);
    // Private delegation threads are not part of any room.
    assert.ok(subs.every((x: any) => x.room_id === null));
  } finally {
    await t.close();
  }
});

test('delegation depth limit', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    await m.bot('Bo');
    await m.bot('Cy');
    await t.api('PUT', '/rooms/defaults', { maxDelegationDepth: 1 });
    m.script('Ada', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Bo', task: 'a', expected_output: 'b', wait: true } }] }, { text: 'ok' });
    m.script('Bo', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Cy', task: 'c', expected_output: 'd', wait: true } }] }, { text: 'zelf gedaan' });
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'go' });
    await settle(t);
    const boTool = t.app.ctx.store.all<any>("SELECT content FROM messages WHERE role = 'tool' AND author_name = 'Bo'")[0];
    assert.match(boTool.content, /delegatiediepte van 1/);
    assert.equal(m.calls.filter((c) => c.bot === 'Cy').length, 0);
  } finally {
    await t.close();
  }
});

test('broadcast fans out to members as separately tracked runs and gives the sender a follow-up', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const bo = await m.bot('Bo');
    const cy = await m.bot('Cy');
    m.script('Ada', { toolCalls: [{ name: 'broadcast', args: { bots: ['Bo', 'Cy'], message: 'Geef elk één risico' } }] }, { text: 'Gevraagd.' }, { text: 'Samengevat.' });
    m.script('Bo', { text: 'risico-Bo', delayMs: 200 });
    m.script('Cy', { text: 'risico-Cy', delayMs: 200 });
    const r = await room(t, { name: 'Risico', agentIds: [ada.id, bo.id, cy.id], mode: 'lead', leadAgentId: ada.id, limits: { maxTurnsPerMessage: 8 } });
    await t.api('POST', `/threads/${r.thread}/messages`, { content: 'Wat zijn de risico’s?' });
    await settle(t);
    const rows = t.app.ctx.store.all<any>("SELECT * FROM room_delegations WHERE kind = 'broadcast'");
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].run_id, rows[1].run_id);
    assert.ok(rows.every((x: any) => x.status === 'done' && x.thread_id === r.thread));
    const all = msgs(t, r.thread);
    assert.ok(all.some((x) => x.role === 'user' && x.author_type === 'agent' && x.author_name === 'Ada' && x.parts.kind === 'broadcast'));
    assert.ok(all.some((x) => x.role === 'system' && /Alle antwoorden op je broadcast/.test(x.content) && /risico-Bo/.test(x.content) && /risico-Cy/.test(x.content)));
    assert.equal(answers(t, r.thread).at(-1)!.content, 'Samengevat.');
  } finally {
    await t.close();
  }
});

test('handoff makes another member task owner; handing back in the same chain is refused', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const bo = await m.bot('Bo');
    m.script('Ada', { toolCalls: [{ name: 'handoff', args: { bot: 'Bo', reason: 'Bo kent de klant' } }] }, { text: 'Overgedragen.' });
    m.script('Bo', { toolCalls: [{ name: 'handoff', args: { bot: 'Ada', reason: 'terug' } }] }, { text: 'Bo neemt over.' }, { text: 'Bo weer.' });
    const r = await room(t, { name: 'Klant', agentIds: [ada.id, bo.id], mode: 'lead', leadAgentId: ada.id });
    await t.api('POST', `/threads/${r.thread}/messages`, { content: 'Klant belt' });
    await settle(t);
    const roomRow = await t.api('GET', `/rooms/${r.id}`);
    assert.equal(roomRow.owner_agent_id, bo.id);
    const boTool = msgs(t, r.thread).find((x) => x.role === 'tool' && x.author_id === bo.id)!;
    assert.match(boTool.content, /lus te voorkomen/);
    await t.api('POST', `/threads/${r.thread}/messages`, { content: 'En nu?' });
    await settle(t);
    assert.equal(answers(t, r.thread).at(-1)!.author_name, 'Bo');
    assert.equal(answers(t, r.thread).at(-1)!.content, 'Bo weer.');
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------- limits, stop/resume

test('cost cap stops the room and blocks further turns', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada', { model: 'claude-opus-5-5' });
    const r = await room(t, { name: 'Budget', agentIds: [ada.id], mode: 'lead', limits: { maxCostUsd: 0.0002 } });
    await t.api('POST', `/threads/${r.thread}/messages`, { content: 'een' });
    await settle(t);
    assert.equal((await t.api('GET', `/rooms/${r.id}`)).status, 'active');
    await t.api('POST', `/threads/${r.thread}/messages`, { content: 'twee' });
    await settle(t);
    const v = await t.api('GET', `/rooms/${r.id}`);
    assert.equal(v.status, 'paused');
    assert.equal(v.status_reason, 'kostenplafond bereikt');
    assert.ok(v.ledger.total.cost >= 0.0002);
    assert.equal(v.ledger.bots[0].name, 'Ada');
    const before = runsOf(t, r.thread).length;
    await t.api('POST', `/threads/${r.thread}/messages`, { content: 'drie' });
    await settle(t);
    assert.equal(runsOf(t, r.thread).length, before);
    assert.ok(msgs(t, r.thread).some((x) => x.role === 'event' && /Kostenplafond van de groep bereikt/.test(x.content)));
    // Resume buttons in the core chat are refused while the room is paused.
    await assert.rejects(t.api('POST', `/threads/${r.thread}/resume`, {}), /gepauzeerd/);
  } finally {
    await t.close();
  }
});

test('stop and resume one bot; the others keep working', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const bo = await m.bot('Bo');
    m.script('Ada', { text: 'traag', delayMs: 3000 });
    const r = await room(t, { name: 'Pauze', agentIds: [ada.id, bo.id], mode: 'everyone' });
    await t.api('POST', `/threads/${r.thread}/messages`, { content: 'start' });
    await until(() => t.app.ctx.store.one("SELECT id FROM runs WHERE agent_id = ? AND status = 'running'", ada.id));
    const stopped = await t.api('POST', `/rooms/${r.id}/stop`, { agentId: ada.id });
    assert.equal(stopped.stopped, 1);
    await settle(t);
    let v = await t.api('GET', `/rooms/${r.id}`);
    assert.equal(v.bots.find((b: any) => b.agentId === ada.id).state, 'paused');
    assert.equal(t.app.ctx.store.one<any>('SELECT status FROM runs WHERE agent_id = ?', ada.id).status, 'cancelled');
    assert.ok(answers(t, r.thread).some((x) => x.author_name === 'Bo'));
    await t.api('POST', `/threads/${r.thread}/messages`, { content: 'nog eens' });
    await settle(t);
    assert.equal(t.app.ctx.store.all('SELECT id FROM runs WHERE agent_id = ?', ada.id).length, 1, 'paused bot does not answer');
    await t.api('POST', `/rooms/${r.id}/resume`, { agentId: ada.id });
    v = await t.api('GET', `/rooms/${r.id}`);
    assert.equal(v.bots.find((b: any) => b.agentId === ada.id).paused, false);
    await t.api('POST', `/threads/${r.thread}/messages`, { content: 'en nu?' });
    await settle(t);
    assert.equal(t.app.ctx.store.all("SELECT id FROM runs WHERE agent_id = ? AND status = 'done'", ada.id).length, 1);
  } finally {
    await t.close();
  }
});

test('stop the whole room and resume with continue', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    m.script('Ada', { text: 'lang', delayMs: 3000 }, { text: 'verder gegaan' });
    const r = await room(t, { name: 'Stop', agentIds: [ada.id], mode: 'lead' });
    await t.api('POST', `/threads/${r.thread}/messages`, { content: 'begin' });
    await until(() => t.app.ctx.store.one("SELECT id FROM runs WHERE agent_id = ? AND status = 'running'", ada.id));
    await t.api('POST', `/rooms/${r.id}/stop`, {});
    await settle(t);
    assert.equal((await t.api('GET', `/rooms/${r.id}`)).status, 'paused');
    await t.api('POST', `/threads/${r.thread}/messages`, { content: 'hallo?' });
    await settle(t);
    assert.equal(runsOf(t, r.thread).length, 1);
    const res = await t.api('POST', `/rooms/${r.id}/resume`, { continue: true });
    assert.equal(res.started, 1);
    await settle(t);
    assert.equal(answers(t, r.thread).at(-1)!.content, 'verder gegaan');
  } finally {
    await t.close();
  }
});

test('per-participant time-out: a slow bot is stopped and the sequence continues', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const bo = await m.bot('Bo');
    m.script('Ada', { text: 'te laat', delayMs: 4000 });
    const r = await room(t, { name: 'Tijd', agentIds: [ada.id, bo.id], mode: 'round_robin', limits: { turnTimeoutSec: 1 } });
    await t.api('POST', `/threads/${r.thread}/messages`, { content: 'snel graag' });
    await settle(t, 8000);
    const aRun = t.app.ctx.store.one<any>('SELECT * FROM runs WHERE agent_id = ?', ada.id);
    assert.equal(aRun.status, 'cancelled');
    assert.match(aRun.error, /^Time-out/);
    const v = await t.api('GET', `/rooms/${r.id}`);
    assert.equal(v.bots.find((b: any) => b.agentId === ada.id).state, 'timeout');
    assert.ok(answers(t, r.thread).some((x) => x.author_name === 'Bo'));
    assert.ok(msgs(t, r.thread).some((x) => x.role === 'event' && /reageerde niet op tijd/.test(x.content)));
  } finally {
    await t.close();
  }
});

test('max steps per turn stops a looping bot', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const loop = { toolCalls: [{ name: 'task_list', args: {} }] };
    m.script('Ada', loop, loop, loop, loop, { text: 'nooit' });
    const r = await room(t, { name: 'Stappen', agentIds: [ada.id], mode: 'lead', limits: { maxStepsPerTurn: 2 } });
    await t.api('POST', `/threads/${r.thread}/messages`, { content: 'go' });
    await settle(t);
    const run = t.app.ctx.store.one<any>('SELECT * FROM runs WHERE agent_id = ?', ada.id);
    assert.equal(run.status, 'cancelled');
    assert.match(run.error, /Maximum van 2 stappen/);
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------- privacy & approvals & ACL

test('private 1-on-1 content and per-bot turn context never leak into a room', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const bo = await m.bot('Bo');
    t.app.ctx.hooks.turnContext.push(({ agent }) => `PRIVE-CONTEXT-${agent.name}`);
    const priv = await t.api('POST', '/threads', { agentId: ada.id });
    await t.api('POST', `/threads/${priv.id}/messages`, { content: 'Mijn pincode is GEHEIM-4321' });
    await settle(t);
    const r = await room(t, { name: 'Open', agentIds: [ada.id, bo.id], mode: 'everyone' });
    m.calls.length = 0;
    await t.api('POST', `/threads/${r.thread}/messages`, { content: 'Wat weten jullie?' });
    await settle(t);
    const adaSeen = m.seen('Ada').join('\n');
    const boSeen = m.seen('Bo').join('\n');
    assert.ok(!adaSeen.includes('GEHEIM-4321') && !boSeen.includes('GEHEIM-4321'));
    assert.ok(adaSeen.includes('PRIVE-CONTEXT-Ada') && !adaSeen.includes('PRIVE-CONTEXT-Bo'));
    assert.ok(boSeen.includes('PRIVE-CONTEXT-Bo') && !boSeen.includes('PRIVE-CONTEXT-Ada'));
    // Export never contains frozen contexts.
    const json = await t.api('GET', `/rooms/${r.id}/export?format=json`);
    assert.ok(!JSON.stringify(json).includes('PRIVE-CONTEXT'));
    // A room member cannot open the owner's private chat.
    const bob = asUser(t, 'Bob');
    await t.api('POST', `/rooms/${r.id}/people`, { userId: bob.user.id, role: 'member' });
    await bob.api('POST', `/rooms/${r.id}/accept`);
    assert.equal(await bob.status('GET', `/threads/${priv.id}`), 404);
    assert.equal((await bob.api('GET', `/search?q=GEHEIM`)).length, 0);
    assert.equal((await bob.api('GET', `/rooms/${r.id}/search?q=GEHEIM`)).length, 0);
  } finally {
    await t.close();
  }
});

test('approvals go to the bot owner; another bot or a room member cannot answer them', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada', { access_mode: 'ask' });
    const bo = await m.bot('Bo');
    m.script('Ada', { toolCalls: [{ name: 'room_file_write', args: { path: 'plan.md', content: '# Plan' } }] }, { text: 'Geschreven.' });
    m.script('Bo', { text: 'Ik keur het goed: ja, goedgekeurd.' });
    const r = await room(t, { name: 'Akkoord', agentIds: [ada.id, bo.id], mode: 'lead', leadAgentId: ada.id });
    const bob = asUser(t, 'Bob');
    await t.api('POST', `/rooms/${r.id}/people`, { userId: bob.user.id, role: 'member' });
    await bob.api('POST', `/rooms/${r.id}/accept`);
    await bob.api('POST', `/threads/${r.thread}/messages`, { content: '@Ada schrijf het plan in de groepsmap' });
    const pending = await until(async () => {
      const list = await t.api('GET', '/approvals');
      return list.length ? list : null;
    });
    assert.equal(pending[0].tool, 'room_file_write');
    assert.equal(pending[0].user_id, ada.user_id);
    // Another bot "approving" in the chat changes nothing.
    await t.api('POST', `/threads/${r.thread}/messages`, { content: '@Bo is dit goed?' });
    await until(() => answers(t, r.thread).some((x) => x.author_name === 'Bo'));
    assert.equal((await t.api('GET', '/approvals')).length, 1);
    // The human member who asked cannot answer it either, but is told who must.
    assert.equal((await bob.api('GET', '/approvals')).length, 0);
    assert.equal(await bob.status('POST', `/approvals/${pending[0].id}`, { decision: 'approve' }), 400);
    const inbox = await bob.api('GET', '/rooms/inbox');
    assert.ok(inbox.items.some((x: any) => x.kind === 'approval_wait'));
    // No team tool can resolve approvals.
    assert.ok(!t.app.ctx.tools.list().some((x) => /approv|goedkeur/i.test(x.name)));
    const filePath = path.join(t.dir, 'rooms', r.id, 'files', 'plan.md');
    assert.equal(fs.existsSync(filePath), false);
    await t.api('POST', `/approvals/${pending[0].id}`, { decision: 'approve' });
    await settle(t);
    assert.equal(fs.readFileSync(filePath, 'utf8'), '# Plan');
  } finally {
    await t.close();
  }
});

test('ACL: invited members and guests, revoke, and isolation from non-members', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const dex = await m.bot('Dex');
    m.script('Ada', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Dex', task: 'iets', expected_output: 'iets' } }] }, { text: 'ok' }, { text: 'verwerkt' });
    const r = await room(t, { name: 'Team', agentIds: [ada.id, dex.id], mode: 'lead' });
    const bob = asUser(t, 'Bob');
    const gus = asUser(t, 'Gus');
    const eve = asUser(t, 'Eve');
    await t.api('POST', `/rooms/${r.id}/people`, { userId: bob.user.id, role: 'member' });
    await t.api('POST', `/rooms/${r.id}/people`, { userId: gus.user.id, role: 'guest' });
    // Invited but not accepted: no access yet.
    assert.equal(await bob.status('GET', `/threads/${r.thread}`), 404);
    assert.ok((await bob.api('GET', '/rooms')).some((x: any) => x.id === r.id && x.invited));
    await bob.api('POST', `/rooms/${r.id}/accept`);
    await gus.api('POST', `/rooms/${r.id}/accept`);
    assert.equal(await bob.status('GET', `/threads/${r.thread}`), 200);
    assert.equal(await gus.status('GET', `/threads/${r.thread}`), 200);
    await bob.api('POST', `/threads/${r.thread}/messages`, { content: 'Doe iets' });
    await settle(t);
    const bobMsg = msgs(t, r.thread).find((x) => x.author_id === bob.user.id)!;
    assert.equal(bobMsg.author_type, 'user');
    // Guest: transcript only.
    for (const p of [`/rooms/${r.id}/files`, `/rooms/${r.id}/ledger`, `/rooms/${r.id}/activity`, `/rooms/tasks?roomId=${r.id}`]) assert.equal(await gus.status('GET', p), 403, p);
    assert.equal(await gus.status('POST', `/threads/${r.thread}/stop`, {}), 403);
    assert.equal(await gus.status('POST', `/rooms/${r.id}/stop`, {}), 403);
    assert.equal(await gus.status('DELETE', `/messages/${bobMsg.id}`), 403);
    assert.equal(await gus.status('POST', `/threads/${r.thread}/messages`, { content: 'Hoi, ik ben gast' }), 200);
    const gv = await gus.api('GET', `/rooms/${r.id}`);
    assert.equal(gv.access, 'guest');
    assert.equal(gv.ledger, undefined);
    // Delegation subthreads: members yes, guests no.
    await settle(t);
    const sub = t.app.ctx.store.one<any>("SELECT id FROM threads WHERE kind = 'delegation'");
    assert.equal(await bob.status('GET', `/threads/${sub.id}`), 200);
    assert.equal(await gus.status('GET', `/threads/${sub.id}`), 404);
    // A room member cannot steer the owner's delegated bot from the sub-task thread.
    const runsBefore = t.app.ctx.store.all('SELECT id FROM runs').length;
    await bob.api('POST', `/threads/${sub.id}/messages`, { content: 'doe iets anders' });
    await settle(t);
    assert.equal(t.app.ctx.store.all('SELECT id FROM runs').length, runsBefore, 'no run started from a member message in a sub-task');
    // With people in the room, bots can only reach the room's own bots.
    const zed = await m.bot('Zed');
    m.script('Ada', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Zed', task: 'lees privé', expected_output: 'x' } }] }, { text: 'ok' });
    await bob.api('POST', `/threads/${r.thread}/messages`, { content: 'Vraag Zed' });
    await settle(t);
    assert.equal(t.app.ctx.store.all('SELECT id FROM runs WHERE agent_id = ?', zed.id).length, 0, 'non-member bot never ran');
    // Members cannot change settings or people; only the owner can.
    assert.equal(await bob.status('PATCH', `/rooms/${r.id}`, { name: 'Gekaapt' }), 403);
    assert.equal(await bob.status('PATCH', `/threads/${r.thread}`, { title: 'Gekaapt' }), 403);
    assert.equal(await bob.status('POST', `/rooms/${r.id}/people`, { userId: eve.user.id }), 403);
    assert.equal(await bob.status('POST', `/rooms/${r.id}/bots`, { agentId: dex.id }), 403);
    // Non-members see nothing.
    assert.equal(await eve.status('GET', `/rooms/${r.id}`), 404);
    assert.equal(await eve.status('GET', `/threads/${r.thread}`), 404);
    assert.equal(await eve.status('POST', `/threads/${r.thread}/messages`, { content: 'x' }), 404);
    assert.equal((await eve.api('GET', '/rooms')).length, 0);
    // Bob cannot add the owner's bots to his own room.
    assert.equal(await bob.status('POST', '/rooms', { name: 'Eigen', agentIds: [ada.id] }), 400);
    // Revoke.
    await t.api('DELETE', `/rooms/${r.id}/people/${bob.user.id}`);
    assert.equal(await bob.status('GET', `/threads/${r.thread}`), 404);
    assert.equal(await bob.status('GET', `/threads/${sub.id}`), 404);
    // A guest can leave by themselves.
    await gus.api('DELETE', `/rooms/${r.id}/people/${gus.user.id}`);
    assert.equal(await gus.status('GET', `/threads/${r.thread}`), 404);
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------- teams, board, proposals, files, search/export

test('task board via tools, hire proposal approved by a human, teams', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const bo = await m.bot('Bo');
    const tm = await t.api('POST', '/rooms/teams', { name: 'Marketing', chiefAgentId: ada.id, agentIds: [bo.id] });
    assert.equal(tm.members.length, 2);
    assert.equal(tm.members.find((x: any) => x.agent_id === bo.id).reports_to, ada.id);
    const made = await t.api('POST', `/rooms/teams/${tm.id}/room`, {});
    const r = { id: made.room.id, thread: made.threadId };
    assert.equal(made.room.lead_agent_id, ada.id);
    m.script(
      'Ada',
      { toolCalls: [{ name: 'task_create', args: { title: 'Campagne opzetten', owner: 'Bo', deadline: '2026-12-01' } }] },
      { toolCalls: [{ name: 'propose_member', args: { name: 'Eva', role: 'Copywriter', instructions: 'Schrijf teksten.', reason: 'We missen tekstwerk' } }] },
      { text: 'Taak gemaakt en Eva voorgesteld.' },
    );
    // Bo is not addressed in this round (lead mode: Ada answers), so no script for Bo here.
    await t.api('POST', `/threads/${r.thread}/messages`, { content: 'Plan de campagne' });
    await settle(t);
    assert.match(m.calls.find((c) => c.bot === 'Ada')!.req.system, /Marketing/);
    const tasks = await t.api('GET', `/rooms/tasks?roomId=${r.id}`);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].ownerName, 'Bo');
    assert.equal(tasks[0].created_by_name, 'Ada');
    assert.equal(tasks[0].source_thread_id, r.thread);
    const props = await t.api('GET', '/rooms/proposals');
    assert.equal(props.length, 1);
    assert.equal(props[0].status, 'pending');
    const toolOut = t.app.ctx.store.messages(r.thread).filter((x: any) => x.role === 'tool').map((x: any) => x.content).join('\n');
    assert.match(toolOut, /Voorstel ingediend/);
    assert.ok(!toolOut.includes(props[0].id), 'no internal proposal id for the bot to repeat to the owner');
    assert.ok(!(await t.api('GET', '/agents')).some((a: any) => a.name === 'Eva'), 'nothing happens before approval');
    await t.api('POST', `/rooms/proposals/${props[0].id}`, { decision: 'approve' });
    const eva = (await t.api('GET', '/agents')).find((a: any) => a.name === 'Eva');
    assert.ok(eva);
    assert.equal(eva.access_mode, 'ask');
    const v = await t.api('GET', `/rooms/${r.id}`);
    assert.ok(v.bots.some((b: any) => b.agentId === eva.id));
    // A non-lead bot cannot propose members (tool not offered).
    m.script('Bo', { toolCalls: [{ name: 'propose_member', args: { name: 'Zed', reason: 'x' } }] }, { text: 'ok' });
    await t.api('POST', `/threads/${r.thread}/messages`, { content: '@Bo stel iemand voor' });
    await settle(t);
    assert.match(msgs(t, r.thread).filter((x) => x.role === 'tool' && x.author_id === bo.id).at(-1)!.content, /Onbekende tool/);
    // Task update by a human member; guests cannot see the board.
    const bob = asUser(t, 'Bob');
    await t.api('POST', `/rooms/${r.id}/people`, { userId: bob.user.id, role: 'member' });
    await bob.api('POST', `/rooms/${r.id}/accept`);
    const upd = await bob.api('PATCH', `/rooms/tasks/${tasks[0].id}`, { status: 'doing' });
    assert.equal(upd.status, 'doing');
    assert.equal((await bob.api('GET', '/rooms/tasks')).length, 1);
  } finally {
    await t.close();
  }
});

// Acceptance round 5 (A-60): a lead made "Contract opstellen" without Bo as owner although that was asked. The tool
// passes the owner through; what a model writes around it (another field name, a role, "Bo (…)") now lands too, an
// unknown owner lists who can, and a task without owner says so to the model.
test('task board: the owner lands also in the words a model uses, or the model hears what is missing', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const bo = await m.bot('Bo', { role: 'Inkoper zonnepanelen' });
    const r = await room(t, { name: 'Inkoopteam', agentIds: [ada.id, bo.id], mode: 'lead', leadAgentId: ada.id });
    m.script(
      'Ada',
      { toolCalls: [{ name: 'task_create', args: { title: 'Contract opstellen', assignee: 'Bo' } }] },
      { toolCalls: [{ name: 'task_create', args: { title: 'Leverancier bellen', owner: 'Bo (Inkoper zonnepanelen)' } }] },
      { toolCalls: [{ name: 'task_create', args: { title: 'Offerte vergelijken', owner: 'de inkoper zonnepanelen' } }] },
      { toolCalls: [{ name: 'task_create', args: { title: 'Planning maken', owner: 'Karel' } }] },
      { toolCalls: [{ name: 'task_create', args: { title: 'Notulen' } }] },
      { text: 'Klaar.' },
    );
    await t.api('POST', `/threads/${r.thread}/messages`, { content: 'Zet de taken op het bord, voor Bo.' });
    await settle(t);
    const tasks = await t.api('GET', `/rooms/tasks?roomId=${r.id}`);
    const owner = (title: string) => tasks.find((x: any) => x.title === title)?.ownerName;
    assert.equal(owner('Contract opstellen'), 'Bo', '"assignee" is read as the owner');
    assert.equal(owner('Leverancier bellen'), 'Bo', 'a name with the role after it');
    assert.equal(owner('Offerte vergelijken'), 'Bo', 'the role only one bot has');
    assert.equal(tasks.find((x: any) => x.title === 'Planning maken'), undefined, 'an unknown owner makes no task');
    assert.equal(owner('Notulen'), '');
    const out = msgs(t, r.thread).filter((x) => x.role === 'tool').map((x) => x.content);
    assert.ok(out.some((x) => /Onbekende eigenaar: Karel\. Kies een van: .*Ada.*Bo.*, of "mij"\./.test(x)), 'the model hears who can own it');
    assert.ok(out.some((x) => /Notulen[\s\S]*nog geen eigenaar/.test(x)), 'and that a task has no owner');
    assert.match(JSON.stringify(t.app.ctx.tools.get('task_create')?.parameters), /Noemt de gebruiker iemand/, 'the field says when to fill it');
  } finally {
    await t.close();
  }
});

test('room files, search, export and activity attribution', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    m.script('Ada', { toolCalls: [{ name: 'room_file_write', args: { path: 'notities/start.md', content: 'hallo' } }] }, { text: 'Notitie over de zonnepanelen gemaakt.' });
    const r = await room(t, { name: 'Archief', agentIds: [ada.id], mode: 'lead' });
    await t.api('POST', `/threads/${r.thread}/messages`, { content: 'Schrijf een notitie' });
    await settle(t);
    const files = await t.api('GET', `/rooms/${r.id}/files`);
    assert.deepEqual(files.map((f: any) => f.path), ['notities/start.md']);
    const up = await fetch(`${t.app.url}/api/rooms/${r.id}/files?path=${encodeURIComponent('../uit.txt')}`, { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/octet-stream' }, body: 'x' });
    assert.equal(up.status, 400);
    const ok = await fetch(`${t.app.url}/api/rooms/${r.id}/files?path=data.csv`, { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/octet-stream' }, body: 'a,b' });
    assert.equal(ok.status, 200);
    const hits = await t.api('GET', `/rooms/${r.id}/search?q=zonnepanelen`);
    assert.equal(hits.length, 1);
    const md = await (await fetch(`${t.app.url}/api/rooms/${r.id}/export`, { headers: { authorization: `Bearer ${t.token}` } })).text();
    assert.match(md, /# Archief/);
    assert.match(md, /Ada \(bot\)/);
    assert.match(md, /\(mens\)/);
    assert.match(md, /Kosten per bot/);
    const act = await t.api('GET', `/rooms/${r.id}/activity?agentId=${ada.id}`);
    assert.ok(act.items.some((x: any) => x.kind === 'file.write' && x.actor_name === 'Ada'));
    assert.equal(act.turns.length, 1);
    assert.ok(act.turns[0].saw.messages >= 1);
    assert.equal(act.turns[0].tools[0].name, 'room_file_write');
  } finally {
    await t.close();
  }
});

test('hire proposal card: event in the group chat, open in Wacht op jou, read-only for members, deny creates nothing', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const bo = await m.bot('Bo');
    const r = await room(t, { name: 'Redactie', agentIds: [ada.id, bo.id], mode: 'lead', leadAgentId: ada.id });
    const events: any[] = [];
    const off = t.app.ctx.events.on('rooms.proposal', (e) => events.push(e));
    m.script(
      'Ada',
      { toolCalls: [{ name: 'propose_member', args: { name: 'Eva', role: 'Copywriter', instructions: 'Schrijf teksten.', reason: 'We missen tekstwerk' } }] },
      { toolCalls: [{ name: 'propose_member', args: { name: 'Fien', role: 'Fotograaf', reason: 'Beelden bij de artikelen' } }] },
      { text: 'Eva en Fien voorgesteld.' },
    );
    await t.api('POST', `/threads/${r.thread}/messages`, { content: 'Wie missen we nog?' });
    await settle(t);
    // The proposal is an event in the group chat that points at the proposal (the UI renders it as the card).
    const ev = msgs(t, r.thread).filter((x) => x.role === 'event' && x.parts?.kind === 'proposal');
    assert.equal(ev.length, 2);
    const list = await t.api('GET', '/rooms/proposals');
    const eva = list.find((p: any) => p.profile.name === 'Eva');
    const fien = list.find((p: any) => p.profile.name === 'Fien');
    assert.ok(eva && fien);
    assert.equal(ev[0].parts.proposalId, eva.id);
    // The card needs names, not ids; the owner may decide.
    assert.equal(eva.proposerName, 'Ada');
    assert.equal(eva.roomName, 'Redactie');
    assert.equal(eva.roomThreadId, r.thread);
    assert.equal(eva.kind, 'new');
    assert.equal(eva.canDecide, true);
    assert.equal(eva.status, 'pending');
    assert.ok(events.some((e) => e.data?.id === eva.id && e.data?.status === 'pending'), 'live event for the cards');
    // The notification opens the group chat with the card (not a page that does not exist).
    const inbox = t.app.ctx.store.all<any>("SELECT * FROM room_inbox WHERE kind = 'proposal'");
    assert.equal(inbox.length, 2);
    assert.ok(inbox.every((x) => x.link === `#/t/${r.thread}`));
    // GET by id: owner yes; an accepted member of the room read-only; a stranger 404 (and cannot decide).
    const one = await t.api('GET', `/rooms/proposals/${eva.id}`);
    assert.equal(one.profile.name, 'Eva');
    const bob = asUser(t, 'Bob');
    const zoe = asUser(t, 'Zoe');
    await t.api('POST', `/rooms/${r.id}/people`, { userId: bob.user.id, role: 'member' });
    await bob.api('POST', `/rooms/${r.id}/accept`);
    const seen = await bob.api('GET', `/rooms/proposals/${eva.id}`);
    assert.equal(seen.canDecide, false);
    assert.equal(seen.ownerName, one.ownerName);
    assert.equal(await zoe.status('GET', `/rooms/proposals/${eva.id}`), 404);
    assert.equal(await bob.status('POST', `/rooms/proposals/${eva.id}`, { decision: 'approve' }), 404);
    // Nothing exists before approval.
    assert.ok(!(await t.api('GET', '/agents')).some((a: any) => a.name === 'Eva' || a.name === 'Fien'));
    // Deny: nothing created, the card shows the outcome.
    const denied = await t.api('POST', `/rooms/proposals/${fien.id}`, { decision: 'deny' });
    assert.equal(denied.status, 'denied');
    assert.equal(denied.canDecide, false);
    assert.equal(denied.result_agent_id, null);
    assert.ok(!(await t.api('GET', '/agents')).some((a: any) => a.name === 'Fien'));
    // Approve: bot + member; the card can link to the new bot's chat.
    const ok = await t.api('POST', `/rooms/proposals/${eva.id}`, { decision: 'approve' });
    assert.equal(ok.status, 'approved');
    assert.ok(ok.result_agent_id);
    assert.equal(ok.resultName, 'Eva');
    assert.equal(ok.decidedByName, one.ownerName);
    const v = await t.api('GET', `/rooms/${r.id}`);
    assert.ok(v.bots.some((b: any) => b.agentId === ok.result_agent_id));
    assert.equal((await t.api('GET', '/rooms/proposals')).filter((p: any) => p.status === 'pending').length, 0);
    await assert.rejects(t.api('POST', `/rooms/proposals/${eva.id}`, { decision: 'deny' }), /al afgehandeld/);
    off();
  } finally {
    await t.close();
  }
});
