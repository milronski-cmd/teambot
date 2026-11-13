import type { Agent, Ctx, Run, Thread, ToolDef, ToolRisk } from '../../core/types.js';
import { toolError } from '../../tools/registry.js';
import { inputLine } from '../../core/util.js';
import { turnFromOwner } from '../../agent/owner-turn.js';
import type { TeamMeta } from '../rooms/types.js';
import { askYesNo } from '../../tools/builtin/selfserve.js';
import { listText } from '../../core/i18n.js';
import { CHANGE_PROPS, applyBotChange, asksChange, changesSomething, planBotChange, settingsLines } from './botpatch.js';
import { callAsUser } from './inner.js';
import { FLAT_SCHEDULE_FIELDS, FLAT_SCHEDULE_PROPS } from '../routines/schedule.js';
import { canonicalJson } from '../../tools/broker.js';
import { words } from '../../../shared/i18n-core.js';

/**
 * Every bot can adjust ITSELF, in the chat, without anyone opening a screen (owner, 11 nov: "de bot kan zich niet eens
 * zelf aanpassen"):
 *  - my_settings   look at or change its own name, instructions, role, description, model and thinking level, parts, skills,
 *                  connected apps and how much it reports to the owner (botpatch.ts: the same checks as the screens);
 *  - my_routines   its own routines by name: list, pause, resume, run now, change, delete (it makes one with
 *                  routine_create). The same routes teambot_do reaches (manage.ts); what this adds is that a bot
 *                  pauses, starts or drops its OWN routine without a card in a turn nobody typed (a routine that stops
 *                  itself when its job is done).
 * Its memory it already keeps itself (memory_remember, memory_update, memory_forget); everything else of TeamBot's
 * screens it reaches with teambot_find and teambot_do.
 *
 * What stays with the owner: more access than the bot has now (a higher access level, a part it does not have, sending
 * to others without asking) is asked on a card, and the owner's own rules are not touched here (propose_rule asks him).
 *
 * This file also holds the two rules every tool that changes TeamBot for a bot follows (my_settings, my_routines, the
 * main bot's bot_settings, teambot_do):
 *  - whose conversation (`notOwnersTalk`): only in a conversation of the owner himself, not for someone who writes in
 *    through a channel;
 *  - whose word (`askedByOwner`): a change is applied straight away when the work began with a message the owner
 *    typed himself: his own turn, and what follows from it (work he had a bot hand on, the turn that brings a
 *    colleague's result back, a turn that goes on where his stopped). Work that began with anything else (a routine,
 *    a webhook, a message from someone else, a turn TeamBot started itself) may have been set off by text a bot READ
 *    (a web page, a file, a mail), and what it changed would stay for good. There the change becomes a proposal: one
 *    card for the owner, applied only after his Ja. The same for every bot, the main bot too.
 */
export const SELF_SETTINGS = 'my_settings';
export const SELF_ROUTINES = 'my_routines';

/**
 * The one place for what the owner told a bot: its own Werknotities, under "Opdrachten van de eigenaar" (the memory's
 * rule). Its prompt (index.ts) and my_settings both name this place, in these words; its instructions stay the owner's
 * own text, and its name and model are settings (my_settings).
 */
export const OWNER_ORDERS_PLACE = 'je werknotities onder “Opdrachten van de eigenaar”';


/**
 * Why this conversation may not change the bot (one sentence), or null: only the owner's own conversations may. Not
 * his own: a conversation of someone else (a shared bot with a member), a channel conversation with anyone but the
 * owner himself, and a conversation someone else reads along in: a group with an invited person (on a server), and
 * every subtask of such a group, whose outcome goes back into the group.
 */
export function notOwnersTalk(ctx: Ctx, agent: Agent, thread: Thread): string | null {
  const no = `Geweigerd door TeamBot: ${agent.name} past zichzelf alleen aan in een gesprek met zijn eigenaar.`;
  if (agent.settings?.sharedRun || thread.user_id !== agent.user_id) return no;
  try {
    // Who sees a conversation is the core's own list (ChatService.audience; rooms keeps it equal to who is in the group).
    const others = (t: Thread | null | undefined) => !t || ctx.chat.audience(t).some((u) => u !== agent.user_id);
    if (others(thread)) return no;
    if (thread.room_id) {
      const room = ctx.services.rooms?.roomForThread?.(thread);
      if (!room || room.user_id !== agent.user_id || others(ctx.store.thread(room.thread_id))) return no;
    }
    const m = ctx.services.channels?.manager;
    const conv = m?.conversationByThread?.(thread.id);
    if (conv) {
      const b = m.binding(conv.binding_id);
      if (!b || !m.isOwnerConversation(b, conv)) return no;
    }
  } catch {
    return no;
  }
  return null;
}

/** How far back a turn is followed to where its work began (far more than the hops a chain of bots may make). */
const MAX_BACK = 12;

/**
 * Did the work this turn belongs to begin with a message the owner typed himself? Decided by where the CHAIN began,
 * the same for every bot (the main bot too):
 *  - this turn itself was started by his own message: the one rule of agent/owner-turn.ts (`turnFromOwner`);
 *  - work between bots (rooms: every turn of a chain carries `meta.team.chainId`, the id of the first request of that
 *    chain): the turn that first request started decides, with that same rule. So three bots deep, and on the turn that
 *    brings a colleague's result back, it is still the owner's word when he typed the request the chain began with;
 *  - a turn that goes on where an earlier one stopped (a retry after a limit or a pause records which turn:
 *    `meta.resumeOf`, `meta.limitRetryOf`; "Ga verder waar je gebleven was" has trigger `resume` and continues this
 *    bot's turn right before it in this conversation): the turn it continues decides.
 *  - a turn in a group that the owner's own message there started (rooms records who wrote the chain's first message).
 * Everything else began with something the owner did not type: a routine, a webhook, a feed, a message from someone
 * else or from a bot in a group, a turn TeamBot started itself. Unknown is no.
 */
export function chainFromOwner(ctx: Ctx, run: Run | null | undefined, thread: Thread | null | undefined, back = 0): boolean {
  if (!run || !thread || back > MAX_BACK) return false;
  // A routine posts its message as the owner (routines/engine.ts), but its words are the routine's: a turn on it, also a
  // retry of it (after a limit, or "opnieuw"), is not his typed word.
  const byRoutine = !!(run.input_message_id && (ctx.store.message(run.input_message_id)?.parts as { routine?: unknown } | undefined)?.routine);
  if (!byRoutine && turnFromOwner(ctx.store, run, thread)) return true;
  // A turn in a group, started by a message there: rooms records that message as the first request of the chain and
  // who wrote it (rooms/service.ts, `chainId: m.id, requestedBy: m.author_id`). When that is the owner's own typed
  // message in this conversation, by the one rule of owner-turn.ts, it is his word like a turn in his own chat.
  const team = run.meta?.team as TeamMeta | undefined;
  if (!byRoutine && team?.chainId && team.chainId === run.input_message_id && team.requestedBy === run.user_id && String(run.trigger || '').startsWith('team:') && turnFromOwner(ctx.store, { ...run, trigger: 'user' }, thread)) return true;
  // Only the owner's own turns count, in his own conversations (never a turn in someone else's conversation).
  const of = (id: unknown): Run | null => {
    const r = typeof id === 'string' && id ? ctx.store.run(id) : null;
    return r && r.id !== run.id && r.user_id === run.user_id ? r : null;
  };
  const from = (r: Run | null) => !!r && chainFromOwner(ctx, r, ctx.store.thread(r.thread_id), back + 1);
  const chainId = (run.meta?.team as TeamMeta | undefined)?.chainId;
  if (chainId) {
    // The first request is a message (the turn it started first, in its conversation) or, for a turn that had no
    // message, that turn itself.
    const asked = ctx.store.message(chainId);
    const first = asked ? ctx.store.one<{ id: string }>('SELECT id FROM runs WHERE thread_id = ? AND input_message_id = ? ORDER BY created_at, rowid LIMIT 1', asked.thread_id, asked.id) : null;
    return from(of(asked ? first?.id : chainId));
  }
  const earlier = of(run.meta?.resumeOf) || of(run.meta?.limitRetryOf);
  if (earlier) return from(earlier);
  if (run.trigger !== 'resume') return false;
  const before = ctx.store.one<{ id: string }>(
    'SELECT id FROM runs WHERE thread_id = ? AND agent_id = ? AND rowid < (SELECT rowid FROM runs WHERE id = ?) ORDER BY rowid DESC LIMIT 1',
    run.thread_id,
    run.agent_id,
    run.id,
  );
  return from(of(before?.id));
}

/**
 * Whose word a change is made on. The owner's: the work began with a message he typed himself (`chainFromOwner`), or a
 * human approved this very call on a card (`t.approved`). Otherwise the change is put to him on a card first.
 *
 * There is no exception per routine or source: a routine stores nothing that says it may change TeamBot (only what
 * narrows a run: a lower access level, fewer parts, tools it may not use), so for what a routine or another source
 * started the card is the rule.
 */
export const askedByOwner = (ctx: Ctx, t: { run: any; thread: Thread; approved?: boolean }) => t.approved === true || chainFromOwner(ctx, t.run, t.thread);
/** The card for a change nobody asked for in this turn. Resolves to an error sentence for the bot, or null after a Ja. */
export async function proposeToOwner(t: Parameters<typeof askYesNo>[0], tool: string, input: any, who: string, what: string[]): Promise<string | null> {
  const r = await askYesNo(t, tool, input, `${who} wil dit veranderen zonder dat jij er in dit gesprek om vroeg: ${what.join('; ')}. Goed?`);
  return r.yes ? null : 'Niet veranderd. Dit was geen vraag van je eigenaar zelf in dit gesprek, dus TeamBot heeft het hem als voorstel op een kaart gevraagd en hij zei geen ja. Ga verder met je werk; probeer het niet opnieuw.';
}

/** The fields of botpatch.ts without their descriptions (the tool's own text explains them once). */
const SLIM_PROPS = Object.fromEntries(Object.entries({ name: { type: 'string' }, ...CHANGE_PROPS }).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([f]) => f !== 'description'))]));

export function selfTools(ctx: Ctx): ToolDef[] {
  const self = (agent: Agent) => ctx.store.agent(agent.id) || agent;
  // Its own name too: "voortaan heet je Max" is said to the bot itself, in the owner's own conversation. A part it
  // switches on for itself while it still asks counts as more access (the owner says Ja or Nee).
  const plan = (a: any, agent: Agent) => planBotChange(ctx, self(agent), a, { rename: true, parts: true });

  const routineOf = (agent: Agent, v: unknown): any | string => {
    let list: any[] = [];
    try {
      list = ctx.store.all<any>('SELECT id, name FROM routines WHERE user_id = ? AND agent_id = ? ORDER BY name', agent.user_id, agent.id);
    } catch {
      return 'Routines staan uit in deze TeamBot.';
    }
    const q = inputLine(v, 120).replace(/^[“"']|[”"']$/g, '');
    if (!list.length) return 'Je hebt nog geen routines. Maak er een met routine_create.';
    if (!q) return `Zeg welke routine je bedoelt (routine). Jouw routines: ${list.map((r) => `“${r.name}”`).join(', ')}.`;
    return list.find((r) => r.id === q) || list.find((r) => String(r.name).toLowerCase() === q.toLowerCase()) || `Je hebt geen routine “${q}”. Jouw routines: ${list.map((r) => `“${r.name}”`).join(', ')}.`;
  };
  const ROUTINE_ACTIONS: Record<string, { method: string; path: (id: string) => string; done: string }> = {
    pause: { method: 'POST', path: (id) => `/routines/${id}/pause`, done: 'staat op pauze' },
    resume: { method: 'POST', path: (id) => `/routines/${id}/resume`, done: 'staat weer aan' },
    run: { method: 'POST', path: (id) => `/routines/${id}/run`, done: 'is nu gestart' },
    change: { method: 'PATCH', path: (id) => `/routines/${id}`, done: 'is aangepast' },
    delete: { method: 'DELETE', path: (id) => `/routines/${id}`, done: 'is verwijderd' },
  };

  return [
    {
      name: SELF_SETTINGS,
      group: 'core',
      // Looking is the base (a read-only bot can look); `riskFor` raises every call that changes something.
      risk: 'read',
      impact: (a, agent) => {
        const p = plan(a, agent);
        return 'error' in p || p.widen.length ? 'external' : 'local';
      },
      // Its own settings are its own business: no card in "Vraagt toestemming". More access always asks (danger).
      internal: true,
      riskFor: (a, t): ToolRisk => {
        const p = plan(a, t.agent);
        return 'error' in p || !changesSomething(p) ? 'read' : p.widen.length ? 'danger' : 'write';
      },
      // Short on purpose: the names say what the fields are.
      description:
        `Bekijk of verander je EIGEN instellingen, zoals je naam en model (zonder velden: bekijken, met je instructies). Wat je eigenaar je voortaan opdraagt hoort in ${OWNER_ORDERS_PLACE}, niet hier. ` +
        'instructions vervangt je instructies, instructions_add zet er tekst achter. ' +
        'reasoning: low tot max. skills, apps en parts: namen, of ["alle"]. notifications: wat je je eigenaar meldt. Minder toegang (access) kan altijd; meer vraagt TeamBot je eigenaar. Zeg hem kort wat je veranderde.',
      parameters: { type: 'object', properties: SLIM_PROPS },
      refuse: (a, t) => (asksChange(a) ? notOwnersTalk(ctx, t.agent, t.thread) : null),
      summarize: (a) => {
        const keys = ['name', ...Object.keys(CHANGE_PROPS)].filter((k) => a?.[k] !== undefined && a[k] !== null && a[k] !== '' && !(Array.isArray(a[k]) && !a[k].length));
        return keys.length ? words('Eigen instellingen aanpassen: {0}', keys.join(', ')) : words('Eigen instellingen bekijken');
      },
      async run(a, t) {
        const me = self(t.agent);
        const p = plan(a, me);
        if ('error' in p) return toolError(p.error);
        const data = (b: Agent) => ({ bot: { id: b.id, name: b.name }, access: b.access_mode, parts: b.tool_groups, model: b.model, reasoning: b.reasoning, skills: b.skills });
        if (!changesSomething(p)) return { text: [...(asksChange(a) ? ['Dat staat al zo. Er is niets veranderd.'] : []), ...settingsLines(ctx, me, { instructions: true })].join('\n'), data: data(me) };
        const no = notOwnersTalk(ctx, me, t.thread);
        if (no) return toolError(no);
        const owner = ctx.store.user(me.user_id);
        if (!owner || owner.disabled) return toolError('De eigenaar van deze bot is niet gevonden.');
        if (p.widen.length) {
          if ((p.patch.access_mode === 'full' || p.patch.settings?.fullAccessExternal === true) && owner.role !== 'owner') return toolError('Alleen de eigenaar van deze TeamBot-installatie kan een bot volledige toegang geven.');
          if (!t.approved && !(await askYesNo(t, SELF_SETTINGS, a, `${me.name} wil zelf meer toegang: ${listText(p.widen)}. Goed?`)).yes) return toolError('Je eigenaar wil je niet meer toegang geven. Er is niets veranderd.');
        }
        // Not asked by the owner in this turn: one card (the same one, when more access was already asked above).
        else if (!askedByOwner(ctx, t)) {
          const no = await proposeToOwner(t, SELF_SETTINGS, a, me.name, p.done);
          if (no) return toolError(no);
        }
        const r = await applyBotChange(ctx, owner, p, t.signal);
        if (r.error) return toolError(`Niet (helemaal) gelukt: ${r.error}`);
        const next = p.patch.tool_groups || p.patch.model !== undefined || p.patch.reasoning !== undefined || p.patch.instructions !== undefined || p.patch.name !== undefined ? ' Dit geldt vanaf je volgende beurt.' : '';
        return { text: [`Aangepast: ${p.done.join('; ')}.${next}`, ...settingsLines(ctx, r.bot)].join('\n'), data: data(r.bot) };
      },
    },
    {
      name: SELF_ROUTINES,
      group: 'core',
      risk: 'read',
      impact: 'local',
      internal: true,
      riskFor: (a): ToolRisk => (!inputLine(a?.action, 20) || inputLine(a?.action, 20).toLowerCase() === 'list' ? 'read' : inputLine(a?.action, 20).toLowerCase() === 'delete' ? 'danger' : 'write'),
      // The shape of a change in the description itself, so a small model gets it right the first time.
      description:
        'Je EIGEN routines: list, pause, resume, run, change of delete. change past dezelfde routine aan (niet verwijderen en opnieuw maken); zet in fields alleen wat anders moet: ' +
        'een andere tijd {"times":["09:30"]} (de dagen blijven), andere dagen {"days":["ma","wo"]}, of name, prompt, schedule_kind met at, every_minutes, month_days of cron, zoals bij routine_create. Een nieuwe maak je met routine_create.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', ...Object.keys(ROUTINE_ACTIONS)] },
          routine: { type: 'string', description: 'Naam of id.' },
          fields: { type: 'object', description: 'Bij change: alleen wat anders moet.', properties: { name: { type: 'string' }, prompt: { type: 'string' }, ...FLAT_SCHEDULE_PROPS } },
        },
      },
      refuse: (a, t) => (inputLine(a?.action, 20) && inputLine(a.action, 20).toLowerCase() !== 'list' ? notOwnersTalk(ctx, t.agent, t.thread) : null),
      summarize: (a) => {
        const act = inputLine(a?.action, 20).toLowerCase() || 'list';
        return act === 'list' ? words('Eigen routines bekijken') : words('Eigen routine “{0}”: {1}', inputLine(a?.routine, 80) || '?', act);
      },
      async run(a, t) {
        const me = self(t.agent);
        const owner = ctx.store.user(me.user_id);
        if (!owner || owner.disabled) return toolError('De eigenaar van deze bot is niet gevonden.');
        const act = inputLine(a?.action, 20).toLowerCase() || 'list';
        const call = async (method: string, url: string, body?: any) => {
          const r = await callAsUser(ctx, owner, { method, url, body }, t.signal);
          let json: any = null;
          try {
            json = JSON.parse(r.body.toString('utf8') || 'null');
          } catch {
            /* no JSON */
          }
          return { status: r.status, json };
        };
        if (act === 'list') {
          const r = await call('GET', `/routines?agentId=${encodeURIComponent(me.id)}`);
          if (r.status >= 400) return toolError(`Je routines kon TeamBot niet lezen: ${inputLine(r.json?.error, 300) || r.status}`);
          const mine = (Array.isArray(r.json) ? r.json : r.json?.routines || []).filter((x: any) => x?.agent_id === me.id);
          if (!mine.length) return { text: 'Je hebt nog geen routines. Maak er een met routine_create.', data: { routines: [] } };
          return { text: `Jouw routines (${mine.length}):\n${JSON.stringify(mine, null, 1).slice(0, 10_000)}`, data: { routines: mine.map((x: any) => ({ id: x.id, name: x.name })) } };
        }
        const def = ROUTINE_ACTIONS[act];
        if (!def) return toolError(`Onbekende actie “${act}”. Kies uit: list, ${Object.keys(ROUTINE_ACTIONS).join(', ')}.`);
        const no = notOwnersTalk(ctx, me, t.thread);
        if (no) return toolError(no);
        const row = routineOf(me, a?.routine);
        if (typeof row === 'string') return toolError(row);
        const fields = a?.fields && typeof a.fields === 'object' && !Array.isArray(a.fields) ? { ...a.fields } : {};
        if (act === 'change') {
          // (A schedule field given next to fields instead of in it counts the same.)
          for (const k of FLAT_SCHEDULE_FIELDS) if (a?.[k] !== undefined && fields[k] === undefined) fields[k] = a[k];
          if (!Object.keys(fields).length) return toolError('Geef in fields wat er anders moet aan de routine, bijvoorbeeld {"times":["09:30"]}.');
          // A routine stays with the bot it belongs to: handing it to another bot is the owner's or the main bot's call.
          for (const k of ['agent_id', 'agentId']) {
            if (fields[k] === undefined) continue;
            if (fields[k] !== me.id) return toolError('Een routine blijft bij jou. Hem aan een andere bot geven doet je eigenaar of de hoofdbot. Er is niets veranderd.');
            delete fields[k];
          }
          // What a routine tells the bot to do is an instruction too: the same rule as for its own instructions.
          if (!askedByOwner(ctx, t)) {
            const no = await proposeToOwner(t, SELF_ROUTINES, a, me.name, [`routine “${row.name}” aanpassen (${Object.keys(fields).join(', ')})`]);
            if (no) return toolError(no);
          }
        }
        const before = act === 'change' ? (await call('GET', def.path(row.id))).json : null;
        // A pause says who paused it (the page shows "Gepauzeerd door …").
        const r = await call(def.method, def.path(row.id), act === 'change' ? fields : act === 'pause' ? { by: me.name } : {});
        if (r.status >= 400) return toolError(`Niet gelukt (routine “${row.name}”): ${inputLine(r.json?.error, 400) || `fout ${r.status}`}`);
        const data = { routine: { id: row.id, name: r.json?.name || row.name }, action: act };
        if (act !== 'change') return { text: `Routine “${row.name}” ${def.done}.`, data };
        // What the routine is now, from TeamBot itself: the bot tells the owner that, not what it hoped to set.
        const now = `${inputLine(r.json?.scheduleText, 200)}${r.json?.nextRunText ? `, eerstvolgende keer ${inputLine(r.json.nextRunText, 80)}` : ''}`;
        if (['name', 'prompt', 'timezone', 'schedule', 'options'].every((k) => canonicalJson(before?.[k]) === canonicalJson(r.json?.[k]))) return { text: `Er is niets veranderd aan routine “${row.name}”: hij staat al zo (${now}).`, data };
        return { text: `Routine “${data.routine.name}” ${def.done} (dezelfde routine): ${now}.`, data };
      },
    },
  ];
}
