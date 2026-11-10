# Module: Back-ups en updates (`backups`)

Server `server/modules/backups/`, UI `ui/src/modules/backups/`, desktop `desktop/update-flow.ts` (+ `updater.ts`,
`main.ts`). Plan 0.4: pakket N = sectie F *Back-up en terugzetten* en sectie G *Motorversies vastzetten* en
*Updates van TeamBot zelf*. Motorversies: zie [cli-agents.md](cli-agents.md#motorversies-vastzetten).

## Wat het doet

**Instellingen › Back-ups** (`#/settings/backups-app`, eigenaar en beheerders; terugzetten alleen de eigenaar):

- **Nu een back-up maken**, met of zonder de werkmappen van bots en de bestanden van groepen. De pagina toont vooraf
  hoe groot dat ongeveer wordt; een back-up die de schijf zou vullen wordt geweigerd (nodig: schatting + 10% + 200 MB).
- **Elke dag automatisch** (standaard aan), **bewaar de laatste N** (3, 5, 7, 14 of 30; standaard 7), optioneel met
  werkmappen. Alleen terwijl TeamBot draait: eerste controle 2 minuten na de start, daarna elk uur; er komt een nieuwe
  als de laatste automatische ouder is dan 23 uur. Zelf gemaakte back-ups en veiligheidskopieën ruimt TeamBot nooit op.
- **Terugzetten met één klik**: bevestigen, en de desktop-app start vanzelf opnieuw (`teambot:restart`); op een
  server staat er "herstart de server". De huidige stand gaat eerst als veiligheidskopie (`…-replaced`) bij de
  back-ups, inclusief de bestanden die worden vervangen: er gaat niets verloren.
- **Wat zit erin, en wat niet**, met de grootte per onderdeel en een eerlijke zin over de sleutels (zie onder).
- **Updates van TeamBot**: welke versie draait, de laatste update, *Wat is er nieuw* en *Terug naar versie x*.

Instellingen › Gegevens houdt een kaart die naar deze pagina wijst.

## Wat er in een back-up zit

Een back-up is een set met één naam `teambot-JJJJMMDD-UUMMSS[-auto|-update|-replaced]` in `<data>/backups/`:

| Bestand | Inhoud |
|---|---|
| `<naam>.db` | `teambot.db`, consistent gekopieerd met `VACUUM INTO` terwijl TeamBot draait |
| `<naam>.teamdata/` | de teamdatabases (`VACUUM INTO`), dezelfde indeling als de kern al terugzet |
| `<naam>.files/` | de gegevensmappen die ertoe doen (tabel hieronder) en het beveiligde sleutelbestand |
| `<naam>.json` | manifest: versie van TeamBot, soort, onderdelen met grootte, wat is overgeslagen en waarom |

De `.db` komt als laatste op zijn plaats (eerst `.db.partial`): een half gemaakte back-up staat nooit in de lijst. De
namen zijn die van vóór 0.4, dus `/api/admin/backups/:naam` (downloaden van de database, oude
back-ups zonder manifest: "alleen de database") blijft werken.

| Onderdeel | In de back-up |
|---|---|
| database, teamdatabases | altijd |
| `attachments`, `skills`, `sites`, `channels`, `mcp` | altijd |
| `master.key.dpapi` / `.keychain` / `.secret-service` | altijd (alleen bruikbaar voor hetzelfde Windows-account of dezelfde gebruiker) |
| `workspaces`, `rooms`, `shared-bots` | alleen als je dat kiest (werkmappen en groepsbestanden) |
| `browser`, `runtimes`, `voice`, `cache`, `tmp`, `logs`, `electron`, `cli-agents`, `memory`, `updates`, `backups` | nooit (browserprofielen, programma's, modellen, caches, werkbestanden, installers) |
| `master.key` (platte sleutel op een server), `url-signing.key`, `local-token` | nooit |
| een map van een andere module die hier nog niet staat | wel, tot 2 GB; groter wordt overgeslagen en in het manifest genoemd |

Links (symlinks, junctions) worden nooit gevolgd; een SQLite-bestand in een map wordt ook met `VACUUM INTO` gekopieerd;
een bestand dat op slot zit, komt in `skipped` in plaats van de hele back-up te laten mislukken. Mappen buiten de
datamap die een bot gebruikt (een eigen projectmap) zitten er niet in; de pagina zegt dat.

**Sleutels.** Opgeslagen sleutels en wachtwoorden staan versleuteld in de database. Op de Windows-desktop is de
hoofdsleutel met DPAPI aan het Windows-account gebonden: na terugzetten werken ze alleen op deze computer met hetzelfde
Windows-account; elders of na een nieuwe Windows-installatie voer je ze opnieuw in. Op een server met `master.key`
of `TEAMBOT_MASTER_KEY` zit die sleutel er bewust niet in (anders kan iedereen met de back-up de sleutels lezen); de
pagina zegt dat je hem zelf moet bewaren. Een teruggezette sleutel hoort bij de teruggezette database: de desktop zet
een klaargezette back-up daarom terug vóórdat de sleutel wordt gelezen (`desktop/main.ts startServer`).

## Terugzetten

1. `POST /api/backups/:name/restore` kopieert `<naam>.db` → `restore-pending.db` en `.teamdata` →
   `restore-pending.teamdata` (zoals de kern) en schrijft `restore-pending.json` (welke set, wie, versie).
2. Bij de volgende start zet de kern (`applyPendingRestore`) de database en teamdatabases op hun plaats en bewaart de
   vervangen database als veiligheidskopie. Daarbij gaan de vergeet-blokkades (`memory_tombstones`, soort `forget`) en
   de gewiste geschiedenis (`history_purges`) van de huidige database mee (`restore-tombstones.json`,
   `restore-history.json`).
3. Daarna roept de kern `applyPendingFiles` aan (`files.ts`), vóór er een module start: elk onderdeel uit
   `<naam>.files/` vervangt het huidige; het huidige gaat naar `<veiligheidskopie>.files/`. Onderdelen die niet in de
   back-up zitten (werkmappen in een back-up zonder werkmappen) blijven zoals ze zijn. Het schrijft
   `restore-applied.json`.
4. De geheugen- en geschiedenismodule passen bij hun start de blokkades opnieuw toe: **wat vergeten was, blijft
   vergeten**, ook als de oude back-up het nog bevat.
5. Deze module start als laatste (`server/modules/index.ts`) en bouwt dan de **afgeleide zoekindexen** opnieuw op uit
   de gegevens: `messages_fts` (zoals migratie `core-002`) en `memory_fts` (`MemoryService.reindex`). Modules met een
   eigen index luisteren naar het servergebeurtenis `backups.restored`. Daarna een melding *Back-up teruggezet* en
   `backups/last-restore.json` voor de pagina.

Een back-up die met een **nieuwere** TeamBot is gemaakt, wordt geweigerd ("werk TeamBot eerst bij"), behalve op de
weg terug naar een oudere versie (die back-up is van die oudere versie). Een klaargezette terugzet annuleren:
`DELETE /api/backups/pending`; de kernroutes ruimen de markering ook op.

## Een tweede plek, versleuteld (`offsite.ts`)

Kaart **Kopie op een tweede plek** op dezelfde pagina Back-ups (geen nieuwe rij in Instellingen; alleen de eigenaar,
alleen op de computer). Zo neemt een kapotte schijf of ransomware de back-ups niet mee.

- **Instellen**: een map (USB-schijf, NAS, andere schijf; volledig pad, moet bestaan, schrijfbaar, niet binnen de
  datamap van TeamBot) en een wachtwoord van minstens 12 tekens (twee keer). TeamBot schrijft in
  `<map>/TeamBot-backups/`. Het wachtwoord staat in de versleutelde sleutels van TeamBot (`backups.offsite.password`,
  van de eigenaar), nooit in het bestand, een log of een antwoord. Instellingen in `backups/offsite.json` (blijft na
  terugzetten); na het terugzetten van een oudere database stel je het wachtwoord zo nodig opnieuw in.
- **Kopiëren**: na elke nieuwe back-up (dagelijks of zelf gemaakt, niet de snelle back-up vóór een update) automatisch
  (schakelaar, standaard aan), of met **Nu een kopie maken** (de nieuwste set). Bewaard: zoveel als de automatische
  back-ups (minstens 3). Is de map er niet (schijf los), dan blijft de back-up gewoon lokaal en meldt de kaart dat.
- **Bestand** `<naam>.teambotbackup`: `TEAMBOTBK\x01` | lengte | header (JSON: naam, versie, datum, scrypt-parameters,
  salt, IV) | AES-256-GCM(gzip(alle bestanden van de set)) | GCM-tag. Sleutel = scrypt(wachtwoord, 16 bytes salt,
  N=2^17, r=8, p=1); IV willekeurig per bestand; de header is AAD (meegeverifieerd). Alleen Node `crypto` en `zlib`,
  geen nieuwe afhankelijkheid. Streaming: ook grote sets passen.
- **Terugzetten van een kopie**: per kopie **Terugzetten** → wachtwoord → TeamBot ontsleutelt naar een tijdelijke map in
  `backups/`, en zet de set pas op zijn plek als de tag klopt (verkeerd wachtwoord, een veranderde byte of een afgekapt
  bestand: niets veranderd, "Het wachtwoord klopt niet, of het bestand is beschadigd"). Daarna de gewone vraag
  *terugzetten?* en het gewone terugzetten (veiligheidskopie, vergeten blijft vergeten, herstart). Paden in het bestand
  kunnen niet buiten die map komen.
- Op een **andere computer** werken opgeslagen sleutels niet (DPAPI/sleutelbos, zie *Wat er in een back-up zit*); de
  kaart zegt dat. Een vergeten wachtwoord kan niemand terughalen.

## Updates van TeamBot zelf (desktop)

`desktop/update-flow.ts` bevat de hele updatestroom zonder Electron (getest met een nep-updater en met de echte
electron-updater tegen een lokale updatemap); `desktop/updater.ts` koppelt electron-updater, de inactiviteit van
Electron (`powerMonitor`), meldingen en het starten van een installer. De server toont en bedient het via
`/api/app-update` (`app-update.ts`; desktop/main.ts zet `ctx.services.appUpdate`), dus ook op de telefoon.

- **Kanaal** (`desktop/update-channel.ts`): een map op een webserver (https) of GitHub Releases; uit `build.publish`
  (`app-update.yml`), te overschrijven in Instellingen › Back-ups › *Geavanceerd* (alleen op de computer).
- **Automatisch bijwerken** (*Aan* standaard / *Alleen melden* / *Uit*): eens per dag kijken (een tik per uur vangt
  een pc die sliep; na een mislukte poging een uur later), op de achtergrond downloaden, en installeren alleen als
  `desktop/update-idle.ts` het toestaat: geen run, routine of back-up bezig, geen routine binnen 10 minuten, niemand
  schreef net aan een bot, en de eigenaar 15 minuten weg (of scherm vergrendeld). *Nu bijwerken* wacht alleen op
  lopend werk. Na *Terug naar versie x* wordt de verlaten versie niet vanzelf opnieuw geïnstalleerd.
- **Back-up vooraf.** Installeren gebeurt alleen in `will-quit` (na *Opnieuw starten en bijwerken* of bij afsluiten):
  eerst `ctx.services.backups.beforeUpdate({ from, to })` (database, teamdatabases en sleutel: snel; soort `update`,
  label *Voor de update naar x*, de laatste 3 blijven), dan een notitie `pending` in `<data>/updates/state.json`, dan
  pas de installer. Lukt de back-up niet, dan wordt er **niet** geïnstalleerd en krijgt de eigenaar een melding.
  electron-updater's eigen *install on quit* staat daarom uit (`autoInstallOnAppQuit = false`); anders zou hij ook
  installeren als TeamBot afsluit omdat de back-up mislukte.
- **Installers bewaren.** Na de download gaat de gecontroleerde installer naar `<data>/updates/installers/` (met zijn
  SHA-512). Staat de installer van de draaiende versie er nog niet (die is met de hand geïnstalleerd), dan haalt
  TeamBot `TeamBot-Setup-<huidige versie>.exe` van hetzelfde updatekanaal (zelfde https-regels) en legt de SHA-512
  vast. Alleen de installers van de draaiende en de nieuwe versie blijven (±150 MB elk).
- **Na de update** ziet de server bij de start dat de versie veranderde (`recordStart`): een regel in de geschiedenis
  met de back-up van vooraf, een melding *TeamBot is bijgewerkt naar x* die naar **Wat is er nieuw**
  (`#/m/backups/nieuw`) wijst. Die pagina toont de delen van `CHANGELOG.md` (meegeleverd als `dist/CHANGELOG.md`
  via `scripts/build.mjs`) van alle versies na de vorige tot en met de huidige, kort, zonder markdown, met *Nog x
  punten tonen*. Draait TeamBot bij de start nog op de oude versie terwijl er een update klaarstond, dan zegt een
  melding dat de update niet is geïnstalleerd.
- **Terug naar versie x** (alleen de Windows-app, alleen vanuit het venster zelf: IPC `teambot:update:rollback`):
  electron-updater gaat nooit zelf terug, dus TeamBot doet het uitdrukkelijk. Voorwaarden: de laatste wijziging was
  een update naar de draaiende versie, de back-up van vlak daarvoor bestaat, en de installer van de vorige versie is
  bewaard en heeft nog dezelfde SHA-512 (opnieuw gecontroleerd vlak voor hij start). Stappen: de back-up wordt
  klaargezet (`stageRestore`, `reason: 'rollback'`), `pending` = rollback, TeamBot sluit; in `will-quit` gaat na het
  sluiten van de server de back-up op zijn plaats (`applyPendingRestore`, met de code van de nieuwe versie, dus ook
  de bestanden), daarna start de bewaarde installer losgekoppeld met `--updated /S --force-run` (zoals
  electron-updater een installer start: de oude verwijderprocedure bewaart de gegevens bij `--updated`, zie
  `build/installer.nsh`) en TeamBot stopt. De oude versie start en meldt *TeamBot is terug op versie x*. Ontbreekt
  iets, dan staat er waarom en wat je zelf kunt doen.

## API (`/api/backups…`, ingelogd)

| Methode | Pad | Wie | Doel |
|---|---|---|---|
| GET | `/backups[?fresh=1]` | beheerder | sets, instellingen, onderdelen met grootte, lopende back-up, klaargezette en laatste terugzet, sleutelzin |
| POST | `/backups` `{ includeWork?, wait? }` | beheerder | back-up maken (meteen `{ job }`, voortgang als `backups.progress`, einde `backups.updated`; `wait` wacht) |
| PUT | `/backups/settings` `{ auto?, keep?, includeWork? }` | beheerder | dagelijkse back-up (bewaard in `backups/settings.json`, blijft na terugzetten) |
| POST | `/backups/:name/restore` | eigenaar | terugzetten klaarzetten |
| DELETE | `/backups/pending` | beheerder | klaargezette terugzet annuleren |
| DELETE | `/backups/:name` | beheerder | een set verwijderen (alle delen) |
| GET | `/backups/updates` | iedereen (leden: alleen wat er nieuw is) | versie, geschiedenis, mislukte update, wat er nieuw is, de weg terug |
| POST | `/backups/updates/seen` | beheerder | *Wat is er nieuw* gezien |
| GET | `/backups/offsite` | beheerder | map, schakelaar, wachtwoord ingesteld (ja/nee), bereikbaar, laatste kopie of fout, de kopieën in de map (ook in `GET /backups` als `offsite`) |
| PUT | `/backups/offsite` `{ folder?, auto?, password? }` | eigenaar | tweede plek instellen |
| DELETE | `/backups/offsite` | eigenaar | stoppen (kopieën blijven staan, wachtwoord weg) |
| POST | `/backups/offsite/copy` `{ name? }` | beheerder | nu een versleutelde kopie maken (wacht tot klaar) |
| POST | `/backups/offsite/import` `{ file, password }` | eigenaar | een kopie terug bij de back-ups zetten → `{ backup }` (daarna het gewone terugzetten) |

De routes `/backups/offsite…` zijn alleen voor de computer (`server/modules/mobile/policy.ts`).

| GET | `/app-update` | beheerder (ook telefoon) | stand van de updates: kanaal, fase, waarop een klaarstaande update wacht, *Automatisch bijwerken*; zonder updater (server, dev) `managed: false` met de reden |
| POST | `/app-update/check` · `/app-update/download` · `/app-update/install` | eigenaar (ook telefoon) | *Nu controleren*, alleen downloaden, *Nu bijwerken* (meteen antwoord; daarna `app-update.changed`) |
| PUT | `/app-update/settings` `{ auto: on\|notify\|off }` | eigenaar (ook telefoon) | *Automatisch bijwerken* |
| PUT | `/app-update/channel` `{ channel }` | eigenaar, **alleen op de computer** (`COMPUTER_ONLY`) | het updatekanaal (`https://…` of `github:eigenaar/naam`; leeg = het ingebouwde) |

Diensten: `ctx.services.backups` = `{ service, list, make, beforeUpdate, stageRestore, rollbackInfo,
restorable }`. Er is één back-upcode: de kern heeft geen eigen back-ups meer.

Audit: `backup.created`, `backup.restore_staged`, `backup.deleted` (bestonden al), `backup.settings`,
`backup.restored`, `backup.app_updated`, `backup.rollback`, `backup.rollback_started` (zinnen in
`ui/src/shell/auditText.ts`).

## Kernwijzigingen (klein, additief)

- `server/modules/backups/restore.ts`: `applyPendingRestore` roept na de database en teamdatabases `applyPendingFiles` aan;
  `startAutoBackup` stopt meteen als `ctx.services.backups.ownsSchedule` er is.
- `server/modules/index.ts`: `backups` als laatste module.
- `scripts/build.mjs`: kopieert `CHANGELOG.md` naar `dist/`.
- `ui/src/lib/palette.ts`: tabblad `backups-app` in de groep *Privacy & gegevens*, zoekwoorden, pagina *Wat is er
  nieuw*.
- `ui/src/modules/index.ts`: de UI-module. `ui/src/pages/Backups.tsx`: de kaart op *Gegevens* wijst naar het tabblad.
- `ui/src/shell/auditText.ts`: zinnen voor de nieuwe auditsoorten.

## Tests

- `tests/app-backup.test.ts`: back-up → wijzigen → terugzetten brengt database en bestanden terug, wat later kwam staat
  in de veiligheidskopie, een vergeten herinnering blijft vergeten en onvindbaar, de zoekindexen zijn opnieuw
  opgebouwd (in de back-up leeg gemaakt), caches/modellen/browserprofielen nooit erin, werkmappen alleen op keuze,
  de laatste N automatische, de back-up vóór een update, een nieuwere back-up geweigerd, leden zien niets, het
  wijzigingslog in gewone woorden.
- `tests/update-safety.test.ts` (nep-updater, nep-installer, er draait nooit een echte installer): back-up vóór de
  installatie en beide installers bewaard (de huidige van een nep-updatekanaal), geen installatie zonder back-up, na
  de update de geschiedenis met de back-up en de weg terug: terugzetten + de bewaarde installer met
  `--updated /S --force-run`; een gewijzigde installer start niet; alleen in de Windows-app; een mislukte update
  wordt opgemerkt.
- `tests/app-update.test.ts`: `/api/app-update` zonder updater (rustig), zonder kanaal (*volgende installer*), het
  kanaal op de computer en geweigerd op de telefoon, *Alleen melden*, *Nu bijwerken* wacht op een taak maar niet op
  de eigenaar, eens per dag kijken, de verlaten versie na de weg terug.
- `tests/update-feed.test.ts`: `npm run release:feed` maakt `latest.yml` + blockmap, een statische server op poort
  4804 serveert ze, de echte electron-updater vindt, downloadt en controleert de nieuwe versie, de update wacht op een
  taak en op de eigenaar, daarna back-up en installatie (een stub).
- `tests/e2e/app-update.mjs` (Edge) en `tests/e2e/phone-owner.mjs` (gekoppelde telefoon): de kaart in Back-ups.
- `tests/backups.test.ts`, `tests/backup-forget.test.ts`: de kernroutes en vergeten na terugzetten (ongewijzigd).
- `tests/backups-offsite.test.ts`: versleuteld bestand heen en terug (alle delen, leeg bestand, 3 MB), geen leesbare
  tekst erin, verkeerd wachtwoord en een veranderde byte laten niets achter; instellen met eerlijke weigeringen
  (binnen de datamap, bestaat niet, relatief pad, kort wachtwoord), kopie na elke back-up, lokale back-up kwijt →
  terughalen met het wachtwoord → terugzetten → na de herstart de oude stand.
- `tests/e2e/backups-offsite.mjs` (`npm run backups:check`, ook in `npm run e2e`; Edge headless, vrije poort): hetzelfde
  in de browser, met axe (WCAG AA) licht en donker.

## Niet getest / beperkingen

- De echte NSIS-installer is niet gedraaid (nooit op de pc van de eigenaar). Ongetest: of een oudere installer met
  `/S --updated --force-run` netjes over een nieuwere installatie heen gaat (electron-builder's sjabloon kent geen
  versiecontrole en roept de oude verwijderprocedure met `--updated` aan; dat is gelezen, niet live gezien), en de
  installatiemap van een stille installatie. Live testen kan alleen op een schone VM of een tweede Windows-account.
- De installer van de huidige versie ophalen werkt alleen als die nog op het updatekanaal staat; anders kan de eerste
  update na een handmatige installatie niet met één klik terug (de pagina zegt dat; de back-up van vooraf is er wel).
- De back-up vóór een update bevat geen bijlagen of werkmappen: een update verandert die niet, en zo blijft het snel.
- *Wat is er nieuw* is de Nederlandse tekst van `CHANGELOG.md` (het wijzigingslog heeft geen vertalingen).
