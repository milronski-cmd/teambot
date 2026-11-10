/**
 * Plain text for places outside the chat bubble (notifications, push, approval summaries): no memory citation codes
 * like "[m:2tdmcj]" or a bare "d:xyz789". The chat bubble turns those into source chips itself; everywhere else they
 * are noise. Same rules as ui/src/lib/preview.ts (stripRefs).
 */
const REF = '(?:m|d|b|a|g|p|e|s):[a-z0-9]{4,16}';
const BRACKETED = new RegExp(`[ \\t]*[\\[(]${REF}(?:\\s*[,;]\\s*${REF})*[\\])]`, 'g');
const BARE = new RegExp(`(^|[\\s“"'(])(?=(?:m|d|b|a|g|p|e|s):[a-z]*\\d)${REF}\\b[ \\t]?`, 'g');
/** Internal ids such as "dlg_3f9a…" (a request to another bot): "(id dlg_…)", "id dlg_…, " or bare. */
const INTERNAL_ID = /\s*\(id [a-z]{2,6}_[0-9a-f]{16,32}\)|\bid [a-z]{2,6}_[0-9a-f]{16,32},\s*|\s*\b(?:dlg|bc|apr|run|cq)_[0-9a-f]{16,32}\b/g;

export function stripRefs(text: string): string {
  if (!text || !/[a-z][:_][a-z0-9]{4}/.test(text)) return text;
  return text
    .replace(BRACKETED, '')
    .replace(BARE, '$1')
    .replace(INTERNAL_ID, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,;:!?])/g, '$1')
    .trim();
}
