/**
 * "Werk dat echt af is": what a task's quality record looks like on the page. The server works it out
 * (server/modules/quality, which also has the types only it needs); the task pages show it. Types only.
 */

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

type EvidenceType = 'file' | 'link' | 'message' | 'attachment' | 'screenshot' | 'output' | 'text';

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
