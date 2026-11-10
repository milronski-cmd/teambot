import fs from 'node:fs';
import crypto from 'node:crypto';
import type { ChatMsg, ToolDef, ToolOutput } from '../../core/types.js';
import { redact } from '../../core/secrets.js';
import { executeTool, safeSummary } from '../../tools/execute.js';
import { LOADER_NAME, bundleId, loaderTool, selectTools, specTokens } from '../../tools/selection.js';
import { saverSettings } from '../../agent/context-budget.js';
import { attachmentRows } from '../../agent/history.js';
import type { McpCallResult, McpToolSpec, ToolHandler } from './bridge.js';
import type { RunScope } from './context.js';
import { appNames, teambotFacts, teambotLabel, withoutOwnFolder } from './activity-labels.js';
import { approvalWhat } from '../../../shared/approvalLabels.js';

/**
 * TeamBot's own tools for a CLI agent run (served over MCP by the bridge): memory and dossiers, team work
 * (ask/delegate to other bots), the bot's own browser and desktop control, workspace snapshots, skills,
 * routines, channels and the bot's connected apps (MCP connectors are proxied, so their OAuth tokens never
 * reach the CLI). Everything is scoped to this run's user, bot, thread and run, and goes through
 * executeTool → the same Broker decision, tool policy, Auto Review and human approvals as API-provider runs.
 *
 * Not offered: TeamBot tools that duplicate the CLI's own file/shell tools (those are already gated by the
 * CLI's permission bridge in TeamBot); two ways to edit the same file with different rules only confuse the
 * model. Tools the Broker would deny in the bot's mode are left out of the list (and refused when called).
 *
 * Fewer tools per turn (0.4.4, as API bots since 0.4 in tools/selection.ts): an engine that reads the list again after
 * `notifications/tools/list_changed` gets only the parts it likely needs this turn, plus `tools_load` for the rest.
 * Loading a part answers the call and tells the CLI the list changed; the CLI then lists again and has those tools from
 * its next step on. The parts a session got stay for the rest of that session (thread.provider_state), so the list only
 * grows and stays byte-identical between turns (prompt caching). The bot can always use every tool it may use: the
 * selection only decides what is listed, a call is checked against the whole set.
 */

export type Engine = 'claude' | 'codex' | 'acp';

/**
 * Engines that list TeamBot's tools again after `notifications/tools/list_changed`; the others get the whole set.
 * Claude Code: yes, when the server says `capabilities.tools.listChanged` (checked in 2.1.319). Codex: only behind its
 * feature flag `mcp_tool_list_changed` (0.16x), so not by default. OpenCode (ACP): not checked.
 */
export const RELISTS: ReadonlySet<Engine> = new Set<Engine>(['claude']);

/** TeamBot tools that the CLIs have natively (and that TeamBot already gates through the CLI's permission flow). */
export const NATIVE_TOOLS = ['list_files', 'read_file', 'write_file', 'edit_file', 'search_files', 'delete_file', 'run_command'];

/** Which TeamBot tools to leave out for an engine in a mode. */
export function nativeExclusions(engine: Engine, mode: string): Set<string> {
  const out = new Set(NATIVE_TOOLS);
  if (engine === 'claude') {
    // Claude Code has its own WebSearch. It has no WebFetch (not in current versions, and --restricted drops it), so
    // TeamBot's web_fetch stays available to read a page.
    out.add('web_search');
  }
  return out;
}

export { withoutOwnFolder };

const MAX_TEXT = 30_000;
const MAX_IMAGES = 2;
const IMAGE = /^image\/(png|jpeg|gif|webp)$/;

function truncate(s: string): string {
  if (s.length <= MAX_TEXT) return s;
  const half = Math.floor(MAX_TEXT / 2) - 100;
  return s.slice(0, half) + `\n… (${s.length - 2 * half} tekens weggelaten) …\n` + s.slice(-half);
}

function inputSchema(p: any) {
  const s = p && typeof p === 'object' && p.type === 'object' ? { ...p } : { type: 'object', properties: {} };
  if (!s.properties || typeof s.properties !== 'object') s.properties = {};
  delete s.$schema;
  return s;
}

export function toolSpec(t: Pick<ToolDef, 'name' | 'description' | 'parameters' | 'risk'>): McpToolSpec {
  return {
    name: t.name,
    description: String(t.description || t.name).slice(0, 2000),
    inputSchema: inputSchema(t.parameters),
    annotations: { readOnlyHint: t.risk === 'read', destructiveHint: t.risk === 'danger', idempotentHint: false, openWorldHint: /^(web_|browser_|mcp_|channel_|remote_|desktop_)/.test(t.name) },
  };
}

/** Estimated tokens of tool definitions as the model sees them (name, description, schema), as for API bots. */
export const mcpTokens = (specs: McpToolSpec[]) => specTokens(specs.map((x) => ({ name: x.name, description: x.description, parameters: x.inputSchema })));

/** What the tool host listed first in a run, for the context estimate on the answer (agent/context-budget.ts). */
export interface ServedTools {
  /** Estimated tokens of the listed definitions (with tools_load). */
  tokens: number;
  /** Estimated tokens of the whole set the bot may use. */
  full: number;
  sent: number;
  of: number;
  leftOut: string[];
}
const served = new Map<string, ServedTools>();
/** The tools a run's CLI got listed at the start of the turn (read once, after the turn). */
export function servedTools(runId: string): ServedTools | null {
  const v = served.get(runId) || null;
  served.delete(runId);
  return v;
}
function remember(runId: string, v: ServedTools) {
  served.delete(runId);
  served.set(runId, v);
  while (served.size > 200) served.delete(served.keys().next().value!);
}

/** provider_state[<engine config>].teambotParts[<bot id>]: the parts this bot's session in this chat was given. */
const PARTS = 'teambotParts';

/** Tool groups with example names; only examples the bot really has are named (readonly offers fewer tools). */
const GROUP_HINTS: [RegExp, string, string[]][] = [
  [/^(memory_|dossier_)/, 'geheugen en dossiers', ['memory_search', 'memory_remember', 'dossier_get']],
  [/^(message_bot|delegate_task|broadcast|handoff|delegation_status|team_status|task_)/, 'samenwerken met andere bots en het takenbord', ['message_bot', 'delegate_task']],
  [/^browser_/, 'je eigen TeamBot-browser', ['browser_open', 'browser_snapshot']],
  [/^desktop_/, 'het bureaublad van de gebruiker (elke actie met toestemming)', ['desktop_computer']],
  [/^(skill_)/, 'skills', ['skill_load']],
  [/^routine_/, 'routines', []],
  [/^(workspace_snapshot|rehearsal_)/, 'reservekopieën en repetitie van je werkmap', []],
  [/^channel_/, 'gekoppelde kanalen (met toestemming)', ['channel_send']],
  [/^mcp_/, 'gekoppelde apps (tools die met mcp beginnen)', []],
  [/^read_document$/, 'pdf- en Word-bestanden in je mappen lezen, zonder script of terminal', ['read_document']],
  [/^(ask_user|ask_form|notify_user|show_html|share_file)$/, 'de gebruiker iets vragen, melden of een bestand delen in de chat', []],
];

/** Short guidance for the CLI (MCP server instructions and the system prompt); names only tools in `names`. */
export function toolsNote(names: string[], engine: Engine): string {
  if (!names.length) return '';
  const has = (n: string) => names.includes(n);
  const groups = GROUP_HINTS.filter(([re]) => names.some((n) => re.test(n))).map(([re, label, examples]) => {
    const ex = examples.filter(has);
    return ex.length ? `${label} (${ex.join(', ')}${names.filter((n) => re.test(n)).length > ex.length ? ', …' : ''})` : label;
  });
  const prefix = engine === 'claude' ? 'mcp__teambot__<naam>' : engine === 'codex' ? 'teambot.<naam> (MCP-server "teambot")' : 'teambot_<naam> of via MCP-server "teambot"';
  const lines = ['## TeamBot-tools', `Naast je eigen tools heb je de tools van TeamBot via de MCP-server "teambot" (namen als ${prefix}): ${groups.join('; ') || names.slice(0, 12).join(', ')}.`];
  if (has('memory_remember') && has('memory_search')) lines.push('- Onthouden en terugzoeken gaat altijd via de TeamBot-geheugentools (memory_remember, memory_search), niet via je eigen geheugen- of notitiebestanden: alleen dan ziet de gebruiker het en kunnen andere gesprekken het terugvinden.');
  else if (has('memory_search')) lines.push('- Terugzoeken gaat via het TeamBot-geheugen (memory_search), niet via je eigen geheugen- of notitiebestanden.');
  if (has('read_document')) lines.push('- Een pdf of Word-bestand (.docx) in je mappen lees je met read_document: één leesstap zonder toestemming. Schrijf daar geen script of terminalopdracht voor.');
  if (has('plan_update')) lines.push('- Taak van drie of meer stappen: zet je plan met plan_update als checklist in de chat en werk het na elke stap bij (de gebruiker ziet het live).');
  const team = ['message_bot', 'delegate_task'].filter(has);
  if (team.length) lines.push(`- Een andere bot iets vragen of werk geven: ${team.join(' of ')}.`);
  if (names.some((n) => n.startsWith('browser_'))) lines.push('- Websites voor de gebruiker openen en bedienen: de browser-tools van TeamBot (dat is de eigen browser van deze bot in TeamBot).');
  if (has(LOADER_NAME)) lines.push(`- Niet al deze tools staan al in je lijst. Mis je er een, haal het onderdeel dan op met ${LOADER_NAME} (één stap, zonder toestemming); daarna staat het in je lijst.`);
  lines.push('- Acties met impact vragen toestemming via TeamBot. Wordt een actie geweigerd, probeer diezelfde actie dan niet via een omweg; een nieuwe opdracht van de gebruiker voer je gewoon uit (TeamBot vraagt dan opnieuw).');
  return lines.join('\n');
}

export interface ToolHostDeps {
  engine: Engine;
  /** Pause the CLI's idle timer while a TeamBot tool runs or waits for a human. */
  hold?(on: boolean): void;
}

export interface ToolHost extends ToolHandler {
  /**
   * Every tool name this run may use (after policy filtering), plus tools_load when the list leaves parts out: for the
   * CLI's allow rules and the tool note. The list itself (`list()`) can be smaller.
   */
  names(): Promise<string[]>;
}

export function teambotTools(s: RunScope, d: ToolHostDeps): ToolHost {
  const { ctx, agent } = s;
  const exclude = nativeExclusions(d.engine, agent.access_mode);
  // "Sleutels voor scripts" (module script-keys) live only in TeamBot's own run_command, where TeamBot hides their values
  // before the CLI's model sees the output; the CLI's own terminal never gets them. A bot with keys keeps run_command.
  if (ctx.services.scriptKeys?.namesFor?.(agent)?.length) exclude.delete('run_command');
  let cache: { at: number; list: ToolDef[] } | null = null;
  let holds = 0;
  const hold = (on: boolean) => {
    holds += on ? 1 : -1;
    if (on && holds === 1) d.hold?.(true);
    if (!on && holds === 0) d.hold?.(false);
  };

  const current = async (fresh = false): Promise<ToolDef[]> => {
    if (!s.thread || !s.run || agent.access_mode === 'chat') return [];
    if (!fresh && cache && Date.now() - cache.at < 15_000) return cache.list;
    const all = await ctx.tools.forAgent(agent, s.thread);
    const list = all.filter((t) => !exclude.has(t.name) && ctx.broker.decide(agent, t) !== 'deny');
    cache = { at: Date.now(), list };
    s.apps = appNames(list);
    return list;
  };

  // Fewer tools per turn (see the top of this file), for engines that list again after list_changed.
  const saver = saverSettings(ctx, agent);
  const select = RELISTS.has(d.engine) && saver.on && saver.selectTools;
  const about = [agent.instructions || '', agent.description || '', agent.role || ''].join('\n');
  const room = !!s.thread && (s.thread.kind === 'room' || !!s.thread.room_id);
  let botNames: string[] | null = null;
  const savedParts = (): string[] => {
    const v = (s.thread && ctx.store.thread(s.thread.id))?.provider_state?.[s.cfg.id]?.[PARTS]?.[agent.id];
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 200) : [];
  };
  const parts = new Set<string>(select ? savedParts() : []);
  const saveParts = () => {
    const t = s.thread && ctx.store.thread(s.thread.id);
    if (!t) return;
    const ps = t.provider_state || {};
    const mine = ps[s.cfg.id] || {};
    ctx.store.updateThread(t.id, { provider_state: { ...ps, [s.cfg.id]: { ...mine, [PARTS]: { ...(mine[PARTS] || {}), [agent.id]: [...parts].sort() } } } });
  };
  /** The tools to list now: every tool, or the selection plus tools_load (null). */
  const chosen = (all: ToolDef[]): { tools: ToolDef[]; loader: ToolDef | null; leftOut: string[] } => {
    if (!select || all.length < 2) return { tools: all, loader: null, leftOut: [] };
    if (!botNames) {
      try {
        botNames = ctx.store.all<{ name: string }>('SELECT name FROM agents WHERE user_id = ? AND id != ? AND archived = 0', agent.user_id, agent.id).map((r) => r.name);
      } catch {
        botNames = [];
      }
    }
    // The new messages and this turn's context (what the CLI gets as its prompt); the parts this session already has
    // count as loaded, so they stay.
    const messages: ChatMsg[] = [{ role: 'user', content: s.req.prompt || '' }];
    if (parts.size) messages.push({ role: 'assistant', content: '', toolCalls: [{ id: 'teambot_parts', name: LOADER_NAME, args: { names: [...parts] } }] });
    const sel = selectTools({ tools: all, groups: ctx.tools.groups, system: s.req.system || '', about, messages, budget: saver.toolTokens, room, botNames });
    if (!sel.leftOut.length) return { tools: all, loader: null, leftOut: [] };
    const sent = new Set(sel.specs.map((x) => x.name));
    const tools = all.filter((t) => sent.has(t.name));
    const loaderSpec = sel.specs.find((x) => x.name === LOADER_NAME)!;
    const loader: ToolDef = { ...loaderTool(all, ctx.tools.groups), description: loaderSpec.description, parameters: loaderSpec.parameters };
    return { tools, loader, leftOut: sel.leftOut.map((b) => b.label) };
  };
  /** Keep what this session was given (only growing), so the list stays the same next turn. */
  const keep = (tools: ToolDef[]) => {
    if (!select) return;
    const n = parts.size;
    for (const t of tools) parts.add(bundleId(t));
    if (parts.size !== n) saveParts();
  };

  let listed = false;

  const result = (out: ToolOutput): McpCallResult => {
    const content: any[] = [{ type: 'text', text: truncate(out.text || (out.isError ? 'Mislukt' : 'Klaar')) }];
    let images = 0;
    for (const a of attachmentRows(ctx, out.attachments)) {
      if (images >= MAX_IMAGES || !IMAGE.test(a.mime) || a.size > 4_500_000 || !fs.existsSync(a.path)) continue;
      content.push({ type: 'image', data: fs.readFileSync(a.path).toString('base64'), mimeType: a.mime });
      images++;
    }
    return { content, isError: !!out.isError };
  };

  const host: ToolHost = {
    async names() {
      const all = await current();
      return [...all.map((t) => t.name), ...(chosen(all).loader ? [LOADER_NAME] : [])];
    },
    instructions() {
      return cache ? toolsNote([...cache.list.map((t) => t.name), ...(chosen(cache.list).loader ? [LOADER_NAME] : [])], d.engine) : '';
    },
    async list() {
      const all = await current();
      const c = chosen(all);
      keep(c.tools);
      // tools_load is small and always directly callable: Claude Code never defers it behind its own tool search
      // (ENABLE_TOOL_SEARCH, on by default in 2.1), so loading a part is one step, not two.
      const specs = [...c.tools.map(toolSpec), ...(c.loader ? [{ ...toolSpec(c.loader), _meta: { 'anthropic/alwaysLoad': true } }] : [])];
      // The list the turn starts with (what most of its model calls carry), for the estimate on the answer.
      if (s.run && !listed) remember(s.run.id, { tokens: mcpTokens(specs), full: mcpTokens(all.map(toolSpec)), sent: c.tools.length, of: all.length, leftOut: c.leftOut });
      listed = true;
      return specs;
    },
    async call(name, args, signal) {
      if (!s.thread || !s.run) return { content: [{ type: 'text', text: 'Geen TeamBot-gesprek voor deze beurt.' }], isError: true };
      if (s.signal.aborted) return { content: [{ type: 'text', text: 'Gestopt.' }], isError: true };
      let tools = await current();
      if (!tools.some((t) => t.name === name)) tools = await current(true);
      // tools_load: checked against every tool this run may use; the CLI hears that its list changed.
      const loading = select && name === LOADER_NAME;
      if (loading) tools = [...tools, loaderTool(tools, ctx.tools.groups)];
      const sig = AbortSignal.any([s.signal, signal]);
      const callId = 'mcp_' + crypto.randomBytes(8).toString('hex');
      const tool = tools.find((t) => t.name === name);
      const summary = withoutOwnFolder(tool ? safeSummary(tool, args) : name, agent);
      hold(true);
      try {
        const r = await executeTool({
          ctx,
          agent,
          thread: s.thread,
          run: s.run,
          tools,
          name,
          args: args && typeof args === 'object' && !Array.isArray(args) ? args : {},
          callId,
          signal: sig,
          onState: (st) => {
            // In words ("Wacht op toestemming: iets over je onthouden" / "… voor GitHub"), never the tool id.
            if (st === 'waiting') s.activity('permission', tool?.app ? `Wacht op toestemming voor ${tool.app}` : `Wacht op toestemming: ${approvalWhat({ tool: name, risk: tool?.risk || 'write', input: args })}`, summary);
          },
          progress: (text) => s.emit({ type: 'status', text: `${teambotLabel(name, true, s.apps)}: ${text}`.slice(0, 160) }),
        });
        const kind = r.denied ? 'denied' : r.out.isError ? 'tool_error' : 'tool_result';
        if (!(name === 'plan_update' && kind === 'tool_result')) {
          const title = `TeamBot · ${redact(summary).slice(0, 200)}${r.denied ? ' — geweigerd' : r.out.isError ? ' — mislukt' : ''}`;
          const detail = (r.out.text || '').slice(0, 600) || undefined;
          const facts = r.denied ? undefined : teambotFacts(name, args, tool?.app);
          // On the engine's own step for this call when it has one (B-04: one call, one line).
          if (s.teambotResult) s.teambotResult(name, kind, title, detail, facts);
          else s.activity(kind, title, detail, facts);
        }
        for (const a of r.out.attachments || []) s.emit({ type: 'attachment', ref: a });
        if (!r.out.isError && Array.isArray(r.out.data?.plan)) s.emit({ type: 'plan', steps: r.out.data.plan });
        if (loading && !r.out.isError && Array.isArray(r.out.data?.loaded)) {
          const n = parts.size;
          for (const id of r.out.data.loaded) if (typeof id === 'string') parts.add(id);
          if (parts.size === n) return result(r.out);
          saveParts();
          return { ...result(r.out), listChanged: true };
        }
        // A tool that was not listed (known from an earlier list of this session): its part stays from now on.
        if (tool && !r.denied) keep([tool]);
        return result(r.out);
      } finally {
        hold(false);
      }
    },
  };
  return host;
}
