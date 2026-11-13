# Module `skills` — Skills & marktplaats

Gebouwd door een subagent, afgerond en samengevoegd door de hoofdsessie (2026-11-06). Plan: §3 (marketplace-datamodel,
install flow), §12, §21.6, §21.1 (sjablonen). Uitgevershandtekeningen, beleid en developer-SDK: EXT-06 (zie
`docs/SDK.md`).

## Skills

- **Formaat**: compatibel met `SKILL.md`, dus YAML-frontmatter plus instructies plus eventuele extra bestanden in de
  skillmap.
  - Frontmatter: `name`, `description`, optioneel `license`, `version`, `allowed-tools`, `metadata`.
  - Opslag per gebruiker in de datamap, met versiegeschiedenis en sha256-checksum.
  - Optioneel een ondertekend **pakket**: `teambot-package.json` naast `SKILL.md` (zie *Uitgevers en handtekeningen*).
- **Importeren**:
  - map, `.zip` (zip-slip-veilig, groottelimiet), plakken;
  - URL, ook een GitHub-map (met SSRF-bescherming);
  - ontdekken in `~/.claude/skills`, `~/.agents/skills` en `~/.codex/skills`.
  - Altijd eerst een preview, dan pas overnemen. De preview toont ook de handtekening en wat het uitgeversbeleid zegt.
- **Veiligheidsscan** bij import en update. De scan zoekt:
  - prompt-injectie ("negeer eerdere instructies");
  - exfiltratiepatronen, secrets, verborgen tekens;
  - externe adressen en uitvoerbare bestanden.

  Resultaat: waarschuwingen plus een label. Prompt-only skills zijn gescheiden van skills met scripts. Scripts worden
  nooit automatisch uitgevoerd ("scripts: uit"): eerst expliciet *vertrouwen* (gebonden aan de checksum van de
  scripts), en daarna vraagt `skill_run_script` bij **elke** uitvoering toestemming, ook onder *Volledige toegang*. Een
  update kan rechten nooit stil verhogen; je ziet een rechten-diff. Een handtekening verandert niets aan deze regels:
  ze komen er bovenop.
- **Uitgever-controle**: bij een import van GitHub (adres of marktplaats) wordt de eigenaar van de repository vergeleken
  met bekende organisaties (`KNOWN_PUBLISHERS` in `import-rules.ts`). Een namaaknaam (`browser-use-headless`,
  `getpaperclipai`, `anthropic` i.p.v. `anthropics`, of `101-skills/superpowers` met de repositorynaam van een ander)
  komt als waarschuwing in de preview en moet expliciet worden bevestigd (`needs-acknowledge`).
- **Installatiebereik**: een skill is geïnstalleerd voor **één team** of **voor alle teams** (zie *Per team*).
- **Gebruik door bots**: een geïnstalleerde skill is er meteen voor **alle bots van het team**. Eén regel beslist wat
  een bot heeft (`SkillLibrary.enabledFor`): de actieve skills van zijn team, min wat bij die bot is weggehaald. De
  prompt, `skill_load`, het `/`-menu, de schermen en de mappen in de werkmap lezen die ene regel. De lijst per bot
  (`agent.skills`) is wat de schermen tonen en bewerken: wat de bot heeft komt er vanzelf op (`defaults.ts`,
  `skill_offers`), en een skill die erop stond en eraf is, is bij die bot **weggehaald** (ook als het zijn laatste was;
  een lege lijst betekent niet meer "alles"). Laadt een skill niet, dan zegt de melding waarom en wat het oplost
  (weggehaald, staat uit, is nog een concept, bestaat niet).
- **In de werkmap, waar de engine zelf zoekt** (`workspace.ts`): de skills van een bot staan als echte skillmappen in
  `<werkmap>/.claude/skills/<naam>/` en `<werkmap>/.agents/skills/<naam>/`. Eén functie (`sync`) schrijft ze, op de
  punten waar het antwoord verandert (elke schrijfactie van de bibliotheek, een bot die gemaakt, gewijzigd of verplaatst
  wordt) en vlak voor een CLI-run. Alleen in een werkmap die TeamBot zelf voor de bot maakte: in een map van de
  eigenaar of van een ander programma schrijft TeamBot niets. Per plek zegt `.teambot-skills.json` wat TeamBot schreef
  (met een controlegetal per bestand); een map die de eigenaar zelf maakte of aanpaste blijft staan en hij hoort het
  één keer. Scripts staan er alleen van een vertrouwde skill van het eigen team. De SKILL.md die een engine leest heeft
  alleen naam en beschrijving in de kop (geen `allowed-tools`, hooks of ander model) en geen regel die een engine bij
  het laden zou uitvoeren; de bibliotheek bewaart de skill zoals hij binnenkwam.
- **Per engine**: Claude Code laadt de mappen zelf (naam en beschrijving eerst, de tekst bij gebruik). Zo'n bot krijgt
  geen lijst van TeamBot en geen `skill_load`; in de beperkte modus (die de werkmap overslaat) en in een werkmap die
  niet van TeamBot is gaan dezelfde skills mee als plugin-map van TeamBot (`--plugin-dir`). Getoond met echte runs
  (`tests/e2e/skills-live.mjs ask|full`). Elke andere route (model via API-sleutel, lokaal model, Codex, OpenCode en
  andere ACP-agents, Claude Code in alleen-lezen of een versie zonder `--plugin-dir`) houdt de lijst in de prompt
  (naam en beschrijving, stabiel en gesorteerd, hooguit 80) plus `skill_load`. Gebruik wordt op één plek geteld
  (`SkillLibrary.used`), ook als Claude Code de skill zelf laadt.
- **Bots maken en verbeteren zelf skills** (`skill_save`): meteen actief voor het
  team, en dezelfde naam is een nieuwe versie van de eigen skill van het team (de vorige blijft bewaard). Alleen een
  skill die geld uitgeeft of zelf berichten aan klanten stuurt, of waar de scan iets ernstigs in vindt, wordt een
  concept dat op de eigenaar wacht (`ownerFirst` in `tools.ts`). Een skill uit de catalogus of van GitHub overschrijft
  een bot niet; die houdt zijn eigen updates.
- **Bots zoeken en voegen toe** (`skill_find`, `skill_install`): in wat het team heeft en in de TeamBot-catalogus (met
  sterren), of vanaf een adres op GitHub. Scripts blijven uit tot de eigenaar de skill vertrouwt, en een skill met een
  ernstige scanbevinding of een namaak-uitgever voegt een bot niet toe (de eigenaar ziet die eerst).
- **Kiezen in het invoerveld** (`/` aan het begin van een regel, `$` overal na een spatie): een menu met de skills van de
  bot (in een groep: van alle bots, met hun naam) en bij `/` ook opdrachten (Nieuw gesprek, Zoeken in dit gesprek,
  Stoppen, Bestand toevoegen, Skills beheren). Zoeken op naam en beschrijving, pijltjes + Enter/Tab of tikken, Esc
  sluit. De gekozen skill blijft als `/naam` of `$naam` in het bericht; `menu.ts` voegt voor die beurt toe dat de bot
  hem eerst laadt en volgt (ook bij CLI-engines: de beurtcontext gaat mee in het bericht). Een skill die de bot niet
  heeft, of "3/4" en "$5", doen niets. `GET /api/skills/menu?threadId=` (ook voor een gekoppelde telefoon, alleen naam
  en beschrijving). Tests: `tests/slash-menu.test.ts` en `tests/e2e/files-chat.mjs`.

  | Tool | Risico | Wat |
  |---|---|---|
  | `skill_load` | read | Volledige instructies van een skill van het team laden. |
  | `skill_read_file` | read | Bijbehorend bestand van een skill van het team lezen. |
  | `skill_find` | read | Zoeken in de skills van het team en in de catalogus. |
  | `skill_install` | write | Een skill uit de catalogus of van een GitHub-adres toevoegen voor het team. |
  | `skill_save` | write | Een eigen werkwijze vastleggen of verbeteren (meteen actief). |
  | `skill_run_script` | danger | Eén script van een *vertrouwde* skill uitvoeren: vraagt altijd toestemming (onder *Volledige toegang* vraagt de tool het zelf), alleen de scripts van die skill, zonder shell (Python, Node.js, PowerShell, bash), vanaf een verse kopie in TeamBots eigen data (`skill-runs/<bot>/<naam>`, dus wat de eigenaar vertrouwt en nooit een bestand dat in een werkmap is aangepast), in de werkmap met een eigen thuis-, temp- en app-datamap (`.skills/.thuis/<naam>`, in de teammap als de bot daar mag schrijven, anders in de werkmap) en zonder sleutels in de omgeving (`safeEnv` plus verwijzingen naar het echte profiel, zoals OneDrive, SSH-agent en cloudconfiguratie). Geen afscherming door het besturingssysteem: een script dat zelf een absoluut pad opent, kan dat nog. Leden op een gedeelde server: alleen als de beheerder de terminal voor leden aanzette (`memberPolicy.allowShell`), net als `run_command`. |

  `skill_load` noemt bij een catalogusskill de herkomst (repository, commit, licentie). Verwijzingen als
  `../../shared/x.md` in een catalogusskill vindt `skill_read_file` in de map `_bron/`.

## Bewaar als skill (0.4.3, pariteit 7.5)

Chatmenu **⋮ › Bewaar als skill…** (`ui/src/modules/skills/SaveAsSkill.tsx`, server `from-chat.ts`):

- `POST /skills/from-chat/draft { threadId, messageId? }`: de eigen engine van de bot (API-chat of het eenmalige
  antwoord van een CLI, zonder tools) schrijft naam, beschrijving en werkwijze uit het gesprek (tot `messageId`); het
  gesprek gaat mee als data tussen `<gesprek>`-tags, geen opdracht. Lukt dat niet, dan een opzet uit het gesprek zelf
  (`ai: false`, met de reden). Er wordt niets opgeslagen.
- `POST /skills/from-chat/save { threadId, agentId, name, description, instructions, scope: 'bot'|'team', acknowledge? }`:
  een gewone SKILL.md (`metadata.saved-from-chat`), via de importer (formaat, scan, uitgeversbeleid) in het team van de
  bot, aan voor die bot of voor alle bots van het team. Een bestaande naam wordt nooit overschreven (409); bij ernstige
  scanwaarschuwingen eerst bevestigen. Bron `chat` (*Bewaard uit een gesprek*), geaudit als `skill.saved_from_chat`.
  Werkt ook vanaf een gekoppelde telefoon. Tests: `tests/skill-from-chat.test.ts`, `tests/e2e/parity-small.mjs` [7.5].

## Maak een skill van dit document (0.4.4)

**Geheugen › Dossiers › (dossier) › Bronnen › Maak een skill** bij een bron met tekst (pdf, Word, geplakte tekst;
`ui/src/modules/skills/FromDocument.tsx`, server `from-document.ts`). Zelfde stroom als *Bewaar als skill*:

- `POST /skills/from-document/draft { sourceId, agentId? }`: de doorzoekbare stukken van de bron (op volgorde, tot
  24.000 tekens; `source.cut` zegt dat er is ingekort) gaan als data tussen `<document>`-tags naar de engine van de bot
  (zonder tools). Zonder bot gekozen: de hoofdbot, anders de eerste bot. Lukt het niet, dan een opzet uit de koppen van
  het document (`ai: false`, met de reden). Er wordt niets opgeslagen. Alleen bronnen uit eigen of gedeelde dossiers.
- `POST /skills/from-document/save { sourceId, agentId, name, description, instructions, scope, acknowledge? }`: via
  `saveDraftSkill` (gedeeld met *Bewaar als skill*: importer, scan, uitgeversbeleid, nooit een bestaande naam
  overschrijven). Bron `document` (*Gemaakt van een document*), `metadata.made-from-document`, audit
  `skill.made_from_document`.

## Skills testen met testvragen (0.4.4)

Tabblad **Testen** bij een skill (`ui/src/modules/skills/SkillTests.tsx`, server `tests.ts`), en een blok **Test eerst
deze versie** in **Nieuwe versie: bekijk verschil** (TeamBot-catalogus).

- Per skill 1 tot 5 testvragen (aanbevolen 3–5), elk met een *klaar als* (tabel `skill_tests`).
- Een test draait de vragen op één versie: `active`, `rev:<n>` (een bewaarde versie) of `commit:<sha>` (de nieuwe
  versie uit de catalogus, opgehaald zoals bij het verschil, zonder iets te installeren). Per vraag:
  1. de bot antwoordt op **zijn eigen engine** (nooit de goedkopere controle-engine), met de skilltekst van die versie in
     de systeemprompt en zonder tools (`quickCall` uit `quality/engine.ts`, max. 900 tokens);
  2. de beoordelaar van de kwaliteitsmodule (de controle-engine van de bot, `quickCall`, max. 220 tokens) geeft
     `goed`, `twijfel` of `fout` met één zin; een onduidelijk oordeel is *geen oordeel*.
- **Eerst een schatting**: `GET …/tests/estimate` geeft het aantal aanroepen en tokens, en het bedrag bij een betaald
  model (`estimateCost`), of "binnen je abonnement", "op je eigen computer" of "gratis model"; altijd met *schatting*.
  Zonder `confirm: true` start er niets. De dagbudgetten en de dagelijkse controlelimiet van de kwaliteitsmodule gelden.
- Een test verandert de skill nooit: bijwerken of een versie activeren blijft een eigen klik. Runs lopen op de
  achtergrond (tabel `skill_test_runs`; de pagina vraagt de run op tot hij klaar is, event `skills.tests`). Na
  **Opslaan** van een wijziging in **Instructies** staat er **Test deze versie**.

| Route | Doel |
|---|---|
| `GET /skills/:id/tests` | vragen, de laatste 6 runs, bots om op te testen (eerst de bots die de skill gebruiken) |
| `PUT /skills/:id/tests` | `{ tests: [{ question, doneWhen }] }` vervangt de lijst (max. 5) |
| `GET /skills/:id/tests/estimate?agentId=&target=` | schatting vooraf |
| `POST /skills/:id/tests/run` | `{ agentId, target, confirm: true }`; 409 als er al een test loopt |
| `GET /skills/:id/tests/runs/:runId` | één run met per vraag antwoord, oordeel en reden |

Tests: `tests/skill-tests.test.ts`; UI in `tests/e2e/switch-skills.mjs` en `tests/e2e/phone-owner.mjs`.

## Uitgevers en handtekeningen

- **Pakketten**: skill, bot-sjabloon (`bot.json`) of connector-sjabloon (`connector.json`) met een manifest
  `teambot-package.json`: naam, semver-versie, soort, uitgever met Ed25519-publieke sleutel, compatibel TeamBot-bereik,
  `requires`, SPDX-licentie, sha256 per bestand en een handtekening over de canonieke JSON. Formaat, CLI en voorbeelden:
  `docs/SDK.md`. De cryptografie zit in `packages/teambot-sdk` (ook gebruikt door de CLI); trust, beleid en weergave in
  `server/modules/skills/publishers.ts`.
- **Controle bij import, installatie en update**: handtekening geldig, elk bestand ongewijzigd (geen ontbrekende of extra
  bestanden), compatibel met deze TeamBot-versie en met de beschikbare toolgroepen/modules. Het manifest wordt na de
  controle uit de skillbestanden gehaald en per revisie bewaard (`skill_versions.package`), zodat de skill te delen en te
  downloaden is als het oorspronkelijke ondertekende pakket.
- **Labels** overal waar een pakket verschijnt: *Ondertekend door <uitgever>* (naam uit de vertrouwenslijst), *Vertrouwd:
  TeamBot (ingebouwd)*, *Ondertekend, onbekende uitgever* (met vingerafdruk), *Niet ondertekend*, *Handtekening ongeldig*
  (installatie geweigerd) en *Niet compatibel met deze TeamBot-versie* (installatie geweigerd, met reden).
- **Updates**: een nieuwe versie moet van dezelfde sleutel komen als de geïnstalleerde. Anders (andere sleutel of geen
  handtekening meer): status `needs-publisher-confirmation` tot de eigenaar van de installatie bevestigt
  (`confirmPublisherChange`), geaudit als `package.publisher_changed`. Een zelf bewerkte skill is niet meer ondertekend.
- **Beleid** (`publisherPolicy`, instellingen-tab *Uitgevers en beleid*): `open` (standaard), `signed-only` of
  `allowlist` (vertrouwde uitgevers + ingebouwde items). De server handhaaft het op elk installatiepad. Leden in
  servermodus zijn er altijd aan gebonden en kunnen onder een streng beleid ook geen eigen skills plakken, bewerken of
  concepten publiceren. Eigenaar en beheerder kunnen per installatie een uitzondering bevestigen (`overridePolicy`,
  geaudit als `package.policy_override`). Een ongeldige handtekening of incompatibel pakket kan niemand doorlaten.
- **Vertrouwde uitgevers**: publieke sleutel plakken of *Vertrouw deze uitgever* bij een pakket (alleen eigenaar en
  beheerders); leden zien de lijst en het beleid alleen.

## TeamBot-catalogus (0.4, pakket H)

Sinds 0.4 komen skills alleen uit een **eigen catalogus**: een vaste lijst bronnen, elk vastgezet op één commit. Na
installeren begint TeamBot leeg; niets is vooraf geïnstalleerd en niets is meegeleverd: installeren haalt precies de
vastgezette bestanden op. Code: `curated.ts` (de lijst), `import-rules.ts` (regels, uitgevers),
`curated-source.ts` (ophalen, licentie, verschil), `curated-routes.ts` (dienst en routes), `textdiff.ts`; UI
`Catalog.tsx`. Bronnen, commits en licenties: [marketplace.md](marketplace.md#teambot-catalogus).

- **Ophalen**: de bestandslijst van de repository op de vastgezette commit (GitHub-API, één keer per commit, een jaar
  bewaard) en daarna alleen de bestanden van die skill van `raw.githubusercontent.com`, elk gecontroleerd tegen de
  git-hash in de lijst. De lijst met de catalogus zelf kost geen netwerk.
- **Importregels** (`import-rules.ts`), op de lijst vóór er iets wordt gedownload en daarna op de inhoud:
  - geweigerd (de hele skill is niet te installeren): programma's en gecompileerde code (op extensie én op de eerste
    bytes: MZ, ELF, Mach-O), archieven en containers (zip, tar, 7z, jar, whl, docx/xlsx/pptx …), symbolische koppelingen,
    bestanden groter dan 512 KB, een skill groter dan 4 MB of met meer dan 150 bestanden, en opvulling (meer dan 300 lege
    regels achter elkaar, een regel van meer dan 50.000 tekens, of bijna alleen witruimte);
  - weggelaten en getoond: verborgen bestanden en mappen (`.github/`, `.claude-plugin/` …), hulpmappen
    (`node_modules`, `__pycache__`) en bestanden die geen leesbare UTF-8-tekst zijn (afbeeldingen, lettertypen, pdf);
  - de `description` in SKILL.md wordt één YAML-tekst tussen dubbele aanhalingstekens (met een commentaarregel die de
    wijziging meldt). Een beschrijving met `: ` erin is ongeldige YAML voor strenge lezers; die wordt zo hersteld. De
    rest van het bestand blijft byte voor byte gelijk; na het herschrijven wordt gecontroleerd dat de beschrijving
    dezelfde is.
- **Licentie per map**: het dichtstbijzijnde licentiebestand vanaf de skillmap naar boven tot de hoofdmap; een kort
  verwijsbestand ("MIT License - see repository root LICENSE") telt niet en dan wordt verder gezocht. Het moet de
  licentie van de catalogus zijn (en SKILL.md mag geen andere noemen), anders wordt niets geïnstalleerd. De
  licentietekst gaat mee in de skill (`LICENSE.txt`, of `LICENSE-repo.txt` als de map al een eigen verwijsbestand
  heeft).
- **Bestanden van buiten de map**: Markdown-verwijzingen als `../../shared/rules.md` binnen de opgegeven `root` van de
  bron gaan mee naar `_bron/<pad>` (hoogstens 40, met dezelfde regels). Een verwijzing naar een andere SKILL.md niet:
  dat is een aparte skill.
- **Naam**: een bestaande skill met dezelfde naam uit een andere bron wordt nooit overschreven (409).
- **Installeren** = één knop: zonder bevindingen direct; met iets om te bevestigen (scan *danger*, uitgeversbeleid)
  verschijnt de gewone controle (`CandidatesReview`).
- **Updates**: nooit vanzelf. *Controleer op nieuwe versies* (Marktplaats) of *Controleer op updates* (Mijn skills)
  vergelijkt de git-hashes van alle bestanden die bij installeren zijn bekeken (`source.seen`) met een nieuwere
  commit, zonder iets te downloaden: eerst een nieuwere vastzetting in de catalogus (alleen een vastzetting die TeamBot
  na de installatie uitbracht, `source.catalogCommit`), anders de nieuwste commit bij de bron. Een gevonden verschil
  toont *Nieuwe versie: bekijk verschil*: per bestand de regels erbij en eraf, de rechten, de scan en of het vertrouwen
  van de scripts vervalt. Pas *Bijwerken* maakt een nieuwe revisie; de vorige blijft onder *Versies* staan.
- **Nieuwere vastzetting zonder controle** (0.4.4, PARITEIT 7.3): brengt een TeamBot-update een nieuwere commit in
  `curated.ts` voor een geïnstalleerde skill, dan weet TeamBot dat zonder netwerk (`CuratedCatalog.pinUpdate`: de
  commit en de `catalogCommit` van de geïnstalleerde versie wijken allebei af van de huidige vastzetting). *Update
  beschikbaar* en de melding op de skill staan er dan meteen. Bovenaan **Mijn skills** staat een rustig blok
  *Nieuwe versie in de TeamBot-catalogus* (`PinUpdates.tsx`) met per skill de datum van de nieuwe versie, de zin
  `pinNote` uit de catalogus (wat er veranderde; vul die in bij het verzetten van een vastzetting) en welke bestanden
  van de skill anders zijn. Dat laatste vraagt `GET /skills/curated/pin-updates` één keer aan GitHub (de
  bestandslijst van de nieuwe commit, een jaar bewaard); offline staat de melding er zonder bestanden. Blijkt geen
  bestand van de skill veranderd, dan verdwijnt de melding voor die skill. *Bekijk wat er verandert* opent het
  gewone verschil; pas *Bijwerken* daar werkt de skill bij, met dezelfde controles als installeren.
- **Uitgeversbeleid**: catalogusskills zijn niet ondertekend; onder `signed-only`/`allowlist` vragen ze dus de gewone
  uitzondering.

## Per team (0.4, pakket B4)

Kolommen `skills.install_scope` en `skills.team_id` (migratie `skills-004`); `skills-005` vervangt de unieke index
`skills_user_name (user_id, name)` door `skills_team_name (user_id, install_scope, team_id, name)`. Met één team merkt de
gebruiker niets: alle bots zitten in dat team.

- **Waar een skill hoort** (`SkillLibrary.teamOf`): `install_scope = 'team'` met `team_id` (leeg = het standaardteam), of
  `install_scope = 'user'` = **voor alle teams**. Een naam is uniek per team, en een skill voor alle teams kan niet naast
  een skill met dezelfde naam in een team bestaan (`nameConflict`; installeren geeft dan 409 met waar die al staat).
- **Waar een installatie heen gaat** (`placementFor`): `teamId` in de aanvraag (een team van de eigenaar, of `'*'` = alle
  teams); zonder keuze het standaardteam. Een andere module die de importer aanroept zonder team (de OpenBot-import)
  installeert voor alle teams, zoals vóór 0.4. Een bot-sjabloon zet zijn skills in het team van de nieuwe bot (`teamId`),
  een skill van een bot (`skill_save`) in het team van die bot.
- **Wat een bot mag** (`reach`): skills van zijn eigen team en voor alle teams **gebruiken**; met *meekijken* of
  *aansturen* op een ander team diens skills **lezen** (`skill_load`, `skill_read_file`, de naam in de prompt), maar nooit
  hun scripts uitvoeren (`skill_run_script` geweigerd vóór de toestemmingskaart, `scriptRefusal`; in de werkmap staan ze niet);
  zonder toegang bestaat de skill voor hem niet (`enabledFor` laat hem weg, ook als hij nog in `agent.skills` staat).
  `setAgentSkills` (en `PUT /skills/agents/:id`) neemt geen skill aan die de bot niet mag zien.
- **Scripts**: de eigen thuis-, temp- en app-datamap van een script staat in de teammap van het thuisteam als de bot daar
  mag schrijven (`.skills/.thuis/<naam>`, gedeeld door de bots van dat team), anders in de werkmap zoals voorheen.
- **Lijsten**: `GET /skills?teamId=` en `GET /skills/curated?teamId=` tonen wat één team heeft (zijn eigen skills en die
  voor alle teams); zonder teamId ziet de eigenaar alles, en in de catalogus per skill alle installaties met hun team
  (`installs`). Elke weergave heeft `teamId`, `teamName` en `allTeams`. `GET /skills/agents/:id` geeft alleen skills die de
  bot mag zien, met `readOnly` voor die van een ander team.
- **Verhuizen**: `PATCH /skills/:id { teamId }` (een team, of `'*'` = voor alle teams); geaudit als `skill.team`.
- **Updates per team**: elke installatie wordt apart bijgewerkt (`POST /skills/curated/update` werkt op die ene skill in
  zijn team); `POST /skills/curated/check-updates { teamId }` controleert alleen wat dat team heeft en laat de
  update-meldingen van andere teams staan.
- **Migratie**: alles van vóór B4 hoort bij het standaardteam; een skill die bots van meer teams al gebruikten, wordt bij
  de start *voor alle teams* (`upgradeTeams`), zodat geen bot een skill kwijtraakt.
- **UI**: *Installeren voor: team … / Alle teams* in de catalogus en bij importeren (vanaf twee teams; standaard het team
  van de teamkiezer), het team als badge in Mijn skills, de lijst volgt de teamkiezer, en op de pagina van een skill
  *Voor: team … / Alle teams*. De bot-editor biedt de skills van het team van de bot en die voor alle teams.

## Marktplaats

- **Skills**: standaard de TeamBot-catalogus hierboven. *Zelf geschreven en eigen catalogi* bevat de ingebouwde
  skills van TeamBot en catalogi die de eigenaar zelf toevoegde. Naast *Gecontroleerd* staat **Open**: zoeken en
  sorteren in alles wat openbaar is op GitHub, skills.sh en ClawHub, voor iedereen aan; toevoegen gaat langs dezelfde
  weg als de catalogus en legt de commit of versie van dat moment vast. Zie [marketplace.md](marketplace.md).
- Tabs **Skills**, **Apps** (MCP-register; plus de connectorcatalogus van de MCP-module en connectorpakketten uit
  externe catalogi), **Bots** (sjablonen), **Bronnen** en **Meldingen**. Er zijn zoek-, categorie- en bronfilters en de schakelaar **Alleen
  ondertekend** (`?signed=1`; ingebouwde items tellen mee). Elk item heeft een detailpagina met versie, wijzigingen,
  rechten, licentie, uitgever, het handtekeninglabel en een *geverifieerd*/*niet geverifieerd*-label (door TeamBot
  beoordeeld of niet).
- **Ingebouwde catalogus**: zelf geschreven in het Nederlands, niets gekopieerd. Telt als vertrouwd (uitgever TeamBot).
  - 15 skills: bronnenonderzoek, samenvatten, heldere taal, SEO-analyse, klantvraag beantwoorden, weekplanning, code
    review, bug-onderzoek, transacties categoriseren, socialmediabericht, notulen, zakelijke e-mail, vertalen, feiten
    checken, CSV-analyse.
  - 9 bot-sjablonen: onderzoeker, schrijver, SEO-specialist, klantenservice, planner, codeerhulp, boekhoudhulp,
    socialmediamanager, notulist.
- **Externe catalogi**: een JSON-index `teambot.catalog/v1` met checksums, altijd "niet geverifieerd". Items mogen een
  `manifest` meegeven (skills met `files` of `download`); bots en connectors kunnen een pakket zijn (`manifest` +
  `files` met `bot.json` of `connector.json`, sectie `connectors`). De marktplaats toont dan de uitgever al in de lijst;
  bij installatie wordt alles opnieuw gecontroleerd. Er is versie vastpinnen en terugdraaien.
- **Gedeeld op deze server**: een ondertekende skill wordt met zijn manifest gedeeld, zodat anderen de uitgever zien.
- **Melden en blokkeren**: een gebruiker meldt een item, een beheerder blokkeert het. Een geblokkeerd item is
  onzichtbaar en niet te installeren.
- **Installatieflow**: preview, dan wie het ondertekende, wat er verandert, welke rechten en welke externe adressen, dan
  bot kiezen, dan installeren (met de bevestigingen die beleid, scan of rechten vragen).
- **Bot-sjablonen**: exporteren zonder gesprekken, geheugen, secrets, werkmapbestanden of providersleutels. Importeren
  als JSON-sjabloon of als ondertekend bot-pakket (zip). Een sjabloon installeren maakt een nieuwe bot; de gebruiker kiest
  zelf provider en model. Skills uit een ondertekend bot-pakket tonen "via bot-sjabloon" met die uitgever.

## API (onder `/api/skills`)

| Onderwerp | Routes |
|---|---|
| Bibliotheek | `GET /skills` (`?teamId=`), `GET/PATCH/DELETE /skills/:id` (PATCH ook `teamId`), `GET /skills/:id/file`, `GET /skills/:id/download`, `PUT /skills/:id/content`, `GET /skills/:id/versions/:rev`, `POST /skills/:id/versions/:rev/activate`, `POST /skills/:id/trust`, `POST /skills/:id/publish` |
| Import | `POST /skills/import/preview` (`teamId`), `POST /skills/import/zip` (`?teamId=`), `POST /skills/import/commit` (`teamId`, anders het team van de preview; `overridePolicy`, `confirmPublisherChange`), `GET /skills/discover/dirs` |
| Per bot | `GET/PUT /skills/agents/:agentId` |
| Sjablonen | `GET /skills/templates/export/:agentId`, `POST /skills/templates/preview`, `POST /skills/templates/install` (body `{ template }` of `{ package: { manifest, files } }`, plus `overridePolicy`) |
| Pakketten | `POST /skills/packages/unzip` (zip van een bot- of connectorpakket naar `{ kind, package }`) |
| Uitgevers | `GET /skills/publishers`, `PUT /skills/publishers/policy`, `POST /skills/publishers/trusted`, `DELETE /skills/publishers/trusted/:vingerafdruk` (wijzigen: eigenaar/beheerder) |
| TeamBot-catalogus | `GET /skills/curated` (zonder netwerk; `?teamId=`), `GET /skills/curated/item?id=` (vastgezette versie: bestanden, licentie, weggelaten, scan), `POST /skills/curated/install` (`id`, `teamId`, `enableFor`, `acknowledge`), `POST /skills/curated/check-updates` (`force`, `teamId`), `GET /skills/curated/diff?skillId=&commit=`, `GET /skills/curated/pin-updates` (nieuwere vastzettingen met wat er verandert), `POST /skills/curated/update` (`skillId`, `commit`, `acknowledge`, `confirmPermissions`) |
| Marktplaats | `GET /skills/market/{skills,bots,apps}` (`?signed=1`), detail/preview/install per item, `GET /skills/market/apps/:catalogId/:itemId/package`, `POST /skills/market/apps/:appId/install`, meldingen (`/skills/market/report`, `/reports`), blokkades (`/skills/market/blocks`; ook catalogus `curated`) |
| Catalogi en delen | `POST/PATCH/DELETE /skills/catalogs`, `POST/DELETE /skills/shares` |

Elke weergave van een pakket bevat `signature` (staat, label, uitgever, vingerafdruk, compatibiliteit, fouten); previews
en details ook `policy` (toegestaan, uitzondering nodig of geweigerd, met reden). Commit-statussen naast de bestaande:
`blocked`, `needs-policy-override`, `needs-publisher-confirmation`.

Tabellen: `skills` (+ `package`: uitgever van de actieve revisie; + `install_scope`, `team_id`), `skill_versions` (+ `package`: gecontroleerd manifest; `source` van een catalogusrevisie bevat `repo`, `commit`, `license`, `licenseFile`, `catalogCommit`, `seen`, `dropped`),
`skill_materializations`, `skill_catalogs`, `skill_reports`, `skill_blocks`, `skill_shares`. Instelling
`publisherPolicy` (gebruiker `''`; via `/admin/settings` alleen door de eigenaar te overschrijven).

## Tests

`tests/skills.test.ts` dekt:
- import en frontmatter-parsing;
- zip-slip geblokkeerd;
- injectiescan;
- systeemprompt met alleen ingeschakelde skills;
- `skill_load` alleen voor eigen, ingeschakelde skills;
- scripts niet uitvoerbaar zonder vertrouwen;
- sjabloon-export zonder secrets of gesprekken;
- update met hogere rechten vraagt bevestiging;
- isolatie tussen gebruikers;
- marktplaats met catalogus, installeren, externe catalogus met checksums, melden en blokkeren, en de apps-tab via
  de MCP-catalogus;
- SSRF bij URL-import.

`tests/skills-catalog.test.ts` dekt, met een lokale fixture-repository (`tests/fixtures/curated/acme-skills/v1` en
`v2`, plus in code gemaakte programma's, archieven, een koppeling en opvulling; geen netwerk):
- de importregels, de beschrijving als YAML-tekst (ook herstel van `: `), uitgevers en namaak, de catalogus zelf
  (commits, licenties, bekende uitgevers, geen uitgesloten bronnen, unieke namen, docx eerlijk "Windows: deels");
- leeg beginnen, de lijst zonder netwerk, installeren met licentie, commit en `_bron/`, weggelaten bestanden;
- weigeren van programma's (ook zonder extensie), archieven, koppelingen, opvulling en een beperkende licentie per map;
- een bestaande skill met dezelfde naam blijft staan;
- een gewijzigde bron: eerst het verschil, niets verandert vóór *Bijwerken*; een nieuwere vastzetting in de catalogus;
- scripts: uit na installeren, geweigerd zonder vertrouwen, en daarna altijd een toestemmingsvraag (ook onder
  *Volledige toegang*), uitvoeren in de werkmap met een eigen thuismap en zonder sleutels;
- namaak-uitgever bij een eigen import (`browser-use-headless`) moet bevestigd worden;
- apps: vastgezette versies, GitHub alleen-lezen, bestanden alleen in de werkmap van de gekozen bots.

Per team (pakket B4): `tests/teams-isolation.test.ts` (B's skill lezen met meekijken, nooit zijn scripts; een concept van
bot A blijft in team A; *voor alle teams*; namen per team; de migratie) en `tests/skills-catalog.test.ts` (zonder keuze
het standaardteam).

`tests/publisher-sdk.test.ts` dekt:
- SDK: canonieke JSON, versiebereiken, sleutels, ondertekenen, gewijzigd bestand/manifest, extra bestand;
- ondertekend pakket installeren met de staat onbekend → vertrouwd, downloaden als origineel pakket;
- gewijzigd bestand, gewijzigd manifest en incompatibel bereik geweigerd (ook met uitzondering);
- update door een andere sleutel of zonder handtekening geweigerd tot bevestiging, met audit;
- `signed-only` en `allowlist` server-side voor skills, bot-sjablonen en connectors, met uitzondering voor de eigenaar en
  zonder uitzondering voor een lid op een server;
- externe catalogus met ondertekende skills, bot- en connectorpakketten en het filter "alleen ondertekend";
- CLI `keygen`/`init`/`validate`/`sign`/`verify`/`zip`, en dat een privésleutel nooit in een pakket(zip) belandt.

## Beperkingen

- Een centrale, gehoste marktplaats bestaat niet. De TeamBot-catalogus staat in de code (`curated.ts`); een nieuwere
  vastzetting komt met een nieuwe TeamBot-versie. Externe catalogi zijn eigen JSON-indexen, zonder review door ons.
- De afscherming van `skill_run_script` is een eigen werkmap, thuismap en omgeving zonder sleutels; er is geen
  sandbox van het besturingssysteem (zoals een AppContainer). Daarom blijft vertrouwen per skill plus toestemming per
  uitvoering nodig.
- De documentskills van Anthropic (docx, pptx, xlsx) werken op Windows maar deels: alles via
  `scripts/office/soffice.py` gebruikt `socket.AF_UNIX` en `LD_PRELOAD`; Python op Windows heeft geen `AF_UNIX`
  (gecontroleerd met Python 3.12.10). Dat staat bij elke skill in de catalogus.
- Geen intrekkingslijst of tijdstempels voor uitgeverssleutels; vertrouwen is per installatie (zie `docs/SDK.md`).
- Ingebouwde items zijn niet apart ondertekend; ze tellen als vertrouwd omdat ze met TeamBot zelf meekomen.
