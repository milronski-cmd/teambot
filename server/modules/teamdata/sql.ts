/**
 * Statement analysis for the team database. Bots send one SQL statement per call with `?` parameters; this file
 * decides what kind of statement it is before it reaches SQLite (the worker's authorizer enforces the same rules a
 * second time, on what SQLite actually compiles).
 *
 * Rules (the same as OpenBot's shared data, so existing skill instructions keep working):
 *  - one statement per call (a second statement after `;` is refused, not silently dropped);
 *  - values always as parameters;
 *  - no transactions, PRAGMA, ATTACH, VACUUM, triggers, virtual tables or extensions.
 */

export type StmtKind = 'read' | 'write' | 'ddl';

export interface Analysis {
  kind: StmtKind;
  /** Upper-case main verb: SELECT, INSERT, UPDATE, DELETE, REPLACE, CREATE, DROP, ALTER. */
  verb: string;
  /** For CREATE/DROP: TABLE, INDEX or VIEW. */
  object: string | null;
  /** Target table (writes and DDL), lower-case-insensitive name as written. */
  table: string | null;
  /** DELETE/UPDATE without WHERE: touches every row. */
  allRows: boolean;
}

export class SqlRefused extends Error {}

interface Tok {
  t: 'word' | 'ident' | 'str' | 'num' | 'param' | 'punct';
  v: string;
}

/** Tokenize just enough of SQLite's grammar: words, quoted identifiers, strings, comments, parameters, punctuation. */
export function tokenize(sql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      const e = sql.indexOf('\n', i);
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const e = sql.indexOf('*/', i + 2);
      if (e < 0) throw new SqlRefused('Niet afgesloten commentaar (/* zonder */).');
      i = e + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      let v = '';
      for (;;) {
        if (j >= n) throw new SqlRefused(c === "'" ? 'Niet afgesloten tekst (een \' te weinig).' : 'Niet afgesloten naam (aanhalingsteken te weinig).');
        if (sql[j] === close) {
          if (close !== ']' && sql[j + 1] === close) {
            v += close;
            j += 2;
            continue;
          }
          break;
        }
        v += sql[j++];
      }
      out.push({ t: c === "'" ? 'str' : 'ident', v });
      i = j + 1;
      continue;
    }
    if (c === '?' || c === ':' || c === '@' || c === '$') {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(sql[j])) j++;
      out.push({ t: 'param', v: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] || ''))) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(sql[j])) j++;
      out.push({ t: 'num', v: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_\u0080-￿]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$\u0080-￿]/.test(sql[j])) j++;
      out.push({ t: 'word', v: sql.slice(i, j) });
      i = j;
      continue;
    }
    out.push({ t: 'punct', v: c });
    i++;
  }
  return out;
}

const REFUSED: Record<string, string> = {
  PRAGMA: 'PRAGMA is niet beschikbaar. Gebruik team_tables om tabellen en kolommen te zien.',
  BEGIN: 'Transacties zijn niet nodig en niet beschikbaar: elk statement is vanzelf alles-of-niets. Schrijf meerdere rijen in één INSERT … VALUES (…), (…).',
  COMMIT: 'Transacties zijn niet beschikbaar: elk statement wordt meteen opgeslagen.',
  END: 'Transacties zijn niet beschikbaar: elk statement wordt meteen opgeslagen.',
  ROLLBACK: 'Transacties zijn niet beschikbaar: elk statement is vanzelf alles-of-niets.',
  SAVEPOINT: 'Transacties zijn niet beschikbaar: elk statement is vanzelf alles-of-niets.',
  RELEASE: 'Transacties zijn niet beschikbaar: elk statement is vanzelf alles-of-niets.',
  ATTACH: 'Andere databases of bestanden koppelen kan niet; alles staat in de teamdatabase.',
  DETACH: 'Andere databases of bestanden koppelen kan niet; alles staat in de teamdatabase.',
  VACUUM: 'Onderhoud (VACUUM, ANALYZE, REINDEX) doet TeamBot zelf.',
  ANALYZE: 'Onderhoud (VACUUM, ANALYZE, REINDEX) doet TeamBot zelf.',
  REINDEX: 'Onderhoud (VACUUM, ANALYZE, REINDEX) doet TeamBot zelf.',
};

const up = (t: Tok | undefined) => (t && t.t === 'word' ? t.v.toUpperCase() : '');
const nameOf = (t: Tok | undefined) => (t && (t.t === 'word' || t.t === 'ident') ? t.v : null);

/** Name after optional `schema.` qualification, starting at index i. */
function qualifiedName(toks: Tok[], i: number): string | null {
  const a = nameOf(toks[i]);
  if (!a) return null;
  if (toks[i + 1]?.t === 'punct' && toks[i + 1].v === '.' && nameOf(toks[i + 2])) return nameOf(toks[i + 2]);
  return a;
}

/** Index of the first top-level (paren depth 0) word among `words`, from `from`. */
function topLevel(toks: Tok[], words: Set<string>, from = 0): number {
  let depth = 0;
  for (let i = from; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === 'punct') {
      if (t.v === '(') depth++;
      else if (t.v === ')') depth--;
      continue;
    }
    if (depth === 0 && words.has(up(t))) return i;
  }
  return -1;
}

const MAIN_VERBS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'VALUES']);

/**
 * A plain new line in the team logbook: `INSERT INTO logboek (…) VALUES (…)[, (…)]`, nothing else. No OR REPLACE,
 * no ON CONFLICT … DO UPDATE, no SELECT (not even in a value), no WITH, no RETURNING. Adding a line to a log changes
 * nothing that was there and reveals nothing: it is bookkeeping, not an action with impact (B-46). Anything that is not
 * exactly this shape is false (and goes through the normal approval).
 */
export function isLogAppend(sql: string): boolean {
  let toks: Tok[];
  try {
    toks = tokenize(String(sql || ''));
  } catch {
    return false;
  }
  while (toks.length && toks.at(-1)!.t === 'punct' && toks.at(-1)!.v === ';') toks.pop();
  if (toks.some((t) => t.t === 'punct' && t.v === ';')) return false;
  if (up(toks[0]) !== 'INSERT' || up(toks[1]) !== 'INTO') return false;
  let i = 2;
  if (toks[i + 1]?.t === 'punct' && toks[i + 1].v === '.') {
    if (String(nameOf(toks[i]) || '').toLowerCase() !== 'main') return false;
    i += 2;
  }
  if (String(nameOf(toks[i]) || '').toLowerCase() !== 'logboek') return false;
  const banned = new Set(['SELECT', 'WITH', 'ON', 'CONFLICT', 'UPDATE', 'DELETE', 'REPLACE', 'RETURNING', 'DEFAULT', 'INSERT', 'DROP', 'ALTER', 'CREATE']);
  if (toks.slice(i + 1).some((t) => banned.has(up(t)))) return false;
  return topLevel(toks, new Set(['VALUES']), i + 1) > 0;
}

/** Analyse one statement. Throws SqlRefused with a short Dutch reason when it may not run. */
export function analyse(sql: string): Analysis {
  if (typeof sql !== 'string' || !sql.trim()) throw new SqlRefused('Geef een SQL-statement mee (sql).');
  if (sql.length > 100_000) throw new SqlRefused('Het statement is te lang (max. 100.000 tekens). Zet grote teksten in een bestand en bewaar het pad.');
  let toks = tokenize(sql);
  // A trigger body contains semicolons of its own: say what is wrong instead of "two statements".
  if (up(toks[0]) === 'CREATE' && (up(toks[1]) === 'TRIGGER' || (['TEMP', 'TEMPORARY'].includes(up(toks[1])) && up(toks[2]) === 'TRIGGER'))) throw new SqlRefused('Triggers zijn niet beschikbaar: schrijf de vervolgstap zelf, met een eigen statement.');
  // One statement: trailing semicolons are fine, anything after a semicolon is not.
  const semi = toks.findIndex((t) => t.t === 'punct' && t.v === ';');
  if (semi >= 0) {
    if (toks.slice(semi).some((t) => !(t.t === 'punct' && t.v === ';'))) throw new SqlRefused('Eén statement per aanroep: na de ; staat nog een tweede statement. Doe het in aparte aanroepen.');
    toks = toks.slice(0, semi);
  }
  if (!toks.length) throw new SqlRefused('Geef een SQL-statement mee (sql).');
  let first = up(toks[0]);
  let start = 0;
  if (first === 'EXPLAIN') {
    const rest = up(toks[1]) === 'QUERY' && up(toks[2]) === 'PLAN' ? 3 : 1;
    const inner = analyse(toks.slice(rest).map(render).join(' '));
    if (inner.kind !== 'read') throw new SqlRefused('EXPLAIN kan hier alleen bij een SELECT.');
    return { ...inner, verb: 'EXPLAIN' };
  }
  if (REFUSED[first]) throw new SqlRefused(REFUSED[first]);
  if (first === 'WITH') {
    const i = topLevel(toks, MAIN_VERBS, 1);
    if (i < 0) throw new SqlRefused('Onvolledige WITH-query: er volgt geen SELECT, INSERT, UPDATE of DELETE.');
    first = up(toks[i]);
    start = i;
  }
  const where = topLevel(toks, new Set(['WHERE']), start) >= 0;
  switch (first) {
    case 'SELECT':
    case 'VALUES':
      return { kind: 'read', verb: 'SELECT', object: null, table: null, allRows: false };
    case 'INSERT':
    case 'REPLACE': {
      const into = toks.findIndex((t, k) => k > start && up(t) === 'INTO');
      return { kind: 'write', verb: first, object: null, table: into >= 0 ? qualifiedName(toks, into + 1) : null, allRows: false };
    }
    case 'UPDATE': {
      let i = start + 1;
      if (up(toks[i]) === 'OR') i += 2;
      return { kind: 'write', verb: 'UPDATE', object: null, table: qualifiedName(toks, i), allRows: !where };
    }
    case 'DELETE': {
      const i = up(toks[start + 1]) === 'FROM' ? start + 2 : start + 1;
      return { kind: 'write', verb: 'DELETE', object: null, table: qualifiedName(toks, i), allRows: !where };
    }
    case 'CREATE': {
      let i = 1;
      const w = up(toks[i]);
      if (w === 'TEMP' || w === 'TEMPORARY') throw new SqlRefused('Tijdelijke tabellen zijn niet beschikbaar: maak een gewone tabel (die zien alle bots).');
      if (w === 'VIRTUAL') throw new SqlRefused('Virtuele tabellen zijn niet beschikbaar.');
      if (w === 'TRIGGER') throw new SqlRefused('Triggers zijn niet beschikbaar: schrijf de vervolgstap zelf, met een eigen statement.');
      if (w === 'UNIQUE') i++;
      const obj = up(toks[i]);
      if (obj !== 'TABLE' && obj !== 'INDEX' && obj !== 'VIEW') throw new SqlRefused('Met CREATE kun je hier een TABLE, INDEX of VIEW maken.');
      i++;
      if (up(toks[i]) === 'IF' && up(toks[i + 1]) === 'NOT' && up(toks[i + 2]) === 'EXISTS') i += 3;
      let table = qualifiedName(toks, i);
      if (obj === 'INDEX') {
        const on = toks.findIndex((t, k) => k > i && up(t) === 'ON');
        table = on >= 0 ? qualifiedName(toks, on + 1) : null;
      }
      return { kind: 'ddl', verb: 'CREATE', object: obj, table, allRows: false };
    }
    case 'DROP': {
      const obj = up(toks[1]);
      if (obj === 'TRIGGER') throw new SqlRefused('Triggers zijn niet beschikbaar.');
      if (obj !== 'TABLE' && obj !== 'INDEX' && obj !== 'VIEW') throw new SqlRefused('Met DROP kun je hier een TABLE, INDEX of VIEW verwijderen.');
      let i = 2;
      if (up(toks[i]) === 'IF' && up(toks[i + 1]) === 'EXISTS') i += 2;
      return { kind: 'ddl', verb: 'DROP', object: obj, table: obj === 'INDEX' ? null : qualifiedName(toks, i), allRows: true };
    }
    case 'ALTER': {
      if (up(toks[1]) !== 'TABLE') throw new SqlRefused('Alleen ALTER TABLE is beschikbaar.');
      return { kind: 'ddl', verb: 'ALTER', object: 'TABLE', table: qualifiedName(toks, 2), allRows: false };
    }
    default:
      throw new SqlRefused(`Onbekend of niet toegestaan statement (${first || toks[0].v}). Gebruik SELECT om te lezen en INSERT, UPDATE, DELETE, CREATE TABLE, ALTER TABLE of DROP TABLE om te schrijven.`);
  }
}

function render(t: Tok): string {
  if (t.t === 'str') return `'${t.v.replace(/'/g, "''")}'`;
  if (t.t === 'ident') return `"${t.v.replace(/"/g, '""')}"`;
  return t.v;
}

// ---------------------------------------------------------------- parameters

export const MAX_PARAMS = 2000;
export const MAX_VALUE_CHARS = 100_000;

function value(v: any, where: string): any {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new SqlRefused(`${where}: ongeldig getal.`);
    return v;
  }
  if (typeof v === 'bigint') return v;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s.length > MAX_VALUE_CHARS) throw new SqlRefused(`${where} is te lang (${s.length.toLocaleString('nl-NL')} tekens, max. ${MAX_VALUE_CHARS.toLocaleString('nl-NL')}). Zet lange tekst in een bestand en bewaar het pad.`);
  return s;
}

/** Normalise `params` from a tool call: an array (for ?), an object (for :naam/@naam/$naam), or a JSON string of one. */
export function normParams(p: any): any[] | Record<string, any> {
  if (p === undefined || p === null || p === '') return [];
  if (typeof p === 'string') {
    try {
      p = JSON.parse(p);
    } catch {
      throw new SqlRefused('params moet een lijst zijn, bijvoorbeeld ["waarde", 3].');
    }
  }
  if (Array.isArray(p)) {
    if (p.length > MAX_PARAMS) throw new SqlRefused(`Te veel parameters (max. ${MAX_PARAMS}).`);
    return p.map((v, i) => value(v, `Parameter ${i + 1}`));
  }
  if (typeof p === 'object') {
    const out: Record<string, any> = {};
    const keys = Object.keys(p);
    if (keys.length > MAX_PARAMS) throw new SqlRefused(`Te veel parameters (max. ${MAX_PARAMS}).`);
    for (const k of keys) {
      const bare = k.replace(/^[:@$]/, '');
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(bare)) throw new SqlRefused(`Ongeldige parameternaam "${k}".`);
      out[bare] = value(p[k], `Parameter ${bare}`);
    }
    return out;
  }
  return [value(p, 'Parameter 1')];
}

/** Turn a SQLite error into a short, useful sentence for a bot (the denial reason of the authorizer wins). */
export function friendlyError(msg: string, denied?: string | null): string {
  if (denied) return denied;
  const m = String(msg || '');
  let x: RegExpMatchArray | null;
  if ((x = m.match(/no such table: (?:main\.)?(\S+)/i))) return `Tabel ${x[1]} bestaat niet. Bekijk de tabellen met team_tables.`;
  if ((x = m.match(/no such column: (\S+)/i))) return `Kolom ${x[1]} bestaat niet. Bekijk de kolommen met team_tables.`;
  if ((x = m.match(/table (\S+) already exists/i))) return `Tabel ${x[1]} bestaat al. Gebruik CREATE TABLE IF NOT EXISTS, of voeg rijen toe aan de bestaande tabel.`;
  if (/database or disk is full/i.test(m)) return 'De teamdatabase is vol (max. 256 MB). Ruim oude rijen op of bewaar grote teksten in bestanden.';
  if (/database is locked|database table is locked|SQLITE_BUSY/i.test(m)) return 'De teamdatabase is even bezig met een andere opdracht. Probeer het zo opnieuw.';
  if (/string or blob too big/i.test(m)) return 'Een waarde is te groot (max. 1 MB per cel). Bewaar grote inhoud in een bestand en zet het pad in de tabel.';
  if (/too many attached/i.test(m)) return 'Andere databases of bestanden koppelen kan niet.';
  if (/not authorized/i.test(m)) return 'Dit statement is niet toegestaan in de teamdatabase.';
  return m.replace(/^Error:\s*/, '').slice(0, 500);
}
