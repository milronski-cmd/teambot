import type { Agent, Ctx, ProviderConfig, Run, Thread } from '../../core/types.js';
import { now as isoNow } from '../../core/db.js';
import { userLocale } from '../../core/i18n.js';
import { historyFill } from '../../agent/compaction.js';
import { dayStart } from '../../agent/budget.js';
import { LOCAL_PROBES } from '../../providers/local.js';
import { parseLimitReset } from '../routines/limits.js';
import { clockTime, DEFAULT_LIMIT_WAIT_MS, isFreeLimit } from '../../agent/fallback.js';
import { mergeWindows, worstWindow, type LimitLevel, type LimitReport, type LimitWindow } from './parse.js';
import { blockedUntil, cleanReserve, cleanSource, effectiveSource, sameSource, sortWindows, weekStart, type ReserveReport, type ReserveView, type SourceReport, type SourceStatus, type SourceView, type StoredSource } from './bar.js';
import { toolLabel } from '../../../shared/toolLabels.js';

/**
 * Usage limits per account (= provider) and context fill per chat. Engines report what they know (see parse.ts);
 * this service merges it, remembers it across restarts, and notifies the owner once when a window gets close to its
 * limit, when it is reached and when it resets. It never invents a number: unknown stays null.
 */

export interface EngineState {
  providerId: string;
  userId: string;
  windows: LimitWindow[];
  plan?: string;
  billing?: 'subscription' | 'api' | 'unknown';
  note?: string;
  /**
   * The engine refused work (limit reached); until = reset when known. Without a known reset TeamBot stops showing
   * it after `clearAt` (the runner's own retry wait), without claiming it is available again.
   */
  blocked?: { at: number; until: number | null; label?: string; clearAt?: number; notified?: boolean; /** The reset came from an error text, not from the engine's own numbers. */ estimated?: boolean } | null;
  source?: LimitReport['source'];
  updatedAt?: number;
  /** The last report from a run (stream) and the windows it covered: then no extra read is needed after that run. */
  streamAt?: number;
  streamIds?: string[];
  checkedAt?: number;
  error?: string;
  unsupported?: string;
  stats?: { input: number; output: number; cost: number; sessions: number } | null;
  /** Highest level already notified per window (reset with the window). */
  notified: Record<string, { level: LimitLevel; resetsAt: number | null }>;
}

export interface ContextState {
  used: number;
  window: number | null;
  engine: string;
  providerId: string;
  at: number;
}

export interface AlertSettings {
  enabled: boolean;
  warnAt: number;
}

const READ_EVERY_MS = 2 * 60_000;
/** A short rate limit (an API 429 for seconds or minutes) is shown, but not notified. */
const QUIET_BLOCK_MS = 10 * 60_000;
const rank = (l: LimitLevel | undefined) => (l === 'limit' ? 3 : l === 'warn' ? 2 : l === 'ok' ? 1 : 0);
const LOCAL = new Set(['ollama', 'lmstudio']);
const READERS = new Set(['claude-code', 'codex-cli', 'opencode']);
/** How often the reachability of a local model server (Ollama …) is checked while the bar is shown. */
const LOCAL_CHECK_MS = 60_000;

export class UsageService {
  private cache = new Map<string, EngineState>();
  private reading = new Map<string, Promise<EngineState>>();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private ctx: Ctx) {}

  // ---------------- state ----------------

  state(providerId: string, userId?: string): EngineState {
    let st = this.cache.get(providerId);
    if (st) return st;
    const row = this.ctx.store.one<{ data: string; user_id: string }>('SELECT data, user_id FROM usage_engines WHERE provider_id = ?', providerId);
    let data: any = {};
    try {
      data = row ? JSON.parse(row.data) : {};
    } catch {
      data = {};
    }
    st = { windows: [], notified: {}, ...data, providerId, userId: row?.user_id || userId || this.ctx.providers.config(providerId)?.user_id || '' };
    this.cache.set(providerId, st!);
    return st!;
  }

  private save(st: EngineState) {
    const { providerId, userId, ...data } = st;
    this.ctx.store.exec(
      'INSERT INTO usage_engines (provider_id, user_id, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(provider_id) DO UPDATE SET data = excluded.data, user_id = excluded.user_id, updated_at = excluded.updated_at',
      providerId,
      userId,
      JSON.stringify(data),
      isoNow(),
    );
  }

  alerts(userId: string): AlertSettings {
    const a = this.ctx.store.getSetting<any>(userId, 'usageAlerts', {});
    const warnAt = Number(a?.warnAt);
    return { enabled: a?.enabled !== false, warnAt: Number.isFinite(warnAt) && warnAt >= 50 && warnAt <= 99 ? Math.round(warnAt) : 80 };
  }

  setAlerts(userId: string, a: Partial<AlertSettings>) {
    const cur = this.alerts(userId);
    const next = { enabled: typeof a.enabled === 'boolean' ? a.enabled : cur.enabled, warnAt: Number.isFinite(Number(a.warnAt)) ? Math.max(50, Math.min(99, Math.round(Number(a.warnAt)))) : cur.warnAt };
    this.ctx.store.setSetting(userId, 'usageAlerts', next);
    return next;
  }

  private tz(userId: string) {
    return this.ctx.store.getSetting<string>(userId, 'timezone', '') || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Amsterdam';
  }

  // ---------------- reports from the engines ----------------

  /** A report from a run (stream) or an explicit read. */
  report(cfg: ProviderConfig | string, r: LimitReport) {
    const c = typeof cfg === 'string' ? this.ctx.providers.config(cfg) : cfg;
    if (!c || !r) return;
    const st = this.state(c.id, c.user_id);
    const t = r.at || Date.now();
    st.windows = mergeWindows(st.windows, r.windows, t);
    if (r.plan) st.plan = r.plan;
    if (r.billing) st.billing = r.billing;
    if (r.note !== undefined) st.note = r.note;
    st.source = r.source;
    st.updatedAt = t;
    if (r.source === 'stream') {
      st.streamAt = t;
      st.streamIds = r.windows.map((w) => w.id);
    }
    if (r.source !== 'stream') st.error = undefined;
    // Every window that is at its limit now, also one this report does not mention (Claude's stream tells one window
    // per request: a week report must not lift a full 5-hour window). A remembered window counts only while its reset
    // is still ahead, so a stale one never blocks for ever.
    const limitW = st.windows.filter((w) => w.level === 'limit' && (r.windows.some((x) => x.id === w.id) || (!!w.resetsAt && w.resetsAt > t)));
    if (r.blocked || limitW.length) {
      const b = blockedUntil(limitW);
      this.block(st, c, b.until ?? st.blocked?.until ?? null, b.label);
    } else if (st.blocked && r.windows.length && (r.source === 'stream' || r.source === 'app-server' || r.source === 'usage-command')) {
      // The engine says it works again before the reset we knew of.
      this.unblock(st, c, 'gemeld');
    }
    this.evaluate(st, c);
    this.save(st);
    this.emit(st);
  }

  /** The runner saw a usage limit (any engine, API 429 included). */
  /** Is this engine at a limit that its owner was already told about (so a failed run says nothing more)? */
  limitNotified(providerId: string): boolean {
    const c = this.ctx.providers.config(providerId);
    if (!c) return false;
    const b = this.state(c.id, c.user_id).blocked;
    // (with limit alerts off nothing was said: then the failed run tells it)
    return this.alerts(c.user_id).enabled && !!b?.notified && (!b.until || b.until > Date.now());
  }

  /**
   * The runner saw a usage limit (any engine, API 429 included). `link`: the chat where it happened, so the one
   * notification about it opens where the bot can be switched (the failed run itself adds no second one).
   */
  limitHit(userId: string, providerId: string, resetAt: number | null, message?: string, o: { link?: string; retry?: { at: number; bot: string } } = {}) {
    const c = this.ctx.providers.config(providerId);
    if (!c) return;
    const st = this.state(c.id, userId);
    const until = resetAt || (message ? parseLimitReset(message, Date.now(), this.tz(userId)) : null);
    this.block(st, c, until, undefined, { free: isFreeLimit(message || ''), link: o.link, retry: o.retry, estimated: true });
    this.save(st);
    this.emit(st);
  }

  private block(st: EngineState, c: ProviderConfig, until: number | null, label?: string, o: { free?: boolean; link?: string; retry?: { at: number; bot: string }; estimated?: boolean } = {}) {
    const now = Date.now();
    const prev = st.blocked;
    const u = until && until > now ? until : null;
    st.blocked = { at: prev?.at || now, until: u ?? prev?.until ?? null, label: label || prev?.label, clearAt: u ? undefined : now + DEFAULT_LIMIT_WAIT_MS, notified: prev?.notified, estimated: u ? !!o.estimated : prev?.estimated };
    const worth = !st.blocked.until || st.blocked.until - now > QUIET_BLOCK_MS;
    if (!st.blocked.notified && worth) {
      st.blocked.notified = true;
      const clock = (ms: number) => clockTime(ms, this.tz(c.user_id), userLocale(this.ctx.store, c.user_id));
      const when = st.blocked.until ? clock(st.blocked.until) : null;
      // Unknown reset, and the bot of this chat tries again by itself: the time it does, as the chat says it.
      const retry = !when && o.retry ? `${o.retry.bot} probeert het rond ${clock(o.retry.at)} automatisch opnieuw.` : '';
      this.notify(c, {
        title: o.free ? `De gratis limiet van ${c.name} is bereikt` : `${c.name} heeft zijn gebruikslimiet bereikt`,
        // Whole sentences, so the page and a push translate each one ("Weer beschikbaar rond {0}.").
        body: [st.blocked.label ? `${st.blocked.label}.` : '', when ? `Weer beschikbaar rond ${when}.` : 'Nog niet bekend wanneer het weer kan.', retry, 'Bots met een reserve-engine gaan daarop verder.'].filter(Boolean).join(' '),
        level: 'limit',
        link: o.link,
      });
    }
    this.arm(st, c);
  }

  private unblock(st: EngineState, c: ProviderConfig, why: 'reset' | 'gemeld' | 'stil') {
    if (!st.blocked) return;
    const told = st.blocked.notified;
    st.blocked = null;
    for (const [id, n] of Object.entries(st.notified)) if (n.level === 'limit') delete st.notified[id];
    // "Weer beschikbaar" only follows a "bereikt" that was said, and only when the engine's reset or report says so.
    if (told && why !== 'stil') this.notify(c, { title: `${c.name} is weer beschikbaar`, body: why === 'reset' ? 'De gebruikslimiet is gereset; je bots gebruiken hem weer.' : 'De engine meldt dat hij weer werkt.', level: 'reset' });
  }

  /** One notification per window per level; a new period (reset moved on) starts over. */
  private evaluate(st: EngineState, c: ProviderConfig) {
    const a = this.alerts(c.user_id);
    for (const w of st.windows) {
      const prev = st.notified[w.id];
      if (prev && w.resetsAt && prev.resetsAt && w.resetsAt - prev.resetsAt > 10 * 60_000) delete st.notified[w.id];
      const level: LimitLevel = w.level === 'limit' ? 'limit' : w.usedPercent !== null && w.usedPercent >= a.warnAt ? 'warn' : w.level;
      const before = st.notified[w.id]?.level;
      if ((level === 'warn' || level === 'limit') && rank(level) > rank(before)) {
        st.notified[w.id] = { level, resetsAt: w.resetsAt };
        // "Reached" is said once by block(); a window that only warns gets its own message.
        if (level === 'warn') {
          const when = w.resetsAt ? clockTime(w.resetsAt, this.tz(c.user_id), userLocale(this.ctx.store, c.user_id)) : null;
          this.notify(c, { title: `${c.name}: ${Math.round(w.usedPercent!)}% van je limiet gebruikt`, body: when ? `${w.label} · reset rond ${when}.` : `${w.label}.`, level: 'warn' });
        }
      } else if (level === 'ok' && before) delete st.notified[w.id];
    }
  }

  private notify(c: ProviderConfig, n: { title: string; body: string; level: 'warn' | 'limit' | 'reset'; link?: string }) {
    if (!this.alerts(c.user_id).enabled) return;
    this.ctx.events.emit(c.user_id, 'notification', { title: n.title, body: n.body, link: n.link || '#/m/usage/', kind: 'limit', level: n.level, providerId: c.id });
    this.ctx.audit(c.user_id, `usage.limit_${n.level}`, { provider: c.id, title: n.title });
  }

  /** Timer for the earliest known reset of a blocked engine (also after a restart). */
  private arm(st: EngineState, c: ProviderConfig) {
    clearTimeout(this.timers.get(st.providerId));
    this.timers.delete(st.providerId);
    const until = st.blocked?.until || st.blocked?.clearAt;
    if (!until) return;
    const t = setTimeout(() => {
      this.timers.delete(st.providerId);
      const cur = this.state(st.providerId);
      const due = cur.blocked?.until || cur.blocked?.clearAt;
      if (!due || due > Date.now() + 1000) return;
      cur.windows = mergeWindows(cur.windows, [], Date.now());
      this.unblock(cur, c, cur.blocked?.until ? 'reset' : 'stil');
      this.save(cur);
      this.emit(cur);
    }, Math.max(200, Math.min(until - Date.now() + 1000, 2_000_000_000)));
    t.unref?.();
    this.timers.set(st.providerId, t);
  }

  resumeTimers() {
    for (const r of this.ctx.store.all<{ provider_id: string }>('SELECT provider_id FROM usage_engines')) {
      const c = this.ctx.providers.config(r.provider_id);
      if (!c) continue;
      const st = this.state(c.id, c.user_id);
      const due = st.blocked?.until || st.blocked?.clearAt;
      if (st.blocked && (!due || due <= Date.now())) {
        st.windows = mergeWindows(st.windows, [], Date.now());
        st.blocked = null;
        for (const [id, n] of Object.entries(st.notified)) if (n.level === 'limit') delete st.notified[id];
        this.save(st);
      } else this.arm(st, c);
    }
  }

  stop() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const p of this.soon.values()) clearTimeout(p.timer);
    this.soon.clear();
  }

  private emit(st: EngineState) {
    this.ctx.events.emit(st.userId, 'usage.updated', { providerId: st.providerId });
  }

  // ---------------- explicit reads ----------------

  canRead(c: ProviderConfig) {
    return READERS.has(c.kind) && !!this.ctx.services['cli-agents']?.readLimits;
  }

  /** Ask the CLI for its limits (cached for two minutes unless forced; one read at a time per provider). */
  refresh(c: ProviderConfig, force = false): Promise<EngineState> {
    const st = this.state(c.id, c.user_id);
    if (!this.canRead(c)) return Promise.resolve(st);
    if (!force && st.checkedAt && Date.now() - st.checkedAt < READ_EVERY_MS) return Promise.resolve(st);
    const busy = this.reading.get(c.id);
    if (busy) return busy;
    const p = (async () => {
      try {
        const r = await this.ctx.services['cli-agents'].readLimits(c, this.tz(c.user_id));
        const cur = this.state(c.id, c.user_id);
        cur.checkedAt = Date.now();
        cur.unsupported = r.unsupported;
        if (r.stats !== undefined) cur.stats = r.stats;
        if (r.report) this.report(c, r.report);
        cur.error = r.report ? undefined : r.error;
        this.save(cur);
        this.emit(cur);
        return cur;
      } catch (e: any) {
        const cur = this.state(c.id, c.user_id);
        cur.checkedAt = Date.now();
        cur.error = String(e?.message || e).slice(0, 300);
        this.save(cur);
        return cur;
      } finally {
        this.reading.delete(c.id);
      }
    })();
    this.reading.set(c.id, p);
    return p;
  }

  // ---------------- views ----------------

  private spend(providerId: string, sinceIso: string) {
    const r = this.ctx.store.one<any>('SELECT COUNT(*) AS calls, COALESCE(SUM(input + output), 0) AS tokens, COALESCE(SUM(cost), 0) AS cost, SUM(value) AS value, COUNT(value) AS valued FROM usage_log WHERE provider_id = ? AND created_at >= ?', providerId, sinceIso);
    return { calls: r?.calls || 0, tokens: r?.tokens || 0, cost: r?.cost || 0, value: r?.valued ? r.value : null };
  }

  async engineView(c: ProviderConfig) {
    const st = this.state(c.id, c.user_id);
    const kind = this.ctx.providers.kind(c.kind);
    const type = kind?.type || 'api';
    let billing: string = LOCAL.has(c.kind) ? 'free' : type === 'api' ? 'paid' : kind?.billing || 'unknown';
    let billingPath = '';
    if (type === 'cli') {
      const s = await Promise.resolve(this.ctx.services['cli-agents']?.status?.(c.kind)).catch(() => null);
      if (s?.billing === 'subscription') billing = 'subscription';
      else if (s?.billing === 'api') billing = 'paid';
      billingPath = s?.billingPath && s.billingPath !== 'Onbekend' ? s.billingPath : '';
    }
    if (st.billing === 'subscription' && billing === 'unknown') billing = 'subscription';
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const windows = mergeWindows(st.windows, [], Date.now());
    const runner = this.ctx.services.runner?.limited?.get?.(c.id);
    return {
      providerId: c.id,
      name: c.name,
      kind: c.kind,
      kindLabel: kind?.label || c.kind,
      type,
      enabled: c.enabled,
      billing,
      billingPath,
      plan: st.plan || null,
      note: st.note || null,
      windows,
      worst: worstWindow(windows),
      blocked: st.blocked || null,
      /** Until when the runner skips this engine (reserve engines take over). */
      pausedUntil: runner && runner.until > Date.now() ? runner.until : null,
      canRead: this.canRead(c),
      reading: this.reading.has(c.id),
      source: st.source || null,
      updatedAt: st.updatedAt || null,
      checkedAt: st.checkedAt || null,
      error: st.error || null,
      unsupported: st.unsupported || null,
      stats: st.stats || null,
      spend: { today: this.spend(c.id, today.toISOString()), week: this.spend(c.id, new Date(Date.now() - 7 * 864e5).toISOString()) },
    };
  }

  /** The user's own enabled providers, most urgent first; the bot's provider first when asked. */
  async engines(userId: string) {
    const list = this.ctx.providers.list(userId).filter((p) => p.user_id === userId);
    const views = await Promise.all(list.map((c) => this.engineView(c)));
    return views.sort((a, b) => Number(b.enabled) - Number(a.enabled) || rank(b.worst?.level) - rank(a.worst?.level) || a.name.localeCompare(b.name));
  }

  // ---------------- keeping the bar live after a run ----------------

  /** Wait after a run before asking the CLI: several runs that end close together share one read. */
  afterRunDelayMs = 15_000;
  /** Because of runs, at most one read per engine per minute (opening the page or "Vernieuwen" may ask sooner). */
  minReadGapMs = 60_000;
  private soon = new Map<string, { timer: NodeJS.Timeout; since: number; ended: number }>();
  private seenRuns = new Set<string>();

  /**
   * A run ended (run.updated). Claude Code and Codex tell the window that matters during the run (stream); when that
   * did not cover every window the bar shows (Claude names one window per request, Codex's live update often only
   * the 5-hour one), the CLI is asked once, a little later, so the bar is right within a minute of new usage. Reading
   * costs no quota (Claude: the local /usage command; Codex: the app-server), and never more than once a minute.
   */
  runEnded(run: Run) {
    if (!run?.id || !['done', 'error', 'cancelled', 'interrupted'].includes(run.status)) return;
    if (this.seenRuns.has(run.id)) return;
    if (this.seenRuns.size > 2000) this.seenRuns.clear();
    this.seenRuns.add(run.id);
    const since = Date.parse(run.started_at || run.created_at) || Date.now();
    const ids = new Set<string>();
    if (run.meta?.engine?.provider_id) ids.add(String(run.meta.engine.provider_id));
    const agent = this.ctx.store.agent(run.agent_id);
    if (agent?.provider_id) ids.add(agent.provider_id);
    for (const r of this.ctx.store.all<{ provider_id: string }>('SELECT DISTINCT provider_id FROM usage_log WHERE agent_id = ? AND user_id = ? AND created_at >= ? AND provider_id IS NOT NULL', run.agent_id, run.user_id, new Date(since).toISOString())) ids.add(r.provider_id);
    for (const id of ids) {
      const c = this.ctx.providers.config(id);
      if (c?.enabled && (c.kind === 'claude-code' || c.kind === 'codex-cli') && this.canRead(c)) this.readSoon(c, since);
    }
    // The per-bot numbers on the usage page changed.
    this.ctx.events.emit(run.user_id, 'usage.spend', { agentId: run.agent_id });
  }

  private readSoon(c: ProviderConfig, since: number) {
    const ended = Date.now();
    const pending = this.soon.get(c.id);
    if (pending) {
      pending.since = Math.min(pending.since, since);
      pending.ended = Math.max(pending.ended, ended);
      return;
    }
    const st = this.state(c.id, c.user_id);
    const gap = st.checkedAt ? st.checkedAt + this.minReadGapMs - ended : 0;
    const entry = { since, ended, timer: null as unknown as NodeJS.Timeout };
    entry.timer = setTimeout(() => {
      this.soon.delete(c.id);
      const cfg = this.ctx.providers.config(c.id);
      if (!cfg?.enabled) return;
      const cur = this.state(c.id, c.user_id);
      // Already read after the run (the page, a refresh): nothing new to ask.
      if (cur.checkedAt && cur.checkedAt >= entry.ended) return;
      // The run's own report covered every window the bar shows (known from a full read before: a first run on a
      // fresh install names only one window, and the others are learnt by reading).
      if (cur.checkedAt && cur.streamAt && cur.streamAt >= entry.since && cur.windows.length && cur.windows.every((w) => cur.streamIds?.includes(w.id))) return;
      void this.refresh(cfg, true).catch(() => {});
    }, Math.max(this.afterRunDelayMs, gap));
    entry.timer.unref?.();
    this.soon.set(c.id, entry);
  }

  // ---------------- free sources (the dots) and the weekly reserve ----------------

  private reported: Map<string, StoredSource> | null = null;
  private reserves = new Map<string, ReserveView & { userId: string }>();
  private localSeen = new Map<string, { at: number; ok: boolean | null; busy: boolean }>();

  private reportedMap() {
    if (this.reported) return this.reported;
    const m = new Map<string, StoredSource>();
    for (const r of this.ctx.store.all<{ id: string; user_id: string; data: string }>('SELECT id, user_id, data FROM usage_sources')) {
      try {
        m.set(`${r.user_id}|${r.id}`, { ...JSON.parse(r.data), id: r.id, userId: r.user_id, origin: 'reported' });
      } catch {
        /* a damaged row is skipped */
      }
    }
    return (this.reported = m);
  }

  /**
   * Another module (the free-model chain) reports a free source: one dot in the usage bar, "beschikbaar" or "op tot …".
   * Remembered across restarts; the UI is told only when something changed. See bar.ts (SourceReport) and
   * docs/modules/usage.md. Returns what the bar will show, or null when the report has no usable id or label.
   */
  reportSource(report: SourceReport): SourceView | null {
    const s = cleanSource(report);
    if (!s) return null;
    const m = this.reportedMap();
    const key = `${s.userId}|${s.id}`;
    const prev = m.get(key);
    m.set(key, s);
    const { userId, id, ...data } = s;
    if (!sameSource(prev, s)) {
      this.ctx.store.exec(
        'INSERT INTO usage_sources (id, user_id, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id, user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
        id,
        userId,
        JSON.stringify(data),
        isoNow(),
      );
      this.ctx.events.emit(userId, 'usage.updated', { sourceId: id });
    }
    return { id, ...data };
  }

  /** Remove a reported source (its dot disappears). */
  clearSource(id: string, userId?: string | null): boolean {
    const u = userId || '*';
    if (!this.reportedMap().delete(`${u}|${id}`)) return false;
    this.ctx.store.exec('DELETE FROM usage_sources WHERE id = ? AND user_id = ?', id, u);
    this.ctx.events.emit(u, 'usage.updated', { sourceId: id });
    return true;
  }

  /**
   * The weekly reserve of the free-model chain (from `atPercent` of the Claude week, ordinary work goes to free models):
   * shown as a mark on that bar, and "nu actief" while it is in force. Kept in memory; report it again after a restart.
   */
  reportReserve(r: ReserveReport): ReserveView | null {
    const v = cleanReserve(r);
    if (!v) return null;
    const key = `${v.userId}|${v.providerId || ''}|${v.windowId}`;
    const prev = this.reserves.get(key);
    this.reserves.set(key, v);
    if (!prev || prev.atPercent !== v.atPercent || prev.active !== v.active) this.ctx.events.emit(v.userId, 'usage.updated', { reserve: true });
    const { userId: _u, ...view } = v;
    return view;
  }

  clearReserve(o: { userId?: string | null; providerId?: string | null; windowId?: string } = {}): boolean {
    const key = `${o.userId || '*'}|${o.providerId || ''}|${o.windowId || 'seven_day'}`;
    if (!this.reserves.delete(key)) return false;
    this.ctx.events.emit(o.userId || '*', 'usage.updated', { reserve: true });
    return true;
  }

  /** Is a local model server reachable? Its own fingerprint endpoint (providers/local.ts); tests replace this. */
  probeLocal = async (c: ProviderConfig): Promise<boolean> => {
    const p = LOCAL_PROBES[c.kind];
    const base = c.base_url || this.ctx.providers.kind(c.kind)?.baseUrl || p?.baseUrl;
    if (!p || !base) return true;
    return !!(await p.identify(base).catch(() => null));
  };

  /** Reachable or not, from the last check (at most once a minute, in the background: the bar never waits for it). */
  private localStatus(c: ProviderConfig): SourceStatus {
    if (!LOCAL_PROBES[c.kind]) return 'available';
    let e = this.localSeen.get(c.id);
    if (!e) this.localSeen.set(c.id, (e = { at: 0, ok: null, busy: false }));
    if (!e.busy && Date.now() - e.at > LOCAL_CHECK_MS) {
      const entry = e;
      entry.busy = true;
      void this.probeLocal(c)
        .catch(() => false)
        .then((ok) => {
          const changed = entry.ok !== ok;
          Object.assign(entry, { ok, at: Date.now(), busy: false });
          if (changed) this.ctx.events.emit(c.user_id, 'usage.updated', { providerId: c.id });
        });
    }
    return e.ok === null ? 'unknown' : e.ok ? 'available' : 'offline';
  }

  /** The dot TeamBot derives from a free or local provider: used up while a limit is known, else available. */
  private engineSource(c: ProviderConfig, local: boolean, st: EngineState, pausedUntil: number | null, now: number): SourceView {
    const retired = (this.ctx.providers.kind(c.kind) as { retired?: string } | undefined)?.retired;
    // A service that stopped (GitHub Models, 30 July 2026) is never "beschikbaar".
    if (retired) return { id: `provider:${c.id}`, label: c.name, status: 'offline', resetsAt: null, usedPercent: null, estimated: false, note: `Gestopt op ${new Date(`${retired}T12:00:00Z`).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' })}. Kies een andere gratis bron.`, providerId: c.id, kind: 'free', origin: 'engine', at: now };
    const blocked = st.blocked && (!st.blocked.until || st.blocked.until > now) ? st.blocked : null;
    const limited = !!blocked || !!pausedUntil;
    const until = blocked ? blocked.until : pausedUntil;
    return {
      id: `provider:${c.id}`,
      label: c.name,
      status: limited ? 'limited' : local ? this.localStatus(c) : 'available',
      resetsAt: limited ? until || null : null,
      usedPercent: null,
      // The reset of a free limit comes from the engine's error text ("try again in 3 hours") or is unknown.
      estimated: limited ? !until || !blocked || !!blocked.estimated : false,
      note: local
        ? 'Draait op je eigen computer, zonder limiet.'
        : c.kind === 'opencode'
          ? 'Gratis modellen van OpenCode. OpenCode meldt geen tegoed: TeamBot ziet de limiet pas als die bereikt is.'
          : 'Gratis tegoed van de aanbieder. TeamBot ziet de limiet pas als die bereikt is.',
      providerId: c.id,
      kind: local ? 'local' : 'free',
      origin: 'engine',
      at: blocked?.at || now,
    };
  }

  // ---------------- the always-visible bar and usage per bot ----------------

  /**
   * The usage bar: the windows of the subscription engines (Claude 5 hours / week / model weeks, Codex 5 hours / week)
   * and one dot per free source (derived from free/local providers, plus what other modules report). Cheap: no CLI is
   * asked here (the route does that in the background when asked to refresh).
   */
  bar(userId: string) {
    const now = Date.now();
    const mine = this.ctx.providers.list(userId).filter((p) => p.user_id === userId && p.enabled);
    const reserves = [...this.reserves.values()].filter((r) => r.userId === '*' || r.userId === userId);
    // The weekly reserve of "Gratis doorschakelen" (engine-chain): above it, ordinary work leaves Claude or Codex (the
    // runner's weekUse windows). Shown as a mark on those week bars unless another module reported its own reserve.
    let weekly = 0;
    try {
      weekly = Number(this.ctx.services.engineChain?.settings?.({ userId })?.weeklyReserve) || 0;
    } catch {
      weekly = 0;
    }
    const engines: any[] = [];
    const derived = new Map<string, SourceView>();
    for (const c of mine) {
      const kind = this.ctx.providers.kind(c.kind);
      const st = this.state(c.id, c.user_id);
      const runner = this.ctx.services.runner?.limited?.get?.(c.id);
      const pausedUntil = runner && runner.until > now ? runner.until : null;
      const local = kind?.billing === 'local' || LOCAL.has(c.kind);
      if (local || kind?.billing === 'free') {
        derived.set(c.id, this.engineSource(c, local, st, pausedUntil, now));
        continue;
      }
      const family = c.kind === 'claude-code' ? 'claude' : c.kind === 'codex-cli' ? 'codex' : 'other';
      const windows = sortWindows(mergeWindows(st.windows, [], now));
      // A CLI on a pay-per-use key, or an engine that never reported a window: nothing to show as a bar.
      if (!windows.length && (family === 'other' || st.billing === 'api')) continue;
      const chainReserve = (w: LimitWindow) =>
        weekly > 0 && (family === 'claude' || family === 'codex') && (w.id === 'seven_day' || /:10080$/.test(w.id)) ? { atPercent: weekly, active: typeof w.usedPercent === 'number' && w.usedPercent >= weekly } : undefined;
      const reserveOf = (w: LimitWindow) => reserves.find((r) => r.windowId === w.id && (r.providerId ? r.providerId === c.id : family === 'claude')) || chainReserve(w);
      const blocked = st.blocked && (!st.blocked.until || st.blocked.until > now) ? st.blocked : null;
      engines.push({
        providerId: c.id,
        name: c.name,
        kind: c.kind,
        family,
        plan: st.plan || null,
        windows: windows.map((w) => {
          const r = reserveOf(w);
          return { id: w.id, label: w.label, usedPercent: w.usedPercent, resetsAt: w.resetsAt, level: w.level, at: w.at, estimated: !!w.estimated, reserveAt: r ? r.atPercent : null, reserveActive: !!r?.active };
        }),
        blocked: blocked ? { until: blocked.until, estimated: !blocked.until || !!blocked.estimated } : null,
        pausedUntil,
        updatedAt: st.updatedAt || null,
        checkedAt: st.checkedAt || null,
        reading: this.reading.has(c.id),
        canRead: this.canRead(c),
        error: !windows.length ? st.error || st.unsupported || null : null,
      });
    }
    const order = { claude: 0, codex: 1, other: 2 } as Record<string, number>;
    engines.sort((a, b) => order[a.family] - order[b.family] || a.name.localeCompare(b.name));

    // Reported sources: one per id (a user's own report goes before one for everybody).
    const byId = new Map<string, StoredSource>();
    for (const s of this.reportedMap().values()) {
      if (s.userId !== '*' && s.userId !== userId) continue;
      if (!byId.has(s.id) || s.userId !== '*') byId.set(s.id, s);
    }
    const sources: SourceView[] = [];
    const strip = ({ userId: _u, ...v }: StoredSource): SourceView => v;
    for (const d of derived.values()) {
      const r = [...byId.values()].find((x) => x.providerId === d.providerId);
      // A limit TeamBot saw itself (a run hit it) is newer news than an older report about the same provider.
      sources.push(r && !(d.status === 'limited' && d.at > r.at) ? { ...strip(r), providerId: d.providerId } : d);
    }
    for (const r of byId.values()) {
      if (r.providerId && (derived.has(r.providerId) || !mine.some((c) => c.id === r.providerId))) continue;
      sources.push(strip(r));
    }
    const shown = sources.map((s) => effectiveSource(s, now)).sort((a, b) => Number(a.kind === 'local') - Number(b.kind === 'local') || a.label.localeCompare(b.label));
    return { engines, sources: shown, now };
  }

  /** Who pays for a provider, in the words of the usage page. */
  billingOf(c: ProviderConfig | null | undefined): 'subscription' | 'paid' | 'free' | 'local' | 'unknown' {
    if (!c) return 'unknown';
    const kind = this.ctx.providers.kind(c.kind);
    if (kind?.billing === 'local' || LOCAL.has(c.kind)) return 'local';
    if (kind?.billing === 'free') return 'free';
    if (kind?.type === 'cli') {
      const st = this.state(c.id, c.user_id);
      if (st.billing === 'api') return 'paid';
      return st.billing === 'subscription' || kind.billing === 'subscription' ? 'subscription' : kind.billing === 'paid' ? 'paid' : 'unknown';
    }
    return kind ? 'paid' : 'unknown';
  }

  /**
   * Usage per bot, today and this week (since Monday 00:00), from the usage log: calls, tokens, cost and the estimated
   * value of subscription work, with the engines each bot used. `by` is the grouping: 'bot', or 'team' (module teams):
   * then a row is a team (in the teams' own order, also without usage) with its bots in `children`, and work without
   * a team (no bot, a deleted bot) is one last row; `today`, `week`, `engines` and `total` keep the same shape.
   */
  breakdown(userId: string, by: 'bot' | 'team' = 'bot') {
    const todayIso = dayStart().toISOString();
    const weekIso = weekStart().toISOString();
    const rows = this.ctx.store.all<any>(
      'SELECT agent_id, provider_id, (created_at >= ?) AS today, COUNT(*) AS calls, COALESCE(SUM(input + output), 0) AS tokens, COALESCE(SUM(cost), 0) AS cost, SUM(value) AS value, COUNT(value) AS valued FROM usage_log WHERE user_id = ? AND created_at >= ? GROUP BY agent_id, provider_id, (created_at >= ?)',
      todayIso,
      userId,
      weekIso,
      todayIso,
    );
    type Spend = { calls: number; tokens: number; cost: number; value: number | null };
    const zero = (): Spend => ({ calls: 0, tokens: 0, cost: 0, value: null });
    const add = (s: Spend, r: any) => {
      s.calls += Number(r.calls) || 0;
      s.tokens += Number(r.tokens) || 0;
      s.cost += Number(r.cost) || 0;
      if (r.valued) s.value = (s.value ?? 0) + (Number(r.value) || 0);
    };
    const bots = new Map<string, { today: Spend; week: Spend; engines: Map<string, { today: Spend; week: Spend }> }>();
    const total = { today: zero(), week: zero() };
    for (const r of rows) {
      const k = r.agent_id || '';
      let b = bots.get(k);
      if (!b) bots.set(k, (b = { today: zero(), week: zero(), engines: new Map() }));
      let e = b.engines.get(r.provider_id || '');
      if (!e) b.engines.set(r.provider_id || '', (e = { today: zero(), week: zero() }));
      for (const s of [b.week, e.week, total.week]) add(s, r);
      if (r.today) for (const s of [b.today, e.today, total.today]) add(s, r);
    }
    const out = [...bots].map(([id, b]) => {
      const a = id ? this.ctx.store.agent(id) : undefined;
      return {
        key: id ? `bot:${id}` : 'none',
        /** bot; deleted = the bot no longer exists; none = work without a bot (memory upkeep, voice …). */
        kind: a ? ('bot' as const) : id ? ('deleted' as const) : ('none' as const),
        id: id || null,
        name: a?.name ?? null,
        avatar: a?.avatar || '',
        color: a?.color || '',
        today: b.today,
        week: b.week,
        engines: [...b.engines]
          .map(([pid, e]) => {
            const cfg = pid ? this.ctx.providers.config(pid) : undefined;
            return { providerId: pid || null, name: cfg?.name ?? null, billing: this.billingOf(cfg), today: e.today, week: e.week };
          })
          .sort((x, y) => y.week.tokens - x.week.tokens || y.week.calls - x.week.calls),
      };
    });
    out.sort((x, y) => y.week.tokens - x.week.tokens || y.week.calls - x.week.calls || (x.name || '').localeCompare(y.name || ''));
    const teams = this.ctx.services.teams;
    const groupings: ('bot' | 'team')[] = teams?.teamOf ? ['bot', 'team'] : ['bot'];
    if (by !== 'team' || !teams?.teamOf) return { by, groupings, since: { today: todayIso, week: weekIso }, rows: out, total };

    // Per team: the bots of each team as its children, their usage and engines added up.
    type Row = (typeof out)[number];
    const group = (children: Row[]) => {
      const today = zero();
      const week = zero();
      const engines = new Map<string, Row['engines'][number]>();
      for (const c of children) {
        for (const [s, from] of [
          [today, c.today],
          [week, c.week],
        ] as const)
          add(s, { ...from, valued: from.value !== null ? 1 : 0 });
        for (const e of c.engines) {
          const k = e.providerId || '';
          let m = engines.get(k);
          if (!m) engines.set(k, (m = { ...e, today: zero(), week: zero() }));
          add(m.today, { ...e.today, valued: e.today.value !== null ? 1 : 0 });
          add(m.week, { ...e.week, valued: e.week.value !== null ? 1 : 0 });
        }
      }
      return { today, week, engines: [...engines.values()].sort((x, y) => y.week.tokens - x.week.tokens || y.week.calls - x.week.calls) };
    };
    const byTeam = new Map<string, Row[]>();
    const loose: Row[] = [];
    for (const r of out) {
      const t = r.kind === 'bot' && r.id ? (teams.teamOf(r.id) as string | null) : null;
      if (t) byTeam.set(t, [...(byTeam.get(t) || []), r]);
      else loose.push(r);
    }
    type TeamRow = { key: string; kind: 'team' | 'none'; id: string | null; name: string | null; avatar: string; color: string; children: Row[] } & ReturnType<typeof group>;
    const teamRows: TeamRow[] = (teams.list(userId) as { id: string; name: string; color: string }[]).map((t) => {
      const children = byTeam.get(t.id) || [];
      byTeam.delete(t.id);
      return { key: `team:${t.id}`, kind: 'team', id: t.id, name: t.name, avatar: '', color: t.color || '', ...group(children), children };
    });
    // A bot whose team is not (or no longer) one of the owner's: with the work without a team.
    for (const list of byTeam.values()) loose.push(...list);
    if (loose.length) teamRows.push({ key: 'none', kind: 'none', id: null, name: null, avatar: '', color: '', ...group(loose), children: loose });
    return { by, groupings, since: { today: todayIso, week: weekIso }, rows: teamRows, total };
  }

  // ---------------- context ----------------

  setContext(threadId: string, agentId: string, c: { used: number; window: number | null; engine: string; providerId: string; keepWindow?: boolean }) {
    if (!threadId || !agentId || !(c.used > 0)) return;
    const prev = this.getContext(threadId, agentId);
    const window = c.window ?? (c.keepWindow && prev?.providerId === c.providerId ? prev.window : null);
    const v: ContextState = { used: Math.round(c.used), window, engine: c.engine, providerId: c.providerId, at: Date.now() };
    this.ctx.store.exec(
      'INSERT INTO usage_context (thread_id, agent_id, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(thread_id, agent_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
      threadId,
      agentId,
      JSON.stringify(v),
      isoNow(),
    );
    const t = this.ctx.store.thread(threadId);
    if (t) this.ctx.chat.emit(t, 'usage.context', { threadId, agentId });
  }

  getContext(threadId: string, agentId: string): ContextState | null {
    const r = this.ctx.store.one<{ data: string }>('SELECT data FROM usage_context WHERE thread_id = ? AND agent_id = ?', threadId, agentId);
    try {
      return r ? JSON.parse(r.data) : null;
    } catch {
      return null;
    }
  }

  /** What the context ring shows for a bot in a chat. */
  contextView(agent: Agent, thread: Thread) {
    const providerId = agent.provider_id || this.ctx.store.getSetting<string | null>(thread.user_id, 'defaultProvider', null);
    const cfg = this.ctx.providers.config(providerId);
    const kind = cfg ? this.ctx.providers.kind(cfg.kind) : undefined;
    if (!cfg) return { kind: 'none' as const, note: 'Deze bot heeft nog geen AI-provider.' };
    if (kind?.type === 'cli') {
      const c = this.getContext(thread.id, agent.id);
      const mine = c && c.providerId === cfg.id ? c : null;
      const claude = cfg.kind === 'claude-code';
      const session = !!this.ctx.store.one('SELECT 1 FROM cli_sessions WHERE thread_id = ? AND agent_id = ? AND provider_id = ?', thread.id, agent.id, cfg.id);
      return {
        kind: 'engine' as const,
        engine: cfg.name,
        used: mine?.used ?? null,
        window: mine?.window ?? null,
        percent: mine?.used && mine.window ? Math.min(100, Math.round((mine.used / mine.window) * 1000) / 10) : null,
        at: mine?.at ?? null,
        estimated: false,
        // Every CLI engine can be compacted now (agent/compaction.ts): its own way, or a TeamBot summary + new session.
        canCompact: session || !!thread.meta?.summary || this.ctx.store.one("SELECT 1 FROM messages WHERE thread_id = ? AND author_id = ? AND role = 'assistant' AND status = 'done' LIMIT 1", thread.id, agent.id) !== undefined,
        compactNote: `${claude && session ? 'Claude Code vat de sessie van dit gesprek samen (/compact).' : cfg.kind === 'codex-cli' && session ? 'Codex vat de sessie van dit gesprek samen.' : `TeamBot vat het gesprek samen; ${agent.name} gaat dan verder in een nieuwe ${cfg.name}-sessie met die samenvatting.`} ${agent.settings?.compaction === false ? 'Automatisch samenvatten staat uit voor deze bot.' : 'Vanzelf bij 75%, aan het begin van de volgende beurt.'}`,
        note: mine ? null : `${cfg.name} heeft in dit gesprek nog geen contextgrootte gemeld.`,
      };
    }
    const h = historyFill(this.ctx, agent, thread);
    return {
      kind: 'history' as const,
      engine: cfg.name,
      used: h.used,
      window: h.budget,
      percent: Math.min(100, Math.round((h.used / h.budget) * 1000) / 10),
      at: Date.now(),
      estimated: true,
      canCompact: true,
      compactNote: h.auto ? 'TeamBot vat het oudere deel vanzelf samen bij 75%.' : 'Automatisch samenvatten staat uit voor deze bot.',
      note: null,
    };
  }

  // ---------------- what is running / waiting (status window, phone) ----------------

  /**
   * "Nu bezig" (0.4.5): the bot's own browser while it runs, for a small live picture and Bekijken / Overnemen (module
   * browser: live view and take-over). Only the page the bot shows and who has control; null without a running browser.
   */
  private browserOf(agentId: string): { url: string; title: string; controller: { kind: 'bot' | 'user'; name: string } | null; filling: boolean } | null {
    try {
      const st = this.ctx.services.computers?.status?.(agentId);
      if (!st?.browser?.running) return null;
      const c = st.controller;
      return { url: String(st.browser.url || '').slice(0, 300), title: String(st.browser.title || '').slice(0, 160), controller: c ? { kind: c.kind === 'user' ? 'user' : 'bot', name: String(c.name || '') } : null, filling: !!st.browser.filling };
    } catch {
      return null;
    }
  }

  status(userId: string) {
    const runs = this.ctx.runs.activeRuns(userId).map((r) => {
      const a = this.ctx.store.agent(r.agent_id);
      const t = this.ctx.store.thread(r.thread_id);
      const row = this.ctx.store.one<any>("SELECT * FROM messages WHERE run_id = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1", r.id);
      const m = row ? this.ctx.store.decode<any>('messages', row) : null;
      const act = Array.isArray(m?.parts?.activity) ? m.parts.activity[m.parts.activity.length - 1] : null;
      const calls = Array.isArray(m?.parts?.toolCalls) ? m.parts.toolCalls.filter((c: any) => c.status === 'running' || c.status === 'pending') : [];
      const doing = r.status === 'waiting' ? 'wacht op jou' : r.status === 'queued' ? 'in de wachtrij' : act?.title ? String(act.title) : calls[0]?.summary || (calls[0]?.name ? toolLabel({ name: calls[0].name }, true) : m?.content ? 'schrijft een antwoord' : 'denkt na');
      return { id: r.id, status: r.status, threadId: r.thread_id, threadTitle: t?.title || '', agentId: r.agent_id, agentName: a?.name || 'Bot', avatar: a?.avatar || '', color: a?.color || '', doing: doing.slice(0, 160), startedAt: r.started_at || r.created_at, trigger: r.trigger, browser: this.browserOf(r.agent_id) };
    });
    const approvals = this.ctx.store
      .all<any>("SELECT * FROM approvals WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 50", userId)
      .map((x) => this.ctx.store.decode<any>('approvals', x))
      .map((x) => ({ id: x.id, kind: x.kind, risk: x.risk, summary: x.summary, tool: x.tool, options: x.options, threadId: x.thread_id, agentId: x.agent_id, agentName: x.agent_id ? this.ctx.store.agent(x.agent_id)?.name || 'Bot' : 'Bot', createdAt: x.created_at }));
    return { runs, approvals };
  }
}
