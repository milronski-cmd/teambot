/**
 * Pure parts of the remote-desktop viewer: the zoomable view, the touch gestures, the adaptive picture quality, the
 * phone keyboard diff and the hardware keyboard mapping. No React, no DOM: unit-tested in tests/remote-desktop.test.ts.
 */

// ------------------------------------------------------------------ view (fit, zoom, pan)

export interface Box {
  /** container (CSS px) */
  cw: number;
  ch: number;
  /** picture size (its aspect ratio is what counts) */
  iw: number;
  ih: number;
}
/** Zoom (1 = the whole screen fits) and the translation of the picture in container pixels. */
export interface View {
  z: number;
  tx: number;
  ty: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MAX_ZOOM = 8;
export const NO_ZOOM: View = { z: 1, tx: 0, ty: 0 };

/** The picture fitted in the container (centered, aspect kept) at zoom 1. */
export function fitRect(b: Box): Rect {
  if (b.cw <= 0 || b.ch <= 0 || b.iw <= 0 || b.ih <= 0) return { x: 0, y: 0, w: Math.max(0, b.cw), h: Math.max(0, b.ch) };
  const s = Math.min(b.cw / b.iw, b.ch / b.ih);
  const w = b.iw * s;
  const h = b.ih * s;
  return { x: (b.cw - w) / 2, y: (b.ch - h) / 2, w, h };
}

/** Where the picture is drawn in the container for this view. */
export function shownRect(b: Box, v: View): Rect {
  const f = fitRect(b);
  return { x: v.tx + v.z * f.x, y: v.ty + v.z * f.y, w: v.z * f.w, h: v.z * f.h };
}

const clampAxis = (t: number, z: number, start: number, size: number, box: number) => {
  const shown = z * size;
  if (shown <= box) return (box - shown) / 2 - z * start;
  return Math.min(-z * start, Math.max(box - z * (start + size), t));
};

/** Keep the picture on screen: centered while smaller than the container, never beyond its edges when larger. */
export function clampView(b: Box, v: View): View {
  const z = Math.max(1, Math.min(MAX_ZOOM, Number.isFinite(v.z) ? v.z : 1));
  const f = fitRect(b);
  return { z, tx: clampAxis(v.tx, z, f.x, f.w, b.cw), ty: clampAxis(v.ty, z, f.y, f.h, b.ch) };
}

/** Zoom by `factor` keeping the point (px, py) under the fingers, then move by (dx, dy). */
export function zoomAt(b: Box, v: View, factor: number, px: number, py: number, dx = 0, dy = 0): View {
  const z = Math.max(1, Math.min(MAX_ZOOM, v.z * (Number.isFinite(factor) && factor > 0 ? factor : 1)));
  const cx = (px - v.tx) / v.z;
  const cy = (py - v.ty) / v.z;
  return clampView(b, { z, tx: px - z * cx + dx, ty: py - z * cy + dy });
}

export const panBy = (b: Box, v: View, dx: number, dy: number): View => clampView(b, { ...v, tx: v.tx + dx, ty: v.ty + dy });

/** A container point -> a point on the picture (0..1), or null when it is not on the picture. */
export function toPicture(b: Box, v: View, px: number, py: number): { x: number; y: number } | null {
  const r = shownRect(b, v);
  if (r.w <= 0 || r.h <= 0) return null;
  const x = (px - r.x) / r.w;
  const y = (py - r.y) / r.h;
  if (x < 0 || y < 0 || x > 1 || y > 1) return null;
  return { x, y };
}

/** A point on the picture (0..1) -> container point (for the pointer and the drag line). */
export function fromPicture(b: Box, v: View, x: number, y: number): { x: number; y: number } {
  const r = shownRect(b, v);
  return { x: r.x + x * r.w, y: r.y + y * r.h };
}

// ------------------------------------------------------------------ touch gestures

/**
 * What a touch means (all points in container pixels):
 *  - tap = click (a second tap close by right after = double click); hold still = right click;
 *  - hold, then drag = drag with the mouse; a quick one-finger drag pans the picture when zoomed in, else it drags too;
 *  - two fingers moving together = scroll; pinching = zoom (the middle between the fingers also pans);
 *    a quick two-finger tap = right click.
 */
export type GestureOut =
  | { kind: 'click'; x: number; y: number; count: 1 | 2 }
  | { kind: 'right'; x: number; y: number }
  | { kind: 'drag'; x: number; y: number; x2: number; y2: number }
  | { kind: 'scroll'; x: number; y: number; dx: number; dy: number }
  | { kind: 'pan'; dx: number; dy: number }
  | { kind: 'zoom'; factor: number; cx: number; cy: number; dx: number; dy: number }
  | { kind: 'press'; x: number; y: number }
  | { kind: 'line'; x: number; y: number; x2: number; y2: number }
  | { kind: 'clear' };

export const TOUCH_SLOP = 10;
export const LONG_PRESS_MS = 550;
export const DOUBLE_TAP_MS = 380;
export const DOUBLE_TAP_PX = 32;
export const SCROLL_STEP_PX = 36;
const PINCH_RATIO = 0.12;
const TWO_SLOP = 12;
const TWO_TAP_MS = 300;

type P = { x: number; y: number };
const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: P, b: P): P => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

type One = { kind: 'one'; id: number; start: P; at: P; t0: number; mode: 'still' | 'pressed' | 'drag' | 'pressdrag' | 'pan' };
type Two = { kind: 'two'; ids: [number, number]; pts: Map<number, P>; d0: number; m0: P; lastD: number; lastM: P; t0: number; mode: 'undecided' | 'pinch' | 'scroll'; acc: P };
type State = { kind: 'idle' } | One | Two | { kind: 'done'; left: Set<number> };

export class Gestures {
  private s: State = { kind: 'idle' };
  private lastTap: { at: P; t: number } | null = null;

  constructor(private zoomed: () => boolean) {}

  /** A long press timer is due at this time (the component calls tick then); null when none is pending. */
  pressDue(): number | null {
    return this.s.kind === 'one' && this.s.mode === 'still' ? this.s.t0 + LONG_PRESS_MS : null;
  }

  down(id: number, x: number, y: number, t: number): GestureOut[] {
    const p = { x, y };
    const s = this.s;
    if (s.kind === 'idle') {
      this.s = { kind: 'one', id, start: p, at: p, t0: t, mode: 'still' };
      return [];
    }
    if (s.kind === 'one' && s.id !== id) {
      // a second finger: whatever the first one did becomes a two-finger gesture (a drag in progress is dropped)
      const out: GestureOut[] = s.mode === 'drag' || s.mode === 'pressdrag' ? [{ kind: 'clear' }] : [];
      const pts = new Map<number, P>([
        [s.id, s.at],
        [id, p],
      ]);
      const d0 = Math.max(1, dist(s.at, p));
      const m0 = mid(s.at, p);
      this.s = { kind: 'two', ids: [s.id, id], pts, d0, m0, lastD: d0, lastM: m0, t0: t, mode: 'undecided', acc: { x: 0, y: 0 } };
      return out;
    }
    if (s.kind === 'two' || s.kind === 'done') {
      // a third finger: ignore it until every finger is up
      const left = s.kind === 'done' ? s.left : new Set(s.ids);
      left.add(id);
      this.s = { kind: 'done', left };
    }
    return [];
  }

  move(id: number, x: number, y: number, _t: number): GestureOut[] {
    const p = { x, y };
    const s = this.s;
    if (s.kind === 'one' && s.id === id) {
      const prev = s.at;
      s.at = p;
      if (s.mode === 'still' || s.mode === 'pressed') {
        if (dist(s.start, p) <= TOUCH_SLOP) return [];
        if (s.mode === 'pressed') s.mode = 'pressdrag';
        else s.mode = this.zoomed() ? 'pan' : 'drag';
        if (s.mode === 'pan') return [{ kind: 'pan', dx: p.x - s.start.x, dy: p.y - s.start.y }];
      } else if (s.mode === 'pan') return [{ kind: 'pan', dx: p.x - prev.x, dy: p.y - prev.y }];
      return [{ kind: 'line', x: s.start.x, y: s.start.y, x2: p.x, y2: p.y }];
    }
    if (s.kind === 'two' && s.pts.has(id)) {
      s.pts.set(id, p);
      const [a, b] = s.ids.map((i) => s.pts.get(i)!);
      const d = Math.max(1, dist(a, b));
      const m = mid(a, b);
      const out: GestureOut[] = [];
      if (s.mode === 'undecided') {
        // pinch when the distance changes more than the middle moves (fingers rarely report at the same moment)
        if (Math.abs(d / s.d0 - 1) > PINCH_RATIO && Math.abs(d - s.d0) > dist(m, s.m0)) s.mode = 'pinch';
        else if (dist(m, s.m0) > TWO_SLOP) s.mode = 'scroll';
        else return [];
        if (s.mode === 'pinch') {
          // from the start of the gesture, so no movement is lost
          s.lastD = s.d0;
          s.lastM = s.m0;
        }
      }
      if (s.mode === 'pinch') {
        out.push({ kind: 'zoom', factor: d / s.lastD, cx: s.lastM.x, cy: s.lastM.y, dx: m.x - s.lastM.x, dy: m.y - s.lastM.y });
      } else {
        s.acc.x += m.x - s.lastM.x;
        s.acc.y += m.y - s.lastM.y;
        // fingers up = the page moves up = scroll down (dy > 0), like scrolling on the phone itself
        const ny = Math.trunc(-s.acc.y / SCROLL_STEP_PX);
        const nx = Math.trunc(-s.acc.x / SCROLL_STEP_PX);
        if (ny || nx) {
          s.acc.y += ny * SCROLL_STEP_PX;
          s.acc.x += nx * SCROLL_STEP_PX;
          out.push({ kind: 'scroll', x: s.m0.x, y: s.m0.y, dx: nx, dy: ny });
        }
      }
      s.lastD = d;
      s.lastM = m;
      return out;
    }
    return [];
  }

  up(id: number, x: number, y: number, t: number): GestureOut[] {
    const s = this.s;
    if (s.kind === 'one' && s.id === id) {
      this.s = { kind: 'idle' };
      const end = { x, y };
      if (s.mode === 'pressed') return [{ kind: 'right', x: s.start.x, y: s.start.y }];
      if (s.mode === 'still') {
        const last = this.lastTap;
        if (last && t - last.t <= DOUBLE_TAP_MS && dist(last.at, s.start) <= DOUBLE_TAP_PX) {
          this.lastTap = null;
          // the second tap lands exactly on the first: Windows only sees a double click within a few pixels
          return [{ kind: 'click', x: last.at.x, y: last.at.y, count: 2 }];
        }
        this.lastTap = { at: s.start, t };
        return [{ kind: 'click', x: s.start.x, y: s.start.y, count: 1 }];
      }
      if (s.mode === 'drag' || s.mode === 'pressdrag') return [{ kind: 'clear' }, { kind: 'drag', x: s.start.x, y: s.start.y, x2: end.x, y2: end.y }];
      return [];
    }
    if (s.kind === 'two' && s.pts.has(id)) {
      const quick = s.mode === 'undecided' && t - s.t0 <= TWO_TAP_MS;
      const left = new Set(s.ids);
      left.delete(id);
      this.s = left.size ? { kind: 'done', left } : { kind: 'idle' };
      this.lastTap = null;
      return quick ? [{ kind: 'right', x: s.m0.x, y: s.m0.y }] : [];
    }
    if (s.kind === 'done') {
      s.left.delete(id);
      if (!s.left.size) this.s = { kind: 'idle' };
    }
    return [];
  }

  cancel(id: number): GestureOut[] {
    const s = this.s;
    const wasLine = s.kind === 'one' && (s.mode === 'drag' || s.mode === 'pressdrag');
    if (s.kind === 'one' && s.id === id) this.s = { kind: 'idle' };
    else if (s.kind === 'two' || s.kind === 'done') {
      const left = s.kind === 'two' ? new Set(s.ids) : s.left;
      left.delete(id);
      this.s = left.size ? { kind: 'done', left } : { kind: 'idle' };
    }
    return wasLine ? [{ kind: 'clear' }] : [];
  }

  /** Time passes: a finger held still long enough becomes a right click (shown at once, sent on release). */
  tick(t: number): GestureOut[] {
    const s = this.s;
    if (s.kind === 'one' && s.mode === 'still' && t - s.t0 >= LONG_PRESS_MS) {
      s.mode = 'pressed';
      return [{ kind: 'press', x: s.start.x, y: s.start.y }];
    }
    return [];
  }
}

// ------------------------------------------------------------------ adaptive quality

export interface Level {
  id: 'sharp' | 'normal' | 'fast' | 'saver';
  /** long side of the picture in pixels */
  side: number;
  /** JPEG quality */
  q: number;
}
export const LEVELS: Level[] = [
  { id: 'sharp', side: 1920, q: 70 },
  { id: 'normal', side: 1440, q: 55 },
  { id: 'fast', side: 1024, q: 45 },
  { id: 'saver', side: 720, q: 35 },
];
export type QualityChoice = 'auto' | Level['id'];

/**
 * The long side to ask for on this monitor: the level's side for a normal 16:9 screen; a super-wide screen (e.g.
 * 5120×1440) gets a proportionally longer side so its picture is as tall as a normal one (at most 2560).
 */
export function frameSide(level: Level, w: number, h: number): number {
  const aspect = w > 0 && h > 0 ? Math.max(w / h, h / w) : 16 / 9;
  return Math.round(Math.min(2560, level.side * Math.max(1, aspect / (16 / 9))));
}

const SLOW_MS = 700;
const FAST_MS = 260;
const SETTLE_MS = 3000;
const UP_AFTER_MS = 10_000;

/**
 * Automatic quality: the viewer asks for the next picture when the last one arrived, so the time per picture is the
 * connection. Slow (≥ 0.7 s on average) → a step smaller and rougher; fast (≤ 0.26 s) for a while → a step sharper.
 */
export class Adaptive {
  level = 1;
  private avg: number | null = null;
  private changedAt = -Infinity;

  constructor(public choice: QualityChoice = 'auto') {}

  current(): Level {
    if (this.choice !== 'auto') return LEVELS.find((l) => l.id === this.choice) || LEVELS[1];
    return LEVELS[this.level];
  }

  /** Did the last picture take long? (a failed or timed-out picture counts as slow). Returns true when the level changed. */
  record(ms: number, now: number): boolean {
    this.avg = this.avg === null ? ms : this.avg * 0.7 + ms * 0.3;
    if (this.choice !== 'auto' || now - this.changedAt < SETTLE_MS) return false;
    if (this.avg >= SLOW_MS && this.level < LEVELS.length - 1) {
      this.level++;
      this.changedAt = now;
      this.avg = null;
      return true;
    }
    if (this.avg <= FAST_MS && this.level > 0 && now - this.changedAt >= UP_AFTER_MS) {
      this.level--;
      this.changedAt = now;
      this.avg = null;
      return true;
    }
    return false;
  }

  /** Average time per picture so far (ms), for the status line. */
  average(): number | null {
    return this.avg;
  }
}

/**
 * How long to wait before asking for the next picture: at most ~10 per second; when the screen did not change, ease
 * off (0.25 s, after a few unchanged ones 0.6 s), but right after a tap or key always fast again.
 */
export function nextDelay(o: { tookMs: number; unchanged: number; sinceInputMs: number }): number {
  if (o.sinceInputMs < 1500) return Math.max(0, 80 - o.tookMs);
  if (o.unchanged >= 4) return 600;
  if (o.unchanged >= 1) return 250;
  return Math.max(0, 100 - o.tookMs);
}

// ------------------------------------------------------------------ typing

/**
 * The phone's text field changed from `before` to `after`: send a Backspace for every character that went, then the
 * new text. Autocorrect may replace a whole word, so this compares from the start (by characters, not UTF-16 units).
 */
export function typedChange(before: string, after: string): { backspaces: number; text: string } {
  const a = Array.from(before);
  const b = Array.from(after);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return { backspaces: a.length - i, text: b.slice(i).join('') };
}

/** Buttons for keys a phone keyboard does not have. `keys` is what the server understands (ctrl+c, alt+tab …). */
export const KEY_BUTTONS: { label: string; keys: string; aria?: string }[] = [
  { label: 'Enter', keys: 'enter' },
  { label: '⌫', keys: 'backspace', aria: 'Backspace' },
  { label: 'Esc', keys: 'esc' },
  { label: 'Tab', keys: 'tab' },
  { label: 'Ctrl+C', keys: 'ctrl+c' },
  { label: 'Ctrl+V', keys: 'ctrl+v' },
  { label: 'Ctrl+X', keys: 'ctrl+x' },
  { label: 'Ctrl+Z', keys: 'ctrl+z' },
  { label: 'Ctrl+A', keys: 'ctrl+a' },
  { label: 'Alt+Tab', keys: 'alt+tab' },
  { label: '⊞ Win', keys: 'win', aria: 'Windows-toets' },
  { label: '↑', keys: 'up', aria: 'Pijl omhoog' },
  { label: '↓', keys: 'down', aria: 'Pijl omlaag' },
  { label: '←', keys: 'left', aria: 'Pijl links' },
  { label: '→', keys: 'right', aria: 'Pijl rechts' },
  { label: 'Del', keys: 'delete', aria: 'Delete' },
  { label: 'Home', keys: 'home' },
  { label: 'End', keys: 'end' },
  { label: 'PgUp', keys: 'pageup', aria: 'Page Up' },
  { label: 'PgDn', keys: 'pagedown', aria: 'Page Down' },
  { label: 'F5', keys: 'f5' },
  { label: 'Alt+F4', keys: 'alt+f4' },
];

const NAMED: Record<string, string> = {
  Enter: 'enter',
  Backspace: 'backspace',
  Tab: 'tab',
  Escape: 'esc',
  Delete: 'delete',
  Insert: 'insert',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ContextMenu: 'menu',
  ' ': 'space',
};
const CODE: Record<string, string> = { Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`', Space: 'space' };

export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  /** AltGr (Ctrl+Alt on Windows) for characters like @ € { on many keyboards */
  altGraph?: boolean;
}

/** A key on a real keyboard (browser on another PC) -> text to type, a key combo, or null (a modifier on its own). */
export function keyInput(e: KeyLike): { type: 'type'; text: string } | { type: 'key'; keys: string } | null {
  if (/^(Control|Shift|Alt|Meta|AltGraph|CapsLock|NumLock|ScrollLock|OS|Dead|Unidentified|Process)$/.test(e.key)) return null;
  const mods = [e.ctrlKey && !e.altGraph && 'ctrl', e.altKey && !e.altGraph && 'alt', e.metaKey && 'win'].filter(Boolean) as string[];
  if (!mods.length && e.key.length === 1 && e.key !== ' ') return { type: 'type', text: e.key };
  if (!mods.length && e.key === ' ') return { type: 'type', text: ' ' };
  let name = NAMED[e.key] || (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.key) ? e.key.toLowerCase() : '');
  if (!name && e.code) {
    if (/^Key[A-Z]$/.test(e.code)) name = e.code.slice(3).toLowerCase();
    else if (/^Digit[0-9]$/.test(e.code)) name = e.code.slice(5);
    else name = CODE[e.code] || '';
  }
  if (!name && e.key.length === 1 && /^[a-z0-9]$/i.test(e.key)) name = e.key.toLowerCase();
  if (!name) return null;
  const all = [...mods, ...(e.shiftKey && (mods.length || NAMED[e.key] || /^F\d/.test(e.key)) ? ['shift'] : []), name];
  return { type: 'key', keys: all.join('+') };
}
