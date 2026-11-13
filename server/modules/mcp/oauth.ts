import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthClientProvider, OAuthDiscoveryState, OAuthTokens } from '@modelcontextprotocol/client';
import {
  LATEST_PROTOCOL_VERSION,
  OAuthError,
  discoverOAuthServerInfo,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
  refreshAuthorization,
  registerClient,
  selectResourceURL,
  startAuthorization,
} from '@modelcontextprotocol/client';
import type { Ctx } from '../../core/types.js';
import { now } from '../../core/db.js';
import { bad } from '../../core/http.js';
import type { ConnectionRow, OAuthState } from './db.js';
import { entryForConn } from './package.js';
import { GOOGLE_PREVIEW } from './catalog.js';
import { cleanError, guardedFetch, mayUsePrivateNetwork, randomToken, resolveKV, sha256 } from './util.js';

export const CALLBACK_PATH = '/api/public/mcp/oauth/callback';
const FLOW_TTL_MS = 10 * 60_000;

export class AuthRequiredError extends Error {
  constructor(msg = 'Opnieuw inloggen bij deze app is nodig (toegang verlopen of ingetrokken).') {
    super(msg);
  }
}

const secretName = (connId: string, what: 'tokens' | 'client' | 'verifier' | 'client_secret') => `mcp:${connId}:oauth:${what}`;

export function getConn(ctx: Ctx, id: string): ConnectionRow | null {
  return ctx.store.get<ConnectionRow>('mcp_connections', id);
}

export function patchOAuth(ctx: Ctx, id: string, patch: Partial<OAuthState>) {
  const c = getConn(ctx, id);
  if (!c) return;
  ctx.store.update('mcp_connections', id, { oauth: { ...(c.oauth || {}), ...patch }, updated_at: now() });
}

function allowPrivate(ctx: Ctx, c: ConnectionRow) {
  return !!c.allow_private && mayUsePrivateNetwork(ctx, c.user_id);
}

export function storedTokens(ctx: Ctx, c: ConnectionRow): (OAuthTokens & { issuer?: string; obtained_at?: number }) | undefined {
  const raw = ctx.secrets.getByName(c.user_id, secretName(c.id, 'tokens'));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function saveTokensFor(ctx: Ctx, c: ConnectionRow, tokens: OAuthTokens & { issuer?: string }) {
  const prev = storedTokens(ctx, c);
  const merged = { ...tokens, refresh_token: tokens.refresh_token || prev?.refresh_token, obtained_at: Date.now() };
  ctx.secrets.set(c.user_id, secretName(c.id, 'tokens'), JSON.stringify(merged));
  patchOAuth(ctx, c.id, {
    status: 'connected',
    connected_at: c.oauth?.connected_at && c.oauth.status === 'connected' ? c.oauth.connected_at : now(),
    expires_at: tokens.expires_in ? new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString() : null,
    has_refresh: !!merged.refresh_token,
    granted_scope: tokens.scope || c.oauth?.scope || '',
  });
}

function clientInfoFor(ctx: Ctx, c: ConnectionRow): (OAuthClientInformationMixed & { issuer?: string }) | undefined {
  const o = c.oauth || {};
  if (o.preregistered && o.client_id) {
    const secret = o.client_secret_id && ctx.secrets.owner(o.client_secret_id) === c.user_id ? ctx.secrets.get(o.client_secret_id) : null;
    return { client_id: o.client_id, ...(secret ? { client_secret: secret } : {}), issuer: (o as any).client_issuer } as any;
  }
  const raw = ctx.secrets.getByName(c.user_id, secretName(c.id, 'client'));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function saveClientInfoFor(ctx: Ctx, c: ConnectionRow, info: OAuthClientInformationMixed & { issuer?: string }) {
  if (c.oauth?.preregistered) {
    patchOAuth(ctx, c.id, { client_issuer: info.issuer } as any);
    return;
  }
  ctx.secrets.set(c.user_id, secretName(c.id, 'client'), JSON.stringify(info));
  patchOAuth(ctx, c.id, { client_id: info.client_id });
}

/**
 * The issuer the SDK (v2, SEP-2352) binds credentials to: the authorization server's own `issuer` from its metadata,
 * else its URL. Stored tokens and client registrations carry this stamp, so the SDK only sends them to that server.
 */
export function issuerOf(disc: Pick<OAuthDiscoveryState, 'authorizationServerUrl' | 'authorizationServerMetadata'> | undefined): string | undefined {
  if (!disc) return undefined;
  return (disc.authorizationServerMetadata as any)?.issuer || disc.authorizationServerUrl;
}

/** Same authorization server? Tolerates one trailing slash (the SDK's own rule). */
export function sameIssuer(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a === b || a.replace(/\/$/, '') === b.replace(/\/$/, '');
}

/**
 * TeamBot before SDK v2 stamped credentials with the authorization server URL. When that URL and the server's
 * `issuer` differ (an issuer with a path), the old stamp would make the SDK drop valid tokens and ask for a new
 * login. Restamp such values on read; anything bound to another server stays as it is (and is refused).
 */
function restamp<T extends { issuer?: string }>(value: T | undefined, disc: OAuthDiscoveryState | undefined): T | undefined {
  const want = issuerOf(disc);
  if (!value || !want || !value.issuer || sameIssuer(value.issuer, want)) return value;
  return sameIssuer(value.issuer, disc?.authorizationServerUrl) ? { ...value, issuer: want } : value;
}

function deleteSecret(ctx: Ctx, userId: string, name: string) {
  const row = ctx.secrets.list(userId).find((s) => s.name === name);
  if (row) ctx.secrets.delete(row.id);
}

/**
 * OAuthClientProvider for the SDK transports. Used at runtime so the SDK can
 * attach the bearer token and refresh it on a 401. It never opens a browser:
 * when a new interactive login is needed it marks the connection and throws.
 */
export class TeamBotOAuthProvider implements OAuthClientProvider {
  constructor(private ctx: Ctx, private connId: string, private onAuthRequired: () => void) {}
  private c(): ConnectionRow {
    const c = getConn(this.ctx, this.connId);
    if (!c) throw new Error('Koppeling bestaat niet meer');
    return c;
  }
  get redirectUrl(): string {
    return this.c().oauth?.redirect_uri || (this.ctx.config.publicUrl || 'http://127.0.0.1') + CALLBACK_PATH;
  }
  get clientMetadata(): OAuthClientMetadata {
    return clientMetadata(this.ctx, this.redirectUrl, this.c().oauth?.scope);
  }
  state() {
    return randomToken();
  }
  clientInformation() {
    const c = this.c();
    return restamp(clientInfoFor(this.ctx, c), c.oauth?.discovery);
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    saveClientInfoFor(this.ctx, this.c(), info as any);
  }
  tokens() {
    const c = this.c();
    const t = storedTokens(this.ctx, c);
    if (!t) return undefined;
    const { obtained_at, ...rest } = t;
    return restamp(rest, c.oauth?.discovery);
  }
  saveTokens(tokens: OAuthTokens) {
    saveTokensFor(this.ctx, this.c(), tokens as any);
  }
  redirectToAuthorization(): void {
    this.onAuthRequired();
    throw new AuthRequiredError();
  }
  saveCodeVerifier(v: string) {
    const c = this.c();
    this.ctx.secrets.set(c.user_id, secretName(c.id, 'verifier'), v);
  }
  codeVerifier(): string {
    const c = this.c();
    const v = this.ctx.secrets.getByName(c.user_id, secretName(c.id, 'verifier'));
    if (!v) throw new Error('Geen PKCE-verifier gevonden');
    return v;
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    const c = this.c();
    if ((scope === 'all' || scope === 'client') && !c.oauth?.preregistered) deleteSecret(this.ctx, c.user_id, secretName(c.id, 'client'));
    if (scope === 'all' || scope === 'tokens') {
      deleteSecret(this.ctx, c.user_id, secretName(c.id, 'tokens'));
      patchOAuth(this.ctx, c.id, { status: 'expired', has_refresh: false });
    }
    if (scope === 'all' || scope === 'verifier') deleteSecret(this.ctx, c.user_id, secretName(c.id, 'verifier'));
    if (scope === 'all' || scope === 'discovery') patchOAuth(this.ctx, c.id, { discovery: undefined });
  }
  saveDiscoveryState(s: OAuthDiscoveryState) {
    patchOAuth(this.ctx, this.connId, { discovery: s, authorization_server: s.authorizationServerUrl });
  }
  discoveryState(): OAuthDiscoveryState | undefined {
    return this.c().oauth?.discovery;
  }
}

function clientMetadata(ctx: Ctx, redirectUri: string, scope?: string): OAuthClientMetadata {
  return {
    client_name: ctx.config.appName || 'TeamBot',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    software_id: 'teambot',
    software_version: ctx.config.version,
    ...(scope ? { scope } : {}),
  } as OAuthClientMetadata;
}

/** Probe the server without credentials: does it need auth, and which scope does it ask for? */
async function probe(ctx: Ctx, c: ConnectionRow) {
  const fetchFn = guardedFetch(allowPrivate(ctx, c));
  const { values } = resolveKV(ctx, c.user_id, c.headers);
  const headers: Record<string, string> = { ...values };
  delete headers.Authorization;
  delete headers.authorization;
  try {
    const res =
      c.transport === 'sse'
        ? await fetchFn(c.url, { method: 'GET', headers: { ...headers, accept: 'text/event-stream' }, redirect: 'manual', signal: AbortSignal.timeout(15_000) })
        : await fetchFn(c.url, {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'TeamBot', version: ctx.config.version } } }),
            redirect: 'manual',
            signal: AbortSignal.timeout(15_000),
          });
    const out = { status: res.status, ...(res.status === 401 ? extractWWWAuthenticateParams(res) : {}) };
    await res.body?.cancel().catch(() => {});
    return out;
  } catch (e: any) {
    return { status: 0, error: cleanError(e) };
  }
}

/**
 * Unauthenticated `initialize` probe of a remote MCP address (SSRF-guarded, no credentials sent): does the server
 * ask for a login? Used before installing a registry server so the right sign-in method is pre-selected.
 */
export async function probeUrl(ctx: Ctx, userId: string, url: string, transport: 'http' | 'sse'): Promise<{ status: number; oauth: boolean; error?: string }> {
  const p: any = await probe(ctx, { url, transport, headers: [], user_id: userId, allow_private: false } as unknown as ConnectionRow);
  return { status: p.status, oauth: p.status === 401 && !!p.resourceMetadataUrl, ...(p.error ? { error: p.error } : {}) };
}

/** Step 1 of the OAuth flow: discovery. Shows scopes and registration mode before anything is sent to the service. */
export async function prepareOAuth(ctx: Ctx, c: ConnectionRow) {
  if (c.transport === 'stdio') throw bad('OAuth is alleen voor remote servers');
  const p: any = await probe(ctx, c);
  if (p.status === 0) throw bad(`Server niet bereikbaar: ${p.error}`);
  const fetchFn = guardedFetch(allowPrivate(ctx, c));
  let info;
  try {
    info = await discoverOAuthServerInfo(c.url, { resourceMetadataUrl: p.resourceMetadataUrl, fetchFn });
  } catch (e: any) {
    throw bad(`Geen OAuth-gegevens gevonden bij deze server (${cleanError(e)}).`);
  }
  const md = info.authorizationServerMetadata;
  if (!md) throw bad('De autorisatieserver publiceert geen metadata; OAuth volgens de MCP-specificatie is niet mogelijk.');
  const discovery: OAuthDiscoveryState = { ...info, resourceMetadataUrl: p.resourceMetadataUrl?.toString() };
  patchOAuth(ctx, c.id, { discovery, authorization_server: info.authorizationServerUrl, resource_metadata_url: p.resourceMetadataUrl?.toString() });
  const supported: string[] = (info.resourceMetadata?.scopes_supported as string[]) || (md.scopes_supported as string[]) || [];
  const required: string[] = p.scope ? String(p.scope).split(/\s+/).filter(Boolean) : [];
  const entry = entryForConn(c);
  const catalogScopes = entry?.scopes || [];
  const scopes = [...new Set([...catalogScopes.map((s) => s.name), ...required, ...supported])].map((name) => {
    const cs = catalogScopes.find((s) => s.name === name);
    return { name, description: cs?.description || '', required: required.includes(name), default: required.includes(name) || !!cs?.default };
  });
  const c2 = getConn(ctx, c.id)!;
  // Some servers answer initialize without a login and only refuse tool calls (Google Workspace): a built-in
  // template that says OAuth is needed is believed over the probe.
  const templateNeedsLogin = !!entry && entry.auth === 'oauth' && !['custom', 'registry'].includes(entry.id);
  // A client ID without the secret the service always asks for is not a usable client yet (the guide shows again).
  const clientReady = !!(c2.oauth?.preregistered && c2.oauth?.client_id) && !(entry?.oauthAppGuide?.secretRequired && !c2.oauth?.client_secret_id);
  return {
    authRequired: p.status === 401 || p.status === 403 || templateNeedsLogin,
    authorizationServer: new URL(info.authorizationServerUrl).host,
    resourceHost: new URL(c.url).host,
    scopes,
    registration: md.registration_endpoint ? 'dynamic' : clientReady ? 'preregistered' : 'missing',
    canRevoke: !!(md as any).revocation_endpoint,
    pkce: !md.code_challenge_methods_supported || (md.code_challenge_methods_supported as string[]).includes('S256'),
  };
}

/**
 * The short, true answer when a service does not let TeamBot register itself (no dynamic client registration) and no
 * own client is filled in yet: what is needed, where to fill it in, and the easier way where there is one.
 */
export function ownAppNeeded(c: ConnectionRow, redirectUri: string): string {
  const e = entryForConn(c);
  const name = e && !['custom', 'registry'].includes(e.id) ? e.name : c.label ? `${c.name} (${c.label})` : c.name;
  const vendor = e?.oauthAppGuide?.vendor || (e && !['custom', 'registry'].includes(e.id) ? e.publisher : '') || 'de dienst';
  const secret = e?.oauthAppGuide?.secretRequired ? ' en het clientgeheim' : ' (en het clientgeheim, als je dat kreeg)';
  const easier = e && GOOGLE_PREVIEW.has(e.id) ? ' Eenvoudiger: de kaart Google bovenaan Apps geeft Gmail, Agenda en Drive (ook spreadsheets lezen) zonder Developer Preview.' : '';
  return `${name} laat apps zoals TeamBot zich niet zelf aanmelden. Eerst is één keer een eigen app bij ${vendor} nodig, met als redirect-URL ${redirectUri}. Vul daarna de client-ID${secret} in bij Apps › ${name} › Inloggen; daar staan ook de stappen.${easier}`;
}

/** Step 2: register (if needed), PKCE + state, return the URL the user opens. */
export async function beginOAuth(ctx: Ctx, c: ConnectionRow, scopes: string[], redirectUri: string): Promise<{ authorizationUrl: string }> {
  if (!c.oauth?.discovery?.authorizationServerMetadata) await prepareOAuth(ctx, c);
  c = getConn(ctx, c.id)!;
  const disc = c.oauth.discovery as OAuthDiscoveryState;
  const md = disc.authorizationServerMetadata!;
  const asUrl = disc.authorizationServerUrl;
  const issuer = issuerOf(disc)!;
  if (md.code_challenge_methods_supported && !(md.code_challenge_methods_supported as string[]).includes('S256')) throw bad('Deze autorisatieserver ondersteunt geen PKCE (S256); verbinden geweigerd.');
  const fetchFn = guardedFetch(allowPrivate(ctx, c));
  const scope = scopes.filter((s) => /^[\x21\x23-\x5b\x5d-\x7e]{1,200}$/.test(s)).join(' ');
  let client = clientInfoFor(ctx, c);
  const regRedirects: string[] | undefined = (client as any)?.redirect_uris;
  const stale = !!client && ((client.issuer && !sameIssuer(client.issuer, issuer) && !sameIssuer(client.issuer, asUrl)) || (!c.oauth.preregistered && regRedirects && !regRedirects.includes(redirectUri)));
  if (client && c.oauth.preregistered && !(client as any).client_secret && entryForConn(c)?.oauthAppGuide?.secretRequired) throw bad(`Vul ook het clientgeheim (client secret) van je eigen OAuth-client in: ${entryForConn(c)!.oauthAppGuide!.vendor} vraagt het altijd.`);
  if (!client || stale) {
    if (c.oauth.preregistered) throw bad('Vul de client-ID van je eigen OAuth-app in.');
    if (!md.registration_endpoint) throw bad(ownAppNeeded(c, redirectUri));
    const full = await registerClient(asUrl, { metadata: md, clientMetadata: clientMetadata(ctx, redirectUri, scope || undefined), scope: scope || undefined, fetchFn });
    client = { ...full, issuer } as any;
    saveClientInfoFor(ctx, c, client as any);
  }
  const provider = new TeamBotOAuthProvider(ctx, c.id, () => {});
  let resource: string | URL | undefined;
  if (disc.resourceMetadata) {
    const sel = await selectResourceURL(c.url, provider, disc.resourceMetadata);
    resource = sel ? (disc.resourceMetadata.resource as string) : undefined;
  }
  const state = randomToken(32);
  const { authorizationUrl, codeVerifier } = await startAuthorization(asUrl, { metadata: md, clientInformation: client!, redirectUrl: redirectUri, scope: scope || undefined, state, resource });
  if (!['https:', 'http:'].includes(authorizationUrl.protocol)) throw bad('Ongeldige autorisatie-URL');
  const extra = entryForConn(c)?.oauthExtraParams || {};
  for (const [k, v] of Object.entries(extra)) if (!authorizationUrl.searchParams.has(k)) authorizationUrl.searchParams.set(k, v);
  ctx.secrets.set(c.user_id, secretName(c.id, 'verifier'), codeVerifier);
  ctx.store.exec('DELETE FROM mcp_oauth_flows WHERE connection_id = ? OR expires_at < ?', c.id, now());
  ctx.store.insert('mcp_oauth_flows', {
    state_hash: sha256(state),
    user_id: c.user_id,
    connection_id: c.id,
    redirect_uri: redirectUri,
    scope,
    created_at: now(),
    expires_at: new Date(Date.now() + FLOW_TTL_MS).toISOString(),
    used: false,
  });
  patchOAuth(ctx, c.id, { scope, redirect_uri: redirectUri, resource: resource ? String(resource) : undefined, status: c.oauth.status === 'connected' ? 'connected' : 'pending' });
  ctx.audit(c.user_id, 'mcp.oauth.started', { connection: c.id, name: c.name, scope, authorizationServer: new URL(asUrl).host });
  return { authorizationUrl: authorizationUrl.href };
}

/** Step 3 (public callback): validate state, exchange the code. Returns the connection on success. */
export async function completeOAuth(ctx: Ctx, q: { state?: string; code?: string; error?: string; error_description?: string; iss?: string }): Promise<{ ok: boolean; conn?: ConnectionRow; message: string }> {
  const state = typeof q.state === 'string' ? q.state : '';
  if (!state || state.length > 200) return { ok: false, message: 'Ongeldige aanmelding: de controlecode (state) ontbreekt.' };
  const flow = ctx.store.get<any>('mcp_oauth_flows', sha256(state), 'state_hash');
  if (!flow || flow.used || flow.expires_at < now()) return { ok: false, message: 'Ongeldige of verlopen aanmelding. Start het verbinden opnieuw vanuit TeamBot.' };
  ctx.store.update('mcp_oauth_flows', flow.state_hash, { used: true }, 'state_hash');
  const c = getConn(ctx, flow.connection_id);
  if (!c || c.user_id !== flow.user_id) return { ok: false, message: 'Deze koppeling bestaat niet meer.' };
  // RFC 9207 mix-up defence: an answer that names another authorization server is refused before anything else,
  // and its error text is not shown (an attacker could have written it).
  const iss = typeof q.iss === 'string' && q.iss ? q.iss : undefined;
  const expectedIssuer = issuerOf(c.oauth?.discovery as OAuthDiscoveryState | undefined);
  if (iss && expectedIssuer && !sameIssuer(iss, expectedIssuer)) {
    const msg = 'Aanmelding geweigerd: het antwoord kwam van een andere autorisatieserver dan waar je inlogde. Start het verbinden opnieuw vanuit TeamBot.';
    ctx.store.update('mcp_connections', c.id, { last_error: msg, updated_at: now() });
    return { ok: false, conn: getConn(ctx, c.id)!, message: msg };
  }
  if (q.error) {
    const msg = `Inloggen geweigerd of mislukt: ${cleanError(q.error_description || q.error).slice(0, 200)}`;
    ctx.store.update('mcp_connections', c.id, { last_error: msg, updated_at: now() });
    patchOAuth(ctx, c.id, { status: c.oauth?.status === 'connected' ? 'connected' : 'disconnected' });
    return { ok: false, conn: getConn(ctx, c.id)!, message: msg };
  }
  const code = typeof q.code === 'string' ? q.code : '';
  if (!code) return { ok: false, message: 'Geen autorisatiecode ontvangen.' };
  const disc = c.oauth?.discovery as OAuthDiscoveryState | undefined;
  const verifier = ctx.secrets.getByName(c.user_id, secretName(c.id, 'verifier'));
  const client = clientInfoFor(ctx, c);
  if (!disc?.authorizationServerMetadata || !verifier || !client) return { ok: false, message: 'Aanmeldgegevens ontbreken; start het verbinden opnieuw.' };
  try {
    const tokens = await exchangeAuthorization(disc.authorizationServerUrl, {
      metadata: disc.authorizationServerMetadata,
      clientInformation: client,
      authorizationCode: code,
      iss,
      codeVerifier: verifier,
      redirectUri: flow.redirect_uri,
      resource: c.oauth.resource,
      fetchFn: guardedFetch(allowPrivate(ctx, c)),
    });
    saveTokensFor(ctx, c, { ...tokens, issuer: issuerOf(disc) } as any);
    deleteSecret(ctx, c.user_id, secretName(c.id, 'verifier'));
    ctx.store.update('mcp_connections', c.id, { status: 'authorized', last_error: null, updated_at: now() });
    ctx.audit(c.user_id, 'mcp.oauth.connected', { connection: c.id, name: c.name, granted: tokens.scope || c.oauth.scope || '' });
    return { ok: true, conn: getConn(ctx, c.id)!, message: 'Verbonden' };
  } catch (e: any) {
    const msg = `Token ophalen mislukt: ${cleanError(e)}`;
    ctx.store.update('mcp_connections', c.id, { last_error: msg, updated_at: now() });
    return { ok: false, conn: getConn(ctx, c.id)!, message: msg };
  }
}

/** Refresh ahead of expiry (the SDK also refreshes on a 401). */
export async function refreshIfNeeded(ctx: Ctx, c: ConnectionRow): Promise<void> {
  const t = storedTokens(ctx, c);
  if (!t) throw new AuthRequiredError('Nog niet ingelogd bij deze app. Klik op “Inloggen”.');
  const exp = c.oauth?.expires_at ? Date.parse(c.oauth.expires_at) : null;
  if (!exp || exp - Date.now() > 60_000) return;
  if (!t.refresh_token) throw new AuthRequiredError();
  const disc = c.oauth?.discovery as OAuthDiscoveryState | undefined;
  const client = clientInfoFor(ctx, c);
  if (!disc?.authorizationServerMetadata || !client) throw new AuthRequiredError();
  try {
    const next = await refreshAuthorization(disc.authorizationServerUrl, {
      metadata: disc.authorizationServerMetadata,
      clientInformation: client,
      refreshToken: t.refresh_token,
      resource: c.oauth.resource,
      fetchFn: guardedFetch(allowPrivate(ctx, c)),
    });
    saveTokensFor(ctx, c, { ...next, issuer: issuerOf(disc) } as any);
    ctx.audit(c.user_id, 'mcp.oauth.refreshed', { connection: c.id });
  } catch (e: any) {
    // SDK v2: one OAuthError class with the RFC 6749 code (v1 had a class per code).
    const code = e instanceof OAuthError ? String(e.code) : '';
    if (/invalid_grant|unauthorized_client|invalid_client/i.test(`${code} ${String(e?.message || e)}`)) {
      deleteSecret(ctx, c.user_id, secretName(c.id, 'tokens'));
      patchOAuth(ctx, c.id, { status: 'expired', has_refresh: false });
      throw new AuthRequiredError();
    }
    throw e;
  }
}

/**
 * Revoke tokens at the service (RFC 7009) when it offers an endpoint, delete the
 * dynamic client registration (RFC 7592) when possible, and wipe local secrets.
 */
export async function revokeOAuth(ctx: Ctx, c: ConnectionRow, opts: { forget?: boolean } = {}): Promise<{ revokedAtService: boolean; detail: string }> {
  const t = storedTokens(ctx, c);
  const disc = c.oauth?.discovery as OAuthDiscoveryState | undefined;
  const md: any = disc?.authorizationServerMetadata;
  const client: any = clientInfoFor(ctx, c);
  const fetchFn = guardedFetch(allowPrivate(ctx, c));
  let revokedAtService = false;
  let detail = '';
  if (t && md?.revocation_endpoint && client?.client_id) {
    const pairs: [string | undefined, string][] = [
      [t.refresh_token, 'refresh_token'],
      [t.access_token, 'access_token'],
    ];
    for (const [token, hint] of pairs) {
      if (!token) continue;
      try {
        const body = new URLSearchParams({ token, token_type_hint: hint });
        const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
        const methods: string[] = md.revocation_endpoint_auth_methods_supported || md.token_endpoint_auth_methods_supported || [];
        if (client.client_secret && (methods.includes('client_secret_basic') || !methods.includes('client_secret_post'))) {
          headers.authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`).toString('base64');
        } else {
          body.set('client_id', client.client_id);
          if (client.client_secret) body.set('client_secret', client.client_secret);
        }
        const res = await fetchFn(md.revocation_endpoint, { method: 'POST', headers, body: body.toString(), signal: AbortSignal.timeout(15_000) });
        await res.body?.cancel().catch(() => {});
        if (res.ok) revokedAtService = true;
        else detail = `De dienst gaf status ${res.status} bij intrekken.`;
      } catch (e: any) {
        detail = `Intrekken bij de dienst mislukt: ${cleanError(e)}`;
      }
    }
  } else if (t) {
    detail = 'De dienst biedt geen intrekkingsadres aan; de tokens zijn alleen lokaal gewist. Trek de toegang zo nodig zelf in bij de dienst.';
  }
  if (opts.forget && client?.registration_client_uri && client?.registration_access_token) {
    try {
      const res = await fetchFn(client.registration_client_uri, { method: 'DELETE', headers: { authorization: `Bearer ${client.registration_access_token}` }, signal: AbortSignal.timeout(10_000) });
      await res.body?.cancel().catch(() => {});
    } catch {
      /* best effort */
    }
  }
  deleteSecret(ctx, c.user_id, secretName(c.id, 'tokens'));
  deleteSecret(ctx, c.user_id, secretName(c.id, 'verifier'));
  if (opts.forget) {
    deleteSecret(ctx, c.user_id, secretName(c.id, 'client'));
    if (c.oauth?.client_secret_id) ctx.secrets.delete(c.oauth.client_secret_id);
  }
  ctx.store.exec('DELETE FROM mcp_oauth_flows WHERE connection_id = ?', c.id);
  patchOAuth(ctx, c.id, { status: 'disconnected', expires_at: null, has_refresh: false, granted_scope: undefined, connected_at: undefined });
  ctx.audit(c.user_id, 'mcp.oauth.revoked', { connection: c.id, name: c.name, revokedAtService });
  return { revokedAtService, detail: revokedAtService ? 'Toegang ingetrokken bij de dienst en lokaal gewist.' : detail || 'Lokaal gewist.' };
}

/** Pre-registered OAuth app (GitHub/Slack/Google): store client id + optional secret. */
export function setOAuthClient(ctx: Ctx, c: ConnectionRow, clientId: string, clientSecret?: string) {
  const id = String(clientId || '').trim();
  if (!id) {
    patchOAuth(ctx, c.id, { preregistered: false, client_id: undefined });
    return;
  }
  if (id.length > 300) throw bad('Client-ID is te lang');
  let secretId = c.oauth?.client_secret_id;
  if (clientSecret) secretId = ctx.secrets.set(c.user_id, secretName(c.id, 'client_secret'), String(clientSecret).slice(0, 2000));
  deleteSecret(ctx, c.user_id, secretName(c.id, 'client'));
  patchOAuth(ctx, c.id, { preregistered: true, client_id: id, client_secret_id: secretId });
}

/**
 * Use the own OAuth client of another connection of the same user (Gmail, Agenda, Drive and Sheets share one Google client).
 * Only between connections whose templates are in the same guide group; the secret is copied vault-to-vault and
 * never leaves the server.
 */
export function copyOAuthClient(ctx: Ctx, from: ConnectionRow, to: ConnectionRow) {
  const group = entryForConn(to)?.oauthAppGuide?.group;
  if (from.user_id !== to.user_id || from.id === to.id || !group || entryForConn(from)?.oauthAppGuide?.group !== group) throw bad('Deze client kan hier niet opnieuw worden gebruikt.');
  const o = from.oauth || ({} as OAuthState);
  if (!o.preregistered || !o.client_id) throw bad('Die koppeling heeft nog geen eigen OAuth-client.');
  const secret = o.client_secret_id && ctx.secrets.owner(o.client_secret_id) === from.user_id ? ctx.secrets.get(o.client_secret_id) : null;
  setOAuthClient(ctx, to, o.client_id, secret || undefined);
}

/** Other connections of this user whose own OAuth client can be reused here (same guide group, client present). */
export function sharedOAuthClients(ctx: Ctx, c: ConnectionRow): ConnectionRow[] {
  const group = entryForConn(c)?.oauthAppGuide?.group;
  if (!group) return [];
  return ctx.store.find<ConnectionRow>('mcp_connections', { user_id: c.user_id }).filter((x) => x.id !== c.id && x.oauth?.preregistered && x.oauth?.client_id && entryForConn(x)?.oauthAppGuide?.group === group);
}

/** Secret names owned by a connection (for cleanup and tests). */
export function connectionSecretPrefix(connId: string) {
  return `mcp:${connId}:`;
}
