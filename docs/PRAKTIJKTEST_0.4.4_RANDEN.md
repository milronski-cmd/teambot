# Praktijktest 0.4.4 — de randen

Stand: 9 november 2026, op de code van 0.4.3 (tak `worktree-agent-a96ed008d882dfc78`). TeamBot gebruikt zoals een
gewoon mens het doet: kanalen, meldingen, de telefoon, de browser en computer van de bot, de kluis, sleutels voor
scripts, apps, bestanden, spraak, back-ups, export, privacy en de eerste start van de verpakte app. Wat half of kapot
was en goed te repareren, is gerepareerd, elk met een test en een eigen commit.

**Hoe.** Een verse TeamBot met `npm run dev:server -- --mode desktop --port 4814` en de UI met Vite op 4834, met een
tijdelijke `TEAMBOT_DATA`, `APPDATA`, `LOCALAPPDATA` en gebruikersmap onder `.data/pt/` in de worktree. Een echte
browser (Edge, headless) op pc-formaat (1440×900) en als gekoppelde iPhone (402×874, aanraken, donker thema). Geen
echte accounts: Telegram, Slack en het AI-model zijn testdubbels op 127.0.0.1 (een OpenAI-compatibel nepmodel als
"Eigen endpoint"), een kleine lokale website met een inlogformulier voor de kluis, en een eigen MCP-server (stdio) voor
Apps. Nooit 4747/4748, nooit de TeamBot of AppData van de eigenaar, geen installer, geen Ollama, geen invoer op het
echte bureaublad. **Telefoon via Tailscale instellen** is niet aangeklikt (dat stelt de echte Tailscale van deze pc in)
en telefoon-toegang via het netwerk is niet aangezet (die opent poort 4815); de telefoon praat hier met poort 4814, zoals
`tests/e2e/phone-owner.mjs` het ook doet.

## Uitkomst

| | Voor | Na |
|---|---|---|
| Werkt | 29 | 39 |
| Half | 10 | 0 |
| Werkt niet | 0 | 0 |
| Niet getest (buiten de regels of zonder echt apparaat) | 4 | 4 |

Instellingen heeft nog steeds **25 rijen** (geteld op de pc; er is geen rij bijgekomen).

## Per onderdeel

Legenda: ✅ werkt · ◐ half · ✗ werkt niet · — niet getest (met reden).

| Onderdeel | Voor | Na | Bewijs | Oorzaak (bij half/kapot) |
|---|---|---|---|---|
| **Kanalen** | | | | |
| Telegram: kiezen, uitleg, token plakken | ✅ | ✅ | Kiezer met Telegram bovenaan; "Dit lijkt geen Telegram-bot-token (vorm: 123456789:ABC…)" bij een verkeerde vorm | |
| Telegram: geweigerde token herstellen | ◐ | ✅ | Voor: "Telegram weigert de bot-token … Maak een nieuwe token via @BotFather", maar nergens waar die moest; "Gegevens controleren" testte de oude token opnieuw (2 fouten). Na: knop **Nieuwe token invullen** opent het tabblad Instellingen (pc en telefoon) | Het tokenveld staat op een ander tabblad en de foutkaart wees er niet naar |
| Telegram: eigen Telegram koppelen en chatten | ✅ | ✅ | QR + deep link, `/start <code>` → "Gekoppeld!", **Verbonden** met *Ontvangen werkt* en *Versturen werkt*; een bericht kreeg antwoord van de bot in Telegram | |
| WhatsApp (QR-code) | ✅ | ✅ | Eerst **Lees dit eerst** met het blokkaderisico en een vinkje, dan het formulier; koppelen zelf vraagt echte WhatsApp (niet gedaan) | |
| WhatsApp Business | ✅ | ✅ | Uitleg (Meta, 24 uur, publieke URL); leeg opslaan: "Nog invullen: Phone number ID, Access token (permanent), App secret" | |
| Discord | ✅ | ✅ | Stappen, leeg opslaan: "Nog invullen: Bot-token"; live niet (echte Discord) | |
| Slack | ✅ | ✅ | App-manifest om te kopiëren, Socket Mode standaard | |
| E-mail: foutmelding bij een verkeerde server of poort | ◐ | ✅ | Voor: "IMAP: connect ECONNREFUSED 127.0.0.1:9". Na: "IMAP: de server weigert de verbinding op poort 9. Controleer de IMAP-server en de poort: IMAP is meestal poort 993 met TLS." | Alleen "niet gevonden" had een eigen tekst; de rest was de systeemmelding |
| Webhook | ✅ | ✅ | Gedeeld geheim wordt gemaakt, kanaal luistert | |
| **Meldingen** | | | | |
| Bel en toast bij een melding van een bot | ✅ | ✅ | `notify_user` → bel "4 ongelezen", melding met tijd en bron | |
| Browsermelding als TeamBot op de achtergrond staat; per bot "Niets" | ✅ | ✅ | Eén browsermelding; na **Niets** bij de bot geen melding, wel in de bel | |
| Meldingen dubbel met `npm run dev:ui` | ◐ | ✅ | Voor: elke melding twee keer (alleen in ontwikkelmodus). Na: één | De app startte zijn modules ook vanuit een start die al was opgeruimd (React's dubbele start); hun luisteraars bleven hangen |
| Pushmeldingen: instellingen en uitleg | ✅ | ✅ | Telefoon › Pushmeldingen: keuzes, "Goedkeuren doe je altijd zelf" | |
| Pushmelding echt ontvangen (browser, iPhone) | — | — | Headless Edge heeft geen Push API ("incognito"); een echte iPhone is nodig | |
| Windows-melding van de desktop-app | — | — | Vraagt de draaiende desktop-app met meldingen; niet in deze test | |
| **Telefoon** | | | | |
| Koppelen met de QR-code | ✅ | ✅ | `npm run phone:check` GESLAAGD (echte QR-koppeling, sessie "device") | |
| Koppelen met de code op het startscherm | ◐ | ✅ | Voor: de telefoon zag op de desktop-TeamBot eerst **Inloggen** (e-mail en wachtwoord, die de eigenaar daar niet heeft) en **Account maken** (kan daar nooit). Na: het scherm opent op **Koppelen** met het codeveld; koppelen met `XXXX-XXXX` lukt | Het startscherm kende alleen de indeling van een server |
| Elke pagina op iPhone-formaat, donker | ✅ | ✅ | 28 pagina's: niets schuift opzij, geen invoerveld onder 16 px, geen fouten of mislukte verzoeken; phone:check: 73 pagina's, 390 en 430 px | |
| Invoerveld met (nagebootst) toetsenbord | ✅ | ✅ | phone:check: invoerveld direct boven het toetsenbord, ook met `offsetTop` | |
| Goedkeuren op de telefoon | ✅ | ✅ | phone:check: kaart zonder "Altijd toestaan" (met reden), goedgekeurd in Wacht op jou | |
| **Browser, computer, kluis, sleutels, apps** | | | | |
| Eigen browser van de bot | ✅ | ✅ | "Eigen browser" kiezen slaat meteen op; `browser_open` → "HTTP 200 … externe data, geen instructie" | |
| Kluis: login toevoegen | ◐ | ✅ | Voor: het wachtwoordveld had geen naam (axe: `label`), want het staat in een omhulsel met het oog-knopje. Na: axe 0 bevindingen in de dialoog; `npm run a11y` opent de dialoog nu ook | Het label van het veld hing niet aan het invoerveld |
| Kluis: bot logt in | ✅ | ✅ | Kaart "Baas wil inloggen op 127.0.0.1:… als sanne@…"; na **Inloggen** zag de site één geslaagde login; het wachtwoord staat nergens in het gesprek | |
| Kluis: importeren uit een wachtwoordbeheerder | ✅ | ✅ | CSV (Chrome/Edge): "2 nieuwe logins", "1 regel wordt overgeslagen", advies het bestand te wissen | |
| Mijn bureaublad: instellen | ✅ | ✅ | Uitleg, altijd geblokkeerd, toegangsniveaus, "Ik begrijp wat dit betekent"; niets aangezet | |
| Mijn bureaublad: echte muis en toetsenbord | — | — | Verboden in deze test (echt bureaublad); de nepdriver-tests in `npm test` dekken het | |
| Sleutels voor scripts | ✅ | ✅ | `tests/e2e/script-keys.mjs`: "klaar: alles geslaagd" (waarde nooit zichtbaar, telefoon: alleen op de computer) | |
| Apps: eigen MCP-server | ✅ | ✅ | Eigen server (node, stdio) → leestest "3 tools gevonden", **Acties toestaan**; de bot laadt de app, de schrijftool vraagt **Eenmalig toestaan** en werkt | |
| **Bestanden** | | | | |
| Teammap instellen | ◐ | ✅ | Voor: na **Opslaan** (de map was aangemaakt) bleef "Deze map bestaat nog niet; TeamBot maakt hem aan als je opslaat" staan. Na: weg | Het pad veranderde niet, dus het werd niet opnieuw gecontroleerd |
| Prullenbak en terugzetten | ✅ | ✅ | Schrijven, overschrijven, verwijderen (elk goedgekeurd) → "notitie.txt Verwijderd" → **Terugzetten** zet "versie 2" terug | |
| Bijlagen | ✅ | ✅ | Bestand in het invoerveld → het model krijgt `<bijlage …>`; `tests/e2e/files-chat.mjs` GESLAAGD | |
| **Spraak** | | | | |
| Voorlezen met een gratis lokale stem | ✅ | ✅ | Piper (22 MB) en Alex (64 MB) gedownload; **Voorlezen** → `POST /voice/speak`, PCM-stream 200 | |
| Dicteren: downloaden van het spraakmodel | ✅ | ✅ | Microfoonknop zonder model opent "Gratis spraakherkenning op deze computer" met **Downloaden (670 MB)**; niet gedownload (groter dan 200 MB) | |
| Downloadknoppen van spraakmodellen voor een schermlezer | ◐ | ✅ | Voor: elke knop heette "Downloaden"/"Stoppen". Na: "Alex (Nederlands, man) downloaden" | Geen naam per model |
| Live praten | — | — | Wordt door anderen herbouwd | |
| **Back-ups, export, privacy** | | | | |
| Back-up maken | ✅ | ✅ | "Back-up gemaakt", 1,9 MB, met grootte vooraf | |
| "Wat zit erin, en wat niet" | ◐ | ✅ | Voor: "Overige gegevens (health)", "(local-url)", "(trash)". Na: **Prullenbak**, metingen van *Hoe gaat het met TeamBot?* bij "Niet in een back-up", het lokale adres hoort bij de installatie en gaat niet mee | Drie mappen van eigen modules stonden niet in de lijst met namen |
| Terugzetten | ◐ | ✅ | Terugzetten werkt (bot van na de back-up weg, kanalen en kluis terug, "Laatst teruggezet …"). Maar de veiligheidskopie werd gemaakt van `teambot.db` zonder zijn WAL-bestand, dat daarna werd gewist: stopte TeamBot hard (crash, stroom weg, Taakbeheer), dan waren de laatste wijzigingen weg. Nagebootst: kopie bevatte alleen "Voor"; na de reparatie ook "Na de back-up" (ook voor teamdatabases) | Kopie van alleen het hoofdbestand van een SQLite-database in WAL-modus |
| Alles exporteren | ✅ | ✅ | Instellingen › Back-ups › Exporteren: 51 kB JSON met gesprekken, **geen** token, wachtwoord of kluiswachtwoord | |
| Diagnosebestand | ✅ | ✅ | 21 kB, geen berichten, geen geheimen | |
| Wat verlaat je pc? | ✅ | ✅ | Per bot de dienst met label ("Eigen endpoint … Blijft op je pc", klopt voor 127.0.0.1), kanalen aan (3), apps, push, websites, updates | |
| Waar staat mijn data? (systeeminfo) | ◐ | ✅ | Voor: "Netwerkadressen http://192.168.…:4814 http://100.…:4814" terwijl TeamBot alleen op 127.0.0.1 luistert (daaronder: "Alleen deze computer"). Na: alleen getoond als TeamBot verder luistert (server) | De adressen werden altijd getoond |
| **Eerste start van de verpakte app** | | | | |
| Eerste start van de verpakte app | ✅ | ✅ | `npx electron-builder --win dir` naar `.data/pt/release-out` (geen installer), daarna de controle van `npm run first-launch:check` met een eigen `APPDATA`, `LOCALAPPDATA`, `TEMP` en datamap, op poort 4814 (app) en 4834 (debug) in plaats van 47913/47914: **alle controles geslaagd**, twee starts. Venster na 1,4 s met "TeamBot is geïnstalleerd … Startmenu", interface na 3,4 s, alleen 127.0.0.1, geen UDP, één keer de melding over het systeemvak bij sluiten, tweede start stil. Een eerdere poging zag een Chrome-venster en een "Ghost"-venster van andere programma's op deze pc (niet van TeamBot) en las de startpagina te laat; de herhaling was schoon. Geen item in `HKCU\…\Run` | |

## Gerepareerd (commits)

| Commit | Wat |
|---|---|
| `3fe914e` | Terugzetten: de veiligheidskopie neemt ook het WAL-bestand mee (eerst samengevoegd, anders ernaast gekopieerd); hoofd- en teamdatabases. Test: `tests/backups.test.ts` (een database met de laatste wijziging alleen in de WAL, zoals na een crash) |
| `2c24a10` | Back-ups: Prullenbak en de metingen hebben een naam, `local-url` gaat nooit mee. Test: `tests/app-backup.test.ts` |
| `b31044a` | Kanalen: knop **Nieuwe token invullen** / **Ander wachtwoord invullen** bij een geweigerde token of wachtwoord. Test: `tests/channels-health.test.ts` (Telegram 401 en Meta code 190 via nep-API's, plus e-mail, Slack, Discord en tegenvoorbeelden) |
| `39fc3d6` | Kanalen: verbindingsfouten in gewone woorden (e-mail met de poorten om te controleren, Telegram zonder internet). Test: `tests/channels-net-errors.test.ts` (echte ImapFlow- en nodemailer-fout op een dichte poort) |
| `eb05a68` | Startscherm van de desktop-app op een telefoon: eerst **Koppelen**, geen **Account maken**. Test: `tests/auth-tabs.test.ts` |
| `1c16653` | Teammap: na **Opslaan** verdwijnt "Deze map bestaat nog niet". Test: `tests/folder-name.test.ts` |
| `903e055` | Waar staat mijn data?: netwerkadressen alleen als ze te openen zijn. Test: `tests/lan-urls.test.ts` |
| `8c6dcd4` | Kluis: wachtwoordveld met naam; spraak: download- en stopknoppen met de naam van het model. Test: `npm run a11y` opent nu ook **Login toevoegen** in de kluis (zonder de reparatie: axe `label`) |
| `bd903fe` | App-start: modules starten niet vanuit een al opgeruimde start (meldingen niet meer dubbel met `npm run dev:ui`). Nagekeken in de browser: één melding in plaats van twee |

Geen kernbestanden gewijzigd behalve `server/api/backups.ts` (`applyPendingRestore`: alleen de kopie van de
veiligheidskopie, klein en additief).

## Open problemen (niet gerepareerd)

| Probleem | Oorzaak | Grootte |
|---|---|---|
| De gedeelde `node_modules` van de hoofdmap is tijdens deze test (13:47) overgezet op de MCP-SDK 2 (`@modelcontextprotocol/client`, `server`, `node`; `@modelcontextprotocol/sdk` 1.x is weg). Code van 0.4.3 vindt daardoor `@modelcontextprotocol/sdk` niet meer: de dev-server stopte met `ERR_MODULE_NOT_FOUND`. Voor deze test is SDK 1.32.2 (de versie uit `package-lock.json`) in een tijdelijke map gezet en alleen voor `server/` en `tests/` van deze worktree gekoppeld; dat is weer weggehaald | Een andere tak heeft de afhankelijkheden in de hoofdmap bijgewerkt; worktrees delen die map | Klein voor 0.4.4 zelf (komt goed als de SDK-2-overstap samenkomt), maar elke andere worktree op 0.4.3 heeft hetzelfde probleem |
| Pushmeldingen echt ontvangen (browser en iPhone) en Windows-meldingen van de desktop-app zijn niet in deze test bekeken | Headless Edge heeft geen Push API; een echte telefoon en de draaiende desktop-app zijn nodig | Klein (een live controle) |
| Kanalen met een echt account (WhatsApp QR, WhatsApp Business, Discord, Slack, e-mail) | Regel: geen echte accounts. Formulieren, foutteksten en de nep-API's werken | Middel (live ronde) |
| **Alles exporteren** is een knop in een link (`<a><Button>`), en het staat onder Back-ups terwijl Gegevens er alleen naar verwijst | Twee klikbare elementen in elkaar | Klein |
| Op de telefoon vallen de tabbladen **Logboek** en **Instellingen** van een kanaal rechts buiten beeld (ze scrollen wel) | Zes tabbladen in één rij | Klein; de nieuwe knop opent Instellingen nu vanzelf |

## Voorgestelde regels voor de CHANGELOG

- Terugzetten van een back-up: de veiligheidskopie bevat nu ook de laatste wijzigingen als TeamBot hard was gestopt (crash, stroom weg); die gingen eerder verloren.
- Kanalen: bij een geweigerde token of wachtwoord staat er meteen **Nieuwe token invullen**; verbindingsfouten van e-mail en Telegram in gewone woorden, met de poorten om te controleren.
- Telefoon: het startscherm van de desktop-app opent op **Koppelen**; **Account maken** staat er niet meer waar dat niet kan.
- Back-ups: de Prullenbak en de metingen van *Hoe gaat het met TeamBot?* hebben een naam bij "Wat zit erin"; het lokale adres gaat niet meer mee.
- Teammap: na **Opslaan** verdwijnt "Deze map bestaat nog niet".
- *Waar staat mijn data?* toont geen netwerkadressen meer die nergens openen.
- Toegankelijkheid: het wachtwoordveld in de kluis en de downloadknoppen van spraakmodellen hebben een naam.
- Ontwikkelen: met `npm run dev:ui` komen meldingen niet meer dubbel.

## Poorten van deze tak

| Poort | Uitkomst |
|---|---|
| `npm run typecheck` | schoon (server en UI) |
| `npm test` | **1326/1328** (387 s, pc druk met andere agents). Twee rood: `acp: OpenCode 1.x that only logs a model error …` ("the waiting turn is cancelled", dezelfde bekende wankele test als in de poorten van 0.4.2; los herhaald: groen) en `real dictionaries: complete …`: de 16 nieuwe Nederlandse teksten van deze tak staan in `i18n/strings.json` maar zijn nog niet vertaald (opdracht: geen `i18n:translate`). Na `npm run i18n:translate` is die weer groen |
| `phone:check`, `script-keys.mjs`, `files-chat.mjs` | geslaagd |
| eerste start (verpakte app) | alle controles geslaagd (zie boven) |
| `npm run a11y` | niet gedraaid in deze ronde (tijd); de nieuwe controle van de kluisdialoog is los met axe nagekeken: 0 bevindingen, zonder de reparatie `label` |

De 16 nieuwe teksten: *Nieuwe token invullen*, *Ander wachtwoord invullen*, de zinnen van de verbindingsfouten
(*de server weigert de verbinding*, *… op poort {0}*, *de server is niet gevonden …*, *… niet bereikbaar*, *… reageert
niet (time-out)*, *… verbrak de verbinding*, *de beveiligde verbinding (TLS) lukt niet*, *Controleer de {0}-server …*,
de twee poortzinnen voor IMAP en SMTP), *Prullenbak (bestanden die bots verwijderden of overschreven)*, *Metingen van
Hoe gaat het met TeamBot?*, *Alleen voor foutzoeken; begint na het terugzetten opnieuw.* en *Downloaden van {0} stoppen*.
