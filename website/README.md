# TeamBot-website

De productwebsite van TeamBot: statische HTML zonder framework, in het Nederlands (`/`) en het Engels (`/en/`).
Alle links tussen pagina's zijn relatief, dus `website/dist/` werkt vanaf `file://`, vanaf elk domein en vanuit een
submap. Geen cookies, geen trackers, geen lettertypen of scripts van andere servers.

## Pagina's

| Pagina | NL | EN | Wat |
|---|---|---|---|
| Home | `index.html` | `en/index.html` | Wat TeamBot is, één downloadknop en vier vinkjes; *zo werkt het* (3 kaarten), alle functies als kaarten (naar `functies.html#<id>`), *één voordeur, aparte teams* (schema), *geen stille verrassingen*, schermafbeeldingen, een blok *vergelijken* met *overstappen van OpenBot*, de prijs, veiligheid, wat nog niet kan en een slotblok. |
| Functies | `functies.html` | `en/features.html` | Elf hoofdfuncties, elk een eigen blok met wat het is, waarom het helpt, een schermafbeelding of illustratie en *zo begin je* (met een link naar de handleiding). Daarna *en verder* en *wat nog niet kan* (`#limits`). |
| Vergelijken | `vergelijking.html` | `en/comparison.html` | TeamBot naast OpenBot, Grok Bot, OpenClaw, Hermes Agent, de ChatGPT- en Claude-apps en cloudplatforms (Manus, Lindy): negen onderwerpen met een bron per cel, stand november 2026. Breed een tabel, smal een kaart per product. Ook *waar anderen verder zijn* en *waar TeamBot voor kiest*. |
| Overstappen | `overstappen.html` | `en/switching.html` | Van OpenBot naar TeamBot: wat meekomt en wat niet, de zes stappen, en Telegram/WhatsApp (één app tegelijk). |
| Prijzen | `prijzen.html` | `en/pricing.html` | TeamBot kost € 0; wat je eventueel zelf betaalt (gratis modellen, lokaal, je eigen abonnement, een API-sleutel); hoe je verrassingen voorkomt; vragen over geld. |
| Veiligheid en privacy | `privacy.html` | `en/privacy.html` | Wat op je pc blijft, wat naar welke AI-aanbieder gaat, wat verder je pc verlaat, sleutels en logins, wat bots mogen, alles verwijderen, deze website, een kwetsbaarheid melden. Dezelfde uitleg als het toestemmingsscherm van de iPhone-app. |
| Vragen | `vragen.html` | `en/faq.html` | Veelgestelde vragen per onderwerp (uitklapbaar): kosten, welke AI, je data, je telefoon zonder Tailscale, OpenBot ernaast. |
| Download | `download.html` | `en/download.html` | De installer, installeren in drie stappen (met de SmartScreen-melding), je telefoon, systeemeisen, eigen server, de SHA-256, bijwerken, nieuw in deze versie. |
| Handleiding | `handleiding.html` | `en/manual.html` | Rechtstreeks uit `docs/HANDLEIDING.md` (alleen Nederlands), met snelkoppelingen en genummerde hoofdstukken. |
| Open source | `open-source.html` | `en/open-source.html` | Licentie, meehelpen, zelf bouwen, deze website. |
| Niet gevonden | `404.html` | (zelfde pagina) | Eén pagina in beide talen; Cloudflare Pages en GitHub Pages tonen hem bij elk onbekend adres. |

Het menu bovenaan: Functies, Vergelijken, Prijzen, Veiligheid, Vragen, Handleiding en de knop Download (onder 1100 px
in het menu). *Overstappen* en *Open source* staan in de voet.

Illustraties (de gratis keten, kleuren, privacy, de browser van een bot, OpenBot → TeamBot, één kanaal per app) zijn
gewone HTML en inline SVG uit `build.mjs` (`ART`), met hun teksten onder `art` in `nl.json`/`en.json`.

## Opbouw

| Pad | Wat |
|---|---|
| `src/template.html` | Het ene sjabloon voor alle pagina's (kop, menu, voet, metatags). |
| `src/nl.json`, `src/en.json` | Alle teksten per taal, ook paginanamen en -adressen (`pages.<id>.slug`). Inline opmaak: `` `code` ``, `**vet**`, `*cursief*`, `[tekst](page:features#limits)`, `[tekst](page:home@en)` (andere taal), `[tekst](repo:LICENSE)`, `[tekst](asset:fonts/OFL.txt)` of `[tekst](https://…)`. `{version}` en `{date}` worden ingevuld. Beide bestanden moeten dezelfde opbouw hebben; de build stopt met een melding als ze verschillen. |
| `src/release.json` | Welke functies van 0.4 in deze release zitten (zie hieronder). |
| `src/shots.json` | Welke schermafbeelding in welk vak staat (zie hieronder). |
| `src/sources.json` | Bronnen van de vergelijking per rij en product, de gelezen pagina's (`_read`) en de controledatum (`_checked`). |
| `src/site.css` | De hele stijl: kleuren als variabelen bovenaan (`:root`), licht en donker, van 320 px tot breed. De build haalt commentaar en regeleinden weg. |
| `src/site.js` | Alleen de themaknop en het telefoonmenu. Geen andere scripts. |
| `src/img/` | Schermafbeeldingen (WebP), OG-afbeeldingen en het touch-icoon. Alleen wat een pagina gebruikt, komt in `dist/`. |
| `build.mjs` | Bouwt `dist/`: pagina's, 404, de handleiding (micromark), de figuurtjes uit `ui/src/lib/botface.ts`, Figtree (met de OFL-licentie), favicon, `_headers`, `robots.txt` en, met een site-adres, `sitemap.xml`. |
| `serve.mjs` | Lokale server die bij elke wijziging opnieuw bouwt. |
| `check.mjs` | Controles (zie hieronder). |
| `screenshots.mjs`, `images.mjs` | Maken de afbeeldingen in `src/img/`. |

## Functies die (nog) niet meegaan: `src/release.json`

Teksten over nieuwe functies hebben een schakelaar, zodat de site waar blijft als een functie niet op tijd klaar is.
In `release.json` staat per functie `"on": true` of `false`, met het pakket uit `docs/PLAN_0.4.md` en een korte
omschrijving. In `nl.json`/`en.json` krijgt een tekst `"if": "<functie>"`: staat die functie uit, dan laat de site
die tekst overal weg. Een tekst met `"if": "!<functie>"` verschijnt juist alleen als de functie uit staat (het
alternatief, zoals "je telefoon via de browser" zolang er geen iPhone-app is).

- Een onbekende functienaam stopt de build, dus een tikfout verbergt nooit stil een tekst.
- Een voorbeeld bekijken zonder het bestand te wijzigen: `TEAMBOT_FEATURES_OFF=teams,proof npm run website:build`
  (of `all`). PowerShell: `$env:TEAMBOT_FEATURES_OFF='teams,proof'; npm run website:build`.
- Standaard staat alles van 0.4 aan, behalve `phoneAnywhere` (je telefoon van overal zonder Tailscale; nu thuis via
  wifi of overal via Tailscale), `iphoneApp` (TestFlight is alleen voor interne testers) en `signed`
  (de Windows-installer is nog niet ondertekend: zolang die uit staat, zegt de downloadpagina wat je in het
  SmartScreen-venster aanklikt; zet hem aan zodra de gepubliceerde installer ondertekend is).
- **Vóór elke publicatie** elke schakelaar nalopen tegen `docs/STATUS.md`: alleen aan wat in de echte app getest is.

## Schermafbeeldingen: vakken in `src/shots.json`

Elk vak verwijst naar één bestand in `src/img/`; breedte en hoogte leest de build zelf, dus elke maat werkt.
Ontbreekt het bestand, dan laat de site het vak weg (`website:check` meldt dat). Wat elk vak moet laten zien, staat
in `shots.json` bij `wil`.

| Vak | Bestand | Waar |
|---|---|---|
| `hero` | `chat-desktop.webp` | Home, eerste scherm |
| `teams` | `teams-desktop.webp` | Home (rondleiding), Functies › Hoofdbot en teams |
| `tasks` | `tasks-desktop.webp` | Home (rondleiding) |
| `phone`, `phoneList` | `phone-chat.webp`, `phone-list.webp` | Home, Functies › Op je telefoon, Download |
| `memory`, `specialist`, `usage`, `channels`, `skills`, `routines`, `colours` | `*-desktop.webp` (uitsnede van het scherm) | Functies |

**Opnieuw maken:** `npm run build:ui` en daarna `npm run website:screenshots`. Het script start een tijdelijke
TeamBot op `127.0.0.1:4811` (`TEAMBOT_SHOTS_PORT` om te wijzigen; 4747 en 4748 weigert het) met een tijdelijke
`TEAMBOT_DATA`, `APPDATA`, `LOCALAPPDATA` en thuismap, dus het leest of verandert niets van deze pc en ziet geen
OpenBot. Een nep-model antwoordt; twee verzonnen teams (Webshop en Bakkerij) met een hoofdbot, taken met bewijs,
geheugen, een specialist, routines, een voorbeeld-gebruiksbalk en de kleur Lavendel maakt het via dezelfde API als de
app. Elk verzoek buiten de lokale TeamBot wordt geblokkeerd. Aan het eind staat per vak of het bestand nieuw is. Pas
daarna zo nodig de alt-teksten aan in `nl.json` en `en.json` onder `shots.<vak>.alt` (in het Engels met
"(in Dutch)") en draai `npm run website:check`.

**Niet fotograferen:** *Waar staat mijn data?* en *Overstappen* tonen de datamap en de netwerkadressen van de pc.

## Commando's

```bash
npm run website:build        # → website/dist (± 0,2 s)
npm run website:dev          # http://127.0.0.1:4800, bouwt opnieuw bij wijzigingen; Ctrl+C stopt
node website/serve.mjs --for 600 --port 4800   # stopt zelf na 600 s (handig op de achtergrond)
npm run website:check        # bouwen + alle controles; exit 1 bij een bevinding (± 1,5 minuut)
node website/check.mjs --screens <map>         # idem, en schermafbeeldingen van elke pagina in <map>
npm run website:screenshots  # nieuwe app-schermafbeeldingen, tijdelijke TeamBot op 4811 (eerst npm run build:ui; max. 4 min)
npm run website:images       # OG-afbeeldingen en touch-icoon opnieuw (max. 90 s)
```

`website:check` controleert:

- **statisch:** geldige `lang`/`hreflang`; elke interne link en elk `#anker` bestaat; geen script, stylesheet,
  lettertype of afbeelding van een andere server; geen dubbele id's; per pagina een titel, een metabeschrijving, de
  Open Graph-tags en precies één `<h1>`; afbeeldingen met `alt`, `width` en `height`; geldige JSON-LD; geen inline
  `style` (de CSP in `_headers` verbiedt die) en de hash van het inline themascript staat in die CSP; nergens
  "unlimited", "onbeperkt", "beter dan" of "better than" (behalve in de handleiding, die uit `docs/` komt);
  `_headers`, `404.html`, `robots.txt` en `.nojekyll` bestaan;
- **in Edge/Chrome:** axe-core (WCAG 2.0–2.2 A/AA + best practices) op elke pagina bij 320, 360, 390, 768, 1280 en
  1360 px in licht en donker; geen horizontaal scrollen; geen paginafouten of consolefouten; geen verzoek naar een
  andere server;
- **verder:** de site werkt vanaf `file://`, en de themaknop wisselt en onthoudt licht/donker.

Edge of Chrome moet geïnstalleerd zijn (`TEAMBOT_E2E_BROWSER=chrome|msedge`).

## Instellingen bij het bouwen

| Variabele | Standaard | Wat |
|---|---|---|
| `TEAMBOT_REPO_URL` | `https://github.com/<org>/teambot` (placeholder) | De repository. Zolang dit de placeholder is, is de downloadknop op de downloadpagina *uitgeschakeld* met de melding "komt beschikbaar zodra de releases online staan", en zijn links naar bestanden in de repo gewone tekst. De downloadknop wijst naar `<repo>/releases/latest`. |
| `TEAMBOT_SITE_URL` | leeg | Het uiteindelijke adres (`https://…`, zonder `/` aan het eind). Dan krijgt elke pagina een canonical-link, `hreflang`-links, `og:url` en een absolute `og:image`, en komen er een `sitemap.xml` en een `Sitemap:`-regel in `robots.txt`. Absolute adressen zijn zonder `.html` (`/prijzen`, `/en/pricing`). |
| `TEAMBOT_SHA256SUMS` | leeg | Pad naar de `SHA256SUMS.txt` van de gepubliceerde release. Dan toont de downloadpagina de SHA-256 van `TeamBot-Setup-<versie>.exe`. Gebruik nooit een lokaal gebouwde installer: die heeft een andere hash. |
| `TEAMBOT_FEATURES_OFF` | leeg | Functies uit `release.json` die voor deze build uit staan (`all` = alles). |

## Publiceren

Niets gaat automatisch online. Kies Cloudflare Pages of GitHub Pages; beide zijn gratis voor deze site.

**Bouwen:** `npm run website:build` · **uitvoermap:** `website/dist` · Node 22.13 of nieuwer (24 aanbevolen).

De build heeft de devDependencies van de repo nodig (`tsx`, `micromark`, `@fontsource-variable/figtree`). Op een
buildserver scheelt het veel tijd om de downloads van Electron en de Chromium van `whatsapp-web.js` over te slaan:
`ELECTRON_SKIP_BINARY_DOWNLOAD=1` en `PUPPETEER_SKIP_DOWNLOAD=1` bij `npm ci`. De eenvoudigste weg blijft lokaal bouwen
en alleen `website/dist/` uploaden: dat is gewone statische HTML.

### Cloudflare Pages (aanbevolen)

`_headers` in `dist/` zet een strikte Content-Security-Policy en cachetijden voor `/assets/*` en `/img/*`;
`404.html` wordt de foutpagina. Cloudflare stuurt `/prijzen.html` door naar `/prijzen`; de links op de site werken
allebei.

Zonder koppeling aan een repository (aanbevolen zolang de code niet openbaar is):

1. Maak in het Cloudflare-dashboard *Workers & Pages › Create › Pages › Upload assets* een project, bijvoorbeeld
   `teambot`.
2. Bouw lokaal met de echte adressen, bijvoorbeeld in PowerShell:
   `$env:TEAMBOT_SITE_URL='https://teambot.example'; $env:TEAMBOT_REPO_URL='https://github.com/<org>/teambot'; npm run website:build`
3. Upload de map `website/dist` in het dashboard, of met `npx wrangler pages deploy website/dist --project-name teambot`.

Met een gekoppelde repository: *Build command* `npm ci && npm run website:build`, *Build output directory*
`website/dist`, en de omgevingsvariabelen `NODE_VERSION=24`, `ELECTRON_SKIP_BINARY_DOWNLOAD=1`,
`PUPPETEER_SKIP_DOWNLOAD=1`, `TEAMBOT_SITE_URL` en `TEAMBOT_REPO_URL`.

**Eigen domein:** project › *Custom domains* › *Set up a custom domain*. Zet daarna `TEAMBOT_SITE_URL` op dat adres
en bouw opnieuw.

### GitHub Pages

`dist/` bevat al `.nojekyll` en `404.html`; `_headers` gebruikt GitHub Pages niet (dan geen CSP-header, de site werkt
wel). Zet onder *Settings › Pages › Source* "GitHub Actions" en voeg een workflow toe, bijvoorbeeld
`.github/workflows/website.yml`:

```yaml
name: Website
on:
  push:
    branches: [main]
    paths: ['website/**', 'docs/HANDLEIDING.md', 'ui/src/lib/botface.ts']
  workflow_dispatch:
permissions: { contents: read, pages: write, id-token: write }
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: { name: github-pages, url: '${{ steps.d.outputs.page_url }}' }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - run: npm ci
        env: { ELECTRON_SKIP_BINARY_DOWNLOAD: '1', PUPPETEER_SKIP_DOWNLOAD: '1' }
      - run: npm run website:build
        env:
          TEAMBOT_REPO_URL: https://github.com/${{ github.repository }}
          TEAMBOT_SITE_URL: https://${{ github.repository_owner }}.github.io/${{ github.event.repository.name }}
      - uses: actions/upload-pages-artifact@v3
        with: { path: website/dist }
      - id: d
        uses: actions/deploy-pages@v4
```

**Eigen domein:** *Settings › Pages › Custom domain*, en zet `TEAMBOT_SITE_URL` in de workflow op dat adres. Ook op
een projectadres zonder eigen domein (`…github.io/teambot/`) werkt alles, mits `TEAMBOT_SITE_URL` klopt: de
404-pagina gebruikt dat adres om vanaf elke diepte de opmaak te vinden.

### Eigen server

Kopieer `website/dist/` naar de webroot (bijvoorbeeld `rsync -a --delete website/dist/ server:/var/www/teambot/`).
Neem de headers uit `dist/_headers` over; daar staat ook de juiste hash voor het inline themascript. Caddy-voorbeeld:

```
teambot.example {
	root * /var/www/teambot
	try_files {path} {path}.html
	file_server
	encode zstd gzip
	handle_errors {
		rewrite * /404.html
		file_server
	}
	header /assets/* Cache-Control "public, max-age=604800"
	header /img/* Cache-Control "public, max-age=604800"
	header Content-Security-Policy "<de regel uit dist/_headers>"
}
```

## Vóór publicatie

- **Domein** kiezen (de eigenaar) en `TEAMBOT_SITE_URL` daarop zetten.
- **Repository-adres** (`TEAMBOT_REPO_URL`): pas dan werken de downloadknop en de links naar LICENSE, NOTICE,
  SECURITY.md en de changelog.
- **Schakelaars** in `src/release.json` nalopen tegen `docs/STATUS.md`.
- **Na elke release:** `TEAMBOT_SHA256SUMS`, en de beperkingen (`features.limits`) en *Nieuw in deze versie*
  (`download.notes`) in `nl.json`/`en.json` bijwerken.
- **Privacypagina:** wie de site host (serverlogs) invullen. De tekst is een **concept** en nog niet juridisch
  getoetst. Houd hem gelijk aan het toestemmingsscherm van de iPhone-app.
- **Vergelijking:** gecontroleerd op 2026-11-09 (stand november 2026), uit de onderzoeksnotities *Functies agent team
  platforms*. Bijwerken door de bronnen in `src/sources.json` opnieuw te lezen, de
  teksten aan te passen en `_checked` te verhogen. Alleen openbare feiten van de makers zelf, met bron; wat je niet
  vindt, blijft "niet gevonden".
- **Teksten:** eerlijk en kort. Geen "unlimited" of "onbeperkt", geen "beter dan" zonder gepubliceerde meting, geen
  verzonnen reviews, cijfers of functies. `website:check` houdt de eerste twee tegen.
