import type { Request } from 'express';
import type { Ctx, Module, User } from '../../core/types.js';
import { ah, HttpError, user } from '../../core/http.js';
import { isLocalRequest } from '../../core/auth.js';
import { RemoteDesktopService } from './service.js';

/**
 * "Bureaublad op afstand" (parity 11.7): see and control the whole Windows desktop from the paired phone or a browser
 * on another PC. Service and safety rules: service.ts. Switching it on (`PUT /remote-desktop/switch`) is in the
 * phone's computer-only list (server/modules/mobile/policy.ts) and is also refused for any request that does not come
 * from this computer itself (a browser on another PC). Switching off works from everywhere.
 */

const services = new WeakMap<Ctx, RemoteDesktopService>();
const sweepers = new WeakMap<Ctx, NodeJS.Timeout>();

type Auth = { id: string; kind: string; name: string };
/** Interactive sign-ins only: the desktop app, a browser login, a paired phone (never a future script/API token). */
const INTERACTIVE = new Set(['desktop', 'web', 'device']);
const authOf = (req: Request): Auth => {
  const s = (req as any).session as Auth | undefined;
  if (!s?.id) throw new HttpError(401, 'Niet ingelogd');
  if (!INTERACTIVE.has(s.kind)) throw new HttpError(403, 'Bureaublad op afstand werkt alleen met je eigen ingelogde app, browser of telefoon.');
  return s;
};

/** The owner of this computer; anyone else (members, admins) gets a plain 403. */
function ownerOf(ctx: Ctx, req: Request): User {
  const u = user(req);
  authOf(req);
  const o = ctx.auth.owner();
  if (u.role !== 'owner' || !o || o.id !== u.id) throw new HttpError(403, 'Alleen de eigenaar van deze computer kan het bureaublad op afstand gebruiken.');
  return u;
}

/** At the computer itself: a direct loopback request of a non-phone session (see isLocalRequest). */
const atComputer = (req: Request) => isLocalRequest(req) && authOf(req).kind !== 'device';

const mod: Module = {
  id: 'remote-desktop',
  label: 'Bureaublad op afstand',

  init(ctx: Ctx) {
    const svc = new RemoteDesktopService(ctx);
    services.set(ctx, svc);
    const api = ctx.api;

    api.get(
      '/remote-desktop',
      ah(async (req) => {
        const u = ownerOf(ctx, req);
        return svc.state({ userId: u.id, authSessionId: authOf(req).id, here: atComputer(req) });
      }),
    );

    /** On/off and the options. Only at the computer itself (COMPUTER_ONLY for phones, loopback for everyone). */
    api.put(
      '/remote-desktop/switch',
      ah(async (req) => {
        const u = ownerOf(ctx, req);
        if (!atComputer(req)) throw new HttpError(403, 'Bureaublad op afstand aanzetten of instellen kan alleen op de computer zelf. Uitzetten kan overal.', 'remote_here_only');
        svc.configure(u, req.body || {});
        return svc.state({ userId: u.id, authSessionId: authOf(req).id, here: true });
      }),
    );

    /** Off from anywhere (the phone too): ends every session. */
    api.post(
      '/remote-desktop/off',
      ah(async (req) => {
        const u = ownerOf(ctx, req);
        svc.turnOff(u, authOf(req).kind === 'device' ? 'telefoon' : atComputer(req) ? 'computer' : 'browser');
        return svc.state({ userId: u.id, authSessionId: authOf(req).id, here: atComputer(req) });
      }),
    );

    api.post(
      '/remote-desktop/sessions',
      ah(async (req) => {
        const u = ownerOf(ctx, req);
        const x = svc.start(u, authOf(req), { ip: String(req.ip || req.socket.remoteAddress || ''), monitor: req.body?.monitor, view: req.body?.view });
        let monitors: any[] = [];
        try {
          monitors = (await svc.monitors(true)).map((m) => ({ index: m.index, w: m.w, h: m.h, primary: m.primary }));
        } catch (e: any) {
          svc.end(x.id, 'ended', { quiet: true });
          throw e instanceof HttpError ? e : new HttpError(503, String(e?.message || e).slice(0, 300), 'remote_capture');
        }
        return { id: x.id, view: x.view, monitor: x.monitor, monitors, control: svc.settings().control, idleMinutes: svc.settings().idleMinutes, idleLeftMs: svc.idleLeft(x) };
      }),
    );

    api.get(
      '/remote-desktop/sessions/:id',
      ah(async (req) => {
        const u = ownerOf(ctx, req);
        const x = svc.get(String(req.params.id), u, authOf(req).id);
        const monitors = (await svc.monitors().catch(() => [])).map((m) => ({ index: m.index, w: m.w, h: m.h, primary: m.primary }));
        return { id: x.id, view: x.view, monitor: x.monitor, monitors, control: svc.settings().control, idleMinutes: svc.settings().idleMinutes, idleLeftMs: svc.idleLeft(x), bot: svc.botState(), tookOverFrom: x.tookOverFrom };
      }),
    );

    /** One JPEG of the chosen monitor (`m`, long side `w`, quality `q`); 304 when it did not change (ETag). */
    api.get(
      '/remote-desktop/sessions/:id/frame',
      ah(async (req, res) => {
        const u = ownerOf(ctx, req);
        const x = svc.get(String(req.params.id), u, authOf(req).id);
        const f = await svc.frame(x, { m: req.query.m, w: req.query.w, q: req.query.q }, String(req.headers['if-none-match'] || ''));
        res.setHeader('cache-control', 'no-store');
        res.setHeader('etag', f.etag);
        res.setHeader('x-tb-cursor', f.cursor ? `${f.cursor.x.toFixed(5)},${f.cursor.y.toFixed(5)}` : '');
        res.setHeader('x-tb-idle', String(Math.round(f.idleLeftMs)));
        res.setHeader('x-tb-size', `${f.width}x${f.height}`);
        if (f.notModified) return void res.status(304).end();
        res.type('jpeg').send(f.jpeg);
      }),
    );

    api.post(
      '/remote-desktop/sessions/:id/input',
      ah(async (req) => {
        const u = ownerOf(ctx, req);
        const x = svc.get(String(req.params.id), u, authOf(req).id);
        return svc.input(x, u, req.body || {});
      }),
    );

    /** "Alleen kijken" on/off for this session (watching only by choice; the owner's setting wins). */
    api.post(
      '/remote-desktop/sessions/:id/view',
      ah(async (req) => {
        const u = ownerOf(ctx, req);
        const x = svc.get(String(req.params.id), u, authOf(req).id);
        x.view = !svc.settings().control || req.body?.view !== false;
        svc.emit();
        return { view: x.view };
      }),
    );

    api.post(
      '/remote-desktop/sessions/:id/keepalive',
      ah(async (req) => {
        const u = ownerOf(ctx, req);
        return svc.keepalive(svc.get(String(req.params.id), u, authOf(req).id));
      }),
    );

    /** End a session: the viewer's own, or any of the owner's sessions from the page on the computer. */
    api.delete(
      '/remote-desktop/sessions/:id',
      ah(async (req) => {
        const u = ownerOf(ctx, req);
        const id = String(req.params.id);
        const st = svc.state({ userId: u.id });
        if (!st.sessions.some((s) => s.id === id)) return { ok: false };
        return { ok: svc.end(id, 'ended') };
      }),
    );

    /**
     * For the desktop shell (desktop/remote-indicator.ts): attach the on-screen indicator, follow who watches, and
     * the Stop button. `_service` for tests (dry-run driver).
     */
    ctx.services.remoteDesktop = {
      attachIndicator: () => svc.attachIndicator(),
      onState: (fn: (s: any) => void) => svc.onState(fn),
      stopFromComputer: (source?: string) => svc.stopFromComputer(source),
      active: () => svc.indicatorState().sessions.length > 0,
      _service: svc,
    };
  },

  start(ctx) {
    const t = setInterval(() => services.get(ctx)?.sweep(), 5_000);
    t.unref?.();
    sweepers.set(ctx, t);
  },

  stop(ctx) {
    const t = sweepers.get(ctx);
    if (t) clearInterval(t);
    sweepers.delete(ctx);
    services.get(ctx)?.close();
  },
};

export default mod;
