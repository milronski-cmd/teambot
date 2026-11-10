/**
 * The usage bar's words and colours: pure helpers without the DOM (the unit tests load them). Texts are Dutch source
 * templates through `t` (lib/format's tText), so the extractor sees them and the interface language applies.
 */
import { formatDate, formatDuration, formatPercent, formatTime, interfaceLocale, tText as t } from '../../lib/format.js';

export type BarTone = 'ok' | 'warn' | 'danger' | 'unknown';
export type SourceStatus = 'available' | 'low' | 'limited' | 'offline' | 'unknown';

export interface BarWindowLike {
  id: string;
  label: string;
  usedPercent: number | null;
  resetsAt: number | null;
  level: 'ok' | 'warn' | 'limit' | 'unknown';
  estimated?: boolean;
}

export interface BarSourceLike {
  label: string;
  status: SourceStatus;
  resetsAt: number | null;
  estimated?: boolean;
}

/** Green below 80%, orange from 80%, red at the limit. Without a number: grey (unless the engine warned itself). */
export function barTone(w: Pick<BarWindowLike, 'usedPercent' | 'level'>): BarTone {
  if (w.level === 'limit' || (w.usedPercent ?? 0) >= 100) return 'danger';
  if (typeof w.usedPercent !== 'number') return w.level === 'warn' ? 'warn' : 'unknown';
  return w.usedPercent >= 80 || w.level === 'warn' ? 'warn' : 'ok';
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The short name of a window in the bar: "5 uur", "Week", "Opus-week", "30 dagen" (else the server's label). */
export function windowName(w: Pick<BarWindowLike, 'id' | 'label'>): string {
  if (w.id === 'five_hour') return t('5 uur');
  if (w.id === 'seven_day') return t('Week');
  const model = w.id.match(/^seven_day_([a-z0-9_]{1,40})$/);
  // A model family is a product name ("Opus", "Fable"): kept as it is.
  if (model) return t('{0}-week', model[1].split('_').map(cap).join(' '));
  const codex = w.id.match(/^codex:(\d+)$/);
  if (codex) {
    const mins = Number(codex[1]);
    if (mins === 300) return t('5 uur');
    if (mins === 10080) return t('Week');
    if (mins % 1440 === 0) return t('{0, plural, one {# dag} other {# dagen}}', mins / 1440);
    if (mins % 60 === 0) return formatDuration(mins / 60, 'hour');
  }
  return w.label;
}

/** "Claude" / "Codex" for the bar; the account's own name when there are two of the same kind (or another engine). */
export function engineName(e: { family: string; name: string }, all: { family: string }[]): string {
  if (e.family === 'other' || all.filter((x) => x.family === e.family).length > 1) return e.name;
  return e.family === 'claude' ? 'Claude' : 'Codex';
}

/** The percentage as the bar shows it: "44%", "≈ 44%" (estimate), "–" (not reported). */
export function percentText(w: Pick<BarWindowLike, 'usedPercent' | 'estimated'>): string {
  if (typeof w.usedPercent !== 'number') return '–';
  const p = formatPercent(Math.round(w.usedPercent));
  return w.estimated ? `≈ ${p}` : p;
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** The reset, short for the bar: "15:59" today, "vr 05:59" this week, "13 nov" later. */
export function resetShort(ms: number | null | undefined, now = Date.now(), locale = interfaceLocale()): string {
  if (!ms) return '';
  const d = new Date(ms);
  if (sameDay(d, new Date(now))) return formatTime(d, locale);
  if (ms - now < 6 * 86_400_000) return formatDate(d, { weekday: 'short', hour: '2-digit', minute: '2-digit' }, locale);
  return formatDate(d, { day: 'numeric', month: 'short' }, locale);
}

/** The reset in full: "vandaag 15:59", "morgen 05:59", "vr 13 nov 05:59". */
export function resetLong(ms: number | null | undefined, now = Date.now(), locale = interfaceLocale()): string {
  if (!ms) return '';
  const d = new Date(ms);
  const time = formatTime(d, locale);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(new Date(now))) / 86_400_000);
  if (diff === 0) return t('vandaag {0}', time);
  if (diff === 1) return t('morgen {0}', time);
  return `${formatDate(d, { weekday: 'short', day: 'numeric', month: 'short' }, locale)} ${time}`;
}

/** The window's name inside a sentence: "Claude week: …" (the bar's own label starts with a capital). */
function nameInSentence(w: Pick<BarWindowLike, 'id' | 'label'>): string {
  return w.id === 'seven_day' || w.id === 'codex:10080' ? t('week') : windowName(w);
}

/** One window as a whole sentence (screen readers, the expanded view): never only a colour. */
export function windowSentence(engine: string, w: BarWindowLike, now = Date.now()): string {
  const name = nameInSentence(w);
  const when = resetLong(w.resetsAt, now);
  const tone = barTone(w);
  const est = w.estimated ? ` ${t('Schatting.')}` : '';
  if (tone === 'danger') return (when ? t('{0} {1}: limiet bereikt, weer beschikbaar {2}.', engine, name, when) : t('{0} {1}: limiet bereikt.', engine, name)) + est;
  if (typeof w.usedPercent !== 'number') return t('{0} {1}: nog niet gemeld.', engine, name);
  const pct = formatPercent(Math.round(w.usedPercent));
  if (tone === 'warn') return (when ? t('{0} {1}: bijna op, {2} gebruikt, reset {3}.', engine, name, pct, when) : t('{0} {1}: bijna op, {2} gebruikt.', engine, name, pct)) + est;
  return (when ? t('{0} {1}: {2} gebruikt, reset {3}.', engine, name, pct, when) : t('{0} {1}: {2} gebruikt.', engine, name, pct)) + est;
}

/** A source that was used up counts as available again once its reset has passed (the server does the same). */
export function effectiveStatus(s: Pick<BarSourceLike, 'status' | 'resetsAt'>, now = Date.now()): SourceStatus {
  return (s.status === 'limited' || s.status === 'low') && s.resetsAt && s.resetsAt <= now ? 'available' : s.status;
}

/** What the dot says next to its name ("" = available: the dot alone, with "beschikbaar" for screen readers). */
export function sourceShort(s: BarSourceLike, now = Date.now()): string {
  const st = effectiveStatus(s, now);
  const when = st === 'limited' || st === 'low' ? resetShort(s.resetsAt, now) : '';
  const est = s.estimated && when ? '≈ ' : '';
  if (st === 'limited') return when ? t('op tot {0}', est + when) : t('op');
  if (st === 'low') return t('bijna op');
  if (st === 'offline') return t('niet bereikbaar');
  if (st === 'unknown') return t('onbekend');
  return '';
}

/** A source as a whole sentence. */
export function sourceSentence(s: BarSourceLike, now = Date.now()): string {
  const st = effectiveStatus(s, now);
  const when = resetLong(s.resetsAt, now);
  const est = s.estimated && when && (st === 'limited' || st === 'low') ? ` ${t('Schatting.')}` : '';
  if (st === 'limited') return (when ? t('{0}: op tot {1}.', s.label, when) : t('{0}: op, nog niet bekend tot wanneer.', s.label)) + est;
  if (st === 'low') return (when ? t('{0}: bijna op, reset {1}.', s.label, when) : t('{0}: bijna op.', s.label)) + est;
  if (st === 'offline') return t('{0}: niet bereikbaar.', s.label);
  if (st === 'unknown') return t('{0}: nog niet bekend.', s.label);
  return t('{0}: beschikbaar.', s.label);
}

/** "Claude en ChatGPT" in the interface language, for the shared-pot sentence. */
export function sharedWith(families: string[], locale = interfaceLocale()): string {
  const names = [...new Set(families.map((f) => (f === 'claude' ? 'Claude' : f === 'codex' ? 'ChatGPT' : '')).filter(Boolean))];
  if (!names.length) return '';
  try {
    return new Intl.ListFormat(locale, { type: 'conjunction' }).format(names);
  } catch {
    return names.join(', ');
  }
}
