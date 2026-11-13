import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clampEffort, claudeInfo } from '../../providers/capabilities.js';
import { headAndTail, type ActivityItem, type AgentRunResult, type Usage } from '../../core/types.js';
import { redact } from '../../core/secrets.js';
import { extraRootsOf, fullAccess, wholeComputer } from '../../tools/builtin/files.js';
import { runQuick, runTempDir, startProc, type Proc } from './proc.js';
import { authHint, lastOutput, contextState, earlierTranscript, safeAttachments, attachmentNote, languageSection, ownSkillLoader, sessionUpdate, skillUsed, withLanguage, workdir, type RunScope, type SessionContext } from './context.js';
import { appToolImpact, claudeToolRisk, claudeToolSummary, commandOf, gate, pathsOf, type GateScope } from './permissions.js';
import { appsOff, discoverClaudeApps, knownApps, recordClaudeInit } from './engine-apps.js';
import { claudeErrorText, cliActivity, cliFacts, cliPending, cliStatus, deniedWhat, failedStep } from './activity-labels.js';
import { MCP_SERVER_NAME, PERMISSION_TOOL_FQN, type BridgeRegistration, type PermissionBridge, type PermissionDecision } from './bridge.js';
import { teambotTools, toolsNote } from './toolhost.js';
import { checkExtraArgs, type CliDef } from './catalog.js';
import { claudeContextFromUsage, claudeContextWindow, claudeUsage, noteClaudeCall, parseClaudeRateLimitEvent } from '../usage/parse.js';
import { withUsage } from '../../agent/budget.js';
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
  /** This Claude Code loads skill folders by itself, also from a plugin folder (`--plugin-dir`). */
  skills?: boolean;
  /** `--no-session-persistence`: a `-p` call writes no session of its own under the user's `~/.claude/projects`. */
  noSession?: boolean;
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
    skills: /--plugin-dir\b/.test(h) && /\bskills\b/i.test(h),
    noSession: /--no-session-persistence\b/.test(h),
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
  /**
   * "Volledige toegang": the terminal is always there and Claude Code's own tools are the bot's too (only the ones in
   * CLAUDE_KEPT_OUT stay off).
   */
  full?: boolean;
  /**
   * "Volledige toegang" on the whole computer (files.ts wholeComputer): never `--restricted`, which would confine the
   * file tools to the working folders. Everything outside them reaches TeamBot's permission gate, which lets it through
   * except key files, closed folders and TeamBot's own data.
   */
  whole?: boolean;
  /** Folders and files that stay shut on the whole computer: deny rules for Claude Code's own file tools (see claudeDenyRules). */
  denyPaths?: string[];
  /** The owner's own CLAUDE.md files too (explicit `cli.loadUserSettings: true`); default: follows loadUserSettings. */
  ownerMemory?: boolean;
  /**
   * The bot's skills as a plugin folder of TeamBot (modules/skills/workspace.ts). Restricted mode skips the skill
   * folders in the work folder; a plugin folder it does load.
   */
  pluginDir?: string;
  /**
   * The engine's own apps (engine-apps.ts) by id, as in their tool names (mcp__<id>__…). `appsGated`: an ask rule for
   * each, so every call reaches the permission gate even where the owner's own Claude Code settings allow it without
   * asking (an ask rule beats an allow rule; checked on Claude Code 2.1.322). `appsOff`: switched off for this bot.
   */
  appsGated?: string[];
  appsOff?: string[];
  /**
   * Of those switched off, the servers Claude Code can leave out entirely by name (`deniedMcpServers`: not started,
   * no tools and no instructions; checked on 2.1.322). A claude.ai connector has a name Claude Code cannot match there;
   * all of them at once go out with ENABLE_CLAUDEAI_MCP_SERVERS (runClaude).
   */
  appsOffServers?: string[];
}

/** Restricted mode (`--restricted`): for every bot that neither brings the owner's own settings nor has the whole computer. */
export function claudeStrict(f: ClaudeFeatures, i: Pick<ClaudeArgInput, 'loadUserSettings' | 'whole'>): boolean {
  return !i.loadUserSettings && f.restricted && !i.whole;
}

/**
 * Deny rules (settings `permissions.deny`) for paths that stay shut on "Volledige toegang": Claude Code refuses them
 * itself for Read/Edit/Write and for the file commands it recognises in Bash, before anything else is asked. A second
 * lock next to TeamBot's gate, which also holds when the owner's own settings allow a tool without asking. An absolute
 * path in a rule starts with `//`; on Windows as `//c/Users/…`.
 */
export function claudeDenyRules(paths: string[]): string[] {
  const out: string[] = [];
  for (const raw of paths) {
    if (typeof raw !== 'string' || !path.isAbsolute(raw)) continue;
    const p = path.resolve(raw).replace(/\\/g, '/');
    const m = p.match(/^([A-Za-z]):\/(.*)$/);
    const abs = (m ? `//${m[1].toLowerCase()}/${m[2]}` : `/${p}`).replace(/\/+$/, '');
    if (/[()\r\n]/.test(abs) || abs.length < 4) continue;
    for (const tool of ['Read', 'Edit']) out.push(`${tool}(${abs})`, `${tool}(${abs}/**)`);
  }
  return [...new Set(out)];
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
/**
 * Still off on "Volledige toegang", because they break TeamBot's own run management instead of limiting the bot: a
 * TeamBot turn is one `claude -p` process that ends with the answer, so a timer or wake-up set inside it never fires
 * (CronCreate, CronDelete, CronList, ScheduleWakeup, the "loop" skill), and RemoteTrigger and the "schedule" skill start
 * work in the owner's claude.ai cloud account that TeamBot cannot see, stop or show. The bot plans with TeamBot routines.
 */
export const CLAUDE_KEPT_OUT = ['RemoteTrigger', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'Skill(schedule)', 'Skill(loop)'];
/** Claude Code tools that reach outside TeamBot (cloud schedules, other sessions, push, workflows): denied below "Volledige toegang". */
export const CLAUDE_OUTSIDE_TOOLS = [
  'RemoteTrigger', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'PushNotification', 'SendMessage', 'ListAgents',
  'Workflow', 'DesignSync', 'Monitor', 'TaskStop', 'EnterWorktree', 'ExitWorktree', 'ReportFindings', 'Skill(schedule)', 'Skill(loop)',
];

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** Key folders in the owner's home folder that exist (deny rules for folders that are not there only add noise). */
function keyFolders(home: string): string[] {
  return ['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.password-store', '.config/gh', '.config/gcloud', '.git-credentials', '.claude/.credentials.json', '.codex/auth.json']
    .map((p) => path.join(home, ...p.split('/')))
    .filter((p) => fs.existsSync(p));
}

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
  const strict = claudeStrict(f, i);
  const shell = !!i.shell || !!i.full;
  // The owner's own Claude Code context stays out unless the bot opts in: no user settings or claude.ai skills
  // (--setting-sources without "user"), no CLAUDE.md of the owner (claudeMdExcludes via --settings, which applies
  // under --restricted too). Auto-memory is switched off with CLAUDE_CODE_DISABLE_AUTO_MEMORY (runClaude).
  if (!i.loadUserSettings && f.settingSources) a.push('--setting-sources', 'project,local');
  const settings: Record<string, any> = {};
  if (!(i.ownerMemory ?? i.loadUserSettings) && i.cwd) settings.claudeMdExcludes = ownerMemoryExcludes(i.cwd, i.home ?? os.homedir());
  const shut = i.whole && i.mode !== 'chat' ? claudeDenyRules(i.denyPaths || []) : [];
  if (shut.length) settings.permissions = { deny: shut };
  // The engine's own apps go through TeamBot's gate wherever there is one (asking and automatic modes, with the
  // permission prompt tool): the gate lets reading and drafts through and asks before anything is sent to others.
  const appRule = (id: string) => (/^[A-Za-z0-9_-]{1,100}$/.test(id) ? `mcp__${id}` : '');
  const gatedApps = (i.mode === 'ask' || i.mode === 'auto') && i.useUserMcp && i.mcpConfigFile ? (i.appsGated || []).map(appRule).filter(Boolean) : [];
  if (gatedApps.length) settings.permissions = { ...settings.permissions, ask: gatedApps };
  const offServers = i.useUserMcp && i.mode !== 'chat' ? (i.appsOffServers || []).filter((n) => /^[a-zA-Z0-9_-]{1,100}$/.test(n) && n !== MCP_SERVER_NAME) : [];
  if (offServers.length) settings.deniedMcpServers = offServers.map((serverName) => ({ serverName }));
  if (i.pluginDir && i.mode !== 'chat') {
    a.push('--plugin-dir', i.pluginDir);
    // A skill is instructions: a line in it that Claude Code would run while loading the skill is never run.
    settings.disableSkillShellExecution = true;
  }
  if (f.settings && Object.keys(settings).length) a.push('--settings', JSON.stringify(settings));
  const deny = [...i.disallowedTools];
  // "Internet" off in the bot editor: Claude Code's own web tools are off too (as for API bots without web tools).
  if (i.web === false) deny.push('WebFetch', 'WebSearch');
  // An app of the engine that the owner switched off for this bot: its tools are not in the bot's list at all.
  if (i.useUserMcp && i.mode !== 'chat') deny.push(...(i.appsOff || []).map(appRule).filter(Boolean));
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
      if (strict && f.tools) a.push('--tools', [...CLAUDE_BASE_TOOLS, ...(shell ? CLAUDE_SHELL_TOOLS : [])].join(','));
      if (!shell) deny.push('Bash', 'PowerShell');
      if (i.mcpConfigFile) a.push('--mcp-config', i.mcpConfigFile, '--permission-prompt-tool', PERMISSION_TOOL_FQN);
      if (f.permissionPrompts) a.push('--permission-prompts', 'host');
      const allow = [...i.allowedTools, ...(i.mcpConfigFile ? teambot : [])];
      if (allow.length) a.push('--allowedTools', allow.join(','));
      break;
    }
  }
  // Never Claude Code's own scheduling/cloud/messaging tools: they act outside TeamBot (e.g. cloud tasks in the
  // owner's claude.ai account via the "schedule" skill). TeamBot has its own routines, messages and notifications.
  if (i.mode !== 'chat') deny.push(...(i.full ? CLAUDE_KEPT_OUT : CLAUDE_OUTSIDE_TOOLS));
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
  tools: Map<string, { name: string; title: string; item?: ActivityItem; sub?: boolean; skill?: string }>;
  /** Tool calls whose result is not in yet: while there is one, the CLI is working, however silent (proc.ts busy). */
  open?: Set<string>;
  result: any;
  sessionId?: string;
  initSeen: boolean;
  /** Context fill of the last top-level request (prompt incl. cache + output), for the context ring. */
  context?: number | null;
  model?: string;
  /** What each model call of this turn reported on the way: what a stopped turn used (usage/parse.ts). */
  calls?: Map<string, any>;
  /** The init message (servers and tools Claude Code loaded). */
  onInit?(m: any): void;
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
        st.onInit?.(m);
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
        noteClaudeCall((st.calls ??= new Map()), st.currentMsg, ev.message?.usage);
        if (st.text) st.needSep = true;
      } else if (ev.type === 'message_delta') {
        noteClaudeCall((st.calls ??= new Map()), st.currentMsg, ev.usage);
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
      noteClaudeCall((st.calls ??= new Map()), msg.id, msg.usage);
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
          st.tools.set(b.id, { name: b.name, title: title || '', item, sub: !top, skill: b.name === 'Skill' ? String(b.input?.skill || b.input?.name || '') : undefined });
          st.open?.add(b.id);
        }
      }
      break;
    }
    case 'user': {
      const content = m.message?.content;
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type !== 'tool_result') continue;
        st.open?.delete(b.tool_use_id);
        const t = st.tools.get(b.tool_use_id);
        // Claude Code loaded a skill from its folder by itself: counted where skill_load counts (modules/skills).
        if (t?.skill && !b.is_error) skillUsed(s, t.skill);
        const past = t?.title ? (t.sub ? 'Deeltaak · ' : '') + t.title : '';
        // A step that failed did not happen: it keeps the wish ("Wil x lezen"), a finished one says what it did.
        const failed = b.is_error && past ? failedStep(past) : null;
        const body = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((c: any) => (c.type === 'text' ? c.text : '')).join('\n') : '';
        // What a command printed stays on its step: the second look reads it as what the bot really saw.
        if (t?.item && !failed && /^(Bash|PowerShell)$/.test(t.name) && body.trim()) t.item.out = redact(headAndTail(body, 900));
        if (t?.item) s.teambotStepDone?.(t.item);
        if (t?.item && past) s.retitle(t.item, failed ? failed.title : past);
        // Only failures get their own line; a successful step is already in the list. A TeamBot tool's step already
        // says "— mislukt" with TeamBot's own reason.
        if (!failed || (t?.item && s.isTeambotLine?.(t.item))) continue;
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

/**
 * A bot with colleagues gives work to them with TeamBot's delegate_task or ask_bot, never to Claude Code's own
 * subagents (Task/Agent): those are nameless copies of itself that the owner cannot see, steer or stop in TeamBot, that
 * have no memory or role, and whose work never reaches the colleague it belongs to. So those two tools are off then.
 */
export const CLAUDE_SUBAGENT_TOOLS = ['Task', 'Agent'];
export const COLLEAGUES_NOTE = 'De eigen subagents van Claude Code (Task, Agent) staan uit: werk voor een ander geef je aan een collega-bot met delegate_task, want alleen dat ziet de eigenaar.';
/** True when this bot can hand work to another bot of its owner (it has delegate_task and there is someone to give it to). */
export function hasColleagues(ctx: { store: { agents(userId: string): { id: string; archived?: boolean }[] } }, agent: { id: string; user_id: string }, toolNames: string[]): boolean {
  if (!toolNames.includes('delegate_task')) return false;
  try {
    return ctx.store.agents(agent.user_id).some((a) => a.id !== agent.id && !a.archived);
  } catch {
    return false;
  }
}

export const ACCOUNT_NOTE =
  'Het e-mailadres dat Claude Code je geeft (userEmail) is de login van het abonnement op deze computer, niet per se de persoon met wie je praat: gebruik en noem het niet en leid er geen naam uit af, ook niet uit de naam van de gebruikersmap.';

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
  /** What this session was last given of the instructions (context.ts): a resumed session gets what changed since. */
  context?: SessionContext;
}

export async function runClaude(s: RunScope, d: ClaudeRunDeps): Promise<AgentRunResult> {
  const { ctx, agent, req } = s;
  const f = await claudeFeatures(d.bin);
  const cwd = workdir(agent);
  const tmp = runTempDir(ctx.config.dataDir, req.runId);
  const atts = safeAttachments(agent, req.attachments);
  // "Volledige toegang" runs like auto in Claude Code; the Broker (gate) then lets the bot's normal actions through.
  const mode = agent.access_mode === 'full' ? 'auto' : agent.access_mode;
  const full = fullAccess(agent);
  // The whole computer: Claude Code's own tools work everywhere; what stays shut is refused by the gate and by deny rules.
  const whole = wholeComputer(agent);
  // The engine's own apps (the owner's claude.ai connectors, his MCP servers): through the gate, minus what is off for this bot.
  const off = appsOff(agent);
  let known = s.opts.useUserMcp ? knownApps(ctx.config.dataDir, s.cfg.id) : [];
  // The very first run on this connection: ask Claude Code which apps it has, so this run already gates them too.
  if (s.opts.useUserMcp && !known.length && (mode === 'ask' || mode === 'auto')) known = await discoverClaudeApps(ctx.config.dataDir, s.cfg.id, d.bin, cwd).catch(() => []);
  const ownApps = known.map((a) => a.id);
  // Switched off for this bot = gone from its runs: a server by name, and the claude.ai connectors when every one is off.
  const offApps = known.filter((a) => off.includes(a.id));
  const connectors = known.filter((a) => a.source === 'claudeai');
  const noConnectors = s.opts.useUserMcp && connectors.length > 0 && connectors.every((a) => off.includes(a.id));
  const dataDir = path.resolve(ctx.config.dataDir).toLowerCase();
  const denyPaths = whole ? [...whole.closed.filter((c) => path.resolve(c).toLowerCase() !== dataDir), ...keyFolders(os.homedir())] : [];
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
    // Claude Code loads the skill folders in the work folder itself (context.ts ownSkillLoader). Its restricted mode
    // skips them, so there the same skills go along as a plugin folder. For the modes this was shown in with a real
    // run (asking, automatic, full access); read-only and chat keep TeamBot's own list.
    let pluginDir: string | undefined;
    if ((mode === 'ask' || mode === 'auto') && f.skills) {
      const strict = claudeStrict(f, { loadUserSettings: s.opts.loadUserSettings, whole: !!whole });
      ({ system, pluginDir } = ownSkillLoader(s, system, { pluginInto: path.join(tmp.dir, 'skills'), skipsWorkFolder: strict }));
    }
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
                // An app of the owner (an MCP server) can send or pay; Claude Code's own tools work on this computer.
                impact: commandOf(input) ? undefined : pr.tool_name.startsWith('mcp__') ? appToolImpact(pr.tool_name) : 'local',
              });
              return g.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: g.message };
            }
          : undefined;
        registration = d.bridge.register({ permission, tools: toolNames.length ? tools : undefined }, tmp.dir);
        mcpConfigFile = path.join(tmp.dir, 'mcp.json');
        fs.writeFileSync(mcpConfigFile, JSON.stringify(d.bridge.mcpConfig(registration, { permission: gated, tools: toolNames.length > 0 })), { mode: 0o600 });
        if (toolNames.length) system += '\n\n' + toolsNote(toolNames, 'claude', { full });
      }
    }
    // Claude Code adds the e-mail address of its login to every session (no switch for it in 2.1.x): that is the
    // owner's subscription, not who the bot talks to, so it must not become the user's name in the chat or in memory.
    if (!s.opts.ownerMemory) system += '\n\n' + ACCOUNT_NOTE;
    const colleagues = mode !== 'chat' && hasColleagues(s.ctx, agent, toolNames);
    if (colleagues) system += '\n\n' + COLLEAGUES_NOTE;
    // "Alleen chat" runs with --tools "": asked to write a file, Claude Code 2.1 then stalls after its thinking
    // (acceptance round 3, A-16: "<invoke name=\"Write\">" as text, no answer until the idle limit). Saying plainly that
    // there are no tools makes it answer in words.
    if (mode === 'chat') system += '\n\n' + CHAT_ONLY_NOTE;
    system = withLanguage(system);
    const systemFile = path.join(tmp.dir, 'system.md');
    fs.writeFileSync(systemFile, system, { mode: 0o600 });
    // For a live check of what the model was told (tests/e2e): keep a copy of the last system prompt per bot.
    if (process.env.TEAMBOT_DEBUG_SYSTEM) {
      try {
        fs.writeFileSync(path.join(process.env.TEAMBOT_DEBUG_SYSTEM, `system-${s.agent.id}.md`), system);
      } catch {
        /* only a diagnostic */
      }
    }
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
        disallowedTools: [...validToolRules(s.opts.disallowedTools), ...(colleagues ? CLAUDE_SUBAGENT_TOOLS : [])],
        extraArgs: extra,
        loadUserSettings: s.opts.loadUserSettings,
        useUserMcp: s.opts.useUserMcp,
        shell: full || ctx.tools.groupEnabled(agent, 'shell'),
        web: full || ctx.tools.groupEnabled(agent, 'web'),
        cwd,
        full,
        whole: !!whole,
        denyPaths,
        ownerMemory: s.opts.ownerMemory,
        pluginDir,
        appsGated: ownApps,
        appsOff: off,
        appsOffServers: offApps.filter((a) => a.source !== 'claudeai').map((a) => a.name),
      });
      const st: ParseState = { text: '', reasoning: '', streamedMsgs: new Set(), currentMsg: null, needSep: false, tools: new Map(), open: new Set(), result: null, sessionId, initSeen: false, context: null };
      // What Claude Code loaded of its own (servers, tools): shown on the bot page as the bot's apps (engine-apps.ts).
      if (s.opts.useUserMcp) st.onInit = (m) => recordClaudeInit(ctx.config.dataDir, s.cfg.id, m, off);
      proc = startProc({
        bin: d.bin,
        args,
        cwd,
        // Claude Code stops its own Bash/PowerShell step after 2 minutes, and never lets it run longer than 10: a build
        // or a test run died there. Ten minutes by default, and the bot may ask up to a day for one command.
        env: { MCP_TOOL_TIMEOUT: String(24 * 3600 * 1000), BASH_DEFAULT_TIMEOUT_MS: String(10 * 60_000), BASH_MAX_TIMEOUT_MS: String(24 * 3600 * 1000), NO_COLOR: '1', ...(s.opts.ownerMemory ? {} : { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }), ...(noConnectors ? { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } : {}) },
        signal: s.signal,
        timeoutMs: s.opts.timeoutMin * 60_000,
        idleMs: s.opts.idleMin * 60_000,
        busy: () => st.open!.size > 0,
        busyIdleMs: s.opts.busyIdleMin * 60_000,
        onLine: (l) => handleClaudeLine(s, st, l),
      });
      const untrack = d.track(proc);
      // A new session reads the instructions from the system prompt file. A resumed one keeps the system prompt it was
      // started with (Claude Code records it per conversation), so what changed since goes in with the turn, as for
      // Codex and ACP (context.ts).
      proc.write((sessionId ? sessionUpdate(s, d.context, system) : '') + transcript + req.prompt + attachmentNote(atts));
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
    const res = r.st.result;
    // The turn's numbers from its result line; without one (stopped, crashed) what its model calls reported on the way.
    const usage: Usage = claudeUsage(res?.usage ? [res.usage] : r.st.calls?.values() || []);
    const billing = await d.billing();
    usage.cost = billing === 'api' && typeof res?.total_cost_usd === 'number' ? res.total_cost_usd : 0;
    // Claude Code prices every run at list price (costBasis "list"), also on a subscription: the estimated value.
    if (typeof res?.total_cost_usd === 'number') usage.value = res.total_cost_usd;
    // Stopped: what it used so far goes along and is counted (agent/budget.ts; on a pay-per-use key it prices it).
    if (s.signal.aborted) throw withUsage(new Error('Gestopt'), billing === 'api' && typeof res?.total_cost_usd !== 'number' ? { ...usage, cost: undefined } : usage, r.st.model);
    if (r.st.context) s.ctx.services?.usage?.setContext?.(req.threadId, agent.id, { used: r.st.context, window: claudeContextWindow(res, r.st.model), engine: d.def.label, providerId: s.cfg.id });
    const text = r.st.text || (typeof res?.result === 'string' ? res.result : '');
    if (r.killed) return { text, usage, sessionId: r.st.sessionId, error: r.killed };
    if (!res) {
      const why = r.exit.error || `exitcode ${r.exit.code}`;
      const hint = authHint(r.stderr, d.def.login);
      return { text, usage, sessionId: r.st.sessionId, error: hint || `Claude Code stopte onverwacht (${why}).${lastOutput(r.stderr) ? ' Laatste uitvoer: ' + lastOutput(r.stderr, 600) : ''}` };
    }
    // A turn that ended well: this session now has these instructions (a failed turn gets the update again).
    if (r.st.sessionId && !(res.is_error || (String(res.subtype || '').startsWith('error') && res.subtype !== 'error_max_turns'))) d.context?.save(r.st.sessionId, contextState(system));
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
