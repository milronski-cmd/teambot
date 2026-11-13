import crypto from 'node:crypto';
import { newer } from '../../../shared/version.js';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { parseVersion, runQuick, setBinEnv } from './proc.js';
import { APP_VERSION } from '../../core/config.js';

/**
 * TeamBot's own copies of Claude Code, Codex and OpenCode (C-07), so a bot never depends on another app's copy.
 * Never installed globally, no install scripts run: only the binary for this platform goes into TeamBot's data folder
 * (`<data>/runtimes/<cli>/<version>/`), for this user only. A copy never updates itself (auto-updaters off).
 *
 * Two sources:
 *  - npm (Claude Code, Codex): the vendor's official platform package (the one `npm install -g` uses). Checked twice:
 *    the npm registry's ECDSA signature over "<name>@<version>:<integrity>" with the registry key below (pinned in
 *    TeamBot, not fetched) plus the SHA-512 of the tarball against that signed integrity; and for the pinned version
 *    also against the SHA-512 recorded here. "Bijwerken" installs the newest version through the same checks.
 *  - GitHub releases (OpenCode): the 2.x line is only published there (npm stays on 1.x), as one zip/tar.gz per
 *    platform. The pinned version is checked against the SHA-256 recorded here (taken from the GitHub API digest and
 *    cross-checked on a real download of every platform). "Bijwerken" to a newer 2.x can only be checked against the
 *    SHA-256 that GitHub publishes for that release asset. That is a weaker check than npm's: GitHub computes the
 *    digest when the asset is uploaded, so it catches a damaged or swapped download, but nobody signs it — whoever can
 *    publish releases in the vendor's repository can also publish a matching digest. The UI says so.
 */

export type RuntimeId = 'claude-code' | 'codex-cli' | 'opencode';

interface Spec {
  label: string;
  /** Where the copy comes from (see above). */
  source: 'npm' | 'github';
  /** npm: the main package (its dist-tags give the newest version). github: "owner/repo". */
  main: string;
  /** Version TeamBot was tested with (installed by "Installeren"). */
  pinned: string;
  /** npm: platform package with the binary for a version. */
  pkg(plat: string, version: string): { name: string; version: string };
  /** github: the release asset for a platform (null: none for it). */
  asset?(plat: string): string | null;
  /** github: the major version "Bijwerken" stays on (2 for OpenCode 2.x). */
  line?: number;
  /** Binary names, best first (the .mjs name is only used by test fixtures). */
  bins: string[];
  /** Environment for every start of this copy: auto-updates off; Codex also needs its bundled helpers (rg) on PATH. */
  env(root: string, bin: string): Record<string, string>;
  /** Checksum of the pinned version per platform, as published (checked 2026-11-07): npm "sha512-…" (SRI), github "sha256:<hex>". */
  integrity: Record<string, string>;
  /** Download size of the pinned version for this platform in MB (shown before installing). */
  sizeMb: Record<string, number>;
}

const OS_NAME: Record<string, string> = { win32: 'windows', darwin: 'darwin', linux: 'linux' };

/** OpenCode's release assets: zip on Windows and macOS, tar.gz on Linux (the baseline/musl builds are not used). */
const opencodeAsset = (plat: string): string | null => {
  const [os, arch] = plat.split('-');
  if (!OS_NAME[os] || !['x64', 'arm64'].includes(arch)) return null;
  return `opencode-${OS_NAME[os]}-${arch}.${os === 'linux' ? 'tar.gz' : 'zip'}`;
};

export const RUNTIMES: Record<RuntimeId, Spec> = {
  'claude-code': {
    label: 'Claude Code',
    source: 'npm',
    main: '@anthropic-ai/claude-code',
    pinned: '2.1.319',
    pkg: (plat, version) => ({ name: `@anthropic-ai/claude-code-${plat}`, version }),
    bins: ['claude.exe', 'claude', 'claude.mjs'],
    env: () => ({ DISABLE_AUTOUPDATER: '1' }),
    integrity: {
      'win32-x64': 'sha512-wncPKSYL/zvjs84k7wZEj+IGQx/LjqQNhgnQhzDEibP0yAVBguAs4p8nBfFAEDbDdUc4Z2co+OaKZV1t02xINA==',
      'win32-arm64': 'sha512-LJXWhy1rZGysmjwmC1/kapdaM55phYFPa3MGad033F01f76+q1lT4N8TCPC6wysHxrkLed/yucLGqMSTNY63cg==',
      'darwin-x64': 'sha512-XuzaFESZRKPupllcbbFCy0xdw9G9+VHLWbXaJhJhUD4gNTmt/ALkKMnECwr3umA7if1cAGDNb2tcgRCIpIy+nQ==',
      'darwin-arm64': 'sha512-dyAOFnsXbeyGgFJMlo2n6zSgLli5r4fTZ3Tj48eELxjccqM4s/wUmQ6P0DyCbxU0EC44VV44T2qj5xEpen25aA==',
      'linux-x64': 'sha512-FO4Sd23BO1VCQPiJe5vG3bNnmV5+YiTau7o1lqK3Fr5VlE4TLdKiyYpwQRwEXO91kE2l12Ep2i7J19T8Md2oOQ==',
      'linux-arm64': 'sha512-PlyxaZTAuU0VF3P/ERF4+deMRjT57cr90SHCrYms3HTebr3eItEWJozw6zq9cs88tc8XoF9ESAIghKXfq9HACg==',
    },
    sizeMb: { 'win32-x64': 160, 'win32-arm64': 155, 'darwin-x64': 150, 'darwin-arm64': 145, 'linux-x64': 160, 'linux-arm64': 155 },
  },
  'codex-cli': {
    label: 'OpenAI Codex CLI',
    source: 'npm',
    main: '@openai/codex',
    pinned: '0.167.0',
    pkg: (plat, version) => ({ name: '@openai/codex', version: `${version}-${plat}` }),
    bins: ['codex.exe', 'codex', 'codex.mjs'],
    // The npm launcher puts the bundled ripgrep (vendor/<target>/codex-path) on PATH; TeamBot starts the binary itself.
    env: (_root, bin) => withPathPrefix(path.join(path.dirname(path.dirname(bin)), 'codex-path')),
    integrity: {
      'win32-x64': 'sha512-duPCBwflc8qhQdLekbL8fDYF646tW4gj0/l9BDnsVhEzoqm6OwxMAJXDFwSOLUUJPCmjBeM+eHYAx4fP/hwfjg==',
      'win32-arm64': 'sha512-dYeYQZ66LCNnFXyF5vHRsbJQLyfbY3G8vDyn6XG3NxcwMFz4stkgSdC94UPc1NhCxkhpufHlkAm1oe+Z28Pw5Q==',
      'darwin-x64': 'sha512-wKoBiI6SBSg8fqiEYEOJs/NM/ZzKaCgy1cseX9LJbuDq3GCCKkeW9BUGe1ZEkyhhZ5Yfj+HzdUfp698abP2tDA==',
      'darwin-arm64': 'sha512-7YtMDZX/jbWH9+fCVQg7BVsov8WvBzu4iuedXJEDlUdZxaTrYX2bEQwHIn3p0gxgSMfm30HGK9+bZm1aGSZaHw==',
      'linux-x64': 'sha512-FNc7danfUng9Sp6w+Fh7kofNHHZpA6VMyNKWsWrS3OwHly69gywTWeiuwrUPXpJSho8Df4xqRsHfHRPzj7zYQg==',
      'linux-arm64': 'sha512-5cv+sybRWqpRJL6KCv3YSnIx1GHRmjek997C38n1Zfno4HomKDLkNSjWLDOOc2+ISlVNSRRnySWq4zKmzlY12g==',
    },
    sizeMb: { 'win32-x64': 181, 'win32-arm64': 170, 'darwin-x64': 170, 'darwin-arm64': 165, 'linux-x64': 175, 'linux-arm64': 170 },
  },
  // OpenCode 2.x from its GitHub releases (npm only has the older 1.x line; OpenBot runs 2.2.5). The SHA-256 values
  // are the GitHub API digests of v2.2.6 (released 2026-11-06), cross-checked on 2026-11-07 against the release's
  // SHA256SUMS file and against a real download of each of these six assets.
  opencode: {
    label: 'OpenCode',
    source: 'github',
    main: 'anomalyco/opencode',
    pinned: '2.2.6',
    pkg: (plat, version) => ({ name: opencodeAsset(plat) || '', version }),
    asset: opencodeAsset,
    line: 2,
    bins: ['opencode.exe', 'opencode', 'opencode.mjs'],
    env: () => ({ OPENCODE_DISABLE_AUTOUPDATE: '1' }),
    integrity: {
      'win32-x64': 'sha256:f75c16b33b8523fe1ff41e7d97e3ae654a47d59a0e327def24db2d9291bb24be',
      'win32-arm64': 'sha256:d2cf2b4de31203e6984263d40fc70206d6a62e800b4b4492a809f28cae862139',
      'darwin-x64': 'sha256:b2962dc445d873df56ae7d3ba7e66502b046bbc4dafa820eca18d0303a98a29c',
      'darwin-arm64': 'sha256:15491608f6b0bc4debe5eac35eab629a2b07ea9a1fbac68ad53bcea59fcc4b45',
      'linux-x64': 'sha256:08bb21d6326ce740d91cce7ebe88a6536933f6e1e30353b91a06b01f25da306c',
      'linux-arm64': 'sha256:f2d27600c367e45057d6a16f6a5c2aa8d77b41a9b10d4bc3d849c2f88870e944',
    },
    sizeMb: { 'win32-x64': 125, 'win32-arm64': 118, 'darwin-x64': 114, 'darwin-arm64': 108, 'linux-x64': 122, 'linux-arm64': 120 },
  },
};

const GITHUB_API = 'https://api.github.com';
const GITHUB_WEB = 'https://github.com';
/** Where github.com sends release downloads (its asset storage). Any other host is refused. */
const GITHUB_ASSET_HOST = /^([\w-]+\.)*githubusercontent\.com$/i;

export const isRuntimeId = (id: string): id is RuntimeId => Object.hasOwn(RUNTIMES, id);

/** The npm registry's signing key (https://registry.npmjs.org/-/npm/v1/keys, current key, checked 2026-11-07). */
const NPM_KEYS = [{ keyid: 'SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U', key: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEY6Ya7W++7aUPzvMTrezH6Ycx3c+HOKYCcNGybJZSCJq/fd7Qa8uuAKtdIkUQtQiEKERhAmE5lMMJhP8OkDOa2g==' }];
const NPM_REGISTRY = 'https://registry.npmjs.org';

export const platformKey = (platform = process.platform, arch = process.arch) => `${platform}-${arch}`;

/** PATH with one folder in front, under the key this OS uses ("Path" on Windows). */
export function withPathPrefix(dir: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  return { [key]: [dir, env[key] || ''].filter(Boolean).join(path.delimiter) };
}

export interface Installed {
  version: string;
  bin: string;
  integrity: string;
  installedAt: string;
  /** The version TeamBot pins (tested); false after "Bijwerken" to a newer one. */
  pinned: boolean;
}

export interface Progress {
  phase: 'metadata' | 'download' | 'verify' | 'extract' | 'check' | 'done' | 'error';
  version: string;
  received?: number;
  total?: number;
  error?: string;
}

export class RuntimeError extends Error {}

/** "npm verified this tarball": the registry's signature over name@version:integrity, with a key TeamBot knows. */
export function verifyRegistrySignature(name: string, version: string, integrity: string, signatures: any, keys = NPM_KEYS): boolean {
  if (!Array.isArray(signatures)) return false;
  for (const s of signatures) {
    const k = keys.find((x) => x.keyid === s?.keyid);
    if (!k || typeof s.sig !== 'string') continue;
    try {
      if (crypto.verify('sha256', Buffer.from(`${name}@${version}:${integrity}`), { key: Buffer.from(k.key, 'base64'), format: 'der', type: 'spki' }, Buffer.from(s.sig, 'base64'))) return true;
    } catch {
      /* malformed signature: try the next */
    }
  }
  return false;
}

const SAFE_SEGMENT = /^[^<>:"|?*\0]+$/;

/**
 * Where an archive entry goes inside `root`, or null for an empty name. A leading "package/" (npm) is dropped.
 * Absolute paths (also "C:/…" and "\\server\…"), ".." and characters Windows cannot store are refused, and the
 * result must lie inside `root`: nothing from an archive lands outside the folder TeamBot extracts into.
 */
export function safeTarget(root: string, raw: string): string | null {
  const rel = raw.replace(/\\/g, '/').replace(/^\.?\/+/, '');
  const inner = rel.startsWith('package/') ? rel.slice('package/'.length) : rel;
  const parts = inner.split('/').filter(Boolean);
  if (!parts.length) return null;
  if (/^\/|^[A-Za-z]:/.test(raw.replace(/\\/g, '/')) || path.isAbsolute(inner) || parts.some((p) => p === '..' || p === '.' || !SAFE_SEGMENT.test(p))) throw new RuntimeError(`Onveilig pad in het pakket: ${raw.slice(0, 120)}`);
  const out = path.resolve(root, ...parts);
  if (!out.startsWith(root + path.sep)) throw new RuntimeError(`Onveilig pad in het pakket: ${raw.slice(0, 120)}`);
  return out;
}

/** At most this much unpacked (OpenCode is ~270 MB): a broken or hostile archive cannot fill the disk. */
const MAX_UNPACKED = 2 * 1024 ** 3;

/**
 * Extract a zip (GitHub release assets) into `dest`, streaming one entry at a time (binaries of 250+ MB). The same
 * guards as the tarballs: only regular files and folders, no links (Unix mode 120000), no absolute paths or "..",
 * nothing encrypted, only "stored" and "deflate", sizes and CRC-32 checked against the zip's own directory.
 */
export async function extractZip(file: string, dest: string): Promise<string[]> {
  fs.mkdirSync(dest, { recursive: true });
  const root = path.resolve(dest);
  const fd = fs.openSync(file, 'r');
  const read = (pos: number, len: number) => {
    const b = Buffer.alloc(len);
    const n = fs.readSync(fd, b, 0, len, pos);
    if (n !== len) throw new RuntimeError('Het zip-bestand is afgekapt (onvolledige download).');
    return b;
  };
  const entries: { name: string; method: number; csize: number; usize: number; crc: number; local: number; exec: boolean; dir: boolean }[] = [];
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 22 + 0xffff);
    if (tailLen < 22) throw new RuntimeError('Dit is geen geldig zip-bestand.');
    const tail = read(size - tailLen, tailLen);
    let e = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) {
      e = i;
      break;
    }
    if (e < 0) throw new RuntimeError('Dit is geen geldig zip-bestand (geen inhoudsopgave).');
    let count = tail.readUInt16LE(e + 10);
    let cdSize = tail.readUInt32LE(e + 12);
    let cdOff = tail.readUInt32LE(e + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
      // ZIP64: the locator just before the end record points at the ZIP64 end record.
      const locAt = size - tailLen + e - 20;
      const loc = locAt >= 0 ? read(locAt, 20) : null;
      if (!loc || loc.readUInt32LE(0) !== 0x07064b50) throw new RuntimeError('Dit is geen geldig zip-bestand (ZIP64 zonder verwijzing).');
      const z = read(Number(loc.readBigUInt64LE(8)), 56);
      if (z.readUInt32LE(0) !== 0x06064b50) throw new RuntimeError('Dit is geen geldig zip-bestand (ZIP64).');
      count = Number(z.readBigUInt64LE(32));
      cdSize = Number(z.readBigUInt64LE(40));
      cdOff = Number(z.readBigUInt64LE(48));
    }
    if (count > 10_000 || cdSize > 64 * 1024 ** 2 || cdOff + cdSize > size) throw new RuntimeError('Het zip-bestand heeft een onmogelijke inhoudsopgave.');
    const cd = read(cdOff, cdSize);
    let p = 0;
    let total = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new RuntimeError('Het zip-bestand heeft een beschadigde inhoudsopgave.');
      const madeBy = cd.readUInt16LE(p + 4) >> 8;
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let csize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const ext = cd.readUInt32LE(p + 38);
      let local = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      // ZIP64 extra field: the 64-bit values for the fields that read 0xFFFFFFFF, in this order.
      let x = p + 46 + nameLen;
      const xEnd = x + extraLen;
      while (x + 4 <= xEnd) {
        const id = cd.readUInt16LE(x);
        const len = cd.readUInt16LE(x + 2);
        if (id === 0x0001) {
          let q = x + 4;
          if (usize === 0xffffffff) (usize = Number(cd.readBigUInt64LE(q)), (q += 8));
          if (csize === 0xffffffff) (csize = Number(cd.readBigUInt64LE(q)), (q += 8));
          if (local === 0xffffffff) local = Number(cd.readBigUInt64LE(q));
        }
        x += 4 + len;
      }
      p = xEnd + commentLen;
      const unixMode = madeBy === 3 ? ext >>> 16 : 0;
      const kind = unixMode & 0o170000;
      if (kind === 0o120000 || (kind && kind !== 0o100000 && kind !== 0o040000)) throw new RuntimeError(`Het pakket bevat een link of ander bijzonder bestand (${name.slice(0, 80)}); TeamBot pakt dat niet uit.`);
      if (flags & 0x1) throw new RuntimeError('Het zip-bestand is versleuteld; TeamBot pakt dat niet uit.');
      const dir = name.endsWith('/') || kind === 0o040000;
      if (!dir && method !== 0 && method !== 8) throw new RuntimeError(`Onbekende compressie in het zip-bestand (${method}).`);
      total += usize;
      if (total > MAX_UNPACKED) throw new RuntimeError('Het pakket is uitgepakt groter dan 2 GB; TeamBot pakt dat niet uit.');
      safeTarget(root, name); // refuse the whole archive before writing anything
      entries.push({ name, method, csize, usize, crc, local, exec: !!(unixMode & 0o111), dir });
    }
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
  const written: string[] = [];
  try {
    for (const en of entries) {
      const out = safeTarget(root, en.name);
      if (!out) continue;
      if (en.dir) {
        fs.mkdirSync(out, { recursive: true });
        continue;
      }
      const lh = read(en.local, 30);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new RuntimeError('Het zip-bestand is beschadigd (lokale kop).');
      const start = en.local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      written.push(out);
      const ws = fs.createWriteStream(out, { mode: en.exec ? 0o755 : 0o644 });
      let crc = 0;
      let n = 0;
      const src = en.csize ? fs.createReadStream(file, { start, end: start + en.csize - 1 }) : Readable.from([]);
      const body = en.method === 8 ? src.pipe(zlib.createInflateRaw()) : src;
      for await (const chunk of body as AsyncIterable<Buffer>) {
        n += chunk.length;
        if (n > en.usize) throw new RuntimeError('Het zip-bestand klopt niet met zijn eigen inhoudsopgave.');
        crc = zlib.crc32(chunk, crc);
        if (!ws.write(chunk)) await once(ws, 'drain');
      }
      ws.end();
      await once(ws, 'close');
      if (n !== en.usize || crc >>> 0 !== en.crc >>> 0) throw new RuntimeError('Het zip-bestand is beschadigd (controlegetal klopt niet).');
    }
  } finally {
    fs.closeSync(fd);
  }
  return written;
}

/**
 * Extract an npm tarball (gzip + ustar/pax) into `dest`, streaming (binaries of 300+ MB). Only regular files and
 * folders under "package/"; links, absolute paths and ".." are refused, so nothing lands outside `dest`.
 */
export async function extractNpmTarball(file: string, dest: string): Promise<string[]> {
  fs.mkdirSync(dest, { recursive: true });
  const root = path.resolve(dest);
  const written: string[] = [];
  const input = fs.createReadStream(file).pipe(zlib.createGunzip());
  let buf: Buffer = Buffer.alloc(0);
  let cur: { remaining: number; pad: number; out: fs.WriteStream | null; collect: Buffer[] | null; kind: string } | null = null;
  let pax: Record<string, string> = {};
  let longName: string | null = null;
  let ended = false;
  const target = (raw: string): string | null => safeTarget(root, raw);
  const finishEntry = async () => {
    const e = cur!;
    cur = null;
    if (e.out) {
      e.out.end();
      await once(e.out, 'close');
    }
    if (e.collect) {
      const text = Buffer.concat(e.collect).toString('utf8');
      if (e.kind === 'L') longName = text.replace(/\0+$/, '');
      else if (e.kind === 'x') {
        pax = {};
        // "<len> key=value\n" records
        for (const rec of text.split('\n')) {
          const m = rec.match(/^\d+ ([^=]+)=([\s\S]*)$/);
          if (m) pax[m[1]] = m[2];
        }
      }
    }
  };
  for await (const chunk of input as AsyncIterable<Buffer>) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (cur) {
        const take = Math.min(cur.remaining, buf.length);
        if (take > 0) {
          const part = buf.subarray(0, take);
          if (cur.out && !cur.out.write(part)) await once(cur.out, 'drain');
          if (cur.collect) cur.collect.push(Buffer.from(part));
          cur.remaining -= take;
          buf = buf.subarray(take);
        }
        if (cur.remaining > 0) break;
        if (buf.length < cur.pad) break;
        buf = buf.subarray(cur.pad);
        await finishEntry();
        continue;
      }
      if (ended || buf.length < 512) break;
      const h = buf.subarray(0, 512);
      buf = buf.subarray(512);
      if (h.every((b) => b === 0)) {
        ended = true;
        break;
      }
      const str = (a: number, n: number) => h.subarray(a, a + n).toString('utf8').replace(/\0.*$/s, '');
      const sizeField = h.subarray(124, 136);
      const size = sizeField[0] & 0x80 ? Number(sizeField.readBigUInt64BE(4)) : parseInt(str(124, 12).trim() || '0', 8);
      const type = String.fromCharCode(h[156] || 48);
      const prefix = str(345, 155);
      const name = pax.path || longName || (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
      const realSize = pax.size ? Number(pax.size) : size;
      if (type !== 'x' && type !== 'L' && type !== 'g') {
        pax = {};
        longName = null;
      }
      const pad = (512 - (realSize % 512)) % 512;
      if (type === 'x' || type === 'L' || type === 'g') {
        cur = { remaining: realSize, pad, out: null, collect: type === 'g' ? null : [], kind: type };
        continue;
      }
      if (type === '5') {
        const dir = target(name);
        if (dir) fs.mkdirSync(dir, { recursive: true });
        cur = { remaining: 0, pad: 0, out: null, collect: null, kind: type };
        continue;
      }
      if (type !== '0' && type !== '\0' && type !== '7') throw new RuntimeError(`Het pakket bevat een link of ander bijzonder bestand (${name.slice(0, 80)}); TeamBot pakt dat niet uit.`);
      const out = target(name);
      if (!out) throw new RuntimeError('Leeg pad in het pakket');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const mode = parseInt(str(100, 8).trim() || '644', 8) & 0o777;
      written.push(out);
      cur = { remaining: realSize, pad, out: fs.createWriteStream(out, { mode: mode & 0o111 ? 0o755 : 0o644 }), collect: null, kind: type };
    }
  }
  if (cur) throw new RuntimeError('Het pakket is afgekapt (onvolledige download).');
  return written;
}

export interface RuntimeOptions {
  /** Registry base URL (tests: a local fixture server). */
  registry?: string;
  /** Registry signing keys (tests: a fixture key). */
  keys?: { keyid: string; key: string }[];
  /** GitHub API and web base URL (tests: a local fixture server that plays both). */
  github?: string;
  /** Pinned versions/integrity (tests: fixture pins). */
  specs?: Partial<Record<RuntimeId, Partial<Spec>>>;
  platform?: string;
}

/** TeamBot's own CLI copies: install, update, uninstall, and where the binary is. */
export class Runtimes {
  readonly registry: string;
  private keys: { keyid: string; key: string }[];
  private githubApi: string;
  private githubWeb: string;
  private specs: Record<RuntimeId, Spec>;
  readonly plat: string;
  private jobs = new Map<RuntimeId, Progress>();
  private latestCache = new Map<RuntimeId, { at: number; v: string | null }>();

  constructor(
    private dataDir: string,
    o: RuntimeOptions = {},
  ) {
    // Tests and private mirrors: TEAMBOT_RUNTIME_REGISTRY + TEAMBOT_RUNTIME_KEYS (JSON) replace the npm registry and its
    // key; TEAMBOT_RUNTIME_GITHUB replaces api.github.com and github.com (one fixture server plays both).
    this.registry = (o.registry || process.env.TEAMBOT_RUNTIME_REGISTRY || NPM_REGISTRY).replace(/\/+$/, '');
    const gh = (o.github || process.env.TEAMBOT_RUNTIME_GITHUB || '').replace(/\/+$/, '');
    this.githubApi = gh || GITHUB_API;
    this.githubWeb = gh || GITHUB_WEB;
    let envKeys: any = null;
    try {
      envKeys = process.env.TEAMBOT_RUNTIME_KEYS ? JSON.parse(process.env.TEAMBOT_RUNTIME_KEYS) : null;
    } catch {
      envKeys = null;
    }
    this.keys = o.keys || (Array.isArray(envKeys) ? envKeys : NPM_KEYS);
    let envSpecs: any = null;
    try {
      envSpecs = process.env.TEAMBOT_RUNTIME_PINS ? JSON.parse(process.env.TEAMBOT_RUNTIME_PINS) : null;
    } catch {
      envSpecs = null;
    }
    const over = o.specs || envSpecs || {};
    this.specs = Object.fromEntries((Object.keys(RUNTIMES) as RuntimeId[]).map((id) => [id, { ...RUNTIMES[id], ...(over[id] || {}) }])) as Record<RuntimeId, Spec>;
    this.plat = o.platform || platformKey();
    for (const id of Object.keys(RUNTIMES) as RuntimeId[]) {
      const cur = this.current(id);
      if (cur) setBinEnv(cur.bin, this.specs[id].env(this.dir(id), cur.bin));
    }
  }

  spec(id: RuntimeId) {
    return this.specs[id];
  }

  dir(id: RuntimeId) {
    return path.join(this.dataDir, 'runtimes', id);
  }

  /** The installed copy, or null (also when its files were removed by hand). */
  current(id: RuntimeId): Installed | null {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(this.dir(id), 'current.json'), 'utf8')) as Installed;
      return j?.bin && fs.existsSync(j.bin) ? j : null;
    } catch {
      return null;
    }
  }

  job(id: RuntimeId): Progress | null {
    return this.jobs.get(id) || null;
  }

  /**
   * Newest version (for "update available"), cached for 6 hours; null when it cannot be read. npm: the "latest"
   * dist-tag. GitHub: the newest release of the pinned major line that is not a draft or a pre-release (GitHub's own
   * "latest" flag cannot be used: OpenCode marks its 1.x releases as latest).
   */
  async latest(id: RuntimeId, fresh = false): Promise<string | null> {
    const c = this.latestCache.get(id);
    if (!fresh && c && Date.now() - c.at < (c.v ? 6 * 3600_000 : 10 * 60_000)) return c.v;
    let v: string | null = null;
    const s = this.specs[id];
    try {
      if (s.source === 'github') {
        const list = await this.getJson(`${this.githubApi}/repos/${s.main}/releases?per_page=40`, 15_000);
        v = newestStable(Array.isArray(list) ? list : [], s.line);
      } else {
        const j = await this.getJson(`${this.registry}/-/package/${encodePkg(s.main)}/dist-tags`, 15_000);
        v = typeof j?.latest === 'string' && /^\d+\.\d+\.\d+$/.test(j.latest) ? j.latest : null;
      }
    } catch {
      v = null;
    }
    this.latestCache.set(id, { at: Date.now(), v });
    return v;
  }

  /**
   * Status for the UI: installed copy, pinned version, newest version, the update to offer and a running job.
   * An update goes to the newest of (pinned, latest) that is newer than the copy: a copy from before TeamBot moved to
   * a newer pin (OpenCode 1.19.5 from npm) is offered the pinned version, with its stronger check.
   */
  async status(id: RuntimeId, o: { checkLatest?: boolean } = {}) {
    const s = this.specs[id];
    const cur = this.current(id);
    const latest = o.checkLatest === false ? (this.latestCache.get(id)?.v ?? null) : await this.latest(id);
    const best = latest && newer(latest, s.pinned) ? latest : s.pinned;
    const updateTo = cur && newer(best, cur.version) ? best : null;
    return {
      id,
      source: s.source,
      supported: !!s.integrity[this.plat],
      platform: this.plat,
      pinned: s.pinned,
      sizeMb: s.sizeMb[this.plat] ?? null,
      installed: cur ? { version: cur.version, pinned: cur.version === s.pinned, installedAt: cur.installedAt, path: cur.bin } : null,
      latest: updateTo || latest,
      updateAvailable: !!updateTo,
      /** "pinned": the update is the version TeamBot pins (own checksum); "latest": a newer one (the source's checks only). */
      updateKind: updateTo ? (updateTo === s.pinned ? ('pinned' as const) : ('latest' as const)) : null,
      job: this.job(id),
    };
  }

  /**
   * Download, verify and install a version (default: the pinned one) of a CLI into TeamBot's data folder. Refuses
   * anything that does not verify; the previous copy stays until the new one is in place and runs.
   */
  async install(id: RuntimeId, version: string | null, onProgress: (p: Progress) => void = () => {}): Promise<Installed> {
    if (this.jobs.has(id) && !['done', 'error'].includes(this.jobs.get(id)!.phase)) throw new RuntimeError(`${this.specs[id].label} wordt al geïnstalleerd.`);
    const s = this.specs[id];
    const v = version || s.pinned;
    if (!/^\d+\.\d+\.\d+$/.test(v)) throw new RuntimeError('Ongeldige versie');
    const report = (p: Omit<Progress, 'version'>) => {
      const full = { ...p, version: v };
      this.jobs.set(id, full);
      try {
        onProgress(full);
      } catch {
        /* listener errors never break an install */
      }
    };
    const dir = this.dir(id);
    const tmp = path.join(dir, `.tmp-${v}-${process.pid}`);
    const archive = path.join(dir, `.download-${v}`);
    try {
      report({ phase: 'metadata' });
      if (!s.integrity[this.plat] && v === s.pinned) throw new RuntimeError(`TeamBot heeft geen eigen kopie van ${s.label} voor dit platform (${this.plat}).`);
      const got = s.source === 'github' ? await this.fromGithub(s, v, archive, report) : await this.fromNpm(s, v, archive, report);
      report({ phase: 'extract' });
      fs.rmSync(tmp, { recursive: true, force: true });
      if (got.kind === 'zip') await extractZip(archive, tmp);
      else await extractNpmTarball(archive, tmp);
      const found = findBin(tmp, s.bins);
      if (!found) throw new RuntimeError(`Het programma van ${s.label} staat niet in het pakket.`);
      // Move into place, then check that it really starts.
      const final = path.join(dir, v);
      fs.rmSync(final, { recursive: true, force: true });
      fs.renameSync(tmp, final);
      const bin = path.join(final, path.relative(tmp, found));
      if (process.platform !== 'win32') fs.chmodSync(bin, 0o755);
      report({ phase: 'check' });
      setBinEnv(bin, s.env(dir, bin));
      const r = await runQuick(bin, ['--version'], { timeoutMs: 60_000 });
      const said = parseVersion(r.stdout || r.stderr);
      // A GitHub asset carries no package name or version of its own: the program must say it is the version asked for.
      if (!said || (s.source === 'github' && said !== v)) {
        setBinEnv(bin, null);
        fs.rmSync(final, { recursive: true, force: true });
        throw new RuntimeError(said ? `${s.label} ${v} meldt zich als versie ${said}; TeamBot installeert dit niet.` : `${s.label} ${v} start niet op deze computer${r.error ? `: ${r.error}` : ''}.`);
      }
      const installed: Installed = { version: v, bin, integrity: got.integrity, installedAt: new Date().toISOString(), pinned: v === s.pinned };
      fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify(installed, null, 2));
      // Only the copy in use stays.
      for (const e of fs.readdirSync(dir)) if (e !== v && e !== 'current.json') fs.rmSync(path.join(dir, e), { recursive: true, force: true });
      report({ phase: 'done' });
      return installed;
    } catch (e: any) {
      fs.rmSync(tmp, { recursive: true, force: true });
      report({ phase: 'error', error: e instanceof RuntimeError ? e.message : `Installeren lukte niet: ${String(e?.message || e).slice(0, 300)}` });
      throw e instanceof RuntimeError ? e : new RuntimeError(`Installeren lukte niet: ${String(e?.message || e).slice(0, 300)}`);
    } finally {
      fs.rmSync(archive, { force: true });
      fs.rmSync(archive + '.part', { force: true });
    }
  }

  /** npm: signed metadata, the pinned SHA-512 for the pinned version, the tarball checked against it. */
  private async fromNpm(s: Spec, v: string, file: string, report: (p: Omit<Progress, 'version'>) => void): Promise<{ kind: 'tgz'; integrity: string }> {
    const pkg = s.pkg(this.plat, v);
    const meta = await this.getJson(`${this.registry}/${encodePkg(pkg.name)}/${encodeURIComponent(pkg.version)}`, 30_000);
    if (meta?.name !== pkg.name || meta?.version !== pkg.version) throw new RuntimeError(`Het register gaf andere pakketgegevens terug dan gevraagd (${pkg.name}@${pkg.version}).`);
    const integrity = String(meta?.dist?.integrity || '');
    if (!/^sha512-[A-Za-z0-9+/]+=*$/.test(integrity)) throw new RuntimeError('Het pakket heeft geen SHA-512-controlesom.');
    if (!verifyRegistrySignature(pkg.name, pkg.version, integrity, meta?.dist?.signatures, this.keys)) throw new RuntimeError('De handtekening van het npm-register klopt niet; TeamBot installeert dit niet.');
    const pinnedIntegrity = v === s.pinned ? s.integrity[this.plat] : null;
    if (pinnedIntegrity && pinnedIntegrity !== integrity) throw new RuntimeError(`De controlesom van ${s.label} ${v} wijkt af van wat TeamBot vastlegde; TeamBot installeert dit niet.`);
    const url = String(meta?.dist?.tarball || '');
    if (new URL(url).origin !== new URL(this.registry).origin) throw new RuntimeError('Het downloadadres hoort niet bij het register.');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    report({ phase: 'download', received: 0 });
    await this.download(url, file, integrity, (received, total) => report({ phase: 'download', received, total }), () => false);
    return { kind: 'tgz', integrity };
  }

  /**
   * GitHub release: a stable release with exactly this tag, the platform's asset from the vendor's own repository,
   * checked against the SHA-256 TeamBot pinned (pinned version) or the digest GitHub publishes (a newer version,
   * the weaker check described at the top of this file). A release without a digest is not installed.
   */
  private async fromGithub(s: Spec, v: string, file: string, report: (p: Omit<Progress, 'version'>) => void): Promise<{ kind: 'zip' | 'tgz'; integrity: string }> {
    const name = s.asset?.(this.plat);
    if (!name) throw new RuntimeError(`TeamBot heeft geen eigen kopie van ${s.label} voor dit platform (${this.plat}).`);
    if (s.line && Number(v.split('.')[0]) !== s.line) throw new RuntimeError(`TeamBot installeert alleen ${s.label} ${s.line}.x.`);
    const tag = `v${v}`;
    const rel = await this.getJson(`${this.githubApi}/repos/${s.main}/releases/tags/${encodeURIComponent(tag)}`, 30_000);
    if (rel?.tag_name !== tag) throw new RuntimeError(`GitHub gaf een andere uitgave terug dan gevraagd (${tag}).`);
    if (rel.draft || rel.prerelease) throw new RuntimeError(`${s.label} ${v} is geen stabiele uitgave; TeamBot installeert die niet.`);
    const asset = (Array.isArray(rel.assets) ? rel.assets : []).find((a: any) => a?.name === name);
    if (!asset) throw new RuntimeError(`${s.label} ${v} heeft geen download voor dit platform (${name}).`);
    const published = typeof asset.digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(asset.digest) ? asset.digest : null;
    const pinned = v === s.pinned ? s.integrity[this.plat] || null : null;
    if (pinned && published && published !== pinned) throw new RuntimeError(`De controlesom van ${s.label} ${v} wijkt af van wat TeamBot vastlegde; TeamBot installeert dit niet.`);
    const expect = pinned || published;
    if (!expect) throw new RuntimeError(`GitHub publiceert geen controlesom voor ${s.label} ${v}; TeamBot installeert dit niet.`);
    const url = String(asset.browser_download_url || '');
    if (!url.startsWith(`${this.githubWeb}/${s.main}/releases/download/${tag}/`)) throw new RuntimeError('Het downloadadres hoort niet bij de uitgaven van de maker.');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    report({ phase: 'download', received: 0 });
    const web = new URL(this.githubWeb);
    // github.com answers with a redirect to its asset storage; only that (or the same server, for test fixtures).
    const mayFollow = (u: URL) => (u.protocol === 'https:' && GITHUB_ASSET_HOST.test(u.hostname)) || u.origin === web.origin;
    await this.download(url, file, expect, (received, total) => report({ phase: 'download', received, total }), mayFollow);
    return { kind: name.endsWith('.zip') ? 'zip' : 'tgz', integrity: expect };
  }

  /** Remove TeamBot's own copy (logins of the CLI itself, in the user's profile, stay). */
  uninstall(id: RuntimeId) {
    const cur = this.current(id);
    if (cur) setBinEnv(cur.bin, null);
    fs.rmSync(this.dir(id), { recursive: true, force: true });
    this.jobs.delete(id);
  }

  private async getJson(url: string, timeoutMs: number): Promise<any> {
    const gh = url.startsWith(this.githubApi);
    const headers: Record<string, string> = gh ? { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': `TeamBot/${APP_VERSION}` } : { accept: 'application/json' };
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!r.ok) {
      if (gh && (r.status === 403 || r.status === 429)) throw new RuntimeError('GitHub laat even geen verzoeken meer toe (limiet per uur). Probeer het later opnieuw.');
      throw new RuntimeError(gh ? `GitHub antwoordde ${r.status} voor ${url.replace(this.githubApi, '')}` : `Het register antwoordde ${r.status} voor ${url.replace(this.registry, '')}`);
    }
    return r.json();
  }

  /**
   * Download to `file`, hashing on the way, and refuse it unless it matches `integrity` ("sha512-<base64>" or
   * "sha256:<hex>"). Redirects only where `mayFollow` allows (at most 5).
   */
  private async download(url: string, file: string, integrity: string, progress: (received: number, total?: number) => void, mayFollow: (u: URL) => boolean) {
    let r: Response | null = null;
    let at = new URL(url);
    for (let hop = 0; ; hop++) {
      r = await fetch(at, { signal: AbortSignal.timeout(30 * 60_000), redirect: 'manual', headers: { 'user-agent': `TeamBot/${APP_VERSION}` } });
      if (r.status < 300 || r.status >= 400) break;
      const loc = r.headers.get('location');
      void r.body?.cancel();
      const next = loc ? new URL(loc, at) : null;
      if (!next || hop >= 5 || !mayFollow(next)) throw new RuntimeError('De download werd doorgestuurd naar een adres dat TeamBot niet vertrouwt.');
      at = next;
    }
    if (!r.ok || !r.body) throw new RuntimeError(`Downloaden lukte niet (${r.status}).`);
    const total = Number(r.headers.get('content-length')) || undefined;
    const sha256 = integrity.startsWith('sha256:');
    const hash = crypto.createHash(sha256 ? 'sha256' : 'sha512');
    const part = file + '.part';
    const out = fs.createWriteStream(part);
    let received = 0;
    let last = 0;
    for await (const chunk of Readable.fromWeb(r.body as any) as AsyncIterable<Buffer>) {
      hash.update(chunk);
      received += chunk.length;
      if (!out.write(chunk)) await once(out, 'drain');
      if (Date.now() - last > 500) {
        last = Date.now();
        progress(received, total);
      }
    }
    out.end();
    await once(out, 'close');
    progress(received, total);
    const got = sha256 ? 'sha256:' + hash.digest('hex') : 'sha512-' + hash.digest('base64');
    if (got !== integrity) throw new RuntimeError('De download klopt niet met de controlesom (beschadigd of gewijzigd); TeamBot installeert dit niet.');
    fs.renameSync(part, file);
  }
}

const encodePkg = (name: string) => name.replace('/', '%2f');

export { newer };

/** The newest stable "vX.Y.Z" release (of one major line when given) in a GitHub releases list. */
export function newestStable(releases: any[], line?: number): string | null {
  let best: string | null = null;
  for (const r of releases) {
    const m = typeof r?.tag_name === 'string' ? r.tag_name.match(/^v(\d+\.\d+\.\d+)$/) : null;
    if (!m || r.draft || r.prerelease) continue;
    if (line && Number(m[1].split('.')[0]) !== line) continue;
    if (!best || newer(m[1], best)) best = m[1];
  }
  return best;
}

/** The CLI's binary in an extracted package (also under vendor/<target>/bin for Codex). */
function findBin(root: string, names: string[]): string | null {
  const hits: string[] = [];
  (function walk(d: string, depth: number) {
    if (depth > 5) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (names.includes(e.name)) hits.push(p);
    }
  })(root, 0);
  hits.sort((a, b) => names.indexOf(path.basename(a)) - names.indexOf(path.basename(b)) || a.length - b.length);
  return hits[0] || null;
}
