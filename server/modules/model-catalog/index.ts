import type { Ctx, ModelInfo, Module, ProviderConfig } from '../../core/types.js';
import { ah, bad, requireRole, user } from '../../core/http.js';
import { redact } from '../../core/secrets.js';
import { decorateModels, oneModelInfo } from '../../api/providers.js';
import { isForeignShared, sharedPolicy } from '../../api/provider-policy.js';
import { catalogAgeDays, catalogStatus, loadCachedCatalog, refreshCatalog } from '../../providers/models-dev.js';
import type { ModelGroup } from '../../../shared/types.js';

/**
 * Modelgegevens (0.4.4): the models.dev catalogue behind context windows, prices and capabilities of models
 * (server/providers/models-dev.ts). A dated snapshot ships with TeamBot; this module takes a newer refreshed copy from
 * the data folder at start (in the background, never blocking) and, only when the owner turned on
 * `modelCatalog.refresh` (whatever leaves the pc stays off until then, PROVIDER_POLICY rule 8), downloads it again
 * once a day. Offline nothing changes: the snapshot or the last copy stays in use. See docs/modules/model-catalog.md.
 *
 * Routes: GET /api/model-catalog (everyone: date, source, counts, whether the refresh is on),
 * PUT /api/model-catalog { refresh } and POST /api/model-catalog/refresh (owner/admin),
 * GET /api/model-catalog/choices (everyone: the models of every connected AI, see modelChoices).
 */

const KEY = 'modelCatalog.refresh';
const HOUR = 3_600_000;

/** One connected AI with the models a bot can be put on: shared/types.ts (the model switcher reads it). */
export type { ModelGroup };

/** A list that does not come within this time is left out for now; the other AIs are not held up by it. */
const LIST_TIMEOUT_MS = 20_000;
/** `soft`: answer with what is there after this long (a CLI that reads its models for the first time takes seconds). */
const SOFT_MS = 1_500;
/** Opening the list twice in a row (or on the phone and the computer) asks every AI once. */
const LIST_TTL_MS = 30_000;
/** What asking one AI gave: whether it is connected (a CLI: installed and logged in) and its models. */
interface Reading {
  connected: boolean;
  models: ModelInfo[];
  error?: string;
}
const lists = new Map<string, { at: number; v: Promise<Reading> }>();

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Geen antwoord binnen de tijd')), ms);
    timer.unref?.();
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

/**
 * Connected = the connection is on and its kind still exists (`usable`), and for a CLI (Claude Code, Codex,
 * OpenCode …) the program is on this computer and logged in (`cliReady`: it asks the program, which takes a moment).
 * A CLI connection with its own program path is taken as it is: the status of the default program says nothing
 * about it.
 */
function usable(ctx: Ctx, cfg: ProviderConfig): boolean {
  const k = ctx.providers.kind(cfg.kind);
  return cfg.enabled && !!k && !k.retired;
}

async function cliReady(ctx: Ctx, cfg: ProviderConfig): Promise<boolean> {
  if (ctx.providers.kind(cfg.kind)?.type !== 'cli' || cfg.config?.path || cfg.config?.command) return true;
  let st: any = null;
  try {
    st = await ctx.services['cli-agents']?.status?.(cfg.kind);
  } catch {
    st = null;
  }
  return !(st && (st.installed === false || st.loggedIn === false));
}

/** The models of one connection, as GET /api/providers/:id/models gives them (prices, levels, the admin's model policy). */
async function listFor(ctx: Ctx, cfg: ProviderConfig, userId: string, timeoutMs: number): Promise<ModelInfo[]> {
  const k = ctx.providers.kind(cfg.kind);
  const decorate = (list: ModelInfo[]) => (k?.type === 'api' ? decorateModels(k, list, cfg.config) : list);
  if (isForeignShared(cfg, userId) && sharedPolicy(cfg).memberModels.length) return decorate(sharedPolicy(cfg).memberModels.map((id) => ({ id })));
  const fixed = (k?.models || []).map((id) => ({ id }));
  try {
    const models = await within(ctx.providers.adapterFor(cfg).listModels(), timeoutMs);
    return decorate(models.length ? models : fixed);
  } catch (e) {
    if (fixed.length) return decorate(fixed);
    throw e;
  }
}

/**
 * What TeamBot knows of one model of a connection (tools, images, context …): its entry in that list, as the bot page
 * shows it (ui/src/components/ModelFacts.tsx), else what the dated tables say of it. A list that cannot be read in
 * `timeoutMs` counts as empty.
 */
export async function modelFacts(ctx: Ctx, cfg: ProviderConfig, userId: string, model: string, timeoutMs = 10_000): Promise<ModelInfo> {
  const list = await listFor(ctx, cfg, userId, timeoutMs).catch((): ModelInfo[] => []);
  return list.find((m) => m.id === model) || oneModelInfo(ctx.providers.kind(cfg.kind), cfg, model);
}

/**
 * Every model of every AI this user has connected, grouped per AI in the order they were connected: Claude Code,
 * Codex and OpenCode with their own lists, providers with an API key, local servers (Ollama, LM Studio). An AI that
 * is switched off, not installed or logged out is left out; with `agentId`, also an AI that bot may not use (a key
 * for another team). The AIs are asked side by side; one that fails or is slow comes back empty with `error`.
 * With `softMs` the answer does not wait longer than that: an AI that is still being asked comes back empty with
 * `pending`, and the next call gets it from the same reading (it is not started twice).
 */
export async function modelChoices(ctx: Ctx, userId: string, o: { agentId?: string; fresh?: boolean; timeoutMs?: number; softMs?: number } = {}): Promise<ModelGroup[]> {
  const agent = o.agentId ? ctx.store.agent(o.agentId) : null;
  const mine = agent && agent.user_id === userId ? agent : null;
  const out = await Promise.all(
    ctx.providers.list(userId).map(async (cfg): Promise<ModelGroup | null> => {
      if (!usable(ctx, cfg)) return null;
      if (mine && ctx.providers.refuseFor(mine, cfg)) return null;
      const k = ctx.providers.kind(cfg.kind)!;
      // The model a bot without one runs on here, as the runner picks it (agent/engines.ts, api/provider-policy.ts).
      const allowed = isForeignShared(cfg, userId) ? sharedPolicy(cfg).memberModels : [];
      const defaultModel = [allowed[0], cfg.config?.defaultModel, k.defaultModel, k.models?.[0]].find((m) => typeof m === 'string' && m) || undefined;
      const provider: ModelGroup['provider'] = { id: cfg.id, name: cfg.name, kind: cfg.kind, kindLabel: k.label, type: k.type, billing: k.billing, own: cfg.user_id === userId, defaultModel };
      const key = `${userId}\n${cfg.id}\n${JSON.stringify([cfg.name, cfg.base_url, cfg.secret_id, cfg.config])}`;
      const hit = lists.get(key);
      let v = hit && !o.fresh && Date.now() - hit.at < LIST_TTL_MS ? hit.v : null;
      if (!v) {
        const reading: Promise<Reading> = cliReady(ctx, cfg)
          .then(async (ready): Promise<Reading> => (ready ? { connected: true, models: await listFor(ctx, cfg, userId, o.timeoutMs ?? LIST_TIMEOUT_MS) } : { connected: false, models: [] }))
          .catch((e): Reading => {
            // Not kept: the next look asks again (the local server may be on by then).
            if (lists.get(key)?.v === reading) lists.delete(key);
            return { connected: true, models: [], error: redact(String(e?.message || e)).slice(0, 200) };
          });
        v = reading;
        lists.set(key, { at: Date.now(), v });
        if (lists.size > 300) lists.delete(lists.keys().next().value!);
      }
      const done = v.then((r): ModelGroup | null => (r.connected ? { provider, models: r.models, ...(r.error ? { error: r.error } : {}) } : null));
      if (!o.softMs) return done;
      let timer: NodeJS.Timeout | undefined;
      const soon = new Promise<ModelGroup>((resolve) => {
        timer = setTimeout(() => resolve({ provider, models: [], pending: true }), o.softMs);
        timer.unref?.();
      });
      return Promise.race([done, soon]).finally(() => clearTimeout(timer));
    }),
  );
  return out.filter((g): g is ModelGroup => !!g);
}

let timer: NodeJS.Timeout | null = null;
let first: NodeJS.Timeout | null = null;
let busy = false;
let lastTry = 0;
let tick: () => void = () => {};

const mod: Module = {
  id: 'model-catalog',
  label: 'Modelgegevens',
  init(ctx) {
    const on = () => ctx.store.getSetting<boolean>('', KEY, false) === true;
    const view = (req: any) => {
      const u = user(req);
      return { ...catalogStatus(), refresh: on(), canEdit: u.role === 'owner' || u.role === 'admin' };
    };
    const refresh = async () => {
      if (busy) return;
      busy = true;
      lastTry = Date.now();
      try {
        const r = await refreshCatalog(ctx.config.dataDir);
        if (!r.ok) ctx.log.warn(`[model-catalog] models.dev niet bijgewerkt: ${r.error}`);
      } finally {
        busy = false;
      }
    };
    ctx.services.modelCatalog = { refresh, status: catalogStatus, facts: (cfg: ProviderConfig, userId: string, model: string) => modelFacts(ctx, cfg, userId, model) };

    ctx.api.get('/model-catalog', ah(async (req) => view(req)));
    ctx.api.get(
      '/model-catalog/choices',
      ah(async (req) => ({
        groups: await modelChoices(ctx, user(req).id, { agentId: typeof req.query.agentId === 'string' ? req.query.agentId.slice(0, 60) : undefined, fresh: req.query.fresh === '1', softMs: req.query.soft === '1' ? SOFT_MS : undefined }),
      })),
    );
    ctx.api.put(
      '/model-catalog',
      ah(async (req) => {
        const me = requireRole(req, 'admin');
        if (typeof req.body?.refresh !== 'boolean') throw bad('Geef refresh: true of false');
        ctx.store.setSetting('', KEY, req.body.refresh);
        ctx.audit(me.id, 'model_catalog.refresh_setting', { on: req.body.refresh });
        // Just turned on and the data is older than a day: fetch it now, in the background.
        if (req.body.refresh && catalogAgeDays() >= 1) void refresh();
        return view(req);
      }),
    );
    ctx.api.post(
      '/model-catalog/refresh',
      ah(async (req) => {
        const me = requireRole(req, 'admin');
        await refresh();
        ctx.audit(me.id, 'model_catalog.refresh', { fetched: catalogStatus().fetched, error: catalogStatus().error });
        return view(req);
      }),
    );

    tick = () => {
      if (on() && !busy && catalogAgeDays() >= 1 && Date.now() - lastTry > 6 * HOUR) void refresh();
    };
  },
  start(ctx) {
    void loadCachedCatalog(ctx.config.dataDir);

    first = setTimeout(() => tick(), 60_000);
    first.unref?.();
    timer = setInterval(() => tick(), HOUR);
    timer.unref?.();
  },
  stop() {
    if (first) clearTimeout(first);
    if (timer) clearInterval(timer);
    first = timer = null;
    lists.clear();
  },
};

export default mod;
