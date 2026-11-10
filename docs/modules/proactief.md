# Proactief werken: vaste taken, projecten, kansen, overzicht en herinneringen

Geen eigen module: het zit in de modules die er al waren. Server: `server/modules/routines/duties/` (vaste taken,
herinneringen, budget), `server/modules/teamdata/projects.ts` en `kansen.ts` (tabellen `projecten` en `kansen` in de
teamdatabase), `server/modules/teams/briefing.ts` (overzicht van de hoofdbot), `server/modules/notifications/owner.ts`
(naar de chat-app van de eigenaar), `server/modules/templates/defs/prive.ts`. UI: `ui/src/modules/routines/Werk.tsx`
(`#/m/routines/werk`). Tests: `tests/proactive-duties.test.ts`, `tests/proactive-loop.test.ts`; met een echt lokaal
model: `tests/e2e/proactive.mjs`.

## Vaste taken

Een vaste taak is een gewone routine met `options.duty = { key, check, source, okWhen, onProblem, guard?, projectId? }`.
De planner, limieten en bonnetjes zijn die van de routines; er is geen tweede planner.

- **Voor elke rol.** Niets in de code hangt aan een rolnaam. Welke vaste taken een bot krijgt, komt uit **presets**
  (`catalog.ts`): gewone gegevens met woorden die de bot herkennen (in rol, naam of beschrijving) en de vaste taken
  die hij dan krijgt. De ingebouwde presets (SEO, Merchant Center, Advertenties, Klantenservice, Researcher, Bouwer,
  Persoonlijke assistent) zijn voorbeelden; de eigenaar voegt eigen presets toe (`GET/PUT /api/proactive/presets`,
  instelling `proactive.presets`) en die werken precies zo. Elke bot met een rol krijgt *Open taken afmaken*; de
  hoofdbot *Kansen scoren*.
- **Een rol die niemand voorzag** (geen preset past): de bot krijgt één run *Vaste taken bedenken*, waarin hij uit
  zijn rol, beschrijving en gekoppelde apps 1 tot 3 vaste taken voor zichzelf instelt met `duty_set`. De eigenaar
  krijgt per vaste taak een melding en past ze aan of haalt ze weg bij Werk. In *Vraagt toestemming* is elke
  `duty_set` eerst een toestemmingskaart.
- **Vragen in de chat**: "houd X elke ochtend in de gaten" → de bot stelt het in met `duty_set` (naam, wat, in orde
  als, hoe vaak: elke N minuten of dagen en tijden, en optioneel een meting); `duty_remove` haalt hem weg.
- **Een meting is een algemeen bouwblok** (`duty.measure`, `DutyService.measure`), voor elke vaste taak:
  `site` (de websites van het team), `url` (één adres: status, snelheid, een tekst die erop moet staan), `tool` (een
  lees-tool van een gekoppelde app bij zijn echte naam, één getal uit het antwoord tegen een grens) en `query` (één
  getal uit de teamdatabase tegen een grens). TeamBot meet dan zelf; de bot wordt alleen gewekt als het niet in orde is.
- **Eerst meten, zonder model** (`DutyService.before`, aangeroepen door de engine vlak voor de bot gewekt zou worden):
  - `site`: TeamBot haalt de websites van het team zelf op (`checks.ts`): status, snelheid, noindex, robots.txt,
    titel, beschrijving, sitemap en een steekproef van 12 pagina's uit de sitemap. De websites van een team zijn
    `profile.sites` plus adressen die in het profiel staan (`teams.sitesOf`).
  - `tasks`: de open taken van de bot in `taken`. `kansen.scoren`: kansen zonder scorekaart.
  - Is alles in orde, dan eindigt de run als *niets nieuws*: één regel op het bonnetje, geen modelaanroep, geen melding.
- **Een probleem is één taak** in `taken` van het team, met `klaar_als`, de meting in `beschrijving` en `bron`
  (`vaste-taak:<routine>:<sleutel>`). Voor hetzelfde open probleem komt nooit een tweede taak. Vindt de volgende
  meting het probleem niet meer, dan sluit TeamBot de taak met die meting als bewijs. Een probleem dat op `kon_niet`
  of geannuleerd staat, komt 14 dagen niet terug.
- **Wat ontbreekt, wordt gezegd**: zonder website of zonder gekoppelde app wacht de vaste taak stil en staat erbij wat
  er nodig is. Een bron is gekoppeld als de bot een van de echte tools van de ingebouwde Google-server heeft
  (`SOURCE_APP`: `gsc_*`, `merchant_*`, `ads_*`, `ga_*`, `calendar_events`); de opdracht noemt die tools bij naam.
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
  - `runsPerDay`: hoogstens zoveel botbeurten per dag voor proactief werk (0 = geen limiet). Daarboven eindigt een run
    stil als *limiet*; een probleem wordt nog wel een taak.
  - `cheapFirst`: proactief werk gaat eerst naar een gratis of lokaal model en schakelt dan nooit door naar een
    betaalde of abonnementsengine (`meta.frugal`, `agent/engines.ts`).

## Projecten (`projects.ts`)

Vaste stappen: inspectie → diagnose → plan → uitvoeren → meten → tip-top. De volgorde en wat elke stap moet opleveren
staan in de code: een nulmeting met cijfers, bron en datum; een diagnose; een plan met `klaar_als` en taken
(`taken.project_id`); alle taken dicht; een nieuwe meting. Bij een project met een website meet TeamBot de site zelf
bij de start en bij *meten*; vindt die meting nog fouten, dan wordt het project niet tip-top. Hoogstens `maxSprint`
(standaard 3) projecten per team in de sprint; de rest wacht en schuift vanzelf door. Bij tip-top blijven de vaste
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
