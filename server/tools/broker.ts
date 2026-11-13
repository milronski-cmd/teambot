import type { Agent, Ctx, Decision, Run, Thread, ToolDef, ToolImpact, ToolRisk } from '../core/types.js';
import { newId, now } from '../core/db.js';
import { redact } from '../core/secrets.js';

const RISKS = new Set<ToolRisk>(['read', 'write', 'exec', 'danger']);

/**
 * Risk of one tool call: `tool.riskFor(args)` when the tool has it (per-target rules the owner set), else the
 * static `tool.risk`. Every caller of `Broker.decide` for a concrete call (runner, MCP bridge) should use this.
 */
export function callRisk(tool: Pick<ToolDef, 'risk' | 'riskFor'>, args: any, t: { agent: Agent; thread: Thread; userId: string }): ToolRisk {
  if (!tool.riskFor) return tool.risk;
  try {
    const r = tool.riskFor(args ?? {}, t);
    if (!RISKS.has(r)) return tool.risk;
    // A pre-approved target may skip the human, never the access mode: an impactful tool is at least "write".
    return r === 'read' && tool.risk !== 'read' ? 'write' : r;
  } catch {
    return tool.risk;
  }
}

export interface ApprovalResult {
  approved: boolean;
  answer?: string;
  always?: boolean;
  by?: string;
  /** The owner decided this before a restart; the resumed run gets the decision once without asking again. */
  carried?: boolean;
}

/** How long a decision made after a restart is reused for the identical request of the resumed run. */
export const CARRY_OVER_MS = 15 * 60_000;

/** JSON with sorted keys and without undefined values: two equal inputs give the same text. */
export function canonicalJson(v: any): string {
  const norm = (x: any): any => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') {
      const out: Record<string, any> = {};
      for (const k of Object.keys(x).sort()) if (x[k] !== undefined) out[k] = norm(x[k]);
      return out;
    }
    return x;
  };
  try {
    return JSON.stringify(norm(JSON.parse(JSON.stringify(v ?? {}))));
  } catch {
    return String(v);
  }
}

/**
 * The single permission gate for every tool call (API agents, CLI agents via the
 * MCP bridge, routines and channels). Deny-by-default for impactful actions:
 *  - chat:     no tools
 *  - readonly: read tools only
 *  - ask:      read automatically, everything else asks the human — except team-internal tools (asking or giving
 *              work to the owner's own bots, the task board): those run like talking to a colleague, and the
 *              receiving bot keeps its own mode for whatever it then does
 *  - auto:     read/write/exec automatically; "danger" (send, publish, delete, buy) always asks
 *  - full:     "Volledige toegang" (owner's explicit opt-in): everything of the bot's own work runs without asking,
 *              also local danger (delete in the workspace, own desktop, sending to the owner himself). Sending or
 *              publishing to others still asks unless the owner allowed that too (settings.fullAccessExternal);
 *              payments always ask. Hard blocks (outside the workspace, password/payment fields, blocklisted
 *              commands, private URLs) stay in force: they live in the tools and the CLI gate, not here.
 * A per-agent tool policy can override (explicit user choice, audited). The owner's own rules (module botrules) come
 * last: they can make any level stricter, and "mag altijd" lifts only a question of the level "Vragen".
 */
export class Broker {
  private pending = new Map<string, (r: ApprovalResult) => void>();

  constructor(private getCtx: () => Ctx) {}

  decide(agent: Agent, tool: Pick<ToolDef, 'name' | 'risk'> & { impact?: ToolDef['impact']; internal?: boolean }, args?: any): Decision {
    const d = this.modeDecide(agent, tool, args);
    // The owner's own rules in plain words (module botrules): stricter anywhere, "mag altijd" only within the level.
    let rules: any;
    try {
      rules = this.getCtx()?.services?.botRules;
    } catch {
      rules = null;
    }
    if (d === 'deny' || typeof rules?.decide !== 'function') return d;
    try {
      return rules.decide(agent, tool, args, d);
    } catch {
      return d === 'allow' ? 'ask' : d; // fail-safe
    }
  }

  /** The decision of the access mode and the per-tool choices alone. */
  private modeDecide(agent: Agent, tool: Pick<ToolDef, 'name' | 'risk'> & { impact?: ToolDef['impact']; internal?: boolean }, args?: any): Decision {
    const mode = agent.access_mode;
    if (mode === 'chat') return 'deny';
    const override = agent.tool_policy?.[tool.name];
    if (override === 'deny') return 'deny';
    if (mode === 'full') {
      if (override === 'ask') return 'ask';
      if (tool.risk !== 'danger') return 'allow';
      const impact = impactOf(tool, args, agent);
      if (impact === 'payment') return 'ask';
      if (impact === 'local') return 'allow';
      return agent.settings?.fullAccessExternal === true ? 'allow' : 'ask';
    }
    if (mode === 'readonly') return tool.risk === 'read' || override === 'allow' ? (tool.risk === 'read' ? 'allow' : 'deny') : 'deny';
    // Impactful actions (send, publish, delete, pay) always ask a human — a per-tool 'allow' cannot switch that off.
    if (tool.risk === 'danger') return 'ask';
    if (override) return override;
    if (tool.internal) return 'allow';
    switch (tool.risk) {
      case 'read':
        return 'allow';
      case 'write':
      case 'exec':
        return mode === 'auto' ? 'allow' : 'ask';
      default:
        return 'ask';
    }
  }

  async request(o: {
    userId: string;
    agent: Agent | null;
    thread: Thread | null;
    run: Run | null;
    kind: 'tool' | 'question';
    tool: string;
    input: any;
    summary: string;
    risk: string;
    options?: string[];
    signal?: AbortSignal;
  }): Promise<ApprovalResult> {
    const ctx = this.getCtx();
    // The owner already decided this exact request after a restart (the run was interrupted while it waited).
    const carried = this.carryOver(o);
    if (carried) return carried;
    const id = newId('apr_');
    const row = {
      id,
      user_id: o.userId,
      agent_id: o.agent?.id ?? null,
      run_id: o.run?.id ?? null,
      thread_id: o.thread?.id ?? null,
      kind: o.kind,
      tool: o.tool,
      input: o.input ?? {},
      summary: redact(o.summary).slice(0, 2000),
      risk: o.risk,
      options: o.options ?? null,
      status: 'pending',
      created_at: now(),
    };
    ctx.store.insert('approvals', row);
    const view = this.view(ctx.store.get('approvals', id));
    ctx.events.emit(o.userId, 'approval.created', view);
    ctx.events.emit(o.userId, 'notification', {
      title: o.kind === 'question' ? `${o.agent?.name || 'Bot'} heeft een vraag` : `${o.agent?.name || 'Bot'} vraagt toestemming`,
      body: o.summary.slice(0, 200),
      link: o.thread ? `#/t/${o.thread.id}` : '#/inbox',
      kind: 'approval',
      approvalId: id,
    });
    if (o.run) {
      ctx.store.updateRun(o.run.id, { status: 'waiting' });
      ctx.events.emit(o.userId, 'run.updated', { ...ctx.store.run(o.run.id) });
    }
    try {
      return await new Promise<ApprovalResult>((resolve, reject) => {
        this.pending.set(id, resolve);
        if (o.signal) {
          if (o.signal.aborted) return reject(new Error('Geannuleerd'));
          o.signal.addEventListener('abort', () => {
            this.pending.delete(id);
            ctx.store.update('approvals', id, { status: 'expired', decided_at: now() });
            ctx.events.emit(o.userId, 'approval.updated', this.view(ctx.store.get('approvals', id)));
            reject(new Error('Geannuleerd'));
          });
        }
      });
    } finally {
      if (o.run && ctx.store.run(o.run.id)?.status === 'waiting') {
        ctx.store.updateRun(o.run.id, { status: 'running' });
        ctx.events.emit(o.userId, 'run.updated', { ...ctx.store.run(o.run.id) });
      }
    }
  }

  /**
   * A decision on an approval of an interrupted run, reused once when the resumed run asks for the same tool with
   * the identical input (canonical JSON) shortly after. Anything different asks normally.
   */
  private carryOver(o: { userId: string; agent: Agent | null; thread: Thread | null; kind: string; tool: string; input: any }): ApprovalResult | null {
    if (!o.agent || !o.thread) return null;
    const ctx = this.getCtx();
    const since = new Date(Date.now() - CARRY_OVER_MS).toISOString();
    const rows = ctx.store.all<any>(
      "SELECT * FROM approvals WHERE user_id = ? AND agent_id = ? AND thread_id = ? AND tool = ? AND kind = ? AND interrupted_at IS NOT NULL AND carried_at IS NULL AND status IN ('approved','denied') AND decided_at >= ? ORDER BY decided_at DESC LIMIT 5",
      o.userId,
      o.agent.id,
      o.thread.id,
      o.tool,
      o.kind,
      since,
    );
    const want = canonicalJson(o.input ?? {});
    for (const r of rows) {
      const a = ctx.store.decode<any>('approvals', r);
      if (canonicalJson(a.input ?? {}) !== want) continue;
      ctx.store.update('approvals', a.id, { carried_at: now() });
      const approved = a.status === 'approved';
      ctx.audit(o.userId, 'approval.carried_over', { tool: a.tool, summary: a.summary, approved }, o.agent.id);
      return { approved, answer: a.answer ?? undefined, by: a.decided_by || undefined, carried: true };
    }
    return null;
  }

  /** Called by the HTTP API when a human decides. */
  resolve(id: string, userId: string, decision: 'approve' | 'deny' | 'always', answer?: string) {
    const ctx = this.getCtx();
    const a = ctx.store.get<any>('approvals', id);
    if (!a || a.user_id !== userId) throw new Error('Onbekend verzoek');
    if (a.status !== 'pending') throw new Error('Dit verzoek is al afgehandeld');
    // An approval that survived a restart never grants "always" (its card does not offer it either).
    if (a.interrupted_at && decision === 'always') decision = 'approve';
    const approved = decision !== 'deny';
    ctx.store.update('approvals', id, { status: approved ? 'approved' : 'denied', answer: answer ?? null, decided_by: userId, decided_at: now() });
    if (decision === 'always' && a.agent_id && a.kind === 'tool' && a.risk !== 'danger') {
      const agent = ctx.store.agent(a.agent_id);
      if (agent && agent.user_id === userId) {
        ctx.store.updateAgent(agent.id, { tool_policy: { ...agent.tool_policy, [a.tool]: 'allow' } });
        ctx.audit(userId, 'policy.always_allow', { tool: a.tool }, agent.id);
      }
    }
    ctx.audit(userId, 'approval.' + (approved ? 'approved' : 'denied'), { id, tool: a.tool, summary: a.summary, ...(a.interrupted_at ? { afterRestart: true } : {}) }, a.agent_id);
    const view = this.view(ctx.store.get('approvals', id));
    ctx.events.emit(userId, 'approval.updated', view);
    const r = this.pending.get(id);
    this.pending.delete(id);
    if (r) r({ approved, answer, always: decision === 'always', by: userId });
    else if (a.interrupted_at) this.resumeAfterRestart(a, userId, approved, answer);
    return view;
  }

  /**
   * The owner decided an approval of a run that a crash/restart interrupted: continue that run's work in its thread
   * (like "Hervatten"), telling the bot what was decided. The identical request is then approved/denied once
   * without asking again (carryOver); a different request asks normally.
   */
  private resumeAfterRestart(a: any, userId: string, approved: boolean, answer?: string) {
    const ctx = this.getCtx();
    try {
      const t = a.thread_id ? ctx.store.thread(a.thread_id) : null;
      const agent = a.agent_id ? ctx.store.agent(a.agent_id) : null;
      if (!t || !agent) return;
      // Already working again (e.g. the owner clicked Hervatten): the decision is recorded, nothing is started twice.
      if (ctx.store.one("SELECT id FROM runs WHERE thread_id = ? AND agent_id = ? AND status IN ('queued','running','waiting') LIMIT 1", t.id, agent.id)) return;
      const owner = ctx.store.user(userId)?.name || 'De eigenaar';
      const what = String(a.summary || a.tool).replace(/\s+/g, ' ').slice(0, 400);
      let text: string;
      if (a.kind === 'question') {
        const ans = answer?.trim();
        text =
          approved && ans
            ? `Na de herstart beantwoordde ${owner} je vraag (“${what}”): ${ans.slice(0, 4000)}\nGa verder waar je gebleven was. Controleer eerst wat al gedaan is, zodat niets dubbel gebeurt.`
            : `Na de herstart sloeg ${owner} je vraag over (“${what}”). Ga verder zonder antwoord, of vraag het later opnieuw als het echt nodig is.`;
      } else if (approved) {
        text = `Na de herstart gaf ${owner} toestemming voor: ${what}\nGa verder waar je gebleven was en voer deze actie nu uit. Controleer eerst wat al gedaan is, zodat niets dubbel gebeurt.`;
      } else {
        text = `Na de herstart weigerde ${owner}: ${what}\nVoer deze actie niet uit. Ga verder zonder, of vraag wat ${owner} anders wil.`;
      }
      const sys = ctx.store.createMessage({ thread_id: t.id, role: 'system', author_type: 'system', author_name: 'TeamBot', content: text, parts: { resumedFrom: { approvalId: a.id, runId: a.run_id } } });
      ctx.chat.emitMessage(t, sys);
      ctx.chat.startAgent(t, agent.id, sys.id, 'resume', { resumedApproval: a.id });
    } catch (e) {
      ctx.log.error('[broker] resume after restart failed', e);
    }
  }

  /**
   * Startup after a crash or restart: nothing waits in-process any more. Approvals of a run that was busy (and is now
   * marked interrupted by RunManager.recover) stay open with `interrupted_at`, so they come back with the run and the
   * queue; deciding one resumes the run. Every other open approval expires. Returns how many were kept, per user.
   */
  expireStale(): Map<string, number> {
    const ctx = this.getCtx();
    const kept = new Map<string, number>();
    const ts = now();
    const rows = ctx.store.all<any>(
      "SELECT a.id, a.user_id, a.run_id, a.thread_id, a.agent_id, a.interrupted_at, r.status AS run_status FROM approvals a LEFT JOIN runs r ON r.id = a.run_id WHERE a.status = 'pending'",
    );
    for (const a of rows) {
      // Only the bot's latest turn in that thread can still be resumed.
      const latest =
        a.run_id && a.thread_id && a.agent_id
          ? ctx.store.one<{ id: string }>("SELECT id FROM runs WHERE thread_id = ? AND agent_id = ? AND status != 'queued' ORDER BY created_at DESC, rowid DESC LIMIT 1", a.thread_id, a.agent_id)
          : null;
      const keep = !!a.run_id && ['running', 'waiting', 'interrupted'].includes(a.run_status) && latest?.id === a.run_id;
      if (keep) {
        if (!a.interrupted_at) ctx.store.update('approvals', a.id, { interrupted_at: ts });
        kept.set(a.user_id, (kept.get(a.user_id) || 0) + 1);
      } else ctx.store.update('approvals', a.id, { status: 'expired', decided_at: ts });
    }
    return kept;
  }

  /**
   * A new turn of the same bot in the same thread started (the owner clicked Hervatten, sent a new message, or the
   * queue continued): an approval left over from before the restart can no longer resume anything, so it expires
   * (the bot asks again if it still needs it). Called by the run manager when a run starts.
   */
  supersedeInterrupted(threadId: string, agentId: string, runId: string): number {
    const ctx = this.getCtx();
    const rows = ctx.store.all<any>(
      "SELECT id, user_id FROM approvals WHERE status = 'pending' AND interrupted_at IS NOT NULL AND thread_id = ? AND agent_id = ? AND (run_id IS NULL OR run_id != ?)",
      threadId,
      agentId,
      runId,
    );
    if (!rows.length) return 0;
    for (const r of rows) {
      ctx.store.update('approvals', r.id, { status: 'expired', decided_at: now() });
      ctx.events.emit(r.user_id, 'approval.updated', this.view(ctx.store.get('approvals', r.id)));
    }
    const t = ctx.store.thread(threadId);
    const name = ctx.store.agent(agentId)?.name || 'De bot';
    if (t) ctx.chat.addEvent(t, `De open goedkeuring van vóór de herstart is vervallen: ${name} gaat verder met een nieuwe beurt en vraagt het opnieuw als het nog nodig is.`, { kind: 'approval_superseded', agentId });
    return rows.length;
  }

  /**
   * A run ended for good (done, error or cancelled) while it still had an open approval or question: nobody waits for
   * the answer any more, so the card expires and leaves "Wacht op jou" (approval.updated). Never for an interrupted
   * run: that approval stays open on purpose, deciding it resumes the work (expireStale / supersedeInterrupted).
   */
  expireForRun(runId: string): number {
    const ctx = this.getCtx();
    const run = ctx.store.run(runId);
    if (!run || !['done', 'error', 'cancelled'].includes(run.status)) return 0;
    const rows = ctx.store.all<any>("SELECT id, user_id FROM approvals WHERE status = 'pending' AND run_id = ?", runId);
    for (const r of rows) {
      this.pending.delete(r.id);
      ctx.store.update('approvals', r.id, { status: 'expired', decided_at: now() });
      ctx.events.emit(r.user_id, 'approval.updated', this.view(ctx.store.get('approvals', r.id)));
    }
    return rows.length;
  }

  view(a: any) {
    if (!a) return a;
    // A shared bot asking a member (agent/shared.ts): "always allow" would change someone else's bot, so the card
    // offers only this once.
    const agent = a.agent_id ? this.getCtx().store.agent(a.agent_id) : null;
    return { ...a, input: a.input, ...(agent && agent.user_id !== a.user_id ? { sharedBot: true } : {}) };
  }
}

/** Impact of a danger tool call (fail-safe: anything unknown counts as external). */
export function impactOf(tool: { impact?: ToolDef['impact'] }, args: any, agent: Agent): ToolImpact {
  try {
    const v = typeof tool.impact === 'function' ? tool.impact(args ?? {}, agent) : tool.impact;
    return v === 'local' || v === 'payment' ? v : 'external';
  } catch {
    return 'external';
  }
}
