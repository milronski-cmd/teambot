import type { Agent, Ctx, Run, Thread, ToolDef, ToolOutput } from '../core/types.js';
import { redact } from '../core/secrets.js';
import { callRisk } from './broker.js';
import { passGate } from './gate.js';
import { ownerOnlyText, sharedRunOf } from '../agent/shared.js';
import { checkArgs } from './schema.js';
import { fillWords, isWords, mapOwnWords, type Words } from '../../shared/i18n-core.js';

/**
 * One call of a TeamBot tool, for a model over an API key, a local model and a CLI engine that uses TeamBot's tools
 * (the TeamBot MCP server) alike: the arguments are checked against the tool's schema, the call is written down as a
 * step for the permission gate (tools/gate.ts decides, asks and reviews), and when the gate lets it through the tool
 * runs. Refused = the tool never runs.
 */

/** Full JSON-schema check of tool arguments, after lenient coercion ("5" → 5): tools/schema.ts. */
export { checkArgs, validateArgs } from './schema.js';

/**
 * A call's line, from the tool's `summarize`: `summary` in Dutch (what the bot, the log and the approval card read) and,
 * when the tool gives TeamBot's words with values (`words(…)`, shared/i18n-core.ts), those as `words`: the chat shows
 * them in the owner's language and the values (a name, a path, what the bot wrote) as written. Secrets are out of both.
 */
export function stepSummary(t: ToolDef, args: any, agent?: Agent): { summary: string; words?: Words } {
  try {
    const s = t.summarize ? t.summarize(args ?? {}, agent ? { agent } : undefined) : `${t.name}(${JSON.stringify(args ?? {}).slice(0, 300)})`;
    if (!isWords(s)) return { summary: redact(String(s ?? '')) };
    const w = mapOwnWords(s, redact);
    return { summary: redact(fillWords(w)), words: w };
  } catch {
    return { summary: t.name };
  }
}

/** The Dutch line of a call (stepSummary). */
export const safeSummary = (t: ToolDef, args: any, agent?: Agent): string => stepSummary(t, args, agent).summary;

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
  if (!out && tool) {
    const who = { agent, thread, userId: thread.user_id };
    const hook = <T>(fn: () => T, otherwise: T): T => {
      try {
        return fn();
      } catch {
        return otherwise;
      }
    };
    // Per-call risk (e.g. channel_send to the owner himself vs. to a customer); the gate still decides.
    const risk = callRisk(tool, args, who);
    auditRisk = risk;
    const g = await passGate(
      { ctx, agent, thread, run, userId: thread.user_id, signal },
      {
        name: tool.name,
        risk,
        impact: tool.impact,
        internal: !!tool.internal || hook(() => tool.internalFor?.(args ?? {}) === true, false),
        group: tool.group,
        args,
        input: args,
        summary: safeSummary(tool, args, agent),
        // A call that can never succeed is refused before any approval card (asking would only waste the owner's time).
        refusal: hook(() => tool.refuse?.(args ?? {}, who) ?? null, null),
        // The terminal part runs its `command` on this computer: the gate reads it like a command of a CLI engine.
        ...(tool.group === 'shell' && typeof args?.command === 'string' ? { command: args.command, cwd: typeof args.cwd === 'string' && args.cwd ? args.cwd : undefined } : {}),
      },
      { onWait: (waiting) => i.onState?.(waiting ? 'waiting' : 'running') },
    );
    asked = g.asked;
    decidedBy = g.by;
    approved = g.allow && g.asked;
    if (!g.allow) {
      out = { text: g.reason, isError: true };
      // The tool's own "this can never succeed" is an error of the call, not a refusal of permission.
      denied = !g.blocked;
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
        // Progress of the chain of work between bots this run belongs to (modules/rooms/progress.ts; never throws).
        if (out && !out.isError) ctx.services.rooms?.toolDone?.(run, tool, risk);
      } catch (e: any) {
        out = { text: `Fout: ${e?.message || e}`, isError: true };
      }
    }
  }
  const final = out!.text ? { ...out!, text: scrub(out!.text) } : out!;
  ctx.audit(thread.user_id, 'tool.call', { tool: i.name, summary: tool ? safeSummary(tool, args) : i.name, error: !!final.isError, denied, risk: auditRisk, asked: asked || undefined, approved: approved || undefined, by: decidedBy }, agent.id);
  return { out: final, denied, tool, approved };
}
