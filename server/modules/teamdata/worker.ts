import { Worker } from 'node:worker_threads';
import type { Logger } from '../../core/types.js';

/**
 * Every statement on a team database runs in one background worker thread, never on the main thread: a heavy query
 * a bot wrote (a big cross join, say) can then never freeze TeamBot (chats, routines, channels, the interface).
 *
 * Inside the worker each database file has two connections:
 *  - a read-only connection for team_query (SQLite itself refuses every write there);
 *  - a read-write connection for team_execute and TeamBot's own fixed statements.
 * Both carry an authorizer that checks what SQLite actually compiled: in "query" mode only reads; in "execute" mode
 * rows of any table and DDL on own tables; never PRAGMA, ATTACH, transactions, triggers, virtual tables, recursive
 * queries or file/extension functions. Plus hard limits (no attached databases, 1 MB per value, 256 MB per file).
 *
 * A statement that runs longer than its time limit is abandoned: its worker is left to finish on its own (SQLite cannot
 * be interrupted from outside) and a fresh worker takes over. With two such workers still busy, new statements are
 * refused for a moment instead of piling up.
 *
 * The worker code is a plain JavaScript string (no TypeScript, no imports) so it runs the same from source, from the
 * bundle and from the installer.
 */
export const WORKER_SOURCE = String.raw`
'use strict';
const { parentPort } = require('node:worker_threads');
const { DatabaseSync, constants: C } = require('node:sqlite');
const LIMITS = { length: 1000000, sqlLength: 120000, column: 200, exprDepth: 200, compoundSelect: 50, functionArg: 64, attach: 0, likePatternLength: 1000, variableNumber: 2500, triggerDepth: 10 };
const MAX_PAGES = 65536;
const DENY_FN = new Set(['load_extension', 'fts3_tokenizer', 'readfile', 'writefile', 'edit', 'fsdir', 'zipfile', 'sqlar_compress', 'sqlar_uncompress']);
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const OK = C.SQLITE_OK;
let mode = 'internal';
let st = null;
const conns = new Map();

function deny(reason) {
  if (st && !st.denied) st.denied = reason;
  return C.SQLITE_DENY;
}
function canChange(name) {
  return !!st && !!name && st.owners[name] !== undefined && st.owners[name] === st.actor;
}
function sysTable(name) {
  return String(name || '').toLowerCase().indexOf('sqlite_') === 0;
}
function authorize(action, a1, a2, dbName) {
  if (mode === 'internal') return OK;
  if (dbName && dbName !== 'main') return deny('Alleen de teamdatabase zelf is beschikbaar (geen tijdelijke of gekoppelde databases).');
  if (action === C.SQLITE_SELECT || action === C.SQLITE_READ) return OK;
  if (action === C.SQLITE_FUNCTION) {
    const f = String(a2 || '').toLowerCase();
    return DENY_FN.has(f) ? deny('De functie ' + f + ' is niet beschikbaar in de teamdatabase.') : OK;
  }
  if (action === C.SQLITE_RECURSIVE) return deny('Recursieve WITH-query' + "'" + 's zijn niet beschikbaar (ze kunnen eindeloos doorlopen). Gebruik een gewone query.');
  if (mode !== 'execute') return deny('Met team_query kun je alleen lezen; schrijven gaat met team_execute.');
  switch (action) {
    case C.SQLITE_INSERT:
    case C.SQLITE_UPDATE:
    case C.SQLITE_DELETE:
      if (sysTable(a1)) return st.ddl ? OK : deny('Systeemtabellen van SQLite kun je niet wijzigen.');
      st.written.add(String(a1));
      return OK;
    case C.SQLITE_CREATE_TABLE:
    case C.SQLITE_CREATE_VIEW: {
      const t = String(a1 || '');
      if (!NAME_RE.test(t) || sysTable(t) || t.toLowerCase().indexOf('_tb') === 0) return deny('Ongeldige naam "' + t + '": gebruik letters, cijfers en _ (max. 63 tekens), niet beginnend met sqlite_ of _tb.');
      return OK;
    }
    case C.SQLITE_CREATE_INDEX:
    case C.SQLITE_REINDEX:
      return OK;
    case C.SQLITE_DROP_TABLE:
    case C.SQLITE_DROP_VIEW:
      return canChange(a1) ? OK : deny(st.owners[a1] === 'system' ? 'De vaste tabel "' + a1 + '" kun je niet verwijderen.' : 'Alleen de bot die "' + a1 + '" maakte, kan hem verwijderen.');
    case C.SQLITE_DROP_INDEX:
      return canChange(a2) ? OK : deny('Alleen de bot die de tabel "' + a2 + '" maakte, kan zijn indexen verwijderen.');
    case C.SQLITE_ALTER_TABLE:
      return canChange(a2) ? OK : deny(st.owners[a2] === 'system' ? 'De vaste tabel "' + a2 + '" kun je niet aanpassen; maak eventueel een eigen tabel ernaast.' : 'Alleen de bot die "' + a2 + '" maakte, kan hem aanpassen.');
  }
  return deny('Dit soort opdracht is niet beschikbaar in de teamdatabase.');
}

function conn(file) {
  let c = conns.get(file);
  if (c) {
    c.used = Date.now();
    return c;
  }
  mode = 'internal';
  const rw = new DatabaseSync(file, { limits: LIMITS, timeout: 3000, allowExtension: false, enableForeignKeyConstraints: true });
  rw.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA trusted_schema=OFF; PRAGMA max_page_count=' + MAX_PAGES);
  if (typeof rw.enableDefensive === 'function') rw.enableDefensive(true);
  rw.setAuthorizer(authorize);
  const ro = new DatabaseSync(file, { readOnly: true, limits: LIMITS, timeout: 3000, allowExtension: false });
  ro.exec('PRAGMA trusted_schema=OFF');
  if (typeof ro.enableDefensive === 'function') ro.enableDefensive(true);
  ro.setAuthorizer(authorize);
  c = { rw, ro, used: Date.now() };
  conns.set(file, c);
  if (conns.size > 12) {
    let oldest = null;
    for (const [f, x] of conns) if (f !== file && (!oldest || x.used < oldest[1].used)) oldest = [f, x];
    if (oldest) closeFile(oldest[0]);
  }
  return c;
}
function closeFile(file) {
  const c = conns.get(file);
  if (!c) return;
  conns.delete(file);
  try { c.ro.close(); } catch (e) {}
  try { c.rw.close(); } catch (e) {}
}

function clean(row) {
  const out = {};
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (v instanceof Uint8Array) out[k] = '[binair, ' + v.length + ' bytes]';
    else if (typeof v === 'bigint') out[k] = (v <= Number.MAX_SAFE_INTEGER && v >= -Number.MAX_SAFE_INTEGER) ? Number(v) : String(v);
    else out[k] = v;
  }
  return out;
}
function size(row) {
  let n = 2;
  for (const k of Object.keys(row)) {
    const v = row[k];
    n += k.length + 4 + (typeof v === 'string' ? v.length : 12);
  }
  return n;
}
function args(p) {
  if (Array.isArray(p)) return p;
  if (p && typeof p === 'object') return [p];
  return [];
}

function runOne(m) {
  const c = conn(m.file);
  const db = m.mode === 'query' ? c.ro : c.rw;
  st = { actor: m.actor || '', owners: m.owners || {}, ddl: !!m.ddl, written: new Set(), denied: null };
  mode = m.mode === 'query' ? 'query' : 'execute';
  try {
    const stmt = db.prepare(m.sql);
    const cols = stmt.columns();
    if (cols.length) {
      const rows = [];
      let chars = 0;
      let truncated = false;
      for (const r of stmt.iterate.apply(stmt, args(m.params))) {
        if (rows.length >= m.maxRows) { truncated = true; break; }
        const x = clean(r);
        chars += size(x);
        rows.push(x);
        if (chars > m.maxChars) { truncated = true; break; }
      }
      return { columns: cols.map(function (x) { return x.name; }), rows: rows, truncated: truncated, changes: null, lastInsertRowid: null, written: Array.from(st.written) };
    }
    const r = stmt.run.apply(stmt, args(m.params));
    return { columns: [], rows: [], truncated: false, changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid), written: Array.from(st.written) };
  } catch (e) {
    if (st && st.denied) e.denied = st.denied;
    throw e;
  } finally {
    mode = 'internal';
    st = null;
  }
}

function internal(m) {
  const c = conn(m.file);
  mode = 'internal';
  const db = c.rw;
  const out = [];
  if (m.tx) db.exec('BEGIN IMMEDIATE');
  try {
    for (const s of m.steps) {
      try {
        if (s.exec) { db.exec(s.sql); out.push({}); continue; }
        const stmt = db.prepare(s.sql);
        if (stmt.columns().length) out.push({ rows: stmt.all.apply(stmt, args(s.params)).map(clean) });
        else {
          const r = stmt.run.apply(stmt, args(s.params));
          out.push({ changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) });
        }
      } catch (e) {
        if (!s.soft) throw e;
        out.push({ rows: [], error: String((e && e.message) || e) });
      }
    }
    if (m.tx) db.exec('COMMIT');
  } catch (e) {
    if (m.tx) { try { db.exec('ROLLBACK'); } catch (x) {} }
    throw e;
  }
  return out;
}

function tables(m) {
  const c = conn(m.file);
  mode = 'internal';
  const list = c.rw.prepare("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','view') AND substr(name, 1, 7) != 'sqlite_' ORDER BY name").all();
  for (const t of list) {
    t.rows = null;
    if (t.type !== 'table') continue;
    try { t.rows = Number(c.rw.prepare('SELECT COUNT(*) AS n FROM "' + String(t.name).replace(/"/g, '""') + '"').get().n); } catch (e) {}
  }
  return list;
}

function backup(m) {
  // VACUUM INTO attaches the destination internally, which the bots' connections forbid (attach limit 0).
  // The copy therefore uses its own short-lived read-only connection that bots never reach.
  conn(m.file); // make sure pending WAL writes of the bot connection exist on disk first
  const c = new DatabaseSync(m.file, { readOnly: true, timeout: 3000, allowExtension: false });
  try {
    c.exec("VACUUM INTO '" + String(m.dest).replace(/'/g, "''") + "'");
  } finally {
    c.close();
  }
  return { ok: true };
}

parentPort.on('message', function (m) {
  let res;
  try {
    let result;
    if (m.op === 'run') result = runOne(m);
    else if (m.op === 'internal') result = internal(m);
    else if (m.op === 'tables') result = tables(m);
    else if (m.op === 'backup') result = backup(m);
    else if (m.op === 'close') { closeFile(m.file); result = { ok: true }; }
    else if (m.op === 'ping') result = { ok: true };
    else throw new Error('Onbekende opdracht ' + m.op);
    res = { id: m.id, ok: true, result: result };
  } catch (e) {
    res = { id: m.id, ok: false, error: String((e && e.message) || e), code: (e && (e.errstr || e.code)) || '', denied: (e && e.denied) || null };
  }
  parentPort.postMessage(res);
});
`;

export class WorkerError extends Error {
  constructor(message: string, public code = '', public denied: string | null = null, public busy = false) {
    super(message);
  }
}

interface Pending {
  resolve(v: any): void;
  reject(e: any): void;
  timer: NodeJS.Timeout;
}
interface Slot {
  worker: Worker;
  pending: Map<number, Pending>;
}

/** Two abandoned (still busy) workers at most; after that new statements are refused until one finishes. */
const MAX_STUCK = 2;

export class SqlWorker {
  private slot: Slot | null = null;
  private seq = 0;
  private stuck = 0;
  private closed = false;

  constructor(private log: Logger) {}

  private spawn(): Slot {
    const worker = new Worker(WORKER_SOURCE, { eval: true, name: 'teambot-teamdata' });
    worker.unref();
    const slot: Slot = { worker, pending: new Map() };
    const failAll = (e: Error) => {
      for (const p of slot.pending.values()) {
        clearTimeout(p.timer);
        p.reject(e);
      }
      slot.pending.clear();
      if (this.slot === slot) this.slot = null;
    };
    worker.on('message', (m: any) => {
      const p = slot.pending.get(m.id);
      if (!p) return;
      slot.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.result);
      else p.reject(new WorkerError(m.error, m.code, m.denied));
    });
    worker.on('error', (e) => {
      this.log.error('[teamdata] worker', e);
      failAll(new WorkerError('De teamdatabase gaf een interne fout; probeer het opnieuw.'));
    });
    worker.on('exit', () => failAll(new WorkerError('De teamdatabase is opnieuw gestart; probeer het opnieuw.', '', null, true)));
    return slot;
  }

  /** Abandon the current worker (a statement ran too long): it finishes on its own, a fresh one takes over. */
  private abandon(slot: Slot, why: WorkerError) {
    if (this.slot === slot) this.slot = null;
    for (const p of slot.pending.values()) {
      clearTimeout(p.timer);
      p.reject(why);
    }
    slot.pending.clear();
    this.stuck++;
    slot.worker.removeAllListeners('exit');
    slot.worker.once('exit', () => (this.stuck = Math.max(0, this.stuck - 1)));
    slot.worker.terminate().catch(() => {});
  }

  call<T = any>(msg: Record<string, any>, timeoutMs = 10_000): Promise<T> {
    if (this.closed) return Promise.reject(new WorkerError('TeamBot sluit af.'));
    if (!this.slot) {
      if (this.stuck >= MAX_STUCK) return Promise.reject(new WorkerError('De teamdatabase is nog bezig met een te zware opdracht. Probeer het over een minuut opnieuw, met een kleinere vraag (WHERE of LIMIT).', 'busy', null, true));
      this.slot = this.spawn();
    }
    const slot = this.slot;
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.log.warn(`[teamdata] statement duurde langer dan ${timeoutMs} ms en is afgebroken`);
        this.abandon(slot, new WorkerError(`Deze opdracht duurde te lang (meer dan ${Math.round(timeoutMs / 1000)} s) en is afgebroken. Maak de vraag kleiner (WHERE, LIMIT of een index).`, 'timeout', null, true));
      }, timeoutMs);
      slot.pending.set(id, { resolve, reject, timer });
      slot.worker.postMessage({ ...msg, id });
    });
  }

  /** Workers that were abandoned after a time-out and are still finishing their statement. */
  get stuckCount() {
    return this.stuck;
  }

  async close() {
    this.closed = true;
    const s = this.slot;
    this.slot = null;
    if (s) {
      for (const p of s.pending.values()) clearTimeout(p.timer);
      s.worker.removeAllListeners('exit');
      await s.worker.terminate().catch(() => {});
    }
  }
}
