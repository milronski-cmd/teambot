import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Ctx } from '../../core/types.js';
import { ah, bad, str, user } from '../../core/http.js';
import type { ConnectionRow } from './db.js';
import type { McpManager } from './runtime.js';
import { getConn } from './oauth.js';
import { cleanError, guardedFetch } from './util.js';
import { ensureKeyAppConn, forgetSecret, keyAppConn, type KeyAppHelpers } from './keyapp.js';

/**
 * Forward Email (forwardemail.net, 4.17.x): the mail side of the owner's domains. A bot sees which mail domains there
 * are and whether their DNS is complete (and, with TransIP, can add what is missing), and makes addresses: an alias
 * that forwards, or a real mailbox (IMAP). Removing an address is an outward step (mail to it bounces or is lost).
 *
 * The owner pastes his API token (forwardemail.net › My Account › Security); calls use HTTP Basic with the token as
 * the user name and an empty password.
 */

export const FORWARDEMAIL_ID = 'forwardemail';
const API = 'https://api.forwardemail.net';
export const FORWARDEMAIL_SECRET = 'mcp:forwardemail:token';

/** Tests point TEAMBOT_FORWARDEMAIL_BASE at a local stand-in. Loopback only. */
function testBase(): string {
  const b = process.env.TEAMBOT_FORWARDEMAIL_BASE || '';
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(b) ? b : '';
}
const net = () => guardedFetch(!!testBase());

function stored(ctx: Ctx, userId: string): { token: string; email: string } | null {
  try {
    const v = JSON.parse(ctx.secrets.getByName(userId, FORWARDEMAIL_SECRET) || 'null');
    return v?.token ? { token: String(v.token), email: String(v.email || '') } : null;
  } catch {
    return null;
  }
}
const tokenOf = (ctx: Ctx, userId: string) => stored(ctx, userId)?.token || null;

export class ForwardEmailError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type FeCall = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, opts?: { query?: Record<string, any>; body?: any }) => Promise<any>;

export function feCaller(token: string): FeCall {
  const auth = `Basic ${Buffer.from(`${token}:`).toString('base64')}`;
  return async (method, path, opts = {}) => {
    const u = new URL((testBase() || API) + path);
    for (const [k, v] of Object.entries(opts.query || {})) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    let res: Response;
    try {
      res = await net()(u.href, {
        method,
        headers: { authorization: auth, accept: 'application/json', ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e: any) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new ForwardEmailError(504, 'Geen antwoord van Forward Email binnen een minuut. Probeer het opnieuw.');
      throw new ForwardEmailError(502, `Forward Email is niet bereikbaar: ${cleanError(e, [token])}`);
    }
    const text = await res.text();
    let j: any = null;
    try {
      j = text ? JSON.parse(text) : {};
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const msg = String(j?.message || j?.error || text.slice(0, 300) || `HTTP ${res.status}`).slice(0, 600);
      if (res.status === 401) throw new ForwardEmailError(401, `Forward Email nam deze API-token niet aan. Maak een nieuwe bij forwardemail.net › My Account › Security en plak die. (${msg})`);
      throw new ForwardEmailError(res.status, msg);
    }
    return j ?? {};
  };
}

// ---------------------------------------------------------------- tools

const domainName = z
  .string()
  .regex(/^(?=.{3,253}$)([a-z0-9](-*[a-z0-9])*\.)+[a-z]{2,63}$/i, 'Geef een domeinnaam zoals voorbeeld.nl')
  .describe('De maildomeinnaam, bijv. "voorbeeld.nl"');
const aliasRef = z.string().min(1).max(200).describe('Het ID van het adres (zie forwardemail_aliases) of de naam vóór de @');
const dom = (name: string) => `/v1/domains/${encodeURIComponent(name.toLowerCase())}`;

const RECORDS = ['has_mx_record', 'has_txt_record', 'has_dkim_record', 'has_return_path_record', 'has_dmarc_record'] as const;

/** A mail domain as a bot reads it: whether its DNS is complete, and which records are still missing. */
export function tidyFeDomain(x: any) {
  const missing = RECORDS.filter((k) => x?.[k] === false).map((k) => k.replace(/^has_|_record$/g, '').toUpperCase().replace('RETURN_PATH', 'Return-Path'));
  return {
    id: x?.id,
    name: x?.name,
    plan: x?.plan,
    dns_compleet: !!x?.has_mx_record && !!x?.has_txt_record && missing.length === 0,
    ...Object.fromEntries(RECORDS.filter((k) => x?.[k] !== undefined).map((k) => [k, !!x[k]])),
    ontbreekt: missing.length ? missing : undefined,
    verification_record: x?.verification_record || undefined,
    has_recipient_verification: x?.has_recipient_verification ?? undefined,
    created_at: x?.created_at ?? undefined,
  };
}

export function tidyAlias(x: any, domain?: string) {
  const d = domain || x?.domain?.name || '';
  return {
    id: x?.id,
    name: x?.name,
    address: x?.name && d ? `${x.name}@${d}` : undefined,
    recipients: x?.recipients,
    description: x?.description || undefined,
    labels: Array.isArray(x?.labels) && x.labels.length ? x.labels : undefined,
    is_enabled: x?.is_enabled,
    has_imap: x?.has_imap ?? undefined,
    storage_used: x?.storage_used ?? undefined,
  };
}

interface FTool {
  name: string;
  title: string;
  description: string;
  kind: 'read' | 'write' | 'send';
  input: Record<string, z.ZodTypeAny>;
  run(a: any, call: FeCall): Promise<any>;
}

const aliasFields = {
  recipients: z.array(z.string().min(1).max(320)).max(50).optional().describe('Waar de mail heen gaat: e-mailadressen (of een webhook-URL). Leeg bij een echte mailbox (has_imap)'),
  description: z.string().max(500).optional(),
  labels: z.array(z.string().max(60)).max(20).optional(),
  is_enabled: z.boolean().optional().describe('Aan (standaard) of uit'),
  has_imap: z.boolean().optional().describe('true = een echte mailbox (IMAP/POP3) waar de mail bewaard wordt, in plaats van alleen doorsturen'),
};
const pick = (a: any, keys: string[]) => Object.fromEntries(keys.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));

export const FORWARDEMAIL_TOOLS: FTool[] = [
  {
    name: 'forwardemail_domains',
    title: 'Maildomeinen',
    kind: 'read',
    description: 'De maildomeinen bij Forward Email, met het abonnement (plan) en of de DNS compleet is (MX, TXT, DKIM, Return-Path, DMARC). Wat ontbreekt, zie forwardemail_domain_verify.',
    input: { page: z.number().int().min(1).optional() },
    run: async (a, call) => {
      const list = await call('GET', '/v1/domains', { query: { limit: 50, page: a.page } });
      const domains = (Array.isArray(list) ? list : []).map(tidyFeDomain);
      return { count: domains.length, domains };
    },
  },
  {
    name: 'forwardemail_domain',
    title: 'Eén maildomein',
    kind: 'read',
    description: 'Eén maildomein bij Forward Email: plan, welke DNS-records er zijn en welke ontbreken, en de DNS-zone die Forward Email voorstelt.',
    input: { domain: domainName },
    run: async (a, call) => {
      const x = await call('GET', dom(a.domain));
      return { ...tidyFeDomain(x), zone_file: typeof x?.zone_file === 'string' ? x.zone_file.slice(0, 8000) : undefined };
    },
  },
  {
    name: 'forwardemail_domain_verify',
    title: 'DNS van een maildomein controleren',
    kind: 'read',
    description: 'Laat Forward Email de DNS-records van een maildomein controleren: wat er nog ontbreekt of fout staat. Staat het domein bij TransIP, dan kun je ontbrekende records zetten met transip_dns_add en daarna opnieuw controleren.',
    input: { domain: domainName },
    run: async (a, call) => {
      try {
        const r = await call('GET', `${dom(a.domain)}/verify-records`);
        return { domain: a.domain.toLowerCase(), ok: true, result: r };
      } catch (e: any) {
        // A domain whose records are not right yet: Forward Email answers with an error that says what is missing.
        if (e instanceof ForwardEmailError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 404) return { domain: a.domain.toLowerCase(), ok: false, ontbreekt_of_fout: e.message };
        throw e;
      }
    },
  },
  {
    name: 'forwardemail_domain_create',
    title: 'Maildomein toevoegen',
    kind: 'write',
    description: 'Voeg een domein toe aan Forward Email om er mail voor te ontvangen. Daarna moeten de DNS-records gezet worden (zie forwardemail_domain_verify).',
    input: { domain: domainName, plan: z.enum(['free', 'enhanced_protection', 'team']).optional().describe('Het abonnement; leeg = dat van het account') },
    run: async (a, call) => tidyFeDomain(await call('POST', '/v1/domains', { body: { domain: a.domain.toLowerCase(), ...(a.plan ? { plan: a.plan } : {}) } })),
  },
  {
    name: 'forwardemail_aliases',
    title: 'Mailadressen van een domein',
    kind: 'read',
    description: 'De mailadressen (aliassen en mailboxen) van een domein bij Forward Email: naam, waar het heen gaat, aan/uit, en of het een echte mailbox (IMAP) is.',
    input: { domain: domainName, q: z.string().max(200).optional().describe('Zoeken op naam of ontvanger'), page: z.number().int().min(1).optional() },
    run: async (a, call) => {
      const list = await call('GET', `${dom(a.domain)}/aliases`, { query: { q: a.q, limit: 50, page: a.page } });
      const aliases = (Array.isArray(list) ? list : []).map((x: any) => tidyAlias(x, a.domain.toLowerCase()));
      return { domain: a.domain.toLowerCase(), count: aliases.length, aliases };
    },
  },
  {
    name: 'forwardemail_alias_create',
    title: 'Mailadres maken',
    kind: 'write',
    description: 'Maak een mailadres op een domein bij Forward Email: een alias die doorstuurt naar recipients, of met has_imap een echte mailbox. Naam "*" is een catch-all.',
    input: { domain: domainName, name: z.string().min(1).max(200).describe('Het deel vóór de @, bijv. "info"'), ...aliasFields },
    run: async (a, call) => tidyAlias(await call('POST', `${dom(a.domain)}/aliases`, { body: { name: a.name, ...pick(a, ['recipients', 'description', 'labels', 'is_enabled', 'has_imap']) } }), a.domain.toLowerCase()),
  },
  {
    name: 'forwardemail_alias_update',
    title: 'Mailadres wijzigen',
    kind: 'write',
    description: 'Wijzig een mailadres bij Forward Email: ontvangers, omschrijving, labels, aan/uit of mailbox (has_imap). Alleen wat je meegeeft verandert.',
    input: { domain: domainName, alias: aliasRef, name: z.string().min(1).max(200).optional().describe('Nieuwe naam vóór de @'), ...aliasFields },
    run: async (a, call) => tidyAlias(await call('PUT', `${dom(a.domain)}/aliases/${encodeURIComponent(a.alias)}`, { body: pick(a, ['name', 'recipients', 'description', 'labels', 'is_enabled', 'has_imap']) }), a.domain.toLowerCase()),
  },
  {
    name: 'forwardemail_alias_delete',
    title: 'Mailadres verwijderen',
    kind: 'send',
    description: 'Verwijder een mailadres bij Forward Email. Mail naar dit adres komt daarna niet meer aan, en bij een mailbox (IMAP) is de bewaarde mail weg.',
    input: { domain: domainName, alias: aliasRef },
    run: async (a, call) => {
      await call('DELETE', `${dom(a.domain)}/aliases/${encodeURIComponent(a.alias)}`);
      return { ok: true, deleted: a.alias, domain: a.domain.toLowerCase() };
    },
  },
  {
    name: 'forwardemail_alias_password',
    title: 'Wachtwoord voor een mailbox',
    kind: 'send',
    description:
      'Maak een nieuw wachtwoord voor een mailbox (IMAP) bij Forward Email. Het wachtwoord komt nooit bij de bot: Forward Email mailt de inloggegevens naar het adres in send_to (vraag de eigenaar naar welk adres). Zet een wachtwoord nooit in een chat of bericht. De bewaarde mail blijft staan.',
    input: { domain: domainName, alias: aliasRef, send_to: z.string().email().describe('Het e-mailadres waar Forward Email de inloggegevens naartoe stuurt (van de eigenaar of de gebruiker van de mailbox)') },
    run: async (a, call) => {
      await call('POST', `${dom(a.domain)}/aliases/${encodeURIComponent(a.alias)}/generate-password`, { body: { emailed_instructions: a.send_to } });
      return { ok: true, alias: a.alias, domain: a.domain.toLowerCase(), note: `De inloggegevens zijn naar ${a.send_to} gemaild. Het wachtwoord zelf staat hier bewust niet.` };
    },
  },
];

/** Never hand a password on to a bot, whatever the service answers. */
function scrub(v: any): any {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !/password|token|secret/i.test(k)).map(([k, x]) => [k, scrub(x)]));
  return v;
}

/** The in-process MCP server of the Forward Email connection. */
export function forwardEmailServer(ctx: Ctx, c: ConnectionRow): McpServer {
  const server = new McpServer({ name: 'Forward Email', version: ctx.config.version }, { capabilities: { tools: {} } });
  for (const t of FORWARDEMAIL_TOOLS) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: z.object(t.input), annotations: { readOnlyHint: t.kind === 'read', destructiveHint: t.kind === 'send', openWorldHint: t.kind === 'send' } },
      async (args: any) => {
        const conn = getConn(ctx, c.id) || c;
        const token = tokenOf(ctx, conn.user_id);
        try {
          if (!token) throw new Error('Forward Email is niet meer gekoppeld (de API-token ontbreekt). Koppel het opnieuw bij Apps › Forward Email.');
          const out = scrub(await t.run(args || {}, feCaller(token)));
          return { content: [{ type: 'text' as const, text: typeof out === 'string' ? out : JSON.stringify(out, null, 1) }] };
        } catch (e: any) {
          return { content: [{ type: 'text' as const, text: `Forward Email gaf een fout: ${cleanError(e, token ? [token] : [])}` }], isError: true };
        }
      },
    );
  }
  return server;
}

// ---------------------------------------------------------------- setting up

export function registerForwardEmail(ctx: Ctx, mgr: McpManager, h: KeyAppHelpers) {
  const api = ctx.api;
  const state = (userId: string) => {
    const s = stored(ctx, userId);
    const c = keyAppConn(ctx, userId, FORWARDEMAIL_ID);
    return { account: s ? { email: s.email || null } : null, status: s && c ? 'on' : 'off', connection: c ? h.view(c) : null };
  };

  api.get('/mcp/forwardemail', ah(async (req) => state(user(req).id)));

  api.put(
    '/mcp/forwardemail',
    ah(async (req) => {
      const u = user(req);
      if (req.body?.forget === true) {
        forgetSecret(ctx, u.id, FORWARDEMAIL_SECRET);
        return state(u.id);
      }
      const token = str(req.body?.token, 500).trim();
      if (!/^[\x21-\x7e]{8,500}$/.test(token)) throw bad('Plak je API-token van Forward Email (forwardemail.net › My Account › Security).');
      let email = '';
      try {
        const acc = await feCaller(token)('GET', '/v1/account');
        email = String(acc?.email || '').slice(0, 200);
      } catch (e: any) {
        ctx.log.warn('[mcp] forwardemail: token niet aangenomen', cleanError(e, [token]).slice(0, 300));
        throw bad(e instanceof ForwardEmailError && e.status === 401 ? cleanError(e, [token]) : `Forward Email nam de token niet aan: ${cleanError(e, [token]).slice(0, 400)}`);
      }
      ctx.secrets.set(u.id, FORWARDEMAIL_SECRET, JSON.stringify({ token, email }));
      ctx.audit(u.id, 'mcp.forwardemail.token', { email });
      await ensureKeyAppConn(ctx, mgr, h, u.id, { id: FORWARDEMAIL_ID, name: 'Forward Email', slug: 'forwardemail' });
      return state(u.id);
    }),
  );
}
