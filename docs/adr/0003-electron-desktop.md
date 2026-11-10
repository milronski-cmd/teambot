# ADR 0003 — Electron voor de desktop

**Status:** aangenomen (2026-11-06)

**Context.** Plan §4 noemt Electron als startkandidaat; Tauri alleen na een aparte spike.

**Besluit.** Electron 45 met `contextIsolation`, `sandbox`, geen `nodeIntegration`, minimale preload. De app blijft
in het systeemvak draaien als het venster sluit, zodat routines en kanalen doorlopen. Installer via electron-builder
(NSIS, per gebruiker). Starten-bij-inloggen is een keuze van de gebruiker in het tray-menu.

**Gevolgen.** Installer ~125 MB. Ondertekening vereist een certificaat (handmatige voorwaarde).
