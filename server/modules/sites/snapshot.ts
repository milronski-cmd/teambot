import fs from 'node:fs';
import path from 'node:path';
import { isInside as inside, isProtectedPath } from '../../tools/builtin/files.js';
import { bytesText } from '../../core/i18n.js';

/**
 * What a published site may contain. A site is a snapshot: the approved files are copied into TeamBot's data folder,
 * so a later change in the bot's folder (or a symlink swapped in afterwards) never changes what is online until
 * someone publishes again.
 */

export const LIMITS = { files: 500, bytes: 50 * 1024 * 1024, file: 25 * 1024 * 1024, depth: 12 };

/** Served content types; anything else is not copied. XML is served as text (no XSLT/XHTML scripting). */
export const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.wasm': 'application/wasm',
};

const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'bower_components']);
/** Names that look like keys, passwords or credentials, whatever their extension. */
const SECRET_NAME = /(^|[-_.\s])(secrets?|credentials?|passwords?|passwd|wachtwoord(en)?|api[-_]?keys?|private[-_]?keys?|id_rsa|id_ed25519|id_ecdsa)([-_.\s]|$)/i;

export type SkipReason = 'hidden' | 'secret' | 'type' | 'link';

export interface ScanFile {
  rel: string;
  abs: string;
  size: number;
}

export interface ScanResult {
  root: string;
  files: ScanFile[];
  bytes: number;
  skipped: { rel: string; why: SkipReason }[];
  entry: string | null;
}

export class SiteError extends Error {}

/** "13 kB", "1,5 MB" in the source notation (format.ts formatBytes; the page shows sizes in the reader's own). */
export const fmtBytes = (n: number) => bytesText(n);

/** Walk a folder and decide what would be published. Throws SiteError (plain Dutch) when it cannot be a site. */
export function scanFolder(folder: string, limits = LIMITS): ScanResult {
  let st: fs.Stats;
  try {
    st = fs.statSync(folder);
  } catch {
    throw new SiteError(`Map niet gevonden: ${folder}`);
  }
  if (!st.isDirectory()) throw new SiteError('Kies een map (met een index.html), geen los bestand.');
  const root = fs.realpathSync.native(folder);
  const files: ScanFile[] = [];
  const skipped: ScanResult['skipped'] = [];
  let bytes = 0;
  const walk = (dir: string, relDir: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.name.startsWith('.')) {
        skipped.push({ rel, why: 'hidden' });
        continue;
      }
      let ls: fs.Stats;
      try {
        ls = fs.lstatSync(abs);
      } catch {
        continue;
      }
      // symlinks and Windows junctions could point anywhere: never followed
      if (ls.isSymbolicLink()) {
        skipped.push({ rel, why: 'link' });
        continue;
      }
      if (ls.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) {
          skipped.push({ rel, why: 'hidden' });
          continue;
        }
        if (depth >= limits.depth) throw new SiteError(`De map is te diep genest (meer dan ${limits.depth} niveaus): ${rel}`);
        walk(abs, rel, depth + 1);
        continue;
      }
      if (!ls.isFile()) continue;
      if (isProtectedPath(abs) || SECRET_NAME.test(e.name.replace(/\.[^.]+$/, '')) || SECRET_NAME.test(e.name)) {
        skipped.push({ rel, why: 'secret' });
        continue;
      }
      if (!TYPES[path.extname(e.name).toLowerCase()]) {
        skipped.push({ rel, why: 'type' });
        continue;
      }
      if (ls.size > limits.file) throw new SiteError(`Bestand te groot voor een site: ${rel} (${fmtBytes(ls.size)}, maximaal ${fmtBytes(limits.file)} per bestand).`);
      files.push({ rel, abs, size: ls.size });
      bytes += ls.size;
      if (files.length > limits.files) throw new SiteError(`Te veel bestanden voor een site: meer dan ${limits.files}. Publiceer een kleinere map.`);
      if (bytes > limits.bytes) throw new SiteError(`De site is te groot: meer dan ${fmtBytes(limits.bytes)} in totaal.`);
    }
  };
  walk(root, '', 0);
  const top = files.filter((f) => !f.rel.includes('/'));
  const entry =
    top.find((f) => f.rel.toLowerCase() === 'index.html')?.rel ||
    top.find((f) => f.rel.toLowerCase() === 'index.htm')?.rel ||
    (top.filter((f) => /\.html?$/i.test(f.rel)).length === 1 ? top.find((f) => /\.html?$/i.test(f.rel))!.rel : null);
  return { root, files, bytes, skipped, entry };
}

/** Plain summary of what was left out ("3 verborgen, 1 geheim"). */
export function skippedText(s: ScanResult['skipped']): string {
  const n = (w: SkipReason) => s.filter((x) => x.why === w).length;
  const parts = [
    n('hidden') && `${n('hidden')} verborgen`,
    n('secret') && `${n('secret')} met geheimen`,
    n('type') && (n('type') === 1 ? '1 is geen webbestand' : `${n('type')} zijn geen webbestand`),
    n('link') && (n('link') === 1 ? '1 snelkoppeling' : `${n('link')} snelkoppelingen`),
  ].filter(Boolean);
  return parts.join(', ');
}

/** Copy the scanned files into `dest` (re-checked: still a plain file inside the folder). */
export function copySnapshot(scan: ScanResult, dest: string): { files: number; bytes: number } {
  fs.mkdirSync(dest, { recursive: true });
  let files = 0;
  let bytes = 0;
  for (const f of scan.files) {
    const ls = fs.lstatSync(f.abs, { throwIfNoEntry: false });
    if (!ls || !ls.isFile() || ls.isSymbolicLink()) continue;
    const real = fs.realpathSync.native(f.abs);
    if (!inside(real, scan.root)) continue;
    const to = path.join(dest, ...f.rel.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(real, to);
    files++;
    bytes += fs.statSync(to).size;
  }
  if (bytes > LIMITS.bytes) throw new SiteError(`De site is te groot: meer dan ${fmtBytes(LIMITS.bytes)} in totaal.`);
  return { files, bytes };
}
