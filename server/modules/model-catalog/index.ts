import type { Module } from '../../core/types.js';
import { ah, bad, requireRole, user } from '../../core/http.js';
import { catalogAgeDays, catalogStatus, loadCachedCatalog, refreshCatalog } from '../../providers/models-dev.js';

/**
 * Modelgegevens (0.4.4): the models.dev catalogue behind context windows, prices and capabilities of models
 * (server/providers/models-dev.ts). A dated snapshot ships with TeamBot; this module takes a newer refreshed copy from
 * the data folder at start (in the background, never blocking) and, only when the owner turned on
 * `modelCatalog.refresh` (whatever leaves the pc stays off until then, PROVIDER_POLICY rule 8), downloads it again
 * once a day. Offline nothing changes: the snapshot or the last copy stays in use. See docs/modules/model-catalog.md.
 *
 * Routes: GET /api/model-catalog (everyone: date, source, counts, whether the refresh is on),
 * PUT /api/model-catalog { refresh } and POST /api/model-catalog/refresh (owner/admin).
 */

const KEY = 'modelCatalog.refresh';
const HOUR = 3_600_000;

let timer: NodeJS.Timeout | null = null;
let first: NodeJS.Timeout | null = null;
let busy = false;
let lastTry = 0;
let tick: () => void = () => {};

const mod: Module = {
  id: 'model-catalog',
  label: 'Modelgegevens',
  init(ctx) {
    const on = () => ctx.store.getSetting<boolean>('', KEY, false) === true;
    const view = (req: any) => {
      const u = user(req);
      return { ...catalogStatus(), refresh: on(), canEdit: u.role === 'owner' || u.role === 'admin' };
    };
    const refresh = async () => {
      if (busy) return;
      busy = true;
      lastTry = Date.now();
      try {
        const r = await refreshCatalog(ctx.config.dataDir);
        if (!r.ok) ctx.log.warn(`[model-catalog] models.dev niet bijgewerkt: ${r.error}`);
      } finally {
        busy = false;
      }
    };
    ctx.services.modelCatalog = { refresh, status: catalogStatus };

    ctx.api.get('/model-catalog', ah(async (req) => view(req)));
    ctx.api.put(
      '/model-catalog',
      ah(async (req) => {
        const me = requireRole(req, 'admin');
        if (typeof req.body?.refresh !== 'boolean') throw bad('Geef refresh: true of false');
        ctx.store.setSetting('', KEY, req.body.refresh);
        ctx.audit(me.id, 'model_catalog.refresh_setting', { on: req.body.refresh });
        // Just turned on and the data is older than a day: fetch it now, in the background.
        if (req.body.refresh && catalogAgeDays() >= 1) void refresh();
        return view(req);
      }),
    );
    ctx.api.post(
      '/model-catalog/refresh',
      ah(async (req) => {
        const me = requireRole(req, 'admin');
        await refresh();
        ctx.audit(me.id, 'model_catalog.refresh', { fetched: catalogStatus().fetched, error: catalogStatus().error });
        return view(req);
      }),
    );

    tick = () => {
      if (on() && !busy && catalogAgeDays() >= 1 && Date.now() - lastTry > 6 * HOUR) void refresh();
    };
  },
  start(ctx) {
    void loadCachedCatalog(ctx.config.dataDir);

    first = setTimeout(() => tick(), 60_000);
    first.unref?.();
    timer = setInterval(() => tick(), HOUR);
    timer.unref?.();
  },
  stop() {
    if (first) clearTimeout(first);
    if (timer) clearInterval(timer);
    first = timer = null;
  },
};

export default mod;
