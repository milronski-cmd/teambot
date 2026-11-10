import type { CuratedSource, WindowsNote } from './curated.js';

/**
 * Catalogue sources for work: building software and websites, data, documents and office, design, research and
 * productivity (notes and tasks). Checked by hand on 2026-11-09 with the GitHub API (`gh`): the licence file that
 * applies to every listed skill folder, the files in the folder at the pinned commit (no archives, programs or files
 * over the size limit of `import-rules.ts`), and recent activity. Same rules as `curated.ts`: nothing is bundled,
 * installs fetch exactly the pinned files.
 *
 * Deliberately left out (2026-11-09):
 *  - anthropics/skills web-artifacts-builder: ships an archive (shadcn-components.tar.gz), which the import rules refuse;
 *  - anthropics/skills canvas-design: leans on ~80 font files, which the import rules leave out;
 *  - anthropics/skills doc-coauthoring: the only folder without a licence file (and the repository has none);
 *  - anthropics/skills brand-guidelines (Anthropic's own house style) and skill-creator (its tests run the Claude Code CLI);
 *  - knowledge-work-plugins productivity/memory-management: TeamBot has its own memory module with sources and undo;
 *  - K-Dense-AI markdown-mermaid-writing: its SKILL.md says Apache-2.0 while the repository licence is MIT;
 *  - remotion-dev/skills: no licence file (and Remotion itself needs a paid company licence above three people);
 *  - openai/skills: no repository licence; licences differ per skill folder, not checked in this round.
 */

const VERIFIED = '2026-11-09';

const PY_SCRIPTS: WindowsNote = {
  status: 'niet-getest',
  note: 'De hulpscripts zijn Python-scripts zonder Linux-truc; op Windows niet uitgevoerd door TeamBot. De werkwijze zelf werkt zonder scripts.',
};

export const CURATED_WORK: CuratedSource[] = [
  {
    id: 'anthropic-skills-werk',
    repo: 'anthropics/skills',
    // Same pin as the Office skills in curated.ts (the Apache-2.0 commit); every folder below has its own LICENSE.txt.
    commit: '2c5958ecac7cee2b583967a2c4981d0f4a75c579',
    commitDate: '2026-11-06',
    owner: 'anthropics',
    publisher: 'Anthropic',
    license: 'Apache-2.0',
    verifiedAt: VERIFIED,
    note: 'Skills van Anthropic voor webontwerp, testen in de browser, eigen apps (MCP) bouwen, thema’s en interne berichten.',
    skills: [
      { path: 'skills/frontend-design', pack: 'Bouwen en data', category: 'Ontwikkeling', note: 'Ontwerpt en bouwt webpagina’s en schermen met een eigen, verzorgde uitstraling in plaats van een standaardlook.' },
      {
        path: 'skills/webapp-testing', scripts: true,
        pack: 'Bouwen en data',
        category: 'Ontwikkeling',
        note: 'Test een webapp op je eigen computer in een echte browser: klikken, schermafbeeldingen en foutmeldingen lezen.',
        windows: PY_SCRIPTS,
        needs: 'Python met playwright en een browser (playwright install chromium).',
      },
      {
        path: 'skills/mcp-builder', scripts: true,
        pack: 'Bouwen en data',
        category: 'Ontwikkeling',
        note: 'Helpt een eigen MCP-server (app voor bots) te bouwen in TypeScript of Python en die met testvragen te beoordelen.',
        windows: PY_SCRIPTS,
        needs: 'Node.js of Python. De evaluatiescripts gebruiken de Anthropic-API met een eigen (betaalde) sleutel; bouwen kan zonder.',
      },
      { path: 'skills/theme-factory', pack: 'Kantoor en ontwerp', category: 'Ontwerp', note: 'Geeft een presentatie, document of webpagina een kant-en-klaar thema met kleuren en lettertypen (tien thema’s).' },
      { path: 'skills/algorithmic-art', pack: 'Kantoor en ontwerp', category: 'Ontwerp', note: 'Maakt generatieve kunst met p5.js als één HTML-bestand dat je in de browser opent.' },
      { path: 'skills/internal-comms', pack: 'Kantoor en ontwerp', category: 'Communicatie', note: 'Schrijft interne berichten zoals een nieuwsbrief, een statusupdate of een lijst met veelgestelde vragen.' },
    ],
  },
  {
    id: 'anthropic-kwp-werk',
    repo: 'anthropics/knowledge-work-plugins',
    // Same pin as the other knowledge-work skills in curated.ts. engineering/ and design/ have no own licence file (the
    // repository's LICENSE, Apache-2.0, applies); productivity/, product-management/ and enterprise-search/ have one.
    commit: 'e050c2ec856373787143d7057663a6ebd1277df3',
    commitDate: '2026-11-07',
    owner: 'anthropics',
    publisher: 'Anthropic',
    license: 'Apache-2.0',
    verifiedAt: VERIFIED,
    note: 'Werkwijzen van Anthropic voor ontwikkelaars, ontwerpers, onderzoek en je eigen takenlijst.',
    skills: [
      { path: 'engineering/skills/code-review', root: 'engineering', pack: 'Bouwen en data', category: 'Ontwikkeling', note: 'Beoordeelt een codewijziging op veiligheid, snelheid en juistheid voordat hij wordt samengevoegd.' },
      { path: 'engineering/skills/documentation', root: 'engineering', pack: 'Bouwen en data', category: 'Ontwikkeling', note: 'Schrijft technische documentatie: een README, API-beschrijving, architectuur of draaiboek.' },
      { path: 'engineering/skills/system-design', root: 'engineering', pack: 'Bouwen en data', category: 'Ontwikkeling', note: 'Ontwerpt een systeem of dienst: de onderdelen, de API’s, het gegevensmodel en de afwegingen.' },
      { path: 'engineering/skills/testing-strategy', root: 'engineering', pack: 'Bouwen en data', category: 'Ontwikkeling', note: 'Stelt een testplan op: welke tests nodig zijn, op welk niveau en hoeveel.' },
      { path: 'engineering/skills/tech-debt', root: 'engineering', pack: 'Bouwen en data', category: 'Ontwikkeling', note: 'Brengt technische schuld in kaart en zet op volgorde wat het eerst opgeknapt moet worden.' },
      { path: 'product-management/skills/write-spec', root: 'product-management', pack: 'Bouwen en data', category: 'Product', note: 'Maakt van een idee een uitgewerkte specificatie met doelen, wat buiten de opdracht valt en acceptatiecriteria.' },
      { path: 'design/skills/accessibility-review', root: 'design', pack: 'Kantoor en ontwerp', category: 'Ontwerp', note: 'Controleert een ontwerp of pagina op toegankelijkheid (WCAG 2.1 AA): contrast, toetsenbord en schermlezer.' },
      { path: 'design/skills/design-critique', root: 'design', pack: 'Kantoor en ontwerp', category: 'Ontwerp', note: 'Geeft gestructureerde feedback op een ontwerp of schermafbeelding: bruikbaarheid, hiërarchie en consistentie.' },
      { path: 'design/skills/ux-copy', root: 'design', pack: 'Kantoor en ontwerp', category: 'Ontwerp', note: 'Schrijft of verbetert de korte teksten in een app of site: knoppen, foutmeldingen en lege schermen.' },
      { path: 'design/skills/user-research', root: 'design', pack: 'Onderzoek', category: 'Onderzoek', note: 'Plant gebruikersonderzoek: onderzoeksvragen, een interviewgids, een usabilitytest of een enquête.' },
      { path: 'design/skills/research-synthesis', root: 'design', pack: 'Onderzoek', category: 'Onderzoek', note: 'Vat interviews, enquêtes of klantreacties samen tot thema’s, inzichten en vervolgstappen.' },
      { path: 'enterprise-search/skills/search-strategy', root: 'enterprise-search', pack: 'Onderzoek', category: 'Onderzoek', note: 'Splitst een vraag op in gerichte zoekopdrachten per bron en zet de resultaten op volgorde van belang.' },
      { path: 'enterprise-search/skills/knowledge-synthesis', root: 'enterprise-search', pack: 'Onderzoek', category: 'Onderzoek', note: 'Voegt zoekresultaten uit meerdere bronnen samen tot één antwoord, zonder dubbelingen en met bronvermelding.' },
      { path: 'productivity/skills/task-management', root: 'productivity', pack: 'Productiviteit', category: 'Productiviteit', note: 'Houdt je taken bij in één bestand TASKS.md dat jij en de bot allebei kunnen lezen en aanpassen.' },
    ],
  },
  {
    id: 'superpowers-werk',
    repo: 'obra/superpowers',
    // Same pin as the superpowers skills in curated.ts (repository LICENSE, MIT).
    commit: '22f0b463e7a5e579904dd6211a520321035526f7',
    commitDate: '2026-11-03',
    owner: 'obra',
    publisher: 'Jesse Vincent (obra)',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'Meer werkwijzen van Jesse Vincent: eerst het idee uitdiepen, werk laten nakijken en een ontwikkeltak netjes afronden.',
    skills: [
      {
        path: 'skills/brainstorming', scripts: true,
        pack: 'Werkwijze',
        category: 'Werkwijze',
        note: 'Werkt een idee eerst samen met je uit in vragen en een ontwerp, voordat er iets gebouwd wordt.',
        windows: { status: 'niet-getest', note: 'De optionele visuele helper start een kleine lokale webserver via bash-scripts (alleen met Git Bash); de werkwijze zelf werkt zonder.' },
      },
      { path: 'skills/requesting-code-review', pack: 'Bouwen en data', category: 'Ontwikkeling', note: 'Laat werk na elke stap door een aparte beoordelaar nakijken voordat het verder gaat.' },
      { path: 'skills/finishing-a-development-branch', pack: 'Bouwen en data', category: 'Ontwikkeling', note: 'Rondt een ontwikkeltak netjes af: eerst de tests, dan kiezen tussen samenvoegen, een pull request of bewaren.', needs: 'git.' },
      { path: 'skills/using-git-worktrees', pack: 'Bouwen en data', category: 'Ontwikkeling', note: 'Zet voor nieuw werk een aparte git-werkmap op, zodat de hoofdmap schoon blijft.', needs: 'git.' },
    ],
  },
  {
    id: 'obsidian-skills',
    repo: 'kepano/obsidian-skills',
    commit: '3ccff5338ea700537839b21900aa5358a0402c98',
    commitDate: '2026-09-15',
    owner: 'kepano',
    publisher: 'Steph Ango (kepano)',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'Skills van de maker van Obsidian voor notities in Obsidian-opmaak, Bases, Canvas en het lezen van webpagina’s.',
    skills: [
      { path: 'skills/obsidian-markdown', pack: 'Productiviteit', category: 'Notities', note: 'Schrijft notities in Obsidian-opmaak: wikilinks, callouts, eigenschappen en ingesloten bestanden.' },
      { path: 'skills/obsidian-bases', pack: 'Productiviteit', category: 'Notities', note: 'Maakt Obsidian Bases: tabel- en kaartweergaven van je notities met filters en formules.' },
      { path: 'skills/json-canvas', pack: 'Kantoor en ontwerp', category: 'Ontwerp', note: 'Maakt mindmaps en stroomschema’s als JSON Canvas-bestand (.canvas) dat je in Obsidian opent.' },
      { path: 'skills/defuddle', pack: 'Onderzoek', category: 'Onderzoek', note: 'Haalt de leesbare tekst uit een webpagina als Markdown, zonder menu’s en advertenties.', needs: 'Het programma Defuddle (MIT): npm install -g defuddle.' },
    ],
  },
  {
    id: 'mattpocock-skills',
    repo: 'mattpocock/skills',
    commit: '4ae2317ddb22b046e26455e4f9c9b3aaaf62212d',
    commitDate: '2026-10-31',
    owner: 'mattpocock',
    publisher: 'Matt Pocock',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'Werkwijzen van Matt Pocock: een plan grondig laten doorvragen en werk overdragen aan een volgende sessie.',
    skills: [
      { path: 'skills/productivity/grilling', pack: 'Werkwijze', category: 'Werkwijze', note: 'Bevraagt je plan of idee grondig, ronde na ronde, tot alle beslissingen helder zijn.' },
      { path: 'skills/productivity/handoff', pack: 'Productiviteit', category: 'Productiviteit', note: 'Vat een lang gesprek samen in een overdrachtsdocument, zodat een andere bot of sessie verder kan.' },
    ],
  },
  {
    id: 'addyosmani-agent-skills',
    repo: 'addyosmani/agent-skills',
    commit: '301b02b12bff98e4688e6984af6556802322bbde',
    commitDate: '2026-11-01',
    owner: 'addyosmani',
    publisher: 'Addy Osmani',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'Engineering-skills van Addy Osmani: beveiliging, snelheid, API-ontwerp en testen in Chrome.',
    skills: [
      { path: 'skills/security-and-hardening', pack: 'Bouwen en data', category: 'Ontwikkeling', note: 'Controleert en verbetert code op beveiliging: invoer, inloggen, opslag en de OWASP Top 10.' },
      { path: 'skills/performance-optimization', pack: 'Bouwen en data', category: 'Ontwikkeling', note: 'Zoekt waarom een app of site traag is en maakt hem sneller: laadtijd, databasevragen en Core Web Vitals.' },
      { path: 'skills/api-and-interface-design', pack: 'Bouwen en data', category: 'Ontwikkeling', note: 'Ontwerpt stabiele API’s en koppelvlakken tussen onderdelen, zodat latere wijzigingen niets breken.' },
      {
        path: 'skills/browser-testing-with-devtools',
        pack: 'Bouwen en data',
        category: 'Ontwikkeling',
        note: 'Test en debugt een webpagina in een echte Chrome: de opbouw van de pagina, foutmeldingen, netwerk en snelheid.',
        needs: 'De app “Chrome DevTools (browser)” uit de appcatalogus en Google Chrome.',
      },
    ],
  },
  {
    id: 'scientific-agent-skills',
    repo: 'K-Dense-AI/scientific-agent-skills',
    // Repository LICENSE.md is MIT; the SKILL.md of both folders says MIT too.
    commit: '2d2065fb4520fa3f3f2bcf61cff26ec8b7eba4b5',
    commitDate: '2026-11-09',
    owner: 'K-Dense-AI',
    publisher: 'K-Dense',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'Onderzoeksskills van K-Dense: literatuur zoeken en bronnen controleren in open wetenschappelijke databases.',
    skills: [
      {
        path: 'skills/literature-review', scripts: true,
        pack: 'Onderzoek',
        category: 'Onderzoek',
        note: 'Doet literatuuronderzoek in onder meer PubMed, arXiv en Semantic Scholar en houdt bij wat is gezocht en gevonden.',
        windows: PY_SCRIPTS,
        needs: 'Python met requests en internettoegang. Een pdf maken vraagt Pandoc en XeLaTeX; schema’s met AI vragen een eigen API-sleutel.',
      },
      {
        path: 'skills/citation-management', scripts: true,
        pack: 'Onderzoek',
        category: 'Onderzoek',
        note: 'Zoekt en controleert bronvermeldingen via OpenAlex, Crossref en PubMed en maakt er nette BibTeX-verwijzingen van.',
        windows: PY_SCRIPTS,
        needs: 'Python met requests en internettoegang; zoeken in Google Scholar vraagt ook het pakket scholarly.',
      },
    ],
  },
];
