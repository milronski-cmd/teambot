# ADR 0002 — SQLite via `node:sqlite`, geen native modules

**Status:** aangenomen (2026-11-06)

**Context.** Native modules (better-sqlite3) moeten per Electron-versie en platform opnieuw gecompileerd worden; dat
breekt installers en Docker-builds vaak.

**Besluit.** Gebruik de ingebouwde `node:sqlite` (Node ≥ 22.13, Electron 45 = Node 24.22) met WAL en FTS5. Migraties
per module met unieke id's. Postgres voor een beheerde multi-tenant cloud is een latere stap (REQ CLD-04), achter
dezelfde `Store`-API.

**Gevolgen.** Geen compileerstap; getest dat FTS5 werkt in Electron. Eén databasebestand per installatie, eenvoudig
te back-uppen en te exporteren.
