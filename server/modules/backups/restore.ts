import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { applyPendingFiles } from './files.js';

/**
 * Putting a backup back happens at the start, before the database is opened: a restore is staged (the chosen backup
 * is copied to `restore-pending.db`, service.ts) and swapped in here, so a running database is never overwritten.
 * Used by server/app.ts and the desktop shell; making, listing and choosing backups is all in service.ts.
 */

/** "20261109-214501": the moment in a backup's file name (local time). */
export function stamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Copy a database that may still have a write-ahead log next to it (TeamBot stopped hard: a crash, a power cut, ended
 * from Task Manager). Its latest changes are only in `-wal`, so a copy of the main file alone misses them; the WAL is
 * folded into the file first. When that fails, the WAL is copied along so nothing of it is lost.
 */
function copyWithWal(from: string, to: string) {
  if (fs.existsSync(from + '-wal')) {
    try {
      const d = new DatabaseSync(from);
      d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      d.close();
    } catch {
      /* unreadable: the WAL is copied along below */
    }
  }
  fs.copyFileSync(from, to);
  if (fs.existsSync(from + '-wal') && fs.statSync(from + '-wal').size > 0) fs.copyFileSync(from + '-wal', to + '-wal');
}

/** Call before opening the database: swaps in a staged restore and keeps the replaced DB as a safety copy. */
export function applyPendingRestore(dataDir: string): string | null {
  const pending = path.join(dataDir, 'restore-pending.db');
  if (!fs.existsSync(pending)) return null;
  const db = path.join(dataDir, 'teambot.db');
  // Keep every "forget" tombstone from the current database: what the user had forgotten must stay forgotten,
  // even when an older backup that still contains it is restored (re-applied by the memory module at start).
  // The same for "Geschiedenis wissen" of a bot or group (re-applied by the history module at start).
  if (fs.existsSync(db)) {
    for (const [table, where, file] of [
      ['memory_tombstones', "WHERE kind = 'forget'", 'restore-tombstones.json'],
      ['history_purges', '', 'restore-history.json'],
    ]) {
      try {
        const cur = new DatabaseSync(db, { readOnly: true });
        const has = cur.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
        const rows = has ? cur.prepare(`SELECT * FROM ${table} ${where}`).all() : [];
        cur.close();
        if (rows.length) fs.writeFileSync(path.join(dataDir, file), JSON.stringify(rows));
      } catch {
        /* unreadable current DB: nothing to carry over */
      }
    }
  }
  const safety = path.join(dataDir, 'backups', `teambot-${stamp()}-replaced.db`);
  fs.mkdirSync(path.dirname(safety), { recursive: true });
  if (fs.existsSync(db)) copyWithWal(db, safety);
  for (const ext of ['-wal', '-shm']) fs.rmSync(db + ext, { force: true });
  fs.renameSync(pending, db);
  // Team databases from the same backup (if it had them): current ones are kept as a safety copy.
  const pendingTeam = path.join(dataDir, 'restore-pending.teamdata');
  if (fs.existsSync(pendingTeam)) {
    const team = path.join(dataDir, 'teamdata');
    if (fs.existsSync(team)) {
      const keep = safety.replace(/\.db$/, '.teamdata');
      fs.mkdirSync(keep, { recursive: true });
      for (const f of fs.readdirSync(team).filter((x) => x.endsWith('.db'))) {
        copyWithWal(path.join(team, f), path.join(keep, f));
        for (const ext of ['', '-wal', '-shm']) fs.rmSync(path.join(team, f + ext), { force: true });
      }
    }
    fs.mkdirSync(team, { recursive: true });
    for (const f of fs.readdirSync(pendingTeam)) fs.renameSync(path.join(pendingTeam, f), path.join(team, f));
    fs.rmSync(pendingTeam, { recursive: true, force: true });
  }
  // The data files of a full app backup (server/modules/backups), before any module reads them.
  applyPendingFiles(dataDir, safety);
  return safety;
}
