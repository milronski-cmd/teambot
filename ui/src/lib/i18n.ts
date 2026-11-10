/**
 * Interface language (UX-02). TeamBot's source texts are Dutch; every other language has a dictionary generated from
 * the source (scripts/i18n-extract.mjs + i18n-translate.mjs → ui/src/i18n/<code>.json) that is applied to the
 * rendered page: text nodes and the placeholder/title/aria-label/alt attributes. Chat content, markdown, code and
 * form values are never touched (elements inside [translate="no"], .md, code, pre, textarea, input,
 * [contenteditable]). Dates, numbers and plural forms come from Intl in the chosen locale (lib/format.ts).
 *
 * Choice: per user (the `language` setting, so the phone follows the computer), cached per device so the first paint
 * is already right. First run: the system/browser language when TeamBot has it, else English. Switching reloads.
 * Right-to-left languages set dir="rtl" on <html>; the layout uses logical classes (ps/pe, ms/me, start/end).
 */
import { FALLBACK_LANG, LANGUAGES, SOURCE_LANG, isLanguage, language, matchLanguage } from './languages';
import { Translator, fillSource } from './i18n-core';
import { bindLocale } from './format';

export type Lang = string;
const KEY = 'tb_lang';

function stored(): string | null {
  try {
    const v = localStorage.getItem(KEY);
    return isLanguage(v) ? v : null;
  } catch {
    return null;
  }
}

/** The system/browser languages, best first. */
export function systemLanguages(): string[] {
  try {
    const list = navigator.languages?.length ? [...navigator.languages] : [navigator.language];
    return list.filter(Boolean);
  } catch {
    return [];
  }
}

/** The language for a first run on this device: the system language when TeamBot has it, else English. */
export const detectLanguage = (): string => matchLanguage(systemLanguages(), FALLBACK_LANG);

/** Current interface language (code from lib/languages). */
export function getLang(): Lang {
  return stored() || detectLanguage();
}

/** Has a language been chosen (or confirmed) on this device? False on a first run. */
export const langChosen = (): boolean => stored() !== null;

/** Locale for dates and numbers in the interface (follows the chosen language). */
export function uiLocale(): string {
  return language(getLang())?.locale || 'en-GB';
}

export const isRtl = (): boolean => language(getLang())?.dir === 'rtl';

function remember(l: string) {
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* private mode */
  }
}

let save: ((l: string) => Promise<unknown>) | null = null;
/** How the chosen language is stored for the signed-in user (set once the app is loaded). */
export function onLanguageSave(fn: (l: string) => Promise<unknown>) {
  save = fn;
}

/** Choose the interface language: stored on this device and for the user, then the page reloads. */
let switching = false;
export async function setLang(l: Lang) {
  if (!isLanguage(l)) return;
  switching = true;
  remember(l);
  try {
    await save?.(l);
  } catch {
    /* offline: the device keeps it; the next load stores it for the user */
  }
  location.reload();
}

/**
 * After sign-in: the user's own choice wins (set on another device → this one follows). Without one, store what this
 * device uses: an earlier explicit choice, Dutch for an account that was already in use (TeamBot was Dutch-only),
 * else the system language. Returns true when the page reloads.
 */
export function syncLanguage(userLang: unknown, o: { existingUser?: boolean } = {}): boolean {
  if (switching) return true;
  const shown = rendered || getLang();
  let pick: string;
  if (isLanguage(userLang)) pick = userLang;
  else {
    pick = stored() || (o.existingUser ? SOURCE_LANG : detectLanguage());
    void save?.(pick)?.catch?.(() => {});
  }
  remember(pick);
  if (pick === shown) return false;
  location.reload();
  return true;
}

/** Languages for a picker, each in its own name ("Deutsch", "العربية"); never translated (translate="no"). */
export const languageOptions = () => LANGUAGES.map((l) => ({ code: l.code, label: l.name, dir: l.dir }));

let tr: Translator | null = null;

/** The bot names last given, also before the dictionary is loaded (startI18n applies them before its first walk). */
let keptNames: string[] = [];

/** Bot names are the user's own words: never translated (a bot called "Onderzoeker" keeps its name). */
export function keepNames(names: string[]) {
  keptNames = names;
  if (!tr) return;
  tr.keep.clear();
  for (const n of names) if (n && n.trim()) tr.keep.add(n.replace(/\s+/g, ' ').trim());
  tr.reset();
}

/** Translate one Dutch source text into the interface language (unchanged in Dutch or before the dictionary loads). */
export function translate(s: string): string {
  return tr ? tr.translate(s) : s;
}

/**
 * A Dutch template with values in the interface language: t('{0} berichten', n). The Dutch source may choose its own
 * plural form with ICU syntax, so a count and its noun stay one translatable text:
 *   t('{0, plural, one {# gesprek} other {# gesprekken}} met {1, plural, one {# bericht} other {# berichten}}', 3, 1)
 */
export function t(tpl: string, ...values: (string | number)[]): string {
  if (tr) return tr.format(tpl, values);
  return values.length || /\{\d+\s*,\s*plural\s*,/.test(tpl) ? fillSource(tpl, values) : tpl;
}

// Dates, numbers and plural forms (lib/format.ts) follow the interface language.
bindLocale(
  uiLocale,
  (s, ...values) => t(s, ...values),
  (s) => (tr ? tr.fragment(s) : s),
);

const SKIP = '[translate="no"],.notranslate,.md,code,pre,textarea,input,[contenteditable="true"],script,style';
const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
/**
 * Interface labels (`data-i18n="label"`: section headings, menu items, field labels) are translated even when a bot
 * has the same name; bot names are kept everywhere else (keepNames).
 */
const LABEL = '[data-i18n="label"]';
const done = new WeakMap<Node, string>();
const doneAttr = new WeakMap<Element, Record<string, string>>();

function skip(el: Element | null): boolean {
  return !el || !!el.closest(SKIP);
}

/** The translation of a text in `el`: an interface label by its own entry, anything else with names kept. */
const translateIn = (el: Element | null, s: string): string => (tr && el?.closest(LABEL) ? tr.label(s) : translate(s));

function textNode(n: Text) {
  const cur = n.nodeValue || '';
  if (done.get(n) === cur) return;
  if (skip(n.parentElement)) return;
  const out = translateIn(n.parentElement, cur);
  if (out !== cur) {
    done.set(n, out);
    n.nodeValue = out;
  }
}

function element(el: Element) {
  // Inputs keep their value, but their placeholder/label/title are interface text.
  if (skip(el.matches('input,textarea') ? el.parentElement : el)) return;
  const mine = doneAttr.get(el) || {};
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (!v || mine[a] === v) continue;
    const out = translateIn(el, v);
    if (out !== v) {
      mine[a] = out;
      doneAttr.set(el, mine);
      el.setAttribute(a, out);
    }
  }
}

function walk(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) return textNode(root as Text);
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const el = root as Element;
  if (el.matches('input,textarea')) return element(el);
  if (skip(el)) return;
  element(el);
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) textNode(n as Text);
    else element(n as Element);
  }
}

let started = false;
/** The language this page was rendered in (a change needs a reload). */
let rendered: string | null = null;
/** Set lang/dir on the page and start translating it when the language is not Dutch. Safe to call more than once. */
export async function startI18n() {
  if (started) return;
  started = true;
  const lang = getLang();
  rendered = lang;
  const info = language(lang);
  document.documentElement.lang = lang;
  document.documentElement.dir = info?.dir || 'ltr';
  if (lang === SOURCE_LANG) return;
  // One lazily loaded chunk per language (only the chosen one is fetched).
  const dicts = import.meta.glob<{ default: Record<string, string> }>(['../i18n/*.json', '!../i18n/languages.json']);
  const load = dicts[`../i18n/${lang}.json`];
  if (!load) return;
  const dict = (await load()).default;
  tr = new Translator(dict, info?.locale || 'en-GB');
  // The bots often load before the dictionary: their names were given while there was no translator yet
  // (acceptance round 4: "Lokaal" became "Lokal", "Reserve kapot" became "احتياطي kapot").
  keepNames(keptNames);
  walk(document.body);
  let queue: Node[] = [];
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    const q = queue;
    queue = [];
    for (const n of q) if (n.isConnected) walk(n);
  };
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'childList') m.addedNodes.forEach((n) => queue.push(n));
      else if (m.type === 'characterData') queue.push(m.target);
      else if (m.type === 'attributes') queue.push(m.target);
    }
    if (!scheduled && queue.length) {
      scheduled = true;
      requestAnimationFrame(flush);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  const titleEl = document.querySelector('title');
  const title = () => {
    const out = translate(document.title);
    if (out !== document.title) document.title = out; // setting it unconditionally would re-trigger this observer forever
  };
  title();
  if (titleEl) new MutationObserver(title).observe(titleEl, { childList: true, characterData: true, subtree: true });
}
