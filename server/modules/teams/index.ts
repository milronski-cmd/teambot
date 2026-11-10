import type { Agent, Ctx, Module } from '../../core/types.js';
import { addPathGuard, addRootFilter } from '../../tools/builtin/files.js';
import { teamMigrations } from './schema.js';
import { type TeamCopier, TeamsService, sitesOfProfile } from './service.js';
import { teamRoutes } from './routes.js';
import { profileContext, teamsPrompt } from './prompt.js';
import { overview } from './overview.js';
import { teamBudgetCheck, teamSpentToday } from './budget.js';
import { StuckReporter } from './stuck.js';
import { Briefing } from './briefing.js';
import { ah, str, user } from '../../core/http.js';

const instances = new WeakMap<Ctx, { svc: TeamsService; dispose: (() => void)[] }>();
const stuckReporters = new WeakMap<Ctx, StuckReporter>();
const briefings = new WeakMap<Ctx, Briefing>();

/**
 * Teams as workspaces (0.4, package B): every bot has a home team; per bot the owner grants other teams meekijken
 * (read) or aansturen (direct); each team has a folder and a business profile; keys are for every team unless set to
 * "alleen dit team". Enforced in code: the folder root filter and path guard (files.ts), the provider bot guard
 * (runner), the delegation checks (rooms), and `keyAllowed` for apps (MCP) and logins (Kluis). Other modules call the
 * helpers on `ctx.services.teams` (see docs/modules/teams.md).
 *
 * The organisation (0.4, package C): the owner may make one main bot (hoofdbot; table team_main) that directs every
 * team by default and only takes work from the owner; any other bot that directs more than one team is a leader; a
 * team lead is optional. `delegateError` keeps work flowing down: no bot can get around a team wall through a bot that
 * reaches further than itself. GET /teams/overview is the "Alle teams" overview.
 */
const mod: Module = {
  id: 'teams',
  label: 'Teams',
  migrations: teamMigrations,
  init(ctx: Ctx) {
    const svc = new TeamsService(ctx);
    const dispose: (() => void)[] = [];
    instances.set(ctx, { svc, dispose });

    // An update from 0.3: everything that exists goes into one team, "Mijn team". A fresh install stays empty.
    try {
      svc.upgrade();
    } catch (e) {
      ctx.log.error('[teams] upgrade failed', e);
    }

    teamRoutes(ctx, svc);

    // 0.4.4 (P2): the main bot reports stuck work once in its own chat (stuck.ts); "Opnieuw proberen" is the owner's click.
    const stuck = new StuckReporter(ctx, svc);
    stuckReporters.set(ctx, stuck);
    // The main bot's daily or weekly overview and the weekly top 3 opportunities (briefing.ts): no model call.
    const briefing = new Briefing(ctx, svc);
    briefings.set(ctx, briefing);
    ctx.api.get('/proactive/briefing', ah(async (req) => briefing.last(user(req).id)));
    ctx.api.post('/proactive/briefing', ah(async (req) => (await briefing.send(user(req).id, { briefing: true, weekly: req.body?.weekly === true })) || { text: '', quiet: true }));
    ctx.api.post(
      '/teams/stuck/retry',
      ah(async (req) => stuck.retry(user(req).id, str(req.body?.messageId, 60), str(req.body?.ref, 80))),
    );

    dispose.push(ctx.providers.addBotGuard((agent, cfg) => svc.providerRefusal(agent, cfg)));
    dispose.push(addRootFilter((agent, roots) => svc.filterRoots(agent, roots)));
    dispose.push(addPathGuard((agent, real, o) => svc.pathRefusal(agent, real, !!o.write)));
    dispose.push(ctx.events.on('agent.updated', (e) => svc.onAgent(e.data as Agent)));

    // A team's own daily budget (optional), checked by the runner before every model call that can cost money.
    const budget = teamBudgetCheck(ctx, svc);
    (ctx.hooks.beforeModelCall ??= []).push(budget);
    dispose.push(() => {
      const list = ctx.hooks.beforeModelCall || [];
      const i = list.indexOf(budget);
      if (i >= 0) list.splice(i, 1);
    });

    ctx.hooks.systemPrompt.push(({ agent }) => teamsPrompt(svc, agent));
    ctx.hooks.turnContext.push(({ agent, thread, input }) => profileContext(svc, agent, thread, input));
    ctx.hooks.agentDeleted.push(({ agentId, userId }) => svc.agentDeleted(agentId, userId));

    /**
     * Helpers for every module (all synchronous). Wave 2 (memory, channels, skills, routines, budget) scopes its data
     * with these: store a team id per record (default: `teamOf(agentId)`), show it to bots that `canRead`, let only
     * `canWrite` bots change it, and check `keyAllowed` before using a key.
     */
    ctx.services.teams = {
      /** The owner's teams in order; the first is the default team. */
      list: (userId: string) => svc.list(userId),
      team: (teamId: string) => svc.team(teamId),
      defaultTeam: (userId: string) => svc.defaultTeam(userId),
      /** The default team, created ("Mijn team") when the owner has none yet. */
      ensureDefault: (userId: string) => svc.ensureDefault(userId),
      /** Two or more teams (only then show team choices). */
      multi: (userId: string) => svc.multi(userId),
      /** Home team id of a bot (null for an unknown bot). */
      teamOf: (agentId: string) => svc.teamOf(agentId),
      /** Bot ids whose home team this is. */
      botsOf: (teamId: string) => svc.botsOf(teamId),
      lead: (teamId: string) => svc.team(teamId)?.lead_agent_id ?? null,
      /** The team's websites: what the owner listed plus addresses written in the profile (watched by the vaste taken). */
      sitesOf: (teamId: string) => sitesOfProfile(svc.team(teamId)?.profile),
      /** 'home' | 'direct' | 'read' | 'none'. */
      access: (agentId: string, teamId: string) => svc.access(agentId, teamId),
      canRead: (agentId: string, teamId: string) => svc.canRead(agentId, teamId),
      canWrite: (agentId: string, teamId: string) => svc.canWrite(agentId, teamId),
      canDirect: (agentId: string, teamId: string) => svc.canDirect(agentId, teamId),
      /** Team ids a bot may read, home team first. */
      readableTeams: (agentId: string) => svc.readableTeams(agentId),
      /** Why `fromId` may not give work to `toId` (team access, main bot, no way around a wall), or null. */
      delegateError: (fromId: string, toId: string) => svc.delegateError(fromId, toId),
      /** Team ids a bot may give work to (home team and aansturen), home team first. */
      directableTeams: (agentId: string) => svc.directableTeams(agentId),
      /** The owner's main bot (hoofdbot) id, or null. At most one per owner; only the owner makes one. */
      mainOf: (userId: string) => svc.mainOf(userId),
      isMain: (agentId: string) => svc.isMain(agentId),
      /** A bot other than the main bot that may give work to more than one team. */
      isLeader: (agentId: string) => svc.isLeader(agentId),
      /** The "Alle teams" overview (same as GET /teams/overview). */
      overview: (userId: string) => overview(svc, userId),
      /** Team id a key is limited to, or null (all teams). */
      keyScope: (kind: string, refId: string) => svc.keyScope(kind, refId),
      /** May this bot use this key (kind provider | app | login | your own kind)? */
      keyAllowed: (agent: Pick<Agent, 'id' | 'user_id'> | string, kind: string, refId: string) => svc.keyAllowed(agent, kind, refId),
      /** Limit a key to one team (or null = all teams), as PUT /teams/keys/:kind/:id (package B4: an app set up for one team's folder). */
      setKeyScope: (userId: string, kind: string, refId: string, teamId: string | null) => svc.setKeyScope(userId, kind, refId, teamId),
      /** The team folder ({ path, label, mode, agents }) or null. */
      teamFolder: (teamId: string) => svc.teamFolder(teamId),
      /** Folder of the default team (or the old setting while there is no team). */
      defaultFolder: (userId: string) => svc.defaultFolder(userId),
      setFolder: (userId: string, teamId: string, folder: any) => svc.setFolder(userId, teamId, folder),
      /** Team folders a bot gets (home team's, plus read-only ones it may look into). */
      foldersFor: (agent: Agent) => svc.foldersFor(agent),
      /** A module's copier for duplicating a team (memory registers one: dossiers/knowledge only with `knowledge`). */
      registerCopier: (id: string, fn: TeamCopier) => svc.registerCopier(id, fn),
      /**
       * Copy a team's data into another team, module by module. Memory only with `knowledge: true` ("vakkennis
       * meenemen", off by default); `agentMap` maps the old team's bots to their copies.
       */
      copyTeamData: (userId: string, fromTeamId: string, toTeamId: string, o?: { knowledge?: boolean; agentMap?: Record<string, string> }) => svc.copyTeamData(userId, fromTeamId, toTeamId, o),
      /** The team's own daily budget (USD, 0 = none) and what its bots spent today. */
      budget: (teamId: string) => ({ limit: Number(svc.team(teamId)?.daily_budget_usd) || 0, spent: teamSpentToday(ctx, svc, teamId) }),
      // Making and changing teams for other modules (team templates, the OpenBot import): the same checks, audit lines
      // and events as the routes. `own` throws "Team niet gevonden" for a team of someone else.
      own: (userId: string, teamId: string) => svc.own(userId, teamId),
      /** `{ name, profile?, … }` as POST /api/teams. */
      create: (userId: string, data: any) => svc.create(userId, data),
      /** `{ name?, leadAgentId?, profile?, … }` as PATCH /api/teams/:id. */
      update: (userId: string, teamId: string, data: any) => svc.update(userId, teamId, data),
      /** Move a bot to this home team. */
      setHome: (userId: string, teamId: string, agentId: string) => svc.setHome(userId, teamId, agentId),
      remove: (userId: string, teamId: string) => svc.remove(userId, teamId),
      /** Make this bot the main bot (refused while another one is) → `{ notes }`; the main bot a normal bot again. */
      setMain: (userId: string, agentId: string) => svc.setMain(userId, agentId),
      clearMain: (userId: string) => svc.clearMain(userId),
      /** For tests and diagnostics only; other modules use the methods above. */
      _service: svc,
      /** Stuck work the main bot reports (stuck.ts); tests call `tick()` directly. */
      stuck: stuck,
      /** The overview the main bot sends (briefing.ts); tests call `tick()` or `send()` directly. */
      briefing,
      exportUser: (userId: string) => svc.exportUser(userId),
    };
  },
  start(ctx: Ctx) {
    stuckReporters.get(ctx)?.start();
    briefings.get(ctx)?.start();
  },
  stop(ctx: Ctx) {
    stuckReporters.get(ctx)?.stop();
    briefings.get(ctx)?.stop();
    const i = instances.get(ctx);
    if (!i) return;
    for (const d of i.dispose.splice(0)) d();
  },
};

export default mod;
