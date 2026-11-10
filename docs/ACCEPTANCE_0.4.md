# Acceptatie — TeamBot 0.4

Stand: 9 november 2026, release **0.4.2**: `main` met alle pakketten van 0.4 samengevoegd (B, B2, B3, B4, C1, C2, D1, D2,
E, F, F2, G, H, I, J, K, L, M, N, O, P, Q, R, S, Y, A1, A2, A3, de vereenvoudigde desktop, de installer, de pariteitsronde
en de telefoon van 0.4.2), plus de reparaties van de poortenronde (tak `worktree-agent-abbfa55a6ee672a49`). Alle poorten
van die ronde staan in `docs/archief/RELEASE_0.4.2_GATES.md`. Bron van elk punt: de **Klaar als** van elk pakket in
`docs/PLAN_0.4.md`, aangevuld met de onderdelen uit de beschrijving van dat pakket die de eigenaar zal willen nalopen.

**Hoe getest.** Drie lagen, telkens met een lege tijdelijke datamap en `APPDATA`, nooit de TeamBot van de eigenaar:
- **in de echte, gebouwde app** (`dist/ui`, Edge zonder venster, testmodel dat zich meldt als "gevonden op deze pc"):
  `npm run accept:04` (A, B, E, F, N, G-04, D1), `npm run parity:04` (182 stappen naast OpenBot), `npm run phone:check`
  (de eigenaar op een gekoppelde iPhone) en de e2e-suites (`npm run e2e`, 16 suites);
- **met unit- en integratietests** (`npm test`, node:test, nep-engines en nagebootste diensten): het bewijs per punt
  staat in de kolom *Bewijs* met het bestand en de naam van de test;
- **live** met de echte Ollama op deze pc: de kwaliteitsmeting (M) en eerder de proef met een document (F-03).

```bash
npm run build:ui && npm run accept:04        # beide suites (ook de tweede als de eerste faalt), ±3 minuten
node --import tsx tests/e2e/accept-04-core.mjs   # A, B, E
node --import tsx tests/e2e/accept-04-data.mjs   # F, N, G, D
# TEAMBOT_E2E_PORT=<poort> (standaard 4838) · TEAMBOT_E2E_SHOTS=<map> schermafbeeldingen · TEAMBOT_ACCEPT_ONLY=F-01,N-01
# TEAMBOT_ACCEPT_OLLAMA=1 ook een korte live proef met de echte Ollama (het model dat al geladen is)
```

Elke regel in de uitvoer begint met het nummer uit deze lijst, bijvoorbeeld `✔ [B-02] bestand van B lezen: geweigerd`.

**Statussen:** *werkt* (bewezen, bewijs erbij) · *deels* (een deel werkt, de rest staat erbij) · *kapot* (een echte fout,
zie *Gevonden fouten*) · *extern* (vraagt een account, apparaat, VM of een keuze van de eigenaar) · *nog niet gebouwd*.

## Samenvatting

| Status | Aantal |
|---|---|
| werkt | 75 |
| deels | 8 |
| kapot | 0 |
| extern | 8 |
| nog niet gebouwd | 2 |
| **totaal** | **93** |

(Vier punten verwijzen naar elkaar en tellen dus twee keer mee als *werkt*: A-12 = E-01, G-05 = N-04, N-03 = F-05,
N-06 = G-04.)

Geen punt is kapot. **Deels** zijn: B-14 (geen bewijs voor "meldingen van alle teams in één keer"; groep en team zijn
geen één begrip geworden), C-01 (de hoofdbot geeft werk aan één team met bewijs terug; verdelen over twee teams is alleen
voor een leider getest, zonder bewijscontrole), G-06 (een binnenkomende e-mail als informatie is niet apart getest),
H-01 (een catalogusskill per team: bewezen in delen, niet in één test), I-02 (de koppeling via de echte QR-route is
getest met een nagebootste iPhone-app), L-01 (`voice:live` niet gedraaid in deze ronde), M-01 (OpenCode alleen op 0.3.0
gemeten) en M-03 (zie *Kwaliteit*). **Nog niet gebouwd** zijn E-11 (zwaar werk over de vijfuursvensters verdelen) en
J-02 (schermafbeeldingen van 0.4 op de site). **Extern** (D-09, E-02, E-08, F-02, I-01, I-03, J-03, N-05) blijft wat een
account, een apparaat of een keuze van de eigenaar vraagt.

Laatste runs (9 november 2026, Windows 11 Home, Node 26.13.0, Edge headless):
`accept-04-core` 73/73, `accept-04-data` 49/49, `parity:04` 182/182, `phone:check` geslaagd, `npm test` 1281/1281,
`npm run e2e` 16 van 16 suites, `a11y` 0, `i18n:check` 0 open in 10 talen (94 pagina's per taal).

## A. Indeling en eenvoud

| # | Punt | Status | Bewijs / opmerking |
|---|---|---|---|
| A-01 | Iemand die TeamBot nooit zag, maakt binnen 2 minuten een bot en krijgt antwoord, zonder handleiding | werkt | `accept-04-core` [A-01]: welkom met drie manieren om te beginnen → *Testmodel gebruiken* → drie vragen (naam, wat hij doet, welk model; het gevonden model voorgesteld) → antwoord in de chat; de bot kent zijn taak. De allereerste bot krijgt alleen die drie vragen; *Soort bot* (hoofdbot of gewone bot) komt bij de volgende bots. `newcomer.mjs` telt klikken en seconden. |
| A-02 | Elke pagina in hoogstens 2 klikken vanuit de zijbalk | werkt | `accept-04-core` [A-02]: de 12 vroegere *Meer*-pagina's via Instellingen (klik 1) en hun regel (klik 2); Routines en Nu bezig via Taken (klik 1) en hun link (klik 2); Taken en Wacht op jou in 1 klik; Mijn skills via Marktplaats; zoekvak in Instellingen. (Fout 1 is gerepareerd in `4c3c4b5`.) |
| A-03 | `npm run a11y` groen | werkt | 0 bevindingen (axe-core, WCAG 2.2 A/AA), ook bij 200% en 400% zoom en op 320 en 390 px. |
| A-04 | `npm run mobile:check` groen | werkt | 20/20. |
| A-05 | `npm run i18n:check` groen | werkt | 10 talen × 15.687 teksten, 0 ontbrekend, 0 fouten; 94 pagina's per taal, 0 zichtbare onvertaalde tekst, 0 paginafouten. Vertaalronde 2 deed ±3.385 nieuwe teksten in alle talen; "Mijn team" volgt de taal. |
| A-06 | Vaste plekken in de zijbalk; *Meer* verdwijnt op de pc | werkt | `accept-04-core` [A-06]: sinds 0.4.2 (vereenvoudigde desktop) **Wacht op jou, Taken en Instellingen**; Routines staan op Taken, Geheugen en Marktplaats onder Instellingen › Bots en teams; de oude link `#/more` opent Instellingen; op de telefoon blijft een korte *Meer* (`layout.mjs`, `phone:check`). |
| A-07 | Eenvoudig is de standaard; experts achter *Instellingen › Geavanceerd tonen* | werkt | `accept-04-core` [A-07]: standaard uit; Taken toont Logboek en met Geavanceerd ook Beslissingen, Gebeurtenissen, Experimenten en Tabellen; *Activiteit*/*Details* in het zijpaneel en *Netwerk en proxy* volgen de schakelaar; een diepe link naar een verborgen tabblad werkt. |
| A-08 | Na installatie leeg beginnen; alles zelf aanmaken | werkt | `accept-04-core` [A-08]; `tests/new-bot.test.ts`. |
| A-09 | Eén takenbord (*Taken*) in plaats van twee | werkt | `newcomer.mjs`; `tests/task-board.test.ts`; `accept-04-core` [B-07]. |
| A-10 | Teamkiezer bovenaan de zijbalk; hoofdbot bovenaan, daaronder de bots van het team | werkt | `layout.mjs` ("tweede team: de teamkiezer verschijnt vanzelf, bovenaan de zijbalk", "hoofdbot: eerste tegel, ook met een ander team gekozen", de chatlijst volgt het team); `tests/team-switcher.test.ts`. Een apart *teamgesprek* onder de hoofdbot is niet gebouwd en staat niet meer in de handleiding. |
| A-11 | De chat blokkeert nooit tijdens een run; drie stromen | werkt | `accept-04-core` [A-11]; `layout.mjs` (routine-runs en overleg tussen bots nemen het eigen gesprek niet over). |
| A-12 | Gebruiksbalk altijd onderin | werkt | Zie E-01. |

## B. Meerdere teams

| # | Punt | Status | Bewijs / opmerking |
|---|---|---|---|
| B-01 | Twee teams met elk een bot en een map, plus een sleutel *alleen voor team A* | werkt | `accept-04-core` [B-01], alles in Instellingen › Teams. |
| B-02 | Een bot van A zonder toegang kan de bestanden van B niet lezen, bekijken, doorzoeken of schrijven | werkt | `accept-04-core` [B-02] (echte tool-lus, niets geschreven, het geheim van B nergens op het scherm); `tests/teams-isolation.test.ts`. |
| B-03 | Sleutels en logins van één team werken niet voor een ander team | werkt | `accept-04-core` [B-03]; `tests/teams-isolation.test.ts` (apps en Kluis). |
| B-04 | Zonder toegang geen werk geven aan bots van B; B staat niet in de prompt | werkt | `accept-04-core` [B-04]; `tests/teams-isolation.test.ts`. |
| B-05 | Zonder toegang ook niets via geheugen, dossiers, zoeken, kanalen of skills | werkt | `tests/teams-isolation.test.ts` "teams isolation: a bot of team A without access reaches nothing of team B; meekijken reads, aansturen directs" (proeven op geheugen, dossiers, zoeken, teamkennis, teamdatabase, groepen en sinds B4 ook `channel_list`, `channel_send`, `skill_load`, `skill_run_script`, routines); `tests/memory-teams.test.ts`. |
| B-06 | Een bot met *meekijken* leest de teamkennis van B maar schrijft niets | werkt | `accept-04-core` [B-06]. |
| B-07 | Een bot met *aansturen* geeft de teamleider van B een taak | werkt | `accept-04-core` [B-07]. |
| B-08 | Een gedeelde sleutel werkt in beide teams | werkt | `accept-04-core` [B-08]. |
| B-09 | Overzicht *Alle teams* klopt (resultaten, fouten, gemiste runs, wat wacht, verbruik per team) | werkt | `tests/teams-org.test.ts` "the overview counts open tasks, what waits for you, errors and missed runs per team" (ook verbruik per team). Via de API getest; de pagina zelf zit niet in een e2e-suite. |
| B-10 | Zolang er één team is geen teamkeuze; vanaf het tweede team wel | werkt | `accept-04-core` [B-10]. |
| B-11 | Bedrijfsprofiel per team dat elke bot van dat team meekrijgt | werkt | `accept-04-core` [B-11]; `tests/teams.test.ts`. |
| B-12 | Migratie: bij een update alles in *Mijn team*; een nieuwe installatie begint leeg | werkt | `tests/teams.test.ts`, `tests/memory-teams.test.ts` ("update from 0.3"). |
| B-13 | Team dupliceren of exporteren als sjabloon (zonder geheugen, sleutels, kanalen, gesprekken) | werkt | `tests/team-duplicate.test.ts` "Team dupliceren: bots, routines (off), profile, lead and budget come along; memory, chats, keys, folder and access do not"; exporteren per groep: `tests/team-package.test.ts`. |
| B-14 | Per team: kanalen, skills, routines, budget, logboek; meldingen voor alle teams in één keer; groep en team één begrip | deels | Per team werkt (B2/B4): `tests/teams-isolation.test.ts` "(B4): B's own bots use B's channel, skill and routine; the owner filters per team", "(B2): a team's daily budget stops its run…", "(B2): the owner sees every team, with a team filter". Geen test voor "meldingen van alle teams in één keer"; groep en team zijn twee begrippen gebleven (een groep hoort bij één team). |

## C. Hoofdbot, leiders, teamleiders en werk dat echt af is

| # | Punt | Status | Bewijs / opmerking |
|---|---|---|---|
| C-01 | De hoofdbot verdeelt een opdracht over twee teams en meldt terug met bewijs | deels | `tests/teams-org.test.ts` "the main bot hands a request to the lead of the right team; the result comes back up the chain with evidence" (één team) en "a leader with aansturen on two teams directs both leads" (twee teams, zonder bewijscontrole). De hoofdbot zelf over twee teams met bewijs: geen test. |
| C-02 | Een taak met een opzettelijk fout resultaat komt op *te controleren*, niet op *klaar* | werkt | `tests/quality.test.ts` "a task with a deliberately wrong result lands on \"te controleren\" with a reason". |
| C-03 | Een bot in een lus stopt zelf | werkt | `tests/quality.test.ts` "a bot that repeats the same tool call stops by itself…" en "a CLI bot repeating the same step is stopped too". |

## D. Gratis modellen

| # | Punt | Status | Bewijs / opmerking |
|---|---|---|---|
| D-01 | Met een gesimuleerde limiet op OpenCode schakelt een gewone taak zichtbaar door naar een andere gratis aanbieder en daarna naar Ollama | werkt | `tests/engine-chain.test.ts` "simulated limit on OpenCode: a normal task switches visibly to another free source, then to Ollama"; in de echte app gezien in `c4-models-cli-review` ("Overgeschakeld naar reserve … Ollama (lokaal)"). |
| D-02 | Een belangrijke taak pauzeert met hervattijd, de melding komt binnen, en gaat na de reset zelf verder | werkt | `tests/engine-chain.test.ts` "an important task pauses with a resume time and a notification…". |
| D-03 | Een verdwenen model valt uit de keten zonder fout voor de gebruiker | werkt | `tests/engine-chain.test.ts` "a free model that is gone drops out of the chain…"; `tests/free-models.test.ts` "a 404 removes a model…". |
| D-04 | Gratis bronnen staan standaard uit; zelf een gratis sleutel invullen; TeamBot werkt ook zonder | werkt | `accept-04-data` [D-04]. |
| D-05 | Catalogus met echte proef, hoogstens één proef per model per dag, privacylabel | werkt | `accept-04-data` [D-05]; `tests/free-models.test.ts`. |
| D-06 | Tegoed per account met de bekende resetmomenten; 429 = wachten; 404/410 = model weg | werkt | `tests/free-models.test.ts`. |
| D-07 | Antwoorden zelf controleren: "gelukt" met een fout in de tekst, of afgekapt, telt als mislukt | werkt | `tests/free-models.test.ts`. |
| D-08 | De sleutel blijft geheim | werkt | `accept-04-data` [D-04], [D-08]. |
| D-09 | Echt chatten en proeven bij Groq, OpenRouter, Cloudflare, Z.ai en Kilo | extern | Vraagt echte (gratis) sleutels van de eigenaar. |
| D-10 | Privéwerk alleen naar lokaal Ollama of bronnen die niets bewaren | werkt | `tests/engine-chain.test.ts` "private work: a bot set to private runs on a local model and never goes to a source that can train". |

## E. Gebruiksbalk en zuinig met limieten

| # | Punt | Status | Bewijs / opmerking |
|---|---|---|---|
| E-01 | De balk toont de cijfers van Claude en Codex, kleuren en resettijd, ook op de telefoon | werkt | `accept-04-core` [E-01]; `tests/usage-bar.test.ts`. |
| E-02 | Met de echte cijfers van Claude en Codex van de eigenaar | extern | Vraagt zijn eigen logins. |
| E-03 | De balk verspringt binnen een minuut na nieuw gebruik | werkt | `accept-04-core` [E-03]. |
| E-04 | Label *schatting* en de uitleg over de gedeelde pot | werkt | `accept-04-core` [E-04]. |
| E-05 | Klik op de balk: verbruik per bot, vandaag en deze week | werkt | `accept-04-core` [E-05]. |
| E-06 | Per gratis bron een bolletje | werkt | `accept-04-core` en `accept-04-data` [E-06]. |
| E-07 | Melding op de pc vóór de grens (80%) en bij de grens | werkt | `accept-04-core` [E-07]. |
| E-08 | Dezelfde melding op de telefoon | extern | Push vraagt een gekoppelde telefoon. |
| E-09 | Weekreserve: boven 85% gaat gewoon werk naar gratis modellen, een belangrijke taak niet | werkt | `tests/engine-chain.test.ts` "above the weekly reserve normal work goes to a free model while important work stays on Claude"; het streepje op de balk: `tests/usage-bar.test.ts`. |
| E-10 | Verbruik per team | werkt | `tests/teams-isolation.test.ts` "(B2): usage per team…"; `tests/usage-bar.test.ts`. |
| E-11 | Zwaar werk slim plannen over de vijfuursvensters en de nacht | nog niet gebouwd | Wordt nergens beloofd; blijft op het plan. |

## F. Geheugen

| # | Punt | Status | Bewijs / opmerking |
|---|---|---|---|
| F-01 | Een feit dat in andere woorden is opgeslagen wordt gevonden | werkt | `accept-04-data` [F-01]; `tests/memory-semantic.test.ts`. |
| F-02 | Hetzelfde met een echt embedmodel | extern | Sinds F2 is er een ingebouwd zoekmodel (multilingual-e5-small) dat pas na toestemming downloadt; dat downloaden is een keuze van de eigenaar. De meting staat in `docs/quality/memory-bench.md` (niet opnieuw gedraaid in deze ronde). |
| F-03 | Een pdf-bron (en Word) wordt geciteerd | werkt | `accept-04-data` [F-03]; `tests/memory-documents.test.ts`. |
| F-04 | "Ja, doe maar" levert een herinnering op, met ongedaan maken | werkt | `accept-04-data` [F-04]. |
| F-05 | Een back-up terugzetten haalt vergeten dingen niet terug | werkt | `accept-04-data` [F-05]. |
| F-06 | Veiligheidsregels blijven altijd geladen | werkt | `accept-04-data` [F-06]; `tests/memory-rules.test.ts`. |
| F-07 | Geheugen per team en lessen van het team | werkt | Per team: `tests/memory-teams.test.ts`, `tests/teams-isolation.test.ts`. Lessen (F2): `tests/memory-dossier-auto.test.ts` "team walls: … a lesson from a correction is for the whole team, and can be narrowed to one bot". |
| F-08 | Bronnen bij lokale modellen en de melding bij een vol geheugen | werkt | `tests/memory-retest.test.ts`. |
| F-09 | De bron onder het antwoord, ook als een lokaal model een document gebruikt zonder te citeren | werkt | `tests/memory-implied-documents.test.ts` "answer-sources: the Word document a local model used without citing it shows under the answer, and only that one" (fout 4 gerepareerd in `f5a5c64`). |

## G. Betrouwbaarheid

| # | Punt | Status | Bewijs / opmerking |
|---|---|---|---|
| G-01 | Een opzettelijk mislukte routine levert binnen 5 minuten een melding op | werkt | `tests/routine-proof.test.ts` "a deliberately failing routine produces a notification within 5 minutes". |
| G-02 | Een door een bot gewist bestand komt terug uit de prullenbak | werkt | `tests/trash.test.ts` "a file a bot deletes goes to the Prullenbak and comes back with one click". |
| G-03 | *Alles stoppen* laat geen proces achter | werkt | `tests/proc-tree.test.ts` (Claude Code met een kind en een wees, Codex, een ACP-engine). |
| G-04 | Motorversies vastzetten | werkt | `accept-04-data` [G-04]; `tests/engine-versions.test.ts`. |
| G-05 | Updates van TeamBot: back-up vooraf, terugzetten, wijzigingslog | werkt | Zie N-04. |
| G-06 | Routines met bewijs en een lijst van wat gemist is; momentopname vóór een schrijvende run; toestemming alleen waar het telt; webpagina's, mails en botberichten nooit een opdracht | deels | `tests/routine-proof.test.ts`, `tests/routine-missed.test.ts`, `tests/trash.test.ts` (momentopname per run), `tests/approval-defaults.test.ts`, `tests/untrusted-content.test.ts` (webpagina's en antwoorden van bots). Een binnenkomende e-mail als informatie is niet apart getest. |

## H. Skills: een eigen, veilige catalogus

| # | Punt | Status | Bewijs / opmerking |
|---|---|---|---|
| H-01 | Een skill uit de catalogus installeren in één team werkt en is in het andere team onzichtbaar | deels | `tests/skills-catalog.test.ts` (installeren naar één team) en `tests/teams-isolation.test.ts` (B4: een skill van team B staat niet in de lijst van A en kan daar niet aan). Niet samen in één test met een catalogusskill. |
| H-02 | Een gewijzigde bron toont eerst het verschil | werkt | `tests/skills-catalog.test.ts` "updates: a changed source shows the diff first…". |
| H-03 | Een skill met een script draait niet zonder akkoord | werkt | `tests/skills-catalog.test.ts` "scripts: off after install, refused without trust…"; `tests/skills.test.ts`. |

## I. iPhone-app en TestFlight

| # | Punt | Status | Bewijs / opmerking |
|---|---|---|---|
| I-01 | De app staat in TestFlight | extern | Vraagt de App Store Connect-sleutel en een cloud-Mac van de eigenaar; de bouwstraat staat klaar (`.github/workflows/ios-companion.yml`). |
| I-02 | Koppelt via de QR-code met de pc van de eigenaar | deels | `phone:check`: "gekoppeld via de echte QR-koppeling: de iPhone-app heeft een eigen apparaatsleutel" (een nagebootste app-client); `tests/mobile.test.ts`. De echte app op een toestel: I-01/I-03. |
| I-03 | Doorstaat chat, spraak, melding en goedkeuren op zijn iPhone | extern | Vraagt de iPhone van de eigenaar. |

## J. Website

| # | Punt | Status | Bewijs / opmerking |
|---|---|---|---|
| J-01 | `website:check` groen | werkt | 17 pagina's × 6 breedtes × licht/donker: 0 bevindingen, 0 axe-bevindingen. |
| J-02 | Schermafbeeldingen van 0.4 | nog niet gebouwd | De afbeeldingen in `website/src/img` zijn nog van 0.3 (7 november). |
| J-03 | De site staat online op het gekozen adres | extern | Domein en hosting kiest de eigenaar. |

## K. Kanalen

| # | Punt | Status | Bewijs / opmerking |
|---|---|---|---|
| K-01 | Een klantvraag die niet in de kennis staat, wordt doorgezet naar de eigenaar | werkt | `tests/channels-customer.test.ts` "a question outside the approved knowledge is handed off to the owner instead of answered". |
| K-02 | Een antwoord met een prijs wacht op goedkeuring | werkt | `tests/channels-customer.test.ts` "a draft with a price waits for approval…". |

## L. Spraak

| # | Punt | Status | Bewijs / opmerking |
|---|---|---|---|
| L-01 | `npm run voice:live` groen | deels | De spraaktests in `npm test` zijn groen (`tests/voice-*.test.ts`); de live suite (lokale spraakmodellen, ±820 MB) is in deze ronde niet gedraaid. Op 0.3 was hij 20/20. |
| L-02 | In een groepsgesprek met spraak is steeds te zien welke bot aan de beurt is | werkt | `tests/voice-talk.test.ts` "group indicator: which bot speaks, which ones think, all listen to you"; de groepsspraak in de echte app: `files-chat.mjs` (wie luistert, half verstane naam, onderblad op de telefoon). |

## M. Kwaliteit meten

| # | Punt | Status | Bewijs / opmerking |
|---|---|---|---|
| M-01 | De testset (±30 taken) draait met Ollama en OpenCode gratis | deels | Op 0.4.2 met Ollama gedraaid (30 taken plus 6 × 3 herhalingen, zie *Kwaliteit*); OpenCode gratis alleen op 0.3.0 (5 taken), niet opnieuw om de gratis limiet te sparen. |
| M-02 | Het verslag staat in de repo | werkt | `docs/quality/` (verslagen, `scores.json`, het werk van elke bot onder `attempts/`). |
| M-03 | 0.4 scoort op geen taak lager dan 0.3.0 | deels | 16 van 30 tegen 12 van 30; 6 taken lager in één run, waarvan 4 bij herhaling gewoon slagen en 2 door het model zakken (zie *Kwaliteit*). |

## N. Back-ups en veilig bijwerken

| # | Punt | Status | Bewijs / opmerking |
|---|---|---|---|
| N-01 | Een back-up van de hele app maken en zien wat erin zit | werkt | `accept-04-data` [N-01]; `tests/app-backup.test.ts`. |
| N-02 | Terugzetten met één klik | werkt | `accept-04-data` [N-02]. |
| N-03 | Wat vergeten was blijft vergeten | werkt | Zie F-05. |
| N-04 | Vóór elke update een back-up, *Terug naar versie x*, *Wat is er nieuw* | werkt | `accept-04-data` [N-04]; `tests/update-safety.test.ts`. |
| N-05 | De echte installer: update en terug naar de vorige versie | extern | Vraagt een schone Windows-VM of een tweede Windows-account (nooit op de pc van de eigenaar). |
| N-06 | Motorversies vastzetten | werkt | Zie G-04. |

## S. Specialisten die zelf leren

| # | Punt | Status | Bewijs / opmerking |
|---|---|---|---|
| S-01 | Met testbronnen slaat een leerronde feiten met bron op in de kennisbank | werkt | `tests/specialists.test.ts` "learning rounds: facts with source and date, planted instruction ignored, duplicates skipped, contradiction to check, citation, goal picked up, report with undo" (één test bewijst S-01 tot en met S-06). |
| S-02 | Een tweede ronde slaat dubbele over | werkt | Idem. |
| S-03 | Hij markeert tegenspraak als *te controleren* | werkt | Idem. |
| S-04 | Hij negeert een verborgen instructie in een bron | werkt | Idem. |
| S-05 | Er ontstaat een leerverslag | werkt | Idem. |
| S-06 | De bot citeert het geleerde daarna in een antwoord | werkt | Idem. |

## Kwaliteit (M-03)

De testset van pakket M op 0.4.2 met het lokale model dat al geladen was (`qwen3.6-uncensored-snel`), dezelfde testset
als de nulmeting: **16 van 30 geslaagd, gemiddelde score 0,69** (0.3.0: 12 van 30, 0,56); eerlijkheidstaken 1 van 6
(gelijk). Naast 0.3.0: 11 taken beter, 13 gelijk, 6 lager. Die zes zijn elk drie keer opnieuw gedraaid: vier halen het
gewoon (toeval van één run), twee blijven zakken door fouten van het model, niet van TeamBot (bouw-formatprijs, 1 van 3;
bouw-sleutel-ontbreekt, ook op 0.3.0 niet gehaald). Daarom *deels*: "op geen taak lager" geldt niet letterlijk, en de
eerlijkheidstaken zijn niet beter geworden. Details per taak: `docs/archief/RELEASE_0.4.2_GATES.md` en `docs/quality/README.md`.

## Gevonden fouten

De vier fouten van de eerste acceptatieronde zijn gerepareerd: Teamwerk vanuit Taken (fout 1, `4c3c4b5`), Geheugen ›
Opslag toonde "Vol" (fout 2), een geweigerde schrijfpoging in het zijpaneel (fout 3), en de bron onder het antwoord bij
een lokaal model dat een document niet citeert (fout 4, `f5a5c64`). De fouten van de poortenronde voor 0.4.2 staan met
oorzaak en reparatie in `docs/archief/RELEASE_0.4.2_GATES.md`.

## Opmerkingen (geen fout, wel om te weten)

1. **Gratis keten met twee OpenCode-koppelingen**: staat de eerste OpenCode op zijn gratis limiet, dan probeert de keten
   eerst een tweede OpenCode-koppeling (die meestal dezelfde limiet heeft) en daarna het lokale model (gezien in
   `c4-models-cli-review`). Het werkt, maar kost een overbodige stap.
2. **Weigering van een map van een ander team**: de reden is de algemene zin "Pad valt buiten de toegestane werkmap en
   extra mappen", niet "deze map hoort bij team …". Veilig, maar minder duidelijk.
3. **Server-modus**: na *herstart de server* toont een al open browsertabblad de oude botnamen tot je de pagina herlaadt.
4. **Naar buiten**: Instellingen › Abonnementen vraagt bij openen de nieuwste versies van Claude Code en Codex (npm) en
   OpenCode (GitHub) op (alleen GET, geen gegevens van de gebruiker).
