import path from 'node:path';
import type { Agent, StepFact, ToolDef } from '../../core/types.js';
import { agentRootList } from '../../tools/builtin/files.js';
import { toolLabel } from '../../../shared/toolLabels.js';
import { MCP_SERVER_NAME } from './bridge.js';
import { commandOf, pathsOf, plainCommand } from './permissions.js';

/**
 * Plain-language lines for CLI engines (Claude Code, Codex, ACP): the "stappen" list (`cliActivity`, past tense) and
 * the progress line while a step is being prepared (`cliStatus`, present tense). The raw tool name and exact input
 * stay available in approvals and logs; the chat shows what happens in words. `null` = internal housekeeping that the
 * owner never needs to see (e.g. Claude Code loading its own tool list).
 */
const HIDDEN = new Set(['ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ExitPlanMode']);

/** TeamBot tool name → app name, for tools of connected apps (e.g. "mcp_bestanden_write_file" → "Bestanden"). */
export type AppNames = ReadonlyMap<string, string>;

/** App names of the connected-app tools in a tool list (see ToolDef.app). */
export function appNames(tools: Pick<ToolDef, 'name' | 'app'>[]): Map<string, string> {
  return new Map(tools.filter((t) => t.app).map((t) => [t.name, t.app!]));
}

const short = (s: unknown, n = 160) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
/**
 * The last part of a path for the steps: "notities/plan.md", "opruimen.py". The bot's own working folder is named
 * after its internal id ("…\workspaces\ag_…"; in practice mode its copy "…\rehearsals\ag_…\rh_…\work"), and
 * attachments get a short id in front ("uploads/a31b28-offerte.pdf"); none of that means anything to the owner, so it
 * is left out: practice mode reads "Las README.md", like the bot's real folder, not "Las work/README.md" (round 6).
 */
export const base = (p: string) => {
  const segs = p.split(/[\\/]/).filter(Boolean);
  let from = 0;
  segs.forEach((seg, i) => {
    if (/^ag_[0-9a-f]{12,}$/i.test(seg)) from = i + 1;
    if (/^rh_[0-9a-f]{12,}$/i.test(seg) && segs[i + 1] === 'work') from = i + 2;
  });
  const own = segs.slice(from);
  return (own.length ? own : segs)
    .slice(-2)
    .map((seg, i, all) => (i === all.length - 1 && all[i - 1] === 'uploads' ? seg.replace(/^[0-9a-f]{6}-/i, '') : seg))
    .join('/');
};
const words = (s: string) => s.replace(/[-_]+/g, ' ').trim();

/**
 * A step as the owner reads it: the bot's own working folder is shown without its path (an internal id, or the
 * practice copy): paths inside it from that folder on, the folder itself as "de werkmap". A CLI engine names files
 * with their full path, so a step read "TeamBot · Bestand delen: C:\…\workspaces\ag_a837…\offerte-velomax.pdf" (B-47)
 * and a refusal "… Toegestaan: C:\…\workspaces\ag_eff2… ; C:\…\Teammap" (B-45). Any other folder stays as written.
 */
export function withoutOwnFolder(text: string, agent: Agent): string {
  const ws = agentRootList(agent).find((r) => r.kind === 'workspace')?.path;
  if (!ws || !text) return text;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = ws.split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return text;
  const body = parts.map(esc).join('[\\\\/]+');
  const flags = process.platform === 'win32' ? 'gi' : 'g';
  return text.replace(new RegExp(`[\\\\/]?${body}[\\\\/]+`, flags), '').replace(new RegExp(`[\\\\/]?${body}(?![\\w.-])`, flags), 'de werkmap');
}

/** A TeamBot tool in words; tools of connected apps are named after their app. */
export function teambotLabel(tool: string, running: boolean, apps?: AppNames): string {
  const app = apps?.get(tool);
  if (app) return `${running ? 'Gebruikt' : 'Gebruikte'} ${app}`;
  return toolLabel({ name: tool }, running);
}

/** "mcp__teambot__memory_update" → TeamBot's own label; "mcp__github__x" → "Gebruikte github". '' = hidden. */
function mcpLabel(name: string, running: boolean, apps?: AppNames): string | null {
  const m = /^mcp__([^_].*?)__(.+)$/.exec(name);
  if (!m) return null;
  const [, server, tool] = m;
  // The plan card shows plan_update itself; a step per update would only repeat it.
  if (server === MCP_SERVER_NAME) return tool === 'permission_prompt' || tool === 'plan_update' ? '' : teambotLabel(tool, running, apps);
  return `${running ? 'Gebruikt' : 'Gebruikte'} ${words(server)}`;
}

export function cliActivity(tool: string, input: any, apps?: AppNames): string | null {
  if (HIDDEN.has(tool)) return null;
  const mcp = mcpLabel(tool, false, apps);
  if (mcp !== null) return mcp || null;
  const p = pathsOf(input)[0];
  const cmd = commandOf(input);
  switch (tool) {
    case 'Read':
      return `Las ${p ? base(p) : 'een bestand'}`;
    case 'Write':
      return `Schreef ${p ? base(p) : 'een bestand'}`;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Paste ${p ? base(p) : 'een bestand'} aan`;
    case 'LS':
      return `Bekeek ${p ? base(p) : 'een map'}`;
    case 'Glob':
    case 'Grep':
      return `Zocht in bestanden${input?.pattern ? `: ${short(input.pattern, 80)}` : ''}`;
    case 'Bash':
    case 'PowerShell':
      return `Voerde uit: ${short(cmd || input?.description, 140)}`;
    case 'WebSearch':
      return `Zocht op internet: ${short(input?.query, 120)}`;
    case 'WebFetch':
      return `Las een webpagina: ${short(input?.url, 120)}`;
    case 'TodoWrite':
      return 'Werkte zijn takenlijstje bij';
    case 'Task':
    case 'Agent':
      return `Gaf een deeltaak${input?.description ? `: ${short(input.description, 120)}` : ''}`;
    case 'Skill':
      return `Pakte een skill erbij${input?.skill || input?.name ? `: ${short(input.skill || input.name, 80)}` : ''}`;
  }
  if (cmd) return `Voerde uit: ${short(cmd, 140)}`;
  if (p) return `Werkte met ${base(p)}`;
  return `Deed een stap (${words(tool)})`;
}

/**
 * A step that is not done yet (the engine announced it; its result, often after an approval card, is still to come)
 * must not read as done (Q-12: "Schreef inbox-3.txt" next to a card that still asked): the same words as what it
 * wants to do. "Schreef notities/plan.md" → "Wil notities/plan.md schrijven", "Voerde uit: npm test" → "Wil een
 * opdracht uitvoeren: npm test". A title the agent wrote itself ("Lees README") stays as it is.
 */
const PENDING: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^Schreef (.+)$/s, (m) => `Wil ${m[1]} schrijven`],
  [/^Las een webpagina(.*)$/s, (m) => `Wil een webpagina lezen${m[1]}`],
  [/^Las een document(.*)$/s, (m) => `Wil een document lezen${m[1]}`],
  [/^Las (.+)$/s, (m) => `Wil ${m[1]} lezen`],
  [/^Paste (.+) aan$/s, (m) => `Wil ${m[1]} aanpassen`],
  [/^Bekeek (.+)$/s, (m) => `Wil ${m[1]} bekijken`],
  [/^Zocht in bestanden(.*)$/s, (m) => `Wil in bestanden zoeken${m[1]}`],
  [/^Zocht op internet(.*)$/s, (m) => `Wil op internet zoeken${m[1]}`],
  [/^Voerde uit: (.+)$/s, (m) => `Wil een opdracht uitvoeren: ${m[1]}`],
  [/^Voerde code uit$/, () => 'Wil code uitvoeren'],
  [/^Zocht een TeamBot-functie op$/, () => 'Zoekt een TeamBot-functie op'],
  [/^Voerde een opdracht uit$/, () => 'Wil een opdracht uitvoeren'],
  [/^Verwijderde (.+)$/s, (m) => `Wil ${m[1]} verwijderen`],
  [/^Verplaatste (.+)$/s, (m) => `Wil ${m[1]} verplaatsen`],
  [/^Werkte met (.+)$/s, (m) => `Wil werken met ${m[1]}`],
  [/^Werkte zijn takenlijstje bij$/, () => 'Werkt zijn takenlijstje bij'],
  [/^Gaf een deeltaak(.*)$/s, (m) => `Wil een deeltaak geven${m[1]}`],
  [/^Pakte een skill erbij(.*)$/s, (m) => `Wil een skill erbij pakken${m[1]}`],
  [/^Gebruikte (.+)$/s, (m) => `Wil ${m[1]} gebruiken`],
  [/^Deed een stap(.*)$/s, (m) => `Wil een stap doen${m[1]}`],
  [/^Dacht na$/, () => 'Denkt na'],
];

export function pendingTitle(past: string): string {
  const sub = /^Deeltaak · /.exec(past)?.[0] || '';
  const t = past.slice(sub.length);
  for (const [re, f] of PENDING) {
    const m = t.match(re);
    if (m) return sub + f(m);
  }
  return past;
}

/**
 * A step whose result was an error did not happen: it keeps saying what the bot wanted ("Wil x lezen"), never "Las x",
 * and the error line says what did not work ("Lukte niet: x lezen") instead of "Lukte niet: las x" (acceptance round
 * 5, B-45: Claude Code reading and writing outside its folders).
 */
export function failedStep(past: string): { title: string; line: string } {
  const sub = /^Deeltaak · /.exec(past)?.[0] || '';
  const wish = pendingTitle(past);
  const what = wish !== past ? wish.slice(sub.length).replace(/^Wil /, '') : past.slice(sub.length).charAt(0).toLowerCase() + past.slice(sub.length + 1);
  return { title: wish, line: `Lukte niet: ${what}` };
}

/**
 * Claude Code's own English refusal for a path outside its folders, in words: "C:\x\a.txt is outside C:\w, C:\t;
 * --restricted confines the file tools to the working directory." → "C:\x\a.txt valt buiten de mappen van deze bot
 * (C:\w, C:\t)." Any other text stays as the engine wrote it.
 */
export function claudeErrorText(body: string): string {
  const t = String(body || '').trim();
  const m = /^(.+?) is outside (.+?); --restricted confines the file tools to the working directory\.?$/s.exec(t);
  return m ? `${m[1]} valt buiten de mappen van deze bot (${m[2]}).` : t;
}

/** What Claude Code was refused at the end of a turn, in words ("tb/a.txt lezen, tb/b.txt schrijven"), not "Read, Write". */
export function deniedWhat(denials: { tool_name?: string; tool_input?: any }[], apps?: AppNames): string {
  const words = denials.map((d) => {
    const wish = cliPending(String(d.tool_name || ''), d.tool_input, apps);
    return wish ? wish.replace(/^Deeltaak · /, '').replace(/^Wil /, '') : String(d.tool_name || '');
  });
  return [...new Set(words.filter(Boolean))].join(', ');
}

/** `cliActivity` for a step whose result is not in yet: TeamBot's own tools in the present tense, the rest as wish. */
export function cliPending(tool: string, input: any, apps?: AppNames): string | null {
  const mcp = mcpLabel(tool, true, apps);
  if (mcp !== null) return mcp || null;
  const past = cliActivity(tool, input, apps);
  return past === null ? null : pendingTitle(past);
}

// ---------------- facts: what a step touched (A-58 "gezien en gedaan", A-35 the bot's own files) ----------------

const one = (op: StepFact['op'], target: unknown): StepFact[] | undefined => (typeof target === 'string' && target.trim() ? [{ op, target: target.trim() }] : undefined);

/** A TeamBot tool's facts (API bots, and TeamBot tools a CLI uses). Paths may be relative to the bot's folder. */
export function teambotFacts(name: string, args: any, app?: string): StepFact[] | undefined {
  if (app) return [{ op: 'app', target: app }];
  switch (name) {
    case 'read_file':
    case 'list_files':
      return one('read', args?.path || (name === 'list_files' ? '.' : ''));
    case 'write_file':
    case 'edit_file':
      return one('write', args?.path);
    case 'delete_file':
      return one('delete', args?.path);
    case 'run_command':
      return one('exec', args?.command);
    case 'web_fetch':
    case 'browser_navigate':
      return one('web', args?.url);
    case 'web_search':
      return one('search', args?.query);
  }
  return undefined;
}

/** Claude Code's (and Codex's) own tools. */
export function cliFacts(tool: string, input: any, apps?: AppNames): StepFact[] | undefined {
  if (HIDDEN.has(tool)) return undefined;
  const m = /^mcp__([^_].*?)__(.+)$/.exec(tool);
  if (m) return m[1] === MCP_SERVER_NAME ? teambotFacts(m[2], input, apps?.get(m[2])) : [{ op: 'app', target: words(m[1]) }];
  const paths = pathsOf(input);
  switch (tool) {
    case 'Read':
    case 'NotebookRead':
      return one('read', paths[0]);
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return paths.length ? [...new Set(paths)].map((target) => ({ op: 'write' as const, target })) : undefined;
    case 'WebFetch':
      return one('web', input?.url);
    case 'WebSearch':
      return one('search', input?.query);
  }
  return one('exec', commandOf(input));
}

/** An ACP agent's tool call (OpenCode, Gemini …). Known as soon as the call has its input. */
export function acpFacts(c: AcpCall, cwd?: string): StepFact[] | undefined {
  const kind = String(c.kind || '');
  const bare = String(c.title ?? '').toLowerCase().replace(/[\s_-]+/g, '');
  if (bare === 'websearch' || bare === 'codesearch') return one('search', c.rawInput?.query);
  if (bare === 'webfetch' || kind === 'fetch') return one('web', c.rawInput?.url);
  const p = acpPathOf(c);
  switch (kind) {
    case 'read':
      return one('read', p);
    case 'edit':
    case 'move':
      return one('write', p);
    case 'delete':
      return one('delete', p);
    case 'execute':
      return one('exec', plainCommand(commandOf(c.rawInput), cwd));
  }
  return undefined;
}

/** Present tense of Claude Code's / Codex's own tools, for the progress line. */
const RUNNING: Record<string, string> = {
  Read: 'Leest een bestand',
  Write: 'Schrijft een bestand',
  Edit: 'Past een bestand aan',
  MultiEdit: 'Past een bestand aan',
  NotebookEdit: 'Past een notebook aan',
  LS: 'Bekijkt een map',
  Glob: 'Zoekt in bestanden',
  Grep: 'Zoekt in bestanden',
  Bash: 'Voert een opdracht uit',
  PowerShell: 'Voert een opdracht uit',
  BashOutput: 'Bekijkt de uitvoer van een opdracht',
  KillShell: 'Stopt een opdracht',
  KillBash: 'Stopt een opdracht',
  WebSearch: 'Zoekt op internet',
  WebFetch: 'Leest een webpagina',
  TodoWrite: 'Werkt zijn takenlijstje bij',
  Task: 'Geeft een deeltaak',
  Agent: 'Geeft een deeltaak',
  Skill: 'Pakt een skill erbij',
  SlashCommand: 'Voert een opdracht uit',
};

/**
 * The progress line ("Zoekt op internet…") while the engine prepares a step; the tool's input is not known yet.
 * `null` = keep the current line (internal housekeeping).
 */
export function cliStatus(tool: string, apps?: AppNames): string | null {
  if (HIDDEN.has(tool)) return null;
  const mcp = mcpLabel(tool, true, apps);
  if (mcp !== null) return mcp ? `${mcp}…` : null;
  return `${RUNNING[tool] || 'Bereidt een stap voor'}…`;
}

// ---------------- ACP agents (OpenCode, Gemini, …) ----------------

/** An ACP tool call as the agent describes it: a title (often just the tool name or a path), a kind and its input. */
export interface AcpCall {
  title?: unknown;
  kind?: unknown;
  rawInput?: any;
  locations?: { path?: unknown }[];
}

/** First line of OpenCode's "execute" code (its code mode), shortened. */
function codeLine(raw: any): string {
  const code = typeof raw?.code === 'string' ? raw.code : '';
  const line = code.split(/\r?\n/).map((l: string) => l.trim()).find((l: string) => l && !l.startsWith('//')) || '';
  return short(line, 100);
}

/** A title the agent wrote for people ("Lees README") is kept; a bare tool name ("execute") or a path is not. */
function wordsTitle(t: string): boolean {
  if (!t || /^[a-z][\w.:-]*$/i.test(t)) return false;
  if (!/\s/.test(t) && /[\\/]/.test(t)) return false;
  return !/^[a-z]:[\\/]/i.test(t);
}

function acpPathOf(c: AcpCall): string {
  const loc = (c.locations || []).map((l) => String(l?.path || '')).find(Boolean);
  return loc || pathsOf(c.rawInput)[0] || (typeof c.rawInput?.filepath === 'string' ? c.rawInput.filepath : '');
}

/**
 * OpenCode's own tools that arrive with only their bare name as title ("websearch", "todowrite", "skill"): the same
 * words as Claude Code's tools of that kind, never the tool name.
 */
function acpBareTool(title: string, raw: any): string | null {
  const t = title.toLowerCase().replace(/[\s_-]+/g, '');
  const str = (v: unknown) => (typeof v === 'string' ? short(v, 120) : '');
  switch (t) {
    case 'websearch':
    case 'codesearch': {
      const q = str(raw?.query);
      return `Zocht op internet${q ? `: ${q}` : ''}`;
    }
    case 'webfetch': {
      const u = str(raw?.url);
      return `Las een webpagina${u ? `: ${u}` : ''}`;
    }
    case 'todowrite':
    case 'todoread':
      return 'Werkte zijn takenlijstje bij';
    case 'skill': {
      const n = str(raw?.name || raw?.skill);
      return `Pakte een skill erbij${n ? `: ${n}` : ''}`;
    }
    case 'task': {
      const d = str(raw?.description);
      return `Gaf een deeltaak${d ? `: ${d}` : ''}`;
    }
  }
  return null;
}

/**
 * OpenCode 2.x "code mode": every tool call is one `execute` step that runs a small program, which calls tools as
 * `tools.<server>.<tool>(…)` and looks them up with `search(…)`. Seen live (acceptance round 6): four "Voerde code uit"
 * lines for a bot that only opened a page and asked the owner to log in. A program that only calls tools is named
 * after the first of them, like any TeamBot step ("Gebruikte de browser"); one that only looks a tool up says so.
 * Real code (fetch, imports, …) stays "Voerde code uit" (null here).
 */
function codeModeCall(raw: unknown): { server: string; tool: string } | 'search' | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const code = raw.replace(/\/\/[^\n]*/g, '');
  if (/(^|[^.\w$])(fetch|require|import|eval|Function)\s*\(|\bnew\s+Function\b|\b(process|Deno|Bun)\./.test(code)) return null;
  const call = /\btools\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/.exec(code);
  if (call) return { server: call[1], tool: call[2] };
  return /(^|[^.\w$])search\s*\(/.test(code) ? 'search' : null;
}

function codeModeLabel(raw: unknown, running = false): string | null {
  const call = codeModeCall(raw);
  if (call === 'search') return running ? 'Zoekt een TeamBot-functie op' : 'Zocht een TeamBot-functie op';
  if (!call) return null;
  return call.server === MCP_SERVER_NAME ? teambotLabel(call.tool, running) : `${running ? 'Gebruikt' : 'Gebruikte'} ${words(call.server)}`;
}

/** "teambot_skill_load", "mcp__teambot__skill_load" → "skill_load" (how ACP agents title a call of TeamBot's tools). */
const TEAMBOT_TITLE = /^(?:mcp__)?teambot(?:__|[_.:/ ])([A-Za-z0-9_-]{1,64})$/;

/**
 * The TeamBot tool an ACP step calls, if that is all it does: OpenCode 1.x titles it "teambot_skill_load", 2.x runs it
 * from a small program (code mode, the first tool it calls). The tool host then reports the result on that same step
 * instead of a second line (B-04: "Pakte een skill erbij" + "TeamBot · Skill laden"). Only names in `names` count.
 */
export function acpTeambotTool(c: AcpCall, names: ReadonlySet<string>): string | null {
  if (c.kind && c.kind !== 'other') return null;
  const call = codeModeCall(c.rawInput?.code);
  if (call && call !== 'search') return call.server === MCP_SERVER_NAME && names.has(call.tool) ? call.tool : null;
  const m = TEAMBOT_TITLE.exec(String(c.title ?? '').trim());
  return m && names.has(m[1]) && !commandOf(c.rawInput) && !(c.locations || []).length ? m[1] : null;
}

/**
 * The line of an ACP step that is not done yet (often next to an approval card). A code-mode call of a TeamBot tool
 * is in the present tense, like a TeamBot tool in a Claude Code run ("Publiceert een website", not "Publiceerde een
 * website" next to the card that still asks, round 6); anything else as `pendingTitle`.
 */
export function acpPendingTitle(c: AcpCall, cwd?: string): string {
  const title = String(c.title ?? '').trim();
  if (!agentTitle(c, title, cwd)) {
    const mode = codeModeLabel(c.rawInput?.code, true);
    if (mode) return mode;
    const tb = TEAMBOT_TITLE.exec(title);
    if (tb) return teambotLabel(tb[1], true);
  }
  return pendingTitle(acpActivity(c, cwd));
}

/**
 * A title the agent wrote for people. Not when it is just the command it runs: OpenCode 2.x titles a shell step with
 * the command itself, so a step read "Get-ChildItem -Force -Recurse | …" instead of "Voerde uit: …" (round 6).
 */
function agentTitle(c: AcpCall, title: string, cwd?: string): boolean {
  if (!wordsTitle(title)) return false;
  const cmd = plainCommand(commandOf(c.rawInput), cwd).replace(/\s+/g, ' ').trim();
  if (!cmd) return true;
  const t = plainCommand(title, cwd).replace(/\s+/g, ' ').replace(/(…|\.\.\.)$/, '').trim();
  return !(t === cmd || (t.length >= 12 && cmd.startsWith(t)));
}

/**
 * The steps line for an ACP tool call, in words: "Las afspraken.md", "Voerde code uit", "Paste plan.md aan". `cwd` is
 * the bot's working folder: OpenCode puts `cd "<that folder>" &&` in front of its commands, which says nothing.
 */
export function acpActivity(c: AcpCall, cwd?: string): string {
  const title = String(c.title ?? '').trim();
  if (agentTitle(c, title, cwd)) return title.slice(0, 200);
  const tb = TEAMBOT_TITLE.exec(title);
  if (tb) return teambotLabel(tb[1], false);
  const bare = acpBareTool(title, c.rawInput);
  if (bare) return bare;
  const mode = codeModeLabel(c.rawInput?.code);
  if (mode) return mode;
  const kind = String(c.kind || '');
  const p = acpPathOf(c);
  const cmd = plainCommand(commandOf(c.rawInput), cwd);
  const code = codeLine(c.rawInput);
  switch (kind) {
    case 'read':
      return `Las ${p ? base(p) : 'een bestand'}`;
    case 'edit':
      return `Paste ${p ? base(p) : 'een bestand'} aan`;
    case 'delete':
      return `Verwijderde ${p ? base(p) : 'een bestand'}`;
    case 'move':
      return `Verplaatste ${p ? base(p) : 'een bestand'}`;
    case 'search':
      return `Zocht in bestanden${c.rawInput?.pattern ? `: ${short(c.rawInput.pattern, 80)}` : ''}`;
    case 'execute':
      return cmd ? `Voerde uit: ${short(cmd, 140)}` : code ? 'Voerde code uit' : 'Voerde een opdracht uit';
    case 'fetch':
      return `Las een webpagina${typeof c.rawInput?.url === 'string' ? `: ${short(c.rawInput.url, 120)}` : ''}`;
    case 'think':
      return 'Dacht na';
  }
  if (code || title === 'execute') return 'Voerde code uit';
  if (cmd) return `Voerde uit: ${short(cmd, 140)}`;
  if (p) return `Werkte met ${base(p)}`;
  return title ? `Deed een stap (${words(title)})` : 'Deed een stap';
}

/** What an ACP agent asks permission for, in words, for the approval card: "Bestand schrijven: notities/plan.md". */
export function acpPermissionSummary(c: AcpCall, paths: string[], cwd: string): string {
  const kind = String(c.kind || '');
  const cmd = plainCommand(commandOf(c.rawInput), cwd);
  const code = codeLine(c.rawInput);
  const rel = paths.map((p) => {
    const r = path.relative(cwd, p);
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : p;
  });
  const list = rel.slice(0, 3).join(', ') + (rel.length > 3 ? ` en nog ${rel.length - 3}` : '');
  const what =
    kind === 'edit' ? 'Bestand schrijven'
    : kind === 'delete' ? 'Bestand verwijderen'
    : kind === 'move' ? 'Bestand verplaatsen'
    : kind === 'read' ? 'Bestand lezen'
    : kind === 'fetch' ? 'Webpagina lezen'
    : '';
  if (cmd) return `Opdracht: ${cmd}`;
  if (what && list) return `${what}: ${list}`;
  if (kind === 'fetch' && typeof c.rawInput?.url === 'string') return `${what}: ${c.rawInput.url}`;
  if (code) return `Code uitvoeren: ${code}`;
  const title = String(c.title ?? '').trim();
  if (wordsTitle(title)) return list ? `${title}: ${list}` : title;
  return list ? `${what || 'Actie'}: ${list}` : what || (title ? `Actie: ${words(title)}` : 'Actie');
}
