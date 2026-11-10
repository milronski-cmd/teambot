/**
 * System-wide dictation hotkey (desktop app): the key combination, validated the same way here (settings) and in the
 * desktop shell (Electron accelerator + the Windows virtual-key code to see when you let go).
 */

export const DEFAULT_HOTKEY = 'Control+Alt+Space';

/** Suggestions that Windows itself does not use (Win+H is Windows' own voice typing, Alt+Space the window menu). */
export const HOTKEY_PRESETS = ['Control+Alt+Space', 'Control+Alt+D', 'Control+Alt+Shift+Space', 'Control+Shift+F9', 'F8'];

const MODS: Record<string, { accel: string; label: string; vk: number }> = {
  control: { accel: 'Control', label: 'Ctrl', vk: 0x11 },
  ctrl: { accel: 'Control', label: 'Ctrl', vk: 0x11 },
  commandorcontrol: { accel: 'CommandOrControl', label: 'Ctrl', vk: 0x11 },
  cmdorctrl: { accel: 'CommandOrControl', label: 'Ctrl', vk: 0x11 },
  alt: { accel: 'Alt', label: 'Alt', vk: 0x12 },
  option: { accel: 'Alt', label: 'Alt', vk: 0x12 },
  shift: { accel: 'Shift', label: 'Shift', vk: 0x10 },
  super: { accel: 'Super', label: 'Win', vk: 0x5b },
  meta: { accel: 'Super', label: 'Win', vk: 0x5b },
};
const MOD_ORDER = ['Control', 'CommandOrControl', 'Alt', 'Shift', 'Super'];
/** Windows' own: window menu, voice typing, lock, emoji, IME; and copy/paste/cut/undo themselves. */
const RESERVED = new Set(['Alt+Space', 'Super+H', 'Super+L', 'Super+Space', 'Control+Space', 'Control+C', 'Control+V', 'Control+X', 'Control+Z', 'Control+A', 'Alt+F4', 'Super+D']);

export interface ParsedHotkey {
  /** Electron accelerator, normalised (e.g. "Control+Alt+Space"). */
  accel: string;
  /** For people: "Ctrl+Alt+Spatie". */
  label: string;
  /** Windows virtual-key code of the main key (to detect when it is released). */
  vk: number;
  mods: string[];
}

function mainKey(k: string): { accel: string; label: string; vk: number } | null {
  const u = k.toUpperCase();
  if (/^[A-Z]$/.test(u)) return { accel: u, label: u, vk: u.charCodeAt(0) };
  if (/^[0-9]$/.test(u)) return { accel: u, label: u, vk: u.charCodeAt(0) };
  const f = /^F([1-9]|1[0-9]|2[0-4])$/.exec(u);
  if (f) return { accel: `F${f[1]}`, label: `F${f[1]}`, vk: 0x6f + Number(f[1]) };
  const named: Record<string, { accel: string; label: string; vk: number }> = {
    SPACE: { accel: 'Space', label: 'Spatie', vk: 0x20 },
    SPATIE: { accel: 'Space', label: 'Spatie', vk: 0x20 },
    INSERT: { accel: 'Insert', label: 'Insert', vk: 0x2d },
    HOME: { accel: 'Home', label: 'Home', vk: 0x24 },
    END: { accel: 'End', label: 'End', vk: 0x23 },
    PAGEUP: { accel: 'PageUp', label: 'PageUp', vk: 0x21 },
    PAGEDOWN: { accel: 'PageDown', label: 'PageDown', vk: 0x22 },
    PAUSE: { accel: 'Pause', label: 'Pause', vk: 0x13 },
    SCROLLLOCK: { accel: 'Scrolllock', label: 'Scroll Lock', vk: 0x91 },
  };
  return named[u] || null;
}

/** null = not a usable combination. Needs a modifier, except for function keys. Escape/Enter/Tab are never allowed. */
export function parseHotkey(raw: unknown): ParsedHotkey | null {
  if (typeof raw !== 'string' || raw.length > 60) return null;
  const parts = raw.split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length || parts.length > 5) return null;
  const key = mainKey(parts[parts.length - 1]);
  if (!key) return null;
  const mods = new Map<string, { accel: string; label: string; vk: number }>();
  for (const p of parts.slice(0, -1)) {
    const m = MODS[p.toLowerCase()];
    if (!m) return null;
    mods.set(m.accel, m);
  }
  if (!mods.size && !/^F\d+$/.test(key.accel)) return null;
  if (mods.size === 1 && mods.has('Shift')) return null; // Shift+letter is just typing
  const ordered = MOD_ORDER.filter((m) => mods.has(m)).map((m) => mods.get(m)!);
  const accel = [...ordered.map((m) => m.accel), key.accel].join('+');
  if (RESERVED.has(accel)) return null;
  return {
    accel,
    label: [...ordered.map((m) => m.label), key.label].join('+'),
    vk: key.vk,
    mods: ordered.map((m) => m.accel),
  };
}

export const hotkeyLabel = (accel: string) => parseHotkey(accel)?.label || accel;
