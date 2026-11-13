import { SETTINGS_PAGES, SETTINGS_ROWS, type SettingsRowDef } from '../../../shared/settings.js';

/**
 * Command palette (Ctrl+K), the pure part: the index of pages and settings, matching and ranking, grouping and the
 * recent list. No React here, so it is unit-tested (tests/palette.test.ts). The component is shell/CommandPalette.tsx.
 */

export type PaletteKind = 'recent' | 'action' | 'bot' | 'group' | 'chat' | 'page' | 'setting' | 'channel' | 'skill' | 'app' | 'routine' | 'task' | 'file' | 'memory' | 'message';

export interface PaletteItem {
  /** Unique within its kind. */
  id: string;
  kind: PaletteKind;
  title: string;
  subtitle?: string;
  href?: string;
  /** Extra words that should find this item ("telegram" finds Kanalen). */
  keywords?: string[];
  /** Name of a lucide icon for pages/settings/actions (resolved by the component). */
  icon?: string;
  /** For bot avatars and chats. */
  agentId?: string | null;
  /** Text with the match between [ and ] (messages, memory). */
  snippet?: string;
  at?: string | null;
  /** Internal: ranking score (higher is better). */
  score?: number;
}

export const GROUP_ORDER: PaletteKind[] = ['recent', 'action', 'bot', 'group', 'chat', 'page', 'setting', 'channel', 'skill', 'app', 'routine', 'task', 'file', 'memory', 'message'];

export const GROUP_LABEL: Record<PaletteKind, string> = {
  recent: 'Recent',
  action: 'Snelle acties',
  bot: 'Bots',
  group: 'Groepen',
  chat: 'Gesprekken',
  page: "Pagina's",
  setting: 'Instellingen',
  channel: 'Kanalen',
  skill: 'Skills',
  app: 'Apps',
  routine: 'Routines',
  task: 'Taken',
  file: 'Bestanden',
  memory: 'Geheugen',
  message: 'In gesprekken',
};

/** Lowercase, without accents, single spaces: "Privé-container" → "prive-container". */
export function norm(s: string): string {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const words = (s: string) => s.split(/[\s/·,()&+.:_-]+/).filter(Boolean);

/** How well one query term matches one text (0 = not at all). */
function termScore(term: string, text: string): number {
  if (!text) return 0;
  if (text === term) return 100;
  if (text.startsWith(term)) return 80;
  const ws = words(text);
  if (ws.some((w) => w === term)) return 70;
  if (ws.some((w) => w.startsWith(term))) return 60;
  if (term.length >= 3 && text.includes(term)) return 40;
  return 0;
}

/**
 * Score of an item for a query: every word of the query must match the title, a keyword or the context (prefix of a
 * word, or a substring from 3 letters). The title counts most, then keywords, then context (e.g. a bot's role). 0 = no
 * match.
 */
export function matchScore(query: string, title: string, keywords: string[] = [], context: string[] = []): number {
  const q = norm(query);
  if (!q) return 0;
  const t = norm(title);
  const ks = keywords.map(norm).filter(Boolean);
  const cs = context.map(norm).filter(Boolean);
  // The whole query against the title first ("mijn skills").
  const whole = termScore(q, t);
  if (whole >= 60) return whole + 20;
  let total = 0;
  for (const term of q.split(' ')) {
    const inTitle = termScore(term, t);
    const inKeys = Math.max(0, ...ks.map((k) => termScore(term, k))) * 0.75;
    const inContext = Math.max(0, ...cs.map((k) => termScore(term, k))) * 0.4;
    const best = Math.max(inTitle, inKeys, inContext);
    if (!best) return 0;
    total += best;
  }
  return total / q.split(' ').length;
}

/** Rank items for a query and keep the best `perKind` of each kind. */
export function rank(query: string, items: PaletteItem[], perKind = 6): PaletteItem[] {
  // The subtitle of a page or setting is only where it lives ("Instellingen · Telefoon & spraak"): not searched.
  const context = (it: PaletteItem) => (it.kind === 'page' || it.kind === 'setting' || !it.subtitle ? [] : [it.subtitle]);
  const scored = items.map((it) => ({ ...it, score: matchScore(query, it.title, it.keywords, context(it)) })).filter((it) => it.score! > 0);
  scored.sort((a, b) => b.score! - a.score! || a.title.localeCompare(b.title, 'nl'));
  const per = new Map<PaletteKind, number>();
  return scored.filter((it) => {
    const n = per.get(it.kind) || 0;
    if (n >= perKind) return false;
    per.set(it.kind, n + 1);
    return true;
  });
}

export interface PaletteGroup {
  kind: PaletteKind;
  label: string;
  items: PaletteItem[];
}

/**
 * Group in the fixed order; with a query, the group holding the best hit comes first (after quick actions), so the
 * most likely answer is the first one under the cursor.
 */
export function groupItems(items: PaletteItem[], o: { bestFirst?: boolean } = {}): PaletteGroup[] {
  const by = new Map<PaletteKind, PaletteItem[]>();
  for (const it of items) {
    const list = by.get(it.kind) || [];
    list.push(it);
    by.set(it.kind, list);
  }
  let order = GROUP_ORDER.filter((k) => by.has(k));
  if (o.bestFirst) {
    const best = (k: PaletteKind) => Math.max(...(by.get(k) || []).map((i) => i.score || 0));
    const pinned = order.filter((k) => k === 'recent');
    const rest = order.filter((k) => k !== 'recent');
    // Stable: equal scores keep the fixed order. Server results (messages, files…) have no score and keep their place.
    rest.sort((a, b) => best(b) - best(a) || GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b));
    order = [...pinned, ...rest];
  }
  return order.map((k) => ({ kind: k, label: GROUP_LABEL[k], items: by.get(k)! }));
}

// ---------------- the index of pages and settings ----------------

export interface ModuleShape {
  id: string;
  label: string;
  pages?: { path: string; title: string; nav?: boolean; bare?: boolean }[];
  settingsTabs?: { id: string; title: string; adminOnly?: boolean }[];
}

/** Detail pages that need an id: not a destination on their own. */
const SKIP_PAGES = new Set(['mcp/c', 'memory/item', 'rooms/groep', 'routines/r', 'workflows/w', 'workflows/run', 'browser/live', 'mobile/delen', 'usage/eiland', 'seen/', 'teams/']);

/** Words people use for a page ("winkel" finds the Marktplaats). Keys: `<module>/<path>`. */
const PAGE_WORDS: Record<string, string[]> = {
  'skills/': ['marktplaats', 'market', 'winkel', 'store', 'skills installeren', 'sjablonen', 'templates', 'apps installeren'],
  'skills/mine': ['mijn skills', 'vaardigheden', 'skills bijwerken', 'updates'],
  'mcp/': ['apps', 'connectors', 'koppelingen', 'mcp', 'integraties', 'gmail', 'agenda', 'notion', 'drive', 'github'],
  'routines/': ['routines', 'planning', 'cron', 'schema', 'automatisch', 'herhalen', 'elke ochtend', 'webhook'],
  'routines/werk': ['werk', 'vaste taken', 'proactief', 'projecten', 'kansen', 'bewakers', 'budget', 'overzicht'],
  'workflows/': ['workflows', 'workflow', 'stappen', 'keten', 'proces', 'automatiseren', 'akkoord', 'pijplijn'],
  'routines/kalender': ['kalender', 'agenda', 'week', 'maand', 'wanneer', 'wachtpunt'],
  'channels/': ['kanalen', 'telegram', 'whatsapp', 'discord', 'slack', 'e-mail', 'mail', 'berichten'],
  'browser/': ['computers', 'browser', 'bureaublad', 'desktop', 'ssh', 'server', 'container', 'docker', 'cloud-vm', 'computer use'],
  'browser/kluis': ['kluis', 'wachtwoorden', 'inloggegevens', 'vault', 'logins', 'sleutels voor scripts', 'api-sleutels', 'tokens'],
  'memory/': ['geheugen', 'herinneringen', 'onthouden', 'dossiers', 'memory'],
  'memory/beoordelen': ['geheugenvoorstellen', 'voorstellen', 'goedkeuren'],
  'memory/over-jou': ['profiel', 'over mij'],
  'rooms/': ['groepschat', 'groepschats', 'groepen', 'team', 'groepsgesprek', 'samenwerken'],
  'rooms/taken': ['takenbord', 'kanban', 'taken'],
  'teamdata/': ['teamwerk', 'taken', 'beslissingen', 'logboek', 'experimenten', 'tabellen'],
  'voice/': ['spraak', 'gesprekken', 'bellen', 'stem'],
  'voice/vergadering': ['vergadering', 'notulen', 'opnemen', 'transcript', 'meeting'],
  'folders/': ['bestanden', 'teammap', 'mappen', 'files', 'documenten'],
  'usage/': ['gebruik', 'limieten', 'quota', 'abonnement', 'tokens', 'reset'],
  'usage/status': ['nu bezig', 'status', 'lopende taken'],
  'mobile/concepten': ['concepten', 'offline', 'drafts'],
  'openbot-import/': ['overstappen', 'openbot', 'importeren', 'migreren'],
  'notifications/': ['meldingen', 'notificaties', 'bel', 'geschiedenis', 'ongelezen'],
  'backups/nieuw': ['wat is er nieuw', 'nieuw', 'wijzigingen', 'update', 'changelog'],
  'sites/': ['website', 'websites', 'site', 'publiceren', 'webpagina', 'link delen', 'html'],
  'rooms/organisatie': ['organisatie', 'organigram', 'teams', 'afdelingen', 'chief of staff'],
  'agents/': ['bots', 'alle bots', 'archief', 'importeren', 'agents'],
  'remote-desktop/': ['bureaublad op afstand', 'op afstand', 'remote desktop', 'scherm delen', 'meekijken', 'overnemen', 'telefoon', 'bedienen', 'muis', 'toetsenbord'],
};

/** Search words for a page (`<module>/<path>`, or `agents/` for Alle bots), also used by the filter in Instellingen. */
export function pageWords(key: string): string[] {
  return PAGE_WORDS[key] || [];
}

/** Words for settings tabs. Keys: the tab id in #/settings/<id>. */
const SETTING_WORDS: Record<string, string[]> = {
  general: ['taal', 'language', 'naam', 'thema', 'donker', 'licht', 'dark mode', 'uiterlijk', 'weergave', 'kleur', 'kleuren', 'accentkleur', 'logokleur', 'lavendel', 'gezichten', 'figuurtjes', 'stijl', 'glad', 'vilt'],
  regels: ['regels', 'eigen regels', 'toestemming', 'nooit', 'eerst vragen', 'mag altijd'],
  'kant-en-klaar': ['kant-en-klaar', 'sjabloon', 'sjablonen', 'team uit een sjabloon', 'voorbeeldteam', 'webshop', 'privé-team'],
  vanzelf: ['wat start vanzelf', 'automatisch', 'gepland', 'planning', 'check-in', 'overzicht', 'leerronde', 'hoe vaak', 'uit zichzelf'],
  slot: ['vergrendeling', 'app-vergrendeling', 'pincode', 'vingerafdruk', 'slot', 'beveiliging'],
  providers: ['ai', 'ai-providers', 'providers', 'diensten', 'api-sleutel', 'engine', 'model', 'sleutel', 'api key', 'claude', 'openai', 'codex', 'ollama', 'gemini', 'koppelen'],
  usage: ['kosten', 'budget', 'uitgaven', 'geld', 'dagbudget'],
  security: ['beveiliging', 'wachtwoord', 'sessies', 'apparaten', 'toegang', 'tokens', 'automation', 'logboek'],
  data: ['gegevens', 'data', 'waar staat mijn data', 'datamap', 'privacy', 'diagnose', 'verwijderen'],
  backups: ['back-up', 'backup', 'terugzetten', 'herstellen', 'export', 'exporteren', 'veiligheidskopie'],
  users: ['gebruikers', 'leden', 'uitnodigen', 'rollen', 'sso', 'scim'],
  'mobile-telefoon': ['telefoon', 'mobiel', 'iphone', 'android', 'koppelen', 'push', 'tailscale', 'qr', 'pwa'],
  'usage-limits': ['limieten', 'gebruik', 'waarschuwing', 'quota', 'statusvenster'],
  'folders-teammap': ['teammap', 'gedeelde map', 'shared'],
  'voice-spraak': ['spraak', 'stem', 'dicteren', 'voorlezen', 'microfoon', 'tts', 'whisper'],
  'notifications-meldingen': ['meldingen', 'geluid', 'notificaties', 'stil', 'niet storen', 'per bot'],
  'engine-chain-doorschakelen': ['doorschakelen', 'gratis keten', 'reserve', 'belangrijk', 'minimumniveau', 'weekreserve', 'pauzeren', 'privé', 'limiet op'],
  'cli-agents-cli': ['abonnementen', 'cli-agents', 'claude', 'chatgpt', 'claude code', 'codex', 'opencode', 'cli', 'terminal', 'abonnement', 'inloggen'],
  'routines-routines': ['routines', 'standaard', 'tijdzone routines', 'dagelijkse limiet'],
  'skills-uitgevers': ['uitgevers', 'beleid', 'vertrouwen', 'handtekening', 'ondertekend', 'licentie'],
  'openbot-import-overstappen': ['openbot', 'overstappen', 'importeren', 'migreren'],
  'backups-app': ['back-up', 'backup', 'terugzetten', 'herstellen', 'restore', 'update', 'bijwerken', 'automatisch bijwerken', 'updatekanaal', 'vorige versie', 'wat is er nieuw'],
  'teams-teams': ['teams', 'team', 'werkruimtes', 'bedrijven', 'nieuw team', 'team maken', 'toegang', 'meekijken', 'aansturen', 'bedrijfsprofiel', 'thuisteam'],
  'health-status': ['hoe gaat het', 'traag', 'hapert', 'vastlopen', 'stilstand', 'snelheid', 'prestaties', 'geheugen', 'status', 'gezondheid'],
  'websearch-zoeken': ['zoeken op internet', 'zoekmachine', 'web search', 'zoekdienst', 'keenable', 'parallel', 'tavily', 'exa', 'brave', 'duckduckgo', 'searxng', 'jina', 'pagina lezen', 'pdf lezen'],
  'images-afbeeldingen': ['afbeeldingen maken', 'afbeelding', 'plaatje', 'foto', 'beeld', 'image', 'banner', 'illustratie', 'dall-e', 'flux'],
  telefoon: ['telefoon', 'mobiel', 'iphone', 'android', 'koppelen', 'qr'],
  teams: ['teams', 'team', 'nieuw team', 'teamnaam'],
  veilig: ['back-up', 'backup', 'terugzetten', 'herstellen', 'veiligheidskopie'],
  meer: ['meer mogelijkheden', 'geavanceerd', 'meer instellingen', 'alles', 'extra', 'aanzetten', 'installeren'],
  systeem: ['wakker', 'slaapstand', 'geavanceerd tonen', 'pc', 'computer'],
  'bot-defaults': ['standaard', 'standaardmodel', 'tijdzone', 'dagbudget', 'budget', 'nieuwe bots', 'taal van bots'],
  'ai-meer': ['lokale modellen', 'ollama', 'andere dienst', 'gemini', 'groq', 'mistral', 'modelgegevens'],
  'network-proxy': ['proxy', 'netwerk', 'bedrijfsnetwerk', 'kantoor', 'http proxy', 'no proxy', 'firewall', 'internetverbinding'],
};

// The list of Instellingen itself (its rows, their entries and the words of each) is in shared/settings.ts, where every
// bot finds the same words through teambot_find.
export { SETTINGS_ROWS, type SettingsRowDef } from '../../../shared/settings.js';
/** The row that takes every module tab that is listed nowhere. */
const CATCH_ALL = 'meer';
const isPageKey = (item: string) => item.includes('/');
const moreOf = (r: SettingsRowDef) => (r.more || []).flatMap((s) => s.items);
/** The key of a row in the navigation: its main entry, else its own overview page. */
const rowKey = (r: SettingsRowDef) => r.main || r.id;
const LISTED = new Set(SETTINGS_ROWS.flatMap((r) => [rowKey(r), ...moreOf(r)]));
/** Entries that the page of their row already links to itself: not again under that row. None today. */
const LINKED_IN_PAGE = new Set<string>([]);

/**
 * Entries shown only with "Geavanceerd tonen" on. Empty since "Meer mogelijkheden" is one row of its own: everything
 * optional is listed there for everyone, so there is no second, hidden layer. (The filter itself stays, for a future need.)
 */
export const ADVANCED_ONLY = new Set<string>([]);

/**
 * Settings links that show another entry: never listed themselves (one Back-ups, one Gebruik). Their links keep working
 * and mark the entry they belong to. `advanced` and `geavanceerd` are the old links to what is now "Meer mogelijkheden";
 * `appearance` and `meldingen` were pages of their own and are part of another page now.
 */
export const SETTINGS_ALIASES: Record<string, string> = {
  'backups-app': 'backups',
  'usage-limits': 'usage/',
  advanced: 'meer',
  geavanceerd: 'meer',
  appearance: 'general',
  meldingen: 'notifications-meldingen',
};

/** The entry a settings link shows (an alias shows the entry it belongs to). */
export const settingsRowOf = (key: string | null): string | null => (key && SETTINGS_ALIASES[key]) || key;

/** The row an entry belongs to (a module tab that is listed nowhere: Algemeen). */
export function settingsParentOf(id: string): SettingsRowDef {
  const key = settingsRowOf(id) || id;
  return SETTINGS_ROWS.find((r) => rowKey(r) === key || r.id === key || moreOf(r).includes(key)) || SETTINGS_ROWS.find((r) => r.id === CATCH_ALL)!;
}

/** True for an entry under "Meer" of a row (not the row's own page). */
export function isSubEntry(id: string): boolean {
  const key = settingsRowOf(id) || id;
  const row = settingsParentOf(key);
  return rowKey(row) !== key && row.id !== key;
}

/** Where an entry lives, for the palette: "Instellingen" for the page of a row itself, else "Instellingen · <row>". */
function settingsPlace(id: string): string {
  const key = settingsRowOf(id) || id;
  const r = settingsParentOf(key);
  return rowKey(r) === key ? 'Instellingen' : `Instellingen · ${r.title}`;
}

/** Search words for a settings tab (also used by the filter on the Settings page). */
export function settingWords(tabId: string): string[] {
  return SETTING_WORDS[tabId] || [];
}

/** Pages of the app itself (not a module) that live under Instellingen. */
const CORE_PAGES: Record<string, { title: string; href: string }> = { 'agents/': { title: 'Alle bots', href: '#/agents' } };
/** The name of every entry in Instellingen (shared/settings.ts); a module's own title only for an entry not described there. */
const ENTRY_TITLES: Record<string, string> = Object.fromEntries(Object.entries(SETTINGS_PAGES).map(([k, p]) => [k, p.title]));
/** Detail pages shown inside Instellingen under their list page (the list stays marked in the navigation). */
const HOSTED_DETAIL: Record<string, string> = { 'mcp/c': 'mcp/', 'rooms/groep': 'rooms/', 'teams/': 'teams-teams' };
/** Modules whose every page (tabs, details) lives under their first page in Instellingen: Geheugen. */
const HOSTED_MODULES = new Set(['memory']);
/**
 * Modules with a fixed place of their own in the sidebar (the Marktplaats): their pages are never shown inside
 * Instellingen and are not listed there either (one place for each thing).
 */
const OWN_PLACES = new Set(['skills']);

/**
 * The Instellingen entry a page belongs to (`<module>/<path>`, or `agents/`), or null when the page has its own place
 * (Taken, Routines, Marktplaats, chats …). Such pages are shown inside Instellingen and keep their own URL.
 */
export function settingsHostOf(key: string): string | null {
  if (OWN_PLACES.has(key.split('/')[0])) return null;
  if (HOSTED_DETAIL[key]) return HOSTED_DETAIL[key];
  if (isPageKey(key) && LISTED.has(key)) return key;
  const mod = key.split('/')[0];
  return HOSTED_MODULES.has(mod) ? `${mod}/` : null;
}

export interface SettingsRow {
  /** Tab id or page key. */
  key: string;
  kind: 'tab' | 'page';
  title: string;
  href: string;
  /** Rarely needed (ADVANCED_ONLY). */
  advanced?: boolean;
  /** Title of the row an entry under "Meer" belongs to (search results say where an entry lives). */
  parent?: string;
}

export interface SettingsNavRow extends SettingsRow {
  id: string;
  icon: string;
  /** False for a row without a page of its own: its page is the overview of `more`. */
  hasMain: boolean;
  /** A list of what the bots have (the second part of the list), not a setting. */
  work: boolean;
  /** The entries under "Meer" (for a row without a page of its own: its whole overview), in sections. */
  more: { title?: string; rows: SettingsRow[] }[];
}

/** Every row with all its entries that exist for this user, before any filter. */
function allRows(tabs: { id: string; label: string }[], modules: ModuleShape[]): SettingsNavRow[] {
  const tabById = new Map(tabs.map((t) => [t.id, t]));
  const entry = (key: string): SettingsRow | null => {
    if (CORE_PAGES[key]) return { key, kind: 'page', title: CORE_PAGES[key].title, href: CORE_PAGES[key].href };
    if (!isPageKey(key)) return tabById.has(key) ? { key, kind: 'tab', title: ENTRY_TITLES[key] || tabById.get(key)!.label, href: `#/settings/${key}` } : null;
    const [mod, path = ''] = key.split(/\/(.*)/);
    const p = modules.find((m) => m.id === mod)?.pages?.find((x) => x.path === path);
    return p ? { key, kind: 'page', title: ENTRY_TITLES[key] || p.title, href: `#/m/${mod}/${path}` } : null;
  };
  const out: SettingsNavRow[] = [];
  for (const r of SETTINGS_ROWS) {
    const more: SettingsNavRow['more'] = (r.more || []).map((s) => ({
      title: s.title,
      rows: s.items.flatMap((k) => {
        const e = entry(k);
        return e ? [{ ...e, parent: r.title, ...(ADVANCED_ONLY.has(k) ? { advanced: true } : {}) }] : [];
      }),
    }));
    if (r.id === CATCH_ALL) {
      const lost = tabs.filter((t) => !LISTED.has(t.id) && !SETTINGS_ALIASES[t.id]);
      if (lost.length) {
        if (!more.length) more.push({ rows: [] });
        more[0].rows.push(...lost.map((t) => ({ key: t.id, kind: 'tab' as const, title: t.label, href: `#/settings/${t.id}`, parent: r.title })));
      }
    }
    const main = r.main ? entry(r.main) : null;
    if (r.main ? !main : !more.some((s) => s.rows.length)) continue;
    out.push({ id: r.id, icon: r.icon, key: rowKey(r), kind: main?.kind || 'tab', title: r.title, href: main?.href || `#/settings/${r.id}`, hasMain: !!main, work: !!r.work, more: more.filter((s) => s.rows.length) });
  }
  return out;
}

/**
 * The Settings list: one flat list of rows (at most eight), from the settings tabs that exist (`tabs`, already filtered
 * for the user's role) and the pages of the modules. Each row carries its entries for "Meer": rarely needed ones
 * (ADVANCED_ONLY) only with `advanced` ("Geavanceerd tonen") or while that entry is `current`; entries the row's page
 * links to itself are left out. A row without a page of its own and without entries is dropped. Pure, so it is
 * unit-tested.
 */
export function settingsNav(tabs: { id: string; label: string }[], modules: ModuleShape[], o: { advanced?: boolean; current?: string | null } = {}): SettingsNavRow[] {
  const cur = settingsRowOf(o.current || null);
  return allRows(tabs, modules)
    .map((r) => ({ ...r, more: r.more.map((s) => ({ ...s, rows: s.rows.filter((e) => (!e.advanced || o.advanced || e.key === cur) && !LINKED_IN_PAGE.has(e.key)) })).filter((s) => s.rows.length) }))
    .filter((r) => r.hasMain || r.more.length);
}

/** The filter of the Settings list: every entry that matches (rows and what is under "Meer", also the rare ones), best first. */
export function settingsSearch(tabs: { id: string; label: string }[], modules: ModuleShape[], q: string): SettingsRow[] {
  const query = q.trim();
  if (!query) return [];
  const words = (r: SettingsRow) => (r.kind === 'tab' ? settingWords(r.key) : pageWords(r.key));
  const all = allRows(tabs, modules).flatMap((r) => [{ key: r.key, kind: r.kind, title: r.title, href: r.href } as SettingsRow, ...r.more.flatMap((s) => s.rows)]);
  return all
    .map((r, i) => ({ r, i, score: matchScore(query, r.title, words(r)) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.r);
}

export interface IndexOpts {
  isAdmin?: boolean;
  serverMode?: boolean;
}

/** Pages and settings of the app, from the module list (so new modules are found automatically). */
export function staticEntries(modules: ModuleShape[], o: IndexOpts = {}): PaletteItem[] {
  const out: PaletteItem[] = [
    { id: 'chats', kind: 'page', title: 'Chats', href: '#/', icon: 'MessageCircle', keywords: ['gesprekken', 'start', 'home'] },
    { id: 'inbox', kind: 'page', title: 'Wacht op jou', href: '#/inbox', icon: 'Inbox', keywords: ['goedkeuringen', 'vragen', 'inbox', 'toestemming'] },
    { id: 'tasks', kind: 'page', title: 'Taken', href: '#/tasks', icon: 'ListChecks', keywords: ['takenbord', 'kanban', 'to-do', 'werk', 'opdrachten'] },
    { id: 'agents', kind: 'page', title: 'Alle bots', subtitle: settingsPlace('agents/'), href: '#/agents', icon: 'Bot', keywords: PAGE_WORDS['agents/'] },
  ];
  for (const m of modules) {
    for (const p of m.pages || []) {
      const key = `${m.id}/${p.path}`;
      if (p.bare || SKIP_PAGES.has(key)) continue;
      // A page under Instellingen says so ("Instellingen · Meer mogelijkheden"); others name their module.
      const sub = settingsHostOf(key) ? settingsPlace(key) : p.path && p.title !== m.label ? m.label : undefined;
      out.push({ id: key, kind: 'page', title: p.title, subtitle: sub, href: `#/m/${m.id}/${p.path}`, icon: `page:${m.id}`, keywords: [...(PAGE_WORDS[key] || []), ...(p.path ? [] : [m.label]), ...(ENTRY_TITLES[key] ? [ENTRY_TITLES[key]] : [])] });
    }
  }
  const has = (id: string) => modules.some((m) => (m.settingsTabs || []).some((t) => `${m.id}-${t.id}` === id));
  const core: { id: string; title: string }[] = [
    { id: 'general', title: ENTRY_TITLES.general },
    { id: 'providers', title: ENTRY_TITLES.providers },
    ...(has('mobile-telefoon') ? [{ id: 'telefoon', title: ENTRY_TITLES.telefoon }] : []),
    ...(has('teams-teams') ? [{ id: 'teams', title: ENTRY_TITLES.teams }] : []),
    { id: 'regels', title: ENTRY_TITLES.regels },
    { id: 'veilig', title: ENTRY_TITLES.veilig },
    { id: 'slot', title: ENTRY_TITLES.slot },
    { id: 'meer', title: SETTINGS_ROWS.find((r) => r.id === 'meer')!.title },
    { id: 'kant-en-klaar', title: ENTRY_TITLES['kant-en-klaar'] },
    { id: 'vanzelf', title: ENTRY_TITLES.vanzelf },
    { id: 'bot-defaults', title: ENTRY_TITLES['bot-defaults'] },
    { id: 'ai-meer', title: ENTRY_TITLES['ai-meer'] },
    { id: 'systeem', title: ENTRY_TITLES.systeem },
    { id: 'usage', title: ENTRY_TITLES.usage },
    { id: 'security', title: ENTRY_TITLES.security },
    { id: 'data', title: ENTRY_TITLES.data },
    { id: 'backups', title: ENTRY_TITLES.backups },
    ...(o.isAdmin && o.serverMode ? [{ id: 'users', title: ENTRY_TITLES.users }] : []),
  ];
  const sub = settingsPlace;
  for (const t of core) out.push({ id: `settings:${t.id}`, kind: 'setting', title: t.title, subtitle: sub(t.id), href: `#/settings/${t.id}`, icon: 'Settings', keywords: SETTING_WORDS[t.id] || [] });
  for (const m of modules)
    for (const t of m.settingsTabs || []) {
      if (t.adminOnly && !o.isAdmin) continue;
      const id = `${m.id}-${t.id}`;
      out.push({ id: `settings:${id}`, kind: 'setting', title: ENTRY_TITLES[id] || t.title, subtitle: sub(id), href: `#/settings/${id}`, icon: 'Settings', keywords: [...(SETTING_WORDS[id] || []), m.label, t.title] });
    }
  return out;
}

// ---------------- recent ----------------

export const RECENT_MAX = 8;

/** Put an item on top of the recent list (without score/snippet; actions are stored by id and re-resolved). */
export function pushRecent(list: PaletteItem[], it: PaletteItem): PaletteItem[] {
  const clean: PaletteItem = { id: it.id, kind: it.kind, title: it.title, subtitle: it.subtitle, href: it.href, icon: it.icon, agentId: it.agentId };
  return [clean, ...list.filter((x) => !(x.id === it.id && x.kind === it.kind))].slice(0, RECENT_MAX);
}
