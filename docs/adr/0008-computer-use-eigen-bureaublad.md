# ADR 0008 — Computer use op het eigen bureaublad: niveaus in de tool, harde blokkades in de driver

**Status:** aangenomen (2026-11-07)

**Context.** De eigenaar gebruikt dagelijks Computer Use van OpenBot (alle bots op "Full access"). TeamBot had alleen
UI Automation per venster met een goedkeuring per klik: veilig, maar te traag voor echt werk, en het model zag zijn
eigen schermafbeelding niet. OpenBot en OpenMausBot gebruiken `cua-driver` (achtergrondinvoer, eigen cursor); Grok
Bot bedient de lokale pc niet met muis en toetsenbord. Geen van drieën heeft een blokkeerlijst voor gevoelige apps, een
noodstop-sneltoets of een stappenlog met schermbeelden.

**Besluit.**
- Eén vision-tool `desktop_computer` met de acties van Claude/OpenAI computer use (screenshot als echte afbeelding,
  klikken, slepen, scrollen, typen, toetsen, wachten, zoomen), naast de bestaande UIA-tools per venster.
- Toegangsniveau per bot: *vraag bij elke actie* (standaard), *één keer per taak* (scope: doel, apps, tijd) en
  *volledige toegang*. De beslissing zit in de tool (`gate()`), want alleen daar is bekend wat er onder het punt staat.
  Externe gevolgen (versturen, betalen, verwijderen, publiceren) vragen altijd met risico `danger`.
- Harde blokkades op elk niveau, afgedwongen in de driver vlak voor de invoer: TeamBot, Windows-beveiliging,
  wachtwoordmanagers, bank- en betaalpagina's, wachtwoordvelden. Inloggen doet de mens (`desktop_request_takeover`).
- Zichtbaarheid: indicator op het scherm (buiten schermopnames), globale noodstop-sneltoets, live beeld (ook telefoon),
  pauze zodra de eigenaar de muis beweegt, stappenlog met schermbeeld.
- Eén blijvend `powershell.exe` met eenmalig gecompileerde C# (als DLL gecachet) in plaats van een nieuw proces per
  actie; geen native Node-modules en geen extra download (past bij ADR 0002).

**Gevolgen.** Bot en eigenaar delen muis en toetsenbord (voorgrondinvoer via `SendInput`); er is geen apart of
virtueel bureaublad per bot. De herkenning van externe gevolgen is een heuristiek en kan zowel te vaak als (zelden) te
weinig vragen; de bot moet `external` invullen en de systeemprompt zegt dat. Volledige toegang is geen
beveiligingsgrens: het blijft het echte bureaublad van de eigenaar.
