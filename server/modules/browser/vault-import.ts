import crypto from 'node:crypto';
import { MAX_ORIGINS, isInsecureOrigin, normalizeOrigin, parseTotp, type TotpSpec } from './vault.js';

/**
 * Vault import: logins from the CSV export of Bitwarden, 1Password, Chrome/Edge (and Firefox or any CSV with a website
 * and a password column). Everything happens in memory: the uploaded text is parsed, the credential fields are
 * encrypted straight away and only a short-lived preview handle stays on the server until the owner picks the rows.
 *
 * Error messages and skip reasons are fixed Dutch sentences: they never repeat a cell of the file (a URL or note can
 * hold a password).
 */

export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 2000;

export class VaultImportError extends Error {}

// ---------------- CSV (RFC 4180) ----------------

/** The delimiter of the header line: comma, or semicolon/tab (Excel with Dutch settings, TSV). Quotes respected. */
function sniffDelimiter(text: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === '\n' || c === '\r')) break;
    else if (!quoted && c in counts) counts[c]++;
  }
  if (counts[';'] > counts[','] && counts[';'] >= counts['\t']) return ';';
  if (counts['\t'] > counts[',']) return '\t';
  return ',';
}

/**
 * Parse CSV text into rows of fields: quoted fields with commas, line breaks and doubled quotes inside, a UTF-8 BOM,
 * CRLF / LF / CR line ends, empty lines skipped. Throws VaultImportError (without file content) on a missing quote or
 * too many rows.
 */
export function parseCsv(input: string, maxRows = IMPORT_MAX_ROWS + 1): string[][] {
  const text = String(input ?? '').replace(/^﻿/, '');
  const delim = sniffDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let quoteLine = 0;
  let any = false; // the current row has content (so an empty line is not a row)
  const endRow = () => {
    row.push(field);
    field = '';
    if (any || row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
    any = false;
    if (rows.length > maxRows) throw new VaultImportError(`Dit bestand heeft meer dan ${maxRows - 1} logins. Splits het in kleinere bestanden of laat logins weg die je bots niet nodig hebben.`);
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (c === '\n' || (c === '\r' && text[i + 1] !== '\n')) line++;
        field += c;
      }
      continue;
    }
    if (c === '"') {
      // a quote opens a quoted field only at the start of a field; elsewhere it is an ordinary character
      if (field === '') {
        quoted = true;
        quoteLine = line;
        any = true;
      } else field += c;
    } else if (c === delim) {
      row.push(field);
      field = '';
      any = true;
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRow();
      line++;
    } else {
      field += c;
      any = true;
    }
  }
  if (quoted) throw new VaultImportError(`Het bestand is niet compleet: vanaf regel ${quoteLine} mist een afsluitend aanhalingsteken. Exporteer opnieuw en kies het bestand dan nog eens.`);
  if (field !== '' || row.length) endRow();
  return rows;
}

// ---------------- formats ----------------

export type ImportFormatId = 'bitwarden' | '1password' | 'chrome' | 'firefox' | 'generic';

interface Columns {
  name?: number;
  url: number;
  username?: number;
  password: number;
  totp?: number;
  type?: number;
}

export interface ImportFormat {
  id: ImportFormatId;
  /** what the owner sees: "Bitwarden", "1Password", "Chrome of Edge", … */
  label: string;
  columns: Columns;
}

const norm = (h: string) =>
  String(h ?? '')
    .replace(/^﻿/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');

function find(header: string[], names: string[]): number | undefined {
  for (const n of names) {
    const i = header.indexOf(n);
    if (i >= 0) return i;
  }
  return undefined;
}

const URL_COLS = ['url', 'website', 'web site', 'login uri', 'uri', 'site', 'address', 'adres', 'websiteadres', 'login url'];
const PASS_COLS = ['password', 'login password', 'wachtwoord', 'pass'];
const USER_COLS = ['username', 'login username', 'user name', 'user', 'login', 'email', 'e mail', 'gebruikersnaam'];
const NAME_COLS = ['name', 'title', 'naam', 'titel'];
const TOTP_COLS = ['login totp', 'otpauth', 'one time password', 'totp', 'otp', '2fa'];

/** Recognise the export by its header line. Throws VaultImportError when no website and password column are found. */
export function detectFormat(headerRaw: string[]): ImportFormat {
  const h = headerRaw.map(norm);
  const has = (...names: string[]) => names.every((n) => h.includes(n));
  const url = find(h, URL_COLS);
  const password = find(h, PASS_COLS);
  if (url === undefined || password === undefined)
    throw new VaultImportError('Dit bestand herken ik niet als wachtwoordexport: er zijn geen kolommen voor de website en het wachtwoord. Exporteer je wachtwoorden als CSV uit Bitwarden, 1Password, Chrome of Edge.');
  const columns: Columns = { url, password, name: find(h, NAME_COLS), username: find(h, USER_COLS), totp: find(h, TOTP_COLS) };
  // Bitwarden: folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp
  // (organisation exports start with "collections" instead of "folder,favorite")
  if (has('login uri', 'login password')) return { id: 'bitwarden', label: 'Bitwarden', columns: { ...columns, type: find(h, ['type']) } };
  // Firefox: url,username,password,httpRealm,formActionOrigin,guid,timeCreated,…
  if (has('url', 'username', 'password') && (h.includes('formactionorigin') || h.includes('httprealm'))) return { id: 'firefox', label: 'Firefox', columns };
  // 1Password 8: Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes (older apps: Website, One-time password)
  if (h.includes('title') || h.includes('otpauth') || h.includes('one time password') || (h.includes('website') && h.includes('archived'))) return { id: '1password', label: '1Password', columns };
  // Chrome and Edge (both Chromium): name,url,username,password[,note]
  if (has('name', 'url', 'username', 'password') && h.every((x) => ['name', 'url', 'username', 'password', 'note', 'notes'].includes(x) || x === ''))
    return { id: 'chrome', label: 'Chrome of Edge', columns };
  return { id: 'generic', label: 'CSV-bestand', columns };
}

// ---------------- rows → logins ----------------

export interface ImportCandidate {
  /** line of the row in the file (header = line 1, as a spreadsheet shows it) */
  line: number;
  label: string;
  origins: string[];
  username: string;
  /** plain text — only inside this module and the vault service, encrypted before it is kept */
  password: string;
  totp: TotpSpec | null;
  insecure: boolean;
  /** set: this row cannot be imported, in plain Dutch */
  skip?: string;
  /** imported, but with a remark (e.g. the 2FA key was not usable) */
  warning?: string;
}

/** Logins of a phone app (Chrome: android://…, Bitwarden: androidapp://…): nothing TeamBot's browser can use. */
const APP_URI = /^(android|androidapp|ios|iosapp):/i;
/** Without a scheme only something that looks like a host name ("shop.example.nl", "localhost:3000") counts. */
const BARE_HOST = /^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z][a-z0-9-]*|\d{1,3}(\.\d{1,3}){3})(:\d{1,5})?(\/|$)/i;

function originsFrom(value: string, splitComma: boolean): { origins: string[]; appOnly: boolean; dropped: number } {
  const parts = String(value ?? '')
    .split(splitComma ? /[\r\n,]+/ : /[\r\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const origins: string[] = [];
  let apps = 0;
  for (const p of parts) {
    if (APP_URI.test(p)) {
      apps++;
      continue;
    }
    if (!/^https?:\/\//i.test(p) && !BARE_HOST.test(p)) continue;
    try {
      const o = normalizeOrigin(p);
      if (!origins.includes(o)) origins.push(o);
    } catch {
      /* not a usable web address: the message would repeat the cell, so it is never shown */
    }
  }
  const dropped = Math.max(0, origins.length - MAX_ORIGINS);
  return { origins: origins.slice(0, MAX_ORIGINS), appOnly: !origins.length && apps > 0, dropped };
}

const hostLabel = (origin: string) => {
  try {
    return new URL(origin).hostname.replace(/^www\./, '');
  } catch {
    return origin;
  }
};

/** Turn the data rows into login candidates (with a fixed reason for rows that cannot be imported). */
export function toCandidates(format: ImportFormat, rows: string[][]): ImportCandidate[] {
  const c = format.columns;
  const cell = (r: string[], i: number | undefined) => (i === undefined ? '' : String(r[i] ?? ''));
  return rows.map((r, n) => {
    const line = n + 2;
    const name = cell(r, c.name).trim().replace(/\s+/g, ' ').slice(0, 80);
    const { origins, appOnly, dropped } = originsFrom(cell(r, c.url), format.id === 'bitwarden');
    const username = cell(r, c.username).trim().slice(0, 320);
    const password = cell(r, c.password);
    const base: ImportCandidate = { line, label: name || (origins[0] ? hostLabel(origins[0]) : ''), origins, username, password: '', totp: null, insecure: origins.some(isInsecureOrigin) };
    const type = cell(r, c.type).trim().toLowerCase();
    if (format.id === 'bitwarden' && type && type !== 'login') return { ...base, skip: 'Geen login (een notitie, kaart of identiteit)' };
    if (!origins.length) return { ...base, skip: appOnly ? 'Alleen voor een app, geen website' : 'Geen bruikbaar webadres' };
    if (!password) return { ...base, skip: 'Geen wachtwoord' };
    if (password.length > 1000) return { ...base, skip: 'Wachtwoord te lang' };
    const warnings: string[] = [];
    let totp: TotpSpec | null = null;
    const rawTotp = cell(r, c.totp).trim();
    if (rawTotp) {
      try {
        totp = parseTotp(rawTotp);
      } catch {
        warnings.push('2FA-sleutel niet herkend: zonder 2FA-code');
      }
    }
    if (dropped) warnings.push(`Alleen de eerste ${MAX_ORIGINS} adressen`);
    return { ...base, password, totp, warning: warnings.join(' · ') || undefined };
  });
}

/** A text that is clearly not a CSV export: say what to do instead (without repeating the content). */
export function notCsvHint(text: string): string | null {
  const head = text.replace(/^﻿/, '').trimStart().slice(0, 200);
  if (text.includes('\u0000') || head.startsWith('PK')) return 'Dit is geen CSV-bestand (maar bijvoorbeeld een zip- of Excel-bestand). Kies bij het exporteren de indeling CSV.';
  if (head.startsWith('{') || head.startsWith('[')) return 'Dit is een JSON-export. Kies bij het exporteren de indeling CSV (bij Bitwarden: “.csv”, niet versleuteld).';
  if (/^<(\?xml|!doctype|html)/i.test(head)) return 'Dit is geen CSV-bestand. Kies bij het exporteren de indeling CSV.';
  return null;
}

/** Parse a whole upload: format + candidates. Throws VaultImportError with a plain-Dutch message. */
export function parseExport(text: string): { format: ImportFormat; candidates: ImportCandidate[] } {
  if (typeof text !== 'string' || !text.trim()) throw new VaultImportError('Dit bestand is leeg.');
  if (Buffer.byteLength(text, 'utf8') > IMPORT_MAX_BYTES) throw new VaultImportError(`Dit bestand is te groot (maximaal ${IMPORT_MAX_BYTES / 1024 / 1024} MB). Splits het in kleinere bestanden.`);
  const hint = notCsvHint(text);
  if (hint) throw new VaultImportError(hint);
  const rows = parseCsv(text);
  if (!rows.length) throw new VaultImportError('Dit bestand is leeg.');
  const format = detectFormat(rows[0]);
  const data = rows.slice(1);
  if (!data.length) throw new VaultImportError('Er staan geen logins in dit bestand (alleen de kopregel).');
  return { format, candidates: toCandidates(format, data) };
}

export const newImportHandle = () => 'vi_' + crypto.randomBytes(18).toString('base64url');
