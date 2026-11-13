/**
 * Vaste taken (standing duties): what a bot watches and improves on its own. A duty is an ordinary routine with
 * `options.duty` set; the routines engine schedules, limits and receipts it like any other routine. See
 * docs/modules/proactief.md.
 */

/** Where the numbers come from. `site`, `tasks` and `projects` are measured by TeamBot itself, without a model. */
export type DutySource =
  | 'site' // the team's websites, fetched by TeamBot (status, indexing, title, sitemap, broken links)
  | 'tasks' // the bot's own open tasks in the team database
  | 'search_console'
  | 'merchant_center'
  | 'ads'
  | 'analytics'
  | 'inbox' // customer messages (connected mail or chat channel)
  | 'calendar'
  | 'web' // public web search (the researcher)
  | 'team'; // the team's own data (team database, team folder)

/** What happens when the check is not "in orde". */
export type DutyAction = 'fix' | 'task' | 'ask';

export type Op = '<' | '<=' | '>' | '>=' | '=' | '!=';
export const OPS: Op[] = ['<', '<=', '>', '>=', '=', '!='];

/**
 * What TeamBot measures itself for a duty, without a model. General building blocks, usable by any duty of any bot:
 *  - site:  the team's websites (status, indexability, sitemap, a sample of pages);
 *  - url:   one address: does it answer (status), fast enough (maxMs), and does the page say what it should (contains);
 *  - tool:  a reading tool of an app connected to the bot (its real tool name), one number out of the answer
 *           (`path`, e.g. "rows.length" or "rows[0].clicks") against a threshold;
 *  - query: one number from the team database (a SELECT) against a threshold.
 * For tool and query the duty is "in orde" when `<number> <op> <value>` holds.
 */
export type Measure =
  | { kind: 'site' }
  | { kind: 'url'; url: string; status?: number; contains?: string; maxMs?: number }
  | { kind: 'tool'; tool: string; args?: Record<string, any>; path?: string; op: Op; value: number }
  | { kind: 'query'; sql: string; op: Op; value: number };

export interface Duty {
  /** Catalogue key ("seo.indexering") or "eigen" for one the owner wrote. */
  key: string;
  /** What to check, in one or two sentences. */
  check: string;
  source: DutySource;
  /** What counts as "in orde". */
  okWhen: string;
  onProblem: DutyAction;
  /** A project that reached tip-top leaves its duties behind as guards; guards always run on the cheapest engine. */
  guard?: boolean;
  projectId?: number | null;
  /** What TeamBot measures itself (no model). Without it: `site` for the source site, else the bot measures. */
  measure?: Measure;
}

/** A reminder: at its time TeamBot itself tells the owner (no model call), on the pc, the phone and his channel. */
export interface Reminder {
  text: string;
}

/** One thing a check found. `key` is stable for the same problem, so it becomes one task, not one per run. */
export interface Finding {
  key: string;
  title: string;
  /** The measurement that shows it: numbers, the address and the time. */
  evidence: string;
  doneWhen: string;
  site?: string;
}

export interface CheckResult {
  /** One quiet line: what was measured ("2 websites, 14 pagina's"). */
  line: string;
  numbers: Record<string, number>;
  findings: Finding[];
}

/**
 * The owner's settings for proactive work (user setting `proactive`). By default nothing is limited: a vaste taak runs
 * on its bot's own model, as often as its schedule says, like any other work (the provider's limits, the fallback
 * chain and a bot's own usage cap apply as always). The limit is optional and off.
 */
export interface ProactiveSettings {
  /** Optional limit: at most this many bot turns a day for proactive work. 0 = no limit (the default). */
  runsPerDay: number;
  /** Optional: proactive work goes to a free or local model first and never moves on to a paid one. Off by default. */
  cheapFirst: boolean;
  /** Optional limit: hoogstens zoveel projecten tegelijk in de sprint, per team. 0 = no limit (the default). */
  maxSprint: number;
  /**
   * Overzicht van de hoofdbot: elke dag, elke week (maandag) of niet. Off until the owner (or his main bot) turns it
   * on: nothing comes to him by itself that he did not ask for. It comes at the hour of his main bot (teams/briefing.ts).
   */
  briefing: 'dag' | 'week' | 'uit';
  /** What the owner is interested in, for the opportunity researcher. */
  interests: string;
}

export const DEFAULT_PROACTIVE: ProactiveSettings = { runsPerDay: 0, cheapFirst: false, maxSprint: 0, briefing: 'uit', interests: '' };

export function cleanProactive(raw: any): ProactiveSettings {
  const r = raw && typeof raw === 'object' ? raw : {};
  const n = (v: any, min: number, max: number, def: number) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.min(max, Math.max(min, Math.round(Number(v)))) : def);
  return {
    runsPerDay: n(r.runsPerDay, 0, 100_000, DEFAULT_PROACTIVE.runsPerDay),
    cheapFirst: typeof r.cheapFirst === 'boolean' ? r.cheapFirst : DEFAULT_PROACTIVE.cheapFirst,
    maxSprint: n(r.maxSprint, 0, 1000, DEFAULT_PROACTIVE.maxSprint),
    briefing: ['dag', 'week', 'uit'].includes(r.briefing) ? r.briefing : DEFAULT_PROACTIVE.briefing,
    interests: typeof r.interests === 'string' ? r.interests.trim().slice(0, 1000) : '',
  };
}

export const SOURCE_LABEL: Record<DutySource, string> = {
  site: 'de websites van het team (TeamBot meet zelf)',
  tasks: 'het takenbord van het team',
  search_console: 'Google Search Console',
  merchant_center: 'Google Merchant Center',
  ads: 'het advertentieaccount (Google Ads)',
  analytics: 'Google Analytics',
  inbox: 'de gekoppelde mailbox of chat',
  calendar: 'de gekoppelde agenda',
  web: 'openbare bronnen op internet',
  team: 'de teamdatabase en de teammap',
};

/**
 * Sources that need an app the owner connects. `tools` are the real tool names of TeamBot's built-in Google server
 * (server/modules/mcp/google.ts): a bot has the source when one of its connected apps offers one of them. `match` is
 * only the fallback for another connector that offers the same thing under its own tool names.
 */
export const SOURCE_APP: Partial<Record<DutySource, { name: string; tools: string[]; match: RegExp }>> = {
  search_console: { name: 'Search Console', tools: ['gsc_sites', 'gsc_search_analytics', 'gsc_inspect_url', 'gsc_sitemaps'], match: /search.?console|webmaster/i },
  merchant_center: { name: 'Merchant Center', tools: ['merchant_accounts', 'merchant_products', 'merchant_report'], match: /merchant|shopping.?content/i },
  ads: { name: 'Google Ads', tools: ['ads_customers', 'ads_query'], match: /google.?ads|adwords/i },
  analytics: { name: 'Google Analytics', tools: ['ga_properties', 'ga_report'], match: /analytics|ga4/i },
  calendar: { name: 'een agenda', tools: ['calendar_events'], match: /calendar|agenda|caldav|outlook/i },
};

export const ACTION_LABEL: Record<DutyAction, string> = {
  fix: 'zelf oplossen binnen je rechten, en anders een taak maken',
  task: 'een taak maken',
  ask: 'de eigenaar vragen (Wacht op jou)',
};
