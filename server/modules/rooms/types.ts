import type { Limits, RoomMode } from './routing.js';

/** limit: stopped by the daily budget until the new day (agent/budget.ts), a limit and not an error. */
export type MemberState = 'idle' | 'queued' | 'running' | 'waiting' | 'paused' | 'error' | 'timeout' | 'limit';
export type HumanRole = 'member' | 'guest';
export type Access = 'owner' | HumanRole;

export interface BotPerms {
  /** auto = takes part according to the room mode; mention = only answers when addressed. */
  respond: 'auto' | 'mention';
  /** Shared room files: none / read / write. */
  files: 'none' | 'read' | 'write';
  /** May create/update tasks on the room board. */
  tasks: boolean;
  /** May delegate, broadcast, hand off and message other bots from this room. */
  delegate: boolean;
}

export const DEFAULT_BOT_PERMS: BotPerms = { respond: 'auto', files: 'read', tasks: true, delegate: true };

export interface Room {
  id: string;
  user_id: string;
  thread_id: string;
  team_id: string | null;
  /** The team (module teams) this group belongs to (walls.ts); null until filled for a group from before teams. */
  workspace_id?: string | null;
  name: string;
  mode: RoomMode;
  lead_agent_id: string | null;
  owner_agent_id: string | null;
  instructions: string;
  limits: Partial<Limits>;
  status: 'active' | 'paused';
  status_reason: string;
  state: { stoppedAgents?: string[] };
  settings: Record<string, any>;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface Member {
  id: string;
  room_id: string;
  kind: 'agent' | 'user';
  ref_id: string;
  role: string;
  perms: Partial<BotPerms>;
  state: MemberState;
  state_detail: string;
  last_run_id: string | null;
  paused: boolean;
  accepted: boolean;
  invited_by: string | null;
  sort: number;
  created_at: string;
  updated_at: string;
}

export type TeamKind = 'turn' | 'sequence' | 'mention' | 'followup' | 'handoff' | 'broadcast' | 'delegation' | 'message' | 'ask' | 'resume';

/** Stored in run.meta.team: the causal chain a bot turn belongs to. */
export interface TeamMeta {
  /** Root of the chain (normally the human message id). Turn caps count runs per chain. */
  chainId: string;
  /** Agents that caused this turn, ending with the agent of this run (cycle detection). */
  path: string[];
  /** Ownership transfers so far in this chain. */
  handoffs: number;
  kind: TeamKind;
  roomId?: string | null;
  /** Remaining agents of an "om de beurt" sequence. */
  next?: string[];
  /** Human who started the chain (for notifications). */
  requestedBy?: string | null;
  delegationId?: string;
  /** Set on synthesized chains for runs that were not started by this module. */
  untracked?: boolean;
  /** The chain uses asynchronous bot messages (ask_bot): its turn cap is maxAskTurns instead of maxTurnsPerMessage. */
  async?: boolean;
}

export interface Delegation {
  id: string;
  user_id: string;
  room_id: string | null;
  /** ask = asynchronous bot message (mailbox): delivered in the target's own chat when it is free; the answer wakes the sender. */
  kind: 'delegate' | 'message' | 'broadcast' | 'ask';
  group_id: string | null;
  parent_thread_id: string;
  parent_run_id: string | null;
  tool_call_id: string | null;
  thread_id: string;
  from_agent_id: string;
  to_agent_id: string;
  task: string;
  expected: string;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled' | 'timeout';
  result: string | null;
  error: string | null;
  run_id: string | null;
  chain_id: string | null;
  path: string[];
  depth: number;
  wait: boolean;
  follow_up: boolean;
  delivered: boolean;
  /** The task on the board this request is about: a task given to a bot starts that bot, and its outcome comes back. */
  task_id?: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export const ACTIVE_RUN = new Set(['queued', 'running', 'waiting']);
export const TERMINAL_RUN = new Set(['done', 'error', 'cancelled', 'interrupted']);
export const TERMINAL_DELEGATION = new Set(['done', 'error', 'cancelled', 'timeout']);
