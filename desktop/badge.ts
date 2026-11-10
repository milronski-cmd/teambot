/**
 * Taskbar / dock / tray badge with the number of things that wait for the owner (B-67).
 *
 * The count is what the UI shows itself: approvals and questions that wait for the owner ("Wacht op jou") plus
 * unread chats. The main window reports it (debounced, only on change) over IPC; while there is no window (TeamBot
 * started hidden at login) the main process falls back to the pending approvals in the database.
 *   - Windows: an overlay icon on the taskbar button (`BrowserWindow.setOverlayIcon`) with a description in the
 *     owner's language for screen readers ("3 wachten op jou"), drawn here as a small PNG (no image library needed);
 *   - macOS / Linux: `app.setBadgeCount` (dock / launcher);
 *   - everywhere: the tray tooltip says it, the tray icon gets a small dot, and the menu item reads "Wacht op jou (3)".
 * Everything here except DesktopBadge's injected setters is pure, so it is unit-tested without Electron.
 */
import zlib from 'node:zlib';
import { tr } from '../server/core/i18n.js';

export interface BadgeCounts {
  /** Approvals, questions and other items that wait for the owner. */
  waiting: number;
  /** Chats with a new message the owner has not seen yet. */
  unread: number;
}

export interface BadgeState extends BadgeCounts {
  count: number;
  /** For screen readers and the tray tooltip, e.g. "2 wachten op jou, 1 ongelezen chat" ('' when nothing). */
  text: string;
  /** What fits in the round badge: "1"…"9", "9+". */
  label: string;
}

const clampCount = (v: unknown) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 9999) : 0;
};

/** Normalise untrusted counts (they come over IPC) and describe them in plain words, in language `lang`. */
export function badgeState(c: Partial<BadgeCounts> | null | undefined, lang = 'nl'): BadgeState {
  const waiting = clampCount(c?.waiting);
  const unread = clampCount(c?.unread);
  const count = waiting + unread;
  const parts: string[] = [];
  // Whole sentences per form, so every language (also with few/many plural forms) can translate them.
  if (waiting) parts.push(waiting === 1 ? tr(lang, '1 wacht op jou') : tr(lang, '{0} wachten op jou', waiting));
  if (unread) parts.push(unread === 1 ? tr(lang, '1 ongelezen chat') : tr(lang, '{0} ongelezen chats', unread));
  return { waiting, unread, count, text: parts.join(lang === 'ar' ? '، ' : ', '), label: count === 0 ? '' : count > 9 ? '9+' : String(count) };
}

// ------------------------------------------------------------------ drawing

type Pt = [number, number];
/** Points on an ellipse arc; angles in degrees, 0 = right, 90 = down (y grows downwards). */
function arc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, n = 18): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
}

/** A simple stroke font for digits and "+", in a box 0.62 wide and 1 high (polylines). */
const GLYPHS: Record<string, { w: number; paths: Pt[][] }> = {
  '0': { w: 0.62, paths: [arc(0.31, 0.5, 0.27, 0.46, 0, 360, 28)] },
  '1': { w: 0.5, paths: [[[0.08, 0.2], [0.34, 0.02], [0.34, 1]]] },
  '2': { w: 0.62, paths: [[...arc(0.31, 0.28, 0.26, 0.25, 195, 380), [0.05, 0.98], [0.6, 0.98]]] },
  '3': { w: 0.62, paths: [arc(0.3, 0.26, 0.25, 0.23, 205, 450), arc(0.3, 0.73, 0.28, 0.25, 270, 515)] },
  '4': { w: 0.66, paths: [[[0.48, 1], [0.48, 0.02], [0.03, 0.7], [0.64, 0.7]]] },
  '5': { w: 0.62, paths: [[[0.56, 0.03], [0.13, 0.03], [0.09, 0.47], ...arc(0.31, 0.7, 0.27, 0.27, 228, 510)]] },
  '6': { w: 0.62, paths: [[[0.52, 0.02], [0.08, 0.62]], arc(0.32, 0.69, 0.26, 0.29, 0, 360, 24)] },
  '7': { w: 0.62, paths: [[[0.03, 0.03], [0.6, 0.03], [0.22, 1]]] },
  '8': { w: 0.62, paths: [arc(0.31, 0.26, 0.23, 0.22, 0, 360, 22), arc(0.31, 0.73, 0.27, 0.25, 0, 360, 24)] },
  '9': { w: 0.62, paths: [arc(0.3, 0.31, 0.26, 0.29, 0, 360, 24), [[0.54, 0.38], [0.12, 0.98]]] },
  '+': { w: 0.5, paths: [[[0.25, 0.3], [0.25, 0.8]], [[0.02, 0.55], [0.48, 0.55]]] },
};

function segDist(px: number, py: number, a: Pt, b: Pt) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / len)) : 0;
  const x = a[0] + t * dx - px;
  const y = a[1] + t * dy - py;
  return Math.sqrt(x * x + y * y);
}

export const BADGE_COLORS = {
  /** The in-app "wacht op jou" badge colour (warn-strong) with its text colour (warn-fg). */
  fill: [0xe9, 0xa3, 0x2a] as const,
  text: [0x1a, 0x14, 0x05] as const,
  ring: [0x1a, 0x14, 0x05] as const,
};

/** RGBA pixels (straight alpha) of a round badge with `label`, `size`×`size`, anti-aliased (4×4 samples). */
export function renderBadgeRgba(label: string, size = 32): Buffer {
  const px = Buffer.alloc(size * size * 4);
  const glyphs = [...label].map((ch) => GLYPHS[ch]).filter(Boolean);
  // Lay the label out in pixels: glyph height ~56% of the badge (smaller for two characters), centred.
  const h = size * (glyphs.length > 1 ? 0.46 : 0.56);
  const gap = h * 0.1;
  const width = glyphs.reduce((a, g) => a + g.w * h, 0) + gap * Math.max(0, glyphs.length - 1);
  const stroke = Math.max(1.1, size * (glyphs.length > 1 ? 0.095 : 0.105));
  const segs: [Pt, Pt][] = [];
  let x0 = (size - width) / 2;
  const y0 = (size - h) / 2;
  for (const g of glyphs) {
    for (const path of g.paths) for (let i = 1; i < path.length; i++) segs.push([[x0 + path[i - 1][0] * h, y0 + path[i - 1][1] * h], [x0 + path[i][0] * h, y0 + path[i][1] * h]]);
    x0 += g.w * h + gap;
  }
  const c = size / 2;
  const r = size / 2 - 0.5;
  const ringW = Math.max(1, size / 22);
  const S = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inDisc = 0;
      let inFill = 0;
      let inText = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const fx = x + (sx + 0.5) / S;
          const fy = y + (sy + 0.5) / S;
          const d = Math.hypot(fx - c, fy - c);
          if (d > r) continue;
          inDisc++;
          if (d <= r - ringW) {
            inFill++;
            if (segs.some(([a, b]) => segDist(fx, fy, a, b) <= stroke / 2)) inText++;
          }
        }
      }
      if (!inDisc) continue;
      // Colour = average of the samples: ring (dark, partly see-through), fill, text.
      const ringN = inDisc - inFill;
      const fillN = inFill - inText;
      const a = (ringN * 0.55 + fillN + inText) / (S * S);
      const mix = (ch: 0 | 1 | 2) => (ringN * 0.55 * BADGE_COLORS.ring[ch] + fillN * BADGE_COLORS.fill[ch] + inText * BADGE_COLORS.text[ch]) / (ringN * 0.55 + fillN + inText);
      const o = (y * size + x) * 4;
      px[o] = Math.round(mix(0));
      px[o + 1] = Math.round(mix(1));
      px[o + 2] = Math.round(mix(2));
      px[o + 3] = Math.round(a * 255);
    }
  }
  return px;
}

/** Minimal PNG encoder (8-bit RGBA, no filtering). */
export function encodePng(rgba: Buffer, width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** The badge as a PNG file. */
export function renderBadgePng(label: string, size = 32): Buffer {
  return encodePng(renderBadgeRgba(label, size), size, size);
}

/**
 * A copy of a tray icon bitmap (BGRA with premultiplied alpha, as Electron's nativeImage.toBitmap gives it and
 * createFromBitmap takes it) with a small badge dot in the top right corner (warn-strong with a dark rim), so
 * "something waits" is visible in the tray too.
 */
export function withTrayDot(bgra: Buffer, width: number, height: number): Buffer {
  const out = Buffer.from(bgra);
  const r = Math.max(2.5, width * 0.22);
  const cx = width - r - 0.25;
  const cy = r + 0.25;
  const rim = Math.max(0.8, width / 24);
  const S = 4;
  for (let y = 0; y < Math.ceil(cy + r + 1) && y < height; y++) {
    for (let x = Math.max(0, Math.floor(cx - r - 1)); x < width; x++) {
      let inDot = 0;
      let inFill = 0;
      for (let sy = 0; sy < S; sy++)
        for (let sx = 0; sx < S; sx++) {
          const d = Math.hypot(x + (sx + 0.5) / S - cx, y + (sy + 0.5) / S - cy);
          if (d <= r) inDot++;
          if (d <= r - rim) inFill++;
        }
      if (!inDot) continue;
      const cov = inDot / (S * S);
      const fillShare = inFill / inDot;
      const col = [0, 1, 2].map((i) => BADGE_COLORS.fill[i] * fillShare + BADGE_COLORS.ring[i] * (1 - fillShare));
      const o = (y * width + x) * 4;
      // Premultiplied "over": result = dot × coverage + what is there × (1 − coverage), per channel and alpha.
      out[o + 2] = Math.round(col[0] * cov + out[o + 2] * (1 - cov));
      out[o + 1] = Math.round(col[1] * cov + out[o + 1] * (1 - cov));
      out[o] = Math.round(col[2] * cov + out[o] * (1 - cov));
      out[o + 3] = Math.round(255 * cov + out[o + 3] * (1 - cov));
    }
  }
  return out;
}

// ------------------------------------------------------------------ controller

export interface BadgeTarget {
  platform: NodeJS.Platform;
  /** Windows: overlay on the taskbar button (null clears). PNG sizes 16, 24 and 32 for the scale factors 1, 1.5, 2. */
  setOverlay(images: { size: number; png: Buffer }[] | null, description: string): void;
  /** macOS dock / Linux launcher. */
  setBadgeCount(n: number): void;
  /** Tray tooltip, a dot on the tray icon, and the "Wacht op jou" menu item. */
  setTray(s: BadgeState): void;
  /** The owner's interface language for the description (default Dutch). */
  lang?(): string;
}

/**
 * Applies the badge, debounced and only when something changed. The main window's report wins; without a window
 * (started hidden) the pending approvals from the database are used.
 */
export class DesktopBadge {
  private fallbackWaiting = 0;
  private counts: Partial<BadgeCounts> | null = null;
  private shown = '';
  private timer: NodeJS.Timeout | null = null;
  private pngCache = new Map<string, { size: number; png: Buffer }[]>();
  applied = 0;

  constructor(
    private target: BadgeTarget,
    private debounceMs = 150,
  ) {}

  /** What the main window counts (unread chats + waiting); `null` when the window is gone. */
  report(c: Partial<BadgeCounts> | null) {
    this.counts = c;
    this.schedule();
  }

  /** Pending approvals counted by the main process (used while no window reports). */
  setFallbackWaiting(n: number) {
    this.fallbackWaiting = n;
    this.schedule();
  }

  /** The current state, described in the owner's language (asked each time, so a language change shows at once). */
  get state(): BadgeState {
    return badgeState(this.counts ?? { waiting: this.fallbackWaiting, unread: 0 }, this.target.lang?.() || 'nl');
  }

  /** Apply again even if unchanged (e.g. the window was shown again: Windows drops the overlay with the button). */
  refresh() {
    this.shown = '';
    this.schedule(0);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms = this.debounceMs) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.apply();
    }, ms);
    this.timer.unref?.();
  }

  private apply() {
    const s = this.state;
    const key = `${s.waiting}|${s.unread}|${s.text}`;
    if (key === this.shown) return;
    this.shown = key;
    this.applied++;
    if (this.target.platform === 'win32') {
      if (!s.count) this.target.setOverlay(null, '');
      else {
        let imgs = this.pngCache.get(s.label);
        if (!imgs) this.pngCache.set(s.label, (imgs = [16, 24, 32].map((size) => ({ size, png: renderBadgePng(s.label, size) }))));
        this.target.setOverlay(imgs, s.text);
      }
    } else this.target.setBadgeCount(s.count);
    this.target.setTray(s);
  }
}
