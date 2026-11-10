# Module: health — Hoe gaat het met TeamBot? en de wachter buiten de app

`server/modules/health` (0.4.3 meter, 0.4.4 wachter), UI `ui/src/modules/health/HealthSettings.tsx`
(*Instellingen › Algemeen › Hoe gaat het met TeamBot?*).

## Meter (0.4.3)

`meter.ts` meet in het serverproces de vertraging van de event-loop, stilstand (> 100 ms en > 1 s), CPU, geheugen,
open handles en lopende taken; één meting per minuut in `<data>/health/samples.jsonl` (twee dagen). `verdict.ts` geeft
de kleur en de redenen. `GET /api/health` (admin), `GET /api/health/history`, `ctx.services.health.snapshot()`,
`history()`, `diagnostics()`.

## Wachter buiten de app (0.4.4, P14)

Een gezondheidscontrole die ook werkt als TeamBot gecrasht is of vastzit, en geen AI-tegoed kost. Het idee komt van
Sentinel van OpenMausBot (Apache-2.0); de code is eigen werk.

- **Hartslag** (`heartbeat.ts`): de server schrijft elke minuut (en 2 s na de start, als de poort bekend is)
  `<data>/health/heartbeat.json` = `{ v, at, boot, pid, port, version, exe, notify, stopped }`, via schrijven en
  hernoemen. Bij netjes stoppen `stopped: true`. Geen sleutels, namen of inhoud.
- **Bewust gestopt** (`markStopped`, `<data>/health/stopped.json`): synchroon geschreven door de desktop-app bij
  `before-quit` (Afsluiten in het systeemvak of menu, een update, *Terug naar versie*, opnieuw starten) en bij
  `session-end` (Windows meldt af of sluit af), en door de installer in `customInit`, voordat hij TeamBot sluit (ook als
  hij het proces hard stopt; alleen als de datamap al bestaat). De volgende start (`HeartbeatWriter.start`) haalt hem
  weg. Het script telt hem alleen als hij tijdens deze run is geschreven (na `boot`) en er daarna geen hartslagen meer
  kwamen (niet ouder dan `at` − 2 min).
- **Script** (`build/watchdog.ps1`, Windows PowerShell 5.1, alleen ASCII, meegeleverd in `resources/`): leest alleen
  de hartslag en de stop-markering. Alleen een crash of een hang telt:
  - `stopped`: de hartslag zegt `stopped`, de markering geldt, of de pc is sinds de laatste hartslag opnieuw opgestart
    (`Win32_OperatingSystem.LastBootUpTime`);
  - `down`: het proces van de hartslag draait niet meer (PID plus starttijd, zodat een hergebruikte PID niet telt);
  - `ok`: `http://127.0.0.1:<port>/healthz` antwoordt, hoe oud de hartslag ook is (een pc die net wakker werd);
  - `hang`: het proces draait maar antwoordt niet, ook niet bij een tweede poging een minuut later.
  De uitkomst staat in `<data>/health/watchdog.json` (`asked`, `answer` erbij). Bij `down` of `hang` en `notify` aan
  vraagt een Windows-venster *TeamBot draait niet sinds 09:12* / *TeamBot reageert niet sinds 09:12* **Ja/Nee** voor
  opnieuw starten, **één keer per incident**: per run van TeamBot (`boot`, in `watchdog-told.txt`), wat het antwoord
  ook is. Pas na een `ok` of `stopped` kan het weer. Staat er een programma op volledig scherm, een game of een
  presentatie (`SHQueryUserNotificationState` 2, 3 of 4), dan vraagt hij niets en ook niet als gevraagd; dat komt bij
  een volgende run. Ja stopt alleen het vastgelopen proces van de hartslag (eigen PID, gecontroleerd op starttijd) en
  start `exe` opnieuw (niet als dat `node` is: een server start je zelf). Testparameters: `-NoPopup`, `-Answer
  Yes|No`, `-ConfirmSeconds`, `-BusyState`.
- **Taak** (`build/installer.nsh`): `customInstall` maakt een taak van de gebruiker zelf: `schtasks /Create /F /SC
  MINUTE /MO 10 /TN "TeamBot Wachter (<USERDOMAIN> <USERNAME>)"`, die `conhost --headless powershell … watchdog.ps1`
  draait. Geen `/RU`, `/RP` of `/RL HIGHEST` en geen taakmap (die maken kan adminrechten vragen), en de installer is per
  gebruiker (`perMachine: false`): geen adminrechten, geen UAC. De accountnaam staat in de naam omdat taaknamen voor
  iedereen op de pc gelden. Hij draait alleen als de gebruiker is ingelogd (dan kan het venster verschijnen).
  `customUnInstall` verwijdert dezelfde taak, behalve bij een update (`isUpdated`). `task.ts` (`taskName()`) vraagt
  alleen-lezen (`schtasks /Query`) of de taak er is: `on`, `missing` of `none` (niet Windows, servermodus, of
  `TEAMBOT_DATA` gezet: een ontwikkel- of testrun kijkt nooit naar de taken van de eigenaar).
- **API**: `GET /api/health` geeft er `watchdog { notify, finding, task }` bij; `PUT /api/health/watchdog { notify }`
  (eigenaar) zet de melding aan of uit (instelling `watchdogNotify`, standaard aan) en schrijft meteen een hartslag.
- **UI**: kaart **Wachter buiten de app** met wat de wachter het laatst zag en **Meld het als TeamBot niet draait of
  vastloopt**. Niet op de telefoon (het gaat over de pc).

## Tests

- `tests/watchdog.test.ts`: de hartslag (velden, `notify`, `stopped` bij afsluiten) en het echte script met een
  tijdelijke datamap: `ok` (ook met een oude hartslag), `hang`, `down`; bewust gestopt (Afsluiten, update, opnieuw
  starten, Windows afsluiten, de tekst die de installer schrijft, een herstarte pc) vraagt nooit iets, een oude
  markering telt niet, de volgende start haalt hem weg; één keer vragen per incident (Nee komt niet terug, ook niet als
  `hang` `down` wordt), niet tijdens volledig scherm, een game of een presentatie; Ja stopt alleen het eigen proces.
- `tests/installer-nsh.test.ts`: de taak van de gebruiker zelf (geen `/RU`, `/RL`, taakmap), verwijderen bij elke
  uninstall met dezelfde naam, niet bij een update; de stop-markering in `customInit`.
- `tests/e2e/care-ui.mjs`: de kaart in de browser (licht, donker) en op een gekoppelde telefoon.
- De duurtest van 48 uur (`npm run soak`) staat nog open.
