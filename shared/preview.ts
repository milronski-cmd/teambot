const REF = '(?:m|d|b|a|g|p|e|s):[a-z0-9]{4,16}';
/** "[m:abc123]", "[m:abc123, d:xyz789]" and "(m:abc123)": always a citation code. */
const BRACKETED = new RegExp(`[ \\t]*[\\[(]${REF}(?:\\s*[,;]\\s*${REF})*[\\])]`, 'g');
/** A bare "m:2tdmcj" in running text: only when it has a digit, so ordinary words like "a:b" are left alone. */
const BARE = new RegExp(`(^|[\\s“"'(])(?=(?:m|d|b|a|g|p|e|s):[a-z]*\\d)${REF}\\b[ \\t]?`, 'g');

/** Internal ids such as "dlg_3f9a…" (a request to another bot): "(id dlg_…)", "id dlg_…, " or bare. */
const INTERNAL_ID = /\s*\(id [a-z]{2,6}_[0-9a-f]{16,32}\)|\bid [a-z]{2,6}_[0-9a-f]{16,32},\s*|\s*\b(?:dlg|bc|apr|run|cq)_[0-9a-f]{16,32}\b/g;

/**
 * Memory citation codes ([m:abc123], d:xyz789) out of a text shown outside the chat bubble: notifications, the
 * approval cards, "Wacht op jou", search results, the steps of a bot. The bubble itself turns them into source chips.
 * Internal request ids (dlg_…) go too.
 */
export function stripRefs(text: string | null | undefined): string {
  return String(text || '')
    .replace(BRACKETED, '')
    .replace(BARE, '$1')
    .replace(INTERNAL_ID, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,;:!?])/g, '$1')
    .trim();
}

/** The head of TeamBot's "Pagina lezen" result for the bot: "URL: …\nStatus: 200\nTitel: …\n\n" (Q-03). */
const WEB_HEAD = /^URL: (\S+)\nStatus: (\d{3})(?:\nTitel: ([^\n]*))?\n\n/;

/** What a web page's status means, as a sentence; '' when the page came back normally. */
export function webStatusText(status: number): string {
  if (status === 404 || status === 410) return 'Deze pagina bestaat niet (meer).';
  if (status === 401 || status === 403) return 'De website geeft geen toegang tot deze pagina.';
  if (status === 429) return 'De website krijgt te veel verzoeken. Probeer het later opnieuw.';
  if (status >= 500) return 'De website heeft even een storing.';
  if (status >= 400) return 'De website gaf deze pagina niet.';
  return '';
}

/**
 * A "Pagina lezen" result in words: no "URL: … Status: 200 Titel: …" but what went wrong (if anything) and the page's
 * title, then the rest as it is. `inline`: for one line (a step). Other texts come back unchanged.
 */
export function webPageInWords(text: string, inline = false): string {
  const m = WEB_HEAD.exec(text);
  if (!m) return text;
  const title = (m[3] || '').trim();
  const head = [webStatusText(Number(m[2])), title && `“${title}”`].filter(Boolean).join(inline ? ' ' : '\n');
  return head + (head ? (inline ? ' — ' : '\n\n') : '') + text.slice(m[0].length);
}

/**
 * The detail line of a step: the markers TeamBot puts around a loaded skill for the bot
 * (`<skill naam="x" versie="r1" bron="…" geverifieerd="nee">`) become words, the rest as stripRefs.
 */
export function stepDetail(text: string | null | undefined): string {
  const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] || '';
  const words = webPageInWords(String(text || ''), true)
    // The page itself, read for the bot: its text (the line already says which page).
    .replace(/<webinhoud bron="[^"]*">\n?/g, '')
    .replace(/\n?<\/webinhoud>/g, '')
    .replace(/<skill\s[^>]*>/g, (tag) => {
      const parts = [attr(tag, 'versie') && `versie ${attr(tag, 'versie')}`, attr(tag, 'bron') && `bron ${attr(tag, 'bron')}`, attr(tag, 'geverifieerd') === 'nee' ? 'niet geverifieerd' : attr(tag, 'geverifieerd') === 'ja' ? 'geverifieerd' : ''].filter(Boolean);
      return parts.length ? `${parts.join(' · ')} — ` : '';
    })
    .replace(/<skillbestand\s[^>]*\bpad="([^"]*)"[^>]*>/g, '$1: ')
    .replace(/<\/(?:skill|skillbestand)>/g, '');
  return stripRefs(words);
}

/** One-line preview of a message for lists: no markdown symbols (**, #, `, links) and no memory citation codes ([m:abc123]). */
export function previewText(md: string | null | undefined): string {
  const src = String(md || '');
  const out = stripRefs(
    src
      .replace(/```[\s\S]*?```/g, ' ')
      // A preview that was cut off inside a code block ("```mermaid flowchart TD A[Water ko…") ends in an open fence.
      .replace(/```[\s\S]*$/, ' ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
      .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
      .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,!?:;]|$)/g, '$1$2')
      .replace(/^\s*>\s?/gm, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();
  // Only a code block: say what it is instead of an empty line.
  if (!out && /```\s*(mermaid|mmd)\b/i.test(src)) return 'Diagram';
  if (!out && src.includes('```')) return 'Codeblok';
  return out;
}
