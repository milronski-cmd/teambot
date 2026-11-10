# Release: Windows-installer, server en iPhone

Handmatige voorwaarden staan **vet**. Geheimen (certificaten, wachtwoorden, Apple-sleutels) komen nooit in de repo;
alleen in de secret-opslag van CI.

## Windows

### Wat iemand ziet, van download tot eerste scherm

1. **Downloaden** van `TeamBot-Setup-<versie>.exe` (64-bit, ±150 MB). Edge kan zeggen dat het bestand niet vaak wordt
   gedownload; kies dan bij de download via **…** voor *Behouden*.
2. **Dubbelklikken.** Zolang de installer niet ondertekend is, zegt Windows *Windows heeft uw pc beschermd*: klik op
   **Meer informatie** en dan op **Toch uitvoeren** (de downloadpagina van de website zegt dat ook). Er komt **geen**
   vraag om beheerdersrechten.
3. Een klein venster met het TeamBot-icoon: *Installeren, even geduld…* (de taal volgt Windows). Geen vragen, geen
   licentiepagina, geen map kiezen; ±10–30 seconden.
4. **TeamBot start vanzelf.** Het venster staat er meteen met *TeamBot is geïnstalleerd — Je vindt TeamBot voortaan in
   het Startmenu en op je bureaublad* (`desktop/start-page.ts`) en gaat binnen een paar seconden over in het
   welkomstscherm. Geen consolevensters, geen firewallvraag (de server luistert alleen op `127.0.0.1`), geen andere
   dialogen. Het venster past op het scherm (nooit groter dan 90% van een klein scherm) en opent later op dezelfde plek.
5. **Venster sluiten (X):** de eerste keer, één keer ooit, het bericht *TeamBot draait op de achtergrond* met
   **Op de achtergrond verder** (standaard) of **TeamBot afsluiten**. Daarna verdwijnt het venster gewoon naar het
   systeemvak; daar staan *TeamBot openen* en *Afsluiten*.
6. **Verwijderen:** Instellingen › Apps › TeamBot › *Verwijderen* → *Weet je zeker dat je TeamBot wilt verwijderen?* →
   *Ook je gegevens verwijderen (bots, gesprekken, geheugen)?* met **Nee** als standaard (Enter = bewaren). Bij een
   update of stil verwijderen wordt dat nooit gevraagd en blijft alles staan (`build/installer.nsh`).

De nieuwe teksten van het bureaubladprogramma (startpagina, sluitbericht) zijn Nederlands; `npm run i18n:extract` en
`npm run i18n:translate` nemen ze mee naar de andere talen.

### Installer-instellingen (`package.json` › `build.nsis`) en waarom

| Instelling | Waarde | Waarom |
|---|---|---|
| `oneClick` | `true` | Geen wizard: dubbelklikken is installeren. De keuzes van de oude wizard (map, voor wie) heeft een gewone gebruiker niet nodig. |
| `perMachine` | `false` | Per gebruiker in `%LOCALAPPDATA%\Programs\TeamBot`: geen beheerdersvraag, en updates gaan stil zonder UAC. |
| `runAfterFinish` | `true` | TeamBot start zelf na de installatie (na een update via `--force-run`). |
| `createStartMenuShortcut`, `createDesktopShortcut`, `shortcutName` | `true`, `true`, `TeamBot` | Startmenu en bureaublad, met het TeamBot-icoon. `true` en niet `always`: wie de bureaubladsnelkoppeling weggooit, krijgt hem niet bij elke update terug. |
| `installerHeaderIcon` | `build/icon.ico` | Het icoon in het installatievenster. Gemaakt uit `build/icon.png` met `node scripts/make-ico.mjs` (draait mee in `npm run icons`). |
| `deleteAppDataOnUninstall` | `false` | Gegevens gaan alleen weg na een uitdrukkelijk *Ja* (`build/installer.nsh`). |
| `include` | `build/installer.nsh` | De vraag over de gegevens. Een one-click-uninstaller maakt zichzelf stil vóór de verwijderstap; de vraag staat daarom in `un.onInit` (`customUnInit`), de uitvoering in `customUnInstall`. |
| geen `license` | — | Bij one-click zou dat een extra pagina met Engelse licentietekst zijn. `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES` en de SBOM staan in de installatiemap (`resources\`). |
| geen `installerLanguages` | — | Alle 26 talen van electron-builder; NSIS kiest die van Windows. Onze eigen teksten zijn Nederlands en Engels. |

Opdrachtregel (scripts en updates):

| Aanroep | Wat er gebeurt |
|---|---|
| `TeamBot-Setup-<versie>.exe /S` | Stil installeren of bijwerken, zonder TeamBot te starten. `/currentuser` mag erbij en verandert niets. |
| `… /S --force-run` | Stil installeren en daarna TeamBot starten. |
| `… /S /D=C:\Pad\Naar\Map` | In een andere map, alleen bij een eerste installatie (daarna blijft TeamBot waar hij staat). `/D=` als laatste. |
| `"%LOCALAPPDATA%\Programs\TeamBot\Uninstall TeamBot.exe" /S` | Stil verwijderen; de gegevens blijven altijd staan. |

**Overstap van 0.4.1 en ouder** (wizard-installer): dezelfde app-id, dus dezelfde registersleutel, map en
snelkoppelingen. De nieuwe installer verwijdert de oude stil met `--updated` (gegevens blijven, er wordt niets
gevraagd) en zet de nieuwe op dezelfde plek. Alleen wie een oude versie in de wizard **voor alle gebruikers**
installeerde (Program Files), krijgt er een tweede installatie per gebruiker naast; verwijder dan eerst de oude via
Instellingen › Apps.

### Bouwen

`npm ci && npm test && npm run dist:win` → in `release\`: `TeamBot-Setup-<versie>.exe`, `.blockmap`, `latest.yml` en
`win-unpacked\`; `THIRD_PARTY_NOTICES.txt` en `sbom.cdx.json` in de projectmap. Een testbuild elders (bijvoorbeeld in
een git-worktree): `npm run dist:win -- -c.directories.output=<map>`. makensis bouwt met waarschuwingen als fouten:
een kapotte `build/installer.nsh` stopt de build.

### Ondertekenen (code signing): klaar voor één wijziging

Zonder handtekening zegt Windows *Windows heeft uw pc beschermd* en *Onbekende uitgever*. Alles staat klaar: de
release-workflow geeft de sleutels door, electron-builder ondertekent `TeamBot.exe`, de uninstaller en de installer en
zet de naam van de uitgever in `app-update.yml`. Vanaf dan controleert elke geïnstalleerde TeamBot bij elke update dat
de nieuwe installer geldig ondertekend is **door diezelfde naam**; anders wordt hij niet geïnstalleerd en staat er
*Deze update is niet ondertekend door de maker van TeamBot* (`verifyPublisher` in `desktop/update-flow.ts`: zonder
consolevenster, en weigert ook als de controle zelf niet lukt). De eerste ondertekende versie gaat gewoon over een
niet-ondertekende heen.

**Route A: Azure Trusted Signing** (aanbevolen; plan *Basic*, ongeveer $10 per maand). Stappen voor de eigenaar:

1. **Azure-account** met een abonnement (portal.azure.com). Controleer vooraf of je als persoon of bedrijf in jouw
   land in aanmerking komt; de voorwaarden verschillen per land.
2. In het abonnement onder *Resourceproviders* **`Microsoft.CodeSigning` registreren**.
3. **Trusted Signing-account maken** (zoek in de portal op *Trusted Signing*; Microsoft past de naam soms aan), plan
   *Basic*, een regio in Europa. Noteer de **accountnaam** en het **eindpunt** van de regio (op de overzichtspagina),
   bijvoorbeeld `https://weu.codesigning.azure.net/` voor West-Europa.
4. **Identiteit laten controleren** (*Identity validation*, soort *Public*). Dat duurt een paar dagen.
5. **Certificaatprofiel maken** (*Certificate profiles*, soort *Public Trust*), bijvoorbeeld `teambot`. De naam op het
   certificaat (*CN*) is je gecontroleerde naam: dat wordt de `publisherName`.
6. **App-registratie** in Microsoft Entra ID (bijvoorbeeld `teambot-signing`) met een **clientgeheim**; geef die
   registratie op het Trusted Signing-account de rol **Trusted Signing Certificate Profile Signer**.
7. **GitHub-secrets** van de repository: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` en `AZURE_CLIENT_SECRET` (uit stap 6).
   De release-workflow geeft ze al door.
8. **De ene wijziging**: dit blok in `package.json` onder `build.win` (naast `"icon"`), met de waarden uit stap 3 en 5:

   ```json
   "azureSignOptions": {
     "publisherName": "Voornaam Achternaam",
     "endpoint": "https://weu.codesigning.azure.net/",
     "codeSigningAccountName": "teambot-signing",
     "certificateProfileName": "teambot"
   }
   ```

   `npm test` controleert het blok (`tests/installer-config.test.ts`). Lokaal ondertekenen: zet in PowerShell
   `$env:AZURE_TENANT_ID`, `$env:AZURE_CLIENT_ID` en `$env:AZURE_CLIENT_SECRET` en draai `npm run dist:win`
   (electron-builder installeert de PowerShell-module *TrustedSigning* zelf).
9. **Controleren**: `Get-AuthenticodeSignature .\release\TeamBot-Setup-<versie>.exe | Format-List Status,
   SignerCertificate` → `Status: Valid` en `CN=` precies de `publisherName`. Klopt de naam niet, pas `publisherName`
   aan vóór je publiceert: geïnstalleerde versies accepteren daarna alleen updates met die naam.
10. **Website**: zet in `website/src/release.json` `signed` op `true`; de uitleg over SmartScreen verdwijnt dan van de
    downloadpagina. SmartScreen bouwt vertrouwen op met het aantal downloads: de eerste dagen kan het venster nog
    komen, maar dan met je naam in plaats van *Onbekende uitgever*.
11. Optioneel, als alles werkt: `"forceCodeSigning": true` onder `build.win`, zodat een release zonder handtekening
    niet meer gebouwd kan worden.

**Route B: een certificaat als `.pfx`-bestand** (OV; sinds 2023 meestal alleen nog op een token of in een cloudkluis,
dan is route A eenvoudiger). Geen wijziging in `package.json`: zet de GitHub-secrets `WIN_CSC_LINK` (het `.pfx` in
base64) en `WIN_CSC_KEY_PASSWORD`; electron-builder leest de naam van de uitgever uit het certificaat.

**Route C: SignPath** (gratis voor open source via *SignPath Foundation*; vraagt een openbare repository met een
open-sourcelicentie, die heeft TeamBot met Apache-2.0). SignPath ondertekent de installer ná het bouwen, in de
release-workflow; daarna maakt `npm run release:feed` `latest.yml` en de `.blockmap` opnieuw, want een handtekening
verandert het bestand. Stappen voor de eigenaar:

1. **Aanvragen** bij SignPath Foundation (signpath.org, *Apply*) met de openbare repository. Na goedkeuring krijg je
   een organisatie in SignPath met een project (bijvoorbeeld `teambot`) en een ondertekenbeleid (bijvoorbeeld
   `release-signing`).
2. In SignPath de **GitHub-koppeling** van het project aanzetten (*Trusted build system*: GitHub.com) en een
   **API-token** maken voor een CI-gebruiker met het recht om in te dienen.
3. In de GitHub-repository: secret `SIGNPATH_API_TOKEN`, en onder *Variables* `SIGNPATH_ORGANIZATION_ID` (en, als ze
   anders heten dan hierboven, `SIGNPATH_PROJECT_SLUG` en `SIGNPATH_SIGNING_POLICY_SLUG`). Zolang
   `SIGNPATH_ORGANIZATION_ID` leeg is, slaat de workflow deze stap over.
4. **De ene wijziging**: dit blok in `package.json` onder `build.win`, met de naam op het certificaat (bij SignPath
   Foundation is dat de stichting zelf; controleer het met stap 5 van de eerste ondertekende build):

   ```json
   "signtoolOptions": {
     "publisherName": "SignPath Foundation"
   }
   ```

   electron-builder zet die naam in `app-update.yml`; vanaf dan installeert TeamBot alleen updates die door precies
   die naam zijn ondertekend. `npm test` controleert het blok en de workflowstappen (`tests/installer-config.test.ts`).
5. **Controleren**: `Get-AuthenticodeSignature .\TeamBot-Setup-<versie>.exe | Format-List Status, SignerCertificate`
   → `Status: Valid` en `CN=` precies de `publisherName`. Daarna `npm run release:feed -- --check` (klopt
   `latest.yml` met de ondertekende installer?).
6. Verschil met route A: SignPath ondertekent de installer (die ziet Windows bij downloaden en de updater bij elke
   update), niet `TeamBot.exe` ín de installatie. Voor SmartScreen en de updatecontrole is de installer wat telt.

### Updates

`desktop/update-flow.ts` (de hele stroom, getest met een nep-updater en met de echte electron-updater tegen een
lokale updatemap: `tests/update-feed.test.ts`), `desktop/update-channel.ts` (waar updates vandaan komen),
`desktop/update-idle.ts` (wanneer een update zichzelf mag installeren), `desktop/updater.ts` (electron-updater en
Electron) en `server/modules/backups/app-update.ts` (`/api/app-update`: de pagina, ook op de telefoon).

- **Waar updates vandaan komen** (één kanaal): `build.publish` in `package.json` (zit in elke versie die daarna
  gebouwd wordt), tenzij de eigenaar in Instellingen › Back-ups › *Geavanceerd* een ander kanaal invult (alleen op de
  computer; `TEAMBOT_UPDATE_CHANNEL` of `TEAMBOT_UPDATE_URL` gaat daar weer voor). Een map op een webserver (https)
  of GitHub Releases van een openbare repository (`github:eigenaar/naam`).
- **Zonder kanaal** (nu: `build.publish` staat op een `.invalid`-adres, alleen zodat electron-builder `latest.yml`
  en `app-update.yml` maakt) zegt Instellingen › Back-ups rustig *Nieuwe versies van TeamBot krijg je met de volgende
  installer*: geen melding, geen menu-item, geen foutmelding.
- **Automatisch bijwerken** (Instellingen › Back-ups, ook op de telefoon): *Aan* (standaard): TeamBot kijkt eens per
  dag, downloadt op de achtergrond en installeert pas als er geen bot aan het werk is, geen routine loopt of binnen
  10 minuten start, er geen back-up wordt gemaakt, en jij 15 minuten niet aan de computer zat (of het scherm vergrendeld
  is) en niet net nog aan een bot schreef. *Alleen melden*: kijkt eens per dag en zegt het. *Uit*: kijkt niet vanzelf.
  In elke stand installeert een gedownloade update bij afsluiten, en **Nu bijwerken** doet het zodra er geen taak loopt.
- De download wordt gecontroleerd tegen de sha512 in `latest.yml` (en na het ondertekenen de handtekening).
- Na **Terug naar versie x** installeert TeamBot de versie die je verliet niet vanzelf opnieuw; een nieuwere wel.
- **Back-up vooraf en de weg terug** (`docs/modules/backups.md`): vóór elke installatie een back-up (lukt die niet,
  dan geen installatie); de installers van de nieuwe en de draaiende versie blijven in
  `%APPDATA%\TeamBot\updates\installers\`; na de update *Wat is er nieuw* en onder Instellingen › Back-ups *Terug naar
  versie x*.
- **Met de one-click-installer:** electron-updater start de nieuwe installer met `--updated /S --force-run`. Die vindt
  de bestaande installatie in het register (dezelfde map), verwijdert de oude versie stil met `--updated` (gegevens
  blijven, er wordt niets gevraagd), houdt de snelkoppelingen, installeert en start TeamBot. *Terug naar versie x*
  start de bewaarde oudere installer op dezelfde manier; ook de oude wizard-installer van 0.4.1 gaat zo stil over een
  one-click-installatie heen.
- **Een draaiende TeamBot** (0.4.4; gevonden bij 0.4.3 over een draaiende 0.4.2: `/S /currentuser` stopte met code 2,
  TeamBot was weg en de bestanden bleven 0.4.2, en een tweede stille installatie startte TeamBot niet).
  `build/installer.nsh` vraagt TeamBot eerst af te sluiten (`TeamBot.exe --quit`: de draaiende TeamBot sluit netjes,
  ook zijn hulpprogramma's, en start geen gedownloade update), wacht, en beëindigt daarna alleen wat er nog van
  TeamBot over is: programma's in de installatiemap en wat die startten, nooit op programmanaam
  (`build/teambot-close.ps1`). electron-builder beëindigde alleen `TeamBot.exe`; een hulpprogramma dat TeamBot had
  gestart (dicteren, een spraak- of AI-motor) bleef draaien en hield een bestand uit de installatiemap in gebruik,
  waardoor de oude uninstaller faalde. De geïnstalleerde TeamBot werkt bovendien vanuit je gebruikersmap, zodat zijn
  hulpprogramma's de installatiemap niet als werkmap houden. Lukt het weghalen van de oude versie toch niet, dan probeert de installer het nog één keer en start
  anders de oude TeamBot weer (je zit nooit zonder). Na elke installatie start TeamBot, ook stil zonder `--force-run`.
  Getest op een kopie met `npm run installer:check` (zie hieronder).
- Lokaal getest (2026-11-06, nog met de wizard-installer): een geïnstalleerde 0.1.0 vond 0.1.1 op een lokale
  updateserver, downloadde, installeerde stil en startte opnieuw. Testen (alleen op een testmachine): bouw een tweede
  versie met `npx electron-builder --win nsis --publish never -c.extraMetadata.version=<x.y.z>
  -c.directories.output=<map>`, maak de map met `npm run release:feed -- --dir <map> --version <x.y.z>`, serveer
  `<map>\feed` op `http://127.0.0.1:<poort>/` en start de geïnstalleerde app met `TEAMBOT_UPDATE_URL` (en
  `TEAMBOT_UPDATE_TEST=1` om meteen te kijken, te downloaden en te installeren).

### Updates publiceren

Na `npm run dist:win` (of de release-workflow) en eventueel het ondertekenen:

```
npm run release:feed            # release\TeamBot-Setup-<versie>.exe → release\feed\ (latest.yml, installer, .blockmap)
npm run release:feed -- --check # klopt release\latest.yml nog met de installer? (na ondertekenen achteraf: nee)
```

`release\feed\` bevat ook de installer van de vorige versie als die in `release\` staat (voor *Terug naar versie x*).

- **GitHub Releases** (`build.publish` = `github`): de release-workflow maakt bij een tag `v<versie>` een
  **concept**-release met de installer, de `.blockmap` en `latest.yml`. Pas als de eigenaar het concept publiceert,
  zien geïnstalleerde TeamBots de nieuwe versie (electron-updater kijkt naar de nieuwste gepubliceerde release, niet
  naar concepten of pre-releases). Elke release houdt zijn eigen installer, dus de weg terug werkt vanzelf.
- **Een map op een webserver** (`build.publish` = `generic`, elke statische host met https): upload de bestanden uit
  `release\feed\` naar die map, **eerst de installer en de `.blockmap`, `latest.yml` als laatste** (zo ziet niemand
  een `latest.yml` waarvan de installer er nog niet staat), en laat de installers van eerdere versies staan. Geef
  `latest.yml` een korte cache (`Cache-Control: no-cache`). Voorbeeld met Cloudflare R2 (een bucket met een eigen
  domein, bijvoorbeeld `downloads.<domein>`; Cloudflare Pages kan niet, daar mag een bestand hoogstens 25 MB zijn):

  ```
  npx wrangler r2 object put teambot-updates/teambot/TeamBot-Setup-<versie>.exe --file release/feed/TeamBot-Setup-<versie>.exe --remote
  npx wrangler r2 object put teambot-updates/teambot/TeamBot-Setup-<versie>.exe.blockmap --file release/feed/TeamBot-Setup-<versie>.exe.blockmap --remote
  npx wrangler r2 object put teambot-updates/teambot/latest.yml --file release/feed/latest.yml --cache-control no-cache --remote
  ```

  Andere hosts (een eigen server met nginx, Backblaze B2, S3 met CloudFront) werken net zo: een map, https, die drie
  bestanden.
- **Controleren**: een geïnstalleerde TeamBot van de vorige versie, Instellingen › Back-ups › *Nu controleren* → *Versie
  x is beschikbaar*. Versies vóór 0.4.4 kennen alleen een map op een webserver, niet GitHub Releases: die krijgen
  0.4.4 één keer met de installer.

### Testen zonder je eigen TeamBot

De echte installer mag nooit draaien op een pc waar een TeamBot staat die je gebruikt: hij heeft dezelfde app-id en
dus dezelfde registersleutel. Hij zou die TeamBot stil verwijderen en vervangen en de snelkoppelingen overschrijven,
en de TeamBot die hij daarna start, loopt via Verkenner met je echte `%APPDATA%\TeamBot`. Een eigen map (`/D=`)
verandert daar niets aan.

- **Op je eigen pc:** `npm run first-launch:check` (na `npm run dist:win` of `npx electron-builder --win dir`; met
  `-- --app <map>\win-unpacked` voor een andere map). Dat start de uitgepakte app, niet de installer, met een eigen
  `APPDATA`, `LOCALAPPDATA`, `TEMP`, datamap en poort, en controleert: het venster staat er binnen een paar seconden
  met de startpagina (*TeamBot is geïnstalleerd* bij de eerste start), daarna het welkomstscherm; geen ander venster
  (geen console, geen dialoog); alleen `127.0.0.1` en geen UDP (dus geen firewallvraag); het sluitbericht precies één
  keer; een tweede start op dezelfde plek. Het stopt alleen het proces dat het zelf startte en noemt de map met
  schermafbeeldingen.
- **Installeren over een draaiende versie, op je eigen pc:** `npm run installer:check`. Bouwt met
  `electron-builder --win nsis` in een tijdelijke map installers van een kleine vervangende app met de echte
  `build/installer.nsh` en `build/teambot-close.ps1`, maar met een eigen app-id en naam (*TeamBotInstallTest*: andere
  registersleutels, geen snelkoppelingen), installeert die met `/D=` in een tijdelijke map en speelt na: de oude fout
  (code 2), de oplossing over een draaiende oude versie, opnieuw over een draaiende nieuwe, met de app dicht, het pad
  van een automatische update en stil verwijderen. Een vervangende app, omdat de installer de app via Windows start en
  die dan niet de tijdelijke `APPDATA` meekrijgt: een echte TeamBot zou je echte gegevens openen. Deze schrijft alleen
  in de tijdelijke map en wordt aan het eind stil verwijderd.
- **Op een schone VM of een tweede Windows-account** (vóór elke publicatie): installeren door te dubbelklikken
  (SmartScreen, het installatievenster, TeamBot start), snelkoppelingen en icoon, een update over de vorige versie
  (ook van 0.4.1 naar deze), *Terug naar versie x*, verwijderen met *Nee* (gegevens blijven), opnieuw installeren
  (alles is terug), verwijderen met *Ja* (de map is weg), stil installeren met `/S` en `/S --force-run`, start bij
  inloggen aan/uit, systeemvak, microfoon. Het veiligst: de gratis evaluatieversie van Windows 11 in een VM.

### Checksums en herkomst

De release-workflow (`.github/workflows/release.yml`) schrijft `SHA256SUMS.txt` en maakt een ondertekende
build-provenance- en SBOM-attestatie. Controle door gebruikers: `gh attestation verify TeamBot-Setup-<versie>.exe -R
<owner>/teambot`, of de SHA-256 op de downloadpagina.

### Microsoft Store

MSIX is optioneel, later; vereist een **Partner Center-account**.

## Server / cloud

`docker compose up -d` (zie `docker-compose.yml`). Vóór publiek gebruik: HTTPS via reverse proxy, back-ups van het
volume `teambot-data`, `TEAMBOT_ALLOW_SIGNUP=0` (alleen uitnodigingen). **Domein + hosting** regelt de eigenaar.

## iPhone (TestFlight, zonder eigen Mac)

Alleen de map `mobile/ios` gaat naar een **eigen privé-repository** op GitHub; de rest van TeamBot blijft lokaal.
GitHub Actions bouwt daar op een macOS-runner (`macos-26`, Xcode 26.x) en zet de build in **TestFlight voor interne
testers** (tot 100 mensen met een rol in App Store Connect, zonder keuring door Apple). Tot dat werkt blijft de PWA
werken (Safari › Deel › *Zet op beginscherm*).

Eisen van Apple (gecontroleerd 9 november 2026): uploads moeten gebouwd zijn met **Xcode 26 of nieuwer en de
iOS 26 SDK** (sinds 28 april 2026), nooit met een beta; apps moeten op iOS 13 of nieuwer mikken (wij: iOS 17). De
workflow kiest de nieuwste Xcode 26+ zonder beta en stopt anders met een melding.

**Ondertekenen:** automatisch via de App Store Connect API-sleutel (*cloud signing*). Geen certificaat, `.p12` of
provisioning profile in de repository of in secrets; het tijdelijke ontwikkelaarscertificaat van elke run wordt aan
het eind ingetrokken. Gekozen boven *match*-achtige secrets omdat het zonder Mac de minste stappen en geen
certificaatbeheer vraagt; de enige prijs is een sleutel met de rol Admin.

### Stappen voor de eigenaar (eenmalig, **vet** = handmatig)

1. **App ID maken** — developer.apple.com › *Certificates, Identifiers & Profiles* › *Identifiers* › **+** ›
   *App IDs* › *App*: bundle-id `app.teambot.companion` (*Explicit*), vink **Push Notifications** aan.
2. **iPhone registreren** — *Devices* › **+**: naam en UDID (Windows: app *Apple Devices* of iTunes, iPhone
   aansluiten, op het serienummer klikken tot de UDID verschijnt). Apple eist één apparaat voor automatisch
   ondertekenen.
3. **App aanmaken** — appstoreconnect.apple.com › *Apps* › **+** › *Nieuwe app*: iOS, naam (uniek, bijv. *TeamBot*
   of *TeamBot Companion*), Nederlands, bundle-id uit stap 1, SKU `teambot-ios`.
4. **API-sleutel maken** — App Store Connect › *Gebruikers en toegang* › *Integraties* › *App Store Connect API* ›
   *Teamsleutels* › **+**, toegang **Admin**. Download `AuthKey_<KEYID>.p8` (één keer mogelijk), noteer Key ID en
   Issuer ID.
5. **Repository maken en vullen** — samen met Claude (zie *Splitsen* hieronder); privé.
6. **Secrets zetten** — repository › *Settings* › *Secrets and variables* › *Actions*:

   | Secret | Waarde |
   |---|---|
   | `APPLE_TEAM_ID` | Team ID (developer.apple.com › *Account* › *Membership details*) |
   | `ASC_KEY_ID` | Key ID van de API-sleutel |
   | `ASC_ISSUER_ID` | Issuer ID |
   | `ASC_KEY_P8` | de hele tekst van `AuthKey_<KEYID>.p8` (in Kladblok openen, alles kopiëren) |

   Optioneel als *variable*: `IOS_BUNDLE_ID` (als `app.teambot.companion` bezet was) en `XCODE_VERSION`.
7. **Testers** — App Store Connect › app › *TestFlight* › *Interne testen* › **+** groep, jezelf toevoegen,
   *Automatische distributie* aan; app *TestFlight* op de iPhone installeren.
8. **Build starten** — *Actions* › *TestFlight* › *Run workflow* (of `gh workflow run testflight.yml`). Na ±20 minuten
   testen en bouwen en 5–30 minuten verwerking staat hij in TestFlight. Mislukt het, dan noemt de workflow de
   ontbrekende stap en staan de logboeken bij *Artifacts*. Kosten: een privé-repository op GitHub Free heeft 2.000
   minuten per maand en macOS telt 10 keer, dus ±200 macOS-minuten, genoeg voor ongeveer 8 builds per maand.
9. **Pushmeldingen (optioneel)** — een aparte APNs-sleutel (*Keys* › **+** › APNs) en de vier
   `TEAMBOT_APNS_*`-variabelen op de pc; zie `mobile/ios/README.md`.

### Splitsen naar een eigen repository (voor wie samenvoegt)

```bash
git subtree split --prefix=mobile/ios -b ios-app     # alleen de geschiedenis van mobile/ios, met die map als root
gh repo create <eigenaar>/teambot-ios --private      # pas na akkoord van de eigenaar
git push git@github.com:<eigenaar>/teambot-ios.git ios-app:main
```

De workflow staat al op de goede plek (`mobile/ios/.github/workflows/testflight.yml` wordt `.github/workflows/…` in
de nieuwe repository). Latere wijzigingen: opnieuw `git subtree split` en pushen, of `git subtree push`.

### App Review (pas voor externe testers en de App Store)

- **5.1.2(i)**: het toestemmingsscherm in de app noemt per AI-dienst wat er naartoe gaat, vóór het eerste gebruik;
  intrekken kan in de app en in iOS-Instellingen. Dezelfde uitleg staat op de privacypagina van de website.
- **2.5.2**: de app downloadt of draait geen code buiten de webpagina van de eigen pc; het enige script is het vaste
  script in de app.
- Privacylabels: de app verzamelt niets voor de maker. Reviewers hebben een bereikbare test-pc met koppelcode nodig.

Status: workflow en app-code klaar, **nog nooit gebouwd** (de eerste run is de eerste compilatie).
