import type { Module } from '../../core/types.js';
import { ah, bad, notFound, str, user } from '../../core/http.js';
import { DEFAULT_CHAIN_SETTINGS, LEVEL_TEXT, MIN_LEVELS, PRIVACY_LABEL } from '../../agent/fallback.js';
import { EngineChainService } from './service.js';

/**
 * "Gratis doorschakelen" (package D): the default chain every bot gets without setting up reserves (main → other
 * subscription → free sources → local), important work that pauses instead of running on a weaker model, the weekly
 * reserve for Claude and Codex, and private work that only goes to a local model or a source that keeps nothing.
 * The runner (agent/runner.ts) does the switching and pausing; this module knows the settings and the rules.
 */
const mod: Module = {
  id: 'engine-chain',
  label: 'Gratis doorschakelen',
  init(ctx) {
    const s = new EngineChainService(ctx);
    ctx.services.engineChain = s;

    ctx.api.get(
      '/engine-chain/settings',
      ah(async (req) => ({
        settings: s.settings({ userId: user(req).id }),
        defaults: DEFAULT_CHAIN_SETTINGS,
        levels: MIN_LEVELS.map((id) => ({ id, label: LEVEL_TEXT[id] })),
        privacy: PRIVACY_LABEL,
        /** Per team (package B4): what the owner set for a team (only those fields; the rest follows `settings`). */
        teams: s.teamOverrides(user(req).id),
      })),
    );

    /**
     * One team's own chain (package B4): `{ enabled?, minLevel?, weeklyReserve? }` (a field null = follow the general
     * settings again); DELETE drops the team's override. A group's team counts first, else the bot's home team.
     */
    const ownTeam = (userId: string, teamId: string) => {
      const t = ctx.services.teams;
      if (!t || t.team(teamId)?.user_id !== userId) throw notFound('Team niet gevonden');
      return t.team(teamId);
    };
    ctx.api.put(
      '/engine-chain/settings/teams/:teamId',
      ah(async (req) => {
        const u = user(req);
        const teamId = str(req.params.teamId, 60);
        ownTeam(u.id, teamId);
        const b = req.body || {};
        if (b.minLevel !== undefined && b.minLevel !== null && !MIN_LEVELS.includes(b.minLevel)) throw bad('Onbekend minimumniveau');
        const next = s.setTeamSettings(u.id, teamId, { enabled: b.enabled, minLevel: b.minLevel, weeklyReserve: b.weeklyReserve });
        ctx.audit(u.id, 'engine_chain.team_settings', { teamId, ...s.teamOverrides(u.id)[teamId] });
        ctx.events.emit(u.id, 'engine-chain.settings', { teamId, settings: next });
        return { teamId, settings: next, override: s.teamOverrides(u.id)[teamId] || null };
      }),
    );
    ctx.api.delete(
      '/engine-chain/settings/teams/:teamId',
      ah(async (req) => {
        const u = user(req);
        const teamId = str(req.params.teamId, 60);
        ownTeam(u.id, teamId);
        const next = s.setTeamSettings(u.id, teamId, null);
        ctx.audit(u.id, 'engine_chain.team_settings', { teamId, cleared: true });
        ctx.events.emit(u.id, 'engine-chain.settings', { teamId, settings: next });
        return { teamId, settings: next, override: null };
      }),
    );

    ctx.api.put(
      '/engine-chain/settings',
      ah(async (req) => {
        const u = user(req);
        const b = req.body || {};
        if (b.minLevel !== undefined && !MIN_LEVELS.includes(b.minLevel)) throw bad('Onbekend minimumniveau');
        const next = s.setSettings(u.id, { enabled: b.enabled, minLevel: b.minLevel, weeklyReserve: b.weeklyReserve });
        ctx.audit(u.id, 'engine_chain.settings', next);
        ctx.events.emit(u.id, 'engine-chain.settings', next);
        // The weekly reserve is a mark on the usage bar: let it redraw.
        ctx.events.emit(u.id, 'usage.updated', { reserve: true });
        return next;
      }),
    );

    /** The chain as it is now: for one bot (`?agentId=`), else for a new bot on the default engine. */
    ctx.api.get(
      '/engine-chain/preview',
      ah(async (req) => {
        const u = user(req);
        const id = str(req.query.agentId || '', 60);
        const agent = id ? ctx.store.agent(id) : null;
        if (id && (!agent || agent.user_id !== u.id)) throw notFound('Bot niet gevonden');
        return s.preview(u.id, agent);
      }),
    );

    /**
     * The pause card's buttons: "Nu doorgaan als gewoon werk" (now, on whatever the chain has, without the minimum
     * level) or "Niet hervatten" (the scheduled resume is dropped). A routine's pause is managed at the routine.
     */
    ctx.api.post(
      '/engine-chain/paused/:runId',
      ah(async (req) => {
        const u = user(req);
        const r = ctx.store.run(str(req.params.runId, 60));
        if (!r || r.user_id !== u.id || !r.meta?.paused) throw notFound('Gepauzeerd werk niet gevonden');
        const thread = ctx.store.thread(r.thread_id);
        if (!thread) throw notFound('Gesprek niet gevonden');
        if (r.meta.routine) throw bad('Dit is werk van een routine; beheer die run bij Routines.');
        if (r.meta.limitRetried) throw bad('Dit werk is al hervat of gestopt.');
        const action = req.body?.action;
        if (action !== 'continue' && action !== 'cancel') throw bad('Kies doorgaan of niet hervatten');
        ctx.services.runner?.cancelLimitRetry?.(r.id);
        const evId = r.meta.paused.eventId;
        const ev = typeof evId === 'string' ? ctx.store.message(evId) : null;
        if (ev?.parts?.pause) ctx.chat.emitMessage(thread, ctx.store.updateMessage(ev.id, { parts: { ...ev.parts, pause: { ...ev.parts.pause, state: action === 'continue' ? 'continued' : 'cancelled', doneAt: new Date().toISOString() } } }), 'message.updated');
        ctx.audit(u.id, action === 'continue' ? 'agent.pause_continue' : 'agent.pause_cancel', { runId: r.id }, r.agent_id);
        if (action === 'cancel') return { ok: true };
        const agent = ctx.store.agent(r.agent_id);
        if (!agent) throw notFound('Bot niet gevonden');
        // As normal work (important: false): the chain may now also use engines below the minimum level.
        const run = ctx.chat.startAgent(thread, agent.id, r.input_message_id, 'retry', { override: r.meta.override, important: false, resumeOf: r.id });
        return { ok: true, run };
      }),
    );
  },
};

export default mod;
