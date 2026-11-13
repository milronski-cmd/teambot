import type { PlanStep, ToolDef } from '../../core/types.js';
import { words } from '../../../shared/i18n-core.js';

/**
 * The plan card: a bot's steps as a checklist in the chat that updates while it works. Every engine feeds it: Codex
 * (todo_list items, turn/plan/updated), ACP agents (session/update "plan"), Claude Code (TodoWrite, where it has it)
 * and every bot through TeamBot's own plan_update tool (API bots directly, CLI bots over the MCP bridge).
 */

const MAX_STEPS = 30;

/** Any engine's plan shape → TeamBot's steps (null when it holds no usable step). */
export function normalizePlan(list: unknown): PlanStep[] | null {
  if (!Array.isArray(list)) return null;
  const out: PlanStep[] = [];
  for (const x of list.slice(0, MAX_STEPS)) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const text = String(o.text ?? o.step ?? o.content ?? o.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!text) continue;
    const raw = String(o.status ?? (o.completed === true ? 'completed' : '')).toLowerCase().replace(/[\s-]/g, '_');
    const status: PlanStep['status'] = /^(completed|complete|done|klaar)$/.test(raw) ? 'completed' : /^(in_?progress|inprogress|active|running|bezig)$/.test(raw) ? 'in_progress' : 'pending';
    out.push({ text, status });
  }
  return out.length ? out : null;
}

export function planSummary(steps: PlanStep[]): string {
  const done = steps.filter((s) => s.status === 'completed').length;
  return `${done} van ${steps.length} klaar`;
}

export function planTool(): ToolDef {
  return {
    name: 'plan_update',
    group: 'core',
    risk: 'read',
    internal: true,
    description:
      'Toon je plan als checklist in de chat en houd het bij terwijl je werkt. Gebruik dit bij een taak van drie of meer stappen: eerst het hele plan, daarna na elke afgeronde stap opnieuw met de nieuwe status. Geef steeds de hele lijst. Status: pending (nog te doen), in_progress (nu bezig, één tegelijk), completed (klaar).',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          maxItems: MAX_STEPS,
          items: {
            type: 'object',
            properties: { text: { type: 'string', description: 'De stap in een korte zin' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } },
            required: ['text', 'status'],
          },
        },
      },
      required: ['steps'],
    },
    summarize: (a) => {
      const steps = normalizePlan(a?.steps);
      return steps ? words('Plan bijwerken ({0} van {1} klaar)', steps.filter((s) => s.status === 'completed').length, steps.length) : words('Plan bijwerken');
    },
    async run(a) {
      const steps = normalizePlan(a?.steps);
      if (!steps) return { text: 'Geef steps mee: een lijst met { text, status }.', isError: true };
      return { text: `Plan bijgewerkt: ${planSummary(steps)}.`, data: { plan: steps } };
    },
  };
}
