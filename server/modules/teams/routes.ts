import type { Request } from 'express';
import type { Ctx } from '../../core/types.js';
import { ah, bad, notFound, own, str, user } from '../../core/http.js';
import type { TeamsService } from './service.js';
import { overview } from './overview.js';
import { duplicateTeam } from './duplicate.js';

const p = (req: Request, k: string) => String(req.params[k] ?? '');

/** REST API under /api/teams (see docs/modules/teams.md). Always only the signed-in owner's teams, bots and keys. */
export function teamRoutes(ctx: Ctx, svc: TeamsService) {
  const api = ctx.api;
  const viewAll = (userId: string) => {
    // Bots but no team (a bot made without the agent.updated event): its default team exists from now on.
    if (!svc.list(userId).length && ctx.store.agents(userId, { archived: true }).length) svc.ensureDefault(userId);
    return svc.list(userId).map((t) => svc.view(t, userId));
  };

  api.get('/teams', ah(async (req) => viewAll(user(req).id)));

  api.post(
    '/teams',
    ah(async (req) => {
      const u = user(req);
      return svc.view(svc.create(u.id, req.body || {}), u.id);
    }),
  );

  // ---- main bot (hoofdbot): at most one per owner, only made by the owner ----

  const mainView = (userId: string) => {
    const id = svc.mainOf(userId);
    const a = id ? ctx.store.agent(id) : null;
    return { main: a ? { id: a.id, name: a.name, avatar: a.avatar, color: a.color, role: a.role, archived: a.archived, homeTeamId: svc.teamOf(a.id) } : null };
  };
  api.get('/teams/main', ah(async (req) => mainView(user(req).id)));
  /** The new-bot flow chose "Hoofdbot": a single-use token for `settings.mainBot` of the bot it creates next. */
  api.post('/teams/main/intent', ah(async (req) => ({ token: svc.intent(user(req).id) })));
  /** Make an existing bot the main bot (refused while there is another one). */
  api.put(
    '/teams/main/:agentId',
    ah(async (req) => {
      const u = user(req);
      own(req, ctx.store.agent(p(req, 'agentId')), 'Bot niet gevonden');
      const r = svc.setMain(u.id, p(req, 'agentId'));
      return { ...mainView(u.id), notes: r.notes };
    }),
  );
  /** The main bot becomes a normal bot. */
  api.delete(
    '/teams/main',
    ah(async (req) => {
      const u = user(req);
      svc.clearMain(u.id);
      return mainView(u.id);
    }),
  );

  /** "Alle teams": per team the lead, bots, open tasks, what waits for you, results, errors, missed runs and usage. */
  api.get(
    '/teams/overview',
    ah(async (req) => {
      const u = user(req);
      viewAll(u.id);
      return overview(svc, u.id);
    }),
  );

  // Keys and logins with their scope ("alle teams" or "alleen dit team").
  api.get('/teams/keys', ah(async (req) => svc.keys(user(req).id)));
  api.put(
    '/teams/keys/:kind/:id',
    ah(async (req) => {
      const u = user(req);
      const kind = p(req, 'kind');
      if (!['provider', 'app', 'login', 'script'].includes(kind)) throw bad('Onbekende soort sleutel');
      const teamId = req.body?.teamId ? str(req.body.teamId, 80) : null;
      svc.setKeyScope(u.id, kind, p(req, 'id'), teamId);
      return svc.keys(u.id).find((k) => k.kind === kind && k.id === p(req, 'id'));
    }),
  );

  // One bot: its home team and its reach in every team.
  api.get(
    '/teams/bots/:agentId',
    ah(async (req) => {
      const a = own(req, ctx.store.agent(p(req, 'agentId')), 'Bot niet gevonden');
      return svc.botView(a);
    }),
  );

  api.get(
    '/teams/:id',
    ah(async (req) => {
      const u = user(req);
      return svc.view(svc.own(u.id, p(req, 'id')), u.id);
    }),
  );
  api.patch(
    '/teams/:id',
    ah(async (req) => {
      const u = user(req);
      return svc.view(svc.update(u.id, p(req, 'id'), req.body || {}), u.id);
    }),
  );
  api.delete(
    '/teams/:id',
    ah(async (req) => {
      svc.remove(user(req).id, p(req, 'id'));
      return { ok: true };
    }),
  );

  /** "Team dupliceren": a new team with copies of the bots (routines off), never memory, keys, channels or chats. */
  api.post(
    '/teams/:id/duplicate',
    ah(async (req) => duplicateTeam(ctx, svc, user(req).id, p(req, 'id'))),
  );

  /** Make this team the bot's home team (moves the bot). */
  api.put(
    '/teams/:id/bots/:agentId',
    ah(async (req) => {
      const u = user(req);
      svc.setHome(u.id, p(req, 'id'), p(req, 'agentId'));
      return svc.view(svc.own(u.id, p(req, 'id')), u.id);
    }),
  );

  /** Access of a bot of another team to this team: none, read (meekijken) or direct (aansturen). */
  api.put(
    '/teams/:id/access/:agentId',
    ah(async (req) => {
      const u = user(req);
      if (!ctx.store.agent(p(req, 'agentId'))) throw notFound('Bot niet gevonden');
      svc.setAccess(u.id, p(req, 'id'), p(req, 'agentId'), req.body?.level);
      return svc.view(svc.own(u.id, p(req, 'id')), u.id);
    }),
  );
}
