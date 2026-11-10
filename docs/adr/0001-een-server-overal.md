# ADR 0001 — Eén server, overal dezelfde UI

**Status:** aangenomen (2026-11-06)

**Context.** Het plan vraagt om een Windows-desktopapp, een self-host/cloudserver en een telefoon-companion. Drie
codebases is voor een klein team onhoudbaar.

**Besluit.** Eén Node/TypeScript-server (`server/`) met de volledige logica (agents, tools, Broker, geheugen,
routines, kanalen) en één React-UI (`ui/`). Desktop = Electron die de server in-process start op 127.0.0.1
(modus `desktop`, één lokale eigenaar). Server/cloud = dezelfde server in modus `server` (meerdere gebruikers,
uitnodigingen). Telefoon = dezelfde UI als PWA (later in een native schil) die verbindt met de host.

**Gevolgen.** Elke functie werkt meteen op alle drie. De telefoon voert zelf geen agents uit (zoals in het plan:
companion). Features zijn modules (`server/modules/<id>`, `ui/src/modules/<id>`) met een vast contract
(`docs/DEVELOPING.md`), zodat ze parallel gebouwd kunnen worden.
