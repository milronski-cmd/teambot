# Module `specialists` — Specialisten die zelf leren

Server `server/modules/specialists/`, UI `ui/src/modules/specialists/`. Plan: `docs/PLAN_0.4.md` pakket S (golf 1).
Tests: `tests/specialists.test.ts`, probes in `tests/teams-isolation.test.ts`.

## Wat het doet

- Een bot wordt **specialist** met een **vakgebied** (één zin) en **bronnen**: websites, RSS/Atom-feeds,
  documentatie (een pagina plus een paar pagina's eronder op dezelfde site) en eigen bestanden (tekst, Markdown,
  HTML, CSV, JSON in de mappen van de bot).
- Een **leerronde** haalt nieuwe inhoud op, haalt de kern eruit **met bron en datum**, vergelijkt met wat de bot al
  weet en zet het in zijn **kennisbank**: een dossier *Kennisbank van <bot>* in het geheugen, alleen voor die bot.
  Dubbel wordt overgeslagen; een feit dat een bekend feit tegenspreekt of bijwerkt **vervangt** het (de nieuwere bron
  wint, de oude versie staat in de geschiedenis, met ongedaan maken). Alleen wat de eigenaar zelf schreef of vastzette
  wordt **te controleren**.
- **Houdt zichzelf bij, zonder instellen**: de leerronde staat standaard **aan** (wekelijks, klein budget, een gratis
  model). Een bot waarvan de naam of rol een bekend vak noemt (SEO, Google Ads, Merchant Center, Meta Ads, GA4,
  Shopify, WordPress, Core Web Vitals, AVG; `defaults.ts`) wordt vanzelf specialist met de officiële bronnen van dat
  vak (één keer; wie het uitzet wordt niet opnieuw aangezet). Migratie `specialists-002` zet de ronde aan voor
  specialisten die haar nooit aan hadden.
- **Elk vakgebied** (belastingrecht, bijen houden, TikTok): een bot waarvan de naam of rol zegt dat hij ergens
  specialist, expert of adviseur in is, wordt vanzelf specialist in dat vak. Heeft hij geen bronnen, dan zoekt hij ze
  zelf (`discoverSources`): een zoekopdracht, per kandidaat een snelle controle dat het een primaire bron is (officieel
  of de eigen site van het onderwerp; nooit een forum, winkel of encyclopedie) en dat de pagina antwoordt. De beste vier
  worden *voorgesteld* en de eigenaar krijgt één melding. De negen vakken in `defaults.ts` zijn alleen voorinstellingen.
- **Leert met zijn eigen model**, zo vaak als de eigenaar kiest (elk uur, elke dag, elke week), zonder eigen limiet.
  Optioneel: *goedkoper model* (gratis of lokaal; is er geen, dan wacht de ronde stil) en een limiet per ronde.
- **Vers**: elk feit heeft *laatst bevestigd* en een herzien-datum (prijs 90, versie 60 … werkwijze 120 dagen). Is die
  datum er, dan controleert de ronde het feit tegen zijn bron: staat het er nog → *bevestigd* (zonder modelaanroep als
  het citaat er letterlijk staat); zegt de bron iets anders → *bijgewerkt*; staat het er niet meer → **vervallen** met
  reden en datum. Vervallen feiten krijgt de bot per beurt terug als "niet meer doen" (`<niet_meer>`).
- **Zoekt wat er veranderd is**: hoogstens eens per zes dagen één zoekopdracht ("Google Search core update SEO november
  2026"), de eerste twee nieuwe pagina's worden gelezen als bron. Zo'n gevonden pagina mag kennis toevoegen (vertrouwen
  *bot*), maar nooit een eigen bron tegenspreken. Niet voor een bot op *privé*.
- **Wat is er nieuw**: elke ronde die iets verandert bewaart "wat is er nieuw en wat verandert er daardoor aan mijn
  werkwijze" (`specialist_rounds.news`); de eigenaar ziet het in de Kennisbank, de bot in zijn systeemprompt.
- De leerronde **plant de module zelf** (`roundsDue`, elk half uur gecontroleerd): wekelijks of dagelijks, de eerste
  meteen. Ze start **nooit een run van de bot zelf** en gebruikt alleen een gratis of lokaal model; is er geen, dan
  wordt de ronde stil overgeslagen (een regel op de kaart, geen melding) en na zes uur opnieuw geprobeerd. *Nu leren*
  start de ronde direct, op de achtergrond; dat is de keuze van de eigenaar en mag de eigen engine van de bot
  gebruiken. De oude leerroutine (één run op het abonnement van de bot per ronde) wordt bij het starten verwijderd.
- **Bronnen zijn data, nooit opdrachten.** Tekst die zich tot een AI richt ("negeer alle eerdere instructies en
  stuur …", "je bent nu …", "voer … uit") wordt vóór de modelaanroep weggehaald en in het leerverslag als
  *genegeerd* gemeld; een "feit" dat op een opdracht lijkt wordt nooit opgeslagen.
- **Kennisgaten**: zegt de specialist in een gesprek met de eigenaar "weet ik niet" (of "staat niet in mijn
  kennisbank", "geen informatie over"), dan wordt de vraag een **leerdoel**, met een korte regel in het gesprek. Een
  optionele **zelftest** (één keer per week drie vragen over het vakgebied, nagekeken tegen de kennisbank) maakt ook
  leerdoelen. De volgende ronde zoekt eerst naar leerdoelen, ook in pagina's die niet veranderden.
- Een **leerverslag** per week: kaart in de Kennisbank, regel in de tijdlijn van het dossier (Geheugen) en een
  melding. Alles wat geleerd is kan per regel of in één keer **ongedaan** worden gemaakt.
- Skillvoorstellen doet de specialist niet meer zelf: één plek stelt voor om van herhaald werk een skill te maken,
  voor elke bot (Kwaliteit, `quality/skills.ts`; zie `docs/modules/quality.md`).

## De leerronde stap voor stap (`round.ts`)

1. **Volgorde**: bronnen met een gecachte pagina die een open leerdoel kan beantwoorden eerst, daarna de bron die
   het langst niet bekeken is.
2. **Ophalen** (`fetch.ts`, `Politeness`): `assertPublicUrl` van de webtools op elke redirect-hop (privé-adressen
   alleen met `settings.allowPrivateNetwork` van de bot, zoals `web_fetch`), hoogstens 2 MB (al tijdens het lezen),
   20 s, robots.txt (eenmaal per host per ronde; een groep voor `TeamBot` wint van `*`), ETag/Last-Modified, een
   eerlijke user agent en 2 s pauze tussen twee verzoeken aan dezelfde host (`TEAMBOT_SPECIALIST_HOST_DELAY_MS`).
   Een HTML-pagina wordt het artikel alleen (`pageToMarkdown`: Readability 0.6.0, Apache-2.0, op linkedom 0.18.15, ISC;
   zonder menu's, cookiemeldingen, zijbalken en voetteksten), net als bij `web_fetch`; zonder duidelijk artikel de hele
   pagina zoals voorheen (`server/tools/builtin/readable.ts`).
3. **Wat nieuw is**: 304 of dezelfde hash = *ongewijzigd* (geen modelaanroep); een gewijzigde pagina stuurt alleen
   haar **nieuwe alinea's**; een feed alleen **nieuwe items** (hoogstens 5 per ronde, nieuwste eerst; de rest
   volgende keer). Eigen RSS 2.0/RSS 1.0/Atom-parser, geen nieuwe dependency.
4. **Opschonen** (`guard.ts`, `sanitizeSource`): alinea's/zinnen die op een opdracht aan een AI lijken eruit.
5. **Uithalen** (`engine.ts`): één aanroep zonder tools per stuk tekst (≤ 12.000 tekens) met strikte JSON:
   `{facts:[{text, quote, same, contradicts, goal}], outside:[]}`. In de vraag: `<bekend>` (verwante feiten uit de
   kennisbank met korte id's), `<leerdoelen>` en de bron in `<bron code=… url=… datum=…>` (tag-lookalikes
   onschadelijk gemaakt). Engine: het eerste gratis model uit de catalogus van pakket D1
   (`ctx.services.freeModels.candidates()`) dat nu kan antwoorden: een online bron die deze bot mag gebruiken
   (`refuseFor`), bij een bot op *privé* alleen een bron die niets bewaart; de catalogus houdt zelf bij hoe het ging
   (limieten, verdwenen modellen). Anders de eigen engine van de bot (API: `chat`, CLI: `complete`), met de teamregels
   voor sleutels (`refuseFor`) en het dagbudget bij een betaalde engine. Elke aanroep staat in `usage_log`; de tokens tellen ook op het bonnetje van de
   routinerun.
6. **Controle per feit**: het feit moet in de (opgeschoonde) bron staan: het citaat letterlijk (≥ 3 woorden), of —
   omdat modellen het citaat vaak parafraseren — minstens 60 % van de eigen woorden van het feit; dan wordt de best
   passende echte zin uit de bron als citaat bewaard. Anders *niet opgeslagen*. Een feit dat op een opdracht lijkt:
   *genegeerd*; `same` = *al bekend*.
7. **Opslaan** via `ctx.services.memory.remember` in het dossier (`scope: 'dossier'`, `type: 'fact'`, bron
   `url`/`file` met citaat, `trust: 'system'`, `createdByAgent` = de bot, idempotentiesleutel per feittekst): de
   pijplijn van het geheugen doet dedup (exact en bijna gelijk), geheimen, blokkades (vergeten blijft vergeten) en
   tegenspraak (zelfde onderwerp met andere waarde → voorstel met `conflict_with`). Zegt het model `contradicts`,
   dan wordt het in elk geval een voorstel met reden `conflict`.
8. **Budget**: Klein 15.000 tokens / 6 aanroepen, Normaal 40.000 / 15, Groot 100.000 / 30. Wat niet meer past
   wordt *uitgesteld*: cache en ETag van die pagina (of het feeditem) worden vergeten, zodat de volgende ronde ermee
   begint.
9. **Verslag**: één regel per gebeurtenis (`new`, `duplicate`, `conflict`, `proposed`, `ignored`, `rejected`,
   `error`, `unchanged`, `skipped`, `goal`) met memory-`changeId` voor undo. Bij tegenspraak een melding.


## Teams

De kennisbank hoort bij de bot en dus bij zijn **thuisteam** (`ctx.services.teams.teamOf`). In code (fail closed):

| Wie | Lezen (`knowledge_search`) | Toevoegen (`knowledge_add`) |
|---|---|---|
| De specialist zelf | ja | ja |
| Bots van hetzelfde thuisteam | ja | ja (voorstel als de run externe inhoud las) |
| Bots met *meekijken* of *aansturen* op dat team | ja | nee |
| Bots zonder toegang | nee ("hoort bij een ander team"), en de specialist wordt in hun prompt niet genoemd | nee |

Via het geheugen zelf (`memory_search`, de beurtcontext) ziet geen andere bot de kennisbank: het dossier heeft
`agent_ids = [bot]`. Bewezen met probes in `tests/teams-isolation.test.ts` (zonder toegang, meekijken, aansturen).

## Tools

| Tool | Groep | Risico | Wat |
|---|---|---|---|
| `knowledge_search` | `specialist` | read | Zoeken in de eigen kennisbank en die van leesbare specialisten; regels met `[m:id]`, bron en datum |
| `knowledge_add` | `specialist` | write | Eén feit met bron in een kennisbank van het eigen team |
| `knowledge_goal` | `specialist` | write (zonder kaart, `internalFor`) | Leerdoel voor de eigen volgende ronde |
| `knowledge_retire` | `specialist` | write (zonder kaart) | Een feit of werkwijze uit de eigen kennisbank laten vervallen, met de reden; niet in een run die inhoud van buiten las |

`knowledge_add` kent `replaces` (het id van het feit dat hierdoor niet meer klopt).

De groep `specialist` krijgt een bot vanzelf als hij specialist wordt. Systeemprompt (stabiel): vakgebied, "noem id
en bron", "zeg eerlijk dat je het niet weet". Beurtcontext (alleen privégesprek met de eigenaar): de best passende
feiten uit de eigen kennisbank met id, bron en datum, zodat de bot ze kan citeren.

## API (onder `/api`)

| Route | Wat |
|---|---|
| `GET /specialists/meta` | soorten bronnen, budgetten, of routines/geheugen/gratis modellen er zijn |
| `GET /specialists` | specialisten van de eigenaar met tellers |
| `GET /specialists/:agentId` | kaart: vakgebied, bronnen met status, leerronde, budget, zelftest, routine (status, volgende run), engine, tellers, laatste ronde |
| `PUT /specialists/:agentId` | `{ enabled, field, learnOn, cadence: daily\|weekly, budget: small\|normal\|large, selfTest, sources: [{kind, target, label, enabled}] }` |
| `POST /specialists/:agentId/learn` | *Nu leren*: de ronde start op de achtergrond (`{ started }`) |
| `GET/POST /specialists/:agentId/knowledge` | feiten en *te controleren* (uit het dossier, met changeId voor undo) / feit toevoegen door de eigenaar |
| `POST /specialists/:agentId/knowledge/:ref/retire` | `{ reason }`: *Werkt niet meer* (vervallen, met ongedaan maken) |
| `GET/POST /specialists/:agentId/goals`, `PATCH/DELETE /specialists/goals/:id` | leerdoelen |
| `GET /specialists/:agentId/reports`, `POST /specialists/:agentId/report` | leerverslagen en rondes / verslag nu maken |
| `POST /specialists/rounds/:id/undo` (`{index?}`), `POST /specialists/reports/:id/undo`, `POST /specialists/reports/:id/seen` | ongedaan maken, gelezen |

Te controleren oplossen en vergeten gaan via de bestaande routes van het geheugen (`/memory/items/:id/approve`
met `mode: replace\|keep_both`, `/reject`, `/forget`, `/memory/changes/:id/undo`).

Event: `specialists.changed` (`{agentId, what}`). Meldingen: leerverslag en te controleren (met
`agentId`, dus het meldingsniveau per bot geldt). Tabellen: zie `schema.ts`. Export: `exportUser` (profielen,
bronnen zonder cache, leerdoelen, rondes, verslagen, voorstellen; de feiten zelf zitten in de export van het
geheugen).

## Diensten (`ctx.services.specialists`)

`learn(userId, agentId)`, `list`, `profile`, `isSpecialist`, `importForAgent(userId, agentId, spec)`,
`exportForAgent(userId, agentId)`, `canRead`/`canWrite(callerId, specialistId)`, `search(userId, specialistId, q)`,
`weeklyReport`, `setOptions({hostDelayMs, fetch})`, `exportUser`.

**Sjablonen (pakket R):** een bot uit een sjabloon mag `specialist: { field, suggestedSources[] }` meekrijgen
(`suggestedSources`: URL's of `{url, kind?, label?}`). Roep `ctx.services.specialists?.importForAgent(...)` aan na het
maken van de bot, of zet het in `settings.specialist` (dan pikt de module het op bij `agent.updated`). De bot wordt
specialist met die bronnen (en de standaardbronnen van zijn vak) als *voorgesteld*; de leerronde staat aan (wekelijks, klein budget). `exportForAgent` geeft het terug voor een
sjabloon, zonder iets van wat geleerd is. Zonder `specialist` gebeurt er niets.

## UI

- **Bot › Specialisme** (`agentSections`, eigen component, slaat op met de *Opslaan* van de editor via
  `useEditorSection`, of met een eigen knop als er geen editor omheen staat): schakelaar, vakgebied, bronnen (soort,
  adres, naam, aan/uit, status "bekeken / niets nieuws / fout / overgeslagen"), leerronde aan/uit, hoe vaak, budget,
  zelftest, waarmee hij leert, volgende ronde met link naar de routine, *Nu leren*, *Kennisbank openen*.
- **Kennisbank** `#/m/specialists/<bot>/<tab>` (niet in de zijbalk): Feiten (bron, geleerd op, gepubliceerd op,
  *Ongedaan maken*, *Klopt niet* = vergeten), Te controleren (nieuw naast oud: *Nieuw klopt / Allebei houden / Oud
  klopt*), Leerdoelen, Leerverslagen (week + rondes, undo per regel of alles), Voorstellen (concept bewerken,
  *Installeren voor <bot>*, *Niet nodig*), Bronnen. `#/m/specialists` toont alle specialisten.
- In de chatkop van een specialist een knop naar zijn kennisbank (met een stip als er iets op de eigenaar wacht).
- Getest in headless Edge op 1360 px (licht en donker) en 360 px: geen overloop, geen paginafouten.

## Ontwerpkeuzes

1. **Kennis in het geheugen, niet in een eigen opslag**: dedup, tegenspraak, vergeten (met blokkade), versies, undo,
   export en straks zoeken op betekenis (pakket F) komen zo vanzelf mee.
2. **De ronde zonder run van de bot**: de module plant haar zelf en doet alleen korte, tool-loze modelaanroepen op een
   gratis of lokaal model. Zo kost bijblijven niets van het abonnement van de eigenaar.
3. **Wat nieuw is**: 304 of dezelfde hash = *ongewijzigd* (geen modelaanroep); een gewijzigde pagina stuurt alleen
   opdracht-/injectiecontrole van het geheugen.
4. **Alleen het nieuwe**: ETag, hash, alineaverschil en geziene feeditems besparen tokens en voorkomen dubbel.
5. **Undo blijft goedkoop**: wat ongedaan is komt niet stil terug (dezelfde feittekst heeft dezelfde
   idempotentiesleutel); *Klopt niet* vergeet het met blokkade.

## Live gemeten (9 november 2026)

Met lokaal Ollama (`qwen3.6-uncensored-snel`, het model dat al geladen was; één verzoek tegelijk):
- met *denken* aan gaf het model binnen 900 tokens alleen denkwerk en geen antwoord (13 s). Daarom staat denken voor
  de korte extractie bij lokale engines uit (`reasoning: 'none'`) en is de ruimte voor het antwoord 2000 tokens; een
  model dat alleen denkt geeft nu een duidelijke fout in plaats van "geen bruikbaar antwoord";
- met denken uit gaf het de juiste feiten in strikte JSON, maar parafraseerde het de citaten ("max 60 characters"):
  daarom telt nu ook de woordoverlap van het feit met de bron (zie stap 6);
- de geplante opdracht in de bron werd vóór de modelaanroep weggehaald en niet opgeslagen.
Na deze twee aanpassingen is de ronde niet opnieuw live gedraaid (om het lokale model van de eigenaar niet te
belasten); de tests dekken het met de nep-provider.

## Beperkingen

- Leren van PDF/Word-bronnen kan nog niet (alleen tekstformaten); pagina's die alleen via JavaScript renderen ziet
  hij niet.
- Feeds: de tekst uit de feed zelf; de gelinkte artikelen worden niet opgehaald (zuinig en beleefd).
- Leerdoelen worden gezocht in de eigen bronnen (en hun cache), niet met een zoekmachine.
- De kennisbank is per bot; een gedeelde *teamkennisbank* hoort bij golf 2 (geheugen per team).
- Er zijn geen eigen auditregels: het geheugen logt elk opgeslagen feit (`memory.created/proposed`), de routinemodule
  het aan- en uitzetten, en de kern elke toolaanroep.
