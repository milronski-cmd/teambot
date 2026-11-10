import crypto from 'node:crypto';

/** Normalize a Message-ID to "<local@domain>" (lowercase domain part is NOT applied: ids are opaque). */
export function normId(id: string | null | undefined): string | null {
  if (!id) return null;
  const s = String(id).trim();
  if (!s) return null;
  const m = s.match(/<[^<>\s]+>/);
  if (m) return m[0];
  return /^[^<>\s]+@[^<>\s]+$/.test(s) ? `<${s}>` : null;
}

/** All Message-IDs in a References / In-Reply-To header value (or array of them). */
export function parseIdList(v: string | string[] | null | undefined): string[] {
  if (!v) return [];
  const all = (Array.isArray(v) ? v.join(' ') : String(v)).match(/<[^<>\s]+>/g) || [];
  return [...new Set(all)];
}

/**
 * Which earlier messages does this mail refer to? Most specific first (In-Reply-To,
 * then References from newest to oldest), so the closest known ancestor wins.
 */
export function threadCandidates(h: { inReplyTo?: string | null; references?: string | string[] | null }): string[] {
  const irt = parseIdList(h.inReplyTo || '');
  const refs = parseIdList(h.references || '').reverse();
  return [...new Set([...irt, ...refs])];
}

/**
 * Conversation key for an incoming mail: the conversation of the first known
 * ancestor, otherwise a new conversation keyed by the mail's own Message-ID.
 */
export function conversationKey(h: { messageId?: string | null; inReplyTo?: string | null; references?: string | string[] | null }, lookup: (ids: string[]) => string | null): { key: string; isNew: boolean } {
  const known = lookup(threadCandidates(h));
  if (known) return { key: known, isNew: false };
  const own = normId(h.messageId) || `<generated-${crypto.randomUUID()}@teambot.local>`;
  return { key: own, isNew: true };
}

/** Headers for a reply that threads correctly in every mail client (RFC 5322 §3.6.4). */
export function replyHeaders(o: { parentMessageId: string | null; parentReferences: string[]; subject: string; domain: string }) {
  const parent = normId(o.parentMessageId);
  const refs = [...o.parentReferences.map(normId).filter(Boolean) as string[]];
  if (parent && !refs.includes(parent)) refs.push(parent);
  // Keep the first (root) and the most recent ids if the chain gets long.
  const trimmed = refs.length > 20 ? [refs[0], ...refs.slice(-19)] : refs;
  return {
    messageId: newMessageId(o.domain),
    inReplyTo: parent || undefined,
    references: trimmed.length ? trimmed.join(' ') : undefined,
    subject: replySubject(o.subject),
  };
}

export function replySubject(subject: string): string {
  const s = (subject || '').replace(/[\r\n]+/g, ' ').trim();
  if (!s) return 'Re: (geen onderwerp)';
  return /^(re|antw|aw|sv)\s*:/i.test(s) ? s : `Re: ${s}`;
}

export function newMessageId(domain: string): string {
  const d = (domain || 'teambot.local').replace(/[^a-z0-9.-]/gi, '') || 'teambot.local';
  return `<tb.${Date.now().toString(36)}.${crypto.randomBytes(8).toString('hex')}@${d}>`;
}

export const domainOf = (address: string) => (address.split('@')[1] || '').toLowerCase().trim();

type HeaderMap = Map<string, any> | Record<string, any>;
function header(h: HeaderMap, name: string): any {
  return h instanceof Map ? h.get(name) : h[name];
}
function headerText(v: any): string {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.map(headerText).join(' ');
  if (typeof v === 'object') return String(v.value ?? v.text ?? '');
  return String(v);
}

/** Auto-replies, bounces and mailing lists must never get an automatic answer (mail loops). */
export function isAutomated(h: HeaderMap, fromAddress: string): string | null {
  const auto = headerText(header(h, 'auto-submitted')).toLowerCase().trim();
  if (auto && auto !== 'no') return 'Auto-Submitted';
  const prec = headerText(header(h, 'precedence')).toLowerCase();
  if (/\b(bulk|junk|list|auto_reply)\b/.test(prec)) return 'Precedence: ' + prec;
  if (header(h, 'x-autoreply') || header(h, 'x-autorespond') || header(h, 'x-auto-response-suppress')?.toString().toLowerCase?.().includes('oof')) return 'autoreply';
  if (header(h, 'list-id') || header(h, 'list-unsubscribe')) return 'mailinglijst';
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?)([+@.-]|$)/i.test(fromAddress)) return 'systeemadres';
  return null;
}

/**
 * Did the receiving server authenticate the sender domain? We read the topmost
 * Authentication-Results header (added by our own provider) and accept DMARC pass,
 * or an aligned DKIM/SPF pass for the From domain.
 */
export function authResultsPass(h: HeaderMap, fromAddress: string): { pass: boolean; method: string } {
  const raw = header(h, 'authentication-results');
  const first = headerText(Array.isArray(raw) ? raw[0] : raw).toLowerCase();
  if (!first) return { pass: false, method: 'geen Authentication-Results' };
  const fromDomain = domainOf(fromAddress);
  const aligned = (d: string) => {
    const x = d.replace(/^@/, '').replace(/[>;,\s].*$/, '').toLowerCase();
    const dom = x.includes('@') ? x.split('@')[1] : x;
    return !!dom && (dom === fromDomain || fromDomain.endsWith('.' + dom) || dom.endsWith('.' + fromDomain));
  };
  if (/\bdmarc=pass\b/.test(first)) return { pass: true, method: 'dmarc' };
  for (const m of first.matchAll(/\bdkim=pass\b[^;]*?header\.(?:d|i)=([^\s;]+)/g)) if (aligned(m[1])) return { pass: true, method: 'dkim' };
  for (const m of first.matchAll(/\bspf=pass\b[^;]*?smtp\.mailfrom=([^\s;]+)/g)) if (aligned(m[1])) return { pass: true, method: 'spf' };
  return { pass: false, method: 'niet geverifieerd' };
}

/** Remove quoted earlier messages and signatures from a reply (saves tokens, avoids re-reading history). */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const t = l.trim();
    const quoteHeader = /^(on|op|am|le)\s.{4,300}\b(wrote|schreef|heeft geschreven|schrieb|a écrit)\b.*:\s*$/i;
    if (quoteHeader.test(t) || (/^(on|op|am|le)\s/i.test(t) && quoteHeader.test(t + ' ' + (lines[i + 1] || '').trim()))) break;
    if (/^-{2,}\s*(original message|oorspronkelijk bericht|forwarded message|doorgestuurd bericht)/i.test(t)) break;
    if (/^_{8,}\s*$/.test(t) && /^(from|van):/i.test((lines[i + 1] || '').trim())) break;
    if (/^(from|van):\s.+/i.test(t) && out.length && out[out.length - 1].trim() === '' && /^(sent|verzonden|date|datum):/i.test((lines[i + 1] || '').trim())) break;
    if (t === '--' || l === '-- ') break;
    if (t.startsWith('>')) continue;
    out.push(l);
  }
  const res = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return res || text.trim();
}

// ---------------------------------------------------------------- an address per bot (plus addressing, 0.4.4 P10)

/** A plus tag as TeamBot accepts it: lowercase letters, digits, dot, dash, underscore; 1–40 characters. */
export const PLUS_TAG_RE = /^[a-z0-9](?:[a-z0-9._-]{0,38}[a-z0-9])?$/;

const GMAIL = new Set(['gmail.com', 'googlemail.com']);

/** The local part as the mail provider compares it (Gmail ignores dots). */
function plainLocal(local: string, domain: string): string {
  const l = local.toLowerCase();
  return GMAIL.has(domain) ? l.replace(/\./g, '') : l;
}

/** "jij+baas@gmail.com" for the mailbox "jij@gmail.com" and the tag "baas" (null for an invalid address or tag). */
export function plusAddress(base: string, tag: string): string | null {
  const m = String(base || '').trim().toLowerCase().match(/^([^@+\s]+)(?:\+[^@]*)?@([^@\s]+)$/);
  const t = String(tag || '').trim().toLowerCase();
  if (!m || !PLUS_TAG_RE.test(t)) return null;
  return `${m[1]}+${t}@${m[2]}`;
}

/**
 * The plus tag of `address` when it is a plus address of the mailbox `base` ("jij+baas@gmail.com" of "jij@gmail.com"
 * → "baas"); null for any other address. Case does not matter; on Gmail dots in the local part do not either.
 */
export function plusTagOf(address: string, base: string): string | null {
  const a = String(address || '').trim().toLowerCase().match(/^([^@+\s]+)\+([^@\s]+)@([^@\s]+)$/);
  const b = String(base || '').trim().toLowerCase().match(/^([^@+\s]+)@([^@\s]+)$/);
  if (!a || !b || a[3] !== b[2] || plainLocal(a[1], a[3]) !== plainLocal(b[1], b[2])) return null;
  return PLUS_TAG_RE.test(a[2]) ? a[2] : null;
}

/** The default tag of a bot from its name: "Baas" → "baas", "Mila de Planner" → "mila-de-planner", "Zoë" → "zoe". */
export function botTag(name: string): string {
  const s = String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return PLUS_TAG_RE.test(s) ? s : '';
}

/** Every bot's tag on one mailbox: the owner's own tag when set and free, else the tag from the name; no doubles. */
export function botTags(bots: { id: string; name: string }[], own: Record<string, string> = {}): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const b of bots) {
    const t = String(own[b.id] || '').toLowerCase();
    if (PLUS_TAG_RE.test(t) && !used.has(t)) out.set(b.id, t), used.add(t);
  }
  for (const b of bots) {
    if (out.has(b.id)) continue;
    const t = botTag(b.name);
    if (t && !used.has(t)) out.set(b.id, t), used.add(t);
  }
  return out;
}
