/**
 * TeamBot bot characters: original, procedurally drawn SVG figures (no third-party art).
 *
 * Pure functions, no DOM: `botSvg()` returns an SVG string that is deterministic for a seed (the bot id) and a set of
 * trait overrides. Chosen traits are stored in the bot's existing `avatar` field as `face:{json}`; any other avatar
 * (an emoji from older versions) simply gets the generated face, and http(s)/data image avatars stay photos.
 *
 * Safety: avatars of other people's bots reach this code (groups, shared bots), so nothing from the stored JSON is
 * ever put into the SVG as-is. Every trait is checked against a fixed list (or a strict #rrggbb pattern) and every
 * number is computed here; the element id prefix is reduced to [a-z0-9].
 */

export const PALETTE = {
  coral: '#FF6B6B',
  tangerine: '#FF9440',
  sun: '#FFC94A',
  lime: '#9BD94F',
  mint: '#2CCB98',
  teal: '#1DB2C4',
  sky: '#4AA3FF',
  cobalt: '#5B6CFF',
  violet: '#8F5CF7',
  grape: '#C24FE0',
  pink: '#FF6FB4',
  slate: '#8C97AB',
} as const;
export type FaceColor = keyof typeof PALETTE;
export const COLORS = Object.keys(PALETTE) as FaceColor[];
export const SHAPES = ['squircle', 'pill', 'ghost', 'drop', 'cloud', 'egg', 'flower', 'bell', 'bun'] as const;
export const EYES = ['bean', 'look', 'dot', 'visor', 'happy'] as const;
export const MOUTHS = ['smile', 'none', 'cat', 'o', 'flat'] as const;
export const EXTRAS = ['none', 'antenna', 'sprout', 'ears', 'horns', 'crown'] as const;
/** Weighted pool for generated faces: most bots get no extra, crowns are only chosen by hand. */
const EXTRA_POOL = ['none', 'antenna', 'sprout', 'ears', 'none', 'antenna', 'horns', 'none'] as const;

export type FaceShape = (typeof SHAPES)[number];
export type FaceEyes = (typeof EYES)[number];
export type FaceMouth = (typeof MOUTHS)[number];
export type FaceExtra = (typeof EXTRAS)[number];
export type FaceStyle = 'clay' | 'felt';
/**
 * idle · working (a run is active) · waiting (needs you) · paused (archived/off) · error (last run failed) · done (just
 * finished) · limit (stopped by the daily budget until the new day: a limit, not a failure; drawn resting like paused)
 */
export type Mood = 'idle' | 'working' | 'waiting' | 'paused' | 'error' | 'done' | 'limit';
/** The expressions shown side by side in the face editor (limit looks like paused there). */
export const MOODS: Mood[] = ['idle', 'working', 'waiting', 'done', 'paused', 'error'];

export interface FaceTraits {
  shape: FaceShape;
  /** a palette name or a #rrggbb colour */
  color: FaceColor | string;
  eyes: FaceEyes;
  mouth: FaceMouth;
  extra: FaceExtra;
  cheeks: boolean;
}

export const FACE_LABELS = {
  shape: { squircle: 'Blokje', pill: 'Pil', ghost: 'Spookje', drop: 'Druppel', cloud: 'Wolk', egg: 'Ei', flower: 'Bloem', bell: 'Bel', bun: 'Broodje' },
  color: { coral: 'Koraal', tangerine: 'Mandarijn', sun: 'Zon', lime: 'Limoen', mint: 'Mint', teal: 'Petrol', sky: 'Hemelsblauw', cobalt: 'Kobalt', violet: 'Violet', grape: 'Druif', pink: 'Roze', slate: 'Leisteen' },
  eyes: { bean: 'Boontjes', look: 'Kijkers', dot: 'Stipjes', visor: 'Vizier', happy: 'Blij' },
  mouth: { smile: 'Lach', none: 'Geen', cat: 'Kattenmond', o: 'Oh', flat: 'Streep' },
  extra: { none: 'Geen', antenna: 'Antenne', sprout: 'Spruitje', ears: 'Oren', horns: 'Hoorntjes', crown: 'Kroon' },
} as const;

export const MOOD_LABELS: Record<Mood, string> = {
  idle: 'rustig',
  working: 'aan het werk',
  waiting: 'wacht op jou',
  paused: 'gepauzeerd',
  error: 'er ging iets mis',
  done: 'klaar',
  limit: 'daglimiet bereikt',
};

// ------------------------------------------------------------------ helpers

export function hash(s: string): number {
  let h = 2166136261;
  for (const c of String(s)) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function pick<T>(arr: readonly T[], seed: string, salt: string): T {
  return arr[hash(salt + ':' + seed) % arr.length];
}
const HEX = /^#[0-9a-fA-F]{6}$/;
function mix(hex: string, to: 'w' | 'b', t: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = n >> 16,
    g = (n >> 8) & 255,
    b = n & 255;
  const T = to === 'w' ? 255 : 0;
  const f = (v: number) => Math.round(v + (T - v) * t).toString(16).padStart(2, '0');
  return '#' + f(r) + f(g) + f(b);
}
const n2 = (v: number) => Math.round(v * 100) / 100;

/** Only known values survive; anything else is dropped (and then generated from the seed). */
export function cleanTraits(o: unknown): Partial<FaceTraits> {
  const out: Partial<FaceTraits> = {};
  if (!o || typeof o !== 'object') return out;
  const x = o as Record<string, unknown>;
  if (typeof x.shape === 'string' && (SHAPES as readonly string[]).includes(x.shape)) out.shape = x.shape as FaceShape;
  if (typeof x.color === 'string' && (x.color in PALETTE || HEX.test(x.color))) out.color = x.color;
  if (typeof x.eyes === 'string' && (EYES as readonly string[]).includes(x.eyes)) out.eyes = x.eyes as FaceEyes;
  if (typeof x.mouth === 'string' && (MOUTHS as readonly string[]).includes(x.mouth)) out.mouth = x.mouth as FaceMouth;
  if (typeof x.extra === 'string' && (EXTRAS as readonly string[]).includes(x.extra)) out.extra = x.extra as FaceExtra;
  if (typeof x.cheeks === 'boolean') out.cheeks = x.cheeks;
  return out;
}

export const FACE_PREFIX = 'face:';

/** Traits stored in an avatar string (`face:{json}`), or null when the avatar is not a face (emoji, photo, empty). */
export function parseFace(avatar: string | null | undefined): Partial<FaceTraits> | null {
  if (!avatar || !avatar.startsWith(FACE_PREFIX)) return null;
  try {
    return cleanTraits(JSON.parse(avatar.slice(FACE_PREFIX.length)));
  } catch {
    return {}; // damaged (e.g. truncated in an old template): fall back to the generated face
  }
}

export function encodeFace(t: Partial<FaceTraits>): string {
  const c = cleanTraits(t);
  const ordered: Record<string, unknown> = {};
  for (const k of ['shape', 'color', 'eyes', 'mouth', 'extra', 'cheeks'] as const) if (c[k] !== undefined) ordered[k] = c[k];
  return FACE_PREFIX + JSON.stringify(ordered);
}

/** A photo/logo avatar (uploaded image or link) instead of a drawn character. */
export function isImageAvatar(avatar: string | null | undefined): boolean {
  return !!avatar && (/^https?:\/\//i.test(avatar) || /^data:image\//i.test(avatar) || /^\/(?!\/)/.test(avatar));
}

export function traitsFor(seed: string, o: Partial<FaceTraits> = {}): FaceTraits {
  const c = cleanTraits(o);
  return {
    color: c.color || pick(COLORS, seed, 'color'),
    shape: c.shape || pick(SHAPES, seed, 'shape'),
    eyes: c.eyes || pick(EYES, seed, 'eyes'),
    mouth: c.mouth || pick(MOUTHS, seed, 'mouth'),
    extra: c.extra || pick(EXTRA_POOL, seed, 'extra'),
    cheeks: c.cheeks ?? (hash('cheeks:' + seed) & 1) === 1,
  };
}

/** A fresh random face (the "willekeurig" button in the editor). */
export function randomTraits(rand: () => number = Math.random): FaceTraits {
  const r = <T,>(a: readonly T[]) => a[Math.floor(rand() * a.length) % a.length];
  return { shape: r(SHAPES), color: r(COLORS), eyes: r(EYES), mouth: r(MOUTHS), extra: r(EXTRA_POOL), cheeks: rand() < 0.5 };
}

/** The base colour of a face (for small accents next to it). */
export function faceColor(seed: string, o: Partial<FaceTraits> = {}): string {
  const t = traitsFor(seed, o);
  return (PALETTE as Record<string, string>)[t.color] || (HEX.test(t.color) ? t.color : PALETTE.slate);
}

// ------------------------------------------------------------------ drawing (viewBox 0 0 100 100)

function flowerPath(): string {
  const pts: string[] = [];
  for (let i = 0; i <= 120; i++) {
    const a = (i / 120) * Math.PI * 2 - Math.PI / 2;
    const r = 37 * (1 + 0.1 * Math.cos(5 * a));
    pts.push(`${(50 + r * Math.cos(a)).toFixed(2)},${(53 + r * Math.sin(a)).toFixed(2)}`);
  }
  return 'M' + pts.join('L') + 'Z';
}

/** Body outline `d`, face anchor `f` = [x, y, scale], highlight spot `h`, top of the head `top`. */
const BODY: Record<FaceShape, { d: string; f: [number, number, number]; h: [number, number]; top: number }> = {
  squircle: { d: 'M50,14C79,14 86,21 86,51C86,81 79,88 50,88C21,88 14,81 14,51C14,21 21,14 50,14Z', f: [50, 53, 1], h: [32, 28], top: 13 },
  pill: { d: 'M38,24H62C78,24 90,36 90,52S78,80 62,80H38C22,80 10,68 10,52S22,24 38,24Z', f: [50, 52, 1], h: [28, 34], top: 24 },
  ghost: { d: 'M18,50C18,28 32,14 50,14C68,14 82,28 82,50V80C82,88 74,90 70,84C66,78 62,78 58,84C54,90 46,90 42,84C38,78 34,78 30,84C26,90 18,88 18,80Z', f: [50, 47, 1], h: [33, 27], top: 13 },
  drop: { d: 'M50,10C58,24 84,40 84,61C84,79 70,90 50,90C30,90 16,79 16,61C16,40 42,24 50,10Z', f: [50, 63, 0.95], h: [36, 48], top: 10 },
  cloud: { d: 'M26,86C13,86 9,71 18,64C11,52 22,39 35,44C37,28 57,24 63,38C75,32 89,44 83,58C93,64 90,86 76,86Z', f: [50, 66, 0.92], h: [30, 52], top: 30 },
  egg: { d: 'M50,12C72,12 84,42 84,61C84,79 70,90 50,90C30,90 16,79 16,61C16,42 28,12 50,12Z', f: [50, 58, 1], h: [35, 32], top: 13 },
  flower: { d: flowerPath(), f: [50, 54, 0.95], h: [35, 34], top: 13 },
  bell: { d: 'M31,17C41,11 59,11 69,17C81,25 85,58 86,73C87,86 78,88 50,88C22,88 13,86 14,73C15,58 19,25 31,17Z', f: [50, 55, 1], h: [34, 28], top: 13 },
  bun: { d: 'M10,70C10,41 28,24 50,24C72,24 90,41 90,70C90,84 82,88 50,88C18,88 10,84 10,70Z', f: [50, 60, 1], h: [30, 40], top: 24 },
};
/** Ears and horns only sit right on shapes with a broad, round top. */
const ROUND_TOP: FaceShape[] = ['squircle', 'bell', 'ghost', 'egg'];

type EyeKind = FaceEyes | 'sleep' | 'wide' | 'squint';
type MouthKind = FaceMouth | 'grin';

function eyesSvg(kind: EyeKind, ink: string, s: number, mood: Mood): string {
  const dx = 11 * s,
    ex = mood === 'working' ? 2.2 : 0; // working: glancing aside
  const L = -dx + ex,
    R = dx + ex;
  const pair = (fn: (x: number) => string) => fn(n2(L)) + fn(n2(R));
  switch (kind) {
    case 'bean':
      return pair((x) => `<ellipse cx="${x}" cy="0" rx="${n2(4.3 * s)}" ry="${n2(6.2 * s)}" fill="${ink}"/><circle cx="${n2(x - 1.4 * s)}" cy="${n2(-2.4 * s)}" r="${n2(1.6 * s)}" fill="#fff" opacity=".9"/>`);
    case 'look':
      return pair((x) => `<circle cx="${x}" cy="0" r="${n2(6.4 * s)}" fill="#fff"/><circle cx="${n2(x + (mood === 'working' ? 2.4 : 0.6) * s)}" cy="${n2(0.8 * s)}" r="${n2(3.3 * s)}" fill="${ink}"/><circle cx="${n2(x - 0.4 * s)}" cy="${n2(-0.6 * s)}" r="${n2(1.1 * s)}" fill="#fff"/>`);
    case 'dot':
      return pair((x) => `<circle cx="${x}" cy="0" r="${n2(3.2 * s)}" fill="${ink}"/>`);
    case 'visor':
      return (
        `<rect x="${n2(-19 * s + ex)}" y="${n2(-6.5 * s)}" width="${n2(38 * s)}" height="${n2(13 * s)}" rx="${n2(6.5 * s)}" fill="${ink}"/>` +
        pair((x) => `<ellipse cx="${n2(x * 0.85)}" cy="0" rx="${n2(3.4 * s)}" ry="${n2(2.6 * s)}" fill="${mood === 'error' ? '#ff9a9a' : mood === 'waiting' ? '#ffe08a' : '#9ff5ff'}"/>`)
      );
    case 'happy':
      return pair((x) => `<path d="M${n2(x - 5 * s)},${n2(2 * s)}Q${x},${n2(-6 * s)} ${n2(x + 5 * s)},${n2(2 * s)}" fill="none" stroke="${ink}" stroke-width="${n2(2.8 * s)}" stroke-linecap="round"/>`);
    case 'sleep':
      return pair((x) => `<path d="M${n2(x - 5 * s)},${n2(-1 * s)}Q${x},${n2(4.5 * s)} ${n2(x + 5 * s)},${n2(-1 * s)}" fill="none" stroke="${ink}" stroke-width="${n2(2.6 * s)}" stroke-linecap="round"/>`);
    case 'wide':
      return pair((x) => `<circle cx="${x}" cy="0" r="${n2(7 * s)}" fill="#fff"/><circle cx="${x}" cy="${n2(0.4 * s)}" r="${n2(2.6 * s)}" fill="${ink}"/><circle cx="${n2(x - 0.8 * s)}" cy="${n2(-0.6 * s)}" r="${n2(0.9 * s)}" fill="#fff"/>`);
    case 'squint':
      return pair((x) => {
        const k = x < 0 ? 1 : -1;
        return `<path d="M${n2(x - 4.5 * s * k)},${n2(-4 * s)}L${n2(x + 4 * s * k)},0L${n2(x - 4.5 * s * k)},${n2(4 * s)}" fill="none" stroke="${ink}" stroke-width="${n2(2.6 * s)}" stroke-linecap="round" stroke-linejoin="round"/>`;
      });
  }
  return '';
}

function mouthSvg(kind: MouthKind, ink: string, s: number): string {
  const y = 9.5 * s;
  switch (kind) {
    case 'smile':
      return `<path d="M${n2(-4.5 * s)},${n2(y)}Q0,${n2(y + 5 * s)} ${n2(4.5 * s)},${n2(y)}" fill="none" stroke="${ink}" stroke-width="${n2(2.3 * s)}" stroke-linecap="round"/>`;
    case 'cat':
      return `<path d="M${n2(-5.5 * s)},${n2(y)}Q${n2(-2.75 * s)},${n2(y + 4 * s)} 0,${n2(y)}Q${n2(2.75 * s)},${n2(y + 4 * s)} ${n2(5.5 * s)},${n2(y)}" fill="none" stroke="${ink}" stroke-width="${n2(2 * s)}" stroke-linecap="round"/>`;
    case 'o':
      return `<ellipse cx="0" cy="${n2(y + 1.5 * s)}" rx="${n2(2.6 * s)}" ry="${n2(3.2 * s)}" fill="${ink}"/>`;
    case 'flat':
      return `<path d="M${n2(-3.5 * s)},${n2(y + 1 * s)}H${n2(3.5 * s)}" stroke="${ink}" stroke-width="${n2(2.2 * s)}" stroke-linecap="round"/>`;
    case 'grin':
      return `<path d="M${n2(-5.5 * s)},${n2(y - 1 * s)}H${n2(5.5 * s)}Q${n2(5.5 * s)},${n2(y + 6 * s)} 0,${n2(y + 6 * s)}Q${n2(-5.5 * s)},${n2(y + 6 * s)} ${n2(-5.5 * s)},${n2(y - 1 * s)}Z" fill="${ink}"/><ellipse cx="0" cy="${n2(y + 4 * s)}" rx="${n2(2.8 * s)}" ry="${n2(1.6 * s)}" fill="#ff8aa0"/>`;
  }
  return '';
}

export interface BotSvgOptions {
  traits?: Partial<FaceTraits>;
  style?: FaceStyle;
  mood?: Mood;
  /** Prefix for the SVG's internal ids; must be unique per rendered instance. */
  uid: string;
}

/** The character as an SVG string (viewBox 0 0 100 100, aria-hidden: always pair it with a visible text). */
export function botSvg(seed: string, { traits, style = 'clay', mood = 'idle', uid }: BotSvgOptions): string {
  const t = traitsFor(seed, traits);
  const id = 'tb' + String(uid).replace(/[^a-zA-Z0-9]/g, '').slice(0, 40);
  const base = (PALETTE as Record<string, string>)[t.color] || (HEX.test(t.color) ? t.color : PALETTE.slate);
  const B = BODY[t.shape] || BODY.squircle;
  const [fx, fy, f0] = B.f;
  const fs = f0 * 1.22;
  const ink = '#221c33';
  const felt = style === 'felt';
  let eyes: EyeKind = t.eyes;
  let mouth: MouthKind = t.mouth;
  if (mood === 'waiting') {
    eyes = eyes === 'visor' ? 'visor' : 'wide';
    mouth = 'o';
  }
  if (mood === 'paused' || mood === 'limit') {
    eyes = 'sleep';
    mouth = 'none';
  }
  if (mood === 'error') {
    eyes = eyes === 'visor' ? 'visor' : 'squint';
    mouth = 'flat';
  }
  if (mood === 'done') {
    eyes = 'happy';
    mouth = 'grin';
  }

  const light = mix(base, 'w', 0.42),
    dark = mix(base, 'b', 0.28),
    edge = mix(base, 'b', 0.45);
  const defs =
    `<radialGradient id="${id}g" cx="34%" cy="26%" r="85%"><stop offset="0" stop-color="${light}"/><stop offset=".5" stop-color="${base}"/><stop offset="1" stop-color="${dark}"/></radialGradient>` +
    `<radialGradient id="${id}s" cx="42%" cy="34%" r="72%"><stop offset=".62" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".22"/></radialGradient>` +
    `<filter id="${id}b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.2"/></filter>` +
    (felt
      ? `<filter id="${id}f" x="-10%" y="-10%" width="120%" height="120%">` +
        `<feTurbulence type="fractalNoise" baseFrequency="1.6" numOctaves="2" seed="${hash(seed) % 97}" result="n"/>` +
        `<feDisplacementMap in="SourceGraphic" in2="n" scale="2.6" xChannelSelector="R" yChannelSelector="G" result="d"/>` +
        `<feColorMatrix in="n" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .55 -.22" result="speck"/>` +
        `<feComposite in="speck" in2="d" operator="in" result="sp"/>` +
        `<feMerge><feMergeNode in="d"/><feMergeNode in="sp"/></feMerge></filter>`
      : '') +
    `<clipPath id="${id}c"><path d="${B.d}"/></clipPath>`;

  let extra: FaceExtra = t.extra;
  if ((extra === 'ears' || extra === 'horns') && !ROUND_TOP.includes(t.shape)) extra = 'antenna';
  const top = B.top;
  let behind = '',
    front = '';
  if (extra === 'ears') behind = `<path d="M24,30L20,8L42,20Z" fill="${dark}"/><path d="M76,30L80,8L58,20Z" fill="${dark}"/>`;
  if (extra === 'horns') behind = `<path d="M32,22Q26,6 36,6Q36,14 42,18Z" fill="${mix(base, 'w', 0.6)}"/><path d="M68,22Q74,6 64,6Q64,14 58,18Z" fill="${mix(base, 'w', 0.6)}"/>`;
  if (extra === 'antenna')
    behind = `<path d="M50,${top + 2}V${top - 7}" stroke="${edge}" stroke-width="2.4" stroke-linecap="round"/><circle cx="50" cy="${top - 9}" r="4.2" fill="${mood === 'working' ? '#7CFFB2' : mood === 'waiting' ? '#FFD34D' : mood === 'error' ? '#FF8A8A' : light}" stroke="${edge}" stroke-width="1.2"/>`;
  if (extra === 'sprout')
    front = `<path d="M50,${top + 1}Q50,${top - 6} 51,${top - 8}" stroke="#3f9b4a" stroke-width="2.2" fill="none" stroke-linecap="round"/><path d="M51,${top - 7}Q44,${top - 16} 38,${top - 11}Q44,${top - 4} 51,${top - 7}Z" fill="#5cc66a"/><path d="M51,${top - 7}Q58,${top - 17} 64,${top - 11}Q57,${top - 3} 51,${top - 7}Z" fill="#74d97f"/>`;
  if (extra === 'crown')
    front = `<path d="M38,${top + 3}L36,${top - 9}L44,${top - 3}L50,${top - 12}L56,${top - 3}L64,${top - 9}L62,${top + 3}Z" fill="#FFCF4A" stroke="#c99512" stroke-width="1.2" stroke-linejoin="round"/>`;

  const cheeks =
    t.cheeks && eyes !== 'visor'
      ? `<ellipse cx="${n2(-15 * fs)}" cy="${n2(6.5 * fs)}" rx="${n2(4 * fs)}" ry="${n2(2.4 * fs)}" fill="#ff5a8a" opacity=".32"/><ellipse cx="${n2(15 * fs)}" cy="${n2(6.5 * fs)}" rx="${n2(4 * fs)}" ry="${n2(2.4 * fs)}" fill="#ff5a8a" opacity=".32"/>`
      : '';
  const zzz =
    mood === 'paused' || mood === 'limit'
      ? `<text x="74" y="22" font-family="system-ui,sans-serif" font-weight="800" font-size="13" fill="currentColor" opacity=".55">z</text><text x="83" y="12" font-family="system-ui,sans-serif" font-weight="800" font-size="9" fill="currentColor" opacity=".4">z</text>`
      : '';
  const blink = (mood === 'idle' || mood === 'working') && !['happy', 'sleep', 'squint'].includes(eyes) ? ' class="tb-eyes"' : '';

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false"><defs>${defs}</defs>` +
    `<ellipse cx="50" cy="94" rx="28" ry="3.6" fill="#000" opacity=".28" filter="url(#${id}b)"/>` +
    behind +
    `<g${felt ? ` filter="url(#${id}f)"` : ''}>` +
    `<path d="${B.d}" fill="url(#${id}g)"/>` +
    `<path d="${B.d}" fill="url(#${id}s)"/>` +
    `<g clip-path="url(#${id}c)"><ellipse cx="${B.h[0]}" cy="${B.h[1]}" rx="11" ry="6.5" transform="rotate(-28 ${B.h[0]} ${B.h[1]})" fill="#fff" opacity="${felt ? 0.18 : 0.42}" filter="url(#${id}b)"/></g>` +
    `<path d="${B.d}" fill="none" stroke="${edge}" stroke-opacity=".35" stroke-width="1"/>` +
    `</g>` +
    front +
    `<g transform="translate(${fx} ${fy})">${cheeks}<g${blink}>${eyesSvg(eyes, ink, fs, mood)}</g>${mouthSvg(mouth, ink, fs)}</g>` +
    zzz +
    `</svg>`
  );
}
