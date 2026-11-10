import type { Request } from 'express';
import type { Agent, Ctx } from '../../../core/types.js';
import { ah, own, str, user } from '../../../core/http.js';
import type { CloudVm, CloudVmService } from './service.js';

/** Cloud-VM API (all under /api, only the user's own bots and VMs). Registered before the generic /computers/:agentId routes. */
export function cloudVmRoutes(ctx: Ctx, cloud: CloudVmService) {
  const api = ctx.api;
  const agentOf = (req: Request): Agent => own(req, ctx.store.agent(String(req.params.agentId)), 'Bot niet gevonden');
  const vmOf = (req: Request): CloudVm => own(req, cloud.get(String(req.params.id)), 'VM niet gevonden');

  api.get('/computers/cloud/providers', ah(async (req) => cloud.providerList(user(req).id)));
  /** The API token is checked with the provider and stored encrypted; only `has_token` comes back. */
  api.put('/computers/cloud/:provider/token', ah(async (req) => cloud.saveToken(user(req), str(req.params.provider, 40), req.body?.token)));
  api.delete('/computers/cloud/:provider/token', ah(async (req) => cloud.deleteToken(user(req), str(req.params.provider, 40))));
  api.get('/computers/cloud/:provider/options', ah(async (req) => cloud.optionsView(user(req).id, str(req.params.provider, 40), req.query.refresh === '1')));
  api.get('/computers/cloud/:provider/estimate', ah(async (req) => cloud.estimateView(user(req).id, str(req.params.provider, 40), str(req.query.type, 60), str(req.query.location, 60))));

  /** All the user's VMs that still exist, including those whose bot was deleted (they still cost money). */
  api.get('/computers/cloud/vms', ah(async (req) => cloud.list(user(req).id)));
  api.post('/computers/cloud/vms/:id/poweroff', ah(async (req) => cloud.powerOff(user(req), vmOf(req))));
  api.post('/computers/cloud/vms/:id/poweron', ah(async (req) => cloud.powerOn(user(req), vmOf(req))));
  api.post('/computers/cloud/vms/:id/refresh', ah(async (req) => cloud.refresh(vmOf(req))));
  /** Typed confirmation: { confirm: <VM name> }. */
  api.post('/computers/cloud/vms/:id/delete', ah(async (req) => cloud.remove(user(req), vmOf(req), req.body?.confirm)));

  api.get(
    '/computers/:agentId/cloud',
    ah(async (req) => {
      const a = agentOf(req);
      return { vm: cloud.forAgent(a.id), ...cloud.allowedFor(a.user_id) };
    }),
  );
  /** { provider, server_type, location, image, docker, confirmCost } — confirmCost = the monthly estimate the user saw. */
  api.post(
    '/computers/:agentId/cloud',
    ah(async (req) => {
      const a = agentOf(req);
      return cloud.create(user(req), a, req.body || {});
    }),
  );
}
