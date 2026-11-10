import crypto from 'node:crypto';
import type { ActivityItem, Agent, Ctx, Run, Thread } from '../core/types.js';

/**
 * Loop guard: a bot that repeats itself without getting anywhere stops by itself, says what it tried and asks the
 * owner for help. On by default, per bot adjustable (Bot › Werk dat af is), always bounded.
 *
 * API engines (tool loop in TeamBot's runner):
 *  - the same tool call with the same arguments a third time (`repeat`), after the earlier ones gave the same result,
 *    is not run: the bot stops (a call whose result changed, such as polling a status, is progress);
 *  - `idle` steps in a row in which no tool call produced anything new (same calls, same results) stop the bot too.
 * CLI engines (their own loop): the same step `repeat` times in a row (same kind, title and detail) stops the run.
 */

export interface LoopLimits {
  repeat: number;
  idle: number;
}

export const LOOP_DEFAULTS: LoopLimits = { repeat: 3, idle: 6 };

const clamp = (v: any, lo: number, hi: number, d: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : d;
};

/** The bot's limits (settings.quality.loopGuard), or null when the owner turned the guard off for this bot. */
export function loopLimits(agent: Agent): LoopLimits | null {
  const g = agent.settings?.quality?.loopGuard;
  if (g === false || (g && typeof g === 'object' && g.on === false)) return null;
  return { repeat: clamp(g?.repeat, 2, 10, LOOP_DEFAULTS.repeat), idle: clamp(g?.idle, 3, 30, LOOP_DEFAULTS.idle) };
}

export interface LoopStop {
  kind: 'repeat' | 'idle';
  /** The step it kept doing, in words. */
  step: string;
  /** What happened, in words (for the chat and a delegation's "niet gelukt"). */
  text: string;
  /** The different steps it tried in this turn, in words. */
  tried: string[];
}

function stable(v: any): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
    .join(',')}}`;
}

const hashOf = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

export class LoopGuard {
  private calls = new Map<string, { n: number; out: string }>();
  private seen = new Set<string>();
  private idleSteps = 0;
  private progressed = false;
  private triedSteps: string[] = [];
  stopped: LoopStop | null = null;

  constructor(private limits: LoopLimits | null) {}

  private sig(name: string, args: any) {
    return hashOf(`${name}\u0000${stable(args)}`);
  }

  private stop(kind: LoopStop['kind'], step: string, text: string): LoopStop {
    this.stopped = { kind, step, text, tried: this.triedSteps.slice(-8) };
    return this.stopped;
  }

  /** Before a call: a stop when this exact call already ran `repeat - 1` times with the same result. */
  before(name: string, args: any, label: string): LoopStop | null {
    if (!this.limits || this.stopped) return this.stopped;
    const c = this.calls.get(this.sig(name, args));
    if (c && c.n >= this.limits.repeat - 1) return this.stop('repeat', label, `${this.limits.repeat}× dezelfde stap (${label}) met hetzelfde resultaat`);
    return null;
  }

  /** After a call: remember its result (same call + same result again = no progress). */
  after(name: string, args: any, label: string, out: string, isError: boolean) {
    if (!this.limits) return;
    const sig = this.sig(name, args);
    const h = hashOf(`${isError ? 'E' : 'O'}${String(out || '').slice(0, 20_000)}`);
    const c = this.calls.get(sig);
    if (c && c.out === h) c.n++;
    else this.calls.set(sig, { n: 1, out: h });
    if (!this.seen.has(`${sig}:${h}`)) {
      this.seen.add(`${sig}:${h}`);
      this.progressed = true;
    }
    if (label && !this.triedSteps.includes(label)) this.triedSteps.push(label);
  }

  /** After a step with tool calls: a stop after `idle` such steps in a row that produced nothing new. */
  endStep(lastLabel = ''): LoopStop | null {
    if (!this.limits || this.stopped) return this.stopped;
    this.idleSteps = this.progressed ? 0 : this.idleSteps + 1;
    this.progressed = false;
    if (this.idleSteps >= this.limits.idle) return this.stop('idle', lastLabel || this.triedSteps.at(-1) || 'dezelfde stappen', `${this.limits.idle} stappen achter elkaar zonder nieuwe uitkomst`);
    return null;
  }
}

/**
 * CLI engines: the same step (kind, title, detail) `repeat` times in a row. A step is judged by what it says now: CLI
 * engines retitle a step when its result is in (the same item sent again), and OpenCode's code mode starts every step
 * as the same bare "Wil code uitvoeren" (practice test 0.4.4: a lookup, a task and a delegation in a row were stopped
 * as one step done three times). A step that is still waiting (`pending`) at the end does not count yet.
 */
export class CliLoopWatch {
  private steps: ActivityItem[] = [];
  private items = new WeakSet<object>();
  stopped: LoopStop | null = null;

  constructor(private limits: LoopLimits | null) {}

  add(item: ActivityItem): LoopStop | null {
    if (!this.limits || this.stopped || !item) return this.stopped;
    if (!this.items.has(item)) {
      this.items.add(item);
      if (['session', 'cli_session', 'settings', 'mode', 'question'].includes(item.kind)) return null;
      this.steps.push(item);
      if (this.steps.length > 60) this.steps.shift();
    } else if (!this.steps.includes(item)) return null;
    const label = (x: ActivityItem) => `${x.title}${x.detail ? `: ${String(x.detail).slice(0, 120)}` : ''}`;
    const sig = (x: ActivityItem) => hashOf(`${x.kind}\u0000${x.title}\u0000${x.detail || ''}`);
    let end = this.steps.length;
    while (end > 0 && this.steps[end - 1].pending) end--;
    if (!end) return null;
    const last = sig(this.steps[end - 1]);
    let run = 0;
    for (let i = end - 1; i >= 0 && !this.steps[i].pending && sig(this.steps[i]) === last; i--) run++;
    if (run < this.limits.repeat) return null;
    const step = label(this.steps[end - 1]);
    const tried = [...new Set(this.steps.slice(0, end).filter((x) => !x.pending).map(label))].slice(-8);
    this.stopped = { kind: 'repeat', step, text: `${this.limits.repeat}× achter elkaar dezelfde stap (${step})`, tried };
    return this.stopped;
  }
}

/** The tool result for a call the guard did not run (the model reads it in its last step). */
export function skippedText(stop: LoopStop): string {
  return `Niet uitgevoerd: je deed deze stap al eerder met precies hetzelfde resultaat (${stop.text}). Er komt geen vooruitgang. Stop nu en roep geen tools meer aan. Schrijf de eigenaar kort wat je probeerde, waar je vastloopt en wat je van hem nodig hebt.`;
}

/** Added to the system prompt for the bot's last step after a stop: no more tools, ask for help. */
export function wrapUpNote(stop: LoopStop): string {
  return `## Gestopt: je zit in een lus\nJe bent gestopt omdat je steeds hetzelfde deed zonder vooruitgang (${stop.text}). Roep geen tools meer aan. Schrijf de eigenaar in een paar zinnen wat je probeerde, waar je vastloopt en wat je van hem nodig hebt om verder te kunnen. Zeg niet dat het gelukt is.`;
}

/** Say it in the chat (an event card with what it tried), tell the owner, and mark the run. */
export function reportLoopStop(ctx: Ctx, run: Run, agent: Agent, thread: Thread, stop: LoopStop) {
  const text = stop.kind === 'repeat' ? `${agent.name} is gestopt: ${stop.text}, zonder vooruitgang. Help ${agent.name} verder of geef een andere aanpak.` : `${agent.name} is gestopt: ${stop.text}. Help ${agent.name} verder of geef een andere aanpak.`;
  ctx.chat.addEvent(thread, text, { kind: 'loop_stop', loop: { kind: stop.kind, step: stop.step, tried: stop.tried, agentId: agent.id } } as any);
  const cur = ctx.store.run(run.id);
  if (cur) ctx.store.updateRun(run.id, { meta: { ...(cur.meta || {}), loopStop: { kind: stop.kind, text: stop.text, step: stop.step } } });
  ctx.events.emit(run.user_id, 'notification', { title: `${agent.name} zit vast en vraagt om hulp`, body: stop.text, link: `#/t/${thread.id}`, kind: 'agent' });
  ctx.audit(run.user_id, 'agent.loop_stop', { kind: stop.kind, step: stop.step.slice(0, 200) }, agent.id);
}
