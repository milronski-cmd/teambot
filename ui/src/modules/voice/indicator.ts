/**
 * Who listens, who thinks, who speaks: the one line (and the state of each face) a spoken call shows, for a call with
 * one bot and for a group call with several. No other product shows which of several bots listens (research of
 * 9 November 2026); here it is always visible, in plain words, next to the bot's own name and face.
 * Pure: the call screens render it with `t` (the interface language), tests/voice-talk.test.ts checks the Dutch source.
 */
import { fillSource } from '../../lib/i18n-core.js';

/** A Dutch template with values, in the interface language (the page passes lib/i18n `t`; default: the Dutch source). */
export type Fmt = (tpl: string, ...values: (string | number)[]) => string;
const dutch: Fmt = (tpl, ...values) => (values.length || /\{\d+\s*,\s*plural\s*,/.test(tpl) ? fillSource(tpl, values) : tpl);

/** What a face shows: it listens to you, thinks (works on an answer), speaks, waits for your approval, or nothing. */
export type BotStatus = 'listening' | 'thinking' | 'speaking' | 'waiting' | 'idle';

/** States of the call with one bot (halfduplex-core HdState, plus Realtime's own). */
export type CallPhase = 'connecting' | 'ready' | 'listening' | 'user' | 'transcribing' | 'thinking' | 'bot' | 'waiting_approval' | 'speaking' | 'muted' | 'paused';

/** States of the group call. */
export type GroupPhase = 'connecting' | 'ready' | 'listening' | 'user' | 'transcribing' | 'waiting' | 'speaking' | 'muted';

/** "Houd de spatiebalk of de knop ingedrukt om te praten" (a computer), "Houd de knop ingedrukt…" (a touch screen). */
export const holdHint = (keyboard: boolean, t: Fmt = dutch) => (keyboard ? t('Houd de spatiebalk of de knop ingedrukt om te praten') : t('Houd de knop ingedrukt om te praten'));

/** The bot's status and the line under its face in a call with one bot. */
export function callIndicator(state: CallPhase, name: string, o: { keyboard?: boolean; t?: Fmt } = {}): { status: BotStatus; text: string } {
  const t = o.t || dutch;
  switch (state) {
    case 'connecting':
      return { status: 'idle', text: t('Verbinden…') };
    case 'ready':
      return { status: 'idle', text: holdHint(o.keyboard !== false, t) };
    case 'listening':
      return { status: 'listening', text: t('{0} luistert', name) };
    case 'user':
      return { status: 'listening', text: t('{0} luistert naar je', name) };
    case 'transcribing':
    case 'thinking':
    case 'bot':
      return { status: 'thinking', text: t('{0} denkt na…', name) };
    case 'waiting_approval':
      return { status: 'waiting', text: t('{0} wacht op je goedkeuring', name) };
    case 'speaking':
      return { status: 'speaking', text: t('{0} spreekt', name) };
    case 'muted':
      return { status: 'idle', text: t('Microfoon gedempt') };
    case 'paused':
      return { status: 'idle', text: t('Gepauzeerd') };
  }
}

export interface GroupBot {
  id: string;
  name: string;
}

/** "Ada denkt na…", "Ada en Bo denken na…", "3 bots denken na…". */
function thinkingText(names: string[], t: Fmt): string {
  if (names.length === 1) return t('{0} denkt na…', names[0]);
  if (names.length === 2) return t('{0} en {1} denken na…', names[0], names[1]);
  return t('{0, plural, one {# bot denkt na…} other {# bots denken na…}}', names.length);
}

/**
 * The group call: each bot's status (the one that speaks, the ones that work on an answer, all of them listening to
 * you) and one line for the whole group. `speaking`: the bot whose answer is read aloud now; `working`: bots with a
 * run in this group chat.
 */
export function groupIndicator(o: { state: GroupPhase; bots: GroupBot[]; speaking: string | null; working: string[]; keyboard?: boolean; t?: Fmt }): { bots: (GroupBot & { status: BotStatus })[]; text: string } {
  const t = o.t || dutch;
  const listening = o.state === 'listening' || o.state === 'user';
  const bots = o.bots.map((b) => ({
    ...b,
    status: (b.id === o.speaking ? 'speaking' : o.working.includes(b.id) ? 'thinking' : listening ? 'listening' : 'idle') as BotStatus,
  }));
  const speaker = bots.find((b) => b.status === 'speaking');
  const thinking = bots.filter((b) => b.status === 'thinking').map((b) => b.name);
  let text: string;
  if (o.state === 'user') text = t('De groep luistert naar je');
  else if (speaker) text = t('{0} spreekt', speaker.name);
  else if (thinking.length) text = thinkingText(thinking, t);
  else if (o.state === 'ready') text = holdHint(o.keyboard !== false, t);
  else if (o.state === 'listening') text = t('De groep luistert');
  else if (o.state === 'transcribing') text = t('Omzetten naar tekst…');
  // (between two answers, or before a bot's run shows up: nobody is known to work right now)
  else if (o.state === 'waiting') text = t('Even wachten…');
  else if (o.state === 'speaking') text = t('Een bot spreekt');
  else if (o.state === 'connecting') text = t('Verbinden…');
  else text = t('Microfoon gedempt');
  return { bots, text };
}

/** The face's mood for a status (lib/botface): thinking = working, waiting for you = waiting. */
export const statusMood = (s: BotStatus): 'idle' | 'working' | 'waiting' => (s === 'thinking' ? 'working' : s === 'waiting' ? 'waiting' : 'idle');
