import { t } from '../lib/i18n';

/** The texts of a block of requests in "Wacht op jou" (pages/Inbox.tsx). */
export const groupLabel = (count: number, bot: string) => t('{0, plural, one {# verzoek} other {# verzoeken}} van {1}', count, bot);
export const groupTitle = (bot: string, count: number, action: string) => t('{0} wil {1} keer: {2}', bot, count, action);
