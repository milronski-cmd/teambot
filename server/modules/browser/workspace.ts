import { isBinary } from '../../tools/builtin/files.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { unifiedDiff } from './diff.js';

/**
 * File-level safety net for bot work (plan §14 "rehearsal", snapshots, undo):
 * - copy a workspace (skipping heavy/generated folders and oversized files, never following links)
 * - manifests with content hashes so we can tell bot changes from user changes
 * - rehearsal diff / apply (with conflict check) / discard
 * - snapshots and restore (with a preview; files created later are kept unless asked)
 */

export const EXCLUDED_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', '.nuxt', '.cache', '.turbo', 'target', '.gradle', '.idea', '.vs', 'coverage']);

export interface CopyLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
}
export const DEFAULT_LIMITS: CopyLimits = { maxFileBytes: 10 * 1024 * 1024, maxTotalBytes: 500 * 1024 * 1024, maxFiles: 20_000 };

export interface FileEntry {
  hash: string;
  size: number;
}
export interface Manifest {
  root: string;
  created: string;
  files: Record<string, FileEntry>;
  /** paths that exist but were not copied (too large / not regular files) */
  skipped: string[];
  partial?: boolean;
}

export class LimitError extends Error {}

const toKey = (rel: string) => rel.split(path.sep).join('/');
const fromKey = (key: string) => key.split('/').join(path.sep);

export function hashFile(file: string): string {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
}

function isExcludedKey(key: string): boolean {
  return key.split('/').some((p) => EXCLUDED_DIRS.has(p));
}

/** Walk a tree and return hashes of regular files (bounded). Never follows symlinks. */
export function scanTree(root: string, limits: CopyLimits = DEFAULT_LIMITS): Manifest {
  const files: Record<string, FileEntry> = {};
  const skipped: string[] = [];
  let total = 0;
  let count = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const key = toKey(path.relative(root, full));
      if (e.isSymbolicLink()) {
        skipped.push(key);
        continue;
      }
      if (e.isDirectory()) {
        if (EXCLUDED_DIRS.has(e.name)) continue;
        walk(full);
        continue;
      }
      if (!e.isFile()) {
        skipped.push(key);
        continue;
      }
      const st = fs.statSync(full, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.size > limits.maxFileBytes) {
        skipped.push(key);
        continue;
      }
      count++;
      total += st.size;
      if (count > limits.maxFiles) throw new LimitError(`Te veel bestanden (meer dan ${limits.maxFiles}). Maak de map kleiner of sluit mappen uit.`);
      if (total > limits.maxTotalBytes) throw new LimitError(`De werkmap is te groot (meer dan ${Math.round(limits.maxTotalBytes / 1048576)} MB zonder uitgesloten mappen).`);
      files[key] = { hash: hashFile(full), size: st.size };
    }
  };
  if (fs.existsSync(root)) walk(root);
  return { root, created: new Date().toISOString(), files, skipped };
}

/** Copy the files of a manifest from `src` to `dst`. */
export function copyFiles(src: string, dst: string, keys: string[]) {
  for (const k of keys) {
    const from = path.join(src, fromKey(k));
    const to = path.join(dst, fromKey(k));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

function writeJson(file: string, data: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}
export function readManifest(file: string): Manifest {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function safeJoin(root: string, key: string): string {
  const base = path.resolve(root);
  const p = path.resolve(base, fromKey(key));
  const rel = path.relative(base, p);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Ongeldig pad: ${key}`);
  // No symlink/junction may lead outside the root: check every existing component with lstat.
  let cur = base;
  for (const part of rel.split(path.sep)) {
    cur = path.join(cur, part);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch {
      break; // the rest does not exist yet (new file)
    }
    if (st.isSymbolicLink()) throw new Error(`Pad via een snelkoppeling/symlink is niet toegestaan: ${key}`);
  }
  return p;
}

// ---------------- rehearsal ----------------

export type ChangeKind = 'added' | 'modified' | 'deleted' | 'moved';
export interface FileChange {
  /** for 'moved': the new place */
  path: string;
  /** for 'moved': where the file was (the real folder still has it there until the move is applied) */
  from?: string;
  change: ChangeKind;
  /** for 'moved': the bot also changed the content on the way (near-identical, not the same) */
  edited?: boolean;
  /**
   * For 'deleted' and 'added' (B-36): the other half of what looks like one file the bot replaced, but too different
   * to call it a move. Safety net: such a deletion is only applied together with (or after) its new file, and not
   * adding the new file keeps the old one, so the content never ends up nowhere.
   */
  related?: string[];
  /** the user changed the original since the rehearsal started */
  conflict: boolean;
  binary: boolean;
  added?: number;
  removed?: number;
  size?: number;
}

// ---------------- moves (B-36) ----------------
// A move in the practice copy is a deleted file plus a new file. Shown as two rows, rejecting the new half and
// applying the rest lost the file. Same content (hash) is a move; near-identical text is a move with an edit.

/** Score (similarity + bonus for the same file name) from which a deleted and a new file are one moved file. */
export const MOVE_SCORE = 0.75;
/** Score from which they stay two rows but are related: the old content may live on only in the new file. */
export const RELATED_SCORE = 0.45;
const NAME_BONUS = 0.2;
/** Similarity is only worked out for text files up to this size, and within a budget per listing (cheap). */
export const NEAR_MAX_BYTES = 128 * 1024;
const NEAR_BUDGET = 4_000_000;

interface Profile {
  grams: Map<string, number>;
  total: number;
}
function profile(text: string): Profile {
  const s = text.replace(/\r\n/g, '\n');
  const grams = new Map<string, number>();
  for (let i = 0; i + 4 <= s.length; i++) {
    const g = s.slice(i, i + 4);
    grams.set(g, (grams.get(g) || 0) + 1);
  }
  return { grams, total: Math.max(0, s.length - 3) };
}
function dice(a: Profile, b: Profile): number {
  if (!a.total || !b.total) return 0;
  const [small, large] = a.grams.size <= b.grams.size ? [a.grams, b.grams] : [b.grams, a.grams];
  let common = 0;
  for (const [g, n] of small) common += Math.min(n, large.get(g) || 0);
  return (2 * common) / (a.total + b.total);
}

/** How much two texts look alike, 0..1 (Dice coefficient over 4-character pieces; line endings ignored). */
export function similarity(a: string, b: string): number {
  if (a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n')) return 1;
  return dice(profile(a), profile(b));
}

export interface MoveSide {
  path: string;
  hash: string;
  size: number;
  /** the content as text; null for a binary, too large or unreadable file (then only the hash and name count) */
  text: string | null;
}
export interface MovePlan {
  moves: { from: string; to: string; edited: boolean }[];
  related: { from: string; to: string }[];
}

const fileName = (k: string) => k.slice(k.lastIndexOf('/') + 1).toLowerCase();
const dirName = (k: string) => k.slice(0, Math.max(0, k.lastIndexOf('/'))).toLowerCase();
const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Pair deleted files with new files: first the same content (preferring the same name, then the same folder), then
 * near-identical text. Each file is in at most one move. What is left but still looks alike is "related".
 */
export function detectMoves(deleted: MoveSide[], added: MoveSide[]): MovePlan {
  const usedD = new Set<string>();
  const usedA = new Set<string>();
  const moves: MovePlan['moves'] = [];
  const take = (d: MoveSide, a: MoveSide, edited: boolean) => {
    if (usedD.has(d.path) || usedA.has(a.path)) return;
    usedD.add(d.path);
    usedA.add(a.path);
    moves.push({ from: d.path, to: a.path, edited });
  };
  // 1. The same content. Two empty files say nothing about a move, unless the name is the same too.
  const addedByHash = new Map<string, MoveSide[]>();
  for (const a of added) addedByHash.set(a.hash, [...(addedByHash.get(a.hash) || []), a]);
  const deletedByHash = new Map<string, MoveSide[]>();
  for (const d of deleted) if (addedByHash.has(d.hash)) deletedByHash.set(d.hash, [...(deletedByHash.get(d.hash) || []), d]);
  for (const [hash, ds] of deletedByHash) {
    const as = addedByHash.get(hash)!;
    if (ds.length * as.length > 2500) {
      // Many identical files (generated ones): pair them in path order instead of comparing every pair.
      const sd = [...ds].sort((x, y) => byPath(x.path, y.path));
      const sa = [...as].sort((x, y) => byPath(x.path, y.path));
      for (let i = 0; i < Math.min(sd.length, sa.length); i++) if (sd[i].size > 0 || fileName(sd[i].path) === fileName(sa[i].path)) take(sd[i], sa[i], false);
      continue;
    }
    const pairs: { d: MoveSide; a: MoveSide; rank: number }[] = [];
    for (const d of ds)
      for (const a of as) {
        const sameName = fileName(d.path) === fileName(a.path);
        if (d.size === 0 && !sameName) continue;
        pairs.push({ d, a, rank: sameName ? 0 : dirName(d.path) === dirName(a.path) ? 1 : 2 });
      }
    pairs.sort((x, y) => x.rank - y.rank || byPath(x.d.path, y.d.path) || byPath(x.a.path, y.a.path));
    for (const p of pairs) take(p.d, p.a, false);
  }
  // 2. Near-identical text (a move or rename with an edit), and what only looks alike.
  const restD = deleted.filter((d) => !usedD.has(d.path));
  const restA = added.filter((a) => !usedA.has(a.path));
  const profiles = new Map<string, Profile>();
  const prof = (side: string, x: MoveSide) => {
    const key = side + x.path;
    let p = profiles.get(key);
    if (!p) profiles.set(key, (p = profile(x.text!)));
    return p;
  };
  let budget = NEAR_BUDGET;
  const scored: { d: MoveSide; a: MoveSide; score: number }[] = [];
  for (const d of restD)
    for (const a of restA) {
      const sameName = fileName(d.path) === fileName(a.path);
      const bonus = sameName ? NAME_BONUS : 0;
      // Not comparable (binary, too large, over budget): the same name is all we know, so related, never a move.
      const unknown = d.text === null || a.text === null || budget <= 0;
      if (unknown) {
        if (sameName) scored.push({ d, a, score: RELATED_SCORE });
        continue;
      }
      const lo = Math.min(d.text!.length, a.text!.length);
      const hi = Math.max(d.text!.length, a.text!.length);
      if (!hi || (2 * lo) / (lo + hi) + bonus < RELATED_SCORE) continue; // cannot reach the threshold
      budget -= d.text!.length + a.text!.length;
      const score = dice(prof('d', d), prof('a', a)) + bonus;
      if (score >= RELATED_SCORE) scored.push({ d, a, score });
    }
  scored.sort((x, y) => y.score - x.score || byPath(x.d.path, y.d.path) || byPath(x.a.path, y.a.path));
  for (const s of scored) if (s.score >= MOVE_SCORE && s.d.text !== null && s.a.text !== null) take(s.d, s.a, true);
  const related = scored.filter((s) => !usedD.has(s.d.path) && !usedA.has(s.a.path)).map((s) => ({ from: s.d.path, to: s.a.path }));
  return { moves, related };
}

/** Merge deleted + new files that are one moved file into a single 'moved' change; mark related halves. */
function withMoves(list: FileChange[], sides: Map<string, MoveSide>): FileChange[] {
  const deleted = list.filter((c) => c.change === 'deleted').map((c) => sides.get(c.path)!);
  const added = list.filter((c) => c.change === 'added').map((c) => sides.get(c.path)!);
  if (!deleted.length || !added.length) return list;
  const plan = detectMoves(deleted, added);
  if (!plan.moves.length && !plan.related.length) return list;
  const by = new Map(list.map((c) => [c.path, c]));
  const gone = new Set<string>();
  const moved: FileChange[] = [];
  for (const m of plan.moves) {
    const d = by.get(m.from)!;
    const a = by.get(m.to)!;
    gone.add(m.from).add(m.to);
    // A conflict on either side: the owner changed the old file, or already has another file at the new place.
    moved.push({ path: m.to, from: m.from, change: 'moved', edited: m.edited, conflict: d.conflict || a.conflict, binary: d.binary || a.binary, size: a.size });
  }
  for (const r of plan.related) {
    (by.get(r.from)!.related ??= []).push(r.to);
    (by.get(r.to)!.related ??= []).push(r.from);
  }
  return [...list.filter((c) => !gone.has(c.path)), ...moved].sort((x, y) => byPath(x.path, y.path));
}

/** Create the rehearsal copy + base manifest. Returns the manifest. */
export function startRehearsalCopy(original: string, copyDir: string, baseFile: string, limits = DEFAULT_LIMITS): Manifest {
  fs.mkdirSync(original, { recursive: true });
  const base = scanTree(original, limits);
  fs.mkdirSync(copyDir, { recursive: true });
  copyFiles(original, copyDir, Object.keys(base.files));
  writeJson(baseFile, base);
  return base;
}

/** Changes the bot made in the copy, with conflict flags against the current original. */
export function rehearsalChanges(original: string, copyDir: string, base: Manifest, limits = DEFAULT_LIMITS): FileChange[] {
  const now = scanTree(copyDir, { ...limits, maxTotalBytes: limits.maxTotalBytes * 2 });
  const skipped = new Set(base.skipped);
  const out: FileChange[] = [];
  const sides = new Map<string, MoveSide>();
  const asText = (buf: Buffer | null) => (buf && buf.length <= NEAR_MAX_BYTES && !isBinary(buf) ? buf.toString('utf8') : null);
  const keys = new Set([...Object.keys(base.files), ...Object.keys(now.files)]);
  for (const k of [...keys].sort()) {
    if (skipped.has(k) || isExcludedKey(k)) continue;
    const b = base.files[k];
    const c = now.files[k];
    let change: ChangeKind | null = null;
    if (!b && c) change = 'added';
    else if (b && !c) change = 'deleted';
    else if (b && c && b.hash !== c.hash) change = 'modified';
    if (!change) continue;
    const origPath = safeJoin(original, k);
    const origNow = fs.existsSync(origPath) && fs.statSync(origPath).isFile() ? hashFile(origPath) : null;
    // conflict: the original no longer matches what the rehearsal started from
    const conflict = change === 'deleted' ? origNow !== null && origNow !== b!.hash : b ? origNow !== b.hash : origNow !== null && origNow !== c?.hash;
    const newBuf = c ? fs.readFileSync(safeJoin(copyDir, k)) : null;
    const oldBuf = origNow ? fs.readFileSync(origPath) : null;
    const binary = !!((newBuf && isBinary(newBuf)) || (oldBuf && isBinary(oldBuf)));
    out.push({ path: k, change, conflict, binary, size: c?.size });
    // For move detection: what the bot started from (still in the real folder) and what it made.
    if (change === 'deleted') sides.set(k, { path: k, hash: b!.hash, size: b!.size, text: asText(oldBuf) });
    if (change === 'added') sides.set(k, { path: k, hash: c!.hash, size: c!.size, text: asText(newBuf) });
  }
  return withMoves(out, sides);
}

/**
 * Unified diff for one file: base version (from original if unchanged there) vs rehearsal copy. For a moved file
 * (`from`), the real folder's file at the old place vs the copy's file at the new place.
 */
export function rehearsalFileDiff(
  original: string,
  copyDir: string,
  base: Manifest,
  key: string,
  from?: string,
): { diff: string; binary: boolean; tooLarge?: boolean; added: number; removed: number; conflict: boolean; before?: string; after?: string; inOriginal: boolean; inRehearsal: boolean } {
  const oldKey = from || key;
  const origPath = safeJoin(original, oldKey);
  const copyPath = safeJoin(copyDir, key);
  const b = base.files[oldKey];
  const origNow = fs.existsSync(origPath) && fs.statSync(origPath).isFile() ? fs.readFileSync(origPath) : null;
  const origHash = origNow ? crypto.createHash('sha1').update(origNow).digest('hex') : null;
  const conflict = b ? origHash !== b.hash : origHash !== null;
  const inRehearsal = fs.existsSync(copyPath);
  const newBuf = inRehearsal ? fs.readFileSync(copyPath) : Buffer.alloc(0);
  const oldBuf = origNow || Buffer.alloc(0);
  if (isBinary(newBuf) || isBinary(oldBuf)) return { diff: '', binary: true, added: 0, removed: 0, conflict, inOriginal: !!origNow, inRehearsal };
  const d = unifiedDiff(oldBuf.toString('utf8'), newBuf.toString('utf8'), { oldName: `werkmap/${oldKey}`, newName: `repetitie/${key}` });
  // Both versions for the side-by-side view (B-42), as long as they are small enough to read on screen.
  const both = !d.tooLarge && oldBuf.length + newBuf.length <= 400_000 ? { before: oldBuf.toString('utf8'), after: newBuf.toString('utf8') } : {};
  return { diff: d.unified, binary: false, tooLarge: d.tooLarge, added: d.added, removed: d.removed, conflict, inOriginal: !!origNow, inRehearsal, ...both };
}

/**
 * Two bots practising in the same folder (B-42): one file as each practice copy has it, for a side-by-side view.
 * A bot that did not touch the file still has the version it started from, so each side is "what you would get".
 */
export function compareRehearsalFiles(
  a: { original: string; copyDir: string; base: Manifest },
  b: { copyDir: string; base: Manifest },
  key: string,
): { binary: boolean; tooLarge?: boolean; left?: string; right?: string; inLeft: boolean; inRight: boolean; leftChanged: boolean; rightChanged: boolean; same: boolean } {
  const read = (dir: string) => {
    const p = safeJoin(dir, key);
    return fs.existsSync(p) && fs.statSync(p).isFile() ? fs.readFileSync(p) : null;
  };
  const la = read(a.copyDir);
  const lb = read(b.copyDir);
  const hash = (x: Buffer | null) => (x ? crypto.createHash('sha1').update(x).digest('hex') : null);
  const changed = (buf: Buffer | null, base: Manifest) => hash(buf) !== (base.files[key]?.hash ?? null);
  const out = { inLeft: !!la, inRight: !!lb, leftChanged: changed(la, a.base), rightChanged: changed(lb, b.base), same: hash(la) === hash(lb) };
  const left = la || Buffer.alloc(0);
  const right = lb || Buffer.alloc(0);
  if (isBinary(left) || isBinary(right)) return { ...out, binary: true };
  if (left.length + right.length > 400_000) return { ...out, binary: false, tooLarge: true };
  return { ...out, binary: false, left: left.toString('utf8'), right: right.toString('utf8') };
}

/** A deletion that was not applied because its content would then only be in a new file still in the copy. */
export interface HeldDeletion {
  path: string;
  keptFor: string;
}
export interface ApplyPlan {
  targets: FileChange[];
  conflicts: string[];
  skipped: string[];
  held: HeldDeletion[];
}

/** Does a selection name this change? A move is one unit: its old or its new path selects it. */
const names = (set: Set<string>, c: FileChange) => set.has(c.path) || (!!c.from && set.has(c.from));

/**
 * What "apply" does with these changes: selected (`null` = all), conflicts only when forced, and the safety net of
 * B-36: a deletion whose content may live on only in a related new file waits until that file is applied too.
 */
export function planApply(changes: FileChange[], select: string[] | null, force: string[] = []): ApplyPlan {
  const want = select ? new Set(select) : null;
  const forced = new Set(force);
  const conflicts: string[] = [];
  const skipped: string[] = [];
  const ok: FileChange[] = [];
  for (const c of changes) {
    if (want && !names(want, c)) skipped.push(c.path);
    else if (c.conflict && !names(forced, c)) conflicts.push(c.path);
    else ok.push(c);
  }
  const going = new Set(ok.map((c) => c.path));
  const held: HeldDeletion[] = [];
  const targets = ok.filter((c) => {
    if (c.change !== 'deleted' || !c.related?.length || c.related.some((p) => going.has(p))) return true;
    held.push({ path: c.path, keptFor: c.related[0] });
    return false;
  });
  return { targets, conflicts, skipped, held };
}

/** Same file on disk (a case-only rename on Windows/macOS: "Notes.txt" and "notes.txt" are one file). */
function sameFile(a: string, b: string): boolean {
  if (path.resolve(a) === path.resolve(b)) return true;
  const sa = fs.statSync(a, { throwIfNoEntry: false, bigint: true });
  const sb = fs.statSync(b, { throwIfNoEntry: false, bigint: true });
  return !!sa && !!sb && sa.ino !== 0n && sa.ino === sb.ino && sa.dev === sb.dev;
}

/** Is this a regular file under `root` (no link on the way)? */
export function fileExistsIn(root: string, key: string): boolean {
  try {
    return !!fs.statSync(safeJoin(root, key), { throwIfNoEntry: false })?.isFile();
  } catch {
    return false;
  }
}

/**
 * Apply selected rehearsal changes to the original. Conflicting files are skipped
 * unless listed in `force`. Returns what happened per file. The base manifest is
 * updated so applied files no longer show up as changes. A move is applied as one unit,
 * new place first, so the content is never in neither place.
 */
export function applyRehearsal(
  original: string,
  copyDir: string,
  baseFile: string,
  select: string[] | null,
  force: string[] = [],
  limits = DEFAULT_LIMITS,
): { applied: string[]; conflicts: string[]; skipped: string[]; held: HeldDeletion[] } {
  const base = readManifest(baseFile);
  const plan = planApply(rehearsalChanges(original, copyDir, base, limits), select, force);
  const applied: string[] = [];
  for (const c of plan.targets) {
    const dst = safeJoin(original, c.path);
    if (c.change === 'deleted') {
      if (fs.existsSync(dst)) fs.rmSync(dst, { force: true });
      delete base.files[c.path];
    } else {
      const src = safeJoin(copyDir, c.path);
      const old = c.change === 'moved' && c.from ? safeJoin(original, c.from) : null;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      // Only the case of the name changed: rename, so the new name is on disk (one file on Windows/macOS).
      if (old && fs.existsSync(old) && old.toLowerCase() === dst.toLowerCase() && sameFile(old, dst)) fs.renameSync(old, dst);
      fs.copyFileSync(src, dst);
      base.files[c.path] = { hash: hashFile(src), size: fs.statSync(src).size };
      if (old && c.from) {
        if (fs.existsSync(old) && !sameFile(old, dst)) fs.rmSync(old, { force: true });
        delete base.files[c.from];
      }
    }
    applied.push(c.path);
  }
  writeJson(baseFile, base);
  return { applied, conflicts: plan.conflicts, skipped: plan.skipped, held: plan.held };
}

/** A deleted file kept because the owner did not add the new file that replaced it (B-36). */
export interface KeptFile {
  path: string;
  because: string;
}

/**
 * Undo selected rehearsal changes inside the copy (reset them to the base/original). A move is undone as one unit
 * (either path selects it). Not adding a new file that replaced a deleted one keeps the deleted one too: otherwise
 * "apply the rest" would remove a file whose content then lives nowhere (B-36).
 */
export function revertInCopy(original: string, copyDir: string, baseFile: string, keys: string[], limits = DEFAULT_LIMITS): { reverted: string[]; kept: KeptFile[] } {
  const base = readManifest(baseFile);
  const want = new Set(keys);
  const todo = new Set(keys);
  const kept: KeptFile[] = [];
  for (const c of rehearsalChanges(original, copyDir, base, limits)) {
    if (c.change === 'moved' && c.from && names(want, c)) todo.add(c.path).add(c.from);
    if (c.change === 'added' && want.has(c.path))
      for (const d of c.related || [])
        if (!todo.has(d)) {
          todo.add(d);
          if (fileExistsIn(original, d)) kept.push({ path: d, because: c.path });
        }
  }
  // New files out first, then the old ones back: with a case-only rename both names are one file on disk.
  const order = [...todo].sort((a, b) => Number(!!base.files[a]) - Number(!!base.files[b]));
  for (const k of order) {
    const inCopy = safeJoin(copyDir, k);
    const inOrig = safeJoin(original, k);
    if (!base.files[k]) fs.rmSync(inCopy, { force: true });
    else if (fileExistsIn(original, k)) {
      fs.mkdirSync(path.dirname(inCopy), { recursive: true });
      fs.copyFileSync(inOrig, inCopy);
      base.files[k] = { hash: hashFile(inOrig), size: fs.statSync(inOrig).size };
    } else {
      // Gone from the real folder as well (the owner removed it): the copy follows, so nothing is left to choose.
      fs.rmSync(inCopy, { force: true });
      delete base.files[k];
    }
  }
  writeJson(baseFile, base);
  return { reverted: order, kept };
}

// ---------------- snapshots ----------------

export function createSnapshot(root: string, dir: string, o: { keys?: string[]; limits?: CopyLimits } = {}): Manifest {
  const full = scanTree(root, o.limits || DEFAULT_LIMITS);
  let m = full;
  if (o.keys) {
    const files: Record<string, FileEntry> = {};
    for (const k of o.keys) if (full.files[k]) files[k] = full.files[k];
    m = { ...full, files, skipped: [], partial: true };
  }
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
  copyFiles(root, path.join(dir, 'files'), Object.keys(m.files));
  writeJson(path.join(dir, 'manifest.json'), m);
  return m;
}

export interface RestorePlan {
  overwrite: string[];
  recreate: string[];
  /** files that exist now but not in the snapshot */
  extra: string[];
  unchanged: number;
}

export function restorePlan(root: string, dir: string): RestorePlan {
  const snap = readManifest(path.join(dir, 'manifest.json'));
  const cur = scanTree(root, { ...DEFAULT_LIMITS, maxTotalBytes: DEFAULT_LIMITS.maxTotalBytes * 4, maxFiles: DEFAULT_LIMITS.maxFiles * 4 });
  const overwrite: string[] = [];
  const recreate: string[] = [];
  const extra: string[] = [];
  let unchanged = 0;
  for (const [k, f] of Object.entries(snap.files)) {
    const c = cur.files[k];
    if (!c) recreate.push(k);
    else if (c.hash !== f.hash) overwrite.push(k);
    else unchanged++;
  }
  if (!snap.partial) {
    const skipped = new Set(snap.skipped);
    for (const k of Object.keys(cur.files)) if (!snap.files[k] && !skipped.has(k)) extra.push(k);
  }
  return { overwrite: overwrite.sort(), recreate: recreate.sort(), extra: extra.sort(), unchanged };
}

export function restoreSnapshot(root: string, dir: string, o: { deleteExtra?: boolean } = {}): RestorePlan {
  const plan = restorePlan(root, dir);
  const files = path.join(dir, 'files');
  copyFiles(files, root, [...plan.overwrite, ...plan.recreate]);
  if (o.deleteExtra) for (const k of plan.extra) fs.rmSync(safeJoin(root, k), { force: true });
  return plan;
}

export function dirSize(dir: string): number {
  let n = 0;
  const walk = (d: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) n += fs.statSync(f, { throwIfNoEntry: false })?.size || 0;
    }
  };
  walk(dir);
  return n;
}
