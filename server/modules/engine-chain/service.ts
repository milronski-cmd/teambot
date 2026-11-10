import type { Agent, Ctx, ProviderConfig, Run, Thread } from '../../core/types.js';
import { localChatModel } from '../../agent/alternatives.js';
import { sharedRunOf } from '../../agent/shared.js';
import {
  MIN_LEVELS,
  cleanChainSettings,
  engineTier,
  enginePrivacy,
  modelFamily,
  orderFree,
  resolveChainSettings,
  type ChainEntry,
  type ChainSettings,
  type ImportantRef,
  type Privacy,
  type WorkFlags,
} from '../../agent/fallback.js';

/**
 * The default chain (package D): which engines a bot may switch to when its own engine is at its limit, without the
 * owner filling in reserves per bot; which runs are important (they never run below a minimum level and pause
 * instead); which runs are private (only a model on this computer or a source that keeps nothing). The runner asks
 * this service (feature-detected as ctx.services.engineChain) and keeps the engine switching itself.
 *
 * The free-model catalogue of package D1 (ctx.services.freeModels: candidates() + report(), see
 * docs/modules/free-models.md) is used when it is there; without it the chain is built from what the owner connected: the other subscription CLI, free CLI engines
 * (OpenCode, Kilo) and a local model. Free API tiers (Groq, OpenRouter …) only come in through the catalogue, which
 * knows which of their models are really free; TeamBot never switches to something that could cost money.
 */

const SETTING = 'engineChain';
const SUB_FIRST = ['claude-code', 'codex-cli'];
const LOCAL_FIRST = ['ollama', 'lmstudio', 'llamacpp', 'jan', 'lemonade', 'localai', 'vllm', 'koboldcpp', 'textgen-webui', 'gpt4all'];
const rank = (order: string[], kind: string) => {
  const i = order.indexOf(kind);
  return i < 0 ? order.length : i;
};
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> => Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms).unref?.())]);
const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(',');
/** The privacy level of a free-model candidate (D1: `privacy.level`) as the chain's label; unknown = can train. */
const CATALOGUE_PRIVACY: Record<string, Privacy> = { local: 'local', 'no-store': 'none', 'may-train': 'train' };

export interface ChainView {
  provider_id: string;
  name: string;
  model: string;
  source: 'main' | 'subscription' | 'free' | 'local';
  tier: string;
  privacy: string;
}

export class EngineChainService {
  private localModels = new Map<string, { model: string | null; at: number }>();

  constructor(private ctx: Ctx) {}

  // ------------------------------------------------------------------ settings (per user; per team in wave 2)

  settings(scope: { userId: string; teamId?: string | null }): ChainSettings {
    return resolveChainSettings(this.ctx.store.getSetting<any>(scope.userId, SETTING, {}), scope.teamId);
  }

  /** Save the owner's choices; per-team overrides already stored (`teams`) stay as they are. */
  setSettings(userId: string, patch: any): ChainSettings {
    const raw = this.ctx.store.getSetting<any>(userId, SETTING, {}) || {};
    const cur = cleanChainSettings(raw);
    const next = cleanChainSettings({ ...cur, ...(patch && typeof patch === 'object' ? patch : {}) }, cur);
    this.ctx.store.setSetting(userId, SETTING, { ...raw, ...next });
    return next;
  }

  /**
   * The team whose chain settings apply: the team of the group the conversation is in (`rooms.workspace_id`), else
   * the bot's home team (package B4). `rooms.team_id` is a department of the org chart, not a team, so it is not used.
   */
  teamOf(thread: Thread | null | undefined, agent?: Pick<Agent, 'id'> | null): string | null {
    try {
      const room = thread ? this.ctx.services.rooms?.roomForThread?.(thread) : null;
      if (typeof room?.workspace_id === 'string' && room.workspace_id) return room.workspace_id;
    } catch {
      /* no rooms module */
    }
    try {
      const home = agent?.id ? this.ctx.services.teams?.teamOf?.(agent.id) : null;
      return typeof home === 'string' && home ? home : null;
    } catch {
      return null;
    }
  }

  /** The per-team overrides the owner set (team id → settings as stored, partial). */
  teamOverrides(userId: string): Record<string, Partial<ChainSettings>> {
    const raw = this.ctx.store.getSetting<any>(userId, SETTING, {}) || {};
    return raw.teams && typeof raw.teams === 'object' ? raw.teams : {};
  }

  /**
   * Set (or with `null` drop) one team's own chain settings: a team whose bots should stop at the free models, or keep
   * important work on Claude while the rest switches. Unset fields follow the owner's general settings.
   */
  setTeamSettings(userId: string, teamId: string, patch: any | null): ChainSettings {
    const raw = this.ctx.store.getSetting<any>(userId, SETTING, {}) || {};
    const teams = { ...(raw.teams && typeof raw.teams === 'object' ? raw.teams : {}) };
    if (patch === null) delete teams[teamId];
    else {
      // Only what the owner set for this team is stored; a field set to null follows the general settings again.
      const p = patch && typeof patch === 'object' ? patch : {};
      const next: Record<string, any> = { ...(teams[teamId] && typeof teams[teamId] === 'object' ? teams[teamId] : {}) };
      if (typeof p.enabled === 'boolean') next.enabled = p.enabled;
      if (MIN_LEVELS.includes(p.minLevel)) next.minLevel = p.minLevel;
      if (p.weeklyReserve !== undefined && p.weeklyReserve !== null) next.weeklyReserve = cleanChainSettings({ weeklyReserve: p.weeklyReserve }).weeklyReserve;
      for (const k of ['enabled', 'minLevel', 'weeklyReserve']) if (p[k] === null) delete next[k];
      if (Object.keys(next).length) teams[teamId] = next;
      else delete teams[teamId];
    }
    this.ctx.store.setSetting(userId, SETTING, { ...raw, teams });
    return this.settings({ userId, teamId });
  }

  /** May the default chain add engines for this bot (owner's setting, the bot's own choice, not a member's shared run)? */
  chainOn(agent: Agent, thread?: Thread | null): boolean {
    return this.settings({ userId: agent.user_id, teamId: this.teamOf(thread, agent) }).enabled && agent.settings?.freeChain !== false && !sharedRunOf(agent);
  }

  /**
   * Is there anything the default chain could switch to for this bot (a quick check without asking the CLIs)? Used by
   * routines: with a chain they let the runner try instead of waiting for a limit another routine ran into.
   */
  hasChain(agent: Agent): boolean {
    if (!this.chainOn(agent)) return false;
    const main = agent.provider_id || this.ctx.store.getSetting<string | null>(agent.user_id, 'defaultProvider', null);
    return this.ctx.providers.list(agent.user_id).some((p) => {
      if (p.id === main || p.user_id !== agent.user_id || !p.enabled) return false;
      const b = this.ctx.providers.kind(p.kind)?.billing;
      return b === 'local' || b === 'subscription' || b === 'free';
    });
  }

  // ------------------------------------------------------------------ what kind of work a run is

  flags(run: Run, agent: Agent, thread: Thread): WorkFlags {
    const s = this.settings({ userId: agent.user_id, teamId: this.teamOf(thread, agent) });
    return {
      chain: s.enabled && agent.settings?.freeChain !== false && !sharedRunOf(agent),
      important: this.importantOf(run, agent, thread),
      minLevel: s.minLevel,
      private: this.privateOf(run, agent, thread),
      weeklyReserve: s.weeklyReserve,
    };
  }

  /**
   * Why this run is important, or null: set on the run (a resumed pause, or "doorgaan als gewoon werk" = false), a
   * routine marked important, a subtask of an important run, or an important task on the board that this bot is
   * doing (status "Bezig") in this group or in the conversation where the task was made. A task on the owner's own
   * board (not of a group) also counts in the owner's own chats with that bot: a task made on the board has no
   * conversation, and the owner asks the bot to do it in its chat (practice test 0.4.4: the work went to a free model).
   */
  importantOf(run: Run, agent: Agent, thread: Thread): ImportantRef | null {
    const m = run.meta || {};
    if (m.important === false) return null;
    if (m.important && typeof m.important === 'object') return m.important as ImportantRef;
    if (m.important === true) return { kind: 'run' };
    const store = this.ctx.store;
    try {
      const rid = m.routine?.id;
      if (typeof rid === 'string') {
        const r = store.one<{ name: string; options: string }>('SELECT name, options FROM routines WHERE id = ? AND user_id = ?', rid, agent.user_id);
        if (r && JSON.parse(r.options || '{}').important === true) return { kind: 'routine', id: rid, title: r.name };
      }
    } catch {
      /* routines module absent */
    }
    try {
      const did = m.team?.delegationId;
      if (typeof did === 'string') {
        const d = store.one<{ parent_run_id: string | null }>('SELECT parent_run_id FROM room_delegations WHERE id = ?', did);
        const parent = d?.parent_run_id ? store.run(d.parent_run_id) : null;
        const imp = parent?.meta?.important;
        if (imp && typeof imp === 'object') return { kind: 'delegation', id: did, title: imp.title };
      }
      const roomId = this.roomIdOf(thread);
      const ownChat = thread.kind === 'chat' && !roomId && thread.agent_id === agent.id && thread.user_id === agent.user_id ? 1 : 0;
      const t = store.one<{ id: string; title: string }>(
        "SELECT id, title FROM room_tasks WHERE important = 1 AND status = 'doing' AND owner_type = 'agent' AND owner_id = ? AND ((room_id IS NOT NULL AND room_id = ?) OR source_thread_id = ? OR (room_id IS NULL AND user_id = ? AND ? = 1)) ORDER BY updated_at DESC LIMIT 1",
        agent.id,
        roomId,
        thread.id,
        agent.user_id,
        ownChat,
      );
      if (t) return { kind: 'task', id: t.id, title: t.title };
    } catch {
      /* rooms module absent */
    }
    return null;
  }

  private roomIdOf(thread: Thread): string | null {
    try {
      return this.ctx.services.rooms?.roomForThread?.(thread)?.id || thread.room_id || null;
    } catch {
      return thread.room_id || null;
    }
  }

  /**
   * Private work: the bot is set to private (strict: every engine, the main one too), or this turn uses a memory item
   * marked sensitive or a dossier that holds one (sensitive: no switch to a source that keeps or trains on it, and
   * never a main engine that can train).
   */
  privateOf(run: Run, agent: Agent, thread: Thread): WorkFlags['private'] {
    if (agent.settings?.private === true) return { mode: 'strict', why: `${agent.name} staat op privé` };
    if (!run.input_message_id) return null;
    try {
      const refs: any[] = this.ctx.store
        .all<{ refs: string }>('SELECT refs FROM memory_usage WHERE thread_id = ? AND message_id = ? AND agent_id = ?', thread.id, run.input_message_id, agent.id)
        .flatMap((r) => {
          try {
            const v = JSON.parse(r.refs || '[]');
            return Array.isArray(v) ? v : [];
          } catch {
            return [];
          }
        });
      const items = [...new Set(refs.filter((r) => r?.p === 'm' && typeof r.id === 'string').map((r) => r.id as string))].slice(0, 200);
      if (items.length && this.ctx.store.one(`SELECT 1 FROM memory_items WHERE id IN (${placeholders(items.length)}) AND sensitivity = 'sensitive' LIMIT 1`, ...items))
        return { mode: 'sensitive', why: 'dit gesprek gebruikt een gevoelige herinnering' };
      const dossiers = [...new Set(refs.filter((r) => r?.p === 'd' && typeof r.id === 'string').map((r) => r.id as string))].slice(0, 50);
      if (dossiers.length) {
        const q = placeholders(dossiers.length);
        const sensitive =
          this.ctx.store.one(`SELECT 1 FROM memory_items WHERE dossier_id IN (${q}) AND sensitivity = 'sensitive' AND status = 'active' LIMIT 1`, ...dossiers) ||
          this.ctx.store.all<{ tags: string }>(`SELECT tags FROM memory_dossiers WHERE id IN (${q})`, ...dossiers).some((d) => /"(gevoelig|privé|prive|sensitive|private)"/i.test(d.tags || ''));
        if (sensitive) return { mode: 'sensitive', why: 'dit gesprek gebruikt een gevoelig dossier' };
      }
    } catch {
      /* memory module absent */
    }
    return null;
  }

  // ------------------------------------------------------------------ the default chain

  /**
   * Engines after the main engine and the bot's own reserves, in order: the other subscription (only when the main
   * engine is a subscription or paid engine), free sources (another provider first, the same model family first), a
   * local model. A bot on a free engine stays free (no subscription in its chain); a bot on a local model stays on
   * this computer (only other local engines). Privacy and the minimum level are applied by the runner.
   */
  async extras(o: { agent: Agent; userId: string; flags: WorkFlags; main: { provider_id: string; model: string }; have: { provider_id: string; model: string }[] }): Promise<ChainEntry[]> {
    const ctx = this.ctx;
    const mainCfg = ctx.providers.config(o.main.provider_id);
    const mainKind = mainCfg ? ctx.providers.kind(mainCfg.kind) : undefined;
    const mainTier = engineTier(mainKind, o.main.model);
    const mainFamily = modelFamily(mainCfg?.kind || '', o.main.model);
    const mine = ctx.providers.list(o.userId).filter((p) => p.user_id === o.userId && p.enabled && p.id !== mainCfg?.id && ctx.providers.canUse(o.userId, p));
    const have = new Set(o.have.map((h) => h.provider_id));
    const out: ChainEntry[] = [];

    // 1. The other subscription (Claude Code ↔ Codex, then other subscription CLIs), when logged in on a subscription.
    if (mainTier === 'top' || mainTier === 'paid') {
      const subs = mine.filter((p) => p.kind !== mainCfg?.kind && ctx.providers.kind(p.kind)?.billing === 'subscription').sort((a, b) => rank(SUB_FIRST, a.kind) - rank(SUB_FIRST, b.kind));
      for (const p of subs) {
        if (have.has(p.id)) continue;
        const k = ctx.providers.kind(p.kind)!;
        if (k.type === 'cli') {
          const cli = ctx.services['cli-agents'];
          const st: any = typeof cli?.status === 'function' ? await withTimeout(Promise.resolve().then(() => cli.status(p.kind)), 8000) : null;
          // Only a CLI that is installed, logged in and on the owner's own subscription (never a pay-per-use key).
          if (!st?.installed || st.loggedIn === false || st.billing !== 'subscription') continue;
        }
        const model = p.config?.defaultModel || '';
        out.push({ provider_id: p.id, model, source: 'subscription', privacy: enginePrivacy(k, p.config), family: modelFamily(p.kind, model) });
      }
    }

    // 2. Free sources (not for a bot on a local model: that one stays on this computer). The catalogue's candidates
    // come first, in the catalogue's own order; then free CLI engines it does not list, another provider and the same
    // family first. A free limit counts per account, not per model: one entry per provider.
    if (mainTier !== 'local') {
      const listed = this.catalogue(o, mine).filter((c) => !have.has(c.provider_id));
      const seen = new Set<string>(listed.map((c) => c.provider_id));
      const cli: ChainEntry[] = [];
      for (const p of mine) {
        const k = ctx.providers.kind(p.kind);
        if (k?.billing !== 'free' || k.type !== 'cli' || have.has(p.id) || seen.has(p.id)) continue;
        seen.add(p.id);
        const model = p.config?.defaultModel || k.defaultModel || '';
        cli.push({ provider_id: p.id, model, source: 'free', privacy: enginePrivacy(k, p.config), family: modelFamily(p.kind, model) });
      }
      out.push(...listed, ...orderFree(cli, { provider_id: mainCfg?.id || '', family: mainFamily }));
    }

    // 3. A model on this computer (Ollama first). Two connections to the same local server are one engine.
    const server = (p: ProviderConfig) => `${p.kind}|${(p.base_url || ctx.providers.kind(p.kind)?.baseUrl || '').replace(/\/+$/, '').replace('localhost', '127.0.0.1')}`;
    const servers = new Set<string>(mainCfg && mainKind?.billing === 'local' ? [server(mainCfg)] : []);
    const locals = mine
      .filter((p) => ctx.providers.kind(p.kind)?.billing === 'local' && !have.has(p.id))
      .sort((a, b) => rank(LOCAL_FIRST, a.kind) - rank(LOCAL_FIRST, b.kind))
      .filter((p) => !servers.has(server(p)) && servers.add(server(p)));
    for (const p of locals.slice(0, 2)) {
      const model = p.config?.defaultModel || (await this.localModel(p));
      if (!model) continue;
      out.push({ provider_id: p.id, model, source: 'local', privacy: 'local', family: modelFamily(p.kind, model) });
    }
    return out;
  }

  /**
   * Candidates from the free-model catalogue of package D1 (`ctx.services.freeModels.candidates()`, synchronous; see
   * docs/modules/free-models.md), in the catalogue's order: available before waiting (on `availableAt`), the same
   * family as the main model first, "tools werken" first when the bot uses tools, then the source's preference. Local
   * models stay out (step 3 adds those). One entry per provider: its first candidate is its best model right now. A
   * provider whose models all wait comes in with `wait` (skipped until then; a resume time for paused important work);
   * one that waits without a known end (a broken key) stays out.
   */
  private catalogue(o: { agent: Agent; userId: string; flags: WorkFlags; main: { provider_id: string; model: string }; have: { provider_id: string }[] }, mine: ProviderConfig[]): ChainEntry[] {
    const fm = this.ctx.services.freeModels;
    if (typeof fm?.candidates !== 'function') return [];
    let list: unknown;
    try {
      list = fm.candidates({
        userId: o.userId,
        needTools: o.agent.access_mode !== 'chat' && (o.agent.tool_groups?.length || 0) > 0,
        // Private work: only a source that keeps nothing (a model on this computer comes in step 3).
        privacy: o.flags.private ? 'no-store' : 'any',
        family: o.main.model || undefined,
        // Already in the chain: the main engine and the bot's own reserves (a provider id leaves the whole provider out).
        exclude: [...new Set([o.main.provider_id, ...o.have.map((h) => h.provider_id)])],
        includeLocal: false,
        limit: 50,
      });
    } catch (e: any) {
      this.ctx.log.warn('[chain] free-model candidates', e?.message || e);
      return [];
    }
    if (!Array.isArray(list)) return [];
    const now = Date.now();
    const seen = new Set<string>();
    const out: ChainEntry[] = [];
    for (const c of list as any[]) {
      const id = c?.providerId;
      if (typeof id !== 'string' || seen.has(id)) continue;
      seen.add(id);
      const cfg = mine.find((p) => p.id === id);
      if (!cfg || cfg.id === o.main.provider_id) continue;
      let wait: ChainEntry['wait'] = null;
      if (c.available === false) {
        if (typeof c.availableAt !== 'number') continue;
        if (c.availableAt > now) wait = { until: c.availableAt, known: c.resetsAt === c.availableAt };
      }
      const model = String(c.model ?? '').slice(0, 200);
      out.push({ provider_id: cfg.id, model, source: 'free', privacy: CATALOGUE_PRIVACY[c.privacy?.level] || 'train', family: typeof c.family === 'string' && c.family ? c.family : modelFamily(cfg.kind, model), catalogue: true, wait });
    }
    return out;
  }

  /** A local provider's chat model (its own default, else one it has), remembered for a minute. */
  private async localModel(p: ProviderConfig): Promise<string | null> {
    const hit = this.localModels.get(p.id);
    if (hit && Date.now() - hit.at < 60_000) return hit.model;
    const model = await localChatModel(this.ctx, p).catch(() => null);
    this.localModels.set(p.id, { model, at: Date.now() });
    return model;
  }

  /**
   * Tell the free-model catalogue how a source did (it keeps per-account limits and drops models that are gone), in
   * its own words: 'ok'; { limit, resetAt, message } for a limit the runner saw (also a free CLI's own text); else the
   * error itself, which the catalogue sorts out (model gone, broken key, network …). The catalogue ignores a repeat of
   * what its own wrapper around the free API types just saw.
   */
  report(providerId: string, outcome: { ok: boolean; kind?: string; model?: string; resetAt?: number | null; error?: string; cause?: unknown }) {
    const fm = this.ctx.services.freeModels;
    if (typeof fm?.report !== 'function') return;
    const ref = outcome.model ? { providerId, model: outcome.model } : providerId;
    const said = outcome.ok ? 'ok' : outcome.kind === 'limit' ? { limit: true, resetAt: outcome.resetAt ?? null, message: outcome.error || '' } : { error: outcome.cause ?? new Error(outcome.error || 'Onbekende fout') };
    try {
      fm.report(ref, said);
    } catch {
      /* the catalogue's own problem */
    }
  }

  // ------------------------------------------------------------------ what the owner sees in Instellingen

  /** The chain as it is now for a bot (or for a new bot on the default engine): names, kind of source, privacy. */
  async preview(userId: string, agent?: Agent | null): Promise<{ main: ChainView | null; chain: ChainView[]; settings: ChainSettings }> {
    const ctx = this.ctx;
    // For a bot: the settings of its team (an override, else the owner's general settings).
    const settings = this.settings({ userId, teamId: agent ? this.teamOf(null, agent) : null });
    const mainId = agent?.provider_id || ctx.store.getSetting<string | null>(userId, 'defaultProvider', null);
    const mainCfg = mainId ? ctx.providers.config(mainId) : null;
    if (!mainCfg || !mainCfg.enabled) return { main: null, chain: [], settings };
    const kind = ctx.providers.kind(mainCfg.kind);
    const mainModel = (agent?.model || ctx.store.getSetting<string>(userId, 'defaultModel', '') || mainCfg.config?.defaultModel || kind?.defaultModel || '') as string;
    const view = (cfg: ProviderConfig, model: string, source: ChainView['source'], privacy?: string): ChainView => {
      const k = ctx.providers.kind(cfg.kind);
      return { provider_id: cfg.id, name: cfg.name, model, source, tier: engineTier(k, model), privacy: privacy || enginePrivacy(k, cfg.config) };
    };
    const fake = agent || ({ id: '', user_id: userId, name: '', settings: {}, access_mode: 'auto', tool_groups: ['files'], provider_id: mainCfg.id, model: mainModel } as unknown as Agent);
    const flags: WorkFlags = { chain: settings.enabled, important: null, minLevel: settings.minLevel, private: null, weeklyReserve: settings.weeklyReserve };
    const extra = settings.enabled ? await this.extras({ agent: fake, userId, flags, main: { provider_id: mainCfg.id, model: mainModel }, have: [{ provider_id: mainCfg.id, model: mainModel }] }) : [];
    const chain = extra.map((e) => {
      const cfg = ctx.providers.config(e.provider_id)!;
      return view(cfg, e.model, e.source, e.privacy);
    });
    return { main: view(mainCfg, mainModel, 'main'), chain, settings };
  }
}
