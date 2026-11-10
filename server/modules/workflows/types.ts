/**
 * Workflows (PARITEIT 9.8): a fixed chain of steps over several bots, with a check, a loop back, the owner's approval
 * and a message at the end. Types shared by the engine, the routes and the tools.
 */

/** A bot does a piece of work. The prompt may use {{invoer}}, {{vorige}} and {{stap N}}. */
export interface BotStep {
  id: string;
  kind: 'bot';
  title: string;
  agentId: string;
  prompt: string;
}

/** The run waits until the owner says yes (Wacht op jou, phone, chat apps). No = the run stops. */
export interface ApprovalStep {
  id: string;
  kind: 'approval';
  title: string;
  note: string;
}

/**
 * A check on the result of the step before it: when it holds the run goes on, otherwise it stops or goes back to an
 * earlier step (a loop, e.g. "back to the writer until the checker says AKKOORD").
 */
export interface ConditionStep {
  id: string;
  kind: 'condition';
  title: string;
  test: 'contains' | 'not_contains' | 'starts_with';
  value: string;
  otherwise: 'stop' | 'goto';
  /** Step id to continue with when the check fails (otherwise = 'goto'). */
  gotoStep: string;
}

/** Tell the owner the result so far (bell, phone push, Windows notification). */
export interface NotifyStep {
  id: string;
  kind: 'notify';
  title: string;
}

export type Step = BotStep | ApprovalStep | ConditionStep | NotifyStep;

export type Schedule = { kind: 'none' } | { kind: 'daily'; time: string } | { kind: 'weekly'; time: string; days: number[] };

export interface Workflow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  steps: Step[];
  schedule: Schedule;
  enabled: boolean;
  version: number;
  /** sha256 of the webhook key; '' = no webhook. The key itself is shown once and never stored. */
  webhook_hash: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export type RunStatus = 'running' | 'waiting' | 'done' | 'error' | 'stopped' | 'interrupted';
export type RunTrigger = 'manual' | 'bot' | 'schedule' | 'webhook';

/** One executed step, in the order it happened (a loop gives a step several lines). */
export interface TraceItem {
  stepId: string;
  kind: Step['kind'];
  title: string;
  status: 'running' | 'waiting' | 'done' | 'error' | 'denied' | 'failed_check' | 'stopped' | 'interrupted';
  agentId?: string;
  threadId?: string;
  runId?: string;
  approvalId?: string;
  output: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface WorkflowRun {
  id: string;
  workflow_id: string;
  user_id: string;
  status: RunStatus;
  trigger: RunTrigger;
  /** Who or what started it, for the history line (a bot's name, "Webhook", …). */
  started_by: string;
  input: string;
  /** Input that came from outside (webhook): quoted as data for the bots, never an instruction. */
  untrusted: boolean;
  version: number;
  /** The steps as they were when the run started: an edit during a run does not change that run. */
  steps: Step[];
  trace: TraceItem[];
  result: string;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export const MAX_STEPS = 20;
/** How often one step may run within a run (the loop guard). */
export const MAX_VISITS = 4;
export const MAX_WORKFLOWS = 200;
export const STEP_TIMEOUT_MIN = 45;
