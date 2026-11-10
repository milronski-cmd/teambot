import type { Agent, Thread, ToolDef, ToolGroup, ToolProvider } from '../core/types.js';

/** Narrows the tools of an agent in a thread (e.g. channels cap tools for external senders). May only remove tools. */
export type ToolFilter = (agent: Agent, thread: Thread, tools: ToolDef[]) => ToolDef[] | Promise<ToolDef[]>;

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

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

  register(t: ToolDef) {
    if (!NAME_RE.test(t.name)) throw new Error(`Invalid tool name ${t.name}`);
    this.tools.set(t.name, t);
  }

  /** Dynamic tools (MCP servers, skills, channels) computed per agent/thread. */
  addProvider(p: ToolProvider) {
    this.providers.push(p);
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
    return agent.tool_groups.includes(group) || agent.tool_groups.includes(group.split(':')[0]);
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
