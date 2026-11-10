/** A bot's claim on a task and its report, as the quality module sends them (see ./api QualityView). */
export interface ClaimLike {
  claim: { agentId: string; name: string; at: string } | null;
  reportedBy: { agentId: string; name: string; at: string } | null;
}

/**
 * The claim to show as "<bot> werkt eraan": none once that bot reported the task after claiming it. A task the bot
 * reported that waits for the owner ("Te controleren") keeps the claim, so the same bot can fix it, but nobody is
 * working on it then (practice test 0.4.4: one card said "Wacht op jou" and "Schrijver werkt eraan").
 */
export function activeClaim(q: ClaimLike | null | undefined): ClaimLike['claim'] {
  const c = q?.claim;
  if (!c) return null;
  const r = q.reportedBy;
  if (r && r.agentId === c.agentId && Date.parse(r.at) >= Date.parse(c.at)) return null;
  return c;
}
