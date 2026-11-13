import type { ActivityItem, Ctx, Run, ToolDef } from '../../core/types.js';
import { now } from '../../core/db.js';

/**
 * Progress of a chain of work between bots: did anything really happen? The loop rule (orchestration.ts loopError)
 * and the notice for two bots that only talk (stallCheck) ask it. One place records it and one place reads it, for
 * every kind of AI alike:
 *
 * - a TeamBot tool that ran well (tools/execute.ts, on every route: an API model, a local model, a CLI engine over
 *   TeamBot's MCP server) and did more than read or hand over: it wrote, sent, ran something or told the owner;
 * - a step of a CLI engine's own tools (agent/cli-loop.ts): the engine wrote or deleted a file, ran a command or used
 *   an app. Those never pass a TeamBot tool, and with full access not even the permission gate, so the CLI loop, which
 *   sees every step, reports them.
 *
 * The mark is "this chain did something at time T", in its own table keyed by the chain (not the run's meta: the turn
 * loops write that back from a copy and would wipe the mark). Unknown tools count: when in doubt it is not a loop.
 */

/** Tools with which a bot says something to the owner: a message to him is progress, although they are team tools. */
const TO_OWNER = new Set(['notify_user', 'ask_user', 'share_file']);

/** What an engine's step touched that counts as doing something (reading, searching and fetching do not). */
const HARD_OPS = new Set(['write', 'delete', 'exec', 'app']);

/**
 * Lines that are not the engine's own step: a refusal, a failure, or the line of one of TeamBot's own tools (the tool
 * host writes "tool_result" there; that call counts where it ran, in executeTool, with its risk).
 */
const NOT_A_STEP = new Set(['denied', 'tool_error', 'tool_result']);

/** The chain a run belongs to, the same way as Orchestrator.callerChain: started by a colleague, or its own input. */
export function chainOf(run: Pick<Run, 'id' | 'input_message_id' | 'meta'>): string {
  return (run.meta?.team?.chainId as string | undefined) || run.input_message_id || run.id;
}

/** Write down that this run's chain did something now. Never throws: it is only a mark. */
export function stepDone(ctx: Ctx, run: Run | null | undefined, what: string) {
  try {
    if (!run?.id || !run.user_id) return;
    ctx.store.exec(
      'INSERT INTO room_progress (chain_id, user_id, at, what, n) VALUES (?, ?, ?, ?, 1) ON CONFLICT(chain_id) DO UPDATE SET at = excluded.at, what = excluded.what, n = room_progress.n + 1',
      chainOf(run),
      run.user_id,
      now(),
      String(what).slice(0, 200),
    );
  } catch (e) {
    ctx.log.warn('[rooms] progress mark', e);
  }
}

/** A TeamBot tool ran well (executeTool). `risk`: the risk of this call. */
export function toolDone(ctx: Ctx, run: Run | null | undefined, tool: Pick<ToolDef, 'name' | 'group'> | null | undefined, risk: string) {
  if (!tool || ((risk === 'read' || tool.group === 'team') && !TO_OWNER.has(tool.name))) return;
  stepDone(ctx, run, tool.name);
}

/** A step of a CLI engine (agent/cli-loop.ts): only a finished step of its own that wrote, deleted, ran or used an app. */
export function engineStep(ctx: Ctx, run: Run | null | undefined, item: ActivityItem | null | undefined) {
  if (!item || item.pending || NOT_A_STEP.has(String(item.kind)) || !Array.isArray(item.facts)) return;
  const hard = item.facts.find((f) => !!f && HARD_OPS.has(f.op));
  if (hard) stepDone(ctx, run, `${hard.op}: ${hard.target}`);
}

/**
 * Did anything change since `since` in this chain? A step that did something (above), or a task on the board that
 * moved on (to bezig, te controleren, klaar or geblokkeerd). A different answer to the same request is not in here:
 * the loop rule looks at that itself; for the stall notice it does not count.
 */
export function progressSince(ctx: Ctx, userId: string, chainId: string, since: string): boolean {
  const { store } = ctx;
  if (store.one("SELECT 1 FROM room_tasks WHERE user_id = ? AND updated_at > ? AND status != 'todo' LIMIT 1", userId, since)) return true;
  return !!store.one('SELECT 1 FROM room_progress WHERE chain_id = ? AND user_id = ? AND at > ?', chainId, userId, since);
}

/** Marks of chains that ended long ago are of no use any more. */
export function pruneProgress(ctx: Ctx, days = 90) {
  try {
    ctx.store.exec('DELETE FROM room_progress WHERE at < ?', new Date(Date.now() - days * 86_400_000).toISOString());
  } catch (e) {
    ctx.log.warn('[rooms] progress prune', e);
  }
}
