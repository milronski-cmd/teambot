/**
 * Answer style per bot ("Antwoordstijl", `agent.settings.answerStyle`): how the bot writes, for every engine (API
 * models and the CLI engines: it is part of TeamBot's system prompt, which Claude Code, Codex, OpenCode and ACP agents
 * get as well, also when it changes during a running session).
 *
 * - `natural` (default, also when unset): the way bots have always answered — in plain sentences, as in a
 *   conversation, as short as the question allows. Adds nothing to the prompt, so existing bots keep exactly the same
 *   prompt (and their prompt caches).
 * - `business`: structured — the core first, then short headings, lists and a table where things are compared.
 *
 * The section comes just before the language rule (both are about form; the most recent instruction weighs most for
 * CLI engines with a long prompt of their own). The bot's own instructions and what the user asks still go first.
 */
import type { Agent } from '../core/types.js';

export type AnswerStyle = 'natural' | 'business';
export const ANSWER_STYLES: AnswerStyle[] = ['natural', 'business'];
export const STYLE_HEADING = '## Antwoordstijl';

export const answerStyle = (agent?: Pick<Agent, 'settings'> | null): AnswerStyle => (agent?.settings?.answerStyle === 'business' ? 'business' : 'natural');

/** The "## Antwoordstijl" section of the system prompt, or '' for the default style. */
export function answerStyleNote(agent?: Pick<Agent, 'settings'> | null): string {
  if (answerStyle(agent) !== 'business') return '';
  return [
    STYLE_HEADING,
    '- Schrijf zakelijk en overzichtelijk: begin met de kern in één of twee zinnen. Zet een langer antwoord daarna in korte kopjes en opsommingen, en gebruik een tabel als je dingen vergelijkt.',
    '- Geen inleiding, geen herhaling van de vraag en geen afsluitende beleefdheden of vragen als "Kan ik nog iets voor je doen?".',
    '- Een korte vraag krijgt een kort antwoord: kopjes alleen als het antwoord langer is dan een paar zinnen.',
    '- Vraagt de gebruiker of vragen je eigen instructies om een andere vorm (een e-mail, een verhaal, één woord), volg dan die.',
  ].join('\n');
}
