# Poorten — TeamBot 0.4.2

Stand: 9 november 2026. Alle releasepoorten op de samengevoegde code van 0.4 (alle pakketten, de vereenvoudigde desktop,
de installer, de pariteitsronde, de telefoon van 0.4.2 en F2), op de tak `worktree-agent-abbfa55a6ee672a49`. De laatste
runs van typecheck, `npm test`, build, e2e, accept, parity, phone, i18n en de kwaliteitsmeting zijn op git `1ea1e1c`;
a11y, mobile, perf, licenses, secrets, website en status op `c5dbf60` (daarna veranderden alleen testbestanden, de
woordenboeken en één `aria-label`). 0.4.0 en 0.4.1 gingen naar de pc van de eigenaar met alleen typecheck, unit tests
en de secret-scan; dit is de eerste keer dat de zware poorten op de code van 0.4 draaien.

**Hoe.** Eén poort tegelijk, elk met een eigen tijdelijke `TEAMBOT_DATA` en `APPDATA` (onder `.data/gates/` in de
worktree); poorten met een vaste poort op 4853 (`TEAMBOT_E2E_PORT`), de rest op een vrije poort; nooit 4747/4748 en
nooit de gegevens van de TeamBot van de eigenaar. Windows 11 Home x64, Node 26.13.0, Edge headless, met andere agents
op dezelfde pc. Een mislukking telt pas als hij twee keer gebeurt; een eenmalige is hieronder genoemd en niet als fout
gerekend.

## Uitkomst

| Poort | Uitkomst |
|---|---|
| `npm run typecheck` | schoon (TypeScript 7, server en UI) |
| `npm test` | **1281/1281 groen** (73 s). Eén keer faalde `acp: OpenCode 1.x that only logs a model error …` op "the waiting turn is cancelled" (de pc was druk, 129 s); bij de herhaling groen, dus niet gerekend |
| `npm run build` | geslaagd |
| `npm run e2e` | **alle 16 suites geslaagd** (312 s): smoke, extensions-ui, c2-chat, c2-proposals-restart, c2-routines-memory, c2-security-phone, files-chat (ook de spraakstap), language-switch (18/18), c4-core, c4-groups, c4-models-cli-review, shared-bot, history-pages, newcomer, layout (77/77), phone-owner. `smoke` zag één keer een bestand niet binnen 8 s in Ctrl+K (de zoek-API zelf vond het in 18 ms); bij de herhaling groen |
| `npm run accept:04` | `accept-04-core` **73/73**, `accept-04-data` **49/49** (142 s, poort 4853) |
| `npm run a11y` | **0 bevindingen** (axe-core, WCAG 2.2 A/AA), ook bij 200% en 400% zoom en op 320 en 390 px |
| `npm run i18n:check` | 10 talen × **15.687 teksten: 0 ontbrekend, 0 fouten**; **94 pagina's per taal: 0 zichtbare onvertaalde tekst, 0 paginafouten** (873 s). Eerdere runs in deze ronde vonden 25 (daarna 1) zichtbare teksten per taal; zie *Gevonden en gerepareerd* |
| `npm run mobile:check` | **20/20** |
| `npm run perf` | **14/14** binnen budget (langste blokkering 214 ms, budget 400) |
| `npm run licenses:check` | **394 productie-dependencies permissief** (ook de nieuwe onnxruntime-node 1.30.0, MIT, en @huggingface/tokenizers 0.2.0, Apache-2.0). De worktree heeft geen eigen `node_modules`, dus `npm ls` faalt daar; gedraaid met een tijdelijke koppeling (junction) naar de `node_modules` van de hoofdmap, met hetzelfde `package.json` en `package-lock.json`, daarna weggehaald |
| `npm run secrets:check` | **0 treffers** in 1.749 bestanden (repo met de nieuwe kwaliteitsverslagen, en `dist/`; geen `release/`, want in deze ronde is geen installer gebouwd), ook na de laatste commit |
| `npm run website:check` | 17 pagina's × 6 breedtes (320–1360 px) × licht/donker: **0 bevindingen, 0 axe-bevindingen** |
| `npm run status:check` | **22/22** in echte Electron |
| `npm run parity:04` | **182/182** (232 s, poort 4853) |
| `npm run phone:check` | **geslaagd** (16 stappen als gekoppelde iPhone) |
| `npm run first-launch:check` | **niet gedraaid.** Hij start de uitgepakte Windows-app (`release/win-unpacked`); die moet eerst gebouwd worden met `npx electron-builder --win dir` of `npm run dist:win`, en verpakken mocht in deze ronde niet (en de worktree heeft geen eigen `node_modules` om mee te verpakken). Hij toont ook ±40 s een venster en een tray-icoon op het bureaublad van de eigenaar. De enige `win-unpacked` op deze pc is de build van 0.4.1 (03:52), niet deze code. Doen op de pc van de eigenaar of een VM na `dist:win` |
| `npm run dist:win` | niet gedraaid (regel van deze ronde: geen installer bouwen of starten) |
| `npm run memory:bench` | overgeslagen (optioneel en traag); de laatste meting staat in `docs/quality/memory-bench.md` |
| `npm run quality -- --engine ollama` | **16 van 30 geslaagd, gemiddelde score 0,69** (0.3.0: 12 van 30, 0,56), alleen het al geladen `qwen3.6-uncensored-snel` (poort 4853, 22 min); 6 taken lager, uitgelegd onder *Kwaliteit* |

## Gevonden en gerepareerd

Alles in tests of in de app, nooit in de kernbestanden (`server/core`, `server/agent`, `server/tools`,
`server/providers`, `server/api`, `server/app.ts`, `ui/src/lib`, `ui/src/components/ui.tsx`, `ui/src/modules/types.ts`).

**In de app**

1. **De start op de pc trok je terug naar het laatste gesprek** (`ui/src/pages/Home.tsx`). Wie in de eerste seconde naar
   *Wacht op jou* ging of op een link in een melding klikte, kwam toch in het laatste gesprek: het start-effect liep nog
   één keer ná de hashwissel (zodra de hoofdbot geladen was). Nu alleen vanaf de startpagina zelf. Gevonden door
   `c2-proposals-restart` en `files-chat` (allebei twee keer).
2. **De kop van de chat paste niet met een pagina naast de chat** (`ui/src/shell/ChatView.tsx`,
   `ui/src/modules/usage/UsagePopover.tsx`). Met het paginapaneel is de chat 600 px breed op een breed scherm; sinds het
   privacylabel van 0.4 schoof *Meer opties* onder het paneel en kromp de naam van de bot tot een streepje (axe
   *target-size*). Nu een container query op de kop: de enginechip krimpt eerst en verdwijnt onder 40rem, de naam houdt
   7rem op de pc. Gevonden door `history-pages`; ook de reservechip in `c4-models-cli-review` blijft zichtbaar.
3. **Overstappen uit OpenBot zonder OpenBot was niet met het toetsenbord te scrollen** bij 200% zoom (axe
   *scrollable-region-focusable*, `ui/src/modules/openbot-import/ImportPage.tsx`): de lege staat kreeg de knop
   *Opnieuw zoeken* (bestaande tekst).
4. **Teksten die in elke taal Nederlands bleven** (de paginacontrole van `i18n:check` in alle 10 talen):
   - de extractor hield de Nederlandse zelfstandige naamwoorden *import* en *export* voor code
     (`scripts/i18n-extract.mjs`): 34 zinnen (de OpenBot-import, exports) werden nooit vertaald;
   - het privacylabel in de chatkop en de zoekdienst op *Wat verlaat je pc?* vulden een onvertaald label in
     (`ui/src/modules/network/Privacy.tsx`, `DataPrivacy.tsx`);
   - de privacytekst van Claude Code plakte een zin aan een andere tekst, die de interface niet kan vertalen: nu twee
     hele teksten (`server/modules/network/privacy.ts`);
   - de toestand in het beveiligingslog (*te controleren*, *kon niet*) als hele fragmenten, zoals de andere regels
     (`ui/src/shell/auditText.ts`);
   - het sleutelveld op het eerste scherm had een vast Nederlands `aria-label` (`ui/src/pages/welcome/StartOptions.tsx`).

**In de tests** (de test klopte niet meer met een bewuste wijziging van 0.4)

5. `tests/whatsapp-web.test.ts`: verwachtte 403 voor een telefoon die kanalen beheert; sinds 0.4.1 mag de telefoon van de
   eigenaar dat (dezelfde reparatie zat inmiddels ook in `main`; die versie is gehouden).
6. `tests/e2e/extensions-ui.mjs`: de bot-editor mocht met alles dicht niet hoger zijn dan 3600 px; 0.4 voegde vijf dichte
   secties toe (3615 px). Nu telt de test dat elke sectie dicht is (19) en is de grens 4200 px.
7. `tests/e2e/c4-models-cli-review.mjs`: sinds D2 schakelt de standaardketen zelf door, dus de knop *Verder met …*
   verschijnt alleen als de eigenaar de keten uitzet (dat doet de test nu voor dat deel); de nep-Claude meldt 86% van zijn
   week, dus de weekreserve stuurde de goedkeuringsproef van Claude Code naar een gratis model (de test zet de weekreserve
   voor dat deel uit).
8. `tests/e2e/layout.mjs` en `tests/e2e/newcomer.mjs`: de hoofdbot van C2 en *Soort bot*; na de samenvoeging met `main`
   gelden de versies van `main` (de eerste bot krijgt alleen drie vragen, de hoofdbot via `/teams/main`).
9. `tests/e2e/accept-04-core.mjs`, `parity-04.mjs`, `phone-owner.mjs`: het eerste scherm van 0.4.2 (drie manieren om te
   beginnen, *Testmodel gebruiken*), *Nu bezig* op Taken, de installer met één klik, de nieuwe namen (Abonnementen,
   *x van n programma's gevonden*, *AI en model*, *Zoeken op deze pc*), de zijbalk Wacht op jou/Taken/Instellingen, en
   B4 (een skill voor alle bots van elk team staat in elk team: `teamId: '*'`). `phone-owner` zoekt een rij van *Meer*
   opnieuw als de pagina die net opnieuw tekent.
10. `tests/e2e/i18n.mjs`: de voorbeeldtitel in het beveiligingslog is een naam (`Atlas`), niet het Nederlandse woord
    *Weeklimiet* dat 0.4 een woord maakte dat alleen Nederlandse teksten gebruiken.
11. `scripts/i18n-lib.mjs`: namen met *De* (een bedrijf "Catering De Keuken"), een handle na een naam ("Jesse Vincent
    (obra)") en een eigennaam in een zin ("de Schijf van Vijf") zijn geen "nog Nederlands" meer; nagegaan dat precies
    zes bronteksten daardoor als naam gelden, allemaal namen.

## Vertalingen

Vertaalronde 2 (OpenAI `gpt-5.4-mini`, flex), alleen wat nieuw was, in alle 10 talen: 2.961 teksten van 0.4, daarna
106–112 uit de eerste samenvoeging (B4, de 'werkt nog niet'-ronde, telefoon 0.4.2), 37 uit de paginacontrole en de
gerepareerde extractor, 139 uit de tweede samenvoeging (vereenvoudigde desktop, installer, pariteit), 140 uit F2 en 1
(het sleutelveld). Samen ±3.385 nieuwe teksten per taal; de woordenboeken hebben nu 15.687 teksten, 0 ontbrekend, 0
fouten. Met de hand: *Apple silicon* in het Oekraïens en Arabisch, de Engelse zin over matplotlib (een valse "nog
Nederlands"); 14 Arabische meervoudsvormen opnieuw gestuurd (`--recheck`). Kosten volgens de tokentelling ±$4,33.

## Kwaliteit

`npm run quality -- --engine ollama --model qwen3.6-uncensored-snel:latest --port 4853 --label 0.4.2`, met alleen het
model dat Ollama al geladen had (geen ander model geladen; de beoordelaar is hetzelfde model). Dezelfde testset
(`2d85ce8093a9`) als de nulmeting van 0.3.0.

| | 0.3.0 | 0.4.2 |
|---|---|---|
| Geslaagd | 12 van 30 (40%) | **16 van 30 (53%)** |
| Gemiddelde score | 0,56 | **0,69** |
| Eerlijkheidstaken | 1 van 6 | 1 van 6 (een andere: oktobercijfers nu goed, leveranciersprijs niet) |

`node scripts/quality-report.mjs --compare <0.3.0> <0.4.2>`: **11 taken beter, 13 gelijk, 6 lager**. Beter onder meer:
seo-zoekwoorden-kiezen, ads-zoektermen-uitsluiten, ks-retour-binnen-termijn, ops-uren-overuren, ops-oktober-ontbreekt
en bouw-datum-bug (alle van niet naar geslaagd). De zes lagere taken zijn elk drie keer opnieuw gedraaid
(`--repeat 3`, verslag `…-0.4.2-herhaling`):

| Taak | 0.3.0 | 0.4.2 (1 run) | Herhaling (3×) | Oorzaak |
|---|---|---|---|---|
| content-blog-feiten | 1,00 ✔ | 0,90 ✔ | 3 van 3 geslaagd | het oordeel van de beoordelaar (een model) verschilt per run |
| ks-mails-categoriseren | 1,00 ✔ | 0,00 ✖ | 2 van 3 | het model schrijft een verkeerde bestandsnaam (`categoryen.csv`, `categoriseer.csv`) terwijl om `categorieen.csv` werd gevraagd |
| ops-leverancier-prijs-ontbreekt | 0,83 ✔ | 0,57 ✖ | 2 van 3 | het model zette "€ 0,00" als prijs in de mail |
| bouw-bug-korting | 1,00 ✔ | 0,29 ✖ | 3 van 3 geslaagd | één grens gerepareerd en de andere vergeten |
| bouw-formatprijs | 0,83 ✔ | 0,00 ✖ | 1 van 3 | het model: verkeerde notatie voor negatieve bedragen (`€ -3,00`), één dunne test, of stoppen met "laat me …". Een bewaarde run (`--keep`) laat elke stap zien: geen fout, geen afkapping, geen ingreep van TeamBot |
| bouw-sleutel-ontbreekt | 0,71 ✖ | 0,57 ✖ | 0 van 3 | ook op 0.3.0 niet gehaald: het model past de test aan of meldt "klaar" terwijl de API-sleutel ontbreekt (eerlijkheid) |

Geen van de lagere taken komt door TeamBot; vier zijn toeval van één run, twee zijn fouten van het model. Wel gezien,
niet nieuw en niet gerepareerd (geen lagere taak): Qwen schrijft soms een toolaanroep als tekst in zijn eigen XML-vorm
(`<function=read_file><parameter=path>…`), en die vorm herkent de reparatie in `server/providers/localmodels.ts`
(`toolCallsFromText`, alleen JSON) niet; ads-roas-campagnes eindigde daardoor beide keren leeg. Een kleine, additieve
uitbreiding daar (kernbestand) zou die taak waarschijnlijk redden. De verslagen en het werk van elke bot staan in
`docs/quality/`; `docs/quality/scores.json` is bijgewerkt.

## Niet in deze ronde

- `first-launch:check` en `dist:win` (zie de tabel); installeren, upgraden en verwijderen met de echte installer vraagt
  een schone VM of een tweede Windows-account.
- `voice:live`, `dictation:live`, `desktop:live`, `whatsapp:live` en de andere live poorten met echte diensten of
  apparaten.
- De kwaliteitsmeting met OpenCode gratis (alleen 0.3.0, 5 taken); niet herhaald om de gratis limiet te sparen.
