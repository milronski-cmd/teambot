# Praktijktest 0.4.4 — de kern van dagelijks gebruik

Datum: 9 november 2026. Getest op de code van 0.4.3 (branch `worktree-agent-ac2bd87c4ebc2ec99`), als een nieuwe
gebruiker, in een echte browser (Edge via Playwright, zonder venster) op pc-formaat (1440×900) en als gekoppelde
iPhone (402×874, aanraken, iOS-app als user-agent, eigen apparaatsessie via de echte QR-koppeling).

## Opzet

- Twee verse TeamBots, elk met een eigen tijdelijke `TEAMBOT_DATA`, `APPDATA`, `HOME` en `LOCALAPPDATA` (in de
  scratchmap), desktopmodus, de gebouwde UI:
  - **A** op poort 4813: alleen het **Testmodel** (een gescripte AI die per bot antwoordt) als "gevonden op deze pc";
    later ook een test-abonnement en een test-gratisbron voor de gratis keten en de gebruiksbalk.
  - **B** op poort 4833: alleen **OpenCode** (gratis modellen, geen account), zoals een nieuwe gebruiker zonder
    abonnement begint. Hierop 6 echte, korte taken met Big Pickle.
- Niets van de eigen TeamBot, Ollama of het Claude-abonnement van de eigenaar is gebruikt; poorten 4747/4748 niet.
- Schermafbeeldingen alleen in de tijdelijke map. Bewijs hieronder als korte stappen.

## Uitkomst in getallen

| | Werkt | Half | Werkt niet |
|---|---|---|---|
| Vóór (0.4.3) | 19 | 7 | 2 |
| Na (deze branch) | 25 | 3 | 0 |

28 onderdelen getest; niet getest staat onderaan.

## Per onderdeel

| Onderdeel | Status vóór | Status na | Bewijs (stappen) | Oorzaak |
|---|---|---|---|---|
| Welkomstscherm, drie manieren | werkt | werkt | Lege TeamBot → **Welkom bij TeamBot** met **Ik heb Claude of ChatGPT** (Installeren), **Ik heb een API-sleutel** en **Gratis beginnen** (Testmodel **Gebruiken**, OpenCode **Gratis starten**). | — |
| Manier 2: API-sleutel | werkt | werkt | `sk-proj-…` → "Herkend: OpenAI (API)", **Koppelen** → "Deze sleutel werkt niet bij OpenAI (API): 401 …" met oplossing; `gsk_…` → Groq, idem; onzin → "TeamBot herkent deze sleutel niet". Geen provider of geheim opgeslagen. | — |
| Manier 3: gratis met OpenCode | werkt | werkt | **Gratis starten** → "Versie en handtekening ophalen…", download 125 MB, "Gecontroleerd. Uitpakken…", na 31 s de drie vragen met **OpenCode · Big Pickle · Aanbevolen** → bot **Gratis** → "Wat is de hoofdstad van Frankrijk?" → "Parijs." in 6 s. | — |
| Hoofdbot maken | half | half | Eerste bot (Baas) heeft geen vraag **Soort bot**; via **⋮ › Bot-instellingen › Geavanceerd › Hoofdbot › Baas hoofdbot maken** wordt hij hoofdbot (`main: true`, stuurt Fietsenwinkel aan). | HANDLEIDING §1 zegt dat de eerste bot de vierde vraag **Soort bot** krijgt; de app stelt die vraag pas bij latere bots (`kindQuestion={!firstBot}`). Documentatie of app gelijktrekken. |
| Team met teamleider en specialisten | werkt | werkt | **Instellingen › Teams › Nieuw team** "Fietsenwinkel"; drie bots gemaakt (komen in Mijn team), met **Naar dit team verplaatsen** naar Fietsenwinkel; **Teamleider** Lisa; Sem via **Specialisme** specialist "SEO voor Nederlandse fietsenwebshops" met een bron. | — (zie open punt: nieuwe bot zegt niet in welk team hij komt) |
| Delegatie, takenbord, goedkeuring, "klaar als" met bewijs (Testmodel) | werkt | werkt | Baas: `task_create` (eigenaar Lisa, klaar als "bestand met drie zinnen") en `delegate_task` → Lisa → Tom; Tom wil `producttekst-ebike.md` schrijven → kaart in **Wacht op jou** → **Eenmalig toestaan** → `task_done` met bewijs → tweede controle "klaar" → kaart in **Klaar** met "Gecontroleerd: klaar · 1 bewijsstuk"; Baas meldt het resultaat. | — |
| Hetzelfde met een echt gratis model (OpenCode) | werkt niet | werkt | Vóór: taak aangemaakt, daarna "Gratis is gestopt: 3× achter elkaar dezelfde stap (Wil code uitvoeren)" en "Tool execution interrupted". Na: taak met klaar als, gedelegeerd aan Schrijver, kaart "Bestand schrijven: ebike.md", toegestaan, twee zinnen geschreven, `task_done` met het pad als bewijs. | De lusbewaking keek naar de eerste titel van een stap; OpenCode 2.x begint elke stap ("code mode") als dezelfde kale "Wil code uitvoeren". Drie verschillende stappen op rij leken één stap drie keer. Opgelost: commit `00df55e`. |
| Takenkaart na het melden | half | werkt | Taak van Schrijver op **Te controleren**: kaart zei tegelijk "Wacht op jou" en "Schrijver werkt eraan". | De claim blijft staan na het melden (zodat dezelfde bot het kan herstellen); de kaart toonde hem als "werkt eraan". Opgelost: `b8dd0fb`. |
| Goedkeuringen: eenmalig, altijd, weigeren | half | werkt | **Eenmalig toestaan** en **Altijd toestaan voor deze bot** (tweede schrijfactie vroeg niets meer) werken. **Weigeren**: de bot kreeg "De gebruiker heeft deze actie geweigerd", maar de stap in de chat zei "Schreef een bestand · Schrijven: geheim.txt". | Een weigering komt ook als foutresultaat terug; de stap koos dan de verleden tijd. Opgelost: `f297178` ("Niet toegestaan"). |
| Geheugen: iets vertellen | werkt | werkt | "Onthoud dat mijn fietsenwinkel De Snelle Spaak heet." (OpenCode) → "Onthouden (Over jou)" met **Ongedaan maken**, de bot bevestigt, geen dubbele kaart. **Geheugen › Snel vastleggen** "Mijn hond heet Bram." werkt ook. | — |
| Geheugen: iets verbeteren | werkt | werkt | "Ik woon niet meer in Utrecht, ik ben verhuisd naar Amersfoort." → kaart "Bijwerken: … → Ik woon in Amersfoort" → toegestaan → nieuwe versie actief, oude in de geschiedenis. | — |
| Geheugen: later vragen | half | werkt | Nieuw gesprek "Hoe heet mijn winkel ook alweer?" (OpenCode) → "Je winkel heet De Snelle Spaak." met **Bronnen**. Maar "Waar woon ik ook alweer? En hoe heet mijn hond?" gaf alleen de hond mee aan de bot. | Na een verbetering scoorde "Ik woon in Amersfoort" 0,29 tegen 1,08 voor de hond en viel onder de grens "dicht bij de beste". Opgelost: `2549d23` (elke vraag ook apart, alleen op woorden, hoogstens drie regels extra). |
| Dossiers | werkt | werkt | **Geheugen › Dossiers › Nieuw dossier** "Verbouwing winkel"; **Bronnen › Bestand toevoegen** een offerte (.txt) → doorzoekbaar; vraag in de chat koppelt het dossier vanzelf en geeft het stuk "Oplevering: vrijdag 18 december" mee. | Klein: "1 delen doorzoekbaar" (zie open punten). |
| Skills uit de catalogus | werkt | werkt | **Marktplaats › Catalogus › SEO**, **Installeren voor** Fietsenwinkel, `seo-hreflang` → "Geïnstalleerd", in **Mijn skills** met versie en licentie. | — |
| Skill zelf maken | werkt | werkt | **Mijn skills › Importeren › Plakken** een SKILL.md → **Voorvertoning** (geen bevindingen, alleen instructies) → **Installeren**. | — |
| Routines | werkt | werkt | **Nieuwe routine** (Tom, werkdagen 09:00; eerstvolgende runs zichtbaar) → **Nu testen** → **Historie**: "Geslaagd · Test" met bonnetje. | — |
| Triggers | werkt | werkt | **Triggers › Trigger toevoegen › Webhook (GitHub)**; geheim één keer getoond; ondertekende POST → 202 en een run "done"; foute handtekening → 401. | — |
| Routine vanuit de chat | werkt | werkt | "Herinner me elke maandag om 9 uur aan de container." → kaart "Routine aanmaken … Elke maandag om 09:00" → toegestaan → routine actief, eerstvolgende run ma 16 nov. | Klein: de kaart onder de stap toont "elke MO" als het model Engelse dagcodes gebruikt (zie open punten). |
| Gebruiksbalk | werkt | werkt | Abonnement (test) 5 uur 40 %, Week 90 % "bijna op" met resettijden; gratis bronnen "beschikbaar"; uitklappen geeft uitleg per bron. | — |
| Gratis keten en weekreserve | werkt | werkt | Boven 85 % van de week: "Overgeschakeld naar Gratis bron (test) · llama-3.3-70b, omdat Abonnement (test) · claude-test al 90 % van de weeklimiet heeft gebruikt (grens 85 %) …". | — |
| "Belangrijk" pauzeert | werkt niet | werkt | Taak op het bord gemaakt, **Wie doet het** Kees, **Bezig**, **Belangrijk** aan; in de chat van Kees "Maak de offerte voor Jansen af" met het abonnement op de limiet → het werk ging naar de gratis bron en daarna naar het lokale model. | Alleen een taak uit een gesprek of groep telde; een taak die op het bord is gemaakt heeft geen gesprek. Opgelost: `3e562de` (telt ook in de eigen chats van de eigenaar met die bot). |
| Zoeken (Ctrl+K) | half | half | Vindt bots, instellingen (Enter op "weekreserve" opent Gratis doorschakelen), berichten, geheugen, routines en bestanden. "Offerte Jansen" vindt de taak "Offerte voor Jansen afmaken" niet. | Taken zitten niet in de zoekbronnen (`server/modules/search`), terwijl het venster "Zoekt overal in TeamBot" zegt. Open. |
| Bestanden in de chat | werkt | werkt | **Bestand toevoegen** een .csv en een .png → de bot krijgt de csv als bijlage en de afbeelding; **Zijpaneel › Bestanden** toont "Gedeeld in dit gesprek". | — |
| Geschiedenispagina's | werkt | werkt | **Bot-instellingen › Geschiedenis** met **Vergelijken met nu** / **Terugzetten**; naam van de bot opent **Jouw gesprekken** en **Overleg tussen bots**; **Wacht op jou › Geschiedenis** met alle besluiten; **Geschiedenis wissen…** toont wat weggaat en blijft. | — |
| Instellingen | werkt | werkt | 25 rijen in 8 groepen (ongewijzigd); Algemeen, Teams, Marktplaats, Geheugen openen binnen Instellingen. | — |
| Telefoon: bericht versturen | werkt | werkt | Gekoppelde iPhone: chat openen, typen, **Versturen** → antwoord komt, invoerveld leeg, niets schuift opzij. | — |
| Telefoon: invoerbalk en meelopen met het antwoord | half | werkt | Lang bericht getypt (invoerveld groeit tot 5 regels) → het laatste bericht verdween 108 px achter het invoerveld; na versturen liep het lange antwoord onder het scherm door, achter **Naar nieuwste** (2 van 2 keer). | De chat bleef alleen onderaan bij een nieuw bericht, niet als het gespreksvlak kleiner werd (groeiend invoerveld, "Nieuw bericht terwijl … werkt"). Opgelost: `9216b25`, met een stap in `tests/e2e/phone-owner.mjs`. |
| Tweede controle op een gratis model | half | half | Echte taak van Schrijver: "Niet automatisch gecontroleerd: de controle lukte niet (OpenCode gaf een fout: Free usage limit reached …). Kijk het zelf na." → **Te controleren**. 23 s later lukte de controle van de delegatie wel. | De gratis daglimiet van OpenCode (na ±6 korte taken). Eerlijk afgehandeld, maar er is geen nieuwe poging later. Open. |

## Fixes in deze branch

| Commit | Wat | Test |
|---|---|---|
| `00df55e` | Lusbewaking stopt OpenCode niet meer na drie verschillende code-mode-stappen (stap telt naar wat hij nu zegt; wachtende stappen tellen nog niet). Kern: `server/agent/loops.ts`, optioneel veld `pending` in `ActivityItem` (`server/core/types.ts`). | `tests/cli-stop.test.ts` (nep-OpenCode met drie code-mode-stappen), `tests/quality.test.ts` |
| `3e562de` | "Belangrijk" op een taak van het bord pauzeert de bot in zijn eigen chat met de eigenaar. | `tests/engine-chain.test.ts` |
| `b8dd0fb` | Takenkaart zegt niet meer "werkt eraan" nadat de bot de taak meldde. | `tests/quality-claim-ui.test.ts` |
| `2549d23` | Geheugen: twee vragen in één bericht krijgen allebei hun antwoord mee. | `tests/memory.test.ts` |
| `9216b25` | Chat houdt het nieuwste bericht in beeld terwijl het invoerveld groeit en het antwoord binnenkomt. | stap in `tests/e2e/phone-owner.mjs` (faalt zonder de fix: 17 px) |
| `f297178` | Geweigerde stap zegt "Niet toegestaan". | `tests/tool-step-status.test.ts` |

Geen nieuwe teksten voor gebruikers, dus geen nieuwe vertalingen nodig. Instellingen blijft op 25 rijen.

`npm run typecheck` is groen. De volledige `npm test`: 1321 van 1327 geslaagd; de 6 andere (browser-livebeeld,
kanaalstatus, Claude-streaming, Codex-sandbox, en twee bestanden die op 60 s vastliepen: `context-budget`,
`memory-review-interval`) slagen allemaal als ze los draaien, ook met deze wijzigingen: ze hadden last van de volle
belasting van de pc tijdens de hele run.

## Open punten (niet in dit pakket)

| Punt | Oorzaak | Grootte |
|---|---|---|
| Ctrl+K vindt geen taken | Geen bron `task` in `server/modules/search`; de takenpagina heeft ook geen diepe link naar één taak (`openKey` is alleen staat). | Middel: zoekbron + `HitKind` + palette-groep + `#/tasks?open=` (±60 regels, plus vertaling van één groepsnaam). |
| Tweede controle mislukt op de gratis limiet en blijft "Te controleren" | `quality/verify.ts` faalt dicht en probeert later niet opnieuw. | Middel: opnieuw proberen na de reset (de keten kent de hervattijd). |
| HANDLEIDING loopt achter op 0.4.2/0.4.3 | §1 "Soort bot" bij de eerste bot; §2 vijf vaste plekken in de zijbalk (nu Wacht op jou, Taken, Instellingen); de tabel van Instellingen gebruikt oude namen (AI-providers, CLI-agents, Limieten …). | Klein: tekst bijwerken. |
| Nieuwe bot met twee teams en **Alle teams** gekozen zegt niet in welk team hij komt | Hij komt in het eerste team (zo beschreven), maar de vragen tonen dat niet; kiezen kan alleen onder **Meer opties**. | Klein: één regel onder de vragen (nieuwe tekst, 10 vertalingen). |
| "1 delen doorzoekbaar" bij een dossierbron; Engelse vertaling "shares" | `ui/src/modules/memory/dossiers.tsx` plakt het getal voor "delen"; de vertaling las "delen" als werkwoord. | Klein: ICU-meervoud + 10 vertalingen. |
| Kaart onder een routine-voorstel toont "elke MO" | `RoutineCreateCard` kent alleen ma–zo; de server begrijpt meer dagcodes. | Klein. |
| Zijpaneel toont **Geheugen** ook zonder **Geavanceerd tonen** | Handleiding zegt alleen met Geavanceerd tonen. | Klein (app of handleiding). |
| Echte iPhone-toetsenbord | De browseremulatie kent geen echt iOS-toetsenbord; de e2e bootst `visualViewport` na. Op een echte iPhone nog eens kijken of de balk stil staat. | — (handmatig) |

## Niet getest

- **Ik heb Claude of ChatGPT** verder dan de knop: installeren (160–181 MB) kan, maar inloggen zou het abonnement van
  de eigenaar gebruiken.
- **Of begin met een kant-en-klaar team**, **Uiterlijk** en live spraak (ander pakket).
- Echte taken: 6 op OpenCode (Parijs; onthoud; later vragen; delegatie vóór en na de fix; het vervolg met de
  goedkeuring). Daarna gaf OpenCode "Free usage limit reached".
