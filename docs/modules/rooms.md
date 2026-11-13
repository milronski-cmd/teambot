# Module `rooms` — Groepen & teams

Server (subagent) + UI (hoofdsessie, na overname op 2026-11-06). Plan: §21.3, §14 (gedeelde rooms), §15 journey 5.

## Wat het doet

- **Groepen** (thread kind `room`): naam, bots, groepsinstructies, gedeelde transcript. Werkwijzen:
  - *lead*: de lead-bot antwoordt en verdeelt het werk;
  - *om de beurt*: bots antwoorden na elkaar en zien elkaars bijdragen;
  - *iedereen*: alle bots tegelijk, als aparte runs;
  - *alleen op vermelding*.
  `@naam`, `@iedereen`/`@all` en "reply" sturen gericht. Een expliciete vermelding gaat vóór de werkwijze.
- **Per bot** blijven model, rechten en geheugen eigen. De per-beurt-context wordt per bot bevroren
  (`parts.contextByAgent`). Tool-verkeer van andere bots is onzichtbaar. Berichten die binnenkomen terwijl een bot nog
  tools uitvoert, worden ná zijn tool-resultaten geplaatst.
- **Orkestratie-tools** (groep `team`, ook buiten groepen):

  | Tool | Risico | Wat |
  |---|---|---|
  | `delegate_task` | write | Begrensde subtaak in een eigen thread (kind `delegation`, `parent_id`); resultaat komt terug als event + vervolgbeurt (async) of direct (wachten). |
  | `broadcast` | write | Zelfde vraag parallel aan gekozen leden, elk als eigen run. |
  | `handoff` | write | Eigenaarschap overdragen; terug-overdragen in dezelfde keten wordt geweigerd. |
  | `message_bot` | write | Direct bericht aan een andere bot. |
  | `propose_member` | write | Alleen de lead: stelt een nieuw teamlid voor; een mens keurt goed. |
  | `task_create` / `task_update` | write | Takenbord, met "klaar als" (`done_when`). Status done van een bot gaat via het afmeldpad (zie `task_done`). |
  | `task_claim` | write | Taak atomair claimen; een tweede bot kan dezelfde taak niet starten (module `quality`). |
  | `task_done` | write | Afmelden met bewijs (tweede blik → klaar of te controleren) of `outcome: cannot` met reden (module `quality`). |
  | `task_list`, `team_status` | read | Takenbord, wie doet wat. |
  | `room_files_list` / `room_file_read` | read | Gedeelde groepsbestanden. |
  | `room_file_write` | write | Gedeelde groepsbestanden (volgens rechten). |

- **Teams** (module `teams`, zie `docs/modules/teams.md`):
  - werk geven aan een bot van een ander team (`delegate_task`, `message_bot`, `ask_bot`, `broadcast`, `handoff`, of
    een taak met die bot als eigenaar) mag alleen met toegang *aansturen* op dat team; de ontvanger mag ook geen team
    aansturen of inkijken dat de afzender niet mag (geen weg om een muur heen via een leider of de hoofdbot), en de
    hoofdbot krijgt alleen werk van de eigenaar. Anders weigert TeamBot met de reden. "Bots die je kunt aanspreken"
    noemt alleen bereikbare bots;
  - **een groep hoort bij één team** (`rooms.workspace_id`, `walls.ts`): het gekozen team (`workspaceId`), anders het
    team van de afdeling, van de lead of van de eerste bot, anders het standaardteam;
  - **een bot van een ander team** komt er alleen in met *meekijken* of *aansturen* op het team van de groep, én als de
    eigenaar voor die groep **Bots van andere teams toestaan** aanzette (`settings.crossTeam`; ook in één stap met
    `crossTeam: true` bij het maken of toevoegen). Dat staat in het groepsgesprek, in de groepsinstellingen en als
    badge *Met bots van andere teams* in het overzicht;
  - zo'n bot ziet het groepsgesprek en leest de groepsbestanden, maar schrijft ze niet; het takenbord van de groep
    alleen met *aansturen*. Verliest hij zijn toegang, dan doet hij niet meer mee (de groep zegt waarom); uitzetten van
    *Bots van andere teams toestaan* kan pas als er geen bots van andere teams meer in zitten;
  - de systeemprompt van een groepsgesprek noemt (vanaf twee teams) het team van de groep, en voor een bot van een
    ander team wat hij daar mag.
- **Ketens** (hoofdbot → leider → teamleider → bot): de resultaten gaan terug langs dezelfde keten.
  - Geeft een bot in een gedelegeerde subtaak (`delegate_task`) een deel door en rondt hij zijn beurt af, dan is die
    subtaak nog niet klaar: hij **wacht** op de antwoorden (status "wacht op …", een melding in het subgesprek). Zodra
    die binnen zijn, krijgt hij een vervolgbeurt in hetzelfde subgesprek; die beurt rondt de subtaak af, en pas dan
    gaat zijn resultaat (met het bewijs) één stap omhoog. Zo krijgt de hoofdbot het gecontroleerde eindresultaat en
    niet de tussenstand "ik heb het doorgezet".
  - Kan die vervolgbeurt niet starten (bijv. het maximum aantal botbeurten), dan gaat de subtaak met de reden als
    *fout* omhoog. Stoppen (`delegation_cancel`, de stopknop van de subtaak, of de opdrachtgever stoppen) stopt ook
    de verzoeken waarop hij wacht; niemand wordt er dan nog voor gewekt.
  - Elke stap is zichtbaar: een eigen subgesprek per stap (`parent_id`), in de opdracht "Keten: A → B → C." vanaf de
    tweede stap, en "Dit werk is al 3 keer doorgegeven, het maximum: je kunt het niet verder doorgeven" voor de bot
    onderaan; "Resultaat teruggestuurd naar …" in elk subgesprek.
  - Dit geldt voor `delegate_task`. Een `ask_bot`-antwoord blijft wat de ontvanger in zijn beurt antwoordt.
- **Stoppen door de eigenaar start niets.** Eén plek zegt "dit heeft de eigenaar gestopt" (`agent/runs.ts`):
  `RunManager.cancel` schrijft het op zodra hij drukt, `stoppedByOwner` leest het voor een beurt of een verzoek, en
  `RunManager.ownerStopped(agentId)` voor een bot ("door de eigenaar gestopt en sindsdien geen beurt gehad"). Alles
  wat uit zichzelf een beurt begint om verder te gaan met eerder werk vraagt het daar: vervolgbeurten en wachtende
  botberichten (hier), de werklus en de check-in van de hoofdbot (`docs/modules/proactief.md`), en het herstel na een
  herstart. Het geldt voor de stopknop van een chat of van een subtaak, *Alles stoppen*, `/stop` in een chat-app en de
  noodstop, ook voor één gestopte bot. (Een groep stoppen of een bot in een groep pauzeren is iets anders: de groep
  wacht tot de eigenaar hem hervat en gaat dan verder. Schema's lopen door: een routine op haar tijd is een nieuwe
  beurt, geen gevolg van de stop.)
  - de bot die het werk gaf krijgt géén vervolgbeurt. In zijn gesprek komt een notitie ("Gestopt door de eigenaar: …
    Het is niet af en blijft van …"), die hij leest bij zijn volgende beurt, waardoor die ook start. Een echte uitkomst
    (klaar, fout, time-out) wekt hem wel, zoals altijd;
  - wat op de gestopte bot wachtte (antwoorden, botberichten in de wachtrij) wacht tot na zijn volgende beurt, ook
    over een herstart heen. Bij *Alles stoppen* vervalt via één haak (`hooks.stopAll`) ook wat nog vanzelf zou
    beginnen: wachtende botberichten, routine-runs die op een nieuwe poging wachten, een geplande nieuwe poging na een
    gebruikslimiet, en een workflow die bezig is of wacht (die krijgt *Gestopt door jou* in plaats van *liep vast*);
  - wordt TeamBot afgesloten vlak na de stop, dan blijft het een stop: na de herstart heet de beurt niet "onderbroken",
    wordt de subtaak niet opnieuw gestart en meldt de hoofdbot het niet als vastgelopen werk;
  - wachtte een subtaak alleen op het gestopte werk, dan stopt die mee en gaat de stop zo de keten omhoog;
  - een taak die de gestopte bot op *Bezig* had staat weer op *Te doen*, zonder claim, en blijft van die bot. Opnieuw
    starten is één stap: *Hervatten* in het gesprek van die bot (het resultaat van een subtaak gaat dan alsnog terug),
    of de bot die de taak gaf geeft hem opnieuw (`task_update` met dezelfde `owner`, of `delegate_task`);
  - de werklus pakt het werk van een gestopte bot niet uit zichzelf op (`docs/modules/proactief.md`).
- **Begrenzing**: geen ingebouwde rem. Alle grenzen zijn instellingen die standaard uit staan (0 = geen grens):
  - `maxTurnsPerMessage`, `maxAskTurns`, `maxDelegationDepth`, `maxHandoffs`, `maxBroadcastTargets`,
    `maxAsksPerHour`, `maxAsksPerPairPerHour` (bij diepte en overdrachten: -1 = helemaal niet);
  - wat vanzelf stopt is alleen een echte lus: in één keten geeft dezelfde bot dezelfde collega voor de derde keer
    hetzelfde verzoek, de twee keren ervoor kwam hetzelfde terug en er veranderde niets (geen taak die verder kwam,
    geen stap die iets schreef of de eigenaar iets meldde). De gever leest waarom, de eigenaar krijgt één melding;
  - stappen per beurt, time-outs per beurt en per delegatie;
  - **kostenplafond** en tokenplafond (de groep stopt en meldt dat);
  - cyclusdetectie (geen A→B→A).
- **Goedkeuringen** gaan altijd naar de eigenaar-mens van de bot (Broker). Een andere bot of een groepslid kan ze niet
  beantwoorden.
- **Organisatie** (`room_teams`, in de UI nog "teams"): afdelingen met een chief of staff (lead) en
  rapportagelijnen, binnen één team van de module `teams` (`workspace_id`; bij de update vanaf 0.3 allemaal in
  *Mijn team*). "Groep van dit team maken".
  **Takenbord** (te doen / bezig / te beoordelen / klaar / geblokkeerd) met eigenaar (bot of mens), deadline, bron
  en resultaat, en de vlag **Belangrijk** (`room_tasks.important`): zolang de eigenaar-bot zo'n taak *Bezig* heeft,
  draait zijn werk in die groep (of in het gesprek waar de taak gemaakt is) nooit onder het minimumniveau en pauzeert
  het in plaats van door te schakelen naar een gratis model ([engine-chain](engine-chain.md)). Een taak hoort bij het
  team van zijn bot-eigenaar (of van de bot die hem maakte); een bot ziet op het persoonlijke bord alleen taken van
  teams die hij mag lezen en wijzigt alleen taken van zijn eigen team of van een team dat hij aanstuurt. Taken zonder
  team (van de eigenaar zelf) ziet iedereen.
  **Aanname-voorstellen** (hire) worden pas na menselijke goedkeuring een bot (`access_mode: ask`).
- **Menselijke leden**: andere gebruikers van de server als *lid* of *gast* (gast ziet alleen die groep, geen
  takenbord), met uitnodigen, accepteren of weigeren, en intrekken. Meldingen van een groep komen bij de gewone meldingen (de bel).
- **Kostenledger** per bot per groep. Activiteitenlog (wie deed wat) en zoeken. Export naar Markdown/JSON, zonder
  bevroren contexten en ruwe providerdata.

## API (onder `/api`)

| Onderwerp | Routes |
|---|---|
| Groepen | `GET /rooms` (`?team=`: de groepen van één team), `POST /rooms` (`workspaceId?`, `crossTeam?`), `GET/PATCH/DELETE /rooms/:id` (PATCH ook `workspaceId`, `crossTeam`), `POST /rooms/:id/stop` (`{agentId?}`), `POST /rooms/:id/resume` (`{agentId?, continue?}`), `GET /rooms/modes`, `GET/PUT /rooms/defaults`. Een groep toont `workspaceId`, `workspaceName`, `crossTeam`, `foreignBots`; een bot `homeTeamId`, `homeTeamName`, `teamReach` (home/direct/read/none) |
| Leden | `POST /rooms/:id/bots` (`crossTeam?`), `PATCH/DELETE /rooms/:id/bots/:agentId` (rechten: `respond` auto/mention, `files` none/read/write, `tasks`, `delegate`; voor een bot van een ander team begrensd door zijn toegang); `POST /rooms/:id/people`, `PATCH/DELETE /rooms/:id/people/:userId`, `POST /rooms/:id/accept`, `POST /rooms/:id/decline`, `GET /rooms/people` |
| Teams | `GET/POST /rooms/teams`, `PATCH/DELETE /rooms/teams/:id`, `PUT /rooms/teams/:id/members`, `DELETE /rooms/teams/:id/members/:agentId`, `POST /rooms/teams/:id/room` |
| Takenbord | `GET/POST /rooms/tasks`, `PATCH/DELETE /rooms/tasks/:id` (ook `important: true/false`: *Belangrijk*, zie [engine-chain](engine-chain.md)); `POST /rooms/tasks/:id/start-after` `{ at }` (0.4.4, P3): *Start na de reset om …* uit de kostenschatting: de eigen bot die de taak doet krijgt hem dan in zijn eigen chat, als eenmalige routine (`Taak: <titel>`, belangrijk als de taak belangrijk is; nodig: module routines) |
| Voorstellen | `GET /rooms/proposals`, `POST /rooms/proposals/:id` (`{decision: approve\|deny}`) |
| Delegaties | `GET /rooms/delegations?threadId=`, `GET /rooms/delegations/by-call/:callId`, `POST /rooms/delegations/:id/cancel` |
| Overig | `GET /rooms/by-thread/:threadId`, `GET /rooms/:id/ledger`, `GET /rooms/:id/activity`, `GET /rooms/:id/search`, `GET /rooms/:id/export`, groepsbestanden `GET/POST/DELETE /rooms/:id/files` |

Events: `rooms.changed`, `rooms.member`, `rooms.delegation`, `rooms.task`, `rooms.team`, `rooms.files`.

Tabellen: `rooms` (met `workspace_id`, migratie `rooms-group-team`; bij de start krijgen groepen van vóór teams
hun team), `room_members`, `room_delegations`, `room_teams` (met `workspace_id`), `room_team_members`, `room_tasks`
(met `workspace_id`), `room_proposals`, `room_activity`, `room_inbox` (wordt niet meer gevuld; de tabel blijft).

Dienst `ctx.services.rooms`: ook `teamOf(roomId)` (het team van een groep) en `botTakesPart(roomId, agentId)` (lid
én mag nog meedoen), onder andere voor zoeken.

## UI

- Pagina **Groepen**: overzicht, uitnodigingen, aanname-voorstellen en de wizard *Nieuwe groep*.
- **Groepsinstellingen** (`#/m/rooms/groep/<id>`): algemeen, bots en rechten, mensen, kosten. Vanaf twee teams staat
  bij *Bots* het team van de groep, de schakelaar *Bots van andere teams toestaan* en per bot van een ander team zijn
  eigen team en toegang.
- **Takenbord**: sinds 0.4 het ene bord **Taken** (`#/tasks`, `ui/src/pages/Tasks.tsx`), samen met de tabel `taken`
  van de teamdatabase; `#/m/rooms/taken` toont hetzelfde bord. Kolommen *Te doen*, *Bezig*, *Te controleren*
  (`review`), *Klaar*, *Geblokkeerd*. Meldingen over een taak voor jou openen `#/tasks`.
- In de chat:
  - deelnemers met status in de kop;
  - *hele groep stoppen*;
  - de @-knop in de composer;
  - zijpaneeltab **Team** (leden en delegaties);
  - kaartjes bij `delegate_task`/`broadcast` met status en een link naar het subgesprek;
  - in de bot-editor een sectie *Groepen*.

## Tests

`tests/rooms.test.ts` — 23 tests:
- routing per werkwijze en @-vermelding;
- om-de-beurt ziet eerdere bijdragen;
- parallelle runs;
- delegatie async en wachtend;
- diepte-, beurten- en cycluslimieten;
- broadcast en handoff;
- kostenplafond;
- stop/hervat per bot en per groep;
- time-out per deelnemer;
- privé-isolatie;
- goedkeuringen alleen voor de eigenaar;
- ACL voor leden en gasten;
- takenbord en aanname-voorstel;
- bestanden, zoeken, export en attributie.

De teamgrenzen bij delegeren, op het takenbord en in groepen (meedoen, meelezen, groepsbestanden, een groep maken met
bots van twee teams, de update vanaf 0.3) staan in `tests/teams-isolation.test.ts`; de organisatie (hoofdbot, leiders,
teamleiders), resultaten terug langs de keten, de 4e stap en A→B→A in `tests/teams-org.test.ts`.

Live (2026-11-06): de OpenAI-bots *Schrijver* en *Onderzoeker* in lead-modus. De schrijver delegeerde het opzoekwerk,
kreeg "Canberra" terug en schreef de tweet.

## Beperkingen

- Groepsgesprekken met spraak en beurtwisseling op naam zijn er nog niet (zie voice).
- Delegatie-tools zijn team-intern (`internal`): in `ask`-modus vragen ze geen goedkeuring (de ontvangende bot houdt
  zijn eigen modus voor wat hij daarna doet); in *Alleen chat* en *Alleen lezen* kan een bot geen werk doorgeven.
  Strenger kan per bot via toolbeleid.
- Een team heeft nog geen vast eigen *teamgesprek* (plan B: "groep en team worden één begrip"); een team heeft
  gewone groepen die bij dat team horen.
- Een gedelegeerde subtaak in een groep (`delegate_task` vanuit de groep) kan naar een bot van een team dat de
  delegerende bot mag aansturen; die bot ziet alleen zijn opdracht, niet het groepsgesprek.
