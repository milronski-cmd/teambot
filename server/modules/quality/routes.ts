import type { Ctx } from '../../core/types.js';
import { ah, bad, notFound, user } from '../../core/http.js';
import type { QualityService } from './service.js';
import { decideSuggestion, suggestions } from './skills.js';
import type { TaskKind } from './types.js';

const KINDS: TaskKind[] = ['room', 'teamdata', 'delegation'];

/**
 * /api/quality — what waits for the owner (te controleren, kon niet, skill suggestions), one task's quality record,
 * and the lessons a bot learned. Changing a task itself goes through its own module (rooms, teamdata), which checks
 * who may do that.
 */
export function qualityRoutes(ctx: Ctx, svc: QualityService) {
  const api = ctx.api;
  const kindOf = (v: any): TaskKind => {
    if (!KINDS.includes(v)) throw bad('Onbekende soort taak');
    return v;
  };
  /**
   * A team database task in the teamdata module's own form (`<teamId>:<id>`: every team has its own database, B2):
   * "12" means that row in `?team=` or the default team. Other kinds as they are.
   */
  const refOf = (userId: string, kind: TaskKind, raw: unknown, team: unknown): string => {
    const ref = String(raw ?? '');
    if (kind !== 'teamdata') return ref;
    const td = ctx.services.teamdata;
    if (typeof td?.parseTaskRef !== 'function') {
      if (!/^\d{1,12}$/.test(ref)) throw bad('Ongeldige taak');
      return ref;
    }
    const p = td.parseTaskRef(userId, ref, typeof team === 'string' && team.trim() ? team.trim().slice(0, 80) : null);
    if (!p) throw bad('Ongeldige taak');
    return p.ref;
  };

  api.get(
    '/quality/inbox',
    ah(async (req) => {
      const u = user(req);
      const tasks = svc.openItems(u.id);
      const sugg = suggestions(svc, u.id);
      return { tasks, suggestions: sugg, count: tasks.length + sugg.length };
    }),
  );

  api.get(
    '/quality/task/:kind/:ref',
    ah(async (req) => {
      const u = user(req);
      const kind = kindOf(req.params.kind);
      const ref = refOf(u.id, kind, req.params.ref, req.query.team);
      const r = svc.row(u.id, kind, ref);
      return { kind, ref, title: r?.title || '', ...svc.view(r), steps: r?.steps || [] };
    }),
  );

  // Owner-only fields of a team database task (own database): "klaar als" and skipping the check.
  api.patch(
    '/quality/task/teamdata/:ref',
    ah(async (req) => {
      const u = user(req);
      const ref = refOf(u.id, 'teamdata', req.params.ref, req.query.team);
      const b = req.body || {};
      if (b.doneWhen !== undefined) svc.setDoneWhen(u.id, 'teamdata', ref, b.doneWhen, 'user');
      if (b.skipCheck !== undefined) svc.setSkip(u.id, 'teamdata', ref, b.skipCheck === true);
      return svc.viewFor(u.id, 'teamdata', ref);
    }),
  );

  api.get('/quality/suggestions', ah(async (req) => suggestions(svc, user(req).id, String(req.query.status || 'open'))));
  api.post(
    '/quality/suggestions/:id',
    ah(async (req) => {
      const u = user(req);
      const d = req.body?.decision;
      if (d !== 'accept' && d !== 'dismiss') throw bad('Kies accept of dismiss');
      const r = await decideSuggestion(svc, u, String(req.params.id), d === 'accept');
      if (!r.ok) throw r.error === 'Voorstel niet gevonden' ? notFound(r.error) : bad(r.error!);
      return r;
    }),
  );

  api.get(
    '/quality/lessons',
    ah(async (req) => {
      const u = user(req);
      const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : '';
      const rows = agentId
        ? ctx.store.all<any>('SELECT * FROM quality_lessons WHERE user_id = ? AND agent_id = ? ORDER BY created_at DESC LIMIT 50', u.id, agentId)
        : ctx.store.all<any>('SELECT * FROM quality_lessons WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', u.id);
      return rows.map((r) => ({ id: r.id, agentId: r.agent_id, agentName: ctx.store.agent(r.agent_id)?.name || 'Verwijderde bot', threadId: r.thread_id, messageId: r.message_id, content: r.content, action: r.action, ref: r.memory_ref, created_at: r.created_at }));
    }),
  );
}
