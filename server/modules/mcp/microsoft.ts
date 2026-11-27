import crypto from 'node:crypto';
import type { Request } from 'express';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Ctx } from '../../core/types.js';
import { newId, now } from '../../core/db.js';
import { ah, bad, str, user } from '../../core/http.js';
import type { ConnectionRow } from './db.js';
import type { McpManager } from './runtime.js';
import type { GoogleHelpers } from './google.js';
import { AuthRequiredError, getConn, patchOAuth } from './oauth.js';
import { teambotApp } from './teambot-apps.js';
import { cleanError, guardedFetch, sha256 } from './util.js';
import { actionsByDefault } from './defaults.js';

/**
 * Microsoft / Outlook (Outlook.com, Hotmail, MSN, Live and work or school accounts): mail and the Outlook calendar
 * through Microsoft Graph, in this process, like google.ts does for Google. The login is OAuth for a public client
 * (authorization code + PKCE, no client secret) with TeamBot's own Entra app; the redirect goes to TeamBot on this
 * computer (http://localhost, any port), which is why it only works on the computer where TeamBot runs. Several
 * Microsoft accounts can be connected side by side; each is its own connection with its own tools.
 *
 * Tokens are stored encrypted in the vault. Microsoft rotates the refresh token: the newest one is always kept.
 */

export const MS_ID = 'microsoft';
export const MS_CALLBACK_PATH = '/api/public/mcp/microsoft/callback';
/**
 * TeamBot's own Entra app ("public client", no secret; all tenants and personal Microsoft accounts; redirect
 * http://localhost/api/public/mcp/microsoft/callback, platform "mobile and desktop"). A public client id is not a
 * secret, so it ships in the source. TEAMBOT_MS_CLIENT_ID (or a built-in "microsoft" app, see teambot-apps.ts) wins.
 */
export const MS_DEFAULT_CLIENT_ID = 'e70fa70a-0246-44d2-8c82-056c6d30359c';
export const MS_SCOPES = ['openid', 'email', 'profile', 'offline_access', 'User.Read', 'Mail.ReadWrite', 'Mail.Send', 'Calendars.ReadWrite'];

export function msClientId(): string {
  return process.env.TEAMBOT_MS_CLIENT_ID || teambotApp('microsoft')?.clientId || MS_DEFAULT_CLIENT_ID;
}

// ---------------------------------------------------------------- endpoints (a local stand-in for tests)

/** Tests point TEAMBOT_MS_BASE at a local stand-in: https://host/path becomes <base>/host/path. Loopback only. */
function testBase(): string {
  const b = process.env.TEAMBOT_MS_BASE || '';
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(b) ? b : '';
}
const at = (url: string) => (testBase() ? `${testBase()}/${url.replace(/^https:\/\//, '')}` : url);
const LOGIN = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const AUTH_URL = `${LOGIN}/authorize`;
const TOKEN_URL = `${LOGIN}/token`;
const GRAPH = 'https://graph.microsoft.com/v1.0';
const net = () => guardedFetch(!!testBase());

/** Where the owner takes TeamBot's access away himself (Microsoft has no simple revocation for a public client). */
export const MS_CONSENT_PERSONAL = 'https://account.live.com/consent/Manage';
export const MS_CONSENT_WORK = 'https://myapps.microsoft.com';

// ---------------------------------------------------------------- tokens

interface MTokens {
  refresh_token?: string;
  access_token?: string;
  expires_at?: number;
}
const tokenName = (connId: string) => `mcp:${connId}:oauth:tokens`;
function tokens(ctx: Ctx, c: ConnectionRow): MTokens {
  try {
    return JSON.parse(ctx.secrets.getByName(c.user_id, tokenName(c.id)) || '{}');
  } catch {
    return {};
  }
}

async function tokenRequest(body: Record<string, string>): Promise<any> {
  const res = await net()(at(TOKEN_URL), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(), signal: AbortSignal.timeout(20_000) });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(String(j.error_description || j.error || `Microsoft gaf HTTP ${res.status}`).split(/\r?\n/)[0]), { code: j.error });
  return j;
}

/** A valid access token; refreshed when (nearly) expired, with the new refresh token Microsoft hands out kept. */
async function accessToken(ctx: Ctx, mgr: McpManager, c: ConnectionRow, force = false): Promise<string> {
  const t = tokens(ctx, c);
  if (!force && t.access_token && (t.expires_at || 0) > Date.now() + 60_000) return t.access_token;
  if (!t.refresh_token) throw new AuthRequiredError('Outlook: log opnieuw in (Apps › Outlook).');
  try {
    const j = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: msClientId(), scope: MS_SCOPES.join(' ') });
    ctx.secrets.set(c.user_id, tokenName(c.id), JSON.stringify({ refresh_token: j.refresh_token || t.refresh_token, access_token: j.access_token, expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000 }));
    return j.access_token;
  } catch (e: any) {
    if (['invalid_grant', 'invalid_client', 'unauthorized_client', 'interaction_required', 'consent_required'].includes(e.code)) {
      mgr.markAuthRequired(c.id);
      throw new AuthRequiredError('Outlook: de toegang is verlopen of ingetrokken. Log opnieuw in (Apps › Outlook).');
    }
    throw e;
  }
}

// ---------------------------------------------------------------- calling Microsoft Graph

class GraphError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

let retryWaits = [5_000, 15_000, 30_000];
/** Tests: shorter waits. */
export function setMsRetryWaits(ms: number[] | null) {
  retryWaits = ms || [5_000, 15_000, 30_000];
}

export type MsCall = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, opts?: { query?: Record<string, any>; body?: any; headers?: Record<string, string> }) => Promise<any>;

function caller(ctx: Ctx, mgr: McpManager, connId: string): MsCall {
  return async (method, url, opts = {}) => {
    const c = getConn(ctx, connId);
    if (!c) throw new Error('Outlook is ontkoppeld.');
    const u = new URL(at(url.startsWith('http') ? url : GRAPH + url));
    for (const [k, v] of Object.entries(opts.query || {})) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    const once = async (force: boolean) => {
      try {
        return await net()(u.href, {
          method,
          headers: { authorization: `Bearer ${await accessToken(ctx, mgr, c, force)}`, ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(45_000),
        });
      } catch (e: any) {
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new GraphError(504, 'geen antwoord binnen 45 seconden. Probeer het opnieuw.');
        throw e;
      }
    };
    let res = await once(false);
    if (res.status === 401) res = await once(true);
    let text = await res.text();
    // Throttled (429, or 503 while Exchange is busy): nothing happened, so wait and send it again.
    for (const wait of retryWaits) {
      if (res.status !== 429 && res.status !== 503) break;
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
      throw new GraphError(res.status, String(j?.error?.message || text.slice(0, 300) || `HTTP ${res.status}`).slice(0, 600), j?.error?.code);
    }
    return text ? JSON.parse(text) : {};
  };
}

// ---------------------------------------------------------------- tools

interface MTool {
  name: string;
  title: string;
  description: string;
  input: Record<string, z.ZodTypeAny>;
  /** read: no change; write: makes or changes something of the owner's own (a draft, a folder); send: goes to others. */
  kind: 'read' | 'write' | 'send';
  run(a: any, g: MsCall): Promise<any>;
}

/** A mail with the same subject to the same person within this time is the same mail (outlook_send). */
const SAME_MAIL_MS = 30 * 60_000;
const norm = (v: string) => String(v || '').replace(/^\s*((re|fw|fwd|aw|antw|ant|doorst)\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
const who = (r: any) => {
  const e = r?.emailAddress || {};
  return e.name && e.address && e.name !== e.address ? `${e.name} <${e.address}>` : String(e.address || e.name || '');
};
const whoList = (l: any) => ((Array.isArray(l) ? l : []) as any[]).map(who).filter(Boolean).join(', ');
const addresses = (s: string) => String(s || '').match(/[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/g) || [];
const recipients = (s?: string) => addresses(s || '').map((address) => ({ emailAddress: { address } }));

export function htmlToText(html: string): string {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<head[\s\S]*?<\/head>/gi, '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>|<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
const bodyText = (b: any) => (String(b?.contentType || '').toLowerCase() === 'html' ? htmlToText(b?.content) : String(b?.content || '').trim());

/** Well-known folders, also by their Dutch names. */
const WELL_KNOWN: Record<string, string> = {
  inbox: 'inbox', postvak: 'inbox', 'postvak in': 'inbox',
  sentitems: 'sentitems', sent: 'sentitems', verzonden: 'sentitems', 'verzonden items': 'sentitems',
  drafts: 'drafts', concepten: 'drafts',
  archive: 'archive', archief: 'archive',
  deleteditems: 'deleteditems', trash: 'deleteditems', prullenbak: 'deleteditems', 'verwijderde items': 'deleteditems',
  junkemail: 'junkemail', junk: 'junkemail', spam: 'junkemail', ongewenst: 'junkemail', 'ongewenste e-mail': 'junkemail',
};
/** A folder by its well-known name, its id, or its display name (top level or under the inbox). */
async function folderId(g: MsCall, folder: string): Promise<string> {
  const f = String(folder || '').trim();
  const known = WELL_KNOWN[f.toLowerCase()];
  if (known) return known;
  if (/^[A-Za-z0-9_=+/-]{40,}$/.test(f)) return f;
  const q = { $filter: `displayName eq '${f.replace(/'/g, "''")}'`, $select: 'id,displayName' };
  const top = await g('GET', '/me/mailFolders', { query: q });
  const hit = (top.value || [])[0] || ((await g('GET', '/me/mailFolders/inbox/childFolders', { query: q })).value || [])[0];
  if (!hit) throw new Error(`Map “${f}” bestaat niet. Gebruik inbox, archive, deleteditems, junkemail of de precieze naam van een eigen map.`);
  return hit.id;
}

const SEARCH_FIELDS = 'id,from,toRecipients,subject,receivedDateTime,isRead,bodyPreview,conversationId';
const row = (m: any) => ({ id: m.id, from: who(m.from), to: whoList(m.toRecipients), subject: m.subject || '', receivedDateTime: m.receivedDateTime, isRead: !!m.isRead, preview: m.bodyPreview || '', conversationId: m.conversationId });

async function search(g: MsCall, a: { query?: string; folder?: string; limit?: number }) {
  const limit = Math.min(50, Math.max(1, Number(a.limit) || 10));
  const folder = a.folder ? await folderId(g, a.folder) : a.query ? '' : 'inbox';
  const query: Record<string, any> = { $top: limit, $select: SEARCH_FIELDS };
  // $search (KQL) cannot be combined with $orderby; Graph orders it by relevance and date itself.
  if (a.query) query.$search = `"${String(a.query).replace(/"/g, '\\"')}"`;
  else query.$orderby = 'receivedDateTime desc';
  const r = await g('GET', folder ? `/me/mailFolders/${encodeURIComponent(folder)}/messages` : '/me/messages', { query });
  return ((r.value || []) as any[]).map(row);
}

/** The sent mail of the last half hour (for the same-mail check); looking never stops a mail. */
async function recentlySent(g: MsCall): Promise<any[]> {
  try {
    const r = await g('GET', '/me/mailFolders/sentitems/messages', { query: { $top: 25, $select: 'id,subject,toRecipients,sentDateTime', $orderby: 'sentDateTime desc' } });
    return (r.value || []) as any[];
  } catch {
    return [];
  }
}

export const MS_TOOLS: MTool[] = [
  {
    name: 'outlook_search',
    title: 'Mail zoeken (Outlook)',
    kind: 'read',
    description:
      'Zoek in Outlook-mail. query is KQL, bijv. "from:klant@voorbeeld.nl", "subject:factuur", "hasattachments:true" of gewoon zoekwoorden; folder is inbox, sentitems, drafts, archive of de naam van een eigen map. Zonder query: de nieuwste berichten van de map (standaard inbox). Geeft id, afzender, ontvangers, onderwerp, datum, gelezen en een fragment.',
    input: {
      query: z.string().optional().describe('KQL-zoekopdracht (leeg = de nieuwste berichten)'),
      folder: z.string().optional().describe('inbox, sentitems, drafts, archive, deleteditems, junkemail of de naam van een map'),
      limit: z.number().int().min(1).max(50).optional().describe('Standaard 10, hoogstens 50'),
    },
    run: (a, g) => search(g, a),
  },
  {
    name: 'outlook_read',
    title: 'Mail lezen (Outlook)',
    kind: 'read',
    description: 'Lees één Outlook-mail helemaal, als platte tekst (zie outlook_search voor het id).',
    input: { id: z.string().min(1) },
    run: async (a, g) => {
      const m = await g('GET', `/me/messages/${encodeURIComponent(a.id)}`, {
        query: { $select: 'id,from,toRecipients,ccRecipients,replyTo,subject,receivedDateTime,sentDateTime,isRead,body,bodyPreview,conversationId,internetMessageId,hasAttachments,webLink' },
        headers: { prefer: 'outlook.body-content-type="text"' },
      });
      let attachments: string[] = [];
      if (m.hasAttachments) attachments = (((await g('GET', `/me/messages/${encodeURIComponent(a.id)}/attachments`, { query: { $select: 'name' } }).catch(() => ({}))).value || []) as any[]).map((x) => String(x.name || ''));
      return { id: m.id, conversationId: m.conversationId, from: who(m.from), to: whoList(m.toRecipients), cc: whoList(m.ccRecipients), replyTo: whoList(m.replyTo), subject: m.subject || '', receivedDateTime: m.receivedDateTime, sentDateTime: m.sentDateTime, isRead: !!m.isRead, internetMessageId: m.internetMessageId || '', attachments, link: m.webLink, body: bodyText(m.body).slice(0, 20_000) };
    },
  },
  {
    name: 'outlook_draft',
    title: 'Concept maken (Outlook)',
    kind: 'write',
    description: 'Zet een concept-e-mail klaar in Outlook (wordt niet verstuurd). Voor een antwoord: geef replyTo (het id uit outlook_search of outlook_read); to en subject mogen dan leeg blijven.',
    input: { to: z.string().optional(), subject: z.string().optional(), body: z.string(), cc: z.string().optional(), replyTo: z.string().optional().describe('Id van het bericht waarop dit een antwoord is') },
    run: async (a, g) => {
      if (a.replyTo) {
        const message: any = {};
        if (a.to) message.toRecipients = recipients(a.to);
        if (a.cc) message.ccRecipients = recipients(a.cc);
        const d = await g('POST', `/me/messages/${encodeURIComponent(a.replyTo)}/createReply`, { body: { comment: a.body, ...(Object.keys(message).length ? { message } : {}) } });
        return { concept: d.id, conversationId: d.conversationId, subject: d.subject, link: d.webLink };
      }
      if (!addresses(a.to).length) throw new Error('Geef een ontvanger (to) met een e-mailadres.');
      const d = await g('POST', '/me/messages', { body: { subject: a.subject || '', body: { contentType: 'Text', content: a.body }, toRecipients: recipients(a.to), ...(a.cc ? { ccRecipients: recipients(a.cc) } : {}) } });
      return { concept: d.id, conversationId: d.conversationId, subject: d.subject, link: d.webLink };
    },
  },
  {
    name: 'outlook_send',
    title: 'Mail versturen (Outlook)',
    kind: 'send',
    description: 'Verstuur een e-mail vanuit het Outlook-adres van de gebruiker. Voor een antwoord: geef replyTo (het id uit outlook_search of outlook_read); het antwoord gaat dan naar de afzender, in hetzelfde gesprek.',
    input: {
      to: z.string().optional().describe('Eén of meer ontvangers, komma-gescheiden; bij een antwoord standaard de afzender'),
      subject: z.string().optional(),
      body: z.string(),
      cc: z.string().optional(),
      replyTo: z.string().optional().describe('Id van het bericht waarop dit een antwoord is'),
      again: z.boolean().optional().describe('Alleen als er kort geleden al een mail met dit onderwerp naar deze ontvanger ging en dit bewust een tweede is'),
    },
    run: async (a, g) => {
      let to: string[] = addresses(a.to);
      let subject = String(a.subject || '');
      if (a.replyTo) {
        const orig = await g('GET', `/me/messages/${encodeURIComponent(a.replyTo)}`, { query: { $select: 'subject,from,replyTo' } });
        if (!to.length) to = addresses(whoList(orig.replyTo) || who(orig.from));
        if (!subject) subject = String(orig.subject || '');
      } else if (!to.length) throw new Error('Geef een ontvanger (to) met een e-mailadres.');
      // The same mail to the same person minutes ago (a turn that was resumed, two bots on one thread): not again.
      if (!a.again && to.length) {
        const want = new Set(to.map((x) => x.toLowerCase()));
        const twin = (await recentlySent(g)).find((m) => norm(m.subject) === norm(subject) && Math.abs(Date.now() - (Date.parse(m.sentDateTime) || 0)) < SAME_MAIL_MS && ((m.toRecipients || []) as any[]).some((r) => want.has(String(r?.emailAddress?.address || '').toLowerCase())));
        if (twin) throw new Error(`Niet verstuurd: aan deze ontvanger ging ${Math.max(1, Math.round((Date.now() - Date.parse(twin.sentDateTime)) / 60_000))} min geleden al een mail met dit onderwerp (bericht ${twin.id}). Lees die eerst (outlook_read). Is dit echt een tweede bericht, stuur het dan met again: true.`);
      }
      if (a.replyTo) {
        const message: any = {};
        if (a.to) message.toRecipients = recipients(a.to);
        if (a.cc) message.ccRecipients = recipients(a.cc);
        await g('POST', `/me/messages/${encodeURIComponent(a.replyTo)}/reply`, { body: { comment: a.body, ...(Object.keys(message).length ? { message } : {}) } });
        return { verstuurd: true, antwoordOp: a.replyTo, aan: to };
      }
      await g('POST', '/me/sendMail', { body: { message: { subject, body: { contentType: 'Text', content: a.body }, toRecipients: recipients(a.to), ...(a.cc ? { ccRecipients: recipients(a.cc) } : {}) }, saveToSentItems: true } });
      return { verstuurd: true, aan: to, onderwerp: subject };
    },
  },
  {
    name: 'outlook_mark_read',
    title: 'Gelezen markeren (Outlook)',
    kind: 'write',
    description: 'Markeer een Outlook-mail als gelezen (of met read: false weer als ongelezen).',
    input: { id: z.string().min(1), read: z.boolean().optional().describe('Standaard true') },
    run: async (a, g) => {
      await g('PATCH', `/me/messages/${encodeURIComponent(a.id)}`, { body: { isRead: a.read !== false } });
      return { id: a.id, gelezen: a.read !== false };
    },
  },
  {
    name: 'outlook_move',
    title: 'Mail verplaatsen (Outlook)',
    kind: 'write',
    description: 'Verplaats een Outlook-mail naar een andere map: archive (archief), deleteditems (prullenbak), junkemail, inbox, of de naam of het id van een eigen map.',
    input: { id: z.string().min(1), folder: z.string().min(1).describe('Mapnaam of map-id') },
    run: async (a, g) => {
      const m = await g('POST', `/me/messages/${encodeURIComponent(a.id)}/move`, { body: { destinationId: await folderId(g, a.folder) } });
      return { verplaatst: true, map: a.folder, id: m.id };
    },
  },
  {
    name: 'outlook_calendar_events',
    title: 'Afspraken (Outlook)',
    kind: 'read',
    description: 'Afspraken uit de Outlook-agenda in een periode (standaard de komende 7 dagen). Tijden in UTC.',
    input: { from: z.string().optional().describe('Begin, ISO-datum of -tijd'), to: z.string().optional().describe('Einde, ISO-datum of -tijd') },
    run: async (a, g) => {
      const iso = (v: string | undefined, fallback: number) => {
        const d = new Date(v || Date.now() + fallback);
        if (!Number.isFinite(d.getTime())) throw new Error(`Geen geldige datum: ${v}`);
        return d.toISOString();
      };
      const r = await g('GET', '/me/calendarView', { query: { startDateTime: iso(a.from, 0), endDateTime: iso(a.to, 7 * 86_400_000), $top: 100, $orderby: 'start/dateTime', $select: 'id,subject,start,end,location,bodyPreview,attendees,webLink,isAllDay' }, headers: { prefer: 'outlook.timezone="UTC"' } });
      const t = (x: any) => (x?.dateTime ? `${String(x.dateTime).replace(/\.0+$/, '')}${x.timeZone === 'UTC' && !/Z$/.test(x.dateTime) ? 'Z' : ''}` : undefined);
      return ((r.value || []) as any[]).map((e) => ({ id: e.id, title: e.subject, start: t(e.start), end: t(e.end), allDay: !!e.isAllDay, location: e.location?.displayName || undefined, description: e.bodyPreview?.slice(0, 500) || undefined, attendees: ((e.attendees || []) as any[]).map((p) => p?.emailAddress?.address).filter(Boolean), link: e.webLink }));
    },
  },
  {
    name: 'outlook_calendar_create',
    title: 'Afspraak maken (Outlook)',
    kind: 'write',
    description: 'Zet een afspraak in de Outlook-agenda. Er gaan geen uitnodigingen naar anderen.',
    input: { title: z.string(), start: z.string().describe('ISO-tijd, bijv. 2026-11-12T14:00:00+01:00'), end: z.string().describe('ISO-tijd'), description: z.string().optional(), location: z.string().optional() },
    run: async (a, g) => {
      const utc = (v: string) => {
        const d = new Date(v);
        if (!Number.isFinite(d.getTime())) throw new Error(`Geen geldige tijd: ${v}`);
        return { dateTime: d.toISOString().replace(/Z$/, ''), timeZone: 'UTC' };
      };
      const e = await g('POST', '/me/events', { body: { subject: a.title, ...(a.description ? { body: { contentType: 'Text', content: a.description } } : {}), ...(a.location ? { location: { displayName: a.location } } : {}), start: utc(a.start), end: utc(a.end) } });
      return { id: e.id, title: e.subject, link: e.webLink };
    },
  },
];

/** The in-process MCP server of one Microsoft account. */
export function microsoftServer(ctx: Ctx, mgr: McpManager, c: ConnectionRow): McpServer {
  const server = new McpServer({ name: 'Outlook', version: ctx.config.version }, { capabilities: { tools: {} } });
  const g = caller(ctx, mgr, c.id);
  for (const t of MS_TOOLS) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: z.object(t.input), annotations: { readOnlyHint: t.kind === 'read', destructiveHint: t.kind === 'send', openWorldHint: t.kind === 'send' } },
      async (args: any) => {
        try {
          const out = await t.run(args || {}, g);
          return { content: [{ type: 'text' as const, text: typeof out === 'string' ? out : JSON.stringify(out, null, 1) }] };
        } catch (e: any) {
          if (e instanceof AuthRequiredError) throw e;
          const hint = e instanceof GraphError && (e.code === 'ErrorItemNotFound' || e.code === 'ErrorInvalidIdMalformed') ? ' Dit id bestaat niet in deze mailbox: neem het letterlijk over uit outlook_search.' : '';
          return { content: [{ type: 'text' as const, text: `Microsoft gaf een fout: ${cleanError(e)}${hint}` }], isError: true };
        }
      },
    );
  }
  return server;
}

// ---------------------------------------------------------------- login and routes

interface Flow {
  userId: string;
  verifier: string;
  redirectUri: string;
  expires: number;
  /** The account this login is for (logging in again); none with `add`. */
  connId?: string;
  /** "Nog een Microsoft-account": never replaces an account that is already there. */
  add?: boolean;
}
const flows = new Map<string, Flow>();

/** The user's Microsoft accounts, the first connected first. */
export function msConns(ctx: Ctx, userId: string): ConnectionRow[] {
  return ctx.store.find<ConnectionRow>('mcp_connections', { user_id: userId, catalog_id: MS_ID }).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}
/** One Microsoft account: the one with this id, or the first. */
export function msConn(ctx: Ctx, userId: string, connId?: string | null): ConnectionRow | null {
  const all = msConns(ctx, userId);
  return (connId && all.find((c) => c.id === connId)) || all[0] || null;
}

/** The claims of an id token (no signature check needed: it came straight from the token endpoint over TLS). */
function claims(idToken: string): any {
  try {
    return JSON.parse(Buffer.from(String(idToken || '').split('.')[1] || '', 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

const LOCAL_ONLY = 'Outlook koppelen kan alleen op de computer waar TeamBot draait: Microsoft stuurt je na het inloggen terug naar http://localhost. Open TeamBot op die computer (http://localhost) en koppel Outlook daar.';

export function registerMicrosoft(ctx: Ctx, mgr: McpManager, h: GoogleHelpers) {
  const api = ctx.api;
  const loopback = (uri: string) => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(uri);
  /** Entra accepts http://localhost with any port for TeamBot's app; another address (server mode) is not registered. */
  const redirect = (req: Request): string | null => {
    const base = h.baseUrl(req);
    if (!loopback(base)) return null;
    const port = new URL(base).port || String(ctx.config.port || '');
    return `http://localhost${port ? `:${port}` : ''}${MS_CALLBACK_PATH}`;
  };

  /** The account a request is about: ?conn= or { conn }, else the first. */
  const pick = (req: Request) => msConn(ctx, user(req).id, str((req.query as any)?.conn ?? req.body?.conn, 80) || null);
  const state = (req: Request) => {
    const u = user(req);
    const c = pick(req);
    const o: any = c?.oauth || {};
    return {
      /** false: TeamBot runs on another address (server mode); logging in only works on its own computer. */
      local: !!redirect(req),
      email: o.email || null,
      status: !c ? 'off' : o.status === 'connected' ? 'on' : 'expired',
      connection: c ? h.view(c) : null,
      consentUrls: { personal: MS_CONSENT_PERSONAL, work: MS_CONSENT_WORK },
      accounts: msConns(ctx, u.id).map((x) => ({ id: x.id, email: String((x.oauth as any)?.email || ''), status: (x.oauth as any)?.status === 'connected' ? 'on' : 'expired' })),
    };
  };

  api.get('/mcp/microsoft', ah(async (req) => state(req)));

  api.post(
    '/mcp/microsoft/start',
    ah(async (req) => {
      const u = user(req);
      const redirectUri = redirect(req);
      if (!redirectUri) throw bad(LOCAL_ONLY);
      const verifier = crypto.randomBytes(48).toString('base64url');
      const st = crypto.randomBytes(24).toString('base64url');
      for (const [k, f] of flows) if (f.expires < Date.now()) flows.delete(k);
      const add = req.body?.add === true;
      const target = add ? null : pick(req);
      flows.set(sha256(st), { userId: u.id, verifier, redirectUri, expires: Date.now() + 10 * 60_000, connId: target?.id, add });
      const hint = String((target?.oauth as any)?.email || '');
      const q = new URLSearchParams({
        client_id: msClientId(),
        redirect_uri: redirectUri,
        response_type: 'code',
        response_mode: 'query',
        scope: MS_SCOPES.join(' '),
        state: st,
        code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        // Another account: Microsoft lets you choose. Logging in again: the address is filled in.
        ...(add || !hint ? { prompt: 'select_account' } : { login_hint: hint }),
      });
      return { authorizationUrl: `${at(AUTH_URL)}?${q}` };
    }),
  );

  ctx.publicApi.get(
    '/mcp/microsoft/callback',
    ah(async (req, res) => {
      res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
      res.setHeader('cache-control', 'no-store');
      const q = req.query as Record<string, any>;
      const key = sha256(String(q.state || ''));
      const flow = flows.get(key);
      flows.delete(key);
      const fail = (message: string, userId?: string) => {
        if (userId) ctx.events.emit(userId, 'mcp.oauth', { id: MS_ID, microsoft: true, ok: false, error: message });
        res.status(400).type('html').send(h.callbackPage(false, 'Inloggen bij Microsoft mislukt', message, '/#/m/mcp/'));
      };
      if (!flow || flow.expires < Date.now()) return fail('Deze inloglink is verlopen of al gebruikt. Klik in TeamBot opnieuw op “Inloggen met Microsoft”.');
      if (q.error) return fail(q.error === 'access_denied' || q.error === 'consent_required' ? 'Je hebt de toegang niet gegeven. Klik in TeamBot opnieuw op “Inloggen met Microsoft” als je dat wel wilt.' : `Microsoft meldde: ${String(q.error_description || q.error).split(/\r?\n/)[0].slice(0, 200)}`, flow.userId);
      if (!q.code) return fail('Geen code ontvangen van Microsoft.', flow.userId);
      let tok: any;
      try {
        tok = await tokenRequest({ grant_type: 'authorization_code', code: String(q.code), client_id: msClientId(), redirect_uri: flow.redirectUri, code_verifier: flow.verifier, scope: MS_SCOPES.join(' ') });
      } catch (e: any) {
        return fail(`Microsoft weigerde de inlog: ${cleanError(e)}`, flow.userId);
      }
      if (!tok.refresh_token) return fail('Microsoft gaf geen blijvende toegang (offline_access). Probeer het opnieuw en geef alle gevraagde toestemmingen.', flow.userId);
      const cl = claims(tok.id_token);
      let email = String(cl.email || cl.preferred_username || '').trim();
      if (!/@/.test(email)) {
        try {
          const res2 = await net()(at(`${GRAPH}/me`) + '?$select=mail,userPrincipalName', { headers: { authorization: `Bearer ${tok.access_token}` }, signal: AbortSignal.timeout(20_000) });
          const me: any = await res2.json().catch(() => ({}));
          email = String(me.mail || me.userPrincipalName || email || '');
        } catch {
          /* only for display and to tell accounts apart */
        }
      }
      // Which account: the one with this address; else the one this login was for (when it had no address yet); a
      // different address is a new account next to the others (never a silent swap of what the bots were using).
      const all = msConns(ctx, flow.userId);
      const same = email ? all.find((x) => String((x.oauth as any)?.email || '').toLowerCase() === email.toLowerCase()) : undefined;
      const meant = flow.connId ? all.find((x) => x.id === flow.connId) : undefined;
      let c: ConnectionRow | null = same || (meant && (!email || !(meant.oauth as any)?.email) ? meant : null);
      const ts = now();
      const fresh = !c;
      if (!c) {
        const id = newId('mcp_');
        ctx.store.insert('mcp_connections', {
          id,
          user_id: flow.userId,
          catalog_id: MS_ID,
          package: null,
          registry: null,
          name: 'Outlook',
          // Told apart by the address (in the bots' tool list and on the Apps page): there are often two.
          label: email,
          slug: h.uniqueSlug(flow.userId, 'outlook'),
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
        // "Gekoppeld" means the bots can use it; narrowing per bot stays one click away.
        h.setBindings(flow.userId, id, ctx.store.agents(flow.userId).map((a) => a.id));
        ctx.audit(flow.userId, 'mcp.connection.created', { id, name: 'Outlook', transport: 'builtin', catalog: MS_ID });
      }
      ctx.secrets.set(flow.userId, tokenName(c.id), JSON.stringify({ refresh_token: tok.refresh_token, access_token: tok.access_token, expires_at: Date.now() + (Number(tok.expires_in) || 3600) * 1000 }));
      patchOAuth(ctx, c.id, { status: 'connected', connected_at: ts, has_refresh: true, scope: String(tok.scope || ''), ...({ email: email || (c.oauth as any)?.email || '', tenant: String(cl.tid || '') } as any) });
      ctx.store.update('mcp_connections', c.id, { status: 'authorized', last_error: null, updated_at: ts, ...(email && !c.label ? { label: email } : {}) });
      await mgr.stop(c.id, 'opnieuw ingelogd').catch(() => {});
      // TeamBot's own tools: usable the moment the login is back, also when the page was closed.
      try {
        const client = await mgr.client(getConn(ctx, c.id)!, { force: true });
        mgr.syncTools(c.id, (await client.listTools()).tools || []);
        ctx.store.exec('UPDATE mcp_tools SET approved = 1, changed = 0 WHERE connection_id = ? AND present = 1', c.id);
        ctx.store.update('mcp_connections', c.id, { verified_at: ts, verify_result: { ok: true, at: ts }, updated_at: ts });
      } catch (e: any) {
        ctx.log.warn('[mcp] outlook tools not listed', e?.message || e);
      }
      const row = getConn(ctx, c.id)!;
      h.emit(flow.userId, row);
      ctx.events.emit(flow.userId, 'mcp.oauth', { id: c.id, microsoft: true, ok: true, fresh });
      res.type('html').send(h.callbackPage(true, 'Outlook is gekoppeld', 'TeamBot test nu de verbinding. Ga terug naar TeamBot.', '/#/m/mcp/'));
    }),
  );

  /** "Verbinding werkt": one real read of the account and one of the mail. */
  api.post(
    '/mcp/microsoft/test',
    ah(async (req) => {
      const c = pick(req);
      if (!c) throw bad('Outlook is nog niet gekoppeld.');
      const g = caller(ctx, mgr, c.id);
      const probe = async (id: string, name: string, fn: () => Promise<any>) => {
        try {
          await fn();
          return { id, name, ok: true };
        } catch (e: any) {
          return { id, name, ok: false, error: cleanError(e).slice(0, 300), authRequired: e instanceof AuthRequiredError };
        }
      };
      const checks = [await probe('account', 'Account', () => g('GET', '/me', { query: { $select: 'id,mail,userPrincipalName' } })), await probe('mail', 'Mail', () => g('GET', '/me/mailFolders/inbox/messages', { query: { $top: 1, $select: 'id' } }))];
      return { ok: checks.every((x) => x.ok), checks, ...state(req) };
    }),
  );

  // ---- the owner's own mail on the dashboard: the same calls the bots' tools make, for the owner himself

  const tool = (name: string) => MS_TOOLS.find((t) => t.name === name)!;
  const mail = async (req: Request, name: string, args: any) => {
    const c = pick(req);
    if (!c || (c.oauth as any)?.status !== 'connected') throw bad('Outlook is niet gekoppeld. Koppel een Microsoft-account bij Apps.');
    try {
      return await tool(name).run(args, caller(ctx, mgr, c.id));
    } catch (e: any) {
      if (e instanceof AuthRequiredError) throw bad('De inlog bij Microsoft is verlopen. Log opnieuw in bij Apps › Outlook.');
      throw bad(`Microsoft gaf een fout: ${cleanError(e).slice(0, 300)}`);
    }
  };

  // New mail in Outlook starts the routines that wait for mail (trigger "E-mail").
  if (!process.env.NODE_TEST_CONTEXT) {
    const timer = setInterval(() => void watchOutlook(ctx, mgr).catch((e) => ctx.log.warn('[mcp] outlook kijken', cleanError(e))), OUTLOOK_WATCH_MS);
    timer.unref?.();
  }

  /** The inbox or the sent mail (box=sent), optionally searched (q): in the shape of the Gmail list. */
  api.get(
    '/mcp/microsoft/mail',
    ah(async (req) => {
      const c = pick(req);
      if (!c || (c.oauth as any)?.status !== 'connected') return { messages: [], off: 'Outlook is niet gekoppeld. Koppel een Microsoft-account bij Apps.' };
      const rows = await mail(req, 'outlook_search', { query: str(req.query.q, 300).trim() || undefined, folder: req.query.box === 'sent' ? 'sentitems' : 'inbox', limit: Math.min(25, Math.max(1, Number(req.query.limit) || 15)) });
      return { messages: (rows as any[]).map((m) => ({ id: m.id, thread: m.conversationId, from: m.from, to: m.to, subject: m.subject, date: m.receivedDateTime, unread: !m.isRead, snippet: m.preview })) };
    }),
  );

  api.get(
    '/mcp/microsoft/mail/:id',
    ah(async (req) => {
      const m: any = await mail(req, 'outlook_read', { id: str(req.params.id, 400) });
      return { id: m.id, thread: m.conversationId, from: m.from, to: m.to, cc: m.cc, subject: m.subject, date: m.receivedDateTime || m.sentDateTime, unread: false, snippet: '', messageId: m.internetMessageId, attachments: m.attachments, body: m.body };
    }),
  );

  /** The owner answers (replyTo: the message id) or writes a mail himself: it goes out at once, from his own address. */
  api.post(
    '/mcp/microsoft/mail/send',
    ah(async (req) => {
      const to = str(req.body?.to, 500).trim();
      const body = str(req.body?.body, 100_000);
      const replyTo = str(req.body?.replyTo, 400).trim() || undefined;
      if (!replyTo && !/\S+@\S+\.\S+/.test(to)) throw bad('Vul een e-mailadres in.');
      if (!body.trim()) throw bad('Het bericht is leeg.');
      await mail(req, 'outlook_send', { to: replyTo ? undefined : to, subject: str(req.body?.subject, 400).trim(), body, cc: str(req.body?.cc, 500).trim() || undefined, replyTo, again: true });
      ctx.audit(user(req).id, 'mcp.microsoft.mail_sent', { to: to.slice(0, 120), reply: !!replyTo });
      return { ok: true };
    }),
  );
}

// ---------------------------------------------------------------- new mail in Outlook → routines that wait for mail

const OUTLOOK_WATCH_MS = 2 * 60_000;
const OUTLOOK_SEEN = 'microsoft.outlook.seen';

/**
 * New mail in the inbox of a connected Outlook goes to the routines that wait for mail (trigger "E-mail"), per account.
 * Nothing is asked of Microsoft for an owner without such a routine; the mail already there at the first look starts
 * nothing. Returns how many mails were handed over.
 */
export async function watchOutlook(ctx: Ctx, mgr: McpManager, onlyUser?: string): Promise<number> {
  const engine = ctx.services.routines?.engine;
  if (typeof engine?.handleEmail !== 'function') return 0;
  let handed = 0;
  const conns = ctx.store.find<ConnectionRow>('mcp_connections', { catalog_id: MS_ID }).filter((c) => c.enabled && (!onlyUser || c.user_id === onlyUser));
  for (const c of conns) {
    const o: any = c.oauth || {};
    if (o.status !== 'connected') continue;
    if (!ctx.store.one("SELECT 1 AS x FROM routine_triggers WHERE user_id = ? AND kind = 'email' AND enabled = 1 LIMIT 1", c.user_id)) continue;
    const g = caller(ctx, mgr, c.id);
    try {
      const list = await g('GET', '/me/mailFolders/inbox/messages', { query: { $top: 25, $select: 'id', $orderby: 'receivedDateTime desc' } });
      const ids: string[] = ((list.value || []) as any[]).map((m) => String(m.id));
      const seenKey = `${OUTLOOK_SEEN}.${c.id}`;
      const st = ctx.store.getSetting<{ ids: string[] } | null>(c.user_id, seenKey, null);
      const seen = new Set(st?.ids || []);
      const fresh = st ? ids.filter((id) => !seen.has(id)).reverse() : [];
      ctx.store.setSetting(c.user_id, seenKey, { ids: [...new Set([...ids, ...(st?.ids || [])])].slice(0, 400) });
      const own = String(o.email || '').toLowerCase();
      for (const id of fresh.slice(0, 10)) {
        const m = await g('GET', `/me/messages/${encodeURIComponent(id)}`, { query: { $select: 'id,from,toRecipients,subject,receivedDateTime,body,internetMessageId' }, headers: { prefer: 'outlook.body-content-type="text"' } });
        // Only what really came in: not the owner's own mail to himself.
        if (own && String(m.from?.emailAddress?.address || '').toLowerCase() === own) continue;
        engine.handleEmail({
          userId: c.user_id,
          accountId: 'outlook',
          bindingName: String(o.email || 'Outlook'),
          from: who(m.from),
          to: whoList(m.toRecipients),
          subject: m.subject || '',
          date: m.receivedDateTime,
          text: bodyText(m.body).slice(0, 20_000),
          messageId: m.internetMessageId || `outlook:${m.id}`,
          id: m.id,
        });
        handed++;
      }
    } catch (e: any) {
      if (!(e instanceof AuthRequiredError)) ctx.log.warn('[mcp] outlook kijken', cleanError(e).slice(0, 200));
    }
  }
  return handed;
}

/** Disconnecting: the tokens go; Microsoft has no simple revocation for a public client, so the owner is told where. */
export async function revokeMicrosoft(_ctx: Ctx, _c: ConnectionRow): Promise<{ revokedAtService: boolean; detail: string }> {
  return { revokedAtService: false, detail: `TeamBot heeft de toegang gewist. Wil je TeamBot ook bij Microsoft weghalen: ${MS_CONSENT_PERSONAL} (Outlook.com, Hotmail, MSN) of ${MS_CONSENT_WORK} (werk- of schoolaccount).` };
}
