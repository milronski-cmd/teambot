import type { CallTalk } from '../../../../shared/voiceSettings.js';

/**
 * How you talk in a spoken call: hold a key or button while you talk ("hold", push-to-talk), or hands-free (the
 * microphone listens and a pause ends your turn). No DOM types here: the call screens and the tests share it.
 *
 * Default ('auto'): hold on a computer, hands-free on a phone or tablet. On a computer the bot's voice comes out of
 * speakers next to an open microphone, and a pause to think often ends your turn too early; holding a key avoids
 * both (the advice for Claude's and Gemini's voice modes in shared rooms, research of 9 November 2026). A phone is
 * held to the ear or used with earphones, where hands-free works well.
 */
export type TalkSetting = CallTalk;
export type TalkMode = 'hold' | 'handsfree';

/** The mode for this device: an explicit choice, else hold on a computer and hands-free on a touch screen. */
export function talkMode(setting: TalkSetting | string | null | undefined, touch: boolean): TalkMode {
  if (setting === 'hold' || setting === 'handsfree') return setting;
  return touch ? 'handsfree' : 'hold';
}

/**
 * Is this device mainly a touch screen (phone, tablet)? The primary pointer is a finger; a laptop with a touch screen
 * still has a fine primary pointer (mouse, trackpad). Browser only; false elsewhere.
 */
export function touchDevice(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

/** The parts of a keyboard event the talk key needs (a DOM KeyboardEvent fits). */
export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  target?: unknown;
}

/** Elements where Space types a space (or picks an option): the talk key leaves those alone. */
function editable(target: unknown): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean; type?: string } | null;
  if (!el || typeof el !== 'object') return false;
  if (el.isContentEditable) return true;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  // Checkboxes, radios and buttons do not type; everything else does.
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(String(el.type || 'text').toLowerCase());
}

/**
 * The talk key: the space bar without Ctrl, Alt or Cmd (Ctrl+Space is dictation in the composer, Ctrl+Alt+Space the
 * desktop hotkey), and not while typing in a text field.
 */
export function isTalkKey(e: KeyLike): boolean {
  if (e.key !== ' ' && e.code !== 'Space') return false;
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  return !editable(e.target);
}

/** After you let go, the recording keeps running this long: people release the key just before their last word ends. */
export const RELEASE_TAIL_MS = 250;
/** When you press, the recording starts this far in the past (the first syllable often starts with the press). */
export const PRESS_PRE_ROLL_MS = 200;
