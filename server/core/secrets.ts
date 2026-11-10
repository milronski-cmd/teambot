import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type DB, all, get, run, newId, now } from './db.js';

/**
 * Secrets are encrypted at rest with AES-256-GCM. The master key comes from
 * TEAMBOT_MASTER_KEY (base64, 32 bytes) or a key file in the data dir that is
 * created on first start. The desktop shell can wrap that file with the OS
 * keychain (Electron safeStorage / Windows DPAPI). Secret values are never
 * returned by the HTTP API and never written to logs.
 */
export class Secrets {
  private key: Buffer;

  constructor(private db: DB, dataDir: string, keyOverride?: Buffer) {
    this.key = keyOverride || Secrets.loadKey(dataDir);
  }

  static loadKey(dataDir: string): Buffer {
    if (process.env.TEAMBOT_MASTER_KEY) {
      const k = Buffer.from(process.env.TEAMBOT_MASTER_KEY, 'base64');
      if (k.length !== 32) throw new Error('TEAMBOT_MASTER_KEY must be 32 bytes base64');
      return k;
    }
    if (fs.existsSync(path.join(dataDir, 'master.key.dpapi')))
      throw new Error('De sleutels in deze datamap zijn beveiligd met Windows (DPAPI). Start TeamBot via de desktop-app, of zet TEAMBOT_MASTER_KEY.');
    const file = path.join(dataDir, 'master.key');
    if (fs.existsSync(file)) return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    const k = crypto.randomBytes(32);
    fs.writeFileSync(file, k.toString('base64'), { mode: 0o600 });
    return k;
  }

  encrypt(plain: string): string {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
  }

  decrypt(blob: string): string {
    const [v, iv, tag, data] = blob.split(':');
    if (v !== 'v1') throw new Error('Unknown secret format');
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  }

  /** Create or replace a named secret for a user. Returns its id. */
  set(userId: string, name: string, value: string): string {
    rememberSecret(value);
    const existing = get<{ id: string }>(this.db, 'SELECT id FROM secrets WHERE user_id = ? AND name = ?', userId, name);
    const enc = this.encrypt(value);
    if (existing) {
      run(this.db, 'UPDATE secrets SET value_enc = ?, updated_at = ? WHERE id = ?', enc, now(), existing.id);
      return existing.id;
    }
    const id = newId('sec_');
    run(this.db, 'INSERT INTO secrets (id, user_id, name, value_enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, userId, name, enc, now(), now());
    return id;
  }

  get(id: string | null | undefined): string | null {
    if (!id) return null;
    const row = get<{ value_enc: string }>(this.db, 'SELECT value_enc FROM secrets WHERE id = ?', id);
    if (!row) return null;
    try {
      return rememberSecret(this.decrypt(row.value_enc));
    } catch {
      return null;
    }
  }

  /** Every secret value of one user (decrypted), e.g. to scrub them from that user's export. Never send these out. */
  valuesOf(userId: string): string[] {
    const out: string[] = [];
    for (const r of all<{ id: string }>(this.db, 'SELECT id FROM secrets WHERE user_id = ?', userId)) {
      const v = this.get(r.id);
      if (v) out.push(...secretParts(v));
    }
    return out;
  }

  getByName(userId: string, name: string): string | null {
    const row = get<{ id: string }>(this.db, 'SELECT id FROM secrets WHERE user_id = ? AND name = ?', userId, name);
    return row ? this.get(row.id) : null;
  }

  owner(id: string): string | null {
    return get<{ user_id: string }>(this.db, 'SELECT user_id FROM secrets WHERE id = ?', id)?.user_id ?? null;
  }

  delete(id: string) {
    run(this.db, 'DELETE FROM secrets WHERE id = ?', id);
  }

  list(userId: string): { id: string; name: string; updated_at: string }[] {
    return all(this.db, 'SELECT id, name, updated_at FROM secrets WHERE user_id = ? ORDER BY name', userId);
  }
}

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_\-]{16,}/g,
  /sk-ant-[A-Za-z0-9_\-]{16,}/g,
  /AIza[0-9A-Za-z_\-]{30,}/g,
  /gh[pousr]_[A-Za-z0-9]{30,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g, // telegram bot tokens
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /tbscim_[A-Za-z0-9_-]{20,}/g, // SCIM provisioning tokens
  // Key formats of other AI services and platforms (Groq, Hugging Face, xAI, Perplexity, NVIDIA, Cerebras, Fireworks,
  // GitHub fine-grained, AWS, Stripe), TeamBot's own first-run setup code, PEM private keys and bearer tokens.
  /\b(?:gsk|hf|fw)_[A-Za-z0-9]{20,}/g,
  /\b(?:xai|pplx|nvapi|csk)-[A-Za-z0-9_-]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /tb(?:setup|mcp)_[A-Za-z0-9_-]{16,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /(?<=\bBearer\s+)[A-Za-z0-9._~+/=-]{20,}/g,
];

/**
 * Secret values this process has stored or read (Secrets.set/get, plus rememberSecret). redact() masks them wherever
 * they show up, also when they do not look like a known key format (a proxy password, a random token): a provider or
 * server that echoes a key back in an error, a log line or an audit entry can then never carry it.
 */
const KNOWN = new Set<string>();
let knownSorted: string[] | null = null;
const MAX_KNOWN = 5000;
const SECRETISH_KEY = /pass|secret|token|key|auth|cred|private|cookie|session|pin|otp|sig/i;

/** Only values that cannot be ordinary words or tiny numbers (masking those would hide normal text). */
function worthMasking(v: string): boolean {
  if (v.length < 8 || v.length > 20_000) return false;
  if (/^\s|\s$/.test(v)) return false;
  if (/^[A-Za-z]+$/.test(v) && v.length < 16) return false;
  return true;
}

/** The parts of a stored secret worth masking: the value itself, or the secret-looking fields of a JSON value. */
function secretParts(value: string): string[] {
  const out: string[] = [];
  const t = value.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      const walk = (x: any, key = '') => {
        if (typeof x === 'string') {
          if (SECRETISH_KEY.test(key) && worthMasking(x)) out.push(x);
        } else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) walk(v, Array.isArray(x) ? key : k);
      };
      walk(JSON.parse(t));
      return out;
    } catch {
      /* not JSON: mask the whole value */
    }
  }
  if (worthMasking(value)) out.push(value);
  return out;
}

/** Remember a secret value so redact() masks it from now on (returns the value unchanged). */
export function rememberSecret<T extends string | null | undefined>(value: T): T {
  if (typeof value !== 'string' || !value) return value;
  for (const p of secretParts(value)) {
    if (KNOWN.size >= MAX_KNOWN) break;
    if (KNOWN.has(p)) continue;
    KNOWN.add(p);
    // The same value inside JSON text (an audit entry, an exported file) is escaped.
    const esc = JSON.stringify(p).slice(1, -1);
    if (esc !== p) KNOWN.add(esc);
    knownSorted = null;
  }
  return value;
}

const longestFirst = (values: Iterable<string>) => [...new Set(values)].filter((v) => v && v.length >= 8).sort((a, b) => b.length - a.length);

function replaceAll(text: string, sorted: string[]): string {
  let t = text;
  for (const v of sorted) if (t.includes(v)) t = t.split(v).join('…[verborgen]');
  return t;
}

/** Replace each of these exact values in a text (longest first, so a value inside another one is still covered). */
export function scrubValues(text: string, values: Iterable<string>): string {
  return replaceAll(text, longestFirst(values));
}

/** Mask anything that looks like a credential, and every secret value TeamBot knows, before it reaches logs/audit. */
export function redact(text: string): string {
  let t = String(text);
  if (KNOWN.size) t = replaceAll(t, (knownSorted ||= longestFirst(KNOWN)));
  for (const p of SECRET_PATTERNS) t = t.replace(p, (m) => m.slice(0, 4) + '…[verborgen]');
  return t;
}
