import type { Agent, PartGuide, Thread, ToolDef, ToolGroup, ToolOutput, ToolProvider } from '../core/types.js';

/** Narrows the tools of an agent in a thread (e.g. channels cap tools for external senders). May only remove tools. */
export type ToolFilter = (agent: Agent, thread: Thread, tools: ToolDef[]) => ToolDef[] | Promise<ToolDef[]>;

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Parts a bot on "Volledige toegang" does not get by itself: they only work after the owner set something up (a Docker
 * container, his own server over SSH) and are the bot's computer mode, not an extra. `request_part` switches them on.
 */
export const FULL_NEEDS_SETUP: ReadonlySet<string> = new Set(['container', 'remote']);

/** What a tool returns when it cannot do what was asked: the reason, for the bot. */
export const toolError = (text: string): ToolOutput => ({ text, isError: true });

/** Make any string safe as a tool name for every provider (max 64, [a-zA-Z0-9_-]). */
export function toolName(s: string): string {
  let n = s.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (n.length > 64) n = n.slice(0, 55) + '_' + Math.abs(hash(s)).toString(36).slice(0, 8);
  return n;
}
function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();
  private providers: ToolProvider[] = [];
  private filters: ToolFilter[] = [];
  groups = new Map<string, ToolGroup>();

  registerGroup(g: ToolGroup) {
    this.groups.set(g.id, g);
  }

  /**
   * Tool names that were registered a second time (the later one silently replaced the earlier): two parts doing a
   * job under one name. `npm run dup:check` fails when this is not empty. (A provider that gives a per-bot version of
   * its own registered tool, as memory does, is not a second tool and is not counted.)
   */
  duplicates = new Set<string>();

  register(t: ToolDef) {
    if (!NAME_RE.test(t.name)) throw new Error(`Invalid tool name ${t.name}`);
    if (this.tools.has(t.name) && this.tools.get(t.name) !== t) this.duplicates.add(t.name);
    this.tools.set(t.name, t);
  }

  /** Dynamic tools (MCP servers, skills, channels) computed per agent/thread. */
  addProvider(p: ToolProvider) {
    this.providers.push(p);
  }

  /** What a bot must know about a part of its tools (core/types.ts PartGuide), in the order the modules added them. */
  guides: PartGuide[] = [];

  addGuide(g: PartGuide) {
    this.guides.push(g);
  }

  /** Security filters run last; they can only remove tools and fail closed (no tools) when they throw. */
  addFilter(f: ToolFilter) {
    this.filters.push(f);
  }

  get(name: string) {
    return this.tools.get(name);
  }

  list(): ToolDef[] {
    return [...this.tools.values()];
  }

  groupEnabled(agent: Agent, group: string): boolean {
    const g = this.groups.get(group);
    if (g?.always) return true;
    if (agent.tool_groups.includes(group) || agent.tool_groups.includes(group.split(':')[0])) return true;
    // "Volledige toegang": the bot simply has every part (terminal, browser, desktop, channels …), whatever was ticked
    // when it was made. Not the parts that need a setup of their own first (FULL_NEEDS_SETUP), not for a shared bot in
    // a member's conversation, and not when this run was narrowed on purpose (a routine with fewer parts).
    return agent.access_mode === 'full' && !agent.settings?.sharedRun && !agent.settings?.partsNarrowed && !FULL_NEEDS_SETUP.has(group.split(':')[0]);
  }

  async forAgent(agent: Agent, thread: Thread): Promise<ToolDef[]> {
    if (agent.access_mode === 'chat') return [];
    const out = new Map<string, ToolDef>();
    for (const t of this.tools.values()) if (this.groupEnabled(agent, t.group)) out.set(t.name, t);
    for (const p of this.providers) {
      try {
        for (const t of await p(agent, thread)) if (this.groupEnabled(agent, t.group) && NAME_RE.test(t.name)) out.set(t.name, t);
      } catch (e) {
        console.error('[tools] provider failed', e);
      }
    }
    let list = [...out.values()];
    for (const f of this.filters) {
      try {
        const keep = new Set((await f(agent, thread, list)).map((t) => t.name));
        list = list.filter((t) => keep.has(t.name));
      } catch (e) {
        console.error('[tools] filter failed', e);
        list = [];
      }
    }
    return list;
  }
}
