import type { Request, Response } from 'express';
import type * as oidc from 'openid-client';
import type { Ctx, User } from '../../core/types.js';
import { newId, now } from '../../core/db.js';
import { HttpError, ah, bad, forbidden, requireRole, str } from '../../core/http.js';
import {
  CLIENT_SECRET,
  DEFAULT_SSO,
  Limiter,
  SCIM_PATH,
  SYSTEM,
  cookie,
  domainAllowed,
  hasClientSecret,
  normalizeBaseUrl,
  normalizeDomains,
  publicBase,
  randomToken,
  redirectUri,
  requestOrigin,
  saveScimSettings,
  saveSsoConfig,
  scimSettings,
  sha256,
  ssoActive,
  ssoConfig,
  type SsoConfig,
} from './config.js';
import { OidcService, SsoRefusal, describeError } from './oidc.js';

const COOKIE = 'tb_sso';
const looksEmail = (s: string) => /^[^@\s]{1,64}@[^@\s]{1,255}$/.test(s);
/**
 * Entra ID leaves out the `email` claim for accounts without a mailbox; there `preferred_username` is the UPN, which
 * only the tenant admin can set. Other providers may let people choose that claim, so it is never used for them.
 */
const MICROSOFT_ISSUERS = new Set(['login.microsoftonline.com', 'login.microsoftonline.us', 'login.partner.microsoftonline.cn']);
const upnFallback = (issuer: string) => {
  try {
    return MICROSOFT_ISSUERS.has(new URL(issuer).hostname);
  } catch {
    return false;
  }
};

export function ssoRoutes(ctx: Ctx, svc: OidcService) {
  const startLimit = new Limiter(30, 60_000);
  const callbackLimit = new Limiter(30, 60_000);
  const exchangeFails = new Limiter(10, 60_000);
  const testLimit = new Limiter(20, 60_000);

  const ua = (req: Request) => String(req.headers['user-agent'] || '').slice(0, 80);
  const cookieAttrs = (base: string) => {
    let p = '/api/public/sso';
    let secure = false;
    try {
      const u = new URL(base);
      p = u.pathname.replace(/\/+$/, '') + '/api/public/sso';
      secure = u.protocol === 'https:';
    } catch {
      /* default path */
    }
    return `Path=${p}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  };
  const clearCookie = (res: Response, base: string) => res.append('Set-Cookie', `${COOKIE}=; Max-Age=0; ${cookieAttrs(base)}`);
  /** Back to the app with a reason code only (the UI shows the Dutch text; nothing user-controlled in the URL). */
  const fail = (res: Response, base: string, reason: string) => {
    clearCookie(res, base);
    res.redirect(302, `${base}/#/?sso_error=${encodeURIComponent(reason)}`);
  };

  /** Find, link or create the TeamBot account for validated ID-token claims. */
  const resolveUser = (c: SsoConfig, claims: oidc.IDToken): User => {
    const issuer = String(claims.iss);
    const subject = String(claims.sub);
    const raw: any = claims;
    const rawEmail =
      typeof raw.email === 'string' ? raw.email : upnFallback(issuer) && typeof raw.preferred_username === 'string' && raw.preferred_username.includes('@') ? raw.preferred_username : '';
    const email = rawEmail.trim().toLowerCase();
    if (raw.email_verified === false || String(raw.email_verified).toLowerCase() === 'false') throw new SsoRefusal('unverified', 'E-mailadres niet bevestigd bij de provider', { email });
    if (!email || !looksEmail(email)) throw new SsoRefusal('noemail', 'De provider gaf geen e-mailadres door', { issuer });
    if (!domainAllowed(c, email)) throw new SsoRefusal('domain', 'E-maildomein niet toegestaan', { email });
    const link = ctx.store.one<{ id: string; user_id: string }>('SELECT id, user_id FROM sso_identities WHERE issuer = ? AND subject = ?', issuer, subject);
    let u = link ? ctx.store.user(link.user_id) : null;
    if (!u) {
      const row = ctx.store.one<{ id: string }>('SELECT id FROM users WHERE email = ?', email);
      if (row) {
        u = ctx.store.user(row.id)!;
        ctx.store.insert('sso_identities', { id: newId('sso_'), user_id: u.id, issuer, subject, email, created_at: now() });
        ctx.audit(u.id, 'sso.linked', { email, issuer });
      } else if (c.autoProvision) {
        const name = str(raw.name || [raw.given_name, raw.family_name].filter(Boolean).join(' ') || email.split('@')[0], 100);
        try {
          u = ctx.auth.createUser({ email, name, role: c.defaultRole === 'admin' ? 'admin' : 'member' });
        } catch (e: any) {
          if (e instanceof HttpError && e.code === 'seat_limit') throw new SsoRefusal('seats', 'Geen plaats meer (maximum aantal gebruikers)', { email });
          throw e;
        }
        ctx.store.insert('sso_identities', { id: newId('sso_'), user_id: u.id, issuer, subject, email, created_at: now() });
        ctx.audit(u.id, 'sso.provisioned', { email, issuer, role: u.role });
      } else throw new SsoRefusal('unknown', 'Geen account voor dit e-mailadres (automatisch aanmaken staat uit)', { email });
    }
    if (u.disabled) throw new SsoRefusal('disabled', 'Account geblokkeerd', { email, userId: u.id });
    ctx.store.exec('UPDATE sso_identities SET last_login_at = ?, email = ? WHERE issuer = ? AND subject = ?', now(), email, issuer, subject);
    return u;
  };

  // ---------------- public: login flow ----------------
  ctx.publicApi.get(
    '/sso',
    ah(async () => {
      const c = ssoConfig(ctx);
      const on = ssoActive(ctx, c);
      return { enabled: on, label: on ? c.label : '', requireSso: on && c.requireSso };
    }),
  );

  ctx.publicApi.get(
    '/sso/start',
    ah(async (req, res) => {
      const c = ssoConfig(ctx);
      const base = publicBase(ctx, req, c).url;
      if (!startLimit.hit(req.ip || '')) return fail(res, base, 'rate');
      if (!ssoActive(ctx, c) || !base) return fail(res, base, 'config');
      // The browser-binding cookie must be set on the host the provider sends the user back to.
      const origin = requestOrigin(req);
      if (origin && new URL(base).origin !== origin && req.query.c !== '1') return res.redirect(302, `${base}/api/public/sso/start?c=1`);
      try {
        const { url, binding } = await svc.start(c, redirectUri(base));
        res.append('Set-Cookie', `${COOKIE}=${binding}; Max-Age=600; ${cookieAttrs(base)}`);
        res.setHeader('Cache-Control', 'no-store');
        res.redirect(302, url);
      } catch (e: any) {
        ctx.log.warn('[sso] start mislukt:', describeError(e));
        ctx.audit(null, 'sso.refused', { reason: 'provider', step: 'start', error: describeError(e), ip: req.ip });
        fail(res, base, 'provider');
      }
    }),
  );

  ctx.publicApi.get(
    '/sso/callback',
    ah(async (req, res) => {
      const c = ssoConfig(ctx);
      const base = publicBase(ctx, req, c).url;
      res.setHeader('Cache-Control', 'no-store');
      if (!callbackLimit.hit(req.ip || '')) return fail(res, base, 'rate');
      if (!ssoActive(ctx, c)) return fail(res, base, 'config');
      const params = new URL(req.originalUrl, 'http://x').searchParams;
      const binding = cookie(req, COOKIE);
      try {
        const claims = await svc.callback(c, params, binding);
        const u = resolveUser(c, claims);
        const code = svc.handoff(u.id, binding!);
        res.redirect(302, `${base}/#/?sso=${code}`);
      } catch (e: any) {
        if (e instanceof SsoRefusal) {
          const { userId, ...detail } = e.detail;
          ctx.audit(userId ?? null, 'sso.refused', { reason: e.reason, message: e.message, ...detail, ip: req.ip });
          return fail(res, base, e.reason);
        }
        ctx.log.error('[sso] callback mislukt:', describeError(e));
        ctx.audit(null, 'sso.refused', { reason: 'error', error: describeError(e), ip: req.ip });
        fail(res, base, 'provider');
      }
    }),
  );

  ctx.publicApi.post(
    '/sso/exchange',
    ah(async (req, res) => {
      const ip = req.ip || '';
      const base = publicBase(ctx, req).url;
      if (exchangeFails.blocked(ip)) throw new HttpError(429, 'Te veel pogingen, probeer het over een minuut opnieuw');
      const userId = svc.redeem(str(req.body?.code, 200), cookie(req, COOKIE));
      clearCookie(res, base);
      const u = userId ? ctx.store.user(userId) : null;
      if (!u || !ssoActive(ctx)) {
        exchangeFails.hit(ip);
        ctx.audit(null, 'sso.refused', { reason: 'handoff', ip });
        throw new HttpError(401, 'Deze inlogpoging is verlopen of al gebruikt. Log opnieuw in.');
      }
      if (u.disabled) {
        ctx.audit(u.id, 'sso.refused', { reason: 'disabled', ip });
        throw new HttpError(403, 'Dit account is geblokkeerd.');
      }
      const s = ctx.auth.createSession(u.id, 'web', ua(req));
      ctx.audit(u.id, 'sso.login', { email: u.email, session: s.id, ip });
      return { token: s.token, user: u };
    }),
  );

  // ---------------- admin: settings ----------------
  const serverOnly = () => {
    if (ctx.config.mode !== 'server') throw bad('SSO en SCIM zijn alleen beschikbaar als TeamBot als server draait.');
  };

  const view = (req: Request, me: User) => {
    const c = ssoConfig(ctx);
    const b = publicBase(ctx, req, c);
    return {
      enabled: c.enabled,
      active: ssoActive(ctx, c),
      issuer: c.issuer,
      clientId: c.clientId,
      hasClientSecret: hasClientSecret(ctx),
      label: c.label,
      allowedDomains: c.allowedDomains,
      defaultRole: c.defaultRole,
      autoProvision: c.autoProvision,
      requireSso: c.requireSso,
      publicUrl: c.publicUrl,
      publicBase: b.url,
      publicBaseSource: b.source,
      redirectUri: b.url ? redirectUri(b.url) : '',
      scopes: 'openid email profile',
      canEditProvider: me.role === 'owner',
      updatedAt: c.updatedAt,
    };
  };

  ctx.api.get(
    '/admin/sso',
    ah(async (req) => {
      const me = requireRole(req, 'admin');
      serverOnly();
      return view(req, me);
    }),
  );

  ctx.api.put(
    '/admin/sso',
    ah(async (req) => {
      const me = requireRole(req, 'admin');
      serverOnly();
      const b = req.body || {};
      const cur = ssoConfig(ctx);
      const next: SsoConfig = { ...cur, allowedDomains: [...cur.allowedDomains] };
      const provider: string[] = [];
      if (b.issuer !== undefined) {
        const v = str(b.issuer, 500).trim();
        if (v && !/^https?:\/\/[^\s]+$/i.test(v)) throw bad('De issuer-URL moet met https:// beginnen');
        if (v !== cur.issuer) provider.push('issuer');
        next.issuer = v;
      }
      if (b.clientId !== undefined) {
        const v = str(b.clientId, 300).trim();
        if (v !== cur.clientId) provider.push('clientId');
        next.clientId = v;
      }
      if (b.publicUrl !== undefined) {
        const v = normalizeBaseUrl(str(b.publicUrl, 500));
        if (v !== cur.publicUrl) provider.push('publicUrl');
        next.publicUrl = v;
      }
      const secret = typeof b.clientSecret === 'string' ? b.clientSecret.trim().slice(0, 2000) : '';
      if (secret || b.clearClientSecret) provider.push('clientSecret');
      if (provider.length && me.role !== 'owner') throw forbidden('Alleen de eigenaar kan de identiteitsprovider instellen (issuer, client-ID, clientgeheim en adres van TeamBot).');
      if (b.label !== undefined) next.label = str(b.label, 60).trim() || DEFAULT_SSO.label;
      if (b.allowedDomains !== undefined) next.allowedDomains = normalizeDomains(b.allowedDomains);
      if (b.defaultRole !== undefined) {
        if (!['member', 'admin'].includes(b.defaultRole)) throw bad('Ongeldige rol');
        if (b.defaultRole === 'admin' && cur.defaultRole !== 'admin' && me.role !== 'owner') throw forbidden('Alleen de eigenaar kan nieuwe SSO-gebruikers automatisch beheerder maken.');
        next.defaultRole = b.defaultRole;
      }
      if (b.autoProvision !== undefined) next.autoProvision = !!b.autoProvision;
      if (b.requireSso !== undefined) next.requireSso = !!b.requireSso;
      if (b.enabled !== undefined) next.enabled = !!b.enabled;
      if (next.enabled && (!next.issuer || !next.clientId)) throw bad('Vul eerst de issuer-URL en de client-ID in.');
      if (next.autoProvision && !next.allowedDomains.length) throw bad('Automatisch accounts aanmaken kan alleen met minstens één toegestaan e-maildomein.');
      if (next.requireSso && !next.enabled) throw bad('SSO verplichten kan alleen als inloggen met SSO aan staat.');
      // A stable redirect URI: without TEAMBOT_PUBLIC_URL the owner's current address is remembered.
      if (next.enabled && !next.publicUrl && !ctx.config.publicUrl) {
        if (me.role !== 'owner') throw bad('De eigenaar moet eerst het adres van TeamBot instellen.');
        next.publicUrl = normalizeBaseUrl(requestOrigin(req));
        provider.push('publicUrl');
      }
      if (secret) ctx.secrets.set(SYSTEM, CLIENT_SECRET, secret);
      else if (b.clearClientSecret) {
        const row = ctx.secrets.list(SYSTEM).find((s) => s.name === CLIENT_SECRET);
        if (row) ctx.secrets.delete(row.id);
      }
      if (provider.length) {
        next.version = cur.version + 1;
        next.providerSetBy = me.id;
        svc.dropCache();
      }
      next.updatedAt = now();
      saveSsoConfig(ctx, next);
      ctx.audit(me.id, 'sso.config', {
        providerChanged: [...new Set(provider)],
        enabled: next.enabled,
        issuer: next.issuer,
        clientId: next.clientId,
        hasClientSecret: hasClientSecret(ctx),
        allowedDomains: next.allowedDomains,
        defaultRole: next.defaultRole,
        autoProvision: next.autoProvision,
        requireSso: next.requireSso,
      });
      return view(req, me);
    }),
  );

  ctx.api.post(
    '/admin/sso/test',
    ah(async (req) => {
      const me = requireRole(req, 'admin');
      serverOnly();
      if (!testLimit.hit(me.id)) throw new HttpError(429, 'Even wachten: te veel tests achter elkaar.');
      const c = ssoConfig(ctx);
      const issuer = str(req.body?.issuer ?? c.issuer, 500).trim();
      if (!issuer) throw bad('Vul een issuer-URL in.');
      try {
        // Owner/admin may point at a local IdP (private address); the SSRF guard still checks every hop.
        const config = await svc.discover(issuer, c.clientId, null, true);
        const m = config.serverMetadata();
        return {
          ok: true,
          issuer: m.issuer,
          authorization_endpoint: m.authorization_endpoint,
          token_endpoint: m.token_endpoint,
          jwks_uri: m.jwks_uri,
          userinfo_endpoint: m.userinfo_endpoint || null,
          end_session_endpoint: (m as any).end_session_endpoint || null,
          scopes_supported: Array.isArray(m.scopes_supported) ? m.scopes_supported.slice(0, 30) : null,
          code_challenge_methods_supported: m.code_challenge_methods_supported || null,
        };
      } catch (e: any) {
        return { ok: false, error: describeError(e) };
      }
    }),
  );

  ctx.api.get(
    '/admin/sso/events',
    ah(async (req) => {
      requireRole(req, 'admin');
      serverOnly();
      const rows = ctx.store.all<any>(
        "SELECT a.id, a.user_id, a.kind, a.data, a.created_at, u.email AS user_email, u.name AS user_name FROM audit a LEFT JOIN users u ON u.id = a.user_id WHERE a.kind LIKE 'sso.%' OR a.kind LIKE 'scim.%' ORDER BY a.id DESC LIMIT 50",
      );
      return rows.map((r) => ({ ...r, data: JSON.parse(r.data || '{}') }));
    }),
  );

  // ---------------- admin: SCIM ----------------
  const scimView = (req: Request, me: User) => {
    const t = ctx.store.one<any>(
      'SELECT t.id, t.created_at, t.last_used_at, u.name AS created_by_name FROM scim_tokens t LEFT JOIN users u ON u.id = t.created_by WHERE t.revoked_at IS NULL ORDER BY t.created_at DESC LIMIT 1',
    );
    const b = publicBase(ctx, req);
    return {
      endpoint: b.url ? b.url + SCIM_PATH : '',
      publicBaseSource: b.source,
      token: t ? { created_at: t.created_at, last_used_at: t.last_used_at, created_by: t.created_by_name || null } : null,
      deleteMode: scimSettings(ctx).deleteMode,
      canEdit: me.role === 'owner',
    };
  };
  const ownerOnly = (req: Request) => {
    const me = requireRole(req, 'admin');
    serverOnly();
    if (me.role !== 'owner') throw forbidden('Alleen de eigenaar beheert de SCIM-koppeling.');
    return me;
  };

  ctx.api.get(
    '/admin/scim',
    ah(async (req) => {
      const me = requireRole(req, 'admin');
      serverOnly();
      return scimView(req, me);
    }),
  );
  ctx.api.put(
    '/admin/scim',
    ah(async (req) => {
      const me = ownerOnly(req);
      const mode = req.body?.deleteMode;
      if (!['deactivate', 'delete'].includes(mode)) throw bad('Kies blokkeren of verwijderen');
      saveScimSettings(ctx, { ...scimSettings(ctx), deleteMode: mode });
      ctx.audit(me.id, 'scim.config', { deleteMode: mode });
      return scimView(req, me);
    }),
  );
  ctx.api.post(
    '/admin/scim/token',
    ah(async (req) => {
      const me = ownerOnly(req);
      const token = 'tbscim_' + randomToken(32);
      ctx.store.tx(() => {
        ctx.store.exec('UPDATE scim_tokens SET revoked_at = ? WHERE revoked_at IS NULL', now());
        ctx.store.exec('INSERT INTO scim_tokens (id, token_hash, created_by, created_at) VALUES (?, ?, ?, ?)', newId('scim_'), sha256(token), me.id, now());
      });
      ctx.audit(me.id, 'scim.token.created', {});
      // Shown once; only the hash is stored.
      return { ...scimView(req, me), newToken: token };
    }),
  );
  ctx.api.delete(
    '/admin/scim/token',
    ah(async (req) => {
      const me = ownerOnly(req);
      ctx.store.exec('UPDATE scim_tokens SET revoked_at = ? WHERE revoked_at IS NULL', now());
      ctx.audit(me.id, 'scim.token.revoked', {});
      return scimView(req, me);
    }),
  );
}

/**
 * Password logins and signups while SSO is on. "Require SSO": only the owner keeps a password (break-glass).
 * Always: nobody signs up with a password for an address in an SSO domain — SSO links accounts by e-mail, so such a
 * signup could claim a colleague's account before their first SSO login.
 */
export function requireSsoPolicy(ctx: Ctx) {
  return (account: { id: string | null; role: string; email: string | null } | null, how: 'login' | 'signup') => {
    const c = ssoConfig(ctx);
    if (!ssoActive(ctx, c)) return;
    if (how === 'login') {
      if (!c.requireSso || account?.role === 'owner') return;
      throw new HttpError(403, 'Op deze server log je in met SSO. Alleen de eigenaar kan nog met een wachtwoord inloggen.', 'sso_required');
    }
    if (c.requireSso) throw new HttpError(403, 'Op deze server maak je geen account met een wachtwoord. Log in met SSO.', 'sso_required');
    if (account?.email && domainAllowed(c, account.email)) throw new HttpError(403, `Voor dit e-mailadres log je in met “${c.label}”.`, 'sso_required');
  };
}

/** While SSO is on, people can't give themselves an address that SSO would link (only the owner changes freely). */
export function ssoEmailPolicy(ctx: Ctx) {
  return (req: Request, _res: Response, who: { user: User }) => {
    if (req.method !== 'PATCH' || req.path !== '/me' || who.user.role === 'owner' || req.body?.email === undefined) return;
    const c = ssoConfig(ctx);
    if (!ssoActive(ctx, c)) return;
    const next = str(req.body.email, 200).trim().toLowerCase();
    if (next === (who.user.email || '')) return;
    if (!next || domainAllowed(c, next)) throw new HttpError(403, 'Je e-mailadres hoort bij inloggen met SSO en kun je hier niet wijzigen. Vraag de beheerder.', 'sso_managed');
  };
}
