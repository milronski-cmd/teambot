import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { loadConfig, type Config } from './core/config.js';
import { openDb, migrate, now } from './core/db.js';
import { coreMigrations } from './core/migrations.js';
import { Store } from './core/store.js';
import { EventBus } from './core/events.js';
import { Secrets, redact } from './core/secrets.js';
import { Auth, passwordProblem } from './core/auth.js';
import { assertExposureAllowed, checkExposure, exposureInput, isLoopbackHost } from './modules/network/exposure.js';
import { HttpError } from './core/http.js';
import type { Ctx, Hooks, Logger, Module } from './core/types.js';
import { ToolRegistry } from './tools/registry.js';
import { Broker } from './tools/broker.js';
import { ProviderRegistry } from './providers/registry.js';
import { builtinKinds } from './providers/kinds.js';
import { RunManager } from './agent/runs.js';
import { Runner } from './agent/runner.js';
import { ChatService } from './agent/chat.js';
import { fileTools } from './tools/builtin/files.js';
import { shellTools } from './tools/builtin/shell.js';
import { webTools } from './tools/builtin/web.js';
import { coreTools } from './tools/builtin/core.js';
import { planTool } from './tools/builtin/plan.js';
import { agentRoutes } from './api/agents.js';
import { threadRoutes } from './api/threads.js';
import { providerRoutes } from './api/providers.js';
import { miscRoutes } from './api/misc.js';
import { agentVersionMigrations, agentVersionRoutes } from './api/agent-versions.js';
import { applyPendingRestore } from './modules/backups/restore.js';
import { previewRoutes } from './api/preview.js';
import { diagnosticsRoutes } from './api/diagnostics.js';
import { memberPolicyRoutes } from './api/member-policy.js';
import { SHARED_BOT_TOOLS, sharedRunOf } from './agent/shared.js';
import { providerPolicyRoutes } from './api/provider-policy.js';
import { forkRoutes } from './api/fork.js';
import { linkPreviewMigrations, linkPreviewRoutes } from './api/link-preview.js';
import { compactionRoutes, registerCompaction } from './agent/compaction.js';
import { ChatQueue, queueMigrations, queueRoutes } from './agent/queue.js';
import { canSeeThread } from './api/threads.js';
import { modules as defaultModules } from './modules/index.js';

export interface AppHandle {
  ctx: Ctx;
  server: http.Server;
  url: string;
  close(): Promise<void>;
}

function makeLogger(dataDir: string, quiet = false): Logger {
  const file = path.join(dataDir, 'logs', 'server.log');
  const write = (level: string, a: any[]) => {
    // Redacted once, for the console (desktop shell, Docker, journald) as well as the log file.
    const line = redact(`${now()} ${level} ${a.map((x) => (x instanceof Error ? x.stack || x.message : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`);
    if (!quiet) (level === 'ERROR' ? console.error : console.log)(line);
    try {
      fs.appendFileSync(file, line + '\n');
    } catch {
      /* ignore */
    }
  };
  return { info: (...a) => write('INFO', a), warn: (...a) => write('WARN', a), error: (...a) => write('ERROR', a) };
}

export async function createApp(over: Partial<Config> & { modules?: Module[]; quiet?: boolean; listen?: boolean; masterKey?: Buffer } = {}): Promise<AppHandle> {
  const config = loadConfig(over);
  // Closed by default: refuse unsafe exposure (e.g. desktop mode on 0.0.0.0) before anything opens or listens.
  if (over.listen !== false) assertExposureAllowed(checkExposure(exposureInput(config, 1)));
  const log = makeLogger(config.dataDir, over.quiet);
  const restoredFrom = applyPendingRestore(config.dataDir);
  if (restoredFrom) log.warn(`Back-up teruggezet; vorige database bewaard als ${restoredFrom}`);
  const db = openDb(path.join(config.dataDir, 'teambot.db'));
  migrate(db, coreMigrations);
  migrate(db, agentVersionMigrations);
  migrate(db, linkPreviewMigrations);
  migrate(db, queueMigrations);
  const store = new Store(db, config.dataDir);
  const events = new EventBus();
  const secrets = new Secrets(db, config.dataDir, over.masterKey);
  const auth = new Auth(store, config);
  const api = express.Router();
  const publicApi = express.Router();
  const rootApi = express.Router();
  const hooks: Hooks = { systemPrompt: [], turnContext: [], route: [], afterRun: [], messageCreated: [], agentDeleted: [] };
  const mods = over.modules ?? defaultModules;

  let ctx!: Ctx;
  const getCtx = () => ctx;
  const runner = new Runner(getCtx);
  const queue = new ChatQueue(getCtx);
  ctx = {
    config,
    db,
    store,
    events,
    hooks,
    api,
    publicApi,
    rootApi,
    tools: new ToolRegistry(),
    broker: new Broker(getCtx),
    providers: new ProviderRegistry(getCtx),
    runs: new RunManager(getCtx, (r, s) => runner.execute(r, s)),
    chat: new ChatService(getCtx),
    secrets,
    auth,
    services: { runner, queue },
    modules: mods,
    audit(userId, kind, data, agentId) {
      try {
        store.insert('audit', { user_id: userId, agent_id: agentId ?? null, kind, data: JSON.parse(redact(JSON.stringify(data ?? {}))), created_at: now() });
      } catch (e) {
        log.error('audit failed', e);
      }
    },
    log,
  };

  for (const k of builtinKinds()) ctx.providers.registerKind(k);
  ctx.tools.registerGroup({ id: 'core', label: 'Basis', description: 'Vragen stellen en meldingen sturen', always: true });
  ctx.tools.registerGroup({ id: 'files', label: 'Bestanden', description: 'Lezen en schrijven binnen de werkmap van de bot', defaultOn: true });
  ctx.tools.registerGroup({ id: 'web', label: 'Internet', description: 'Zoeken en webpagina’s lezen', defaultOn: true });
  ctx.tools.registerGroup({ id: 'shell', label: 'Terminal', description: 'Opdrachten uitvoeren (PowerShell/bash) in de werkmap — standaard uit' });
  for (const t of [...coreTools(), planTool(), ...fileTools(), ...shellTools({ dataDir: () => ctx.config.dataDir }), ...webTools()]) ctx.tools.register(t);
  // A shared bot in a member's conversation only keeps the tools of its private context (agent/shared.ts).
  ctx.tools.addFilter((agent, _thread, list) => (sharedRunOf(agent) ? list.filter((t) => SHARED_BOT_TOOLS.has(t.name)) : list));

  // Module migrations + init (each module owns its tables, routes, tools and hooks).
  for (const m of mods) if (m.migrations?.length) migrate(db, m.migrations);
  // A module that cannot start never stops the others, and never fails unseen: it is in the log and in the
  // diagnostics file (ctx.services.startupProblems).
  const problems: { module: string; phase: 'init' | 'start'; error: string }[] = [];
  ctx.services.startupProblems = problems;
  const failed = (m: Module, phase: 'init' | 'start', e: any) => {
    log.error(`[module ${m.id}] ${phase} failed`, e);
    problems.push({ module: m.id, phase, error: redact(String(e?.message || e)).slice(0, 500) });
  };
  for (const m of mods) {
    try {
      await m.init?.(ctx);
    } catch (e) {
      failed(m, 'init', e);
    }
  }

  auth.routes(publicApi, api);
  agentRoutes(ctx);
  threadRoutes(ctx);
  providerRoutes(ctx);
  miscRoutes(ctx);
  agentVersionRoutes(ctx);
  previewRoutes(ctx);
  diagnosticsRoutes(ctx);
  memberPolicyRoutes(ctx);
  providerPolicyRoutes(ctx);
  forkRoutes(ctx, canSeeThread);
  linkPreviewRoutes(ctx);
  compactionRoutes(ctx, canSeeThread);
  registerCompaction(ctx);
  queueRoutes(ctx, queue);

  // ---------- HTTP ----------
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TEAMBOT_TRUST_PROXY || 'loopback');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Permissions-Policy', 'microphone=(self), camera=(self), geolocation=()');
    next();
  });
  const json = express.json({ limit: '50mb' });
  app.use((req, res, next) => (req.path.startsWith('/api/attachments') || req.path.startsWith('/api/public/hooks') ? next() : json(req, res, next)));
  app.get('/healthz', (_req, res) => res.json({ ok: true, version: config.version }));
  // Share target (PWA): normally the service worker takes this POST; without it, explain on the share page.
  app.post('/share-target', (_req, res) => res.redirect(303, '/#/m/mobile/delen/geen'));
  app.use(rootApi);
  app.use('/api/public', publicApi);
  app.use('/api', auth.middleware, api);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Onbekend API-pad' }));

  if (config.uiDir) {
    const ui = config.uiDir;
    app.use(
      express.static(ui, {
        index: false,
        // Our own build output only; needed when TeamBot lives under a dot-folder (e.g. a worktree in .claude\).
        dotfiles: 'allow',
        setHeaders(res, p) {
          if (p.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        },
      }),
    );
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api') || req.path === '/ws') return next();
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: data:; connect-src 'self' ws: wss: https:; frame-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'",
      );
      res.setHeader('Cache-Control', 'no-cache');
      // dotfiles: 'allow' — the app may be installed under a folder whose name starts with a dot.
      res.sendFile(path.join(ui, 'index.html'), { dotfiles: 'allow' });
    });
  } else {
    app.get('/', (_req, res) => res.type('html').send(`<h1>${config.appName}</h1><p>De interface is nog niet gebouwd. Draai <code>npm run build:ui</code> of gebruik <code>npm run dev:ui</code>.</p>`));
  }

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err instanceof HttpError ? err.status : err?.status && err.status < 600 ? err.status : 500;
    if (status >= 500) log.error('[http]', err);
    // A deliberate HttpError (offline, a service not reachable, …) already says what is wrong in plain words; only
    // unexpected exceptions are called an internal error.
    // Every error text is redacted: a provider or service that echoes a key in its error must not hand it to the UI.
    const msg = status < 500 ? redact(String(err?.message ?? '')) : err instanceof HttpError ? redact(String(err.message)) : `Interne fout: ${redact(String(err?.message || err))}`;
    res.status(status).json({ error: msg, code: err?.code });
  });

  const server = http.createServer(app);

  // ---------- WebSocket: live events per user ----------
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });
  const clients = new Set<{ ws: WebSocket; userId: string; sessionId: string; device?: boolean; alive: boolean }>();
  // Paired phones get the same live events as the user, except provider configuration (may hold custom auth headers).
  const DEVICE_HIDDEN = new Set(['provider.updated', 'provider.deleted']);
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url || '/', 'http://x');
    // Modules may add their own signed sockets (ctx.services.wsRoutes: path → handler), e.g. the audio of a live call.
    const extra = u.pathname !== '/ws' && ctx.services.wsRoutes instanceof Map ? ctx.services.wsRoutes.get(u.pathname) : null;
    if (u.pathname !== '/ws' && !extra) return socket.destroy();
    // A signed /ws URL (see Auth.resolveSigned): the session token never travels in the URL.
    const r = auth.resolveSigned('GET', req.url);
    if (!r) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (extra) {
        const offRevoke = auth.onRevoke((ids) => void (ids.includes(r.session.id) && ws.close(4401, 'Sessie ingetrokken')));
        ws.on('close', () => offRevoke());
        return extra(ws, r, u);
      }
      const c = { ws, userId: r.user.id, sessionId: r.session.id, device: (r.session as any).kind === 'device', alive: true };
      clients.add(c);
      ws.on('pong', () => (c.alive = true));
      ws.on('close', () => clients.delete(c));
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(String(data));
          if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: now() }));
        } catch {
          /* ignore */
        }
      });
      ws.send(JSON.stringify({ type: 'hello', data: { user: r.user, version: config.version } }));
    });
  });
  events.subscribe((e) => {
    const payload = JSON.stringify({ type: e.type, data: e.data, ts: e.ts });
    for (const c of clients) if ((e.userId === '*' || c.userId === e.userId) && c.ws.readyState === WebSocket.OPEN && !(c.device && DEVICE_HIDDEN.has(e.type))) c.ws.send(payload);
  });
  const ping = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) {
        c.ws.terminate();
        clients.delete(c);
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }, 30_000);
  ctx.services.onlineUsers = () => new Set([...clients].map((c) => c.userId));
  // A revoked session (logout, device revoke, disabled user) loses its live connection immediately.
  auth.onRevoke((ids) => {
    for (const c of clients) {
      if (!ids.includes(c.sessionId)) continue;
      clients.delete(c);
      c.ws.close(4401, 'Sessie ingetrokken');
      setTimeout(() => c.ws.terminate(), 2000).unref();
    }
  });

  // ---------- startup ----------
  if (config.mode === 'server' && auth.userCount() === 0 && process.env.TEAMBOT_OWNER_EMAIL && process.env.TEAMBOT_OWNER_PASSWORD) {
    const weak = passwordProblem(process.env.TEAMBOT_OWNER_PASSWORD, { email: process.env.TEAMBOT_OWNER_EMAIL, name: process.env.TEAMBOT_OWNER_NAME });
    if (weak) log.error(`TEAMBOT_OWNER_PASSWORD geweigerd: ${weak} Er is geen eigenaar gemaakt; kies een sterker wachtwoord of maak het account via de pagina.`);
    else {
      auth.createUser({ name: process.env.TEAMBOT_OWNER_NAME || 'Eigenaar', email: process.env.TEAMBOT_OWNER_EMAIL, password: process.env.TEAMBOT_OWNER_PASSWORD, role: 'owner' });
      log.info('Eigenaar-account aangemaakt vanuit omgevingsvariabelen');
    }
  }
  // Exposure report (refusals already stopped the start at the top of createApp); warnings go to the log loudly.
  const exposure = checkExposure(exposureInput(config, auth.userCount()));
  ctx.services.exposure = exposure;
  if (over.listen !== false) for (const f of exposure.findings) if (f.level === 'warn') log.warn(`[beveiliging] ${f.message} ${f.fix}`);
  // A fresh server: the owner account can only be claimed from this computer, or with this one-time code.
  if (config.mode === 'server' && auth.userCount() === 0 && !process.env.TEAMBOT_SETUP_TOKEN) {
    auth.onSetupCode = (code) => {
      if (over.quiet) return;
      // Straight to the console (never into server.log or a diagnostics file).
      const base = config.publicUrl || `http://${isLoopbackHost(config.host) || config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host}:${config.port}`;
      console.log(`\n  Eerste keer: maak het eigenaar-account via deze link (eenmalig):\n  ${base.replace(/\/$/, '')}/#/?setup=${code}\n  Of vul deze code in op de pagina: ${code}\n`);
    };
  }
  // Open approvals of a run that was busy stay open (they resume the run); every other open approval expires.
  const keptApprovals = ctx.broker.expireStale();

  let url = '';
  if (over.listen !== false) {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : config.port;
    config.port = port;
    url = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${port}`;
    if (config.mode === 'server' && auth.userCount() === 0 && !process.env.TEAMBOT_SETUP_TOKEN) auth.ensureSetupCode();
  }
  ctx.runs.recover();
  for (const [uid, n] of keptApprovals)
    ctx.events.emit(uid, 'notification', {
      title: n === 1 ? 'Er wacht nog een goedkeuring van vóór de herstart' : `Er wachten nog ${n} goedkeuringen van vóór de herstart`,
      body: 'De taak is onderbroken. Als je toestaat, gaat de bot verder; weigeren kan ook.',
      link: '#/inbox',
      kind: 'approval',
    });
  runner.resumeLimitRetries();
  queue.start();
  for (const m of mods) {
    try {
      await m.start?.(ctx);
    } catch (e) {
      failed(m, 'start', e);
    }
  }
  log.info(`${config.appName} ${config.version} gestart (${config.mode}) op ${url || '(geen poort)'} — data: ${config.dataDir}`);

  return {
    ctx,
    server,
    url,
    async close() {
      clearInterval(ping);
      runner.stopRetries();
      queue.stop();
      for (const m of [...mods].reverse()) {
        try {
          await m.stop?.(ctx);
        } catch (e) {
          log.error(`[module ${m.id}] stop failed`, e);
        }
      }
      for (const r of ctx.runs.activeRuns()) ctx.runs.cancel(r.id, 'Server gestopt');
      for (const c of clients) c.ws.close();
      await new Promise<void>((r) => server.close(() => r()));
      db.close();
    },
  };
}
