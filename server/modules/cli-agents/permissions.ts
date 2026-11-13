import path from 'node:path';
import type { Agent, Ctx, Run, Thread, ToolImpact, ToolRisk } from '../../core/types.js';
import { fullAccess, shutFolders, wholeComputer } from '../../tools/builtin/files.js';
import type { CodexReadGuard } from './codex-sandbox.js';
import { shellCommandImpact as commandImpact, shellCommandRisk as commandRisk } from '../../tools/builtin/command-risk.js';
import { passGate } from '../../tools/gate.js';
import { redact } from '../../core/secrets.js';
import { approvalWhat } from '../../../shared/approvalLabels.js';
import { ownerOnlyText, sharedRunOf } from '../../agent/shared.js';

/**
 * The way in to the permission gate for a CLI engine's own tools. Every approval request a CLI makes (Claude Code
 * permission prompt, ACP session/request_permission, Codex app-server approval) is written down here as a step
 * (which tool, its risk, the folders, the website and the command it names) and handed to the one gate that also
 * decides the tool calls of API models (tools/gate.ts). Nothing is decided in this file.
 */

// Which shell commands ask a human and which count as "to others" is decided in ONE place, for TeamBot's own terminal
// tool and for every CLI engine alike: tools/builtin/command-risk.ts.
export { commandRisk, commandImpact };

/** A tool of an app the engine is connected to itself (an MCP server in its own settings), named the way Claude Code names it. */
export const isAppTool = (tool: string) => /^mcp__/.test(tool);

/** "mcp__claude_ai_Gmail__send_message" → { app: "claude_ai_Gmail", tool: "send_message" }. */
export function appToolParts(tool: string): { app: string; tool: string } | null {
  const m = /^mcp__([^_].*?)__(.+)$/.exec(tool);
  return m ? { app: m[1], tool: m[2] } : null;
}

/** "claude_ai_Gmail" → "Gmail", "github" → "github": the name the owner knows an app of his engine by. */
export const appLabel = (app: string) => app.replace(/^claude_ai_/i, '').replace(/[-_]+/g, ' ').trim() || app;

/** Fields that name the people a call reaches (a mail, a message, an invitation). */
const RECIPIENT_FIELD = /^(to|cc|bcc|recipients?|attendees|invitees|guests|participants|members)$/i;

/** The people this input names (one level deep), e.g. ["a@example.com"]; [] when it names nobody. */
export function recipientsOf(input: any): string[] {
  const out: string[] = [];
  const add = (v: any) => {
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
    else if (Array.isArray(v)) v.forEach(add);
    else if (v && typeof v === 'object') add(v.email ?? v.address ?? v.id);
  };
  const scan = (o: any) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    for (const [k, v] of Object.entries(o)) if (RECIPIENT_FIELD.test(k)) add(v);
  };
  scan(input);
  if (input && typeof input === 'object') for (const v of Object.values(input)) if (v && typeof v === 'object' && !Array.isArray(v)) scan(v);
  return [...new Set(out)].slice(0, 20);
}

/** "createDraft", "send-message" → ["create", "draft"], ["send", "message"]. */
const nameWords = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** A tool that starts like this only looks something up (get_thread, search_threads, list_events, find_free_time …). */
const READ_START = new Set(['get', 'list', 'search', 'read', 'fetch', 'query', 'find', 'lookup', 'look', 'view', 'show', 'count', 'describe', 'preview', 'export', 'download', 'guide', 'help', 'whoami', 'check', 'ask']);
/** Words that make a call act: it changes, sends or runs something, whatever it starts with ("get_and_delete"). */
const ACTS = new Set(['create', 'update', 'edit', 'modify', 'set', 'add', 'insert', 'upload', 'save', 'move', 'rename', 'put', 'patch', 'replace', 'write', 'append', 'archive', 'apply', 'import', 'copy', 'schedule', 'book', 'assign', 'enable', 'disable', 'start', 'stop', 'run', 'execute', 'approve', 'cancel', 'complete', 'batch']);
/** Words of sending, publishing, deleting or paying: such a call reaches others or cannot be undone. */
const OUTWARD = new Set(['send', 'publish', 'post', 'reply', 'forward', 'share', 'invite', 'message', 'email', 'mail', 'comment', 'tweet', 'submit', 'delete', 'remove', 'trash', 'destroy', 'drop', 'wipe', 'erase', 'revoke', 'unpublish', 'deploy', 'push', 'merge', 'release', 'kill', 'terminate', 'pay', 'payment', 'purchase', 'buy', 'order', 'checkout', 'charge', 'refund', 'transfer', 'invoice', 'subscribe', 'unsubscribe']);
const MONEY = new Set(['pay', 'payment', 'purchase', 'buy', 'order', 'checkout', 'charge', 'refund', 'transfer', 'invoice', 'subscribe']);
const SENDS = new Set(['send', 'publish', 'post', 'reply', 'forward', 'share', 'invite', 'submit', 'tweet']);

/**
 * What a tool of one of the engine's own apps does (the owner's claude.ai connectors, an MCP server in the engine's
 * settings). The engine passes only the tool's name and its input, without the annotations TeamBot reads for an app it
 * connects itself (modules/mcp/risk.ts), so the name decides, carefully:
 *  - it starts with looking something up and nothing in it acts (get_thread, search_threads, list_events) → "read":
 *    runs on every level;
 *  - a draft, or another change of the owner's own (create_draft, update_document) → "write": runs from "Automatisch" on;
 *  - a word of sending, publishing, deleting or paying anywhere in it (send_message, create_refund), or a change that
 *    names the people it goes to (to, cc, attendees …) and is no draft → "danger": the gate asks the owner, exactly as
 *    for TeamBot's own channels.
 */
export function appToolRisk(tool: string, input: any): ToolRisk {
  const words = nameWords(appToolParts(tool)?.tool || tool);
  const acts = words.slice(1).some((w) => ACTS.has(w) || SENDS.has(w) || (OUTWARD.has(w) && !['message', 'email', 'mail', 'comment', 'order', 'invoice', 'payment'].includes(w)));
  if (READ_START.has(words[0]) && !acts) return 'read';
  const draft = words.includes('draft') || words.includes('drafts');
  if (draft && !words.some((w) => SENDS.has(w))) return 'write';
  if (words.some((w) => OUTWARD.has(w))) return 'danger';
  return !draft && recipientsOf(input).length ? 'danger' : 'write';
}

/** Paying through an app is never the bot's own call: it asks on every level, whatever else the owner allowed. */
export function appToolImpact(tool: string): ToolImpact {
  return nameWords(appToolParts(tool)?.tool || tool).some((w) => MONEY.has(w)) ? 'payment' : 'external';
}

/**
 * A tool of a CLI engine that the engine's own table below has no line for (Claude Code by name, ACP by kind): one
 * answer for every engine.
 *  - A tool of an app (`mcp__<app>__<tool>`): what its name and input say (`appToolRisk`); what goes out is "to others".
 *  - Anything else is a tool of the engine itself that TeamBot does not know yet. It works on this computer, like a
 *    command: asks on "Vragen", runs from "Automatisch" on. What reaches others never comes this way: a command is
 *    read by command-risk.ts, a web address by the gate, and a tool of an app is the line above.
 */
export function otherToolRisk(tool: string, input?: any): ToolRisk {
  return isAppTool(tool) ? appToolRisk(tool, input) : 'exec';
}

/** Claude Code built-in tool → TeamBot risk; a tool without a line here: `otherToolRisk`. */
export function claudeToolRisk(tool: string, input: any): ToolRisk {
  if (/^(Read|Glob|Grep|LS|NotebookRead|WebSearch|WebFetch|TodoWrite|TodoRead|Task|Agent|BashOutput|ListMcpResourcesTool|ReadMcpResourceTool|Skill|ToolSearch)$/.test(tool)) return 'read';
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool)) return 'write';
  if (/^(Bash|PowerShell|KillShell|KillBash|Monitor)$/.test(tool)) return commandRisk(String(input?.command ?? ''));
  // Claude Code's own helpers that only act inside its session on this computer (a bot on "Volledige toegang" has them).
  if (/^(TaskStop|TaskOutput|TaskList|TaskGet|ListAgents)$/.test(tool)) return 'read';
  if (/^(TaskCreate|TaskUpdate|SendMessage|EnterWorktree|ExitWorktree|Workflow|ReportFindings)$/.test(tool)) return 'write';
  if (tool === 'ExitPlanMode' || tool === 'EnterPlanMode') return 'write';
  return otherToolRisk(tool, input);
}

/**
 * Tools of the ACP engines themselves whose name has two words (OpenCode, Gemini CLI, Qwen Code): not a tool of an app.
 * A name of one word is never taken for an app tool.
 */
const ACP_OWN_TOOL =
  /^(?:external[_-]directory|doom[_-]loop|todo[_-]?(?:write|read)|write[_-]todos|web[_-]?(?:search|fetch)|google[_-]web[_-]search|code[_-]?search|apply[_-]patch|multi[_-]?edit|plan[_-](?:enter|exit)|(?:enter|exit)[_-]plan[_-]mode|switch[_-]mode|activate[_-]skill|save[_-]memory|ask[_-]user(?:[_-]question)?|read[_-](?:file|many[_-]files)|write[_-]file|list[_-]directory|search[_-]file[_-]content|run[_-]shell[_-]command)$/i;

/**
 * An ACP tool call that is a tool of one of the engine's own apps (an MCP server in the engine's own settings), under
 * the name Claude Code gives such a tool: `mcp__<app>__<tool>`. Null for everything else.
 *
 * ACP has no kind for it: it arrives as kind "other" (or none) with only a name, without a command, a program or file
 * locations. The name is `<app>_<tool>` (OpenCode: "gmail_send_email"), `<tool> (<app> MCP Server)` (Gemini CLI, Qwen
 * Code) or already `mcp__<app>__<tool>`. Where the app's name ends is not told, so the first word counts as the app.
 * TeamBot's own tools never come here (acp.ts answers those first: they pass the gate when the call arrives).
 */
export function acpAppTool(tc: { kind?: string; title?: string; rawInput?: any; locations?: unknown[]; _meta?: any } | null | undefined): string | null {
  if (!tc || (tc.kind && tc.kind !== 'other')) return null;
  const raw = tc.rawInput;
  if (commandOf(raw) || typeof raw?.code === 'string' || (Array.isArray(tc.locations) && tc.locations.length)) return null;
  const slug = (s: string) => s.trim().replace(/[^A-Za-z0-9-]+/g, '_').replace(/^_+|_+$/g, '');
  for (const c of [tc._meta?.toolName, tc._meta?.tool, raw?.tool, tc.title]) {
    if (typeof c !== 'string' || !c.trim() || c.length > 200) continue;
    const name = c.trim();
    if (/^(?:mcp__)?teambot(?:__|[_.:/ ])/i.test(name)) return null;
    if (/^mcp__[^_].*?__\S+$/.test(name)) return name.slice(0, 100);
    const named = name.match(/^(.+?)\s*\((.+?)\s+MCP Server\)$/i);
    if (named && slug(named[1]) && slug(named[2])) return `mcp__${slug(named[2])}__${slug(named[1])}`.slice(0, 100);
    const parts = name.match(/^([A-Za-z0-9]+)[_.:/-]+([A-Za-z0-9]+(?:[_.:/-]+[A-Za-z0-9]+)*)$/);
    if (parts && !ACP_OWN_TOOL.test(name)) return `mcp__${parts[1]}__${slug(parts[2])}`.slice(0, 100);
  }
  return null;
}

/** ACP tool kind → TeamBot risk; a kind without a line here: `otherToolRisk`. */
export function acpKindRisk(kind: string | undefined, rawInput: any): ToolRisk {
  switch (kind) {
    case 'read':
    case 'search':
    case 'think':
    case 'fetch':
      return 'read';
    case 'edit':
    case 'move':
    case 'switch_mode':
      return 'write';
    case 'delete':
      return 'danger';
    case 'execute':
      return commandRisk(commandOf(rawInput));
    default:
      return commandOf(rawInput) ? commandRisk(commandOf(rawInput)) : otherToolRisk(String(kind || 'other'));
  }
}

export function commandOf(input: any): string {
  if (!input || typeof input !== 'object') return '';
  const c = input.command ?? input.cmd ?? input.commandLine ?? input.script;
  return Array.isArray(c) ? c.join(' ') : typeof c === 'string' ? c : '';
}

/** Paths a tool call wants to touch (best effort over common field names). */
export function pathsOf(input: any): string[] {
  if (!input || typeof input !== 'object') return [];
  const out: string[] = [];
  for (const k of ['file_path', 'path', 'notebook_path', 'filePath', 'filepath', 'abs_path', 'absolute_path', 'target', 'destination', 'source']) {
    if (typeof input[k] === 'string' && input[k]) out.push(input[k]);
  }
  if (Array.isArray(input.paths)) for (const p of input.paths) if (typeof p === 'string') out.push(p);
  if (Array.isArray(input.edits)) for (const e of input.edits) if (typeof e?.file_path === 'string') out.push(e.file_path);
  return out;
}

export function urlOf(input: any): string {
  return typeof input?.url === 'string' ? input.url : '';
}

export interface GateScope {
  ctx: Ctx;
  agent: Agent;
  thread: Thread | null;
  run: Run | null;
  userId: string;
  signal: AbortSignal;
  /** Namespace for tool names in approvals and tool_policy, e.g. "claude-code". */
  ns: string;
  /** Pause idle timers while a human decides. */
  hold?(on: boolean): void;
  onActivity?(title: string, detail?: string): void;
}

export interface GateRequest {
  tool: string;
  risk: ToolRisk;
  summary: string;
  input: any;
  /** Paths that must stay inside the bot's workspace roots. */
  paths?: string[];
  url?: string;
  command?: string;
  /** For danger requests in "Volledige toegang" (default external: asks). */
  impact?: ToolImpact;
}

export interface GateResult {
  allow: boolean;
  message: string;
  asked: boolean;
}

/** One permission request of a CLI engine through the gate; the engine gets yes or no and the reason. */
export async function gate(s: GateScope, r: GateRequest): Promise<GateResult> {
  const { ctx, agent } = s;
  // One name per tool of an engine: the owner's choice for that tool and his rules hold for every use of it.
  const name = `${s.ns}:${r.tool}`.slice(0, 120);
  // The steps say what in words ("een bestand wijzigen"), not the CLI's tool name ("Write").
  const what = approvalWhat({ tool: name, risk: r.risk, input: r.input });
  const g = await passGate(
    { ctx, agent, thread: s.thread, run: s.run, userId: s.userId, signal: s.signal },
    {
      name,
      risk: r.risk,
      // Without a command: an app of the owner (an MCP server of the CLI) can reach others; the CLI's own tools work here.
      impact: r.impact || (r.command ? commandImpact(r.command) : isAppTool(r.tool) ? appToolImpact(r.tool) : fullAccess(agent) ? 'local' : 'external'),
      // What the owner's own rules (module botrules) look at: the folders, the website and the command of this request.
      args: { paths: r.paths || [], url: r.url, command: r.command },
      input: sanitizeInput(r.input),
      summary: r.summary || r.tool,
      // A shared bot in a member's conversation never runs commands on its owner's computer (agent/shared.ts).
      refusal: sharedRunOf(agent) && (r.command || r.risk === 'exec') ? `Geweigerd door TeamBot: ${ownerOnlyText(agent)}` : null,
      command: r.command,
      paths: r.paths,
      url: r.url,
    },
    {
      // Idle timers pause while a human decides.
      onWait: (waiting, summary) => {
        s.hold?.(waiting);
        if (waiting) s.onActivity?.(`Wacht op toestemming: ${what}`, summary);
      },
    },
  );
  ctx.audit(s.userId, 'cli.permission', g.allow ? { tool: name, summary: g.summary, allowed: true, ...(g.asked ? { asked: true } : { auto: true }) } : { tool: name, summary: g.summary, allowed: false, reason: g.reason.slice(0, 200), asked: g.asked }, agent.id);
  if (!g.allow) s.onActivity?.(`Geweigerd: ${what}`, g.reason);
  else if (g.asked) s.onActivity?.(`Goedgekeurd: ${what}`);
  return { allow: g.allow, message: g.allow ? (g.asked ? 'Goedgekeurd door de gebruiker' : 'Toegestaan door TeamBot') : g.reason, asked: g.asked };
}

/** Whether the three hard blocks hold for a bot, in one sentence for the place where the owner chooses its level. */
export interface HardBlocks {
  guarded: boolean;
  /** "Bewaakt door TeamBot: …" or "Niet bewaakt door TeamBot: …" (Dutch, one sentence). */
  text: string;
}

const BLOCKS = 'sleutelbestanden (zoals ~/.ssh), de mappen die je dicht zette en de gegevens van TeamBot';
const GUARDED: HardBlocks = { guarded: true, text: `Bewaakt door TeamBot: ${BLOCKS} blijven dicht voor deze bot.` };
const unguarded = (why: string): HardBlocks => ({ guarded: false, text: `Niet bewaakt door TeamBot: ${why}; alleen de instructies van de bot verbieden het.` });

/**
 * Do the three hard blocks (key files, the folders the owner closed, TeamBot's own data) hold for a bot on this AI at
 * this level, whatever the bot tries? One answer for every kind of AI:
 *  - a model over an API key or a local model: every step is a tool of TeamBot and passes the gate;
 *  - Claude Code: what it does outside the bot's folders asks the gate or is refused by Claude Code itself, and on the
 *    whole computer the shut folders also go along as its own deny rules (claude.ts);
 *  - OpenCode: asks the gate for every edit, command, web page and path outside its folder (catalog.ts acpEnv);
 *  - another ACP engine: TeamBot cannot make it ask for every step: what it reads (and from "Automatisch" on what it
 *    changes or runs) without asking, the gate never sees;
 *  - Codex: approvals are off except on "Vragen", so its sandbox holds the blocks: only where TeamBot's check on this
 *    computer showed that a profile holds (codex-sandbox.ts), and on the whole computer only where `:root` write with
 *    deny entries held too. Elsewhere Codex runs with the legacy flags or without a sandbox.
 * `whole`: the level "Volledige toegang" means the whole computer for this bot (files.ts wholeComputer).
 * Where a block does not hold, the bot's instructions carry it (`hardBlocksNote`, and folders' foldersPrompt for the
 * whole computer).
 */
export function hardBlocks(o: { engine: 'api' | 'claude' | 'codex' | 'acp' | string; cli?: string; label?: string; level: string; whole?: boolean; codex?: CodexReadGuard | null }): HardBlocks {
  if (o.level === 'chat' || o.engine === 'claude' || (o.engine !== 'codex' && o.engine !== 'acp')) return GUARDED;
  if (o.engine === 'codex') {
    const g = o.codex;
    if (o.level === 'full' && o.whole) return g?.root && g.level !== 'open' ? GUARDED : unguarded(`met Volledige toegang draait Codex hier zonder sandbox en zonder TeamBot iets te vragen, dus Codex kan ${BLOCKS} lezen en wijzigen`);
    return g && g.level !== 'open' ? GUARDED : unguarded(`Codex kan op deze pc alles lezen wat jij kunt lezen, ook ${BLOCKS}`);
  }
  if (o.cli === 'opencode') return GUARDED;
  const who = o.label || 'Deze AI';
  return o.level === 'readonly' || o.level === 'ask'
    ? unguarded(`${who} kan bestanden lezen zonder TeamBot te vragen, ook ${BLOCKS}`)
    : unguarded(`${who} kan in deze stand bestanden lezen en wijzigen en opdrachten uitvoeren zonder TeamBot te vragen, ook in ${BLOCKS}`);
}

/** `hardBlocks` for every level of one bot (or of a new bot of the owner, without `agent`), for the bot's page. */
export function hardBlocksByLevel(o: { engine: string; cli?: string; label?: string; codex?: CodexReadGuard | null; agent: Agent }): Record<'chat' | 'readonly' | 'ask' | 'auto' | 'full', HardBlocks> {
  const whole = !!wholeComputer({ ...o.agent, access_mode: 'full' });
  const at = (level: string) => hardBlocks({ ...o, level, whole });
  return { chat: at('chat'), readonly: at('readonly'), ask: at('ask'), auto: at('auto'), full: at('full') };
}

/**
 * The hard blocks in the bot's own instructions, for a run in which they do not hold (`hardBlocks`). Empty on the whole
 * computer: the folders module says it there already, with the same folders (folders/index.ts foldersPrompt).
 */
export function hardBlocksNote(agent: Agent, dataDir: string): string {
  if (wholeComputer(agent)) return '';
  const shut = shutFolders(agent, dataDir);
  const data = shut[0];
  const closed = shut.slice(1);
  return [
    '## Wat dicht blijft',
    `TeamBot kan in deze stand niet elke stap van je controleren. Lees, wijzig of gebruik daarom nooit: bestanden met sleutels en wachtwoorden (zoals ~/.ssh, inloggegevens van git, cloud en CLI's, wachtwoorden en cookies van browsers), de gegevens van TeamBot in ${data} (behalve je eigen mappen)${closed.length ? ` en deze mappen: ${closed.join(', ')}` : ''}. Vraag daar niet om en zoek er geen omweg voor.`,
  ].join('\n');
}

/** Keep approval payloads small and free of obvious secrets. */
function sanitizeInput(input: any): any {
  try {
    const s = redact(JSON.stringify(input ?? {}));
    return s.length > 20_000 ? { preview: s.slice(0, 20_000) + '…' } : JSON.parse(s);
  } catch {
    return {};
  }
}

/** A path for an approval card: relative inside the bot's working folder (`root`), the full path elsewhere. */
export function cardPath(p: string, root?: string): string {
  if (!root) return p;
  const rel = path.relative(path.resolve(root), path.resolve(root, p));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : p;
}

/** A shell command without the CLI's own `cd "<working folder>" && ` in front (that folder is the bot's own). */
export function plainCommand(cmd: string, root?: string): string {
  const c = String(cmd || '').trim();
  if (!root) return c;
  const m = c.match(/^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;)\s*/i);
  if (!m) return c;
  const dir = (m[1] || m[2] || m[3] || '').replace(/[\\/]+$/, '');
  const norm = (x: string) => path.resolve(x).replace(/\\/g, '/').toLowerCase();
  return norm(dir) === norm(root) ? c.slice(m[0].length) : c;
}

/**
 * Codex on Windows reports a command with every quoted argument in Rust's debug notation, each backslash doubled:
 * `"C:\\WINDOWS\\…\\powershell.exe" -Command "Set-Content -LiteralPath 'C:\\Users\\…\\a.txt' …"` (acceptance round 5,
 * B-46). The command that really ran has single backslashes; that is the one to show and to check. A quoted part is
 * only read back when every backslash in it belongs to an escape and at least one is doubled, so a plain
 * `"C:\Users\x"` or `"C:\new\test"` stays exactly as it is.
 */
export function codexCommand(cmd: unknown): string {
  const c = String(cmd ?? '');
  if (!c.includes('\\\\')) return c;
  const ESC: Record<string, string> = { n: '\n', r: '\r', t: '\t', '0': '\0' };
  return c.replace(/"((?:[^"\\]|\\.)*)"/g, (whole, inner: string) =>
    /\\\\/.test(inner) && /^(?:[^\\]|\\[\\"nrt0'])*$/.test(inner) ? `"${inner.replace(/\\([\\"nrt0'])/g, (_m, ch: string) => ESC[ch] ?? ch)}"` : whole,
  );
}

/**
 * The command inside a shell wrapper: Codex runs `"…\powershell.exe" -Command "Set-Content …"` or `bash -lc '…'`;
 * the card shows the inner command. Anything else is returned unchanged.
 */
export function unwrapShell(cmd: string): string {
  const c = String(cmd || '').trim();
  const m =
    c.match(/^(?:"[^"]*[\\/])?(?:[^\s"]*[\\/])?(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-(?:NoProfile|NoLogo|NonInteractive|ExecutionPolicy\s+\w+)\s+)*-(?:Command|c)\s+([\s\S]+)$/i) ||
    c.match(/^(?:\/usr\/bin\/|\/bin\/)?(?:bash|sh|zsh)\s+-l?c\s+([\s\S]+)$/) ||
    c.match(/^(?:cmd(?:\.exe)?)\s+\/[cs]\s+([\s\S]+)$/i);
  if (!m) return c;
  const inner = m[1].trim();
  const q = inner[0];
  return (q === '"' || q === "'") && inner.endsWith(q) && inner.length > 1 ? inner.slice(1, -1).replace(q === "'" ? /''/g : /`"/g, q) : inner;
}

const PATH_ARG = String.raw`(?:"([^"]+)"|'([^']+)'|([^\s;|&>'"]+))`;
const pick = (m: RegExpMatchArray, i = 1) => m[i] || m[i + 1] || m[i + 2] || '';

/**
 * The files a command only writes (Codex on Windows writes a file with `Set-Content`, `Out-File` or `> file`):
 * the target paths, or null when the command does more than write files (then it stays "een opdracht").
 */
export function commandWriteTargets(cmd: string): string[] | null {
  const c = unwrapShell(cmd).trim();
  if (!c || c.length > 4000) return null;
  // One statement: a pipe into a writer is fine, other chaining, sub-shells or invocations are not.
  const statements = c.split(/\s*(?:;|&&|\n)\s*/).filter(Boolean);
  if (statements.length !== 1 || /\$\(|`\(|\binvoke-|\biex\b|\bstart-process\b|\brm\b|\bdel\b|\bremove-item\b/i.test(c)) return null;
  const s = statements[0];
  // A PowerShell writer: the -Path/-FilePath argument, else the first positional argument.
  const target = (rest: string) => {
    const named = rest.match(new RegExp(String.raw`\s-(?:Path|LiteralPath|FilePath)\s+${PATH_ARG}`, 'i'));
    const pos = rest.match(new RegExp(String.raw`^\s+${PATH_ARG}`));
    const p = named ? pick(named) : pos ? pick(pos) : '';
    return p && !p.startsWith('-') ? [p] : null;
  };
  const ps = s.match(/^(?:[^|]*\|\s*)?(?:Set-Content|Add-Content|Out-File)\b([\s\S]*)$/i);
  if (ps) return target(ps[1]);
  const item = s.match(/^New-Item\b([\s\S]*)$/i);
  if (item) return /-ItemType\s+["']?File\b/i.test(item[1]) ? target(item[1]) : null;
  const net = s.match(new RegExp(String.raw`^\[(?:System\.)?IO\.File\]::(?:WriteAllText|WriteAllLines|AppendAllText)\(\s*${PATH_ARG}`, 'i'));
  if (net) return [pick(net)];
  const tee = s.match(new RegExp(String.raw`^[^|]*\|\s*tee(?:\s+-a)?\s+${PATH_ARG}\s*$`));
  if (tee) return [pick(tee)];
  // `echo …  > file`, `printf … >> file`, `cat > file <<EOF` — the only redirect, to a file (not a device).
  const redir = s.match(new RegExp(String.raw`^(?:echo|printf|cat|Write-Output)\b[^<>|]*>>?\s*${PATH_ARG}(?:\s*<<-?\s*'?\w+'?[\s\S]*)?$`, 'i'));
  if (redir && !/^(\/dev\/|nul$|con$)/i.test(pick(redir))) return [pick(redir)];
  return null;
}

const ACP_KIND: Record<string, string> = {
  execute: 'Opdracht',
  edit: 'Bestand aanpassen',
  read: 'Bestand lezen',
  delete: 'Bestand verwijderen',
  move: 'Bestand verplaatsen',
  search: 'Zoeken in bestanden',
  fetch: 'Webpagina lezen',
  think: 'Nadenken',
};

/**
 * One line in Dutch for an ACP tool call (OpenCode, Gemini CLI, Qwen, …) for the steps and the approval card:
 * "Opdracht: pdftotext -layout offerte.pdf -", "Bestand aanpassen: notities/plan.md". Never "shell",
 * "soort: execute" or the full path of the bot's working folder, and the command is not shown twice.
 */
export function acpToolSummary(tc: { kind?: string; title?: string; rawInput?: any; locations?: { path?: string }[] }, root?: string): string {
  const kind = String(tc.kind || 'other');
  const raw = tc.rawInput;
  const cmd = plainCommand(commandOf(raw), root);
  const paths = [...new Set([...(tc.locations || []).map((l) => String(l?.path || '')).filter(Boolean), ...pathsOf(raw)])].map((p) => cardPath(p, root));
  const title = String(tc.title || '').replace(/\s+/g, ' ').trim();
  // OpenCode titles are often a bare tool word ("shell", "read") or the command itself.
  const bareTitle = !title || /^(shell|bash|execute|read|write|edit|patch|delete|move|grep|glob|list|search|fetch|webfetch|websearch|codesearch|task|think|tool|other)$/i.test(title) || (!!cmd && plainCommand(title, root) === cmd);
  const label = ACP_KIND[kind] || 'Stap';
  const pathLike = !!title && !/\s/.test(title) && /[\\/]/.test(title);
  let line: string;
  const query = typeof raw?.query === 'string' ? raw.query.replace(/\s+/g, ' ').trim() : '';
  if (/^web_?search$/i.test(title)) line = `Zoeken op internet${query ? `: ${query}` : ''}`;
  else if (/^todo_?(write|read)$/i.test(title)) line = 'Plan bijwerken';
  else if (kind === 'execute') line = `${label}${cmd || !bareTitle ? `: ${cmd || plainCommand(title, root)}` : ''}`;
  else if (!bareTitle && !pathLike) line = title; // the engine's own description: "Lees README", "Plan opstellen"
  else {
    const what = kind === 'fetch' ? urlOf(raw) : paths.length ? paths.slice(0, 3).join(', ') : pathLike ? cardPath(title, root) : cmd;
    line = `${label}${what ? `: ${what}` : ''}`;
  }
  return redact(line).slice(0, 400);
}

/** Human readable one-liner for a Claude Code tool call, in Dutch (the approval card shows it in bold). */
export function claudeToolSummary(tool: string, input: any, root?: string): string {
  const p0 = pathsOf(input)[0];
  const p = p0 ? cardPath(p0, root) : '';
  const cmd = commandOf(input);
  const cut = (s: string) => s.slice(0, 400);
  switch (tool) {
    case 'Write':
      return cut(`Bestand schrijven: ${p || '(onbekend)'}`);
    case 'Edit':
    case 'MultiEdit':
      return cut(`Bestand aanpassen: ${p || '(onbekend)'}`);
    case 'NotebookEdit':
      return cut(`Notebook aanpassen: ${p || '(onbekend)'}`);
    case 'Read':
      return cut(`Bestand lezen: ${p || '(onbekend)'}`);
    case 'WebFetch':
      return cut(`Webpagina lezen: ${input?.url || ''}`);
    case 'WebSearch':
      return cut(`Zoeken op internet: ${input?.query || ''}`);
    case 'Grep':
    case 'Glob':
      return cut(`Zoeken in bestanden: ${input?.pattern || ''}`);
  }
  // A tool of one of the engine's own apps: the app and what it does, and who it goes to (the card shows it in bold).
  const app = appToolParts(tool);
  if (app) {
    const to = recipientsOf(input);
    const subject = typeof input?.subject === 'string' ? input.subject.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    return cut(`${appLabel(app.app)}: ${app.tool.replace(/_/g, ' ')}${to.length ? ` — aan ${to.slice(0, 5).join(', ')}` : ''}${subject ? ` — onderwerp: ${subject}` : ''}`);
  }
  if (cmd) return cut(`Opdracht: ${cmd}`);
  if (p) return cut(`${tool}: ${p}`);
  try {
    return `${tool}(${JSON.stringify(input ?? {}).slice(0, 300)})`;
  } catch {
    return tool;
  }
}
