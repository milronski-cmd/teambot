import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import type { Agent, Ctx } from '../../core/types.js';
import { ah, bad, notFound, own, str, user } from '../../core/http.js';
import { checkUrl } from './policy.js';
import { VIEWPORT } from './browser.js';
import { startMjpeg } from './mjpeg.js';
import { desktopSnapshots } from './host.js';
import { ELEMENT_INFO_JS } from './pagescripts.js';
import { HttpLike, type BrowserProfile, type ComputerService } from './service.js';

/**
 * What a paired phone may do with a bot's browser (the browser sheet on the phone): watch, take over and type/click,
 * give back. Never a visible window on the desktop, never profile or vault management.
 */
export const MOBILE_BROWSER_ROUTES: { method: string; path: string }[] = [
  { method: 'GET', path: '/computers/:agentId' },
  { method: 'GET', path: '/computers/:agentId/stream' },
  { method: 'GET', path: '/computers/:agentId/frame.jpg' },
  { method: 'POST', path: '/computers/:agentId/takeover' },
  { method: 'POST', path: '/computers/:agentId/release' },
  { method: 'POST', path: '/computers/:agentId/heartbeat' },
  { method: 'POST', path: '/computers/:agentId/input' },
];

const isDevice = (req: Request) => (req as any).session?.kind === 'device';

const KEYS = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space', 'Shift+Tab', 'Control+A', 'Control+C', 'Control+V', 'Control+X', 'Control+Y', 'Control+Z']);

export function computerRoutes(ctx: Ctx, svc: ComputerService) {
  const api = ctx.api;
  const agentOf = (req: Request): Agent => own(req, ctx.store.agent(String(req.params.agentId)), 'Bot niet gevonden');
  const profileOf = (req: Request): BrowserProfile => own(req, ctx.store.get<BrowserProfile>('browser_profiles', String(req.params.id)), 'Profiel niet gevonden');
  const rehearsalOf = (req: Request) => own(req, ctx.store.get<any>('rehearsals', String(req.params.id)), 'Repetitie niet gevonden');
  const snapshotOf = (req: Request) => own(req, ctx.store.get<any>('workspace_snapshots', String(req.params.id)), 'Snapshot niet gevonden');
  const wrap = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    try {
      return await fn();
    } catch (e: any) {
      if (e instanceof HttpLike) throw e;
      throw bad(String(e?.message || e));
    }
  };

  // ---------- device capabilities (truth table) ----------
  api.get(
    '/computers/capabilities',
    ah(async (req) => {
      const u = user(req);
      const caps = await svc.caps(req.query.refresh === '1');
      const isAdmin = u.role !== 'member';
      return {
        platform: caps.platform,
        osName: caps.osName,
        isWindowsHome: caps.isWindowsHome,
        appMode: caps.appMode,
        detectedAt: caps.detectedAt,
        browsers: caps.browsers.map((b) => ({ name: b.name, path: isAdmin ? b.path : undefined })),
        caps: Object.values(caps.caps).map((c) => ({ ...c, path: isAdmin ? c.path : undefined })),
        modes: await svc.modes(u),
        canAllowPrivate: svc.canAllowPrivate(u),
        isOwner: u.role === 'owner',
        engine: await svc.engineView(u.id),
      };
    }),
  );
  /** "Browser van de bots": inside TeamBot (invisible tabs) or an installed Edge/Chrome. Running browsers keep theirs. */
  api.put(
    '/computers/engine',
    ah(async (req) => {
      const u = user(req);
      svc.setEngine(u, req.body?.engine);
      return svc.engineView(u.id);
    }),
  );

  // ---------- browser profiles (incl. shared computers) ----------
  api.get('/computers/profiles', ah(async (req) => svc.profilesOf(user(req).id)));
  api.post(
    '/computers/profiles',
    ah(async (req) => {
      const u = user(req);
      return svc.createSharedProfile(u.id, str(req.body?.name, 80), req.body?.room_id ? str(req.body.room_id, 64) : null);
    }),
  );
  api.post(
    '/computers/profiles/:id/wipe',
    ah(async (req) => {
      const p = profileOf(req);
      await svc.wipeProfile(user(req).id, p);
      return { ok: true };
    }),
  );
  /** Share a profile between selected bots (a bot's own profile becomes shared; its logins stay). */
  api.put(
    '/computers/profiles/:id/members',
    ah(async (req) => {
      const p = profileOf(req);
      const ids = Array.isArray(req.body?.agent_ids) ? req.body.agent_ids.map((x: any) => str(x, 64)) : null;
      if (!ids) throw bad('Kies de bots die dit profiel delen');
      return wrap(() => svc.setProfileMembers(user(req), p, ids));
    }),
  );
  /** This profile's own proxy (address + optional login, write-only); '' clears it. Applies to this profile only. */
  api.put(
    '/computers/profiles/:id/proxy',
    ah(async (req) => {
      const p = profileOf(req);
      return { proxy: await svc.setProfileProxy(user(req), p, req.body || {}) };
    }),
  );
  api.post(
    '/computers/profiles/:id/proxy/test',
    ah(async (req) => {
      const p = profileOf(req);
      return svc.testProfileProxy(user(req), p, req.body || {});
    }),
  );
  /** Sites with cookies in this profile (starts the browser headless if needed). */
  api.get(
    '/computers/profiles/:id/sites',
    ah(async (req) => {
      const p = profileOf(req);
      return wrap(() => svc.cookieSites(p));
    }),
  );
  /** Log out of one site: cookies + site data of that site in this profile. */
  api.post(
    '/computers/profiles/:id/logout',
    ah(async (req) => {
      const p = profileOf(req);
      return wrap(() => svc.logoutSite(user(req), p, str(req.body?.site, 300), null));
    }),
  );
  api.delete(
    '/computers/profiles/:id',
    ah(async (req) => {
      const p = profileOf(req);
      if (!p.shared) throw bad('Een eigen botprofiel verwijder je door het te wissen of de bot te verwijderen');
      await svc.deleteProfile(user(req).id, p);
      return { ok: true };
    }),
  );

  // ---------- rehearsals ----------
  api.get(
    '/computers/rehearsals/:id',
    ah(async (req) => {
      const r = rehearsalOf(req);
      return { rehearsal: r, changes: r.status === 'active' || r.status === 'review' ? svc.rehearsalChanges(r) : [] };
    }),
  );
  api.get(
    '/computers/rehearsals/:id/diff',
    ah(async (req) => {
      const r = rehearsalOf(req);
      if (!(r.status === 'active' || r.status === 'review')) throw bad('Deze repetitie is afgerond');
      // A moved file (B-36): the old place in the real folder against the new place in the copy.
      const from = str(req.query.from, 1000);
      return wrap(() => svc.rehearsalFileDiff(r, str(req.query.path, 1000), from || undefined));
    }),
  );
  /** Two bots practising in the same folder: one file from both practice copies, side by side (B-42). */
  api.get(
    '/computers/rehearsals/:id/compare',
    ah(async (req) => {
      const r = rehearsalOf(req);
      const other = own(req, ctx.store.get<any>('rehearsals', str(req.query.with, 100)), 'Repetitie niet gevonden');
      const open = (x: any) => x.status === 'active' || x.status === 'review';
      if (!open(r) || !open(other)) throw bad('Deze repetitie is afgerond');
      if (other.id === r.id || path.resolve(other.original) !== path.resolve(r.original)) throw bad('Deze twee oefenrondes werken niet in dezelfde map');
      return wrap(() => svc.compareRehearsalFiles(r, other, str(req.query.path, 1000)));
    }),
  );
  api.post(
    '/computers/rehearsals/:id/apply',
    ah(async (req) => {
      const r = rehearsalOf(req);
      if (!(r.status === 'active' || r.status === 'review')) throw bad('Deze repetitie is afgerond');
      const files = Array.isArray(req.body?.files) ? req.body.files.map((f: any) => str(f, 1000)) : null;
      const force = Array.isArray(req.body?.force) ? req.body.force.map((f: any) => str(f, 1000)) : [];
      return wrap(() => svc.applyRehearsal(user(req).id, r, files, force));
    }),
  );
  api.post(
    '/computers/rehearsals/:id/revert',
    ah(async (req) => {
      const r = rehearsalOf(req);
      if (!(r.status === 'active' || r.status === 'review')) throw bad('Deze repetitie is afgerond');
      const files = Array.isArray(req.body?.files) ? req.body.files.map((f: any) => str(f, 1000)) : [];
      if (!files.length) throw bad('Kies bestanden om te verwerpen');
      const res = await wrap(() => svc.revertRehearsal(user(req).id, r, files));
      return { ok: true, kept: res.kept };
    }),
  );
  api.post(
    '/computers/rehearsals/:id/end',
    ah(async (req) => {
      const r = rehearsalOf(req);
      if (!(r.status === 'active' || r.status === 'review')) throw bad('Deze repetitie is al afgerond');
      const busy = ctx.store.one<any>("SELECT COUNT(*) n FROM runs WHERE agent_id = ? AND status IN ('queued','running','waiting')", r.agent_id)?.n ?? 0;
      if (busy) throw new HttpLike(409, 'De bot is nog bezig in de repetitie. Wacht tot hij klaar is of stop hem eerst.');
      const remaining = svc.rehearsalChanges(r);
      const discard = req.body?.discard === true;
      if (remaining.length && !discard) throw new HttpLike(409, `Er zijn nog ${remaining.length} niet-toegepaste wijzigingen. Pas ze toe of kies "verwerpen en afronden".`);
      return svc.endRehearsal(user(req).id, r, remaining.length ? 'discarded' : 'applied');
    }),
  );

  // ---------- snapshots ----------
  api.get(
    '/computers/snapshots/:id/preview',
    ah(async (req) => {
      const s = snapshotOf(req);
      const { restorePlan } = await import('./workspace.js');
      return wrap(() => restorePlan(s.workspace, s.dir));
    }),
  );
  api.post(
    '/computers/snapshots/:id/restore',
    ah(async (req) => {
      const s = snapshotOf(req);
      return wrap(() => svc.restoreSnapshot(user(req).id, s, req.body?.deleteExtra === true));
    }),
  );
  api.delete(
    '/computers/snapshots/:id',
    ah(async (req) => {
      const s = snapshotOf(req);
      svc.deleteSnapshot(user(req).id, s);
      return { ok: true };
    }),
  );

  // ---------- per-bot overview ----------
  api.get(
    '/computers',
    ah(async (req) => {
      const u = user(req);
      return ctx.store.agents(u.id).map((a) => ({ agent: { id: a.id, name: a.name, avatar: a.avatar, color: a.color, workspace: svc.realWorkspace(a) }, config: svc.config(a), status: svc.statusOf(a) }));
    }),
  );
  api.get(
    '/computers/:agentId',
    ah(async (req) => {
      const a = agentOf(req);
      return { config: svc.config(a), status: svc.statusOf(a), workspace: svc.realWorkspace(a) };
    }),
  );
  api.put(
    '/computers/:agentId/config',
    ah(async (req) => {
      const a = agentOf(req);
      return wrap(() => svc.saveConfig(user(req), a, req.body || {}));
    }),
  );

  // ---------- own server (SSH), only for the bot's owner ----------
  /** Connection test: host key fingerprint (always), then — only once trusted — OS and Docker after logging in. */
  api.post(
    '/computers/:agentId/remote/test',
    ah(async (req) => {
      const a = agentOf(req);
      return svc.testRemote(a);
    }),
  );
  /** Explicit trust-on-first-use: pin the fingerprint the user checked ({ fingerprint: null } forgets it). */
  api.put(
    '/computers/:agentId/remote/trust',
    ah(async (req) => {
      const a = agentOf(req);
      return wrap(() => svc.trustRemote(user(req), a, req.body?.fingerprint ?? null));
    }),
  );
  /** Accepts the private key or password once; stores it encrypted as a secret and returns only its name. */
  api.put(
    '/computers/:agentId/remote/credential',
    ah(async (req) => {
      const a = agentOf(req);
      return wrap(() => svc.setRemoteCredential(user(req), a, req.body?.kind, req.body?.value));
    }),
  );
  api.delete(
    '/computers/:agentId/remote/credential',
    ah(async (req) => {
      const a = agentOf(req);
      return wrap(() => svc.clearRemoteCredential(user(req), a));
    }),
  );
  api.get(
    '/computers/:agentId/actions',
    ah(async (req) => {
      const a = agentOf(req);
      const limit = Math.min(500, Number(req.query.limit) || 100);
      const thread = req.query.threadId ? String(req.query.threadId) : null;
      return ctx.store.all<any>(`SELECT * FROM computer_actions WHERE agent_id = ? AND user_id = ? ${thread ? 'AND thread_id = ?' : ''} ORDER BY created_at DESC LIMIT ${limit}`, ...(thread ? [a.id, a.user_id, thread] : [a.id, a.user_id]));
    }),
  );
  api.get(
    '/computers/:agentId/actions/:actionId/frame',
    ah(async (req, res) => {
      const a = agentOf(req);
      const row = ctx.store.get<any>('computer_actions', String(req.params.actionId));
      if (!row || row.agent_id !== a.id || !row.frame) throw notFound('Geen beeld bij deze stap');
      const file = path.join(svc.framesDir(a.id), path.basename(row.frame));
      if (!fs.existsSync(file)) throw notFound('Beeld is opgeruimd');
      res.setHeader('cache-control', 'private, max-age=3600');
      res.type(file.endsWith('.png') ? 'png' : 'jpeg').sendFile(file);
    }),
  );

  // ---------- browser runtime ----------
  /** The owner starts the bot's browser (headless; optionally on a URL) to look along or to log in ahead of time. */
  api.post(
    '/computers/:agentId/browser/start',
    ah(async (req) => {
      const a = agentOf(req);
      const s = await wrap(() => svc.startBrowser(user(req), a, req.body?.url ? str(req.body.url, 2000) : undefined));
      return { ok: true, url: s.clean(s.active.url()) };
    }),
  );
  /** "Uitloggen bij deze site" from the browser panel. */
  api.post(
    '/computers/:agentId/browser/logout-site',
    ah(async (req) => {
      const a = agentOf(req);
      const p = svc.findProfile(a);
      if (!p) throw notFound('Deze bot heeft nog geen browserprofiel');
      return wrap(() => svc.logoutSite(user(req), p, str(req.body?.site, 300), a.id));
    }),
  );
  api.post(
    '/computers/:agentId/browser/close',
    ah(async (req) => {
      const a = agentOf(req);
      const u = user(req);
      const p = svc.findProfile(a);
      if (!p) return { ok: false };
      const res = await svc.browsers.close('p:' + p.id);
      svc.logAction(u.id, a.id, { actor: 'user', actorName: u.name, tool: 'browser_close', summary: 'Browser gesloten door gebruiker', status: 'done' });
      svc.emitStatus(u.id, p.id);
      return { ok: res };
    }),
  );

  /** Latest live frame (or a fresh one). */
  api.get(
    '/computers/:agentId/frame.jpg',
    ah(async (req, res) => {
      const a = agentOf(req);
      const s = svc.sessionOf(a);
      if (!s) throw notFound('De browser van deze bot draait niet');
      const buf = (await s.frame(55)) || s.latestFrame;
      if (!buf) throw notFound('Nog geen beeld');
      res.setHeader('cache-control', 'no-store');
      res.type('jpeg').send(buf);
    }),
  );

  /** Live screen as MJPEG stream (works in <img>, also on phones). */
  api.get(
    '/computers/:agentId/stream',
    ah(async (req, res: Response) => {
      const a = agentOf(req);
      const s = svc.sessionOf(a);
      if (!s) throw notFound('De browser van deze bot draait niet');
      const send = startMjpeg(res);
      const handle = { end: () => res.end() };
      svc.streams.add(handle);
      const unsub = s.subscribe(send);
      const stop = () => {
        unsub();
        svc.streams.delete(handle);
        // the session may have been relaunched (takeover): detach from the current one too
        const cur = svc.sessionOf(a);
        if (cur && cur.viewers.delete(send) && !cur.viewers.size) cur.stopScreencast().catch(() => {});
      };
      req.on('close', stop);
      s.closeHandlers.add(() => {
        stop();
        res.end();
      });
    }),
  );

  /** Element facts for approval previews (rect in viewport pixels + form fields, secrets hidden). */
  api.get(
    '/computers/:agentId/element',
    ah(async (req) => {
      const a = agentOf(req);
      const s = svc.sessionOf(a);
      if (!s) throw notFound('De browser van deze bot draait niet');
      const ref = str(req.query.ref, 20);
      if (!/^e\d{1,7}$/.test(ref)) throw bad('Ongeldige referentie');
      const info = await s.active.evaluate(`(${ELEMENT_INFO_JS})(${JSON.stringify(ref)})`).catch(() => null);
      return { info, viewport: VIEWPORT, url: s.active.url() };
    }),
  );

  // ---------- human control (lease) ----------
  const resourceOf = (a: Agent, kind: string) => (kind === 'desktop' ? 'desktop:host' : 'browser:' + svc.profileFor(a).id);

  api.post(
    '/computers/:agentId/takeover',
    ah(async (req) => {
      const a = agentOf(req);
      const u = user(req);
      const kind = req.body?.target === 'desktop' ? 'desktop' : 'browser';
      if (kind === 'desktop' && u.role !== 'owner') throw new HttpLike(403, 'Alleen de eigenaar');
      const resource = resourceOf(a, kind);
      const visible = req.body?.visible === true && kind === 'browser';
      const sticky = req.body?.pause === true;
      if (visible && isDevice(req)) throw new HttpLike(403, 'Een venster op je computer open je vanaf je computer. Op de telefoon neem je over in het live beeld.');
      if (visible) {
        const caps = await svc.caps();
        if (caps.caps.visible.status !== 'available' || u.role !== 'owner') throw new HttpLike(400, caps.caps.visible.status !== 'available' ? caps.caps.visible.detail : 'Alleen de eigenaar van deze computer kan een zichtbaar venster openen.');
      }
      const lease = svc.takeControl(u, resource, { sticky, session: kind === 'browser' ? svc.sessionOf(a) : null });
      if (visible) {
        const s = svc.sessionOf(a);
        if (s && !s.headed) await svc.browsers.relaunch(s.key, true);
        else if (!s) await svc.browsers.ensure(svc.sessionOpts(svc.profileFor(a), true));
      }
      // a fresh picture for everyone watching: the last screencast frame may be older than the page
      if (kind === 'browser') svc.sessionOf(a)?.pushFrame().catch(() => {});
      svc.logAction(u.id, a.id, { actor: 'user', actorName: u.name, tool: 'takeover', summary: sticky ? 'Bot gepauzeerd' : visible ? 'Overgenomen in zichtbaar venster' : 'Overgenomen via live scherm', status: 'done' });
      ctx.audit(u.id, 'computer.takeover', { kind, visible, sticky }, a.id);
      if (kind === 'browser') svc.emitStatus(u.id, svc.profileFor(a).id);
      return { ok: true, controller: svc.controller(lease.resource) };
    }),
  );
  api.post(
    '/computers/:agentId/release',
    ah(async (req) => {
      const a = agentOf(req);
      const u = user(req);
      const kind = req.body?.target === 'desktop' ? 'desktop' : 'browser';
      const resource = resourceOf(a, kind);
      const ok = svc.releaseControl(u, resource);
      if (kind === 'browser') {
        const s = svc.sessionOf(a);
        if (s?.headed) await svc.browsers.relaunch(s.key, false).catch(() => {});
        svc.emitStatus(u.id, svc.profileFor(a).id);
      }
      if (kind === 'desktop') svc.hostStopped.delete(a.id);
      svc.logAction(u.id, a.id, { actor: 'user', actorName: u.name, tool: 'release', summary: 'Bediening teruggegeven aan de bot', status: 'done' });
      return { ok };
    }),
  );
  api.post(
    '/computers/:agentId/heartbeat',
    ah(async (req) => {
      const a = agentOf(req);
      const u = user(req);
      return { ok: svc.heartbeat(resourceOf(a, req.body?.target === 'desktop' ? 'desktop' : 'browser'), u.id) };
    }),
  );
  api.post(
    '/computers/:agentId/stop',
    ah(async (req) => {
      const a = agentOf(req);
      return svc.emergencyStop(user(req), a);
    }),
  );
  api.post(
    '/computers/:agentId/resume-host',
    ah(async (req) => {
      const a = agentOf(req);
      svc.hostStopped.delete(a.id);
      ctx.audit(user(req).id, 'computer.host_resumed', {}, a.id);
      return { ok: true };
    }),
  );

  /** Human input relayed into the bot's browser. Typed text is never stored, logged or shown to the bot. */
  api.post(
    '/computers/:agentId/input',
    ah(async (req) => {
      const a = agentOf(req);
      const u = user(req);
      const p = svc.findProfile(a);
      if (!p) throw notFound('De browser van deze bot draait niet');
      const resource = 'browser:' + p.id;
      const ctl = svc.leases.current(resource);
      if (!ctl || ctl.holder.kind !== 'user' || ctl.holder.id !== u.id) throw new HttpLike(409, 'Neem eerst de bediening over');
      svc.heartbeat(resource, u.id);
      const s = svc.sessionOf(a);
      if (!s) throw notFound('De browser van deze bot draait niet');
      const b = req.body || {};
      const page = s.active;
      s.touch();
      switch (b.type) {
        case 'click': {
          const x = Math.max(0, Math.min(1, Number(b.x))) * VIEWPORT.width;
          const y = Math.max(0, Math.min(1, Number(b.y))) * VIEWPORT.height;
          await page.mouse.click(x, y);
          break;
        }
        case 'type':
          await page.keyboard.type(str(b.text, 2000), { delay: 10 });
          break;
        case 'key': {
          const k = str(b.key, 30);
          if (!KEYS.has(k)) throw bad('Toets niet toegestaan');
          await page.keyboard.press(k);
          break;
        }
        case 'scroll':
          await page.mouse.wheel(0, Math.max(-3000, Math.min(3000, Number(b.dy) || 0)));
          break;
        case 'navigate': {
          const r = await checkUrl(str(b.url, 2000), svc.policyOf(svc.config(a)), { navigation: true });
          if (!r.ok) throw bad(r.reason || 'Geblokkeerd');
          await page.goto(r.url!.href, { waitUntil: 'domcontentloaded' }).catch(() => {});
          break;
        }
        case 'back':
          await page.goBack().catch(() => {});
          break;
        case 'forward':
          await page.goForward().catch(() => {});
          break;
        case 'tab': {
          const target = s.pages()[Number(b.index)];
          if (!target) throw bad('Dit tabblad bestaat niet (meer)');
          s.setActive(target);
          await target.bringToFront().catch(() => {});
          break;
        }
        case 'reload':
          await page.reload().catch(() => {});
          break;
        default:
          throw bad('Onbekende invoer');
      }
      // never log what the human typed
      if (b.type === 'navigate') svc.logAction(u.id, a.id, { actor: 'user', actorName: u.name, tool: 'navigate', summary: `Gebruiker opende ${str(b.url, 200)}`, url: page.url(), status: 'done' });
      // address bar and picture follow right away (the page events are debounced, and a static page sends no new frames)
      if (['navigate', 'back', 'forward', 'reload', 'tab'].includes(b.type)) {
        svc.emitStatus(u.id, p.id);
        s.pushFrame().catch(() => {});
      }
      return { ok: true, url: s.clean(s.active.url()) };
    }),
  );

  // ---------- rehearsal + snapshots per bot ----------
  api.get(
    '/computers/:agentId/rehearsal',
    ah(async (req) => {
      const a = agentOf(req);
      const r = svc.activeRehearsal(a.id);
      const history = ctx.store.find<any>('rehearsals', { agent_id: a.id }, { order: 'created_at DESC', limit: 10 });
      return { rehearsal: r, changes: r ? svc.rehearsalChanges(r) : [], history };
    }),
  );
  api.post(
    '/computers/:agentId/rehearsal',
    ah(async (req) => {
      const a = agentOf(req);
      return wrap(() => svc.startRehearsal(user(req).id, a, str(req.body?.note, 500)));
    }),
  );
  /** Rehearsals of all bots that work on the same folder (compare agents). */
  api.get(
    '/computers/:agentId/rehearsal/compare',
    ah(async (req) => {
      const a = agentOf(req);
      const root = path.resolve(svc.realWorkspace(a));
      const rows = ctx.store.all<any>("SELECT * FROM rehearsals WHERE user_id = ? AND status IN ('active','review')", a.user_id).filter((r) => path.resolve(r.original) === root);
      return rows.map((r) => ({ rehearsal: r, agent: ctx.store.agent(r.agent_id)?.name || '?', changes: svc.rehearsalChanges(r) }));
    }),
  );
  api.get(
    '/computers/:agentId/snapshots',
    ah(async (req) => {
      const a = agentOf(req);
      return ctx.store.find<any>('workspace_snapshots', { agent_id: a.id }, { order: 'created_at DESC', limit: 100 }).map((s) => ({ ...s, dir: undefined }));
    }),
  );
  api.post(
    '/computers/:agentId/snapshots',
    ah(async (req) => {
      const a = agentOf(req);
      const snap = await wrap(() => svc.createSnapshot(user(req).id, a, str(req.body?.label, 200) || 'Handmatige snapshot', false));
      return { ...snap, dir: undefined };
    }),
  );

  // ---------- desktop (host) helpers for the UI ----------
  api.get(
    '/computers/:agentId/desktop/windows',
    ah(async (req) => {
      const a = agentOf(req);
      const u = user(req);
      if (u.role !== 'owner') throw new HttpLike(403, 'Alleen de eigenaar');
      const cfg = svc.config(a);
      if ((await svc.caps()).caps.host.status !== 'available') throw bad('Bureaubladbediening kan op dit apparaat niet');
      const r = await wrap(() => svc.hostDriver.call('windows', {}));
      // the owner picks apps; show process names and titles (this is the owner's own desktop)
      const procs = new Map<string, string[]>();
      for (const w of r.windows || []) {
        const list = procs.get(w.process) || [];
        if (list.length < 3) list.push(String(w.title).slice(0, 80));
        procs.set(w.process, list);
      }
      return { apps: [...procs.entries()].map(([process, titles]) => ({ process, titles, allowed: cfg.host_apps.includes(process) })) };
    }),
  );
  api.get(
    '/computers/:agentId/desktop/preview/:sid',
    ah(async (req, res) => {
      const a = agentOf(req);
      const snap = desktopSnapshots.get(String(req.params.sid));
      if (!snap || snap.agentId !== a.id || !snap.preview || !fs.existsSync(snap.preview)) throw notFound('Voorbeeld niet (meer) beschikbaar');
      res.setHeader('cache-control', 'private, max-age=600');
      res.type('png').sendFile(snap.preview);
    }),
  );
  api.get(
    '/computers/:agentId/desktop/ref',
    ah(async (req) => {
      const a = agentOf(req);
      const [sid, eid] = str(req.query.ref, 40).split('.');
      const snap = desktopSnapshots.get(sid);
      if (!snap || snap.agentId !== a.id) throw notFound('Verlopen');
      const el = eid ? snap.elements.find((e) => e.ref === eid) : null;
      return { snapshotId: sid, window: snap.window, element: el ? { type: el.type, name: el.name, x: el.x, y: el.y, w: el.w, h: el.h } : null, hasPreview: !!snap.preview };
    }),
  );
}
