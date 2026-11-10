/** One step of a plan (same shape as PlanStep in ./types; kept local so this file has no imports and is unit-tested). */
interface Step {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** "2 van 5 klaar" and the share done, for the plan card. */
export function planProgress(steps: Step[]): { done: number; total: number; percent: number; label: string } {
  const total = steps.length;
  const done = steps.filter((s) => s.status === 'completed').length;
  return { done, total, percent: total ? Math.round((done / total) * 100) : 0, label: total && done === total ? 'Alles klaar' : `${done} van ${total} klaar` };
}
