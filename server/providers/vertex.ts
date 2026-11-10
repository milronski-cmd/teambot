import crypto from 'node:crypto';
import { ProviderError, errorFromResponse, networkError } from './common.js';

/**
 * Google Vertex AI access tokens without the Google SDK: a service-account JSON key is exchanged for an OAuth access
 * token (JWT bearer grant, RS256 signed with node:crypto). A pasted access token ("ya29.…") is used as is; it expires
 * after about an hour.
 */

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
}

export function parseServiceAccount(secret: string): ServiceAccount | null {
  const s = secret.trim();
  if (!s.startsWith('{')) return null;
  try {
    const j = JSON.parse(s);
    if (j?.type === 'service_account' && typeof j.client_email === 'string' && typeof j.private_key === 'string') return { client_email: j.client_email, private_key: j.private_key, project_id: j.project_id };
  } catch {
    /* not JSON */
  }
  throw new ProviderError('Vertex AI: het sleutelbestand is geen geldig service-account-JSON (type "service_account" met client_email en private_key).', 401, false, '', 'auth');
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export function serviceAccountJwt(sa: ServiceAccount, now = Math.floor(Date.now() / 1000), aud = GOOGLE_TOKEN_URL): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud, iat: now, exp: now + 3600 }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), sa.private_key);
  return `${header}.${claims}.${b64url(sig)}`;
}

/** Token source with caching (refreshes five minutes before expiry). `tokenUrl` is only overridden in tests. */
export function vertexTokenSource(secret: string | null, opts: { tokenUrl?: string; label?: string } = {}): () => Promise<string> {
  const label = opts.label || 'Vertex AI';
  if (!secret) return async () => {
    throw new ProviderError(`${label}: geen sleutel ingesteld`, 401, false, '', 'auth');
  };
  const sa = parseServiceAccount(secret);
  if (!sa) {
    const token = secret.trim();
    return async () => token;
  }
  let cached: { token: string; until: number } | null = null;
  return async () => {
    if (cached && cached.until > Date.now()) return cached.token;
    const url = opts.tokenUrl || GOOGLE_TOKEN_URL;
    const assertion = serviceAccountJwt(sa, Math.floor(Date.now() / 1000), GOOGLE_TOKEN_URL);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw networkError(label, e);
    }
    if (!res.ok) {
      const err = await errorFromResponse(res, label);
      // invalid_grant = key revoked/deleted or the clock is off.
      if (/invalid_grant|invalid_client|unauthorized_client/i.test(err.body)) err.category = 'auth';
      throw err;
    }
    const j: any = await res.json();
    if (!j?.access_token) throw new ProviderError(`${label}: geen toegangstoken ontvangen`, 401, false, '', 'auth');
    cached = { token: j.access_token, until: Date.now() + (Number(j.expires_in) || 3600) * 1000 - 300_000 };
    return cached.token;
  };
}

/** Project id from the pasted service account, so the user does not have to type it twice. */
export function projectFromSecret(secret: string | null): string | undefined {
  try {
    return secret ? parseServiceAccount(secret)?.project_id : undefined;
  } catch {
    return undefined;
  }
}
