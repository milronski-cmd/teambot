import type { Agent, Ctx, ToolContext, ToolDef, ToolGroup } from '../../core/types.js';
import { inputLine } from '../../core/util.js';
import { toolError } from '../registry.js';
import { isParseError } from '../../modules/botrules/parse.js';
import { fullAccess } from './files.js';
import { EFFECT_LABEL, MONEY_REFUSAL, aboutMoney } from '../../modules/botrules/money.js';
import { patchBot } from '../../modules/teams/inner.js';
import { words } from '../../../shared/i18n-core.js';

/**
 * A bot never gets stuck on a setting, and the owner never has to open a settings screen for it: the bot asks, the
 * owner answers Ja or Nee on a card in the chat (also on his phone), and TeamBot changes the setting.
 *  - request_part   a part (tool group) that is switched off for this bot: on Ja it is switched on, and TeamBot starts
 *                   the bot's next turn itself (a turn's tool list is fixed when it starts);
 *  - propose_rule   a rule for this bot's own work ("mag altijd …", "vraag altijd eerst …"): on Ja it is stored through
 *                   the botrules service, in the owner's words. Never a looser rule about money.
 * Both are in the always-on core group. Nothing here is policy: parts and rules stay ordinary settings.
 */
export const PART_TOOL = 'request_part';
export const RULE_TOOL = 'propose_rule';

const sentence = (s: string) => (/[.!?]$/.test(s) ? s : s + '.');
const YES = /^\s*(?:ja|yes|ok|oke|oké|okay|prima|goed|doe maar|akkoord|aanzetten|instellen)(?![a-z])/i;

/** The owner's own words are the answer: only a clear yes counts, anything else is a no. */
export const saidYes = (r: { approved: boolean; answer?: string }) => r.approved && YES.test(r.answer ?? '');

/** Ask the bot's owner a yes/no question on a card in the chat. Only in the owner's own conversation. */
export async function askYesNo(t: ToolContext, tool: string, input: any, summary: string): Promise<{ yes: boolean; answer?: string }> {
  if (t.thread.user_id !== t.agent.user_id) return { yes: false };
  const r = await t.ctx.broker.request({ userId: t.thread.user_id, agent: t.agent, thread: t.thread, run: t.run, kind: 'question', tool, input, summary, risk: 'write', options: ['Ja', 'Nee'], signal: t.signal });
  return { yes: saidYes(r), answer: r.approved ? r.answer : undefined };
}

/** A part by its id or its name on screen ("browser", "Terminal"). */
export function findPart(ctx: Ctx, v: unknown): ToolGroup | null {
  const q = inputLine(v, 60).toLowerCase();
  if (!q) return null;
  const list = [...ctx.tools.groups.values()];
  return list.find((g) => g.id.toLowerCase() === q) || list.find((g) => g.label.toLowerCase() === q) || null;
}

export const partList = (ctx: Ctx) =>
  [...ctx.tools.groups.values()]
    .filter((g) => !g.always)
    .map((g) => `${g.id} (${g.label})`)
    .join(', ');

/** What the owner still has to connect before this part can work (a Ja cannot do that), or null. */
function notConnected(ctx: Ctx, agent: Agent, g: ToolGroup): string | null {
  try {
    if (g.id === 'channels' && !ctx.store.one('SELECT 1 FROM channel_bindings WHERE user_id = ? LIMIT 1', agent.user_id))
      return `${g.label} kan nog niet aan: er is nog geen chat-app of e-mailadres gekoppeld. De eigenaar moet er eerst een koppelen bij Kanalen; zeg hem dat in één zin en ga verder met wat wel kan.`;
  } catch {
    /* module off: nothing to check */
  }
  return null;
}

export function registerSelfServe(ctx: Ctx) {
  /** Runs in which a part was switched on: TeamBot starts the next turn, where the bot has the new tools. */
  const resume = new Map<string, string>();

  const tools: ToolDef[] = [
    {
      name: PART_TOOL,
      group: 'core',
      risk: 'read',
      description:
        'Mis je een onderdeel dat voor jou uit staat (bijvoorbeeld browser, shell, channels of desktop)? Vraag het hiermee aan: noem het onderdeel en zeg in één zin waarom je het nodig hebt. ' +
        'TeamBot vraagt het je eigenaar (Ja of Nee) en zet het bij Ja meteen voor je aan. Gebruik dit in plaats van vast te lopen of te zeggen dat je iets niet kunt.',
      parameters: {
        type: 'object',
        properties: {
          part: { type: 'string', description: 'Het onderdeel, bijvoorbeeld “browser”, “shell”, “channels” of “desktop”.' },
          why: { type: 'string', description: 'Eén zin: waarvoor je het nodig hebt.' },
        },
        required: ['part', 'why'],
      },
      summarize: (a) => (inputLine(a?.why, 200) ? words('Onderdeel aanvragen: {0} — {1}', inputLine(a?.part, 60) || '?', inputLine(a?.why, 200)) : words('Onderdeel aanvragen: {0}', inputLine(a?.part, 60) || '?')),
      async run(a, t) {
        const g = findPart(t.ctx, a?.part);
        if (!g) return toolError(`Er is geen onderdeel “${inputLine(a?.part, 60)}”. Onderdelen: ${partList(t.ctx)}.`);
        const agent = t.ctx.store.agent(t.agent.id) || t.agent;
        if (t.ctx.tools.groupEnabled(agent, g.id)) return `${g.label} staat al aan voor jou. Ga verder met je werk.`;
        if (t.thread.user_id !== agent.user_id) return toolError(`Alleen de eigenaar van ${agent.name} kan een onderdeel aanzetten. Ga verder zonder ${g.label}.`);
        const need = notConnected(t.ctx, agent, g);
        if (need) return need;
        const why = inputLine(a?.why, 300);
        // "Volledige toegang": the bot has every part; one that needs a setup first is switched on at once, no question.
        const direct = fullAccess(agent);
        if (!why && !direct) return toolError('Zeg in één zin waarom je dit onderdeel nodig hebt (why).');
        const r = direct ? { yes: true, answer: undefined } : await askYesNo(t, PART_TOOL, { part: g.id, why }, `${agent.name} heeft ${g.label} nodig: ${sentence(why)} Aanzetten?`);
        if (!r.yes) return `De eigenaar zet ${g.label} niet aan${r.answer && !/^\s*nee\s*$/i.test(r.answer) ? ` (antwoord: “${inputLine(r.answer, 300)}”)` : ''}. Ga verder zonder dit onderdeel en zeg eerlijk wat daardoor niet lukt.`;
        const cur = t.ctx.store.agent(agent.id) || agent;
        const owner = t.ctx.store.user(agent.user_id);
        if (!owner || owner.disabled) return toolError('De eigenaar van deze bot is niet gevonden.');
        try {
          // The one way a tool writes a bot (teams/inner.ts): the bot as it was is kept as a version.
          await patchBot(t.ctx, owner, agent.id, { tool_groups: [...new Set([...cur.tool_groups, g.id])] }, t.signal);
        } catch (e: any) {
          return toolError(`${g.label} is niet aangezet: ${e?.message || e}`);
        }
        if (t.run?.id) resume.set(t.run.id, g.label);
        return `${g.label} staat nu aan voor jou. De tools ervan heb je in je volgende beurt, en die start TeamBot meteen na deze. Sluit deze beurt nu af met één korte zin; daarna ga je verder met je werk.`;
      },
    },
    {
      name: RULE_TOOL,
      group: 'core',
      risk: 'read',
      description:
        'Stel je eigenaar een regel voor je eigen werk voor, als je steeds om hetzelfde akkoord vraagt of als iets voortaan altijd gevraagd moet worden. Schrijf de regel in gewone woorden, zoals je eigenaar hem zou schrijven: ' +
        '“Mag altijd bestanden maken in de map Offertes” of “Vraag altijd eerst voordat je iets in Shopify verandert”. TeamBot vraagt het je eigenaar (Ja of Nee) en legt de regel bij Ja vast. Niet voor geld: betalen en uitgeven wordt altijd gevraagd.',
      parameters: {
        type: 'object',
        properties: {
          rule: { type: 'string', description: 'De regel in één zin, met “mag altijd”, “vraag altijd eerst” of “nooit”.' },
          why: { type: 'string', description: 'Eén zin: waarom dit handig is.' },
        },
        required: ['rule'],
      },
      summarize: (a) => words('Regel voorstellen: “{0}”', inputLine(a?.rule, 200) || '?'),
      async run(a, t) {
        const rules = t.ctx.services.botRules?._service;
        if (!rules) return toolError('Eigen regels staan uit in deze TeamBot.');
        const agent = t.agent;
        if (t.thread.user_id !== agent.user_id) return toolError(`Alleen de eigenaar van ${agent.name} stelt regels in.`);
        const text = inputLine(a?.rule, 400);
        const p = rules.parse(agent.user_id, text);
        if (isParseError(p)) return toolError(`Deze regel kan TeamBot zo niet vastleggen: ${p.error}`);
        if (p.effect === 'allow' && aboutMoney(text, p.match)) return toolError(MONEY_REFUSAL);
        if (rules.list(agent.user_id, { agentId: agent.id }).some((r: any) => r.text.toLowerCase() === text.toLowerCase())) return 'Deze regel staat er al. Ga verder met je werk.';
        const why = inputLine(a?.why, 300);
        const r = await askYesNo(t, RULE_TOOL, { rule: text, why }, `${agent.name} stelt een regel voor: “${text}” (${EFFECT_LABEL[p.effect as keyof typeof EFFECT_LABEL]}).${why ? ` ${sentence(why)}` : ''} Instellen?`);
        if (!r.yes) return `De eigenaar wil deze regel niet${r.answer && !/^\s*nee\s*$/i.test(r.answer) ? ` (antwoord: “${inputLine(r.answer, 300)}”)` : ''}. Blijf werken zoals nu en stel dit niet opnieuw voor.`;
        try {
          rules.add(agent.user_id, { agentId: agent.id }, text, p);
        } catch (e: any) {
          return toolError(`De regel is niet opgeslagen: ${e?.message || e}`);
        }
        return `De regel staat er nu: “${text}” (${EFFECT_LABEL[p.effect as keyof typeof EFFECT_LABEL]}). Hij geldt vanaf nu; ga verder met je werk.`;
      },
    },
  ];
  for (const t of tools) ctx.tools.register(t);

  // One line in every working bot's system prompt.
  ctx.hooks.systemPrompt.push(({ agent }) =>
    agent.access_mode === 'chat' || agent.settings?.sharedRun ? null : `Staat een onderdeel dat je nodig hebt uit, vraag het dan aan (${PART_TOOL}). Vraag je steeds om hetzelfde akkoord, stel dan een regel voor (${RULE_TOOL}).`,
  );

  // The part is on: start the bot's next turn, in which it has the new tools.
  ctx.hooks.afterRun.push(({ agent, thread, run }) => {
    const label = resume.get(run.id);
    if (!label) return;
    resume.delete(run.id);
    if (run.status === 'cancelled' || run.status === 'error') return;
    const sys = ctx.store.createMessage({ thread_id: thread.id, role: 'system', author_type: 'system', author_name: 'TeamBot', content: `${label} staat nu aan voor ${agent.name}. Ga verder waar je gebleven was.`, parts: {} });
    ctx.chat.emitMessage(thread, sys);
    ctx.runs.enqueue({ threadId: thread.id, agentId: agent.id, userId: thread.user_id, trigger: 'resume', inputMessageId: sys.id, meta: { partEnabled: true } });
  });
}
