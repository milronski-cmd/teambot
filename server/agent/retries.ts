/**
 * Work that goes on later by itself: a message answered again when the engine's usage limit is over, and important
 * work that pauses until an engine within its level is free. The timers live in memory and are armed again after a
 * restart (the moment itself is on the run: meta.limitRetryAt).
 */
import type { Agent, Ctx, Run, Thread } from '../core/types.js';
import { now } from '../core/db.js';
import { userLocale } from '../core/i18n.js';
import { hideAttempt } from './attempts.js';
import type { Active, Engines } from './engines.js';
import { clockTime, DEFAULT_LIMIT_WAIT_MS, LEVEL_TEXT, MAX_LIMIT_RETRIES, MAX_PAUSES, pauseUntil, retryAt, type WorkFlags } from './fallback.js';
import { userTz } from './prompt.js';

export class Retries {
  private retryTimers = new Map<string, NodeJS.Timeout>();
  constructor(
    private getCtx: () => Ctx,
    private engines: Engines,
  ) {}

  /**
   * Important work that cannot go on within its minimum level: the failed attempt goes, a calm pause card says why and
   * when it goes on, the owner gets a notification (also on the phone), and at the reset the same message is answered
   * again by itself (a routine run waits in the routine instead). The run ends as paused (meta.paused), not as failed.
   */
  async pauseWork(run: Run, agent: Agent, thread: Thread, o: { why: string; kind: 'limit' | 'outage'; chain: Active[]; failed?: Active; resetAt: number | null; messageId?: string; flags: WorkFlags }) {
    const ctx = this.getCtx();
    const tz = userTz(ctx, thread.user_id);
    const cur = ctx.store.run(run.id) || run;
    const imp = o.flags.important || { kind: 'run' as const };
    if (o.messageId) hideAttempt(ctx, thread, o.messageId);
    const count = Number(cur.meta?.pauseCount || 0);
    if (count >= MAX_PAUSES) {
      const text = `${o.why}. Dit belangrijke werk is al ${count}× gepauzeerd en gaat niet meer vanzelf verder; stuur een bericht om het opnieuw te proberen.`;
      ctx.chat.addEvent(thread, text, { kind: 'limit_wait' });
      ctx.store.updateRun(run.id, { status: 'error', error: text, finished_at: now() });
      return;
    }
    // The earliest moment an engine within the level is expected to be free again: a reset the engine gave, else
    // TeamBot's own guess (30 minutes; also for an outage).
    const t0 = Date.now();
    const cands: { at: number; known: boolean }[] = [];
    if (o.resetAt && o.resetAt > t0) cands.push({ at: o.resetAt, known: true });
    if (o.kind === 'outage' || !o.resetAt) cands.push({ at: t0 + DEFAULT_LIMIT_WAIT_MS, known: false });
    for (const x of o.chain) {
      if (!this.engines.allowed(x, o.flags, o.chain[0])) continue;
      const l = this.engines.limited.get(x.cfg.id);
      if (l && l.until > t0) cands.push({ at: l.until, known: !!l.known });
      // A free source the catalogue says waits until then (its availableAt).
      if (x.wait && x.wait.until > t0) cands.push({ at: x.wait.until, known: x.wait.known });
    }
    const first = cands.sort((a, b) => a.at - b.at)[0];
    const { at, known: sure } = first.known ? pauseUntil(first.at, t0) : { at: Math.max(first.at, t0 + 60_000), known: false };
    const time = clockTime(at, tz);
    const level = LEVEL_TEXT[o.flags.minLevel];
    const what = imp.title ? ` (“${imp.title}”)` : '';
    const routineId = typeof cur.meta?.routine?.id === 'string' ? cur.meta.routine.id : null;
    const text = sure
      ? `Belangrijk werk gepauzeerd${what}: ${o.why}, en een ander model op het niveau ${level} is er nu niet. ${agent.name} gaat rond ${time} vanzelf verder.`
      : `Belangrijk werk gepauzeerd${what}: ${o.why}, en een ander model op het niveau ${level} is er nu niet. Nog niet bekend wanneer het weer kan; ${agent.name} probeert het rond ${time} opnieuw.`;
    const until = new Date(at).toISOString();
    const ev = ctx.chat.addEvent(thread, text, {
      kind: 'work_paused',
      pause: { runId: run.id, agentId: agent.id, inputMessageId: run.input_message_id, until, known: sure, reason: o.why, level: o.flags.minLevel, title: imp.title || null, important: imp.kind, routineId, state: 'waiting' },
    });
    const meta = { ...(cur.meta || {}), important: imp, paused: { until, known: sure, reason: o.why, level: o.flags.minLevel, eventId: ev.id, at: now() }, ...(routineId ? {} : { limitRetryAt: until }) };
    ctx.store.updateRun(run.id, { status: 'error', error: text.slice(0, 2000), finished_at: now(), meta });
    // Whole sentences, so the page and a push translate each one; the time in the reader's own words.
    const clock = clockTime(at, tz, userLocale(ctx.store, run.user_id));
    ctx.events.emit(run.user_id, 'notification', {
      title: 'Belangrijk werk gepauzeerd',
      body: sure ? `${o.why}. ${agent.name} gaat rond ${clock} vanzelf verder.` : `${o.why}. ${agent.name} probeert het rond ${clock} opnieuw.`,
      link: `#/t/${thread.id}`,
      kind: 'pause',
      level: 'important',
      agentId: agent.id,
    });
    ctx.audit(run.user_id, 'agent.paused', { reason: o.why.slice(0, 300), until, level: o.flags.minLevel, important: imp.kind, engine: o.failed?.cfg.id }, agent.id);
    if (!routineId) this.armRetry(run.id, at);
  }

  /**
   * A new run for a message whose important work was paused (the resume itself, a routine trying again, the owner's
   * "Opnieuw proberen"): the pause card says it went on, and a resume still scheduled for that message is dropped.
   */
  resumedPause(run: Run, thread: Thread, agentId: string) {
    // (a new message has no pause yet: only a run for an earlier message can resume one)
    if (!run.input_message_id || run.trigger === 'user' || run.trigger === 'channel') return;
    const ctx = this.getCtx();
    try {
      for (const r of ctx.store.all<{ id: string }>(
        "SELECT id FROM runs WHERE thread_id = ? AND agent_id = ? AND input_message_id = ? AND id != ? AND json_extract(meta, '$.paused') IS NOT NULL AND json_extract(meta, '$.limitRetryAt') IS NOT NULL AND json_extract(meta, '$.limitRetried') IS NULL",
        thread.id,
        agentId,
        run.input_message_id,
        run.id,
      ))
        this.cancelLimitRetry(r.id);
      const cards = ctx.store.all<{ id: string }>(
        "SELECT id FROM messages WHERE thread_id = ? AND role = 'event' AND json_extract(parts, '$.kind') = 'work_paused' AND json_extract(parts, '$.pause.state') = 'waiting' AND json_extract(parts, '$.pause.agentId') = ? AND json_extract(parts, '$.pause.inputMessageId') = ?",
        thread.id,
        agentId,
        run.input_message_id,
      );
      for (const c of cards) {
        const m = ctx.store.message(c.id);
        if (m?.parts?.pause) ctx.chat.emitMessage(thread, ctx.store.updateMessage(m.id, { parts: { ...m.parts, pause: { ...m.parts.pause, state: 'resumed', doneAt: now() } } }), 'message.updated');
      }
    } catch (e: any) {
      ctx.log.warn('[chain] resume card', e?.message);
    }
  }

  /** When the bot tries a message at its limit again by itself (null: it does not; no message, or tried 3× already). */
  plannedRetry(run: Run, resetAt: number | null): number | null {
    if (!run.input_message_id || Number(run.meta?.limitRetries || 0) >= MAX_LIMIT_RETRIES) return null;
    return retryAt(resetAt);
  }

  /** "Wacht tot de limiet voorbij is en probeer opnieuw": a new run for the same message at the reset (max 3×). */
  scheduleLimitRetry(run: Run, agent: Agent, thread: Thread, resetAt: number | null, why: string, tz: string, planned?: number): boolean {
    const ctx = this.getCtx();
    const n = Number(run.meta?.limitRetries || 0);
    if (!run.input_message_id) return false;
    if (n >= MAX_LIMIT_RETRIES) {
      ctx.chat.addEvent(thread, `${why}. Er is al ${n}× opnieuw geprobeerd; stuur een bericht om het zelf nog eens te proberen.`, { kind: 'limit_wait' });
      return false;
    }
    const at = planned ?? retryAt(resetAt);
    ctx.store.updateRun(run.id, { meta: { ...ctx.store.run(run.id)!.meta, limitRetryAt: new Date(at).toISOString() } });
    // Without a known reset the retry time is TeamBot's own guess: say so, in the words of the notification.
    const time = clockTime(at, tz);
    const said = resetAt
      ? `${why}. ${agent.name} probeert het rond ${time} automatisch opnieuw.`
      : `${why}. Nog niet bekend wanneer het weer kan. ${agent.name} probeert het rond ${time} automatisch opnieuw.`;
    ctx.chat.addEvent(thread, said, { kind: 'limit_wait' });
    this.armRetry(run.id, at);
    return true;
  }

  /** Stop a scheduled "probeert het rond … opnieuw" (the owner chose another engine for that message). */
  cancelLimitRetry(runId: string) {
    clearTimeout(this.retryTimers.get(runId));
    this.retryTimers.delete(runId);
    const ctx = this.getCtx();
    const r = ctx.store.run(runId);
    if (r?.meta?.limitRetryAt && !r.meta.limitRetried) ctx.store.updateRun(r.id, { meta: { ...r.meta, limitRetried: true } });
  }

  /**
   * "Alles stoppen": what was planned to go on by itself does not (a message that would be tried again after its
   * limit, important work that would resume). The chat had said it would: the pause card now says it will not (as
   * after "Niet hervatten"), a planned retry gets one line. Returns how many were dropped.
   */
  stopPlanned(userId: string): number {
    const ctx = this.getCtx();
    let n = 0;
    for (const id of [...this.retryTimers.keys()]) {
      const r = ctx.store.run(id);
      if (!r || r.user_id !== userId || r.meta?.limitRetried) continue;
      this.cancelLimitRetry(id);
      n++;
      const thread = ctx.store.thread(r.thread_id);
      if (!thread) continue;
      const card = typeof r.meta?.paused?.eventId === 'string' ? ctx.store.message(r.meta.paused.eventId) : null;
      if (card?.parts?.pause) ctx.chat.emitMessage(thread, ctx.store.updateMessage(card.id, { parts: { ...card.parts, pause: { ...card.parts.pause, state: 'cancelled', doneAt: now() } } }), 'message.updated');
      else ctx.chat.addEvent(thread, 'Je hebt alles gestopt: er wordt niet meer vanzelf opnieuw geprobeerd. Stuur een bericht om verder te gaan.', { kind: 'limit_wait' });
    }
    return n;
  }

  armRetry(runId: string, at: number) {
    const ctx = this.getCtx();
    clearTimeout(this.retryTimers.get(runId));
    const t = setTimeout(() => {
      this.retryTimers.delete(runId);
      const r = ctx.store.run(runId);
      if (!r || r.meta?.limitRetried || !r.meta?.limitRetryAt) return;
      ctx.store.updateRun(r.id, { meta: { ...r.meta, limitRetried: true } });
      // Paused important work goes on even when the conversation moved on; it stays important.
      const paused = !!r.meta?.paused;
      // The conversation moved on (a newer run of this bot in this thread): don't answer an old message again.
      if (!paused && ctx.store.one('SELECT 1 FROM runs WHERE thread_id = ? AND agent_id = ? AND created_at > ? AND id != ?', r.thread_id, r.agent_id, r.created_at, r.id)) return;
      if (!ctx.store.agent(r.agent_id) || !ctx.store.thread(r.thread_id)) return;
      const meta = paused
        ? { override: r.meta?.override, important: r.meta?.important || true, resumeOf: r.id, pauseCount: Number(r.meta?.pauseCount || 0) + 1 }
        : { override: r.meta?.override, limitRetryOf: r.id, limitRetries: Number(r.meta?.limitRetries || 0) + 1 };
      ctx.runs.enqueue({ threadId: r.thread_id, agentId: r.agent_id, userId: r.user_id, trigger: 'retry', inputMessageId: r.input_message_id, meta });
    }, Math.max(0, Math.min(at - Date.now(), 2_000_000_000)));
    t.unref?.();
    this.retryTimers.set(runId, t);
  }

  /** After a restart: re-arm limit retries that were still waiting (and paused important work: up to 8 days). */
  resumeLimitRetries() {
    const ctx = this.getCtx();
    const since = new Date(Date.now() - 9 * 86400_000).toISOString();
    for (const r of ctx.store.all<any>("SELECT id, meta FROM runs WHERE created_at > ? AND json_extract(meta, '$.limitRetryAt') IS NOT NULL AND json_extract(meta, '$.limitRetried') IS NULL", since)) {
      const at = Date.parse(JSON.parse(r.meta || '{}').limitRetryAt);
      if (!isNaN(at)) this.armRetry(r.id, at);
    }
  }

  stopRetries() {
    for (const t of this.retryTimers.values()) clearTimeout(t);
    this.retryTimers.clear();
  }

}
