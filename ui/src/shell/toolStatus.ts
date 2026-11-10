/** What a tool step in the chat shows: still running, waiting for the owner, done, failed, or refused. */
export type ToolStepStatus = 'pending' | 'running' | 'waiting' | 'done' | 'error' | 'denied' | undefined;

/**
 * The step's state from the call and its result. A refused call also gets a result (an error for the model: "De
 * gebruiker heeft deze actie geweigerd"), so "geweigerd" goes first; it read "Schreef een bestand" for a file that was
 * never written (practice test 0.4.4).
 */
export function toolStepStatus(call: { status?: string }, result: { isError?: boolean } | null | undefined): ToolStepStatus {
  if (call.status === 'denied') return 'denied';
  if (result) return result.isError ? 'error' : 'done';
  return call.status as ToolStepStatus;
}
