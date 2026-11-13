import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import TurndownService from 'turndown';
import type { ToolDef } from '../../core/types.js';
import { refuseReadOf, resolveInWorkspace } from '../../tools/builtin/files.js';
import { MAX_OCR_PAGES, OCR_HINT, isImage, ocrEngine } from './ocr.js';
import { words } from '../../../shared/i18n-core.js';

/**
 * read_document (A-39): the text of a document in the bot's folders, as a plain TeamBot read tool. A CLI engine
 * without its own pdf reader (OpenCode) otherwise writes a Python script and asks twice to run it in the terminal;
 * this is one read step that needs no approval (risk "read", only inside the bot's folders).
 *
 * One entry (`readDocument`) for every kind, also used for dossier sources:
 *  - pdf: pdf.js (pdfjs-dist, Apache-2.0); pages without a text layer (scans) are read with OCR (ocr.ts; the first
 *    scan fetches the language data by itself, and when that fails an honest note says the next scan tries again);
 *  - Word (.docx): mammoth (BSD-2-Clause) to HTML, then turndown to markdown, so headings, lists and tables stay;
 *    when mammoth fails the plain reader below still gives the paragraphs;
 *  - Excel (.xlsx): read-excel-file (MIT), every sheet as a markdown table;
 *  - PowerPoint (.pptx): our own small reader (slides in deck order, with speaker notes);
 *  - pictures (png, jpeg …): OCR;
 *  - everything else only when it is text.
 */

const MAX_BYTES = 60 * 1024 * 1024;
const MAX_CHARS = 200_000;
/** Rows of one Excel sheet in the text (the team database import reads every row). */
const MAX_SHEET_ROWS = 2000;

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjs: Promise<PdfJs> | null = null;
function loadPdfJs(): Promise<PdfJs> {
  if (!pdfjs)
    pdfjs = (async () => {
      const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
      // In Node pdf.js runs its "worker" in this thread; handing it the module avoids a file lookup next to the bundle.
      const g = globalThis as any;
      // @ts-ignore -- pdf.js ships no types for its worker module
      if (!g.pdfjsWorker) g.pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
      return lib;
    })();
  return pdfjs;
}

/** "1-3,5" → [1,2,3,5] within 1..max; empty = all pages. */
export function pageList(spec: string | undefined, max: number): number[] {
  const all = Array.from({ length: max }, (_, i) => i + 1);
  const s = String(spec || '').trim();
  if (!s) return all;
  const out = new Set<number>();
  for (const part of s.split(/[,;\s]+/)) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!m) continue;
    const a = Math.max(1, Number(m[1]));
    const b = Math.min(max, Number(m[2] || m[1]));
    for (let i = a; i <= b; i++) out.add(i);
  }
  return out.size ? [...out].sort((x, y) => x - y) : all;
}

export const NO_TEXT_PAGE = '(geen tekst op deze pagina; mogelijk een scan of afbeelding)';

export interface PdfTextResult {
  text: string;
  pages: number;
  shown: number[];
  /** Pages without a text layer (scans), before OCR. */
  scanned: number[];
  /** Pages whose text came from OCR. */
  ocr: number[];
  /** Scanned pages not read with OCR (no language data, or beyond the limit). */
  unread: number[];
  truncated: boolean;
}

export async function pdfText(data: Uint8Array, pages?: string, o: { maxChars?: number; ocr?: boolean } = {}): Promise<PdfTextResult> {
  const maxChars = o.maxChars ?? MAX_CHARS;
  const lib = await loadPdfJs();
  // pdf.js may detach the buffer it gets: PDFium (for scans) reads its own copy.
  const engine = o.ocr === false ? null : ocrEngine();
  const copy = engine ? data.slice() : null;
  const task = lib.getDocument({ data, useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  const bodies = new Map<number, string>();
  let want: number[] = [];
  let truncated = false;
  let numPages = 0;
  try {
    numPages = doc.numPages;
    want = pageList(pages, doc.numPages);
    let len = 0;
    for (const n of want) {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      const body = tc.items
        .map((it: any) => (typeof it.str === 'string' ? it.str + (it.hasEOL ? '\n' : ' ') : ''))
        .join('')
        .replace(/[ \t]+\n/g, '\n')
        .trim();
      bodies.set(n, body);
      len += body.length + 20;
      if (len > maxChars) {
        truncated = n !== want[want.length - 1];
        break;
      }
    }
  } finally {
    await task.destroy().catch(() => {});
  }
  const scanned = [...bodies].filter(([, b]) => b.replace(/\s/g, '').length < 3).map(([n]) => n);
  const ocr: number[] = [];
  // The first scan fetches the language data by itself (ocr.ts `ensure`).
  if (scanned.length && copy && engine && (await engine.ensure())) {
    const todo = scanned.slice(0, MAX_OCR_PAGES);
    const got = await engine.pdfPages(copy, todo);
    for (const [n, t] of got) {
      if (!t.trim()) continue;
      bodies.set(n, t);
      ocr.push(n);
    }
  }
  const unread = scanned.filter((n) => !ocr.includes(n));
  const text = [...bodies].map(([n, b]) => `--- pagina ${n} ---\n${b && !unread.includes(n) ? b : NO_TEXT_PAGE}`).join('\n\n');
  return { text, pages: numPages, shown: want, scanned, ocr, unread, truncated };
}

const XML_ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : XML_ENT[e] ?? m));

/** Text of a .docx (paragraphs, tabs, line breaks), without a Word library: the fallback when mammoth cannot. */
export function docxText(buf: Buffer): string {
  const zip = new AdmZip(buf);
  const entry = zip.getEntry('word/document.xml');
  if (!entry) throw new Error('Dit Word-bestand heeft geen tekstdeel (word/document.xml).');
  const xml = entry.getData().toString('utf8');
  return unxml(
    xml
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:(br|cr)\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const cellText = (s: unknown) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();

/** Rows as a markdown table (first row = header); ragged rows are padded. */
export function markdownTable(rows: string[][]): string {
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length), 1);
  const pad = (r: string[]) => Array.from({ length: width }, (_, i) => cellText(r[i]));
  const [head, ...rest] = rows;
  return [`| ${pad(head).join(' | ')} |`, `|${' --- |'.repeat(width)}`, ...rest.map((r) => `| ${pad(r).join(' | ')} |`)].join('\n');
}

let docTd: TurndownService | null = null;
function docTurndown(): TurndownService {
  if (docTd) return docTd;
  const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' });
  td.remove(['img', 'script', 'style'] as any);
  // Tables stay tables (cells were separate lines before).
  td.addRule('table', {
    filter: 'table',
    replacement: (_content, node: any) => {
      // Walk the children (turndown's DOM has no reliable querySelectorAll); a nested table's rows stay its own.
      const find = (n: any, name: string, out: any[] = []): any[] => {
        for (const c of Array.from((n.childNodes || []) as ArrayLike<any>)) {
          const nn = String(c.nodeName || '').toUpperCase();
          if (name.split(',').includes(nn)) out.push(c);
          else if (nn !== 'TABLE') find(c, name, out);
        }
        return out;
      };
      const rows = find(node, 'TR').map((tr) => find(tr, 'TD,TH').map((c) => String(c.textContent || '')));
      return `\n\n${markdownTable(rows)}\n\n`;
    },
  });
  docTd = td;
  return td;
}

/** A .docx as markdown (headings, lists, tables, footnotes) through mammoth; null when mammoth cannot read it. */
export async function docxMarkdown(buf: Buffer): Promise<string | null> {
  try {
    const mammoth: any = (await import('mammoth')).default ?? (await import('mammoth'));
    const r = await mammoth.convertToHtml({ buffer: buf }, { ignoreEmptyParagraphs: true, convertImage: mammoth.images.imgElement(async () => ({ src: '' })) });
    const md = docTurndown()
      .turndown(String(r.value || ''))
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return md || null;
  } catch {
    return null;
  }
}

export interface Sheet {
  name: string;
  rows: (string | number | boolean | null)[][];
}

/** The sheets of an .xlsx with their rows (dates as yyyy-mm-dd, empty cells null), via read-excel-file. */
export async function xlsxSheets(buf: Buffer): Promise<Sheet[]> {
  const mod: any = await import('read-excel-file/node');
  const read = mod.default ?? mod;
  const sheets: { sheet: string; data: any[][] }[] = await read(buf);
  return sheets.map((s) => {
    const rows = s.data.map((r) =>
      r.map((c) => (c instanceof Date ? (Number.isNaN(c.getTime()) ? null : c.toISOString().replace(/T00:00:00\.000Z$/, '').replace(/\.000Z$/, 'Z')) : c === undefined ? null : typeof c === 'object' && c !== null ? String(c) : c)),
    );
    // Drop empty rows at the end and empty columns on the right.
    while (rows.length && rows[rows.length - 1].every((c) => c === null || c === '')) rows.pop();
    const width = rows.reduce((w, r) => Math.max(w, r.reduce((x, c, i) => (c === null || c === '' ? x : i + 1), 0)), 0);
    return { name: s.sheet, rows: rows.map((r) => r.slice(0, width)) };
  });
}

/** Every sheet of an .xlsx as a markdown table under "## Blad: <name>". */
export async function xlsxText(buf: Buffer): Promise<string> {
  const sheets = await xlsxSheets(buf);
  const parts: string[] = [];
  for (const s of sheets) {
    if (!s.rows.length) {
      parts.push(`## Blad: ${s.name}\n\n(leeg)`);
      continue;
    }
    const rows = s.rows.slice(0, MAX_SHEET_ROWS + 1).map((r) => r.map((c) => (c === null ? '' : String(c))));
    const more = s.rows.length - rows.length;
    parts.push(`## Blad: ${s.name}\n\n${markdownTable(rows)}${more > 0 ? `\n\n… nog ${more} rijen niet getoond` : ''}`);
  }
  return parts.join('\n\n');
}

/** Paragraphs of a DrawingML part (a slide or its notes), without fields such as the slide number. */
function drawingParagraphs(xml: string): string[] {
  return xml
    .replace(/<a:fld\b[\s\S]*?<\/a:fld>/g, '')
    .split(/<\/a:p>/)
    .map((p) =>
      unxml(
        p
          .replace(/<a:br\s*\/>/g, '\n')
          .replace(/<a:tab\s*\/>/g, '\t')
          .match(/<a:t(?:\s[^>]*)?>[^<]*<\/a:t>|\n|\t/g)
          ?.map((x) => (x === '\n' || x === '\t' ? x : x.replace(/<[^>]+>/g, '')))
          .join('') || '',
      ).trim(),
    )
    .filter(Boolean);
}

/** Text of a .pptx: every slide in the order of the deck ("## Dia n"), with its speaker notes. */
export function pptxText(buf: Buffer): string {
  const zip = new AdmZip(buf);
  const read = (name: string) => zip.getEntry(name)?.getData().toString('utf8') ?? null;
  const rels = (file: string): Map<string, { type: string; target: string }> => {
    const dir = path.posix.dirname(file);
    const relXml = read(`${dir}/_rels/${path.posix.basename(file)}.rels`) || '';
    const out = new Map<string, { type: string; target: string }>();
    for (const m of relXml.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
      const target = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
      const type = /\bType="([^"]+)"/.exec(m[0])?.[1] || '';
      if (id && target) out.set(id, { type, target: target.startsWith('/') ? target.slice(1) : path.posix.normalize(`${dir}/${target}`) });
    }
    return out;
  };
  let slides: string[] = [];
  const pres = read('ppt/presentation.xml');
  if (pres) {
    const r = rels('ppt/presentation.xml');
    slides = [...pres.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)].map((m) => r.get(m[1])?.target || '').filter((t) => t && zip.getEntry(t));
  }
  if (!slides.length)
    slides = zip
      .getEntries()
      .map((e) => e.entryName)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]));
  if (!slides.length) throw new Error('In dit PowerPoint-bestand staan geen dia’s (ppt/slides).');
  return slides
    .map((s, i) => {
      const lines = drawingParagraphs(read(s) || '');
      const notesFile = [...rels(s).values()].find((x) => /\/notesSlide$/.test(x.type))?.target;
      const notes = notesFile ? drawingParagraphs(read(notesFile) || '') : [];
      return [`## Dia ${i + 1}`, lines.join('\n') || '(geen tekst op deze dia)', notes.length ? `Notities: ${notes.join('\n')}` : ''].filter(Boolean).join('\n');
    })
    .join('\n\n');
}

export type DocKind = 'pdf' | 'word' | 'excel' | 'powerpoint' | 'image' | 'text';

/** What kind of document a file is, by its first bytes and its name (Office files are zips). */
export function documentKind(buf: Buffer, name: string): DocKind | null {
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  const ext = path.extname(name).toLowerCase();
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    if (/^\.(docx|docm|dotx)$/.test(ext)) return 'word';
    if (/^\.(xlsx|xlsm|xltx)$/.test(ext)) return 'excel';
    if (/^\.(pptx|pptm|potx)$/.test(ext)) return 'powerpoint';
    try {
      const zip = new AdmZip(buf);
      if (zip.getEntry('word/document.xml')) return 'word';
      if (zip.getEntry('xl/workbook.xml')) return 'excel';
      if (zip.getEntry('ppt/presentation.xml')) return 'powerpoint';
    } catch {
      /* not a zip after all */
    }
    return null;
  }
  if (isImage(buf)) return 'image';
  if (!buf.subarray(0, 8000).includes(0)) return 'text';
  return null;
}

export interface DocText {
  kind: DocKind;
  /** First line(s) for a reader: name, kind, pages. */
  head: string;
  text: string;
  /** Plain remarks for the reader (what was read with OCR, what was not read and why). */
  notes: string[];
  pdf?: PdfTextResult;
}

export const UNSUPPORTED = 'Van dit soort bestand kan TeamBot de tekst niet lezen (alleen pdf, Word, Excel, PowerPoint, afbeeldingen en tekstbestanden).';

/** The text of any supported document. `name` (an attachment's original name) decides the kind next to the bytes. */
export async function readDocument(file: string, o: { pages?: string; name?: string; maxChars?: number; ocr?: boolean } = {}): Promise<DocText> {
  const st = fs.statSync(file);
  if (st.isDirectory()) throw new Error('Dit is een map, geen bestand.');
  if (st.size > MAX_BYTES) throw new Error(`Bestand te groot om te lezen (${Math.round(st.size / 1024 / 1024)} MB, max 60 MB).`);
  const buf = fs.readFileSync(file);
  const name = path.basename(o.name || file);
  const kind = documentKind(buf, name);
  const notes: string[] = [];
  if (kind === 'pdf') {
    const r = await pdfText(new Uint8Array(buf), o.pages, { maxChars: o.maxChars, ocr: o.ocr });
    if (r.ocr.length) notes.push(r.ocr.length === 1 ? `Pagina ${r.ocr[0]} is een scan en is gelezen met tekstherkenning (OCR); controleer namen en getallen.` : `${r.ocr.length} pagina's zijn scans en zijn gelezen met tekstherkenning (OCR); controleer namen en getallen.`);
    const engine = ocrEngine();
    // One whole sentence per form ("Pagina 4 is", "Pagina's 4, 5 zijn"): never "is"/"zijn" as a value in one sentence.
    const one = r.unread.length === 1;
    const pages = r.unread.join(', ');
    if (r.unread.length && engine?.ready()) notes.push(one ? `Pagina ${pages} is niet gelezen: per keer leest TeamBot ${MAX_OCR_PAGES} gescande pagina's. Vraag om de volgende pagina's met pages.` : `Pagina's ${pages} zijn niet gelezen: per keer leest TeamBot ${MAX_OCR_PAGES} gescande pagina's. Vraag om de volgende pagina's met pages.`);
    else if (r.unread.length) notes.push(one ? `Pagina ${pages} is een scan zonder tekst. ${engine?.problem() ?? OCR_HINT}` : `Pagina's ${pages} zijn scans zonder tekst. ${engine?.problem() ?? OCR_HINT}`);
    if (r.truncated) notes.push("De tekst is afgekapt; vraag om minder pagina's.");
    const head = `${name} — pdf, ${r.pages} ${r.pages === 1 ? 'pagina' : "pagina's"}${r.shown.length < r.pages ? ` (getoond: ${r.shown.length})` : ''}`;
    return { kind, head, text: r.text, notes, pdf: r };
  }
  if (kind === 'word') {
    const md = await docxMarkdown(buf);
    return { kind, head: `${name} — Word-document`, text: md ?? docxText(buf), notes };
  }
  if (kind === 'excel') return { kind, head: `${name} — Excel-werkmap`, text: await xlsxText(buf), notes };
  if (kind === 'powerpoint') return { kind, head: `${name} — PowerPoint-presentatie`, text: pptxText(buf), notes };
  if (kind === 'image') {
    const engine = o.ocr === false ? null : ocrEngine();
    if (!engine || !(await engine.ensure())) throw new Error(`Dit is een afbeelding. ${engine?.problem() ?? OCR_HINT}`);
    const text = await engine.recognize(buf);
    notes.push('Gelezen met tekstherkenning (OCR); controleer namen en getallen.');
    return { kind, head: `${name} — afbeelding`, text: text || '(geen tekst gevonden op deze afbeelding)', notes };
  }
  if (kind === 'text') return { kind, head: '', text: buf.toString('utf8'), notes };
  throw new Error(UNSUPPORTED);
}

export async function documentText(file: string, o: { pages?: string } = {}): Promise<string> {
  const d = await readDocument(file, o);
  let text = d.text;
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + "\n… (afgekapt; vraag om minder pagina's)";
  return (d.head ? `${d.head}\n\n` : '') + text + (d.notes.length ? `\n\n[${d.notes.join(' ')}]` : '');
}

export const readDocumentTool: ToolDef = {
  name: 'read_document',
  group: 'files',
  risk: 'read',
  description:
    'Lees de tekst van een pdf (ook een scan), Word-document (.docx), Excel-werkmap (.xlsx), PowerPoint (.pptx), foto van een tekst of tekstbestand in je werkmap of je andere mappen (bijv. een bijlage in uploads/). Gebruik dit in plaats van een script of opdracht in de terminal. Optioneel pages, bijv. "1-3".',
  parameters: { type: 'object', properties: { path: { type: 'string', description: 'Pad in je werkmap of een van je mappen' }, pages: { type: 'string', description: 'Alleen deze pagina\'s van een pdf, bijv. "1-3,5"' } }, required: ['path'] },
  // An attachment's short id ("uploads/ac62bc-offerte.pdf") means nothing to the owner: "Document lezen: offerte.pdf".
  summarize: (a) => words('Document lezen: {0}', String(a.path ?? '').replace(/(^|[\\/])uploads[\\/][0-9a-f]{6}-/i, '$1')),
  refuse: refuseReadOf('path'),
  async run(a, t) {
    const f = resolveInWorkspace(t.agent, String(a.path || ''));
    if (!fs.existsSync(f)) return { text: `Bestand niet gevonden: ${a.path}`, isError: true };
    try {
      return await documentText(f, { pages: a.pages ? String(a.pages) : undefined });
    } catch (e: any) {
      return { text: `Kon ${a.path} niet lezen: ${e?.message || e}`, isError: true };
    }
  },
};
