import fs from 'node:fs';
import path from 'node:path';
import SNAPSHOT_JSON from './models-dev-snapshot.json' with { type: 'json' };

/**
 * Model facts from models.dev (MIT data, https://models.dev, maintained by the OpenCode team; licence in
 * third_party/models.dev/LICENSE): context window, output limit, list price, tool calling, image input and thinking,
 * for the providers TeamBot connects to. Order of trust stays "never a guess, always a dated source":
 *
 *   own price (prices) → the provider's own live model list → TeamBot's small override table (pricing.ts and
 *   capabilities.ts: only where models.dev lacks a fact or has it wrong) → this catalogue → "onbekend".
 *
 * A trimmed, dated snapshot ships with TeamBot (models-dev-snapshot.json, built by `npm run models:snapshot`), so it
 * works offline and from the first second. The optional daily refresh (setting `modelCatalog.refresh`, off by default:
 * whatever leaves the pc stays off until the owner turns it on, PROVIDER_POLICY rule 8) downloads models.dev's
 * api.json in the background, trims it the same way and keeps it in `<data>/cache/models-dev.json`. Nothing here ever
 * blocks startup or a model call: a failed download keeps what there was.
 */

/** One model in the trimmed catalogue (short keys: the snapshot ships with every install). */
export interface CatalogRow {
  /** Context window (tokens). */
  c?: number;
  /** Output limit (tokens). */
  o?: number;
  /** USD per 1M tokens [input, output]; only when at least one is above zero (0/0 is not taken as "free"). */
  p?: [number, number];
  /** USD per 1M cached input tokens. */
  cr?: number;
  /** Tool calling. */
  t?: boolean;
  /** Image input. */
  v?: boolean;
  /** Thinking. */
  r?: boolean;
  /** Effort values the model takes (models.dev reasoning_options type "effort"). */
  e?: string[];
}

export interface Catalog {
  source: 'models.dev';
  /** Day the data was read from models.dev (YYYY-MM-DD). */
  fetched: string;
  providers: Record<string, Record<string, CatalogRow>>;
}

/** TeamBot provider kind → models.dev provider ids (first match wins). Local servers are not in it: they are free. */
export const MODELS_DEV_IDS: Record<string, string[]> = {
  anthropic: ['anthropic'],
  'claude-code': ['anthropic'],
  openai: ['openai'],
  codex: ['openai'],
  // No azure: a deployment name is chosen by the owner and need not be the model's id.
  google: ['google'],
  vertex: ['google-vertex', 'google-vertex-anthropic'],
  bedrock: ['amazon-bedrock'],
  groq: ['groq'],
  cerebras: ['cerebras'],
  mistral: ['mistral'],
  openrouter: ['openrouter'],
  zai: ['zai'],
  nvidia: ['nvidia'],
  cloudflare: ['cloudflare-workers-ai'],
  kilo: ['kilo'],
  xai: ['xai'],
  deepseek: ['deepseek'],
  moonshot: ['moonshotai'],
  qwen: ['alibaba'],
  minimax: ['minimax'],
  together: ['togetherai'],
  fireworks: ['fireworks-ai'],
  deepinfra: ['deepinfra'],
  huggingface: ['huggingface'],
  perplexity: ['perplexity'],
  opencode: ['opencode'],
};

export const MODELS_DEV_URL = 'https://models.dev/api.json';
const MAX_BYTES = 40 * 1024 * 1024;
const num = (x: any) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : undefined);

/** models.dev's api.json → the trimmed catalogue (only the providers in MODELS_DEV_IDS, only the facts TeamBot uses). */
export function trimCatalog(api: any, fetched: string): Catalog {
  const wanted = new Set(Object.values(MODELS_DEV_IDS).flat());
  const providers: Catalog['providers'] = {};
  for (const id of [...wanted].sort()) {
    const models = api?.[id]?.models;
    if (!models || typeof models !== 'object') continue;
    const out: Record<string, CatalogRow> = {};
    for (const key of Object.keys(models).sort()) {
      const m = models[key];
      if (!m || typeof m !== 'object') continue;
      const row: CatalogRow = {};
      const c = num(m.limit?.context);
      if (c) row.c = c;
      const o = num(m.limit?.output);
      if (o) row.o = o;
      const pin = num(m.cost?.input);
      const pout = num(m.cost?.output);
      if (pin !== undefined && pout !== undefined && pin + pout > 0 && pin < 10_000 && pout < 10_000) {
        row.p = [pin, pout];
        const cr = num(m.cost?.cache_read);
        if (cr !== undefined) row.cr = cr;
      }
      if (typeof m.tool_call === 'boolean') row.t = m.tool_call;
      if (Array.isArray(m.modalities?.input)) row.v = m.modalities.input.includes('image');
      if (typeof m.reasoning === 'boolean') row.r = m.reasoning;
      const effort = (Array.isArray(m.reasoning_options) ? m.reasoning_options : []).find((x: any) => x?.type === 'effort' && Array.isArray(x.values));
      if (effort) row.e = effort.values.map(String).slice(0, 12);
      if (Object.keys(row).length) out[String(m.id || key)] = row;
    }
    if (Object.keys(out).length) providers[id] = out;
  }
  return { source: 'models.dev', fetched, providers };
}

function valid(c: any): c is Catalog {
  return !!c && c.source === 'models.dev' && /^\d{4}-\d{2}-\d{2}$/.test(String(c.fetched)) && !!c.providers && typeof c.providers === 'object' && Object.keys(c.providers).length >= 5;
}

const SNAPSHOT = SNAPSHOT_JSON as unknown as Catalog;
let current: Catalog = SNAPSHOT;
let origin: 'snapshot' | 'refresh' = 'snapshot';
let lastError: string | null = null;

/** The catalogue in use and where it came from (shown next to a model: "bron: models.dev, <date>"). */
export function catalogStatus() {
  let models = 0;
  for (const p of Object.values(current.providers)) models += Object.keys(p).length;
  return { source: current.source, fetched: current.fetched, origin, snapshot: SNAPSHOT.fetched, providers: Object.keys(current.providers).length, models, error: lastError };
}

/** Test hook: back to the bundled snapshot, or a given catalogue. */
export function useCatalog(c?: Catalog) {
  current = c ?? SNAPSHOT;
  origin = c ? 'refresh' : 'snapshot';
  lastError = null;
}

/** Bedrock/Vertex/dated ids → forms models.dev may use for the same model. */
function candidates(model: string): string[] {
  const m = String(model || '').trim();
  const plain = m
    .replace(/^(us|eu|apac|global|jp|au)\./, '')
    .replace(/@\d{8}$/, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '');
  const out = [m, plain, m.toLowerCase(), plain.replace(/^(anthropic|openai|google)[./]/, ''), plain.replace(/-v\d+:\d+$/, '').replace(/^anthropic\./, ''), plain.replace(/-\d{8}$/, '')];
  return [...new Set(out.filter(Boolean))];
}

/** The catalogue row for a model on a provider kind, with the day it was read; null when models.dev does not know it. */
export function catalogInfo(kind: string, model: string): (CatalogRow & { checked: string; provider: string }) | null {
  const ids = MODELS_DEV_IDS[kind];
  if (!ids || !model) return null;
  for (const id of ids) {
    const p = current.providers[id];
    if (!p) continue;
    for (const k of candidates(model)) if (Object.hasOwn(p, k)) return { ...p[k], checked: current.fetched, provider: id };
  }
  return null;
}

// ------------------------------------------------------------------ cache and refresh (never blocking)

export const cacheFile = (dataDir: string) => path.join(dataDir, 'cache', 'models-dev.json');

/** Take the refreshed catalogue from an earlier day when it is newer than the snapshot (async; startup goes on). */
export async function loadCachedCatalog(dataDir: string): Promise<boolean> {
  try {
    const c = JSON.parse(await fs.promises.readFile(cacheFile(dataDir), 'utf8'));
    if (!valid(c) || c.fetched < current.fetched) return false;
    current = c;
    origin = 'refresh';
    return true;
  } catch {
    return false;
  }
}

/** Days since the catalogue in use was read. */
export const catalogAgeDays = (now = Date.now()) => Math.floor((now - Date.parse(`${current.fetched}T00:00:00Z`)) / 86_400_000);

/**
 * Download models.dev, trim it and keep it (data dir + memory). Errors are kept for the status line and never thrown:
 * the catalogue that was there stays.
 */
export async function refreshCatalog(dataDir: string, o: { fetch?: typeof fetch; url?: string; timeoutMs?: number; now?: Date } = {}): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await (o.fetch || fetch)(o.url || MODELS_DEV_URL, { signal: AbortSignal.timeout(o.timeoutMs ?? 60_000), redirect: 'follow', headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const len = Number(r.headers.get('content-length') || 0);
    if (len > MAX_BYTES) throw new Error('too large');
    const text = await r.text();
    if (text.length > MAX_BYTES) throw new Error('too large');
    const c = trimCatalog(JSON.parse(text), (o.now || new Date()).toISOString().slice(0, 10));
    if (!valid(c)) throw new Error('unexpected content');
    const file = cacheFile(dataDir);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(`${file}.tmp`, JSON.stringify(c));
    await fs.promises.rename(`${file}.tmp`, file);
    current = c;
    origin = 'refresh';
    lastError = null;
    return { ok: true };
  } catch (e: any) {
    lastError = String(e?.message || e).slice(0, 200);
    return { ok: false, error: lastError };
  }
}
