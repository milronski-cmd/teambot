/**
 * TeamBot package SDK — the single implementation of the package format used by the TeamBot server
 * (import/install checks) and by the `teambot-pack` CLI (scripts/teambot-pack.mjs).
 *
 * A package is a folder (or zip) with a `teambot-package.json` manifest next to its files:
 *   - kind "skill":     SKILL.md (+ extra files)
 *   - kind "bot":       bot.json  (a `teambot.bot-template/v1` template)
 *   - kind "connector": connector.json (a `teambot.connector/v1` connector template)
 *
 * Signature: Ed25519 (node:crypto) over the UTF-8 bytes of
 *   SIGNATURE_CONTEXT + canonicalJson(manifest without its "signature" field)
 * canonicalJson = RFC 8785 (JCS)-style: object keys sorted by UTF-16 code units, no whitespace,
 * strings/numbers as JSON.stringify writes them, `undefined` members dropped.
 * Keys: `publisher.publicKey` is the base64 (standard alphabet, padded) of the raw 32-byte Ed25519 public key;
 * private keys are PKCS#8 PEM files that stay with the publisher (never inside a package).
 *
 * Only `node:crypto`; erasable TypeScript only and no relative imports, so this file also runs under
 * Node's native type stripping.
 */
import crypto from 'node:crypto';

export const PACKAGE_FORMAT = 'teambot.package/v1';
export const MANIFEST_FILE = 'teambot-package.json';
/** Domain separation: a package signature can never be confused with a signature over other data. */
export const SIGNATURE_CONTEXT = 'teambot.package/v1 signature\n';
export const PACKAGE_KINDS = ['skill', 'bot', 'connector'] as const;
export type PackageKind = (typeof PACKAGE_KINDS)[number];
/** The file every package of a kind must contain. */
export const MAIN_FILE: Record<PackageKind, string> = { skill: 'SKILL.md', bot: 'bot.json', connector: 'connector.json' };
export const DEFAULT_COMPAT_RANGE = '>=0.1.0 <3.0.0';

export interface Publisher {
  /** Self-chosen identifier (e.g. reverse domain). Informational: trust is bound to the key, never to the id or name. */
  id: string;
  name: string;
  /** base64 of the raw 32-byte Ed25519 public key. */
  publicKey: string;
}

export interface PackageRequires {
  /** TeamBot tool groups the package needs (e.g. "web", "files"). */
  toolGroups?: string[];
  /** TeamBot modules the package needs (e.g. "mcp", "routines"). */
  modules?: string[];
}

export interface PackageManifest {
  format: typeof PACKAGE_FORMAT;
  name: string;
  /** Semver x.y.z (optional pre-release). */
  version: string;
  kind: PackageKind;
  description?: string;
  publisher: Publisher;
  /** Compatible TeamBot versions, e.g. ">=0.1.0 <1.0.0". */
  teambot: string;
  requires: PackageRequires;
  /** SPDX license expression. */
  license: string;
  homepage?: string;
  /** posix relative path -> sha256 (hex) of every file in the package except the manifest. */
  files: Record<string, string>;
  /** base64 Ed25519 signature (64 bytes). */
  signature?: string;
}

export type FileInput = Map<string, Uint8Array> | Record<string, Uint8Array | string>;

// ------------------------------------------------------------------ bytes, hashing, canonical JSON

function toBytes(v: Uint8Array | string): Uint8Array {
  return typeof v === 'string' ? Buffer.from(v, 'utf8') : v;
}

export function toFileMap(files: FileInput): Map<string, Uint8Array> {
  if (files instanceof Map) return files;
  const out = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(files)) out.set(k, toBytes(v));
  return out;
}

export function sha256Hex(data: Uint8Array | string): string {
  return crypto.createHash('sha256').update(toBytes(data)).digest('hex');
}

/** Deterministic JSON (see file header). Throws on values JSON cannot represent (NaN, functions, ...). */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: getal moet eindig zijn');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return '[' + value.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',') + ']';
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
    }
    default:
      throw new TypeError(`canonicalJson: type ${typeof value} wordt niet ondersteund`);
  }
}

/** sha256 of every file except the manifest, keys sorted. */
export function hashFiles(files: FileInput): Record<string, string> {
  const m = toFileMap(files);
  const out: Record<string, string> = {};
  for (const p of [...m.keys()].sort()) if (p !== MANIFEST_FILE) out[p] = sha256Hex(m.get(p)!);
  return out;
}

const PRIVATE_KEY_RE = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/;

/** Paths of files that contain private key material (PEM). A package must never ship one. */
export function findPrivateKeys(files: FileInput): string[] {
  const out: string[] = [];
  for (const [p, b] of toFileMap(files)) if (PRIVATE_KEY_RE.test(Buffer.from(b).toString('latin1'))) out.push(p);
  return out.sort();
}

// ------------------------------------------------------------------ keys

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

function b64ToBytes(s: string, expected: number, what: string): Buffer {
  const clean = String(s || '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  if (!clean || !B64.test(padded)) throw new Error(`${what} is geen geldige base64.`);
  const buf = Buffer.from(padded, 'base64');
  if (buf.length !== expected) throw new Error(`${what} moet ${expected} bytes zijn (nu ${buf.length}).`);
  return buf;
}

/**
 * Accept a pasted public key (raw base64/base64url, or an SPKI "BEGIN PUBLIC KEY" PEM) and return the
 * canonical form: padded standard base64 of the raw 32 bytes. Throws with a readable message.
 */
export function normalizePublicKey(input: string): string {
  const s = String(input || '').trim();
  if (/-----BEGIN PUBLIC KEY-----/.test(s)) {
    let k: crypto.KeyObject;
    try {
      k = crypto.createPublicKey(s);
    } catch {
      throw new Error('Deze PEM-sleutel kan niet worden gelezen.');
    }
    if (k.asymmetricKeyType !== 'ed25519') throw new Error('Alleen Ed25519-sleutels worden ondersteund.');
    return Buffer.from(String(k.export({ format: 'jwk' }).x), 'base64url').toString('base64');
  }
  return b64ToBytes(s, 32, 'De publieke sleutel').toString('base64');
}

export function publicKeyObject(publicKey: string): crypto.KeyObject {
  const raw = b64ToBytes(publicKey, 32, 'De publieke sleutel');
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
}

/** Short, human-comparable fingerprint of a public key (first 16 bytes of its sha256, grouped). */
export function fingerprint(publicKey: string): string {
  const raw = b64ToBytes(publicKey, 32, 'De publieke sleutel');
  return (crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32).match(/.{4}/g) || []).join(' ');
}

export function generateKeyPair(): { publicKey: string; privateKeyPem: string; fingerprint: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = Buffer.from(String(publicKey.export({ format: 'jwk' }).x), 'base64url').toString('base64');
  return { publicKey: pub, privateKeyPem: String(privateKey.export({ format: 'pem', type: 'pkcs8' })), fingerprint: fingerprint(pub) };
}

function privateKeyObject(privateKeyPem: string): crypto.KeyObject {
  let k: crypto.KeyObject;
  try {
    k = crypto.createPrivateKey(privateKeyPem);
  } catch {
    throw new Error('De privésleutel kan niet worden gelezen (verwacht een PKCS#8 PEM-bestand van teambot-pack keygen).');
  }
  if (k.asymmetricKeyType !== 'ed25519') throw new Error('Alleen Ed25519-sleutels worden ondersteund.');
  return k;
}

export function publicKeyFromPrivateKey(privateKeyPem: string): string {
  const k = crypto.createPublicKey(privateKeyObject(privateKeyPem));
  return Buffer.from(String(k.export({ format: 'jwk' }).x), 'base64url').toString('base64');
}

// ------------------------------------------------------------------ semver (small, dependency-free)

export interface Version {
  major: number;
  minor: number;
  patch: number;
  pre: (string | number)[];
}

const VERSION_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseVersion(v: string): Version | null {
  const m = VERSION_RE.exec(String(v || '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.').map((x) => (/^\d+$/.test(x) ? Number(x) : x)) : [] };
}

/** Semver precedence: <0 when a < b. Build metadata is ignored. */
export function compareVersions(a: Version, b: Version): number {
  for (const k of ['major', 'minor', 'patch'] as const) if (a[k] !== b[k]) return a[k] - b[k];
  if (!a.pre.length || !b.pre.length) return (b.pre.length ? 1 : 0) - (a.pre.length ? 1 : 0);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

type Op = '>=' | '<=' | '>' | '<' | '=';
interface Comparator {
  op: Op;
  v: Version;
}

const v3 = (major: number, minor: number, patch: number, pre: (string | number)[] = []): Version => ({ major, minor, patch, pre });

/** Partial version "1", "1.2", "1.2.3", "1.x", "*" -> parts (null = wildcard). */
function partial(s: string): { parts: (number | null)[]; pre: (string | number)[] } {
  const t = s.replace(/^v/, '');
  if (t === '' || t === '*' || t === 'x' || t === 'X') return { parts: [null, null, null], pre: [] };
  const full = parseVersion(t);
  if (full) return { parts: [full.major, full.minor, full.patch], pre: full.pre };
  const m = /^(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(t);
  if (!m) throw new Error(`Ongeldige versie in bereik: "${s}"`);
  const p = [m[1], m[2], m[3]].map((x) => (x === undefined || /^[xX*]$/.test(x) ? null : Number(x)));
  // Anything after a wildcard is a wildcard too.
  for (let i = 1; i < 3; i++) if (p[i - 1] === null) p[i] = null;
  return { parts: p, pre: [] };
}

function desugar(op: string, s: string): Comparator[] {
  const { parts, pre } = partial(s);
  const [M, m, p] = parts;
  const any: Comparator[] = [];
  if (M === null) return op === '<' || op === '>' ? [{ op: '<', v: v3(0, 0, 0, [0]) }] : any;
  if (op === '^') {
    if (M > 0 || m === null) return [{ op: '>=', v: v3(M, m ?? 0, p ?? 0, pre) }, { op: '<', v: v3(M + 1, 0, 0) }];
    if (m > 0 || p === null) return [{ op: '>=', v: v3(0, m, p ?? 0, pre) }, { op: '<', v: v3(0, m + 1, 0) }];
    return [{ op: '>=', v: v3(0, 0, p, pre) }, { op: '<', v: v3(0, 0, p + 1) }];
  }
  if (op === '~') {
    if (m === null) return [{ op: '>=', v: v3(M, 0, 0) }, { op: '<', v: v3(M + 1, 0, 0) }];
    return [{ op: '>=', v: v3(M, m, p ?? 0, pre) }, { op: '<', v: v3(M, m + 1, 0) }];
  }
  const lower = v3(M, m ?? 0, p ?? 0, pre);
  const upper = m === null ? v3(M + 1, 0, 0) : p === null ? v3(M, m + 1, 0) : null;
  switch (op) {
    case '':
    case '=':
      return upper ? [{ op: '>=', v: lower }, { op: '<', v: upper }] : [{ op: '=', v: lower }];
    case '>=':
      return [{ op: '>=', v: lower }];
    case '>':
      return upper ? [{ op: '>=', v: upper }] : [{ op: '>', v: lower }];
    case '<':
      return [{ op: '<', v: lower }];
    case '<=':
      return upper ? [{ op: '<', v: upper }] : [{ op: '<=', v: lower }];
  }
  throw new Error(`Onbekende operator "${op}"`);
}

/**
 * Parse a range: comparator sets separated by "||"; inside a set, comparators separated by spaces
 * (all must match), "a - b" hyphen ranges, operators >= <= > < =, caret ^, tilde ~, wildcards x/*.
 * Pre-releases are compared by plain precedence (simplified compared to npm).
 */
export function parseRange(range: string): Comparator[][] {
  const r = String(range ?? '').trim();
  if (r.length > 200) throw new Error('Het versiebereik is te lang.');
  return r.split('||').map((set) => {
    const s = set.trim();
    const hy = /^(\S+)\s+-\s+(\S+)$/.exec(s);
    if (hy) return [...desugar('>=', hy[1]), ...desugar('<=', hy[2])];
    const out: Comparator[] = [];
    const tokens = s.replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean);
    for (const tok of tokens) {
      const m = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(tok)!;
      out.push(...desugar(m[1] || '', m[2]));
    }
    return out;
  });
}

function matches(c: Comparator, v: Version): boolean {
  const d = compareVersions(v, c.v);
  switch (c.op) {
    case '>=':
      return d >= 0;
    case '<=':
      return d <= 0;
    case '>':
      return d > 0;
    case '<':
      return d < 0;
    default:
      return d === 0;
  }
}

/** Does `version` satisfy `range`? Throws on an invalid range or version. */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) throw new Error(`Ongeldige versie: "${version}"`);
  return parseRange(range).some((set) => set.every((c) => matches(c, v)));
}

// ------------------------------------------------------------------ manifest

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PUBLISHER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,99}$/;
const SPDX_RE = /^[A-Za-z0-9][A-Za-z0-9.+\-() ]{0,119}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const IDENT_RE = /^[a-z0-9][a-z0-9_.:-]{0,59}$/;

/** A manifest file path must be relative, posix, without "." / ".." / empty segments or control characters. */
export function isSafeManifestPath(p: string): boolean {
  if (typeof p !== 'string' || !p || p.length > 400) return false;
  if (/[\u0000-\u001f\\]/.test(p) || p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && !/[<>:"|?*]/.test(seg) && !/[. ]$/.test(seg));
}

/** Structural validation; returns readable (Dutch) errors. An unsigned manifest may have an empty publicKey. */
export function validateManifest(m: any): string[] {
  const e: string[] = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['teambot-package.json moet een JSON-object zijn.'];
  if (m.format !== PACKAGE_FORMAT) e.push(`Het veld "format" moet "${PACKAGE_FORMAT}" zijn.`);
  if (typeof m.name !== 'string' || !NAME_RE.test(m.name)) e.push('Het veld "name" moet een korte naam zijn met kleine letters, cijfers, punt, liggend streepje of koppelteken.');
  if (typeof m.version !== 'string' || !parseVersion(m.version)) e.push('Het veld "version" moet een semver-versie zijn, bijvoorbeeld 1.0.0.');
  if (!PACKAGE_KINDS.includes(m.kind)) e.push(`Het veld "kind" moet een van ${PACKAGE_KINDS.join(', ')} zijn.`);
  const pub = m.publisher;
  if (!pub || typeof pub !== 'object') e.push('Het veld "publisher" ontbreekt.');
  else {
    if (typeof pub.id !== 'string' || !PUBLISHER_ID_RE.test(pub.id)) e.push('publisher.id is ongeldig (letters, cijfers en . _ : @ / -; maximaal 100 tekens).');
    if (typeof pub.name !== 'string' || !pub.name.trim() || pub.name.length > 120) e.push('publisher.name ontbreekt of is te lang (maximaal 120 tekens).');
    if (pub.publicKey !== undefined && typeof pub.publicKey !== 'string') e.push('publisher.publicKey moet tekst zijn.');
    else if (pub.publicKey || m.signature !== undefined) {
      try {
        if (normalizePublicKey(pub.publicKey) !== pub.publicKey) e.push('publisher.publicKey moet standaard-base64 met opvulling zijn.');
      } catch (err: any) {
        e.push(`publisher.publicKey: ${err.message}`);
      }
    }
  }
  if (typeof m.teambot !== 'string' || !m.teambot.trim()) e.push('Het veld "teambot" (compatibele TeamBot-versies, bijvoorbeeld ">=0.1.0 <1.0.0") ontbreekt.');
  else {
    try {
      parseRange(m.teambot);
    } catch (err: any) {
      e.push(`Het veld "teambot" is geen geldig versiebereik: ${err.message}`);
    }
  }
  if (m.requires !== undefined) {
    if (!m.requires || typeof m.requires !== 'object' || Array.isArray(m.requires)) e.push('Het veld "requires" moet een object zijn.');
    else
      for (const k of ['toolGroups', 'modules']) {
        const v = m.requires[k];
        if (v !== undefined && (!Array.isArray(v) || v.length > 50 || v.some((x: any) => typeof x !== 'string' || !IDENT_RE.test(x)))) e.push(`requires.${k} moet een lijst met namen zijn.`);
      }
  }
  if (typeof m.license !== 'string' || !SPDX_RE.test(m.license)) e.push('Het veld "license" moet een SPDX-licentie zijn, bijvoorbeeld "Apache-2.0" of "MIT".');
  if (m.description !== undefined && (typeof m.description !== 'string' || m.description.length > 1024)) e.push('Het veld "description" is te lang (maximaal 1024 tekens).');
  if (m.homepage !== undefined && (typeof m.homepage !== 'string' || !/^https:\/\//i.test(m.homepage) || m.homepage.length > 500)) e.push('Het veld "homepage" moet een https-adres zijn.');
  if (!m.files || typeof m.files !== 'object' || Array.isArray(m.files)) e.push('Het veld "files" (pad -> sha256) ontbreekt.');
  else {
    const entries = Object.entries(m.files);
    if (entries.length > 1000) e.push('Te veel bestanden in "files".');
    for (const [p, h] of entries) {
      if (!isSafeManifestPath(p) || p === MANIFEST_FILE) e.push(`Onveilig of ongeldig pad in "files": ${String(p).slice(0, 100)}`);
      else if (typeof h !== 'string' || !HEX64.test(h)) e.push(`Ongeldige sha256 voor ${p}.`);
    }
    if (PACKAGE_KINDS.includes(m.kind) && !(MAIN_FILE[m.kind as PackageKind] in m.files)) e.push(`Een ${m.kind}-pakket moet ${MAIN_FILE[m.kind as PackageKind]} bevatten.`);
  }
  if (m.signature !== undefined) {
    try {
      b64ToBytes(m.signature, 64, 'De handtekening');
    } catch (err: any) {
      e.push(err.message);
    }
  }
  return e;
}

export interface CreateManifestInput {
  name: string;
  version: string;
  kind: PackageKind;
  publisher: { id: string; name: string; publicKey?: string };
  license: string;
  teambot?: string;
  requires?: PackageRequires;
  description?: string;
  homepage?: string;
  files: FileInput;
}

/** Build an (unsigned) manifest for the given files. */
export function createManifest(o: CreateManifestInput): PackageManifest {
  const m: PackageManifest = {
    format: PACKAGE_FORMAT,
    name: o.name,
    version: o.version,
    kind: o.kind,
    ...(o.description ? { description: o.description } : {}),
    publisher: { id: o.publisher.id, name: o.publisher.name, publicKey: o.publisher.publicKey ? normalizePublicKey(o.publisher.publicKey) : '' },
    teambot: o.teambot || DEFAULT_COMPAT_RANGE,
    requires: { ...(o.requires?.toolGroups?.length ? { toolGroups: [...o.requires.toolGroups] } : {}), ...(o.requires?.modules?.length ? { modules: [...o.requires.modules] } : {}) },
    license: o.license,
    ...(o.homepage ? { homepage: o.homepage } : {}),
    files: hashFiles(o.files),
  };
  return m;
}

/** The exact bytes that are signed. */
export function signingPayload(manifest: object): Buffer {
  const { signature: _ignored, ...rest } = manifest as any;
  return Buffer.from(SIGNATURE_CONTEXT + canonicalJson(rest), 'utf8');
}

/**
 * Sign a manifest. Fills `publisher.publicKey` from the private key when empty; refuses when the
 * manifest names a different key. Returns a new object; the input is not modified.
 */
export function signManifest(manifest: PackageManifest, privateKeyPem: string): PackageManifest {
  const key = privateKeyObject(privateKeyPem);
  const pub = publicKeyFromPrivateKey(privateKeyPem);
  const cur = manifest.publisher?.publicKey || '';
  if (cur && cur !== pub) throw new Error('Deze privésleutel hoort niet bij publisher.publicKey in het manifest. Gebruik de juiste sleutel of maak publicKey leeg.');
  const { signature: _old, ...rest } = manifest;
  const unsigned = { ...rest, publisher: { ...manifest.publisher, publicKey: pub } } as PackageManifest;
  const errors = validateManifest(unsigned);
  if (errors.length) throw new Error(`Het manifest is ongeldig: ${errors.join(' ')}`);
  const signature = crypto.sign(null, signingPayload(unsigned), key).toString('base64');
  return { ...unsigned, signature };
}

/** Check only the Ed25519 signature (not the files). */
export function verifyManifestSignature(manifest: any): { ok: boolean; error?: string } {
  if (!manifest?.signature) return { ok: false, error: 'Het manifest is niet ondertekend.' };
  try {
    const key = publicKeyObject(manifest.publisher?.publicKey);
    const sig = b64ToBytes(manifest.signature, 64, 'De handtekening');
    return crypto.verify(null, signingPayload(manifest), key, sig) ? { ok: true } : { ok: false, error: 'De handtekening klopt niet bij de inhoud van het manifest.' };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// ------------------------------------------------------------------ verification

export type SignatureState = 'trusted' | 'untrusted' | 'unsigned' | 'invalid';

export interface VerifyOptions {
  /** The running TeamBot version; when set, the manifest's "teambot" range is checked. */
  appVersion?: string;
  /** Trusted publisher keys (canonical base64) -> display name. */
  trusted?: Map<string, string> | Iterable<{ publicKey: string; name: string }>;
  /** Available tool groups / modules; when set, "requires" is checked against them. */
  toolGroups?: Iterable<string>;
  modules?: Iterable<string>;
  /** Refuse packages of another kind. */
  expectKind?: PackageKind;
  /**
   * Check only the manifest (structure, signature, compatibility), not the files. For catalog listings where the
   * files are downloaded later; the files must always be verified before installing.
   */
  skipFiles?: boolean;
}

export interface PackageVerification {
  state: SignatureState;
  manifest: PackageManifest | null;
  signed: boolean;
  signatureValid: boolean;
  filesValid: boolean;
  publisher: (Publisher & { fingerprint: string }) | null;
  /** Name from the trust list (never the self-declared one) when the key is trusted. */
  trustedName: string | null;
  compatible: boolean;
  /** Why the package is not compatible (blocks install). */
  incompatible: string[];
  /** Why the package is invalid (blocks install). */
  errors: string[];
  warnings: string[];
}

function trustMap(t: VerifyOptions['trusted']): Map<string, string> {
  if (!t) return new Map();
  if (t instanceof Map) return t;
  const m = new Map<string, string>();
  for (const x of t) m.set(x.publicKey, x.name);
  return m;
}

/** Parse the manifest file of a package (null when absent). Throws on invalid JSON. */
export function readManifest(files: FileInput): any | null {
  const raw = toFileMap(files).get(MANIFEST_FILE);
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw).toString('utf8').replace(/^﻿/, ''));
  } catch {
    throw new Error('teambot-package.json is geen geldige JSON.');
  }
}

/**
 * Verify a package: manifest structure, Ed25519 signature, the sha256 of every file (no missing, changed
 * or unlisted files), compatibility (TeamBot version range and `requires`), and trust. Pure function.
 */
export function verifyPackage(input: FileInput, opts: VerifyOptions = {}): PackageVerification {
  const files = toFileMap(input);
  const out: PackageVerification = { state: 'unsigned', manifest: null, signed: false, signatureValid: false, filesValid: false, publisher: null, trustedName: null, compatible: true, incompatible: [], errors: [], warnings: [] };
  let m: any;
  try {
    m = readManifest(files);
  } catch (e: any) {
    out.state = 'invalid';
    out.errors.push(e.message);
    return out;
  }
  if (!m) return out;
  out.signed = m.signature !== undefined && m.signature !== null && m.signature !== '';
  const structural = validateManifest(m);
  if (structural.length) {
    out.state = 'invalid';
    out.errors.push(...structural.map((x) => `Pakketgegevens ongeldig: ${x}`));
    return out;
  }
  const manifest = m as PackageManifest;
  out.manifest = manifest;
  if (manifest.publisher.publicKey) out.publisher = { ...manifest.publisher, fingerprint: fingerprint(manifest.publisher.publicKey) };
  if (opts.expectKind && manifest.kind !== opts.expectKind) out.errors.push(`Dit is een ${manifest.kind}-pakket, geen ${opts.expectKind}-pakket.`);

  // Files: every file listed, unchanged, and nothing unlisted.
  const actual = hashFiles(files);
  const problems: string[] = [];
  if (!opts.skipFiles) for (const [p, h] of Object.entries(manifest.files)) {
    if (!(p in actual)) problems.push(`Bestand ${p} ontbreekt.`);
    else if (actual[p] !== h) problems.push(`Bestand ${p} is gewijzigd na het ondertekenen.`);
  }
  for (const p of Object.keys(actual)) if (!(p in manifest.files)) problems.push(`Bestand ${p} staat niet in het manifest (niet ondertekend).`);
  if (opts.skipFiles) {
    problems.length = 0;
    out.warnings.push('De bestanden worden bij het installeren gecontroleerd.');
  }
  out.filesValid = problems.length === 0;

  if (out.signed) {
    const sig = verifyManifestSignature(manifest);
    out.signatureValid = sig.ok;
    if (!sig.ok) out.errors.push(sig.error || 'De handtekening is ongeldig.');
    out.errors.push(...problems);
  } else {
    out.warnings.push(...problems.map((p) => `${p} (het manifest is niet ondertekend)`));
  }

  // Compatibility.
  if (opts.appVersion) {
    try {
      if (!satisfies(opts.appVersion, manifest.teambot)) out.incompatible.push(`Vereist TeamBot ${manifest.teambot}; dit is versie ${opts.appVersion}.`);
    } catch (e: any) {
      out.incompatible.push(e.message);
    }
  }
  if (opts.toolGroups) {
    const have = new Set(opts.toolGroups);
    const missing = (manifest.requires?.toolGroups || []).filter((g) => !have.has(g));
    if (missing.length) out.incompatible.push(`Vereist toolgroep(en) die hier niet bestaan: ${missing.join(', ')}.`);
  }
  if (opts.modules) {
    const have = new Set(opts.modules);
    const missing = (manifest.requires?.modules || []).filter((g) => !have.has(g));
    if (missing.length) out.incompatible.push(`Vereist module(s) die hier niet actief zijn: ${missing.join(', ')}.`);
  }
  out.compatible = out.incompatible.length === 0;

  if (out.errors.length) out.state = 'invalid';
  else if (!out.signed) out.state = 'unsigned';
  else {
    const name = trustMap(opts.trusted).get(manifest.publisher.publicKey);
    out.state = name !== undefined ? 'trusted' : 'untrusted';
    out.trustedName = name ?? null;
  }
  return out;
}

// ------------------------------------------------------------------ inline form (catalogs, JSON uploads)

/** File content in JSON: UTF-8 text, or base64 for binary files. */
export type InlineContent = string | { base64: string };

/** A package as JSON: `{ manifest, files }` (used in catalog entries and API bodies). */
export interface InlinePackage {
  manifest: any;
  files: Record<string, InlineContent>;
}

export function inlineToFiles(p: InlinePackage): Map<string, Uint8Array> {
  if (!p || typeof p !== 'object' || !p.files || typeof p.files !== 'object') throw new Error('Pakket zonder bestanden.');
  const out = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(p.files)) {
    if (!isSafeManifestPath(k) || k === MANIFEST_FILE) throw new Error(`Onveilig pad in het pakket: ${String(k).slice(0, 100)}`);
    if (typeof v === 'string') out.set(k, Buffer.from(v, 'utf8'));
    else if (v && typeof v === 'object' && typeof v.base64 === 'string') out.set(k, Buffer.from(v.base64, 'base64'));
    else throw new Error(`Ongeldige inhoud voor ${k}.`);
  }
  if (p.manifest !== undefined && p.manifest !== null) out.set(MANIFEST_FILE, Buffer.from(JSON.stringify(p.manifest), 'utf8'));
  return out;
}

export function filesToInline(files: FileInput): InlinePackage {
  const m = toFileMap(files);
  const out: InlinePackage = { manifest: readManifest(m), files: {} };
  for (const p of [...m.keys()].sort()) {
    if (p === MANIFEST_FILE) continue;
    const b = Buffer.from(m.get(p)!);
    const text = b.toString('utf8');
    out.files[p] = Buffer.from(text, 'utf8').equals(b) && !b.includes(0) ? text : { base64: b.toString('base64') };
  }
  return out;
}
