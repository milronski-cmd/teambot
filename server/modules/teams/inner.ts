import http from 'node:http';
import { Duplex } from 'node:stream';
import express from 'express';
import type { Agent, Ctx, User } from '../../core/types.js';
import { HttpError } from '../../core/http.js';
import { redact } from '../../core/secrets.js';

/**
 * TeamBot's own API, called inside this process as a user: a request object goes straight through the router the app
 * serves under /api. No port, no token, no session row. This is how a bot's tools do what the screens do (manage.ts,
 * botpatch.ts), so a change made by a bot passes the same checks, log lines and events as a click of the owner.
 *
 * `patchBot` is the one way a tool writes a bot's own fields: PATCH /agents/:id, the save of the bot editor, which
 * keeps the bot as it was as a version. `my_settings`, `bot_settings`, `teambot_do` and `request_part` all end there.
 *
 * (A leaf on purpose: it imports nothing of the teams module or of the tools, so both can use it.)
 */
const MAX_BYTES = 4_000_000;
const TIMEOUT_MS = 120_000;

export interface CallResult {
  status: number;
  type: string;
  body: Buffer;
}

const inners = new WeakMap<Ctx, express.Express>();

/** The owner's API router behind the same 404 and error answers as the real app (app.ts). */
function innerApp(ctx: Ctx): express.Express {
  let app = inners.get(ctx);
  if (app) return app;
  app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.use(ctx.api);
  app.use((_req, res) => void res.status(404).json({ error: 'Onbekend API-pad' }));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err instanceof HttpError ? err.status : err?.status && err.status < 600 ? err.status : 500;
    if (status >= 500) ctx.log.error('[bot in TeamBot]', err);
    res.status(status).json({ error: status < 500 || err instanceof HttpError ? redact(String(err?.message ?? '')) : `Interne fout: ${redact(String(err?.message || err))}`, code: err?.code });
  });
  inners.set(ctx, app);
  return app;
}

/**
 * Perform one call of TeamBot's own API as `user`, without the network. The session is of kind "device" (not a stored
 * session), so routes that refuse a paired phone (things that hand out access or show secrets) refuse this caller too;
 * the host is not this computer's, so nothing treats it as "the computer itself".
 */
export function callAsUser(ctx: Ctx, user: User, call: { method: string; url: string; body?: any }, signal?: AbortSignal): Promise<CallResult> {
  return new Promise<CallResult>((resolve) => {
    const socket = new Duplex({ read() {}, write(_c, _e, cb) { cb(); } });
    Object.defineProperty(socket, 'remoteAddress', { value: '0.0.0.0' });
    const req = new http.IncomingMessage(socket as any);
    req.method = call.method;
    req.url = call.url;
    req.headers = { host: 'bot.teambot.invalid', accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'TeamBot bot' };
    (req as any).body = call.body;
    (req as any).user = user;
    (req as any).session = { id: 'bot', user_id: user.id, kind: 'device', name: 'Bot' };
    (req as any).signedUrl = false;
    req.push(null);
    const res = new http.ServerResponse(req);
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (over?: { status: number; error: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (over) return resolve({ status: over.status, type: 'application/json', body: Buffer.from(JSON.stringify({ error: over.error })) });
      resolve({ status: res.statusCode, type: String(res.getHeader('content-type') || ''), body: Buffer.concat(chunks) });
      // Tell a handler that streams (a download, live events) that nobody is listening any more.
      req.emit('close');
      res.emit('close');
    };
    const take = (c: any, enc?: any) => {
      if (done || c === undefined || c === null || typeof c === 'function') return;
      const b = Buffer.isBuffer(c) ? c : c instanceof Uint8Array ? Buffer.from(c) : Buffer.from(String(c), typeof enc === 'string' ? (enc as BufferEncoding) : 'utf8');
      size += b.length;
      if (size <= MAX_BYTES) chunks.push(b);
    };
    (res as any).write = (c: any, enc?: any, cb?: any) => {
      take(c, enc);
      const f = typeof enc === 'function' ? enc : cb;
      if (typeof f === 'function') f();
      if (size > MAX_BYTES) finish();
      return true;
    };
    (res as any).end = (c?: any, enc?: any, cb?: any) => {
      take(c, enc);
      finish();
      const f = typeof c === 'function' ? c : typeof enc === 'function' ? enc : cb;
      if (typeof f === 'function') f();
      return res;
    };
    Object.defineProperty(res, 'headersSent', { get: () => done || chunks.length > 0 });
    const timer = setTimeout(() => finish({ status: 504, error: 'TeamBot gaf binnen twee minuten geen antwoord op deze actie.' }), TIMEOUT_MS);
    const onAbort = () => finish({ status: 499, error: 'Gestopt.' });
    signal?.addEventListener('abort', onAbort);
    try {
      (innerApp(ctx) as any)(req, res, (err: any) => finish({ status: err?.status || 500, error: redact(String(err?.message || err || 'Onbekend API-pad')) }));
    } catch (e: any) {
      finish({ status: 500, error: redact(String(e?.message || e)) });
    }
  });
}

/** One route as the user, for a caller that only needs it done: a refusal is thrown as the route's own sentence. */
export async function routeAs(ctx: Ctx, user: User, method: string, url: string, body: any, signal?: AbortSignal): Promise<void> {
  const r = await callAsUser(ctx, user, { method, url, body }, signal);
  if (r.status < 400) return;
  let msg = `fout ${r.status}`;
  try {
    msg = JSON.parse(r.body.toString('utf8'))?.error || msg;
  } catch {
    /* not JSON */
  }
  throw new Error(msg);
}

/**
 * Write fields of a bot the way the bot editor saves them (PATCH /agents/:id), as the owner: the checks of the screen,
 * the bot as it was kept as a version (Bot bewerken › Geschiedenis), a log line and the event. Throws the route's
 * sentence when it refuses.
 */
export async function patchBot(ctx: Ctx, owner: User, botId: string, patch: Partial<Agent>, signal?: AbortSignal): Promise<Agent> {
  await routeAs(ctx, owner, 'PATCH', `/agents/${botId}`, patch, signal);
  return ctx.store.agent(botId)!;
}
