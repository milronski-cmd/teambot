import { create } from 'zustand';
import { api, on } from './api';
import type { Agent, Approval, Message, ProviderView, Run, Thread, User } from './types';
import { toolLabel } from '../shell/toolLabels';

/** "Tool voorbereiden: mcp__teambot__ask_form" (raw tool id from the server) → "Vraagt je om gegevens…". */
export function statusText(text: string): string {
  const m = /^Tool voorbereiden: (.+)$/.exec(text || '');
  if (!m) return text;
  const name = m[1].replace(/^mcp__teambot__/, '');
  const label = toolLabel({ name }, true);
  return label === name.replace(/_/g, ' ') ? 'Bereidt een stap voor…' : `${label}…`;
}

interface State {
  me: User | null;
  mode: 'desktop' | 'server';
  /** This app runs on a paired phone (a device session): a few things that hand out access stay on the computer. */
  device: boolean;
  agents: Agent[];
  /** Bots others share with the team (server mode), shown under "Gedeeld"; never in `agents` (those are your own). */
  shared: Agent[];
  threads: Thread[];
  providers: ProviderView[];
  approvals: Approval[];
  runs: Run[];
  settings: Record<string, any>;
  /** messages per thread id (loaded lazily) */
  messages: Record<string, Message[]>;
  /** live status line per message id */
  status: Record<string, string>;
  /** The server's latest sign of life per busy run (`run.alive`, at most every 10 s); gone when the run ends. */
  alive: Record<string, RunAlive>;
  /**
   * How each bot's most recent run ended (this session), for its face: error → "problem", done → "finished" for a
   * moment; budgetUntil: stopped by the daily budget until then → "daglimiet bereikt".
   */
  finished: Record<string, { status: Run['status']; at: number; threadId: string; budgetUntil?: number }>;
  online: boolean;
  load(): Promise<void>;
  loadThread(id: string): Promise<{ thread: Thread; canResume: boolean; resumeReason?: 'interrupted' | 'stopped' | null } | null>;
  refreshThreads(): Promise<void>;
  refreshAgents(): Promise<void>;
  refreshShared(): Promise<void>;
  refreshProviders(): Promise<void>;
  refreshApprovals(): Promise<void>;
}

/** The server's sign of life of a busy run. Times are the server's clock, except `receivedAt` (this browser's). */
export interface RunAlive {
  lastActivityAt: number;
  at: number;
  receivedAt: number;
  doing?: string;
  /** CLI engines: whether the engine's process still exists. */
  process?: 'alive' | 'gone';
}

/** Add or update by id (a bot that arrives both from an API answer and a live event must not appear twice). */
export const upsert = <T extends { id: string }>(list: T[], item: T, front = false): T[] => {
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) {
    const copy = list.slice();
    copy[i] = { ...copy[i], ...item };
    return copy;
  }
  return front ? [item, ...list] : [...list, item];
};

export const useApp = create<State>((set, get) => ({
  me: null,
  mode: 'desktop',
  device: false,
  agents: [],
  shared: [],
  threads: [],
  providers: [],
  approvals: [],
  runs: [],
  settings: {},
  messages: {},
  status: {},
  alive: {},
  finished: {},
  online: false,
  async load() {
    const [me, agents, threads, providers, approvals, runs, settings, shared] = await Promise.all([
      api.get('/me'),
      api.get('/agents'),
      api.get('/threads'),
      api.get('/providers'),
      api.get('/approvals'),
      api.get('/runs'),
      api.get('/settings'),
      api.get<any[]>('/agents/shared').catch(() => []),
    ]);
    set({ me: me.user, mode: me.mode, device: me.session?.kind === 'device', agents, threads, providers, approvals, runs, settings, shared: shared.map(sharedAgent) });
  },
  async loadThread(id) {
    try {
      const r = await api.get(`/threads/${id}`);
      set((s) => ({
        messages: { ...s.messages, [id]: r.messages },
        threads: upsert(s.threads, r.thread),
        runs: [...s.runs.filter((x) => x.thread_id !== id), ...r.runs],
      }));
      return { thread: r.thread, canResume: r.canResume, resumeReason: r.resumeReason ?? null };
    } catch {
      return null;
    }
  },
  async refreshThreads() {
    set({ threads: await api.get('/threads') });
  },
  async refreshAgents() {
    set({ agents: await api.get('/agents') });
  },
  async refreshShared() {
    set({ shared: ((await api.get<any[]>('/agents/shared').catch(() => [])) || []).map(sharedAgent) });
  },
  async refreshProviders() {
    set({ providers: await api.get('/providers') });
  },
  async refreshApprovals() {
    set({ approvals: await api.get('/approvals') });
  },
}));

// ---- live event wiring ----
let wired = false;
export function wireEvents() {
  if (wired) return;
  wired = true;
  const s = useApp;
  on('ws.status', (d) => s.setState({ online: !!d.connected }));
  on('message.created', (m: Message) =>
    s.setState((st) => {
      const list = st.messages[m.thread_id];
      const threads = st.threads.map((t) => (t.id === m.thread_id ? { ...t, updated_at: m.created_at, last: m.role === 'tool' ? t.last : { content: m.content.slice(0, 140), author_name: m.author_name, created_at: m.created_at, role: m.role, status: m.status, budgetUntil: m.parts?.budget?.resetAt, note: m.role === 'system' ? m.parts?.note : undefined } } : t));
      threads.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at));
      return { threads, messages: list ? { ...st.messages, [m.thread_id]: upsert(list, m) } : st.messages };
    }),
  );
  on('message.updated', (m: Message) =>
    s.setState((st) => {
      const isPreview = (t: (typeof st.threads)[number]) => t.id === m.thread_id && !!t.last && t.last.created_at === m.created_at && t.last.author_name === m.author_name && m.role !== 'tool';
      // A message that disappears (deleted, or a quiet routine run that hides itself) must not stay as the sidebar
      // preview: it showed "ROUTINE_NO_UPDATE" (acceptance round 3). The server knows the message before it.
      if (m.deleted && st.threads.some(isPreview)) void s.getState().refreshThreads().catch(() => {});
      // Keep the sidebar preview (last message text + status) in step with streaming/finished answers.
      const threads = st.threads.map((t) => (isPreview(t) && !m.deleted ? { ...t, last: { ...t.last!, content: (m.content || '').slice(0, 140), status: m.status } } : t));
      const list = st.messages[m.thread_id];
      if (!list) return { threads };
      const status = { ...st.status };
      if (m.status !== 'streaming') delete status[m.id];
      return { threads, messages: { ...st.messages, [m.thread_id]: upsert(list, m) }, status };
    }),
  );
  on('message.delta', (d: { threadId: string; messageId: string; text: string; reasoning: string }) =>
    s.setState((st) => {
      const list = st.messages[d.threadId];
      if (!list) return {};
      return {
        messages: {
          ...st.messages,
          [d.threadId]: list.map((m) => (m.id === d.messageId ? { ...m, content: (m.content || '') + (d.text || ''), parts: { ...m.parts, reasoning: (m.parts.reasoning || '') + (d.reasoning || '') } } : m)),
        },
      };
    }),
  );
  on('message.status', (d: { messageId: string; text: string }) => s.setState((st) => ({ status: { ...st.status, [d.messageId]: statusText(d.text) } })));
  on('tool.progress', (d: { messageId: string; text: string }) => s.setState((st) => ({ status: { ...st.status, [d.messageId]: d.text } })));
  on('run.alive', (a: { runId: string; lastActivityAt: number; at: number; doing?: string; process?: 'alive' | 'gone' }) => {
    if (!a?.runId || !Number.isFinite(a.lastActivityAt) || !Number.isFinite(a.at)) return;
    s.setState((st) => ({ alive: { ...st.alive, [a.runId]: { lastActivityAt: a.lastActivityAt, at: a.at, receivedAt: Date.now(), doing: a.doing, process: a.process } } }));
  });
  on('run.updated', (r: Run) =>
    s.setState((st) => {
      const active = ['queued', 'running', 'waiting'].includes(r.status);
      if (active) return { runs: upsert(st.runs, r) };
      if (st.alive[r.id]) {
        const { [r.id]: _over, ...alive } = st.alive;
        st = { ...st, alive };
      }
      const budgetUntil = r.status === 'error' ? Date.parse(r.meta?.budget?.resetAt || '') || undefined : undefined;
      // Important work that paused (package D2) did not fail: the pause card in the chat says when it goes on.
      const status = r.meta?.paused ? 'cancelled' : r.status;
      return { alive: st.alive, runs: st.runs.filter((x) => x.id !== r.id), finished: { ...st.finished, [r.agent_id]: { status, at: Date.now(), threadId: r.thread_id, budgetUntil } } };
    }),
  );
  on('thread.updated', (t: Thread) => s.setState((st) => ({ threads: upsert(st.threads, t, true) })));
  on('thread.deleted', (d: { id: string }) => s.setState((st) => ({ threads: st.threads.filter((t) => t.id !== d.id), approvals: st.approvals.filter((a) => a.thread_id !== d.id) })));
  // "Geschiedenis wissen" of a group: its own conversation stays, empty.
  on('thread.cleared', (d: { id: string }) =>
    s.setState((st) => ({ messages: { ...st.messages, [d.id]: [] }, threads: st.threads.map((t) => (t.id === d.id ? { ...t, last: null } : t)), approvals: st.approvals.filter((a) => a.thread_id !== d.id) })),
  );
  on('agent.updated', (a: Agent) => s.setState((st) => ({ agents: upsert(st.agents, a) })));
  on('agent.deleted', (d: { id: string }) => s.setState((st) => ({ agents: st.agents.filter((a) => a.id !== d.id) })));
  on('agents.shared', () => void s.getState().refreshShared());
  on('provider.updated', (p: ProviderView) => s.setState((st) => ({ providers: upsert(st.providers, p) })));
  on('provider.deleted', (d: { id: string }) => s.setState((st) => ({ providers: st.providers.filter((p) => p.id !== d.id) })));
  on('approval.created', (a: Approval) => s.setState((st) => ({ approvals: upsert(st.approvals, a, true) })));
  on('approval.updated', (a: Approval) => s.setState((st) => ({ approvals: a.status === 'pending' ? upsert(st.approvals, a) : st.approvals.filter((x) => x.id !== a.id) })));
  on('settings.updated', (st: any) => s.setState({ settings: st }));
}

export function agentById(id: string | null | undefined): Agent | undefined {
  if (!id) return undefined;
  const st = useApp.getState();
  return st.agents.find((a) => a.id === id) || st.shared.find((a) => a.id === id);
}

/** A bot from /agents/shared as a full Agent for the chat screens (face, name, role; nothing of the owner's setup). */
export function sharedAgent(v: any): Agent {
  return {
    id: v.id,
    user_id: v.owner?.id || '',
    shared_from: { id: v.owner?.id || '', name: v.owner?.name || '' },
    name: v.name,
    avatar: v.avatar || '',
    color: v.color || '',
    role: v.role || '',
    description: v.description || '',
    instructions: '',
    provider_id: null,
    model: '',
    reasoning: '',
    access_mode: v.access_mode === 'chat' || v.access_mode === 'readonly' ? v.access_mode : 'ask',
    workspace: '',
    tool_groups: [],
    tool_policy: {},
    skills: [],
    fallback: null,
    busy_policy: 'queue',
    settings: { shared: true },
    pinned: false,
    archived: false,
    sort: 0,
    created_at: '',
    updated_at: '',
  } as Agent;
}
