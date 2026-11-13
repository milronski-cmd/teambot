import type { Agent, Ctx, Thread, ToolDef, ToolImpact, ToolRisk } from '../../core/types.js';
import { toolError } from '../../tools/registry.js';
import { inputLine } from '../../core/util.js';
import { redact } from '../../core/secrets.js';
import { askYesNo } from '../../tools/builtin/selfserve.js';
import type { TeamsService } from './service.js';
import { moreAccess } from './botpatch.js';
import { callAsUser } from './inner.js';
import { type Checked, type Reach, reachOf } from './reach.js';
import { askedByOwner, chainFromOwner, notOwnersTalk, proposeToOwner } from './selftools.js';
import { SETTINGS, SETTINGS_PAGES, SETTINGS_ROWS, type SettingDef } from '../../../shared/settings.js';
import { placeOf as settingsPlace } from '../../../shared/places.js';
import { listText, tr, userLanguage } from '../../core/i18n.js';
import { USER_SETTINGS } from '../../api/misc.js';
import { fillWords, words, type Words } from '../../../shared/i18n-core.js';

/**
 * "Een bot kan alles wat de gebruiker in het scherm kan": whatever the owner can do in TeamBot's own screens, every bot
 * of his can do for him. The screens only ever call TeamBot's own API (the routes every module registers on
 * `ctx.api`), so two tools cover it all without a tool per screen:
 *  - teambot_find   the list of those calls (method, path, one Dutch line), made from the routes that are registered,
 *                   filtered by a word;
 *  - teambot_do     performs one call inside this process (inner.ts): through the same router the app serves under
 *                   /api, with the bot's owner as the user. The session kind is "device", so every route that already
 *                   refuses a paired phone (things that hand out access or show secrets) refuses the bot as well.
 * The main bot has them in its list; every other bot reaches them through tools_find and tools_call (index.ts).
 *
 * The route only knows the owner, so what a BOT may do with it is decided here, before the access gate:
 *  - `refusal`: never through this tool — keys, passwords, tokens and logins, sessions, devices and pairing, remote
 *    desktop, exporting everything, restoring or deleting back-ups, the updater, admin, the main-bot designation,
 *    answering approval cards, the closed folders, and rules (those go through bot_rules, which guards money rules);
 *  - whose conversation: only in a conversation of the owner himself (`notOwnersTalk`). In a conversation with someone
 *    else (a customer on a channel) the screens do not exist for the bot: not to look either, so nothing of another
 *    customer or of the owner can be read out through it;
 *  - the bot's own reach (reach.ts): its access to the teams (none / meekijken / aansturen) and the keys of its team.
 *    Reading across a wall is refused like writing. The main bot works TeamBot as the owner;
 *  - `planCall`: the risk of one call for the gate (tools/broker.ts). Looking is 'read'; changing is 'write'; deleting,
 *    sending or publishing to others and giving a bot more access is 'danger' with impact 'external'; anything about
 *    money is 'danger' with impact 'payment', which asks the owner at every access level. More access than a bot has
 *    now asks the owner even when the gate would not (like bot_settings and my_settings);
 *  - whose word (`askedByOwner`, the one rule of selftools.ts): a change is made straight away when the work began
 *    with a message the owner typed himself (his own turn, and what follows from it: work a bot handed on, the turn
 *    after a colleague's result). Work that began with anything else (a routine, a webhook, a turn TeamBot started)
 *    may have been set off by text a bot read, so there the change is one card for the owner first. Looking is always
 *    free. The same for every bot: the main bot is no exception.
 */
export const MANAGE_FIND = 'teambot_find';
export const MANAGE_DO = 'teambot_do';
export const MANAGE_TOOL_NAMES = [MANAGE_FIND, MANAGE_DO] as const;
/** Always there, like a bot's own settings: not a part the owner switches on. */
const GROUP = 'core';

const MAX_OUT = 12_000;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

// ---------- the registered routes ----------

export interface RouteInfo {
  method: string;
  /** As registered, relative to /api: `/routines/:id/pause`. */
  path: string;
  re: RegExp;
  group: string;
  /** One Dutch line: "Routine pauzeren". */
  text: string;
}

function compile(path: string): RegExp {
  const body = path
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.startsWith('*') ? '.+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${body}/?$`, 'i');
}

const routeCache = new WeakMap<Ctx, { n: number; list: RouteInfo[] }>();

/** Every route on the owner's API, in the order it was registered (the order Express matches in). */
export function routesOf(ctx: Ctx): RouteInfo[] {
  const stack: any[] = (ctx.api as any)?.stack || [];
  const hit = routeCache.get(ctx);
  if (hit && hit.n === stack.length) return hit.list;
  const list: RouteInfo[] = [];
  for (const layer of stack) {
    const r = layer?.route;
    if (!r) continue;
    for (const p of Array.isArray(r.path) ? r.path : [r.path]) {
      if (typeof p !== 'string' || !p.startsWith('/')) continue;
      for (const m of Object.keys(r.methods || {})) {
        const method = m.toUpperCase();
        if (!(METHODS as readonly string[]).includes(method)) continue;
        list.push({ method, path: p, re: compile(p), group: p.split('/')[1] || '', text: describe(ctx, method, p) });
      }
    }
  }
  routeCache.set(ctx, { n: stack.length, list });
  return list;
}

const matchRoute = (ctx: Ctx, method: string, path: string) => routesOf(ctx).find((r) => r.method === method && r.re.test(path)) || null;

// ---------- plain Dutch for a call ----------

/** What a path is about, longest prefix first. */
const NOUNS: [string, string][] = [
  ['proactive/checkin', 'Dagelijkse check-in van de hoofdbot'],
  ['proactive/briefing', 'Overzicht van de hoofdbot'],
  ['proactive/projects', 'Project'],
  ['proactive/kansen', 'Kans'],
  ['proactive/duties', 'Vaste taak'],
  ['proactive', 'Uit zichzelf werken'],
  ['rooms/tasks', 'Taak'],
  ['rooms/delegations', 'Doorgegeven werk'],
  ['rooms', 'Groepsgesprek'],
  ['routines/triggers', 'Trigger van een routine'],
  ['routines/runs', 'Run van een routine'],
  ['routines/settings', 'Instellingen van routines'],
  ['routines/planned', 'Alles wat gepland staat en vanzelf start (routines, herinneringen, vaste taken)'],
  ['routines', 'Routine'],
  ['teams/overview', 'Overzicht van alle teams'],
  ['teams/main', 'Hoofdbot'],
  ['teams', 'Team'],
  ['team-templates', 'Teamsjabloon'],
  ['agents', 'Bot'],
  ['threads', 'Gesprek'],
  ['messages', 'Bericht'],
  ['memory/dossiers', 'Dossier'],
  ['memory/customers', 'Klant (wie er schrijft via een kanaal) aan een klantdossier'],
  ['memory', 'Geheugen'],
  ['channels/bindings', 'Kanaal'],
  ['channels/conversations', 'Gesprek in een kanaal'],
  ['channels', 'Kanalen'],
  ['mcp/connections', 'App'],
  ['mcp', 'Apps'],
  // The marketplace the owner sees: first what TeamBot checked, then everything public, most stars first. TeamBot's
  // own starter catalogue and catalogues he added are a separate choice there (Meer opties), and so here.
  ['skills/web', 'Marktplaats (alles wat openbaar is)'],
  ['skills/curated', 'Marktplaats (gecontroleerd door TeamBot)'],
  ['skills/market/skills', 'Eigen catalogi (TeamBot-startcatalogus en zelf toegevoegde catalogi)'],
  ['skills/market/apps', 'Marktplaats (apps)'],
  ['skills/market/bots', 'Marktplaats (bots)'],
  ['skills/market/sources', 'Bronnen van de marktplaats'],
  ['skills/market/report', 'Melding over een skill, bot of app'],
  ['skills/market', 'Marktplaats'],
  ['skills/catalogs', 'Catalogus in de marktplaats'],
  ['skills', 'Skill'],
  ['settings', 'Instellingen'],
  ['usage', 'Verbruik'],
  ['notifications/prefs', 'Voorkeuren voor meldingen'],
  ['notifications', 'Meldingen'],
  ['folders/trash', 'Prullenbak'],
  ['folders/team', 'Teammap'],
  ['folders', 'Mappen'],
  ['chat-folders', 'Map voor chats'],
  ['workflows', 'Workflow'],
  ['workflow-runs', 'Run van een workflow'],
  ['specialists', 'Specialist'],
  ['backups', 'Back-up'],
  ['app-update', 'Update van TeamBot'],
  ['providers', 'AI-verbinding'],
  ['computers', 'Browser en computer'],
  ['sites', 'Website'],
  ['runs', 'Run'],
  ['stop-all', 'Alle bots'],
  ['approvals', 'Vraag om toestemming'],
  ['audit', 'Logboek'],
  ['system', 'TeamBot zelf'],
  ['search', 'Zoeken'],
  ['health', 'Status van TeamBot'],
  ['bot-rules', 'Eigen regels'],
  ['teamdata', 'Teamgegevens'],
  ['voice', 'Spraak'],
  ['engine-chain', 'Doorschakelen naar een andere AI'],
  ['free-models', 'Gratis modellen'],
  ['power', 'Wakker houden van de computer'],
];

/** A whole line for a route where its noun and verb alone would not say enough (the one way to find and add a skill). */
const LINES: Record<string, string> = {
  'GET /skills/web/search':
    'Marktplaats: skills zoeken zoals in het scherm (query q = je woorden, ook Engels). Eerst wat TeamBot controleerde, dan alles wat openbaar is (skills.sh, GitHub, ClawHub), meeste sterren eerst; elk resultaat heeft een id om toe te voegen',
  'POST /skills/curated/install': 'Marktplaats: een skill toevoegen met het id uit het zoeken (body id; teamId "*" = alle teams); meteen bruikbaar voor het team',
  'GET /skills/curated': 'Marktplaats: alle skills die TeamBot controleerde, meeste sterren eerst (het eerste scherm)',
  'GET /skills/curated/item': 'Marktplaats: één skill bekijken (query id)',
  'GET /skills/web/repo': 'Marktplaats: de skills in één repository op GitHub (query repo)',
  'GET /skills/market/skills':
    'Eigen catalogi: skills uit de TeamBot-startcatalogus en catalogi die je zelf toevoegde (in de Marktplaats onder Meer opties › Zelf geschreven en eigen catalogi). Gewone skills zoek je met GET /skills/web/search',
};

/** The last fixed word of a path that says what happens. */
/** What a call does, with the thing it is done to as {0} ("Routine ‘Dagoverzicht’ pauzeren"). */
const ACTIONS: Record<string, string> = {
  pause: '{0} pauzeren',
  resume: '{0} aanzetten',
  run: '{0} nu starten',
  'run-after': '{0} later starten',
  duplicate: '{0} kopiëren',
  cancel: '{0} stoppen',
  stop: '{0} stoppen',
  'stop-all': '{0} stoppen',
  approve: '{0} goedkeuren',
  reopen: '{0} heropenen',
  release: '{0} vrijgeven',
  confirm: '{0} bevestigen',
  send: '{0} versturen',
  resend: '{0} opnieuw versturen',
  publish: '{0} publiceren',
  republish: '{0} opnieuw publiceren',
  share: '{0} delen',
  restore: '{0} terugzetten',
  undo: '{0} ongedaan maken',
  test: '{0} testen',
  read: '{0} als gelezen markeren',
  seen: '{0} als gezien markeren',
  retry: '{0} opnieuw proberen',
  refresh: '{0} verversen',
  check: '{0} controleren',
  preview: '{0} vooraf bekijken',
  empty: '{0} leegmaken',
  wipe: '{0} wissen',
  import: '{0} importeren',
  export: '{0} exporteren',
  order: '{0} volgorde aanpassen',
  decide: '{0} beslissen',
  accept: '{0} aannemen',
  decline: '{0} afwijzen',
  compact: '{0} samenvatten',
  fork: '{0} afsplitsen',
  react: '{0} reageren',
  pin: '{0} vastzetten',
  forward: '{0} doorsturen',
  learn: '{0} laten leren',
  generate: '{0} laten voorstellen',
  install: '{0} installeren',
  link: '{0} koppelen',
  connect: '{0} aanzetten',
  disconnect: '{0} uitzetten',
};

const SUBS: Record<string, string> = {
  settings: 'instellingen',
  prefs: 'voorkeuren',
  runs: 'runs',
  messages: 'berichten',
  versions: 'versies',
  history: 'geschiedenis',
  bots: 'bots',
  access: 'toegang tot het team',
  triggers: 'triggers',
  goals: 'doelen',
  knowledge: 'vakkennis',
  reports: 'rapporten',
  proposals: 'voorstellen',
  senders: 'afzenders',
  items: 'items',
  alerts: 'waarschuwingen',
  limits: 'limieten',
};

const FIELDS: Record<string, string> = {
  name: 'naam',
  title: 'titel',
  role: 'rol',
  description: 'omschrijving',
  instructions: 'instructies',
  access_mode: 'toegang',
  model: 'model',
  provider_id: 'AI',
  tool_groups: 'onderdelen',
  tool_policy: 'toestemming per tool',
  settings: 'instellingen',
  workspace: 'werkmap',
  enabled: 'aan of uit',
  time: 'tijd',
  status: 'status',
  schedule: 'planning',
  prompt: 'opdracht',
  profile: 'profiel',
  leadAgentId: 'teamleider',
  deadline: 'deadline',
  dailyBudgetUsd: 'dagbudget',
  daily_budget_usd: 'dagbudget',
  timezone: 'tijdzone',
  language: 'taal',
  archived: 'archief',
  level: 'niveau',
};

const VERB: Record<string, string> = { GET: '{0} bekijken', POST: '{0} maken', PUT: '{0} aanpassen', PATCH: '{0} aanpassen', DELETE: '{0} verwijderen' };
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** The name of the thing a call is about: from the body, else looked up by the id in the path (the owner's own only). */
function nameOf(ctx: Ctx, userId: string, key: string, id: string | undefined, body: any): string {
  const given = inputLine(body?.name, 60) || inputLine(body?.title, 60);
  if (!id) return given;
  try {
    const own = (row: any) => (row && row.user_id === userId ? row : null);
    if (key === 'agents') return own(ctx.store.agent(id))?.name || given;
    if (key === 'teams') return own(ctx.services.teams?.team?.(id))?.name || given;
    const table: Record<string, [string, string]> = { routines: ['routines', 'name'], 'rooms/tasks': ['room_tasks', 'title'], threads: ['threads', 'title'], workflows: ['workflows', 'name'], rooms: ['rooms', 'name'], 'channels/bindings': ['channel_bindings', 'name'] };
    const t = table[key];
    if (t) return inputLine(ctx.store.one<any>(`SELECT ${t[1]} AS n FROM ${t[0]} WHERE id = ? AND user_id = ?`, id, userId)?.n, 60) || given;
  } catch {
    /* a module that is off: no name */
  }
  return given;
}

/** The fields of a body in words: TeamBot's label for each, the value as given ("naam “Rikkert”", "aan"). */
function fieldsWords(body: any): Words[] {
  if (!isObj(body)) return [];
  const parts: Words[] = [];
  for (const [k, v] of Object.entries(body).slice(0, 6)) {
    const label = FIELDS[k] ? words(FIELDS[k]) : k;
    if (k === 'enabled') parts.push(words(v ? 'aan' : 'uit'));
    else if (typeof v === 'string' && v.length <= 60 && !/\n/.test(v)) parts.push(words('{0} “{1}”', label, v));
    else if (typeof v === 'number' || typeof v === 'boolean') parts.push(words('{0} {1}', label, v === true ? words('ja') : v === false ? words('nee') : v));
    else parts.push(words('{0}', label));
  }
  if (Object.keys(body).length > 6) parts.push(words('…'));
  return parts;
}
/** Words one after the other, separated by a comma. */
const commaList = (list: Words[]): Words | null => (list.length ? list.reduce((all, w) => words('{0}, {1}', all, w)) : null);

/** The settings of the screens (shared/settings.ts) that one route changes, by its method and pattern. */
const settingsOf = (method: string, pattern: string): SettingDef[] => Object.values(SETTINGS as Record<string, SettingDef>).filter((d) => d.call === `${method} ${pattern}` && d.field);
/** The value at a dotted field of a body ("ui.botStyle"), or undefined. */
const at = (body: any, field: string): unknown => field.split('.').reduce<any>((v, k) => (isObj(v) ? v[k] : undefined), body);
const shown = (d: SettingDef, v: unknown) => d.choices?.find((c) => c.value === v)?.label ?? (typeof v === 'string' ? inputLine(v, 60) : JSON.stringify(v));

/** The fields a route takes, for the route list: the settings of the screens it changes (PUT /settings: every key it keeps). */
function fieldsOf(method: string, pattern: string): string[] {
  const fields = settingsOf(method, pattern).map((d) => d.field!);
  if (method === 'PUT' && pattern === '/settings') for (const k of USER_SETTINGS) if (!fields.some((f) => f.split('.')[0] === k) || k === 'ui') fields.push(k);
  return [...new Set(fields.filter((f) => f !== 'ui'))];
}

/**
 * One Dutch line for a call: "Routine ‘Dagoverzicht’ aanzetten", "Bot ‘Rik’ aanpassen: naam “Rikkert”". Without a
 * concrete path (the route list) it describes the route: "Routine pauzeren", with the fields of the screens it changes.
 */
export function describe(ctx: Ctx, method: string, pattern: string, call?: { userId: string; path: string; body?: any }): string {
  if (call) return line(ctx, method, pattern, call);
  const fields = fieldsOf(method, pattern);
  const plain = LINES[`${method} ${pattern}`] || line(ctx, method, pattern);
  return fields.length ? `${plain} — velden: ${fields.join(', ')} (wat elk veld in het scherm is en welke waarden het neemt: zoek het op met de woorden van het scherm)` : plain;
}

function line(ctx: Ctx, method: string, pattern: string, call?: { userId: string; path: string; body?: any }): string {
  return fillWords(lineWords(ctx, method, pattern, call)).slice(0, 400);
}

/** line() as TeamBot's words with the names and values in it as they are: the owner reads it in his own language. */
function lineWords(ctx: Ctx, method: string, pattern: string, call?: { userId: string; path: string; body?: any }): Words {
  const segs = pattern.split('/').filter(Boolean);
  const real = call ? call.path.split('/').filter(Boolean) : [];
  const joined = segs.join('/');
  const hit = NOUNS.find(([k]) => joined === k || joined.startsWith(k + '/'));
  const key = hit ? hit[0] : segs[0] || '';
  const used = key.split('/').length;
  const noun = hit ? hit[1] : ctx.modules.find((m) => m.id === key)?.label || cap(key.replace(/-/g, ' '));
  const rest = segs.slice(used);
  const fixed = rest.filter((s) => !s.startsWith(':') && !s.startsWith('*'));
  const last = segs.at(-1) || '';
  const action = method !== 'GET' && fixed.length && fixed.at(-1) === last && ACTIONS[last] ? last : key === 'stop-all' ? 'stop-all' : '';
  const subs = (action && action !== 'stop-all' ? fixed.slice(0, -1) : fixed).map((s) => SUBS[s] || s.replace(/-/g, ' '));
  const idAt = rest[0]?.startsWith(':') ? used : -1;
  const name = call ? nameOf(ctx, call.userId, key, idAt >= 0 ? real[idAt] : undefined, method === 'GET' ? null : call.body) : '';
  // A bot named further on in the path (/teams/:id/bots/:agentId): say which one.
  const botAt = segs.findIndex((s, i) => i > used && s === ':agentId');
  const bot = call && botAt >= 0 ? ctx.store.agent(real[botAt] || '')?.name || '' : '';
  const thing = name ? words('{0} ‘{1}’', words(noun), name) : words(noun);
  const part = subs.length ? words('{0} ({1})', thing, words(subs.join(' › '))) : thing;
  const whose = bot ? words('{0} voor {1}', part, bot) : part;
  const did = action ? words(ACTIONS[action], whose) : method === 'POST' && last.startsWith(':') ? words('{0} bijwerken', whose) : VERB[method] ? words(VERB[method], whose) : words('{0} {1}', whose, method);
  if (call && !action && method !== 'GET' && method !== 'DELETE') {
    // A setting of the screens is said with its own words: "Stijl figuurtjes “Vilt”". (Not a bot's settings: its
    // whole settings object goes along, so its own field names say what changes.)
    const named = (pattern === '/agents/:id' ? [] : settingsOf(method, pattern)).flatMap((d) => {
      const v = at(call.body, d.field!);
      if (v === undefined) return [];
      // A choice is said in TeamBot's words, a text as given.
      return [d.choices?.some((c) => c.value === v) ? words('{0} “{1}”', words(d.title), words(shown(d, v))) : typeof v === 'string' ? words('{0} “{1}”', words(d.title), shown(d, v)) : words('{0} {1}', words(d.title), shown(d, v))];
    });
    const f = commaList(named.length ? named : fieldsWords(name && isObj(call.body) && method === 'POST' ? Object.fromEntries(Object.entries(call.body).filter(([k]) => k !== 'name' && k !== 'title')) : call.body));
    if (f) return words('{0}: {1}', did, f);
  }
  return did;
}

// ---------- the line the owner drew ----------

const NEVER: { re: RegExp; write?: boolean; why: string }[] = [
  { re: /^\/(admin|memory\/admin)(\/|$)/i, why: 'beheer van gebruikers en van de installatie doet de eigenaar zelf' },
  { re: /^\/(secrets|script-keys|realtime\/client_secrets|teams\/keys|mcp\/server-tokens)(\/|$)/i, why: 'sleutels en tokens gaan nooit via een bot' },
  { re: /^\/computers\/vault(\/|$)/i, why: 'de kluis met wachtwoorden opent alleen de eigenaar' },
  { re: /(^|\/)(secret|secrets|client_secrets|token|tokens|github-token|credential|credentials|password|login|oauth|rotate|revoke-previous|proxy)(\/|$)/i, why: 'sleutels, wachtwoorden en inloggen bij een dienst gaan nooit via een bot' },
  { re: /^\/voice\/(realtime|gemini)\/session(\/|$)/i, why: 'dit geeft een tijdelijke sleutel uit' },
  { re: /^\/(sessions|pairing|pair|auth|mobile|remote-desktop)(\/|$)/i, why: 'inlogsessies, gekoppelde apparaten, koppelen en bureaublad op afstand regelt de eigenaar zelf' },
  { re: /(^|\/)(pair-codes|pair-phone)(\/|$)/i, why: 'koppelen van een apparaat of afzender doet de eigenaar zelf' },
  { re: /^\/me(\/|$)/i, write: true, why: 'het eigen account (e-mailadres, wachtwoord, app-slot) wijzigt de eigenaar zelf' },
  { re: /^\/(export|memory\/export)(\/|$)/i, why: 'alles exporteren doet de eigenaar zelf' },
  { re: /^\/(openbot-import|mcp\/import)(\/|$)/i, write: true, why: 'een overstap neemt ook sleutels over; die start de eigenaar zelf' },
  { re: /^\/backups\/offsite(\/|$)/i, why: 'de tweede plek voor back-ups (met wachtwoord) stelt de eigenaar zelf in' },
  { re: /^\/backups\/.*restore(\/|$)/i, why: 'een back-up terugzetten doet de eigenaar zelf' },
  { re: /^\/app-update(\/|$)/i, write: true, why: 'TeamBot bijwerken doet de eigenaar zelf' },
  { re: /^\/teams\/main(\/|$)/i, write: true, why: 'wie de hoofdbot is bepaalt alleen de eigenaar' },
  { re: /^\/approvals(\/|$)/i, write: true, why: 'een vraag om toestemming beantwoordt alleen de eigenaar' },
  { re: /^\/bot-rules(?!\/preview(\/|$))(\/|$)/i, write: true, why: 'een regel van de eigenaar gaat via bot_rules (de hoofdbot) of propose_rule (een voorstel aan de eigenaar)' },
  { re: /^\/network(\/|$)/i, write: true, why: 'wie de computer via het netwerk kan bereiken stelt de eigenaar zelf in' },
];

/** Field names that carry a secret. A filled-in one is never sent through a bot. */
const SECRET_FIELD = /pass(word|wd)$|^password|wachtwoord|secret|api[_-]?key|apikey|^key$|token$|credential|^authorization$|^cookies?$|private[_-]?key/i;

function deep(v: any, fn: (key: string, value: any) => boolean, depth = 0): boolean {
  if (depth > 6 || !v || typeof v !== 'object') return false;
  for (const [k, x] of Array.isArray(v) ? v.map((y, i) => [String(i), y] as const) : Object.entries(v)) {
    if (!Array.isArray(v) && fn(k, x)) return true;
    if (deep(x, fn, depth + 1)) return true;
  }
  return false;
}

/** Why a call never goes through a bot (one sentence), or null. */
export function refusal(method: string, path: string, body?: any): string | null {
  const write = method !== 'GET';
  const no = (why: string) => `Geweigerd door TeamBot: ${why}. Zeg de eigenaar eerlijk dat hij dit zelf doet in TeamBot.`;
  for (const n of NEVER) if ((write || !n.write) && n.re.test(path)) return no(n.why);
  if (method === 'DELETE' && /^\/backups(\/|$)/i.test(path)) return no('een back-up weggooien doet de eigenaar zelf');
  if (write && deep(body, (k, v) => (SECRET_FIELD.test(k) && typeof v === 'string' && v.trim() !== '') || (k === 'headers' && isObj(v) && Object.keys(v).length > 0))) return no('een sleutel, token of wachtwoord gaat nooit via een bot; de eigenaar vult die zelf in');
  if (write && /^\/settings\/?$/i.test(path) && isObj(body) && 'closedFolders' in body) return no('welke mappen dicht zijn voor bots bepaalt de eigenaar zelf');
  if (write && /^\/channels\//i.test(path) && isObj(body) && (body.is_owner || body.owner)) return no('iemand eigenaar van een kanaal maken doet de eigenaar zelf');
  return null;
}

const MONEY_PATH = /(^|\/)(budgets?|billing|payments?|subscriptions?|plans?|checkout|credits?|limits|alerts|cap)(\/|$)|^\/computers\/cloud(\/|$)|^\/(free-models|engine-chain)(\/|$)/i;
const MONEY_FIELD = /budget|usd$|eur$|price|prijs|cost|kosten|spend|paid|betaald|billing|payment/i;
const SENDS = /(^|\/)(send|resend|publish|republish|share|shares|invite|invites|broadcast)(\/|$)/i;
const DESTROYS = /(^|\/)(empty|wipe|purge)(\/|$)/i;

export type CallPlan =
  | { error: string }
  | { refuse: string }
  | { method: string; path: string; query: string; url: string; body: any; route: RouteInfo; risk: ToolRisk; impact: ToolImpact; money: boolean; widen: string[]; summary: string; words: Words };

/**
 * What gives a bot more access than it has now (the owner is always asked first). `parts`: a part switched on counts
 * too (every bot but the main bot, which sets up bots for the owner the way bot_settings does).
 */
function widening(ctx: Ctx, method: string, path: string, body: any, parts: boolean): string[] {
  const out: string[] = [];
  if (method === 'GET' || method === 'DELETE') return out;
  const b = isObj(body) ? body : {};
  const m = /^\/agents(?:\/([^/]+))?\/?$/i.exec(path);
  if (m) out.push(...moreAccess(ctx, m[1] ? ctx.store.agent(m[1]) : null, b, { parts }));
  if (/^\/agents\/[^/]+\/versions\/[^/]+\/restore\/?$/i.test(path)) out.push('een oudere versie van de bot, die meer toegang kan hebben');
  if (/^\/agents\/import\/?$|^\/import\/agents\/?$/i.test(path)) out.push('geïmporteerde bots met hun eigen toegang');
  if (/^\/teams\/[^/]+\/access\/[^/]+\/?$/i.test(path) && b.level !== 'none' && b.level !== null) out.push(`toegang tot een ander team${inputLine(b.level, 20) ? ` (${inputLine(b.level, 20)})` : ''}`);
  if (/^\/folders\/team\/?$/i.test(path)) out.push('een map op de computer voor de bots van een team');
  return out;
}

/** Read the arguments of one call and decide its risk. Never throws. `o.parts`: see `widening`. */
export function planCall(ctx: Ctx, userId: string, a: any, o: { parts?: boolean } = {}): CallPlan {
  const method = inputLine(a?.method, 10).toUpperCase() || 'GET';
  if (!(METHODS as readonly string[]).includes(method)) return { error: `Onbekende methode “${method}”. Kies uit: ${METHODS.join(', ')}.` };
  let raw = inputLine(a?.path, 600);
  if (!raw) return { error: `Geef het pad van de actie (path), bijvoorbeeld /routines. Zoek het op met ${MANAGE_FIND}.` };
  const q = new URLSearchParams();
  const cut = raw.indexOf('?');
  if (cut >= 0) {
    for (const [k, v] of new URLSearchParams(raw.slice(cut + 1))) q.append(k, v);
    raw = raw.slice(0, cut);
  }
  if (isObj(a?.query)) for (const [k, v] of Object.entries(a.query)) if (v !== undefined && v !== null && typeof v !== 'object') q.set(k, String(v));
  let path = raw.replace(/^https?:\/\/[^/]+/i, '').replace(/^\/?api(?=\/)/i, '');
  if (!path.startsWith('/')) path = '/' + path;
  if (path.length > 1) path = path.replace(/\/+$/, '');
  if (/[%\\\s#]|\.\.|\/\//.test(path)) return { error: 'Dit pad klopt niet: gebruik alleen gewone tekens, zonder %, spaties of “..”. Een id haal je uit een lijst (GET).' };
  // A body sent as JSON text (some engines pass an object as a string) is that object; anything else is said, never
  // sent on as an empty body that "succeeds" without changing anything.
  let given = a?.body;
  if (typeof given === 'string' && given.trim()) {
    try {
      given = JSON.parse(given);
    } catch {
      return { error: 'De body is geen geldige JSON. Geef de velden als object, bijvoorbeeld { "ui": { "theme": "dark" } }.' };
    }
  }
  if (method !== 'GET' && given !== undefined && given !== null && given !== '' && !isObj(given) && !Array.isArray(given)) return { error: 'De body moet een object zijn met de velden, bijvoorbeeld { "name": "Nieuwe naam" }.' };
  const body = method === 'GET' ? undefined : isObj(given) || Array.isArray(given) ? given : {};
  const never = refusal(method, path, body);
  if (never) return { refuse: never };
  const route = matchRoute(ctx, method, path);
  if (!route) {
    const other = routesOf(ctx).filter((r) => r.re.test(path)).map((r) => r.method);
    return { error: other.length ? `Dit pad kent ${method} niet; wel: ${[...new Set(other)].join(', ')}.` : `TeamBot kent geen actie ${method} ${path}. Zoek de juiste op met ${MANAGE_FIND}.` };
  }
  const widen = widening(ctx, method, path, body, o.parts === true);
  const money = method !== 'GET' && (MONEY_PATH.test(path) || deep(body, (k) => MONEY_FIELD.test(k)));
  const outward = method === 'DELETE' || SENDS.test(path) || DESTROYS.test(path);
  const risk: ToolRisk = method === 'GET' ? 'read' : money || widen.length || outward ? 'danger' : 'write';
  const impact: ToolImpact = money ? 'payment' : risk === 'danger' ? 'external' : 'local';
  // The step's line: TeamBot's words with the names in it (the Dutch text is what the bot and the approval card read).
  let said = lineWords(ctx, method, route.path, { userId, path, body });
  if (money) said = words('{0} (gaat over geld)', said);
  if (widen.length) said = words('{0} — geeft meer toegang: {1}', said, words(listText(widen)));
  const qs = q.toString();
  return { method, path, query: qs, url: qs ? `${path}?${qs}` : path, body, route, risk, impact, money, widen, summary: fillWords(said), words: said };
}

// ---------- the answer ----------

/** Hide the value of every field whose name says it is a secret, and what a provider keeps besides its key. */
function scrub(v: any, depth = 0): any {
  if (depth > 12 || !v || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
  const out: Record<string, any> = {};
  for (const [k, x] of Object.entries(v)) out[k] = (SECRET_FIELD.test(k) && typeof x === 'string' && x) || (k === 'headers' && isObj(x) && Object.keys(x).length) ? '[verborgen]' : scrub(x, depth + 1);
  return out;
}

/** The answer as bounded text: a long list keeps its first items and says how many there are. */
function answerText(json: any): string {
  const clean = scrub(json);
  const full = redact(JSON.stringify(clean, null, 1) ?? 'null');
  if (full.length <= MAX_OUT) return full;
  if (Array.isArray(clean)) {
    const kept: string[] = [];
    let n = 0;
    for (const item of clean) {
      const s = redact(JSON.stringify(item));
      if (n + s.length > MAX_OUT - 200) break;
      kept.push(s);
      n += s.length + 2;
    }
    if (kept.length) return `[\n${kept.join(',\n')}\n]\n(De eerste ${kept.length} van ${clean.length} getoond. Vraag er één op, of filter met query.)`;
  }
  return `${full.slice(0, MAX_OUT)}\n… (afgekapt: het antwoord is ${full.length} tekens. Vraag één onderdeel op, of filter met query.)`;
}

// ---------- the settings of the screens, by their own words ----------

/** Words that say nothing about which setting is meant ("zet de stijl op vilt" → "stijl", "vilt"). */
const FILLER = new Set(['de', 'het', 'een', 'van', 'op', 'in', 'en', 'voor', 'met', 'naar', 'aan', 'uit', 'om', 'zet', 'maak', 'mijn', 'je', 'jouw', 'graag', 'wil', 'the', 'to', 'of', 'set', 'and', 'for', 'on', 'my', 'your', 'turn', 'make', 'please']);
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** A Dutch plural or verb form still finds its word: "routines" → "routine", "taken" → "taak" via the line. */
const stem = (w: string) => (w.length > 4 ? w.replace(/(en|s)$/, '') : w);
const holds = (hay: string, w: string) => hay.includes(w) || hay.includes(stem(w));

/** Where a setting is, in words: "Instellingen › Meer mogelijkheden › Spraak" (shared/places.ts), or on a bot's page. */
const placeOf = (key: string): string => (key === 'bot' ? 'de pagina van een bot › Meer mogelijkheden' : settingsPlace(key));
/** The words of an entry as the screen shows them: its own title and line, and the row it is the page of. */
function pageWords(key: string): string[] {
  const own = SETTINGS_ROWS.find((r) => r.main === key);
  return [SETTINGS_PAGES[key]?.title || '', SETTINGS_PAGES[key]?.hint || '', own?.title || '', own?.hint || ''].filter(Boolean);
}
/** `{"ui":{"botStyle":…}}` for "ui.botStyle". */
const bodyShape = (field: string) => field.split('.').reduceRight((inner, k) => `{"${k}":${inner}}`, '…');
const said = (v: SettingChoice['value']) => JSON.stringify(v);
type SettingChoice = NonNullable<SettingDef['choices']>[number];

interface SettingHit {
  id: string;
  title: string;
  where: string;
  call: string | null;
  field?: string;
  values?: { value: SettingChoice['value']; label: string; means?: string }[];
  refused?: string;
}

/**
 * The settings and settings pages of the screens that the words name, in Dutch and in the user's interface language:
 * the title and the line of a row or switch, its choices, and the page it is on. Every meaningful word must be there;
 * only when nothing has them all, the ones with the most.
 */
function findSettings(ctx: Ctx, routes: RouteInfo[], userId: string, words: string[]): { text: string[]; hits: SettingHit[] } {
  const lang = userLanguage(ctx.store, userId);
  const local = (s: string) => (lang === 'nl' ? s : tr(lang, s));
  const both = (list: (string | undefined)[]) => list.flatMap((s) => (s ? [s, local(s)] : []));
  const want = words.map(fold).filter((w) => w.length > 1 && !FILLER.has(w));
  if (!want.length) return { text: [], hits: [] };
  const score = (hay: string) => want.filter((w) => holds(hay, w)).length;
  const settings = Object.entries(SETTINGS as Record<string, SettingDef>).map(([id, d]) => {
    const own = fold(both([d.title, d.hint, d.note, ...(d.choices || []).flatMap((c) => [c.label, c.means])]).join(' | ') + ` | ${d.field || ''} | ${(d.choices || []).map((c) => String(c.value)).join(' ')}`);
    // `n`: the words found here or on its page; `mine`: those in its own words (they decide between rows of one page).
    return { id, d, n: score(`${own} | ${fold(both(pageWords(d.on)).join(' | '))}`), mine: score(own) };
  });
  const pages = Object.keys(SETTINGS_PAGES).map((key) => ({ key, n: score(fold(both(pageWords(key)).join(' | '))) }));
  // A row without a page of its own (Meer mogelijkheden): the list of what is under it.
  const hubs = SETTINGS_ROWS.filter((r) => !r.main).map((r) => ({ r, n: score(fold(both([r.title, r.hint]).join(' | '))) }));
  const best = Math.max(0, ...settings.map((s) => s.n), ...pages.map((p) => p.n), ...hubs.map((h) => h.n));
  if (!best) return { text: [], hits: [] };
  const top = settings.filter((s) => s.n === best);
  const mineBest = Math.max(0, ...top.map((s) => s.mine));
  const named = (title: string) => (lang !== 'nl' && local(title) !== title ? `“${local(title)}” (${title})` : `“${title}”`);
  const hits: SettingHit[] = [];
  const text: string[] = [];
  for (const { id, d } of top.filter((s) => s.mine === mineBest).slice(0, 12)) {
    const [method, path] = d.call ? d.call.split(' ') : ['', ''];
    const body = d.field ? JSON.parse(bodyShape(d.field).replace('…', 'null')) : undefined;
    const no = d.call ? refusal(method, path.replace(/:[^/]+/g, 'x'), body) : null;
    const where = placeOf(d.on);
    text.push(`- ${named(d.title)}${d.hint ? ` — ${local(d.hint)}` : ''} (${where})`);
    const values = d.choices ? `waarden: ${d.choices.map((c) => `${said(c.value)} = ${c.label}${c.means ? ` (${c.means})` : ''}`).join(', ')}` : d.takes ? `waarde: ${d.takes}` : '';
    if (!d.call) text.push(`  ${values ? `${values}. ` : ''}${d.note || 'Dit stel je op het apparaat zelf in; een bot kan het niet.'}`);
    else {
      text.push(`  ${d.call}${d.field ? ` met body ${bodyShape(d.field)}` : ''}${values ? `; ${values}` : ''}.${d.note ? ` ${d.note}` : ''}`);
      if (no) text.push(`  Niet via een bot: ${no.replace(/^Geweigerd door TeamBot: /, '')}`);
    }
    hits.push({ id, title: d.title, where, call: d.call, field: d.field, values: d.choices?.map((c) => ({ value: c.value, label: c.label, means: c.means })), refused: no || undefined });
  }
  for (const { key } of pages.filter((p) => p.n === best).slice(0, 6)) {
    const page = SETTINGS_PAGES[key];
    const own = Object.values(SETTINGS as Record<string, SettingDef>).filter((d) => d.on === key).map((d) => named(d.title));
    const calls = routes.filter((r) => page.api.some((p) => r.path === p || r.path.startsWith(p + '/'))).slice(0, 8);
    text.push(`- Pagina ${named(page.title)}${page.hint ? ` — ${local(page.hint)}` : ''} (${placeOf(key)})`);
    if (own.length) text.push(`  Instellingen hier: ${own.join(', ')} (zoek er een op met zijn woorden).`);
    if (calls.length) text.push(...calls.map((r) => `  ${r.method} ${r.path} — ${r.text}`));
    else text.push(`  Niet via een bot: dit doet de eigenaar zelf in TeamBot.`);
  }
  for (const { r } of hubs.filter((h) => h.n === best)) {
    text.push(`- ${named(r.title)} — ${local(r.hint)} (Instellingen)`);
    for (const s of r.more || []) text.push(`  ${s.title ? `${local(s.title)}: ` : ''}${s.items.map((k) => named(SETTINGS_PAGES[k]?.title || k)).join(', ')}`);
    text.push('  Zoek een onderdeel op met zijn naam.');
  }
  return { text, hits };
}

/**
 * A message of the owner that names a setting of the screens in its own words ("zet de stijl van de figuurtjes op
 * vilt": the title and a value of one setting): the setting with its call, for that turn. A bot that does not know
 * TeamBot's screens by heart (a small model) then sees that it is TeamBot's own setting, not a file or a web page. Only
 * when at least two words of the message, and at least half of the words that say something, are the setting's own.
 */
export function settingsNamed(ctx: Ctx, userId: string, message: string): string | null {
  const words = fold(String(message || '').slice(0, 400)).replace(/[“”"'‘’?!.,:;()]/g, ' ').split(/\s+/).filter(Boolean);
  const want = words.filter((w) => w.length > 2 && !FILLER.has(w));
  if (want.length < 2 || want.length > 16) return null;
  const lang = userLanguage(ctx.store, userId);
  const both = (list: (string | undefined)[]) => list.flatMap((s) => (s ? [s, lang === 'nl' ? s : tr(lang, s)] : []));
  const scored = Object.values(SETTINGS as Record<string, SettingDef>)
    .filter((d) => d.call)
    .map((d) => ({ d, n: want.filter((w) => holds(fold(both([d.title, d.hint, ...(d.choices || []).map((c) => c.label)]).join(' | ')), w)).length }))
    .filter((x) => x.n >= 2 && x.n * 2 >= want.length)
    .sort((a, b) => b.n - a.n)
    .slice(0, 2);
  if (!scored.length) return null;
  const lines = scored.map(({ d }) => {
    const values = d.choices ? `; waarden: ${d.choices.map((c) => `${said(c.value)} = ${c.label}`).join(', ')}` : '';
    return `- “${d.title}” (${placeOf(d.on)}): ${d.call}${d.field ? ` met body ${bodyShape(d.field)}` : ''}${values}`;
  });
  return `Dit kan over een instelling van TeamBot zelf gaan; die zet je met ${MANAGE_DO} (meer met ${MANAGE_FIND}):\n${lines.join('\n')}`;
}

// ---------- the tools ----------

type Call = Extract<CallPlan, { route: RouteInfo }>;

export function manageTools(ctx: Ctx, svc: TeamsService): ToolDef[] {
  const isMain = (agent: Agent) => svc.mainOf(agent.user_id) === agent.id;
  /** Why TeamBot's screens are not for this conversation (one sentence), or null: only the owner's own conversations. */
  const outside = (agent: Agent, thread: Thread): string | null =>
    notOwnersTalk(ctx, agent, thread) ? `Geweigerd door TeamBot: ${agent.name} bedient TeamBot alleen in een gesprek met zijn eigenaar zelf. In dit gesprek kan dat niet, ook niet om iets op te zoeken.` : null;
  const plan = (a: any, agent: Agent): CallPlan => {
    try {
      return planCall(ctx, agent.user_id, a, { parts: !isMain(agent) });
    } catch (e: any) {
      return { error: `Deze actie kan TeamBot niet lezen: ${e?.message || e}` };
    }
  };
  /**
   * The bot's own walls for this call (reach.ts, with the rule of its route in routetable.ts): a refusal, or the call as
   * this bot makes it. A wall that cannot be read is closed.
   */
  const walls = (agent: Agent, p: Call): { reach: Reach | null; no: string | null; call: Checked | null } => {
    try {
      const reach = reachOf(ctx, svc, agent);
      const call = reach ? reach.check({ method: p.method, path: p.path, query: p.query, body: p.body, route: p.route.path }) : null;
      return { reach, no: call?.no ?? null, call };
    } catch (e: any) {
      ctx.log.error('[teams] reach', e);
      return { reach: null, no: `Geweigerd door TeamBot: de toegang van ${agent.name} tot de teams kon niet worden gelezen. Er is niets gedaan.`, call: null };
    }
  };

  return [
    {
      name: MANAGE_FIND,
      group: GROUP,
      risk: 'read',
      description:
        `Zoek op wat je in TeamBot kunt doen: alles wat de eigenaar in de schermen kan (bots, teams, taken, routines, geheugen, kanalen, apps, skills, instellingen, verbruik, meldingen, mappen, workflows, back-ups …). ` +
        `Geef een woord (word) uit het scherm, bijvoorbeeld “routine”, “thema” of “marktplaats”; je krijgt de acties met methode en pad (bij een instelling ook veld en waarden), die je uitvoert met ${MANAGE_DO}. Zonder woord: de onderdelen.`,
      parameters: { type: 'object', properties: { word: { type: 'string', description: 'Een of meer woorden om op te zoeken, bijvoorbeeld “routine pauzeren”.' } } },
      refuse: (_a, t) => outside(t.agent, t.thread),
      summarize: (a) => (inputLine(a?.word ?? a?.query ?? a?.q, 80) ? words('Opzoeken wat TeamBot kan: “{0}”', inputLine(a.word ?? a.query ?? a.q, 80)) : words('Opzoeken wat TeamBot kan')),
      async run(a, t) {
        const no = outside(t.agent, t.thread);
        if (no) return toolError(no);
        const all = routesOf(ctx).filter((r) => !refusal(r.method, r.path.replace(/:[^/]+/g, 'x'), undefined));
        const label = (g: string) => NOUNS.find(([k]) => k === g)?.[1] || ctx.modules.find((m) => m.id === g)?.label || cap(g.replace(/-/g, ' '));
        const words = fold(inputLine(a?.word ?? a?.query ?? a?.q, 120)).replace(/[“”"'‘’?!.,:;()]/g, ' ').split(' ').filter(Boolean);
        if (!words.length) {
          const groups = new Map<string, number>();
          for (const r of all) groups.set(r.group, (groups.get(r.group) || 0) + 1);
          const lines = [...groups].sort((x, y) => x[0].localeCompare(y[0])).map(([g, n]) => `- ${g} — ${label(g)} (${n})`);
          return { text: `TeamBot kent ${all.length} acties in ${groups.size} onderdelen (pad — wat het is):\n${lines.join('\n')}\n\nZoek verder met een woord, bijvoorbeeld word: “routines”. Een instelling vind je met de woorden van het scherm, bijvoorbeeld word: “thema”.` };
        }
        const settings = findSettings(ctx, all, t.agent.user_id, words);
        // Every word that says something must be in the route (its method, path, line or part); filler words only
        // when they are all there is.
        const want = words.filter((w) => !FILLER.has(w)).length ? words.filter((w) => !FILLER.has(w)) : words;
        const hay = (r: RouteInfo) => fold(`${r.method} ${r.path} ${r.text} ${label(r.group)}`);
        const found = all.filter((r) => want.every((w) => holds(hay(r), w)));
        // Best first: a route with a line of its own that holds the words (the way to find and add a skill), then the
        // words early in the route's line (a route about it) before a route that only mentions them.
        const place = (text: string, w: string) => (text.includes(w) ? text.indexOf(w) : text.includes(stem(w)) ? text.indexOf(stem(w)) : 1000);
        const early = (r: RouteInfo) => want.reduce((s, w) => s + place(fold(r.text), w), 0);
        const own = (r: RouteInfo) => (LINES[`${r.method} ${r.path}`] && want.every((w) => holds(fold(r.text), w)) ? 0 : 1);
        const ranked = found
          .map((r, i) => ({ r, i, o: own(r), s: early(r) }))
          .sort((x, y) => x.o - y.o || (x.o ? x.s - y.s : 0) || x.i - y.i)
          .map((x) => x.r);
        if (!ranked.length && !settings.text.length) return { text: `Niets gevonden voor “${words.join(' ')}”. Probeer één woord, of roep ${MANAGE_FIND} aan zonder woord voor de onderdelen.` };
        const listed = ranked.slice(0, 60);
        const byGroup = new Map<string, RouteInfo[]>();
        for (const r of listed) byGroup.set(r.group, [...(byGroup.get(r.group) || []), r]);
        const lines: string[] = [];
        if (settings.text.length) lines.push('Instellingen (zoals in het scherm):', ...settings.text, '');
        for (const [g, list] of byGroup) lines.push(`${label(g)}:`, ...list.map((r) => `- ${r.method} ${r.path} — ${r.text}`));
        if (ranked.length > listed.length) lines.push(`… en nog ${ranked.length - listed.length}. Zoek preciezer.`);
        lines.push('', `Voer een actie uit met ${MANAGE_DO} (method, path, body). Een :id haal je uit de lijst (GET) van dat onderdeel. Weet je niet welke velden een actie wil, bekijk dan eerst een bestaand item met GET.`);
        return { text: lines.join('\n'), data: { settings: settings.hits, routes: listed.map((r) => ({ method: r.method, path: r.path, text: r.text })) } };
      },
    },
    {
      name: MANAGE_DO,
      group: GROUP,
      // Looking is the base; `riskFor` raises every call that changes something (and fails safe to 'danger').
      risk: 'read',
      riskFor: (a, t): ToolRisk => {
        const p = plan(a, t.agent);
        return 'error' in p || 'refuse' in p ? 'read' : p.risk;
      },
      impact: (a, agent) => {
        const p = plan(a, agent);
        return 'error' in p || 'refuse' in p ? 'external' : p.impact;
      },
      description:
        `Doe in TeamBot wat de eigenaar anders zelf in een scherm zou doen, binnen de teams waar jij toegang toe hebt. Geef de methode en het pad van de actie (zoek ze op met ${MANAGE_FIND}) en bij een wijziging de velden in body. ` +
        'GET kijkt alleen. POST maakt of start iets, PUT en PATCH passen iets aan, DELETE verwijdert. ' +
        'Verwijderen, iets naar anderen versturen of publiceren en een bot meer toegang geven vraagt TeamBot de eigenaar eerst; alles wat over geld gaat vraagt TeamBot altijd. ' +
        'Sleutels, wachtwoorden, inlogsessies, apparaten koppelen, alles exporteren, back-ups terugzetten en bijwerken van TeamBot gaan hier nooit doorheen: dat doet de eigenaar zelf.',
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: [...METHODS], description: 'GET (kijken), POST, PUT, PATCH of DELETE.' },
          path: { type: 'string', description: 'Het pad van de actie, bijvoorbeeld /routines of /routines/rt_123/pause.' },
          query: { type: 'object', description: 'Filters voor een GET, bijvoorbeeld { "status": "open" }.', additionalProperties: true },
          body: { type: 'object', description: 'De velden voor POST, PUT of PATCH.', additionalProperties: true },
        },
        required: ['method', 'path'],
      },
      // Before any card: what the owner would be asked about must be something this bot may do here at all.
      refuse: (a, t) => {
        const p = plan(a, t.agent);
        if ('refuse' in p) return p.refuse;
        return outside(t.agent, t.thread) || ('error' in p ? null : walls(t.agent, p).no);
      },
      summarize: (a, t) => {
        const p = t?.agent ? plan(a, t.agent) : null;
        return p && 'words' in p ? p.words : words('In TeamBot: {0} {1}', inputLine(a?.method, 10).toUpperCase() || 'GET', inputLine(a?.path, 200));
      },
      async run(a, t) {
        const no = outside(t.agent, t.thread);
        if (no) return toolError(no);
        const p = plan(a, t.agent);
        if ('error' in p) return toolError(p.error);
        if ('refuse' in p) return toolError(p.refuse);
        const owner = ctx.store.user(t.agent.user_id);
        if (!owner || owner.disabled) return toolError('De eigenaar van deze bot is niet gevonden.');
        const wall = walls(t.agent, p);
        if (wall.no) return toolError(wall.no);
        const mine = wall.call && 'query' in wall.call ? wall.call : null;
        // All of memory at once (routetable.ts 'whole'): only when the owner himself began this work; a card is not enough.
        if (mine?.ownerChain && !chainFromOwner(ctx, t.run, t.thread))
          return toolError(`Geweigerd door TeamBot: dit gaat over het geheugen als geheel; dat doet ${t.agent.name} alleen als je eigenaar er zelf om vraagt in zijn eigen gesprek. Er is niets veranderd.`);
        if (p.widen.length) {
          if (owner.role !== 'owner') return toolError('Alleen de eigenaar van deze TeamBot-installatie kan een bot meer toegang geven.');
          if (!t.approved && !(await askYesNo(t, MANAGE_DO, a, `${t.agent.name} wil meer toegang geven: ${listText(p.widen)} (${describe(ctx, p.method, p.route.path, { userId: owner.id, path: p.path, body: p.body })}). Goed?`)).yes)
            return toolError('De eigenaar wil dit niet. Er is niets veranderd.');
        }
        // Whose word counts (selftools.ts): this work did not begin with a message the owner typed, so one card for
        // him first. For every bot, the main bot too.
        else if (p.risk !== 'read' && !askedByOwner(ctx, t)) {
          const no = await proposeToOwner(t, MANAGE_DO, a, t.agent.name, [p.summary]);
          if (no) return toolError(no);
        }
        // The call as this bot makes it: its own team where none was named, a list merged with what it cannot see.
        const url = mine ? (mine.query ? `${p.path}?${mine.query}` : p.path) : p.url;
        const r = await callAsUser(ctx, owner, { method: p.method, url, body: mine ? mine.body : p.body }, t.signal);
        const isJson = /json/i.test(r.type);
        let json: any;
        if (isJson) {
          try {
            json = JSON.parse(r.body.toString('utf8') || 'null');
          } catch {
            json = undefined;
          }
        }
        if (r.status >= 400) {
          const msg = redact(inputLine(json?.error, 600) || `fout ${r.status}`);
          if (json?.code === 'mobile_denied' || r.status === 401) return toolError(`Geweigerd door TeamBot: ${msg} Een bot kan dit niet; de eigenaar doet het zelf.`);
          return toolError(`Niet gelukt (${p.summary}): ${msg}${r.status === 404 ? `${/[.!?]$/.test(msg) ? '' : '.'} Klopt het id? Haal het uit de lijst (GET), of zoek de actie op met ${MANAGE_FIND}.` : ''}`);
        }
        if (!isJson || json === undefined) {
          // Text or a file cannot be looked through for what lies behind a wall: a bot with walls does not get it.
          if (wall.reach?.walls) return { text: `${p.summary} — gelukt.${r.body.length ? ' Het antwoord is geen lijst of item van TeamBot; dat kun je hier niet lezen.' : ''}` };
          if (/^text\//i.test(r.type)) return { text: `${p.summary} — gelukt.\n${redact(r.body.toString('utf8')).slice(0, MAX_OUT)}` };
          return { text: r.body.length ? `${p.summary} — gelukt. Het antwoord is een bestand (${r.type || 'onbekend soort'}, ${r.body.length} bytes); dat kun je hier niet lezen.` : `${p.summary} — gelukt.` };
        }
        if (wall.reach) {
          if (mine) json = mine.after(json);
          // The answer itself is something of a team the bot cannot look into (found by a name, not an id).
          if (wall.reach.hides(json)) return p.risk === 'read' ? toolError(wall.reach.closed) : { text: `${p.summary} — gelukt.` };
          json = wall.reach.filter(json);
        }
        return { text: `${p.summary} — gelukt.\n${answerText(json)}` };
      },
    },
  ];
}

