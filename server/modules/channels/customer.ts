/**
 * Customer mode ("Klantenservice") for channels where a bot talks to people outside the team. Everything here is
 * enforced in code, on the bot's finished draft, before anything leaves TeamBot (manager.customerReply):
 *
 *  - AI label: the first reply in a conversation (and again after a day of silence) says it is an AI assistant;
 *  - hand off: a draft that does not know, that defers, or that is not grounded in the owner's approved knowledge
 *    is not sent; the customer hears that a person will reply (with working hours), the owner gets the conversation,
 *    and the bot stays quiet in it until the owner replies or releases it;
 *  - never invent policy: every number, amount, time, address and link in the draft must come from the approved
 *    knowledge or the customer's own message, policy topics (prices, refunds, delivery, warranty, terms, hours) must
 *    be covered by that knowledge, and a substantive answer must cite a knowledge item ([K2]);
 *  - money and promises: a draft about prices, payments, refunds, discounts or promises waits in "Wacht op jou"
 *    until the owner approves (or edits) it.
 *
 * The prompt tells the bot the same rules, but the prompt is only a hint: this file decides.
 */
import { bad } from '../../core/http.js';

export interface WorkHours {
  enabled: boolean;
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
  from: string;
  to: string;
}

export interface CustomerConfig {
  enabled: boolean;
  /** Anyone may write in a private chat (no pairing code). Never on WhatsApp (QR): that is the owner's own number. */
  open: boolean;
  /** The bot says it is an AI. */
  aiLabel: boolean;
  /** Questions the bot cannot answer from approved knowledge go to the owner. */
  handoff: boolean;
  /** Money, prices, refunds, discounts and promises wait for the owner's approval. */
  approveMoney: boolean;
  hours: WorkHours;
  /** Approved knowledge: one fact, answer or rule per line. The only source the bot may answer from. */
  knowledge: string;
  /**
   * Also approved: the business profile of the channel's own team (Instellingen › Teams: company, what it does, tone,
   * rules), added after the channel's own lines (0.4, package B4). Never another team's profile. Off by default.
   */
  profile: boolean;
}

export const KNOWLEDGE_MAX = 20_000;
const DEFAULT_HOURS: WorkHours = { enabled: false, days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' };
export const CUSTOMER_DEFAULTS: CustomerConfig = { enabled: false, open: true, aiLabel: true, handoff: true, approveMoney: true, hours: DEFAULT_HOURS, knowledge: '', profile: false };

/** Adapters where strangers may not write to the bot, even in customer mode. */
const NO_OPEN_DOOR = new Set(['whatsapp-web']);

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const pad = (s: string) => {
  const m = String(s || '').trim().match(/^(\d{1,2})[:.](\d{2})$/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : String(s || '').trim();
};
const bool = (v: any, d: boolean) => (typeof v === 'boolean' ? v : d);

/** Read a stored customer config (never throws; unknown values fall back to the defaults). */
export function readCustomer(c: any, adapter: string): CustomerConfig {
  const src = c && typeof c === 'object' ? c : {};
  const h = src.hours && typeof src.hours === 'object' ? src.hours : {};
  const days = Array.isArray(h.days) ? [...new Set(h.days.map(Number).filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : DEFAULT_HOURS.days;
  const from = HHMM.test(pad(h.from)) ? pad(h.from) : DEFAULT_HOURS.from;
  const to = HHMM.test(pad(h.to)) ? pad(h.to) : DEFAULT_HOURS.to;
  return {
    enabled: bool(src.enabled, false),
    open: NO_OPEN_DOOR.has(adapter) ? false : bool(src.open, true),
    aiLabel: bool(src.aiLabel, true),
    handoff: bool(src.handoff, true),
    approveMoney: bool(src.approveMoney, true),
    hours: { enabled: bool(h.enabled, false), days: days as number[], from, to },
    knowledge: String(src.knowledge ?? '').replace(/\r\n/g, '\n').slice(0, KNOWLEDGE_MAX),
    profile: bool(src.profile, false),
  };
}

/** Validate the customer config from the API (Dutch errors). */
export function normalizeCustomer(input: any, prev: any, adapter: string): CustomerConfig {
  const p = prev && typeof prev === 'object' ? prev : {};
  const i = input && typeof input === 'object' ? input : {};
  const merged = { ...p, ...i, hours: { ...(p.hours || {}), ...(i.hours || {}) } };
  const h = merged.hours;
  if (h.enabled) {
    if (!HHMM.test(pad(h.from)) || !HHMM.test(pad(h.to))) throw bad('Vul de werktijden in als uu:mm, bijvoorbeeld 09:00 en 17:00.');
    if (pad(h.to) <= pad(h.from)) throw bad('De eindtijd van je werktijden moet na de begintijd liggen.');
    if (!Array.isArray(h.days) || !h.days.length) throw bad('Kies minstens één werkdag.');
  }
  if (String(merged.knowledge ?? '').length > KNOWLEDGE_MAX) throw bad(`De goedgekeurde kennis is te lang (maximaal ${KNOWLEDGE_MAX} tekens).`);
  return readCustomer(merged, adapter);
}

export const canOpenDoor = (adapter: string) => !NO_OPEN_DOOR.has(adapter);

// ---------------------------------------------------------------- approved knowledge

export interface KnowledgeItem {
  id: string;
  text: string;
}

/**
 * One item per non-empty line (list bullets removed), numbered K1, K2 … so the bot can cite them. `extra` (the team's
 * business profile, when the owner chose that) comes after the channel's own lines, so their numbers stay the same.
 */
export function knowledgeItems(text: string, extra: string[] = []): KnowledgeItem[] {
  return [
    ...String(text || '')
      .replace(/\r\n/g, '\n')
      .split('\n'),
    ...extra,
  ]
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
    .filter((l) => l.length > 1)
    .slice(0, 300)
    .map((t, i) => ({ id: `K${i + 1}`, text: t.slice(0, 1000) }));
}

/** The knowledge as the bot sees it in its instructions. */
export function knowledgePrompt(items: KnowledgeItem[]): string {
  return items.length ? items.map((k) => `[${k.id}] ${k.text}`).join('\n') : '(nog leeg: er is geen goedgekeurde kennis, dus zet elke inhoudelijke vraag door)';
}

// ---------------------------------------------------------------- facts (numbers, amounts, times, links)

export interface Fact {
  kind: 'money' | 'percent' | 'time' | 'duration' | 'number' | 'email' | 'url';
  /** Normalized value used to compare with the knowledge. */
  key: string;
  /** As it is written in the draft (for the owner). */
  display: string;
}

/** "1.899" → 1899, "499,00" → 499, "17.30" → 17.3, "2,5" → 2.5. */
export function numValue(raw: string): string {
  let s = String(raw).replace(/,-+$/, '').replace(/[.,]+$/, '');
  const dot = s.includes('.');
  const comma = s.includes(',');
  if (dot && comma) {
    const dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    s = s.split(dec === '.' ? ',' : '.').join('').replace(dec, '.');
  } else if (dot || comma) {
    const parts = s.split(dot ? '.' : ',');
    const thousands = parts.length > 2 || (parts.length === 2 && parts[1].length === 3 && parts[0].length <= 3 && parts[0] !== '0');
    s = thousands ? parts.join('') : parts.join('.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? String(n) : String(raw);
}

const CUR = '(?:€|eur\\b|euro\'?s?\\b|\\$|usd\\b|£|gbp\\b|dollar\\b)';
const NUM = '\\d+(?:[.,]\\d+)*(?:,-+)?';
const MONEY = new RegExp(`${CUR}\\s?(${NUM})|(${NUM})\\s?${CUR}`, 'gi');
const PERCENT = /(\d+(?:[.,]\d+)?)\s?(?:%|procent\b|percent\b)/gi;
const TIME = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/g;
const DURATION = /\b(\d+)\s?(werkdag(?:en)?|dag(?:en)?|weken|week|maand(?:en)?|jaren|jaar|uur|uren|minuten|minuut|days?|weeks?|months?|years?|hours?|minutes?)\b/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const URL_RE = /\bhttps?:\/\/[^\s)<>\]]+|\bwww\.[^\s)<>\]]+/gi;
const PLAIN_NUM = /\d+(?:[.,]\d+)*/g;

const normUrl = (u: string) =>
  u
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[.,;:!?'"]+$/, '')
    .replace(/\/+$/, '');

/** All checkable facts in a text, in order. Citations ([K2]) are not facts. */
export function factsOf(text: string): Fact[] {
  let s = stripCitations(String(text || ''));
  const out: Fact[] = [];
  const take = (re: RegExp, fn: (m: RegExpExecArray) => Fact | null) => {
    s = s.replace(re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpExecArray;
      const f = fn(m);
      if (f) out.push(f);
      return ' ';
    });
  };
  take(EMAIL, (m) => ({ kind: 'email', key: 'email:' + m[0].toLowerCase(), display: m[0] }));
  take(URL_RE, (m) => ({ kind: 'url', key: 'url:' + normUrl(m[0]), display: m[0].replace(/[.,;:!?]+$/, '') }));
  take(MONEY, (m) => ({ kind: 'money', key: numValue(m[1] || m[2]), display: m[0].trim() }));
  take(PERCENT, (m) => ({ kind: 'percent', key: numValue(m[1]), display: m[0].trim() }));
  take(TIME, (m) => ({ kind: 'time', key: `${Number(m[1])}:${m[2]}`, display: m[0] }));
  take(DURATION, (m) => ({ kind: 'duration', key: numValue(m[1]), display: m[0] }));
  take(PLAIN_NUM, (m) => {
    const key = numValue(m[0]);
    // A bare 0 or 1 ("1 vraag", "stap 1") is not a claim; with a unit it is (see DURATION, MONEY).
    return key === '0' || key === '1' ? null : { kind: 'number', key, display: m[0] };
  });
  return out;
}

/** Normalized values a text supports: every number in any form, times (also their hour), addresses and links. */
export function supportOf(text: string): Set<string> {
  const set = new Set<string>();
  for (const f of factsOf(text)) {
    set.add(f.key);
    if (f.kind === 'time') {
      const [h, mm] = f.key.split(':');
      if (mm === '00') set.add(h);
    }
  }
  // Numbers the fact parser filtered (0, 1) or folded into another fact still count as support.
  for (const m of String(text || '').matchAll(PLAIN_NUM)) set.add(numValue(m[0]));
  return set;
}

// ---------------------------------------------------------------- topics

export type Topic = 'price' | 'discount' | 'refund' | 'warranty' | 'delivery' | 'hours' | 'terms' | 'promise';

export const TOPICS: Record<Topic, RegExp> = {
  price:
    /€|\$|£|\b(prijs|prijzen|prijslijst|kost|kosten|kostte|tarie(f|ven)|euro'?s?|bedrag(en)?|betal\w*|offerte\w*|factu(u|r)\w*|btw|goedkoop|abonnement\w*|price[sd]?|pricing|costs?|pay\w*|fees?|invoice\w*|quote\w*)\b/i,
  discount: /\b(korting\w*|aanbieding\w*|actieprijs|coupon\w*|voucher\w*|cadeaubon\w*|tegoedbon\w*|gratis|discount\w*|promo\w*|free of charge)\b/i,
  refund:
    /\b(terugbetal\w*|geld terug|restitu\w*|retour\w*|terugsturen|terug ?brengen|ruil\w*|omruil\w*|annule\w*|opzeg\w*|herroep\w*|vergoed\w*|compensa\w*|schadevergoeding|refund\w*|returns?|returning|exchange\w*|cancel\w*|reimburs\w*|chargeback)\b/i,
  warranty: /\b(garantie\w*|waarborg|reparat\w*|repareren|defect\w*|warrant\w*|repair\w*)\b/i,
  delivery: /\b(lever\w*|bezorg\w*|verzend\w*|verzonden|verstuurd|pakket\w*|bestelling\w*|besteld|track ?(&|en|and) ?trace|shipping|shipped|ship|deliver\w*|dispatch\w*|orders?)\b/i,
  hours: /\b(openingstijd\w*|openingsuren|geopend|gesloten|open op|open tot|open van|bereikbaar|opening hours|closed|we are open)\b/i,
  terms: /\b(voorwaarden|beleid|policy|policies|terms|privacy|aansprakelijk\w*|contract\w*|reglement)\b/i,
  promise:
    /\b(beloof\w*|beloften?|garandeer\w*|verzeker\w*|zorg(en)? ervoor|zorgen dat|regel ik|komt (helemaal )?goed|krijg(t|en)? (je|u) (het|uw|je|een|binnen)|ontvang(t|en) (je|u)|(we|wij) (sturen|storten|betalen|vergoeden|regelen|zorgen)|uiterlijk (morgen|vandaag|\w+dag)|i promise|we promise|we guarantee|we will (send|refund|pay|replace)|you will (get|receive))\b/i,
};

/** Topics that need the owner's approval before a reply goes out. */
const MONEY_TOPICS: Topic[] = ['price', 'discount', 'refund', 'promise'];
/** Policy topics the approved knowledge must cover before the bot may answer about them. */
const POLICY_TOPICS: Topic[] = ['price', 'discount', 'refund', 'warranty', 'delivery', 'hours', 'terms'];

const TOPIC_LABEL: Record<Topic, string> = {
  price: 'prijzen of betalen',
  discount: 'kortingen of acties',
  refund: 'terugbetalen, retour of annuleren',
  warranty: 'garantie of reparatie',
  delivery: 'levering of verzending',
  hours: 'openingstijden',
  terms: 'voorwaarden of beleid',
  promise: 'een belofte',
};

export function topicsOf(text: string): Topic[] {
  const t = stripCitations(String(text || ''));
  return (Object.keys(TOPICS) as Topic[]).filter((k) => TOPICS[k].test(t));
}

// ---------------------------------------------------------------- citations, doubt, small talk, asking for a human

// K = approved knowledge, C = what TeamBot knows about this customer (0.4.5, memory per customer).
const CITE = /\s*[[(]\s*[KC]\d{1,3}(?:\s*[,;/&]\s*[KC]?\d{1,3})*\s*[\])]/gi;

/** Knowledge and customer-fact ids the draft cites ([K2], [K1, K3], (K4), [C1], [K2, C3]). */
export function citationsOf(text: string): string[] {
  const out = new Set<string>();
  for (const m of String(text || '').matchAll(CITE)) {
    let letter = 'K';
    for (const n of m[0].matchAll(/([KC])?\s*(\d{1,3})/gi)) {
      if (n[1]) letter = n[1].toUpperCase();
      out.add(`${letter}${Number(n[2])}`);
    }
  }
  return [...out];
}

export function stripCitations(text: string): string {
  return String(text || '')
    .replace(CITE, '')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** The bot's own way of saying "a person must answer this". */
const MARKER = /\[\s*(doorzetten|handoff|hand-off|mens|human)\s*\]/i;
const UNSURE =
  /\b(weet ik (het |dat )?niet|ik weet (het |dat )?niet|(weet|ben) (ik )?(het |dat )?niet zeker|niet zeker (weten|of)|geen idee|kan ik (je |u )?(dat |het )?niet (zeggen|vertellen|beantwoorden|bevestigen)|kan ik (je |u )?geen antwoord|geen antwoord op geven|heb ik geen (informatie|gegevens)|(ik )?heb geen (informatie|gegevens) (over|hierover|daarover)|geen informatie (over|hierover|daarover)|staat (dat |dit |het )?niet in|kan ik niet (vinden|terugvinden|opzoeken)|ik heb (daar|hier) geen (zicht|informatie)|i (do not|don't|dont) know|i'm not sure|i am not sure|not sure (if|whether)|no information|i (can't|cannot|can not) (say|tell|confirm|answer))\b/i;
const DEFER =
  /\b(zet (je|uw) vraag door|doorzetten naar|doorgezet|een (collega|medewerker|mens) (neemt|komt|helpt|belt|reageert)|neem(t|en)? (zo snel mogelijk )?contact (met (je|u) )?op|i('ll| will) (forward|pass)|a (colleague|human|person) will)\b/i;
const GREETING =
  /^(hallo|hoi|hey|hi|hee|goedemorgen|goedemiddag|goedenavond|goedendag|dag|welkom|graag gedaan|geen dank|bedankt|dank (je|u)( wel)?|fijne dag|prettige dag|tot ziens|doei|hello|hi there|thanks|thank you|you'?re welcome|bye|good (morning|afternoon|evening))\b/i;

/** Every sentence is a greeting, thanks or a question back ("Wat is je ordernummer?"). */
export function isSmallTalk(text: string): boolean {
  const t = stripCitations(text);
  if (!t || t.length > 300) return false;
  const sentences = t.match(/[^.!?\n]+[.!?]*/g) || [];
  return sentences.every((s) => {
    const x = s.trim();
    return !x || GREETING.test(x) || x.endsWith('?') || /^[\p{Extended_Pictographic}\s]+$/u.test(x);
  });
}

const HUMAN = [
  /\b(wil|graag|kan ik|mag ik|liever|i want|i'd like|can i|could i|let me)\b.{0,30}\b(een )?(mens|medewerker|human|person|agent|representative)\b/i,
  /\b(iemand|een mens|een medewerker|een persoon|someone|somebody|a person)\b.{0,20}\b(spreken|praten|bellen|aan de lijn|speak|talk)\b/i,
  /^\s*(mens|medewerker|human|agent)\s*[.!?]*\s*$/i,
  /\b(echt(e)? (mens|persoon)|real person|speak to (a|someone|somebody)|talk to (a|someone|somebody))\b/i,
];

/** The customer asks for a person. */
export const humanRequested = (text: string) => {
  const t = String(text || '').slice(0, 1000).replace(/[’‘]/g, "'");
  return HUMAN.some((re) => re.test(t));
};

/** Short and common words that say nothing about the subject. */
const STOP = new Set(
  'deze dit dat die een het de van voor met maar ook niet wel zijn wordt worden kan kunnen kunt mag moet moeten hebben heeft jullie onze jouw jou mijn ons hier daar graag alleen binnen tussen over onder naar door bij tot omdat want als dan wij jij hij zij hun haar krijg krijgt krijgen word zeker gewoon even altijd nooit heel veel meer minder andere ander eigen nog weer this that with have from will would there their what when where your yours they them been were also only very just about into than then'.split(
    ' ',
  ),
);

/** Do two texts share a word that is about the subject? (first five letters, so "fiets" matches "fietsen") */
export function sharesWords(a: string, b: string): boolean {
  const words = (s: string) => new Set((stripCitations(s).toLowerCase().match(/\p{L}{4,}/gu) || []).filter((w) => !STOP.has(w)).map((w) => w.slice(0, 5)));
  const wb = words(b);
  for (const w of words(a)) if (wb.has(w)) return true;
  return false;
}

// ---------------------------------------------------------------- the verdict on a draft

export interface DraftVerdict {
  action: 'send' | 'hold' | 'handoff';
  /** What would be sent: the draft without citations. */
  text: string;
  /** Plain Dutch, for the owner. */
  reasons: string[];
  topics: Topic[];
  cited: string[];
}

/**
 * Decide what happens to a bot's draft reply to a customer. `question` is the customer's message(s) the draft
 * answers (their own numbers and words support the answer too). `customer` (0.4.5): what TeamBot remembers about
 * this customer (C1 …). Those facts may back a number or a citation and share words with the answer, but they never
 * cover policy: price, discount, refund, warranty, delivery, hours and terms still need the approved knowledge, and
 * money and promises still wait for the owner.
 */
export function classifyDraft(o: { draft: string; question: string; knowledge: KnowledgeItem[]; customer?: KnowledgeItem[] }): DraftVerdict {
  const raw = String(o.draft || '')
    .replace(/[’‘]/g, "'")
    .trim();
  const customer = (o.customer || []).filter((c) => /^C\d{1,3}$/.test(c.id));
  const sources = [...o.knowledge, ...customer];
  const ids = new Set(sources.map((k) => k.id));
  const cited = citationsOf(raw).filter((c) => ids.has(c));
  const text = stripCitations(raw);
  const v = (action: DraftVerdict['action'], reasons: string[], topics: Topic[] = []): DraftVerdict => ({ action, text, reasons, topics, cited });
  if (!text) return v('handoff', ['De bot had geen antwoord']);
  if (MARKER.test(raw)) return v('handoff', ['De bot weet het antwoord niet']);
  if (UNSURE.test(text)) return v('handoff', ['De bot weet het antwoord niet zeker']);
  if (DEFER.test(text)) return v('handoff', ['De bot wil de vraag doorzetten']);

  // Policy coverage: approved knowledge only. Support for numbers, links and words: the customer's facts as well.
  const kText = o.knowledge.map((k) => k.text).join('\n');
  const all = `${kText}\n${customer.map((c) => c.text).join('\n')}\n${o.question}`;
  const facts = factsOf(text);
  // Only greetings, thanks and questions back: no claims, so no source needed (its numbers must still be known).
  const small = isSmallTalk(text);
  const topics = [...new Set([...topicsOf(text), ...(small ? [] : topicsOf(o.question))])];

  const support = supportOf(all);
  const kLower = all.toLowerCase();
  const urls = new Set(factsOf(all).filter((f) => f.kind === 'url' || f.kind === 'email').map((f) => f.key));
  const missing = facts.filter((f) => (f.kind === 'url' || f.kind === 'email' ? !urls.has(f.key) && !kLower.includes(f.display.toLowerCase()) : !support.has(f.key)));
  if (missing.length) {
    const list = [...new Set(missing.map((f) => f.display))].slice(0, 3).join(', ');
    return v('handoff', [`Noemt iets wat niet in je goedgekeurde kennis staat: ${list}`], topics);
  }
  const uncovered = small ? [] : topics.filter((t) => POLICY_TOPICS.includes(t) && !TOPICS[t].test(kText));
  if (uncovered.length) return v('handoff', [`Gaat over ${TOPIC_LABEL[uncovered[0]]}; daar staat niets over in je goedgekeurde kennis`], topics);
  if (!small && !cited.length) return v('handoff', ['Het antwoord noemt geen bron uit je goedgekeurde kennis'], topics);
  // A source must be about what the answer says: at least one word in common (an opening-hours line does not
  // support "your order has been noted").
  if (!small && !sharesWords(text, sources.filter((k) => cited.includes(k.id)).map((k) => k.text).join(' ')))
    return v('handoff', ['De genoemde bron uit je kennis past niet bij het antwoord'], topics);

  const reasons: string[] = [];
  const money = facts.filter((f) => f.kind === 'money');
  if (money.length) reasons.push(`Noemt een bedrag: ${money.map((f) => f.display).slice(0, 3).join(', ')}`);
  for (const t of topics) if (MONEY_TOPICS.includes(t) && !(t === 'price' && money.length)) reasons.push(t === 'promise' ? 'Bevat een belofte' : `Gaat over ${TOPIC_LABEL[t]}`);
  if (reasons.length) return v('hold', reasons, topics);
  return v('send', [], topics);
}

// ---------------------------------------------------------------- working hours

const MON_FIRST = [1, 2, 3, 4, 5, 6, 0];

function dayName(d: number, locale: string, style: 'short' | 'long') {
  // 7 January 2024 was a Sunday.
  return new Intl.DateTimeFormat(locale, { weekday: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 7 + d)));
}

/** "ma–vr 09:00–17:00", "ma, wo, vr 09:00–12:00" in the given locale. */
export function hoursSummary(h: WorkHours, locale: string): string {
  const days = MON_FIRST.filter((d) => h.days.includes(d));
  const runs: number[][] = [];
  for (const d of days) {
    const last = runs.at(-1);
    if (last && MON_FIRST.indexOf(last.at(-1)!) + 1 === MON_FIRST.indexOf(d)) last.push(d);
    else runs.push([d]);
  }
  const part = runs.map((r) => (r.length >= 3 ? `${dayName(r[0], locale, 'short')}–${dayName(r.at(-1)!, locale, 'short')}` : r.map((d) => dayName(d, locale, 'short')).join(', '))).join(', ');
  return `${part} ${h.from}–${h.to}`;
}

/** Weekday (0 = Sunday) and minutes since midnight of a moment in a time zone. */
function localParts(at: Date, tz: string): { day: number; minutes: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { day: day < 0 ? 0 : day, minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')) };
}

const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function isOpen(h: WorkHours, at: Date, tz: string): boolean {
  if (!h.enabled) return true;
  const p = localParts(at, tz);
  return h.days.includes(p.day) && p.minutes >= mins(h.from) && p.minutes < mins(h.to);
}

/** When the next working period starts ("maandag 09:00"), or null when there is none. */
export function nextOpening(h: WorkHours, at: Date, tz: string, locale: string): string | null {
  if (!h.enabled || !h.days.length) return null;
  const p = localParts(at, tz);
  for (let i = 0; i < 8; i++) {
    const d = (p.day + i) % 7;
    if (!h.days.includes(d)) continue;
    if (i === 0 && p.minutes >= mins(h.from)) continue;
    return `${dayName(d, locale, 'long')} ${h.from}`;
  }
  return null;
}

// ---------------------------------------------------------------- texts the customer reads (Dutch source; the
// manager translates them with trUser into the owner's interface language)

export const TEXT = {
  aiLabelHandoff: 'Je praat met een AI-assistent. Wil je liever een mens? Zeg het gerust.',
  aiLabel: 'Je praat met een AI-assistent.',
  handoffPlain: 'Ik heb je vraag doorgezet naar een medewerker. Je krijgt zo snel mogelijk antwoord.',
  handoffOpen: 'Ik heb je vraag doorgezet naar een medewerker. Je krijgt zo snel mogelijk antwoord, binnen onze werktijden ({0}).',
  handoffClosed: 'Ik heb je vraag doorgezet naar een medewerker. We zijn nu gesloten; je krijgt antwoord vanaf {0}.',
  noAnswer: 'Daar kan ik je helaas geen antwoord op geven.',
};

/** How long an AI label stays "said" in a conversation before the next reply repeats it. */
export const AI_LABEL_EVERY_MS = 24 * 3600_000;
