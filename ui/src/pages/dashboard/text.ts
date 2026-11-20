import { t } from '../../lib/i18n';

/** Texts of the dashboard that carry a number (pages/Dashboard.tsx and its parts). */
export const appsCount = (ok: number, all: number) => t('Apps die werken: {0} van {1}', ok, all);
export const botsBusy = (busy: number, all: number) => t('Bots aan het werk: {0} van {1}', busy, all);
export const appsWorking = (ok: number, all: number) => t('{0} van {1} werken', ok, all);
export const courseLabel = (_n: number) => t('Verloop van dit cijfer');
export const courseChange = (diff: string, since: string) => t('{0} sinds {1}', diff, since);
export const courseSame = (since: string) => t('Gelijk gebleven sinds {0}', since);
