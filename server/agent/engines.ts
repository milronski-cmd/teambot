/**
 * The engines one run can use, in order: the bot's main engine, its own reserves, then the default chain
 * (modules/engine-chain). Which of them may take a piece of work (important, private, weekly reserve), and which are
 * at their usage limit right now. The rules themselves are pure functions in agent/fallback.ts; agent/runner.ts
 * decides when to switch.
 */
import { createHash } from 'node:crypto';
import type { Agent, Ctx, ProviderAdapter, ProviderConfig, ProviderKind, Run, Thread } from '../core/types.js';
import { applySharedModel, checkSharedSpend } from '../api/provider-policy.js';
import { prettyModel } from '../../shared/modelLabel.js';
import { enginePrivacy, engineTier, fallbackList, limitAccount, meetsLevel, privateSafe, TIER_RANK, weekUse, type ChainEntry, type EngineTier, type Privacy, type WorkFlags } from './fallback.js';
import { sharedRunOf } from './shared.js';

/**
 * An engine the run can use. `tier`/`privacy`: see agent/fallback.ts (default chain); `chain`: added by the default
 * chain (modules/engine-chain), `catalogue`: a source of the free-model catalogue, `wait`: the catalogue says it waits for
 * its limit until then (skipped until that moment, and a resume time for paused important work).
 */
export type Active = { cfg: ProviderConfig; adapter: ProviderAdapter; model: string; tier?: EngineTier; privacy?: Privacy; chain?: boolean; catalogue?: boolean; wait?: { until: number; known: boolean } };
/** The engines of one run, in order. `skipped`: said when no engine answered; `extended`: the default chain was added. */
export type Chain = Active[] & { skipped: string[]; privacy: string[]; extended?: boolean };
/** An engine failed (limit, logged out, outage, crash): the runner may switch to a reserve. */
export type EngineFailure = { error: any; messageId?: string };

/** "OpenCode (Big Pickle)", "Ollama (lokaal) · qwen3.6": the engine and its model in words, never "opencode/big-pickle". */
export const engineName = (a: Active) => {
  const m = a.model && a.model !== 'default' ? prettyModel(a.model) : '';
  return !m ? a.cfg.name : a.cfg.name.includes('(') ? `${a.cfg.name} · ${m}` : `${a.cfg.name} (${m})`;
};
/** "A", "A en B", "A, B en C" (names of engines, never translated). */
export const listNames = (names: string[]) => {
  const u = [...new Set(names)];
  return u.length <= 1 ? u[0] || '' : `${u.slice(0, -1).join(', ')} en ${u[u.length - 1]}`;
};

/** The model an engine runs: the one asked for, else the connection's own default, else the first of its kind. */
const modelFor = (cfg: ProviderConfig, kind: ProviderKind | undefined, wanted: string | undefined): string => wanted || cfg.config?.defaultModel || kind?.defaultModel || kind?.models?.[0] || '';

export class Engines {
  constructor(private getCtx: () => Ctx) {}

  /**
   * Engines that are at their usage limit, until their reset (in memory; a restart simply tries again). A limit counts
   * for the whole account (provider), so all models of OpenCode's free tier are skipped together. `known`: the engine
   * said when it resets (else `until` is TeamBot's own guess).
   */
  limited = new Map<string, { until: number; known?: boolean }>();

  resolveProvider(agent: Agent, userId: string): { cfg: ProviderConfig; adapter: ProviderAdapter; model: string } {
    const ctx = this.getCtx();
    let providerId = agent.provider_id;
    let model = agent.model;
    // A shared bot keeps the engine its owner chose for it (sharing the bot is consent to that); the member's own
    // budget applies (checkBudget) and a shared provider's per-person limits too (below).
    const engineOwner = sharedRunOf(agent)?.ownerId || userId;
    if (!providerId) {
      providerId = ctx.store.getSetting<string | null>(engineOwner, 'defaultProvider', null);
      model = model || ctx.store.getSetting<string>(engineOwner, 'defaultModel', '');
    }
    if (!providerId) throw new Error('Deze bot heeft nog geen AI. Koppel er een via Instellingen › AI-diensten en kies hem bij de bot.');
    const { cfg, adapter } = ctx.providers.adapter(providerId);
    if (!ctx.providers.canUse(userId, cfg) && !ctx.providers.canUse(engineOwner, cfg)) throw new Error('Je hebt geen toegang tot deze provider');
    const refused = ctx.providers.refuseFor(agent, cfg);
    if (refused) throw new Error(refused);
    const kind = ctx.providers.kind(cfg.kind);
    // Someone else's shared provider: the admin's model list and per-person daily cap apply (PRV-06).
    model = applySharedModel(cfg, userId, model);
    checkSharedSpend(ctx, cfg, userId);
    model = modelFor(cfg, kind, model);
    if (!model && kind?.type === 'api') throw new Error('Kies een model voor deze bot (Bot-instellingen › Model).');
    return { cfg, adapter, model };
  }

  /**
   * Main engine plus the bot's usable reserves, in order (the default chain is added later, when needed: extendChain).
   * `skipped`: reserves on someone else's shared provider that its policy refuses for this person right now (daily cap
   * reached, model no longer allowed); said in the chat when no engine answered, so a member knows why the reserve did
   * not take over (C-12). `privacy`: reserves private work may not use (named in one line when nothing answered).
   */
  engineChain(agent: Agent, userId: string, flags?: WorkFlags): Chain {
    const ctx = this.getCtx();
    const tag = (a: Active): Active => {
      const kind = ctx.providers.kind(a.cfg.kind);
      return { ...a, tier: engineTier(kind, a.model), privacy: enginePrivacy(kind, a.cfg.config) };
    };
    const list: Chain = Object.assign([tag(this.resolveProvider(agent, userId))] as Active[], { skipped: [] as string[], privacy: [] as string[] });
    for (const f of fallbackList(agent)) {
      try {
        const cfg = ctx.providers.config(f.provider_id);
        if (!cfg || !cfg.enabled || !(ctx.providers.canUse(userId, cfg) || ctx.providers.canUse(sharedRunOf(agent)?.ownerId || userId, cfg))) continue;
        const refused = ctx.providers.refuseFor(agent, cfg);
        if (refused) {
          list.skipped.push(`Reserve ${cfg.name} niet gebruikt: ${refused}`);
          continue;
        }
        const { adapter } = ctx.providers.adapter(f.provider_id);
        const kind = ctx.providers.kind(cfg.kind);
        let model: string;
        try {
          model = modelFor(cfg, kind, applySharedModel(cfg, userId, f.model));
        } catch {
          list.skipped.push(`Reserve ${cfg.name} niet gebruikt: dat model is daar niet (meer) toegestaan voor jou.`);
          continue;
        }
        if (!model && kind?.type === 'api') continue;
        try {
          checkSharedSpend(ctx, cfg, userId);
        } catch {
          list.skipped.push(`Reserve ${cfg.name} niet gebruikt: je daglimiet op die gedeelde provider is bereikt.`);
          continue;
        }
        if (list.some((x) => x.cfg.id === cfg.id && x.model === model)) continue;
        const r = tag({ cfg, adapter, model });
        if (flags?.private && !privateSafe(r.privacy!)) {
          list.privacy.push(cfg.name);
          continue;
        }
        list.push(r);
      } catch (e: any) {
        ctx.log.warn('[fallback] reserve skipped', f.provider_id, e?.message);
      }
    }
    return list;
  }

  /**
   * Add the default chain (other subscription, free sources, local model) after the bot's own reserves, once per run
   * and only when needed (most turns never leave the main engine). Sources private work may not use are left out and
   * named when nothing answers.
   */
  async extendChain(chain: Chain, agent: Agent, userId: string, flags: WorkFlags) {
    if (chain.extended) return;
    chain.extended = true;
    const ctx = this.getCtx();
    const svc = ctx.services.engineChain;
    if (!flags.chain || typeof svc?.extras !== 'function') return;
    let extra: ChainEntry[] = [];
    try {
      extra = (await svc.extras({ agent, userId, flags, main: { provider_id: chain[0].cfg.id, model: chain[0].model }, have: chain.map((x) => ({ provider_id: x.cfg.id, model: x.model })) })) || [];
    } catch (e: any) {
      ctx.log.warn('[chain] extras', e?.message);
    }
    for (const x of extra) {
      try {
        const { cfg, adapter } = ctx.providers.adapter(x.provider_id);
        if (!cfg.enabled || !ctx.providers.canUse(userId, cfg)) continue;
        const kind = ctx.providers.kind(cfg.kind);
        const model = modelFor(cfg, kind, x.model);
        if (!model && kind?.type === 'api') continue;
        if (chain.some((y) => y.cfg.id === cfg.id)) continue;
        const e: Active = { cfg, adapter, model, tier: engineTier(kind, model), privacy: x.privacy || enginePrivacy(kind, cfg.config), chain: true, catalogue: !!x.catalogue, ...(x.wait && x.wait.until > Date.now() ? { wait: { until: x.wait.until, known: !!x.wait.known } } : {}) };
        if (flags.private && !privateSafe(e.privacy!)) {
          chain.privacy.push(cfg.name);
          continue;
        }
        chain.push(e);
      } catch (err: any) {
        ctx.log.warn('[chain] engine skipped', x.provider_id, err?.message);
      }
    }
  }

  /**
   * A limit counts for the account, not for one connection: the user's other connections on the same account (a second
   * OpenCode connection on this computer, the same key twice) are at their limit too, so the chain skips them and goes
   * on to the next real option (0.4.3: it tried the second OpenCode connection first). See limitAccount.
   */
  markLimited(cfg: ProviderConfig, userId: string, l: { until: number; known: boolean }) {
    const ctx = this.getCtx();
    this.limited.set(cfg.id, l);
    try {
      const account = (c: ProviderConfig) => {
        const k = ctx.providers.kind(c.kind);
        // A key only as a short fingerprint, in memory, to compare two connections (never stored or logged).
        const key = k?.type === 'api' && c.secret_id ? createHash('sha256').update(ctx.secrets.get(c.secret_id) || '').digest('hex').slice(0, 16) : null;
        return limitAccount(c, k, key);
      };
      const mine = account(cfg);
      if (!mine) return;
      for (const p of ctx.providers.list(userId)) if (p.id !== cfg.id && p.kind === cfg.kind && account(p) === mine) this.limited.set(p.id, l);
    } catch (e: any) {
      ctx.log.warn('[fallback] shared limit', e?.message);
    }
  }

  isLimited(a: Active) {
    if (a.wait && a.wait.until > Date.now()) return true;
    const l = this.limited.get(a.cfg.id);
    if (l && l.until <= Date.now()) this.limited.delete(a.cfg.id);
    return !!l && l.until > Date.now();
  }

  /** What kind of work this run is (modules/engine-chain); without that module only the run's and bot's own flags. */
  workFlags(run: Run, agent: Agent, thread: Thread): WorkFlags {
    const ctx = this.getCtx();
    const svc = ctx.services.engineChain;
    if (typeof svc?.flags === 'function') {
      try {
        return svc.flags(run, agent, thread);
      } catch (e: any) {
        ctx.log.warn('[chain] flags', e?.message);
      }
    }
    const imp = run.meta?.important;
    return { chain: false, important: imp && typeof imp === 'object' ? imp : imp === true ? { kind: 'run' } : null, minLevel: 'top', private: agent.settings?.private === true ? { mode: 'strict', why: `${agent.name} staat op privé` } : null, weeklyReserve: 0 };
  }

  /** May this engine take over this run (the main engine always may; see startEngine for private work on it)? */
  allowed(x: Active, flags: WorkFlags, main: Active): boolean {
    if (flags.important && x !== main && !meetsLevel(x.tier || 'paid', flags.minLevel)) return false;
    if (flags.private && x !== main && !privateSafe(x.privacy || 'stores')) return false;
    // Proactive work (modules/routines/duties): never moves on to a paid or subscription engine.
    if (flags.frugal && x !== main && TIER_RANK[x.tier || 'paid'] > TIER_RANK.free) return false;
    return true;
  }

  /** The week use of a Claude or Codex engine when it is above the weekly reserve (normal work leaves it), else null. */
  weekly(x: Active, flags: WorkFlags): { percent: number } | null {
    if (!flags.weeklyReserve || flags.important || x.tier !== 'top') return null;
    try {
      const w = weekUse(this.getCtx().services.usage?.state?.(x.cfg.id)?.windows);
      return w && w.percent >= flags.weeklyReserve ? { percent: Math.round(w.percent) } : null;
    } catch {
      return null;
    }
  }

  /** "Claude Code blijft over voor belangrijk werk (87% van de week gebruikt)." when a switch passed over it. */
  weeklySkipNote(chain: Active[], from: Active, to: Active, flags: WorkFlags): string {
    const passed = chain.slice(chain.indexOf(from) + 1, chain.indexOf(to)).filter((x) => !this.isLimited(x) && this.allowed(x, flags, chain[0]));
    const w = passed.map((x) => ({ x, w: this.weekly(x, flags) })).find((y) => y.w);
    return w ? ` ${engineName(w.x)} blijft over voor belangrijk werk (${w.w!.percent}% van de weeklimiet gebruikt).` : '';
  }

  /** An engine below the minimum level that normal work would have switched to. */
  belowLevel(chain: Active[], cur: Active, flags: WorkFlags): Active | null {
    return chain.slice(chain.indexOf(cur) + 1).find((x) => !this.isLimited(x) && !this.allowed(x, flags, chain[0]) && (!flags.private || privateSafe(x.privacy || 'stores'))) || null;
  }

  /**
   * The next engine after `cur` that is not at its limit and may take this work (important: within the minimum level;
   * private: only private-safe ones). Normal work passes over Claude/Codex above the weekly reserve while another
   * engine is there.
   */
  nextEngine(chain: Active[], cur: Active, flags?: WorkFlags): Active | null {
    const i = chain.indexOf(cur);
    const rest = chain.slice(i + 1).filter((x) => !this.isLimited(x) && (!flags || this.allowed(x, flags, chain[0])));
    return (flags && rest.find((x) => !this.weekly(x, flags))) || rest[0] || null;
  }

  /**
   * The engine this run uses right now, on the run (meta.engine) while it is a reserve: the chat header shows the
   * reserve instead of the bot's main engine while it answers. Cleared again when the main engine runs.
   */
  markEngine(run: Run, thread: Thread, active: Active, main: Active) {
    const ctx = this.getCtx();
    const cur = ctx.store.run(run.id);
    if (!cur) return;
    const reserve = active !== main;
    if (!reserve && !cur.meta?.engine) return;
    const meta = { ...(cur.meta || {}) };
    if (reserve) meta.engine = { provider_id: active.cfg.id, kind: active.cfg.kind, name: active.cfg.name, model: active.model || '' };
    else delete meta.engine;
    const upd = ctx.store.updateRun(run.id, { meta });
    for (const uid of ctx.chat.audience(thread, run.user_id)) ctx.events.emit(uid, 'run.updated', upd);
  }

  /** Tell the free-model catalogue how a free source did (feature-detected; it keeps its own limits). */
  reportEngine(a: Active, outcome: { ok: boolean; kind?: string; resetAt?: number | null; error?: string; cause?: unknown }) {
    if (!a.catalogue && a.tier !== 'free') return;
    try {
      this.getCtx().services.engineChain?.report?.(a.cfg.id, { ...outcome, model: a.model });
    } catch {
      /* the catalogue's own problem */
    }
  }

}
