import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compareVersions } from './updates.js';

/**
 * "Wat is er nieuw" after an update, from CHANGELOG.md (shipped as dist/CHANGELOG.md by scripts/build.mjs). The
 * changelog is written in plain Dutch already; here it is only cut into versions, sections and short items, and the
 * markdown marks are taken out. Shown as it is written (the changelog has no translations).
 */

export interface ChangeGroup {
  title?: string;
  items: string[];
}
export interface ChangeSection {
  title: string;
  groups: ChangeGroup[];
}
export interface ChangeRelease {
  version: string;
  date?: string;
  intro: string;
  sections: ChangeSection[];
}

/** Where the changelog is: next to the bundle (dist/CHANGELOG.md), or the repository root in development. */
export function findChangelog(): string | null {
  const cands = [process.env.TEAMBOT_CHANGELOG, ...['../CHANGELOG.md', '../../../CHANGELOG.md', '../../CHANGELOG.md'].map((rel) => fileURLToPath(new URL(rel, import.meta.url)))];
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  return null;
}

/** Plain text: no **bold**, *italic*, `code` or [link](url) marks. */
export function plainMarkdown(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseChangelog(md: string): ChangeRelease[] {
  const out: ChangeRelease[] = [];
  let rel: ChangeRelease | null = null;
  let sec: ChangeSection | null = null;
  let grp: ChangeGroup | null = null;
  let item: string[] | null = null;
  const flushItem = () => {
    if (item && grp) grp.items.push(plainMarkdown(item.join(' ')));
    item = null;
  };
  const group = () => {
    if (!sec) {
      sec = { title: 'Wijzigingen', groups: [] };
      rel!.sections.push(sec);
    }
    if (!grp) {
      grp = { items: [] };
      sec.groups.push(grp);
    }
    return grp;
  };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h2 = line.match(/^##\s+\[?(\d+\.\d+\.\d+(?:-[\w.]+)?)\]?\s*(?:[—–-]\s*(.+))?$/);
    if (h2) {
      flushItem();
      rel = { version: h2[1], date: h2[2]?.trim(), intro: '', sections: [] };
      out.push(rel);
      sec = null;
      grp = null;
      continue;
    }
    if (!rel) continue;
    if (/^##\s/.test(line)) {
      // Another level-2 heading ("Onuitgebracht"): stop collecting for the current release.
      flushItem();
      rel = null;
      continue;
    }
    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) {
      flushItem();
      sec = { title: plainMarkdown(h3[1]), groups: [] };
      rel.sections.push(sec);
      grp = null;
      continue;
    }
    const bold = line.match(/^\*\*(.+)\*\*\s*$/);
    if (bold && sec) {
      flushItem();
      grp = { title: plainMarkdown(bold[1]), items: [] };
      sec.groups.push(grp);
      continue;
    }
    const li = line.match(/^\s*[-*]\s+(.+)$/);
    if (li) {
      flushItem();
      group();
      item = [li[1]];
      continue;
    }
    if (item && /^\s{2,}\S/.test(line)) {
      item.push(line.trim());
      continue;
    }
    if (!line.trim()) {
      flushItem();
      continue;
    }
    if (!sec) rel.intro = plainMarkdown(`${rel.intro} ${line}`);
  }
  flushItem();
  for (const r of out) for (const s of r.sections) s.groups = s.groups.filter((g) => g.items.length);
  for (const r of out) r.sections = r.sections.filter((s) => s.groups.length);
  return out;
}

/** The releases after `from` up to and including `to` (newest first); just `to` when `from` is unknown. */
export function whatsNew(to: string, from?: string, md?: string): ChangeRelease[] {
  let text = md;
  if (text === undefined) {
    const f = findChangelog();
    if (!f) return [];
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      return [];
    }
  }
  const all = parseChangelog(text);
  const list = from ? all.filter((r) => compareVersions(r.version, from) > 0 && compareVersions(r.version, to) <= 0) : all.filter((r) => r.version === to);
  return list.sort((a, b) => compareVersions(b.version, a.version)).slice(0, 5);
}
