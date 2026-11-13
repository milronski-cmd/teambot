# TeamBot voor iPhone

Kleine SwiftUI-app rond de TeamBot-webapp van **je eigen** pc of server. De app voert zelf geen AI of agents uit;
je pc blijft de plek waar alles draait. Deze map is een eigen (privé) repository: de map `mobile/ios` van TeamBot.
GitHub Actions bouwt hem op een macOS-runner en zet hem in TestFlight.

> **Status (eerlijk):** de Swift-code is op Windows geschreven en **nog nooit gecompileerd**. De eerste run van de
> workflow is ook de eerste compilatie; reken op een paar kleine reparaties. Zie *Bekende risico's* onderaan.

## Wat de app doet

| Onderdeel | Hoe |
|---|---|
| Koppelen | Native QR-scanner (AVFoundation) of adres + koppelcode. `POST /api/public/mobile/claim` met `client: "ios-app"`. |
| Sleutel | Het apparaat-token staat alleen in de **Keychain** (`AfterFirstUnlockThisDeviceOnly`). Overleeft app-updates; gaat niet mee in een back-up naar een andere iPhone. Een koppeling uit een oudere app-versie blijft gewoon werken. |
| Toestemming | Vóór het eerste gebruik: welke AI-diensten de bots op je pc gebruiken en wat ze krijgen (`GET /api/mobile/privacy`), met *Ik geef toestemming* / *Niet akkoord*. Pas daarna laadt de webapp. Komt er op de pc een nieuwe AI-dienst bij, dan vraagt de app opnieuw. Intrekken: in de app (tandwiel › *Toestemming intrekken*), in TeamBot › Instellingen › Telefoon › *Toestemming en verbinding*, of met de schakelaar in iOS-Instellingen › TeamBot (die kan alleen intrekken). App Review-richtlijn 5.1.2(i). |
| Verbinding per schakel | De app vraagt elk bekend adres van je pc tegelijk "ben jij mijn TeamBot?" (`POST /api/public/mobile/hello`, zonder token; het antwoord is met een HMAC aan het token gebonden). Het token gaat alleen naar een adres dat dat bewijst. Daarna één eerlijk scherm per probleem: *pc slaapt*, *TeamBot is dicht*, *netwerk weg* (niet op je wifi thuis, Tailscale uit, lokaal netwerk niet toegestaan, ander netwerk), *iPhone offline*, *koppeling ingetrokken*, steeds met de oplossing als eerste knop. |
| TeamBot-verbinding | Onderweg zonder Tailscale: iroh naar de sleutel van de pc uit de QR-code, via een lokale proxy voor de web view (`IrohTunnel`). Altijd als laatste geprobeerd, na wifi en Tailscale. |
| Netwerkwissel | De pc geeft zijn andere adressen mee (`GET /api/mobile/status`: wifi, Tailscale, https). Wisselt de iPhone van wifi naar mobiel of Tailscale, dan zoekt de app vanzelf het adres dat werkt. |
| App | `WKWebView` met de webapp van de pc. Het token wordt alleen voor de origin van de pc in de pagina gezet; navigatie buiten de pc opent Safari. De app voert alleen het vaste script uit dat in de app zit; de pagina kan hem alleen de vaste woorden `unauthorized` en `settings` sturen (richtlijn 2.5.2). |
| Microfoon | Alleen voor de pagina van de pc en alleen na de iOS-vraag (`NSMicrophoneUsageDescription`). Nooit op de achtergrond. |
| Opnieuw koppelen | Wist nooit gesprekken: die staan op je pc. Berichten die nog niet waren afgeleverd (*Nog niet afgeleverd*) blijven ook op de iPhone staan. |
| Meldingen | APNs. Na koppelen vraagt de app één keer om toestemming. Een melding opent alleen de app; er wordt nooit iets goedgekeurd vanuit een melding. |
| Startpagina | Haak voor golf 2: geeft de pc in `GET /api/mobile/status` een `home` (bijv. de hoofdbot), dan opent de app daar (`AppModel.startRoute`). Nu nog `null`. |

Teksten over privacy volgen de privacypagina van de website (`website/src/nl.json` › `privacy`). In de app staan ze
in `TeamBot/Views/ConsentView.swift` en `TeamBot/Privacy/Consent.swift` (`dataText`); houd die gelijk.

## TestFlight via GitHub Actions (zonder Mac)

Workflow: `.github/workflows/testflight.yml`. Bij elke pull request bouwt en test hij op een iPhone-simulator. Met
*Run workflow* test hij en zet hij een build in TestFlight. **Minuten:** in een privé-repository tellen
macOS-minuten 10 keer; GitHub Free geeft 2.000 minuten per maand, dus ongeveer 200 macOS-minuten: genoeg voor
ongeveer 8 TestFlight-builds per maand (een build kost 20 à 25 minuten). Daarom draait hij niet bij elke push.

**Ondertekenen:** automatisch, met de App Store Connect API-sleutel. Xcode maakt op de runner een tijdelijk
ontwikkelaarscertificaat (aan het eind van de run weer ingetrokken door `ci/revoke_run_certificates.py`) en
ondertekent de upload met het distributiecertificaat dat Apple zelf beheert (*cloud signing*). Je hoeft dus geen
certificaat, `.p12` of provisioning profile te maken of te bewaren. Alleen de API-sleutel staat in GitHub-secrets.

Stappen (eenmalig):

1. **App ID** — developer.apple.com › *Certificates, Identifiers & Profiles* › *Identifiers* › **+** › *App IDs* ›
   *App*. Description `TeamBot`, Bundle ID *Explicit* `app.teambot.companion` (bezet? kies bijv.
   `nl.<jouwnaam>.teambot` en zet die als variabele `IOS_BUNDLE_ID`, zie stap 5). Vink **Push Notifications** aan.
2. **Je iPhone als apparaat** (Apple eist minstens één apparaat in je team voor automatisch ondertekenen) —
   *Devices* › **+** › naam en **UDID**. De UDID vind je op Windows in de app *Apple Devices* (of iTunes): sluit je
   iPhone aan, kies hem en klik op het serienummer tot *UDID* verschijnt; kopieer die.
3. **App in App Store Connect** — appstoreconnect.apple.com › *Apps* › **+** › *Nieuwe app*: platform iOS, naam
   (bijv. *TeamBot*; moet uniek zijn in de App Store, anders *TeamBot Companion*), taal Nederlands, de bundle-id van
   stap 1, SKU `teambot-ios`.
4. **API-sleutel** — App Store Connect › *Gebruikers en toegang* › *Integraties* › *App Store Connect API* ›
   *Teamsleutels* › **+**. Naam `GitHub TestFlight`, toegang **Admin** (lagere rollen mogen de cloud-ondertekening
   niet gebruiken). Download `AuthKey_XXXXXXXXXX.p8` (kan maar één keer) en noteer de *Key ID* en de *Issuer ID*
   (staat boven de lijst).
5. **Secrets in GitHub** — deze repository › *Settings* › *Secrets and variables* › *Actions* › *New repository
   secret*:
   - `APPLE_TEAM_ID` — je Team ID (developer.apple.com › *Account* › *Membership details*)
   - `ASC_KEY_ID` — de Key ID
   - `ASC_ISSUER_ID` — de Issuer ID
   - `ASC_KEY_P8` — open `AuthKey_….p8` in Kladblok en plak de **hele** tekst, met de regels BEGIN en END
   Optioneel onder *Variables*: `IOS_BUNDLE_ID` (andere bundle-id) en `XCODE_VERSION` (bijv. `26.6`).
6. **Interne testers** — App Store Connect › je app › *TestFlight* › *Interne testen* › **+** groep, voeg jezelf
   toe en zet *Automatische distributie* aan. Installeer de app *TestFlight* op je iPhone.

Een build starten: *Actions* › *TestFlight* › *Run workflow* (vinkjes *Uploaden* en *Alleen voor interne testers*
staan aan) › *Run workflow*. Of met de GitHub CLI: `gh workflow run testflight.yml`. Na 10 à 20 minuten bouwen en
5 à 30 minuten verwerken bij Apple staat de build in TestFlight. Het buildnummer is `<run>.<poging>`; de versie
staat in `project.yml` (`MARKETING_VERSION`).

Gaat iets mis, dan zegt de workflow welke stap ontbreekt (geen apparaat, geen app-record, sleutel zonder Admin,
te veel certificaten) en staan de volledige logboeken bij *Artifacts*.

## Bouwen op een Mac (optioneel)

1. Xcode 26 of nieuwer (App Store-uploads vereisen sinds 28 april 2026 Xcode 26 en de iOS 26 SDK) en Homebrew.
2. `brew install xcodegen`
3. In deze map: `TEAMBOT_TEAM_ID=<Team ID> xcodegen generate` (zonder Team ID alleen de simulator).
4. Open `TeamBot.xcodeproj` en start op een simulator of je iPhone.
5. Tests: `xcodebuild test -project TeamBot.xcodeproj -scheme TeamBot -destination 'platform=iOS Simulator,name=iPhone 17' CODE_SIGNING_ALLOWED=NO`

Iconen: `node tools/gen-icons.mjs` (gebruikt een lokale Chrome of Edge).

## Verbinding met je pc

De app probeert in deze volgorde: wifi/LAN, Tailscale en https-adressen, dan de TeamBot-verbinding. Hij zegt in het
instellingenblad (en kort bovenin) hoe hij verbonden is: *Thuis, via wifi*, *Via Tailscale*, *Via TeamBot-verbinding,
direct* of *Onderweg via TeamBot-verbinding*.

- **TeamBot-verbinding (voor iedereen, sinds 0.4.4)**: geen Tailscale, account of routerinstellingen. Op de pc
  *Instellingen › Telefoon* (sinds 0.4.5 staat de QR-code er meteen en gaat de verbinding vanzelf aan); in de app
  *QR-code scannen*, de enige knop op het eerste scherm (de code met een adres alleen als de camera niet
  mag). Werkt thuis en onderweg, versleuteld tot op de pc (iroh: direct waar het kan, anders via een relay die alleen versleutelde gegevens
  ziet). De QR-code bevat de sleutel van de pc (`n=`), die de app vastpint. Code: `TeamBot/Connection/IrohTunnel.swift`
  (IrohLib 1.2.0 via SwiftPM, zie `project.yml`): een lokale proxy op `127.0.0.1:<vaste poort>` waar elke
  TCP-verbinding van de web view één iroh-stream naar de pc wordt. Meer: `docs/modules/mobile.md` › *TeamBot-verbinding*.
- **Tailscale https (aanbevolen voor wie Tailscale al heeft)**: op je pc *Instellingen › Telefoon › Telefoon via Tailscale instellen*; op de
  iPhone de app Tailscale. Werkt thuis en onderweg, en alleen via dit adres kan de app precies zien of je pc slaapt
  (geen antwoord) of TeamBot dicht is (Tailscale antwoordt dan 502).
- **Zelfde wifi**: *Instellingen › Telefoon › Telefoon-toegang* op je pc. Dit is `http` en niet versleuteld; iOS
  vraagt om toegang tot het lokale netwerk. Op wifi kan de app een slapende pc niet van een gesloten TeamBot
  onderscheiden; het scherm zegt dan beide.
- **Eigen tunnel of server**: elk `https`-adres werkt.

## Pushmeldingen (APNs) aanzetten

1. *Keys* op developer.apple.com › **+** › *Apple Push Notifications service (APNs)* › download `AuthKey_….p8`
   (een andere sleutel dan die voor TestFlight).
2. Op de pc waar TeamBot draait (nooit in een repository):
   ```
   TEAMBOT_APNS_KEY_FILE=C:\pad\naar\AuthKey_XXXXXX.p8
   TEAMBOT_APNS_KEY_ID=XXXXXX
   TEAMBOT_APNS_TEAM_ID=<Team ID>
   TEAMBOT_APNS_TOPIC=app.teambot.companion
   ```
3. Debug-builds melden zich aan als `sandbox`, TestFlight als `production`; de server kiest de juiste Apple-host.

## App Review (pas nodig voor externe testers en de App Store)

- Privacybeleid-URL en App Privacy-antwoorden: de app verzamelt zelf niets voor de maker; gegevens gaan naar de
  eigen pc van de gebruiker en van daar naar de AI-diensten die hij zelf koos (zie het toestemmingsscherm).
  `PrivacyInfo.xcprivacy` declareert alleen UserDefaults (reden `CA92.1`).
- Reviewers hebben een bereikbare test-pc met koppelcode nodig, en een uitleg dat de app een schil is om de eigen
  TeamBot (richtlijn 4.2 kan bij een webschil vragen stellen).

## Bekende risico's bij de eerste echte build

- Ongecompileerd: verwacht kleine Swift-fouten (concurrency-waarschuwingen in Swift 5-modus, een API die net anders
  heet). De logica die het meest telt (`LinkDiagnosis`, `HostClient.outcome`, `ConsentStore`, `Pairing`) is in
  `TeamBotTests` afgedekt.
- Automatisch ondertekenen op een verse runner kan haperen op Apple-kant (sleutelrol, geen apparaat, certificaatlimiet).
  De workflow herkent die gevallen en zegt wat te doen.
- `tailscale://` als link naar de Tailscale-app is niet gegarandeerd; de app valt terug op de App Store-pagina.
- **TeamBot-verbinding (0.4.4), ongecompileerd:** de eerste CI-run bevestigt (1) dat SwiftPM IrohLib 1.2.0 ophaalt
  (stap *Swift-pakketten ophalen*; het xcframework komt uit de iroh-ffi-release met vaste checksum), (2) de namen uit
  IrohLib (`Endpoint.bind(options:)`, `EndpointOptions(preset:relayMode:)`, `EndpointAddr(id:relayUrl:addresses:)`,
  `connect(addr:alpn:)`, `openBi()`, `read(sizeLimit:)`, `writeAll(buf:)`, `paths()`), (3) `NWListener` op
  `127.0.0.1` via `requiredLocalEndpoint`, en (4) de nieuwe tests in `TeamBotLinkTests`. Minimaal iOS 17.5 (eis van
  IrohLib). De app wordt groter door de statische iroh-bibliotheek. Een echte iPhone onderweg (4G) is nog niet getest.
- **Exportregels:** de app heeft nu een eigen versleuteling (QUIC/TLS van iroh). `ITSAppUsesNonExemptEncryption`
  staat op `false`; controleer vóór externe testers of de App Store of dat nog klopt (standaardversleuteling voor
  een eigen verbinding valt meestal onder de vrijstelling, maar dat is een keuze van de eigenaar).
