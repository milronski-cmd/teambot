import type { AccessMode, Migration } from '../../core/types.js';
import { defineTable } from '../../core/db.js';
import type { Schedule } from './schedule.js';
import type { Duty, Reminder } from './duties/types.js';

defineTable('routines', { json: ['schedule', 'options'] });
defineTable('routine_runs', { json: ['payload', 'usage', 'meta'], bool: ['no_update', 'notified'] });
defineTable('routine_triggers', { json: ['config', 'filters', 'state'], bool: ['enabled'] });
defineTable('routine_events', { json: ['payload'] });

export const migrations: Migration[] = [
  {
    id: 'routines-001',
    sql: `
CREATE TABLE routines (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, agent_id TEXT NOT NULL, name TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', paused_reason TEXT,
  schedule TEXT NOT NULL DEFAULT '{"kind":"none"}', timezone TEXT NOT NULL DEFAULT 'Europe/Amsterdam',
  options TEXT NOT NULL DEFAULT '{}', thread_id TEXT, next_run_at TEXT, last_run_at TEXT, last_status TEXT,
  last_summary TEXT, fail_count INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX routines_user ON routines(user_id);
CREATE INDEX routines_agent ON routines(agent_id);
CREATE INDEX routines_due ON routines(status, next_run_at);
CREATE TABLE routine_runs (
  id TEXT PRIMARY KEY, routine_id TEXT NOT NULL, user_id TEXT NOT NULL, run_key TEXT NOT NULL UNIQUE,
  trigger TEXT NOT NULL, trigger_id TEXT, event_id TEXT, scheduled_for TEXT, status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1, max_attempts INTEGER NOT NULL DEFAULT 1, next_retry_at TEXT,
  run_id TEXT, thread_id TEXT, message_id TEXT, no_update INTEGER NOT NULL DEFAULT 0, payload TEXT,
  usage TEXT NOT NULL DEFAULT '{}', summary TEXT NOT NULL DEFAULT '', error TEXT, meta TEXT NOT NULL DEFAULT '{}',
  notified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, duration_ms INTEGER
);
CREATE INDEX routine_runs_routine ON routine_runs(routine_id, created_at);
CREATE INDEX routine_runs_user ON routine_runs(user_id, started_at);
CREATE INDEX routine_runs_status ON routine_runs(status);
CREATE INDEX routine_runs_run ON routine_runs(run_id);
CREATE TABLE routine_triggers (
  id TEXT PRIMARY KEY, routine_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
  preset TEXT NOT NULL DEFAULT '', config TEXT NOT NULL DEFAULT '{}', filters TEXT NOT NULL DEFAULT '{}',
  secret_set_at TEXT, prev_valid_until TEXT, enabled INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT '{}',
  next_check_at TEXT, last_event_at TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX routine_triggers_routine ON routine_triggers(routine_id);
CREATE INDEX routine_triggers_due ON routine_triggers(kind, enabled, next_check_at);
CREATE TABLE routine_events (
  id TEXT PRIMARY KEY, trigger_id TEXT NOT NULL, routine_id TEXT NOT NULL, user_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL, status TEXT NOT NULL, event_type TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
  payload TEXT, routine_run_id TEXT, created_at TEXT NOT NULL, UNIQUE (trigger_id, dedupe_key)
);
CREATE INDEX routine_events_trigger ON routine_events(trigger_id, created_at);
`,
  },
];

export type RoutineStatus = 'draft' | 'active' | 'paused' | 'completed';

export interface RunOverride {
  provider_id?: string | null;
  model?: string;
  access_mode?: AccessMode | '';
  /** Subset of the bot's tool groups; null/undefined = all of the bot's groups. */
  tool_groups?: string[] | null;
  max_turns?: number;
  deny_tools?: string[];
}

/** Start another routine when this one finishes (routine chain A → B). */
export interface ChainNext {
  routineId: string;
  /** done = only after a real result; always = also after "niets nieuws" and failures. */
  on: 'done' | 'always';
  /** Give the result of this run to the next routine (as quoted data). */
  passResult: boolean;
}

export interface RoutineOptions {
  missedPolicy: 'skip' | 'catchup';
  maxRunsPerDay: number;
  maxCostPerDayUsd: number;
  retries: number;
  pauseAfterFailures: number;
  timeoutMinutes: number;
  lastRunContext: boolean;
  lastRunChars: number;
  hideSilentRuns: boolean;
  notify: 'always' | 'errors' | 'never';
  /** Also send the result (and files the bot shared) to a chat app: the owner himself or an existing conversation. */
  deliver: RoutineDelivery | null;
  override: RunOverride;
  /** thread = own routine thread with a fresh context per run; main = in the bot's main chat (keeps its context). */
  runIn: 'thread' | 'main';
  /** When the AI engine's limit is reached: wait for the reset and try again, skip this run, or fail. */
  limitPolicy: 'wait' | 'skip' | 'fail';
  /** Never wait longer than this for a limit reset (hours). */
  maxLimitWaitHours: number;
  then: ChainNext | null;
  /**
   * Belangrijk: the run never goes below the minimum level of Instellingen › Gratis doorschakelen (default Claude or
   * Codex); with nothing in it available it pauses until the reset and then goes on by itself (modules/engine-chain).
   */
  important: boolean;
  /** A waitpoint (wait_for): fires once on its event or when it times out, and continues in `threadId`. */
  waitpoint?: Waitpoint;
  /** A vaste taak (standing duty): measured first, quiet when in order, a task with proof when not (duties/). */
  duty?: Duty;
  /** A reminder: TeamBot itself tells the owner at the time, without a model call (duties/). */
  reminder?: Reminder;
}

export type WaitKind = 'file' | 'message' | 'webhook' | 'time';
export interface Waitpoint {
  kind: WaitKind;
  /** What it waits for, in words ("een nieuw bestand “*.pdf” in uploads"). */
  what: string;
  /** The conversation that set it: the bot continues there. */
  threadId: string | null;
  /** The moment itself ('time') or the timeout (other kinds), ISO. */
  until: string;
  firedAt?: string | null;
  /** event = it happened (or the time came); timeout = it did not happen in time. */
  how?: 'event' | 'timeout' | null;
}

export interface RoutineDelivery {
  bindingId: string;
  /** 'owner' = the owner's own chat on that channel; otherwise an existing conversation id of the binding. */
  to: 'owner' | string;
  withFiles: boolean;
  /** Also report failed runs there (not only results). */
  errors?: boolean;
}

export const DEFAULT_OPTIONS: RoutineOptions = {
  missedPolicy: 'catchup',
  maxRunsPerDay: 100,
  maxCostPerDayUsd: 2,
  retries: 2,
  pauseAfterFailures: 3,
  timeoutMinutes: 30,
  lastRunContext: false,
  lastRunChars: 1500,
  hideSilentRuns: true,
  notify: 'always',
  deliver: null,
  override: {},
  runIn: 'thread',
  limitPolicy: 'wait',
  maxLimitWaitHours: 12,
  then: null,
  important: false,
};

/** After rotating a webhook secret the old one can keep working this long at most (owner's choice, default 0 = never). */
export const MAX_SECRET_GRACE_MINUTES = 60;

/** Routine chains stop after this many hops (A → B → C …) and never revisit a routine. */
export const MAX_CHAIN = 5;

export interface Routine {
  id: string;
  user_id: string;
  agent_id: string;
  name: string;
  prompt: string;
  status: RoutineStatus;
  paused_reason: string | null;
  schedule: Schedule;
  timezone: string;
  options: RoutineOptions;
  thread_id: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_summary: string | null;
  fail_count: number;
  created_by: 'user' | 'agent';
  created_at: string;
  updated_at: string;
}

export type RunTrigger = 'schedule' | 'catchup' | 'manual' | 'test' | 'webhook' | 'feed' | 'page' | 'folder' | 'email' | 'chat' | 'chain';
export type RoutineRunStatus = 'pending' | 'running' | 'retrying' | 'done' | 'no_update' | 'error' | 'cancelled' | 'interrupted' | 'skipped' | 'missed' | 'limited';

export const ACTIVE_RUN = ['pending', 'running', 'retrying'];
/** Statuses that represent a real (started) execution for limit accounting. */
export const STARTED_RUN = ['running', 'retrying', 'done', 'no_update', 'error', 'cancelled', 'interrupted'];

export interface RoutineRun {
  id: string;
  routine_id: string;
  user_id: string;
  run_key: string;
  trigger: RunTrigger;
  trigger_id: string | null;
  event_id: string | null;
  scheduled_for: string | null;
  status: RoutineRunStatus;
  attempt: number;
  max_attempts: number;
  next_retry_at: string | null;
  run_id: string | null;
  thread_id: string | null;
  message_id: string | null;
  no_update: boolean;
  payload: { source: string; label: string; data: any } | null;
  usage: { input?: number; output?: number; cost?: number };
  summary: string;
  error: string | null;
  meta: Record<string, any>;
  notified: boolean;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
}

/** chat = a message on a chat channel (WhatsApp, Telegram, Discord, Slack, webhook channel) via the channels module. */
export type TriggerKind = 'webhook' | 'feed' | 'page' | 'folder' | 'email' | 'chat';

/** Config of a chat-message trigger. */
export interface ChatTriggerConfig {
  /** One channel binding; '' = every chat channel of the owner. */
  bindingId: string;
  /** Who may start it: the verified owner, anyone on the allowlist (default), or also unknown senders. */
  senders: 'owner' | 'allowlist' | 'anyone';
  /** Case-insensitive text match; 'any' = every message. */
  match: 'any' | 'contains' | 'starts_with' | 'regex';
  text: string;
  /** false = the bot does not also answer a message that started this routine. */
  botReplies: boolean;
  ratePerMinute: number;
}
export type WebhookPreset = 'token' | 'hmac' | 'github' | 'slack' | 'linear' | 'sentry' | 'stripe' | 'standard';

export interface FieldFilter {
  path: string;
  op: 'eq' | 'neq' | 'contains' | 'not_contains' | 'starts_with' | 'in' | 'exists' | 'not_exists' | 'gt' | 'lt';
  value?: any;
}
export interface TriggerFilters {
  fields?: FieldFilter[];
  /** Any of these keywords must appear (case-insensitive) in the payload text. */
  anyKeywords?: string[];
  /** None of these keywords may appear. */
  noneKeywords?: string[];
}

export interface Trigger {
  id: string;
  routine_id: string;
  user_id: string;
  kind: TriggerKind;
  name: string;
  preset: WebhookPreset | '';
  config: Record<string, any>;
  filters: TriggerFilters;
  secret_set_at: string | null;
  prev_valid_until: string | null;
  enabled: boolean;
  state: Record<string, any>;
  next_check_at: string | null;
  last_event_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export type EventStatus = 'accepted' | 'filtered' | 'duplicate' | 'rejected' | 'limited' | 'paused' | 'baseline' | 'error';

export interface GlobalSettings {
  paused: boolean;
  maxRunsPerDay: number;
  maxCostPerDayUsd: number;
}
export const DEFAULT_GLOBAL: GlobalSettings = { paused: false, maxRunsPerDay: 300, maxCostPerDayUsd: 10 };

export const secretName = (triggerId: string, prev = false) => `routine-trigger:${triggerId}${prev ? ':prev' : ''}`;
