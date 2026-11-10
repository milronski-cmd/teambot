# Module: Mappen (`folders`)

Per team een **teammap** die alle (of gekozen) bots van dat team lezen en schrijven, plus **extra mappen per bot**
(alleen lezen of lezen en schrijven). Zichtbaar en te bekijken in de app, en gerespecteerd door de bestandstools en de
CLI-engines, binnen het toegangsniveau van de bot. Bots van een ander team komen er alleen in met toegang *meekijken*
of *aansturen* (module `teams`), en dan alleen lezen. Daarnaast de **Prullenbak**: wat een bot in zijn mappen
verwijdert of overschrijft, kan de eigenaar 30 dagen lang met één klik terugzetten, per bestand of per run.

## Waar

- **Bestanden** (`#/m/folders`, `#/m/folders/team`, `#/m/folders/<botId>`): de teammap en alle mappen van elke bot
  bekijken (alleen lezen), met een voorbeeld per bestand: pdf-pagina's (pdf.js, Apache-2.0; zoomen, "pagina x van y",
  de tekst voor schermlezers), afbeeldingen, audio- en videospeler, markdown (opgemaakt of als tekst) en tekst. Knoppen
  **Openen** (het bestand zelf in een nieuw tabblad, als scriptloze sandbox; niet voor pdf en svg) en **Downloaden**.
  Bestanden zonder voorbeeld (docx, zip, …) zeggen dat eerlijk en bieden Downloaden. Een gekoppelde telefoon mag
  bekijken, openen en downloaden (alleen lezen). Knop **Prullenbak** bovenaan.
- **Prullenbak** (`#/m/folders/prullenbak`): per bestand de map, de bot, wanneer, de grootte en hoe lang het nog bewaard
  blijft; *Verwijderd* of *Vorige versie*; **Terugzetten**, **Downloaden** (de bewaarde kopie, altijd als download) en
  **Definitief verwijderen** (met bevestiging); filter per bot; **Prullenbak legen** (met bevestiging); gebruik t.o.v.
  het maximum.
- **Routine-bonnetje** (routinesmodule): de bestanden die die run veranderde, met **Alles terugzetten**.
- **Chat**: een bijlage (pdf, tekst, markdown, video) opent in hetzelfde voorbeeld; zip/docx blijven een download.
- **Instellingen → Teammap** (en hetzelfde onderdeel in **Instellingen → Teams**): map, naam voor de bots, rechten
  (lezen en schrijven / alleen lezen), alle bots van het team of een keuze. Vanaf twee teams kies je eerst het team, en
  toont **Bestanden** een knop per teammap (`#/m/folders/team` voor het eerste team, `#/m/folders/team:<teamId>` voor
  de andere).
- **Bot bewerken → Mappen**: werkmap, de teammappen die de bot krijgt en extra mappen; map toevoegen met rechten;
  rechten wijzigen of verwijderen.

- **Bestanden › Scans en foto's lezen** (kaart onder de mappen): tekstherkenning (OCR) aanzetten. Eén knop
  **Taaldata downloaden (± 10 MB)** voor de eigenaar of een beheerder; voortgang, fout met **Opnieuw proberen**,
  **Verwijderen**. Zonder taaldata leest TeamBot geen scans en zegt dat eerlijk.

## Documenten lezen (`documents.ts`, `ocr.ts`, `chunk.ts`)

Eén ingang, `readDocument(file, { pages, name, maxChars })`, voor de tool `read_document` en voor dossierbronnen
(`memory/dossiers.ts` › `documentSourceText`). De soort volgt uit de eerste bytes en de naam (Office-bestanden zijn zips).

| Soort | Hoe | Wat de bot krijgt |
|---|---|---|
| pdf met tekst | pdf.js (`pdfjs-dist`, Apache-2.0) | `--- pagina n ---` per pagina |
| pdf-pagina zonder tekst (scan) | PDFium-WASM (`@hyzyla/pdfium` 3.0.0, MIT) tekent de pagina in grijs (± 250 dpi, max 3500 px), tesseract.js 7.0.0 (Apache-2.0) leest hem | de tekst onder dezelfde paginaregel, plus de notitie "gelezen met tekstherkenning; controleer namen en getallen" |
| Word (.docx) | mammoth 1.13.0 (BSD-2-Clause) → HTML → turndown | markdown met koppen, lijsten, tabellen, voetnoten; lukt mammoth niet, dan de oude alinea-lezer |
| Excel (.xlsx) | read-excel-file 9.3.14 (MIT) | elk blad als `## Blad: <naam>` met een markdowntabel (max 2000 rijen per blad in de tekst) |
| PowerPoint (.pptx) | eigen lezer (adm-zip) | `## Dia n` in de volgorde van de presentatie (`presentation.xml`), met de sprekersnotities |
| afbeelding (png, jpeg, bmp, tiff, webp, gif, pnm) | tesseract.js | de herkende tekst |
| tekst | utf-8 | de tekst |

**OCR.** Taaldata **tessdata_fast 4.1.0** (Apache-2.0), Nederlands (6,1 MB) en Engels (4,1 MB), vast op die release met
SHA-256 per bestand; gedownload **alleen na ja** (`POST /api/ocr/download`, eigenaar of beheerder) naar
`<data>/models/ocr/tessdata_fast-4.1.0`, net als het ingebouwde zoekmodel. Een bestand dat niet klopt, wordt weggegooid;
een bestand dat later verandert, wordt niet meer vertrouwd. tesseract.js krijgt alleen die map (`langPath`, `cacheMethod:
'none'`) en haalt nooit zelf iets op. Herkenning in de eigen worker thread van tesseract.js (de server loopt door), één
pagina tegelijk, maximaal **20 gescande pagina's** per keer (de rest wordt genoemd: vraag om de volgende met `pages`),
90 s per pagina; de worker stopt na 2 minuten zonder werk.

**Stukken (chunking, `chunk.ts`, eigen code)** voor dossierbronnen: ± 1200 tekens, gesplitst op alinea's, dan op
zinsgrenzen, dan tussen woorden (nooit midden in een woord); ± 15 % overlap met het vorige stuk; een stuk dat niet zelf
met zijn paginaregel of kop begint, krijgt `--- pagina n ---` / de laatste kop ervoor, zodat een bot "pagina 12" kan
citeren; maximaal 400 stukken (was 200). Een bron houdt tot 400.000 tekens; meer wordt gezegd, niet verzwegen. Oude
bronnen blijven zoals ze zijn; **Opnieuw lezen** maakt nieuwe stukken.

## Opslag

- Teammap: per team in `teams.folder = { path, label, mode: 'rw'|'ro', agents: 'all'|[botIds] }` (module `teams`).
  Teammappen overlappen nooit (één map hoort bij één team). De oude gebruikersinstelling `teamFolder` is de teammap
  van het eerste team: bij de update vanaf 0.3 wordt hij daarheen verplaatst, en wie hem nog schrijft (OpenBot-import)
  zet daarmee de map van het eerste team. Zonder de module `teams` (tests die alleen deze module laden) werkt de
  instelling zoals vroeger.
- Extra mappen: `agent.settings.folders = [{ path, mode, label }]`. Het oude `settings.extraRoots` blijft werken
  (lezen en schrijven).
- Prullenbak: tabel `folder_trash` (per gebruiker: bot, run, gesprek, soort `deleted`/`overwritten`/`created`, pad, map
  en pad daarbinnen, grootte, sha256, naam van de kopie, vervaldatum, teruggezet op) en de kopieën zelf in
  `<data>/trash/<gebruiker>/`. Nooit in de map van de bot zelf.

## Prullenbak en momentopname per run (`trash.ts`)

- **Overschrijven of bewerken** (`write_file`, `edit_file`): vóór de eerste wijziging van een bestand in een run gaat de
  huidige inhoud als kopie naar de prullenbak (*Vorige versie*). Latere wijzigingen in dezelfde run zijn het eigen werk
  van de bot; de versie van vóór de run blijft de bewaarde.
- **Verwijderen** (`delete_file`): het bestand zelf verhuist naar de prullenbak (ook over schijven heen); een lege map
  wordt genoteerd en kan terug. Een niet-lege map verwijderen weigert de tool.
- **Nieuw bestand**: genoteerd zonder inhoud, zodat een run terugzetten het weer kan weghalen (naar de prullenbak).
- **Momentopname van een run** = de eerste notitie per bestand van die run: precies de bestanden die de run aanraakte,
  met hoe ze vóór de run waren. **Alles terugzetten** zet gewijzigde en verwijderde bestanden terug en haalt nieuwe weg.
- **Terugzetten verliest nooit iets**: een bestand dat op die plek staat, gaat eerst zelf naar de prullenbak (en kan dus
  ook weer terug). Was het al precies zo, dan verandert er niets. Nooit in een sleutelbestand of in de gegevensmap van
  TeamBot (buiten `workspaces`).
- **Bewaren**: 30 dagen; maximaal 2 GB per gebruiker (als hij vol is, gaan de oudste kopieën eerst, nooit die van de
  run die op dat moment schrijft); maximaal 200 MB per bestand. Teruggezette regels blijven nog een week als
  geschiedenis. Opruimen bij het starten en elk uur. `createFoldersModule({ trash: { days, maxBytes, maxFile } })` voor
  tests.
- **Te groot voor de prullenbak**: overschrijven gaat door, met de melding aan de bot dat er geen vorige versie is
  (zichtbaar in de momentopname). Verwijderen gebeurt **nooit stil**: de tool vraagt dan altijd een eigen goedkeuring
  (`delete_file:definitief`, *DEFINITIEF VERWIJDEREN (past niet in de prullenbak, terughalen kan niet): <pad>*), ook in
  *Automatisch* en *Volledige toegang*. Nee = het bestand blijft.
- **Dienst** `ctx.services.trash`: `keepBeforeWrite`, `noteCreated`, `moveToTrash` (dezelfde regels voor andere plekken
  die voor een bot bestanden wijzigen), `runChanges`, `restoreRun`, `days`.

## Zoeken in bestanden (`search_files`, `server/tools/builtin/search.ts`)

ripgrep (MIT/Unlicense) uit `@vscode/ripgrep` 1.18.0 (MIT; het platformpakket levert `rg.exe`, 5,4 MB, geen download
bij installeren; in de Windows-app via `asarUnpack`). Eigen proces met een opgeschoonde omgeving (`safeEnv`), dus de
server loopt door; de regex-engine van ripgrep werkt in lineaire tijd (geen ReDoS), met `--regex-size-limit`/
`--dfa-size-limit`. Grenzen: 200 treffers, bestanden tot 2 MB, regels tot 400 tekens, 15 s (daarna wordt het proces
gestopt en krijgt de bot wat er gevonden is, met een notitie); stoppen van de run stopt ook het zoeken. Hoofdletters
maken niet uit, `glob` op de bestandsnaam (`--iglob`). Overgeslagen: binaire bestanden, wat `.gitignore` uitsluit,
`node_modules`, `.git`, `dist` …, en sleutelbestanden (`.env*`, `.ssh`, `.gnupg`, `.aws`, `master.key`, `local-token`);
symlinks worden niet gevolgd. Uitvoer zoals voorheen: `pad:regel: inhoud`. Een ongeldige regex geeft een eerlijke fout.
Zonder de binary (ongewoon platform) loopt de oude zoektocht in een worker thread met dezelfde grenzen; die wordt na de
tijdslimiet beëindigd, ook als een regex blijft hangen. Tests: `tests/search-files.test.ts`.

## Handhaving

- `server/tools/builtin/files.ts`: `agentRootList(agent)` geeft werkmap + extra mappen + module-mappen (teammappen via
  `addRootProvider`) met hun rechten; daarna smalt `addRootFilter` (teams) dat in: een map in de teammap van een ander
  team valt zonder toegang weg en is met toegang alleen-lezen. `addPathGuard` (teams) weigert in
  `resolveInWorkspace` elk pad in een andere teammap, ook binnen een werkmap of extra map die die map bevat. `resolveInWorkspace(agent, pad, { write: true })` weigert schrijven in een
  alleen-lezen map (de meest specifieke map telt). `write_file`, `edit_file` en `delete_file` schrijven; een gedeelde
  map zelf kan nooit verwijderd worden. Sleutelbestanden (`.env`, `.ssh`, `master.key`, …) blijven overal dicht.
- **Goedkeuring**: met de prullenbak is verwijderen een omkeerbare wijziging (`riskFor` → *write*): het vraagt in
  *Vraagt toestemming* (kaart “wil een bestand naar de prullenbak verplaatsen”) en niet meer in *Automatisch*. Zonder
  prullenbak (minimale opstelling) blijft het een actie met impact die altijd vraagt.
- **Claude Code**: alleen mappen met schrijfrechten krijgen `--add-dir` (in alleen-lezen-modus alle mappen). Alleen-lezen
  mappen gaan via de toestemmingsbrug: lezen mag, schrijven wordt door TeamBot geweigerd.
- **Codex**: alleen mappen met schrijfrechten als `--add-dir` (sandbox `workspace-write`); lezen kan de sandbox overal.
- **ACP (OpenCode e.a.)**: `fs/read_text_file` en `fs/write_text_file` en elke toestemmingsvraag lopen via TeamBot; schrijven
  in een alleen-lezen map wordt geweigerd.
- De systeemprompt krijgt een vast blok "## Mappen" met de extra mappen, hun pad en rechten.
- Niet te delen: een hele schijf, de eigen gebruikersmap, de gegevensmap van TeamBot (of een map die die bevat) en
  sleutelmappen. Leden op een server kunnen geen mappen instellen (worden gestript, net als `extraRoots`).

Een werkmap is geen sandbox: de terminal-tool kan buiten de mappen; die staat standaard uit en vraagt goedkeuring.
Verwijderen of overschrijven via de terminal of door een CLI-engine zelf gaat **niet** via de prullenbak (zie
Beperkingen); verwijderen via de terminal is daarom een actie die altijd vraagt.

## API

- `GET/PUT/DELETE /api/folders/team[?teamId=]` (zonder `teamId`: het eerste team; `PUT` maakt het eerste team aan als
  er nog geen is). `GET` geeft ook `teamId`, `teams` (voor de teamkeuze) en de bots van dat team.
- `POST /api/folders/check` `{ path }` → `{ ok, path, label } | { ok: false, error }`
- `GET /api/folders/roots?agentId=` (zonder `agentId`: de teammap, of met `teamId=` die van één team)
- `GET /api/folders/browse?agentId=&root=&path=` en `GET /api/folders/file?agentId=&root=&path=` (`kind`: pdf, image,
  audio, video, markdown, text of binary; tekst ≤ 256 kB; een pdf of office-bestand is nooit "tekst")
- `GET /api/folders/raw?agentId=&root=&path=[&download=1]`: het bestand zelf, met dezelfde padcontrole (geen ontsnapping,
  geen sleutelbestanden). Alleen afbeeldingen, audio en video inline; elke soort tekst (ook .html) als `text/plain`; de
  rest (pdf, svg, office) als download. Altijd `nosniff` en `Content-Security-Policy: sandbox`; bereikverzoeken voor
  spoelen. Links zijn gesigneerd (nooit de sessietoken in de URL).
- `GET /api/folders/trash?agentId=&restored=1` → `{ items, usage }`; `POST /api/folders/trash/:id/restore`;
  `GET /api/folders/trash/:id/raw` (de kopie, altijd als download, sandbox); `DELETE /api/folders/trash/:id`;
  `POST /api/folders/trash/empty`; `GET /api/folders/trash/runs/:runId` (de momentopname van een run) en
  `POST /api/folders/trash/runs/:runId/restore` (`{ restored, failed }`). Alleen eigen regels (anders 404).

- `GET /api/ocr` → `{ state: absent|downloading|ready|error|no-runtime, langs, bytes, done, error, mayDownload }`;
  `POST /api/ocr/download` (eigenaar/beheerder; begint de download en antwoordt meteen); `DELETE /api/ocr`.

Events: `trash.updated`. Audit: `trash.kept`, `trash.restored`, `trash.run_restored`, `trash.dropped` (vol of door de
eigenaar), `trash.emptied`, plus `file.delete` met `trash` of `permanent`; `ocr.download`, `ocr.removed`.

**Windows-app.** tesseract.js (met zijn afhankelijkheden) en PDFium staan in `asarUnpack` (worker-script en wasm worden
van schijf gelezen); de varianten van `tesseract.js-core` die niet gebruikt worden (zonder LSTM, `.wasm.js`) en de
browserbuilds van PDFium blijven buiten het pakket (± 35 MB minder).

## Beperkingen

- Alleen wat via de bestandstools van TeamBot gaat, komt in de prullenbak. Schrijft of verwijdert een CLI-engine zelf
  (Claude Code `Write`/`Edit`/`Bash`, Codex in de sandbox, OpenCode via `fs/write_text_file`), dan niet; het bewijs van
  een routine ziet zulke bestanden wel (`routines/proof.ts`). Aanhaken kan met `ctx.services.trash` in de
  toestemmingspoort en in `fs/write_text_file` van de CLI-module.
- Een momentopname bewaart alleen bestanden die de run aanraakte, geen volledige kopie van de map (daarvoor bestaan de
  snapshots en de repetitie in de browsermodule).
- OCR: alleen Nederlands en Engels; handschrift en slechte foto's lukken matig (tessdata_fast is snel, niet het
  nauwkeurigst). Geen odt, rtf, epub of oud .doc/.xls/.ppt (officeparser of Xberg kan later, zie het onderzoek).
  Kop- en voetteksten van Word neemt mammoth niet mee.

## Tests

`tests/documents-ocr.test.ts` (fixtures in `tests/fixtures/documents/`, gemaakt met `make.ts`: een gescande pdf
zonder tekstlaag, dezelfde pagina als png, docx, xlsx, pptx): Word met koppen en tabel, Excel-bladen als tabel, pptx in
de volgorde van de presentatie met notities, soort herkennen zonder extensie, scan zonder taaldata eerlijk (en geen
download vanzelf), download met hashcontrole (fout bestand weg, gewijzigd bestand niet vertrouwd), OCR van de scan en de
foto (de echte taaldata wordt eenmalig met dezelfde hashcontrole in een cache buiten de repo gezet; zonder internet
overgeslagen), stukken op zinsgrens met overlap en paginaregel, meer dan 200 stukken.
`tests/folders.test.ts`: alleen-lezen vs. lezen en schrijven via de echte tool-lus, teammap per bot, systeemprompt,
bladeren en ontsnappen, geweigerde mappen, `--add-dir` en de CLI-toestemmingspoort, leden op een server, het voorbeeld
(soort per bestand, veilige headers, download, bereikverzoeken, padcontrole). De teamgrenzen (map van een ander team,
ook als extra map of binnen de werkmap) staan in `tests/teams-isolation.test.ts`. `tests/trash.test.ts`: verwijderd
bestand komt terug met dezelfde inhoud (zonder kaart in *Automatisch*, met kaart “Naar de prullenbak” in *Vraagt
toestemming*), vorige versie één keer per run en terugzetten verliest niets, momentopname van een run (bewerkt,
overschreven, nieuw, verwijderd) in één keer terug, te groot = eigen goedkeuring (ook in *Volledige toegang*), bewaren
en maximum, alleen eigen regels en downloaden als bestand. `tests/e2e/files-chat.mjs` (onderdeel van `npm run e2e`):
pdf echt getekend, afbeelding, markdown, audio, docx, de pdf uit de chat, telefoonbreedte.
