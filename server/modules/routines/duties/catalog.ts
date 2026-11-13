import type { Agent } from '../../../core/types.js';
import type { Duty, DutyAction, DutySource, Measure } from './types.js';

/**
 * Presets: vaste taken that fit a kind of bot. A preset is plain data: words that recognise the bot (in its role, name
 * or description) and the duties that go with it.
 *
 * Nothing here is given to a bot by itself. Live (10–11 Nov 2026) TeamBot seeded these per bot from words in the role:
 * 32 routines the owner never asked for, on sources that were not connected, for the wrong bot too (a content writer
 * whose role mentions "SEO-pagina's" got the SEO checks). None of them ever produced anything. Since then:
 *  - the built-in presets below are a library of examples: the owner or a bot picks one deliberately (POST
 *    /api/proactive/duties with `key`, or duty_set in a conversation);
 *  - only presets the owner wrote himself (user setting `proactive.presets`) are applied to the bots they recognise:
 *    that is his own instruction.
 * A bot's work comes from what the owner said and from the team's tasks and projects (duties/work.ts), not from a list.
 */
export const CATALOG_VERSION = 3;

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const WORKDAYS = [1, 2, 3, 4, 5];

export interface CatalogDuty {
  key: string;
  title: string;
  check: string;
  source: DutySource;
  okWhen: string;
  onProblem: DutyAction;
  days: number[];
  times: string[];
  /** Instead of days and times: every so many minutes. */
  everyMinutes?: number;
  /** What TeamBot measures itself for this duty, without a model (types.ts). */
  measure?: Measure;
}

export interface RoleDuties {
  id: string;
  label: string;
  /** Words that recognise the bot (whole words, case-insensitive; "advertent*" = begins with). */
  words: string[];
  duties: CatalogDuty[];
}
/** A preset (the owner's word for it). */
export type Preset = RoleDuties;

export const ROLE_DUTIES: RoleDuties[] = [
  {
    id: 'seo',
    label: 'SEO',
    words: ['seo', 'zoekmachine*', 'vindbaarheid', 'organisch*'],
    duties: [
      {
        key: 'seo.techniek',
        title: 'Websites: technische fouten en indexeerbaarheid',
        check: 'Zijn de websites van het team bereikbaar en indexeerbaar: geen noindex, geen blokkade in robots.txt, een titel en beschrijving, een werkende sitemap en geen kapotte pagina’s?',
        source: 'site',
        okWhen: 'elke website antwoordt met 200, is indexeerbaar, heeft een titel en een sitemap, en geen gecontroleerde pagina geeft een fout',
        onProblem: 'fix',
        days: EVERY_DAY,
        times: ['06:30'],
      },
      {
        key: 'seo.posities',
        title: 'Posities en klikken in Google',
        check: 'Vergelijk klikken, vertoningen en gemiddelde positie van de laatste 7 dagen met de 7 dagen ervoor, per website en voor de belangrijkste zoekwoorden en pagina’s.',
        source: 'search_console',
        okWhen: 'geen website verliest meer dan 15% klikken en geen belangrijk zoekwoord zakt meer dan 3 plaatsen',
        onProblem: 'task',
        days: [1, 4],
        times: ['07:00'],
      },
      {
        key: 'seo.indexering',
        title: 'Indexering in Google',
        check: 'Welke pagina’s zijn niet geïndexeerd of geven een fout in Search Console (dekking, sitemaps, handmatige acties)?',
        source: 'search_console',
        okWhen: 'geen nieuwe fouten in de dekking, de sitemaps zijn verwerkt en er is geen handmatige actie',
        onProblem: 'task',
        days: [2, 5],
        times: ['07:10'],
      },
    ],
  },
  {
    id: 'merchant',
    label: 'Merchant Center',
    words: ['merchant', 'productfeed*', 'feed*', 'shopping'],
    duties: [
      {
        key: 'merchant.afkeuringen',
        title: 'Merchant Center: afkeuringen',
        check: 'Zijn er afgekeurde producten, waarschuwingen of accountproblemen in Merchant Center? Noem aantallen per reden.',
        source: 'merchant_center',
        okWhen: 'geen afgekeurde producten en geen accountprobleem',
        onProblem: 'fix',
        days: EVERY_DAY,
        times: ['07:15'],
      },
      {
        key: 'merchant.feed',
        title: 'Merchant Center: feedfouten',
        check: 'Is de productfeed vandaag opgehaald en zonder fouten verwerkt? Vergelijk het aantal producten met de vorige keer.',
        source: 'merchant_center',
        okWhen: 'de feed is binnen 24 uur verwerkt, zonder fouten, en het aantal producten wijkt minder dan 5% af',
        onProblem: 'fix',
        days: EVERY_DAY,
        times: ['07:25'],
      },
    ],
  },
  {
    id: 'ads',
    label: 'Advertenties',
    words: ['ads', 'adwords', 'advertent*', 'campagne*', 'sea'],
    duties: [
      {
        key: 'ads.kosten',
        title: 'Advertenties: kosten tegenover resultaat',
        check: 'Vergelijk per campagne de kosten, conversies en opbrengst van gisteren en de laatste 7 dagen met de 7 dagen ervoor.',
        source: 'ads',
        okWhen: 'geen campagne geeft meer uit dan zijn dagbudget, en de kosten per conversie stijgen nergens meer dan 25%',
        onProblem: 'ask',
        days: EVERY_DAY,
        times: ['07:40'],
      },
    ],
  },
  {
    id: 'klantenservice',
    label: 'Klantenservice',
    words: ['klantenservice', 'klantcontact', 'klanthulp', 'klantvragen', 'support', 'helpdesk'],
    duties: [
      {
        key: 'klant.onbeantwoord',
        title: 'Onbeantwoorde klantberichten',
        check: 'Welke klantberichten wachten langer dan 4 uur op een antwoord?',
        source: 'inbox',
        okWhen: 'geen klantbericht wacht langer dan 4 uur',
        onProblem: 'fix',
        days: EVERY_DAY,
        times: ['09:00', '13:00', '17:00'],
      },
    ],
  },
  {
    id: 'kansen',
    label: 'Researcher',
    words: ['researcher', 'kansenzoeker', 'verkenner', 'kansen', 'trendwatcher', 'marktonderzoek*'],
    duties: [
      {
        key: 'kansen.zoeken',
        title: 'Kansen zoeken',
        check:
          'Zoek in openbare bronnen wat nu werkt en past bij de bedrijven en interesses van de eigenaar: nieuwe kanalen, advertentieplatforms en verdienmodellen. Meld elke kans met kans_melden: wat het is, waarom nu, bronnen met adres en datum, kosten, risico en een mini-test.',
        source: 'web',
        okWhen: 'er is niets nieuws dat een bron met een datum van de laatste 60 dagen heeft',
        onProblem: 'task',
        days: [2, 5],
        times: ['06:45'],
      },
    ],
  },
  {
    id: 'techniek',
    label: 'Bouwer',
    words: ['bouwer', 'webmaster', 'devops', 'sitebeheer', 'websitebeheer'],
    duties: [
      {
        key: 'site.bereikbaar',
        title: 'Websites bereikbaar',
        check: 'Antwoorden de websites van het team, en hoe snel?',
        source: 'site',
        okWhen: 'elke website antwoordt met 200 binnen 5 seconden',
        onProblem: 'fix',
        days: EVERY_DAY,
        times: ['08:00', '14:00', '20:00'],
      },
    ],
  },
  {
    id: 'assistent',
    label: 'Persoonlijke assistent',
    words: ['assistent', 'agendahulp', 'secretar*', 'afspraken en herinneringen'],
    duties: [
      {
        key: 'agenda.vandaag',
        title: 'Agenda van vandaag en morgen',
        check: 'Wat staat er vandaag en morgen in de agenda, botst er iets, en waar moet de eigenaar iets voor voorbereiden of meenemen?',
        source: 'calendar',
        okWhen: 'er staat niets op de agenda waar de eigenaar nog iets voor moet doen',
        onProblem: 'ask',
        days: EVERY_DAY,
        times: ['07:30'],
      },
    ],
  },
];

/**
 * Retired (kept so an existing install's routine with this key still runs until it is cleaned up, see
 * DutyService.retire): the open tasks of a bot are now picked up by the work loop the moment they exist (work.ts),
 * not at 09:30 and 14:30 by a routine every bot got.
 */
export const FINISH_WORK: CatalogDuty = {
  key: 'werk.afmaken',
  title: 'Open taken afmaken',
  check: 'Staan er taken op jouw naam open op het takenbord van het team?',
  source: 'tasks',
  okWhen: 'er staat geen taak van jou op open of bezig',
  onProblem: 'fix',
  days: WORKDAYS,
  times: ['09:30', '14:30'],
};

/** Retired like FINISH_WORK: unscored opportunities are part of the main bot's work (work.ts). */
export const SCORE_OPPORTUNITIES: CatalogDuty = {
  key: 'kansen.scoren',
  title: 'Kansen scoren',
  check: 'Zijn er nieuwe kansen zonder scorekaart? Geef elke kans een scorekaart met kans_scoren.',
  source: 'team',
  okWhen: 'elke gemelde kans heeft een scorekaart',
  onProblem: 'fix',
  days: [0, 3],
  times: ['18:00'],
};

/** The retired one-off run in which a bot was told to think up duties for itself. */
export const SETUP_KEY = 'vaste-taken.bedenken';

/** Every key TeamBot once gave a bot by itself (the built-in presets and the three above). */
export const BUILTIN_KEYS: ReadonlySet<string> = new Set([...ROLE_DUTIES.flatMap((r) => r.duties.map((d) => d.key)), FINISH_WORK.key, SCORE_OPPORTUNITIES.key, SETUP_KEY]);

/** A built-in duty by its key (the library), or null. */
export function builtinDuty(key: string): CatalogDuty | null {
  return [...ROLE_DUTIES.flatMap((r) => r.duties), FINISH_WORK, SCORE_OPPORTUNITIES].find((d) => d.key === key) || null;
}

const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Does this text name the word? Whole words; a word ending in * also matches what begins with it. */
export function wordMatch(text: string, word: string): boolean {
  const w = word.trim().toLowerCase();
  if (!w) return false;
  const prefix = w.endsWith('*');
  const core = esc(prefix ? w.slice(0, -1) : w);
  return new RegExp(`(^|[^\\p{L}\\p{N}])${core}${prefix ? '' : '(?![\\p{L}\\p{N}])'}`, 'iu').test(text);
}

/** The owner's presets as stored → clean presets (bad ones are left out). */
export function cleanPresets(raw: unknown): Preset[] {
  const out: Preset[] = [];
  for (const x of Array.isArray(raw) ? raw.slice(0, 100) : []) {
    const label = String(x?.label ?? '').trim().slice(0, 60);
    const words = (Array.isArray(x?.words) ? x.words : String(x?.words ?? '').split(',')).map((w: any) => String(w).trim().toLowerCase().slice(0, 60)).filter(Boolean).slice(0, 20);
    const id = String(x?.id ?? label).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const duties: CatalogDuty[] = [];
    for (const d of Array.isArray(x?.duties) ? x.duties.slice(0, 12) : []) {
      const title = String(d?.title ?? '').trim().slice(0, 80);
      const check = String(d?.check ?? '').trim().slice(0, 1000);
      if (!title || !check) continue;
      const days = (Array.isArray(d?.days) ? d.days : []).map(Number).filter((n: number) => Number.isInteger(n) && n >= 0 && n <= 6);
      const times = (Array.isArray(d?.times) ? d.times : []).map(String).filter((t: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t));
      const every = Number(d?.everyMinutes);
      duties.push({
        key: String(d?.key ?? `${id}.${title}`).trim().toLowerCase().replace(/[^a-z0-9.]+/g, '-').slice(0, 60),
        title,
        check,
        source: d?.source ?? 'team',
        okWhen: String(d?.okWhen ?? '').trim().slice(0, 500),
        onProblem: ['fix', 'task', 'ask'].includes(d?.onProblem) ? d.onProblem : 'task',
        days: days.length ? days : [0, 1, 2, 3, 4, 5, 6],
        times: times.length ? times : ['07:00'],
        ...(Number.isFinite(every) && every >= 1 ? { everyMinutes: Math.round(every) } : {}),
        ...(d?.measure && typeof d.measure === 'object' ? { measure: d.measure } : {}),
      });
    }
    if (id && label && words.length && duties.length && !out.some((p) => p.id === id)) out.push({ id, label, words, duties });
  }
  return out;
}

/** Built-in presets plus the owner's; one of his with the id of a built-in one takes its place. */
export function allPresets(own: Preset[] = []): Preset[] {
  return [...ROLE_DUTIES.filter((b) => !own.some((o) => o.id === b.id)), ...own];
}

export function rolesFor(agent: Pick<Agent, 'role' | 'name' | 'description'>, presets: Preset[] = ROLE_DUTIES): RoleDuties[] {
  const text = `${agent.role || ''} ${agent.name || ''} ${agent.description || ''}`;
  return presets.filter((r) => r.words.some((w) => wordMatch(text, w)));
}

/**
 * The duties a bot gets by itself: only those of the owner's OWN presets that recognise it (he wrote them, so that is
 * his instruction). Never a built-in one, and nothing generic "for every bot".
 */
export function defaultDuties(agent: Pick<Agent, 'role' | 'name' | 'description'>, o: { presets?: Preset[] } = {}): CatalogDuty[] {
  return o.presets?.length ? rolesFor(agent, o.presets).flatMap((r) => r.duties) : [];
}

export const toDuty = (c: CatalogDuty): Duty => ({ key: c.key, check: c.check, source: c.source, okWhen: c.okWhen, onProblem: c.onProblem, ...(c.measure ? { measure: c.measure } : {}) });
