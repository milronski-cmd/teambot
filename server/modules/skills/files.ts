import { sha256 } from '../../core/util.js';
import { isBinary } from '../../tools/builtin/files.js';

export { isBinary, sha256 };
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import AdmZip from 'adm-zip';
import { bytesText } from '../../core/i18n.js';

/** In-memory skill folder: posix relative path -> bytes. */
export type FileMap = Map<string, Buffer>;

export const LIMITS = {
  /** Files per skill. */
  maxFiles: 200,
  /** Total bytes per skill. */
  maxSkillBytes: 10 * 1024 * 1024,
  /** Bytes per file. */
  maxFileBytes: 5 * 1024 * 1024,
  /** Compressed upload/download size. */
  maxZipBytes: 25 * 1024 * 1024,
  /** Entries in an archive (a repo may contain more than one skill). */
  maxZipEntries: 5000,
  /** Total uncompressed bytes in an archive. */
  maxZipUncompressed: 100 * 1024 * 1024,
  /** Max compression ratio per entry (zip-bomb guard). */
  maxRatio: 200,
};

const JUNK = /(^|\/)(__MACOSX|\.git|node_modules|\.DS_Store|Thumbs\.db|desktop\.ini|\.venv|__pycache__)(\/|$)/i;


/**
 * Normalise a relative path from an untrusted source. Returns null for anything that could escape
 * the skill folder: absolute paths, drive letters, UNC, `..`, NUL/control characters.
 */
export function safeRelPath(p: string): string | null {
  if (typeof p !== 'string' || !p) return null;
  if (/[\u0000-\u001f]/.test(p)) return null;
  let s = p.replace(/\\/g, '/');
  if (s.startsWith('/') || /^[a-zA-Z]:/.test(s) || s.startsWith('//')) return null;
  const parts: string[] = [];
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    if (/[<>:"|?*]/.test(seg)) return null;
    if (/[. ]$/.test(seg)) return null; // Windows strips trailing dots/spaces -> aliasing
    parts.push(seg);
  }
  s = parts.join('/');
  if (!s || s.length > 400) return null;
  return s;
}

export function isSkillMd(rel: string) {
  return path.posix.basename(rel).toLowerCase() === 'skill.md';
}

/** Canonical checksum of a skill folder: sha256 over sorted "path\0sha256(content)\n" lines. */
export function checksumOf(files: FileMap): string {
  const h = crypto.createHash('sha256');
  for (const p of [...files.keys()].sort()) h.update(`${p}\0${sha256(files.get(p)!)}\n`);
  return h.digest('hex');
}

export function totalSize(files: FileMap) {
  let n = 0;
  for (const b of files.values()) n += b.length;
  return n;
}

/** Enforce per-skill limits; throws a readable error. */
export function checkLimits(files: FileMap) {
  if (files.size > LIMITS.maxFiles) throw new Error(`Te veel bestanden in de skill (${files.size}, maximaal ${LIMITS.maxFiles}).`);
  for (const [p, b] of files) if (b.length > LIMITS.maxFileBytes) throw new Error(`Bestand ${p} is te groot (${bytesText(b.length)}, maximaal ${bytesText(LIMITS.maxFileBytes)}).`);
  const t = totalSize(files);
  if (t > LIMITS.maxSkillBytes) throw new Error(`De skill is te groot (${bytesText(t)}, maximaal ${bytesText(LIMITS.maxSkillBytes)}).`);
}

/**
 * Read an archive safely: rejects the whole archive on any path that could escape (zip-slip), symlink
 * entries, encrypted entries, unknown compression and zip bombs (size + ratio caps, CRC check).
 */
export interface ZipOptions {
  /**
   * Skip (instead of rejecting the archive for) unsafe paths, symbolic links, oversized and suspiciously
   * compressed entries. Used for whole repositories from the internet, where only the skill folders matter;
   * skipped entries are never extracted. Uploads stay strict.
   */
  lenient?: boolean;
  /** Only extract entries whose (normalised) path passes this filter; others are not decompressed at all. */
  include?: (rel: string) => boolean;
  /** Receives the paths of skipped entries (lenient mode). */
  skipped?: string[];
}

/** Archive metadata without extracting: entry paths (normalised, files only), the zip comment and the newest entry time. */
export function zipInfo(buf: Buffer): { names: string[]; comment: string; newest: string | null } {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buf);
  } catch {
    throw new Error('Dit is geen geldig zip-bestand.');
  }
  const names: string[] = [];
  let newest = 0;
  for (const e of zip.getEntries().slice(0, LIMITS.maxZipEntries * 4)) {
    if (e.isDirectory) continue;
    const rel = safeRelPath(e.entryName);
    if (rel && !JUNK.test(rel)) names.push(rel);
    const t = (e.header as any).time instanceof Date ? (e.header as any).time.getTime() : 0;
    if (t > newest) newest = t;
  }
  let comment = '';
  try {
    comment = zip.getZipComment() || '';
  } catch {
    comment = '';
  }
  return { names, comment: comment.slice(0, 200), newest: newest ? new Date(newest).toISOString() : null };
}

export function filesFromZip(buf: Buffer, o: ZipOptions = {}): FileMap {
  if (buf.length > LIMITS.maxZipBytes) throw new Error(`Het zip-bestand is te groot (maximaal ${bytesText(LIMITS.maxZipBytes)}).`);
  let zip: AdmZip;
  try {
    zip = new AdmZip(buf);
  } catch {
    throw new Error('Dit is geen geldig zip-bestand.');
  }
  const entries = zip.getEntries();
  if (entries.length > LIMITS.maxZipEntries * (o.include ? 4 : 1)) throw new Error(`Het zip-bestand bevat te veel bestanden (${entries.length}).`);
  const out: FileMap = new Map();
  const lower = new Set<string>();
  let total = 0;
  const skip = (rel: string, why: string) => {
    if (!o.lenient) throw new Error(why);
    o.skipped?.push(rel);
  };
  for (const e of entries) {
    const raw = e.entryName;
    if (e.isDirectory) {
      if (raw.split(/[\\/]/).includes('..') || /^([a-zA-Z]:|[\\/])/.test(raw)) {
        skip(raw.slice(0, 120), `Onveilig pad in het zip-bestand geweigerd: ${raw.slice(0, 120)}`);
      }
      continue;
    }
    const rel = safeRelPath(raw);
    if (!rel) {
      skip(raw.slice(0, 120), `Onveilig pad in het zip-bestand geweigerd: ${raw.slice(0, 120)}`);
      continue;
    }
    if (JUNK.test(rel)) continue;
    if (o.include && !o.include(rel)) continue;
    const mode = (e.attr >>> 16) & 0o170000;
    if (mode === 0o120000) {
      skip(rel, `Symbolische koppeling in het zip-bestand geweigerd: ${rel}`);
      continue;
    }
    const h: any = e.header;
    if (h.encrypted) {
      skip(rel, `Versleuteld bestand in zip niet ondersteund: ${rel}`);
      continue;
    }
    const size = Number(h.size) || 0;
    const csize = Number(h.compressedSize) || 0;
    if (size > LIMITS.maxFileBytes * 4) {
      skip(rel, `Bestand ${rel} in het zip-bestand is te groot.`);
      continue;
    }
    if (csize > 0 && size / csize > LIMITS.maxRatio && size > 1024 * 1024) {
      skip(rel, `Verdachte compressie (zip-bom) bij ${rel}; geweigerd.`);
      continue;
    }
    total += size;
    if (total > LIMITS.maxZipUncompressed) throw new Error('Het zip-bestand is uitgepakt te groot.');
    const comp = e.getCompressedData();
    let data: Buffer;
    if (h.method === 0) data = Buffer.from(comp);
    else if (h.method === 8) {
      try {
        data = zlib.inflateRawSync(comp, { maxOutputLength: Math.max(size, 1) });
      } catch {
        throw new Error(`Kon ${rel} niet uitpakken (beschadigd of groter dan opgegeven).`);
      }
    } else throw new Error(`Onbekende compressiemethode in ${rel}.`);
    if (data.length !== size) throw new Error(`Grootte van ${rel} klopt niet met het zip-register; geweigerd.`);
    if (typeof (zlib as any).crc32 === 'function' && ((zlib as any).crc32(data) >>> 0) !== (Number(h.crc) >>> 0)) throw new Error(`Controlegetal (CRC) van ${rel} klopt niet; geweigerd.`);
    // Case-insensitive duplicates would alias on Windows.
    if (lower.has(rel.toLowerCase())) {
      skip(rel, `Dubbel pad in het zip-bestand: ${rel}`);
      continue;
    }
    lower.add(rel.toLowerCase());
    out.set(rel, data);
  }
  return out;
}

/** Read a local folder (never follows symlinks; skips junk). */
export function filesFromDir(dir: string, maxFiles = LIMITS.maxFiles * 5): FileMap {
  const root = path.resolve(dir);
  const st = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) throw new Error(`Map niet gevonden: ${dir}`);
  const out: FileMap = new Map();
  let total = 0;
  const walk = (d: string, depth: number) => {
    if (depth > 8) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (JUNK.test(rel)) continue;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile()) {
        if (out.size >= maxFiles) throw new Error(`De map bevat te veel bestanden (meer dan ${maxFiles}).`);
        const s = fs.statSync(full);
        if (s.size > LIMITS.maxFileBytes) throw new Error(`Bestand ${rel} is te groot.`);
        total += s.size;
        if (total > LIMITS.maxZipUncompressed) throw new Error('De map is te groot.');
        const safe = safeRelPath(rel);
        if (safe) out.set(safe, fs.readFileSync(full));
      }
    }
  };
  walk(root, 0);
  return out;
}

/** Files posted by the browser (folder picker): [{ path, base64 | text }]. */
export function filesFromUpload(list: any[]): FileMap {
  if (!Array.isArray(list) || !list.length) throw new Error('Geen bestanden ontvangen.');
  if (list.length > LIMITS.maxFiles * 5) throw new Error('Te veel bestanden.');
  const out: FileMap = new Map();
  let total = 0;
  for (const f of list) {
    const rel = safeRelPath(String(f?.path || ''));
    if (!rel) throw new Error(`Onveilig of leeg pad geweigerd: ${String(f?.path || '').slice(0, 120)}`);
    if (JUNK.test(rel)) continue;
    const b = typeof f.base64 === 'string' ? Buffer.from(f.base64, 'base64') : Buffer.from(String(f.text ?? ''), 'utf8');
    if (b.length > LIMITS.maxFileBytes) throw new Error(`Bestand ${rel} is te groot.`);
    total += b.length;
    if (total > LIMITS.maxZipUncompressed) throw new Error('De upload is te groot.');
    out.set(rel, b);
  }
  return out;
}

/** Directories (posix, '' = root) that contain a SKILL.md. */
export function findSkillRoots(files: FileMap): string[] {
  const roots = new Set<string>();
  for (const p of files.keys()) if (isSkillMd(p)) roots.add(path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p));
  return [...roots].sort((a, b) => a.length - b.length || a.localeCompare(b));
}

/** Files of one skill root, relative to it; nested skill folders are excluded (they are separate skills). */
export function subset(files: FileMap, root: string, allRoots: string[]): FileMap {
  const prefix = root ? root + '/' : '';
  const nested = allRoots.filter((r) => r !== root && (root === '' || r.startsWith(prefix)));
  const out: FileMap = new Map();
  for (const [p, b] of files) {
    if (prefix && !p.startsWith(prefix)) continue;
    if (nested.some((n) => p.startsWith(n + '/'))) continue;
    let rel = p.slice(prefix.length);
    if (isSkillMd(rel) && !rel.includes('/')) rel = 'SKILL.md';
    out.set(rel, b);
  }
  return out;
}

/** Strip a single wrapping top-level folder (GitHub archives: repo-ref/...). */
export function stripTopFolder(files: FileMap): FileMap {
  const tops = new Set([...files.keys()].map((p) => p.split('/')[0]));
  if (tops.size !== 1 || [...files.keys()].some((p) => !p.includes('/'))) return files;
  const out: FileMap = new Map();
  for (const [p, b] of files) out.set(p.slice(p.indexOf('/') + 1), b);
  return out;
}

/** Write a FileMap atomically into `dest` (via a temp folder + rename). */
export function writeFilesAtomic(dest: string, files: FileMap) {
  const tmp = `${dest}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  fs.mkdirSync(tmp, { recursive: true });
  try {
    for (const [rel, b] of files) {
      const safe = safeRelPath(rel);
      if (!safe) throw new Error(`Onveilig pad: ${rel}`);
      const target = path.join(tmp, ...safe.split('/'));
      if (!path.resolve(target).startsWith(path.resolve(tmp) + path.sep)) throw new Error(`Onveilig pad: ${rel}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, b);
    }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

/** Build a zip from a FileMap (for download/share). */
export function zipFiles(files: FileMap, folder: string): Buffer {
  const zip = new AdmZip();
  for (const [p, b] of [...files.entries()].sort((a, b) => a[0].localeCompare(b[0]))) zip.addFile(`${folder}/${p}`, b);
  return zip.toBuffer();
}
