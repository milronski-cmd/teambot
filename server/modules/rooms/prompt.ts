import type { Agent, Message, Thread } from '../../core/types.js';
import type { Board } from './board.js';
import type { RoomService } from './service.js';
import type { TeamMeta } from './types.js';
import { wallPrompt } from './walls.js';

const MODE_TEXT: Record<string, string> = {
  lead: 'De lead (of de huidige taakeigenaar) beantwoordt berichten die niemand specifiek aanspreken en verdeelt het werk. Andere bots reageren als ze worden aangesproken of een taak krijgen.',
  round_robin: 'Om de beurt: de bots antwoorden na elkaar op hetzelfde bericht. Je ziet wat de bots vóór jou schreven; vul aan in plaats van te herhalen.',
  everyone: 'Iedereen: alle bots antwoorden tegelijk. Houd je bijdrage kort en vanuit je eigen rol.',
  mention: 'Alleen op vermelding: een bot antwoordt alleen als hij met @naam wordt aangesproken (of als iemand op zijn bericht reageert).',
};

/** At most this many colleagues by name in the prompt (the rest is counted). */
const MAX_COLLEAGUES = 40;

/** The bots this bot can give work to: the owner's other bots it may reach (teams: its own team and teams it directs). */
export function colleagues(s: RoomService, agent: Agent): Agent[] {
  return s.ctx.store
    .agents(agent.user_id)
    .filter((a) => a.id !== agent.id && !a.archived && !a.settings?.sharedRun && !s.orch.teamError(agent.id, a.id));
}

/**
 * "Samenwerken met je team": who the colleagues are (with their role) and the plain rules for working together. For
 * every bot that has colleagues and the team tools, in every conversation, so each bot knows who does what and uses
 * them. delegate_task is always in a bot's list; ask_bot and the task board it finds on demand (tools/selection.ts).
 * Stable: it changes only when the owner's bots change.
 */
export function teamworkPrompt(s: RoomService, agent: Agent, thread: Thread): string | null {
  // Without tools (chat) or with reading only (readonly) a bot cannot give work: the prompt never names a tool it lacks.
  if (agent.settings?.sharedRun || agent.access_mode === 'chat' || agent.access_mode === 'readonly') return null;
  if (Array.isArray(agent.tool_groups) && !agent.tool_groups.includes('team')) return null;
  const room = s.roomForThread(thread);
  // A group with other people in it: its bots only reach each other (orchestration.ts resolveBot).
  const inRoom = room && s.humanMembers(room).length ? new Set(s.botMembers(room).map((m) => m.ref_id)) : null;
  const others = colleagues(s, agent).filter((a) => !inRoom || inRoom.has(a.id));
  if (!others.length) return null;
  const owner = s.userName(agent.user_id);
  const main = !!s.ctx.services.teams?.isMain?.(agent.id);
  const lines = ['## Samenwerken met je team'];
  // The main bot already has its teams and bots listed (module teams); in a group the members are listed below.
  if (main) lines.push('Je werkt met een team van bots; wie dat zijn staat hierboven.');
  else {
    lines.push(`Je bent niet alleen: je werkt in een team van bots voor ${owner}. Je collega's (met hun rol):`);
    for (const a of others.slice(0, MAX_COLLEAGUES)) lines.push(`- ${a.name}${a.role ? ` — ${a.role.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`);
    if (others.length > MAX_COLLEAGUES) lines.push(`- en nog ${others.length - MAX_COLLEAGUES} andere bots.`);
  }
  lines.push(
    'Zo werk je samen:',
    '- Werk dat bij de rol van een collega hoort, geef je aan die collega met delegate_task (hij werkt in een eigen gesprek); doe het niet zelf en laat het niet liggen. Geen hulpagent of deeltaak van je eigen programma: alleen een collega heeft de rol, het geheugen en de toegang die erbij horen. Voor een losse vraag of melding in zijn eigen chat is er ask_bot.',
  );
  // What to give a colleague along and that the answer comes back by itself is in the definition of delegate_task; how
  // the main bot follows work up and reports is in its own block (module teams). Neither is said twice.
  if (!main)
    lines.push(
      '- Kijk het resultaat na als het terugkomt, en stuur het terug als het niet af is.',
      `- Meld ${owner} wat er is gedaan en door wie, en wat nog openstaat. Zeg nooit dat iets loopt of klaar is als je het niet aan een collega hebt gegeven of zelf hebt gedaan.`,
    );
  lines.push(
    `- Zet werk nooit als "te doen" bij jezelf of bij ${owner} als een collega het kan doen: een taak op het takenbord krijgt een eigenaar die hem kan doen. Alleen wat echt alleen ${owner} kan (inloggen, betalen, een besluit nemen) zet je bij ${owner}.`,
  );
  if (room && thread.id === room.thread_id) lines.push('In dit groepsgesprek kun je een collega die lid is ook met @naam aanspreken; hij antwoordt dan hier.');
  return lines.join('\n');
}

/** Stable additions to the system prompt (no timestamps, no live states): room context or delegation brief, then teamwork. */
export function systemPromptFor(s: RoomService, board: Board, agent: Agent, thread: Thread): string | null {
  const parts = [contextPrompt(s, board, agent, thread), teamworkPrompt(s, agent, thread)].filter((x): x is string => !!x);
  return parts.length ? parts.join('\n\n') : null;
}

function contextPrompt(s: RoomService, board: Board, agent: Agent, thread: Thread): string | null {
  const room = s.roomForThread(thread);
  if (thread.kind === 'delegation') {
    const d = thread.meta?.delegation || {};
    const from = s.agentName(d.from);
    if (thread.meta?.dm)
      return `## Bot-tot-botgesprek\nDit is een direct gesprek tussen ${from} en jou (${agent.name}), los van andere gesprekken. Beantwoord de berichten van ${from} beknopt en concreet; je antwoord gaat terug naar ${from}. De eigenaar kan meelezen.${room ? ` Dit gesprek hoort bij de groep “${room.name}”.` : ''}`;
    return [
      '## Gedelegeerde subtaak',
      `${from} heeft je een afgebakende subtaak gegeven. Je ziet het oorspronkelijke gesprek niet: werk met wat in de opdracht staat.`,
      `Neem de tijd die het werk vraagt en maak het af. Lever in je laatste antwoord het volledige resultaat in het gevraagde formaat: alleen dat laatste antwoord gaat automatisch terug naar ${from}, niet wat je onderweg schreef. Zet er dus alles in wat ${from} moet weten.`,
      'Noem bij het resultaat je bewijs (bestand, link, uitvoer van een opdracht). Een controle met een frisse blik kijkt je resultaat na voordat het terug gaat.',
      'Lukt het niet, begin je laatste antwoord dan met "Kon niet:" en zeg eerlijk waarom. Verzin nooit een resultaat.',
      `Geef de taak niet terug aan ${from} en vraag de gebruiker alleen iets als het echt niet anders kan. Doe niets buiten de opdracht. Hoort een deel van het werk bij de rol van een andere collega, dan mag je dat deel aan die collega geven.`,
      room ? `Deze subtaak hoort bij de groep “${room.name}”; de leden van die groep kunnen meelezen.` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (!room || thread.id !== room.thread_id) return null;
  const bots = s.botMembers(room);
  const people = s.humanMembers(room);
  const me = s.botMember(room, agent.id);
  const lines = [
    `## Groepsgesprek “${room.name}”`,
    `Je (${agent.name}) zit in een gedeeld groepsgesprek met mensen en andere AI-bots. Berichten van anderen staan als “[Naam]: tekst”. Antwoord alleen namens jezelf; doe je nooit voor als een andere bot of een mens en schrijf geen “[Naam]:” voor je antwoord.`,
    `Werkwijze: ${MODE_TEXT[room.mode] || room.mode}`,
    'Bots in de groep:',
    ...bots.map((b) => {
      const a = s.ctx.store.agent(b.ref_id);
      const tags = [room.lead_agent_id === b.ref_id ? 'lead' : '', s.perms(b).respond === 'mention' ? 'alleen op vermelding' : ''].filter(Boolean).join(', ');
      return `- ${a?.name}${a?.role ? ` — ${a.role}` : ''}${tags ? ` (${tags})` : ''}${b.ref_id === agent.id ? ' ← jij' : ''}`;
    }),
    `Mensen: ${[`${s.userName(room.user_id)} (eigenaar)`, ...people.map((p) => `${s.userName(p.ref_id)} (${p.role === 'guest' ? 'gast' : 'lid'})`)].join(', ')}.`,
  ];
  if (room.lead_agent_id === agent.id)
    lines.push(
      'Jij bent de lead: begrijp de vraag, verdeel werk (delegate_task voor afgebakende subtaken, broadcast om meerdere bots tegelijk iets te vragen, of spreek een lid aan met @naam), houd het takenbord bij (task_create/task_update) en vat de resultaten samen voor de mensen. Stel nieuwe leden alleen voor met propose_member; een mens beslist.',
    );
  else if (me) lines.push('Als je werk beter bij een ander lid past, spreek die aan met @naam of draag het over met handoff. Doe alleen wat binnen jouw rol valt.');
  lines.push(
    'Heb je een andere bot nodig, spreek hem dan aan met @naam: hij krijgt een beurt en antwoordt hier. Noem een bot niet met @naam als je alleen over hem praat. Een bot die al in de keten zit, wordt niet opnieuw gewekt (geen lussen): bedank of bevestig dus niet met @naam.',
    'Privacy: alles hier is zichtbaar voor alle leden. Deel geen inhoud uit privégesprekken of uit je privégeheugen, tenzij iemand er hier uitdrukkelijk om vraagt en het passend is. Geheimen en sleutels deel je nooit.',
    'Goedkeuringen en vragen (ask_user) gaan altijd naar de eigenaar van de bots; een andere bot kan ze niet beantwoorden en jij kunt ze niet namens iemand beantwoorden.',
  );
  const wall = wallPrompt(s, room, agent);
  if (wall) lines.push(wall);
  const org = board.orgChart(room.team_id);
  if (org) lines.push('', '### Organisatie', org);
  if (room.instructions.trim()) lines.push('', '### Groepsinstructies', room.instructions.trim());
  return lines.join('\n');
}

const WHY: Record<string, string> = {
  turn: 'Je bent aangesproken in de groep.',
  sequence: 'Je bent aan de beurt in de volgorde.',
  mention: 'Een andere bot noemde je met @naam.',
  followup: 'Een gedelegeerde taak, bericht of broadcast is afgerond; verwerk het resultaat (of de resultaten).',
  ask: 'Een andere bot stuurde je een bericht; je antwoord gaat automatisch terug.',
  delegation: 'Een andere bot gaf je een taak; je laatste antwoord gaat automatisch terug.',
  handoff: 'Het werk is aan jou overgedragen; jij bent nu taakeigenaar.',
  broadcast: 'Een andere bot vraagt meerdere bots tegelijk om een bijdrage.',
  resume: 'Je bent hervat na een pauze.',
};

/**
 * The main bot, on a message of its owner: who its colleagues are and that their work goes to them, right next to the
 * message. The same rule stands in its system prompt, but a small model then still does a small job itself (seen with
 * a real model, 12 nov): said beside the request it gives the work to the colleague.
 */
export function routeReminder(s: RoomService, agent: Agent, thread: Thread, input: Message | null): string | null {
  if (!input || input.role !== 'user' || input.parts?.kind) return null;
  if (thread.kind === 'delegation' || thread.user_id !== agent.user_id) return null;
  if (!s.ctx.services.teams?.isMain?.(agent.id)) return null;
  if (agent.settings?.sharedRun || agent.access_mode === 'chat' || agent.access_mode === 'readonly') return null;
  if (Array.isArray(agent.tool_groups) && !agent.tool_groups.includes('team')) return null;
  const others = colleagues(s, agent);
  if (!others.length) return null;
  const names = others.slice(0, 12).map((a) => `${a.name}${a.role ? ` (${a.role.replace(/\s+/g, ' ').slice(0, 60)})` : ''}`);
  return `Je collega's: ${names.join(', ')}${others.length > 12 ? ` en nog ${others.length - 12}` : ''}. Hoort deze opdracht bij de rol van een collega, geef haar dan nu door met delegate_task (met alle context, een “klaar als” en het bewijs dat je terug wilt) en doe haar niet zelf, ook niet als ze klein is. Een vraag aan jou zelf beantwoord je zelf.`;
}

/** Per-turn room status (frozen per bot into the input message, never shared with other bots). */
export function turnContextFor(s: RoomService, agent: Agent, thread: Thread, input: Message | null): string | null {
  if (input?.parts?.kind === 'bot_ask') {
    // An asynchronous message from another bot (ask_bot), delivered in this bot's own chat.
    const from = s.agentName(input.parts.from);
    const owner = s.userName(thread.user_id);
    if (input.parts.taskId)
      return `Deze taak komt van de bot ${from}, niet van ${owner}. Begin er nu aan en maak hem af; neem de tijd die het werk vraagt. Alleen je laatste antwoord in deze beurt gaat automatisch terug naar ${from}, die daarmee wordt gewekt: zet daarin wat je deed, het bewijs en wat er nog openstaat. Stuur ${from} geen wedervraag via ask_bot (dat wordt geweigerd om lussen te voorkomen).`;
    return input.parts.reply
      ? `Dit bericht komt van de bot ${from}, niet van ${owner}. Alleen je laatste antwoord in deze beurt gaat automatisch terug naar ${from}, die daarmee wordt gewekt; wat je onderweg schrijft niet. Doe eerst wat gevraagd is (neem de tijd die het vraagt) en antwoord dan concreet en volledig in één keer; stuur ${from} geen wedervraag via ask_bot (dat wordt geweigerd om lussen te voorkomen) maar noem in je antwoord wat je nog nodig hebt.`
      : `Dit is een melding van de bot ${from}, niet van ${owner}. Doe wat nodig is. Je laatste antwoord komt als notitie bij ${from}: zeg daarin kort wat je deed, of eerlijk wat niet lukte.`;
  }
  const room = s.roomForThread(thread);
  if (!room || thread.id !== room.thread_id) return null;
  const run = s.ctx.store.one<any>("SELECT * FROM runs WHERE thread_id = ? AND agent_id = ? AND status IN ('running','queued') ORDER BY created_at DESC LIMIT 1", thread.id, agent.id);
  const team = run ? (s.ctx.store.decode<any>('runs', run).meta?.team as TeamMeta | undefined) : undefined;
  const states = s
    .botMembers(room)
    .filter((b) => b.ref_id !== agent.id)
    .map((b) => `${s.agentName(b.ref_id)}: ${b.paused ? 'gepauzeerd' : { idle: 'beschikbaar', queued: 'in de wachtrij', running: 'bezig', waiting: 'wacht op een mens', error: 'fout bij laatste beurt', timeout: 'time-out bij laatste beurt', paused: 'gepauzeerd', limit: 'daglimiet bereikt' }[b.state] || b.state}`);
  const owner = room.owner_agent_id || room.lead_agent_id;
  const l = s.limits(room);
  const parts = [`Groepsstatus: ${owner ? `taakeigenaar ${s.agentName(owner)}` : 'geen taakeigenaar'}${states.length ? ' · ' + states.join(' · ') : ''}.`];
  if (team) {
    parts.push(WHY[team.kind] || '');
    // The count only when the end is in sight: a bot that reads "3 van 200" every turn becomes careful for nothing.
    const used = s.turnsUsed(room.user_id, team);
    const cap = s.turnCap(l, team);
    const chain = team.path.length > 1 ? `Keten: ${team.path.map((p) => s.agentName(p)).join(' → ')}.` : '';
    if (cap > 0 && used >= cap * 0.8) parts.push(`Botbeurten voor dit bericht: ${used} van ${cap} gebruikt. ${chain}`.trim());
    else if (chain) parts.push(chain);
  }
  return parts.filter(Boolean).join('\n');
}
