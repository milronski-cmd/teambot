/**
 * Pure text helpers of the specialists module: what in a source reads like an instruction to an AI (source text is
 * data, never a command), what a bot's answer says when it does not know, word tokens for overlap checks, quote
 * anchoring and a paragraph diff. No I/O; unit-tested in tests/specialists.test.ts.
 */

/** Lower case, no diacritics, punctuation as spaces, single spaces. */
export function normalize(s: string): string {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@.:/]+/gu, ' ')
    .replace(/(?<![\p{L}\p{N}])[.:/]+|[.:/]+(?![\p{L}\p{N}])/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP = new Set(
  (
    'de het een en of in op aan van voor met naar bij uit om te tot over als dan dat die dit deze is zijn was waren wordt worden ' +
    'je jij u ik we wij ze zij hij zij er hun hen ons onze mijn jouw uw niet geen wel ook nog al maar want dus hoe wat wie waar wanneer ' +
    'heeft hebben had kan kun kunnen mag mogen moet moeten zal zullen zou zouden veel meer minder heel erg zo of ' +
    'the a an and or of in on at to for with from by as is are was were be been it its this that these those not no ' +
    'do does did can could should would will may might have has had you your we our they their he she his her'
  ).split(' '),
);

/** Content words (no stop words, at least 2 characters), at most `max`. */
export function tokens(s: string, max = 80): string[] {
  const out: string[] = [];
  for (const w of normalize(s).split(' ')) {
    if (w.length < 2 || STOP.has(w)) continue;
    const t = w.replace(/(en|s|e)$/, (m, _x, i) => (w.length - m.length >= 4 ? '' : m));
    if (!out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

export function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sb = new Set(b);
  const inter = a.filter((x) => sb.has(x)).length;
  return inter / (a.length + b.length - inter);
}

/** Share of `small` that is in `big`. */
export function containment(small: string[], big: string[]): number {
  if (!small.length) return 0;
  const sb = new Set(big);
  return small.filter((x) => sb.has(x)).length / small.length;
}

export function clip(s: string, n: number): string {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, Math.max(0, n - 1)).trimEnd() + '…' : t;
}

// ---------------------------------------------------------------------------- instructions in source text

/**
 * Text in a web page, feed or file that addresses an AI or tries to make it do something: override its rules, change
 * its role, send data somewhere, run commands, or store a rule. Such text is dropped before a model sees the source,
 * and a "fact" that looks like it is never stored.
 */
const INSTRUCTION_RES: RegExp[] = [
  // "negeer alle eerdere instructies", "ignore previous instructions", "disregard the rules above"
  /\b(negeer|vergeet|omzeil|ignore|disregard|forget|override|bypass)\b.{0,60}\b(instructie\w*|opdracht\w*|regels?|richtlijn\w*|prompt\w*|instructions?|rules?|guidelines?|system)\b/,
  /\b(nieuwe|new|updated|gewijzigde)\s+(instructie\w*|instructions?|opdracht\w*|system prompt|systeemprompt)\b/,
  /\b(system ?prompt|systeemprompt|developer message|jailbreak|prompt injection)\b/,
  /<\|?(im_start|im_end|system|assistant)\|?>|\[\/?inst\]|###\s*(instruction|system)/,
  // a new role: "je bent nu", "vanaf nu ben je", "you are now", "act as", "pretend"
  /\b(je bent nu|jij bent nu|vanaf nu (ben|moet|doe)|you are now|from now on you|act as (a|an|the)\b|pretend (to be|you are)|doe alsof je)\b/,
  // speaking to the AI that reads this
  /\b(beste|lieve|dear|hey|hallo|hello)\s+(ai|assistent|assistant|chatbot|bot|llm|taalmodel|language model)\b/,
  /\b(ai[- ]?(assistent\w*|assistants?|agents?|modellen|models?|bots?)|taalmodellen|language models|llms?|chatbots?)\b.{0,40}\b(die|that|who|which)\b.{0,20}\b(dit|this)\b.{0,10}\b(lezen|leest|read|reads|reading|zien|see)\b/,
  // sending data somewhere
  /\b(stuur|verstuur|mail|e-?mail|doorsturen|stuur door|send|forward|upload|post|lek|leak|exfiltrat\w*)\b.{0,80}\b(naar|to|aan)\b.{0,60}(@|https?:\/\/|\bwww\.|\bwebhook\b)/,
  /\b(stuur|verstuur|send|forward|deel|share|geef|give|reveal|toon|show)\b.{0,50}\b(wachtwoord\w*|password\w*|api[- ]?(key|sleutel)\w*|tokens?|geheim\w*|secrets?|credentials?|klantgegevens|klantenlijst|gegevens van|private data|personal data|system prompt)\b/,
  // running things
  /\b(voer|run|execute|draai)\b.{0,40}\b(uit|commando\w*|commands?|scripts?|code|shell|terminal)\b/,
  /\b(curl|wget|powershell|bash -c|rm -rf|invoke-webrequest|iex)\b/,
  // storing a rule or using a tool
  /\b(onthoud|sla op|bewaar|remember|save|store)\b.{0,40}\b(voortaan|altijd|nooit|from now on|always|never|als regel|as a rule)\b/,
  /\b(roep|gebruik|call|use|invoke)\b.{0,20}\b(de tool|the tool|tool|function|functie)\b.{0,40}\b(aan|with|met|to)\b/,
  // a directive at the start of a sentence
  /^(voortaan|vanaf nu|in het vervolg|from now on|you must|you should always|je moet altijd|antwoord (altijd|voortaan)|reply (always|only))\b/,
];

/** Does this text read like an instruction to an AI (rather than information)? */
export function looksLikeInstruction(s: string): boolean {
  const n = String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (!n) return false;
  return INSTRUCTION_RES.some((re) => re.test(n));
}

/** Split text into paragraphs (blank lines; very long paragraphs into ~1200-character parts at sentence ends). */
export function paragraphs(text: string): string[] {
  const out: string[] = [];
  for (const raw of String(text || '').replace(/\r/g, '').split(/\n\s*\n+/)) {
    const p = raw.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
    if (!p) continue;
    if (p.length <= 1500) {
      out.push(p);
      continue;
    }
    let cur = '';
    for (const s of p.split(/(?<=[.!?])\s+/)) {
      if (cur && cur.length + s.length > 1200) {
        out.push(cur.trim());
        cur = '';
      }
      cur += (cur ? ' ' : '') + s;
    }
    if (cur.trim()) out.push(cur.trim());
  }
  return out;
}

/**
 * Remove every paragraph (and every line of a list) that reads like an instruction to an AI. Returns the clean text
 * and what was dropped, so the report can say what was ignored.
 */
export function sanitizeSource(text: string): { text: string; dropped: string[] } {
  const keep: string[] = [];
  const dropped: string[] = [];
  for (const p of paragraphs(text)) {
    if (!looksLikeInstruction(p)) {
      keep.push(p);
      continue;
    }
    // A long paragraph with one bad sentence: keep the other sentences.
    const parts = p.split(/(?<=[.!?])\s+|\n/);
    if (parts.length > 2) {
      const good = parts.filter((x) => !looksLikeInstruction(x));
      const bad = parts.filter((x) => looksLikeInstruction(x));
      if (good.join(' ').trim()) keep.push(good.join(' ').trim());
      dropped.push(...bad.map((b) => b.trim()).filter(Boolean));
    } else dropped.push(p);
  }
  return { text: keep.join('\n\n'), dropped };
}

/** Paragraphs of `next` that were not in `prev` (normalised), in order. */
export function newParagraphs(prev: string, next: string): string[] {
  const old = new Set(paragraphs(prev).map(normalize));
  return paragraphs(next).filter((p) => !old.has(normalize(p)));
}

/** The quote (at least 3 words) is literally in the source text (ignoring case, accents, punctuation and spacing). */
export function anchored(quote: string, source: string): boolean {
  const q = normalize(quote);
  if (q.split(' ').filter(Boolean).length < 3) return false;
  return normalize(source).includes(q);
}

/** The sentence of the source that shares the most words with `text` (a real quote when the model's quote is not). */
export function bestSentence(text: string, source: string): { sentence: string; share: number } {
  const t = tokens(text);
  let best = { sentence: '', share: 0 };
  for (const p of paragraphs(source))
    for (const s of p.split(/(?<=[.!?])\s+|\n/)) {
      const share = containment(t, tokens(s));
      if (share > best.share) best = { sentence: s.trim(), share };
    }
  return best;
}

/**
 * Is this fact grounded in the source? Its quote is literally there, or (models often paraphrase the quote) at least
 * 60 % of the fact's own words are in the source, with at least three words. A made-up fact fails both.
 */
export function grounded(fact: string, quote: string, source: string): { ok: boolean; excerpt: string } {
  if (anchored(quote, source)) return { ok: true, excerpt: quote };
  const ft = tokens(fact);
  if (ft.length < 3 || containment(ft, tokens(source, 4000)) < 0.6) return { ok: false, excerpt: '' };
  return { ok: true, excerpt: clip(bestSentence(fact, source).sentence || quote, 300) };
}

// ---------------------------------------------------------------------------- knowledge gaps

const GAP_RES: RegExp[] = [
  /\b(dat|dit|het) weet ik (helaas |eigenlijk |nu |op dit moment )?niet\b/,
  /\bik weet (het|dat|dit) (helaas |eigenlijk |nu )?niet\b/,
  /\bweet ik (het )?niet zeker\b|\bik weet (het )?niet zeker\b/,
  /\b(daar|hierover|daarover) heb ik (helaas )?(geen|nog geen|onvoldoende) (informatie|gegevens|kennis|bronnen?)\b/,
  /\bik heb (helaas )?(geen|nog geen) (informatie|gegevens|kennis|bron(nen)?) (over|van|voor|bij|waarin)\b/,
  /\b(staat|zit) (niet|nog niet) in mijn (kennisbank|geheugen|bronnen)\b/,
  /\bkan ik (je )?(helaas )?(niet|geen antwoord op) (zeggen|beantwoorden|vinden|geven)\b/,
  /\b(ik kan|kan ik) (dat|dit|het) (helaas )?niet (beantwoorden|zeggen|vinden)\b/,
  /\bgeen (betrouwbare )?bron (voor|over|van)\b/,
  /\bi (don't|do not) know\b|\bi'm not sure\b|\bi am not sure\b|\bi (don't|do not) have (any )?(information|data|a source)\b/,
];

/** Does the bot's answer say it does not know (a knowledge gap)? Only the first part of a long answer counts. */
export function saysUnknown(answer: string): boolean {
  const n = String(answer || '')
    .slice(0, 1500)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, ' ');
  return GAP_RES.some((re) => re.test(n));
}

/** The owner's own words of a message: no quotes, code blocks or forwarded parts. */
export function ownWords(content: string): string {
  return String(content || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A short, safe id for a model prompt (k1, g2 …) → the real id. */
export function shortIds<T extends { id: string }>(rows: T[], prefix: string): { map: Map<string, T>; list: { key: string; row: T }[] } {
  const map = new Map<string, T>();
  const list = rows.map((row, i) => {
    const key = `${prefix}${i + 1}`;
    map.set(key, row);
    return { key, row };
  });
  return { map, list };
}

/** Neutralise tag lookalikes so source text can never close the <bron> block it is quoted in. */
export function quoteSafe(s: string): string {
  return String(s || '').replace(/<\s*\/?\s*(bron|bekend|leerdoelen|system|instructie)/gi, (m) => m.replace('<', '‹'));
}
