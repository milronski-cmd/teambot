import path from 'node:path';
import type { Agent, Ctx, Run, Thread, ToolImpact, ToolRisk } from '../../core/types.js';
import { agentRoots, resolveInWorkspace, wholeComputer } from '../../tools/builtin/files.js';
import { commandPaths } from '../../tools/builtin/command-risk.js';
import { assertPublicUrl } from '../../tools/builtin/web.js';
import { redact } from '../../core/secrets.js';
import { approvalWhat } from '../../../shared/approvalLabels.js';
import { ownerOnlyText, sharedRunOf } from '../../agent/shared.js';
import { autoReview } from '../../agent/autoreview.js';
import { ownRule } from '../../tools/execute.js';

/**
 * Permission gate for CLI agents. Every approval request a CLI makes (Claude Code
 * permission prompt, ACP session/request_permission, Codex app-server approval)
 * is classified to a TeamBot risk and decided by the central Broker — the same
 * rules as API agents: chat = nothing, readonly = reads only, ask = humans approve
 * writes/exec, auto = writes/exec automatic, danger always asks.
 */

/** Commands that are never allowed, in any mode. */
const HARDLINE = [
  /\bformat(\.com)?\s+[a-z]:/i,
  /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\$HOME|\/\*)(\s|$)/i,
  /Remove-Item\s+.*-Recurse.*\s+(C:\\|~|\$env:USERPROFILE)\s*$/i,
  /\bmkfs\./i,
  /\bdd\s+if=.*of=\/dev\//i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /\bshutdown\b|\bStop-Computer\b|\bRestart-Computer\b/i,
  /\bvssadmin\s+delete\b|\bbcdedit\b|\bcipher\s+\/w/i,
  /\breg\s+delete\s+HKLM/i,
];

/** Shell commands with outside impact (send, publish, delete, push) → always ask. */
const DANGER_CMD = [
  /\bgit\s+push\b/i,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D|tag\s+-d|filter-branch)\b/i,
  /\bgh\s+(pr|issue|release|repo|gist|api)\s+(create|merge|close|delete|comment|edit|upload|-X)/i,
  /\b(npm|pnpm|yarn|bun)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bdocker\s+push\b|\bgem\s+push\b|\bdotnet\s+nuget\s+push\b/i,
  /\b(curl|wget|http|xh)\b.*(\s-X\s*(POST|PUT|PATCH|DELETE)|\s--data|\s-d\s|\s-F\s|--upload-file|--form|\s-T\s)/i,
  /\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b.*-Method\s+(Post|Put|Patch|Delete)/i,
  /\b(ssh|scp|sftp|rsync)\s+[^|;&]*\w@[\w.-]+/i,
  /\b(sendmail|mailx?|Send-MailMessage)\b/i,
  /\brm\s+-[a-z]*r/i,
  /\bRemove-Item\b.*-Recurse/i,
  /\b(del|erase)\s+\/[sq]/i,
  /\b(rd|rmdir)\s+\/s/i,
  /\bkubectl\s+(apply|delete|create|scale|rollout)\b|\bterraform\s+(apply|destroy)\b/i,
  /\b(aws|az|gcloud)\s+\S+\s+(delete|create|deploy|put|rm|cp)\b/i,
  /\bvercel\b.*--prod|\bnetlify\s+deploy\b|\bfly\s+deploy\b|\bfirebase\s+deploy\b/i,
];

export function isHardline(cmd: string) {
  return HARDLINE.some((r) => r.test(cmd));
}

// The path analysis of a command (outside the bot's folders / key folders) is shared with TeamBot's own terminal tool.
export { commandPaths };

export function commandRisk(cmd: string): ToolRisk {
  return DANGER_CMD.some((r) => r.test(cmd)) ? 'danger' : 'exec';
}

/** Danger commands that only destroy locally (inside the workspace; snapshots/undo exist) vs. ones that reach others. */
const LOCAL_DANGER_CMD = [
  /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D|tag\s+-d|filter-branch)\b/i,
  /\brm\s+-[a-z]*r/i,
  /\bRemove-Item\b.*-Recurse/i,
  /\b(del|erase)\s+\/[sq]/i,
  /\b(rd|rmdir)\s+\/s/i,
];
/** For "Volledige toegang": a danger command is local only if every danger pattern it matches is a local one. */
export function commandImpact(cmd: string): ToolImpact {
  const hits = DANGER_CMD.filter((r) => r.test(cmd));
  if (!hits.length) return 'local';
  return hits.every((h) => LOCAL_DANGER_CMD.some((l) => l.source === h.source)) ? 'local' : 'external';
}

/** Claude Code built-in tool → TeamBot risk. Unknown tools (incl. foreign MCP tools) are treated as dangerous. */
export function claudeToolRisk(tool: string, input: any): ToolRisk {
  if (/^(Read|Glob|Grep|LS|NotebookRead|WebSearch|WebFetch|TodoWrite|TodoRead|Task|Agent|BashOutput|ListMcpResourcesTool|ReadMcpResourceTool|Skill|ToolSearch)$/.test(tool)) return 'read';
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool)) return 'write';
  if (/^(Bash|PowerShell|KillShell|KillBash|Monitor)$/.test(tool)) return commandRisk(String(input?.command ?? ''));
  if (tool === 'ExitPlanMode' || tool === 'EnterPlanMode') return 'write';
  return 'danger';
}

/** ACP tool kind → TeamBot risk. */
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
      return commandOf(rawInput) ? commandRisk(commandOf(rawInput)) : 'exec';
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

/** Decide a CLI permission request through the TeamBot Broker. Fail-closed on any error. */
export async function gate(s: GateScope, r: GateRequest): Promise<GateResult> {
  const { ctx, agent } = s;
  let summary = redact(r.summary || r.tool).slice(0, 1500);
  // The steps say what in words ("een bestand wijzigen"), not the CLI's tool name ("Write").
  const what = approvalWhat({ tool: `${s.ns}:${r.tool}`, risk: r.risk, input: r.input });
  const deny = (message: string, asked = false): GateResult => {
    ctx.audit(s.userId, 'cli.permission', { tool: `${s.ns}:${r.tool}`, summary, allowed: false, reason: message.slice(0, 200), asked }, agent.id);
    s.onActivity?.(`Geweigerd: ${what}`, message);
    return { allow: false, message, asked };
  };
  try {
    if (agent.access_mode === 'chat') return deny(`Geweigerd door TeamBot: ${agent.name} staat in chatmodus (geen tools).`);
    // A shared bot in a member's conversation never runs commands on its owner's computer (agent/shared.ts).
    if (sharedRunOf(agent) && (r.command || r.risk === 'exec')) return deny(`Geweigerd door TeamBot: ${ownerOnlyText(agent)}`);
    // A web page fetched by the CLI itself (Claude Code WebFetch, an ACP "fetch"): only with "Internet" on, like API bots.
    if (r.url && ctx.tools?.groupEnabled && !ctx.tools.groupEnabled(agent, 'web')) return deny(`Geweigerd door TeamBot: Internet staat uit voor ${agent.name}. Zet het aan bij de bot (Bewerken › Tools) als hij webpagina's mag lezen.`);
    if (r.command && isHardline(r.command)) return deny('Geweigerd door TeamBot: deze opdracht staat op de vaste blokkeerlijst (systeembrede schade).');
    // A command that names paths outside the bot's folders: key folders are refused, anything else asks a human.
    const reach = r.command ? commandPaths(r.command, { roots: agentRoots(agent), dataDir: ctx.config?.dataDir, whole: wholeComputer(agent) }) : { outside: [], keys: [] };
    if (reach.keys.length) return deny(`Geweigerd door TeamBot: deze opdracht gebruikt een beschermde map of beschermd bestand (sleutels, inloggegevens of de gegevens van TeamBot): ${reach.keys.slice(0, 3).join(', ')}`);
    for (const p of r.paths || []) {
      try {
        // Writes (and deletes) must land in a read-write folder; read-only shared folders stay readable.
        resolveInWorkspace(agent, p, { write: r.risk === 'write' || r.risk === 'danger' });
      } catch (e: any) {
        return deny(`Geweigerd door TeamBot: ${e.message}`);
      }
    }
    if (r.url) {
      try {
        await assertPublicUrl(r.url, !!agent.settings?.allowPrivateUrls);
      } catch (e: any) {
        return deny(`Geweigerd door TeamBot: ${e.message}`);
      }
    }
    // Danger actions get their own policy key so an earlier "always allow" for the tool never covers them.
    const name = `${s.ns}:${r.tool}${r.risk === 'danger' ? ':danger' : ''}`.slice(0, 120);
    const impact: ToolImpact = r.impact || (r.command ? commandImpact(r.command) : 'external');
    // What the owner's own rules (module botrules) look at: the folders, the website and the command of this request.
    const call = { name, risk: r.risk, impact };
    const callArgs = { paths: r.paths || [], url: r.url, command: r.command };
    const decided = ctx.broker.decide(agent, call, callArgs);
    let decision = decided === 'allow' && reach.outside.length ? 'ask' : decided;
    const rule = decision !== 'allow' ? ownRule(ctx, agent, call, callArgs, decision) : null;
    if (decision === 'deny')
      return deny(rule ? `Geweigerd door een regel van je eigenaar: “${rule}”. Doe dit niet; vraag je eigenaar als het echt nodig is.` : `Geweigerd door TeamBot: ${agent.name} heeft in modus "${agent.access_mode}" geen toestemming voor ${r.tool} (${riskLabel(r.risk)}).`);
    if (reach.outside.length) summary = redact(`${summary} — buiten de mappen van de bot: ${reach.outside.slice(0, 3).join(', ')}`).slice(0, 1500);
    if (rule) summary = `Jouw regel: “${rule}”\n${summary}`.slice(0, 1500);
    // Rules TeamBot cannot pin down in code: Auto Review checks the change against them; without a turn to check, ask.
    const reviewRules: string[] = r.risk !== 'read' && typeof ctx.services?.botRules?.reviewTexts === 'function' ? ctx.services.botRules.reviewTexts(agent) : [];
    if (decision === 'allow' && reviewRules.length) {
      const v = s.thread && s.run ? await autoReview(ctx, agent, s.thread, s.run, { name, risk: r.risk, description: '' }, sanitizeInput(r.input), reviewRules) : { verdict: 'ask', reason: 'Je hebt een eigen regel die TeamBot niet vooraf kan controleren.' };
      if (v.verdict === 'ask') {
        decision = 'ask';
        summary = `Automatische controle: ${v.reason}\n${summary}`.slice(0, 1500);
      }
    }
    if (decision === 'allow') {
      ctx.audit(s.userId, 'cli.permission', { tool: name, summary, allowed: true, auto: true }, agent.id);
      return { allow: true, message: 'Toegestaan door TeamBot', asked: false };
    }
    s.hold?.(true);
    s.onActivity?.(`Wacht op toestemming: ${what}`, summary);
    try {
      const res = await ctx.broker.request({ userId: s.userId, agent, thread: s.thread, run: s.run, kind: 'tool', tool: name, input: sanitizeInput(r.input), summary, risk: r.risk, signal: s.signal });
      if (!res.approved) return deny('De gebruiker heeft deze actie geweigerd. Vraag eventueel wat je anders moet doen.', true);
      ctx.audit(s.userId, 'cli.permission', { tool: name, summary, allowed: true, asked: true }, agent.id);
      s.onActivity?.(`Goedgekeurd: ${what}`);
      return { allow: true, message: 'Goedgekeurd door de gebruiker', asked: true };
    } catch {
      return deny('Gestopt voordat er toestemming was.', true);
    } finally {
      s.hold?.(false);
    }
  } catch (e: any) {
    return deny(`Geweigerd door TeamBot (interne fout): ${String(e?.message || e).slice(0, 200)}`);
  }
}

function riskLabel(r: ToolRisk) {
  return { read: 'lezen', write: 'schrijven', exec: 'uitvoeren', danger: 'actie met impact' }[r];
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
  if (cmd) return cut(`Opdracht: ${cmd}`);
  if (p) return cut(`${tool}: ${p}`);
  try {
    return `${tool}(${JSON.stringify(input ?? {}).slice(0, 300)})`;
  } catch {
    return tool;
  }
}
