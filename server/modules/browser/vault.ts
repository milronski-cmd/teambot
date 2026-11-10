import crypto from 'node:crypto';
import type { Agent, Ctx, User } from '../../core/types.js';
import { newId, now } from '../../core/db.js';
import { HttpLike } from './service.js';
import { newImportHandle, parseExport, VaultImportError, type ImportFormat } from './vault-import.js';

/**
 * Login vault ("Kluis"): site logins of the owner (exact origins, username, password, optional TOTP secret). The
 * credential fields are encrypted with the master key of the secret store (AES-256-GCM, `ctx.secrets.encrypt`) in
 * their own table — deliberately NOT as named rows in `secrets`, because those can be referenced by name elsewhere
 * (MCP environment variables, `/secrets`). Values never leave the server: the HTTP API answers `has_password` /
 * `has_totp`, the model never gets them, and TeamBot itself fills them into the page after the owner's approval
 * (vault-fill.ts) — only on an exact origin match.
 */

export const MAX_ORIGINS = 5;
export const MAX_ENTRIES = 500;
/** How long a CSV import preview (encrypted rows in memory, never on disk) stays usable. */
const IMPORT_TTL_MS = 15 * 60_000;

export class VaultInputError extends Error {}

/** The exact origin (scheme://host[:port]) of a URL or bare host the owner typed. Throws VaultInputError. */
export function normalizeOrigin(input: string): string {
  let s = String(input ?? '').trim();
  if (!s) throw new VaultInputError('Vul het adres van de website in.');
  if (/[\s*]/.test(s)) throw new VaultInputError(`"${s.slice(0, 80)}": jokertekens en spaties kunnen niet; vul één exact adres in, bijv. https://accounts.google.com.`);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^:/]+:\d+(\/|$)/.test(s)) throw new VaultInputError(`"${s.slice(0, 80)}" is geen webadres (alleen http en https).`);
    s = 'https://' + s;
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new VaultInputError(`"${s.slice(0, 80)}" is geen geldig webadres.`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new VaultInputError(`"${s.slice(0, 80)}" is geen webadres (alleen http en https).`);
  if (u.username || u.password) throw new VaultInputError('Zet geen gebruikersnaam of wachtwoord in het adres.');
  if (!u.hostname || u.hostname.endsWith('.')) throw new VaultInputError(`"${s.slice(0, 80)}" heeft geen geldige hostnaam.`);
  return u.origin;
}

/** Up to MAX_ORIGINS exact origins (one per line or comma separated), de-duplicated, order kept. */
export function parseOrigins(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map(String) : String(v ?? '').split(/[\n,]+/);
  const out: string[] = [];
  for (const x of raw.map((r) => r.trim()).filter(Boolean)) {
    const o = normalizeOrigin(x);
    if (!out.includes(o)) out.push(o);
  }
  if (!out.length) throw new VaultInputError('Vul minstens één adres in waar je op deze site inlogt.');
  if (out.length > MAX_ORIGINS) throw new VaultInputError(`Maximaal ${MAX_ORIGINS} adressen per login.`);
  return out;
}

/** Origin of a page URL, or null for about:blank, data:, chrome-error: and other non-web pages. */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * Phishing guard: the page's origin must be EXACTLY one of the stored origins — same scheme, same host (no
 * subdomains, no lookalikes: hosts are compared after URL/IDNA normalisation) and same port.
 */
export function originMatches(origins: string[], pageUrl: string): boolean {
  const o = originOf(pageUrl);
  return !!o && origins.includes(o);
}

/** Plain http to anything but this machine: the password would travel unencrypted. */
export function isInsecureOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return true;
  }
}

// ---------------- TOTP (RFC 6238) ----------------

export interface TotpSpec {
  /** base32, upper case, no padding */
  secret: string;
  algorithm: 'SHA1' | 'SHA256' | 'SHA512';
  digits: 6 | 7 | 8;
  period: number;
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s-]+/g, '').replace(/=+$/, '');
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new VaultInputError('De 2FA-sleutel is geen geldige base32-code (letters A-Z en cijfers 2-7).');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Accepts a base32 secret ("JBSW Y3DP …") or an otpauth://totp/… URI (from the QR code). Throws VaultInputError. */
export function parseTotp(input: string): TotpSpec {
  const s = String(input ?? '').trim();
  let secret = s;
  let algorithm: TotpSpec['algorithm'] = 'SHA1';
  let digits: TotpSpec['digits'] = 6;
  let period = 30;
  if (/^otpauth:/i.test(s)) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      throw new VaultInputError('Deze otpauth-link is ongeldig.');
    }
    if (u.host.toLowerCase() !== 'totp') throw new VaultInputError('Alleen tijdgebonden codes (TOTP) worden ondersteund, geen tellercodes (HOTP).');
    secret = u.searchParams.get('secret') || '';
    const alg = (u.searchParams.get('algorithm') || 'SHA1').toUpperCase();
    if (alg !== 'SHA1' && alg !== 'SHA256' && alg !== 'SHA512') throw new VaultInputError(`Onbekend algoritme ${alg.slice(0, 20)} (SHA1, SHA256 of SHA512).`);
    algorithm = alg;
    const d = Number(u.searchParams.get('digits') || 6);
    if (d !== 6 && d !== 7 && d !== 8) throw new VaultInputError('Een code heeft 6, 7 of 8 cijfers.');
    digits = d;
    const p = Number(u.searchParams.get('period') || 30);
    if (!Number.isInteger(p) || p < 10 || p > 300) throw new VaultInputError('Ongeldige periode voor de code.');
    period = p;
  }
  const key = base32Decode(secret);
  if (key.length < 10) throw new VaultInputError('De 2FA-sleutel is te kort (minstens 16 tekens).');
  return { secret: base32Encode(key), algorithm, digits, period };
}

export function base32Encode(b: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of b) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** The current code (and seconds until it changes). */
export function totpCode(spec: TotpSpec, atMs = Date.now()): { code: string; remainingSec: number } {
  const step = Math.floor(atMs / 1000 / spec.period);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac(spec.algorithm.toLowerCase(), base32Decode(spec.secret)).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  const code = String(bin % 10 ** spec.digits).padStart(spec.digits, '0');
  const remainingSec = spec.period - (Math.floor(atMs / 1000) % spec.period);
  return { code, remainingSec };
}

// ---------------- scrubbing ----------------

/** Every way a value may show up in a URL or page (plain, URL-encoded, form-encoded). */
export function secretVariants(v: string | null | undefined): string[] {
  if (!v || v.length < 4) return v ? [v] : [];
  // plain, encodeURIComponent, and HTML form encoding (spaces as +, also ! ' ( ) ~ escaped)
  const form = new URLSearchParams({ v }).toString().slice(2);
  const out = new Set([v, encodeURIComponent(v), encodeURIComponent(v).replace(/%20/g, '+'), form, form.replace(/\+/g, '%20')]);
  return [...out];
}

/** Last line of defence for tool output, URLs and logs: replace any known secret by "[verborgen]". */
export function scrubSecrets(text: string, secrets: string[]): string {
  let t = String(text ?? '');
  for (const s of [...secrets].filter((x) => x && x.length >= 4).sort((a, b) => b.length - a.length)) t = t.split(s).join('[verborgen]');
  return t;
}

// ---------------- store ----------------

export interface VaultRow {
  id: string;
  user_id: string;
  label: string;
  origins: string[];
  username_enc: string | null;
  password_enc: string | null;
  totp_enc: string | null;
  agent_ids: string[];
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

/** What the owner's UI sees: never the password or the TOTP secret. */
export interface VaultEntryView {
  id: string;
  label: string;
  origins: string[];
  username: string;
  has_password: boolean;
  has_totp: boolean;
  insecure: boolean;
  agent_ids: string[];
  grants: { agent_id: string; origin: string; created_at: string }[];
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

/** Only for vault-fill.ts, inside the tool call that the owner approved. */
export interface VaultCredentials {
  username: string;
  password: string;
  totp: TotpSpec | null;
}

/** One row of a CSV import preview as the owner sees it: never the password or the 2FA key. */
export interface ImportRowView {
  index: number;
  line: number;
  label: string;
  origins: string[];
  username: string;
  has_totp: boolean;
  insecure: boolean;
  /** new = can be imported · duplicate = already in the vault (or twice in the file) · skip = not a usable login */
  status: 'new' | 'duplicate' | 'skip';
  reason?: string;
  warning?: string;
}

export interface ImportPreviewView {
  handle: string;
  format: { id: string; label: string };
  expires_at: string;
  /** how many more logins fit in the vault */
  room: number;
  rows: ImportRowView[];
}

export interface ImportResultView {
  imported: number;
  skipped: { line: number; label: string; reason: string }[];
}

interface PendingRow {
  view: ImportRowView;
  username_enc: string | null;
  password_enc: string | null;
  totp_enc: string | null;
}

interface PendingImport {
  userId: string;
  expires: number;
  format: ImportFormat;
  rows: PendingRow[];
}

export class VaultService {
  /** CSV import previews: in memory only, encrypted credential fields, one per user, gone after use or 15 minutes. */
  private imports = new Map<string, PendingImport>();

  constructor(private ctx: Ctx) {}

  private enc(v: string | null | undefined): string | null {
    return v ? this.ctx.secrets.encrypt(v) : null;
  }

  private dec(v: string | null | undefined): string {
    if (!v) return '';
    try {
      return this.ctx.secrets.decrypt(v);
    } catch {
      return '';
    }
  }

  row(id: string): VaultRow | null {
    return this.ctx.store.get<VaultRow>('vault_logins', id);
  }

  rows(userId: string): VaultRow[] {
    return this.ctx.store.find<VaultRow>('vault_logins', { user_id: userId }, { order: 'created_at' });
  }

  view(r: VaultRow): VaultEntryView {
    const grants = this.ctx.store.find<any>('vault_grants', { entry_id: r.id }, { order: 'created_at' }).map((g) => ({ agent_id: g.agent_id, origin: g.origin, created_at: g.created_at }));
    return {
      id: r.id,
      label: r.label,
      origins: r.origins,
      username: this.dec(r.username_enc),
      has_password: !!r.password_enc,
      has_totp: !!r.totp_enc,
      insecure: r.origins.some(isInsecureOrigin),
      agent_ids: r.agent_ids,
      grants,
      created_at: r.created_at,
      updated_at: r.updated_at,
      last_used_at: r.last_used_at,
    };
  }

  list(userId: string): VaultEntryView[] {
    return this.rows(userId).map((r) => this.view(r));
  }

  private cleanAgents(userId: string, v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    const mine = new Set(this.ctx.store.agents(userId).map((a) => a.id));
    return [...new Set(v.map(String))].filter((id) => mine.has(id)).slice(0, 200);
  }

  private input<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e: any) {
      if (e instanceof VaultInputError) throw new HttpLike(400, e.message);
      throw e;
    }
  }

  create(u: User, body: any): VaultEntryView {
    const n = this.ctx.store.one<any>('SELECT COUNT(*) n FROM vault_logins WHERE user_id = ?', u.id)?.n ?? 0;
    if (n >= MAX_ENTRIES) throw new HttpLike(400, `Maximaal ${MAX_ENTRIES} logins in de kluis.`);
    const origins = this.input(() => parseOrigins(body?.origins ?? body?.url));
    const password = String(body?.password ?? '');
    if (!password) throw new HttpLike(400, 'Vul het wachtwoord in.');
    if (password.length > 1000) throw new HttpLike(400, 'Dit wachtwoord is te lang.');
    const username = String(body?.username ?? '').trim().slice(0, 320);
    const totp = body?.totp ? this.input(() => parseTotp(String(body.totp))) : null;
    const t = now();
    const row: VaultRow = {
      id: newId('vl_'),
      user_id: u.id,
      label: String(body?.label ?? '').trim().slice(0, 80) || new URL(origins[0]).hostname,
      origins,
      username_enc: this.enc(username),
      password_enc: this.enc(password),
      totp_enc: totp ? this.enc(JSON.stringify(totp)) : null,
      agent_ids: this.cleanAgents(u.id, body?.agent_ids),
      created_at: t,
      updated_at: t,
      last_used_at: null,
    };
    this.ctx.store.insert('vault_logins', row);
    // never the username, password or TOTP secret in the audit log
    this.ctx.audit(u.id, 'vault.created', { id: row.id, origins, totp: !!totp, bots: row.agent_ids.length });
    this.ctx.events.emit(u.id, 'vault.updated', { id: row.id });
    return this.view(this.row(row.id)!);
  }

  update(u: User, r: VaultRow, body: any): VaultEntryView {
    const patch: Partial<VaultRow> = { updated_at: now() };
    const changed: string[] = [];
    if (body?.label !== undefined) patch.label = String(body.label).trim().slice(0, 80) || r.label;
    if (body?.origins !== undefined || body?.url !== undefined) {
      patch.origins = this.input(() => parseOrigins(body.origins ?? body.url));
      changed.push('origins');
    }
    if (body?.username !== undefined) {
      patch.username_enc = this.enc(String(body.username).trim().slice(0, 320));
      changed.push('username');
    }
    // write-only fields: empty = keep, a value = replace
    if (body?.password) {
      if (String(body.password).length > 1000) throw new HttpLike(400, 'Dit wachtwoord is te lang.');
      patch.password_enc = this.enc(String(body.password));
      changed.push('password');
    }
    if (body?.totp === null || body?.clear_totp === true) {
      patch.totp_enc = null;
      changed.push('totp_removed');
    } else if (body?.totp) {
      patch.totp_enc = this.enc(JSON.stringify(this.input(() => parseTotp(String(body.totp)))));
      changed.push('totp');
    }
    if (body?.agent_ids !== undefined) {
      patch.agent_ids = this.cleanAgents(u.id, body.agent_ids);
      changed.push('bots');
    }
    this.ctx.store.update('vault_logins', r.id, patch);
    // a different site or account: earlier "always allow" choices no longer apply
    if (changed.includes('origins') || changed.includes('username')) this.ctx.store.exec('DELETE FROM vault_grants WHERE entry_id = ?', r.id);
    else if (patch.origins === undefined && patch.agent_ids && patch.agent_ids.length) {
      for (const g of this.ctx.store.find<any>('vault_grants', { entry_id: r.id })) if (!patch.agent_ids.includes(g.agent_id)) this.ctx.store.remove('vault_grants', g.id);
    }
    this.ctx.audit(u.id, 'vault.updated', { id: r.id, changed });
    this.ctx.events.emit(u.id, 'vault.updated', { id: r.id });
    return this.view(this.row(r.id)!);
  }

  remove(u: User, r: VaultRow) {
    this.ctx.store.exec('DELETE FROM vault_grants WHERE entry_id = ?', r.id);
    this.ctx.store.remove('vault_logins', r.id);
    this.ctx.audit(u.id, 'vault.deleted', { id: r.id, origins: r.origins });
    this.ctx.events.emit(u.id, 'vault.updated', { id: r.id });
  }

  // ---------------- CSV import (Bitwarden, 1Password, Chrome/Edge, Firefox) ----------------

  private sweepImports() {
    const t = Date.now();
    for (const [k, p] of this.imports) if (p.expires <= t) this.imports.delete(k);
  }

  /** Same site (one shared exact origin) and the same account name. */
  private existingKeys(userId: string) {
    return this.rows(userId).map((r) => ({ origins: r.origins, username: this.dec(r.username_enc).trim().toLowerCase() }));
  }

  private static sameLogin(a: { origins: string[]; username: string }, b: { origins: string[]; username: string }) {
    return a.username === b.username && a.origins.some((o) => b.origins.includes(o));
  }

  /**
   * Parse an uploaded CSV export in memory and keep the rows (credentials already encrypted) behind a short-lived
   * handle. The answer has names, sites and usernames — never a password or 2FA key — and marks duplicates.
   */
  importPreview(u: User, body: any): ImportPreviewView {
    this.sweepImports();
    const text = body?.csv;
    if (typeof text !== 'string') throw new HttpLike(400, 'Kies een CSV-bestand met je wachtwoorden.');
    let parsed: ReturnType<typeof parseExport>;
    try {
      parsed = parseExport(text);
    } catch (e) {
      // our own messages are fixed sentences; anything unexpected gets a generic one (never a piece of the file)
      throw new HttpLike(400, e instanceof VaultImportError ? e.message : 'Dit bestand kon ik niet lezen. Exporteer je wachtwoorden opnieuw als CSV en probeer het nog eens.');
    }
    for (const [k, p] of this.imports) if (p.userId === u.id) this.imports.delete(k);
    const existing = this.existingKeys(u.id);
    const accepted: { origins: string[]; username: string }[] = [];
    const rows: PendingRow[] = parsed.candidates.map((c, index) => {
      const key = { origins: c.origins, username: c.username.toLowerCase() };
      let status: ImportRowView['status'] = 'new';
      let reason = c.skip;
      if (reason) status = 'skip';
      else if (existing.some((e) => VaultService.sameLogin(e, key))) {
        status = 'duplicate';
        reason = 'Staat al in de kluis';
      } else if (accepted.some((e) => VaultService.sameLogin(e, key))) {
        status = 'duplicate';
        reason = 'Staat twee keer in het bestand';
      } else accepted.push(key);
      const ok = status === 'new';
      return {
        view: { index, line: c.line, label: c.label, origins: c.origins, username: c.username, has_totp: ok && !!c.totp, insecure: c.insecure, status, reason, warning: ok ? c.warning : undefined },
        username_enc: ok ? this.enc(c.username) : null,
        password_enc: ok ? this.enc(c.password) : null,
        totp_enc: ok && c.totp ? this.enc(JSON.stringify(c.totp)) : null,
      };
    });
    const handle = newImportHandle();
    const expires = Date.now() + IMPORT_TTL_MS;
    this.imports.set(handle, { userId: u.id, expires, format: parsed.format, rows });
    const n = this.ctx.store.one<any>('SELECT COUNT(*) n FROM vault_logins WHERE user_id = ?', u.id)?.n ?? 0;
    return { handle, format: { id: parsed.format.id, label: parsed.format.label }, expires_at: new Date(expires).toISOString(), room: Math.max(0, MAX_ENTRIES - n), rows: rows.map((r) => r.view) };
  }

  /** Import the chosen rows of a preview (once). Summary: how many, and per skipped row a plain-Dutch reason. */
  importRun(u: User, body: any): ImportResultView {
    this.sweepImports();
    const handle = String(body?.handle ?? '');
    const p = this.imports.get(handle);
    if (!p || p.userId !== u.id) throw new HttpLike(404, 'Deze voorvertoning is verlopen of al gebruikt. Kies het bestand opnieuw.');
    this.imports.delete(handle);
    const pick = new Set((Array.isArray(body?.rows) ? body.rows : []).map((x: unknown) => Number(x)).filter(Number.isInteger));
    const existing = this.existingKeys(u.id);
    let room = MAX_ENTRIES - (this.ctx.store.one<any>('SELECT COUNT(*) n FROM vault_logins WHERE user_id = ?', u.id)?.n ?? 0);
    const skipped: ImportResultView['skipped'] = [];
    const ids: string[] = [];
    const t = now();
    this.ctx.store.tx(() => {
      for (const r of p.rows) {
        const v = r.view;
        const skip = (reason: string) => skipped.push({ line: v.line, label: v.label || '(zonder naam)', reason });
        if (v.status !== 'new' || !r.password_enc) skip(v.reason || 'Niet te importeren');
        else if (!pick.has(v.index)) skip('Niet gekozen');
        else if (existing.some((e) => VaultService.sameLogin(e, { origins: v.origins, username: v.username.toLowerCase() }))) skip('Staat al in de kluis');
        else if (room <= 0) skip(`De kluis is vol (maximaal ${MAX_ENTRIES} logins)`);
        else {
          const row: VaultRow = {
            id: newId('vl_'),
            user_id: u.id,
            label: v.label || new URL(v.origins[0]).hostname,
            origins: v.origins,
            username_enc: r.username_enc,
            password_enc: r.password_enc,
            totp_enc: r.totp_enc,
            agent_ids: [],
            created_at: t,
            updated_at: t,
            last_used_at: null,
          };
          this.ctx.store.insert('vault_logins', row);
          ids.push(row.id);
          existing.push({ origins: v.origins, username: v.username.toLowerCase() });
          room--;
        }
      }
    });
    // never usernames, passwords or 2FA keys in the audit log or events: only counts and the format
    this.ctx.audit(u.id, 'vault.imported', { format: p.format.id, imported: ids.length, skipped: skipped.length });
    if (ids.length) this.ctx.events.emit(u.id, 'vault.updated', { imported: ids.length });
    return { imported: ids.length, skipped };
  }

  revokeGrant(u: User, r: VaultRow, agentId: string, origin?: string) {
    for (const g of this.ctx.store.find<any>('vault_grants', { entry_id: r.id, agent_id: agentId })) if (!origin || g.origin === origin) this.ctx.store.remove('vault_grants', g.id);
    this.ctx.audit(u.id, 'vault.grant_revoked', { id: r.id, origin: origin || null }, agentId);
    this.ctx.events.emit(u.id, 'vault.updated', { id: r.id });
  }

  // ---------------- for the login tool ----------------

  /** Entries of the bot's owner that this bot may ask for, with an exact origin match for the page. */
  matchesFor(agent: Agent, pageUrl: string): VaultRow[] {
    const origin = originOf(pageUrl);
    if (!origin) return [];
    return this.rows(agent.user_id).filter(
      (r) => r.origins.includes(origin) && !!r.password_enc && (!r.agent_ids.length || r.agent_ids.includes(agent.id)) && this.ctx.services.teams?.keyAllowed?.(agent, 'login', r.id) !== false,
    );
  }

  hasGrant(entryId: string, agentId: string, origin: string): boolean {
    return !!this.ctx.store.one<any>('SELECT id FROM vault_grants WHERE entry_id = ? AND agent_id = ? AND origin = ?', entryId, agentId, origin);
  }

  addGrant(userId: string, entryId: string, agentId: string, origin: string) {
    if (this.hasGrant(entryId, agentId, origin)) return;
    this.ctx.store.insert('vault_grants', { id: newId('vg_'), user_id: userId, entry_id: entryId, agent_id: agentId, origin, created_at: now() });
    this.ctx.audit(userId, 'vault.grant_added', { id: entryId, origin }, agentId);
    this.ctx.events.emit(userId, 'vault.updated', { id: entryId });
  }

  /** Decrypt for filling. Only vault-fill.ts calls this, after the approval (or a stored grant) and the origin check. */
  credentials(r: VaultRow): VaultCredentials {
    let totp: TotpSpec | null = null;
    const raw = this.dec(r.totp_enc);
    if (raw) {
      try {
        totp = JSON.parse(raw);
      } catch {
        totp = null;
      }
    }
    return { username: this.dec(r.username_enc), password: this.dec(r.password_enc), totp };
  }

  /** Display name for approvals ("als sanne@example.com"). Shown to the owner only, never to the bot. */
  accountLabel(r: VaultRow): string {
    return this.dec(r.username_enc) || r.label;
  }

  touch(r: VaultRow) {
    this.ctx.store.update('vault_logins', r.id, { last_used_at: now() });
  }

  agentDeleted(agentId: string, userId: string) {
    this.ctx.store.exec('DELETE FROM vault_grants WHERE agent_id = ?', agentId);
    for (const r of this.rows(userId)) if (r.agent_ids.includes(agentId)) this.ctx.store.update('vault_logins', r.id, { agent_ids: r.agent_ids.filter((x) => x !== agentId) });
  }

  /** Data export: which logins exist, never the username, password or TOTP secret. */
  exportUser(userId: string) {
    return this.rows(userId).map((r) => ({ id: r.id, label: r.label, origins: r.origins, has_password: !!r.password_enc, has_totp: !!r.totp_enc, agent_ids: r.agent_ids, created_at: r.created_at, last_used_at: r.last_used_at }));
  }
}
