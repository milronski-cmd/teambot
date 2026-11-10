import http from 'node:http';
import crypto from 'node:crypto';

/**
 * Minimal OpenID Connect provider for tests (in-process, 127.0.0.1): discovery, JWKS, an authorize endpoint that
 * signs the "next user" in without a login page, and a token endpoint that checks client auth + PKCE and returns an
 * RS256-signed ID token. `tamper` lets a test break one property of the next ID token.
 */
export interface FakeUser {
  sub: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  preferred_username?: string;
}
export interface Tamper {
  nonce?: string;
  aud?: string;
  iss?: string;
  /** Seconds from now; negative = already expired. */
  exp?: number;
  /** Sign with a key that is not in the JWKS. */
  foreignKey?: boolean;
}

export interface FakeIdp {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Who signs in at the next /authorize. */
  next(user: FakeUser, tamper?: Tamper): void;
  /** Requests the provider saw (for assertions). */
  authorizeRequests: URLSearchParams[];
  tokenRequests: { params: URLSearchParams; auth: string }[];
  close(): Promise<void>;
}

const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url');

export async function startFakeIdp(
  clientId = 'teambot-test-client',
  clientSecret = 'fake-client-secret-' + crypto.randomBytes(12).toString('hex'),
  authMethods: string[] = ['client_secret_basic', 'client_secret_post'],
): Promise<FakeIdp> {
  const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const foreign = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'test-key-1';
  const jwk = { ...(key.publicKey.export({ format: 'jwk' }) as any), kid, alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { user: FakeUser; tamper: Tamper; nonce: string; challenge: string; redirectUri: string; clientId: string }>();
  let nextUser: FakeUser = { sub: 'nobody' };
  let nextTamper: Tamper = {};
  const authorizeRequests: URLSearchParams[] = [];
  const tokenRequests: { params: URLSearchParams; auth: string }[] = [];
  let issuer = '';

  const sign = (payload: any, foreignKey = false) => {
    const input = `${b64({ alg: 'RS256', typ: 'JWT', kid })}.${b64(payload)}`;
    const sig = crypto.sign('sha256', Buffer.from(input), foreignKey ? foreign.privateKey : key.privateKey).toString('base64url');
    return `${input}.${sig}`;
  };
  const json = (res: http.ServerResponse, status: number, body: any) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', issuer);
    if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      return json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        userinfo_endpoint: `${issuer}/userinfo`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        scopes_supported: ['openid', 'email', 'profile'],
        token_endpoint_auth_methods_supported: authMethods,
        code_challenge_methods_supported: ['S256'],
        claims_supported: ['sub', 'email', 'email_verified', 'name'],
      });
    }
    if (req.method === 'GET' && url.pathname === '/jwks') return json(res, 200, { keys: [jwk] });
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const q = url.searchParams;
      authorizeRequests.push(q);
      const redirectUri = q.get('redirect_uri') || '';
      if (q.get('client_id') !== clientId || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !redirectUri) {
        return json(res, 400, { error: 'invalid_request' });
      }
      const code = crypto.randomBytes(16).toString('hex');
      codes.set(code, { user: nextUser, tamper: nextTamper, nonce: q.get('nonce') || '', challenge: q.get('code_challenge')!, redirectUri, clientId });
      const back = new URL(redirectUri);
      back.searchParams.set('code', code);
      if (q.get('state')) back.searchParams.set('state', q.get('state')!);
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const p = new URLSearchParams(body);
      const auth = String(req.headers.authorization || '');
      tokenRequests.push({ params: p, auth });
      let id = p.get('client_id');
      let secret = p.get('client_secret');
      const used = auth.startsWith('Basic ') ? 'client_secret_basic' : 'client_secret_post';
      if (!authMethods.includes(used)) return json(res, 401, { error: 'invalid_client', error_description: `${used} not allowed` });
      if (auth.startsWith('Basic ')) {
        const [a, b] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
        id = decodeURIComponent(a);
        secret = decodeURIComponent(b);
      }
      if (id !== clientId || secret !== clientSecret) return json(res, 401, { error: 'invalid_client' });
      const c = codes.get(p.get('code') || '');
      codes.delete(p.get('code') || '');
      if (!c || p.get('grant_type') !== 'authorization_code' || p.get('redirect_uri') !== c.redirectUri) return json(res, 400, { error: 'invalid_grant' });
      const verifier = p.get('code_verifier') || '';
      if (crypto.createHash('sha256').update(verifier).digest('base64url') !== c.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE' });
      const t = Math.floor(Date.now() / 1000);
      const claims: any = {
        iss: c.tamper.iss ?? issuer,
        sub: c.user.sub,
        aud: c.tamper.aud ?? clientId,
        iat: t,
        exp: t + (c.tamper.exp ?? 300),
        nonce: c.tamper.nonce ?? c.nonce,
      };
      for (const k of ['email', 'email_verified', 'name', 'preferred_username'] as const) if (c.user[k] !== undefined) claims[k] = c.user[k];
      return json(res, 200, { access_token: 'at_' + crypto.randomBytes(12).toString('hex'), token_type: 'Bearer', expires_in: 3600, scope: 'openid email profile', id_token: sign(claims, c.tamper.foreignKey) });
    }
    json(res, 404, { error: 'not_found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as any;
  issuer = `http://127.0.0.1:${addr.port}`;
  return {
    issuer,
    clientId,
    clientSecret,
    next(user, tamper = {}) {
      nextUser = user;
      nextTamper = tamper;
    },
    authorizeRequests,
    tokenRequests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
