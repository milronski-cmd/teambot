import fs from 'node:fs';
import path from 'node:path';
import type { Agent, Ctx, User } from '../../core/types.js';
import { HttpError, bad, notFound } from '../../core/http.js';
import { now } from '../../core/db.js';
import { redact } from '../../core/secrets.js';
import { SqlWorker, WorkerError } from './worker.js';
import { type Analysis, SqlRefused, analyse, friendlyError, normParams } from './sql.js';
import { OPEN_DECISION, STANDARD, STANDARD_TABLES, parseOptions } from './schema.js';

/**
 * Team data: one SQLite database per team (0.4, package B2), shared by the bots of that team. Bots read and write
 * their own team's database with team_query / team_execute (see tools.ts) and may only read (team_tables /
 * team_query with `team`) the database of another team they have meekijken or aansturen on; the owner sees the
 * important tables of every team in "Teamwerk" and answers decisions under "Wacht op jou". TeamBot's own database is
 * never reachable from here, and one team's database is a different file than another's (no ATTACH): a statement
 * can never reach across.
 *
 * Files: `<data>/teamdata/<user>.db` is the owner's original database (from before teams); it belongs to the team
 * that was the default team when teams first appeared (setting `teamdata.legacyTeam`). Every other team has
 * `<user>.<team>.db`. What TeamBot keeps about a database in its own (table owners, who asked which decision, the
 * change log, imported rows) carries the team id; '' = the original database while the owner has no team yet.
 */

export interface Actor {
  type: 'agent' | 'user' | 'system';
  id: string;
  name: string;
  threadId?: string | null;
  runId?: string | null;
}

export class TeamDataError extends Error {}

export const QUERY_MAX_ROWS = 500;
const QUERY_MAX_CHARS = 400_000;
const BOT_TIMEOUT_MS = 10_000;
const UI_TIMEOUT_MS = 15_000;
const AUDIT_KEEP = 20_000;
/** User setting: the team whose database is the original `<user>.db`. */
export const LEGACY_TEAM_KEY = 'teamdata.legacyTeam';
/** TeamBot's own tables about team databases (each has user_id + team_id). */
const META_TABLES = ['teamdata_tables', 'teamdata_origins', 'teamdata_audit', 'teamdata_imports', 'teamdata_import_tables'];

/** The team an import goes into: `{ teamId }` (or a team id), default the default team. */
type TeamOpt = string | null | undefined | { teamId?: string | null };
const teamOptId = (o: TeamOpt): string | null => (o && typeof o === 'object' ? o.teamId ?? null : o ?? null);

export interface RunResult {
  columns: string[];
  rows: Record<string, any>[];
  truncated: boolean;
  changes: number | null;
  lastInsertRowid: number | null;
  written: string[];
  analysis: Analysis;
  /** Tables created or removed by this statement (DDL). */
  created: string[];
  dropped: string[];
}

interface MetaRow {
  name: string;
  owner_type: 'system' | 'agent' | 'user';
  owner_id: string | null;
  owner_name: string;
  created_at: string;
}

const ownerKey = (a: Pick<Actor, 'type' | 'id'>) => (a.type === 'system' ? 'system' : `${a.type}:${a.id}`);
const metaKey = (m: MetaRow) => (m.owner_type === 'system' ? 'system' : `${m.owner_type}:${m.owner_id}`);
const safe = (s: string) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');

/** Name comparison for bot names written into tables by bots ("Baas", " SEO & Content"). */
export function nameKey(s: unknown): string {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** LIKE pattern for a search term (escaped with \). */
const like = (term: string) => `%${term.replace(/[\\%_]/g, (c) => '\\' + c)}%`;

/** AND of search terms, each matching any of the given columns. Only placeholders are generated. */
function search(cols: string[], q: string): { sql: string; params: string[] } {
  const terms = String(q || '')
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 8);
  if (!terms.length) return { sql: '1', params: [] };
  const params: string[] = [];
  const parts = terms.map((t) => {
    const p = like(t.slice(0, 100));
    return '(' + cols.map((c) => (params.push(p), `COALESCE(${c}, '') LIKE ? ESCAPE '\\'`)).join(' OR ') + ')';
  });
  return { sql: parts.join(' AND '), params };
}

/** Add up counts per status of several team databases. */
function addCounts(into: Record<string, number>, from: Record<string, number>) {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] || 0) + v;
  return into;
}

export class TeamData {
  /** Tables are stored per team (0.4, B2): importers pass `{ teamId }` to importTables / undoImport. */
  readonly perTeam = true;
  private ready = new Map<string, Promise<void>>();
  private legacy = new Map<string, string>();
  private audits = 0;

  constructor(private ctx: Ctx, readonly worker: SqlWorker, readonly dir: string) {}

  // ------------------------------------------------------------------ teams (module teams)

  private get teams(): any {
    return this.ctx.services.teams;
  }

  /**
   * The team a view or statement is about, as the key of its database: the given team (one of the owner's), else the
   * default team. '' while the owner has no team yet: the original database, which becomes the default team's as
   * soon as that team exists.
   */
  teamKey(userId: string, teamId?: string | null): string {
    const svc = this.teams;
    if (!svc?.team) return '';
    let id = '';
    if (teamId && teamId !== 'all') {
      const t = svc.team(teamId);
      if (!t || t.user_id !== userId) throw notFound('Team niet gevonden');
      id = t.id;
    } else id = svc.defaultTeam(userId)?.id || '';
    if (id) this.legacyTeam(userId);
    return id;
  }

  /** Every team database of the owner ('' = only the original one, before teams). */
  teamKeys(userId: string): string[] {
    const list: { id: string }[] = this.teams?.list?.(userId) || [];
    if (!list.length) return [''];
    this.legacyTeam(userId);
    return list.map((t) => t.id);
  }

  teamName(tk: string): string {
    return (tk && this.teams?.team?.(tk)?.name) || '';
  }

  /**
   * The team that owns the original database `<user>.db` (from before teams): the default team at the moment the
   * owner first had one. Remembered, so it never moves when teams are reordered or added later. What TeamBot kept
   * about that database until then (team id '') is filed under that team too.
   */
  legacyTeam(userId: string): string | null {
    const hit = this.legacy.get(userId);
    if (hit) return hit;
    let id = this.ctx.store.getSetting<string | null>(userId, LEGACY_TEAM_KEY, null);
    if (!id) {
      const def = this.teams?.defaultTeam?.(userId);
      if (!def) return null;
      const tid = def.id as string;
      this.ctx.store.tx(() => {
        this.ctx.store.setSetting(userId, LEGACY_TEAM_KEY, tid);
        for (const t of META_TABLES) this.ctx.store.exec(`UPDATE ${t} SET team_id = ? WHERE user_id = ? AND team_id = ''`, tid, userId);
      });
      id = tid;
    }
    this.legacy.set(userId, id);
    return id;
  }

  private fileOf(userId: string, tk: string) {
    return path.join(this.dir, !tk || tk === this.legacyTeam(userId) ? `${safe(userId)}.db` : `${safe(userId)}.${safe(tk)}.db`);
  }

  /** The database file of a team (default: the owner's default team). */
  file(userId: string, teamId?: string | null) {
    return this.fileOf(userId, this.teamKey(userId, teamId));
  }

  /**
   * Teams whose database a bot may read besides its own (meekijken or aansturen), in order. Empty with one team or
   * without access: then nothing about other teams shows in its prompt or tools.
   */
  otherReadable(agentId: string): { id: string; name: string }[] {
    const svc = this.teams;
    if (!svc?.readableTeams) return [];
    const [, ...rest] = svc.readableTeams(agentId) as string[];
    return rest.map((id) => ({ id, name: svc.team(id)?.name || '' }));
  }

  /**
   * The team a bot names in a tool call (`team`: name or id), among the teams it may read; null = its own team.
   * Unknown teams and teams without access get the same answer (the bot learns nothing about teams it cannot see).
   */
  teamForBot(agent: Pick<Agent, 'id' | 'name'>, raw: unknown): string | null {
    const v = String(raw ?? '').trim();
    const svc = this.teams;
    if (!v || !svc?.readableTeams) return null;
    const ids: string[] = svc.readableTeams(agent.id);
    const k = nameKey(v);
    const hit = ids.find((id) => id === v || (k && nameKey(svc.team(id)?.name) === k));
    if (hit) return hit === ids[0] ? null : hit;
    const others = ids.slice(1).map((id) => `“${svc.team(id)?.name}”`);
    throw new TeamDataError(
      `Geen team “${v.slice(0, 60)}” waarvan ${agent.name} de teamdatabase mag lezen. ${others.length ? `Behalve je eigen team kun je meekijken bij: ${others.join(', ')}.` : 'Je kunt alleen de teamdatabase van je eigen team gebruiken (laat team leeg).'}`,
    );
  }

  /**
   * The team database a statement runs on, and whether this actor may: a bot reads its own team and the teams it may
   * look into (meekijken, aansturen), and writes only in its own team. The owner and TeamBot itself reach every team.
   */
  scope(userId: string, actor: Actor, teamId: string | null | undefined, need: 'read' | 'write'): string {
    const svc = this.teams;
    if (actor.type !== 'agent' || !svc?.teamOf) return this.teamKey(userId, teamId);
    const home: string | null = svc.teamOf(actor.id);
    if (!teamId) return home ?? this.teamKey(userId);
    const tk = this.teamKey(userId, teamId);
    if (home && tk === home) return tk;
    if (home && (need === 'read' ? svc.canRead(actor.id, tk) : svc.canWrite(actor.id, tk))) return tk;
    const name = this.teamName(tk) || 'een ander team';
    if (home && svc.canRead(actor.id, tk))
      throw new TeamDataError(`Geweigerd door TeamBot: in de teamdatabase van team “${name}” mag ${actor.name} alleen meekijken (lezen), niet schrijven. Schrijf in de teamdatabase van je eigen team, of vraag een bot van “${name}” om het te doen.`);
    throw new TeamDataError(`Geweigerd door TeamBot: ${actor.name} heeft geen toegang tot de teamdatabase van team “${name}”.`);
  }

  /** Create the database with the standard tables on first use (idempotent). */
  ensure(userId: string, teamId?: string | null): Promise<void> {
    return this.ensureKey(userId, this.teamKey(userId, teamId));
  }

  private ensureKey(userId: string, tk: string): Promise<void> {
    const file = this.fileOf(userId, tk);
    let p = this.ready.get(file);
    if (!p) {
      p = this.init(userId, tk).catch((e) => {
        this.ready.delete(file);
        throw e;
      });
      this.ready.set(file, p);
    }
    return p;
  }

  private async init(userId: string, tk: string) {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.fileOf(userId, tk);
    await this.worker.call({ op: 'internal', file, tx: true, steps: STANDARD_TABLES.map((t) => ({ exec: true, sql: t.ddl })) }, UI_TIMEOUT_MS);
    // Indexes are a nicety: a table that was imported with other columns must not block the rest.
    await this.worker.call({ op: 'internal', file, tx: false, steps: STANDARD_TABLES.flatMap((t) => t.indexes.map((sql) => ({ exec: true, sql, soft: true }))) }, UI_TIMEOUT_MS);
    // Columns added later (taken.klaar_als): only when missing, so an existing database is never touched twice.
    const upgrades = STANDARD_TABLES.flatMap((t) => (t.upgrades || []).map((sql) => ({ table: t.name, sql, column: sql.match(/ADD COLUMN\s+(\w+)/i)?.[1] || '' })));
    if (upgrades.length) {
      const cols = await this.worker.call<{ rows?: any[] }[]>({ op: 'internal', file, tx: false, steps: [...new Set(upgrades.map((u) => u.table))].map((tb) => ({ sql: `SELECT name, '${tb}' AS tbl FROM pragma_table_info('${tb}')`, soft: true })) }, UI_TIMEOUT_MS);
      const have = new Set(cols.flatMap((c) => (c?.rows || []).map((r: any) => `${r.tbl}.${r.name}`)));
      const todo = upgrades.filter((u) => u.column && !have.has(`${u.table}.${u.column}`));
      if (todo.length) await this.worker.call({ op: 'internal', file, tx: false, steps: todo.map((u) => ({ exec: true, sql: u.sql, soft: true })) }, UI_TIMEOUT_MS);
    }
    await this.reconcile(userId, tk, null);
  }

  // ------------------------------------------------------------------ ownership

  private meta(userId: string, tk: string): Map<string, MetaRow> {
    return new Map(this.ctx.store.all<MetaRow>('SELECT name, owner_type, owner_id, owner_name, created_at FROM teamdata_tables WHERE user_id = ? AND team_id = ?', userId, tk).map((m) => [m.name, m]));
  }

  /** Who may drop/alter which table: owner key per table (standard tables: "system"). */
  private owners(userId: string, tk: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [n, m] of this.meta(userId, tk)) out[n] = metaKey(m);
    return out;
  }

  /** Align the ownership list with the tables that really exist. New tables belong to `actor` (or TeamBot). */
  private async reconcile(userId: string, tk: string, actor: Actor | null): Promise<{ created: string[]; dropped: string[] }> {
    const list = await this.worker.call<{ type: string; name: string }[]>({ op: 'tables', file: this.fileOf(userId, tk) }, UI_TIMEOUT_MS);
    const meta = this.meta(userId, tk);
    const names = new Set(list.map((t) => t.name));
    const created: string[] = [];
    const dropped: string[] = [];
    this.ctx.store.tx(() => {
      for (const t of list) {
        if (meta.has(t.name)) continue;
        const sys = STANDARD.has(t.name) || !actor || actor.type === 'system';
        this.ctx.store.exec(
          'INSERT OR IGNORE INTO teamdata_tables (user_id, team_id, name, owner_type, owner_id, owner_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          userId,
          tk,
          t.name,
          sys ? 'system' : actor!.type,
          sys ? null : actor!.id,
          sys ? 'TeamBot' : actor!.name,
          now(),
        );
        created.push(t.name);
      }
      for (const n of meta.keys()) {
        if (names.has(n)) continue;
        this.ctx.store.exec('DELETE FROM teamdata_tables WHERE user_id = ? AND team_id = ? AND name = ?', userId, tk, n);
        dropped.push(n);
      }
    });
    return { created, dropped };
  }

  /** Record (or change) who owns a table, e.g. for tables taken over from another app. */
  setOwner(userId: string, name: string, owner: Actor, teamId?: string | null) {
    this.ctx.store.exec(
      'INSERT INTO teamdata_tables (user_id, team_id, name, owner_type, owner_id, owner_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, team_id, name) DO UPDATE SET owner_type = excluded.owner_type, owner_id = excluded.owner_id, owner_name = excluded.owner_name',
      userId,
      this.teamKey(userId, teamId),
      name,
      owner.type,
      owner.type === 'system' ? null : owner.id,
      owner.name,
      now(),
    );
  }

  private ownerView(userId: string, m: MetaRow | undefined) {
    if (!m) return { type: 'system' as const, id: null, name: 'TeamBot' };
    if (m.owner_type === 'agent') {
      const a = this.ctx.store.agent(m.owner_id);
      return { type: 'agent' as const, id: m.owner_id, name: a && a.user_id === userId ? a.name : m.owner_name };
    }
    return { type: m.owner_type, id: m.owner_id, name: m.owner_name };
  }

  // ------------------------------------------------------------------ tables

  async tables(userId: string, teamId?: string | null) {
    return this.tablesIn(userId, this.teamKey(userId, teamId));
  }

  private async tablesIn(userId: string, tk: string) {
    await this.ensureKey(userId, tk);
    const list = await this.worker.call<{ type: 'table' | 'view'; name: string; sql: string; rows: number | null }[]>({ op: 'tables', file: this.fileOf(userId, tk) }, UI_TIMEOUT_MS);
    const meta = this.meta(userId, tk);
    const std = new Map(STANDARD_TABLES.map((t) => [t.name, t]));
    return list
      .map((t) => ({
        name: t.name,
        type: t.type,
        sql: t.sql,
        rows: t.rows,
        standard: std.has(t.name),
        label: std.get(t.name)?.label || t.name,
        about: std.get(t.name)?.about || '',
        owner: this.ownerView(userId, meta.get(t.name)),
      }))
      .sort((a, b) => Number(b.standard) - Number(a.standard) || (a.standard ? STANDARD_TABLES.findIndex((x) => x.name === a.name) - STANDARD_TABLES.findIndex((x) => x.name === b.name) : a.name.localeCompare(b.name)));
  }

  // ------------------------------------------------------------------ bot statements

  /**
   * Run one statement for a bot (or the owner). `mode` is the tool that was used: query only reads; execute writes
   * (and also answers a SELECT, so a bot that picks the "wrong" tool for a read still gets its rows). `teamId`: the
   * team database (default: a bot's own team, the owner's default team); a bot only reads another team it may look
   * into, and never writes there.
   */
  async run(userId: string, actor: Actor, sql: string, params: any, mode: 'query' | 'execute', teamId?: string | null): Promise<RunResult> {
    let a: Analysis;
    let p: any[] | Record<string, any>;
    try {
      a = analyse(sql);
      p = normParams(params);
    } catch (e: any) {
      if (e instanceof SqlRefused) throw new TeamDataError(e.message);
      throw e;
    }
    if (mode === 'query' && a.kind !== 'read') throw new TeamDataError(`team_query is alleen om te lezen (SELECT). Gebruik team_execute voor ${a.verb}.`);
    let tk: string;
    try {
      tk = this.scope(userId, actor, teamId, a.kind === 'read' ? 'read' : 'write');
    } catch (e) {
      // A refused write into another team stays visible in the bot's own team log.
      if (a.kind !== 'read' && e instanceof TeamDataError && actor.type === 'agent') this.audit(userId, this.teams?.teamOf?.(actor.id) ?? this.teamKey(userId), actor, a, sql, p, null, e.message);
      throw e;
    }
    return this.runIn(userId, tk, actor, sql, p, a);
  }

  private async runIn(userId: string, tk: string, actor: Actor, sql: string, p: any[] | Record<string, any>, a: Analysis): Promise<RunResult> {
    await this.ensureKey(userId, tk);
    const run = a.kind === 'read' ? 'query' : 'execute';
    try {
      const r = await this.worker.call<Omit<RunResult, 'analysis' | 'created' | 'dropped'>>(
        { op: 'run', file: this.fileOf(userId, tk), mode: run, sql, params: p, maxRows: QUERY_MAX_ROWS, maxChars: QUERY_MAX_CHARS, actor: ownerKey(actor), owners: this.owners(userId, tk), ddl: a.kind === 'ddl' },
        BOT_TIMEOUT_MS,
      );
      const written = r.written.filter((t) => !/^sqlite_/i.test(t));
      let created: string[] = [];
      let dropped: string[] = [];
      if (run === 'execute') {
        if (a.kind === 'ddl') ({ created, dropped } = await this.reconcile(userId, tk, actor));
        const out: RunResult = { ...r, written, analysis: a, created, dropped };
        // Awaited (never failing the statement): when the tool answers, the owner already got the decision.
        await this.afterWrite(userId, tk, actor, out, sql, p).catch((e) => this.ctx.log.error('[teamdata] after write', e));
        return out;
      }
      return { ...r, written, analysis: a, created, dropped };
    } catch (e: any) {
      const msg = e instanceof WorkerError ? friendlyError(e.message, e.denied) : friendlyError(String(e?.message || e));
      if (run === 'execute') this.audit(userId, tk, actor, a, sql, p, null, msg);
      throw new TeamDataError(msg);
    }
  }

  private async afterWrite(userId: string, tk: string, actor: Actor, r: RunResult, sql: string, params: any) {
    this.audit(userId, tk, actor, r.analysis, sql, params, r, null);
    if (r.analysis.kind === 'ddl') this.ctx.audit(userId, 'teamdata.schema', { by: actor.name, verb: r.analysis.verb, object: r.analysis.object, table: r.analysis.table, created: r.created, dropped: r.dropped, ...(tk ? { teamId: tk } : {}) }, actor.type === 'agent' ? actor.id : null);
    const tables = [...new Set([...r.written, ...r.created, ...r.dropped, ...(r.analysis.kind === 'ddl' && r.analysis.table ? [r.analysis.table] : [])])];
    if (tables.length) this.changed(userId, tables, actor, tk);
    // New decisions for the owner: remember which bot asked (it is woken with the answer) and notify the owner.
    if (actor.type === 'agent' && (r.analysis.verb === 'INSERT' || r.analysis.verb === 'REPLACE') && r.written.includes('beslissingen') && (r.changes || 0) > 0 && (r.lastInsertRowid || 0) > 0) {
      const last = r.lastInsertRowid!;
      const first = Math.max(1, last - (r.changes || 1) + 1);
      const ids: number[] = [];
      for (let id = first; id <= last && ids.length < 50; id++) ids.push(id);
      this.ctx.store.tx(() => {
        for (const id of ids)
          this.ctx.store.exec(
            'INSERT INTO teamdata_origins (user_id, team_id, tbl, row_id, agent_id, thread_id, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, team_id, tbl, row_id) DO UPDATE SET agent_id = excluded.agent_id, thread_id = excluded.thread_id, run_id = excluded.run_id, created_at = excluded.created_at',
            userId,
            tk,
            'beslissingen',
            id,
            actor.id,
            actor.threadId ?? null,
            actor.runId ?? null,
            now(),
          );
      });
      const rows = await this.rowsIn(userId, tk, `SELECT id, vraag, status FROM beslissingen WHERE id BETWEEN ? AND ? AND status = '${OPEN_DECISION}' ORDER BY id`, [first, last]);
      if (rows.length) {
        this.ctx.events.emit(userId, 'notification', {
          title: rows.length === 1 ? `${actor.name} vraagt je om een beslissing` : `${actor.name} vraagt je om ${rows.length} beslissingen`,
          body: String(rows[0].vraag || '').slice(0, 200),
          link: '#/inbox',
          kind: 'decision',
        });
      }
    }
  }

  private changed(userId: string, tables: string[], actor: Actor | null, tk = '') {
    this.ctx.events.emit(userId, 'teamdata.changed', { tables, by: actor?.name || null, teamId: tk || null });
  }

  private audit(userId: string, tk: string, actor: Actor, a: Analysis, sql: string, params: any, r: RunResult | null, error: string | null) {
    try {
      this.ctx.store.exec(
        'INSERT INTO teamdata_audit (user_id, team_id, actor_type, actor_id, actor_name, thread_id, run_id, verb, table_name, sql, params, changes, row_id, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        userId,
        tk,
        actor.type,
        actor.type === 'system' ? null : actor.id,
        actor.name,
        actor.threadId ?? null,
        actor.runId ?? null,
        a.verb + (a.object ? ` ${a.object}` : ''),
        a.table ?? r?.written[0] ?? null,
        redact(sql.slice(0, 4000)),
        redact(JSON.stringify(params ?? []).slice(0, 2000)),
        r?.changes ?? null,
        r?.lastInsertRowid ?? null,
        error,
        now(),
      );
      if (++this.audits % 200 === 0) {
        const cut = this.ctx.store.one<{ id: number }>('SELECT id FROM teamdata_audit WHERE user_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?', userId, AUDIT_KEEP);
        if (cut) this.ctx.store.exec('DELETE FROM teamdata_audit WHERE user_id = ? AND id <= ?', userId, cut.id);
      }
    } catch (e) {
      this.ctx.log.error('[teamdata] audit', e);
    }
  }

  /** A write a bot was refused before it ran (another team's database): in the change log of its own team. */
  noteRefused(userId: string, actor: Actor, sql: string, params: any, reason: string) {
    let a: Analysis;
    try {
      a = analyse(sql);
    } catch {
      return;
    }
    if (a.kind === 'read' || actor.type !== 'agent') return;
    this.audit(userId, this.teams?.teamOf?.(actor.id) ?? this.teamKey(userId), actor, a, sql, params ?? [], null, reason);
  }

  /** The change log of one team database (default: the default team). */
  auditLog(userId: string, limit = 100, teamId?: string | null) {
    return this.ctx.store.all(
      'SELECT id, actor_type, actor_id, actor_name, verb, table_name, sql, changes, row_id, error, created_at FROM teamdata_audit WHERE user_id = ? AND team_id = ? ORDER BY id DESC LIMIT ?',
      userId,
      this.teamKey(userId, teamId),
      Math.min(500, Math.max(1, limit)),
    );
  }

  // ------------------------------------------------------------------ fixed statements (interface, import)

  /** Rows of one fixed statement (TeamBot's own SQL with placeholders; never bot input as SQL). */
  async rows(userId: string, sql: string, params: any[] = [], soft = false, teamId?: string | null): Promise<any[]> {
    return this.rowsIn(userId, this.teamKey(userId, teamId), sql, params, soft);
  }

  private async rowsIn(userId: string, tk: string, sql: string, params: any[] = [], soft = false): Promise<any[]> {
    await this.ensureKey(userId, tk);
    const [r] = await this.worker.call<{ rows?: any[]; error?: string }[]>({ op: 'internal', file: this.fileOf(userId, tk), tx: false, steps: [{ sql, params, soft }] }, UI_TIMEOUT_MS);
    return r?.rows || [];
  }

  async write(userId: string, steps: { sql: string; params?: any[] }[], teamId?: string | null): Promise<{ changes?: number; lastInsertRowid?: number }[]> {
    return this.writeIn(userId, this.teamKey(userId, teamId), steps);
  }

  private async writeIn(userId: string, tk: string, steps: { sql: string; params?: any[] }[]): Promise<{ changes?: number; lastInsertRowid?: number }[]> {
    await this.ensureKey(userId, tk);
    return this.worker.call({ op: 'internal', file: this.fileOf(userId, tk), tx: true, steps }, UI_TIMEOUT_MS);
  }

  /**
   * Take over tables from another app (e.g. OpenBot's shared agent-data.db). Idempotent per source row: a row that
   * was imported before is skipped, so importing again only adds what is new. Original ids are kept where they are
   * still free (bots refer to "kaart 34" or "taak 56"); a taken id gets a new one. Tables that do not exist yet are
   * created with their original CREATE statement (checked like a bot's), owned by `ownerOf(table)`. `team`:
   * `{ teamId }`, the team database to fill (default: the default team). `undoImport` takes it back.
   */
  async importTables(
    userId: string,
    source: string,
    tables: { name: string; sql: string; rows: Record<string, any>[] }[],
    ownerOf: (table: string) => Actor,
    team?: TeamOpt,
  ): Promise<{ name: string; created: boolean; inserted: number; skipped: number; renumbered: number; error?: string }[]> {
    const tk = this.teamKey(userId, teamOptId(team));
    await this.ensureKey(userId, tk);
    const out: { name: string; created: boolean; inserted: number; skipped: number; renumbered: number; error?: string }[] = [];
    const existing = new Set((await this.tablesIn(userId, tk)).map((t) => t.name));
    for (const t of tables) {
      const res = { name: t.name, created: false, inserted: 0, skipped: 0, renumbered: 0 } as (typeof out)[number];
      out.push(res);
      try {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(t.name) || /^sqlite_/i.test(t.name)) throw new Error('ongeldige tabelnaam');
        if (!existing.has(t.name)) {
          const a = analyse(t.sql);
          if (a.verb !== 'CREATE' || a.object !== 'TABLE' || a.table !== t.name) throw new Error('onbekende tabeldefinitie');
          await this.runIn(userId, tk, ownerOf(t.name), t.sql, [], a);
          existing.add(t.name);
          res.created = true;
          this.ctx.store.exec('INSERT OR IGNORE INTO teamdata_import_tables (user_id, team_id, source, tbl, created_at) VALUES (?, ?, ?, ?, ?)', userId, tk, source, t.name, now());
        }
        const q = `"${t.name.replace(/"/g, '""')}"`;
        const cols = new Set((await this.rowsIn(userId, tk, 'SELECT name FROM pragma_table_info(?)', [t.name])).map((r) => String(r.name)));
        const hasId = cols.has('id');
        const taken = new Set(hasId ? (await this.rowsIn(userId, tk, `SELECT id FROM ${q}`)).map((r) => String(r.id)) : []);
        const done = new Set(this.ctx.store.all<{ source_id: string }>('SELECT source_id FROM teamdata_imports WHERE user_id = ? AND team_id = ? AND source = ? AND tbl = ?', userId, tk, source, t.name).map((r) => r.source_id));
        // Rows that keep their id go first, so a renumbered row (next free id) never takes an id a later row needs.
        const todo: { key: string; sql: string; params: any[]; keep: boolean }[] = [];
        for (const row of t.rows) {
          const key = String(row.id ?? row.__rowid ?? '');
          if (!key || done.has(key)) {
            res.skipped++;
            continue;
          }
          const keepId = hasId && row.id !== null && row.id !== undefined && !taken.has(String(row.id));
          if (hasId && !keepId) res.renumbered++;
          const names = Object.keys(row).filter((c) => c !== '__rowid' && cols.has(c) && (c !== 'id' || keepId));
          if (keepId) taken.add(String(row.id));
          todo.push({ key, keep: keepId || !hasId, sql: `INSERT OR IGNORE INTO ${q} (${names.map((c) => `"${c.replace(/"/g, '""')}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, params: names.map((c) => (row[c] instanceof Uint8Array ? null : row[c])) });
        }
        todo.sort((a, b) => Number(b.keep) - Number(a.keep));
        for (let i = 0; i < todo.length; i += 500) {
          const batch = todo.slice(i, i + 500);
          const r = await this.writeIn(userId, tk, batch.map((x) => ({ sql: x.sql, params: x.params })));
          this.ctx.store.tx(() => {
            batch.forEach((x, k) => {
              const ok = (r[k]?.changes || 0) > 0;
              if (ok) res.inserted++;
              else res.skipped++;
              this.ctx.store.exec('INSERT OR IGNORE INTO teamdata_imports (user_id, team_id, source, tbl, source_id, row_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', userId, tk, source, t.name, x.key, ok ? r[k].lastInsertRowid ?? null : null, now());
            });
          });
        }
        if (res.inserted) this.audit(userId, tk, { type: 'system', id: '', name: `Import ${source}` }, { kind: 'write', verb: 'INSERT', object: null, table: t.name, allRows: false }, `IMPORT ${source} → ${t.name}`, [], { written: [t.name], changes: res.inserted } as any, null);
      } catch (e: any) {
        res.error = e instanceof TeamDataError ? e.message : e?.message || String(e);
      }
    }
    const changed = out.filter((x) => x.inserted || x.created).map((x) => x.name);
    if (changed.length) this.changed(userId, changed, null, tk);
    return out;
  }

  /** How many rows of each table were taken over from `source` before (into one team: default the default team). */
  importedCounts(userId: string, source: string, team?: TeamOpt): Record<string, number> {
    return Object.fromEntries(
      this.ctx.store.all<{ tbl: string; n: number }>('SELECT tbl, COUNT(*) AS n FROM teamdata_imports WHERE user_id = ? AND team_id = ? AND source = ? GROUP BY tbl', userId, this.teamKey(userId, teamOptId(team)), source).map((r) => [r.tbl, r.n]),
    );
  }

  /**
   * Take an import back: remove exactly the rows `importTables` added from `source` into one team (`teamdata_imports`
   * says which; rows that were already there, or that bots added since, stay), and drop a table the import created
   * once it is empty (a table a bot has written rows into since stays, with those rows). `tables`: only these
   * (default: every table of that import). Afterwards importing again adds the rows anew.
   */
  async undoImport(userId: string, source: string, o: { tables?: string[]; teamId?: string | null } = {}): Promise<{ name: string; removed: number; dropped: boolean; error?: string }[]> {
    const tk = this.teamKey(userId, o.teamId);
    await this.ensureKey(userId, tk);
    const known = this.ctx.store.all<{ tbl: string }>('SELECT DISTINCT tbl FROM teamdata_imports WHERE user_id = ? AND team_id = ? AND source = ? UNION SELECT tbl FROM teamdata_import_tables WHERE user_id = ? AND team_id = ? AND source = ?', userId, tk, source, userId, tk, source).map((r) => r.tbl);
    const want = o.tables?.length ? known.filter((n) => o.tables!.includes(n)) : known;
    const created = new Set(this.ctx.store.all<{ tbl: string }>('SELECT tbl FROM teamdata_import_tables WHERE user_id = ? AND team_id = ? AND source = ?', userId, tk, source).map((r) => r.tbl));
    const actor: Actor = { type: 'system', id: '', name: `Import ${source}` };
    const out: { name: string; removed: number; dropped: boolean; error?: string }[] = [];
    for (const name of want) {
      const res = { name, removed: 0, dropped: false } as (typeof out)[number];
      out.push(res);
      try {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name) || /^sqlite_/i.test(name)) throw new Error('ongeldige tabelnaam');
        const q = `"${name.replace(/"/g, '""')}"`;
        const exists = (await this.rowsIn(userId, tk, "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", [name])).length > 0;
        const ids = this.ctx.store.all<{ row_id: number | null }>('SELECT row_id FROM teamdata_imports WHERE user_id = ? AND team_id = ? AND source = ? AND tbl = ? AND row_id IS NOT NULL', userId, tk, source, name).map((r) => Number(r.row_id));
        if (exists && ids.length) {
          for (let i = 0; i < ids.length; i += 500) {
            const batch = ids.slice(i, i + 500);
            const r = await this.writeIn(userId, tk, batch.map((id) => ({ sql: `DELETE FROM ${q} WHERE rowid = ?`, params: [id] })));
            res.removed += r.reduce((n, x) => n + (x?.changes || 0), 0);
          }
        }
        this.ctx.store.tx(() => {
          this.ctx.store.exec('DELETE FROM teamdata_imports WHERE user_id = ? AND team_id = ? AND source = ? AND tbl = ?', userId, tk, source, name);
        });
        if (res.removed) this.audit(userId, tk, actor, { kind: 'write', verb: 'DELETE', object: null, table: name, allRows: false }, `UNDO IMPORT ${source} → ${name}`, [], { written: [name], changes: res.removed } as any, null);
        // A table the import made goes again once nothing is left in it (never a standard table).
        if (created.has(name) && !STANDARD.has(name)) {
          const left = exists ? Number((await this.rowsIn(userId, tk, `SELECT COUNT(*) AS n FROM ${q}`))[0]?.n) || 0 : 0;
          if (!left) {
            if (exists) await this.writeIn(userId, tk, [{ sql: `DROP TABLE IF EXISTS ${q}` }]);
            this.ctx.store.exec('DELETE FROM teamdata_import_tables WHERE user_id = ? AND team_id = ? AND source = ? AND tbl = ?', userId, tk, source, name);
            res.dropped = exists;
            if (exists) this.audit(userId, tk, actor, { kind: 'ddl', verb: 'DROP', object: 'TABLE', table: name, allRows: false }, `UNDO IMPORT ${source}: DROP TABLE ${name}`, [], null, null);
          }
        }
      } catch (e: any) {
        res.error = e instanceof TeamDataError ? e.message : e?.message || String(e);
      }
    }
    if (out.some((x) => x.dropped)) await this.reconcile(userId, tk, null);
    const changed = out.filter((x) => x.removed || x.dropped).map((x) => x.name);
    if (changed.length) {
      this.ctx.audit(userId, 'teamdata.import_undone', { source, tables: changed, ...(tk ? { teamId: tk } : {}) });
      this.changed(userId, changed, null, tk);
    }
    return out;
  }

  /** Daily copy of a team database (kept 7 days), next to TeamBot's own backups. */
  async backup(userId: string, teamId?: string | null) {
    return this.backupFile(this.file(userId, teamId));
  }

  async backupFile(file: string) {
    const dir = path.join(this.dir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const base = path.basename(file, '.db');
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const dest = path.join(dir, `${base}-${stamp}.db`);
    if (fs.existsSync(dest)) return null;
    await this.worker.call({ op: 'backup', file, dest }, 60_000);
    const mine = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(base + '-') && f.endsWith('.db'))
      .sort();
    for (const f of mine.slice(0, Math.max(0, mine.length - 7))) fs.rmSync(path.join(dir, f), { force: true });
    return dest;
  }

  // ------------------------------------------------------------------ owner views

  /** The databases a view covers: one team, or every team (`all`, also the default for summary and decisions). */
  private keysFor(userId: string, teamId: string | null | undefined): string[] {
    return !teamId || teamId === 'all' ? this.teamKeys(userId) : [this.teamKey(userId, teamId)];
  }

  /** Counts of one team, or of every team added up (`all`, the default: the badge counts every team). */
  async summary(userId: string, teamId?: string | null) {
    const parts = await Promise.all(this.keysFor(userId, teamId).map((tk) => this.summaryIn(userId, tk)));
    const out = parts.reduce((acc, s) => ({
      decisions: addCounts(acc.decisions, s.decisions),
      openDecisions: acc.openDecisions + s.openDecisions,
      tasks: addCounts(acc.tasks, s.tasks),
      waitingTasks: acc.waitingTasks + s.waitingTasks,
      experiments: addCounts(acc.experiments, s.experiments),
      unprocessedEvents: acc.unprocessedEvents + s.unprocessedEvents,
      logToday: acc.logToday + s.logToday,
    }));
    return out;
  }

  private async summaryIn(userId: string, tk: string) {
    await this.ensureKey(userId, tk);
    const [dec, tasks, exp, ev, log] = await this.worker.call<{ rows: any[] }[]>(
      {
        op: 'internal',
        file: this.fileOf(userId, tk),
        tx: false,
        steps: [
          { sql: 'SELECT status, COUNT(*) AS n FROM beslissingen GROUP BY status', soft: true },
          { sql: 'SELECT status, COUNT(*) AS n FROM taken GROUP BY status', soft: true },
          { sql: 'SELECT status, COUNT(*) AS n FROM experimenten GROUP BY status', soft: true },
          { sql: 'SELECT COUNT(*) AS n FROM gebeurtenissen WHERE verwerkt = 0', soft: true },
          { sql: "SELECT COUNT(*) AS n FROM logboek WHERE tijd >= date('now','localtime')", soft: true },
        ],
      },
      UI_TIMEOUT_MS,
    );
    const by = (rows: any[]) => Object.fromEntries(rows.map((r) => [String(r.status ?? ''), Number(r.n) || 0]));
    const t = by(tasks.rows);
    return {
      decisions: by(dec.rows),
      openDecisions: by(dec.rows)[OPEN_DECISION] || 0,
      tasks: t,
      waitingTasks: Object.entries(t)
        .filter(([s]) => s.startsWith('wacht_op'))
        .reduce((n, [, v]) => n + v, 0),
      experiments: by(exp.rows),
      unprocessedEvents: Number(ev.rows[0]?.n) || 0,
      logToday: Number(log.rows[0]?.n) || 0,
    };
  }

  // ---- decisions ----

  private agents(userId: string): Agent[] {
    return this.ctx.store.agents(userId).filter((a) => !a.archived);
  }

  /**
   * The bot that asked: the one named in gevraagd_door, else the one that wrote the row (when TeamBot saw it). Only
   * bots that may read this team's database qualify: an answer never carries a team's decision across the wall.
   */
  askerOf(userId: string, row: any, agents = this.agents(userId), tk = this.teamKey(userId)): Agent | null {
    const o = this.ctx.store.one<{ agent_id: string }>('SELECT agent_id FROM teamdata_origins WHERE user_id = ? AND team_id = ? AND tbl = ? AND row_id = ?', userId, tk, 'beslissingen', Number(row.id));
    const svc = this.teams;
    const pool = tk && svc?.canRead ? agents.filter((a) => svc.canRead(a.id, tk)) : agents;
    const byName = pool.find((a) => nameKey(a.name) === nameKey(row.gevraagd_door) && nameKey(a.name));
    if (byName) return byName;
    if (o) return pool.find((a) => a.id === o.agent_id) || null;
    return null;
  }

  decisionView(userId: string, row: any, agents = this.agents(userId), tk = this.teamKey(userId)) {
    const { id, vraag, uitleg, opties, gevraagd_door, status, antwoord, vervangt_id, aangemaakt, beslist, ...extra } = row;
    const asker = this.askerOf(userId, row, agents, tk);
    return {
      id: Number(id),
      vraag: String(vraag ?? ''),
      uitleg: uitleg == null ? '' : String(uitleg),
      opties: opties == null ? '' : String(opties),
      options: parseOptions(opties),
      gevraagd_door: gevraagd_door == null ? '' : String(gevraagd_door),
      asker: asker ? { id: asker.id, name: asker.name, avatar: asker.avatar } : null,
      status: String(status ?? ''),
      antwoord: antwoord == null ? '' : String(antwoord),
      vervangt_id: vervangt_id == null ? null : Number(vervangt_id),
      aangemaakt: aangemaakt == null ? '' : String(aangemaakt),
      beslist: beslist == null ? '' : String(beslist),
      /** The team whose database holds this decision (answer with this team id). */
      teamId: tk || null,
      teamName: this.teamName(tk),
      extra,
    };
  }

  /** Decisions of one team, or of every team (`all`, the default: "Wacht op jou" shows them all). */
  async decisions(userId: string, f: { status?: string; q?: string; limit?: number } = {}, teamId?: string | null) {
    const status = f.status === 'closed' || f.status === 'all' ? f.status : 'open';
    const s = search(['vraag', 'uitleg', 'opties', 'gevraagd_door', 'antwoord'], f.q || '');
    const filter = status === 'open' ? `status = '${OPEN_DECISION}'` : status === 'closed' ? `status != '${OPEN_DECISION}'` : '1';
    const limit = Math.min(1000, Math.max(1, Number(f.limit) || 500));
    const keys = this.keysFor(userId, teamId);
    const agents = this.agents(userId);
    const lists = await Promise.all(
      keys.map(async (tk) => (await this.rowsIn(userId, tk, `SELECT * FROM beslissingen WHERE ${filter} AND ${s.sql} ORDER BY CASE WHEN status = '${OPEN_DECISION}' THEN 0 ELSE 1 END, id DESC LIMIT ?`, [...s.params, limit])).map((r) => this.decisionView(userId, r, agents, tk))),
    );
    const all = lists.flat();
    if (keys.length > 1) all.sort((a, b) => Number(a.status !== OPEN_DECISION) - Number(b.status !== OPEN_DECISION) || b.aangemaakt.localeCompare(a.aangemaakt) || b.id - a.id);
    return all.slice(0, limit);
  }

  /**
   * The owner decides: one of the options (by index), an own answer, or "vervalt". Written back to the row (only
   * while it is still open, so two devices cannot both decide) and delivered to the asking bot as a message in its
   * own chat: sent at once when it is free, otherwise queued (and bundled with other answers that still wait).
   * `teamId`: the team whose database holds the decision (default: the default team).
   */
  async decide(u: Pick<User, 'id' | 'name'>, id: number, body: { choice?: number | null; answer?: string; note?: string; expire?: boolean }, teamId?: string | null) {
    if (!Number.isInteger(id) || id < 1) throw bad('Ongeldige beslissing.');
    const tk = this.teamKey(u.id, teamId);
    const [row] = await this.rowsIn(u.id, tk, 'SELECT * FROM beslissingen WHERE id = ?', [id]);
    if (!row) throw notFound('Deze beslissing bestaat niet (meer).');
    if (row.status !== OPEN_DECISION) throw new HttpError(409, `Deze beslissing is al afgehandeld (${row.status}${row.antwoord ? `: ${String(row.antwoord).slice(0, 120)}` : ''}).`);
    const note = String(body.note ?? '').trim().slice(0, 4000);
    const options = parseOptions(row.opties);
    let status = 'gekozen';
    let answer: string;
    if (body.expire) {
      status = 'vervallen';
      answer = note ? `Vervallen: ${note}` : `Vervallen (${u.name})`;
    } else if (body.choice !== undefined && body.choice !== null && body.choice !== ('' as any)) {
      const opt = options[Number(body.choice)];
      if (!opt) throw bad('Deze optie bestaat niet (meer). Vernieuw de pagina.');
      answer = opt.answer + (note ? ` — ${note}` : '');
    } else {
      const own = String(body.answer ?? '').trim().slice(0, 4000);
      if (!own) throw bad('Kies een optie of schrijf je antwoord.');
      answer = own + (note ? ` — ${note}` : '');
    }
    const [res] = await this.writeIn(u.id, tk, [{ sql: `UPDATE beslissingen SET status = ?, antwoord = ?, beslist = datetime('now','localtime') WHERE id = ? AND status = '${OPEN_DECISION}'`, params: [status, answer, id] }]);
    if (!res?.changes) throw new HttpError(409, 'Deze beslissing is net al afgehandeld.');
    const actor: Actor = { type: 'user', id: u.id, name: u.name };
    this.audit(u.id, tk, actor, { kind: 'write', verb: 'UPDATE', object: null, table: 'beslissingen', allRows: false }, `UPDATE beslissingen SET status = '${status}' WHERE id = ${id}`, [answer], null, null);
    this.ctx.audit(u.id, 'teamdata.decision', { id, status, answer: answer.slice(0, 300), ...(tk ? { teamId: tk } : {}) });
    this.changed(u.id, ['beslissingen'], actor, tk);
    const [fresh] = await this.rowsIn(u.id, tk, 'SELECT * FROM beslissingen WHERE id = ?', [id]);
    const view = this.decisionView(u.id, fresh || { ...row, status, antwoord: answer }, undefined, tk);
    const agent = this.askerOf(u.id, row, undefined, tk);
    let woke: { agentId: string; name: string; threadId: string; mode: string } | null = null;
    let notice = '';
    if (agent) {
      try {
        woke = await this.wake(u, agent, row, answer, status);
      } catch (e: any) {
        notice = `Opgeslagen, maar ${agent.name} kon niet worden gewekt: ${e?.message || e}`;
      }
    } else notice = row.gevraagd_door ? `Opgeslagen. TeamBot vond geen bot met de naam “${row.gevraagd_door}” om het antwoord te sturen.` : 'Opgeslagen. Er staat niet bij welke bot dit vroeg, dus er is niemand gewekt.';
    return { decision: view, woke, notice };
  }

  private async wake(u: Pick<User, 'id' | 'name'>, agent: Agent, row: any, answer: string, status: string) {
    const queue = this.ctx.services.queue;
    const thread = this.ctx.chat.threadForAgent(u.id, agent.id);
    const lines = [`Beslissing #${row.id}: ${String(row.vraag || '').trim()}`];
    if (status === 'vervallen') lines.push(`Deze beslissing laat ik vervallen.${answer.startsWith('Vervallen: ') ? ` ${answer.slice(11)}` : ''}`);
    else lines.push(`Mijn keuze: ${answer}`);
    lines.push('', `(Staat al in de tabel beslissingen: status ${status}.)`);
    const text = lines.join('\n');
    // An answer that still waits in the queue gets this one added, so a run of choices becomes one turn.
    const waiting = queue?.items(thread.id).find((it: any) => it.parts?.kind === 'team_decision');
    if (waiting) {
      queue.update(thread, waiting.id, `${waiting.content}\n\n${text}`);
      return { agentId: agent.id, name: agent.name, threadId: thread.id, mode: 'queued' };
    }
    if (queue) {
      const r = await queue.submit(thread, { id: u.id, name: u.name }, { content: text, parts: { kind: 'team_decision', decisionId: Number(row.id) } }, 'auto');
      return { agentId: agent.id, name: agent.name, threadId: thread.id, mode: r.mode };
    }
    await this.ctx.chat.postUserMessage({ thread, user: { id: u.id, name: u.name }, content: text, parts: { kind: 'team_decision', decisionId: Number(row.id) } });
    return { agentId: agent.id, name: agent.name, threadId: thread.id, mode: 'sent' };
  }

  // ---- tasks ----

  async tasks(userId: string, teamId?: string | null) {
    const rows = await this.rows(userId, 'SELECT * FROM taken ORDER BY COALESCE(bijgewerkt, aangemaakt) DESC, id DESC LIMIT 2000', [], true, teamId);
    return rows.map((r) => ({ ...r, id: Number(r.id) }));
  }

  async setTaskStatus(u: Pick<User, 'id' | 'name'>, id: number, status: string, teamId?: string | null) {
    const s = String(status || '').trim();
    if (!/^[a-z_]{2,40}$/.test(s)) throw bad('Ongeldige status.');
    const tk = this.teamKey(u.id, teamId);
    const [res] = await this.writeIn(u.id, tk, [{ sql: "UPDATE taken SET status = ?, bijgewerkt = datetime('now','localtime') WHERE id = ?", params: [s, id] }]);
    if (!res?.changes) throw notFound('Deze taak bestaat niet (meer).');
    const actor: Actor = { type: 'user', id: u.id, name: u.name };
    this.audit(u.id, tk, actor, { kind: 'write', verb: 'UPDATE', object: null, table: 'taken', allRows: false }, `UPDATE taken SET status = '${s}' WHERE id = ${id}`, [], null, null);
    this.changed(u.id, ['taken'], actor, tk);
    // The owner decided (quality module): a task that waited for him ("te controleren", "kon niet") no longer does.
    this.ctx.services.quality?.ownerDecided?.(u.id, 'teamdata', this.taskRef(u.id, tk, id), s === 'klaar');
    const [row] = await this.rowsIn(u.id, tk, 'SELECT * FROM taken WHERE id = ?', [id]);
    return row;
  }

  /** "Klaar als" of a task, set by the owner (a bot can no longer change it after that). */
  async setTaskDoneWhen(u: Pick<User, 'id' | 'name'>, id: number, text: string, teamId?: string | null) {
    const v = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const tk = this.teamKey(u.id, teamId);
    const [res] = await this.writeIn(u.id, tk, [{ sql: 'UPDATE taken SET klaar_als = ? WHERE id = ?', params: [v || null, id] }]);
    if (!res?.changes) throw notFound('Deze taak bestaat niet (meer).');
    const [row] = await this.rowsIn(u.id, tk, 'SELECT * FROM taken WHERE id = ?', [id]);
    this.ctx.services.quality?.setDoneWhen?.(u.id, 'teamdata', this.taskRef(u.id, tk, id), v, 'user', String(row?.titel || ''));
    const actor: Actor = { type: 'user', id: u.id, name: u.name };
    this.audit(u.id, tk, actor, { kind: 'write', verb: 'UPDATE', object: null, table: 'taken', allRows: false }, `UPDATE taken SET klaar_als = ? WHERE id = ${id}`, [v], null, null);
    this.changed(u.id, ['taken'], actor, tk);
    return row;
  }

  /**
   * How other modules name a task of a team database (the quality module's records): `<teamId>:<id>`, because every
   * team has its own database and row ids repeat between them; only the plain id while the owner has no team.
   */
  taskRef(userId: string, tk: string, id: number | string): string {
    void userId;
    return tk ? `${tk}:${id}` : String(id);
  }

  /**
   * A task ref from outside: "12" (the given team, else the default team, as the routes do) or "<teamId>:12". The team
   * must be one of the owner's (else "Team niet gevonden"); null for something that is not a task ref.
   */
  parseTaskRef(userId: string, raw: string, teamId?: string | null): { teamId: string | null; id: number; ref: string } | null {
    const m = /^(?:([A-Za-z0-9_-]{1,80}):)?(\d{1,12})$/.exec(String(raw ?? '').trim());
    if (!m) return null;
    const tk = this.teamKey(userId, m[1] || teamId || null);
    return { teamId: tk || null, id: Number(m[2]), ref: this.taskRef(userId, tk, m[2]) };
  }

  // ---- lists ----

  async log(userId: string, f: { q?: string; agent?: string; site?: string; before?: number; limit?: number } = {}, teamId?: string | null) {
    const tk = this.teamKey(userId, teamId);
    const s = search(['wat', 'waarom', 'bewijs', 'site', 'agent', 'terugdraaien'], f.q || '');
    const limit = Math.min(200, Math.max(1, Number(f.limit) || 50));
    const where = [s.sql];
    const params: any[] = [...s.params];
    if (f.agent) where.push('trim(agent) = ?'), params.push(String(f.agent).trim());
    if (f.site) where.push('site = ?'), params.push(String(f.site));
    const base = where.slice();
    const baseParams = params.slice();
    if (Number(f.before) > 0) where.push('id < ?'), params.push(Number(f.before));
    const rows = await this.rowsIn(userId, tk, `SELECT * FROM logboek WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`, [...params, limit + 1], true);
    const more = rows.length > limit;
    const list = rows.slice(0, limit).map((r) => ({ ...r, id: Number(r.id) }));
    const facets = !f.before
      ? await this.worker.call<{ rows: any[] }[]>(
          {
            op: 'internal',
            file: this.fileOf(userId, tk),
            tx: false,
            steps: [
              { sql: 'SELECT trim(agent) AS v, COUNT(*) AS n FROM logboek GROUP BY trim(agent) ORDER BY n DESC LIMIT 100', soft: true },
              { sql: "SELECT site AS v, COUNT(*) AS n FROM logboek WHERE COALESCE(site, '') != '' GROUP BY site ORDER BY n DESC LIMIT 200", soft: true },
              { sql: `SELECT COUNT(*) AS n FROM logboek WHERE ${base.join(' AND ')}`, params: baseParams, soft: true },
            ],
          },
          UI_TIMEOUT_MS,
        )
      : null;
    return { rows: list, next: more ? list[list.length - 1].id : null, agents: facets?.[0].rows || null, sites: facets?.[1].rows || null, total: facets ? Number(facets[2].rows[0]?.n) || 0 : null };
  }

  async events(userId: string, f: { q?: string; soort?: string; verwerkt?: string; before?: number; limit?: number } = {}, teamId?: string | null) {
    const tk = this.teamKey(userId, teamId);
    const s = search(['samenvatting', 'dossier', 'bron', 'soort'], f.q || '');
    const limit = Math.min(200, Math.max(1, Number(f.limit) || 50));
    const where = [s.sql];
    const params: any[] = [...s.params];
    if (f.soort) where.push('soort = ?'), params.push(String(f.soort));
    if (f.verwerkt === '0' || f.verwerkt === '1') where.push('COALESCE(verwerkt, 0) = ?'), params.push(Number(f.verwerkt));
    const base = where.slice();
    const baseParams = params.slice();
    if (Number(f.before) > 0) where.push('id < ?'), params.push(Number(f.before));
    const rows = await this.rowsIn(userId, tk, `SELECT * FROM gebeurtenissen WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`, [...params, limit + 1], true);
    const more = rows.length > limit;
    const list = rows.slice(0, limit).map((r) => ({ ...r, id: Number(r.id) }));
    const facets = !f.before
      ? await this.worker.call<{ rows: any[] }[]>(
          {
            op: 'internal',
            file: this.fileOf(userId, tk),
            tx: false,
            steps: [
              { sql: 'SELECT soort AS v, COUNT(*) AS n FROM gebeurtenissen GROUP BY soort ORDER BY n DESC LIMIT 50', soft: true },
              { sql: `SELECT COUNT(*) AS n FROM gebeurtenissen WHERE ${base.join(' AND ')}`, params: baseParams, soft: true },
            ],
          },
          UI_TIMEOUT_MS,
        )
      : null;
    return { rows: list, next: more ? list[list.length - 1].id : null, soorten: facets?.[0].rows || null, total: facets ? Number(facets[1].rows[0]?.n) || 0 : null };
  }

  async experiments(userId: string, teamId?: string | null) {
    const rows = await this.rows(userId, 'SELECT * FROM experimenten ORDER BY id DESC LIMIT 1000', [], true, teamId);
    return rows.map((r) => ({ ...r, id: Number(r.id) }));
  }

  /** Raw rows of any table or view (read-only browser in the interface). */
  async tableRows(userId: string, name: string, f: { offset?: number; limit?: number } = {}, teamId?: string | null) {
    const tk = this.teamKey(userId, teamId);
    const list = await this.tablesIn(userId, tk);
    const t = list.find((x) => x.name === name);
    if (!t) throw notFound('Deze tabel bestaat niet (meer).');
    const limit = Math.min(200, Math.max(1, Number(f.limit) || 50));
    const offset = Math.max(0, Number(f.offset) || 0);
    const q = `"${t.name.replace(/"/g, '""')}"`;
    const [ordered, plain] = await this.worker.call<{ rows: any[]; error?: string }[]>(
      {
        op: 'internal',
        file: this.fileOf(userId, tk),
        tx: false,
        steps: [
          { sql: `SELECT * FROM ${q} ORDER BY rowid DESC LIMIT ? OFFSET ?`, params: [limit, offset], soft: true },
          { sql: `SELECT * FROM ${q} LIMIT ? OFFSET ?`, params: [limit, offset], soft: true },
        ],
      },
      UI_TIMEOUT_MS,
    );
    const rows = ordered.error ? plain.rows : ordered.rows;
    const columns = rows.length ? Object.keys(rows[0]) : columnsFromSql(t.sql);
    return { table: t, columns, rows, offset, limit, total: t.rows };
  }
}

/** Column names from a CREATE TABLE statement (for an empty table). */
export function columnsFromSql(sql: string | null): string[] {
  const m = String(sql || '').match(/\(([\s\S]*)\)/);
  if (!m) return [];
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of m[1].replace(/--[^\n]*/g, '')) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out
    .map((d) => d.trim().match(/^["`[]?([A-Za-z_][\w]*)/)?.[1] || '')
    .filter((n) => n && !/^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)$/i.test(n));
}
