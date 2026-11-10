import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../../core/types.js';
import { HttpError, bad } from '../../core/http.js';
import { APPLIED_MARKER, PENDING_MARKER, copyTree, planParts, vacuumCopy, type PartPlan, type PendingRestore } from './files.js';
import { compareVersions } from './updates.js';
import { stamp } from './restore.js';

/**
 * Full app backups (package N): the database and team databases (consistent copies), the data folders that matter,
 * optionally the work and group folders, never caches, models or programs. Daily automatic backups (keep N),
 * a backup before every TeamBot update, and a restore with one click that keeps "forget" and "Geschiedenis wissen"
 * (core applyPendingRestore carries those over) and rebuilds the derived search indexes afterwards.
 *
 * The sets keep the file names backups have had since 0.3 (teambot-<moment>[-kind].db).
 */

export const NAME = /^teambot-\d{8}-\d{6}(-[a-z]+)?\.db$/;
export type BackupKind = 'manual' | 'auto' | 'update';

export interface Settings {
  /** A backup every day while TeamBot runs. */
  auto: boolean;
  /** How many automatic backups stay. */
  keep: number;
  /** Work and group folders also in the automatic backup. */
  includeWork: boolean;
}
const DEFAULTS: Settings = { auto: true, keep: 7, includeWork: false };
/** Backups made right before an update: the last ones stay (the newest is needed for "Terug naar versie x"). */
const KEEP_UPDATE = 3;

export interface Manifest {
  format: 1;
  app: 'TeamBot';
  version: string;
  createdAt: string;
  kind: BackupKind | 'replaced';
  label?: string;
  includesWork: boolean;
  /** Only the database, team databases and the key (the backup before an update). */
  dataOnly?: boolean;
  dbBytes: number;
  teamDatabases: number;
  parts: { id: string; label: string; bytes: number; files: number }[];
  skipped: { path: string; reason: string }[];
  /** Parts left out because they were too big (unknown parts) or optional and not chosen. */
  leftOut: { id: string; label: string; reason: string }[];
  bytes: number;
  platform: string;
  update?: { from: string; to: string };
}

export interface BackupItem {
  name: string;
  createdAt: string;
  kind: BackupKind | 'replaced';
  label?: string;
  version?: string;
  bytes: number;
  includesWork: boolean;
  dataOnly: boolean;
  /** A backup from before this feature: only the database (and team databases). */
  legacy: boolean;
  update?: { from: string; to: string };
}

export interface Job {
  phase: 'database' | 'files' | 'done' | 'error';
  kind: BackupKind;
  done: number;
  total: number;
  startedAt: string;
  name?: string;
  error?: string;
}

const base = (name: string) => name.replace(/\.db$/, '');
const kindOf = (name: string): BackupItem['kind'] => {
  const k = name.match(/-([a-z]+)\.db$/)?.[1];
  return k === 'auto' || k === 'update' || k === 'replaced' ? k : 'manual';
};

export class BackupService {
  job: Job | null = null;
  /** Called after every new backup set (the encrypted copy to the second place, offsite.ts). Must not throw. */
  onCreated: ((b: BackupItem) => void) | null = null;
  private running: Promise<any> | null = null;
  private planCache: { at: number; v: PartPlan[] } | null = null;

  constructor(private ctx: Ctx) {}

  get dataDir() {
    return this.ctx.config.dataDir;
  }
  dir() {
    const d = path.join(this.dataDir, 'backups');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  // ------------------------------------------------------------------ settings (a file: they belong to this
  // installation and survive a restore of an older backup)

  settings(): Settings {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(this.dir(), 'settings.json'), 'utf8'));
      return { auto: j.auto !== false, keep: clampKeep(j.keep), includeWork: j.includeWork === true };
    } catch {
      return { ...DEFAULTS };
    }
  }

  saveSettings(patch: Partial<Settings>): Settings {
    const cur = this.settings();
    const next: Settings = {
      auto: typeof patch.auto === 'boolean' ? patch.auto : cur.auto,
      keep: patch.keep !== undefined ? clampKeep(patch.keep) : cur.keep,
      includeWork: typeof patch.includeWork === 'boolean' ? patch.includeWork : cur.includeWork,
    };
    fs.writeFileSync(path.join(this.dir(), 'settings.json'), JSON.stringify(next, null, 1));
    return next;
  }

  // ------------------------------------------------------------------ listing

  manifest(name: string): Manifest | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir(), `${base(name)}.json`), 'utf8'));
    } catch {
      return null;
    }
  }

  exists(name: string) {
    return NAME.test(name) && fs.existsSync(path.join(this.dir(), name));
  }

  list(): BackupItem[] {
    return fs
      .readdirSync(this.dir())
      .filter((f) => NAME.test(f))
      .map((f) => {
        const m = this.manifest(f);
        const st = fs.statSync(path.join(this.dir(), f));
        return {
          name: f,
          createdAt: m?.createdAt || st.mtime.toISOString(),
          kind: kindOf(f),
          label: m?.label,
          version: m?.version,
          bytes: m?.bytes ?? st.size,
          includesWork: !!m?.includesWork,
          dataOnly: !!m?.dataOnly,
          legacy: !m,
          update: m?.update,
        };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  }

  /** What a backup would contain now, with sizes (cached a minute: walking big work folders takes a while). */
  async plan(fresh = false): Promise<PartPlan[]> {
    if (!fresh && this.planCache && Date.now() - this.planCache.at < 60_000) return this.planCache.v;
    const v = await planParts(this.dataDir);
    this.planCache = { at: Date.now(), v };
    return v;
  }

  /** The database and team databases now (always in a backup). */
  dbBytes(): number {
    return fileSize(path.join(this.dataDir, 'teambot.db')) + fileSize(path.join(this.dataDir, 'teambot.db-wal')) + teamDatabases(this.dataDir).reduce((s, f) => s + fileSize(f), 0);
  }

  // ------------------------------------------------------------------ making a backup

  /**
   * Make a backup set. One at a time; a second call while one runs waits for it and returns that one's result.
   * `dataOnly`: the database, team databases and key only (fast; the backup before an update).
   */
  async make(o: { kind?: BackupKind; includeWork?: boolean; dataOnly?: boolean; label?: string; update?: { from: string; to: string }; onProgress?: (j: Job) => void } = {}): Promise<BackupItem> {
    if (this.running) {
      await this.running.catch(() => {});
    }
    const p = this.doMake(o);
    this.running = p;
    try {
      return await p;
    } finally {
      if (this.running === p) this.running = null;
    }
  }

  private async doMake(o: { kind?: BackupKind; includeWork?: boolean; dataOnly?: boolean; label?: string; update?: { from: string; to: string }; onProgress?: (j: Job) => void }): Promise<BackupItem> {
    const kind = o.kind || 'manual';
    let at = new Date();
    let name = `teambot-${stamp(at)}${kind === 'manual' ? '' : `-${kind}`}`;
    // Two backups in the same second (a pre-update backup right after a manual one): never overwrite.
    while (fs.existsSync(path.join(this.dir(), `${name}.db`)) || fs.existsSync(path.join(this.dir(), `${name}.db.partial`))) {
      at = new Date(at.getTime() + 1000);
      name = `teambot-${stamp(at)}${kind === 'manual' ? '' : `-${kind}`}`;
    }
    const dir = this.dir();
    const dbPartial = path.join(dir, `${name}.db.partial`);
    const files = path.join(dir, `${name}.files`);
    const team = path.join(dir, `${name}.teamdata`);
    const job: Job = { phase: 'database', kind, done: 0, total: 0, startedAt: new Date().toISOString() };
    this.job = job;
    let last = 0;
    const report = (force = false) => {
      if (!force && Date.now() - last < 400) return;
      last = Date.now();
      try {
        o.onProgress?.({ ...job });
      } catch {
        /* a listener never breaks a backup */
      }
    };
    try {
      const plan = o.dataOnly ? [] : await this.plan(true);
      const includeWork = !o.dataOnly && !!o.includeWork;
      const chosen = plan.filter((p) => p.exists && (p.kind === 'always' || (p.kind === 'optional' && includeWork)) && !(p.unknown && p.bytes > 2 * 1024 ** 3));
      const keyPart = o.dataOnly ? (await planParts(this.dataDir)).filter((p) => p.file && p.exists && p.id.startsWith('master.key.')) : [];
      const leftOut: Manifest['leftOut'] = plan
        .filter((p) => p.exists && !chosen.includes(p) && p.kind !== 'excluded')
        .map((p) => ({ id: p.id, label: p.label, reason: p.kind === 'optional' ? 'niet gekozen' : 'te groot (meer dan 2 GB)' }));
      const dbSize = fileSize(path.join(this.dataDir, 'teambot.db')) + fileSize(path.join(this.dataDir, 'teambot.db-wal'));
      const teamFiles = teamDatabases(this.dataDir);
      job.total = dbSize + teamFiles.reduce((s, f) => s + fileSize(f), 0) + [...chosen, ...keyPart].reduce((s, p) => s + p.bytes, 0);
      assertSpace(dir, job.total);
      report(true);
      // The database: consistent while TeamBot runs.
      this.ctx.db.exec(`VACUUM INTO '${dbPartial.replace(/'/g, "''")}'`);
      job.done += dbSize;
      for (const f of teamFiles) {
        try {
          vacuumCopy(f, path.join(team, path.basename(f)));
        } catch (e: any) {
          this.ctx.log.warn('[backups] teamdatabase niet gekopieerd', path.basename(f), e?.message || e);
        }
        job.done += fileSize(f);
      }
      report(true);
      job.phase = 'files';
      const parts: Manifest['parts'] = [];
      const skipped: Manifest['skipped'] = [];
      for (const p of [...chosen, ...keyPart]) {
        const r = await copyTree(path.join(this.dataDir, p.id), path.join(files, p.id), (n) => ((job.done += n), report()), p.id);
        parts.push({ id: p.id, label: p.label, bytes: r.bytes, files: r.files });
        skipped.push(...r.skipped.slice(0, 200));
      }
      const dbBytes = fileSize(dbPartial);
      const total = dbBytes + dirSize(team) + parts.reduce((s, p) => s + p.bytes, 0);
      const m: Manifest = {
        format: 1,
        app: 'TeamBot',
        version: this.ctx.config.version,
        createdAt: at.toISOString(),
        kind,
        label: o.label,
        includesWork: includeWork,
        dataOnly: o.dataOnly || undefined,
        dbBytes,
        teamDatabases: teamFiles.length,
        parts,
        skipped: skipped.slice(0, 500),
        leftOut,
        bytes: total,
        platform: process.platform,
        update: o.update,
      };
      fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(m, null, 1));
      // Last: only a complete set has a .db that the listing (and core's routes) see.
      fs.renameSync(dbPartial, path.join(dir, `${name}.db`));
      job.phase = 'done';
      job.name = `${name}.db`;
      job.done = job.total;
      report(true);
      if (kind === 'auto') this.prune('auto', this.settings().keep);
      if (kind === 'update') this.prune('update', KEEP_UPDATE);
      this.planCache = null;
      const made = this.list().find((b) => b.name === `${name}.db`)!;
      try {
        this.onCreated?.(made);
      } catch {
        /* a listener never breaks a backup */
      }
      return made;
    } catch (e: any) {
      for (const p of [dbPartial, files, team, path.join(dir, `${name}.json`)]) fs.rmSync(p, { recursive: true, force: true });
      job.phase = 'error';
      job.error = e instanceof HttpError ? e.message : `De back-up is niet gelukt: ${String(e?.message || e).slice(0, 300)}`;
      report(true);
      throw e instanceof HttpError ? e : new HttpError(500, job.error);
    }
  }

  /** Remove the oldest sets of one kind beyond `keep`. Manual backups and safety copies are never removed here. */
  prune(kind: 'auto' | 'update', keep: number) {
    const sets = this.list().filter((b) => b.kind === kind);
    for (const b of sets.slice(Math.max(1, keep))) this.remove(b.name);
  }

  remove(name: string) {
    if (!NAME.test(name)) throw bad('Ongeldige naam');
    const dir = this.dir();
    for (const p of [name, `${base(name)}.json`, `${base(name)}.teamdata`, `${base(name)}.files`]) fs.rmSync(path.join(dir, p), { recursive: true, force: true });
    this.planCache = null;
  }

  // ------------------------------------------------------------------ restore

  pending(): PendingRestore | null {
    if (!fs.existsSync(path.join(this.dataDir, 'restore-pending.db'))) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dataDir, PENDING_MARKER), 'utf8'));
    } catch {
      return { name: '', at: '' };
    }
  }

  /**
   * Stage a restore for the next start: the database and team databases as core does it, plus a marker so the data
   * files come back too (files.ts applyPendingFiles). A backup made by a newer TeamBot is refused, except on the way
   * back to an older version (rollback), where the backup is from that older version anyway.
   */
  stageRestore(name: string, o: { by?: string; reason?: 'restore' | 'rollback' } = {}): PendingRestore {
    if (!NAME.test(name)) throw bad('Ongeldige naam');
    const file = path.join(this.dir(), name);
    if (!fs.existsSync(file)) throw bad('Back-up niet gevonden');
    const m = this.manifest(name);
    if (m?.version && o.reason !== 'rollback' && compareVersions(m.version, this.ctx.config.version) > 0)
      throw bad(`Deze back-up is gemaakt met TeamBot ${m.version}, een nieuwere versie dan deze (${this.ctx.config.version}). Werk TeamBot eerst bij naar ${m.version} of nieuwer.`);
    const dd = this.dataDir;
    fs.copyFileSync(file, path.join(dd, 'restore-pending.db'));
    const pendingTeam = path.join(dd, 'restore-pending.teamdata');
    fs.rmSync(pendingTeam, { recursive: true, force: true });
    const side = path.join(this.dir(), `${base(name)}.teamdata`);
    if (fs.existsSync(side)) fs.cpSync(side, pendingTeam, { recursive: true });
    const marker: PendingRestore = { name: base(name), at: new Date().toISOString(), by: o.by, reason: o.reason || 'restore', version: m?.version };
    fs.writeFileSync(path.join(dd, PENDING_MARKER), JSON.stringify(marker));
    return marker;
  }

  cancelRestore() {
    for (const f of ['restore-pending.db', 'restore-pending.teamdata', PENDING_MARKER]) fs.rmSync(path.join(this.dataDir, f), { recursive: true, force: true });
  }

  /** The last restore that was put in place (for the settings page). */
  lastRestore(): (PendingRestore & { appliedAt: string; parts: string[]; safety?: string | null }) | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir(), 'last-restore.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * At start, after a restore: rebuild the derived indexes (after the memory and history modules re-applied what was
   * forgotten or wiped), tell the owner, and keep a note for the settings page. Modules with an index of their own
   * listen to the server event "backups.restored".
   */
  afterRestore(): any {
    const f = path.join(this.dataDir, APPLIED_MARKER);
    if (!fs.existsSync(f)) return null;
    let info: any = {};
    try {
      info = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      info = {};
    }
    fs.rmSync(f, { force: true });
    const rebuilt: string[] = [];
    try {
      rebuildMessageIndex(this.ctx);
      rebuilt.push('messages');
    } catch (e) {
      this.ctx.log.error('[backups] zoekindex van berichten opnieuw opbouwen mislukt', e);
    }
    try {
      const svc = this.ctx.services.memory?.svc;
      if (svc?.reindex) {
        svc.reindex();
        rebuilt.push('memory');
      }
    } catch (e) {
      this.ctx.log.error('[backups] zoekindex van het geheugen opnieuw opbouwen mislukt', e);
    }
    const note = { ...info, rebuilt };
    try {
      fs.writeFileSync(path.join(this.dir(), 'last-restore.json'), JSON.stringify(note, null, 1));
    } catch {
      /* the note is a nicety */
    }
    this.ctx.events.emit('*', 'backups.restored', note);
    const owner = this.ctx.auth.owner();
    if (owner) {
      this.ctx.audit(owner.id, 'backup.restored', { name: info.name, reason: info.reason || 'restore', parts: (info.parts || []).length });
      if (info.reason !== 'rollback')
        this.ctx.events.emit(owner.id, 'notification', {
          title: 'Back-up teruggezet',
          body: 'TeamBot draait weer met de gekozen back-up. Wat je had vergeten, blijft vergeten. De stand van vóór het terugzetten is bewaard als veiligheidskopie.',
          link: '#/settings/backups-app',
          kind: 'system',
        });
    }
    return note;
  }
}

/** Rebuild the full-text index of the chat messages from the messages (same rule as the core migration). */
export function rebuildMessageIndex(ctx: Ctx) {
  ctx.store.tx(() => {
    ctx.store.exec('DELETE FROM messages_fts');
    ctx.store.exec('DELETE FROM messages_fts_map');
    ctx.store.exec(`INSERT INTO messages_fts (content, message_id, thread_id, user_id)
      SELECT m.content, m.id, m.thread_id, t.user_id FROM messages m JOIN threads t ON t.id = m.thread_id
      WHERE m.deleted = 0 AND m.content != '' AND m.role IN ('user', 'assistant') ORDER BY m.rowid`);
    ctx.store.exec('INSERT INTO messages_fts_map (message_id, rid, thread_id) SELECT message_id, rowid, thread_id FROM messages_fts');
  });
}

const clampKeep = (v: any) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(30, Math.max(1, n)) : DEFAULTS.keep;
};

function fileSize(f: string) {
  try {
    return fs.statSync(f).size;
  } catch {
    return 0;
  }
}

function dirSize(d: string) {
  try {
    return fs.readdirSync(d).reduce((s, f) => s + fileSize(path.join(d, f)), 0);
  } catch {
    return 0;
  }
}

function teamDatabases(dataDir: string): string[] {
  const d = path.join(dataDir, 'teamdata');
  try {
    return fs
      .readdirSync(d)
      .filter((f) => f.endsWith('.db'))
      .map((f) => path.join(d, f));
  } catch {
    return [];
  }
}

/** Refuse a backup that would fill the disk (needs the estimated size plus 10% and 200 MB to spare). */
function assertSpace(dir: string, bytes: number) {
  let free = Infinity;
  try {
    const s = fs.statfsSync(dir);
    free = Number(s.bavail) * Number(s.bsize);
  } catch {
    return;
  }
  const need = bytes * 1.1 + 200 * 1024 ** 2;
  if (free < need) {
    const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1).replace('.', ',')} GB`;
    throw bad(`Niet genoeg vrije schijfruimte voor deze back-up: nodig ongeveer ${gb(need)}, vrij ${gb(free)}. Maak ruimte vrij of laat de werkmappen eruit.`);
  }
}
