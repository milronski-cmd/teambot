import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseCsv } from '../browser/vault-import.js';
import { xlsxSheets } from '../folders/documents.js';
import { type Actor, type TeamData, TeamDataError } from './service.js';
import type { ImportResult } from '../../../shared/teamdata.js';

/**
 * "Zet deze Excel of CSV in een teamtabel": a spreadsheet becomes a table in the team database, through the existing
 * importTables (checked like a bot's CREATE, audited, idempotent per row) and taken back with undoImport.
 *  - CSV with the RFC 4180 parser of the vault import (comma, semicolon or tab), xlsx with read-excel-file;
 *  - the first row names the columns (made safe: lower case, a-z 0-9 _); every column gets a type from its values
 *    (INTEGER, REAL or TEXT); an own `id` column comes first, a column called id in the file is kept as `id_bron`;
 *  - the import's name ("source") is the file's content hash, so the same file twice adds nothing and another
 *    version is a new import that can be undone on its own.
 */

export const IMPORT_MAX_ROWS = 50_000;
const MAX_COLUMNS = 100;
const MAX_BYTES = 30 * 1024 * 1024;

export interface FileTable {
  name: string;
  sql: string;
  columns: { name: string; label: string; type: 'INTEGER' | 'REAL' | 'TEXT' }[];
  rows: Record<string, any>[];
}

/** A safe SQL name: lower case letters, digits and _; starts with a letter; at most 50 characters. */
export function safeName(raw: string, fallback: string): string {
  let s = String(raw ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);
  if (!s) s = fallback;
  if (!/^[a-z]/.test(s)) s = `k_${s}`;
  if (/^sqlite_/.test(s)) s = `t_${s}`;
  return s;
}

const INT = /^-?\d{1,15}$/;
const DEC = /^-?\d{1,15}([.,]\d+)?$/;

/** Value of one cell for SQLite: numbers as numbers (a Dutch decimal comma too), empty as null. */
function value(v: unknown, type: FileTable['columns'][number]['type']): any {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (type === 'TEXT') return String(v);
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  return type === 'INTEGER' ? Number(s) : Number(s.replace(',', '.'));
}

/** Rows (first = header) to a table definition and its rows (a `__rowid` per row: its line in the file). */
export function tableFromRows(raw: unknown[][], tableName: string): FileTable {
  const rows = raw.filter((r) => r.some((c) => c !== null && c !== undefined && String(c).trim() !== ''));
  if (rows.length < 1) throw new TeamDataError('Dit bestand is leeg.');
  const header = rows[0].slice(0, MAX_COLUMNS);
  const body = rows.slice(1, IMPORT_MAX_ROWS + 1);
  if (rows.length - 1 > IMPORT_MAX_ROWS) throw new TeamDataError(`Dit bestand heeft meer dan ${IMPORT_MAX_ROWS.toLocaleString('nl-NL')} rijen. Splits het in kleinere bestanden.`);
  const width = Math.min(MAX_COLUMNS, Math.max(header.length, ...body.map((r) => r.length)));
  const used = new Set(['id']);
  const columns: FileTable['columns'] = [];
  for (let i = 0; i < width; i++) {
    const label = String(header[i] ?? '').trim();
    let name = safeName(label, `kolom_${i + 1}`);
    if (name === 'id') name = 'id_bron';
    let n = name;
    for (let k = 2; used.has(n); k++) n = `${name}_${k}`;
    used.add(n);
    const vals = body.map((r) => r[i]).filter((v) => v !== null && v !== undefined && String(v).trim() !== '');
    const type: FileTable['columns'][number]['type'] = !vals.length
      ? 'TEXT'
      : vals.every((v) => (typeof v === 'number' && Number.isInteger(v)) || (typeof v === 'string' && INT.test(v.trim())))
        ? 'INTEGER'
        : vals.every((v) => typeof v === 'number' || (typeof v === 'string' && DEC.test(v.trim())))
          ? 'REAL'
          : 'TEXT';
    columns.push({ name: n, label: label || n, type });
  }
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const sql = `CREATE TABLE ${q(tableName)} (id INTEGER PRIMARY KEY, ${columns.map((c) => `${q(c.name)} ${c.type}`).join(', ')})`;
  const out = body.map((r, k) => {
    const o: Record<string, any> = { id: k + 1, __rowid: String(k + 1) };
    columns.forEach((c, i) => (o[c.name] = value(r[i], c.type)));
    return o;
  });
  return { name: tableName, sql, columns, rows: out };
}

/** The rows of a CSV or Excel file (the chosen sheet, or the first with data) and the sheet names. */
export async function readSpreadsheet(file: string, name: string, sheet?: string): Promise<{ rows: unknown[][]; sheet?: string; sheets?: string[] }> {
  const st = fs.statSync(file);
  if (st.size > MAX_BYTES) throw new TeamDataError(`Dit bestand is te groot (${Math.round(st.size / 1024 / 1024)} MB, max 30 MB).`);
  const buf = fs.readFileSync(file);
  const ext = path.extname(name).toLowerCase();
  if (buf[0] === 0x50 && buf[1] === 0x4b && /^\.(xlsx|xlsm|xltx)?$/.test(ext)) {
    let sheets;
    try {
      sheets = await xlsxSheets(buf);
    } catch (e: any) {
      throw new TeamDataError(`Deze Excel-werkmap kon niet worden gelezen: ${String(e?.message || e).slice(0, 160)}`);
    }
    const names = sheets.map((s) => s.name);
    const pick = sheet ? sheets.find((s) => s.name === sheet) : sheets.find((s) => s.rows.length > 0);
    if (!pick) throw new TeamDataError(sheet ? `Het blad “${sheet}” bestaat niet. Bladen: ${names.join(', ')}.` : 'In deze werkmap staan geen gegevens.');
    return { rows: pick.rows, sheet: pick.name, sheets: names };
  }
  if (/^\.(csv|tsv|txt)$/.test(ext) || !buf.subarray(0, 8000).includes(0)) {
    try {
      return { rows: parseCsv(buf.toString('utf8'), IMPORT_MAX_ROWS + 2) };
    } catch (e: any) {
      throw new TeamDataError(String(e?.message || e).replace(/logins/g, 'rijen').slice(0, 200));
    }
  }
  throw new TeamDataError('Alleen CSV-bestanden en Excel-werkmappen (.xlsx) kunnen in een teamtabel.');
}

/**
 * Import a CSV or Excel file into a table of the team database (new table, or rows added to an existing table with
 * the same name). `table`: the table name (default: from the file name or sheet).
 */
export async function importSpreadsheet(
  svc: TeamData,
  userId: string,
  file: string,
  o: { name: string; table?: string; sheet?: string; teamId?: string | null; actor: Actor },
): Promise<ImportResult> {
  const read = await readSpreadsheet(file, o.name, o.sheet);
  const base = o.table || (read.sheet && read.sheets && read.sheets.length > 1 ? read.sheet : path.basename(o.name, path.extname(o.name)));
  const table = safeName(base, 'import');
  const def = tableFromRows(read.rows, table);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).update(`\n${read.sheet || ''}\n${table}`).digest('hex').slice(0, 16);
  const source = `bestand:${hash}`;
  const [r] = await svc.importTables(userId, source, [{ name: table, sql: def.sql, rows: def.rows }], () => o.actor, { teamId: o.teamId ?? null });
  if (r?.error) throw new TeamDataError(`Importeren in tabel ${table} lukte niet: ${r.error}`);
  return {
    table,
    source,
    created: !!r?.created,
    inserted: r?.inserted || 0,
    skipped: r?.skipped || 0,
    rows: def.rows.length,
    columns: def.columns,
    sheet: read.sheet,
    sheets: read.sheets,
  };
}
