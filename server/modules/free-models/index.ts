import type { Module, ProviderConfig } from '../../core/types.js';
import { ah, bad, forbidden, notFound, str, user } from '../../core/http.js';
import { PROVIDERS } from '../../providers/catalog.js';
import { createFor } from '../../providers/kinds.js';
import { FreeModelsService, TOOLS_TEXT, type CandidateQuery, type Outcome } from './service.js';
import { FREE_SOURCES, sourceDef } from './sources.js';
import { familyOf } from './family.js';
import { PRIVACY_TEXT, type PrivacyLevel } from './privacy.js';

/**
 * Gratis modellen (package D1): the free sources (Groq, OpenRouter ":free", Cloudflare Workers AI, Z.ai GLM Flash,
 * Kilo Gateway, plus OpenCode's free models via the OpenCode CLI and local models), with quota per account, a daily
 * model list, a bounded tool probe per model, privacy labels, and `ctx.services.freeModels` for the free-model chain.
 * See docs/modules/free-models.md.
 */

const LEVELS = new Set<string>(['local', 'no-store', 'may-train', 'any']);

/** For a free engine that is not connected yet: is it on this computer, and can TeamBot install it in one click. */
export interface EngineSetup {
  /** null: not checked (another user than the owner). */
  installed: boolean | null;
  canInstall: boolean;
  /** CLI engines only for the owner of this installation. */
  ownerOnly?: boolean;
  /** Found only inside another app (OpenBot): TeamBot installs its own copy instead of borrowing that one. */
  otherApp?: string;
  /** What to do yourself when TeamBot cannot install it. */
  steps?: string[];
}

const OLLAMA_STEPS = ['Download Ollama van ollama.com en installeer het.', 'Haal een model op, bijvoorbeeld met: ollama pull qwen3:4b', 'Kom terug en klik op Aanzetten.'];

const mod: Module = {
  id: 'free-models',
  label: 'Gratis modellen',
  migrations: [
    {
      id: 'free-models-001',
      sql: `CREATE TABLE free_sources (provider_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL);
CREATE TABLE free_models (provider_id TEXT NOT NULL, model TEXT NOT NULL, user_id TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL, PRIMARY KEY (provider_id, model));`,
    },
  ],
  init(ctx) {
    const s = new FreeModelsService(ctx);
    s.load();

    // Every chat call through a free provider kind reports its outcome and rate-limit headers (no change in the runner).
    for (const def of FREE_SOURCES) {
      if (def.engine !== 'api') continue;
      const pd = PROVIDERS.find((p) => p.id === def.kind);
      const k = ctx.providers.kind(def.kind);
      if (!pd || !k) continue;
      ctx.providers.registerKind({ ...k, create: (cfg: ProviderConfig, key: string | null) => s.wrap(createFor(pd, { onResponse: (r) => s.observe(cfg, r) })(cfg, key), cfg) });
    }

    ctx.services.freeModels = {
      /** Free models to switch to, best first, with availability and reset times (see service.ts CandidateQuery). */
      candidates: (q?: CandidateQuery) => s.candidates(q),
      /** What happened with a call: 'ok', { error }, { limit, resetAt }, { gone }. */
      report: (provider: string | { providerId: string; model?: string }, outcome: Outcome) => s.report(provider, outcome),
      familyOf,
      privacyLabel: (kind: string, model?: string) => s.privacyOf(kind, model),
      /** The sources as the settings card shows them (no keys). */
      sources: (userId: string) => s.view(userId),
      /** Fetch due model lists (all with force) and send due probes. */
      refresh: (userId: string, o?: { force?: boolean; probe?: boolean }) => s.refreshUser(userId, o),
      service: s,
    };

    const canChange = (kind: string) => {
      const def = sourceDef(kind);
      if (!def || !ctx.providers.kind(def.kind) || (!def.card && def.engine === 'api')) throw notFound('Onbekende gratis bron');
      return def;
    };

    const within = <T>(p: Promise<T>, ms: number) => Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms).unref?.())]);
    /** Does a local engine answer on this computer, and where (its own detect: a version/model list, no prompt; at most 3 s). */
    const detectLocal = async (kind: string): Promise<{ installed: boolean; baseUrl?: string }> => {
      const k = ctx.providers.kind(kind);
      const r: any = k?.detect ? await within(Promise.resolve(k.detect(ctx)), 3000) : null;
      return { installed: !!r?.installed, baseUrl: typeof r?.baseUrl === 'string' ? r.baseUrl : undefined };
    };
    /** Is the engine of a free CLI or local source on this computer (no prompt, no cost). */
    const setupOf = async (u: { id: string; role: string }, kind: string): Promise<EngineSetup> => {
      const def = sourceDef(kind)!;
      if (def.engine === 'cli') {
        // CLI engines run on the owner's own login on this computer: never for another user (cli-agents guards).
        if (u.role !== 'owner') return { installed: null, canInstall: false, ownerOnly: true };
        const st: any = await within(Promise.resolve(ctx.services['cli-agents']?.status?.(kind)), 15_000);
        // Not found, or only inside another app (OpenBot): "Installeren" sets up TeamBot's own copy in one click.
        const installed = !!st?.installed && st.pathSource !== 'andere-app';
        return { installed, canInstall: !installed && typeof ctx.services['cli-agents']?.connect === 'function', otherApp: st?.installed && st.pathSource === 'andere-app' ? st.pathApp || 'een andere app' : undefined };
      }
      return { installed: (await detectLocal(kind)).installed, canInstall: false, steps: kind === 'ollama' ? OLLAMA_STEPS : undefined };
    };
    /** The card, plus for every free engine on this computer that is not connected yet: is it here, can TeamBot install it. */
    const viewFor = async (u: { id: string; role: string }) => {
      const v = s.view(u.id);
      const engines = await Promise.all(v.engines.map(async (e) => (e.configured ? { ...e, setup: null } : { ...e, setup: await setupOf(u, e.kind) })));
      return { ...v, engines };
    };

    ctx.api.get(
      '/free-models',
      ah(async (req) => viewFor(user(req))),
    );

    /** On/off, key and account of one free source. The key goes straight into the encrypted vault, never back out. */
    ctx.api.put(
      '/free-models/sources/:kind',
      ah(async (req) => {
        const u = user(req);
        const def = canChange(String(req.params.kind));
        const b = req.body || {};
        // A CLI or local engine has no key here (a CLI keeps its own login; cli-agents never stores one for it).
        const apiKey = def.engine === 'api' && typeof b.apiKey === 'string' ? str(b.apiKey, 20_000).trim() : '';
        const extra: Record<string, string> = {};
        for (const f of def.fields || []) {
          const v = typeof b[f.key] === 'string' ? str(b[f.key], 200).trim() : '';
          if (!v) continue;
          if (f.pattern && !f.pattern.test(v)) throw bad(f.invalid || `"${f.label}" klopt niet.`);
          extra[f.key] = v;
        }
        let own: ProviderConfig | undefined = ctx.providers
          .list(u.id)
          .filter((c) => c.kind === def.kind && c.user_id === u.id)
          .sort((a, c) => String(a.created_at).localeCompare(String(c.created_at)))[0];
        const wantOn = b.on === true;
        if (def.engine === 'cli' && u.role !== 'owner') throw forbidden(`${def.label} draait op de eigen login van de computer waarop TeamBot draait. Alleen de eigenaar kan het gebruiken.`);
        if (def.engine === 'cli' && wantOn && !own) {
          // Connect the CLI the way "Gratis starten" does (on a free model); not here yet → the card offers "Installeren".
          const connect = ctx.services['cli-agents']?.connect;
          if (typeof connect !== 'function') throw bad(`${def.label} kan hier niet worden gekoppeld.`);
          own = ctx.providers.config((await connect(u.id, def.kind)).provider.id) || undefined;
        } else if (def.engine === 'local' && wantOn && !own && !s.configFor(u.id, def.kind)) {
          const here = await detectLocal(def.kind);
          if (!here.installed) throw bad(`${ctx.providers.kind(def.kind)?.label || def.label} draait niet op deze computer. ${(def.kind === 'ollama' ? OLLAMA_STEPS : []).join(' ')}`.trim());
          own = ctx.providers.create(u.id, { kind: def.kind, base_url: here.baseUrl });
          ctx.events.emit(u.id, 'provider.updated', ctx.providers.view(own, u.id));
        } else if (apiKey || Object.keys(extra).length || (wantOn && !s.configFor(u.id, def.kind))) {
          if (own) {
            own = ctx.providers.updateConfig(own.id, u.id, { apiKey: apiKey || undefined, config: Object.keys(extra).length ? extra : undefined, enabled: true });
            if (apiKey) s.keyChanged(own.id);
          } else {
            if (def.needsKey && !apiKey) throw bad(`Vul eerst je sleutel van ${def.label} in.`);
            for (const f of def.fields || []) if (!extra[f.key]) throw bad(`Vul "${f.label}" in voor ${def.label}.`);
            own = ctx.providers.create(u.id, { kind: def.kind, apiKey: apiKey || undefined, config: extra });
          }
          ctx.events.emit(u.id, 'provider.updated', ctx.providers.view(own, u.id));
        }
        if (typeof b.on === 'boolean') {
          if (b.on && own && !own.enabled) {
            own = ctx.providers.updateConfig(own.id, u.id, { enabled: true });
            ctx.events.emit(u.id, 'provider.updated', ctx.providers.view(own, u.id));
          }
          s.setOn(u.id, def.kind, b.on);
        }
        ctx.audit(u.id, 'free_models.source', { kind: def.kind, on: typeof b.on === 'boolean' ? b.on : undefined, key: apiKey ? 'nieuw' : undefined });
        // Check right away (the model list is free), at most a few seconds; probes follow in the background.
        const cfg = s.configFor(u.id, def.kind);
        if (cfg && s.activeSources(u.id).some((x) => x.cfg.id === cfg.id)) {
          let wait: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([s.refreshSource(def, cfg, true).catch(() => {}), new Promise((r) => (wait = setTimeout(r, 12_000)))]);
          clearTimeout(wait);
          void s.refreshUser(u.id).catch(() => {});
        }
        return viewFor(u);
      }),
    );

    /** "Nu verversen": model lists now (free); due probes in the background, still at most one per model per day. */
    ctx.api.post(
      '/free-models/refresh',
      ah(async (req) => {
        const u = user(req);
        await s.refreshUser(u.id, { force: true, probe: false });
        void s.refreshUser(u.id).catch(() => {});
        return viewFor(u);
      }),
    );

    /** The order the free chain would try now (for the settings card and diagnostics). */
    ctx.api.get(
      '/free-models/candidates',
      ah(async (req) => {
        const u = user(req);
        const privacy = String(req.query.privacy || '');
        return s.candidates({ userId: u.id, needTools: req.query.needTools === '1', privacy: LEVELS.has(privacy) ? (privacy as PrivacyLevel | 'any') : undefined, family: req.query.family ? String(req.query.family).slice(0, 100) : undefined, limit: 50 }).map((c) => ({ ...c, toolsText: TOOLS_TEXT[c.tools], privacyText: PRIVACY_TEXT[c.privacy.level] }));
      }),
    );

    ctx.events.on('provider.deleted', (e: any) => {
      const id = e?.data?.id;
      if (id) s.forget(id);
    });
    ctx.events.on('provider.updated', (e: any) => {
      const id = e?.data?.id;
      if (id) s.touched(id);
    });
  },
  start(ctx) {
    const s: FreeModelsService | undefined = ctx.services.freeModels?.service;
    s?.registerPrivacy();
    s?.start();
  },
  stop(ctx) {
    ctx.services.freeModels?.service?.stop();
  },
};

export default mod;
