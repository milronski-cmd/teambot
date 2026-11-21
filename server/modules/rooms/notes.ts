import crypto from 'node:crypto';
import type { Agent, Ctx } from '../../core/types.js';
import { now } from '../../core/db.js';

/**
 * A note for a colleague: something the other only has to know ("ter info", where a job stands, a correction of your
 * own earlier message, thanks). It starts no turn and gets no answer: the colleague reads it at the start of its next
 * turn, whatever that turn is about.
 *
 * Why (live, 20–21 Nov 2026, a team of 19 bots in 24 hours): two thirds of all turns were bots writing to each other
 * (330 questions, 241 follow-up turns, 184 handed-over jobs, against 136 turns of own work), and a large share of those
 * questions were notices that said themselves that no answer was needed. Every such notice cost the receiver a whole
 * turn with its whole context, and by default the sender a second one for the answer.
 */

const KEEP_MIN = 15;
const MAX_SHOWN = 20;

/** A message that says itself it needs no answer: such a "question" is left as a note. Dutch and English, the first lines only. */
const NOTICE_RE = /\b(ter info(?:rmatie)?|ter kennisgeving|ter kennisname|geen antwoord nodig|geen reactie nodig|geen actie nodig|hoeft niet te antwoorden|fyi|for your information|no (?:reply|answer|response|action) (?:needed|required|necessary))\b/i;
export const isNotice = (message: string) => NOTICE_RE.test(String(message || '').slice(0, 300));

export function leaveNote(ctx: Ctx, from: Agent, to: Agent, text: string): void {
  ctx.store.exec('INSERT INTO bot_notes (id, user_id, to_agent_id, from_agent_id, from_name, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', `bn_${crypto.randomBytes(10).toString('hex')}`, to.user_id, to.id, from.id, from.name, String(text).slice(0, 4000), now());
  ctx.audit(to.user_id, 'team.note', { to: to.name, text: String(text).replace(/\s+/g, ' ').slice(0, 160) }, from.id);
}

/** What colleagues left for this bot since its last turn; read once (kept a quarter of an hour, so one turn sees it whole). */
export function notesContext(ctx: Ctx, agent: Agent): string | null {
  let rows: any[] = [];
  try {
    rows = ctx.store.all<any>('SELECT id, from_name, text, created_at, read_at FROM bot_notes WHERE to_agent_id = ? AND (read_at IS NULL OR read_at >= ?) ORDER BY created_at LIMIT ?', agent.id, new Date(Date.now() - KEEP_MIN * 60_000).toISOString(), MAX_SHOWN);
  } catch {
    return null;
  }
  if (!rows.length) return null;
  const fresh = rows.filter((r) => !r.read_at).map((r) => r.id);
  if (fresh.length) ctx.store.exec(`UPDATE bot_notes SET read_at = ? WHERE id IN (${fresh.map(() => '?').join(',')})`, now(), ...fresh);
  const at = (s: string) => String(s).slice(5, 16).replace('T', ' ');
  return `Meldingen van collega's sinds je vorige beurt (ter info: je hoeft er niet op te antwoorden en niet voor te bedanken; neem ze mee in je werk, en reageer alleen als er iets niet klopt):\n${rows.map((r) => `- ${r.from_name} (${at(r.created_at)} UTC): ${String(r.text).replace(/\s+/g, ' ').trim()}`).join('\n')}`;
}
