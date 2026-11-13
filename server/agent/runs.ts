import { AsyncLocalStorage } from 'node:async_hooks';
import { redact } from '../core/secrets.js';
import type { Ctx, Run } from '../core/types.js';
import { now } from '../core/db.js';
import { crashDetail, plainEngineError } from './fallback.js';
import { isBudgetError, type BudgetStop } from './budget.js';

type Exec = (run: Run, signal: AbortSignal) => Promise<void>;

/** A run in one of these states is over. */
export const TERMINAL = new Set(['done', 'error', 'cancelled', 'interrupted']);

/**
 * Cancel reasons of a person who stopped the work by hand: the stop button of a chat or a run, "Alles stoppen", the
 * stop on a subtask, /stop in a chat app, the emergency stop of the screen and a routine run cancelled by hand.
 * Not: a time-out, a limit, a new message that interrupts, a restart, a deleted bot. Not a group that was stopped or a
 * bot paused in it either: a group stays paused until the owner resumes it, and then goes on (modules/rooms).
 */
const OWNER_STOP = /^(Gestopt door gebruiker|Alles gestopt|Subtaak gestopt door |Gestopt via |Noodstop|Geannuleerd door gebruiker)/;

/**
 * The one place that says "the owner stopped this": a run (or the work a bot gave another bot: same fields) that
 * ended as stopped with one of his own stop reasons. RunManager.cancel writes it down, RunManager.ownerStopped asks it
 * for a bot. Nothing starts by itself because of such a stop: no follow-up turn for the bot that gave the work, no
 * next bot message, no pick-up by the work loop, no check-in, no restart of the work after TeamBot was closed.
 * Whoever gave the work finds a note and reads it at its next turn (modules/rooms/orchestration.ts).
 */
export function stoppedByOwner(r: { status?: string | null; error?: string | null } | null | undefined): boolean {
  return !!r && r.status === 'cancelled' && OWNER_STOP.test(r.error || '');
}

/** Why a run was cancelled, as RunManager.cancel gave it. */
const stopReason = (signal: AbortSignal) => String(signal.reason?.message || signal.reason || 'Gestopt').slice(0, 2000);

/** A working run tells the browser it is alive at most this often. */
export const ALIVE_EVERY_MS = 10_000;
/** A CLI process that ended while its run goes on: said after this long (a normal end closes the run well within it). */
export const GONE_GRACE_MS = 5_000;

/** The `run.alive` event: a sign of life of a run that is busy. Times are the server's clock, in ms. */
export interface RunAlive {
  runId: string;
  threadId: string;
  agentId: string;
  /** When the run last really did something: a chunk from the model, a tool starting or answering, output of the CLI. */
  lastActivityAt: number;
  /** When this event was made; `at - lastActivityAt` is the silence, whatever the clock of the browser says. */
  at: number;
  /** What it is doing, when known (the current tool or step). */
  doing?: string;
  /** CLI engines only: whether the engine's process still exists. */
  process?: 'alive' | 'gone';
}

interface Beat {
  threadId: string;
  agentId: string;
  lastActivityAt: number;
  lastEmit: number;
  doing?: string;
  /** Live processes of a CLI engine (null: none was ever started, e.g. an API engine). */
  procs: number | null;
  goneSince: number;
  goneSent: boolean;
}

/**
 * The sign of life of the runs that are busy, in memory only: every real activity moves `lastActivityAt`, and the
 * owner's browser hears it at most every ALIVE_EVERY_MS (also when nothing happened, so silence is a fact, not a guess).
 */
export class RunPulse {
  private beats = new Map<string, Beat>();
  private timer: NodeJS.Timeout | null = null;
  private every: number;
  private grace: number;
  private clock: () => number;
  constructor(
    private send: (a: RunAlive) => void,
    private o: { everyMs?: number; goneGraceMs?: number; clock?: () => number; /** The run's status now; while it waits for the owner nothing is sent. */ status?: (runId: string) => string | undefined; /** false: no timer, the caller calls tick() (tests). */ timers?: boolean } = {},
  ) {
    this.every = o.everyMs ?? ALIVE_EVERY_MS;
    this.grace = o.goneGraceMs ?? GONE_GRACE_MS;
    this.clock = o.clock ?? Date.now;
  }

  begin(run: Pick<Run, 'id' | 'thread_id' | 'agent_id'>) {
    const t = this.clock();
    this.beats.set(run.id, { threadId: run.thread_id, agentId: run.agent_id, lastActivityAt: t, lastEmit: t, procs: null, goneSince: 0, goneSent: false });
    if (!this.timer && this.o.timers !== false) {
      this.timer = setInterval(() => this.tick(), 1000);
      this.timer.unref?.();
    }
  }

  end(runId: string) {
    this.beats.delete(runId);
    if (!this.beats.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Something real happened in this run. `doing`: what it does now ('' = nothing in particular any more). */
  touch(runId: string, doing?: string) {
    const b = this.beats.get(runId);
    if (!b) return;
    const t = this.clock();
    b.lastActivityAt = t;
    if (doing !== undefined) b.doing = doing.replace(/\s+/g, ' ').trim().slice(0, 120) || undefined;
    if (t - b.lastEmit >= this.every) this.emit(runId, b, t);
  }

  /** A process of the run's CLI engine started (true) or ended (false). */
  proc(runId: string, alive: boolean) {
    const b = this.beats.get(runId);
    if (!b) return;
    const t = this.clock();
    b.lastActivityAt = t;
    b.procs = Math.max(0, (b.procs ?? 0) + (alive ? 1 : -1));
    if (b.procs === 0) b.goneSince = t;
    else if (b.goneSent) {
      // A new process after "gone" was said (the engine started again): take the warning back at once.
      b.goneSent = false;
      this.emit(runId, b, t);
    }
  }

  /** Send what is due (the timer calls this every second; it costs nothing while nothing is due). */
  tick() {
    const t = this.clock();
    for (const [id, b] of this.beats) {
      const gone = b.procs === 0 && !b.goneSent && t - b.goneSince >= this.grace;
      if (!gone && t - b.lastEmit < this.every) continue;
      // Waiting for the owner (an approval, a question) is not silence: the clock starts again when the run goes on.
      if (this.o.status?.(id) === 'waiting') {
        b.lastActivityAt = t;
        b.lastEmit = t;
        continue;
      }
      if (gone) b.goneSent = true;
      this.emit(id, b, t);
    }
  }

  info(runId: string): RunAlive | null {
    const b = this.beats.get(runId);
    return b ? this.view(runId, b, this.clock()) : null;
  }

  private view(runId: string, b: Beat, at: number): RunAlive {
    return { runId, threadId: b.threadId, agentId: b.agentId, lastActivityAt: b.lastActivityAt, at, ...(b.doing ? { doing: b.doing } : {}), ...(b.procs === null ? {} : { process: b.procs > 0 ? ('alive' as const) : ('gone' as const) }) };
  }

  private emit(runId: string, b: Beat, t: number) {
    b.lastEmit = t;
    try {
      this.send(this.view(runId, b, t));
    } catch {
      /* a sign of life never breaks the run */
    }
  }
}

/**
 * The run whose engine is being started in this async context (agent/cli-loop.ts sets it), so the code that reads the
 * CLI's output (modules/cli-agents/proc.ts) can report bytes and the life of the process without knowing the run.
 */
export const cliRunScope = new AsyncLocalStorage<{ runId: string; pulse: RunPulse }>();

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
  // How many bots work at the same time. 8 made a team of 13 bots plus routines wait for each other; 32 is what an
  // ordinary pc carries in CLI processes. The rest waits in the queue (never dropped). TEAMBOT_MAX_PARALLEL overrides.
  maxParallel = Number(process.env.TEAMBOT_MAX_PARALLEL || 32);

  /** The sign of life of every busy run (`run.alive`, in memory): see RunPulse. */
  readonly pulse: RunPulse;

  constructor(private getCtx: () => Ctx, private exec: Exec) {
    this.pulse = new RunPulse(
      (a) => {
        const ctx = this.getCtx();
        const t = ctx.store.thread(a.threadId);
        const run = ctx.store.run(a.runId);
        // What the bot is doing is the owner's to see; others in a group only hear that it is alive.
        for (const uid of ctx.chat.audience(t, run?.user_id)) ctx.events.emit(uid, 'run.alive', uid === (t?.user_id ?? run?.user_id) ? a : { ...a, doing: undefined });
      },
      { status: (id) => this.getCtx().store.run(id)?.status },
    );
  }

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
    this.pulse.begin(r);
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
        // (Stopped right as it ended: still stopped, with the reason, so what follows knows who stopped it.)
        if (cur && !TERMINAL.has(cur.status)) ctx.store.updateRun(run.id, ctl.signal.aborted ? { status: 'cancelled', error: stopReason(ctl.signal), finished_at: now() } : { status: 'done', finished_at: now() });
      })
      .catch((e: any) => {
        const aborted = ctl.signal.aborted;
        const msg = aborted ? stopReason(ctl.signal) : String(e?.message || e);
        // The daily budget is a limit, not a failure (agent/budget.ts): the run says so in meta.budget, so the bot's
        // face, the sidebar and the notifications say "daglimiet bereikt" instead of "er ging iets mis".
        const budget = !aborted && isBudgetError(e) ? e.budget : null;
        if (!aborted && !budget) ctx.log.warn(`[run ${run.id}]`, msg);
        const cur = budget ? ctx.store.run(run.id) : null;
        ctx.store.updateRun(run.id, { status: aborted ? 'cancelled' : 'error', error: msg.slice(0, 2000), finished_at: now(), ...(budget ? { meta: { ...(cur?.meta || {}), budget } } : {}) });
        if (!aborted) this.surfaceError(run, msg, budget);
      })
      .finally(() => {
        this.pulse.end(run.id);
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
      // The owner's own stop is written down at once: the run itself needs a moment to wind down, and when TeamBot is
      // closed in that moment the run is still his stop after the restart (recover), not an interruption that
      // TeamBot picks up again by itself.
      if (OWNER_STOP.test(reason) && !a.ctl.signal.aborted) {
        const cur = ctx.store.run(runId);
        if (cur) ctx.store.updateRun(runId, { meta: { ...(cur.meta || {}), ownerStop: reason } });
      }
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

  /**
   * The big red button: stop every run of a user (incl. queued), and then what waits to start by itself in a part's
   * own queue (hooks.stopAll), so nothing from before the stop starts later.
   */
  stopAll(userId: string): number {
    const ctx = this.getCtx();
    let n = 0;
    for (const r of ctx.store.all<any>("SELECT id FROM runs WHERE user_id = ? AND status IN ('queued','running','waiting')", userId)) if (this.cancel(r.id, 'Alles gestopt')) n++;
    for (const h of ctx.hooks.stopAll || []) {
      try {
        h({ userId });
      } catch (e) {
        ctx.log.warn('[runs] stop-all', String(e));
      }
    }
    return n;
  }

  /**
   * Did the owner stop this bot by hand, and has it not had a turn since? When (ms), or null. Every part of TeamBot
   * that starts a turn by itself to go on with earlier work asks this first and then does not start: the work loop,
   * the main bot's check-in, answers and bot messages that were waiting for the bot. The bot goes on at its next
   * turn: the owner writes or presses "Hervatten", a routine fires at its time, or a colleague gives it new work.
   */
  ownerStopped(agentId: string): number | null {
    const last = this.getCtx().store.one<{ status: string; error: string | null; finished_at: string | null; created_at: string }>('SELECT status, error, finished_at, created_at FROM runs WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', agentId);
    return stoppedByOwner(last) ? Date.parse(last!.finished_at || last!.created_at) || 0 : null;
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
      // The owner had pressed stop and TeamBot was closed before the run had wound down (cancel wrote it down): it
      // is his stop, so nothing offers or starts it again as "onderbroken door een herstart".
      if (typeof r.meta?.ownerStop === 'string' && OWNER_STOP.test(r.meta.ownerStop)) {
        ctx.store.updateRun(r.id, { status: 'cancelled', error: r.meta.ownerStop, finished_at: now() });
        ctx.store.exec("UPDATE messages SET status = 'cancelled' WHERE run_id = ? AND status = 'streaming'", r.id);
        ctx.broker.expireForRun(r.id);
        continue;
      }
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
