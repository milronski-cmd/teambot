/**
 * Theme handling: 'system' follows the OS, 'light'/'dark' are explicit. Stored per device; a theme a bot sets for the
 * user (`settings.ui.theme`) every device takes over once (adoptSharedTheme).
 * Without a choice on this device a phone starts dark (the owner, 9 November 2026: "de layout mag wel wat donker op de
 * telefoon, dat is veel mooier"); the computer keeps following the OS. A choice in Instellingen always wins, also
 * "Systeem".
 *
 * The accent colour (Instellingen › Uiterlijk › Kleur, shell/accent.ts) belongs to the user, not the device: it is
 * stored in the user's settings (`ui.accent`) and only cached here (`tb_accent`), so the first paint (and the sign-in
 * screen) already has the right colour. "Standaard" sets nothing: the tokens of styles.css as they always were.
 */
import { useSyncExternalStore } from 'react';
import { accentCss, cleanAccent, DEFAULT_ACCENT } from './accent';

export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'tb_theme';

/** A phone or tablet: the iPhone app (its web view says "TeamBotiOS/…") or a touch screen as the main pointer. */
export function isPhoneLike(): boolean {
  if (typeof window === 'undefined') return false;
  if (/TeamBotiOS\//.test(navigator.userAgent)) return true;
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
}

/** What this device uses when nobody chose a theme here. */
export const defaultThemePref = (): ThemePref => (isPhoneLike() ? 'dark' : 'system');

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* private mode: the default below */
  }
  return defaultThemePref();
}

export function setThemePref(p: ThemePref) {
  try {
    localStorage.setItem(KEY, p);
  } catch {
    /* ignore */
  }
  applyTheme();
  for (const fn of themeListeners) fn();
}

const themeListeners = new Set<() => void>();
/** The theme chosen on this device, live (the row in Instellingen follows a theme a bot set). */
export const useThemePref = (): ThemePref =>
  useSyncExternalStore(
    (fn) => (themeListeners.add(fn), () => void themeListeners.delete(fn)),
    getThemePref,
  );

const SHARED_AT = 'tb_theme_at';
/**
 * A theme set for all devices at once (`settings.ui.theme`, stamped `ui.themeAt` by the server: a bot asked, or the
 * API): this device takes it over once; after that a choice made here counts again.
 */
export function adoptSharedTheme(theme: unknown, at: unknown) {
  if ((theme !== 'system' && theme !== 'light' && theme !== 'dark') || typeof at !== 'string' || !at) return;
  try {
    if (localStorage.getItem(SHARED_AT) === at) return;
    localStorage.setItem(SHARED_AT, at);
  } catch {
    /* private mode: take it over on this page only */
  }
  setThemePref(theme);
}

const mq = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function applyTheme() {
  applyAccent();
  const p = getThemePref();
  const dark = p === 'dark' || (p === 'system' && !!mq?.matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0d0d10' : '#f4f3f6');
}

mq?.addEventListener('change', () => getThemePref() === 'system' && applyTheme());

// ------------------------------------------------------------------ accent colour

const ACCENT_KEY = 'tb_accent';
const accentListeners = new Set<() => void>();
let accent: string = (() => {
  try {
    return cleanAccent(localStorage.getItem(ACCENT_KEY));
  } catch {
    return DEFAULT_ACCENT;
  }
})();

/** The accent colour in use on this page (an id from shell/accent.ts). */
export const getAccent = (): string => accent;

/** Use an accent colour now (cached for the next start). Saving it for the user is the caller's job. */
export function setAccent(id: unknown) {
  const next = cleanAccent(id);
  if (next === accent && document.documentElement.dataset.accent === (next === DEFAULT_ACCENT ? undefined : next)) return;
  accent = next;
  try {
    if (next === DEFAULT_ACCENT) localStorage.removeItem(ACCENT_KEY);
    else localStorage.setItem(ACCENT_KEY, next);
  } catch {
    /* private mode: only this page */
  }
  applyAccent();
  for (const fn of accentListeners) fn();
}

function applyAccent() {
  const root = document.documentElement;
  if (!document.getElementById('tb-accents')) {
    const style = document.createElement('style');
    style.id = 'tb-accents';
    style.textContent = accentCss();
    document.head.appendChild(style);
  }
  if (accent === DEFAULT_ACCENT) delete root.dataset.accent;
  else root.dataset.accent = accent;
}

const subscribeAccent = (fn: () => void) => {
  accentListeners.add(fn);
  return () => void accentListeners.delete(fn);
};

/** The accent colour in use, live (the logo mark, the picker). */
export const useAccent = (): string => useSyncExternalStore(subscribeAccent, getAccent);
