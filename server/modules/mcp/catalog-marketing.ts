import type { CatalogEntry } from './catalog.js';

/**
 * Package 0.4.5, marketing area: apps (MCP servers) for SEO, analytics, ads and social listening. Checked on
 * 2026-11-09: licence file and latest commit on GitHub (`gh`), the pinned version on npm or PyPI, and the README for
 * the start command, settings and which tools write. Versions are pinned; a newer one only comes with a new catalogue.
 *
 * Deliberately left out (2026-11-09): OpenSEO (every-app/open-seo, MIT) needs a paid DataForSEO account (no free
 * tier) and runs as your own Docker or Cloudflare app; once it runs, add it as "Eigen server" with its /mcp address and
 * an API key. Also left out: the DataForSEO MCP (paid only), meta-ads-mcp (no open licence: NOASSERTION), Postiz
 * (AGPL-3.0), mcp-server-gsc by ahonn (no licence file), the Bluesky MCP servers (no licence or no commits for over a
 * year), cohnen/mcp-google-ads (no commits since 2025-10) and mcp-gsc by AminForou (its PyPI release is from 2025-09).
 */

const VERIFIED = '2026-11-09';
const NOT_LIVE = 'Niet live getest tegen de echte dienst; het transport (stdio/HTTP) is gedekt door automatische tests met een lokale testserver.';
const GOOGLE_CREDENTIALS_HELP = 'Volledig pad naar het JSON-bestand met je Google-inlog (Application Default Credentials). Maak het één keer met de Google Cloud CLI: gcloud auth application-default login met de rechten uit de documentatie; gcloud toont daarna het pad.';

export const MARKETING_CATALOG: CatalogEntry[] = [
  {
    // googleanalytics/google-analytics-mcp (Apache-2.0, Google), PyPI analytics-mcp 1.1.0 of 2026-11-06. Without
    // --allow-write the server only offers its read tools.
    id: 'google-analytics',
    name: 'Google Analytics 4 (alleen lezen)',
    category: 'kennis',
    description: 'Bezoekers, bronnen, conversies en trechters uit Google Analytics 4 opvragen via de officiële MCP-server van Google; alleen lezen.',
    publisher: 'Google',
    official: true,
    transport: 'stdio',
    command: 'uvx',
    args: ['analytics-mcp@1.1.0'],
    env: [
      { name: 'GOOGLE_APPLICATION_CREDENTIALS', label: 'Bestand met Google-inlog', help: GOOGLE_CREDENTIALS_HELP, required: true, placeholder: 'C:\\Users\\…\\application_default_credentials.json' },
      { name: 'GOOGLE_CLOUD_PROJECT', label: 'Google Cloud-project-ID', help: 'Het project waarin de Google Analytics Admin API en Data API aanstaan.', required: true },
    ],
    auth: 'none',
    dataFlow: 'Draait lokaal op deze computer en praat rechtstreeks met de Google Analytics-API’s. Cijfers die de bot opvraagt gaan naar je AI-provider.',
    requirements: 'Python met uv (uvx), de Google Cloud CLI (gcloud) en een Google Cloud-project met de Google Analytics Admin API en Data API aan; inloggen met het recht analytics.readonly.',
    license: 'Apache-2.0',
    source: 'https://github.com/googleanalytics/google-analytics-mcp',
    verification: 'geverifieerd',
    verifiedAt: VERIFIED,
    testStatus: `${NOT_LIVE} Pakket, opdracht en instellingen gecontroleerd in de README op 2026-11-09; zonder --allow-write zijn er alleen leestools.`,
    revokeHelp: 'myaccount.google.com › Beveiliging › Apps van derden met accounttoegang (of verwijder het inlogbestand).',
    // Only exist with --allow-write; never treated as reading.
    riskOverrides: { create_property_annotation: 'write', create_custom_dimension: 'write', create_key_event: 'write' },
  },
  {
    // googleads/google-ads-mcp (Apache-2.0, Google), PyPI google-ads-mcp 0.0.6 of 2026-11-02. Write tools first return
    // a proposal (validate_only) and only change the account when called again with its checksum.
    id: 'google-ads',
    name: 'Google Ads',
    category: 'kennis',
    description: 'Campagnes, zoekwoorden en resultaten uit Google Ads opvragen (GAQL) via de officiële MCP-server van Google.',
    publisher: 'Google',
    official: true,
    transport: 'stdio',
    command: 'uvx',
    args: ['google-ads-mcp@0.0.6'],
    env: [
      { name: 'GOOGLE_APPLICATION_CREDENTIALS', label: 'Bestand met Google-inlog', help: GOOGLE_CREDENTIALS_HELP, required: true, placeholder: 'C:\\Users\\…\\application_default_credentials.json' },
      { name: 'GOOGLE_PROJECT_ID', label: 'Google Cloud-project-ID', help: 'Het project waarin de Google Ads API aanstaat.', required: true },
      { name: 'GOOGLE_ADS_DEVELOPER_TOKEN', label: 'Developer token', help: 'Uit het API Center van je Google Ads-beheerdersaccount. Wordt versleuteld in de kluis bewaard.', secret: true, required: true },
      { name: 'GOOGLE_ADS_LOGIN_CUSTOMER_ID', label: 'Beheerdersaccount-ID (optioneel)', help: 'Alleen als je klantaccounts via een beheerdersaccount (MCC) bereikt; zonder streepjes.' },
    ],
    auth: 'none',
    dataFlow: 'Draait lokaal en praat rechtstreeks met de Google Ads API. Campagnegegevens die de bot opvraagt gaan naar je AI-provider. Een video uploaden zet die op YouTube.',
    requirements: 'Python met uv (uvx), de Google Cloud CLI (gcloud), de Google Ads API aan in je project en een developer token; inloggen met het recht adwords.',
    license: 'Apache-2.0',
    source: 'https://github.com/googleads/google-ads-mcp',
    verification: 'geverifieerd',
    verifiedAt: VERIFIED,
    testStatus: `${NOT_LIVE} Pakket, instellingen (ook GOOGLE_ADS_DEVELOPER_TOKEN in ads_mcp/utils.py) en de schrijftools gecontroleerd op 2026-11-09.`,
    revokeHelp: 'myaccount.google.com › Beveiliging › Apps van derden met accounttoegang; het developer token beheer je in het API Center van Google Ads.',
    riskOverrides: { create_asset: 'write', manage_labels: 'write', manage_label_associations: 'write', upload_video_asset: 'danger' },
    availability: 'De Google Ads API is gratis, maar het developer token moet je aanvragen; met een testtoken werkt alleen een testaccount.',
  },
  {
    // saurabhsharma2u/search-console-mcp (MIT), npm 2.1.4 of 2026-10-21. Read-only by default since 2.1.4: changes
    // (sitemaps, indexing) need an extra write permission at setup.
    id: 'search-console',
    name: 'Google Search Console en Bing (community)',
    category: 'kennis',
    description: 'Zoekwoorden, posities, klikken en indexering uit Google Search Console (en Bing Webmaster Tools) opvragen; standaard alleen lezen.',
    publisher: 'saurabhsharma2u (community)',
    official: false,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'search-console-mcp@2.1.4'],
    env: [
      { name: 'GOOGLE_APPLICATION_CREDENTIALS', label: 'Serviceaccount-sleutel (optioneel)', help: 'Pad naar de JSON-sleutel van een Google-serviceaccount dat in Search Console is toegevoegd. Leeg = de inlog van “npx search-console-mcp@2.1.4 setup” (één keer in een terminal).' },
      { name: 'BING_API_KEY', label: 'Bing Webmaster-sleutel (optioneel)', help: 'Uit Bing Webmaster Tools › Instellingen › API-toegang. Wordt versleuteld in de kluis bewaard.', secret: true },
    ],
    auth: 'none',
    dataFlow: 'Draait lokaal en praat rechtstreeks met de API’s van Google Search Console (en Bing als je een sleutel invult). Zoekcijfers die de bot opvraagt gaan naar je AI-provider.',
    requirements: 'Node.js met npx en een site in Google Search Console; inloggen met een serviceaccount of één keer “npx search-console-mcp@2.1.4 setup” in een terminal.',
    license: 'MIT',
    source: 'https://github.com/saurabhsharma2u/search-console-mcp',
    verification: 'geverifieerd',
    verifiedAt: VERIFIED,
    testStatus: `${NOT_LIVE} Opdracht, inlogwijzen en de schrijftools gecontroleerd in de README op 2026-11-09.`,
    revokeHelp: 'myaccount.google.com › Beveiliging › Apps van derden met accounttoegang; een serviceaccount haal je weg in Search Console › Instellingen › Gebruikers en rechten.',
    riskOverrides: { sitemaps_submit: 'write', indexing_submit: 'write', sitemaps_delete: 'danger', sites_manage: 'danger' },
    alternatives: 'Zonder koppeling: exporteer de prestaties uit Search Console als CSV en geef die aan de bot.',
  },
  {
    // priyankark/lighthouse-mcp (MIT), npm 0.1.21 of 2026-10-26. Uses the Lighthouse library (Apache-2.0, Google).
    id: 'lighthouse',
    name: 'Lighthouse (snelheid en SEO meten)',
    category: 'browser',
    description: 'Een pagina laten doormeten door Google Lighthouse: snelheid, SEO, toegankelijkheid en goede gewoonten, met scores en verbeterpunten.',
    publisher: 'priyankark (community)',
    official: false,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'lighthouse-mcp@0.1.21'],
    auth: 'none',
    dataFlow: 'Draait lokaal: Chrome op deze computer opent de pagina en Lighthouse meet hem. Er is geen tussendienst; de uitslag gaat naar je AI-provider.',
    requirements: 'Node.js 22.19 of nieuwer met npx en Google Chrome (of Chromium) op deze computer.',
    license: 'MIT',
    source: 'https://github.com/priyankark/lighthouse-mcp',
    verification: 'geverifieerd',
    verifiedAt: VERIFIED,
    testStatus: `${NOT_LIVE} Opdracht en tools (run_audit, get_performance_score) gecontroleerd in de README op 2026-11-09.`,
    alternatives: 'Zonder koppeling in een terminal: npx lighthouse@13.6.0 <adres> of, voor een hele site, npx unlighthouse@0.19.1 --site <adres>.',
  },
  {
    // ruslanlap/pagespeed-insights-mcp (Apache-2.0), npm 2.2.0 of 2026-10-19.
    id: 'pagespeed-insights',
    name: 'PageSpeed Insights (Google)',
    category: 'kennis',
    description: 'Snelheid en Core Web Vitals van een pagina opvragen bij Google PageSpeed Insights, ook de cijfers van echte bezoekers (CrUX).',
    publisher: 'ruslanlap (community)',
    official: false,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'pagespeed-insights-mcp@2.2.0'],
    env: [
      { name: 'GOOGLE_API_KEY', label: 'Google API-sleutel', help: 'Gratis: maak in Google Cloud een API-sleutel en zet de PageSpeed Insights API aan. Wordt versleuteld in de kluis bewaard.', secret: true, required: true },
    ],
    auth: 'none',
    dataFlow: 'Draait lokaal; het adres van elke pagina die je laat meten gaat naar Google (PageSpeed Insights API), dat de pagina vanaf zijn eigen servers meet. De uitslag gaat naar je AI-provider.',
    requirements: 'Node.js met npx en een gratis Google API-sleutel.',
    license: 'Apache-2.0',
    source: 'https://github.com/ruslanlap/pagespeed-insights-mcp',
    verification: 'geverifieerd',
    verifiedAt: VERIFIED,
    testStatus: `${NOT_LIVE} Opdracht, de instelling GOOGLE_API_KEY en de tools gecontroleerd in de README op 2026-11-09.`,
    availability: 'De PageSpeed Insights API is gratis binnen het dagquotum van Google.',
  },
  {
    // Hawstein/mcp-server-reddit (MIT), PyPI 0.2.1 of 2026-06-10. Eight read-only tools on Reddit's public API.
    id: 'reddit',
    name: 'Reddit lezen (zonder sleutel)',
    category: 'kennis',
    description: 'Lezen wat er op Reddit over een onderwerp, product of merk wordt gezegd: subreddits, berichten en reacties, zonder account.',
    publisher: 'Hawstein (community)',
    official: false,
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-reddit@0.2.1'],
    auth: 'none',
    dataFlow: 'Draait lokaal en haalt openbare Reddit-berichten op vanaf deze computer. Wat de bot leest gaat naar je AI-provider. Er wordt niets geplaatst.',
    requirements: 'Python met uv (uvx).',
    license: 'MIT',
    source: 'https://github.com/Hawstein/mcp-server-reddit',
    verification: 'geverifieerd',
    verifiedAt: VERIFIED,
    testStatus: `${NOT_LIVE} Opdracht en de acht leestools gecontroleerd in de README op 2026-11-09.`,
    availability: 'Reddit kan verzoeken zonder account afremmen of weigeren.',
  },
  {
    // serpapi/serpapi-mcp (MIT), hosted by SerpApi. The key goes in the Authorization header (not in the address).
    id: 'serpapi',
    name: 'SerpApi (Google-zoekresultaten)',
    category: 'kennis',
    description: 'Echte zoekresultaten opvragen van Google en andere zoekmachines (ook Trends, Maps en Shopping): posities, advertenties en concurrenten.',
    publisher: 'SerpApi',
    official: true,
    transport: 'http',
    url: 'https://mcp.serpapi.com/mcp',
    auth: 'headers',
    headers: [
      {
        name: 'Authorization',
        label: 'API-sleutel',
        help: 'Gratis account op serpapi.com (250 zoekopdrachten per maand). De sleutel gaat versleuteld in de kluis.',
        secret: true,
        required: true,
        prefix: 'Bearer ',
      },
    ],
    dataFlow: 'Zoekvragen gaan naar mcp.serpapi.com (SerpApi), dat de zoekmachine bevraagt en de resultaten teruggeeft. SerpApi ziet dus waar je op zoekt. Resultaten gaan naar je AI-provider.',
    license: 'MIT (serpapi/serpapi-mcp); gehoste dienst van SerpApi',
    source: 'https://github.com/serpapi/serpapi-mcp',
    verification: 'geverifieerd',
    verifiedAt: VERIFIED,
    testStatus: 'Eindpunt en sleutel in de Authorization-header gecontroleerd in de README op 2026-11-09; het gratis abonnement op serpapi.com/pricing. Niet live getest.',
    availability: 'Gratis abonnement: 250 zoekopdrachten per maand (50 per uur); daarboven betaald.',
    alternatives: 'Zonder sleutel: de koppeling “DuckDuckGo zoeken” (geen Google-posities).',
  },
];
