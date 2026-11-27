import crypto from 'node:crypto';
import { aboutMoney } from '../botrules/money.js';
import type { Request } from 'express';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Ctx } from '../../core/types.js';
import { newId, now } from '../../core/db.js';
import { ah, bad, str, user } from '../../core/http.js';
import type { ConnectionRow } from './db.js';
import type { McpManager } from './runtime.js';
import { AuthRequiredError, getConn, patchOAuth } from './oauth.js';
import { teambotApp } from './teambot-apps.js';
import { cleanError, guardedFetch, sha256 } from './util.js';
import { actionsByDefault } from './defaults.js';

/**
 * Google in one go (0.4.4): one login gives the bots Search Console, Merchant Center, Google Ads, Analytics, Gmail,
 * Agenda and Drive. TeamBot talks to Google's own REST APIs itself, in this process: no Python, no Node, no gcloud,
 * no preview programme and no service in between. The login is OAuth for installed apps (authorization code + PKCE,
 * redirect to TeamBot on this computer); tokens are stored encrypted in the vault and never shown.
 *
 * The tools are offered as a built-in MCP server (transport "builtin", see runtime.ts), so everything Apps already
 * does applies unchanged: per-bot access, read-only until the owner allows actions, risk per tool, the call log.
 */

export const GOOGLE_ID = 'google';
export const GOOGLE_CALLBACK_PATH = '/api/public/mcp/google/callback';
const S = 'https://www.googleapis.com/auth/';
/** Google Ads API version (v26: October 2026). Google retires a version about a year after its release. */
const ADS = 'v26';

export interface GoogleService {
  id: string;
  name: string;
  line: string;
  scopes: string[];
  /** API names to switch on in the Google Cloud project of the OAuth client. */
  apis: string[];
}

export const GOOGLE_SERVICES: GoogleService[] = [
  { id: 'searchconsole', name: 'Search Console', line: 'Zoekwoorden, posities en indexering', scopes: [S + 'webmasters.readonly', S + 'webmasters'], apis: ['searchconsole.googleapis.com'] },
  { id: 'merchant', name: 'Merchant Center', line: 'Producten, afkeuringen en prestaties', scopes: [S + 'content'], apis: ['merchantapi.googleapis.com'] },
  { id: 'ads', name: 'Google Ads', line: 'Campagnes, zoekwoorden en kosten', scopes: [S + 'adwords'], apis: ['googleads.googleapis.com'] },
  { id: 'analytics', name: 'Analytics', line: 'Bezoekers en conversies', scopes: [S + 'analytics.readonly', S + 'analytics.edit'], apis: ['analyticsdata.googleapis.com', 'analyticsadmin.googleapis.com'] },
  { id: 'tagmanager', name: 'Tag Manager', line: 'Tags, triggers en variabelen van je containers', scopes: [S + 'tagmanager.readonly'], apis: ['tagmanager.googleapis.com'] },
  { id: 'gmail', name: 'Gmail', line: 'Mail lezen, concepten maken en versturen', scopes: [S + 'gmail.readonly', S + 'gmail.compose'], apis: ['gmail.googleapis.com'] },
  { id: 'calendar', name: 'Agenda', line: 'Afspraken lezen en maken', scopes: [S + 'calendar.events'], apis: ['calendar-json.googleapis.com'] },
  { id: 'drive', name: 'Drive', line: 'Bestanden zoeken en lezen', scopes: [S + 'drive.readonly'], apis: ['drive.googleapis.com'] },
];
const serviceIds = (list: unknown): string[] => {
  const want = Array.isArray(list) ? list.map(String) : [];
  const ids = GOOGLE_SERVICES.map((s) => s.id).filter((id) => want.includes(id));
  return ids.length ? ids : GOOGLE_SERVICES.map((s) => s.id);
};

// ---------------------------------------------------------------- endpoints (a local stand-in for tests)

/** Tests point TEAMBOT_GOOGLE_BASE at a local stand-in: https://host/path becomes <base>/host/path. Loopback only. */
function testBase(): string {
  const b = process.env.TEAMBOT_GOOGLE_BASE || '';
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(b) ? b : '';
}
const at = (url: string) => (testBase() ? `${testBase()}/${url.replace(/^https:\/\//, '')}` : url);
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const net = () => guardedFetch(!!testBase());

// ---------------------------------------------------------------- OAuth client and tokens

interface GClient {
  id: string;
  secret: string;
  source: 'teambot' | 'own';
}
const OWN_CLIENT = 'mcp:google:client';

export function googleClient(ctx: Ctx, userId: string): GClient | null {
  try {
    const own = JSON.parse(ctx.secrets.getByName(userId, OWN_CLIENT) || 'null');
    if (own?.id) return { id: own.id, secret: own.secret || '', source: 'own' };
  } catch {
    /* unreadable: treated as absent */
  }
  const app = teambotApp('google');
  return app ? { id: app.clientId, secret: app.clientSecret, source: 'teambot' } : null;
}

/** An own client: the pasted JSON file from Google Cloud ("installed" or "web"), or the ID and secret typed in. */
function parseClient(b: any): { id: string; secret: string } {
  let id = str(b?.client_id, 300).trim();
  let secret = str(b?.client_secret, 2000).trim();
  const raw = str(b?.json, 20_000).trim();
  if (raw) {
    let j: any;
    try {
      j = JSON.parse(raw);
    } catch {
      // Not JSON: maybe only the client ID was pasted.
      id = id || raw;
    }
    const c = j?.installed || j?.web || j;
    if (c?.client_id) {
      id = String(c.client_id);
      secret = String(c.client_secret || '');
    }
  }
  if (!/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(id)) throw bad('Dit is geen Google-client. Plak het JSON-bestand dat je bij “Download JSON” kreeg, of de client-ID die eindigt op .apps.googleusercontent.com.');
  if (!secret) throw bad('Het clientgeheim ontbreekt. Plak het hele JSON-bestand van “Download JSON”.');
  return { id, secret };
}

interface GTokens {
  refresh_token?: string;
  access_token?: string;
  expires_at?: number;
}
const tokenName = (connId: string) => `mcp:${connId}:oauth:tokens`;
const adsName = (connId: string) => `mcp:${connId}:google:ads`;
function tokens(ctx: Ctx, c: ConnectionRow): GTokens {
  try {
    return JSON.parse(ctx.secrets.getByName(c.user_id, tokenName(c.id)) || '{}');
  } catch {
    return {};
  }
}

async function tokenRequest(body: Record<string, string>): Promise<any> {
  const res = await net()(at(TOKEN_URL), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(), signal: AbortSignal.timeout(20_000) });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.error_description || j.error || `Google gaf HTTP ${res.status}`), { code: j.error });
  return j;
}

/** A valid access token; refreshed when (nearly) expired. A revoked login marks the connection "opnieuw inloggen". */
async function accessToken(ctx: Ctx, mgr: McpManager, c: ConnectionRow, force = false): Promise<string> {
  const t = tokens(ctx, c);
  if (!force && t.access_token && (t.expires_at || 0) > Date.now() + 60_000) return t.access_token;
  const client = googleClient(ctx, c.user_id);
  if (!t.refresh_token || !client) throw new AuthRequiredError('Google: log opnieuw in (Apps › Google).');
  try {
    const j = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: client.id, client_secret: client.secret });
    ctx.secrets.set(c.user_id, tokenName(c.id), JSON.stringify({ ...t, access_token: j.access_token, expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000 }));
    return j.access_token;
  } catch (e: any) {
    if (e.code === 'invalid_grant' || e.code === 'invalid_client' || e.code === 'unauthorized_client') {
      mgr.markAuthRequired(c.id);
      throw new AuthRequiredError('Google: de toegang is verlopen of ingetrokken. Log opnieuw in (Apps › Google).');
    }
    throw e;
  }
}

// ---------------------------------------------------------------- calling Google

class GoogleError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Where the owner switches this API on in his Google Cloud project. */
    public fixUrl?: string,
  ) {
    super(message);
  }
}

/** How long to wait before each new try after "too many requests per minute" (three tries, under a minute in all). */
let retryWaits = [5_000, 15_000, 30_000];
/** Tests: shorter waits. */
export function setGoogleRetryWaits(ms: number[] | null) {
  retryWaits = ms || [5_000, 15_000, 30_000];
}

/** A limit per minute or per second (429, or Google's older 403 with the same meaning); never a limit per day. */
export function tooFast(status: number, body: string): boolean {
  if (status !== 429 && status !== 403) return false;
  if (/per day|daily|dailyLimit/i.test(body)) return false;
  return status === 429 ? true : /per minute|per second|rateLimitExceeded|userRateLimitExceeded|RATE_LIMIT_EXCEEDED/i.test(body);
}

/** `timeoutMs`: for a call Google itself takes long over (inspecting a URL: often 10 s, sometimes over 40 s); default 45 s. */
type Call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, opts?: { query?: Record<string, any>; body?: any; headers?: Record<string, string>; raw?: boolean; timeoutMs?: number }) => Promise<any>;

function caller(ctx: Ctx, mgr: McpManager, connId: string): Call {
  return async (method, url, opts = {}) => {
    const c = getConn(ctx, connId);
    if (!c) throw new Error('Google is ontkoppeld.');
    const u = new URL(at(url));
    for (const [k, v] of Object.entries(opts.query || {})) {
      if (v === undefined || v === null || v === '') continue;
      for (const x of Array.isArray(v) ? v : [v]) u.searchParams.append(k, String(x));
    }
    const limit = opts.timeoutMs || 45_000;
    const once = async (force: boolean) => {
      try {
        return await net()(u.href, {
          method,
          headers: { authorization: `Bearer ${await accessToken(ctx, mgr, c, force)}`, ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(limit),
        });
      } catch (e: any) {
        // Not an error Google gave: it gave no answer at all. Say so, so the bot tries again instead of concluding.
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new GoogleError(504, `geen antwoord binnen ${Math.round(limit / 1000)} seconden. Probeer het opnieuw.`);
        throw e;
      }
    };
    let res = await once(false);
    if (res.status === 401) res = await once(true);
    let text = await res.text();
    // Too many requests in a minute (a bot that searches a mailbox in a burst): Google did nothing with the request, so
    // wait and send it again instead of handing the bot an error. A daily limit is not waited for.
    for (const wait of retryWaits) {
      if (!tooFast(res.status, text)) break;
      const after = Number(res.headers.get('retry-after')) * 1000;
      await new Promise((r) => setTimeout(r, after > 0 && after <= 60_000 ? after : wait));
      res = await once(false);
      text = await res.text();
    }
    if (!res.ok) {
      let j: any = null;
      try {
        j = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      const err = Array.isArray(j) ? j[0]?.error : j?.error;
      const details: any[] = Array.isArray(err?.details) ? err.details : [];
      const fixUrl = details.map((d) => d?.metadata?.activationUrl).find(Boolean) || (/has not been used in project|is disabled/i.test(err?.message || '') ? (String(err.message).match(/https:\/\/console\.developers\.google\.com\/\S+?(?=[\s"]|$)/)?.[0] ?? undefined) : undefined);
      const ads = details.flatMap((d) => d?.errors || []).map((e: any) => e?.message).filter(Boolean)[0];
      throw new GoogleError(res.status, String(ads || err?.message || text.slice(0, 300) || `HTTP ${res.status}`).slice(0, 600), fixUrl);
    }
    if (opts.raw) return text;
    return text ? JSON.parse(text) : {};
  };
}

// ---------------------------------------------------------------- tools

interface GTool {
  name: string;
  service: string;
  title: string;
  description: string;
  input: Record<string, z.ZodTypeAny>;
  /** read: no change; write: makes something (a draft, an appointment); send: goes to other people. */
  kind: 'read' | 'write' | 'send';
  /** The Google scope the tool needs when that is not the service's first one (Gmail: compose for drafts and sending). */
  scope?: string;
  run(a: any, g: Call, x: { ctx: Ctx; conn: ConnectionRow }): Promise<any>;
}

/**
 * Google lets the owner tick each right separately (all unticked at first). A service is on when one of its rights was
 * given, and a tool only when its own right was given, so "only reading mail" works and sending simply is not offered.
 */
function grantedServices(asked: string[], scope: string): string[] {
  const granted = scope.split(/\s+/);
  return asked.filter((id) => !scope || GOOGLE_SERVICES.find((s) => s.id === id)!.scopes.some((sc) => granted.includes(sc)));
}
function toolGranted(t: GTool, scope: string): boolean {
  return !scope || scope.split(/\s+/).includes(t.scope || GOOGLE_SERVICES.find((s) => s.id === t.service)!.scopes[0]);
}

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const header = (m: any, name: string) => (m?.payload?.headers || []).find((h: any) => String(h.name).toLowerCase() === name)?.value || '';

function mailBody(part: any): string {
  if (!part) return '';
  const data = part.body?.data ? Buffer.from(part.body.data, 'base64url').toString('utf8') : '';
  if (part.mimeType === 'text/plain' && data) return data;
  const kids: any[] = part.parts || [];
  const plain = kids.map(mailBody).find((x) => x);
  if (plain) return plain;
  if (part.mimeType === 'text/html' && data) return data.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return '';
}

function rfc822(a: { to: string; subject: string; body: string; cc?: string; inReplyTo?: string }) {
  const clean = (s: string) => String(s || '').replace(/[\r\n]+/g, ' ').trim();
  const lines = [`To: ${clean(a.to)}`, ...(a.cc ? [`Cc: ${clean(a.cc)}`] : []), `Subject: =?UTF-8?B?${Buffer.from(clean(a.subject)).toString('base64')}?=`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64'];
  if (a.inReplyTo) lines.push(`In-Reply-To: ${clean(a.inReplyTo)}`, `References: ${clean(a.inReplyTo)}`);
  return b64url(`${lines.join('\r\n')}\r\n\r\n${Buffer.from(String(a.body || '')).toString('base64').replace(/(.{76})/g, '$1\r\n')}`);
}

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL = 'https://www.googleapis.com/calendar/v3';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const GSC = 'https://www.googleapis.com/webmasters/v3';
const MERCHANT = 'https://merchantapi.googleapis.com';
const ADS_URL = `https://googleads.googleapis.com/${ADS}`;
const GTM = 'https://tagmanager.googleapis.com/tagmanager/v2';
/** A mail with the same subject to the same person within this time is the same mail (gmail_send). */
const SAME_MAIL_MS = 30 * 60_000;
const site = z.string().describe('De site zoals in Search Console, bijv. "https://www.voorbeeld.nl/" of "sc-domain:voorbeeld.nl" (zie gsc_sites)');
const account = z.string().regex(/^\d+$/).describe('Merchant Center-account-ID, alleen cijfers (zie merchant_accounts)');

const adsCustomer = z.string().describe('Klant-ID, 10 cijfers; streepjes mogen (zie ads_customers)');
const adsId = (c: string) => String(c || '').replace(/\D/g, '');
/** "123" or "customers/1234567890/campaigns/123": the full resource name. */
function adsResource(customer: string, kind: string, id: string): string {
  const s = String(id || '').trim();
  if (/^customers\/\d+\//.test(s)) return s;
  if (!/^\d+$/.test(s)) throw new Error(`Geef het ID als cijfers of als resourceName (customers/…/${kind}/…).`);
  return `customers/${adsId(customer)}/${kind}/${s}`;
}
async function adsMutate(g: Call, x: { ctx: Ctx; conn: ConnectionRow }, customer: string, operations: any[], o: { validateOnly?: boolean; partialFailure?: boolean } = {}) {
  const id = adsId(customer);
  if (id.length !== 10) throw new Error('Het klant-ID heeft 10 cijfers (zie ads_customers).');
  // The examples write "customers/C/"; Google needs the real customer id there.
  const ops = JSON.parse(JSON.stringify(operations).replace(/customers\/C\//g, `customers/${id}/`));
  return g('POST', `${ADS_URL}/customers/${id}/googleAds:mutate`, {
    body: { mutateOperations: ops, ...(o.partialFailure ? { partialFailure: true } : {}), ...(o.validateOnly ? { validateOnly: true } : {}) },
    headers: adsHeaders(x),
    timeoutMs: 90_000,
  });
}

/**
 * What a change in Google Ads does to the owner's money. Spending less (pausing, removing, excluding search terms) is an
 * outward step like any other; anything that can spend more (a budget, a bid, switching something on, a new campaign,
 * keyword or ad) is a payment, which asks the owner on every access level (broker.ts).
 */
export function adsImpact(tool: string, args: any): 'external' | 'payment' {
  const a = args || {};
  if (tool === 'ads_campaign_status') return a.status === 'PAUSED' ? 'external' : 'payment';
  if (tool === 'ads_negatives_add') return 'external';
  if (tool !== 'ads_mutate') return 'payment';
  const ops: any[] = Array.isArray(a.operations) ? a.operations : [];
  if (!ops.length) return 'payment';
  const lowers = (op: any) => {
    const entries = Object.entries(op || {});
    if (entries.length !== 1) return false;
    const [kind, b] = entries[0] as [string, any];
    if (!b || typeof b !== 'object') return false;
    if (b.remove && !b.create && !b.update) return true;
    const mask = String(b.updateMask || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (b.update && mask.length && mask.every((m) => m === 'status') && ['PAUSED', 'REMOVED'].includes(b.update.status)) return true;
    if (b.create && b.create.negative === true && /CriterionOperation$/.test(kind)) return true;
    return false;
  };
  return ops.every(lowers) ? 'external' : 'payment';
}

function adsHeaders(x: { ctx: Ctx; conn: ConnectionRow }): Record<string, string> {
  // Google no longer requires a developer token for the Ads API (the API Center says so since 2026: access levels live
  // in the Google Cloud project). One that was saved is still sent; should Google ask for one after all, its error names
  // the developer token and Apps › Google shows the field for it (needsToken).
  const token = x.ctx.secrets.getByName(x.conn.user_id, adsName(x.conn.id));
  const login = String((x.conn.oauth as any)?.ads_login || '').replace(/\D/g, '');
  return { ...(token ? { 'developer-token': token } : {}), ...(login ? { 'login-customer-id': login } : {}) };
}

/** Merchant API: the Google Cloud project of the client must be registered with the account once; TeamBot does it. */
async function merchant(g: Call, x: { conn: ConnectionRow }, acc: string, fn: () => Promise<any>) {
  try {
    return await fn();
  } catch (e: any) {
    if (!(e instanceof GoogleError) || !/not registered|register.*gcp|developer registration/i.test(e.message)) throw e;
    await g('POST', `${MERCHANT}/accounts/v1/accounts/${acc}/developerRegistration:registerGcp`, { body: { developerEmail: (x.conn.oauth as any)?.email || '' } });
    return fn();
  }
}

/** What already lies with the person a mail goes to: sent, received and drafts of the last two months, newest first. */
type Earlier = { what: 'verstuurd' | 'ontvangen' | 'concept'; date: string; subject: string; thread: string; id: string };
async function earlierWith(g: Call, to: string): Promise<Earlier[]> {
  const addr = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(String(to || ''))?.[0];
  if (!addr) return [];
  try {
    const list = await g('GET', `${GMAIL}/messages`, { query: { q: `(to:${addr} OR from:${addr}) newer_than:60d`, maxResults: 6 } });
    const rows = await Promise.all(((list.messages || []) as any[]).map((m) => g('GET', `${GMAIL}/messages/${m.id}`, { query: { format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] } })));
    return rows.map((m) => {
      const labels: string[] = m.labelIds || [];
      return { what: labels.includes('DRAFT') ? 'concept' : labels.includes('SENT') ? 'verstuurd' : 'ontvangen', date: header(m, 'date'), subject: header(m, 'subject'), thread: m.threadId, id: m.id } as Earlier;
    });
  } catch {
    // Looking back is a help, never a reason not to write: without it the mail goes as before.
    return [];
  }
}

/** The line a bot reads with what it just wrote: look at what was there, and tidy up what this replaces. */
function earlierNote(rows: Earlier[], sent: boolean): string | undefined {
  if (!rows.length) return undefined;
  const drafts = rows.filter((r) => r.what === 'concept').length;
  return [
    `Met deze ontvanger is al gemaild (zie “eerder”, nieuwste eerst).`,
    sent ? 'Klopt je bericht daar niet mee, zeg dat dan in je antwoord, zodat het rechtgezet kan worden.' : 'Sluit je concept daarop aan: verwijs alleen naar wat echt verstuurd is.',
    // One whole sentence per form, never a fragment as a value.
    drafts === 1 ? 'Er staat nog 1 ouder concept aan deze ontvanger: haal het weg als het hierdoor vervalt (gmail_drafts, gmail_draft_delete).' : drafts ? `Er staan nog ${drafts} oudere concepten aan deze ontvanger: haal weg wat hierdoor vervalt (gmail_drafts, gmail_draft_delete).` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

const norm = (v: string) => String(v || '').replace(/^\s*((re|fw|fwd|aw|antw)\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * A report on product_view must select the product's id (or a count); Google refuses it otherwise ("is expected to
 * have any of ['product_view.id', PRODUCTS_COUNT] fields"). A bot that asks for titles or issues forgets that, so the
 * id is added: the rows are the same, with one field more.
 */
export function merchantQuery(query: string): string {
  const q = String(query || '');
  const m = /^(\s*SELECT\s+)([\s\S]+?)(\s+FROM\s+product_view\b)/i.exec(q);
  if (!m || /(^|[\s,])(product_view\.)?id\s*(,|$)/i.test(m[2].trim()) || /count/i.test(m[2])) return q;
  return `${m[1]}id, ${m[2]}${m[3]}${q.slice(m[0].length)}`;
}

export const GOOGLE_TOOLS: GTool[] = [
  // ---- Search Console
  { name: 'gsc_sites', service: 'searchconsole', title: 'Sites in Search Console', kind: 'read', description: 'Toon de sites (properties) in Google Search Console waar dit account bij kan.', input: {}, run: (_a, g) => g('GET', `${GSC}/sites`) },
  {
    name: 'gsc_search_analytics',
    service: 'searchconsole',
    title: 'Zoekprestaties',
    kind: 'read',
    description: 'Klikken, vertoningen, CTR en positie uit Google Search Console, per zoekwoord, pagina, land, apparaat of datum. Standaard de laatste 28 dagen.',
    input: {
      site,
      start: z.string().optional().describe('Begindatum JJJJ-MM-DD (standaard 28 dagen terug)'),
      end: z.string().optional().describe('Einddatum JJJJ-MM-DD (standaard eergisteren)'),
      dimensions: z.array(z.enum(['query', 'page', 'country', 'device', 'date', 'searchAppearance'])).optional().describe('Standaard ["query"]'),
      filters: z.array(z.object({ dimension: z.enum(['query', 'page', 'country', 'device']), operator: z.enum(['contains', 'equals', 'notContains', 'notEquals', 'includingRegex', 'excludingRegex']), expression: z.string() })).optional(),
      type: z.enum(['web', 'image', 'video', 'news', 'discover', 'googleNews']).optional(),
      limit: z.number().int().min(1).max(5000).optional().describe('Aantal rijen (standaard 100)'),
    },
    run: (a, g) =>
      g('POST', `${GSC}/sites/${encodeURIComponent(a.site)}/searchAnalytics/query`, {
        body: { startDate: a.start || day(-30), endDate: a.end || day(-2), dimensions: a.dimensions || ['query'], type: a.type, rowLimit: a.limit || 100, ...(a.filters?.length ? { dimensionFilterGroups: [{ filters: a.filters }] } : {}) },
      }),
  },
  { name: 'gsc_inspect_url', service: 'searchconsole', title: 'URL inspecteren', kind: 'read', description: 'Hoe Google één pagina ziet: geïndexeerd of niet, laatste crawl, canonieke URL, mobiel en rich results.', input: { site, url: z.string().url() }, run: (a, g) => g('POST', 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', { body: { inspectionUrl: a.url, siteUrl: a.site, languageCode: 'nl-NL' }, timeoutMs: 120_000 }) },
  { name: 'gsc_sitemaps', service: 'searchconsole', title: 'Sitemaps', kind: 'read', description: 'De ingediende sitemaps van een site, met fouten en waarschuwingen.', input: { site }, run: (a, g) => g('GET', `${GSC}/sites/${encodeURIComponent(a.site)}/sitemaps`) },
  {
    name: 'gsc_sitemap_submit',
    service: 'searchconsole',
    title: 'Sitemap indienen',
    kind: 'write',
    scope: S + 'webmasters',
    description: 'Dien een sitemap (opnieuw) in bij Google Search Console, bijvoorbeeld na nieuwe of gewijzigde pagina’s. Geef de site zoals gsc_sites hem noemt en het volledige adres van de sitemap.',
    input: { site, sitemap: z.string().url() },
    run: async (a, g) => {
      await g('PUT', `${GSC}/sites/${encodeURIComponent(a.site)}/sitemaps/${encodeURIComponent(a.sitemap)}`);
      return { ingediend: a.sitemap, site: a.site };
    },
  },
  {
    name: 'gsc_sitemap_delete',
    service: 'searchconsole',
    title: 'Sitemap verwijderen',
    kind: 'send',
    scope: S + 'webmasters',
    description: 'Haal een ingediende sitemap weg uit Search Console (de sitemap zelf op de website blijft staan).',
    input: { site, sitemap: z.string().url() },
    run: async (a, g) => {
      await g('DELETE', `${GSC}/sites/${encodeURIComponent(a.site)}/sitemaps/${encodeURIComponent(a.sitemap)}`);
      return { verwijderd: a.sitemap, site: a.site };
    },
  },
  {
    name: 'gsc_site_add',
    service: 'searchconsole',
    title: 'Site toevoegen',
    kind: 'write',
    scope: S + 'webmasters',
    description: 'Voeg een site toe aan Search Console ("https://www.voorbeeld.nl/" of "sc-domain:voorbeeld.nl"). Daarna moet het eigendom nog bevestigd worden (DNS of een bestand op de site) voordat er gegevens komen.',
    input: { site },
    run: async (a, g) => {
      await g('PUT', `${GSC}/sites/${encodeURIComponent(a.site)}`);
      return { toegevoegd: a.site };
    },
  },
  {
    name: 'gsc_site_delete',
    service: 'searchconsole',
    title: 'Site weghalen',
    kind: 'send',
    scope: S + 'webmasters',
    description: 'Haal een site weg uit de lijst van dit Google-account in Search Console. De gegevens bij Google blijven; opnieuw toevoegen kan.',
    input: { site },
    run: async (a, g) => {
      await g('DELETE', `${GSC}/sites/${encodeURIComponent(a.site)}`);
      return { weggehaald: a.site };
    },
  },
  // ---- Merchant Center
  { name: 'merchant_accounts', service: 'merchant', title: 'Merchant Center-accounts', kind: 'read', description: 'Toon de Merchant Center-accounts waar dit Google-account bij kan.', input: {}, run: (_a, g) => g('GET', `${MERCHANT}/accounts/v1/accounts`) },
  {
    name: 'merchant_products',
    service: 'merchant',
    title: 'Producten',
    kind: 'read',
    description: 'De producten in Merchant Center met prijs, voorraad en status per bestemming (goedgekeurd, afgekeurd, met de reden).',
    input: { account, limit: z.number().int().min(1).max(250).optional().describe('Aantal per pagina (standaard 50)'), pageToken: z.string().optional() },
    run: (a, g, x) => merchant(g, x, a.account, () => g('GET', `${MERCHANT}/products/v1/accounts/${a.account}/products`, { query: { pageSize: a.limit || 50, pageToken: a.pageToken } })),
  },
  {
    name: 'merchant_report',
    service: 'merchant',
    title: 'Rapport (Merchant Center)',
    kind: 'read',
    description:
      'Een rapport uit Merchant Center met de querytaal van de Merchant API. Voorbeelden: "SELECT offer_id, title, clicks, impressions FROM product_performance_view WHERE date BETWEEN \'2026-10-01\' AND \'2026-10-31\'" of "SELECT id, offer_id, title, aggregated_reporting_context_status, item_issues FROM product_view WHERE aggregated_reporting_context_status = \'NOT_ELIGIBLE_OR_DISAPPROVED\'".',
    input: { account, query: z.string().min(10), limit: z.number().int().min(1).max(1000).optional() },
    run: (a, g, x) => merchant(g, x, a.account, () => g('POST', `${MERCHANT}/reports/v1/accounts/${a.account}/reports:search`, { body: { query: merchantQuery(a.query), pageSize: a.limit || 200 } })),
  },
  // ---- Google Ads
  { name: 'ads_customers', service: 'ads', title: 'Google Ads-accounts', kind: 'read', description: 'Toon de Google Ads-accounts (klant-ID’s) waar dit Google-account direct bij kan.', input: {}, run: (_a, g, x) => g('GET', `${ADS_URL}/customers:listAccessibleCustomers`, { headers: adsHeaders(x) }) },
  {
    name: 'ads_query',
    service: 'ads',
    title: 'Google Ads opvragen',
    kind: 'read',
    description:
      'Vraag gegevens op uit Google Ads met GAQL (alleen lezen). Voorbeeld: "SELECT campaign.name, metrics.clicks, metrics.impressions, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date DURING LAST_30_DAYS ORDER BY metrics.cost_micros DESC". Bedragen zijn in micro’s (1.000.000 = 1 euro).',
    input: {
      customer: adsCustomer,
      query: z.string().min(10).describe('GAQL-query die met SELECT begint'),
      pageToken: z.string().optional().describe('nextPageToken uit het vorige antwoord, voor de volgende pagina'),
    },
    run: (a, g, x) => {
      if (!/^\s*select\b/i.test(a.query)) throw new Error('Alleen SELECT-query’s (lezen).');
      return g('POST', `${ADS_URL}/customers/${adsId(a.customer)}/googleAds:search`, { body: { query: a.query, ...(a.pageToken ? { pageToken: a.pageToken } : {}) }, headers: adsHeaders(x) });
    },
  },
  {
    name: 'ads_preview',
    service: 'ads',
    title: 'Google Ads-wijziging proberen',
    kind: 'read',
    description:
      'Laat Google een wijziging controleren zonder iets te veranderen (validateOnly). Zelfde invoer als ads_mutate. Doe dit altijd eerst: zo zie je fouten voordat de eigenaar iets hoeft goed te keuren.',
    input: { customer: adsCustomer, operations: z.array(z.record(z.string(), z.any())).min(1).max(200).describe('Zoals bij ads_mutate') },
    run: async (a, g, x) => {
      await adsMutate(g, x, a.customer, a.operations, { validateOnly: true });
      return { gecontroleerd: true, veranderd: false, operaties: a.operations.length, uitleg: 'Google keurt deze wijziging goed. Er is nog niets veranderd; voer hem uit met ads_mutate.' };
    },
  },
  {
    name: 'ads_mutate',
    service: 'ads',
    title: 'Google Ads wijzigen',
    kind: 'send',
    description: [
      'Wijzig Google Ads: campagnes, budgetten, advertentiegroepen, advertenties, zoekwoorden, uitsluitingen, biedstrategieën, assets en conversieacties, in één keer (googleAds:mutate, REST/JSON, camelCase).',
      'Elke operatie is één object met één sleutel, bijvoorbeeld campaignBudgetOperation, campaignOperation, adGroupOperation, adGroupAdOperation, adGroupCriterionOperation, campaignCriterionOperation, assetOperation, campaignAssetOperation, conversionActionOperation, sharedSetOperation, sharedCriterionOperation; daarin create, update (met updateMask) of remove (resourceName).',
      'Nieuwe dingen die naar elkaar verwijzen krijgen tijdelijke negatieve ID’s, bijv. "customers/C/campaignBudgets/-1". "customers/C/" wordt het echte klant-ID.',
      'Budget en campagne (gepauzeerd): [{"campaignBudgetOperation":{"create":{"resourceName":"customers/C/campaignBudgets/-1","name":"Budget fietsen","amountMicros":"20000000","deliveryMethod":"STANDARD"}}},{"campaignOperation":{"create":{"name":"Fietsen zoeken","status":"PAUSED","advertisingChannelType":"SEARCH","campaignBudget":"customers/C/campaignBudgets/-1","maximizeClicks":{},"networkSettings":{"targetGoogleSearch":true,"targetSearchNetwork":false,"targetContentNetwork":false},"containsEuPoliticalAdvertising":"DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING"}}}]',
      'Advertentiegroep: [{"adGroupOperation":{"create":{"campaign":"customers/C/campaigns/123","name":"E-bikes","status":"ENABLED","type":"SEARCH_STANDARD","cpcBidMicros":"800000"}}}]',
      'Zoekwoord: [{"adGroupCriterionOperation":{"create":{"adGroup":"customers/C/adGroups/456","status":"ENABLED","keyword":{"text":"elektrische fiets","matchType":"PHRASE"}}}}]',
      'Responsive zoekadvertentie: [{"adGroupAdOperation":{"create":{"adGroup":"customers/C/adGroups/456","status":"PAUSED","ad":{"finalUrls":["https://www.voorbeeld.nl/"],"responsiveSearchAd":{"headlines":[{"text":"…"},{"text":"…"},{"text":"…"}],"descriptions":[{"text":"…"},{"text":"…"}]}}}}}]',
      'Pauzeren: [{"campaignOperation":{"update":{"resourceName":"customers/C/campaigns/123","status":"PAUSED"},"updateMask":"status"}}]',
      'Bedragen in micro’s (1.000.000 = 1 euro). Probeer eerst met ads_preview. Meer uitgeven (budget, bod, iets aanzetten, een nieuwe campagne, zoekwoord of advertentie) vraagt altijd de eigenaar.',
    ].join('\n'),
    input: {
      customer: adsCustomer,
      operations: z.array(z.record(z.string(), z.any())).min(1).max(200).describe('MutateOperation-objecten, zie de beschrijving'),
      partialFailure: z.boolean().optional().describe('true: wat lukt gaat door, de rest komt terug als fout'),
    },
    run: async (a, g, x) => {
      const r = await adsMutate(g, x, a.customer, a.operations, { partialFailure: a.partialFailure });
      const done = (r?.mutateOperationResponses || []).map((o: any) => Object.values(o || {}).map((v: any) => v?.resourceName).find(Boolean)).filter(Boolean);
      return { veranderd: true, resultaten: done, ...(r?.partialFailureError ? { deelsMislukt: r.partialFailureError.message || r.partialFailureError } : {}) };
    },
  },
  {
    name: 'ads_campaign_status',
    service: 'ads',
    title: 'Campagne aan of uit',
    kind: 'send',
    description: 'Zet een Google Ads-campagne op pauze of weer aan. Aanzetten kost geld en vraagt altijd de eigenaar.',
    input: { customer: adsCustomer, campaign: z.string().describe('Campagne-ID (cijfers) of resourceName'), status: z.enum(['PAUSED', 'ENABLED']) },
    run: async (a, g, x) => {
      const rn = adsResource(a.customer, 'campaigns', a.campaign);
      await adsMutate(g, x, a.customer, [{ campaignOperation: { update: { resourceName: rn, status: a.status }, updateMask: 'status' } }]);
      return { campagne: rn, status: a.status };
    },
  },
  {
    name: 'ads_budget_set',
    service: 'ads',
    title: 'Dagbudget instellen',
    kind: 'send',
    description: 'Stel het gemiddelde dagbudget van een campagnebudget in, in euro’s. Zoek het budget op met ads_query: "SELECT campaign.name, campaign_budget.resource_name, campaign_budget.amount_micros FROM campaign". Vraagt altijd de eigenaar.',
    input: { customer: adsCustomer, budget: z.string().describe('Budget-ID (cijfers) of resourceName van campaign_budget'), euros: z.number().positive().max(100000).describe('Nieuw dagbudget in euro’s, bijv. 25') },
    run: async (a, g, x) => {
      const rn = adsResource(a.customer, 'campaignBudgets', a.budget);
      await adsMutate(g, x, a.customer, [{ campaignBudgetOperation: { update: { resourceName: rn, amountMicros: String(Math.round(a.euros * 100) * 10_000) }, updateMask: 'amount_micros' } }]);
      return { budget: rn, perDag: a.euros };
    },
  },
  {
    name: 'ads_negatives_add',
    service: 'ads',
    title: 'Uitsluitingszoekwoorden toevoegen',
    kind: 'send',
    description: 'Voeg uitsluitingszoekwoorden toe aan een campagne (zoektermen waarop je niet wilt verschijnen). Dat verlaagt uitgaven.',
    input: {
      customer: adsCustomer,
      campaign: z.string().describe('Campagne-ID (cijfers) of resourceName'),
      keywords: z.array(z.string().min(1).max(80)).min(1).max(200),
      matchType: z.enum(['BROAD', 'PHRASE', 'EXACT']).optional().describe('Standaard PHRASE'),
    },
    run: async (a, g, x) => {
      const camp = adsResource(a.customer, 'campaigns', a.campaign);
      await adsMutate(g, x, a.customer, a.keywords.map((k: string) => ({ campaignCriterionOperation: { create: { campaign: camp, negative: true, keyword: { text: k, matchType: a.matchType || 'PHRASE' } } } })), { partialFailure: true });
      return { campagne: camp, uitgesloten: a.keywords };
    },
  },
  // ---- Analytics
  { name: 'ga_properties', service: 'analytics', title: 'Analytics-properties', kind: 'read', description: 'Toon de Google Analytics 4-accounts en properties waar dit account bij kan.', input: {}, run: (_a, g) => g('GET', 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries', { query: { pageSize: 200 } }) },
  {
    name: 'ga_key_events',
    service: 'analytics',
    title: 'Doelen (key events)',
    kind: 'read',
    description: 'De gebeurtenissen die in een Analytics-property als doel (key event) tellen, zoals een aanvraag of een aankoop.',
    input: { property: z.string().describe('Property-ID, bijv. 123456789') },
    run: (a, g) => g('GET', `https://analyticsadmin.googleapis.com/v1beta/properties/${String(a.property).replace(/\D/g, '')}/keyEvents`, { query: { pageSize: 200 } }),
  },
  {
    name: 'ga_key_event_create',
    service: 'analytics',
    title: 'Doel instellen (key event)',
    kind: 'write',
    scope: S + 'analytics.edit',
    description: 'Laat een gebeurtenis in een Analytics-property als doel (key event) tellen, bijvoorbeeld generate_lead. Kijk eerst met ga_key_events of hij er al staat.',
    input: { property: z.string().describe('Property-ID, bijv. 123456789'), event: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/).describe('Naam van de gebeurtenis, bijv. generate_lead'), once: z.boolean().optional().describe('Tel hoogstens één keer per sessie (standaard: elke keer)') },
    run: (a, g) => g('POST', `https://analyticsadmin.googleapis.com/v1beta/properties/${String(a.property).replace(/\D/g, '')}/keyEvents`, { body: { eventName: a.event, countingMethod: a.once ? 'ONCE_PER_SESSION' : 'ONCE_PER_EVENT' } }),
  },
  {
    name: 'ga_custom_dimension_create',
    service: 'analytics',
    title: 'Eigen dimensie maken',
    kind: 'write',
    scope: S + 'analytics.edit',
    description: 'Maak in een Analytics-property een eigen dimensie voor een parameter van een gebeurtenis (bijvoorbeeld lead_bron), zodat hij in rapporten te gebruiken is.',
    input: { property: z.string().describe('Property-ID, bijv. 123456789'), parameter: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/).describe('Naam van de parameter, bijv. lead_bron'), name: z.string().min(1).max(80).describe('Naam in de rapporten') },
    run: (a, g) => g('POST', `https://analyticsadmin.googleapis.com/v1beta/properties/${String(a.property).replace(/\D/g, '')}/customDimensions`, { body: { parameterName: a.parameter, displayName: a.name, scope: 'EVENT' } }),
  },
  {
    name: 'ga_report',
    service: 'analytics',
    title: 'Analytics-rapport',
    kind: 'read',
    description: 'Een rapport uit Google Analytics 4: metrics (bijv. sessions, totalUsers, conversions, purchaseRevenue) per dimensie (bijv. date, sessionDefaultChannelGroup, pagePath, country). Standaard de laatste 28 dagen.',
    input: { property: z.string().regex(/^\d+$/).describe('Property-ID, alleen cijfers (zie ga_properties)'), metrics: z.array(z.string()).min(1), dimensions: z.array(z.string()).optional(), start: z.string().optional(), end: z.string().optional(), limit: z.number().int().min(1).max(10_000).optional() },
    run: (a, g) =>
      g('POST', `https://analyticsdata.googleapis.com/v1beta/properties/${a.property}:runReport`, {
        body: { dateRanges: [{ startDate: a.start || '28daysAgo', endDate: a.end || 'yesterday' }], metrics: a.metrics.map((name: string) => ({ name })), dimensions: (a.dimensions || []).map((name: string) => ({ name })), limit: a.limit || 100 },
      }),
  },
  // ---- Tag Manager (reading: what is published, so a bot can check tags and consent without a browser)
  { name: 'gtm_accounts', service: 'tagmanager', title: 'Tag Manager-accounts', kind: 'read', description: 'Toon de Google Tag Manager-accounts waar dit Google-account bij kan.', input: {}, run: async (_a, g) => ((await g('GET', `${GTM}/accounts`)).account || []).map((x: any) => ({ account: x.accountId, name: x.name })) },
  {
    name: 'gtm_containers',
    service: 'tagmanager',
    title: 'Tag Manager-containers',
    kind: 'read',
    description: 'De containers van een Tag Manager-account, met hun openbare id (GTM-XXXX) en de sites waar ze voor zijn.',
    input: { account: z.string().regex(/^\d+$/).describe('Account-ID, alleen cijfers (zie gtm_accounts)') },
    run: async (a, g) => ((await g('GET', `${GTM}/accounts/${a.account}/containers`)).container || []).map((x: any) => ({ container: x.containerId, name: x.name, publicId: x.publicId, domains: x.domainName || [], usage: x.usageContext || [] })),
  },
  {
    name: 'gtm_published',
    service: 'tagmanager',
    title: 'Gepubliceerde container',
    kind: 'read',
    description: 'Wat er nu live staat in een Tag Manager-container: elke tag met zijn soort, of hij op pauze staat, op welke triggers hij afgaat en welke toestemming hij vraagt; en de triggers en variabelen.',
    input: { account: z.string().regex(/^\d+$/).describe('Account-ID (zie gtm_accounts)'), container: z.string().regex(/^\d+$/).describe('Container-ID, alleen cijfers (zie gtm_containers)') },
    run: async (a, g) => {
      const v = await g('GET', `${GTM}/accounts/${a.account}/containers/${a.container}/versions:live`);
      const trig = new Map<string, string>(((v.trigger || []) as any[]).map((x) => [String(x.triggerId), String(x.name)]));
      // Built-in triggers have fixed ids that are not in the list.
      const BUILT_IN: Record<string, string> = { '2147479553': 'All Pages', '2147479572': 'Consent Initialization - All Pages', '2147479573': 'Initialization - All Pages' };
      const names = (ids: any) => (Array.isArray(ids) ? ids.map((id) => trig.get(String(id)) || BUILT_IN[String(id)] || `trigger ${id}`) : []);
      const param = (x: any, key: string) => ((x.parameter || []) as any[]).find((q) => q.key === key)?.value;
      return {
        version: v.containerVersionId,
        name: v.name || '',
        published: v.fingerprint ? new Date(Number(v.fingerprint)).toISOString() : null,
        tags: ((v.tag || []) as any[]).map((x) => ({
          name: x.name,
          type: x.type,
          paused: !!x.paused,
          fires_on: names(x.firingTriggerId),
          blocked_by: names(x.blockingTriggerId),
          consent: x.consentSettings?.consentStatus || 'notSet',
          consent_types: ((x.consentSettings?.consentType?.list || []) as any[]).map((q) => q.value),
          id: param(x, 'measurementIdOverride') || param(x, 'tagId') || param(x, 'conversionId') || undefined,
        })),
        triggers: ((v.trigger || []) as any[]).map((x) => ({ name: x.name, type: x.type })),
        variables: ((v.variable || []) as any[]).map((x) => ({ name: x.name, type: x.type })),
      };
    },
  },
  // ---- Gmail
  {
    name: 'gmail_search',
    service: 'gmail',
    title: 'Mail zoeken',
    kind: 'read',
    description: 'Zoek in Gmail met de zoektaal van Gmail (bijv. "is:unread", "from:klant@voorbeeld.nl newer_than:7d", "subject:factuur has:attachment"). Geeft afzender, onderwerp, datum en een fragment per bericht.',
    input: { query: z.string().optional().describe('Leeg = de nieuwste berichten in de inbox'), limit: z.number().int().min(1).max(25).optional().describe('Standaard 10') },
    run: async (a, g) => {
      const list = await g('GET', `${GMAIL}/messages`, { query: { q: a.query || 'in:inbox', maxResults: a.limit || 10 } });
      const rows = await Promise.all(((list.messages || []) as any[]).map((m) => g('GET', `${GMAIL}/messages/${m.id}`, { query: { format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] } })));
      return rows.map((m) => ({ id: m.id, thread: m.threadId, from: header(m, 'from'), to: header(m, 'to'), subject: header(m, 'subject'), date: header(m, 'date'), unread: (m.labelIds || []).includes('UNREAD'), snippet: m.snippet }));
    },
  },
  {
    name: 'gmail_read',
    service: 'gmail',
    title: 'Mail lezen',
    kind: 'read',
    description: 'Lees één e-mail helemaal (zie gmail_search voor het id).',
    input: { id: z.string() },
    run: async (a, g) => {
      const m = await g('GET', `${GMAIL}/messages/${encodeURIComponent(a.id)}`, { query: { format: 'full' } });
      const files = (function walk(p: any): string[] {
        return [...(p?.filename ? [p.filename] : []), ...((p?.parts || []) as any[]).flatMap(walk)];
      })(m.payload);
      return { id: m.id, thread: m.threadId, from: header(m, 'from'), to: header(m, 'to'), cc: header(m, 'cc'), subject: header(m, 'subject'), date: header(m, 'date'), messageId: header(m, 'message-id'), attachments: files, body: mailBody(m.payload).slice(0, 20_000) };
    },
  },
  {
    name: 'gmail_draft',
    service: 'gmail',
    title: 'Concept maken',
    kind: 'write',
    scope: S + 'gmail.compose',
    description: 'Zet een concept-e-mail klaar in Gmail (wordt niet verstuurd). Voor een antwoord: geef thread en inReplyTo (het messageId uit gmail_read).',
    input: { to: z.string(), subject: z.string(), body: z.string(), cc: z.string().optional(), thread: z.string().optional(), inReplyTo: z.string().optional() },
    run: async (a, g) => {
      const eerder = await earlierWith(g, a.to);
      const r = await g('POST', `${GMAIL}/drafts`, { body: { message: { raw: rfc822(a), ...(a.thread ? { threadId: a.thread } : {}) } } });
      return eerder.length ? { ...r, eerder, let_op: earlierNote(eerder, false) } : r;
    },
  },
  {
    name: 'gmail_drafts',
    service: 'gmail',
    title: 'Concepten bekijken',
    kind: 'read',
    scope: S + 'gmail.compose',
    description: 'De concepten die in Gmail klaarstaan, eventueel gefilterd met de zoektaal van Gmail (bijv. "to:klant@voorbeeld.nl"). Geeft per concept het concept-id (voor gmail_draft_delete), ontvanger, onderwerp en datum.',
    input: { query: z.string().optional(), limit: z.number().int().min(1).max(25).optional().describe('Standaard 15') },
    run: async (a, g) => {
      const list = await g('GET', `${GMAIL}/drafts`, { query: { ...(a.query ? { q: a.query } : {}), maxResults: a.limit || 15 } });
      const rows = await Promise.all(((list.drafts || []) as any[]).map((d) => g('GET', `${GMAIL}/drafts/${d.id}`, { query: { format: 'metadata' } })));
      return rows.map((d) => ({ draft: d.id, thread: d.message?.threadId, to: header(d.message, 'to'), subject: header(d.message, 'subject'), date: header(d.message, 'date'), snippet: d.message?.snippet }));
    },
  },
  {
    name: 'gmail_draft_delete',
    service: 'gmail',
    title: 'Concept weggooien',
    kind: 'write',
    scope: S + 'gmail.compose',
    description: 'Gooi één concept weg dat niet meer klopt of dubbel is (concept-id uit gmail_drafts of gmail_draft). Alleen concepten: verstuurde en ontvangen mail blijft staan.',
    input: { draft: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/).describe('Concept-id') },
    run: async (a, g) => {
      await g('DELETE', `${GMAIL}/drafts/${a.draft}`);
      return { deleted: a.draft };
    },
  },
  {
    name: 'gmail_send',
    service: 'gmail',
    title: 'Mail versturen',
    kind: 'send',
    scope: S + 'gmail.compose',
    description: 'Verstuur een e-mail vanuit het Gmail-adres van de gebruiker. Voor een antwoord: geef thread en inReplyTo (het messageId uit gmail_read).',
    input: { to: z.string(), subject: z.string(), body: z.string(), cc: z.string().optional(), thread: z.string().optional(), inReplyTo: z.string().optional(), again: z.boolean().optional().describe('Alleen als er kort geleden al een mail met dit onderwerp naar deze ontvanger ging en dit bewust een tweede is') },
    run: async (a, g) => {
      const eerder = await earlierWith(g, a.to);
      // The same mail to the same person minutes ago (a turn that was resumed, two bots on one thread): not again.
      const twin = eerder.find((r) => r.what === 'verstuurd' && norm(r.subject) === norm(a.subject) && Math.abs(Date.now() - (Date.parse(r.date) || 0)) < SAME_MAIL_MS);
      if (twin && !a.again) throw new Error(`Niet verstuurd: aan deze ontvanger ging ${Math.max(1, Math.round((Date.now() - Date.parse(twin.date)) / 60_000))} min geleden al een mail met dit onderwerp (bericht ${twin.id}). Lees die eerst (gmail_read). Is dit echt een tweede bericht, stuur het dan met again: true.`);
      const r = await g('POST', `${GMAIL}/messages/send`, { body: { raw: rfc822(a), ...(a.thread ? { threadId: a.thread } : {}) } });
      return eerder.length ? { ...r, eerder, let_op: earlierNote(eerder, true) } : r;
    },
  },
  // ---- Agenda
  {
    name: 'calendar_events',
    service: 'calendar',
    title: 'Afspraken',
    kind: 'read',
    description: 'Afspraken uit Google Agenda in een periode (standaard de komende 7 dagen), eventueel met een zoekwoord.',
    input: { from: z.string().optional().describe('Begin, ISO-datum of -tijd'), to: z.string().optional().describe('Einde, ISO-datum of -tijd'), query: z.string().optional(), calendar: z.string().optional().describe('Agenda-ID (standaard de hoofdagenda)') },
    run: async (a, g) => {
      const iso = (v: string | undefined, fallback: number) => new Date(v || Date.now() + fallback).toISOString();
      const r = await g('GET', `${CAL}/calendars/${encodeURIComponent(a.calendar || 'primary')}/events`, { query: { timeMin: iso(a.from, 0), timeMax: iso(a.to, 7 * 86_400_000), q: a.query, singleEvents: true, orderBy: 'startTime', maxResults: 100 } });
      return ((r.items || []) as any[]).map((e) => ({ id: e.id, title: e.summary, start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date, location: e.location, description: e.description?.slice(0, 500), attendees: (e.attendees || []).map((p: any) => p.email), link: e.htmlLink }));
    },
  },
  {
    name: 'calendar_create_event',
    service: 'calendar',
    title: 'Afspraak maken',
    kind: 'write',
    description: 'Zet een afspraak in Google Agenda. Er gaan geen uitnodigingen naar anderen.',
    input: { title: z.string(), start: z.string().describe('ISO-tijd, bijv. 2026-11-12T14:00:00+01:00'), end: z.string().describe('ISO-tijd'), description: z.string().optional(), location: z.string().optional(), calendar: z.string().optional() },
    run: (a, g) => g('POST', `${CAL}/calendars/${encodeURIComponent(a.calendar || 'primary')}/events`, { query: { sendUpdates: 'none' }, body: { summary: a.title, description: a.description, location: a.location, start: { dateTime: a.start }, end: { dateTime: a.end } } }),
  },
  // ---- Drive
  {
    name: 'drive_search',
    service: 'drive',
    title: 'Bestanden zoeken',
    kind: 'read',
    description: 'Zoek bestanden in Google Drive op naam of inhoud.',
    input: { query: z.string().describe('Zoekwoorden'), limit: z.number().int().min(1).max(50).optional() },
    run: (a, g) => {
      const q = String(a.query).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      return g('GET', `${DRIVE}/files`, { query: { q: `(name contains '${q}' or fullText contains '${q}') and trashed = false`, pageSize: a.limit || 20, fields: 'files(id,name,mimeType,modifiedTime,size,webViewLink)', orderBy: 'modifiedTime desc', supportsAllDrives: true, includeItemsFromAllDrives: true } });
    },
  },
  {
    name: 'drive_read',
    service: 'drive',
    title: 'Bestand lezen',
    kind: 'read',
    description: 'Lees de tekst van een bestand in Google Drive: Google Documenten en Presentaties als tekst, Spreadsheets als CSV (eerste blad), en gewone tekstbestanden.',
    input: { id: z.string().describe('Bestands-ID (zie drive_search)') },
    run: async (a, g) => {
      const f = await g('GET', `${DRIVE}/files/${encodeURIComponent(a.id)}`, { query: { fields: 'id,name,mimeType,size,webViewLink', supportsAllDrives: true } });
      const mime = String(f.mimeType || '');
      const as = mime === 'application/vnd.google-apps.spreadsheet' ? 'text/csv' : /^application\/vnd\.google-apps\.(document|presentation)$/.test(mime) ? 'text/plain' : '';
      if (!as && !/^text\/|json|xml|csv|markdown/.test(mime)) return { name: f.name, type: mime, link: f.webViewLink, note: 'Dit bestandstype kan TeamBot niet als tekst lezen; open de link.' };
      if (!as && Number(f.size || 0) > 2_000_000) return { name: f.name, type: mime, link: f.webViewLink, note: 'Te groot om te lezen (meer dan 2 MB).' };
      const text = as ? await g('GET', `${DRIVE}/files/${encodeURIComponent(a.id)}/export`, { query: { mimeType: as }, raw: true }) : await g('GET', `${DRIVE}/files/${encodeURIComponent(a.id)}`, { query: { alt: 'media', supportsAllDrives: true }, raw: true });
      return { name: f.name, type: mime, link: f.webViewLink, text: String(text).slice(0, 60_000) };
    },
  },
];

/** The name of the service a tool belongs to, as the bot's tool list groups it ("Google Search Console", "Gmail"). */
export function googlePart(tool: string): string | null {
  const s = GOOGLE_SERVICES.find((x) => x.id === GOOGLE_TOOLS.find((t) => t.name === tool)?.service);
  return s ? (s.id === 'gmail' ? 'Gmail' : s.id === 'ads' ? s.name : `Google ${s.name}`) : null;
}

/** What to do next after an error Google words in its own terms (one sentence, or nothing). */
export function nextStep(tool: string, message: string): string {
  const m = String(message || '');
  if (/only be accessed by subaccounts and standalone accounts/i.test(m)) return ' Dit is een hoofdaccount met subaccounts: gebruik het account-ID van het subaccount zelf (merchant_accounts toont ze).';
  if (tool === 'merchant_report' && /invalid field name/i.test(m))
    return ' Velden van product_view zijn onder meer: id, offer_id, title, brand, gtin, price, availability, condition, category_l1 t/m category_l5, product_type_l1 t/m product_type_l5, feed_label, language_code, aggregated_reporting_context_status, item_issues, click_potential.';
  if (/only approved for use with test accounts/i.test(m))
    return ' Dit ligt aan het developer token (dat heeft alleen testtoegang), niet aan het account of de query: opnieuw proberen of een ander account geeft dezelfde fout. De eigenaar vraagt in het API-centrum van Google Ads Basic access aan; meld het hem één keer en ga door met ander werk.';
  if (/^gmail_/.test(tool) && /Invalid id value/i.test(m)) return ' Deze id bestaat niet in deze mailbox: neem de id letterlijk over uit gmail_search (of gmail_drafts voor een concept).';
  return '';
}

/**
 * "Gewone mail mag zonder mij de deur uit": the owner's switch (off by default) that lets a bot send an ordinary reply
 * without a card. Ordinary is narrow on purpose: an answer in a conversation that already exists (the thread and the
 * message it answers), to one person, that is not about money. A first message to someone, more than one recipient, a
 * copy to others, or anything about money, a price or a payment asks as before; the owner's own rules and the
 * reviewer still apply. Live (20 Nov 2026): most of what a team asked its owner was leave to send a mail.
 */
export const MAIL_RULE = 'mcp.google.plainReplies';
export function plainReply(args: any): boolean {
  const a = args || {};
  const to = String(a.to || '').split(/[,;]/).map((x: string) => x.trim()).filter(Boolean);
  if (to.length !== 1 || a.cc || a.bcc) return false;
  if (!String(a.thread || '').trim() || !String(a.inReplyTo || '').trim()) return false;
  return !aboutMoney(`${a.subject || ''}\n${a.body || ''}`);
}

/** The in-process MCP server of one Google connection: the tools of the services the owner chose. */
export function googleServer(ctx: Ctx, mgr: McpManager, c: ConnectionRow): McpServer {
  const server = new McpServer({ name: 'Google', version: ctx.config.version }, { capabilities: { tools: {} } });
  const on = new Set(serviceIds((c.oauth as any)?.services));
  const g = caller(ctx, mgr, c.id);
  const scope = String(c.oauth?.scope || '');
  for (const t of GOOGLE_TOOLS.filter((x) => on.has(x.service) && toolGranted(x, scope))) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: z.object(t.input), annotations: { readOnlyHint: t.kind === 'read', destructiveHint: t.kind === 'send', openWorldHint: t.kind === 'send' } },
      async (args: any) => {
        try {
          const out = await t.run(args || {}, g, { ctx, conn: getConn(ctx, c.id) || c });
          return { content: [{ type: 'text' as const, text: typeof out === 'string' ? out : JSON.stringify(out, null, 1) }] };
        } catch (e: any) {
          if (e instanceof AuthRequiredError) throw e;
          const fix = e instanceof GoogleError && e.fixUrl ? ` Zet deze API aan in je Google Cloud-project: ${e.fixUrl}` : '';
          return { content: [{ type: 'text' as const, text: `Google gaf een fout: ${cleanError(e)}${fix}${nextStep(t.name, String(e?.message || e))}` }], isError: true };
        }
      },
    );
  }
  return server;
}

// ---------------------------------------------------------------- login and routes

interface Flow {
  userId: string;
  services: string[];
  verifier: string;
  redirectUri: string;
  expires: number;
  /** The account this login is for (logging in again); none with `add`. */
  connId?: string;
  /** "Nog een Google-account": never replaces an account that is already there. */
  add?: boolean;
}
const flows = new Map<string, Flow>();

/** The user's Google accounts, the first connected first (more than one: a second Gmail, a business and a private account). */
export function googleConns(ctx: Ctx, userId: string): ConnectionRow[] {
  return ctx.store.find<ConnectionRow>('mcp_connections', { user_id: userId, catalog_id: GOOGLE_ID }).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}
/** One Google account: the one with this id, or the first. */
export function googleConn(ctx: Ctx, userId: string, connId?: string | null): ConnectionRow | null {
  const all = googleConns(ctx, userId);
  return (connId && all.find((c) => c.id === connId)) || all[0] || null;
}

/** One cheap read per service: the proof behind "Verbinding werkt", and where an API still has to be switched on. */
const PROBES: Record<string, (g: Call, x: { ctx: Ctx; conn: ConnectionRow }) => Promise<any>> = {
  searchconsole: (g) => g('GET', `${GSC}/sites`),
  merchant: (g) => g('GET', `${MERCHANT}/accounts/v1/accounts`, { query: { pageSize: 1 } }),
  ads: (g, x) => g('GET', `${ADS_URL}/customers:listAccessibleCustomers`, { headers: adsHeaders(x) }),
  analytics: (g) => g('GET', 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries', { query: { pageSize: 1 } }),
  tagmanager: (g) => g('GET', `${GTM}/accounts`),
  gmail: (g) => g('GET', `${GMAIL}/profile`),
  calendar: (g) => g('GET', `${CAL}/calendars/primary/events`, { query: { maxResults: 1, timeMin: new Date().toISOString() } }),
  drive: (g) => g('GET', `${DRIVE}/about`, { query: { fields: 'user(emailAddress)' } }),
};

export interface GoogleHelpers {
  baseUrl(req: Request): string;
  uniqueSlug(userId: string, wanted: string): string;
  callbackPage(ok: boolean, title: string, body: string, link?: string): string;
  emit(userId: string, c: ConnectionRow | null, id?: string): void;
  view(c: ConnectionRow): any;
  setBindings(userId: string, connId: string, agentIds: string[]): void;
}

export function registerGoogle(ctx: Ctx, mgr: McpManager, h: GoogleHelpers) {
  const api = ctx.api;
  const redirect = (req: Request) => h.baseUrl(req) + GOOGLE_CALLBACK_PATH;
  const loopback = (uri: string) => /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri);

  /** The account a request is about: ?conn= or { conn } (several Google accounts), else the first. */
  const pick = (req: Request) => googleConn(ctx, user(req).id, str((req.query as any)?.conn ?? req.body?.conn, 80) || null);
  const state = (req: Request) => {
    const u = user(req);
    const c = pick(req);
    const client = googleClient(ctx, u.id);
    const o: any = c?.oauth || {};
    const on = c ? serviceIds(o.services) : [];
    const redirectUri = redirect(req);
    return { plainReplies: ctx.store.getSetting<boolean>(user(req).id, MAIL_RULE, false) === true,
      /** teambot: one click; own: the user's own client is saved; null: make an own client first. */
      client: client?.source ?? null,
      redirectUri,
      /** A Desktop client only redirects to this computer; behind another address a Web client is needed. */
      clientType: loopback(redirectUri) ? 'desktop' : 'web',
      enableApisUrl: `https://console.cloud.google.com/flows/enableapi?apiid=${GOOGLE_SERVICES.flatMap((s) => s.apis).join(',')}`,
      services: GOOGLE_SERVICES.map((s) => ({ id: s.id, name: s.name, line: s.line, on: on.includes(s.id) })),
      email: o.email || null,
      status: !c ? 'off' : o.status === 'connected' ? 'on' : 'expired',
      adsToken: !!(c && ctx.secrets.getByName(u.id, adsName(c.id))),
      adsLogin: o.ads_login || '',
      connection: c ? h.view(c) : null,
      /** Every Google account of this user, the first first. */
      accounts: googleConns(ctx, u.id).map((x) => ({ id: x.id, email: String((x.oauth as any)?.email || ''), status: (x.oauth as any)?.status === 'connected' ? 'on' : 'expired' })),
    };
  };

  api.get('/mcp/google', ah(async (req) => state(req)));
  /** The owner's switch: ordinary replies go out without a card (see plainReply). */
  api.put(
    '/mcp/google/mail-rule',
    ah(async (req) => {
      const u = user(req);
      ctx.store.setSetting(u.id, MAIL_RULE, req.body?.plainReplies === true);
      ctx.audit(u.id, 'mcp.google.mail_rule', { plainReplies: req.body?.plainReplies === true });
      return state(req);
    }),
  );

  api.put(
    '/mcp/google/client',
    ah(async (req) => {
      const u = user(req);
      if (req.body?.forget === true) {
        for (const s of ctx.secrets.list(u.id)) if (s.name === OWN_CLIENT) ctx.secrets.delete(s.id);
      } else {
        const c = parseClient(req.body);
        ctx.secrets.set(u.id, OWN_CLIENT, JSON.stringify(c));
        ctx.audit(u.id, 'mcp.google.client', { clientId: c.id });
      }
      return state(req);
    }),
  );

  api.post(
    '/mcp/google/start',
    ah(async (req) => {
      const u = user(req);
      const client = googleClient(ctx, u.id);
      if (!client) throw bad('Er is nog geen Google-client. Maak er eerst een (Apps › Google).');
      const services = serviceIds(req.body?.services);
      const verifier = crypto.randomBytes(48).toString('base64url');
      const st = crypto.randomBytes(24).toString('base64url');
      const redirectUri = redirect(req);
      for (const [k, f] of flows) if (f.expires < Date.now()) flows.delete(k);
      const add = req.body?.add === true;
      const target = add ? null : pick(req);
      flows.set(sha256(st), { userId: u.id, services, verifier, redirectUri, expires: Date.now() + 10 * 60_000, connId: target?.id, add });
      const hint = String((target?.oauth as any)?.email || '');
      const q = new URLSearchParams({
        client_id: client.id,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: ['openid', 'email', ...GOOGLE_SERVICES.filter((s) => services.includes(s.id)).flatMap((s) => s.scopes)].join(' '),
        state: st,
        code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        access_type: 'offline',
        // consent: Google only hands out a refresh token when it asks again. Another account: Google lets you choose.
        prompt: add ? 'consent select_account' : 'consent',
        ...(hint ? { login_hint: hint } : {}),
      });
      return { authorizationUrl: `${at(AUTH_URL)}?${q}` };
    }),
  );

  ctx.publicApi.get(
    '/mcp/google/callback',
    ah(async (req, res) => {
      res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
      res.setHeader('cache-control', 'no-store');
      const q = req.query as Record<string, any>;
      const key = sha256(String(q.state || ''));
      const flow = flows.get(key);
      flows.delete(key);
      const fail = (message: string, userId?: string) => {
        if (userId) ctx.events.emit(userId, 'mcp.oauth', { id: GOOGLE_ID, google: true, ok: false, error: message });
        res.status(400).type('html').send(h.callbackPage(false, 'Inloggen bij Google mislukt', message, '/#/m/mcp/'));
      };
      if (!flow || flow.expires < Date.now()) return fail('Deze inloglink is verlopen of al gebruikt. Klik in TeamBot opnieuw op “Inloggen met Google”.');
      if (q.error) return fail(q.error === 'access_denied' ? 'Je hebt de toegang niet gegeven. Klik in TeamBot opnieuw op “Inloggen met Google” als je dat wel wilt.' : `Google meldde: ${String(q.error_description || q.error).slice(0, 200)}`, flow.userId);
      const client = googleClient(ctx, flow.userId);
      if (!client || !q.code) return fail('Geen code ontvangen van Google.', flow.userId);
      let tok: any;
      try {
        tok = await tokenRequest({ grant_type: 'authorization_code', code: String(q.code), client_id: client.id, client_secret: client.secret, redirect_uri: flow.redirectUri, code_verifier: flow.verifier });
      } catch (e: any) {
        return fail(`Google weigerde de inlog: ${cleanError(e)}`, flow.userId);
      }
      let email = '';
      try {
        email = String(JSON.parse(Buffer.from(String(tok.id_token || '').split('.')[1] || '', 'base64url').toString('utf8')).email || '');
      } catch {
        /* no id token: the address is only for display */
      }
      // Only what the owner really ticked on Google's screen counts.
      const services = grantedServices(flow.services, String(tok.scope || ''));
      if (!services.length) return fail('Je hebt bij Google geen van de gevraagde rechten aangevinkt. Probeer het opnieuw en zet de vinkjes aan voor wat TeamBot mag gebruiken.', flow.userId);
      // Which account: the one this login was for; else the one with this address; a different address is a new
      // account next to the others (never a silent swap of the account the bots were using).
      const all = googleConns(ctx, flow.userId);
      const same = email ? all.find((x) => String((x.oauth as any)?.email || '').toLowerCase() === email.toLowerCase()) : undefined;
      const meant = flow.connId ? all.find((x) => x.id === flow.connId) : undefined;
      let c: ConnectionRow | null = same || (meant && (!email || !(meant.oauth as any)?.email) ? meant : null) || (!flow.add && !flow.connId && all.length === 1 && !(all[0].oauth as any)?.email ? all[0] : null);
      const ts = now();
      const fresh = !c;
      const extra = fresh && all.length > 0;
      if (!c) {
        const id = newId('mcp_');
        ctx.store.insert('mcp_connections', {
          id,
          user_id: flow.userId,
          catalog_id: GOOGLE_ID,
          package: null,
          registry: null,
          name: 'Google',
          // A second account is told apart by its address (in the bots' tool list and on the Apps page).
          label: extra ? email : '',
          slug: h.uniqueSlug(flow.userId, 'google'),
          transport: 'builtin',
          command: '',
          args: [],
          cwd: '',
          env: [],
          url: '',
          headers: [],
          auth: 'none',
          oauth: {},
          trusted_at: ts,
          allow_private: false,
          enabled: true,
          allow_actions: actionsByDefault(ctx, flow.userId),
          verified_at: null,
          verify_result: null,
          status: 'new',
          last_error: null,
          server_info: null,
          idle_minutes: 10,
          timeout_sec: 60,
          created_at: ts,
          updated_at: ts,
        } as ConnectionRow);
        c = getConn(ctx, id)!;
        // A new user expects "gekoppeld" to mean his bots can use it; narrowing per bot stays one click away.
        h.setBindings(flow.userId, id, ctx.store.agents(flow.userId).map((a) => a.id));
        ctx.audit(flow.userId, 'mcp.connection.created', { id, name: 'Google', transport: 'builtin', catalog: GOOGLE_ID });
      }
      const prev = tokens(ctx, c);
      ctx.secrets.set(flow.userId, tokenName(c.id), JSON.stringify({ refresh_token: tok.refresh_token || prev.refresh_token, access_token: tok.access_token, expires_at: Date.now() + (Number(tok.expires_in) || 3600) * 1000 }));
      patchOAuth(ctx, c.id, { status: 'connected', connected_at: ts, has_refresh: !!(tok.refresh_token || prev.refresh_token), scope: String(tok.scope || ''), ...({ services, email: email || (c.oauth as any)?.email || '' } as any) });
      ctx.store.update('mcp_connections', c.id, { status: 'authorized', last_error: null, updated_at: ts });
      await mgr.stop(c.id, 'opnieuw ingelogd').catch(() => {});
      // The tools are TeamBot's own: usable (for reading) the moment the login is back, also when the page was closed.
      try {
        const client = await mgr.client(getConn(ctx, c.id)!, { force: true });
        mgr.syncTools(c.id, (await client.listTools()).tools || []);
        ctx.store.exec('UPDATE mcp_tools SET approved = 1, changed = 0 WHERE connection_id = ? AND present = 1', c.id);
        ctx.store.update('mcp_connections', c.id, { verified_at: ts, verify_result: { ok: true, at: ts }, updated_at: ts });
      } catch (e: any) {
        ctx.log.warn('[mcp] google tools not listed', e?.message || e);
      }
      const row = getConn(ctx, c.id)!;
      h.emit(flow.userId, row);
      ctx.events.emit(flow.userId, 'mcp.oauth', { id: c.id, google: true, ok: true, fresh });
      res.type('html').send(h.callbackPage(true, 'Google is gekoppeld', 'TeamBot test nu de verbinding. Ga terug naar TeamBot.', '/#/m/mcp/'));
    }),
  );

  /** "Verbinding werkt": the tool list (which approves the read tools) plus one real read per chosen service. */
  api.post(
    '/mcp/google/test',
    ah(async (req) => {
      const u = user(req);
      const c = pick(req);
      if (!c) throw bad('Google is nog niet gekoppeld.');
      const g = caller(ctx, mgr, c.id);
      const on = serviceIds((c.oauth as any)?.services);
      const checks = await Promise.all(
        GOOGLE_SERVICES.filter((s) => on.includes(s.id)).map(async (s) => {
          try {
            await PROBES[s.id](g, { ctx, conn: c });
            return { id: s.id, name: s.name, ok: true };
          } catch (e: any) {
            const needsToken = s.id === 'ads' && /developer token/i.test(String(e?.message));
            return { id: s.id, name: s.name, ok: false, error: cleanError(e).slice(0, 300), fixUrl: e instanceof GoogleError ? e.fixUrl : undefined, needsToken, authRequired: e instanceof AuthRequiredError };
          }
        }),
      );
      return { ok: checks.some((x) => x.ok), checks, ...state(req) };
    }),
  );

  api.put(
    '/mcp/google/ads',
    ah(async (req) => {
      const u = user(req);
      const c = pick(req);
      if (!c) throw bad('Koppel eerst Google.');
      const token = str(req.body?.developerToken, 200).trim();
      if (token) {
        if (!/^[A-Za-z0-9_-]{15,60}$/.test(token)) throw bad('Dit lijkt geen developer token: hij staat in Google Ads onder Beheer › API-centrum en is ongeveer 22 tekens lang.');
        ctx.secrets.set(u.id, adsName(c.id), token);
      }
      if (req.body?.loginCustomerId !== undefined) patchOAuth(ctx, c.id, { ...({ ads_login: str(req.body.loginCustomerId, 20).replace(/\D/g, '') } as any) });
      ctx.audit(u.id, 'mcp.google.ads', { id: c.id });
      return state(req);
    }),
  );

  // ---- the owner's own mail on the dashboard: the same Gmail calls the bots' tools make, for the owner himself

  /** The Gmail tool with this name, run for the owner; plain words when Gmail is not connected or not allowed. */
  const mail = async (req: Request, name: 'gmail_search' | 'gmail_read' | 'gmail_send', args: any) => {
    const c = pick(req);
    const o: any = c?.oauth || {};
    if (!c || o.status !== 'connected' || !serviceIds(o.services).includes('gmail')) throw bad('Gmail is niet gekoppeld. Koppel Google bij Apps en vink Gmail aan.');
    const tool = GOOGLE_TOOLS.find((t) => t.name === name)!;
    if (!toolGranted(tool, String(o.scope || ''))) throw bad(name === 'gmail_send' ? 'Je hebt Google alleen laten lezen. Log opnieuw in bij Apps › Google en vink ook het versturen van mail aan.' : 'Je hebt bij Google het lezen van mail niet aangevinkt. Log opnieuw in bij Apps › Google.');
    try {
      return await tool.run(args, caller(ctx, mgr, c.id), { ctx, conn: c });
    } catch (e: any) {
      if (e instanceof AuthRequiredError) throw bad('De inlog bij Google is verlopen. Log opnieuw in bij Apps › Google.');
      throw bad(`Google gaf een fout: ${cleanError(e).slice(0, 300)}`);
    }
  };

  // New mail in Gmail starts the routines that wait for mail (trigger "E-mail"), like a mailbox connected as a channel.
  if (!process.env.NODE_TEST_CONTEXT) {
    const timer = setInterval(() => void watchGmail(ctx, mgr).catch((e) => ctx.log.warn('[mcp] gmail kijken', cleanError(e))), GMAIL_WATCH_MS);
    timer.unref?.();
  }

  /** The inbox (or a Gmail search): the newest messages, with who, what and whether it is unread. */
  api.get(
    '/mcp/google/mail',
    ah(async (req) => {
      // Not connected is a state, not a failure: the dashboard shows how to connect it (and the browser logs no error).
      const c = pick(req);
      const o: any = c?.oauth || {};
      if (!c || o.status !== 'connected' || !serviceIds(o.services).includes('gmail')) return { messages: [], off: 'Gmail is niet gekoppeld. Koppel Google bij Apps en vink Gmail aan.' };
      return { messages: await mail(req, 'gmail_search', { query: str(req.query.q, 300).trim() || 'in:inbox', limit: Math.min(25, Math.max(1, Number(req.query.limit) || 15)) }) };
    }),
  );

  api.get(
    '/mcp/google/mail/:id',
    ah(async (req) => mail(req, 'gmail_read', { id: str(req.params.id, 120) })),
  );

  /** The owner answers or writes a mail himself: it goes out at once, from his own address. */
  api.post(
    '/mcp/google/mail/send',
    ah(async (req) => {
      const to = str(req.body?.to, 500).trim();
      const body = str(req.body?.body, 100_000);
      if (!/\S+@\S+\.\S+/.test(to)) throw bad('Vul een e-mailadres in.');
      if (!body.trim()) throw bad('Het bericht is leeg.');
      const r = await mail(req, 'gmail_send', { to, subject: str(req.body?.subject, 400).trim(), body, cc: str(req.body?.cc, 500).trim() || undefined, thread: str(req.body?.thread, 120) || undefined, inReplyTo: str(req.body?.inReplyTo, 400) || undefined });
      ctx.audit(user(req).id, 'mcp.google.mail_sent', { to: to.slice(0, 120), reply: !!req.body?.thread });
      return { ok: true, id: r?.id || null };
    }),
  );
}

// ---------------------------------------------------------------- new mail in Gmail → routines that wait for mail

/** How often TeamBot looks for new mail (only for an owner who has a routine waiting for mail). */
const GMAIL_WATCH_MS = 2 * 60_000;
const GMAIL_SEEN = 'google.gmail.seen';

/**
 * New mail in the inbox of a connected Gmail goes to the routines that wait for mail (routines' trigger "E-mail", the
 * same one a mailbox connected as a channel feeds): the bot of such a routine gets a turn per mail, with sender,
 * subject and text. Nothing is asked of Google for an owner without such a routine. The mail that is already there
 * when TeamBot first looks starts nothing: only what comes in after it. Returns how many mails were handed over.
 */
export async function watchGmail(ctx: Ctx, mgr: McpManager, onlyUser?: string): Promise<number> {
  const engine = ctx.services.routines?.engine;
  if (typeof engine?.handleEmail !== 'function') return 0;
  let handed = 0;
  const conns = ctx.store.find<ConnectionRow>('mcp_connections', { catalog_id: GOOGLE_ID }).filter((c) => c.enabled && (!onlyUser || c.user_id === onlyUser));
  for (const c of conns) {
    const o: any = c.oauth || {};
    if (o.status !== 'connected' || !serviceIds(o.services).includes('gmail')) continue;
    if (!ctx.store.one("SELECT 1 AS x FROM routine_triggers WHERE user_id = ? AND kind = 'email' AND enabled = 1 LIMIT 1", c.user_id)) continue;
    const g = caller(ctx, mgr, c.id);
    try {
      const list = await g('GET', `${GMAIL}/messages`, { query: { q: 'in:inbox newer_than:2d', maxResults: 25 } });
      const ids: string[] = ((list.messages || []) as any[]).map((m) => String(m.id));
      // Per account; the first account keeps the key it had when there could be only one.
      const seenKey = googleConn(ctx, c.user_id)?.id === c.id ? GMAIL_SEEN : `${GMAIL_SEEN}.${c.id}`;
      const state = ctx.store.getSetting<{ ids: string[] } | null>(c.user_id, seenKey, null);
      const seen = new Set(state?.ids || []);
      // The first look: what is there now is old mail.
      const fresh = state ? ids.filter((id) => !seen.has(id)).reverse() : [];
      ctx.store.setSetting(c.user_id, seenKey, { ids: [...new Set([...ids, ...(state?.ids || [])])].slice(0, 400) });
      for (const id of fresh.slice(0, 10)) {
        const m = await g('GET', `${GMAIL}/messages/${encodeURIComponent(id)}`, { query: { format: 'full' } });
        // Only what really came in: not the owner's own sent mail that Gmail also labels with the conversation.
        if (!(m.labelIds || []).includes('INBOX') || (m.labelIds || []).includes('SENT')) continue;
        engine.handleEmail({
          userId: c.user_id,
          accountId: 'gmail',
          bindingName: String(o.email || 'Gmail'),
          from: header(m, 'from'),
          to: header(m, 'to'),
          subject: header(m, 'subject'),
          date: header(m, 'date'),
          text: mailBody(m.payload).slice(0, 20_000),
          messageId: header(m, 'message-id') || `gmail:${m.id}`,
          id: m.id,
        });
        handed++;
      }
    } catch (e: any) {
      if (!(e instanceof AuthRequiredError)) ctx.log.warn('[mcp] gmail kijken', cleanError(e).slice(0, 200));
    }
  }
  return handed;
}

/** Disconnecting: also take the access away at Google itself. */
export async function revokeGoogle(ctx: Ctx, c: ConnectionRow): Promise<{ revokedAtService: boolean; detail: string }> {
  const t = tokens(ctx, c);
  const token = t.refresh_token || t.access_token;
  if (!token) return { revokedAtService: false, detail: '' };
  try {
    const res = await net()(at(REVOKE_URL), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString(), signal: AbortSignal.timeout(15_000) });
    return { revokedAtService: res.ok, detail: res.ok ? 'De toegang is ook bij Google ingetrokken.' : 'Google kon de toegang niet intrekken; haal TeamBot weg bij myaccount.google.com › Beveiliging › Apps van derden.' };
  } catch {
    return { revokedAtService: false, detail: 'Google was niet bereikbaar; haal TeamBot weg bij myaccount.google.com › Beveiliging › Apps van derden.' };
  }
}
