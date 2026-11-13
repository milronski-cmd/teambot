import { TERMINAL } from '../../agent/runs.js';
import { isLoopbackHost } from '../../core/util.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request } from 'express';
import type { Agent, Ctx, Thread } from '../../core/types.js';
import { ah, HttpError } from '../../core/http.js';
import { allowedAgents, rateLimited, tokenByValue } from './expose.js';

/**
 * Server side of `teambot send` (bin/teambot.mjs): post a message to a bot from a terminal or script and fetch the
 * answer. Two ways in:
 *  - a personal token (`tbmcp_…`, the same tokens as "TeamBot als MCP-server"): only the bots of that token;
 *  - the desktop app's own sign-in on this computer (`<data>/local-token`): only from this computer (loopback).
 * Messages arrive as "Terminal" in their own conversation per caller and bot; the bot keeps its access mode and asks
 * for approval in TeamBot as usual. The CLI polls `GET /cli/runs/:id?wait=` (long poll, max 30 s per request) so any
 * timeout works without keeping one request open for minutes.
 */

export const CLI_PATH = '/cli';
const MAX_MESSAGE = 20_000;
const MAX_WAIT_SEC = 30;
/** Written next to `local-token` so the CLI finds the app on this computer even on another port. */
export const LOCAL_URL_FILE = 'local-url';

interface Caller {
  userId: string;
  /** null = the desktop app's own sign-in */
  tokenId: string | null;
  tokenName: string | null;
  agents: Agent[];
}

const fail = (status: number, message: string, code: string) => new HttpError(status, message, code);

function callerOf(ctx: Ctx, req: Request): Caller {
  const h = String(req.headers.authorization || '');
  const value = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  let caller: Caller | null = null;
  if (value.startsWith('tbmcp_')) {
    const tok = tokenByValue(ctx, value);
    const owner = tok ? ctx.store.user(tok.user_id) : null;
    if (tok && owner && !owner.disabled) caller = { userId: tok.user_id, tokenId: tok.id, tokenName: tok.name || 'token', agents: allowedAgents(ctx, tok) };
    if (caller && (!tok!.last_used || Date.now() - Date.parse(tok!.last_used) > 60_000)) ctx.store.update('mcp_server_tokens', tok!.id, { last_used: new Date().toISOString() });
  } else if (value) {
    // the desktop app's own long-lived sign-in (local-token): only on this computer
    const r = ctx.auth.resolve(value);
    if (r && r.session.kind === 'desktop' && !r.user.disabled && isLoopbackHost(String(req.ip || req.socket.remoteAddress || ''))) caller = { userId: r.user.id, tokenId: null, tokenName: null, agents: ctx.store.agents(r.user.id) };
  }
  if (!caller) throw fail(401, 'Deze token is ongeldig of ingetrokken. Maak een nieuwe in TeamBot onder Apps › TeamBot als server.', 'token');
  if (rateLimited('cli:' + (caller.tokenId || caller.userId))) throw fail(429, 'Te veel berichten in korte tijd. Probeer het over een minuut opnieuw.', 'rate');
  return caller;
}

function pickBot(caller: Caller, ref: unknown): Agent {
  const names = caller.agents.map((a) => a.name).join(', ');
  const want = typeof ref === 'string' ? ref.trim() : '';
  if (!caller.agents.length)
    throw fail(403, caller.tokenId ? 'Met deze token is geen enkele bot bereikbaar. Kies bots bij de token in TeamBot.' : 'Je hebt nog geen bots. Maak eerst een bot in TeamBot.', 'bot');
  if (!want) {
    if (caller.agents.length === 1) return caller.agents[0];
    throw fail(400, `Kies een bot met --bot. Je kunt kiezen uit: ${names}.`, 'choose');
  }
  const lower = want.toLowerCase();
  const bot = caller.agents.find((a) => a.id === want) || caller.agents.find((a) => a.name.toLowerCase() === lower);
  if (!bot) throw fail(404, `De bot "${want.slice(0, 60)}" bestaat niet of is niet bereikbaar${caller.tokenId ? ' met deze token' : ''}. Je kunt kiezen uit: ${names}.`, 'bot');
  return bot;
}

function threadFor(ctx: Ctx, caller: Caller, agent: Agent, fresh: boolean): Thread {
  const key = caller.tokenId ? ['$.cliTokenId', caller.tokenId] : ['$.cliLocal', 1];
  if (!fresh) {
    const row = ctx.store.one<any>(
      `SELECT * FROM threads WHERE user_id = ? AND agent_id = ? AND kind = 'chat' AND archived = 0 AND json_extract(meta, '${key[0]}') = ? ORDER BY updated_at DESC LIMIT 1`,
      caller.userId,
      agent.id,
      key[1],
    );
    if (row) return ctx.store.decode<Thread>('threads', row);
  }
  const meta = caller.tokenId ? { cliTokenId: caller.tokenId } : { cliLocal: 1 };
  const t = ctx.store.createThread({ user_id: caller.userId, agent_id: agent.id, kind: 'chat', title: caller.tokenName ? `Via de terminal (${caller.tokenName})` : 'Via de terminal', meta });
  ctx.events.emit(caller.userId, 'thread.updated', t);
  return t;
}

function lastReply(ctx: Ctx, threadId: string, runId: string, agentId: string): string {
  const r = ctx.store.one<any>(
    "SELECT content FROM messages WHERE thread_id = ? AND run_id = ? AND role = 'assistant' AND author_id = ? AND content != '' ORDER BY seq DESC LIMIT 1",
    threadId,
    runId,
    agentId,
  );
  return r?.content || '';
}


export function registerCli(ctx: Ctx) {
  ctx.publicApi.post(
    CLI_PATH + '/send',
    ah(async (req) => {
      const caller = callerOf(ctx, req);
      const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
      if (!message) throw fail(400, 'Het bericht is leeg.', 'message');
      if (message.length > MAX_MESSAGE) throw fail(400, `Het bericht is te lang (maximaal ${MAX_MESSAGE.toLocaleString('nl-NL')} tekens).`, 'message');
      const bot = pickBot(caller, req.body?.bot);
      const owner = ctx.store.user(caller.userId)!;
      const thread = threadFor(ctx, caller, bot, req.body?.new_conversation === true);
      const m = await ctx.chat.postUserMessage({ thread, user: owner, content: message, authorType: 'external', authorName: caller.tokenName ? `Terminal: ${caller.tokenName}` : 'Terminal', route: false, trigger: 'cli' });
      const run = ctx.chat.startAgent(thread, bot.id, m.id, 'cli');
      if (!run) throw fail(409, `${bot.name} kon niet starten.`, 'run');
      ctx.audit(caller.userId, 'cli.send', { token: caller.tokenId, thread: thread.id }, bot.id);
      return { bot: { id: bot.id, name: bot.name }, thread_id: thread.id, thread_title: thread.title, run_id: run.id, status: run.status };
    }),
  );

  ctx.publicApi.get(
    CLI_PATH + '/runs/:id',
    ah(async (req) => {
      const caller = callerOf(ctx, req);
      let run = ctx.store.run(String(req.params.id));
      const thread = run ? ctx.store.thread(run.thread_id) : null;
      const mine = !!run && !!thread && thread.user_id === caller.userId && (caller.tokenId ? thread.meta?.cliTokenId === caller.tokenId : !!thread.meta?.cliLocal);
      if (!run || !thread || !mine) throw fail(404, 'Dit bericht is niet gevonden.', 'run');
      const wait = Math.max(0, Math.min(MAX_WAIT_SEC, Number(req.query.wait) || 0));
      if (wait && !TERMINAL.has(run.status)) {
        await ctx.runs.waitFor(run.id, wait * 1000).catch(() => null);
        run = ctx.store.run(run.id)!;
      }
      const agent = ctx.store.agent(run.agent_id);
      const done = TERMINAL.has(run.status);
      return {
        status: run.status,
        /** waiting for an approval or an answer from the owner in TeamBot */
        waiting: run.status === 'waiting',
        bot: { id: run.agent_id, name: agent?.name || 'Bot' },
        thread_id: thread.id,
        thread_title: thread.title,
        reply: done ? lastReply(ctx, thread.id, run.id, run.agent_id) : undefined,
        error: run.status === 'done' ? undefined : run.error || (run.status === 'cancelled' ? 'gestopt' : undefined),
      };
    }),
  );
}

// ---------------- helpers for the UI (ready-to-paste command) and the CLI (find this app) ----------------

/** The data folder a CLI on this computer looks in by default (same rule as the server, without TEAMBOT_DATA). */
function platformDataDir(): string {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'TeamBot');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'TeamBot');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'teambot');
}

/** bin/teambot.mjs of this installation (source checkout, built dist, or the unpacked copy next to app.asar). */
function cliScript(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const p = path.join(dir, 'bin', 'teambot.mjs');
    if (fs.existsSync(p)) return p.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

let scriptCache: string | null | undefined;

/** `node "<path>" send [--data "<dir>"]`, or null when this installation has no CLI file. */
export function cliInfo(ctx: Ctx): { command: string; local: boolean } | null {
  if (scriptCache === undefined) scriptCache = cliScript();
  if (!scriptCache) return null;
  const same = (a: string, b: string) => (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
  const data = same(ctx.config.dataDir, platformDataDir()) ? '' : ` --data "${ctx.config.dataDir}"`;
  return { command: `node "${scriptCache}" send${data}`, local: ctx.config.mode === 'desktop' };
}

/** The address on this computer, for the CLI (only when TeamBot listens on loopback or on every interface). */
export function writeLocalUrl(ctx: Ctx): string | null {
  const host = ctx.config.host;
  const port = ctx.config.port;
  if (!port) return null;
  const h = host === '0.0.0.0' || !host ? '127.0.0.1' : host === '::' ? '[::1]' : host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  if (!isLoopbackHost(h)) return null;
  const url = `http://${h}:${port}`;
  try {
    fs.writeFileSync(path.join(ctx.config.dataDir, LOCAL_URL_FILE), url + '\n');
    return url;
  } catch {
    return null;
  }
}

export function removeLocalUrl(ctx: Ctx, url: string | null) {
  if (!url) return;
  const file = path.join(ctx.config.dataDir, LOCAL_URL_FILE);
  try {
    if (fs.readFileSync(file, 'utf8').trim() === url) fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}
