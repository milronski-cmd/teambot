/**
 * One turn on a CLI engine (Claude Code, Codex, an ACP agent …). The engine runs its own loop and keeps its own
 * session; TeamBot hands it the prompt and shows its steps, plan, files and text as they come in.
 */
import type { Agent, AttachmentRef, Ctx, Message, MessageParts, PlanStep, Run, Thread } from '../core/types.js';
import { now } from '../core/db.js';
import { redact } from '../core/secrets.js';
import { redactDetail } from './attempts.js';
import { checkBudget, lastCallCost, modelSaid, recordUnfinished, recordUsage, usageOf } from './budget.js';
import { afterRun, alive, DeltaStream, startAnswer } from './chat-loop.js';
import { cliContextStats, cliRecord, withServedTools } from './context-budget.js';
import type { Active, EngineFailure } from './engines.js';
import { plainEngineError, plainError } from './fallback.js';
import { attachmentRows, ensureInWorkspace } from './history.js';
import { CliLoopWatch, loopLimits, reportLoopStop } from './loops.js';
import { cliPrompt, userTz } from './prompt.js';
import { cliRunScope } from './runs.js';

/** Steps are saved at most this often; the chat keeps the last MAX_STEPS of a turn. */
const STEP_SAVE_MS = 400;
const MAX_STEPS = 200;

/** Returns the error (instead of throwing) when the engine failed, so the runner can switch to a reserve. */
export async function cliLoop(ctx: Ctx, run: Run, agent: Agent, thread: Thread, active: Active, system: string, signal: AbortSignal, reserve = false): Promise<EngineFailure | null> {
  // The daily budget (a CLI on a pay-per-use key reports its cost): its previous answer here is the estimate.
  checkBudget(ctx, run.user_id, agent, { cfg: active.cfg, estimate: lastCallCost(ctx, thread.id, agent.id, active.cfg.id) });
  const input = ctx.store.message(run.input_message_id);
  const prompt = cliPrompt(ctx, agent, thread, input);
  const rows = attachmentRows(ctx, input?.parts?.attachments);
  const attachments = rows.map((a) => ({ path: ensureInWorkspace(agent, a) || a.path, name: a.name, mime: a.mime }));
  // An estimate of what TeamBot hands the engine (agent/context-budget.ts); the engine's own count comes after the turn.
  const ctxEstimate = cliContextStats(ctx, agent, thread, { system, prompt, attachments: rows }).catch(() => null);
  const state = thread.provider_state?.[active.cfg.id] || {};
  // "<bot> werkt nu met <engine>" belongs above the answer, so it is said before the answer exists. On a reserve
  // the switch event already said it.
  if (!reserve) {
    try {
      ctx.services['cli-agents']?.switchNote?.({ thread, agentId: agent.id, providerId: active.cfg.id, kind: active.cfg.kind });
    } catch (e) {
      ctx.log.warn('[runner] switch note', e);
    }
  }
  const msg = startAnswer(ctx, run, agent, thread, active, { activity: [] });
  const stream = new DeltaStream(ctx, thread, msg);
  const activity: any[] = [];
  const files: AttachmentRef[] = [];
  // The plan card: the engine's own plan (Codex, ACP, Claude TodoWrite) or TeamBot's plan_update over MCP.
  let plan: { steps: PlanStep[]; updated_at: string } | undefined;
  let lastSave = 0;
  let stepTimer: NodeJS.Timeout | null = null;
  // The final answer of the turn: the text after its last step. A CLI turn is one message whose text also holds what
  // the engine said between its steps ("Nog een controleronde."); a bot that asked for this work gets only the answer
  // (parts.answer, read by modules/rooms). `mark`: where the text after the last step starts; `prev`: the part before.
  let mark = 0;
  let prev = 0;
  const step = () => {
    if (stream.text.length > mark && stream.text.slice(mark).trim()) prev = mark;
    mark = stream.text.length;
  };
  const answerPart = (content: string): { answer?: string } => {
    const last = stream.text.slice(mark).trim() || stream.text.slice(prev, mark).trim();
    return last && last.length < content.trim().length && content.includes(last) ? { answer: last } : {};
  };
  /** The one place this turn writes its answer: steps, files and plan so far, plus what the caller adds. */
  const save = (patch: Partial<Message> = {}, parts: Partial<MessageParts> = {}) => {
    if (stepTimer) clearTimeout(stepTimer);
    stepTimer = null;
    lastSave = Date.now();
    const cur = ctx.store.message(msg.id)!;
    const upd = ctx.store.updateMessage(msg.id, { ...patch, parts: { ...cur.parts, activity: activity.slice(-MAX_STEPS), attachments: files.length ? [...files] : undefined, ...(plan ? { plan } : {}), ...parts } });
    ctx.chat.emitMessage(thread, upd, 'message.updated');
  };
  const tz = () => userTz(ctx, thread.user_id);
  /** What the model sent back in this turn (text, thinking, its real steps; not TeamBot's notes about the session). */
  const heard = () => stream.reasoning + stream.text + activity.filter((a) => /^(tool|files|permission|denied)/.test(String(a?.kind || ''))).map((a) => String(a.title || '')).join('\n');
  // Loop guard (agent/loops.ts): the same step again and again stops the CLI; what it did stays, as a finished answer.
  const watch = new CliLoopWatch(loopLimits(agent));
  const loopStop = new AbortController();
  const endLoop = (usage?: Message['usage']) => {
    save({ content: stream.text, status: 'done', ...(usage ? { usage } : {}) }, answerPart(stream.text));
    reportLoopStop(ctx, run, agent, thread, watch.stopped!);
    return null;
  };
  try {
    // Inside this scope the code that reads the CLI's output reports its bytes and whether its process still exists.
    const scope = ctx.runs?.pulse ? { runId: run.id, pulse: ctx.runs.pulse } : null;
    const runAgent: NonNullable<typeof active.adapter.runAgent> = (...a) => (scope ? cliRunScope.run(scope, () => active.adapter.runAgent!(...a)) : active.adapter.runAgent!(...a));
    const r = await runAgent(
      { model: active.model, system, prompt, attachments, workspace: agent.workspace, sessionId: state.sessionId, accessMode: agent.access_mode, reasoning: agent.reasoning, agentId: agent.id, threadId: thread.id, runId: run.id, userId: thread.user_id },
      AbortSignal.any([signal, loopStop.signal]),
      (e) => {
        // Every event of the engine is a sign of life; a step says what it is doing (text and status: DeltaStream).
        if (e.type === 'activity') alive(ctx, run.id, e.item.title);
        else if (e.type !== 'text' && e.type !== 'reasoning' && e.type !== 'status' && e.type !== 'tool_start') alive(ctx, run.id);
        if (e.type === 'session') {
          const t = ctx.store.thread(thread.id)!;
          ctx.store.updateThread(thread.id, { provider_state: { ...t.provider_state, [active.cfg.id]: { ...(t.provider_state?.[active.cfg.id] || {}), sessionId: e.sessionId } } });
        } else if (e.type === 'activity') {
          // A step of the engine's own tools is progress of the chain between bots (modules/rooms/progress.ts). Read a
          // moment later: an engine marks its step for one of TeamBot's own tools as waiting right after reporting it.
          queueMicrotask(() => ctx.services.rooms?.engineStep?.(run, e.item));
          if (watch.add(e.item) && !loopStop.signal.aborted) loopStop.abort(new Error('Gestopt: steeds dezelfde stap'));
          // The same step again (CLI engines retitle a step when its result is in): one line, saved at once. A new
          // step is saved at most every 400 ms, and when that time is up, so a step that waits (an approval card) is
          // on screen too, not only after the next event.
          const again = activity.includes(e.item);
          // Only real steps split the text (a tool, files, a permission); a note about the session or context does not.
          if (!again && /^(tool|files|permission|denied)/.test(String(e.item.kind || ''))) step();
          if (!again) activity.push(e.item);
          if (again || Date.now() - lastSave > STEP_SAVE_MS) save();
          else if (!stepTimer) stepTimer = setTimeout(save, Math.max(0, STEP_SAVE_MS - (Date.now() - lastSave)));
        } else if (e.type === 'plan') {
          plan = { steps: e.steps.slice(0, 30), updated_at: now() };
          save();
        } else if (e.type === 'attachment') {
          if (files.length < 20 && !files.some((f) => f.id === e.ref.id)) files.push(e.ref);
          save();
        } else stream.push(e);
      },
    );
    stream.flush();
    // The model the CLI reports it used ("opus" or the CLI default → "claude-opus-5-5"); else what was asked for.
    const model = modelSaid(r.model, active.model);
    // A turn that failed before the engine gave any number still used what it did (an estimate, budget.ts).
    const none = !(r.usage.input > 0 || r.usage.output > 0);
    const usage = (r.error && none && recordUnfinished(ctx, run, agent, active.cfg, model, { reported: r.usage, sent: (await ctxEstimate)?.total, received: heard() })) || recordUsage(ctx, run, agent, active.cfg, model, r.usage);
    if (watch.stopped && !signal.aborted) return endLoop(usage);
    // With the TeamBot tools the CLI really got listed (fewer for an engine that lists again, cli-agents/toolhost.ts).
    const est0 = await ctxEstimate;
    const est = est0 && withServedTools(est0, ctx.services['cli-agents']?.servedTools?.(run.id));
    save(
      { content: r.text || stream.text, status: r.error ? 'error' : 'done', usage },
      {
        model,
        reasoning: stream.reasoning || undefined,
        error: r.error ? redact(plainEngineError(r.error, { engine: active.cfg.name, tz: tz() })) : undefined,
        errorDetail: r.error ? redactDetail(r.error) : undefined,
        ...answerPart(r.text || stream.text),
        ...(est ? { contextStats: cliRecord(ctx, agent, est, r.usage) } : {}),
      },
    );
    if (r.error) return { error: new Error(r.error), messageId: msg.id };
    await afterRun(ctx, agent, thread, run, r.text || stream.text);
    return null;
  } catch (e: any) {
    stream.flush();
    // Stopped (by the owner or the loop guard) or broken off: what the engine used until then counts too. Its own
    // numbers when it said them (withUsage), else an estimate (budget.ts).
    const used = recordUnfinished(ctx, run, agent, active.cfg, modelSaid(e?.model, active.model), { reported: usageOf(e), sent: (await ctxEstimate)?.total, received: heard() });
    if (watch.stopped && !signal.aborted) return endLoop(used || undefined);
    if (ctx.store.message(msg.id)!.status === 'streaming')
      save({ content: stream.text, status: signal.aborted ? 'cancelled' : 'error', ...(used ? { usage: used } : {}) }, signal.aborted ? {} : { error: redact(plainError(e, { engine: active.cfg.name, tz: tz() })), errorDetail: redactDetail(e) });
    if (signal.aborted) throw e;
    return { error: e, messageId: msg.id };
  } finally {
    if (stepTimer) clearTimeout(stepTimer);
  }
}
