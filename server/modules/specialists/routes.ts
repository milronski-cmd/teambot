import type { Request } from 'express';
import type { Ctx } from '../../core/types.js';
import { HttpError, ah, bad, str, user } from '../../core/http.js';
import { BUDGETS, SOURCE_KINDS, SOURCE_LABEL, type SpecialistService } from './service.js';
import { decideProposal, proposals } from './skills.js';

const p = (req: Request, k: string) => String(req.params[k] ?? '');

/** Errors of other modules (routines' HttpishError) keep their status and Dutch message. */
function rethrow(e: any): never {
  if (e instanceof HttpError) throw e;
  if (typeof e?.status === 'number') throw new HttpError(e.status, e.message);
  throw bad(e?.message || String(e));
}

/** REST API under /api/specialists (see docs/modules/specialists.md). Always only the signed-in owner's bots. */
export function specialistRoutes(ctx: Ctx, svc: SpecialistService) {
  const api = ctx.api;

  api.get(
    '/specialists/meta',
    ah(async () => ({
      kinds: SOURCE_KINDS.map((id) => ({ id, label: SOURCE_LABEL[id] })),
      budgets: Object.entries(BUDGETS).map(([id, b]) => ({ id, label: b.label, tokens: b.tokens, calls: b.calls })),
      memoryAvailable: !!ctx.services.memory?.dossiers,
      freeModels: typeof ctx.services.freeModels?.candidates === 'function',
    })),
  );

  api.get('/specialists', ah(async (req) => svc.list(user(req).id)));

  // ---- rounds, reports, goals and proposals by their own id (before /:agentId)
  api.post(
    '/specialists/rounds/:id/undo',
    ah(async (req) => {
      const idx = req.body?.index;
      return svc.undoRound(user(req).id, p(req, 'id'), idx === undefined || idx === null ? null : Number(idx));
    }),
  );
  api.post('/specialists/reports/:id/undo', ah(async (req) => svc.undoReport(user(req).id, p(req, 'id'))));
  api.post(
    '/specialists/reports/:id/seen',
    ah(async (req) => {
      const u = user(req);
      const r = ctx.store.get<any>('specialist_reports', p(req, 'id'));
      if (!r || r.user_id !== u.id) throw new HttpError(404, 'Leerverslag niet gevonden');
      ctx.store.update('specialist_reports', r.id, { seen_at: r.seen_at || new Date().toISOString() });
      svc.emit(u.id, r.agent_id, 'reports');
      return { ok: true };
    }),
  );
  api.patch('/specialists/goals/:id', ah(async (req) => svc.updateGoal(user(req).id, p(req, 'id'), req.body || {})));
  api.delete('/specialists/goals/:id', ah(async (req) => svc.removeGoal(user(req).id, p(req, 'id'))));
  api.post('/specialists/proposals/:id', ah(async (req) => decideProposal(svc, user(req).id, p(req, 'id'), req.body || {})));

  // ---- one specialist
  api.get(
    '/specialists/:agentId',
    ah(async (req) => {
      const a = svc.ownAgent(user(req).id, p(req, 'agentId'));
      return svc.view(a);
    }),
  );
  api.put(
    '/specialists/:agentId',
    ah(async (req) => {
      try {
        return svc.save(user(req).id, p(req, 'agentId'), req.body || {});
      } catch (e) {
        rethrow(e);
      }
    }),
  );
  api.post(
    '/specialists/:agentId/learn',
    ah(async (req) => {
      try {
        return await svc.learnNow(user(req).id, p(req, 'agentId'));
      } catch (e) {
        rethrow(e);
      }
    }),
  );
  api.get('/specialists/:agentId/knowledge', ah(async (req) => svc.knowledge(user(req).id, p(req, 'agentId'))));
  api.post(
    '/specialists/:agentId/knowledge',
    ah(async (req) => {
      const u = user(req);
      try {
        const out = svc.addFact(u.id, p(req, 'agentId'), { content: str(req.body?.content, 1000), source: req.body?.source ? str(req.body.source, 1000) : null, replaces: req.body?.replaces ? str(req.body.replaces, 80) : null, by: { type: 'user' } });
        if (!out?.item) throw bad(out?.message || 'Niet opgeslagen');
        return { action: out.action, message: out.message, ref: out.item.ref };
      } catch (e) {
        rethrow(e);
      }
    }),
  );
  // "Werkt niet meer": retire one fact with the reason; the bot is told not to use it any more.
  api.post(
    '/specialists/:agentId/knowledge/:ref/retire',
    ah(async (req) => {
      const u = user(req);
      try {
        const out = svc.retireFact(u.id, p(req, 'agentId'), p(req, 'ref'), str(req.body?.reason, 300), { type: 'user', id: u.id });
        return { changeId: out.changeId, ref: out.item?.ref };
      } catch (e) {
        rethrow(e);
      }
    }),
  );
  api.get(
    '/specialists/:agentId/goals',
    ah(async (req) => {
      svc.ownAgent(user(req).id, p(req, 'agentId'));
      return svc.goals(p(req, 'agentId'));
    }),
  );
  api.post(
    '/specialists/:agentId/goals',
    ah(async (req) => {
      const a = svc.ownAgent(user(req).id, p(req, 'agentId'));
      if (!svc.active(a.id)) throw bad(`${a.name} is nog geen specialist.`);
      const r = svc.addGoal(a, { question: str(req.body?.question, 600), origin: 'owner' });
      if (!r) throw bad('Schrijf het leerdoel als een gewone vraag (er kunnen hoogstens 30 leerdoelen tegelijk open staan).');
      return r.goal;
    }),
  );
  api.get(
    '/specialists/:agentId/reports',
    ah(async (req) => {
      svc.ownAgent(user(req).id, p(req, 'agentId'));
      return { reports: svc.reports(p(req, 'agentId')), rounds: svc.rounds(p(req, 'agentId')) };
    }),
  );
  api.post(
    '/specialists/:agentId/report',
    ah(async (req) => {
      const u = user(req);
      const a = svc.ownAgent(u.id, p(req, 'agentId'));
      if (!svc.active(a.id)) throw bad(`${a.name} is nog geen specialist.`);
      return svc.weeklyReport(u.id, a.id, { force: true });
    }),
  );
  api.get(
    '/specialists/:agentId/proposals',
    ah(async (req) => {
      svc.ownAgent(user(req).id, p(req, 'agentId'));
      return proposals(svc, p(req, 'agentId'));
    }),
  );
}
