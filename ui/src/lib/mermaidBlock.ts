/**
 * When a code block in a chat answer is drawn as a Mermaid diagram. No imports: unit-tested directly, and the heavy
 * mermaid library itself is only loaded (lazily) once such a block really appears.
 */

/** ```mermaid (or ```mmd) fenced block: the language class react-markdown puts on the code element. */
export function isMermaidLang(className?: string | null): boolean {
  const lang = /(?:^|\s)language-([\w-]+)/.exec(className || '')?.[1]?.toLowerCase();
  return lang === 'mermaid' || lang === 'mmd';
}

/** Fence lines (``` or ~~~, optionally indented up to 3 spaces) in a markdown text, in order. */
function fences(markdown: string): { char: string; len: number; info: string }[] {
  const out: { char: string; len: number; info: string }[] = [];
  for (const line of String(markdown || '').split(/\r?\n/)) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (m) out.push({ char: m[1][0], len: m[1].length, info: m[2].trim() });
  }
  return out;
}

/**
 * True while the text ends inside an open code fence (the bot is still streaming that block): it is then shown as code
 * and not drawn yet. A closing fence uses the same character, is at least as long and has no info string.
 */
export function endsInOpenFence(markdown: string): boolean {
  let open: { char: string; len: number } | null = null;
  for (const f of fences(markdown)) {
    if (!open) open = f;
    else if (f.char === open.char && f.len >= open.len && !f.info) open = null;
  }
  return open !== null;
}

/** First word of a Mermaid diagram (after an optional `---` front matter or %% comments): enough to try drawing it. */
const KNOWN = /^(graph|flowchart|sequenceDiagram|classDiagram|classDiagram-v2|stateDiagram|stateDiagram-v2|erDiagram|journey|gantt|pie|quadrantChart|requirementDiagram|gitGraph|mindmap|timeline|zenuml|sankey|sankey-beta|xychart|xychart-beta|block|block-beta|packet|packet-beta|kanban|architecture|architecture-beta|radar|radar-beta|treemap|treemap-beta|venn|venn-beta|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|usecase|ishikawa|wardley)\b/;

export function looksLikeMermaid(code: string): boolean {
  const lines = String(code || '')
    .replace(/^\s*---[\s\S]*?\n---\s*\n/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('%%'));
  return !!lines.length && KNOWN.test(lines[0]);
}

/** Draw this block? A mermaid block that is complete (not the last, still open fence) and starts like a diagram. */
export function shouldDrawMermaid(o: { className?: string | null; code: string; markdown: string; isLastBlock: boolean }): boolean {
  if (!isMermaidLang(o.className)) return false;
  if (o.isLastBlock && endsInOpenFence(o.markdown)) return false;
  if (o.code.length > 50_000) return false;
  return looksLikeMermaid(o.code);
}

/** Width and height from an SVG's viewBox (to size it as an image), or null. */
export function svgSize(svg: string): { width: number; height: number } | null {
  const m = /<svg\b[^>]*\bviewBox\s*=\s*["']\s*[-\d.e]+[\s,]+[-\d.e]+[\s,]+([\d.e]+)[\s,]+([\d.e]+)\s*["']/i.exec(svg);
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  return width > 0 && height > 0 && isFinite(width) && isFinite(height) ? { width, height } : null;
}
