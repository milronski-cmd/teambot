import type { Ctx, Module } from '../../core/types.js';
import { RoutineEngine, type EngineOptions } from './engine.js';
import { migrations } from './schema.js';
import { routineRoutes } from './routes.js';
import { ROUTINE_SYSTEM_PROMPT, routineTools, RUN_GROUP, TOOL_GROUP } from './tools.js';
import { DutyService } from './duties/service.js';
import { dutyRoutes, dutyTools, REMINDER_GROUP } from './duties/tools.js';

/**
 * Routines & triggers: scheduled and event-driven bot runs with idempotent claims,
 * missed-run policy, retries, limits, quiet path, receipts and signed webhooks.
 * Routines only run while this TeamBot process runs (desktop awake / server up).
 */
export function createRoutinesModule(opts: EngineOptions = {}): Module {
  const engines = new WeakMap<Ctx, RoutineEngine>();
  return {
    id: 'routines',
    label: 'Routines & triggers',
    migrations,
    init(ctx) {
      const engine = new RoutineEngine(ctx, opts);
      engines.set(ctx, engine);
      // Vaste taken and reminders: the same engine, with a measurement before any model call (duties/).
      const duties = new DutyService(ctx, engine);
      engine.duties = duties;
      ctx.services.routines = {
        engine,
        /** Vaste taken (standing duties), reminders and the owner's budget for proactive work. */
        duties,
        list: (userId: string, agentId?: string) => engine.routinesOf(userId, agentId),
        exportUser: (userId: string) => engine.exportUser(userId),
        /** A bot's routines for a bot or team template: name, task, schedule and safe options; no triggers, delivery or ids. */
        exportForAgent: (userId: string, agentId: string) =>
          engine
            .routinesOf(userId, agentId)
            .filter((r) => !r.options.waitpoint)
            .map((r) => ({ name: r.name, prompt: r.prompt, schedule: r.schedule, timezone: r.timezone, options: { missedPolicy: r.options.missedPolicy, maxRunsPerDay: r.options.maxRunsPerDay, maxCostPerDayUsd: r.options.maxCostPerDayUsd, retries: r.options.retries, timeoutMinutes: r.options.timeoutMinutes, notify: r.options.notify, runIn: r.options.runIn, important: r.options.important } })),
        /** Install template routines for a new bot: always paused, the owner turns them on. */
        importForAgent: (userId: string, agentId: string, defs: any[]) => {
          let n = 0;
          for (const d of (Array.isArray(defs) ? defs : []).slice(0, 50)) {
            const o = d?.options && typeof d.options === 'object' ? d.options : {};
            const opts = { missedPolicy: o.missedPolicy, maxRunsPerDay: o.maxRunsPerDay, maxCostPerDayUsd: o.maxCostPerDayUsd, retries: o.retries, timeoutMinutes: o.timeoutMinutes, notify: o.notify, runIn: o.runIn, important: o.important === true };
            const r = engine.create(userId, { name: d?.name, prompt: d?.prompt, agent_id: agentId, timezone: d?.timezone, schedule: d?.schedule, options: opts }, { status: 'paused', allowPastOnce: true });
            ctx.store.update('routines', r.id, { paused_reason: 'Geïmporteerd: staat uit tot je hem aanzet' });
            n++;
          }
          return n;
        },
      };

      ctx.tools.registerGroup(TOOL_GROUP);
      ctx.tools.registerGroup(RUN_GROUP);
      const tools = routineTools(engine);
      for (const t of tools.static) ctx.tools.register(t);
      // The quiet-path tool: in routine threads, and in a bot's main chat while a routine runs there.
      ctx.tools.addProvider((_agent, thread) => (thread.kind === 'routine' || engine.routineRunIn(thread.id) ? [tools.noUpdate] : []));

      ctx.tools.registerGroup(REMINDER_GROUP);
      const dt = dutyTools(engine, duties);
      for (const t of dt.static) ctx.tools.register(t);
      // duty_report: only in the routine thread of a vaste taak.
      ctx.tools.addProvider((_agent, thread) => (thread.kind === 'routine' && engine.routine(thread.meta?.routineId)?.options.duty ? [dt.report] : []));
      dutyRoutes(ctx, engine, duties);

      ctx.hooks.systemPrompt.push(({ thread }) => (thread.kind === 'routine' ? ROUTINE_SYSTEM_PROMPT : null));
      ctx.hooks.agentDeleted.push(({ agentId, userId }) => {
        for (const r of engine.routinesOf(userId, agentId)) engine.remove(r);
      });

      routineRoutes(ctx, engine);
    },
    start(ctx) {
      engines.get(ctx)?.start();
    },
    stop(ctx) {
      engines.get(ctx)?.stop();
    },
  };
}

const mod: Module = createRoutinesModule();
export default mod;
