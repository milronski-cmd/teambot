// JSON shapes returned by the API. The ones the server uses as well are in shared/types.ts; here the page adds the
// few fields only its list endpoints send, and the shapes only the page reads.
import type { Agent as SharedAgent, AttachmentRef, Billing, ModelInfo, PlanStep, ProviderKindInfo, ProviderTestResult as SharedTestResult, Thread as SharedThread, ToolCall } from '../../../shared/types.js';

import type { Words } from '../../../shared/i18n-core.js';

export type { AccessMode, AttachmentRef, Billing, ModelInfo, PlanStep, Role, ToolCall, ToolGroup, User } from '../../../shared/types.js';

export interface Agent extends SharedAgent {
  /** A bot someone else shares with the team (server mode): whose it is. Only on bots from /agents/shared. */
  shared_from?: { id: string; name: string };
}

export interface Thread extends SharedThread {
  /** The conversation list: the newest message; `note`: a TeamBot note's line for the owner (shell/SystemNote.tsx). */
  last?: { content: string; author_name: string; created_at: string; role: string; status?: Message['status']; budgetUntil?: string; note?: { text: string; values?: (string | number)[] } } | null;
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
    /** `words`: a TeamBot tool's step as TeamBot's words with values (shown with components/Words.tsx). */
    activity?: { kind: string; title: string; detail?: string; ts: string; words?: Words }[];
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
  /** Not answered in time: the bot went on with other work; deciding still reaches it. */
  parked_at?: string | null;
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

export interface ProviderKindView extends ProviderKindInfo {
  canDetect: boolean;
  status?: { installed: boolean; version?: string; loggedIn?: boolean; detail?: string; baseUrl?: string } | null;
}

/** Result of "Test verbinding" / "Sleutel controleren": free check with a fix hint in plain Dutch. */
export interface ProviderTestResult extends SharedTestResult {
  models?: ModelInfo[];
}

/** Who pays for a model or engine (label in the UI). */
export const BILLING_LABEL: Record<Billing, string> = { free: 'gratis', subscription: 'abonnement', paid: 'betaald', local: 'lokaal, gratis' };
