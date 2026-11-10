import { randomToken, sha256 } from '../../core/util.js';

export { randomToken, sha256 };
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../../core/types.js';
import { HttpError, bad } from '../../core/http.js';
import { redact } from '../../core/secrets.js';
import { assertPublicUrl } from '../../tools/builtin/web.js';
import type { KV } from './db.js';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

export function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, rej) => {
      timer = setTimeout(() => rej(new Error(msg)), ms);
      timer.unref?.();
    }),
  ]);
}

/** Clean an error message for users/logs: no secrets, no huge stack dumps. */
export function cleanError(e: any, secrets: string[] = []): string {
  let m = String(e?.message || e || 'Onbekende fout');
  for (const s of secrets) if (s && s.length >= 6) m = m.split(s).join('[verborgen]');
  return redact(m).slice(0, 800);
}

export function maskSecrets(text: string, secrets: string[]): string {
  let t = text;
  for (const s of secrets) if (s && s.length >= 6) t = t.split(s).join('[verborgen]');
  return redact(t);
}

// ---------- environment variables / headers backed by ctx.secrets ----------

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'keep-alive', 'proxy-authorization', 'cookie2', 'mcp-session-id', 'mcp-protocol-version']);

export interface KVInput {
  name: string;
  value?: string;
  /** true = value is secret (stored in ctx.secrets, never returned). */
  secret?: boolean;
  /** Reference to an existing named user secret instead of a value. */
  secret_name?: string;
  /** Prefix for the secret value (e.g. "Bearer "); only for headers. */
  prefix?: string;
}

/**
 * Store env vars / headers. Secret values go into ctx.secrets under
 * `mcp:<connId>:<kind>:<NAME>`; the row only keeps a secret id/name.
 * A secret entry sent without a value keeps the existing secret.
 */
export function storeKV(ctx: Ctx, userId: string, connId: string, kind: 'env' | 'header', input: any, existing: KV[] = []): KV[] {
  if (input === undefined) return existing;
  if (!Array.isArray(input)) throw bad(`${kind === 'env' ? 'Omgevingsvariabelen' : 'Headers'} moeten een lijst zijn`);
  if (input.length > 50) throw bad('Te veel items (max 50)');
  const out: KV[] = [];
  const seen = new Set<string>();
  const ownSecrets = new Set(ctx.secrets.list(userId).map((s) => s.name));
  for (const raw of input as KVInput[]) {
    const name = String(raw?.name ?? '').trim();
    if (!name) continue;
    if (kind === 'env' && !ENV_NAME.test(name)) throw bad(`Ongeldige naam voor omgevingsvariabele: ${name}`);
    if (kind === 'header' && (!HEADER_NAME.test(name) || FORBIDDEN_HEADERS.has(name.toLowerCase()))) throw bad(`Deze header kun je niet instellen: ${name}`);
    const key = kind === 'header' ? name.toLowerCase() : name;
    if (seen.has(key)) throw bad(`Dubbele naam: ${name}`);
    seen.add(key);
    const prev = existing.find((e) => (kind === 'header' ? e.name.toLowerCase() === key : e.name === name));
    const value = raw.value === undefined || raw.value === null ? undefined : String(raw.value);
    if (value !== undefined && value.length > 16_000) throw bad(`Waarde van ${name} is te lang`);
    if (kind === 'header' && value && /[\r\n]/.test(value)) throw bad(`Header ${name} bevat een regeleinde`);
    if (raw.secret_name) {
      const sn = String(raw.secret_name);
      if (!ownSecrets.has(sn) || sn.startsWith('provider:') || sn.startsWith('mcp:')) throw bad(`Geheim "${sn}" bestaat niet`);
      out.push({ name, secret_name: sn });
    } else if (raw.secret) {
      if (value) {
        const full = (raw.prefix ? String(raw.prefix) : '') + value;
        const id = ctx.secrets.set(userId, `mcp:${connId}:${kind}:${name}`, full);
        out.push({ name, secret_id: id });
      } else if (prev?.secret_id) out.push({ name, secret_id: prev.secret_id });
      else if (prev?.secret_name) out.push({ name, secret_name: prev.secret_name });
      else throw bad(`Geef een waarde voor ${name}`);
    } else {
      out.push({ name, value: value ?? '' });
    }
  }
  // Remove inline secrets that are no longer referenced.
  for (const e of existing) if (e.secret_id && !out.some((o) => o.secret_id === e.secret_id)) ctx.secrets.delete(e.secret_id);
  return out;
}

/** Resolve values (incl. secrets) for use at runtime only. */
export function resolveKV(ctx: Ctx, userId: string, list: KV[]): { values: Record<string, string>; secrets: string[]; missing: string[] } {
  const values: Record<string, string> = {};
  const secrets: string[] = [];
  const missing: string[] = [];
  for (const e of list || []) {
    if (e.secret_id) {
      const v = ctx.secrets.owner(e.secret_id) === userId ? ctx.secrets.get(e.secret_id) : null;
      if (v === null) missing.push(e.name);
      else {
        values[e.name] = v;
        secrets.push(v, v.replace(/^(Bearer|Basic|token)\s+/i, ''));
      }
    } else if (e.secret_name) {
      const v = ctx.secrets.getByName(userId, e.secret_name);
      if (v === null) missing.push(e.name);
      else {
        values[e.name] = v;
        secrets.push(v, v.replace(/^(Bearer|Basic|token)\s+/i, ''));
      }
    } else values[e.name] = e.value ?? '';
  }
  return { values, secrets, missing };
}

/** API view: names and plain values only. */
export function viewKV(list: KV[]) {
  return (list || []).map((e) =>
    e.secret_id || e.secret_name ? { name: e.name, secret: true, secret_name: e.secret_name, set: true } : { name: e.name, value: e.value ?? '', secret: false },
  );
}

export function deleteKVSecrets(ctx: Ctx, list: KV[]) {
  for (const e of list || []) if (e.secret_id) ctx.secrets.delete(e.secret_id);
}

// ---------- SSRF-guarded fetch ----------

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * fetch() that checks every hop against the SSRF guard. Redirects are followed
 * manually (max 5); authorization headers are dropped on cross-origin hops.
 */
export function guardedFetch(allowPrivate: boolean): FetchLike {
  return async (input, init = {}) => {
    let url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as any).url;
    if (init.redirect === 'manual' || init.redirect === 'error') {
      await assertPublicUrl(url, allowPrivate);
      return fetch(url, init);
    }
    let opts: RequestInit = { ...init, redirect: 'manual' };
    for (let hop = 0; hop <= 5; hop++) {
      await assertPublicUrl(url, allowPrivate);
      const res = await fetch(url, opts);
      const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!loc) return res;
      await res.body?.cancel().catch(() => {});
      const next = new URL(loc, url);
      if (new URL(url).origin !== next.origin) {
        const h = new Headers(opts.headers);
        h.delete('authorization');
        h.delete('cookie');
        opts = { ...opts, headers: h };
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && (opts.method || 'GET').toUpperCase() !== 'GET')) {
        opts = { ...opts, method: 'GET', body: undefined };
      }
      url = next.href;
    }
    throw new Error('Te veel doorverwijzingen');
  };
}

/** May this user reach localhost/LAN addresses? Desktop owner or server admins only. */
export function mayUsePrivateNetwork(ctx: Ctx, userId: string): boolean {
  const u = ctx.store.user(userId);
  if (!u) return false;
  if (ctx.config.mode === 'desktop') return true;
  return u.role === 'owner' || u.role === 'admin';
}

/** May this user run local programs (stdio servers) on the host? */
export function mayUseStdio(ctx: Ctx, userId: string): boolean {
  const u = ctx.store.user(userId);
  if (!u) return false;
  if (ctx.config.mode === 'desktop' || u.role !== 'member') return true;
  return !!ctx.store.getSetting('', 'mcpMembersMayRunLocal', false);
}

export function forbiddenErr(msg: string) {
  return new HttpError(403, msg);
}

// ---------- processes ----------

/** Kill a process and all its children (Windows: taskkill /T /F). */
export function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    try {
      if (process.platform === 'win32') {
        const k = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        const t = setTimeout(resolve, 5000);
        k.on('exit', () => (clearTimeout(t), resolve()));
        k.on('error', () => (clearTimeout(t), resolve()));
      } else {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* gone */
        }
        resolve();
      }
    } catch {
      resolve();
    }
  });
}

export function pidAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

/** Short safe slug for tool names: lowercase [a-z0-9_]. */
export function slugify(s: string): string {
  const out = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  return out || 'app';
}

/** Is a command available on PATH (honest "npx/uvx niet gevonden" in the catalogue). */
export function commandOnPath(cmd: string): boolean {
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd);
  const dirs = String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase())] : [''];
  for (const d of dirs) for (const e of exts) if (fs.existsSync(path.join(d, cmd + e))) return true;
  return false;
}
