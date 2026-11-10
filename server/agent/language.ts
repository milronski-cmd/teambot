/**
 * The language bots answer in (all engines: API models, Claude Code, Codex, ACP agents).
 *
 * Default ("auto"): the language the owner writes in; when that is unclear (a routine without a message, only a link
 * or code) the owner's interface language. Optionally a fixed language per user (setting `botLanguage`) or per bot
 * (`agent.settings.language`; '' = follow the user setting). The rule is the last "## Taal" section of the system
 * prompt: CLI engines bring a long English prompt of their own and read a lot of English (tool output,
 * documentation), so they drift — most of all in the short lines between steps — unless the most recent instruction
 * is explicit. The rest of TeamBot's prompt stays Dutch; the rule says which language to use, not the prompt's.
 */
import type { Agent } from '../core/types.js';
import { userLanguage } from '../core/i18n.js';
import { isLanguage, language, languageName, localeOf } from '../../shared/languages.js';

interface SettingsStore {
  getSetting<T = any>(userId: string, key: string, def: T): T;
}

export type BotLanguage = { mode: 'auto'; fallback: string } | { mode: 'fixed'; code: string };

export const LANGUAGE_HEADING = '## Taal';

/** The rule for one bot of a user: the bot's own choice, else the user's, else "the language the user writes in". */
export function botLanguage(store: SettingsStore | null | undefined, userId: string, agent?: Pick<Agent, 'settings'> | null): BotLanguage {
  const ui = userLanguage(store, userId);
  const own = agent?.settings?.language;
  let pick: unknown = own === 'auto' || isLanguage(own) ? own : undefined;
  if (pick === undefined) {
    try {
      pick = store?.getSetting<string>(userId, 'botLanguage', 'auto');
    } catch {
      pick = 'auto';
    }
  }
  return isLanguage(pick) ? { mode: 'fixed', code: pick } : { mode: 'auto', fallback: ui };
}

/** The language a bot uses when nothing else tells (fixed language, or the interface language). */
export const defaultAnswerLanguage = (l: BotLanguage) => (l.mode === 'fixed' ? l.code : l.fallback);

/** Locale for dates in what the bot reads ("Huidige datum en tijd: …"), in the language it will most likely use. */
export const answerLocale = (l: BotLanguage) => localeOf(defaultAnswerLanguage(l));

/** Dutch name of a language for use inside Dutch prompt text: "Duits", "Engels", "Arabisch". */
export function nlName(code: string): string {
  const n = languageName(code, 'nl');
  return n.charAt(0).toUpperCase() + n.slice(1);
}

/** "het Duits (Deutsch)": Dutch name plus the language's own name, so no model can misread it. */
function named(code: string): string {
  const own = language(code)?.name;
  const nl = nlName(code);
  return own && own.toLowerCase() !== nl.toLowerCase() ? `het ${nl} (${own})` : `het ${nl}`;
}

const SAME_FOR_ALL =
  "Dat geldt voor alles wat de gebruiker leest: je antwoord, de korte berichtjes tussen je stappen door en samenvattingen. Ook als je eigen instructies, tool-resultaten, webpagina's of documentatie in een andere taal zijn: vertaal en vat samen. Namen, code, opdrachten, bestandsnamen en letterlijke citaten blijven zoals ze zijn.";

/** The "## Taal" section of the system prompt. */
export function languageNote(l: BotLanguage): string {
  if (l.mode === 'fixed') {
    return [
      LANGUAGE_HEADING,
      `- Schrijf alles wat de gebruiker leest in ${named(l.code)}, ook als de gebruiker zelf in een andere taal schrijft. Alleen als de gebruiker uitdrukkelijk om een andere taal vraagt (zoals een vertaling of een tekst voor iemand anders), schrijf je dat stuk in die taal.`,
      `- ${SAME_FOR_ALL.replace('vertaal en vat samen.', `vertaal en vat samen in ${named(l.code)}.`)}`,
    ].join('\n');
  }
  return [
    LANGUAGE_HEADING,
    '- Antwoord in de taal waarin de gebruiker schrijft: schrijft de gebruiker Duits, dan antwoord je in het Duits; schrijft de gebruiker Nederlands, dan in het Nederlands. Let daarvoor op de berichten van de gebruiker zelf, niet op de taal van deze instructies, tool-resultaten of documenten.',
    `- Is niet duidelijk welke taal de gebruiker schrijft (een routine of taak zonder bericht, alleen een link, code of één woord), gebruik dan ${named(l.fallback)}.`,
    `- ${SAME_FOR_ALL.replace('vertaal en vat samen.', 'vertaal en vat samen in de taal van de gebruiker.')}`,
  ].join('\n');
}

/**
 * A built-in Dutch prompt that asks for output "in het Nederlands" / "(Nederlands)" (memory items, dossier summaries,
 * review reasons — texts the owner reads later) asks for the owner's language instead.
 */
export function outputLanguage(prompt: string, code: string): string {
  if (!isLanguage(code) || code === 'nl') return prompt;
  const n = nlName(code);
  return prompt.replace(/\bin het Nederlands\b/g, `in het ${n}`).replace(/\(Nederlands\)/g, `(${n})`).replace(/, Nederlands>/g, `, ${n}>`);
}

/** The language for texts a model writes for the owner to read later (memory, summaries): see defaultAnswerLanguage. */
export const ownerTextLanguage = (store: SettingsStore | null | undefined, userId: string, agent?: Pick<Agent, 'settings'> | null) => defaultAnswerLanguage(botLanguage(store, userId, agent));

/** The default rule (auto, Dutch as fallback) for code paths without a user (tests, previews). */
export const DEFAULT_LANGUAGE_NOTE = languageNote({ mode: 'auto', fallback: 'nl' });

/** The "## Taal" section in a system prompt (up to the next "## " heading or the end), or ''. */
export function languageSection(system: string): string {
  const i = system.lastIndexOf(`${LANGUAGE_HEADING}\n`);
  if (i < 0 || (i > 0 && system[i - 1] !== '\n')) return '';
  const rest = system.slice(i);
  const next = rest.indexOf('\n## ', LANGUAGE_HEADING.length);
  return next < 0 ? rest.trimEnd() : rest.slice(0, next).trimEnd();
}

/**
 * The system prompt with its language rule moved to the very end (once). CLI engines add their tool note after
 * TeamBot's prompt; the rule must still be the last thing they read. Without a rule in `system`, `fallback` is used.
 */
export function withLanguage(system: string, fallback = DEFAULT_LANGUAGE_NOTE): string {
  const note = languageSection(system) || fallback;
  let body = system;
  const sec = languageSection(system);
  if (sec) {
    const i = system.lastIndexOf(sec);
    body = (system.slice(0, i) + system.slice(i + sec.length)).replace(/\n{3,}/g, '\n\n').trimEnd();
  }
  return body.endsWith(note) ? body : `${body}\n\n${note}`;
}
