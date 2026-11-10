/**
 * "Importeren uit Markdown" (A-49): existing Markdown notes (one .md file per project, client or topic) become
 * dossiers. Each file becomes one dossier: the title from its first "# heading" (else the file name), the first
 * paragraph as the summary, and the whole text as a knowledge source "Geïmporteerd uit <bestand>" (chunked and
 * searchable, like a pasted note). The text is data, never an instruction to a bot.
 *
 * Safety: the same rules as everything else in memory — text that looks like a password or key is refused (nothing is
 * created), something the owner asked to forget stays forgotten, and text that reads like an instruction is kept as
 * plain data with a warning. A preview (dryRun) shows exactly what will happen before anything is written.
 */
import path from 'node:path';
import type { MemoryService } from './service.js';
import { addSource, createDossier } from './dossiers.js';
import { clean, detectSecret, isInjectionLike, normalize } from './text.js';

export const MD_IMPORT_LIMITS = { files: 50, fileChars: 400_000, totalChars: 5_000_000 };

export interface MdFileIn {
  name: string;
  text: string;
}

export type MdImportStatus = 'new' | 'renamed' | 'duplicate' | 'rejected' | 'blocked' | 'empty' | 'too_big' | 'not_markdown' | 'created' | 'failed';

export interface MdImportLine {
  name: string;
  title: string;
  summary: string;
  chars: number;
  status: MdImportStatus;
  message: string;
  warning?: string;
  dossierId?: string;
}

/** Title and summary of a Markdown note (front matter, headings and formatting stripped). */
export function parseMarkdownNote(name: string, text: string): { title: string; summary: string } {
  let body = String(text || '').replace(/^﻿/, '');
  let fmTitle = '';
  const fm = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fm) {
    fmTitle = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1] || '';
    body = body.slice(fm[0].length);
  }
  const lines = body.split(/\r?\n/);
  let title = '';
  let at = -1;
  let inCode = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*```/.test(l)) inCode = !inCode;
    if (inCode) continue;
    const h = l.match(/^\s{0,3}#\s+(.+?)\s*#*\s*$/);
    if (h) {
      title = h[1];
      at = i;
      break;
    }
  }
  const base = path.basename(String(name || '')).replace(/\.(md|markdown|mdown|txt)$/i, '').replace(/[_]+/g, ' ').trim();
  title = plain(title || fmTitle || base || 'Geïmporteerd dossier');
  // Summary: the first real paragraph after the title (not a heading, list, table, quote or code).
  const para: string[] = [];
  inCode = false;
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*```/.test(l)) {
      inCode = !inCode;
      if (para.length) break;
      continue;
    }
    if (inCode) continue;
    if (!l.trim()) {
      if (para.length) break;
      continue;
    }
    if (/^\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||<!--)/.test(l)) {
      if (para.length) break;
      continue;
    }
    para.push(l.trim());
  }
  return { title: clean(title, 120), summary: clean(plain(para.join(' ')), 400) };
}

/** Markdown → readable text for a title or summary line. */
function plain(s: string): string {
  return String(s || '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, a, b) => b || a)
    .replace(/[*_~`]+/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Preview (dryRun) or import. Duplicates (an existing dossier with the same title, or the same title twice in this
 * batch) are skipped or, with `duplicates: 'rename'`, added as "Titel (2)".
 */
export function importMarkdownDossiers(svc: MemoryService, userId: string, files: MdFileIn[], o: { dryRun?: boolean; duplicates?: 'skip' | 'rename' } = {}) {
  if (!Array.isArray(files) || !files.length) throw new Error('Kies een of meer Markdown-bestanden (.md).');
  if (files.length > MD_IMPORT_LIMITS.files) throw new Error(`Maximaal ${MD_IMPORT_LIMITS.files} bestanden per keer.`);
  const total = files.reduce((n, f) => n + String(f?.text || '').length, 0);
  if (total > MD_IMPORT_LIMITS.totalChars) throw new Error('Samen zijn de bestanden te groot (maximaal 5 MB per keer). Importeer ze in delen.');
  const rename = o.duplicates === 'rename';
  const taken = new Set(svc.store.all<any>("SELECT title FROM memory_dossiers WHERE user_id = ? AND status IN ('active','closed')", userId).map((d) => normalize(d.title)));
  const lines: MdImportLine[] = [];
  for (const f of files) {
    const name = clean(path.basename(String(f?.name || 'naamloos.md')), 200);
    const text = String(f?.text ?? '');
    const line: MdImportLine = { name, title: '', summary: '', chars: text.length, status: 'new', message: '' };
    lines.push(line);
    if (!/\.(md|markdown|mdown|txt)$/i.test(name)) {
      line.status = 'not_markdown';
      line.message = 'Geen Markdown-bestand (.md); overgeslagen.';
      continue;
    }
    if (text.length > MD_IMPORT_LIMITS.fileChars) {
      line.status = 'too_big';
      line.message = 'Te groot (maximaal 400 kB per bestand).';
      continue;
    }
    if (!text.trim()) {
      line.status = 'empty';
      line.message = 'Leeg bestand; overgeslagen.';
      continue;
    }
    const { title, summary } = parseMarkdownNote(name, text);
    line.title = title;
    line.summary = summary;
    const secret = detectSecret(text);
    if (secret) {
      line.status = 'rejected';
      line.message = `Niet geïmporteerd: dit bestand lijkt een ${secret} te bevatten. Haal dat eruit (bewaar het in Instellingen › Beveiliging › Opgeslagen geheimen) en probeer het opnieuw.`;
      continue;
    }
    if (svc.blockedBy(userId, [title, summary].join(' '), null, ['forget'])) {
      line.status = 'blocked';
      line.message = 'Niet geïmporteerd: dit is eerder op jouw verzoek vergeten.';
      continue;
    }
    if (isInjectionLike(text)) {
      line.warning = 'Bevat tekst die als een opdracht aan een bot leest. Het wordt bewaard als gewone tekst (data), nooit als opdracht.';
      // The summary is shown to bots with the dossier: never an instruction-like line there.
      if (isInjectionLike(summary)) line.summary = '';
    }
    if (taken.has(normalize(title))) {
      if (!rename) {
        line.status = 'duplicate';
        line.message = `Er is al een dossier “${title}”; overgeslagen.`;
        continue;
      }
      let n = 2;
      while (taken.has(normalize(`${title} (${n})`))) n++;
      line.title = clean(`${title} (${n})`, 120);
      line.status = 'renamed';
      line.message = `Er is al een dossier “${title}”; wordt “${line.title}”.`;
    }
    taken.add(normalize(line.title));
    if (!line.message) line.message = 'Wordt een nieuw dossier.';
  }
  if (o.dryRun) return { dryRun: true, lines, toImport: lines.filter((l) => l.status === 'new' || l.status === 'renamed').length };

  let created = 0;
  for (const [i, line] of lines.entries()) {
    if (line.status !== 'new' && line.status !== 'renamed') continue;
    const text = String(files[i]?.text ?? '');
    try {
      const r = createDossier(svc, userId, { title: line.title, summary: line.summary, kind: 'topic', tags: ['geïmporteerd'] }, { type: 'user', id: userId });
      if (r.existed) {
        line.status = 'duplicate';
        line.message = `Er is al een dossier “${line.title}”; overgeslagen.`;
        continue;
      }
      try {
        addSource(svc, userId, r.dossier.id, { kind: 'file', target: line.name, title: `Geïmporteerd uit ${line.name}`, text }, { type: 'user', id: userId });
      } catch (e: any) {
        line.warning = `Dossier gemaakt, maar de tekst kon niet als bron worden opgeslagen: ${e?.message || e}`;
      }
      line.status = 'created';
      line.dossierId = r.dossier.id;
      line.message = 'Geïmporteerd.';
      created++;
    } catch (e: any) {
      line.status = 'failed';
      line.message = `Mislukt: ${String(e?.message || e)}`;
    }
  }
  svc.ctx.audit(userId, 'memory.dossiers_imported', { files: lines.length, created, skipped: lines.length - created, source: 'markdown' });
  return { dryRun: false, lines, created };
}

