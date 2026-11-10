import type { Ctx, ModelInfo, ProviderConfig, ProviderKind } from '../core/types.js';
import { ah, bad, str, user } from '../core/http.js';
import { pickDefault } from '../providers/catalog.js';
import { priceInfo } from '../providers/pricing.js';
import { withCapabilities } from '../providers/capabilities.js';
import { explain } from '../providers/common.js';
import { redact } from '../core/secrets.js';
import { checkMemberProviderUrl, isRestricted } from './member-policy.js';
import { cleanPolicyConfig, isForeignShared, sharedPolicy } from './provider-policy.js';
import { localChatModel, rememberFreeReserve } from '../agent/alternatives.js';

const detectCache = new Map<string, { at: number; v: any }>();

async function detect(ctx: Ctx, k: ProviderKind) {
  if (!k.detect) return null;
  const c = detectCache.get(k.id);
  if (c && Date.now() - c.at < 20_000) return c.v;
  let v: any;
  try {
    v = await Promise.race([k.detect(ctx), new Promise((r) => setTimeout(() => r({ installed: false, detail: 'time-out' }), 6000))]);
  } catch (e: any) {
    v = { installed: false, detail: e?.message };
  }
  detectCache.set(k.id, { at: Date.now(), v });
  return v;
}

/**
 * Default engine for new bots, cheapest smart route first: Claude Code on a subscription → Codex on a subscription →
 * OpenCode (free model) → local models (Ollama, LM Studio) → free API tiers → paid API keys.
 */
export async function providerRank(ctx: Ctx, p: ProviderConfig): Promise<number> {
  if (!p.enabled) return 99;
  const k = ctx.providers.kind(p.kind);
  if (k?.type === 'cli') {
    let st: any = null;
    try {
      st = await ctx.services['cli-agents']?.status?.(p.kind);
    } catch {
      st = null;
    }
    if (st && (st.installed === false || st.loggedIn === false)) return 90;
    if (p.kind === 'claude-code') return st?.billing === 'api' ? 50 : 0;
    if (p.kind === 'codex-cli') return st?.billing === 'api' ? 51 : 1;
    if (p.kind === 'opencode') return 2;
    return st?.billing === 'subscription' ? 3 : 40;
  }
  if (k?.group === 'local') return 10;
  if (k?.group === 'free') return 20;
  return 30;
}

/** Pick (or re-pick) the default engine while the user has not chosen one himself. */
export async function autoDefaultProvider(ctx: Ctx, userId: string) {
  const cur = ctx.store.getSetting<string | null>(userId, 'defaultProvider', null);
  const auto = ctx.store.getSetting<boolean>(userId, 'defaultProviderAuto', true);
  if (cur && ctx.providers.config(cur) && auto === false) return;
  const own = ctx.providers.list(userId).filter((p) => p.user_id === userId);
  if (!own.length) return;
  const ranked = await Promise.all(own.map(async (p) => ({ p, r: await providerRank(ctx, p) })));
  ranked.sort((a, b) => a.r - b.r);
  const best = ranked[0].p;
  if (best.id === cur) return;
  const k = ctx.providers.kind(best.kind);
  ctx.store.setSetting(userId, 'defaultProvider', best.id);
  ctx.store.setSetting(userId, 'defaultModel', best.config?.defaultModel || k?.defaultModel || '');
  ctx.store.setSetting(userId, 'defaultProviderAuto', true);
  ctx.audit(userId, 'provider.default_auto', { provider: best.id, kind: best.kind });
}

/** OpenCode without a chosen model: start on a free model (no account or key needed). */
export async function ensureFreeDefaultModel(ctx: Ctx, cfg: ProviderConfig, userId: string): Promise<ProviderConfig> {
  if (cfg.kind !== 'opencode' || cfg.config?.defaultModel) return cfg;
  try {
    const models = await ctx.providers.adapterFor(cfg).listModels();
    const free = models.filter((m) => m.billing === 'free');
    const pick = free.find((m) => m.id === 'opencode/big-pickle') || free[0];
    if (!pick) return cfg;
    return ctx.providers.updateConfig(cfg.id, userId, { config: { ...cfg.config, defaultModel: pick.id } });
  } catch {
    return cfg;
  }
}

export function kindView(k: ProviderKind) {
  const { create, detect, recommend, ...rest } = k;
  return { ...rest, canDetect: !!detect };
}

/** Models for the UI: price (live list → dated table), free flag and the recommended default marked. */
export function decorateModels(k: ProviderKind | undefined, models: ModelInfo[], config?: Record<string, any>): (ModelInfo & { recommended?: boolean; priceSource?: string; priceChecked?: string })[] {
  const rec = k ? pickDefault(models, k.recommend) || (k.defaultModel && models.some((m) => m.id === k.defaultModel) ? k.defaultModel : undefined) : undefined;
  return models.map((m0) => {
    const m = k ? withCapabilities(k.id, k.reasoningStyle, m0) : m0;
    const info = k ? priceInfo(k.id, m.id, config) : null;
    const price = m.price || info?.price;
    const free = m.free || (price ? price[0] === 0 && price[1] === 0 : undefined);
    return { ...m, price, free: free || undefined, priceSource: m.price ? 'lijst' : info?.source, priceChecked: info?.checked, recommended: m.id === rec || undefined };
  });
}

/** Required provider settings (Azure resource, Cloudflare account, Bedrock region). */
export function checkRequiredFields(k: ProviderKind, base_url: string | undefined, config: any) {
  for (const f of k.fields || []) {
    if (!f.required) continue;
    const v = f.key === 'base_url' ? base_url : config?.[f.key];
    if (!String(v ?? '').trim()) throw bad(`Vul "${f.label}" in voor ${k.label}`);
  }
}

export function providerRoutes(ctx: Ctx) {
  const api = ctx.api;

  api.get(
    '/provider-kinds',
    ah(async (req) => {
      const kinds = [...ctx.providers.kinds.values()];
      const withDetect = req.query.detect === '1';
      return Promise.all(kinds.map(async (k) => ({ ...kindView(k), status: withDetect ? await detect(ctx, k) : undefined })));
    }),
  );

  /**
   * "Sleutel controleren" before connecting: a free check (key/credit endpoint or model list, never a paid prompt)
   * with a plain-language fix hint, plus the live model list with prices and a recommended default.
   */
  api.post(
    '/provider-kinds/:id/check',
    ah(async (req) => {
      const u = user(req);
      const k = ctx.providers.kind(String(req.params.id));
      if (!k || k.type !== 'api') throw bad('Onbekend providertype');
      const b = req.body || {};
      const base_url = str(b.base_url, 500) || '';
      await checkMemberProviderUrl(ctx, u, base_url || k.baseUrl);
      const config = b.config && typeof b.config === 'object' ? cleanPolicyConfig(b.config, u.role) : {};
      checkRequiredFields(k, base_url, config);
      const apiKey = b.apiKey ? str(b.apiKey, 20_000).trim() : null;
      if (k.needsKey && !k.keyOptional && !apiKey) throw bad(`${k.label} heeft een API-sleutel nodig`);
      const cfg: ProviderConfig = { id: 'check', user_id: u.id, kind: k.id, name: k.label, base_url, secret_id: null, config, enabled: true, shared: false, created_at: new Date().toISOString() };
      let adapter;
      try {
        adapter = k.create(cfg, apiKey, ctx);
      } catch (e: any) {
        return { ok: false, detail: e?.message || String(e), ...explain(e, { keyUrl: k.keyUrl }), models: [] };
      }
      const t = await adapter.test();
      let models: ModelInfo[] = [];
      if (t.ok) {
        try {
          models = await adapter.listModels();
        } catch (e: any) {
          if (!(k.models || []).length) return { ...t, ok: false, detail: e?.message || String(e), ...explain(e, { keyUrl: k.keyUrl }) };
        }
        if (!models.length && k.models?.length) models = k.models.map((id) => ({ id }));
      }
      return { ...t, models: decorateModels(k, models, config) };
    }),
  );

  api.get(
    '/providers',
    ah(async (req) => {
      const u = user(req);
      return ctx.providers.list(u.id).map((p) => ctx.providers.view(p, u.id));
    }),
  );

  api.post(
    '/providers',
    ah(async (req) => {
      const u = user(req);
      const b = req.body || {};
      if (b.shared && u.role === 'member') throw bad('Alleen beheerders kunnen providers delen met alle gebruikers');
      await checkMemberProviderUrl(ctx, u, str(b.base_url, 500) || ctx.providers.kind(str(b.kind, 60))?.baseUrl);
      const kk = ctx.providers.kind(str(b.kind, 60));
      if (kk?.retired) throw bad(`${kk.label} is gestopt op ${kk.retired}; kies een andere provider.`);
      if (kk) checkRequiredFields(kk, str(b.base_url, 500), b.config);
      let p = ctx.providers.create(u.id, { kind: str(b.kind, 60), name: str(b.name, 80), base_url: str(b.base_url, 500), apiKey: b.apiKey ? str(b.apiKey, 20_000) : undefined, config: cleanPolicyConfig(b.config, u.role), shared: !!b.shared });
      if (!ctx.store.getSetting(u.id, 'defaultProvider', null)) {
        ctx.store.setSetting(u.id, 'defaultProvider', p.id);
        const k = ctx.providers.kind(p.kind);
        if (b.config?.defaultModel || k?.defaultModel) ctx.store.setSetting(u.id, 'defaultModel', b.config?.defaultModel || k?.defaultModel);
        ctx.store.setSetting(u.id, 'defaultProviderAuto', true);
      } else if (ctx.store.getSetting<boolean>(u.id, 'defaultProviderAuto', false) === true) {
        // Possibly a better free/subscription engine, while TeamBot still picks the default itself.
        await autoDefaultProvider(ctx, u.id);
      }
      if (p.kind === 'opencode') p = await ensureFreeDefaultModel(ctx, p, u.id);
      ctx.events.emit(u.id, 'provider.updated', ctx.providers.view(p, u.id));
      return ctx.providers.view(p, u.id);
    }),
  );

  api.patch(
    '/providers/:id',
    ah(async (req) => {
      const u = user(req);
      const b = req.body || {};
      if (b.shared && u.role === 'member') throw bad('Alleen beheerders kunnen providers delen');
      if (b.base_url !== undefined) {
        const cur = ctx.providers.config(req.params.id as string);
        await checkMemberProviderUrl(ctx, u, str(b.base_url, 500) || (cur ? ctx.providers.kind(cur.kind)?.baseUrl : undefined));
      }
      const p = ctx.providers.updateConfig(req.params.id as string, u.id, { name: b.name, base_url: b.base_url, apiKey: b.apiKey, config: cleanPolicyConfig(b.config, u.role), enabled: b.enabled, shared: b.shared });
      ctx.events.emit(u.id, 'provider.updated', ctx.providers.view(p, u.id));
      return ctx.providers.view(p, u.id);
    }),
  );

  api.delete(
    '/providers/:id',
    ah(async (req) => {
      const u = user(req);
      const inUse = ctx.store.all<any>('SELECT name FROM agents WHERE provider_id = ? AND user_id = ?', req.params.id, u.id);
      ctx.providers.remove(req.params.id as string, u.id);
      if (ctx.store.getSetting(u.id, 'defaultProvider', null) === req.params.id) ctx.store.setSetting(u.id, 'defaultProvider', null);
      ctx.events.emit(u.id, 'provider.deleted', { id: req.params.id });
      return { ok: true, agentsWithoutProvider: inUse.map((a) => a.name) };
    }),
  );

  api.post(
    '/providers/:id/test',
    ah(async (req) => {
      const u = user(req);
      const cfg = ctx.providers.config(req.params.id as string);
      if (!ctx.providers.canUse(u.id, cfg)) throw bad('Provider niet gevonden');
      // A provider that echoes the key in its error must not hand it to the page (redact masks known secret values).
      const r: any = await ctx.providers.adapterFor(cfg!).test();
      return r && typeof r === 'object' ? { ...r, detail: typeof r.detail === 'string' ? redact(r.detail) : r.detail, hint: typeof r.hint === 'string' ? redact(r.hint) : r.hint } : r;
    }),
  );

  api.get(
    '/providers/:id/models',
    ah(async (req) => {
      const u = user(req);
      const cfg = ctx.providers.config(req.params.id as string);
      if (!ctx.providers.canUse(u.id, cfg)) throw bad('Provider niet gevonden');
      const k = ctx.providers.kind(cfg!.kind);
      // Someone else's shared provider with a model policy: only the allowed models (PRV-06), with what TeamBot knows
      // about them (the owner's own price included: members pay it too; acceptance round 5, C-12 said "onbekend").
      if (isForeignShared(cfg, u.id) && sharedPolicy(cfg).memberModels.length) {
        const ids = sharedPolicy(cfg).memberModels.map((id) => ({ id }));
        return k?.type === 'api' ? decorateModels(k, ids, cfg.config) : ids;
      }
      try {
        const models = await ctx.providers.adapterFor(cfg!).listModels();
        if (k?.type !== 'api') return models.length ? models : (k?.models || []).map((id) => ({ id }));
        return decorateModels(k, models.length ? models : (k?.models || []).map((id) => ({ id })), cfg!.config);
      } catch (e: any) {
        if (k?.models?.length) return decorateModels(k, k.models.map((id) => ({ id })), cfg!.config);
        throw bad(e?.message || String(e));
      }
    }),
  );

  /** What TeamBot knows about one model that is not in the engine's list ("Ander model"): table facts, levels, price. */
  api.get(
    '/providers/:id/model-info',
    ah(async (req) => {
      const u = user(req);
      const cfg = ctx.providers.config(req.params.id as string);
      if (!ctx.providers.canUse(u.id, cfg)) throw bad('Provider niet gevonden');
      const k = ctx.providers.kind(cfg!.kind);
      const model = str(req.query.model, 200).trim();
      if (!model) throw bad('Geen model');
      return k?.type === 'api' ? decorateModels(k, [{ id: model }], cfg!.config)[0] : withCapabilities(cfg!.kind, k?.reasoningStyle, { id: model, tools: true });
    }),
  );

  /**
   * Context window per local model (C-13): Ollama gets it with every chat (num_ctx), LM Studio loads the model with it.
   * tokens null = the server's own setting.
   */
  api.put(
    '/providers/:id/context-window',
    ah(async (req) => {
      const u = user(req);
      const cfg = ctx.providers.config(req.params.id as string);
      if (!cfg || cfg.user_id !== u.id) throw bad('Provider niet gevonden');
      if (cfg.kind !== 'ollama' && cfg.kind !== 'lmstudio') throw bad('Het contextvenster stel je alleen in voor Ollama en LM Studio; llama.cpp kiest het bij het starten van de server (-c).');
      const model = str(req.body?.model, 200).trim();
      if (!model) throw bad('Kies eerst een model');
      const n = req.body?.tokens === null || req.body?.tokens === '' ? null : Number(req.body?.tokens);
      if (n !== null && !(Number.isInteger(n) && n >= 1024 && n <= 4_194_304)) throw bad('Ongeldig contextvenster (1.024 tot 4.194.304 tokens)');
      const windows = { ...(cfg.config?.contextWindows || {}) };
      if (n === null) delete windows[model];
      else windows[model] = n;
      const p = ctx.providers.updateConfig(cfg.id, u.id, { config: { contextWindows: windows } });
      ctx.audit(u.id, 'provider.context_window', { provider: cfg.id, model, tokens: n });
      ctx.events.emit(u.id, 'provider.updated', ctx.providers.view(p, u.id));
      return { model, tokens: n };
    }),
  );

  /**
   * A local reserve for bots on a free engine with a daily limit (OpenCode): the welcome screen asks before it makes
   * the first bot on OpenCode. Connects a local engine that runs here (Ollama) when needed; see agent/alternatives.ts.
   */
  api.post(
    '/providers/free-reserve',
    ah(async (req) => {
      const u = user(req);
      if (isRestricted(ctx, u)) return { reserve: null };
      return { reserve: await rememberFreeReserve(ctx, u.id, { connect: true }) };
    }),
  );

  /** Find locally running/installed engines and add them in one click. */
  api.post(
    '/providers/autodetect',
    ah(async (req) => {
      const u = user(req);
      if (isRestricted(ctx, u)) return { added: [] };
      const existing = new Set(ctx.providers.list(u.id).filter((p) => p.user_id === u.id).map((p) => p.kind));
      const added: any[] = [];
      const takenBases = new Set(ctx.providers.list(u.id).filter((p) => p.user_id === u.id).map((p) => (p.base_url || ctx.providers.kind(p.kind)?.baseUrl || '').replace(/\/+$/, '')));
      for (const k of ctx.providers.kinds.values()) {
        if (!k.detect || existing.has(k.id)) continue;
        if (k.needsKey || k.retired) continue;
        const s = await detect(ctx, k);
        if (s?.installed && s.baseUrl && takenBases.has(s.baseUrl.replace(/\/+$/, ''))) continue; // same server, other name
        if (s?.installed && (k.type !== 'cli' || s.loggedIn !== false)) {
          if (s.baseUrl) takenBases.add(s.baseUrl.replace(/\/+$/, ''));
          // A local server found on an older default port (llama.cpp 8080, Lemonade 8000) keeps that address.
          const p = ctx.providers.create(u.id, { kind: k.id, base_url: s.baseUrl && s.baseUrl !== k.baseUrl ? s.baseUrl : undefined });
          added.push(ctx.providers.view(p, u.id));
        }
      }
      for (let i = 0; i < added.length; i++) {
        const cfg = ctx.providers.config(added[i].id);
        if (cfg?.kind === 'opencode') added[i] = ctx.providers.view(await ensureFreeDefaultModel(ctx, cfg, u.id), u.id);
        // A local engine (Ollama, LM Studio …) gets a chat model that is really there, so the first bot made on it
        // from the welcome screen answers (before: "Kies een model voor deze bot (Bot-instellingen › Model).").
        else if (cfg && ctx.providers.kind(cfg.kind)?.billing === 'local' && !cfg.config?.defaultModel) {
          const model = await localChatModel(ctx, cfg);
          if (model) added[i] = ctx.providers.view(ctx.providers.updateConfig(cfg.id, u.id, { config: { ...cfg.config, defaultModel: model } }), u.id);
        }
      }
      if (added.length) await autoDefaultProvider(ctx, u.id);
      for (const p of added) ctx.events.emit(u.id, 'provider.updated', p);
      return { added };
    }),
  );
}
