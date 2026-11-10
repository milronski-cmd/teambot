import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.js';
import { canonicalJson } from '../server/tools/broker.js';
import { mockAdapter, startTestApp, type MockStep, type TestApp } from './helpers.js';
import type { ChatRequest } from '../server/core/types.js';

/**
 * Q-08: an open approval survives a crash. The run that waited is marked interrupted on restart; its approval stays
 * open (interrupted_at) next to the queue; deciding it resumes the run, and the identical request is not asked twice.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => T | Promise<T>, ms = 8000): Promise<NonNullable<T>> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    await sleep(20);
  }
  throw new Error('condition not met in time');
}

interface Restarted {
  app: Awaited<ReturnType<typeof createApp>>;
  script: MockStep[];
  requests: ChatRequest[];
  api<T = any>(method: string, p: string, body?: any): Promise<T>;
  close(): Promise<void>;
}

/**
 * Bring the bot to an open approval (or question), then "crash": the process dies while the run waits. app.close()
 * cancels the run gracefully, so the rows are put back as a hard kill leaves them (run waiting, approval pending).
 */
async function crashWhileWaiting(t: TestApp, threadId: string, content: string, extra?: (t: TestApp) => Promise<void>) {
  await t.api('POST', `/threads/${threadId}/messages`, { content });
  const apr = await until(() => t.app.ctx.store.one<any>("SELECT * FROM approvals WHERE thread_id = ? AND status = 'pending'", threadId));
  const run = t.app.ctx.store.run(apr.run_id)!;
  assert.equal(run.status, 'waiting');
  await extra?.(t);
  await t.app.close();
  const db = new DatabaseSync(path.join(t.dir, 'teambot.db'));
  db.prepare("UPDATE approvals SET status = 'pending', decided_at = NULL, decided_by = NULL WHERE id = ?").run(apr.id);
  db.prepare("UPDATE runs SET status = 'waiting', finished_at = NULL, error = NULL WHERE id = ?").run(run.id);
  db.close();
  return { approvalId: apr.id as string, runId: run.id as string };
}

async function restart(t: TestApp): Promise<Restarted> {
  const script: MockStep[] = [];
  const requests: ChatRequest[] = [];
  const app = await createApp({ dataDir: t.dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
  app.ctx.providers.registerKind({ id: 'mock', label: 'Mock', type: 'api', needsKey: false, description: 'test', models: ['mock-1'], defaultModel: 'mock-1', create: () => mockAdapter(script, requests) });
  const token = app.ctx.auth.ensureLocalOwner();
  const api = async (method: string, p: string, body?: any): Promise<any> => {
    const res = await fetch(app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${(j as any).error}`);
    return j;
  };
  return {
    app,
    script,
    requests,
    api,
    async close() {
      await app.close();
      fs.rmSync(t.dir, { recursive: true, force: true });
    },
  };
}

async function idle(app: Restarted['app'], threadId: string) {
  await sleep(40);
  await until(() => !app.ctx.store.all("SELECT id FROM runs WHERE thread_id = ? AND status IN ('queued','running','waiting')", threadId).length || null);
}

const WRITE = { path: 'na-herstart.txt', content: 'hallo na de herstart' };

test('canonical JSON: key order and undefined values do not matter', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } }), canonicalJson({ a: { d: [1, { x: 1, y: 2 }] }, b: 1 }));
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: 2 }));
});

test('approve after a crash: the approval comes back with the run and the queue, resumes, and is not asked twice', async () => {
  const t = await startTestApp();
  let r2: Restarted | null = null;
  try {
    const bot = await t.agent({ name: 'Schrijver', access_mode: 'ask', tool_groups: ['files'] });
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    t.script.push({ toolCalls: [{ name: 'write_file', args: WRITE }] });
    const { approvalId, runId } = await crashWhileWaiting(t, th.id, 'Schrijf het bestand', async (t) => {
      // A message typed while the bot waited sits in the queue.
      const q = await t.api('POST', `/threads/${th.id}/queue`, { content: 'En daarna een samenvatting', mode: 'queue' });
      assert.equal(q.mode, 'queued');
    });
    r2 = await restart(t);
    const ctx = r2.app.ctx;
    // The run is interrupted (never repeated by itself), the approval is still open, the queue is kept and paused.
    assert.equal(ctx.store.run(runId)!.status, 'interrupted');
    const open = await r2.api('GET', '/approvals');
    assert.equal(open.length, 1);
    assert.equal(open[0].id, approvalId);
    assert.ok(open[0].interrupted_at, 'marked as interrupted');
    const q = await r2.api('GET', `/threads/${th.id}/queue`);
    assert.equal(q.items.length, 1);
    assert.equal(q.paused, true);
    const ev = ctx.store.messages(th.id).filter((m) => m.role === 'event' && m.parts?.kind === 'interrupted').at(-1)!;
    assert.equal(ev.parts.approvalId, approvalId);
    assert.match(ev.content, /goedkeuring staat nog open/);
    // The owner is told (bell / phone).
    const notes = await r2.api('GET', '/notifications');
    assert.ok(JSON.stringify(notes).includes('vóór de herstart'), 'notification about the open approval');
    // Approve: the bot resumes; its identical request is approved once without a new card.
    r2.script.push({ toolCalls: [{ name: 'write_file', args: { content: WRITE.content, path: WRITE.path } }] }, { text: 'Klaar, het bestand staat er.' });
    const view = await r2.api('POST', `/approvals/${approvalId}`, { decision: 'approve' });
    assert.equal(view.status, 'approved');
    await idle(r2.app, th.id);
    const file = path.join(bot.workspace, WRITE.path);
    assert.equal(fs.readFileSync(file, 'utf8'), WRITE.content);
    assert.equal(ctx.store.one<any>("SELECT COUNT(*) n FROM approvals WHERE thread_id = ? AND status = 'pending'", th.id).n, 0, 'no second card');
    assert.equal(ctx.store.one<any>("SELECT COUNT(*) n FROM approvals WHERE thread_id = ?", th.id).n, 1);
    const audit = ctx.store.all<any>('SELECT kind, data FROM audit ORDER BY id').map((a) => a.kind);
    assert.equal(audit.filter((k) => k === 'approval.carried_over').length, 1);
    assert.equal(audit.filter((k) => k === 'file.write').length, 1, 'written exactly once');
    const sys = ctx.store.messages(th.id).find((m) => m.role === 'system' && m.parts?.resumedFrom?.approvalId === approvalId);
    assert.ok(sys && /toestemming voor/.test(sys.content), 'the bot is told what was decided');
    assert.ok(JSON.stringify(r2.requests[0].messages).includes('Na de herstart gaf'), 'the resumed turn sees the decision');
    const runs = ctx.store.all<any>('SELECT trigger, status FROM runs WHERE thread_id = ? ORDER BY created_at', th.id);
    assert.deepEqual(runs.map((r) => r.trigger), ['user', 'resume']);
    // The queue still waits for the owner ("Doorgaan"); nothing was sent by itself.
    assert.equal((await r2.api('GET', `/threads/${th.id}/queue`)).items.length, 1);
    // The carried decision is used once: the same request again asks normally, as does a different one.
    r2.script.push({ toolCalls: [{ name: 'write_file', args: WRITE }] });
    await r2.api('POST', `/threads/${th.id}/queue/resume`, {});
    const again = await until(() => ctx.store.one<any>("SELECT * FROM approvals WHERE thread_id = ? AND status = 'pending'", th.id));
    assert.equal(again.interrupted_at, null);
    r2.app.ctx.runs.cancelThread(th.id);
    await idle(r2.app, th.id);
  } finally {
    if (r2) await r2.close();
    else await t.close();
  }
});

test('deny after a crash: the bot is told, and the identical request is refused without a new card', async () => {
  const t = await startTestApp();
  let r2: Restarted | null = null;
  try {
    const bot = await t.agent({ name: 'Schrijver', access_mode: 'ask', tool_groups: ['files'] });
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    t.script.push({ toolCalls: [{ name: 'write_file', args: WRITE }] });
    const { approvalId } = await crashWhileWaiting(t, th.id, 'Schrijf het bestand');
    // Two restarts before the owner decides: the approval is still there after the second one.
    const first = await restart(t);
    assert.ok(first.app.ctx.store.get<any>('approvals', approvalId).interrupted_at);
    await first.app.close();
    r2 = await restart(t);
    assert.equal(r2.app.ctx.store.get<any>('approvals', approvalId).status, 'pending');
    r2.script.push({ toolCalls: [{ name: 'write_file', args: WRITE }] }, { text: 'Goed, ik laat het.' });
    await r2.api('POST', `/approvals/${approvalId}`, { decision: 'deny' });
    await idle(r2.app, th.id);
    const ctx = r2.app.ctx;
    assert.ok(!fs.existsSync(path.join(bot.workspace, WRITE.path)), 'nothing written');
    assert.equal(ctx.store.one<any>("SELECT COUNT(*) n FROM approvals WHERE thread_id = ? AND status = 'pending'", th.id).n, 0);
    assert.ok(ctx.store.messages(th.id).some((m) => m.role === 'system' && /weigerde/.test(m.content)));
    const tool = ctx.store.messages(th.id).filter((m) => m.role === 'tool').at(-1)!;
    assert.match(tool.content, /geweigerd|weiger/i);
  } finally {
    if (r2) await r2.close();
    else await t.close();
  }
});

test('Hervatten instead of deciding: the old approval expires and the bot asks once again; stale approvals expire', async () => {
  const t = await startTestApp();
  let r2: Restarted | null = null;
  try {
    const bot = await t.agent({ name: 'Schrijver', access_mode: 'ask', tool_groups: ['files'] });
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    t.script.push({ toolCalls: [{ name: 'write_file', args: WRITE }] });
    const { approvalId } = await crashWhileWaiting(t, th.id, 'Schrijf het bestand');
    // Leftovers without a resumable run: no run at all, and a run that had already finished.
    const db = new DatabaseSync(path.join(t.dir, 'teambot.db'));
    const owner = db.prepare('SELECT user_id FROM approvals WHERE id = ?').get(approvalId) as any;
    db.prepare("INSERT INTO approvals (id, user_id, agent_id, run_id, thread_id, kind, tool, input, summary, risk, status, created_at) VALUES ('apr_los', ?, ?, NULL, ?, 'tool', 'write_file', '{}', 'los', 'write', 'pending', ?)").run(owner.user_id, bot.id, th.id, new Date().toISOString());
    db.close();
    r2 = await restart(t);
    const ctx = r2.app.ctx;
    assert.equal(ctx.store.get<any>('approvals', 'apr_los').status, 'expired');
    assert.equal(ctx.store.get<any>('approvals', approvalId).status, 'pending');
    r2.script.push({ toolCalls: [{ name: 'write_file', args: WRITE }] });
    await r2.api('POST', `/threads/${th.id}/resume`, {});
    const fresh = await until(() => ctx.store.one<any>("SELECT * FROM approvals WHERE thread_id = ? AND status = 'pending' AND id != ?", th.id, approvalId));
    assert.equal(ctx.store.get<any>('approvals', approvalId).status, 'expired', 'superseded by the new turn');
    assert.equal(ctx.store.one<any>("SELECT COUNT(*) n FROM approvals WHERE thread_id = ? AND status = 'pending'", th.id).n, 1, 'one card, not two');
    assert.ok(ctx.store.messages(th.id).some((m) => m.parts?.kind === 'approval_superseded'));
    // Deciding the superseded one is refused; the fresh one works as usual.
    await assert.rejects(r2.api('POST', `/approvals/${approvalId}`, { decision: 'approve' }), /al afgehandeld/);
    r2.script.push({ text: 'Gedaan.' });
    await r2.api('POST', `/approvals/${fresh.id}`, { decision: 'approve' });
    await idle(r2.app, th.id);
    assert.equal(fs.readFileSync(path.join(bot.workspace, WRITE.path), 'utf8'), WRITE.content);
  } finally {
    if (r2) await r2.close();
    else await t.close();
  }
});

test('a question that was open during a crash comes back; the answer goes into the resumed run', async () => {
  const t = await startTestApp();
  let r2: Restarted | null = null;
  try {
    const bot = await t.agent({ name: 'Vrager', access_mode: 'ask' });
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    t.script.push({ toolCalls: [{ name: 'ask_user', args: { question: 'Welk seizoen?', options: ['lente', 'herfst'] } }] });
    const { approvalId } = await crashWhileWaiting(t, th.id, 'Vraag me iets');
    r2 = await restart(t);
    const open = (await r2.api('GET', '/approvals'))[0];
    assert.equal(open.kind, 'question');
    assert.ok(open.interrupted_at);
    assert.match(r2.app.ctx.store.messages(th.id).filter((m) => m.parts?.kind === 'interrupted').at(-1)!.content, /vraag van Vrager staat nog open/);
    // The resumed bot asks the same question again: it gets the answer right away (no second card).
    r2.script.push({ toolCalls: [{ name: 'ask_user', args: { question: 'Welk seizoen?', options: ['lente', 'herfst'] } }] }, { text: 'Herfst dus.' });
    await r2.api('POST', `/approvals/${approvalId}`, { decision: 'approve', answer: 'herfst' });
    await idle(r2.app, th.id);
    const ctx = r2.app.ctx;
    assert.ok(JSON.stringify(r2.requests[0].messages).includes('herfst'), 'answer in the resumed turn');
    assert.match(ctx.store.messages(th.id).filter((m) => m.role === 'tool').at(-1)!.content, /Antwoord van de gebruiker: herfst/);
    assert.equal(ctx.store.one<any>("SELECT COUNT(*) n FROM approvals WHERE thread_id = ?", th.id).n, 1);
  } finally {
    if (r2) await r2.close();
    else await t.close();
  }
});
