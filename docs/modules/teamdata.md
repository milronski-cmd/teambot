# Module `teamdata` — Teamdatabase en Teamwerk

Server `server/modules/teamdata/`, UI `ui/src/modules/teamdata/`. Tests: `tests/teamdata.test.ts`,
`tests/teamdata-import.test.ts` (OpenBot), `tests/teamdata-file-import.test.ts` (CSV en Excel), de teamprobes in
`tests/teams-isolation.test.ts`, `npm run teamdata:check` (browser,
telefoon en tablet).

## Wat het doet

- **Eén database per team** (SQLite) voor de bots van dat team (0.4, pakket B2; zie `docs/modules/teams.md`):
  - `<data>/teamdata/<eigenaar>.db` is de oorspronkelijke database van de eigenaar (van vóór teams); die hoort bij het
    team dat standaardteam was toen er voor het eerst een team was (instelling `teamdata.legacyTeam`, verschuift
    daarna nooit meer);
  - elk ander team heeft `<data>/teamdata/<eigenaar>.<team>.db`.

  TeamBot's eigen database (`teambot.db`: gebruikers, sleutels, gesprekken) is van hieruit nooit bereikbaar, en een
  statement kan nooit bij de database van een ander team (een ander bestand, geen `ATTACH`).
- **Vaste tabellen** in elke teamdatabase vanaf de eerste keer: `taken`, `beslissingen`, `gebeurtenissen`, `logboek`,
  `experimenten` (kolommen zoals in de OpenBot-skill *team-database*). Ze zijn van TeamBot: elke bot van het team mag
  rijen toevoegen en wijzigen, niemand kan ze verwijderen of aanpassen. Bots maken er eigen tabellen naast; een eigen
  tabel kan alleen de maker aanpassen (`ALTER`) of verwijderen (`DROP`).
- **Tools** (groep `team:data`, dus aan bij iedere bot met *Team & samenwerking*; CLI-engines krijgen ze via de
  MCP-brug):

  | Tool | Risico | Wat |
  |---|---|---|
  | `team_tables` | read | Tabellen met CREATE-statement, aantal rijen en maker. |
  | `team_query` | read | Eén `SELECT` (ook `WITH … SELECT`), waarden als `?` in `params`; max. 500 rijen of 400.000 tekens, met melding "afgekapt". |
  | `team_execute` | write | Eén `INSERT`/`UPDATE`/`DELETE` (ook upsert en `RETURNING`) of `CREATE`/`ALTER`/`DROP` van een tabel, index of view. `DROP` en `UPDATE`/`DELETE` zonder `WHERE` gelden als *danger* (impact lokaal): in *Automatisch* vraagt dat toestemming. Een nieuwe regel in het logboek (precies `INSERT INTO logboek (…) VALUES (…)`, zonder `SELECT`, `ON CONFLICT`, `OR REPLACE`, `WITH` of `RETURNING`; `isLogAppend` in `sql.ts`) is boekhouding: in *Vraagt toestemming* zonder aparte kaart (`internalFor`), zodat een goedgekeurde wijziging in de teammap geen tweede kaart geeft (B-46). *Alleen lezen* blijft geweigerd; de aanroep staat in het beveiligingslogboek en in `teamdata_audit`. |

  Gelijkwaardig aan OpenBot's `list_tables` / `query_data` / `execute_data`; een skill hoeft alleen de toolnamen te
  vervangen.
- **Teams.** Een bot werkt in de database van zijn eigen team. Heeft hij *meekijken* of *aansturen* op een ander team,
  dan krijgen `team_tables` en `team_query` een parameter `team` (de naam van dat team) en leest hij daar mee; een
  antwoord van daar begint met *Uit de teamdatabase van team “…” (meekijken, alleen lezen)*. Schrijven doet hij alleen
  in zijn eigen team: `team_execute` met een ander team wordt geweigerd vóór er een toestemmingskaart komt. Een team
  zonder toegang of een onbekend team krijgen hetzelfde antwoord (de bot leert niets over teams die hij niet mag zien).
  Een geweigerde schrijfpoging staat in het wijzigingslog van het eigen team. Bots zonder toegang tot een ander team
  (en elke bot zolang er één team is) zien geen `team`-parameter en niets over teams.
- **Systeemprompt**: korte vaste sectie "Teamdatabase" (tools, vaste tabellen, beslissing klaarzetten, logboek,
  taken oppakken en afmelden; vanaf toegang tot een ander team ook bij welke teams de bot mag meekijken).
- **Taken echt af** (module `quality`): `taken` heeft een kolom `klaar_als` (bestaande databases krijgen hem bij het
  eerste gebruik). Zet een bot een taak op `klaar`, dan krijgt die de tweede blik met `bewijs` als bewijs; zonder of
  met fout bewijs wordt de status `wacht_op_controle` (in Teamwerk: *Te controleren*, kolom Wacht op jou). Status
  `kon_niet` (reden in `resultaat`) is het eerlijke "lukte niet". Het taakvenster toont klaar als, bewijs en oordeel,
  met goedkeuren en terugsturen. De tweede blik gebeurt in de database van het team waarin de bot schrijft; voor andere modules
  (de module `quality`, *Wacht op jou*) heet zo'n taak `<teamId>:<id>`, omdat rij-id's per teamdatabase opnieuw beginnen
  (`taskRef` / `parseTaskRef`; `PATCH /teamdata/tasks/:id` en `…/reopen` nemen beide vormen aan).

## Veiligheid en robuustheid

- **Eén statement per aanroep** (ook `;` binnen tekst of commentaar wordt goed gelezen); geen transacties, `PRAGMA`,
  `ATTACH`, `VACUUM`, triggers, tijdelijke of virtuele tabellen (`sql.ts`, met uitleg in het Nederlands).
- **SQLite-authorizer** op wat SQLite echt compileert (`worker.ts`): `team_query` draait op een alleen-lezen
  verbinding en mag alleen lezen; geen recursieve `WITH` (kan eindeloos lopen), geen `load_extension`/bestandsfuncties,
  eigenaarscontrole bij `DROP`/`ALTER`. Plus harde limieten: geen gekoppelde databases, 1 MB per waarde, 256 MB per
  bestand (`max_page_count`), `trusted_schema=OFF`, defensive mode.
- **Teamgrens** (`TeamData.scope`): welke database een statement krijgt, en of deze bot daar mag lezen of schrijven;
  de eigenaar en TeamBot zelf bereiken elk team.
- **Werkthread**: alle SQL draait in één achtergrondthread. Een opdracht die langer dan 10 s duurt, wordt afgebroken
  (de bot krijgt "maak de vraag kleiner"); de thread maakt zijn werk zelf af, een nieuwe neemt het over. Zijn er twee
  zulke threads nog bezig, dan weigert de database even nieuwe opdrachten. De rest van TeamBot loopt altijd door.
- **Audit**: elke schrijfopdracht (ook geweigerde, met reden) in `teamdata_audit` per team (laatste 20.000 per
  eigenaar), schemawijzigingen ook in het beveiligingslogboek. Zichtbaar onder *Teamwerk → Tabellen → Laatste
  wijzigingen*.
- **Back-up**: dagelijks een kopie van elke teamdatabase (`VACUUM INTO`, `teamdata/backups/`, 7 dagen per bestand).
  De back-ups onder Instellingen → *Gegevens* nemen alle teamdatabases mee (map `<back-up>.teamdata/`).

## Beslissingen

1. Een bot schrijft een rij in `beslissingen` van zijn team (vraag, uitleg, opties, `gevraagd_door`). TeamBot onthoudt
   welke bot en welk gesprek dat was (`teamdata_origins`, per team) en stuurt een melding (ook naar de telefoon).
2. De eigenaar ziet de beslissingen van **alle teams** onder **Wacht op jou** (telt mee in het badge-getal van
   zijbalk, tabbalk en venstertitel; komen ze uit meer teams, dan staat het team erbij) met de opties als knoppen:
   kiezen → bevestigen, met optionele toelichting; of een eigen antwoord, of *Laat vervallen*. Opties mogen een
   JSON-lijst zijn, `A) …; B) …`, `1) … 2) …`, `1. … 2. …` of één per regel.
3. Het antwoord wordt teruggeschreven in de database van dat team (`status` gekozen/vervallen, `antwoord`, `beslist`;
   alleen zolang de rij nog open is) en als bericht van de eigenaar in de **eigen chat van de vragende bot** gezet via
   de chatwachtrij: meteen als de bot vrij is, anders in de wachtrij; meerdere antwoorden voor een bezette bot worden
   één bericht. De vragende bot = de bot met de naam in `gevraagd_door`, anders de bot die de rij schreef — alleen een
   bot die de database van dat team mag lezen. Geen bot gevonden → het antwoord staat in de tabel en de eigenaar krijgt
   dat te horen.

## Interface: Teamwerk (`#/m/teamdata/<tab>`)

- Vanaf twee teams een **teamkeuze** bovenaan: alle tabbladen en de getallen gaan over dat team.
- Vier getallen bovenaan (beslissingen voor jou, taken die op jou wachten, in uitvoering, wijzigingen vandaag).
- **Taken**: kolommen Open / Bezig / Wacht op jou (`wacht_op_*`) / Klaar (+ Gestopt), of *per bot*; op de telefoon één
  kolom tegelijk. Een taak opent met resultaat, bewijs (links klikbaar) en een statuskeuze voor de eigenaar.
  Sinds 0.4 staan deze taken ook op het ene bord **Taken** (`#/tasks`), naast die van het takenbord van TeamBot:
  `open` → Te doen, `bezig` → Bezig, `wacht_op_*` → Te controleren (met "Wacht op jou"), `klaar` → Klaar,
  `geblokkeerd` → Geblokkeerd, de rest (geannuleerd, vervallen) onder *Toon gestopte*. Verplaatsen op dat bord schrijft
  `open`, `bezig`, `wacht_op_eigenaar`, `klaar` of `geblokkeerd` terug (`ui/src/pages/tasks/model.ts`).
- **Beslissingen**: open (zelfde kaarten als in Wacht op jou, filter per bot) en afgehandeld, doorzoekbaar.
- **Logboek** en **Gebeurtenissen**: doorzoekbaar (alle woorden), filters (bot, site / soort, verwerkt), 50 per keer.
- **Experimenten**: per status, meetdatum met "over N dagen" of verstreken.
- **Tabellen**: alle tabellen (ook die bots zelf maakten) met een alleen-lezen rijenweergave, plus de laatste
  wijzigingen. Knop **CSV of Excel importeren** (zie *Importeren uit CSV en Excel*), met daarna **Ongedaan maken**.

## Importeren uit CSV en Excel (`import-file.ts`)

Een spreadsheet wordt een teamtabel, via de bestaande `importTables` (gecontroleerd als het CREATE van een bot, in het
wijzigingslog) en terug te nemen met `undoImport`.

- **CSV** met de RFC 4180-lezer van de kluis-import (komma, puntkomma of tab; aanhalingstekens, regeleinden in een
  veld), **xlsx** met read-excel-file 9.3.14 (MIT): het gekozen blad, of het eerste met gegevens.
- De eerste rij geeft de kolomnamen, veilig gemaakt (`Omzet (€) 2026` → `omzet_2026`, dubbele namen `_2`, een kolom
  `id` uit het bestand wordt `id_bron`); een eigen `id INTEGER PRIMARY KEY` komt eerst. Elke kolom krijgt een soort uit
  zijn waarden: INTEGER, REAL (ook met een Nederlandse komma: `1250,50`) of TEXT; lege cellen worden NULL.
- De tabelnaam: wat je opgeeft, anders de bestandsnaam (bij een werkmap met meer bladen: de bladnaam). Bestaat de tabel
  al, dan komen de rijen erbij (alleen kolommen die bestaan).
- De **bron** van de import is de inhoud-hash van het bestand (`bestand:<16 hex>`): hetzelfde bestand nog eens voegt
  niets dubbel toe; een andere versie is een eigen import, apart terug te draaien.
- Maximaal 50.000 rijen, 100 kolommen, 30 MB.
- **Bot-tool `team_import_file`** `{ path, table?, sheet? }` (risico *schrijven*): een .csv of .xlsx uit de mappen van
  de bot, alleen in een nieuwe tabel of een tabel van die bot zelf (niet in een vaste tabel of die van een ander). De
  tabel is van de bot. Niet in de versie met `team` (meekijken is alleen lezen).
- Alles werkt live bij (event `teamdata.changed`, met `teamId`).

## API

`GET /api/teamdata/summary | tables | tables/:name | audit | decisions?status=open|closed|all&q= | tasks | log | events
| experiments`, `POST /api/teamdata/decisions/:id/answer` (`choice` | `answer` | `expire`, `note`, `teamId`),
`PATCH /api/teamdata/tasks/:id` (`status`, `teamId`), `POST /api/teamdata/import` (`attachmentId`, `table?`, `sheet?`,
`teamId?` → `{ table, source, created, inserted, skipped, rows, columns, sheet }`), `POST /api/teamdata/import/undo`
(`source`, `teamId?`). Altijd de eigen databases van de ingelogde gebruiker.

`?team=<teamId>` kiest de database van één team (een onbekend team: 404). Zonder `team` (of met `team=all`) tellen
`summary` en `decisions` **alle teams** samen (elke beslissing met `teamId` en `teamName`); de andere routes tonen dan
het standaardteam. Een antwoord zonder `teamId` gaat over het standaardteam.

Tabellen in `teambot.db` (alle met `user_id` + `team_id`; `''` = de oorspronkelijke database zolang de eigenaar nog
geen team heeft): `teamdata_tables` (maker per tabel), `teamdata_origins` (wie een beslissing vroeg),
`teamdata_audit`, `teamdata_imports` (per overgenomen bronrij het rij-id hier), `teamdata_import_tables` (tabellen die
een import maakte, migratie `teamdata-004-import-tables`). Migratie `teamdata-003-teams` voegde `team_id` toe; bij de
start komt alles van vóór teams in het standaardteam.

Dienst `ctx.services.teamdata` (`TeamData`): `perTeam: true` (de tabellen staan per team). `run`, `rows`, `write`,
`tables`, `decisions`, `decide`, `summary`, … hebben elk een laatste, optionele `teamId` (standaard: voor een bot zijn
eigen team, anders het standaardteam). Voor importeurs:

- `importTables(userId, source, tables, ownerOf, { teamId })` vult de database van dat team (zonder: het
  standaardteam; een onbekend team: fout); `importedCounts(userId, source, { teamId })` telt per tabel wat er van
  `source` in dat team kwam;
- `undoImport(userId, source, { tables?, teamId? })` neemt een import terug: precies de rijen die de import toevoegde
  (volgens `teamdata_imports`; rijen die er al stonden of die bots sindsdien schreven blijven), en een tabel die de
  import maakte zodra hij leeg is (heeft een bot er sindsdien in geschreven, dan blijft hij met die rijen). Geeft per
  tabel `{ name, removed, dropped, error? }`; daarna voegt opnieuw importeren de rijen weer toe. In het wijzigingslog
  van het team en het beveiligingslogboek (`teamdata.import_undone`).

`teamForBot(agent, naam)`, `scope(userId, actor, teamId, 'read' | 'write')`, `otherReadable(agentId)` en
`file(userId, teamId?)` geven de teamgrens.

## Overnemen uit OpenBot

Op de pagina *Overstappen uit OpenBot* staat de sectie **Teamtabellen** (aangevinkt zolang er iets nieuws is):

- `~/OpenBot/Shared/Data/agent-data.db` (+ WAL) wordt naar een privé-map gekopieerd en die kopie wordt gelezen; het
  origineel wordt nooit door SQLite geopend. OpenBot's eigen boekhouding (`openbot_metadata`) wordt alleen gebruikt
  om te zien welke bot een tabel maakte.
- Elke tabel komt over (`TeamData.importTables`, in de database van het gekozen team, standaard het standaardteam;
  terug te nemen met `undoImport`): vaste tabellen vullen de
  bestaande; eigen tabellen van bots worden gemaakt met hun originele CREATE-statement (gecontroleerd zoals bij een
  bot) en horen daarna bij de overgenomen bot. Originele id's blijven behouden waar ze vrij zijn (bots verwijzen naar
  "kaart 34"); een bezet id krijgt een nieuw nummer (gemeld).
- **Opnieuw overnemen voegt alleen nieuwe rijen toe**: per bronrij staat de koppeling in `teamdata_imports`.
- In de overgenomen kopie van een skill worden `openbot.query_data` / `execute_data` / `list_tables` →
  `team_query` / `team_execute` / `team_tables`, `send_message` → `ask_bot`, en het pad van agent-data.db → "de
  teamdatabase". De rest (de afspraken van de eigenaar) blijft staan.

## Beperkingen

- Een team verwijderen kan alleen als het leeg is; zijn teamdatabase blijft als bestand staan en is daarna niet meer
  in beeld.
- Logboek, gebeurtenissen, experimenten, tabellen en taken toont Teamwerk per team (geen samengevoegde lijst over alle
  teams); beslissingen en de getallen wel samen.
