import type { Ctx, Module } from '../../core/types.js';
import { ah, requireRole, user } from '../../core/http.js';
import { isRestricted } from '../../api/member-policy.js';
import { type OpenBotPaths, defaultOpenBotPaths, detectOpenBot } from './reader.js';
import { type Detector, OpenBotImport } from './service.js';
import { defaultHermesHome } from './hermes.js';
import { HermesImport } from './hermes-service.js';
import { openClawRoutes } from './openclaw.js';
import type { OpenClawPaths } from './openclaw-reader.js';

/**
 * "Importeer je OpenBot-team": reads the owner's own OpenBot data on this computer (read-only, no secrets) and
 * turns it into one TeamBot team (the shared folder as team folder, the team tables), the boss as main bot or team
 * lead, a knowledge bot as specialist, skills, memories and routines that start switched off. Preview first (writes
 * nothing), one import, and undo. Only the owner of a desktop/self-host installation can use it (it reads local
 * folders). See docs/modules/openbot-import.md.
 *
 * The same screen imports from Hermes Agent (`/openbot-import/hermes/...`, hermes-service.ts): its profiles as bots,
 * skills, memories and scheduled jobs (as routines that start switched off), with its own undo. And from OpenClaw
 * (`/openbot-import/openclaw/...`, openclaw.ts), with the same preview/undo pattern.
 */
export interface OpenBotImportOptions {
  paths?: () => OpenBotPaths;
  /** Engine detection (tests inject a fake; default = the provider kind's own detect()). */
  detect?: (ctx: Ctx) => Detector;
  /** Hermes Agent's data folder (tests point it at a fixture; default HERMES_HOME or ~/.hermes). */
  hermesHome?: () => string;
  /** Where OpenClaw lives (tests point it at a fixture; default ~/.openclaw). */
  openclawPaths?: () => OpenClawPaths;
}

const defaultDetect = (ctx: Ctx): Detector => async (kindId) => {
  const k = ctx.providers.kind(kindId);
  if (!k?.detect) return null;
  return Promise.race([k.detect(ctx), new Promise<null>((r) => setTimeout(() => r(null), 8000))]);
};

export function createOpenBotImportModule(opts: OpenBotImportOptions = {}): Module {
  return {
    id: 'openbot-import',
    label: 'Overstappen uit OpenBot',
    init(ctx) {
      const paths = opts.paths || (() => defaultOpenBotPaths());
      const detector = (opts.detect || defaultDetect)(ctx);
      const svc = new OpenBotImport(ctx, paths, detector);
      ctx.services.openbotImport = svc;
      const hermes = new HermesImport(ctx, opts.hermesHome || (() => defaultHermesHome()), detector);
      const api = ctx.api;
      // Overstappen uit OpenClaw (0.4.4): its own files (openclaw.ts, openclaw-reader.ts), same preview/undo pattern.
      openClawRoutes(ctx, opts.openclawPaths);

      /** Cheap check for the first-run screen: is there an OpenBot installation, and was it imported already? */
      api.get(
        '/openbot-import/detect',
        ah(async (req) => {
          const u = user(req);
          const state = ctx.store.getSetting<any>(u.id, 'openbotImport', {}) || {};
          if (u.role !== 'owner' || isRestricted(ctx, u)) return { available: false, found: false };
          const d = detectOpenBot(paths());
          return { available: true, ...d, imported: state.last ? { at: state.last.at, counts: state.last.counts, undone: state.last.undone || null } : null, undoable: svc.undoAvailable(u.id), dismissed: !!state.dismissed };
        }),
      );

      api.post(
        '/openbot-import/dismiss',
        ah(async (req) => {
          const u = user(req);
          const state = ctx.store.getSetting<any>(u.id, 'openbotImport', {}) || {};
          ctx.store.setSetting(u.id, 'openbotImport', { ...state, dismissed: req.body?.dismissed !== false });
          return { ok: true };
        }),
      );

      api.post(
        '/openbot-import/preview',
        ah(async (req) => {
          const u = requireRole(req, 'owner');
          return svc.preview(u.id);
        }),
      );

      api.post(
        '/openbot-import/commit',
        ah(async (req) => {
          const u = requireRole(req, 'owner');
          return svc.commit(u.id, req.body || {});
        }),
      );

      api.get(
        '/openbot-import/last',
        ah(async (req) => {
          const u = user(req);
          const last = (ctx.store.getSetting<any>(u.id, 'openbotImport', {}) || {}).last || null;
          return last ? { ...last, undo: svc.undoAvailable(u.id) } : null;
        }),
      );

      /** "Overstappen" step by step: status per step (back-ups, import, side by side, channels, routines, back). */
      api.get(
        '/openbot-import/cutover',
        ah(async (req) => {
          const u = requireRole(req, 'owner');
          return svc.cutover(u.id);
        }),
      );

      /** Look at what runs in OpenBot now (reads a private copy; OpenBot is never changed). */
      api.post(
        '/openbot-import/cutover/check',
        ah(async (req) => {
          const u = requireRole(req, 'owner');
          svc.checkOpenBot(u.id);
          return svc.cutover(u.id);
        }),
      );

      /** The owner ticks off what TeamBot cannot see: `{ step: 'backup' | 'check', done }`. */
      api.post(
        '/openbot-import/cutover/mark',
        ah(async (req) => {
          const u = requireRole(req, 'owner');
          return svc.markStep(u.id, String(req.body?.step || ''), req.body?.done !== false);
        }),
      );

      /** Switch on the imported routines that were on in OpenBot (never customer routines; not while OpenBot still runs them). */
      api.post(
        '/openbot-import/cutover/routines',
        ah(async (req) => {
          const u = requireRole(req, 'owner');
          return svc.resumeRoutines(u.id);
        }),
      );

      /** "Import ongedaan maken": what would be removed (nothing changes), then removing it. */
      api.get(
        '/openbot-import/undo',
        ah(async (req) => {
          const u = requireRole(req, 'owner');
          return svc.undoPlan(u.id);
        }),
      );

      api.post(
        '/openbot-import/undo',
        ah(async (req) => {
          const u = requireRole(req, 'owner');
          return svc.undo(u.id);
        }),
      );

      // ---- Hermes Agent ----
      api.get(
        '/openbot-import/hermes/detect',
        ah(async (req) => {
          const u = user(req);
          if (u.role !== 'owner' || isRestricted(ctx, u)) return { available: false, found: false };
          return { available: true, ...hermes.detect(u.id) };
        }),
      );
      api.post(
        '/openbot-import/hermes/preview',
        ah(async (req) => hermes.preview(requireRole(req, 'owner').id, req.body || {})),
      );
      api.post(
        '/openbot-import/hermes/commit',
        ah(async (req) => hermes.commit(requireRole(req, 'owner').id, req.body || {})),
      );
      api.get(
        '/openbot-import/hermes/undo',
        ah(async (req) => hermes.undoPlan(requireRole(req, 'owner').id)),
      );
      api.post(
        '/openbot-import/hermes/undo',
        ah(async (req) => hermes.undo(requireRole(req, 'owner').id)),
      );
    },
  };
}

const mod: Module = createOpenBotImportModule();
export default mod;
