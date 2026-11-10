import type { Ctx, ModelInfo, ProviderAdapter, ProviderConfig } from '../../core/types.js';
import { now as isoNow } from '../../core/db.js';
import { categoryOf, fetchJson } from '../../providers/common.js';
import { CHECKED, FREE_SOURCES, ROUTER, cardSources, sourceDef, type FreeSourceDef } from './sources.js';
import { privacyFits, privacyLabel, type PrivacyLabel, type PrivacyLevel } from './privacy.js';
import { groqLimits, limitCooldown, nextUtcMidnight, openrouterFree, type Window } from './quota.js';
import { familyOf } from './family.js';
import { hasBuiltinPrivacy, registerPrivacyRule } from '../network/privacy.js';

/**
 * The free-model catalogue and quota tracker (package D1). See docs/modules/free-models.md.
 *
 * Per free source (= one provider connection = one account) TeamBot keeps: a cooldown after a 429 until the known
 * reset, a broken key, what is left today where the provider says so (OpenRouter /key, Groq headers), and the list of
 * free models with a tested label ("tools werken" / "alleen tekst"), refreshed daily. Real traffic through the free
 * provider kinds is tracked automatically (see `wrap`); `report()` is for what the tracker cannot see itself.
 */

const MIN = 60_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** Model lists are fetched again after a day (free: no prompt). */
const REFRESH_EVERY = DAY;
/** After a failed list fetch, try again after an hour. */
const RETRY_REFRESH = HOUR;
/** Never more than one probe per model per day. */
const PROBE_MIN_GAP = DAY;
/** A tested label is checked again after a week (probes come out of the free quota). */
const REPROBE_EVERY = 7 * DAY;
/** A vanished model that the provider lists again gets one new probe after a day (catalogues keep ghost entries). */
const GONE_RECHECK = DAY;
const MAX_MODELS = 25;
const KEY_READ_EVERY = 10 * MIN;
/** Answers in a row that failed (outage, broken answer) before a model rests. */
const FAIL_LIMIT = 3;
const OUTAGE_REST = 10 * MIN;
const UNREACHABLE_REST = 2 * MIN;
const TICK_EVERY = 30 * MIN;
/** Shown in the card even before they are connected: the free CLI (OpenCode) and the usual local engine (Ollama). */
const ALWAYS_LISTED = new Set(['opencode', 'ollama']);
const NOT_CHAT = /(embed|rerank|whisper|tts|transcribe|speech|bge-|clip|moderation|guard)/i;

export type ToolsLabel = 'tools' | 'text' | 'unknown';
export const TOOLS_TEXT: Record<ToolsLabel, string> = { tools: 'tools werken', text: 'alleen tekst', unknown: 'nog niet getest' };

interface Cool {
  until: number;
  reason: string;
  known: boolean;
  /** Set from response headers (Groq: 0 requests left): a success does not clear it. */
  fromHeaders?: boolean;
  /** Set from OpenRouter's /key counter (0 left today). */
  fromKey?: boolean;
}

export interface SourceState {
  providerId: string;
  userId: string;
  kind: string;
  cooldown: Cool | null;
  limitHits: number;
  auth: { at: number; message: string } | null;
  unreachable: { at: number; until: number; message: string } | null;
  remaining: { used: number | null; limit: number | null; remaining: number | null; resetsAt: number | null; source: 'key' | 'count'; at: number } | null;
  /** Requests without a key in the last hour (Kilo counts per IP). */
  hourly: number[];
  refreshedAt: number | null;
  refreshTriedAt: number | null;
  refreshError: string | null;
  probes: { day: string; n: number };
  keyReadAt: number | null;
  lastOkAt: number | null;
}

export interface ModelState {
  providerId: string;
  model: string;
  userId: string;
  label?: string;
  context?: number;
  listed: boolean;
  listedAt: number | null;
  tools: ToolsLabel;
  toolsSource?: 'probe' | 'traffic' | 'engine';
  /** The provider's own list says the model takes tools (weak evidence: catalogues lie). */
  claimsTools?: boolean;
  probedAt: number | null;
  probeError?: string | null;
  gone: { at: number; status: number; message: string } | null;
  cooldown: Cool | null;
  failures: number;
  remaining?: { requests: Window | null; tokens: Window | null; at: number } | null;
  lastOkAt: number | null;
  rank?: number;
}

/** What happened with a call (from the runner/D2, or from the tracking wrapper). */
export type Outcome =
  | 'ok'
  | { ok: true; usedTools?: boolean; toolCalls?: number; noTools?: boolean }
  | { error: unknown }
  | { limit: true; resetAt?: number | null; message?: string }
  | { gone: true; status?: number; message?: string };

export interface CandidateQuery {
  /** Whose connections (default: the owner). */
  userId?: string;
  /** Only models that can use tools ("alleen tekst" is left out; "nog niet getest" comes after "tools werken"). */
  needTools?: boolean;
  /** The least private level allowed: local = only this computer, no-store = also "bewaart niets", may-train/any = all. */
  privacy?: PrivacyLevel | 'any';
  /** Same model family first (familyOf). */
  family?: string;
  /** Already tried: a provider id leaves the whole provider out; { providerId, model } leaves that model out and puts
   *  the provider's other models after other providers (quota counts per account). */
  exclude?: (string | { providerId: string; model?: string })[];
  /** Local models (Ollama, LM Studio …) at the end of the list (default true). */
  includeLocal?: boolean;
  limit?: number;
}

export interface Candidate {
  providerId: string;
  providerKind: string;
  providerLabel: string;
  engine: 'api' | 'cli' | 'local';
  model: string;
  modelLabel?: string;
  family: string;
  tools: ToolsLabel;
  privacy: PrivacyLabel;
  available: boolean;
  /** When it can be used again (epoch ms); null = now (available) or unknown (e.g. a broken key). */
  availableAt: number | null;
  /** The source's next known quota reset (daily counter), when known. */
  resetsAt: number | null;
  reason?: string;
  remaining?: { requests: number | null; limit: number | null } | null;
}

type Ref = string | { providerId: string; model?: string };

const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);
const short = (e: any) => String(e?.message || e || '').replace(/\s+/g, ' ').slice(0, 300);

export class FreeModelsService {
  /** Clock (tests move it). */
  now: () => number = () => Date.now();
  /** Send due probes when lists are refreshed without saying (tests switch it off to control every request). */
  autoProbe = true;
  private sources = new Map<string, SourceState>();
  private models = new Map<string, ModelState>();
  private refreshing = new Map<string, Promise<void>>();
  private probing = new Set<string>();
  private lastHeaders = new Map<string, { requests: Window | null; tokens: Window | null }>();
  private recorded = new Map<string, number>();
  private emitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;
  /** Removes this module's rules from the privacy labels of the network module again (stop). */
  private unregister: (() => void)[] = [];

  constructor(private ctx: Ctx) {}

  // ---------------- state ----------------

  load() {
    for (const r of this.ctx.store.all<{ provider_id: string; user_id: string; data: string }>('SELECT provider_id, user_id, data FROM free_sources')) {
      try {
        this.sources.set(r.provider_id, { ...this.blankSource(r.provider_id, r.user_id, ''), ...JSON.parse(r.data), providerId: r.provider_id, userId: r.user_id });
      } catch {
        /* a broken row starts over */
      }
    }
    for (const r of this.ctx.store.all<{ provider_id: string; model: string; user_id: string; data: string }>('SELECT provider_id, model, user_id, data FROM free_models')) {
      try {
        this.models.set(`${r.provider_id}\u0000${r.model}`, { ...this.blankModel(r.provider_id, r.model, r.user_id), ...JSON.parse(r.data), providerId: r.provider_id, model: r.model, userId: r.user_id });
      } catch {
        /* a broken row starts over */
      }
    }
  }

  private blankSource(providerId: string, userId: string, kind: string): SourceState {
    return { providerId, userId, kind, cooldown: null, limitHits: 0, auth: null, unreachable: null, remaining: null, hourly: [], refreshedAt: null, refreshTriedAt: null, refreshError: null, probes: { day: '', n: 0 }, keyReadAt: null, lastOkAt: null };
  }

  private blankModel(providerId: string, model: string, userId: string): ModelState {
    return { providerId, model, userId, listed: false, listedAt: null, tools: 'unknown', probedAt: null, gone: null, cooldown: null, failures: 0, lastOkAt: null };
  }

  private src(cfg: ProviderConfig): SourceState {
    let s = this.sources.get(cfg.id);
    if (!s) {
      s = this.blankSource(cfg.id, cfg.user_id, cfg.kind);
      this.sources.set(cfg.id, s);
    }
    s.kind = cfg.kind;
    return s;
  }

  private mdl(cfg: ProviderConfig, model: string): ModelState {
    const k = `${cfg.id}\u0000${model}`;
    let m = this.models.get(k);
    if (!m) {
      m = this.blankModel(cfg.id, model, cfg.user_id);
      this.models.set(k, m);
    }
    return m;
  }

  private modelsOf(providerId: string): ModelState[] {
    return [...this.models.values()].filter((m) => m.providerId === providerId);
  }

  private saveSource(s: SourceState) {
    const { providerId, userId, ...data } = s;
    this.ctx.store.exec(
      'INSERT INTO free_sources (provider_id, user_id, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(provider_id) DO UPDATE SET data = excluded.data, user_id = excluded.user_id, updated_at = excluded.updated_at',
      providerId,
      userId,
      JSON.stringify(data),
      isoNow(),
    );
  }

  private saveModel(m: ModelState) {
    const { providerId, model, userId, ...data } = m;
    this.ctx.store.exec(
      'INSERT INTO free_models (provider_id, model, user_id, data, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(provider_id, model) DO UPDATE SET data = excluded.data, user_id = excluded.user_id, updated_at = excluded.updated_at',
      providerId,
      model,
      userId,
      JSON.stringify(data),
      isoNow(),
    );
  }

  /** A provider connection was removed: forget its quota and models. */
  forget(providerId: string) {
    this.sources.delete(providerId);
    for (const k of [...this.models.keys()]) if (k.startsWith(`${providerId}\u0000`)) this.models.delete(k);
    this.ctx.store.exec('DELETE FROM free_sources WHERE provider_id = ?', providerId);
    this.ctx.store.exec('DELETE FROM free_models WHERE provider_id = ?', providerId);
  }

  /** A new key or account: the old "key broken" and limits no longer say anything. */
  keyChanged(providerId: string) {
    const s = this.sources.get(providerId);
    if (!s) return;
    s.auth = null;
    s.cooldown = null;
    s.limitHits = 0;
    s.remaining = null;
    s.refreshedAt = null;
    s.refreshTriedAt = null;
    s.keyReadAt = null;
    this.saveSource(s);
  }

  // ---------------- which sources ----------------

  offKinds(userId: string): Set<string> {
    const v = this.ctx.store.getSetting<{ off?: string[] }>(userId, 'freeModels', {});
    return new Set(Array.isArray(v?.off) ? v.off.filter((x) => typeof x === 'string') : []);
  }

  setOn(userId: string, kind: string, on: boolean) {
    const off = this.offKinds(userId);
    if (on) off.delete(kind);
    else off.add(kind);
    const cur = this.ctx.store.getSetting<any>(userId, 'freeModels', {});
    this.ctx.store.setSetting(userId, 'freeModels', { ...(cur && typeof cur === 'object' ? cur : {}), off: [...off] });
  }

  /** All connections of one kind this user may use: own first (oldest first), then shared ones. */
  private configsOf(userId: string, kind: string): ProviderConfig[] {
    return this.ctx.providers
      .list(userId)
      .filter((c) => c.kind === kind)
      .sort((a, b) => Number(b.user_id === userId) - Number(a.user_id === userId) || String(a.created_at).localeCompare(String(b.created_at)));
  }

  /** The connection TeamBot uses for a kind: one account per provider, never several combined. */
  configFor(userId: string, kind: string): ProviderConfig | null {
    return this.configsOf(userId, kind).find((c) => c.enabled) || null;
  }

  /** The free sources in use for this user: one per kind, enabled, not switched off in "Gratis modellen". */
  activeSources(userId: string): { def: FreeSourceDef; cfg: ProviderConfig }[] {
    const off = this.offKinds(userId);
    const out: { def: FreeSourceDef; cfg: ProviderConfig }[] = [];
    for (const def of FREE_SOURCES) {
      if (off.has(def.kind) || !this.ctx.providers.kind(def.kind)) continue;
      const cfg = this.configFor(userId, def.kind);
      if (cfg) out.push({ def, cfg });
    }
    return out;
  }

  private users(): string[] {
    const kinds = FREE_SOURCES.map((d) => d.kind);
    return this.ctx.store.all<{ user_id: string }>(`SELECT DISTINCT user_id FROM providers WHERE kind IN (${kinds.map(() => '?').join(',')})`, ...kinds).map((r) => r.user_id);
  }

  // ---------------- privacy ----------------

  /** The privacy label of a free source (and model) from this module's own table of terms (privacy.ts). */
  privacyOf(kind: string, model = ''): PrivacyLabel {
    return privacyLabel(kind, model);
  }

  /**
   * Give the privacy labels of the network module (package P: the chip in the chat header, the bot editor and "Wat
   * verlaat je pc?") the terms of the free sources it has no checked rule for itself (today Kilo and Z.ai), through
   * `registerPrivacyRule(kind, rule)`. Its own checked rules (Groq, OpenRouter, Cloudflare, OpenCode per model, local
   * servers by where they run) stay as they are. Called at start; stop() removes the rules again.
   */
  registerPrivacy() {
    for (const off of this.unregister.splice(0)) off();
    for (const def of FREE_SOURCES) {
      if (def.engine === 'local' || hasBuiltinPrivacy(def.kind)) continue;
      this.unregister.push(
        registerPrivacyRule(def.kind, (model) => {
          const l = privacyLabel(def.kind, model);
          return { level: l.level, receiver: def.label, detail: l.note || l.label, policyUrl: l.source, checkedAt: l.checked || CHECKED };
        }),
      );
    }
  }

  /** The connection was edited (maybe a new key): a "key broken" or failed list no longer holds. */
  touched(providerId: string) {
    const s = this.sources.get(providerId);
    if (!s) return;
    s.auth = null;
    s.refreshTriedAt = null;
    s.refreshError = null;
    this.saveSource(s);
  }

  // ---------------- traffic ----------------

  /** Wrap a free provider's adapter: every real chat call reports its outcome (429, model gone, success …). */
  wrap(inner: ProviderAdapter, cfg: ProviderConfig): ProviderAdapter {
    if (!inner.chat) return inner;
    const chat = inner.chat.bind(inner);
    return {
      ...inner,
      chat: async (req, signal, onEvent) => {
        try {
          const r = await chat(req, signal, onEvent);
          this.record(cfg, req.model, { ok: true, usedTools: req.tools.length > 0, toolCalls: r.toolCalls.length, noTools: /geen tools/i.test(r.notice || '') });
          return r;
        } catch (e) {
          if (!signal.aborted) this.record(cfg, req.model, { error: e });
          throw e;
        }
      },
    };
  }

  /** Response headers of a chat call (before its body): Groq says what is left per model. */
  observe(cfg: ProviderConfig, r: { status: number; headers: Headers; model: string }) {
    if (cfg.kind !== 'groq' || !r.model) return;
    const now = this.now();
    const g = groqLimits(r.headers, now);
    if (!g.requests && !g.tokens) return;
    this.lastHeaders.set(`${cfg.id}\u0000${r.model}`, g);
    const m = this.mdl(cfg, r.model);
    m.remaining = { ...g, at: now };
    if (g.requests?.remaining === 0 && g.requests.resetAt) m.cooldown = { until: g.requests.resetAt, reason: 'Daglimiet van dit model bereikt', known: true, fromHeaders: true };
    this.saveModel(m);
  }

  /** An outcome reported from outside (the runner / free chain). Deduplicated against what the wrapper just saw. */
  report(ref: Ref, outcome: Outcome) {
    const providerId = typeof ref === 'string' ? ref : ref?.providerId;
    const model = typeof ref === 'string' ? '' : ref?.model || '';
    const cfg = providerId ? this.ctx.providers.config(providerId) : null;
    if (!cfg || !sourceDef(cfg.kind)) return;
    const k = `${cfg.id}\u0000${model}\u0000${outcomeKind(outcome)}`;
    const at = this.recorded.get(k);
    if (at && this.now() - at < 3000) return;
    this.record(cfg, model, outcome);
  }

  private record(cfg: ProviderConfig, model: string, o: Outcome) {
    const def = sourceDef(cfg.kind);
    if (!def) return;
    const now = this.now();
    this.recorded.set(`${cfg.id}\u0000${model}\u0000${outcomeKind(o)}`, now);
    if (this.recorded.size > 500) for (const [k, t] of this.recorded) if (now - t > 10_000) this.recorded.delete(k);
    const s = this.src(cfg);
    const m = model ? this.mdl(cfg, model) : null;
    if (def.hourlyAnon && !cfg.secret_id && outcomeKind(o) !== 'gone') {
      s.hourly = [...(s.hourly || []).filter((t) => now - t < HOUR), now].slice(-1000);
    }
    if (o === 'ok' || 'ok' in o) {
      const ok = o === 'ok' ? { ok: true as const } : o;
      s.lastOkAt = now;
      s.auth = null;
      s.unreachable = null;
      s.limitHits = 0;
      s.cooldown = null;
      if (s.remaining && s.remaining.source === 'key' && s.remaining.remaining !== null && /:free$/i.test(model)) {
        s.remaining = { ...s.remaining, remaining: Math.max(0, s.remaining.remaining - 1), used: s.remaining.used !== null ? s.remaining.used + 1 : null };
      }
      if (m) {
        m.failures = 0;
        m.lastOkAt = now;
        m.gone = null;
        if (!(m.cooldown?.fromHeaders && m.cooldown.until > now)) m.cooldown = null;
        if (ok.noTools) {
          m.tools = 'text';
          m.toolsSource = 'traffic';
        } else if (ok.usedTools && (ok.toolCalls || 0) > 0 && m.tools !== 'tools') {
          m.tools = 'tools';
          m.toolsSource = 'traffic';
        }
      }
    } else if ('gone' in o) {
      if (m) this.markGone(cfg, m, o.status ?? 404, o.message || 'gemeld');
    } else if ('limit' in o) {
      this.limit(def, cfg, s, m, { message: o.message || '', resetAt: o.resetAt ?? null });
    } else {
      this.failure(def, cfg, s, m, o.error);
    }
    this.saveSource(s);
    if (m) this.saveModel(m);
    this.changed(cfg.user_id, def, cfg);
  }

  private failure(def: FreeSourceDef, cfg: ProviderConfig, s: SourceState, m: ModelState | null, e: any) {
    const now = this.now();
    const cat = categoryOf(e);
    const status = typeof e?.status === 'number' ? e.status : 0;
    const msg = short(e);
    const body = typeof e?.body === 'string' ? e.body : '';
    // OpenRouter: "No endpoints found that support tool use" — the model is there, only not with tools.
    if (m && /no endpoints found that support (tool|the requested)/i.test(`${msg} ${body}`)) {
      m.tools = 'text';
      m.toolsSource = 'traffic';
      return;
    }
    if (m && (cat === 'model' || status === 404 || status === 410)) return this.markGone(cfg, m, status || 404, msg);
    if (cat === 'auth') {
      s.auth = { at: now, message: msg };
      return;
    }
    if (cat === 'forbidden') {
      if (m) m.cooldown = { until: now + DAY, reason: 'Geen toegang tot dit model met dit account', known: false };
      return;
    }
    if (cat === 'rate_limit' || cat === 'quota' || status === 429) return this.limit(def, cfg, s, m, { message: msg, body, retryAfter: e?.retryAfter });
    if (cat === 'network') {
      s.unreachable = { at: now, until: now + UNREACHABLE_REST, message: msg };
      return;
    }
    if (cat === 'overloaded' && m) {
      m.failures = (m.failures || 0) + 1;
      if (m.failures >= FAIL_LIMIT) m.cooldown = { until: now + Math.min(2 * HOUR, OUTAGE_REST * 2 ** (m.failures - FAIL_LIMIT)), reason: 'Gaf een paar keer achter elkaar geen goed antwoord', known: false };
    }
    // context, bad_request, refusal …: about this request, not about the source.
  }

  private limit(def: FreeSourceDef, cfg: ProviderConfig, s: SourceState, m: ModelState | null, o: { message: string; body?: string; retryAfter?: number; resetAt?: number | null }) {
    const now = this.now();
    let cd = limitCooldown(def, { message: o.message, body: o.body, retryAfter: o.retryAfter, groq: m ? this.lastHeaders.get(`${cfg.id}\u0000${m.model}`) : null, hits: s.limitHits, keyless: !cfg.secret_id, now });
    if (o.resetAt && o.resetAt > now) cd = { ...cd, until: o.resetAt, known: true };
    const cool: Cool = { until: cd.until, reason: cd.reason, known: cd.known };
    if (cd.scope === 'model' && m) m.cooldown = cool;
    else s.cooldown = cool;
    s.limitHits = cd.known ? 0 : s.limitHits + 1;
    this.ctx.log.info(`[free-models] ${def.label}: ${cd.reason}, weer beschikbaar rond ${new Date(cd.until).toISOString()}${cd.known ? '' : ' (geschat)'}`);
    if (def.kind === 'openrouter') void this.readKey(def, cfg, true).catch(() => {});
  }

  private markGone(cfg: ProviderConfig, m: ModelState, status: number, message: string) {
    const first = !m.gone;
    m.gone = { at: this.now(), status, message: message.slice(0, 200) };
    m.cooldown = null;
    if (!first) return;
    // Logged, never shown as an error: the chain simply stops offering this model.
    this.ctx.log.info(`[free-models] model verdwenen bij ${cfg.name}: ${m.model} (${status})`);
    this.ctx.audit(cfg.user_id, 'free_models.model_gone', { provider: cfg.id, kind: cfg.kind, model: m.model, status });
  }

  // ---------------- lists, quota reads, probes ----------------

  /** Fetch the model list again (free: no prompt) when it is a day old, or now with `force`. */
  async refreshSource(def: FreeSourceDef, cfg: ProviderConfig, force = false): Promise<void> {
    const s = this.src(cfg);
    const now = this.now();
    if (!force && ((s.refreshedAt && now - s.refreshedAt < REFRESH_EVERY) || (s.refreshTriedAt && now - s.refreshTriedAt < RETRY_REFRESH))) return;
    const busy = this.refreshing.get(cfg.id);
    if (busy) return busy;
    const p = this.doRefresh(def, cfg, s).finally(() => this.refreshing.delete(cfg.id));
    this.refreshing.set(cfg.id, p);
    return p;
  }

  private async doRefresh(def: FreeSourceDef, cfg: ProviderConfig, s: SourceState) {
    const now = this.now();
    s.refreshTriedAt = now;
    let list: ModelInfo[];
    try {
      list = await this.ctx.providers.adapterFor(cfg).listModels();
    } catch (e) {
      s.refreshError = short(e);
      if (categoryOf(e) === 'auth') s.auth = { at: now, message: short(e) };
      this.saveSource(s);
      this.changed(cfg.user_id, def, cfg);
      return;
    }
    const recommend = this.ctx.providers.kind(cfg.kind)?.recommend || [];
    const rankOf = (id: string) => {
      const i = recommend.findIndex((r) => (typeof r === 'string' ? r === id : r.test(id)));
      return i < 0 ? 999 : i;
    };
    const free = list
      .filter((m) => m?.id && !ROUTER.test(m.id) && !NOT_CHAT.test(m.id) && def.isFree(m))
      .map((m) => ({ m, rank: rankOf(m.id) }))
      .sort((a, b) => a.rank - b.rank || (b.m.context || 0) - (a.m.context || 0) || a.m.id.localeCompare(b.m.id))
      .slice(0, MAX_MODELS);
    const seen = new Set<string>();
    free.forEach(({ m, rank }, i) => {
      const st = this.mdl(cfg, m.id);
      seen.add(m.id);
      st.listed = true;
      st.listedAt = now;
      st.label = m.label && m.label !== m.id ? m.label : undefined;
      st.context = m.context;
      st.claimsTools = m.tools;
      st.rank = rank * 100 + i;
      if (def.engine === 'cli') {
        // An agent CLI runs its own tools (OpenCode): nothing to probe, and probing would spend its free quota.
        st.tools = 'tools';
        st.toolsSource = 'engine';
      } else if (def.engine === 'local' && typeof m.tools === 'boolean') {
        // A local server says itself whether a model takes tools; loading every model for a probe would be heavy.
        st.tools = m.tools ? 'tools' : 'text';
        st.toolsSource = 'engine';
      }
      // A vanished model that is listed again: a local model is back (pulled again); an online one waits for a probe.
      if (st.gone && def.engine !== 'api') st.gone = null;
      this.saveModel(st);
    });
    for (const st of this.modelsOf(cfg.id)) {
      if (seen.has(st.model) || !st.listed) continue;
      st.listed = false;
      this.saveModel(st);
    }
    s.refreshedAt = now;
    s.refreshError = null;
    this.saveSource(s);
    if (def.kind === 'openrouter') await this.readKey(def, cfg).catch(() => {});
    this.changed(cfg.user_id, def, cfg);
  }

  /** OpenRouter: today's free requests from GET /api/v1/key (reading it costs nothing and counts for nothing). */
  async readKey(def: FreeSourceDef, cfg: ProviderConfig, force = false): Promise<void> {
    if (def.kind !== 'openrouter') return;
    const s = this.src(cfg);
    const now = this.now();
    if (!force && s.keyReadAt && now - s.keyReadAt < KEY_READ_EVERY) return;
    const key = this.ctx.secrets.get(cfg.secret_id);
    if (!key) return;
    s.keyReadAt = now;
    const base = (cfg.base_url || this.ctx.providers.kind(cfg.kind)?.baseUrl || '').replace(/\/+$/, '');
    try {
      const j = await fetchJson(`${base}/key`, { headers: { authorization: `Bearer ${key}` }, timeoutMs: 10_000 }, def.label);
      const f = openrouterFree(j);
      if (!f) return;
      const reset = nextUtcMidnight(now);
      s.remaining = { ...f, resetsAt: reset, source: 'key', at: now };
      if (f.remaining === 0) s.cooldown = { until: reset, reason: 'Daglimiet bereikt', known: true, fromKey: true };
      // Only a wait this read itself set is lifted by it (a 429 just now outweighs a counter that lags behind).
      else if (f.remaining && s.cooldown?.fromKey) s.cooldown = null;
    } catch (e) {
      if (categoryOf(e) === 'auth') s.auth = { at: now, message: short(e) };
    } finally {
      this.saveSource(s);
      this.changed(cfg.user_id, def, cfg);
    }
  }

  /**
   * One small request with one tool, to label a model "tools werken" or "alleen tekst". At most once per model per day
   * (also when asked again), within the source's daily probe budget, and never while the source waits for a reset.
   * Returns true when a probe was really sent.
   */
  async probe(cfg: ProviderConfig, model: string): Promise<boolean> {
    const def = sourceDef(cfg.kind);
    if (!def || def.engine !== 'api' || def.probesPerDay <= 0) return false;
    const now = this.now();
    const s = this.src(cfg);
    const m = this.mdl(cfg, model);
    const key = `${cfg.id}\u0000${model}`;
    if (this.probing.has(key)) return false;
    if (m.probedAt && now - m.probedAt < PROBE_MIN_GAP) return false;
    if (s.auth || (s.cooldown && s.cooldown.until > now) || (m.cooldown && m.cooldown.until > now) || (s.unreachable && s.unreachable.until > now)) return false;
    const day = dayKey(now);
    if (s.probes.day !== day) s.probes = { day, n: 0 };
    if (s.probes.n >= def.probesPerDay) return false;
    s.probes.n++;
    m.probedAt = now;
    this.saveSource(s);
    this.saveModel(m);
    this.probing.add(key);
    try {
      const adapter = this.ctx.providers.adapterFor(cfg);
      const r = await adapter.chat!(
        {
          model,
          system: 'You are a connection test. Call the tool exactly once and do not write any text.',
          messages: [{ role: 'user', content: 'Call the tool "ping" with {"text": "ok"}.' }],
          tools: [{ name: 'ping', description: 'Connection test: call this with text "ok".', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }],
          maxTokens: 512,
          reasoning: 'low',
        },
        AbortSignal.timeout(150_000),
        () => {},
      );
      const call = r.toolCalls.find((c) => c.name === 'ping' && c.args && typeof c.args === 'object' && !('__invalid_json' in c.args) && !('__invalid_call' in c.args));
      m.tools = call && !/geen tools/i.test(r.notice || '') ? 'tools' : 'text';
      m.toolsSource = 'probe';
      m.probeError = null;
    } catch (e) {
      // The outcome (429 → cooldown, 404 → gone …) is recorded by the tracking wrapper; the label stays as it was.
      m.probeError = short(e);
    } finally {
      this.probing.delete(key);
      this.saveModel(m);
      this.changed(cfg.user_id, def, cfg);
    }
    return true;
  }

  /** The model of a source that most needs a probe now (untested first), or null. */
  private dueProbe(cfg: ProviderConfig): ModelState | null {
    const now = this.now();
    const due = this.modelsOf(cfg.id).filter((m) => {
      if (!m.listed) return false;
      if (m.probedAt && now - m.probedAt < PROBE_MIN_GAP) return false;
      if (m.gone) return now - m.gone.at > GONE_RECHECK;
      return m.tools === 'unknown' || !m.probedAt || now - m.probedAt > REPROBE_EVERY;
    });
    due.sort((a, b) => Number(a.tools !== 'unknown') - Number(b.tools !== 'unknown') || (a.rank ?? 1e9) - (b.rank ?? 1e9) || (a.probedAt || 0) - (b.probedAt || 0));
    return due[0] || null;
  }

  /** Refresh the lists of this user's sources (when due, or now with force) and send due probes (one per source). */
  async refreshUser(userId: string, o: { force?: boolean; probe?: boolean } = {}) {
    const probe = o.probe ?? this.autoProbe;
    for (const { def, cfg } of this.activeSources(userId)) {
      await this.refreshSource(def, cfg, !!o.force).catch(() => {});
      if (probe && def.engine === 'api') {
        const m = this.dueProbe(cfg);
        if (m) await this.probe(cfg, m.model).catch(() => {});
      }
    }
  }

  /** Background work: daily lists, probes spread over the day (one per source per tick). */
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const userId of this.users()) await this.refreshUser(userId);
    } finally {
      this.ticking = false;
    }
  }

  start() {
    const run = () => {
      void this.tick()
        .catch((e) => this.ctx.log.warn('[free-models] tick', e?.message || e))
        .finally(() => {
          this.timer = setTimeout(run, TICK_EVERY);
          (this.timer as any).unref?.();
        });
    };
    this.timer = setTimeout(run, 20_000);
    (this.timer as any).unref?.();
  }

  stop() {
    for (const off of this.unregister.splice(0)) off();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const t of this.emitTimers.values()) clearTimeout(t);
    this.emitTimers.clear();
  }

  // ---------------- availability and candidates ----------------

  private availability(def: FreeSourceDef, cfg: ProviderConfig, s: SourceState, m: ModelState | null, now: number): { available: boolean; availableAt: number | null; resetsAt: number | null; reason?: string } {
    const daily = s.remaining?.resetsAt || (def.dailyReset === 'utc' ? nextUtcMidnight(now) : null);
    if (s.auth) return { available: false, availableAt: null, resetsAt: daily, reason: 'Sleutel ongeldig of verlopen' };
    const waits: Cool[] = [];
    if (s.cooldown && s.cooldown.until > now) waits.push(s.cooldown);
    if (m?.cooldown && m.cooldown.until > now) waits.push(m.cooldown);
    if (s.unreachable && s.unreachable.until > now) waits.push({ until: s.unreachable.until, reason: 'Niet bereikbaar', known: false });
    if (def.hourlyAnon && !cfg.secret_id) {
      const recent = (s.hourly || []).filter((t) => now - t < HOUR);
      if (recent.length >= def.hourlyAnon) waits.push({ until: Math.min(...recent) + HOUR, reason: 'Uurlimiet bereikt', known: false });
    }
    if (waits.length) {
      const w = waits.sort((a, b) => b.until - a.until)[0];
      return { available: false, availableAt: w.until, resetsAt: w.known ? w.until : daily, reason: w.reason };
    }
    return { available: true, availableAt: null, resetsAt: daily };
  }

  /** The models of a source that can be offered: listed and not gone; before the first list, the built-in list. */
  private offered(def: FreeSourceDef, cfg: ProviderConfig, s: SourceState): ModelState[] {
    const listed = this.modelsOf(cfg.id).filter((m) => m.listed && !m.gone);
    if (listed.length || s.refreshedAt) return listed;
    const builtin = (this.ctx.providers.kind(cfg.kind)?.models || []).filter((id) => !ROUTER.test(id) && def.isFree({ id, free: /:free$/i.test(id) || undefined }));
    return builtin.map((id, i) => ({ ...this.blankModel(cfg.id, id, cfg.user_id), listed: true, rank: 900 + i }));
  }

  /**
   * Free models to switch to, best first: available before waiting; online before local; a provider that was not
   * tried before one that was (quota counts per account); the same family first; "tools werken" before "nog niet
   * getest" (with needTools); then the source's own preference and the provider's recommended models.
   */
  candidates(q: CandidateQuery = {}): Candidate[] {
    const userId = q.userId || this.ctx.auth.owner()?.id;
    if (!userId) return [];
    const now = this.now();
    const wholeOut = new Set<string>();
    const modelOut = new Set<string>();
    const tried = new Set<string>();
    for (const x of q.exclude || []) {
      if (typeof x === 'string') wholeOut.add(x);
      else if (x?.providerId) {
        tried.add(x.providerId);
        if (x.model) modelOut.add(`${x.providerId}\u0000${x.model}`);
        else wholeOut.add(x.providerId);
      }
    }
    const fam = q.family ? familyOf(q.family) : '';
    const rows: (Candidate & { _k: number[] })[] = [];
    for (const { def, cfg } of this.activeSources(userId)) {
      if (wholeOut.has(cfg.id) || (q.includeLocal === false && def.engine === 'local')) continue;
      const s = this.src(cfg);
      for (const m of this.offered(def, cfg, s)) {
        if (modelOut.has(`${cfg.id}\u0000${m.model}`)) continue;
        if (q.needTools && m.tools === 'text') continue;
        const privacy = this.privacyOf(def.kind, m.model);
        if (!privacyFits(privacy.level, q.privacy)) continue;
        const a = this.availability(def, cfg, s, m, now);
        const family = familyOf(m.model);
        const remaining = s.remaining ? { requests: s.remaining.remaining, limit: s.remaining.limit } : m.remaining?.requests ? { requests: m.remaining.requests.remaining, limit: m.remaining.requests.limit } : null;
        rows.push({
          providerId: cfg.id,
          providerKind: def.kind,
          providerLabel: cfg.name,
          engine: def.engine,
          model: m.model,
          modelLabel: m.label,
          family,
          tools: m.tools,
          privacy,
          ...a,
          remaining,
          _k: [
            a.available ? 0 : 1,
            a.available ? 0 : a.availableAt ?? Number.MAX_SAFE_INTEGER,
            def.engine === 'local' ? 1 : 0,
            tried.has(cfg.id) ? 1 : 0,
            fam && family !== fam ? 1 : 0,
            q.needTools ? (m.tools === 'tools' ? 0 : 1) : 0,
            def.rank,
            m.rank ?? 1e6,
          ],
        });
      }
    }
    rows.sort((a, b) => {
      for (let i = 0; i < a._k.length; i++) if (a._k[i] !== b._k[i]) return a._k[i] - b._k[i];
      return a.model.localeCompare(b.model);
    });
    const out = rows.map(({ _k, ...c }) => c);
    return q.limit ? out.slice(0, q.limit) : out;
  }

  // ---------------- views ----------------

  private status(def: FreeSourceDef, cfg: ProviderConfig | null, on: boolean): { status: 'off' | 'available' | 'limited' | 'key' | 'error' | 'unchecked'; resetsAt: number | null; reason?: string } {
    if (!cfg || !on) return { status: 'off', resetsAt: null };
    const now = this.now();
    const s = this.src(cfg);
    const a = this.availability(def, cfg, s, null, now);
    if (s.auth) return { status: 'key', resetsAt: null, reason: a.reason };
    if (!a.available) return { status: a.reason === 'Niet bereikbaar' ? 'error' : 'limited', resetsAt: a.availableAt, reason: a.reason };
    const offered = this.offered(def, cfg, s);
    if (!s.refreshedAt && s.refreshError) return { status: 'error', resetsAt: null, reason: s.refreshError };
    if (offered.length && offered.every((m) => m.cooldown && m.cooldown.until > now)) {
      const first = Math.min(...offered.map((m) => m.cooldown!.until));
      return { status: 'limited', resetsAt: first, reason: 'Alle modellen wachten op hun reset' };
    }
    if (!s.refreshedAt) return { status: 'unchecked', resetsAt: null };
    return { status: 'available', resetsAt: null };
  }

  private usedPercent(def: FreeSourceDef, cfg: ProviderConfig, s: SourceState): { pct: number | null; estimated: boolean } {
    if (s.remaining?.limit && s.remaining.used !== null) return { pct: Math.min(100, (s.remaining.used / s.remaining.limit) * 100), estimated: s.remaining.source !== 'key' };
    if (def.hourlyAnon && !cfg.secret_id) {
      const n = (s.hourly || []).filter((t) => this.now() - t < HOUR).length;
      return { pct: Math.min(100, (n / def.hourlyAnon) * 100), estimated: true };
    }
    return { pct: null, estimated: false };
  }

  /** One free source as the "Gratis modellen" card shows it. Never contains a key. */
  sourceView(userId: string, def: FreeSourceDef) {
    const all = this.configsOf(userId, def.kind);
    const cfg = all.find((c) => c.enabled) || all[0] || null;
    const on = !!cfg && cfg.enabled && !this.offKinds(userId).has(def.kind);
    const st = this.status(def, cfg, on);
    const s = cfg ? this.src(cfg) : null;
    const now = this.now();
    const models = cfg && s
      ? this.offered(def, cfg, s)
          .sort((a, b) => (a.rank ?? 1e6) - (b.rank ?? 1e6) || a.model.localeCompare(b.model))
          .map((m) => {
            const a = this.availability(def, cfg, s, m, now);
            return { id: m.model, label: m.label || null, family: familyOf(m.model), tools: m.tools, toolsSource: m.toolsSource || null, context: m.context || null, privacy: this.privacyOf(def.kind, m.model), available: a.available, availableAt: a.availableAt, reason: a.reason || null, probedAt: m.probedAt, probeError: m.probeError || null };
          })
      : [];
    const gone = cfg ? this.modelsOf(cfg.id).filter((m) => m.gone).map((m) => ({ id: m.model, at: m.gone!.at })) : [];
    const used = cfg && s ? this.usedPercent(def, cfg, s) : { pct: null, estimated: false };
    const kind = this.ctx.providers.kind(def.kind);
    return {
      kind: def.kind,
      label: def.engine === 'api' ? def.label : cfg?.name || kind?.label || def.label,
      engine: def.engine,
      providerId: cfg?.id || null,
      configured: !!cfg,
      own: !!cfg && cfg.user_id === userId,
      hasKey: !!cfg?.secret_id,
      needsKey: def.needsKey,
      keyPlaceholder: kind?.keyPlaceholder || null,
      fields: (def.fields || []).map(({ key, label, placeholder, hint }) => ({ key, label, placeholder: placeholder || null, hint: hint || null, value: key && cfg ? String(cfg.config?.[key] || '') : '' })),
      signupUrl: def.signupUrl || null,
      on,
      ...st,
      privacy: this.privacyOf(def.kind),
      limitNote: def.limitNote,
      docs: def.docs,
      remaining: s?.remaining ? { remaining: s.remaining.remaining, limit: s.remaining.limit, resetsAt: s.remaining.resetsAt } : null,
      usedPercent: used.pct,
      estimated: used.estimated,
      models,
      gone,
      counts: { models: models.length, tools: models.filter((m) => m.tools === 'tools').length, text: models.filter((m) => m.tools === 'text').length, unknown: models.filter((m) => m.tools === 'unknown').length },
      refreshedAt: s?.refreshedAt || null,
      refreshError: s?.refreshError || null,
      /** More connections of this provider: TeamBot uses one account and never combines several. */
      extraAccounts: Math.max(0, all.length - 1),
    };
  }

  /**
   * The free engines on this computer the card lists with their own Aanzetten button: OpenCode and Ollama always
   * (also when not connected or switched off, so nothing is silently hidden), other local engines once connected.
   */
  engineKinds(userId: string): FreeSourceDef[] {
    return FREE_SOURCES.filter((d) => !d.card && this.ctx.providers.kind(d.kind) && (ALWAYS_LISTED.has(d.kind) || this.configsOf(userId, d.kind).length > 0)).sort((a, b) => a.rank - b.rank || Number(b.kind === 'ollama') - Number(a.kind === 'ollama') || a.kind.localeCompare(b.kind));
  }

  view(userId: string) {
    return {
      sources: cardSources().map((d) => this.sourceView(userId, d)),
      engines: this.engineKinds(userId).map((d) => this.sourceView(userId, d)),
      checked: CHECKED,
    };
  }

  // ---------------- telling others ----------------

  private changed(userId: string, def: FreeSourceDef, cfg: ProviderConfig) {
    this.pushUsage(def, cfg);
    if (this.emitTimers.has(userId)) return;
    const t = setTimeout(() => {
      this.emitTimers.delete(userId);
      this.ctx.events.emit(userId, 'free-models.updated', { at: this.now() });
    }, 300);
    (t as any).unref?.();
    this.emitTimers.set(userId, t);
  }

  /** One dot per free online source in the usage bar (ctx.services.usage.reportSource, feature-detected). */
  private pushUsage(def: FreeSourceDef, cfg: ProviderConfig) {
    const usage = this.ctx.services.usage;
    if (def.engine !== 'api' || typeof usage?.reportSource !== 'function') return;
    const on = cfg.enabled && !this.offKinds(cfg.user_id).has(def.kind);
    if (!on) return;
    const st = this.status(def, cfg, on);
    const s = this.src(cfg);
    const used = this.usedPercent(def, cfg, s);
    const status = st.status === 'limited' ? 'limited' : st.status === 'key' || st.status === 'error' ? 'offline' : st.status === 'unchecked' ? 'unknown' : used.pct !== null && used.pct >= 80 ? 'low' : 'available';
    const note = st.status === 'key' ? 'Sleutel ongeldig of verlopen.' : st.reason && st.status !== 'available' ? `${st.reason}.` : def.limitNote;
    try {
      usage.reportSource({ id: def.kind, label: def.label, status, resetsAt: st.resetsAt, usedPercent: used.pct, estimated: used.estimated, note, userId: cfg.user_id, providerId: cfg.id, kind: 'free' });
    } catch (e: any) {
      this.ctx.log.warn('[free-models] usage report', e?.message || e);
    }
  }
}

function outcomeKind(o: Outcome): string {
  if (o === 'ok' || 'ok' in o) return 'ok';
  if ('gone' in o) return 'gone';
  if ('limit' in o) return 'limit';
  const cat = categoryOf((o as any).error);
  return cat === 'model' ? 'gone' : cat === 'rate_limit' || cat === 'quota' ? 'limit' : `err:${cat}`;
}
