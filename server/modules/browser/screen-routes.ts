import fs from 'node:fs';
import type { Request, Response } from 'express';
import type { Agent, Ctx } from '../../core/types.js';
import { ah, notFound, own, str, user } from '../../core/http.js';
import { startMjpeg } from './mjpeg.js';
import { LEVEL_LABEL } from './screen-policy.js';
import { HttpLike, type ComputerService } from './service.js';

/**
 * Routes for full-screen computer use on this desktop. Registered before the generic /computers/:agentId routes
 * (literal /computers/desktop/... paths). Only the owner of this computer: it is their real screen.
 * Everything a paired phone may use is listed in MOBILE_SCREEN_ROUTES (watch, stop, pause/resume, revoke).
 */
export const MOBILE_SCREEN_ROUTES: { method: string; path: string }[] = [
  { method: 'GET', path: '/computers/desktop/state' },
  { method: 'POST', path: '/computers/desktop/stop' },
  { method: 'GET', path: '/computers/:agentId/screen' },
  { method: 'GET', path: '/computers/:agentId/screen/stream' },
  { method: 'GET', path: '/computers/:agentId/screen/frame.jpg' },
  { method: 'GET', path: '/computers/:agentId/screen/preview/:callId' },
  { method: 'GET', path: '/computers/:agentId/screen/preview/:callId/image' },
  { method: 'POST', path: '/computers/:agentId/screen/pause' },
  { method: 'POST', path: '/computers/:agentId/screen/resume' },
  { method: 'DELETE', path: '/computers/:agentId/screen/grant' },
  { method: 'POST', path: '/computers/:agentId/stop' },
  { method: 'GET', path: '/computers/:agentId/actions' },
  { method: 'GET', path: '/computers/:agentId/actions/:actionId/frame' },
];

export function screenRoutes(ctx: Ctx, svc: ComputerService) {
  const api = ctx.api;
  const sc = svc.screen;
  const ownerOnly = (req: Request) => {
    const u = user(req);
    if (u.role !== 'owner') throw new HttpLike(403, 'Alleen de eigenaar van deze computer');
    return u;
  };
  const agentOf = (req: Request): Agent => own(req, ctx.store.agent(String(req.params.agentId)), 'Bot niet gevonden');
  const hostAgent = (req: Request): Agent => {
    ownerOnly(req);
    const a = agentOf(req);
    if (!svc.config(a).host_control) throw notFound('Bureaubladbediening staat uit voor deze bot');
    return a;
  };

  api.get(
    '/computers/desktop/state',
    ah(async (req) => {
      ownerOnly(req);
      return sc.state();
    }),
  );

  /** Emergency stop for the whole desktop (app button, phone, tray, global hotkey all end up here). */
  api.post(
    '/computers/desktop/stop',
    ah(async (req) => {
      const u = ownerOnly(req);
      return sc.stopAll(u, str(req.body?.source, 40) || 'app');
    }),
  );
  api.post(
    '/computers/desktop/resume',
    ah(async (req) => {
      const u = ownerOnly(req);
      return sc.resumeAll(u);
    }),
  );

  api.get(
    '/computers/:agentId/screen',
    ah(async (req) => {
      const u = ownerOnly(req);
      const a = agentOf(req);
      const cfg = svc.config(a);
      const g = sc.grant(a.id);
      const ctl = svc.controller('desktop:host');
      return {
        enabled: cfg.host_control && cfg.mode === 'host',
        level: cfg.host_level,
        levelLabel: LEVEL_LABEL[cfg.host_level],
        options: cfg.host_options,
        apps: cfg.host_apps,
        stopped: svc.hostStopped.has(a.id),
        controller: ctl,
        mine: !!(ctl && ctl.kind === 'user' && ctl.userId === u.id),
        botActive: !!(ctl && ctl.kind === 'bot' && ctl.agentId === a.id),
        grant: g ? { goal: g.goal, until: new Date(g.until).toISOString(), apps: g.apps, actions: g.actions, threadId: g.threadId } : null,
        hotkey: sc.hotkey,
        monitors: cfg.host_control ? await sc.monitors().catch(() => []) : [],
        viewers: sc.viewerCount(a.id),
      };
    }),
  );

  /** Live view of the bot's monitor as MJPEG (same masking as the bot sees; works in <img>, also on phones). */
  api.get(
    '/computers/:agentId/screen/stream',
    ah(async (req, res: Response) => {
      const a = hostAgent(req);
      const send = startMjpeg(res);
      const handle = { end: () => res.end() };
      svc.streams.add(handle);
      const unsub = sc.subscribe(a, send);
      req.on('close', () => {
        unsub();
        svc.streams.delete(handle);
      });
    }),
  );

  api.get(
    '/computers/:agentId/screen/frame.jpg',
    ah(async (req, res) => {
      const a = hostAgent(req);
      const buf = (await sc.frame(a).catch(() => null)) || sc.latestFrame(a.id);
      if (!buf) throw notFound('Nog geen beeld');
      res.setHeader('cache-control', 'no-store');
      res.type('jpeg').send(buf);
    }),
  );

  /** Approval preview of a desktop action: the screen with the target marked (keyed by tool call id). */
  api.get(
    '/computers/:agentId/screen/preview/:callId',
    ah(async (req) => {
      ownerOnly(req);
      const a = agentOf(req);
      const p = sc.preview(String(req.params.callId), a.id);
      if (!p) throw notFound('Geen voorbeeld (meer)');
      return { ...p.meta, file: undefined, at: new Date(p.at).toISOString() };
    }),
  );
  api.get(
    '/computers/:agentId/screen/preview/:callId/image',
    ah(async (req, res) => {
      ownerOnly(req);
      const a = agentOf(req);
      const p = sc.preview(String(req.params.callId), a.id);
      if (!p || !fs.existsSync(p.file)) throw notFound('Geen voorbeeld (meer)');
      res.setHeader('cache-control', 'private, max-age=600');
      res.type('jpeg').sendFile(p.file);
    }),
  );

  /** "Neem over": the owner gets the desktop, the bot's next action waits. */
  api.post(
    '/computers/:agentId/screen/pause',
    ah(async (req) => {
      const u = ownerOnly(req);
      const a = agentOf(req);
      const lease = svc.takeControl(u, 'desktop:host', { sticky: true });
      svc.logAction(u.id, a.id, { actor: 'user', actorName: u.name, tool: 'takeover', summary: 'Bureaublad overgenomen: de bot wacht', status: 'done' });
      ctx.audit(u.id, 'computer.takeover', { kind: 'desktop', sticky: true }, a.id);
      sc.emitState();
      return { ok: true, controller: svc.controller(lease.resource) };
    }),
  );
  /** "Geef terug": release the owner's hold and lift an emergency-stop pause for this bot. */
  api.post(
    '/computers/:agentId/screen/resume',
    ah(async (req) => {
      const u = ownerOnly(req);
      const a = agentOf(req);
      const ok = svc.releaseControl(u, 'desktop:host');
      const wasStopped = svc.hostStopped.delete(a.id);
      svc.logAction(u.id, a.id, { actor: 'user', actorName: u.name, tool: 'release', summary: wasStopped ? 'Bureaublad hervat na noodstop' : 'Bureaublad teruggegeven aan de bot', status: 'done' });
      if (wasStopped) ctx.audit(u.id, 'computer.host_resumed', {}, a.id);
      sc.emitState();
      ctx.events.emit(u.id, 'computer.status', svc.statusOf(a));
      return { ok, resumed: wasStopped };
    }),
  );
  api.delete(
    '/computers/:agentId/screen/grant',
    ah(async (req) => {
      ownerOnly(req);
      const a = agentOf(req);
      return { ok: sc.revokeGrant(a.id, 'door de gebruiker') };
    }),
  );
}
