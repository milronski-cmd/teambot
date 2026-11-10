import type { Agent, Message, Thread } from '../../core/types.js';
import { frozenContext } from '../../agent/history.js';
import { cleanProfile, type TeamsService } from './service.js';

/**
 * Stable system-prompt blocks about the organisation. No live state, so the prompt cache stays valid until the owner
 * changes teams, leads, roles or access. Teams without access are never named.
 *  - the main bot (hoofdbot): its job (understand, pick the team and bot, hand over with "klaar als", follow up, check
 *    the evidence, report back) and the teams with their lead and bots (with their role);
 *  - with two or more teams: the bot's home team and lead, the teams it may look into or direct, and that every other
 *    team is closed;
 *  - a leader (directs more than one team) and a team lead: how they pass work on and check it.
 * With one team and no main bot nothing is added (one team = calm).
 */
export function teamsPrompt(svc: TeamsService, agent: Agent): string | null {
  if (agent.settings?.sharedRun) return null;
  const mainId = svc.mainOf(agent.user_id);
  const multi = svc.multi(agent.user_id);
  if (!multi && !mainId) return null;
  if (mainId === agent.id) return mainPrompt(svc, agent);
  const parts = [multi ? wallsBlock(svc, agent) : null, leaderBlock(svc, agent), leadBlock(svc, agent)].filter((x): x is string => !!x);
  return parts.length ? parts.join('\n\n') : null;
}

/** "Kim (Technische SEO)" for every active bot of a team, the lead first; the main bot is never listed. */
function botLines(svc: TeamsService, teamId: string, skip: string | null): string[] {
  const t = svc.team(teamId);
  const main = t ? svc.mainOf(t.user_id) : null;
  return svc
    .botsOf(teamId)
    .map((id) => svc.ctx.store.agent(id))
    .filter((a): a is Agent => !!a && !a.archived && a.id !== main && a.id !== skip)
    .sort((a, b) => (a.id === t?.lead_agent_id ? -1 : b.id === t?.lead_agent_id ? 1 : a.name.localeCompare(b.name)))
    .map((a) => `${a.name}${a.role ? ` (${a.role.replace(/\s+/g, ' ').slice(0, 80)})` : ''}${a.id === t?.lead_agent_id ? ' — teamleider' : ''}`);
}

const MAIN_JOB = [
  'Jij bent de hoofdbot: de vaste voordeur van de eigenaar. Je staat boven de teams. De eigenaar praat met jou; jij zorgt dat het werk bij de juiste bot komt en meldt terug. Zo werk je:',
  '1. Begrijp de vraag. Is iets echt onduidelijk, vraag het dan eerst kort na.',
  '2. Kies het team en de bot die erover gaan. Heeft het team een teamleider, geef het werk dan aan de teamleider: die verdeelt het in zijn team en heeft daar het laatste woord. Heeft het team geen teamleider, geef elke taak dan zelf aan de bot wiens rol het best past.',
  '3. Geef het werk met delegate_task. Zet in task de opdracht met alle context die nodig is (de bot ziet dit gesprek niet). Zet in expected_output wanneer het klaar is (“Klaar als: …”) en welk bewijs je terug wilt: een bestand, een link, een verstuurd bericht of een schermafbeelding. Werk dat los van elkaar kan, geef je tegelijk aan verschillende bots.',
  '4. Volg het op. Het resultaat komt vanzelf terug als nieuwe beurt; met delegation_status zie je hoe het ervoor staat. Wacht niet in een lus en vraag niet steeds opnieuw.',
  '5. Controleer het resultaat tegen het “klaar als” en kijk of het bewijs erbij zit. Ontbreekt er iets, stuur het dan terug naar dezelfde bot met wat er nog moet gebeuren. Zonder bewijs is het niet klaar maar “nog te controleren”.',
  '6. Meld in gewone taal terug: wat er is gedaan, door wie, met het bewijs, en wat er nog openstaat. Kan iets niet, zeg dan eerlijk wat en waarom; verzin nooit een resultaat.',
  'Doe het werk van een team of een specialist nooit zelf als er een bot voor is, tenzij de eigenaar je daar uitdrukkelijk om vraagt. Vragen over de teams, de planning of de voortgang beantwoord je wel zelf.',
  'Hoe vaak een opdracht wordt doorgegeven is begrensd: geef het werk daarom zo direct mogelijk aan wie het doet.',
  'Je geeft de teams werk, maar je schrijft niets in hun mappen of kennis; van een team zie je alleen wat je toegang toestaat en wat de bots rapporteren. Neem niets van het ene team mee naar het andere als de taak dat niet echt vraagt.',
];

/** The main bot's block: its job, then the teams it directs with their lead (optional) and bots with their role. */
function mainPrompt(svc: TeamsService, agent: Agent): string {
  const teams = svc.list(agent.user_id);
  const direct = teams.filter((t) => svc.canDirect(agent.id, t.id));
  const read = teams.filter((t) => svc.access(agent.id, t.id) === 'read');
  const lines = ['## Hoofdbot', ...MAIN_JOB, ''];
  const withBots = direct.map((t) => ({ t, bots: botLines(svc, t.id, agent.id) })).filter((x) => x.bots.length);
  if (!withBots.length) lines.push('Er zijn nog geen bots om werk aan te geven. Help de eigenaar dan zelf, en zeg het als een taak beter bij een eigen bot of team past; de eigenaar maakt die zelf.');
  else if (teams.length === 1) lines.push('Bots in je team (met hun rol):', ...withBots[0].bots.map((b) => `- ${b}`));
  else {
    lines.push('Teams die je werk geeft:');
    for (const { t, bots } of withBots) lines.push(`### Team “${t.name}”`, ...bots.map((b) => `- ${b}`));
  }
  for (const t of read) lines.push(`Bij team “${t.name}” mag je alleen meekijken: je leest de teammap, maar je geeft dat team geen taken.`);
  if (teams.length > 1) lines.push('Andere teams zijn afgeschermd: hun bots, mappen en sleutels kun je niet gebruiken.');
  return lines.join('\n');
}

/** A leader directs more than one team: pass work to the lead (or, without one, the bot whose role fits) and check it. */
function leaderBlock(svc: TeamsService, agent: Agent): string | null {
  if (!svc.isLeader(agent.id)) return null;
  const teams = svc.directableTeams(agent.id).map((id) => svc.team(id)).filter((t): t is NonNullable<typeof t> => !!t);
  const names = teams.map((t) => `“${t.name}”`);
  const lines = [
    '## Leider',
    `Je geeft werk aan meer dan één team: ${names.slice(0, -1).join(', ')} en ${names.at(-1)}. Werk voor een team geef je aan de teamleider van dat team; heeft een team geen teamleider, dan aan de bot wiens rol het best past. Gebruik delegate_task met een duidelijk “Klaar als: …” en het bewijs dat je terug wilt. Controleer het resultaat en het bewijs voordat je het teruggeeft aan wie jou het werk gaf. Doe het werk van een team niet zelf als dat team ervoor is.`,
  ];
  for (const t of teams.filter((x) => !x.lead_agent_id)) {
    const bots = botLines(svc, t.id, agent.id);
    if (bots.length) lines.push(`Bots van team “${t.name}” (met hun rol): ${bots.join(', ')}.`);
  }
  return lines.join('\n');
}

/** The team lead: the last word in its team, splits work over its bots and checks it before passing the result up. */
function leadBlock(svc: TeamsService, agent: Agent): string | null {
  const home = svc.team(svc.teamOf(agent.id));
  if (!home || home.lead_agent_id !== agent.id) return null;
  const bots = botLines(svc, home.id, agent.id);
  return [
    '## Teamleider',
    `Jij bent de teamleider van team “${home.name}” en hebt het laatste woord in dit team. Krijg je werk voor het team, verdeel het dan over de bots van je team met delegate_task (elk met een duidelijk “klaar als”), of doe het zelf als dat sneller is. Controleer hun werk voordat je het resultaat teruggeeft, en geef het bewijs mee (een bestand, link of verstuurd bericht).`,
    bots.length ? `Bots van je team (met hun rol): ${bots.join(', ')}.` : 'Je team heeft verder nog geen bots: doe het werk zelf.',
  ].join('\n');
}

/** Two or more teams: the home team and lead, the teams the bot may look into or direct, and that the rest is closed. */
function wallsBlock(svc: TeamsService, agent: Agent): string | null {
  const teams = svc.list(agent.user_id);
  const home = svc.homeOf(agent);
  const ht = teams.find((t) => t.id === home);
  if (!ht) return null;
  const name = (id: string | null) => (id ? svc.ctx.store.agent(id)?.name || '' : '');
  const lines = ['## Teams', `Je hoort bij team “${ht.name}”.${ht.lead_agent_id && ht.lead_agent_id !== agent.id ? ` Teamleider: ${name(ht.lead_agent_id)}.` : ht.lead_agent_id === agent.id ? ' Jij bent de teamleider.' : ''}`];
  const read = teams.filter((t) => t.id !== home && svc.access(agent.id, t.id) === 'read');
  const direct = teams.filter((t) => t.id !== home && svc.access(agent.id, t.id) === 'direct');
  const main = svc.mainOf(agent.user_id);
  for (const t of direct) {
    const bots = svc
      .botsOf(t.id)
      .filter((id) => id !== main)
      .map(name)
      .filter(Boolean);
    lines.push(
      `Je mag team “${t.name}” aansturen: geef de teamleider${t.lead_agent_id ? ` (${name(t.lead_agent_id)})` : ''} of een bot van dat team een taak met delegate_task of ask_bot${bots.length ? `. Bots van dat team: ${bots.join(', ')}` : ''}. Je mag ook meekijken in de teammap van dat team, maar je schrijft er niets.`,
    );
  }
  for (const t of read) lines.push(`Je mag meekijken bij team “${t.name}”: je leest de teammap, maar je schrijft er niets en je geeft dat team geen taken.`);
  lines.push('Andere teams zijn afgeschermd: hun bots, mappen en sleutels kun je niet gebruiken. Neem nooit iets uit het ene team mee naar het andere als dat niet nodig is voor de taak.');
  return lines.join('\n');
}

/** The business profile as one block, or null when nothing is filled in. */
export function profileBlock(teamName: string, p: any): string | null {
  const c = cleanProfile(p);
  if (!c.company && !c.about && !c.tone && !c.rules) return null;
  const lines = [`Bedrijfsprofiel van team “${teamName}” (geldt voor al je werk voor dit team):`];
  if (c.company) lines.push(`Bedrijf: ${c.company}`);
  if (c.about) lines.push(`Wat het bedrijf doet: ${c.about}`);
  if (c.tone) lines.push(`Toon: ${c.tone}`);
  if (c.rules) lines.push(`Regels: ${c.rules}`);
  return lines.join('\n');
}

/** How far back the turn context looks for the same profile before repeating it. */
const PROFILE_WINDOW = 20;

/**
 * Per-turn context: the home team's business profile. It is repeated only when this bot has not had this exact
 * profile in the recent, not yet summarised part of the conversation (a fresh chat, a changed profile, after a
 * summary, or every ~10 turns), so long chats do not carry it in every message.
 */
export function profileContext(svc: TeamsService, agent: Agent, thread: Thread, input: Message | null): string | null {
  if (agent.settings?.sharedRun) return null;
  const home = svc.homeOf(agent);
  const team = svc.team(home);
  if (!team) return null;
  const block = profileBlock(team.name, team.profile);
  if (!block) return null;
  if (!input) return block;
  const after = Math.max(Number(thread.meta?.summaryUpTo) || 0, (Number(thread.meta?.contextFromSeq) || 1) - 1);
  const recent = svc.ctx.store.messages(thread.id, { limit: PROFILE_WINDOW, beforeSeq: input.seq }).filter((m) => m.seq > after && (m.role === 'user' || m.role === 'system'));
  if (recent.some((m) => frozenContext(m, agent.id).includes(block))) return null;
  return block;
}
