/** Shared types of the quality module ("werk dat echt af is"). Other modules import these as types only. */

/** Which kind of task a quality record belongs to. */
export type TaskKind = 'room' | 'teamdata' | 'delegation';

/**
 * State of the second look:
 *  none     nothing reported yet;
 *  passed   checked and done ("klaar");
 *  review   needs the owner ("te controleren"): no or wrong evidence, the check doubts, or no engine for the check;
 *  cant     the bot honestly said it could not do it ("kon niet");
 *  skipped  the owner turned the check off for this task (evidence is still required);
 *  owner    the owner decided himself (approved, or set it to done).
 */
export type CheckState = 'none' | 'passed' | 'review' | 'cant' | 'skipped' | 'owner';

export type EvidenceType = 'file' | 'link' | 'message' | 'attachment' | 'screenshot' | 'output' | 'text';

/** One piece of evidence after TeamBot looked at it itself (before any model call). */
export interface EvidenceItem {
  type: EvidenceType;
  value: string;
  /** true = verified (file exists, message found, output matches a real step); false = wrong; null = could not check. */
  ok: boolean | null;
  /** Plain words: what TeamBot saw ("bestaat, 2,1 kB", "niet gevonden", "link niet geopend"). */
  note: string;
  /** A short piece of the content, for the checker (never shown in full). */
  excerpt?: string;
}

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

/** What the interface shows of a task's quality record. */
export interface QualityView {
  doneWhen: string;
  doneWhenBy: 'agent' | 'user' | null;
  skipCheck: boolean;
  claim: { agentId: string; name: string; at: string } | null;
  outcome: 'done' | 'cant' | null;
  outcomeReason: string;
  reportedBy: { agentId: string; name: string; at: string } | null;
  evidence: EvidenceItem[];
  check: { state: CheckState; label: string; reason: string; engine: string; at: string | null };
  open: boolean;
}

export const CHECK_LABEL: Record<CheckState, string> = {
  none: 'Nog niet afgemeld',
  passed: 'Gecontroleerd: klaar',
  review: 'Te controleren',
  cant: 'Kon niet',
  skipped: 'Klaar (controle overgeslagen)',
  owner: 'Goedgekeurd door jou',
};
