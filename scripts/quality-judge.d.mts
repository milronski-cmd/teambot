// Types for scripts/quality-judge.mjs (used by tests/quality/judge.test.ts).
export interface JudgeInput {
  rubric: string[];
  material: string;
  context?: string;
}
export interface JudgeVerdict {
  ok: boolean;
  detail: string;
  skipped?: boolean;
}
export interface JudgeStats {
  label: string;
  model: string;
  think: boolean | undefined;
  calls: number;
  errors: number;
}
export function judgePrompt(o: JudgeInput): string;
export function makeJudge(model: string, opts?: { base?: string; think?: boolean; timeoutMs?: number }): { judge: (o: JudgeInput) => Promise<JudgeVerdict>; stats: JudgeStats };
