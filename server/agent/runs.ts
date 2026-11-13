import { redact } from '../core/secrets.js';
import type { Ctx, Run } from '../core/types.js';
import { now } from '../core/db.js';
import { crashDetail, plainEngineError } from './fallback.js';
import { isBudgetError, type BudgetStop } from './budget.js';

type Exec = (run: Run, signal: AbortSignal) => Promise<void>;

/** A run in one of these states is over. */
export const TERMINAL = new Set(['done', 'error', 'cancelled', 'interrupted']);

/**
 * Durable run queue. One run at a time per (thread, agent); different agents in
 * the same room may run in parallel. Runs are persisted, so a restart can tell
 * what was queued (re-queued) and what was in flight (marked interrupted, resumable).
 */
export class RunManager {
  private queue: string[] = [];
  private active = new Map<string, { run: Run; ctl: AbortController; key: string }>();
  private busyKeys = new Set<string>();
  private waiters = new Map<string, ((r: Run) => void)[]>();
  maxParallel = Number(process.env.TEAMBOT_MAX_PARALLEL || 8);

  constructor(private getCtx: () => Ctx, private exec: Exec) {}

  private key(r: Run) {
    return `${r.thread_id}:${r.agent_id}`;
  }

  private emit(r: Run) {
    const ctx = this.getCtx();
    const t = ctx.store.thread(r.thread_id);
    for (const uid of ctx.chat.audience(t, r.user_id)) ctx.events.emit(uid, 'run.updated', r);
  }

  enqueue(o: { threadId: string; agentId: string; userId: string; trigger?: string; inputMessageId?: string | null; meta?: Record<string, any> }): Run {
    const ctx = this.getCtx();
    const run = ctx.store.createRun({ thread_id: o.threadId, agent_id: o.agentId, user_id: o.userId, trigger: o.trigger || 'user', input_message_id: o.inputMessageId ?? null, meta: o.meta || {} });
    this.queue.push(run.id);
    this.emit(run);
    queueMicrotask(() => this.pump());
    return run;
  }

  private pump() {
    const ctx = this.getCtx();
    for (let i = 0; i < this.queue.length && this.active.size < this.maxParallel; ) {
      const id = this.queue[i];
      const run = ctx.store.run(id);
      if (!run || run.status !== 'queued') {
        this.queue.splice(i, 1);
        continue;
      }
      const key = this.key(run);
      if (this.busyKeys.has(key)) {
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      this.start(run, key);
    }
  }

  private start(run: Run, key: string) {
    const ctx = this.getCtx();
    const ctl = new AbortController();
    this.busyKeys.add(key);
    const r = ctx.store.updateRun(run.id, { status: 'running', started_at: now() });
    this.active.set(run.id, { run: r, ctl, key });
    this.emit(r);
    // A new turn of this bot here: an approval still open from before a restart can no longer resume anything.
    try {
      ctx.broker.supersedeInterrupted(r.thread_id, r.agent_id, r.id);
    } catch (e) {
      ctx.log.error('[runs] supersede interrupted approvals', e);
    }
    this.exec(r, ctl.signal)
      .then(() => {
        const cur = ctx.store.run(run.id);
        if (cur && !TERMINAL.has(cur.status)) ctx.store.updateRun(run.id, { status: ctl.signal.aborted ? 'cancelled' : 'done', finished_at: now() });
      })
      .catch((e: any) => {
        const aborted = ctl.signal.aborted;
        const msg = aborted ? String(ctl.signal.reason?.message || ctl.signal.reason || 'Gestopt') : String(e?.message || e);
        // The daily budget is a limit, not a failure (agent/budget.ts): the run says so in meta.budget, so the bot's
        // face, the sidebar and the notifications say "daglimiet bereikt" instead of "er ging iets mis".
        const budget = !aborted && isBudgetError(e) ? e.budget : null;
        if (!aborted && !budget) ctx.log.warn(`[run ${run.id}]`, msg);
        const cur = budget ? ctx.store.run(run.id) : null;
        ctx.store.updateRun(run.id, { status: aborted ? 'cancelled' : 'error', error: msg.slice(0, 2000), finished_at: now(), ...(budget ? { meta: { ...(cur?.meta || {}), budget } } : {}) });
        if (!aborted) this.surfaceError(run, msg, budget);
      })
      .finally(() => {
        this.active.delete(run.id);
        this.busyKeys.delete(key);
        // The conversation (or its bot) was deleted while the run was busy: its row is gone. Whoever waits for it
        // still hears that it is over, and the next queued run still starts.
        // The run is over: an approval or question it left open can no longer be answered into anything.
        try {
          ctx.broker.expireForRun(run.id);
        } catch (e) {
          ctx.log.error('[runs] expire approvals of ended run', e);
        }
        const row = ctx.store.run(run.id);
        const fin = row || { ...r, status: 'cancelled' as const, finished_at: now() };
        if (row) this.emit(row);
        for (const w of this.waiters.get(run.id) || []) w(fin);
        this.waiters.delete(run.id);
        this.pump();
      });
  }

  /**
   * A run that fails before the bot produced a message (no provider, key unreadable, budget reached, ...) must not
   * fail silently: show the error in the chat as a message from the bot, with the usual "Opnieuw proberen".
   */
  private surfaceError(run: Run, error: string, budget?: BudgetStop | null) {
    const ctx = this.getCtx();
    try {
      // A run stopped by the daily budget after it had done steps says so too, below what it did (midRun).
      const has = ctx.store.one<any>("SELECT id FROM messages WHERE run_id = ? AND role = 'assistant' LIMIT 1", run.id);
      if (has && !budget) return;
      const thread = ctx.store.thread(run.thread_id);
      const agent = ctx.store.agent(run.agent_id);
      if (!thread) return;
      const parts = budget ? { error: error.slice(0, 2000), budget } : { error: redact(plainEngineError(error)).slice(0, 2000), errorDetail: crashDetail(error) ? redact(crashDetail(error)!) : undefined };
      const m = ctx.store.createMessage({ thread_id: thread.id, role: 'assistant', author_type: 'agent', author_id: run.agent_id, author_name: agent?.name || 'Bot', run_id: run.id, content: '', status: 'error', parts });
      ctx.chat.emitMessage(thread, m);
    } catch (e) {
      ctx.log.error('[runs] could not surface error', e);
    }
  }

  cancel(runId: string, reason = 'Gestopt door gebruiker'): boolean {
    const ctx = this.getCtx();
    const a = this.active.get(runId);
    if (a) {
      a.ctl.abort(new Error(reason));
      return true;
    }
    const r = ctx.store.run(runId);
    if (r && r.status === 'queued') {
      const fin = ctx.store.updateRun(runId, { status: 'cancelled', error: reason, finished_at: now() });
      this.queue = this.queue.filter((x) => x !== runId);
      this.emit(fin);
      for (const w of this.waiters.get(runId) || []) w(fin);
      this.waiters.delete(runId);
      return true;
    }
    return false;
  }

  cancelThread(threadId: string, agentId?: string, reason?: string): number {
    const ctx = this.getCtx();
    let n = 0;
    for (const r of ctx.store.all<any>("SELECT id, agent_id FROM runs WHERE thread_id = ? AND status IN ('queued','running','waiting')", threadId)) {
      if (agentId && r.agent_id !== agentId) continue;
      if (this.cancel(r.id, reason)) n++;
    }
    return n;
  }

  /** The big red button: stop every run of a user (incl. queued). */
  stopAll(userId: string): number {
    const ctx = this.getCtx();
    let n = 0;
    for (const r of ctx.store.all<any>("SELECT id FROM runs WHERE user_id = ? AND status IN ('queued','running','waiting')", userId)) if (this.cancel(r.id, 'Alles gestopt')) n++;
    return n;
  }

  waitFor(runId: string, timeoutMs = 0): Promise<Run> {
    const ctx = this.getCtx();
    const r = ctx.store.run(runId);
    if (r && TERMINAL.has(r.status)) return Promise.resolve(r);
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const done = (run: Run) => {
        if (timer) clearTimeout(timer);
        resolve(run);
      };
      const list = this.waiters.get(runId) || [];
      list.push(done);
      this.waiters.set(runId, list);
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const l = this.waiters.get(runId);
          if (l) this.waiters.set(runId, l.filter((f) => f !== done));
          reject(new Error('Time-out bij wachten op taak'));
        }, timeoutMs);
        timer.unref?.();
      }
    });
  }

  activeRuns(userId?: string): Run[] {
    const ctx = this.getCtx();
    const rows = ctx.store.runsByStatus(['queued', 'running', 'waiting']);
    return userId ? rows.filter((r) => r.user_id === userId) : rows;
  }

  isBusy(threadId: string, agentId: string) {
    return this.busyKeys.has(`${threadId}:${agentId}`);
  }

  /**
   * After a restart: re-queue queued runs; mark in-flight runs interrupted (never auto-repeat side effects). An approval
   * or question the run was waiting for stays open (Broker.expireStale ran first and marked it `interrupted_at`):
   * deciding it resumes the run.
   */
  recover() {
    const ctx = this.getCtx();
    for (const r of ctx.store.runsByStatus(['running', 'waiting'])) {
      ctx.store.updateRun(r.id, { status: 'interrupted', error: 'Onderbroken doordat de app werd afgesloten of herstart', finished_at: now() });
      const t = ctx.store.thread(r.thread_id);
      if (t) {
        // parts.interrupted: the chat says "Onderbroken door een herstart" instead of "Gestopt" (nobody pressed stop).
        ctx.store.exec("UPDATE messages SET status = 'cancelled', parts = json_set(parts, '$.interrupted', json('true')) WHERE run_id = ? AND status = 'streaming'", r.id);
        const open = ctx.store.one<{ id: string; kind: string }>("SELECT id, kind FROM approvals WHERE run_id = ? AND status = 'pending' AND interrupted_at IS NOT NULL ORDER BY created_at DESC LIMIT 1", r.id);
        const name = ctx.store.agent(r.agent_id)?.name || 'De bot';
        const text = !open
          ? 'Een taak werd onderbroken door een herstart. Klik op “Hervatten” om verder te gaan.'
          : open.kind === 'question'
            ? `Een taak werd onderbroken door een herstart. De vraag van ${name} staat nog open: je antwoord gaat mee als ${name} verdergaat.`
            : `Een taak werd onderbroken door een herstart. De goedkeuring staat nog open: als je toestaat, gaat ${name} verder.`;
        ctx.chat.addEvent(t, text, { kind: 'interrupted', runId: r.id, agentId: r.agent_id, ...(open ? { approvalId: open.id } : {}) });
      }
    }
    for (const r of ctx.store.runsByStatus(['queued'])) this.queue.push(r.id);
    this.pump();
  }
}
