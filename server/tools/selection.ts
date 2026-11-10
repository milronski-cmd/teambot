import type { ChatMsg, ToolDef, ToolGroup, ToolSpec } from '../core/types.js';
import { estimateTokens } from '../core/tokens.js';

/**
 * Fewer tool definitions per model call (TeamBot 0.4, package Y). A bot with many tools and apps sends every
 * definition with every call: 49 tools (~8k tokens) for a standard bot, 89 (~13k) with every group on, plus the tools
 * of connected apps. When the definitions are bigger than a budget, only the parts that are likely needed this turn
 * are sent, plus one small tool (`tools_load`) that loads the rest:
 *
 * - always: the basics (core, files, web, memory, terminal, container);
 * - a part the system prompt or the bot's own instructions name a tool of (the prompt promises it: routine_no_update,
 *   the team database, the browser of a browser bot), or that the question or the bot's instructions mention
 *   ("plan dit elke ochtend in" → routines, the name of an app or of another bot);
 * - a part used or loaded earlier in this conversation (so it stays for the rest of the conversation);
 * - in a group chat: the team tools;
 * - then the smallest remaining parts while they fit in the budget.
 *
 * The rest is named in the description of `tools_load`, so the bot can see what it did not get and load it in one
 * step. Deterministic and only growing within a conversation: the tool list (which comes before everything else in the
 * prompt) stays byte-identical between calls, so prompt caching keeps working; it changes only when a part is added.
 * Never more than the bot already has: a selection is always a subset of `ToolRegistry.forAgent`.
 */

export const LOADER_NAME = 'tools_load';

/** Parts that every bot with tools keeps: small, or needed for nearly every task. */
const ALWAYS = new Set(['core', 'files', 'web', 'memory', 'shell', 'container']);

/** Words in a question or in the bot's instructions that point at a part (Dutch and English). */
const HINTS: Record<string, RegExp> = {
  team: /\b(delegeer|delegeren|uitbesteden|overdragen|doorgeven|collega'?s?|teamleider|takenbord|team|vraag (?:het )?aan|delegate|hand ?off|colleague)\b/i,
  'team:data': /\b(teamdatabase|database|tabel|tabellen|logboek|beslissingen|sql)\b/i,
  'team:projects': /\b(project\w*|kans|kansen|kansenbord|nulmeting)\b/i,
  routines: /\b(routines?|herinner\w*|elke (?:dag|ochtend|middag|avond|nacht|week|maand|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag)|dagelijks|wekelijks|maandelijks|om \d{1,2}(?:[:.]\d{2})? ?uur|morgen(?:ochtend|middag|avond)|inplannen|plan\w* (?:dit|het|dat) in|schedule|remind\w*|every (?:day|morning|week|month))\b/i,
  'routines:run': /\b(routine_no_update)\b/i,
  browser: /\b(browser|inloggen|log ?in|klik\w*|formulier|invullen|screenshot|schermafbeelding)\b/i,
  desktop: /\b(bureaublad|desktop|venster|muis|toetsenbord)\b/i,
  rehearsal: /\b(repetitie|oefen\w*|snapshot|herstelpunt|terugdraaien|reservekopie|rehearsal)\b/i,
  remote: /\b(ssh|vps|eigen server)\b/i,
  channels: /\b(telegram|whatsapp|discord|slack|e-?mail|mail|kanaal|kanalen|sms)\b/i,
  skills: /\b(skills?|vaardigheid)\b/i,
};

/** Labels for parts without a registered group of their own. */
const LABELS: Record<string, [string, string]> = {
  'team:data': ['Teamdatabase', 'Gedeelde tabellen van het team lezen en bijwerken (taken, beslissingen, logboek)'],
  'team:projects': ['Projecten en kansen', 'Groot werk als project in vaste stappen doen, en een idee om geld te verdienen als kans melden'],
  'memory:dossiers': ['Dossiers (uitgebreid)', 'Dossiers aanmaken en regels met losse velden toevoegen of bijwerken; meestal is dossier_note genoeg'],
};

export interface Bundle {
  id: string;
  label: string;
  description: string;
  tools: ToolDef[];
  /** Estimated tokens of the definitions of this part. */
  tokens: number;
}

export interface Selection {
  /** The definitions to send, in the bot's normal order, plus `tools_load` at the end when parts were left out. */
  specs: ToolSpec[];
  /** Parts left out this call (their labels), in a stable order. */
  leftOut: Bundle[];
  /** Number of tools the bot has in total (without tools_load). */
  of: number;
  /** '' when every tool is sent, else a short key of the sent set (part of the prompt-cache/thinking key). */
  key: string;
}

const specOf = (t: ToolDef): ToolSpec => ({ name: t.name, description: t.description, parameters: t.parameters, ...(t.app ? { app: t.app } : {}) });
export const specTokens = (specs: ToolSpec[]) => estimateTokens(JSON.stringify(specs.map(({ app: _a, ...s }) => s)));

export function bundleId(t: Pick<ToolDef, 'group' | 'app'>): string {
  return t.app ? `app:${t.app}` : t.group;
}

/** The parts of a tool list, in the order they first appear. */
export function bundlesOf(tools: ToolDef[], groups: Map<string, ToolGroup>): Bundle[] {
  const by = new Map<string, Bundle>();
  for (const t of tools) {
    const id = bundleId(t);
    let b = by.get(id);
    if (!b) {
      const g = groups.get(id);
      const [label, description] = t.app ? [t.app, `Gekoppelde app ${t.app}`] : g ? [g.label, g.description] : LABELS[id] || [id, ''];
      b = { id, label, description, tools: [], tokens: 0 };
      by.set(id, b);
    }
    b.tools.push(t);
  }
  for (const b of by.values()) b.tokens = specTokens(b.tools.map(specOf));
  return [...by.values()];
}

const textOf = (m: ChatMsg) => (typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n'));

/** Words of an app name that count as "named" (as in the Ollama window fit). */
function appNamed(app: string, text: string): boolean {
  return app.toLowerCase().split(/[^\p{L}\p{N}]+/u).some((w) => w.length >= 4 && text.includes(w));
}

const nameRe = (names: string[]) => (names.length ? new RegExp(`(?<![\\w-])(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w-])`) : null);

export interface SelectInput {
  tools: ToolDef[];
  groups: Map<string, ToolGroup>;
  system: string;
  /** The bot's own instructions and description (static per bot). */
  about: string;
  messages: ChatMsg[];
  /** Budget for all definitions together (estimated tokens); at or under it everything is sent. */
  budget: number;
  /** A group chat: the team tools always. */
  room?: boolean;
  /** Names of the owner's other bots: naming one in a question points at the team tools. */
  botNames?: string[];
}

/** Which parts to send this call (see the top of this file). */
export function selectTools(i: SelectInput): Selection {
  const all = i.tools.filter((t) => t.name !== LOADER_NAME);
  const full: Selection = { specs: all.map(specOf), leftOut: [], of: all.length, key: '' };
  const bundles = bundlesOf(all, i.groups);
  const total = bundles.reduce((n, b) => n + b.tokens, 0);
  if (total <= i.budget || bundles.length < 2) return full;

  const keep = new Set<string>();
  for (const b of bundles) if (ALWAYS.has(b.id)) keep.add(b.id);
  if (i.room) keep.add('team');
  // Named by the (stable) system prompt or the bot's instructions: the prompt promises these tools.
  const fixedText = `${i.system}\n${i.about}`;
  for (const b of bundles) {
    if (keep.has(b.id)) continue;
    const re = nameRe(b.tools.map((t) => t.name));
    if (re?.test(fixedText)) keep.add(b.id);
  }
  // Used or loaded in this conversation, and pointed at by a question or by the bot's instructions.
  const called = new Set<string>();
  const loaded = new Set<string>();
  // The person's own words (without the frozen <context> blocks: memory notes are no request) for the hints; the
  // whole text for tool names (a turn context can name a tool, e.g. routine_no_update in a routine turn).
  const asked: string[] = [i.about.toLowerCase()];
  const texts: string[] = [];
  for (const m of i.messages) {
    if (m.role === 'assistant') {
      for (const c of m.toolCalls || []) {
        called.add(c.name);
        if (c.name === LOADER_NAME) for (const n of loaderNames(c.args)) loaded.add(n.toLowerCase());
      }
    } else if (m.role === 'user') {
      const text = textOf(m);
      texts.push(text);
      asked.push(text.replace(/<context>[\s\S]*?<\/context>/g, ' ').toLowerCase());
    }
  }
  const words = asked.join('\n');
  const all2 = texts.join('\n');
  const bots = (i.botNames || []).filter((n) => n.trim().length >= 3);
  const botRe = nameRe(bots.map((n) => n.toLowerCase()));
  for (const b of bundles) {
    if (keep.has(b.id)) continue;
    if (loaded.has(b.id.toLowerCase()) || loaded.has(b.label.toLowerCase()) || b.tools.some((t) => called.has(t.name))) keep.add(b.id);
    else if (b.id.startsWith('app:') ? appNamed(b.id.slice(4), words) : HINTS[b.id]?.test(words)) keep.add(b.id);
    else if (b.id === 'team' && botRe?.test(words)) keep.add(b.id);
    else if (nameRe(b.tools.map((t) => t.name))?.test(all2)) keep.add(b.id);
  }
  // Then the smallest remaining parts while everything fits in the budget (stable: by size, then by id).
  let used = bundles.filter((b) => keep.has(b.id)).reduce((n, b) => n + b.tokens, 0);
  for (const b of bundles.filter((x) => !keep.has(x.id)).sort((a, c) => a.tokens - c.tokens || (a.id < c.id ? -1 : 1))) {
    if (used + b.tokens > i.budget) break;
    keep.add(b.id);
    used += b.tokens;
  }
  const leftOut = bundles.filter((b) => !keep.has(b.id));
  if (!leftOut.length) return full;
  const sent = all.filter((t) => keep.has(bundleId(t)));
  const loader = loaderSpec(leftOut);
  const specs = [...sent.map(specOf), loader];
  return { specs, leftOut, of: all.length, key: shortKey(specs.map((s) => s.name).join(',') + '|' + loader.description) };
}

function loaderNames(args: any): string[] {
  const v = args?.names ?? args?.name ?? args?.parts;
  return (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map((x) => String(x).trim()).filter(Boolean);
}

function loaderSpec(leftOut: Bundle[]): ToolSpec {
  const lines = leftOut.map((b) => `- ${b.id}: ${b.label}${b.description ? ` — ${b.description}` : ''} (${b.tools.length === 1 ? '1 hulpmiddel' : `${b.tools.length} hulpmiddelen`})`);
  return {
    name: LOADER_NAME,
    description: [
      'Haal extra hulpmiddelen erbij. Om ruimte te sparen kreeg je niet al je hulpmiddelen mee; deze onderdelen kun je laden:',
      ...lines,
      'Laad alleen wat je voor deze taak echt nodig hebt. Geladen hulpmiddelen zijn vanaf je volgende stap beschikbaar.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { names: { type: 'array', items: { type: 'string', enum: leftOut.map((b) => b.id) }, description: 'De onderdelen om te laden (de namen vóór de dubbele punt)' } },
      required: ['names'],
    },
  };
}

/**
 * The tool behind `tools_load`. It only reports; the runner sends the loaded parts from the next model call on (the
 * selection reads this call back from the conversation). It can only load tools the bot already has.
 */
export function loaderTool(all: ToolDef[], groups: Map<string, ToolGroup>): ToolDef {
  return {
    name: LOADER_NAME,
    group: 'core',
    risk: 'read',
    internal: true,
    description: 'Haal extra hulpmiddelen erbij.',
    parameters: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' } } }, required: ['names'] },
    summarize: (a) => `Hulpmiddelen erbij: ${loaderNames(a).join(', ')}`,
    async run(a) {
      const bundles = bundlesOf(all.filter((t) => t.name !== LOADER_NAME), groups);
      const want = loaderNames(a);
      const found = bundles.filter((b) => want.includes(b.id) || want.some((w) => w.toLowerCase() === b.label.toLowerCase()));
      if (!found.length) return { text: `Onbekend onderdeel: ${want.join(', ') || '(niets opgegeven)'}. Je kunt kiezen uit: ${bundles.map((b) => b.id).join(', ')}.`, isError: true };
      return {
        text: `Geladen: ${found.map((b) => `${b.label} (${b.tools.map((t) => t.name).join(', ')})`).join('; ')}. Deze hulpmiddelen zijn vanaf je volgende stap beschikbaar.`,
        data: { loaded: found.map((b) => b.id) },
      };
    },
  };
}

/** A short, stable key (FNV-1a, base 36). */
export function shortKey(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}
