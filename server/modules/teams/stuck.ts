import type { Ctx, Thread } from '../../core/types.js';
import { now } from '../../core/db.js';
import { bad, notFound } from '../../core/http.js';
import { trUser } from '../../core/i18n.js';
import { redact } from '../../core/secrets.js';
import { plainEngineError } from '../../agent/fallback.js';
import type { TeamsService } from './service.js';

/**
 * "Niets blijft stil liggen" (0.4.4, P2): the main bot reports stuck work once, in plain words, in its own chat.
 *
 * Stuck is:
 *  - an approval or question that has waited in "Wacht op jou" for more than WAIT_MINUTES;
 *  - a task of a bot that broke (error) or was cut off (TeamBot stopped mid-run) and that nobody picked up again
 *    within BROKEN_AFTER_MS (no newer run of that bot in that chat, no automatic retry planned);
 *  - a routine run that failed (also "Kon niet: koppeling verlopen" from the check before the start).
 * The main bot writes one or two sentences per item: what waits, in which team, and where you answer. Each item is
 * reported once (team_stuck_reports). A broken task gets "Opnieuw proberen", a failed routine "Nog een keer"; both are
 * the owner's own click. The main bot never answers, approves or retries anything by itself: the message is written by
 * TeamBot without a model call (no tokens), and the approval stays where it is.
 *
 * Without a main bot nothing is written here (the normal notifications stay). Work in the main bot's own chat is left
 * out: you see it there already. Delegations are left out too: the bot that gave the work hears about it.
 * The idea comes from OpenMausBot's team escalations (Apache-2.0); this is our own code.
 */

export const WAIT_MINUTES = 30;
export const BROKEN_AFTER_MS = 5 * 60_000;
/** Older work is not reported any more (the first start after an update does not dig up last month). */
const LOOK_BACK_MS = 7 * 24 * 3600_000;
/** At most this many items in one message; the rest is counted. */
const MAX_LINES = 5;

export type StuckKind = 'approval' | 'question' | 'error' | 'interrupted' | 'routine';

export interface StuckItem {
  /** apr:<id> | run:<id> | rr:<id> */
  ref: string;
  kind: StuckKind;
  agentId: string | null;
  bot: string;
  team: string | null;
  /** The approval's summary, the error in plain words, or the routine's name. */
  title: string;
  since: string;
  /** Where you answer or look. */
  link: string;
  threadId: string | null;
  routineId?: string;
  /** A failed routine: its error in plain words. */
  error?: string;
  retry: boolean;
}

/** One item of a stuck message as stored in its parts (the UI draws the buttons from this). */
export interface StuckPart {
  ref: string;
  kind: StuckKind;
  link: string;
  retry: boolean;
  /** When the owner pressed Opnieuw proberen (then the button is gone). */
  retriedAt?: string;
}

const line = (s: unknown, n = 140) => {
  const v = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return v.length > n ? v.slice(0, n - 1) + '…' : v;
};
const minutesSince = (iso: string, at: number) => Math.max(0, Math.round((at - Date.parse(iso)) / 60_000));

function hasTable(ctx: Ctx, name: string) {
  return !!ctx.store.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name);
}

/** What is stuck right now for this owner (not yet filtered on what was reported before). */
export function collectStuck(ctx: Ctx, svc: TeamsService, userId: string, at = Date.now()): StuckItem[] {
  const mainId = svc.mainOf(userId);
  if (!mainId) return [];
  const store = ctx.store;
  const since = new Date(at - LOOK_BACK_MS).toISOString();
  const name = (id: string | null | undefined) => (id ? store.agent(id)?.name || '' : '');
  const teamName = (agentId: string | null | undefined) => {
    if (!agentId || agentId === mainId) return null;
    const tid = svc.teamOf(agentId);
    return tid ? store.one<{ name: string }>('SELECT name FROM teams WHERE id = ?', tid)?.name || null : null;
  };
  const mainThreads = new Set(store.threads(userId, { agentId: mainId, kind: 'chat', limit: 5 }).filter((t) => !t.room_id).map((t) => t.id));
  const out: StuckItem[] = [];

  // Approvals and questions that have waited too long.
  const waitCut = new Date(at - WAIT_MINUTES * 60_000).toISOString();
  for (const r of store.all<any>("SELECT id, agent_id, thread_id, kind, summary, created_at FROM approvals WHERE user_id = ? AND status = 'pending' AND created_at <= ? AND created_at >= ? ORDER BY created_at LIMIT 50", userId, waitCut, since)) {
    if (r.thread_id && mainThreads.has(r.thread_id)) continue;
    const question = r.kind === 'question';
    out.push({ ref: `apr:${r.id}`, kind: question ? 'question' : 'approval', agentId: r.agent_id, bot: name(r.agent_id) || 'Een bot', team: teamName(r.agent_id), title: line(r.summary) || (question ? 'Vraag' : 'Toestemming gevraagd'), since: r.created_at, link: '#/inbox', threadId: r.thread_id || null, retry: false });
  }

  // Broken or cut-off tasks nobody picked up again.
  const brokeCut = new Date(at - BROKEN_AFTER_MS).toISOString();
  for (const r of store.all<any>("SELECT id, agent_id, thread_id, status, error, meta, finished_at, created_at FROM runs WHERE user_id = ? AND status IN ('error','interrupted') AND COALESCE(finished_at, created_at) <= ? AND created_at >= ? ORDER BY created_at LIMIT 100", userId, brokeCut, since)) {
    if (mainThreads.has(r.thread_id)) continue;
    let meta: any = {};
    try {
      meta = typeof r.meta === 'string' ? JSON.parse(r.meta) : r.meta || {};
    } catch {
      /* keep empty */
    }
    // Paused important work and a planned "probeert het rond … opnieuw" are not stuck: TeamBot picks them up itself.
    if (meta?.paused || (meta?.limitRetryAt && !meta?.limitRetried)) continue;
    const thread = store.thread(r.thread_id);
    if (!thread || thread.user_id !== userId || thread.kind === 'delegation' || thread.kind === 'routine') continue;
    const later = store.one('SELECT 1 FROM runs WHERE thread_id = ? AND agent_id = ? AND created_at > ? AND id != ? LIMIT 1', r.thread_id, r.agent_id, r.created_at, r.id);
    if (later) continue;
    const agent = store.agent(r.agent_id);
    const engine = agent?.provider_id ? ctx.providers.config(agent.provider_id)?.name : undefined;
    const err = r.status === 'interrupted' ? '' : line(redact(plainEngineError(String(r.error || ''), { engine })), 200);
    const canRetry = !!store.one("SELECT 1 FROM messages WHERE thread_id = ? AND role = 'user' AND deleted = 0 LIMIT 1", r.thread_id);
    out.push({ ref: `run:${r.id}`, kind: r.status === 'interrupted' ? 'interrupted' : 'error', agentId: r.agent_id, bot: agent?.name || 'Een bot', team: teamName(r.agent_id), title: err, since: r.finished_at || r.created_at, link: `#/t/${r.thread_id}`, threadId: r.thread_id, retry: canRetry });
  }

  // Failed routine runs (the routine engine retries by its own policy first: only the final failure counts).
  if (hasTable(ctx, 'routine_runs') && hasTable(ctx, 'routines'))
    for (const r of store.all<any>("SELECT rr.id, rr.error, rr.finished_at, rr.created_at, ro.id AS routine_id, ro.name, ro.agent_id FROM routine_runs rr JOIN routines ro ON ro.id = rr.routine_id WHERE rr.user_id = ? AND rr.status = 'error' AND COALESCE(rr.finished_at, rr.created_at) <= ? AND rr.created_at >= ? ORDER BY rr.created_at LIMIT 50", userId, brokeCut, since)) {
      const later = store.one("SELECT 1 FROM routine_runs WHERE routine_id = ? AND created_at > ? AND status IN ('done','no_update','running','pending','retrying') LIMIT 1", r.routine_id, r.created_at);
      if (later) continue;
      out.push({ ref: `rr:${r.id}`, kind: 'routine', agentId: r.agent_id, bot: name(r.agent_id) || 'Een bot', team: teamName(r.agent_id), title: line(r.name, 80), since: r.finished_at || r.created_at, link: `#/m/routines/r/${r.routine_id}?tab=history`, threadId: null, routineId: r.routine_id, error: line(r.error, 200), retry: true });
    }
  return out.sort((a, b) => a.since.localeCompare(b.since));
}

/** One or two sentences about one item, in the owner's language. */
export function stuckSentence(ctx: Ctx, userId: string, i: StuckItem, at = Date.now()): string {
  const t = (text: string, ...v: (string | number)[]) => trUser(ctx.store, userId, text, ...v);
  const m = minutesSince(i.since, at);
  switch (i.kind) {
    case 'approval':
    case 'question': {
      const what = i.kind === 'question' ? (i.team ? t('{0} in team {1} wacht al {2, plural, one {# minuut} other {# minuten}} op je antwoord: “{3}”.', i.bot, i.team, m, i.title) : t('{0} wacht al {1, plural, one {# minuut} other {# minuten}} op je antwoord: “{2}”.', i.bot, m, i.title)) : i.team ? t('{0} in team {1} wacht al {2, plural, one {# minuut} other {# minuten}} op je goedkeuring: “{3}”.', i.bot, i.team, m, i.title) : t('{0} wacht al {1, plural, one {# minuut} other {# minuten}} op je goedkeuring: “{2}”.', i.bot, m, i.title);
      return `${what} ${t('Je antwoordt in Wacht op jou.')}`;
    }
    case 'interrupted':
      return `${i.team ? t('Het werk van {0} in team {1} is afgebroken voordat het klaar was.', i.bot, i.team) : t('Het werk van {0} is afgebroken voordat het klaar was.', i.bot)} ${t('Je kunt het opnieuw proberen of het gesprek openen.')}`;
    case 'error':
      return `${i.team ? t('Het werk van {0} in team {1} is vastgelopen: {2}', i.bot, i.team, i.title || t('er ging iets mis.')) : t('Het werk van {0} is vastgelopen: {1}', i.bot, i.title || t('er ging iets mis.'))} ${t('Je kunt het opnieuw proberen of het gesprek openen.')}`;
    case 'routine':
      return `${i.team ? t('Routine “{0}” van {1} in team {2} is mislukt: {3}', i.title, i.bot, i.team, i.error || t('er ging iets mis.')) : t('Routine “{0}” van {1} is mislukt: {2}', i.title, i.bot, i.error || t('er ging iets mis.'))} ${t('Het bonnetje staat bij Routines.')}`;
  }
}

export class StuckReporter {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  /** Test seam. */
  clock = () => Date.now();

  constructor(
    private ctx: Ctx,
    private svc: TeamsService,
  ) {}

  start(everyMs = 60_000) {
    this.stop();
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Report what is newly stuck for every owner with a main bot. Returns the messages written (for tests). */
  tick(): string[] {
    if (this.busy) return [];
    this.busy = true;
    const written: string[] = [];
    try {
      for (const { user_id } of this.ctx.store.all<{ user_id: string }>('SELECT user_id FROM team_main')) {
        try {
          const id = this.reportFor(user_id);
          if (id) written.push(id);
        } catch (e: any) {
          this.ctx.log.warn('[teams] vastgelopen werk melden', redact(String(e?.message || e)));
        }
      }
    } finally {
      this.busy = false;
    }
    return written;
  }

  /** Write one message for what is new; null when nothing is. */
  reportFor(userId: string): string | null {
    const ctx = this.ctx;
    const mainId = this.svc.mainOf(userId);
    const main = mainId ? ctx.store.agent(mainId) : null;
    if (!main || main.archived || main.user_id !== userId) return null;
    const at = this.clock();
    const fresh = collectStuck(ctx, this.svc, userId, at).filter((i) => !ctx.store.one('SELECT 1 FROM team_stuck_reports WHERE user_id = ? AND ref = ?', userId, i.ref));
    if (!fresh.length) return null;
    const thread = ctx.chat.threadForAgent(userId, main.id);
    const shown = fresh.slice(0, MAX_LINES);
    const sentences = shown.map((i) => stuckSentence(ctx, userId, i, at));
    const rest = fresh.length - shown.length;
    const t = (text: string, ...v: (string | number)[]) => trUser(ctx.store, userId, text, ...v);
    let content = shown.length === 1 ? sentences[0] : `${t('Er ligt werk stil:')}\n\n${sentences.map((s) => `- ${s}`).join('\n')}`;
    if (rest > 0) content += `\n\n${t('En nog {0, plural, one {# ander punt} other {# andere punten}} in Wacht op jou en Alle teams.', rest)}`;
    const parts: StuckPart[] = fresh.map((i) => ({ ref: i.ref, kind: i.kind, link: i.link, retry: i.retry }));
    const m = ctx.chat.addAgentMessage(thread, main, content, { stuck: { items: parts.slice(0, MAX_LINES) } } as any);
    const ts = now();
    // Every item is told once, also the ones only counted in "en nog …".
    for (const i of fresh) ctx.store.exec('INSERT OR IGNORE INTO team_stuck_reports (user_id, ref, message_id, created_at) VALUES (?, ?, ?, ?)', userId, i.ref, m.id, ts);
    // One notification, so it also reaches you outside the chat (Dutch: the outlets translate it themselves).
    ctx.events.emit(userId, 'notification', {
      title: `${main.name}: er ligt werk stil`,
      body: fresh.length === 1 ? line(`${fresh[0].bot}: ${fresh[0].title}`, 200) : `${fresh.length} punten wachten op je.`,
      link: `#/t/${thread.id}`,
      kind: 'warning',
      agentId: main.id,
      ref: `stuck:${m.id}`,
    });
    ctx.audit(userId, 'teams.stuck_reported', { count: fresh.length, message: m.id }, main.id);
    return m.id;
  }

  /** "Opnieuw proberen" under a stuck message: the owner's own click, for exactly the item it shows. */
  retry(userId: string, messageId: string, ref: string) {
    const ctx = this.ctx;
    const m = ctx.store.one<any>('SELECT * FROM messages WHERE id = ? AND deleted = 0', messageId);
    const thread: Thread | null = m ? ctx.store.thread(m.thread_id) : null;
    if (!m || !thread || thread.user_id !== userId) throw notFound('Bericht niet gevonden');
    const msg = ctx.store.messages(thread.id).find((x) => x.id === messageId);
    const items: StuckPart[] = (msg?.parts as any)?.stuck?.items || [];
    const item = items.find((x) => x.ref === ref);
    if (!msg || !item || !item.retry) throw bad('Dit punt kun je niet opnieuw proberen');
    if (item.retriedAt) throw bad('Dit is al opnieuw gestart');
    let result: any;
    if (ref.startsWith('run:')) {
      const run = ctx.store.one<any>('SELECT * FROM runs WHERE id = ? AND user_id = ?', ref.slice(4), userId);
      if (!run) throw notFound('Taak niet gevonden');
      const t = ctx.store.thread(run.thread_id);
      if (!t || t.user_id !== userId) throw notFound('Gesprek niet gevonden');
      if (ctx.store.one("SELECT 1 FROM runs WHERE thread_id = ? AND agent_id = ? AND status IN ('queued','running','waiting')", t.id, run.agent_id)) throw bad('De bot is al bezig in dat gesprek');
      const lastUser = ctx.store.one<any>("SELECT id FROM messages WHERE thread_id = ? AND role = 'user' AND deleted = 0 ORDER BY seq DESC LIMIT 1", t.id);
      if (!lastUser) throw bad('Geen bericht om opnieuw te proberen');
      result = { run: ctx.chat.startAgent(t, run.agent_id, lastUser.id, 'retry') };
      if (!result.run) throw bad('Kon de bot niet starten');
    } else if (ref.startsWith('rr:')) {
      const rr = ctx.store.one<any>('SELECT routine_id FROM routine_runs WHERE id = ? AND user_id = ?', ref.slice(3), userId);
      const engine = ctx.services.routines?.engine;
      const r = rr && engine ? engine.routine(rr.routine_id) : null;
      if (!r || r.user_id !== userId) throw notFound('Routine niet gevonden');
      result = { routineRun: engine.runView(engine.manualRun(r, 'manual')) };
    } else throw bad('Dit punt kun je niet opnieuw proberen');
    const next = items.map((x) => (x.ref === ref ? { ...x, retriedAt: now() } : x));
    const upd = ctx.store.updateMessage(msg.id, { parts: { ...msg.parts, stuck: { ...(msg.parts as any).stuck, items: next } } as any });
    ctx.chat.emitMessage(thread, upd, 'message.updated');
    ctx.audit(userId, 'teams.stuck_retry', { ref, message: msg.id });
    return { ok: true, ...result };
  }
}
