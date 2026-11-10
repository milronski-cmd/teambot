/**
 * Text in pieces for a searchable library (dossier sources). Own code, no library:
 *  - pieces of about `size` characters, split at paragraphs, then at sentence ends, then between words (never inside
 *    a word);
 *  - about 15 % overlap: a piece starts with the last sentence(s) of the one before, so an answer on the boundary is
 *    still found whole;
 *  - every piece knows where it is: a piece that does not start on its own page line or heading gets the page
 *    ("--- pagina 12 ---" from the pdf reader, "## Dia 3", "## Blad: Klanten") or last heading in front, so a bot can
 *    say "pagina 12";
 *  - at most `max` pieces (default 400; was 200).
 */

export interface ChunkOptions {
  size?: number;
  /** Share of `size` repeated from the previous piece (0–0.5). */
  overlap?: number;
  max?: number;
}

const PAGE = /^--- pagina (\d+) ---$/;
const HEADING = /^#{1,6} \S/;

/** Split one long paragraph into sentences, and a too-long sentence between words. */
function units(para: string, size: number): string[] {
  if (para.length <= size) return [para];
  const sentences = para.match(/[^.!?…\n]+(?:[.!?…]+["'”’)\]]*|\n|$)\s*/g) || [para];
  const out: string[] = [];
  for (const s of sentences) {
    if (s.length <= size) {
      out.push(s);
      continue;
    }
    let cur = '';
    for (const w of s.split(/(?<=\s)/)) {
      if (cur.length + w.length > size && cur) {
        out.push(cur);
        cur = '';
      }
      // A single "word" longer than a piece (a long url or a table row): cut it.
      if (w.length > size) for (let i = 0; i < w.length; i += size) out.push(w.slice(i, i + size));
      else cur += w;
    }
    if (cur) out.push(cur);
  }
  return out;
}

export function chunkText(text: string, size = 1200, o: ChunkOptions = {}): string[] {
  size = Math.max(200, o.size ?? size);
  const overlap = Math.max(0, Math.min(0.5, o.overlap ?? 0.15)) * size;
  const max = o.max ?? 400;
  const paras = text
    .replace(/\r/g, '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  // Pieces of text, each with the place it stands (page / heading) and whether it starts a paragraph.
  type Unit = { text: string; where: string; para: boolean; marker: boolean };
  const all: Unit[] = [];
  let page = '';
  let heading = '';
  for (const p of paras) {
    const first = p.split('\n')[0].trim();
    const pm = PAGE.exec(first);
    if (pm) {
      page = first;
      heading = '';
    } else if (HEADING.test(first)) heading = first.slice(0, 120);
    const where = [page, heading].filter(Boolean).join('\n');
    units(p, size).forEach((u, i) => all.push({ text: u.trim(), where, para: i === 0, marker: i === 0 && (!!pm || HEADING.test(first)) }));
  }
  const out: string[] = [];
  let cur: Unit[] = [];
  // Units in `cur` that are new (not carried over as overlap): only those make a piece worth writing.
  let fresh = 0;
  const len = (us: Unit[]) => us.reduce((n, u) => n + u.text.length + 2, 0);
  const flush = () => {
    if (!fresh) return;
    const body = cur.map((u, i) => (i && u.para ? '\n\n' : i ? ' ' : '') + u.text).join('');
    const where = cur[0].where;
    // Say where the piece is, unless it starts with that line itself.
    const prefix = where && !cur[0].marker ? `${where}\n` : '';
    out.push((prefix + body).trim());
    // Overlap: the last whole units of this piece (not its first) start the next one.
    const keep: Unit[] = [];
    for (let i = cur.length - 1; i > 0; i--) {
      if (len([cur[i], ...keep]) > overlap) break;
      keep.unshift({ ...cur[i], marker: false });
    }
    cur = keep.some((u) => u.text.length > 20) ? keep : [];
    fresh = 0;
  };
  for (const u of all) {
    if (out.length >= max) break;
    // A new page starts a new piece when the current one is already reasonably full.
    const newPage = u.marker && PAGE.test(u.text.split('\n')[0]);
    if (cur.length && (len(cur) + u.text.length > size || (newPage && len(cur) > size / 3))) {
      flush();
      // The overlap belongs to the previous place: not in front of a new page or heading, nor when it does not fit.
      if (u.marker || (cur.length && cur[0].where !== u.where) || len(cur) + u.text.length > size) cur = [];
    }
    cur.push(u);
    fresh++;
  }
  if (out.length < max) flush();
  return out.filter(Boolean).slice(0, max);
}
