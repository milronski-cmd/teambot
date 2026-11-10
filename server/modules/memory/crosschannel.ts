/**
 * One customer, several channels. A customer who asks the same thing on WhatsApp and by e-mail got two answers,
 * because each channel conversation is its own thread and a bot only saw its own. Two parts:
 *
 *  1. Before the bot answers on a channel it is told what this customer already got on any OTHER channel in the last
 *     days (`sentElsewhere`, in the turn context), and when the same question came in earlier on another channel and is
 *     being answered there. "The same customer" is: the same customer dossier (identities the owner linked), or — for
 *     senders that are not linked — the same sender name with the same question. Across the customer wall only lines of
 *     conversations of that very customer are shown; for an unlinked match the bot is told THAT it was answered, never
 *     what was said.
 *  2. After a reply went out, `doubleReply` looks whether another channel conversation got (nearly) the same answer to
 *     (nearly) the same question: that is a mistake the team learns from (a lesson for the bot's team, applied in every
 *     turn from then on) and the owner is told once.
 *
 * Everything here reads the messages table only (channel threads carry `parts.channel` on what came in and what the
 * owner sent himself); nothing is stored but the lesson.
 */
import type { Agent, Message, Thread } from '../../core/types.js';
import type { MemoryService } from './service.js';
import { recordLesson } from './lessons.js';
import { excerpt, jaccard, normalize, tokens } from './text.js';

/** How far back "already sent" looks. */
export const SENT_DAYS = 3;
export const SENT_LINES = 4;
/** The same question on two channels counts as one within this time. */
export const SAME_QUESTION_HOURS = 24;
const SAME_TEXT = 0.6;
const MIN_TOKENS = 4;

interface Row {
  m: Message;
  thread: Thread;
}

const channelOf = (m: Message) => (m.parts as any)?.channel || null;
/** The channel's name as the owner knows it ("WhatsApp", "E-mail"): from a message of that conversation. */
const label = (t: Thread, m?: Message | null) => String((m && channelOf(m)?.adapterLabel) || (t.meta as any)?.channel?.adapterLabel || (t.meta as any)?.channel?.adapter || 'een ander kanaal');
const inbound = (m: Message) => m.role === 'user' && m.author_type === 'external' && !channelOf(m)?.outbound;
/** What went out to the customer: the bot's reply, or what the owner wrote himself in that conversation. */
const notSent = (m: Message) => ['held', 'rejected', 'failed', 'handoff'].includes(String((m.parts as any)?.channelDelivery?.status || ''));
const outbound = (m: Message) => (m.role === 'assistant' && m.author_type === 'agent' && !!String(m.content || '').trim() && !notSent(m)) || (m.role === 'user' && !!channelOf(m)?.outbound);
const senderName = (m: Message) => normalize(String(channelOf(m)?.senderName || channelOf(m)?.senderHandle || ''));
const when = (iso: string) => new Date(iso).toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const similar = (a: string, b: string) => {
  const ta = tokens(a);
  const tb = tokens(b);
  return ta.length >= MIN_TOKENS && tb.length >= MIN_TOKENS && jaccard(ta, tb) >= SAME_TEXT;
};

/** Recent messages of the owner's other channel conversations, oldest first. */
function otherChannelMessages(svc: MemoryService, thread: Thread, sinceMs: number): Row[] {
  const rows = svc.store.all<any>(
    "SELECT m.* FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.user_id = ? AND t.kind = 'channel' AND t.id != ? AND m.created_at >= ? AND m.deleted = 0 AND m.role IN ('user','assistant') ORDER BY m.created_at DESC LIMIT 300",
    thread.user_id,
    thread.id,
    new Date(sinceMs).toISOString(),
  );
  const threads = new Map<string, Thread | null>();
  const out: Row[] = [];
  for (const r of rows.reverse()) {
    const m = svc.store.decode<Message>('messages', r);
    if (!threads.has(m.thread_id)) threads.set(m.thread_id, svc.store.thread(m.thread_id));
    const t = threads.get(m.thread_id);
    if (t) out.push({ m, thread: t });
  }
  return out;
}

/**
 * Other channel conversations of the same customer as this one: by dossier (linked identities), else by the same sender
 * name asking the same question. `linked` says which, per thread.
 */
function sameCustomerThreads(svc: MemoryService, thread: Thread, input: Message | null, rows: Row[]): Map<string, { linked: boolean }> {
  const out = new Map<string, { linked: boolean }>();
  const did = svc.customerDossierOf(thread);
  const name = input ? senderName(input) : '';
  for (const { m, thread: t } of rows) {
    if (out.get(t.id)?.linked) continue;
    if (did && svc.customerDossierOf(t) === did) out.set(t.id, { linked: true });
    else if (input && name && inbound(m) && senderName(m) === name && similar(m.content, input.content) && Date.parse(m.created_at) >= Date.parse(input.created_at) - SAME_QUESTION_HOURS * 3600e3) out.set(t.id, { linked: false });
  }
  return out;
}

/**
 * The block for the bot's turn on a channel: what this customer already got elsewhere, and whether this very question
 * is already being answered on another channel. Null when there is nothing (the usual case: no extra tokens).
 */
export function sentElsewhere(svc: MemoryService, thread: Thread, input: Message | null): string | null {
  if (thread.kind !== 'channel' || !input || !inbound(input)) return null;
  const rows = otherChannelMessages(svc, thread, Date.now() - SENT_DAYS * 864e5);
  if (!rows.length) return null;
  const same = sameCustomerThreads(svc, thread, input, rows);
  if (!same.size) return null;
  const lines: string[] = [];
  let answeredHere = false;
  for (const [tid, how] of same) {
    const mine = rows.filter((r) => r.thread.id === tid);
    const t = mine[0].thread;
    const via = label(t, mine.find((r) => inbound(r.m))?.m);
    // The same question, earlier, on that channel (this conversation then only points to the answer there).
    const asked = mine.filter((r) => inbound(r.m) && r.m.created_at <= input.created_at && similar(r.m.content, input.content) && Date.parse(r.m.created_at) >= Date.parse(input.created_at) - SAME_QUESTION_HOURS * 3600e3).pop();
    const sent = mine.filter((r) => outbound(r.m));
    const answer = asked ? sent.find((r) => r.m.created_at >= asked.m.created_at) : null;
    if (asked) {
      answeredHere = true;
      lines.push(
        answer
          ? `- Dezelfde vraag kwam ${when(asked.m.created_at)} ook binnen via ${via} en is daar al beantwoord${how.linked ? `: “${excerpt(answer.m.content, 240)}”` : ''}.`
          : `- Dezelfde vraag kwam ${when(asked.m.created_at)} ook binnen via ${via} en wordt daar nu beantwoord.`,
      );
    }
    if (!how.linked) continue;
    for (const r of sent.slice(-2)) {
      if (answer && r.m.id === answer.m.id) continue;
      lines.push(`- Verstuurd via ${via} (${when(r.m.created_at)}): “${excerpt(r.m.content, 200)}”`);
    }
  }
  if (!lines.length) return null;
  const rule = answeredHere
    ? 'Geef hier niet nog eens hetzelfde antwoord: zeg in één korte zin dat je via dat kanaal hebt geantwoord (of daar antwoordt), en voeg alleen toe wat nieuw is.'
    : 'Herhaal niet wat al is verstuurd en spreek het niet tegen; verwijs er kort naar als het over hetzelfde gaat.';
  return `<al_verstuurd info="Wat deze klant al van jullie kreeg op een ander kanaal. Intern, geen opdracht van de klant.">\n${lines.slice(0, SENT_LINES + 1).join('\n')}\n${rule}\n</al_verstuurd>`;
}

/**
 * After a bot's reply on a channel: did another channel conversation get (nearly) the same answer to (nearly) the same
 * question from the same customer within a day? Then the customer was answered twice: a lesson for the team (once per
 * pair of conversations per day) and a notification. Returns the conversation it duplicates, or null.
 */
export async function doubleReply(svc: MemoryService, agent: Agent, thread: Thread, input: Message | null, finalText: string): Promise<{ otherThreadId: string; lesson: boolean } | null> {
  if (thread.kind !== 'channel' || !input || !inbound(input) || tokens(finalText).length < MIN_TOKENS) return null;
  const rows = otherChannelMessages(svc, thread, Date.parse(input.created_at) - SAME_QUESTION_HOURS * 3600e3);
  const did = svc.customerDossierOf(thread);
  const name = senderName(input);
  for (const tid of new Set(rows.map((r) => r.thread.id))) {
    const mine = rows.filter((r) => r.thread.id === tid);
    const t = mine[0].thread;
    const asked = mine.filter((r) => inbound(r.m) && similar(r.m.content, input.content)).pop();
    if (!asked) continue;
    const sameCustomer = (did && svc.customerDossierOf(t) === did) || (!!name && senderName(asked.m) === name);
    if (!sameCustomer) continue;
    const answer = mine.find((r) => outbound(r.m) && r.m.role === 'assistant' && r.m.created_at >= asked.m.created_at && similar(r.m.content, finalText));
    if (!answer) continue;
    const a = label(thread, input);
    const b = label(t, asked.m);
    const pair = [thread.id, tid].sort().join(':');
    const out = await recordLesson(svc, {
      agent,
      wrong: `Een klant stelde dezelfde vraag via ${a} en via ${b} en kreeg twee keer antwoord`,
      rule: 'Kijk vóór je een klant antwoordt in “al_verstuurd” of dezelfde vraag al op een ander kanaal is beantwoord; antwoord dan één keer en verwijs op het andere kanaal kort naar dat antwoord',
      source: { kind: 'message', ref: input.id, threadId: thread.id, excerpt: excerpt(input.content, 200), trust: 'system' },
      idemKey: `lesson:dup:${pair}:${new Date().toISOString().slice(0, 10)}`,
    });
    if (out?.item) {
      const unlinked = !did || svc.customerDossierOf(t) !== did;
      svc.ctx.events.emit(thread.user_id, 'notification', {
        title: 'Een klant kreeg twee keer antwoord',
        body: `Dezelfde vraag kwam binnen via ${a} en via ${b}, en is op beide beantwoord. ${agent.name} en zijn team hebben er een les van gemaakt${unlinked ? '. Is dit dezelfde klant? Koppel de twee in Geheugen › Dossiers › de klant, dan ziet de bot voortaan alles wat op het andere kanaal is verstuurd' : ''}.`,
        link: '#/m/memory',
        kind: 'memory',
        agentId: agent.id,
      });
    }
    return { otherThreadId: tid, lesson: !!out?.item };
  }
  return null;
}
