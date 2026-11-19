/**
 * TeamBot's own OAuth apps, for services that do not let an app register itself (no dynamic client registration):
 * Google ("Desktop app" client, used by google.ts) and GitHub (OAuth App, used by oauth.ts for every connection whose
 * login runs at github.com). With them a user connects with one login; without them, TeamBot leads the user through
 * making an own app once (Apps › the service › Inloggen).
 *
 * For a desktop app the client "secret" is not a secret (Google and GitHub: installed applications cannot keep
 * secrets); it identifies the app, and the login itself is protected by PKCE and the redirect to this computer. It is
 * shipped in the app but kept out of the source: scripts/build.mjs puts it in at build time (__TEAMBOT_APPS__) from
 * TEAMBOT_<NAME>_CLIENT_FILE or TEAMBOT_<NAME>_CLIENT_ID and _SECRET. The same variables at run time win (tests). A
 * build without them, such as one made from the public source, falls back to the own app.
 *
 * The publisher makes them once:
 *  - Google: console.cloud.google.com, a project "TeamBot" with the Search Console, Merchant, Google Ads, Analytics
 *    Data/Admin, Gmail, Calendar, Drive and Sheets APIs on; Google Auth Platform: consent screen "TeamBot", audience
 *    "External", home page, privacy page and domain, then "Publish app" (in "Testing" a login ends after 7 days).
 *    Unverified, Google shows "deze app is niet geverifieerd" and allows 100 users; verification lifts both (Gmail and
 *    Drive reading are "restricted" scopes: a yearly security assessment). Clients › "Desktop app" › "Download JSON".
 *  - GitHub: Settings › Developer settings › OAuth Apps › New, callback http://127.0.0.1/api/public/mcp/oauth/callback
 *    (GitHub accepts any port on a loopback address), "Expire user access tokens" on; then a client secret.
 */
export interface TeambotApp {
  clientId: string;
  clientSecret: string;
}

declare const __TEAMBOT_APPS__: Record<string, TeambotApp> | undefined;
const BUILT: Record<string, TeambotApp> = typeof __TEAMBOT_APPS__ !== 'undefined' ? __TEAMBOT_APPS__ : {};

/** Login servers (their issuer) where TeamBot brings its own app, and which one. */
const BY_ISSUER: Record<string, string> = { 'https://github.com/login/oauth': 'github' };

export function teambotApp(name: string): TeambotApp | null {
  const env = `TEAMBOT_${name.toUpperCase()}_CLIENT`;
  if (process.env[`${env}_ID`]) return { clientId: process.env[`${env}_ID`]!, clientSecret: process.env[`${env}_SECRET`] || '' };
  return BUILT[name]?.clientId ? BUILT[name] : null;
}

const nameFor = (authorizationServer: string | undefined | null) => (authorizationServer ? BY_ISSUER[authorizationServer.replace(/\/+$/, '')] : undefined);

/** TeamBot's own app for the login server of a connection (its discovered authorization server), if there is one. */
export function teambotAppFor(authorizationServer: string | undefined | null): TeambotApp | null {
  const name = nameFor(authorizationServer);
  return name ? teambotApp(name) : null;
}

/**
 * Withdraw the owner's permission at the service, for a login server without a revocation address where TeamBot owns
 * the app (GitHub: the app removes its own grant). null: not possible here; true/false: whether the service agreed.
 */
export async function revokeWithTeambotApp(authorizationServer: string | undefined | null, accessToken: string, fetchFn: (url: string, init: RequestInit) => Promise<Response>): Promise<boolean | null> {
  const name = nameFor(authorizationServer);
  const app = name ? teambotApp(name) : null;
  if (name !== 'github' || !app?.clientSecret || !accessToken) return null;
  const auth = 'Basic ' + Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64');
  const res = await fetchFn(`https://api.github.com/applications/${encodeURIComponent(app.clientId)}/grant`, {
    method: 'DELETE',
    headers: { authorization: auth, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
    body: JSON.stringify({ access_token: accessToken }),
    signal: AbortSignal.timeout(15_000),
  });
  await res.body?.cancel().catch(() => {});
  return res.status === 204;
}
