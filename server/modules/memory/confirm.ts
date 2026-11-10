/**
 * "Ja, doe maar" on a bot's memory proposal counts as the owner's confirmation (plan 0.4 F).
 *
 * Precision first: only a short, plainly affirmative reply of the owner ("ja", "ja, doe maar", "klopt", "yes please")
 * in a private chat, that directly follows a finished answer of the chat's own bot which ends with a concrete memory
 * proposal:
 *  - a question that names the fact: "Zal ik onthouden dat je hond Bram heet?", "Wil je dat ik onthoud: …?",
 *    "Shall I remember that you live in Utrecht?" → the fact in the owner's own voice ("Mijn hond heet Bram"), stored
 *    through the normal pipeline as his explicit wish (origin explicit, source = his reply) with the usual
 *    "Onthouden · Ongedaan maken" line under his message;
 *  - a proposal the bot already made with memory_remember in that turn (waiting in Te beoordelen) that the answer
 *    mentions and asks about → approved, with the undo line under the reply.
 * Anything vaguer ("Zal ik dat onthouden?") stores nothing; the bot is told to name the fact or use memory_remember.
 * Text from a turn that read external content (web, mail, files) stays a proposal, injection-like text is refused by
 * the pipeline, a fact that cannot be turned into the owner's voice with confidence is not stored (the bot is told).
 */
import type { Message, Thread } from '../../core/types.js';
import type { MemoryService } from './service.js';
import type { MemoryItemRow, Scope } from './types.js';
import { approveProposal, dossierMentioned, isOwnerMessage, runTainted, setMsgFlags, writeCandidate } from './pipeline.js';
import { clean, containment, firstPerson, isFiniteVerb, normalize, ownWords, sentences, tidyClause, tokens, wantsShared } from './text.js';
import { usableMemoryTools } from './context.js';

// ------------------------------------------------------------------ the owner's reply

const YES_WORDS = new Set(
  (
    'ja jawel jazeker jaja jep jup yes yep yeah yup sure ok oke okay okido prima goed is doe maar graag klopt dat correct akkoord ' +
    'zeker weten hoor please do it go ahead thats that s right mag top perfect super alsjeblieft aub svp onthoud onthou onthouden ' +
    'sla op opslaan noteer noteren het dit even wel precies exact inderdaad helemaal absoluut natuurlijk tuurlijk lijkt me mij ' +
    'uitstekend fijn thanks thank you bedankt dank je dankje dankjewel zo'
  ).split(' '),
);
const STRONG = new Set('ja jawel jazeker jaja jep jup yes yep yeah yup sure ok oke okay okido prima klopt correct akkoord zeker graag doe inderdaad precies absoluut natuurlijk tuurlijk perfect top super exact goed mag'.split(' '));

/** A short reply that only says yes ("Ja, doe maar!", "klopt", "yes please", 👍) — nothing more, nothing else. */
export function isConfirmation(raw: string): boolean {
  const own = ownWords(raw).trim();
  if (!own || own.length > 80 || own.includes('?')) return false;
  if (/^(?:👍|👌|✅|✔️?)+[!.\s]*$/u.test(own)) return true;
  const words = normalize(own).split(' ').filter(Boolean);
  if (!words.length || words.length > 8) return false;
  if (!words.every((w) => YES_WORDS.has(w))) return false;
  // "ja maar" without "doe/sla maar" is hesitation, not consent.
  if (/\bja maar\b/.test(words.join(' ')) && !/\b(doe|sla|onthoud|onthou) maar\b/.test(words.join(' '))) return false;
  return words.some((w) => STRONG.has(w));
}

// ------------------------------------------------------------------ the bot's proposal

const SEP = String.raw`(\s*:\s*|\s+dat\s+|\s+that\s+)`;
const NL_ASK = new RegExp(
  String.raw`\b(?:zal|wil|mag|kan|zou)\s+ik\b(?:\s+(?:dat|dit|het|dan|even|graag|ook|voor\s+(?:je|jou|u|later)|in\s+(?:mijn|je|het)\s+geheugen))*\s+(onthouden|opslaan|bewaren|noteren|vastleggen|zetten)\b(?:\s+(?:voor\s+(?:je|jou|u|later)|in\s+(?:mijn|je|het)\s+geheugen))*` + SEP + '(.+)$',
  'i',
);
const NL_WANT = new RegExp(String.raw`\bwil\s+(?:je|jij|u)\s+dat\s+ik\b(?:\s+(?:dat|dit|het|even|ook))*\s+(onthoud|onthou|opsla|noteer|vastleg|bewaar)\b(?:\s+in\s+(?:mijn|je|het)\s+geheugen)?` + SEP + '(.+)$', 'i');
const EN_ASK = new RegExp(String.raw`\b(?:shall|should|can|may|could)\s+i\s+(remember|note(?:\s+down)?|save|store|keep\s+in\s+mind)\b(?:\s+(?:this|it))?(?:\s+(?:for\s+you|for\s+later|in\s+(?:my|your)\s+memory))*` + SEP + '(.+)$', 'i');
const EN_WANT = new RegExp(String.raw`\b(?:do\s+you\s+want|would\s+you\s+like)\s+me\s+to\s+(remember|note|save|store)\b(?:\s+(?:this|it))?` + SEP + '(.+)$', 'i');
/** A memory question without the fact itself ("Zal ik dat voor je onthouden?"). */
const GENERIC = /\b(?:zal|wil|mag|kan|zou)\s+ik\b.{0,40}\b(?:onthouden|in\s+(?:mijn|je|het)\s+geheugen)\b|\bwil\s+(?:je|jij|u)\s+dat\s+ik\b.{0,30}\b(?:onthoud|onthou)\b|\b(?:shall|should|can|may)\s+i\s+(?:remember|save|store)\b|\b(?:do\s+you\s+want|would\s+you\s+like)\s+me\s+to\s+(?:remember|save)\b/i;
/** "opslaan/bewaren/zetten" are only about memory when the sentence says so. */
const NEEDS_MEMORY_WORD = /^(opslaan|bewaren|zetten|opsla|bewaar|save|store)/i;

export interface Proposal {
  sentence: string;
  /** Facts as the bot put them (second person), with whether they came as a "dat …" clause. */
  clauses: { text: string; subordinate: boolean }[];
}

/** The concrete memory proposal at the end of a bot answer (null: none; clauses empty: a vague one). */
export function proposalIn(answer: string): Proposal | null {
  const text = String(answer || '').replace(/[*_`]+/g, '').replace(/\[(?:m|d|b|a|g|p|e|s):[a-z0-9]{4,12}\]/gi, '');
  const sents = sentences(text).filter((s) => s.length > 3);
  for (const s of sents.slice(-3).reverse()) {
    if (!s.trim().endsWith('?')) continue;
    const m = s.match(NL_ASK) || s.match(NL_WANT) || s.match(EN_ASK) || s.match(EN_WANT);
    if (m && !(NEEDS_MEMORY_WORD.test(m[1]) && !/geheugen|memory/i.test(s))) {
      const subordinate = /dat|that/i.test(m[2]);
      const body = m[3]
        .replace(/\?+\s*$/, '')
        .replace(/,\s*(?:of|or|en|and)\s+(?:wil|zal|mag|moet|liever|toch|niet|do|would|should|shall)\b.*$/i, '')
        .replace(/\s+of\s+(?:niet|toch|liever)\b.*$/i, '')
        .replace(/^["'„“”‘’]+|["'„“”‘’]+$/g, '')
        .trim();
      const parts = body.split(/,?\s+en\s+dat\s+|,?\s+and\s+that\s+/i).map((x) => x.trim()).filter((x) => x.length >= 3);
      return { sentence: s, clauses: parts.slice(0, 3).map((p) => ({ text: p, subordinate })) };
    }
    if (GENERIC.test(s)) return { sentence: s, clauses: [] };
  }
  return null;
}

// ------------------------------------------------------------------ the fact in the owner's voice

/** Present tense: the "je"-form → the "ik"-form (irregular and ambiguous verbs listed; null = not sure). */
const IK: Record<string, string> = {
  bent: 'ben', is: 'ben', hebt: 'heb', heeft: 'heb', kunt: 'kan', kan: 'kan', zult: 'zal', zal: 'zal', wilt: 'wil', wil: 'wil', mag: 'mag', moet: 'moet',
  gaat: 'ga', staat: 'sta', doet: 'doe', komt: 'kom', ziet: 'zie', slaat: 'sla', eet: 'eet', zit: 'zit', weet: 'weet', laat: 'laat', praat: 'praat',
  wacht: 'wacht', zet: 'zet', haat: 'haat', lacht: 'lach', vindt: 'vind', houdt: 'houd', rijdt: 'rijd', wordt: 'word', heet: 'heet', sport: 'sport',
  start: 'start', test: 'test', kost: 'kost', rust: 'rust', was: 'was', had: 'had', zou: 'zou', werd: 'werd', ging: 'ging', kwam: 'kwam',
  woonde: 'woonde', werkte: 'werkte',
};
function ikForm(w: string): string | null {
  const l = w.toLowerCase();
  if (IK[l]) return IK[l];
  if (/^[a-zà-ÿ]{3,}t$/.test(l) && !/(?:tt|cht|aat|eet|oot|uut|ait|eit|uit|out|ijt)$/.test(l) && !(l.length <= 4 && /st$/.test(l))) return l.slice(0, -1);
  return null;
}
const isVerb = (w: string) => !!w && (w.toLowerCase() in IK || isFiniteVerb(w.toLowerCase()));
/** Words after "je" that show it is the subject, not "your" (je in Utrecht woont, je graag thee drinkt). */
const FUNCTION = new Set(
  'in op bij met voor naar aan van uit om tot over onder tegen zonder sinds vanaf na graag liever het liefst altijd nooit vaak meestal soms elke elk iedere ieder niet geen ook nog al nu inmiddels tegenwoordig thuis zelf de het een dit dat deze die er hier daar morgen vandaag volgende vorige'.split(' '),
);
const isNounLike = (w: string | undefined) => !!w && /^[a-zà-ÿ][a-zà-ÿ-]*$/.test(w) && !FUNCTION.has(w) && !isVerb(w);
/** Verbs that say how something is, not what the owner does: "je hond ziek is", "je kantoor in Utrecht zit". */
const STATE_VERBS = new Set('is was heet heette heeft ligt lag staat stond zit zat valt begint eindigt kost duurt loopt blijft wordt'.split(' '));

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function englishVoice(c: string): string {
  let s = c
    .replace(/^you\s+are\b/i, 'I am')
    .replace(/^you're\b/i, "I'm")
    .replace(/^you\s+were\b/i, 'I was')
    .replace(/^you've\b/i, "I've")
    .replace(/^you\b/i, 'I')
    .replace(/\byourself\b/gi, 'myself')
    .replace(/\byours\b/gi, 'mine')
    .replace(/\byour\b/gi, 'my')
    .replace(/\byou\b/gi, 'me');
  return cap(s);
}

/**
 * The bot's second-person fact in the owner's first person ("je hond Bram heet" → "Mijn hond heet Bram", "je in Utrecht
 * woont" → "Ik woon in Utrecht"). Null when it cannot be done with confidence ("jullie", an unknown verb form).
 */
export function ownerVoice(clause: string, subordinate: boolean): string | null {
  let c = clean(clause, 400).replace(/[?.!]+$/, '').trim();
  if (c.length < 3 || /\bjullie\b/i.test(c)) return null;
  // "Zal ik onthouden dat ik de offertes verwijder?": in the bot's question "ik" is the bot, not a fact of the owner
  // (seen live with a small local model).
  if (/\b(ik|mijn|mij|me|m'n|i|my|mine|myself)\b/i.test(c)) return null;
  const dutch = /\b(je|jij|jou|jouw|u|uw|jezelf)\b/i.test(c) || !/\b(you|your|yours|yourself)\b/i.test(c);
  if (!dutch) return englishVoice(c);
  const w = c.split(/\s+/);
  const lw = w.map((x) => x.toLowerCase());
  const done = new Set<number>();
  if (['je', 'jij', 'u'].includes(lw[0])) {
    // "je" + a noun is "your …" only when the verb fits that noun ("je hond Bram heet", "je kinderen Mo en Lisa
    // heten"); "je koffie zwart drinkt" is something the owner does.
    const last = lw[lw.length - 1];
    const subject = lw[0] !== 'je' || (subordinate ? !isNounLike(lw[1]) || !(STATE_VERBS.has(last) || /en$/.test(last)) : isVerb(lw[1]));
    if (subject) {
      // The verb: second in a main clause, last in a "dat …" clause.
      const vi = subordinate ? w.length - 1 : 1;
      const v = w[vi] ? ikForm(w[vi]) : null;
      if (!v || vi === 0) return null;
      w[0] = 'ik';
      w[vi] = v;
      done.add(0).add(vi);
    } else {
      w[0] = 'mijn';
      done.add(0);
    }
  } else if (['jouw', 'uw'].includes(lw[0])) {
    w[0] = 'mijn';
    done.add(0);
  } else if (!subordinate) {
    // Inverted main clause: "Op vrijdag werk je thuis" → "Op vrijdag werk ik thuis".
    for (let i = 1; i < Math.min(6, w.length - 1); i++) {
      if (['je', 'jij', 'u'].includes(lw[i + 1]) && isVerb(lw[i])) {
        const v = lw[i] in IK ? IK[lw[i]] : lw[i];
        w[i] = v;
        w[i + 1] = 'ik';
        done.add(i).add(i + 1);
        break;
      }
    }
  }
  for (let i = 0; i < w.length; i++) {
    if (done.has(i)) continue;
    const l = w[i].toLowerCase().replace(/[,;:]$/, '');
    const tail = w[i].slice(l.length);
    if (l === 'jouw' || l === 'uw') w[i] = 'mijn' + tail;
    else if (l === 'jou') w[i] = 'mij' + tail;
    else if (l === 'jezelf' || l === 'uzelf') w[i] = 'mezelf' + tail;
    else if (l === 'je') w[i] = (isNounLike(w[i + 1]?.toLowerCase()) && !tail ? 'mijn' : 'me') + tail;
    else if (l === 'jij' || l === 'u') return null;
  }
  const out = w.join(' ');
  return subordinate ? tidyClause(out, true) : cap(out);
}

// ------------------------------------------------------------------ capture

/** The bot answer the owner's message replies to: the last message before it, a finished answer of the chat's bot. */
function previousAnswer(svc: MemoryService, m: Message, thread: Thread): Message | null {
  const before = svc.store.messages(thread.id, { limit: 12, beforeSeq: m.seq }).filter((x) => x.role === 'user' || x.role === 'assistant');
  const last = before.at(-1);
  if (!last || last.role !== 'assistant' || last.author_id !== thread.agent_id || last.status !== 'done' || !last.content?.trim()) return null;
  return last;
}

/** Proposals the bot made with its memory tools in that turn, which its answer names and asks about. */
function askedProposals(svc: MemoryService, answer: Message, userId: string): MemoryItemRow[] {
  if (!answer.run_id) return [];
  const text = answer.content || '';
  if (!sentences(text).slice(-3).some((s) => s.trim().endsWith('?'))) return [];
  const rows = svc.store
    .all<any>("SELECT * FROM memory_items WHERE user_id = ? AND status = 'proposed' AND created_by_agent = ? AND origin_run_id = ? ORDER BY created_at LIMIT 10", userId, answer.author_id, answer.run_id)
    .map((r) => svc.store.decode<MemoryItemRow>('memory_items', r))
    .filter((r) => !(r.flags || []).some((f) => f === 'external' || f === 'tainted' || f === 'injection'))
    .filter((r) => text.includes(`[m:${r.ref}]`) || containment(tokens(svc.contentOf(r)), tokens(text, 400)) >= 0.6);
  return rows.length <= 3 ? rows : [];
}

/**
 * The owner's message says yes to a memory proposal of the bot: store or approve it and tell the bot (msg flags).
 * Returns true when the message was such a reply (then nothing else is captured from it).
 */
export function captureConfirmation(svc: MemoryService, m: Message, thread: Thread): boolean {
  if (!isOwnerMessage(m, thread) || !thread.agent_id || svc.audience(thread, thread.user_id) !== 'private') return false;
  if (!isConfirmation(m.content)) return false;
  const agent = svc.store.agent(thread.agent_id);
  if (!agent || agent.user_id !== thread.user_id) return false;
  const eff = svc.effective(agent);
  if (!eff.enabled) return false;
  const answer = previousAnswer(svc, m, thread);
  if (!answer) return false;
  const userId = thread.user_id;
  const proposal = proposalIn(answer.content);
  const pending = askedProposals(svc, answer, userId);
  if (!proposal && !pending.length) return false;
  if (eff.learn === 'off') {
    setMsgFlags(svc, m.id, userId, { outcomes: [{ action: 'off', message: 'Leren staat uit; er is niets opgeslagen. De gebruiker kan dit aanzetten in Geheugen › Opslag.' }] });
    return true;
  }
  const outcomes: { action: string; ref?: string; message: string }[] = [];
  const said = 'De gebruiker zei ja op je voorstel om dit te onthouden.';

  // 1. Proposals the bot already made with memory_remember: approved, with the reply as their source.
  const approved: MemoryItemRow[] = [];
  for (const p of pending) {
    try {
      const r = svc.store.tx(() => {
        const out = approveProposal(svc, userId, p.id);
        svc.patchItem(p.id, { source_kind: 'message', source_ref: m.id, source_thread_id: thread.id });
        return out;
      });
      approved.push(r.item);
      outcomes.push({ action: 'inserted', ref: r.item.ref, message: `${said} Opgeslagen [m:${r.item.ref}].` });
    } catch (e: any) {
      outcomes.push({ action: 'invalid', ref: p.ref, message: `${said} Niet opgeslagen [m:${p.ref}]: ${e.message}` });
    }
  }

  // 2. The fact the question named, in the owner's voice, as his own explicit wish.
  const run = answer.run_id ? svc.store.run(answer.run_id) : null;
  const tainted = !!run && runTainted(svc, run);
  let unsure = 0;
  (proposal?.clauses || []).forEach((cl, i) => {
    const content = ownerVoice(cl.text, cl.subordinate);
    if (!content) {
      unsure++;
      return;
    }
    if (approved.some((a) => containment(tokens(content), tokens(svc.contentOf(a))) >= 0.6)) return;
    let scope: Scope;
    let dossierId: string | null = null;
    if (wantsShared(proposal!.sentence)) scope = 'shared';
    else if ((dossierId = dossierMentioned(svc, userId, agent.id, content))) scope = 'dossier';
    else if (firstPerson(content) && !/^(we|wij|ons|onze)\b/i.test(content)) scope = 'about_you';
    else scope = 'agent';
    const out = writeCandidate(svc, {
      userId,
      content,
      scope,
      agentId: agent.id,
      dossierId,
      source: { kind: 'message', ref: m.id, threadId: thread.id, excerpt: `${clean(proposal!.sentence, 240)} — ${clean(m.content, 60)}`, trust: 'user' },
      origin: 'explicit',
      createdBy: 'user',
      idemKey: `y:${m.id}:${i}`,
      flags: tainted ? ['tainted'] : [],
      // A question written in a turn that read web pages, mails or files: the owner still reviews the exact text.
      forcePropose: tainted,
      proposalReason: tainted ? 'tainted' : undefined,
    });
    outcomes.push({ action: out.action, ref: out.item?.ref, message: `${said} ${out.message}` });
  });

  if (!outcomes.length) {
    const can = usableMemoryTools(svc, agent);
    const how = can.has('memory_remember') ? 'Sla het nu op met memory_remember (één kort feit)' : 'Zeg dat hij het zelf kan toevoegen in Geheugen & dossiers';
    outcomes.push({
      action: 'unclear',
      message: unsure
        ? `De gebruiker zei ja op je voorstel om iets te onthouden, maar TeamBot kon het feit niet zeker in zijn woorden zetten en heeft niets opgeslagen. ${how}.`
        : `De gebruiker zei ja op je vraag om iets te onthouden, maar die vraag noemde het feit niet. ${how}, of vraag kort wat je precies moet onthouden.`,
    });
  }
  setMsgFlags(svc, m.id, userId, { outcomes });
  return true;
}
