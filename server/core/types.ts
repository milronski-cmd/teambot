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

/** full = "Volledige toegang": the owner's explicit opt-in; normal actions without asking (see Broker.decide). */
export type AccessMode = 'chat' | 'readonly' | 'ask' | 'auto' | 'full';
/**
 * What a `danger` tool does, for "Volledige toegang": local (files, own desktop) runs without asking, external
 * (sends or publishes to someone else) asks unless the owner also allowed that, payment always asks.
 */
export type ToolImpact = 'local' | 'external' | 'payment';
export type ToolRisk = 'read' | 'write' | 'exec' | 'danger';
export type Decision = 'allow' | 'ask' | 'deny';
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
  tool_policy: Record<string, Decision>;
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

export type ThreadKind = 'chat' | 'room' | 'routine' | 'delegation' | 'channel';

export interface Thread {
  id: string;
  user_id: string;
  agent_id: string | null;
  room_id: string | null;
  kind: ThreadKind;
  title: string;
  parent_id: string | null;
  provider_state: Record<string, any>;
  meta: Record<string, any>;
  pinned: boolean;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: any;
  status?: 'pending' | 'running' | 'done' | 'error' | 'denied' | 'waiting';
  approvalId?: string;
  summary?: string;
}

export interface AttachmentRef {
  id: string;
  name: string;
  mime: string;
  size: number;
}

/** What a step touched, in data (for "Wat heeft deze bot gezien en gedaan" and the bot's files in the side panel). */
export interface StepFact {
  op: 'read' | 'write' | 'delete' | 'web' | 'search' | 'exec' | 'app';
  /** Full path, URL, command, search query or app name. */
  target: string;
}

export interface ActivityItem {
  kind: string;
  title: string;
  detail?: string;
  ts: string;
  facts?: StepFact[];
  /** A CLI step that has not finished yet (its title says what the bot wants to do); the loop guard waits for it. */
  pending?: boolean;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cost?: number;
  /** Estimated value at list price (USD) when `cost` is covered by a subscription (e.g. Claude Code's total_cost_usd). */
  value?: number;
}

export interface MessageParts {
  toolCalls?: ToolCall[];
  toolResult?: { toolCallId: string; name: string; isError?: boolean };
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

/** Who pays: free (no account/key needed or a free model), subscription (your own CLI login), paid (per use), local (own hardware). */
export type Billing = 'free' | 'subscription' | 'paid' | 'local';

export interface ModelInfo {
  id: string;
  label?: string;
  billing?: Billing;
  context?: number;
  vision?: boolean;
  tools?: boolean;
  reasoning?: boolean;
  /** USD per 1M tokens [input, output], from the provider's own model list (when it publishes prices). */
  price?: [number, number];
  /** Free to use (free model or free tier of the provider). */
  free?: boolean;
  /** Thinking levels this model takes (C-11): [] = none to choose, undefined = unknown. */
  reasoningLevels?: string[];
  defaultReasoning?: string;
  /** Where tools/vision/context come from when not from the engine itself (dated table). */
  capSource?: string;
  capChecked?: string;
  /** Local models (C-13): memory per token of context (bytes, estimate), the context the server loaded it with, and
   *  whether the server fixes the window at start (llama.cpp). */
  memPerToken?: number;
  loadedContext?: number;
  contextFixed?: boolean;
}

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

/** Outcome of "Test verbinding": a free check (model list, key/credit endpoint) with a plain-language fix hint. */
export interface ProviderTestResult {
  ok: boolean;
  detail: string;
  /** What to do about a failure, in Dutch. */
  hint?: string;
  /** Error category (auth, quota, rate_limit, model, network, ...). */
  category?: string;
  /** The key itself was checked (not only a public model list). */
  verified?: boolean;
  /** Credit / limit info when the provider exposes it for free. */
  credit?: string;
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

/** One step of a bot's plan (plan card in the chat). */
export interface PlanStep {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
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

export interface ProviderKind {
  id: string;
  label: string;
  type: 'api' | 'cli';
  /** How the provider takes a thinking level (openai-compat ReasoningStyle); null = it takes none. */
  reasoningStyle?: string | null;
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
  /** Typical billing of this engine (shown as a label; a CLI's actual login decides in the end). */
  billing?: Billing;
  models?: string[];
  defaultModel?: string;
  /** Section on the Providers page: free, via your subscription, local, with an API key. */
  section?: 'free' | 'subscription' | 'local' | 'key';
  /** Honest one-line cost summary (free-tier limits included) and the date it was checked. */
  costNote?: string;
  costCheckedAt?: string;
  pricingUrl?: string;
  /** Extra settings this provider needs (Azure resource, Cloudflare account, Bedrock region, ...). */
  fields?: ProviderField[];
  /** Label for the secret field when it is not a plain API key. */
  keyLabel?: string;
  /** Not verified against the vendor's current docs: shown as "experimenteel". */
  experimental?: boolean;
  /** The service stopped on this date: hidden from "add", existing connections explain it. */
  retired?: string;
  /** Preferred default models, best first (server-side only; the first one in the live list wins). */
  recommend?: (string | RegExp)[];
  create(cfg: ProviderConfig, key: string | null, ctx: Ctx): ProviderAdapter;
  /** `baseUrl`: where a local server was found (it may run on an older default port). */
  detect?(ctx: Ctx): Promise<{ installed: boolean; version?: string; loggedIn?: boolean; detail?: string; baseUrl?: string }>;
}

export interface ProviderField {
  /** Stored as cfg.config[key] (or cfg.base_url when key is "base_url"). */
  key: string;
  label: string;
  placeholder?: string;
  hint?: string;
  required?: boolean;
  /** Fixed choices (rendered as a select). */
  options?: { value: string; label: string }[];
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
  /** `t.agent` is there when TeamBot knows the bot (the approval card), e.g. to name what lies outside its folders. */
  summarize?(args: any, t?: { agent: Agent }): string;
  /** Name of the app behind this tool (tools of connected apps), for plain-language progress lines ("Gebruikt Notion"). */
  app?: string;
  run(args: any, t: ToolContext): Promise<string | ToolOutput>;
}

export interface ToolGroup {
  id: string;
  label: string;
  description: string;
  defaultOn?: boolean;
  always?: boolean;
}

export type ToolProvider = (agent: Agent, thread: Thread) => ToolDef[] | Promise<ToolDef[]>;

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
