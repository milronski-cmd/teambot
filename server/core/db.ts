import { DatabaseSync, type StatementSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { statSync } from 'node:fs';
import type { Migration } from './types.js';

export type DB = DatabaseSync;

export function openDb(file: string): DB {
  const db = new DatabaseSync(file);
  // secure_delete: deleted rows and freed pages are overwritten with zeros, so forgotten text does not linger in free space.
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL; PRAGMA secure_delete=ON;');
  return db;
}

/**
 * After deleting sensitive text (forgetting memory, "alles wissen"): make it physically gone, not only logically.
 * - FTS5 keeps a deleted document's tokens in old index segments until they are merged: `optimize` merges them.
 * - The WAL still holds the old page versions: a TRUNCATE checkpoint writes the new pages into the database and empties
 *   the WAL file (with secure_delete the freed bytes in the database are already zeros).
 * - `vacuum` (optional, only below `maxVacuumBytes`) rebuilds the file so no slack from before secure_delete remains.
 * Never throws: a busy database just keeps the text until the next checkpoint.
 */
export function purgeDeleted(db: DB, o: { fts?: string[]; vacuum?: boolean; file?: string; maxVacuumBytes?: number } = {}): { checkpointed: boolean; vacuumed: boolean } {
  for (const t of o.fts || []) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(t)) continue;
    try {
      db.exec(`INSERT INTO ${t}(${t}) VALUES('optimize')`);
    } catch {
      /* table missing (module off) */
    }
  }
  let vacuumed = false;
  if (o.vacuum) {
    let size = 0;
    try {
      size = o.file ? fsStatSize(o.file) : 0;
    } catch {
      /* unknown size */
    }
    if (size <= (o.maxVacuumBytes ?? 256 * 1024 * 1024)) {
      try {
        db.exec('VACUUM');
        vacuumed = true;
      } catch {
        /* inside a transaction or busy: secure_delete already zeroed the freed bytes */
      }
    }
  }
  let checkpointed = false;
  try {
    const r = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: number } | undefined;
    checkpointed = !r?.busy;
  } catch {
    /* not in WAL mode */
  }
  return { checkpointed, vacuumed };
}

const fsStatSize = (f: string) => statSync(f).size;

export const now = () => new Date().toISOString();
export const newId = (prefix = '') => prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 22);

/** Convert JS values into something node:sqlite accepts. */
export function sv(v: any): any {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v;
  if (v instanceof Uint8Array) return v;
  return JSON.stringify(v);
}

/** Prepared statements kept per database; some SQL text carries a number (LIMIT, seq), so the cache is bounded. */
const MAX_STATEMENTS = 300;
const statements = new WeakMap<DB, Map<string, StatementSync>>();

/**
 * The prepared statement for this SQL text, compiled once per database instead of on every call. Reuse is safe here:
 * every caller runs a statement to the end in one synchronous call (all/get/run, never iterate), which resets it and
 * clears its bindings, and SQLite recompiles a statement by itself after a schema change. The least recently used
 * statement goes first when the cache is full.
 */
function prepared(db: DB, sql: string): StatementSync {
  let cache = statements.get(db);
  if (!cache) statements.set(db, (cache = new Map()));
  let s = cache.get(sql);
  if (s) cache.delete(sql);
  else {
    s = db.prepare(sql);
    if (cache.size >= MAX_STATEMENTS) cache.delete(cache.keys().next().value!);
  }
  cache.set(sql, s);
  return s;
}

export function all<T = any>(db: DB, sql: string, ...params: any[]): T[] {
  return prepared(db, sql).all(...params.map(sv)) as T[];
}
export function get<T = any>(db: DB, sql: string, ...params: any[]): T | undefined {
  return prepared(db, sql).get(...params.map(sv)) as T | undefined;
}
export function run(db: DB, sql: string, ...params: any[]) {
  return prepared(db, sql).run(...params.map(sv));
}

/** Databases that are inside a transaction right now (per database: a second one gets its own transaction). */
const inTx = new WeakSet<DB>();
/** Run `fn` in one transaction; a call inside a transaction of the same database joins it. */
export function tx<T>(db: DB, fn: () => T): T {
  if (inTx.has(db)) return fn();
  inTx.add(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    inTx.delete(db);
  }
}

export function migrate(db: DB, migrations: Migration[]) {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set(all<{ id: string }>(db, 'SELECT id FROM _migrations').map((r) => r.id));
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    tx(db, () => {
      db.exec(m.sql);
      run(db, 'INSERT INTO _migrations (id, applied_at) VALUES (?, ?)', m.id, now());
    });
    // A migration may add a column to a table that was already used.
    columnsCache.delete(db);
  }
}

// ---------- Generic table helpers with JSON/bool column mapping ----------

interface TableSpec {
  json: Set<string>;
  bool: Set<string>;
}
const specs = new Map<string, TableSpec>();
/** The columns of each table, per database (two databases may have a table of the same name with other columns). */
const columnsCache = new WeakMap<DB, Map<string, Set<string>>>();

/** Register JSON and boolean columns so rows are decoded/encoded automatically. */
export function defineTable(table: string, opts: { json?: string[]; bool?: string[] }) {
  specs.set(table, { json: new Set(opts.json || []), bool: new Set(opts.bool || []) });
}

function columns(db: DB, table: string): Set<string> {
  let cache = columnsCache.get(db);
  if (!cache) columnsCache.set(db, (cache = new Map()));
  let c = cache.get(table);
  if (!c) {
    c = new Set(all<{ name: string }>(db, `PRAGMA table_info(${JSON.stringify(table)})`).map((r) => r.name));
    if (c.size === 0) throw new Error(`Unknown table ${table}`);
    cache.set(table, c);
  }
  return c;
}

export function decodeRow<T = any>(table: string, row: any): T {
  if (!row) return row;
  const s = specs.get(table);
  const out: any = { ...row };
  if (s) {
    for (const k of s.json) {
      if (k in out) {
        const v = out[k];
        if (typeof v === 'string') {
          try {
            out[k] = JSON.parse(v);
          } catch {
            /* keep raw */
          }
        }
      }
    }
    for (const k of s.bool) if (k in out) out[k] = !!out[k];
  }
  return out as T;
}

function encodeVal(table: string, k: string, v: any) {
  const s = specs.get(table);
  if (s?.json.has(k)) return v === undefined ? null : v === null ? null : JSON.stringify(v);
  return sv(v);
}

export function insert<T = any>(db: DB, table: string, obj: Record<string, any>): T {
  const cols = columns(db, table);
  const keys = Object.keys(obj).filter((k) => cols.has(k) && obj[k] !== undefined);
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  prepared(db, sql).run(...keys.map((k) => encodeVal(table, k, obj[k])));
  return obj as T;
}

export function update(db: DB, table: string, id: string | number, patch: Record<string, any>, idCol = 'id') {
  const cols = columns(db, table);
  const keys = Object.keys(patch).filter((k) => cols.has(k) && k !== idCol && patch[k] !== undefined);
  if (!keys.length) return;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE ${idCol} = ?`;
  prepared(db, sql).run(...keys.map((k) => encodeVal(table, k, patch[k])), id);
}

export function getById<T = any>(db: DB, table: string, id: string | number, idCol = 'id'): T | null {
  const row = prepared(db, `SELECT * FROM ${table} WHERE ${idCol} = ?`).get(id as any);
  return row ? decodeRow<T>(table, row) : null;
}

export function find<T = any>(db: DB, table: string, where: Record<string, any> = {}, opts: { order?: string; limit?: number } = {}): T[] {
  const keys = Object.keys(where).filter((k) => where[k] !== undefined);
  const clause = keys.length ? 'WHERE ' + keys.map((k) => (where[k] === null ? `${k} IS NULL` : `${k} = ?`)).join(' AND ') : '';
  const params = keys.filter((k) => where[k] !== null).map((k) => sv(where[k]));
  const sql = `SELECT * FROM ${table} ${clause} ${opts.order ? 'ORDER BY ' + opts.order : ''} ${opts.limit ? 'LIMIT ' + Number(opts.limit) : ''}`;
  return prepared(db, sql).all(...params).map((r) => decodeRow<T>(table, r));
}

export function remove(db: DB, table: string, id: string | number, idCol = 'id') {
  prepared(db, `DELETE FROM ${table} WHERE ${idCol} = ?`).run(id as any);
}
