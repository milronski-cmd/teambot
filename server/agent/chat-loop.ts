/**
 * One turn on an API engine: call the model, run the tools it asks for, call it again with the results, until it
 * answers without tools (or a limit of steps, a loop or a stop ends the turn). Streaming, steering by the owner while
 * it runs, the context budget and the loop guard meet here; each of those has its own file.
 */
import type { Agent, ChatMsg, ChatResult, Ctx, Message, MessageParts, PlanStep, Run, StreamEvent, Thread, ToolCall, ToolDef } from '../core/types.js';
import { now } from '../core/db.js';
import { redact } from '../core/secrets.js';
import { categoryOf, ProviderError } from '../providers/common.js';
import { executeTool, stepSummary } from '../tools/execute.js';
import type { OnDemand } from '../tools/selection.js';
import { toolLabel } from '../../shared/toolLabels.js';
import { readImageText } from './attachments.js';
import { checkBudget, lastCallCost, recordUnfinished, recordUsage, usageOf } from './budget.js';
import { ContextSaver, cutMiddle } from './context-budget.js';
import type { Active, EngineFailure } from './engines.js';
import { plainError } from './fallback.js';
import { buildHistory, toolsCrowdOut } from './history.js';
import { LoopGuard, loopLimits, maxSteps, reportLoopStop, skippedText, wrapUpNote } from './loops.js';
import { userTz } from './prompt.js';
import { hasPendingSteer } from './queue.js';

const MAX_TOOL_OUTPUT = 30_000;
/** How often steering may restart a model call within one run; after that a steer message waits for the next step. */
const MAX_STEER_RESTARTS = 8;

/** Batches streaming deltas into websocket events and periodically persists partial text. */
export class DeltaStream {
  text = '';
  reasoning = '';
  private pendingText = '';
  private pendingReasoning = '';
  private timer: NodeJS.Timeout | null = null;
  private lastSave = Date.now();
  constructor(
    private ctx: Ctx,
    private thread: Thread,
    private msg: Message,
    private tools: ToolDef[] = [],
  ) {}
  push(e: StreamEvent) {
    // Every chunk is a sign of life (agent/runs.ts RunPulse); writing text is no particular step any more.
    alive(this.ctx, this.msg.run_id, e.type === 'status' ? e.text : e.type === 'tool_start' ? preparingText(e.name, this.tools) : e.type === 'text' ? '' : undefined);
    if (e.type === 'text') {
      this.text += e.delta;
      this.pendingText += e.delta;
    } else if (e.type === 'reasoning') {
      this.reasoning += e.delta;
      this.pendingReasoning += e.delta;
    } else if (e.type === 'status') {
      this.ctx.chat.emit(this.thread, 'message.status', { threadId: this.thread.id, messageId: this.msg.id, text: e.text });
      return;
    } else if (e.type === 'tool_start') {
      this.ctx.chat.emit(this.thread, 'message.status', { threadId: this.thread.id, messageId: this.msg.id, text: preparingText(e.name, this.tools) });
      return;
    }
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 50);
  }
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pendingText || this.pendingReasoning) {
      this.ctx.chat.emit(this.thread, 'message.delta', { threadId: this.thread.id, messageId: this.msg.id, text: this.pendingText, reasoning: this.pendingReasoning });
      this.pendingText = '';
      this.pendingReasoning = '';
    }
    if (Date.now() - this.lastSave > 2000) {
      this.lastSave = Date.now();
      this.ctx.store.update('messages', this.msg.id, { content: this.text });
    }
  }
}

/** A sign of life of a run: something real just happened (agent/runs.ts RunPulse sends it on, throttled). */
export function alive(ctx: Ctx, runId: string | null | undefined, doing?: string) {
  if (runId) ctx.runs?.pulse?.touch(runId, doing);
}

/** A message of the bot in this run (an answer, a tool result), saved and sent to everyone who watches the chat. */
function botMessage(ctx: Ctx, run: Run, agent: Agent, thread: Thread, m: Pick<Message, 'role'> & Partial<Pick<Message, 'content' | 'status' | 'parts'>>): Message {
  const msg = ctx.store.createMessage({ thread_id: thread.id, author_type: 'agent', author_id: agent.id, author_name: agent.name, run_id: run.id, ...m });
  alive(ctx, run.id);
  ctx.chat.emitMessage(thread, msg);
  return msg;
}

/** The answer a model call or CLI turn is about to write: on screen at once, with the engine that writes it. */
export function startAnswer(ctx: Ctx, run: Run, agent: Agent, thread: Thread, active: Active, parts: Partial<MessageParts> = {}): Message {
  return botMessage(ctx, run, agent, thread, { role: 'assistant', status: 'streaming', parts: { model: active.model, provider: active.cfg.kind, providerId: active.cfg.id, providerName: active.cfg.name, ...parts } });
}

/** Progress line while the model prepares a tool call, in words ("Zoekt op internet…", "Gebruikt Notion…"). */
export function preparingText(name: string, tools: ToolDef[] = []): string {
  const app = tools.find((t) => t.name === name)?.app;
  return app ? `Gebruikt ${app}…` : `${toolLabel({ name }, true)}…`;
}

function setCall(ctx: Ctx, thread: Thread, messageId: string, callId: string, patch: Partial<ToolCall>) {
  const m = ctx.store.message(messageId);
  if (!m?.parts?.toolCalls) return;
  const toolCalls = m.parts.toolCalls.map((c) => (c.id === callId ? { ...c, ...patch } : c));
  const upd = ctx.store.updateMessage(messageId, { parts: { ...m.parts, toolCalls } });
  ctx.chat.emitMessage(thread, upd, 'message.updated');
}

/** A tool call that is not run (loop guard): a tool result that says why, so the history stays complete. */
function skipTool(ctx: Ctx, run: Run, agent: Agent, thread: Thread, messageId: string, call: ToolCall, text: string) {
  botMessage(ctx, run, agent, thread, { role: 'tool', content: text, parts: { toolResult: { toolCallId: call.id, name: call.name, isError: true, ...(call.via ? { via: call.via } : {}) } } });
  setCall(ctx, thread, messageId, call.id, { status: 'denied' });
}

async function runTool(ctx: Ctx, run: Run, agent: Agent, thread: Thread, messageId: string, call: ToolCall, tools: ToolDef[], signal: AbortSignal, demand: OnDemand) {
  setCall(ctx, thread, messageId, call.id, { status: 'running' });
  alive(ctx, run.id, call.summary ? `${toolLabel(call, true)}: ${call.summary}` : toolLabel(call, true));
  const { out, denied, tool } = await executeTool({
    ctx,
    agent,
    thread,
    run,
    tools,
    name: call.name,
    args: call.args,
    callId: call.id,
    signal,
    onState: (st) => {
      alive(ctx, run.id);
      setCall(ctx, thread, messageId, call.id, { status: st });
    },
    progress: (text) => {
      alive(ctx, run.id);
      ctx.chat.emit(thread, 'tool.progress', { threadId: thread.id, messageId, callId: call.id, text });
    },
  });
  alive(ctx, run.id, '');
  // A tool outside the list: the fields when the arguments did not fit, and once what the bot must know about its part.
  const final = await demand.after(tool, call.args, out, denied);
  botMessage(ctx, run, agent, thread, { role: 'tool', content: cutMiddle(final.text || '', MAX_TOOL_OUTPUT), parts: { toolResult: { toolCallId: call.id, name: call.name, isError: !!final.isError, ...(call.via ? { via: call.via } : {}) }, attachments: final.attachments } });
  setCall(ctx, thread, messageId, call.id, { status: denied ? 'denied' : final.isError ? 'error' : 'done' });
  if (!final.isError && Array.isArray(final.data?.plan)) setPlan(ctx, thread, run, messageId, final.data.plan);
  return final;
}

/** The plan card (plan_update): one per run, on its latest message, updated in place. */
function setPlan(ctx: Ctx, thread: Thread, run: Run, messageId: string, steps: PlanStep[]) {
  for (const m of ctx.store.all<{ id: string }>("SELECT id FROM messages WHERE run_id = ? AND role = 'assistant' AND id != ? AND json_extract(parts, '$.plan') IS NOT NULL", run.id, messageId)) {
    const old = ctx.store.message(m.id);
    if (!old) continue;
    const { plan: _drop, ...rest } = old.parts as any;
    ctx.chat.emitMessage(thread, ctx.store.updateMessage(old.id, { parts: rest }), 'message.updated');
  }
  const cur = ctx.store.message(messageId);
  if (cur) ctx.chat.emitMessage(thread, ctx.store.updateMessage(messageId, { parts: { ...cur.parts, plan: { steps, updated_at: now() } } }), 'message.updated');
}

export async function afterRun(ctx: Ctx, agent: Agent, thread: Thread, run: Run, finalText: string) {
  for (const h of ctx.hooks.afterRun) {
    try {
      await h({ agent, thread, run: ctx.store.run(run.id)!, finalText });
    } catch (e) {
      ctx.log.error('[hooks.afterRun]', e);
    }
  }
}

/** An answer without text or tool call: an error on the answer and on the run (the same words the chat used). */
function emptyAnswer(ctx: Ctx, thread: Thread, m: Message, thought: boolean): EngineFailure {
  const error = thought ? 'Het model gaf geen antwoord. Probeer het opnieuw of zet het denkniveau lager.' : 'Het model gaf een leeg antwoord. Probeer het opnieuw.';
  ctx.chat.emitMessage(thread, ctx.store.updateMessage(m.id, { status: 'error', parts: { ...m.parts, error } }), 'message.updated');
  return { error: new Error(error), messageId: m.id };
}

const hasImage = (messages: ChatMsg[]) => messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image'));

/** Whether this engine's model looks at images, as TeamBot knows it (the facts on the bot page). Unknown: yes, as before. */
async function seesImages(ctx: Ctx, active: Active, userId: string): Promise<boolean> {
  try {
    const m = await ctx.services.modelCatalog?.facts?.(active.cfg, userId, active.model);
    return m?.vision !== false;
  } catch {
    return true;
  }
}

/** Returns the error (instead of throwing) when the engine failed, so the runner can switch to a reserve. */
export async function chatLoop(ctx: Ctx, run: Run, agent: Agent, thread: Thread, active: Active, system: string, signal: AbortSignal): Promise<EngineFailure | null> {
  if (!active.adapter.chat) throw new Error('Deze provider ondersteunt geen chat');
  // Context budget (agent/context-budget.ts): per model call the history and tool list, shortened where safe, with
  // the tokens per part on the answer. `tools` = every tool a call may name; the model is listed the core of them,
  // plus tools_find and tools_call for the rest (tools/selection.ts).
  const saver = new ContextSaver(ctx, agent, thread, run, await ctx.tools.forAgent(agent, thread), system, (o) => buildHistory(ctx, agent, thread, o));
  const tools = saver.tools;
  const maxTurns = maxSteps(agent);
  let finalText = '';
  let turn = 0;
  let restarts = 0;
  let calls = 0;
  // The turn asked for a tool somewhere: then an empty last answer is a quiet end, not a failure.
  let acted = false;
  // Loop guard (agent/loops.ts): after a stop the bot gets one last step, without running tools, to ask for help.
  const guard = new LoopGuard(loopLimits(agent));
  // Images go to a model that can look at them. Whether this one can is looked up once, when there is an image to send
  // (undefined: not yet); viewing switched off for the bot counts as no.
  let vision: boolean | undefined = agent.settings?.vision === false ? false : undefined;
  for (; turn < maxTurns; turn++) {
    if (signal.aborted) throw signal.reason || new Error('Gestopt');
    // The daily budget before every model call, not only before the run (acceptance round 6, B-70: one long run went
    // past it). The previous call of this bot here is the estimate for this one; after steps of this run that is the
    // previous step. Over budget: the run stops here, with what it already did above (BudgetError, midRun).
    checkBudget(ctx, run.user_id, agent, { cfg: active.cfg, estimate: lastCallCost(ctx, thread.id, agent.id, active.cfg.id), midRun: calls > 0 });
    let step0 = saver.next({ vision: vision !== false });
    // A model that cannot look at images refused the whole call ("Multimodal data provided…", Ollama, 12 nov). It gets
    // the text on the images of this message instead (OCR, agent/attachments.ts), or a note that there is an image it
    // cannot see. The same on every API engine; a CLI engine reads its attachments itself.
    if (vision === undefined && hasImage(step0.messages)) {
      vision = await seesImages(ctx, active, thread.user_id);
      if (!vision) {
        await readImageText(ctx, agent, ctx.store.message(run.input_message_id), signal);
        step0 = saver.next({ vision: false });
      }
    }
    const { messages, truncated, specs, stats } = step0;
    const msg = startAnswer(ctx, run, agent, thread, active);
    const stream = new DeltaStream(ctx, thread, msg, tools);
    // Steering (A-21): a message the owner adds while this model call is still generating stops the call and the
    // step starts again with the message in it, in the same turn. No tool of this step has run yet (tools only run
    // after the call), so nothing is done twice. During tool execution the message waits for the next model call.
    const step = new AbortController();
    const stopStep = () => step.abort(signal.reason);
    signal.addEventListener('abort', stopStep, { once: true });
    let steeredMid = false;
    const offSteer = restarts < MAX_STEER_RESTARTS
      ? ctx.events.on('queue.steered', (ev) => {
          if (ev.data?.runId !== run.id || step.signal.aborted) return;
          steeredMid = true;
          step.abort(new Error('Bijgestuurd'));
        })
      : () => {};
    let result: ChatResult;
    let toolsBegun = '';
    try {
      result = await active.adapter.chat!({ model: active.model, system: guard.stopped ? `${system}\n\n${wrapUpNote(guard.stopped)}` : system, messages, tools: specs, reasoning: agent.reasoning, historyTruncated: truncated }, step.signal, (e) => {
        if (e.type === 'tool_start') toolsBegun += e.name;
        if (!step.signal.aborted) stream.push(e);
      });
      // An engine that swallowed the stop and returned what it had: still start the step again with the message.
      if (steeredMid) throw new Error('Bijgestuurd');
      stream.flush();
    } catch (e: any) {
      stream.flush();
      // What the call used until it ended without its result (stopped, steered, failed) is counted too (budget.ts).
      const used = recordUnfinished(ctx, run, agent, active.cfg, active.model, { reported: usageOf(e), sent: stats.total, received: stream.reasoning + stream.text + toolsBegun });
      if (steeredMid && !signal.aborted) {
        // What the bot had written so far stays visible, marked as interrupted, but the model does not see it as an
        // answer (history.ts skips it). Nothing written yet: the attempt disappears (the steer message says it).
        restarts++;
        const partial = stream.text.trim();
        const patch = partial
          ? { content: stream.text, status: 'cancelled' as const, parts: { ...msg.parts, steered: true, reasoning: stream.reasoning || undefined } }
          : { deleted: true, status: 'cancelled' as const, parts: { ...msg.parts, steered: true, switched: true } };
        ctx.chat.emitMessage(thread, ctx.store.updateMessage(msg.id, patch as any), 'message.updated');
        turn--;
        continue;
      }
      const aborted = signal.aborted;
      // "Too long" while the conversation is short: name the real cause, the tools and instructions (B-20).
      if (e instanceof ProviderError && categoryOf(e) === 'context' && toolsCrowdOut(system, specs, messages)) e.category = 'tools';
      const upd = ctx.store.updateMessage(msg.id, {
        content: stream.text,
        status: aborted ? 'cancelled' : 'error',
        ...(used ? { usage: used } : {}),
        parts: { ...msg.parts, reasoning: stream.reasoning || undefined, error: aborted ? undefined : redact(plainError(e, { engine: active.cfg.name, tz: userTz(ctx, thread.user_id) })) },
      });
      ctx.chat.emitMessage(thread, upd, 'message.updated');
      if (aborted) throw e;
      return { error: e, messageId: msg.id };
    } finally {
      offSteer();
      signal.removeEventListener('abort', stopStep);
    }
    const usage = recordUsage(ctx, run, agent, active.cfg, result.model || active.model, result.usage);
    calls++;
    const toolCalls: ToolCall[] = result.toolCalls.map((c) => {
      // A tools_call is, from here on, the call it names: shown, checked, logged and stored as that tool.
      const real = saver.demand.resolve(c.name, c.args);
      const t = tools.find((x) => x.name === real.name);
      return { ...c, ...real, ...(real.name !== c.name ? { via: c.name } : {}), status: 'pending', ...(t?.summarize ? stepSummary(t, real.args) : {}) };
    });
    const updated = ctx.store.updateMessage(msg.id, {
      content: result.text,
      status: 'done',
      usage,
      parts: { ...msg.parts, model: result.model || active.model, toolCalls: toolCalls.length ? toolCalls : undefined, reasoning: result.reasoning, raw: result.raw, notice: result.notice, contextStats: saver.record(stats, result.usage) },
    });
    ctx.chat.emitMessage(thread, updated, 'message.updated');
    if (result.text) finalText = result.text;
    if (guard.stopped) {
      // The last step after a loop stop: whatever tools it still asks for are not run.
      for (const call of toolCalls) skipTool(ctx, run, agent, thread, updated.id, call, skippedText(guard.stopped));
      break;
    }
    if (!toolCalls.length || result.stop === 'refusal') {
      // Steering (agent/queue.ts): the owner added a message to this turn while it ran; take it in before finishing.
      if (result.stop !== 'refusal' && hasPendingSteer(ctx, thread.id, run.id, updated.seq)) continue;
      // Nothing came back in the whole turn (no text, no tool call): it failed, it is not "klaar". Said on the answer
      // itself. A turn that did its work and ends without closing words is done (a routine with nothing new is quiet).
      if (result.stop !== 'refusal' && !result.text?.trim() && !finalText.trim() && !acted) return emptyAnswer(ctx, thread, updated, !!result.reasoning);
      break;
    }
    acted = true;
    for (const call of toolCalls) {
      // Stopped: the calls that never started are closed with a result that says so. A call left "pending" without
      // a result kept spinning in the chat for ever (the words are the ones history.ts gives the model for it).
      if (signal.aborted) {
        skipTool(ctx, run, agent, thread, updated.id, call, 'Onderbroken: deze actie is niet (volledig) uitgevoerd.');
        continue;
      }
      const label = call.summary ? `${toolLabel(call, false)}: ${call.summary}` : toolLabel(call, false);
      if (guard.before(call.name, call.args, label)) {
        skipTool(ctx, run, agent, thread, updated.id, call, skippedText(guard.stopped!));
        continue;
      }
      const out = await runTool(ctx, run, agent, thread, updated.id, call, tools, signal, saver.demand);
      guard.after(call.name, call.args, label, out.text || '', !!out.isError);
    }
    if (!signal.aborted && (guard.stopped || guard.endStep())) reportLoopStop(ctx, run, agent, thread, guard.stopped!);
  }
  if (turn >= maxTurns && !guard.stopped) ctx.chat.addEvent(thread, maxTurns === 1 ? `${agent.name} heeft het maximum van 1 stap bereikt en is gestopt. Stuur een bericht om verder te gaan.` : `${agent.name} heeft het maximum van ${maxTurns} stappen bereikt en is gestopt. Stuur een bericht om verder te gaan.`, { kind: 'max_turns' });
  await afterRun(ctx, agent, thread, run, finalText);
  return null;
}
