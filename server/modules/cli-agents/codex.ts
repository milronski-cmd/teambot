import { cliActivity, cliFacts, cliPending, cliStatus, type AppNames } from './activity-labels.js';
import type { ActivityItem, AgentRunResult, StepFact, Usage } from '../../core/types.js';
import { redact } from '../../core/secrets.js';
import { agentRootList, extraRootsOf } from '../../tools/builtin/files.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runQuick, runTempDir, startProc, type Proc } from './proc.js';
import { authHint, lastOutput, composePrompt, contextState, earlierTranscript, errorText, safeAttachments, sessionInstructions, sessionUpdate, workdir, type RunScope, type SafeAttachment, type SessionContext } from './context.js';
import { cardPath, codexCommand, commandRisk, commandWriteTargets, gate, plainCommand, unwrapShell, type GateScope } from './permissions.js';
import { RpcError, RpcPeer } from './rpc.js';
import { checkExtraArgs, type CliDef } from './catalog.js';
import { APP_VERSION } from '../../core/config.js';
import { MCP_SERVER_NAME, type BridgeRegistration, type PermissionBridge, type StdioServer } from './bridge.js';
import { teambotTools, toolsNote } from './toolhost.js';
import { codexContext, parseCodexRateLimits } from '../usage/parse.js';
import { CODEX_OPEN, codexKeyPaths, codexProfileArgs, type CodexReadGuard } from './codex-sandbox.js';
import { normalizePlan } from '../../tools/builtin/plan.js';

/** Progress line for a step of the Codex app-server ("Voert een opdracht uit…"); null = keep the current line. */
function codexStatus(type: string, it: any, apps?: AppNames): string | null {
  if (type === 'commandExecution') return 'Voert een opdracht uit…';
  if (type === 'fileChange') return 'Past bestanden aan…';
  if (type === 'webSearch') return 'Zoekt op internet…';
  if (type === 'mcpToolCall') return cliStatus(`mcp__${it.server || '?'}__${it.tool || '?'}`, apps);
  return null;
}

/**
 * OpenAI Codex CLI.
 *  readonly → `codex exec --json`, read-only (approvals never: nothing can be granted)
 *  auto     → `codex exec --json`, writes in the bot's folders, no network; anything else is refused by Codex
 *  full     → as auto, with network
 *  ask      → `codex app-server`, read-only + on-request: each escalation (write, network, outside the bot's
 *             folders) is an approval request that goes to the TeamBot Broker.
 *  chat     → refused: Codex cannot run without tools.
 * What the sandbox lets Codex READ depends on the computer (codex-sandbox.ts): TeamBot's permission profile when
 * Codex can enforce it (only the bot's folders, or everything minus key folders), else the legacy `--sandbox` flags.
 */

const REASONING = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);
const IMAGE = /^image\/(png|jpe?g|gif|webp)$/;

export interface CodexDeps {
  def: CliDef;
  bin: string;
  /** Serves TeamBot's own tools to Codex over MCP (optional in tests). */
  bridge?: PermissionBridge;
  billing(): Promise<'subscription' | 'api' | 'unknown'>;
  track(p: Proc): () => void;
  /** What the stored session already has of its instructions (changes reach a resumed session as an update). */
  context?: SessionContext;
  /** What Codex's sandbox can enforce on this computer (checked once per binary); absent = legacy flags. */
  readGuard?(): Promise<CodexReadGuard>;
}

/** TeamBot's permission profile for this run (`-c` overrides), or null when only the legacy `--sandbox` flags work here. */
export async function codexPermissions(s: RunScope, d: CodexDeps, o: { write: boolean; network: boolean }): Promise<{ args: string[] | null; guard: CodexReadGuard }> {
  const guard = (await d.readGuard?.().catch(() => CODEX_OPEN)) || CODEX_OPEN;
  const roots = agentRootList(s.agent);
  const deny = guard.level === 'keyfolders' ? codexKeyPaths({ home: os.homedir(), dataDir: s.ctx.config.dataDir, keep: roots.map((r) => r.path) }) : [];
  return { guard, args: codexProfileArgs({ guard, write: o.write, network: o.network, roots: roots.slice(1).map((r) => ({ path: r.path, mode: r.mode })), deny }) };
}

/** Codex features that act outside the sandbox without a per-action approval (from `codex features list`). */
const OUTSIDE_FEATURES = new Set(['computer_use', 'browser_use', 'browser_use_external', 'in_app_browser', 'apps', 'enable_mcp_apps', 'plugins', 'remote_plugin']);
const featureCache = new Map<string, string[]>();

/**
 * Unless the bot opts in, switch off the user's own Codex MCP servers and computer/browser
 * features for TeamBot runs: their tool calls would bypass the bot's access mode.
 */
export async function codexIsolation(bin: string, useUserMcp: boolean): Promise<string[]> {
  if (useUserMcp) return [];
  let enabled = featureCache.get(bin);
  if (!enabled) {
    const r = await runQuick(bin, ['features', 'list'], { timeoutMs: 15_000 });
    enabled = r.stdout
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s{2,}|\t/))
      .filter((c) => c.length >= 3 && /^true$/i.test(c[c.length - 1]) && OUTSIDE_FEATURES.has(c[0]))
      .map((c) => c[0]);
    featureCache.set(bin, enabled);
  }
  const out: string[] = [];
  for (const f of enabled) out.push('--disable', f);
  try {
    const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const toml = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    for (const m of toml.matchAll(/^\s*\[mcp_servers\.([A-Za-z0-9_-]{1,64})\]\s*$/gm)) out.push('-c', `mcp_servers.${m[1]}.enabled=false`);
  } catch {
    /* no user config */
  }
  return out;
}

const toml = (v: string) => JSON.stringify(v);

/**
 * `-c` overrides that add the TeamBot MCP server for this run (stdio bridge, see bridge.ts). TeamBot gates every
 * call itself (Broker + approvals), so Codex is told not to ask again ("approve") and to wait long enough for a
 * human decision. Values are TOML strings (JSON escaping is valid TOML for these paths/names).
 */
export function codexMcpArgs(srv: StdioServer): string[] {
  const k = `mcp_servers.${MCP_SERVER_NAME}`;
  const env = Object.entries(srv.env)
    .filter(([n]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n))
    .map(([n, v]) => `${n} = ${toml(v)}`)
    .join(', ');
  return [
    '-c', `${k}.command=${toml(srv.command)}`,
    '-c', `${k}.args=[${srv.args.map(toml).join(', ')}]`,
    '-c', `${k}.env={ ${env} }`,
    '-c', `${k}.enabled=true`,
    '-c', `${k}.startup_timeout_sec=30`,
    '-c', `${k}.tool_timeout_sec=86400`,
    '-c', `${k}.default_tools_approval_mode="approve"`,
  ];
}

interface CodexTools {
  args: string[];
  note: string;
  /** Ends the run's token and removes its temp files. */
  dispose(): void;
}

/** Register this run's TeamBot tools with the bridge and build the Codex config for them. */
async function withTeambotTools(s: RunScope, d: CodexDeps, hold: (on: boolean) => void): Promise<CodexTools> {
  const none: CodexTools = { args: [], note: '', dispose() {} };
  if (!d.bridge) return none;
  const tools = teambotTools(s, { engine: 'codex', hold });
  const names = await tools.names();
  if (!names.length) return none;
  await d.bridge.ensure();
  const tmp = runTempDir(s.ctx.config.dataDir, s.req.runId);
  const reg: BridgeRegistration = d.bridge.register({ tools }, tmp.dir);
  return {
    args: codexMcpArgs(d.bridge.stdioServer(reg, { tools: true })),
    note: toolsNote(names, 'codex'),
    dispose() {
      reg.dispose();
      tmp.cleanup();
    },
  };
}

/**
 * Arguments for `codex exec`. With `profile` (TeamBot's permission profile, see codex-sandbox.ts) the folders,
 * writing and network come from the profile and `--sandbox` is left out: it would switch Codex back to the legacy
 * settings, which only limit writes.
 */
export function codexExecArgs(o: { sandbox: 'read-only' | 'workspace-write'; cwd: string; model?: string; reasoning?: string; addDirs: string[]; images: string[]; sessionId?: string; extra: string[]; isolation?: string[]; mcp?: string[]; network?: boolean; profile?: string[] | null }): string[] {
  const a = ['exec', '--json', '--skip-git-repo-check', '--color', 'never', '-C', o.cwd, ...(o.profile ? o.profile : ['-s', o.sandbox]), '-c', 'approval_policy="never"', ...(o.isolation || []), ...(o.mcp || [])];
  if (!o.profile && o.network && o.sandbox === 'workspace-write') a.push('-c', 'sandbox_workspace_write.network_access=true');
  if (o.model && o.model !== 'default') a.push('-m', o.model);
  if (o.reasoning && REASONING.has(o.reasoning)) a.push('-c', `model_reasoning_effort="${o.reasoning}"`);
  if (!o.profile && o.sandbox === 'workspace-write') for (const d of o.addDirs) a.push('--add-dir', d);
  a.push(...o.extra);
  if (o.sessionId) {
    a.push('resume');
    for (const i of o.images) a.push('-i', i);
    a.push(o.sessionId, '-');
  } else {
    for (const i of o.images) a.push('-i', i);
    a.push('-');
  }
  return a;
}

const NO_SESSION = /no (rollout|session|thread|conversation) found|session not found|thread not found|could not find (session|thread)|failed to (find|load) (session|thread|rollout)/i;

/**
 * "Vraagt toestemming" (app-server, read-only sandbox, on-request): on Windows Codex wrote files with PowerShell
 * Set-Content, the sandbox refused it and Codex gave up without asking (acceptance round 3, A-16, 3 of 3 tries). A
 * change through apply_patch does reach TeamBot as an approval card; so say how to write here.
 */
/**
 * The read-only sandbox refused a command (acceptance round 4, B-46: Codex still wrote with PowerShell Set-Content now
 * and then, without asking; it failed without a card and the bot only said "geweigerd"). PowerShell (also in Dutch),
 * POSIX shells, and macOS's sandbox.
 */
/** At most this many notes per run to a turn that wrote around the sandbox (no endless back and forth). */
const MAX_STEERS = 2;

export const SANDBOX_REFUSED = /access to the path .{0,300} is denied|toegang tot het pad .{0,300} (is )?geweigerd|unauthorizedaccess|access is denied|toegang (is )?geweigerd|permission denied|read-only file system|operation not permitted/i;

/** Texts only a refused file access gives (PowerShell, also in Dutch; a read-only file system). */
export const SANDBOX_SURE = /access to the path .{0,300} is denied|toegang tot het pad .{0,300} (is )?geweigerd|unauthorizedaccess|read-only file system/i;

/** What TeamBot tells the running Codex turn when the sandbox refused a write by command (turn/steer). */
export function codexRefusedNote(files: string[], cmd: string): string {
  const what = files.length ? `om ${files.join(', ')} te schrijven` : `(${cmd.replace(/\s+/g, ' ').slice(0, 160)})`;
  return `TeamBot: je terminalopdracht ${what} is geweigerd door de alleen-lezen sandbox; zo lukt het in deze modus nooit. Doe het opnieuw met apply_patch (ook voor een nieuw bestand): dan krijgt de eigenaar een goedkeuringskaart. Heb je voor een opdracht echt meer rechten nodig, vraag die dan aan met een korte reden.`;
}

export const CODEX_ASK_NOTE =
  'Je werkt in een alleen-lezen sandbox; de eigenaar keurt elke wijziging goed via TeamBot. Maak en wijzig bestanden daarom altijd met apply_patch (ook nieuwe bestanden en mappen): dan krijgt de eigenaar een goedkeuringskaart. Schrijven met een terminalopdracht (zoals PowerShell Set-Content, New-Item, echo > of Out-File) wordt geweigerd. Heb je voor een opdracht meer rechten nodig, vraag die dan aan met een korte reden in plaats van op te geven.';

export async function runCodex(s: RunScope, d: CodexDeps): Promise<AgentRunResult> {
  if (s.agent.access_mode === 'chat') {
    return { text: '', usage: { input: 0, output: 0 }, error: 'Chatmodus (zonder tools) kan bij Codex niet worden afgedwongen. Zet deze bot op "Alleen lezen" of gebruik een API-provider voor alleen chatten.' };
  }
  if (s.agent.access_mode === 'ask') {
    try {
      return await runAppServer(s, d);
    } catch (e: any) {
      if (e?.fallback !== true || s.signal.aborted) throw e;
      s.activity('notice', 'Codex app-server niet beschikbaar — alleen lezen', `Goedkeuring per actie werkt alleen via "codex app-server" (${errorText(e).slice(0, 200)}). Deze beurt draait daarom met een alleen-lezen sandbox.`);
      return runExec(s, d, 'read-only');
    }
  }
  // "Volledige toegang": write in the workspace with network, no per-action approvals (the sandbox still keeps the
  // rest of the computer out); TeamBot tools keep their Broker rules.
  return runExec(s, d, s.agent.access_mode === 'auto' || s.agent.access_mode === 'full' ? 'workspace-write' : 'read-only');
}

interface ExecState {
  text: string;
  reasoning: string;
  sessionId?: string;
  usage: Usage;
  failed: string | null;
  sawThread: boolean;
  /** Steps of TeamBot tool calls by item id (TeamBot reports their result on them). */
  mcpSteps?: Map<string, ActivityItem>;
}

export function handleCodexExecLine(s: RunScope, st: ExecState, line: string) {
  let m: any;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  const addText = (t: string) => {
    if (!t) return;
    const sep = st.text ? (st.text.endsWith('\n') ? '\n' : '\n\n') : '';
    st.text += sep + t;
    s.emit({ type: 'text', delta: sep + t });
  };
  switch (m.type) {
    case 'thread.started':
      st.sawThread = true;
      if (m.thread_id) {
        st.sessionId = m.thread_id;
        s.emit({ type: 'session', sessionId: m.thread_id });
        s.activity('session', s.req.sessionId === m.thread_id ? 'Verder in het vorige Codex-gesprek' : 'Codex gestart');
      }
      break;
    case 'turn.started':
      s.emit({ type: 'status', text: 'Codex denkt na…' });
      break;
    case 'turn.completed': {
      const u = m.usage || {};
      st.usage.input += Number(u.input_tokens) || 0;
      st.usage.output += (Number(u.output_tokens) || 0) + (Number(u.reasoning_output_tokens) || 0);
      st.usage.cacheRead = (st.usage.cacheRead || 0) + (Number(u.cached_input_tokens) || 0);
      break;
    }
    case 'turn.failed':
      st.failed = String(m.error?.message || 'Codex-beurt mislukt');
      break;
    case 'error':
      st.failed = String(m.message || m.error?.message || 'Codex-fout');
      break;
    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const it = m.item || {};
      const done = m.type === 'item.completed';
      if (it.type === 'agent_message' && done) addText(String(it.text || ''));
      else if (it.type === 'reasoning' && done && it.text) {
        st.reasoning += (st.reasoning ? '\n\n' : '') + it.text;
        s.emit({ type: 'reasoning', delta: (st.reasoning.length > it.text.length ? '\n\n' : '') + it.text });
      } else if (it.type === 'command_execution') {
        if (m.type === 'item.started') s.emit({ type: 'status', text: 'Voert een opdracht uit…' });
        if (m.type === 'item.started') s.activity('tool', `Voerde uit: ${codexCommand(it.command).replace(/\s+/g, ' ').slice(0, 200)}`, undefined, it.command ? [{ op: 'exec', target: codexCommand(it.command) }] : undefined);
        else if (done && it.exit_code !== 0) s.activity('tool_error', `Opdracht lukte niet (exitcode ${it.exit_code ?? '?'})`, String(it.aggregated_output || '').slice(-400) || undefined);
      } else if (it.type === 'file_change' && done) {
        s.activity('files', `Bestanden ${it.status === 'failed' ? 'niet ' : ''}gewijzigd`, changeLines(it.changes), it.status === 'failed' ? undefined : changeFacts(it.changes));
      } else if (it.type === 'mcp_tool_call' && m.type === 'item.started') {
        const label = cliActivity(`mcp__${it.server || '?'}__${it.tool || '?'}`, it.arguments, s.apps);
        const item = label ? s.activity('tool', label, undefined, cliFacts(`mcp__${it.server || '?'}__${it.tool || '?'}`, it.arguments, s.apps)) : undefined;
        // A TeamBot tool: TeamBot reports its result on this same step (B-04).
        if (item && it.server === MCP_SERVER_NAME && it.tool) {
          s.teambotStep?.(String(it.tool), item);
          if (it.id) (st.mcpSteps ||= new Map()).set(String(it.id), item);
        }
      } else if (it.type === 'mcp_tool_call' && done) {
        const item = st.mcpSteps?.get(String(it.id));
        if (item) s.teambotStepDone?.(item);
      } else if (it.type === 'web_search' && m.type === 'item.started') {
        s.activity('tool', `Zocht op internet: ${String(it.query || '').slice(0, 200)}`, undefined, it.query ? [{ op: 'search', target: String(it.query) }] : undefined);
      } else if (it.type === 'todo_list') {
        const steps = normalizePlan(it.items);
        if (steps) s.emit({ type: 'plan', steps });
      } else if (it.type === 'error' && done) {
        s.activity('error', 'Codex meldt een fout', String(it.message || '').slice(0, 600));
      }
      break;
    }
  }
}

async function prepare(s: RunScope) {
  const atts = safeAttachments(s.agent, s.req.attachments);
  const images = atts.filter((a) => IMAGE.test(a.mime)).map((a) => a.path);
  return { atts, images };
}

/** Turn prompt: on a fresh session the earlier chat (and, for exec, the instructions); on a resumed one an update if they changed. */
function promptFor(s: RunScope, atts: SafeAttachment[], fresh: boolean, o: { system?: string; update?: string }): string {
  let transcript = '';
  if (fresh) {
    const t = earlierTranscript(s.ctx, s.agent, s.req.threadId, s.run?.input_message_id);
    if (t.count) {
      transcript = t.text;
      s.activity('session', 'Nieuwe sessie met eerdere context', t.count === 1 ? '1 eerder bericht uit deze chat meegegeven' : `${t.count} eerdere berichten uit deze chat meegegeven`);
    }
  }
  return composePrompt({ system: fresh ? o.system : undefined, update: fresh ? undefined : o.update, transcript, prompt: s.req.prompt, attachments: atts });
}

async function runExec(s: RunScope, d: CodexDeps, sandbox: 'read-only' | 'workspace-write'): Promise<AgentRunResult> {
  const cwd = workdir(s.agent);
  const { atts, images } = await prepare(s);
  const extra = checkExtraArgs(d.def, s.opts.extraArgs);
  const isolation = await codexIsolation(d.bin, s.opts.useUserMcp);
  const network = sandbox === 'workspace-write' && s.agent.access_mode === 'full';
  const perm = await codexPermissions(s, d, { write: sandbox === 'workspace-write', network });
  let current: Proc | null = null;
  const tb = await withTeambotTools(s, d, (on) => current?.hold(on));
  try {
    return await execWith(s, d, sandbox, { cwd, atts, images, extra, isolation, tb, profile: perm.args, network, setProc: (p) => (current = p) });
  } finally {
    tb.dispose();
  }
}

async function execWith(
  s: RunScope,
  d: CodexDeps,
  sandbox: 'read-only' | 'workspace-write',
  o: { cwd: string; atts: SafeAttachment[]; images: string[]; extra: string[]; isolation: string[]; tb: CodexTools; profile: string[] | null; network: boolean; setProc(p: Proc): void },
): Promise<AgentRunResult> {
  const { cwd, atts, images, extra, isolation, tb } = o;
  const full = sessionInstructions(s.req.system, tb.note);
  const attempt = async (sessionId: string | undefined) => {
    const st: ExecState = { text: '', reasoning: '', sessionId, usage: { input: 0, output: 0 }, failed: null, sawThread: false };
    const proc = startProc({
      bin: d.bin,
      args: codexExecArgs({ sandbox, cwd, model: s.req.model, reasoning: s.req.reasoning, addDirs: extraRootsOf(s.agent, { writableOnly: true }), images, sessionId, extra, isolation, mcp: tb.args, network: o.network, profile: o.profile }),
      cwd,
      env: { NO_COLOR: '1' },
      signal: s.signal,
      timeoutMs: s.opts.timeoutMin * 60_000,
      idleMs: s.opts.idleMin * 60_000,
      onLine: (l) => handleCodexExecLine(s, st, l),
    });
    o.setProc(proc);
    const untrack = d.track(proc);
    proc.write(promptFor(s, atts, !sessionId, { system: full, update: sessionId ? sessionUpdate(s, d.context, full) : '' }));
    proc.end();
    const exit = await proc.done;
    untrack();
    return { st, exit, stderr: proc.stderrTail(), killed: proc.killedReason };
  };
  let r = await attempt(s.req.sessionId);
  if (s.req.sessionId && !s.signal.aborted && !r.st.sawThread && NO_SESSION.test(r.stderr + (r.st.failed || ''))) {
    s.activity('session', 'Vorige Codex-sessie niet gevonden — nieuwe sessie gestart');
    r = await attempt(undefined);
  }
  if (s.signal.aborted) throw new Error('Gestopt');
  const billing = await d.billing();
  r.st.usage.cost = billing === 'api' ? undefined : 0;
  const base = { text: r.st.text, usage: r.st.usage, sessionId: r.st.sessionId };
  if (r.killed) return { ...base, error: r.killed };
  if (r.st.failed) return { ...base, error: authHint(r.st.failed + ' ' + r.stderr, d.def.login) || redact(r.st.failed).slice(0, 1500) };
  if (r.exit.code !== 0) {
    return { ...base, error: authHint(r.stderr, d.def.login) || `Codex stopte onverwacht (${r.exit.error || `exitcode ${r.exit.code}`}).${lastOutput(r.stderr) ? ' Laatste uitvoer: ' + lastOutput(r.stderr, 600) : ''}` };
  }
  if (r.st.sessionId) d.context?.save(r.st.sessionId, contextState(full));
  return base;
}

// ---------------- app-server (ask mode) ----------------

class Fallback extends Error {
  fallback = true;
}

async function runAppServer(s: RunScope, d: CodexDeps): Promise<AgentRunResult> {
  const cwd = workdir(s.agent);
  const { atts, images } = await prepare(s);
  const usage: Usage = { input: 0, output: 0 };
  let text = '';
  let turnId: string | null = null;
  let threadId: string | undefined;
  let finished: { status: string; error?: string } | null = null;
  let finishTurn: () => void = () => {};
  let turnDone = new Promise<void>((r) => (finishTurn = r));
  const items = new Map<string, any>();
  const mcpSteps = new Map<string, { item: ActivityItem; past: string }>();
  // Commands Codex asked TeamBot about (an approval card); a refused write it did not ask about is steered (B-46).
  const askedItems = new Set<string>();
  // A plain "permission denied" (git push without a key …) is no sign of the sandbox; it counts for a write command.
  const refusedBySandbox = (it: any) => {
    const out = String(it.aggregatedOutput || '');
    if (askedItems.has(String(it.id)) || !(it.status === 'failed' || (it.exitCode ?? 0) !== 0) || !SANDBOX_REFUSED.test(out)) return false;
    return SANDBOX_SURE.test(out) || !!commandWriteTargets(codexCommand(it.command));
  };
  let refusedNote = '';
  let steering: Promise<unknown> = Promise.resolve();
  let steered = 0;
  let lastItemText = '';
  let context: { used: number; window: number | null } | null = null;
  // The model Codex reports for the thread (thread/start or thread/resume), shown under the answer.
  let usedModel: string | undefined;
  const gs: GateScope = {
    ctx: s.ctx,
    agent: s.agent,
    thread: s.thread,
    run: s.run,
    userId: s.req.userId,
    signal: s.signal,
    ns: d.def.id,
    hold: (on) => proc.hold(on),
    onActivity: (title, detail) => s.activity('permission', title, detail),
  };
  let peer!: RpcPeer;
  const isolation = await codexIsolation(d.bin, s.opts.useUserMcp);
  // Read-only profile (reads limited where Codex can enforce it); every escalation asks TeamBot.
  const perm = await codexPermissions(s, d, { write: false, network: false });
  let started: Proc | null = null;
  const tb = await withTeambotTools(s, d, (on) => started?.hold(on));
  const full = sessionInstructions(s.req.system, [tb.note, CODEX_ASK_NOTE].filter(Boolean).join('\n\n'));
  let proc: Proc;
  try {
    proc = startProc({
      bin: d.bin,
      args: ['app-server', ...isolation, ...tb.args, ...(perm.args || [])],
      cwd,
      env: { NO_COLOR: '1' },
      signal: s.signal,
      timeoutMs: s.opts.timeoutMin * 60_000,
      idleMs: s.opts.idleMin * 60_000,
      graceMs: 3000,
      onLine: (l) => peer.handleLine(l),
    });
  } catch (e) {
    tb.dispose();
    throw e;
  }
  started = proc;
  peer = new RpcPeer(proc, { jsonrpcField: false });
  const untrack = d.track(proc);
  const exited = proc.done.then((x) => {
    peer.close('Codex app-server is gestopt');
    finishTurn();
    return x;
  });
  const emitText = (t: string, itemId: string) => {
    if (!t) return;
    if (lastItemText && lastItemText !== itemId && text && !text.endsWith('\n\n')) {
      const sep = text.endsWith('\n') ? '\n' : '\n\n';
      text += sep;
      s.emit({ type: 'text', delta: sep });
    }
    lastItemText = itemId;
    text += t;
    s.emit({ type: 'text', delta: t });
  };
  const streamedItems = new Set<string>();

  peer.onNotification = (method, p) => {
    if (p?.threadId && threadId && p.threadId !== threadId) return;
    switch (method) {
      case 'item/agentMessage/delta':
        streamedItems.add(p.itemId);
        emitText(String(p.delta || ''), p.itemId);
        break;
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        s.emit({ type: 'reasoning', delta: String(p.delta || '') });
        break;
      case 'item/started': {
        const it = p.item || {};
        items.set(it.id, it);
        const status = codexStatus(it.type, it, s.apps);
        if (status) s.emit({ type: 'status', text: status });
        // The command as it ran (single backslashes) and without the PowerShell or bash wrapper, like on the card.
        if (it.type === 'commandExecution') s.activity('tool', `Opdracht: ${(plainCommand(unwrapShell(codexCommand(it.command)), cwd) || codexCommand(it.command)).slice(0, 300)}`, undefined, it.command ? [{ op: 'exec', target: codexCommand(it.command) }] : undefined);
        else if (it.type === 'fileChange') s.activity('tool', 'Bestanden wijzigen', (it.changes || []).map((c: any) => c.path).join('\n').slice(0, 1500));
        else if (it.type === 'mcpToolCall') {
          // Until the call is completed (a TeamBot tool may wait for an approval card): what the bot wants to do.
          const tool = `mcp__${it.server || '?'}__${it.tool || '?'}`;
          const label = cliPending(tool, it.arguments, s.apps);
          if (label) {
            const item = s.activity('tool', label, undefined, cliFacts(tool, it.arguments, s.apps));
            mcpSteps.set(it.id, { item, past: cliActivity(tool, it.arguments, s.apps) || label });
            // A TeamBot tool: TeamBot reports its result on this same step (B-04).
            if (it.server === MCP_SERVER_NAME && it.tool) s.teambotStep?.(String(it.tool), item);
          }
        }
        else if (it.type === 'webSearch') s.activity('tool', `Zoeken op internet: ${String(it.query || '').slice(0, 200)}`, undefined, it.query ? [{ op: 'search', target: String(it.query) }] : undefined);
        break;
      }
      case 'item/completed': {
        const it = p.item || {};
        items.set(it.id, it);
        const step = it.type === 'mcpToolCall' ? mcpSteps.get(it.id) : undefined;
        if (step) s.teambotStepDone?.(step.item);
        if (step) s.retitle(step.item, step.past);
        if (it.type === 'agentMessage' && !streamedItems.has(it.id)) emitText(String(it.text || ''), it.id);
        else if (it.type === 'commandExecution' && refusedBySandbox(it)) {
          // Codex ran it without asking and the read-only sandbox refused it (B-46): say so in the steps, and tell the
          // running turn how it does work here, so the bot tries again with apply_patch (an approval card).
          const cmd = codexCommand(it.command);
          const files = (commandWriteTargets(cmd) || []).map((f) => cardPath(f, cwd));
          s.activity('tool_error', files.length ? `Mocht ${files.join(', ')} niet met een terminalopdracht schrijven` : 'Een opdracht werd geweigerd door de alleen-lezen sandbox', 'In "Vraagt toestemming" mag Codex alleen via apply_patch schrijven: dan krijg je een goedkeuringskaart. TeamBot heeft Codex gevraagd het zo opnieuw te doen.');
          refusedNote = codexRefusedNote(files, plainCommand(unwrapShell(cmd), cwd) || cmd);
          if (steered < MAX_STEERS && turnId && threadId) {
            steered++;
            const note = refusedNote;
            steering = peer.request('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text: note, text_elements: [] }] }, 10_000).then(
              () => (refusedNote = ''),
              () => {
                /* the turn had ended already: a short follow-up turn takes the note (below) */
              },
            );
          }
        } else if (it.type === 'commandExecution') s.activity(it.status === 'completed' && (it.exitCode ?? 0) === 0 ? 'tool_result' : 'tool_error', `Opdracht ${it.status === 'declined' ? 'geweigerd' : it.status === 'completed' ? 'klaar' : 'mislukt'}`, String(it.aggregatedOutput || '').slice(-600) || undefined);
        else if (it.type === 'fileChange') s.activity('files', `Bestanden ${it.status === 'completed' ? 'gewijzigd' : 'niet gewijzigd'}`, changeLines(it.changes), it.status === 'completed' ? changeFacts(it.changes) : undefined);
        break;
      }
      case 'turn/plan/updated': {
        const steps = normalizePlan(p.plan);
        if (steps) s.emit({ type: 'plan', steps });
        break;
      }
      case 'thread/tokenUsage/updated': {
        const t = p.tokenUsage?.total;
        if (t) {
          usage.input = Number(t.inputTokens) || 0;
          usage.output = (Number(t.outputTokens) || 0) + (Number(t.reasoningOutputTokens) || 0);
          usage.cacheRead = Number(t.cachedInputTokens) || 0;
        }
        const c = codexContext(p);
        if (c) context = c;
        break;
      }
      case 'account/rateLimits/updated': {
        // Codex's own usage windows (5 hours / week / month, depending on the plan), live during the turn.
        const r = parseCodexRateLimits(p?.rateLimits ? { rateLimits: p.rateLimits } : p);
        if (r) s.ctx.services?.usage?.report?.(s.cfg, { ...r, source: 'stream' });
        break;
      }
      case 'turn/started':
        if (!turnId) turnId = p.turn?.id || null;
        break;
      case 'turn/completed':
        if (!turnId || p.turn?.id === turnId) {
          finished = { status: String(p.turn?.status || 'completed'), error: p.turn?.error?.message };
          finishTurn();
        }
        break;
      case 'error':
        if (p?.willRetry) s.emit({ type: 'status', text: 'Codex probeert het opnieuw…' });
        else s.activity('error', 'Codex meldt een fout', String(p?.error?.message || '').slice(0, 600));
        break;
    }
  };

  peer.onRequest = async (method, p) => {
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        if (p.itemId) askedItems.add(String(p.itemId));
        const cmd = codexCommand(p.command || items.get(p.itemId)?.command || '');
        const network = !!p.networkApprovalContext;
        const cwd = p.cwd ? String(p.cwd) : workdir(s.agent);
        // Codex writes files with a command ("Set-Content planten.txt …"): the card says "een bestand schrijven" and
        // names the file; the exact command stays under "Exacte invoer bekijken". Its own policy key, so "altijd
        // toestaan" for writing a file never covers other commands.
        const writes = network ? null : commandWriteTargets(cmd);
        const shown = plainCommand(unwrapShell(cmd), cwd);
        const g = await gate(gs, {
          tool: network ? 'netwerk' : writes ? 'bestand-schrijven' : 'opdracht',
          // A write must land in a folder the bot may write to (the gate checks the paths as writes).
          risk: network ? 'danger' : writes ? (commandRisk(cmd) === 'danger' ? 'danger' : 'write') : commandRisk(cmd),
          summary: writes
            ? `Bestand schrijven: ${writes.map((f) => cardPath(f, cwd)).join(', ')}${p.reason ? ` — reden: ${p.reason}` : ''}`
            : `${network ? 'Netwerktoegang voor' : 'Opdracht'}: ${shown || p.reason || '(onbekend)'}${p.reason ? ` — reden: ${p.reason}` : ''}`,
          input: { command: cmd, cwd: p.cwd, reason: p.reason },
          paths: [...(p.cwd ? [String(p.cwd)] : []), ...(writes || []).map((f) => path.resolve(cwd, f))],
          command: cmd,
        });
        return { decision: g.allow ? 'accept' : 'decline' };
      }
      case 'item/fileChange/requestApproval': {
        const it = items.get(p.itemId);
        const paths: string[] = (it?.changes || []).map((c: any) => String(c.path));
        if (p.grantRoot) paths.push(String(p.grantRoot));
        const g = await gate(gs, { tool: 'bestanden', impact: 'local', risk: (it?.changes || []).some((c: any) => c.kind?.type === 'delete') ? 'danger' : 'write', summary: `Bestanden wijzigen: ${paths.join(', ') || '(onbekend)'}${p.reason ? ` — reden: ${p.reason}` : ''}`, input: { paths, reason: p.reason }, paths });
        return { decision: g.allow ? 'accept' : 'decline' };
      }
      case 'item/permissions/requestApproval': {
        const g = await gate(gs, { tool: 'extra-rechten', risk: 'danger', summary: `Codex vraagt extra rechten: ${JSON.stringify(p.permissions || {}).slice(0, 400)}${p.reason ? ` — reden: ${p.reason}` : ''}`, input: p.permissions || {} });
        return g.allow ? { permissions: p.permissions || {}, scope: 'turn' } : { permissions: {}, scope: 'turn' };
      }
      case 'item/tool/requestUserInput': {
        const answers: Record<string, { answers: string[] }> = {};
        for (const q of p.questions || []) {
          if (q.isSecret) {
            answers[q.id] = { answers: [] };
            continue;
          }
          try {
            proc.hold(true);
            const r = await s.ctx.broker.request({ userId: s.req.userId, agent: s.agent, thread: s.thread, run: s.run, kind: 'question', tool: 'codex:vraag', input: {}, summary: [q.header, q.question].filter(Boolean).join(' — ').slice(0, 1500), risk: 'read', options: (q.options || []).map((o: any) => String(o.label ?? o)).slice(0, 10), signal: s.signal });
            answers[q.id] = { answers: r.answer ? [r.answer] : [] };
          } catch {
            answers[q.id] = { answers: [] };
          } finally {
            proc.hold(false);
          }
        }
        return { answers };
      }
      case 'mcpServer/elicitation/request':
        // TeamBot's own server never asks anything itself: an elicitation for it is Codex's own approval prompt for
        // a TeamBot tool call, which TeamBot gates when the call arrives (Broker + approvals). Others: decline.
        if (p?.serverName === MCP_SERVER_NAME && p?.mode !== 'url') return { action: 'accept', content: {}, _meta: null };
        return { action: 'decline', content: null, _meta: null };
      case 'applyPatchApproval':
      case 'execCommandApproval':
        return { decision: 'denied' };
      default:
        throw new RpcError(`TeamBot ondersteunt ${method} niet`, -32601);
    }
  };

  try {
    try {
      await peer.request('initialize', { clientInfo: { name: 'teambot', title: 'TeamBot', version: APP_VERSION }, capabilities: { experimentalApi: false, requestAttestation: false } }, 30_000);
    } catch (e: any) {
      const st = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 50))]);
      throw new Fallback(`app-server start mislukt: ${errorText(e)}${st ? ' ' + proc.stderrTail().slice(-300) : ''}`);
    }
    peer.notify('initialized', {});
    // With TeamBot's profile on the command line no `sandbox` here: that would select the legacy settings again.
    const policy = perm.args ? { approvalPolicy: 'on-request' } : { approvalPolicy: 'on-request', sandbox: 'read-only' };
    let fresh = !s.req.sessionId;
    if (s.req.sessionId) {
      try {
        const r: any = await peer.request('thread/resume', { threadId: s.req.sessionId, cwd, ...policy, excludeTurns: true }, 60_000);
        threadId = r?.thread?.id || s.req.sessionId;
        if (typeof r?.model === 'string') usedModel = r.model;
        s.activity('session', 'Codex-sessie hervat');
      } catch (e: any) {
        s.activity('session', 'Vorige Codex-sessie niet gevonden — nieuwe sessie gestart', errorText(e).slice(0, 200));
        fresh = true;
      }
    }
    if (fresh) {
      const r: any = await peer.request('thread/start', { cwd, ...policy, model: s.req.model && s.req.model !== 'default' ? s.req.model : null, developerInstructions: full }, 60_000);
      threadId = r?.thread?.id;
      if (typeof r?.model === 'string') usedModel = r.model;
      if (!threadId) throw new Error('Codex gaf geen sessie-id terug');
      s.activity('session', 'Codex-sessie gestart', `Model: ${r?.model || 'standaard'} · alleen-lezen sandbox${perm.guard.level === 'confined' ? ' (alleen de mappen van de bot)' : ''}, goedkeuring via TeamBot`);
    }
    s.emit({ type: 'session', sessionId: threadId! });
    // A resumed thread keeps the developerInstructions it started with: changed instructions go in as an update.
    const input: any[] = [{ type: 'text', text: promptFor(s, atts, fresh, { update: fresh ? '' : sessionUpdate(s, d.context, full) }), text_elements: [] }, ...images.map((p) => ({ type: 'localImage', path: p }))];
    const onAbort = () => {
      if (turnId && threadId) peer.request('turn/interrupt', { threadId, turnId }, 3000).catch(() => {});
    };
    s.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const tr: any = await peer.request('turn/start', { threadId, input, ...(s.req.reasoning && REASONING.has(s.req.reasoning) ? { effort: s.req.reasoning } : {}) }, 60_000);
      turnId = tr?.turn?.id || turnId;
      await turnDone;
      // The sandbox refused a write and the turn ended before TeamBot could tell it (turn/steer came too late): one
      // short follow-up turn with that note, so the bot does it the way that asks the owner (apply_patch, a card).
      await steering;
      if (refusedNote && !s.signal.aborted && !proc.killedReason && (finished as { status: string } | null)?.status !== 'failed') {
        const note = refusedNote;
        refusedNote = '';
        turnId = null;
        finished = null;
        turnDone = new Promise<void>((r) => (finishTurn = r));
        s.activity('session', 'Codex probeert het opnieuw via een goedkeuringskaart');
        const tr2: any = await peer.request('turn/start', { threadId, input: [{ type: 'text', text: note, text_elements: [] }] }, 60_000);
        turnId = tr2?.turn?.id || turnId;
        await turnDone;
      }
    } finally {
      s.signal.removeEventListener('abort', onAbort);
    }
    if (s.signal.aborted) throw new Error('Gestopt');
    const billing = await d.billing();
    usage.cost = billing === 'api' ? undefined : 0;
    const base = { text, usage, sessionId: threadId, model: usedModel };
    if (context) s.ctx.services?.usage?.setContext?.(s.req.threadId, s.agent.id, { ...(context as { used: number; window: number | null }), engine: d.def.label, providerId: s.cfg.id });
    const f = finished as { status: string; error?: string } | null;
    if (proc.killedReason) return { ...base, error: proc.killedReason };
    if (!f) return { ...base, error: authHint(proc.stderrTail(), d.def.login) || `Codex stopte onverwacht.${lastOutput(proc.stderrTail()) ? ' Laatste uitvoer: ' + lastOutput(proc.stderrTail(), 600) : ''}` };
    if (f.status === 'failed') return { ...base, error: authHint(f.error || '', d.def.login) || redact(f.error || 'Codex-beurt mislukt').slice(0, 1500) };
    if (threadId) d.context?.save(threadId, contextState(full));
    return base;
  } finally {
    untrack();
    proc.kill('klaar');
    await exited;
    tb.dispose();
  }
}

const modelCache = new Map<string, { at: number; v: { id: string; label?: string; vision?: boolean; reasoning?: boolean; tools?: boolean; reasoningLevels?: string[]; defaultReasoning?: string; isDefault?: boolean }[] }>();

/** Codex's reasoning efforts for a model from model/list (strings or { reasoningEffort } objects), in TeamBot's set. */
export function codexEfforts(m: any): string[] {
  const list = Array.isArray(m?.supportedReasoningEfforts) ? m.supportedReasoningEfforts : [];
  return [...new Set(list.map((x: any) => String(typeof x === 'string' ? x : x?.reasoningEffort || x?.effort || '')).filter((x: string) => REASONING.has(x)))] as string[];
}

/** Models available to the user's Codex login, via app-server `model/list` (no prompt, no cost). */
export async function codexModels(bin: string, cwd: string) {
  const c = modelCache.get(bin);
  if (c && Date.now() - c.at < 10 * 60_000) return c.v;
  const ctl = new AbortController();
  let peer!: RpcPeer;
  const proc = startProc({ bin, args: ['app-server'], cwd, signal: ctl.signal, timeoutMs: 30_000, idleMs: 30_000, onLine: (l) => peer.handleLine(l) });
  peer = new RpcPeer(proc, { jsonrpcField: false });
  proc.done.then(() => peer.close('gestopt'));
  try {
    await peer.request('initialize', { clientInfo: { name: 'teambot', title: 'TeamBot', version: APP_VERSION }, capabilities: { experimentalApi: false, requestAttestation: false } }, 20_000);
    peer.notify('initialized', {});
    const r: any = await peer.request('model/list', { limit: 100 }, 20_000);
    const v = (r?.data || [])
      .filter((m: any) => !m.hidden)
      .map((m: any) => ({
        id: String(m.model || m.id),
        label: String(m.displayName || m.model || m.id),
        vision: Array.isArray(m.inputModalities) ? m.inputModalities.includes('image') : undefined,
        reasoning: codexEfforts(m).length > 0,
        reasoningLevels: codexEfforts(m),
        defaultReasoning: REASONING.has(String(m.defaultReasoningEffort)) ? String(m.defaultReasoningEffort) : undefined,
        isDefault: !!m.isDefault,
        tools: true,
        capSource: 'Codex',
      }));
    modelCache.set(bin, { at: Date.now(), v });
    return v;
  } finally {
    ctl.abort();
    await proc.done;
  }
}

/** A Codex change per file in words ("nieuw: a.txt", "gewijzigd: b.md", "verwijderd: c.py"), not Codex's add/update. */
export function changeLines(changes: any): string {
  const word: Record<string, string> = { add: 'nieuw', delete: 'verwijderd', update: 'gewijzigd' };
  return (Array.isArray(changes) ? changes : [])
    .map((c: any) => `${word[String(c?.kind?.type || c?.kind || 'update')] || 'gewijzigd'}: ${c?.path}`)
    .join('\n')
    .slice(0, 1500);
}

/** Files a Codex change touched (write, or delete for a removal). */
function changeFacts(changes: any): StepFact[] | undefined {
  const out: StepFact[] = [];
  for (const c of Array.isArray(changes) ? changes : []) {
    const kind = String(c?.kind?.type || c?.kind || '');
    if (typeof c?.path === 'string' && c.path) out.push({ op: kind === 'delete' ? 'delete' : 'write', target: c.path });
  }
  return out.length ? out : undefined;
}
