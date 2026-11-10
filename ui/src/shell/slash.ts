/**
 * The "/" and "$" menu in the composer (pure helpers, unit-tested in tests/slash-menu.test.ts).
 *  - "/" at the start of a line: skills of this bot and a few commands ("Nieuw gesprek", "Zoeken in dit gesprek", …).
 *  - "$" after a space (or at the start): skills only, anywhere in the message ("schrijf dit met $brand-guidelines").
 * A picked skill stays in the message as "/name" or "$name"; the server tells the bot to load and follow that skill.
 */

export interface SlashToken {
  /** Index of the "/" or "$" in the text. */
  start: number;
  /** Index just after the typed query (the caret). */
  end: number;
  trigger: '/' | '$';
  query: string;
}

/** The "/word" or "$word" being typed at the caret, or null. */
export function slashToken(text: string, caret: number): SlashToken | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const m = /(^|\s)([/$])([^\s/$]{0,60})$/.exec(before);
  if (!m) return null;
  const trigger = m[2] as '/' | '$';
  const start = before.length - m[3].length - 1;
  // "/" only where a command can start (beginning of a line), so "rood / blauw" or a path never opens a menu.
  if (trigger === '/' && start > 0 && before[start - 1] !== '\n') return null;
  // "$5" or "$ 10" is money, not a skill.
  if (trigger === '$' && /^\d/.test(m[3])) return null;
  return { start, end: before.length, trigger, query: m[3] };
}

export interface MenuItem {
  kind: 'skill' | 'command';
  id: string;
  /** Skill name ("brand-guidelines") or command label ("Nieuw gesprek"). */
  label: string;
  description?: string;
  /** Extra words that find a command ("stop", "zoek", …). */
  keywords?: string[];
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** Items that match the query: names starting with it first, then names containing it, then descriptions. */
export function filterItems<T extends MenuItem>(items: T[], query: string, limit = 30): T[] {
  const q = fold(query.trim());
  if (!q) return items.slice(0, limit);
  const score = (it: T) => {
    const name = fold(it.label);
    const words = [name, ...(it.keywords || []).map(fold)];
    if (words.some((w) => w.startsWith(q))) return 0;
    if (name.split(/[\s_-]+/).some((w) => w.startsWith(q))) return 1;
    if (words.some((w) => w.includes(q))) return 2;
    if (fold(it.description || '').includes(q)) return 3;
    return 9;
  };
  return items
    .map((it, i) => ({ it, s: score(it), i }))
    .filter((x) => x.s < 9)
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.it);
}

/** Text and caret after picking: a skill becomes "/name " or "$name "; a command removes what was typed. */
export function applyPick(text: string, token: SlashToken, item: MenuItem): { text: string; caret: number } {
  const head = text.slice(0, token.start);
  const tail = text.slice(token.end).replace(/^[^\s]*/, '');
  if (item.kind === 'command') {
    const t = (head + tail.replace(/^ /, '')).replace(/^\s+$/, '');
    return { text: t, caret: head.length };
  }
  const ins = `${token.trigger}${item.label} `;
  const rest = tail.replace(/^ /, '');
  return { text: head + ins + rest, caret: head.length + ins.length };
}
