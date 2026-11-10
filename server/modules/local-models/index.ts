import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Ctx, ModelInfo, Module, ProviderConfig, User } from '../../core/types.js';
import { ah, bad, str, user } from '../../core/http.js';
import { now } from '../../core/db.js';
import { isRestricted } from '../../api/member-policy.js';
import { autoDefaultProvider } from '../../api/providers.js';
import { chosenContext, ollamaModels } from '../../providers/localmodels.js';
import { detectHardware, type Hardware } from './hardware.js';
import { GiB, PLAN_CONTEXT, budget, bestDownload, fitFor, fitLoaded, memoryNeed, recommend, type Candidate, type Fit, type FitWhy, type ToolsKnown } from './advice.js';
import { CATALOG_CHECKED, CATALOG_SOURCE, OLLAMA_CATALOG } from './catalog.js';
import { Pulls, cpuWarning, getJson, originOf, parsePs, placement, type CpuWarning, type Placement, type PsModel, type PullState } from './ollama.js';
import { probeAdapter, probeOllama, probePlan, probeThink, type ProbeOutcome, type ProbeWhere } from './probe.js';

/**
 * "Lokale modellen op deze pc" (TeamBot 0.4, package Q): what this pc has, which local models fit ("past goed",
 * "werkt traag", "te groot"), whether a model really calls tools (a cached local test), a warning when Ollama runs a
 * model on the processor although there is a video card, and one-click downloads from a short list (Ollama /api/pull,
 * only when the owner clicks). Routes under /api/local-models; the UI card is ui/src/modules/local-models.
 *
 * Only for the owner and admins: it is about the computer TeamBot runs on (members on a server get nothing).
 */

const ID = 'local-models';

export interface ProbeView extends ProbeOutcome {
  at: string;
  ms: number;
  where?: ProbeWhere;
}

export interface InstalledModel {
  id: string;
  size: number;
  params?: string;
  quant?: string;
  /** What Ollama says it can do (undefined = Ollama does not say). */
  tools?: boolean;
  vision?: boolean;
  thinking?: boolean;
  /** The window the advice is for: chosen, loaded now, or TeamBot's 16k. */
  context: number;
  need: number;
  fit: Fit;
  why: FitWhy;
  loaded?: { placement: Placement; context: number; size: number; sizeVram: number };
  probe: ProbeView | null;
  toolsKnown: ToolsKnown;
}

export interface CatalogView {
  id: string;
  params: string;
  size: number;
  moe?: boolean;
  vision?: boolean;
  thinking?: boolean;
  firstBot?: boolean;
  need: number;
  fit: Fit;
  why: FitWhy;
  installed: boolean;
  best?: boolean;
}

export interface OtherServer {
  providerId: string;
  name: string;
  kind: string;
  models: { id: string; probe: ProbeView | null; tools?: boolean }[];
  error?: string;
}

export interface LocalModelsView {
  allowed: boolean;
  hardware: Hardware | null;
  budget: { vram: number; ram: number; gpu: string | null } | null;
  ollama: { running: boolean; base: string; version?: string; providerId: string | null; local: boolean; defaultModel?: string };
  installed: InstalledModel[];
  catalog: CatalogView[];
  catalogChecked: string;
  catalogSource: string;
  recommended: { id: string; installed: boolean } | null;
  cpuWarning: CpuWarning | null;
  pulls: PullState[];
  others: OtherServer[];
  /** Free disk space where Ollama keeps its models (only when Ollama runs on this pc). */
  diskFree: number | null;
}

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._\-/:]{0,199}$/;
const isLocalHost = (base: string) => {
  try {
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(base).hostname);
  } catch {
    return false;
  }
};
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> => Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
const full = (m: string) => (m.includes(':') ? m : `${m}:latest`);

export interface LocalModelsOptions {
  /** Hardware source (tests give a fixture). */
  hardware?: () => Promise<Hardware>;
  /** How long a hardware check is reused (default 10 minutes). */
  hardwareTtlMs?: number;
  /** Where Ollama keeps its models, for the free disk space (default OLLAMA_MODELS or ~/.ollama/models). */
  modelsDir?: string;
}

export function createLocalModelsModule(opts: LocalModelsOptions = {}): Module {
  let hw: { at: number; p: Promise<Hardware> } | null = null;
  const hardware = (refresh = false): Promise<Hardware> => {
    const ttl = opts.hardwareTtlMs ?? 10 * 60_000;
    if (!hw || refresh || Date.now() - hw.at > ttl) {
      const p = (opts.hardware || detectHardware)();
      hw = { at: Date.now(), p };
      p.catch(() => (hw = null));
    }
    return hw.p;
  };
  const probing = new Map<string, Promise<ProbeView>>();
  /** Models the tool test put on the processor on purpose (until Ollama unloads them): not a sign of a slow pc. */
  const onCpuForTest = new Map<string, number>();
  const testedOnCpu = (id: string) => (onCpuForTest.get(id) || 0) > Date.now();
  let pulls: Pulls;

  const probeKey = (kind: string, base: string, model: string) => `${kind}|${originOf(base)}|${model}`;
  const cachedProbe = (ctx: Ctx, kind: string, base: string, model: string, digest = ''): ProbeView | null => {
    const row = ctx.store.get<any>('local_model_probes', probeKey(kind, base, model));
    if (!row || (digest && row.digest && row.digest !== digest)) return null;
    return { verdict: row.verdict, detail: row.detail, message: row.message || undefined, at: row.at, ms: row.ms, where: row.where_run || undefined };
  };
  const saveProbe = (ctx: Ctx, kind: string, base: string, model: string, digest: string, v: ProbeView) => {
    const id = probeKey(kind, base, model);
    const row = { id, kind, base: originOf(base), model, digest, verdict: v.verdict, detail: v.detail, message: v.message || null, where_run: v.where || null, ms: v.ms, at: v.at };
    if (ctx.store.get('local_model_probes', id)) ctx.store.update('local_model_probes', id, row);
    else ctx.store.insert('local_model_probes', row);
  };

  /** The user's own enabled Ollama provider, or the default address. */
  const ollamaOf = (ctx: Ctx, userId: string): { cfg: ProviderConfig | null; base: string } => {
    const cfg = ctx.providers.list(userId).find((p) => p.user_id === userId && p.kind === 'ollama' && p.enabled) || null;
    return { cfg, base: cfg?.base_url || ctx.providers.kind('ollama')?.baseUrl || 'http://127.0.0.1:11434/v1' };
  };

  const diskFree = (base: string): number | null => {
    if (!isLocalHost(base)) return null;
    const dir = opts.modelsDir || process.env.OLLAMA_MODELS || path.join(os.homedir(), '.ollama', 'models');
    for (const d of [dir, os.homedir()]) {
      try {
        const s = fs.statfsSync(d);
        return Number(s.bavail) * Number(s.bsize);
      } catch {
        /* next */
      }
    }
    return null;
  };

  /** Everything the card shows. */
  async function view(ctx: Ctx, u: User, refresh: boolean, o2: { others?: boolean } = {}): Promise<LocalModelsView> {
    const { cfg, base } = ollamaOf(ctx, u.id);
    const o = originOf(base);
    const [h, version] = await Promise.all([withTimeout(hardware(refresh), 20_000), withTimeout(getJson(`${o}/api/version`, 1500), 2000)]);
    const b = h ? budget(h) : null;
    const running = typeof version?.version === 'string';
    let installed: InstalledModel[] = [];
    let ps: PsModel[] = [];
    if (running) {
      const [tags, psj, infos] = await Promise.all([withTimeout(getJson(`${o}/api/tags`, 4000), 5000), withTimeout(getJson(`${o}/api/ps`, 2000), 2500), withTimeout(ollamaModels(base), 15_000)]);
      ps = parsePs(psj);
      const info = new Map<string, ModelInfo>((infos || []).map((m) => [m.id, m]));
      for (const t of tags?.models || []) {
        const id = String(t?.name || t?.model || '');
        const mi = info.get(id);
        if (!id || (infos && !mi)) continue; // embedding-only models are not for chat
        const size = Number(t.size) || 0;
        const live = ps.find((m) => m.name === id || m.name === full(id));
        const context = chosenContext(cfg?.config, id) ?? (live?.context || undefined) ?? Math.min(PLAN_CONTEXT, mi?.context || PLAN_CONTEXT);
        const need = memoryNeed({ weights: size, kvPerToken: mi?.memPerToken, context });
        const f = live && live.size > 0 && !testedOnCpu(live.name) ? fitLoaded(live.size, live.sizeVram) : b ? fitFor(b, need) : { fit: 'slow' as Fit, why: 'no_gpu' as FitWhy };
        const probe = cachedProbe(ctx, 'ollama', base, id, String(t.digest || ''));
        const toolsKnown: ToolsKnown = probe && probe.verdict !== 'error' ? (probe.verdict === 'tools' ? 'yes' : 'no') : mi?.tools === false ? 'no' : 'unknown';
        installed.push({
          id,
          size,
          params: t.details?.parameter_size || undefined,
          quant: t.details?.quantization_level || undefined,
          tools: mi?.tools,
          vision: mi?.vision,
          thinking: mi?.reasoning,
          context,
          need,
          ...f,
          loaded: live ? { placement: placement(live), context: live.context, size: live.size, sizeVram: live.sizeVram } : undefined,
          probe,
          toolsKnown,
        });
      }
      installed = installed.sort((a, c) => a.id.localeCompare(c.id));
    }
    const has = (id: string) => installed.some((m) => m.id === id || m.id === full(id));
    const catalog: CatalogView[] = OLLAMA_CATALOG.map((c) => {
      const need = memoryNeed({ weights: c.size, kvPerToken: c.kvPerToken, context: PLAN_CONTEXT });
      const f = b ? fitFor(b, need) : { fit: 'slow' as Fit, why: 'no_gpu' as FitWhy };
      return { id: c.id, params: c.params, size: c.size, moe: c.moe, vision: c.vision, thinking: c.thinking, firstBot: c.firstBot, need, ...f, installed: has(c.id) };
    });
    const cand = (x: { id: string; fit: Fit; size: number }, more: Partial<Candidate>): Candidate => ({ id: x.id, fit: x.fit, size: x.size, tools: 'unknown', ...more });
    const catCands = catalog.map((c) => cand(c, { firstBot: c.firstBot, tools: 'unknown' }));
    const best = bestDownload(catCands);
    if (best) catalog.find((c) => c.id === best.id)!.best = true;
    const recommended = running || !installed.length ? recommend(installed.map((m) => cand(m, { tools: m.toolsKnown, loaded: !!m.loaded })), catCands) : null;
    // Other local servers the user connected (LM Studio, llama.cpp, …): models and their tool test.
    const locals = o2.others === false ? [] : ctx.providers.list(u.id).filter((p) => p.user_id === u.id && p.enabled && p.kind !== 'ollama' && ctx.providers.kind(p.kind)?.billing === 'local');
    const others: OtherServer[] = await Promise.all(
      locals.map(async (p): Promise<OtherServer> => {
        const pbase = p.base_url || ctx.providers.kind(p.kind)?.baseUrl || '';
        try {
          const list = (await withTimeout(Promise.resolve().then(() => ctx.providers.adapterFor(p).listModels()), 4000)) as ModelInfo[] | null;
          if (!list) throw new Error('geen antwoord');
          return { providerId: p.id, name: p.name, kind: p.kind, models: list.filter((m) => m.id && m.id !== 'default').map((m) => ({ id: m.id, tools: m.tools, probe: cachedProbe(ctx, p.kind, pbase, m.id) })) };
        } catch (e: any) {
          return { providerId: p.id, name: p.name, kind: p.kind, models: [], error: String(e?.message || e).slice(0, 160) };
        }
      }),
    );
    return {
      allowed: true,
      hardware: h,
      budget: b ? { vram: b.vram, ram: b.ram, gpu: b.gpu?.name || null } : null,
      ollama: { running, base: o, version: version?.version, providerId: cfg?.id || null, local: isLocalHost(base), defaultModel: cfg?.config?.defaultModel || undefined },
      installed,
      catalog,
      catalogChecked: CATALOG_CHECKED,
      catalogSource: CATALOG_SOURCE,
      recommended,
      cpuWarning: running ? cpuWarning(ps.filter((m) => !testedOnCpu(m.name)), h) : null,
      pulls: pulls.list(u.id),
      others,
      diskFree: running ? diskFree(base) : null,
    };
  }

  /** Test one model; one test per model at a time, the result is kept until the model changes. */
  async function probe(ctx: Ctx, u: User, model: string, providerId?: string): Promise<ProbeView> {
    let kind = 'ollama';
    let base: string;
    let cfg: ProviderConfig | null;
    if (providerId) {
      cfg = ctx.providers.config(providerId);
      if (!cfg || cfg.user_id !== u.id || ctx.providers.kind(cfg.kind)?.billing !== 'local') throw bad('Provider niet gevonden');
      kind = cfg.kind;
      base = cfg.base_url || ctx.providers.kind(cfg.kind)?.baseUrl || '';
    } else ({ cfg, base } = ollamaOf(ctx, u.id));
    const key = probeKey(kind, base, model);
    const running = probing.get(key);
    if (running) return running;
    const job = (async (): Promise<ProbeView> => {
      const t0 = Date.now();
      let out: ProbeOutcome;
      let where: ProbeWhere | undefined;
      let digest = '';
      const signal = AbortSignal.timeout(180_000);
      if (kind === 'ollama') {
        const o = originOf(base);
        const [tags, psj, infos, h] = await Promise.all([withTimeout(getJson(`${o}/api/tags`, 4000), 5000), withTimeout(getJson(`${o}/api/ps`, 2000), 2500), withTimeout(ollamaModels(base), 15_000), withTimeout(hardware(), 20_000)]);
        const tag = (tags?.models || []).find((t: any) => t.name === model || t.name === full(model));
        if (!tag) throw bad(`${model} staat niet in Ollama op deze pc.`);
        digest = String(tag.digest || '');
        const mi = (infos || []).find((m) => m.id === tag.name);
        const b = h ? budget(h) : null;
        const need = memoryNeed({ weights: Number(tag.size) || 0, kvPerToken: mi?.memPerToken, context: 4096 });
        if (b && fitFor(b, need).fit === 'too_big') throw bad(`${model} is te groot voor deze pc; de test zou niet lukken.`);
        const plan = probePlan(tag.name, parsePs(psj), b ? b.vram : null, need);
        where = plan.where;
        if (plan.numGpu === 0) onCpuForTest.set(tag.name, Date.now() + 3 * 60_000);
        const caps = mi ? [...(mi.tools ? ['tools'] : []), ...(mi.reasoning ? ['thinking'] : [])] : undefined;
        if (mi?.tools === false) out = { verdict: 'text', detail: 'no_tools' };
        else out = await probeOllama({ base, label: cfg?.name || 'Ollama', model: tag.name, think: probeThink(caps, mi?.reasoningLevels), plan }, signal);
      } else {
        out = await probeAdapter(ctx.providers.adapterFor(cfg!), model, signal);
      }
      const v: ProbeView = { ...out, at: now(), ms: Date.now() - t0, where };
      // A failed test (server away, time-out) is not remembered: the next look tries again.
      if (v.verdict !== 'error') saveProbe(ctx, kind, base, model, digest, v);
      ctx.events.emit(u.id, 'localmodels.probe', { model, providerId: providerId || null, probe: v });
      return v;
    })();
    probing.set(key, job);
    try {
      return await job;
    } finally {
      probing.delete(key);
    }
  }

  return {
    id: ID,
    label: 'Lokale modellen',
    migrations: [
      {
        id: 'local-models-001',
        sql: `CREATE TABLE local_model_probes (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          base TEXT NOT NULL,
          model TEXT NOT NULL,
          digest TEXT NOT NULL DEFAULT '',
          verdict TEXT NOT NULL,
          detail TEXT NOT NULL,
          message TEXT,
          where_run TEXT,
          ms INTEGER NOT NULL DEFAULT 0,
          at TEXT NOT NULL
        )`,
      },
    ],
    init(ctx) {
      pulls = new Pulls(
        (userId, s) => ctx.events.emit(userId, 'localmodels.pull', s),
        (userId, s) => {
          if (s.ok) ctx.events.emit(userId, 'notification', { title: 'Model gedownload', body: `${s.model} staat nu in Ollama op deze pc.`, link: '#/settings/providers', kind: 'local-models' });
          // Right after a download the owner started: check that the model really calls tools.
          const u = ctx.store.user(userId);
          if (s.ok && u) void probe(ctx, u, s.model).catch(() => null);
        },
      );
      const allowed = (u: User) => !isRestricted(ctx, u);

      ctx.api.get(
        '/local-models',
        ah(async (req) => {
          const u = user(req);
          if (!allowed(u)) return { allowed: false };
          return view(ctx, u, req.query.refresh === '1');
        }),
      );

      ctx.api.post(
        '/local-models/pull',
        ah(async (req) => {
          const u = user(req);
          if (!allowed(u)) throw bad('Alleen de eigenaar kan modellen downloaden op deze computer.');
          const model = str(req.body?.model, 200).trim();
          const item = OLLAMA_CATALOG.find((c) => c.id === model);
          if (!item) throw bad('Kies een model uit de lijst.');
          const { base } = ollamaOf(ctx, u.id);
          const o = originOf(base);
          const version = await withTimeout(getJson(`${o}/api/version`, 1500), 2000);
          if (typeof version?.version !== 'string') throw bad('Ollama draait niet op deze pc. Start Ollama en probeer het opnieuw.');
          const h = await withTimeout(hardware(), 20_000);
          if (h && fitFor(budget(h), memoryNeed({ weights: item.size, kvPerToken: item.kvPerToken })).fit === 'too_big') throw bad(`${model} is te groot voor deze pc.`);
          const free = diskFree(base);
          if (free !== null && free < item.size + GiB) throw bad(`Niet genoeg vrije schijfruimte voor ${model}. Maak ruimte vrij op de schijf waar Ollama zijn modellen bewaart en probeer het opnieuw.`);
          ctx.audit(u.id, 'localmodels.pull', { model });
          void pulls.start(base, model, u.id);
          return { started: true, pulls: pulls.list(u.id) };
        }),
      );

      ctx.api.post(
        '/local-models/pull/cancel',
        ah(async (req) => {
          const u = user(req);
          if (!allowed(u)) throw bad('Niet toegestaan');
          return { cancelled: pulls.cancel(str(req.body?.model, 200).trim(), u.id) };
        }),
      );

      ctx.api.post(
        '/local-models/probe',
        ah(async (req) => {
          const u = user(req);
          if (!allowed(u)) throw bad('Alleen de eigenaar kan modellen testen op deze computer.');
          const model = str(req.body?.model, 200).trim();
          if (!MODEL_NAME.test(model)) throw bad('Ongeldige modelnaam');
          return probe(ctx, u, model, req.body?.providerId ? str(req.body.providerId, 80) : undefined);
        }),
      );

      /** "Gebruik voor nieuwe bots": the model becomes Ollama's default (connects Ollama when it is not yet). */
      ctx.api.post(
        '/local-models/use',
        ah(async (req) => {
          const u = user(req);
          if (!allowed(u)) throw bad('Niet toegestaan');
          const model = str(req.body?.model, 200).trim();
          if (!MODEL_NAME.test(model)) throw bad('Ongeldige modelnaam');
          let { cfg, base } = ollamaOf(ctx, u.id);
          const tags = await withTimeout(getJson(`${originOf(base)}/api/tags`, 4000), 5000);
          const tag = (tags?.models || []).find((t: any) => t.name === model || t.name === full(model));
          if (!tag) throw bad(tags ? `${model} staat niet in Ollama op deze pc.` : 'Ollama draait niet op deze pc. Start Ollama en probeer het opnieuw.');
          if (!cfg) cfg = ctx.providers.create(u.id, { kind: 'ollama' });
          const p = ctx.providers.updateConfig(cfg.id, u.id, { config: { defaultModel: tag.name } });
          const def = ctx.store.getSetting<string | null>(u.id, 'defaultProvider', null);
          if (!def) {
            ctx.store.setSetting(u.id, 'defaultProvider', p.id);
            ctx.store.setSetting(u.id, 'defaultProviderAuto', true);
          } else if (def !== p.id && ctx.store.getSetting<boolean>(u.id, 'defaultProviderAuto', false) === true) await autoDefaultProvider(ctx, u.id);
          if (ctx.store.getSetting<string | null>(u.id, 'defaultProvider', null) === p.id) ctx.store.setSetting(u.id, 'defaultModel', tag.name);
          ctx.audit(u.id, 'localmodels.use', { provider: p.id, model: tag.name });
          ctx.events.emit(u.id, 'provider.updated', ctx.providers.view(p, u.id));
          ctx.events.emit(u.id, 'settings.updated', ctx.store.settings(u.id));
          return { providerId: p.id, model: tag.name };
        }),
      );

      ctx.services.localModels = {
        hardware: (refresh?: boolean) => hardware(refresh),
        /** For a first bot on a local provider: the recommended installed model (null = no opinion). */
        async pickChatModel(cfg: ProviderConfig, models: ModelInfo[]): Promise<string | null> {
          if (cfg.kind !== 'ollama') return null;
          const owner = ctx.store.user(cfg.user_id);
          if (!owner || isRestricted(ctx, owner)) return null;
          const v = await view(ctx, owner, false, { others: false });
          // Only with real facts (the pc and every model's size); otherwise the caller's own rule decides.
          if (!v.hardware || !v.installed.length || v.installed.some((m) => !m.size)) return null;
          const rec = v.recommended;
          return rec?.installed && models.some((m) => m.id === rec.id) ? rec.id : null;
        },
        probe: (u: User, model: string, providerId?: string) => probe(ctx, u, model, providerId),
      };
    },
    stop() {
      // A download that still runs stops with the server; Ollama keeps what it has and continues on the next pull.
      pulls?.cancelAll();
    },
  };
}

export default createLocalModelsModule();
