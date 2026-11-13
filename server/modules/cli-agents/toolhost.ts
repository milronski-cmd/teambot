import fs from 'node:fs';
import crypto from 'node:crypto';
import type { ToolDef, ToolOutput } from '../../core/types.js';
import { redact } from '../../core/secrets.js';
import { estimateTokens } from '../../core/tokens.js';
import { executeTool, stepSummary } from '../../tools/execute.js';
import { mapOwnWords, words } from '../../../shared/i18n-core.js';
import { CALL_NAME, FIND_NAME, mentions, onDemand, specTokens, type OnDemand } from '../../tools/selection.js';
import { cutMiddle, saverSettings } from '../../agent/context-budget.js';
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
 * model. Tools the Broker would deny in the bot's mode are left out of the list. Called by name, such a tool (what
 * "Alleen lezen" leaves out, or what the owner forbade himself: his "nooit" for a tool, a rule of his) still goes to
 * the gate, which refuses it in the same words an API model reads, before anything is asked.
 *
 * A small list on every engine (tools/selection.ts, the same as for API bots): the core of the bot's tools, plus
 * `tools_find` and `tools_call` for every other tool it has. A `tools_call` is turned into the call it names before
 * the gate, so it is checked, approved, logged and shown as that tool. The list is the same in every turn (prompt
 * caching) and needs nothing from the engine: no second listing, no tool search of its own.
 */

export type Engine = 'claude' | 'codex' | 'acp';

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

/** A tool result for the CLI's model: enough for a long log or page; beyond it the first and last half. */
const MAX_TEXT = 100_000;
const MAX_IMAGES = 2;
const IMAGE = /^image\/(png|jpeg|gif|webp)$/;

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
  /** Estimated tokens of the listed definitions (with tools_find and tools_call). */
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

/**
 * Short guidance for the CLI in its instructions, next to the system prompt every engine gets. `names`: the tools in
 * the CLI's list. Only what the tool definitions and that prompt do not say themselves (a bot on "Volledige toegang"
 * reads there how it works).
 */
export function toolsNote(names: string[], engine: Engine, o: { full?: boolean } = {}): string {
  if (!names.length) return '';
  const has = (n: string) => names.includes(n);
  const prefix = engine === 'claude' ? 'mcp__teambot__<naam>' : engine === 'codex' ? 'teambot.<naam> (MCP-server "teambot")' : 'teambot_<naam> of via MCP-server "teambot"';
  const lines = ['## TeamBot-tools', `De tools van TeamBot staan in je lijst als ${prefix}.`];
  if (has('dossier_write') || has('memory_search')) lines.push('- Onthouden en terugzoeken doe je in TeamBot, niet in eigen geheugen- of notitiebestanden: alleen dat zien de gebruiker en je andere gesprekken.');
  if (!o.full) lines.push('- Acties met impact vragen toestemming via TeamBot. Wordt een actie geweigerd, probeer diezelfde actie dan niet via een omweg; een nieuwe opdracht van de gebruiker voer je gewoon uit (TeamBot vraagt dan opnieuw).');
  return lines.join('\n');
}

/** provider_state[<engine config>].teambotTold[<bot id>]: what this bot's session in this chat was already given (selection.ts `told`). */
const TOLD = 'teambotTold';

export interface ToolHostDeps {
  engine: Engine;
  /** Pause the CLI's idle timer while a TeamBot tool runs or waits for a human. */
  hold?(on: boolean): void;
}

export interface ToolHost extends ToolHandler {
  /** The tool names in the CLI's list this run (the core, tools_find, tools_call): for its allow rules and the tool note. */
  names(): Promise<string[]>;
}

export function teambotTools(s: RunScope, d: ToolHostDeps): ToolHost {
  const { ctx, agent } = s;
  const exclude = nativeExclusions(d.engine, agent.access_mode);
  // "Sleutels voor scripts" (module script-keys) live only in TeamBot's own run_command, where TeamBot hides their values
  // before the CLI's model sees the output; the CLI's own terminal never gets them. A bot with keys keeps run_command.
  if (ctx.services.scriptKeys?.namesFor?.(agent)?.length) exclude.delete('run_command');
  // `refused`: tools the bot has but the owner forbade outright (his "nooit" for a tool, a rule of his).
  let cache: { at: number; list: ToolDef[]; refused: ToolDef[] } | null = null;
  let holds = 0;
  const hold = (on: boolean) => {
    holds += on ? 1 : -1;
    if (on && holds === 1) d.hold?.(true);
    if (!on && holds === 0) d.hold?.(false);
  };

  const current = async (fresh = false): Promise<ToolDef[]> => {
    if (!s.thread || !s.run || agent.access_mode === 'chat') return [];
    if (!fresh && cache && Date.now() - cache.at < 15_000) return cache.list;
    const all = (await ctx.tools.forAgent(agent, s.thread)).filter((t) => !exclude.has(t.name));
    const list = all.filter((t) => ctx.broker.decide(agent, t) !== 'deny');
    // What may not run (what "Alleen lezen" leaves out, the owner's "nooit" for a tool, a rule of his) is not in the
    // list, but is kept for a call by name: the gate refuses it in the words a model over an API key reads (`call`).
    cache = { at: Date.now(), list, refused: all.filter((t) => !list.includes(t)) };
    s.apps = appNames(list);
    return list;
  };

  // The list (tools/selection.ts): the core, and tools_find and tools_call for the rest. What a first use of a part
  // brought along (its guide, the fields of its other tools) is in the engine's session from then on: remembered with
  // the session (thread.provider_state), so a later turn of the same session does not get it again. A new session
  // starts empty.
  const saver = saverSettings(ctx, agent);
  const mine = () => (s.thread && ctx.store.thread(s.thread.id))?.provider_state?.[s.cfg.id];
  const kept = mine()?.[TOLD]?.[agent.id];
  const told = new Set<string>(s.req.sessionId && Array.isArray(kept) ? kept.filter((x: unknown) => typeof x === 'string').slice(0, 200) : []);
  // A new session that still has the list of an older one: written (empty) with the first listing.
  let saved = !s.req.sessionId && Array.isArray(kept) && kept.length ? -1 : told.size;
  const saveTold = () => {
    const t = s.thread && ctx.store.thread(s.thread.id);
    if (!t || told.size === saved) return;
    saved = told.size;
    const ps = t.provider_state || {};
    const cur = ps[s.cfg.id] || {};
    ctx.store.updateThread(t.id, { provider_state: { ...ps, [s.cfg.id]: { ...cur, [TOLD]: { ...(cur[TOLD] || {}), [agent.id]: [...told].sort() } } } });
  };
  let made: { of: ToolDef[]; demand: OnDemand } | null = null;
  // The message this run answers: a tool it names is in the list for this run (selection.ts `wanted`).
  const asked = ctx.store.message(s.run?.input_message_id)?.content || '';
  const demandOf = (tools: ToolDef[]): OnDemand => onDemand({ tools, groups: ctx.tools.groups, guides: ctx.tools.guides, who: { agent, thread: s.thread!, userId: s.thread!.user_id }, on: saver.on && saver.selectTools, told, asked });
  const demandFor = (all: ToolDef[]): OnDemand => {
    if (made?.of === all) return made.demand;
    const demand = demandOf(all);
    made = { of: all, demand };
    return demand;
  };

  let listed = false;

  const result = (out: ToolOutput): McpCallResult => {
    const content: any[] = [{ type: 'text', text: cutMiddle(out.text || (out.isError ? 'Mislukt' : 'Klaar'), MAX_TEXT) }];
    let images = 0;
    for (const a of attachmentRows(ctx, out.attachments)) {
      if (images >= MAX_IMAGES || !IMAGE.test(a.mime) || a.size > 4_500_000 || !fs.existsSync(a.path)) continue;
      content.push({ type: 'image', data: fs.readFileSync(a.path).toString('base64'), mimeType: a.mime });
      images++;
    }
    return { content, isError: !!out.isError };
  };

  // Claude Code calls a tool only when its list has the name: a TeamBot tool that the bot's instructions name but that is
  // outside the list (`teambot_find` for a bot that is not the main bot) was refused as "No such tool available" before
  // the bot went through tools_call (12 nov). Such a tool goes along by name only, behind Claude Code's own tool search
  // (its definition loads when the bot calls it; a direct call works the first time), for a few tokens per step.
  const named = (all: ToolDef[]): ToolDef[] => (d.engine === 'claude' ? demandFor(all).rest.filter((t) => mentions(s.req.system, t.name)) : []);

  const host: ToolHost = {
    async names() {
      const all = await current();
      return all.length ? [...demandFor(all).listed, ...named(all)].map((t) => t.name) : [];
    },
    async list() {
      const all = await current();
      if (!all.length) return [];
      const d = demandFor(all);
      // Never behind Claude Code's own tool search (ENABLE_TOOL_SEARCH, on by default in 2.1): the list is small on
      // purpose, and a tool that first has to be looked up costs a step every time (and went unused: a bot went
      // looking for TeamBot's screens in the browser instead).
      const specs = [...d.listed.map((t) => ({ ...toolSpec(t), _meta: { 'anthropic/alwaysLoad': true } })), ...named(all).map((t) => ({ ...toolSpec(t), _meta: { 'anthropic/alwaysLoad': false } }))];
      // The list the turn starts with (what its model calls carry), for the estimate on the answer.
      // A tool listed by name only costs its name per step (Claude Code loads its definition when the bot calls it).
      const loaded = specs.filter((x) => x._meta['anthropic/alwaysLoad'] !== false);
      const byName = specs.filter((x) => x._meta['anthropic/alwaysLoad'] === false).map((x) => `mcp__teambot__${x.name}`);
      if (s.run && !listed) remember(s.run.id, { tokens: mcpTokens(loaded) + (byName.length ? estimateTokens(byName.join(' ')) : 0), full: mcpTokens(all.map(toolSpec)), sent: d.active ? d.listed.length - 2 : all.length, of: all.length, leftOut: d.leftOut });
      listed = true;
      saveTold();
      return specs;
    },
    async call(asked, askedArgs, signal) {
      if (!s.thread || !s.run) return { content: [{ type: 'text', text: 'Geen TeamBot-gesprek voor deze beurt.' }], isError: true };
      if (s.signal.aborted) return { content: [{ type: 'text', text: 'Gestopt.' }], isError: true };
      let all = await current();
      // A tools_call is the call it names from here on: checked, approved, logged and shown as that tool.
      let real = demandFor(all).resolve(asked, askedArgs);
      const notListed = () => real.name !== FIND_NAME && (real.name === CALL_NAME || !all.some((t) => t.name === real.name));
      // Not a tool of this run as far as the (briefly kept) list knows: look again, a part may just have been switched on.
      if (notListed()) {
        all = await current(true);
        real = demandFor(all).resolve(asked, askedArgs);
      }
      // A tool the owner forbade outright is not in the bot's list. Asked for by name it still goes to the gate, so the
      // bot reads why (the owner's rule itself), in the words a model over an API key gets, not "unknown tool".
      const kept = notListed() ? cache?.refused || [] : [];
      const meant = kept.length ? demandOf([...all, ...kept]).resolve(asked, askedArgs) : null;
      const refused = meant ? kept.find((t) => t.name === meant.name) : undefined;
      if (refused) real = meant!;
      const { name, args } = real;
      const demand = demandFor(all);
      const tools = refused ? [...demand.callable, refused] : demand.callable;
      const sig = AbortSignal.any([s.signal, signal]);
      const callId = 'mcp_' + crypto.randomBytes(8).toString('hex');
      const tool = tools.find((t) => t.name === name);
      const said = tool ? stepSummary(tool, args) : { summary: name };
      const summary = withoutOwnFolder(said.summary, agent);
      // The owner's line: TeamBot's words in his language, the values as written (never the bot's own folder either).
      const line = said.words && mapOwnWords(said.words, (v) => withoutOwnFolder(v, agent));
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
          // On the engine's own step for this call when it has one (B-04: one call, one line); the engine knows the
          // step by the tool it called (`asked`: tools_call for a tool outside its list).
          const shown = line && words(r.denied ? 'TeamBot · {0} — geweigerd' : r.out.isError ? 'TeamBot · {0} — mislukt' : 'TeamBot · {0}', line);
          if (s.teambotResult) s.teambotResult(asked, kind, title, detail, facts, shown);
          else s.activity(kind, title, detail, facts, { words: shown });
        }
        for (const a of r.out.attachments || []) s.emit({ type: 'attachment', ref: a });
        if (!r.out.isError && Array.isArray(r.out.data?.plan)) s.emit({ type: 'plan', steps: r.out.data.plan });
        const out = await demand.after(r.tool, args, r.out, r.denied);
        saveTold();
        return result(out);
      } finally {
        hold(false);
      }
    },
  };
  return host;
}
