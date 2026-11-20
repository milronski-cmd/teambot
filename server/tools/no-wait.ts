/**
 * A bot does not hold a turn open to wait. A command that only waits (a long sleep, or a loop that polls every half
 * minute or slower until something happens) keeps the turn busy for as long as that takes: nothing else of that bot
 * runs, a colleague waits for its answer, and an update of the app cannot be installed (live, 20 Nov 2026: a bot
 * waited in a loop for a deploy planned hours later, three times in one evening). Waiting for a time is what a routine
 * is for: the bot plans a one-off routine at that time, ends its turn, and is called back by itself.
 *
 * Short waits stay: a pause under ten minutes, and a loop that looks every few seconds (a build that takes minutes).
 */

const LONG_SLEEP_S = 600;
const SLOW_POLL_S = 30;

/** Seconds of every explicit wait in a command: `sleep 90`, `sleep 5m`, `Start-Sleep -Seconds 90`, `timeout /t 90`. */
function sleeps(cmd: string): number[] {
  const out: number[] = [];
  const unit: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 };
  for (const m of cmd.matchAll(/\bsleep\s+(\d+(?:\.\d+)?)([smhd])?\b/gi)) out.push(Number(m[1]) * (unit[(m[2] || 's').toLowerCase()] || 1));
  for (const m of cmd.matchAll(/\bStart-Sleep\b[^;|\n]*?(?:-Seconds\s+|-s\s+)?(\d+(?:\.\d+)?)\b/gi)) out.push(Number(m[1]));
  for (const m of cmd.matchAll(/\bStart-Sleep\b[^;|\n]*?-Milliseconds\s+(\d+)/gi)) out.push(Number(m[1]) / 1000);
  for (const m of cmd.matchAll(/\btimeout\s+\/t\s+(\d+)/gi)) out.push(Number(m[1]));
  return out.filter((n) => Number.isFinite(n) && n > 0);
}

/** Why this command is waiting in a turn (one sentence for the bot), or null. */
export function waitsInTurn(command: string | undefined | null): string | null {
  const cmd = String(command || '');
  if (!cmd || !/\bsleep\b|\bStart-Sleep\b|\btimeout\s+\/t\b/i.test(cmd)) return null;
  const list = sleeps(cmd);
  if (!list.length) return null;
  const longest = Math.max(...list);
  const loop = /\b(?:until|while)\b[\s\S]{0,400}?\bdo\b|\bwhile\s*\([\s\S]{0,300}?\)\s*\{|\bdo\s*\{[\s\S]{0,400}?\}\s*(?:until|while)\b/i.test(cmd);
  // A loop with its own end ("for i in 1 2 3", a counter that stops it) is a bounded wait: its length is what counts.
  const bounded = /\bfor\s+\w+\s+in\b|\$\(\(\s*\w+\s*\+\s*1\s*\)\)|\+\+|-lt\s+\d+|-gt\s+\d+|\[\s*\$\w+\s+-ge\s+\d+/i.test(cmd);
  if (longest >= LONG_SLEEP_S || (loop && !bounded && longest >= SLOW_POLL_S))
    return 'Niet uitgevoerd: deze opdracht wacht alleen maar, en zolang houdt je beurt alles vast (je eigen andere werk, een collega die op je wacht, een update van de app). Wacht niet in een beurt op iets dat langer dan een paar minuten duurt. Plan een eenmalige vaste taak (routine) op het moment dat het klaar moet zijn, met wat je dan nakijkt en doet, sluit je beurt nu af met wat er loopt, en je wordt op dat moment vanzelf teruggeroepen. Iets dat binnen een paar minuten klaar is, mag je wel afwachten met een korte lus (elke paar seconden kijken).';
  return null;
}
