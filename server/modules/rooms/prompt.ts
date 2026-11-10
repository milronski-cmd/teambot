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

/** Stable additions to the system prompt (no timestamps, no live states): room context or delegation brief. */
export function systemPromptFor(s: RoomService, board: Board, agent: Agent, thread: Thread): string | null {
  const room = s.roomForThread(thread);
  if (thread.kind === 'delegation') {
    const d = thread.meta?.delegation || {};
    const from = s.agentName(d.from);
    if (thread.meta?.dm)
      return `## Bot-tot-botgesprek\nDit is een direct gesprek tussen ${from} en jou (${agent.name}), los van andere gesprekken. Beantwoord de berichten van ${from} beknopt en concreet; je antwoord gaat terug naar ${from}. De eigenaar kan meelezen.${room ? ` Dit gesprek hoort bij de groep “${room.name}”.` : ''}`;
    return [
      '## Gedelegeerde subtaak',
      `${from} heeft je een afgebakende subtaak gegeven. Je ziet het oorspronkelijke gesprek niet: werk met wat in de opdracht staat.`,
      `Lever in je laatste antwoord het volledige resultaat in het gevraagde formaat; dat antwoord gaat automatisch terug naar ${from}.`,
      'Noem bij het resultaat je bewijs (bestand, link, uitvoer van een opdracht). Een controle met een frisse blik kijkt je resultaat na voordat het terug gaat.',
      'Lukt het niet, begin je laatste antwoord dan met "Kon niet:" en zeg eerlijk waarom. Verzin nooit een resultaat.',
      `Geef de taak niet terug aan ${from} en vraag de gebruiker alleen iets als het echt niet anders kan. Doe niets buiten de opdracht.`,
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
    'Spreek een andere bot alleen met @naam aan als dat echt nodig is: elke vermelding kost een beurt en het aantal beurten per bericht is begrensd. Een bot die al in de keten zit, wordt niet opnieuw gewekt (geen lussen).',
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
  handoff: 'Het werk is aan jou overgedragen; jij bent nu taakeigenaar.',
  broadcast: 'Een andere bot vraagt meerdere bots tegelijk om een bijdrage.',
  resume: 'Je bent hervat na een pauze.',
};

/** Per-turn room status (frozen per bot into the input message, never shared with other bots). */
export function turnContextFor(s: RoomService, agent: Agent, thread: Thread, input: Message | null): string | null {
  if (input?.parts?.kind === 'bot_ask') {
    // An asynchronous message from another bot (ask_bot), delivered in this bot's own chat.
    const from = s.agentName(input.parts.from);
    const owner = s.userName(thread.user_id);
    return input.parts.reply
      ? `Dit bericht komt van de bot ${from}, niet van ${owner}. Je antwoord in deze beurt gaat automatisch terug naar ${from}, die daarmee wordt gewekt. Antwoord concreet en volledig in één keer; stuur ${from} geen wedervraag via ask_bot (dat wordt geweigerd om lussen te voorkomen) maar noem in je antwoord wat je nog nodig hebt.`
      : `Dit is een melding van de bot ${from}, niet van ${owner}; er gaat geen antwoord terug. Doe wat nodig is en houd je antwoord kort.`;
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
    const used = s.turnsUsed(room.user_id, team);
    parts.push(`Botbeurten voor dit bericht: ${used} van ${s.turnCap(l, team)} gebruikt.${team.path.length > 1 ? ` Keten: ${team.path.map((p) => s.agentName(p)).join(' → ')}.` : ''}`);
  }
  return parts.filter(Boolean).join('\n');
}
