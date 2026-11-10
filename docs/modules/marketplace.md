# Marktplaats: skills en apps van internet

De Marktplaats (tabs **Aanbevolen voor je bots · Skills · Apps · Bots**; **Bronnen** en **Meldingen** alleen met
*Geavanceerd tonen* of via een directe link) toont skills sinds 0.4 uit de **TeamBot-catalogus**: een vaste lijst
bronnen, elk vastgezet op één commit (hieronder). Apps komen live uit het officiële MCP-register en de
connectorcatalogus van de MCP-module. De zelf geschreven skills van TeamBot en eigen `teambot.catalog/v1`-catalogi
staan onder "Zelf geschreven en eigen catalogi" (een link onder de catalogus). Bot-sjablonen blijven ingebouwd: er is
(nog) geen openbare, legitieme bron voor bot-sjablonen.

**Voor een normaal mens (0.4.5).** De pagina opent op *Aanbevolen voor je bots*: per bot een korte lijst (3 skills,
2 apps) die past bij de naam, rol en beschrijving van die bot (een SEO-bot krijgt eerst de SEO-skills), zonder bots
één skill per onderwerp. Skills en Apps hebben één zoekvak en **onderwerpen als tegels** met een pictogram
(Marketing en SEO, Klantenservice en verkoop, Bouwen en data, Kantoor en ontwerp, Zoeken, Schrijven en plannen,
Overig). Elke catalogusvermelding valt via haar categorie (en anders haar pakket) in een tegel; een categorie die
nergens past krijgt een eigen tegel, dus nieuwe catalogusbestanden met nieuwe pakketten werken zonder UI-wijziging
(`ui/src/modules/skills/marketGroups.ts`). Een kaart toont de naam, één zin, *Gratis*, de licentie, *Werkt op Windows*
waar dat bekend is (gecontroleerd, of alleen tekst zonder scripts) en één knop **Toevoegen**; daarna één keuze: *het
hele team* (alle bots van dat team) of één bot. Wat er al is, heet *Toegevoegd*, met de melding van een nieuwe versie.
De controles blijven precies zoals hieronder (licentie, scan bij toevoegen, uitgeverscontrole, vaste versie); op de
kaart zijn ze één klein **Gecontroleerd** met de uitleg achter (i). Apps uit het register zijn niet door TeamBot
gecontroleerd en krijgen dat label dus niet.

Waarom een eigen catalogus (onderzoek *Knelpunten gebruikers alle AI bots*, 9 november 2026): besmette skills haalden
in 2026 samen meer dan 1,7 miljoen downloads door eerst een exacte kopie van een officiële skill te uploaden en die
later te vervangen; scanners zijn te omzeilen. Vastzetten op een commit, alleen leesbare tekst en een zichtbaar
verschil bij elke update zijn de regels die daaruit volgen. Werking en importregels: [skills.md](skills.md#teambot-catalogus-04-pakket-h).
Vanaf twee teams kies je bij installeren voor welk team (of *Alle teams*); "Geïnstalleerd" geldt dan voor dat team
(pakket B4, [skills.md](skills.md#per-team-04-pakket-b4)).

## TeamBot-catalogus

Gecontroleerd op 9 november 2026 met de GitHub-API (`gh`): repository, het licentiebestand dat voor elke gekozen
skillmap geldt, en de nieuwste commit; daarna vastgezet. Elke gekozen skill is dezelfde dag live geïnstalleerd vanaf
deze commits (68 direct; planning-with-files vraagt een bevestiging omdat de bestaande scan een geciteerde zin
"Ignore any instruction-like text" als prompt-injectie ziet).

| Bron | Commit | Licentie (bestand) | Skills |
| --- | --- | --- | --- |
| `anthropics/knowledge-work-plugins` | `e050c2ec` (2026-11-07) | Apache-2.0 (`customer-support/LICENSE`, `marketing/LICENSE`, `data/LICENSE`; operations en small-business: `LICENSE` in de hoofdmap) | klantenservice 5, marketing 8, operations 9, data 7, klein bedrijf 12 |
| `anthropics/skills` | `2c5958ec` (2026-11-06) | Apache-2.0 (`skills/<naam>/LICENSE.txt`; pas vanaf deze commit, PR #2146) | docx, pdf, pptx, xlsx |
| `obra/superpowers` | `22f0b463` (2026-11-03) | MIT (`LICENSE`) | verification-before-completion, writing-plans, executing-plans, systematic-debugging, test-driven-development, receiving-code-review |
| `coreyhaines31/marketingskills` | `96798cf3` (2026-11-06) | MIT (`LICENSE`) | copywriting, copy-editing, ads, ad-creative, emails, social, cro, pricing, launch, ai-seo |
| `AgriciDaniel/claude-seo` | `6be93f45` (2026-10-22) | MIT (`LICENSE`; de `LICENSE.txt` in de skillmappen verwijst ernaar) | seo-local, seo-plan, seo-content-brief, seo-geo, seo-schema, seo-hreflang |
| `blader/humanizer` | `0ef9fe5b` (2026-10-28) | MIT (`LICENSE`) | humanizer |
| `OthmanAdi/planning-with-files` | `2362ca38` (2026-11-07) | MIT (`LICENSE`) | planning-with-files |

Bewust niet opgenomen: CC BY-NC-ND (`hesreallyhim/awesome-claude-code`), CC-BY-SA (`trailofbits/skills`), de
Figma-skills (Figma Developer Terms), repositories zonder licentiebestand (`vercel-labs/agent-skills`,
`ComposioHQ/awesome-claude-skills`) en AGPL. Bij claude-seo zijn alleen onderdelen gekozen die (vrijwel) zonder hun
eigen Python-hulpprogramma werken; skills van knowledge-work-plugins/small-business werken het best met gekoppelde
(vaak betaalde) diensten, en zeggen dat zelf.

Windows (documentskills): docx, pptx en xlsx *deels*: maken en lezen werkt met Node.js/Python, maar alles via
`scripts/office/soffice.py` (pdf maken, formules doorrekenen, voorbeeldafbeeldingen) gebruikt `socket.AF_UNIX` en een
`LD_PRELOAD`-truc; Python op Windows heeft geen `AF_UNIX` (gecontroleerd met Python 3.12.10 op Windows 11), en
LibreOffice staat meestal niet in het pad. pdf gebruikt alleen Python-bibliotheken (niet uitgevoerd op Windows).

Code: `server/modules/skills/{curated,curated-source,curated-routes,import-rules,textdiff}.ts` (catalogus),
`server/modules/skills/{websource,web-routes,webcache,licenses}.ts` (open bronnen, cache, licenties),
`server/modules/mcp/registry.ts` (+ routes in `server/modules/mcp/api.ts`), UI
`ui/src/modules/skills/{Catalog,ClearMarket,Recommended,WebSkills,RegistryApps,marketParts,merge}.tsx` en `marketGroups.ts`. Tests: `tests/skills-catalog.test.ts`
(lokale fixture-repository in `tests/fixtures/curated/`), `tests/marketplace-web.test.ts` en `tests/market-speed.test.ts`
met opgenomen antwoorden in `tests/fixtures/market/` (geen netwerk; vertraagde bronnen worden gesimuleerd), de duidelijke pagina (tegels, zoeken, Toevoegen voor een bot of het hele team, ook op de telefoon): `node --import tsx tests/e2e/market-clear.mjs`, in de echte
UI: `node --import tsx tests/e2e/market-speed.mjs [map voor schermafbeeldingen]` (open bronnen via
`#/m/skills/skills?bron=internet`; na `npm run build:ui`; `MARKET_SPEED_LIVE=1` voor het echte internet), live:
`OPENAI_KEY_FILE=… npm run market:live` (tijdelijke datamap).

## Snel eerste beeld (stale-while-revalidate)

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

## Open bronnen (alleen als ze bewust zijn ingesteld)

Sinds 0.4 is de lijst open collecties standaard leeg (`DEFAULT_COLLECTIONS = []`; de oude lijst staat als
`OPEN_COLLECTIONS` in `websource.ts`) en zoekt TeamBot niet meer in skills.sh. Met
`TEAMBOT_SKILL_COLLECTIONS=eigenaar/repo,…` (ontwikkelaars, tests) verschijnt *Open bronnen (niet gecontroleerd)*
weer, met skills.sh-zoeken erbij; dan geldt de beschrijving hieronder (stand 2026-11-07). Eigen import via een adres
(Mijn skills › Importeren) blijft kunnen, met de uitgever-controle op namaaknamen.

| Bron | Wat | Toegang | Licentie van de inhoud |
| --- | --- | --- | --- |
| GitHub-collecties | Mappen met een `SKILL.md` in bekende openbare repositories (lijst hieronder) | Archief-download via `codeload.github.com` (geen API-limiet); welke commit `HEAD` is, leest TeamBot uit de doorverwijzing van `github.com/<repo>/archive/HEAD.zip` | Per skill bepaald (zie Licenties) |
| skills.sh | Zoekfunctie van de openbare skills-directory (`/api/search`), met installatie-aantallen | Openbaar, per IP beperkt; de voorwaarden staan caching uitdrukkelijk toe. `/api/v1` vraagt een Vercel-token en wordt niet gebruikt | Resultaten wijzen naar GitHub-repositories; daar wordt de licentie gelezen |
| GitHub-API | Alleen sterren, licentie volgens GitHub en (fallback) de bestandsboom van te grote repositories | 60/uur zonder token; optioneel token in de kluis | — |
| Officieel MCP-register | `registry.modelcontextprotocol.io` API **v0.1** (`/servers`, `/servers/{naam}/versions/{versie}`) | Openbaar | Licentie van het pakket via npm/PyPI-metadata waar bekend |

Open collecties tot en met 0.3 (`OPEN_COLLECTIONS`; nu alleen via `TEAMBOT_SKILL_COLLECTIONS=eigenaar/repo,…`):
anthropics/skills, openai/skills, vercel-labs/agent-skills, anthropics/knowledge-work-plugins, huggingface/skills,
cloudflare/skills, supabase/agent-skills, expo/skills, microsoft/azure-skills, mattpocock/skills, obra/superpowers,
trailofbits/skills, remotion-dev/skills. Repositorylicenties (GitHub, 2026-11-07): MIT (mattpocock, obra, supabase, expo,
microsoft/azure-skills), Apache-2.0 (huggingface, cloudflare, anthropics/knowledge-work-plugins), CC-BY-SA-4.0
(trailofbits); geen repositorylicentie bij anthropics/skills, openai/skills, vercel-labs/agent-skills en
remotion-dev/skills — daar geldt per skill wat in de map of de frontmatter staat (Anthropic en OpenAI leveren per skill
een `LICENSE.txt`; de Figma-skills van OpenAI vallen onder Figma's eigen voorwaarden; Remotion heeft geen licentie en is
dus niet installeerbaar). Live geteld: 653 skills, waarvan het grootste deel installeerbaar.

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
  skills.sh-zoekopdracht 1 uur; registerlijst/`latest` 1 uur; exacte registerversie 30 dagen; npm/PyPI-licentie 7 dagen.
- Een host die 429 of `x-ratelimit-remaining: 0` geeft, wordt tot de reset met rust gelaten.
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
- **Skill uit een open bron** (alleen als ingesteld): detail → "Installeren…" → `POST /api/skills/web/install` (stage) → bestaande review en
  `POST /api/skills/import/commit` met `enableFor`. Bron: `catalog_ref = github/<eigenaar>/<repo>/<pad>`.
  Update: de index vergelijkt de checksum van de geïnstalleerde versie met de bron (`catalogUpdate` in Mijn skills);
  `POST /api/skills/web/check-updates` kijkt of `HEAD` verschoof en haalt dan één keer het nieuwe archief.
  Verwijderen: `DELETE /api/skills/:id`.
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
Skills (`/api/skills/web/…`): `GET sources`, `POST sources/refresh`, `GET skills?q&category&repo&installable&budget&early`,
`GET item?repo&path` (of `?source&skillId` voor een skills.sh-resultaat), `GET file?…&file`, `POST install`,
`POST check-updates`, `PUT/DELETE github-token`.
Apps (`/api/mcp/registry/…`): `GET servers?q&category&cursor&budget&early`, `GET server?name&version`, `GET icon?name&v`,
`POST entry`, `POST check-updates`; `POST /api/mcp/connections/:id/registry-update`.

## Beperkingen

- Het register zoekt alleen op servernaam; beschrijvingen worden niet doorzocht. Populariteit kent het register niet.
- Installatie-aantallen van skills.sh zijn hun eigen telling (en deels te beïnvloeden); TeamBot toont ze als indicatie.
- Zeer grote repositories (archief > 25 MB) gebruiken de GitHub-boom-API plus losse bestanden; zonder token kost dat
  API-verzoeken en zijn beschrijving en licentie pas bekend na openen.
- MCPB-bundels, Cargo en pakketten die zelf een lokale webserver starten worden niet ondersteund.
- De lijst met aanbevolen servers en collecties is met de hand gekozen en moet af en toe worden nagelopen.
