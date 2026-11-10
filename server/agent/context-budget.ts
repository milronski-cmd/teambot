import type { Agent, ChatMsg, ContentPart, Ctx, Message, Run, Thread, ToolDef, ToolSpec, Usage } from '../core/types.js';
import { CHARS_PER_TOKEN, estimateTokens } from '../core/tokens.js';
import { LOADER_NAME, loaderTool, selectTools, shortKey, specTokens, type Selection } from '../tools/selection.js';

/**
 * Context budget (TeamBot 0.4, package Y: "efficiënter"). Every model call resends the whole context: system prompt,
 * tool definitions, the memory block of every turn, the conversation and every tool output so far. This module
 * measures that per part and keeps it small without losing what matters:
 *
 * 1. Measure: per model call an estimate per part (system, tools, memory/context, conversation, tool output,
 *    attachments), next to the count the engine itself reports afterwards; on the answer (`parts.contextStats`), in the
 *    log and in the side panel. CLI engines: an estimate of what TeamBot hands them.
 * 2. Shorten safely, for every provider (0.3.0 did this only for Ollama, and only when the window was full):
 *    - tool output of older turns is cut to its start and end, with a marker that says so and how to get it back;
 *    - very long runs: big tool output of many steps ago, likewise (milder);
 *    - the same tool call with the same output again is not sent twice;
 *    - attachments and images of older turns: a short note, the file stays in the workspace;
 *    - a very long conversation is cut at a stable point; what falls off (or was summarised by compaction) keeps its
 *      pinned memory rules and the owner's own rules ("vraag eerst …") in a block at the front.
 *    Never touched: the system prompt (instructions, safety rules), the current question and its context, the owner's
 *    own words in the kept part, and the output of tools whose result is the owner's answer or a loaded skill.
 * 3. Fewer tool definitions (tools/selection.ts), with `tools_load` for the rest.
 * 4. Caching stays effective: every change is decided per whole turn (or per block of steps), in steps of a few
 *    turns, so between those moments each call is the previous call plus what was added (append-only). Claude's
 *    thinking blocks are bound to the conversation before them: when something before a block changed since it was
 *    written, the block is left out (history.ts records the key per answer), so the API never refuses the history.
 * 5. Delegated work and bot-to-bot messages get a small history budget of their own.
 * Everything is on by default and can be switched off per bot (settings.contextSaver) or per user (setting).
 */

export interface SaverSettings {
  /** Master switch. Off = exactly the 0.3.0 behaviour. */
  on: boolean;
  /** The newest user turns whose tool output always stays complete. */
  keepTurns: number;
  /** Older turns are shortened in blocks of this many turns (the prompt changes only then: caching). */
  step: number;
  /** Tool output of older turns is cut to about this many characters. */
  oldToolChars: number;
  /** Within the recent turns: the newest tool results that always stay complete … */
  keepSteps: number;
  /** … and older ones are shortened in blocks of this many steps … */
  stepChunk: number;
  /** … to about this many characters (only output that is really big). */
  runToolChars: number;
  /** The same tool call with the same output is not sent twice. */
  duplicates: boolean;
  /** Send only the tool definitions likely needed (with tools_load for the rest). */
  selectTools: boolean;
  /** Tool definitions up to this many tokens are always sent in full. */
  toolTokens: number;
  /** History budget for a delegated task or a bot-to-bot message (tokens). */
  delegationTokens: number;
}

export const SAVER_DEFAULTS: SaverSettings = {
  on: true,
  keepTurns: 2,
  step: 3,
  oldToolChars: 1200,
  keepSteps: 10,
  stepChunk: 5,
  runToolChars: 2500,
  duplicates: true,
  selectTools: true,
  toolTokens: 6000,
  delegationTokens: 12_000,
};

const LIMITS: Partial<Record<keyof SaverSettings, [number, number]>> = {
  keepTurns: [1, 50],
  step: [1, 20],
  oldToolChars: [300, 20_000],
  keepSteps: [2, 200],
  stepChunk: [1, 50],
  runToolChars: [500, 30_000],
  toolTokens: [500, 200_000],
  delegationTokens: [1000, 400_000],
};

function merge(base: SaverSettings, v: any): SaverSettings {
  if (v === false) return { ...base, on: false };
  if (v === true) return { ...base, on: true };
  if (!v || typeof v !== 'object') return base;
  const out: any = { ...base };
  for (const k of Object.keys(base) as (keyof SaverSettings)[]) {
    const x = v[k];
    if (typeof base[k] === 'boolean' && typeof x === 'boolean') out[k] = x;
    else if (typeof base[k] === 'number' && Number.isFinite(Number(x)) && x !== null && x !== '') {
      const [lo, hi] = LIMITS[k] || [0, Number.MAX_SAFE_INTEGER];
      out[k] = Math.min(hi, Math.max(lo, Math.round(Number(x))));
    }
  }
  return out;
}

/** Defaults ← the owner's setting `contextSaver` ← the bot's `settings.contextSaver` (true/false or an object). */
export function saverSettings(ctx: Ctx | null, agent: Agent): SaverSettings {
  let s = SAVER_DEFAULTS;
  try {
    if (ctx) s = merge(s, ctx.store.getSetting<any>(agent.user_id, 'contextSaver', null));
  } catch {
    /* defaults */
  }
  return merge(s, agent.settings?.contextSaver);
}

// ------------------------------------------------------------------ measuring

/** An image costs about this many tokens (a ~1000×1000 screenshot). */
export const IMAGE_TOKENS = 1600;
const IMAGE_CHARS = IMAGE_TOKENS * CHARS_PER_TOKEN;

export interface ContextParts {
  system: number;
  tools: number;
  /** The per-turn context frozen into the user messages: memory block, date, team and skill notes. */
  memory: number;
  /** The conversation itself: messages, answers, tool calls, the summary. */
  history: number;
  toolOutputs: number;
  attachments: number;
}

const CONTEXT_RE = /\n*<context>\n?[\s\S]*?\n?<\/context>/g;
const ATTACH_RE = /<bijlage naam="[^"]*" pad="[^"]*">[\s\S]*?<\/bijlage>/g;

function splitUserText(text: string, p: ContextParts) {
  let rest = text;
  let memory = 0;
  let att = 0;
  rest = rest.replace(CONTEXT_RE, (s) => ((memory += s.length), ''));
  rest = rest.replace(ATTACH_RE, (s) => ((att += s.length), ''));
  p.memory += estimateTokens(memory);
  p.attachments += estimateTokens(att);
  p.history += estimateTokens(rest.length);
}

function assistantChars(m: ChatMsg): number {
  if (m.raw?.provider === 'anthropic' && Array.isArray(m.raw.data)) {
    let n = 0;
    for (const b of m.raw.data) {
      if (b?.type === 'text') n += String(b.text || '').length;
      else if (b?.type === 'thinking') n += String(b.thinking || '').length;
      else if (b?.type === 'tool_use') n += String(b.name || '').length + JSON.stringify(b.input ?? {}).length;
    }
    return n;
  }
  const text = typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
  return text.length + (m.toolCalls?.length ? JSON.stringify(m.toolCalls.map((c) => ({ name: c.name, args: c.args }))).length : 0);
}

/** Estimated tokens per part of one model call, as TeamBot sends it. */
export function measure(system: string, tools: ToolSpec[], messages: ChatMsg[]): ContextParts {
  const p: ContextParts = { system: estimateTokens(system.length), tools: tools.length ? specTokens(tools) : 0, memory: 0, history: 0, toolOutputs: 0, attachments: 0 };
  for (const m of messages) {
    p.history += 4; // role and framing
    if (m.role === 'assistant') p.history += estimateTokens(assistantChars(m));
    else if (m.role === 'tool') {
      if (typeof m.content === 'string') p.toolOutputs += estimateTokens(m.content.length);
      else for (const c of m.content) p.toolOutputs += c.type === 'text' ? estimateTokens(c.text.length) : IMAGE_TOKENS;
    } else if (typeof m.content === 'string') splitUserText(m.content, p);
    else
      for (const c of m.content) {
        if (c.type === 'text') splitUserText(c.text, p);
        else p.attachments += IMAGE_TOKENS;
      }
  }
  return p;
}

export const sumParts = (p: ContextParts) => p.system + p.tools + p.memory + p.history + p.toolOutputs + p.attachments;

// ------------------------------------------------------------------ shortening the history (used by history.ts)

/** One message of the history with what the saver needs to know about it. */
export interface HistItem {
  msg: ChatMsg;
  /** Seq of the stored message (a synthesised tool result: the seq of its call). */
  seq: number;
  /** Stable user-turn number: how many user messages of the thread came up to here. */
  turn: number;
  kind: 'user' | 'assistant' | 'tool' | 'note';
  /** The stored row (not for synthesised results). */
  row?: Message;
  /** Tool results: stable number among this bot's tool results in the thread. */
  toolOrdinal?: number;
  /** Tool results: tool name + arguments (duplicate calls). */
  callKey?: string;
  /** Assistant messages: the key the answer was written under (agent/context-budget, thinking binding). */
  key?: string;
  synthetic?: boolean;
}

export interface HistEdit {
  seq: number;
  kind: 'old' | 'run' | 'dup' | 'att' | 'uimg' | 'img';
}

export interface ShortenResult {
  edits: HistEdit[];
  toolOutputs: number;
  duplicates: number;
  attachments: number;
  images: number;
  savedChars: number;
}

/** Tools whose result is the owner's own answer, a memory fact or loaded instructions: never shortened. */
const NEVER_SHORTEN = new Set(['ask_user', 'ask_form', 'memory_get', 'memory_search', 'dossier_get', 'dossier_search', 'skill_load', 'skill_read_file', 'plan_update', 'notify_user', LOADER_NAME]);
const OLD_MIN = 2000;
const RUN_MIN = 6000;
const DUP_MIN = 800;
const ATT_MIN = 3000;

const textParts = (c: string | ContentPart[]) => (typeof c === 'string' ? c : c.filter((p) => p.type === 'text').map((p: any) => p.text).join('\n'));
const imageParts = (c: string | ContentPart[]) => (typeof c === 'string' ? [] : c.filter((p) => p.type === 'image'));

function cutWithMarker(s: string, max: number, marker: (dropped: number) => string): string {
  if (s.length <= max) return s;
  const head = Math.ceil(max * 0.7);
  const tail = Math.max(0, max - head);
  const dropped = s.length - head - tail;
  return `${s.slice(0, head)}\n… ${marker(dropped)} …\n${tail ? s.slice(s.length - tail) : ''}`;
}

function nlChars(n: number) {
  return n.toLocaleString('nl-NL');
}

/** The cut points for this call: older turns up to `turnCut`, and tool results up to `stepCut`. */
export function cutPoints(s: SaverSettings, questionTurn: number, lastToolOrdinal: number) {
  const turnCut = Math.floor(Math.max(0, questionTurn - s.keepTurns) / s.step) * s.step;
  const stepCut = Math.floor(Math.max(0, lastToolOrdinal - s.keepSteps) / s.stepChunk) * s.stepChunk;
  return { turnCut, stepCut };
}

/**
 * Shorten the history in place (see the top of this file). Every decision about a message depends only on that
 * message, the ones before it and the two cut points, so the shortened history only grows between cut moves.
 */
export function shortenItems(items: HistItem[], s: SaverSettings, opts: { questionTurn: number }): ShortenResult {
  const res: ShortenResult = { edits: [], toolOutputs: 0, duplicates: 0, attachments: 0, images: 0, savedChars: 0 };
  const lastOrd = items.reduce((n, it) => Math.max(n, it.toolOrdinal || 0), 0);
  const { turnCut, stepCut } = cutPoints(s, opts.questionTurn, lastOrd);
  const firstFull = new Map<string, number>();
  for (const it of items) {
    const m = it.msg;
    const old = turnCut > 0 && it.turn <= turnCut;
    if (it.kind === 'tool' && !it.synthetic && !NEVER_SHORTEN.has(m.toolName || '')) {
      const text = textParts(m.content);
      const imgs = imageParts(m.content);
      const tool = m.toolName || 'de tool';
      let next: string | null = null;
      let dropImages = false;
      let kind: HistEdit['kind'] | null = null;
      if (old && (text.length > OLD_MIN || imgs.length)) {
        next = text.length > OLD_MIN ? cutWithMarker(text, s.oldToolChars, (d) => `[Ingekort door TeamBot om ruimte te sparen: oudere uitvoer van ${tool}, ${nlChars(d)} van ${nlChars(text.length)} tekens weggelaten. Roep de tool opnieuw aan als je de volledige inhoud nodig hebt.]`) : text;
        if (imgs.length) {
          next += '\n[afbeelding uit een oudere beurt weggelaten om ruimte te sparen]';
          dropImages = true;
        }
        kind = 'old';
      } else if (stepCut > 0 && (it.toolOrdinal || 0) <= stepCut && text.length > RUN_MIN) {
        next = cutWithMarker(text, s.runToolChars, (d) => `[Ingekort door TeamBot om ruimte te sparen: uitvoer van ${tool} van een aantal stappen geleden, ${nlChars(d)} van ${nlChars(text.length)} tekens weggelaten. Roep de tool opnieuw aan als je de volledige inhoud nodig hebt.]`);
        kind = 'run';
      } else if (s.duplicates && it.callKey && text.length > DUP_MIN && !imgs.length && !m.isError) {
        const sig = `${it.callKey}#${text.length}#${shortKey(text)}`;
        if (firstFull.has(sig)) {
          next = `[Zelfde uitvoer als de eerdere aanroep van ${tool} met dezelfde invoer hierboven (${nlChars(text.length)} tekens); TeamBot stuurt die niet nog eens mee.]`;
          kind = 'dup';
        } else firstFull.set(sig, it.seq);
      }
      if (next !== null && kind) {
        const kept = dropImages ? [] : imgs;
        m.content = kept.length ? [{ type: 'text', text: next }, ...kept] : next;
        res.savedChars += Math.max(0, text.length - next.length) + (imgs.length - kept.length) * IMAGE_CHARS;
        res.edits.push({ seq: it.seq, kind });
        if (kind === 'dup') res.duplicates++;
        else res.toolOutputs++;
      }
    } else if (it.kind === 'user' && old) {
      // Attachments and images of older turns: the file is in the workspace; the person's own words stay as they are.
      let text = textParts(m.content);
      const imgs = imageParts(m.content);
      let changed = false;
      text = text.replace(/<bijlage naam="([^"]*)" pad="([^"]*)">\n([\s\S]*?)\n<\/bijlage>/g, (all, naam, pad, body: string) => {
        if (body.length <= ATT_MIN) return all;
        changed = true;
        res.attachments++;
        const keep = body.slice(0, Math.min(800, Math.floor(s.oldToolChars * 0.7)));
        res.savedChars += body.length - keep.length;
        return `<bijlage naam="${naam}" pad="${pad}">\n${keep}\n… [Ingekort door TeamBot: ${nlChars(body.length - keep.length)} tekens van deze oudere bijlage weggelaten; het hele bestand staat in je werkmap als ${pad}.] …\n</bijlage>`;
      });
      if (imgs.length) {
        changed = true;
        res.images += imgs.length;
        res.savedChars += imgs.length * IMAGE_CHARS;
        text = text.replace(/\[afbeelding bijgevoegd: ([^\]]*)\]/g, '[afbeelding bijgevoegd: $1 — de afbeelding zelf is uit deze oudere beurt weggelaten om ruimte te sparen]');
      }
      if (changed) {
        m.content = text;
        res.edits.push({ seq: it.seq, kind: imgs.length ? 'uimg' : 'att' });
      }
    }
  }
  return res;
}

/**
 * Screenshots in tool results are heavy. 0.3.0 kept images only in the newest 3 results, which changed the history
 * with every new screenshot (no prompt cache, and Claude's thinking blocks after it invalid). The saver removes them
 * in blocks of 3: the newest 2–4 image results keep their images.
 */
export function pruneToolImages(items: HistItem[]): HistEdit[] {
  const withImages = items.filter((it) => it.kind === 'tool' && typeof it.msg.content !== 'string' && imageParts(it.msg.content).length);
  const cut = Math.floor(Math.max(0, withImages.length - 2) / 3) * 3;
  const edits: HistEdit[] = [];
  for (const it of withImages.slice(0, cut)) {
    it.msg.content = `${textParts(it.msg.content)}\n[afbeelding weggelaten om ruimte te sparen]`;
    edits.push({ seq: it.seq, kind: 'img' });
  }
  return edits;
}

// ------------------------------------------------------------------ what never falls off

/** Lines of the "Vastgezet:" part of a memory block (pinned memory: instructions first). */
export function pinnedLines(context: string): string[] {
  const out: string[] = [];
  const block = context.match(/<geheugen[^>]*>([\s\S]*?)<\/geheugen>/)?.[1];
  if (!block) return out;
  const lines = block.split('\n');
  let inPinned = false;
  for (const l of lines) {
    if (/^Vastgezet:\s*$/.test(l)) {
      inPinned = true;
      continue;
    }
    if (!inPinned) continue;
    if (/^- \[m:[^\]]+\]/.test(l)) out.push(l);
    else if (/^\s{2,}\S/.test(l) && out.length) out[out.length - 1] += `\n${l}`;
    else break;
  }
  return out;
}

const RULE_RE =
  /\b(vraag (?:eerst|altijd|het eerst|mij eerst|me eerst)|eerst (?:vragen|overleggen|toestemming|akkoord)|(?:zonder|met) (?:mijn |eerst |expliciete )?(?:toestemming|akkoord|overleg|goedkeuring)|nooit|altijd|voortaan|vanaf nu|in het vervolg|ask (?:me )?first|always|never|from now on|without (?:my )?(?:permission|approval|consent))\b/i;

/** Sentences of the owner's own words that state a rule ("Vraag eerst voordat je iets verstuurt."). */
export function ownerRules(text: string): string[] {
  const own = text.replace(/```[\s\S]*?```/g, ' ').replace(/^>.*$/gm, ' ');
  return own
    .split(/(?<=[.!?])\s+|\n+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 8 && x.length <= 300 && RULE_RE.test(x));
}

/**
 * The block at the front of the history for what was left out (dropped turns, or the part compaction summarised):
 * pinned memory rules and the owner's own rules from that part, so a "vraag eerst" never disappears with it.
 */
export function carryBlock(dropped: { context: string; ownText: string | null }[], kept: string): { text: string; pinned: number; rules: number } {
  const pinned = new Map<string, string>();
  for (const d of dropped)
    for (const l of pinnedLines(d.context)) {
      const ref = l.match(/^- \[(m:[^\]]+)\]/)?.[1] || l;
      if (!kept.includes(`[${ref}]`)) pinned.set(ref, l);
    }
  const rules: string[] = [];
  for (const d of dropped) for (const r of d.ownText ? ownerRules(d.ownText) : []) if (!rules.includes(r) && !kept.includes(r)) rules.push(r);
  const pin = [...pinned.values()].slice(-20);
  const rul = rules.slice(-10);
  const parts: string[] = [];
  if (pin.length) parts.push(`[Vastgezette regels uit het eerdere deel van dit gesprek; die blijven gelden]\n${pin.join('\n')}`);
  if (rul.length) parts.push(`[Afspraken van de eigenaar uit het eerdere deel van dit gesprek, in zijn eigen woorden; die blijven gelden]\n${rul.map((r) => `- “${r}”`).join('\n')}`);
  let text = parts.join('\n\n');
  if (text.length > 5000) text = text.slice(0, 5000) + '\n…';
  return { text, pinned: pin.length, rules: rul.length };
}

// ------------------------------------------------------------------ Claude's thinking blocks

/** The key an answer is written under: the tool set, what is at the front, and every change before it. */
export function editsKey(toolsKey: string, frontKey: string, edits: HistEdit[], beforeSeq = Infinity): string {
  const list = edits.filter((e) => e.seq < beforeSeq).map((e) => `${e.seq}${e.kind}`);
  if (!toolsKey && !frontKey && !list.length) return '';
  return shortKey(`${toolsKey}|${frontKey}|${list.join(',')}`);
}

const THINKING = new Set(['thinking', 'redacted_thinking']);

/**
 * Claude (Opus 5.5, Sonnet 5.5, Fable 5.1, Haiku 5.5) binds a thinking block to everything before it: when that
 * changed since the block was written (an older tool output shortened, a tool part loaded, a summary in front), the
 * API refuses the block. Leave those blocks out; the text and tool calls of the answer stay.
 */
export function stripStaleThinking(messages: ChatMsg[], metas: { seq: number; key: string }[], toolsKey: string, frontKey: string, edits: HistEdit[]): number {
  let n = 0;
  messages.forEach((m, i) => {
    if (m.role !== 'assistant' || m.raw?.provider !== 'anthropic' || !Array.isArray(m.raw.data) || !m.raw.data.some((b: any) => THINKING.has(b?.type))) return;
    const meta = metas[i];
    if (!meta) return;
    if (editsKey(toolsKey, frontKey, edits, meta.seq) === (meta.key || '')) return;
    messages[i] = { ...m, raw: { provider: m.raw.provider, data: m.raw.data.filter((b: any) => !THINKING.has(b?.type)) } };
    n++;
  });
  return n;
}

// ------------------------------------------------------------------ the runner hook

export interface ContextStats {
  v: 1;
  engine: 'api' | 'cli';
  /** Estimated tokens per part of what TeamBot sent. */
  parts: ContextParts;
  total: number;
  tools: { sent: number; of: number; leftOut: string[] };
  shortened: { toolOutputs: number; duplicates: number; attachments: number; images: number; dropped: number; carried: number; thinking: number; savedTokens: number };
  saver: boolean;
  summary?: boolean;
  /** History budget of a delegated task or bot-to-bot message (tokens). */
  delegation?: number;
  /** What the engine itself counted after the call (input incl. cache). */
  reported?: { input: number; cacheRead?: number };
  /** CLI engines: what the engine added itself (its own instructions and tools, its session), from its own count. */
  engineOwn?: number;
  /** The key this answer was written under (thinking binding; see stripStaleThinking). */
  key?: string;
}

export interface HistoryInfo {
  metas: { seq: number; key: string }[];
  edits: HistEdit[];
  frontKey: string;
  shortened: ShortenResult;
  dropped: number;
  carried: number;
  summary: boolean;
}

export interface SaverTurn {
  messages: ChatMsg[];
  truncated: boolean;
  specs: ToolSpec[];
  stats: ContextStats;
}

/** A delegated task, a bot-to-bot message or an ask in the bot's own chat: a small history budget of its own. */
export function isDelegated(run: Run | null | undefined, thread: Thread): boolean {
  const team = run?.meta?.team;
  return !!team && (thread.kind === 'delegation' || team.kind === 'ask');
}

/**
 * The per-run hook of the runner (API engines): builds each model call's history and tool list and its stats.
 * `tools`: what the bot may use (ToolRegistry.forAgent); `.tools` adds tools_load when parts can be left out.
 */
export class ContextSaver {
  readonly settings: SaverSettings;
  readonly tools: ToolDef[];
  private botNames: string[] = [];
  private about: string;
  constructor(
    private ctx: Ctx,
    private agent: Agent,
    private thread: Thread,
    private run: Run | null,
    private all: ToolDef[],
    private system: string,
    private build: (o: { vision: boolean; budgetTokens?: number; saver: SaverSettings | false }) => { messages: ChatMsg[]; truncated: boolean; info?: HistoryInfo },
  ) {
    this.settings = saverSettings(ctx, agent);
    this.about = [agent.instructions || '', agent.description || '', agent.role || ''].join('\n');
    const select = this.settings.on && this.settings.selectTools && all.length > 1;
    this.tools = select ? [...all, loaderTool(all, ctx.tools.groups)] : all;
    if (select) {
      try {
        this.botNames = ctx.store.all<{ name: string }>('SELECT name FROM agents WHERE user_id = ? AND id != ? AND archived = 0', agent.user_id, agent.id).map((r) => r.name);
      } catch {
        this.botNames = [];
      }
    }
  }

  /** History, tool list and stats for the next model call. */
  next(o: { vision: boolean }): SaverTurn {
    const s = this.settings;
    const delegated = s.on && isDelegated(this.run, this.thread);
    const historyTokens = Number(this.agent.settings?.historyTokens) || 80_000;
    const budgetTokens = delegated ? Math.min(historyTokens, s.delegationTokens) : undefined;
    const h = this.build({ vision: o.vision, budgetTokens, saver: s.on ? s : false });
    let sel: Selection;
    if (s.on && s.selectTools) {
      sel = selectTools({ tools: this.all, groups: this.ctx.tools.groups, system: this.system, about: this.about, messages: h.messages, budget: s.toolTokens, room: this.thread.kind === 'room' || !!this.thread.room_id, botNames: this.botNames });
    } else sel = { specs: this.all.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters, ...(t.app ? { app: t.app } : {}) })), leftOut: [], of: this.all.length, key: '' };
    let thinking = 0;
    let key = '';
    if (h.info) {
      thinking = stripStaleThinking(h.messages, h.info.metas, sel.key, h.info.frontKey, h.info.edits);
      key = editsKey(sel.key, h.info.frontKey, h.info.edits);
    }
    const parts = measure(this.system, sel.specs, h.messages);
    const sh = h.info?.shortened;
    const toolSaved = sel.leftOut.reduce((n, b) => n + b.tokens, 0) - (sel.leftOut.length ? specTokens(sel.specs.filter((x) => x.name === LOADER_NAME)) : 0);
    const stats: ContextStats = {
      v: 1,
      engine: 'api',
      parts,
      total: sumParts(parts),
      tools: { sent: sel.specs.filter((x) => x.name !== LOADER_NAME).length, of: sel.of, leftOut: sel.leftOut.map((b) => b.label) },
      shortened: {
        toolOutputs: sh?.toolOutputs || 0,
        duplicates: sh?.duplicates || 0,
        attachments: sh?.attachments || 0,
        images: sh?.images || 0,
        dropped: h.info?.dropped || 0,
        carried: h.info?.carried || 0,
        thinking,
        savedTokens: Math.max(0, estimateTokens(sh?.savedChars || 0) + Math.max(0, toolSaved)),
      },
      saver: s.on,
      ...(h.info?.summary ? { summary: true } : {}),
      ...(delegated ? { delegation: budgetTokens } : {}),
      ...(key ? { key } : {}),
    };
    return { messages: h.messages, truncated: h.truncated, specs: sel.specs, stats };
  }

  /** The stats to store on the answer, with the engine's own count; also one line in the log. */
  record(stats: ContextStats, usage?: Usage | null): ContextStats {
    const out: ContextStats = { ...stats, ...(usage && usage.input > 0 ? { reported: { input: usage.input, ...(usage.cacheRead ? { cacheRead: usage.cacheRead } : {}) } } : {}) };
    logStats(this.ctx, this.agent, out);
    return out;
  }
}

export function logStats(ctx: Ctx, agent: Agent, s: ContextStats) {
  try {
    const p = s.parts;
    ctx.log.info(
      `[context] ${agent.name} (${s.engine}): ~${s.total} tokens — system ${p.system}, tools ${p.tools} (${s.tools.sent}/${s.tools.of}), memory ${p.memory}, history ${p.history}, tool output ${p.toolOutputs}, attachments ${p.attachments}` +
        (s.shortened.savedTokens ? `; saved ~${s.shortened.savedTokens}` : '') +
        (s.reported ? `; engine counted ${s.reported.input}${s.reported.cacheRead ? ` (${s.reported.cacheRead} cached)` : ''}` : '') +
        (s.delegation ? `; delegation budget ${s.delegation}` : '') +
        (s.saver ? '' : '; saver off'),
    );
  } catch {
    /* logging never breaks a run */
  }
}

/** Tools a CLI engine has itself (TeamBot does not hand those over its MCP server). */
const CLI_NATIVE = new Set(['list_files', 'read_file', 'write_file', 'edit_file', 'search_files', 'delete_file', 'run_command']);

/**
 * CLI engines (Claude Code, Codex, OpenCode …) keep their own context: TeamBot only sees what it hands them (system
 * prompt, the prompt with the new messages and the turn context, attachments, its own tools over MCP). An estimate of
 * those parts; after the turn, what the engine counted itself shows the rest (its own instructions, tools, session).
 */
export async function cliContextStats(ctx: Ctx, agent: Agent, thread: Thread, o: { system: string; prompt: string; attachments: { mime: string; size?: number }[] }): Promise<ContextStats> {
  const parts: ContextParts = { system: estimateTokens(o.system.length), tools: 0, memory: 0, history: 0, toolOutputs: 0, attachments: 0 };
  splitUserText(o.prompt, parts);
  for (const a of o.attachments) parts.attachments += /^image\//.test(a.mime) ? IMAGE_TOKENS : /^text\/|json|xml|csv|yaml/.test(a.mime) ? estimateTokens(Math.min(Number(a.size) || 0, 200_000)) : 0;
  let sent = 0;
  let of = 0;
  try {
    const tools = (await ctx.tools.forAgent(agent, thread)).filter((t) => !CLI_NATIVE.has(t.name));
    of = tools.length;
    sent = tools.length;
    parts.tools = tools.length ? specTokens(tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))) : 0;
  } catch {
    /* no estimate for the tools */
  }
  return {
    v: 1,
    engine: 'cli',
    parts,
    total: sumParts(parts),
    tools: { sent, of, leftOut: [] },
    shortened: { toolOutputs: 0, duplicates: 0, attachments: 0, images: 0, dropped: 0, carried: 0, thinking: 0, savedTokens: 0 },
    saver: saverSettings(ctx, agent).on,
  };
}

/**
 * The estimate with the TeamBot tools the CLI really got listed (cli-agents/toolhost.ts: a smaller list plus tools_load
 * for an engine that lists again, the whole set for the others). Without that information: unchanged.
 */
export function withServedTools(s: ContextStats, t?: { tokens: number; full: number; sent: number; of: number; leftOut: string[] } | null): ContextStats {
  if (!t || !Number.isFinite(t.tokens)) return s;
  const parts = { ...s.parts, tools: t.tokens };
  return {
    ...s,
    parts,
    total: sumParts(parts),
    tools: { sent: t.sent, of: t.of, leftOut: t.leftOut },
    shortened: { ...s.shortened, savedTokens: s.shortened.savedTokens + Math.max(0, t.full - t.tokens) },
  };
}

/** CLI stats with the engine's own count after the turn (what it added itself = its count minus TeamBot's part). */
export function cliRecord(ctx: Ctx, agent: Agent, s: ContextStats, usage?: Usage | null): ContextStats {
  const out: ContextStats = { ...s };
  if (usage && usage.input > 0) {
    out.reported = { input: usage.input, ...(usage.cacheRead ? { cacheRead: usage.cacheRead } : {}) };
    out.engineOwn = Math.max(0, usage.input - s.total);
  }
  logStats(ctx, agent, out);
  return out;
}
