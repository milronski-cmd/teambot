import fs from 'node:fs';
import path from 'node:path';
import { Client, InMemoryTransport, SSEClientTransport, SdkError, SdkErrorCode, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';
import type { Transport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { Ctx } from '../../core/types.js';
import { now } from '../../core/db.js';
import { safeEnv } from '../../tools/builtin/shell.js';
import { assertPublicUrl } from '../../tools/builtin/web.js';
import type { ConnectionRow, ToolRow } from './db.js';
import { entryForConn } from './package.js';
import { googleServer } from './google.js';
import { AuthRequiredError, TeamBotOAuthProvider, getConn, patchOAuth, refreshIfNeeded } from './oauth.js';
import { riskFromAnnotations, riskOf, stricter, toolHash } from './risk.js';
import { cleanError, guardedFetch, killTree, maskSecrets, mayUsePrivateNetwork, mayUseStdio, pidAlive, resolveKV, sleep, withTimeout } from './util.js';

export type RuntimeState = 'stopped' | 'starting' | 'ready' | 'backoff' | 'error' | 'auth_required';

const MAX_CRASHES = 5;
const STABLE_MS = 60_000;
const MAX_TOOLS = 500;

interface Runtime {
  id: string;
  userId: string;
  state: RuntimeState;
  client: Client | null;
  transport: Transport | null;
  starting: Promise<Client> | null;
  lastUsed: number;
  readySince: number;
  stateSince: number;
  crashes: number;
  restarts: number;
  nextRetryAt: number;
  retryTimer: NodeJS.Timeout | null;
  stopping: boolean;
  stderr: string[];
  secretValues: string[];
  lastError: string | null;
  pid: number | null;
  inflight: number;
  /** The server failed the 2026-07-28 probe: use the plain 2025 handshake from now on (this run of TeamBot). */
  legacyOnly?: boolean;
}

export interface RuntimeStatus {
  state: RuntimeState;
  since: string;
  lastError: string | null;
  crashes: number;
  restarts: number;
  nextRetryAt: string | null;
  pid: number | null;
  inflight: number;
  lastUsed: string | null;
}

/** Owns one MCP client per connection: start on demand, health, restart with backoff, idle stop. */
export class McpManager {
  private runtimes = new Map<string, Runtime>();
  private sweeper: NodeJS.Timeout | null = null;
  /** Hook for the module: called after a (re)connect or tool list change. */
  onChange: (userId: string, connId: string) => void = () => {};

  constructor(private ctx: Ctx) {}

  connDir(c: Pick<ConnectionRow, 'id' | 'user_id'>) {
    return path.join(this.ctx.config.dataDir, 'mcp', c.user_id, c.id);
  }

  private rt(c: ConnectionRow): Runtime {
    let r = this.runtimes.get(c.id);
    if (!r) {
      r = {
        id: c.id,
        userId: c.user_id,
        state: 'stopped',
        client: null,
        transport: null,
        starting: null,
        lastUsed: 0,
        readySince: 0,
        stateSince: Date.now(),
        crashes: 0,
        restarts: 0,
        nextRetryAt: 0,
        retryTimer: null,
        stopping: false,
        stderr: [],
        secretValues: [],
        lastError: null,
        pid: null,
        inflight: 0,
      };
      this.runtimes.set(c.id, r);
    }
    return r;
  }

  status(id: string): RuntimeStatus {
    const r = this.runtimes.get(id);
    if (!r) return { state: 'stopped', since: now(), lastError: null, crashes: 0, restarts: 0, nextRetryAt: null, pid: null, inflight: 0, lastUsed: null };
    return {
      state: r.state,
      since: new Date(r.stateSince).toISOString(),
      lastError: r.lastError,
      crashes: r.crashes,
      restarts: r.restarts,
      nextRetryAt: r.state === 'backoff' && r.nextRetryAt ? new Date(r.nextRetryAt).toISOString() : null,
      pid: r.pid,
      inflight: r.inflight,
      lastUsed: r.lastUsed ? new Date(r.lastUsed).toISOString() : null,
    };
  }

  stderrTail(id: string): string[] {
    return [...(this.runtimes.get(id)?.stderr || [])];
  }

  private setState(r: Runtime, state: RuntimeState, err?: string | null) {
    r.state = state;
    r.stateSince = Date.now();
    if (err !== undefined) r.lastError = err;
    const dbStatus = state === 'ready' ? 'connected' : state === 'auth_required' ? 'auth_required' : state === 'error' || state === 'backoff' ? 'error' : state === 'starting' ? 'starting' : 'stopped';
    try {
      const c = getConn(this.ctx, r.id);
      if (c) this.ctx.store.update('mcp_connections', r.id, { status: dbStatus, last_error: state === 'ready' ? null : (r.lastError ?? c.last_error), updated_at: now() });
    } catch {
      /* connection deleted */
    }
    this.ctx.events.emit(r.userId, 'mcp.status', { id: r.id, ...this.status(r.id) });
  }

  /** Get a connected client, starting the server on demand. */
  async client(c: ConnectionRow, opts: { force?: boolean } = {}): Promise<Client> {
    const r = this.rt(c);
    r.lastUsed = Date.now();
    if (r.client && r.state === 'ready') return r.client;
    if (r.starting) return r.starting;
    if (!c.enabled && !opts.force) throw new Error(`${label(c)} staat uit.`);
    if (!opts.force) {
      if (r.state === 'error') throw new Error(r.lastError || `${label(c)} is in foutstatus. Klik op “Opnieuw verbinden”.`);
      if (r.state === 'auth_required') throw new AuthRequiredError(`${label(c)}: opnieuw inloggen nodig. Open Apps en klik op “Inloggen”.`);
      if (r.state === 'backoff') {
        const wait = r.nextRetryAt - Date.now();
        if (wait > 10_000) throw new Error(`${label(c)} is gecrasht; nieuwe poging over ${Math.ceil(wait / 1000)} s. ${r.lastError || ''}`.trim());
        if (wait > 0) await sleep(wait);
      }
    } else {
      r.crashes = 0;
    }
    if (r.retryTimer) clearTimeout(r.retryTimer);
    r.retryTimer = null;
    if (r.client && r.state === 'ready') return r.client;
    if (r.starting) return r.starting;
    r.starting = this.open(r, c).finally(() => {
      r.starting = null;
    });
    return r.starting;
  }

  private async makeTransport(c: ConnectionRow, r: Runtime): Promise<Transport> {
    if (c.transport === 'builtin') {
      // A server inside TeamBot itself (Google): the client talks to it over a linked in-memory pair.
      const [mine, theirs] = InMemoryTransport.createLinkedPair();
      await googleServer(this.ctx, this, c).connect(theirs);
      return mine;
    }
    if (c.transport === 'stdio') {
      if (!mayUseStdio(this.ctx, c.user_id)) throw new Error('Lokale programma’s (stdio) zijn op deze server alleen voor beheerders toegestaan.');
      if (!c.command) throw new Error('Geen opdracht ingesteld.');
      if (!c.trusted_at) throw new Error('Bevestig eerst dat je deze opdracht vertrouwt (Apps › koppeling › Bewerken).');
      const { values, secrets, missing } = resolveKV(this.ctx, c.user_id, c.env);
      if (missing.length) throw new Error(`Geheim ontbreekt voor: ${missing.join(', ')}`);
      r.secretValues = secrets;
      let cwd = c.cwd;
      if (cwd) {
        if (!path.isAbsolute(cwd) || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`Werkmap bestaat niet: ${cwd}`);
      } else {
        cwd = this.connDir(c);
        fs.mkdirSync(cwd, { recursive: true });
      }
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(safeEnv(values))) if (typeof v === 'string') env[k] = v;
      const t = new StdioClientTransport({ command: c.command, args: c.args || [], env, cwd, stderr: 'pipe' });
      t.stderr?.on('data', (chunk: Buffer) => this.pushStderr(r, chunk));
      return t;
    }
    const allowPrivate = !!c.allow_private && mayUsePrivateNetwork(this.ctx, c.user_id);
    const url = await assertPublicUrl(c.url, allowPrivate);
    const { values: headers, secrets, missing } = resolveKV(this.ctx, c.user_id, c.headers);
    if (missing.length) throw new Error(`Geheim ontbreekt voor header: ${missing.join(', ')}`);
    r.secretValues = secrets;
    let authProvider: TeamBotOAuthProvider | undefined;
    if (c.auth === 'oauth') {
      await refreshIfNeeded(this.ctx, c);
      authProvider = new TeamBotOAuthProvider(this.ctx, c.id, () => this.markAuthRequired(c.id));
    }
    const fetchFn = guardedFetch(allowPrivate);
    if (c.transport === 'sse') return new SSEClientTransport(url, { requestInit: { headers }, fetch: fetchFn, authProvider });
    return new StreamableHTTPClientTransport(url, { requestInit: { headers }, fetch: fetchFn, authProvider, reconnectionOptions: { maxRetries: 2, initialReconnectionDelay: 1000, maxReconnectionDelay: 10_000, reconnectionDelayGrowFactor: 2 } });
  }

  private pushStderr(r: Runtime, chunk: Buffer) {
    const lines = maskSecrets(chunk.toString('utf8'), r.secretValues).split(/\r?\n/).filter((l) => l.trim());
    for (const l of lines) r.stderr.push(l.slice(0, 500));
    if (r.stderr.length > 60) r.stderr.splice(0, r.stderr.length - 60);
  }

  markAuthRequired(connId: string) {
    const r = this.runtimes.get(connId);
    const c = getConn(this.ctx, connId);
    if (!c) return;
    patchOAuth(this.ctx, connId, { status: 'expired' });
    if (r) this.setState(r, 'auth_required', 'Toegang verlopen of ingetrokken: log opnieuw in.');
    else this.ctx.store.update('mcp_connections', connId, { status: 'auth_required', last_error: 'Toegang verlopen of ingetrokken: log opnieuw in.', updated_at: now() });
    this.ctx.events.emit(c.user_id, 'notification', { title: `${label(c)}: opnieuw inloggen`, body: 'De toegang is verlopen of ingetrokken. Open Apps om opnieuw in te loggen.', link: `#/m/mcp/c/${c.id}`, kind: 'mcp' });
  }

  private async open(r: Runtime, c: ConnectionRow): Promise<Client> {
    r.stopping = false;
    this.setState(r, 'starting');
    let transport: Transport | null = null;
    // Remote (Streamable HTTP) servers: speak spec 2026-07-28 when the server does, else the 2025 handshake (one extra
    // round trip). stdio stays on the plain handshake: the SDK would probe with a second copy of the program, and SSE
    // is a 2025-only transport. A server that answers the probe badly (a 5xx or an unusable reply on an unknown
    // method) gets the plain handshake on a fresh connection, and keeps it for this run of TeamBot.
    const probe = c.transport === 'http' && !r.legacyOnly;
    const makeClient = (auto: boolean) => {
      const cl = new Client(
        { name: this.ctx.config.appName || 'TeamBot', version: this.ctx.config.version },
        {
          capabilities: {},
          ...(auto ? { versionNegotiation: { mode: 'auto' as const } } : {}),
          listMaxPages: 20,
          listChanged: {
            tools: {
              onChanged: (err, tools) => {
                if (!err && tools) {
                  this.syncTools(c.id, tools);
                  this.onChange(c.user_id, c.id);
                }
              },
            },
          },
        },
      );
      cl.onclose = () => this.handleClose(r, cl);
      cl.onerror = (e) => {
        if (r.state === 'ready') r.lastError = cleanError(e, r.secretValues);
      };
      return cl;
    };
    let client = makeClient(probe);
    const timeout = c.transport === 'stdio' ? 120_000 : 30_000;
    try {
      transport = await this.makeTransport(c, r);
      try {
        await withTimeout(client.connect(transport, { timeout }), timeout + 2000, 'Verbinden duurde te lang (time-out).');
      } catch (e: any) {
        if (!probe || !(e instanceof SdkError && e.code === SdkErrorCode.EraNegotiationFailed)) throw e;
        await client.close().catch(() => {});
        r.legacyOnly = true;
        client = makeClient(false);
        transport = await this.makeTransport(c, r);
        await withTimeout(client.connect(transport, { timeout }), timeout + 2000, 'Verbinden duurde te lang (time-out).');
      }
    } catch (e: any) {
      r.client = client;
      r.transport = transport;
      r.pid = (transport as any)?.pid ?? null;
      await this.closeClient(r);
      if (e instanceof AuthRequiredError || e instanceof UnauthorizedError || /\b401\b|unauthorized/i.test(String(e?.message))) {
        if (c.auth === 'oauth') {
          this.markAuthRequired(c.id);
          throw new AuthRequiredError(`${label(c)}: inloggen nodig. Open Apps en klik op “Inloggen”.`);
        }
        this.setState(r, 'error', 'De server weigert de toegang (401). Controleer de token/headers.');
        throw new Error(r.lastError!);
      }
      const tail = r.stderr.slice(-3).join(' · ');
      const msg = `Server start niet: ${cleanError(e, r.secretValues)}${tail ? ` — ${tail}` : ''}`;
      r.crashes++;
      if (r.crashes >= MAX_CRASHES) this.setState(r, 'error', `${msg} (${r.crashes}× mislukt; klik op “Opnieuw verbinden” na het oplossen)`);
      else {
        r.nextRetryAt = Date.now() + backoff(r.crashes);
        this.setState(r, 'backoff', msg);
      }
      throw new Error(msg);
    }
    r.client = client;
    r.transport = transport;
    r.pid = (transport as any)?.pid ?? null;
    r.readySince = Date.now();
    r.lastError = null;
    const caps = client.getServerCapabilities() || {};
    const ver = client.getServerVersion();
    this.ctx.store.update('mcp_connections', c.id, {
      server_info: {
        name: String(ver?.name || '').slice(0, 200),
        version: String(ver?.version || '').slice(0, 100),
        protocol: client.getNegotiatedProtocolVersion(),
        capabilities: { tools: !!caps.tools, resources: !!caps.resources, prompts: !!caps.prompts, logging: !!caps.logging },
        instructions: String(client.getInstructions() || '').slice(0, 4000),
      },
      updated_at: now(),
    });
    if (caps.tools) {
      try {
        this.syncTools(c.id, await this.listAllTools(client, c));
      } catch (e: any) {
        r.lastError = `Tools ophalen mislukt: ${cleanError(e, r.secretValues)}`;
      }
    }
    this.setState(r, 'ready', r.lastError);
    this.onChange(c.user_id, c.id);
    return client;
  }

  private async listAllTools(client: Client, c: ConnectionRow) {
    // SDK v2: without a cursor, listTools walks every page itself (capped by listMaxPages).
    const res = await client.listTools(undefined, { timeout: c.timeout_sec * 1000 });
    return (res.tools || []).slice(0, MAX_TOOLS);
  }

  /** Merge the server's tool list into mcp_tools. Risks only escalate automatically; changed tools need re-approval. */
  syncTools(connId: string, tools: any[]) {
    const ctx = this.ctx;
    const c = getConn(ctx, connId);
    if (!c) return;
    const overrides = entryForConn(c)?.riskOverrides || {};
    const existing = new Map(ctx.store.find<ToolRow>('mcp_tools', { connection_id: connId }).map((t) => [t.name, t]));
    const seen = new Set<string>();
    const ts = now();
    let newCount = 0;
    const loosened: string[] = [];
    ctx.store.tx(() => {
      for (const t of tools.slice(0, MAX_TOOLS)) {
        const name = String(t?.name || '').slice(0, 128);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const annotations = t.annotations && typeof t.annotations === 'object' ? t.annotations : {};
        const schema = t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} };
        const hint = stricter(riskFromAnnotations(annotations, name, String(t.description || '')), overrides[name]);
        const hash = toolHash({ description: t.description, inputSchema: schema, annotations });
        const row = existing.get(name);
        // Risks only escalate automatically, with one exception: a tool that was "schrijven" only because its server
        // gave no annotations, and that TeamBot now recognises as probably read-only (same name, description and
        // schema: the server changed nothing). That is TeamBot's own rule getting better, not a server loosening itself.
        const guessedNow = row && hint === 'read' && row.server_risk === 'write' && row.hint_risk === 'write' && row.schema_hash === hash && riskOf(annotations, name, '', false).risk === 'write';
        const base = {
          title: String(t.title || annotations.title || '').slice(0, 200),
          description: String(t.description || '').slice(0, 4000),
          input_schema: schema,
          annotations,
          hint_risk: hint,
          schema_hash: hash,
          present: 1,
          last_seen: ts,
        };
        if (guessedNow) loosened.push(name);
        if (!row) {
          newCount++;
          ctx.store.insert('mcp_tools', { connection_id: connId, name, ...base, server_risk: hint, user_risk: null, enabled: true, approved: false, changed: false, first_seen: ts });
        } else {
          const changed = row.approved && row.schema_hash !== hash;
          ctx.store.exec(
            'UPDATE mcp_tools SET title = ?, description = ?, input_schema = ?, annotations = ?, hint_risk = ?, server_risk = ?, schema_hash = ?, present = 1, last_seen = ?, approved = ?, changed = ? WHERE connection_id = ? AND name = ?',
            base.title,
            base.description,
            JSON.stringify(schema),
            JSON.stringify(annotations),
            hint,
            guessedNow ? 'read' : stricter(row.server_risk, hint),
            hash,
            ts,
            changed ? 0 : row.approved ? 1 : 0,
            changed || row.changed ? 1 : 0,
            connId,
            name,
          );
        }
      }
      for (const name of existing.keys()) if (!seen.has(name)) ctx.store.exec('UPDATE mcp_tools SET present = 0 WHERE connection_id = ? AND name = ?', connId, name);
    });
    // In the log, so the owner can see why a tool became "lezen" without him changing it.
    if (loosened.length) ctx.audit(c.user_id, 'mcp.tool.risk_guessed', { id: c.id, tools: loosened.slice(0, 50), to: 'read' });
    if (c.verified_at && newCount) {
      ctx.events.emit(c.user_id, 'notification', { title: `${label(c)}: nieuwe tools`, body: newCount === 1 ? '1 nieuwe tool gevonden. Die is pas bruikbaar nadat je hem goedkeurt.' : `${newCount} nieuwe tools gevonden. Ze zijn pas bruikbaar nadat je ze goedkeurt.`, link: `#/m/mcp/c/${c.id}`, kind: 'mcp' });
    }
  }

  private handleClose(r: Runtime, client: Client) {
    if (r.client !== client) return; // stale client (already replaced or never became ready)
    r.client = null;
    r.transport = null;
    if (r.stopping) return;
    const c = getConn(this.ctx, r.id);
    if (!c) return;
    if (Date.now() - r.readySince > STABLE_MS) r.crashes = 0;
    r.crashes++;
    r.restarts++;
    const tail = r.stderr.slice(-3).join(' · ');
    const msg = `Server is onverwacht gestopt${tail ? `: ${tail}` : ''}`;
    this.ctx.audit(c.user_id, 'mcp.crashed', { connection: c.id, name: c.name, crashes: r.crashes });
    if (r.crashes >= MAX_CRASHES) {
      this.setState(r, 'error', `${msg} — ${r.crashes}× achter elkaar; automatisch herstarten gestopt. Klik op “Opnieuw verbinden”.`);
      this.ctx.events.emit(c.user_id, 'notification', { title: `${label(c)} crasht steeds`, body: 'Automatisch herstarten is gestopt. Bekijk de foutmelding in Apps.', link: `#/m/mcp/c/${c.id}`, kind: 'mcp' });
      return;
    }
    const delay = backoff(r.crashes);
    r.nextRetryAt = Date.now() + delay;
    this.setState(r, 'backoff', msg);
    const recentlyUsed = Date.now() - r.lastUsed < Math.max(1, c.idle_minutes || 10) * 60_000;
    if (recentlyUsed && c.enabled) {
      r.retryTimer = setTimeout(() => {
        r.retryTimer = null;
        const fresh = getConn(this.ctx, r.id);
        if (fresh?.enabled && r.state === 'backoff') this.client(fresh).catch(() => {});
      }, delay);
      r.retryTimer.unref?.();
    }
  }

  private async closeClient(r: Runtime) {
    const client = r.client;
    const transport = r.transport as any;
    const pid: number | null = transport?.pid ?? r.pid ?? null;
    r.stopping = true;
    r.client = null;
    r.transport = null;
    if (transport instanceof StdioClientTransport && process.platform === 'win32' && pid) {
      // cmd.exe wrappers (npx) do not forward signals: end stdin, then kill the whole tree.
      // The SDK keeps the child in a private field; we only use it to end stdin gracefully.
      const proc: import('node:child_process').ChildProcess | undefined = (transport as any)._process;
      const exited = proc ? new Promise<boolean>((res) => proc.once('close', () => res(true))) : Promise.resolve(true);
      try {
        proc?.stdin?.end();
      } catch {
        /* ignore */
      }
      const ok = await Promise.race([exited, sleep(1000).then(() => false)]);
      if (!ok || pidAlive(pid)) await killTree(pid);
    }
    try {
      if (client) await withTimeout(client.close(), 6000, 'close timeout');
      else if (transport) await withTimeout(transport.close(), 6000, 'close timeout');
    } catch {
      /* ignore */
    }
    if (pid && pidAlive(pid)) await killTree(pid);
    r.pid = null;
  }

  async stop(id: string, reason = 'gestopt') {
    const r = this.runtimes.get(id);
    if (!r) return;
    if (r.retryTimer) clearTimeout(r.retryTimer);
    r.retryTimer = null;
    if (r.starting) {
      try {
        await r.starting;
      } catch {
        /* ignore */
      }
    }
    await this.closeClient(r);
    r.crashes = 0;
    if (getConn(this.ctx, id)) this.setState(r, 'stopped', reason === 'idle' ? null : r.lastError);
  }

  /** Stop and forget (connection deleted). */
  async remove(id: string) {
    await this.stop(id, 'verwijderd');
    this.runtimes.delete(id);
  }

  async restart(c: ConnectionRow): Promise<Client> {
    await this.stop(c.id, 'herstart');
    const r = this.rt(c);
    r.crashes = 0;
    r.stderr = [];
    r.lastError = null;
    return this.client(getConn(this.ctx, c.id)!, { force: true });
  }

  /** Run a request against the server, tracking in-flight work and auth failures. */
  async use<T>(c: ConnectionRow, fn: (client: Client) => Promise<T>): Promise<T> {
    const client = await this.client(c);
    const r = this.rt(c);
    r.inflight++;
    try {
      return await fn(client);
    } catch (e: any) {
      if (e instanceof AuthRequiredError || e instanceof UnauthorizedError) {
        this.markAuthRequired(c.id);
        throw new AuthRequiredError(`${label(c)}: opnieuw inloggen nodig.`);
      }
      throw new Error(cleanError(e, r.secretValues));
    } finally {
      r.inflight--;
      r.lastUsed = Date.now();
    }
  }

  startSweeper() {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweepIdle(), 30_000);
    this.sweeper.unref?.();
  }

  async sweepIdle() {
    for (const r of this.runtimes.values()) {
      if (r.state !== 'ready' || r.inflight > 0) continue;
      const c = getConn(this.ctx, r.id);
      if (!c) {
        await this.remove(r.id);
        continue;
      }
      const idleMs = (c.idle_minutes ?? 10) * 60_000;
      if (idleMs > 0 && Date.now() - r.lastUsed > idleMs) await this.stop(r.id, 'idle');
    }
  }

  async stopAll() {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    await Promise.all([...this.runtimes.keys()].map((id) => this.stop(id, 'server gestopt').catch(() => {})));
  }
}

function backoff(n: number) {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, n - 1));
}

export function label(c: Pick<ConnectionRow, 'name' | 'label'>) {
  return c.label ? `${c.name} (${c.label})` : c.name;
}
