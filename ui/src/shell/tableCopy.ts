import Papa from 'papaparse';
import { copyToClipboard } from '../lib/clipboard.js';

/**
 * "Kopieer tabel" under a table in a chat answer (parity 4.6): one click puts the table on the clipboard twice, as CSV
 * (text/plain: a text editor, a .csv file, a mail) and as an HTML table (text/html: Excel, Google Sheets, Numbers and
 * Word paste that into real cells, whatever the list separator of the computer is). CSV quoting comes from Papa Parse
 * (MIT): fields with a comma, quote or line break are quoted, quotes doubled.
 *
 * A bot answer is untrusted text (it may repeat a web page), so a cell that a spreadsheet would run as a formula
 * ("=HYPERLINK(…)", "@SUM(…)", "+cmd|…") gets a leading apostrophe, the usual guard against CSV injection. Plain numbers
 * with a sign ("-5", "+3,5 %") stay numbers.
 */

export type Grid = string[][];

/** A cell a spreadsheet would treat as a formula: starts with = or @ (or a tab/CR), or with + or - that is no number. */
export const FORMULA_START = /^(?:[=@\t\r]|[+-](?!\s*[\d.,]+\s*%?\s*$))/;

const guard = (cell: string) => (FORMULA_START.test(cell) ? "'" + cell : cell);

/** Rows of equal length (short rows padded), cells trimmed, empty trailing rows dropped. */
export function normalizeGrid(rows: string[][]): Grid {
  const clean = rows.map((r) => r.map((c) => String(c ?? '').replace(/ /g, ' ').replace(/[ \t]*\r?\n[ \t]*/g, '\n').trim()));
  while (clean.length && clean[clean.length - 1].every((c) => !c)) clean.pop();
  const width = Math.max(0, ...clean.map((r) => r.length));
  return clean.map((r) => (r.length < width ? [...r, ...Array(width - r.length).fill('')] : r));
}

/** CSV with CRLF line ends (RFC 4180, what Excel writes too). */
export function gridToCsv(grid: Grid): string {
  return Papa.unparse(grid, { newline: '\r\n', escapeFormulae: FORMULA_START });
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A plain HTML table (first row as header) that spreadsheets paste into cells; line breaks in a cell stay <br>. */
export function gridToHtml(grid: Grid): string {
  const cell = (tag: 'th' | 'td', c: string) => `<${tag}>${esc(guard(c)).replace(/\n/g, '<br>')}</${tag}>`;
  const [head, ...body] = grid;
  const thead = head ? `<thead><tr>${head.map((c) => cell('th', c)).join('')}</tr></thead>` : '';
  const tbody = body.length ? `<tbody>${body.map((r) => `<tr>${r.map((c) => cell('td', c)).join('')}</tr>`).join('')}</tbody>` : '';
  return `<meta charset="utf-8"><table>${thead}${tbody}</table>`;
}

/** The cells of a rendered table, as the reader sees them (innerText keeps line breaks). */
export function gridOf(table: HTMLTableElement): Grid {
  return normalizeGrid(Array.from(table.rows).map((r) => Array.from(r.cells).map((c) => (c as HTMLElement).innerText ?? c.textContent ?? '')));
}

/**
 * Put CSV (text/plain) and the HTML table (text/html) on the clipboard. Where the async clipboard is missing (a phone
 * on plain http, no secure context) a copy event carries both formats; as a last resort only the CSV text.
 */
export async function copyGrid(grid: Grid): Promise<boolean> {
  const csv = gridToCsv(grid);
  const html = gridToHtml(grid);
  try {
    if (navigator.clipboard?.write && window.isSecureContext && typeof ClipboardItem !== 'undefined') {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([csv], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })]);
      return true;
    }
  } catch {
    /* refused or unsupported: try the copy event below */
  }
  let set = false;
  const onCopy = (e: ClipboardEvent) => {
    if (!e.clipboardData) return;
    e.clipboardData.setData('text/plain', csv);
    e.clipboardData.setData('text/html', html);
    e.preventDefault();
    set = true;
  };
  document.addEventListener('copy', onCopy);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    document.removeEventListener('copy', onCopy);
  }
  return ok && set ? true : copyToClipboard(csv);
}
