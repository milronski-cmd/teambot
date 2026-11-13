import type { Ctx, ProviderConfig, User } from '../../core/types.js';
import { HttpError } from '../../core/http.js';
import { assertPublicUrl } from '../../tools/builtin/web.js';
import { PLACE } from '../../../shared/places.js';

export interface Endpoint {
  cfg: ProviderConfig;
  kind: string;
  /** Provider name shown to the user ("who receives the audio"). */
  label: string;
  baseUrl: string;
  /** Never leaves the server. */
  key: string | null;
}

export const NO_OPENAI =
  `Hiervoor is een OpenAI API-sleutel nodig (plak hem bij ${PLACE.ai}). Gratis alternatieven: browserstem voor voorlezen en een eigen (lokale) OpenAI-compatibele spraakserver voor spraakherkenning.`;

/** API providers (not CLI agents) this user may use: own + shared by an admin. */
export function apiProviders(ctx: Ctx, userId: string): ProviderConfig[] {
  return ctx.providers
    .list(userId)
    .filter((p) => p.enabled && ctx.providers.kind(p.kind)?.type === 'api' && p.kind !== 'mock')
    .sort((a, b) => Number(b.user_id === userId) - Number(a.user_id === userId));
}

export function providerSummary(ctx: Ctx, userId: string) {
  return apiProviders(ctx, userId).map((p) => ({ id: p.id, name: p.name, kind: p.kind, kindLabel: ctx.providers.kind(p.kind)?.label || p.kind, own: p.user_id === userId, hasKey: !!p.secret_id }));
}

/**
 * Resolve the endpoint for a voice feature. With an explicit id the provider must be usable by the user (no silent
 * switch to another provider: the user chose who receives the audio); without one the first OpenAI provider is used
 * (own before shared). Returns null when nothing suitable exists.
 */
export function resolveEndpoint(ctx: Ctx, userId: string, id: string | null | undefined, opts: { openaiOnly?: boolean } = {}): Endpoint | null {
  let cfg: ProviderConfig | null = null;
  if (id) {
    const c = ctx.providers.config(id);
    if (c && ctx.providers.canUse(userId, c) && c.enabled && ctx.providers.kind(c.kind)?.type === 'api') cfg = c;
    if (cfg && opts.openaiOnly && cfg.kind !== 'openai') cfg = null;
    if (!cfg) return null;
  } else cfg = apiProviders(ctx, userId).find((p) => p.kind === 'openai') || null;
  if (!cfg) return null;
  const kind = ctx.providers.kind(cfg.kind);
  const baseUrl = (cfg.base_url || kind?.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) return null;
  return { cfg, kind: cfg.kind, label: cfg.name || kind?.label || cfg.kind, baseUrl, key: ctx.secrets.get(cfg.secret_id) };
}

/**
 * SSRF policy for voice endpoints: on a multi-user server a member's own provider may not point to private
 * addresses. Desktop mode, admins and admin-shared providers may (local speech servers are the point).
 */
export async function endpointUrl(ctx: Ctx, user: Pick<User, 'id' | 'role'>, ep: Endpoint, path: string): Promise<string> {
  const url = ep.baseUrl + path;
  const allowPrivate = ctx.config.mode === 'desktop' || user.role !== 'member' || ep.cfg.user_id !== user.id;
  try {
    await assertPublicUrl(url, allowPrivate);
  } catch (e: any) {
    throw new HttpError(400, `Spraak-endpoint geweigerd: ${e?.message || e}`, 'voice_endpoint_blocked');
  }
  return url;
}

/** Realtime WebRTC needs https (or a loopback http proxy for development/tests). */
export function realtimeBase(ep: Endpoint): string {
  const u = new URL(ep.baseUrl);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new HttpError(400, 'Live praten vereist een https-adres voor de OpenAI-provider', 'voice_realtime_https');
  return ep.baseUrl;
}

export function authHeaders(ep: Endpoint): Record<string, string> {
  const h: Record<string, string> = {};
  if (ep.key) {
    const custom = ep.cfg.config?.apiKeyHeader;
    if (typeof custom === 'string' && /^[\w-]{1,60}$/.test(custom)) h[custom] = ep.key;
    else h.authorization = `Bearer ${ep.key}`;
  }
  return h;
}

/** Turn a provider error body into a short Dutch message without leaking secrets. */
export async function providerError(res: Response, label: string): Promise<HttpError> {
  let msg = '';
  try {
    const t = await res.text();
    try {
      const j = JSON.parse(t);
      msg = j?.error?.message || j?.message || (typeof j?.error === 'string' ? j.error : '') || t;
    } catch {
      msg = t;
    }
  } catch {
    /* ignore */
  }
  const status = res.status === 429 ? 429 : res.status >= 500 ? 502 : 400;
  // Known causes in plain Dutch, without the provider's English text (which also echoes part of the key).
  const known =
    res.status === 401 || res.status === 403
      ? `de sleutel wordt geweigerd: ongeldig of ingetrokken (${res.status}, controleer de API-sleutel bij AI-diensten)`
      : res.status === 404
        ? 'dit model of endpoint bestaat niet (404)'
        : res.status === 429
          ? 'limiet bereikt of tegoed op (429)'
          : '';
  if (known) return new HttpError(status, `${label}: ${known}`, 'voice_provider_error');
  return new HttpError(status, `${label}: ${res.status} ${String(msg).replace(/sk-[A-Za-z0-9_*-]{8,}/g, 'sk-…').slice(0, 300)}`, 'voice_provider_error');
}
