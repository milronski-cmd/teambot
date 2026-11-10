/**
 * Sources for an answer that cites none (A-42). TeamBot puts the relevant memories in the context of every turn with
 * an id to cite ([m:abc123]); big models write that id, small local models (Ollama) use the memory but never cite it,
 * so no "Bronnen" showed under "Je hond heet Bram". Here a memory that was in the context counts as a source of an
 * answer when the answer clearly says what the memory holds and the question did not already say it: a name or number
 * from the memory, or several of its words. A memory that was there but not used is left out.
 */
import type { MemoryService } from './service.js';
import type { MemoryItemRow } from './types.js';
import { isStopWord, normalize, stem, stripDiacritics } from './text.js';

interface Word {
  t: string;
  /** A name or another specific word: capitalised in the middle of a sentence ("heet Bram", "in Utrecht"). */
  name: boolean;
  /** A number of two digits or more ("1985", "42"). */
  num: boolean;
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’]*/gu;
/** What may stand between a sentence end (or a line start) and the next word: spaces, markdown, quotes, bullets. */
const MARKUP_TAIL = /[\s*_#>`"“„'(\-–•]+$/;

/** Is the word at `idx` the first of a sentence or line (where a capital says nothing)? */
function sentenceStart(s: string, idx: number): boolean {
  const tail = s.slice(Math.max(0, idx - 16), idx);
  const lead = tail.replace(MARKUP_TAIL, '');
  return !lead || /[.!?:]$/.test(lead) || tail.slice(lead.length).includes('\n');
}

function words(text: string, max = 8000): Word[] {
  const s = String(text || '').slice(0, max);
  const out: Word[] = [];
  for (const m of s.matchAll(WORD)) {
    const raw = m[0];
    const t = normalize(raw).replace(/\s+/g, '');
    if (!t || isStopWord(t)) continue;
    const num = /^\d{2,}$/.test(t);
    const name = !num && /^\p{Lu}/u.test(stripDiacritics(raw)) && !sentenceStart(s, m.index ?? 0);
    if (t.length < 3 && !num && !name) continue;
    out.push({ t: num ? t : stem(t), name, num });
  }
  return out;
}

const set = (ws: Word[]) => new Set(ws.map((w) => w.t));

/**
 * Does `answer` clearly use the memory `memory`? `question` is what the answer replies to: words the question already
 * had are no evidence (the answer repeats them). Deterministic and cheap; tuned to miss rather than to show a wrong one.
 */
export function usesMemory(memory: string, answer: string, question: string): boolean {
  const mem = words(memory, 2000);
  if (!mem.length) return false;
  const ans = words(answer);
  const ansSet = set(ans);
  const qSet = set(words(question, 4000));
  // A word counts as specific when it is a name or number in the memory or where the answer uses it.
  const specific = new Set([...mem, ...ans].filter((w) => w.name || w.num).map((w) => w.t));
  const memSet = set(mem);
  const fresh = [...memSet].filter((t) => !qSet.has(t));
  const hits = fresh.filter((t) => ansSet.has(t));
  if (!hits.length) return false;
  const strong = hits.some((t) => specific.has(t));
  const onTopic = [...memSet].filter((t) => qSet.has(t)).length;
  // The memory is about what was asked ("Hoe heet mijn hond?" ↔ "Mijn hond heet Bram"): its name or two of its words,
  // or one of its words when it shares two with the question ("Wat eet mijn kat graag?" ↔ "… kat … eet graag vis").
  if (onTopic) return strong || hits.length >= 2 || onTopic >= 2;
  // Not about the question's words ("Wat weet je over mij?"): only when the answer repeats a good part of it.
  return hits.length >= 2 && (strong || hits.length / fresh.length >= 0.6);
}

/**
 * Per answer in a thread (assistant message id → memory items it used without citing them). Looks only at memories
 * TeamBot gave this bot in this conversation (memory_usage: per-turn context, and what it looked up itself during the
 * turn), and only at answers without any citation code (those show their own sources).
 */
export function impliedSources(svc: MemoryService, userId: string, threadId: string): { byMessage: Record<string, MemoryItemRow[]>; documents: Record<string, ImpliedDocument[]>; upto: number } {
  const st = svc.store;
  const last = st.one<{ seq: number }>('SELECT MAX(seq) AS seq FROM messages WHERE thread_id = ?', threadId)?.seq ?? 0;
  const byMessage: Record<string, MemoryItemRow[]> = {};
  const documents: Record<string, ImpliedDocument[]> = {};
  const usage = st
    .all<any>('SELECT agent_id, via, refs, created_at FROM memory_usage WHERE thread_id = ? ORDER BY created_at DESC LIMIT 500', threadId)
    .map((u) => ({ ...u, refs: safeRefs(u.refs) }))
    .reverse();
  if (!usage.length) return { byMessage, documents, upto: last };
  // Parts of documents (pdf, Word, text in a dossier) the bot was given: the chunk, and its source while it is live
  // and its dossier readable for this user.
  const chunks = new Map<string, { text: string; source: ImpliedDocument } | null>();
  const chunk = (id: string) => {
    if (!chunks.has(id)) {
      const c = st.one<any>("SELECT c.text, s.id AS sid, s.ref, s.dossier_id FROM memory_chunks c JOIN memory_sources s ON s.id = c.source_id WHERE c.id = ? AND s.status = 'active'", id);
      chunks.set(id, c && svc.dossierRole(userId, c.dossier_id) ? { text: String(c.text || ''), source: { ref: c.ref, id: c.sid } } : null);
    }
    return chunks.get(id) || null;
  };
  const answers = st.all<any>(
    "SELECT m.id, m.content, m.created_at, m.author_id, r.input_message_id, r.created_at AS run_at, r.finished_at FROM messages m JOIN runs r ON r.id = m.run_id WHERE m.thread_id = ? AND m.role = 'assistant' AND m.author_type = 'agent' AND m.status = 'done' AND m.deleted = 0 AND m.content != '' ORDER BY m.seq DESC LIMIT 300",
    threadId,
  );
  const items = new Map<string, MemoryItemRow | null>();
  const item = (id: string) => {
    if (!items.has(id)) {
      const r = svc.itemRow(id);
      const live = r && !['forgotten', 'trashed', 'rejected'].includes(r.status);
      items.set(id, live && (r.user_id === userId || (r.scope === 'dossier' && svc.dossierRole(userId, r.dossier_id))) ? r : null);
    }
    return items.get(id) || null;
  };
  const questions = new Map<string, string>();
  for (const a of answers) {
    if (/\[(?:m|d|b|a|g|p|e|s):[a-z0-9]{4,16}\]/.test(a.content)) continue;
    // (the answer is done before its run is: then everything recorded so far counts)
    const end = a.finished_at || new Date().toISOString();
    const mine = usage.filter((u) => u.agent_id === a.author_id && u.created_at <= end);
    // What was in the context up to this answer (the last turns; earlier ones were said once and are not repeated),
    // plus what the bot looked up itself during this turn.
    const ctxRows = mine.filter((u) => u.via === 'context').slice(-10);
    const toolRows = mine.filter((u) => u.via === 'tool' && u.created_at >= a.run_at);
    const ids = new Set<string>();
    const chunkIds = new Set<string>();
    for (const u of [...ctxRows, ...toolRows])
      for (const r of u.refs) {
        if (r?.p === 'm' && r.id) ids.add(r.id);
        else if (r?.p === 's' && r.id) chunkIds.add(r.id);
      }
    if (!ids.size && !chunkIds.size) continue;
    if (a.input_message_id && !questions.has(a.input_message_id)) questions.set(a.input_message_id, st.message(a.input_message_id)?.content || '');
    const q = a.input_message_id ? questions.get(a.input_message_id) || '' : '';
    const used: MemoryItemRow[] = [];
    for (const id of ids) {
      const r = item(id);
      if (r && usesMemory(svc.contentOf(r), a.content, q)) used.push(r);
      if (used.length >= 5) break;
    }
    if (used.length) byMessage[a.id] = used;
    const docs: ImpliedDocument[] = [];
    for (const id of chunkIds) {
      const c = chunk(id);
      if (c && !docs.some((d) => d.id === c.source.id) && usesDocument(c.text, a.content, q)) docs.push(c.source);
      if (docs.length >= 3) break;
    }
    if (docs.length) documents[a.id] = docs;
  }
  return { byMessage, documents, upto: last };
}

/** A document (dossier source) an answer used without citing it: its ref ("s:<ref>") and id. */
export interface ImpliedDocument {
  ref: string;
  id: string;
}

/** "7.450" and "7 450" are the number 7450 (so "€ 7.450" in an answer matches "7450 euro" in the offer). */
const joinThousands = (s: string) => String(s || '').replace(/(\d)[.   ](?=\d{3}(?!\d))/g, '$1');

/**
 * Does `answer` clearly use this part of a document? Stricter than a memory (a part is long, so a few shared words say
 * little): a name or number from the part that the question did not have, or three of its words.
 */
export function usesDocument(part: string, answer: string, question: string): boolean {
  const doc = words(joinThousands(part), 4000);
  if (!doc.length) return false;
  const ans = words(joinThousands(answer));
  const ansSet = set(ans);
  const qSet = set(words(joinThousands(question), 4000));
  const specific = new Set([...doc, ...ans].filter((w) => w.name || w.num).map((w) => w.t));
  const hits = [...set(doc)].filter((t) => !qSet.has(t) && ansSet.has(t));
  return hits.some((t) => specific.has(t)) || hits.length >= 3;
}

function safeRefs(raw: any): any[] {
  if (Array.isArray(raw)) return raw;
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
