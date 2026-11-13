import type { Router } from 'express';
import type { DB } from './db.js';
import type { EventBus } from './events.js';
import type { Config } from './config.js';
import type { Store } from './store.js';
import type { Secrets } from './secrets.js';
import type { Auth } from './auth.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { Broker } from '../tools/broker.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { RunManager } from '../agent/runs.js';
import type { ChatService } from '../agent/chat.js';
import type { StepFact } from '../../shared/seen.js';
import type { AccessMode, Agent, AttachmentRef, ModelInfo, PlanStep, ProviderKindInfo, ProviderTestResult, Thread, ToolCall } from '../../shared/types.js';
import type { Words } from '../../shared/i18n-core.js';

/** The JSON shapes the page reads too: shared/types.ts. */
export type { AccessMode, Agent, AttachmentRef, Billing, Decision, ModelInfo, PlanStep, ProviderField, ProviderTestResult, Role, Thread, ThreadKind, ToolCall, ToolGroup, User } from '../../shared/types.js';

/**
 * What a `danger` tool does, for "Volledige toegang": local (files, own desktop) runs without asking, external
 * (sends or publishes to someone else) asks unless the owner also allowed that, payment always asks.
 */
export type ToolImpact = 'local' | 'external' | 'payment';
export type ToolRisk = 'read' | 'write' | 'exec' | 'danger';

/** What a step touched, in data: shared/seen.ts (the page shows it under "Wat heeft deze bot gezien en gedaan"). */
export type { StepFact };

export interface ActivityItem {
  kind: string;
  title: string;
  detail?: string;
  ts: string;
  facts?: StepFact[];
  /** A CLI step that has not finished yet (its title says what the bot wants to do); the loop guard waits for it. */
  pending?: boolean;
  /** The title as TeamBot's words with values (a TeamBot tool's step): shown in the reader's language, values as written. */
  words?: Words;
  /** What a command of a CLI engine printed (its start and its end): for the second look before "klaar", not shown as a line. */
  out?: string;
}

/** A long output short: its start and its end (a test run ends with its counts). */
export function headAndTail(text: string, max: number): string {
  const t = String(text || '').trim();
  const head = Math.floor(max * 0.35);
  return t.length <= max ? t : `${t.slice(0, head)} … ${t.slice(-(max - head))}`;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cost?: number;
  /** Estimated value at list price (USD) when `cost` is covered by a subscription (e.g. Claude Code's total_cost_usd). */
  value?: number;
  /** The tokens are TeamBot's estimate, not the engine's count (a call that stopped before the engine said). */
  estimated?: boolean;
}

export interface MessageParts {
  toolCalls?: ToolCall[];
  toolResult?: { toolCallId: string; name: string; isError?: boolean; via?: string };
  attachments?: AttachmentRef[];
  reasoning?: string;
  raw?: { provider: string; data: any };
  context?: string;
  activity?: ActivityItem[];
  error?: string;
  /** The run was stopped by the daily budget (agent/budget.ts): a limit, shown as such instead of as an error. */
  budget?: { limit: number; spent: number; estimate?: number; resetAt: string; byAdmin?: boolean; midRun?: boolean };
  notice?: string;
  model?: string;
  provider?: string;
  [k: string]: any;
}

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system' | 'event';
export type AuthorType = 'user' | 'agent' | 'system' | 'external';

export interface Message {
  id: string;
  thread_id: string;
  seq: number;
  role: MessageRole;
  author_type: AuthorType;
  author_id: string | null;
  author_name: string;
  content: string;
  parts: MessageParts;
  run_id: string | null;
  status: 'done' | 'streaming' | 'error' | 'cancelled';
  usage: Usage | null;
  reply_to: string | null;
  reactions: Record<string, string[]>;
  pinned: boolean;
  deleted: boolean;
  created_at: string;
  edited_at: string | null;
}

export type RunStatus = 'queued' | 'running' | 'waiting' | 'done' | 'error' | 'cancelled' | 'interrupted';

export interface Run {
  id: string;
  thread_id: string;
  agent_id: string;
  user_id: string;
  status: RunStatus;
  trigger: string;
  input_message_id: string | null;
  error: string | null;
  usage: Usage;
  meta: Record<string, any>;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

// ---------- Providers ----------

export type ContentPart = { type: 'text'; text: string } | { type: 'image'; mime: string; data: string };

export interface ChatMsg {
  role: 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  raw?: { provider: string; data: any };
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: any;
  /** The connected app (MCP) this tool belongs to: a local model with a small window can leave a whole app out. Never sent to the provider. */
  app?: string;
}

export interface ChatRequest {
  model: string;
  system: string;
  messages: ChatMsg[];
  tools: ToolSpec[];
  reasoning?: string;
  maxTokens?: number;
  historyTruncated?: boolean;
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_start'; id: string; name: string }
  | { type: 'status'; text: string };

export interface ChatResult {
  text: string;
  reasoning?: string;
  toolCalls: ToolCall[];
  usage: Usage;
  stop: 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'error';
  raw?: { provider: string; data: any };
  model?: string;
  notice?: string;
  /** Images the model produced (image-output models); not yet shown in the chat by the runner. */
  images?: { mime: string; data: string }[];
}

export interface AgentRunRequest {
  model: string;
  system: string;
  prompt: string;
  attachments: { path: string; name: string; mime: string }[];
  workspace: string;
  sessionId?: string;
  accessMode: AccessMode;
  reasoning?: string;
  agentId: string;
  threadId: string;
  runId: string;
  userId: string;
}

export type AgentEvent =
  | StreamEvent
  | { type: 'activity'; item: ActivityItem }
  /** The bot's plan, whole list each time (Codex todo list, ACP plan, Claude TodoWrite, TeamBot's plan_update). */
  | { type: 'plan'; steps: PlanStep[] }
  | { type: 'session'; sessionId: string }
  /** A file a tool produced for the chat (e.g. share_file, a screenshot): shown with the CLI agent's answer. */
  | { type: 'attachment'; ref: AttachmentRef };

export interface AgentRunResult {
  text: string;
  usage: Usage;
  sessionId?: string;
  error?: string;
  /** The model the CLI really used (e.g. "claude-opus-5-5" for the alias "opus" or "default"), when it says so. */
  model?: string;
}

export interface ProviderAdapter {
  kind: string;
  listModels(): Promise<ModelInfo[]>;
  test(): Promise<ProviderTestResult>;
  chat?(req: ChatRequest, signal: AbortSignal, onEvent: (e: StreamEvent) => void): Promise<ChatResult>;
  runAgent?(req: AgentRunRequest, signal: AbortSignal, onEvent: (e: AgentEvent) => void): Promise<AgentRunResult>;
  /** One short answer without tools or session (CLI engines, which have no `chat`); null = not supported by this CLI. */
  complete?(req: { model?: string; system: string; prompt: string }): Promise<string | null>;
}

export interface ProviderConfig {
  id: string;
  user_id: string;
  kind: string;
  name: string;
  base_url: string;
  secret_id: string | null;
  config: Record<string, any>;
  enabled: boolean;
  shared: boolean;
  created_at: string;
}

export interface ProviderKind extends ProviderKindInfo {
  /** How the provider takes a thinking level (openai-compat ReasoningStyle); null = it takes none. */
  reasoningStyle?: string | null;
  /** Preferred default models, best first (server-side only; the first one in the live list wins). */
  recommend?: (string | RegExp)[];
  create(cfg: ProviderConfig, key: string | null, ctx: Ctx): ProviderAdapter;
  /** `baseUrl`: where a local server was found (it may run on an older default port). */
  detect?(ctx: Ctx): Promise<{ installed: boolean; version?: string; loggedIn?: boolean; detail?: string; baseUrl?: string }>;
}

// ---------- Tools ----------

export interface ToolContext {
  ctx: Ctx;
  agent: Agent;
  thread: Thread;
  run: Run;
  userId: string;
  signal: AbortSignal;
  toolCallId: string;
  /** A human approved this call (approval card), as opposed to an automatic allow. */
  approved?: boolean;
  progress(text: string): void;
}

export interface ToolOutput {
  text: string;
  isError?: boolean;
  attachments?: AttachmentRef[];
  data?: any;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: any;
  group: string;
  risk: ToolRisk;
  /** Only for danger tools; default 'external'. A function can look at the arguments (e.g. the recipient). */
  impact?: ToolImpact | ((args: any, agent: Agent) => ToolImpact);
  /**
   * Optional risk of one specific call; the broker still makes the decision. Lets a tool be gentler for a target the
   * owner explicitly pre-approved (e.g. channel_send to the owner himself) and keep `risk` for everything else.
   * Must be cheap and synchronous; any error falls back to `risk`.
   */
  riskFor?(args: any, t: { agent: Agent; thread: Thread; userId: string }): ToolRisk;
  /**
   * Optional: a reason why this call can never succeed right now (e.g. the skill is not trusted). Checked before the
   * access mode and the approval card, so the owner is not asked to approve something that will be refused anyway.
   * Returns null when the call may go ahead. Must be cheap and synchronous; an error counts as "go ahead".
   */
  refuse?(args: any, t: { agent: Agent; thread: Thread; userId: string }): string | null;
  /**
   * Team-internal: the bot asks, messages or hands work to another bot of the same owner, or keeps the owner's task
   * board. In "Vraagt toestemming" (ask) this runs without an approval card, like talking to a colleague; whatever the
   * receiving bot then does goes through its own access mode. Read-only and chat bots still cannot use it.
   */
  internal?: boolean;
  /**
   * Like `internal`, for one specific call only: low-impact team bookkeeping such as a new line in the team logbook
   * (team_execute "INSERT INTO logboek … VALUES …"). Runs without a card in "Vraagt toestemming"; read-only bots still
   * cannot, and the call is logged like any other. Must be cheap and synchronous; an error counts as false.
   */
  internalFor?(args: any): boolean;
  /**
   * The step's line: `words(template, ...values)` (shared/i18n-core.ts), so the owner reads TeamBot's words in his
   * language and the names, paths and texts in it as written; a plain string is shown as it is. `t.agent` is there
   * when TeamBot knows the bot (the approval card), e.g. to name what lies outside its folders.
   */
  summarize?(args: any, t?: { agent: Agent }): string | Words;
  /** Name of the app behind this tool (tools of connected apps), for plain-language progress lines ("Gebruikt Notion"). */
  app?: string;
  /**
   * Never in the list a model gets with every call, whatever the tool's name (tools/selection.ts): the bot reaches it
   * through tools_find and tools_call. Set by a provider on the copy it hands a bot that needs the tool now and then.
   */
  onDemand?: boolean;
  run(args: any, t: ToolContext): Promise<string | ToolOutput>;
}

export type ToolProvider = (agent: Agent, thread: Thread) => ToolDef[] | Promise<ToolDef[]>;

/**
 * What a bot must know to use a part of its tools well (how its browser works, the tables of the team database). It is
 * in the system prompt while that part's tools are listed; when they are on demand it comes with what `tools_find`
 * finds (tools/selection.ts), so it costs nothing in the steps that never touch the part.
 */
export interface PartGuide {
  /** Part ids: a tool group ("browser", "team:data"), or "app:*" for the connected apps. */
  parts: string[];
  /** Stable text for this bot (no timestamps), or nothing when it does not apply. */
  text(a: { agent: Agent; thread: Thread; userId: string }): string | null | undefined | Promise<string | null | undefined>;
}

// ---------- Hooks / modules ----------

type MaybeP<T> = T | Promise<T>;

export interface Hooks {
  /** Stable additions to the system prompt (keep deterministic: no timestamps). */
  systemPrompt: Array<(a: { agent: Agent; thread: Thread; userId: string }) => MaybeP<string | null | undefined>>;
  /** Per-turn context, frozen into the user message the first time it is sent. */
  turnContext: Array<(a: { agent: Agent; thread: Thread; userId: string; input: Message | null }) => MaybeP<string | null | undefined>>;
  /** Decide who answers a new message. Return true when handled. */
  route: Array<(a: { message: Message; thread: Thread; userId: string }) => MaybeP<boolean>>;
  afterRun: Array<(a: { agent: Agent; thread: Thread; run: Run; finalText: string }) => MaybeP<void>>;
  messageCreated: Array<(a: { message: Message; thread: Thread }) => void>;
  agentDeleted: Array<(a: { agentId: string; userId: string }) => void>;
  /**
   * Extra daily limits, checked by the runner before every model call that can cost money (next to the owner's own
   * daily budget; free, local and subscription engines are never checked). Throw a BudgetError (agent/budget.ts) to
   * stop the run as "daglimiet bereikt". Synchronous and cheap. Optional: modules create it (`??= []`).
   */
  beforeModelCall?: Array<(a: { agent: Agent; userId: string; estimate: number | null; midRun: boolean; tz?: string }) => void>;
  /**
   * Like beforeModelCall, but before every model call of a bot on any engine (also free, local and subscription): a
   * bot's own usage cap in tokens (usage module). Throw a BudgetError to pause the bot. Optional (`??= []`).
   */
  beforeAnyModelCall?: Array<(a: { agent: Agent; userId: string; midRun: boolean; tz?: string }) => void>;
  /**
   * "Alles stoppen" (RunManager.stopAll, from the app and from the tray): what waits to start by itself in a part's
   * own queue is stopped too (a routine run or a message waiting for its next attempt, a bot message waiting for its
   * recipient, a workflow between two steps). Called right after the runs are stopped. Optional (`??= []`).
   */
  stopAll?: Array<(a: { userId: string }) => void>;
}

export interface Migration {
  id: string;
  sql: string;
}

export interface Module {
  id: string;
  label?: string;
  migrations?: Migration[];
  init?(ctx: Ctx): void | Promise<void>;
  start?(ctx: Ctx): void | Promise<void>;
  stop?(ctx: Ctx): void | Promise<void>;
}

export interface Logger {
  info(...a: any[]): void;
  warn(...a: any[]): void;
  error(...a: any[]): void;
}

export interface Ctx {
  config: Config;
  db: DB;
  store: Store;
  events: EventBus;
  hooks: Hooks;
  api: Router;
  publicApi: Router;
  /**
   * Routes at the server root, outside /api and without session auth (e.g. SCIM at /scim/v2). Register specific
   * prefixes only and authenticate every request yourself.
   */
  rootApi: Router;
  tools: ToolRegistry;
  broker: Broker;
  providers: ProviderRegistry;
  runs: RunManager;
  chat: ChatService;
  secrets: Secrets;
  auth: Auth;
  services: Record<string, any>;
  modules: Module[];
  audit(userId: string | null, kind: string, data: any, agentId?: string | null): void;
  log: Logger;
}
