/** A bot's computer (browser, own server): what the server (server/modules/browser) and the page both use. */

/** "Verbinding testen" of an own server over SSH. */
export interface RemoteTestResult {
  ok: boolean;
  host: string;
  port: number;
  username: string;
  fingerprint: string | null;
  trusted: boolean;
  mismatch?: boolean;
  expected?: string | null;
  windows?: boolean;
  os?: string;
  docker?: { installed: boolean; usable: boolean; version: string | null };
  message?: string;
  error?: string;
}

/** "accounts.google.com" / ".google.com" / a URL → "google.com" (rough registrable domain; IPs and localhost as is). */
export function siteOf(input: string): string | null {
  let d = String(input || '').trim().toLowerCase();
  if (d.includes('://')) {
    try {
      d = new URL(d).hostname;
    } catch {
      return null;
    }
  }
  d = d.replace(/^\.+/, '').replace(/\.$/, '');
  if (!d || /[^a-z0-9.\-:[\]]/.test(d)) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(d) || d.includes(':') || !d.includes('.')) return d;
  const parts = d.split('.');
  if (parts.length <= 2) return d;
  const sld = parts[parts.length - 2];
  const tld = parts[parts.length - 1];
  const n = tld.length === 2 && ['co', 'com', 'net', 'org', 'gov', 'ac', 'edu', 'or', 'ne', 'go'].includes(sld) ? 3 : 2;
  return parts.slice(-n).join('.');
}
