import type { Agent } from '../core/types.js';
import { ERROR_TEXT, ProviderError, isOutage } from '../providers/common.js';

/**
 * Reserve engines (ordered list per bot, also for CLI engines such as Claude Code → Codex → OpenCode free).
 * The runner switches when an engine hits its usage limit, is logged out, overloaded or cannot start, and
 * always says so in the chat. A limit is remembered until its reset, so later turns start on the next engine
 * and go back to the main engine by themselves once the reset has passed.
 *
 * After the bot's own reserves comes the default chain (modules/engine-chain): the other subscription, free sources and
 * a local model. The pure rules of that chain live here: engine tiers and the minimum level of important work, privacy
 * labels, the order of free sources and the weekly reserve.
 */

export type EngineErrorKind = 'limit' | 'auth' | 'outage' | 'unavailable' | 'other';
export type LimitPolicy = 'fallback' | 'wait' | 'stop';
export interface FallbackRef {
  provider_id: string;
  model: string;
}

export const MAX_FALLBACKS = 5;
export const MAX_LIMIT_RETRIES = 3;
const MAX_WAIT_MS = 12 * 3600_000;
export const DEFAULT_LIMIT_WAIT_MS = 30 * 60_000;

const LIMIT = /usage limit|rate[ _-]?limit|limit reached|hit your (usage )?limit|out of extra usage|quota|too many requests|\b429\b|limiet bereikt|gebruikslimiet|insufficient_quota|credit balance is too low|resets? (at|in)\b/i;
const AUTH = /niet \(meer\) ingelogd|not\s+logged\s+in|please\s+(run\s+)?\/?login|invalid api key|authentication[_ ](error|failed|required)|unauthori[sz]ed|\b401\b|oauth token (has )?expired|credentials? (not found|expired)|auth_required|log in again|vraagt om in te loggen/i;
const OUTAGE = /overloaded|\b529\b|\b50[234]\b|service unavailable|internal server error|ECONN(RESET|REFUSED)|ETIMEDOUT|socket hang up|network error|fetch failed|timed? ?out|time-out/i;
const UNAVAILABLE = /niet gevonden op deze computer|niet gevonden in PATH|start niet als ACP-agent|kon geen sessie starten|app-server start mislukt|Programma niet gevonden|stopte onverwacht|ENOENT/i;

export function classifyEngineError(e: any): EngineErrorKind {
  // Provider errors carry a plain-language category (quota → limit, model gone → unavailable, ...).
  if (e instanceof ProviderError && e.engineKind) return e.engineKind;
  if (e instanceof ProviderError) {
    if (e.status === 429) return 'limit';
    if (e.status === 401 || e.status === 403) return 'auth';
    if (isOutage(e)) return 'outage';
  }
  const t = String(e?.message || e || '');
  if (LIMIT.test(t)) return 'limit';
  if (AUTH.test(t)) return 'auth';
  if (UNAVAILABLE.test(t)) return 'unavailable';
  if (isOutage(e) || OUTAGE.test(t)) return 'outage';
  return 'other';
}

/**
 * When does a limit reset, from the CLI/API message? Understands "…|1762531200" (Claude Code), "resets 3pm",
 * "resets at 15:30", "try again in 2 hours 5 minutes", "retry after 120 seconds". null when unknown.
 */
export function resetTimeFrom(text: string, now = Date.now()): number | null {
  const t = String(text || '');
  const unix = t.match(/\|(\d{10})\b/);
  if (unix) return Number(unix[1]) * 1000;
  const iso = t.match(/\b(20\d\d-\d\d-\d\dT\d\d:\d\d(?::\d\d)?(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?)\b/);
  if (iso && /reset|again|beschikbaar|retry/i.test(t)) {
    const v = Date.parse(iso[1]);
    if (!isNaN(v) && v > now) return v;
  }
  const rel = t.match(/(?:in|after|na|over)\s+((?:\d+\s*(?:days?|d|dagen|dag|hours?|hrs?|h|uur|uren|minutes?|mins?|m|minuten|minuut|seconds?|secs?|s|seconden)\b[\s,and&en]*)+)/i);
  if (rel) {
    let ms = 0;
    for (const m of rel[1].matchAll(/(\d+)\s*(days?|d|dagen|dag|hours?|hrs?|h|uur|uren|minutes?|mins?|m|minuten|minuut|seconds?|secs?|s|seconden)\b/gi)) {
      const n = Number(m[1]);
      const u = m[2].toLowerCase();
      ms += /^d/.test(u) ? n * 86400_000 : /^(h|uur|uren)/.test(u) ? n * 3600_000 : /^(m|min)/.test(u) ? n * 60_000 : n * 1000;
    }
    if (ms > 0) return now + ms;
  }
  const clock = t.match(/resets?\s+(?:at\s+|om\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (clock) {
    let h = Number(clock[1]) % 24;
    const min = Number(clock[2] || 0);
    if (clock[3]) {
      h = h % 12;
      if (/pm/i.test(clock[3])) h += 12;
    }
    const d = new Date(now);
    d.setHours(h, min, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return null;
}

/** Ordered reserve list of a bot: settings.fallbacks, else the single legacy `fallback`. Deduped, max 5. */
export function fallbackList(agent: Agent): FallbackRef[] {
  const raw: any[] = Array.isArray(agent.settings?.fallbacks) ? agent.settings.fallbacks : agent.fallback ? [agent.fallback] : [];
  const seen = new Set<string>();
  const out: FallbackRef[] = [];
  for (const f of raw) {
    const pid = typeof f?.provider_id === 'string' ? f.provider_id : '';
    if (!pid) continue;
    const model = typeof f.model === 'string' ? f.model.slice(0, 200) : '';
    const k = `${pid}\u0000${model}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ provider_id: pid, model });
    if (out.length >= MAX_FALLBACKS) break;
  }
  return out;
}

export function limitPolicy(agent: Agent): LimitPolicy {
  const p = agent.settings?.onLimit;
  return p === 'wait' || p === 'stop' ? p : 'fallback';
}

/** When to retry after a limit (bounded): the parsed reset (+1 min), else 30 minutes. */
export function retryAt(resetAt: number | null, now = Date.now()): number {
  const at = resetAt && resetAt > now ? resetAt + 60_000 : now + DEFAULT_LIMIT_WAIT_MS;
  return Math.min(at, now + MAX_WAIT_MS);
}

/** "13:19", or "vr 06:00" more than 20 hours ahead; `locale` = the reader's (a weekday is a word). */
export function clockTime(ms: number, tz?: string, locale = 'nl-NL'): string {
  try {
    return new Date(ms).toLocaleString(locale, { timeZone: tz, hour: '2-digit', minute: '2-digit', ...(ms - Date.now() > 20 * 3600_000 ? { weekday: 'short' } : {}) });
  } catch {
    return new Date(ms).toISOString().slice(11, 16);
  }
}

// ------------------------------------------------------------------ the default chain (package D)

/**
 * How strong an engine is for "important" work: `top` = Claude or Codex (the owner's subscription or a paid Claude/GPT
 * engine), `paid` = another subscription or paid engine, `free` = a free tier (OpenCode Zen, Groq, OpenRouter :free …),
 * `local` = a model on this computer. Ordered: an important run never switches below its minimum level.
 */
export type EngineTier = 'top' | 'paid' | 'free' | 'local';
export const TIER_RANK: Record<EngineTier, number> = { local: 0, free: 1, paid: 2, top: 3 };
export const MIN_LEVELS: EngineTier[] = ['top', 'paid', 'free', 'local'];

/**
 * What a source does with the conversation: `local` = blijft op je pc, `none` = bewaart niets (a source labelled so by
 * the free-model catalogue or by the owner), `stores` = bewaart gesprekken (your own subscription or paid account),
 * `train` = kan trainen (free tiers; unknown free sources count as this). Private work only goes to local/none.
 */
export type Privacy = 'local' | 'none' | 'stores' | 'train';
export const PRIVACY_LABEL: Record<Privacy, string> = { local: 'blijft op je pc', none: 'bewaart niets', stores: 'bewaart gesprekken', train: 'kan trainen' };

/** The level words in the chat, the pause card and Instellingen. */
export const LEVEL_TEXT: Record<EngineTier, string> = { top: 'Claude of Codex', paid: 'een abonnement of betaalde engine', free: 'een gratis model', local: 'een lokaal model' };

/**
 * The owner's choices for the default chain. Stored per user (`engineChain`); `teams` holds per-team overrides
 * (wave 2: a team can set its own chain), so nothing here is a global.
 */
export interface ChainSettings {
  /** The default chain is on (main → other subscription → free sources → local). */
  enabled: boolean;
  /** An important run never runs below this level; with nothing in it available it pauses until the reset. */
  minLevel: EngineTier;
  /** Above this % of the Claude or Codex week, normal work already goes to free models (0 = off). */
  weeklyReserve: number;
}
export const DEFAULT_CHAIN_SETTINGS: ChainSettings = { enabled: true, minLevel: 'top', weeklyReserve: 85 };

/** Stored value (+ optional team override) → clean settings. Unknown or bad values fall back to the default. */
export function resolveChainSettings(raw: any, teamId?: string | null): ChainSettings {
  const base = cleanChainSettings(raw, DEFAULT_CHAIN_SETTINGS);
  const team = teamId && raw?.teams && typeof raw.teams === 'object' ? raw.teams[teamId] : null;
  return team && typeof team === 'object' ? cleanChainSettings(team, base) : base;
}

export function cleanChainSettings(raw: any, def: ChainSettings = DEFAULT_CHAIN_SETTINGS): ChainSettings {
  const r = raw && typeof raw === 'object' ? raw : {};
  const w = Number(r.weeklyReserve);
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : def.enabled,
    minLevel: MIN_LEVELS.includes(r.minLevel) ? r.minLevel : def.minLevel,
    weeklyReserve: r.weeklyReserve === undefined || !Number.isFinite(w) ? def.weeklyReserve : w <= 0 ? 0 : Math.max(50, Math.min(99, Math.round(w))),
  };
}

const FAMILIES: [string, RegExp][] = [
  ['claude', /claude|\bopus\b|\bsonnet\b|\bhaiku\b|\bfable\b/i],
  ['openai', /\bgpt|codex|(^|[/\s])o[134](-|$)|chatgpt/i],
  ['qwen', /qwen|qwq/i],
  ['llama', /llama/i],
  ['gemini', /gemini|gemma/i],
  ['mistral', /mistral|mixtral|codestral|devstral|magistral|ministral/i],
  ['deepseek', /deepseek/i],
  ['glm', /\bglm|zhipu/i],
  ['kimi', /kimi|moonshot/i],
  ['grok', /grok/i],
  ['phi', /\bphi-?\d/i],
  ['nemotron', /nemotron/i],
  ['minimax', /minimax/i],
];

/** The model family ("claude", "openai", "qwen" …; '' = unknown) from the engine kind and the model name. */
export function modelFamily(kindId: string, model: string): string {
  if (kindId === 'claude-code' || kindId === 'anthropic') return 'claude';
  if (kindId === 'codex-cli' && !/\b(oss|qwen|llama)/i.test(model || '')) return 'openai';
  const m = String(model || '');
  return FAMILIES.find(([, re]) => re.test(m))?.[0] || '';
}

/** The tier of an engine from its typical billing and model family (see EngineTier). */
export function engineTier(kind: { id: string; billing?: string } | undefined, model: string): EngineTier {
  if (kind?.billing === 'local') return 'local';
  if (kind?.billing === 'free') return 'free';
  const fam = modelFamily(kind?.id || '', model);
  return fam === 'claude' || fam === 'openai' ? 'top' : 'paid';
}

export const meetsLevel = (tier: EngineTier, min: EngineTier) => TIER_RANK[tier] >= TIER_RANK[min];

const PRIVACY_WORDS: [Privacy, RegExp][] = [
  ['local', /^(local|lokaal|on[-_ ]?device|blijft op je pc)$/i],
  ['none', /^(none|nothing|zero|zdr|no[-_ ]?retention|bewaart niets)$/i],
  ['train', /^(train|training|may[-_ ]?train|kan trainen)$/i],
  ['stores', /^(stores?|retains?|logs?|bewaart( gesprekken)?)$/i],
];
/** A privacy label in any of the usual spellings → Privacy, or null when it is not one. */
export function normPrivacy(v: unknown): Privacy | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return (s && PRIVACY_WORDS.find(([, re]) => re.test(s))?.[0]) || null;
}

/**
 * Which usage limit a connection draws from, as a key: connections with the same key reach their limit together. A CLI
 * engine logs in once per computer, so a second connection of the same kind (two OpenCode connections) uses the same
 * login and the same free daily limit, unless it signs in another way (`config.authMethod`) or runs its own command
 * (`config.command`/`args`). An API engine counts per key at its address: `key` is a fingerprint of the key; without a
 * key it shares nothing (null), and neither does a model on this computer.
 */
export function limitAccount(
  cfg: { kind: string; base_url?: string | null; config?: Record<string, any> | null },
  kind: { type?: string; billing?: string; baseUrl?: string } | undefined,
  key?: string | null,
): string | null {
  if (!kind || kind.billing === 'local') return null;
  const c = cfg.config || {};
  if (kind.type === 'cli') return ['cli', cfg.kind, typeof c.authMethod === 'string' ? c.authMethod : '', JSON.stringify([c.command ?? '', c.args ?? []])].join('|');
  if (!key) return null;
  const url = String(cfg.base_url || kind.baseUrl || '').trim().replace(/\/+$/, '').replace('localhost', '127.0.0.1').toLowerCase();
  return ['api', cfg.kind, url, key].join('|');
}

/** What an engine does with the conversation: the owner's or catalogue's label, else from its billing. */
export function enginePrivacy(kind: { billing?: string } | undefined, config?: Record<string, any> | null): Privacy {
  const own = normPrivacy(config?.privacy);
  if (own) return own;
  if (kind?.billing === 'local') return 'local';
  if (kind?.billing === 'free') return 'train';
  return 'stores';
}

/** May private work go here? Only to a model on this computer or a source that keeps nothing. */
export const privateSafe = (p: Privacy) => p === 'local' || p === 'none';

/**
 * Free sources in the order the chain tries them: first a different provider than the main engine (a free limit counts
 * per account, not per model), then the same model family as the main model. Stable otherwise.
 */
export function orderFree<T extends { provider_id: string; family?: string }>(list: T[], main: { provider_id: string; family: string }): T[] {
  const score = (x: T) => (x.provider_id === main.provider_id ? 2 : 0) + (main.family && x.family === main.family ? 0 : 1);
  return list.map((x, i) => ({ x, i })).sort((a, b) => score(a.x) - score(b.x) || a.i - b.i).map((y) => y.x);
}

/**
 * The week window of a Claude ("seven_day") or Codex ("…:10080") account: its use in %, or null when unknown (a window
 * whose reset has passed says nothing any more).
 */
export function weekUse(windows: { id: string; usedPercent: number | null; resetsAt?: number | null }[] | undefined, now = Date.now()): { percent: number; resetsAt: number | null } | null {
  const w = (windows || []).filter((x) => (x.id === 'seven_day' || /:10080$/.test(x.id)) && typeof x.usedPercent === 'number' && !(x.resetsAt && x.resetsAt <= now));
  if (!w.length) return null;
  const top = w.sort((a, b) => (b.usedPercent as number) - (a.usedPercent as number))[0];
  return { percent: top.usedPercent as number, resetsAt: top.resetsAt ?? null };
}

/** Why a run counts as important (routine, task on the board, inherited from the run that delegated it, or set on the run). */
export interface ImportantRef {
  kind: 'routine' | 'task' | 'delegation' | 'run';
  id?: string;
  title?: string;
}

/** What the runner needs to know about one run before it picks an engine (see modules/engine-chain). */
export interface WorkFlags {
  /** The default chain may add engines after the bot's own reserves. */
  chain: boolean;
  important: ImportantRef | null;
  minLevel: EngineTier;
  /** strict: the bot is set to private (every engine, the main one too); sensitive: the turn uses sensitive memory. */
  private: { mode: 'strict' | 'sensitive'; why: string } | null;
  /** % of the Claude/Codex week above which normal work leaves those engines (0 = off). */
  weeklyReserve: number;
  /** Proactive work (a vaste taak): never switches to a paid or subscription engine; only free and local ones. */
  frugal?: boolean;
}

/** An engine the default chain adds (after the main engine and the bot's own reserves). */
export interface ChainEntry {
  provider_id: string;
  model: string;
  source: 'subscription' | 'free' | 'local';
  privacy?: Privacy;
  family?: string;
  /** From the free-model catalogue (ctx.services.freeModels). */
  catalogue?: boolean;
  /**
   * The catalogue says this source waits for its limit until `until` (its `availableAt`; `known` when that is the
   * source's own reset). The runner skips it until then and counts it as a resume time for paused important work.
   */
  wait?: { until: number; known: boolean } | null;
}

/** An important run pauses at most this often in a row before it stops waiting by itself. */
export const MAX_PAUSES = 6;

/** When paused important work goes on: the reset (+1 min, at most 8 days ahead), else in 30 minutes. */
export const MAX_PAUSE_MS = 8 * 86400_000;
export function pauseUntil(resetAt: number | null, now = Date.now()): { at: number; known: boolean } {
  if (resetAt && resetAt > now) return { at: Math.min(resetAt + 60_000, now + MAX_PAUSE_MS), known: true };
  return { at: now + DEFAULT_LIMIT_WAIT_MS, known: false };
}

/** The free tier of an engine (OpenCode's free models) is used up for now, rather than a paid plan's limit. */
export function isFreeLimit(text: string): boolean {
  return P_FREE.test(String(text || ''));
}

/**
 * The first half of the chat line when an engine fails ("… Overgeschakeld naar reserve: …"): the free limit plainly
 * ("De gratis limiet van OpenCode is bereikt (weer beschikbaar rond 13:18)"), else "<engine> <reason>". `engine` is
 * the engine with its model in words ("OpenCode (Big Pickle)"); `provider` the engine alone (the free limit counts
 * for all its free models).
 */
export function failureText(o: { engine: string; provider: string; kind: EngineErrorKind; resetAt?: number | null; tz?: string; error?: string }): string {
  if (o.kind === 'limit' && isFreeLimit(o.error || '')) return `De gratis limiet van ${o.provider} is bereikt${o.resetAt ? ` (weer beschikbaar rond ${clockTime(o.resetAt, o.tz)})` : ''}`;
  return `${o.engine} ${reasonText(o.kind, o.resetAt, o.tz)}`;
}

export function reasonText(kind: EngineErrorKind, resetAt?: number | null, tz?: string): string {
  switch (kind) {
    case 'limit':
      return `heeft zijn gebruikslimiet bereikt${resetAt ? ` (weer beschikbaar rond ${clockTime(resetAt, tz)})` : ''}`;
    case 'auth':
      return 'is niet (meer) ingelogd';
    case 'outage':
      return 'is overbelast of niet bereikbaar';
    case 'unavailable':
      return 'kon niet starten';
    default:
      return 'gaf een fout';
  }
}

// ------------------------------------------------------------------ plain error text (Q-03)

/** What an engine's own (mostly English) error text is about. */
export type PlainErrorKind = 'missing' | 'auth' | 'limit' | 'model' | 'outage' | 'network' | 'cut' | 'cancelled' | 'crash';

const P_MISSING = /\bspawn\s+\S+\s+ENOENT\b|command not found|is not recognized as an internal or external command|executable (file )?not found|not installed\b/i;
const P_AUTH =
  /not\s+logged\s+in|please\s+(run\s+)?[`'"]?\/?log ?in\b|login required|log in again|sign in again|invalid[_ ]?(api[_ -]?key|x-api-key|token|credentials?)|incorrect api key|api[_ -]?key (is )?(not valid|invalid|missing|required|expired)|unauthori[sz]ed|\b(?:status|error|http|code)\W{0,3}401\b|authentication[_ ]?(error|failed|required)|unauthenticated|(oauth )?token (has )?expired|credentials? (not found|expired|missing)|auth_required/i;
const P_FREE = /free usage limit|free[_ -]?tier|free-models-per-(day|min)|daily free allocation/i;
const P_LIMIT = /usage limit|rate[ _-]?limit|limit reached|hit your (usage )?limit|out of extra usage|too many requests|\b(?:status|error|http|code)\W{0,3}429\b|quota|insufficient[_ ]?(quota|balance|credits?)|credit balance is too low|session limit|weekly limit|5-hour limit/i;
const P_MODEL = /model[_ ]?not[_ ]?found|ModelNotFound|unknown[_ ]model|invalid model|no such model|not a valid model|issue with the selected model|selected model .{0,80}may not exist|model .{0,80}(does not exist|not found|is not available|not supported|unavailable)/i;
const P_OUTAGE = /overloaded|over capacity|\b529\b|\b(?:status|error|http|code)\W{0,3}50[0234]\b|service unavailable|temporarily unavailable|internal server error|bad gateway|gateway time-?out|high demand|try again later/i;
const P_NETWORK =
  /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|fetch failed|socket hang up|network (error|is unreachable)|connection (error|refused|reset|timed? ?out)|unable to connect|could not connect|getaddrinfo|could not resolve host|error sending request|request timed? ?out/i;
// The connection broke off while the answer was streaming (Node's fetch: "terminated", "other side closed"); seen live
// in acceptance round 5 as the chat's whole error text.
const P_CUT = /^\s*(?:TypeError:\s*)?terminated\.?\s*$|other side closed|premature close|UND_ERR_SOCKET|stream (?:was )?(?:closed|ended) (?:unexpectedly|prematurely)/i;
// The program itself stopped without an answer ("Claude Code stopte onverwacht (exitcode 3)"): TeamBot's own text for a
// CLI that exited, or the English one of a CLI wrapper. Checked last: a limit or login in its output says more.
const P_CRASH = /\bstopte onverwacht\b|\bexited unexpectedly\b|\bprocess exited with code -?\d+/i;
const P_CANCELLED = /^\s*(?:the\s+)?(?:web ?search|search|fetch|request|operation|tool(?: call)?|command|task)?\s*(?:was\s+)?(?:cancell?ed|aborted|interrupted)(?: by (?:the )?user)?\.?\s*$/i;

/** The kind of a known engine error, or null when the text is something else (then it is shown as is). */
export function plainErrorKind(raw: string): PlainErrorKind | null {
  const t = String(raw || '');
  if (P_CANCELLED.test(t)) return 'cancelled';
  if (P_MISSING.test(t)) return 'missing';
  if (P_AUTH.test(t)) return 'auth';
  if (P_FREE.test(t) || P_LIMIT.test(t)) return 'limit';
  if (P_MODEL.test(t)) return 'model';
  if (P_OUTAGE.test(t)) return 'outage';
  if (P_NETWORK.test(t)) return 'network';
  if (P_CUT.test(t)) return 'cut';
  if (P_CRASH.test(t)) return 'crash';
  return null;
}

/**
 * An engine's error as one plain Dutch sentence with what to do (auth, limit, network, not installed, unknown model,
 * overloaded). Unknown texts come back unchanged. The raw text stays in the run and the server log for diagnosis;
 * this is only what the person sees. Dutch source text: the interface dictionary translates it like any other text.
 */
export function plainEngineError(raw: string, o: { engine?: string; tz?: string; now?: number } = {}): string {
  const t = String(raw || '').trim();
  if (!t) return t;
  const kind = plainErrorKind(t);
  if (!kind) return t;
  const e = (o.engine || '').trim() || 'De AI-engine';
  const now = o.now ?? Date.now();
  const reset = kind === 'limit' ? resetTimeFrom(t, now) : null;
  const when = reset && reset > now ? ` (weer beschikbaar rond ${clockTime(reset, o.tz)})` : '';
  switch (kind) {
    case 'cancelled':
      return 'Afgebroken voordat het klaar was.';
    case 'missing':
      return `${e} is niet gevonden op deze computer. Installeer het programma of stel het pad in via Instellingen › Abonnementen, of kies een andere engine.`;
    case 'auth': {
      // Keep the login command TeamBot already found for this CLI ("Log zelf in met: claude auth login").
      const login = t.match(/Log zelf in met: ([\w@/-]+(?: [\w@/-]+){0,3})/)?.[1];
      return login
        ? `${e} is niet (meer) ingelogd. Log zelf in met: ${login}`
        : `${e} is niet (meer) ingelogd of de sleutel klopt niet. Log opnieuw in (of plak een nieuwe sleutel) en probeer het daarna nog eens.`;
    }
    case 'limit':
      return P_FREE.test(t)
        ? `De gratis limiet van ${e} is bereikt${when}. Probeer het later opnieuw of kies een ander model.`
        : `${e} heeft zijn gebruikslimiet bereikt${when}. Probeer het later opnieuw, of kies een ander model of een reserve-engine.`;
    case 'model':
      return `${e} kent dit model niet (meer). Kies een ander model in de instellingen van de bot.`;
    case 'outage':
      return `${e} is even overbelast of tijdelijk niet bereikbaar. Probeer het zo opnieuw.`;
    case 'network':
      return `Geen verbinding met ${e}. Controleer je internetverbinding en probeer het opnieuw.`;
    case 'cut':
      return `De verbinding met ${e} brak halverwege het antwoord af. Probeer het opnieuw.`;
    case 'crash':
      return `${e} stopte onverwacht. Probeer het opnieuw. Gebeurt het weer, kijk dan bij Instellingen › Abonnementen of ${e} nog werkt, of kies een andere engine voor deze bot.`;
  }
}

/** Any thrown engine error as plain text: API errors by their category, CLI texts by what they say. */
export function plainError(e: any, o: { engine?: string; tz?: string; now?: number } = {}): string {
  if (e instanceof ProviderError && e.category && e.category !== 'bad_request' && e.category !== 'other') {
    const t = ERROR_TEXT[e.category];
    const wait = e.retryAfter ? ` Opnieuw mogelijk over ${e.retryAfter} s.` : '';
    return `${(o.engine || '').trim() || 'De AI-engine'}: ${t.title}. ${t.fix.replace('{keyUrl}', '')}${wait}`;
  }
  return plainEngineError(String(e?.message || e || ''), o);
}

/**
 * What the program said when it stopped unexpectedly ("… (exitcode 3). Laatste uitvoer: …"), for a "Details" toggle under
 * the plain sentence: the only clue for whoever wants to find out why. Undefined for every other error.
 */
export function crashDetail(e: any): string | undefined {
  const t = String(e?.message || e || '').trim();
  return t && plainErrorKind(t) === 'crash' ? t.slice(0, 1500) : undefined;
}

/**
 * A failed step's detail ("Web search cancelled", "fetch failed"): only short, known engine texts become plain words;
 * real output (a command's error output, a file's content) stays as it is.
 */
export function plainStepDetail(detail: string | undefined): string | undefined {
  if (!detail) return detail;
  const t = detail.trim();
  if (t.length > 240 || /\n/.test(t)) return detail;
  return plainErrorKind(t) ? plainEngineError(t, { engine: 'De dienst' }) : detail;
}
