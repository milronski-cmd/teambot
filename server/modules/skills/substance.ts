import { splitFrontmatter } from './format.js';

/**
 * Does a skill do anything itself? Some published skills are only a pointer to another skill ("Call the Skill tool
 * with grilling", mattpocock/grill-me) or almost empty. Installed on their own they give the bot nothing, so the
 * install review warns first ("Deze skill doet zelf weinig: …"). A heuristic, never a block: the owner decides.
 */
export interface Substance {
  /** True when the skill has (almost) no instructions of its own. */
  thin: boolean;
  /** Words of instructions (headings and the frontmatter not counted). */
  words: number;
  /** Other skills it hands the work to, e.g. ["grilling"]. */
  pointsTo: string[];
  /** Dutch warning for the review, or null. */
  message: string | null;
}

/** Below this many words a skill that hands off to another skill is "only a pointer". */
const POINTER_MAX_WORDS = 60;
/** Below this many words (and no other files) a skill is "nearly empty". */
const EMPTY_MAX_WORDS = 15;

const NAME = String.raw`[\p{L}\p{N}][\p{L}\p{N}_:.-]{0,60}`;
const Q = String.raw`[\x60"'“”‘’*]*`;
const VERBS = String.raw`call|use|invoke|run|load|trigger|activate|launch|start|open|follow|see|read|apply|gebruik|roep|laad|start|volg|lees|zie`;
const POINTER_RES = [
  // "Call the Skill tool with grilling", "use the Skill tool for `grilling`"
  new RegExp(String.raw`\bskill[\s-]*tool\b[^.\n]{0,20}?\b(?:with|for|on|named|called|met|voor)\s+(?:the\s+|de\s+)?(?:skill\s+)?${Q}(${NAME})${Q}`, 'giu'),
  // "Use the grilling skill", "Follow the `brand-guidelines` skill", "Gebruik de skill grilling"
  new RegExp(String.raw`\b(?:${VERBS})\s+(?:the\s+|de\s+|het\s+)?${Q}(${NAME})${Q}\s+skill\b`, 'giu'),
  new RegExp(String.raw`\b(?:${VERBS})\s+(?:the\s+|de\s+|het\s+)?skill\s+${Q}(${NAME})${Q}`, 'giu'),
  // "Skill: grilling", "skill(grilling)"
  new RegExp(String.raw`\bskill\s*(?:[:=(])\s*${Q}(${NAME})${Q}`, 'giu'),
];
const NOT_A_NAME = new Set(['the', 'a', 'an', 'this', 'that', 'it', 'de', 'het', 'een', 'deze', 'die', 'tool', 'skill', 'skills', 'with', 'for', 'to', 'and', 'or', 'of', 'in', 'on', 'is', 'file', 'files', 'md', 'instructions', 'below', 'above', 'list', 'name', 'bestand', 'instructies', 'hieronder']);

/** Files that do not count as substance next to SKILL.md. */
const NOISE_FILE = /^(?:license|licence|copying|notice|readme|changelog|teambot-package)(?:\.[\w.]+)?$|(?:^|\/)\.[^/]+$/i;
/** Display metadata for other agent clients (e.g. agents/openai.yaml: the skill's name and icon in Codex), not instructions. */
const CLIENT_META = /^agents\/[^/]+\.(?:ya?ml|json|toml)$/i;

export function skillSubstance(skillMd: string, filePaths: string[] = [], ownName = ''): Substance {
  const { body } = splitFrontmatter(String(skillMd || ''));
  const text = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .split(/\r?\n/)
    .filter((l) => !/^\s{0,3}#{1,6}\s/.test(l))
    .join('\n');
  const words = (text.match(/[\p{L}\p{N}][\p{L}\p{N}_'’-]*/gu) || []).length;
  const own = ownName.toLowerCase();
  const pointsTo: string[] = [];
  for (const re of POINTER_RES) {
    for (const m of text.matchAll(re)) {
      const name = m[1].replace(/[.:]+$/, '');
      const low = name.toLowerCase();
      if (!name || NOT_A_NAME.has(low) || low === own || pointsTo.some((x) => x.toLowerCase() === low)) continue;
      pointsTo.push(name);
    }
  }
  const extraFiles = filePaths.filter((p) => p !== 'SKILL.md' && !NOISE_FILE.test(p.split('/').pop() || p) && !CLIENT_META.test(p));
  let message: string | null = null;
  if (pointsTo.length && words <= POINTER_MAX_WORDS && !extraFiles.length) {
    const list = pointsTo.slice(0, 3).map((n) => `“${n}”`);
    const names = list.length > 1 ? `${list.slice(0, -1).join(', ')} en ${list[list.length - 1]}` : list[0];
    message = `Deze skill doet zelf weinig: hij verwijst alleen naar de skill ${names}. Zonder ${pointsTo.length > 1 ? 'die skills' : 'die skill'} heeft je bot er niets aan; installeer liever ${pointsTo.length > 1 ? 'die' : 'die skill'} zelf (of allebei).`;
  } else if (words < EMPTY_MAX_WORDS && !extraFiles.length) {
    message = words === 1 ? 'Deze skill doet zelf weinig: de instructies zijn maar 1 woord lang en er zitten geen andere bestanden bij.' : `Deze skill doet zelf weinig: de instructies zijn maar ${words} woorden lang en er zitten geen andere bestanden bij.`;
  }
  return { thin: !!message, words, pointsTo, message };
}
