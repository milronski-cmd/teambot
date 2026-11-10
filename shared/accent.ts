/**
 * Accent colours (Instellingen › Uiterlijk › Kleur). "Standaard" is the monochrome look of styles.css (near-black in
 * light, a soft silver in dark: 0.4.5 toned it down from near-white, which made the send button and every primary
 * button a glaring white disc on the dark page); every other choice only swaps the accent tokens
 * (--color-accent, --color-accent-soft, --color-accent-fg) and the focus ring (--color-ring). The neutral tokens
 * (canvas, surfaces, text, lines) and the semantic colours (ok, warn, danger) never change, so the bots keep carrying
 * their own colours.
 *
 * Pure (no DOM): the values are checked by tests/accent.test.ts, which computes the WCAG contrast of every palette in
 * light and in dark (text on the accent, the accent as text on every surface, text on the soft accent background,
 * the focus ring on every surface) and checks that NEUTRALS and the standard palette are the values of styles.css.
 * The choice is stored per user (`settings.ui.accent`), so the computer, the browser and the paired phone show the same.
 * Identifiers are stored as written: add a colour, never rename one (an unknown id reads back as "standard").
 */

export interface AccentTokens {
  /** Buttons, links, selected items, toggles; also text on every surface. */
  accent: string;
  /** Tinted background behind selected or highlighted items. */
  accentSoft: string;
  /** Text and icons on the accent (primary buttons). */
  accentFg: string;
  /** The keyboard focus ring. */
  ring: string;
}

export interface Accent {
  id: string;
  /** Dutch source name (translated on the page like every other text). */
  label: string;
  light: AccentTokens;
  dark: AccentTokens;
  /** Body colour of the TeamBot figure (the logo mark in the app) with this choice. */
  logo: string;
}

/** The colours of the TeamBot figure today (tangerine): the standard logo, unchanged. */
export const STANDARD_LOGO = '#FF9440';

const LIGHT_FG = '#ffffff';
const DARK_FG = '#111114';

/** One accent from its four colours; the ring is the accent itself (it passes 3:1 on every surface, see the test). */
const pal = (p: { id: string; label: string; light: [accent: string, soft: string]; dark: [accent: string, soft: string]; logo: string }): Accent => ({
  id: p.id,
  label: p.label,
  light: { accent: p.light[0], accentSoft: p.light[1], accentFg: LIGHT_FG, ring: p.light[0] },
  dark: { accent: p.dark[0], accentSoft: p.dark[1], accentFg: DARK_FG, ring: p.dark[0] },
  logo: p.logo,
});

/**
 * The choices in the order of the picker: Standaard, then once around the colour wheel. Light accents are dark
 * enough for 4.5:1 as text on the darkest light surface; dark accents are soft pastels with dark text on them, so the
 * phone (dark by default) stays calm and readable.
 */
export const ACCENTS: readonly Accent[] = [
  {
    id: 'standard',
    label: 'Standaard',
    light: { accent: '#1c1b19', accentSoft: '#ebe8e2', accentFg: '#ffffff', ring: '#1c1b19' },
    dark: { accent: '#d6d6de', accentSoft: '#28282e', accentFg: '#111114', ring: '#eeedf0' },
    logo: STANDARD_LOGO,
  },
  pal({ id: 'lavender', label: 'Lavendel', light: ['#7c48ae', '#eee5f9'], dark: ['#c0a1e4', '#2d2636'], logo: '#cba1fa' }),
  pal({ id: 'cobalt', label: 'Kobalt', light: ['#4c55c3', '#e4e9fd'], dark: ['#9dabef', '#262939'], logo: '#a3b2fe' }),
  pal({ id: 'sky', label: 'Hemelsblauw', light: ['#0465a0', '#dbecfc'], dark: ['#76b5e9', '#1d2c38'], logo: '#71bfff' }),
  pal({ id: 'teal', label: 'Petrol', light: ['#036c75', '#d5eff2'], dark: ['#6cbdc6', '#172e31'], logo: '#1acfdf' }),
  pal({ id: 'mint', label: 'Mint', light: ['#036f4f', '#d9f0e5'], dark: ['#73bf9e', '#1b2f26'], logo: '#56d1a3' }),
  pal({ id: 'olive', label: 'Olijf', light: ['#576803', '#e7edd8'], dark: ['#a6b775', '#282c1b'], logo: '#adc35e' }),
  pal({ id: 'gold', label: 'Goud', light: ['#7c5c04', '#f2e9d5'], dark: ['#cdab62', '#312919'], logo: '#ddb049' }),
  pal({ id: 'terracotta', label: 'Terracotta', light: ['#a34409', '#fbe4da'], dark: ['#e29f81', '#37251e'], logo: '#fc9b6f' }),
  pal({ id: 'pink', label: 'Roze', light: ['#a9356c', '#fae2ea'], dark: ['#e698b6', '#36242b'], logo: '#f893bc' }),
  pal({ id: 'grape', label: 'Druif', light: ['#93408e', '#f5e3f3'], dark: ['#d79bd1', '#332531'], logo: '#e698df' }),
];

export const DEFAULT_ACCENT = 'standard';

/**
 * The neutral tokens of styles.css (@theme for light, .dark for dark). Only used for the preview panels (a light and a
 * dark sample side by side) and by the contrast test; tests/accent.test.ts checks that they equal styles.css.
 */
export const NEUTRALS = {
  light: { canvas: '#faf9f7', surface: '#ffffff', 'surface-2': '#f5f3ef', 'surface-3': '#ebe8e2', fg: '#1c1b19', muted: '#5c5852', line: '#e6e2dc', 'line-strong': '#d2ccc3' },
  dark: { canvas: '#0f0f11', surface: '#19191d', 'surface-2': '#1f1f23', 'surface-3': '#28282e', fg: '#eeedf0', muted: '#a8a5ae', line: '#2a2a30', 'line-strong': '#3c3c43' },
} as const;
export type Mode = keyof typeof NEUTRALS;

/** A stored value → a known accent id ("standard" for anything else: nothing from storage reaches the CSS as-is). */
export function cleanAccent(v: unknown): string {
  return typeof v === 'string' && ACCENTS.some((a) => a.id === v) ? v : DEFAULT_ACCENT;
}

export function accentById(id: unknown): Accent {
  return ACCENTS.find((a) => a.id === id) || ACCENTS[0];
}

/** The user's accent from their settings (`settings.ui.accent`). */
export const accentOfSettings = (settings: { ui?: { accent?: unknown } } | null | undefined): string => cleanAccent(settings?.ui?.accent);

const tokenDecls = (t: AccentTokens) =>
  [
    ['accent', t.accent],
    ['accent-soft', t.accentSoft],
    ['accent-fg', t.accentFg],
    ['btn', t.accent],
    ['btn-fg', t.accentFg],
    ['ring', t.ring],
  ]
    .map(([k, v]) => '--color-' + k + ':' + v)
    .join(';');

/**
 * The style sheet for all colour choices, keyed on `data-accent` on <html>. Standard has no rule (no attribute = the
 * tokens of styles.css). `:root.dark[data-accent]` is more specific than both `.dark` and `:root[data-accent]`, so a
 * switch between light and dark needs nothing but the class that theme.ts already sets.
 */
export function accentCss(): string {
  return ACCENTS.filter((a) => a.id !== DEFAULT_ACCENT)
    .map((a) => `:root[data-accent="${a.id}"]{${tokenDecls(a.light)}}\n:root.dark[data-accent="${a.id}"]{${tokenDecls(a.dark)}}`)
    .join('\n');
}

/**
 * CSS variables for a sample panel in a given mode (neutrals + accent), set inline on the panel so the preview shows
 * light and dark side by side whatever the app itself shows. Content of a panel uses tokens only (no `dark:` classes).
 */
export function previewVars(id: string, mode: Mode): Record<string, string> {
  const n = NEUTRALS[mode];
  const t = accentById(id)[mode];
  const out: Record<string, string> = { colorScheme: mode };
  for (const [k, v] of Object.entries(n)) out[`--color-${k}`] = v;
  Object.assign(out, { '--color-accent': t.accent, '--color-accent-soft': t.accentSoft, '--color-accent-fg': t.accentFg, '--color-ring': t.ring });
  return out;
}

// ------------------------------------------------------------------ WCAG 2.x contrast

const HEX6 = /^#[0-9a-fA-F]{6}$/;

/** Relative luminance of a #rrggbb colour (WCAG 2.x). */
export function luminance(hex: string): number {
  if (!HEX6.test(hex)) throw new Error(`not a #rrggbb colour: ${hex}`);
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(n >> 16) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}

/** Contrast ratio of two #rrggbb colours (1 … 21). */
export function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * Every colour pair of one palette in one mode that must meet WCAG AA, with the minimum: 4.5:1 for text (the accent
 * as text on every surface and on its soft background, text on the accent, body and muted text on the soft
 * background) and 3:1 for the focus ring (non-text contrast, WCAG 1.4.11) against every surface it can be drawn on.
 */
export function contrastPairs(id: string, mode: Mode): { what: string; fg: string; bg: string; min: number }[] {
  const n = NEUTRALS[mode];
  const t = accentById(id)[mode];
  const surfaces: [string, string][] = [
    ['canvas', n.canvas],
    ['surface', n.surface],
    ['surface-2', n['surface-2']],
    ['surface-3', n['surface-3']],
    ['accent-soft', t.accentSoft],
  ];
  return [
    { what: 'accent-fg on accent', fg: t.accentFg, bg: t.accent, min: 4.5 },
    { what: 'fg on accent-soft', fg: n.fg, bg: t.accentSoft, min: 4.5 },
    { what: 'muted on accent-soft', fg: n.muted, bg: t.accentSoft, min: 4.5 },
    ...surfaces.map(([k, bg]) => ({ what: 'accent text on ' + k, fg: t.accent, bg, min: 4.5 })),
    ...surfaces.map(([k, bg]) => ({ what: 'focus ring on ' + k, fg: t.ring, bg, min: 3 })),
  ];
}
