import crypto from 'node:crypto';
import type { Request } from 'express';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Ctx } from '../../core/types.js';
import { newId, now } from '../../core/db.js';
import { ah, bad, str, user } from '../../core/http.js';
import type { ConnectionRow } from './db.js';
import type { McpManager } from './runtime.js';
import { AuthRequiredError, getConn, patchOAuth } from './oauth.js';
import { TEAMBOT_GOOGLE_CLIENT } from './google-client.js';
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
  { id: 'searchconsole', name: 'Search Console', line: 'Zoekwoorden, posities en indexering', scopes: [S + 'webmasters.readonly'], apis: ['searchconsole.googleapis.com'] },
  { id: 'merchant', name: 'Merchant Center', line: 'Producten, afkeuringen en prestaties', scopes: [S + 'content'], apis: ['merchantapi.googleapis.com'] },
  { id: 'ads', name: 'Google Ads', line: 'Campagnes, zoekwoorden en kosten', scopes: [S + 'adwords'], apis: ['googleads.googleapis.com'] },
  { id: 'analytics', name: 'Analytics', line: 'Bezoekers en conversies', scopes: [S + 'analytics.readonly'], apis: ['analyticsdata.googleapis.com', 'analyticsadmin.googleapis.com'] },
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
  const id = process.env.TEAMBOT_GOOGLE_CLIENT_ID || TEAMBOT_GOOGLE_CLIENT.clientId;
  const secret = process.env.TEAMBOT_GOOGLE_CLIENT_SECRET || TEAMBOT_GOOGLE_CLIENT.clientSecret;
  return id ? { id, secret, source: 'teambot' } : null;
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

type Call = (method: 'GET' | 'POST', url: string, opts?: { query?: Record<string, any>; body?: any; headers?: Record<string, string>; raw?: boolean }) => Promise<any>;

function caller(ctx: Ctx, mgr: McpManager, connId: string): Call {
  return async (method, url, opts = {}) => {
    const c = getConn(ctx, connId);
    if (!c) throw new Error('Google is ontkoppeld.');
    const u = new URL(at(url));
    for (const [k, v] of Object.entries(opts.query || {})) {
      if (v === undefined || v === null || v === '') continue;
      for (const x of Array.isArray(v) ? v : [v]) u.searchParams.append(k, String(x));
    }
    const once = async (force: boolean) =>
      net()(u.href, {
        method,
        headers: { authorization: `Bearer ${await accessToken(ctx, mgr, c, force)}`, ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(45_000),
      });
    let res = await once(false);
    if (res.status === 401) res = await once(true);
    const text = await res.text();
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
  run(a: any, g: Call, x: { ctx: Ctx; conn: ConnectionRow }): Promise<any>;
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
const site = z.string().describe('De site zoals in Search Console, bijv. "https://www.voorbeeld.nl/" of "sc-domain:voorbeeld.nl" (zie gsc_sites)');
const account = z.string().regex(/^\d+$/).describe('Merchant Center-account-ID, alleen cijfers (zie merchant_accounts)');

function adsHeaders(x: { ctx: Ctx; conn: ConnectionRow }): Record<string, string> {
  const token = x.ctx.secrets.getByName(x.conn.user_id, adsName(x.conn.id));
  if (!token) throw new Error('Google Ads vraagt een developer token. Vul hem in bij Apps › Google › Google Ads (uit het API-centrum van je Google Ads-beheerdersaccount).');
  const login = String((x.conn.oauth as any)?.ads_login || '').replace(/\D/g, '');
  return { 'developer-token': token, ...(login ? { 'login-customer-id': login } : {}) };
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
  { name: 'gsc_inspect_url', service: 'searchconsole', title: 'URL inspecteren', kind: 'read', description: 'Hoe Google één pagina ziet: geïndexeerd of niet, laatste crawl, canonieke URL, mobiel en rich results.', input: { site, url: z.string().url() }, run: (a, g) => g('POST', 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', { body: { inspectionUrl: a.url, siteUrl: a.site, languageCode: 'nl-NL' } }) },
  { name: 'gsc_sitemaps', service: 'searchconsole', title: 'Sitemaps', kind: 'read', description: 'De ingediende sitemaps van een site, met fouten en waarschuwingen.', input: { site }, run: (a, g) => g('GET', `${GSC}/sites/${encodeURIComponent(a.site)}/sitemaps`) },
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
    run: (a, g, x) => merchant(g, x, a.account, () => g('POST', `${MERCHANT}/reports/v1/accounts/${a.account}/reports:search`, { body: { query: a.query, pageSize: a.limit || 200 } })),
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
    input: { customer: z.string().describe('Klant-ID, 10 cijfers; streepjes mogen (zie ads_customers)'), query: z.string().min(10).describe('GAQL-query die met SELECT begint') },
    run: (a, g, x) => {
      if (!/^\s*select\b/i.test(a.query)) throw new Error('Alleen SELECT-query’s (lezen).');
      return g('POST', `${ADS_URL}/customers/${String(a.customer).replace(/\D/g, '')}/googleAds:search`, { body: { query: a.query }, headers: adsHeaders(x) });
    },
  },
  // ---- Analytics
  { name: 'ga_properties', service: 'analytics', title: 'Analytics-properties', kind: 'read', description: 'Toon de Google Analytics 4-accounts en properties waar dit account bij kan.', input: {}, run: (_a, g) => g('GET', 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries', { query: { pageSize: 200 } }) },
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
    description: 'Zet een concept-e-mail klaar in Gmail (wordt niet verstuurd). Voor een antwoord: geef thread en inReplyTo (het messageId uit gmail_read).',
    input: { to: z.string(), subject: z.string(), body: z.string(), cc: z.string().optional(), thread: z.string().optional(), inReplyTo: z.string().optional() },
    run: (a, g) => g('POST', `${GMAIL}/drafts`, { body: { message: { raw: rfc822(a), ...(a.thread ? { threadId: a.thread } : {}) } } }),
  },
  {
    name: 'gmail_send',
    service: 'gmail',
    title: 'Mail versturen',
    kind: 'send',
    description: 'Verstuur een e-mail vanuit het Gmail-adres van de gebruiker. Voor een antwoord: geef thread en inReplyTo (het messageId uit gmail_read).',
    input: { to: z.string(), subject: z.string(), body: z.string(), cc: z.string().optional(), thread: z.string().optional(), inReplyTo: z.string().optional() },
    run: (a, g) => g('POST', `${GMAIL}/messages/send`, { body: { raw: rfc822(a), ...(a.thread ? { threadId: a.thread } : {}) } }),
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

/** The in-process MCP server of one Google connection: the tools of the services the owner chose. */
export function googleServer(ctx: Ctx, mgr: McpManager, c: ConnectionRow): McpServer {
  const server = new McpServer({ name: 'Google', version: ctx.config.version }, { capabilities: { tools: {} } });
  const on = new Set(serviceIds((c.oauth as any)?.services));
  const g = caller(ctx, mgr, c.id);
  for (const t of GOOGLE_TOOLS.filter((x) => on.has(x.service))) {
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
          return { content: [{ type: 'text' as const, text: `Google gaf een fout: ${cleanError(e)}${fix}` }], isError: true };
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
}
const flows = new Map<string, Flow>();

export function googleConn(ctx: Ctx, userId: string): ConnectionRow | null {
  return ctx.store.find<ConnectionRow>('mcp_connections', { user_id: userId, catalog_id: GOOGLE_ID })[0] || null;
}

/** One cheap read per service: the proof behind "Verbinding werkt", and where an API still has to be switched on. */
const PROBES: Record<string, (g: Call, x: { ctx: Ctx; conn: ConnectionRow }) => Promise<any>> = {
  searchconsole: (g) => g('GET', `${GSC}/sites`),
  merchant: (g) => g('GET', `${MERCHANT}/accounts/v1/accounts`, { query: { pageSize: 1 } }),
  ads: (g, x) => g('GET', `${ADS_URL}/customers:listAccessibleCustomers`, { headers: adsHeaders(x) }),
  analytics: (g) => g('GET', 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries', { query: { pageSize: 1 } }),
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

  const state = (req: Request) => {
    const u = user(req);
    const c = googleConn(ctx, u.id);
    const client = googleClient(ctx, u.id);
    const o: any = c?.oauth || {};
    const on = c ? serviceIds(o.services) : [];
    const redirectUri = redirect(req);
    return {
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
    };
  };

  api.get('/mcp/google', ah(async (req) => state(req)));

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
      flows.set(sha256(st), { userId: u.id, services, verifier, redirectUri, expires: Date.now() + 10 * 60_000 });
      const q = new URLSearchParams({
        client_id: client.id,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: ['openid', 'email', ...GOOGLE_SERVICES.filter((s) => services.includes(s.id)).flatMap((s) => s.scopes)].join(' '),
        state: st,
        code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        access_type: 'offline',
        // consent: Google only hands out a refresh token when it asks again.
        prompt: 'consent',
        ...(googleConn(ctx, u.id)?.oauth && (googleConn(ctx, u.id)!.oauth as any).email ? { login_hint: (googleConn(ctx, u.id)!.oauth as any).email } : {}),
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
      const granted = String(tok.scope || '').split(/\s+/);
      // Only what the owner really ticked on Google's screen counts.
      const services = flow.services.filter((id) => GOOGLE_SERVICES.find((s) => s.id === id)!.scopes.every((sc) => !tok.scope || granted.includes(sc)));
      if (!services.length) return fail('Je hebt bij Google geen van de gevraagde rechten aangevinkt. Probeer het opnieuw en laat de vinkjes aan.', flow.userId);
      let c = googleConn(ctx, flow.userId);
      const ts = now();
      const fresh = !c;
      if (!c) {
        const id = newId('mcp_');
        ctx.store.insert('mcp_connections', {
          id,
          user_id: flow.userId,
          catalog_id: GOOGLE_ID,
          package: null,
          registry: null,
          name: 'Google',
          label: '',
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
      const c = googleConn(ctx, u.id);
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
      const c = googleConn(ctx, u.id);
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
