/**
 * TeamBot's settings, described once. The screens show these words, and every bot finds a setting by the same words
 * through `teambot_find` (server/modules/teams/manage.ts), with the call that changes it, its field and what each value
 * means. Nothing here is said twice:
 *  - SETTINGS_ROWS: the list of Instellingen, with the one line under each row (ui/src/lib/palette.ts builds the list,
 *    ui/src/pages/Settings.tsx shows it);
 *  - SETTINGS_PAGES: every entry of that list (a settings tab or a page), its title and its one line, and the parts of
 *    TeamBot's API the page works with;
 *  - SETTINGS: every setting row and switch of the screens (SettingRow and SwitchRow in
 *    ui/src/components/SettingControls.tsx take their title and line from here, by id).
 * A new setting is described here or it cannot be shown (tests/settings-find.test.ts finds every row and switch of the
 * screens through teambot_find by its own words). Pure data: no DOM, no server.
 */
import { ACCENTS } from './accent.js';
import { LANGUAGES } from './languages.js';

// ---------------------------------------------------------------- the list of Instellingen

export interface SettingsRowDef {
  /** Also the settings tab id of the overview page of a row without `main` (#/settings/<id>). */
  id: string;
  title: string;
  /** One short line under the row (narrow screen) and under the title of its page. */
  hint: string;
  /** Name of a lucide icon (resolved by the component). */
  icon: string;
  main?: string;
  more?: { title?: string; items: string[] }[];
  /** Not a setting: a list of what the bots have (the second part of the list). */
  work?: boolean;
}

/**
 * Instellingen ("ik zie nog veel instellingen staan waar ik niet veel van snap"): ONE list, and every row opens one
 * thing. First what everyone needs and has to choose himself (connect an AI, pair the phone, language and look, his own
 * rules, back-ups, the lock), then what the bots have (bots, teams, memory, channels, apps, files). No overview pages in
 * between.
 *
 * The LAST row, "Meer mogelijkheden", is the one place for everything optional: every function you can switch on or set
 * up is listed there as one row with one line that says what it is. Nothing optional is on by necessity and nothing is
 * hidden: it is all there, and nowhere else.
 *
 * RULE for new entries: add them to "Meer mogelijkheden", unless nobody can use TeamBot without them. A module tab that
 * is listed nowhere lands there by itself, so nothing is ever lost (tests/palette.test.ts).
 *
 * An entry is one of:
 *  - a settings tab id (#/settings/<id>), e.g. `general` or `mobile-telefoon` (module tabs are `<module>-<tab>`);
 *  - a page key with a slash: a module page `<module>/<path>` (#/m/<module>/<path>), or `agents/` for Alle bots.
 */
export const SETTINGS_ROWS: SettingsRowDef[] = [
  // ---- what everyone needs and chooses himself
  // What is connected, and the ways to add one (the same row for every kind of AI).
  { id: 'ai', title: 'AI-diensten', hint: 'De AI waarmee je bots werken.', icon: 'Sparkles', main: 'providers' },
  { id: 'phone', title: 'Telefoon', hint: 'Koppelen met een QR-code.', icon: 'Smartphone', main: 'telefoon' },
  // Name, language, light or dark, colour and the style of the bot figures.
  { id: 'general', title: 'Taal en uiterlijk', hint: 'Naam, taal, thema en kleur.', icon: 'Palette', main: 'general' },
  // His own rules in plain words: what the bots never may, must ask first, or always may.
  { id: 'rules', title: 'Regels', hint: 'Wat bots nooit mogen of eerst vragen.', icon: 'ShieldCheck', main: 'regels' },
  // Make a back-up and put one back (the daily one comes by itself).
  { id: 'backup', title: 'Back-ups', hint: 'Back-up maken of terugzetten.', icon: 'DatabaseBackup', main: 'veilig' },
  { id: 'lock', title: 'Vergrendeling', hint: 'Pincode op TeamBot.', icon: 'Lock', main: 'slot' },
  // ---- what the bots have: lists a person looks things up in (Groepen and Workflows have their own places)
  { id: 'bots', title: 'Bots', hint: 'Alle bots, en een nieuwe maken.', icon: 'Bot', main: 'agents/', work: true },
  { id: 'teams', title: 'Teams', hint: 'De naam van je team, of een nieuw team.', icon: 'Users', main: 'teams', work: true },
  { id: 'memory', title: 'Geheugen', hint: 'Wat bots onthouden.', icon: 'Brain', main: 'memory/', work: true },
  { id: 'channels', title: 'Kanalen', hint: 'Telegram, WhatsApp, Discord, Slack en e-mail.', icon: 'RadioTower', main: 'channels/', work: true },
  { id: 'apps', title: 'Apps', hint: 'Gmail, agenda, Notion en andere apps.', icon: 'Blocks', main: 'mcp/', work: true },
  { id: 'files', title: 'Bestanden', hint: 'Mappen en bestanden van bots.', icon: 'FolderOpen', main: 'folders/', work: true },
  // ---- everything optional, each as one row: switch it on or set it up when you want it
  {
    id: 'meer',
    title: 'Meer mogelijkheden',
    hint: 'Alle overige functies en instellingen.',
    icon: 'LayoutGrid',
    more: [
      { title: 'Beginnen en overstappen', items: ['kant-en-klaar', 'openbot-import-overstappen'] },
      { title: 'AI en modellen', items: ['cli-agents-cli', 'free-models-gratis', 'ai-meer', 'engine-chain-doorschakelen', 'bot-defaults', 'websearch-zoeken', 'images-afbeeldingen', 'voice-spraak'] },
      { title: 'Bots, teams en werk', items: ['vanzelf', 'teams-teams', 'teams/alle', 'rooms/organisatie', 'specialists/', 'routines-routines', 'notifications-meldingen', 'notifications/', 'usage/', 'usage', 'skills-uitgevers', 'users'] },
      { title: 'Apparaten en bestanden', items: ['mobile-telefoon', 'mobile/concepten', 'remote-desktop/', 'browser/', 'browser/kluis', 'sites/', 'folders-teammap', 'folders/prullenbak', 'voice/vergadering', 'voice/'] },
      { title: 'Deze computer', items: ['backups', 'security', 'data', 'systeem', 'network-proxy', 'health-status'] },
    ],
  },
];

export interface SettingsPageDef {
  /** The title in the list and above the page. */
  title: string;
  /** The one line under it in a list of entries. */
  hint?: string;
  /** The parts of TeamBot's API this page works with (path prefixes), for a bot that looks for it. */
  api: string[];
}

/** Every entry of the list (the key is the tab id or page key of SETTINGS_ROWS). */
export const SETTINGS_PAGES: Record<string, SettingsPageDef> = {
  // the pages of the rows themselves
  providers: { title: 'AI-diensten', api: ['/providers'] },
  telefoon: { title: 'Telefoon', api: ['/mobile'] },
  general: { title: 'Taal en uiterlijk', api: ['/settings', '/me'] },
  regels: { title: 'Regels', api: ['/bot-rules'] },
  veilig: { title: 'Back-ups', api: ['/backups'] },
  slot: { title: 'Vergrendeling', api: ['/me'] },
  'agents/': { title: 'Alle bots', hint: 'Alle bots en het archief.', api: ['/agents'] },
  teams: { title: 'Teams', hint: 'De naam van je team, of een nieuw team.', api: ['/teams'] },
  'memory/': { title: 'Geheugen', hint: 'Wat bots onthouden.', api: ['/memory'] },
  'channels/': { title: 'Kanalen', hint: 'Telegram, WhatsApp, Discord, Slack en e-mail.', api: ['/channels'] },
  'mcp/': { title: 'Apps', hint: 'Gmail, agenda, Notion en andere apps.', api: ['/mcp'] },
  'folders/': { title: 'Bestanden', hint: 'Mappen en bestanden van bots.', api: ['/folders'] },
  // Meer mogelijkheden
  'kant-en-klaar': { title: 'Kant-en-klare teams', hint: 'Een ingericht team met bots.', api: ['/team-templates'] },
  'openbot-import-overstappen': { title: 'Overstappen van OpenBot', hint: 'Bots en gesprekken meenemen.', api: ['/openbot-import'] },
  'cli-agents-cli': { title: 'AI-programma’s', hint: 'Claude Code, Codex en OpenCode.', api: ['/cli-agents'] },
  'free-models-gratis': { title: 'Gratis modellen', hint: 'Zonder abonnement of sleutel.', api: ['/free-models'] },
  'ai-meer': { title: 'Lokale modellen en andere diensten', hint: 'Ollama en zestig andere diensten.', api: ['/local-models', '/providers', '/provider-kinds'] },
  'engine-chain-doorschakelen': { title: 'Gratis doorschakelen', hint: 'Reservemodel als je limiet bereikt is.', api: ['/engine-chain'] },
  'bot-defaults': { title: 'Standaarden voor nieuwe bots', hint: 'Taal, model, tijdzone en dagbudget.', api: ['/settings'] },
  'websearch-zoeken': { title: 'Zoeken op internet', hint: 'De zoekdienst voor bots.', api: ['/web-search', '/settings'] },
  'images-afbeeldingen': { title: 'Afbeeldingen maken', hint: 'De dienst voor afbeeldingen.', api: ['/images'] },
  'voice-spraak': { title: 'Spraak', hint: 'Stem, dicteren en voorlezen.', api: ['/voice/settings', '/voice/local', '/voice/tts'] },
  vanzelf: { title: 'Wat start vanzelf', hint: 'Alles wat automatisch start, en wanneer.', api: ['/routines/planned', '/proactive'] },
  'teams-teams': { title: 'Teaminstellingen', hint: 'Profiel, teamleider, budget en sleutels.', api: ['/teams'] },
  'teams/alle': { title: 'Alle teams', api: ['/teams/overview'] },
  'rooms/organisatie': { title: 'Afdelingen', hint: 'Wie aan wie werk geeft.', api: ['/rooms/teams'] },
  'specialists/': { title: 'Kennisbanken', hint: 'Extra vakkennis per bot.', api: ['/specialists'] },
  'routines-routines': { title: 'Standaarden voor routines', hint: 'Maximum voor alle routines samen.', api: ['/routines/settings'] },
  'notifications-meldingen': { title: 'Meldingen per bot', hint: 'Hoeveel elke bot mag melden.', api: ['/notifications/prefs'] },
  'notifications/': { title: 'Alle meldingen', api: ['/notifications'] },
  'usage/': { title: 'Gebruik en limieten', hint: 'Verbruik van je abonnementen.', api: ['/usage/limits', '/usage/alerts', '/usage/status'] },
  usage: { title: 'Kosten', hint: 'Schatting per dag, bot en model.', api: ['/usage'] },
  'skills-uitgevers': { title: 'Vertrouwde makers', hint: 'Van wie je skills en bots vertrouwt.', api: ['/skills/publishers'] },
  users: { title: 'Gebruikers', hint: 'Uitnodigen, rollen en inloggen via je bedrijf.', api: ['/admin/users', '/admin/invites', '/admin/member-policy'] },
  'mobile-telefoon': { title: 'Telefoonverbinding', hint: 'Eigen adres en pushmeldingen.', api: ['/mobile'] },
  'mobile/concepten': { title: 'Concepten', hint: 'Offline geschreven berichten.', api: ['/mobile'] },
  'remote-desktop/': { title: 'Bureaublad op afstand', hint: 'Je pc bedienen vanaf je telefoon.', api: ['/remote-desktop'] },
  'browser/': { title: 'Computers en servers', hint: 'Waar bots op werken.', api: ['/computers'] },
  'browser/kluis': { title: 'Kluis', hint: 'Wachtwoorden en sleutels voor bots.', api: ['/computers/vault'] },
  'sites/': { title: 'Websites', hint: 'Pagina’s die bots online zetten.', api: ['/sites'] },
  'folders-teammap': { title: 'Teammap', hint: 'Eén gedeelde map voor alle bots.', api: ['/folders/team'] },
  'folders/prullenbak': { title: 'Prullenbak', hint: 'Verwijderde bestanden terugzetten.', api: ['/folders/trash'] },
  'voice/vergadering': { title: 'Vergadernotities', hint: 'Een gesprek opnemen en samenvatten.', api: ['/voice/calls'] },
  'voice/': { title: 'Spraakgesprekken', hint: 'Eerdere spraakgesprekken.', api: ['/voice/calls'] },
  backups: { title: 'Back-ups en updates', hint: 'Automatisch, externe kopie, export en updates.', api: ['/backups', '/app-update'] },
  security: { title: 'Beveiliging', hint: 'Ingelogde apparaten, sleutels en logboek.', api: ['/sessions', '/secrets', '/audit'] },
  data: { title: 'Privacy en gegevens', hint: 'Wat lokaal blijft en wat naar een AI-dienst gaat.', api: ['/privacy'] },
  systeem: { title: 'Deze computer', hint: 'Pc wakker houden en extra details tonen.', api: ['/power', '/settings'] },
  'network-proxy': { title: 'Netwerk en proxy', hint: 'Voor een bedrijfsnetwerk.', api: ['/admin/network'] },
  'health-status': { title: 'Status van TeamBot', hint: 'Snelheid en storingen.', api: ['/health'] },
};

// ---------------------------------------------------------------- the settings themselves

export interface SettingChoice {
  /** The value as it is stored and sent. */
  value: string | number | boolean;
  /** The word on the screen. */
  label: string;
  /** What it does, when the word alone does not say it. */
  means?: string;
}

export interface SettingDef {
  /** The words of the row on the screen. */
  title: string;
  /** The one line under it (a row may show another line in some states; this is the one it usually shows). */
  hint?: string;
  /** Where it is: the entry of SETTINGS_PAGES, or `bot` (the page of one bot, Meer mogelijkheden). */
  on: string;
  /** The call that changes it ("PUT /settings"), or null when only that device itself can (said in `note`). */
  call: string | null;
  /** The field in the body, dotted: "ui.botStyle" is { "ui": { "botStyle": … } }. */
  field?: string;
  /** The values it takes and what each means. */
  choices?: SettingChoice[];
  /** What it takes when it is not one of a few choices. */
  takes?: string;
  /** What else a bot must know (per device, read first, …). */
  note?: string;
}

const ON_OFF: SettingChoice[] = [
  { value: true, label: 'Aan' },
  { value: false, label: 'Uit' },
];
const LANGUAGE_CHOICES: SettingChoice[] = LANGUAGES.map((l) => ({ value: l.code, label: l.name }));
/** How much a bot (or TeamBot itself) may notify: the words of the screen (notifications/api.ts LEVEL_LABEL). */
export const NOTIFY_LEVELS: SettingChoice[] = [
  { value: 'all', label: 'Alles' },
  { value: 'important', label: 'Alleen belangrijk', means: 'alleen vragen, goedkeuringen en wat misging' },
  { value: 'none', label: 'Niets' },
];
const BOT_NOTE = 'Stuur het hele settings-object van de bot terug met je wijziging erin: haal het eerst op met GET /agents/:id.';

const settings = <T extends Record<string, SettingDef>>(x: T) => x;

/** Every setting row and switch of the screens, by id. */
export const SETTINGS = settings({
  // ---- Taal en uiterlijk
  'me.name': { title: 'Je naam', on: 'general', call: 'PATCH /me', field: 'name', takes: 'een naam; de bots noemen je zo' },
  language: { title: 'Taal van de app', on: 'general', call: 'PUT /settings', field: 'language', choices: LANGUAGE_CHOICES },
  'ui.theme': {
    title: 'Thema',
    hint: 'Geldt voor dit apparaat.',
    on: 'general',
    call: 'PUT /settings',
    field: 'ui.theme',
    choices: [
      { value: 'system', label: 'Systeem', means: 'volgt licht of donker van het apparaat' },
      { value: 'light', label: 'Licht' },
      { value: 'dark', label: 'Donker' },
    ],
    note: 'Gezet via PUT /settings geldt het meteen op al je apparaten; daarna kan elk apparaat zelf weer kiezen.',
  },
  'ui.accent': {
    title: 'Kleur',
    hint: 'Geldt op al je apparaten.',
    on: 'general',
    call: 'PUT /settings',
    field: 'ui.accent',
    choices: ACCENTS.map((a) => ({ value: a.id, label: a.label })),
    note: 'De kleur van knoppen, links, wat je kiest, de focusrand en het TeamBot-figuurtje.',
  },
  'ui.botStyle': {
    title: 'Stijl figuurtjes',
    hint: 'Elke bot houdt zijn eigen vorm en kleur.',
    on: 'general',
    call: 'PUT /settings',
    field: 'ui.botStyle',
    choices: [
      { value: 'clay', label: 'Glad', means: 'gladde figuurtjes, als van klei (standaard)' },
      { value: 'felt', label: 'Vilt', means: 'figuurtjes van vilt' },
    ],
  },
  // ---- Standaarden voor nieuwe bots
  botLanguage: {
    title: 'Bots antwoorden in',
    hint: 'Per bot kun je dit apart instellen.',
    on: 'bot-defaults',
    call: 'PUT /settings',
    field: 'botLanguage',
    choices: [{ value: 'auto', label: 'De taal waarin je schrijft' }, ...LANGUAGE_CHOICES],
  },
  defaultProvider: { title: 'Standaard-AI', on: 'bot-defaults', call: 'PUT /settings', field: 'defaultProvider', takes: 'het id van een AI-verbinding (GET /providers), of null voor geen' },
  defaultModel: { title: 'Standaardmodel', on: 'bot-defaults', call: 'PUT /settings', field: 'defaultModel', takes: 'een model van de standaard-AI (GET /providers/:id/models); leeg = automatisch' },
  timezone: { title: 'Tijdzone', hint: 'Voor routines en tijden in de chat.', on: 'bot-defaults', call: 'PUT /settings', field: 'timezone', takes: 'een tijdzone zoals Europe/Amsterdam' },
  dailyBudgetUsd: { title: 'Dagbudget', hint: 'Betaalde bots stoppen bij dit bedrag per dag.', on: 'bot-defaults', call: 'PUT /settings', field: 'dailyBudgetUsd', takes: 'een bedrag in dollars per dag; 0 = geen limiet' },
  // ---- Deze computer
  'power.enabled': {
    title: 'Houd de pc wakker terwijl routines of taken lopen',
    hint: 'Het scherm mag wel uit.',
    on: 'systeem',
    call: 'PUT /power',
    field: 'enabled',
    choices: ON_OFF,
    note: 'Alleen in de desktop-app van TeamBot.',
  },
  'ui.advanced': { title: 'Geavanceerd tonen', hint: 'Toont ook de onderdelen voor gevorderden.', on: 'systeem', call: 'PUT /settings', field: 'ui.advanced', choices: ON_OFF },
  // ---- Back-ups en updates
  'backups.auto': { title: 'Elke dag automatisch een back-up maken', on: 'backups', call: 'PUT /backups/settings', field: 'auto', choices: ON_OFF },
  'backups.keep': {
    title: 'Bewaar de laatste',
    on: 'backups',
    call: 'PUT /backups/settings',
    field: 'keep',
    choices: [3, 5, 7, 14, 30].map((n) => ({ value: n, label: `${n} back-ups` })),
  },
  'backups.includeWork': { title: 'Ook werkmappen en groepsbestanden in de automatische back-up', on: 'backups', call: 'PUT /backups/settings', field: 'includeWork', choices: ON_OFF },
  // ---- Meldingen
  'notifications.sound': { title: 'Geluid bij een melding', on: 'notifications-meldingen', call: 'PUT /notifications/prefs', field: 'sound', choices: ON_OFF },
  'notifications.other': {
    title: 'Meldingen zonder bot',
    hint: 'Limieten, apps, kanalen en systeemmeldingen',
    on: 'notifications-meldingen',
    call: 'PUT /notifications/prefs',
    field: 'other',
    choices: NOTIFY_LEVELS,
  },
  // ---- Gebruik en limieten
  'usage.alerts': { title: 'Melden als een limiet bijna op is, op is, en weer beschikbaar is', on: 'usage/', call: 'PUT /usage/alerts', field: 'enabled', choices: ON_OFF },
  'usage.warnAt': {
    title: 'Waarschuwen vanaf',
    on: 'usage/',
    call: 'PUT /usage/alerts',
    field: 'warnAt',
    choices: [70, 80, 90, 95].map((n) => ({ value: n, label: `${n}%` })),
  },
  'usage.statusWindow': {
    title: 'Zwevend statusvenster',
    on: 'usage/',
    call: null,
    choices: [
      { value: 'off', label: 'Uit' },
      { value: 'auto', label: 'Als er iets loopt' },
      { value: 'always', label: 'Altijd' },
    ],
    note: 'Alleen in de desktop-app, op die computer zelf: een bot kan dit niet zetten.',
  },
  // ---- Telefoonverbinding (koppelen en het adres doet de eigenaar zelf)
  'mobile.address': { title: 'Adres voor je telefoon', on: 'mobile-telefoon', call: 'POST /mobile/pair', field: 'baseUrl', takes: 'een adres waarop je telefoon deze computer bereikt' },
  'mobile.bind': {
    title: 'Bereikbaar via',
    on: 'mobile-telefoon',
    call: 'PUT /mobile/gateway',
    field: 'bind',
    choices: [
      { value: 'all', label: 'Alle netwerken' },
      { value: 'tailscale', label: 'Alleen Tailscale' },
      { value: 'loopback', label: 'Alleen deze computer' },
    ],
  },
  'mobile.port': { title: 'Poort', hint: 'Leeg = standaard', on: 'mobile-telefoon', call: 'PUT /mobile/gateway', field: 'port', takes: 'een poortnummer; leeg = standaard' },
  'push.alwaysPhone': { title: 'Altijd ook op de telefoon', on: 'mobile-telefoon', call: 'PUT /mobile/push/prefs', field: 'alwaysPhone', choices: ON_OFF },
  'push.approvals': { title: 'Vragen en goedkeuringen (altijd)', on: 'mobile-telefoon', call: 'PUT /mobile/push/prefs', field: 'approvals', choices: ON_OFF },
  'push.agent': { title: 'Meldingen van bots (als TeamBot niet open staat)', on: 'mobile-telefoon', call: 'PUT /mobile/push/prefs', field: 'agent', choices: ON_OFF },
  'push.runDone': { title: 'Taak klaar of mislukt (als TeamBot niet open staat)', on: 'mobile-telefoon', call: 'PUT /mobile/push/prefs', field: 'runDone', choices: ON_OFF },
  'push.preview': { title: 'Inhoud tonen op het vergrendelscherm', on: 'mobile-telefoon', call: 'PUT /mobile/push/prefs', field: 'preview', choices: ON_OFF },
  // ---- Gebruikers (een server met leden; de eigenaar of een beheerder)
  'members.dailyBudgetUsd': { title: 'Dagbudget per lid (USD)', hint: '0 = geen limiet.', on: 'users', call: 'PUT /admin/member-policy', field: 'dailyBudgetUsd', takes: 'een bedrag in dollars per dag; 0 = geen limiet' },
  'members.maxAgents': { title: 'Aantal bots per lid', hint: '0 = geen limiet.', on: 'users', call: 'PUT /admin/member-policy', field: 'maxAgents', takes: 'een aantal; 0 = geen limiet' },
  'members.allowShell': { title: 'Terminal toestaan voor leden', hint: 'Alleen voor mensen die je volledig vertrouwt.', on: 'users', call: 'PUT /admin/member-policy', field: 'allowShell', choices: ON_OFF },
  'members.allowCloudVm': { title: 'Cloud-VM’s toestaan voor leden', hint: 'Met hun eigen token en op hun eigen kosten.', on: 'users', call: 'PUT /admin/member-policy', field: 'allowCloudVm', choices: ON_OFF },
  // ---- de pagina van een bot (Meer mogelijkheden)
  'agent.description': { title: 'Korte beschrijving', on: 'bot', call: 'PATCH /agents/:id', field: 'description', takes: 'een korte tekst over de bot' },
  'agent.language': {
    title: 'Taal van de antwoorden',
    on: 'bot',
    call: 'PATCH /agents/:id',
    field: 'settings.language',
    choices: LANGUAGE_CHOICES,
    note: `Leeg = de taal van Standaarden voor nieuwe bots. ${BOT_NOTE}`,
  },
  'agent.answerStyle': {
    title: 'Antwoordstijl',
    hint: 'Natuurlijk: gewone zinnen. Zakelijk: de kern bovenaan, met kopjes.',
    on: 'bot',
    call: 'PATCH /agents/:id',
    field: 'settings.answerStyle',
    choices: [
      { value: 'natural', label: 'Natuurlijk', means: 'gewone zinnen (standaard)' },
      { value: 'business', label: 'Zakelijk', means: 'de kern bovenaan, met kopjes' },
    ],
    note: BOT_NOTE,
  },
  'agent.fullAccessExternal': {
    title: 'Ook versturen naar anderen zonder te vragen',
    hint: 'Berichten, formulieren en acties in gekoppelde apps. Betalen vraagt altijd.',
    on: 'bot',
    call: 'PATCH /agents/:id',
    field: 'settings.fullAccessExternal',
    choices: ON_OFF,
    note: `Alleen bij volledige toegang. ${BOT_NOTE}`,
  },
  'agent.autoReview': {
    title: 'Automatische controle (aanbevolen bij automatisch)',
    hint: 'Een tweede controle kijkt of elke wijziging past bij wat jij vroeg.',
    on: 'bot',
    call: 'PATCH /agents/:id',
    field: 'settings.autoReview',
    choices: ON_OFF,
    note: `Alleen bij automatisch. ${BOT_NOTE}`,
  },
  'agent.ownTools': {
    title: 'Zelf kiezen',
    hint: 'Jij bepaalt welke onderdelen en skills de bot heeft.',
    on: 'bot',
    call: 'PATCH /agents/:id',
    field: 'tool_groups',
    takes: 'de lijst met onderdelen (de groepen uit GET /tools) die de bot heeft. Uit (automatisch) = alle onderdelen aan en geen toestemming per tool: de bot krijgt wat hij voor zijn werk nodig heeft',
  },
  'agent.useUserMcp': {
    title: 'Je eigen apps van het programma gebruiken',
    hint: 'De MCP-servers en plugins die je zelf in het programma hebt ingesteld.',
    on: 'bot',
    call: 'PATCH /agents/:id',
    field: 'settings.cli.useUserMcp',
    choices: ON_OFF,
    note: `Alleen voor een bot op een AI-programma (Claude Code, Codex). ${BOT_NOTE}`,
  },
  'agent.loadUserSettings': {
    title: 'Je eigen instellingen van het programma laden (minder streng)',
    hint: 'Toestaan-regels uit je instellingen kunnen dan stappen goedkeuren zonder TeamBot.',
    on: 'bot',
    call: 'PATCH /agents/:id',
    field: 'settings.cli.loadUserSettings',
    choices: ON_OFF,
    note: `Alleen voor een bot op een AI-programma (Claude Code, Codex). ${BOT_NOTE}`,
  },
});

export type SettingId = keyof typeof SETTINGS;

/** The words of one setting on the screen. */
export const settingText = (id: SettingId): SettingDef => SETTINGS[id];

/** The choices of a setting as options of a control: value as a string, the label of the screen. */
export function settingOptions<T extends string = string>(id: SettingId): { value: T; label: string }[] {
  return (SETTINGS[id] as SettingDef).choices?.map((c) => ({ value: String(c.value) as T, label: c.label })) || [];
}

/** The title of an entry of the list (a tab or page key), or '' when it has none here. */
export const settingsPageTitle = (key: string): string => SETTINGS_PAGES[key]?.title || '';
