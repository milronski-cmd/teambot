import type { Module } from '../../core/types.js';
import { qualityMigrations } from './schema.js';
import { QualityService } from './service.js';
import { qualityRoutes } from './routes.js';
import { verifyPrompt } from './prompt.js';
import { isCorrection, learnFromCorrection } from './lessons.js';

/**
 * Werk dat echt af is: "klaar als" per task, an atomic claim on board tasks, a second look with a fresh context before
 * "klaar" (evidence required; without it "te controleren"), an honest "kon niet", lessons from the owner's corrections
 * (through the memory module's public service) and, for recurring work done well, a skill suggestion.
 *
 * The task board (rooms), the team database (teamdata) and delegations call `ctx.services.quality`; loop detection
 * lives in the runner (server/agent/loops.ts). See docs/modules/quality.md.
 */
/** The recheck timers of each running app (a test process runs several). */
const timers = new WeakMap<object, ReturnType<typeof setInterval>[]>();

const mod: Module = {
  id: 'quality',
  label: 'Werk dat af is',
  migrations: qualityMigrations,
  init(ctx) {
    const svc = new QualityService(ctx);
    const pending = new Set<Promise<any>>();
    const track = (p: Promise<any>) => {
      pending.add(p);
      p.catch((e) => ctx.log.warn('[quality]', e?.message || e)).finally(() => pending.delete(p));
    };

    ctx.services.quality = {
      svc,
      ensure: svc.ensure.bind(svc),
      view: svc.viewFor.bind(svc),
      setDoneWhen: svc.setDoneWhen.bind(svc),
      setSkip: svc.setSkip.bind(svc),
      claim: svc.claim.bind(svc),
      release: svc.release.bind(svc),
      holder: svc.holder.bind(svc),
      report: svc.report.bind(svc),
      checkDelegation: svc.checkDelegation.bind(svc),
      ownerDecided: svc.ownerDecided.bind(svc),
      reopen: svc.reopen.bind(svc),
      remove: svc.remove.bind(svc),
      workerOf: svc.workerOf.bind(svc),
      tellBot: svc.tellBot.bind(svc),
      /** Second looks that waited for a usage limit and are due now (the module runs this every minute). */
      recheckDue: svc.recheckDue.bind(svc),
      /** Test/diagnostic hook: wait for lessons that are still being made. */
      drain: async () => {
        while (pending.size) await Promise.allSettled([...pending]);
      },
      exportUser: (userId: string) => ({
        quality: {
          tasks: ctx.store.find('quality_tasks', { user_id: userId }),
          lessons: ctx.store.find('quality_lessons', { user_id: userId }),
          suggestions: ctx.store.find('quality_suggestions', { user_id: userId }),
        },
      }),
      deleteUser: (userId: string) => svc.deleteUser(userId),
    };

    // The board lines only for a bot that really has the board tools (the prompt never names a tool it lacks).
    const canBoard = (agent: any) =>
      ctx.tools.groupEnabled(agent, 'team') &&
      ['task_claim', 'task_done'].every((n) => {
        const t = ctx.tools.get(n);
        return !!t && ctx.broker.decide(agent, t) !== 'deny';
      });
    ctx.hooks.systemPrompt.push(({ agent }) => verifyPrompt(agent, { board: canBoard(agent) }));

    // The owner corrects a bot: a lesson for that bot (after the message is saved; never in the way of the answer).
    ctx.hooks.messageCreated.push(({ message, thread }) => {
      // (messages TeamBot posts in the owner's name — a decision's answer, a task sent back — carry a kind: no lesson)
      if (message.role !== 'user' || message.author_type !== 'user' || message.author_id !== thread.user_id || message.parts?.kind || !isCorrection(message.content)) return;
      setImmediate(() => track(learnFromCorrection(svc, message, thread)));
    });

    ctx.hooks.agentDeleted.push(({ agentId }) => {
      ctx.store.exec('UPDATE quality_tasks SET claimed_by = NULL, claimed_at = NULL WHERE claimed_by = ?', agentId);
      ctx.store.exec("UPDATE quality_suggestions SET status = 'dismissed' WHERE agent_id = ? AND status = 'open'", agentId);
    });

    qualityRoutes(ctx, svc);
  },
  start(ctx) {
    // A second look that met a usage limit (OpenCode's free daily limit) runs again after the reset; stored, so also
    // after a restart. Every minute, a few at a time.
    const tick = () => void ctx.services.quality?.recheckDue?.().catch((e: any) => ctx.log.warn('[quality] recheck', e?.message || e));
    const list = [setInterval(tick, 60_000), setTimeout(tick, 5_000)];
    for (const t of list) t.unref?.();
    timers.set(ctx, list);
  },
  stop(ctx) {
    for (const t of timers.get(ctx) || []) clearTimeout(t);
    timers.delete(ctx);
  },
};

export default mod;
