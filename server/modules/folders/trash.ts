import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Agent, Ctx, Migration } from '../../core/types.js';
import { defineTable, newId, now } from '../../core/db.js';
import { bytesText } from '../../core/i18n.js';
import { agentRootList, isInside as inside, isProtectedPath } from '../../tools/builtin/files.js';
import { documentsFor } from './index.js';

/**
 * Prullenbak (trash) and run snapshots for files bots change in their folders.
 *
 * - Before a bot overwrites or edits a file, its current content is copied here (once per run and file: the version
 *   from before the run). Before a bot deletes a file, the file itself moves here. A file a run creates is noted
 *   (no content), so "alles van deze run terugzetten" can take it away again (into the trash, never gone).
 * - Together the entries of one run are the snapshot of exactly the files that run touched.
 * - Kept 30 days, at most 2 GB per user (the oldest go first when it is full), one file at most 200 MB. A file that
 *   does not fit is never removed silently: the delete tool asks the owner for a permanent delete (files.ts).
 * - Restoring never loses anything either: a file that is in the way goes into the trash first.
 */

export const TRASH_DAYS = 30;
export const TRASH_MAX_BYTES = 2 * 1024 ** 3;
export const TRASH_MAX_FILE = 200 * 1024 ** 2;

export type TrashKind = 'deleted' | 'overwritten' | 'created';

export interface TrashEntry {
  id: string;
  user_id: string;
  agent_id: string | null;
  run_id: string | null;
  thread_id: string | null;
  kind: TrashKind;
  /** Absolute path of the file in the bot's folder. */
  path: string;
  /** The folder it is in (display) and the path inside it. */
  root: string;
  root_label: string;
  rel: string;
  size: number;
  sha256: string | null;
  /** File name of the copy in the trash folder; null = no content kept (a created file, an empty folder, too big). */
  stored: string | null;
  is_dir: boolean;
  /** Why no copy was kept: too_big. */
  note: string | null;
  /** What changed it: write_file, edit_file, delete_file, restore … */
  source: string;
  created_at: string;
  expires_at: string;
  restored_at: string | null;
}

defineTable('folder_trash', { bool: ['is_dir'] });

export const trashMigrations: Migration[] = [
  {
    id: 'folders-001',
    sql: `
CREATE TABLE folder_trash (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, agent_id TEXT, run_id TEXT, thread_id TEXT, kind TEXT NOT NULL,
  path TEXT NOT NULL, root TEXT NOT NULL DEFAULT '', root_label TEXT NOT NULL DEFAULT '', rel TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0, sha256 TEXT, stored TEXT, is_dir INTEGER NOT NULL DEFAULT 0, note TEXT,
  source TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, expires_at TEXT NOT NULL, restored_at TEXT
);
CREATE INDEX folder_trash_user ON folder_trash(user_id, created_at);
CREATE INDEX folder_trash_run ON folder_trash(run_id);
CREATE INDEX folder_trash_expires ON folder_trash(expires_at);
`,
  },
];

export interface KeepInput {
  agent: Agent;
  /** Absolute path (as resolved by resolveInWorkspace). */
  file: string;
  runId?: string | null;
  threadId?: string | null;
  source: string;
}

export interface KeepResult {
  /** The content is safe in the trash (now or earlier in this run). */
  kept: boolean;
  entry: TrashEntry | null;
  /** Why it could not be kept (plain Dutch, for the bot and the owner). */
  reason?: string;
  tooBig?: boolean;
}

const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

function hashFile(file: string): string {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

/** Move a file, also across drives (rename fails with EXDEV there). */
function moveFile(from: string, to: string) {
  try {
    fs.renameSync(from, to);
  } catch (e: any) {
    if (e?.code !== 'EXDEV' && e?.code !== 'EPERM') throw e;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

export interface TrashLimits {
  days: number;
  maxBytes: number;
  maxFile: number;
}

export class Trash {
  readonly limits: TrashLimits;
  constructor(private ctx: Ctx, limits: Partial<TrashLimits> = {}) {
    this.limits = { days: TRASH_DAYS, maxBytes: TRASH_MAX_BYTES, maxFile: TRASH_MAX_FILE, ...limits };
  }

  private dir(userId: string) {
    const d = path.join(this.ctx.config.dataDir, 'trash', userId.replace(/[^\w-]/g, '_'));
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  private decode(row: any): TrashEntry {
    return this.ctx.store.decode<TrashEntry>('folder_trash', row);
  }

  get(id: string): TrashEntry | null {
    return this.ctx.store.get<TrashEntry>('folder_trash', id);
  }

  /** Where in the bot's folders a path is (the most specific folder), for display. */
  private place(agent: Agent | null, file: string): { root: string; label: string; rel: string } {
    const roots = agent ? agentRootList(agent).filter((r) => inside(file, r.path)).sort((a, b) => b.path.length - a.path.length) : [];
    const r = roots[0];
    if (!r) return { root: path.dirname(file), label: path.basename(path.dirname(file)), rel: path.basename(file) };
    return { root: r.path, label: r.kind === 'workspace' ? `Werkmap van ${agent!.name}` : r.label, rel: path.relative(r.path, file).split(path.sep).join('/') || path.basename(file) };
  }

  usage(userId: string): { bytes: number; count: number; maxBytes: number; maxFile: number; days: number } {
    const row = this.ctx.store.one<{ b: number; n: number }>('SELECT COALESCE(SUM(size), 0) b, COUNT(*) n FROM folder_trash WHERE user_id = ? AND stored IS NOT NULL', userId);
    return { bytes: row?.b || 0, count: row?.n || 0, maxBytes: this.limits.maxBytes, maxFile: this.limits.maxFile, days: this.limits.days };
  }

  /** Can a file of this size go into the trash (after making room by dropping the oldest entries)? */
  fits(size: number): boolean {
    return size <= this.limits.maxFile;
  }

  /** Make room for `size` bytes: expired entries first, then the oldest ones (never one of the run that asks). */
  private makeRoom(userId: string, size: number, runId?: string | null) {
    this.cleanup(userId);
    let used = this.usage(userId).bytes;
    if (used + size <= this.limits.maxBytes) return;
    const rows = this.ctx.store.all<any>("SELECT * FROM folder_trash WHERE user_id = ? AND stored IS NOT NULL AND (run_id IS NULL OR run_id != ?) ORDER BY created_at LIMIT 2000", userId, runId || '');
    for (const r of rows) {
      if (used + size <= this.limits.maxBytes) break;
      this.drop(this.decode(r), 'full');
      used -= r.size || 0;
    }
  }

  /** Remove one entry and its copy (expired, purged by the owner, or room was needed). */
  private drop(e: TrashEntry, why: 'expired' | 'full' | 'purged') {
    if (e.stored) {
      try {
        fs.rmSync(path.join(this.dir(e.user_id), e.stored), { force: true });
      } catch {
        /* already gone */
      }
    }
    this.ctx.store.remove('folder_trash', e.id);
    if (why !== 'expired') this.ctx.audit(e.user_id, 'trash.dropped', { id: e.id, path: e.path, why }, e.agent_id);
  }

  private insert(e: Omit<TrashEntry, 'id' | 'created_at' | 'expires_at' | 'restored_at'>): TrashEntry {
    const ts = Date.now();
    const row: TrashEntry = { ...e, id: newId('trs_'), created_at: new Date(ts).toISOString(), expires_at: new Date(ts + this.limits.days * 86_400_000).toISOString(), restored_at: null };
    this.ctx.store.insert('folder_trash', row);
    this.ctx.events.emit(e.user_id, 'trash.updated', { id: row.id, kind: row.kind, path: row.path });
    return row;
  }

  /** The first entry of a run for a path (its state from before the run). */
  private firstOfRun(runId: string, file: string): TrashEntry | null {
    const rows = this.ctx.store.all<any>('SELECT * FROM folder_trash WHERE run_id = ? ORDER BY created_at, rowid', runId);
    const hit = rows.find((r) => norm(r.path) === norm(file));
    return hit ? this.decode(hit) : null;
  }

  /** Copy (or move) one file into the trash folder. */
  private store(userId: string, file: string, move: boolean): { stored: string; sha: string; size: number } {
    const id = newId('blob_');
    const dest = path.join(this.dir(userId), id);
    if (move) moveFile(file, dest);
    else fs.copyFileSync(file, dest);
    return { stored: id, sha: hashFile(dest), size: fs.statSync(dest).size };
  }

  /**
   * Before a bot overwrites or edits a file: keep its current content (once per run and file — the version from before
   * the run; later changes in the same run are the bot's own work).
   */
  keepBeforeWrite(o: KeepInput): KeepResult {
    const st = fs.statSync(o.file, { throwIfNoEntry: false });
    if (!st || !st.isFile()) return { kept: false, entry: null };
    const userId = o.agent.user_id;
    if (o.runId) {
      const prev = this.firstOfRun(o.runId, o.file);
      if (prev) return { kept: !!prev.stored || prev.kind === 'created', entry: prev, reason: prev.note === 'too_big' ? this.tooBigText(prev.size) : undefined, tooBig: prev.note === 'too_big' };
    }
    const where = this.place(o.agent, o.file);
    const base = { user_id: userId, agent_id: o.agent.id, run_id: o.runId || null, thread_id: o.threadId || null, kind: 'overwritten' as const, path: o.file, root: where.root, root_label: where.label, rel: where.rel, is_dir: false, source: o.source };
    if (!this.fits(st.size)) {
      const entry = this.insert({ ...base, size: st.size, sha256: null, stored: null, note: 'too_big' });
      return { kept: false, entry, reason: this.tooBigText(st.size), tooBig: true };
    }
    this.makeRoom(userId, st.size, o.runId);
    const s = this.store(userId, o.file, false);
    const entry = this.insert({ ...base, size: s.size, sha256: s.sha, stored: s.stored, note: null });
    this.ctx.audit(userId, 'trash.kept', { id: entry.id, path: o.file, kind: 'overwritten', bytes: s.size }, o.agent.id);
    return { kept: true, entry };
  }

  /** A run created this file (it did not exist): noted, so restoring the run can take it away again. */
  noteCreated(o: KeepInput): void {
    if (!o.runId || this.firstOfRun(o.runId, o.file)) return;
    const where = this.place(o.agent, o.file);
    this.insert({ user_id: o.agent.user_id, agent_id: o.agent.id, run_id: o.runId, thread_id: o.threadId || null, kind: 'created', path: o.file, root: where.root, root_label: where.label, rel: where.rel, size: 0, sha256: null, stored: null, is_dir: false, note: null, source: o.source });
  }

  /**
   * A bot deletes a file (or an empty folder): it moves into the trash. Returns kept=false with tooBig when it does not
   * fit; the caller then must not delete it without an explicit permanent-delete approval.
   */
  moveToTrash(o: KeepInput): KeepResult {
    const st = fs.statSync(o.file, { throwIfNoEntry: false });
    if (!st) return { kept: false, entry: null, reason: 'Bestaat niet' };
    const userId = o.agent.user_id;
    const where = this.place(o.agent, o.file);
    const base = { user_id: userId, agent_id: o.agent.id, run_id: o.runId || null, thread_id: o.threadId || null, kind: 'deleted' as const, path: o.file, root: where.root, root_label: where.label, rel: where.rel, source: o.source };
    if (st.isDirectory()) {
      // Only empty folders are deleted by the tools; nothing to copy, the entry recreates it.
      fs.rmdirSync(o.file);
      const entry = this.insert({ ...base, size: 0, sha256: null, stored: null, is_dir: true, note: null });
      this.ctx.audit(userId, 'trash.kept', { id: entry.id, path: o.file, kind: 'deleted', dir: true }, o.agent.id);
      return { kept: true, entry };
    }
    if (!this.fits(st.size)) return { kept: false, entry: null, reason: this.tooBigText(st.size), tooBig: true };
    this.makeRoom(userId, st.size, o.runId);
    const s = this.store(userId, o.file, true);
    const entry = this.insert({ ...base, size: s.size, sha256: s.sha, stored: s.stored, is_dir: false, note: null });
    this.ctx.audit(userId, 'trash.kept', { id: entry.id, path: o.file, kind: 'deleted', bytes: s.size }, o.agent.id);
    return { kept: true, entry };
  }

  tooBigText(size: number): string {
    return `Dit bestand is te groot voor de prullenbak (${bytesText(size)}, maximaal ${bytesText(this.limits.maxFile)}).`;
  }

  /** Never write into TeamBot's own data or a key file when restoring (the bots' folders in it are theirs). */
  private restorable(file: string): string | null {
    if (isProtectedPath(file)) return 'Dit pad is beschermd (geheimen/sleutels).';
    const data = path.resolve(this.ctx.config.dataDir);
    if (inside(file, data) && !inside(file, path.join(data, 'workspaces')) && !inside(file, documentsFor(this.ctx))) return 'Terugzetten in de gegevensmap van TeamBot kan niet.';
    return null;
  }

  /**
   * Put one entry back on its place. A file that is there now goes into the trash first (nothing is ever lost).
   * A "created" entry has nothing to put back: restoring it means taking the file the run made away.
   */
  restore(userId: string, id: string, o: { runId?: string | null } = {}): { ok: boolean; path: string; message: string; replaced?: string } {
    const e = this.get(id);
    if (!e || e.user_id !== userId) return { ok: false, path: '', message: 'Niet gevonden in de prullenbak' };
    const why = this.restorable(e.path);
    if (why) return { ok: false, path: e.path, message: why };
    const agent = e.agent_id ? this.ctx.store.agent(e.agent_id) : null;
    const owner = agent && agent.user_id === userId ? agent : ({ id: e.agent_id, user_id: userId, name: 'de bot', settings: {}, workspace: e.root } as unknown as Agent);
    const cur = fs.statSync(e.path, { throwIfNoEntry: false });
    let replaced: string | undefined;
    if (e.kind === 'created') {
      if (cur?.isFile()) {
        const k = this.moveToTrash({ agent: owner, file: e.path, runId: o.runId ?? null, source: 'restore' });
        if (!k.kept) return { ok: false, path: e.path, message: k.reason || 'Kon het bestand niet weghalen' };
        replaced = k.entry?.id;
      }
      this.ctx.store.update('folder_trash', e.id, { restored_at: now() });
      this.ctx.audit(userId, 'trash.restored', { id: e.id, path: e.path, kind: e.kind }, e.agent_id);
      return { ok: true, path: e.path, message: cur ? 'Het nieuwe bestand staat nu in de prullenbak' : 'Het bestand was er al niet meer', replaced };
    }
    if (e.is_dir) {
      fs.mkdirSync(e.path, { recursive: true });
    } else {
      if (!e.stored) return { ok: false, path: e.path, message: e.note === 'too_big' ? 'Van dit bestand is geen kopie bewaard (te groot).' : 'Van dit bestand is geen kopie bewaard.' };
      const blob = path.join(this.dir(userId), e.stored);
      if (!fs.existsSync(blob)) return { ok: false, path: e.path, message: 'De kopie in de prullenbak is weg.' };
      if (cur?.isDirectory()) return { ok: false, path: e.path, message: 'Op die plek staat nu een map met dezelfde naam.' };
      if (cur?.isFile()) {
        if (e.sha256 && cur.size === e.size && hashFile(e.path) === e.sha256) {
          this.finishRestore(e, userId);
          return { ok: true, path: e.path, message: 'Het bestand was al zo' };
        }
        const k = this.keepBeforeWrite({ agent: owner, file: e.path, runId: null, source: 'restore' });
        if (!k.kept) return { ok: false, path: e.path, message: k.reason || 'Kon het huidige bestand niet eerst bewaren' };
        replaced = k.entry?.id;
      }
      fs.mkdirSync(path.dirname(e.path), { recursive: true });
      fs.copyFileSync(blob, e.path);
    }
    this.finishRestore(e, userId);
    return { ok: true, path: e.path, message: replaced ? 'Teruggezet; de versie die er stond, staat nu in de prullenbak' : 'Teruggezet', replaced };
  }

  private finishRestore(e: TrashEntry, userId: string) {
    if (e.stored) {
      try {
        fs.rmSync(path.join(this.dir(userId), e.stored), { force: true });
      } catch {
        /* ignore */
      }
    }
    this.ctx.store.update('folder_trash', e.id, { restored_at: now(), stored: null });
    this.ctx.audit(userId, 'trash.restored', { id: e.id, path: e.path, kind: e.kind }, e.agent_id);
    this.ctx.events.emit(userId, 'trash.updated', { id: e.id, restored: true });
  }

  /** The files one run touched, with what was there before the run (its snapshot). */
  runChanges(userId: string, runId: string) {
    const rows = this.ctx.store.all<any>('SELECT * FROM folder_trash WHERE user_id = ? AND run_id = ? ORDER BY created_at, rowid', userId, runId).map((r) => this.decode(r));
    const first = new Map<string, TrashEntry>();
    for (const r of rows) if (!first.has(norm(r.path))) first.set(norm(r.path), r);
    return [...first.values()].map((e) => ({
      id: e.id,
      path: e.path,
      rel: e.rel,
      root_label: e.root_label,
      kind: e.kind,
      size: e.size,
      restored: !!e.restored_at,
      /** Can this one be put back (a copy is kept, or it was created by the run)? */
      restorable: !e.restored_at && (e.kind === 'created' || e.is_dir || !!e.stored),
      note: e.note,
      exists: fs.existsSync(e.path),
    }));
  }

  /** "Alles van deze run terugzetten": every touched file back to how it was before the run. */
  restoreRun(userId: string, runId: string): { restored: { path: string; message: string }[]; failed: { path: string; message: string }[] } {
    const out = { restored: [] as { path: string; message: string }[], failed: [] as { path: string; message: string }[] };
    for (const c of this.runChanges(userId, runId)) {
      if (c.restored) continue;
      const r = this.restore(userId, c.id);
      (r.ok ? out.restored : out.failed).push({ path: c.path, message: r.message });
    }
    this.ctx.audit(userId, 'trash.run_restored', { runId, restored: out.restored.length, failed: out.failed.length });
    return out;
  }

  list(userId: string, o: { agentId?: string; runId?: string; restored?: boolean; limit?: number } = {}) {
    const where = ['user_id = ?', "kind != 'created'"];
    const args: any[] = [userId];
    if (o.agentId) {
      where.push('agent_id = ?');
      args.push(o.agentId);
    }
    if (o.runId) {
      where.push('run_id = ?');
      args.push(o.runId);
    }
    if (!o.restored) where.push('restored_at IS NULL');
    const limit = Math.max(1, Math.min(500, o.limit || 200));
    return this.ctx.store.all<any>(`SELECT * FROM folder_trash WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`, ...args, limit).map((r) => this.decode(r));
  }

  /** The kept copy itself, for "Downloaden" in the trash view. */
  blobPath(e: TrashEntry): string | null {
    if (!e.stored) return null;
    const p = path.join(this.dir(e.user_id), e.stored);
    return fs.existsSync(p) ? p : null;
  }

  purge(userId: string, id: string): boolean {
    const e = this.get(id);
    if (!e || e.user_id !== userId) return false;
    this.drop(e, 'purged');
    this.ctx.events.emit(userId, 'trash.updated', { id, purged: true });
    return true;
  }

  empty(userId: string): number {
    const rows = this.ctx.store.all<any>('SELECT * FROM folder_trash WHERE user_id = ?', userId);
    for (const r of rows) this.drop(this.decode(r), 'purged');
    this.ctx.audit(userId, 'trash.emptied', { entries: rows.length });
    this.ctx.events.emit(userId, 'trash.updated', { emptied: true });
    return rows.length;
  }

  /** Retention: entries older than TRASH_DAYS go (with their copies). Restored entries stay a week as history. */
  cleanup(userId?: string): number {
    const ts = now();
    const restoredBefore = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const rows = userId
      ? this.ctx.store.all<any>('SELECT * FROM folder_trash WHERE user_id = ? AND (expires_at <= ? OR (restored_at IS NOT NULL AND restored_at <= ?)) LIMIT 5000', userId, ts, restoredBefore)
      : this.ctx.store.all<any>('SELECT * FROM folder_trash WHERE expires_at <= ? OR (restored_at IS NOT NULL AND restored_at <= ?) LIMIT 5000', ts, restoredBefore);
    for (const r of rows) this.drop(this.decode(r), 'expired');
    return rows.length;
  }
}
