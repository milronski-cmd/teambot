import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../../core/types.js';
import { HttpError, ah, bad, str, user } from '../../core/http.js';
import type { ConnectionRow } from './db.js';
import type { McpManager } from './runtime.js';
import { label } from './runtime.js';
import { ImportError, type ImportedServer, parsePasted, previewOf, scanLocal } from './import.js';

type User = ReturnType<typeof user>;

export interface ImportDeps {
  /** The normal connection create (validation, publisher policy, secrets to the vault, audit). */
  createConnection(u: User, body: any): Promise<ConnectionRow>;
  /** Does this URL ask for an OAuth login (401 + resource metadata)? */
  probe(userId: string, url: string, transport: 'http' | 'sse'): Promise<{ oauth: boolean }>;
  /** The API view of a connection. */
  view(c: ConnectionRow): any;
}

const MAX_APPLY = 30;

/** Same server already connected? (same program and arguments, or the same address) */
function fingerprint(s: { transport: string; command?: string; args?: string[]; url?: string }) {
  if (s.transport === 'stdio') return `stdio|${String(s.command || '').toLowerCase()}|${(s.args || []).join('\u0001')}`;
  return `url|${String(s.url || '').replace(/\/+$/, '').toLowerCase()}`;
}

function isLocalUrl(u?: string) {
  if (!u) return false;
  try {
    const h = new URL(u).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return h === 'localhost' || h === '::1' || h.endsWith('.local') || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  } catch {
    return false;
  }
}

/** The body for the normal create: secrets as vault values, blanks left out (the owner fills them in later). */
export function createBody(s: ImportedServer, o: { trust: boolean; agentIds: string[] }) {
  const kvs = (list: ImportedServer['env']) =>
    list.filter((k) => !(k.required && !k.value)).map((k) => (k.secret ? { name: k.name, secret: true, value: k.value, ...(k.prefix ? { prefix: k.prefix } : {}) } : { name: k.name, value: k.value }));
  const body: any = { catalog_id: 'custom', name: s.name, transport: s.transport, agentIds: o.agentIds };
  if (s.transport === 'stdio') {
    body.command = s.command || '';
    body.args = s.args || [];
    if (s.cwd && path.isAbsolute(s.cwd) && fs.existsSync(s.cwd)) body.cwd = s.cwd;
    body.env = kvs(s.env);
    if (o.trust) body.trust_command = true;
  } else {
    body.url = s.url || '';
    body.headers = kvs(s.headers);
    body.auth = s.auth;
    if (isLocalUrl(s.url)) body.allow_private = true;
    if (s.auth === 'oauth' && s.oauthClientId) body.oauth_client_id = s.oauthClientId;
  }
  return body;
}

/**
 * Import routes (see import.ts):
 *  POST /mcp/import/parse   pasted text → recognised servers (values included: the owner pasted them himself)
 *  GET  /mcp/import/local   config files of other MCP clients on this computer → preview WITHOUT secret values
 *  POST /mcp/import/apply   create the chosen servers (from the paste or re-read from the files, never from the
 *                           browser), secrets to the vault; stdio only with the owner's "ik vertrouw deze opdrachten"
 */
export function registerImportRoutes(ctx: Ctx, mgr: McpManager, d: ImportDeps) {
  const api = ctx.api;
  void mgr;
  /** "This computer" is the machine TeamBot runs on: only its owner may look at its files. */
  const mayScan = (u: User) => ctx.config.mode === 'desktop' || u.role === 'owner';
  const scanFor = (u: User) => {
    if (!mayScan(u)) throw new HttpError(403, 'Importeren van deze computer kan alleen de eigenaar van de computer waarop TeamBot draait. Plak de config van je eigen computer hierboven.');
    return scanLocal();
  };
  const existingOf = (userId: string) => {
    const m = new Map<string, { id: string; display: string }>();
    for (const c of ctx.store.find<ConnectionRow>('mcp_connections', { user_id: userId })) m.set(fingerprint(c), { id: c.id, display: label(c) });
    return m;
  };
  const parse = (text: unknown) => {
    try {
      return parsePasted(str(text, 200_000));
    } catch (e: any) {
      if (e instanceof ImportError) throw bad(e.message);
      throw e;
    }
  };
  /** Remote servers without credentials: ask the server whether it wants an OAuth login, so that is pre-selected. */
  const detectOAuth = async (userId: string, s: ImportedServer) => {
    if (s.transport === 'stdio' || s.auth !== 'none' || !s.url || /\$\{/.test(s.url) || isLocalUrl(s.url)) return;
    const p = await d.probe(userId, s.url, s.transport).catch(() => null);
    if (p?.oauth) s.auth = 'oauth';
  };

  api.post(
    '/mcp/import/parse',
    ah(async (req) => {
      const u = user(req);
      const servers = parse(req.body?.text);
      for (const s of servers.slice(0, 5)) await detectOAuth(u.id, s);
      const ex = existingOf(u.id);
      return { servers: servers.map((s) => ({ ...s, existing: ex.get(fingerprint(s)) || null })) };
    }),
  );

  api.get(
    '/mcp/import/local',
    ah(async (req) => {
      const u = user(req);
      const scans = scanFor(u);
      const ex = existingOf(u.id);
      ctx.audit(u.id, 'mcp.import.scanned', { sources: scans.filter((s) => s.found).map((s) => s.label), servers: scans.reduce((n, s) => n + s.servers.length, 0) });
      return {
        sources: scans.map((s) => ({ key: s.key, label: s.label, file: s.file, found: s.found, error: s.error, servers: s.servers.map((x) => ({ ...previewOf(x), existing: ex.get(fingerprint(x)) || null })) })),
      };
    }),
  );

  api.post(
    '/mcp/import/apply',
    ah(async (req) => {
      const u = user(req);
      const b = req.body || {};
      const from = b.from === 'local' ? 'local' : 'text';
      const all = from === 'local' ? scanFor(u).flatMap((s) => s.servers) : parse(b.text);
      const ids: string[] = Array.isArray(b.ids) ? [...new Set<string>(b.ids.map((x: any) => String(x)))] : [];
      const pick = ids.map((id) => all.find((s) => s.id === id)).filter(Boolean) as ImportedServer[];
      if (!pick.length) throw bad('Kies minstens één server om te importeren.');
      if (pick.length > MAX_APPLY) throw bad(`Importeer maximaal ${MAX_APPLY} servers tegelijk.`);
      const trust = b.trust === true;
      if (!trust && pick.some((s) => s.transport === 'stdio')) throw bad('Bevestig eerst dat je de lokale programma’s vertrouwt; TeamBot start ze op deze computer.');
      const agentIds = Array.isArray(b.agentIds) ? b.agentIds.map((x: any) => String(x)).slice(0, 100) : [];
      const results: any[] = [];
      for (const s of pick) {
        try {
          await detectOAuth(u.id, s);
          const c = await d.createConnection(u, createBody(s, { trust, agentIds }));
          const missing = [...s.env, ...s.headers].filter((k) => k.required && !k.value).map((k) => k.name);
          results.push({ id: s.id, name: s.name, ok: true, connection: d.view(c), missing, needsLogin: c.auth === 'oauth' });
        } catch (e: any) {
          results.push({ id: s.id, name: s.name, ok: false, error: String(e?.message || e).slice(0, 300) });
        }
      }
      ctx.audit(u.id, 'mcp.import.applied', { from, chosen: pick.length, created: results.filter((r) => r.ok).length, sources: [...new Set(pick.map((s) => s.source))] });
      return { results };
    }),
  );
}
