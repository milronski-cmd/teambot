import fs from 'node:fs';
import type { Agent, Ctx } from '../core/types.js';
import { ah, bad, forbidden, HttpError, own, str, user } from '../core/http.js';
import { recordAgentVersion } from './agent-versions.js';
import { sanitizeAgentForMember } from './member-policy.js';
import { applySharedModel } from './provider-policy.js';
import { classifyEngineError, MAX_FALLBACKS, plainError } from '../agent/fallback.js';
import { applyFreeReserve, localChatModel } from '../agent/alternatives.js';
import { isShared, sharingAvailable } from '../agent/shared.js';
import { ANSWER_STYLES } from '../agent/style.js';

/** A shared bot as other members see it: face, name and role, and whose it is. */
export function sharedView(ctx: Ctx, a: Agent) {
  const owner = ctx.store.user(a.user_id);
  return { id: a.id, name: a.name, avatar: a.avatar, color: a.color, role: a.role, description: a.description, access_mode: a.access_mode, shared: true, owner: { id: a.user_id, name: owner?.name || 'Onbekend' } };
}

const EDITABLE: (keyof Agent)[] = [
  'name', 'avatar', 'color', 'role', 'description', 'instructions', 'provider_id', 'model', 'reasoning', 'access_mode',
  'workspace', 'tool_groups', 'tool_policy', 'skills', 'fallback', 'busy_policy', 'settings', 'pinned', 'archived', 'sort',
];
const ACCESS = new Set(['chat', 'readonly', 'ask', 'auto', 'full']);

export function pickAgent(body: any): Partial<Agent> {
  const out: any = {};
  for (const k of EDITABLE) if (body?.[k] !== undefined) out[k] = body[k];
  if (out.name !== undefined) out.name = str(out.name, 80).trim();
  if (out.instructions !== undefined) out.instructions = str(out.instructions, 60_000);
  if (out.access_mode !== undefined && !ACCESS.has(out.access_mode)) throw bad('Ongeldige toegangsmodus');
  if (out.tool_groups !== undefined && !Array.isArray(out.tool_groups)) throw bad('tool_groups moet een lijst zijn');
  if (out.busy_policy !== undefined && !['queue', 'steer', 'interrupt'].includes(out.busy_policy)) throw bad('Ongeldig beleid');
  if (out.settings && typeof out.settings === 'object' && out.settings.answerStyle !== undefined && !ANSWER_STYLES.includes(out.settings.answerStyle)) throw bad('Ongeldige antwoordstijl');
  return out;
}

/** Portable agent template: setup only — never conversations, memory, files or secrets. */
export function agentTemplate(a: Agent) {
  return {
    format: 'teambot.agent/v1',
    name: a.name,
    avatar: a.avatar,
    color: a.color,
    role: a.role,
    description: a.description,
    instructions: a.instructions,
    model: a.model,
    reasoning: a.reasoning,
    access_mode: a.access_mode,
    tool_groups: a.tool_groups,
    skills: a.skills,
    busy_policy: a.busy_policy,
    // Local paths never travel in a template (extra folders, import origin).
    settings: { ...a.settings, extraRoots: undefined, folders: undefined, importedFrom: undefined },
  };
}

/**
 * "Volledige toegang" is an explicit opt-in of the installation owner (never a member, never via templates):
 * the bot then does its normal work without asking. Changing it is audited.
 */
function checkFullAccess(ctx: Ctx, u: { id: string; role: string }, next: Partial<Agent>, cur?: Agent) {
  const turnsOn = next.access_mode === 'full' && cur?.access_mode !== 'full';
  const external = next.settings?.fullAccessExternal === true && cur?.settings?.fullAccessExternal !== true;
  if ((turnsOn || external) && u.role !== 'owner') throw forbidden('Alleen de eigenaar van deze TeamBot-installatie kan een bot volledige toegang geven.');
  if (turnsOn) ctx.audit(u.id, 'agent.full_access', { on: true, external: next.settings?.fullAccessExternal === true }, cur?.id ?? null);
  if (cur?.access_mode === 'full' && next.access_mode !== undefined && next.access_mode !== 'full') ctx.audit(u.id, 'agent.full_access', { on: false }, cur.id);
  if (external && !turnsOn) ctx.audit(u.id, 'agent.full_access', { external: true }, cur?.id ?? null);
}

/**
 * "Gedeeld met het team" (settings.shared, A-61): only on a server, only by the bot's owner when he is the server's owner
 * or an admin. Switching it off always works. Both are logged.
 */
function checkSharing(ctx: Ctx, u: { id: string; role: string }, next: Partial<Agent>, cur?: Agent) {
  if (!next.settings) return;
  const was = cur?.settings?.shared === true;
  const will = next.settings.shared === true;
  if (will && !was) {
    if (!sharingAvailable(ctx)) throw bad('Een bot met het team delen kan alleen op een TeamBot-server.');
    if (u.role !== 'owner' && u.role !== 'admin') throw forbidden('Alleen de eigenaar of een beheerder van deze server kan een bot met het team delen.');
  }
  if (will !== was && cur) ctx.audit(u.id, will ? 'agent.shared' : 'agent.unshared', { name: cur.name }, cur.id);
  if (!will && next.settings.shared !== undefined) {
    const { shared: _s, ...rest } = next.settings;
    next.settings = rest;
  }
}

/** Ordered reserve engines (settings.fallbacks, max 5): only own/usable providers; `fallback` mirrors the first. */
function checkFallbacks(ctx: Ctx, u: { id: string }, next: Partial<Agent>) {
  const list = next.settings?.fallbacks;
  if (next.settings && next.settings.onLimit !== undefined && !['fallback', 'wait', 'stop'].includes(next.settings.onLimit)) throw bad('Ongeldige keuze bij een limiet');
  if (list === undefined) return;
  if (!Array.isArray(list)) throw bad('Reserves moeten een lijst zijn');
  const clean = list
    .filter((f: any) => f && typeof f.provider_id === 'string' && f.provider_id)
    .slice(0, MAX_FALLBACKS)
    .map((f: any) => ({ provider_id: str(f.provider_id, 60), model: str(f.model ?? '', 200) }));
  for (const f of clean) {
    const cfg = ctx.providers.config(f.provider_id);
    if (!ctx.providers.canUse(u.id, cfg)) throw bad('Onbekende reserve-provider');
    if (f.model) applySharedModel(cfg!, u.id, f.model);
  }
  next.settings = { ...next.settings, fallbacks: clean };
  next.fallback = clean[0] || null;
}

/** Per bot of this user: the model of its most recent answer in the last 30 days (from the usage log). */
export function lastModels(ctx: Ctx, userId: string): Record<string, string> {
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const out: Record<string, string> = {};
  // SQLite: a bare column next to MAX() comes from the row that has the maximum.
  for (const r of ctx.store.all<{ agent_id: string; model: string }>('SELECT agent_id, model, MAX(created_at) AS at FROM usage_log WHERE user_id = ? AND created_at >= ? AND agent_id IS NOT NULL GROUP BY agent_id', userId, since)) {
    if (r.agent_id && typeof r.model === 'string' && r.model && r.model !== 'default') out[r.agent_id] = r.model.slice(0, 120);
  }
  return out;
}

export function agentRoutes(ctx: Ctx) {
  const api = ctx.api;

  api.get('/agents', ah(async (req) => ctx.store.agents(user(req).id, { archived: req.query.archived === '1' })));

  /**
   * Bots that others share with the team (server mode): what a member needs to talk to them, with the owner's name.
   * Never the instructions, engine settings or anything else of the owner.
   */
  api.get(
    '/agents/shared',
    ah(async (req) => {
      const u = user(req);
      if (!sharingAvailable(ctx)) return [];
      return ctx.store
        .all<any>("SELECT * FROM agents WHERE user_id != ? AND archived = 0 AND json_extract(settings, '$.shared') = 1 ORDER BY name COLLATE NOCASE", u.id)
        .map((r) => ctx.store.decode<Agent>('agents', r))
        .filter((a) => isShared(ctx, a))
        .map((a) => sharedView(ctx, a));
    }),
  );

  // Bot cards: the model each bot really used last (a CLI on "default" reports its real model, e.g. claude-opus-5-5).
  api.get('/agents/last-models', ah(async (req) => lastModels(ctx, user(req).id)));

  api.post(
    '/agents',
    ah(async (req) => {
      const u = user(req);
      const data = sanitizeAgentForMember(ctx, u, pickAgent(req.body));
      checkFullAccess(ctx, u, data);
      checkSharing(ctx, u, data);
      checkFallbacks(ctx, u, data);
      if (data.provider_id && !ctx.providers.canUse(u.id, ctx.providers.config(data.provider_id))) throw bad('Onbekende provider');
      if (data.fallback?.provider_id && !ctx.providers.canUse(u.id, ctx.providers.config(data.fallback.provider_id))) throw bad('Onbekende reserve-provider');
      if (data.provider_id && data.model) applySharedModel(ctx.providers.config(data.provider_id)!, u.id, data.model);
      if (data.fallback?.provider_id && data.fallback.model) applySharedModel(ctx.providers.config(data.fallback.provider_id)!, u.id, data.fallback.model);
      if (!data.provider_id) {
        const def = ctx.store.getSetting<string | null>(u.id, 'defaultProvider', null);
        if (def) {
          data.provider_id = def;
          data.model = data.model || ctx.store.getSetting(u.id, 'defaultModel', '');
        }
      }
      // A new bot on a free engine with a daily limit (OpenCode) gets the local reserve "Gratis starten" set up.
      const reserve = applyFreeReserve(ctx, u.id, data.provider_id, data.settings?.fallbacks);
      if (reserve) {
        data.settings = { ...(data.settings || {}), fallbacks: reserve };
        data.fallback = reserve[0];
      }
      // "Eigen werkplek" (module folders): without a chosen folder, a new bot gets its own folder under the team folder.
      if (!data.workspace) data.workspace = ctx.services.folders?.werkplekFor?.(u.id, data) || undefined;
      const a = ctx.store.createAgent(u.id, data);
      ctx.audit(u.id, 'agent.created', { name: a.name }, a.id);
      ctx.events.emit(u.id, 'agent.updated', a);
      return a;
    }),
  );

  api.get('/agents/:id', ah(async (req) => own(req, ctx.store.agent(req.params.id as string), 'Bot niet gevonden')));

  api.patch(
    '/agents/:id',
    ah(async (req) => {
      const u = user(req);
      const a = own(req, ctx.store.agent(req.params.id as string), 'Bot niet gevonden');
      const patch = sanitizeAgentForMember(ctx, u, pickAgent(req.body), a);
      checkFullAccess(ctx, u, patch, a);
      checkSharing(ctx, u, patch, a);
      checkFallbacks(ctx, u, patch);
      if (patch.provider_id && !ctx.providers.canUse(u.id, ctx.providers.config(patch.provider_id))) throw bad('Onbekende provider');
      if (patch.fallback?.provider_id && !ctx.providers.canUse(u.id, ctx.providers.config(patch.fallback.provider_id))) throw bad('Onbekende reserve-provider');
      {
        const pid = patch.provider_id !== undefined ? patch.provider_id : a.provider_id;
        const model = patch.model !== undefined ? patch.model : a.model;
        if (pid && model && (patch.provider_id !== undefined || patch.model !== undefined)) applySharedModel(ctx.providers.config(pid)!, u.id, model);
        if (patch.fallback?.provider_id && patch.fallback.model) applySharedModel(ctx.providers.config(patch.fallback.provider_id)!, u.id, patch.fallback.model);
      }
      if (patch.provider_id !== undefined && patch.provider_id !== a.provider_id) {
        ctx.audit(u.id, 'agent.provider_changed', { from: a.provider_id, to: patch.provider_id, model: patch.model }, a.id);
      }
      recordAgentVersion(ctx, a, patch);
      const upd = ctx.store.updateAgent(a.id, patch);
      ctx.audit(u.id, 'agent.updated', { fields: Object.keys(patch) }, a.id);
      ctx.events.emit(u.id, 'agent.updated', upd);
      // Members keep their "Gedeeld" list current (name, face, shared or not).
      if (upd.settings?.shared === true || a.settings?.shared === true) ctx.events.emit('*', 'agents.shared', { id: a.id });
      return upd;
    }),
  );

  /**
   * Own order of the bots in the chat list (drag in the sidebar): `sort` = position, starting at 1. Bots that were
   * never placed keep sort 0 and appear after the placed ones (oldest first), so a new bot lands at the end.
   */
  api.post(
    '/agents/order',
    ah(async (req) => {
      const u = user(req);
      const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map((x: any) => String(x)).slice(0, 2000) : [];
      if (!ids.length) throw bad('Geef de nieuwe volgorde als lijst van bots');
      const mine = new Set(ctx.store.agents(u.id, { archived: true }).map((a) => a.id));
      const order = [...new Set(ids)].filter((id) => mine.has(id));
      // Plain update: reordering is not a profile change (no version, no "recent activity" bump).
      ctx.store.tx(() => order.forEach((id, i) => ctx.store.update('agents', id, { sort: i + 1 })));
      for (const id of order) ctx.events.emit(u.id, 'agent.updated', ctx.store.agent(id));
      ctx.audit(u.id, 'agent.reordered', { count: order.length });
      return { ok: true, order };
    }),
  );

  /** What deleting this bot removes and what stays, with counts (shown in the confirm dialog before anything happens). */
  api.get(
    '/agents/:id/delete-preview',
    ah(async (req) => {
      const a = own(req, ctx.store.agent(req.params.id as string), 'Bot niet gevonden');
      // Module tables may be absent (module disabled): count 0 then.
      const count = (sql: string, ...p: any[]) => {
        try {
          return Number(ctx.store.one<{ n: number }>(sql, ...p)?.n || 0);
        } catch {
          return 0;
        }
      };
      const own1 = "SELECT id FROM threads WHERE agent_id = ? AND room_id IS NULL";
      return {
        threads: count(`SELECT COUNT(*) n FROM (${own1})`, a.id),
        messages: count(`SELECT COUNT(*) n FROM messages WHERE thread_id IN (${own1}) AND deleted = 0 AND role IN ('user','assistant')`, a.id),
        memories: count("SELECT COUNT(*) n FROM memory_items WHERE user_id = ? AND scope = 'agent' AND agent_id = ? AND status IN ('active','proposed','archived')", a.user_id, a.id),
        routines: count('SELECT COUNT(*) n FROM routines WHERE user_id = ? AND agent_id = ?', a.user_id, a.id),
        channels: count('SELECT COUNT(*) n FROM channel_bindings WHERE user_id = ? AND agent_id = ?', a.user_id, a.id),
        groups: count("SELECT COUNT(DISTINCT room_id) n FROM room_members WHERE kind = 'agent' AND ref_id = ?", a.id),
        running: count("SELECT COUNT(*) n FROM runs WHERE agent_id = ? AND status IN ('queued','running','waiting')", a.id),
        workspace: a.workspace,
        workspaceInData: a.workspace.startsWith(ctx.config.dataDir),
      };
    }),
  );

  api.delete(
    '/agents/:id',
    ah(async (req) => {
      const u = user(req);
      const a = own(req, ctx.store.agent(req.params.id as string), 'Bot niet gevonden');
      for (const r of ctx.store.all<any>("SELECT id FROM runs WHERE agent_id = ? AND status IN ('queued','running','waiting')", a.id)) ctx.runs.cancel(r.id, 'Bot verwijderd');
      for (const h of ctx.hooks.agentDeleted) {
        try {
          h({ agentId: a.id, userId: u.id });
        } catch (e) {
          ctx.log.error(e);
        }
      }
      ctx.store.deleteAgent(a.id);
      if (a.settings?.shared === true) ctx.events.emit('*', 'agents.shared', { id: a.id });
      let filesDeleted = false;
      if (req.query.deleteFiles === '1' && a.workspace.startsWith(ctx.config.dataDir)) {
        fs.rmSync(a.workspace, { recursive: true, force: true });
        filesDeleted = true;
      }
      ctx.audit(u.id, 'agent.deleted', { name: a.name, filesDeleted }, a.id);
      ctx.events.emit(u.id, 'agent.deleted', { id: a.id });
      return { ok: true, filesDeleted, workspace: a.workspace };
    }),
  );

  api.post(
    '/agents/:id/duplicate',
    ah(async (req) => {
      const u = user(req);
      const a = own(req, ctx.store.agent(req.params.id as string), 'Bot niet gevonden');
      const data = sanitizeAgentForMember(ctx, u, { ...agentTemplate(a), provider_id: a.provider_id, fallback: a.fallback, tool_policy: a.tool_policy, name: a.name + ' (kopie)' } as any);
      if (!data.workspace) data.workspace = ctx.services.folders?.werkplekFor?.(u.id, data) || undefined;
      const copy = ctx.store.createAgent(u.id, data);
      ctx.events.emit(u.id, 'agent.updated', copy);
      return copy;
    }),
  );

  api.get(
    '/agents/:id/export',
    ah(async (req, res) => {
      const a = own(req, ctx.store.agent(req.params.id as string), 'Bot niet gevonden');
      res.setHeader('content-disposition', `attachment; filename="${a.name.replace(/[^\w-]+/g, '_')}.teambot-agent.json"`);
      res.json(agentTemplate(a));
    }),
  );

  api.post(
    '/agents/import',
    ah(async (req) => {
      const u = user(req);
      const t = req.body || {};
      if (t.format !== 'teambot.agent/v1') throw bad('Onbekend sjabloonformaat');
      const a = ctx.store.createAgent(u.id, { ...sanitizeAgentForMember(ctx, u, pickAgent(t)), provider_id: ctx.store.getSetting(u.id, 'defaultProvider', null) });
      ctx.audit(u.id, 'agent.imported', { name: a.name }, a.id);
      ctx.events.emit(u.id, 'agent.updated', a);
      return a;
    }),
  );

  /**
   * "Profiel maken mislukt: …" in words. At an engine's limit the code says so ("limit"), so the page can offer a
   * local model with one click, as the chat does (acceptance round 5).
   */
  const generateFailed = (e: any, engine: string) => new HttpError(400, `Profiel maken mislukt: ${plainError(e, { engine }).slice(0, 300)}`, classifyEngineError(e) === 'limit' ? 'limit' : undefined);

  /** Prompt-to-bot: draft a profile from a plain description. The user reviews before saving. */
  api.post(
    '/agents/generate',
    ah(async (req) => {
      const u = user(req);
      const description = str(req.body?.description, 4000);
      if (!description) throw bad('Beschrijf wat de bot moet doen');
      const providerId = req.body?.provider_id || ctx.store.getSetting<string | null>(u.id, 'defaultProvider', null);
      if (!providerId) throw bad('Koppel eerst een AI-provider');
      const { cfg, adapter } = ctx.providers.adapter(providerId);
      // API providers answer via chat; CLI engines (Claude Code, Codex, OpenCode) via a one-shot run without tools.
      if (!ctx.providers.canUse(u.id, cfg) || (!adapter.chat && !adapter.complete)) throw bad('Deze provider kan geen profiel maken; kies Claude Code, Codex, OpenCode of een API-provider');
      const kind = ctx.providers.kind(cfg.kind);
      const system =
        'Je ontwerpt AI-agentprofielen. Antwoord ALLEEN met één JSON-object, zonder uitleg of codeblok, met de velden: name (kort, max 3 woorden), role (functietitel), description (1 zin), instructions (concrete werkinstructies in markdown, 8-20 regels, in de taal van de gebruiker), avatar (één emoji), color (hex), tool_groups (subset van ["files","web","shell","memory","team","skills","browser","routines"]), access_mode ("ask" tenzij alleen-lezen past: "readonly").';
      let text: string;
      let model: string;
      if (adapter.chat) {
        // The default model belongs to the default provider: with another engine chosen here it is not that engine's
        // model (acceptance round 5: Ollama got "default" and answered "Model bestaat niet"). A local engine without a
        // model of its own uses one that is really there.
        const ownDefault = providerId === ctx.store.getSetting<string | null>(u.id, 'defaultProvider', null) ? ctx.store.getSetting<string>(u.id, 'defaultModel', '') : '';
        model = [req.body?.model, ownDefault, cfg.config?.defaultModel].find((m) => typeof m === 'string' && m && m !== 'default') || '';
        if (!model && kind?.billing === 'local') model = (await localChatModel(ctx, cfg)) || '';
        model = model || kind?.defaultModel || kind?.models?.[0] || '';
        if (!model) throw bad('Kies eerst een standaardmodel in Instellingen');
        text = (
          await adapter.chat({ model, system, messages: [{ role: 'user', content: description }], tools: [] }, AbortSignal.timeout(120_000), () => {}).catch((e: any) => {
            throw generateFailed(e, cfg.name);
          })
        ).text;
      } else {
        // The CLI's own default model unless one is asked for (its default is what the user picked in that CLI).
        model = typeof req.body?.model === 'string' ? req.body.model : '';
        const out = await adapter.complete!({ model, system, prompt: description }).catch((e: any) => {
          throw generateFailed(e, cfg.name);
        });
        if (out === null) throw bad('Deze CLI kan geen profiel maken; kies Claude Code, Codex, OpenCode of een API-provider');
        text = out;
      }
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) throw bad('Het model gaf geen geldig profiel terug; probeer het opnieuw');
      let draft: any;
      try {
        draft = JSON.parse(m[0]);
      } catch {
        throw bad('Het model gaf geen geldige JSON terug; probeer het opnieuw');
      }
      const picked = pickAgent(draft);
      // Like the starters and templates: every bot can remember and work with the team (ask, delegate), whatever the
      // model picked; the model often left 'team' out, so a generated lead could not delegate in a group.
      const groups = Array.isArray(picked.tool_groups) ? picked.tool_groups.filter((g: unknown) => typeof g === 'string') : ['files', 'web'];
      picked.tool_groups = [...new Set([...groups, 'memory', 'team'])];
      return { draft: picked, model, provider_id: providerId };
    }),
  );
}
