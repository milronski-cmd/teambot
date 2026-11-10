import type { Request } from 'express';
import type { Ctx, Module } from '../../core/types.js';
import { ah, bad, notFound, requireRole, str, user } from '../../core/http.js';
import { now } from '../../core/db.js';
import { setProxyResolver } from '../../tools/builtin/web.js';
import { applyProxy, currentProxy, looksLocalName, makeUpstream, parseNoProxy, parseProxyUrl, proxySupport, testProxy, upstreamFor, type UpstreamProxy } from './proxy.js';
import { agentPrivacy, engineView, exposureOf, keyStorage, outgoing } from './report.js';
import { PRIVACY_TEXT } from './privacy.js';

/**
 * Netwerk en proxy: one HTTP(S) proxy for TeamBot's outgoing traffic, set by the owner or an admin (server-wide).
 * Also "closed by default" (0.4, package P): the exposure report of the startup check (exposure.ts), the privacy label
 * per bot (privacy.ts) and the data for "Wat verlaat je pc?" (report.ts).
 *
 * Settings: global setting `network.proxy` { enabled, url, noProxy[], browser, authOwner }. The optional proxy login
 * is one encrypted secret `proxy_login` ({ username, password }) of the admin who saved it; the API only ever says
 * whether a login is stored. Changes apply at once (see proxy.ts), no restart.
 *
 * Routes (owner/admin): GET/PUT /api/admin/network/proxy, POST /api/admin/network/proxy/test,
 * GET /api/admin/network/exposure. Everyone (own bots, also on a paired phone): GET /api/privacy/agents/:id,
 * GET /api/privacy/overview.
 */

const KEY = 'network.proxy';
const SECRET = 'proxy_login';
export const DEFAULT_NO_PROXY = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '.local'];
const TEST_TARGET = 'https://example.com/';

interface Stored {
  enabled: boolean;
  url: string;
  noProxy: string[];
  browser: boolean;
  authOwner: string | null;
  updatedAt?: string;
}

let appliedBy: Ctx | null = null;
let applyError: string | null = null;

function stored(ctx: Ctx): Stored | null {
  const s = ctx.store.getSetting<any>('', KEY, null);
  if (!s || typeof s !== 'object') return null;
  return {
    enabled: !!s.enabled,
    url: typeof s.url === 'string' ? s.url : '',
    noProxy: Array.isArray(s.noProxy) ? s.noProxy.map(String) : DEFAULT_NO_PROXY,
    browser: s.browser !== false,
    authOwner: typeof s.authOwner === 'string' ? s.authOwner : null,
    updatedAt: s.updatedAt,
  };
}

function login(ctx: Ctx, s: Stored | null): { username: string; password: string } | null {
  if (!s?.authOwner) return null;
  const raw = ctx.secrets.getByName(s.authOwner, SECRET);
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    return { username: String(j.username || ''), password: String(j.password || '') };
  } catch {
    return null;
  }
}

function upstreamOf(ctx: Ctx, s: Stored): UpstreamProxy {
  const l = login(ctx, s);
  return makeUpstream({ url: s.url, noProxy: s.noProxy, browser: s.browser, username: l?.username, password: l?.password });
}

/** Apply the stored settings to this process. */
export function applyStored(ctx: Ctx) {
  const s = stored(ctx);
  applyError = null;
  if (!s?.enabled || !s.url) {
    if (appliedBy === ctx || currentProxy()) applyProxy(null);
    appliedBy = null;
    return;
  }
  try {
    const r = applyProxy(upstreamOf(ctx, s));
    if (!r.applied) applyError = r.reason || 'Niet toegepast';
    appliedBy = r.applied ? ctx : null;
  } catch (e: any) {
    applyError = String(e?.message || e);
    applyProxy(null);
    appliedBy = null;
  }
  if (applyError) ctx.log.warn(`[network] proxy niet toegepast: ${applyError}`);
}

function view(ctx: Ctx) {
  const s = stored(ctx);
  const p = currentProxy();
  return {
    configured: !!s,
    enabled: !!s?.enabled,
    url: s?.url || '',
    noProxy: s ? s.noProxy : DEFAULT_NO_PROXY,
    browser: s ? s.browser : true,
    hasAuth: !!login(ctx, s),
    updatedAt: s?.updatedAt || null,
    active: !!p && appliedBy === ctx,
    activeLabel: p && appliedBy === ctx ? p.label : null,
    applyError,
    support: proxySupport(),
    defaultNoProxy: DEFAULT_NO_PROXY,
  };
}

function noProxyFrom(v: unknown): string[] {
  const r = parseNoProxy(Array.isArray(v) ? v.map(String) : str(v, 10_000));
  if (r.invalid.length) throw bad(`Niet herkend in "Niet via de proxy": ${r.invalid.slice(0, 5).join(', ')}. Gebruik namen (intranet.bedrijf.nl), domeinen (.bedrijf.nl) of IP-bereiken (10.0.0.0/8).`);
  return r.entries;
}

/** A bot this user may talk to: their own, or one the owner shares with the team (server mode). */
function visibleAgent(ctx: Ctx, req: Request, id: string) {
  const u = user(req);
  const a = ctx.store.agent(id);
  if (!a) throw notFound('Bot niet gevonden');
  if (a.user_id !== u.id && !(ctx.config.mode === 'server' && a.settings?.shared === true)) throw notFound('Bot niet gevonden');
  return a;
}

function privacyRoutes(ctx: Ctx) {
  // A paired phone may read the labels too (read-only, no secrets in it).
  (ctx.services.mobileRoutes ||= []).push({ method: 'GET', path: '/privacy/agents/:id' }, { method: 'GET', path: '/privacy/overview' });

  ctx.api.get(
    '/privacy/agents/:id',
    ah(async (req) => {
      const a = visibleAgent(ctx, req, String(req.params.id));
      const p = agentPrivacy(ctx, a);
      // Someone else's shared bot: the label, not the owner's connection names.
      return a.user_id === user(req).id ? p : { ...p, engines: p.engines.map((e) => ({ ...e, providerId: '', provider: e.kindLabel })) };
    }),
  );

  // The bot editor: labels for engines that are not saved yet (provider the user may use + model).
  ctx.api.post(
    '/privacy/engines',
    ah(async (req) => {
      const u = user(req);
      const list = Array.isArray(req.body?.engines) ? req.body.engines.slice(0, 6) : [];
      return list.map((e: any) => {
        const cfg = ctx.providers.config(typeof e?.provider_id === 'string' ? e.provider_id : '');
        if (!cfg || !ctx.providers.canUse(u.id, cfg)) return null;
        return engineView(ctx, 'main', cfg.id, str(e?.model, 200));
      });
    }),
  );

  ctx.api.get(
    '/privacy/overview',
    ah(async (req) => {
      const u = user(req);
      const device = (req as any).session?.kind === 'device';
      const admin = u.role !== 'member' && !device;
      const bots = ctx.store.agents(u.id).map((a) => agentPrivacy(ctx, a));
      const exp = admin ? exposureOf(ctx) : null;
      return {
        levels: PRIVACY_TEXT,
        bots,
        outgoing: outgoing(ctx, u.id),
        keys: keyStorage(ctx.config.dataDir),
        mode: ctx.config.mode,
        dataDir: admin ? ctx.config.dataDir : null,
        exposure: exp,
      };
    }),
  );

  ctx.api.get(
    '/admin/network/exposure',
    ah(async (req) => {
      requireRole(req, 'admin');
      const exp = exposureOf(ctx);
      return exp;
    }),
  );
}

const mod: Module = {
  id: 'network',
  label: 'Netwerk en proxy',
  init(ctx) {
    // web_fetch & co.: behind a proxy a public-looking name that local DNS cannot resolve is left to the proxy.
    setProxyResolver((u) => !!upstreamFor(u) && !looksLocalName(u.hostname));
    privacyRoutes(ctx);

    ctx.api.get(
      '/admin/network/proxy',
      ah(async (req) => {
        requireRole(req, 'admin');
        return view(ctx);
      }),
    );

    ctx.api.put(
      '/admin/network/proxy',
      ah(async (req) => {
        const me = requireRole(req, 'admin');
        const b = req.body || {};
        const prev = stored(ctx);
        const enabled = b.enabled === undefined ? !!prev?.enabled : !!b.enabled;
        const rawUrl = b.url === undefined ? prev?.url || '' : str(b.url, 500).trim();
        let url = '';
        if (rawUrl || enabled) {
          try {
            url = parseProxyUrl(rawUrl).href.replace(/\/$/, '');
          } catch (e: any) {
            throw bad(e.message);
          }
        }
        const noProxy = b.noProxy === undefined ? prev?.noProxy || DEFAULT_NO_PROXY : noProxyFrom(b.noProxy);
        const browser = b.browser === undefined ? prev?.browser !== false : !!b.browser;
        let authOwner = prev?.authOwner || null;
        if (b.clearAuth) {
          if (authOwner) {
            const row = ctx.store.one<{ id: string }>('SELECT id FROM secrets WHERE user_id = ? AND name = ?', authOwner, SECRET);
            if (row) ctx.secrets.delete(row.id);
          }
          authOwner = null;
        } else {
          const username = str(b.username, 300);
          const password = str(b.password, 1000);
          if (username || password) {
            const old = login(ctx, prev);
            const next = { username: username || old?.username || '', password: password || old?.password || '' };
            if (prev?.authOwner && prev.authOwner !== me.id) {
              const row = ctx.store.one<{ id: string }>('SELECT id FROM secrets WHERE user_id = ? AND name = ?', prev.authOwner, SECRET);
              if (row) ctx.secrets.delete(row.id);
            }
            ctx.secrets.set(me.id, SECRET, JSON.stringify(next));
            authOwner = me.id;
          }
        }
        const s: Stored = { enabled, url, noProxy, browser, authOwner, updatedAt: now() };
        ctx.store.setSetting('', KEY, s);
        applyStored(ctx);
        const v = view(ctx);
        ctx.audit(me.id, 'network.proxy.update', { enabled, proxy: url ? new URL(url).host : null, noProxy: noProxy.length, browser, login: v.hasAuth, applied: v.active });
        ctx.events.emit(me.id, 'network.proxy.updated', v);
        return v;
      }),
    );

    ctx.api.post(
      '/admin/network/proxy/test',
      ah(async (req) => {
        const me = requireRole(req, 'admin');
        const b = req.body || {};
        const prev = stored(ctx);
        let p: UpstreamProxy;
        try {
          const url = str(b.url, 500).trim() || prev?.url || '';
          const saved = login(ctx, prev);
          const username = str(b.username, 300) || saved?.username || '';
          const password = str(b.password, 1000) || saved?.password || '';
          p = makeUpstream({ url, noProxy: [], browser: true, username, password });
        } catch (e: any) {
          throw bad(e.message);
        }
        const target = str(b.target, 1000).trim() || TEST_TARGET;
        const r = await testProxy(p, /^[a-z]+:\/\//i.test(target) ? target : 'https://' + target);
        let host = '';
        try {
          host = new URL(/^[a-z]+:\/\//i.test(target) ? target : 'https://' + target).host;
        } catch {
          host = '';
        }
        ctx.audit(me.id, 'network.proxy.test', { ok: r.ok, proxy: p.label, target: host, status: r.status ?? null });
        return { ...r, proxy: p.label, target: host };
      }),
    );
  },
  start(ctx) {
    applyStored(ctx);
  },
  stop(ctx) {
    if (appliedBy === ctx) {
      applyProxy(null);
      appliedBy = null;
    }
  },
};

export default mod;
