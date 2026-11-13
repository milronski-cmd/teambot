import type { CheckState, EvidenceItem, QualityView, TaskKind } from '../../../shared/quality.js';

/** Shared types of the quality module ("werk dat echt af is"). Other modules import these as types only. */

/** The shapes the task pages show too: shared/quality.ts. */
export type { CheckState, EvidenceItem, QualityView, TaskKind };

/** A step the bot really took in the run that reported the task (TeamBot's own record, not the bot's claim). */
export interface StepItem {
  tool: string;
  summary: string;
  ok: boolean;
  /** Start of the tool's output (for matching evidence and for the checker). */
  out?: string;
}

export interface Verdict {
  state: CheckState;
  reason: string;
  engine?: string;
  tokens?: number;
  /** The check could not run because its engine is at its usage limit: TeamBot tries again at this time (epoch ms). */
  retryAt?: number;
  /** Which limit: a free tier's (OpenCode's free daily limit) or a usage limit, and of which engine. */
  limit?: { free: boolean; engine: string };
  /** The checker answered, but not with a verdict: the look is done again. */
  unclear?: boolean;
}

export interface QualityRow {
  id: string;
  user_id: string;
  kind: TaskKind;
  ref: string;
  title: string;
  done_when: string;
  done_when_by: 'agent' | 'user' | null;
  skip_check: boolean;
  claimed_by: string | null;
  claimed_at: string | null;
  outcome: 'done' | 'cant' | null;
  outcome_reason: string;
  reported_by: string | null;
  reported_at: string | null;
  evidence: EvidenceItem[];
  steps: StepItem[];
  check_state: CheckState;
  check_reason: string;
  check_engine: string;
  check_tokens: number | null;
  checked_at: string | null;
  /** Waits for the owner (shown under "Wacht op jou"). */
  open: boolean;
  /** A check that waited for a limit runs again at this time (ISO), with what it needs in `recheck_input`. */
  recheck_at: string | null;
  recheck_n: number;
  recheck_input: { result?: string; description?: string; requireEvidence?: boolean };
  created_at: string;
  updated_at: string;
}

export const CHECK_LABEL: Record<CheckState, string> = {
  none: 'Nog niet afgemeld',
  passed: 'Gecontroleerd: klaar',
  review: 'Te controleren',
  cant: 'Kon niet',
  skipped: 'Klaar (controle overgeslagen)',
  owner: 'Goedgekeurd door jou',
};
