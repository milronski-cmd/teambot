import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';
import type { Agent, Ctx, Thread } from '../../core/types.js';
import { newId, now } from '../../core/db.js';
import { ah, bad, notFound, str, user } from '../../core/http.js';
import { baseUrl } from './api.js';
import { randomToken, sha256, withTimeout } from './util.js';
import { cliInfo } from './cli.js';

/**
 * TeamBot as a restricted MCP server (P2): an external MCP client (Claude
 * Desktop, Claude Code, …) can talk to selected bots with a personal token.
 * Exposes only `list_bots` and `ask_bot`; nothing else of TeamBot (no files,
 * secrets, admin). Bots keep their own access mode and approvals.
 */

export const SERVER_PATH = '/mcp/server';
const RATE = { windowMs: 60_000, max: 60 };
const ASK_TIMEOUT_MS = 5 * 60_000;

export interface TokenRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  agent_ids: string[];
  created_at: string;
  last_used: string | null;
  revoked: boolean;
}

const hits = new Map<string, number[]>();
export function rateLimited(id: string) {
  const t = Date.now();
  const list = (hits.get(id) || []).filter((x) => t - x < RATE.windowMs);
  list.push(t);
  hits.set(id, list);
  return list.length > RATE.max;
}

function tokenView(r: TokenRow) {
  return { id: r.id, name: r.name, agent_ids: r.agent_ids, created_at: r.created_at, last_used: r.last_used, revoked: r.revoked };
}

export function allowedAgents(ctx: Ctx, tok: TokenRow): Agent[] {
  const ids = new Set(tok.agent_ids || []);
  return ctx.store.agents(tok.user_id).filter((a) => ids.has(a.id));
}

/** The (not revoked) personal token row for a `tbmcp_…` value, or null. Shared by the MCP endpoint and `teambot send`. */
export function tokenByValue(ctx: Ctx, value: string): TokenRow | null {
  if (!value.startsWith('tbmcp_')) return null;
  const tok = ctx.store.get<TokenRow>('mcp_server_tokens', sha256(value), 'token_hash');
  return tok && !tok.revoked ? tok : null;
}

function threadFor(ctx: Ctx, tok: TokenRow, agent: Agent, fresh: boolean): Thread {
  if (!fresh) {
    const row = ctx.store.one<any>(
      "SELECT * FROM threads WHERE user_id = ? AND agent_id = ? AND kind = 'chat' AND archived = 0 AND json_extract(meta, '$.mcpTokenId') = ? ORDER BY updated_at DESC LIMIT 1",
      tok.user_id,
      agent.id,
      tok.id,
    );
    if (row) return ctx.store.decode<Thread>('threads', row);
  }
  const t = ctx.store.createThread({ user_id: tok.user_id, agent_id: agent.id, kind: 'chat', title: `Via MCP: ${tok.name || 'extern'}`, meta: { mcpTokenId: tok.id } });
  ctx.events.emit(tok.user_id, 'thread.updated', t);
  return t;
}

async function askBot(ctx: Ctx, tok: TokenRow, botRef: string, message: string, fresh: boolean): Promise<{ text: string; isError?: boolean }> {
  const agents = allowedAgents(ctx, tok);
  const ref = botRef.trim().toLowerCase();
  const agent = agents.find((a) => a.id === botRef) || agents.find((a) => a.name.toLowerCase() === ref);
  if (!agent) return { text: `Onbekende of niet-toegestane bot: ${botRef}. Toegestaan: ${agents.map((a) => a.name).join(', ') || '(geen)'}`, isError: true };
  const owner = ctx.store.user(tok.user_id);
  if (!owner || owner.disabled) return { text: 'Account niet actief', isError: true };
  const thread = threadFor(ctx, tok, agent, fresh);
  const m = await ctx.chat.postUserMessage({ thread, user: owner, content: message, authorType: 'external', authorName: `MCP: ${tok.name || 'extern'}`, route: false, trigger: 'mcp' });
  const run = ctx.chat.startAgent(thread, agent.id, m.id, 'mcp');
  if (!run) return { text: 'Bot kon niet starten', isError: true };
  ctx.audit(tok.user_id, 'mcp.server.ask', { token: tok.id, tokenName: tok.name, thread: thread.id }, agent.id);
  let final;
  try {
    // Own timer (cleared when done): the core waitFor timeout is never cleared and would keep the process alive.
    final = await withTimeout(ctx.runs.waitFor(run.id), ASK_TIMEOUT_MS, 'timeout');
  } catch {
    return { text: `${agent.name} is nog bezig (mogelijk wacht hij op jouw goedkeuring in TeamBot). Het antwoord verschijnt in TeamBot in het gesprek "${thread.title}".` };
  }
  const reply = ctx.store.one<any>(
    "SELECT content FROM messages WHERE thread_id = ? AND run_id = ? AND role = 'assistant' AND author_id = ? AND content != '' ORDER BY seq DESC LIMIT 1",
    thread.id,
    run.id,
    agent.id,
  );
  if (final.status !== 'done') return { text: `${agent.name} stopte met status ${final.status}${final.error ? `: ${final.error}` : ''}.${reply?.content ? `\n\nLaatste antwoord:\n${reply.content}` : ''}`, isError: true };
  return { text: reply?.content || '(geen tekstantwoord)' };
}

function buildServer(ctx: Ctx, tok: TokenRow) {
  const server = new McpServer({ name: 'TeamBot', version: ctx.config.version }, { capabilities: { tools: {} } });
  server.registerTool(
    'list_bots',
    { description: 'Toon de TeamBot-bots die je via deze verbinding mag aanspreken.', annotations: { readOnlyHint: true, openWorldHint: false } },
    async () => {
      const list = allowedAgents(ctx, tok).map((a) => `- ${a.name} (id ${a.id})${a.role ? ` — ${a.role}` : ''}${a.description ? `: ${a.description.slice(0, 200)}` : ''}`);
      return { content: [{ type: 'text', text: list.length ? list.join('\n') : 'Geen bots toegestaan voor deze verbinding.' }] };
    },
  );
  server.registerTool(
    'ask_bot',
    {
      description:
        'Stuur een bericht naar een TeamBot-bot en wacht op het antwoord (max. 5 minuten). De bot gebruikt zijn eigen model, tools en toestemmingen; acties met impact vragen goedkeuring in TeamBot.',
      inputSchema: z.object({ bot: z.string().describe('Naam of id van de bot (zie list_bots)'), message: z.string().min(1).max(20_000), new_conversation: z.boolean().optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ bot, message, new_conversation }) => {
      const r = await askBot(ctx, tok, bot, message, !!new_conversation);
      return { content: [{ type: 'text', text: r.text }], isError: r.isError };
    },
  );
  return server;
}

export function registerExpose(ctx: Ctx) {
  const api = ctx.api;
  const list = (userId: string) => ctx.store.find<TokenRow>('mcp_server_tokens', { user_id: userId }, { order: 'created_at DESC' });

  api.get(
    '/mcp/server-tokens',
    // cli: the ready-to-paste `teambot send` command for this installation (null when the CLI file is not shipped)
    ah(async (req) => ({ endpoint: baseUrl(ctx, req) + '/api/public' + SERVER_PATH, tokens: list(user(req).id).filter((t) => !t.revoked).map(tokenView), cli: cliInfo(ctx) })),
  );
  api.post(
    '/mcp/server-tokens',
    ah(async (req) => {
      const u = user(req);
      const name = str(req.body?.name, 60).trim() || 'Externe MCP-client';
      const valid = new Set(ctx.store.agents(u.id).map((a) => a.id));
      const agentIds = (Array.isArray(req.body?.agentIds) ? req.body.agentIds.map(String) : []).filter((id: string) => valid.has(id));
      if (!agentIds.length) throw bad('Kies minstens één bot');
      if (list(u.id).filter((t) => !t.revoked).length >= 20) throw bad('Maximaal 20 actieve tokens');
      const token = 'tbmcp_' + randomToken(32);
      const row: TokenRow = { id: newId('mst_'), user_id: u.id, name, token_hash: sha256(token), agent_ids: agentIds, created_at: now(), last_used: null, revoked: false };
      ctx.store.insert('mcp_server_tokens', row);
      ctx.audit(u.id, 'mcp.server.token_created', { id: row.id, name, agents: agentIds });
      return { ...tokenView(row), token, endpoint: baseUrl(ctx, req) + '/api/public' + SERVER_PATH };
    }),
  );
  api.patch(
    '/mcp/server-tokens/:id',
    ah(async (req) => {
      const u = user(req);
      const r = ctx.store.get<TokenRow>('mcp_server_tokens', String(req.params.id));
      if (!r || r.user_id !== u.id || r.revoked) throw notFound('Token niet gevonden');
      const valid = new Set(ctx.store.agents(u.id).map((a) => a.id));
      const p: any = {};
      if (req.body?.name !== undefined) p.name = str(req.body.name, 60).trim();
      if (Array.isArray(req.body?.agentIds)) p.agent_ids = req.body.agentIds.map(String).filter((id: string) => valid.has(id));
      ctx.store.update('mcp_server_tokens', r.id, p);
      ctx.audit(u.id, 'mcp.server.token_updated', { id: r.id, agents: p.agent_ids });
      return tokenView(ctx.store.get<TokenRow>('mcp_server_tokens', r.id)!);
    }),
  );
  api.delete(
    '/mcp/server-tokens/:id',
    ah(async (req) => {
      const u = user(req);
      const r = ctx.store.get<TokenRow>('mcp_server_tokens', String(req.params.id));
      if (!r || r.user_id !== u.id) throw notFound('Token niet gevonden');
      ctx.store.update('mcp_server_tokens', r.id, { revoked: true });
      ctx.audit(u.id, 'mcp.server.token_revoked', { id: r.id, name: r.name });
      return { ok: true };
    }),
  );

  // The MCP endpoint itself (Streamable HTTP, stateless). Own bearer token, not a TeamBot session.
  const handler = makeHandler(ctx);
  const nodeHandler = toNodeHandler(handler);
  ctx.publicApi.all(
    SERVER_PATH,
    ah(async (req, res) => {
      const h = String(req.headers.authorization || '');
      const tok = h.startsWith('Bearer tbmcp_') ? ctx.store.get<TokenRow>('mcp_server_tokens', sha256(h.slice(7)), 'token_hash') : null;
      const owner = tok ? ctx.store.user(tok.user_id) : null;
      if (!tok || tok.revoked || !owner || owner.disabled) {
        res.setHeader('www-authenticate', 'Bearer realm="TeamBot"');
        res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Ongeldige of ingetrokken TeamBot MCP-token' }, id: null });
        return;
      }
      if (rateLimited(tok.id)) {
        res.status(429).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Te veel verzoeken; probeer het zo opnieuw' }, id: null });
        return;
      }
      if (req.method !== 'POST') {
        res.status(405).setHeader('allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Alleen POST (stateless Streamable HTTP)' }, id: null });
        return;
      }
      if (!tok.last_used || Date.now() - Date.parse(tok.last_used) > 60_000) ctx.store.update('mcp_server_tokens', tok.id, { last_used: now() });
      // The checked token travels to the server factory as auth info (its id only; the token value stays here).
      (req as any).auth = { token: tok.id, clientId: tok.id, scopes: [], extra: { tokenId: tok.id } };
      await nodeHandler(req, res, req.body);
    }),
  );
  return { close: () => handler.close().catch(() => {}) };
}

/**
 * The SDK v2 handler for the endpoint: spec 2026-07-28 requests and 2025-era (stateless) requests on the same
 * address, each served by a fresh McpServer for the token that the route already checked.
 */
function makeHandler(ctx: Ctx): McpHttpHandler {
  return createMcpHandler(
    (rc) => {
      const id = String((rc.authInfo?.extra as any)?.tokenId || '');
      const tok = id ? ctx.store.get<TokenRow>('mcp_server_tokens', id) : null;
      if (!tok || tok.revoked) throw new Error('Ongeldige of ingetrokken TeamBot MCP-token');
      return buildServer(ctx, tok);
    },
    { onerror: () => {} },
  );
}
