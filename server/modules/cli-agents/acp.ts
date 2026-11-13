import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentRunResult, Usage } from '../../core/types.js';
import { acpContext } from '../usage/parse.js';
import { withUsage } from '../../agent/budget.js';
import { redact } from '../../core/secrets.js';
import { fullAccess, resolveInWorkspace } from '../../tools/builtin/files.js';
import { runTempDir, startProc, type Proc } from './proc.js';
import { authHint, lastOutput, composePrompt, contextState, earlierTranscript, cleanFacts, errorText, safeAttachments, sessionInstructions, sessionUpdate, workdir, type RunScope, type SessionContext } from './context.js';
import { acpAppTool, acpKindRisk, acpToolSummary, cardPath, commandOf, gate, hardBlocks, hardBlocksNote, otherToolRisk, pathsOf, plainCommand, urlOf, type GateScope } from './permissions.js';
import { RequestError } from '@agentclientprotocol/sdk';
import { ACP_PROTOCOL_VERSION, acpWire, isWireError, type AcpWire } from './acp-wire.js';
import type { CliDef } from './catalog.js';
import { APP_VERSION } from '../../core/config.js';
import { MCP_SERVER_NAME, type BridgeRegistration, type PermissionBridge } from './bridge.js';
import { teambotTools, toolsNote } from './toolhost.js';
import { acpActivity, acpFacts, acpPendingTitle, acpPermissionSummary, acpTeambotTool, failedStep } from './activity-labels.js';
import { normalizePlan } from '../../tools/builtin/plan.js';
import { PLACE } from '../../../shared/places.js';

/**
 * Generic Agent Client Protocol (ACP) client over stdio. TeamBot is the "client"
 * (editor role): it starts the agent, opens or loads a session in the bot's
 * workspace, streams session/update notifications into the chat, answers
 * session/request_permission via the Broker, and serves fs/* only inside the
 * workspace. No terminal capability is offered, so agents use their own
 * (permission-gated) execution.
 */

export { ACP_PROTOCOL_VERSION };
const IMAGE = /^image\/(png|jpe?g|gif|webp)$/;
const NORM = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

/**
 * Some ACP agents send Windows paths without the drive letter (OpenCode: "Users/x/ws/file.txt" for
 * "C:\Users\x\ws\file.txt"). Such a path would be taken as relative to the workspace. When it is the workspace
 * path minus its drive, put the drive back; everything else is left unchanged (and still checked by the workspace rules).
 */
export function acpPath(p: string, cwd: string, win = process.platform === 'win32'): string {
  if (!win || !p || path.win32.isAbsolute(p)) return p;
  const drive = cwd.match(/^([A-Za-z]:)[\\/]/)?.[1];
  if (!drive) return p;
  const bare = cwd.slice(3).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const q = p.replace(/\\/g, '/');
  if (q.toLowerCase() === bare || q.toLowerCase().startsWith(bare + '/')) return path.win32.join(`${drive}\\`, q);
  return p;
}

/**
 * An error the agent only writes to its log, after which it keeps retrying in silence (found live with OpenCode 1.19:
 * at the daily free limit `session/prompt` never returns and no update comes, so the chat said "Denkt na…" for good).
 * OpenCode prints its log on stderr with `--print-logs`; a failed model call of the main agent reads
 * `level=ERROR … message="stream error" … agent=build … error.error="AI_APICallError: Free usage limit reached …"`.
 * Only errors that a retry cannot fix end the turn: the free limit, a login problem, an unknown model. Title
 * generation (`small=true`) is ignored. Returns the engine's own error text, or null.
 */
export function fatalStderrError(text: string): string | null {
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!/level=ERROR/.test(line) || !/message="?stream error/.test(line) || /\bsmall=true\b/.test(line)) continue;
    const err = (/error\.error="((?:[^"\\]|\\.)*)"/.exec(line)?.[1] || '').replace(/^AI_\w+Error:\s*/, '').trim();
    if (!err) continue;
    if (/free usage limit|free[_ -]?tier|free-models-per-(day|min)|daily free allocation/i.test(err)) return err;
    if (/unauthori[sz]ed|\b401\b|invalid[_ ]?api[_ -]?key|not\s+logged\s+in|authentication/i.test(err)) return err;
    if (/model[_ ]?not[_ ]?found|unknown[_ ]model|no such model/i.test(err)) return err;
  }
  return null;
}

export interface AcpDeps {
  def: CliDef;
  bin: string;
  args: string[];
  /** Serves TeamBot's own tools to the agent over MCP (session/new|load|resume `mcpServers`). */
  bridge?: PermissionBridge;
  /** Extra environment for this run (e.g. the chosen model in the CLI's inline config). */
  env?: Record<string, string>;
  /** Optional auth method id the owner selected (calls ACP `authenticate` with an already existing CLI login). */
  authMethod?: string;
  billing(): Promise<'subscription' | 'api' | 'unknown'>;
  track(p: Proc): () => void;
  /** Safety net: earlier unapproved action by this CLI (then ask/readonly runs are refused until the owner resets). */
  unsafe?(): { at: string; kind: string; title: string } | null;
  markUnsafe?(info: { kind: string; title: string }): void;
  /** What the stored session already has of its instructions (ACP has no system prompt: changes go in as an update). */
  context?: SessionContext;
}

/** ACP `mcpServers` entry (stdio; every ACP agent must support it). */
export function acpMcpServer(srv: { command: string; args: string[]; env: Record<string, string> }) {
  return { name: MCP_SERVER_NAME, command: srv.command, args: srv.args, env: Object.entries(srv.env).map(([name, value]) => ({ name, value })) };
}

/** Does an ACP tool call belong to TeamBot's own MCP server (e.g. OpenCode names it "teambot_memory_search")? */
export function isTeambotToolCall(tc: any, names: Set<string>): boolean {
  // The title comes from the agent: never let a native action (edit, command, fetch, …) pass by naming itself after
  // a TeamBot tool. MCP tool calls are kind "other" (or none) and carry no command or file locations.
  if (tc?.kind && tc.kind !== 'other') return false;
  if (commandOf(tc?.rawInput) || (Array.isArray(tc?.locations) && tc.locations.length)) return false;
  const cands = [tc?.title, tc?.rawInput?.tool, tc?._meta?.tool, tc?._meta?.toolName].filter((x) => typeof x === 'string') as string[];
  for (const c of cands) {
    const m = c.trim().match(/^(?:mcp__)?teambot(?:__|[_.:/ ])([A-Za-z0-9_-]{1,64})\b/);
    if (m && names.has(m[1])) return true;
  }
  return false;
}

/** Tool kinds that change something; in ask/readonly mode they must have gone through session/request_permission. */
const CHANGING_KINDS = new Set(['edit', 'delete', 'move', 'execute']);

type Mode = { id: string; name?: string };

/** Pick an ACP session mode that is never broader than the TeamBot access mode. */
export function pickAcpMode(access: string, current: string | undefined, modes: Mode[]): { set?: string; refuse?: string } {
  const ids = modes.map((m) => m.id);
  const find = (re: RegExp) => modes.find((m) => re.test(m.id) || re.test(m.name || ''))?.id;
  const broad = /yolo|bypass|full[-_ ]?access|dangerous|accept[-_ ]?(all|edits)|auto[-_ ]?(edit|accept|approve)|never[-_ ]?ask|agent[-_ ]?full/i;
  if (!ids.length) return {};
  if (access === 'readonly') {
    const ro = find(/^(plan|read[-_ ]?only|readonly|view|architect)$/i) || find(/plan|read[-_ ]?only/i);
    if (ro) return ro === current ? {} : { set: ro };
  }
  const safe = find(/^(default|ask|normal|manual|code|build|agent)$/i);
  if (current && broad.test(current)) {
    if (safe && !broad.test(safe)) return { set: safe };
    return { refuse: `De CLI staat in modus "${current}" (keurt zelf alles goed) en heeft geen veiligere modus. Pas de modus in de CLI aan.` };
  }
  return {};
}

export async function runAcp(s: RunScope, d: AcpDeps): Promise<AgentRunResult> {
  const { agent, req } = s;
  if (agent.access_mode === 'chat') {
    return { text: '', usage: { input: 0, output: 0 }, error: `Chatmodus (zonder tools) kan bij ${d.def.label} niet worden afgedwongen. Zet deze bot op "Alleen lezen" of gebruik een API-provider voor alleen chatten.` };
  }
  const guarded = agent.access_mode === 'ask' || agent.access_mode === 'readonly';
  const flagged = guarded ? d.unsafe?.() : null;
  if (flagged)
    return {
      text: '',
      usage: { input: 0, output: 0 },
      error: `${d.def.label} voerde eerder een actie uit zonder TeamBot om toestemming te vragen (${flagged.kind}: ${flagged.title}). Daarom draait deze CLI niet meer in "vraagt toestemming" of "alleen lezen". Controleer de instellingen van de CLI en sta hem daarna opnieuw toe via ${PLACE.aiPrograms}.`,
    };
  const cwd = workdir(agent);
  const atts = safeAttachments(agent, req.attachments);
  const usage: Usage = { input: 0, output: 0 };
  let text = '';
  let reasoning = '';
  let sessionId: string | undefined;
  let replaying = false;
  let needSep = false;
  const toolCalls = new Map<string, any>();
  // Safety net (found live: a CLI may approve its own edits): which tool calls asked TeamBot first.
  const asked = new Set<string>();
  let lastClientWrite = 0;
  let violation = '';
  const approvedPaths = new Set<string>();
  // OpenCode asks twice for one write outside its folder ("external_directory", then "edit"), both for the same tool
  // call: what the user (or the policy) already allowed for that call is not asked again.
  const allowedCalls = new Map<string, string>();
  let planShown = '';
  // The last action refused in this turn (OpenCode then ends the turn itself, as "cancelled"), TeamBot's reason, and
  // whether a person refused something (then the turn stays stopped; see FOLLOW_UPS).
  let refused = '';
  let refusedWhy = '';
  let humanRefused = false;
  // 0 = the owner's message, 1… = a follow-up turn after OpenCode stopped on a refusal by TeamBot's own limits.
  let round = 0;
  // Actions the owner approved in this run, by what they do: when the agent dropped one after another refusal, its
  // retry in the follow-up turn is not asked again (once, only the exact same action).
  const ownerApproved = new Map<string, string>();
  // Approval cards still open per tool call: withdrawn when the agent drops that call (see session/request_permission).
  const waitingCards = new Map<string, AbortController>();
  const gs: GateScope = {
    ctx: s.ctx,
    agent,
    thread: s.thread,
    run: s.run,
    userId: req.userId,
    signal: s.signal,
    ns: d.def.id,
    hold: (on) => proc.hold(on),
    onActivity: (title, detail) => s.activity('permission', title, detail),
  };
  let peer!: AcpWire;
  // TeamBot's own tools for this run, offered to the agent as an MCP server (gated inside TeamBot).
  let started: Proc | null = null;
  const host = d.bridge ? teambotTools(s, { engine: 'acp', hold: (on) => started?.hold(on) }) : null;
  const toolNames = host ? await host.names() : [];
  const teambotNames = new Set(toolNames);
  let reg: BridgeRegistration | null = null;
  let tmp: { dir: string; cleanup(): void } | null = null;
  let mcpServers: any[] = [];
  if (host && d.bridge && toolNames.length) {
    await d.bridge.ensure();
    tmp = runTempDir(s.ctx.config.dataDir, req.runId);
    reg = d.bridge.register({ tools: host }, tmp.dir);
    mcpServers = [acpMcpServer(d.bridge.stdioServer(reg, { tools: true }))];
  }
  const release = () => {
    reg?.dispose();
    tmp?.cleanup();
  };
  let proc!: Proc;
  let untrack: () => void = () => {};
  let exited: Promise<unknown> = Promise.resolve();
  // A fatal error the agent only logs (see fatalStderrError): ends the waiting session/prompt right away.
  let stderrFatal = '';
  let onFatal: (msg: string) => void = () => {};
  const fatalSeen = new Promise<never>((_, reject) => (onFatal = (msg) => reject(new Error(msg))));
  fatalSeen.catch(() => {});
  // (Re)start the agent process; the handlers below are attached to every new peer.
  const launch = () => {
    let errBuf = '';
    proc = startProc({
      bin: d.bin,
      args: d.args,
      cwd,
      env: { NO_COLOR: '1', ...(d.def.acpEnv || {}), ...(d.env || {}) },
      signal: s.signal,
      timeoutMs: s.opts.timeoutMin * 60_000,
      idleMs: s.opts.idleMin * 60_000,
      graceMs: 3000,
      onLine: (l) => peer.handleLine(l),
      onStderr: (chunk) => {
        if (stderrFatal) return;
        errBuf = (errBuf + chunk).slice(-20_000);
        const nl = errBuf.lastIndexOf('\n');
        if (nl < 0) return;
        const err = fatalStderrError(errBuf.slice(0, nl));
        errBuf = errBuf.slice(nl + 1);
        if (!err) return;
        stderrFatal = redact(err).slice(0, 400);
        onFatal(stderrFatal);
      },
    });
    started = proc;
    peer = acpWire(proc);
    peer.onNotification = onNotification;
    peer.onRequest = onRequest;
    untrack = d.track(proc);
    const p = proc;
    const pr = peer;
    exited = p.done.then((x) => {
      pr.close(`${d.def.label} is gestopt`);
      return x;
    });
  };

  // A refused action: by TeamBot's own limits (outside the bot's folders, read-only, its mode) or by a person.
  const noteRefusal = (what: string, g: { message: string; asked: boolean }) => {
    refused = what;
    refusedWhy = g.message;
    if (g.asked) humanRefused = true;
  };

  // A step that only calls one of TeamBot's own tools: TeamBot reports the result on that step (B-04). OpenCode 2.x
  // sends the program of a code-mode step only after it ran (live, 2.2.6: the TeamBot call came first), so until the
  // program is in, the step takes any TeamBot result ('*'). A program that turns out to do more than call TeamBot
  // tools (fetch, a lookup) gets its own line again: real code is never hidden behind a TeamBot step.
  const claimForTeambot = (cur: any, finished: boolean) => {
    if (!cur.item || cur.titled) return;
    const code = typeof cur.rawInput?.code === 'string' ? cur.rawInput.code : '';
    if (!cur.teambot) {
      if (finished) return;
      const tool = acpTeambotTool(cur, teambotNames);
      const codeStep = !code && String(cur.title ?? '').trim() === 'execute' && (!cur.kind || cur.kind === 'other') && !commandOf(cur.rawInput);
      if (tool || codeStep) {
        cur.teambot = tool || '*';
        s.teambotStep?.(cur.teambot, cur.item);
      }
      return;
    }
    if (cur.teambot !== '*' || !code) return;
    const tool = acpTeambotTool(cur, teambotNames);
    cur.teambot = tool || '-';
    if (s.isTeambotLine?.(cur.item)) {
      if (!tool) cur.item = s.activity('tool', acpPendingTitle(cur, cwd), describeTool(cur, cwd), acpFacts(cur, cwd), { pending: !finished });
      return;
    }
    s.teambotStepDone?.(cur.item);
    if (tool && !finished) s.teambotStep?.(tool, cur.item);
  };

  const pushText = (t: string) => {
    if (!t) return;
    if (needSep && text && !text.endsWith('\n\n')) {
      const sep = text.endsWith('\n') ? '\n' : '\n\n';
      text += sep;
      s.emit({ type: 'text', delta: sep });
    }
    needSep = false;
    text += t;
    s.emit({ type: 'text', delta: t });
  };

  const onNotification = (method: string, p: any) => {
    if (method !== 'session/update' || replaying) return;
    if (sessionId && p?.sessionId && p.sessionId !== sessionId) return;
    const u = p?.update || {};
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        if (u.content?.type === 'text') pushText(String(u.content.text || ''));
        break;
      case 'agent_thought_chunk':
        if (u.content?.type === 'text') {
          reasoning += u.content.text || '';
          s.emit({ type: 'reasoning', delta: String(u.content.text || '') });
        }
        break;
      case 'tool_call': {
        needSep = true;
        // The input often arrives only with a later update: the facts are added to this same step then. Until the
        // call is completed (often after an approval card) the step says what the bot wants to do (Q-12).
        const done = u.status === 'completed' || u.status === 'failed';
        const item = s.activity('tool', done ? acpActivity(u, cwd) : acpPendingTitle(u, cwd), describeTool(u, cwd), acpFacts(u, cwd), { pending: !done });
        const cur = { ...u, startedAt: Date.now(), item, titled: done };
        toolCalls.set(u.toolCallId, cur);
        claimForTeambot(cur, done);
        break;
      }
      case 'tool_call_update': {
        const prev = toolCalls.get(u.toolCallId) || {};
        const cur = { ...prev, ...Object.fromEntries(Object.entries(u).filter(([, v]) => v !== undefined && v !== null)) };
        toolCalls.set(u.toolCallId, cur);
        const finished = u.status === 'failed' || u.status === 'completed';
        if (finished) waitingCards.get(u.toolCallId)?.abort();
        claimForTeambot(cur, finished);
        if (finished && cur.item) s.teambotStepDone?.(cur.item);
        // OpenCode's code mode sends the program only with a later update ("execute" with no input first), and a shell
        // step its command: name the waiting step after it then, so an approval card is not shown next to "Wil code
        // uitvoeren" (round 6), and a step is not titled with the bare command.
        if (cur.item && !cur.titled && !finished && (typeof u.rawInput?.code === 'string' || commandOf(u.rawInput))) s.retitle(cur.item, acpPendingTitle(cur, cwd));
        if (cur.item && !cur.item.facts && u.status !== 'failed') {
          const facts = acpFacts(cur, cwd);
          if (facts) cur.item.facts = cleanFacts(facts);
        }
        // A step that failed did not happen: it keeps saying what the bot wanted ("Wil x aanpassen"), like Claude Code.
        const failed = u.status === 'failed' ? failedStep(acpActivity(cur, cwd)) : null;
        if (cur.item && !cur.titled && finished) {
          cur.titled = true;
          s.retitle(cur.item, failed ? failed.title : acpActivity(cur, cwd), { done: true });
        } else if (cur.item?.pending && finished) s.retitle(cur.item, cur.item.title, { done: true });
        // A changing action that completed without ever asking TeamBot (an edit through TeamBot's own fs/write was
        // gated there and counts as asked): stop the run, warn, and refuse this CLI in ask/readonly from now on.
        if (u.status === 'completed' && guarded && !violation && CHANGING_KINDS.has(String(cur.kind)) && !asked.has(u.toolCallId) && !(cur.kind === 'edit' && lastClientWrite >= (cur.startedAt || 0))) {
          const title = String(cur.title || cur.kind).slice(0, 200);
          violation = `Gestopt: ${d.def.label} voerde een actie uit zonder TeamBot om toestemming te vragen (${cur.kind}: ${title}). Controleer het resultaat in de werkmap. Deze CLI draait niet meer in "vraagt toestemming" of "alleen lezen" tot je hem in ${PLACE.aiPrograms} opnieuw toestaat.`;
          s.ctx.audit(req.userId, 'cli.unapproved_action', { cli: d.def.id, kind: cur.kind, title, mode: agent.access_mode }, agent.id);
          d.markUnsafe?.({ kind: String(cur.kind), title });
          proc.kill(violation);
        }
        // Like Claude Code: only failures get their own line ("Lukte niet: x aanpassen"); a finished step is already in
        // the list. A TeamBot tool's step already says "— mislukt" with TeamBot's own reason.
        if (failed && !(cur.item && s.isTeambotLine?.(cur.item))) s.activity('tool_error', failed.line, failedDetail(contentText(u.content)) || undefined);
        break;
      }
      case 'plan': {
        const steps = normalizePlan(u.entries);
        const key = JSON.stringify(steps);
        if (steps && key !== planShown) {
          planShown = key;
          s.emit({ type: 'plan', steps });
        }
        break;
      }
      case 'current_mode_update':
        s.activity('mode', `Modus: ${u.currentModeId}`);
        break;
      case 'usage_update': {
        if (typeof u.used === 'number') usage.input = Math.max(usage.input, u.used);
        const c = acpContext(u);
        if (c) s.ctx.services?.usage?.setContext?.(s.req.threadId, s.agent.id, { ...c, engine: d.def.label, providerId: s.cfg.id });
        break;
      }
    }
  };

  const onRequest = async (method: string, p: any): Promise<any> => {
    switch (method) {
      case 'session/request_permission': {
        if (s.signal.aborted) return { outcome: { outcome: 'cancelled' } };
        const tc = { ...(toolCalls.get(p?.toolCall?.toolCallId) || {}), ...(p?.toolCall || {}) };
        if (p?.toolCall?.toolCallId) asked.add(String(p.toolCall.toolCallId));
        const options0: any[] = Array.isArray(p?.options) ? p.options : [];
        if (isTeambotToolCall(tc, teambotNames)) {
          // TeamBot's own tools are gated inside TeamBot (Broker, tool policy, approvals) when they run.
          const ok = options0.find((o) => o.kind === 'allow_once') || options0.find((o) => /^allow/.test(o.kind) && o.kind !== 'allow_always');
          return ok ? { outcome: { outcome: 'selected', optionId: ok.optionId } } : { outcome: { outcome: 'cancelled' } };
        }
        const raw = tc.rawInput;
        const locs: string[] = (tc.locations || []).map((l: any) => String(l?.path || '')).filter(Boolean);
        const paths = [...new Set([...locs, ...pathsOf(raw)].map((x) => acpPath(x, cwd)))];
        const callId = String(p?.toolCall?.toolCallId || '');
        const sameAsAllowed = callId && allowedCalls.get(callId) === `${tc.kind}|${paths.join('|')}`;
        // The very same action the owner approved before OpenCode dropped it (see FOLLOW_UPS): not asked twice.
        const action = `${tc.kind}|${paths.join('|')}|${commandOf(raw)}|${JSON.stringify(raw ?? null)}`;
        const approvedCall = round > 0 && !sameAsAllowed ? ownerApproved.get(action) : undefined;
        const carried = !!approvedCall && toolCalls.get(approvedCall)?.status !== 'completed';
        if (carried) {
          ownerApproved.delete(action);
          s.ctx.audit(req.userId, 'cli.permission', { tool: `${d.def.id}:${tc.kind || 'other'}`, summary: acpPermissionSummary(tc, paths, cwd).slice(0, 300), allowed: true, carried: true }, agent.id);
        }
        // OpenCode ends the whole turn when one action is refused, also actions it runs at the same time that still
        // wait for a card: that card is withdrawn when OpenCode drops its call (round 6: the owner approved a write
        // to the team folder that OpenCode had already given up, and nothing was written).
        const dropped = new AbortController();
        if (callId) waitingCards.set(callId, dropped);
        // Nobody refused a withdrawn card: the step says so, not "Geweigerd: … Gestopt voordat er toestemming was".
        const onActivity = (title: string, detail?: string) =>
          dropped.signal.aborted && /^Geweigerd: /.test(title) ? s.activity('permission', title.replace(/^Geweigerd: /, 'Kaart ingetrokken: '), `${d.def.label} gaf deze actie op voordat je besliste.`) : gs.onActivity?.(title, detail);
        // A tool of one of the engine's own apps (an MCP server in its settings) goes to the gate as that app's tool,
        // under the name Claude Code gives it: it can send or pay, and the owner's rules know it by that name.
        const app = acpAppTool(tc);
        const g = sameAsAllowed ? { allow: true, message: 'Al toegestaan voor deze actie', asked: false } : carried ? { allow: true, message: 'Al goedgekeurd door de eigenaar', asked: false } : await gate({ ...gs, signal: AbortSignal.any([gs.signal, dropped.signal]), onActivity }, {
          tool: app || String(tc.kind || 'other'),
          risk: app ? otherToolRisk(app, raw) : acpKindRisk(tc.kind, raw),
          summary: acpPermissionSummary(tc, paths, cwd),
          input: raw ?? { title: tc.title },
          paths,
          url: tc.kind === 'fetch' ? urlOf(raw) || undefined : undefined,
          command: commandOf(raw) || undefined,
          // Deleting is confined to the workspace (paths checked above): local under "Volledige toegang".
          impact: tc.kind === 'delete' ? 'local' : undefined,
        });
        if (callId && waitingCards.get(callId) === dropped) waitingCards.delete(callId);
        if (s.signal.aborted || dropped.signal.aborted) return { outcome: { outcome: 'cancelled' } };
        const options: any[] = Array.isArray(p?.options) ? p.options : [];
        const pick = g.allow ? options.find((o) => o.kind === 'allow_once') || options.find((o) => /^allow/.test(o.kind) && o.kind !== 'allow_always') : options.find((o) => o.kind === 'reject_once') || options.find((o) => /^reject/.test(o.kind));
        if (!g.allow) noteRefusal(acpToolSummary(tc, cwd), g);
        if (g.allow && (tc.kind === 'edit' || tc.kind === 'move' || tc.kind === 'delete')) for (const x of paths) approvedPaths.add(NORM(path.isAbsolute(x) ? x : path.join(cwd, x)));
        if (g.allow && callId) allowedCalls.set(callId, `${tc.kind}|${paths.join('|')}`);
        if (g.allow && g.asked && callId) ownerApproved.set(action, callId);
        if (!pick) return { outcome: { outcome: 'cancelled' } };
        return { outcome: { outcome: 'selected', optionId: pick.optionId } };
      }
      case 'fs/read_text_file': {
        const file = resolveInWorkspace(agent, acpPath(String(p?.path || ''), cwd));
        const st = fs.statSync(file);
        if (st.size > 10_000_000) throw new RequestError(-32602, 'Bestand te groot (max 10 MB)');
        let content = fs.readFileSync(file, 'utf8');
        if (p?.line || p?.limit) {
          const lines = content.split('\n');
          const start = Math.max(0, (Number(p.line) || 1) - 1);
          content = lines.slice(start, p.limit ? start + Number(p.limit) : undefined).join('\n');
        }
        return { content };
      }
      case 'fs/write_text_file': {
        // Every write passes the gate, on every level (the owner's rules about a folder hold for it too), unless the
        // owner or the gate already allowed this very file for the engine's own permission request in this run.
        const asked = path.resolve(cwd, acpPath(String(p?.path || ''), cwd));
        if (!approvedPaths.has(NORM(asked))) {
          const g = await gate(gs, { tool: 'edit', risk: 'write', summary: `Bestand schrijven: ${p?.path}`, input: { path: p?.path, bytes: String(p?.content ?? '').length }, paths: [asked] });
          if (!g.allow) {
            noteRefusal(`Bestand schrijven: ${p?.path}`, g);
            throw new RequestError(-32000, g.message);
          }
        }
        const target = resolveInWorkspace(agent, asked, { write: true });
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, String(p?.content ?? ''));
        lastClientWrite = Date.now();
        s.ctx.audit(req.userId, 'cli.fs_write', { path: target, bytes: String(p?.content ?? '').length, cli: d.def.id }, agent.id);
        return null;
      }
      default:
        throw new RequestError(-32601, `TeamBot ondersteunt ${method} niet`);
    }
  };

  const fail = (msg: string): AgentRunResult => ({ text, usage, sessionId, error: msg });
  // One start at a time per CLI (and data folder): two OpenCode 2.x processes booting together share one SQLite
  // database and one of them exits "before reporting readiness" (soak test). Held until the session is open.
  const unlockStart = await startLock(`${d.def.id}:${process.env.XDG_DATA_HOME || ''}`, s.signal);
  try {
    let init: any;
    for (let attempt = 0; ; attempt++) {
      launch();
      try {
        init = await peer.request(
          'initialize',
          {
            protocolVersion: ACP_PROTOCOL_VERSION,
            clientCapabilities: { fs: { readTextFile: true, writeTextFile: agent.access_mode !== 'readonly' }, terminal: false },
            clientInfo: { name: 'teambot', title: 'TeamBot', version: APP_VERSION },
          },
          90_000,
        );
        break;
      } catch (e: any) {
        await Promise.race([exited, new Promise((r) => setTimeout(r, 200))]);
        const tail = proc.stderrTail();
        // A start that lost a race (another instance booting, database briefly locked): nothing happened yet, so
        // starting again is safe. Up to three more times, with a growing pause.
        if (STARTUP_RACE.test(`${tail} ${errorText(e)}`) && attempt < START_RETRIES.length && !s.signal.aborted) {
          s.activity('notice', `${d.def.label} startte niet meteen — opnieuw (${attempt + 2}e poging)`, lastOutput(tail) || undefined);
          untrack();
          proc.kill('opnieuw starten');
          await exited;
          await new Promise((r) => setTimeout(r, START_RETRIES[attempt] + Math.floor(Math.random() * 250)));
          continue;
        }
        if (STARTUP_RACE.test(`${tail} ${errorText(e)}`)) return fail(`${d.def.label} kon niet starten: een ander ${d.def.label}-proces op deze computer hield zijn database bezet (${attempt + 1} pogingen). Probeer het zo opnieuw; blijft het gebeuren, sluit dan andere ${d.def.label}-vensters of -bots.`);
        return fail(authHint(tail, d.def.login) || `${d.def.label} start niet als ACP-agent (${errorText(e)}).${lastOutput(tail) ? ' Laatste uitvoer: ' + lastOutput(tail) : ''}`);
      }
    }
    const caps = init?.agentCapabilities || {};
    if (d.authMethod) {
      try {
        await peer.request('authenticate', { methodId: d.authMethod }, 120_000);
      } catch (e: any) {
        return fail(`Inloggen via methode "${d.authMethod}" lukte niet (${errorText(e)}). Log zelf in met: ${d.def.login}`);
      }
    }
    const authMethods: string[] = (init?.authMethods || []).map((m: any) => m.name || m.id);
    const authFail = (e: any) => fail(`${d.def.label} vraagt om in te loggen. Log zelf in met: ${d.def.login}${authMethods.length ? ` (mogelijke methodes: ${authMethods.join(', ')})` : ''}. Details: ${errorText(e).slice(0, 200)}`);
    const isAuth = (e: any) => isWireError(e) && (e.code === -32000 || /auth/i.test(e.message));
    let modes: { currentModeId?: string; availableModes?: Mode[] } | undefined;
    let resumed = false;
    if (req.sessionId && (caps.sessionCapabilities?.resume || caps.loadSession)) {
      try {
        if (caps.sessionCapabilities?.resume) {
          const r: any = await peer.request('session/resume', { sessionId: req.sessionId, cwd, mcpServers }, 120_000);
          modes = r?.modes;
        } else {
          replaying = true;
          const r: any = await peer.request('session/load', { sessionId: req.sessionId, cwd, mcpServers }, 180_000);
          modes = r?.modes;
        }
        sessionId = req.sessionId;
        resumed = true;
        s.activity('session', `${d.def.label}-sessie hervat`);
      } catch (e: any) {
        if (isAuth(e)) return authFail(e);
        s.activity('session', `Vorige ${d.def.label}-sessie niet te laden — nieuwe sessie gestart`, errorText(e).slice(0, 200));
      } finally {
        replaying = false;
      }
    }
    if (!resumed) {
      try {
        const r: any = await peer.request('session/new', { cwd, mcpServers }, 120_000);
        sessionId = String(r?.sessionId || '');
        modes = r?.modes;
      } catch (e: any) {
        if (isAuth(e)) return authFail(e);
        return fail(`${d.def.label} kon geen sessie starten: ${errorText(e)}`);
      }
      if (!sessionId) return fail(`${d.def.label} gaf geen sessie-id terug`);
      s.activity('session', `${d.def.label}-sessie gestart`, caps.loadSession || caps.sessionCapabilities?.resume ? undefined : 'Deze CLI kan sessies niet hervatten; TeamBot geeft het eerdere gesprek steeds als context mee.');
    }
    unlockStart();
    s.emit({ type: 'session', sessionId: sessionId! });
    const pm = pickAcpMode(agent.access_mode, modes?.currentModeId, modes?.availableModes || []);
    if (pm.refuse) return fail(pm.refuse);
    if (pm.set) {
      try {
        await peer.request('session/set_mode', { sessionId, modeId: pm.set }, 30_000);
        s.activity('mode', `Modus ingesteld: ${pm.set}`);
      } catch (e: any) {
        if (agent.access_mode !== 'readonly') return fail(`Kon de veilige modus "${pm.set}" niet instellen: ${errorText(e)}`);
      }
    }

    let transcript = '';
    if (!resumed) {
      const t = earlierTranscript(s.ctx, agent, req.threadId, s.run?.input_message_id);
      if (t.count) {
        transcript = t.text;
        s.activity('session', 'Eerdere context meegegeven', t.count === 1 ? '1 eerder bericht uit deze chat' : `${t.count} eerdere berichten uit deze chat`);
      }
    }
    // An engine TeamBot cannot make ask for every step: the hard blocks go along in its instructions (permissions.ts hardBlocks).
    const blocks = hardBlocks({ engine: 'acp', cli: d.def.id, label: d.def.label, level: agent.access_mode });
    const full = sessionInstructions(req.system, [toolNames.length ? toolsNote(toolNames, 'acp', { full: fullAccess(agent) }) : '', blocks.guarded ? '' : hardBlocksNote(agent, s.ctx.config.dataDir)].filter(Boolean).join('\n\n'));
    const prompt: any[] = [{ type: 'text', text: composePrompt({ system: resumed ? undefined : full, update: resumed ? sessionUpdate(s, d.context, full) : undefined, transcript, prompt: req.prompt, attachments: atts }) }];
    for (const a of atts) {
      if (IMAGE.test(a.mime) && caps.promptCapabilities?.image && a.size < 5_000_000) prompt.push({ type: 'image', mimeType: a.mime, data: fs.readFileSync(a.path).toString('base64') });
      else prompt.push({ type: 'resource_link', uri: pathToFileURL(a.path).href, name: a.name, mimeType: a.mime, size: a.size });
    }
    const onAbort = () => peer.notify('session/cancel', { sessionId });
    s.signal.addEventListener('abort', onAbort, { once: true });
    let res: any;
    let turn = prompt;
    // Tokens of every prompt in this run (the owner's message and any follow-up turn).
    const used = { input: 0, output: 0, cacheRead: 0, seen: false };
    // What this run used: the prompts' own counts, else the context fill the agent reported; also when it is stopped
    // (it goes along with the stop and is counted: agent/budget.ts).
    const total = async (): Promise<Usage> => {
      if (used.seen) {
        if (used.input) usage.input = used.input;
        usage.output = used.output;
        usage.cacheRead = used.cacheRead || undefined;
      }
      usage.cost = (await d.billing()) === 'api' ? undefined : 0;
      return usage;
    };
    try {
      for (;;) {
        try {
          res = await Promise.race([peer.request('session/prompt', { sessionId, prompt: turn }), fatalSeen]);
        } catch (e: any) {
          if (s.signal.aborted) throw withUsage(new Error('Gestopt'), await total());
          if (stderrFatal) {
            // Written before the process is ended below (the SDK writes asynchronously), and a moment for the agent to
            // take it (it stops its silent retries) before TeamBot ends the process anyway.
            await peer.notify('session/cancel', { sessionId });
            await Promise.race([exited, new Promise((r) => setTimeout(r, CANCEL_GRACE_MS))]);
            return fail(authHint(stderrFatal, d.def.login) || `${d.def.label} gaf een fout: ${stderrFatal}`);
          }
          if (proc.killedReason) return fail(proc.killedReason);
          if (isAuth(e)) return authFail(e);
          const tail = proc.stderrTail();
          return fail(authHint(errorText(e) + ' ' + tail, d.def.login) || `${d.def.label} gaf een fout: ${errorText(e)}${peer.closed && lastOutput(tail) ? ' Laatste uitvoer: ' + lastOutput(tail) : ''}`);
        }
        const u = res?.usage || res?._meta?.usage;
        if (u) {
          used.seen = true;
          used.input += Number(u.inputTokens ?? u.input_tokens ?? 0) || 0;
          used.output += Number(u.outputTokens ?? u.output_tokens ?? 0) || 0;
          used.cacheRead += Number(u.cachedReadTokens ?? u.cacheReadTokens ?? 0) || 0;
        }
        if (violation || s.signal.aborted) break;
        // The agent ended the turn itself after TeamBot's own limits refused an action, and dropped the rest of that
        // step with it (see FOLLOW_UPS): one short follow-up turn in the same session does the rest. Not after a
        // person refused something: then the bot stops, as asked.
        if (res?.stopReason !== 'cancelled' || !refused || humanRefused || round >= FOLLOW_UPS) break;
        round++;
        s.activity('notice', `TeamBot liet ${d.def.label} verdergaan zonder de geweigerde actie`, refused.slice(0, 300));
        turn = [{ type: 'text', text: acpFollowUpNote(refused, refusedWhy) }];
        refused = '';
        refusedWhy = '';
        needSep = true;
      }
    } finally {
      s.signal.removeEventListener('abort', onAbort);
    }
    if (violation) return fail(violation);
    if (s.signal.aborted) throw withUsage(new Error('Gestopt'), await total());
    if (res?.stopReason === 'cancelled') {
      // Not stopped by the owner: the CLI ended the turn itself after an action was refused (OpenCode does that, with
      // an empty answer) and no follow-up turn followed. Say so plainly instead of "Gestopt"; not an engine error (no
      // reserve engine).
      if (!refused) throw withUsage(new Error('Gestopt'), await total());
      const note = `_${d.def.label} stopte deze beurt nadat een actie niet mocht (${refused.slice(0, 200)}). Zeg wat de bot anders moet doen._`;
      const sep = text ? (text.endsWith('\n') ? '\n' : '\n\n') : '';
      s.emit({ type: 'text', delta: sep + note });
      text += sep + note;
    }
    await total();
    if (res?.stopReason === 'refusal') s.activity('notice', `${d.def.label} weigerde deze opdracht`);
    if (res?.stopReason === 'max_tokens' || res?.stopReason === 'max_turn_requests') s.activity('max_turns', 'Gestopt: maximum bereikt', String(res.stopReason));
    if (sessionId) d.context?.save(sessionId, contextState(full));
    void reasoning;
    return { text, usage, sessionId };
  } finally {
    unlockStart();
    untrack();
    proc.kill('klaar');
    await exited;
    release();
  }
}

/**
 * Follow-up turns per run after an ACP agent ended its turn because TeamBot's own limits refused an action (outside
 * the bot's folders, read-only, its mode; acceptance round 6, B-45/B-46). OpenCode 2.x fails every other action of
 * that step on any refusal and ends the turn, also an action the owner had just approved. It has no setting to go on
 * (`continue_loop_on_deny` is an ignored key in 2.2.6), and after an allowed permission it writes the file itself (it
 * never uses fs/write_text_file), so "allow, then let TeamBot's write fail" would let it write outside the bot's
 * folders. A short follow-up turn in the same session works for any agent and keeps every refusal in place.
 */
const FOLLOW_UPS = 2;

/** What TeamBot tells the agent in that follow-up turn: what was refused and why, and to do the rest without it. */
export function acpFollowUpNote(what: string, why: string): string {
  const reason = String(why || '').replace(/^Geweigerd door TeamBot:\s*/, '').trim();
  return `[TeamBot] TeamBot heeft deze actie geweigerd: ${what}${reason ? ` (${reason})` : ''}. Daarop brak je je hele beurt af: acties die nog niet klaar waren, zijn niet uitgevoerd, ook als ze wel mochten. Ga verder met de rest van de opdracht: doe wat nog niet gedaan is en wel mag, maar probeer de geweigerde actie niet nog eens en ook niet via een omweg. Zeg in je antwoord kort wat niet kon en waarom.`;
}

/** How long an agent gets to take session/cancel after a fatal logged error, before its process is ended. */
const CANCEL_GRACE_MS = 500;

/** Start failures that a new attempt can fix: another instance was booting at the same moment. */
export const STARTUP_RACE = /exited before reporting readiness|database is locked|SQLITE_BUSY/i;
const START_RETRIES = [700, 1500, 3000];
const START_LOCK_MAX_MS = 30_000;
const startLocks = new Map<string, Promise<void>>();

/**
 * Wait for the previous start with the same key (at most 30 s: a hanging start never blocks the others for long),
 * then return the release function for this start (idempotent).
 */
export async function startLock(key: string, signal?: AbortSignal): Promise<() => void> {
  const prev = startLocks.get(key) || Promise.resolve();
  let free!: () => void;
  const mine = new Promise<void>((r) => (free = r));
  const tail = prev.then(() => mine);
  startLocks.set(key, tail);
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    prev,
    new Promise<void>((r) => {
      timer = setTimeout(r, START_LOCK_MAX_MS);
      signal?.addEventListener('abort', () => r(), { once: true });
    }),
  ]);
  clearTimeout(timer);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    free();
    if (startLocks.get(key) === tail) startLocks.delete(key);
  };
}

/**
 * The detail under "Lukte niet: …". After TeamBot refused a step, OpenCode answers the call with its own English
 * sentence "The user declined this tool call" (acceptance round 5, B-45); the line above already says who refused and
 * why, so that sentence becomes "Niet toegestaan." Anything else is shown as the engine wrote it.
 */
export function failedDetail(text: string): string {
  const t = String(text || '').trim();
  if (/^(the )?user (declined|rejected|denied) (?:(this|the) )?(tool call|permission|request)\.?$/i.test(t)) return 'Niet toegestaan.';
  return t.slice(0, 400);
}

function contentText(content: any): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((c: any) => {
      if (c?.type === 'content' && c.content?.type === 'text') return c.content.text;
      if (c?.type === 'diff') return `diff: ${c.path}`;
      if (c?.type === 'terminal') return '[terminal]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * The detail under a step: the command or code, and the files it touches relative to the bot's working folder
 * (`cwd`). The working folder itself ("paden: C:\…\workspaces\ag_…") and OpenCode's `cd "<that folder>" &&` say
 * nothing to the owner and are left out.
 */
export function describeTool(u: any, cwd?: string): string | undefined {
  const parts: string[] = [];
  const cmd = plainCommand(commandOf(u.rawInput), cwd);
  const code = typeof u.rawInput?.code === 'string' ? u.rawInput.code.trim() : '';
  if (code && !cmd) parts.push(`code: ${code.replace(/\s+/g, ' ').slice(0, 300)}`);
  if (cmd) parts.push(`opdracht: ${cmd.slice(0, 300)}`);
  const root = cwd ? path.resolve(cwd).toLowerCase() : '';
  const locs = [...new Set((u.locations || []).map((l: any) => String(l?.path || '')).filter((p: string) => p && (!root || path.resolve(cwd!, p).toLowerCase() !== root)).map((p: string) => cardPath(p, cwd)))];
  if (locs.length) parts.push(`${locs.length === 1 ? 'bestand' : 'bestanden'}: ${locs.slice(0, 5).join(', ')}`);
  return parts.length ? redact(parts.join(' · ')) : undefined;
}
