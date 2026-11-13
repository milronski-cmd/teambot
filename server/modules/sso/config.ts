import { randomToken, sha256 } from '../../core/util.js';

export { randomToken, sha256 };
import type { Request } from 'express';
import type { Ctx } from '../../core/types.js';
import { now } from '../../core/db.js';
import { bad } from '../../core/http.js';

/** OIDC login settings (one provider per server). The client secret lives in the secrets service, never here. */
export interface SsoConfig {
  enabled: boolean;
  issuer: string;
  clientId: string;
  label: string;
  allowedDomains: string[];
  defaultRole: 'member' | 'admin';
  autoProvision: boolean;
  requireSso: boolean;
  /** Public base URL of this TeamBot (redirect URI = <publicUrl>/api/public/sso/callback). */
  publicUrl: string;
  /** User who last set the provider fields (issuer/client); decides whether private IdP addresses are allowed. */
  providerSetBy: string | null;
  /** Bumped when provider fields change (drops cached discovery and running login attempts). */
  version: number;
  updatedAt: string | null;
}

export interface ScimSettings {
  /** What a SCIM DELETE does: block the account (default) or remove it with all its data. */
  deleteMode: 'deactivate' | 'delete';
}

export const DEFAULT_SSO: SsoConfig = {
  enabled: false,
  issuer: '',
  clientId: '',
  label: 'Inloggen met SSO',
  allowedDomains: [],
  defaultRole: 'member',
  autoProvision: false,
  requireSso: false,
  publicUrl: '',
  providerSetBy: null,
  version: 1,
  updatedAt: null,
};
export const DEFAULT_SCIM: ScimSettings = { deleteMode: 'deactivate' };

/** Secrets of the server itself (not of a person) are stored under the empty user id. */
export const SYSTEM = '';
export const CLIENT_SECRET = 'sso:client_secret';
export const CALLBACK_PATH = '/api/public/sso/callback';
export const SCIM_PATH = '/scim/v2';


function read<T>(ctx: Ctx, key: string, def: T): T {
  const r = ctx.store.one<{ value: string }>('SELECT value FROM sso_settings WHERE key = ?', key);
  if (!r) return { ...def };
  try {
    return { ...def, ...JSON.parse(r.value) };
  } catch {
    return { ...def };
  }
}
function write(ctx: Ctx, key: string, value: any) {
  ctx.store.exec(
    'INSERT INTO sso_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    key,
    JSON.stringify(value),
    now(),
  );
}

export const ssoConfig = (ctx: Ctx): SsoConfig => read(ctx, 'oidc', DEFAULT_SSO);
export const saveSsoConfig = (ctx: Ctx, c: SsoConfig) => write(ctx, 'oidc', c);
export const scimSettings = (ctx: Ctx): ScimSettings => read(ctx, 'scim', DEFAULT_SCIM);
export const saveScimSettings = (ctx: Ctx, s: ScimSettings) => write(ctx, 'scim', s);

export const hasClientSecret = (ctx: Ctx) => !!ctx.secrets.getByName(SYSTEM, CLIENT_SECRET);

/** SSO is usable for logins: server mode, switched on and a provider configured. */
export function ssoActive(ctx: Ctx, c = ssoConfig(ctx)): boolean {
  return ctx.config.mode === 'server' && c.enabled && !!c.issuer && !!c.clientId;
}

/** Normalise a base URL: http(s), no query/fragment, no trailing slash. Throws a Dutch message. */
export function normalizeBaseUrl(raw: string): string {
  const s = String(raw || '').trim();
  if (!s) return '';
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw bad('Ongeldig adres van TeamBot (bijv. https://teambot.voorbeeld.nl)');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw bad('Het adres van TeamBot moet met http:// of https:// beginnen');
  if (u.username || u.password) throw bad('Geen gebruikersnaam of wachtwoord in het adres');
  u.search = '';
  u.hash = '';
  return u.href.replace(/\/+$/, '');
}

/** Origin the request came in on (behind a trusted proxy: the forwarded protocol/host). */
export function requestOrigin(req: Request): string {
  const host = String(req.get('host') || '').trim();
  if (!/^[A-Za-z0-9.\-:[\]]{1,255}$/.test(host)) return '';
  return `${req.protocol === 'https' ? 'https' : 'http'}://${host}`;
}

/**
 * Public base URL used for the redirect URI, the SCIM endpoint and the hand-off back to the app:
 * the SSO setting, else TEAMBOT_PUBLIC_URL, else the origin of the current request.
 */
export function publicBase(ctx: Ctx, req?: Request, c = ssoConfig(ctx)): { url: string; source: 'sso' | 'env' | 'request' } {
  if (c.publicUrl) return { url: c.publicUrl, source: 'sso' };
  if (ctx.config.publicUrl) {
    try {
      return { url: normalizeBaseUrl(ctx.config.publicUrl), source: 'env' };
    } catch {
      /* fall through */
    }
  }
  return { url: req ? requestOrigin(req) : '', source: 'request' };
}

export const redirectUri = (base: string) => base + CALLBACK_PATH;

/** Clean an e-mail domain list (array or comma/space separated text). */
export function normalizeDomains(v: any): string[] {
  const list = Array.isArray(v) ? v : String(v ?? '').split(/[\s,;]+/);
  const out = new Set<string>();
  for (const raw of list) {
    const d = String(raw || '').trim().toLowerCase().replace(/^@/, '');
    if (!d) continue;
    if (!/^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d)) throw bad(`Ongeldig domein: ${d.slice(0, 80)}`);
    out.add(d);
  }
  if (out.size > 50) throw bad('Maximaal 50 domeinen');
  return [...out];
}

export function domainAllowed(c: SsoConfig, email: string): boolean {
  if (!c.allowedDomains.length) return true;
  const domain = email.split('@').pop() || '';
  return c.allowedDomains.includes(domain);
}

/** Read one cookie value from a request. */
export function cookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

