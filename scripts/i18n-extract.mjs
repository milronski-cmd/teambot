// Extracts user-facing Dutch strings from the UI (and server error/event texts) into i18n/strings.json.
// Template literals become patterns with {0},{1}… placeholders. Usage: node scripts/i18n-extract.mjs
// As a module: extractStrings(root) → Map<text, Set<file>> (the translate script uses the files as context).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DUTCH = /\b(de|het|een|en|van|voor|niet|geen|met|op|je|jouw|bot|bots|wordt|worden|is|zijn|naar|bij|nog|alle|alleen|kies|maak|opslaan|verwijderen|toevoegen|bewerken|instellingen|gesprek|bericht|groep|sleutel|terug|annuleren|klaar|fout|bezig|leeg|nieuwe?|koppel|stoppen|starten|vragen|toestaan|weigeren|meer|over|wat|wie|waar|hoe|als|dan|ook|zoals|om|uit|aan|of|dit|deze|die|dat|kan|mag|moet|gebruik|gebruikt|bekijk|open|sluiten|zoeken|vandaag|gisteren|min|uur|dag|dagen)\b|[ëéèïöüĳ]/i;
const SKIP = /^(https?:|#\/|\/api|\.\/|\.\.\/|[a-z]+:[a-z]|[\w.-]+\.(ts|tsx|js|json|md|png|svg)$)|^[\w-]+(\s+[\w:/[\]().%#-]+)*$/;

/**
 * Dutch words beyond the short DUTCH list: every lowercase word (4+ letters) of the Dutch source texts that the English
 * translations never use ("abonnement", "betaald", "lokaal", "gevonden", "licentie"). Built from the previous
 * i18n/strings.json and ui/src/i18n/en.json, so texts with only such words ("lokaal, gratis", "nog downloaden",
 * "(aanbevolen)") are no longer missed (acceptance round 4, C-15).
 */
let VOCAB = new Set();
const plainText = (s) => String(s).replace(/\{\d+[^{}]*(\{[^{}]*\}[^{}]*)*\}|https?:\/\/\S+|`[^`]*`|\S*[\\/]\S*/g, ' ');
/** Words of the English translations (ui/src/i18n/en.json values). */
function englishWords(en) {
  // Everything in an English translation counts, code and commands included ("winget", "npx"): never Dutch evidence.
  const out = new Set();
  for (const [k, v] of Object.entries(en)) if (typeof v === 'string' && v !== k) for (const w of String(v).toLowerCase().match(/\p{L}+/gu) || []) out.add(w);
  return out;
}
function dutchVocabulary(sources, english) {
  const out = new Set();
  for (const s of sources) for (const w of plainText(s).match(/(?<![\p{L}\d_-])\p{Ll}{4,}(?![\p{L}\d_])/gu) || []) if (!english.has(w)) out.add(w);
  return out;
}
const hasVocab = (t) => (t.toLowerCase().match(/\p{L}{4,}/gu) || []).some((w) => VOCAB.has(w));

/** Separators around a text fragment (" · weer beschikbaar", "— nog downloaden", ". Bots met …"): not part of the text. */
const EDGE = /^[\s·•—–|,;:.)]+|[\s·•—–|,;:(]+$/g;

/** One CSS class: a utility with a known prefix ("px-2", "min-w-[12.5rem]", "tb-in"), a plain one ("relative"), an
 * arbitrary property ("[overflow-wrap:anywhere]"), each optionally behind variants ("hover:", "desk:", "coarse:"). */
const CSS_VARIANT = /^(?:(?:hover|focus|focus-visible|focus-within|active|disabled|desk|coarse|fine|sm|md|lg|xl|2xl|dark|group-hover|group-focus|peer-[a-z-]+|first|last|odd|even|rtl|ltr|print|motion-safe|motion-reduce|aria-[a-z-]+|placeholder|before|after|open|empty):)+/;
const CSS_UTILITY = /^!?-?(?:p|px|py|pt|pb|pl|pr|ps|pe|m|mx|my|mt|mb|ml|mr|ms|me|w|h|min-w|max-w|min-h|max-h|size|gap|gap-x|gap-y|space-x|space-y|text|bg|border|border-[trblxyse]|rounded|rounded-[a-z]+|z|duration|ease|delay|items|justify|self|place-items|place-content|content|flex|grid-cols|grid-rows|col-span|row-span|inset|inset-[xy]|top|left|right|bottom|start|end|leading|tracking|font|opacity|shadow|ring|ring-offset|outline|overflow|overflow-[xy]|whitespace|break|line-clamp|translate-[xy]|scale|rotate|order|basis|grow|shrink|aspect|object|cursor|select|pointer-events|fill|stroke|decoration|underline-offset|divide|divide-[xy]|transition|animate|tb)-[\w./%()[\],+#-]+$/;
const CSS_WORDS = new Set(['relative', 'absolute', 'fixed', 'sticky', 'static', 'flex', 'grid', 'block', 'inline', 'inline-block', 'inline-flex', 'hidden', 'contents', 'border', 'underline', 'truncate', 'italic', 'uppercase', 'lowercase', 'capitalize', 'transition', 'shadow', 'rounded', 'grow', 'shrink', 'outline', 'ring', 'invisible', 'visible', 'isolate', 'antialiased', 'sr-only', 'not-sr-only', 'container', '@container', 'group', 'peer']);
function cssClass(w) {
  const core = w.replace(CSS_VARIANT, '');
  return CSS_WORDS.has(core) || CSS_UTILITY.test(core) || /^\[[^\]\s]+\]$/.test(core) || (core !== w && /^-?[a-z][\w-]*$/.test(core));
}
export function isStyleCode(t) {
  return (
    /^<(?:path|ellipse|circle|rect|line|polyline|polygon|g|svg|stop|radialGradient|linearGradient|defs|filter|fe[A-Z]\w*|mask|clipPath|use)\b[^]*>$/.test(t) ||
    /^(?:calc|min|max|clamp|var)\(.*\)$/.test(t) ||
    /^\((?:pointer|hover|any-pointer|any-hover|prefers-[a-z-]+|orientation|display-mode)\s*:[^()]*\)$/.test(t) ||
    t.split(' ').every(cssClass)
  );
}

function looksUser(s) {
  const t = s.trim();
  if (t.length < 2 || t.length > 800) return false;
  if (!/[a-zA-ZÀ-ÿ]{2}/.test(t)) return false;
  // Regular expressions for Dutch text in the server ("^(?:de|onze|mijn) …", "\\p{Lu}") are not interface text.
  if (/^\^|\\p\{|\(\?[:!=<]|\\[sdwb][*+?]/.test(t)) return false;
  // Pieces of code between two quotes of different strings ("null], ['Bron', r.bron ?", "iets gedaan') : you('",
  // "gewijzigd'"), route ids ("memory/beoordelen"), anchors ("#inhoud"), a member access closing a call
  // ("bot.mayNot), list(lead ?") and an attribute of a prompt tag ('datum="{0}"').
  if (/\bnull\]|\]\s*,\s*\[|\[\];|'\)|\('|'\}|\}\s*'|===|!==|\?\s*'|'\s*:\s|\/g,|^#\w|^[a-z]+\/[a-z-]+$|\(\);|= new \w|\breadonly\b|^'[\w-]+'$|\btr\(\w|\) : \w|\b[a-z]\w*\.[a-z]\w*\),|^[a-z]+="\{\d+\}"$/.test(t) || (/\p{L}'$/u.test(t) && !/^'/.test(t))) return false;
  // Commands and example paths ("winget install …", "type binnen.txt & …", "C:\Users\…\mijn-skill") stay as they are.
  if ((/^(winget|npm|npx|pip|pipx|brew|curl|git|cat|echo|type \S+\.\w+)\s/.test(t) && !DUTCH.test(t.replace(/^\S+/, ''))) || /^[A-Z]:\\/.test(t)) return false;
  // A Dutch word on its own, in lower case ("abonnement", "betaald", "rustig"): a label or badge.
  if (/^\p{Ll}{4,}$/u.test(t) && VOCAB.has(t)) return true;
  if (/^[a-z][a-zA-Z0-9_.]*$/.test(t)) return false; // identifiers
  // Code-like: braces/tags, arrows, assignments without spaces, "a;b". Prose with "; " or " = " is fine, and so is a
  // sentence that mentions a flag or an argument ("(--acp=true)", "vllm serve <model>").
  const prose = /\s/.test(t) && /^[A-Za-zÀ-ÿ(]/.test(t) ? t.replace(/--[\w-]+=\S+?(?=[)\s,.]|$)|<[a-z][\w-]*>/g, '') : t;
  if (/[{}<>]|=>|==|\bclassName\b|;\S|[^\s=!<>]=|=[^\s=]/.test(prose) && !/\{(\d+|h|is)\}/.test(t)) return false;
  // Fragments of source code that a quote-to-quote match picked up.
  // ("import"/"export" only as code: "de import uit OpenBot ongedaan gemaakt" is a sentence.)
  if (/\b(const|let|return|await|function|typeof|useState|useRef|useEffect|throw)\b|\bexport (?:const|let|function|default|class|type|interface|async|\{)|\bimport (?:\{|\*|type |[\w$]+ from )|=>|&&|\|\||\?\?|\);\s*$|\);\s*(const|let|if|for|return|await|[a-z_$][\w$.]*\()|\$\{|`|\\n|\?\.|\w\(\)|^[\]|&;+]|\(\s*$|\bAND \w+ = \?/.test(t)) return false;
  if (/^(bg|text|border|rounded|flex|grid|h|w|p|m|px|py|mt|mb|gap|space|items|justify|min|max|shrink|truncate|font|hover|focus|sm|md|lg|absolute|relative|fixed|inline|block|hidden|overflow|scroll|z|top|left|right|bottom|start|end|ring|shadow|opacity|transition|animate|cursor|select|line|whitespace|break|col|row|order|self|place|content|object|aspect|leading|tracking|uppercase|underline|italic|sr-only|outline|resize|appearance|pointer|-?translate|inset|backdrop|fill|stroke)[-:\s/[]/.test(t)) return false;
  if (SKIP.test(t) && !/\s/.test(t)) return false;
  // SQL and other code that happens to contain Dutch-looking words.
  if (/^(ALTER|CREATE|SELECT|INSERT|UPDATE|DELETE|DROP)\s+[A-Z]/.test(t)) return false;
  if (/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH|REPLACE)\b[\s\S]*\b(FROM|INTO|SET|WHERE|VALUES)\b/.test(t)) return false;
  if (/^(AND|OR|WHERE) ([\w.]+ (=|<|>|IS\b|IN\b|LIKE\b)|\()/.test(t) || /^((LEFT |INNER )?JOIN \w+|(ORDER|GROUP) BY\b|PRAGMA [a-z]+_\w+|COALESCE\()/.test(t) || /\bLIMIT \? OFFSET \?/.test(t)) return false;
  // Media queries, user agents, MIME headers, schema ids, e-mail addresses, CLI flags and app paths.
  if (/^\((min|max)-(width|height):/.test(t) || /^Mozilla\/\d/.test(t) || /^attachment;/.test(t) || /^[\w.-]+\/v\d+$/.test(t)) return false;
  if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(t) || /^--?[a-z][\w-]*\.?$/.test(t) || /^\/[\w{}/.?=&-]+$/.test(t)) return false;
  // TypeScript fragments that a quote-to-quote match picked up ("React.ReactNode[]; fields: …", "T | undefined, ):").
  if (/\w\[\];|\|\s*undefined\b|\bstatic async\b|\.toLocale\w+\(|\(\(\w+\)|: Promise\b/.test(t)) return false;
  // A condition between two JSX branches ("NAMED.has(p.kind) ?"): a method call followed by the "?" of a choice.
  if (/^[\w.]+\.\w+\([\w.,\s]*\)\s*\?$/.test(t)) return false;
  // Class fields ("null = null; private stream: MediaStream | null = null; …") and type helpers ("ReturnType").
  if (/\b(private|protected|readonly) \w+\??: |\| null = null\b|\bReturnType\b/.test(t)) return false;
  // Drawing and styling code: SVG markup ("<ellipse cx=\"{0}\" …/>"), CSS values ("calc(100vw - 700px)"), media
  // features ("(pointer: coarse)") and class lists with variants or arbitrary values ("@container flex h-[60px] …",
  // "coarse:-my-3", "[overflow-wrap:anywhere]"). Never interface text, and no language can "translate" them.
  if (isStyleCode(t)) return false;
  // An API route on its own ("PATCH /skills/:id", "GET /folders/browse"): a key in a route table, never shown.
  if (/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \/[\w/:{}.*-]*$/.test(t)) return false;
  // A shell line that starts with an environment variable ("ELECTRON_RUN_AS_NODE=1 exec {0}{1} \"$@\""): a script.
  if (/^[A-Z][A-Z0-9_]*=\S+ \S/.test(t)) return false;
  // Tailwind class lists ("mx-auto flex min-h-full …") and paths/URLs with a file name ("{0}/de/de_DE/….onnx").
  const words = t.split(' ');
  if (words.length > 1 && words.every((w) => /^[a-z0-9:[\]/.%#_()!-]+$/.test(w)) && words.filter((w) => w.includes('-')).length >= 2 && !DUTCH.test(t.replace(/[\w:/[\].%#()!]+-[\w:/[\].%#()!-]+/g, ''))) return false;
  if (!/\s/.test(t) && /\//.test(t) && /\.[a-z]{2,5}(\?\w+)?$/.test(t)) return false;
  // A thing and what is done to it ("{0} heropenen", "{0} later starten"): a placeholder and a Dutch infinitive.
  if (/^\{\d+\}(?: [a-zà-ÿ]+){1,3}$/.test(t) && /[a-zà-ÿ]{2,}en$/.test(t)) return true;
  // must look Dutch: a common Dutch word, Dutch diacritics, a word only Dutch texts use, or a capitalised phrase
  return DUTCH.test(t) || hasVocab(t) || (/\s/.test(t) && /^[A-Z]/.test(t) && !/^[A-Z][a-z]+[A-Z]/.test(t));
}

/** Interface labels in the UI ("AI-providers", "Kosten", "lokaal, gratis") as values of these keys, also without Dutch words. */
const LABEL_KEYS = /\b(label|title|text|hint|description|placeholder|subtitle|tooltip|heading|summary|note|empty|cta)\s*:\s*(['"])((?:\\.|(?!\2)[^\\\n])*)\2/g;

// Comments are not interface text (block comments and whole-line // comments; URLs inside strings stay intact).
// (A backtick inside a regular expression, "/[`*]/g", is handled by templateLiterals, which skips regex literals; the
// old fix here also took a backtick out of any array without quotes, "[a, b ? `${x}==${y}` : x]", and broke the
// templates after it — acceptance round 5, C-15.)
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * Every template literal in a source, also the ones inside another one's ${…} (`{h} gemaakt${n ? ` (${n} items)` : ''}`):
 * [{ start, pat, count }] with ${…} as {0}, {1} … A regex stops at the first inner backtick and returns a broken piece.
 */
export function templateLiterals(src) {
  const out = [];
  const n = src.length;
  // A regular expression literal at `i` (a slash after an operator, a bracket or a keyword; after a name, a number or
  // ")" it is a division): its closing slash, or -1. A backtick or quote inside one (/please\s+[`'"]?log ?in/,
  // .replace(/"/g, …)) started a string or template there, and every template after it in the file was read inside
  // out (acceptance round 5, C-15: the engine errors of plainEngineError — free limit, not logged in, not found —
  // were never extracted and stayed Dutch).
  const regexEnd = (i) => {
    if (src[i] !== '/' || src[i + 1] === '/' || src[i + 1] === '*') return -1;
    let p = i - 1;
    while (p >= 0 && (src[p] === ' ' || src[p] === '\t')) p--;
    if (!(p < 0 || '(,=:[!&|?{};\n+-*%~^'.includes(src[p]) || /\b(return|typeof|case|in|of)$/.test(src.slice(Math.max(0, p - 6), p + 1)))) return -1;
    let k = i + 1;
    let cls = false;
    while (k < n && src[k] !== '\n') {
      const d = src[k];
      if (d === '\\') {
        k += 2;
        continue;
      }
      if (d === '[') cls = true;
      else if (d === ']') cls = false;
      else if (d === '/' && !cls) return k;
      k++;
    }
    return -1;
  };
  // From the backtick at `start`: the template's end index, or -1.
  const parse = (start) => {
    let j = start + 1;
    let pat = '';
    let count = 0;
    while (j < n) {
      const c = src[j];
      if (c === '\\') {
        pat += src.slice(j, j + 2);
        j += 2;
        continue;
      }
      if (c === '`') {
        out.push({ start, pat, count });
        return j;
      }
      if (c === '$' && src[j + 1] === '{') {
        let depth = 1;
        let k = j + 2;
        while (k < n && depth > 0) {
          const d = src[k];
          if (d === '`') {
            const end = parse(k);
            if (end < 0) return -1;
            k = end + 1;
            continue;
          }
          if (d === "'" || d === '"') {
            k++;
            while (k < n && src[k] !== d && src[k] !== '\n') k += src[k] === '\\' ? 2 : 1;
            k++;
            continue;
          }
          const re = d === '/' ? regexEnd(k) : -1;
          if (re > 0) {
            k = re + 1;
            continue;
          }
          if (d === '{') depth++;
          else if (d === '}') depth--;
          k++;
        }
        pat += `{${count++}}`;
        j = k;
        continue;
      }
      pat += c;
      j++;
    }
    return -1;
  };
  for (let i = 0; i < n; i++) {
    const c = src[i];
    // Quoted strings on one line are skipped, so a backtick inside '…' starts nothing.
    if (c === "'" || c === '"') {
      let k = i + 1;
      while (k < n && src[k] !== c && src[k] !== '\n') k += src[k] === '\\' ? 2 : 1;
      if (src[k] === c) i = k;
      continue;
    }
    // Regular expression literals too (see regexEnd).
    const re = c === '/' ? regexEnd(i) : -1;
    if (re > 0) {
      i = re;
      continue;
    }
    if (c === '`') {
      const end = parse(i);
      if (end > 0) i = end;
    }
  }
  return out;
}

function listFiles(dir, re, skipDirs = []) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!['node_modules', 'dist', ...skipDirs].includes(e.name)) walk(p);
      } else if (re.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
    }
  })(dir);
  return out;
}

/**
 * All interface texts in the source: Map<text, Set<relative file>>. The Dutch vocabulary starts from the texts the
 * English dictionary has and grows with what this run finds, until nothing new is found (the same result every run
 * for the same source and dictionary).
 */
export function extractStrings(root = process.cwd()) {
  let en = {};
  try {
    en = JSON.parse(fs.readFileSync(path.join(root, 'ui', 'src', 'i18n', 'en.json'), 'utf8'));
  } catch {
    /* no dictionary yet: the common Dutch words only */
  }
  const english = englishWords(en);
  let sources = Object.keys(en);
  let result;
  for (let round = 0; round < 5; round++) {
    VOCAB = dutchVocabulary(sources, english);
    result = extractOnce(root);
    const found = [...result.strings.keys()];
    if (dutchVocabulary(found, english).size <= VOCAB.size) break;
    sources = [...new Set([...sources, ...found])];
  }
  return result;
}

function extractOnce(root) {
  // Interface texts: the UI itself and the code it shares with the server and the desktop shell (shared/).
  const files = [...listFiles(path.join(root, 'ui', 'src'), /\.(tsx?|mjs)$/, ['i18n']), ...listFiles(path.join(root, 'shared'), /\.ts$/)];
  // The desktop shell (tray menu, notifications, taskbar badge) uses the server's dictionaries too.
  const serverFiles = [...listFiles(path.join(root, 'server'), /\.ts$/), ...listFiles(path.join(root, 'desktop'), /\.ts$/)];
  const out = new Map();
  let file = '';
  const put = (t) => {
    // The security log's sentences say {h}/{is} for "hebt/heeft", "bent/is" (filled per actor): one text per form.
    if (/\{(h|is)\}/.test(t)) {
      put(t.replace(/\{h\}/g, 'hebt').replace(/\{is\}/g, 'bent'));
      put(t.replace(/\{h\}/g, 'heeft').replace(/\{is\}/g, 'is'));
      return;
    }
    if (!out.has(t)) out.set(t, new Set());
    out.get(t).add(file);
  };
  const add = (s) => {
    const t = s.replace(/\s+/g, ' ').trim().replace(EDGE, '');
    // "{h} {0}{1}" is a sentence once {h} is filled in ("hebt {0}{1}").
    if (looksUser(t.replace(/\{h\}/g, 'hebt').replace(/\{is\}/g, 'bent'))) put(t);
  };
  // Single words: JSX text between tags is always user text; string literals only when capitalised (labels such as
  // 'Opslaan', 'Instellingen'), never camelCase or ALL-CAPS identifiers.
  const addWord = (s, jsx) => {
    const t = s.replace(/\s+/g, ' ').trim();
    // A leading "-" is a command-line flag ("--token"), not a word.
    if (out.has(t) || !/^[A-Za-zÀ-ÿ’'][A-Za-zÀ-ÿ’'-]{1,39}[.:!?…]?$/.test(t)) return;
    if (jsx || /^[A-ZÀ-Ý][a-zà-ÿ’'-]+[.:!?…]?$/.test(t)) put(t);
  };
  // Explicit translation calls: t('…', …) in the UI, tr(lang, '…', …) / trUser(store, id, '…', …) on the server, and
  // TeamBot's words with someone's words in them (words('Taak aan {0}: {1}', …), tOwn / ownText('…', …) and
  // <Words text="was: {0}" …/>), also lower case and also when no word in them looks Dutch.
  const addCalls = (src) => {
    // A file with its own local `words` (a word list helper, voice/textlang.ts) does not call TeamBot's words().
    const ownWords = /\b(?:const|let|var|function)\s+words\b/.test(src) && !/\bimport\b[^;]*\bwords\b[^;]*\bfrom\b/.test(src);
    const calls = ownWords
      ? /(?<![\w.$])(?:t\(|tOwn\(|ownText\(|tr\(\s*[^,()]+,|trUser\(\s*[^,()]+,\s*[^,()]+,)\s*(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g
      : /(?<![\w.$])(?:t\(|words\(|tOwn\(|ownText\(|tr\(\s*[^,()]+,|trUser\(\s*[^,()]+,\s*[^,()]+,)\s*(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g;
    for (const m of src.matchAll(calls)) {
      const t = m[2].replace(/\\(['"])/g, '$1').replace(/\s+/g, ' ').trim();
      if (t && /[A-Za-zÀ-ÿ]{2}/.test(t)) put(t);
    }
    for (const m of src.matchAll(/<Words\b[^<>]*?\btext=(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
      const t = m[2].replace(/\s+/g, ' ').trim();
      if (t && /[A-Za-zÀ-ÿ]{2}/.test(t)) put(t);
    }
  };

  for (const f of files) {
    file = path.relative(root, f).replace(/\\/g, '/');
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    addCalls(src);
    // JSX text between tags
    for (const m of src.matchAll(/>([^<>{}`]*[A-Za-zÀ-ÿ][^<>{}`]*)</g)) {
      add(m[1]);
      addWord(m[1], true);
    }
    // JSX text fragments mixed with expressions: split on {...}
    for (const m of src.matchAll(/>([^<>]*\{[^<>]*\}[^<>]*)</g))
      for (const part of m[1].split(/\{[^{}]*\}/)) {
        add(part);
        addWord(part, true);
      }
    // JSX text right after a tag up to an expression, or after an expression up to a tag ("Gevonden: {list}")
    const CODE = /[`'"\\]|\b(const|let|return|if|for|await|async|function|typeof)\b|useState|=>|&&|\|\||\?\?|\w\(|\)\s*[;,)]|\[\]|^\s*[)\],.;:+]/;
    for (const m of src.matchAll(/>([^<>{}]*[A-Za-zÀ-ÿ][^<>{}]*)\{/g)) if (!CODE.test(m[1])) add(m[1]);
    // A sentence that goes on after an expression (". Bots met een reserve-engine schakelen vanzelf over.") is text too.
    for (const m of src.matchAll(/\}([^<>{}]*[A-Za-zÀ-ÿ][^<>{}]*)</g)) if (!CODE.test(m[1]) || (/^\s*[.,;:]\s+\p{L}/u.test(m[1]) && !CODE.test(m[1].replace(/^\s*[.,;:]/, '')))) add(m[1]);
    // string literals
    for (const m of src.matchAll(/(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
      add(m[2].replace(/\\(['"])/g, '$1'));
      addWord(m[2], false);
    }
    // Labels as values of label/title/hint/… keys ("AI-providers", "CLI-agents"), also without a Dutch word.
    for (const m of src.matchAll(LABEL_KEYS)) {
      const t = m[3].replace(/\\(['"])/g, '$1').replace(/\s+/g, ' ').trim();
      if (/[A-ZÀ-Ý]/.test(t) && /\p{Ll}{2}/u.test(t) && !/^[a-z]+[A-Z]\w*$/.test(t) && !/[{}<>=;`]|^\w+:\/\/|^[#./]/.test(t)) put(t);
    }
    // template literals → pattern (also the ones nested in another template's ${…})
    for (const { pat, count } of templateLiterals(src)) if (count < 6) add(pat);
  }
  for (const f of serverFiles) {
    file = path.relative(root, f).replace(/\\/g, '/');
    // A constant named …PROMPT… holds text only the bots read ("export const PLAIN_TOOLS_PROMPT = '…'"): not interface.
    const src = stripComments(fs.readFileSync(f, 'utf8')).replace(/(\b[A-Z][A-Z0-9_]*PROMPT[A-Z0-9_]*\s*=\s*)(['"`])(?:\\.|(?!\2)[^\\])*\2/g, '$1$2$2');
    addCalls(src);
    for (const m of src.matchAll(/\b(?:bad|notFound|HttpError\(\s*\d+\s*,|new Error|new ChannelError|new HttpLike\(\s*\d+\s*,)\(?\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
      let i = 0;
      const pat = m[2].replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, () => `{${i++}}`);
      add(pat);
    }
    // Texts the server sends to the UI as data: provider/template descriptions, capability details, labels.
    // (Template literals as values: see the template loop below, which also reads nested ones.)
    // (Also under a quoted key: `'run-after': '{0} later starten'` in a table of actions.)
    for (const m of src.matchAll(/(?:\b[A-Za-z_]\w*|(['"])[\w-]+\1)\s*:\s*(['"])((?:\\.|(?!\2)[^\\])*)\2/g)) {
      if (m[3].length > 400) continue; // long texts (bot instructions) are prompts, not interface
      let i = 0;
      const pat = m[3].replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, () => `{${i++}}`).replace(/\\(['"`])/g, '$1');
      add(pat);
      addWord(pat, false);
    }
    // Other capitalised sentences in quotes (session names, status texts passed as arguments), also with the other
    // kind of quote inside ('Gebruik "Telefoon via Tailscale instellen", dan regelt TeamBot het.').
    for (const m of src.matchAll(/'([A-ZÀ-Ý][^'\\\n]{3,600})'|"([A-ZÀ-Ý][^"\\\n]{3,600})"/g)) {
      const s = m[1] ?? m[2];
      if (/\s/.test(s)) add(s);
    }
    // What a function returns as text (a problem, a reason, a label): `return 'Lezen: …'`, also when it is long.
    for (const m of src.matchAll(/\breturn\s+(['"])((?:\\.|(?!\1)[^\\])*)\1/g)) if (m[2].length <= 800 && !/\n/.test(m[2])) add(m[2].replace(/\\(['"])/g, '$1'));
    // One sentence per form: the form for one is often a plain string in a choice (`n === 1 ? '1 routine staat uit. Zet
    // hem aan …' : `${n} routines staan uit. …``). Only the template was found, so "1 routine staat uit" stayed Dutch in
    // every other language while "3 routines" was translated (acceptance round 6).
    for (const m of src.matchAll(/\?\s*(['"])((?:\\.|(?!\1)[^\\\n])*?(?<![\w.,])1 \p{Ll}(?:\\.|(?!\1)[^\\\n])*)\1/gu)) if (m[2].length <= 600) add(m[2].replace(/\\(['"])/g, '$1'));
    // Template literals passed as arguments (chat event lines, notices): "${name} heeft het maximum van … bereikt",
    // as the branches of a choice (one sentence per plural form: `n === 1 ? `…1 herinnering…` : `…herinneringen…``),
    // as a return value (`return `Het lokale spraakmodel is nog niet gedownload (${mb}). …``) or as a value in an
    // object (`body: `…``); also when nested in another template.
    for (const { start, pat, count } of templateLiterals(src)) {
      const before = src.slice(Math.max(0, start - 40), start);
      const asValue = /\b[A-Za-z_]\w*\s*:\s*$/.test(before);
      const returned = /\breturn\s*$/.test(before);
      if (!asValue && !returned && !/(?:[(,[]|[^?]\?|\s:|\$\{)\s*$/.test(before)) continue;
      // Prompt lines for the bots ("- Gebruik …", "## …", "(Dit is een routine-run …") and HTML are not interface.
      if (pat.length > (returned ? 800 : asValue ? 400 : 300) || /\n/.test(pat) || /^\s*(- |#|<|\(Dit is|\[)/.test(pat)) continue;
      if (count < 6 && /\s/.test(pat) && /[a-zà-ÿ]{3}/.test(pat.replace(/\{\d+\}/g, ''))) add(pat.replace(/\\(['"`])/g, '$1'));
    }
  }
  return { strings: out, fileCount: files.length, serverCount: serverFiles.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const root = process.cwd();
  const { strings, fileCount, serverCount } = extractStrings(root);
  const list = [...strings.keys()].sort();
  fs.mkdirSync(path.join(root, 'i18n'), { recursive: true });
  fs.writeFileSync(path.join(root, 'i18n', 'strings.json'), JSON.stringify(list, null, 1));
  console.log(`${list.length} teksten uit ${fileCount} UI- en ${serverCount} serverbestanden.`);
}
