import type { Agent, Ctx, ToolDef, ToolOutput, ToolRisk } from '../../core/types.js';
import { toolError } from '../../tools/registry.js';
import { inputLine, inputText } from '../../core/util.js';
import { cleanProfile, type TeamRow, type TeamsService } from './service.js';
import { askYesNo } from '../../tools/builtin/selfserve.js';
import { listText } from '../../core/i18n.js';
import { askedByOwner, notOwnersTalk, proposeToOwner } from './selftools.js';
import { ACCESS, type BotChange, CHANGE_PROPS, applyBotChange, asksChange, changesSomething, names, planBotChange, settingsLines } from './botpatch.js';
import { isParseError, type ParsedRule } from '../botrules/parse.js';
import type { StoredRule } from '../botrules/match.js';
import { EFFECT_LABEL, MONEY_REFUSAL, aboutMoney, atLeastAsStrict } from '../botrules/money.js';
import { words, type Words } from '../../../shared/i18n-core.js';

/**
 * Tools of the owner's main bot (hoofdbot) only: it sets up teams and bots for the owner and writes down what the
 * owner tells it about a team. Every other bot is refused with a sentence that says why (and does not get these tools
 * at all: index.ts hands them out through a tool provider). They are 'write' at most: they run without a question
 * at "Automatisch"; nothing here sends, pays or deletes. Two things ask the owner first, at every access level: giving a
 * bot more access than it has now (botpatch.ts `moreAccess`: a higher level, versturen naar anderen) and removing or
 * weakening a rule. A rule about money is never removed or weakened by a bot.
 *  - team_templates       the team templates (id, name, one line, the bots);
 *  - team_from_template   a team from a template: the same install as "Team maken" in the app;
 *  - team_profile         read a team's business profile, or fill it in (also by a template's question keys);
 *  - team_add_bot         one extra bot in a team;
 *  - bot_settings         read or change what the owner would otherwise click for a bot, or for several bots at once:
 *                         access, parts, model, name, role, instructions, skills, apps, notifications (botpatch.ts);
 *  - bot_rules            list, add, change and remove the owner's own rules of a bot or a team (module botrules).
 * Everything else the owner can do in TeamBot's screens the main bot does with teambot_find and teambot_do (manage.ts).
 */
export const MAIN_TOOL_GROUP = 'team';
export const MAIN_TOOL_NAMES = ['team_templates', 'team_from_template', 'team_profile', 'team_add_bot', 'bot_settings', 'bot_rules'] as const;

const PROFILE_FIELDS = ['company', 'about', 'tone', 'rules'] as const;

type SettingsPlan = { error: string } | { changes: BotChange[]; widen: string[]; any: boolean };
/** "alle" in a list of bots. */
const ALL = /^(alle|alles|all|\*)$/i;
type RuleScope = { key: { agentId: string } | { teamId: string }; label: string; bot?: Agent };
type RulesPlan =
  | { error: string }
  | { refuse: string }
  | { kind: 'list'; scope: RuleScope }
  | { kind: 'add'; scope: RuleScope; text: string; parsed: ParsedRule; loosens: boolean }
  | { kind: 'remove'; scope: RuleScope; rule: StoredRule; loosens: boolean }
  | { kind: 'change'; scope: RuleScope; rule: StoredRule; text: string; parsed: ParsedRule; loosens: boolean };

export function mainBotTools(ctx: Ctx, svc: TeamsService): ToolDef[] {
  /** Why this bot may not use these tools (null for the owner's main bot). */
  const refusal = (agent: Agent): string | null =>
    svc.mainOf(agent.user_id) === agent.id ? null : `Geweigerd door TeamBot: alleen de hoofdbot van de eigenaar zet teams en bots op en vult een teamprofiel in. ${agent.name} is niet de hoofdbot. Vraag het de hoofdbot of de eigenaar.`;
  const refuse = (_a: any, t: { agent: Agent }) => refusal(t.agent);
  const templates = () => ctx.services.teamTemplates;

  /** A team of the owner by name or id; without one, the only team there is. */
  const teamOf = (userId: string, v: unknown): TeamRow | string => {
    const list = svc.list(userId);
    const q = inputLine(v, 80).replace(/^[“"']|[”"']$/g, '');
    if (!list.length) return 'Er is nog geen team. Maak er eerst een met team_from_template.';
    if (!q) return list.length === 1 ? list[0] : `Zeg welk team je bedoelt (team). Teams: ${list.map((t) => `“${t.name}”`).join(', ')}.`;
    return list.find((t) => t.id === q) || list.find((t) => t.name.toLowerCase() === q.toLowerCase()) || `Er is geen team “${q}”. Teams: ${list.map((t) => `“${t.name}”`).join(', ')}.`;
  };
  /** A bot of the owner by name or id. */
  const botOf = (userId: string, v: unknown): Agent | string => {
    const list = ctx.store.agents(userId);
    const q = inputLine(v, 80).replace(/^[“"']|[”"']$/g, '');
    const all = list.map((b) => b.name).join(', ');
    if (!q) return `Zeg welke bot je bedoelt (bot). Bots: ${all}.`;
    return list.find((b) => b.id === q) || list.find((b) => b.name.toLowerCase() === q.toLowerCase()) || `Er is geen bot “${q}”. Bots: ${all}.`;
  };

  /** The bots a bot_settings call is about: one (bot), several (bots, or "alle"), or every bot of a team (team). */
  const targetsOf = (a: any, userId: string): Agent[] | string => {
    const list = ctx.store.agents(userId);
    const many = names(a?.bots);
    if (many.length === 1 && ALL.test(many[0])) return list.length ? list : 'Er zijn nog geen bots.';
    if (many.length) {
      const out: Agent[] = [];
      for (const n of many) {
        const bot = botOf(userId, n);
        if (typeof bot === 'string') return bot;
        if (!out.some((x) => x.id === bot.id)) out.push(bot);
      }
      return out;
    }
    if (inputLine(a?.bot, 80)) {
      const bot = botOf(userId, a.bot);
      return typeof bot === 'string' ? bot : [bot];
    }
    if (inputLine(a?.team, 80)) {
      const team = teamOf(userId, a.team);
      if (typeof team === 'string') return team;
      const bots = svc.botsOf(team.id).map((id) => ctx.store.agent(id)).filter((x): x is Agent => !!x && !x.archived);
      return bots.length ? bots : `Team “${team.name}” heeft nog geen bots.`;
    }
    return botOf(userId, '') as string;
  };
  /** What a bot_settings call would change per bot, and what of it gives a bot wider access than it has now. */
  const settingsPlan = (a: any, userId: string): SettingsPlan => {
    const bots = targetsOf(a, userId);
    if (typeof bots === 'string') return { error: bots };
    if (bots.length > 1 && (inputLine(a?.name, 80) || (typeof a?.instructions === 'string' && a.instructions.trim()))) return { error: 'Een naam of volledig nieuwe instructies geef je per bot; voor meerdere bots tegelijk gebruik je instructions_add.' };
    const changes: BotChange[] = [];
    for (const bot of bots) {
      const c = planBotChange(ctx, bot, a, { rename: true });
      if ('error' in c) return { error: bots.length > 1 ? `${bot.name}: ${c.error}` : c.error };
      changes.push(c);
    }
    const widen = [...new Set(changes.flatMap((c) => c.widen))];
    return { changes, widen, any: changes.some(changesSomething) };
  };

  const rulesSvc = () => ctx.services.botRules?._service;
  /** What a bot_rules call would do; `loosens`: it lets the bot do more than now (the owner is asked first). */
  const rulesPlan = (a: any, userId: string): RulesPlan => {
    const rules = rulesSvc();
    if (!rules) return { error: 'Eigen regels staan uit in deze TeamBot.' };
    let scope: RuleScope;
    if (inputLine(a?.bot, 80)) {
      const bot = botOf(userId, a.bot);
      if (typeof bot === 'string') return { error: bot };
      scope = { key: { agentId: bot.id }, label: bot.name, bot };
    } else if (inputLine(a?.team, 80)) {
      const team = teamOf(userId, a.team);
      if (typeof team === 'string') return { error: team };
      scope = { key: { teamId: team.id }, label: `team “${team.name}”` };
    } else return { error: 'Zeg voor welke bot (bot) of welk team (team) de regel geldt.' };
    const action = inputLine(a?.action, 20).toLowerCase() || 'list';
    if (action === 'list') return { kind: 'list', scope };
    const list: StoredRule[] = rules.list(userId, scope.key);
    const find = (): StoredRule | string => {
      const q = inputLine(a?.rule, 400).replace(/^[“"']|[”"']$/g, '');
      if (!q) return 'Zeg welke regel je bedoelt (rule): de tekst van de regel of zijn id.';
      return list.find((r) => r.id === q) || list.find((r) => r.text.toLowerCase() === q.toLowerCase()) || `Die regel staat niet bij ${scope.label}. Regels daar: ${list.map((r) => `“${r.text}”`).join(', ') || 'geen'}.`;
    };
    const parse = (): { text: string; parsed: ParsedRule } | string => {
      const text = inputLine(a?.text, 400);
      const p = rules.parse(userId, text);
      return isParseError(p) ? `Deze regel kan TeamBot zo niet vastleggen: ${p.error}` : { text, parsed: p };
    };
    if (action === 'add') {
      const n = parse();
      if (typeof n === 'string') return { error: n };
      const loosens = n.parsed.effect === 'allow';
      if (loosens && aboutMoney(n.text, n.parsed.match)) return { refuse: MONEY_REFUSAL };
      return { kind: 'add', scope, ...n, loosens };
    }
    if (action === 'remove') {
      const rule = find();
      if (typeof rule === 'string') return { error: rule };
      const loosens = rule.effect !== 'allow';
      if (loosens && aboutMoney(rule.text, rule.match)) return { refuse: MONEY_REFUSAL };
      return { kind: 'remove', scope, rule, loosens };
    }
    if (action === 'change') {
      const rule = find();
      if (typeof rule === 'string') return { error: rule };
      const n = parse();
      if (typeof n === 'string') return { error: n };
      const loosens = !atLeastAsStrict(rule, n.parsed);
      if ((loosens && aboutMoney(rule.text, rule.match)) || (n.parsed.effect === 'allow' && aboutMoney(n.text, n.parsed.match))) return { refuse: MONEY_REFUSAL };
      return { kind: 'change', scope, rule, ...n, loosens };
    }
    return { error: 'Kies een actie: list, add, change of remove.' };
  };
  const ruleLine = (r: StoredRule) => `- “${r.text}” (${EFFECT_LABEL[r.effect]}; id ${r.id})`;

  const botLine = (id: string) => {
    const a = ctx.store.agent(id);
    return a ? `${a.name}${a.role ? ` (${a.role})` : ''}` : '';
  };
  /** The profile and, for a team from a template, the questions that are still open. */
  const profileLines = (userId: string, team: TeamRow): string[] => {
    const p = cleanProfile(team.profile);
    const lines = [`Profiel van team “${team.name}”:`, `- Bedrijf (company): ${p.company || 'nog leeg'}`, `- Wat het doet (about): ${p.about ? p.about.split('\n').join('\n  ') : 'nog leeg'}`, `- Toon (tone): ${p.tone || 'nog leeg'}`, `- Regels (rules): ${p.rules ? p.rules.split('\n').join('\n  ') : 'nog leeg'}`];
    const q = templates()?.questionsFor?.(userId, team.id);
    if (q?.open?.length) lines.push('Nog niet gevraagd (sleutel — vraag); schrijf een antwoord op met answers: { sleutel: antwoord }:', ...q.open.map((x: any) => `- ${x.key} — ${x.label}`));
    else if (q) lines.push('Alle vragen van het sjabloon zijn beantwoord.');
    return lines;
  };

  return [
    {
      name: 'team_templates',
      group: MAIN_TOOL_GROUP,
      risk: 'read',
      description: 'Toon de teamsjablonen: kant-en-klare teams met een teamleider en een paar bots. Gebruik dit voordat je de eigenaar een team voorstelt of er een maakt met team_from_template.',
      parameters: { type: 'object', properties: {} },
      refuse,
      summarize: () => words('Teamsjablonen bekijken'),
      async run(_a, t) {
        const no = refusal(t.agent);
        if (no) return toolError(no);
        const defs: any[] = templates()?.list?.() || [];
        if (!defs.length) return toolError('Teamsjablonen staan uit in deze TeamBot.');
        const lines = defs.map((d) => `- ${d.id} — ${d.name}: ${d.description}\n  Bots: ${d.bots.map((b: any) => `${b.name} (${b.role}${b.lead ? ', teamleider' : ''})`).join(', ')}`);
        return {
          text: `${defs.length} teamsjablonen (id — naam: wat het team doet):\n${lines.join('\n')}\n\nEen team maken: team_from_template met het id.`,
          data: { templates: defs.map((d) => ({ id: d.id, name: d.name, description: d.description, bots: d.bots.map((b: any) => ({ name: b.name, role: b.role, lead: !!b.lead })) })) },
        };
      },
    },
    {
      name: 'team_from_template',
      group: MAIN_TOOL_GROUP,
      risk: 'write',
      impact: 'local',
      description:
        'Maak voor de eigenaar een NIEUW team uit een teamsjabloon (id uit team_templates): het team, de bots en de teamleider staan er meteen. Alleen als de eigenaar om een team vroeg of ja zei op je voorstel; voor één of twee collega’s gebruik je team_add_bot. Routines van de bots staan uit tot de eigenaar ze aanzet. ' +
        'Weet je al antwoorden op de vragen van het sjabloon, geef ze mee in answers; de rest vraag je daarna in het gesprek, één vraag per keer, en schrijf je op met team_profile.',
      parameters: {
        type: 'object',
        properties: {
          template: { type: 'string', description: 'Het id van het sjabloon, bijvoorbeeld “webshop”.' },
          name: { type: 'string', description: 'Naam van het team. Leeg = de naam van het sjabloon.' },
          answers: { type: 'object', description: 'Antwoorden die je al hebt, per sleutel van een vraag van het sjabloon: { sleutel: antwoord }.', additionalProperties: { type: 'string' } },
        },
        required: ['template'],
      },
      refuse,
      summarize: (a) => (inputLine(a?.name, 60) ? words('Team maken uit het sjabloon “{0}”: {1}', inputLine(a?.template, 60) || '?', inputLine(a?.name, 60)) : words('Team maken uit het sjabloon “{0}”', inputLine(a?.template, 60) || '?')),
      async run(a, t) {
        const no = refusal(t.agent);
        if (no) return toolError(no);
        const tpl = templates();
        if (!tpl?.install) return toolError('Teamsjablonen staan uit in deze TeamBot.');
        const id = inputLine(a?.template, 60).toLowerCase();
        const def = tpl.get(id) || (tpl.list() as any[]).find((d) => d.name.toLowerCase() === id);
        if (!def) return toolError(`Er is geen teamsjabloon “${id}”. Sjablonen: ${(tpl.list() as any[]).map((d) => d.id).join(', ')}.`);
        try {
          // The same path as "Team maken" in the app, on the AI the main bot itself works with.
          const out = await tpl.install(t.agent.user_id, def.id, { name: inputLine(a?.name, 60) || undefined, answers: a?.answers, provider_id: t.agent.provider_id || undefined, model: t.agent.model || undefined });
          const team = out.teamId ? svc.team(out.teamId) : null;
          const bots = (out.agents as any[]).map((x) => botLine(x.id)).filter(Boolean);
          const q = team ? tpl.questionsFor(t.agent.user_id, team.id) : null;
          const lines = [`Team “${out.teamName}” is gemaakt.${out.lead ? ` Teamleider: ${out.lead.name}.` : ''}`, `Bots: ${bots.join(', ')}.`, 'Routines van deze bots staan uit tot de eigenaar ze aanzet.'];
          if (q?.open?.length) lines.push('Vraag de eigenaar nu, één vraag per bericht, en schrijf elk antwoord op met team_profile (answers: { sleutel: antwoord }):', ...q.open.map((x: any) => `- ${x.key} — ${x.label}`));
          for (const w of out.warnings || []) lines.push(`Let op: ${w}`);
          return { text: lines.join('\n'), data: { team: team ? { id: team.id, name: team.name } : null, lead: out.lead, bots: (out.agents as any[]).map((x) => ({ id: x.id, name: x.name, role: ctx.store.agent(x.id)?.role || '' })), roomId: out.roomId } };
        } catch (e: any) {
          return toolError(`Het team is niet gemaakt: ${e?.message || e}`);
        }
      },
    },
    {
      name: 'team_profile',
      group: MAIN_TOOL_GROUP,
      risk: 'write',
      impact: 'local',
      // Only looking (no field given) is reading.
      riskFor: (a): ToolRisk => (a?.answers && typeof a.answers === 'object' && Object.keys(a.answers).length) || PROFILE_FIELDS.some((k) => typeof a?.[k] === 'string') ? 'write' : 'read',
      description:
        'Lees het profiel van een team, of schrijf op wat de eigenaar je erover vertelt. Alle bots van het team krijgen het profiel mee. ' +
        'Zonder velden: toont het profiel en welke vragen van het sjabloon nog open staan. ' +
        'Met answers: antwoorden op vragen van het sjabloon, per sleutel ({ sleutel: antwoord }); wat er al stond blijft staan. ' +
        'Met company, about, tone of rules vervang je dat veld zelf (voor een team zonder sjabloon, of om iets te verbeteren). Zet er nooit wachtwoorden of sleutels in.',
      parameters: {
        type: 'object',
        properties: {
          team: { type: 'string', description: 'De naam van het team. Leeg mag als er maar één team is.' },
          answers: { type: 'object', description: 'Antwoorden per sleutel van een vraag van het sjabloon.', additionalProperties: { type: 'string' } },
          company: { type: 'string', description: 'Naam van het bedrijf (of voor wie het team werkt).' },
          about: { type: 'string', description: 'Wat het bedrijf doet, of waar het team mee helpt.' },
          tone: { type: 'string', description: 'De toon waarin het team schrijft.' },
          rules: { type: 'string', description: 'Regels en afspraken voor het team.' },
        },
      },
      refuse,
      summarize: (a) => {
        const what = [...Object.keys(a?.answers && typeof a.answers === 'object' ? a.answers : {}), ...PROFILE_FIELDS.filter((k) => typeof a?.[k] === 'string')];
        const team = inputLine(a?.team, 60);
        if (what.length) return team ? words('Teamprofiel invullen van “{0}”: {1}', team, what.slice(0, 6).join(', ')) : words('Teamprofiel invullen: {0}', what.slice(0, 6).join(', '));
        return team ? words('Teamprofiel bekijken van “{0}”', team) : words('Teamprofiel bekijken');
      },
      async run(a, t) {
        const no = refusal(t.agent);
        if (no) return toolError(no);
        const userId = t.agent.user_id;
        const team = teamOf(userId, a?.team);
        if (typeof team === 'string') return toolError(team);
        const notes: string[] = [];
        try {
          const answers = a?.answers && typeof a.answers === 'object' && !Array.isArray(a.answers) ? a.answers : null;
          if (answers && Object.keys(answers).length) {
            const r = templates()?.fillProfile?.(userId, team.id, answers);
            if (!r) return toolError(`Team “${team.name}” komt niet uit een sjabloon, dus het heeft geen vragen met een sleutel. Vul het profiel in met company, about, tone of rules.`);
            if (r.unknown.length) notes.push(`Onbekende sleutel overgeslagen: ${r.unknown.join(', ')}. Sleutels van dit team: ${r.def.questions.map((q: any) => q.key).join(', ')}.`);
            notes.push(r.saved.length ? `Opgeschreven: ${r.saved.join(', ')}.` : 'Er is niets veranderd.');
            notes.push(...r.warnings);
          }
          const direct: Record<string, string> = {};
          for (const k of PROFILE_FIELDS) if (typeof a?.[k] === 'string') direct[k] = inputText(a[k], 4000);
          if (Object.keys(direct).length) {
            svc.update(userId, team.id, { profile: direct });
            notes.push(`Bijgewerkt: ${Object.keys(direct).join(', ')}.`);
          }
        } catch (e: any) {
          return toolError(`Het profiel is niet opgeslagen: ${e?.message || e}`);
        }
        const now = svc.own(userId, team.id);
        return { text: [...notes, ...profileLines(userId, now)].join('\n'), data: { team: { id: now.id, name: now.name }, profile: cleanProfile(now.profile) } };
      },
    },
    {
      name: 'team_add_bot',
      group: MAIN_TOOL_GROUP,
      risk: 'write',
      impact: 'local',
      description:
        'Maak één bot (een collega) in een team, voor werk waar nog geen bot voor is; voor meerdere collega’s roep je dit per bot aan. Geef hem een korte naam (één woord), een rol in een paar woorden, één zin over wat hij doet en duidelijke instructies: wat hij doet, wat hij niet doet en wanneer hij het de teamleider vraagt. ' +
        'De bot werkt met dezelfde AI als de teamleider (of als jij) en kan meteen alles: volledige toegang, alle onderdelen en de skills van het team. Stel het de eigenaar eerst voor als hij er niet zelf om vroeg.',
      parameters: {
        type: 'object',
        properties: {
          team: { type: 'string', description: 'De naam van het team. Leeg = je eigen team.' },
          name: { type: 'string', description: 'Naam van de bot, liefst één woord.' },
          role: { type: 'string', description: 'Rol in een paar woorden, bijvoorbeeld “Nieuwsbrieven schrijven”.' },
          description: { type: 'string', description: 'Eén zin: wat de bot doet.' },
          instructions: { type: 'string', description: 'De instructies voor de bot, in gewone taal.' },
        },
        required: ['name', 'role', 'instructions'],
      },
      refuse,
      summarize: (a) => {
        const [name, team, role] = [inputLine(a?.name, 40) || '?', inputLine(a?.team, 60), inputLine(a?.role, 60)];
        if (team) return role ? words('Bot {0} maken in team “{1}” ({2})', name, team, role) : words('Bot {0} maken in team “{1}”', name, team);
        return role ? words('Bot {0} maken ({1})', name, role) : words('Bot {0} maken', name);
      },
      async run(a, t) {
        const no = refusal(t.agent);
        if (no) return toolError(no);
        const userId = t.agent.user_id;
        // No team named: the main bot's own team ("maak een collega"), also when there are more teams.
        const team = teamOf(userId, inputLine(a?.team, 80) || svc.teamOf(t.agent.id) || '');
        if (typeof team === 'string') return toolError(team);
        const name = inputLine(a?.name, 40);
        const role = inputLine(a?.role, 80);
        const instructions = inputText(a?.instructions, 8000);
        if (!name || !role || !instructions) return toolError('Geef een naam, een rol en instructies voor de nieuwe bot.');
        const twin = ctx.store.agents(userId, { archived: true }).find((x) => x.name.trim().toLowerCase() === name.toLowerCase());
        if (twin) return toolError(`Er is al een bot die ${twin.name} heet${twin.archived ? ' (in het archief)' : ''}. Kies een andere naam.`);
        try {
          // On the AI of the team lead, so the whole team works with the same one; without a lead, the main bot's.
          const like = (team.lead_agent_id ? ctx.store.agent(team.lead_agent_id) : null) || t.agent;
          const bot = svc.newBot(userId, { name, role, description: inputLine(a?.description, 200), instructions, provider_id: like.provider_id, model: like.model }, 'hoofdbot', team.id);
          // Access and parts: the start of every new bot (agent/new-bot.ts), nothing weaker on this path.
          const lead = team.lead_agent_id ? ctx.store.agent(team.lead_agent_id) : null;
          return {
            text: `${bot.name} (${bot.role}) is gemaakt in team “${team.name}”.${lead ? ` Teamleider ${lead.name} kan hem werk geven.` : ''} Jij kunt hem ook zelf werk geven met delegate_task. De eigenaar kan hem aanpassen bij Bots.`,
            data: { bot: { id: bot.id, name: bot.name, role: bot.role }, team: { id: team.id, name: team.name } },
          };
        } catch (e: any) {
          return toolError(`De bot is niet gemaakt: ${e?.message || e}`);
        }
      },
    },
    {
      name: 'bot_settings',
      group: MAIN_TOOL_GROUP,
      risk: 'write',
      // Wider access than the bot has now always asks the owner: 'danger' asks at every level, and `run` asks itself
      // when the gate did not (Volledige toegang with versturen naar anderen).
      riskFor: (a, t): ToolRisk => {
        const p = settingsPlan(a, t.agent.user_id);
        return 'error' in p || !p.any ? 'read' : p.widen.length ? 'danger' : 'write';
      },
      impact: (a, agent) => {
        const p = settingsPlan(a, agent.user_id);
        return 'error' in p || p.widen.length ? 'external' : 'local';
      },
      description:
        'Bekijk of verander de instellingen van een bot, of van meerdere bots in één keer, zodat de eigenaar er geen scherm voor hoeft te openen. Alleen bot: toont de instellingen. ' +
        'Voor wie: bot (één naam), bots (meerdere namen, of ["alle"] voor alle bots) of team (alle bots van dat team). Zo geef je in één stap alle bots een skill, een app of hetzelfde meldingsniveau. ' +
        'access: chat (alleen praten), readonly (alleen lezen), ask (vraagt toestemming), auto (automatisch) of full (volledige toegang). send_to_others: bij volledige toegang ook zonder vragen versturen naar anderen. ' +
        'parts_on en parts_off: onderdelen aan of uit, zoals browser, shell, channels of desktop. model en reasoning: het model en hoe diep het nadenkt. ' +
        'name, role, description, instructions (vervangt alles) of instructions_add (zet erachter). skills_on en skills_off: skills aan of uit. apps_on en apps_off: gekoppelde apps. notifications: all, important of none. ' +
        'Meer toegang dan de bot nu heeft (een hoger niveau, of send_to_others aan) vraagt TeamBot de eigenaar altijd eerst.',
      parameters: {
        type: 'object',
        properties: {
          bot: { type: 'string', description: 'De naam van de bot.' },
          bots: { type: 'array', items: { type: 'string' }, description: 'Meerdere bots tegelijk: hun namen, of ["alle"] voor alle bots.' },
          team: { type: 'string', description: 'Of: alle bots van dit team.' },
          name: { type: 'string', description: 'Een nieuwe naam voor de bot (alleen bij één bot).' },
          ...CHANGE_PROPS,
        },
      },
      refuse,
      summarize: (a) => {
        const what: Words[] = [];
        const m = inputLine(a?.access, 20).toLowerCase();
        if (m) what.push(words(m === 'full' ? 'toegang wordt “{0}” (doet zijn werk zonder te vragen)' : 'toegang wordt “{0}”', words(ACCESS[m] || m)));
        if (a?.send_to_others === true) what.push(words('mag ook versturen naar anderen zonder te vragen'));
        if (a?.send_to_others === false) what.push(words('vraagt weer voordat hij iets naar anderen verstuurt'));
        if (names(a?.parts_on).length) what.push(words('aan: {0}', names(a.parts_on).join(', ')));
        if (names(a?.parts_off).length) what.push(words('uit: {0}', names(a.parts_off).join(', ')));
        if (inputLine(a?.model, 200)) what.push(words('model: {0}', inputLine(a.model, 200)));
        if (inputLine(a?.reasoning, 20)) what.push(words('denkniveau: {0}', inputLine(a.reasoning, 20)));
        if (inputLine(a?.name, 80)) what.push(words('naam: {0}', inputLine(a.name, 80)));
        if (typeof a?.role === 'string') what.push(words('rol: {0}', inputLine(a.role, 80)));
        if (typeof a?.description === 'string') what.push(words('omschrijving'));
        if (typeof a?.instructions === 'string' && a.instructions.trim()) what.push(words('nieuwe instructies'));
        if (typeof a?.instructions_add === 'string' && a.instructions_add.trim()) what.push(words('instructies aanvullen'));
        if (names(a?.skills_on).length) what.push(words('skills aan: {0}', names(a.skills_on).join(', ')));
        if (names(a?.skills_off).length) what.push(words('skills uit: {0}', names(a.skills_off).join(', ')));
        if (names(a?.apps_on).length) what.push(words('apps erbij: {0}', names(a.apps_on).join(', ')));
        if (names(a?.apps_off).length) what.push(words('apps eraf: {0}', names(a.apps_off).join(', ')));
        if (inputLine(a?.notifications, 20)) what.push(words('meldingen: {0}', inputLine(a.notifications, 20)));
        const many = names(a?.bots);
        const bot = many.length ? (many.length === 1 && ALL.test(many[0]) ? words('Alle bots') : many.join(', ')) : inputLine(a?.bot, 60) || (inputLine(a?.team, 60) ? words('De bots van team “{0}”', inputLine(a.team, 60)) : '?');
        return what.length ? words('{0} instellen: {1}', bot, what.reduce((all, w) => words('{0}; {1}', all, w))) : words('Instellingen van {0} bekijken', bot);
      },
      async run(a, t) {
        const no = refusal(t.agent);
        if (no) return toolError(no);
        const userId = t.agent.user_id;
        const p = settingsPlan(a, userId);
        if ('error' in p) return toolError(p.error);
        const view = (b: Agent) => ({ bot: { id: b.id, name: b.name }, access: b.access_mode, parts: b.tool_groups, model: b.model, skills: b.skills });
        if (!p.any) {
          if (asksChange(a)) return { text: `Dat staat al zo${p.changes.length > 1 ? ' bij deze bots' : ` bij ${p.changes[0].bot.name}`}. Er is niets veranderd.`, data: p.changes.length === 1 ? view(p.changes[0].bot) : { bots: p.changes.map((c) => view(c.bot)) } };
          if (p.changes.length === 1) return { text: settingsLines(ctx, p.changes[0].bot, { instructions: true }).join('\n'), data: view(p.changes[0].bot) };
          return { text: p.changes.map((c) => settingsLines(ctx, c.bot).join('\n')).join('\n\n'), data: { bots: p.changes.map((c) => view(c.bot)) } };
        }
        const owner = ctx.store.user(userId);
        if (!owner) return toolError('De eigenaar van deze bot is niet gevonden.');
        const outside = notOwnersTalk(ctx, t.agent, t.thread);
        if (outside) return toolError('Geweigerd door TeamBot: bots instellen doet de hoofdbot alleen in een gesprek van de eigenaar zelf.');
        const who = listText(p.changes.filter((c) => c.widen.length).map((c) => c.bot.name));
        if (p.widen.length) {
          if (owner.role !== 'owner' && p.changes.some((c) => c.patch.access_mode === 'full' || c.patch.settings?.fullAccessExternal === true)) return toolError('Alleen de eigenaar van deze TeamBot-installatie kan een bot volledige toegang geven.');
          if (!t.approved && !(await askYesNo(t, 'bot_settings', a, `${t.agent.name} wil ${who} meer toegang geven: ${listText(p.widen)}. Goed?`)).yes)
            return toolError(`De eigenaar wil ${who} niet meer toegang geven. Er is niets veranderd.`);
        }
        // Not asked by the owner in this turn (a routine, a webhook, text the bot read): a proposal on one card first.
        else if (!askedByOwner(ctx, t)) {
          const no = await proposeToOwner(t, 'bot_settings', a, t.agent.name, p.changes.filter(changesSomething).map((c) => `${c.bot.name}: ${c.done.join(', ')}`));
          if (no) return toolError(no);
        }
        const lines: string[] = [];
        const after: Agent[] = [];
        let failed = 0;
        for (const c of p.changes) {
          if (!changesSomething(c)) {
            after.push(c.bot);
            continue;
          }
          const r = await applyBotChange(ctx, owner, c, t.signal);
          after.push(r.bot);
          if (r.error) failed++;
          lines.push(r.error ? `Niet (helemaal) gelukt voor ${r.bot.name}: ${r.error}` : `Ingesteld voor ${r.bot.name}: ${c.done.join('; ')}.`);
        }
        if (after.length === 1) lines.push(...settingsLines(ctx, after[0]));
        const out: ToolOutput = { text: lines.join('\n'), data: after.length === 1 ? view(after[0]) : { bots: after.map(view) } };
        if (failed && failed === p.changes.filter(changesSomething).length) out.isError = true;
        return out;
      },
    },
    {
      name: 'bot_rules',
      group: MAIN_TOOL_GROUP,
      risk: 'write',
      // Removing or weakening a rule (and a rule that lets a bot do more) always asks the owner; see bot_settings.
      riskFor: (a, t): ToolRisk => {
        const p = rulesPlan(a, t.agent.user_id);
        return 'error' in p || 'refuse' in p || p.kind === 'list' ? 'read' : p.loosens ? 'danger' : 'write';
      },
      impact: (a, agent) => {
        const p = rulesPlan(a, agent.user_id);
        return 'kind' in p && (p.kind === 'list' || !p.loosens) ? 'local' : 'external';
      },
      description:
        'De eigen regels van de eigenaar voor een bot of een team: bekijken (list), toevoegen (add), veranderen (change) of weghalen (remove). Geef bot of team. ' +
        'Schrijf een regel in de woorden van de eigenaar, met “nooit”, “vraag altijd eerst” of “mag altijd”, bijvoorbeeld: “Vraag altijd eerst voordat je iets in Shopify verandert”. ' +
        'Een strengere regel leg je meteen vast. Een regel weghalen of losser maken, of een regel die iets vrijgeeft, vraagt TeamBot de eigenaar altijd eerst. Een regel over geld haal je nooit weg en maak je nooit losser: dat doet de eigenaar zelf.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'change', 'remove'], description: 'Wat je doet. Leeg = list.' },
          bot: { type: 'string', description: 'De naam van de bot waarvoor de regel geldt.' },
          team: { type: 'string', description: 'Of de naam van het team: de regel geldt dan voor alle bots van dat team.' },
          text: { type: 'string', description: 'Bij add en change: de (nieuwe) regel in één zin.' },
          rule: { type: 'string', description: 'Bij change en remove: de tekst of het id van de bestaande regel.' },
        },
      },
      refuse: (a, t) => {
        const no = refusal(t.agent);
        if (no) return no;
        const p = rulesPlan(a, t.agent.user_id);
        return 'refuse' in p ? p.refuse : null;
      },
      summarize: (a, t) => {
        const where = inputLine(a?.bot, 60) || (inputLine(a?.team, 60) ? words('team “{0}”', inputLine(a.team, 60)) : '?');
        const p = t?.agent ? rulesPlan(a, t.agent.user_id) : null;
        const old = p && 'rule' in p ? p.rule.text : inputLine(a?.rule, 200);
        switch (inputLine(a?.action, 20).toLowerCase()) {
          case 'add':
            return words('Regel toevoegen bij {0}: “{1}”', where, inputLine(a?.text, 300));
          case 'remove':
            return words('Regel weghalen bij {0}: “{1}”', where, old);
          case 'change':
            return words('Regel veranderen bij {0}: “{1}” wordt “{2}”', where, old, inputLine(a?.text, 300));
          default:
            return words('Regels bekijken van {0}', where);
        }
      },
      async run(a, t) {
        const no = refusal(t.agent);
        if (no) return toolError(no);
        const userId = t.agent.user_id;
        const p = rulesPlan(a, userId);
        if ('error' in p) return toolError(p.error);
        if ('refuse' in p) return toolError(p.refuse);
        const rules = rulesSvc();
        const view = () => {
          const own: StoredRule[] = rules.list(userId, p.scope.key);
          const lines = [`Regels van ${p.scope.label}:`, ...(own.length ? own.map(ruleLine) : ['- nog geen'])];
          const home = p.scope.bot ? svc.team(svc.teamOf(p.scope.bot.id) || '') : null;
          const teamRules: StoredRule[] = home ? rules.list(userId, { teamId: home.id }) : [];
          if (home && teamRules.length) lines.push(`Regels van team “${home.name}” (gelden ook voor ${p.scope.bot!.name}):`, ...teamRules.map(ruleLine));
          return lines;
        };
        if (p.kind === 'list') return { text: view().join('\n'), data: { rules: rules.list(userId, p.scope.key).map((r: StoredRule) => ({ id: r.id, text: r.text, effect: r.effect })) } };
        if (p.loosens && !t.approved) {
          const q =
            p.kind === 'add'
              ? `${t.agent.name} wil een regel toevoegen bij ${p.scope.label}: “${p.text}” (${EFFECT_LABEL[p.parsed.effect]}). Goed?`
              : p.kind === 'remove'
                ? `${t.agent.name} wil een regel weghalen bij ${p.scope.label}: “${p.rule.text}” (${EFFECT_LABEL[p.rule.effect]}). Goed?`
                : `${t.agent.name} wil een regel van ${p.scope.label} losser maken: “${p.rule.text}” wordt “${p.text}” (${EFFECT_LABEL[p.parsed.effect]}). Goed?`;
          if (!(await askYesNo(t, 'bot_rules', a, q)).yes) return toolError('De eigenaar wil dit niet. Er is niets veranderd.');
        }
        let did: string;
        try {
          if (p.kind === 'add' || p.kind === 'change') rules.add(userId, p.scope.key, p.text, p.parsed);
          if (p.kind === 'remove' || p.kind === 'change') rules.remove(userId, p.rule);
          did = p.kind === 'add' ? `Regel toegevoegd bij ${p.scope.label}: “${p.text}” (${EFFECT_LABEL[p.parsed.effect]}).` : p.kind === 'remove' ? `Regel weggehaald bij ${p.scope.label}: “${p.rule.text}”.` : `Regel veranderd bij ${p.scope.label}: “${p.rule.text}” is nu “${p.text}” (${EFFECT_LABEL[p.parsed.effect]}).`;
        } catch (e: any) {
          return toolError(`De regel is niet opgeslagen: ${e?.message || e}`);
        }
        return { text: [did, ...view()].join('\n') };
      },
    },
  ];
}
