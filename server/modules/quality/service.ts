import type { Agent, Ctx, User } from '../../core/types.js';
import { newId, now } from '../../core/db.js';
import { inspectEvidence, parseEvidence, runSteps, shortSteps } from './evidence.js';
import { gaveUpText, limitNowText, secondLook, UNCLEAR } from './verify.js';
import { maybeSuggestSkill } from './skills.js';
import { CHECK_LABEL, type CheckState, type EvidenceItem, type QualityRow, type QualityView, type StepItem, type TaskKind, type Verdict } from './types.js';

const DONE_WHEN_MAX = 300;
/** A second look that keeps meeting a usage limit is tried this often in all, then the owner checks it himself. */
export const MAX_RECHECKS = 6;
/** Where the owner sees a task of the board (the board opens it) or of the team database. */
export const taskLink = (r: { kind: string; ref: string }) => (r.kind === 'room' ? `#/tasks?open=${encodeURIComponent(`b:${r.ref}`)}` : '#/tasks');

/** "Kon niet: de site was offline" (also "Niet gelukt:", "Lukt niet —"): a delegated bot's honest "could not". */
export const CANT_RE = /^\s*(?:\*\*)?(kon niet|kan niet|niet gelukt|lukt niet|mislukt|could not|couldn'?t|cannot|can'?t do)(?:\*\*)?\s*[:—–-]\s*([\s\S]*)$/i;

export interface ReportInput {
  userId: string;
  kind: TaskKind;
  ref: string;
  title: string;
  description?: string;
  result?: string;
  agent: Agent | null;
  outcome: 'done' | 'cant';
  reason?: string;
  evidence?: any;
  runId?: string | null;
  /** Resolve a relative path in the task's group folder (task board tasks of a group). */
  roomFile?: (rel: string) => string | null;
  /** Evidence attached by the bot is required (task board, team database). */
  requireEvidence?: boolean;
  /** Steps to use instead of the run's own (e.g. a delegated run). */
  steps?: StepItem[];
  /** Evidence TeamBot already has itself (a delegated bot's delivered text). */
  extraEvidence?: EvidenceItem[];
}

/**
 * Quality records for tasks: "klaar als", the atomic claim, what the bot reported and the second look. Shared by the
 * task board (rooms), the team database (teamdata) and delegated subtasks; `ctx.services.quality` is this service.
 */
export class QualityService {
  constructor(public ctx: Ctx) {}

  row(userId: string, kind: TaskKind, ref: string | number): QualityRow | null {
    const r = this.ctx.store.one<any>('SELECT * FROM quality_tasks WHERE user_id = ? AND kind = ? AND ref = ?', userId, kind, String(ref));
    return r ? this.ctx.store.decode<QualityRow>('quality_tasks', r) : null;
  }

  /** The record of a task, created (empty) when it does not exist yet. */
  ensure(userId: string, kind: TaskKind, ref: string | number, title = ''): QualityRow {
    const ts = now();
    this.ctx.store.exec(
      'INSERT OR IGNORE INTO quality_tasks (id, user_id, kind, ref, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      newId('qt_'),
      userId,
      kind,
      String(ref),
      title.slice(0, 200),
      ts,
      ts,
    );
    const r = this.row(userId, kind, ref)!;
    if (title && r.title !== title.slice(0, 200)) this.patch(r, { title: title.slice(0, 200) });
    return this.row(userId, kind, ref)!;
  }

  private patch(r: QualityRow, p: Record<string, any>) {
    this.ctx.store.update('quality_tasks', r.id, { ...p, updated_at: now() });
  }

  private emit(userId: string, kind: TaskKind, ref: string) {
    this.ctx.events.emit(userId, 'quality.changed', { kind, ref });
  }

  remove(userId: string, kind: TaskKind, ref: string | number) {
    this.ctx.store.exec('DELETE FROM quality_tasks WHERE user_id = ? AND kind = ? AND ref = ?', userId, kind, String(ref));
    this.emit(userId, kind, String(ref));
  }

  private agentName(id: string | null | undefined) {
    return (id && this.ctx.store.agent(id)?.name) || 'Onbekende bot';
  }

  view(r: QualityRow | null): QualityView {
    const state: CheckState = r?.check_state || 'none';
    return {
      doneWhen: r?.done_when || '',
      doneWhenBy: r?.done_when_by || null,
      skipCheck: !!r?.skip_check,
      claim: r?.claimed_by ? { agentId: r.claimed_by, name: this.agentName(r.claimed_by), at: r.claimed_at || r.updated_at } : null,
      outcome: r?.outcome || null,
      outcomeReason: r?.outcome_reason || '',
      reportedBy: r?.reported_by ? { agentId: r.reported_by, name: this.agentName(r.reported_by), at: r.reported_at || r.updated_at } : null,
      evidence: r?.evidence || [],
      check: { state, label: CHECK_LABEL[state], reason: r?.check_reason || '', engine: r?.check_engine || '', at: r?.checked_at || null },
      open: !!r?.open,
    };
  }

  viewFor(userId: string, kind: TaskKind, ref: string | number): QualityView {
    return this.view(this.row(userId, kind, ref));
  }

  /**
   * "Klaar als": one short, checkable sentence. The bot proposes it; once the owner set it, a bot can no longer
   * change it (returns an error text).
   */
  setDoneWhen(userId: string, kind: TaskKind, ref: string | number, text: any, by: 'agent' | 'user', title = ''): string | null {
    const v = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, DONE_WHEN_MAX);
    const r = this.ensure(userId, kind, ref, title);
    if (by === 'agent' && r.done_when_by === 'user' && r.done_when && v !== r.done_when) return `De eigenaar heeft "klaar als" voor deze taak vastgezet: ${r.done_when}`;
    this.patch(r, { done_when: v, done_when_by: v ? by : null });
    this.emit(userId, kind, String(ref));
    return null;
  }

  setSkip(userId: string, kind: TaskKind, ref: string | number, skip: boolean, title = '') {
    const r = this.ensure(userId, kind, ref, title);
    this.patch(r, { skip_check: !!skip });
    this.emit(userId, kind, String(ref));
  }

  /**
   * Claim a task for one bot. Atomic: one UPDATE that only succeeds while nobody (or the same bot) holds it, so two
   * bots that try at the same moment never both get it.
   */
  claim(userId: string, kind: TaskKind, ref: string | number, agentId: string, title = ''): { ok: true; already: boolean } | { ok: false; holder: string; holderName: string; since: string } {
    const r = this.ensure(userId, kind, ref, title);
    const ts = now();
    const res = this.ctx.store.exec('UPDATE quality_tasks SET claimed_by = ?, claimed_at = COALESCE(CASE WHEN claimed_by = ? THEN claimed_at END, ?), updated_at = ? WHERE id = ? AND (claimed_by IS NULL OR claimed_by = ?)', agentId, agentId, ts, ts, r.id, agentId);
    if (Number(res.changes) === 1) {
      if (r.claimed_by !== agentId) this.emit(userId, kind, String(ref));
      return { ok: true, already: r.claimed_by === agentId };
    }
    const cur = this.row(userId, kind, ref)!;
    return { ok: false, holder: cur.claimed_by!, holderName: this.agentName(cur.claimed_by), since: cur.claimed_at || cur.updated_at };
  }

  /** Who holds the task (agent id), or null. */
  holder(userId: string, kind: TaskKind, ref: string | number): string | null {
    return this.row(userId, kind, ref)?.claimed_by || null;
  }

  /** Release a claim: by the bot that holds it (agentId), or by the owner (agentId null). */
  release(userId: string, kind: TaskKind, ref: string | number, agentId: string | null = null): boolean {
    const r = this.row(userId, kind, ref);
    if (!r?.claimed_by || (agentId && r.claimed_by !== agentId)) return false;
    this.patch(r, { claimed_by: null, claimed_at: null });
    this.emit(userId, kind, String(ref));
    return true;
  }

  /**
   * A bot reports a task: done (with evidence, then the second look decides) or "kon niet" (with a reason; no check).
   * Returns the verdict and the stored record.
   */
  async report(i: ReportInput): Promise<{ verdict: Verdict; row: QualityRow }> {
    const r = this.ensure(i.userId, i.kind, i.ref, i.title);
    const ts = now();
    const by = i.agent?.id || null;
    if (i.outcome === 'cant') {
      const reason = String(i.reason || i.result || '').replace(/\s+/g, ' ').trim().slice(0, 1000) || 'Geen reden opgegeven.';
      this.patch(r, { outcome: 'cant', outcome_reason: reason, reported_by: by, reported_at: ts, check_state: 'cant', check_reason: reason, check_engine: '', checked_at: ts, open: i.kind !== 'delegation', claimed_by: null, claimed_at: null, recheck_at: null });
      this.ctx.audit(i.userId, 'quality.cant', { kind: i.kind, ref: i.ref, task: i.title.slice(0, 120), reason: reason.slice(0, 300) }, by);
      this.emit(i.userId, i.kind, String(i.ref));
      return { verdict: { state: 'cant', reason }, row: this.row(i.userId, i.kind, i.ref)! };
    }
    const steps = i.steps ?? runSteps(this.ctx, i.runId);
    const evidence = [...(i.extraEvidence || []), ...inspectEvidence(this.ctx, { userId: i.userId, agent: i.agent, values: parseEvidence(i.evidence), steps, roomFile: i.roomFile })];
    const checkOff = i.agent?.settings?.quality?.check === false;
    const looked = await secondLook(this.ctx, {
      userId: i.userId,
      agent: i.agent,
      title: i.title,
      description: i.description,
      doneWhen: r.done_when,
      result: i.result,
      evidence,
      steps,
      skip: r.skip_check || checkOff,
      requireEvidence: i.requireEvidence !== false,
    });
    // A delegated subtask is not checked again later (its result went back to the bot that asked): say so plainly.
    const verdict: Verdict = looked.retryAt && i.kind === 'delegation' ? { ...looked, retryAt: undefined, reason: limitNowText(looked.limit) } : looked;
    const done = verdict.state === 'passed' || verdict.state === 'skipped';
    // The check waits for a limit: what it needs to run again later (evidence and steps are stored anyway).
    const later = verdict.retryAt && i.kind !== 'delegation';
    this.patch(r, {
      recheck_at: later ? new Date(verdict.retryAt!).toISOString() : null,
      recheck_n: 0,
      recheck_input: later ? { result: String(i.result || '').slice(0, 10_000), description: String(i.description || '').slice(0, 2000), requireEvidence: i.requireEvidence !== false } : {},
      outcome: verdict.state === 'cant' ? 'cant' : 'done',
      outcome_reason: verdict.state === 'cant' ? verdict.reason : '',
      reported_by: by,
      reported_at: ts,
      evidence,
      steps: shortSteps(steps),
      check_state: verdict.state,
      check_reason: verdict.reason,
      check_engine: verdict.engine || '',
      check_tokens: verdict.tokens ?? null,
      checked_at: ts,
      open: i.kind !== 'delegation' && !done,
      // Done: the claim ends. "Te controleren": the bot keeps it, so it can fix the work and report again.
      ...(done || verdict.state === 'cant' ? { claimed_by: null, claimed_at: null } : {}),
    });
    this.ctx.audit(i.userId, 'quality.report', { kind: i.kind, ref: i.ref, task: i.title.slice(0, 120), state: verdict.state, evidence: evidence.length }, by);
    this.emit(i.userId, i.kind, String(i.ref));
    if (done && i.agent && i.kind !== 'delegation') {
      try {
        maybeSuggestSkill(this, i.userId, i.agent, i.title);
      } catch (e) {
        this.ctx.log.warn('[quality] skill suggestion', e);
      }
    }
    return { verdict, row: this.row(i.userId, i.kind, i.ref)! };
  }

  /**
   * A delegated subtask came back "done": the same second look, on the worker bot's check engine, with the expected
   * output as "klaar als" and the result text as the delivered work (the steps of its run are the evidence). A result
   * that starts with "Kon niet:" is the honest "could not" and is passed on as such, without a model call.
   */
  async checkDelegation(o: { userId: string; delegationId: string; worker: Agent | null; task: string; expected: string; result: string; runId: string | null }): Promise<Verdict> {
    const title = o.task.replace(/\s+/g, ' ').trim().slice(0, 200) || 'Subtaak';
    if (o.worker?.settings?.quality?.check === false) return { state: 'skipped', reason: 'De controle staat uit voor deze bot.' };
    const cant = o.result.match(CANT_RE);
    if (cant) return (await this.report({ userId: o.userId, kind: 'delegation', ref: o.delegationId, title, agent: o.worker, outcome: 'cant', reason: cant[2].replace(/^\*+\s*/, '') || o.result })).verdict;
    if (o.expected.trim()) this.setDoneWhen(o.userId, 'delegation', o.delegationId, o.expected, 'agent', title);
    const steps = runSteps(this.ctx, o.runId);
    if (!o.result.trim() && !steps.some((s) => s.ok)) {
      const r = this.ensure(o.userId, 'delegation', o.delegationId, title);
      const verdict: Verdict = { state: 'review', reason: 'Geen resultaat en geen gelukte stappen.' };
      this.patch(r, { outcome: 'done', reported_by: o.worker?.id || null, reported_at: now(), check_state: verdict.state, check_reason: verdict.reason, checked_at: now() });
      return verdict;
    }
    const delivered: EvidenceItem = { type: 'text', value: o.result.slice(0, 600), ok: true, note: 'het geleverde resultaat zelf', excerpt: o.result.slice(0, 1500) };
    return (await this.report({ userId: o.userId, kind: 'delegation', ref: o.delegationId, title, description: o.task, result: o.result, agent: o.worker, outcome: 'done', steps, requireEvidence: false, extraEvidence: o.result.trim() ? [delivered] : [] })).verdict;
  }

  /**
   * The owner decided about a task himself: approved it (done), or changed its status otherwise. Either way it no
   * longer waits for him.
   */
  ownerDecided(userId: string, kind: TaskKind, ref: string | number, done: boolean) {
    const r = this.row(userId, kind, ref);
    if (!r) return;
    const p: Record<string, any> = { open: false, recheck_at: null };
    if (done) Object.assign(p, { check_state: 'owner', check_reason: 'Goedgekeurd door de eigenaar.', checked_at: now(), claimed_by: null, claimed_at: null });
    this.patch(r, p);
    this.emit(userId, kind, String(ref));
  }

  /** Back to work: the owner says it is not done. The check result is cleared; the claim stays with the bot. */
  reopen(userId: string, kind: TaskKind, ref: string | number) {
    const r = this.row(userId, kind, ref);
    if (!r) return;
    this.patch(r, { open: false, check_state: 'none', check_reason: '', outcome: null, outcome_reason: '', recheck_at: null });
    this.emit(userId, kind, String(ref));
  }

  /**
   * Second looks that waited for a usage limit and whose time has come (at most `max` per call, one at a time): each
   * runs again on the same rules; still at the limit → later again (at most MAX_RECHECKS tries), else the outcome
   * goes to the task (the board's or the team database's own handler in `ctx.services.qualityRechecked`) and the
   * owner gets a notification. Returns how many ran.
   */
  async recheckDue(nowMs = Date.now(), max = 5): Promise<number> {
    if (this.rechecking) return 0;
    this.rechecking = true;
    try {
      const due = this.ctx.store
        .all<any>("SELECT * FROM quality_tasks WHERE recheck_at IS NOT NULL AND recheck_at <= ? AND check_state = 'review' AND open = 1 AND kind IN ('room','teamdata') ORDER BY recheck_at LIMIT ?", new Date(nowMs).toISOString(), max)
        .map((x) => this.ctx.store.decode<QualityRow>('quality_tasks', x));
      for (const r of due) {
        try {
          await this.recheck(r);
        } catch (e: any) {
          this.ctx.log.warn('[quality] recheck', e?.message || e);
        }
      }
      return due.length;
    } finally {
      this.rechecking = false;
    }
  }
  private rechecking = false;

  /**
   * Tasks that still wait for the owner only because the checker once gave no verdict (before TeamBot tried such a
   * look again by itself): they get their second look now. Returns how many.
   */
  retryUnclear(): number {
    return Number(this.ctx.store.exec("UPDATE quality_tasks SET recheck_at = ?, recheck_n = 0 WHERE check_state = 'review' AND open = 1 AND recheck_at IS NULL AND kind IN ('room','teamdata') AND check_reason = ?", now(), UNCLEAR).changes) || 0;
  }

  /**
   * "Alles stoppen" (the planner's stop): the second looks of this owner that wait for a usage limit are not done by
   * themselves later. The task says so and waits for him. Returns how many were waiting.
   */
  stopRechecks(userId: string): number {
    const rows = this.ctx.store
      .all<any>("SELECT * FROM quality_tasks WHERE user_id = ? AND recheck_at IS NOT NULL AND check_state = 'review' AND open = 1", userId)
      .map((x) => this.ctx.store.decode<QualityRow>('quality_tasks', x));
    for (const r of rows) {
      this.patch(r, { recheck_at: null, check_reason: 'Niet automatisch gecontroleerd: je hebt alles gestopt. Kijk het zelf na.' });
      this.emit(r.user_id, r.kind, r.ref);
    }
    return rows.length;
  }

  private async recheck(r: QualityRow) {
    const agent = r.reported_by ? this.ctx.store.agent(r.reported_by) : null;
    // Taken off the list first: a failure below never makes it run again and again.
    this.patch(r, { recheck_at: null });
    if (!agent || agent.user_id !== r.user_id) {
      this.patch(r, { check_reason: 'Niet automatisch gecontroleerd: de bot die de taak meldde bestaat niet meer. Kijk het zelf na.' });
      this.emit(r.user_id, r.kind, r.ref);
      return;
    }
    const n = (r.recheck_n || 0) + 1;
    // What the bot reported: kept with the waiting look, else what the task on the board itself says.
    const task = r.kind === 'room' && this.ctx.store.hasTable('room_tasks') ? this.ctx.store.one<{ result: string | null; description: string | null }>('SELECT result, description FROM room_tasks WHERE id = ?', r.ref) : null;
    const input = { result: task?.result || '', description: task?.description || '', ...(r.recheck_input || {}) };
    const verdict = await secondLook(this.ctx, {
      userId: r.user_id,
      agent,
      title: r.title,
      description: input.description,
      doneWhen: r.done_when,
      result: input.result,
      evidence: r.evidence || [],
      steps: r.steps || [],
      skip: r.skip_check || agent.settings?.quality?.check === false,
      requireEvidence: input.requireEvidence !== false,
      attempt: n,
    });
    // Meanwhile the owner decided, sent it back, or the bot reported it again: that counts, not this look.
    const cur = this.row(r.user_id, r.kind, r.ref);
    if (!cur || cur.check_state !== 'review' || !cur.open || cur.reported_at !== r.reported_at) return;
    if (verdict.retryAt) {
      const last = n >= MAX_RECHECKS;
      this.patch(cur, last ? { recheck_n: n, check_reason: gaveUpText(verdict.limit) } : { recheck_n: n, recheck_at: new Date(verdict.retryAt).toISOString(), check_reason: verdict.reason });
      this.emit(r.user_id, r.kind, r.ref);
      return;
    }
    const done = verdict.state === 'passed' || verdict.state === 'skipped';
    const ts = now();
    this.patch(cur, {
      recheck_n: n,
      outcome: verdict.state === 'cant' ? 'cant' : 'done',
      outcome_reason: verdict.state === 'cant' ? verdict.reason : '',
      check_state: verdict.state,
      check_reason: verdict.reason,
      check_engine: verdict.engine || '',
      check_tokens: verdict.tokens ?? null,
      checked_at: ts,
      open: !done,
      ...(done || verdict.state === 'cant' ? { claimed_by: null, claimed_at: null } : {}),
    });
    this.ctx.audit(r.user_id, 'quality.recheck', { kind: r.kind, ref: r.ref, task: r.title.slice(0, 120), state: verdict.state, attempt: n }, agent.id);
    const handler = this.ctx.services.qualityRechecked?.[r.kind];
    if (typeof handler === 'function') {
      try {
        await handler({ userId: r.user_id, ref: r.ref, agent, verdict });
      } catch (e: any) {
        this.ctx.log.warn('[quality] recheck handler', e?.message || e);
      }
    }
    const title = r.title.slice(0, 80);
    this.ctx.events.emit(r.user_id, 'notification', {
      title: done ? `Gecontroleerd en klaar: ${title}` : verdict.state === 'cant' ? `${agent.name} kon “${title}” niet doen` : `Te controleren: ${title}`,
      body: verdict.reason.slice(0, 200),
      link: taskLink(r),
      kind: 'task',
    });
    this.emit(r.user_id, r.kind, r.ref);
    if (done) {
      try {
        maybeSuggestSkill(this, r.user_id, agent, r.title);
      } catch (e) {
        this.ctx.log.warn('[quality] skill suggestion', e);
      }
    }
  }

  /** Tasks that wait for the owner (te controleren, kon niet), newest first. */
  openItems(userId: string) {
    return this.ctx.store
      .all<any>("SELECT * FROM quality_tasks WHERE user_id = ? AND open = 1 AND kind IN ('room','teamdata') ORDER BY updated_at DESC LIMIT 100", userId)
      .map((x) => this.ctx.store.decode<QualityRow>('quality_tasks', x))
      .map((r) => ({ kind: r.kind, ref: r.ref, title: r.title, ...this.view(r) }));
  }

  /** The bot that should hear about a task (who claimed it, else who reported it). */
  workerOf(userId: string, kind: TaskKind, ref: string | number): Agent | null {
    const r = this.row(userId, kind, ref);
    const id = r?.claimed_by || r?.reported_by;
    const a = id ? this.ctx.store.agent(id) : null;
    return a && a.user_id === userId ? a : null;
  }

  /** A message from the owner in a bot's own chat (queued when the bot is busy), e.g. "not done yet: …". */
  async tellBot(u: Pick<User, 'id' | 'name'>, agent: Agent, text: string, parts: Record<string, any> = {}) {
    const thread = this.ctx.chat.threadForAgent(u.id, agent.id);
    const queue = this.ctx.services.queue;
    if (queue?.submit) {
      const r = await queue.submit(thread, { id: u.id, name: u.name }, { content: text, parts }, 'auto');
      return { threadId: thread.id, mode: r?.mode || 'sent' };
    }
    await this.ctx.chat.postUserMessage({ thread, user: { id: u.id, name: u.name }, content: text, parts });
    return { threadId: thread.id, mode: 'sent' };
  }

  /** Remove everything of a user (account removal). */
  deleteUser(userId: string) {
    this.ctx.store.exec('DELETE FROM quality_tasks WHERE user_id = ?', userId);
    this.ctx.store.exec('DELETE FROM quality_lessons WHERE user_id = ?', userId);
    this.ctx.store.exec('DELETE FROM quality_suggestions WHERE user_id = ?', userId);
  }
}
