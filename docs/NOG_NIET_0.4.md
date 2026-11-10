# Wat zegt dat het niet werkt — TeamBot 0.4.2

Stand: 9 november 2026, op een tak van `main` (0.4.1). Vraag van de eigenaar: "Ik zie veel functies, daar staat dat het
nog niet werkt, dus alles moet klaar, ook op de app." Hier staat alles wat in de app, de handleiding, de acceptatielijst
en `website/src/release.json` zei of liet doorschemeren dat iets nog niet werkt, met wat ermee gebeurd is.

**Uitkomsten:** *werkt nu* (gebouwd of aangesloten, met test) · *eerlijk onmogelijk* (kan hier echt niet: Mac, account,
betaalde dienst, apparaat of Windows-grens; de tekst zegt rustig waarom en wat je wel kunt, zonder rood) ·
*weggehaald* (dode of misleidende tekst weg of verbeterd) · *klopt* (de tekst was goed; alleen de markering ging weg).

Gezocht met: `nog niet`, `binnenkort`, `komt later`, `niet beschikbaar`, `werkt nog niet`, `niet ondersteund`,
`experimenteel`, `bèta`, `in deze versie`, `volgende versie`, `golf 2`, `TODO`/`FIXME`, uitgeschakelde knoppen met uitleg,
en de rode/oranje meldingen daarbij, in `ui/src` (zonder woordenboeken), `server/` en `desktop/`.

## Samenvatting

| Waar | werkt nu | eerlijk onmogelijk | weggehaald | klopt |
|---|---|---|---|---|
| Teksten in de app (A) | 3 | 25 | 8 | — |
| Handleiding, 37 markeringen `0.4-pending` (B) | 2 | 1 | 19 | 15 |
| Acceptatielijst, 43 punten *nog niet gebouwd*, *deels* of *kapot* (C) | 36 | 5 | 2 | — |

Geen enkele `0.4-pending`-markering staat nog in `docs/HANDLEIDING.md`. Nagelopen in de echte gebouwde app (Edge zonder
venster, lege tijdelijke datamap, poort 4851): **Team dupliceren** maakt "Mijn team (kopie)" met de bots, "Niet mogelijk"
bij Hyper-V en Windows Sandbox is grijs met de uitleg over Docker, *AI-providers* en *CLI-agents* tonen geen
"experimenteel" meer en Pi is grijs, *Organisatie* zegt "Eerste afdeling maken". Wat nergens in de app beloofd wordt maar wel op
het plan stond, staat onder C met *weggehaald* (de belofte is uit de handleiding) en blijft voor een volgende versie.

## A. Teksten in de app

### A1. Werkt nu

| Waar | Wat er stond | Waarom het niet werkte | Nu |
|---|---|---|---|
| Gebruiksbalk en *Gebruik en limieten* (`ui/src/modules/usage/UsageBar.tsx:227`, `UsagePage.tsx:113`) | Het streepje en "Weekreserve vanaf …: … Nu actief." verschenen nooit | `usage.reportReserve()` werd nergens aangeroepen | De balk leest de weekreserve van *Gratis doorschakelen* (standaard 85%) zelf, op de week van Claude én Codex, met *Nu actief.* erboven; opslaan in *Gratis doorschakelen* tekent de balk opnieuw. De zin zegt nu "naar een ander model" (was "naar gratis modellen"; het kan ook je andere abonnement of een reserve van de bot zijn). Test: `tests/usage-bar.test.ts` ("weekly reserve: the mark of Gratis doorschakelen …") |
| Chat, *Bronnen* onder een antwoord (acceptatie fout 4, F-09) | Geen bron als een lokaal model een pdf of Word-document gebruikte zonder `[s:…]` | Alleen herinneringen telden als stille bron | Ook het documentdeel dat het model kreeg en duidelijk gebruikte (een getal of naam eruit, of drie woorden; "€ 7.450" = 7450) staat eronder, met een link naar het dossier. Test: `tests/memory-implied-documents.test.ts` |
| *Instellingen › Teams* (B-13; de handleiding beloofde "dupliceren") | Geen knop; `copyTeamData` had geen aanroeper | Niet aangesloten | **Team dupliceren**: nieuw team met een kopie van elke bot (instructies, engine, skills, routines die uit staan, vakgebied van specialisten), hetzelfde bedrijfsprofiel, dezelfde teamleider en hetzelfde dagbudget; nooit geheugen, gesprekken, sleutels, kanalen, teammap of toegang van andere teams; de hoofdbot blijft er één. Alles of niets. Test: `tests/team-duplicate.test.ts` |

### A2. Eerlijk onmogelijk (blijft, rustig en alleen waar het speelt)

| Waar | Wat het zegt | Waarom het hier niet kan | Wat er veranderde |
|---|---|---|---|
| *Computers › Wat kan hier*, Hyper-V en Windows Sandbox op Windows Home (`server/modules/browser/capabilities.ts`) | "Niet mogelijk", in **rood** | Windows Home heeft ze niet | Grijs in plaats van rood (`CAP_STATUS` in `ui/src/modules/browser/api.ts`), met "TeamBot heeft Hyper-V/Windows Sandbox niet nodig: een afgeschermde bot draait in Docker Desktop" in plaats van "upgrade naar Pro" |
| Idem op Windows Pro | "TeamBot beheert nog geen Hyper-V-VM's zelf" / "kan Windows Sandbox nog niet automatisch bedienen" | TeamBot schermt af met Docker | "TeamBot start zelf geen …; een afgeschermde bot draait in Docker." |
| Idem op macOS en Linux | "Bureaubladbediening is nog niet beschikbaar op macOS/Linux" | Bediening werkt via Windows UI Automation | "Bureaubladbediening kan alleen op Windows, niet op macOS/Linux." (alleen daar zichtbaar) |
| *CLI-agents*, Pi coding agent (`ui/src/modules/cli-agents/index.tsx`) | "niet ondersteund", rode badge en rood vak | Pi voert tools uit zonder te vragen; TeamBot kan de toegangsmodus niet afdwingen | Badge en uitleg grijs |
| *CLI-agents*, Google Antigravity CLI, Factory Droid, Mistral Vibe, Amp | "experimenteel" (oranje), en "Experimenteel: …" in de beschrijving van Factory Droid | Gebouwd volgens de documentatie; proberen vraagt een account bij die maker | Grijze badge "niet live getest"; beschrijving "Niet live getest: …" |
| *AI-providers*, LocalAI, Lemonade, KoboldCpp, Text Generation WebUI, GPT4All en één API-dienst (`ui/src/pages/Providers.tsx`) | "experimenteel" (oranje) en "Experimenteel: … nog niet live getest" | Die programma's staan niet op deze pc | Grijze badge "niet live getest"; in het venster: gebouwd volgens de documentatie van de maker, "De knop hieronder laat meteen zien of het bij jou werkt." |
| *Telefoon › Installeren op je telefoon* (`ui/src/modules/mobile/PhoneSettings.tsx`) | Ontwikkelaarstekst: broncode in `mobile/ios`, "er is nog geen TestFlight- of App Store-versie" | Een iPhone-app bouwen en verspreiden vraagt een Mac en het Apple-account van de makers | "Een aparte app uit de App Store is niet nodig: op je beginscherm werkt TeamBot als een app, op de iPhone en op Android." |
| *Bot › Computer & bestanden › Eigen server (SSH)*, sleutel met wachtwoordzin (`server/modules/browser/remote.ts`) | "dat wordt nog niet ondersteund" | De wachtwoordzin zou naast de sleutel bewaard worden en dan niets beschermen | Zegt nu waarom, met de opdracht voor een aparte sleutel |
| Chat, bot in de modus *Privé-container* die wil browsen (`server/modules/browser/service.ts`) | "een browser in de container is nog niet beschikbaar" | In de container zit geen browser; TeamBot valt nooit terug op deze pc | "… daarin zit geen browser. Moet hij browsen, kies dan … “Eigen browser”." |
| *Apps & connectors › register*, pakket met eigen lokale webserver (`server/modules/mcp/registry.ts`) | "dat ondersteunt TeamBot nog niet" | TeamBot start alleen pakketten die via stdio praten | "TeamBot start alleen pakketten die via stdio werken. Kies een andere installatievorm." |
| Idem, MCPB-bundel | "worden nog niet ondersteund" | Bundelformaat voor een andere app | "Een MCPB-bundel installeert TeamBot niet. Kies een andere installatievorm." |
| *Instellingen › Spraak* op macOS (`ui/src/modules/voice/Settings.tsx:50`) | "Voorlezen met Piper is nog niet beschikbaar voor …" | Piper wordt alleen voor Windows en Linux meegeleverd | Ongewijzigd; alleen op die systemen zichtbaar, de andere stemmen werken wel |
| *Spraak*, Arabisch (`voice/Settings.tsx:56`, `VoiceFields.tsx`, `LocalModels.tsx`, `AgentVoice.tsx`, `server/modules/voice/tts.ts`) | "er is nog geen gratis lokale stem" | Er is geen stem met een vrije licentie | Ongewijzigd, met wat je wel kunt (systeemstem) |
| *Spraak*, lokaal spraakmodel "niet voor dit systeem" (`voice/LocalModels.tsx:69`) | Oranje badge | Geen bestanden voor dat systeem (bijv. Windows op ARM) | Ongewijzigd; op Windows x64 niet zichtbaar |
| *Live praten*, **Live (OpenAI Realtime)** (`voice/LiveCall.tsx:211`) | "Niet beschikbaar: hiervoor is een OpenAI API-sleutel nodig" | Betaalde dienst | Ongewijzigd; het gratis gesprek staat ernaast |
| *Netwerk en proxy* (`network/ProxySettings.tsx:129`) | "SOCKS wordt niet ondersteund." | Vraagt een extra bibliotheek (geen `npm install` in deze ronde); HTTP(S)-proxy werkt | Ongewijzigd (hint, grijs) |
| *Instellingen › Algemeen › Updates* (`ui/src/pages/Settings.tsx:228`) | "Automatisch bijwerken staat uit: Geen updatekanaal ingesteld." | Er is nog geen openbaar updatekanaal (GitHub-repository of hosting van de eigenaar) | Ongewijzigd: grijs, en je kunt zelf een kanaal invullen |
| *Apps & connectors*, Google Workspace "beperkt beschikbaar" (`mcp/Page.tsx`, `server/modules/mcp/catalog.ts`) | Oranje badge | Google Developer Preview, vraagt een Workspace-account | Ongewijzigd |
| *Apps & connectors* in servermodus, "Niet beschikbaar" | Knop uit voor leden | Lokale programma's alleen voor beheerders | Ongewijzigd (alleen in servermodus) |
| *Websites*, "(niet beschikbaar op deze computer)" (`sites/SitesPage.tsx:69`) | Keuze netwerk of Tailscale uit | Geen netwerkadres of geen Tailscale op deze pc | Ongewijzigd |
| *Bot › Computer & bestanden* en *Computers*, modus "Niet beschikbaar" / "Kan niet" met wat ontbreekt | Oranje, met de lijst | Bijv. Docker Desktop staat er niet op | Ongewijzigd: zegt precies wat je installeert |
| *Eigen server (SSH) › Cloud-VM* in servermodus (`browser/CloudVmSection.tsx:39`) | "Cloud-VM's zijn hier niet beschikbaar" | Regel van de beheerder | Ongewijzigd |
| *Kanalen*, goedkeuren via het kanaal (`channels/BindingDetail.tsx:449`) | "Niet beschikbaar voor dit kanaal" | Afzenders zijn daar niet sterk genoeg te controleren | Ongewijzigd (veiligheid) |
| *Bot-instellingen › Wat mag de bot?*, **Alleen chat** uit bij een CLI-engine (`ui/src/pages/AgentEditor.tsx:872`) | "Kan niet met …: die engine laat zich niet beperken tot alleen praten." | De CLI zelf | Ongewijzigd, met het alternatief |
| Chat, Codex zonder app-server (`server/modules/cli-agents/codex.ts:209`) | "Codex app-server niet beschikbaar — alleen lezen" | Goedkeuren per actie kan alleen via de app-server | Ongewijzigd (eerlijke terugval) |

### A3. Weggehaald

| Waar | Wat er stond | Waarom weg |
|---|---|---|
| *Overstappen uit OpenBot*, rollen (`server/modules/openbot-import/service.ts`, 2×) | "Een hoofdbot kan in deze versie van TeamBot nog niet." | Dode tekst: de hoofdbot zit in 0.4. Alleen zonder die module (tests) staat er nu "De hoofdbot staat in deze TeamBot niet aan." |
| Idem, specialisten (2×) | "Specialisten (die zelf leren) zitten nog niet in deze versie …" | Dood; nu "Specialisten staan in deze TeamBot niet aan" voor hetzelfde geval |
| Idem, teamtabellen (`ui/src/modules/openbot-import/TeamRoles.tsx`) | "die is in deze versie nog één voor al je teams" | Dood: de teamdatabase is per team (B2) |
| Dossierbron pdf (`server/modules/memory/dossiers.ts`) | "PDF lezen is nog niet beschikbaar in deze versie van TeamBot." | Pdf lezen zit erin; de tekst komt alleen als pdf.js ontbreekt: "… het onderdeel pdf.js ontbreekt in deze installatie. Installeer TeamBot opnieuw …" |
| Routines, e-mailtrigger (`server/modules/routines/engine.ts`) | "de kanalenmodule biedt (nog) geen e-mailontvangst" | Dood: e-mail ontvangen kan; nu "de kanalenmodule draait niet" |
| Welkomstscherm en *Gegevens* (`ui/src/pages/Home.tsx`, `Settings.tsx`) | "verzenden, betalen en verwijderen vragen altijd" | Niet meer waar sinds de Prullenbak: nu "… en verwijderen wat niet terug kan, vragen altijd" |
| *Bot-instellingen*, uitleg bij **Automatisch** (`AgentEditor.tsx:122`) | "(verzenden, betalen, verwijderen, publiceren) vragen altijd" | Idem |
| *Organisatie* (`ui/src/modules/rooms/org.tsx`; de handleiding zei "De pagina noemt een afdeling nog team") | **Eerste team maken**, **Team maken**, **Hoort bij team**, "Nog geen teams", "hoofdteam" | Verwarrend naast de echte teams van 0.4: nu **Eerste afdeling maken**, **Nieuwe afdeling**, **Afdeling maken**, **Hoort bij afdeling**; `tests/e2e/c4-groups.mjs` volgt mee |

**Geen actie nodig (toestand, geen ontbrekende functie):** lege staten ("Nog geen bots", "Nog geen routines", … op
±120 plekken), de stand van een koppeling ("Verbonden, nog niet getest", "Ontvangen nog niet getest", "nog niet
gedaan"), "nog niet gemeld" en "nog niet opgevraagd" op de gebruiksbalk, "nog niet getest" als toollabel van een gratis
model, "Nog niet afgeleverd" bij concepten op de telefoon, "Nog niet bekeken" bij een specialist, "nog niet opgeslagen"
bij een formulier, en de weigeringen in de teamdatabase ("Transacties zijn niet beschikbaar"; tekst voor de bot). Geen
`TODO`/`FIXME` bij de interface; geen knop die altijd uit staat.

## B. Handleiding: de markeringen `0.4-pending`

Elk stuk is naast de echte interface gelegd (exacte namen, waar het staat, wat het doet). Allemaal op `main`; de
markering is overal weg.

| Regel (oud) | Pakket | Onderwerp | Uitkomst |
|---|---|---|---|
| 67 | Q | Kaart *Lokale modellen op deze pc* op het welkomstscherm | weggehaald: de kaart toont daar een **Aanrader voor je eerste bot**, de lijst passen/traag/te groot staat achter **Alle lokale modellen** |
| 71 | R | Beginnen met een kant-en-klaar team | klopt; de knopnaam **Of begin met een kant-en-klaar team** erbij |
| 88 | C2 | Vierde vraag bij een nieuwe bot | weggehaald: heet **Soort bot**, met **Gewone bot** of **Hoofdbot** |
| 102 | O | Overstappen met teams en rollen | weggehaald: geen rol per bot, wel **In welk team**, **Hoofdbot**, **Teamleider**, **Specialisten**, **Wat niet meekomt**, **Import ongedaan maken** |
| 118 | A3 | Teamkiezer bovenaan | klopt |
| 122 | C2 | Hoofdbot bovenaan, "daaronder het teamgesprek" | weggehaald: er is geen vast teamgesprek; daaronder staan de bots en groepen van het gekozen team |
| 182 | D2 | Weekreserve met streepje op de weekbalk | werkt nu (zie A1); tekst: ook de Codex-week, naar een ander model uit de keten, waar je de grens zet |
| 186 | B2/B3 | Verbruik per team | klopt; "vanaf twee teams" erbij |
| 230 | Y | Zuinig met tokens | weggehaald: de tekst zei het omgekeerde ("wordt niet steeds opnieuw verstuurd"); nu wat TeamBot echt doet en waar je het ziet |
| 259 | D2 | Automatisch doorschakelen | weggehaald: "voor het hele team" en "Per team aan te passen" klopten niet (één keuze voor al je bots, per bot uit te zetten); de eigen reserves gaan voor |
| 264 | D2 | **Belangrijk** pauzeert | klopt; waar je het niveau kiest en de privé-schakelaar per bot erbij |
| 270 | Q | Lokale modellen slim kiezen | klopt; waar het staat en de labels erbij |
| 305 | C2 | Kop "De hoofdbot en leiders" | klopt |
| 308 | C2 | Hoofdbot kiezen | klopt; **Soort bot** en "onder **Geavanceerd**" erbij |
| 313 | C2 | Leiders | weggehaald: leider word je met **Aansturen** op één ander team (niet "meerdere"), te zien onder **Leiders** op **Alle teams** |
| 372 | G | Toestemming alleen waar het telt | weggehaald: geldt voor **Automatisch** en **Volledige toegang** (niet voor de standaard **Vraagt toestemming**); "nooit een opdracht" is "behandelt als gegevens" |
| 402 | A3 | Nieuwe bot in het gekozen team, overzicht **Alle teams** | klopt |
| 433 | B2/B3 | Wat per team is | werkt nu voor **Team dupliceren** (A1); weggehaald: kanalen, skills, routines per team en "elk team heeft een teamgesprek" (niet gebouwd); "exporteren als sjabloon" wijst nu naar **Exporteren als team** van een groep |
| 439 | R | Team uit een sjabloon | weggehaald: de vragen en skills zijn er alleen op het welkomstscherm; later onder **Groepen › Nieuwe groep › Uit een sjabloon**; **Nieuw team** begint leeg |
| 469 | C1 | **Klaar als**, frisse blik, bewijs | klopt (hoofdletter zoals in de app) |
| 474 | C1 | Claimen, lussen, lessen | weggehaald: een correctie wordt een les voor die bot, niet voor het hele team |
| 479 | D2 | Taak met **Belangrijk** | klopt; waar de knop zit (taakvenster, taken van het bord) |
| 506 | B2/B3 | "Groep en team worden één begrip", teamgesprek, extra groepen onder Geavanceerd | weggehaald: alleen "een groep hoort bij één team" klopt |
| 544 | B2/B3 | Geheugen per team | klopt |
| 550 | S | Specialist worden | weggehaald: exacte namen (**Geavanceerd › Specialisme**, **Specialist in een vakgebied**, **Vakgebied**, **Bronnen**) |
| 555 | S | Leerronde en kennisbank | weggehaald: **Leerronde aan**, **Elke ochtend**/**Elke maandagochtend**, **Kennisbanken**, **Te controleren**; niet altijd gratis (anders de eigen engine binnen het dagbudget, zie **Leert met:**) |
| 560 | S | Bronnen zijn gegevens, leerdoelen, verslag, skillvoorstel | klopt |
| 591 | G | Routines met bewijs, **Gemist terwijl je pc uit stond** | klopt |
| 596 | D2 | Routine met **Belangrijk** | klopt |
| 607 | H | Eigen skillcatalogus | weggehaald: "per team" en "afgeschermd in de map van het team" klopten niet (voor al je teams; scripts in de werkmap van de bot, eerst **Scripts vertrouwen** en daarna per run goedkeuren) |
| 673 | G | Prullenbak | weggehaald: geen momentopname van de hele teammap; **Alles terugzetten** staat op het **Run-bonnetje**; wat een CLI-engine zelf schrijft gaat erbuiten om |
| 698 | L | Spraak: ingedrukt houden, wie luistert, hetzelfde model | weggehaald: exacte keuzes; hetzelfde model alleen bij het **Gratis gesprek** |
| 723 | K | Telegram, QR-waarschuwing, **Verbonden** pas na echt testen | klopt |
| 727 | K | Kanaal per team, klantenregels | weggehaald: een kanaal hoort niet bij één team; de klantenregels gelden met **Klantenservice: deze bot praat met klanten**, met de exacte schakelaars |
| 749 | I | De iPhone-app (TestFlight) | eerlijk onmogelijk: er is geen app; uitleg waarom (Mac en Apple-account van de makers) en dat het beginscherm werkt |
| 754 | I | Verbindingsstatus van de iPhone-app | weggehaald (hoort bij de app die er niet is) |
| 869 | P | "Alles wat je pc verlaat, staat standaard uit" | weggehaald: zoeken op internet staat aan en een bot praat met zijn AI-dienst; nu wat echt uit staat, waar **Wat verlaat je pc?** en **Wie kan TeamBot bereiken?** staan |

Daarbij verbeterd zonder markering, omdat het niet meer klopte met de app: de tabel van **Instellingen** (hoofdstuk 2:
**Gratis doorschakelen**, **Kennisbanken**, **Teams** en **Alle teams** onder **Bots en groepen**, **Prullenbak**), "**Teams**
(in de groep **Geavanceerd**)" werd **Bots en groepen**, **Teamwerk** staat één klik onder **Taken** (was "zoek het met
Ctrl+K"), de rij **Automatisch** en de zin over **Altijd toestaan** (verwijderen naar de prullenbak is terug te draaien),
de nieuwe namen op **Organisatie**, en in hoofdstuk 26 de regel dat kanalen, skills en routines voor al je teams gelden.

## C. Acceptatielijst (`docs/ACCEPTANCE_0.4.md`): wat *nog niet gebouwd*, *deels* of *kapot* was

Die lijst is geschreven op `4d8805b`, vóór de samenvoeging van C1, C2, D2, G, H, I, K, L, M, O, P, Q, R, S, Y, A3, B2
en B3. Per punt de stand op deze tak.

| # | Was | Nu | Waarom / bewijs |
|---|---|---|---|
| A-02 | kapot (fout 1) | werkt nu | Teamwerk één klik onder Taken (`4c3c4b5`, `tests/e2e/layout.mjs`) |
| A-05 | deels | werkt nu | Vertaalronde 1 (`a729b5d`); "Mijn team" volgt de taal (`trUser`). De teksten die deze ronde veranderde, moeten nog door de vertaalronde |
| A-07 | kapot (fout 1) | werkt nu | Idem A-02 |
| A-10 | nog niet gebouwd | werkt nu | Teamkiezer (A3) en hoofdbot bovenaan (C2); "daaronder het teamgesprek" is uit de handleiding (zie B, 122) |
| B-05 | nog niet gebouwd | werkt nu (geheugen, dossiers, zoeken); weggehaald (kanalen, skills) | B3; kanalen en skills gelden voor alle teams, de handleiding belooft niets anders meer |
| B-09 | nog niet gebouwd | werkt nu | **Alle teams** (C2, `server/modules/teams/overview.ts`) |
| B-13 | nog niet gebouwd | werkt nu | **Team dupliceren** (A1); een groep als bestand met **Exporteren als team** |
| B-14 | nog niet gebouwd | werkt nu (budget, logboek per team); weggehaald (kanalen, skills, routines per team, groep = team) | B2; de beloftes zijn uit de handleiding, `release.json` zegt het ook |
| C-01 | nog niet gebouwd | werkt nu | C2 (`tests/teams-org.test.ts`) |
| C-02 | nog niet gebouwd | werkt nu | C1 (`tests/quality.test.ts`) |
| C-03 | nog niet gebouwd | werkt nu | C1 (`server/agent/loops.ts`) |
| D-01 | nog niet gebouwd | werkt nu | D2 (`tests/engine-chain.test.ts`, "simulated limit on OpenCode") |
| D-02 | nog niet gebouwd | werkt nu | D2 ("an important task pauses …") |
| D-03 | deels | werkt nu | D2 ("a free model that is gone drops out of the chain") |
| D-10 | nog niet gebouwd | werkt nu | D2 ("private work …") |
| E-09 | nog niet gebouwd | werkt nu | D2; het streepje op de balk sinds deze ronde (A1) |
| E-10 | nog niet gebouwd | werkt nu | B2 (verbruik per team, vanaf twee teams) |
| E-11 | nog niet gebouwd | weggehaald | Zwaar werk over de vijfuursvensters verdelen is niet gebouwd en wordt nergens in de app, de handleiding of op de site beloofd; blijft op het plan |
| F-07 | nog niet gebouwd | werkt nu (geheugen per team); weggehaald (lessen van het team) | B3; een les is per bot, zo staat het nu ook in de handleiding |
| F-09 | deels (fout 4) | werkt nu | A1 |
| G-01 | nog niet gebouwd | werkt nu | G (`tests/routine-proof.test.ts`) |
| G-02 | nog niet gebouwd | werkt nu | G (`tests/trash.test.ts`) |
| G-03 | nog niet gebouwd | werkt nu | G (Windows job objects, `tests/cli-stop.test.ts`) |
| G-06 | nog niet gebouwd | werkt nu | G (bewijs, gemiste runs, momentopname per run, toestemming waar het telt) |
| H-01 | nog niet gebouwd | weggehaald | De catalogus werkt, maar een skill geldt voor al je teams (installeren per team is niet gebouwd); de handleiding zegt dat nu |
| H-02 | nog niet gebouwd | werkt nu | H (`tests/skills-catalog.test.ts`) |
| H-03 | nog niet gebouwd | werkt nu | H (scripts uit tot vertrouwd en per run goedgekeurd) |
| I-01 | nog niet gebouwd | eerlijk onmogelijk | TestFlight vraagt de App Store Connect-sleutel van de eigenaar en een cloud-Mac; de bouwstraat staat klaar (`.github/workflows/ios-companion.yml`) |
| I-02 | nog niet gebouwd | eerlijk onmogelijk | Hoort bij de app uit I-01 |
| J-02 | nog niet gebouwd | eerlijk onmogelijk (in deze ronde) | Schermafbeeldingen van 0.4 voor de site: buiten deze opdracht (alleen `release.json` van de site mocht hier veranderen) |
| K-01 | nog niet gebouwd | werkt nu | K (`tests/channels-customer.test.ts`) |
| K-02 | nog niet gebouwd | werkt nu | K |
| L-01 | nog niet gebouwd | eerlijk onmogelijk (in deze ronde) | `voice:live` is een live poort; die draait de agent van de poorten |
| L-02 | nog niet gebouwd | werkt nu | L |
| M-01 | nog niet gebouwd | werkt nu | M (`npm run quality`, `40de1ea`) |
| M-02 | nog niet gebouwd | werkt nu | M (verslag en basislijnen in de repo) |
| M-03 | nog niet gebouwd | eerlijk onmogelijk (in deze ronde) | Een meting (30 taken op Ollama, uren werk op één geladen model), geen functie in de app; hoort bij de poorten |
| S-01 … S-06 | nog niet gebouwd | werkt nu (6) | S (`tests/specialists.test.ts`) |

Van de gevonden fouten zijn 1 en 4 nu gerepareerd (A-02 en F-09); 2 en 3 waren al gerepareerd. (Telling in de
samenvatting: S-01 … S-06 als zes punten; B-05, B-14 en F-07 tellen als *werkt nu*, met het deel dat niet gebouwd is
onder *weggehaald* in de handleiding. De *extern*-punten D-09, E-02, E-08, F-02, I-03, J-03 en N-05
waren al eerlijk als "vraagt een account, apparaat of VM" en zijn niet veranderd.)

## D. `website/src/release.json`

Alle schakelaars kloppen met wat meegaat: aan voor `teams`, `mainBot`, `proof`, `freeChain`, `pauseImportant`,
`privateWork`, `privacyLabels`, `usageBar`, `weekReserve`, `simpleLayout`, `semanticMemory`, `missedRuns`, `trash`,
`catalog`, `customerSafe`; uit voor `iphoneApp` (geen TestFlight). De beschrijving van `teams` noemde kanalen en
routines per team en die van `weekReserve` alleen gratis modellen; beide verbeterd.

**Open voor wie de site bijwerkt** (buiten deze opdracht): `website/src/nl.json` regel 156 en 171 ("eigen … kanalen en
routines", "kanalen blijven per team gescheiden") en 316 ("kanalen, skills, routines, budget en logboek" per team), en
dezelfde zinnen in `en.json`, beloven meer dan 0.4 doet. Kanalen, skills en routines gelden voor alle teams.
