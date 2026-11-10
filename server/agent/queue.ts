import type { AttachmentRef, Ctx, Message, MessageParts, Migration, Run, Thread, User } from '../core/types.js';
import { defineTable, newId, now } from '../core/db.js';
import { ah, bad, notFound, str, user } from '../core/http.js';
import { applyRunOverride } from './runner.js';
import { TERMINAL } from './runs.js';

/**
 * Chat queue and steering (CHT: "wachtrij + bijsturen").
 *
 * While a bot is working, messages from the owner wait in a durable queue *outside* the transcript, so the running
 * turn never half-sees them and nothing is answered twice. The owner can edit, reorder and delete queued messages.
 * When the bot becomes idle the first queued message is posted as a normal message (one turn per message).
 *
 * Steering puts a message into the CURRENT turn instead:
 *  - API engines: the message is stored right away (parts.steer.runId) and announced with 'queue.steered'. A model
 *    call that is still generating stops and starts again with the message in it, in the same turn (no tool of that
 *    step has run yet). During tool execution it joins at the next model call: the runner rebuilds the history before
 *    every call. When the turn was about to finish, the runner does one more step (see hasPendingSteer in chat-loop.ts).
 *  - CLI engines (Claude Code, Codex, ACP) cannot take input mid-turn: the message goes to the front of the queue, or
 *    with `interrupt` the turn is stopped and the message sent at once (the CLI session resumes with its context).
 *  - A run that waits for an answer to a question card (ask_user, ask_form, a CLI's own question): the next typed
 *    message IS the answer, also with a plain Enter (OpenBot-style), for API and CLI engines alike. It never lands in
 *    a blocked queue behind the open question.
 */

defineTable('chat_queue', { json: ['attachments', 'parts'] });

export const queueMigrations: Migration[] = [
  {
    id: 'chat-queue-001',
    sql: `
CREATE TABLE chat_queue (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, user_id TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
  attachments TEXT NOT NULL DEFAULT '[]', reply_to TEXT, parts TEXT NOT NULL DEFAULT '{}', sort REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX chat_queue_thread ON chat_queue(thread_id, sort);
`,
  },
];

export const MAX_QUEUE_ITEMS = 50;

export interface QueueItem {
  id: string;
  thread_id: string;
  user_id: string;
  content: string;
  attachments: AttachmentRef[];
  reply_to: string | null;
  parts: MessageParts;
  sort: number;
  created_at: string;
  updated_at: string;
}

export interface QueueInput {
  content: string;
  attachments?: AttachmentRef[];
  replyTo?: string | null;
  parts?: MessageParts;
}

export type SubmitMode = 'auto' | 'queue' | 'steer' | 'interrupt';

export interface SubmitResult {
  /** sent = posted as a normal message; queued = waits in the queue; steered = taken into the running turn;
   *  answered = answered the open question of the running turn; interrupted = turn stopped, message sent now. */
  mode: 'sent' | 'queued' | 'steered' | 'answered' | 'interrupted';
  message?: Message;
  item?: QueueItem;
  reason?: string;
}

/**
 * True when the owner steered this run with a message that the bot has not seen yet (stored after `afterSeq`).
 * Used by the runner before it finishes an API turn.
 */
export function hasPendingSteer(ctx: Ctx, threadId: string, runId: string, afterSeq: number): boolean {
  return !!ctx.store.one("SELECT id FROM messages WHERE thread_id = ? AND role = 'user' AND deleted = 0 AND seq > ? AND json_extract(parts, '$.steer.runId') = ? LIMIT 1", threadId, afterSeq, runId);
}

export class ChatQueue {
  private unsub: (() => void) | null = null;
  /** Runs whose end was handled (run.updated is emitted once per audience member). */
  private handled = new Set<string>();
  /** Threads that are posting their next queued message right now (posting awaits route hooks). */
  private draining = new Set<string>();

  constructor(private getCtx: () => Ctx) {}

  private get ctx() {
    return this.getCtx();
  }

  /** A queued message is being posted in this thread right now (others must wait for the turn it starts). */
  isDraining(threadId: string): boolean {
    return this.draining.has(threadId);
  }

  /** Threads where the owner can queue and steer: a chat (or routine thread) with exactly one bot. */
  supports(t: Thread | null | undefined): t is Thread {
    return !!t && !!t.agent_id && !t.room_id && (t.kind === 'chat' || t.kind === 'routine');
  }

  items(threadId: string): QueueItem[] {
    return this.ctx.store.find<QueueItem>('chat_queue', { thread_id: threadId }, { order: 'sort, created_at' });
  }

  item(thread: Thread, id: string): QueueItem {
    const it = this.ctx.store.get<QueueItem>('chat_queue', id);
    if (!it || it.thread_id !== thread.id) throw notFound('Bericht staat niet (meer) in de wachtrij');
    return it;
  }

  /** The bot's active run in this thread (running first, then waiting, then queued). */
  activeRun(thread: Thread): Run | null {
    if (!thread.agent_id) return null;
    const row = this.ctx.store.one<any>(
      "SELECT * FROM runs WHERE thread_id = ? AND agent_id = ? AND status IN ('queued','running','waiting') ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END, created_at LIMIT 1",
      thread.id,
      thread.agent_id,
    );
    return row ? this.ctx.store.decode<Run>('runs', row) : null;
  }

  /** 'api' (in-process loop: can steer mid-turn) or 'cli' (own loop: queue or interrupt). */
  engine(thread: Thread, run: Run | null = null): 'api' | 'cli' | null {
    const ctx = this.ctx;
    const base = ctx.store.agent(thread.agent_id);
    if (!base) return null;
    const agent = run ? applyRunOverride(base, run.meta?.override) : base;
    const pid = agent.provider_id || ctx.store.getSetting<string | null>(thread.user_id, 'defaultProvider', null);
    const cfg = pid ? ctx.providers.config(pid) : null;
    return (cfg && ctx.providers.kind(cfg.kind)?.type) || null;
  }

  view(thread: Thread) {
    const t = this.ctx.store.thread(thread.id) || thread;
    const run = this.activeRun(t);
    const engine = this.engine(t, run);
    const items = this.items(t.id);
    return {
      threadId: t.id,
      items,
      paused: !!t.meta?.queuePaused && items.length > 0,
      pausedReason: items.length ? t.meta?.queuePausedReason || '' : '',
      busy: !!run,
      runStatus: run?.status || null,
      engine,
      /** The running turn can take a message mid-turn (API engines); CLI engines queue or interrupt. */
      canSteer: !!run && (engine === 'api' || run.status === 'queued'),
    };
  }

  emit(thread: Thread) {
    const t = this.ctx.store.thread(thread.id);
    if (t) this.ctx.chat.emit(t, 'queue.updated', this.view(t));
  }

  // ------------------------------------------------------------------ editing

  add(thread: Thread, u: Pick<User, 'id'>, input: QueueInput, opts: { front?: boolean } = {}): QueueItem {
    const ctx = this.ctx;
    const n = ctx.store.one<{ n: number; lo: number | null; hi: number | null }>('SELECT COUNT(*) n, MIN(sort) lo, MAX(sort) hi FROM chat_queue WHERE thread_id = ?', thread.id)!;
    if (n.n >= MAX_QUEUE_ITEMS) throw bad(`De wachtrij is vol (maximaal ${MAX_QUEUE_ITEMS} berichten).`);
    const ts = now();
    const it: QueueItem = {
      id: newId('cq_'),
      thread_id: thread.id,
      user_id: u.id,
      content: input.content,
      attachments: input.attachments || [],
      reply_to: input.replyTo ?? null,
      parts: input.parts || {},
      sort: n.n === 0 ? 1 : opts.front ? (n.lo ?? 1) - 1 : (n.hi ?? 0) + 1,
      created_at: ts,
      updated_at: ts,
    };
    ctx.store.insert('chat_queue', it);
    ctx.audit(u.id, 'queue.added', { threadId: thread.id, front: !!opts.front }, thread.agent_id);
    return it;
  }

  update(thread: Thread, id: string, content: string): QueueItem {
    const it = this.item(thread, id);
    if (!content.trim() && !it.attachments.length) throw bad('Leeg bericht; verwijder het liever uit de wachtrij.');
    this.ctx.store.update('chat_queue', it.id, { content, updated_at: now() });
    this.emit(thread);
    return this.item(thread, id);
  }

  /** Move an item to position `to` (0 = first). */
  move(thread: Thread, id: string, to: number): QueueItem[] {
    const list = this.items(thread.id);
    const from = list.findIndex((x) => x.id === id);
    if (from < 0) throw notFound('Bericht staat niet (meer) in de wachtrij');
    const [it] = list.splice(from, 1);
    list.splice(Math.max(0, Math.min(list.length, Math.round(Number(to) || 0))), 0, it);
    this.ctx.store.tx(() => list.forEach((x, i) => this.ctx.store.update('chat_queue', x.id, { sort: i + 1 })));
    this.emit(thread);
    return this.items(thread.id);
  }

  remove(thread: Thread, id: string) {
    const it = this.item(thread, id);
    this.ctx.store.remove('chat_queue', it.id);
    this.emit(thread);
  }

  pause(thread: Thread, reason: string) {
    const t = this.ctx.store.thread(thread.id);
    if (!t) return;
    this.ctx.store.updateThread(t.id, { meta: { ...t.meta, queuePaused: true, queuePausedReason: reason.slice(0, 300) } });
    this.emit(t);
  }

  async resume(thread: Thread) {
    const t = this.ctx.store.thread(thread.id);
    if (!t) return;
    if (t.meta?.queuePaused) {
      const { queuePaused: _p, queuePausedReason: _r, ...meta } = t.meta;
      this.ctx.store.updateThread(t.id, { meta });
    }
    await this.drain(t.id);
    this.emit(t);
  }

  // ------------------------------------------------------------------ sending

  private owner(thread: Thread): Pick<User, 'id' | 'name'> {
    const u = this.ctx.store.user(thread.user_id);
    return { id: thread.user_id, name: u?.name || 'Gebruiker' };
  }

  private post(thread: Thread, u: Pick<User, 'id' | 'name'>, input: QueueInput, o: { route?: boolean; parts?: MessageParts } = {}) {
    return this.ctx.chat.postUserMessage({ thread, user: u, content: input.content, attachments: input.attachments, replyTo: input.replyTo ?? null, parts: { ...(input.parts || {}), ...(o.parts || {}) }, route: o.route });
  }

  /**
   * The composer's single entry point. auto/queue: send now when the bot is idle and nothing waits, otherwise queue.
   * steer/interrupt: put it into the current turn (see steer()).
   */
  async submit(thread: Thread, u: Pick<User, 'id' | 'name'>, input: QueueInput, mode: SubmitMode = 'auto'): Promise<SubmitResult> {
    if (mode === 'steer' || mode === 'interrupt') return this.steer(thread, u, input, mode === 'interrupt');
    // The bot asked something and waits: what the owner types now is the answer, not a new turn for later.
    const answered = this.answerOpenQuestion(thread, u, input);
    if (answered) return answered;
    const run = this.activeRun(thread);
    const busy = this.draining.has(thread.id) || !!run || this.items(thread.id).length > 0;
    // The bot's own rule for "a new message while I work" (busy_policy), unless the composer asked for a mode. With
    // messages already waiting the queue keeps its order: a new one goes behind them.
    if (mode === 'auto' && run && !this.items(thread.id).length) {
      const policy = this.ctx.store.agent(thread.agent_id)?.busy_policy;
      if (policy === 'steer' || policy === 'interrupt') return this.steer(thread, u, input, policy === 'interrupt');
    }
    if (!busy) {
      const t = this.ctx.store.thread(thread.id) || thread;
      if (t.meta?.queuePaused) {
        const { queuePaused: _p, queuePausedReason: _r, ...meta } = t.meta;
        this.ctx.store.updateThread(t.id, { meta });
      }
      return { mode: 'sent', message: await this.post(thread, u, input) };
    }
    const item = this.add(thread, u, input);
    this.emit(thread);
    return { mode: 'queued', item };
  }

  async steer(thread: Thread, u: Pick<User, 'id' | 'name'>, input: QueueInput, interrupt = false): Promise<SubmitResult> {
    const ctx = this.ctx;
    const run = this.activeRun(thread);
    if (!run) return { mode: 'sent', message: await this.post(thread, u, input) };
    // A turn waiting for an answer (question card): this message is the answer.
    if (!interrupt) {
      const answered = this.answerOpenQuestion(thread, u, input, run);
      if (answered) return answered;
    }
    if (interrupt) {
      ctx.store.updateRun(run.id, { meta: { ...run.meta, steerInterrupt: true } });
      ctx.runs.cancel(run.id, 'Onderbroken om bij te sturen');
      const message = await this.post(thread, u, input, { parts: { steer: { interrupted: run.id } } });
      ctx.audit(u.id, 'queue.message-steered', { threadId: thread.id, runId: run.id, interrupt: true }, thread.agent_id);
      return { mode: 'interrupted', message };
    }
    // Not started yet (any engine) or an in-process API loop: store it now; the turn reads it at its next step.
    if (run.status === 'queued' || this.engine(thread, run) === 'api') {
      const message = await this.post(thread, u, input, { route: false, parts: { steer: { runId: run.id } } });
      ctx.chat.emit(thread, 'queue.steered', { threadId: thread.id, runId: run.id, messageId: message.id });
      ctx.audit(u.id, 'queue.message-steered', { threadId: thread.id, runId: run.id }, thread.agent_id);
      this.emit(thread);
      return { mode: 'steered', message };
    }
    const item = this.add(thread, u, input, { front: true });
    this.emit(thread);
    return {
      mode: 'queued',
      item,
      reason: 'Deze engine (CLI) kan niet midden in een beurt bijgestuurd worden. Je bericht staat vooraan in de wachtrij; kies “Onderbreken” om de beurt te stoppen en het meteen te sturen.',
    };
  }

  /**
   * The open question of the bot's waiting turn in this chat (a question card: ask_user, ask_form, or a question the
   * CLI itself asks), answered with this message. Null when nothing is asked or the message has no text.
   */
  answerOpenQuestion(thread: Thread, u: Pick<User, 'id'>, input: QueueInput, run: Run | null = this.activeRun(thread)): SubmitResult | null {
    const text = input.content.trim();
    if (!run || run.status !== 'waiting' || !text) return null;
    const q = this.ctx.store.one<{ id: string }>(
      "SELECT id FROM approvals WHERE status = 'pending' AND kind = 'question' AND user_id = ? AND (run_id = ? OR (run_id IS NULL AND thread_id = ?)) ORDER BY created_at DESC LIMIT 1",
      thread.user_id,
      run.id,
      thread.id,
    );
    if (!q) return null;
    try {
      this.ctx.broker.resolve(q.id, u.id, 'approve', text);
    } catch {
      return null;
    }
    this.ctx.audit(u.id, 'queue.answered', { threadId: thread.id, runId: run.id }, thread.agent_id);
    return { mode: 'answered' };
  }

  /** Steer with an item that is already queued (removed from the queue first). */
  async steerItem(thread: Thread, u: Pick<User, 'id' | 'name'>, id: string, interrupt = false): Promise<SubmitResult> {
    const it = this.item(thread, id);
    this.ctx.store.remove('chat_queue', it.id);
    try {
      return await this.steer(thread, u, { content: it.content, attachments: it.attachments, replyTo: it.reply_to, parts: it.parts }, interrupt);
    } finally {
      this.emit(thread);
    }
  }

  /** Post the first queued message when the bot is idle (one message = one turn). */
  async drain(threadId: string): Promise<Message | null> {
    const t = this.ctx.store.thread(threadId);
    if (!this.supports(t) || t.meta?.queuePaused || this.draining.has(t.id) || this.activeRun(t)) return null;
    const [first] = this.items(t.id);
    if (!first) return null;
    this.draining.add(t.id);
    try {
      this.ctx.store.remove('chat_queue', first.id);
      const owner = this.owner(t);
      const m = await this.post(t, { id: first.user_id, name: first.user_id === owner.id ? owner.name : this.ctx.store.user(first.user_id)?.name || owner.name }, { content: first.content, attachments: first.attachments, replyTo: first.reply_to, parts: { ...first.parts, fromQueue: true } });
      return m;
    } finally {
      this.draining.delete(t.id);
      this.emit(t);
    }
  }

  // ------------------------------------------------------------------ lifecycle

  private async onTerminal(r: Run) {
    const ctx = this.ctx;
    if (this.handled.has(r.id)) return;
    this.handled.add(r.id);
    if (this.handled.size > 5000) this.handled.delete(this.handled.values().next().value!);
    const run = ctx.store.run(r.id);
    const t = run ? ctx.store.thread(run.thread_id) : null;
    if (!run || !this.supports(t) || t.agent_id !== run.agent_id) return;
    const queued = this.items(t.id).length;
    if (queued && !t.meta?.queuePaused) {
      if (run.status === 'cancelled' && !run.meta?.steerInterrupt) this.pause(t, 'Gestopt: de wachtrij wacht tot je op “Doorgaan” klikt.');
      else if (run.status === 'error') this.pause(t, 'De vorige beurt mislukte: de wachtrij wacht tot je op “Doorgaan” klikt.');
      else if (run.status === 'interrupted') this.pause(t, 'Onderbroken door een herstart: de wachtrij wacht tot je op “Doorgaan” klikt.');
    }
    // A steer message that arrived after the bot's last step (race at the very end of a turn) still gets its turn.
    if (run.status === 'done' && !this.activeRun(t)) {
      const last = ctx.store.one<{ s: number }>("SELECT COALESCE(MAX(seq), 0) s FROM messages WHERE run_id = ? AND role = 'assistant'", run.id)?.s ?? 0;
      const missed = ctx.store.one<{ id: string }>("SELECT id FROM messages WHERE thread_id = ? AND role = 'user' AND deleted = 0 AND seq > ? AND json_extract(parts, '$.steer.runId') = ? ORDER BY seq LIMIT 1", t.id, last, run.id);
      if (missed) {
        ctx.chat.startAgent(t, run.agent_id, missed.id, 'steer');
        this.emit(t);
        return;
      }
    }
    await this.drain(t.id);
    this.emit(t);
  }

  start() {
    const ctx = this.ctx;
    // After a restart nothing is sent automatically: the owner checks the queue first.
    for (const r of ctx.store.all<{ thread_id: string }>('SELECT DISTINCT thread_id FROM chat_queue')) {
      const t = ctx.store.thread(r.thread_id);
      if (!t) ctx.store.exec('DELETE FROM chat_queue WHERE thread_id = ?', r.thread_id);
      else if (!t.meta?.queuePaused) this.pause(t, 'TeamBot is herstart: controleer de wachtrij en klik op “Doorgaan”.');
    }
    this.unsub = ctx.events.on('run.updated', (e) => {
      const r = e.data as Run;
      if (!r?.id || !TERMINAL.has(r.status)) return;
      // The run manager emits once per audience member; onTerminal is idempotent (drain checks idleness).
      setImmediate(() => this.onTerminal(r).catch((err) => this.ctx.log.error('[queue]', err)));
    });
  }

  stop() {
    this.unsub?.();
    this.unsub = null;
  }
}

/** REST API under /threads/:id/queue and /threads/:id/steer (owner of a 1:1 chat only). */
export function queueRoutes(ctx: Ctx, q: ChatQueue) {
  const api = ctx.api;
  const ownThread = (req: any): Thread => {
    const t = ctx.store.thread(String(req.params.id));
    if (!t || t.user_id !== user(req).id) throw notFound('Gesprek niet gevonden');
    if (!q.supports(t)) throw bad('De wachtrij en bijsturen werken alleen in een chat met één bot.');
    return t;
  };
  const input = (req: any): QueueInput => {
    const u = user(req);
    const content = str(req.body?.content, 200_000);
    const attachments: AttachmentRef[] = Array.isArray(req.body?.attachments)
      ? req.body.attachments
          .map((id: string) => ctx.store.get<any>('attachments', String(id)))
          .filter((a: any) => a && a.user_id === u.id)
          .map((a: any) => ({ id: a.id, name: a.name, mime: a.mime, size: a.size }))
      : [];
    if (!content.trim() && !attachments.length) throw bad('Leeg bericht');
    return { content, attachments, replyTo: req.body?.replyTo ? String(req.body.replyTo) : null, parts: req.body?.voice ? { voice: true } : undefined };
  };
  const linkAttachments = (t: Thread, i: QueueInput) => {
    for (const a of i.attachments || []) ctx.store.update('attachments', a.id, { thread_id: t.id });
  };
  const MODES = new Set(['auto', 'queue', 'steer', 'interrupt']);

  api.get('/threads/:id/queue', ah(async (req) => q.view(ownThread(req))));
  api.post(
    '/threads/:id/queue',
    ah(async (req) => {
      const t = ownThread(req);
      const i = input(req);
      linkAttachments(t, i);
      const mode = MODES.has(req.body?.mode) ? (req.body.mode as SubmitMode) : 'auto';
      return { ...(await q.submit(t, user(req), i, mode)), queue: q.view(t) };
    }),
  );
  api.post(
    '/threads/:id/steer',
    ah(async (req) => {
      const t = ownThread(req);
      const i = input(req);
      linkAttachments(t, i);
      return { ...(await q.steer(t, user(req), i, !!req.body?.interrupt)), queue: q.view(t) };
    }),
  );
  api.post(
    '/threads/:id/queue/pause',
    ah(async (req) => {
      const t = ownThread(req);
      q.pause(t, str(req.body?.reason, 300) || 'Gepauzeerd door jou.');
      return q.view(t);
    }),
  );
  api.post(
    '/threads/:id/queue/resume',
    ah(async (req) => {
      const t = ownThread(req);
      await q.resume(t);
      return q.view(t);
    }),
  );
  api.patch(
    '/threads/:id/queue/:itemId',
    ah(async (req) => {
      const t = ownThread(req);
      q.update(t, String(req.params.itemId), str(req.body?.content, 200_000));
      return q.view(t);
    }),
  );
  api.post(
    '/threads/:id/queue/:itemId/move',
    ah(async (req) => {
      const t = ownThread(req);
      const id = String(req.params.itemId);
      const list = q.items(t.id);
      const cur = list.findIndex((x) => x.id === id);
      const to = req.body?.dir === 'up' ? cur - 1 : req.body?.dir === 'down' ? cur + 1 : Number(req.body?.to);
      q.move(t, id, to);
      return q.view(t);
    }),
  );
  api.post(
    '/threads/:id/queue/:itemId/steer',
    ah(async (req) => {
      const t = ownThread(req);
      return { ...(await q.steerItem(t, user(req), String(req.params.itemId), !!req.body?.interrupt)), queue: q.view(t) };
    }),
  );
  api.delete(
    '/threads/:id/queue/:itemId',
    ah(async (req) => {
      const t = ownThread(req);
      q.remove(t, String(req.params.itemId));
      return q.view(t);
    }),
  );
}
