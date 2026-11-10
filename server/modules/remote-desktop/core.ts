import { keyNames, planShot, VK, type Monitor, type ShotGeometry } from '../browser/screen-policy.js';

/**
 * Pure parts of "Bureaublad op afstand": the settings, what a frame request may ask for, how a touch on the phone
 * becomes a click on the right pixel of the right monitor, and which keys the owner may send. No I/O, unit-tested.
 */

/** Minutes without any input before a session stops by itself. */
export const IDLE_CHOICES = [5, 10, 15, 30, 60] as const;

export interface RemoteSettings {
  /** Off by default; only switched on at the computer itself. */
  enabled: boolean;
  /** Also mouse and keyboard (otherwise watch only). */
  control: boolean;
  idleMinutes: number;
  changedAt: string | null;
}

export const DEFAULT_SETTINGS: RemoteSettings = { enabled: false, control: true, idleMinutes: 10, changedAt: null };

export function cleanSettings(v: any, cur: RemoteSettings = DEFAULT_SETTINGS): RemoteSettings {
  const o = v && typeof v === 'object' ? v : {};
  const idle = Number(o.idleMinutes);
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : cur.enabled,
    control: typeof o.control === 'boolean' ? o.control : cur.control,
    idleMinutes: (IDLE_CHOICES as readonly number[]).includes(idle) ? idle : cur.idleMinutes,
    changedAt: typeof o.changedAt === 'string' ? o.changedAt : cur.changedAt,
  };
}

/**
 * What the screen driver may show and touch for the owner: the whole screen and every app, except what the driver
 * always blocks (TeamBot itself, so nobody can switch "computer only" settings or the stop button from a distance,
 * and Windows' security prompts). No extra blocked apps or title words: it is the owner's own computer.
 */
export function ownerPolicy() {
  return { allow: [] as string[], full: true, all: true, block: [] as string[], blockTitle: '', owner: true };
}

const MIN_SIDE = 320;
const MAX_SIDE = 2560;

/** The capture plan for one frame: the whole monitor, its long side scaled to `maxSide` (never enlarged). */
export function frameGeometry(mon: Monitor, maxSide: unknown): ShotGeometry {
  const n = Math.round(Number(maxSide));
  const side = Number.isFinite(n) ? Math.max(MIN_SIDE, Math.min(MAX_SIDE, n)) : 1440;
  return planShot(mon, { maxW: side, maxH: side, maxPixels: Number.MAX_SAFE_INTEGER, monitor: mon.index });
}

/** JPEG quality for a frame (20-90). */
export function frameQuality(q: unknown): number {
  const n = Math.round(Number(q));
  return Number.isFinite(n) ? Math.max(20, Math.min(90, n)) : 55;
}

const unit = (v: unknown, what: string): number => {
  const n = v === null || v === undefined || v === '' || typeof v === 'boolean' ? NaN : Number(v);
  if (!Number.isFinite(n)) throw new Error(`Geef ${what} als getal tussen 0 en 1.`);
  return Math.max(0, Math.min(1, n));
};

/** A point on the picture (0..1 from the top left) -> a physical screen pixel on that monitor. */
export function toPhysical(mon: Monitor, nx: unknown, ny: unknown): { x: number; y: number } {
  const x = unit(nx, 'x');
  const y = unit(ny, 'y');
  return { x: mon.x + Math.min(mon.w - 1, Math.floor(x * mon.w)), y: mon.y + Math.min(mon.h - 1, Math.floor(y * mon.h)) };
}

/** The mouse pointer as a point on the picture of this monitor, or null when it is on another monitor. */
export function cursorOn(mon: Monitor, c: { x: number; y: number } | null | undefined): { x: number; y: number } | null {
  if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return null;
  if (c.x < mon.x || c.y < mon.y || c.x >= mon.x + mon.w || c.y >= mon.y + mon.h) return null;
  return { x: (c.x - mon.x + 0.5) / mon.w, y: (c.y - mon.y + 0.5) / mon.h };
}

export type RemoteInput =
  | { type: 'click'; x: number; y: number; button: 'left' | 'right' | 'middle'; count: number }
  | { type: 'move'; x: number; y: number }
  | { type: 'drag'; x: number; y: number; x2: number; y2: number }
  | { type: 'scroll'; x: number; y: number; dy: number; dx: number }
  | { type: 'type'; text: string }
  | { type: 'key'; keys: string[] };

const MAX_TEXT = 2000;

/** Validate what the viewer sends (untrusted). Coordinates stay 0..1 here; `driverCall` maps them. */
export function parseInput(b: any): RemoteInput {
  const type = String(b?.type || '');
  switch (type) {
    case 'click': {
      const button = b.button === 'right' || b.button === 'middle' ? b.button : 'left';
      const count = Math.max(1, Math.min(3, Math.round(Number(b.count) || 1)));
      return { type, x: unit(b.x, 'x'), y: unit(b.y, 'y'), button, count };
    }
    case 'move':
      return { type, x: unit(b.x, 'x'), y: unit(b.y, 'y') };
    case 'drag':
      return { type, x: unit(b.x, 'x'), y: unit(b.y, 'y'), x2: unit(b.x2, 'x2'), y2: unit(b.y2, 'y2') };
    case 'scroll': {
      const clamp = (v: unknown) => Math.max(-30, Math.min(30, Math.round(Number(v) || 0)));
      const dy = clamp(b.dy);
      const dx = clamp(b.dx);
      if (!dy && !dx) throw new Error('Geef aan hoeveel er gescrold moet worden.');
      return { type, x: unit(b.x, 'x'), y: unit(b.y, 'y'), dy, dx };
    }
    case 'type': {
      // No control characters except a new line and tab (the driver presses Enter / Tab for those).
      const text = String(b.text ?? '')
        .replace(/\r\n?/g, '\n')
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
      if (!text) throw new Error('Geen tekst om te typen.');
      if (text.length > MAX_TEXT) throw new Error(`Typ hooguit ${MAX_TEXT} tekens tegelijk.`);
      return { type, text };
    }
    case 'key':
      return { type, keys: ownerKeys(b.keys).names.map((n) => n.join('+')) };
  }
  throw new Error('Onbekende invoer.');
}

/**
 * Keys the owner may send: everything a keyboard has (Alt+Tab, the Windows key, Esc, F-keys …), up to 10 combos at
 * once. Only Ctrl+Alt+Del / Ctrl+Alt+End are refused: Windows does not accept them from software, and they are not
 * needed (the phone has its own lock screen; the computer locks with Win+L).
 */
export function ownerKeys(v: unknown): { names: string[][]; vks: number[][] } {
  const list = Array.isArray(v) ? v.map(String) : String(v ?? '').trim().split(/\s+/);
  const combos = list.map((x) => x.trim()).filter(Boolean);
  if (!combos.length) throw new Error('Geef een toets of combinatie, bijv. "enter" of "ctrl+c".');
  if (combos.length > 10) throw new Error('Hooguit 10 toetscombinaties tegelijk.');
  const names = combos.map(keyNames);
  for (const n of names) if (n.includes('ctrl') && n.includes('alt') && (n.includes('delete') || n.includes('end'))) throw new Error('Ctrl+Alt+Del kan niet op afstand.');
  return { names, vks: names.map((n) => n.map((k) => VK[k] ?? k.toUpperCase().charCodeAt(0))) };
}

/** One validated input -> the driver action and its request (physical pixels, owner policy). */
export function driverCall(input: RemoteInput, mon: Monitor): { action: string; payload: Record<string, any>; summary: string } {
  const policy = ownerPolicy();
  switch (input.type) {
    case 'click': {
      const p = toPhysical(mon, input.x, input.y);
      const what = input.button === 'right' ? 'rechtsklik' : input.count === 2 ? 'dubbelklik' : input.button === 'middle' ? 'middelklik' : 'klik';
      return { action: 'click', payload: { x: p.x, y: p.y, button: input.button, count: input.count, mods: [], policy }, summary: what };
    }
    case 'move': {
      const p = toPhysical(mon, input.x, input.y);
      return { action: 'move', payload: { x: p.x, y: p.y, policy }, summary: 'muis bewogen' };
    }
    case 'drag': {
      const a = toPhysical(mon, input.x, input.y);
      const b = toPhysical(mon, input.x2, input.y2);
      return { action: 'drag', payload: { x: a.x, y: a.y, x2: b.x, y2: b.y, policy }, summary: 'slepen' };
    }
    case 'scroll': {
      const p = toPhysical(mon, input.x, input.y);
      return { action: 'scroll', payload: { x: p.x, y: p.y, dy: input.dy, dx: input.dx, mods: [], policy }, summary: 'scrollen' };
    }
    case 'type':
      return { action: 'type', payload: { text: input.text, policy }, summary: 'typen' };
    case 'key':
      return { action: 'key', payload: { combos: ownerKeys(input.keys).vks, policy }, summary: `toets ${input.keys.join(' ')}` };
  }
}

/** Why a session ended, as a code the viewer turns into a sentence. */
export type EndReason = 'ended' | 'stopped_here' | 'off' | 'idle' | 'gone' | 'unavailable' | 'shutdown' | 'signed_out';
