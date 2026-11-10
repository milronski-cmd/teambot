/**
 * Small things the desktop shell remembers between starts: where the main window was and which one-time tips were
 * shown. Kept in Electron's userData (`<data>/electron/shell.json`), which is never part of a backup. No Electron import,
 * so it is tested directly (tests/desktop-shell.test.ts); desktop/main.ts reads the screens and calls these.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ShellState {
  /** The window's last normal (not maximised) place and whether it was maximised. */
  window?: { bounds: Rect; maximized?: boolean };
  /** When the one-time tip "TeamBot keeps running in the background" was shown (the first time the window closed). */
  closeTipAt?: string;
  /** The owner's interface language at the last run: the start page is drawn before the server can say it. */
  lang?: string;
  /** The owner's accent colour at the last run (settings.ui.accent): the window icon is right before the server is up. */
  accent?: string;
}

const FILE = 'shell.json';

/** The size TeamBot was designed for, and the smallest the window may get (desktop/main.ts minWidth/minHeight). */
export const DESIGN_SIZE = { width: 1360, height: 880 } as const;
export const MIN_SIZE = { width: 380, height: 500 } as const;

const isRect = (r: any): r is Rect => !!r && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(r[k])) && r.width > 0 && r.height > 0;

export function readShellState(dir: string): ShellState {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
    const s: ShellState = {};
    if (raw?.window && isRect(raw.window.bounds)) s.window = { bounds: raw.window.bounds, maximized: raw.window.maximized === true };
    if (typeof raw?.closeTipAt === 'string') s.closeTipAt = raw.closeTipAt;
    if (typeof raw?.lang === 'string' && /^[a-z]{2,3}$/.test(raw.lang)) s.lang = raw.lang;
    if (typeof raw?.accent === 'string' && /^[a-z][a-z0-9-]{0,30}$/.test(raw.accent)) s.accent = raw.accent;
    return s;
  } catch {
    return {};
  }
}

/** Merge and save (write to a temporary file, then rename: a hard stop never leaves half a file). */
export function writeShellState(dir: string, patch: ShellState): ShellState {
  const next = { ...readShellState(dir), ...patch };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `${FILE}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(next, null, 1));
    fs.renameSync(tmp, path.join(dir, FILE));
  } catch {
    /* a tip may show once more, the window opens in the middle: never worth failing for */
  }
  return next;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const inside = (x: number, y: number, a: Rect) => x >= a.x && x < a.x + a.width && y >= a.y && y < a.y + a.height;

/**
 * Where the main window opens. The saved place when its title bar is still on one of the screens (screens change: a
 * laptop without its monitor, another resolution), made to fit that screen. Otherwise the design size, but never more
 * than 90% of the main screen's work area (a 1366×768 laptop), in the middle of it.
 */
export function windowBounds(saved: ShellState['window'] | undefined, workAreas: Rect[], primary: Rect): { bounds: Rect; maximized: boolean } {
  if (saved && isRect(saved.bounds)) {
    const b = saved.bounds;
    const area = workAreas.find((a) => inside(b.x + Math.min(b.width / 2, 200), b.y + 16, a));
    if (area) {
      const width = clamp(Math.round(b.width), Math.min(MIN_SIZE.width, area.width), area.width);
      const height = clamp(Math.round(b.height), Math.min(MIN_SIZE.height, area.height), area.height);
      return {
        bounds: { x: clamp(Math.round(b.x), area.x, area.x + area.width - width), y: clamp(Math.round(b.y), area.y, area.y + area.height - height), width, height },
        maximized: saved.maximized === true,
      };
    }
  }
  const width = clamp(Math.min(DESIGN_SIZE.width, Math.round(primary.width * 0.9)), Math.min(MIN_SIZE.width, primary.width), primary.width);
  const height = clamp(Math.min(DESIGN_SIZE.height, Math.round(primary.height * 0.9)), Math.min(MIN_SIZE.height, primary.height), primary.height);
  return {
    bounds: { x: primary.x + Math.round((primary.width - width) / 2), y: primary.y + Math.round((primary.height - height) / 2), width, height },
    maximized: saved?.maximized === true,
  };
}
