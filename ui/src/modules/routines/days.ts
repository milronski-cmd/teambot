/**
 * Day codes as models write them in routine_create (`days`), to the Dutch name the routine card shows. The server
 * understands the same codes (server/modules/routines/schedule.ts parseDay): Dutch (ma, maa, maandag), English (MO,
 * Mon, Monday) and numbers (0 or 7 = Sunday, 1 = Monday). Pure (no imports), so it is unit-tested
 * (tests/routine-days.test.ts).
 */

const LONG = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];

const CODES: Record<string, number> = {
  zo: 0, zon: 0, zondag: 0, su: 0, sun: 0, sunday: 0,
  ma: 1, maa: 1, maandag: 1, mo: 1, mon: 1, monday: 1,
  di: 2, din: 2, dinsdag: 2, tu: 2, tue: 2, tues: 2, tuesday: 2,
  wo: 3, woe: 3, woensdag: 3, we: 3, wed: 3, wednesday: 3,
  do: 4, don: 4, donderdag: 4, th: 4, thu: 4, thur: 4, thurs: 4, thursday: 4,
  vr: 5, vrij: 5, vrijdag: 5, fr: 5, fri: 5, friday: 5,
  za: 6, zat: 6, zaterdag: 6, sa: 6, sat: 6, saturday: 6,
};

/** The weekday (0 = Sunday … 6 = Saturday) of a code, or null when it is none. "Mon.", "MO", 1 and "maandag" → 1. */
export function dayNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v === 7 ? 0 : v >= 0 && v <= 6 ? v : null;
  const s = String(v ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (/^[0-7]$/.test(s)) return Number(s) % 7;
  return CODES[s] ?? null;
}

/** The Dutch name of a day code ("MO" → "maandag"); an unknown code stays as it is. */
export function dayName(v: unknown): string {
  const n = dayNumber(v);
  return n === null ? String(v ?? '') : LONG[n];
}

/** When a weekly routine runs, in words: "elke maandag, woensdag", "elke werkdag", "elk weekend" or "elke dag". */
export function everyText(days: unknown[]): string {
  if (!days.length) return 'elke dag';
  const nums = days.map(dayNumber);
  if (nums.every((n) => n !== null)) {
    // Monday first, as in the Netherlands.
    const set = [...new Set(nums as number[])].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    if (set.length === 7) return 'elke dag';
    if (set.join(',') === '1,2,3,4,5') return 'elke werkdag';
    if (set.join(',') === '6,0') return 'elk weekend';
    return `elke ${set.map((n) => LONG[n]).join(', ')}`;
  }
  return `elke ${days.map(dayName).join(', ')}`;
}
