# Proactief werken: de werklus, vaste taken, projecten, kansen, overzicht en herinneringen

Geen eigen module: het zit in de modules die er al waren. Server: `server/modules/routines/duties/` (de werklus
`work.ts`, vaste taken, herinneringen, de optionele limiet), `server/modules/teamdata/projects.ts` en `kansen.ts`
(tabellen `projecten` en `kansen` in de teamdatabase), `server/modules/teams/proactive.ts` (check-in van de hoofdbot)
en `briefing.ts` (overzicht), `server/modules/notifications/owner.ts` (naar de chat-app van de eigenaar),
`server/modules/templates/defs/prive.ts`. UI: `ui/src/modules/routines/Werk.tsx` (`#/m/routines/werk`). Tests:
`tests/work-loop.test.ts`, `tests/proactive-duties.test.ts`, `tests/proactive-general.test.ts`,
`tests/proactive-loop.test.ts`, `tests/teams-proactive.test.ts`; met een echt lokaal model: `tests/e2e/proactive.mjs`
(nog van vóór de werklus: verwacht automatisch aangemaakte vaste taken en moet worden bijgewerkt).

## Uitgangspunt: het goede werk, niet zomaar werk

Op de pc van de eigenaar (10–11 nov 2026, 0.4.4) maakte TeamBot in één nacht 49 routines aan; 64 runs eindigden
allemaal als *niets nieuws*, 59 daarvan zonder dat er ooit een model was aangeroepen. Vijf echte taken stonden intussen
onaangeroerd op het takenbord, en een bot leerde 452 feiten over een gemeente waar het bedrijf niets mee te maken heeft.
Sindsdien geldt:

- **Geen bot krijgt iets vanzelf.** Geen vaste taak per rol, geen *Open taken afmaken* voor iedereen, geen ronde
  *Vaste taken bedenken*. Wat een bot doet, komt uit wat de eigenaar zei en uit de taken en projecten van het team.
- **Werk dat er ligt, wordt nu gedaan**, door de bot van wie het is, op zijn eigen model met al zijn tools (de werklus).
- **Geen rem, maar ook geen zinloze beurten.** Zonder werk start er geen beurt en wordt er niets ingepland; voor
  precies dezelfde lijst start geen tweede beurt.
- **Toestemming alleen bij geld, een eerste bericht aan een nieuw contact en mail aan klanten**: één keer vragen met
  een concreet voorstel, en intussen door met de rest.

## De werklus (`duties/work.ts`)

Bij elke verandering (gebeurtenissen `rooms.task` en `teamdata.changed`, binnen 3 seconden) en elke minuut kijkt
TeamBot per bot naar het werk dat er echt ligt. Dat is lezen uit de eigen administratie, zonder model:

- taken op zijn naam op het takenbord (`room_tasks`: te doen, bezig) en in de teamdatabase (`taken`: open, bezig);
- projecten in de sprint waarvan hij eigenaar is, als de volgende stap aan hem is (tijdens *uitvoeren* met open taken
  loopt het project via die taken);
- voor de hoofdbot ook: taken zonder eigenaar, projecten zonder bot erachter, wat terugkwam en bekeken moet worden
  (*te controleren*, *geblokkeerd*, `wacht_op_controle`, `kon_niet` van de laatste 3 dagen) en kansen zonder scorekaart.

Ligt er werk en is de bot niet bezig, dan krijgt hij een beurt in zijn eigen chat (trigger `work`) met precies die
lijst en de werkwijze: nu doen, elk punt afmelden met bewijs of met de reden, toestemming één keer vragen en door met de
rest, geen werk verzinnen en geen wachtpunt zetten om het uit te stellen. De hoofdbot krijgt erbij dat hij stuurt:
eigenaar kiezen, de volgende stap van een project uitzetten, controleren wat terugkomt. Zo loopt de keten zonder klok:
taak zonder eigenaar → hoofdbot geeft hem aan de juiste bot → die bot werkt → wat terugkomt gaat naar de hoofdbot.

- **Niet twee keer voor dezelfde lijst.** Per bot onthoudt TeamBot voor welke lijst (de punten, niet de tekst) de
  laatste beurt is gestart (instelling `proactive.work`). Een nieuwe beurt start zodra de lijst verandert: een taak
  afgemeld of geparkeerd, een nieuwe taak, een project een stap verder. Verandert er niets, dan volgt na 20 uur nog een
  poging (de opdracht zegt dan dat het dezelfde lijst is), hoogstens 3 in totaal.
- **Wanneer er geen beurt start**: geen werk; de bot is bezig of wacht op een goedkeuring; de eigenaar typte in de
  laatste 5 minuten met die bot; er is geen AI gekoppeld; de limiet die de eigenaar zelf zette, is bereikt; of de
  eigenaar heeft de bot gestopt (stopknop of *Alles stoppen*): dan begint hij niet uit zichzelf opnieuw. Zijn werk
  blijft op zijn naam; de lus kijkt er weer naar na zijn volgende beurt (de eigenaar of een collega gaf hem iets, of de
  eigenaar koos *Hervatten*).
- **Het bonnetje**: wat de bot zei staat in zijn eigen chat; `audit` krijgt `work.run` (aantal punten, hoeveel er van
  de lijst af zijn, hoeveel tools er zijn gebruikt, de uitkomst). Een beurt zonder iets te melden verdwijnt uit de chat.
  De hoofdbot meldt zijn beurt ook als melding en in de chat-app van de eigenaar.
- `GET /api/proactive/work`: per bot wat er ligt, hoe de laatste beurt ging en waarom er nu geen beurt start.
- Onder de testrunner staat de lus uit (`work.enabled`), omdat andere tests modelaanroepen tellen.

## Check-in van de hoofdbot (`teams/proactive.ts`)

Elke werkdag op het uur van de eigenaar, en tussendoor als iets nieuws hem nodig heeft. De opdracht bevat de feiten van
TeamBot én de doelen van de eigenaar zoals TeamBot ze kent: de projecten in de sprint met hun volgende stap, de
wachtende projecten en hoeveel taken er open staan. De hoofdbot doet in die beurt zelf wat hij kan doen of uitzetten
(taak met eigenaar, `delegate_task`, `project_start`, `project_stap`) en stelt hoogstens één vraag, alleen voor iets waar
het ja van de eigenaar echt voor nodig is. Loopt er geen project en staat er geen taak open, dan start hij het project
waarvan hij weet dat de eigenaar het wil, of vraagt hij welk doel eerst; hij verzint er zelf geen.

Heeft de eigenaar de hoofdbot net gestopt (stopknop of *Alles stoppen*), dan komt er de eerste vier uur geen check-in:
zijn stop maakt de weg niet vrij voor een beurt die de hoofdbot uit zichzelf begint. Op het volgende uur van de
check-in komt hij weer gewoon.

## Vaste taken

Een vaste taak is een gewone routine met `options.duty = { key, check, source, okWhen, onProblem, guard?, projectId? }`.
De planner, limieten en bonnetjes zijn die van de routines; er is geen tweede planner.

- **Alleen als iemand erom vraagt.** De eigenaar maakt er een bij Werk of vraagt het in de chat ("houd X elke ochtend
  in de gaten"): de bot stelt hem in met `duty_set` (naam, wat, in orde als, hoe vaak: elke N minuten of dagen en
  tijden, en optioneel een meting); `duty_remove` haalt hem weg. `duty_set` weigert een vaste taak die nog niets kan
  meten (de app of tool is er niet).
- **Presets zijn een bibliotheek, geen automaat.** De ingebouwde presets in `catalog.ts` (SEO, Merchant Center,
  Advertenties, Klantenservice, Researcher, Bouwer, Persoonlijke assistent) zijn voorbeelden om uit te kiezen
  (`POST /api/proactive/duties` met `key`). Alleen presets die de eigenaar zelf schreef (`PUT /api/proactive/presets`,
  instelling `proactive.presets`) worden toegepast op de bots die ze herkennen: dat is zijn eigen opdracht.
- **Opruimen na de update** (`DutyService.retire`, één keer per eigenaar): wat TeamBot vroeger zelf aanmaakte en nooit
  iets opleverde, wordt gearchiveerd: een ingebouwde vaste taak van de oude automaat die niemand aanpaste, de ronde
  *Vaste taken bedenken*, en wat een bot in die ronde bedacht. "Nooit iets opgeleverd" = geen enkele run met een
  botbeurt, een bevinding of een gemaakte of gesloten taak. Blijft altijd: wat de eigenaar maakte of aanpaste, wat een
  bot in een gesprek instelde, een bewaker van een project, herinneringen, gewone routines en alles wat ooit iets vond.
  Gearchiveerd is niet weg: de hele routine staat in `proactive.archived`, elke routine staat in het logboek
  (`routine.archived`), de eigenaar krijgt één melding en ziet ze bij Werk onder *Opgeruimd*, met *Terugzetten*
  (`GET /api/proactive/archived`, `POST /api/proactive/archived/:id/restore`).
- **Een meting is een algemeen bouwblok** (`duty.measure`, `DutyService.measure`), voor elke vaste taak:
  `site` (de websites van het team), `url` (één adres: status, snelheid, een tekst die erop moet staan), `tool` (een
  lees-tool van een gekoppelde app bij zijn echte naam, één getal uit het antwoord tegen een grens) en `query` (één
  getal uit de teamdatabase tegen een grens). TeamBot meet dan zelf; de bot wordt alleen gewekt als het niet in orde is.
- **Eerst meten, zonder model** (`DutyService.before`, aangeroepen door de engine vlak voor de bot gewekt zou worden):
  - `site`: TeamBot haalt de websites van het team zelf op (`checks.ts`): status, snelheid, noindex, robots.txt,
    titel, beschrijving, sitemap en een steekproef van 12 pagina's uit de sitemap. De websites van een team zijn
    `profile.sites` plus adressen die in het profiel staan (`teams.sitesOf`).
  - Is alles in orde, dan eindigt de run als *niets nieuws*: één regel op het bonnetje, geen modelaanroep, geen melding.
- **Een probleem is één taak** in `taken` van het team, met `klaar_als`, de meting in `beschrijving` en `bron`
  (`vaste-taak:<routine>:<sleutel>`). Voor hetzelfde open probleem komt nooit een tweede taak. Vindt de volgende
  meting het probleem niet meer, dan sluit TeamBot de taak met die meting als bewijs. Een probleem dat op `kon_niet`
  of geannuleerd staat, komt 14 dagen niet terug.
- **Niets om naar te kijken = niet ingepland.** Zonder website of zonder gekoppelde app zegt de vaste taak wat er
  nodig is en parkeert hij zichzelf (op pauze met `Wacht: …` als reden) in plaats van op schema voor niets te draaien;
  zodra de bron er is, gaat hij vanzelf weer aan (`park`, `unpark`). Een bron is gekoppeld als de bot een van de echte
  tools van de ingebouwde Google-server heeft (`SOURCE_APP`: `gsc_*`, `merchant_*`, `ads_*`, `ga_*`,
  `calendar_events`); de opdracht noemt die tools bij naam.
- **Onbeantwoorde klantberichten** meet TeamBot zelf uit de kanaalgegevens (`checkInbox`): gesprekken waar het
  laatste bericht van de klant ouder is dan 4 uur en er daarna niets is verstuurd. Het eigen gesprek van de eigenaar
  en gepauzeerde gesprekken tellen niet.
- **Klaar is pas klaar na een meting.** Zet een bot een taak van een gemeten vaste taak op `klaar`, dan meet TeamBot
  meteen zelf opnieuw (`remeasure`, in `team_execute`). Probleem weg: klaar, met de meting als bewijs. Nog niet weg:
  terug naar `open` met wat er nog mis is, en de bot hoort dat. Bij de geplande controle worden pagina's die in een
  taak genoemd staan apart nagekeken voordat die taak sluit.
- **De run hangt niet af van `duty_report`.** Roept de bot hem niet aan, dan legt TeamBot zelf vast wat het gemeten
  heeft, of welke tools van de bron de bot echt aanriep en dat er geen uitkomst gemeld is (`DutyService.after`).
- **De bot wekken** gebeurt alleen als er iets te doen is. De bot krijgt wat er gemeten is
  en sluit af met `duty_report` (`in_orde`, `probleem`, `opgelost`, `kon_niet`). Een punt zonder cijfer of bron wordt
  geweigerd.
- **Geen limiet, tenzij de eigenaar er een zet.** Een vaste taak draait op het eigen model van zijn bot, zo vaak als
  zijn schema zegt (ook elke minuut: de app weigert geen frequentie), net als ander werk. Wat ander werk begrenst,
  geldt hier ook: de limieten van de aanbieder, de reserveketen, en een gebruikslimiet of budget dat de eigenaar zelf
  zette. Controles zonder model zijn geen botbeurten en tellen nergens mee, ook niet voor de run-limieten van routines.
  Twee keuzes, beide standaard uit (`PUT /api/proactive/settings`):
  - `runsPerDay`: hoogstens zoveel botbeurten per dag voor proactief werk (0 = geen limiet); beurten van de werklus
    tellen mee. Daarboven eindigt een run stil als *limiet* en start de werklus geen beurt; een probleem wordt nog wel
    een taak.
  - `cheapFirst`: proactief werk gaat eerst naar een gratis of lokaal model en schakelt dan nooit door naar een
    betaalde of abonnementsengine (`meta.frugal`, `agent/engines.ts`).

## Projecten (`projects.ts`)

Vaste stappen: inspectie → diagnose → plan → uitvoeren → meten → tip-top. De volgorde en wat elke stap moet opleveren
staan in de code: een nulmeting met cijfers, bron en datum; een diagnose; een plan met `klaar_als` en taken
(`taken.project_id`); alle taken dicht; een nieuwe meting. Bij een project met een website meet TeamBot de site zelf
bij de start en bij *meten*; vindt die meting nog fouten, dan wordt het project niet tip-top. Geen maximum aantal
projecten in de sprint, tenzij de eigenaar er een instelt (`maxSprint`, standaard 0 = geen; Werk › Projecten); boven dat maximum
wacht een nieuw project en schuift het vanzelf door, ook zodra het maximum omhoog gaat of weg is. Bij tip-top blijven de vaste
taken van de bot als bewaker achter (`duty.guard`). Tools: `project_start`, `project_stap`, `project_list`.

## Kansen (`kansen.ts`)

`kans_melden` slaat een kans alleen op met minstens één bron met webadres en datum, minstens één bron van de laatste
90 dagen, kosten, risico en een mini-test. `kans_scoren` (alleen de hoofdbot, als die er is) geeft vijf cijfers; de
score rekent TeamBot uit. Eén keer per week gaan de beste drie naar de eigenaar (*Wacht op jou*, een melding en zijn
chat-app). Alleen zijn *ja* maakt er werk van: een mini-test als project. Geen bot-tool kan beslissen.

## Overzicht van de hoofdbot (`briefing.ts`)

Elke dag of week (instelling `briefing`, tijd `briefingTime`), zonder modelaanroep: wat klaar is, wat veranderde
(nieuwe problemen, cijfers van de controles tegenover het vorige overzicht, stappen van projecten), wat op de
eigenaar wacht en wat er van hem nodig is. Een dag waarop niets gebeurde en niets wacht, geeft geen bericht. Met een
hoofdbot staat het in zijn chat; zonder hoofdbot is het een melding en staat de tekst op de pagina Werk.

## Herinneringen

`reminder_set` en `reminder_cancel` (groep *Herinneringen*, altijd aan). Een herinnering is een routine met
`options.reminder`; op het tijdstip meldt TeamBot het zelf, zonder model: als melding (belangrijk), in de chat met de
bot en via de chat-app van de eigenaar (`tellOwner`: alleen naar *Dit ben ik* op een kanaal van die bot of zijn team).

## Privé

Het sjabloon `prive` (Assistent, Opzoeker, Kasboek) maakt in één klik een eigen team: eigen geheugen, map en
teamdatabase, en geen toegang over en weer met de bedrijfsteams.

## API

`GET/PUT /api/proactive/settings`, `GET/POST /api/proactive/duties`, `GET/POST /api/proactive/projects`,
`POST /api/proactive/projects/:id/stop`, `GET /api/proactive/kansen`, `POST /api/proactive/kansen/:id/decide`,
`GET/POST /api/proactive/briefing`.

## Beperkingen

- Search Console, Merchant Center en Agenda zijn getest tegen de lokale nep-Google van de Google-koppeling, niet met
  echte accounts; Ads en Analytics alleen op herkenning van hun tools.
- De sitecontrole leest de HTML zoals de server hem geeft; een pagina die alleen met JavaScript inhoud toont, ziet hij
  niet volledig.
- Een klein lokaal model sluit een run niet altijd af met `duty_report`. De taken staan er dan al (TeamBot maakte ze
  zelf); alleen de samenvatting van de bot ontbreekt.
- Vaste taken draaien alleen zolang TeamBot draait; na een nacht uit volgt één inhaalrun.
