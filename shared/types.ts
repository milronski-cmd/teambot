/**
 * The JSON shapes the API gives and the page reads, written once: server/core/types.ts passes them on to the server,
 * ui/src/lib/types.ts to the page (which adds the few fields only a list endpoint sends). Types only.
 */

import type { Words } from './i18n-core.js';

/** full = "Volledige toegang": the owner's explicit opt-in; normal actions without asking (see Broker.decide). */
export type AccessMode = 'chat' | 'readonly' | 'ask' | 'auto' | 'full';
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
  /** The step's line in Dutch, as the bot and an export read it. */
  summary?: string;
  /** The same line as TeamBot's words with values (tools/execute.ts): the owner reads it in his language. */
  words?: Words;
  /**
   * The listed tool the model made this call through (`tools_call`, tools/selection.ts). The call itself is stored as
   * the tool it names, so everything shows, checks and logs that tool; the model gets its own call back as it wrote it.
   */
  via?: string;
}

export interface AttachmentRef {
  id: string;
  name: string;
  mime: string;
  size: number;
}

/** One step of a bot's plan (plan card in the chat). */
export interface PlanStep {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
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
  /** For the page (api/providers.ts decorateModels): the recommended default, and where the price comes from (lijst = the provider's live list, tabel = dated table, eigen, gratis). */
  recommended?: boolean;
  priceSource?: string;
  priceChecked?: string;
  /** Thinking levels this model takes (C-11; none, minimal, low, medium, on, high, xhigh, max): [] = none to choose, undefined = unknown. */
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

/** One connected AI with the models a bot can be put on (GET /api/model-catalog/choices; the model switcher in the chat header). */
export interface ModelGroup {
  /** defaultModel: what a bot without a model of its own runs on here ("Automatisch"); absent = it needs a model. */
  provider: { id: string; name: string; kind: string; kindLabel: string; type: 'api' | 'cli'; billing?: Billing; own: boolean; defaultModel?: string };
  models: ModelInfo[];
  /** Connected, but its list could not be read now (a local server that is off, a time-out). */
  error?: string;
  /** Its list is still being read (`soft`): the rest is here already, ask again for this one. */
  pending?: boolean;
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

/** A kind of AI connection as the Providers page shows it (the server's ProviderKind adds how to make and find one). */
export interface ProviderKindInfo {
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
}

/** A group of tools a bot can have (the bot page lists them). */
export interface ToolGroup {
  id: string;
  label: string;
  description: string;
  defaultOn?: boolean;
  always?: boolean;
}
