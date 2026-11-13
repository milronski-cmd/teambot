// TeamBot website builder — no framework. Renders website/src (one template + nl.json/en.json) to website/dist.
// Usage: npm run website:build   (= node --import tsx website/build.mjs; tsx is needed to import ui/src/lib/botface.ts)
// Env: TEAMBOT_SITE_URL   absolute site address (https://…, no trailing slash) → canonical, hreflang, og:url, og:image,
//                         sitemap.xml and robots.txt
//      TEAMBOT_REPO_URL   public repository (https://github.com/<org>/teambot) → source, licence and release links
//      TEAMBOT_SHA256SUMS the SHA256SUMS.txt of the published release (made by .github/workflows/release.yml) → the
//                         download page shows the installer's SHA-256; without it the page says where to find it
//      TEAMBOT_FEATURES_OFF  comma list of features from src/release.json to switch off for this build ("all" = all)
// Inputs besides the texts:
//   src/release.json  which 0.4 features ship. Any text object with "if": "<feature>" is left out when that feature is
//                     off, and one with "if": "!<feature>" only shows when it is off. So the site stays true if a
//                     feature slips: switch it off, rebuild.
//   src/shots.json    which image in src/img fills which screenshot slot (swap an image = replace the file).
// All links in the output are relative, so dist/ works from file:// and from any host or sub-folder.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const src = path.join(here, 'src');
const dist = path.join(here, 'dist');
const require = createRequire(path.join(repo, 'package.json'));
const { botSvg } = await import(pathToFileURL(path.join(repo, 'ui/src/lib/botface.ts')).href);
// micromark (MIT) is already installed with react-markdown; it turns docs/HANDLEIDING.md into HTML at build time.
const { micromark } = await import('micromark');
const { gfm, gfmHtml } = await import('micromark-extension-gfm');

const SITE_URL = (process.env.TEAMBOT_SITE_URL || '').replace(/\/+$/, '');
const REPO_URL = (process.env.TEAMBOT_REPO_URL || 'https://github.com/<org>/teambot').replace(/\/+$/, '');
const REPO_PLACEHOLDER = REPO_URL.includes('<org>');
const VERSION = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
const INSTALLER = `TeamBot-Setup-${VERSION}.exe`;
const MAC_FILE = `TeamBot-${VERSION}-mac-arm64.dmg`;
/** SHA-256 of this version's installer from the release's SHA256SUMS.txt; null when that file is not given. */
const SHA256 = (() => {
  const f = process.env.TEAMBOT_SHA256SUMS;
  if (!f) return null;
  const line = fs
    .readFileSync(path.resolve(f), 'utf8')
    .split(/\r?\n/)
    .map((l) => /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(l.trim()))
    .find((m) => m && m[2] === INSTALLER);
  if (!line) throw new Error(`${f} bevat geen SHA-256 voor ${INSTALLER}`);
  return line[1].toLowerCase();
})();
const LANGS = ['nl', 'en'];
const ALL_PAGES = ['home', 'features', 'compare', 'switch', 'pricing', 'privacy', 'faq', 'download', 'manual', 'opensource'];
/** Header menu (Download is the button next to it) and the two link columns in the footer. */
const NAV = ['features', 'compare', 'pricing', 'privacy', 'faq', 'manual'];
const FOOT = [
  ['features', 'compare', 'switch', 'pricing', 'download'],
  ['privacy', 'faq', 'manual', 'opensource'],
];
/** The products in the comparison, in column order (texts in compare.products, sources in sources.json). */
const PRODUCTS = ['teambot', 'openbot', 'grokbot', 'openclaw', 'hermes', 'chatapps', 'cloud'];

const readJson = (f) => JSON.parse(fs.readFileSync(path.join(src, f), 'utf8'));
const template = fs.readFileSync(path.join(src, 'template.html'), 'utf8');
const sources = fs.existsSync(path.join(src, 'sources.json')) ? readJson('sources.json') : {};
const CHECKED = sources._checked || '2026-11-07';

// ------------------------------------------------------------------ release switches and texts
const RELEASE = readJson('release.json');
const FLAGS = Object.fromEntries(Object.entries(RELEASE.features).map(([k, v]) => [k, v.on === true]));
// TEAMBOT_FEATURES_OFF=teams,proof (or "all") previews the site without those features, without editing release.json.
for (const k of (process.env.TEAMBOT_FEATURES_OFF || '').split(',').map((s) => s.trim()).filter(Boolean)) {
  if (k === 'all') Object.keys(FLAGS).forEach((f) => (FLAGS[f] = false));
  else if (k in FLAGS) FLAGS[k] = false;
  else throw new Error(`TEAMBOT_FEATURES_OFF: onbekende functie "${k}"`);
}
/** "teams" → is it on; "!teams" → is it off. Unknown names are a build error, so a typo can't hide a text. */
function on(cond) {
  const neg = cond.startsWith('!');
  const key = neg ? cond.slice(1) : cond;
  if (!(key in FLAGS)) throw new Error(`release.json kent de functie "${key}" niet (gebruikt in "if": "${cond}")`);
  return neg ? !FLAGS[key] : FLAGS[key];
}
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
/**
 * Fills in {version} and {date}, drops objects whose "if" is false (from arrays; as a property they become null) and
 * strips the "if" key from the ones that stay.
 */
function fill(v) {
  if (typeof v === 'string') return v.replaceAll('{version}', VERSION).replaceAll('{date}', CHECKED);
  if (Array.isArray(v)) return v.filter((x) => !(isObj(x) && 'if' in x) || on(x.if)).map(fill);
  if (isObj(v)) {
    if ('if' in v && !on(v.if)) return null;
    return Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'if').map(([k, x]) => [k, fill(x)]));
  }
  return v;
}
/** nl.json and en.json must have the same structure, and the same if/icon/slot/id values, before filtering. */
const SAME = new Set(['if', 'icon', 'slot', 'slot2', 'art', 'extra', 'id', 'mark']);
function sameShape(a, b, at = '') {
  const kind = (x) => (Array.isArray(x) ? 'array' : x === null ? 'null' : typeof x);
  if (kind(a) !== kind(b)) throw new Error(`nl.json en en.json verschillen bij ${at || '(begin)'}: ${kind(a)} tegenover ${kind(b)}`);
  if (Array.isArray(a)) {
    if (a.length !== b.length) throw new Error(`nl.json en en.json verschillen bij ${at}: ${a.length} tegenover ${b.length} items`);
    a.forEach((x, i) => sameShape(x, b[i], `${at}[${i}]`));
  } else if (isObj(a)) {
    const ka = Object.keys(a).sort().join(', ');
    const kb = Object.keys(b).sort().join(', ');
    if (ka !== kb) throw new Error(`nl.json en en.json verschillen bij ${at || '(begin)'}: {${ka}} tegenover {${kb}}`);
    for (const k of Object.keys(a)) {
      if (SAME.has(k) && typeof a[k] !== 'object' && a[k] !== b[k]) throw new Error(`nl.json en en.json verschillen bij ${at}.${k}: "${a[k]}" tegenover "${b[k]}"`);
      sameShape(a[k], b[k], at ? `${at}.${k}` : k);
    }
  }
}
const raw = Object.fromEntries(LANGS.map((l) => [l, readJson(`${l}.json`)]));
sameShape(raw.nl, raw.en);
const strings = Object.fromEntries(LANGS.map((l) => [l, fill(raw[l])]));
/** A page is built when both languages define it (pages.<id> in nl.json and en.json). */
const PAGES = ALL_PAGES.filter((id) => LANGS.every((l) => strings[l].pages?.[id]));

// ------------------------------------------------------------------ helpers
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const get = (obj, key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const slugOf = (L, id) => strings[L].pages[id].slug;
/** Relative URL from a page in language `from` to page `id` in language `to`. */
function pageHref(from, id, to = from, hash = '') {
  return (from === 'en' ? '../' : '') + (to === 'en' ? 'en/' : '') + slugOf(to, id) + (hash ? '#' + hash : '');
}
const rootOf = (L) => (L === 'en' ? '../' : '');
/**
 * Absolute address of a page (canonical, hreflang, og:url, sitemap): without "index.html" and without ".html", the
 * form Cloudflare Pages redirects to and GitHub Pages also serves. Links between pages stay relative with ".html",
 * so the site keeps working from file://.
 */
const absUrl = (L, id) => {
  const slug = slugOf(L, id);
  return `${SITE_URL}/${L === 'en' ? 'en/' : ''}${slug === 'index.html' ? '' : slug.replace(/\.html$/, '')}`;
};
const repoUrl = (p = '') => REPO_URL + (p ? '/blob/main/' + p : '');
export function slugify(s) {
  return String(s)
    .replace(/^\s*\d+\.\s*/, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&[a-z]+;/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
/** A text that may have variants ([{text}, …] after filtering) → the first one that is left. */
function pick(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.length ? pick(v[0]) : '';
  if (isObj(v) && 'text' in v) return v.text;
  return '';
}

/**
 * Inline text from the JSON files → HTML. Supports `code`, **bold**, *italic* and [text](target), where target is
 * page:<id>#hash (another page of this site; page:<id>@en for the other language), repo:<path> (a file in the
 * repository), asset:<path> or an https URL.
 */
function fmt(s, L) {
  const parts = String(s ?? '').split('`');
  return parts
    .map((p, i) => {
      if (i % 2) return `<code>${esc(p)}</code>`;
      let h = esc(p);
      h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1<em>$2</em>');
      h = h.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, target) => link(text, target.replace(/&amp;/g, '&'), L));
      return h;
    })
    .join('');
}
function link(textHtml, target, L) {
  if (target.startsWith('page:')) {
    const [idLang, hash] = target.slice(5).split('#');
    const [id, lang = L] = idLang.split('@');
    return `<a href="${esc(pageHref(L, id, lang, hash))}"${lang !== L ? ` hreflang="${lang}"` : ''}>${textHtml}</a>`;
  }
  if (target.startsWith('repo:')) {
    // Until the repository is public the address is a placeholder: show the file name, not a dead link.
    if (REPO_PLACEHOLDER) return `${textHtml} <span class="muted">(${esc(target.slice(5))})</span>`;
    return `<a href="${esc(repoUrl(target.slice(5)))}">${textHtml}</a>`;
  }
  if (target.startsWith('asset:')) return `<a href="${esc(rootOf(L) + 'assets/' + target.slice(6))}">${textHtml}</a>`;
  if (/^https:\/\//.test(target)) return `<a href="${esc(target)}" rel="noopener">${textHtml}</a>`;
  throw new Error(`Onbekend linkdoel: ${target}`);
}
const T = (L) => (key) => {
  const v = get(strings[L], key);
  if (v === undefined) throw new Error(`Ontbrekende tekst ${L}:${key}`);
  return v;
};
/** Keeps hyphenated words such as "AI-bots" on one line in headings (only in text, never inside a tag). */
const noBreak = (html) => html.replace(/(^|>)([^<]+)/g, (_, a, text) => a + text.replace(/(\S+-\S+)/g, '<span class="nowrap">$1</span>'));
const list = (arr, L, cls = '') => `<ul${cls ? ` class="${cls}"` : ''}>${arr.map((x) => `<li>${fmt(pick(x), L)}</li>`).join('')}</ul>`;
const paras = (arr, L) => arr.map((x) => `<p>${fmt(pick(x), L)}</p>`).join('');

// ------------------------------------------------------------------ icons (24×24 line icons, always decorative)
const ICONS = {
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
  bot: '<rect x="4" y="7.5" width="16" height="12.5" rx="4"/><path d="M12 7.5V4.5"/><circle cx="12" cy="3.6" r="1"/><path d="M9.5 13v1.2M14.5 13v1.2"/>',
  proof: '<rect x="5" y="4" width="14" height="17" rx="2.5"/><path d="M9 4.5V3h6v1.5"/><path d="M9 13l2 2 4-4.5"/>',
  spark: '<path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8z"/><path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  book: '<path d="M5 5a2 2 0 0 1 2-2h12v15H7a2 2 0 0 0-2 2z"/><path d="M5 20a2 2 0 0 0 2 2h12"/><path d="M9.5 7.5h5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  box: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  cursor: '<path d="M5.5 4l12.5 6-5.3 1.7L10.9 17z"/><path d="M13 12.3l4.8 4.8"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.5 3.5 5.4 3.5 8.5s-1.1 6-3.5 8.5c-2.4-2.5-3.5-5.4-3.5-8.5s1.1-6 3.5-8.5z"/>',
  gauge: '<path d="M4 16a8 8 0 1 1 16 0"/><path d="M12 16l3.5-4.5"/><path d="M4 20h16"/>',
  switch: '<path d="M4 8h14l-3.5-3.5M20 16H6l3.5 3.5"/>',
  pause: '<circle cx="12" cy="12" r="8.5"/><path d="M10 9v6M14 9v6"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  pc: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16v4"/>',
  send: '<path d="M4 12h14M13 6l6 6-6 6"/>',
  shield: '<path d="M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z"/><path d="M9 12l2 2 4-4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8.5-8.5M16.5 7l2.5 2.5M14 9.5l2 2"/>',
  trash: '<path d="M4.5 7h15M10 7V4.5h4V7M6.5 7l1 13h9l1-13"/><path d="M10 11v5M14 11v5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  wallet: '<rect x="3" y="6" width="18" height="14" rx="2.5"/><path d="M3 10h18M16 15h2"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  chat: '<path d="M20 15a2 2 0 0 1-2 2H8.5L4 20.5V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/><path d="M8.5 9h7M8.5 12.5h4.5"/>',
  cap: '<path d="M2.5 9.5L12 5l9.5 4.5L12 14z"/><path d="M6.5 11.6v4.2c0 1.4 2.5 2.7 5.5 2.7s5.5-1.3 5.5-2.7v-4.2"/><path d="M21.5 9.5V15"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.3-1.2-1.6-1.2-2.8 0-1 .8-1.6 1.8-1.6h2.1a4 4 0 0 0 4-4C20.5 6.6 16.7 3.5 12 3.5z"/><circle cx="7.8" cy="11.2" r="1.1"/><circle cx="10.6" cy="7.6" r="1.1"/><circle cx="15.2" cy="8" r="1.1"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  minus: '<path d="M6 12h12"/>',
  question: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2-2.4 3.7"/><path d="M12 17h.01"/>',
  cloud: '<path d="M7 18.5a4.5 4.5 0 0 1-.6-9 5.5 5.5 0 0 1 10.6 1.4 3.8 3.8 0 0 1 0 7.6z"/>',
  scale: '<path d="M12 4v16M6 20h12M5 8h14"/><path d="M5 8l-2.5 5.5a2.8 2.8 0 0 0 5 0zM19 8l-2.5 5.5a2.8 2.8 0 0 0 5 0z"/>',
  code: '<path d="M8.5 7l-5 5 5 5M15.5 7l5 5-5 5"/>',
  heart: '<path d="M12 20s-7.5-4.4-7.5-10A4.3 4.3 0 0 1 12 7.6 4.3 4.3 0 0 1 19.5 10c0 5.6-7.5 10-7.5 10z"/>',
  server: '<rect x="4" y="4" width="16" height="7" rx="2"/><rect x="4" y="13" width="16" height="7" rx="2"/><path d="M8 7.5h.01M8 16.5h.01"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z"/><path d="M10 20.5h4"/>',
  refresh: '<path d="M19.5 9A8 8 0 0 0 5.2 7.5M4.5 15a8 8 0 0 0 14.3 1.5"/><path d="M19.8 4.2V9H15M4.2 19.8V15H9"/>',
  translate: '<path d="M4 5.5h9M8.5 3.5v2c0 4-2.3 7-5 8.5M5.8 9.5c1.2 2 3.2 3.5 5.7 4.3"/><path d="M12.5 20.5l4-9.5 4 9.5M14 17h5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  undo: '<path d="M9 14L4.5 9.5 9 5"/><path d="M4.5 9.5h9.5a5.5 5.5 0 0 1 0 11H10"/>',
};
function icon(name, cls = 'ic') {
  if (!ICONS[name]) throw new Error(`Onbekend icoon: ${name}`);
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
}
// A bot figure with the icon as a small badge, instead of a bare icon in a box: the next figure of the row each time,
// so cards next to each other get different bots. "info" and "minus" (limits, things we do not do) stay plain.
const BOX_BOTS = [
  ['tangerine', null],
  ['sky', { shape: 'egg', color: 'sky', eyes: 'look', mouth: 'smile', extra: 'sprout', cheeks: false }],
  ['violet', { shape: 'ghost', color: 'violet', eyes: 'bean', mouth: 'cat', extra: 'ears', cheeks: true }],
  ['mint', { shape: 'bell', color: 'mint', eyes: 'dot', mouth: 'smile', extra: 'none', cheeks: true }],
  ['sun', { shape: 'pill', color: 'sun', eyes: 'visor', mouth: 'flat', extra: 'antenna', cheeks: false }],
  ['coral', { shape: 'cloud', color: 'coral', eyes: 'bean', mouth: 'smile', extra: 'none', cheeks: true }],
  ['teal', { shape: 'drop', color: 'teal', eyes: 'happy', mouth: 'smile', extra: 'none', cheeks: true }],
  ['pink', { shape: 'bun', color: 'pink', eyes: 'bean', mouth: 'cat', extra: 'antenna', cheeks: true }],
];
const BOX_MOODS = ['idle', 'done', 'working'];
let boxN = 0;
const iconBox = (name) => {
  if (name === 'info' || name === 'minus') return `<span class="ic-box">${icon(name)}</span>`;
  const n = boxN++;
  const [color, traits] = BOX_BOTS[n % BOX_BOTS.length];
  return `<span class="ic-box bot-box bb-${color}">${face(`box-${n}`, traits || BRAND, BOX_MOODS[n % BOX_MOODS.length], 'bb-face')}<span class="bb-badge">${icon(name)}</span></span>`;
};

// ------------------------------------------------------------------ bot figures
const BRAND = { shape: 'squircle', color: 'tangerine', eyes: 'bean', mouth: 'smile', extra: 'antenna', cheeks: true };
let uidN = 0;
const faceSvg = (seed, traits, mood = 'idle') => botSvg(seed, { traits, mood, uid: `f${++uidN}` });
/** A bot figure. Decorative: the name or text next to it always says what it is. */
const face = (seed, traits, mood = 'idle', cls = '') => `<span class="tb-face${cls ? ' ' + cls : ''}" aria-hidden="true">${faceSvg(seed, traits, mood)}</span>`;
/** Full-bleed square app icon (same recipe as scripts/make-icons.mjs). */
function iconSvg(round = 230, pad = 0.16) {
  const s = 1 - pad * 2,
    o = 1024 * pad;
  const inner = botSvg('TeamBot', { traits: BRAND, uid: 'icon' }).replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><radialGradient id="bgicon" cx="50%" cy="38%" r="75%"><stop offset="0" stop-color="#1b1b21"/><stop offset="1" stop-color="#0b0b0e"/></radialGradient></defs><rect width="1024" height="1024" rx="${round}" fill="url(#bgicon)"/><g transform="translate(${o} ${o + 1024 * 0.02}) scale(${(1024 * s) / 100})">${inner}</g></svg>`;
}
/** The example team: one bot per mood, so the faces explain themselves. */
const TEAM = [
  { key: 'planner', mood: 'idle', traits: BRAND },
  { key: 'researcher', mood: 'working', traits: { shape: 'egg', color: 'sky', eyes: 'look', mouth: 'smile', extra: 'sprout', cheeks: false } },
  { key: 'writer', mood: 'waiting', traits: { shape: 'ghost', color: 'violet', eyes: 'bean', mouth: 'cat', extra: 'ears', cheeks: true } },
  { key: 'bookkeeper', mood: 'done', traits: { shape: 'bell', color: 'mint', eyes: 'dot', mouth: 'smile', extra: 'none', cheeks: true } },
  { key: 'postman', mood: 'paused', traits: { shape: 'pill', color: 'sun', eyes: 'visor', mouth: 'flat', extra: 'antenna', cheeks: false } },
  { key: 'builder', mood: 'error', traits: { shape: 'cloud', color: 'coral', eyes: 'bean', mouth: 'smile', extra: 'none', cheeks: true } },
];
/** Figures for the example teams in the diagram on the home page. */
const DECOR = [
  { shape: 'egg', color: 'sky', eyes: 'look', mouth: 'smile', extra: 'sprout', cheeks: false },
  { shape: 'ghost', color: 'violet', eyes: 'bean', mouth: 'cat', extra: 'ears', cheeks: true },
  { shape: 'drop', color: 'teal', eyes: 'happy', mouth: 'smile', extra: 'none', cheeks: true },
  { shape: 'pill', color: 'sun', eyes: 'visor', mouth: 'flat', extra: 'antenna', cheeks: false },
  { shape: 'bell', color: 'mint', eyes: 'dot', mouth: 'smile', extra: 'none', cheeks: true },
  { shape: 'bun', color: 'pink', eyes: 'bean', mouth: 'cat', extra: 'antenna', cheeks: true },
];

// ------------------------------------------------------------------ screenshots (slots in src/shots.json)
const imgDir = path.join(src, 'img');
const SHOTS = readJson('shots.json');
const hasImg = (f) => fs.existsSync(path.join(imgDir, f));
function imgSize(file) {
  const b = fs.readFileSync(path.join(imgDir, file));
  if (file.endsWith('.png')) return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (file.endsWith('.webp') && b.toString('ascii', 12, 16) === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
  }
  if (file.endsWith('.webp') && b.toString('ascii', 12, 16) === 'VP8 ') return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  if (file.endsWith('.webp') && b.toString('ascii', 12, 16) === 'VP8X') return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
  throw new Error(`Onbekend afbeeldingsformaat: ${file}`);
}
// Images are cached for a week too, and a new screenshot keeps its file name: a fingerprint of the content in the address.
const imgV = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(imgDir, file))).digest('hex').slice(0, 10);
const missingShots = new Set();
/** The image file for a slot (webp or png), or null when it isn't there (then the slot is left out). */
function slotFile(slot) {
  const s = SHOTS[slot];
  if (!s) throw new Error(`shots.json kent het vak "${slot}" niet`);
  const f = ['webp', 'png'].map((e) => `${s.file}.${e}`).find(hasImg);
  if (!f) missingShots.add(`${slot} (${s.file})`);
  return f || null;
}
function shot(L, t, slot, { eager = false, caption = '' } = {}) {
  const f = slotFile(slot);
  if (!f) return '';
  const [w, h] = imgSize(f);
  const kind = SHOTS[slot].kind === 'phone' ? 'phone' : 'desktop';
  const img = `<img src="${rootOf(L)}img/${f}?v=${imgV(f)}" width="${w}" height="${h}" alt="${esc(t(`shots.${slot}.alt`))}"${eager ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async">`;
  return `<figure class="shot shot-${kind}" data-slot="${slot}"><div class="frame">${img}</div>${caption ? `<figcaption>${fmt(caption, L)}</figcaption>` : ''}</figure>`;
}

// ------------------------------------------------------------------ pages
const R = {};
const dlHref = (L) => pageHref(L, 'download');
const primaryDownload = (L, label, cls = '') => `<a class="btn btn-primary${cls ? ' ' + cls : ''}" href="${dlHref(L)}">${icon('download')}<span>${esc(label)}</span></a>`;
const arrowLink = (href, label) => `<a class="more" href="${href}"><span>${esc(label)}</span>${icon('arrow')}</a>`;
const sectionHead = (kicker, title, id, lead = '', L = 'nl', cls = '') =>
  `<div class="section-head${cls ? ' ' + cls : ''}">${kicker ? `<p class="kicker">${esc(kicker)}</p>` : ''}<h2 id="${id}">${noBreak(fmt(title, L))}</h2>${lead ? `<p class="lead">${fmt(pick(lead), L)}</p>` : ''}</div>`;
/** "page:manual#teams" style targets in the JSON → href (used for whole-card links). */
const hrefOf = (L, target) => {
  const m = /href="([^"]+)"/.exec(link('x', target, L));
  return m ? m[1].replace(/&amp;/g, '&') : '#';
};
/** Icon + title + text cards (a list). */
const pointList = (L, items, cls = '') =>
  `<ul class="points${cls ? ' ' + cls : ''}">${items.map((x) => `<li>${iconBox(x.icon)}<h3>${fmt(x.title, L)}</h3><p>${fmt(pick(x.text), L)}</p></li>`).join('')}</ul>`;
const checkList = (L, items, ic = 'check', cls = 'why') => `<ul class="${cls}">${items.map((x) => `<li>${icon(ic)}<span>${fmt(pick(x), L)}</span></li>`).join('')}</ul>`;
const bigSteps = (L, steps) =>
  `<ol class="bigsteps">${steps.map((s, i) => `<li><span class="step-n" aria-hidden="true">${i + 1}</span><div><h3>${fmt(s.title, L)}</h3><p>${fmt(pick(s.text), L)}</p></div></li>`).join('')}</ol>`;

// ------------------------------------------------------------------ illustrations (texts in <lang>.json › art)
/** The accent colours of Instellingen › Uiterlijk (ui/src/shell/accent.ts): light and dark tone. */
const ACCENT_SWATCHES = [
  ['#17161c', '#f4f4f7'],
  ['#7c48ae', '#c0a1e4'],
  ['#4c55c3', '#9dabef'],
  ['#0465a0', '#76b5e9'],
  ['#036c75', '#6cbdc6'],
  ['#036f4f', '#73bf9e'],
  ['#576803', '#a6b775'],
  ['#7c5c04', '#cdab62'],
  ['#a34409', '#e29f81'],
  ['#a9356c', '#e698b6'],
  ['#93408e', '#d79bd1'],
];
const ART = {
  /** The free model chain: four steps in order, and what important work does. */
  chain: (L, a) =>
    `<div class="flow-wrap"><ol class="flow" aria-label="${esc(a.label)}">${a.steps
      .map((s, i) => `<li><span class="flow-n" aria-hidden="true">${i + 1}</span><span class="flow-t">${fmt(s.title, L)}</span><span class="flow-d">${fmt(s.text, L)}</span></li>`)
      .join('')}</ol><p class="flow-note">${icon('pause')}<span>${fmt(a.pause, L)}</span></p></div>`,
  /** The eleven accent colours as swatches (light tone; the dark tone in dark mode). */
  colours: (L, a) =>
    `<ul class="swatches" aria-label="${esc(a.label)}">${a.names
      .map(
        (n, i) =>
          `<li><svg class="sw" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><circle class="sw-l" cx="10" cy="10" r="9" fill="${ACCENT_SWATCHES[i][0]}"/><circle class="sw-d" cx="10" cy="10" r="9" fill="${ACCENT_SWATCHES[i][1]}"/></svg><span>${esc(n)}</span></li>`,
      )
      .join('')}</ul>`,
  /** Chat apps as chips. */
  channels: (L, a) => `<ul class="chips-static" aria-label="${esc(a.label)}">${a.names.map((n) => `<li>${icon('chat')}<span>${esc(n)}</span></li>`).join('')}</ul>`,
  /** What stays on your pc, and what leaves it. */
  privacy: (L, a) =>
    `<figure class="art art-privacy" aria-labelledby="art-pv-cap"><div class="pv-pc"><p class="pv-title">${icon('pc')}<span>${esc(a.pc)}</span></p><ul class="pv-items">${a.items
      .map((x) => `<li>${icon('lock')}<span>${esc(x)}</span></li>`)
      .join('')}</ul></div><div class="pv-out"><div class="pv-route pv-ok"><span class="pv-dot">${icon('send')}</span><p><strong>${esc(a.ai)}</strong><span>${esc(a.aiNote)}</span></p></div><div class="pv-route pv-no"><span class="pv-dot">${icon('x')}</span><p><strong>${esc(
      a.us,
    )}</strong><span>${esc(a.usNote)}</span></p></div></div><figcaption id="art-pv-cap">${fmt(a.caption, L)}</figcaption></figure>`,
  /** A bot's own browser, with the hard blocks next to it. */
  computer: (L, a) =>
    `<figure class="art art-computer" aria-labelledby="art-cu-cap"><div class="win" aria-hidden="true"><div class="win-bar"><span class="win-dots"><i></i><i></i><i></i></span><span class="win-url">${icon('lock')}<span>${esc(a.url)}</span></span><span class="win-live">${esc(
      a.live,
    )}</span></div><div class="win-body"><div class="sk sk-h"></div><div class="sk"></div><div class="sk sk-s"></div><div class="sk-row"><span class="sk-card"></span><span class="sk-card"></span><span class="sk-card"></span></div>${face('art-cu', DECOR[0], 'working', 'win-bot')}</div><div class="win-foot"><span class="win-who">${esc(a.bot)}</span><span class="win-btn">${esc(
      a.take,
    )}</span></div></div><div class="blocked"><p class="blocked-t">${icon('shield')}<span>${esc(a.blockedTitle)}</span></p><ul>${a.blocked.map((x) => `<li>${icon('lock')}<span>${esc(x)}</span></li>`).join('')}</ul><p class="blocked-stop">${fmt(a.stop, L)}</p></div><figcaption id="art-cu-cap" class="sr">${esc(
      a.caption,
    )}</figcaption></figure>`,
  /** OpenBot → TeamBot. */
  switch: (L, a) =>
    `<figure class="art art-switch" aria-labelledby="art-sw-cap"><div class="sw-app sw-from"><p class="sw-name">${esc(a.from)}</p><p class="sw-state">${esc(a.fromState)}</p></div><div class="sw-arrow" aria-hidden="true">${icon('arrow')}</div><div class="sw-app sw-to"><p class="sw-name">${face(
      'art-sw',
      BRAND,
      'done',
      'sw-face',
    )}<span>${esc(a.to)}</span></p><ul>${a.items.map((x) => `<li>${icon('check')}<span>${esc(x)}</span></li>`).join('')}</ul></div><figcaption id="art-sw-cap">${fmt(a.caption, L)}</figcaption></figure>`,
  /** A chat channel can be connected to one app at a time. */
  oneApp: (L, a) =>
    `<figure class="art art-one" aria-labelledby="art-one-cap"><div class="one-src">${icon('chat')}<span>${esc(a.channel)}</span></div><ul class="one-apps"><li class="one-off"><span class="one-line" aria-hidden="true"></span><span class="one-app">${esc(a.old)}</span><span class="one-state">${icon('x')}${esc(
      a.oldState,
    )}</span></li><li class="one-on"><span class="one-line" aria-hidden="true"></span><span class="one-app">${esc(a.new)}</span><span class="one-state">${icon('check')}${esc(a.newState)}</span></li></ul><figcaption id="art-one-cap">${fmt(a.caption, L)}</figcaption></figure>`,
};
function art(L, t, key) {
  if (!ART[key]) throw new Error(`Onbekende illustratie: ${key}`);
  return ART[key](L, t(`art.${key}`));
}

// ------------------------------------------------------------------ plans (home and pricing)
/** The plans next to each other: free on your own PC now, the hosted versions marked as coming soon (no buy button). */
function plansGrid(L, t) {
  const p = t('pricing.plans');
  const bots = [BRAND, TEAM[1].traits, TEAM[2].traits];
  return `<ul class="plans">${p.items
    .map(
      (it, i) =>
        `<li class="plan plan-${esc(it.id)}${it.soon ? ' plan-soon' : ' plan-now'}">${face('plan-' + it.id, bots[i % bots.length], it.soon ? 'idle' : 'done', 'plan-face')}<p class="plan-badge">${esc(it.soon ? p.soon : p.now)}</p><h3>${fmt(it.name, L)}</h3><p class="plan-amount"><span class="plan-num">${esc(it.amount)}</span> <span class="plan-per">${esc(it.per)}</span></p><p class="plan-text">${fmt(it.text, L)}</p><ul class="checks">${it.points.map((x) => `<li>${icon('check')}<span>${fmt(x, L)}</span></li>`).join('')}</ul>${it.soon ? '' : `<div class="actions">${primaryDownload(L, p.cta)}</div>`}</li>`,
    )
    .join('')}</ul><p class="plans-note">${icon('info')}<span>${fmt(p.note, L)}</span></p>`;
}

// ------------------------------------------------------------------ home
R.home = (L, t) => {
  const h = t('home');
  const heroFaces = TEAM.slice(0, 5)
    .map((b) => face('hero-' + b.key, b.traits, b.mood))
    .join('');
  const trust = `<ul class="trust">${h.trust.map((x) => `<li>${icon('check')}<span>${fmt(x, L)}</span></li>`).join('')}</ul>`;
  const hero = `<section class="hero" aria-labelledby="hero-h"><div class="wrap hero-text">
<p class="kicker kicker-pill">${esc(h.kicker)}</p>
<h1 id="hero-h">${noBreak(fmt(h.title, L))}</h1>
<p class="lead">${fmt(pick(h.lead), L)}</p>
<div class="actions">${primaryDownload(L, h.ctaDownload, 'btn-lg')}<a class="btn btn-ghost btn-lg" href="#what">${esc(h.ctaHow)}</a></div>
${trust}
</div>
<div class="wrap hero-media"><div class="hero-side hero-side-l" aria-hidden="true">${face('hero-side-l', TEAM[3].traits, 'done')}</div><div class="hero-side hero-side-r" aria-hidden="true">${face('hero-side-r', TEAM[2].traits, 'working')}</div><div class="hero-faces">${heroFaces}</div><div class="device"><div class="device-bar" aria-hidden="true"><i></i><i></i><i></i></div>${shot(L, t, 'hero', { eager: true })}</div></div></section>`;

  const pr0 = h.parade;
  const paradeBots = [...TEAM.map((b) => b.traits), DECOR[2], DECOR[5]];
  const paradeRow = (dup) =>
    `<ul class="parade-row"${dup ? ' aria-hidden="true"' : ''}>${pr0.roles.map((r, i) => `<li>${face(`parade-${dup ? 'b' : 'a'}-${i}`, paradeBots[i % paradeBots.length], ['idle', 'working', 'done'][i % 3])}<span>${esc(r)}</span></li>`).join('')}</ul>`;
  const parade = `<section class="parade" aria-label="${esc(pr0.label)}"><div class="parade-track">${paradeRow(false)}${paradeRow(true)}</div></section>`;

  const how = `<section class="section section-soft" id="how" aria-labelledby="how-h"><div class="wrap">${sectionHead(h.how.kicker, h.how.title, 'how-h', '', L)}
<ol class="steps steps-faces">${h.how.steps.map((s, i) => `<li>${face('step-' + i, TEAM[[0, 2, 3][i % 3]].traits, ['idle', 'working', 'done'][i % 3], 'step-face')}<span class="step-n" aria-hidden="true">${i + 1}</span><h3>${fmt(s.title, L)}</h3><p>${fmt(s.text, L)}</p></li>`).join('')}</ol></div></section>`;


  const w = h.what;
  const what = `<section class="section" id="what" aria-labelledby="what-h"><div class="wrap">${sectionHead(w.kicker, w.title, 'what-h', w.lead, L)}<ul class="fcards">${w.items.map((it) => `<li class="fcard fcard-static">${iconBox(it.icon)}<span class="fcard-t">${fmt(it.title, L)}</span><span class="fcard-d">${fmt(it.text, L)}</span></li>`).join('')}</ul><p class="after-points">${arrowLink(pageHref(L, 'features'), w.link)}</p></div></section>`;
  let structure = '';
  if (h.structure) {
    const s = h.structure;
    const d = s.diagram;
    let n = 0;
    const teams = d.teams
      .map(
        (team) =>
          `<li class="org-team"><p class="org-team-name">${icon('lock')}<span>${esc(team.name)}</span></p><ul>${team.bots.map((b) => `<li>${face('org-' + b, DECOR[n++ % DECOR.length])}<span>${esc(b)}</span></li>`).join('')}</ul></li>`,
      )
      .join('');
    const main = FLAGS.mainBot ? `<div class="org-node org-main">${face('org-main', BRAND, 'working')}<span>${esc(d.main)}</span></div>` : '';
    structure = `<section class="section" aria-labelledby="teams-h"><div class="wrap split">
<div class="split-text">${sectionHead(s.kicker, s.title, 'teams-h', '', L)}${paras(s.text, L)}</div>
<figure class="org" aria-labelledby="org-cap"><div class="org-top"><div class="org-node org-you"><span class="ic-round">${icon('user')}</span><span>${esc(d.you)}</span></div>${main}</div>
<ul class="org-teams" aria-label="${esc(d.label)}">${teams}</ul><figcaption id="org-cap">${fmt(d.caption, L)}</figcaption></figure>
</div></section>`;
  }

  // The phone, with the two phone screenshots next to each other.
  const ph = h.phone;
  const phone = `<section class="section section-soft" id="phone" aria-labelledby="home-phone-h"><div class="wrap split split-even home-phone">
<div class="split-text">${sectionHead(ph.kicker, ph.title, 'home-phone-h', '', L)}${ph.text.filter((x) => !isObj(x) || pick([x]) !== '').map((x) => `<p>${fmt(isObj(x) ? x.text : x, L)}</p>`).join('')}<p class="after-points">${arrowLink(pageHref(L, 'download', L, 'phone'), ph.link)}</p></div>
<div class="duo">${shot(L, t, 'phone')}${shot(L, t, 'phoneList')}</div>
</div></section>`;

  const pr = h.price;
  const price = `<section class="section" aria-labelledby="price-h"><div class="wrap"><div class="price-band">
<p class="price-amount"><span aria-hidden="true">${esc(pr.amount)}</span><span class="sr">${esc(pr.amountLabel)}</span></p>
<div><p class="kicker">${esc(pr.kicker)}</p><h2 id="price-h">${fmt(pr.title, L)}</h2><p>${fmt(pr.text, L)}</p>${arrowLink(pageHref(L, 'pricing'), pr.link)}</div>
</div></div></section>`;

  // Memory, free models, phone, comparison and questions: one card each, with a bot, that links to its own page.
  const ts = h.teasers;
  const teaserHref = { memory: pageHref(L, 'features', L, 'memory'), free: pageHref(L, 'features', L, 'free'), phone: pageHref(L, 'features', L, 'phone'), compare: pageHref(L, 'compare'), faq: pageHref(L, 'faq') };
  const teasers = `<section class="section section-soft" id="more" aria-labelledby="more-h"><div class="wrap">${sectionHead(ts.kicker, ts.title, 'more-h', '', L)}<ul class="teasers">${ts.items
    .map((x, i) => {
      if (!teaserHref[x.id]) throw new Error(`home.teasers: onbekend id "${x.id}"`);
      return `<li class="card teaser">${face('teaser-' + x.id, TEAM[(i + 1) % TEAM.length].traits, ['done', 'working', 'idle'][i % 3], 'teaser-face')}<h3>${fmt(x.title, L)}</h3><p>${fmt(pick(x.text), L)}</p>${arrowLink(teaserHref[x.id], x.link)}</li>`;
    })
    .join('')}</ul></div></section>`;

  const hn = h.honest;
  // While there is no public release, that is the first thing "not yet" has to say.
  const hnItems = REPO_PLACEHOLDER ? [t('download.pending'), ...hn.items] : hn.items;
  const honest = `<section class="section" aria-labelledby="honest-h"><div class="wrap"><div class="honest card">${iconBox('info')}<div><h2 id="honest-h">${fmt(hn.title, L)}</h2>${list(hnItems, L, 'dots')}${arrowLink(pageHref(L, 'features', L, 'limits'), hn.link)}</div></div></div></section>`;

  const calm = ['idle', 'working', 'done', 'idle', 'done', 'working'];
  const team = TEAM.map((b, i) => face('cta-' + b.key, b.traits, calm[i])).join('');
  const cta = `<section class="section cta" aria-labelledby="cta-h"><div class="wrap"><div class="cta-box"><div class="cta-faces">${team}</div><h2 id="cta-h">${fmt(h.cta.title, L)}</h2><p class="lead">${fmt(h.cta.text, L)}</p><div class="actions actions-center">${primaryDownload(L, h.ctaDownload, 'btn-lg')}<a class="btn btn-ghost btn-lg" href="${pageHref(L, 'faq')}">${esc(h.cta.faq)}</a></div></div></div></section>`;

  return hero + parade + what + how + structure + phone + price + teasers + honest + cta;
};

const HEAD_BOTS = { features: 1, compare: 2, pricing: 3, privacy: 4, faq: 5, manual: 1, download: 0, switch: 3, opensource: 2 };
function pageHead(L, t, id, extra = '', cls = '') {
  const hb = TEAM[(HEAD_BOTS[id] ?? 0) % TEAM.length];
  return `<div class="page-head${cls ? ' ' + cls : ''}"><div class="wrap">${face('head-' + id, hb.traits, 'done', 'head-face')}<h1>${noBreak(fmt(t(`pages.${id}.h1`), L))}</h1><p class="lead">${fmt(t(`pages.${id}.lead`), L)}</p>${extra}</div></div>`;
}
const onPage = (L, t, items) =>
  `<nav class="on-page" aria-label="${esc(t('onPage'))}"><ul>${items.map(([id, label]) => `<li><a href="#${esc(id)}">${fmt(label, L)}</a></li>`).join('')}</ul></nav>`;

// ------------------------------------------------------------------ features
/** The media of a feature: one or two screenshots, or an illustration. */
function featureMedia(L, t, it) {
  if (it.slot && it.slot2) return `<div class="duo">${shot(L, t, it.slot)}${shot(L, t, it.slot2)}</div>`;
  if (it.slot) return shot(L, t, it.slot);
  if (it.art) return art(L, t, it.art);
  return '';
}
R.features = (L, t) => {
  const f = t('features');
  const jump = `<nav class="jump" aria-label="${esc(f.jumpLabel)}"><ul>${f.items.map((it) => `<li><a href="#${esc(it.id)}">${icon(it.icon)}<span>${fmt(it.short, L)}</span></a></li>`).join('')}</ul></nav>`;
  const sections = f.items
    .map((it, i) => {
      const phone = it.slot && SHOTS[it.slot]?.kind === 'phone';
      const extra = it.extra ? art(L, t, it.extra) : '';
      return `<section class="feature${i % 2 ? ' feature-alt' : ''}" id="${esc(it.id)}" aria-labelledby="f-${esc(it.id)}"><div class="wrap feature-grid${phone ? ' feature-phone' : ''}">
<div class="feature-text"><p class="kicker kicker-icon">${icon(it.icon)}<span>${esc(it.short)}</span></p><h2 id="f-${esc(it.id)}">${noBreak(fmt(it.title, L))}</h2><p class="feature-what">${fmt(pick(it.what), L)}</p>
<h3 class="mini">${esc(f.whyLabel)}</h3>${checkList(L, it.why)}${extra}
<div class="start"><p class="start-t">${icon('arrow')}<span>${esc(f.startLabel)}</span></p><p>${fmt(pick(it.start), L)}</p></div></div>
<div class="feature-media">${featureMedia(L, t, it)}</div></div></section>`;
    })
    .join('');
  const m = f.more;
  const more = `<section class="section section-soft" id="more" aria-labelledby="more-h"><div class="wrap">${sectionHead('', m.title, 'more-h', m.lead, L)}${pointList(L, m.items, 'points-cards')}</div></section>`;
  const lim = f.limits;
  const limits = `<section class="section" id="limits" aria-labelledby="limits-h"><div class="wrap"><div class="honest card">${iconBox('info')}<div><h2 id="limits-h">${fmt(lim.title, L)}</h2><p>${fmt(lim.lead, L)}</p>${list(REPO_PLACEHOLDER ? [t('download.pending'), ...lim.items] : lim.items, L, 'dots')}</div></div></div></section>`;
  return `${pageHead(L, t, 'features', jump, 'page-head-wide')}${sections}${more}${limits}<div class="wrap shots-note"><p class="note">${fmt(t('shots.note'), L)}</p></div>`;
};

// ------------------------------------------------------------------ pricing
R.pricing = (L, t) => {
  const p = t('pricing');
  const f = p.free;
  const free = `<section class="price-card" id="free" aria-labelledby="free-h"><div class="price-card-amount"><p class="kicker" id="free-h">${esc(f.kicker)}</p><p class="price-amount"><span aria-hidden="true">${esc(f.amount)}</span><span class="sr">${esc(f.amountLabel)}</span></p><p class="muted">${fmt(f.per, L)}</p></div>
<div class="price-card-body"><ul class="checks">${f.items.map((x) => `<li>${icon('check')}<span>${fmt(x, L)}</span></li>`).join('')}</ul><div class="actions">${primaryDownload(L, f.cta)}</div></div></section>`;
  const y = p.you;
  const options = y.options
    .map((o) => `<li class="card option">${iconBox(o.icon)}<h3>${fmt(o.title, L)}</h3><p class="cost">${fmt(o.cost, L)}</p><p>${fmt(o.text, L)}</p></li>`)
    .join('');
  const you = `<section class="section" id="you" aria-labelledby="you-h"><div class="wrap">${sectionHead('', y.title, 'you-h', y.lead, L)}<ul class="options">${options}</ul>
<div class="extras card"><h3>${fmt(y.extrasTitle, L)}</h3>${list(y.extras, L, 'dots')}</div></div></section>`;
  const g = p.guard;
  const guard = `<section class="section section-soft" id="guard" aria-labelledby="guard-h"><div class="wrap">${sectionHead('', g.title, 'guard-h', '', L)}${pointList(L, g.items, 'points-cards')}</div></section>`;
  const q = p.faq;
  const faq = `<section class="section" id="faq" aria-labelledby="faq-h"><div class="wrap">${sectionHead('', q.title, 'faq-h', '', L)}<div class="faq">${q.items.map((x) => `<div class="card"><h3>${fmt(x.q, L)}</h3><p>${fmt(x.a, L)}</p></div>`).join('')}</div><p class="after-points">${arrowLink(pageHref(L, 'faq'), q.more)}</p></div></section>`;
  const pl = p.plans;
  const plans = `<section class="section section-tight" id="plans" aria-labelledby="plans-h"><div class="wrap">${sectionHead(pl.kicker, pl.title, 'plans-h', pl.lead, L)}${plansGrid(L, t)}</div></section>`;
  return `${pageHead(L, t, 'pricing')}${plans}${you}${guard}${faq}`;
};

// ------------------------------------------------------------------ privacy
R.privacy = (L, t) => {
  const p = t('privacy');
  const summary = `<h2 class="kicker">${esc(p.summaryTitle)}</h2>${pointList(L, p.summary, 'points-4 points-cards')}`;
  const ICON = { pc: 'pc', ai: 'send', other: 'globe', keys: 'key', control: 'shield', delete: 'trash', site: 'eye', report: 'lock' };
  const sec = (id, title, body) => `<section class="doc-section" id="${id}" aria-labelledby="${id}-h"><h2 id="${id}-h">${iconBox(ICON[id])}<span>${fmt(title, L)}</span></h2>${body}</section>`;
  const a = p.ai;
  // one card per choice (a table would scroll sideways on a phone)
  const table = `<ul class="routes" aria-label="${esc(a.caption)}">${a.rows
    .map((r, i) => `<li class="route${i === 0 ? ' route-local' : ''}"><h3>${fmt(r[0], L)}</h3><dl><dt>${esc(a.labels[0])}</dt><dd>${fmt(r[1], L)}</dd><dt>${esc(a.labels[1])}</dt><dd>${fmt(r[2], L)}</dd></dl></li>`)
    .join('')}</ul>`;
  const d = p.delete;
  const nav = onPage(
    L,
    t,
    ['pc', 'ai', 'other', 'keys', 'control', 'delete', 'site', 'report'].map((id) => [id, p[id].title]),
  );
  const bullets = (items) => checkList(L, items, 'check', 'ticks');
  return `${pageHead(L, t, 'privacy', `<p class="notice"><strong>${esc(p.draftTitle)}</strong> ${fmt(pick(p.draft), L)}</p>`)}
<div class="section section-tight"><div class="wrap">${summary}<div class="privacy-art">${art(L, t, 'privacy')}</div></div></div>
<div class="wrap doc-wrap">${nav}<div class="doc-cards">
${sec('pc', p.pc.title, bullets(p.pc.items))}
${sec('ai', a.title, `<p>${fmt(a.lead, L)}</p>${table}${bullets(a.after)}`)}
${sec('other', p.other.title, bullets(p.other.items))}
${sec('keys', p.keys.title, bullets(p.keys.items))}
${sec('control', p.control.title, `${bullets(p.control.items)}<p class="muted">${fmt(p.control.note, L)}</p>`)}
${sec('delete', d.title, `<p>${fmt(d.lead, L)}</p><ol class="numbered">${d.steps.map((x) => `<li>${fmt(x, L)}</li>`).join('')}</ol>`)}
${sec('site', p.site.title, bullets(p.site.items))}
${sec('report', p.report.title, `<p>${fmt(p.report.text, L)}</p>`)}
</div></div>`;
};

// ------------------------------------------------------------------ download
R.download = (L, t) => {
  const d = t('download');
  // The newest release's files by name: one click starts the download.
  const file = (name) => `${REPO_URL}/releases/latest/download/${name}`;
  const btn = REPO_PLACEHOLDER
    ? `<span class="btn btn-primary btn-lg" role="link" aria-disabled="true">${icon('download')}<span>${esc(d.button)}</span></span>`
    : `<a class="btn btn-primary btn-lg" href="${esc(file(INSTALLER))}" rel="noopener">${icon('download')}<span>${esc(d.button)}</span></a><a class="btn btn-ghost btn-lg" href="${esc(file(MAC_FILE))}" rel="noopener">${icon('download')}<span>${esc(d.macButton)}</span></a>`;
  const pending = REPO_PLACEHOLDER ? `<p class="notice"><strong>${esc(d.pendingTitle)}</strong> ${fmt(d.pending, L)}</p>` : '';
  const steps = (arr) => `<ol class="numbered">${arr.map((x) => `<li>${fmt(x, L)}</li>`).join('')}</ol>`;
  const card = (id, ic, title, body, cls = '') => `<section class="card card-icon${cls ? ' ' + cls : ''}" id="${id}" aria-labelledby="${id}-h"><h2 id="${id}-h">${iconBox(ic)}<span>${fmt(title, L)}</span></h2>${body}</section>`;
  const install = `<section class="section" id="install" aria-labelledby="install-h"><div class="wrap">${sectionHead('', d.stepsTitle, 'install-h', '', L)}<ol class="steps steps-cards">${d.steps
    .map((s, i) => `<li${s.id ? ` id="${esc(s.id)}"` : ''}><span class="step-n" aria-hidden="true">${i + 1}</span><h3>${fmt(s.title, L)}</h3><p>${fmt(pick(s.text), L)}</p></li>`)
    .join('')}</ol></div></section>`;
  const phoneImg = shot(L, t, 'phoneList');
  const phone = `<section class="section section-soft" id="phone" aria-labelledby="phone-h"><div class="wrap split split-phone"><div class="split-text">${sectionHead('', d.phoneTitle, 'phone-h', d.phoneLead, L)}${steps(d.phoneSteps)}<p>${fmt(pick(d.phoneNote), L)}</p><p class="muted">${fmt(d.phoneAndroid, L)}</p></div>${phoneImg}</div></section>`;
  const notes = d.notes.length ? card('notes', 'spark', d.notesTitle, `${list(d.notes, L, 'dots dots-2')}<p class="muted">${fmt(d.notesMore, L)}</p>`, 'card-wide') : '';
  const smart = d.smart.length ? `<aside class="smart" aria-labelledby="smart-h">${iconBox('shield')}<div><h2 id="smart-h">${fmt(d.smartTitle, L)}</h2><ol>${d.smart.map((x) => `<li>${fmt(isObj(x) ? x.text : x, L)}</li>`).join('')}</ol></div></aside>` : '';
  return `${pageHead(L, t, 'download')}
<div class="section section-tight"><div class="wrap">${pending}
<div class="dl-card">${face('download', BRAND, 'done', 'dl-face')}<div><h2>${fmt(d.winTitle, L)}</h2><p>${fmt(d.winText, L)}</p><div class="actions">${btn}</div><p class="fine">${fmt(d.fileName, L)}</p><p class="fine">${fmt(d.macNote, L)}</p></div></div>${smart}</div></div>
${install}${phone}
<section class="section" aria-labelledby="more-dl-h"><div class="wrap"><h2 id="more-dl-h" class="sr">${esc(d.moreTitle)}</h2><div class="cards-2 cards-start">
${card('req', 'pc', d.reqTitle, list(d.req, L, 'dots'), 'card-wide')}
${notes}
</div><p class="after-points">${arrowLink(pageHref(L, 'manual', L, 'voor-gevorderden'), d.advancedLink)}</p></div></section>`;
};

// ------------------------------------------------------------------ manual
R.manual = (L, t) => {
  // The table of contents in the Markdown (for GitHub) is left out: the page builds its own from the chapters.
  // HTML comments (such as the `<!-- 0.4-pending: … -->` markers for the docs check) are notes for the authors:
  // micromark shows raw HTML as text, so they go before rendering.
  const md = fs
    .readFileSync(path.join(repo, 'docs/HANDLEIDING.md'), 'utf8')
    .replace(/<!-- inhoud -->[\s\S]*?<!-- \/inhoud -->\n*/, '')
    .replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*\n/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  let html = micromark(md, { extensions: [gfm()], htmlExtensions: [gfmHtml()] });
  if (/0\.4-pending|&lt;!--/.test(html)) throw new Error('website/build.mjs: an HTML comment of docs/HANDLEIDING.md would show on the manual page');
  html = html.replace(/<h1>[\s\S]*?<\/h1>\s*/, '');
  const toc = [];
  // Links like (#17-bestanden…) point at GitHub's numbered slugs; here the ids have no number.
  html = html.replace(/href="#\d+-/g, 'href="#');
  html = html.replace(/<h2>([\s\S]*?)<\/h2>/g, (_, inner) => {
    const id = slugify(inner.replace(/<[^>]+>/g, ''));
    toc.push([id, inner]);
    // the chapter number in its own badge
    const numbered = inner.replace(/^\s*(\d+)\.\s*/, '<span class="ch-n">$1</span>');
    return `<h2 id="${id}">${numbered}</h2>`;
  });
  // Each table scrolls in its own region, named after the heading above it (several regions need different names).
  let heading = '';
  const used = new Set();
  html = html
    .replace(/<h[23][^>]*>([\s\S]*?)<\/h[23]>|<table>/g, (all, inner) => {
      if (inner !== undefined) {
        heading = inner.replace(/<[^>]+>/g, '').replace(/^\s*\d+\.?\s*/, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
        return all;
      }
      let label = heading ? `${t('manual.tableLabel')}: ${heading}` : t('manual.tableLabel');
      for (let n = 2; used.has(label); n++) label = `${t('manual.tableLabel')} ${n}${heading ? `: ${heading}` : ''}`;
      used.add(label);
      return `<div class="table-scroll" role="region" aria-label="${esc(label)}" tabindex="0"><table>`;
    })
    .replace(/<\/table>/g, '</table></div>');
  html = html.replace(/<th>/g, '<th scope="col">');
  const m = t('manual');
  const av = m.advanced;
  toc.push(['voor-gevorderden', esc(av.title)]);
  const advanced = `<section class="advanced" lang="${L}" aria-labelledby="voor-gevorderden"><h2 id="voor-gevorderden">${fmt(av.title, L)}</h2><p>${fmt(av.lead, L)}</p>
<h3 id="server">${fmt(av.serverTitle, L)}</h3><p>${fmt(av.serverText, L)}</p><pre><code>docker compose up -d</code></pre><p>${fmt(av.serverNote, L)}</p>
<h3 id="checksum">${fmt(av.sumTitle, L)}</h3><p>${fmt(SHA256 ? av.sumKnown : av.sumPending, L)}</p>${SHA256 ? `<pre><code>${SHA256}</code></pre>` : ''}<p>${fmt(av.sumHow, L)}</p><pre><code>Get-FileHash .\${INSTALLER} -Algorithm SHA256</code></pre><p>${fmt(av.sumMore, L)}</p></section>`;
  const note = L === 'nl' ? '' : `<p class="notice" lang="${L}"><strong>${esc(m.onlyNlTitle)}</strong> ${fmt(m.onlyNl, L)}</p>`;
  const quick = `<nav class="quick" aria-label="${esc(m.quickLabel)}"><ul>${m.quick
    .map((q) => `<li><a href="#${esc(q.id)}">${iconBox(q.icon)}<span><strong>${fmt(q.title, L)}</strong><span>${fmt(q.text, L)}</span></span></a></li>`)
    .join('')}</ul></nav>`;
  return `${pageHead(L, t, 'manual', note + quick, 'page-head-wide')}
<div class="wrap doc"><nav class="toc" aria-labelledby="toc-h"><h2 id="toc-h">${esc(m.toc)}</h2><ol lang="nl">${toc.map(([id, h]) => `<li${id === 'voor-gevorderden' && L !== 'nl' ? ` lang="${L}"` : ''}><a href="#${id}">${h.replace(/^\s*(\d+)\.\s*/, '<span class="toc-n">$1</span>')}</a></li>`).join('')}</ol></nav>
<article class="prose manual" lang="nl">${html}${advanced}<p class="muted"><em>${fmt(m.source, L)}</em></p></article></div>`;
};

// ------------------------------------------------------------------ compare
/** One comparison cell: optional mark (yes / part / no) and the text, with its sources. */
function compareCell(L, c, rowId, p) {
  const row = c.rows.find((r) => r.id === rowId);
  const cell = row.cells[p];
  if (cell == null) throw new Error(`vergelijking ${L}: ${rowId}.${p} ontbreekt`);
  const text = pick(isObj(cell) && 'text' in cell ? cell.text : cell);
  const mark = isObj(cell) ? cell.mark : null;
  const srcs = (sources[rowId] || {})[p] || [];
  const isGap = text === '' || text === '-';
  const body = isGap ? `<span class="gap">${esc(c.notFound)}</span>` : fmt(text, L);
  const markHtml = mark ? `<span class="mark mark-${mark}">${icon(mark === 'yes' ? 'check' : mark === 'no' ? 'x' : 'minus')}<span class="sr">${esc(c.marks[mark])}: </span></span>` : '';
  const links = srcs.length
    ? `<span class="src">${esc(c.source)}: ${srcs
        .map((u, i) => {
          const label = srcs.length > 1 ? `${i + 1}` : esc(c.sourceShort);
          if (u.startsWith('page:') || u.startsWith('repo:')) return link(label, u, L);
          return `<a href="${esc(u)}" rel="noopener">${label}<span class="sr"> (${esc(new URL(u).host)})</span></a>`;
        })
        .join(', ')}</span>`
    : '';
  return { html: `<span class="cell">${markHtml}<span class="cell-t">${body}</span></span>${links}`, mark };
}
R.compare = (L, t) => {
  const c = t('compare');
  const name = (p) => fmt(c.products[p].name, L);
  const head = `<thead><tr><th scope="col">${esc(c.aspect)}</th>${PRODUCTS.map((p) => `<th scope="col"${p === 'teambot' ? ' class="us"' : ''}><span class="th-name">${name(p)}</span><span class="th-kind">${fmt(c.products[p].kind, L)}</span></th>`).join('')}</tr></thead>`;
  // The table says it in a few words (cellShort); the full sentence and its sources are in the product cards below.
  const shortCell = (row, p) => {
    const s = c.cellShort?.[row.id]?.[p];
    if (s == null) throw new Error(`vergelijking ${L}: cellShort.${row.id}.${p} ontbreekt`);
    const mark = compareCell(L, c, row.id, p).mark;
    const markHtml = mark ? `<span class="mark mark-${mark}">${icon(mark === 'yes' ? 'check' : mark === 'no' ? 'x' : 'minus')}<span class="sr">${esc(c.marks[mark])}: </span></span>` : '';
    return `<span class="cell">${markHtml}<span class="cell-t">${fmt(pick(s), L)}</span></span>`;
  };
  const rows = c.rows
    .map((row) => `<tr><th scope="row">${icon(row.icon)}<span>${fmt(row.label, L)}</span></th>${PRODUCTS.map((p) => `<td${p === 'teambot' ? ' class="us"' : ''}>${shortCell(row, p)}</td>`).join('')}</tr>`)
    .join('');
  const table = `<div class="table-scroll cmp-table" role="region" aria-labelledby="cmp-cap" tabindex="0"><table class="compare"><caption id="cmp-cap" class="sr">${esc(c.caption)}</caption>${head}<tbody>${rows}</tbody></table></div>`;
  // The same facts per product, for narrow screens (the table is hidden there).
  const pcards = `<div class="pcards">${PRODUCTS.map(
    (p, i) =>
      `<details class="pcard${p === 'teambot' ? ' us' : ''}"${i === 0 ? ' open' : ''}><summary><span class="pc-name">${name(p)}</span><span class="pc-kind">${fmt(c.products[p].kind, L)}</span>${icon('arrow', 'ic pc-chev')}</summary><dl>${c.rows
        .map((row) => `<div><dt>${icon(row.icon)}<span>${fmt(row.label, L)}</span></dt><dd>${compareCell(L, c, row.id, p).html}</dd></div>`)
        .join('')}</dl></details>`,
  ).join('')}</div>`;
  const legend = `<ul class="legend" aria-label="${esc(c.legendLabel)}">${['yes', 'part', 'no'].map((m) => `<li><span class="mark mark-${m}">${icon(m === 'yes' ? 'check' : m === 'no' ? 'x' : 'minus')}</span><span>${esc(c.marks[m])}</span></li>`).join('')}</ul>`;
  const short = `<div class="cards-3 cards-start">${c.short.map((s) => `<section class="card card-icon"><h2>${iconBox(s.icon)}<span>${fmt(s.title, L)}</span></h2>${paras(s.text, L)}</section>`).join('')}</div>`;
  const others = `<section class="section section-soft" id="others" aria-labelledby="others-h"><div class="wrap">${sectionHead('', c.othersTitle, 'others-h', c.othersLead, L)}<ul class="better-grid">${PRODUCTS.filter((p) => p !== 'teambot')
    .map((p) => `<li class="card"><h3>${name(p)}</h3>${checkList(L, c.products[p].ahead, 'arrow', 'why why-arrow')}</li>`)
    .join('')}</ul></div></section>`;
  const ours = `<section class="section" id="ours" aria-labelledby="ours-h"><div class="wrap">${sectionHead('', c.oursTitle, 'ours-h', c.oursLead, L)}${pointList(L, c.ours, 'points-cards')}</div></section>`;
  const read = Object.entries(sources._read || {})
    .map(([p, urls]) => `<section class="card"><h3>${name(p)}</h3><ul class="src-list">${urls.map((u) => `<li><a href="${esc(u)}" rel="noopener">${esc(u.replace(/^https:\/\//, ''))}</a></li>`).join('')}</ul></section>`)
    .join('');
  return `${pageHead(L, t, 'compare', `<p class="stand">${icon('clock')}<span>${fmt(c.checked, L)}</span></p>`, 'page-head-wide')}
<div class="section section-tight"><div class="wrap">${short}</div></div>
<section class="section section-soft cmp-section" id="table" aria-labelledby="table-h"><div class="wrap cmp-wrap">${sectionHead('', c.tableTitle, 'table-h', c.tableLead, L)}${legend}${table}<h3 class="cmp-details">${esc(c.detailsTitle)}</h3>${pcards}<p class="note">${fmt(c.tableNote, L)}</p></div></section>
${others}${ours}
<section class="section section-soft" id="sources" aria-labelledby="read-h"><div class="wrap">${sectionHead('', c.readTitle, 'read-h', c.readLead, L)}<div class="cards-3 cards-start">${read}</div><p class="note">${fmt(c.fix, L)}</p></div></section>`;
};

// ------------------------------------------------------------------ switching from OpenBot
R.switch = (L, t) => {
  const s = t('switch');
  const head = `<div class="actions">${primaryDownload(L, s.cta)}<a class="btn btn-ghost" href="#steps">${esc(s.toSteps)}</a></div>`;
  const comes = `<section class="section section-tight" aria-labelledby="comes-h"><div class="wrap split split-even"><div class="split-text">${sectionHead(s.comes.kicker, s.comes.title, 'comes-h', s.comes.lead, L)}${pointList(L, s.comes.items, 'points-2 points-compact')}</div>${art(L, t, 'switch')}</div></section>`;
  const not = `<section class="section section-soft" id="not" aria-labelledby="not-h"><div class="wrap">${sectionHead('', s.not.title, 'not-h', s.not.lead, L)}<ul class="points points-cards points-3 points-minus">${s.not.items
    .map((x) => `<li>${iconBox('minus')}<h3>${fmt(x.title, L)}</h3><p>${fmt(x.text, L)}</p></li>`)
    .join('')}</ul></div></section>`;
  const steps = `<section class="section" id="steps" aria-labelledby="steps-h"><div class="wrap narrow-wide">${sectionHead(s.steps.kicker, s.steps.title, 'steps-h', s.steps.lead, L)}${bigSteps(L, s.steps.items)}</div></section>`;
  const ch = s.channels;
  const channels = `<section class="section section-soft" id="channels" aria-labelledby="ch-h"><div class="wrap split split-even"><div class="split-text">${sectionHead(ch.kicker, ch.title, 'ch-h', ch.lead, L)}<ol class="numbered">${ch.steps.map((x) => `<li>${fmt(x, L)}</li>`).join('')}</ol><p class="tip">${icon('info')}<span>${fmt(ch.tip, L)}</span></p></div>${art(L, t, 'oneApp')}</div>
<div class="wrap"><div class="cards-2 cards-start ch-cards">${ch.cards.map((x) => `<section class="card card-icon"><h3>${iconBox(x.icon)}<span>${fmt(x.title, L)}</span></h3>${paras(x.text, L)}</section>`).join('')}</div></div></section>`;
  const after = `<section class="section" aria-labelledby="after-h"><div class="wrap">${sectionHead('', s.after.title, 'after-h', '', L)}${pointList(L, s.after.items, 'points-3 points-cards')}</div></section>`;
  const cta = `<section class="section cta" aria-labelledby="sw-cta-h"><div class="wrap"><div class="cta-box">${face('sw-cta', BRAND, 'done', 'cta-one')}<h2 id="sw-cta-h">${fmt(s.end.title, L)}</h2><p class="lead">${fmt(s.end.text, L)}</p><div class="actions actions-center">${primaryDownload(L, s.cta, 'btn-lg')}<a class="btn btn-ghost btn-lg" href="${pageHref(L, 'manual', L, 'eerste-start')}">${esc(s.end.manual)}</a></div></div></div></section>`;
  return pageHead(L, t, 'switch', head) + comes + not + steps + channels + after + cta;
};

// ------------------------------------------------------------------ FAQ
R.faq = (L, t) => {
  const q = t('faq');
  const nav = onPage(
    L,
    t,
    q.groups.map((g) => [g.id, g.title]),
  );
  const groups = q.groups
    .map(
      (g) =>
        `<section class="qa-group" id="${esc(g.id)}" aria-labelledby="${esc(g.id)}-h"><h2 id="${esc(g.id)}-h">${iconBox(g.icon)}<span>${fmt(g.title, L)}</span></h2><div class="qa-list">${g.items
          .map((x, i) => `<details class="qa"${i === 0 ? ' open' : ''}><summary><h3>${fmt(x.q, L)}</h3>${icon('arrow', 'ic qa-chev')}</summary><div class="qa-a">${paras(Array.isArray(x.a) ? x.a : [x.a], L)}</div></details>`)
          .join('')}</div></section>`,
    )
    .join('');
  const end = `<section class="section" aria-labelledby="faq-end-h"><div class="wrap"><div class="cta-box cta-small">${face('faq-end', DECOR[2], 'idle', 'cta-one')}<h2 id="faq-end-h">${fmt(q.end.title, L)}</h2><p class="lead">${fmt(q.end.text, L)}</p><div class="actions actions-center"><a class="btn btn-ghost" href="${pageHref(L, 'manual')}">${esc(q.end.manual)}</a>${primaryDownload(L, q.end.download)}</div></div></div></section>`;
  return `${pageHead(L, t, 'faq', nav)}<div class="section section-tight"><div class="wrap"><div class="qa-wrap">${groups}</div></div></div>${end}`;
};

// ------------------------------------------------------------------ open source
R.opensource = (L, t) => {
  const o = t('opensource');
  const repoLine = REPO_PLACEHOLDER
    ? `<p class="notice"><strong>${esc(o.repoPendingTitle)}</strong> ${fmt(o.repoPending, L)}</p>`
    : `<div class="actions"><a class="btn btn-ghost" href="${esc(REPO_URL)}" rel="noopener">${icon('code')}<span>${esc(o.repoButton)}</span></a></div>`;
  const lic = o.license;
  const license = `<section class="section section-tight" id="license" aria-labelledby="license-h"><div class="wrap"><div class="lic card">${face('os-lic', BRAND, 'done', 'lic-face')}<div><p class="kicker">${esc(lic.kicker)}</p><h2 id="license-h">${fmt(lic.title, L)}</h2>${paras(lic.text, L)}${checkList(L, lic.points, 'check', 'why why-cols')}</div></div></div></section>`;
  const co = o.contribute;
  const contribute = `<section class="section section-soft" id="contribute" aria-labelledby="contribute-h"><div class="wrap">${sectionHead('', co.title, 'contribute-h', co.lead, L)}${pointList(L, co.items, 'points-4 points-cards')}</div></section>`;
  const build = `<div class="section" id="build"><div class="wrap cards-2 cards-start">
<section class="card card-icon" aria-labelledby="build-h"><h2 id="build-h">${iconBox('code')}<span>${fmt(o.buildTitle, L)}</span></h2><p>${fmt(o.buildLead, L)}</p><pre><code>${esc(o.buildCode)}</code></pre><p class="muted">${fmt(o.buildNote, L)}</p></section>
<section class="card card-icon" id="site" aria-labelledby="site-h"><h2 id="site-h">${iconBox('globe')}<span>${fmt(o.siteTitle, L)}</span></h2><p>${fmt(o.siteText, L)}</p><pre><code>npm run website:build
npm run website:check</code></pre></section></div></div>`;
  return `${pageHead(L, t, 'opensource', repoLine)}${license}${contribute}${build}`;
};

/** 404.html: one page in both languages, at the root (hosts serve it for every unknown address). */
R.notfound = (L) => {
  const block = (lang, level) => {
    const tt = T(lang);
    const links = ['home', 'download', 'features', 'compare', 'faq', 'privacy'].map((id) => `<li><a href="${pageHref(L, id, lang)}"${lang !== L ? ` hreflang="${lang}"` : ''}>${esc(tt(`pages.${id}.nav`))}</a></li>`).join('');
    return `<section class="nf"${lang !== L ? ` lang="${lang}"` : ''} aria-labelledby="nf-${lang}"><h${level} id="nf-${lang}">${fmt(tt('pages.notfound.h1'), L)}</h${level}><p class="lead">${fmt(tt('pages.notfound.lead'), L)}</p><h${level + 1} class="kicker">${esc(tt('notfound.links'))}</h${level + 1}><ul class="chips">${links}</ul></section>`;
  };
  return `<div class="page-head"><div class="wrap nf-wrap"><div class="nf-card">${face('nf', BRAND, 'waiting', 'nf-face')}${block('nl', 1)}${block('en', 2)}</div></div></div>`;
};

// ------------------------------------------------------------------ render
const THEME_SCRIPT = /<script>([^<]*)<\/script>/.exec(template)?.[1];
if (!THEME_SCRIPT) throw new Error('template.html: het inline themascript ontbreekt');

function jsonLd(L, t) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'TeamBot',
    description: t('pages.home.description'),
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Windows 11',
    softwareVersion: VERSION,
    inLanguage: L,
    license: 'https://www.apache.org/licenses/LICENSE-2.0',
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
    ...(SITE_URL ? { url: absUrl(L, 'home') } : {}),
    ...(REPO_PLACEHOLDER ? {} : { codeRepository: REPO_URL }),
  };
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

// The stylesheet and the script are cached for a week (see the headers file), so their address carries a fingerprint
// of their content: a page of a new version never gets the styles of an old one from the browser's cache.
const ASSET_V = crypto
  .createHash('sha256')
  .update(fs.readFileSync(path.join(src, 'site.css')))
  .update(fs.readFileSync(path.join(src, 'site.js')))
  .digest('hex')
  .slice(0, 10);
const stamp = (html) => html.replace(/assets\/site\.(css|js)"/g, `assets/site.$1?v=${ASSET_V}"`);

function render(L, id) {
  const t = T(L);
  const other = L === 'nl' ? 'en' : 'nl';
  const is404 = id === 'notfound';
  const navItems = (ids) => ids.map((p) => `<li><a href="${pageHref(L, p)}"${p === id ? ' aria-current="page"' : ''}>${esc(t(`pages.${p}.nav`))}</a></li>`).join('');
  const self = (lang) => absUrl(lang, id);
  const headLinks = is404
    ? // hosts show 404.html at any depth (/a/b/c); with a known site address, relative links resolve from the site root
      '<meta name="robots" content="noindex">' + (SITE_URL ? `\n<base href="${esc(new URL(SITE_URL + '/').pathname)}">` : '')
    : SITE_URL
      ? [
          `<link rel="canonical" href="${esc(self(L))}">`,
          ...LANGS.map((l) => `<link rel="alternate" hreflang="${l}" href="${esc(self(l))}">`),
          `<link rel="alternate" hreflang="x-default" href="${esc(self('nl'))}">`,
          `<meta property="og:url" content="${esc(self(L))}">`,
        ].join('\n')
      : LANGS.filter((l) => l !== L)
          .map((l) => `<link rel="alternate" hreflang="${l}" href="${esc(pageHref(L, id, l))}">`)
          .join('\n');
  const title = id === 'home' ? t('pages.home.title') : `${t(`pages.${id}.title`)} · TeamBot`;
  const altHref = is404 ? pageHref(L, 'home', other) : pageHref(L, id, other);
  const vars = {
    lang: L,
    locale: L === 'nl' ? 'nl_NL' : 'en_GB',
    altLocale: L === 'nl' ? 'en_GB' : 'nl_NL',
    title,
    description: t(`pages.${id}.description`),
    ogImage: (SITE_URL ? SITE_URL + '/' : rootOf(L)) + `img/og-${L}.png`,
    ogAlt: t('ogAlt'),
    root: rootOf(L),
    home: pageHref(L, 'home'),
    dlHref: dlHref(L),
    dlCurrent: id === 'download' ? ' aria-current="page"' : '',
    altHref,
    altLang: other,
    altCode: other.toUpperCase(),
    altName: other === 'en' ? 'English' : 'Nederlands',
    headLinks,
    jsonLd: id === 'home' ? jsonLd(L, t) : '',
    logo: faceSvg('TeamBot', BRAND, 'idle'),
    logoFoot: faceSvg('TeamBot', BRAND, 'idle'),
    nav: navItems(NAV),
    menuNav: navItems([...NAV, 'download']),
    foot1: navItems(FOOT[0]),
    foot2: navItems(FOOT[1]),
    // code blocks scroll sideways on phones, so they must be reachable with the keyboard
    content: R[id](L, t).replace(/<pre>/g, '<pre tabindex="0">'),
  };
  return template.replace(/\{\{\{\s*([\w.]+)\s*\}\}\}|\{\{\s*([\w.]+)\s*\}\}/g, (_, rawKey, plain) => {
    const key = rawKey || plain;
    const v = key.startsWith('t.') ? t(key.slice(2)) : vars[key];
    if (v === undefined) throw new Error(`Template: onbekende sleutel ${key}`);
    return rawKey ? (key.startsWith('t.') ? fmt(v, L) : v) : esc(v);
  });
}

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

/** Security and cache headers for Cloudflare Pages (and Netlify); GitHub Pages ignores this file. */
function headersFile() {
  const hash = crypto.createHash('sha256').update(THEME_SCRIPT).digest('base64');
  const csp = `default-src 'self'; script-src 'self' 'sha256-${hash}'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'`;
  return `/*
  Content-Security-Policy: ${csp}
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), browsing-topics=()
  X-Frame-Options: DENY
/assets/*
  Cache-Control: public, max-age=604800
/img/*
  Cache-Control: public, max-age=604800
`;
}

export function build() {
  const started = Date.now();
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(path.join(dist, 'en'), { recursive: true });
  let n = 0;
  const urls = [];
  for (const L of LANGS)
    for (const id of PAGES) {
      uidN = 0;
      boxN = 0;
      fs.writeFileSync(path.join(dist, L === 'en' ? 'en' : '', slugOf(L, id)), stamp(render(L, id)));
      urls.push([id, L]);
      n++;
    }
  uidN = 0;
  fs.writeFileSync(path.join(dist, '404.html'), stamp(render('nl', 'notfound')));
  // assets: css, js, self-hosted Figtree (SIL OFL 1.1, licence copied along), icons, images
  // light minifying: drop comments and line breaks (the source keeps one property per line for readable diffs)
  const css = fs
    .readFileSync(path.join(src, 'site.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s*\n\s*/g, '')
    .replace(/\s*\{\s*/g, '{');
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'assets/site.css'), css + '\n');
  copy(path.join(src, 'site.js'), path.join(dist, 'assets/site.js'));
  const fontDir = path.dirname(require.resolve('@fontsource-variable/figtree/package.json'));
  for (const f of ['figtree-latin-wght-normal.woff2', 'figtree-latin-ext-wght-normal.woff2']) copy(path.join(fontDir, 'files', f), path.join(dist, 'assets/fonts', f));
  copy(path.join(fontDir, 'LICENSE'), path.join(dist, 'assets/fonts/OFL.txt'));
  fs.writeFileSync(path.join(dist, 'assets/favicon.svg'), iconSvg());
  // only what a page uses: the social preview images and the files of the screenshot slots
  const used = new Set([...LANGS.map((l) => `og-${l}.png`), ...Object.keys(SHOTS).filter((k) => !k.startsWith('_')).map(slotFile).filter(Boolean)]);
  for (const f of used) if (hasImg(f)) copy(path.join(imgDir, f), path.join(dist, 'img', f));
  if (hasImg('apple-touch-icon.png')) copy(path.join(imgDir, 'apple-touch-icon.png'), path.join(dist, 'assets/apple-touch-icon.png'));
  fs.writeFileSync(path.join(dist, '.nojekyll'), '');
  fs.writeFileSync(path.join(dist, '_headers'), headersFile());
  fs.writeFileSync(path.join(dist, 'robots.txt'), `User-agent: *\nAllow: /\n${SITE_URL ? `Sitemap: ${SITE_URL}/sitemap.xml\n` : ''}`);
  if (SITE_URL) {
    const loc = (id, l) => absUrl(l, id);
    const entries = urls
      .map(([id, l]) => `  <url><loc>${esc(loc(id, l))}</loc>${LANGS.map((x) => `<xhtml:link rel="alternate" hreflang="${x}" href="${esc(loc(id, x))}"/>`).join('')}</url>`)
      .join('\n');
    fs.writeFileSync(path.join(dist, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${entries}\n</urlset>\n`);
  }
  const off = Object.entries(FLAGS)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  console.log(
    `website: ${n} pagina's + 404 in ${path.relative(repo, dist)} (${Date.now() - started} ms)` +
      (off.length ? ` · functies uit: ${off.join(', ')}` : '') +
      (missingShots.size ? ` · ontbrekende schermafbeeldingen: ${[...missingShots].join(', ')}` : '') +
      (REPO_PLACEHOLDER ? ' · repo-adres is nog een placeholder' : '') +
      (SITE_URL ? '' : ' · zonder TEAMBOT_SITE_URL (relatieve og:image, geen sitemap)'),
  );
}

export { iconSvg, BRAND, TEAM, faceSvg, FLAGS, SHOTS };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) build();
