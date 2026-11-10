import fs from 'node:fs';
import path from 'node:path';
import type { Request } from 'express';
import type { Agent, Ctx, ToolRisk } from '../../core/types.js';
import { newId, now } from '../../core/db.js';
import { HttpError, ah, bad, notFound, own, str, user } from '../../core/http.js';
import type { ConnectionRow, ToolRow } from './db.js';
import { BEHIND_GOOGLE, CATALOG, type CatalogEntry, catalogEntry } from './catalog.js';
import { GOOGLE_ID, registerGoogle, revokeGoogle } from './google.js';
import { CALLBACK_PATH, beginOAuth, completeOAuth, connectionSecretPrefix, copyOAuthClient, getConn, prepareOAuth, revokeOAuth, setOAuthClient, sharedOAuthClients } from './oauth.js';
import { isRisk, riskOf, riskRank } from './risk.js';
import type { McpManager } from './runtime.js';
import { label } from './runtime.js';
import { GROUP, effectiveRisk, exposedName, formatContent, logCall, usableTools } from './tools.js';
import { deleteKVSecrets, forbiddenErr, mayUsePrivateNetwork, mayUseStdio, slugify, storeKV, viewKV, cleanError, commandOnPath } from './util.js';
import { type ConnectionPackage, connectionSignature, connectorFromPackage, entryForConn, packageOf } from './package.js';
import { assertMaySelfAuthor, builtinView, decide, enforcePolicy, publisherChange, publisherSettings, unsignedView } from '../skills/publishers.js';
import { isRestricted } from '../../api/member-policy.js';
import { type ConnectionRegistry, type RegistryItem, type Registry, FEATURED, entryFor, iconPath } from './registry.js';
import { budgetParam, isOffline } from '../skills/webcache.js';
import { FALLBACK_ICON_SVG, NO_ICON_PNG } from './icons.js';
import { probeUrl } from './oauth.js';
import { registerImportRoutes } from './import-routes.js';

export function baseUrl(ctx: Ctx, req: Request): string {
  if (ctx.config.publicUrl) return ctx.config.publicUrl.replace(/\/+$/, '');
  const host = String(req.get('host') || '').trim();
  if (!/^[A-Za-z0-9.\-:[\]]{1,255}$/.test(host)) throw bad('Ongeldige host-header');
  return `${req.protocol === 'https' ? 'https' : 'http'}://${host}`;
}

function tools(ctx: Ctx, connId: string): ToolRow[] {
  return ctx.store.find<ToolRow>('mcp_tools', { connection_id: connId }, { order: 'name' });
}

function toolView(c: ConnectionRow, t: ToolRow) {
  return {
    name: t.name,
    exposed: exposedName(c.slug, t.name),
    title: t.title,
    description: t.description,
    input_schema: t.input_schema,
    annotations: t.annotations,
    hint_risk: t.hint_risk,
    server_risk: t.server_risk,
    user_risk: t.user_risk,
    risk: effectiveRisk(t),
    /** "lezen" is TeamBot's own guess (the server gave no annotations): shown as "waarschijnlijk alleen lezen". */
    guessed: t.server_risk === 'read' && riskOf(t.annotations, t.name, t.description).guessed,
    enabled: t.enabled,
    approved: t.approved,
    changed: t.changed,
    present: !!t.present,
    usable: !!t.present && t.enabled && t.approved && !t.changed && !!c.verified_at && (effectiveRisk(t) === 'read' || c.allow_actions),
    first_seen: t.first_seen,
    last_seen: t.last_seen,
  };
}

export function connView(ctx: Ctx, mgr: McpManager, c: ConnectionRow, detail = false) {
  const ts = tools(ctx, c.id).filter((t) => t.present);
  const counts = { total: ts.length, usable: 0, pending: 0, read: 0, write: 0, exec: 0, danger: 0 };
  for (const t of ts) {
    counts[effectiveRisk(t)]++;
    if (!t.approved || t.changed) counts.pending++;
  }
  counts.usable = usableTools(ctx, c).length;
  const entry = entryForConn(c);
  const o = c.oauth || {};
  const v: any = {
    id: c.id,
    catalog_id: c.catalog_id,
    name: c.name,
    label: c.label,
    display: label(c),
    slug: c.slug,
    transport: c.transport,
    command: c.command,
    args: c.args,
    cwd: c.cwd,
    env: viewKV(c.env),
    url: c.url,
    host: c.url ? safeHost(c.url) : null,
    headers: viewKV(c.headers),
    auth: c.auth,
    oauth:
      c.auth === 'oauth'
        ? {
            status: o.status || 'disconnected',
            scope: o.scope || '',
            granted_scope: o.granted_scope || '',
            expires_at: o.expires_at || null,
            has_refresh: !!o.has_refresh,
            authorization_server: o.authorization_server ? safeHost(o.authorization_server) : null,
            preregistered: !!o.preregistered,
            client_id: o.preregistered ? o.client_id : undefined,
            has_client_secret: !!o.client_secret_id,
            connected_at: o.connected_at || null,
            can_revoke: !!(o.discovery as any)?.authorizationServerMetadata?.revocation_endpoint,
          }
        : null,
    trusted: !!c.trusted_at,
    trusted_at: c.trusted_at,
    allow_private: c.allow_private,
    enabled: c.enabled,
    allow_actions: c.allow_actions,
    verified_at: c.verified_at,
    verify_result: c.verify_result,
    status: c.status,
    last_error: c.last_error,
    server_info: c.server_info,
    idle_minutes: c.idle_minutes,
    timeout_sec: c.timeout_sec,
    created_at: c.created_at,
    updated_at: c.updated_at,
    runtime: mgr.status(c.id),
    counts,
    agents: ctx.store.all<{ agent_id: string }>('SELECT agent_id FROM mcp_bindings WHERE connection_id = ?', c.id).map((r) => r.agent_id),
    catalog: entry ? { name: entry.name, source: entry.source, license: entry.license, verification: entry.verification, revokeHelp: entry.revokeHelp, oauthClient: entry.oauthClient, oauthAppHelp: entry.oauthAppHelp, oauthAppGuide: entry.oauthAppGuide } : null,
    signature: connectionSignature(ctx, c),
    package: c.package ? { name: c.package.name || null, version: c.package.version || null, publisher: c.package.publisher?.name || null, fingerprint: c.package.publisher?.fingerprint || null } : null,
    registry: c.registry ? registryView(ctx, c.registry) : null,
    dataDir: c.transport === 'stdio' ? mgr.connDir(c) : undefined,
  };
  if (detail) {
    v.tools = tools(ctx, c.id).map((t) => toolView(c, t));
    v.stderr = mgr.stderrTail(c.id);
    // Own OAuth clients of this user that can be reused here (one Google client for Gmail, Agenda, Drive and Sheets).
    if (c.auth === 'oauth') v.sharedClients = sharedOAuthClients(ctx, c).map((x) => ({ id: x.id, display: label(x), client_id: x.oauth.client_id }));
  }
  return v;
}

function safeHost(u: string) {
  try {
    return new URL(u).host;
  } catch {
    return null;
  }
}

/** Map a registry/network failure onto an HTTP error the UI can show. */
function webFail(e: any): never {
  if (e instanceof HttpError) throw e;
  const status = Number(e?.status) || 502;
  throw new HttpError(status === 404 ? 404 : status === 429 ? 429 : status === 503 ? 503 : 502, String(e?.message || e).slice(0, 300));
}

/** Registry origin of a connection, with the newest version we know of (cache only, no network here). */
function registryView(ctx: Ctx, r: ConnectionRegistry) {
  const latest: string | null = (ctx.services.mcp?.registry as Registry | undefined)?.peekLatest(r.name) ?? null;
  return { name: r.name, version: r.version, option: r.option, kind: r.kind, identifier: r.identifier || null, installedAt: r.installedAt, publishedAt: r.publishedAt || null, latest, updateAvailable: !!latest && latest !== r.version };
}

function ownConn(ctx: Ctx, req: Request): ConnectionRow {
  return own(req, getConn(ctx, String(req.params.id)), 'Koppeling niet gevonden');
}

function uniqueSlug(ctx: Ctx, userId: string, wanted: string, exceptId?: string) {
  const base = slugify(wanted);
  for (let i = 1; i < 1000; i++) {
    const s = i === 1 ? base : `${base.slice(0, 20)}_${i}`;
    const row = ctx.store.one<any>('SELECT id FROM mcp_connections WHERE user_id = ? AND slug = ?', userId, s);
    if (!row || row.id === exceptId) return s;
  }
  return `${base.slice(0, 12)}_${newId().slice(0, 8).toLowerCase()}`;
}

function parseArgs(v: any): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw bad('Argumenten moeten een lijst zijn');
  if (v.length > 64) throw bad('Te veel argumenten');
  return v.map((a) => {
    const s = String(a ?? '');
    if (s.length > 4000) throw bad('Argument te lang');
    if (/[\0\r\n]/.test(s)) throw bad('Argumenten mogen geen regeleinden bevatten');
    return s;
  });
}

function checkUrl(ctx: Ctx, userId: string, raw: string, allowPrivate: boolean): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw bad('Ongeldige URL');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw bad('Alleen http(s)-adressen');
  if (u.username || u.password) throw bad('Zet geen inloggegevens in de URL; gebruik headers of OAuth');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const local = host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host) || host === '::1';
  if (local && !(allowPrivate && mayUsePrivateNetwork(ctx, userId)))
    throw forbiddenErr(mayUsePrivateNetwork(ctx, userId) ? 'Dit is een lokaal adres: zet “Lokaal netwerk toestaan” aan.' : 'Lokale netwerkadressen zijn op deze server alleen voor beheerders.');
  if (u.protocol === 'http:' && !local) throw bad('Gebruik https voor remote servers (http alleen voor lokale adressen)');
  return u.href;
}

function fillDefaults(s: string, dir: string) {
  return s.replace(/\{connDir\}/g, dir.replace(/\\/g, '/'));
}

/** Apply create/update fields to a connection row (validated). */
function applyBody(ctx: Ctx, mgr: McpManager, userId: string, b: any, cur: ConnectionRow | null, id: string): Partial<ConnectionRow> & { securityChanged: boolean } {
  const p: any = {};
  let securityChanged = false;
  const transport = (b.transport ?? cur?.transport ?? 'stdio') as ConnectionRow['transport'];
  if (cur?.transport === 'builtin') {
    // Built into TeamBot (Google): only the name, on/off and the time-outs can change.
    if (b.name !== undefined) p.name = str(b.name, 80).trim() || cur.name;
    if (b.label !== undefined) p.label = str(b.label, 60).trim();
    if (b.enabled !== undefined) p.enabled = !!b.enabled;
    return { ...p, securityChanged: false };
  }
  if (!['stdio', 'http', 'sse'].includes(transport)) throw bad('Ongeldig transport');
  if (transport !== cur?.transport) {
    p.transport = transport;
    securityChanged = true;
  }
  if (b.name !== undefined || !cur) {
    const name = str(b.name, 80).trim();
    if (!name) throw bad('Geef de koppeling een naam');
    p.name = name;
  }
  if (b.label !== undefined) p.label = str(b.label, 60).trim();
  if (transport === 'stdio') {
    if (!mayUseStdio(ctx, userId)) throw forbiddenErr('Lokale programma’s (stdio) zijn op deze server alleen voor beheerders toegestaan.');
    if (b.command !== undefined) p.command = str(b.command, 500).trim();
    if (b.args !== undefined) p.args = parseArgs(b.args);
    if (b.cwd !== undefined) {
      const cwd = str(b.cwd, 1000).trim();
      if (cwd && !path.isAbsolute(cwd)) throw bad('Werkmap moet een volledig pad zijn');
      if (cwd && !fs.existsSync(cwd)) throw bad(`Werkmap bestaat niet: ${cwd}`);
      p.cwd = cwd;
    }
    const cmd = p.command ?? cur?.command ?? '';
    if (!cmd) throw bad('Geef de opdracht die de server start (bijv. npx)');
    if (b.env !== undefined) {
      const dir = mgr.connDir({ id, user_id: userId });
      const env = Array.isArray(b.env) ? b.env.map((e: any) => (e && typeof e.value === 'string' && !e.secret ? { ...e, value: fillDefaults(e.value, dir) } : e)) : b.env;
      p.env = storeKV(ctx, userId, id, 'env', env, cur?.env || []);
    }
    const changed =
      (p.command !== undefined && p.command !== cur?.command) ||
      (p.args !== undefined && JSON.stringify(p.args) !== JSON.stringify(cur?.args || [])) ||
      (p.cwd !== undefined && p.cwd !== (cur?.cwd || '')) ||
      (p.env !== undefined && JSON.stringify(p.env) !== JSON.stringify(cur?.env || []));
    if (changed) securityChanged = true;
    if (b.trust_command === true) p.trusted_at = now();
    else if (changed || !cur) p.trusted_at = null;
    p.url = '';
    p.headers = cur?.headers?.length ? (deleteKVSecrets(ctx, cur.headers), []) : [];
    p.auth = 'none';
  } else {
    const allowPrivate = b.allow_private !== undefined ? !!b.allow_private : !!cur?.allow_private;
    if (allowPrivate && !mayUsePrivateNetwork(ctx, userId)) throw forbiddenErr('Lokale netwerkadressen zijn op deze server alleen voor beheerders.');
    if (b.allow_private !== undefined && allowPrivate !== !!cur?.allow_private) {
      p.allow_private = allowPrivate;
      securityChanged = true;
    }
    if (b.url !== undefined || !cur?.url) {
      const url = checkUrl(ctx, userId, str(b.url ?? cur?.url, 2000).trim(), allowPrivate);
      if (url !== cur?.url) {
        p.url = url;
        securityChanged = true;
      }
    }
    if (b.headers !== undefined) {
      p.headers = storeKV(ctx, userId, id, 'header', b.headers, cur?.headers || []);
      if (JSON.stringify(p.headers) !== JSON.stringify(cur?.headers || [])) securityChanged = true;
    }
    if (b.auth !== undefined) {
      if (!['none', 'headers', 'oauth'].includes(b.auth)) throw bad('Ongeldige authenticatie');
      if (b.auth !== cur?.auth) securityChanged = true;
      p.auth = b.auth;
    } else if (!cur) p.auth = 'none';
    if (cur?.transport === 'stdio') {
      if (cur.env?.length) deleteKVSecrets(ctx, cur.env);
      p.env = [];
      p.command = '';
      p.args = [];
      p.trusted_at = null;
    }
  }
  if (b.enabled !== undefined) p.enabled = !!b.enabled;
  if (b.idle_minutes !== undefined) p.idle_minutes = Math.max(0, Math.min(1440, Math.round(Number(b.idle_minutes) || 0)));
  if (b.timeout_sec !== undefined) p.timeout_sec = Math.max(5, Math.min(600, Math.round(Number(b.timeout_sec) || 60)));
  return { ...p, securityChanged };
}

/** Return the HTML page shown in the browser tab after the OAuth redirect. */
function callbackPage(ok: boolean, title: string, body: string, link?: string) {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1f2937;background:#fff}@media(prefers-color-scheme:dark){body{background:#111827;color:#e5e7eb}a{color:#93c5fd}}h1{font-size:1.25rem;color:${ok ? '#16a34a' : '#dc2626'}}</style></head>
<body><h1>${esc(title)}</h1><p>${esc(body)}</p>${link ? `<p><a href="${esc(link)}">Terug naar TeamBot</a></p>` : ''}<p>Je kunt dit tabblad sluiten.</p></body></html>`;
}

/** Restricted member under a strict publisher policy: templates are installed exactly as published. */
function strictPolicyFor(ctx: Ctx, u: { role: any }) {
  return isRestricted(ctx, u) && publisherSettings(ctx).policy !== 'open';
}

const LOCKED_MSG = 'Op deze server geldt een uitgeversbeleid: je installeert een connector zoals de uitgever hem publiceerde. Adres, opdracht en argumenten zijn niet aan te passen.';

/** Refuse own URL/command/args on top of a template (strict policy), and pin them to the template values. */
function lockToTemplate(b: any, entry: CatalogEntry) {
  const differs = (v: any, want: any) => v !== undefined && JSON.stringify(v) !== JSON.stringify(want);
  if (differs(b.transport, entry.transport)) throw forbiddenErr(LOCKED_MSG);
  if (entry.transport === 'stdio') {
    const extra = entry.argsPrompt && Array.isArray(b.extraArgs) ? b.extraArgs : [];
    if (differs(b.command, entry.command) || (b.args !== undefined && differs(b.args, [...(entry.args || []), ...extra])) || (b.cwd && String(b.cwd).trim())) throw forbiddenErr(LOCKED_MSG);
    b.command = entry.command;
    b.args = [...(entry.args || []), ...extra];
    delete b.cwd;
  } else {
    if (differs(b.url, entry.url) || differs(b.auth, entry.auth) || b.allow_private === true) throw forbiddenErr(LOCKED_MSG);
    b.url = entry.url;
    b.auth = entry.auth;
  }
}

export function registerRoutes(ctx: Ctx, mgr: McpManager, registry?: Registry) {
  const strictFor = (u: { role: any }) => strictPolicyFor(ctx, u);
  const api = ctx.api;
  const emit = (userId: string, c: ConnectionRow | null, id?: string) => ctx.events.emit(userId, 'mcp.updated', c ? connView(ctx, mgr, c) : { id, deleted: true });

  // ---- catalogue ----
  api.get(
    '/mcp/catalog',
    ah(async (req) => {
      const u = user(req);
      const stdioOk = mayUseStdio(ctx, u.id);
      return CATALOG.map((e) => ({
        ...e,
        available: e.transport !== 'stdio' || e.id === 'custom' || stdioOk,
        unavailableReason: e.transport === 'stdio' && e.id !== 'custom' && !stdioOk ? 'Lokale programma’s zijn op deze server alleen voor beheerders.' : undefined,
        commandFound: e.command ? commandOnPath(e.command) : undefined,
        advanced: BEHIND_GOOGLE.has(e.id) || undefined,
        // Built-in templates count as trusted (publisher TeamBot); "Eigen server" is configured by the user.
        signature: e.id === 'custom' ? null : builtinView(),
      }));
    }),
  );

  // ---- connector packages ----
  api.post(
    '/mcp/packages/preview',
    ah(async (req) => {
      const u = user(req);
      const r = connectorFromPackage(ctx, req.body?.package);
      const stdioOk = mayUseStdio(ctx, u.id);
      return {
        entry: {
          ...r.entry,
          available: r.entry.transport !== 'stdio' || stdioOk,
          unavailableReason: r.entry.transport === 'stdio' && !stdioOk ? 'Lokale programma’s zijn op deze server alleen voor beheerders.' : undefined,
          commandFound: r.entry.command ? commandOnPath(r.entry.command) : undefined,
        },
        signature: r.signature,
        policy: decide(ctx, u, r.signature),
        scan: r.scan,
        manifest: r.verification.manifest ? { name: r.verification.manifest.name, version: r.verification.manifest.version, license: r.verification.manifest.license, teambot: r.verification.manifest.teambot } : null,
      };
    }),
  );
  api.get(
    '/mcp/info',
    ah(async (req) => {
      const u = user(req);
      return {
        redirectUri: baseUrl(ctx, req) + CALLBACK_PATH,
        stdioAllowed: mayUseStdio(ctx, u.id),
        privateNetworkAllowed: mayUsePrivateNetwork(ctx, u.id),
        platform: process.platform,
        mode: ctx.config.mode,
      };
    }),
  );

  // ---- MCP Registry (apps from the internet) ----
  const needRegistry = (): Registry => {
    if (!registry) throw new HttpError(501, 'Het MCP-register is niet beschikbaar in deze installatie.');
    return registry;
  };
  const installedFromRegistry = (userId: string) => {
    const m = new Map<string, { id: string; display: string; version: string; option: string }[]>();
    for (const c of ctx.store.find<ConnectionRow>('mcp_connections', { user_id: userId })) {
      if (!c.registry?.name) continue;
      m.set(c.registry.name, [...(m.get(c.registry.name) || []), { id: c.id, display: label(c), version: c.registry.version, option: c.registry.option }]);
    }
    return m;
  };
  const registryCard = (it: RegistryItem, inst: ReturnType<typeof installedFromRegistry>, stdioOk: boolean) => {
    const ok = it.options.filter((o) => o.supported);
    return {
      name: it.name,
      title: it.title,
      description: it.description,
      version: it.version,
      status: it.status,
      publisher: it.publisher,
      publisherKind: it.publisherKind,
      // never the publisher's own URL: the browser loads icons through TeamBot (see icons.ts); none when TeamBot
      // already knows it is not usable (the monogram straight away, no request)
      icon: registry?.iconKnownBad(it) ? null : iconPath(it),
      category: it.category,
      featured: it.featured,
      remote: it.remote,
      local: it.local,
      repository: it.repository,
      websiteUrl: it.websiteUrl,
      updatedAt: it.updatedAt || it.publishedAt,
      kinds: [...new Set(ok.map((o) => o.kind))],
      needsSecrets: ok.length > 0 && ok.every((o) => [...o.env, ...o.headers].some((f) => f.required && f.secret)),
      installable: ok.some((o) => o.kind === 'remote' || stdioOk),
      installed: inst.get(it.name) || [],
    };
  };
  /** Admin takedown (Marktplaats › Meldingen) for registry servers: catalog "mcp-registry", item = server name. */
  const regBlocked = (name: string) => !!ctx.services.skills?.catalogs?.isBlocked?.('app', 'mcp-registry', name);
  const registryInstall = async (userId: string, raw: any) => {
    const reg = needRegistry();
    const name = str(raw?.name, 220);
    if (regBlocked(name)) throw new HttpError(403, 'Deze app is door de beheerder geblokkeerd.');
    const version = str(raw?.version, 64) || 'latest';
    const optKey = str(raw?.option, 40);
    let it: RegistryItem;
    try {
      it = await reg.get(name, version);
    } catch (e) {
      webFail(e);
    }
    const opt = it.options.find((o) => o.key === optKey);
    const license = opt ? await reg.packageLicense(opt).catch(() => null) : null;
    const auth = ['none', 'headers', 'oauth'].includes(raw?.auth) ? raw.auth : undefined;
    const r = entryFor(it, optKey, raw?.inputs && typeof raw.inputs === 'object' && !Array.isArray(raw.inputs) ? raw.inputs : {}, { auth, license });
    const info: ConnectionRegistry = { name: it.name, version: it.version, option: r.option.key, kind: r.option.kind, identifier: r.option.identifier, inputs: r.inputs, publishedAt: it.publishedAt, installedAt: now(), template: r.entry };
    return { entry: r.entry, info, item: it, option: r.option };
  };

  api.get(
    '/mcp/registry/servers',
    ah(async (req) => {
      const u = user(req);
      const reg = needRegistry();
      const q = str(req.query.q, 100).trim();
      const category = str(req.query.category, 60);
      const inst = installedFromRegistry(u.id);
      const stdioOk = mayUseStdio(ctx, u.id);
      try {
        if (!q) {
          const f = await reg.featured(budgetParam(req.query.budget), req.query.early === '1');
          const items = f.items.filter((i) => !regBlocked(i.name)).map((i) => registryCard(i, inst, stdioOk));
          // Nothing from the registry yet (first start, slow or no network): TeamBot's own connectors are ready at once.
          const starterAll = !items.length && !category ? CATALOG.filter((e) => !(ctx.services.skills?.catalogs?.isBlocked?.('app', 'mcp', e.id))) : [];
          return {
            mode: 'featured',
            items: items.filter((i) => !category || i.category === category),
            categories: [...new Set(items.map((i) => i.category))].sort(),
            nextCursor: null,
            stale: f.stale,
            errors: f.errors.slice(0, 5),
            pending: f.pending,
            refreshing: f.refreshing,
            featuredTotal: FEATURED.length,
            starter: starterAll.slice(0, 6).map((e) => ({ id: e.id, title: e.name, description: e.description, publisher: e.publisher })),
            starterTotal: starterAll.length,
            offline: isOffline(),
          };
        }
        const r = await reg.search(q, str(req.query.cursor, 300) || null);
        const items = r.items.filter((i) => i.status !== 'deleted' && !regBlocked(i.name)).map((i) => registryCard(i, inst, stdioOk));
        return { mode: 'search', items: items.filter((i) => !category || i.category === category), categories: [...new Set(items.map((i) => i.category))].sort(), nextCursor: r.nextCursor, stale: r.stale, error: r.error, offline: isOffline() };
      } catch (e) {
        webFail(e);
      }
    }),
  );

  /**
   * App icon via TeamBot (cached, validated); the publisher never sees the viewer. When unusable: a neutral fallback
   * icon; with `miss=none` a 1x1 transparent PNG (`x-teambot-icon: none`), so the marketplace draws its own monogram
   * for the app without a failed request in the console; `miss=404` (older pages) a 404.
   */
  api.get(
    '/mcp/registry/icon',
    ah(async (req, res) => {
      user(req);
      const name = str(req.query.name, 220);
      const icon = registry && name && !regBlocked(name) ? await registry.icon(name) : null;
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('content-security-policy', "default-src 'none'; sandbox");
      res.setHeader('content-disposition', 'inline');
      if (icon) {
        res.setHeader('cache-control', 'private, max-age=86400');
        res.type(icon.type).send(icon.body);
      } else if (req.query.miss === 'none') {
        res.setHeader('cache-control', 'private, max-age=3600');
        res.setHeader('x-teambot-icon', 'none');
        res.type('image/png').send(NO_ICON_PNG);
      } else if (req.query.miss === '404') {
        res.setHeader('cache-control', 'private, max-age=3600');
        res.status(404).type('text/plain').send('Geen icoon');
      } else {
        res.setHeader('cache-control', 'private, max-age=3600');
        res.setHeader('x-teambot-icon', 'fallback');
        res.type('image/svg+xml').send(FALLBACK_ICON_SVG);
      }
    }),
  );

  api.get(
    '/mcp/registry/server',
    ah(async (req) => {
      const u = user(req);
      const reg = needRegistry();
      const name = str(req.query.name, 220);
      const version = str(req.query.version, 64) || 'latest';
      if (regBlocked(name)) throw new HttpError(403, 'Deze app is door de beheerder geblokkeerd.');
      let it;
      try {
        it = await reg.get(name, version);
      } catch (e) {
        webFail(e);
      }
      const stdioOk = mayUseStdio(ctx, u.id);
      const versions = await reg.versions(it.name);
      const pkgOpt = it.options.find((o) => o.supported && (o.kind === 'npm' || o.kind === 'pypi'));
      const license = pkgOpt ? await reg.packageLicense(pkgOpt) : null;
      const sig = unsignedView();
      return {
        ...registryCard(it, installedFromRegistry(u.id), stdioOk),
        statusMessage: it.statusMessage,
        publishedAt: it.publishedAt,
        isLatest: it.isLatest,
        subfolder: it.subfolder,
        options: it.options.map((o) => ({
          ...o,
          available: o.supported && (o.kind === 'remote' || stdioOk),
          unavailableReason: !o.supported ? o.reason : o.kind !== 'remote' && !stdioOk ? 'Lokale programma’s zijn op deze server alleen voor beheerders.' : undefined,
        })),
        versions,
        license,
        licenseSource: license ? (pkgOpt?.kind === 'npm' ? 'npm' : pkgOpt?.kind === 'pypi' ? 'PyPI' : null) : null,
        registryUrl: `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(it.name)}/versions/${encodeURIComponent(it.version)}`,
        stale: it.stale,
        fetchedAt: it.fetchedAt,
        signature: sig,
        policy: decide(ctx, u, sig),
      };
    }),
  );

  /** The connector template for one install option (shown in the wizard before anything is created or started). */
  api.post(
    '/mcp/registry/entry',
    ah(async (req) => {
      const u = user(req);
      const r = await registryInstall(u.id, req.body || {});
      let probe: { status: number; oauth: boolean; error?: string } | null = null;
      if (r.entry.transport !== 'stdio' && !req.body?.auth) {
        // Ask the server (without any credentials) whether it wants a login, so OAuth is pre-selected when needed.
        probe = await probeUrl(ctx, u.id, r.entry.url!, r.entry.transport as 'http' | 'sse');
        if (probe.oauth) {
          r.entry.auth = 'oauth';
          r.entry.oauthClient = 'dynamic';
        }
      }
      const stdioOk = mayUseStdio(ctx, u.id);
      const sig = unsignedView();
      return {
        entry: {
          ...r.entry,
          available: r.entry.transport !== 'stdio' || stdioOk,
          unavailableReason: r.entry.transport === 'stdio' && !stdioOk ? 'Lokale programma’s zijn op deze server alleen voor beheerders.' : undefined,
          commandFound: r.entry.command ? commandOnPath(r.entry.command) : undefined,
          signature: sig,
        },
        registry: { name: r.info.name, version: r.info.version, option: r.info.option, inputs: r.info.inputs, auth: r.entry.auth },
        probe,
        policy: decide(ctx, u, sig),
      };
    }),
  );

  /** Ask the registry for the newest version of every server this user installed from it (cached for an hour). */
  api.post(
    '/mcp/registry/check-updates',
    ah(async (req) => {
      const u = user(req);
      const reg = needRegistry();
      const conns = ctx.store.find<ConnectionRow>('mcp_connections', { user_id: u.id }).filter((c) => c.registry?.name);
      const errors: { name: string; error: string }[] = [];
      for (const name of [...new Set(conns.map((c) => c.registry!.name))]) {
        try {
          await reg.get(name, 'latest', { force: req.body?.force === true });
        } catch (e: any) {
          errors.push({ name, error: String(e?.message || e).slice(0, 300) });
        }
      }
      return { checked: conns.length, updates: conns.map((c) => ({ id: c.id, display: label(c), ...registryView(ctx, c.registry!) })).filter((x) => x.updateAvailable), errors };
    }),
  );

  /** Update a registry-installed connection to the newest (or a given) version; the read-only test and trust start over. */
  api.post(
    '/mcp/connections/:id/registry-update',
    ah(async (req) => {
      const u = user(req);
      const reg = needRegistry();
      const c = ownConn(ctx, req);
      if (!c.registry) throw bad('Deze koppeling komt niet uit het MCP-register.');
      const cur = c.registry;
      let it: RegistryItem;
      try {
        it = await reg.get(cur.name, str(req.body?.version, 64) || 'latest', { force: true });
      } catch (e) {
        webFail(e);
      }
      if (it.version === cur.version) return { ok: true, unchanged: true, from: cur.version, to: it.version, missing: [], needsTrust: false, connection: connView(ctx, mgr, c, true) };
      const opt =
        it.options.find((o) => o.key === cur.option && o.kind === cur.kind && o.supported) ||
        it.options.find((o) => o.kind === cur.kind && (o.identifier || '') === (cur.identifier || '') && o.supported) ||
        it.options.find((o) => o.kind === cur.kind && o.supported);
      if (!opt) throw bad('De nieuwe versie biedt deze installatievorm niet meer aan; installeer hem opnieuw vanuit de marktplaats.');
      enforcePolicy(ctx, u, unsignedView(), { override: req.body?.overridePolicy === true, what: 'connector', item: it.name });
      const license = await reg.packageLicense(opt).catch(() => null);
      const r = entryFor(it, opt.key, cur.inputs || {}, { auth: c.auth, license });
      if (r.entry.transport !== c.transport) throw bad('De nieuwe versie gebruikt een ander transport; installeer hem als nieuwe koppeling.');
      const body: any = r.entry.transport === 'stdio' ? { command: r.entry.command, args: r.entry.args, ...(req.body?.trust_command === true ? { trust_command: true } : {}) } : { url: r.entry.url, auth: c.auth };
      const { securityChanged, ...p } = applyBody(ctx, mgr, u.id, body, c, c.id);
      void securityChanged;
      const info: ConnectionRegistry = { ...cur, version: it.version, option: opt.key, identifier: opt.identifier, inputs: r.inputs, publishedAt: it.publishedAt, installedAt: now(), template: r.entry };
      Object.assign(p, { registry: info, verified_at: null, allow_actions: false, verify_result: null });
      await mgr.stop(c.id, 'nieuwe versie uit het MCP-register');
      ctx.store.update('mcp_connections', c.id, { ...p, updated_at: now() });
      const have = new Set([...(c.env || []), ...(c.headers || [])].map((k) => k.name.toLowerCase()));
      const missing = [...(r.entry.env || []), ...(r.entry.headers || [])].filter((f) => f.required && !have.has(f.name.toLowerCase())).map((f) => f.name);
      ctx.audit(u.id, 'mcp.connection.registry_updated', { id: c.id, name: it.name, from: cur.version, to: it.version });
      const fresh = getConn(ctx, c.id)!;
      emit(u.id, fresh);
      return { ok: true, unchanged: false, from: cur.version, to: it.version, missing, needsTrust: fresh.transport === 'stdio' && !fresh.trusted_at, connection: connView(ctx, mgr, fresh, true) };
    }),
  );

  // ---- connections ----
  api.get(
    '/mcp/connections',
    ah(async (req) => {
      const u = user(req);
      return ctx.store.find<ConnectionRow>('mcp_connections', { user_id: u.id }, { order: 'name, label' }).map((c) => connView(ctx, mgr, c));
    }),
  );

  api.post(
    '/mcp/connections',
    ah(async (req) => connView(ctx, mgr, await createConnection(user(req), { ...(req.body || {}) }), true)),
  );

  /** Create a connection (catalogue template, package, registry server or own server); also used by the import. */
  async function createConnection(u: ReturnType<typeof user>, b: any): Promise<ConnectionRow> {
    {
      let entry = catalogEntry(b.catalog_id);
      let pkg: ConnectionPackage | null = null;
      let reg: ConnectionRegistry | null = null;
      if (b.package) {
        // Signed (or unsigned) connector package: verify, apply the publisher policy, then treat it like a template.
        const r = connectorFromPackage(ctx, b.package);
        enforcePolicy(ctx, u, r.signature, { override: b.overridePolicy === true, what: 'connector', item: r.verification.manifest?.name || r.entry.name });
        entry = r.entry;
        pkg = packageOf(r.verification, r.entry);
        delete b.catalog_id;
      } else if (b.registry) {
        // MCP Registry: the template is rebuilt here from the (cached) registry record — never taken from the browser —
        // and the command/URL are pinned to it. Registry records are unsigned, so the publisher policy applies.
        if (!registry) throw new HttpError(501, 'Het MCP-register is niet beschikbaar.');
        const r = await registryInstall(u.id, b.registry);
        enforcePolicy(ctx, u, unsignedView(), { override: b.overridePolicy === true, what: 'connector', item: r.info.name });
        entry = r.entry;
        reg = r.info;
        delete b.catalog_id;
        b.transport = entry.transport;
        if (entry.transport === 'stdio') {
          b.command = entry.command;
          b.args = [...(entry.args || [])];
        } else {
          b.url = entry.url;
          b.auth = entry.auth;
          delete b.allow_private;
        }
      } else {
        if (b.catalog_id && !entry) throw bad('Onbekend catalogus-item');
        if (!entry || entry.id === 'custom') assertMaySelfAuthor(ctx, u, 'eigen connectors toevoegen');
      }
      // Least privilege (0.4, package H): no folders given → only the work folders of the bots this connection is for.
      // Per team (package B4): the bots' team folder when they may write there, else their work folder. Bots of two
      // teams never share one such server (it would see both teams' folders), and the app is then for that team only.
      let onlyTeam: string | null = null;
      if (entry?.argsPrompt?.defaultWorkFolders && b.args === undefined && !(Array.isArray(b.extraArgs) && b.extraArgs.some((x: any) => String(x ?? '').trim()))) {
        const ids: string[] = Array.isArray(b.agentIds) ? b.agentIds.map(String) : [];
        const bots = ids.map((x) => ctx.store.agent(x)).filter((a) => !!a && a.user_id === u.id && !!a.workspace) as Agent[];
        const teams = ctx.services.teams;
        const homes = new Set(bots.map((a) => teams?.teamOf?.(a.id)).filter(Boolean) as string[]);
        if (teams?.multi?.(u.id) && homes.size > 1) throw bad('Deze bots horen bij verschillende teams. Maak per team een eigen koppeling, zodat geen bot via deze app in de map van een ander team komt.');
        const teamDir = (a: Agent): string | null => {
          try {
            const r = (teams?.foldersFor?.(a) || []).find((x: any) => x?.kind === 'team' && x.mode === 'rw' && x.path);
            return r && fs.existsSync(r.path) ? r.path : null;
          } catch {
            return null;
          }
        };
        const dirs = [...new Set(bots.map((a) => teamDir(a) || a.workspace))];
        if (!dirs.length) throw bad('Kies minstens één bot: de server krijgt dan alleen de teammap of werkmap van die bot. Of vul zelf een map in.');
        for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });
        b.extraArgs = dirs;
        if (teams?.multi?.(u.id) && homes.size === 1) onlyTeam = [...homes][0];
      }
      if (entry && entry.id !== 'custom' && strictFor(u)) lockToTemplate(b, entry);
      const id = newId('mcp_');
      if (entry && entry.id !== 'custom') {
        b.name = b.name || entry.name;
        b.transport = b.transport || entry.transport;
        if (entry.transport === 'stdio') {
          b.command = b.command ?? entry.command;
          b.args = b.args ?? [...(entry.args || []), ...(Array.isArray(b.extraArgs) ? b.extraArgs : [])];
          if (b.env === undefined && entry.env) b.env = entry.env.filter((f) => f.default).map((f) => ({ name: f.name, value: f.default }));
        } else {
          b.url = b.url ?? entry.url;
          b.auth = b.auth ?? entry.auth;
        }
      }
      const fields = applyBody(ctx, mgr, u.id, b, null, id);
      const { securityChanged, ...p } = fields;
      void securityChanged;
      const ts = now();
      const row: ConnectionRow = {
        id,
        user_id: u.id,
        catalog_id: pkg || reg ? null : (entry?.id ?? null),
        package: pkg,
        registry: reg,
        name: p.name!,
        label: p.label ?? '',
        slug: uniqueSlug(ctx, u.id, `${p.name}${p.label ? '_' + p.label : ''}`),
        transport: p.transport || 'stdio',
        command: p.command ?? '',
        args: p.args ?? [],
        cwd: p.cwd ?? '',
        env: p.env ?? [],
        url: p.url ?? '',
        headers: p.headers ?? [],
        auth: (p.auth as any) ?? 'none',
        oauth: {},
        trusted_at: p.trusted_at ?? null,
        allow_private: !!p.allow_private,
        enabled: p.enabled ?? true,
        allow_actions: false,
        verified_at: null,
        verify_result: null,
        status: 'new',
        last_error: null,
        server_info: null,
        idle_minutes: p.idle_minutes ?? 10,
        timeout_sec: p.timeout_sec ?? 60,
        created_at: ts,
        updated_at: ts,
      };
      ctx.store.insert('mcp_connections', row);
      if (row.auth === 'oauth' && b.oauth_client_id) setOAuthClient(ctx, row, str(b.oauth_client_id, 300), b.oauth_client_secret ? str(b.oauth_client_secret, 2000) : undefined);
      else if (row.auth === 'oauth' && b.oauth_client_from) {
        const from = getConn(ctx, str(b.oauth_client_from, 60));
        try {
          if (from?.user_id === u.id) copyOAuthClient(ctx, from, getConn(ctx, id)!);
        } catch {
          /* not reusable here: the client can still be filled in at "Inloggen" */
        }
      }
      if (Array.isArray(b.agentIds)) setBindings(ctx, u.id, id, b.agentIds);
      // Pointed at one team's folder (package B4): the app is for that team only (Instellingen › Teams can widen it).
      if (onlyTeam) {
        try {
          ctx.services.teams?.setKeyScope?.(u.id, 'app', id, onlyTeam);
        } catch (e: any) {
          ctx.log.warn('[mcp] team scope not set', e?.message || e);
        }
      }
      ctx.audit(u.id, 'mcp.connection.created', { id, name: row.name, label: row.label, transport: row.transport, host: row.url ? safeHost(row.url) : undefined, command: row.command || undefined, catalog: row.catalog_id, package: pkg ? { name: pkg.name, version: pkg.version, signature: pkg.state, fingerprint: pkg.publisher?.fingerprint } : undefined, registry: reg ? { name: reg.name, version: reg.version, option: reg.option, identifier: reg.identifier } : undefined });
      const c = getConn(ctx, id)!;
      emit(u.id, c);
      return c;
    }
  }

  registerGoogle(ctx, mgr, { baseUrl: (req) => baseUrl(ctx, req), uniqueSlug: (userId, wanted) => uniqueSlug(ctx, userId, wanted), callbackPage, emit, view: (c) => connView(ctx, mgr, c, true), setBindings: (userId, connId, ids) => setBindings(ctx, userId, connId, ids) });
  registerImportRoutes(ctx, mgr, { createConnection, probe: (userId, url, transport) => probeUrl(ctx, userId, url, transport), view: (c) => connView(ctx, mgr, c) });

  api.get('/mcp/connections/:id', ah(async (req) => connView(ctx, mgr, ownConn(ctx, req), true)));

  api.patch(
    '/mcp/connections/:id',
    ah(async (req) => {
      const u = user(req);
      const c = ownConn(ctx, req);
      const b = req.body || {};
      if (strictFor(u)) {
        // Strict publisher policy: a member can set labels, secrets and timeouts, not point the connection elsewhere.
        const differs = (k: string, cur: any) => b[k] !== undefined && JSON.stringify(b[k]) !== JSON.stringify(cur);
        if (differs('transport', c.transport) || differs('url', c.url) || differs('command', c.command) || differs('args', c.args) || differs('cwd', c.cwd) || differs('auth', c.auth) || (b.allow_private === true && !c.allow_private)) throw forbiddenErr(LOCKED_MSG);
      }
      const { securityChanged, ...p } = applyBody(ctx, mgr, u.id, b, c, c.id);
      if (p.name !== undefined || p.label !== undefined) {
        const n = p.name ?? c.name;
        const l = p.label ?? c.label;
        if (n !== c.name || l !== c.label) (p as any).slug = uniqueSlug(ctx, u.id, `${n}${l ? '_' + l : ''}`, c.id);
      }
      if (securityChanged) {
        // New command/URL/credentials: the read-only test has to be repeated before actions are allowed again.
        Object.assign(p, { verified_at: null, allow_actions: false, verify_result: null });
        await mgr.stop(c.id, 'instellingen gewijzigd');
        if (c.auth === 'oauth' && p.url && p.url !== c.url) await revokeOAuth(ctx, c).catch(() => {});
      }
      if (p.enabled === false) await mgr.stop(c.id, 'uitgezet');
      ctx.store.update('mcp_connections', c.id, { ...p, updated_at: now() });
      if (b.oauth_client_id !== undefined) setOAuthClient(ctx, getConn(ctx, c.id)!, str(b.oauth_client_id, 300), b.oauth_client_secret ? str(b.oauth_client_secret, 2000) : undefined);
      else if (b.oauth_client_from !== undefined && c.auth === 'oauth') {
        const from = getConn(ctx, str(b.oauth_client_from, 60));
        if (!from || from.user_id !== u.id) throw notFound('Koppeling niet gevonden');
        copyOAuthClient(ctx, from, getConn(ctx, c.id)!);
      }
      ctx.audit(u.id, 'mcp.connection.updated', { id: c.id, fields: Object.keys(b).filter((k) => !/secret|value/i.test(k)), securityChanged });
      const fresh = getConn(ctx, c.id)!;
      emit(u.id, fresh);
      return connView(ctx, mgr, fresh, true);
    }),
  );

  /**
   * Update a package-installed connection to a new version of the same package. Same publisher key required
   * (or an explicit confirmation); the publisher policy applies; the read-only test has to be repeated.
   */
  api.post(
    '/mcp/connections/:id/package',
    ah(async (req) => {
      const u = user(req);
      const c = ownConn(ctx, req);
      const b = req.body || {};
      if (!c.package) throw bad('Deze koppeling is niet uit een pakket geïnstalleerd.');
      const r = connectorFromPackage(ctx, b.package);
      const name = r.verification.manifest?.name;
      if (c.package.name && name !== c.package.name) throw bad(`Dit is een ander pakket (${name || 'zonder naam'}), geen nieuwe versie van ${c.package.name}.`);
      if (r.entry.transport !== c.transport) throw bad('De nieuwe versie gebruikt een ander transport; installeer hem als nieuwe koppeling.');
      enforcePolicy(ctx, u, r.signature, { override: b.overridePolicy === true, what: 'connector', item: name || c.name });
      const change = publisherChange(c.package, r.signature);
      if (change && b.confirmPublisherChange !== true) throw new HttpError(409, change.reason, 'publisher-changed');
      const body: any = {};
      if (r.entry.transport === 'stdio') {
        const oldArgs = c.package.template.args || [];
        const extra = oldArgs.every((a, i) => c.args[i] === a) ? c.args.slice(oldArgs.length) : [];
        body.command = r.entry.command;
        body.args = [...(r.entry.args || []), ...(r.entry.argsPrompt ? extra : [])];
      } else {
        body.url = r.entry.url;
        body.auth = r.entry.auth;
      }
      const { securityChanged, ...p } = applyBody(ctx, mgr, u.id, body, c, c.id);
      void securityChanged;
      // A new template version always needs a fresh read-only test before actions are allowed again.
      Object.assign(p, { package: packageOf(r.verification, r.entry), verified_at: null, allow_actions: false, verify_result: null });
      await mgr.stop(c.id, 'nieuwe pakketversie');
      if (c.auth === 'oauth' && p.url && p.url !== c.url) await revokeOAuth(ctx, c).catch(() => {});
      ctx.store.update('mcp_connections', c.id, { ...p, updated_at: now() });
      ctx.audit(u.id, 'mcp.connection.package_updated', { id: c.id, package: name, from: c.package.version, to: r.verification.manifest?.version, signature: r.signature.state, fingerprint: r.signature.fingerprint });
      if (change) ctx.audit(u.id, 'package.publisher_changed', { what: 'connector', item: name, from: change.from, to: change.to });
      const fresh = getConn(ctx, c.id)!;
      emit(u.id, fresh);
      return connView(ctx, mgr, fresh, true);
    }),
  );

  api.delete(
    '/mcp/connections/:id',
    ah(async (req) => {
      const u = user(req);
      const c = ownConn(ctx, req);
      let revoke = { revokedAtService: false, detail: '' };
      if (c.auth === 'oauth') revoke = await revokeOAuth(ctx, c, { forget: true });
      else if (c.catalog_id === GOOGLE_ID) revoke = await revokeGoogle(ctx, c);
      await mgr.remove(c.id);
      deleteKVSecrets(ctx, c.env);
      deleteKVSecrets(ctx, c.headers);
      for (const s of ctx.secrets.list(u.id)) if (s.name.startsWith(connectionSecretPrefix(c.id))) ctx.secrets.delete(s.id);
      ctx.store.tx(() => {
        ctx.store.exec('DELETE FROM mcp_tools WHERE connection_id = ?', c.id);
        ctx.store.exec('DELETE FROM mcp_bindings WHERE connection_id = ?', c.id);
        ctx.store.exec('DELETE FROM mcp_calls WHERE connection_id = ?', c.id);
        ctx.store.exec('DELETE FROM mcp_oauth_flows WHERE connection_id = ?', c.id);
        ctx.store.remove('mcp_connections', c.id);
      });
      const dir = mgr.connDir(c);
      let dataDeleted = false;
      if (req.query.deleteData === '1' && fs.existsSync(dir) && dir.startsWith(path.join(ctx.config.dataDir, 'mcp'))) {
        fs.rmSync(dir, { recursive: true, force: true });
        dataDeleted = true;
      }
      ctx.audit(u.id, 'mcp.connection.deleted', { id: c.id, name: c.name, label: c.label, revokedAtService: revoke.revokedAtService, dataDeleted });
      emit(u.id, null, c.id);
      return { ok: true, ...revoke, dataDeleted, dataDir: !dataDeleted && fs.existsSync(dir) ? dir : null };
    }),
  );

  // ---- lifecycle ----
  api.post(
    '/mcp/connections/:id/restart',
    ah(async (req) => {
      const u = user(req);
      const c = ownConn(ctx, req);
      let error: string | null = null;
      try {
        await mgr.restart(c);
      } catch (e: any) {
        error = cleanError(e);
      }
      ctx.audit(u.id, 'mcp.restart', { id: c.id, ok: !error });
      const fresh = getConn(ctx, c.id)!;
      emit(u.id, fresh);
      return { ok: !error, error, connection: connView(ctx, mgr, fresh, true) };
    }),
  );
  api.post(
    '/mcp/connections/:id/stop',
    ah(async (req) => {
      const c = ownConn(ctx, req);
      await mgr.stop(c.id, 'handmatig gestopt');
      const fresh = getConn(ctx, c.id)!;
      emit(c.user_id, fresh);
      return connView(ctx, mgr, fresh, true);
    }),
  );

  /** Read-only test: connect, tools/list, optionally one read tool. Passing approves the tool list. */
  api.post(
    '/mcp/connections/:id/test',
    ah(async (req) => {
      const u = user(req);
      const c = ownConn(ctx, req);
      const b = req.body || {};
      const started = Date.now();
      try {
        const client = await mgr.client(c, { force: true });
        try {
          await client.ping({ timeout: 10_000 });
        } catch {
          /* ping is optional for some servers */
        }
        if (client.getServerCapabilities()?.tools) {
          const list: any[] = [];
          let cursor: string | undefined;
          for (let i = 0; i < 20; i++) {
            const r = await client.listTools(cursor ? { cursor } : undefined, { timeout: c.timeout_sec * 1000 });
            list.push(...(r.tools || []));
            cursor = r.nextCursor;
            if (!cursor) break;
          }
          mgr.syncTools(c.id, list);
        }
        let sample: any = null;
        if (b.tool) {
          const t = ctx.store.one<any>('SELECT * FROM mcp_tools WHERE connection_id = ? AND name = ? AND present = 1', c.id, String(b.tool));
          const row = t ? ctx.store.decode<ToolRow>('mcp_tools', t) : null;
          if (!row) throw bad('Onbekende tool');
          if (effectiveRisk(row) !== 'read') throw bad('In de test mogen alleen leestools draaien.');
          const args = b.args && typeof b.args === 'object' && !Array.isArray(b.args) ? b.args : {};
          const t0 = Date.now();
          const res: any = await mgr.use(c, (cl) => cl.callTool({ name: row.name, arguments: args }, { timeout: c.timeout_sec * 1000 }));
          const f = formatContent(ctx, u.id, null, `${c.slug}-test`, res?.content || [], res?.structuredContent);
          logCall(ctx, { userId: u.id, connId: c.id, kind: 'test', tool: row.name, risk: 'read', summary: JSON.stringify(args).slice(0, 240), ok: !res?.isError, error: res?.isError ? f.text.slice(0, 300) : null, ms: Date.now() - t0 });
          sample = { tool: row.name, isError: !!res?.isError, text: f.text.slice(0, 4000), attachments: f.attachments };
        }
        const ts = now();
        ctx.store.exec('UPDATE mcp_tools SET approved = 1, changed = 0 WHERE connection_id = ? AND present = 1', c.id);
        const result = { ok: true, at: ts, ms: Date.now() - started, tools: ctx.store.one<any>('SELECT COUNT(*) n FROM mcp_tools WHERE connection_id = ? AND present = 1', c.id)?.n ?? 0, sample: sample ? { tool: sample.tool, isError: sample.isError } : null };
        ctx.store.update('mcp_connections', c.id, { verified_at: ts, verify_result: result, last_error: null, updated_at: ts });
        logCall(ctx, { userId: u.id, connId: c.id, kind: 'test', tool: 'tools/list', risk: 'read', summary: result.tools === 1 ? '1 tool' : `${result.tools} tools`, ok: true, ms: Date.now() - started });
        ctx.audit(u.id, 'mcp.verified', { id: c.id, name: c.name, tools: result.tools });
        const fresh = getConn(ctx, c.id)!;
        emit(u.id, fresh);
        return { ok: true, sample, connection: connView(ctx, mgr, fresh, true) };
      } catch (e: any) {
        if (e instanceof HttpError) throw e;
        const error = cleanError(e);
        ctx.store.update('mcp_connections', c.id, { verify_result: { ok: false, at: now(), error }, last_error: error, updated_at: now() });
        logCall(ctx, { userId: u.id, connId: c.id, kind: 'test', tool: 'tools/list', risk: 'read', summary: '', ok: false, error, ms: Date.now() - started });
        const fresh = getConn(ctx, c.id)!;
        emit(u.id, fresh);
        return { ok: false, error, authRequired: fresh.status === 'auth_required' || /inloggen/i.test(error), connection: connView(ctx, mgr, fresh, true) };
      }
    }),
  );

  api.post(
    '/mcp/connections/:id/actions',
    ah(async (req) => {
      const u = user(req);
      const c = ownConn(ctx, req);
      const enabled = !!req.body?.enabled;
      if (enabled && !c.verified_at) throw bad('Doe eerst de leestest; daarna kun je acties toestaan.');
      ctx.store.update('mcp_connections', c.id, { allow_actions: enabled, updated_at: now() });
      ctx.audit(u.id, enabled ? 'mcp.actions.enabled' : 'mcp.actions.disabled', { id: c.id, name: c.name });
      const fresh = getConn(ctx, c.id)!;
      emit(u.id, fresh);
      return connView(ctx, mgr, fresh, true);
    }),
  );

  // ---- tools: risk override, enable, approve ----
  api.patch(
    '/mcp/connections/:id/tools/:name',
    ah(async (req) => {
      const u = user(req);
      const c = ownConn(ctx, req);
      const raw = ctx.store.one<any>('SELECT * FROM mcp_tools WHERE connection_id = ? AND name = ?', c.id, String(req.params.name));
      if (!raw) throw notFound('Tool niet gevonden');
      const t = ctx.store.decode<ToolRow>('mcp_tools', raw);
      const b = req.body || {};
      const patch: Record<string, any> = {};
      if (b.risk !== undefined) {
        if (b.risk !== null && !isRisk(b.risk)) throw bad('Ongeldig risico');
        const next: ToolRisk = (b.risk as ToolRisk | null) || t.server_risk;
        const cur = effectiveRisk(t);
        if (riskRank(next) < riskRank(cur) && b.confirm !== true) {
          throw new HttpError(409, `Je maakt "${t.name}" minder streng (${cur} → ${next}). Bevestig dit expliciet.`, 'confirm_required');
        }
        patch.user_risk = b.risk === null ? null : next;
        ctx.audit(u.id, riskRank(next) < riskRank(cur) ? 'mcp.tool.risk_loosened' : 'mcp.tool.risk_changed', { id: c.id, tool: t.name, from: cur, to: next });
      }
      if (b.enabled !== undefined) patch.enabled = b.enabled ? 1 : 0;
      if (b.approve === true) {
        patch.approved = 1;
        patch.changed = 0;
        ctx.audit(u.id, 'mcp.tool.approved', { id: c.id, tool: t.name, risk: effectiveRisk({ ...t, user_risk: patch.user_risk !== undefined ? patch.user_risk : t.user_risk }) });
      }
      const keys = Object.keys(patch);
      if (keys.length) ctx.store.exec(`UPDATE mcp_tools SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE connection_id = ? AND name = ?`, ...keys.map((k) => patch[k]), c.id, t.name);
      const fresh = getConn(ctx, c.id)!;
      emit(u.id, fresh);
      return connView(ctx, mgr, fresh, true);
    }),
  );
  api.post(
    '/mcp/connections/:id/tools/approve',
    ah(async (req) => {
      const u = user(req);
      const c = ownConn(ctx, req);
      if (!c.verified_at) throw bad('Doe eerst de leestest.');
      const names: string[] | null = Array.isArray(req.body?.names) ? req.body.names.map(String) : null;
      for (const t of tools(ctx, c.id)) if (t.present && (!names || names.includes(t.name))) ctx.store.exec('UPDATE mcp_tools SET approved = 1, changed = 0 WHERE connection_id = ? AND name = ?', c.id, t.name);
      ctx.audit(u.id, 'mcp.tool.approved', { id: c.id, tools: names || 'alle' });
      const fresh = getConn(ctx, c.id)!;
      emit(u.id, fresh);
      return connView(ctx, mgr, fresh, true);
    }),
  );

  // ---- call log ----
  api.get(
    '/mcp/connections/:id/calls',
    ah(async (req) => {
      const c = ownConn(ctx, req);
      const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
      const limit = Math.min(200, Number(req.query.limit) || 50);
      return ctx.store.all<any>(
        'SELECT l.*, a.name AS agent_name FROM mcp_calls l LEFT JOIN agents a ON a.id = l.agent_id WHERE l.connection_id = ? AND l.user_id = ? AND l.id < ? ORDER BY l.id DESC LIMIT ?',
        c.id,
        c.user_id,
        before,
        limit,
      ).map((r) => ({ ...r, ok: !!r.ok }));
    }),
  );

  // ---- bindings (which bots may use which app) ----
  api.put(
    '/mcp/connections/:id/agents',
    ah(async (req) => {
      const u = user(req);
      const c = ownConn(ctx, req);
      const ids = Array.isArray(req.body?.agentIds) ? req.body.agentIds.map(String) : null;
      if (!ids) throw bad('agentIds moet een lijst zijn');
      setBindings(ctx, u.id, c.id, ids);
      const fresh = getConn(ctx, c.id)!;
      emit(u.id, fresh);
      return connView(ctx, mgr, fresh, true);
    }),
  );
  api.get(
    '/mcp/agents/:agentId',
    ah(async (req) => {
      const u = user(req);
      const a = own(req, ctx.store.agent(String(req.params.agentId)), 'Bot niet gevonden');
      const bound = new Set(ctx.store.all<any>('SELECT connection_id FROM mcp_bindings WHERE agent_id = ?', a.id).map((r) => r.connection_id));
      return ctx.store.find<ConnectionRow>('mcp_connections', { user_id: u.id }, { order: 'name, label' }).map((c) => ({ ...connView(ctx, mgr, c), bound: bound.has(c.id) }));
    }),
  );
  api.put(
    '/mcp/agents/:agentId/:id',
    ah(async (req) => {
      const u = user(req);
      const a = own(req, ctx.store.agent(String(req.params.agentId)), 'Bot niet gevonden');
      const c = ownConn(ctx, req);
      const on = !!req.body?.enabled;
      if (on) ctx.store.exec('INSERT OR IGNORE INTO mcp_bindings (agent_id, connection_id, user_id, created_at) VALUES (?, ?, ?, ?)', a.id, c.id, u.id, now());
      else ctx.store.exec('DELETE FROM mcp_bindings WHERE agent_id = ? AND connection_id = ?', a.id, c.id);
      ctx.audit(u.id, on ? 'mcp.binding.added' : 'mcp.binding.removed', { connection: c.id, name: label(c) }, a.id);
      const fresh = getConn(ctx, c.id)!;
      emit(u.id, fresh);
      return { ...connView(ctx, mgr, fresh), bound: on };
    }),
  );

  /** exposed tool name → app + tool (for the chat tool-card renderer). */
  api.get(
    '/mcp/tool-index',
    ah(async (req) => {
      const u = user(req);
      const out: Record<string, { connectionId: string; app: string; tool: string; risk: string; title?: string }> = {};
      for (const c of ctx.store.find<ConnectionRow>('mcp_connections', { user_id: u.id })) {
        for (const t of tools(ctx, c.id)) out[exposedName(c.slug, t.name)] = { connectionId: c.id, app: label(c), tool: t.name, risk: effectiveRisk(t), title: t.title || undefined };
      }
      return { group: GROUP, tools: out };
    }),
  );

  // ---- OAuth ----
  api.post(
    '/mcp/connections/:id/oauth/prepare',
    ah(async (req) => {
      const c = ownConn(ctx, req);
      if (c.auth !== 'oauth') throw bad('Deze koppeling gebruikt geen OAuth');
      const r = await prepareOAuth(ctx, c);
      return { ...r, redirectUri: baseUrl(ctx, req) + CALLBACK_PATH, connection: connView(ctx, mgr, getConn(ctx, c.id)!) };
    }),
  );
  api.post(
    '/mcp/connections/:id/oauth/start',
    ah(async (req) => {
      const c = ownConn(ctx, req);
      if (c.auth !== 'oauth') throw bad('Deze koppeling gebruikt geen OAuth');
      const scopes = Array.isArray(req.body?.scopes) ? req.body.scopes.map((s: any) => String(s)).slice(0, 50) : [];
      try {
        return await beginOAuth(ctx, c, scopes, baseUrl(ctx, req) + CALLBACK_PATH);
      } catch (e: any) {
        if (e instanceof HttpError) throw e;
        throw bad(`Inloggen starten mislukt: ${cleanError(e)}`);
      }
    }),
  );
  api.post(
    '/mcp/connections/:id/oauth/revoke',
    ah(async (req) => {
      const u = user(req);
      const c = ownConn(ctx, req);
      await mgr.stop(c.id, 'toegang ingetrokken');
      const r = await revokeOAuth(ctx, c);
      ctx.store.update('mcp_connections', c.id, { status: 'stopped', allow_actions: false, updated_at: now() });
      const fresh = getConn(ctx, c.id)!;
      emit(u.id, fresh);
      return { ...r, connection: connView(ctx, mgr, fresh, true) };
    }),
  );
  ctx.publicApi.get(
    '/mcp/oauth/callback',
    ah(async (req, res) => {
      const q = req.query as Record<string, any>;
      const r = await completeOAuth(ctx, { state: q.state, code: q.code, error: q.error, error_description: q.error_description, iss: q.iss });
      res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
      res.setHeader('cache-control', 'no-store');
      if (r.conn) {
        if (r.ok) {
          ctx.store.update('mcp_connections', r.conn.id, { status: 'authorized' });
          mgr
            .restart(r.conn)
            .catch(() => {})
            .finally(() => {
              const fresh = getConn(ctx, r.conn!.id);
              if (fresh) emit(fresh.user_id, fresh);
            });
          ctx.events.emit(r.conn.user_id, 'mcp.oauth', { id: r.conn.id, ok: true });
        } else ctx.events.emit(r.conn.user_id, 'mcp.oauth', { id: r.conn.id, ok: false, error: r.message });
        emit(r.conn.user_id, getConn(ctx, r.conn.id));
      }
      res.status(r.ok ? 200 : 400).type('html').send(callbackPage(r.ok, r.ok ? `Verbonden met ${r.conn ? label(r.conn) : 'de app'}` : 'Verbinden mislukt', r.ok ? 'TeamBot test nu de verbinding (alleen lezen).' : r.message, r.conn ? `/#/m/mcp/c/${r.conn.id}` : '/'));
    }),
  );
}

export function setBindings(ctx: Ctx, userId: string, connId: string, agentIds: string[]) {
  const valid = new Set(ctx.store.agents(userId, { archived: true }).map((a) => a.id));
  const wanted = [...new Set(agentIds)].filter((id) => valid.has(id));
  ctx.store.tx(() => {
    ctx.store.exec('DELETE FROM mcp_bindings WHERE connection_id = ? AND user_id = ?', connId, userId);
    for (const a of wanted) ctx.store.exec('INSERT OR IGNORE INTO mcp_bindings (agent_id, connection_id, user_id, created_at) VALUES (?, ?, ?, ?)', a, connId, userId, now());
  });
  ctx.audit(userId, 'mcp.binding.set', { connection: connId, agents: wanted });
}

export { commandOnPath };
