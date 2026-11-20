import crypto from 'node:crypto';
import type { Request } from 'express';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Ctx } from '../../core/types.js';
import { newId, now } from '../../core/db.js';
import { ah, bad, str, user } from '../../core/http.js';
import type { ConnectionRow } from './db.js';
import type { McpManager } from './runtime.js';
import { getConn, patchOAuth } from './oauth.js';
import { cleanError, guardedFetch, sha256 } from './util.js';

/**
 * The bank (4.9.1): the bots read the balances and transactions of the owner's own bank accounts, so that the money
 * side of a business is in TeamBot too (the dashboard, a bot that keeps the books). Reading only: there is no tool
 * that pays, and the service used here cannot pay with this kind of access either.
 *
 * It runs on Enable Banking (enablebanking.com), an account-information service under PSD2 that covers the European
 * banks. The owner makes an application there once (free for his own accounts: "restricted production"), and gives
 * TeamBot its application ID and private key. Per bank he then gives permission at the bank itself; that permission
 * ends after the period the bank allows (often 180 days) and is then given again.
 *
 * The tools are a built-in MCP server (transport "builtin", like Google), so Apps does the rest: which bot may use
 * it, the call log, the risk per tool.
 */

export const BANK_ID = 'bank';
export const BANK_CALLBACK_PATH = '/api/public/mcp/bank/callback';
const API = 'https://api.enablebanking.com';

/** Tests point TEAMBOT_BANK_BASE at a local stand-in for the service. Loopback only. */
function testBase(): string {
  const b = process.env.TEAMBOT_BANK_BASE || '';
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(b) ? b : '';
}
const net = () => guardedFetch(!!testBase());

// ---------------------------------------------------------------- what is stored

interface BankApp {
  appId: string;
  privateKey: string;
  /** The address the bank sends the owner back to; it must be one of the application's redirect URLs. */
  redirectUrl?: string;
}
export interface BankAccount {
  uid: string;
  iban: string;
  name: string;
  currency: string;
}
/** One permission at one bank. */
export interface BankLink {
  sessionId: string;
  bank: string;
  country: string;
  validUntil: string;
  accounts: BankAccount[];
}

const APP = 'mcp:bank:app';
const linksName = (connId: string) => `mcp:${connId}:bank:links`;

function bankApp(ctx: Ctx, userId: string): BankApp | null {
  try {
    const a = JSON.parse(ctx.secrets.getByName(userId, APP) || 'null');
    return a?.appId && a?.privateKey ? a : null;
  } catch {
    return null;
  }
}

function links(ctx: Ctx, c: ConnectionRow | null): BankLink[] {
  if (!c) return [];
  try {
    const l = JSON.parse(ctx.secrets.getByName(c.user_id, linksName(c.id)) || '[]');
    return Array.isArray(l) ? l : [];
  } catch {
    return [];
  }
}

export function bankConn(ctx: Ctx, userId: string): ConnectionRow | null {
  return ctx.store.find<ConnectionRow>('mcp_connections', { user_id: userId, catalog_id: BANK_ID })[0] || null;
}

/** "NL91ABNA0417164300" → "NL91 •••• 4300": enough to tell accounts apart on a screen. */
export const maskIban = (iban: string) => (iban.length > 8 ? `${iban.slice(0, 4)} •••• ${iban.slice(-4)}` : iban);

// ---------------------------------------------------------------- calling the service

export class BankError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The service's error codes in plain words (what the owner or the bot can do about it). */
function explain(code: string, fallback: string): string {
  if (/^(EXPIRED|REVOKED|CLOSED)_SESSION$|^SESSION_DOES_NOT_EXIST$|^WRONG_SESSION_STATUS$/.test(code)) return 'De toestemming bij de bank is verlopen of ingetrokken. Koppel de bank opnieuw bij Apps › Bank.';
  if (code === 'ASPSP_RATE_LIMIT_EXCEEDED') return 'De bank staat nu geen nieuwe opvraging toe (banken laten dit meestal vier keer per dag toe als je er zelf niet bij bent). Probeer het over een paar uur opnieuw.';
  if (code === 'ASPSP_TIMEOUT' || code === 'ASPSP_ERROR') return 'De bank gaf geen goed antwoord. Probeer het later opnieuw.';
  if (code === 'ASPSP_PSU_ACTION_REQUIRED') return 'De bank wil dat je eerst zelf iets bevestigt (in je bank-app of internetbankieren). Doe dat en probeer het opnieuw.';
  if (code === 'REDIRECT_URI_NOT_ALLOWED') return 'Het terugkeeradres staat niet bij je applicatie. Zet het bij Enable Banking onder je applicatie bij “Redirect URLs”, of vul bij Apps › Bank een adres in dat er wel staat.';
  if (code === 'UNAUTHORIZED_ACCESS' || code === 'UNAUTHORIZED_IP') return 'Enable Banking weigert deze applicatie. Controleer het applicatie-ID en de sleutel, en of de applicatie actief is.';
  if (code === 'NO_ACCOUNTS_ADDED') return 'De bank gaf geen rekeningen door. Bij een applicatie voor eigen gebruik moet je elke rekening eerst koppelen in het Enable Banking-paneel (“Activate by linking accounts”).';
  if (code === 'WRONG_TRANSACTIONS_PERIOD') return 'De bank geeft over deze periode geen mutaties (vaak hooguit 90 dagen terug). Kies een kortere periode.';
  return fallback;
}

/** The token the service asks for: signed with the application's own key, valid for one hour. */
export function bankToken(app: BankApp, at = Date.now()): string {
  const b64 = (v: any) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const iat = Math.floor(at / 1000);
  const body = `${b64({ typ: 'JWT', alg: 'RS256', kid: app.appId })}.${b64({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat, exp: iat + 3600 })}`;
  return `${body}.${crypto.sign('RSA-SHA256', Buffer.from(body), app.privateKey).toString('base64url')}`;
}

type Call = (method: 'GET' | 'POST' | 'DELETE', path: string, opts?: { query?: Record<string, any>; body?: any }) => Promise<any>;

function caller(app: BankApp): Call {
  return async (method, path, opts = {}) => {
    const u = new URL((testBase() || API) + path);
    for (const [k, v] of Object.entries(opts.query || {})) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    let res: Response;
    try {
      res = await net()(u.href, {
        method,
        headers: { authorization: `Bearer ${bankToken(app)}`, ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e: any) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new BankError(504, 'TIMEOUT', 'Geen antwoord binnen een minuut. Probeer het opnieuw.');
      throw e;
    }
    const text = await res.text();
    let j: any = null;
    try {
      j = text ? JSON.parse(text) : {};
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const code = String(j?.error || '');
      throw new BankError(res.status, code, explain(code, String(j?.message || text.slice(0, 300) || `HTTP ${res.status}`).slice(0, 400)));
    }
    return j ?? {};
  };
}

// ---------------------------------------------------------------- reading accounts

const amount = (a: any) => (a && a.amount !== undefined ? { amount: Number(a.amount), currency: String(a.currency || '') } : null);

/** Booked first, then what is available now, then whatever the bank gives. */
const BALANCE_ORDER = ['CLBD', 'ITBD', 'XPCD', 'ITAV', 'CLAV', 'OPBD', 'OPAV'];
const BALANCE_NAME: Record<string, string> = { CLBD: 'geboekt', ITBD: 'geboekt (tussenstand)', XPCD: 'verwacht', ITAV: 'beschikbaar', CLAV: 'beschikbaar', OPBD: 'beginsaldo', OPAV: 'beginsaldo beschikbaar' };

export function tidyBalances(raw: any): { type: string; name: string; amount: number; currency: string; date: string | null }[] {
  const list: any[] = Array.isArray(raw?.balances) ? raw.balances : [];
  const rank = (t: string) => (BALANCE_ORDER.indexOf(t) + 1 || 99);
  return list
    .filter((b) => amount(b?.balance_amount))
    .sort((a, b) => rank(a.balance_type) - rank(b.balance_type))
    .map((b) => ({ type: String(b.balance_type || ''), name: BALANCE_NAME[b.balance_type] || String(b.name || b.balance_type || ''), ...amount(b.balance_amount)!, date: b.reference_date || (b.last_change_date_time ? String(b.last_change_date_time).slice(0, 10) : null) }));
}

/** One transaction as a bot reads it: money in is positive, money out negative, and who the other party is. */
export function tidyTransaction(t: any) {
  const out = t?.credit_debit_indicator === 'DBIT';
  const a = amount(t?.transaction_amount);
  const other = out ? t?.creditor : t?.debtor;
  const otherAccount = out ? t?.creditor_account : t?.debtor_account;
  const text = [...(Array.isArray(t?.remittance_information) ? t.remittance_information : []), t?.note].filter((x) => typeof x === 'string' && x.trim()).join(' ');
  return {
    date: t?.booking_date || t?.value_date || t?.transaction_date || null,
    amount: a ? (out ? -Math.abs(a.amount) : Math.abs(a.amount)) : null,
    currency: a?.currency || '',
    counterparty: String(other?.name || '').slice(0, 140) || null,
    counterparty_iban: otherAccount?.iban || null,
    description: text.replace(/\s+/g, ' ').trim().slice(0, 300),
    status: t?.status === 'BOOK' ? 'geboekt' : t?.status === 'PDNG' ? 'in behandeling' : String(t?.status || ''),
    reference: t?.entry_reference || null,
  };
}

/**
 * Answers are kept for a quarter of an hour: a bank allows only a few reads a day without the owner present, and a
 * team of bots asking the same thing must not use them up.
 */
const cache = new Map<string, { at: number; value: any }>();
const CACHE_MS = 15 * 60_000;
async function cached<T>(key: string, load: () => Promise<T>): Promise<{ value: T; at: number }> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  const fresh = { at: Date.now(), value: await load() };
  cache.set(key, fresh);
  if (cache.size > 200) for (const [k, v] of cache) if (Date.now() - v.at > CACHE_MS) cache.delete(k);
  return fresh;
}
/** Tests, and a new permission at the bank: forget what was read. */
export function clearBankCache() {
  cache.clear();
}

function findAccounts(all: BankLink[], wanted?: string): (BankAccount & { bank: string })[] {
  const flat = all.flatMap((l) => l.accounts.map((a) => ({ ...a, bank: l.bank })));
  const w = String(wanted || '').replace(/\s+/g, '').toLowerCase();
  if (!w) return flat;
  const hit = flat.filter((a) => a.uid.toLowerCase() === w || a.iban.toLowerCase() === w || a.iban.toLowerCase().endsWith(w) || a.name.replace(/\s+/g, '').toLowerCase().includes(w));
  if (!hit.length) throw new Error(`Geen gekoppelde rekening gevonden voor “${wanted}”. Gebruik bank_accounts voor de lijst.`);
  return hit;
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const stamp = (at: number) => new Date(at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

interface BTool {
  name: string;
  title: string;
  description: string;
  input: Record<string, z.ZodTypeAny>;
  run: (a: any, x: { call: Call; links: BankLink[] }) => Promise<any>;
}

export const BANK_TOOLS: BTool[] = [
  {
    name: 'bank_accounts',
    title: 'Bankrekeningen',
    description: 'De gekoppelde bankrekeningen van de eigenaar: bank, naam, IBAN en tot wanneer de toestemming bij de bank geldt.',
    input: {},
    run: async (_a, x) => ({
      accounts: x.links.flatMap((l) => l.accounts.map((a) => ({ bank: l.bank, name: a.name, iban: a.iban, currency: a.currency, toestemming_tot: l.validUntil.slice(0, 10) }))),
    }),
  },
  {
    name: 'bank_balances',
    title: 'Saldo',
    description: 'Het saldo van de gekoppelde bankrekeningen (alle, of één: geef het IBAN, de laatste cijfers ervan of de naam). Antwoorden worden een kwartier bewaard; banken staan maar een paar opvragingen per dag toe.',
    input: { account: z.string().optional().describe('IBAN, de laatste cijfers of de naam van één rekening; leeg = alle rekeningen') },
    run: async (a, x) => {
      const out = [];
      for (const acc of findAccounts(x.links, a.account)) {
        try {
          const r = await cached(`bal:${acc.uid}`, () => x.call('GET', `/accounts/${encodeURIComponent(acc.uid)}/balances`));
          out.push({ bank: acc.bank, name: acc.name, iban: acc.iban, balances: tidyBalances(r.value), stand_van: stamp(r.at) });
        } catch (e: any) {
          out.push({ bank: acc.bank, name: acc.name, iban: acc.iban, error: cleanError(e).slice(0, 300) });
        }
      }
      return { accounts: out };
    },
  },
  {
    name: 'bank_transactions',
    title: 'Mutaties',
    description: 'De af- en bijschrijvingen van één bankrekening over een periode (standaard de laatste 30 dagen; banken geven vaak hooguit 90 dagen terug). Bij is positief, af is negatief. Antwoorden worden een kwartier bewaard.',
    input: {
      account: z.string().describe('IBAN, de laatste cijfers of de naam van de rekening (zie bank_accounts)'),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Vanaf deze dag (JJJJ-MM-DD)'),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Tot en met deze dag (JJJJ-MM-DD)'),
      limit: z.number().int().min(1).max(1000).optional().describe('Hoogstens zoveel mutaties, de nieuwste eerst (standaard 200)'),
    },
    run: async (a, x) => {
      const hits = findAccounts(x.links, a.account);
      if (hits.length > 1) throw new Error(`“${a.account}” past bij meer rekeningen (${hits.map((h) => h.iban).join(', ')}). Geef het IBAN.`);
      const acc = hits[0];
      const to = a.to || day(new Date());
      const from = a.from || day(new Date(Date.parse(to) - 30 * 86400_000));
      const limit = a.limit || 200;
      const r = await cached(`tx:${acc.uid}:${from}:${to}:${limit}`, async () => {
        const list: any[] = [];
        let key: string | undefined;
        // An empty page can still come with a key for the next one; ten pages is far more than a bank gives.
        for (let page = 0; page < 10 && list.length < limit; page++) {
          const p = await x.call('GET', `/accounts/${encodeURIComponent(acc.uid)}/transactions`, { query: { date_from: from, date_to: to, continuation_key: key } });
          list.push(...(Array.isArray(p.transactions) ? p.transactions : []));
          key = p.continuation_key || undefined;
          if (!key) break;
        }
        return { list, more: !!key || list.length > limit };
      });
      const tx = r.value.list.map(tidyTransaction).sort((p, q) => String(q.date || '').localeCompare(String(p.date || ''))).slice(0, limit);
      const sum = (f: (n: number) => boolean) => Math.round(tx.filter((t) => t.amount !== null && f(t.amount)).reduce((s, t) => s + t.amount!, 0) * 100) / 100;
      return { bank: acc.bank, name: acc.name, iban: acc.iban, from, to, count: tx.length, bij: sum((n) => n > 0), af: sum((n) => n < 0), meer_beschikbaar: r.value.more, stand_van: stamp(r.at), transactions: tx };
    },
  },
];

/** The in-process MCP server of the bank connection. Every tool only reads. */
export function bankServer(ctx: Ctx, c: ConnectionRow): McpServer {
  const server = new McpServer({ name: 'Bank', version: ctx.config.version }, { capabilities: { tools: {} } });
  for (const t of BANK_TOOLS) {
    server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: z.object(t.input), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }, async (args: any) => {
      try {
        const conn = getConn(ctx, c.id) || c;
        const app = bankApp(ctx, conn.user_id);
        if (!app) throw new Error('De bank is niet meer gekoppeld (de sleutel ontbreekt). Koppel hem opnieuw bij Apps › Bank.');
        const all = links(ctx, conn).filter((l) => Date.parse(l.validUntil) > Date.now());
        if (!all.length) throw new Error('De toestemming bij de bank is verlopen. Koppel de bank opnieuw bij Apps › Bank.');
        const out = await t.run(args || {}, { call: caller(app), links: all });
        return { content: [{ type: 'text' as const, text: JSON.stringify(out, null, 1) }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `De bank gaf een fout: ${cleanError(e)}` }], isError: true };
      }
    });
  }
  return server;
}

// ---------------------------------------------------------------- setting up and linking a bank

interface Flow {
  userId: string;
  bank: string;
  country: string;
  expires: number;
}
const flows = new Map<string, Flow>();

export interface BankHelpers {
  baseUrl(req: Request): string;
  uniqueSlug(userId: string, wanted: string): string;
  callbackPage(ok: boolean, title: string, body: string, link?: string): string;
  emit(userId: string, c: ConnectionRow | null, id?: string): void;
  view(c: ConnectionRow): any;
  setBindings(userId: string, connId: string, agentIds: string[]): void;
  /** Bots that may use a new connection without asking (the owner's default for new apps). */
  actionsByDefault(userId: string): boolean;
}

function parseApp(body: any): BankApp {
  const appId = str(body?.appId, 80).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(appId)) throw bad('Dit lijkt geen applicatie-ID: het staat bij Enable Banking onder je applicatie en ziet eruit als 1a2b3c4d-1234-5678-9abc-1a2b3c4d5e6f.');
  const privateKey = str(body?.privateKey, 8000).trim();
  try {
    if (crypto.createPrivateKey(privateKey).asymmetricKeyType !== 'rsa') throw new Error('rsa');
  } catch {
    throw bad('Dit is geen geldige sleutel. Plak de hele inhoud van het .pem-bestand dat je bij het aanmaken van de applicatie kreeg, met de regels “-----BEGIN PRIVATE KEY-----” en “-----END PRIVATE KEY-----”.');
  }
  const redirectUrl = str(body?.redirectUrl, 300).trim();
  if (redirectUrl && !/^https?:\/\/\S+$/.test(redirectUrl)) throw bad('Het terugkeeradres moet met http:// of https:// beginnen.');
  return { appId, privateKey, ...(redirectUrl ? { redirectUrl } : {}) };
}

export function registerBank(ctx: Ctx, mgr: McpManager, h: BankHelpers) {
  const api = ctx.api;
  const own = (req: Request) => h.baseUrl(req) + BANK_CALLBACK_PATH;
  const redirect = (req: Request, app: BankApp | null) => app?.redirectUrl || own(req);

  const state = (req: Request) => {
    const u = user(req);
    const c = bankConn(ctx, u.id);
    const app = bankApp(ctx, u.id);
    const all = links(ctx, c);
    return {
      app: app ? { appId: app.appId } : null,
      /** TeamBot's own address, and the one in use (the same unless the owner filled in another registered one). */
      ownRedirectUrl: own(req),
      redirectUrl: redirect(req, app),
      links: all.map((l) => ({ bank: l.bank, country: l.country, validUntil: l.validUntil, expired: Date.parse(l.validUntil) <= Date.now(), accounts: l.accounts.map((a) => ({ name: a.name, iban: maskIban(a.iban), currency: a.currency })) })),
      status: !c || !all.length ? 'off' : all.some((l) => Date.parse(l.validUntil) > Date.now()) ? 'on' : 'expired',
      connection: c ? h.view(c) : null,
    };
  };

  api.get('/mcp/bank', ah(async (req) => state(req)));

  /**
   * The money on the dashboard: per account the balance, and the latest transactions of all accounts together. The
   * same reads the bots' tools make (and the same quarter of an hour of keeping), for the owner himself; here the
   * screen gets masked account numbers.
   */
  api.get(
    '/mcp/bank/overview',
    ah(async (req) => {
      const u = user(req);
      const c = bankConn(ctx, u.id);
      const app = bankApp(ctx, u.id);
      const all = links(ctx, c).filter((l) => Date.parse(l.validUntil) > Date.now());
      if (!c || !app || !all.length) return { status: !links(ctx, c).length ? 'off' : 'expired', accounts: [], transactions: [] };
      const call = caller(app);
      const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
      const to = day(new Date());
      const from = day(new Date(Date.now() - days * 86400_000));
      const accounts = [];
      const transactions: any[] = [];
      for (const acc of findAccounts(all)) {
        const row: any = { bank: acc.bank, name: acc.name, iban: maskIban(acc.iban), currency: acc.currency };
        try {
          const b = await cached(`bal:${acc.uid}`, () => call('GET', `/accounts/${encodeURIComponent(acc.uid)}/balances`));
          row.balances = tidyBalances(b.value);
          row.at = new Date(b.at).toISOString();
        } catch (e: any) {
          row.error = cleanError(e).slice(0, 300);
        }
        try {
          const t = await cached(`tx:${acc.uid}:${from}:${to}:50`, async () => ({ list: (await call('GET', `/accounts/${encodeURIComponent(acc.uid)}/transactions`, { query: { date_from: from, date_to: to } })).transactions || [], more: false }));
          for (const x of (t.value.list as any[]).slice(0, 50)) transactions.push({ ...tidyTransaction(x), account: acc.name, iban: maskIban(acc.iban) });
        } catch (e: any) {
          row.txError = cleanError(e).slice(0, 300);
        }
        accounts.push(row);
      }
      transactions.sort((p, q) => String(q.date || '').localeCompare(String(p.date || '')));
      return { status: 'on', from, to, accounts, transactions: transactions.slice(0, 40) };
    }),
  );

  /** Save the application (checked with one real call), or forget it. */
  api.put(
    '/mcp/bank/app',
    ah(async (req) => {
      const u = user(req);
      if (req.body?.forget === true) {
        for (const s of ctx.secrets.list(u.id)) if (s.name === APP) ctx.secrets.delete(s.id);
        return state(req);
      }
      const app = parseApp(req.body);
      try {
        await caller(app)('GET', '/aspsps', { query: { country: 'NL' } });
      } catch (e: any) {
        throw bad(`Enable Banking nam deze gegevens niet aan: ${cleanError(e).slice(0, 300)}`);
      }
      ctx.secrets.set(u.id, APP, JSON.stringify(app));
      ctx.audit(u.id, 'mcp.bank.app', { appId: app.appId });
      return state(req);
    }),
  );

  /** The banks of a country, to choose from. */
  api.get(
    '/mcp/bank/banks',
    ah(async (req) => {
      const u = user(req);
      const app = bankApp(ctx, u.id);
      if (!app) throw bad('Vul eerst je Enable Banking-applicatie in.');
      const country = str(req.query.country, 2).toUpperCase();
      if (!/^[A-Z]{2}$/.test(country)) throw bad('Kies een land.');
      const r = await cached(`banks:${app.appId}:${country}`, () => caller(app)('GET', '/aspsps', { query: { country } }));
      const list: any[] = Array.isArray(r.value?.aspsps) ? r.value.aspsps : [];
      return { banks: list.map((b) => ({ name: String(b.name), country: String(b.country), logo: typeof b.logo === 'string' ? b.logo : '', business: Array.isArray(b.psu_types) && b.psu_types.includes('business'), personal: !Array.isArray(b.psu_types) || b.psu_types.includes('personal'), days: Math.floor((Number(b.maximum_consent_validity) || 0) / 86400) })) };
    }),
  );

  /** Start giving permission at one bank: returns the address of the bank's own page. */
  api.post(
    '/mcp/bank/link',
    ah(async (req) => {
      const u = user(req);
      const app = bankApp(ctx, u.id);
      if (!app) throw bad('Vul eerst je Enable Banking-applicatie in.');
      const bank = str(req.body?.bank, 120).trim();
      const country = str(req.body?.country, 2).toUpperCase();
      if (!bank || !/^[A-Z]{2}$/.test(country)) throw bad('Kies een bank.');
      const days = Math.min(180, Math.max(1, Math.floor(Number(req.body?.days) || 180)));
      const st = crypto.randomBytes(24).toString('base64url');
      for (const [k, f] of flows) if (f.expires < Date.now()) flows.delete(k);
      flows.set(sha256(st), { userId: u.id, bank, country, expires: Date.now() + 20 * 60_000 });
      let r: any;
      try {
        r = await caller(app)('POST', '/auth', {
          body: { access: { valid_until: new Date(Date.now() + days * 86400_000).toISOString() }, aspsp: { name: bank, country }, state: st, redirect_url: redirect(req, app), psu_type: req.body?.business === true ? 'business' : 'personal', language: 'nl' },
        });
      } catch (e: any) {
        throw bad(cleanError(e).slice(0, 400));
      }
      if (typeof r?.url !== 'string' || !/^https:\/\//.test(r.url)) throw bad('Enable Banking gaf geen adres om toestemming te geven.');
      return { url: r.url, state: st };
    }),
  );

  /** The bank sent the owner back with a code: make it a permission, and the connection when there was none. */
  const finish = async (q: Record<string, any>): Promise<{ ok: true; userId: string; bank: string; accounts: number } | { ok: false; userId?: string; message: string }> => {
    const key = sha256(String(q.state || ''));
    const flow = flows.get(key);
    if (!flow || flow.expires < Date.now()) return { ok: false, message: 'Deze koppeling is verlopen of al gebruikt. Klik in TeamBot opnieuw op “Bank koppelen”.' };
    if (q.error || !q.code) return { ok: false, userId: flow.userId, message: q.error === 'access_denied' ? 'Je hebt bij de bank geen toestemming gegeven. Klik in TeamBot opnieuw op “Bank koppelen” als je dat wel wilt.' : `De bank meldde: ${String(q.error_description || q.error || 'geen code ontvangen').slice(0, 200)}` };
    flows.delete(key);
    const app = bankApp(ctx, flow.userId);
    if (!app) return { ok: false, userId: flow.userId, message: 'De Enable Banking-applicatie ontbreekt.' };
    let s: any;
    try {
      s = await caller(app)('POST', '/sessions', { body: { code: String(q.code) } });
    } catch (e: any) {
      return { ok: false, userId: flow.userId, message: cleanError(e).slice(0, 300) };
    }
    const accounts: BankAccount[] = (Array.isArray(s?.accounts) ? s.accounts : [])
      .filter((a: any) => a?.uid)
      .map((a: any) => ({ uid: String(a.uid), iban: String(a.account_id?.iban || a.all_account_ids?.[0]?.identification || ''), name: String(a.name || a.product || a.details || 'Rekening').slice(0, 80), currency: String(a.currency || 'EUR') }));
    if (!s?.session_id || !accounts.length) return { ok: false, userId: flow.userId, message: explain('NO_ACCOUNTS_ADDED', '') };
    let c = bankConn(ctx, flow.userId);
    const ts = now();
    if (!c) {
      const id = newId('mcp_');
      ctx.store.insert('mcp_connections', {
        id, user_id: flow.userId, catalog_id: BANK_ID, package: null, registry: null, name: 'Bank', label: '', slug: h.uniqueSlug(flow.userId, 'bank'), transport: 'builtin', command: '', args: [], cwd: '', env: [], url: '', headers: [], auth: 'none', oauth: {}, trusted_at: ts, allow_private: false, enabled: true,
        allow_actions: h.actionsByDefault(flow.userId), verified_at: null, verify_result: null, status: 'new', last_error: null, server_info: null, idle_minutes: 10, timeout_sec: 90, created_at: ts, updated_at: ts,
      } as ConnectionRow);
      c = getConn(ctx, id)!;
      // As with every app: "gekoppeld" means the bots can use it (reading only); narrowing per bot is one click away.
      h.setBindings(flow.userId, id, ctx.store.agents(flow.userId).map((a) => a.id));
      ctx.audit(flow.userId, 'mcp.connection.created', { id, name: 'Bank', transport: 'builtin', catalog: BANK_ID });
    }
    const link: BankLink = { sessionId: String(s.session_id), bank: String(s.aspsp?.name || flow.bank), country: String(s.aspsp?.country || flow.country), validUntil: String(s.access?.valid_until || new Date(Date.now() + 90 * 86400_000).toISOString()), accounts };
    // A new permission at the same bank replaces the old one.
    const rest = links(ctx, c).filter((l) => !(l.bank === link.bank && l.country === link.country));
    ctx.secrets.set(flow.userId, linksName(c.id), JSON.stringify([...rest, link]));
    clearBankCache();
    patchOAuth(ctx, c.id, { status: 'connected', connected_at: ts } as any);
    ctx.store.update('mcp_connections', c.id, { status: 'authorized', last_error: null, updated_at: ts });
    await mgr.stop(c.id, 'bank gekoppeld').catch(() => {});
    try {
      const client = await mgr.client(getConn(ctx, c.id)!, { force: true });
      mgr.syncTools(c.id, (await client.listTools()).tools || []);
      ctx.store.exec('UPDATE mcp_tools SET approved = 1, changed = 0 WHERE connection_id = ? AND present = 1', c.id);
      ctx.store.update('mcp_connections', c.id, { verified_at: ts, verify_result: { ok: true, at: ts }, updated_at: ts });
    } catch (e: any) {
      ctx.log.warn('[mcp] bank tools not listed', e?.message || e);
    }
    ctx.audit(flow.userId, 'mcp.bank.linked', { bank: link.bank, country: link.country, accounts: accounts.length });
    h.emit(flow.userId, getConn(ctx, c.id)!);
    ctx.events.emit(flow.userId, 'mcp.oauth', { id: c.id, bank: true, ok: true });
    return { ok: true, userId: flow.userId, bank: link.bank, accounts: accounts.length };
  };

  ctx.publicApi.get(
    BANK_CALLBACK_PATH.replace('/api/public', ''),
    ah(async (req, res) => {
      res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
      res.setHeader('cache-control', 'no-store');
      const r = await finish(req.query as Record<string, any>);
      if (!r.ok) {
        if (r.userId) ctx.events.emit(r.userId, 'mcp.oauth', { id: BANK_ID, bank: true, ok: false, error: r.message });
        return void res.status(400).type('html').send(h.callbackPage(false, 'Bank koppelen mislukt', r.message, '/#/m/mcp/'));
      }
      res.type('html').send(h.callbackPage(true, `${r.bank} is gekoppeld`, 'Je rekeningen zijn gekoppeld. Je bots kunnen het saldo en de mutaties nu lezen. Ga terug naar TeamBot.', '/#/m/mcp/'));
    }),
  );

  /**
   * The bank sent the owner to another registered address than TeamBot's own (an application made earlier, for another
   * program): he pastes the address he ended up on, and TeamBot takes the code from it.
   */
  api.post(
    '/mcp/bank/finish',
    ah(async (req) => {
      const u = user(req);
      let q: Record<string, any>;
      try {
        q = Object.fromEntries(new URL(str(req.body?.url, 4000).trim()).searchParams);
      } catch {
        throw bad('Plak het hele adres uit de adresbalk van de pagina waar de bank je naartoe stuurde (het begint met http).');
      }
      const r = await finish(q);
      if (!r.ok || r.userId !== u.id) throw bad(r.ok ? 'Dit adres hoort niet bij jouw koppeling.' : r.message);
      return state(req);
    }),
  );

  /** Take one bank away: the permission is ended at the bank too, when the service can. */
  api.post(
    '/mcp/bank/unlink',
    ah(async (req) => {
      const u = user(req);
      const c = bankConn(ctx, u.id);
      if (!c) throw bad('Er is geen bank gekoppeld.');
      const bank = str(req.body?.bank, 120);
      const country = str(req.body?.country, 2).toUpperCase();
      const all = links(ctx, c);
      const gone = all.filter((l) => l.bank === bank && l.country === country);
      const app = bankApp(ctx, u.id);
      for (const l of gone) if (app) await caller(app)('DELETE', `/sessions/${encodeURIComponent(l.sessionId)}`).catch(() => {});
      ctx.secrets.set(u.id, linksName(c.id), JSON.stringify(all.filter((l) => !gone.includes(l))));
      clearBankCache();
      ctx.audit(u.id, 'mcp.bank.unlinked', { bank, country });
      h.emit(u.id, getConn(ctx, c.id)!);
      return state(req);
    }),
  );
}

/** Removing the connection: end every permission at the banks. */
export async function revokeBank(ctx: Ctx, c: ConnectionRow): Promise<{ revokedAtService: boolean; detail: string }> {
  const app = bankApp(ctx, c.user_id);
  const all = links(ctx, c);
  if (!app || !all.length) return { revokedAtService: false, detail: '' };
  const done = await Promise.all(all.map((l) => caller(app)('DELETE', `/sessions/${encodeURIComponent(l.sessionId)}`).then(() => true, () => false)));
  clearBankCache();
  return done.every(Boolean) ? { revokedAtService: true, detail: 'De toestemming is ook bij de bank beëindigd.' } : { revokedAtService: false, detail: 'De toestemming kon niet bij elke bank worden beëindigd; hij loopt daar vanzelf af, of trek hem in bij je bank.' };
}
