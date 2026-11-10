# Module `remote-desktop` — Bureaublad op afstand

Pariteit 11.7 (OpenBot: Sunshine/Moonlight). Server: `server/modules/remote-desktop/`, UI: `ui/src/modules/remote-desktop/`,
stopbalk op de pc: `desktop/remote-indicator.ts`.

## Wat het doet

De eigenaar ziet en bedient zijn hele Windows-bureaublad vanaf de gekoppelde telefoon (de iPhone-app, die de web-UI
toont) of vanuit een browser op een andere computer op dezelfde verbinding (LAN of Tailscale).

- **Instellingen › Bestanden en computers › Bureaublad op afstand** (`#/m/remote-desktop`): aan/uit, "Ook bedienen met
  muis en toetsenbord" (anders alleen meekijken), "Stopt vanzelf" (5/10/15/30/60 minuten zonder bediening, standaard 10),
  wie er nu meekijkt (met Stop per sessie) en de veiligheidsregels in gewone woorden. Op de telefoon: de status,
  **Bureaublad openen** en **Uitzetten**; aanzetten staat er niet (zegt rustig dat dat op de computer kan).
- **Viewer** (`#/m/remote-desktop/live`, volledig scherm, altijd donker):
  - *Aanraken*: tik = klikken; twee keer snel tikken = dubbelklikken (de tweede tik valt precies op de eerste, anders
    ziet Windows geen dubbelklik); even vasthouden = rechtsklikken (een ring laat zien dat het zover is); vasthouden en
    slepen = slepen met de muis; snel slepen met één vinger = slepen, of het beeld verschuiven als je bent ingezoomd;
    twee vingers samen = scrollen (vingers omhoog = omlaag scrollen, zoals op de telefoon zelf); knijpen = in- en
    uitzoomen tot 8× (het midden tussen de vingers verschuift mee); kort tikken met twee vingers = rechtsklikken.
    Een sleep toont een lijn tot je loslaat en gaat dan in één keer naar de pc (nooit een muisknop die blijft hangen
    als de verbinding wegvalt).
  - *Toetsenbord*: een tekstveld (16 px, geen autocorrectie) waarvan elke wijziging op de pc wordt getypt (wat
    autocorrectie vervangt, wordt met Backspace teruggedraaid; plakken typt de tekst), plus knoppen voor Enter,
    Backspace, Esc, Tab, Ctrl+C/V/X/Z/A, Alt+Tab, de Windows-toets, pijltjes, Delete, Home/End, PgUp/PgDn, F5 en Alt+F4.
  - *Muis en toetsenbord van een andere pc*: klikken, rechtsklikken, middelklik, slepen, scrollwiel (Ctrl+wiel zoomt),
    zweven (muisbeweging, hooguit ±7 keer per seconde). Toetsen gaan naar de pc zolang het beeld de focus heeft;
    **Shift+Esc** zet de focus terug op de knoppen (geen toetsenbordval, WCAG 2.1.2).
  - *Schermen*: kiezer bovenaan (Scherm 1 … n) en in Opties met resolutie; de muisaanwijzer van de pc wordt getekend.
  - *Opties*: scherm, beeldkwaliteit (Automatisch, Scherp, Gemiddeld, Snel, Zuinig), "Alleen kijken" (tikken doet
    niets), in-/uitzoomen.
  - *Status*: een klein label op het beeld ("Live · 5 beelden per seconde", "Trage verbinding: lagere kwaliteit",
    "Verbinding kwijt, opnieuw proberen…", "Alleen kijken"); een minuut voor het vanzelf stoppen een balk met
    **Ik ben er nog**; werkt er een bot op het bureaublad, dan staat dat erboven, en na je eerste tik wacht de bot
    (met **Geef terug**).
  - Gestopt? De reden in gewone woorden (op de computer gestopt, uitgezet, te lang niets gedaan, verbinding weg, …)
    met **Opnieuw verbinden** waar dat zin heeft. Was de app een minuut op de achtergrond, dan verbindt hij vanzelf
    opnieuw zodra hij weer in beeld is.

## Veiligheid

- **Standaard uit.** Aanzetten en instellen (`PUT /remote-desktop/switch`) kan alleen **op de computer zelf**:
  - in de lijst `COMPUTER_ONLY` van `server/modules/mobile/policy.ts` (een telefoon krijgt 403 `mobile_denied`);
  - én de route weigert elk verzoek dat niet rechtstreeks van deze computer komt (`isLocalRequest`: loopback zonder
    proxy-headers) of van een telefoonsessie: een browser op een andere pc krijgt 403 `remote_here_only`.
  - Uitzetten (`POST /remote-desktop/off`) kan overal waar de eigenaar is ingelogd.
- **Alleen de eigenaar**, op zijn eigen interactieve sessies (desktop-app, browserlogin, gekoppelde telefoon; geen
  andere soorten tokens). Leden en beheerders krijgen 403. Een sessie hoort bij de inlog die hem begon: een andere inlog
  (ook van de eigenaar) kan hem niet gebruiken; wordt die inlog ingetrokken of uitgelogd, dan stopt de sessie.
- **Stopbalk op de pc** (`desktop/remote-indicator.ts`): zolang iemand meekijkt staat bovenaan het hoofdscherm een
  altijd-bovenop balk "‹apparaat› kijkt mee op deze computer" / "… bedient deze computer" (na invoer in de laatste 20
  s) met **Stop**, plus een Windows-melding bij de eerste sessie en een item in het systeemvak. Stop (en, zolang er
  iemand meekijkt, de noodstop Ctrl+Alt+Esc en het systeemvak) beëindigt alle sessies **en zet het uit**; aanzetten kan daarna alleen weer op de
  computer. De balk neemt geen focus, staat niet in schermopnames en hoort bij TeamBot: op afstand is hij niet weg te
  klikken. **Zonder balk geen bureaublad op afstand**: de server weigert aanzetten en sessies zolang de desktop-app
  geen balk heeft aangemeld (`attachIndicator`), dus in servermodus of zonder de app is het eerlijk "niet beschikbaar".
- **TeamBot zelf is afgedekt**: de schermhulp draait met het eigenaarsbeleid (`ownerPolicy()`: hele scherm, alle apps),
  maar zijn harde blokkade blijft: vensters van TeamBot (en Electron) en de Windows-beveiligingsvensters (UAC,
  inlog/vergrendeling, credential-prompts) worden in het beeld donker geschilderd en krijgen nooit invoer op afstand.
  Zo kan niemand op afstand computer-only instellingen, de koppeling van een nieuw apparaat of de stopknop omzeilen.
- **Vanzelf stoppen**: na de gekozen minuten zonder invoer (alleen kijken telt niet; "Ik ben er nog" wel), en als de
  viewer een minuut niets meer vraagt (app dicht of verbinding weg). Een tabblad of app die sluit, beëindigt de sessie
  meteen (`pagehide`).
- **Logboek** (Instellingen › Beveiliging): `remote_desktop.on`, `.options`, `.off` (met bron: computer, telefoon,
  stopknop, sneltoets, systeemvak), `.start` (apparaat, soort, alleen kijken, IP) en `.end` (reden, duur, aantal
  acties) — één begin- en één eindregel per sessie.
- Hooguit 3 sessies tegelijk, 40 invoeracties per seconde, 2 beelden tegelijk per sessie. Ctrl+Alt+Del/End worden
  geweigerd (Windows neemt ze niet aan van software).
- Werkt er een bot op het bureaublad (lease `desktop:host`), dan neemt de eerste klik of toets van de eigenaar de
  bediening over (zoals *Neem over*, blijvend tot *Geef terug*); alleen meekijken stoort de bot niet.

## Hoe het werkt (ontwerpkeuzes)

- **Hergebruik, geen nieuwe afhankelijkheid.** Beeld en invoer komen uit de schermhulp van computer use
  (`server/modules/browser/screen.ps1.ts`: één blijvend `powershell.exe` met gecompileerde C#; per-monitor DPI v2,
  meerdere schermen, `SendInput`). Bureaublad op afstand start er een **eigen** exemplaar van (map
  `<data>/remote-desktop/driver`), zodat een sessie nooit op een schermafbeelding van een bot wacht en de noodstop van
  computer use de sessie niet raakt. Nieuw in de hulp: `policy.owner` — dan mogen Alt+Tab, Alt+F4, de Windows-toets
  en wachtwoordvelden (het is de eigenaar die typt) en spreken de meldingen de eigenaar aan; de harde blokkades blijven.
  De hulp stopt 30 s nadat de laatste sessie eindigt.
- **Beeld = opvragen, niet duwen.** De viewer vraagt een JPEG van het gekozen scherm (`GET …/frame?m=&w=&q=`) zodra hij
  de vorige heeft getoond (zoals VNC's framebuffer-verzoek), met `If-None-Match`: een stilstaand scherm kost een 304
  van een paar bytes. Zo kan er op een trage lijn geen vertraging opstapelen (een MJPEG-stroom vult dan de buffers en
  loopt seconden achter). De muisaanwijzer en de resterende tijd komen als headers mee (`x-tb-cursor`, `x-tb-idle`).
  Beelden staan alleen even in `<data>/remote-desktop/tmp` en worden direct na het lezen verwijderd (ook bij opstarten).
- **Kwaliteit vanzelf** (`Adaptive` in `logic.ts`): vier niveaus (lange zijde 1920/1440/1024/720 px, JPEG 70/55/45/35).
  Duurt een nieuw beeld gemiddeld ≥ 0,7 s, dan een niveau lager (hooguit elke 3 s); ≤ 0,26 s gedurende 10 s, dan een
  niveau hoger. Hooguit ~10 beelden per seconde; bij een stilstaand scherm rustiger (0,25–0,6 s), direct na een tik weer
  snel. Een superbreed scherm (bijv. 5120×1440) krijgt een evenredig langere zijde, zodat het beeld even hoog blijft.
  Gemeten op deze pc (loopback): 45–90 ms per beeld, 15 KB (Zuinig) tot 125 KB (Scherp, 1920×1080).
- **Invoer** = kleine POST's (`…/input`) met een punt van 0..1 op het beeld; de server rekent per scherm terug naar
  fysieke pixels (ook schermen links/boven het hoofdscherm met negatieve coördinaten) en de hulp controleert vlak voor
  de invoer zelf nog het venster onder het punt.
- **Bekeken alternatieven.** OpenBot (PolyForm Noncommercial; alleen gelezen, niets overgenomen) gebruikt Sunshine/
  Moonlight via een relay en WebRTC; Sunshine, Moonlight en RustDesk zijn GPL/AGPL en vallen af voor Apache-2.0.
  MeshCentral (Apache-2.0) doet bureaublad in de browser met JPEG-tegels over een WebSocket, kwaliteit/schaal/beelden
  per seconde instelbaar en een "privacy bar" met Verbreken op het scherm — dezelfde opzet als hier (eigen code).
  Electron `desktopCapturer` + WebRTC zou zuiniger zijn (videocodec), maar vraagt signalering, werkt alleen met de
  desktop-app als zender en kan TeamBot-vensters niet per stuk afdekken; dat kan later als upgrade, de API blijft.

## API (alle onder `/api`, alleen de eigenaar)

| Route | Wat |
|---|---|
| `GET /remote-desktop` | `{enabled, control, idleMinutes, available, unavailable: 'platform'\|'app'\|null, here, sessions[]}` |
| `PUT /remote-desktop/switch` | `{enabled?, control?, idleMinutes?}` — alleen op de computer zelf (COMPUTER_ONLY + loopback) |
| `POST /remote-desktop/off` | uitzetten (overal), beëindigt alle sessies |
| `POST /remote-desktop/sessions` | `{monitor?, view?}` → `{id, view, monitor, monitors[], control, idleMinutes, idleLeftMs}` |
| `GET /remote-desktop/sessions/:id` | status + `bot` (werkt er een bot op het bureaublad) + `tookOverFrom` |
| `GET /remote-desktop/sessions/:id/frame?m=&w=&q=` | JPEG (`etag`, `x-tb-cursor`, `x-tb-idle`, `x-tb-size`) of 304 |
| `POST /remote-desktop/sessions/:id/input` | `{type: click\|move\|drag\|scroll\|type\|key, monitor, …}` (punten 0..1) |
| `POST /remote-desktop/sessions/:id/view` | `{view}` alleen kijken aan/uit (de instelling van de computer wint) |
| `POST /remote-desktop/sessions/:id/keepalive` | "Ik ben er nog" |
| `DELETE /remote-desktop/sessions/:id` | sessie beëindigen |

Een geëindigde sessie geeft 410 met `code: remote_<reden>` (`ended`, `stopped_here`, `off`, `idle`, `gone`,
`unavailable`, `shutdown`, `signed_out`); de viewer zet die om in een zin. Live events: `remote-desktop.state`,
`remote-desktop.ended {id, reason}`. Voor de desktop-app: `ctx.services.remoteDesktop` = `{attachIndicator(),
onState(fn), stopFromComputer(source), active()}`.

## Tests

- `tests/remote-desktop.test.ts` (node:test, proef-schermhulp: er gaat nooit echte invoer naar het bureaublad):
  instellingen, beeldgrootte en -kwaliteit, punten → pixels (ook negatieve schermen), validatie van invoer, toetsen van
  de eigenaar, het eigenaarsbeleid in elke hulp-aanvraag, de tekst van de stopbalk, zoom/verschuif-rekenwerk, de
  gebaren (tik, dubbeltik, vasthouden, slepen, verschuiven, scrollen, knijpen, tweevingertik), automatische kwaliteit,
  typen, toetsenbord; en via HTTP: standaard uit, aanzetten alleen op de computer (telefoon 403 `mobile_denied`, andere
  pc 403 `remote_here_only`), zonder stopbalk niet beschikbaar, sessie met beelden/304/invoer, alleen de eigenaar en
  alleen de eigen inlog, Stop op de pc, vanzelf stoppen (inactief, verbinding weg, uitgelogd), alleen meekijken, en
  een bot die wacht zodra de eigenaar tikt; plus de logboekzinnen.
- `tests/e2e/remote-desktop.mjs` (`npm run remote:check`, na `npm run build:ui`; Edge headless): aanzetten op de
  computer, koppelen als iPhone (echte QR-koppeling), de viewer met echte aanraakgebaren (CDP-touch), toetsenbord,
  trage verbinding (25 kB/s → kleiner beeld), scherm 2, Zuinig, alleen kijken, "Ik ben er nog", een browser op een
  andere pc met muis en toetsenbord, Stop op de pc; op elk telefoonscherm donker, velden ≥ 16 px, niet opzij schuiven
  en axe WCAG 2.2 A/AA. Het "bureaublad" is een plaatje dat de test zelf tekent.
- `tests/e2e/parity-04.mjs` rij 11.7.

## Beperkingen

- Alleen Windows en alleen met de desktop-app (de stopbalk). Geen geluid, geen bestanden slepen, geen klembord
  synchroon (plakken = typen), geen Ctrl+Alt+Del en geen vergrendelscherm/UAC (beveiligd bureaublad: Windows staat
  vastleggen en invoer daar niet toe). Programma's die als administrator draaien nemen geen invoer aan van een
  gewone TeamBot (UIPI); dat zie je doordat er niets gebeurt.
- JPEG per beeld, geen videocodec: op een trage lijn liever minder beelden dan vertraging. Over http op het LAN gaat het
  beeld onversleuteld (net als de rest van de app); via Tailscale is het versleuteld.
- Invoer gaat via `SendInput` op de voorgrond: de eigenaar op afstand en iemand achter de pc delen muis en toetsenbord.
- Een dubbelklik vanaf de telefoon zijn twee klikken kort na elkaar; bij veel vertraging tussen twee tikken kan
  Windows er twee losse klikken van maken.

## Handmatige voorwaarden / live test met de eigenaar

Nog te doen samen met de eigenaar (de tests sturen bewust nooit echte invoer naar deze pc):
1. In de desktop-app aanzetten (Instellingen › Bestanden en computers › Bureaublad op afstand).
2. Vanaf de iPhone-app: Bureaublad openen → de stopbalk verschijnt bovenaan het hoofdscherm van de pc.
3. Tikken, vasthouden, slepen, scrollen, typen, Alt+Tab, een ander scherm (ook de 5120×1440 en de 1920×480).
4. Een venster van TeamBot op afstand aanraken → "Dit venster kun je op afstand niet bedienen (TeamBot zelf)".
5. Op de pc **Stop** klikken in de balk (en eens de noodstop Ctrl+Alt+Esc) → telefoon zegt "Gestopt op de computer",
   het staat uit. Controleren dat de klik op de niet-focusbare balk werkt zonder het actieve venster te verstoren.
6. Logboek nakijken; een sessie 10 minuten laten liggen → "Ik ben er nog" en daarna vanzelf gestopt.
