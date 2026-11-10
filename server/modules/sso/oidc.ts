import net from 'node:net';
import * as oidc from 'openid-client';
import type { Ctx } from '../../core/types.js';
import { redact } from '../../core/secrets.js';
import { isPrivateIp, safeFetch } from '../../tools/builtin/web.js';
import { CLIENT_SECRET, SYSTEM, type SsoConfig, randomToken, sha256 } from './config.js';

const SCOPE = 'openid email profile';
const FLOW_TTL_MS = 10 * 60_000;
const HANDOFF_TTL_MS = 60_000;
const DISCOVERY_TTL_MS = 15 * 60_000;
const MAX_FLOWS = 2000;

/** A refusal with a short reason code; the UI maps the code to a Dutch message (never free text in the URL). */
export class SsoRefusal extends Error {
  constructor(public reason: string, message: string, public detail: Record<string, any> = {}) {
    super(message);
  }
}

interface Flow {
  state: string;
  nonce: string;
  verifier: string;
  binding: string; // sha256 of the browser-binding cookie
  redirectUri: string;
  version: number;
  expires: number;
}

/** May the server talk to this IdP over plain http? Only for a local IdP of an owner/admin (loopback/LAN). */
function insecureOk(issuer: URL, allowPrivate: boolean): boolean {
  if (issuer.protocol === 'https:') return false;
  if (!allowPrivate) return false;
  const host = issuer.hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || (net.isIP(host) > 0 && isPrivateIp(host));
}

/** Readable Dutch text for a library/network error, without anything secret in it. */
export function describeError(e: any): string {
  // openid-client wraps the precise check that failed in `cause` (a fixed library text, no token data).
  const cause = e?.cause instanceof Error && typeof e.cause.message === 'string' && e.cause.message !== e.message ? `: ${e.cause.message}` : '';
  const msg = redact(String(e?.message || e || 'onbekende fout') + cause).slice(0, 300);
  const code = String(e?.code || '');
  if (/"issuer" property does not match/i.test(msg)) return 'De issuer in het discovery-document komt niet precies overeen met de ingevulde issuer-URL (let ook op een / aan het eind).';
  if (/only requests to HTTPS are allowed|must be https/i.test(msg)) return 'De identiteitsprovider moet via https bereikbaar zijn (http alleen voor een lokale provider).';
  if (/privé-netwerk|Lokale adressen/i.test(msg)) return msg;
  if (code === 'OAUTH_RESPONSE_IS_NOT_CONFORM' || /response.*status/i.test(msg)) return `De identiteitsprovider gaf een onverwacht antwoord (${msg}).`;
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|timed? ?out|aborted/i.test(msg)) return `De identiteitsprovider is niet bereikbaar (${msg}).`;
  return msg;
}

export class OidcService {
  private flows = new Map<string, Flow>();
  private handoffs = new Map<string, { userId: string; binding: string; expires: number }>();
  private cache: { key: string; at: number; config: oidc.Configuration } | null = null;

  constructor(private ctx: Ctx) {}

  /** Private (LAN/loopback) IdP addresses are allowed when an owner/admin configured the provider. */
  allowPrivate(c: SsoConfig): boolean {
    const u = c.providerSetBy ? this.ctx.store.user(c.providerSetBy) : null;
    return !!u && (u.role === 'owner' || u.role === 'admin');
  }

  private fetcher(allowPrivate: boolean): oidc.CustomFetch {
    return (url, options) => safeFetch(url, { ...(options as any), allowPrivate, maxRedirects: 3, signal: options.signal ?? AbortSignal.timeout(15_000) });
  }

  /** Discover an issuer (used by the admin "test" button and the login flow). */
  async discover(issuer: string, clientId: string, clientSecret: string | null, allowPrivate: boolean): Promise<oidc.Configuration> {
    let url: URL;
    try {
      url = new URL(issuer);
    } catch {
      throw new Error('Ongeldige issuer-URL');
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('De issuer-URL moet met https:// beginnen');
    const insecure = insecureOk(url, allowPrivate);
    const fetcher = this.fetcher(allowPrivate);
    const discovered = await oidc.discovery(url, clientId || 'teambot-test', undefined, oidc.None(), {
      [oidc.customFetch]: fetcher,
      execute: insecure ? [oidc.allowInsecureRequests] : [],
      timeout: 15,
    });
    const m = discovered.serverMetadata();
    // Client authentication: client_secret_basic (the OIDC default) unless the provider only offers _post.
    const methods = m.token_endpoint_auth_methods_supported;
    const auth = !clientSecret ? oidc.None() : !Array.isArray(methods) || methods.includes('client_secret_basic') ? oidc.ClientSecretBasic(clientSecret) : oidc.ClientSecretPost(clientSecret);
    const config = new oidc.Configuration(m, clientId || 'teambot-test', clientSecret ? { client_secret: clientSecret } : undefined, auth);
    config[oidc.customFetch] = fetcher;
    config.timeout = 15;
    // Also verify the ID-token signature when it comes straight from the token endpoint (defence in depth).
    oidc.enableNonRepudiationChecks(config);
    if (insecure) oidc.allowInsecureRequests(config);
    if (String(m.issuer).includes('{tenantid}'))
      throw new Error('Dit is een issuer voor meerdere tenants (bijv. “common”). Gebruik de URL met je eigen tenant-ID, zodat alleen jouw organisatie kan inloggen.');
    if (!m.authorization_endpoint || !m.token_endpoint) throw new Error('Het discovery-document mist authorization_endpoint of token_endpoint');
    if (!m.jwks_uri) throw new Error('Het discovery-document mist jwks_uri (nodig om ID-tokens te controleren)');
    if (Array.isArray(m.code_challenge_methods_supported) && !m.code_challenge_methods_supported.includes('S256')) throw new Error('De provider ondersteunt geen PKCE met S256');
    if (Array.isArray(m.response_types_supported) && !m.response_types_supported.includes('code')) throw new Error('De provider ondersteunt de authorization-code-flow niet');
    return config;
  }

  /** The configuration for logins (cached per settings version). */
  private async configuration(c: SsoConfig): Promise<oidc.Configuration> {
    const secret = this.ctx.secrets.getByName(SYSTEM, CLIENT_SECRET);
    const key = sha256([c.version, c.issuer, c.clientId, secret || ''].join('\n'));
    if (this.cache && this.cache.key === key && Date.now() - this.cache.at < DISCOVERY_TTL_MS) return this.cache.config;
    const config = await this.discover(c.issuer, c.clientId, secret, this.allowPrivate(c));
    this.cache = { key, at: Date.now(), config };
    return config;
  }

  dropCache() {
    this.cache = null;
    this.flows.clear();
  }

  private sweep() {
    const t = Date.now();
    for (const [k, f] of this.flows) if (f.expires <= t) this.flows.delete(k);
    for (const [k, h] of this.handoffs) if (h.expires <= t) this.handoffs.delete(k);
    while (this.flows.size > MAX_FLOWS) this.flows.delete(this.flows.keys().next().value!);
  }

  /** Start a login: returns the provider URL and the browser-binding value (goes into an HttpOnly cookie). */
  async start(c: SsoConfig, redirectUri: string): Promise<{ url: string; binding: string }> {
    this.sweep();
    const config = await this.configuration(c);
    const verifier = oidc.randomPKCECodeVerifier();
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const binding = randomToken();
    this.flows.set(state, { state, nonce, verifier, binding: sha256(binding), redirectUri, version: c.version, expires: Date.now() + FLOW_TTL_MS });
    const url = oidc.buildAuthorizationUrl(config, { redirect_uri: redirectUri, scope: SCOPE, code_challenge: challenge, code_challenge_method: 'S256', state, nonce });
    return { url: url.href, binding };
  }

  /**
   * Finish a login: checks the browser binding and state, then lets openid-client validate the code exchange (PKCE),
   * the ID token signature, issuer, audience, expiry and nonce. Returns the validated ID-token claims.
   */
  async callback(c: SsoConfig, params: URLSearchParams, binding: string | null): Promise<oidc.IDToken> {
    this.sweep();
    const state = params.get('state') || '';
    const flow = state ? this.flows.get(state) : undefined;
    if (flow) this.flows.delete(state); // one attempt per login
    if (!flow || flow.expires <= Date.now()) throw new SsoRefusal('state', 'Onbekende of verlopen inlogpoging (state)');
    if (!binding || sha256(binding) !== flow.binding) throw new SsoRefusal('state', 'Inlogpoging hoort niet bij deze browser');
    if (flow.version !== c.version) throw new SsoRefusal('config', 'De SSO-instellingen zijn tijdens het inloggen gewijzigd');
    const idpError = params.get('error');
    if (idpError) throw new SsoRefusal('provider', 'De identiteitsprovider weigerde de aanmelding', { idpError: idpError.replace(/[^\w.-]/g, '').slice(0, 64) });
    const config = await this.configuration(c);
    const current = new URL(flow.redirectUri);
    for (const [k, v] of params) current.searchParams.append(k, v);
    let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
    try {
      tokens = await oidc.authorizationCodeGrant(config, current, { pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce, idTokenExpected: true });
    } catch (e: any) {
      // Only the error code/message is kept (never tokens or the response body).
      throw new SsoRefusal('provider', 'Controle van de aanmelding mislukt', { error: describeError(e), code: String(e?.code || '').slice(0, 64) });
    }
    const claims = tokens.claims();
    if (!claims) throw new SsoRefusal('provider', 'Geen ID-token ontvangen');
    return claims;
  }

  /** One-time code (60 s) that the app exchanges for a session token via POST; bound to the same browser. */
  handoff(userId: string, binding: string): string {
    this.sweep();
    const code = randomToken();
    this.handoffs.set(sha256(code), { userId, binding: sha256(binding), expires: Date.now() + HANDOFF_TTL_MS });
    return code;
  }

  redeem(code: string, binding: string | null): string | null {
    this.sweep();
    const key = sha256(String(code || ''));
    const h = this.handoffs.get(key);
    if (!h) return null;
    this.handoffs.delete(key);
    if (h.expires <= Date.now() || !binding || sha256(binding) !== h.binding) return null;
    return h.userId;
  }
}
