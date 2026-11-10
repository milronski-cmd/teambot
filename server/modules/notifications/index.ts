import type { Ctx, Message, Module, Run, Thread } from '../../core/types.js';
import type { TBEvent } from '../../core/events.js';
import { ah, bad, str, user } from '../../core/http.js';
import { newId, now } from '../../core/db.js';
import { cleanPrefs, decide, isImportant, mergePrefs, type NotifyPrefs } from './policy.js';
import { plainEngineError, plainErrorKind } from '../../agent/fallback.js';
import { redact } from '../../core/secrets.js';

/**
 * Meldingencentrum: the history of everything TeamBot told you (approvals and questions, finished or failed tasks,
 * routine results, limit warnings, channel messages, team invites …), read/unread, per-bot levels and sound.
 *
 * It does not invent a second notification path: modules keep emitting `notification` events. This module records
 * them, and the existing outlets (the app's toast, desktop notifications, phone push) ask
 * `ctx.services.notifications.shouldAlert()` / `.sound()` before they alert, so a muted bot is quiet everywhere.
 *
 * Events to the UI: `notification.added` { item, alert, sound, unread } (also for a coalesced update of an existing
 * item) and `notifications.read` { ids | all, unread }.
 */

export interface NotificationRow {
  id: string;
  user_id: string;
  kind: string;
  important: boolean;
  title: string;
  body: string;
  link: string;
  agent_id: string | null;
  ref: string | null;
  count: number;
  muted: boolean;
  read_at: string | null;
  created_at: string;
  updated_at: string;
}

const PREFS_KEY = 'notificationPrefs';
const KEEP = 500;
const KEEP_DAYS = 90;
/** A run that finishes after this long is worth a "klaar" entry (shorter ones you were watching anyway). */
const RUN_DONE_AFTER_MS = 60_000;

/** Only in-app hash routes (same rule as phone pushes). */
export function safeLink(link: unknown): string {
  const s = String(link || '');
  const h = s.startsWith('#') ? s : s ? '#' + s : '';
  return /^#\/[\w\-/?=&.%:]*$/.test(h) && h.length < 300 ? h : '';
}

const threadIdOf = (link: string) => /^#\/t\/([\w-]+)/.exec(link)?.[1] || null;

export class NotificationService {
  private inserts = 0;
  constructor(private ctx: Ctx) {}

  // ---------- preferences ----------

  prefs(userId: string): NotifyPrefs {
    return cleanPrefs(this.ctx.store.getSetting<any>(userId, PREFS_KEY, {}));
  }

  setPrefs(userId: string, patch: any): NotifyPrefs {
    const mine = new Set(this.ctx.store.agents(userId, { archived: true }).map((a) => a.id));
    const next = mergePrefs(this.prefs(userId), patch, (id) => mine.has(id));
    this.ctx.store.setSetting(userId, PREFS_KEY, next);
    this.ctx.events.emit(userId, 'notifications.prefs', next);
    return next;
  }

  sound(userId: string): boolean {
    return this.prefs(userId).sound;
  }

  // ---------- classification ----------

  /** The bot a notification belongs to (explicit id, the approval, the routine, or the chat it links to). */
  agentOf(userId: string, d: any): string | null {
    const own = (id: unknown) => {
      if (typeof id !== 'string' || !id) return null;
      const a = this.ctx.store.agent(id);
      return a && a.user_id === userId ? a.id : null;
    };
    const direct = own(d?.agentId) || own(d?.agent_id);
    if (direct) return direct;
    try {
      if (typeof d?.approvalId === 'string') {
        const apr = this.ctx.store.one<any>('SELECT agent_id FROM approvals WHERE id = ?', d.approvalId);
        if (own(apr?.agent_id)) return apr.agent_id;
      }
      if (typeof d?.routineId === 'string') {
        const r = this.ctx.store.one<any>('SELECT agent_id FROM routines WHERE id = ? AND user_id = ?', d.routineId, userId);
        if (own(r?.agent_id)) return r.agent_id;
      }
    } catch {
      /* table of an absent module */
    }
    const link = safeLink(d?.link);
    const tid = threadIdOf(link);
    if (tid) {
      const t = this.ctx.store.thread(tid);
      if (t && !t.room_id) return own(t.agent_id);
    }
    const edit = /^#\/agents\/([\w-]+)/.exec(link)?.[1];
    return edit ? own(edit) : null;
  }

  /** Kind for the history: an approval that is a question shows as "Vraag". */
  private kindOf(d: any): string {
    const k = str(d?.kind, 30) || 'agent';
    if (k === 'approval' && typeof d?.approvalId === 'string') {
      const apr = this.ctx.store.one<any>('SELECT kind FROM approvals WHERE id = ?', d.approvalId);
      if (apr?.kind === 'question') return 'question';
    }
    return k;
  }

  /** May this notification pop up, sound or be pushed? Used by the desktop app and phone push as well. */
  shouldAlert(userId: string, d: any): boolean {
    if (!userId || userId === '*') return true;
    return decide(this.prefs(userId), { agentId: this.agentOf(userId, d), important: isImportant(d) }).alert;
  }

  // ---------- history ----------

  private decode(row: any): NotificationRow {
    return { ...row, important: !!row.important, muted: !!row.muted };
  }

  unread(userId: string): number {
    return this.ctx.store.one<{ n: number }>('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL', userId)?.n || 0;
  }

  /**
   * Store one notification. Coalesces into an unread item with the same `ref` (or the same title + link within two
   * minutes), so a chatty channel or a repeating warning is one line with a count, not a wall.
   */
  record(userId: string, d: any, o: { ref?: string | null; alert?: boolean } = {}): NotificationRow | null {
    if (!userId || userId === '*' || !d) return null;
    const title = str(d.title, 160).trim() || 'TeamBot';
    const body = str(d.body, 400).trim();
    const link = safeLink(d.link);
    const agentId = this.agentOf(userId, d);
    const kind = this.kindOf(d);
    const important = isImportant({ ...d, kind });
    const prefs = this.prefs(userId);
    const dec = decide(prefs, { agentId, important });
    const alert = o.alert === false ? false : dec.alert;
    const muted = dec.muted;
    const t = now();
    const tid = threadIdOf(link);
    // A module may group its own repeats with `ref` ("preflight:<routine>:<apps>", "stuck:<item>"): one line with a count.
    const ref = o.ref ?? (d.approvalId ? `apr:${str(d.approvalId, 60)}` : kind === 'channel' && tid ? `chan:${tid}` : typeof d.ref === 'string' && /^[\w:.,-]{1,160}$/.test(d.ref) ? d.ref : null);

    const same = ref
      ? this.ctx.store.one<any>('SELECT * FROM notifications WHERE user_id = ? AND ref = ? ORDER BY updated_at DESC LIMIT 1', userId, ref)
      : this.ctx.store.one<any>('SELECT * FROM notifications WHERE user_id = ? AND title = ? AND link = ? AND updated_at > ? ORDER BY updated_at DESC LIMIT 1', userId, title, link, new Date(Date.now() - 120_000).toISOString());
    // Same approval/run again: never a second line.
    if (same && (ref?.startsWith('apr:') || ref?.startsWith('run:'))) return null;
    // Same unread chat or warning: one line with a count. Quiet lines (a muted bot) keep coalescing for half a day.
    const quietPair = !!same && !!same.muted && muted && Date.now() - Date.parse(same.updated_at) < 12 * 3600_000;
    let row: NotificationRow;
    if (same && (same.read_at === null || quietPair)) {
      const count = (same.count || 1) + 1;
      const upgrade = important && !same.important;
      this.ctx.store.exec('UPDATE notifications SET title = ?, body = ?, count = ?, important = ?, muted = ?, updated_at = ? WHERE id = ?', title, body, count, upgrade || same.important ? 1 : 0, muted && same.muted ? 1 : 0, t, same.id);
      row = this.decode({ ...same, title, body, count, important: upgrade || !!same.important, muted: muted && !!same.muted, updated_at: t });
    } else {
      row = { id: newId('ntf_'), user_id: userId, kind, important, title, body, link, agent_id: agentId, ref, count: 1, muted, read_at: muted ? t : null, created_at: t, updated_at: t };
      this.ctx.store.insert('notifications', row);
      if (++this.inserts % 50 === 1) this.prune(userId);
    }
    this.ctx.events.emit(userId, 'notification.added', { item: row, alert, sound: alert && prefs.sound, unread: this.unread(userId) });
    return row;
  }

  private prune(userId: string) {
    const cutoff = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString();
    this.ctx.store.exec('DELETE FROM notifications WHERE user_id = ? AND updated_at < ?', userId, cutoff);
    this.ctx.store.exec('DELETE FROM notifications WHERE user_id = ? AND id NOT IN (SELECT id FROM notifications WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?)', userId, userId, KEEP);
  }

  list(userId: string, o: { filter?: string; before?: string; limit?: number } = {}) {
    const where = ['user_id = ?'];
    const args: any[] = [userId];
    if (o.filter === 'unread') where.push('read_at IS NULL');
    if (o.filter === 'important') where.push('important = 1');
    if (o.before) {
      where.push('updated_at < ?');
      args.push(o.before);
    }
    const limit = Math.max(1, Math.min(100, o.limit || 40));
    const rows = this.ctx.store.all<any>(`SELECT * FROM notifications WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`, ...args, limit + 1);
    return { items: rows.slice(0, limit).map((r) => this.decode(r)), more: rows.length > limit, unread: this.unread(userId) };
  }

  markRead(userId: string, sel: { ids?: string[]; all?: boolean; ref?: string; link?: string }) {
    const t = now();
    let ids: string[] = [];
    if (sel.all) {
      this.ctx.store.exec('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', t, userId);
    } else {
      const rows = sel.ids?.length
        ? this.ctx.store.all<any>(`SELECT id FROM notifications WHERE user_id = ? AND read_at IS NULL AND id IN (${sel.ids.map(() => '?').join(',')})`, userId, ...sel.ids)
        : sel.ref
          ? this.ctx.store.all<any>('SELECT id FROM notifications WHERE user_id = ? AND read_at IS NULL AND ref = ?', userId, sel.ref)
          : sel.link
            ? this.ctx.store.all<any>('SELECT id FROM notifications WHERE user_id = ? AND read_at IS NULL AND link = ?', userId, sel.link)
            : [];
      ids = rows.map((r) => r.id);
      if (!ids.length) return { unread: this.unread(userId), changed: 0 };
      this.ctx.store.exec(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`, t, userId, ...ids);
    }
    const unread = this.unread(userId);
    this.ctx.events.emit(userId, 'notifications.read', sel.all ? { all: true, unread } : { ids, unread });
    return { unread, changed: sel.all ? -1 : ids.length };
  }

  clear(userId: string) {
    this.ctx.store.exec('DELETE FROM notifications WHERE user_id = ?', userId);
    this.ctx.events.emit(userId, 'notifications.read', { all: true, cleared: true, unread: 0 });
    return { ok: true };
  }

  // ---------- event sources ----------

  onEvent = (e: TBEvent) => {
    if (!e.userId || e.userId === '*') return;
    try {
      if (e.type === 'notification') this.record(e.userId, e.data);
      else if (e.type === 'run.updated') this.onRun(e.userId, e.data);
      else if (e.type === 'approval.updated' && e.data?.id && e.data.status && e.data.status !== 'pending') this.markRead(e.userId, { ref: `apr:${e.data.id}` });
    } catch (err: any) {
      this.ctx.log.warn('[notifications]', err?.message || err);
    }
  };

  /** A long task that finished, or a task that failed: the bot's result belongs in the history. */
  private onRun(userId: string, r: Run) {
    if (!r || (r.status !== 'done' && r.status !== 'error')) return;
    // Important work that paused (engine-chain) is not a failure: the runner sent its own "gepauzeerd" notification.
    if (r.meta?.paused) return;
    if (r.trigger && !['user', 'retry', 'channel'].includes(r.trigger)) return;
    const took = r.finished_at && r.started_at ? Date.parse(r.finished_at) - Date.parse(r.started_at) : 0;
    if (r.status === 'done' && (took < RUN_DONE_AFTER_MS || r.trigger === 'channel')) return;
    const thread = this.ctx.store.thread(r.thread_id);
    if (!thread || thread.kind === 'delegation' || thread.kind === 'routine') return;
    // A usage limit is told once (acceptance round 4: "… heeft zijn gebruikslimiet bereikt" and "… liep vast" at the
    // same moment): when the limit notification for it came in during this run, the failed run adds nothing.
    if (r.status === 'error' && r.error && plainErrorKind(r.error) === 'limit') {
      const since = r.started_at || r.created_at;
      const engine = r.meta?.engine?.provider_id || this.ctx.store.agent(r.agent_id)?.provider_id;
      if (engine && this.ctx.services.usage?.limitNotified?.(engine)) return;
      if (since && this.ctx.store.one("SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'limit' AND updated_at >= ? LIMIT 1", userId, since)) return;
    }
    const agent = this.ctx.store.agent(r.agent_id);
    const name = agent?.name || 'Je bot';
    const last = r.status === 'done' ? this.ctx.store.one<any>("SELECT content FROM messages WHERE run_id = ? AND role = 'assistant' AND deleted = 0 ORDER BY seq DESC LIMIT 1", r.id) : null;
    // The engine's own (English) error text stays in the run row; people get the same plain sentence as in the chat.
    const engine = agent?.provider_id ? this.ctx.providers.config(agent.provider_id)?.name : undefined;
    const failed = r.status === 'error' && r.error ? redact(plainEngineError(r.error, { engine })) : '';
    this.record(
      userId,
      {
        // Stopped by the daily budget (agent/budget.ts): a limit, not "liep vast"; the body says when and where to raise it.
        title: r.status === 'done' ? `${name} is klaar` : r.meta?.budget?.cap ? `${name} heeft zijn eigen limiet bereikt` : r.meta?.budget ? `${name} heeft de daglimiet bereikt` : `${name} liep vast`,
        body: r.status === 'done' ? str(last?.content, 200).replace(/\s+/g, ' ') || `Na ${Math.round(took / 60_000)} min.` : str(failed, 200) || 'Er ging iets mis.',
        link: `#/t/${r.thread_id}`,
        kind: 'run',
        level: r.status === 'error' ? (r.meta?.budget ? 'limit' : 'error') : undefined,
        agentId: r.agent_id,
      },
      { ref: `run:${r.id}` },
    );
  }

  /** A message that came in through a channel (WhatsApp, Telegram …): quietly in the history, one line per chat. */
  onMessage = ({ message, thread }: { message: Message; thread: Thread }) => {
    if (thread.kind !== 'channel' || message.author_type !== 'external' || message.role !== 'user') return;
    try {
      const ch = (message.parts as any)?.channel || {};
      this.record(
        thread.user_id,
        {
          title: message.author_name || `Bericht via ${ch.adapterLabel || 'een kanaal'}`,
          body: str(message.content, 200).replace(/\s+/g, ' ') || 'Bijlage',
          link: `#/t/${thread.id}`,
          kind: 'channel',
          agentId: thread.agent_id,
        },
        { ref: `chan:${thread.id}`, alert: false },
      );
    } catch (err: any) {
      this.ctx.log.warn('[notifications] kanaalbericht', err?.message || err);
    }
  };
}

/** Per app instance (tests run several apps in one process). */
const subscriptions = new WeakMap<Ctx, () => void>();

const mod: Module = {
  id: 'notifications',
  label: 'Meldingen',
  migrations: [
    {
      id: 'notifications-001',
      sql: `CREATE TABLE notifications (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'agent', important INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '', agent_id TEXT, ref TEXT,
  count INTEGER NOT NULL DEFAULT 1, muted INTEGER NOT NULL DEFAULT 0, read_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX notifications_user ON notifications(user_id, updated_at);
CREATE INDEX notifications_ref ON notifications(user_id, ref);`,
    },
  ],
  init(ctx) {
    const s = new NotificationService(ctx);
    subscriptions.get(ctx)?.();
    subscriptions.set(ctx, ctx.events.subscribe(s.onEvent));
    ctx.services.notifications = {
      /** May this notification alert (pop up, sound, push)? Desktop notifications and phone push ask this first. */
      shouldAlert: (userId: string, d: any) => s.shouldAlert(userId, d),
      /** The owner wants a sound with alerts. */
      sound: (userId: string) => s.sound(userId),
      prefs: (userId: string) => s.prefs(userId),
      record: (userId: string, d: any) => s.record(userId, d),
      exportUser: (userId: string) => ({ notifications: { prefs: s.prefs(userId), history: s.list(userId, { limit: 100 }).items.map((n) => ({ ...n, user_id: undefined })) } }),
      instance: s,
    };
    if (!Array.isArray(ctx.services.mobileRoutes)) ctx.services.mobileRoutes = [];
    for (const [method, path] of [
      ['GET', '/notifications'],
      ['POST', '/notifications/read'],
      ['GET', '/notifications/prefs'],
      ['PUT', '/notifications/prefs'],
    ])
      ctx.services.mobileRoutes.push({ method, path });

    ctx.hooks.messageCreated.push(s.onMessage);
    ctx.hooks.agentDeleted.push(({ agentId, userId }) => {
      const p = s.prefs(userId);
      if (p.bots[agentId]) s.setPrefs(userId, { bots: { [agentId]: null } });
    });

    const api = ctx.api;
    api.get(
      '/notifications',
      ah(async (req) => {
        const u = user(req);
        return s.list(u.id, { filter: str(req.query.filter, 20), before: str(req.query.before, 40) || undefined, limit: Number(req.query.limit) || undefined });
      }),
    );
    api.post(
      '/notifications/read',
      ah(async (req) => {
        const u = user(req);
        const b = req.body || {};
        if (b.all === true) return s.markRead(u.id, { all: true });
        if (Array.isArray(b.ids)) return s.markRead(u.id, { ids: b.ids.filter((x: unknown) => typeof x === 'string').slice(0, 500) });
        if (typeof b.link === 'string') return s.markRead(u.id, { link: safeLink(b.link) });
        throw bad('Geef ids, link of all: true');
      }),
    );
    api.delete('/notifications', ah(async (req) => s.clear(user(req).id)));
    api.get('/notifications/prefs', ah(async (req) => s.prefs(user(req).id)));
    api.put('/notifications/prefs', ah(async (req) => s.setPrefs(user(req).id, req.body || {})));
  },
  stop(ctx) {
    subscriptions.get(ctx)?.();
    subscriptions.delete(ctx);
  },
};

export default mod;
