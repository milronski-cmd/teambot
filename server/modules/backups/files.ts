import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * What a full app backup contains, and how its files are copied and put back. No Ctx here: core's
 * applyPendingRestore (restore.ts) and the desktop shell use it before or after the server runs.
 *
 * A backup "set" in `<data>/backups/` is one name `teambot-YYYYMMDD-HHMMSS[-kind]` with:
 *   <name>.db         consistent copy of teambot.db (VACUUM INTO), the file core's /admin/backups routes know
 *   <name>.teamdata/  the team databases (VACUUM INTO), the layout core already restores
 *   <name>.files/     the data folders that matter (attachments, skills, sites, ...) and the protected key file
 *   <name>.json       manifest: version, kind, parts, sizes, what was skipped
 * Caches, downloaded models and programs are never in it (EXCLUDED). Work and group folders are optional.
 */

export type PartKind = 'always' | 'optional' | 'excluded';

export interface PartDef {
  /** Top-level name in the data folder. */
  id: string;
  label: string;
  kind: PartKind;
  /** Why it is not in a backup (excluded parts). */
  reason?: string;
  /** A single file instead of a folder. */
  file?: boolean;
}

/** Known parts of the data folder. Anything else a module adds later counts as app data ("always", size-capped). */
export const PARTS: PartDef[] = [
  { id: 'attachments', label: 'Bijlagen en bestanden uit gesprekken', kind: 'always' },
  { id: 'skills', label: 'Skills', kind: 'always' },
  { id: 'sites', label: 'Websites van bots', kind: 'always' },
  { id: 'channels', label: 'Koppelingen met chat-apps', kind: 'always' },
  { id: 'mcp', label: 'Gegevens van gekoppelde apps', kind: 'always' },
  { id: 'trash', label: 'Prullenbak (bestanden die bots verwijderden of overschreven)', kind: 'always' },
  // The protected master key (desktop): only usable by the same Windows account (DPAPI) or the same macOS/Linux login.
  { id: 'master.key.dpapi', label: 'Sleutel van je opgeslagen wachtwoorden', kind: 'always', file: true },
  { id: 'master.key.keychain', label: 'Sleutel van je opgeslagen wachtwoorden', kind: 'always', file: true },
  { id: 'master.key.secret-service', label: 'Sleutel van je opgeslagen wachtwoorden', kind: 'always', file: true },
  { id: 'workspaces', label: 'Werkmappen van bots', kind: 'optional' },
  { id: 'rooms', label: 'Bestanden van groepen', kind: 'optional' },
  { id: 'shared-bots', label: 'Werkmappen van gedeelde bots', kind: 'optional' },
  { id: 'browser', label: 'Browserprofielen van bots', kind: 'excluded', reason: 'Cookies en logins op websites. Log na het terugzetten zo nodig opnieuw in.' },
  { id: 'runtimes', label: 'Eigen kopieën van Claude Code, Codex en OpenCode', kind: 'excluded', reason: 'Programma’s; opnieuw te installeren met één klik.' },
  { id: 'voice', label: 'Spraakmodellen en voorleescache', kind: 'excluded', reason: 'Gedownload; komt vanzelf terug als je spraak gebruikt.' },
  { id: 'cache', label: 'Cache', kind: 'excluded', reason: 'Tijdelijke kopieën van internet.' },
  { id: 'tmp', label: 'Tijdelijke bestanden', kind: 'excluded', reason: 'Tijdelijk.' },
  { id: 'logs', label: 'Logbestanden', kind: 'excluded', reason: 'Alleen voor foutzoeken.' },
  { id: 'health', label: 'Metingen van Hoe gaat het met TeamBot?', kind: 'excluded', reason: 'Alleen voor foutzoeken; begint na het terugzetten opnieuw.' },
  { id: 'electron', label: 'Vensterinstellingen en cache van de app', kind: 'excluded', reason: 'Hoort bij deze installatie.' },
  { id: 'cli-agents', label: 'Werkbestanden van de CLI-engines', kind: 'excluded', reason: 'Tijdelijk; hoort bij deze computer.' },
  { id: 'memory', label: 'Werkbestanden van het geheugen', kind: 'excluded', reason: 'Wordt na het terugzetten opnieuw opgebouwd.' },
  { id: 'updates', label: 'Installatiebestanden van TeamBot', kind: 'excluded', reason: 'Nodig om terug te gaan naar een vorige versie; horen bij deze computer.' },
  { id: 'backups', label: 'De back-ups zelf', kind: 'excluded', reason: 'Een back-up zit nooit in een back-up.' },
];

/** Never copied and never restored: the database itself (separately), keys that belong to this installation, staging. */
// local-url: the address this installation listens on (written at every start; the command line `teambot send` reads it).
const NEVER = /^(teambot\.db(-wal|-shm|-journal)?|teamdata|master\.key|url-signing\.key|local-token|local-url|restore-.*|.*\.onleesbaar-.*|.*\.(tmp|part|partial))$/i;
/** A part of an unknown module bigger than this is left out (and named in the manifest): never a surprise of many GB. */
export const UNKNOWN_CAP = 2 * 1024 ** 3;
const SAFE_NAME = /^[\w][\w.-]{0,80}$/;

export interface PartPlan extends PartDef {
  exists: boolean;
  bytes: number;
  files: number;
  /** More entries than counted (the walk stops at a limit). */
  truncated?: boolean;
  unknown?: boolean;
}

export const partDef = (id: string): PartDef | undefined => PARTS.find((p) => p.id === id);

/** May this top-level name be copied into a backup or put back from one? */
export function restorable(name: string): boolean {
  if (!SAFE_NAME.test(name) || NEVER.test(name)) return false;
  const d = partDef(name);
  return !d || d.kind !== 'excluded';
}

export interface Measure {
  bytes: number;
  files: number;
  truncated: boolean;
}

const MAX_ENTRIES = 500_000;

/** Size of a file or folder. Links (symlinks, junctions) are never followed. Yields now and then on big trees. */
export async function measure(p: string, budget = { left: MAX_ENTRIES }): Promise<Measure> {
  const out: Measure = { bytes: 0, files: 0, truncated: false };
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    return out;
  }
  if (st.isFile()) return { bytes: st.size, files: 1, truncated: false };
  if (!st.isDirectory()) return out;
  const stack = [p];
  let n = 0;
  while (stack.length) {
    const d = stack.pop()!;
    let list: fs.Dirent[];
    try {
      list = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of list) {
      if (--budget.left < 0) {
        out.truncated = true;
        return out;
      }
      const f = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(f);
      else if (e.isFile()) {
        try {
          out.bytes += fs.lstatSync(f).size;
          out.files++;
        } catch {
          /* gone meanwhile */
        }
      }
      if (++n % 2000 === 0) await new Promise((r) => setImmediate(r));
    }
  }
  return out;
}

/** Every top-level part of the data folder, known or not, with its size (the database and team databases apart). */
export async function planParts(dataDir: string): Promise<PartPlan[]> {
  const names = new Set<string>(PARTS.map((p) => p.id));
  try {
    for (const n of fs.readdirSync(dataDir)) if (!NEVER.test(n)) names.add(n);
  } catch {
    /* no data folder yet */
  }
  const out: PartPlan[] = [];
  for (const id of names) {
    const def = partDef(id);
    if (!def && !SAFE_NAME.test(id)) continue;
    const p = path.join(dataDir, id);
    const exists = fs.existsSync(p);
    if (!def && !exists) continue;
    // Excluded parts (caches, models, browser profiles) are named, not walked: they can hold many files.
    const m = exists && def?.kind !== 'excluded' ? await measure(p) : { bytes: 0, files: 0, truncated: false };
    out.push({ ...(def || { id, label: `Overige gegevens (${id})`, kind: 'always' as const }), exists, bytes: m.bytes, files: m.files, truncated: m.truncated || undefined, unknown: !def || undefined });
  }
  return out;
}

export interface CopyResult {
  bytes: number;
  files: number;
  skipped: { path: string; reason: string }[];
}

const SQLITE_EXT = /\.(db|sqlite|sqlite3)$/i;
function isSqlite(file: string): boolean {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const b = Buffer.alloc(16);
      fs.readSync(fd, b, 0, 16, 0);
      return b.toString('latin1') === 'SQLite format 3\0';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** A consistent copy of a SQLite file that may be in use (VACUUM INTO on a read-only connection). */
export function vacuumCopy(src: string, dest: string) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { force: true });
  const db = new DatabaseSync(src, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

/**
 * Copy a file or folder tree. Links are skipped (never followed: a work folder may point anywhere), SQLite files
 * are copied consistently, and a file that cannot be read (locked, gone) is named in `skipped` instead of failing
 * the whole backup. `onBytes` reports progress.
 */
export async function copyTree(src: string, dest: string, onBytes: (n: number) => void = () => {}, rel = ''): Promise<CopyResult> {
  const out: CopyResult = { bytes: 0, files: 0, skipped: [] };
  let st: fs.Stats;
  try {
    st = fs.lstatSync(src);
  } catch (e: any) {
    out.skipped.push({ path: rel || path.basename(src), reason: e?.code || 'niet leesbaar' });
    return out;
  }
  const copyFile = async (from: string, to: string, r: string, size: number) => {
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (SQLITE_EXT.test(from) && isSqlite(from)) {
        try {
          vacuumCopy(from, to);
        } catch {
          await fs.promises.copyFile(from, to);
        }
      } else await fs.promises.copyFile(from, to);
      out.bytes += size;
      out.files++;
      onBytes(size);
    } catch (e: any) {
      out.skipped.push({ path: r, reason: e?.code || String(e?.message || e).slice(0, 80) });
    }
  };
  if (st.isSymbolicLink()) {
    out.skipped.push({ path: rel || path.basename(src), reason: 'link' });
    return out;
  }
  if (st.isFile()) {
    await copyFile(src, dest, rel || path.basename(src), st.size);
    return out;
  }
  if (!st.isDirectory()) return out;
  fs.mkdirSync(dest, { recursive: true });
  const stack: [string, string, string][] = [[src, dest, rel]];
  let n = 0;
  while (stack.length) {
    const [d, o, r] = stack.pop()!;
    let list: fs.Dirent[];
    try {
      list = fs.readdirSync(d, { withFileTypes: true });
    } catch (e: any) {
      out.skipped.push({ path: r || '.', reason: e?.code || 'niet leesbaar' });
      continue;
    }
    for (const e of list) {
      const f = path.join(d, e.name);
      const to = path.join(o, e.name);
      const rr = r ? `${r}/${e.name}` : e.name;
      if (e.isSymbolicLink()) {
        out.skipped.push({ path: rr, reason: 'link' });
        continue;
      }
      if (e.isDirectory()) {
        fs.mkdirSync(to, { recursive: true });
        stack.push([f, to, rr]);
      } else if (e.isFile()) {
        let size = 0;
        try {
          size = fs.lstatSync(f).size;
        } catch {
          /* gone meanwhile */
        }
        await copyFile(f, to, rr, size);
      }
      if (++n % 500 === 0) await new Promise((res) => setImmediate(res));
    }
  }
  return out;
}

// ---------------------------------------------------------------- restore

/** Written next to restore-pending.db by a full-backup restore; read by applyPendingFiles at the next start. */
export const PENDING_MARKER = 'restore-pending.json';
/** Left by applyPendingFiles for the backups module (index rebuild, notification) once the restore is in place. */
export const APPLIED_MARKER = 'restore-applied.json';

export interface PendingRestore {
  name: string;
  at: string;
  by?: string;
  reason?: 'restore' | 'rollback';
  /** TeamBot version that made the backup. */
  version?: string;
}

const setFiles = (backupFile: string) => backupFile.replace(/\.db$/, '.files');

/**
 * Put the data files of a staged full-backup restore in place. Called by core's applyPendingRestore right after the
 * database swap, before any module reads a file. Every part in the backup replaces the current one; the current one
 * is moved next to the safety copy of the database (`<safety>.files/`), so nothing is lost. Parts the backup does not
 * contain (work folders in a backup without them) stay as they are. Never throws: a start must never fail on this.
 */
export function applyPendingFiles(dataDir: string, safetyDb: string | null, log: (line: string) => void = () => {}): { parts: string[]; skipped: string[] } | null {
  const markerFile = path.join(dataDir, PENDING_MARKER);
  if (!fs.existsSync(markerFile)) return null;
  const done = { parts: [] as string[], skipped: [] as string[] };
  let marker: PendingRestore | null = null;
  try {
    marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  } catch {
    marker = null;
  }
  try {
    if (!marker?.name || !/^teambot-\d{8}-\d{6}(-[a-z]+)?$/.test(marker.name)) throw new Error('ongeldige markering');
    const src = path.join(dataDir, 'backups', `${marker.name}.files`);
    const keep = safetyDb ? setFiles(safetyDb) : path.join(dataDir, 'backups', `${marker.name}-vervangen.files`);
    if (fs.existsSync(src)) {
      for (const name of fs.readdirSync(src)) {
        if (!restorable(name)) {
          done.skipped.push(name);
          continue;
        }
        const from = path.join(src, name);
        const dest = path.join(dataDir, name);
        try {
          if (fs.existsSync(dest)) {
            fs.mkdirSync(keep, { recursive: true });
            const aside = path.join(keep, name);
            fs.rmSync(aside, { recursive: true, force: true });
            try {
              fs.renameSync(dest, aside);
            } catch {
              // Another volume or a locked entry: copy aside, then clear.
              fs.cpSync(dest, aside, { recursive: true, verbatimSymlinks: true });
              fs.rmSync(dest, { recursive: true, force: true });
            }
          }
          fs.cpSync(from, dest, { recursive: true, verbatimSymlinks: true });
          done.parts.push(name);
        } catch (e: any) {
          done.skipped.push(name);
          log(`[backup] terugzetten van ${name} mislukt: ${e?.message || e}`);
        }
      }
    }
    fs.writeFileSync(path.join(dataDir, APPLIED_MARKER), JSON.stringify({ ...marker, appliedAt: new Date().toISOString(), parts: done.parts, skipped: done.skipped, safety: safetyDb ? path.basename(safetyDb).replace(/\.db$/, '') : null }));
  } catch (e: any) {
    log(`[backup] bestanden terugzetten mislukt: ${e?.message || e}`);
  } finally {
    fs.rmSync(markerFile, { force: true });
  }
  return done;
}
