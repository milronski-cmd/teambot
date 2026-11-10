// Mirrors server/core/types.ts (JSON shapes returned by the API).

export type AccessMode = 'chat' | 'readonly' | 'ask' | 'auto' | 'full';
export type Role = 'owner' | 'admin' | 'member';

export interface User {
  id: string;
  email: string | null;
  name: string;
  role: Role;
  disabled: boolean;
  settings: Record<string, any>;
  created_at: string;
}

export interface Agent {
  id: string;
  user_id: string;
  /** A bot someone else shares with the team (server mode): whose it is. Only on bots from /agents/shared. */
  shared_from?: { id: string; name: string };
  name: string;
  avatar: string;
  color: string;
  role: string;
  description: string;
  instructions: string;
  provider_id: string | null;
  model: string;
  reasoning: string;
  access_mode: AccessMode;
  workspace: string;
  tool_groups: string[];
  tool_policy: Record<string, 'allow' | 'ask' | 'deny'>;
  skills: string[];
  fallback: { provider_id: string; model: string } | null;
  /** What a new message does while the bot works: wait in the queue, steer the running turn, or interrupt it. */
  busy_policy: 'queue' | 'steer' | 'interrupt';
  settings: Record<string, any>;
  pinned: boolean;
  archived: boolean;
  sort: number;
  created_at: string;
  updated_at: string;
}

export interface Thread {
  id: string;
  user_id: string;
  agent_id: string | null;
  room_id: string | null;
  kind: 'chat' | 'room' | 'routine' | 'delegation' | 'channel';
  title: string;
  parent_id: string | null;
  provider_state: Record<string, any>;
  meta: Record<string, any>;
  pinned: boolean;
  archived: boolean;
  created_at: string;
  updated_at: string;
  last?: { content: string; author_name: string; created_at: string; role: string; status?: Message['status']; budgetUntil?: string } | null;
}

export interface ToolCall {
  id: string;
  name: string;
  args: any;
  status?: 'pending' | 'running' | 'done' | 'error' | 'denied' | 'waiting';
  summary?: string;
}

export interface AttachmentRef {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export interface PlanStep {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** A run stopped by the daily budget (server/agent/budget.ts). */
export interface BudgetStop {
  limit: number;
  spent: number;
  estimate?: number;
  resetAt: string;
  byAdmin?: boolean;
  midRun?: boolean;
}

export interface Message {
  id: string;
  thread_id: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool' | 'system' | 'event';
  author_type: 'user' | 'agent' | 'system' | 'external';
  author_id: string | null;
  author_name: string;
  content: string;
  parts: {
    toolCalls?: ToolCall[];
    toolResult?: { toolCallId: string; name: string; isError?: boolean };
    attachments?: AttachmentRef[];
    reasoning?: string;
    activity?: { kind: string; title: string; detail?: string; ts: string }[];
    /** The bot's plan as a checklist (plan card), updated while it works. */
    plan?: { steps: PlanStep[]; updated_at: string };
    error?: string;
    /** Stopped by the daily budget (a limit, not an error): when it opens again and whether only the admin can raise it. */
    budget?: BudgetStop;
    notice?: string;
    model?: string;
    provider?: string;
    [k: string]: any;
  };
  run_id: string | null;
  status: 'done' | 'streaming' | 'error' | 'cancelled';
  usage: { input: number; output: number; cacheRead?: number; cost?: number; value?: number | null } | null;
  reply_to: string | null;
  reactions: Record<string, string[]>;
  pinned: boolean;
  deleted: boolean;
  created_at: string;
  edited_at: string | null;
}

export interface Run {
  id: string;
  thread_id: string;
  agent_id: string;
  user_id: string;
  status: 'queued' | 'running' | 'waiting' | 'done' | 'error' | 'cancelled' | 'interrupted';
  trigger: string;
  error: string | null;
  usage: { input: number; output: number; cost?: number };
  /** engine: the reserve engine this run uses right now (set by the server while a reserve answers). */
  meta?: Record<string, any>;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface Approval {
  id: string;
  user_id: string;
  agent_id: string | null;
  run_id: string | null;
  thread_id: string | null;
  kind: 'tool' | 'question';
  tool: string;
  input: any;
  summary: string;
  risk: 'read' | 'write' | 'exec' | 'danger';
  options: string[] | null;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  answer: string | null;
  /** Set when the run that asked was interrupted by a crash/restart; the approval stays open and resumes the run. */
  interrupted_at?: string | null;
  /** A bot someone else shares with the team asks you (in your own conversation): no "always allow" for it. */
  sharedBot?: boolean;
  created_at: string;
}

export interface ProviderView {
  id: string;
  user_id: string;
  kind: string;
  name: string;
  base_url: string;
  config: Record<string, any>;
  enabled: boolean;
  shared: boolean;
  hasKey: boolean;
  own: boolean;
  kindLabel: string;
  type: 'api' | 'cli';
  billing?: Billing;
  created_at: string;
}

export interface ProviderKindView {
  id: string;
  label: string;
  type: 'api' | 'cli';
  group?: 'cloud' | 'local' | 'cli' | 'custom' | 'free';
  baseUrl?: string;
  needsKey: boolean;
  keyOptional?: boolean;
  keyUrl?: string;
  keyPlaceholder?: string;
  docsUrl?: string;
  description: string;
  authNote?: string;
  billingNote?: string;
  billing?: Billing;
  models?: string[];
  defaultModel?: string;
  canDetect: boolean;
  status?: { installed: boolean; version?: string; loggedIn?: boolean; detail?: string; baseUrl?: string } | null;
  /** Section on the Providers page. */
  section?: 'free' | 'subscription' | 'local' | 'key';
  costNote?: string;
  costCheckedAt?: string;
  pricingUrl?: string;
  keyLabel?: string;
  fields?: { key: string; label: string; placeholder?: string; hint?: string; required?: boolean; options?: { value: string; label: string }[] }[];
  experimental?: boolean;
  retired?: string;
}

/** Result of "Test verbinding" / "Sleutel controleren": free check with a fix hint in plain Dutch. */
export interface ProviderTestResult {
  ok: boolean;
  detail: string;
  hint?: string;
  category?: string;
  verified?: boolean;
  credit?: string;
  models?: ModelInfo[];
}

/** Who pays for a model or engine (label in the UI). */
export type Billing = 'free' | 'subscription' | 'paid' | 'local';
export const BILLING_LABEL: Record<Billing, string> = { free: 'gratis', subscription: 'abonnement', paid: 'betaald', local: 'lokaal, gratis' };

export interface ModelInfo {
  id: string;
  label?: string;
  billing?: Billing;
  context?: number;
  vision?: boolean;
  tools?: boolean;
  /** USD per 1M tokens [input, output]. */
  price?: [number, number];
  free?: boolean;
  recommended?: boolean;
  /** Where the price comes from: lijst (provider's live list), tabel (dated table), eigen, gratis. */
  priceSource?: string;
  priceChecked?: string;
  /** Thinking levels this model takes (none, minimal, low, medium, on, high, xhigh, max); [] = none; undefined = unknown. */
  reasoningLevels?: string[];
  defaultReasoning?: string;
  reasoning?: boolean;
  capSource?: string;
  capChecked?: string;
  /** Local models: memory per token of context (bytes), the window it is loaded with now, fixed at server start. */
  memPerToken?: number;
  loadedContext?: number;
  contextFixed?: boolean;
}

export interface ToolGroup {
  id: string;
  label: string;
  description: string;
  defaultOn?: boolean;
  always?: boolean;
}
