import type { Agent, PartGuide, Thread, ToolDef, ToolGroup, ToolOutput, ToolSpec } from '../core/types.js';
import { estimateTokens } from '../core/tokens.js';
import { checkArgs } from './schema.js';
import { words } from '../../shared/i18n-core.js';

/**
 * Which tool definitions a model gets with every call. A bot with every part on has over a hundred tools; sending
 * every definition with every step cost about 18,000 tokens per step, on every engine. So a model is listed:
 *
 * - the core: the tools bots use daily (ask the owner, notify, the plan, memory search and dossiers, a skill, work or
 *   a question for a colleague, the way into its browser, files/terminal/web for engines that have none of their own,
 *   and for the main bot TeamBot itself; every other bot finds those two on demand, `onDemand` on its copy);
 * - `tools_find`: looks up any other tool the bot has. Its description NAMES EVERY ONE of them, per part, so a model
 *   never has to guess whether something exists (an earlier selection hid parts behind labels, and bots did not find
 *   what they needed). It answers with the description and the fields;
 * - `tools_call`: uses such a tool, with its name and fields.
 *
 * What a bot is set up for, and what a message asks for by name, is listed with the core (`wanted`): a bot whose
 * instructions say it works in its browser has the browser part in its list, and a message that names browser_click
 * gets it listed for that run (12 nov: a small model did not get from tools_find to such a tool and gave no answer).
 *
 * The first time a run uses a tool of a part whose tools belong together (the browser, the desktop, the team database,
 * a connected app …) the result also carries the fields of the rest of that part and what the bot must know about it
 * (its guide): one tool used and the whole part is known, without a search step per tool.
 *
 * The same on every engine (API models and the CLI engines over MCP; nothing depends on an engine listing its tools
 * again). The list is the same in every step of every conversation of a bot, so prompt caches hold. Nothing is taken
 * away: a `tools_call` is turned into the call it names before anything else happens (`resolve`), so it passes the same
 * gate (tools/execute.ts: argument check, Broker, tool policy, review, approval, audit) and shows, logs and reads back
 * under the tool's own name. A model that calls an unlisted tool directly gets it too. With "fewer tools" off
 * (contextSaver.selectTools) everything is listed as before.
 */

export const FIND_NAME = 'tools_find';
export const CALL_NAME = 'tools_call';

/** Always listed, when the bot has them. A CLI engine has the file, terminal and search tools itself (not offered by TeamBot). */
const CORE = new Set([
  'ask_user',
  'notify_user',
  'plan_update',
  'share_file',
  'list_files',
  'read_file',
  'write_file',
  'edit_file',
  'search_files',
  'delete_file',
  'run_command',
  'web_search',
  'web_fetch',
  'read_document',
  'memory_search',
  'dossier_get',
  'dossier_write',
  'skill_load',
  'delegate_task',
  'ask_bot',
  // The way into the bot's own browser: with the first page come the fields of the other browser tools (TOGETHER).
  'browser_open',
  'browser_snapshot',
  'teambot_find',
  'teambot_do',
]);

/**
 * Parts that are listed whole: tools that only exist in one kind of run (the end of a routine, hanging up a live call)
 * and the bot's computer when the owner set one up for it (a container, his own server): that is where it works.
 */
const CORE_PARTS = new Set(['routines:run', 'voice-call', 'container', 'remote']);

/**
 * Parts whose tools belong together: using one means the bot will need the others. The first use in a run brings the
 * fields of the rest of the part (connected apps too: one tool of an app, and the app is known).
 */
const TOGETHER = new Set(['browser', 'desktop', 'team:data', 'team:projects', 'rehearsal', 'routines:workflows', 'channels']);

/**
 * What a part is, in a few words, in front of its tool names in the description of `tools_find`. `words`: extra search
 * words (English names models use). `label`: for a part without a registered group. A part without a line here is
 * named by its group's label.
 */
const PARTS: Record<string, { hint: string; words?: string; label?: string }> = {
  core: { hint: 'vragen en eigen instellingen', words: 'settings form formulier html onderdeel regel naam model' },
  files: { hint: 'websites publiceren', words: 'site publish' },
  'files:images': { hint: 'afbeelding maken', words: 'image picture plaatje', label: 'Afbeeldingen' },
  memory: { hint: 'losse notities', words: 'memory remember forget geheugen onthouden vergeten' },
  'memory:dossiers': { hint: 'dossierregels', words: 'memory besluit actie persoon bron', label: 'Dossiers (uitgebreid)' },
  skills: { hint: 'skills beheren', words: 'skill install save script zoeken toevoegen vastleggen' },
  routines: { hint: 'routines', words: 'schedule cron planning inplannen wachten vast moment' },
  'routines:reminders': { hint: 'herinneringen en vaste taken', words: 'reminder duty' },
  'routines:workflows': { hint: 'workflows', words: 'workflow', label: 'Workflows' },
  team: { hint: 'collega-bots en takenbord', words: 'task taak message bericht ask status board overdragen bot team' },
  'team:data': { hint: 'teamdatabase', words: 'sql database table tabel logboek beslissing', label: 'Teamdatabase' },
  'team:projects': { hint: 'projecten en kansen', words: 'project kans', label: 'Projecten en kansen' },
  browser: { hint: 'je eigen browser', words: 'website login inloggen formulier klikken invullen' },
  desktop: { hint: 'bureaublad en apps van deze computer', words: 'screen scherm muis toetsenbord venster app' },
  rehearsal: { hint: 'reservekopie en repetitie van je werkmap', words: 'snapshot backup herstelpunt' },
  specialist: { hint: 'kennisbank', words: 'knowledge kennis' },
  channels: { hint: 'berichten via mail en chat-apps', words: 'email mail telegram whatsapp kanaal send versturen' },
};

/** The description of tools_find stays under this (a tool description is cut at 2,000 characters for a CLI engine). */
const FIND_DESCRIPTION_CHARS = 1990;
/** Full definitions in one answer of tools_find up to about this many characters; further matches by name. */
const FIND_CHARS = 12_000;
/** The same for the rest of a part that comes with its first use. */
const PART_CHARS = 9000;

/** A tool as a provider gets it. */
export const specOf = (t: ToolDef): ToolSpec => ({ name: t.name, description: t.description, parameters: t.parameters, ...(t.app ? { app: t.app } : {}) });
/** Estimated tokens of tool definitions as the model sees them (name, description, schema). */
export const specTokens = (specs: ToolSpec[]) => estimateTokens(JSON.stringify(specs.map(({ app: _a, ...s }) => s)));

/** The part a tool belongs to: its group, or its connected app. */
function bundleId(t: Pick<ToolDef, 'group' | 'app'>): string {
  return t.app ? `app:${t.app}` : t.group;
}

const isCore = (t: ToolDef) => !t.app && !t.onDemand && (CORE.has(t.name) || CORE_PARTS.has(t.group));

/** Does the text name this tool or part (as a word: "teambot_find" in "zoek het op met teambot_find")? */
export function mentions(text: string | undefined, name: string): boolean {
  if (!text || !name) return false;
  let i = text.indexOf(name);
  while (i >= 0) {
    if (!/[A-Za-z0-9_]/.test(text[i - 1] || '') && !/[A-Za-z0-9_]/.test(text[i + name.length] || '')) return true;
    i = text.indexOf(name, i + 1);
  }
  return false;
}

/**
 * Tools outside the core that the bot is set up for or this run asks for (see the top of this file):
 *  - a tool named by its name in the bot's own text (role, description, instructions) or in the message;
 *  - a part whose tools belong together (TOGETHER, not a connected app: those can be large) whole, when one of its tools
 *    is named that way or the bot's own text names the part itself ("browser", "Teamdatabase").
 * The bot's own text keeps its list the same in every conversation; a message changes it for its own run only.
 */
function wanted(tools: ToolDef[], groups: Map<string, ToolGroup>, agent: Agent, asked: string): Set<string> {
  const own = [agent.role, agent.description, agent.instructions].filter(Boolean).join('\n').toLowerCase();
  const msg = asked.toLowerCase();
  const out = new Set<string>();
  const whole = new Set<string>();
  for (const t of tools) {
    const n = t.name.toLowerCase();
    if (!mentions(own, n) && !mentions(msg, n)) continue;
    out.add(t.name);
    if (!t.app && TOGETHER.has(t.group)) whole.add(t.group);
  }
  for (const id of TOGETHER) {
    const words = [id.includes(':') ? '' : id, groups.get(id)?.label || PARTS[id]?.label || ''];
    if (words.some((w) => w && mentions(own, w.toLowerCase()))) whole.add(id);
  }
  for (const t of tools) if (!t.app && whole.has(t.group)) out.add(t.name);
  return out;
}

/**
 * The parts of a bot's tools that have tools it finds on demand (their ids, in the order they first appear): outside
 * the core and not what the bot is set up for (`wanted` from its own text). Their guides are not in its prompt
 * (agent/prompt.ts); they come with the first use (`after`).
 */
export function partsOnDemand(tools: ToolDef[], o?: { groups: Map<string, ToolGroup>; agent: Agent }): string[] {
  const outside = tools.filter((t) => !isCore(t));
  const setUp = o ? wanted(outside, o.groups, o.agent, '') : null;
  return [...new Set(outside.filter((t) => !setUp?.has(t.name)).map(bundleId))];
}

/** Does a guide belong to one of these parts ("app:*" = any connected app)? */
export function guideFor(g: PartGuide, parts: Iterable<string>): boolean {
  for (const p of parts) if (g.parts.includes(p) || (p.startsWith('app:') && g.parts.includes('app:*'))) return true;
  return false;
}

interface Part {
  id: string;
  label: string;
  hint: string;
  words: string;
  tools: ToolDef[];
}

function partsOf(rest: ToolDef[], groups: Map<string, ToolGroup>): Part[] {
  const by = new Map<string, Part>();
  for (const t of rest) {
    const id = bundleId(t);
    let p = by.get(id);
    if (!p) {
      const g = groups.get(id);
      const known = PARTS[id];
      const label = t.app || g?.label || known?.label || id;
      p = { id, label, hint: t.app ? `app ${t.app}` : known?.hint || label.toLowerCase(), words: known?.words || '', tools: [] };
      by.set(id, p);
    }
    p.tools.push(t);
  }
  return [...by.values()];
}

/** The first part every name shares, up to an underscore: "browser_" for the browser tools, "mcp_notion_" for an app. */
function sharedPrefix(names: string[]): string {
  if (names.length < 3) return '';
  let pre = names[0];
  for (const n of names) while (pre && !n.startsWith(pre)) pre = pre.slice(0, -1);
  pre = pre.slice(0, pre.lastIndexOf('_') + 1);
  return pre.length >= 4 && names.every((n) => n.length > pre.length) ? pre : '';
}

/**
 * Every tool outside the list by name, per part, for the description of `tools_find`. A tool description is cut at
 * about 2,000 characters on its way to a CLI engine (toolhost.ts; Claude Code caps it too), and names that fall off are
 * tools a bot never finds. So it is made to fit: the names in full; when that is too long (connected apps), a part whose
 * names all start the same way is written once with that start ("je eigen browser (browser_…): navigate, click");
 * and only when that is still too long the longest parts name their first tools and say how many more there are.
 */
function catalogText(parts: Part[], max: number): { text: string; short: boolean; cut: boolean } {
  const line = (p: Part, short: boolean, keep: number) => {
    const names = p.tools.map((t) => t.name);
    const pre = short ? sharedPrefix(names) : '';
    const more = names.length - Math.min(names.length, keep);
    return `${p.hint}${pre ? ` (${pre}…)` : ''}: ${names.slice(0, keep).map((n) => n.slice(pre.length)).join(', ')}${more > 0 ? ` en nog ${more}` : ''}`;
  };
  const all = (short: boolean, keep: number) => parts.map((p) => line(p, short, keep)).join('; ');
  const full = all(false, Infinity);
  if (full.length <= max) return { text: full, short: false, cut: false };
  const short = all(true, Infinity);
  if (short.length <= max) return { text: short, short: true, cut: false };
  for (const keep of [24, 16, 12, 8, 6, 4, 3, 2, 1]) {
    const text = all(true, keep);
    if (text.length <= max || keep === 1) return { text: text.slice(0, max), short: true, cut: true };
  }
  return { text: short.slice(0, max), short: true, cut: true };
}

/** "browser_open" from what a model wrote: "mcp__teambot__browser_open", "teambot.browser_open", " Browser_Open ". */
const bareName = (v: unknown) => String(v ?? '').trim().replace(/^mcp__teambot__/i, '').replace(/^teambot[.:/]/i, '');

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
/** A Dutch plural or verb form still finds its tool: "herinneringen" → "herinnering", "routines" → "routine". */
const stem = (w: string) => (w.length > 4 ? w.replace(/(en|s)$/, '') : w);

/**
 * The tools that fit a query, best first. A name gives that tool. Else every word must be found: in the tool's own name
 * or description (then only those tools: "screenshot" gives the two screenshot tools, not the whole browser), or, when
 * no tool says it itself, in its part ("database" gives the tools of the team database). Nothing: any word.
 */
function search(parts: Part[], query: string): ToolDef[] {
  const q = norm(bareName(query));
  const words = q.split(/[^a-z0-9_]+/).filter(Boolean);
  if (!words.length) return [];
  const all = parts.flatMap((p) => p.tools.map((t) => ({ t, p })));
  const named = all.filter(({ t }) => words.includes(t.name.toLowerCase()));
  if (named.length) return named.map((x) => x.t);
  const rows = all.map(({ t, p }, i) => {
    const name = norm(t.name);
    const text = norm(t.description);
    const part = norm(`${p.id} ${p.label} ${p.hint} ${p.words}`);
    let score = 0;
    let own = 0;
    let any = 0;
    for (const w of words) {
      const has = (hay: string) => hay.includes(w) || hay.includes(stem(w));
      const n = has(name) ? 3 : has(text) ? 2 : has(part) ? 1 : 0;
      if (n >= 2) own++;
      if (n) any++;
      score += n;
    }
    return { t, i, score, own, any };
  });
  const best = (keep: (r: (typeof rows)[number]) => boolean) => rows.filter(keep).sort((a, b) => b.score - a.score || a.i - b.i).map((r) => r.t);
  const own = best((r) => r.own === words.length);
  if (own.length) return own;
  const every = best((r) => r.any === words.length);
  return every.length ? every : best((r) => r.any > 0);
}

const firstSentence = (s: string) => {
  const one = String(s || '').replace(/\s+/g, ' ').trim();
  const cut = one.search(/(?<=[.:;])\s/);
  return (cut > 0 ? one.slice(0, cut) : one).slice(0, 140);
};

/** The fields of a tool as one line of JSON (what the model fills `args` with). */
const fields = (t: ToolDef) => JSON.stringify(t.parameters && typeof t.parameters === 'object' ? t.parameters : { type: 'object', properties: {} });

interface OnDemandInput {
  /** Every tool the bot may use in this run (ToolRegistry.forAgent, after what the engine leaves out). */
  tools: ToolDef[];
  groups: Map<string, ToolGroup>;
  guides: PartGuide[];
  who: { agent: Agent; thread: Thread; userId: string };
  /** "Fewer tools" is on for this bot (contextSaver). Off: everything is listed. */
  on: boolean;
  /** The message this run answers: a tool it names is listed for this run (`wanted`). */
  asked?: string;
  /**
   * What the model was already given: the ids of parts whose other tools came with a first use, and the guides
   * ("guide:<parts>"). Kept by the caller for as long as the model remembers it: one run of an API model (older tool
   * output is shortened), the session of a CLI engine.
   */
  told: Set<string>;
}

export interface OnDemand {
  /** Tools are left out of the list (so tools_find and tools_call are in it). */
  active: boolean;
  /** What the model gets listed, in the bot's own order; tools_find and tools_call last. */
  listed: ToolDef[];
  /** Every tool a call may name: the bot's whole set, plus tools_find and tools_call. */
  callable: ToolDef[];
  /** The tools outside the list. */
  rest: ToolDef[];
  /** Labels of the parts with tools outside the list (for the context panel). */
  leftOut: string[];
  /** '' when everything is listed, else a short key of the listed set (part of the thinking key, context-budget.ts). */
  key: string;
  /** A `tools_call` as the call it names; any other call as it is. */
  resolve(name: string, args: any): { name: string; args: any };
  /**
   * What goes back to the model for a tool of a part with tools outside the list: its result, with the fields when the
   * arguments did not fit and, once per run, what the bot must know about that part (its guide) and, for a part whose
   * tools belong together, the fields of the rest of it.
   */
  after(tool: ToolDef | undefined, args: any, out: ToolOutput, denied: boolean): Promise<ToolOutput>;
}

/** The list for one run (see the top of this file). */
export function onDemand(i: OnDemandInput): OnDemand {
  const all = i.tools.filter((t) => t.name !== FIND_NAME && t.name !== CALL_NAME);
  const want = i.on ? wanted(all.filter((t) => !isCore(t)), i.groups, i.who.agent, i.asked || '') : new Set<string>();
  const rest = i.on ? all.filter((t) => !isCore(t) && !want.has(t.name)) : [];
  // The parts whose guide is not in the prompt: it comes with the first use of one of their tools (also of a tool the
  // message named, which is listed for this run only).
  const unguided = new Set(i.on ? partsOnDemand(all, { groups: i.groups, agent: i.who.agent }) : []);

  /** The guides of these tools' parts that were not given yet in this run, as text. */
  const guides = async (tools: ToolDef[]): Promise<string> => {
    const ids = new Set(tools.map(bundleId));
    const out: string[] = [];
    for (const g of i.guides) {
      const key = `guide:${g.parts.join('+')}`;
      if (i.told.has(key) || !guideFor(g, ids)) continue;
      try {
        const text = await g.text(i.who);
        if (text) out.push(text);
        i.told.add(key);
      } catch {
        /* a guide never breaks a call */
      }
    }
    return out.join('\n\n');
  };
  const withGuide = async (tool: ToolDef, out: ToolOutput, extra: string[] = []): Promise<ToolOutput> => {
    const guide = await guides([tool]);
    if (guide) extra.push(guide);
    return extra.length ? { ...out, text: [out.text, ...extra].filter(Boolean).join('\n\n') } : out;
  };

  // Everything is listed (fewer tools off, or nothing left outside what is wanted): only the guide still comes.
  if (!rest.length)
    return { active: false, listed: all, callable: all, rest: [], leftOut: [], key: '', resolve: (name, args) => ({ name, args }), after: async (t, _a, out, denied) => (t && !denied && unguided.has(bundleId(t)) ? withGuide(t, out) : out) };
  const parts = partsOf(rest, i.groups);
  const restNames = new Set(rest.map((t) => t.name));
  const byName = new Map<string, ToolDef>(all.map((t) => [t.name.toLowerCase(), t]));

  /** One tool as tools_find gives it. */
  const block = (t: ToolDef) => `### ${t.name}\n${t.description}\nvelden: ${fields(t)}`;
  // Every tool outside the list by name, per part: the bot reads here what exists.
  const intro = `Geeft de uitleg en de velden van een hulpmiddel dat niet in je lijst staat; gebruik het daarna met ${CALL_NAME}. Geef een naam of een paar woorden. `;
  const how = 'Staat er (begin_…) achter een onderdeel, dan begint elke naam daarvan zo. ';
  const rest0 = 'Zonder query krijg je elke naam. ';
  const lead = 'Wat je buiten je lijst hebt: ';
  let catalog = catalogText(parts, FIND_DESCRIPTION_CHARS - intro.length - lead.length - 1);
  if (catalog.short) catalog = catalogText(parts, FIND_DESCRIPTION_CHARS - intro.length - how.length - rest0.length - lead.length - 1);

  const find: ToolDef = {
    name: FIND_NAME,
    group: 'core',
    risk: 'read',
    internal: true,
    description:
      `${intro}${catalog.short ? how : ''}${catalog.cut ? rest0 : ''}${lead}${catalog.text}.`,
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Bijvoorbeeld “browser” of “herinnering”. Leeg: alles op een rij.' } } },
    summarize: (a) => (String(a?.query ?? '').trim() ? words('Hulpmiddel zoeken: {0}', String(a.query).trim().slice(0, 80)) : words('Hulpmiddelen bekijken')),
    async run(a) {
      const query = String(a?.query ?? a?.word ?? a?.q ?? a?.name ?? '').trim();
      if (!query) {
        const lines = parts.map((p) => `- ${p.label}: ${p.tools.map((t) => t.name).join(', ')}`);
        return { text: `Buiten je lijst heb je ${rest.length} hulpmiddelen:\n${lines.join('\n')}\n\nZoek op een naam of onderdeel voor de uitleg en de velden.` };
      }
      const found = search(parts, query);
      // Asked for a tool that is in the list already: say so, instead of "nothing found".
      const here = found.length ? [] : all.filter((t) => !restNames.has(t.name) && norm(bareName(query)).split(/[^a-z0-9_]+/).includes(t.name.toLowerCase())).map((t) => t.name);
      if (here.length) return { text: `${here.join(', ')} staat al in je lijst: gebruik het direct.` };
      if (!found.length) return { text: `Niets gevonden voor “${query.slice(0, 80)}”. Probeer één ander woord, of een onderdeel: ${parts.map((p) => p.label).join(', ')}. Zonder query krijg je alles op een rij.` };
      const full: string[] = [];
      const more: string[] = [];
      let used = 0;
      for (const t of found) {
        const b = block(t);
        if (full.length && used + b.length > FIND_CHARS) more.push(`${t.name} — ${firstSentence(t.description)}`);
        else {
          full.push(b);
          used += b.length;
        }
      }
      const out = [`Gevonden: ${found.length}. Gebruik er een met ${CALL_NAME} (name en args met de velden hieronder).`, '', full.join('\n\n')];
      if (more.length) out.push('', 'Ook gevonden (zoek op de naam voor de velden):', ...more.map((m) => `- ${m}`));
      const guide = await guides(found);
      if (guide) out.push('', guide);
      return { text: out.join('\n'), data: { found: found.map((t) => t.name) } };
    },
  };

  const call: ToolDef = {
    name: CALL_NAME,
    group: 'core',
    risk: 'read',
    internal: true,
    description: `Gebruik een hulpmiddel dat niet in je lijst staat, met zijn naam en zijn velden (uit ${FIND_NAME}). Toestemming en regels gelden als bij elk hulpmiddel.`,
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Bijvoorbeeld browser_open' }, args: { type: 'object', description: 'De velden van dat hulpmiddel', additionalProperties: true } },
      required: ['name'],
    },
    summarize: (a) => words('Hulpmiddel gebruiken: {0}', bareName(a?.name).slice(0, 80)),
    // Only reached when the name is not a tool of this bot (`resolve` turns every other call into the tool itself).
    async run(a) {
      const want = bareName(a?.name);
      if (!want) return { text: `Geef de naam van het hulpmiddel (name). Zoek hem op met ${FIND_NAME}.`, isError: true };
      // A name that is nearly right: the tools that share a word of their name with it ("reminder_maken" → reminder_set).
      const words = (n: string) => n.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
      const asked = words(want);
      const near = rest
        .map((t, i) => ({ name: t.name, i, n: words(t.name).filter((w) => asked.includes(w)).length }))
        .filter((x) => x.n)
        .sort((x, y) => y.n - x.n || x.i - y.i)
        .slice(0, 6)
        .map((x) => x.name);
      // A tool of a part that is switched off for this bot is not there either: the bot can ask for the part.
      const off = restNames.has('request_part') ? ' Staat het onderdeel uit, vraag het dan aan met request_part.' : '';
      return { text: `Onbekend hulpmiddel: ${want.slice(0, 80)}.${near.length ? ` Bedoel je: ${near.join(', ')}?` : ''} Zoek het op met ${FIND_NAME}.${off}`, isError: true };
    },
  };

  byName.set(FIND_NAME, find);
  const listed = [...all.filter((t) => !restNames.has(t.name)), find, call];
  return {
    active: true,
    listed,
    callable: [...all, find, call],
    rest,
    leftOut: parts.map((p) => p.label),
    key: shortKey(listed.map((t) => t.name).join(',')),
    resolve(name, args) {
      if (name !== CALL_NAME) return { name, args };
      const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
      const tool = byName.get(bareName(a.name ?? a.tool).toLowerCase());
      if (!tool) return { name, args };
      let inner = a.args ?? a.arguments ?? a.input ?? a.parameters;
      if (typeof inner === 'string') {
        try {
          inner = JSON.parse(inner);
        } catch {
          inner = { __invalid_json: inner };
        }
      }
      // Fields written next to `name` instead of inside `args`.
      if (inner === undefined || inner === null) {
        const { name: _n, tool: _t, ...others } = a;
        inner = others;
      }
      return { name: tool.name, args: inner };
    },
    async after(tool, args, out, denied) {
      if (!tool || denied || !unguided.has(bundleId(tool))) return out;
      const part = parts.find((p) => p.id === bundleId(tool));
      const extra: string[] = [];
      if (restNames.has(tool.name) && out.isError && checkArgs(tool.parameters, args).error) extra.push(`Velden van ${tool.name}: ${fields(tool)}`);
      // The first use of a part whose tools belong together: the rest of it, so no search step per tool.
      if (part && (TOGETHER.has(part.id) || part.id.startsWith('app:')) && !i.told.has(part.id)) {
        i.told.add(part.id);
        const others = part.tools.filter((t) => t.name !== tool.name);
        const full: string[] = [];
        let used = 0;
        for (const t of others) {
          const b = block(t);
          if (used + b.length > PART_CHARS) break;
          full.push(b);
          used += b.length;
        }
        const names = others.slice(full.length).map((t) => t.name);
        if (others.length) extra.push([`Bij dit onderdeel horen ook (gebruik ze met ${CALL_NAME}):`, ...full, ...(names.length ? [`En: ${names.join(', ')} (velden via ${FIND_NAME}).`] : [])].join('\n\n'));
      }
      return withGuide(tool, out, extra);
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

