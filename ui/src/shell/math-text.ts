/**
 * Formula detection and preparation for chat answers (shell/math.ts loads KaTeX when hasMath is true). Kept apart from
 * the loader, without its stylesheet import, so it also works outside Vite (tests/chat-math.test.ts).
 */

/** Code blocks (also an unclosed fence while streaming) and inline code: never touched. */
const CODE = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/g;

function outsideCode(text: string, fn: (s: string) => string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(CODE)) {
    out += fn(text.slice(last, m.index)) + m[0];
    last = m.index! + m[0].length;
  }
  return out + fn(text.slice(last));
}

const MATH = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(?<![\\$\w])\$(?![\s\d$])[^$\n]+?(?<![\s\\])\$(?![\d$])/;

/** Does the text contain a formula outside code: $$…$$, \[…\], \(…\), or $…$ that is not an amount ($5)? */
export function hasMath(text: string): boolean {
  if (!/[$\\]/.test(text)) return false;
  let found = false;
  outsideCode(text, (s) => {
    if (!found && MATH.test(s)) found = true;
    return s;
  });
  return found;
}

/**
 * Prepare the text for remark-math, outside code: \[…\] and \(…\) (as many models write them) become $$…$$ and $…$, and
 * a single $ before an amount ($5, $ 10) stays a dollar sign instead of starting a formula.
 */
export function prepareMath(text: string): string {
  // amounts first, so a formula written as \(5x\) is not taken for one once it has become $5x$
  return outsideCode(text, (s) =>
    s
      .replace(/(?<![\\$])\$(?=\s?\d)/g, '\\$')
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => `\n$$\n${m.trim()}\n$$\n`)
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => `$${m.trim()}$`),
  );
}
