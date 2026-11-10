# Releaserapport — TeamBot 0.3.0 (eindcontrole, plan §25)

Stand: 2026-11-08, na acceptatieronde 6 en fixronde C. Dit is de controlelijst die het plan bij een release vraagt (§25, punten 1–10),
met per punt de eisen (ID's uit `docs/MASTER_PLAN.md` §6), het platform, de status, het bewijs en wat ontbreekt.

✅ gebouwd en getest · 🟡 deels getest · ⛔ wacht op een externe voorwaarde (met het alternatief dat wél getest is).
Een ⛔ telt pas als compleet met een werkend alternatief én een expliciet besluit van de eigenaar (§21/§25). Per ⛔ staat
hieronder onder *Besluiten voor de eigenaar* een advies: wat we aanraden, waarom en wat het kost. Het besluit zelf is
van de eigenaar en staat op **open** tot hij het neemt.

Alle automatische poorten zijn op 2026-11-08 één voor één gedraaid (Windows 11 Home x64, Node 26.13.0, TeamBot 0.3.0),
elk met een eigen tijdelijke datamap en `APPDATA`: `typecheck` schoon, `npm test` 862/862, `e2e` 13 suites geslaagd,
`a11y` 0 bevindingen, `i18n:check` 10 talen × 12.041 teksten en 78 pagina's schoon, `mobile:check` 20/20, `perf` 14/14,
`licenses:check` 380 permissief, `website:check` 0 bevindingen, `status:check` 22/22 in echte Electron, `secrets:check`
0 treffers, ook in de bestanden ín `app.asar`. Details in `docs/STATUS.md`.

| # | Onderdeel (§25) | Eisen | Platform | Status | Bewijs | Ontbreekt / alternatief | Besluit eigenaar |
|---|---|---|---|---|---|---|---|
| 1 | Functiematrix per eis met platform, implementatie, status en bewijs | alle | alle | ✅ | `docs/MASTER_PLAN.md` §6; master-checklist van de eindacceptatie (239 rijen: kern en aanbieders ronde 5, uitbreidingen ronde 6, release ronde 4) | — | — |
| 2 | Windows 11 x64: schone installatie, upgrade, verwijderen, update, handtekening; Windows 10 alleen ESU; iOS | REL-02, REL-03, REL-04, MOB-04, SEC-07 | Windows 11 x64; iOS | 🟡 / ⛔ | `npm run dist:win` → `TeamBot-Setup-0.3.0.exe`, SHA-512 en grootte gelijk aan `latest.yml`; installer bevat LICENSE, NOTICE, THIRD_PARTY_NOTICES en `sbom.cdx.json`; uitgepakte app gestart met tijdelijke datamap, DPAPI-sleutel, migratie van 0.1.0-data, harde stop zonder corruptie, netjes afsluiten zonder processen (`tests/keystore.test.ts`, acceptatierapport D); updater lokaal 0.1.0 → 0.1.1 (`docs/IOS_WINDOWS_RELEASE.md`); verwijderen vraagt of de gegevens mee moeten, met *Nee* als standaard, nooit bij stil verwijderen of bijwerken (`build/installer.nsh`, `tests/installer-nsh.test.ts`; de build zet de vraag in de uninstaller) | Installeren/upgraden/verwijderen met de echte installer (ook de nieuwe vraag over de gegevens) vraagt een **schone VM of tweede Windows-account**; ⛔ **codesigning-certificaat** (SmartScreen, handtekeningcontrole van updates); `build.publish` wijst nog naar een placeholder: voor updates via GitHub Releases eerst de repository instellen; Windows 10 ESU niet getest; ⛔ iOS: **Mac + Apple Developer-account** (alternatief: PWA, `npm run mobile:check`) | open (advies B1, B2, B6) |
| 3 | Groepschat: parallel, lead-overdracht, privé/gedeeld, per bot geheugen/model/rechten, goedkeuringen, stop/hervat, geen dubbele runs of cycli, kostenlimiet | TEAM-01…07 | alle | ✅ | `tests/rooms.test.ts`, `tests/team-package.test.ts`, e2e `c4-groups` (takenbord, groepsbestanden, kanaal aan een groep, organisatie), live Schrijver ↔ Onderzoeker | — | — |
| 4 | Geheugen: verouderde feiten, tegenspraak, bronnen, ACL-lekken, consolidatie/quota, vergeten in cascade, herstel na back-up, gevoelige data | MEM-01…05 | alle | ✅ | `tests/memory.test.ts`, `tests/memory-eval.test.ts`, `tests/backup-forget.test.ts`; fysiek vergeten (secure_delete, WAL) | — | — |
| 5 | Extensies: installeren/bijwerken/terugdraaien/verwijderen, kwaadaardige skill, licenties, scopes, intrekken | EXT-01…06 | alle | ✅ | `tests/skills.test.ts`, `tests/publisher-sdk.test.ts`, `tests/mcp.test.ts`, `npm run licenses:check`; SDK-doorloop alleen met `docs/SDK.md`: sleutel, pakket, ondertekenen, controleren, zip, import in de UI als "Ondertekend, onbekende uitgever"; gewijzigd bestand → controle faalt | — | — |
| 6 | Computers: privé en gedeeld, concurrentie, lease, geen terugval naar de host, overnemen, snapshots/repetitie, crash, persistente data | CMP-01…07 | Windows 11 Home | 🟡 / ⛔ | `tests/browser.test.ts`, `tests/computer-use.test.ts`, `tests/remote-computer.test.ts`; oefenronde naast de echte map (e2e `c4-models-cli-review`) | ⛔ Privé-VM/container: Hyper-V bestaat niet op Windows Home en Docker is op deze pc niet geïnstalleerd (alternatief: eigen browser per bot, SSH-server, cloud-VM, oefenronde; nooit stille terugval); live muis/toetsenbord (`npm run desktop:live`) nog niet gedraaid met de nieuwe computer use; SSH niet tegen een echte server; cloud-VM niet met een **echt Hetzner/DigitalOcean-token** | open (advies B3) |
| 7 | Spraak: microfoontoestemming, dempen/onderbreken/ophangen, bewaartermijn, sleutel-isolatie, storing provider, kosten | VOX-01…05 | Windows; iOS | 🟡 | `tests/voice.test.ts`, `tests/voice-local.test.ts`, `tests/voice-streaming.test.ts`, `tests/dictation-hotkey.test.ts`; live lokaal gesprek met onderbreken | iOS-microfoon op een **echte iPhone** (alternatief: PWA in de browser); onderbreken alleen op Windows getest; OpenAI Realtime is betaald en niet opnieuw getest | open (advies B8) |
| 8 | Routines: tijdzone/zomertijd, gemiste runs, retries/idempotentie, webhook-auth/rotatie, dedupe, slapende host, annuleren, kostenplafond | RTN-01…03 | alle | ✅ | `tests/routines.test.ts`, `tests/wait-for.test.ts`, `tests/power.test.ts`; kalender en wachtpunt in e2e `c4-core` | Een routine loopt alleen als de pc aan is (optie *pc wakker houden*, standaard uit) | — |
| 9 | Beveiliging en privacy: dreigingsmodel, SBOM/notices, gegevensstromen, export/verwijderen, secrets-scan, externe review vóór cloudproductie | SEC-01, SEC-02, SEC-07 | alle | 🟡 / ⛔ | `docs/THREAT_MODEL.md` (T1–T29, ook dicteren in elk programma en teams importeren), `SECURITY.md` (meldroute, termijnen per ernst, ondersteunde versies), `tests/security-review.test.ts`, `tests/web-safety.test.ts`, `tests/backups.test.ts`, `tests/sso-scim.test.ts`; SBOM + notices in de installer; `npm run secrets:check` 0, ook in de bestanden ín `app.asar` (`tests/secret-scan.test.ts`) | ⛔ **Externe pentest** vóór de cloud live gaat; ⛔ **juridische toets** van licenties vóór verkoop (o.a. Piper/espeak-ng GPL als apart proces, gedocumenteerd in `docs/modules/voice.md`); de meldroute werkt pas met een **openbare GitHub-repository** | open (advies B4, B5, B6) |
| 10 | Vergelijkend bewijs: zelfde taken, versies en limieten tegen concurrenten; metingen en beperkingen publiceren | §24, §25 #10 | Windows | ⛔ | Eigen metingen: `npm run perf` 14/14, `npm run a11y` 0; vergelijkingspagina van de website met alleen openbare feiten, bronnen en controledatum, zonder "beter dan" | Geen vergelijkende sessies met dezelfde taken tegen OpenBot, OpenMausBot of Grok Bot (vraagt accounts bij die diensten en een menselijke beoordeling); daarom **geen claim "beter dan"** op de website | open (advies B7) |

## Besluiten voor de eigenaar

Per ⛔ (en het open punt 7): ons advies, waarom, en wat het kost. Bedragen zijn een indicatie van november 2026;
controleer ze bij aanschaf. **Besluit: open** betekent dat de eigenaar nog moet kiezen.

**B1 — Codesigning-certificaat** (punt 2)
- *Advies:* ja, vóór de eerste openbare release. Neem het goedkoopste wat bij je past: Microsoft Trusted Signing
  (Azure) als je daarvoor in aanmerking komt (de voorwaarden zijn streng en verschillen per land), anders een gewoon
  OV-certificaat. Een duurder EV-certificaat is niet nodig: volgens Microsoft levert EV sinds 2024 geen voorsprong meer
  op bij SmartScreen.
- *Waarom:* zonder handtekening toont Windows "onbekende uitgever" en houdt SmartScreen de installer tegen; veel mensen
  stoppen dan. Met een handtekening kan de updater ook controleren dat een update echt van jou is (`win.publisherName`).
- *Wat het kost:* Trusted Signing ongeveer $10 per maand; een OV-certificaat ongeveer €200–500 per jaar (de sleutel
  moet op een hardwaretoken of in een cloudkluis). Eenmalig een dagdeel om het in de release-workflow te zetten.
  SmartScreen bouwt daarna nog vertrouwen op naarmate er gedownload wordt.
- *Als je het niet doet:* alleen voor jezelf en bekenden; de website zegt eerlijk dat Windows waarschuwt.
- *Besluit:* open.

**B2 — Eigen iOS-app in de App Store** (punt 2)
- *Advies:* nu niet; houd de telefoon-app als PWA (werkt al: `npm run mobile:check` 20/20, koppelen via QR en
  Tailscale). Kom erop terug als de PWA op de iPhone echt tekortschiet.
- *Waarom:* de PWA doet chatten, goedkeuren en meldingen. Een App Store-app vraagt een Mac, een review door Apple en
  onderhoud bij elke iOS-versie, voor weinig extra.
- *Wat het kost:* Apple Developer Program €99 per jaar, een Mac (of een macOS-buildserver) en enkele dagen werk plus de
  review door Apple.
- *Besluit:* open.

**B3 — Een eigen VM of container per bot** (punt 6)
- *Advies:* voor 0.3.0 de alternatieven accepteren (eigen browser per bot, eigen server via SSH, cloud-VM, oefenronde
  naast de echte map). Wil je de privé-container toch zien werken: installeer Docker Desktop, dat draait ook op
  Windows 11 Home (via WSL 2); de containermodus zit al in TeamBot en is dan te testen. Niet naar Windows Pro alleen
  hiervoor.
- *Waarom:* TeamBot valt nooit stil terug op je eigen pc; de vangrail is de toestemmingsvraag. Een container maakt het
  veiliger voor shellwerk, maar is voor gewoon gebruik niet nodig.
- *Wat het kost:* de alternatieven niets. Docker Desktop is gratis voor persoonlijk gebruik en kleine bedrijven, plus
  ongeveer een uur om te installeren en te testen. Hyper-V vraagt Windows 11 Pro (upgrade ongeveer €145).
- *Besluit:* open.

**B4 — Externe pentest** (punt 9)
- *Advies:* niet nodig voor de desktopversie; wel verplicht voordat de beheerde cloud live gaat. Tot dan zijn het
  dreigingsmodel, de beveiligingstests en de meldroute genoeg.
- *Waarom:* op de desktop draait TeamBot op je eigen pc (de server luistert alleen op 127.0.0.1, de telefoon komt via
  Tailscale) met je eigen sleutels; er is geen server van ons die aangevallen kan worden. In de cloud staan gegevens
  van anderen bij ons: daar hoort een onafhankelijke toets bij.
- *Wat het kost:* voor een webapp met een cloudomgeving meestal €4.000–15.000, afhankelijk van hoeveel dagen het
  bureau test; reken op 2–4 weken doorlooptijd plus tijd om bevindingen op te lossen.
- *Besluit:* open.

**B5 — Juridische toets van de licenties** (punt 9)
- *Advies:* niet nodig om TeamBot gratis als open source te publiceren; wel vóór je iets verkoopt (cloud of een
  betaalde versie).
- *Waarom:* TeamBot is Apache-2.0, alle 380 productie-afhankelijkheden zijn permissief (`npm run licenses:check`), de
  notices en de SBOM zitten in de installer, en Piper/espeak-ng (GPL) draait als apart proces, vastgelegd in
  `docs/modules/voice.md` en ADR 0004. Bij verkoop komen er voorwaarden en aansprakelijkheid bij: dat hoort een jurist
  te bekijken.
- *Wat het kost:* een paar uur van een IT-jurist, ongeveer €300–1.800.
- *Besluit:* open.

**B6 — Openbare GitHub-repository** (punt 2 en 9)
- *Advies:* ja, aanmaken vóór de eerste release.
- *Waarom:* zonder repository zijn er geen updates via GitHub Releases (`build.publish` wijst nu naar een placeholder),
  geen CI, geen releases met herkomstbewijs, werkt de meldroute uit `SECURITY.md` niet en blijft de downloadknop op de
  website uit. De code wordt daarmee openbaar; dat past bij Apache-2.0.
- *Wat het kost:* niets; een à twee uur werk. Kijk vooraf de git-geschiedenis na op privézaken (de secret scan vond 0
  sleutels) of begin de openbare repository met een schone geschiedenis.
- *Besluit:* open.

**B7 — Vergelijkend bewijs tegen OpenBot, OpenMausBot en Grok Bot** (punt 10)
- *Advies:* accepteren zonder "beter dan"-claim, zoals de website nu doet. Wil je toch vergelijken: één eigen proef met
  de taken die je echt doet (je gebruikt OpenBot dagelijks), met versies en datum, en die eerlijk publiceren, ook waar
  TeamBot verliest.
- *Waarom:* een vergelijking zonder dezelfde taken, versies en limieten is niet eerlijk, en een claim zonder meting kan
  niet op de website.
- *Wat het kost:* niets als je het niet doet; een eigen proef ongeveer een dag, plus abonnementen bij de andere
  diensten voor die maand.
- *Besluit:* open.

**B8 — Spraak op een echte iPhone** (punt 7)
- *Advies:* één keer samen testen met je eigen iPhone: TeamBot via Tailscale openen, microfoon toestaan, dicteren en een
  gesprek met onderbreken. Tot dan staat het op de website als "nog niet live getest".
- *Waarom:* de microfoon in Safari gedraagt zich anders dan in Edge; dat zie je alleen op een echt toestel.
- *Wat het kost:* niets; 15–30 minuten.
- *Besluit:* open.

## De live versie online zetten

Wat de eigenaar doet voor een openbare release, in deze volgorde. Alles hieronder is voorbereid en getest zonder iets
te publiceren; er wordt niets gepusht of geüpload tot de eigenaar het zelf doet. Eerst de besluiten B1–B8 hierboven
(B1 ondertekenen en B6 de repository bepalen de stappen 4 en 5).

**1. Domein.** Kies één naam en registreer die (een `.nl` of `.app` kost ongeveer €10–20 per jaar). Zet de DNS bij
Cloudflare (gratis; daar komen ook de website en eventueel de updates). Plan twee adressen: `<domein>` voor de
website en, als je de updates zelf host, `downloads.<domein>` voor het updatekanaal.

**2. Website** (`website/dist` is een statische map, details in `website/README.md`):

```
$env:TEAMBOT_SITE_URL='https://<domein>'; $env:TEAMBOT_REPO_URL='https://github.com/<account>/teambot'
$env:TEAMBOT_SHA256SUMS='release\SHA256SUMS.txt'; npm run website:check
npx wrangler pages deploy website/dist --project-name teambot
```

Koppel `<domein>` aan het Pages-project (*Custom domains*). GitHub Pages kan ook. Na het ondertekenen (stap 4):
`signed` op `true` in `website/src/release.json`, dan verdwijnt de uitleg over SmartScreen.

**3. Updatekanaal: de ene wijziging die automatisch bijwerken aanzet.** Vervang in `package.json` `build.publish`
(nu een `.invalid`-adres, waardoor TeamBot zegt dat nieuwe versies met de volgende installer komen) door één van deze
twee; elke versie die daarna gebouwd wordt, werkt zichzelf bij (Automatisch bijwerken staat standaard aan):

- GitHub Releases (vraagt een openbare repository, stap 5):

  ```json
  "publish": [
    { "provider": "github", "owner": "<account>", "repo": "teambot", "releaseType": "release" }
  ]
  ```

- of een map op een webserver (bijvoorbeeld Cloudflare R2 met het adres `downloads.<domein>`):

  ```json
  "publish": [
    { "provider": "generic", "url": "https://downloads.<domein>/teambot/" }
  ]
  ```

Per release daarna: `npm run release:feed` en de bestanden publiceren zoals in `docs/IOS_WINDOWS_RELEASE.md`
(*Updates publiceren*): bij GitHub het concept van de release-workflow publiceren, bij een map eerst de installer en
de `.blockmap` uploaden en `latest.yml` als laatste. TeamBots van vóór deze wijziging krijgen de eerste versie mét
kanaal nog één keer met de installer (of het kanaal in Instellingen › Back-ups › *Geavanceerd*).

**4. Ondertekenen** (advies B1): kies één route uit `docs/IOS_WINDOWS_RELEASE.md`, *Ondertekenen*; elk is één blok
onder `build.win` plus de secrets in de repository.

- *Azure Trusted Signing* (ongeveer $10 per maand, identiteitscontrole van een paar dagen): `azureSignOptions`.
- *SignPath Foundation* (gratis voor open source; vraagt een openbare repository en een aanvraag):
  `signtoolOptions.publisherName` en de variabele `SIGNPATH_ORGANIZATION_ID`. De workflow ondertekent de installer en
  maakt `latest.yml` opnieuw.

Controleer de eerste ondertekende installer met `Get-AuthenticodeSignature`: de naam moet precies de `publisherName`
zijn, want geïnstalleerde TeamBots accepteren daarna alleen updates met die naam.

**5. GitHub-repository openbaar of niet** (advies B6):

- *Openbaar* is nodig voor updates via GitHub Releases (een privérepository zou een sleutel in de app vragen, dat
  doet TeamBot niet), voor SignPath Foundation, voor de meldroute uit `SECURITY.md` en voor de links op de website
  (`TEAMBOT_REPO_URL`). Kijk de geschiedenis vooraf na (`npm run secrets:check` vond 0 sleutels) of begin de openbare
  repository met een schone geschiedenis. Zet de secrets en variabelen van stap 4 in de repository.
- *Niet openbaar*: dan het updatekanaal als map op een webserver (stap 3, tweede blok) en ondertekenen met Azure
  Trusted Signing. De release-workflow werkt ook in een privérepository; de downloadknop wijst dan naar je eigen
  host.

**6. De release zelf.**

1. Versie ophogen, `CHANGELOG.md` bijwerken, `npm test`, `npm run e2e` en de andere poorten uit `docs/STATUS.md`.
2. De installer één keer op een **schone Windows 11-VM** (of een tweede Windows-account) installeren, een data-upgrade
   doen, verwijderen met *Nee* (gegevens blijven), opnieuw installeren (alles is terug) en verwijderen met *Ja* (de
   map `%APPDATA%\TeamBot` is weg). Nooit in het Windows-account waar je echte TeamBot staat: de installer gebruikt
   dezelfde app-id. Het veiligst is een VM met de gratis evaluatieversie van Windows 11 of een andere pc; een tweede
   lokaal account kan ook, kies dan bij het installeren *alleen voor mij*.
3. Een tag `v<versie>` pushen: de release-workflow bouwt, ondertekent, maakt `latest.yml` en zet een concept-release
   klaar. Publiceer het concept (of upload `release/feed/`) pas na stap 2.
4. Controleren op die VM met de vorige versie: Instellingen › Back-ups › *Nu controleren* → *Versie x is beschikbaar*,
   *Nu bijwerken* → back-up, installeren, opnieuw starten, *Wat is er nieuw*; daarna *Terug naar versie x*.
5. Samen met de eigenaar: `npm run desktop:live` (muis en toetsenbord), WhatsApp en de iPhone koppelen (zie
   `docs/STATUS.md`).
