import { t } from '../lib/i18n';

/** The texts of a block of requests in "Wacht op jou" (pages/Inbox.tsx). */
export const groupLabel = (count: number, bot: string) => t('{0, plural, one {# verzoek} other {# verzoeken}} van {1}', count, bot);
export const groupTitle = (bot: string, count: number, action: string) => t('{0} wil {1} keer: {2}', bot, count, action);

/** "Wacht op jou › Geleerd" (pages/InboxLearned.tsx): one line about a bot, and the names of its controls. */
export const learnedCount = (answers: number) => t('{0, plural, one {# antwoord onthouden} other {# antwoorden onthouden}}', answers);
export const openCount = (open: number) => t('{0, plural, one {# vraag wacht op jou} other {# vragen wachten op jou}}', open);
export const askedWeek = (n: number) => t('{0, plural, one {# keer iets gevraagd deze week} other {# keer iets gevraagd deze week}}', n);
export const learnedOf = (bot: string) => t('Wat {0} van je leerde', bot);
export const answerTo = (question: string) => t('Antwoord op: {0}', question);
