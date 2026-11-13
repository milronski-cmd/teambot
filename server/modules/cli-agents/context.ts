import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ActivityItem, Agent, AgentEvent, AgentRunRequest, Ctx, ProviderConfig, Run, StepFact, Thread } from '../../core/types.js';
import { now } from '../../core/db.js';
import { redact } from '../../core/secrets.js';
import { agentRoots, fullAccess, resolveInWorkspace } from '../../tools/builtin/files.js';
import { applyRunOverride } from '../../agent/runner.js';
import { stoppedByOwner } from '../../agent/runs.js';
import { agentForThread } from '../../agent/shared.js';
import { DEFAULT_LANGUAGE_NOTE, languageSection, withLanguage } from '../../agent/language.js';
import { plainStepDetail } from '../../agent/fallback.js';
import { withoutOwnFolder } from './activity-labels.js';
import type { Words } from '../../../shared/i18n-core.js';

export interface CliOptions {
  /** Claude Code: extra allowed tool rules (only in ask/auto). */
  allowedTools: string[];
  disallowedTools: string[];
  /** Extra CLI flags, validated against a per-CLI allowlist. */
  extraArgs: string[];
  /** Claude Code: load the user's own settings files (less strict). */
  loadUserSettings: boolean;
  /** Use MCP servers from the CLI's own configuration. */
  useUserMcp: boolean;
  maxTurns: number;
  timeoutMin: number;
  idleMin: number;
  /** No output for this long while a step of the CLI is still running (a long build or test): only then is it dead. */
  busyIdleMin: number;
  /**
   * Claude Code: the owner's own memory files (CLAUDE.md) and auto-memory too. Only with an explicit
   * `cli.loadUserSettings: true`; the default of "Volledige toegang" brings his settings, skills and apps, not the
   * notes he wrote for his own Claude Code sessions (a bot would take them for its own instructions).
   */
  ownerMemory: boolean;
}

/**
 * Limits that never stop real work (the owner: no built-in brakes). A CLI that is silent while no step is running is
 * hung: stopped after `IDLE_MIN`. Silent while a step runs (a build, a test run, a download): alive, until
 * `BUSY_IDLE_MIN`. `TIMEOUT_MIN` is the ceiling for one turn. All three per bot adjustable (settings.cli).
 */
export const CLI_LIMITS = { idleMin: 30, busyIdleMin: 12 * 60, timeoutMin: 72 * 60, maxTurns: 40, maxTurnsFull: 10_000 };

/**
 * After the owner pressed Stop, the CLI session still holds the unfinished turn, and Claude Code picked the stopped task
 * up again on the next message (acceptance round 2, B-32). When this bot's previous run in this chat was stopped by the
 * owner, the next turn starts with this note, unless the owner asked to continue ("Hervatten").
 *
 * The session also never saw the outcome of a call that was cut off with the turn. Had the bot given work to a
 * colleague in that turn, it concluded "not handed over" (live, 12 nov). So the note says that work did arrive and was
 * stopped with the turn; what was given to whom is in TeamBot's notes in the conversation (modules/rooms).
 */
export function stoppedTaskNote(ctx: Ctx, req: Pick<AgentRunRequest, 'threadId' | 'agentId' | 'runId'>): string {
  const run = ctx.store.run(req.runId);
  if (!run || run.trigger === 'resume') return '';
  const prev = ctx.store.one<{ id: string; status: string; error: string | null }>('SELECT id, status, error FROM runs WHERE thread_id = ? AND agent_id = ? AND id != ? AND created_at <= ? ORDER BY created_at DESC LIMIT 1', req.threadId, req.agentId, req.runId, run.created_at);
  // One definition of "stopped by the owner" (agent/runs.ts): his own stop reasons, not a steering message, a shutdown
  // or a removed bot or chat.
  if (!prev || !stoppedByOwner(prev)) return '';
  const given = ctx.services.rooms?.stoppedGiven?.(prev.id) ? ' Wat je in die beurt al aan een collega had gegeven, is aangekomen en met jouw beurt gestopt: het is niet af en blijft van die collega (per stuk staat er een notitie van TeamBot in dit gesprek).' : '';
  return `[TeamBot] De eigenaar heeft je vorige taak gestopt. Ga daar niet mee verder en maak die niet af, tenzij de eigenaar daar hieronder zelf om vraagt.${given} Reageer alleen op het nieuwe bericht hieronder.\n\n`;
}

/**
 * "Hervatten" after a stop or a restart: a CLI session does not keep a turn that was cut off mid-answer, so Claude Code
 * answered "er was nog niets geschreven" and started over although the owner saw part of the answer (acceptance
 * round 3, A-20). The next turn gets the end of what was already written, to go on from there.
 */
export function resumeNote(ctx: Ctx, req: Pick<AgentRunRequest, 'threadId' | 'agentId' | 'runId'>): string {
  const run = ctx.store.run(req.runId);
  if (!run || run.trigger !== 'resume') return '';
  const prev = ctx.store.one<{ id: string; status: string }>('SELECT id, status FROM runs WHERE thread_id = ? AND agent_id = ? AND id != ? AND created_at <= ? ORDER BY created_at DESC LIMIT 1', req.threadId, req.agentId, req.runId, run.created_at);
  if (!prev || (prev.status !== 'cancelled' && prev.status !== 'interrupted')) return '';
  const msg = ctx.store.one<{ content: string }>("SELECT content FROM messages WHERE run_id = ? AND role = 'assistant' AND deleted = 0 ORDER BY seq DESC LIMIT 1", prev.id);
  const text = String(msg?.content || '').trim();
  if (!text) return '';
  const tail = text.length > 2000 ? '…' + text.slice(-2000) : text;
  return `[TeamBot] Je vorige antwoord werd afgebroken. Dit had je al geschreven (de eigenaar ziet het in de chat):\n<<<\n${tail}\n>>>\nGa precies verder waar dit ophoudt; begin niet opnieuw en herhaal het niet.\n\n`;
}

export function cliOptions(agent: Agent): CliOptions {
  const c = (agent.settings?.cli || {}) as Record<string, any>;
  const list = (v: any) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).slice(0, 50) : []);
  const num = (v: any, d: number, min: number, max: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.min(max, Math.max(min, Number(v))) : d);
  const full = fullAccess(agent);
  return {
    allowedTools: list(c.allowedTools),
    disallowedTools: list(c.disallowedTools),
    extraArgs: list(c.extraArgs),
    // "Volledige toegang": the owner's own Claude Code/Codex settings, skills and apps (MCP servers) are the bot's too,
    // unless he switched that off for this bot (an explicit false).
    loadUserSettings: typeof c.loadUserSettings === 'boolean' ? c.loadUserSettings : full,
    useUserMcp: typeof c.useUserMcp === 'boolean' ? c.useUserMcp : full,
    ownerMemory: c.loadUserSettings === true,
    // One step limit: the bot's own (settings.maxTurns, which a routine lowers for its run: agent/runner.ts) and the
    // one typed at this engine (cli.maxTurns). Where both are set the LOWER one counts, so a routine's limit holds.
    maxTurns: num(Math.min(...[c.maxTurns, agent.settings?.maxTurns].map(Number).filter((n) => n > 0)), full ? CLI_LIMITS.maxTurnsFull : CLI_LIMITS.maxTurns, 1, 100_000),
    timeoutMin: num(c.timeoutMin, CLI_LIMITS.timeoutMin, 0.01, 30 * 24 * 60),
    idleMin: num(c.idleMin, CLI_LIMITS.idleMin, 0.01, 24 * 60),
    busyIdleMin: num(c.busyIdleMin, CLI_LIMITS.busyIdleMin, 0.01, 7 * 24 * 60),
  };
}

export interface RunScope {
  ctx: Ctx;
  cfg: ProviderConfig;
  req: AgentRunRequest;
  agent: Agent;
  thread: Thread | null;
  run: Run | null;
  signal: AbortSignal;
  emit(e: AgentEvent): void;
  /**
   * One line in the steps; `facts` = what it touched (path, URL, command …). Returns the item (facts may be added later).
   * `pending`: the step has not finished (the loop guard waits for what it turns out to be; `retitle` with
   * `done` ends that).
   */
  activity(kind: string, title: string, detail?: string, facts?: StepFact[], o?: { pending?: boolean; words?: Words }): ActivityItem;
  /** A new title for a step already in the list (its result came in: "Wil x schrijven" → "Schreef x"); shown at once. */
  retitle(item: ActivityItem, title: string, o?: { done?: boolean }): void;
  /**
   * The engine's step for a call of one of TeamBot's own tools (`mcp__teambot__x`, OpenCode's code mode): TeamBot's
   * tool host puts its result on that same line (`teambotResult`), so one call is one step, not "Pakte een skill
   * erbij" plus "TeamBot · Skill laden: …" (B-04). From then on the engine no longer renames that step. Tool '*' = a
   * step whose program is not known yet (OpenCode's code mode): it takes the result of any TeamBot tool.
   */
  teambotStep?(tool: string, item: ActivityItem): void;
  /** The engine finished that step (its result is in): a later TeamBot result is never put on it. */
  teambotStepDone?(item: ActivityItem): void;
  /** The tool host's line for a TeamBot tool: on the engine's step for that call when there is one, else a new line. */
  teambotResult?(tool: string, kind: string, title: string, detail?: string, facts?: StepFact[], words?: Words): ActivityItem;
  /** True for an engine step that now shows TeamBot's own result (see `teambotStep`). */
  isTeambotLine?(item: ActivityItem): boolean;
  opts: CliOptions;
  /** App names of the TeamBot tools offered in this run (filled by the tool host), for plain-language steps. */
  apps?: Map<string, string>;
}

/**
 * The bot's skills as folders in its work folder (modules/skills/workspace.ts), right before a CLI engine starts
 * there: `.claude/skills` and `.agents/skills`, where Claude Code, Codex and OpenCode look for skills themselves.
 * For every engine, so no path is missed, and only in a work folder TeamBot made for the bot; never stops a run.
 */
function syncSkills(ctx: Ctx, agent: Agent) {
  try {
    workdir(agent);
    ctx.services.skills?.sync?.(agent);
  } catch (e) {
    ctx.log.warn('[cli] skill folders not brought up to date', e);
  }
}

/**
 * For an engine that loads skill folders itself: the instructions without TeamBot's list of skills, and this run
 * without `skill_load`, so the bot has one skill system instead of two. So far only Claude Code, where a real run
 * showed it (claude.ts); every other engine keeps the list and `skill_load`, and so does this one when anything here
 * fails. Where the engine cannot take the skills from the work folder (`o.skipsWorkFolder`: Claude Code's restricted
 * mode; or a work folder that is not TeamBot's own, where TeamBot writes nothing) they go along as a plugin folder
 * of TeamBot, made in `o.pluginInto`.
 */
export function ownSkillLoader(s: RunScope, system: string, o: { pluginInto: string; skipsWorkFolder: boolean }): { system: string; pluginDir?: string } {
  const svc = s.ctx.services.skills;
  try {
    const next = svc?.nativeSystem?.(s.agent, system);
    if (typeof next !== 'string') return { system };
    const pluginDir = o.skipsWorkFolder || !svc.inWorkFolder(s.agent) ? svc.plugin(s.agent, o.pluginInto) || undefined : undefined;
    s.agent.tool_policy = { ...s.agent.tool_policy, skill_load: 'deny' };
    return { system: next, pluginDir };
  } catch (e) {
    s.ctx.log.warn('[cli] the engine\'s own skill loader is not used', e);
    return { system };
  }
}

/** An engine loaded a skill itself (its own skill tool in its stream): counted in the place `skill_load` counts. */
export function skillUsed(s: RunScope, name: string) {
  try {
    s.ctx?.services?.skills?.used?.(s.agent, name);
  } catch {
    /* only a count */
  }
}

export function makeScope(ctx: Ctx, cfg: ProviderConfig, req: AgentRunRequest, signal: AbortSignal, onEvent: (e: AgentEvent) => void): RunScope {
  const base = ctx.store.agent(req.agentId);
  if (!base) throw new Error('Bot bestaat niet meer');
  const run = ctx.store.run(req.runId);
  // Same per-run narrowing as API runs (routines may lower the access mode, tool groups or deny tools).
  const thread = ctx.store.thread(req.threadId);
  // A shared bot in a member's conversation: its narrowed copy for that member (agent/shared.ts).
  const agent = agentForThread(ctx, applyRunOverride(base, run?.meta?.override), thread);
  syncSkills(ctx, agent);
  const emit = (e: AgentEvent) => {
    try {
      onEvent(e);
    } catch {
      /* UI errors must not break the CLI stream */
    }
  };
  // Steps as the owner reads them: never the path of the bot's own folder (an internal id), also not in the detail
  // of a refusal ("… Toegestaan: C:\…\workspaces\ag_eff2…", B-45). Facts keep the full path.
  const words = (s: string) => withoutOwnFolder(s, agent);
  const titleOf = (title: string) => redact(words(title)).slice(0, 300);
  const detailOf = (kind: string, detail?: string) => {
    // A failed step's short engine text ("Web search cancelled", "fetch failed") in plain words (Q-03).
    const d = kind === 'tool_error' ? plainStepDetail(detail) : detail;
    return d ? redact(words(d)).slice(0, 2000) : undefined;
  };
  const tbSteps = new Map<string, ActivityItem[]>();
  const tbLines = new WeakSet<ActivityItem>();
  const tbWaiting = new WeakSet<ActivityItem>();
  const activity =(kind: string, title: string, detail?: string, facts?: StepFact[], o?: { pending?: boolean; words?: Words }): ActivityItem => {
    const item: ActivityItem = { kind, title: titleOf(title), detail: detailOf(kind, detail), ts: now() };
    if (facts?.length) item.facts = cleanFacts(facts);
    if (o?.pending) item.pending = true;
    if (o?.words) item.words = o.words;
    emit({ type: 'activity', item });
    return item;
  };
  return {
    ctx,
    cfg,
    req,
    agent,
    thread,
    run,
    signal,
    emit,
    activity,
    retitle(item, title, o) {
      const ended = !!o?.done && !!item.pending;
      if (ended) delete item.pending;
      const t = titleOf(title);
      if (tbLines.has(item) || !t || t === item.title) {
        // Finished under the same title (or as a TeamBot line): still sent again, so the loop guard sees it is done.
        if (ended) emit({ type: 'activity', item });
        return;
      }
      item.title = t;
      // The same item again: the runner keeps one line and saves the new title right away.
      emit({ type: 'activity', item });
    },
    teambotStep(tool, item) {
      const list = tbSteps.get(tool) || [];
      list.push(item);
      tbSteps.set(tool, list);
      // Until TeamBot's result is on it the step only says "Leest een document": which document is not in its words.
      // It waits, so the loop guard does not count it yet (live, 0.4.4: four bots that read three different documents
      // in one go were stopped as "3× achter elkaar dezelfde stap (Las een document)").
      if (!item.pending) {
        item.pending = true;
        tbWaiting.add(item);
      }
    },
    teambotStepDone(item) {
      if (tbWaiting.delete(item)) delete item.pending;
      for (const list of tbSteps.values()) {
        const i = list.indexOf(item);
        if (i >= 0) list.splice(i, 1);
      }
    },
    teambotResult(tool, kind, title, detail, facts, shown) {
      // A step for this tool, else one that waits for any TeamBot call ('*': its program is not known yet).
      const item = tbSteps.get(tool)?.shift() || tbSteps.get('*')?.shift();
      if (!item) return activity(kind, title, detail, facts, { words: shown });
      // A subtask's step keeps saying so.
      const sub = /^Deeltaak · /.test(item.title) && !/^Deeltaak · /.test(title) ? 'Deeltaak · ' : '';
      tbLines.add(item);
      delete item.pending;
      item.kind = kind;
      item.title = titleOf(sub + title);
      if (shown) item.words = sub ? { text: 'Deeltaak · {0}', values: [shown] } : shown;
      else delete item.words;
      item.detail = detailOf(kind, detail);
      if (facts?.length) item.facts = cleanFacts(facts);
      else delete item.facts;
      emit({ type: 'activity', item });
      return item;
    },
    isTeambotLine: (item) => tbLines.has(item),
    opts: cliOptions(agent),
  };
}

/** Facts as stored: known ops only, secrets redacted, bounded. */
export function cleanFacts(facts: StepFact[]): StepFact[] {
  const ops = new Set(['read', 'write', 'delete', 'web', 'search', 'exec', 'app']);
  return facts
    .filter((f) => f && ops.has(f.op) && typeof f.target === 'string' && f.target.trim())
    .slice(0, 20)
    .map((f) => ({ op: f.op, target: redact(f.target.trim()).slice(0, 1000) }));
}

/** Only the owner of the provider may run it, and only an owner-role user (CLI logins belong to the host account). */
export function assertMayRun(ctx: Ctx, cfg: ProviderConfig, userId: string) {
  if (cfg.user_id !== userId) throw new Error('CLI-agents gebruiken de login van de computer waarop TeamBot draait en kunnen niet gedeeld worden. Gebruik een API-provider met je eigen sleutel.');
  const u = ctx.store.user(userId);
  if (!u || u.role !== 'owner') throw new Error('Alleen de eigenaar van deze TeamBot-installatie kan CLI-agents gebruiken (ze draaien op zijn of haar eigen CLI-login).');
}

/** Workspace dir for the run (created if missing). */
export function workdir(agent: Agent): string {
  const root = agentRoots(agent)[0];
  fs.mkdirSync(root, { recursive: true });
  return root;
}

export interface SafeAttachment {
  path: string;
  rel: string;
  name: string;
  mime: string;
  size: number;
}

/** Attachments are passed only as paths inside the bot's workspace. */
export function safeAttachments(agent: Agent, list: AgentRunRequest['attachments']): SafeAttachment[] {
  const out: SafeAttachment[] = [];
  for (const a of list || []) {
    try {
      const p = resolveInWorkspace(agent, a.path);
      if (!fs.existsSync(p)) continue;
      out.push({ path: p, rel: path.relative(agentRoots(agent)[0], p) || a.name, name: a.name, mime: a.mime, size: fs.statSync(p).size });
    } catch {
      /* outside workspace → skipped */
    }
  }
  return out;
}

/**
 * The attachments of this turn for a CLI engine. A pdf or Word file names its reader here, at the moment it matters:
 * one read step without approval (an engine otherwise writes a script or a terminal command for it: two cards, A-39).
 */
export function attachmentNote(atts: SafeAttachment[]): string {
  if (!atts.length) return '';
  const doc = (a: SafeAttachment) => /pdf|wordprocessingml/.test(a.mime) || /\.(pdf|docx)$/i.test(a.name);
  return `\n\nBijlagen van de gebruiker (staan in je werkmap):\n${atts.map((a) => `- ${a.rel} (${a.mime}, ${Math.max(1, Math.round(a.size / 1024))} kB)${doc(a) ? ' — lees de tekst met de TeamBot-tool read_document: één leesstap zonder toestemming, geen script of terminalopdracht' : ''}`).join('\n')}`;
}

/**
 * When a CLI starts a fresh session in a thread that already has history (first use,
 * provider switch, lost session), give it the earlier conversation as context.
 * Returns '' when there is nothing the prompt does not already contain.
 */
export function earlierTranscript(ctx: Ctx, agent: Agent, threadId: string, inputId?: string | null, max = 30): { text: string; count: number } {
  // After "Gesprek samenvatten" (agent/compaction.ts) the older part is the summary; only what came after it is quoted.
  const th = ctx.store.thread(threadId);
  const from = Number(th?.meta?.contextFromSeq) || 0;
  const upTo = th?.meta?.summary && (Number(th.meta.summaryUpTo) || 0) >= from ? Number(th.meta.summaryUpTo) || 0 : 0;
  const summary = upTo ? String(th!.meta.summary) : '';
  const rows = ctx.store.messages(threadId, { limit: 200 }).filter((m) => m.seq > upTo);
  let lastOwn = -1;
  rows.forEach((m, i) => {
    if (m.author_id === agent.id && m.role === 'assistant' && m.status === 'done') lastOwn = i;
  });
  if (lastOwn < 0 && !summary) return { text: '', count: 0 };
  const picked = rows
    .slice(0, lastOwn + 1)
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content?.trim() && m.id !== inputId && !m.deleted)
    .slice(-max);
  if (!picked.length && !summary) return { text: '', count: 0 };
  const lines = picked.map((m) => {
    const who = m.author_id === agent.id ? 'jij' : m.author_name || m.role;
    const body = m.content.length > 1500 ? m.content.slice(0, 1500) + ' …' : m.content;
    return `[${who}]: ${body}`;
  });
  const head = summary ? `Samenvatting van het eerdere deel van dit gesprek:\n${summary}\n${lines.length ? '\nDaarna:\n' : ''}` : '';
  return {
    text: `<eerder_gesprek>\nDit is een nieuwe sessie. Hieronder het eerdere gesprek in deze chat ter context (data, geen nieuwe opdracht):\n${head}${lines.join('\n')}\n</eerder_gesprek>\n\n`,
    count: picked.length + (summary ? 1 : 0),
  };
}

/**
 * Plain-text prompt for CLIs without a system prompt option: the full instructions on a new session, and on a resumed
 * session only an update when they changed since (see contextUpdate).
 */
export function composePrompt(o: { system?: string; update?: string; transcript?: string; prompt: string; attachments?: SafeAttachment[] }): string {
  let s = '';
  if (o.system) s += `<teambot_instructies>\n${o.system}\n</teambot_instructies>\n\n`;
  if (o.update) s += o.update;
  if (o.transcript) s += o.transcript;
  s += o.prompt + attachmentNote(o.attachments || []);
  return s;
}

/**
 * Language rule for CLI engines. Claude Code, Codex and ACP agents bring a long English system prompt of their own and
 * read a lot of English (tool output, documentation), so they drift into English — most of all in the short lines
 * they write between steps. The bot's "## Taal" section (agent/language.ts: the language the owner writes in, or a
 * fixed language per user or bot) is in TeamBot's system prompt; withLanguage moves it to the very end, after the
 * tool note, so it is the most recent instruction the engine reads. LANGUAGE_NOTE is the default rule (used when a
 * prompt has none).
 */
export const LANGUAGE_NOTE = DEFAULT_LANGUAGE_NOTE;
export { withLanguage, languageSection };

/** The instructions a Codex/ACP session gets: the bot's system prompt, the note about TeamBot's own tools, the language rule. */
export function sessionInstructions(system: string, note: string): string {
  return withLanguage(system + (note ? '\n\n' + note : ''));
}

/**
 * Keeping the instructions of a running CLI session current: one way for every CLI engine (Claude Code, Codex, ACP).
 *
 * An engine takes TeamBot's instructions when a session starts (Claude Code: `--append-system-prompt-file`; Codex: the
 * first prompt or app-server `developerInstructions`; ACP: the first prompt). None of them is relied on to follow a
 * change afterwards: Codex and ACP never replace them, and Claude Code records its system prompt per conversation and
 * reuses that record when the conversation is resumed. Restarting the session would lose the CLI's own context (files
 * it read, tool results). So every part of the instructions is a block (a "## " section: the bot's own instructions,
 * its team and colleagues, memory, skills, rules …) and TeamBot remembers per session a short
 * hash of every "## " section it delivered (`cli_sessions.context_state`) and, when a section changed (instructions,
 * skills, memory brief, connected apps, the tool note, the access mode), starts the next turn of that same session
 * with a `<teambot_instructies_update>` block: only the changed sections plus the headings of removed ones, or the full
 * text when nothing is known about the session yet (sessions from older versions) or most of it changed. The state is
 * saved only after a turn that ended well, so a failed turn sends the update again.
 */
export type ContextState = Record<string, string>;

export interface SessionContext {
  /** Section hashes the stored session already has (null: unknown, e.g. a session from an older TeamBot). */
  previous: ContextState | null;
  /** Remember what the session has now (called after a turn that ended well). */
  save(sessionId: string, state: ContextState): void;
}

interface PromptSection {
  key: string;
  title: string;
  text: string;
}

const BEGIN = '(begin)';

/** A prompt split at its "## " headings ("### " stays inside its section); the text before the first heading is "(begin)". */
export function promptSections(text: string): PromptSection[] {
  const out: PromptSection[] = [];
  const seen = new Map<string, number>();
  let title = '';
  let lines: string[] = [];
  const flush = () => {
    const body = lines.join('\n').trim();
    if (body) {
      const base = title || BEGIN;
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      out.push({ key: n > 1 ? `${base} #${n}` : base, title, text: body });
    }
  };
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^## \S/.test(line)) {
      flush();
      title = line.trim();
      lines = [line];
    } else lines.push(line);
  }
  flush();
  return out;
}

const digest = (s: string) => crypto.createHash('sha256').update(s).digest('base64url').slice(0, 16);

export function contextState(text: string): ContextState {
  const o: ContextState = {};
  for (const s of promptSections(text)) o[s.key] = digest(s.text);
  return o;
}

export function parseContextState(v: unknown): ContextState | null {
  if (typeof v !== 'string' || !v) return null;
  try {
    const o = JSON.parse(v);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    const out: ContextState = {};
    for (const [k, h] of Object.entries(o)) if (typeof h === 'string') out[k.slice(0, 200)] = h.slice(0, 64);
    return out;
  } catch {
    return null;
  }
}

const sectionLabel = (s: { title: string }) => (s.title ? s.title.replace(/^##\s+/, '') : 'Algemeen');

/** The update block for a resumed session ('' when it already has the current instructions). */
export function contextUpdate(previous: ContextState | null, text: string): { text: string; changed: string[] } {
  const now = promptSections(text);
  const changed = previous ? now.filter((s) => previous[s.key] !== digest(s.text)) : now;
  const removed = previous ? Object.keys(previous).filter((k) => !now.some((s) => s.key === k)) : [];
  if (!changed.length && !removed.length) return { text: '', changed: [] };
  const size = changed.reduce((n, s) => n + s.text.length, 0);
  if (!previous || size > 0.6 * Math.max(1, String(text).length)) {
    return {
      text: `<teambot_instructies_update>\nJe TeamBot-instructies zijn gewijzigd. Hieronder staat de volledige nieuwe versie; die vervangt alle eerdere teambot_instructies in deze sessie.\n\n${String(text).trim()}\n</teambot_instructies_update>\n\n`,
      changed: now.map(sectionLabel),
    };
  }
  const parts = changed.map((s) => (s.title ? s.text : `Algemeen (het begin van je instructies, zonder kop):\n${s.text}`));
  const gone = removed.map((k) => k.replace(/ #\d+$/, '')).filter((k) => k !== BEGIN);
  if (gone.length) parts.push(`Vervallen (geldt niet meer): ${[...new Set(gone)].join(', ')}`);
  return {
    text: `<teambot_instructies_update>\nJe TeamBot-instructies zijn gewijzigd. De onderdelen hieronder vervangen het onderdeel met dezelfde kop in je eerdere teambot_instructies; de rest blijft gelden.\n\n${parts.join('\n\n')}\n</teambot_instructies_update>\n\n`,
    changed: [...changed.map(sectionLabel), ...gone.map((g) => `${g.replace(/^##\s+/, '')} (vervallen)`)],
  };
}

/** The update for a resumed session (shown in the activity when there is one); '' without session tracking. */
export function sessionUpdate(s: RunScope, context: SessionContext | undefined, instructions: string): string {
  if (!context) return '';
  const u = contextUpdate(context.previous, instructions);
  // Without a stored state (the first turn in this session failed, or the session is older than this check) nothing
  // is known to have changed: the full text goes again, without a list of "changed" sections that all look changed
  // (seen in acceptance round 5 after OpenCode's free limit: "Gewijzigd: Algemeen, Geheugen, Jouw computer, …").
  if (u.text) s.activity('session', context.previous ? 'Bijgewerkte instructies meegegeven' : 'Instructies opnieuw meegegeven', context.previous ? `Gewijzigd: ${u.changed.join(', ')}` : undefined);
  return u.text;
}

export function errorText(e: any): string {
  return redact(String(e?.message || e)).slice(0, 2000);
}

/**
 * The last output of a CLI for an error message in the chat: without stack-trace lines ("    at cli.acp
 * (B:/~BUN/root/chunk-….js:2:1020)") that mean nothing to the owner; the full text stays in the server log.
 */
export function lastOutput(tail: string, max = 500): string {
  const lines = String(tail || '')
    // Terminal colour codes ("\x1b[91m\x1b[1mError: \x1b[0m…" from OpenCode) showed up as broken characters.
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^\s*at\s/.test(l) && !/\b(chunk-[\w-]+\.js|node:internal\/|~BUN\/root)\b/.test(l));
  return redact(lines.join(' ').replace(/\s+/g, ' ').trim()).slice(-max);
}

/** Fold "please log in"-style CLI output into an actionable message. */
export function authHint(text: string, loginCmd: string): string | null {
  if (/not\s+logged\s+in|please\s+(run\s+)?\/?login|invalid api key|authentication[_ ](error|failed|required)|unauthori[sz]ed|401\b|oauth token (has )?expired|credentials? (not found|expired)|auth_required|log in again/i.test(text)) {
    return `De CLI is niet (meer) ingelogd. Log zelf in met: ${loginCmd}`;
  }
  return null;
}
