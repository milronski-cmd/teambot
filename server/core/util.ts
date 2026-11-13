/** Small helpers every part of the server needs; one copy of each. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';

/**
 * True when an address or host name only reaches this computer: localhost and *.localhost, 127.0.0.0/8 (also as
 * ::ffff:127.x) and ::1, with or without brackets or a trailing dot.
 */
export function isLoopbackHost(host: string | null | undefined): boolean {
  let h = String(host || '').trim().toLowerCase();
  if (h.startsWith('[') && h.includes(']')) h = h.slice(1, h.indexOf(']'));
  h = h.replace(/\.$/, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.startsWith('::ffff:')) h = h.slice(7);
  if (net.isIPv4(h)) return h.split('.')[0] === '127';
  if (net.isIPv6(h)) return h === '::1' || /^0*:0*:0*:0*:0*:0*:0*:0*1$/.test(h);
  return false;
}

/** True when a URL (a model server, a relay) points at this computer; false for an address that is no URL. */
export function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** SHA-256 of a text or bytes, as hex. */
export const sha256 = (data: string | Buffer): string => crypto.createHash('sha256').update(data).digest('hex');

/** SHA-256 of a file on disk, read as a stream (also for big model files), as hex. */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

/**
 * A file of a known size and SHA-256 at `dest`: kept when it is already there, else downloaded next to it (`.part`),
 * checked and only then moved into place. `onBytes` counts progress (a file that was there counts at once).
 * True when it was downloaded.
 */
export async function fetchVerified(fetchImpl: typeof fetch, f: { url: string; size: number; sha256: string }, dest: string, o: { timeoutMs: number; onBytes(n: number): void }): Promise<boolean> {
  if (fs.existsSync(dest) && fs.statSync(dest).size === f.size && (await sha256File(dest)) === f.sha256) {
    o.onBytes(f.size);
    return false;
  }
  const part = dest + '.part';
  const r = await fetchImpl(f.url, { redirect: 'follow', signal: AbortSignal.timeout(o.timeoutMs) });
  if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(part);
  let n = 0;
  try {
    const reader = r.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > f.size) throw new Error('groter dan verwacht');
      hash.update(value);
      o.onBytes(value.byteLength);
      if (!out.write(value)) await new Promise((res) => out.once('drain', res));
    }
  } finally {
    await new Promise((res) => out.end(res));
  }
  if (n !== f.size || hash.digest('hex') !== f.sha256) {
    fs.rmSync(part, { force: true });
    throw new Error('de controle van het bestand klopte niet');
  }
  fs.renameSync(part, dest);
  return true;
}

/** A random secret for links, tokens and codes (URL-safe). */
export const randomToken = (bytes = 32): string => crypto.randomBytes(bytes).toString('base64url');

/** Is there a file at this path (false for a folder, a missing path or one that cannot be read)? */
export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Is there a folder at this path? */
export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Text on one line (whitespace collapsed), at most `n` characters; text that was cut ends in "…". */
export function oneLine(s: unknown, n: number): string {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim();
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
}

/** A text field from outside (a tool call, a request) on one line and at most `max` characters; '' when it is no text. */
export const inputLine = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** A text field from outside that may have several lines (Windows line ends made plain), at most `max` characters. */
export const inputText = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim().slice(0, max) : '');

/** Fixed-window counters per key (login tries, pairing codes, test messages). In memory and per process. */
export class Limiter {
  private hits = new Map<string, { n: number; reset: number }>();

  constructor(private max: number, private windowMs: number) {}

  private entry(key: string) {
    const t = Date.now();
    let h = this.hits.get(key);
    if (!h || h.reset <= t) {
      h = { n: 0, reset: t + this.windowMs };
      this.hits.set(key, h);
      if (this.hits.size > 5000) for (const [k, v] of this.hits) if (v.reset <= t) this.hits.delete(k);
    }
    return h;
  }

  /** Count one hit. Returns false when the key went over its limit. */
  hit(key: string): boolean {
    const h = this.entry(key);
    h.n++;
    return h.n <= this.max;
  }

  /** True when the key already used up its window. */
  blocked(key: string): boolean {
    const h = this.hits.get(key);
    return !!h && h.reset > Date.now() && h.n >= this.max;
  }

  retryAfterSec(key: string): number {
    const h = this.hits.get(key);
    return h ? Math.max(1, Math.ceil((h.reset - Date.now()) / 1000)) : 0;
  }
}
