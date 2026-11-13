import fs from 'node:fs';
import path from 'node:path';
import type { AgentRunRequest, AgentEvent, Ctx, Module, ProviderAdapter, ProviderConfig, ProviderKind } from '../../core/types.js';
import { ah, bad, forbidden, notFound, str, user } from '../../core/http.js';
import { now } from '../../core/db.js';
import { agentForThread } from '../../agent/shared.js';
import { missedTurns } from '../../agent/prompt.js';
import { CLI_DEFS, checkCustomArgs, checkExtraArgs, defById, fileExists, installLines, installPlan, type CliDef } from './catalog.js';
import { findBinary, findBinarySource, parseVersion, runQuick, setBinEnv, type Proc } from './proc.js';
import { ensure as ensureToolchain, find as findToolchain, status as toolchainStatus } from '../../core/runtimes.js';
import { jobs } from './jobs.js';
import { isRuntimeId, Runtimes } from './runtimes.js';
import { DEVICE_LOGIN, DeviceLogins, loginCommand, openTerminal, PASTE_LOGIN } from './login.js';
import { PermissionBridge } from './bridge.js';
import { assertMayRun, cliOptions, makeScope, parseContextState, resumeNote, stoppedTaskNote, workdir, type ContextState, type SessionContext } from './context.js';
import { compactClaudeSession, readClaudeUsage, readCodexLimits, readOpencodeStats, type CompactResult } from './usage.js';
import type { LimitReport } from '../usage/parse.js';
import { runClaude } from './claude.js';
import { claudeModels } from './claude-models.js';
import { codexIsolation, codexModels, runCodex } from './codex.js';
import { codexReadGuard, codexReadText } from './codex-sandbox.js';
import { compactCodexSession } from './compact.js';
import { runAcp } from './acp.js';
import { cliComplete } from './complete.js';
import { autoDefaultProvider, ensureFreeDefaultModel } from '../../api/providers.js';
import { rememberFreeReserve } from '../../agent/alternatives.js';
import { withCapabilities } from '../../providers/capabilities.js';
import { prettyModel } from '../../../shared/modelLabel.js';
import { EngineVersions, versionRoutes } from './versions.js';
import { servedTools } from './toolhost.js';
import { hardBlocksByLevel } from './permissions.js';
import { appViews, appsOff, codexConfigApps, discoverClaudeApps, knownApps, opencodeConfigApps, type EngineAppView } from './engine-apps.js';
import { PLACE } from '../../../shared/places.js';

/**
 * CLI-agents: bots that run on the user's own official agent CLIs (Claude Code,
 * Codex, and ACP agents such as Gemini CLI, OpenCode, Copilot, Cursor, Kimi,
 * Hermes, Grok Build, Cline, Qwen Code, or a custom ACP runner).
 */

export interface CliStatus {
  id: string;
  label: string;
  engine: CliDef['engine'];
  installed: boolean;
  path?: string;
  /** teambot = TeamBot's own copy; gevonden = a system install; andere-app = a copy inside another app (pathApp). */
  pathSource?: 'provider' | 'instelling' | 'teambot' | 'gevonden' | 'andere-app';
  pathApp?: string;
  version?: string;
  loggedIn?: boolean;
  authMethod?: string;
  billing: 'subscription' | 'api' | 'unknown';
  billingPath: string;
  detail: string;
  checkedAt: string;
  /** Set when the CLI changed something without asking TeamBot (ask/readonly refused until reset). */
  unsafe?: { at: string; kind: string; title: string };
}

const SETTING = 'cliAgents';
const TTL = 30_000;

export class CliAgents {
  bridge: PermissionBridge;
  /** TeamBot's own copies of Claude Code, Codex and OpenCode (runtimes.ts). */
  runtimes: Runtimes;
  logins: DeviceLogins;
  procs = new Set<Proc>();
  private cache = new Map<string, { at: number; v: CliStatus }>();
  private help = new Map<string, string>();
  /** Every status read of a CLI's default binary (engine version pinning, versions.ts). */
  onStatus?: (def: CliDef, st: CliStatus) => void;

  /** TeamBot's data folder (its own Node.js and other runtimes live there). */
  get dataDir(): string {
    return this.ctx.config.dataDir;
  }

  constructor(private ctx: Ctx) {
    this.bridge = new PermissionBridge(ctx.config.dataDir);
    this.runtimes = new Runtimes(ctx.config.dataDir);
    this.logins = new DeviceLogins();
  }

  ownerId(): string | null {
    return this.ctx.auth.owner()?.id ?? null;
  }

  settings(): { paths: Record<string, string>; unsafe: Record<string, { at: string; kind: string; title: string }> } {
    const o = this.ownerId();
    const s = o ? this.ctx.store.getSetting<any>(o, SETTING, {}) : {};
    return { paths: s?.paths && typeof s.paths === 'object' ? s.paths : {}, unsafe: s?.unsafe && typeof s.unsafe === 'object' ? s.unsafe : {} };
  }

  /** Safety net state per CLI: set when a CLI changed something without asking TeamBot in ask/readonly mode. */
  setUnsafe(id: string, info: { kind: string; title: string } | null) {
    const o = this.ownerId();
    if (!o) return;
    const cur = this.settings();
    if (info) cur.unsafe[id] = { at: new Date().toISOString(), ...info };
    else delete cur.unsafe[id];
    this.ctx.store.setSetting(o, SETTING, cur);
    this.clear();
  }

  setPath(id: string, p: string | null) {
    const o = this.ownerId();
    if (!o) throw bad('Geen eigenaar gevonden');
    const cur = this.settings();
    if (p) cur.paths[id] = p;
    else delete cur.paths[id];
    this.ctx.store.setSetting(o, SETTING, cur);
    this.clear();
  }

  clear() {
    this.cache.clear();
    this.help.clear();
  }

  track = (p: Proc) => {
    this.procs.add(p);
    return () => this.procs.delete(p);
  };

  /**
   * Which binary to run: provider override → owner setting → TeamBot's own copy → a system install (PATH, the usual
   * install folders) → as a last resort a copy inside another app (named, so the UI can say so).
   */
  async resolveBin(def: CliDef, cfg?: ProviderConfig | null): Promise<{ bin: string | null; source?: CliStatus['pathSource']; app?: string }> {
    const fromCfg = def.custom ? cfg?.config?.command : cfg?.config?.path;
    if (fromCfg) {
      const p = path.isAbsolute(fromCfg) ? fromCfg : findBinary([fromCfg]);
      return { bin: p && fs.existsSync(p) ? p : null, source: 'provider' };
    }
    const set = this.settings().paths[def.id];
    if (set) return { bin: fs.existsSync(set) ? set : null, source: 'instelling' };
    if (def.custom) return { bin: null };
    const own = isRuntimeId(def.id) ? this.runtimes.current(def.id) : null;
    if (own) return { bin: own.bin, source: 'teambot' };
    for (const name of def.bins) {
      const hit = findBinarySource([name]);
      if (!hit) continue;
      if (def.verify && !def.verify.test(await this.helpText(hit.path))) continue;
      return hit.app ? { bin: hit.path, source: 'andere-app', app: hit.app } : { bin: hit.path, source: 'gevonden' };
    }
    // Installed by TeamBot with its own Node.js ("Installeren" on a computer without npm): it runs with that Node.js.
    for (const id of ['node', 'uv'] as const) {
      const t = findToolchain(id, this.dataDir);
      if (t?.source !== 'teambot') continue;
      const env = t.env(process.env);
      const dirs = [...t.pathDirs, ...(env.UV_TOOL_BIN_DIR ? [env.UV_TOOL_BIN_DIR] : [])];
      for (const name of def.bins) {
        const p = findBinary([name], dirs);
        if (!p || !dirs.some((d) => path.resolve(p).toLowerCase().startsWith(path.resolve(d).toLowerCase()))) continue;
        if (def.verify && !def.verify.test(await this.helpText(p))) continue;
        setBinEnv(p, Object.fromEntries(Object.entries(env).filter(([k]) => k.toUpperCase() === 'PATH' || k.startsWith('npm_config_') || k.startsWith('UV_'))));
        return { bin: p, source: 'teambot' };
      }
    }
    return { bin: null };
  }

  async helpText(bin: string): Promise<string> {
    const c = this.help.get(bin);
    if (c !== undefined) return c;
    const r = await runQuick(bin, ['--help'], { timeoutMs: 10_000 });
    const t = (r.stdout + '\n' + r.stderr).slice(0, 100_000);
    this.help.set(bin, t);
    return t;
  }

  /** Install / version / login state without running a prompt. Never returns emails, tokens or org names. */
  async status(def: CliDef, cfg?: ProviderConfig | null, fresh = false): Promise<CliStatus> {
    const { bin, source, app } = await this.resolveBin(def, cfg);
    const key = `${def.id}:${bin || ''}`;
    const c = this.cache.get(key);
    if (!fresh && c && Date.now() - c.at < TTL) return c.v;
    // A CLI with free models (OpenCode, Kilo) says so, instead of "Actief pad: Onbekend" right after "Gratis starten".
    const billingPath = def.billing === 'free' ? 'Gratis modellen; andere modellen via je eigen sleutels of account in de CLI' : 'Onbekend';
    const base: CliStatus = { id: def.id, label: def.label, engine: def.engine, installed: false, billing: 'unknown', billingPath, detail: '', checkedAt: new Date().toISOString(), unsafe: this.settings().unsafe[def.id] };
    if (!bin) {
      base.detail = def.custom ? 'Stel het programma van je ACP-agent in bij de provider.' : source ? 'Het ingestelde pad bestaat niet (meer).' : `Niet gevonden in PATH of de gebruikelijke installatiemappen. Installeer ${def.label} of stel het pad in.`;
      this.cache.set(key, { at: Date.now(), v: base });
      return base;
    }
    const v = await runQuick(bin, def.versionArgs, { timeoutMs: 15_000 });
    const st: CliStatus = { ...base, path: bin, pathSource: source, pathApp: app, installed: v.code === 0 || !!parseVersion(v.stdout), version: parseVersion(v.stdout || v.stderr) };
    if (!st.installed) {
      st.detail = v.error ? `Kan het programma niet starten: ${v.error}` : `Het programma reageert niet op ${def.versionArgs.join(' ')} (exitcode ${v.code}).`;
    } else {
      await this.authState(def, bin, st);
    }
    if (def.unsupported) st.detail = def.unsupported;
    this.cache.set(key, { at: Date.now(), v: st });
    if (!cfg?.config?.path && !cfg?.config?.command) this.onStatus?.(def, st);
    return st;
  }

  private async authState(def: CliDef, bin: string, st: CliStatus) {
    const a = def.auth;
    if (!a) {
      st.detail = 'Inlogstatus is niet zonder prompt te controleren. Log zo nodig in met: ' + def.login;
      return;
    }
    try {
      if (a.kind === 'claude') {
        const r = await runQuick(bin, ['auth', 'status', '--json'], { timeoutMs: 15_000 });
        let j: any = null;
        try {
          j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
        } catch {
          /* not json */
        }
        st.loggedIn = typeof j?.loggedIn === 'boolean' ? j.loggedIn : r.code === 0 ? true : r.code === 1 ? false : undefined;
        const m = String(j?.authMethod || '');
        st.authMethod = m || undefined;
        if (/claude\.ai|oauth/.test(m)) {
          st.billing = 'subscription';
          st.billingPath = j?.subscriptionType ? `Claude-abonnement (${String(j.subscriptionType).replace(/[^\w -]/g, '')})` : 'Je Claude-abonnement';
        } else if (/api_key|third_party/.test(m)) {
          st.billing = 'api';
          st.billingPath = m === 'third_party' ? 'Cloudprovider (Bedrock/Vertex/Foundry) — betaal per gebruik' : 'API-sleutel — betaal per gebruik';
        }
        st.detail = st.loggedIn ? (m ? `Ingelogd via ${m}.` : 'Ingelogd.') : `Niet ingelogd. Log hieronder in TeamBot in, of in een terminal met: ${def.login}`;
      } else if (a.kind === 'codex') {
        const r = await runQuick(bin, ['login', 'status'], { timeoutMs: 15_000 });
        const t = r.stdout + r.stderr;
        st.loggedIn = r.code === 0 && !/not logged in/i.test(t) ? true : /not logged in/i.test(t) || r.code === 1 ? false : undefined;
        if (st.loggedIn && /chatgpt/i.test(t)) {
          st.billing = 'subscription';
          st.authMethod = 'chatgpt';
          // (a phrase, not one word: single words are not picked up for translation, acceptance round 5 C-15)
          st.billingPath = 'Je ChatGPT-abonnement';
        } else if (st.loggedIn && /api key/i.test(t)) {
          st.billing = 'api';
          st.authMethod = 'api-key';
          st.billingPath = 'OpenAI API-sleutel — betaal per gebruik';
        }
        st.detail = st.loggedIn ? (st.authMethod === 'chatgpt' ? 'Ingelogd met ChatGPT.' : st.authMethod ? 'Ingelogd met een API-sleutel.' : 'Ingelogd.') : `Niet ingelogd. Log hieronder in TeamBot in, of in een terminal met: ${def.login}`;
      } else if (a.kind === 'cmd') {
        const r = await runQuick(bin, a.args, { timeoutMs: 15_000 });
        const t = r.stdout + r.stderr;
        st.loggedIn = /not (logged|authenticated|signed)|login required|unauthenticated/i.test(t) ? false : r.code === 0 ? true : undefined;
        st.detail = st.loggedIn === false ? `Niet ingelogd. Log zelf in met: ${def.login}` : st.loggedIn ? 'Ingelogd.' : 'Inlogstatus onbekend.';
      } else if (a.kind === 'files') {
        const found = (typeof a.files === 'function' ? a.files() : a.files).some(fileExists);
        st.loggedIn = found ? true : a.sole ? false : undefined;
        st.detail = found ? 'Inloggegevens van de CLI gevonden.' : a.sole ? `Geen login gevonden. Log zelf in met: ${def.login}` : `Geen inlogbestand gevonden (de CLI kan ook de sleutelbos gebruiken). Log zo nodig in met: ${def.login}`;
      } else if (a.kind === 'settings') {
        let method = '';
        try {
          const j = JSON.parse(fs.readFileSync(a.file, 'utf8'));
          method = String(j?.security?.auth?.selectedType || j?.selectedAuthType || '');
        } catch {
          /* no settings yet */
        }
        st.authMethod = method.replace(/[^\w.-]/g, '') || undefined;
        st.detail = method ? `Inlogmethode ingesteld: ${st.authMethod}.` : `Nog geen inlogmethode gekozen. Log zelf in met: ${def.login}`;
        if (!method) st.loggedIn = false;
        if (/oauth|login|google|qwen/i.test(method)) {
          st.billing = 'subscription';
          st.billingPath = 'Eigen account/abonnement van de CLI';
        } else if (/api|key|vertex/i.test(method)) {
          st.billing = 'api';
          st.billingPath = 'API-sleutel — betaal per gebruik';
        }
      }
    } catch (e: any) {
      st.detail = `Inlogstatus kon niet worden gecontroleerd: ${String(e?.message || e).slice(0, 200)}`;
    }
  }

  async acpLaunch(def: CliDef, bin: string, cfg: ProviderConfig, model?: string): Promise<string[]> {
    let args = def.custom ? checkCustomArgs(cfg.config?.args) : [...(def.acpArgs || [])];
    if (!def.custom && def.legacy) {
      const v = (await this.status(def, cfg)).version;
      if (v && Number(v.split('.')[0]) < def.legacy.below) args = [...def.legacy.acpArgs];
    }
    if (!def.custom && def.acpProbe && def.acpFallback) {
      const h = await this.helpText(bin);
      if (!h.includes(def.acpProbe) && h.includes(def.acpFallback[0])) args = [...def.acpFallback];
    }
    if (model && model !== 'default' && def.modelFlag && /^[\w.:/@+-]{1,120}$/.test(model)) args = [def.modelFlag, model, ...args];
    return args;
  }

  kind(def: CliDef): ProviderKind {
    const self = this;
    return {
      id: def.id,
      label: def.label,
      type: 'cli',
      group: 'cli',
      needsKey: false,
      docsUrl: def.docsUrl,
      description: def.description,
      authNote: def.authNote,
      billingNote: def.billingNote,
      billing: def.billing,
      experimental: def.experimental,
      models: def.models,
      defaultModel: def.models?.[0],
      detect: async () => {
        const s = await self.status(def);
        return { installed: s.installed, version: s.version, loggedIn: s.loggedIn, detail: s.detail };
      },
      create(cfg: ProviderConfig, _key: string | null, ctx: Ctx): ProviderAdapter {
        return {
          kind: def.id,
          async listModels() {
            // The actual login decides: Claude/Codex with a subscription login → "abonnement", with an API key → "betaald".
            const live = def.billing === 'subscription' ? (await self.status(def, cfg).catch(() => null))?.billing : undefined;
            const billing = live === 'api' ? ('paid' as const) : live === 'subscription' ? ('subscription' as const) : undefined;
            const base = (def.models || ['default']).map((id) => ({ id, label: id === 'default' ? 'Standaard (instelling van de CLI)' : id, tools: true, billing }));
            if (def.modelsArgs) {
              const { bin } = await self.resolveBin(def, cfg);
              // OpenCode picks how deeply a model thinks itself (its own model variants); TeamBot has no level to set.
              const list = bin ? [base[0], ...(await cliModelList(bin, def.modelsArgs))] : base;
              return list.map((m) => ({ ...m, reasoningLevels: [] as string[] }));
            }
            if (def.engine === 'claude') {
              // Aliases and the full model ids this Claude Code login has, from its own /model command (no cost).
              const { bin } = await self.resolveBin(def, cfg);
              const list = bin ? await claudeModels(bin, path.join(ctx.config.dataDir, 'cli-agents', 'usage')).catch(() => null) : null;
              return (list?.length ? list.map((m) => ({ ...m, tools: true, billing })) : base).map((m) => withCapabilities('claude-code', null, m));
            }
            if (def.engine !== 'codex') return base;
            try {
              const { bin } = await self.resolveBin(def, cfg);
              if (!bin) return base;
              const dir = path.join(ctx.config.dataDir, 'cli-agents');
              fs.mkdirSync(dir, { recursive: true });
              const list = (await codexModels(bin, dir)).map((m: any) => ({ ...m, billing }));
              // "Standaard": the levels of the model Codex uses by default.
              const def0 = list.find((m: any) => m.isDefault);
              return [{ ...base[0], reasoningLevels: def0?.reasoningLevels, defaultReasoning: def0?.defaultReasoning, vision: def0?.vision, capSource: def0 ? 'Codex' : undefined }, ...list];
            } catch {
              return base;
            }
          },
          async test() {
            const s = await self.status(def, cfg, true);
            if (!s.installed) return { ok: false, detail: s.detail || `${def.label} niet gevonden` };
            if (s.loggedIn === false) return { ok: false, detail: s.detail };
            return { ok: true, detail: `${def.label} ${s.version || ''} gevonden. ${s.detail} Facturatie: ${s.billingPath}.`.replace(/\s+/g, ' ').trim() };
          },
          runAgent(req: AgentRunRequest, signal: AbortSignal, onEvent: (e: AgentEvent) => void) {
            return self.run(ctx, def, cfg, req, signal, onEvent);
          },
          async complete(req) {
            const { bin } = await self.resolveBin(def, cfg);
            if (!bin) throw new Error(`${def.label} is niet gevonden op deze computer. Installeer de CLI of stel het pad in via ${PLACE.aiPrograms}, of kies een andere engine.`);
            return cliComplete(def, bin, req);
          },
        };
      },
    };
  }

  /** Sessions are kept per (thread, bot, provider): two bots on the same CLI in a room never share a session. */
  sessionFor(threadId: string, agentId: string, providerId: string): string | undefined {
    return this.sessionRow(threadId, agentId, providerId)?.session_id;
  }

  sessionRow(threadId: string, agentId: string, providerId: string) {
    return this.ctx.store.one<{ session_id: string; context_state: string | null; seen_seq: number | null }>('SELECT session_id, context_state, seen_seq FROM cli_sessions WHERE thread_id = ? AND agent_id = ? AND provider_id = ?', threadId, agentId, providerId);
  }

  /** After a turn that ended well: this engine's session has seen the chat up to this message. */
  saveSeen(req: AgentRunRequest, cfg: ProviderConfig, seq: number) {
    this.ctx.store.exec('UPDATE cli_sessions SET seen_seq = ? WHERE thread_id = ? AND agent_id = ? AND provider_id = ?', seq, req.threadId, req.agentId, cfg.id);
  }

  /**
   * The turns of this chat that the engine's session did not see, because another engine answered for the bot in
   * between (agent/prompt.ts missedTurns): they go in front of the next turn, so the session is kept.
   */
  private missed(req: AgentRunRequest, cfg: ProviderConfig, row: { seen_seq: number | null } | null | undefined, note: (item: any) => void): string {
    const agent = this.ctx.store.agent(req.agentId);
    const thread = this.ctx.store.thread(req.threadId);
    if (!row || !agent || !thread) return '';
    const m = missedTurns(this.ctx, agent, thread, this.ctx.store.message(this.ctx.store.run(req.runId)?.input_message_id), { seen: row.seen_seq, providerId: cfg.id });
    if (m.count) note({ kind: 'session', title: 'Bijgepraat over wat een andere AI hier antwoordde', detail: m.count === 1 ? '1 bericht meegegeven dat deze sessie miste' : `${m.count} berichten meegegeven die deze sessie miste`, ts: now() });
    return m.text;
  }

  /** A new session id forgets what the previous session knew of its instructions. */
  saveSession(req: AgentRunRequest, cfg: ProviderConfig, sessionId: string) {
    const ts = now();
    this.ctx.store.exec(
      `INSERT INTO cli_sessions (thread_id, agent_id, provider_id, user_id, cli, session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id, agent_id, provider_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at,
         context_state = CASE WHEN cli_sessions.session_id = excluded.session_id THEN cli_sessions.context_state ELSE NULL END,
         seen_seq = CASE WHEN cli_sessions.session_id = excluded.session_id THEN cli_sessions.seen_seq ELSE NULL END`,
      req.threadId,
      req.agentId,
      cfg.id,
      req.userId,
      cfg.kind,
      sessionId.slice(0, 200),
      ts,
      ts,
    );
  }

  /** Section hashes of the instructions this session has now (see contextUpdate in context.ts). */
  saveContext(req: AgentRunRequest, cfg: ProviderConfig, sessionId: string, state: ContextState) {
    this.ctx.store.exec('UPDATE cli_sessions SET context_state = ? WHERE thread_id = ? AND agent_id = ? AND provider_id = ? AND session_id = ?', JSON.stringify(state), req.threadId, req.agentId, cfg.id, sessionId.slice(0, 200));
  }

  async run(ctx: Ctx, def: CliDef, cfg: ProviderConfig, req0: AgentRunRequest, signal: AbortSignal, onEvent0: (e: AgentEvent) => void) {
    assertMayRun(ctx, cfg, req0.userId);
    // Windows: start the Job Object helper now, so the CLI is in its job before it starts anything (jobs.ts).
    jobs.warm();
    // Automatic compaction (agent/compaction.ts): when the previous turn left the context ≥ 75% full, compact the
    // session first, inside this turn, so nothing else resumes the same session meanwhile.
    await ctx.services.compaction?.beforeCliRun?.({ agentId: req0.agentId, threadId: req0.threadId, providerId: cfg.id, activity: (item: any) => onEvent0({ type: 'activity', item }) });
    if (signal.aborted) throw new Error('Gestopt');
    const row = this.sessionRow(req0.threadId, req0.agentId, cfg.id);
    // Stopped by the owner last time: the session must not take up the unfinished task again (all CLI engines).
    const stopped = stoppedTaskNote(ctx, req0);
    // "Hervatten": the session lost the answer that was cut off; give the bot what it already wrote.
    const resumed = stopped ? '' : resumeNote(ctx, req0);
    // Another engine answered here for this bot since this session's last turn: it is told what it missed.
    const missed = this.missed(req0, cfg, row, (item) => onEvent0({ type: 'activity', item }));
    // What the chat holds now (the answer of this turn included): what this session has seen once the turn ends well.
    const seenNow = ctx.store.one<{ n: number | null }>('SELECT MAX(seq) AS n FROM messages WHERE thread_id = ?', req0.threadId)?.n ?? 0;
    // After a stop by the owner the stopped session is not resumed: a new one starts with the earlier chat as context.
    // The engine itself writes a call that the stop cut off into its session as "[Tool call interrupted … its outcome
    // is unknown]", and the bot believed that line over TeamBot's note that the work had arrived with the colleague
    // (12 nov, Claude Code, twice: "ik weet niet zeker of hij is aangekomen"). A new session has no such line.
    const req: AgentRunRequest = { ...req0, sessionId: stopped ? undefined : row?.session_id, prompt: stopped + resumed + missed + req0.prompt };
    if (stopped) onEvent0({ type: 'activity', item: { kind: 'session', title: 'Vorige taak was gestopt: begint bij je nieuwe bericht', detail: row?.session_id ? 'Nieuwe sessie, met het eerdere gesprek als context' : undefined, ts: now() } });
    const context: SessionContext = { previous: parseContextState(row?.context_state), save: (sessionId, state) => this.saveContext(req, cfg, sessionId, state) };
    const onEvent = (e: AgentEvent) => {
      if (e.type === 'session' && e.sessionId) this.saveSession(req, cfg, e.sessionId);
      onEvent0(e);
    };
    const s = makeScope(ctx, cfg, req, signal, onEvent);
    const { bin } = await this.resolveBin(def, cfg);
    if (!bin) throw new Error(`${def.label} is niet gevonden op deze computer. Installeer de CLI of stel het pad in via ${PLACE.aiPrograms}.`);
    const billing = async () => (await this.status(def, cfg)).billing;
    ctx.audit(req.userId, 'cli.run', { cli: def.id, mode: s.agent.access_mode, resume: !!req.sessionId }, s.agent.id);
    // The CLI goes into its Job Object right after it starts; only the very first run waits for the helper.
    await jobs.whenReady();
    // Every engine gets its instructions the same way: in full when a session starts, and after that what changed since
    // this session last saw it (`context`). A turn that ended well: the session has seen the chat up to here.
    const done = <T extends { error?: string }>(r: T): T => {
      if (!r.error) this.saveSeen(req, cfg, seenNow);
      return r;
    };
    if (def.engine === 'claude') return done(await runClaude(s, { def, bin, bridge: this.bridge, billing, track: this.track, context }));
    if (def.engine === 'codex') return done(await runCodex(s, { def, bin, bridge: this.bridge, billing, track: this.track, context, readGuard: () => codexReadGuard(bin, ctx.config.dataDir) }));
    if (def.engine === 'acp') {
      const args = [...(await this.acpLaunch(def, bin, cfg, req.model)), ...(def.custom ? [] : checkExtraArgs(def, s.opts.extraArgs))];
      const authMethod = typeof cfg.config?.authMethod === 'string' && /^[\w.:-]{1,60}$/.test(cfg.config.authMethod) ? cfg.config.authMethod : undefined;
      return done(await runAcp(s, { def, bin, args, env: acpModelEnv(def, req.model, appsOff(s.agent)), bridge: this.bridge, authMethod, billing, track: this.track, unsafe: () => this.settings().unsafe[def.id] || null, markUnsafe: (info) => this.setUnsafe(def.id, info), context }));
    }
    throw new Error(def.unsupported || `${def.label} wordt niet ondersteund`);
  }

  /**
   * "<bot> werkt nu met <CLI>: nieuwe sessie gestart …" when a bot changed engine in this chat and has no session on
   * the new one yet. Called by the runner before the answer is created, so the event stands above the answer.
   */
  switchNote(o: { thread: import('../../core/types.js').Thread; agentId: string; providerId: string; kind: string }) {
    const def = defById(o.kind);
    if (!def || this.sessionFor(o.thread.id, o.agentId, o.providerId)) return;
    const other = this.ctx.store.one<{ p: string }>(
      "SELECT json_extract(parts, '$.provider') AS p FROM messages WHERE thread_id = ? AND author_id = ? AND role = 'assistant' AND status = 'done' AND deleted = 0 ORDER BY seq DESC LIMIT 1",
      o.thread.id,
      o.agentId,
    )?.p;
    if (!other || other === def.id) return;
    const name = this.ctx.store.agent(o.agentId)?.name || 'De bot';
    this.ctx.chat.addEvent(o.thread, `${name} werkt nu met ${def.label}: nieuwe sessie gestart. Het eerdere gesprek in deze chat is als context meegegeven.`, { kind: 'cli_session', agentId: o.agentId });
  }

  private claudeUsage = new Map<string, boolean>();

  /** What the CLI login behind `cfg` says about its usage limits. Never a prompt, never private files. */
  async readLimits(cfg: ProviderConfig, tz: string): Promise<{ report: LimitReport | null; error?: string; stats?: { input: number; output: number; cost: number; sessions: number } | null; unsupported?: string }> {
    const def = defById(cfg.kind);
    if (!def) return { report: null, unsupported: 'Onbekende CLI' };
    const { bin } = await this.resolveBin(def, cfg);
    if (!bin) return { report: null, error: `${def.label} is niet gevonden op deze computer.` };
    const dir = path.join(this.ctx.config.dataDir, 'cli-agents', 'usage');
    if (def.engine === 'claude') {
      if (this.claudeUsage.get(bin) === false) return { report: null, unsupported: 'Deze versie van Claude Code geeft zijn limieten niet buiten de terminal door.' };
      const r = await readClaudeUsage(bin, dir, tz);
      this.claudeUsage.set(bin, r.supported);
      return { report: r.report, error: r.error, unsupported: r.supported ? undefined : 'Deze versie van Claude Code geeft zijn limieten niet buiten de terminal door.' };
    }
    if (def.engine === 'codex') return readCodexLimits(bin, dir);
    if (def.id === 'opencode') return { report: null, stats: await readOpencodeStats(bin, dir), unsupported: 'OpenCode geeft geen limieten door.' };
    return { report: null, unsupported: `${def.label} geeft geen limieten door.` };
  }

  /**
   * The CLI's own compaction of a bot's session in this chat: Claude Code `/compact`, Codex app-server
   * `thread/compact/start`. `fallback` = this engine (ACP agents such as OpenCode, a Codex without the method) or this
   * chat (no session yet) cannot do it itself: TeamBot then summarises and starts a new session with the summary.
   * `inRun`: called at the start of the bot's own next turn (automatic compaction), so that run does not count as busy.
   */
  async compact(o: { threadId: string; agentId: string; providerId: string; inRun?: boolean }): Promise<CompactResult & { fallback?: boolean }> {
    const cfg = this.ctx.providers.config(o.providerId);
    const def = cfg ? defById(cfg.kind) : undefined;
    const base = this.ctx.store.agent(o.agentId);
    const thread = this.ctx.store.thread(o.threadId);
    // A shared bot in a member's conversation: its session lives in that member's own folder (agent/shared.ts).
    let agent = base;
    try {
      agent = base && thread ? agentForThread(this.ctx, base, thread) : base;
    } catch {
      agent = null;
    }
    if (!cfg || !def || !agent) return { compacted: false, reason: 'geen CLI-provider' };
    if (!o.inRun && this.ctx.store.one("SELECT 1 FROM runs WHERE thread_id = ? AND agent_id = ? AND status IN ('queued','running','waiting')", o.threadId, o.agentId)) return { compacted: false, reason: 'de bot is nog bezig; probeer het zo opnieuw' };
    if (def.engine !== 'claude' && def.engine !== 'codex') return { compacted: false, fallback: true };
    const sessionId = this.sessionFor(o.threadId, o.agentId, cfg.id);
    if (!sessionId) return { compacted: false, fallback: true, reason: `er is nog geen ${def.label}-sessie in dit gesprek` };
    const { bin } = await this.resolveBin(def, cfg);
    if (!bin) return { compacted: false, reason: `${def.label} is niet gevonden op deze computer. Installeer de CLI of stel het pad in via ${PLACE.aiPrograms}.` };
    if (def.engine === 'claude') return compactClaudeSession({ bin, cwd: workdir(agent), sessionId, model: agent.model });
    const r = await compactCodexSession({ bin, cwd: workdir(agent), threadId: sessionId, args: await codexIsolation(bin, false) });
    return r.unsupported ? { ...r, fallback: true } : r;
  }

  /** Forget this bot's CLI session in this chat: its next turn starts a new session (with the earlier chat as context). */
  resetSession(threadId: string, agentId: string, providerId: string) {
    this.ctx.store.exec('DELETE FROM cli_sessions WHERE thread_id = ? AND agent_id = ? AND provider_id = ?', threadId, agentId, providerId);
    const th = this.ctx.store.thread(threadId);
    if (th?.provider_state?.[providerId]) {
      const ps = { ...th.provider_state };
      delete ps[providerId];
      this.ctx.store.updateThread(th.id, { provider_state: ps });
    }
  }

  stopAll() {
    this.logins.stopAll();
    for (const p of this.procs) p.kill('Server gestopt');
    this.procs.clear();
    this.bridge.stop();
  }
}


/** Free models of OpenCode Zen (no account or key): names ending in "-free", plus the free stealth model big-pickle. */
export function modelBilling(id: string): 'free' | 'local' | undefined {
  const [prov, name = ''] = id.split('/', 2);
  if (prov === 'opencode' && (/-free$/i.test(name) || name === 'big-pickle')) return 'free';
  if (prov === 'ollama' || prov === 'lmstudio' || prov === 'llama.cpp') return 'local';
  return undefined;
}

const BILLING_LABEL = { free: 'gratis', local: 'lokaal, gratis', subscription: 'abonnement', paid: 'betaald' } as const;
const listCache = new Map<string, { at: number; v: { id: string; label: string; tools: boolean; billing?: 'free' | 'local' }[] }>();

/** Models a CLI can use (e.g. `opencode models`), free ones first and labelled. No prompt, no cost. */
export async function cliModelList(bin: string, args: string[]) {
  const key = bin + ' ' + args.join(' ');
  const c = listCache.get(key);
  if (c && Date.now() - c.at < 10 * 60_000) return c.v;
  let r = await runQuick(bin, args, { timeoutMs: 60_000 });
  if (!r.stdout.trim() && args.includes('--standalone')) r = await runQuick(bin, args.filter((a) => a !== '--standalone'), { timeoutMs: 60_000 });
  const ids = [...new Set(r.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[\w.-]+\/[\w.:/@+-]{1,120}$/.test(l)))];
  const rank = (id: string) => (modelBilling(id) === 'free' ? 0 : modelBilling(id) === 'local' ? 1 : 2);
  const v = ids
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((id) => {
      const b = modelBilling(id);
      // In words ("Big Pickle · gratis"); a model of another provider keeps that provider's name ("Sonnet 4.5 (anthropic)").
      const name = prettyModel(id);
      const vendor = id.split('/')[0];
      const words = vendor === 'opencode' || b === 'local' || name === id ? name : `${name} (${vendor})`;
      return { id, label: b ? `${words} · ${BILLING_LABEL[b]}` : `${words} · eigen provider in OpenCode`, tools: true, billing: b };
    });
  if (v.length) listCache.set(key, { at: Date.now(), v });
  return v;
}

/** ACP agents that take the model from their inline config (OpenCode): put the bot's model there for this run. */
export function acpModelEnv(def: CliDef, model?: string, appsOff: string[] = []): Record<string, string> {
  const key = def.acpModelConfigEnv;
  const withModel = !!model && model !== 'default' && /^[\w.:/@+-]{1,120}$/.test(model);
  if (!key || (!withModel && !appsOff.length)) return {};
  let base: any = {};
  try {
    base = JSON.parse(def.acpEnv?.[key] || '{}');
  } catch {
    /* no base config */
  }
  // An app of the engine's own (its `mcp` servers) that the owner switched off for this bot (engine-apps.ts).
  const mcp = appsOff.length ? { mcp: Object.fromEntries(appsOff.map((id) => [id, { enabled: false }])) } : {};
  return { [key]: JSON.stringify({ ...base, ...(withModel ? { model } : {}), ...mcp }) };
}

/** Validate and normalise provider config for CLI kinds (owner only, never shared). */
export function sanitizeCliConfig(def: CliDef, cfg: any): Record<string, any> {
  const out: Record<string, any> = {};
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  if (def.custom) {
    const cmd = str(c.command, 1000).trim();
    if (!cmd) throw bad('Vul het programma van je ACP-agent in (pad of naam in PATH)');
    const p = path.isAbsolute(cmd) ? cmd : findBinary([cmd]);
    if (!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) throw bad(`Programma niet gevonden: ${cmd}`);
    out.command = p;
    try {
      out.args = checkCustomArgs(c.args);
    } catch (e: any) {
      throw bad(e.message);
    }
  } else if (c.path) {
    const p = str(c.path, 1000).trim();
    if (!path.isAbsolute(p) || !fs.existsSync(p) || !fs.statSync(p).isFile()) throw bad(`Pad niet gevonden of geen bestand: ${p}`);
    out.path = p;
  }
  if (c.authMethod) {
    if (!/^[\w.:-]{1,60}$/.test(String(c.authMethod))) throw bad('Ongeldige inlogmethode');
    out.authMethod = String(c.authMethod);
  }
  if (c.defaultModel && /^[\w.:/@+-]{1,120}$/.test(String(c.defaultModel))) out.defaultModel = String(c.defaultModel);
  return out;
}

/** What Claude Code / an ACP engine can read (Dutch, for the bot editor). Codex: codexReadText (checked per computer). */
export function cliReadText(def: CliDef): string {
  if (def.engine === 'claude')
    return 'Lezen: de bestandstools van Claude Code lezen alleen in de mappen van deze bot; daarbuiten weigert Claude Code zelf. Opdrachten in de terminal (alleen als je die aanzet) draaien zonder sandbox: noemt een opdracht een pad buiten die mappen, dan vraagt TeamBot het jou eerst, en sleutelmappen (zoals ~/.ssh en de gegevens van TeamBot) worden geweigerd.';
  return `Lezen: TeamBot geeft ${def.label} alleen bestanden uit de mappen van deze bot. Wat de CLI zelf buiten zijn werkmap leest, gaat langs TeamBot als de CLI het vraagt (OpenCode doet dat) en wordt dan geweigerd. Opdrachten met een pad buiten de mappen vragen jou eerst; sleutelmappen worden geweigerd.`;
}

function publicStatus(s: CliStatus, def: CliDef) {
  return {
    ...s,
    description: def.description,
    billingNote: def.billingNote,
    authNote: def.authNote,
    docsUrl: def.docsUrl,
    login: def.login,
    install: installLines(def),
    unsupported: def.unsupported,
    experimental: !!def.experimental,
    custom: !!def.custom,
    // TeamBot's own copy (runtimes.ts) replaces the global install for Claude Code, Codex and OpenCode. Every other CLI
    // that has an official way TeamBot can run itself (catalog.ts installPlan): also without npm or uv on this computer.
    canInstall: !s.installed && !isRuntimeId(def.id) && canRun(installPlan(def)),
    managed: isRuntimeId(def.id),
    deviceLogin: !!DEVICE_LOGIN[def.id],
    pasteLogin: PASTE_LOGIN.has(def.id),
    loginCommand: loginCommand(def.id, s.path || null, def.login),
  };
}

let instance: CliAgents | null = null;
let versions: EngineVersions | null = null;
/** TeamBot can bring its own Node.js or uv here: on this computer already, a copy of TeamBot's, or one to download. */
const toolchainHere = (id: 'node' | 'uv') => {
  try {
    const st = instance ? toolchainStatus(id, instance.dataDir) : null;
    return !!st && (!!st.source || st.available);
  } catch {
    return false;
  }
};
const canRun = (plan: ReturnType<typeof installPlan>) => !!plan && (plan.kind === 'npm' ? !!findBinary(['npm']) || toolchainHere('node') : plan.kind === 'uv' ? !!findBinary(['uv']) || toolchainHere('uv') : true);

/** Ollama or LM Studio answers on this computer (the engines "Gratis starten" can connect as reserve by itself). */
async function localEngineRunning(ctx: Ctx): Promise<boolean> {
  const found = await Promise.all(
    ['ollama', 'lmstudio'].map(async (id) => {
      const k = ctx.providers.kind(id);
      if (!k?.detect) return false;
      const r: any = await Promise.race([Promise.resolve(k.detect(ctx)).catch(() => null), new Promise((res) => setTimeout(() => res(null), 3000))]);
      return !!r?.installed;
    }),
  );
  return found.some(Boolean);
}

const mod: Module = {
  id: 'cli-agents',
  label: 'CLI-agents',
  migrations: [
    {
      id: 'cli-agents-001',
      sql: `CREATE TABLE cli_sessions (
        thread_id TEXT NOT NULL, agent_id TEXT NOT NULL, provider_id TEXT NOT NULL, user_id TEXT NOT NULL,
        cli TEXT NOT NULL, session_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, agent_id, provider_id)
      );
      CREATE INDEX cli_sessions_user ON cli_sessions(user_id);`,
    },
    // Per-section hashes of the instructions a session has (null: unknown → the next resumed turn gets them in full).
    { id: 'cli-agents-002', sql: 'ALTER TABLE cli_sessions ADD COLUMN context_state TEXT;' },
    // Up to which message of the chat a session has seen it (null: unknown → up to the last answer this engine gave there).
    { id: 'cli-agents-003', sql: 'ALTER TABLE cli_sessions ADD COLUMN seen_seq INTEGER;' },
  ],
  init(ctx) {
    const cli = new CliAgents(ctx);
    instance = cli;
    const kinds = new Map<string, CliDef>();
    for (const def of CLI_DEFS) {
      if (def.engine === 'unsupported') continue;
      kinds.set(def.id, def);
      ctx.providers.registerKind(cli.kind(def));
    }

    const ownerOnly = (req: any) => {
      const u = user(req);
      if (u.role !== 'owner') throw forbidden('Alleen de eigenaar van deze TeamBot-installatie kan abonnementen (Claude Code, Codex …) gebruiken: ze draaien op zijn eigen login op die computer en mogen niet gedeeld worden. Gebruik een eigen API-sleutel.');
      return u;
    };

    // Guards in front of the core provider routes (registered before them): CLI providers are owner-only and never shared.
    ctx.api.post('/providers', (req, _res, next) => {
      const def = kinds.get(req.body?.kind);
      if (!def) return next();
      try {
        ownerOnly(req);
        if (req.body.shared) throw bad('Abonnementen kunnen niet gedeeld worden met andere gebruikers (persoonlijke login).');
        req.body.config = sanitizeCliConfig(def, req.body.config);
        delete req.body.apiKey;
        next();
      } catch (e) {
        next(e);
      }
    });
    ctx.api.patch('/providers/:id', (req, _res, next) => {
      const cfg = ctx.providers.config(req.params.id as string);
      const def = cfg ? kinds.get(cfg.kind) : undefined;
      if (!def) return next();
      try {
        ownerOnly(req);
        if (req.body?.shared) throw bad('Abonnementen kunnen niet gedeeld worden met andere gebruikers (persoonlijke login).');
        if (req.body?.config !== undefined) req.body.config = sanitizeCliConfig(def, { ...cfg!.config, ...req.body.config });
        if (req.body) delete req.body.apiKey;
        next();
      } catch (e) {
        next(e);
      }
    });

    // Engine versions: known-good versions, change detection, a free self-check, the way back (versions.ts).
    versions = new EngineVersions(ctx, cli);
    cli.onStatus = (d, st) => {
      try {
        versions?.observe(d, st);
      } catch (e: any) {
        ctx.log.warn('[cli-agents] versie bijhouden', e?.message || e);
      }
    };
    versionRoutes(ctx, versions, ownerOnly);

    ctx.api.get(
      '/cli-agents/status',
      ah(async (req) => {
        const u = user(req);
        if (u.role !== 'owner') return { canUse: false, reason: 'Abonnementen (Claude Code, Codex …) draaien op de eigen login van de computer waarop TeamBot draait. Alleen de eigenaar kan ze gebruiken; gebruik zelf een eigen API-sleutel.', items: [] };
        const fresh = req.query.fresh === '1';
        if (fresh) cli.clear();
        const items = await Promise.all(
          CLI_DEFS.filter((d) => !d.custom).map(async (d) => ({ ...publicStatus(await cli.status(d, null, fresh), d), runtime: await runtimeStatus(d.id), loginState: cli.logins.get(d.id) })),
        );
        const providers = ctx.providers.list(u.id).filter((p) => p.user_id === u.id && kinds.has(p.kind)).map((p) => ({ id: p.id, kind: p.kind, name: p.name, enabled: p.enabled, config: p.config }));
        const custom = defById('acp-custom')!;
        // A local model is connected or runs on this computer: "Gratis starten" sets it up as reserve itself, so the
        // page needs no "Ollama instellen" hint (acceptance round 5, C-7).
        const localModel = ctx.providers.list(u.id).some((p) => p.enabled && ctx.providers.kind(p.kind)?.billing === 'local') || (await localEngineRunning(ctx));
        return { canUse: true, items, providers, mode: ctx.config.mode, custom: { ...publicStatus({ ...(await cli.status(custom, null)), installed: true, detail: custom.description }, custom) }, platform: process.platform, localModel };
      }),
    );

    /** What a bot on this CLI provider can read on this computer (bot editor, warning for "Volledige toegang"). */
    ctx.api.get(
      '/cli-agents/read-access/:providerId',
      ah(async (req) => {
        const u = ownerOnly(req);
        const cfg = ctx.providers.config(req.params.providerId as string);
        const def = cfg ? kinds.get(cfg.kind) : undefined;
        if (!cfg || !def || cfg.user_id !== u.id) throw notFound('Provider niet gevonden');
        if (def.engine === 'codex') {
          const { bin } = await cli.resolveBin(def, cfg);
          if (!bin) return { engine: def.engine, level: 'unknown', confined: false, text: `${def.label} is niet gevonden op deze computer.` };
          const g = await codexReadGuard(bin, ctx.config.dataDir);
          return { engine: def.engine, level: g.level, confined: g.level === 'confined', text: codexReadText(g) };
        }
        return { engine: def.engine, level: 'gated', confined: true, text: cliReadText(def) };
      }),
    );

    /**
     * Per level: do the hard blocks (key files, closed folders, TeamBot's data) hold for a bot on this AI, or not, in
     * one sentence for the level choice (permissions.ts hardBlocks). Any provider; `agentId` for that bot's own folders.
     */
    ctx.api.get(
      '/cli-agents/hard-blocks/:providerId',
      ah(async (req) => {
        const u = user(req);
        const cfg = ctx.providers.list(u.id).find((p) => p.id === req.params.providerId);
        if (!cfg) throw notFound('Provider niet gevonden');
        const def = kinds.get(cfg.kind);
        const own = req.query.agentId ? ctx.store.agent(String(req.query.agentId)) : null;
        if (req.query.agentId && (!own || own.user_id !== u.id)) throw notFound('Bot niet gevonden');
        const agent = own || ({ id: '', user_id: u.id, access_mode: 'full', settings: {} } as any);
        let codex = null;
        if (def?.engine === 'codex') {
          const { bin } = await cli.resolveBin(def, ctx.providers.config(cfg.id)!);
          codex = bin ? await codexReadGuard(bin, ctx.config.dataDir) : null;
        }
        return { engine: def?.engine || 'api', levels: hardBlocksByLevel({ engine: def?.engine || 'api', cli: def?.id, label: def?.label, codex, agent }) };
      }),
    );

    ctx.api.put(
      '/cli-agents/safety/:id',
      ah(async (req) => {
        const u = ownerOnly(req);
        const def = defById(req.params.id as string);
        if (!def) throw bad('Onbekende CLI');
        cli.setUnsafe(def.id, null);
        ctx.audit(u.id, 'cli.safety_reset', { cli: def.id });
        return publicStatus(await cli.status(def, null, true), def);
      }),
    );

    /** One-click install of the official npm package — only after the owner confirmed it in the UI. */
    ctx.api.post(
      '/cli-agents/:id/install',
      ah(async (req) => {
        const u = ownerOnly(req);
        const def = defById(req.params.id as string);
        const plan = def && !def.custom && !isRuntimeId(def.id) ? installPlan(def) : null;
        if (!def || !plan) throw bad('Deze CLI kan TeamBot niet voor je installeren; gebruik de officiële opdracht.');
        if (req.body?.confirm !== true) throw bad('Bevestig eerst dat TeamBot deze CLI mag installeren.');
        // npm or uv of this computer, else TeamBot's own Node.js or uv (downloaded once, core/runtimes.ts): the program
        // lands in TeamBot's own folder, where resolveBin finds it. Else the vendor's own install script.
        let bin: string | null;
        let args: string[];
        let env: Record<string, string> | undefined;
        if (plan.kind === 'script') {
          bin = plan.shell === 'powershell' ? findBinary(['powershell', 'pwsh']) : findBinary(['sh', 'bash']);
          args = plan.shell === 'powershell' ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', plan.command] : ['-c', plan.command];
        } else {
          const tool = plan.kind === 'npm' ? 'npm' : 'uv';
          bin = findBinary([tool]);
          args = plan.args;
          if (!bin) {
            const t = await ensureToolchain(plan.kind === 'npm' ? 'node' : 'uv', ctx.config.dataDir).catch((e: any) => {
              throw bad(`${plan.kind === 'npm' ? 'Node.js' : 'uv'} voor het installeren ophalen lukte niet: ${String(e?.message || e).slice(0, 300)} Gebruik anders de officiële opdracht.`);
            });
            env = t.env(process.env);
            bin = findBinary([tool], t.pathDirs);
          }
        }
        if (!bin) throw bad('Het programma om mee te installeren is niet gevonden. Gebruik de officiële opdracht.');
        ctx.audit(u.id, 'cli.install', { cli: def.id, how: plan.kind, what: plan.kind === 'script' ? plan.command.slice(0, 200) : plan.args.join(' '), ...(env ? { toolchain: 'teambot' } : {}) });
        const r = await runQuick(bin, args, { timeoutMs: 10 * 60_000, env });
        cli.clear();
        const st = await cli.status(def, null, true);
        if (!st.installed) throw bad(`Installeren lukte niet${r.error ? `: ${r.error}` : ''}. ${(r.stderr || r.stdout).trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 400)}`);
        return publicStatus(st, def);
      }),
    );

    ctx.api.put(
      '/cli-agents/paths/:id',
      ah(async (req) => {
        const u = ownerOnly(req);
        const def = defById(req.params.id as string);
        if (!def || def.custom) throw bad('Onbekende CLI');
        const p = req.body?.path ? str(req.body.path, 1000).trim() : '';
        if (p) {
          if (!path.isAbsolute(p)) throw bad('Gebruik een volledig pad (bijv. C:\\Users\\naam\\.local\\bin\\claude.exe)');
          if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw bad('Bestand niet gevonden');
        }
        cli.setPath(def.id, p || null);
        ctx.audit(u.id, 'cli.path_set', { cli: def.id, path: p || null });
        return publicStatus(await cli.status(def, null, true), def);
      }),
    );

    /** Connect a found CLI as a provider (OpenCode starts on a free model). */
    const connect = async (userId: string, def: CliDef) => {
      const existing = ctx.providers.list(userId).find((p) => p.user_id === userId && p.kind === def.id);
      if (existing) return { provider: ctx.providers.view(await ensureFreeDefaultModel(ctx, existing, userId), userId), created: false };
      const s = await cli.status(def, null, true);
      if (!s.installed) throw bad(`${def.label} is niet gevonden. Installeer de CLI eerst of stel het pad in.`);
      let p = ctx.providers.create(userId, { kind: def.id, name: def.label });
      p = await ensureFreeDefaultModel(ctx, p, userId);
      await autoDefaultProvider(ctx, userId);
      const view = ctx.providers.view(p, userId);
      ctx.events.emit(userId, 'provider.updated', view);
      return { provider: view, created: true };
    };

    ctx.api.post(
      '/cli-agents/:id/connect',
      ah(async (req) => {
        const u = ownerOnly(req);
        const def = kinds.get(req.params.id as string);
        if (!def || def.custom) throw bad('Onbekende CLI');
        const r = await connect(u.id, def);
        // Connect and test in one go: the card shows "Verbinding werkt" or what to do next.
        const cfg = ctx.providers.config(r.provider.id)!;
        const test = await Promise.resolve()
          .then(() => ctx.providers.adapterFor(cfg).test())
          .catch((e: any) => ({ ok: false, detail: String(e?.message || e) }));
        return { ...r, test };
      }),
    );

    // ---------------------------------------------------------------- TeamBot's own CLI copies (C-07)

    const runtimeStatus = async (id: string, checkLatest = false) => (isRuntimeId(id) ? { ...(await cli.runtimes.status(id, { checkLatest })), label: cli.runtimes.spec(id).label } : null);
    /** Install (or update) in the background; progress and the end go to the owner as "cli.runtime" events. */
    const startInstall = (userId: string, id: string, version: 'pinned' | 'latest', after?: () => Promise<void>) => {
      if (!isRuntimeId(id)) throw bad('TeamBot heeft geen eigen kopie van deze CLI');
      const job = cli.runtimes.job(id);
      if (job && !['done', 'error'].includes(job.phase)) return job;
      ctx.audit(userId, version === 'latest' ? 'cli.runtime_update' : 'cli.runtime_install', { cli: id });
      void (async () => {
        try {
          const v = version === 'latest' ? await cli.runtimes.latest(id, true) : null;
          if (version === 'latest' && !v) throw new Error('De nieuwste versie kon niet worden opgehaald. Probeer het later opnieuw.');
          const done = await cli.runtimes.install(id, v, (p) => ctx.events.emit(userId, 'cli.runtime', { id, ...p }));
          cli.clear();
          ctx.audit(userId, 'cli.runtime_installed', { cli: id, version: done.version, integrity: done.integrity });
          if (after) await after();
        } catch (e: any) {
          ctx.log.warn('[cli-agents] runtime install', id, e?.message);
        } finally {
          ctx.events.emit(userId, 'cli.runtime', { id, ...(cli.runtimes.job(id) || { phase: 'error' }), status: await runtimeStatus(id).catch(() => null) });
        }
      })();
      return { phase: 'metadata', version: version === 'pinned' ? cli.runtimes.spec(id).pinned : '' };
    };

    ctx.api.get(
      '/cli-agents/runtimes',
      ah(async (req) => {
        ownerOnly(req);
        const ids = ['claude-code', 'codex-cli', 'opencode'];
        return { items: await Promise.all(ids.map((id) => runtimeStatus(id, req.query.latest !== '0'))), platform: cli.runtimes.plat };
      }),
    );

    /**
     * The first screen's "Ik heb Claude of ChatGPT" (TeamBot 0.4.2): Claude Code and Codex in a few facts — on this
     * computer, logged in, already connected, can TeamBot install its own copy — without the rest of the CLI list.
     * `fresh=1` checks again (after a login in the vendor's own window); `only=<id>` limits that to one CLI. The login
     * itself always stays with the vendor's program: TeamBot never sees or stores a token, an email or an org name.
     */
    ctx.api.get(
      '/cli-agents/subscriptions',
      ah(async (req) => {
        const u = user(req);
        if (u.role !== 'owner') return { canUse: false, mode: ctx.config.mode, items: [] };
        const only = typeof req.query.only === 'string' ? req.query.only : '';
        const ids = ['claude-code', 'codex-cli'];
        const items = await Promise.all(
          ids.map(async (id) => {
            const def = kinds.get(id)!;
            const st = await cli.status(def, null, req.query.fresh === '1' && (!only || only === id));
            const rt = await runtimeStatus(id);
            const p = ctx.providers.list(u.id).find((x) => x.user_id === u.id && x.kind === id && x.enabled);
            return {
              id,
              label: def.label,
              installed: st.installed,
              loggedIn: st.loggedIn,
              billing: st.billing,
              providerId: p?.id || null,
              runtime: rt ? { supported: rt.supported, pinned: rt.pinned, sizeMb: rt.sizeMb, installed: !!rt.installed, job: rt.job } : null,
              loginCommand: loginCommand(id, st.path || null, def.login),
              docsUrl: def.docsUrl,
            };
          }),
        );
        return { canUse: true, mode: ctx.config.mode, items };
      }),
    );

    ctx.api.post(
      '/cli-agents/runtimes/:id/install',
      ah(async (req) => {
        const u = ownerOnly(req);
        const id = String(req.params.id);
        if (!isRuntimeId(id)) throw bad('TeamBot heeft geen eigen kopie van deze CLI');
        return { job: startInstall(u.id, id, req.body?.version === 'latest' ? 'latest' : 'pinned') };
      }),
    );

    ctx.api.delete(
      '/cli-agents/runtimes/:id',
      ah(async (req) => {
        const u = ownerOnly(req);
        const id = String(req.params.id);
        if (!isRuntimeId(id)) throw bad('TeamBot heeft geen eigen kopie van deze CLI');
        const job = cli.runtimes.job(id);
        if (job && !['done', 'error'].includes(job.phase)) throw bad('Wacht tot het installeren klaar is.');
        cli.runtimes.uninstall(id);
        cli.clear();
        ctx.audit(u.id, 'cli.runtime_uninstall', { cli: id });
        const def = defById(id)!;
        return { runtime: await runtimeStatus(id), status: publicStatus(await cli.status(def, null, true), def) };
      }),
    );

    /**
     * "Gratis starten": OpenCode with a free model in one click. Uses an OpenCode that is already here (TeamBot's own
     * copy or a system install), else installs TeamBot's own copy first; then connects it on a free model.
     * OpenCode's free models have a daily limit: when a local model runs on this computer (Ollama with a chat model),
     * it is connected too and becomes the reserve engine of the bots made on OpenCode from now on (`reserve`), so a
     * bot goes on when the free limit is reached. Without one, the UI says in one line how a local model helps.
     * Answers "installing" right away when a download is needed; "cli.freestart" says when it is ready.
     */
    ctx.api.post(
      '/cli-agents/free-start',
      ah(async (req) => {
        const u = ownerOnly(req);
        const def = kinds.get('opencode')!;
        const finish = async () => {
          const r = await connect(u.id, def);
          const model = (ctx.providers.config(r.provider.id)?.config?.defaultModel as string) || '';
          const reserve = await rememberFreeReserve(ctx, u.id, { connect: true, exclude: [r.provider.id] });
          ctx.audit(u.id, 'cli.free_start', { provider: r.provider.id, model, reserve: reserve?.provider_id || null });
          return { status: 'ready' as const, provider: r.provider, model, reserve };
        };
        const st = await cli.status(def, null, true);
        if (st.installed && st.pathSource !== 'andere-app') return finish();
        if (st.installed && req.body?.useOtherApp === true) return finish();
        const job = startInstall(u.id, 'opencode', 'pinned', async () => {
          try {
            ctx.events.emit(u.id, 'cli.freestart', await finish());
          } catch (e: any) {
            ctx.events.emit(u.id, 'cli.freestart', { status: 'error', error: String(e?.message || e) });
          }
        });
        return { status: 'installing' as const, job };
      }),
    );

    // ---------------------------------------------------------------- logging in from TeamBot

    ctx.api.post(
      '/cli-agents/:id/login',
      ah(async (req) => {
        const u = ownerOnly(req);
        const def = kinds.get(req.params.id as string);
        if (!def || def.custom) throw bad('Onbekende CLI');
        const { bin } = await cli.resolveBin(def);
        if (!bin) throw bad(`${def.label} is niet gevonden. Installeer de CLI eerst.`);
        const args = DEVICE_LOGIN[def.id];
        if (!args) return { mode: 'terminal', command: loginCommand(def.id, bin, def.login) };
        ctx.audit(u.id, 'cli.login_start', { cli: def.id });
        const login = await cli.logins.start(def.id, bin, args, (l) => {
          cli.clear();
          ctx.audit(u.id, l.state === 'done' ? 'cli.login_done' : 'cli.login_failed', { cli: def.id });
          ctx.events.emit(u.id, 'cli.login', l);
        });
        return { mode: 'device', login };
      }),
    );

    ctx.api.get(
      '/cli-agents/:id/login',
      ah(async (req) => {
        ownerOnly(req);
        return { login: cli.logins.get(String(req.params.id)) };
      }),
    );

    ctx.api.delete(
      '/cli-agents/:id/login',
      ah(async (req) => {
        ownerOnly(req);
        cli.logins.cancel(String(req.params.id));
        return { ok: true };
      }),
    );

    /** The code from Claude Code's sign-in page, handed to the waiting `claude auth login` (never stored or logged). */
    ctx.api.post(
      '/cli-agents/:id/login/code',
      ah(async (req) => {
        const u = ownerOnly(req);
        try {
          const login = cli.logins.submit(String(req.params.id), str(req.body?.code, 2100));
          ctx.audit(u.id, 'cli.login_code', { cli: String(req.params.id) });
          return { login };
        } catch (e: any) {
          throw bad(e?.message || String(e));
        }
      }),
    );

    /** Open a terminal on this computer with the login command (desktop app only: the screen is right here). */
    ctx.api.post(
      '/cli-agents/:id/login/terminal',
      ah(async (req) => {
        const u = ownerOnly(req);
        if (ctx.config.mode !== 'desktop') throw bad('Een terminal openen kan alleen in de desktop-app. Kopieer de opdracht en voer die uit op de computer waar TeamBot draait.');
        const def = kinds.get(req.params.id as string);
        if (!def || def.custom) throw bad('Onbekende CLI');
        const { bin } = await cli.resolveBin(def);
        const command = loginCommand(def.id, bin, def.login);
        if (!openTerminal(command)) throw bad('Er kon geen terminal worden geopend. Kopieer de opdracht en voer die zelf uit.');
        ctx.audit(u.id, 'cli.login_terminal', { cli: def.id });
        return { ok: true, command };
      }),
    );

    ctx.hooks.agentDeleted.push(({ agentId }) => {
      try {
        ctx.store.exec('DELETE FROM cli_sessions WHERE agent_id = ?', agentId);
      } catch {
        /* ignore */
      }
    });

    /**
     * The engine's own apps of a bot (engine-apps.ts): what it has from the owner's claude.ai connectors and the MCP
     * servers in the program's own settings, shown with the bot's apps, each with a switch for this bot (default on).
     */
    const engineAppsOf = async (a: { id: string; provider_id?: string | null; access_mode: string; settings?: any }): Promise<EngineAppView[]> => {
      const cfg = a.provider_id ? ctx.providers.config(a.provider_id) : null;
      const def = cfg ? kinds.get(cfg.kind) : undefined;
      if (!cfg || !def || a.access_mode === 'chat') return [];
      const off = appsOff(a);
      // Claude Code and Codex load them only with "Je eigen apps van het programma gebruiken" (cli.useUserMcp); OpenCode always.
      if (def.engine === 'claude') {
        if (!cliOptions(a as any).useUserMcp) return [];
        let known = knownApps(ctx.config.dataDir, cfg.id);
        // Before any run: ask Claude Code itself which apps it has (once an hour at most when it has none).
        if (!known.length) {
          const { bin } = await cli.resolveBin(def, cfg);
          if (bin) known = await discoverClaudeApps(ctx.config.dataDir, cfg.id, bin, workdir(ctx.store.agent(a.id)!)).catch(() => []);
        }
        return appViews(known, { engine: def.label, off, guarded: true });
      }
      if (def.engine === 'codex') return cliOptions(a as any).useUserMcp ? appViews(codexConfigApps(), { engine: def.label, off, guarded: false }) : [];
      if (def.id === 'opencode') return appViews(opencodeConfigApps(), { engine: def.label, off, guarded: false });
      return [];
    };
    const ownBot = (req: any) => {
      const u = user(req);
      const a = ctx.store.agent(String(req.params.id));
      if (!a || a.user_id !== u.id) throw notFound('Bot niet gevonden');
      return { u, a };
    };
    ctx.api.get(
      '/cli-agents/agents/:id/apps',
      ah(async (req) => ({ apps: await engineAppsOf(ownBot(req).a) })),
    );
    ctx.api.put(
      '/cli-agents/agents/:id/apps/:app',
      ah(async (req) => {
        const { u, a } = ownBot(req);
        const app = String(req.params.app || '');
        if (!(await engineAppsOf(a)).some((x) => x.id === app)) throw notFound('App niet gevonden bij deze bot');
        const on = !!req.body?.enabled;
        const cliSet = { ...((a.settings?.cli as any) || {}) };
        const off = new Set(appsOff(a));
        if (on) off.delete(app);
        else off.add(app);
        cliSet.appsOff = [...off];
        if (!cliSet.appsOff.length) delete cliSet.appsOff;
        const upd = ctx.store.updateAgent(a.id, { settings: { ...(a.settings || {}), cli: cliSet } });
        ctx.audit(u.id, on ? 'cli.app_on' : 'cli.app_off', { app }, a.id);
        ctx.events.emit(u.id, 'agent.updated', upd);
        return { apps: await engineAppsOf(ctx.store.agent(a.id)!) };
      }),
    );

    /** CLI sessions in a thread (for the inspector) — only the thread owner. */
    ctx.api.get(
      '/cli-agents/threads/:id/sessions',
      ah(async (req) => {
        const u = user(req);
        const th = ctx.store.thread(req.params.id as string);
        if (!th || (th.user_id !== u.id && !(th.meta?.memberUserIds || []).includes(u.id))) throw notFound('Gesprek niet gevonden');
        const rows = ctx.store.all<any>('SELECT agent_id, provider_id, cli, session_id, updated_at FROM cli_sessions WHERE thread_id = ? AND user_id = ? ORDER BY updated_at DESC', th.id, th.user_id);
        return rows.map((r) => ({ agentId: r.agent_id, agentName: ctx.store.agent(r.agent_id)?.name || 'Verwijderde bot', providerId: r.provider_id, cli: r.cli, label: defById(r.cli)?.label || r.cli, sessionId: r.session_id, updatedAt: r.updated_at }));
      }),
    );

    ctx.api.post(
      '/cli-agents/threads/:id/sessions/reset',
      ah(async (req) => {
        const u = user(req);
        const th = ctx.store.thread(req.params.id as string);
        if (!th || th.user_id !== u.id) throw notFound('Gesprek niet gevonden');
        const agentId = str(req.body?.agentId, 60);
        const n = ctx.store.all<any>('SELECT provider_id FROM cli_sessions WHERE thread_id = ? AND agent_id = ?', th.id, agentId);
        if (!n.length) return { reset: 0 };
        ctx.store.exec('DELETE FROM cli_sessions WHERE thread_id = ? AND agent_id = ?', th.id, agentId);
        const ps = { ...(th.provider_state || {}) };
        for (const r of n) delete ps[r.provider_id];
        ctx.store.updateThread(th.id, { provider_state: ps });
        const a = ctx.store.agent(agentId);
        ctx.chat.addEvent(th, `Nieuwe CLI-sessie voor ${a?.name || 'de bot'}: de volgende beurt begint opnieuw, met het eerdere gesprek als context.`, { kind: 'cli_session', agentId });
        ctx.audit(u.id, 'cli.session_reset', { threadId: th.id }, agentId);
        return { reset: n.length };
      }),
    );

    ctx.services['cli-agents'] = {
      defs: () => CLI_DEFS.map((d) => ({ id: d.id, label: d.label, engine: d.engine })),
      status: (id: string) => {
        const d = defById(id);
        return d ? cli.status(d) : null;
      },
      /** Connect a CLI found on this computer as the owner's provider (OpenCode on a free model), as "Verbinden" does. */
      connect: (userId: string, id: string) => {
        const d = kinds.get(id);
        if (!d || d.custom) throw bad('Onbekende CLI');
        if (ctx.store.user(userId)?.role !== 'owner') throw forbidden('Alleen de eigenaar van deze TeamBot-installatie kan een CLI koppelen.');
        return connect(userId, d);
      },
      /** Usage limits of the CLI login behind this provider (see usage.ts); null when the CLI reports none. */
      readLimits: (cfg: ProviderConfig, tz: string) => cli.readLimits(cfg, tz),
      /** "Gesprek samenvatten" for a CLI bot: the CLI's own compaction of the bot's session in this chat (see compact()). */
      compact: (o: { threadId: string; agentId: string; providerId: string; inRun?: boolean }) => cli.compact(o),
      /** After TeamBot summarised the chat itself: the bot's next turn starts a new session with that summary. */
      resetSession: (threadId: string, agentId: string, providerId: string) => cli.resetSession(threadId, agentId, providerId),
      switchNote: (o: { thread: any; agentId: string; providerId: string; kind: string }) => cli.switchNote(o),
      /** Engine versions (versions.ts): known-good versions, self-check, the way back. */
      versions,
      /** The TeamBot tools a run's CLI got listed at the start of the turn (toolhost.ts), for the context estimate. */
      servedTools: (runId: string) => servedTools(runId),
    };
  },
  start() {
    versions?.start();
  },
  stop() {
    versions?.stop();
    instance?.stopAll();
  },
};

export default mod;
