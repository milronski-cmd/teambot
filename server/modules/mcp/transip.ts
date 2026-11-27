import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Ctx } from '../../core/types.js';
import { ah, bad, str, user } from '../../core/http.js';
import type { ConnectionRow } from './db.js';
import type { McpManager } from './runtime.js';
import { getConn } from './oauth.js';
import { cleanError, sha256 } from './util.js';
import { ensureKeyAppConn, forgetSecret, keyAppConn, type KeyAppHelpers } from './keyapp.js';

/**
 * TransIP (4.17.x): the owner's domains and their DNS, so that a bot can run the web side of his business: see which
 * domains there are and when they renew, check whether a name is free, register one (that costs money: it always asks
 * the owner, impact "payment" in tools.ts), and set DNS records and nameservers (outward steps: a wrong record takes a
 * site or the mail offline, so they ask unless the owner allowed outward steps).
 *
 * TransIP's REST API v6. The owner gives his login name and a private key (control panel › Account › API ›
 * Key Pairs); TeamBot signs a short-lived token with it (POST /auth) and keeps that until shortly before it ends.
 * The key's IP whitelist usually holds only the owner's IPv4 address, so every call to TransIP goes over IPv4.
 */

export const TRANSIP_ID = 'transip';
const API = 'https://api.transip.nl/v6';
export const TRANSIP_SECRET = 'mcp:transip:account';

/** Tests point TEAMBOT_TRANSIP_BASE at a local stand-in for TransIP. Loopback only. */
function base(): string {
  const b = process.env.TEAMBOT_TRANSIP_BASE || '';
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/[\w/-]*)?$/.test(b) ? b.replace(/\/$/, '') : API;
}

export interface TransipAccount {
  login: string;
  privateKey: string;
}

function account(ctx: Ctx, userId: string): TransipAccount | null {
  try {
    const a = JSON.parse(ctx.secrets.getByName(userId, TRANSIP_SECRET) || 'null');
    return a?.login && a?.privateKey ? a : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- calling TransIP

export class TransipError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** TransIP's own error text, with what the owner can do about it in front. */
export function explainTransip(status: number, text: string, auth = false): string {
  const t = String(text || '').slice(0, 300);
  if (/whitelist|ip[- ]?(address|adres)?\b.*(not|niet)\b.*(allow|toegestaan)|not allowed.*\bip\b|\bip\b.*not allowed/i.test(t)) return `TransIP weigert dit IP-adres: het staat niet op de whitelist van je API-sleutel. Zet het IPv4-adres van deze computer erbij (TransIP › Account › API › IP-whitelist), of maak een sleutel zonder whitelist. TransIP meldt: ${t}`;
  if (/api.*(disabled|not enabled|switched off|uitgeschakeld|staat uit)|(disabled|not enabled).*api/i.test(t)) return `De API staat uit bij TransIP. Zet hem aan bij TransIP › Account › API (“API-instellingen: Aan”). TransIP meldt: ${t}`;
  if (auth || status === 401) return `TransIP nam de inlognaam en sleutel niet aan. Controleer je TransIP-inlognaam en plak de hele privésleutel (met “-----BEGIN PRIVATE KEY-----”). TransIP meldt: ${t || `HTTP ${status}`}`;
  if (status === 404) return `Niet gevonden bij TransIP: ${t}`;
  if (status === 429) return `TransIP krijgt nu te veel verzoeken. Probeer het over een minuut opnieuw. (${t})`;
  return t || `TransIP gaf HTTP ${status}.`;
}

/** One HTTP request to TransIP over IPv4 (a GET can carry a JSON body: /domain-availability takes one). */
function send(method: string, url: URL, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string }> {
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, { method, family: 4, timeout: 60_000, headers: { accept: 'application/json', ...headers, ...(body !== undefined ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 20_000_000) req.destroy(new Error('Het antwoord van TransIP is te groot.'));
        else chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new TransipError(504, 'Geen antwoord van TransIP binnen een minuut. Probeer het opnieuw.')));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const parse = (text: string) => {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return null;
  }
};

/** The body of POST /auth and its signature: RSA-SHA512 over exactly that JSON text, base64. */
export function transipAuthRequest(a: TransipAccount, at = Date.now()): { body: string; signature: string } {
  const body = JSON.stringify({ login: a.login, nonce: crypto.randomBytes(16).toString('hex'), read_only: false, expiration_time: '30 minutes', label: `TeamBot ${new Date(at).toISOString().slice(0, 19).replace('T', ' ')} ${crypto.randomBytes(3).toString('hex')}`, global_key: false });
  return { body, signature: crypto.sign('RSA-SHA512', Buffer.from(body), a.privateKey).toString('base64') };
}

/** Tokens, per account and key, until shortly before they end (30 minutes). */
const tokens = new Map<string, { token: string; until: number }>();
const TOKEN_MS = 25 * 60_000;
export function clearTransipTokens() {
  tokens.clear();
}

async function token(a: TransipAccount, fresh = false): Promise<string> {
  const key = sha256(`${a.login}\n${a.privateKey}`);
  const hit = tokens.get(key);
  if (!fresh && hit && hit.until > Date.now()) return hit.token;
  const { body, signature } = transipAuthRequest(a);
  let r: { status: number; text: string };
  try {
    r = await send('POST', new URL(base() + '/auth'), { signature }, body);
  } catch (e: any) {
    throw new TransipError(502, `TransIP is niet bereikbaar: ${cleanError(e)}`);
  }
  const j = parse(r.text);
  if (r.status >= 300 || !j?.token) throw new TransipError(r.status || 502, explainTransip(r.status, String(j?.error || r.text), true));
  tokens.set(key, { token: String(j.token), until: Date.now() + TOKEN_MS });
  return String(j.token);
}

export type TransipCall = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, opts?: { query?: Record<string, any>; body?: any }) => Promise<any>;

export function transipCaller(a: TransipAccount): TransipCall {
  return async (method, path, opts = {}) => {
    const u = new URL(base() + path);
    for (const [k, v] of Object.entries(opts.query || {})) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    let r = await send(method, u, { authorization: `Bearer ${await token(a)}` }, body);
    // The token ended early (or was revoked): one new one, once.
    if (r.status === 401) r = await send(method, u, { authorization: `Bearer ${await token(a, true)}` }, body);
    const j = parse(r.text);
    if (r.status >= 300) throw new TransipError(r.status, explainTransip(r.status, String(j?.error || r.text)));
    return j ?? {};
  };
}

// ---------------------------------------------------------------- tools

const domainName = z
  .string()
  .regex(/^(?=.{3,253}$)([a-z0-9](-*[a-z0-9])*\.)+[a-z]{2,63}$/i, 'Geef een domeinnaam zoals voorbeeld.nl')
  .describe('De domeinnaam, bijv. "voorbeeld.nl"');
const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SRV', 'SSHFP', 'TLSA', 'CAA', 'NAPTR'] as const;
const dnsEntry = z.object({
  name: z.string().min(1).max(255).describe('De naam binnen het domein: "@" voor het domein zelf, "www", "mail._domainkey" …'),
  expire: z.number().int().min(60).max(2_592_000).describe('TTL in seconden, bijv. 300 of 86400'),
  type: z.enum(DNS_TYPES),
  content: z.string().min(1).max(4000).describe('De waarde, bijv. een IP-adres, "10 mx1.forwardemail.net." of de tekst van een TXT-record'),
});
const nameserver = z.object({ hostname: z.string().min(3).max(255), ipv4: z.string().optional(), ipv6: z.string().optional() });
const d = (name: string) => `/domains/${encodeURIComponent(name.toLowerCase())}`;

/** A domain as a bot reads it: never the auth code (that moves the domain to another registrar). */
export function tidyDomain(x: any) {
  const out: any = {
    name: x?.name,
    renewalDate: x?.renewalDate ?? null,
    registrationDate: x?.registrationDate ?? null,
    cancellationDate: x?.cancellationDate || null,
    isTransferLocked: x?.isTransferLocked ?? null,
    isWhitelabel: x?.isWhitelabel ?? undefined,
    isDnsOnly: x?.isDnsOnly ?? undefined,
    tags: Array.isArray(x?.tags) && x.tags.length ? x.tags : undefined,
  };
  if (Array.isArray(x?.nameservers)) out.nameservers = x.nameservers.map((n: any) => ({ hostname: n?.hostname, ...(n?.ipv4 ? { ipv4: n.ipv4 } : {}), ...(n?.ipv6 ? { ipv6: n.ipv6 } : {}) }));
  if (Array.isArray(x?.contacts)) out.contacts = x.contacts.map((c: any) => ({ type: c?.type, name: [c?.firstName, c?.lastName].filter(Boolean).join(' ') || undefined, company: c?.companyName || undefined, email: c?.email || undefined, country: c?.country || undefined }));
  return out;
}

interface TTool {
  name: string;
  title: string;
  description: string;
  /** read: no change; write: makes something; send: changes what the outside world sees (DNS) or costs money. */
  kind: 'read' | 'write' | 'send';
  input: Record<string, z.ZodTypeAny>;
  run(a: any, call: TransipCall): Promise<any>;
}

export const TRANSIP_TOOLS: TTool[] = [
  {
    name: 'transip_domains',
    title: 'Domeinen bij TransIP',
    kind: 'read',
    description: 'De domeinen van de eigenaar bij TransIP, met de datum waarop ze verlengd worden. De verhuiscode (auth code) wordt nooit getoond.',
    input: { tags: z.string().optional().describe('Alleen domeinen met deze tags, komma-gescheiden') },
    run: async (a, call) => {
      const r = await call('GET', '/domains', { query: { tags: a.tags } });
      const list = (Array.isArray(r?.domains) ? r.domains : []).map(tidyDomain);
      return { count: list.length, domains: list };
    },
  },
  {
    name: 'transip_domain',
    title: 'Eén domein',
    kind: 'read',
    description: 'Eén domein bij TransIP: verlengdatum, nameservers en contactpersonen (samengevat).',
    input: { domain: domainName },
    run: async (a, call) => tidyDomain((await call('GET', d(a.domain), { query: { include: 'nameservers,contacts' } }))?.domain || {}),
  },
  {
    name: 'transip_domain_available',
    title: 'Is een domeinnaam vrij?',
    kind: 'read',
    description: 'Kijk bij TransIP of een of meer domeinnamen vrij zijn om te registreren (status free = vrij, notfree = bezet, inyouraccount = al van de eigenaar). Registreren doe je daarna met transip_domain_register.',
    input: { domain: domainName.optional(), domains: z.array(domainName).max(20).optional().describe('Meerdere namen tegelijk (hoogstens 20)') },
    run: async (a, call) => {
      const names: string[] = [...(a.domain ? [a.domain] : []), ...(a.domains || [])].map((x: string) => x.toLowerCase());
      if (!names.length) throw new Error('Geef een domeinnaam (domain) of een lijst (domains).');
      if (names.length === 1) return { availability: [(await call('GET', `/domain-availability/${encodeURIComponent(names[0])}`))?.availability] };
      return { availability: (await call('GET', '/domain-availability', { body: { domainNames: [...new Set(names)] } }))?.availability || [] };
    },
  },
  {
    name: 'transip_domain_register',
    title: 'Domein registreren (kost geld)',
    kind: 'send',
    description:
      'Registreer een nieuwe domeinnaam bij TransIP op naam van de eigenaar. Dit kost geld: TransIP maakt er een factuur voor, en de eigenaar moet het altijd eerst goedkeuren. Kijk eerst met transip_domain_available of de naam vrij is. Zonder contacts/nameservers gebruikt TransIP de standaard van het account.',
    input: {
      domain: domainName,
      nameservers: z.array(nameserver).max(13).optional().describe('Eigen nameservers; leeg = die van TransIP'),
      dnsEntries: z.array(dnsEntry).max(200).optional().describe('DNS-records om meteen te zetten'),
      contacts: z.array(z.record(z.string(), z.any())).max(10).optional().describe('Contactpersonen in de vorm van TransIP (type, firstName, lastName, companyName, street, number, postalCode, city, phoneNumber, email, country); leeg = de standaard van het account'),
    },
    run: async (a, call) => {
      await call('POST', '/domains', { body: { domainName: a.domain.toLowerCase(), ...(a.contacts?.length ? { contacts: a.contacts } : {}), ...(a.nameservers?.length ? { nameservers: a.nameservers } : {}), ...(a.dnsEntries?.length ? { dnsEntries: a.dnsEntries } : {}) } });
      return { ok: true, registered: a.domain.toLowerCase(), note: 'TransIP registreert het domein; het staat binnen enkele minuten in het account. Er komt een factuur voor.' };
    },
  },
  {
    name: 'transip_dns',
    title: 'DNS-records',
    kind: 'read',
    description: 'Alle DNS-records van een domein bij TransIP (naam, TTL in seconden, type, waarde).',
    input: { domain: domainName },
    run: async (a, call) => ({ domain: a.domain.toLowerCase(), dnsEntries: (await call('GET', `${d(a.domain)}/dns`))?.dnsEntries || [] }),
  },
  {
    name: 'transip_dns_add',
    title: 'DNS-record toevoegen',
    kind: 'send',
    description: 'Voeg één DNS-record toe aan een domein bij TransIP (bijv. een MX- of TXT-record voor de mail, of een A-record voor een site). Bestaande records blijven staan. Een verkeerd record kan een site of de mail laten uitvallen.',
    input: { domain: domainName, entry: dnsEntry },
    run: async (a, call) => {
      await call('POST', `${d(a.domain)}/dns`, { body: { dnsEntry: a.entry } });
      return { ok: true, added: a.entry, note: 'DNS-wijzigingen zijn meestal binnen enkele minuten tot een uur overal zichtbaar.' };
    },
  },
  {
    name: 'transip_dns_update',
    title: 'DNS-record wijzigen',
    kind: 'send',
    description: 'Wijzig de waarde (content) van één bestaand DNS-record bij TransIP. TransIP zoekt het record op naam, TTL en type; er moet er precies één zo zijn. Kijk eerst met transip_dns.',
    input: { domain: domainName, entry: dnsEntry.describe('Naam, TTL en type van het bestaande record, met de nieuwe waarde in content') },
    run: async (a, call) => {
      await call('PATCH', `${d(a.domain)}/dns`, { body: { dnsEntry: a.entry } });
      return { ok: true, updated: a.entry };
    },
  },
  {
    name: 'transip_dns_delete',
    title: 'DNS-record verwijderen',
    kind: 'send',
    description: 'Verwijder één DNS-record van een domein bij TransIP. Geef het record precies zoals transip_dns het toont (naam, TTL, type en waarde).',
    input: { domain: domainName, entry: dnsEntry },
    run: async (a, call) => {
      await call('DELETE', `${d(a.domain)}/dns`, { body: { dnsEntry: a.entry } });
      return { ok: true, deleted: a.entry };
    },
  },
  {
    name: 'transip_dns_replace',
    title: 'Alle DNS-records vervangen',
    kind: 'send',
    description:
      'LET OP: vervangt ALLE DNS-records van een domein bij TransIP door deze lijst. Elk record dat niet in de lijst staat, is daarna weg en komt niet terug (ook de records voor de site en de mail). Haal eerst de huidige records op met transip_dns en geef de complete nieuwe lijst. Voor één record: gebruik transip_dns_add, transip_dns_update of transip_dns_delete.',
    input: { domain: domainName, entries: z.array(dnsEntry).min(1).max(500).describe('De complete nieuwe lijst met records') },
    run: async (a, call) => {
      await call('PUT', `${d(a.domain)}/dns`, { body: { dnsEntries: a.entries } });
      return { ok: true, domain: a.domain.toLowerCase(), records: a.entries.length };
    },
  },
  {
    name: 'transip_nameservers_set',
    title: 'Nameservers instellen',
    kind: 'send',
    description: 'Stel de nameservers van een domein bij TransIP in. Andere nameservers dan die van TransIP betekenen dat de DNS-records bij TransIP niet meer gelden; een fout hier haalt site en mail offline.',
    input: { domain: domainName, nameservers: z.array(nameserver).min(1).max(13) },
    run: async (a, call) => {
      await call('PUT', `${d(a.domain)}/nameservers`, { body: { nameservers: a.nameservers } });
      return { ok: true, domain: a.domain.toLowerCase(), nameservers: a.nameservers.map((n: any) => n.hostname) };
    },
  },
];

/** The in-process MCP server of the TransIP connection. */
export function transipServer(ctx: Ctx, c: ConnectionRow): McpServer {
  const server = new McpServer({ name: 'TransIP', version: ctx.config.version }, { capabilities: { tools: {} } });
  for (const t of TRANSIP_TOOLS) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: z.object(t.input), annotations: { readOnlyHint: t.kind === 'read', destructiveHint: t.kind === 'send', openWorldHint: t.kind === 'send' } },
      async (args: any) => {
        try {
          const conn = getConn(ctx, c.id) || c;
          const a = account(ctx, conn.user_id);
          if (!a) throw new Error('TransIP is niet meer gekoppeld (de sleutel ontbreekt). Koppel het opnieuw bij Apps › TransIP.');
          const out = await t.run(args || {}, transipCaller(a));
          return { content: [{ type: 'text' as const, text: JSON.stringify(out, null, 1) }] };
        } catch (e: any) {
          return { content: [{ type: 'text' as const, text: `TransIP gaf een fout: ${cleanError(e)}` }], isError: true };
        }
      },
    );
  }
  return server;
}

// ---------------------------------------------------------------- setting up

function parseAccount(body: any): TransipAccount {
  const login = str(body?.login, 120).trim();
  if (!/^[\w.@+-]{2,120}$/.test(login)) throw bad('Vul je TransIP-inlognaam in (de naam waarmee je inlogt op het controlepaneel, niet je e-mailadres als dat afwijkt).');
  const privateKey = str(body?.privateKey, 10_000).trim();
  try {
    if (crypto.createPrivateKey(privateKey).asymmetricKeyType !== 'rsa') throw new Error('rsa');
  } catch {
    throw bad('Dit is geen geldige privésleutel. Plak de hele sleutel die TransIP toonde bij het aanmaken (TransIP › Account › API › Key Pairs), met de regels “-----BEGIN PRIVATE KEY-----” en “-----END PRIVATE KEY-----”.');
  }
  return { login, privateKey };
}

export function registerTransip(ctx: Ctx, mgr: McpManager, h: KeyAppHelpers) {
  const api = ctx.api;
  const state = (userId: string) => {
    const a = account(ctx, userId);
    const c = keyAppConn(ctx, userId, TRANSIP_ID);
    return { account: a ? { login: a.login } : null, status: a && c ? 'on' : 'off', connection: c ? h.view(c) : null };
  };

  api.get('/mcp/transip', ah(async (req) => state(user(req).id)));

  /** Save the login and key (checked with one real read), or forget them. */
  api.put(
    '/mcp/transip',
    ah(async (req) => {
      const u = user(req);
      if (req.body?.forget === true) {
        forgetSecret(ctx, u.id, TRANSIP_SECRET);
        clearTransipTokens();
        return state(u.id);
      }
      const a = parseAccount(req.body);
      try {
        await transipCaller(a)('GET', '/domains', { query: { pageSize: 1 } });
      } catch (e: any) {
        ctx.log.warn('[mcp] transip: sleutel niet aangenomen', cleanError(e, [a.privateKey]).slice(0, 300));
        throw bad(cleanError(e, [a.privateKey]).slice(0, 500));
      }
      ctx.secrets.set(u.id, TRANSIP_SECRET, JSON.stringify(a));
      ctx.audit(u.id, 'mcp.transip.account', { login: a.login });
      await ensureKeyAppConn(ctx, mgr, h, u.id, { id: TRANSIP_ID, name: 'TransIP', slug: 'transip' });
      return state(u.id);
    }),
  );
}
