# Marktplaats: skills en apps van internet

De Marktplaats (tabs **Aanbevolen voor je bots · Skills · Apps · Bots**; **Bronnen** en **Meldingen** alleen met
*Geavanceerd tonen* of via een directe link) toont skills sinds 0.4 uit de **TeamBot-catalogus**: een vaste lijst
bronnen, elk vastgezet op één commit (hieronder). Apps komen live uit het officiële MCP-register en de
connectorcatalogus van de MCP-module. De zelf geschreven skills van TeamBot en eigen `teambot.catalog/v1`-catalogi
staan onder "Zelf geschreven en eigen catalogi" (een link onder de catalogus). Bot-sjablonen blijven ingebouwd: er is
(nog) geen openbare, legitieme bron voor bot-sjablonen.

**Voor een normaal mens.** De pagina opent op *Aanbevolen voor je bots*: per bot een korte lijst die past bij de naam,
rol en beschrijving van die bot (een SEO-bot krijgt eerst de SEO-skills), zonder bots één skill per onderwerp. *Alles*
heeft één zoekvak en **onderwerpen als tegels** (Marketing en SEO, Klantenservice en verkoop, Bouwen en data, Kantoor
en ontwerp, Zoeken, Schrijven en plannen, Overig; `ui/src/modules/skills/marketGroups.ts`). De lijst staat op
**sterren**: de skills uit de repository met de meeste sterren op GitHub eerst. Een kaart toont een icoon, de naam, de
bron met het aantal sterren, één zin en één knop **Toevoegen**. Toevoegen is **één klik**: de skill is er meteen voor
alle bots van het team; er is geen keuze per bot en er valt niets in te stellen. Wat er al is, heet *Toegevoegd*, met
de melding van een nieuwe versie. Een klik op de kaart opent de **pagina van de skill** (met de pijl terug): wat hij
doet, bron, sterren en licentie, wat hij nodig heeft, de instructies die de bot leest, en daaronder de controle
(rechten, veiligheidsscan, bestanden). Bevat een skill scripts, dan staat daar welke; ze staan na toevoegen uit en er
wordt niets uitgevoerd. **Toevoegen via link** (naast het zoekvak) neemt elke skill in het open SKILL.md-formaat over
van een GitHub-map, een link naar een SKILL.md (de hele map komt mee, met scripts en andere bestanden), een zip of een
map op de computer; je ziet eerst wat erin zit, met de scan. De controles blijven zoals hieronder (licentie, scan bij
toevoegen, uitgeverscontrole, vaste versie); op de kaart zijn ze één klein **Gecontroleerd** met de uitleg erachter.
Apps uit het register zijn niet door TeamBot gecontroleerd en krijgen dat label dus niet.

**Bots doen het zelf.** Een bot zoekt met `skill_find` in wat het team heeft en in de catalogus, voegt toe met
`skill_install` (een id uit de catalogus of een adres op GitHub) en legt een eigen werkwijze vast met `skill_save`;
zie [skills.md](skills.md).

Waarom een eigen catalogus (onderzoek *Knelpunten gebruikers alle AI bots*, 9 november 2026): besmette skills haalden
in 2026 samen meer dan 1,7 miljoen downloads door eerst een exacte kopie van een officiële skill te uploaden en die
later te vervangen; scanners zijn te omzeilen. Vastzetten op een commit, alleen leesbare tekst en een zichtbaar
verschil bij elke update zijn de regels die daaruit volgen. Werking en importregels: [skills.md](skills.md#teambot-catalogus-04-pakket-h).
Vanaf twee teams kies je bij installeren voor welk team (of *Alle teams*); "Geïnstalleerd" geldt dan voor dat team
(pakket B4, [skills.md](skills.md#per-team-04-pakket-b4)).

## TeamBot-catalogus

Wat de community echt gebruikt, niet de standaardpakketten van leveranciers. De lijst is gemaakt op 12 november 2026:
op GitHub gezocht naar repositories met skills in het open SKILL.md-formaat, gesorteerd op sterren, van elke kandidaat
een deel gelezen, en het licentiebestand per skillmap nagekeken (GitHub-API via `gh`). Daarna is **elke** skill
hieronder in een testapp vanaf zijn vastgezette commit met één klik toegevoegd en door een bot die nooit is ingesteld
geladen met `skill_load` (78 van 78). Het aantal sterren is dat van die dag; het staat op elke kaart en
bepaalt de volgorde.

| Bron | Sterren | Commit | Licentie | Skills |
| --- | --- | --- | --- | --- |
| `mattpocock/skills` | 321.994 | `4ae2317d` (2026-10-31) | MIT | to-spec, tdd, grilling, handoff |
| `obra/superpowers` | 316.285 | `22f0b463` (2026-11-03) | MIT | brainstorming, writing-plans, systematic-debugging, verification-before-completion, executing-plans |
| `addyosmani/agent-skills` | 115.896 | `301b02b1` (2026-11-01) | MIT | spec-driven-development, planning-and-task-breakdown, shipping-and-launch, security-and-hardening, performance-optimization |
| `blader/humanizer` | 67.965 | `b48c832f` (2026-11-10) | MIT | humanizer |
| `coreyhaines31/marketingskills` | 59.778 | `1f837447` (2026-11-11) | MIT | copywriting, seo-audit, ai-seo, ads, cold-email, emails, content-strategy, cro, ad-creative, programmatic-seo, schema, site-architecture, link-building, analytics, social, copy-editing, pricing |
| `K-Dense-AI/scientific-agent-skills` | 56.845 | `2d2065fb` (2026-11-09) | MIT | market-research-reports, statistical-analysis |
| `obsidianmd/obsidian-skills` | 51.710 | `39812773` (2026-11-11) | MIT | obsidian-markdown, defuddle |
| `alirezarezvani/claude-skills` | 29.654 | `9ca476d8` (2026-11-11) | MIT | financial-analyst, month-end-close, customer-success-manager |
| `AgriciDaniel/claude-seo` | 28.240 | `cca7e4a2` (2026-11-11) | MIT | seo-technical, seo-ecommerce, seo-local, seo-schema, seo-content, seo-plan, seo-content-brief, seo-geo |
| `phuryn/pm-skills` | 27.892 | `9af7bfd0` (2026-11-08) | MIT | competitor-analysis, market-sizing, pricing-strategy |
| `zubair-trabzada/geo-seo-claude` | 11.628 | `989cae01` (2026-10-05) | MIT | geo-audit, geo-llmstxt |
| `SawyerHood/dev-browser` | 6.727 | `520ba5cb` (2026-11-03) | MIT | dev-browser |
| `czlonkowski/n8n-skills` | 6.630 | `e037563e` (2026-10-24) | MIT | n8n-code-javascript, n8n-error-handling |
| `sergebulaev/linkedin-skills` | 5.843 | `8f8bc4b4` (2026-10-27) | MIT | linkedin-post-writer, linkedin-profile-optimizer |
| `lackeyjb/playwright-skill` | 3.285 | `dd47a6a0` (2026-08-14) | MIT | playwright-skill |
| `addyosmani/web-quality-skills` | 3.069 | `afa8da94` (2026-08-24) | MIT | seo, core-web-vitals, accessibility |
| `wondelai/skills` | 2.669 | `d8d5d75f` (2026-11-02) | MIT | hundred-million-offers, one-page-marketing, mom-test |
| `Kappaemme-git/codex-first-customer-finder-skill` | 1.249 | `d3f6964b` (2026-09-19) | MIT | first-customer-finder |
| `jezweb/claude-skills` | 1.108 | `1260fa74` (2026-10-09) | MIT | shopify-setup, shopify-products, wordpress-setup, wordpress-content, seo-local-business |
| `growthenginenowoslawski/coldoutboundskills` | 813 | `25c5d85f` (2026-10-05) | MIT | campaign-strategy, campaign-copywriting, spam-word-checker |
| `40RTY-ai/shopify-admin-skills` | 204 | `e3579f43` (2026-10-26) | MIT | shopify-admin-order-lookup-and-summary, shopify-admin-refund-and-reorder, shopify-admin-low-inventory-restock, shopify-admin-seo-metadata-audit, shopify-admin-payout-reconciliation |

Samen 78 skills uit 21 repositories. Een skill staat er alleen in als de repository een open licentie in een
licentiebestand heeft (MIT, Apache-2.0, BSD, ISC), de vastgezette versie door de importregels komt, en hij zonder
bevestiging toe te voegen is.

Bewust niet opgenomen:
- **standaardpakketten van leveranciers** (Anthropic, Google, OpenAI, Vercel): de eigenaar wil wat mensen zelf kozen.
  Wie ze toch wil, voegt ze toe met *Toevoegen via link*;
- **geweigerd door de importregels** (te veel of te grote bestanden, archieven): `Leonxlnx/taste-skill`,
  `tt-a1i/archify`, `mvanhorn/last30days-skill`, `nicobailon/visual-explainer`, `Agents365-ai/drawio-skill`,
  `mikehasa/golive-skill`;
- **ernstige bevinding in de veiligheidsscan** (vraagt een bevestiging, dus geen één klik):
  `OthmanAdi/planning-with-files`, `nidhinjs/prompt-master`, `n8n-workflow-patterns` uit `czlonkowski/n8n-skills`;
- `AgriciDaniel/claude-ads`: de hoofdskill heet `ads`, net als die van marketingskills (één naam per team), en de
  andere skills leunen op die hoofdskill;
- **geen of een beperkende licentie**: `vercel-labs/agent-skills` en `ComposioHQ/awesome-claude-skills` (geen
  licentiebestand), `sickn33/agentic-awesome-skills` (teksten CC BY 4.0), `trailofbits/skills` (CC-BY-SA),
  `hesreallyhim/awesome-claude-code` (CC BY-NC-ND), AGPL;
- **werken niet als losse skillmap**: `garrytan/gstack`, `Panniantong/Agent-Reach`, `nowork-studio/notfair-plugin`.

Waar de community weinig goeds heeft (stand 12 november 2026): Google Merchant Center, WooCommerce, Nederlandse
boekhouding en btw, en Excel. Daar staat dus weinig of niets; een bot kan er zelf een skill voor vastleggen
(`skill_save`).

Skills met scripts: de scripts staan na toevoegen uit en zijn op Windows niet door TeamBot uitgevoerd; de werkwijze zelf
werkt zonder.

Code: `server/modules/skills/{curated,curated-source,curated-routes,import-rules,textdiff}.ts` (catalogus),
`server/modules/skills/{websource,web-routes,webcache,licenses}.ts` (open zoeken in GitHub, skills.sh en ClawHub; cache; licenties),
`server/modules/mcp/registry.ts` (+ routes in `server/modules/mcp/api.ts`), UI
`ui/src/modules/skills/{Catalog,ClearMarket,Recommended,OpenMarket,RegistryApps,marketParts,merge}.tsx` en `marketGroups.ts`. Tests: `tests/skills-catalog.test.ts`
(lokale fixture-repository in `tests/fixtures/curated/`), `tests/skills-catalog-data.test.ts` (de lijst zelf), `tests/skills-web-open.test.ts` (open zoeken en toevoegen, tegen een nagebootste GitHub, skills.sh en ClawHub op 127.0.0.1), `tests/marketplace-web.test.ts` en `tests/market-speed.test.ts`
met opgenomen antwoorden in `tests/fixtures/market/` (geen netwerk; vertraagde bronnen worden gesimuleerd), de duidelijke pagina (tegels, zoeken, Toevoegen in één klik, de skillpagina, ook op de telefoon): `node --import tsx tests/e2e/market-clear.mjs`, in de echte
UI: `node --import tsx tests/e2e/market-speed.mjs [map voor schermafbeeldingen]` (de weergave Openbaar via
`#/m/skills/skills?bron=open`; na `npm run build:ui`; `MARKET_SPEED_LIVE=1` voor het echte internet), live:
`OPENAI_KEY_FILE=… npm run market:live` (tijdelijke datamap).

## Snel eerste beeld (stale-while-revalidate)

Voor skills: *Gecontroleerd* vraagt geen netwerk en staat er meteen. *Open* vraagt GitHub, skills.sh en ClawHub elk
apart (`only=github|directory|clawhub`), zodat een trage bron de kaarten van de andere niet ophoudt; wat al eens
gezocht is, komt uit de cache zonder verzoek. De punten hieronder over `pending`, `refreshing` en "Alvast klaar" gelden
voor de apps uit het MCP-register.

- Alle bronnen lopen parallel, elk met een eigen tijdslimiet (`SOURCE_TIMEOUTS` in `websource.ts`: HEAD-controle 10 s,
  archief 60 s, GitHub-API 10 s, skills.sh 10 s; register 10 s per verzoek). Eén trage bron houdt de rest niet op.
- **Wat in de cache staat, komt meteen** (laatst opgehaalde momentopname uit `<datamap>/cache/…`). Is de laatste
  controle ouder dan een uur, dan wordt de bron op de achtergrond gecontroleerd (`refreshing`); de pagina toont klein
  "Bijwerken…" en daarna "Bijgewerkt". Een controle die net klaar is (ook een mislukte) telt vijf minuten als gedaan.
- **Wat nooit is opgehaald**, krijgt bij het eerste beeld 1,2 s (`FIRST_VIEW_BUDGET_MS`); daarna loopt het op de
  achtergrond door (`pending`). De pagina vraagt opnieuw met `budget=1500&early=1`: de server antwoordt zodra de
  volgende bron binnen is. Elke collectie wordt één keer gedownload en geparst, hoe vaak er ook gevraagd wordt.
- Staat er nog niets van internet klaar (eerste start, traag of geen netwerk), dan toont de pagina meteen zes skills
  of apps van TeamBot zelf ("Alvast klaar", met "Alle … bekijken") en daaronder plaatshouders.
- Nieuwe kaarten komen **onder** de kaarten die er al staan (`mergeStable` in `merge.ts`); kaarten verschuiven niet.
  De categorierij heeft een vaste hoogte (schuift zijwaarts op de telefoon), fouten van bronnen staan onder de lijst.
- Offline (`TEAMBOT_OFFLINE=1`): alleen de cache, geen achtergrondcontrole, en de regel "Offline: laatst opgehaalde
  gegevens."
- Gemeten (2026-11-07, koude start, lege datamap): met gesimuleerde trage bronnen eerste kaarten 1,4 s, eerste
  internetkaarten 3,4 s, compleet 4,9 s; tegen het echte internet eerste kaarten 1,6 s, eerste internetkaarten 2,0 s,
  alle collecties 8,8 s; apps 1,4 s met alle 49 aanbevolen apps.

## Open: alles wat openbaar is

Naast *Gecontroleerd* heeft Skills de weergave *Open*: één zoekvak en één sorteerkeuze over alles wat openbaar is, voor
iedereen aan (geen instelling; de omgevingsvariabele `TEAMBOT_SKILL_COLLECTIONS` en de open collecties van 0.3 bestaan
niet meer). Niemand bij TeamBot heeft deze skills bekeken; de controle gebeurt op het moment van toevoegen. Zoek je op
woorden, dan staan de treffers uit de gecontroleerde catalogus en uit de eigen catalogi er ook bij.

| Bron | Wat | Toegang (zonder account) | Getallen op de kaart |
| --- | --- | --- | --- |
| GitHub | Repositories met skills: zonder woorden alles met het topic `agent-skills`, met woorden die woorden plus "skill" in naam, beschrijving of topics (`/search/repositories`). De skills in een repository leest TeamBot uit het archief (`codeload.github.com`, geen API-limiet) | 10 zoekopdrachten per minuut; code zoeken (mappen met een `SKILL.md`) vraagt een account en wordt niet gebruikt | Sterren op GitHub, licentie volgens GitHub, laatst bijgewerkt |
| skills.sh | Losse skills die in een GitHub-repository staan: zoeken (`/api/search`) en de lijsten "all-time" en "trending" (`/api/skills/<lijst>/<pagina>`) | Openbaar | Installaties volgens skills.sh (hun eigen telling); geen beschrijving tot de repository is geopend |
| ClawHub | Losse skills die ClawHub zelf host (niet op GitHub), met versies: lijst (`/api/v1/skills?sort=stars|trending|newest|updated`, met cursor), zoeken (`/api/v1/search`), één skill (`/api/v1/skills/<naam>?ownerHandle=`), zip per versie (`/api/v1/download`) | Openbaar | Sterren en downloads die ClawHub zelf telt (andere getallen dan GitHub-sterren; de kaart zegt "op ClawHub"), licentie zoals ClawHub die noemt |
| GitHub-API | Alleen (fallback) de bestandsboom van repositories die te groot zijn voor een archief | 60 per uur; optioneel token in de kluis | — |
| Officieel MCP-register | `registry.modelcontextprotocol.io` API **v0.1** (`/servers`, `/servers/{naam}/versions/{versie}`) | Openbaar | Licentie van het pakket via npm/PyPI-metadata waar bekend |

Niet gebruikt (nagegaan op 2026-11-12): Smithery (de lijst werkt, zoeken op woorden geeft HTTP 500), LobeHub (401, vraagt
een account), agentskills.io (alleen de specificatie, geen bibliotheek).

**Sorteren** (het scherm zegt onder de keuze wat de volgorde betekent):

- *Meeste sterren*: GitHub op sterren; skills.sh op installaties; ClawHub op zijn eigen sterren. Drie secties, want de
  getallen zijn niet te vergelijken.
- *Trending*: GitHub heeft geen openbare lijst van sterren per dag, dus: de meeste sterren onder repositories die in de
  laatste 30 dagen zijn aangemaakt. skills.sh: de meeste installaties in de laatste 24 uur. ClawHub: zijn eigen
  trending-volgorde (bij zoeken op woorden: de meeste installaties in 60 dagen).
- *Nieuwste*: GitHub kan repositories niet op aanmaakdatum sorteren, dus: van wat deze week is aangemaakt de 100 met de
  meeste sterren, nieuwste eerst; samen met het nieuwste van ClawHub in één lijst op datum.
- *Laatst bijgewerkt*: GitHub en ClawHub in één lijst op datum.

**Toevoegen** is één klik en dezelfde route als de catalogus (`POST /api/skills/curated/install`), met als id
`github/<eigenaar>/<repo>[/<map of skillnaam>]` of `clawhub/<eigenaar>/<skill>`. Dezelfde importregels en scan, scripts
uit tot de eigenaar de skill vertrouwt, en de versie van dat moment wordt vastgelegd: bij GitHub de commit waar `HEAD`
naar wijst, bij ClawHub het versienummer. Een repository met één skill voegt die toe; met meer skills kiest de gebruiker
er een (`GET /api/skills/web/repo`). Ernstige bevindingen van de scan, een uitgever die op een bekende naam lijkt of een
waarschuwing van ClawHub zelf maken van de klik een bevestiging die ze toont. Een licentie wordt getoond als die bekend
is; het ontbreken ervan houdt toevoegen niet tegen (net als bij *Toevoegen via link*). Staat dezelfde map in de
gecontroleerde catalogus, dan wordt die versie toegevoegd.

**Bijwerken**: *Controleer op updates* vergelijkt de vastgelegde bestanden met de nieuwste commit of versie bij de bron;
een verschil is een melding met het verschil per bestand (`GET /api/skills/curated/diff`), en pas na een klik wordt er
bijgewerkt (`POST /api/skills/curated/update`). Bron in de bibliotheek: `catalog_ref = curated/github/…` of
`curated/clawhub/…`, met `source.commit` als de vastgelegde commit of versie.

**Limiet**: resultaten blijven een uur in de cache (laatst bijgewerkt, en het nieuwste van ClawHub, tien minuten). Geeft GitHub aan dat de
zoeklimiet bereikt is, dan zegt TeamBot rustig wanneer het weer kan; wat al gezien is, skills.sh, ClawHub, de
gecontroleerde catalogus en toevoegen werken door. De zoeklimiet en de uurlimiet van de rest van de GitHub-API worden
apart bijgehouden.

**Bots** krijgen hetzelfde: `skill_find` noemt na de skills van het team en de gecontroleerde catalogus ook wat openbaar
is (gemarkeerd als niet gecontroleerd), en `skill_install` voegt daaruit toe met dezelfde controles; wat de eigenaar
moet bevestigen, voegt een bot niet toe.

**Wat de pc verlaat**: alleen de zoekwoorden (van de gebruiker of van een bot) gaan naar GitHub, skills.sh en ClawHub;
dat staat op *Instellingen › Wat verlaat je pc?*. Met `TEAMBOT_OFFLINE=1` gaat er niets uit.

Het register heeft geen categorieën of populariteit. "Aanbevolen" is een met de hand gekozen lijst van 49 servernamen
(`FEATURED` in `registry.ts`; alle gegevens komen live uit het register), zodat er zonder zoeken ruim 40 apps staan.
Gekozen (2026-11-07) op een duidelijke licentie: de eigen gehoste server van de dienst zelf (hun voorwaarden; bijv.
Notion, Linear, Atlassian, Stripe, GitHub, Figma) of een open-sourcepakket onder MIT, Apache-2.0, MPL-2.0 of GPL
(nagekeken op npm/PyPI/GitHub). Elke kaart heeft het pictogram van de uitgever of anders een eigen monogram. Zoeken
gebruikt de zoekfunctie van het register (substring van de servernaam, minstens 3 tekens) met paginering. Categorieën
zijn TeamBot's eigen trefwoordindeling (`categorize` in `licenses.ts`) en worden als zodanig getoond.

## Licenties (skills)

Volgorde: licentiebestand in de skillmap → `license` in SKILL.md → licentiebestand in de hoofdmap van de repository →
licentie volgens de GitHub-API. Alleen **open** licenties (MIT, Apache-2.0, BSD, ISC, MPL-2.0, CC0, CC-BY(-SA), (L/A)GPL, …)
zijn installeerbaar vanaf internet. **Beperkend** (proprietary, "all rights reserved", source-available, BUSL, Elastic,
SSPL, PolyForm, niet-commercieel/geen afgeleiden, "governed by … terms") en **onbekend** (geen licentie = alle rechten
voorbehouden) worden getoond maar niet geïnstalleerd; de server weigert met 403, ook als de browser het toch vraagt.
Herkenning is bewust behoudend: onbekende tekst is nooit "open".

## Cache, limieten en offline

- Alles gaat via `WebCache` (`<datamap>/cache/market-skills` en `<datamap>/cache/mcp-registry`): per sleutel een TTL,
  ETag-hervalidatie waar de server dat ondersteunt, en bij netwerkfouten, limieten of offline een verouderde kopie
  (`stale`), die de UI ook zo toont. Maximaal 400 MB, oudste eerst opgeruimd.
- TTL's: commit van een repository 1 uur; archief per commit 30 dagen (onveranderlijk); GitHub-repositorygegevens 24 uur;
  zoekresultaten van GitHub, skills.sh en ClawHub 1 uur (laatst bijgewerkt, en het nieuwste van ClawHub, 10 minuten); een versie van een ClawHub-skill 1 jaar; registerlijst/`latest` 1 uur; exacte registerversie 30 dagen; npm/PyPI-licentie 7 dagen.
- Een host die 429 of `x-ratelimit-remaining: 0` geeft, wordt tot de reset met rust gelaten. Zoeken op GitHub heeft een
  eigen limiet (`limitKey`), los van de rest van de GitHub-API.
- `TEAMBOT_OFFLINE=1` (of `TEAMBOT_MARKET_OFFLINE=1`): nooit netwerk, alleen cache.
- Optioneel GitHub-token (Marktplaats › Bronnen) als geheim `market:github-token` in de kluis, of `TEAMBOT_GITHUB_TOKEN`
  voor een server. Het token gaat alleen naar `api.github.com` (de fetcher stuurt `Authorization` nooit mee naar een
  andere host, ook niet na een doorverwijzing).

## Veiligheid

- Downloads lopen via de bestaande SSRF-veilige fetcher (elke hop gecontroleerd), met groottelimieten (archief 25 MB,
  JSON 8 MB, bestand 5 MB, skill 10 MB/200 bestanden).
- Repositoryarchieven worden "lenient" gelezen: symbolische koppelingen, onveilige paden, te grote of verdacht
  gecomprimeerde items worden overgeslagen en nooit uitgepakt; alleen de skillmappen en licentiebestanden worden
  uitgepakt. Uploads blijven strikt.
- Niets wordt uitgevoerd tijdens bekijken: SKILL.md, bestanden, scan en rechten zijn alleen-lezen. Installeren gaat
  door de bestaande importer (scan op prompt-injectie/geheimen/scripts, rechtenverschil, uitgeversbeleid, bevestiging bij
  gevaar, inschakelen per bot). Scripts blijven geblokkeerd tot de eigenaar de skill vertrouwt.
- Registerrecords zijn onvertrouwde invoer: naam, pakketnaam, versie, argumenten en URL's worden streng gecontroleerd
  (geen argument-injectie via pakketnamen, geen eigen npm/PyPI-register, alleen https, geen regeleinden). Het sjabloon
  wordt op de server opnieuw uit het (gecachte) record gebouwd; opdracht, argumenten en adres zijn vastgezet op het
  register, de browser kan ze bij installeren niet veranderen. Geheimen gaan nooit op de opdrachtregel: `docker -e
  NAAM={geheim}` wordt `-e NAAM` met een omgevingsvariabele uit de kluis; een verplicht geheim argument maakt die vorm
  onbruikbaar. URL-variabelen worden gecodeerd (kunnen de host niet veranderen).
- Verder gelden alle regels van de MCP-module: stdio start pas na "Ik vertrouw deze opdracht", leestest vóór acties,
  risico's per tool, acties uit tot de eigenaar ze aanzet. Registerrecords zijn niet ondertekend; het uitgeversbeleid
  behandelt ze zo (strikt beleid vraagt een vastgelegde uitzondering of blokkeert leden).
- Bij een remote server zonder opgegeven inlog vraagt TeamBot de server — zonder gegevens — of hij om OAuth vraagt
  (`probeUrl`), pas nadat de eigenaar op "Koppelen…" klikt.
- Melden en blokkeren werken ook voor internetitems (catalogus `github` met item `eigenaar/repo/pad`, en `mcp-registry`
  met de servernaam).
- App-pictogrammen laadt de browser nooit bij de uitgever (dat zou het IP-adres van de kijker verraden): kaarten krijgen
  `/api/mcp/registry/icon?name=…&v=…` en de server haalt alleen de pictogram-URL uit het eigen registerrecord op, via
  dezelfde downloader (SSRF-controle per doorverwijzing, time-out), max. 256 kB, gecachet (7 dagen, `icon:<url>` in
  `cache/mcp-registry`). Alleen PNG/JPEG/WebP op basis van de bestandskop (niet het content-type van de uitgever) en
  max. 2048 px per zijde; anders, bij een fout, offline of een geblokkeerde app een eigen neutraal pictogram (SVG,
  `x-teambot-icon: fallback`), en die URL wordt een uur niet opnieuw geprobeerd. Alleen voor ingelogde gebruikers.

## Installeren, bijwerken, verwijderen

- **Catalogusskill**: *Toevoegen* op de kaart of in het detail → *Voor wie?* (hele team of één bot) → `POST /api/skills/curated/install` met `teamId` en `enableFor` (staat de skill er al, dan zet de pagina hem aan met `PUT /api/skills/agents/:id`; zonder bevindingen
  direct geïnstalleerd, anders de gewone review). Bijwerken: *Controleer op nieuwe versies* → *Nieuwe versie: bekijk
  verschil* (`GET /api/skills/curated/diff`) → *Bijwerken* (`POST /api/skills/curated/update`). Bron:
  `catalog_ref = curated/<bron-id>/<pad>`. Verwijderen: `DELETE /api/skills/:id`.
- **Skill uit Open** (GitHub of ClawHub): *Toevoegen* op de kaart → `POST /api/skills/curated/install` met het id van
  het resultaat; zie "Open: alles wat openbaar is" hierboven. Bijwerken en verwijderen als een catalogusskill.
- **Skill van internet uit 0.3** (`catalog_ref = github/<eigenaar>/<repo>/<pad>`, zonder vastgelegde commit): de
  update-melding blijft werken (`POST /api/skills/web/check-updates` vergelijkt met `HEAD`); de link opent de pagina van
  de skill, en toevoegen daar zet hem om naar een vastgelegde commit.
- **App**: detail → installatievorm kiezen (remote HTTP/SSE, npm via `npx`, PyPI via `uvx`, OCI via `docker`, NuGet via
  `dnx`; MCPB, Cargo en pakketten met een eigen lokale webserver worden nog niet ondersteund) → `POST
  /api/mcp/registry/entry` → de bestaande wizard (sleutels naar de kluis, bots, vertrouwen, leestest, acties) →
  `POST /api/mcp/connections` met `registry: { name, version, option, inputs, auth }`. Update: `POST
  /api/mcp/registry/check-updates` en `POST /api/mcp/connections/:id/registry-update` (zet opdracht/adres op de nieuwe
  versie; vertrouwen, leestest en acties beginnen opnieuw). Verwijderen: `DELETE /api/mcp/connections/:id`.

## API

Lijsten geven naast `items` ook `pending` (nog nooit opgehaald, loopt), `refreshing` (uit de cache, wordt gecontroleerd),
`starter`/`starterTotal` (TeamBot-items zolang er niets van internet is) en `offline`; `budget` (ms, max. 20 000) en
`early=1` regelen hoe lang de server wacht.
Skills (`/api/skills/web/…`): `GET search?q&sort&page&teamId&only` (`sort` = `stars`, `trending`, `new`, `updated`;
antwoord: `checked`, `github`, `directory`, `clawhub`, `limit`, `offline`), `GET repo?repo&teamId` (de skills in één
repository), `GET sources` (limieten, of er een token is), `POST check-updates` (skills van internet uit 0.3),
`PUT/DELETE github-token`. Toevoegen, de pagina van een skill, verschil en bijwerken: `/api/skills/curated/…`.
Apps (`/api/mcp/registry/…`): `GET servers?q&category&cursor&budget&early`, `GET server?name&version`, `GET icon?name&v`,
`POST entry`, `POST check-updates`; `POST /api/mcp/connections/:id/registry-update`.

## Beperkingen

- Het register zoekt alleen op servernaam; beschrijvingen worden niet doorzocht. Populariteit kent het register niet.
- Installatie-aantallen van skills.sh zijn hun eigen telling (en deels te beïnvloeden); TeamBot toont ze als indicatie.
- Zeer grote repositories (archief > 25 MB) gebruiken de GitHub-boom-API plus losse bestanden; zonder token kost dat
  API-verzoeken en zijn beschrijving en licentie pas bekend na openen.
- MCPB-bundels, Cargo en pakketten die zelf een lokale webserver starten worden niet ondersteund.
- De lijst met aanbevolen servers is met de hand gekozen en moet af en toe worden nagelopen.
- Een ClawHub-skill is vastgelegd op het versienummer dat ClawHub geeft; of ClawHub een bestaande versie laat
  overschrijven is niet nagegaan. Een commit op GitHub kan niet veranderen.
- GitHub laat zonder account alleen repositories zoeken, geen bestanden: een map met een `SKILL.md` in een repository
  zonder het topic of het woord "skill" wordt alleen gevonden via skills.sh of met *Toevoegen via link*.
