import dns from 'node:dns/promises';
import net from 'node:net';
import { isPrivateIp } from '../../tools/builtin/web.js';

/**
 * Network policy for the bot browser (SSRF guard + per-bot domain allow/deny lists).
 * Pure decision logic with an injectable resolver so it can be unit-tested without network.
 */

export interface UrlPolicy {
  /** Hosts the bot may open (empty = every public host). `example.com` also matches subdomains; `*.example.com` only subdomains. */
  allow: string[];
  /** Hosts that are always blocked (wins over allow). */
  deny: string[];
  /** Localhost / LAN / link-local allowed (owner/admin only, explicit). */
  allowPrivate: boolean;
}

export type Resolver = (host: string) => Promise<string[]>;

export const defaultResolver: Resolver = async (host) => (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export interface UrlDecision {
  ok: boolean;
  reason?: string;
  url?: URL;
}

// ---------- IP classification ----------

/** The one SSRF check (tools/builtin/web.ts); this name stays for existing callers. */
export { isPrivateIp as isPrivateAddress };

// ---------- domain lists ----------

/** Normalise a user-entered domain rule ("https://www.Example.com/x" -> "www.example.com"). */
export function normalizeRule(r: string): string {
  let s = String(r || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
  return s;
}

export function hostMatches(host: string, rule: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const r = normalizeRule(rule);
  if (!r) return false;
  if (r.startsWith('*.')) return h.endsWith(r.slice(1)) && h.length > r.length - 1;
  return h === r || h.endsWith('.' + r);
}

export function cleanRules(list: unknown, max = 200): string[] {
  if (!Array.isArray(list)) return [];
  const out = new Set<string>();
  for (const x of list) {
    const r = normalizeRule(String(x));
    if (r && /^(\*\.)?[a-z0-9.\-[\]:]+$/.test(r)) out.add(r);
    if (out.size >= max) break;
  }
  return [...out];
}

// ---------- URL decisions ----------

const dnsCache = new Map<string, { at: number; addrs: string[] }>();

async function resolveCached(host: string, resolver: Resolver): Promise<string[]> {
  if (resolver !== defaultResolver) return resolver(host);
  const hit = dnsCache.get(host);
  if (hit && Date.now() - hit.at < 60_000) return hit.addrs;
  const addrs = await resolver(host);
  dnsCache.set(host, { at: Date.now(), addrs });
  if (dnsCache.size > 2000) dnsCache.clear();
  return addrs;
}

/**
 * Decide whether the bot browser may load a URL.
 * - only http(s) (plus about:blank)
 * - denylist always wins; allowlist (if set) only applies to top-level navigations
 * - private / loopback / link-local addresses blocked unless allowPrivate (checked after DNS)
 */
export async function checkUrl(raw: string, policy: UrlPolicy, o: { navigation?: boolean; resolver?: Resolver } = {}): Promise<UrlDecision> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'Ongeldige URL' };
  }
  if (u.href === 'about:blank') return { ok: true, url: u };
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: `Protocol ${u.protocol} is niet toegestaan (alleen http en https)` };
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return { ok: false, reason: 'URL zonder host' };
  if (policy.deny.some((r) => hostMatches(host, r))) return { ok: false, reason: `${host} staat op de blokkeerlijst van deze bot` };
  if (o.navigation !== false && policy.allow.length && !policy.allow.some((r) => hostMatches(host, r)))
    return { ok: false, reason: `${host} staat niet op de lijst met toegestane domeinen van deze bot` };
  if (policy.allowPrivate) return { ok: true, url: u };
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa') || host.endsWith('.lan'))
    return { ok: false, reason: 'Lokale adressen zijn geblokkeerd voor deze bot (SSRF-bescherming)' };
  let addrs: string[];
  if (net.isIP(host)) addrs = [host];
  else {
    try {
      addrs = await resolveCached(host, o.resolver || defaultResolver);
    } catch {
      return { ok: false, reason: `Kan ${host} niet opzoeken (DNS)` };
    }
  }
  if (!addrs.length) return { ok: false, reason: `Kan ${host} niet opzoeken (DNS)` };
  if (addrs.some(isPrivateIp)) return { ok: false, reason: 'Dit adres wijst naar een privé-netwerk of deze computer en is geblokkeerd (SSRF-bescherming)' };
  return { ok: true, url: u };
}

// ---------- action risk ----------

/** Words that indicate an irreversible / external side effect when clicked or submitted. */
const DANGER_WORDS =
  /\b(koop|kopen|bestel|bestellen|betaal|betalen|afrekenen|checkout|check out|pay|buy|purchase|order now|place order|verstuur|versturen|verzend|verzenden|send|submit|post|plaats|plaatsen|publiceer|publiceren|publish|tweet|share|delen|delete|verwijder|verwijderen|remove|bevestig|bevestigen|confirm|transfer|overmaken|doneer|donate|subscribe|abonneer|sign|onderteken|merge|deploy|install|installeer)\b/i;

const PAY_SEND_WORDS =
  /\b(koop|kopen|bestel|bestellen|betaal|betalen|afrekenen|checkout|check out|pay|buy|purchase|order now|place order|verstuur|versturen|verzend|verzenden|send|transfer|overmaken|doneer|donate|subscribe|abonneer)\b/i;

export interface ElementInfo {
  tag: string;
  type?: string;
  role?: string;
  name?: string;
  inForm?: boolean;
  formMethod?: string;
  /** button that would submit its form (type=submit or default button inside a form) */
  submits?: boolean;
  href?: string;
}

/**
 * Classify a click/Enter on an element: 'write' for ordinary interaction/navigation,
 * 'danger' when it likely sends, buys, publishes or deletes something.
 */
export function classifyAction(el: ElementInfo, o: { full?: boolean } = {}): { risk: 'write' | 'danger'; reason?: string } {
  const name = (el.name || '').slice(0, 200);
  // "Volledige toegang": only a button that pays or sends goes through browser_submit; the rest is an ordinary click.
  if (o.full) return PAY_SEND_WORDS.test(name) ? { risk: 'danger', reason: `"${name.slice(0, 60)}" lijkt iets te kopen, te betalen of te versturen` } : { risk: 'write' };
  if (DANGER_WORDS.test(name)) return { risk: 'danger', reason: `"${name.slice(0, 60)}" lijkt iets te versturen, kopen, publiceren of verwijderen` };
  if (el.submits || (el.tag === 'input' && /^(submit|image)$/i.test(el.type || ''))) {
    const method = (el.formMethod || 'get').toLowerCase();
    if (method !== 'get') return { risk: 'danger', reason: 'Deze knop verstuurt een formulier (POST)' };
  }
  return { risk: 'write' };
}

/** Honest risk per tool, used by the registry and documented in the module doc. */
export const TOOL_RISK = {
  browser_open: 'read',
  browser_navigate: 'read',
  browser_back: 'read',
  browser_snapshot: 'read',
  browser_screenshot: 'read',
  browser_tabs: 'read',
  browser_wait: 'read',
  browser_close: 'read',
  browser_click: 'write',
  browser_type: 'write',
  browser_select: 'write',
  browser_press: 'write',
  browser_scroll: 'write',
  browser_download: 'write',
  browser_request_login: 'read',
  browser_submit: 'danger',
  browser_upload: 'danger',
  desktop_windows: 'read',
  desktop_inspect: 'read',
  desktop_screenshot: 'read',
  // Desktop input is gated inside the tools by the bot's desktop access level (every / task / full access);
  // external side effects (send, pay, delete, publish) always ask with risk "danger" there.
  desktop_click: 'write',
  desktop_type: 'write',
  desktop_key: 'write',
  desktop_computer: 'write',
  desktop_launch: 'write',
  desktop_request_access: 'read',
  desktop_request_takeover: 'read',
  rehearsal_start: 'write',
  rehearsal_status: 'read',
  rehearsal_finish: 'read',
  workspace_snapshot: 'write',
  workspace_snapshots: 'read',
  computer_exec: 'exec',
  remote_exec: 'exec',
  remote_read_file: 'read',
  remote_list: 'read',
  remote_write_file: 'write',
  remote_upload: 'write',
  remote_download: 'write',
} as const;
