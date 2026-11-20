import type { Agent, Ctx, Message, Thread } from '../core/types.js';
import { tokens } from '../modules/memory/text.js';

/**
 * What the owner already answered. A question a bot asked him (ask_user) and his answer are kept where they were
 * asked, in `approvals`; nothing is copied. They come back in three places:
 *   - a bot that asks the same thing again gets the earlier answer instead of a new card (`again: true` asks anyway,
 *     for when the situation really differs or the bot is not sure);
 *   - a turn about something he answered before gets those answers along, so the bot does not need to ask;
 *   - the owner sees per bot what it asked and learned, and corrects or forgets an answer ("Wacht op jou › Geleerd").
 * Answers hold for the whole team: what he told one bot, a colleague need not ask again. A private bot's questions
 * stay with that bot. Live (20 Nov 2026): "ze vragen wel heel veel", and the same questions came back.
 */

export interface Answered {
  id: string;
  agentId: string | null;
  agentName: string;
  question: string;
  answer: string;
  at: string;
}

const MAX_ROWS = 400;

/** The owner's own words out of a stored answer (a plain text, or the JSON a form card stores). */
export function plainAnswer(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s.startsWith('{') && !s.startsWith('[')) return s;
  try {
    const v = JSON.parse(s);
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(String).join(', ');
    return Object.entries(v)
      .map(([k, x]) => `${k}: ${typeof x === 'string' ? x : JSON.stringify(x)}`)
      .join('; ');
  } catch {
    return s;
  }
}

/** Every answered question of this owner that still counts (not forgotten), newest first. */
export function answeredRows(ctx: Ctx, userId: string): Answered[] {
  const names = new Map(ctx.store.all<any>('SELECT id, name FROM agents WHERE user_id = ?', userId).map((a) => [a.id, a.name]));
  return ctx.store
    .all<any>("SELECT id, agent_id, summary, answer, decided_at, created_at FROM approvals WHERE user_id = ? AND kind = 'question' AND tool = 'ask_user' AND status = 'approved' AND answer IS NOT NULL AND answer != '' AND forgotten_at IS NULL ORDER BY COALESCE(decided_at, created_at) DESC LIMIT ?", userId, MAX_ROWS)
    .map((r) => ({ id: r.id, agentId: r.agent_id, agentName: names.get(r.agent_id) || 'Bot', question: String(r.summary || ''), answer: plainAnswer(r.answer), at: r.decided_at || r.created_at }))
    .filter((r) => r.question.trim() && r.answer.trim());
}

/** The answers this bot may use: its own and those of colleagues that are not private. */
function readable(ctx: Ctx, agent: Agent): Answered[] {
  const hidden = new Set(ctx.store.all<any>('SELECT id, settings FROM agents WHERE user_id = ?', agent.user_id).filter((a) => {
    try {
      return a.id !== agent.id && (typeof a.settings === 'string' ? JSON.parse(a.settings || '{}') : a.settings || {})?.private === true;
    } catch {
      return false;
    }
  }).map((a) => a.id));
  return answeredRows(ctx, agent.user_id).filter((r) => !r.agentId || !hidden.has(r.agentId));
}

/** How much of the earlier question is in this text (0..1) and how many words they share. */
function overlap(question: string, text: string): { share: number; both: number; same: number } {
  const q = new Set(tokens(question));
  const t = new Set(tokens(text, 400));
  if (!q.size || !t.size) return { share: 0, both: 0, same: 0 };
  let both = 0;
  for (const w of q) if (t.has(w)) both++;
  return { share: both / q.size, both, same: both / (q.size + t.size - both) };
}

/** The same question, asked before and answered (or null). */
export function sameQuestion(ctx: Ctx, agent: Agent, question: string): Answered | null {
  let best: { r: Answered; score: number } | null = null;
  for (const r of readable(ctx, agent)) {
    const o = overlap(r.question, question);
    if (o.both >= 3 && o.same >= 0.6 && (!best || o.same > best.score)) best = { r, score: o.same };
  }
  return best?.r || null;
}

/** Earlier answers that are about what this text is about, best first. */
export function earlierAnswers(ctx: Ctx, agent: Agent, text: string, limit = 4): Answered[] {
  return readable(ctx, agent)
    .map((r) => ({ r, o: overlap(r.question, text) }))
    .filter((x) => x.o.both >= 3 && x.o.share >= 0.5)
    .sort((a, b) => b.o.share - a.o.share || b.o.both - a.o.both)
    .slice(0, limit)
    .map((x) => x.r);
}

const day = (iso: string) => String(iso || '').slice(0, 10);
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)} …` : s).replace(/\s+/g, ' ');

/** What the bot hears instead of a second card for the same question. */
export function alreadyAnswered(r: Answered, agent: Agent): string {
  const who = r.agentId && r.agentId !== agent.id ? `${r.agentName} vroeg dit eerder` : 'Dit vroeg je eerder';
  return `${who} (${day(r.at)}): “${short(r.question, 400)}”. Antwoord van je eigenaar: “${short(r.answer, 2000)}”. Werk met dat antwoord. Is de situatie nu echt anders, of weet je niet zeker of het antwoord hier ook geldt, stel de vraag dan opnieuw met again: true en zeg wat er anders is.`;
}

/** Turn context: what the owner already answered about this. Data for the bot, in its owner's conversation only. */
export function answeredContext(ctx: Ctx, agent: Agent, thread: Thread, input: Message | null): string | null {
  if (!input || agent.access_mode === 'chat' || thread.user_id !== agent.user_id || agent.settings?.sharedRun) return null;
  const text = String(input.content || '');
  if (text.length < 12) return null;
  const rows = earlierAnswers(ctx, agent, text);
  if (!rows.length) return null;
  return `Eerder beantwoord door je eigenaar (geldt nog; vraag dit niet opnieuw, tenzij de situatie echt anders is):\n${rows.map((r) => `- (${day(r.at)}) “${short(r.question, 220)}” → “${short(r.answer, 400)}”`).join('\n')}`;
}
