import type { Agent, Ctx, Run, Thread, ToolDef, ToolOutput } from '../core/types.js';
import { redact } from '../core/secrets.js';
import { autoReview } from '../agent/autoreview.js';
import { callRisk } from './broker.js';
import { ownerOnlyText, sharedRunOf } from '../agent/shared.js';
import { checkArgs } from './schema.js';

/**
 * One tool call through TeamBot's permission gate. Shared by the API-agent loop (runner) and the TeamBot MCP
 * server for CLI agents, so both get exactly the same checks: argument validation, the Broker decision for the
 * bot's access mode and tool policy, Auto Review in auto mode, and a human approval when needed. Deny = the
 * tool never runs.
 */

/** Full JSON-schema check of tool arguments, after lenient coercion ("5" → 5): tools/schema.ts. */
export { checkArgs, validateArgs } from './schema.js';

/** The text of the owner's own rule (module botrules) behind a refusal or a question, or null. */
export function ownRule(ctx: Ctx, agent: Agent, call: Pick<ToolDef, 'name' | 'risk'> & { impact?: ToolDef['impact']; internal?: boolean }, args: any, decision: 'ask' | 'deny'): string | null {
  try {
    const r = ctx.services?.botRules?.reason?.(agent, call, args, decision);
    return r?.text ? String(r.text).replace(/\s+/g, ' ').slice(0, 300) : null;
  } catch {
    return null;
  }
}

export function safeSummary(t: ToolDef, args: any, agent?: Agent): string {
  try {
    return redact(t.summarize ? t.summarize(args ?? {}, agent ? { agent } : undefined) : `${t.name}(${JSON.stringify(args ?? {}).slice(0, 300)})`);
  } catch {
    return t.name;
  }
}

export interface ExecuteToolInput {
  ctx: Ctx;
  agent: Agent;
  thread: Thread;
  run: Run;
  /** The tools this bot may use in this thread (from ToolRegistry.forAgent). */
  tools: ToolDef[];
  name: string;
  args: any;
  callId: string;
  signal: AbortSignal;
  /** 'waiting' while a human decides, 'running' again afterwards. */
  onState?(state: 'waiting' | 'running'): void;
  progress?(text: string): void;
}

export interface ExecuteToolResult {
  out: ToolOutput;
  denied: boolean;
  tool?: ToolDef;
  /** A human approved this call. */
  approved?: boolean;
}

export async function executeTool(i: ExecuteToolInput): Promise<ExecuteToolResult> {
  const { ctx, agent, thread, run, signal } = i;
  // Values of the owner's "Sleutels voor scripts" (module script-keys) never reach the model, the transcript or the live
  // output, whichever tool shows them (a script that prints one, a file it wrote that is read back).
  const scrub = (s: string) => (typeof ctx.services.scriptKeys?.scrub === 'function' && s ? String(ctx.services.scriptKeys.scrub(agent.user_id, s)) : s);
  const tool = i.tools.find((t) => t.name === i.name);
  let out: ToolOutput | null = null;
  let denied = false;
  let approved = false;
  // For the log: did a human decide (and who), or did the access mode allow/deny it on its own.
  let asked = false;
  let decidedBy: string | undefined;
  let auditRisk: string | undefined;
  // The arguments the tool runs with: the model's, after coercion along the schema ("5" → 5).
  let args = i.args;
  if (i.args && typeof i.args === 'object' && typeof i.args.__invalid_call === 'string') {
    // A tool call the model wrote as text that could not be read for sure (providers/toolcall-text.ts): nothing runs,
    // the model reads what was wrong and how to call it properly.
    out = { text: i.args.__invalid_call, isError: true };
  } else if (!tool && sharedRunOf(agent)) {
    // A shared bot in a member's conversation: the owner's tools do not exist here; say so in plain words.
    out = { text: ownerOnlyText(agent), isError: true };
    denied = true;
  } else if (!tool) out = { text: `Onbekende tool: ${i.name}. Beschikbaar: ${i.tools.map((t) => t.name).join(', ')}`, isError: true };
  else if (i.args && typeof i.args === 'object' && '__invalid_json' in i.args) out = { text: 'INVALID_JSON: de tool-argumenten waren geen geldige JSON. Probeer het opnieuw met geldige JSON.', isError: true };
  else {
    const v = checkArgs(tool.parameters, i.args);
    if (v.error) out = { text: `${v.error} Roep ${tool.name} opnieuw aan met argumenten die bij het schema passen.`, isError: true };
    else args = v.args;
  }
  if (!out && tool?.refuse) {
    // A call that can never succeed is refused before any approval card (asking would only waste the owner's time).
    let why: string | null = null;
    try {
      why = tool.refuse(args ?? {}, { agent, thread, userId: thread.user_id });
    } catch {
      why = null;
    }
    if (why) out = { text: why, isError: true };
  }
  if (!out && tool) {
    // Per-call risk (e.g. channel_send to the owner himself vs. to a customer); the broker still decides.
    const risk = callRisk(tool, args, { agent, thread, userId: thread.user_id });
    auditRisk = risk;
    let internal = !!tool.internal;
    if (!internal && tool.internalFor) {
      try {
        internal = tool.internalFor(args ?? {}) === true;
      } catch {
        internal = false;
      }
    }
    const call = { name: tool.name, risk, impact: tool.impact, internal };
    let decision = ctx.broker.decide(agent, call, args);
    // The owner's own rule that made this ask or be refused (module botrules), for the card and the bot.
    const rule = decision !== 'allow' ? ownRule(ctx, agent, call, args, decision) : null;
    let reviewNote = rule && decision === 'ask' ? `Jouw regel: “${rule}”\n` : '';
    // Rules TeamBot cannot pin down in code: Auto Review checks every change against them, also outside auto mode.
    const reviewRules: string[] = risk !== 'read' && typeof ctx.services?.botRules?.reviewTexts === 'function' ? ctx.services.botRules.reviewTexts(agent) : [];
    if (decision === 'allow' && (risk === 'write' || risk === 'exec' || risk === 'danger') && (agent.settings?.autoReview || reviewRules.length)) {
      const v = await autoReview(ctx, agent, thread, run, tool, args, reviewRules);
      if (v.verdict === 'ask') {
        decision = 'ask';
        reviewNote = `Automatische controle: ${v.reason}\n`;
      }
    }
    if (decision === 'deny') {
      out = { text: rule ? `Geweigerd door een regel van je eigenaar: “${rule}”. Doe dit niet; vraag je eigenaar als het echt nodig is.` : `Geweigerd: ${agent.name} heeft in modus "${agent.access_mode}" geen toestemming voor ${tool.name}.`, isError: true };
      denied = true;
    } else if (decision === 'ask') {
      i.onState?.('waiting');
      asked = true;
      try {
        const r = await ctx.broker.request({ userId: thread.user_id, agent, thread, run, kind: 'tool', tool: tool.name, input: args, summary: reviewNote + safeSummary(tool, args, agent), risk, signal });
        decidedBy = r.by;
        if (!r.approved) {
          out = { text: 'De gebruiker heeft deze actie geweigerd. Vraag eventueel wat je anders moet doen.', isError: true };
          denied = true;
        } else approved = true;
      } catch {
        out = { text: 'Gestopt voordat er toestemming was.', isError: true };
        denied = true;
      }
      i.onState?.('running');
    }
    if (!out) {
      try {
        const r = await tool.run(args ?? {}, {
          ctx,
          agent,
          thread,
          run,
          userId: thread.user_id,
          signal,
          toolCallId: i.callId,
          approved,
          progress: (text) => i.progress?.(redact(scrub(text))),
        });
        out = typeof r === 'string' ? { text: r } : r;
      } catch (e: any) {
        out = { text: `Fout: ${e?.message || e}`, isError: true };
      }
    }
  }
  const final = out!.text ? { ...out!, text: scrub(out!.text) } : out!;
  ctx.audit(thread.user_id, 'tool.call', { tool: i.name, summary: tool ? safeSummary(tool, args) : i.name, error: !!final.isError, denied, risk: auditRisk, asked: asked || undefined, approved: approved || undefined, by: decidedBy }, agent.id);
  return { out: final, denied, tool, approved };
}
