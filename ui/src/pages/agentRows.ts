/**
 * The bot page per kind of AI: which rows work on the AI a bot uses now. A row that cannot work there is not shown
 * (never greyed out with an explanation); the same thing has the same row and the same words on every AI that has it.
 * No imports from React, so it is unit-tested directly (tests/agent-rows.test.ts).
 *
 * The five kinds, and what runs the bot's turn on each:
 *  - `api`    a model through an API key: TeamBot's own tool loop (server/agent/chat-loop.ts);
 *  - `local`  a model on this computer (Ollama, LM Studio, llama.cpp …): the same loop;
 *  - `claude` Claude Code (server/modules/cli-agents/claude.ts);
 *  - `codex`  Codex (server/modules/cli-agents/codex.ts);
 *  - `acp`    a program that speaks ACP: OpenCode, Gemini CLI, Copilot CLI, an own ACP agent (cli-agents/acp.ts).
 *
 * What decides a row is in the server's code; the place is named at each row below.
 */
import { accessUnsupported } from '../lib/access.js';
import { LOCAL_KINDS } from './newbot/choices.js';

export type AiKind = 'api' | 'local' | 'claude' | 'codex' | 'acp';

/** What the page knows of an AI (a ProviderView has all of it). */
export interface AiFacts {
  id?: string;
  type: 'api' | 'cli';
  kind: string;
  billing?: string | null;
}

export function aiKind(p: AiFacts | null | undefined): AiKind {
  if (!p) return 'api';
  if (p.type === 'cli') return p.kind === 'claude-code' ? 'claude' : p.kind === 'codex-cli' ? 'codex' : 'acp';
  return p.billing === 'local' || LOCAL_KINDS.has(p.kind) ? 'local' : 'api';
}

/**
 * Extra flags a program accepts from TeamBot (mirrors `extraArgs` in server/modules/cli-agents/catalog.ts). A program
 * that is not listed accepts none: any flag stops its turn with "Extra argument niet toegestaan".
 */
export const EXTRA_ARGS: Record<string, string[]> = {
  'claude-code': ['--fallback-model <model>', '--max-budget-usd <usd>', '--agent <agent>', '--autocompact <auto|tokens>', '--exclude-dynamic-system-prompt-sections'],
  'codex-cli': ['--oss', '--local-provider <lmstudio|ollama>', '--profile <naam>'],
  'gemini-cli': ['--sandbox'],
  'copilot-cli': ['--effort <low|medium|high|xhigh>'],
};

/** Programs that can answer one loose question (server/modules/cli-agents/complete.ts): Claude Code, Codex, OpenCode. */
const SHORT_CALL = new Set(['claude-code', 'codex-cli', 'opencode']);

export type RowId =
  | 'chat' // the level "Alleen chat"
  | 'steer' // "Bijsturen" while the bot works
  | 'reasoning' // the thinking level
  | 'steps' // at most so many steps in one turn
  | 'time' // at most so long for one turn
  | 'silence' // stop after so long without a sign of life
  | 'ownApps' // the program's own MCP servers and apps
  | 'ownSettings' // the owner's own settings files of the program
  | 'alwaysAllow' // steps of the program that never ask
  | 'alwaysDeny' // steps of the program that are always refused
  | 'extraArgs' // extra flags for the program
  | 'contextWindow' // the context window of a local model
  | 'writeInstructions' // "Laat AI de instructies schrijven"
  | 'loopIdle'; // "Stappen zonder iets nieuws" of the loop guard

const ROWS: Record<RowId, (k: AiKind, p: AiFacts | null | undefined, o: { access?: string }) => boolean> = {
  // TeamBot's loop lists no tools at this level (server/tools/registry.ts) and Claude Code starts with `--tools ""`
  // (claude.ts); Codex and an ACP program cannot be held to it and refuse every turn (codex.ts runCodex, acp.ts runAcp).
  // The rule itself is lib/access.ts.
  chat: (_k, p) => !accessUnsupported('chat', p || undefined),
  // Only TeamBot's own loop reads a new message between two steps; for a program the message goes to the front of the
  // queue (server/agent/queue.ts submit).
  steer: (k) => k === 'api' || k === 'local',
  // Sent with each model call (chat-loop.ts), `--effort` (claude.ts), `model_reasoning_effort` (codex.ts). An ACP
  // program is started with the model only (cli-agents/index.ts acpLaunch): it never gets a level.
  reasoning: (k) => k !== 'acp',
  // The loop's own limit (settings.maxTurns, server/agent/loops.ts maxSteps) and Claude Code's `--max-turns`
  // (cli-agents/context.ts cliOptions: the lower of settings.maxTurns and settings.cli.maxTurns). Codex and ACP
  // programs have no step limit.
  steps: (k) => k === 'api' || k === 'local' || k === 'claude',
  // The run of a program is ended after settings.cli.timeoutMin, and after settings.cli.idleMin without output
  // (claude.ts, codex.ts, acp.ts → proc.ts). A model call of TeamBot's own loop has no clock of its own.
  time: (k) => k === 'claude' || k === 'codex' || k === 'acp',
  silence: (k) => k === 'claude' || k === 'codex' || k === 'acp',
  // settings.cli.useUserMcp: `--strict-mcp-config` when off (claude.ts), the owner's servers and features off
  // (codex.ts codexIsolation). An ACP program only ever gets TeamBot's own server.
  ownApps: (k) => k === 'claude' || k === 'codex',
  // settings.cli.loadUserSettings, allowedTools, disallowedTools: Claude Code only (claude.ts). Allowed rules are
  // only passed on at "Vraagt toestemming" and "Automatisch".
  ownSettings: (k) => k === 'claude',
  alwaysAllow: (k, _p, o) => k === 'claude' && (o.access === 'ask' || o.access === 'auto'),
  alwaysDeny: (k) => k === 'claude',
  extraArgs: (k, p) => k !== 'api' && k !== 'local' && !!p && !!EXTRA_ARGS[p.kind],
  // PUT /providers/:id/context-window takes Ollama (num_ctx per chat) and LM Studio (reloads the model) only
  // (server/api/providers.ts, server/providers/localmodels.ts).
  contextWindow: (_k, p) => p?.kind === 'ollama' || p?.kind === 'lmstudio',
  // POST /agents/generate: any API or local model, and the programs that can answer one loose question.
  writeInstructions: (k, p) => k === 'api' || k === 'local' || (!!p && SHORT_CALL.has(p.kind)),
  // Steps in a row without anything new: only TeamBot's own loop counts them (server/agent/loops.ts LoopGuard.endStep,
  // chat-loop.ts). A program's steps are watched for the same step done again only (CliLoopWatch: `repeat`).
  loopIdle: (k) => k === 'api' || k === 'local',
};

/** Does this row work on this AI? (`access`: the bot's level, for a row that only counts at some levels.) */
export function rowWorks(row: RowId, p: AiFacts | null | undefined, o: { access?: string } = {}): boolean {
  return ROWS[row](aiKind(p), p, o);
}

// ---------------------------------------------------------------- "Wat mag de bot?"

export type AccessLevel = 'chat' | 'readonly' | 'ask' | 'auto' | 'full';
export const ACCESS_LEVELS: AccessLevel[] = ['chat', 'readonly', 'ask', 'auto', 'full'];

/** The levels this AI can be held to. */
export function accessLevels(p: AiFacts | null | undefined): AccessLevel[] {
  return ACCESS_LEVELS.filter((l) => l !== 'chat' || rowWorks('chat', p));
}

/** The level to use on this AI for a level it cannot be held to: the nearest one that works ("Alleen lezen" for "Alleen chat"). */
export function accessOn(p: AiFacts | null | undefined, level: string | undefined): AccessLevel {
  const ok = accessLevels(p);
  if (ok.includes(level as AccessLevel)) return level as AccessLevel;
  return level === 'chat' ? 'readonly' : 'ask';
}

/**
 * What a level means when a program runs the turn, where that differs from TeamBot's own loop (the program keeps its
 * own tools; TeamBot decides what it is asked). One line, shown under the choice.
 */
const ACCESS_ON_PROGRAM: Record<'claude' | 'codex' | 'acp', Partial<Record<AccessLevel, string>>> = {
  claude: {
    chat: 'Praat alleen: Claude Code draait zonder tools.',
    readonly: 'Mag lezen en zoeken, niets wijzigen; er kan niets worden goedgekeurd.',
    ask: 'Elke stap waarvoor Claude Code toestemming nodig heeft, komt eerst bij jou.',
    auto: 'Werkt zelf door; pushen, publiceren, verwijderen en verzenden vraagt het eerst.',
    full: 'Werkt zonder te vragen op je hele computer; versturen naar anderen en betalen vragen wel. Alleen voor bots die je vertrouwt.',
  },
  codex: {
    readonly: 'Mag lezen, niets wijzigen; er kan niets worden goedgekeurd.',
    ask: 'Mag lezen; schrijven en het netwerk op alleen na jouw akkoord.',
    auto: 'Mag schrijven in de mappen van de bot, zonder netwerk. Wat meer nodig heeft, wordt geweigerd.',
    full: 'Mag schrijven en het netwerk op zonder te vragen. Alleen voor bots die je vertrouwt.',
  },
  acp: {
    readonly: 'Mag lezen en zoeken; schrijven wordt geweigerd.',
    ask: 'Elk verzoek om toestemming van het programma komt eerst bij jou.',
    auto: 'Werkt zelf door; wat impact heeft, vraagt het eerst.',
    full: 'Werkt zonder te vragen; versturen naar anderen en betalen vragen wel. Alleen voor bots die je vertrouwt.',
  },
};

/** The line under "Wat mag de bot?" for this level on this AI; '' = the general line of the level. */
export function accessLine(p: AiFacts | null | undefined, level: string | undefined): string {
  const k = aiKind(p);
  return k === 'api' || k === 'local' ? '' : ACCESS_ON_PROGRAM[k][level as AccessLevel] || '';
}

/**
 * Whether TeamBot guards the hard blocks (key files, closed folders) at a level on the bot's AI, as the server says it
 * for any AI and level. Absent = nothing is known, and nothing is said.
 */
export interface LevelGuard {
  guarded: boolean;
  text: string;
}

/** One calm line under "Wat mag de bot?" where TeamBot cannot guard the hard blocks at this level on this AI; '' elsewhere. */
export function guardLine(guards: Partial<Record<string, LevelGuard>> | null | undefined, level: string | undefined): string {
  const g = level && guards && typeof guards === 'object' ? guards[level] : undefined;
  return g && g.guarded === false && typeof g.text === 'string' ? g.text.trim() : '';
}

// ---------------------------------------------------------------- "Als de bot bezig is"

/** The choice that is in view for a stored policy: "Bijsturen" on a program is what it does there, the queue. */
export function busyShown(p: AiFacts | null | undefined, policy: string | undefined): 'queue' | 'steer' | 'interrupt' {
  if (policy === 'interrupt') return 'interrupt';
  return policy === 'steer' && rowWorks('steer', p) ? 'steer' : 'queue';
}

// ---------------------------------------------------------------- "Hoe lang mag een beurt duren"

const positive = (v: unknown): number | undefined => (Number(v) > 0 ? Number(v) : undefined);

/**
 * The step limit that counts on this AI: the bot's own (settings.maxTurns), and for Claude Code the lower of that and
 * the one typed at the program before there was one row for it (settings.cli.maxTurns).
 */
export function stepsOf(settings: Record<string, any> | undefined, p: AiFacts | null | undefined): number | undefined {
  const own = positive(settings?.maxTurns);
  const old = aiKind(p) === 'claude' ? positive(settings?.cli?.maxTurns) : undefined;
  return own && old ? Math.min(own, old) : (own ?? old);
}

/** One step limit for the bot: stored as settings.maxTurns (every AI with a step limit reads it); the old one goes. */
export function withSteps(settings: Record<string, any> | undefined, steps: number | undefined): Record<string, any> {
  const out: Record<string, any> = { ...(settings || {}) };
  if (steps && steps > 0) out.maxTurns = steps;
  else delete out.maxTurns;
  if (out.cli && typeof out.cli === 'object' && 'maxTurns' in out.cli) {
    const { maxTurns: _old, ...cli } = out.cli;
    out.cli = cli;
  }
  return out;
}

// ---------------------------------------------------------------- another AI for the bot

interface Kept {
  /** The level chosen on an AI that could be held to it, while the bot is on one that cannot. */
  access?: string;
  /** The model the bot had on each AI it was on (by provider id). */
  models?: Record<string, string>;
  /** The extra flags per program (by kind): another program would refuse them. */
  extraArgs?: Record<string, string[]>;
}

/**
 * The bot gets another AI. What does not apply to the new one is kept, out of view, for when the bot goes back:
 *  - a value that is simply not read there stays where it is (the thinking level, the limits of a turn, the
 *    program's own rules): the page does not show its row;
 *  - a value that would break the new AI is put aside in `settings.kept` and comes back with the AI it belongs to:
 *    the level "Alleen chat" (the bot gets "Alleen lezen" meanwhile), the model, and a program's extra flags.
 * Returns the change for the bot (provider, model, level, settings). `model`: the model chosen with the new AI (the
 * chat's model switcher picks both at once); left out, the bot gets the model it had there before.
 */
export function switchAi(
  bot: BotAi,
  from: AiFacts | null | undefined,
  to: AiFacts | null | undefined,
  chosen?: string,
): { provider_id: string | null; model: string; access_mode: AccessLevel; settings: Record<string, any> } {
  const settings: Record<string, any> = { ...(bot.settings || {}) };
  const kept: Kept = { ...(settings.kept || {}) };
  let cli: Record<string, any> = { ...(settings.cli || {}) };
  const fromId = from?.id || bot.provider_id || '';
  const toId = to?.id || '';

  // The model: each AI has its own.
  const models = { ...(kept.models || {}) };
  if (bot.model && fromId) models[fromId] = bot.model;
  const model = chosen ?? ((toId && models[toId]) || '');
  if (toId) delete models[toId];
  kept.models = models;

  // Extra flags: each program has its own list of flags it accepts.
  const args = { ...(kept.extraArgs || {}) };
  if (Array.isArray(cli.extraArgs) && cli.extraArgs.length) args[from?.kind || ''] = cli.extraArgs;
  const mine = to && rowWorks('extraArgs', to) ? args[to.kind] : undefined;
  if (to) delete args[to.kind];
  if (mine?.length) cli.extraArgs = mine;
  else delete cli.extraArgs;
  kept.extraArgs = args;

  // The step limit: one for the bot (the one typed at Claude Code becomes the bot's).
  let next = settings;
  if (aiKind(from) === 'claude' && positive(cli.maxTurns)) {
    next = withSteps({ ...settings, cli }, stepsOf({ ...settings, cli }, from));
    cli = { ...(next.cli || {}) };
  }

  // The level: back to the one chosen before when the new AI can be held to it, else the nearest that works.
  let access = bot.access_mode || 'ask';
  if (kept.access && accessLevels(to).includes(kept.access as AccessLevel)) {
    access = kept.access;
    delete kept.access;
  } else if (!accessLevels(to).includes(access as AccessLevel)) {
    kept.access = kept.access || access;
    access = accessOn(to, access);
  }

  const out: Record<string, any> = { ...next };
  if (Object.keys(cli).length) out.cli = cli;
  else delete out.cli;
  for (const k of ['models', 'extraArgs'] as const) if (!Object.keys(kept[k] || {}).length) delete kept[k];
  if (Object.keys(kept).length) out.kept = kept;
  else delete out.kept;
  return { provider_id: to?.id || null, model, access_mode: access as AccessLevel, settings: out };
}

/** What a bot has of its AI (an Agent has all of it). */
export interface BotAi {
  provider_id?: string | null;
  model?: string | null;
  access_mode?: string;
  settings?: Record<string, any>;
}

/**
 * A pick of AI and model wherever it is made (the bot page, the chat's model switcher): the change to save on the bot.
 * The same AI: only the model. Another AI: as switchAi, so what does not apply there is put aside the same way
 * everywhere, with the picked model.
 */
export function aiPick(
  bot: BotAi,
  providers: readonly AiFacts[],
  pick: { provider_id: string; model: string },
): { provider_id: string; model: string } | { provider_id: string | null; model: string; access_mode: AccessLevel; settings: Record<string, any> } {
  if ((bot.provider_id || '') === pick.provider_id) return { provider_id: pick.provider_id, model: pick.model };
  const find = (id: string | null | undefined) => (id ? providers.find((p) => p.id === id) : undefined);
  return switchAi(bot, find(bot.provider_id), find(pick.provider_id) || { id: pick.provider_id, type: 'api', kind: '' }, pick.model);
}

/** The owner chose a level himself: the one put aside at an AI switch is no longer what he wants back. */
export function withoutKeptAccess(settings: Record<string, any> | undefined): Record<string, any> {
  const out: Record<string, any> = { ...(settings || {}) };
  if (!out.kept || typeof out.kept !== 'object') return out;
  const { access: _a, ...kept } = out.kept;
  if (Object.keys(kept).length) out.kept = kept;
  else delete out.kept;
  return out;
}

// ---------------------------------------------------------------- "Niet opgeslagen"

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const TURN_KEYS = ['timeoutMin', 'idleMin', 'maxTurns'];

/** Which of the two rows about the program hold unsaved changes: the length of a turn, and the program's own setup. */
export function changedRows(saved: Record<string, any> | undefined, draft: Record<string, any> | undefined): { turn: boolean; program: boolean } {
  const a = saved?.cli || {};
  const b = draft?.cli || {};
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return {
    turn: !same(positive(saved?.maxTurns), positive(draft?.maxTurns)) || TURN_KEYS.some((k) => !same(a[k], b[k])),
    program: keys.some((k) => !TURN_KEYS.includes(k) && !same(a[k], b[k])),
  };
}

/**
 * "What this bot must do", in one spot on its page: its instructions, and right with them what the owner told it in a
 * conversation. Those orders stand in the bot's own Werknotities under this heading (server/modules/memory/pipeline.ts,
 * ORDERS; the bot reads them in every turn); they are edited on the bot's Geheugen page.
 */
export const ORDERS_HEADING = 'Opdrachten van de eigenaar';

/** The lines under "Opdrachten van de eigenaar" in the text of a bot's Werknotities, up to the next heading; '' if none. */
export function ownerOrders(notes: string | null | undefined): string {
  const lines = String(notes || '').split(/\r?\n/);
  const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
  const at = lines.findIndex((l) => heading.exec(l)?.[2].toLowerCase() === ORDERS_HEADING.toLowerCase());
  if (at < 0) return '';
  const level = heading.exec(lines[at])![1].length;
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    const h = heading.exec(l);
    if (h && h[1].length <= level) break;
    out.push(l);
  }
  return out.join('\n').trim();
}
