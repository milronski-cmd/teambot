/**
 * A run from start to end: which engine answers, and what happens when it cannot (its usage limit, logged out, an
 * outage, a crash): switch to a reserve, wait for the reset, pause important work, or stop and say why.
 *
 * The parts, each in its own file:
 *  - agent/prompt.ts      what the bot reads (system prompt, turn context, the prompt for a CLI engine)
 *  - agent/chat-loop.ts   a turn on an API engine (model call → tools → model call …)
 *  - agent/cli-loop.ts    a turn on a CLI engine (it runs its own loop)
 *  - agent/engines.ts     the engines of a run, in order, and which are at their limit
 *  - agent/retries.ts     trying again at the reset, pausing and resuming important work
 *  - agent/attempts.ts    what stays in the chat of an attempt that failed
 *  - agent/budget.ts      the daily budget and the usage log
 *  - agent/fallback.ts    the rules (pure functions): kinds of failures, levels, privacy, times
 */
import type { Agent, Ctx, Message, Run, Thread } from '../core/types.js';
import { freeAlternatives } from './alternatives.js';
import { prepareAttachments } from './attachments.js';
import { dropSessionOnlySteps, hideAttempt } from './attempts.js';
import { chatLoop } from './chat-loop.js';
import { cliLoop } from './cli-loop.js';
import { engineName, Engines, listNames, type Active, type Chain } from './engines.js';
import { classifyEngineError, clockTime, DEFAULT_LIMIT_WAIT_MS, failureText, LEVEL_TEXT, limitPolicy, PRIVACY_LABEL, privateSafe, resetTimeFrom, type WorkFlags } from './fallback.js';
import { systemPrompt, turnContext, userTz } from './prompt.js';
import { Retries } from './retries.js';
import { agentForThread } from './shared.js';

export { PLAIN_TOOLS_PROMPT } from './prompt.js';
export { preparingText } from './chat-loop.js';
export { validateArgs } from '../tools/execute.js';

const ACCESS_RANK: Record<string, number> = { chat: 0, readonly: 1, ask: 2, auto: 3, full: 4 };

/**
 * Per-run overrides (run.meta.override, e.g. set by routines): may switch engine/model and
 * only ever NARROW permissions (access mode, tool groups, max turns, denied tools).
 */
export function applyRunOverride(agent: Agent, o: any): Agent {
  if (!o || typeof o !== 'object') return agent;
  const a: Agent = { ...agent, settings: { ...agent.settings }, tool_policy: { ...agent.tool_policy } };
  if (typeof o.provider_id === 'string' && o.provider_id) {
    a.provider_id = o.provider_id;
    a.model = typeof o.model === 'string' ? o.model : '';
  } else if (typeof o.model === 'string' && o.model) a.model = o.model;
  if (o.access_mode in ACCESS_RANK && ACCESS_RANK[o.access_mode] < ACCESS_RANK[a.access_mode]) a.access_mode = o.access_mode;
  if (Array.isArray(o.tool_groups)) a.tool_groups = a.tool_groups.filter((g) => o.tool_groups.includes(g));
  if (Number(o.max_turns) > 0) a.settings.maxTurns = Math.min(Number(o.max_turns), Number(agent.settings?.maxTurns) || 40);
  if (Array.isArray(o.deny_tools)) for (const t of o.deny_tools) if (typeof t === 'string') a.tool_policy[t] = 'deny';
  return a;
}

export class Runner {
  private engines: Engines;
  private retries: Retries;
  constructor(private getCtx: () => Ctx) {
    this.engines = new Engines(getCtx);
    this.retries = new Retries(getCtx, this.engines);
  }

  /** Engines at their usage limit until their reset (the usage page reads it): see Engines.limited. */
  get limited() {
    return this.engines.limited;
  }
  systemPrompt(agent: Agent, thread: Thread): Promise<string> {
    return systemPrompt(this.getCtx(), agent, thread);
  }
  turnContext(agent: Agent, thread: Thread, input: Message | null): Promise<string> {
    return turnContext(this.getCtx(), agent, thread, input);
  }
  /** Stop a scheduled "probeert het rond … opnieuw" (the owner chose another engine for that message). */
  cancelLimitRetry(runId: string) {
    this.retries.cancelLimitRetry(runId);
  }
  armRetry(runId: string, at: number) {
    this.retries.armRetry(runId, at);
  }
  /** After a restart: re-arm limit retries that were still waiting (and paused important work). */
  resumeLimitRetries() {
    this.retries.resumeLimitRetries();
  }
  stopRetries() {
    this.retries.stopRetries();
  }

  /** Entry point used by the RunManager. */
  async execute(run: Run, signal: AbortSignal) {
    const ctx = this.getCtx();
    const base = ctx.store.agent(run.agent_id);
    const thread = ctx.store.thread(run.thread_id);
    if (!base || !thread) throw new Error('Bot of gesprek bestaat niet meer');
    // A shared bot in a member's conversation runs as its narrowed copy for that member (agent/shared.ts).
    const agent = agentForThread(ctx, applyRunOverride(base, run.meta?.override), thread);
    // (the daily budget is checked before every model call, on the engine that makes it: chat-loop.ts / cli-loop.ts)
    const input = ctx.store.message(run.input_message_id);
    if (input && (input.role === 'user' || input.role === 'system')) {
      const multi = thread.kind === 'room' || thread.kind === 'channel' || !!thread.room_id;
      if (multi) {
        // Group threads: several bots answer the same message, each with its own memory/context (frozen per bot).
        const byAgent = input.parts?.contextByAgent || {};
        if (byAgent[agent.id] === undefined) {
          const c = await turnContext(ctx, agent, thread, input);
          const fresh = ctx.store.message(input.id)!;
          ctx.store.updateMessage(input.id, { parts: { ...fresh.parts, contextByAgent: { ...(fresh.parts?.contextByAgent || {}), [agent.id]: c } } });
        }
      } else if (input.parts?.context === undefined) {
        const c = await turnContext(ctx, agent, thread, input);
        ctx.store.updateMessage(input.id, { parts: { ...input.parts, context: c } });
      }
    }
    // A zip is unpacked and audio written out before the bot reads the message (agent/attachments.ts).
    await prepareAttachments(ctx, agent, thread.user_id, input, signal);
    const system = await systemPrompt(ctx, agent, thread);
    const tz = userTz(ctx, thread.user_id);
    // What kind of work this is (important / private / weekly reserve, modules/engine-chain) decides which engines
    // of the chain it may use; the chain itself is the main engine, the bot's reserves, then the default chain.
    const flags = this.engines.workFlags(run, agent, thread);
    if (run.meta?.frugal === true) flags.frugal = true; // proactive work (modules/routines/duties)
    this.retries.resumedPause(run, thread, agent.id);
    const chain = this.engines.engineChain(agent, run.user_id, flags);
    const policy = limitPolicy(agent);
    const start = await this.startEngine(chain, thread, tz, policy, { run, agent, flags });
    if (!start) return;
    let active = start;
    this.engines.markEngine(run, thread, active, chain[0]);
    for (;;) {
      const out = active.adapter.runAgent ? await cliLoop(ctx, run, agent, thread, active, system, signal, active !== chain[0]) : await chatLoop(ctx, run, agent, thread, active, system, signal);
      if (!out) {
        this.engines.reportEngine(active, { ok: true });
        return;
      }
      const e = out.error;
      if (signal.aborted) throw e;
      const kind = classifyEngineError(e);
      if (kind === 'other') {
        if (out.messageId) dropSessionOnlySteps(ctx, thread, out.messageId);
        throw e;
      }
      const resetAt = kind === 'limit' ? resetTimeFrom(String(e?.message || e)) : null;
      if (kind === 'limit') this.engines.markLimited(active.cfg, run.user_id, { until: resetAt || Date.now() + DEFAULT_LIMIT_WAIT_MS, known: !!resetAt });
      this.engines.reportEngine(active, { ok: false, kind, resetAt, error: String(e?.message || e).slice(0, 300), cause: e });
      const why = failureText({ engine: engineName(active), provider: active.cfg.name, kind, resetAt, tz, error: String(e?.message || e) });
      // A task may have become important during this run (the bot set it to "Bezig"): look again before switching.
      if (!flags.important) flags.important = this.engines.workFlags(ctx.store.run(run.id) || run, agent, thread).important;
      let next: Active | null = null;
      if (!(kind === 'limit' && policy !== 'fallback')) {
        await this.engines.extendChain(chain, agent, run.user_id, flags);
        next = this.engines.nextEngine(chain, active, flags);
      }
      // Important work never goes below its minimum level: with nothing in it available it pauses until the reset and
      // then goes on by itself (a limit or an outage; a login or a missing program needs the owner, as before).
      if (!next && flags.important && policy !== 'stop' && (kind === 'limit' || kind === 'outage')) {
        if (kind === 'limit') ctx.services.usage?.limitHit?.(run.user_id, active.cfg.id, resetAt, String(e?.message || e), { link: `#/t/${thread.id}` });
        await this.retries.pauseWork(run, agent, thread, { why: failureText({ engine: engineName(active), provider: active.cfg.name, kind, resetAt: null, tz, error: String(e?.message || e) }), kind, chain, failed: active, resetAt, messageId: out.messageId, flags });
        return;
      }
      // No reserve takes over and the bot tries again by itself: when, in the same words in the chat and the notification.
      const retry = kind === 'limit' && !next && policy !== 'stop' ? this.retries.plannedRetry(run, resetAt) : null;
      // One notification per limit, pointing at this chat (the run that fails here does not add a second one).
      if (kind === 'limit') ctx.services.usage?.limitHit?.(run.user_id, active.cfg.id, resetAt, String(e?.message || e), { link: `#/t/${thread.id}`, retry: retry ? { at: retry, bot: agent.name } : undefined });
      if (next) {
        // The switch is said once, as an event. The failed attempt itself disappears when it has nothing to show,
        // and otherwise keeps what it wrote without "Gestopt" or an error under it (the reserve answers next).
        if (out.messageId) hideAttempt(ctx, thread, out.messageId);
        ctx.chat.addEvent(thread, `${why}. Overgeschakeld naar reserve: ${engineName(next)}.${this.engines.weeklySkipNote(chain, active, next, flags)}`, { kind: 'fallback' });
        ctx.audit(run.user_id, 'agent.fallback', { from: active.cfg.id, fromModel: active.model, to: next.cfg.id, toModel: next.model, reason: kind }, agent.id);
        active = next;
        this.engines.markEngine(run, thread, active, chain[0]);
        continue;
      }
      // A reserve the shared-provider policy refused is never a silent dead end: say which one and why.
      if (kind !== 'limit' || policy === 'fallback') {
        for (const s of chain.skipped) ctx.chat.addEvent(thread, s, { kind: 'fallback' });
        // Private work: the sources it did not go to, in one line.
        if (chain.privacy.length && flags.private) ctx.chat.addEvent(thread, `Niet overgeschakeld naar ${listNames(chain.privacy)}: dit is privéwerk (${flags.private.why}), en privéwerk gaat alleen naar een lokaal model of een bron die niets bewaart.`, { kind: 'fallback' });
        const below = flags.important ? this.engines.belowLevel(chain, active, flags) : null;
        if (below) ctx.chat.addEvent(thread, `Belangrijk werk gaat niet naar ${engineName(below)}: dat zit onder het minimumniveau (${LEVEL_TEXT[flags.minLevel]}).`, { kind: 'fallback' });
      }
      if (kind === 'limit' && policy !== 'stop') this.retries.scheduleLimitRetry(run, agent, thread, resetAt, why, tz, retry ?? undefined);
      // The failed answer keeps only what it really did: a lone "OpenCode-sessie gestart" is no step (C-06, also
      // without a reserve: no "1 stap" block above the error).
      if (out.messageId) dropSessionOnlySteps(ctx, thread, out.messageId);
      // No reserve took over: offer what the bot can switch to with one click (a local model, the owner's own
      // subscription), on the failed answer itself. Never a paid engine; for private work only a local model.
      if (kind === 'limit' && out.messageId) await this.offerAlternatives(agent, thread, out.messageId, chain.slice(0, chain.indexOf(active) + 1), !!flags.private);
      throw e;
    }
  }

  /**
   * Start on the main engine, unless it is still at its limit, the bot's choice at a limit is "switch to a reserve" and
   * a reserve is free (said in the chat). A bot set to "wait" or "stop" never runs on a reserve: it starts on the main
   * engine, which answers with its limit again, and then waits for the reset or stops — as the owner chose per bot.
   * Also: private work leaves a main engine it may not use; important work with nothing within its level pauses at
   * once (null: the run ended as paused); above the weekly reserve normal work starts on another engine.
   */
  private async startEngine(chain: Chain, thread: Thread, tz: string, policy: ReturnType<typeof limitPolicy>, w: { run: Run; agent: Agent; flags: WorkFlags }): Promise<Active | null> {
    const ctx = this.getCtx();
    const first = chain[0];
    const f = w.flags;
    // The run knows why it is important (a resumed run and the subtasks it delegates inherit it).
    if (f.important && !w.run.meta?.important) {
      const cur = ctx.store.run(w.run.id);
      if (cur) ctx.store.updateRun(cur.id, { meta: { ...(cur.meta || {}), important: f.important } });
    }
    // Private work never goes to a source that can train on it, and for a bot set to private only to a model on this
    // computer or a source that keeps nothing: the main engine included. Said in the chat, or refused when there is none.
    if (f.private && (f.private.mode === 'strict' ? !privateSafe(first.privacy || 'stores') : first.privacy === 'train')) {
      await this.engines.extendChain(chain, w.agent, w.run.user_id, f);
      const safe = chain.slice(1).find((x) => !this.engines.isLimited(x) && privateSafe(x.privacy || 'stores'));
      if (!safe)
        throw new Error(
          `Dit is privéwerk (${f.private.why}). Privéwerk gaat alleen naar een lokaal model of een bron die niets bewaart, en die is er nu niet: ${engineName(first)} ${PRIVACY_LABEL[first.privacy || 'stores']}. Koppel een lokaal model, bijvoorbeeld Ollama (Instellingen › AI-diensten)${f.private.mode === 'strict' ? `, of zet ${w.agent.name} niet meer op privé` : ''}.`,
        );
      ctx.chat.addEvent(thread, `Overgeschakeld naar ${engineName(safe)}, omdat dit privéwerk is (${f.private.why}): ${engineName(first)} ${PRIVACY_LABEL[first.privacy || 'stores']}, en privéwerk gaat alleen naar een lokaal model of een bron die niets bewaart.`, { kind: 'fallback' });
      return safe;
    }
    if (this.engines.isLimited(first)) {
      if (policy === 'fallback') {
        await this.engines.extendChain(chain, w.agent, w.run.user_id, f);
        const rest = chain.slice(1).filter((x) => !this.engines.isLimited(x) && this.engines.allowed(x, f, first));
        const free = rest.find((x) => !this.engines.weekly(x, f)) || rest[0];
        if (free) {
          const until = this.engines.limited.get(first.cfg.id)!.until;
          ctx.chat.addEvent(thread, `${engineName(first)} zit nog tot ongeveer ${clockTime(until, tz)} aan zijn gebruikslimiet; deze beurt draait op ${engineName(free)}. Daarna gaat de bot vanzelf terug.`, { kind: 'fallback' });
          return free;
        }
      }
      // Important work with nothing within its level: pause right away (no call to an engine that is still at its limit).
      if (f.important && policy !== 'stop') {
        const l = this.engines.limited.get(first.cfg.id)!;
        await this.retries.pauseWork(w.run, w.agent, thread, { why: `${engineName(first)} zit nog tot ongeveer ${clockTime(l.until, tz)} aan zijn gebruikslimiet`, kind: 'limit', chain, failed: first, resetAt: l.known ? l.until : null, flags: f });
        return null;
      }
      return first;
    }
    // Weekly reserve: above the owner's threshold of the Claude or Codex week, normal work already goes to another
    // engine of the chain, so the rest of the week stays for important work. Only when there is one to go to.
    const wk = policy === 'fallback' ? this.engines.weekly(first, f) : null;
    if (wk) {
      await this.engines.extendChain(chain, w.agent, w.run.user_id, f);
      const alt = chain.slice(1).find((x) => !this.engines.isLimited(x) && this.engines.allowed(x, f, first) && !this.engines.weekly(x, f));
      if (alt) {
        ctx.chat.addEvent(thread, `Overgeschakeld naar ${engineName(alt)}, omdat ${engineName(first)} al ${wk.percent}% van de weeklimiet heeft gebruikt (grens ${f.weeklyReserve}%); zo blijft er genoeg over voor belangrijk werk.`, { kind: 'fallback' });
        ctx.audit(w.run.user_id, 'agent.weekly_reserve', { from: first.cfg.id, to: alt.cfg.id, percent: wk.percent, threshold: f.weeklyReserve }, w.agent.id);
        return alt;
      }
    }
    return first;
  }

  /** The free alternatives for a bot whose engine hit its limit, on its failed answer (see agent/alternatives.ts). */
  private async offerAlternatives(agent: Agent, thread: Thread, messageId: string, tried: Active[], privateOnly = false) {
    const ctx = this.getCtx();
    try {
      const alts = (await freeAlternatives(ctx, agent, { exclude: tried.map((x) => x.cfg.id), limited: (id) => this.engines.isLimited({ cfg: { id } } as Active) })).filter((a) => !privateOnly || a.kind === 'local');
      const m = ctx.store.message(messageId);
      if (!m || !alts.length) return;
      ctx.chat.emitMessage(thread, ctx.store.updateMessage(m.id, { parts: { ...m.parts, switchTo: alts.map(({ provider_id, model, label, kind }) => ({ provider_id, model, label, kind })) } }), 'message.updated');
    } catch (e: any) {
      ctx.log.warn('[fallback] alternatives', e?.message);
    }
  }

}
