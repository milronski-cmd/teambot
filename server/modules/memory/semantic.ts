/**
 * Search by meaning ("wagen" finds "auto"), next to search by words. Small, multilingual and local: the owner's own
 * Ollama with an embedding model (`/api/embed`), or — for everyone, also without Ollama — the built-in model TeamBot
 * downloads once after the owner said yes (builtin-embed.ts: multilingual-e5-small on the CPU). Without either,
 * everything works as before (FTS5 with light NL/EN stemming and the synonyms stored with each memory); nothing here is
 * ever required.
 *
 * - Engine, in this order: the model the owner chose in Geheugen › Opslag; an enabled Ollama provider on a loopback
 *   address only (memory text never leaves the computer for this) with an installed embedding model (EMBED_PREFERENCE,
 *   multilingual first, else any model Ollama reports as "embedding"); else the built-in model when it is downloaded.
 * - Store: `memory_vectors`, derived like `memory_fts`: one unit-length float32 vector per active/proposed memory
 *   item and per document chunk. Sensitive items are never embedded (their content is encrypted; a vector would
 *   be a readable copy). `MemoryService.syncIndex/unindex` drop a vector in the same transaction as the record change
 *   (forget, trash, sensitive, new text); the background indexer embeds what is missing, a reindex rebuilds them all.
 * - Search: cosine similarity in TypeScript over the vectors the reader may see (the caller joins the source table
 *   and applies its ACL). A similarity below the model's floor is no hit, and so is one far below the best hit of the
 *   same search (the model's band); above it, the score is blended with the lexical rank (service.searchItems).
 * - The query vector is computed once per text (small cache); in the per-turn context it gets a short time limit, so
 *   a cold model never holds up the bot (that turn then uses words only).
 */
import { now } from '../../core/db.js';
import { clean } from './text.js';
import type { MemoryService } from './service.js';
import { BUILTIN, BuiltinModel, LEGACY_BUILTIN, isBuiltinId, type BuiltinStatus } from './builtin-embed.js';

/** Multilingual models first (Dutch is the owner's language); then good English ones. Matched on the name start. */
export const EMBED_PREFERENCE = [
  'bge-m3',
  'qwen3-embedding',
  'embeddinggemma',
  'snowflake-arctic-embed2',
  'granite-embedding',
  'paraphrase-multilingual',
  'nomic-embed-text-v2',
  'jeffh/intfloat-multilingual-e5',
  'nomic-embed-text',
  'mxbai-embed-large',
  'snowflake-arctic-embed',
  'all-minilm',
];
/** The model TeamBot offers to download (multilingual, ±1,2 GB). */
export const SUGGESTED_MODEL = 'bge-m3';
const EMBED_NAME = /embed|bge-|e5|minilm|paraphrase-multilingual/i;

export interface QVec {
  model: string;
  vec: Float32Array;
}

export interface EmbedEngine {
  /** Ollama on this computer, or the built-in model (no provider). */
  kind: 'ollama' | 'builtin';
  providerId: string;
  providerName: string;
  origin: string;
  model: string;
}

export type SemanticState = 'off' | 'no-ollama' | 'remote' | 'unreachable' | 'no-model' | 'on';

export interface SemanticInfo {
  state: SemanticState;
  engine: EmbedEngine | null;
  /** Embedding models installed in the (first reachable, local) Ollama. */
  models: string[];
  provider: { id: string; name: string } | null;
  error?: string;
  /** The built-in model: downloaded, downloading, not yet (the owner can turn it on), or not in this build. */
  builtin?: BuiltinStatus;
}

interface Family {
  /** Cosine similarity below this is no hit (models spread their scores differently). */
  floor: number;
  /**
   * Only hits within this distance of the best similarity of the same search count (models that put everything
   * close together, like e5, need a narrow band; without one every memory is "a bit similar").
   */
  band?: number;
  /** How far above the floor a clear match lies (score 1); default 1 − floor. */
  span?: number;
  /**
   * Score by place within the band (the best hit 1, the edge of the band 0,35) instead of by distance to the floor:
   * for models whose similarities say little on their own (e5: right and unrelated notes both score ±0,80–0,86).
   */
  relative?: boolean;
  /**
   * A soft band (0.4.4): score exp((sim − best) / tau), so the best hit scores 1 and one 3·tau below it scores 0,05
   * (counted as no hit). Smooth where `band` was a hard edge; measured on the memory benchmark.
   */
  tau?: number;
  /**
   * The best similarity of a search must reach this for the per-turn block to call anything "relevant" (unless words
   * match well). Only for a model whose similarities were measured: below it, the question is not about memory
   * ("Leuk, dankjewel!") and the bot gets no noise.
   */
  gate?: number;
  /** Weight of a word hit next to a meaning hit (the meaning score of the best hit is 1). */
  words?: number;
  doc?: string;
  query?: string;
}

/** Per model family: the similarity floor and the prefixes the model was trained with. */
export function family(model: string): Family {
  const m = model.toLowerCase();
  if (/nomic-embed-text-v2/.test(m)) return { floor: 0.55, doc: 'search_document: ', query: 'search_query: ' };
  if (/nomic-embed/.test(m)) return { floor: 0.6, doc: 'search_document: ', query: 'search_query: ' };
  if (m === BUILTIN.id) return { floor: BUILTIN_FLOOR, tau: BUILTIN_TAU, gate: BUILTIN_GATE, words: 1 };
  if (m === 'builtin:multilingual-e5-small') return { floor: 0.76, tau: 0.02, words: 0.6, doc: 'passage: ', query: 'query: ' };
  if (/e5/.test(m)) return { floor: 0.8, doc: 'passage: ', query: 'query: ' };
  if (/mxbai-embed/.test(m)) return { floor: 0.6, query: 'Represent this sentence for searching relevant passages: ' };
  if (/embeddinggemma/.test(m)) return { floor: 0.5, doc: 'title: none | text: ', query: 'task: search result | query: ' };
  if (/qwen3-embedding/.test(m)) return { floor: 0.5, query: 'Instruct: Given a question, retrieve stored notes that answer it\nQuery: ' };
  if (/all-minilm|paraphrase/.test(m)) return { floor: 0.5 };
  return { floor: 0.55 };
}

/**
 * granite-embedding-97m-multilingual-r2 on the memory benchmark (docs/quality/memory-bench.md): the right note scores
 * 0,74–0,86 (p10–p90), the best unrelated one 0,77–0,83, and for a message that is not about memory at all ("Leuk,
 * dankjewel!", "Hoe ver is de maan?") the best note only 0,72–0,79. So a low floor, a soft band around the best hit
 * (tau 0,02) and a gate of 0,77 for the per-turn block. (multilingual-e5-small, before 0.4.4, put all of these at
 * 0,80–0,86 and could not tell a memory question from small talk.)
 */
export const BUILTIN_FLOOR = 0.5;
export const BUILTIN_TAU = 0.02;
export const BUILTIN_GATE = 0.77;

/** Only an Ollama on this computer: what is embedded is the owner's memory. */
export function isLoopback(origin: string): boolean {
  try {
    const h = new URL(origin).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
  } catch {
    return false;
  }
}

function originOf(base: string): string {
  const b = String(base || '').trim() || 'http://127.0.0.1:11434/v1';
  try {
    return new URL(b).origin;
  } catch {
    return b.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
  }
}

/**
 * Similarities → scores in 0..1 for one search: below the model's floor (or outside its band around the best hit) is
 * no hit; `span` = how far above the floor a clear match lies (1 − floor for models that spread their scores).
 */
export function scoreSims(model: string, sims: [string, number][]): Map<string, number> {
  const f = family(model);
  const out = new Map<string, number>();
  if (!sims.length) return out;
  const best = Math.max(...sims.map((x) => x[1]));
  if (f.tau) {
    for (const [id, sim] of sims) {
      if (sim < f.floor) continue;
      const s = Math.exp((sim - best) / f.tau);
      if (s >= 0.05) out.set(id, s);
    }
    return out;
  }
  const lo = f.band ? Math.max(f.floor, best - f.band) : f.floor;
  const span = f.span ?? 1 - f.floor;
  for (const [id, sim] of sims) {
    if (sim < lo) continue;
    out.set(id, f.relative && f.band ? 0.35 + 0.65 * Math.min(1, (sim - (best - f.band)) / f.band) : Math.min(1, (sim - f.floor) / span));
  }
  return out;
}

/** Unit length (cosine = dot product). */
export function normalizeVec(v: ArrayLike<number>): Float32Array {
  const out = new Float32Array(v.length);
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

const toBlob = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
function fromBlob(b: Uint8Array): Float32Array {
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return new Float32Array(ab);
}

/** The text a record is embedded from (null = no vector: sensitive, not live, empty). */
export function vectorText(kind: string, row: any): string | null {
  if (!row) return null;
  if (kind === 'item') {
    if (!['active', 'proposed'].includes(row.status) || row.sensitivity === 'sensitive' || row.content_enc) return null;
    const t = clean(String(row.content || ''), 2000);
    return t.length >= 2 ? t : null;
  }
  if (kind === 'chunk') {
    const t = clean(String(row.text || ''), 4000);
    return t.length >= 2 ? t : null;
  }
  // What went out of a dossier's text into its archive (a line that no longer fit, or that a rewrite took out): found
  // by meaning too, like the note it once was.
  if (kind === 'record') {
    if (!isArchiveLine(row)) return null;
    const t = clean(String(row.body || ''), 4000);
    return t.length >= 2 ? t : null;
  }
  return null;
}

/** A line (or lines) of a dossier's archive: an active timeline entry that living.ts archiveLines wrote. */
export function isArchiveLine(row: any): boolean {
  if (!row || row.kind !== 'event' || row.status !== 'active') return false;
  try {
    const d = typeof row.data === 'string' ? JSON.parse(row.data || '{}') : row.data;
    return !!d?.archive;
  } catch {
    return false;
  }
}

/** One live archive record (null when it is not one any more). */
const ARCHIVE_ROW = "SELECT * FROM memory_records WHERE id = ? AND kind = 'event' AND status = 'active'";

export interface PullState {
  model: string;
  status: 'running' | 'done' | 'error';
  completed: number;
  total: number;
  error?: string;
  at: string;
}

export class Semantic {
  private infos = new Map<string, { at: number; info: SemanticInfo }>();
  private vecs = new Map<string, { model: string; vec: Float32Array }>();
  private qcache = new Map<string, Float32Array>();
  private timer: NodeJS.Timeout | null = null;
  private kickTimer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = true;
  readonly pulls = new Map<string, PullState>();
  /** The built-in model (one per installation, in the data folder). */
  readonly builtin: BuiltinModel;

  constructor(private svc: MemoryService) {
    this.builtin = new BuiltinModel(svc.ctx.config.dataDir);
  }

  /** The owner of this installation said yes to the built-in model (install-wide, it is one download). */
  builtinConsent(): boolean {
    return !!this.store.getSetting<any>('', 'memory.builtin', {})?.consent;
  }

  builtinStatus(): BuiltinStatus {
    return this.builtin.status(this.builtinConsent());
  }

  /** Yes: remember the consent and download the model (once; progress in builtinStatus). */
  enableBuiltin(userId: string, done?: (ok: boolean) => void): BuiltinStatus {
    this.store.setSetting('', 'memory.builtin', { consent: true, by: userId, at: now() });
    const st = this.builtinStatus();
    if (st.state === 'absent' || st.state === 'error') {
      void this.builtin.download().then((ok) => {
        this.forgetInfo();
        if (ok) (this.builtin.removeLegacy(), this.kick());
        done?.(ok);
      });
    }
    return this.builtinStatus();
  }

  /**
   * The owner said yes to the built-in search model before 0.4.4 (multilingual-e5-small): its successor comes in the
   * background (the yes is install-wide and for "the built-in model"; it is smaller than the old one). Until it is
   * there, search by meaning waits (words with synonyms); then the vectors are made again and the old files go.
   */
  upgradeBuiltin() {
    if (!this.builtinConsent()) return;
    const st = this.builtinStatus();
    if (st.state === 'ready') {
      if (this.builtin.legacyPresent()) this.builtin.removeLegacy();
      return;
    }
    if (st.state !== 'absent') return;
    void this.builtin.download().then((ok) => {
      this.forgetInfo();
      if (ok) (this.builtin.removeLegacy(), this.kick());
    });
  }

  /** Remove the built-in model and its vectors (the owner's choice in Opslag). */
  removeBuiltin() {
    this.store.setSetting('', 'memory.builtin', { consent: false, at: now() });
    this.builtin.remove();
    for (const id of [BUILTIN.id, ...LEGACY_BUILTIN.ids]) this.store.exec('DELETE FROM memory_vectors WHERE model = ?', id);
    this.vecs.clear();
    this.forgetInfo();
  }

  private builtinWarned = 0;
  /** The built-in model failed (corrupt file, runtime error): say so in the log, at most once an hour. */
  private noteBuiltinError(e: any) {
    if (/abort|timeout/i.test(String(e?.name || '') + String(e?.message || ''))) return;
    if (Date.now() - this.builtinWarned < 3600_000) return;
    this.builtinWarned = Date.now();
    this.svc.ctx.log.warn('[memory] ingebouwd zoekmodel gaf geen vectoren', String(e?.message || e).slice(0, 200));
  }

  /** The engine of the built-in model, when it is downloaded and can run here. */
  private builtinEngine(): EmbedEngine | null {
    return this.builtinStatus().state === 'ready' ? { kind: 'builtin', providerId: 'builtin', providerName: 'TeamBot', origin: '', model: BUILTIN.id } : null;
  }

  private get store() {
    return this.svc.store;
  }

  // ------------------------------------------------------------------ engine

  enabled(userId: string): boolean {
    return this.svc.userSettings(userId).semantic !== 'off';
  }

  forgetInfo(userId?: string) {
    if (userId) this.infos.delete(userId);
    else this.infos.clear();
  }

  /** Which engine embeds for this user now (cached: 60 s when it works, 20 s when it does not). */
  async info(userId: string, fresh = false): Promise<SemanticInfo> {
    const c = this.infos.get(userId);
    if (!fresh && c && Date.now() - c.at < (c.info.state === 'on' ? 60_000 : 20_000)) return c.info;
    const info = await this.detect(userId);
    this.infos.set(userId, { at: Date.now(), info });
    return info;
  }

  private async detect(userId: string): Promise<SemanticInfo> {
    const builtin = this.builtinStatus();
    const info = await this.detectOllama(userId);
    info.builtin = builtin;
    if (info.state === 'off') return info;
    const own = this.builtinEngine();
    const chosen = this.svc.userSettings(userId).semanticModel;
    if (own && isBuiltinId(chosen)) return { ...info, state: 'on', engine: own, models: [...new Set([...info.models, BUILTIN.id])] };
    if (info.state === 'on') return own ? { ...info, models: [...info.models, BUILTIN.id] } : info;
    // No embedding model in Ollama (or no Ollama at all): the built-in model, when it is there.
    if (own) return { ...info, state: 'on', engine: own, models: [BUILTIN.id], error: undefined };
    return info;
  }

  private async detectOllama(userId: string): Promise<SemanticInfo> {
    const s = this.svc.userSettings(userId);
    if (s.semantic === 'off') return { state: 'off', engine: null, models: [], provider: null };
    const ctx = this.svc.ctx;
    const providers = ctx.providers.list(userId).filter((p) => p.kind === 'ollama' && p.enabled && ctx.providers.canUse(userId, p));
    if (!providers.length) return { state: 'no-ollama', engine: null, models: [], provider: null };
    let fallback: SemanticInfo | null = null;
    for (const p of providers) {
      const origin = originOf(p.base_url || ctx.providers.kind('ollama')?.baseUrl || '');
      const provider = { id: p.id, name: p.name || 'Ollama' };
      if (!isLoopback(origin)) {
        fallback ||= { state: 'remote', engine: null, models: [], provider };
        continue;
      }
      let tags: any;
      try {
        const r = await fetch(`${origin}/api/tags`, { signal: AbortSignal.timeout(2500), redirect: 'error' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        tags = await r.json();
      } catch (e: any) {
        if (!fallback || fallback.state === 'remote') fallback = { state: 'unreachable', engine: null, models: [], provider, error: String(e?.message || e).slice(0, 200) };
        continue;
      }
      const models = (Array.isArray(tags?.models) ? tags.models : [])
        .filter((m: any) => {
          const caps: string[] = Array.isArray(m?.capabilities) ? m.capabilities : [];
          const name = String(m?.name || m?.model || '');
          return caps.length ? caps.includes('embedding') : EMBED_NAME.test(name);
        })
        .map((m: any) => String(m.name || m.model));
      if (!models.length) {
        if (!fallback || ['remote', 'unreachable'].includes(fallback.state)) fallback = { state: 'no-model', engine: null, models: [], provider };
        continue;
      }
      const base = (n: string) => n.replace(/:latest$/, '');
      const pick =
        (s.semanticModel && models.find((m: string) => m === s.semanticModel || base(m) === base(s.semanticModel!))) ||
        EMBED_PREFERENCE.map((pref) => models.find((m: string) => base(m).toLowerCase().startsWith(pref))).find(Boolean) ||
        models[0];
      return { state: 'on', engine: { kind: 'ollama', providerId: p.id, providerName: provider.name, origin, model: pick }, models, provider };
    }
    return fallback || { state: 'no-ollama', engine: null, models: [], provider: null };
  }

  /** Embed texts with Ollama or the built-in model (documents or a query). Throws on failure. */
  async embed(engine: EmbedEngine, texts: string[], as: 'doc' | 'query', timeoutMs = 120_000): Promise<Float32Array[]> {
    const f = family(engine.model);
    const prefix = (as === 'query' ? f.query : f.doc) || '';
    if (engine.kind === 'builtin') {
      let timer: NodeJS.Timeout | null = null;
      const limit = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), timeoutMs);
        timer.unref?.();
      });
      try {
        return (await Promise.race([this.builtin.embed(texts.map((t) => prefix + t)), limit])).map((v) => normalizeVec(v));
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    const r = await fetch(`${engine.origin}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: engine.model, input: texts.map((t) => prefix + t), truncate: true }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    if (!r.ok) throw new Error(`Ollama /api/embed: HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
    const j: any = await r.json();
    const list: any[] = Array.isArray(j?.embeddings) ? j.embeddings : [];
    if (list.length !== texts.length || list.some((v) => !Array.isArray(v) || !v.length)) throw new Error('Ollama gaf geen bruikbare vectoren terug');
    return list.map((v) => normalizeVec(v));
  }

  /** The vector of a search text, or null (no engine, or not within the time limit). */
  async queryVector(userId: string, text: string, timeoutMs = 6000): Promise<QVec | null> {
    const q = clean(String(text || ''), 2000);
    if (q.length < 2) return null;
    let info: SemanticInfo;
    try {
      info = await this.info(userId);
    } catch {
      return null;
    }
    if (!info.engine) return null;
    const model = info.engine.model;
    const key = `${model}\n${q}`;
    const hit = this.qcache.get(key);
    if (hit) {
      this.qcache.delete(key);
      this.qcache.set(key, hit);
      return { model, vec: hit };
    }
    try {
      const [vec] = await this.embed(info.engine, [q], 'query', timeoutMs);
      this.qcache.set(key, vec);
      while (this.qcache.size > 200) this.qcache.delete(this.qcache.keys().next().value!);
      return { model, vec };
    } catch (e: any) {
      // A timeout only means "not now" (a cold model loads meanwhile); a refused connection means Ollama is gone.
      if (info.engine.kind === 'builtin') this.noteBuiltinError(e);
      else if (!/abort|timeout/i.test(String(e?.name || '') + String(e?.message || ''))) this.infos.set(userId, { at: Date.now(), info: { ...info, state: 'unreachable', engine: null, error: String(e?.message || e).slice(0, 200) } });
      return null;
    }
  }

  // ------------------------------------------------------------------ store (sync, called inside record transactions)

  private vecOf(kind: string, rid: string, model: string): Float32Array | null {
    const k = `${kind}:${rid}`;
    const c = this.vecs.get(k);
    if (c && c.model === model) return c.vec;
    const r = this.store.one<any>('SELECT vec, model FROM memory_vectors WHERE kind = ? AND rid = ?', kind, rid);
    if (!r || r.model !== model) return null;
    const vec = fromBlob(r.vec);
    this.vecs.set(k, { model, vec });
    return vec;
  }

  drop(kind: string, rid: string) {
    this.store.exec('DELETE FROM memory_vectors WHERE kind = ? AND rid = ?', kind, rid);
    this.vecs.delete(`${kind}:${rid}`);
  }

  dropUser(userId: string) {
    this.store.exec('DELETE FROM memory_vectors WHERE user_id = ?', userId);
    for (const k of [...this.vecs.keys()]) this.vecs.delete(k);
  }

  /**
   * A record changed (from syncIndex): keep its vector only while it is live and its text is the same; anything
   * else drops it now (forgotten, trashed, sensitive) and lets the indexer embed the new text.
   */
  sync(kind: 'item' | 'chunk' | 'record', rid: string, row: any | null) {
    const text = row ? vectorText(kind, row) : null;
    if (!text || !row?.user_id || !this.enabled(row.user_id)) {
      if (this.store.one('SELECT 1 FROM memory_vectors WHERE kind = ? AND rid = ?', kind, rid)) this.drop(kind, rid);
      return;
    }
    const cur = this.store.one<any>('SELECT text_hash FROM memory_vectors WHERE kind = ? AND rid = ?', kind, rid);
    if (cur && cur.text_hash === this.hash(row.user_id, text)) return;
    if (cur) this.drop(kind, rid);
    this.kick();
  }

  hash(userId: string, text: string) {
    return this.svc.hmac(userId, 'v:' + text, 24);
  }

  /** Remove vectors whose record is gone or changed (after a restore, or a crash between write and index). */
  verify(userId?: string): number {
    const w = userId ? 'AND v.user_id = ?' : '';
    const p = userId ? [userId] : [];
    let n = 0;
    for (const r of this.store.all<any>(`SELECT v.kind, v.rid, v.user_id, v.text_hash FROM memory_vectors v WHERE 1 = 1 ${w}`, ...p)) {
      const row = r.kind === 'item' ? this.store.get<any>('memory_items', r.rid) : r.kind === 'chunk' ? this.store.one<any>("SELECT c.* FROM memory_chunks c JOIN memory_sources s ON s.id = c.source_id WHERE c.id = ? AND s.status = 'active'", r.rid) : r.kind === 'record' ? this.store.one<any>(ARCHIVE_ROW, r.rid) : null;
      const text = row ? vectorText(r.kind, row) : null;
      if (!text || row.user_id !== r.user_id || this.hash(r.user_id, text) !== r.text_hash || !this.enabled(r.user_id)) {
        this.drop(r.kind, r.rid);
        n++;
      }
    }
    return n;
  }

  counts(userId: string) {
    const v = (kind: string) => this.store.one<any>('SELECT COUNT(*) AS n FROM memory_vectors WHERE user_id = ? AND kind = ?', userId, kind)?.n || 0;
    const items = this.store.one<any>("SELECT COUNT(*) AS n FROM memory_items WHERE user_id = ? AND status IN ('active','proposed') AND sensitivity != 'sensitive' AND content != ''", userId)?.n || 0;
    const chunks = this.store.one<any>("SELECT COUNT(*) AS n FROM memory_chunks c JOIN memory_sources s ON s.id = c.source_id WHERE c.user_id = ? AND s.status = 'active'", userId)?.n || 0;
    return { items: { done: v('item'), total: items }, chunks: { done: v('chunk'), total: chunks } };
  }

  // ------------------------------------------------------------------ search (sync, after the query vector is known)

  /**
   * Score (0..1, see scoreSims) and raw cosine similarity per item id among the items the WHERE clause (alias i, the
   * reader's ACL) allows; `best` = the highest similarity of this search (for the per-turn gate).
   */
  itemScores(qv: QVec, where: string, params: any[]): { scores: Map<string, number>; sims: Map<string, number>; best: number } {
    const sims: [string, number][] = [];
    for (const r of this.store.all<any>(`SELECT i.id FROM memory_vectors v JOIN memory_items i ON i.id = v.rid WHERE v.kind = 'item' AND v.model = ? AND ${where}`, qv.model, ...params)) {
      const vec = this.vecOf('item', r.id, qv.model);
      if (vec) sims.push([r.id, dot(qv.vec, vec)]);
    }
    return { scores: scoreSims(qv.model, sims), sims: new Map(sims), best: sims.reduce((m, x) => Math.max(m, x[1]), -1) };
  }

  /**
   * Similarity per document chunk of these owners (optionally one dossier, or only the dossiers a reader may read —
   * the reader's walls, decided on the source rows, never by the vectors).
   */
  chunkScores(qv: QVec, userIds: string[], dossierId?: string | null, dossierIds?: string[] | null): Map<string, number> {
    if (!userIds.length || (dossierIds && !dossierIds.length)) return new Map();
    const rows = this.store.all<any>(
      `SELECT c.id FROM memory_vectors v JOIN memory_chunks c ON c.id = v.rid JOIN memory_sources s ON s.id = c.source_id WHERE v.kind = 'chunk' AND v.model = ? AND s.status = 'active' AND c.user_id IN (${userIds.map(() => '?').join(',')})${dossierId ? ' AND c.dossier_id = ?' : ''}${dossierIds ? ` AND c.dossier_id IN (${dossierIds.map(() => '?').join(',')})` : ''}`,
      qv.model,
      ...userIds,
      ...(dossierId ? [dossierId] : []),
      ...(dossierIds || []),
    );
    const sims: [string, number][] = [];
    for (const r of rows) {
      const vec = this.vecOf('chunk', r.id, qv.model);
      if (vec) sims.push([r.id, dot(qv.vec, vec)]);
    }
    return scoreSims(qv.model, sims);
  }

  /** Similarity per archive line of these owners, among the dossiers a reader may read (the walls on the record rows). */
  recordScores(qv: QVec, userIds: string[], dossierIds: string[]): Map<string, number> {
    if (!userIds.length || !dossierIds.length) return new Map();
    const rows = this.store.all<any>(
      `SELECT r.id FROM memory_vectors v JOIN memory_records r ON r.id = v.rid WHERE v.kind = 'record' AND v.model = ? AND r.status = 'active' AND r.user_id IN (${userIds.map(() => '?').join(',')}) AND r.dossier_id IN (${dossierIds.map(() => '?').join(',')})`,
      qv.model,
      ...userIds,
      ...dossierIds,
    );
    const sims: [string, number][] = [];
    for (const r of rows) {
      const vec = this.vecOf('record', r.id, qv.model);
      if (vec) sims.push([r.id, dot(qv.vec, vec)]);
    }
    return scoreSims(qv.model, sims);
  }

  // ------------------------------------------------------------------ background indexer

  start() {
    this.stopped = false;
    try {
      this.upgradeBuiltin();
    } catch (e: any) {
      this.svc.ctx.log.warn('[memory] nieuwe versie van het zoekmodel ophalen mislukt', String(e?.message || e).slice(0, 200));
    }
  }

  stop() {
    this.stopped = true;
    this.builtin.release();
    if (this.timer) clearInterval(this.timer);
    if (this.kickTimer) clearTimeout(this.kickTimer);
    this.timer = null;
    this.kickTimer = null;
  }

  /** Something new to embed: run soon (debounced). */
  kick() {
    if (this.stopped || this.kickTimer) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      void this.run();
    }, 400);
    this.kickTimer.unref?.();
  }

  /** One pass over everything that is missing a vector (single-flight; a request during a pass runs once more). */
  run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again);
      } catch (e) {
        this.svc.ctx.log.warn('[memory] zoeken op betekenis: indexeren mislukt', (e as any)?.message || e);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /** Tests and diagnostics: embed everything that is pending now and wait for it. */
  async drain() {
    this.forgetInfo();
    await this.run();
    if (this.running) await this.running;
  }

  private async pass() {
    const users = this.store
      .all<any>("SELECT DISTINCT user_id FROM memory_items WHERE status IN ('active','proposed') UNION SELECT DISTINCT user_id FROM memory_chunks UNION SELECT DISTINCT user_id FROM memory_records WHERE kind = 'event' AND status = 'active'")
      .map((r) => r.user_id as string);
    for (const userId of users) {
      if (!this.enabled(userId)) continue;
      const info = await this.info(userId).catch(() => null);
      if (!info?.engine) continue;
      const engine = info.engine;
      // Another model was chosen (or installed): its vectors are not comparable, so they are made again.
      this.store.exec('DELETE FROM memory_vectors WHERE user_id = ? AND model != ?', userId, engine.model);
      const started = Date.now();
      for (;;) {
        const items = this.store
          .all<any>("SELECT i.* FROM memory_items i WHERE i.user_id = ? AND i.status IN ('active','proposed') AND i.sensitivity != 'sensitive' AND i.content != '' AND NOT EXISTS (SELECT 1 FROM memory_vectors v WHERE v.kind = 'item' AND v.rid = i.id) LIMIT 32", userId)
          .map((r) => ({ kind: 'item' as const, row: r }));
        const chunks = this.store
          .all<any>("SELECT c.* FROM memory_chunks c JOIN memory_sources s ON s.id = c.source_id WHERE c.user_id = ? AND s.status = 'active' AND NOT EXISTS (SELECT 1 FROM memory_vectors v WHERE v.kind = 'chunk' AND v.rid = c.id) LIMIT 16", userId)
          .map((r) => ({ kind: 'chunk' as const, row: r }));
        const records = this.store
          .all<any>("SELECT r.* FROM memory_records r WHERE r.user_id = ? AND r.kind = 'event' AND r.status = 'active' AND json_extract(r.data, '$.archive') AND NOT EXISTS (SELECT 1 FROM memory_vectors v WHERE v.kind = 'record' AND v.rid = r.id) LIMIT 16", userId)
          .map((r) => ({ kind: 'record' as const, row: r }));
        const todo = [...items, ...chunks, ...records].map((x) => ({ ...x, text: vectorText(x.kind, x.row) })).filter((x) => x.text) as { kind: 'item' | 'chunk' | 'record'; row: any; text: string }[];
        if (!todo.length) break;
        let vecs: Float32Array[];
        try {
          vecs = await this.embed(engine, todo.map((x) => x.text), 'doc');
        } catch (e: any) {
          if (engine.kind === 'builtin') this.noteBuiltinError(e);
          else {
            this.infos.set(userId, { at: Date.now(), info: { ...info, state: 'unreachable', engine: null, error: String(e?.message || e).slice(0, 200) } });
            this.svc.ctx.log.warn('[memory] zoeken op betekenis: Ollama gaf geen vectoren', String(e?.message || e).slice(0, 200));
          }
          break;
        }
        const ts = now();
        this.store.tx(() => {
          todo.forEach((x, i) => {
            // The record may have changed (or been forgotten) while Ollama was busy: only the text that was embedded.
            const cur = x.kind === 'item' ? this.store.get<any>('memory_items', x.row.id) : x.kind === 'record' ? this.store.one<any>(ARCHIVE_ROW, x.row.id) : this.store.one<any>("SELECT c.* FROM memory_chunks c JOIN memory_sources s ON s.id = c.source_id WHERE c.id = ? AND s.status = 'active'", x.row.id);
            if (!cur || vectorText(x.kind, cur) !== x.text) return;
            this.store.exec(
              'INSERT OR REPLACE INTO memory_vectors (kind, rid, user_id, model, dim, text_hash, vec, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              x.kind,
              x.row.id,
              userId,
              engine.model,
              vecs[i].length,
              this.hash(userId, x.text),
              toBlob(vecs[i]),
              ts,
            );
            this.vecs.set(`${x.kind}:${x.row.id}`, { model: engine.model, vec: vecs[i] });
          });
        });
        if (Date.now() - started > 60_000 || this.stopped) break;
      }
    }
  }

  // ------------------------------------------------------------------ model download (the owner's explicit choice)

  /** Download an embedding model with the owner's Ollama (one at a time per provider; progress in `pulls`). */
  pull(userId: string, engine: { providerId: string; origin: string }, model: string, done?: () => void): PullState {
    const cur = this.pulls.get(engine.providerId);
    if (cur?.status === 'running') return cur;
    const st: PullState = { model, status: 'running', completed: 0, total: 0, at: now() };
    this.pulls.set(engine.providerId, st);
    void (async () => {
      try {
        const r = await fetch(`${engine.origin}/api/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: true }), redirect: 'error', signal: AbortSignal.timeout(3 * 3600_000) });
        if (!r.ok || !r.body) throw new Error(`HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let m: any;
            try {
              m = JSON.parse(line);
            } catch {
              continue;
            }
            if (m.error) throw new Error(String(m.error).slice(0, 200));
            if (Number(m.total) > 0) {
              st.total = Number(m.total);
              st.completed = Number(m.completed) || 0;
            }
            if (m.status === 'success') st.status = 'done';
          }
        }
        if (st.status !== 'done') throw new Error('De download stopte voordat hij klaar was');
        st.completed = st.total;
      } catch (e: any) {
        st.status = 'error';
        st.error = String(e?.message || e).slice(0, 200);
      }
      st.at = now();
      this.forgetInfo();
      if (st.status === 'done') this.kick();
      done?.();
    })();
    void userId;
    return st;
  }
}
