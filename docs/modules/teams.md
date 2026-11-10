# Module `teams` — Teams als afgeschermde werkruimtes, met hoofdbot, leiders en teamleiders

Server `server/modules/teams/`, UI `ui/src/modules/teams/` en de teamkiezer `ui/src/shell/TeamSwitcher.tsx`. Plan:
`docs/PLAN_0.4.md` pakket B (kern = golf 1, B2 = golf 2 deel 1: teamdatabase, groepen, zoeken, budget en verbruik per
team; B3: geheugen; B4: kanalen, skills, routines en gratis doorschakelen per team), pakket C (organisatie: hoofdbot,
leiders, teamleiders; golf 2) en A3 (teamkiezer, golf 2). Tests: `tests/teams-isolation.test.ts`,
`tests/teams.test.ts`, `tests/teams-org.test.ts`, `tests/team-switcher.test.ts`; e2e `tests/e2e/layout.mjs` en
`tests/e2e/newcomer.mjs` (teamkiezer).

## Wat het doet

- Een **team** is een werkruimte van één eigenaar: naam, kleur, **teamleider** (niet verplicht), **bedrijfsprofiel**
  (naam van het bedrijf, wat het doet, toon, regels), een eigen **teammap**, een eigen **teamdatabase** (Teamwerk:
  taken, beslissingen, logboek, gebeurtenissen, experimenten en eigen tabellen), eigen **groepen**, eigen
  **geheugen en dossiers**, eigen **kanalen**, eigen **skills** (of skills *voor alle teams*), eigen **routines**, een
  optioneel eigen **dagbudget** en optioneel eigen instellingen voor **gratis doorschakelen**.
- Elke bot heeft precies één **thuisteam**. Daar werkt hij: met de map, de database, het profiel en de sleutels van
  dat team.
- Per bot en per ander team kiest de eigenaar de **toegang**:

  | Toegang | Code | Wat de bot mag in dat andere team |
  |---|---|---|
  | Geen toegang (standaard) | `none` | niets: de map, de database en het geheugen van het team zijn dicht, de bots zijn niet aan te spreken, de groepen zijn dicht, zoeken vindt niets, het team wordt in zijn prompt niet genoemd |
  | Meekijken | `read` | de teammap en de teamdatabase lezen (alleen lezen), en het geheugen van het team: gedeelde kennis, dossiers met hun documenten, gesprekssamenvattingen (alleen lezen); meedoen in een groep van dat team als die groep andere teams toestaat (groepsbestanden alleen lezen, geen taken) |
  | Aansturen | `direct` | alles van meekijken, plus de teamleider en de bots van dat team taken geven (`delegate_task`, `ask_bot`, `message_bot`, `broadcast`, `handoff`, een taak met die bot als eigenaar, het takenbord in een groep van dat team); nooit schrijven in de map, de database of het geheugen |

- **Sleutels en logins** staan in één kluis en zijn standaard **voor alle teams**. Per sleutel kan de eigenaar kiezen
  voor *alleen dit team*. Een bot van een ander team kan zo'n sleutel dan niet gebruiken, ook niet met *aansturen*
  (hij laat het werk dan doen door een bot van dat team). Soorten: AI-providers (`provider`), apps/MCP-koppelingen
  (`app`) en website-logins uit de Kluis (`login`).
- **Dagbudget per team** (optioneel, in USD): wat de bots van het team samen per dag aan betaalde AI mogen uitgeven,
  **bovenop** het eigen dagbudget van de eigenaar (Instellingen › Kosten). Gratis, lokale en abonnementsmodellen tellen
  niet mee, net als bij het eigen dagbudget.
- **Eén team = rustig.** Zolang er één team is, toont de UI alleen de instellingen van dat ene team (geen teamkeuze,
  geen toegang per bot, geen sleutelscope, geen teambudget), en staat er niets over teams in de prompts en de tools,
  behalve als de eigenaar een hoofdbot of een teamleider heeft gekozen (zie hieronder).

## De organisatie: hoofdbot → leiders → teamleiders → bots

| Rol | Wie | Wat |
|---|---|---|
| **Hoofdbot** | één bot die de eigenaar daar zelf voor kiest (hoogstens één per eigenaar) | de vaste voordeur: begrijpt de vraag, kiest het team en de bot, geeft het werk door met een "klaar als", volgt het op, controleert resultaat en bewijs, en meldt in gewone taal terug. Hij heeft standaard *aansturen* op alle teams, ook op teams die later komen. |
| **Leider** | elke andere bot die meer dan één team werk mag geven (thuisteam plus *aansturen* op een ander team) | geeft werk aan de teamleiders (of, zonder teamleider, aan de passende bot) van die teams en controleert het |
| **Teamleider** | per team één bot van dat team, **niet verplicht** | krijgt het werk voor zijn team, verdeelt het over de bots van zijn team en heeft het laatste woord in het team |
| **Bot** | elke andere bot | doet het werk |

- **Zonder teamleider** (de opzet die de eigenaar zelf gebruikt: één team met de hoofdbot en veel smalle specialisten)
  geeft de hoofdbot of een leider elke taak direct aan de bot wiens **rol** het best past, en controleert het
  resultaat zelf. Er staat nergens een waarschuwing dat een teamleider ontbreekt; het overzicht toont gewoon de
  hoofdbot boven de bots.
- **Niets ontstaat vanzelf.** Er komt geen hoofdbot, leider of teamleider zonder dat de eigenaar hem kiest.
- **De hoofdbot maken.** Bij *Nieuwe bot* staat de keuze **Soort bot: Gewone bot of Hoofdbot**. Kiest de eigenaar
  *Hoofdbot*, dan haalt de pagina een eenmalige keuze-sleutel op (`POST /teams/main/intent`, 6 uur geldig) en zet die
  in `settings.mainBot` van de nieuwe bot; de server maakt die bot bij het aanmaken hoofdbot en haalt de sleutel weer
  uit de bot. Een sjabloon, import of kopie met `mainBot` maakt dus **nooit** een hoofdbot (dat zou stil toegang tot
  alle teams geven). Een bestaande bot wordt hoofdbot via de bot-editor (*Hoofdbot*) of *Alle teams*.
- **Hoofdbot worden** (`setMain`): geweigerd zolang er een andere hoofdbot is ("maak die eerst een gewone bot").
  De toegangsregels van de bot vervallen (dus standaard *aansturen* overal); is hij teamleider, dan niet meer (de
  hoofdbot staat boven de teams); staan de tools *Team & samenwerking* uit, dan gaan ze aan. Alles wat zo verandert,
  staat in het antwoord (`notes`) en in het logboek; niets gebeurt stil.
- **Gewone bot worden** (`clearMain`): de bot verliest zijn *aansturen* op andere teams; de eigenaar geeft dat per
  team opnieuw als hij wil.
- De hoofdbot heeft een thuisteam zoals elke bot (zijn map, profiel en sleutels). Per team kan de eigenaar zijn toegang
  verlagen naar *meekijken* of *geen toegang* (die keuze wordt bewaard, omdat de standaard *aansturen* is). Hij
  schrijft nooit in de map of kennis van een ander team: *aansturen* is nooit schrijven.
- De hoofdbot kan geen teamleider zijn en krijgt **geen werk van andere bots** (alleen van de eigenaar); resultaten
  komen wel vanzelf bij hem terug.

## Vastgelopen werk melden (0.4.4, P2, `stuck.ts`)

De hoofdbot meldt vastgelopen werk één keer in zijn vaste gesprek (`ctx.chat.threadForAgent(owner, main)`), zonder
modelaanroep (`addAgentMessage`, dus geen tokens). Elke minuut (`start()`, `StuckReporter.tick()`) verzamelt
`collectStuck` per eigenaar met een hoofdbot:
- goedkeuringen en vragen die langer dan `WAIT_MINUTES` (30) op `pending` staan;
- runs met `error` of `interrupted` die `BROKEN_AFTER_MS` (5 min) oud zijn en waar daarna geen run van dezelfde bot in
  hetzelfde gesprek meer kwam; een geplande herkansing na een limiet (`meta.limitRetryAt`) en gepauzeerd belangrijk werk
  (`meta.paused`) tellen niet; delegaties en routinegesprekken ook niet;
- routine-runs met `error` zonder latere geslaagde of lopende run van die routine (ook *Kon niet: koppeling verlopen*).
Werk in het gesprek van de hoofdbot zelf blijft buiten beschouwing, en niets ouder dan 7 dagen. Per bericht staan
hoogstens 5 punten, de rest wordt geteld. Elk punt komt in `team_stuck_reports` (`teams-003-stuck`) en wordt dus maar één
keer gemeld. Bij het bericht hoort één melding (`kind: 'warning'`, `ref: stuck:<bericht>`).

`parts.stuck.items` = `[{ ref, kind, link, retry, retriedAt? }]`; de UI (`ui/src/modules/teams/StuckExtra.tsx`) toont
per punt de link en bij `retry` **Opnieuw proberen** → `POST /api/teams/stuck/retry { messageId, ref }`: een run start
opnieuw (`trigger: 'retry'`, laatste gebruikersbericht), een routine draait één keer handmatig (`manualRun`). Daarna
staat `retriedAt` in de parts en is de knop weg. De hoofdbot beslist nooit zelf: hij keurt niets goed en start niets.
Het idee komt uit `docs/team-escalations.md` van OpenMausBot (Apache-2.0); de code is eigen werk.

## Handhaving (in code, niet in de prompt)

| Wat | Waar |
|---|---|
| Teammap van een ander team | `addRootFilter` + `addPathGuard` in `server/tools/builtin/files.ts`: zonder toegang valt een map in een andere teammap weg (ook als extra map van de bot), met toegang wordt hij alleen-lezen; `resolveInWorkspace` weigert elk pad in een andere teammap (ook via een werkmap die die map bevat). Geldt voor alle bestandstools, de toestemmingsbrug van de CLI-engines, ACP, `--add-dir` en `read_document`. |
| Teamdatabase van een ander team | Elk team een eigen databasebestand (`server/modules/teamdata`, zie `docs/modules/teamdata.md`): een statement kan nooit bij een ander bestand (geen `ATTACH`). `TeamData.scope` laat een bot lezen in zijn eigen team en de teams die hij mag lezen (`team_tables` / `team_query` met `team`), en schrijven alleen in zijn eigen team; `team_execute` in een ander team wordt geweigerd vóór er een toestemmingskaart komt (`refuse`). Een antwoord op een beslissing gaat alleen naar een bot die dat team mag lezen. |
| Groep van een ander team | `server/modules/rooms/walls.ts`: een groep hoort bij één team (`rooms.workspace_id`); een bot van een ander team komt er alleen in met meekijken of aansturen én als de eigenaar *Bots van andere teams toestaan* aanzette; zo'n bot leest de groepsbestanden alleen en gebruikt het takenbord alleen met aansturen; verliest hij zijn toegang, dan doet hij niet meer mee (`dispatch` zegt waarom). |
| Zoeken | `server/modules/search`: elk resultaat hoort bij een team (of bij alle teams). `ctx.services.search.forAgent` vindt voor een bot alleen wat hij mag lezen; de eigenaar ziet alles en filtert met `?team=`. |
| Dagbudget per team | `teams/budget.ts` via de runnerhook `beforeModelCall`: vóór elke modelaanroep die geld kan kosten, met dezelfde schatting als het eigen dagbudget (wat de vorige aanroep van deze bot hier kostte). Bereikt: `BudgetError` (*Daglimiet van het team “…” bereikt*), een limiet en geen fout. |
| Sleutel *alleen dit team* (AI) | `ProviderRegistry.addBotGuard` / `refuseFor`, aangeroepen in `Runner.resolveProvider` (hoofdengine) en `engineChain` (reserves): geweigerd vóór elke modelaanroep, met de reden in de chat. |
| App (MCP) *alleen dit team* | `boundConnections` en de controle bij elke aanroep in `server/modules/mcp/tools.ts` (`keyAllowed(agent, 'app', id)`). |
| Login *alleen dit team* | `Vault.matchesFor` in `server/modules/browser/vault.ts` (`keyAllowed(agent, 'login', id)`). |
| Werk geven aan een bot van een ander team | `TeamsService.delegateError`, aangeroepen door `Orchestrator.hopError`, `handoff` en `botList` (`server/modules/rooms/orchestration.ts`) en het takenbord: alleen met *aansturen* op het team van de ontvanger. |
| Geen weg om een muur heen via een andere bot | `delegateError`: de ontvanger mag geen team aansturen dat de afzender niet mag aansturen, en nergens meekijken waar de afzender geen toegang heeft. Zo kan een bot zonder toegang tot team B niet via een leider, een bot met *meekijken* of de hoofdbot toch werk aan B geven of kennis van B terugkrijgen. Werk gaat alleen omlaag of opzij in de organisatie. |
| De hoofdbot krijgt alleen werk van de eigenaar | `delegateError` (ook met één team). |
| Eén hoofdbot per eigenaar | tabel `team_main` (primaire sleutel `user_id`) en `setMain`. |
| Begrensde diepte, geen lussen | `Orchestrator.hopError` (module rooms): hoogstens `maxDelegationDepth` keer doorgeven (standaard 3: hoofdbot → leider → teamleider → bot; de 4e keer wordt geweigerd), en een bot die al in de keten zit krijgt het werk niet nog eens (geen A→B→A). |
| Takenbord | `Board.createTask/updateTask` (eigenaar in een ander team = aansturen); `task_list`/`task_update` van een bot tonen alleen taken van teams die hij mag lezen, en wijzigen alleen in het eigen team of een team dat hij aanstuurt (`room_tasks.workspace_id`). |
| Geheugen en dossiers | `team_id` op botnotities, gedeelde kennis, dossiers en gesprekssamenvattingen; de `Reader` van een bot (`readerFor` → `aclSql`, `readableDossiers`) laat alleen het thuisteam, teams met meekijken/aansturen en kennis *voor alle teams* door; schrijven alleen in het thuisteam (`teamWriteRefusal`/`dossierWriteRefusal` in tools, pijplijn en dienst). Vaste regels van een team alleen voor de bots van dat team. Zie `docs/modules/memory.md` › Geheugen per team. |
| Kanalen | `server/modules/channels/teams.ts` (`ChannelTeams`): een kanaal hoort bij het team van zijn bot of groep (`channel_bindings.team_id`, gaat mee als de bot verhuist). Alleen bots van dat team antwoorden erop of versturen erdoor: `bindingsForAgent` (tools), `channel_send` geweigerd vóór de toestemmingskaart, een antwoord van een bot van een ander team gaat niet naar buiten (`onRunDone`), een bot van een ander team die de eigenaar in WhatsApp bij naam noemt wordt niet aangesproken (`receive`), en een routine bezorgt alleen via de kanalen van zijn team (`services.channels.deliver` met `agentId`). Met meekijken/aansturen toont `channel_list` het kanaal alleen-lezen; zonder toegang bestaat het voor de bot niet. De sleutels van een kanaal volgen bovendien `keyAllowed(bot, 'channel', id)`. Zie `docs/modules/channels.md` › Per team. |
| Skills | `server/modules/skills/library.ts`: een skill hoort bij één team of is *voor alle teams* (`install_scope`, `team_id`; naam uniek per team). `enabledFor` en `setAgentSkills` laten een bot alleen skills van zijn team en voor alle teams gebruiken, en met meekijken/aansturen die van dat team lezen; `skill_prepare_scripts`/`skill_run_script` weigeren scripts van een skill van een ander team (`scriptRefusal`) vóór de toestemmingskaart. Zie `docs/modules/skills.md` › Per team. |
| Routines | `server/modules/routines/engine.ts`: een routine hoort bij het team van zijn bot. Bezorgen via een kanaal, een chat- of e-mailtrigger en *Daarna starten* alleen binnen dat team (bij het instellen geweigerd, en tijdens het draaien nog eens); `routine_list` toont een bot alleen routines van teams die hij mag lezen. Zie `docs/modules/routines.md` › Per team. |
| Gratis doorschakelen | `EngineChainService.teamOf`: de instellingen van het team van de groep, anders van het thuisteam van de bot (`engineChain.teams[teamId]`). |

Alle controles zijn synchroon en lezen uit een momentopname per eigenaar die bij elke wijziging vervalt. Een controle
die faalt, weigert (fail closed).

## Resultaten gaan terug langs dezelfde keten

Dat staat in de module rooms (`docs/modules/rooms.md`, *Ketens*): een bot die een deel van zijn subtaak doorgeeft,
is pas klaar als de antwoorden binnen zijn en zijn vervolgbeurt is afgelopen; dán gaat zijn resultaat (met het bewijs)
één stap omhoog. Elke stap is zichtbaar: het subgesprek per stap, "Keten: Hoofdbot → Leider → Teamleider → Bot" in de
opdracht, "… wacht op …" en "Resultaat teruggestuurd naar …".

## Prompts

Alle blokken zijn stabiel (geen tijd, geen live status) en veranderen alleen als de eigenaar teams, teamleiders,
rollen of toegang wijzigt.

- **Hoofdbot** (`## Hoofdbot`): zijn werkwijze in zes stappen (begrijpen, team en bot kiezen, doorgeven met
  `delegate_task` en "Klaar als: …" plus het gewenste bewijs, opvolgen, controleren, in gewone taal terugmelden), dat
  hij het werk van een team of specialist nooit zelf doet als er een bot voor is (tenzij de eigenaar dat vraagt), dat
  doorgeven begrensd is, en dat hij niets schrijft in andere teams. Daarna de teams die hij werk geeft, met per team
  de bots en hun rol (de teamleider bovenaan, gemarkeerd). Met één team: "Bots in je team (met hun rol)".
- **Twee of meer teams** (`## Teams`, elke andere bot): het thuisteam en de teamleider, de teams waar de bot mag
  meekijken of die hij mag aansturen (met teamleider en bots, nooit de hoofdbot), en dat andere teams afgeschermd zijn.
  Teams zonder toegang worden niet genoemd.
- **Leider** (`## Leider`): dat hij werk geeft aan de teamleider (of zonder teamleider de bot wiens rol past), met een
  "klaar als" en bewijs, het resultaat controleert en het niet zelf doet; bij teams zonder teamleider de bots met rol.
- **Teamleider** (`## Teamleider`): dat hij het laatste woord heeft, het werk verdeelt over de bots van zijn team (met
  hun rol) en hun werk controleert voordat hij het resultaat met bewijs teruggeeft.
- De sectie *Teamdatabase* noemt de teams waar de bot mag meekijken; een groepsgesprek noemt (vanaf twee teams) het
  team van de groep.
- **Beurtcontext** (`turnContext`): het bedrijfsprofiel van het thuisteam. Het komt alleen opnieuw mee als de bot dit
  profiel niet al in het recente, nog niet samengevatte deel van het gesprek had (een nieuw gesprek, een gewijzigd
  profiel, na samenvatten, of na zo'n 10 beurten). Zo blijft de systeemprompt stabiel voor prompt caching en draagt
  een lang gesprek het profiel niet in elk bericht mee.

## Migratie

- **Update vanaf 0.3:** bij de start krijgt elke eigenaar met bots maar zonder team één team **Mijn team**, met:
  - alle bots (ook gearchiveerde) als thuisteam;
  - de oude gedeelde teammap (gebruikersinstelling `teamFolder`) als teammap;
  - het bestaande organigram (`room_teams`, afdelingen met chief of staff) als afdelingen van Mijn team
    (`room_teams.workspace_id`); is er precies één afdeling bovenaan met een chief of staff, dan wordt die bot de
    teamleider;
  - bestaande taken (`room_tasks.workspace_id`);
  - de bestaande teamdatabase (`teamdata/<eigenaar>.db`, met de eigenaars van tabellen, wie welke beslissing vroeg,
    het wijzigingslog en overgenomen rijen; instelling `teamdata.legacyTeam`);
  - bestaande groepen (`rooms.workspace_id`): het team van hun bots (eerst de lead, anders de meeste bots), anders het
    standaardteam. Had een groep al bots uit meer teams, dan staat *Bots van andere teams toestaan* aan.
  - het geheugen: gedeelde kennis en dossiers in Mijn team, notities en gesprekssamenvattingen van een bot in het team
    van die bot ("Over jou" blijft persoonlijk). Elke bot ziet daarna precies wat hij vóór de update zag.
  - kanalen (`channel_bindings.team_id`): het team van hun bot of groep;
  - skills (migratie `skills-005`, daarna bij de start `SkillLibrary.upgradeTeams`): het standaardteam, of *voor alle
    teams* als bots van meer teams de skill al gebruikten (dat kan alleen bij een ontwikkelversie van 0.4 die al
    teams had); elke bot houdt zijn skills;
  - routines hebben geen eigen veld: ze horen bij het team van hun bot.
  Er komt **geen hoofdbot**; die kiest de eigenaar zelf.
- **Nieuwe installatie:** leeg. Het eerste team (*Mijn team*) ontstaat vanzelf als de eerste bot wordt gemaakt (of als
  de eigenaar zelf een team of teammap aanmaakt).
- Een nieuwe bot komt in het eerste team, of in het team uit `settings.homeTeam` bij het aanmaken (het team dat in de
  teamkiezer gekozen is).
- De instelling `teamFolder` blijft een "inbox": wie hem nog schrijft (de OpenBot-import, scripts) zet daarmee de
  teammap van het eerste team.

## API (onder `/api`)

| Route | Wat |
|---|---|
| `POST /teams/stuck/retry` | `{ messageId, ref }`: **Opnieuw proberen** onder het bericht van de hoofdbot over vastgelopen werk (alleen een punt met `retry`, één keer). Zie *Vastgelopen werk melden*. |
| `GET /teams` | Alle teams in volgorde (het eerste is het standaardteam): `id, name, color, profile {company, about, tone, rules}, leadAgentId, leadName, folder, sort, dailyBudgetUsd, spentToday, isDefault, bots[] (met lead, main), access[]` (`access`: elke bot van een ander team met `level` none/read/direct en `main`). Maakt niets aan. |
| `POST /teams` | `{ name, color?, profile? }` → team. Naam uniek per eigenaar, max. 50 teams. |
| `GET /teams/:id` | Eén team. |
| `PATCH /teams/:id` | `{ name?, color?, profile? (deels), leadAgentId? (bot van dit team, niet de hoofdbot, of null), sort?, dailyBudgetUsd? (0 = geen, max. 10.000) }`. |
| `DELETE /teams/:id` | Alleen een leeg team: geen bots en geen sleutels alleen voor dit team (anders 400 met de reden). |
| `PUT /teams/:id/bots/:agentId` | Dit team wordt het thuisteam van de bot (verplaatsen). Toegang tot zijn nieuwe thuisteam vervalt; was hij teamleider van het oude team, dan niet meer. |
| `PUT /teams/:id/access/:agentId` | `{ level: 'none' \| 'read' \| 'direct' }`: toegang van een bot van een ander team tot dit team (voor de hoofdbot is `direct` de standaard). |
| `GET /teams/bots/:agentId` | Thuisteam van de bot, `main`, `leader`, en zijn toegang (`home`/`direct`/`read`/`none`) per team. |
| `GET /teams/main` | `{ main: { id, name, avatar, color, role, archived, homeTeamId } \| null }`. |
| `POST /teams/main/intent` | `{ token }`: eenmalige keuze "Hoofdbot" voor `settings.mainBot` van de volgende nieuwe bot (400 als er al een hoofdbot is). |
| `PUT /teams/main/:agentId` | Deze bot wordt de hoofdbot (400 als er een andere is) → `{ main, notes[] }`. |
| `DELETE /teams/main` | De hoofdbot wordt een gewone bot. |
| `GET /teams/overview` | *Alle teams*: `main` (met teams die hij niet aanstuurt, wat van hem op je wacht, zijn fouten en verbruik), `leaders[]` (met hun teams), en per team `lead` (of null), `bots[]` (zonder de hoofdbot), `directedBy[]`, `open`, `waiting`, `results`, `errors`, `missed` (elk met `count` en tot 5 `items {kind, id, title, detail, who, at, link}`), `usage {today, week}`; plus `usage.source` (`team` van de module usage, of `bots`: per bot opgeteld bij het huidige thuisteam). De laatste 7 dagen. Leest alleen. |
| `POST /teams/:id/duplicate` | **Team dupliceren** (`duplicate.ts`): een nieuw team "<naam> (kopie)" met een kopie van elke bot van het team als bottemplate (instructies, gezicht, tools, skills, dezelfde engine, routines die uit staan, het vakgebied van een specialist), hetzelfde profiel, de kopie van de teamleider en hetzelfde dagbudget; daarna `copyTeamData` zonder vakkennis. Nooit: geheugen, gesprekken, sleutels en hun scope, kanalen, de teammap, toegang van bots van andere teams, de hoofdbot. Alles of niets → `{ team, bots, mainSkipped, warnings }`. Audit `team.duplicated`. |
| `GET /teams/keys` | Sleutels en logins met hun scope: `{ kind: provider \| app \| login, id, name, detail, teamId }` (`teamId` null = alle teams). |
| `PUT /teams/keys/:kind/:id` | `{ teamId: string \| null }`: alleen dit team, of weer alle teams. |

Per team elders: de teammap `GET/PUT/DELETE /api/folders/team?teamId=` (`docs/modules/folders.md`), Teamwerk
`/api/teamdata/*?team=` (`docs/modules/teamdata.md`), groepen `GET /api/rooms?team=` (`docs/modules/rooms.md`),
zoeken `GET /api/search/all?team=`, verbruik `GET /api/usage/breakdown?by=team` (`docs/modules/usage.md`), kanalen
`GET /api/channels/bindings?teamId=`, skills `GET /api/skills?teamId=` en `GET /api/skills/curated?teamId=` (installeren
met `teamId`, `'*'` = alle teams), routines `GET /api/routines?teamId=` (ook runs, attention, missed, summary,
calendar), gratis doorschakelen `PUT/DELETE /api/engine-chain/settings/teams/:teamId`.

Bronnen van het overzicht (elk alleen als die module er is): takenbord (`room_tasks.workspace_id`; *ter controle* telt
als "wacht op jou"), goedkeuringen en vragen (`approvals`), voorstellen voor nieuwe leden (`room_proposals`), afgeronde
en mislukte subtaken (`room_delegations`), mislukte beurten (`runs`), mislukte en gemiste routineruns
(`routine_runs`), verbruik (`ctx.services.usage.breakdown`: per team zodra die module dat biedt, `groupings` met
`team`; anders per bot opgeteld).

Event: `teams.changed`. Auditregels: `team.created`, `team.updated`, `team.deleted`, `team.bot_moved`,
`team.access`, `team.key_scope`, `team.main_set`, `team.main_cleared`, `team.main_refused`.

Tabellen: `teams` (met `daily_budget_usd`, migratie `teams-002-budget`), `team_bots` (thuisteam per bot),
`team_access` (bot × team → read/direct; voor de hoofdbot ook none), `team_key_scopes` (soort × id → team),
`team_main` (eigenaar → hoofdbot, migratie `teams-002`). De volledige export (`exportUser`)
neemt ze mee.

## Diensten voor andere modules (`ctx.services.teams`)

Alles synchroon. Modules schalen hun gegevens hiermee per team: sla per record een team op (standaard
`teamOf(agentId)`, oude records zonder team horen bij `defaultTeam(userId)`), toon het aan bots die `canRead`, laat
alleen bots die `canWrite` het wijzigen, en vraag `keyAllowed` vóór het gebruik van een sleutel. Voeg een probe toe
aan `PROBES` in `tests/teams-isolation.test.ts` voor elke nieuwe weg naar teamgegevens.

| Helper | Geeft |
|---|---|
| `list(userId)`, `team(teamId)`, `defaultTeam(userId)`, `ensureDefault(userId)`, `multi(userId)` | teams, het standaardteam (eventueel aangemaakt), twee of meer teams |
| `teamOf(agentId)` | id van het thuisteam (null voor een onbekende bot) |
| `botsOf(teamId)`, `lead(teamId)` | bots van het team, de teamleider (of null) |
| `access(agentId, teamId)` | `'home' \| 'direct' \| 'read' \| 'none'` (de hoofdbot: standaard `direct`) |
| `canRead`, `canWrite`, `canDirect` | lezen (home/read/direct), schrijven (alleen home), taken geven (home/direct) |
| `readableTeams(agentId)`, `directableTeams(agentId)` | team-id's die de bot mag lezen / werk mag geven, thuisteam eerst |
| `delegateError(fromId, toId)` | reden (Nederlands) waarom de ene bot de andere geen werk mag geven, of null |
| `mainOf(userId)`, `isMain(agentId)`, `isLeader(agentId)` | de hoofdbot (id of null), is deze bot de hoofdbot, is hij een leider |
| `overview(userId)` | het overzicht *Alle teams* (zoals `GET /teams/overview`) |
| `keyScope(kind, refId)`, `keyAllowed(agentOrId, kind, refId)` | team van een sleutel (null = alle teams), mag deze bot hem gebruiken; `kind` mag een eigen soort zijn (bijv. `channel`) |
| `setKeyScope(userId, kind, refId, teamId \| null)` | een sleutel op één team zetten of weer op alle teams (zoals `PUT /teams/keys/:kind/:id`); de MCP-module doet dat voor een bestanden-app die standaard naar de map van één team wijst |
| `teamFolder(teamId)`, `defaultFolder(userId)`, `setFolder(...)`, `foldersFor(agent)` | teammappen |
| `budget(teamId)` | `{ limit, spent }`: het dagbudget van het team (0 = geen) en wat zijn bots vandaag uitgaven |
| `own(userId, teamId)`, `create(userId, data)`, `update(userId, teamId, data)`, `setHome(userId, teamId, agentId)`, `remove(userId, teamId)` | teams maken en wijzigen voor andere modules (teamsjablonen, de OpenBot-import), met dezelfde controles, logregels en events als de routes |
| `registerCopier(id, fn)`, `copyTeamData(userId, van, naar, { knowledge?, agentMap? })` | een team dupliceren: elke module kopieert zijn eigen teamgegevens (zie hieronder) |

### Een team dupliceren of als sjabloon exporteren

`POST /teams/:id/duplicate` (knop **Team dupliceren** onderaan bij het team) maakt het nieuwe team en de kopieën van de
bots, en roept daarna `copyTeamData(userId, oudTeam, nieuwTeam, { knowledge: false, agentMap })` aan. Elke module die zich met `registerCopier`
heeft aangemeld kopieert dan zijn eigen deel; het antwoord geeft per module wat er gekopieerd is (of de fout).
- **Geheugen gaat nooit mee**, behalve met de optie **Vakkennis meenemen** (`knowledge: true`, standaard uit; toon het
  als een vinkje dat uit staat). Dan kopieert het geheugen alleen de dossiers (met besluiten, acties, bronnen en
  documenten) en de gedeelde kennis van het team; nooit "Over jou", notities van bots, gesprekssamenvattingen, iets
  persoonlijks of gevoeligs. Sleutels, kanalen en gesprekken gaan nooit mee.
- `agentMap` (id van de oude bot → id van zijn kopie) houdt de botlijst van een dossier; zonder is een gekopieerd
  dossier voor alle bots van het nieuwe team.
- Hetzelfde kan nu al tussen twee bestaande teams: Geheugen › Dossiers › **Vakkennis kopiëren**
  (`POST /api/memory/teams/copy`).
- Exporteren als sjabloon met vakkennis bestaat nog niet (de kopie werkt binnen één installatie).

## UI

- **Instellingen › Bots en groepen › Teams** (`#/settings/teams-teams`, ook met één team: de optie is er altijd) en
  `#/m/teams/<teamId>` (dezelfde instellingen voor één team, binnen Instellingen met *Teams* gemarkeerd; de teamkiezer
  linkt hierheen), met bovenaan een link naar *Alle teams*:
  - naam, kleur, teamleider (*Geen teamleider* mag; de hoofdbot staat er niet tussen) en bedrijfsprofiel;
  - de bots van het team (met *teamleider* en *hoofdbot*), en vanaf twee teams een bot naar dit team verplaatsen;
  - vanaf twee teams (of als er een is ingesteld): *Dagbudget van dit team*, met wat vandaag al gebruikt is;
  - de teammap (hetzelfde onderdeel als *Teammap*);
  - vanaf twee teams ook: toegang voor bots van andere teams (*Geen toegang / Meekijken / Aansturen*; bij de hoofdbot
    "stuurt standaard alle teams aan"), sleutels en logins (*Alle teams / Alleen …*), team verwijderen.
- **Alle teams** (`#/m/teams/alle`, `Overview.tsx`): bovenaan de hoofdbot met *Praat met …* (zonder hoofdbot: wat een
  hoofdbot is, *Nieuwe hoofdbot maken* of een bestaande bot kiezen; het hoeft niet), daaronder de leiders, en per team
  de bots (teamleider gemarkeerd als die er is), wie het team werk geeft, tellers (open taken, wacht op jou, fouten,
  gemiste runs) en de lijsten met links naar waar je het afhandelt, plus verbruik deze week. Live (rustig gebundeld).
- **Nieuwe bot**: *Soort bot — Gewone bot / Hoofdbot* (`MainBotChoice` in `MainBot.tsx`); met een hoofdbot staat er
  alleen welke dat is.
- **Bot-editor › Hoofdbot** (`MainBotSection`): deze bot hoofdbot maken (met bevestiging), of weer een gewone bot.
- **Start**: op de pc opent de start het gesprek met de hoofdbot (anders het laatste gesprek); op de telefoon is de
  hoofdbot de eerste rij van de chats (de chatlijst van A3; `MainBotEntry` bestaat nog voor andere plekken). `useMainBot()` (`api.ts`) geeft de hoofdbot live aan elk onderdeel.
- **Teamkiezer** (pakket A3, `ui/src/shell/TeamSwitcher.tsx`): zolang er één team is, staat er niets over teams in
  beeld. Vanaf het tweede team staat bovenaan de zijbalk (en op de telefoon boven *Chats* en in *Meer*) een rustige knop
  met de kleur en naam van het team dat je bekijkt. Het menu: *Alle teams*, elk team (met het aantal bots), *Nieuw team*
  en *Teams beheren*. Met de muis en het toetsenbord (Enter of pijltje opent, pijltjes, Home/End, Escape). De keuze
  geldt per apparaat (localStorage `tb.team`) en valt terug op *Alle teams* als dat team weg is. *Alle teams* opent ook
  het overzicht van alle teams als de app dat heeft (`#/m/teams/alle`, pakket C2).
  - Wat de keuze filtert: de chatlijst en de vastgezette bots (bots met dit thuisteam; groepen met een bot van dit
    team of zonder bots) en het takenbord `#/tasks` (taken van dit team en de eigen taken van de eigenaar, met een
    regel welk team je ziet). Alles waarvan het team nog niet bekend is (een bot die net gemaakt is), blijft zichtbaar.
    Dit gaat over wat je ziet; de muren tussen teams handhaaft de server.
  - Een nieuwe bot komt in het gekozen team (`settings.homeTeam` bij het aanmaken).
  - Elk team heeft zijn eigen teamdatabase (B2): een gekozen team is ook het team dat **Teamwerk** en de
    teamdatabase-taken op `#/tasks` tonen. Bij *Alle teams* blijft Teamwerk op het team dat het toonde.
  - De hoofdbot staat boven alle teams: altijd de eerste vastgezette bot (met *Hoofdbot* eronder), ook als een ander
    team gekozen is, en de start op de pc opent hem. Hij komt uit `GET /teams` (`bots[].main`, van pakket C2); een
    server zonder hoofdbot heeft er gewoon geen.
  - Andere pagina's (routines, geheugen, gebruik …) volgen de keuze zodra ze per team kunnen filteren: `useTeamView()`
    (`activeId`, `active`) en `teamQuery()` (`?teamId=…`) uit `ui/src/modules/teams/scope.ts`, plus
    `<TeamFilterNote>` (`./FilterNote`) zodat zichtbaar is dat de pagina één team toont. De regels zelf staan los en
    getest in `ui/src/shell/teamFilter.ts` (`tests/team-switcher.test.ts`).
- **Bot-editor › Teams** (onder *Meer opties* bij een nieuwe bot, onder *Geavanceerd* bij een bestaande; alleen vanaf
  twee teams): het thuisteam (verhuizen, met uitleg wat er bij opslaan gebeurt) en per ander team *Geen toegang /
  Meekijken / Aansturen*. Opgeslagen met de gewone *Opslaan* van de editor. Bij een nieuwe bot alleen het thuisteam;
  toegang kies je zodra de bot bestaat.
- **Instellingen › Teammap** kiest vanaf twee teams eerst het team; **Bestanden** toont dan een knop per teammap; de
  bot-editor (*Mappen*) toont de teammappen die de bot echt krijgt.
- Vanaf twee teams elders: een teamkeuze in **Teamwerk** (beslissingen onder *Wacht op jou* blijven van alle teams,
  met het team erbij), het team en *Bots van andere teams toestaan* in de **groepsinstellingen**, en *Per bot / Per
  team* bij het **verbruik**.
- Vanaf twee teams volgen **Routines**, **Kanalen**, **Mijn skills** en het **verbruik per bot** de teamkiezer
  (`useFollowTeam()` in `follow.ts`, bovenop `useTeamView()`/`<TeamFilterNote>` van A3), met *Alle teams tonen*; onder
  *Alle teams* staat het team bij elk item. Skills installeren vraagt *Installeren voor: team … / Alle teams*, en een
  skill verhuist op zijn eigen pagina naar een ander team of naar alle teams. In de teaminstellingen staat de kaart
  **Gratis doorschakelen voor dit team** (`TeamChain.tsx`): aan/uit, minimumniveau voor belangrijk werk en weekreserve,
  elk op *zoals bij alle teams* of eigen.

## Tests

- `tests/stuck-work.test.ts` (0.4.4 P2): vastgelopen werk één keer gemeld door de hoofdbot, met team en waar je
  antwoordt; *Opnieuw proberen* start precies één keer; niets zonder hoofdbot; controle vooraf van routines.
- `tests/teams-isolation.test.ts`: twee teams met elk bots, een map en een sleutel alleen voor dat team. Elke *probe*
  probeert als bot van team A iets van team B te bereiken via de echte tool-lus (map lezen, bladeren, zoeken,
  schrijven, bewerken; B's map als extra map; een werkmap die B's map bevat; B's sleutel als hoofd- en als
  reserve-engine; B's app en login; `delegate_task`, `message_bot`, `ask_bot`, `handoff`, `broadcast`; een taak voor
  B's bot; werk geven aan een bot van A die B aanstuurt (leider), aan een bot van A die bij B meekijkt, en aan de
  hoofdbot; B's beslissingen, logboek, gebeurtenissen en eigen tabel via `team_query`/`team_tables`; schrijven in B's
  database met `team_execute`; een antwoord op een beslissing van B; meedoen in een groep van B, daar meelezen en
  groepsbestanden schrijven; zoeken naar B's teammap, routines, gesprekken en groepsgesprek) en draait drie keer:
  zonder toegang (alles geweigerd), met meekijken (alleen lezen) en met aansturen (ook werk geven). Plus: B's eigen
  bots werken gewoon, de gedeelde sleutel werkt in beide teams, niets van B in de prompt van A; de eigenaar ziet alle
  teams met een teamfilter (Teamwerk, groepen, zoeken); het dagbudget van een team stopt een run vóór de stap die het
  zou overschrijden; verbruik per team; de update vanaf 0.3 (teamdatabase en groepen in Mijn team).
  Geheugen (golf 2): zoeken op woorden en op betekenis (vectoren), `memory_get`, het per-beurtblok, dossiers en hun
  documenten, gesprekssamenvattingen, B's teamregel in de prompt van A, en elke schrijfweg in B's geheugen; met een
  eigen test voor B's eigen bots, regels per team, kennis voor alle teams en het teamfilter van de eigenaar.
  Kanalen, skills en routines (B4, `B4_PROBES`): `channel_list` (meekijken ziet het kanaal alleen-lezen),
  `channel_send` via B's kanaal, de eigenaar die bot A op B's kanaal bij naam noemt, `skill_load` en de vermelding van
  B's skill in de prompt van A (meekijken mag lezen), `skill_run_script` van B's vertrouwde script, `skill_draft` met
  de naam van B's skill, `routine_list`, een chattrigger "elk kanaal" van A op B's kanaal, een routine van A die via
  B's kanaal bezorgt, en *Daarna starten* naar B's routine. Plus een eigen test: B's eigen bots gebruiken B's kanaal,
  skill en routine, het teamfilter van de eigenaar, *voor alle teams*, gratis doorschakelen per team, een kanaal dat
  meegaat met zijn bot, en de update (kanalen en skills in Mijn team, of voor alle teams).
- `tests/teams.test.ts`: lege start, update vanaf 0.3 (bots, organigram, taken, teammap), de API, het bedrijfsprofiel
  in de beurtcontext.
- `tests/teams-org.test.ts` (nep-provider): de eigenaar maakt één hoofdbot (een tweede, een hergebruikte keuze of een
  sjabloon met de vlag maakt er geen; geen teamleider; weer gewone bot; een bestaande bot wordt hoofdbot); de hoofdbot
  geeft een vraag aan de teamleider van het juiste team (van twee), die een deel doorgeeft aan een bot van zijn team,
  en het resultaat komt met bewijs terug langs de keten (niet de tussenstand); een leider met *aansturen* op twee teams
  stuurt beide teamleiders aan; geweigerd in code: een ander team zonder toegang, om de muur heen via een leider of de
  hoofdbot, de 4e keer doorgeven en A→B→A; één team met de hoofdbot en specialisten zonder teamleider (werk direct naar
  de passende specialist, geen waarschuwing); het overzicht met open taken, wat op jou wacht, fouten en gemiste runs.

## Beperkingen en wat nog gedeeld is

- Per team sinds B3: **geheugen en dossiers**; sinds B4: **kanalen**, **skills** en **routines** (en gratis
  doorschakelen als de eigenaar dat per team instelt). Bewust gedeeld: sleutels en logins (standaard voor alle teams,
  per sleutel *alleen dit team*), skills die de eigenaar *voor alle teams* zet, en *Wacht op jou* (alles van alle
  teams, met het team erbij). Zoeken rekent een kanaal of routine tot het team van zijn bot.
- Een kanaal hoort bij het team van zijn bot: verhuist de bot, dan gaat het kanaal mee (er is geen los "teamveld" om in
  te stellen). Een WhatsApp-koppeling (QR) delen alleen de bots van dat team.
- Wie een team dupliceert (`copyTeamData`), krijgt geen kanalen of skills mee; skills *voor alle teams* zijn er al.
- Het takenbord `room_tasks` en de tabel `taken` in de teamdatabase: `taken` staat sinds B2 in de database van elk
  team (het volgt het databasebestand); aan de taken-logica zelf is niets veranderd.
- Verbruik en dagbudget per team tellen het verbruik van de **huidige** bots van het team: een bot die naar een ander
  team gaat, neemt zijn verbruik mee.
- Een team verwijderen kan alleen als het leeg is; zijn teamdatabase blijft als bestand staan
  (`teamdata/<eigenaar>.<team>.db`) en is daarna niet meer in beeld. Zijn groepen gaan naar het team van hun bots.
- De hoofdbot krijgt het bedrijfsprofiel van zijn eigen thuisteam mee, niet dat van de teams die hij aanstuurt.
- Of de hoofdbot echt het juiste team en de juiste bot kiest, hangt af van het model; de regels (toegang, diepte,
  lussen, één hoofdbot) staan in de code. Een heel klein lokaal model (getest: qwen3 1.7B) gebruikte in een korte
  proef `task_create` in plaats van `delegate_task`; kies voor de hoofdbot een sterk model.
- Het organigram (*Organisatie*, `room_teams`) heet in de UI nog "teams"; het zijn afdelingen binnen een team.
- Een werkmap is geen sandbox: de terminal-tool kan buiten de mappen (staat standaard uit en vraagt goedkeuring), en de
  sandbox van Codex mag overal lezen. Een CLI-engine met een werkmap die de map van een ander team bevat, kan daar met
  zijn eigen tools bij; zet teammappen dus niet binnen de werkmap van een bot.
- Een gedeelde provider van de beheerder op een server die *alleen voor zijn team* staat, kunnen leden niet gebruiken.
