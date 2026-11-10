# Module `sites` — Websites publiceren

Server `server/modules/sites/` (`snapshot.ts` = wat mee mag, `server.ts` = de webserver, `index.ts` = dienst, tools,
routes), UI `ui/src/modules/sites/` (pagina **Websites** onder Instellingen › Kanalen en apps, en de goedkeuringskaart).
Tests: `tests/sites.test.ts`.

## Wat het doet

- Een bot publiceert een **map uit zijn werkmap** (of een andere map die hij mag lezen) als kleine **statische website**
  met een eigen, onraadbare link (`/s/<192-bit token>/`), geserveerd door TeamBot zelf.
- **Bereik** per site: *Alleen deze computer* (loopback), *Je netwerk* (LAN: 10/8, 172.16/12, 192.168/16, link-local,
  IPv6 ULA) of *Je tailnet* (Tailscale: 100.64/10, `fd7a:115c:a1e0::/48`). TeamBot controleert per verzoek het
  adres van de bezoeker; een publiek internetadres komt er nooit in. Dit is **geen openbare hosting**; de UI zegt dat
  en noemt voor echte publicatie een eigen account bij bijv. GitHub Pages, Netlify of Cloudflare Pages (alleen tekst).
- Optioneel **automatisch offline** na N dagen (`expires_days`); de sweeper (elke minuut) zet verlopen sites uit en
  ruimt de kopie op.
- De eigenaar beheert alles op `#/m/sites`: openen, link kopiëren, **Stoppen** (link → 404), **Opnieuw publiceren**
  (huidige inhoud van de map, zelfde link, eventueel ander bereik of verloop), **Verwijderen** (gestopte sites).

## Tools (groep `files`, dus bij elke bot met *Bestanden*; CLI-bots via de MCP-brug)

| Tool | Risico | Wat |
|---|---|---|
| `site_publish` | danger (extern) | `{ path, title?, reach?, expires_days? }`. Vraagt **altijd** toestemming — ook onder "Volledige toegang" met "verzenden en publiceren zonder vragen": dan vraagt de tool zelf. Dezelfde map opnieuw = bijwerken (zelfde link). |
| `site_list` | read | De sites van deze bot met status en link. |
| `site_unpublish` | write | Een eigen site offline halen (link, map of naam). |

**Goedkeuringskaart** (`SitePublishCard`): titel, nieuw of bijwerken, map, aantal bestanden en grootte, startpagina,
wat er niet mee gaat (verborgen, geheim, geen webbestand, snelkoppeling), wie erbij kan en via welk adres, wanneer hij
offline gaat, en wat er mis zou gaan (geen `index.html`, buiten de werkmap, Tailscale staat uit). Geen "Altijd
toestaan". De gegevens komen van `GET /api/sites/preview/:approvalId` (alleen voor de eigenaar van dat verzoek).

## Veiligheid

- **Eigen poort = eigen origin** (standaard 4760, `TEAMBOT_SITES_PORT`; de gekozen poort wordt onthouden). De API van
  TeamBot staat daar niet (`/api/...` → 404) en het token van de app (localStorage van de app-origin) is onbereikbaar.
  De server luistert alleen zolang er iets online is, en alleen op alle interfaces als een site het netwerk of tailnet
  wil (anders `127.0.0.1`; `TEAMBOT_SITES_HOST` overschrijft).
- **CSP `sandbox` zonder `allow-same-origin`** op elk antwoord: de pagina krijgt een ondoorzichtige origin, dus geen
  cookies (ook niet die van 127.0.0.1, cookies kennen geen poort), geen opslag, en verzoeken zonder inloggegevens.
  Verder `connect-src 'self' https:` (nooit `http:`, dus TeamBot op http://127.0.0.1 of een LAN-adres is
  onbereikbaar), `form-action 'self'`, `frame-ancestors 'none'`, `object-src 'none'`; plus `X-Content-Type-Options:
  nosniff`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`, `Access-Control-Allow-Origin: *` (alleen voor
  de eigen module-scripts en `fetch('data.json')` van de site; nooit met credentials). Service workers worden geweigerd.
  Gevolg voor bots: een site kan niets opslaan (`localStorage` werkt niet) — dat staat in de toolbeschrijving.
- **Snapshot**: de bestanden worden gekopieerd naar `<data>/sites/<id>/<versie>/`. Wat de bot daarna in de map
  verandert (of een snelkoppeling die later wordt geplaatst) komt pas online na opnieuw publiceren. Oude versies
  worden opgeruimd.
- **Wat mee mag**: alleen bekende webtypes (html, css, js, json, txt/md/csv/xml als tekst, svg, afbeeldingen,
  lettertypes, audio/video, pdf, zip, wasm). Nooit: namen die met `.` beginnen (`.env`, `.git`), `node_modules`,
  beschermde paden (`isProtectedPath`), namen met *secret, credential, password, wachtwoord, api-key, private-key,
  id_rsa*, en symlinks/junctions (worden niet gevolgd; bij het kopiëren nogmaals gecontroleerd met `realpath`).
- **Limieten**: 500 bestanden, 50 MB totaal, 25 MB per bestand, 12 niveaus diep — daarboven een duidelijke melding,
  nooit stil afgekapt.
- **Paden bij het serveren**: alleen `GET`/`HEAD`; elk padsegment wordt gedecodeerd en geweigerd bij `..`, `.`, een
  punt vooraan, `/`, `\`, `:` (NTFS-streams), `*?"<>|` of stuurtekens; daarna moet het pad binnen de snapshot vallen
  en een gewoon bestand zijn (`lstat`, geen symlink), met een bekend type.
- **Wie**: in servermodus kunnen alleen eigenaar en beheerders publiceren. Bot verwijderd → zijn sites gaan offline.
- **Audit**: `site.publish`, `site.republish`, `site.unpublish`, `site.expire`, `site.delete` (map, aantallen, bereik,
  verloop, door wie).

## Bekende beperkingen

- Op Windows kan de eerste site op *Je netwerk* of *Je tailnet* een firewallvraag geven (TeamBot gaat dan op alle
  interfaces luisteren); de UI zegt dat ("kies Privénetwerken").
- In Docker tonen de links het adres van de container. Publiceer de poort (`-p 4760:4760`) en gebruik het adres van de
  host; met `TEAMBOT_SITES_PORT` kies je een vaste poort.
- Geen eigen domeinnaam, geen https (de link is http op een LAN-/tailnet-adres) en geen server-side code: alleen
  statische bestanden.

## API

| Route | Wat |
|---|---|
| `GET /api/sites` | `{ sites: SiteView[], info: { port, listening, host, lan[], tailnet[], canPublish, mode } }` |
| `GET /api/sites/preview/:approvalId` | gegevens voor de goedkeuringskaart |
| `POST /api/sites/:id/republish` | `{ reach?, expires_days? }` — huidige inhoud, zelfde link |
| `POST /api/sites/:id/stop` | offline (link → 404), kopie weg |
| `DELETE /api/sites/:id` | uit de lijst (bestanden van de bot blijven) |

Event naar de UI: `sites.updated`.
