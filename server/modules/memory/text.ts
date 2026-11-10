/**
 * Text utilities for the memory module: normalisation, tokenising, similarity, secret/sensitivity/instruction
 * detection and the high-precision heuristics used for explicit intents and automatic proposals (Dutch + English).
 * Everything here is deterministic and dependency-free so it is cheap to run on every message.
 */
import type { ItemType, Sensitivity } from './types.js';

export const MAX_CONTENT = 2000;

export function clean(s: string, max = MAX_CONTENT): string {
  let t = String(s ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (t.length > max) t = t.slice(0, max - 1).trimEnd() + '…';
  return t;
}

export function stripDiacritics(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}+/gu, '');
}

/** Lowercase, no diacritics, punctuation to spaces, single spaces. Used for hashing and exact dedup. */
export function normalize(s: string): string {
  return stripDiacritics(String(s ?? '').toLowerCase())
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP = new Set(
  (
    'de het een en of maar dat dit die deze daar hier er is zijn ben bent was waren wordt worden werd heb hebt heeft hebben had ' +
    'ik je jij u hij zij ze we wij jullie mij me mijn m jouw jou uw zijn haar hun ons onze men het hem hen ' +
    'van in op aan met voor naar bij om tot uit over door als dan ook nog wel niet geen al wat wie waar hoe waarom welke ' +
    'te zo zou zal zullen kan kun kunt kunnen moet moeten mag mogen wil wilt willen gaat gaan ga even graag heel erg veel meer ' +
    'onthoud onthouden noteer sla op vergeet alsjeblieft aub svp dus toch want omdat nu straks altijd nooit ' +
    'the a an and or but that this these those there here is are was were be been being have has had do does did ' +
    'i you he she it we they me my mine your yours his her its our their them us of in on at to for from with by about as ' +
    'than then also not no yes what who where how why which so would will shall can could must may might please remember note'
  ).split(/\s+/),
);

/** A word that carries no meaning of its own ("de", "mijn", "the"); expects a normalized word. */
export function isStopWord(w: string): boolean {
  return STOP.has(w);
}

/** Very light suffix stripping so Dutch/English inflections collapse (woon/woont/woonde, live/lives). */
export function stem(w: string): string {
  if (w.length <= 3 || /\d/.test(w)) return w;
  for (const suf of ['ingen', 'heden', 'ing', 'en', 'de', 'te', 'es', 's', 't', 'e', 'd']) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) return w.slice(0, -suf.length);
  }
  return w;
}

/** Significant, stemmed, de-duplicated tokens of a text. */
export function tokens(s: string, max = 64): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of normalize(s).split(' ')) {
    if (!w || STOP.has(w)) continue;
    if (w.length < 3 && !/\d/.test(w)) continue;
    const t = stem(w);
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

export function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const A = new Set(a);
  let inter = 0;
  for (const x of new Set(b)) if (A.has(x)) inter++;
  return inter / (A.size + new Set(b).size - inter);
}

/** Share of `small` that is contained in `big`. */
export function containment(small: string[], big: string[]): number {
  if (!small.length) return 0;
  const B = new Set(big);
  let inter = 0;
  for (const x of new Set(small)) if (B.has(x)) inter++;
  return inter / new Set(small).size;
}

/** FTS5 query: OR of prefix terms. Returns '' when nothing searchable remains. */
export function ftsQuery(text: string, max = 12): string {
  const words: string[] = [];
  const seen = new Set<string>();
  for (const w of normalize(text).split(' ')) {
    if (!w || STOP.has(w) || (w.length < 3 && !/\d/.test(w))) continue;
    const t = stem(w);
    if (t.length < 2 || seen.has(t)) continue;
    seen.add(t);
    words.push('"' + t.replace(/"/g, '""') + '"*');
    if (words.length >= max) break;
  }
  return words.join(' OR ');
}


export function excerpt(s: string, n = 280): string {
  const t = clean(s, 100_000).replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

export function canonicalKey(s: string | null | undefined): string | null {
  if (!s) return null;
  const k = normalize(s).split(' ').filter((w) => w && !STOP.has(w)).map(stem).join(' ').slice(0, 80);
  return k || null;
}

// ---------------------------------------------------------------- secrets

const SECRET_RES: [RegExp, string][] = [
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_\-]{16,}/, 'API-sleutel'],
  [/\bAIza[0-9A-Za-z_\-]{30,}/, 'API-sleutel'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub-token'],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/, 'GitHub-token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'Slack-token'],
  [/\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/, 'bot-token'],
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, 'token'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, 'AWS-sleutel'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'privésleutel'],
  [/\b(?:wachtwoord|password|passwd|pwd|wachtwoordzin|passphrase|pincode|pin-code|pin|api[\s_-]?key|apikey|api[\s_-]?sleutel|secret|token|toegangscode|inlogcode|2fa|otp|herstelcode|recovery code)\b\s*(?:is|=|:|was|luidt)\s*\S{3,}/i, 'wachtwoord of code'],
  [/\b(?:mijn|my)\s+(?:wachtwoord|password|pincode|pin)\b/i, 'wachtwoord of code'],
  [/\b(?:Bearer)\s+[A-Za-z0-9._\-]{20,}/, 'token'],
];

function luhn(num: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let n = Number(num[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function elfProef(bsn: string): boolean {
  if (!/^\d{9}$/.test(bsn)) return false;
  let s = 0;
  for (let i = 0; i < 8; i++) s += Number(bsn[i]) * (9 - i);
  s -= Number(bsn[8]);
  return s % 11 === 0 && bsn !== '000000000';
}

/** Returns a label when the text contains something that must never be stored in memory. */
export function detectSecret(s: string): string | null {
  const t = String(s || '');
  for (const [re, label] of SECRET_RES) if (re.test(t)) return label;
  for (const m of t.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return 'betaalkaartnummer';
  }
  if (/\b(?:bsn|burgerservicenummer|sofinummer)\b/i.test(t)) return 'burgerservicenummer';
  for (const m of t.matchAll(/\b\d{9}\b/g)) if (elfProef(m[0]) && /\b(bsn|burgerservice|sofi)/i.test(t)) return 'burgerservicenummer';
  return null;
}

// ---------------------------------------------------------------- sensitivity

const SENSITIVE_RE =
  /\b(ziek\w*|ziekte|diagnose\w*|medicijn\w*|medicatie|therapie|therapeut|psycholoog|psychiater|depressie\w*|angststoorni\w*|burn-?out|adhd|autisme|kanker|diabetes|hiv|zwanger\w*|abortus|operatie|ziekenhuis|handicap|beperking|verslav\w*|religie|geloof|moslim|christen\w*|joods|politiek\w*|partij(lid)?|vakbond|seksu\w*|homo\w*|lesbi\w*|transgender|biseksu\w*|strafblad|veroordeel\w*|schuld(en)?|faillis\w*|salaris|inkomen|hypotheek|iban|rekeningnummer|paspoort\w*|rijbewijsnummer|health|illness|medication|diagnos\w*|pregnan\w*|religion|religious|political|sexual\w*|criminal record|salary|income|debt|passport)\b/i;
const PERSONAL_RE =
  /(\b(woon\w*|adres|telefoon\w*|mobiel\w*|06[- ]?\d{8}|geboren|verjaardag|jarig|leeftijd|jaar oud|vrouw|man|partner|vriend(in)?|kind(eren)?|zoon|dochter|moeder|vader|ouders|broer|zus|familie|huisdier|hond|kat|e-?mail\w*|live in|my wife|my husband|my son|my daughter|birthday|phone|address)\b|[\w.+-]+@[\w-]+\.[\w.]+|\+\d{2}[\s-]?\d{6,})/i;

export function detectSensitivity(s: string): Sensitivity {
  if (SENSITIVE_RE.test(s)) return 'sensitive';
  if (PERSONAL_RE.test(s)) return 'personal';
  return 'normal';
}

export const sensRank: Record<Sensitivity, number> = { normal: 0, personal: 1, sensitive: 2 };
export function maxSensitivity(a: Sensitivity | undefined | null, b: Sensitivity | undefined | null): Sensitivity {
  const x = a && sensRank[a] !== undefined ? a : 'normal';
  const y = b && sensRank[b] !== undefined ? b : 'normal';
  return sensRank[x] >= sensRank[y] ? x : y;
}

// ---------------------------------------------------------------- instruction-likeness (poisoning guard)

const INJECTION_RE =
  /(\b(negeer|ignore|disregard|override|omzeil)\b.{0,40}\b(instructie\w*|regels|instructions|rules|prompt|beperkingen)\b|\bsystem ?prompt\b|\bje bent nu\b|\byou are now\b|\b(stuur|forward|send|mail|e-?mail|doorsturen|transfer|maak .{0,20}over|betaal|pay|upload|exfiltrat\w*)\b.{0,60}\b(naar|to)\b.{0,40}(@|https?:\/\/|\biban\b|\brekening)|\b(voer|run|execute)\b.{0,30}\b(uit|command|commando|script|code)\b|\bcurl\s|\bwget\s|\bpowershell\b|\brm -rf\b|\b(wachtwoord|password|credentials?|api[- ]?key)s?\b.{0,40}\b(geven|delen|sturen|share|send|reveal)\b)/i;
const DIRECTIVE_RE = /^\s*(voortaan|vanaf nu|in het vervolg|altijd|nooit|from now on|always|never|you must|je moet|jij moet|zorg dat|antwoord (altijd|voortaan|in het)|reply (always|in))\b/i;

/** Content that reads like an instruction to an agent (rather than a fact). */
export function isInstructionLike(s: string): boolean {
  return INJECTION_RE.test(s) || DIRECTIVE_RE.test(s);
}

/** Instructions that would be harmful if obeyed (exfiltration, override, command execution). */
export function isInjectionLike(s: string): boolean {
  return INJECTION_RE.test(s);
}

export function firstPerson(s: string): boolean {
  return /\b(ik|mijn|mij|me|m'n|ikzelf|i|my|mine|i'm|i am|myself)\b/i.test(s);
}

/**
 * The owner says that something CHANGED or was wrong ("ik woon niet meer in …", "mijn kat heet nu Max", "correctie:",
 * "sinds deze maand werk ik …", "we stappen over van … naar …"). Such an explicit correction may replace the old
 * memory directly (with undo); without it a contradiction goes to the review queue first (settings.conflicts).
 */
const CORRECTION_RE = /\b(niet meer|niet langer|geen\s+\S+(?:\s+\S+)?\s+meer|tegenwoordig|inmiddels|sinds\s+(?:kort|deze|dit|vorige|vorig|vandaag|gisteren)|voortaan|vanaf nu|vanaf vandaag|correctie|verbetering|ik bedoel|eigenlijk|klopt niet|was fout|verkeerd|verhuisd|verhuis|stap(?:pen)? over|overgestapt|overstappen|veranderd|gewijzigd|vroeger|voorheen|in plaats van|anymore|no longer|actually|correction|moved to|switched to)\b|\b(?:ik|we|wij|hij|zij|ze|is|ben|zijn|heet|heten|woon|woont|wonen|werk|werkt|werken|heb|heeft|hebben|drink|drinkt|gebruik|gebruikt|rijd|rijdt|zit|zitten|sta|staat|doe|doet)\s+nu\b|\bnow\s+(?:live|work|use|drink|is|am|are)\b/i;
export function isCorrection(...texts: (string | null | undefined)[]): boolean {
  return texts.some((t) => !!t && CORRECTION_RE.test(ownWords(String(t))));
}

const SHARE_ALL_RE = /\b(voor (alle|iedere|elke) bots?|voor het hele team|voor iedereen|alle bots|gedeeld geheugen|for all bots|for everyone|voor alle teams|in alle teams|voor elk team|for all teams|for every team)\b/i;
export function wantsShared(s: string): boolean {
  return SHARE_ALL_RE.test(s);
}
/** "Onthoud voor alle teams dat …": shared knowledge for every team (the owner's explicit choice, in his own words). */
const ALL_TEAMS_RE = /\b(voor alle teams|in alle teams|voor elk team|for all teams|for every team)\b/i;
export function wantsAllTeams(s: string): boolean {
  return ALL_TEAMS_RE.test(s);
}

// ---------------------------------------------------------------- message preparation

/** Remove quoted lines, code blocks and forwarded content: that is data, never an instruction from the user. */
export function ownWords(content: string): string {
  const c = String(content || '');
  if (/^\s*(doorgestuurd van|forwarded from|---------- forwarded)/i.test(c)) return '';
  return c
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[a-z_]+[^>]*>[\s\S]*?<\/[a-z_]+>/gi, ' ')
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n')
    .replace(/"[^"\n]{40,}"|“[^”\n]{40,}”|„[^”\n]{40,}”/g, ' ')
    .trim();
}

export function sentences(s: string): string[] {
  return s
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------- explicit intents

const REMEMBER_RE =
  /(?:^|[.!?]\s+|\b(?:kun je|kan je|wil je|zou je|graag|alsjeblieft|please|could you|can you)\s+)(?:onthoud|onthou|onthouden|noteer|sla (?:even )?op|leg (?:even )?vast|vergeet niet|remember|note|keep in mind|don't forget)\b\s*(?:even\s+|goed\s+|alsjeblieft\s+|please\s+)?([:,-]\s*|dat\s+|that\s+)?(.+)$/i;
/** "voor al mijn bots (gedeeld geheugen):", "alleen voor jezelf, niet voor mijn andere bots:" in front of the fact. */
const AUDIENCE_RE = /^(?:alleen\s+|wel\s+|ook\s+)?voor\s+(?:jezelf|jou|al(?:le)?\s+(?:mijn\s+|onze\s+)?bots|al(?:le)?\s+(?:mijn\s+|onze\s+)?teams|elk\s+team|iedereen|het\s+(?:hele\s+)?team|de\s+(?:hele\s+)?groep)\b(?:[^:.!?]{0,80}:\s*|\s+(?=dat\s))/i;
const NO_REMEMBER_RE =
  /\b(niet onthouden|onthoud (dit|dat|het) niet|alleen (in|voor|tijdens) (dit|deze|het) (gesprek|chat)|(in|voor) dit gesprek alleen|just (in|for) this (chat|conversation)|only (in|for) this (chat|conversation)|niet opslaan|sla (dit|dat|het) niet op|hoef je niet te onthouden|vergeet (dit|dat|het) (maar|meteen|direct|weer)\b|vergeet (dit|dat|het)\s*[.!]?$|don'?t (remember|store|save) (this|that|it)|do not (remember|store|save)|off the record|niet voor je geheugen)/i;
const FORGET_RE =
  /\b(vergeet|wis|verwijder)\b(?! niet)\s+(?:(?:maar|alsjeblieft|even)\s+)?(dat|wat|alles|mijn|het feit|uit je geheugen)\b|\buit je geheugen\b|\bforget (that|what|about|everything|my)\b/i;

export interface ExplicitIntent {
  kind: 'remember' | 'no_remember' | 'forget' | null;
  content?: string;
}

/** Detect "onthoud dat ..." / "niet onthouden" / "vergeet ..." in the user's own words (quotes/code/forwards ignored). */
export function explicitIntent(raw: string): ExplicitIntent {
  const own = ownWords(raw);
  if (!own) return { kind: null };
  if (NO_REMEMBER_RE.test(own)) return { kind: 'no_remember' };
  if (FORGET_RE.test(own)) return { kind: 'forget' };
  for (const line of own.split(/\n+/)) {
    const m = line.trim().match(REMEMBER_RE);
    if (!m) continue;
    // Who it is for and "ook" are not part of the fact: "Onthoud ook dat …", "Onthoud voor al mijn bots: …",
    // "Onthoud alleen voor jezelf, niet voor mijn andere bots: …".
    let body = m[2];
    let dat = /dat/i.test(m[1] || '');
    const aud = body.match(AUDIENCE_RE);
    if (aud) body = body.slice(aud[0].length);
    const lead = body.match(/^(?:ook|nog)\s+(dat\s+)?/i) || (aud ? body.match(/^(dat\s+)/i) : null);
    if (lead) {
      body = body.slice(lead[0].length);
      if (lead[1]) dat = true;
    }
    // Only the fact itself: stop at the end of its sentence or where a new instruction starts
    // ("Onthoud dat X. Zoek daarna …", "onthoud dat X en zoek dan …").
    const rest = firstClause(body);
    // "Onthoud dat maar", "onthoud het dan": what to remember is elsewhere (the reply or the bot's question).
    if (/^(?:(?:dit|dat|this|that|het|maar|dan|even|wel|graag|alsjeblieft)\s*)+[.!]?$/i.test(rest) || rest.length < 3) return { kind: 'remember', content: '' };
    return { kind: 'remember', content: tidyClause(rest, dat) };
  }
  return { kind: null };
}

const FINITE = new Set(
  (
    'ben is zijn was waren heb heeft hebben had woon woont wonen werk werkt werken heet heten hou houd houdt houden wil wilt willen ' +
    'moet moeten kan kun kunt kunnen mag mogen ga gaat gaan kom komt komen drink drinkt eet eten begint beginnen eindigt eindigen ' +
    'studeer studeert speel speelt rijd rijdt gebruik gebruikt spreek spreekt vind vindt lees leest sta staat staan ligt liggen ' +
    'wordt word worden krijg krijgt zit zitten sport sporten train traint werkte woonde verhuis verhuist ken kent kennen ' +
    'heette zat stond lag noem noemt noemen gebruiken haat haten volg volgt plan plant'
  ).split(' '),
);
const ART = new Set('de het een mijn onze ons zijn haar hun jouw uw dit deze die dat'.split(' '));
const PRON = new Set('ik jij je u hij zij ze we wij jullie men het'.split(' '));

/** Words that start a new instruction after the fact to remember. */
const NEXT_STEP = /\s*(?:[,;]\s*|\s)(?:en\s+)?(?:daarna|vervolgens|daarnaast|dan|en dan|and then|then|after that|next)\b.*$|\s+en\s+(?:zoek|maak|stuur|schrijf|kijk|geef|vertel|zeg|controleer|check|bel|plan|lees|open|antwoord)\b.*$|\s+and\s+(?:search|look|make|send|write|tell|check|find|open|answer)\b.*$/i;

/** The first sentence of what follows "onthoud dat", without a follow-up instruction. */
export function firstClause(s: string): string {
  let c = s.trim().split(/(?<=[.!?])\s+/)[0] || '';
  c = c.replace(NEXT_STEP, '');
  return c.replace(/\s*[?]+$/, '').trim();
}

/** At the end of a "dat …" clause the last word is the verb: a known one, or a present-tense form on -t ("levert"). */
export const isFiniteVerb = (w: string) => FINITE.has(w) || /^[a-zà-ÿ]{3,}t$/.test(w);
const endsFinite = (part: string) => {
  const w = part.split(' ');
  const last = w[w.length - 1];
  return /^[a-zà-ÿ]+$/.test(last) && isFiniteVerb(last) && !FINITE.has((w[w.length - 2] || '').toLowerCase());
};

const NAMING = new Set(['heet', 'heten', 'heette', 'noem', 'noemt', 'noemen']);
const NAME_PARTICLE = new Set(['van', 'de', 'den', 'der', 'ter', 'ten', 'te', "'t"]);

/** Length of the subject at the start of a subordinate clause (0 = none): "ik", "mijn favoriete kleur", "Anna". */
function subjectLength(w: string[], verb: string): number {
  const first = w[0].toLowerCase();
  const end = w.length - 1; // the verb itself is never part of the subject
  // "het" before a noun is an article ("het wachtwoord …"), otherwise a pronoun ("het regent").
  if (PRON.has(first) && !(first === 'het' && w.length >= 4)) return 1;
  if (ART.has(first)) {
    // article + adjectives (-e, followed by a lower-case word) + noun: "mijn favoriete kleur", "de oude auto"
    let subj = 1;
    while (subj < end - 1 && /e$/i.test(w[subj]) && /^[a-zà-ÿ]/.test(w[subj + 1] || '')) subj++;
    subj++;
    // "van de wifi" belongs to the noun: "het wachtwoord van de wifi"
    if (w[subj]?.toLowerCase() === 'van' && subj + 2 < end && ART.has(w[subj + 1].toLowerCase())) subj += 3;
    // a name right after the noun is part of the subject ("mijn klant Jan"), except with naming verbs
    // ("de leverancier Van den Ban heet" → the name is what he is called).
    if (!NAMING.has(verb) && /^\p{Lu}/u.test(w[subj] || '')) {
      subj++;
      while (subj < end && (/^\p{Lu}/u.test(w[subj]) || (NAME_PARTICLE.has(w[subj].toLowerCase()) && /^\p{Lu}/u.test(w[subj + 1] || '')))) subj++;
    }
    return Math.min(subj, end);
  }
  return /^\p{Lu}/u.test(w[0]) ? 1 : 0;
}

/** One subordinate clause to main-clause order; without a subject the verb simply goes first ("in Arnhem zit" → "zit in Arnhem"). */
function mainOrder(part: string, needSubject: boolean): string {
  const w = part.split(' ');
  if (w.length < 2 || !endsFinite(part)) return part;
  const last = w[w.length - 1];
  const subj = subjectLength(w, last);
  if (subj && w.length - 1 > subj) return [...w.slice(0, subj), last, ...w.slice(subj, -1)].join(' ');
  if (!subj && !needSubject) return [last, ...w.slice(0, -1)].join(' ');
  return part;
}

/**
 * Turn a Dutch subordinate clause ("ik in Utrecht woon") into a main clause ("Ik woon in Utrecht"). Coordinated
 * clauses keep their shared subject: "mijn webshop Velomax heet en in Arnhem zit" → "Mijn webshop heet Velomax en zit
 * in Arnhem".
 */
export function tidyClause(clause: string, subordinate: boolean): string {
  let c = clean(clause).replace(/[.!]+$/, '');
  // A nested clause ("… omdat ze daar studeert") already has its own word order: reorder only what comes before it
  // and keep it as it is ("mijn zus Lisa heet en in Utrecht woont omdat ze daar studeert" →
  // "Mijn zus heet Lisa en woont in Utrecht, omdat ze daar studeert").
  const nested = subordinate ? c.match(/,?\s+(omdat|want|zodat|terwijl|hoewel|doordat|tenzij|wanneer|zodra|nadat|voordat)\s+.+$/i) : null;
  if (nested && nested.index! > 0) {
    const head = tidyClause(c.slice(0, nested.index), true);
    return `${head}, ${nested[0].replace(/^,?\s+/, '')}`;
  }
  if (subordinate) {
    const parts = c.split(/\s+en\s+/);
    if (parts.length > 1 && parts.every(endsFinite) && parts[0].split(' ').length >= 3) {
      c = parts.map((p, i) => mainOrder(p, i === 0)).join(' en ');
    } else if (c.split(' ').length >= 3) {
      c = mainOrder(c, true);
    }
  }
  return c.charAt(0).toUpperCase() + c.slice(1);
}

// ---------------------------------------------------------------- automatic proposals (high precision only)

export interface HeuristicFact {
  content: string;
  key: string | null;
  type: ItemType;
  aboutUser: boolean;
}

const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const tidyEnd = (s: string) => s.replace(/[,;:]+$/, '').trim();
const DAYS = 'maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag|morgen|overmorgen|volgende week|eind van de (?:week|maand)';
const MONTHS = 'januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december';
const ROLE_NOUN = 'klant|leverancier|accountant|boekhouder|compagnon|collega|partner|baas|manager|webdesigner|developer|ontwikkelaar|advocaat|notaris|huisarts|tandarts|contactpersoon|aannemer|vertegenwoordiger';

/** "Ik woon nu in Leiden" → "Ik woon in Leiden" (the change marker is not part of the fact). */
function dropNow(s: string): string {
  return s.replace(/\s+(?:nu|inmiddels|tegenwoordig|sinds kort|now)(?=\s)/i, '');
}

const FACT_PATTERNS: { re: RegExp; key: (m: RegExpMatchArray) => string | null; type: ItemType; about: boolean; rewrite?: (m: RegExpMatchArray) => string }[] = [
  // Corrections first: "ik woon niet meer in Utrecht maar in Amersfoort" → "Ik woon in Amersfoort" (same key → supersede).
  { re: /^ik woon (?:sinds kort |nu |tegenwoordig )?niet meer (?:in|op|te) .{2,60}? maar (?:nu |sinds kort )?(?:in|op|te) (.{2,60})$/i, key: () => 'woonplaats', type: 'fact', about: true, rewrite: (m) => `Ik woon in ${tidyEnd(m[1])}` },
  { re: /^(?:ik ben|we zijn|wij zijn) (?:onlangs |net |vorige \w+ )?verhuisd (?:van .{2,40}? )?naar (.{2,60})$/i, key: () => 'woonplaats', type: 'fact', about: true, rewrite: (m) => `Ik woon in ${tidyEnd(m[1])}` },
  { re: /^ik werk (?:sinds kort |nu |tegenwoordig )?niet meer bij .{2,60}? maar (?:nu |sinds kort )?bij (.{2,60})$/i, key: () => 'werkgever', type: 'fact', about: true, rewrite: (m) => `Ik werk bij ${tidyEnd(m[1])}` },
  { re: /^(?:sinds (?:kort|vandaag|deze (?:week|maand)|vorige (?:week|maand)|[a-z0-9 ]{1,20}),? )?werk ik (?:nu |tegenwoordig )?bij (.{2,60}?)(?:,? (?:en )?niet meer bij .{2,60})?$/i, key: () => 'werkgever', type: 'fact', about: true, rewrite: (m) => `Ik werk bij ${tidyEnd(m[1])}` },
  { re: /^(?:ik heet|mijn naam is|my name is|i'm called|call me|noem me|noem mij|spreek me aan met)\s+(.{2,60})$/i, key: () => 'naam', type: 'fact', about: true },
  // "nu/inmiddels/tegenwoordig" marks a change ("ik woon nu in Leiden"): same key as before, the adverb is dropped.
  { re: /^(?:ik woon|i live)\s+(?:(?:nu|inmiddels|tegenwoordig|sinds kort|now)\s+)?(?:in|op|te|at)\s+(.{2,80})$/i, key: () => 'woonplaats', type: 'fact', about: true, rewrite: (m) => dropNow(m[0]) },
  { re: /^(?:ik werk|i work)\s+(?:(?:nu|inmiddels|tegenwoordig|sinds kort|now)\s+)?(?:bij|voor|at|for)\s+(.{2,80})$/i, key: () => 'werkgever', type: 'fact', about: true, rewrite: (m) => dropNow(m[0]) },
  { re: /^(?:ik werk als|ik ben van beroep|i work as an?|i am an?|i'm an?)\s+(.{2,60})$/i, key: () => 'beroep', type: 'fact', about: true },
  { re: /^(?:mijn|my)\s+([a-zà-ÿ][\wà-ÿ ]{1,40}?)\s+(?:is|zijn|heet|heten|are)\s+(?:(?:nu|inmiddels|tegenwoordig|now)\s+)?(.{1,80})$/i, key: (m) => m[1], type: 'fact', about: true, rewrite: (m) => dropNow(m[0]) },
  { re: /^(?:ik hou van|ik houd van|ik vind .{1,40} (?:leuk|fijn|lekker)|ik heb een voorkeur voor|ik geef de voorkeur aan|i love|i like|i prefer)\b(.{2,100})$/i, key: () => null, type: 'preference', about: true },
  { re: /^(?:ik hou niet van|ik houd niet van|ik heb een hekel aan|ik haat|ik vind .{1,40} niet (?:leuk|fijn)|i hate|i dislike|i don't like)\b(.{2,100})$/i, key: () => null, type: 'preference', about: true },
  { re: /^(?:voortaan|vanaf nu|in het vervolg|from now on)\b[, ]*(.{4,200})$/i, key: () => null, type: 'instruction', about: false },
  { re: /^(?:antwoord|schrijf|reply|answer)\s+(?:altijd|voortaan|always)\s+(.{3,120})$/i, key: () => 'antwoordstijl', type: 'instruction', about: false },
  // Standing instructions with "altijd/nooit" ("Schrijf blogteksten altijd in de je-vorm").
  { re: /^(?:schrijf|antwoord|formuleer|gebruik|noem|spreek|vermeld|zet)\s+(?:\S+\s+){0,5}?(?:altijd|voortaan|nooit)\s+(.{3,140})$/i, key: () => null, type: 'instruction', about: false },
  // Diet / identity ("Ik ben trouwens vegetariër").
  { re: /^ik ben (?:trouwens |zelf |sinds .{1,20} )?(vegetari\w*|veganist\w*|vegan|flexitari\w*|zzp'?er|freelancer|ondernemer|student|gepensioneerd|eigenaar van .{2,60})\b.{0,80}$/i, key: (m) => (/vegetari|vegan|flexitari/i.test(m[1]) ? 'dieet' : 'beroep'), type: 'fact', about: true, rewrite: (m) => `Ik ben ${m[1].toLowerCase()}` },
  { re: /^ik heb (?:een |mijn eigen )?(eenmanszaak|bedrijf|webshop|winkel|zaak|praktijk|bv|vof)\b(.{2,100})$/i, key: () => 'bedrijf', type: 'fact', about: true },
  // Habits with "altijd/nooit/graag/liever" ("Ik drink mijn koffie altijd zwart").
  { re: /^ik (?:drink|eet|neem|lees|draag|rijd|sport|fiets|loop)\b.{0,40}?\b(?:altijd|nooit|graag|liever|het liefst)\b.{1,80}$/i, key: () => null, type: 'preference', about: true },
  // Decisions ("We hebben besloten om …", "We gaan voor …").
  { re: /^(?:(?:we|wij|ik) (?:hebben|heb) (?:besloten|gekozen|afgesproken)|(?:oké|ok|goed|prima),? (?:we|wij) (?:gaan|kiezen) voor|(?:we|wij) (?:gaan|kiezen) voor|besluit:|besloten:)\b.{3,180}$/i, key: () => null, type: 'decision', about: false },
  // Commitments ("Ik heb Jan beloofd dat …", "Ik moet de aangifte vóór 31 januari indienen").
  { re: /^ik heb .{1,40} beloofd\b.{3,160}$/i, key: () => null, type: 'task', about: true },
  { re: new RegExp(`^ik moet .{3,100}?\\b(?:vóór|voor|uiterlijk|op) (?:\\d{1,2} (?:${MONTHS})|${DAYS})\\b.{0,80}$`, 'i'), key: () => null, type: 'task', about: true },
  // People and companies ("Pieter de Vries is onze nieuwe accountant", "Onze grootste klant is Bouwmaat").
  { re: new RegExp(`^(\\p{Lu}[\\p{L}-]+(?: (?:de |van |van der |van den |den |ter )?\\p{Lu}[\\p{L}-]+){0,3}) is (?:onze|mijn|de|ons) (?:nieuwe |vaste |grootste |belangrijkste |eigen )?(${ROLE_NOUN})\\b.{0,120}$`, 'u'), key: () => null, type: 'person', about: true },
  { re: new RegExp(`^(?:onze|ons) (?:nieuwe |vaste |grootste |belangrijkste )?(${ROLE_NOUN})\\s+(?:is|heet)\\s+(.{2,100})$`, 'i'), key: () => null, type: 'person', about: true },
  // Names of the owner's own things ("Die winkel heet Velo Vintage en zit in Haarlem").
  { re: /^(?:die|de|mijn|onze|ons) (winkel|zaak|webshop|site|website|bedrijf|praktijk|bv|merk|app)\s+heet\s+(.{2,100})$/i, key: (m) => `naam ${m[1].toLowerCase()}`, type: 'fact', about: true },
  // Planned dates ("De lancering staat gepland voor 1 maart").
  { re: new RegExp(`^(?:de|onze|mijn) ([\\p{L}-]{3,30}) (?:staat|is) gepland (?:voor|op) (\\d{1,2} (?:${MONTHS})(?: \\d{4})?|${DAYS})\\b.{0,60}$`, 'iu'), key: () => null, type: 'task', about: true },
];

/** Facts/preferences the user states about themselves, as review proposals. Questions and hypotheticals are skipped. */
export function heuristicFacts(raw: string, max = 5): HeuristicFact[] {
  const own = ownWords(raw);
  if (!own) return [];
  const out: HeuristicFact[] = [];
  for (const s0 of sentences(own)) {
    const s = s0.replace(/[.!]+$/, '').trim();
    if (!s || s.endsWith('?') || s.length > 240) continue;
    if (/^(als|stel dat|wat als|if|suppose|misschien|maybe|denk je|vind je)\b/i.test(s)) continue;
    if (REMEMBER_RE.test(s) || NO_REMEMBER_RE.test(s)) continue;
    for (const p of FACT_PATTERNS) {
      const m = s.match(p.re);
      if (!m) continue;
      const key = p.key(m);
      out.push({ content: cap1(tidyEnd(p.rewrite ? p.rewrite(m) : s)), key: key ? clean(key, 80).toLowerCase() : null, type: p.type, aboutUser: p.about });
      break;
    }
    if (out.length >= max) break;
  }
  return out;
}

/** A canonical key for explicit statements, so "ik woon in X" later conflicts with "ik woon in Y". */
export function guessKey(content: string): { key: string | null; type: ItemType | null } {
  const s = content.replace(/[.!]+$/, '');
  for (const p of FACT_PATTERNS) {
    const m = s.match(p.re);
    if (m) {
      const k = p.key(m);
      return { key: k ? clean(k, 80).toLowerCase() : null, type: p.type };
    }
  }
  return { key: null, type: null };
}

export function guessType(content: string): ItemType {
  const s = content.toLowerCase();
  if (DIRECTIVE_RE.test(content)) return 'instruction';
  if (/\b(besloten|besluit|afgesproken|decided|agreed|we kiezen|gekozen voor)\b/.test(s)) return 'decision';
  if (/\b(todo|actie|deadline|uiterlijk|moet nog|follow[- ]?up|taak)\b/.test(s)) return 'task';
  if (/\b(hou van|houd van|voorkeur|liever|prefer|like|hekel|favoriet)\b/.test(s)) return 'preference';
  if (/\b(geleerd|les|lesson|learned|tip|werkt beter|let op)\b/.test(s)) return 'lesson';
  return 'fact';
}

// ---------------------------------------------------------------- episode heuristics

const DECISION_RE = /\b(besloten|besluit|we gaan voor|afgesproken|gekozen voor|we kiezen|akkoord|decided|agreed|we'll go with|decision)\b/i;
const ACTION_RE = /\b(todo|to-do|actiepunt|actie:|ik zal|ik ga\b|jij gaat|moet nog|deadline|uiterlijk|vóór|voor (maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag|morgen|volgende week)|follow[- ]?up|will do|i'll|next step|volgende stap)\b/i;

export function episodeLines(text: string): { decisions: string[]; actions: string[]; questions: string[] } {
  const decisions: string[] = [];
  const actions: string[] = [];
  const questions: string[] = [];
  for (const s of sentences(ownWords(text) || text)) {
    if (s.length < 8 || s.length > 300) continue;
    if (s.endsWith('?')) questions.push(s);
    else if (DECISION_RE.test(s)) decisions.push(s);
    else if (ACTION_RE.test(s)) actions.push(s);
  }
  return { decisions, actions, questions };
}

/** Escape a string for use inside a SQL LIKE pattern with ESCAPE '\'. */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}
