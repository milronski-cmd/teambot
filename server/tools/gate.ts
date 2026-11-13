import type { Agent, Ctx, Run, Thread, ToolDef, ToolRisk } from '../core/types.js';
import { redact } from '../core/secrets.js';
import { autoReview } from '../agent/autoreview.js';
import { PARKED_TEXT } from './broker.js';
import { agentRoots, fullAccess, resolveInWorkspace, wholeComputer } from './builtin/files.js';
import { commandPaths, isHardline } from './builtin/command-risk.js';
import { assertPublicUrl } from './builtin/web.js';

/**
 * The one permission gate. Every step a bot wants to take passes here, whichever way it arrives: a tool call of a model
 * over an API key or a local model and TeamBot's own tools used by a CLI engine (tools/execute.ts), or a request of a
 * CLI engine for one of its own tools: the permission prompt of Claude Code, the approval of Codex, the permission
 * request of an ACP engine (modules/cli-agents/permissions.ts). Each way in only writes down what it got as a
 * `GateStep`; what is decided, in which order and in which words is here, once.
 *
 *  1. Chat only: nothing runs.
 *  2. Hard blocks, refused before anything is asked: what the tool itself says can never succeed (`refusal`), a
 *     command that wipes the disk, key and password files, TeamBot's own data and the folders the owner closed, a path
 *     the bot may not write, a web address it may not open.
 *  3. The access level, the owner's choice per tool and his own rules (Broker.decide with module botrules).
 *  4. A command that names a path outside the bot's folders asks (only a bot that is kept to its own folders has an
 *     "outside": with the whole computer nothing but the hard blocks is outside).
 *  5. The reviewer model (agent/autoreview.ts) reads the step first, and only then: when a rule of the owner that
 *     TeamBot cannot check in code names this kind of step (botrules/review.ts), or when the owner switched on the
 *     bot's own "Automatische controle" at the level "Automatisch". It costs one or two model calls.
 *  6. The card for the owner.
 */

export interface GateTurn {
  ctx: Ctx;
  agent: Agent;
  thread: Thread | null;
  run: Run | null;
  userId: string;
  signal: AbortSignal;
}

export interface GateStep {
  /** The name the owner's choices per tool and his rules know the step by; also on the card. */
  name: string;
  risk: ToolRisk;
  /** Who a step of risk "danger" reaches (default: others). */
  impact?: ToolDef['impact'];
  /** Team-internal work (ToolDef.internal). */
  internal?: boolean;
  /** The part of TeamBot the tool belongs to; a CLI engine's own tool has none. */
  group?: string;
  /** What the owner's rules read: the tool's arguments, or the folders, the website and the command of the step. */
  args: any;
  /** What the card and the reviewer show. */
  input: any;
  /** One line for the card. */
  summary: string;
  /** The tool's own reason why this call can never succeed (ToolDef.refuse). */
  refusal?: string | null;
  /** A shell command on this computer, and the folder it runs in. */
  command?: string;
  cwd?: string;
  /** Files and folders the step reads or (risk write or danger) writes. */
  paths?: string[];
  /** A web address the step opens itself. */
  url?: string;
}

/** What the gate decides before any model call or card. */
type GateVerdict =
  | { decision: 'run' }
  | { decision: 'refuse'; reason: string; blocked: boolean }
  | { decision: 'ask'; note: string; risk: ToolRisk }
  | { decision: 'review'; rules: string[]; own: boolean; strong: boolean };

export interface GateOutcome {
  allow: boolean;
  /** The owner decided on a card. */
  asked: boolean;
  /** Who decided on the card. */
  by?: string;
  /** Why not, in words for the bot. */
  reason: string;
  /** A hard block or the tool's own refusal (not a matter of permission). */
  blocked: boolean;
  /** The line of the card and the log. */
  summary: string;
}

const HARDLINE_FULL = 'Geweigerd door TeamBot: deze opdracht wist de hele schijf of je hele gebruikersmap. Dat doet TeamBot nooit; verwijder de mappen die je bedoelt.';
const HARDLINE = 'Geweigerd door TeamBot: deze opdracht staat op de vaste blokkeerlijst (systeembrede schade).';
const RISK_LABEL: Record<ToolRisk, string> = { read: 'lezen', write: 'schrijven', exec: 'uitvoeren', danger: 'actie met impact' };
const CUT = 1500;

type Call = Pick<ToolDef, 'name' | 'risk'> & { impact?: ToolDef['impact']; internal?: boolean; group?: string };

/** The text of the owner's own rule (module botrules) behind a refusal or a question, or null. */
function ownRule(ctx: Ctx, agent: Agent, call: Call, args: any, decision: 'ask' | 'deny'): string | null {
  try {
    const r = ctx.services?.botRules?.reason?.(agent, call, args, decision);
    return r?.text ? String(r.text).replace(/\s+/g, ' ').slice(0, 300) : null;
  } catch {
    return null;
  }
}

/** The owner's rules the reviewer must read for this step; `strong`: a check that fails asks instead of going on. */
function reviewRules(ctx: Ctx, agent: Agent, call: Call, args: any): { texts: string[]; strong: boolean } {
  try {
    const r = ctx.services?.botRules?.reviewFor?.(agent, call, args);
    return { texts: Array.isArray(r?.texts) ? r.texts : [], strong: !!r?.strong };
  } catch {
    return { texts: [], strong: false };
  }
}

/**
 * The decision for one step, with the line for the card. No model call and no card: `review` and `ask` say what
 * `passGate` does next.
 */
async function judgeStep(turn: Pick<GateTurn, 'ctx' | 'agent'>, step: GateStep): Promise<GateVerdict & { summary: string }> {
  const { ctx, agent } = turn;
  let summary = redact(step.summary || step.name).slice(0, CUT);
  const refuse = (reason: string, blocked = true) => ({ decision: 'refuse' as const, reason, blocked, summary });
  if (agent.access_mode === 'chat') return refuse(`Geweigerd door TeamBot: ${agent.name} staat in chatmodus (geen tools).`, false);
  if (step.refusal) return refuse(step.refusal);

  const full = fullAccess(agent);
  let outside: string[] = [];
  let cwd: string | undefined;
  try {
    if (step.cwd) cwd = resolveInWorkspace(agent, step.cwd);
    // Writes (and deletes) must land in a folder the bot may write; folders shared read-only stay readable.
    for (const p of step.paths || []) resolveInWorkspace(agent, p, { write: step.risk === 'write' || step.risk === 'danger' });
  } catch (e: any) {
    return refuse(`Geweigerd door TeamBot: ${e.message}`);
  }
  if (step.command) {
    if (isHardline(step.command, full)) return refuse(full ? HARDLINE_FULL : HARDLINE);
    const reach = commandPaths(step.command, { roots: agentRoots(agent), cwd, dataDir: ctx.config?.dataDir, whole: wholeComputer(agent) });
    if (reach.keys.length) return refuse(`Geweigerd door TeamBot: deze opdracht gebruikt een beschermde map of beschermd bestand (sleutels, inloggegevens of de gegevens van TeamBot): ${reach.keys.slice(0, 3).join(', ')}`);
    outside = reach.outside;
  }
  if (step.url) {
    // A page a CLI engine fetches itself: only with "Internet" on for the bot, like TeamBot's own web tools.
    if (ctx.tools?.groupEnabled && !ctx.tools.groupEnabled(agent, 'web')) return refuse(`Geweigerd door TeamBot: Internet staat uit voor ${agent.name}. Zet het aan bij de bot (Bewerken › Tools) als hij webpagina's mag lezen.`);
    try {
      // "Volledige toegang": this computer and the home network too (a bot tests the app it runs on 127.0.0.1).
      await assertPublicUrl(step.url, full || agent.settings?.allowPrivateNetwork === true);
    } catch (e: any) {
      return refuse(`Geweigerd door TeamBot: ${e.message}`);
    }
  }

  const call: Call = { name: step.name, risk: step.risk, impact: step.impact, internal: step.internal, group: step.group };
  const decided = ctx.broker.decide(agent, call, step.args);
  // The owner's own rule that made this ask or be refused, for the card and the bot.
  const rule = decided !== 'allow' ? ownRule(ctx, agent, call, step.args, decided) : null;
  if (decided === 'deny')
    return refuse(
      rule ? `Geweigerd door een regel van je eigenaar: “${rule}”. Doe dit niet; vraag je eigenaar als het echt nodig is.` : `Geweigerd door TeamBot: ${agent.name} heeft in modus "${agent.access_mode}" geen toestemming voor ${step.name} (${RISK_LABEL[step.risk]}).`,
      false,
    );
  // The card names what lies outside the bot's folders (once: the terminal tool says it in its own line already), and
  // offers no "Altijd toestaan" for it (risk "danger"): the next command outside asks again whatever the owner chose.
  if (outside.length && !/ — buiten de (?:werkplek|mappen) van de bot: /.test(summary)) summary = redact(`${summary} — buiten de mappen van de bot: ${outside.slice(0, 3).join(', ')}`).slice(0, CUT);
  if (decided === 'ask' || outside.length) return { decision: 'ask', note: rule ? `Jouw regel: “${rule}”` : '', risk: outside.length ? 'danger' : step.risk, summary };

  if (step.risk === 'read') return { decision: 'run', summary };
  // The bot's own "Automatische controle" counts where its switch is: at the level "Automatisch".
  const own = agent.access_mode === 'auto' && agent.settings?.autoReview === true;
  const review = reviewRules(ctx, agent, call, step.args);
  if (!own && !review.texts.length) return { decision: 'run', summary };
  return { decision: 'review', rules: review.texts, own, strong: review.strong, summary };
}

/**
 * One step through the gate, to the end: the decision, the reviewer when the decision needs one, the card when the
 * owner must decide. `onWait`: a card is open (true, with its line) or closed again (false). Any error refuses.
 */
export async function passGate(turn: GateTurn, step: GateStep, o: { onWait?(waiting: boolean, summary: string): void } = {}): Promise<GateOutcome> {
  const { ctx, agent } = turn;
  let summary = redact(step.summary || step.name).slice(0, CUT);
  try {
    const v = await judgeStep(turn, step);
    summary = v.summary;
    if (v.decision === 'refuse') return { allow: false, asked: false, reason: v.reason, blocked: v.blocked, summary };
    let note = v.decision === 'ask' ? v.note : '';
    if (v.decision === 'review') {
      // Without a turn there is nothing to read the step against: only a rule that clearly names it asks.
      const r =
        turn.thread && turn.run
          ? await autoReview(ctx, agent, turn.thread, turn.run, { name: step.name, risk: step.risk }, step.input, { rules: v.rules, own: v.own, failOpen: !v.own && !v.strong })
          : { verdict: v.strong ? ('ask' as const) : ('allow' as const), reason: 'Je hebt een eigen regel die TeamBot niet vooraf kan controleren.' };
      if (r.verdict === 'allow') return { allow: true, asked: false, reason: '', blocked: false, summary };
      note = `Automatische controle: ${r.reason}`;
    }
    if (v.decision === 'run') return { allow: true, asked: false, reason: '', blocked: false, summary };
    if (note) summary = `${note}\n${summary}`.slice(0, CUT);
    o.onWait?.(true, summary);
    try {
      const r = await ctx.broker.request({ userId: turn.userId, agent, thread: turn.thread, run: turn.run, kind: 'tool', tool: step.name, input: step.input, summary, risk: v.decision === 'ask' ? v.risk : step.risk, signal: turn.signal, park: true });
      return { allow: r.approved, asked: true, by: r.by, reason: r.approved ? '' : r.parked ? PARKED_TEXT : 'De gebruiker heeft deze actie geweigerd. Vraag eventueel wat je anders moet doen.', blocked: false, summary };
    } catch {
      return { allow: false, asked: true, reason: 'Gestopt voordat er toestemming was.', blocked: false, summary };
    } finally {
      o.onWait?.(false, summary);
    }
  } catch (e: any) {
    return { allow: false, asked: false, reason: `Geweigerd door TeamBot (interne fout): ${String(e?.message || e).slice(0, 200)}`, blocked: true, summary };
  }
}
