import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clampEffort, claudeInfo } from '../../providers/capabilities.js';
import type { ActivityItem, AgentRunResult, Usage } from '../../core/types.js';
import { redact } from '../../core/secrets.js';
import { extraRootsOf } from '../../tools/builtin/files.js';
import { runQuick, runTempDir, startProc, type Proc } from './proc.js';
import { authHint, lastOutput, earlierTranscript, safeAttachments, attachmentNote, languageSection, withLanguage, workdir, type RunScope } from './context.js';
import { claudeToolRisk, claudeToolSummary, commandOf, gate, pathsOf, type GateScope } from './permissions.js';
import { claudeErrorText, cliActivity, cliFacts, cliPending, cliStatus, deniedWhat, failedStep } from './activity-labels.js';
import { MCP_SERVER_NAME, PERMISSION_TOOL_FQN, type BridgeRegistration, type PermissionBridge, type PermissionDecision } from './bridge.js';
import { teambotTools, toolsNote } from './toolhost.js';
import { checkExtraArgs, type CliDef } from './catalog.js';
import { claudeContextFromUsage, claudeContextWindow, parseClaudeRateLimitEvent } from '../usage/parse.js';
import { normalizePlan } from '../../tools/builtin/plan.js';
import { prettyModel } from '../../../shared/modelLabel.js';

export interface ClaudeFeatures {
  partial: boolean;
  appendFile: boolean;
  restricted: boolean;
  permissionPrompts: boolean;
  tools: boolean;
  effort: boolean;
  modes: string[];
  /** `--setting-sources` and `--settings` (keep the owner's own Claude Code context out of TeamBot bots). */
  settingSources?: boolean;
  settings?: boolean;
}

/**
 * Claude Code reports a usage limit as "Claude AI usage limit reached|1794041512" (reset as Unix seconds). The user
 * reads words instead: "(opnieuw mogelijk over 60 minuten, rond 09:51)" — the relative part keeps the reset time
 * readable for the reserve engines (resetTimeFrom) and for routines that wait for the reset (parseLimitReset).
 */
export function readableReset(raw: string, now = Date.now()): string {
  return raw.replace(/\|(\d{10})\b/g, (_m, s: string) => {
    const at = Number(s) * 1000;
    const min = Math.max(1, Math.round((at - now) / 60_000));
    const clock = new Date(at).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
    return min === 1 ? ` (opnieuw mogelijk over 1 minuut, rond ${clock})` : ` (opnieuw mogelijk over ${min} minuten, rond ${clock})`;
  });
}

const featureCache = new Map<string, { key: string; f: ClaudeFeatures }>();

/** Read supported flags from `claude --help` (no network, no prompt), cached per binary + mtime. */
export async function claudeFeatures(bin: string): Promise<ClaudeFeatures> {
  let key = bin;
  try {
    key += ':' + fs.statSync(bin).mtimeMs;
  } catch {
    /* ignore */
  }
  const c = featureCache.get(bin);
  if (c && c.key === key) return c.f;
  const r = await runQuick(bin, ['--help'], { timeoutMs: 15_000 });
  const h = r.stdout + r.stderr;
  const modeBlock = h.match(/--permission-mode[\s\S]*?\(choices:([\s\S]*?)\)/)?.[1] || '';
  const modes = [...modeBlock.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]);
  const f: ClaudeFeatures = {
    partial: /--include-partial-messages/.test(h),
    appendFile: /--append-system-prompt-file|--append-system-prompt\[-file\]/.test(h),
    restricted: /--restricted\b/.test(h),
    permissionPrompts: /--permission-prompts\b/.test(h),
    tools: /--tools\s/.test(h),
    effort: /--effort\b/.test(h),
    settingSources: /--setting-sources\b/.test(h),
    settings: /--settings\b/.test(h),
    modes: modes.length ? modes : ['acceptEdits', 'bypassPermissions', 'default', 'plan'],
  };
  featureCache.set(bin, { key, f });
  return f;
}

export interface ClaudeArgInput {
  mode: 'chat' | 'readonly' | 'ask' | 'auto';
  model?: string;
  sessionId?: string;
  systemFile?: string;
  systemInline?: string;
  /** Per-run MCP config with the TeamBot server (tools and/or the permission gate). */
  mcpConfigFile?: string;
  /** TeamBot tools offered over MCP (names without prefix); allowed without a Claude prompt — TeamBot gates them itself. */
  teambotTools?: string[];
  maxTurns: number;
  effort?: string;
  addDirs: string[];
  /**
   * Some of addDirs are read-only: every file edit must reach the permission gate (which refuses writes there), so
   * "auto" runs in Claude's normal mode instead of acceptEdits. The Broker still approves ordinary writes on its own.
   */
  gateEdits?: boolean;
  allowedTools: string[];
  disallowedTools: string[];
  extraArgs: string[];
  loadUserSettings: boolean;
  useUserMcp: boolean;
  /** The bot may use a terminal (TeamBot tool group "shell"): Bash/PowerShell are offered, still behind the gate. */
  shell?: boolean;
  /** TeamBot tool group "web" (Internet): false → Claude Code's own WebFetch and WebSearch are switched off. */
  web?: boolean;
  /** Working folder of the run: CLAUDE.md files in the folders above it belong to the owner, not to the bot. */
  cwd?: string;
  home?: string;
}

/**
 * Memory files that are the owner's own Claude Code context, not the bot's: ~/.claude/CLAUDE.md and rules, and the
 * CLAUDE.md/AGENTS.md files in the folders above the bot's working folder (e.g. one in the owner's home folder).
 * Patterns for the `claudeMdExcludes` setting (absolute paths, glob), with forward slashes and, on Windows, also as
 * written there. The bot's own folder (a project the owner pointed it at) keeps its CLAUDE.md.
 */
export function ownerMemoryExcludes(cwd: string, home: string): string[] {
  const files = (d: string) => [path.join(d, 'CLAUDE.md'), path.join(d, 'CLAUDE.local.md'), path.join(d, 'AGENTS.md'), path.join(d, '.claude', 'CLAUDE.md'), path.join(d, '.claude', 'rules', '**')];
  const out: string[] = [];
  if (home) out.push(path.join(home, '.claude', 'CLAUDE.md'), path.join(home, '.claude', 'rules', '**'));
  let d = path.resolve(cwd);
  for (let i = 0; i < 40; i++) {
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
    out.push(...files(d));
  }
  return [...new Set(out.flatMap((p) => (p.includes('\\') ? [p.replace(/\\/g, '/'), p] : [p])))];
}

/**
 * Claude Code's built-in tools named explicitly: with --restricted, "--tools default" drops Bash/PowerShell (and
 * WebFetch) — a bot with terminal rights would silently have no shell. Unknown names are ignored by the CLI.
 */
export const CLAUDE_BASE_TOOLS = ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'Task', 'Agent', 'Skill'];
export const CLAUDE_SHELL_TOOLS = ['Bash', 'PowerShell', 'BashOutput', 'KillShell', 'KillBash'];
/** Claude Code tools that reach outside TeamBot (cloud schedules, other sessions, push, workflows): always denied. */
export const CLAUDE_OUTSIDE_TOOLS = [
  'RemoteTrigger', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'PushNotification', 'SendMessage', 'ListAgents',
  'Workflow', 'DesignSync', 'Monitor', 'TaskStop', 'EnterWorktree', 'ExitWorktree', 'ReportFindings', 'Skill(schedule)', 'Skill(loop)',
];

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Translate a TeamBot access mode to Claude Code flags. Never broader than the bot's mode:
 *  chat     → no tools at all
 *  readonly → plan mode, nobody can approve anything
 *  ask      → normal mode, every permission prompt goes to the TeamBot Broker (human)
 *  auto     → acceptEdits (normal mode when a read-only folder is attached, so its edits reach the gate); other
 *             prompts go to the Broker (auto for write/exec, human for danger)
 */
export function buildClaudeArgs(f: ClaudeFeatures, i: ClaudeArgInput): string[] {
  const a = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (f.partial) a.push('--include-partial-messages');
  if (i.model && i.model !== 'default') a.push('--model', i.model);
  if (i.sessionId) a.push('--resume', i.sessionId);
  if (i.systemFile && f.appendFile) a.push('--append-system-prompt-file', i.systemFile);
  else if (i.systemInline) a.push('--append-system-prompt', i.systemInline);
  a.push('--max-turns', String(i.maxTurns));
  if (i.effort && f.effort && EFFORTS.has(i.effort)) a.push('--effort', i.effort);
  const strict = !i.loadUserSettings && f.restricted;
  // The owner's own Claude Code context stays out unless the bot opts in: no user settings or claude.ai skills
  // (--setting-sources without "user"), no CLAUDE.md of the owner (claudeMdExcludes via --settings, which applies
  // under --restricted too). Auto-memory is switched off with CLAUDE_CODE_DISABLE_AUTO_MEMORY (runClaude).
  if (!i.loadUserSettings && f.settingSources) a.push('--setting-sources', 'project,local');
  if (!i.loadUserSettings && f.settings && i.cwd) a.push('--settings', JSON.stringify({ claudeMdExcludes: ownerMemoryExcludes(i.cwd, i.home ?? os.homedir()) }));
  const deny = [...i.disallowedTools];
  // "Internet" off in the bot editor: Claude Code's own web tools are off too (as for API bots without web tools).
  if (i.web === false) deny.push('WebFetch', 'WebSearch');
  const teambot = (i.teambotTools || []).filter((n) => /^[a-zA-Z0-9_-]{1,64}$/.test(n)).map((n) => `mcp__${MCP_SERVER_NAME}__${n}`);
  if (strict) a.push('--restricted');
  if (!i.useUserMcp || i.mode === 'chat') a.push('--strict-mcp-config');
  switch (i.mode) {
    case 'chat':
      if (f.tools) a.push('--tools', '');
      else deny.push('Bash', 'PowerShell', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Agent');
      a.push('--permission-mode', f.modes.includes('dontAsk') ? 'dontAsk' : 'plan');
      if (f.permissionPrompts) a.push('--permission-prompts', 'none');
      break;
    case 'readonly':
      a.push('--permission-mode', 'plan');
      if (f.permissionPrompts) a.push('--permission-prompts', 'none');
      deny.push('Bash', 'PowerShell', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit');
      // Only TeamBot tools the Broker allows in readonly (reads) are listed; no permission gate (nobody can approve).
      if (i.mcpConfigFile && teambot.length) a.push('--mcp-config', i.mcpConfigFile, '--allowedTools', teambot.join(','));
      break;
    case 'ask':
    case 'auto': {
      a.push('--permission-mode', i.mode === 'auto' && !i.gateEdits ? 'acceptEdits' : 'default');
      if (strict && f.tools) a.push('--tools', [...CLAUDE_BASE_TOOLS, ...(i.shell ? CLAUDE_SHELL_TOOLS : [])].join(','));
      if (!i.shell) deny.push('Bash', 'PowerShell');
      if (i.mcpConfigFile) a.push('--mcp-config', i.mcpConfigFile, '--permission-prompt-tool', PERMISSION_TOOL_FQN);
      if (f.permissionPrompts) a.push('--permission-prompts', 'host');
      const allow = [...i.allowedTools, ...(i.mcpConfigFile ? teambot : [])];
      if (allow.length) a.push('--allowedTools', allow.join(','));
      break;
    }
  }
  // Never Claude Code's own scheduling/cloud/messaging tools: they act outside TeamBot (e.g. cloud tasks in the
  // owner's claude.ai account via the "schedule" skill). TeamBot has its own routines, messages and notifications.
  if (i.mode !== 'chat') deny.push(...CLAUDE_OUTSIDE_TOOLS);
  if (deny.length) a.push('--disallowedTools', [...new Set(deny)].join(','));
  if (i.mode !== 'chat') for (const d of i.addDirs) a.push('--add-dir', d);
  a.push(...i.extraArgs);
  return a;
}

/** Old Claude Code without --append-system-prompt-file: an inline prompt of at most ~6000 characters, language rule kept last. */
export function shortSystem(system: string): string {
  const rule = languageSection(system);
  const body = rule ? system.replace(rule, '').trimEnd() : system;
  return withLanguage(body.slice(0, 5900 - rule.length) + ' …', rule || undefined);
}

const TOOL_RULE = /^[A-Za-z][\w-]{0,80}(\([^()\r\n]{0,200}\))?$/;
export function validToolRules(list: string[]): string[] {
  return list.filter((t) => TOOL_RULE.test(t) && !t.startsWith('mcp__teambot__'));
}

interface ParseState {
  text: string;
  reasoning: string;
  streamedMsgs: Set<string>;
  currentMsg: string | null;
  needSep: boolean;
  tools: Map<string, { name: string; title: string; item?: ActivityItem; sub?: boolean }>;
  result: any;
  sessionId?: string;
  initSeen: boolean;
  /** Context fill of the last top-level request (prompt incl. cache + output), for the context ring. */
  context?: number | null;
  model?: string;
}

/** Claude Code's own status words ("requesting", "compacting") in Dutch; anything unknown stays a calm "Bezig…". */
export function claudeStatusText(v: unknown): string {
  const s = String(v ?? '').trim().toLowerCase();
  if (/^(requesting|thinking|responding|streaming)$/.test(s)) return 'Denkt na…';
  if (/compact/.test(s)) return 'Vat het gesprek samen…';
  if (/retry/.test(s)) return 'Claude Code probeert het opnieuw…';
  return 'Bezig…';
}

/** Parse one stream-json line into AgentEvents. Exported for tests. */
export function handleClaudeLine(s: RunScope, st: ParseState, line: string) {
  let m: any;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  const top = !m.parent_tool_use_id;
  const pushText = (t: string) => {
    if (!t) return;
    if (st.needSep && st.text && !st.text.endsWith('\n\n')) {
      const sep = st.text.endsWith('\n') ? '\n' : '\n\n';
      st.text += sep;
      s.emit({ type: 'text', delta: sep });
    }
    st.needSep = false;
    st.text += t;
    s.emit({ type: 'text', delta: t });
  };
  switch (m.type) {
    case 'system':
      if (m.subtype === 'init') {
        st.initSeen = true;
        if (typeof m.model === 'string') st.model = m.model;
        if (m.session_id && m.session_id !== st.sessionId) {
          st.sessionId = m.session_id;
          s.emit({ type: 'session', sessionId: m.session_id });
        }
        s.activity('session', s.req.sessionId && m.session_id === s.req.sessionId ? 'Verder in het vorige Claude Code-gesprek' : 'Claude Code gestart', m.model ? `Model: ${prettyModel(m.model)}` : undefined);
      } else if (m.subtype === 'api_retry' || m.subtype === 'status') {
        s.emit({ type: 'status', text: m.subtype === 'api_retry' ? 'Claude Code probeert het opnieuw…' : claudeStatusText(m.status ?? m.message) });
      } else if (m.subtype === 'compact_boundary') {
        s.activity('compact', 'Context samengevat door Claude Code');
        const post = Number(m.compact_metadata?.post_tokens);
        if (post > 0) st.context = post;
      }
      break;
    case 'rate_limit_event': {
      // Claude's own usage window (5-hour / weekly …): kept per account, shown in the usage popover, notified near the limit.
      const r = parseClaudeRateLimitEvent(m);
      if (r) s.ctx.services?.usage?.report?.(s.cfg, r);
      break;
    }
    case 'stream_event': {
      if (!top) break;
      const ev = m.event || {};
      if (ev.type === 'message_start') {
        st.currentMsg = ev.message?.id || null;
        if (st.text) st.needSep = true;
      } else if (ev.type === 'content_block_delta') {
        if (st.currentMsg) st.streamedMsgs.add(st.currentMsg);
        if (ev.delta?.type === 'text_delta') pushText(ev.delta.text || '');
        else if (ev.delta?.type === 'thinking_delta') {
          st.reasoning += ev.delta.thinking || '';
          s.emit({ type: 'reasoning', delta: ev.delta.thinking || '' });
        }
      } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
        // the progress line in words ("Zoekt op internet…"), never the raw tool name
        const text = cliStatus(String(ev.content_block.name || ''), s.apps);
        if (text) s.emit({ type: 'status', text });
      }
      break;
    }
    case 'assistant': {
      const msg = m.message || {};
      const streamed = msg.id && st.streamedMsgs.has(msg.id);
      if (top) st.context = claudeContextFromUsage(msg.usage) ?? st.context;
      if (top && typeof msg.model === 'string' && !msg.model.startsWith('<')) st.model = msg.model;
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        if (b.type === 'text' && top && !streamed) {
          if (st.text) st.needSep = true;
          pushText(b.text || '');
        } else if (b.type === 'thinking' && top && !streamed && b.thinking) {
          st.reasoning += b.thinking;
          s.emit({ type: 'reasoning', delta: b.thinking });
        } else if (b.type === 'tool_use') {
          if (b.name === 'TodoWrite') {
            const steps = normalizePlan(b.input?.todos);
            if (steps) s.emit({ type: 'plan', steps });
          }
          // Plain words in the chat; the exact tool and input stay in approvals and logs. Until its result is in (often
          // after an approval card) the step says what the bot wants to do, not what it did ("Wil x schrijven").
          const title = cliActivity(b.name, b.input, s.apps);
          const pending = cliPending(b.name, b.input, s.apps);
          const item = title ? s.activity('tool', (top ? '' : 'Deeltaak · ') + (pending || title), undefined, cliFacts(b.name, b.input, s.apps)) : undefined;
          // A TeamBot tool: TeamBot reports its result on this same step (B-04).
          const own = `mcp__${MCP_SERVER_NAME}__`;
          if (item && String(b.name).startsWith(own)) s.teambotStep?.(String(b.name).slice(own.length), item);
          st.tools.set(b.id, { name: b.name, title: title || '', item, sub: !top });
        }
      }
      break;
    }
    case 'user': {
      const content = m.message?.content;
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type !== 'tool_result') continue;
        const t = st.tools.get(b.tool_use_id);
        const past = t?.title ? (t.sub ? 'Deeltaak · ' : '') + t.title : '';
        // A step that failed did not happen: it keeps the wish ("Wil x lezen"), a finished one says what it did.
        const failed = b.is_error && past ? failedStep(past) : null;
        if (t?.item) s.teambotStepDone?.(t.item);
        if (t?.item && past) s.retitle(t.item, failed ? failed.title : past);
        // Only failures get their own line; a successful step is already in the list. A TeamBot tool's step already
        // says "— mislukt" with TeamBot's own reason.
        if (!failed || (t?.item && s.isTeambotLine?.(t.item))) continue;
        const body = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((c: any) => (c.type === 'text' ? c.text : '')).join('\n') : '';
        s.activity('tool_error', failed.line.replace(/^Lukte niet: Deeltaak · /, 'Lukte niet: '), body ? claudeErrorText(body).slice(0, 400) : undefined);
      }
      break;
    }
    case 'result':
      st.result = m;
      if (m.session_id && m.session_id !== st.sessionId) {
        st.sessionId = m.session_id;
        s.emit({ type: 'session', sessionId: m.session_id });
      }
      if (Array.isArray(m.permission_denials) && m.permission_denials.length) {
        s.activity('denied', m.permission_denials.length === 1 ? '1 actie geweigerd' : `${m.permission_denials.length} acties geweigerd`, deniedWhat(m.permission_denials, s.apps));
      }
      break;
  }
}

export const ACCOUNT_NOTE =
  'Claude Code geeft je het e-mailadres van het Claude-account op deze computer (userEmail). Dat is de login van het abonnement, niet per se de persoon met wie je praat: gebruik het niet, noem het niet en leid er geen naam uit af (ook niet uit de naam van de gebruikersmap). Wat je over de gebruiker weet, komt alleen uit je instructies, het gesprek en het geheugen van TeamBot.';

/** For "Alleen chat" (no tools at all): without it Claude Code stalls when a request needs a tool. */
export const CHAT_ONLY_NOTE =
  'Je staat in de modus "Alleen chat": je hebt in dit gesprek geen enkele tool. Je kunt geen bestanden lezen of schrijven, geen opdrachten uitvoeren en niets op internet opzoeken. Schrijf nooit een tool-aanroep, ook niet als tekst of XML. Vraagt iemand om zoiets, zeg dan in gewone taal dat dat in deze modus niet kan en dat de eigenaar de bot een ruimere toegang kan geven.';

const NO_SESSION = /No conversation found|session .* not found|no such session|could not find session/i;

export interface ClaudeRunDeps {
  def: CliDef;
  bin: string;
  bridge: PermissionBridge;
  /** "subscription" → cost 0 (plan), "api" → CLI-reported cost counts. */
  billing(): Promise<'subscription' | 'api' | 'unknown'>;
  track(p: Proc): () => void;
}

export async function runClaude(s: RunScope, d: ClaudeRunDeps): Promise<AgentRunResult> {
  const { ctx, agent, req } = s;
  const f = await claudeFeatures(d.bin);
  const cwd = workdir(agent);
  const tmp = runTempDir(ctx.config.dataDir, req.runId);
  const atts = safeAttachments(agent, req.attachments);
  // "Volledige toegang" runs like auto in Claude Code; the Broker (gate) then lets the bot's normal actions through.
  const mode = agent.access_mode === 'full' ? 'auto' : agent.access_mode;
  let registration: BridgeRegistration | null = null;
  let proc: Proc | null = null;
  const gs: GateScope = {
    ctx,
    agent,
    thread: s.thread,
    run: s.run,
    userId: req.userId,
    signal: s.signal,
    ns: d.def.id,
    hold: (on) => proc?.hold(on),
    onActivity: (title, detail) => s.activity('permission', title, detail),
  };
  try {
    let mcpConfigFile: string | undefined;
    let toolNames: string[] = [];
    let system = req.system;
    if (mode !== 'chat') {
      const gated = mode === 'ask' || mode === 'auto';
      const tools = teambotTools(s, { engine: 'claude', hold: (on) => proc?.hold(on) });
      toolNames = await tools.names();
      if (gated || toolNames.length) {
        await d.bridge.ensure();
        const permission = gated
          ? async (pr: { tool_name: string; input: any }): Promise<PermissionDecision> => {
              if (pr.tool_name === PERMISSION_TOOL_FQN) return { behavior: 'deny', message: 'Interne TeamBot-tool; niet zelf aanroepen.' };
              const input = pr.input ?? {};
              // TeamBot's own tools are gated inside TeamBot (Broker, tool policy, approvals) when they run.
              if (pr.tool_name.startsWith(`mcp__${MCP_SERVER_NAME}__`)) return { behavior: 'allow', updatedInput: input };
              const risk = claudeToolRisk(pr.tool_name, input);
              const g = await gate(gs, {
                tool: pr.tool_name,
                risk,
                summary: claudeToolSummary(pr.tool_name, input, cwd),
                input,
                paths: pathsOf(input),
                url: pr.tool_name === 'WebFetch' ? input.url : undefined,
                command: commandOf(input),
              });
              return g.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: g.message };
            }
          : undefined;
        registration = d.bridge.register({ permission, tools: toolNames.length ? tools : undefined }, tmp.dir);
        mcpConfigFile = path.join(tmp.dir, 'mcp.json');
        fs.writeFileSync(mcpConfigFile, JSON.stringify(d.bridge.mcpConfig(registration, { permission: gated, tools: toolNames.length > 0 })), { mode: 0o600 });
        if (toolNames.length) system += '\n\n' + toolsNote(toolNames, 'claude');
      }
    }
    // Claude Code adds the e-mail address of its login to every session (no switch for it in 2.1.x): that is the
    // owner's subscription, not who the bot talks to, so it must not become the user's name in the chat or in memory.
    if (!s.opts.loadUserSettings) system += '\n\n' + ACCOUNT_NOTE;
    // "Alleen chat" runs with --tools "": asked to write a file, Claude Code 2.1 then stalls after its thinking
    // (acceptance round 3, A-16: "<invoke name=\"Write\">" as text, no answer until the idle limit). Saying plainly that
    // there are no tools makes it answer in words.
    if (mode === 'chat') system += '\n\n' + CHAT_ONLY_NOTE;
    system = withLanguage(system);
    const systemFile = path.join(tmp.dir, 'system.md');
    fs.writeFileSync(systemFile, system, { mode: 0o600 });
    const extra = checkExtraArgs(d.def, s.opts.extraArgs);
    // Every folder is an --add-dir: with --restricted, Claude Code refuses any file outside its working directories
    // without asking, so a read-only folder that is left out cannot even be read. Edits in an --add-dir are
    // auto-accepted in acceptEdits, so when a read-only folder is present "auto" uses the normal mode (gateEdits):
    // each edit then reaches the permission gate, which refuses writes in read-only folders.
    const roots = extraRootsOf(agent);
    const gateEdits = (mode === 'ask' || mode === 'auto') && roots.length > extraRootsOf(agent, { writableOnly: true }).length;

    const attempt = async (sessionId: string | undefined, transcript: string): Promise<{ st: ParseState; exit: { code: number | null; error?: string }; stderr: string; killed: string | null }> => {
      const args = buildClaudeArgs(f, {
        mode,
        model: req.model,
        sessionId,
        systemFile,
        systemInline: f.appendFile ? undefined : system.length <= 6000 ? system : shortSystem(system),
        mcpConfigFile,
        teambotTools: toolNames,
        maxTurns: s.opts.maxTurns,
        // Only a level this model takes (e.g. no xhigh on Opus 4.6), see providers/capabilities.ts.
        effort: clampEffort(claudeInfo(req.model || 'default')?.reasoningLevels, req.reasoning),
        addDirs: roots,
        gateEdits,
        allowedTools: mode === 'ask' || mode === 'auto' ? validToolRules(s.opts.allowedTools) : [],
        disallowedTools: validToolRules(s.opts.disallowedTools),
        extraArgs: extra,
        loadUserSettings: s.opts.loadUserSettings,
        useUserMcp: s.opts.useUserMcp,
        shell: ctx.tools.groupEnabled(agent, 'shell'),
        web: ctx.tools.groupEnabled(agent, 'web'),
        cwd,
      });
      const st: ParseState = { text: '', reasoning: '', streamedMsgs: new Set(), currentMsg: null, needSep: false, tools: new Map(), result: null, sessionId, initSeen: false, context: null };
      proc = startProc({
        bin: d.bin,
        args,
        cwd,
        env: { MCP_TOOL_TIMEOUT: String(24 * 3600 * 1000), NO_COLOR: '1', ...(s.opts.loadUserSettings ? {} : { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }) },
        signal: s.signal,
        timeoutMs: s.opts.timeoutMin * 60_000,
        idleMs: s.opts.idleMin * 60_000,
        onLine: (l) => handleClaudeLine(s, st, l),
      });
      const untrack = d.track(proc);
      proc.write(transcript + req.prompt + attachmentNote(atts));
      proc.end();
      const exit = await proc.done;
      untrack();
      return { st, exit, stderr: proc.stderrTail(), killed: proc.killedReason };
    };

    let transcript = '';
    if (!req.sessionId) {
      const t = earlierTranscript(ctx, agent, req.threadId, s.run?.input_message_id);
      if (t.count) {
        transcript = t.text;
        s.activity('session', 'Nieuwe sessie met eerdere context', t.count === 1 ? '1 eerder bericht uit deze chat meegegeven' : `${t.count} eerdere berichten uit deze chat meegegeven`);
      }
    }
    let r = await attempt(req.sessionId, transcript);
    if (req.sessionId && !s.signal.aborted && !r.st.initSeen && NO_SESSION.test(r.stderr + JSON.stringify(r.st.result || ''))) {
      const t = earlierTranscript(ctx, agent, req.threadId, s.run?.input_message_id);
      s.activity('session', 'Vorige Claude Code-sessie niet gevonden — nieuwe sessie gestart', t.count === 1 ? '1 eerder bericht meegegeven als context' : t.count ? `${t.count} eerdere berichten meegegeven als context` : undefined);
      r = await attempt(undefined, t.text);
    }
    if (s.signal.aborted) throw new Error('Gestopt');
    const res = r.st.result;
    const usage: Usage = { input: 0, output: 0 };
    if (res?.usage) {
      const u = res.usage;
      usage.cacheRead = Number(u.cache_read_input_tokens) || 0;
      usage.input = (Number(u.input_tokens) || 0) + usage.cacheRead + (Number(u.cache_creation_input_tokens) || 0);
      usage.output = Number(u.output_tokens) || 0;
    }
    const billing = await d.billing();
    usage.cost = billing === 'api' && typeof res?.total_cost_usd === 'number' ? res.total_cost_usd : 0;
    // Claude Code prices every run at list price (costBasis "list"), also on a subscription: the estimated value.
    if (typeof res?.total_cost_usd === 'number') usage.value = res.total_cost_usd;
    if (r.st.context) s.ctx.services?.usage?.setContext?.(req.threadId, agent.id, { used: r.st.context, window: claudeContextWindow(res, r.st.model), engine: d.def.label, providerId: s.cfg.id });
    const text = r.st.text || (typeof res?.result === 'string' ? res.result : '');
    if (r.killed) return { text, usage, sessionId: r.st.sessionId, error: r.killed };
    if (!res) {
      const why = r.exit.error || `exitcode ${r.exit.code}`;
      const hint = authHint(r.stderr, d.def.login);
      return { text, usage, sessionId: r.st.sessionId, error: hint || `Claude Code stopte onverwacht (${why}).${lastOutput(r.stderr) ? ' Laatste uitvoer: ' + lastOutput(r.stderr, 600) : ''}` };
    }
    if (res.subtype === 'error_max_turns') {
      const turns = res.num_turns ?? s.opts.maxTurns;
      s.activity('max_turns', turns === 1 ? 'Gestopt na 1 stap (maximum)' : `Gestopt na ${turns} stappen (maximum)`, 'Stuur een bericht om verder te gaan.');
      return { text, usage, sessionId: r.st.sessionId, model: r.st.model };
    }
    if (res.is_error || String(res.subtype || '').startsWith('error')) {
      const raw = [typeof res.result === 'string' ? res.result : '', ...(Array.isArray(res.errors) ? res.errors.map(String) : [])].filter(Boolean).join(' — ') || res.subtype || 'onbekende fout';
      const limit = /usage limit|rate limit|limit reached|out of extra usage/i.test(raw) ? 'Gebruikslimiet van je Claude-abonnement of account bereikt. Probeer het later opnieuw. ' : '';
      return { text: r.st.text, usage, sessionId: r.st.sessionId, error: authHint(raw, d.def.login) || limit + redact(readableReset(raw)).slice(0, 1500) };
    }
    // The model Claude Code really used ("opus" or the default resolve to a full id), shown under the answer.
    return { text, usage, sessionId: r.st.sessionId, model: r.st.model };
  } finally {
    registration?.dispose();
    tmp.cleanup();
  }
}
