/**
 * Pure helpers of the in-app bot browser (desktop/inapp-browser.ts), without Electron at run time so tests can load
 * them in plain Node.
 */
import type { Cookie, CookiesSetDetails } from 'electron';

/** Electron's own marks in the user agent (sites treat an "Electron" browser as an embedded app, e.g. sign-in pages). */
export function cleanUserAgent(ua: string): string {
  return ua.replace(/\s(?:teambot|TeamBot|Electron)\/\S+/g, '').replace(/\s{2,}/g, ' ').trim();
}

/** Electron's cookie → a CDP Network.Cookie (Storage.getCookies). */
export function toCdpCookie(c: Cookie) {
  const sameSite = c.sameSite === 'strict' ? 'Strict' : c.sameSite === 'lax' ? 'Lax' : c.sameSite === 'no_restriction' ? 'None' : undefined;
  return {
    name: c.name,
    value: c.value,
    domain: c.domain || '',
    path: c.path || '/',
    expires: c.session || !c.expirationDate ? -1 : c.expirationDate,
    size: c.name.length + c.value.length,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    session: !!c.session,
    ...(sameSite ? { sameSite } : {}),
  };
}

/** A CDP CookieParam (Storage.setCookies) → Electron's cookies.set details. */
export function fromCdpCookie(c: any): CookiesSetDetails {
  const domain = String(c.domain || '');
  const host = domain.replace(/^\./, '');
  const url = typeof c.url === 'string' && c.url ? c.url : `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`;
  return {
    url,
    name: String(c.name ?? ''),
    value: String(c.value ?? ''),
    ...(domain.startsWith('.') ? { domain } : {}),
    path: c.path || '/',
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    ...(typeof c.expires === 'number' && c.expires > 0 ? { expirationDate: c.expires } : {}),
    sameSite: c.sameSite === 'Strict' ? 'strict' : c.sameSite === 'Lax' ? 'lax' : c.sameSite === 'None' ? 'no_restriction' : 'unspecified',
  };
}
