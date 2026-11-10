/**
 * The usage meters in the sidebar footer (0.4.5): pure helpers without the DOM, so the unit tests load them.
 *  - one ring per subscription or provider: the outer ring is the week, the inner ring the 5-hour window (when the
 *    provider has one); the provider's own mark in the middle (components/ProviderMark), or its initial without one;
 *  - calm grey until 75% used, amber from 75%, red from 90% (and at the limit);
 *  - one plain sentence per line in the popover: "Nog 62%, weer vol om do 09:00."
 * Texts are Dutch source templates through `t` (lib/format's tText), so the extractor sees them.
 */
import { formatDate, formatPercent, formatTime, interfaceLocale, tText as t } from '../../lib/format.js';
import { effectiveStatus, engineName, sourceShort, windowName, type BarSourceLike, type BarWindowLike } from './bar.js';

export type MeterTone = 'calm' | 'warn' | 'danger' | 'unknown';

/** Grey until 75% used, amber from 75%, red from 90% or at the limit. Without a number: unknown (unless warned). */
export function meterTone(usedPercent: number | null | undefined, level?: string | null): MeterTone {
  if (level === 'limit' || (typeof usedPercent === 'number' && usedPercent >= 90)) return 'danger';
  if (typeof usedPercent !== 'number') return level === 'warn' ? 'warn' : 'unknown';
  return usedPercent >= 75 || level === 'warn' ? 'warn' : 'calm';
}

/** The worse of two tones (the ring's colour follows its fullest window). */
export function worseTone(a: MeterTone, b: MeterTone): MeterTone {
  const rank: Record<MeterTone, number> = { unknown: 0, calm: 1, warn: 2, danger: 3 };
  return rank[b] > rank[a] ? b : a;
}

const isWeek = (id: string) => id === 'seven_day' || /^[\w.-]+:10080$/.test(id);
const isFive = (id: string) => id === 'five_hour' || /^[\w.-]+:300$/.test(id);

/**
 * Which windows the ring shows: the week outside, the 5 hours inside. Claude's own week (`seven_day`) and Codex's main
 * limit (`codex:…`) go before a second limit of the same account. Without a week the first window is the outer ring.
 */
export function ringWindows<W extends Pick<BarWindowLike, 'id'>>(ws: readonly W[]): { outer: W | null; inner: W | null } {
  const main = (pick: (id: string) => boolean) => ws.find((w) => pick(w.id) && (w.id === 'seven_day' || w.id === 'five_hour' || w.id.startsWith('codex:'))) || ws.find((w) => pick(w.id)) || null;
  const week = main(isWeek);
  const five = main(isFive);
  const outer = week || ws[0] || null;
  return { outer, inner: five && five !== outer ? five : null };
}

/** The other windows worth a line in the popover: only those that are nearly or fully used (a model week at its limit). */
export function extraWindows<W extends Pick<BarWindowLike, 'id' | 'usedPercent' | 'level'>>(ws: readonly W[]): W[] {
  const { outer, inner } = ringWindows(ws);
  return ws.filter((w) => w !== outer && w !== inner && (meterTone(w.usedPercent, w.level) === 'warn' || meterTone(w.usedPercent, w.level) === 'danger'));
}

/**
 * The letter in the middle of each ring: the first letter of the name; two letters where two names start alike
 * ("Cl" and "Co" for Claude and Codex), so the rings never look the same.
 */
export function monograms(names: readonly string[]): string[] {
  const first = (s: string) => Array.from(s.trim())[0]?.toUpperCase() || '?';
  const two = (s: string) => {
    const ch = Array.from(s.trim().replace(/\s+/g, ''));
    return (ch[0] || '?').toUpperCase() + (ch[1] || '').toLowerCase();
  };
  return names.map((n) => (names.filter((x) => first(x) === first(n)).length > 1 ? two(n) : first(n)));
}

/** The providers TeamBot has a simple mark for (components/ProviderMark.tsx draws them). */
export type MarkId = 'claude' | 'openrouter' | 'ollama' | 'opencode' | 'cloudflare' | 'mistral' | 'gemini' | 'codex' | 'groq' | 'kilo';
const MARKS: [RegExp, MarkId][] = [
  [/claude|anthropic/, 'claude'],
  [/openrouter/, 'openrouter'],
  [/opencode/, 'opencode'],
  [/ollama/, 'ollama'],
  [/cloudflare/, 'cloudflare'],
  [/mistral/, 'mistral'],
  [/gemini/, 'gemini'],
  // No licensed mark exists for these three: a neutral glyph of TeamBot's own (a prompt, a bolt, a weight).
  [/codex|chatgpt|openai/, 'codex'],
  [/groq/, 'groq'],
  [/kilo/, 'kilo'],
];

/**
 * Which mark belongs to a provider, from what is known about it (family, kind, id, name), first hint first:
 * "Claude Code" → claude, "openrouter-free" → openrouter. No mark known (an own name, another service): null, and
 * the ring shows the initial.
 */
export function markOf(...hints: (string | null | undefined)[]): MarkId | null {
  for (const h of hints) {
    const text = String(h || '').toLowerCase().replace(/[\s._-]+/g, '');
    if (!text) continue;
    const hit = MARKS.find(([re]) => re.test(text));
    if (hit) return hit[1];
  }
  return null;
}

/** When a window is full again, as the end of a sentence: { at: "15:59" / "do 09:00" } or { on: "13 nov" }. */
function when(ms: number | null | undefined, now: number, locale: string): { at?: string; on?: string } | null {
  if (!ms) return null;
  const d = new Date(ms);
  const n = new Date(now);
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return { at: formatTime(d, locale) };
  if (ms - now < 6 * 86_400_000) return { at: formatDate(d, { weekday: 'short', hour: '2-digit', minute: '2-digit' }, locale) };
  return { on: formatDate(d, { day: 'numeric', month: 'short' }, locale) };
}

/** What is left as a percentage, "≈ " in front when TeamBot derived it. */
export function leftText(w: Pick<BarWindowLike, 'usedPercent' | 'estimated'>, locale = interfaceLocale()): string {
  if (typeof w.usedPercent !== 'number') return '–';
  const p = formatPercent(Math.max(0, Math.round(100 - w.usedPercent)), locale);
  return w.estimated ? `≈ ${p}` : p;
}

/** One window in one plain sentence: "Nog 62%, weer vol om do 09:00.", "Op, weer vol om 15:59.", "Nog niet gemeld." */
export function leftSentence(w: Pick<BarWindowLike, 'usedPercent' | 'resetsAt' | 'level' | 'estimated'>, now = Date.now(), locale = interfaceLocale()): string {
  const at = when(w.resetsAt, now, locale);
  if (w.level === 'limit' || (w.usedPercent ?? 0) >= 100) {
    if (at?.at) return t('Op, weer vol om {0}.', at.at);
    if (at?.on) return t('Op, weer vol op {0}.', at.on);
    return t('Op.');
  }
  if (typeof w.usedPercent !== 'number') return t('Nog niet gemeld.');
  const left = leftText(w, locale);
  if (at?.at) return t('Nog {0}, weer vol om {1}.', left, at.at);
  if (at?.on) return t('Nog {0}, weer vol op {1}.', left, at.on);
  return t('Nog {0}.', left);
}

/** An engine that hit a limit no window shows in numbers: "Op, weer vol om 15:59." */
export function blockedSentence(until: number | null | undefined, now = Date.now(), locale = interfaceLocale()): string {
  const at = when(until, now, locale);
  if (at?.at) return t('Op, weer vol om {0}.', at.at);
  if (at?.on) return t('Op, weer vol op {0}.', at.on);
  return t('Op.');
}

/** A free or local source in one sentence: "Nog 40%, weer vol om 01:00.", "Beschikbaar.", "Op, weer vol om 15:59." */
export function sourceLine(s: BarSourceLike & { usedPercent?: number | null }, now = Date.now(), locale = interfaceLocale()): string {
  const st = effectiveStatus(s, now);
  if (st === 'limited') return blockedSentence(s.resetsAt, now, locale);
  if (typeof s.usedPercent === 'number' && st !== 'offline') return leftSentence({ usedPercent: s.usedPercent, resetsAt: s.resetsAt, level: st === 'low' ? 'warn' : 'ok', estimated: s.estimated }, now, locale);
  if (st === 'low') return t('Bijna op.');
  if (st === 'offline') return t('Niet bereikbaar.');
  if (st === 'unknown') return t('Nog niet bekend.');
  return t('Beschikbaar.');
}

/** The ring of a source: its percentage when known, else full for "op", nothing for the rest. */
export function sourceRing(s: BarSourceLike & { usedPercent?: number | null }, now = Date.now()): { value: number | null; tone: MeterTone; dashed: boolean } {
  const st = effectiveStatus(s, now);
  if (st === 'limited') return { value: 100, tone: 'danger', dashed: false };
  const value = typeof s.usedPercent === 'number' ? s.usedPercent : null;
  if (st === 'low') return { value, tone: 'warn', dashed: false };
  if (st === 'offline' || st === 'unknown') return { value: null, tone: 'unknown', dashed: true };
  return { value, tone: value === null ? 'calm' : meterTone(value), dashed: false };
}

/** The short summary for the meter button (screen readers, tooltip): "Claude nog 62%". */
export function shortLeft(name: string, w: Pick<BarWindowLike, 'usedPercent' | 'level' | 'estimated'> | null, locale = interfaceLocale()): string {
  if (!w) return name;
  if (w.level === 'limit' || (w.usedPercent ?? 0) >= 100) return t('{0} op', name);
  if (typeof w.usedPercent !== 'number') return name;
  return t('{0} nog {1}', name, leftText(w, locale));
}

// ---------------------------------------------------------------- the rings and the popover lines

export interface RingPart {
  /** 0–100 used; null = no number (only the track). */
  value: number | null;
  tone: MeterTone;
  /** A dashed track: not reported, not reachable or unknown (never a fake fill). */
  dashed: boolean;
}

export interface MeterLine {
  key: string;
  /** "Week", "5 uur", "Opus-week"; empty for a free source (its name is the provider's). */
  name: string;
  part: RingPart;
  sentence: string;
}

export interface MeterItem {
  key: string;
  /** The provider's name ("Claude", "Codex", "Groq"): a product name, never translated. */
  name: string;
  /** The provider's mark in the middle of the ring; null = none known, the initial (`mono`) stands there. */
  mark: MarkId | null;
  /** The letter(s) in the middle of the ring when there is no mark. */
  mono: string;
  /** Plan of a subscription ("Max"), or "Gratis" / "Lokaal" for a source. */
  sub: string | null;
  outer: RingPart;
  inner: RingPart | null;
  lines: MeterLine[];
  /** Short words for the meter button: "Claude nog 62%". */
  summary: string;
  estimated: boolean;
}

export interface MeterEngine {
  providerId: string;
  name: string;
  family: string;
  /** The engine's kind ("claude-code", "codex", "opencode" …), a hint for its mark. */
  kind?: string;
  plan: string | null;
  windows: (BarWindowLike & { estimated?: boolean })[];
  blocked: { until: number | null; estimated?: boolean } | null;
  pausedUntil?: number | null;
  reading?: boolean;
  error?: string | null;
}

export interface MeterSource extends BarSourceLike {
  id: string;
  usedPercent?: number | null;
  kind?: 'free' | 'local';
}

function partOf(w: Pick<BarWindowLike, 'usedPercent' | 'level'>): RingPart {
  const tone = meterTone(w.usedPercent, w.level);
  const known = typeof w.usedPercent === 'number';
  return { value: known ? Math.max(0, Math.min(100, w.usedPercent!)) : tone === 'danger' ? 100 : null, tone, dashed: !known && tone === 'unknown' };
}

/** Every ring of the meter, engines first (Claude, Codex, other subscriptions), then the free and local sources. */
export function meterItems(bar: { engines: readonly MeterEngine[]; sources: readonly MeterSource[] }, now = Date.now(), locale = interfaceLocale()): MeterItem[] {
  const items: Omit<MeterItem, 'mono'>[] = [];
  for (const e of bar.engines) {
    const name = engineName(e, [...bar.engines]);
    const stopUntil = e.blocked ? e.blocked.until : e.pausedUntil && e.pausedUntil > now ? e.pausedUntil : null;
    const stopped = !!e.blocked || !!stopUntil;
    const { outer, inner } = ringWindows(e.windows);
    const shown = [outer, inner, ...extraWindows(e.windows)].filter(Boolean) as MeterEngine['windows'];
    const lines: MeterLine[] = shown.map((w) => ({ key: w.id, name: windowName(w), part: partOf(w), sentence: leftSentence(w, now, locale) }));
    const anyFull = shown.some((w) => meterTone(w.usedPercent, w.level) === 'danger');
    if (stopped && !anyFull) lines.unshift({ key: 'blocked', name: t('Limiet'), part: { value: 100, tone: 'danger', dashed: false }, sentence: blockedSentence(stopUntil, now, locale) });
    if (!lines.length)
      lines.push({
        key: 'none',
        name: '',
        part: { value: null, tone: 'unknown', dashed: true },
        sentence: e.reading ? t('Wordt opgevraagd…') : e.error ? t('Opvragen lukte niet: {0}', e.error) : t('Nog niet gemeld.'),
      });
    const outerPart: RingPart = outer ? partOf(outer) : { value: null, tone: 'unknown', dashed: true };
    items.push({
      key: e.providerId,
      name,
      mark: markOf(e.family === 'other' ? '' : e.family, e.kind, e.name),
      sub: e.plan,
      // Stopped at a limit no window shows: the whole ring red, so it is never read as "plenty left".
      outer: stopped && !anyFull ? { value: 100, tone: 'danger', dashed: false } : outerPart,
      inner: inner ? partOf(inner) : null,
      lines,
      summary: stopped && !anyFull ? t('{0} op', name) : shortLeft(name, outer, locale),
      estimated: shown.some((w) => w.estimated) || !!(stopped && e.blocked?.estimated && stopUntil),
    });
  }
  for (const s of bar.sources) {
    const part = sourceRing(s, now);
    const short = sourceShort(s, now);
    items.push({
      key: 'src:' + s.id,
      name: s.label,
      mark: markOf(s.id, s.label),
      sub: s.kind === 'local' ? t('Lokaal') : t('Gratis'),
      outer: part,
      inner: null,
      lines: [{ key: s.id, name: '', part, sentence: sourceLine(s, now, locale) }],
      summary: short ? `${s.label} ${short}` : t('{0} beschikbaar', s.label),
      estimated: !!s.estimated && effectiveStatus(s, now) !== 'available',
    });
  }
  const monos = monograms(items.map((i) => i.name));
  return items.map((i, n) => ({ ...i, mono: monos[n] }));
}

/** The tone of the meter as a whole (the worst ring). */
export function meterWorst(items: readonly Pick<MeterItem, 'outer' | 'inner'>[]): MeterTone {
  return items.reduce<MeterTone>((acc, i) => worseTone(worseTone(acc, i.outer.tone), i.inner?.tone || 'unknown'), 'unknown');
}
