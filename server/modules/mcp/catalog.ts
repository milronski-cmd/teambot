import type { ToolRisk } from '../../core/types.js';
import { MARKETING_CATALOG } from './catalog-marketing.js';

import { CATALOG_SERVICE } from './catalog-service.js';

import { CATALOG_WORK } from './catalog-work.js';

/**
 * Connector catalogue: templates for commonly used MCP servers. Every entry
 * records its source, licence and verification state. URLs and commands were
 * checked against the vendor's own documentation / repository on the date in
 * `verifiedAt`; "niet geverifieerd" means we could not confirm it and the UI
 * says so. Nothing here is copied from other products: these are public
 * protocol endpoints and package names.
 */

export interface CatalogField {
  /** Env var name (stdio) or header name (http). */
  name: string;
  label: string;
  help?: string;
  secret?: boolean;
  required?: boolean;
  /** Prepended to a secret header value, e.g. "Bearer ". */
  prefix?: string;
  placeholder?: string;
  /** Default value; `{connDir}` = the connection's own data folder. */
  default?: string;
}

export interface CatalogScope {
  name: string;
  description: string;
  /** Pre-selected (minimal set). */
  default?: boolean;
}

/** One step of the guided setup of an own OAuth client (shown instead of a bare client-ID form). */
export interface OAuthGuideStep {
  title: string;
  /** Short instructions with the exact names of console pages, fields and values. */
  lines: string[];
  /** Console pages for this step. */
  links?: { url: string; label: string }[];
  /** Values to paste into the console; `{redirectUri}` becomes TeamBot's own callback URL. */
  copy?: { label: string; value: string }[];
}

export interface OAuthAppGuide {
  /** Connectors in the same group can share one OAuth client (Gmail, Agenda, Drive and Sheets: one Google client). */
  group: string;
  vendor: string;
  intro: string;
  /** The service always needs the client secret, also with PKCE (Google). */
  secretRequired: boolean;
  clientIdPattern?: string;
  clientIdPlaceholder?: string;
  steps: OAuthGuideStep[];
}

export interface CatalogEntry {
  id: string;
  name: string;
  category: 'ontwikkeling' | 'productiviteit' | 'communicatie' | 'kennis' | 'systeem' | 'browser' | 'eigen';
  description: string;
  publisher: string;
  official: boolean;
  transport: 'stdio' | 'http' | 'sse';
  url?: string;
  command?: string;
  args?: string[];
  /**
   * The user must add one or more arguments (e.g. folders). `defaultWorkFolders`: left empty, the work folders of the
   * bots the connection is for are used (least privilege: the filesystem server only sees the team/work folder).
   */
  argsPrompt?: { label: string; help: string; kind: 'paths' | 'text'; defaultWorkFolders?: boolean };
  env?: CatalogField[];
  headers?: CatalogField[];
  auth: 'none' | 'headers' | 'oauth';
  /** OAuth client: dynamic registration works, or the user must register an app at the service. */
  oauthClient?: 'dynamic' | 'own-app';
  oauthAppHelp?: string;
  /** Step-by-step setup of the own OAuth client, with the exact console settings. */
  oauthAppGuide?: OAuthAppGuide;
  /** Extra query parameters for the authorization request (e.g. Google offline access). */
  oauthExtraParams?: Record<string, string>;
  scopes?: CatalogScope[];
  /** Plain-language data flow: what leaves the machine and where it goes. */
  dataFlow: string;
  requirements?: string;
  license: string;
  source: string;
  docs?: string;
  verification: 'geverifieerd' | 'niet geverifieerd';
  verifiedAt: string;
  /** Honest test state of this template against the real service. */
  testStatus: string;
  /** Where the user can revoke access at the service itself. */
  revokeHelp?: string;
  /** Only stricter risks than the annotations; never looser. */
  riskOverrides?: Record<string, ToolRisk>;
  /** Availability limits (preview, invite-only, plan). */
  availability?: string;
  alternatives?: string;
}

const VERIFIED = '2026-11-06';
/** Package H (0.4): versions pinned, read-only GitHub, key-less search and reading; checked on npm, PyPI and GitHub. */
const PINNED = '2026-11-09';
const NOT_LIVE = 'Niet live getest tegen de echte dienst; het transport (stdio/HTTP/OAuth) is gedekt door automatische tests met een lokale testserver.';
// Live checks below were run by hand on the date given; they are not part of the automated tests.

/**
 * Google Workspace (checked 2026-11-07): Google's own MCP servers have no dynamic client registration and no client
 * ID metadata documents (accounts.google.com advertises neither; Google's docs say so), so an own Google Cloud OAuth
 * client is unavoidable. One client works for Gmail, Agenda, Drive and Sheets. Zero-setup alternatives are third-party
 * gateways that hold the Google tokens themselves (see `alternatives`).
 */
const GOOGLE_VERIFIED = '2026-11-07';
const GOOGLE_API: Record<'gmail' | 'calendar' | 'drive' | 'sheets', { ids: string[]; names: string }> = {
  gmail: { ids: ['gmail.googleapis.com', 'gmailmcp.googleapis.com'], names: '“Gmail API” en “Gmail MCP API”' },
  calendar: { ids: ['calendar-json.googleapis.com', 'calendarmcp.googleapis.com'], names: '“Google Calendar API” en “Google Calendar MCP API”' },
  drive: { ids: ['drive.googleapis.com', 'drivemcp.googleapis.com'], names: '“Google Drive API” en “Google Drive MCP API”' },
  sheets: { ids: ['sheets.googleapis.com', 'sheetsmcp.googleapis.com'], names: '“Google Sheets API” en “Google Sheets MCP API”' },
};
const GOOGLE_TEST = 'Live gecontroleerd op 2026-11-07 via TeamBot (tests/e2e/google-mcp-live.mjs): OAuth-gegevens gevonden (accounts.google.com, PKCE S256), geen automatische registratie en geen client-metadata: eigen OAuth-client mét clientgeheim nodig. De server beantwoordt initialize en tools/list ook zonder inloggen; pas een toolaanroep vraagt om inloggen. Echt inloggen niet getest (vereist preview-toegang).';
const SHEETS_VERIFIED = '2026-11-08';
const SHEETS_TEST = 'Live gecontroleerd op 2026-11-08 via TeamBot (tests/e2e/google-mcp-live.mjs): OAuth-gegevens gevonden (accounts.google.com, PKCE S256), geen automatische registratie: eigen OAuth-client mét clientgeheim nodig. Echt inloggen en de tools zelf niet getest (vereist preview-toegang).';
const GOOGLE_AVAILABILITY = 'Developer Preview (sinds april 2026, nog niet algemeen beschikbaar): alleen na aanmelding bij het Google Workspace Developer Preview Program, met een Google Workspace-account. Of persoonlijke @gmail.com-accounts werken, bevestigt Google niet.';
const GOOGLE_ALTERNATIVES = 'Zonder eigen Google Cloud-client: een tussendienst die zelf bij Google is geregistreerd, bijv. Composio (https://connect.composio.dev/mcp) of Zapier (https://mcp.zapier.com/api/v1/connect), als “Eigen server” met OAuth (automatische registratie). Let op: die dienst bewaart dan je Google-toegang en ziet je e-mail, agenda of bestanden; kies dat alleen als je die partij vertrouwt.';

function googleGuide(product: keyof typeof GOOGLE_API, scopes: string[]): OAuthAppGuide {
  const api = GOOGLE_API[product];
  return {
    group: 'google',
    vendor: 'Google Cloud',
    intro: 'Google laat apps zoals TeamBot niet automatisch registreren. Je maakt daarom één keer een eigen OAuth-client in Google Cloud (ongeveer 10 minuten). Diezelfde client werkt ook voor de andere Google-koppelingen (Gmail, Agenda, Drive, Sheets): daar zet je alleen hun API’s aan en voeg je hun rechten toe. De knoppen openen de juiste pagina in de Google Cloud-console; de namen tussen aanhalingstekens zijn de Engelse namen in de console.',
    secretRequired: true,
    clientIdPattern: '^[0-9]+-[a-z0-9]+\\.apps\\.googleusercontent\\.com$',
    clientIdPlaceholder: '123456789012-abc123….apps.googleusercontent.com',
    steps: [
      {
        title: 'Toegang tot de preview',
        lines: [
          'De MCP-servers van Google Workspace zijn nog een Developer Preview: alleen aangemelde deelnemers kunnen ze gebruiken.',
          'Meld je één keer aan met je Google Workspace-account en het Google Cloud-project uit de volgende stap. Google keurt dat meestal binnen een paar dagen goed.',
          'Heb je al toegang, ga dan door.',
        ],
        links: [{ url: 'https://developers.google.com/workspace/preview', label: 'Aanmelden voor de preview' }],
      },
      {
        title: 'Project en API’s',
        lines: [
          'Maak een project (bijv. “TeamBot”) of kies een bestaand project bovenaan in de console.',
          `Zet in dat project de ${api.names} aan: de tweede knop opent de juiste pagina, klik daar op “Enable”.`,
        ],
        links: [
          { url: 'https://console.cloud.google.com/projectcreate', label: 'Project maken' },
          { url: `https://console.cloud.google.com/flows/enableapi?apiid=${api.ids.join(',')}`, label: 'API’s aanzetten' },
        ],
      },
      {
        title: 'Toestemmingsscherm',
        lines: [
          'Google Auth Platform › “Branding” › “Get started”: app-naam “TeamBot”, je eigen e-mailadres als “User support email” en als contactadres.',
          '“Audience”: kies “Internal” als je een Google Workspace-account van je eigen organisatie gebruikt: dan zijn geen testgebruikers nodig en blijft het inloggen geldig.',
          'Alleen met een persoonlijk account: kies “External”, laat de status op “Testing” en voeg onder “Test users” je eigen Google-adres toe. Google beëindigt het inloggen dan na 7 dagen; daarna log je in TeamBot opnieuw in.',
          '“Data access” › “Add or remove scopes”: plak de rechten hieronder bij “Manually add scopes” en sla op.',
        ],
        links: [
          { url: 'https://console.cloud.google.com/auth/branding', label: 'Branding' },
          { url: 'https://console.cloud.google.com/auth/audience', label: 'Audience' },
          { url: 'https://console.cloud.google.com/auth/scopes', label: 'Data access' },
        ],
        copy: [{ label: 'Rechten (scopes)', value: scopes.join(',') }],
      },
      {
        title: 'OAuth-client',
        lines: [
          'Google Auth Platform › “Clients” › “Create client”.',
          '“Application type”: “Web application”; “Name”: bijv. “TeamBot”.',
          '“Authorized redirect URIs” › “Add URI”: plak de redirect-URL hieronder, precies zo (met poort). Verandert het adres van TeamBot, pas hem dan hier aan.',
          'Vink “Use this client for an AI-powered agent” aan: vanaf 11 november 2026 weigeren deze servers clients zonder dat vinkje.',
          'Klik op “Create” en kopieer de “Client ID” en het “Client secret” (het geheim zie je maar één keer; je kunt ook het JSON-bestand downloaden).',
        ],
        links: [{ url: 'https://console.cloud.google.com/auth/clients/create', label: 'Client maken' }],
        copy: [{ label: 'Redirect-URL', value: '{redirectUri}' }],
      },
    ],
  };
}

/**
 * Not shown to a newcomer (still found by searching): Google's own preview servers and the community servers need an
 * own OAuth client, Python or gcloud. The built-in Google connection (google.ts) does the same with one login.
 */
export const BEHIND_GOOGLE = new Set(['google-gmail', 'google-drive', 'google-calendar', 'google-sheets', 'google-workspace-mcp', 'google-analytics', 'google-ads', 'search-console']);

export const CATALOG: CatalogEntry[] = [
  {
    // Read-only by default (research 2026-11-09: least privilege). The /readonly endpoint only offers read tools; the
    // toolset header narrows it further (docs/remote-server.md of github/github-mcp-server, checked 2026-11-09).
    id: 'github-readonly',
    name: 'GitHub (alleen lezen)',
    category: 'ontwikkeling',
    description: 'Repositories, issues en pull requests lezen via de officiële GitHub MCP-server, op het eindpunt dat alleen leestools aanbiedt.',
    publisher: 'GitHub',
    official: true,
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/readonly',
    auth: 'headers',
    headers: [
      {
        name: 'Authorization',
        label: 'Personal access token',
        help: 'Een fine-grained token met alleen leesrechten op de repositories die de bot mag zien (github.com › Settings › Developer settings). Wordt versleuteld in de kluis bewaard.',
        secret: true,
        required: true,
        prefix: 'Bearer ',
        placeholder: 'github_pat_…',
      },
      { name: 'X-MCP-Toolsets', label: 'Onderdelen', help: 'Welke onderdelen de bot ziet, met komma’s. Leeg = de standaardset van GitHub.', default: 'repos,issues,pull_requests' },
    ],
    dataFlow: 'Verzoeken van de bot en de token gaan naar api.githubcopilot.com (GitHub). Resultaten (code, issues) komen terug in het gesprek en naar je AI-provider. Schrijven kan via dit eindpunt niet.',
    license: 'MIT (github/github-mcp-server); gehoste dienst van GitHub',
    source: 'https://github.com/github/github-mcp-server',
    docs: 'https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md',
    verification: 'geverifieerd',
    verifiedAt: PINNED,
    testStatus: 'Eindpunt en kopteksten gecontroleerd in de documentatie van GitHub op 2026-11-09. Met een echte token niet getest.',
    revokeHelp: 'Trek tokens in via github.com › Settings › Developer settings › Personal access tokens.',
    alternatives: 'Ook schrijven nodig: kies “GitHub” (volledig) en zet acties pas aan als dat moet.',
  },
  {
    id: 'github',
    name: 'GitHub',
    category: 'ontwikkeling',
    description: 'Repositories, issues, pull requests, code zoeken en Actions via de officiële remote GitHub MCP-server.',
    publisher: 'GitHub',
    official: true,
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    auth: 'headers',
    headers: [
      {
        name: 'Authorization',
        label: 'Personal access token',
        help: 'Maak een fine-grained token met alleen de repositories en rechten die de bot nodig heeft (github.com › Settings › Developer settings).',
        secret: true,
        required: true,
        prefix: 'Bearer ',
        placeholder: 'github_pat_…',
      },
      { name: 'X-MCP-Readonly', label: 'Alleen lezen (optioneel: "true")', help: 'Met "true" biedt de server alleen leestools aan.', placeholder: 'true' },
    ],
    oauthClient: 'own-app',
    oauthAppHelp: 'GitHub ondersteunt geen automatische registratie (DCR). Wil je OAuth in plaats van een token, registreer dan een eigen GitHub OAuth App met de redirect-URL hieronder.',
    scopes: [
      { name: 'repo', description: 'Repositories lezen en schrijven (klassieke token)' },
      { name: 'read:org', description: 'Organisaties en teams lezen', default: true },
      { name: 'read:packages', description: 'Packages lezen' },
    ],
    dataFlow: 'Verzoeken van de bot en de token gaan naar api.githubcopilot.com (GitHub). Resultaten (code, issues) komen terug in het gesprek en naar je AI-provider.',
    license: 'MIT (github/github-mcp-server); gehoste dienst van GitHub',
    source: 'https://github.com/github/github-mcp-server',
    docs: 'https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md',
    verification: 'geverifieerd',
    verifiedAt: VERIFIED,
    testStatus: 'Live gecontroleerd op 2026-11-06: server bereikbaar en weigert verzoeken zonder token (zoals verwacht). Met token niet getest.',
    revokeHelp: 'Trek tokens in via github.com › Settings › Developer settings › Personal access tokens.',
    riskOverrides: { create_pull_request: 'danger', create_issue: 'danger', add_issue_comment: 'danger', create_repository: 'danger', fork_repository: 'danger' },
    alternatives: 'Lokaal: docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server',
  },
  {
    id: 'notion',
    name: 'Notion',
    category: 'productiviteit',
    description: 'Pagina’s en databases in je Notion-workspace zoeken, lezen en bewerken.',
    publisher: 'Notion',
    official: true,
    transport: 'http',
    url: 'https://mcp.notion.com/mcp',
    auth: 'oauth',
    oauthClient: 'dynamic',
    dataFlow: 'Na inloggen bij Notion gaan verzoeken naar mcp.notion.com. Inhoud van pagina’s komt in het gesprek en gaat naar je AI-provider.',
    license: 'Gehoste dienst van Notion (eigendomsrechtelijk)',
    source: 'https://developers.notion.com/docs/get-started-with-mcp',
    docs: 'https://developers.notion.com/docs/get-started-with-mcp',
    verification: 'geverifieerd',
    verifiedAt: VERIFIED,
    testStatus: 'OAuth-discovery live gecontroleerd op 2026-11-06 (automatische registratie beschikbaar). Inloggen zelf niet getest (vereist account).',
    revokeHelp: 'In Notion: Instellingen › Verbindingen.',
    alternatives: 'SSE (alleen als nodig): https://mcp.notion.com/sse',
  },
  {
    id: 'linear',
    name: 'Linear',
    category: 'productiviteit',
    description: 'Issues, projecten en cycles in Linear zoeken, aanmaken en bijwerken.',
    publisher: 'Linear',
    official: true,
    transport: 'http',
    url: 'https://mcp.linear.app/mcp',
    auth: 'oauth',
    oauthClient: 'dynamic',
    scopes: [
      { name: 'read', description: 'Alles lezen', default: true },
      { name: 'write', description: 'Issues en reacties aanmaken/bewerken' },
    ],
    dataFlow: 'Verzoeken gaan naar mcp.linear.app (Linear). Issue-inhoud komt in het gesprek en gaat naar je AI-provider.',
    license: 'Gehoste dienst van Linear (eigendomsrechtelijk)',
    source: 'https://linear.app/docs/mcp',
    docs: 'https://linear.app/docs/mcp',
    verification: 'geverifieerd',
    verifiedAt: VERIFIED,
    testStatus: 'OAuth-discovery live gecontroleerd op 2026-11-06 (automatische registratie; server vraagt scopes read en write). Inloggen niet getest.',
    revokeHelp: 'In Linear: Settings › Account › Security & access › Authorized applications.',
    alternatives: 'Alleen-lezen: https://mcp.linear.app/mcp/readonly · API-sleutel als Authorization: Bearer-header.',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    category: 'ontwikkeling',
    description: 'Fouten, issues en releases in Sentry bekijken en analyseren.',
    publisher: 'Sentry',
    official: true,
    transport: 'http',
    url: 'https://mcp.sentry.dev/mcp',
    auth: 'oauth',
    oauthClient: 'dynamic',
    dataFlow: 'Verzoeken gaan naar mcp.sentry.dev (Sentry). Foutmeldingen en stacktraces komen in het gesprek en gaan naar je AI-provider.',
    license: 'FSL-1.1-Apache-2.0 (getsentry/sentry-mcp; wordt na 2 jaar Apache-2.0)',
    source: 'https://github.com/getsentry/sentry-mcp',
    docs: 'https://mcp.sentry.dev',
    verification: 'geverifieerd',
    verifiedAt: VERIFIED,
    testStatus: 'OAuth-discovery live gecontroleerd op 2026-11-06 (automatische registratie beschikbaar). Inloggen niet getest.',
    revokeHelp: 'In Sentry: User Settings › Authorized Applications.',
    alternatives: 'Lokaal: npx @sentry/mcp-server@latest met SENTRY_AUTH_TOKEN.',
  },
  {
    id: 'atlassian',
    name: 'Atlassian (Jira & Confluence)',
    category: 'productiviteit',
    description: 'Jira-issues en Confluence-pagina’s zoeken, lezen en bijwerken via de Atlassian Rovo MCP-server.',
    publisher: 'Atlassian',
    official: true,
    transport: 'http',
    url: 'https://mcp.atlassian.com/v2/mcp',
    auth: 'oauth',
    oauthClient: 'dynamic',
    dataFlow: 'Verzoeken gaan naar mcp.atlassian.com. Issue- en pagina-inhoud komt in het gesprek en gaat naar je AI-provider.',
    license: 'Gehoste dienst van Atlassian (eigendomsrechtelijk)',
    source: 'https://github.com/atlassian/atlassian-mcp-server',
    docs: 'https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/',
    verification: 'geverifieerd',
    verifiedAt: VERIFIED,
    testStatus: 'OAuth-discovery live gecontroleerd op 2026-11-06 (autorisatie via auth.atlassian.com, automatische registratie). Inloggen niet getest.',
    availability: 'Een Atlassian-beheerder bepaalt welke domeinen via OAuth mogen verbinden; IP-allowlists kunnen verbindingen blokkeren. /v1/sse werkt niet meer.',
    revokeHelp: 'In Atlassian: Account › Security › Connected apps.',
  },
  {
    id: 'slack',
    name: 'Slack',
    category: 'communicatie',
    description: 'Berichten en kanalen in Slack zoeken en (na toestemming) berichten sturen.',
    publisher: 'Slack',
    official: true,
    transport: 'http',
    url: 'https://mcp.slack.com/mcp',
    auth: 'oauth',
    oauthClient: 'own-app',
    oauthAppHelp:
      'Slack vereist een eigen Slack-app (client-ID + secret) die in de Slack-directory staat of als interne app in je workspace is geïnstalleerd. Zet de redirect-URL hieronder in die app.',
    scopes: [
      { name: 'search:read.public', description: 'Openbare kanalen doorzoeken', default: true },
      { name: 'channels:history', description: 'Berichten in openbare kanalen lezen', default: true },
      { name: 'users:read', description: 'Gebruikers opzoeken', default: true },
      { name: 'chat:write', description: 'Berichten sturen namens jou' },
    ],
    dataFlow: 'Verzoeken gaan naar mcp.slack.com. Berichten uit Slack komen in het gesprek en gaan naar je AI-provider; verzenden gebeurt alleen na jouw goedkeuring.',
    license: 'Gehoste dienst van Slack (eigendomsrechtelijk)',
    source: 'https://docs.slack.dev/ai/mcp-server/',
    docs: 'https://docs.slack.dev/ai/mcp-server/',
    verification: 'geverifieerd',
    verifiedAt: VERIFIED,
    testStatus: 'Discovery live gecontroleerd op 2026-11-06: geen automatische registratie, eigen Slack-app nodig. Inloggen niet getest.',
    availability: 'Alleen voor Slack-apps die in de directory staan of intern zijn geïnstalleerd.',
    revokeHelp: 'In Slack: Instellingen › Apps beheren.',
  },
  {
    id: 'google-gmail',
    name: 'Gmail (Google)',
    category: 'communicatie',
    description: 'E-mail zoeken en lezen, concepten maken via de officiële Google MCP-server voor Gmail.',
    publisher: 'Google',
    official: true,
    transport: 'http',
    url: 'https://gmailmcp.googleapis.com/mcp/v1',
    auth: 'oauth',
    oauthClient: 'own-app',
    oauthAppHelp: 'Google ondersteunt geen automatische registratie: maak één keer een eigen OAuth-client in Google Cloud (stappenplan in TeamBot). Eén client werkt voor Gmail, Agenda, Drive en Sheets.',
    oauthAppGuide: googleGuide('gmail', ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose']),
    oauthExtraParams: { access_type: 'offline', prompt: 'consent' },
    scopes: [
      { name: 'https://www.googleapis.com/auth/gmail.readonly', description: 'E-mail lezen', default: true },
      { name: 'https://www.googleapis.com/auth/gmail.compose', description: 'Concepten maken (de server heeft geen tool om te verzenden)' },
    ],
    dataFlow: 'Verzoeken gaan naar gmailmcp.googleapis.com (Google). E-mailinhoud komt in het gesprek en gaat naar je AI-provider.',
    license: 'Gehoste dienst van Google (eigendomsrechtelijk)',
    source: 'https://developers.google.com/workspace/guides/configure-mcp-servers',
    verification: 'geverifieerd',
    verifiedAt: GOOGLE_VERIFIED,
    testStatus: GOOGLE_TEST,
    availability: GOOGLE_AVAILABILITY,
    revokeHelp: 'myaccount.google.com › Beveiliging › Apps van derden met accounttoegang.',
    alternatives: GOOGLE_ALTERNATIVES,
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    category: 'productiviteit',
    description: 'Bestanden in Google Drive zoeken en lezen via de officiële Google MCP-server.',
    publisher: 'Google',
    official: true,
    transport: 'http',
    url: 'https://drivemcp.googleapis.com/mcp/v1',
    auth: 'oauth',
    oauthClient: 'own-app',
    oauthAppHelp: 'Google ondersteunt geen automatische registratie: maak één keer een eigen OAuth-client in Google Cloud (stappenplan in TeamBot). Eén client werkt voor Gmail, Agenda, Drive en Sheets.',
    oauthAppGuide: googleGuide('drive', ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file']),
    oauthExtraParams: { access_type: 'offline', prompt: 'consent' },
    scopes: [
      { name: 'https://www.googleapis.com/auth/drive.readonly', description: 'Alle bestanden lezen', default: true },
      { name: 'https://www.googleapis.com/auth/drive.file', description: 'Alleen bestanden die via deze app zijn geopend/gemaakt' },
    ],
    dataFlow: 'Verzoeken gaan naar drivemcp.googleapis.com (Google). Bestandsinhoud komt in het gesprek en gaat naar je AI-provider.',
    license: 'Gehoste dienst van Google (eigendomsrechtelijk)',
    source: 'https://developers.google.com/workspace/guides/configure-mcp-servers',
    verification: 'geverifieerd',
    verifiedAt: GOOGLE_VERIFIED,
    testStatus: GOOGLE_TEST,
    availability: GOOGLE_AVAILABILITY,
    revokeHelp: 'myaccount.google.com › Beveiliging › Apps van derden met accounttoegang.',
    alternatives: GOOGLE_ALTERNATIVES,
  },
  {
    id: 'google-calendar',
    name: 'Google Agenda',
    category: 'productiviteit',
    description: 'Agenda’s en afspraken bekijken via de officiële Google MCP-server voor Calendar.',
    publisher: 'Google',
    official: true,
    transport: 'http',
    url: 'https://calendarmcp.googleapis.com/mcp/v1',
    auth: 'oauth',
    oauthClient: 'own-app',
    oauthAppHelp: 'Google ondersteunt geen automatische registratie: maak één keer een eigen OAuth-client in Google Cloud (stappenplan in TeamBot). Eén client werkt voor Gmail, Agenda, Drive en Sheets.',
    oauthAppGuide: googleGuide('calendar', ['https://www.googleapis.com/auth/calendar.events.readonly', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events.freebusy']),
    oauthExtraParams: { access_type: 'offline', prompt: 'consent' },
    scopes: [
      { name: 'https://www.googleapis.com/auth/calendar.events.readonly', description: 'Afspraken lezen', default: true },
      { name: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly', description: 'Lijst van agenda’s lezen', default: true },
      { name: 'https://www.googleapis.com/auth/calendar.events.freebusy', description: 'Beschikbaarheid lezen' },
    ],
    dataFlow: 'Verzoeken gaan naar calendarmcp.googleapis.com (Google). Afspraken komen in het gesprek en gaan naar je AI-provider.',
    license: 'Gehoste dienst van Google (eigendomsrechtelijk)',
    source: 'https://developers.google.com/workspace/guides/configure-mcp-servers',
    verification: 'geverifieerd',
    verifiedAt: GOOGLE_VERIFIED,
    testStatus: GOOGLE_TEST,
    availability: GOOGLE_AVAILABILITY,
    revokeHelp: 'myaccount.google.com › Beveiliging › Apps van derden met accounttoegang.',
    alternatives: GOOGLE_ALTERNATIVES,
  },
  {
    // Sheets (checked 2026-11-08 on Google's page): the same Developer Preview and the same own-client rule as Gmail,
    // Drive and Agenda. Its tools per Google: get_values, get_spreadsheet (read); update_values, update_formulas,
    // update_spreadsheet, insert_dimension (write). No search tool: the bot needs the spreadsheet's link or ID.
    id: 'google-sheets',
    name: 'Google Sheets',
    category: 'productiviteit',
    description: 'Spreadsheets lezen en bewerken via de officiële Google MCP-server voor Sheets: waarden en formules lezen en schrijven, rijen of kolommen invoegen.',
    publisher: 'Google',
    official: true,
    transport: 'http',
    url: 'https://sheetsmcp.googleapis.com/mcp/v1',
    auth: 'oauth',
    oauthClient: 'own-app',
    oauthAppHelp: 'Google ondersteunt geen automatische registratie: maak één keer een eigen OAuth-client in Google Cloud (stappenplan in TeamBot). Eén client werkt voor Gmail, Agenda, Drive en Sheets.',
    oauthAppGuide: googleGuide('sheets', ['https://www.googleapis.com/auth/spreadsheets.readonly', 'https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file']),
    oauthExtraParams: { access_type: 'offline', prompt: 'consent' },
    scopes: [
      { name: 'https://www.googleapis.com/auth/spreadsheets.readonly', description: 'Spreadsheets lezen', default: true },
      { name: 'https://www.googleapis.com/auth/spreadsheets', description: 'Spreadsheets lezen en bewerken' },
      { name: 'https://www.googleapis.com/auth/drive.readonly', description: 'Alle bestanden in Google Drive lezen' },
      { name: 'https://www.googleapis.com/auth/drive.file', description: 'Alleen bestanden die via deze app zijn geopend of gemaakt' },
    ],
    dataFlow: 'Verzoeken gaan naar sheetsmcp.googleapis.com (Google). Inhoud van spreadsheets komt in het gesprek en gaat naar je AI-provider. Volgens Google heeft deze server geen zoektool: geef de bot de link van de spreadsheet (of koppel ook Google Drive om te zoeken).',
    license: 'Gehoste dienst van Google (eigendomsrechtelijk)',
    source: 'https://developers.google.com/workspace/guides/configure-mcp-servers',
    verification: 'geverifieerd',
    verifiedAt: SHEETS_VERIFIED,
    testStatus: SHEETS_TEST,
    availability: GOOGLE_AVAILABILITY,
    revokeHelp: 'myaccount.google.com › Beveiliging › Apps van derden met accounttoegang.',
    // Only stricter than the server's own annotations: changing a spreadsheet is never treated as reading.
    riskOverrides: { update_values: 'write', update_formulas: 'write', update_spreadsheet: 'write', insert_dimension: 'write' },
    alternatives: GOOGLE_ALTERNATIVES,
  },
  {
    id: 'filesystem',
    name: 'Bestanden (referentieserver)',
    category: 'systeem',
    description: 'Lezen en schrijven in de werkmap van je bots (of mappen die jij kiest), via de officiële MCP-referentieserver “filesystem”.',
    publisher: 'MCP-project (modelcontextprotocol/servers)',
    official: true,
    transport: 'stdio',
    command: 'npx',
    // Pinned (npm, 2026-11-09): a new version only after a new catalogue (postmark-mcp turned bad in a later version).
    args: ['-y', '@modelcontextprotocol/server-filesystem@2.2.0'],
    argsPrompt: { label: 'Toegestane mappen', help: 'Leeg = alleen de werkmap van de bots die je kiest. Anders één volledig pad per regel; de server kan alleen hierin lezen en schrijven.', kind: 'paths', defaultWorkFolders: true },
    auth: 'none',
    dataFlow: 'Draait lokaal op deze computer. Bestandsinhoud uit de toegestane mappen komt in het gesprek en gaat naar je AI-provider.',
    requirements: 'Node.js met npx (de eerste start downloadt het pakket van npm).',
    license: 'MIT, nieuwe code Apache-2.0 (modelcontextprotocol/servers stapt over)',
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    verification: 'geverifieerd',
    verifiedAt: VERIFIED,
    testStatus: 'Handmatig live getest op 2026-11-06 via TeamBot (Windows, npx): verbonden, 16 tools gevonden.',
  },
  {
    id: 'fetch',
    name: 'Fetch (referentieserver)',
    category: 'kennis',
    description: 'Webpagina’s ophalen en omzetten naar tekst via de officiële referentieserver “fetch”.',
    publisher: 'MCP-project (modelcontextprotocol/servers)',
    official: true,
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-fetch@2026.11.4'],
    auth: 'none',
    dataFlow:
      'Draait lokaal en haalt pagina’s op vanaf deze computer — ook adressen in je eigen netwerk (geen SSRF-bescherming in de server zelf). TeamBot heeft daarom ook een eigen beveiligde web_fetch-tool.',
    requirements: 'Python met uv (uvx).',
    license: 'MIT',
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    verification: 'geverifieerd',
    verifiedAt: VERIFIED,
    testStatus: NOT_LIVE,
  },
  {
    id: 'memory',
    name: 'Kennisgraaf (referentieserver “memory”)',
    category: 'kennis',
    description: 'Een eenvoudige lokale kennisgraaf (entiteiten en relaties) via de officiële referentieserver “memory”.',
    publisher: 'MCP-project (modelcontextprotocol/servers)',
    official: true,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory@2.1.0'],
    env: [{ name: 'MEMORY_FILE_PATH', label: 'Bestand voor de kennisgraaf', help: 'Volledig pad; standaard in de datamap van deze koppeling.', default: '{connDir}/memory.jsonl' }],
    auth: 'none',
    dataFlow: 'Draait lokaal; gegevens staan in het gekozen bestand op deze computer. Wat de bot opvraagt gaat naar je AI-provider.',
    requirements: 'Node.js met npx.',
    license: 'MIT',
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    verification: 'geverifieerd',
    verifiedAt: VERIFIED,
    testStatus: 'Handmatig live getest op 2026-11-06 via TeamBot (Windows, npx): verbonden, 9 tools gevonden.',
    alternatives: 'TeamBot heeft ook een eigen geheugenmodule met bronnen en vergeten/undo.',
  },
  {
    id: 'playwright',
    name: 'Playwright (browser)',
    category: 'browser',
    description: 'Een browser bedienen (navigeren, klikken, formulieren) via de officiële Playwright MCP-server van Microsoft.',
    publisher: 'Microsoft',
    official: true,
    transport: 'stdio',
    command: 'npx',
    // Pinned version (npm latest 2026-11-09); --isolated keeps the browser profile in memory (no cookies on disk).
    args: ['-y', '@playwright/mcp@0.0.84', '--headless', '--isolated'],
    auth: 'none',
    dataFlow: 'Draait lokaal en bezoekt websites vanaf deze computer (ook je eigen netwerk). Pagina-inhoud komt in het gesprek en gaat naar je AI-provider. Het browserprofiel blijft in het geheugen en wordt niet bewaard.',
    requirements: 'Node.js met npx; downloadt bij de eerste start een browser.',
    license: 'Apache-2.0',
    source: 'https://github.com/microsoft/playwright-mcp',
    verification: 'geverifieerd',
    verifiedAt: PINNED,
    testStatus: NOT_LIVE,
    alternatives: 'TeamBot heeft ook een eigen browsermodule met geïsoleerd profiel.',
  },
  {
    // Keenable's hosted MCP server (checked 2026-11-09 in docs.keenable.ai/mcp-server.md and live: initialize +
    // tools/list without a key gives search_web_pages and fetch_page_content). The local bridge @keenable/mcp is MIT.
    id: 'keenable',
    name: 'Keenable zoeken (zonder sleutel)',
    category: 'kennis',
    description: 'Op internet zoeken en pagina’s als tekst lezen met Keenable, gemaakt voor AI-agents. Werkt zonder account of sleutel.',
    publisher: 'Keenable',
    official: true,
    transport: 'http',
    url: 'https://api.keenable.ai/mcp',
    auth: 'headers',
    headers: [
      {
        name: 'X-API-Key',
        label: 'API-sleutel (optioneel)',
        help: 'Zonder sleutel: 1.000 verzoeken per uur per internetadres. Met een gratis sleutel van keenable.ai geen uurlimiet (100.000 verzoeken per maand). De sleutel gaat versleuteld in de kluis.',
        secret: true,
        placeholder: 'keen_…',
      },
    ],
    dataFlow: 'Zoekvragen en de adressen van pagina’s die de bot leest gaan naar Keenable (VS). Keenable zoekt in een eigen index en geeft de pagina als tekst terug.',
    license: 'Gehoste dienst van Keenable (voorwaarden: keenable.ai/terms); de lokale brug @keenable/mcp is MIT',
    source: 'https://docs.keenable.ai/mcp-server.md',
    docs: 'https://docs.keenable.ai/mcp-server.md',
    verification: 'geverifieerd',
    verifiedAt: PINNED,
    testStatus: 'Live gecontroleerd op 2026-11-09 zonder sleutel: verbonden (initialize), 2 tools gevonden; een zoekopdracht via de API gaf Nederlandse resultaten.',
    availability: 'Zonder sleutel 1.000 verzoeken per uur en 10 per seconde per internetadres, gedeeld met ander verkeer van dat adres. Volgens de voorwaarden voor persoonlijk gebruik.',
    alternatives: 'TeamBot zoekt ook zonder deze koppeling al via Keenable en Parallel (Instellingen › Geavanceerd › Zoeken).',
  },
  {
    // The Parallel MCP server (checked 2026-11-09 in docs.parallel.ai/integrations/mcp/quickstart.md and live: tools/list
    // without a key, filtered with ?tools=, gives web_search and web_fetch). The older search.parallel.ai/mcp still runs;
    // Parallel's docs send new installs here.
    id: 'parallel-search',
    name: 'Parallel zoeken (zonder sleutel)',
    category: 'kennis',
    description: 'Op internet zoeken en pagina’s lezen met Parallel, gemaakt voor AI-agents: dichte, actuele fragmenten. Werkt zonder account of sleutel.',
    publisher: 'Parallel',
    official: true,
    transport: 'http',
    url: 'https://mcp.parallel.ai/mcp?tools=web_search,web_fetch',
    auth: 'headers',
    headers: [
      {
        name: 'Authorization',
        label: 'API-sleutel (optioneel)',
        help: 'Zonder sleutel werkt het met lagere limieten. Een sleutel van platform.parallel.ai geeft hogere limieten, maar dan betaal je per gebruik.',
        secret: true,
        prefix: 'Bearer ',
      },
    ],
    dataFlow: 'Zoekvragen en de adressen van pagina’s die de bot leest gaan naar Parallel (VS), dat de resultaten als tekst teruggeeft.',
    license: 'Gehoste dienst van Parallel (voorwaarden: parallel.ai/customer-terms); de oudere Search MCP (parallel-web/search-mcp) is MIT',
    source: 'https://docs.parallel.ai/integrations/mcp/quickstart',
    docs: 'https://docs.parallel.ai/integrations/mcp/quickstart',
    verification: 'geverifieerd',
    verifiedAt: PINNED,
    testStatus: 'Live gecontroleerd op 2026-11-09 zonder sleutel: verbonden (initialize), 2 tools gevonden; een zoekopdracht gaf Nederlandse resultaten.',
    availability: 'Gratis voor hobbygebruik en persoonlijke agents; Parallel noemt geen getallen voor de limieten. Voor veel gebruik raadt Parallel een betaald account aan.',
    alternatives: 'TeamBot zoekt ook zonder deze koppeling al via Keenable en Parallel (Instellingen › Geavanceerd › Zoeken).',
  },
  {
    // nickclyde/duckduckgo-mcp-server (MIT, 1,573 stars, PyPI 0.7.0 of 2026-09-04; checked 2026-11-09).
    id: 'duckduckgo',
    name: 'DuckDuckGo zoeken (zonder sleutel)',
    category: 'kennis',
    description: 'Op internet zoeken via DuckDuckGo en een gevonden pagina als tekst lezen, zonder account of sleutel.',
    publisher: 'nickclyde (community)',
    official: false,
    transport: 'stdio',
    command: 'uvx',
    args: ['duckduckgo-mcp-server@0.7.0'],
    env: [{ name: 'DDG_SAFE_SEARCH', label: 'SafeSearch (optioneel)', help: 'STRICT, MODERATE of OFF.', default: 'MODERATE' }],
    auth: 'none',
    dataFlow: 'Draait lokaal. Zoekvragen gaan vanaf deze computer naar DuckDuckGo; pagina’s die de bot leest worden vanaf deze computer opgehaald (ook adressen in je eigen netwerk: de server heeft daar geen bescherming tegen). Resultaten gaan naar je AI-provider.',
    requirements: 'Python met uv (uvx).',
    license: 'MIT',
    source: 'https://github.com/nickclyde/duckduckgo-mcp-server',
    verification: 'geverifieerd',
    verifiedAt: PINNED,
    testStatus: `${NOT_LIVE} DuckDuckGo kan veel zoekvragen achter elkaar blokkeren; de server remt zelf af (standaard 30 per minuut).`,
    alternatives: 'TeamBot heeft ook een eigen beveiligde web_fetch-tool. Een eigen SearXNG met mcp-searxng is robuuster maar vraagt een eigen installatie.',
  },
  {
    // jina-ai/MCP (Apache-2.0): read_url works without a key (rate limited); search needs a key, so only read_url is on.
    id: 'jina-reader',
    name: 'Jina Reader (pagina’s lezen)',
    category: 'kennis',
    description: 'Een webpagina of pdf als nette tekst laten lezen door Jina; zonder sleutel, met een lagere limiet.',
    publisher: 'Jina AI',
    official: true,
    transport: 'http',
    url: 'https://mcp.jina.ai/v1?include_tools=read_url',
    auth: 'headers',
    headers: [
      {
        name: 'Authorization',
        label: 'API-sleutel (optioneel)',
        help: 'Zonder sleutel werkt lezen met een lagere limiet. Een gratis sleutel maak je op jina.ai; die gaat versleuteld in de kluis.',
        secret: true,
        prefix: 'Bearer ',
        placeholder: 'jina_…',
      },
    ],
    dataFlow: 'Het adres van elke pagina die de bot leest gaat naar mcp.jina.ai (Jina AI), dat de pagina ophaalt en als tekst teruggeeft. Jina ziet dus welke pagina’s je laat lezen. Alleen de leestool staat aan; zoeken (sleutel nodig) niet.',
    license: 'Apache-2.0 (jina-ai/MCP); gehoste dienst van Jina AI',
    source: 'https://github.com/jina-ai/MCP',
    verification: 'geverifieerd',
    verifiedAt: PINNED,
    testStatus: 'Eindpunt (/v1) en de filter include_tools gecontroleerd in de README op 2026-11-09. Niet live getest.',
  },
  {
    // tavily-ai/tavily-mcp (MIT, 2,481 stars, npm tavily-mcp 0.2.22; checked 2026-11-09). The hosted server takes the key
    // as a Bearer header (README); without a key it answers 401.
    id: 'tavily',
    name: 'Tavily zoeken (eigen gratis sleutel)',
    category: 'kennis',
    description: 'Zoeken en pagina’s uitlezen met Tavily, gemaakt voor AI-agents. Met je eigen gratis sleutel.',
    publisher: 'Tavily',
    official: true,
    transport: 'http',
    url: 'https://mcp.tavily.com/mcp/',
    auth: 'headers',
    headers: [
      {
        name: 'Authorization',
        label: 'Tavily-sleutel',
        help: 'Gratis: 1.000 credits per maand, zonder creditcard. Maak de sleutel op app.tavily.com; hij gaat versleuteld in de kluis.',
        secret: true,
        required: true,
        prefix: 'Bearer ',
        placeholder: 'tvly-…',
      },
    ],
    dataFlow: 'Zoekvragen en de adressen van pagina’s die de bot laat uitlezen gaan naar Tavily (VS).',
    license: 'MIT (tavily-ai/tavily-mcp); gehoste dienst van Tavily',
    source: 'https://github.com/tavily-ai/tavily-mcp',
    docs: 'https://docs.tavily.com/documentation/mcp',
    verification: 'geverifieerd',
    verifiedAt: PINNED,
    testStatus: 'Adres en sleutel-header gecontroleerd in de README op 2026-11-09; zonder sleutel antwoordt de server 401. Met een echte sleutel niet live getest.',
    availability: 'Gratis: 1.000 credits per maand (een gewone zoekopdracht kost 1 credit), zonder creditcard.',
    alternatives: 'Lokaal: npx -y tavily-mcp@0.2.22 met TAVILY_API_KEY. Dezelfde sleutel kun je ook bij Instellingen › Geavanceerd › Zoeken invullen; dan gebruikt web_search hem als reserve.',
  },
  {
    // exa-labs/exa-mcp-server (MIT, 5,219 stars, npm exa-mcp-server 3.4.3; checked 2026-11-09). Live: tools/list without
    // a key, filtered with ?tools=, gives web_search_exa and web_fetch_exa (agent_run, which costs more, stays off).
    id: 'exa',
    name: 'Exa zoeken (eigen gratis sleutel)',
    category: 'kennis',
    description: 'Op betekenis zoeken en pagina’s als tekst lezen met Exa. Zonder sleutel met een lage gratis limiet; met je eigen gratis sleutel ruimer.',
    publisher: 'Exa',
    official: true,
    transport: 'http',
    url: 'https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa',
    auth: 'headers',
    headers: [
      {
        name: 'x-api-key',
        label: 'Exa-sleutel (aanbevolen)',
        help: 'Gratis: elke maand $10 tegoed, zonder creditcard. Maak de sleutel op dashboard.exa.ai; hij gaat versleuteld in de kluis. Zonder sleutel werkt het alleen via IPv4 en met een lage limiet.',
        secret: true,
      },
    ],
    dataFlow: 'Zoekvragen en de adressen van pagina’s die de bot leest gaan naar Exa (VS).',
    license: 'MIT (exa-labs/exa-mcp-server); gehoste dienst van Exa',
    source: 'https://github.com/exa-labs/exa-mcp-server',
    docs: 'https://docs.exa.ai/reference/exa-mcp',
    verification: 'geverifieerd',
    verifiedAt: PINNED,
    testStatus: 'Live gecontroleerd op 2026-11-09 zonder sleutel: verbonden (initialize), 2 tools gevonden. Met een sleutel niet live getest.',
    availability: 'Gratis tegoed: $10 per maand (ongeveer 1.400 zoekopdrachten), zonder creditcard.',
    alternatives: 'Lokaal: npx -y exa-mcp-server@3.4.3 met EXA_API_KEY. Dezelfde sleutel kun je ook bij Instellingen › Geavanceerd › Zoeken invullen; dan gebruikt web_search hem als reserve.',
  },
  {
    // taylorwilsdon/google_workspace_mcp (MIT, PyPI workspace-mcp 2.4.0 of 2026-11-08). Not by Google; an option next to
    // Google's own servers (Developer Preview). Read-only and the core tool tier by default.
    id: 'google-workspace-mcp',
    name: 'Google Workspace (community, alleen lezen)',
    category: 'productiviteit',
    description: 'Gmail, Agenda, Drive, Docs en Sheets lezen via de open-source Workspace MCP-server, standaard alleen lezen.',
    publisher: 'taylorwilsdon (community)',
    official: false,
    transport: 'stdio',
    command: 'uvx',
    args: ['workspace-mcp@2.4.0', '--tool-tier', 'core', '--read-only', '--tools', 'gmail', 'calendar', 'drive', 'docs', 'sheets'],
    env: [
      { name: 'GOOGLE_OAUTH_CLIENT_ID', label: 'Google OAuth-client-ID', help: 'Van een eigen OAuth-client in Google Cloud (zelfde stappen als bij de Google-koppelingen).', required: true, placeholder: '…apps.googleusercontent.com' },
      { name: 'GOOGLE_OAUTH_CLIENT_SECRET', label: 'Clientgeheim', help: 'Wordt versleuteld in de kluis bewaard.', secret: true, required: true },
    ],
    auth: 'none',
    dataFlow: 'Draait lokaal op deze computer en praat rechtstreeks met de Google-API’s; er zit geen tussendienst tussen. E-mail, afspraken en bestanden die de bot opvraagt gaan naar je AI-provider. Het inloggen bij Google regelt de server zelf.',
    requirements: 'Python met uv (uvx) en een eigen Google Cloud OAuth-client.',
    license: 'MIT',
    source: 'https://github.com/taylorwilsdon/google_workspace_mcp',
    verification: 'geverifieerd',
    verifiedAt: PINNED,
    testStatus: `${NOT_LIVE} Vlaggen (--tool-tier, --read-only, --tools) gecontroleerd in de README op 2026-11-09; inloggen bij Google niet getest.`,
    availability: 'Werkt met persoonlijke en Workspace-accounts, ook zonder de Developer Preview van Google.',
    alternatives: 'De officiële Google-servers (Gmail, Drive, Agenda, Sheets) hierboven, als je toegang hebt tot de Developer Preview.',
  },
  {
    id: 'context7',
    name: 'Context7 (documentatie)',
    category: 'kennis',
    description: 'Actuele documentatie en codevoorbeelden van libraries opzoeken.',
    publisher: 'Upstash',
    official: true,
    transport: 'http',
    url: 'https://mcp.context7.com/mcp',
    auth: 'headers',
    headers: [
      {
        name: 'Authorization',
        label: 'API-sleutel (optioneel)',
        help: 'Zonder sleutel werkt het met lagere limieten. Sleutel aanmaken op context7.com.',
        secret: true,
        prefix: 'Bearer ',
      },
    ],
    dataFlow: 'Zoekvragen gaan naar mcp.context7.com (Upstash). Documentatie komt terug in het gesprek.',
    license: 'MIT (upstash/context7)',
    source: 'https://github.com/upstash/context7',
    verification: 'geverifieerd',
    verifiedAt: VERIFIED,
    testStatus: 'Handmatig live getest op 2026-11-06 via TeamBot zonder sleutel: verbonden, 2 leestools gevonden.',
    alternatives: 'Lokaal: npx -y @upstash/context7-mcp · OAuth-variant: https://mcp.context7.com/mcp/oauth',
  },
  ...MARKETING_CATALOG,

  ...CATALOG_SERVICE,

  ...CATALOG_WORK,
  {
    id: 'custom',
    name: 'Eigen server',
    category: 'eigen',
    description: 'Koppel elke MCP-server: een lokaal programma (stdio) of een remote URL (Streamable HTTP of SSE), met headers, geheimen of OAuth.',
    publisher: 'Jijzelf',
    official: false,
    transport: 'stdio',
    auth: 'none',
    dataFlow: 'Hangt af van de server. TeamBot toont na het verbinden alle tools met hun risico; acties staan pas aan na een geslaagde leestest.',
    license: 'Afhankelijk van de server',
    source: 'https://modelcontextprotocol.io/specification',
    verification: 'geverifieerd',
    verifiedAt: VERIFIED,
    testStatus: 'Gedekt door automatische tests (stdio, Streamable HTTP, SSE-client, OAuth) met een lokale testserver.',
  },
];

export function catalogEntry(id: string | null | undefined): CatalogEntry | undefined {
  return id ? CATALOG.find((c) => c.id === id) : undefined;
}
