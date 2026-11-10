# Module `browser` — Browser & computer

Plan: §14 (bot-computers), §21.7, §26 (platform-truth-table), §5, §25 checklist punt 6.

## Wat de module doet

- **Computermodus per bot** (`none` geen computer · `workspace` alleen werkmap · `browser` eigen browser · `host` mijn
  bureaublad · `container` privé-container · `remote` eigen server via SSH). De modus bepaalt welke toolgroepen de bot
  krijgt (bij opslaan worden `files`/`rehearsal`/`browser`/`desktop`/`container`/`remote` in `agent.tool_groups` gezet
  of weggehaald; `shell` blijft de keuze van de gebruiker, behalve bij `none`). De UI noemt een werkmap nooit een
  sandbox.
- **Eigen browser per bot**: Playwright `launchPersistentContext` met de geïnstalleerde Edge/Chrome/Chromium
  (`executablePath`-detectie, of `TEAMBOT_BROWSER_PATH`) en een eigen profielmap
  `<data>/browser/profiles/<profielId>` — nooit het profiel van de gebruiker. Headless standaard, Chromium-sandbox aan
  (`TEAMBOT_BROWSER_NO_SANDBOX=1` om uit te zetten, bijv. in Docker als root). Geen browser → eerlijke melding.
  Gedeeld profiel ("gedeelde computer") alleen via expliciete toekenning; één controller tegelijk (lease).
- **Netwerkbeleid via een eigen proxy** (`proxy.ts`): elke browserrequest (navigatie, redirect-hop, subresource,
  fetch/XHR, WebSocket, download) gaat door een lokale forward-proxy met per sessie eigen inloggegevens. Die blokkeert
  localhost/privé/link-local/CGNAT/multicast/IPv4-mapped IPv6 (SSRF) en de denylist, en verbindt met het adres dat hij
  zelf heeft opgezocht en gecontroleerd (geen DNS-rebinding). De allowlist geldt voor de hoofdpagina (vooraf gecontroleerd
  + `framenavigated`-controle na redirects). Lokale adressen alleen als eigenaar/beheerder `allow_private` aanzet.
- **Proxy per browserprofiel** (0.4.4; Computers › Browserprofielen › *Proxy…*): één profiel kan een eigen HTTP(S)-proxy
  krijgen. Chromium blijft via Playwright's `proxy`-optie aan de beleidsproxy hangen (die controleert alles eerst); de
  beleidsproxy schakelt voor die sessie door naar de proxy van het profiel in plaats van die van de eigenaar
  (`SessionOpts.upstream` → `ProxyClient.upstream`, per verzoek gevraagd, dus een wijziging geldt meteen voor nieuwe
  verbindingen). Andere profielen en de rest van TeamBot houden hun route. Alleen het adres staat in
  `browser_profiles.proxy_url`; de optionele login staat versleuteld in `secrets` als `browser-proxy:<profielId>`
  (`{ username, password }`), wordt door TeamBot zelf als `Proxy-Authorization` meegestuurd (Chromium ziet hem nooit) en
  komt nooit in de API, het logboek (`browser.profile_proxy`: alleen host en óf er een login is) of een logregel.
  Weigert de proxy de login (407), dan toont TeamBot een eigen pagina die de proxy van het profiel noemt. Een lid op een
  gedeelde server mag alleen een proxy met een openbaar adres kiezen; een gekoppelde telefoon kan hem niet instellen.
- **Pagina lezen**: `browser_snapshot` geeft een begrensd overzicht met stabiele referenties (`[e12]`, als
  `data-tbref`-attribuut), of `mode: text`. Wachtwoord-/betaal-/OTP-velden worden nooit uitgelezen. Alle pagina-inhoud
  staat in `<webinhoud>` met de waarschuwing dat het data is en geen instructie.
- **Na een actie meteen de pagina**: `browser_click`, `browser_press` en `browser_select` antwoorden met wat er gedaan
  is plus het overzicht van de pagina zoals die nu is (zoals Playwright MCP). De bot hoeft na een klik dus geen aparte
  `browser_snapshot` te doen: één modelaanroep per stap in plaats van twee. Referenties van elementen die er nog
  staan blijven gelijk.
- **Risico-indeling van acties**: klikken/typen = `write`; knoppen die (via POST of op naam: bestellen, betalen,
  versturen, publiceren, verwijderen, …) iets met impact doen worden door `browser_click`/`browser_press` geweigerd en
  moeten via `browser_submit` (`danger`, vraagt altijd). Zoekformulieren (GET) zijn gewone navigatie.
  `browser_upload` is `danger`. Toggle "elke klik eerst vragen" zet `tool_policy` op `ask` voor click/type/select/press.
- **Downloaden** (`browser_download {url | ref}`, `download.ts`): een link (ook een afbeelding of pdf op een andere
  website, waar `<a download>` door de browser genegeerd wordt) haalt TeamBot zelf op, maar via dezelfde beleidsproxy
  als de browser (elke verbinding en elke redirect-hop gecontroleerd; https via CONNECT), met de cookies van de
  bot-browser voor die site. Gestreamd naar `downloads/` met de limiet van de bot (`limits.downloadMb`; een te grote
  aangekondigde grootte wordt meteen geweigerd, een stream zonder grootte wordt bij de limiet afgebroken), time-outs
  (20 s verbinden, 30 s stilstand, 15 min totaal), voortgang in de stap ("Downloaden: 3,2 MB van 10 MB") en Stop; een
  halve download (`.deel`) blijft nooit staan. Een knop zonder adres (bestand in de pagina gemaakt) gebruikt de eigen
  download van de browser, met 30 s wachttijd en een duidelijke melding.
- **In woorden**: kaarten en de stappen zeggen "Klik op knop “Bestellen”" of "Downloaden: link “Factuur”", nooit een
  referentie als `e10`. Tools met een ref hebben een optioneel `element` (de omschrijving van de bot); de
  goedkeuringskaart toont het element ook zelf ("Op de pagina: …", gemarkeerd op de schermafbeelding).
- **Inloggen** (`browser_request_login {url?, reason?, method: auto|kluis|zelf}`): eerst de **kluis**, anders logt de
  gebruiker zelf in.
  - *Kluis* (`vault.ts`, `vault-fill.ts`): logins van de eigenaar van de bot (exacte origins, max 5; gebruikersnaam,
    wachtwoord, optioneel TOTP-sleutel als base32 of `otpauth://totp/…`). Die drie velden zijn versleuteld met de
    hoofdsleutel van de secret store (AES-256-GCM, `ctx.secrets.encrypt`) in een eigen tabel — bewust niet als rij in
    `secrets`, want die zijn op naam te gebruiken (MCP-omgevingsvariabelen, `/secrets`). Wachtwoord en TOTP-sleutel zijn
    alleen-schrijven: de API geeft `has_password`/`has_totp`. Per login kun je kiezen welke bots erom mogen vragen.
  - *Matchen*: alleen als de origin van de hoofdpagina **exact** gelijk is aan een opgeslagen origin (schema, host na
    URL/IDNA-normalisatie, poort; geen subdomeinen, geen jokertekens). Alleen als de gebruiker van het gesprek ook de
    eigenaar van de bot is.
  - *Goedkeuring*: een vraag `browser_vault_login` (“Operations wil inloggen op ads.google.com als …”, risico `danger`)
    met *Inloggen* (per account), *Altijd toestaan voor deze bot op deze site* (= beslissing `always`, dus nooit vanaf
    een gekoppelde telefoon), *Zelf inloggen* en *Weigeren*. “Altijd” wordt een `vault_grants`-rij (login + bot +
    origin); intrekken in de Kluis. Een andere origin of gebruikersnaam wist de grants van die login.
  - *Invullen door TeamBot*: vlak voor het invullen wordt de origin opnieuw gecontroleerd, en daarna op elk
    element-handle (een handle hoort bij één document, dus na een navigatie mislukt het invullen in plaats van op een
    andere site te landen). Alleen het hoofdframe; alleen inlogformulieren (één wachtwoordveld; registratie- en
    wachtwoord-wijzigen-formulieren niet); stappen gebruikersnaam → wachtwoord → TOTP-code (wacht op een nieuw
    tijdvenster als de code bijna verloopt); klikt de inlogknop of drukt Enter. Gevulde velden krijgen
    `data-tbvault-filled`: gemaskeerd in elke schermafbeelding/geschiedenisframe, verborgen in `browser_snapshot`
    (“ingevuld door de kluis van TeamBot, verborgen”), en `browser_type` weigert ze. Tijdens het invullen stuurt de
    live stream geen frames (`session.privacy`; daarna één gemaskeerd frame). Bij mislukken worden de velden weer
    leeggemaakt. Zet een site het wachtwoord in de URL (GET-formulier), dan stopt TeamBot. Alle vaultwaarden (ook
    URL-/formulier-gecodeerd en de TOTP-codes) worden voor de rest van de sessie uit elk browser-toolresultaat en elke
    gelogde URL gehaald (`session.scrub`).
  - *Wat de bot krijgt*: alleen “Ingelogd op …” (zeker als de pagina naar een ander adres ging, anders met het advies
    het te controleren) of “Mislukt: … (vaste reden)”: geweigerd, geen formulier, registratieformulier, code
    geweigerd, niets gebeurd (captcha), adres veranderd, time-out. Playwright-foutmeldingen (die een waarde kunnen
    herhalen) komen nooit naar buiten. Vraagt de site nog een code en is er geen TOTP-sleutel, dan volgt het
    handmatige stuk (“vul de code zelf in”). Via een grant mislukt → melding aan de eigenaar.
  - *Importeren* (`vault-import.ts`): CSV-export van Bitwarden (ook organisatie-export), 1Password (Title/Url/OTPAuth
    en oudere Website/One-time password), Chrome en Edge (`name,url,username,password[,note]`), Firefox en elke CSV met
    een kolom voor website en wachtwoord. Herkenning op de kopregel; RFC 4180 (aanhalingstekens, komma's/regeleinden
    in velden, `""`), BOM, CRLF/LF/CR, puntkomma/tab (Excel). Max. 2 MB en 2000 rijen. De UI leest het bestand en
    stuurt de tekst één keer mee (`POST /computers/vault/import/preview {csv}`); de server parseert in het geheugen,
    versleutelt gebruikersnaam/wachtwoord/TOTP meteen en houdt alleen een voorvertoning (`vi_…`, één per gebruiker,
    15 min, eenmalig) in het geheugen — niets op schijf. Voorvertoning: naam, adressen, gebruikersnaam, `has_totp`,
    `status` new/duplicate/skip met vaste reden (staat al in de kluis = zelfde origin + gebruikersnaam, twee keer in
    het bestand, geen login, alleen een app, geen bruikbaar webadres, geen wachtwoord, wachtwoord te lang). Een
    ongeldige of Steam-2FA-sleutel → import zonder TOTP met opmerking. `POST /computers/vault/import {handle, rows}`
    → `{imported, skipped: [{line, label, reason}]}` (ook "niet gekozen" en "kluis vol"). Geïmporteerde logins: alle
    bots mogen erom vragen. Foutmeldingen herhalen nooit een cel uit het bestand.
  - *Zelf inloggen*: de bot pauzeert (lease naar de gebruiker), in de desktop-app opent een zichtbaar venster met
    hetzelfde profiel (anders het browserpaneel) en de vraag heeft “Klaar”. Menselijke invoer wordt niet gelogd.
- **Browserpaneel en live meekijken**: MJPEG-stream (`/stream`, CDP-screencast, max ~5 fps, alleen als iemand kijkt),
  losse frames, en per bot-actie een geschiedenisframe (laatste 80) voor terugkijken. Het paneel naast de chat toont
  tabbladen (met titel), een adresbalk die de bot live volgt (status-event bij elke navigatie, gedebounced), terug /
  vooruit / herladen, “Neem over” (klikken/typen in het beeld, typveld voor de telefoon), “Geef terug”, “Pauzeer”, en
  een menu met beeld-in-beeld, “Open als venster” (desktop-app, eigenaar), “Uitloggen bij <site>”, “Profiel wissen”,
  de Kluis, “Browser sluiten” en “Noodstop”. De eigenaar kan de browser ook zelf starten (bijv. om alvast in te loggen).
- **Profielen**: elke bot een eigen blijvend profiel; een profiel kan gedeeld worden met gekozen bots (een eigen
  profiel wordt dan een gedeeld profiel en de oorspronkelijke bot houdt het; bots die je uitvinkt krijgen weer een
  eigen profiel). “Uitloggen bij een site” wist de cookies (`clearCookies` op domein) en de sitegegevens
  (`Storage.clearDataForOrigin`) van die site; “Profiel wissen” verwijdert de hele profielmap (overal uitgelogd).
- **Control-lease** (`lease.ts`): één controller per resource (`browser:<profiel>`, `desktop:host`,
  `container:<bot>`). Bots wachten FIFO; een mens kan een bot onderbreken (de bot krijgt de lease daarna terug). Een
  lease verloopt pas na de TTL **en** als de houder echt weg is (run niet meer actief / geen hartslag of venster meer).
- **Mijn bureaublad** (Windows): standaard uit; alleen de eigenaar, met bevestiging (`confirmHost`), per bot een
  app-allowlist. Twee manieren van werken, met dezelfde regels:
  - *Computer use met beeld* (`desktop_computer`, `screen.ts`, `screen.ps1.ts`, `screen-policy.ts`): schermafbeelding
    van een heel beeldscherm als **echte afbeelding voor het model** (geschaald tot lange zijde ≤ 1280 en ≤ 1,2 MP,
    nooit vergroot; per-monitor DPI v2; meerdere schermen incl. negatieve coördinaten; coördinaten zijn pixels in die
    afbeelding en worden deterministisch per monitor teruggerekend), plus acties `left_click`, `double_click`,
    `triple_click`, `right_click`, `middle_click`, `mouse_move`, `left_click_drag`, `scroll`, `type`, `key`
    (reeksen en aliassen zoals `Return`, `Page_Down`), `wait`, `cursor_position` en `zoom` (regio scherper lezen).
    Na elke actie volgt een nieuwe schermafbeelding. `screenshot` met `elements: true` voegt de UI Automation-elementen
    van het actieve venster toe (type, naam, middelpunt en grootte in schermafbeeldingpixels). `desktop_launch` start
    een toegestane app op naam (App Paths, anders het Startmenu). Eén blijvend `powershell.exe` (C# één keer gecompileerd
    en als DLL gecachet, JSON-regels via stdin/stdout, alleen ASCII) — schermafbeelding ±0,1 s, probe ±10 ms,
    herstart ±0,3 s.
    Dezelfde hulp draait (in een eigen proces) ook voor *Bureaublad op afstand* van de eigenaar
    (`docs/modules/remote-desktop.md`): met `policy.owner` mogen daar Alt+Tab, Alt+F4, de Windows-toets en
    wachtwoordvelden en spreken de meldingen de eigenaar aan; de harde blokkade (TeamBot zelf, beveiligingsvensters)
    blijft ook dan.
  - *Per venster via UI Automation* (`desktop_windows`, `desktop_inspect`, `desktop_screenshot`, `desktop_click`,
    `desktop_type`, `desktop_key`, `host.ps1.ts`): referenties naar elementen in één toegestaan venster.
  - **Toegangsniveau per bot** (`host_level`): `every` *Vraag bij elke actie* (standaard; voorbeeld met het doel rood
    gemarkeerd), `task` *Vraag één keer per taak* (één goedkeuring met doel, apps en maximale tijd, standaard 30 min;
    automatisch bij de eerste actie of via `desktop_request_access`; geldt per gesprek, max. 500 acties, intrekbaar),
    `auto` *Volledige toegang* (zoals OpenBot "Full access": geen vraag per actie binnen de toegestane apps).
    "Altijd toestaan" bij één actie = de rest van deze taak (tijdgebonden), nooit een blijvende toestemming.
    Optioneel scope *alle apps* (`host_options.allApps`, eigenaar + `confirmAllApps`). Is de bot zelf op "Vragen"
    ingesteld, dan vraagt de runner per tool-aanroep; dan wordt niet dubbel gevraagd.
  - **Altijd geblokkeerd, op elk niveau**: TeamBot zelf, UAC/credential/lock-schermen, Windows-beveiliging,
    wachtwoordmanagers en authenticators, crypto-wallets, en vensters waarvan de titel op bankieren, betalen/afrekenen,
    wachtwoordbeheer of inlogprompts wijst (vaste lijst + eigen woorden). Typen in een wachtwoordveld (UIA `IsPassword`
    of klassiek `ES_PASSWORD`) en tekst-/plaktoetsen in zo'n veld worden geweigerd. Windows-toets, Alt+Tab/F4/Esc,
    Ctrl+Esc, Ctrl+Alt+Del/End, Ctrl+Shift+Esc en Print Screen zijn verboden. Inloggen, codes, betalen:
    `desktop_request_takeover` (de bot pauzeert, de eigenaar doet het, "Klaar" geeft terug).
  - **Externe gevolgen vragen altijd** (risico `danger`, ook bij volledige toegang en binnen een taakscope): knoppen
    als Verzenden/Betalen/Verwijderen/Publiceren, "Ja/OK" in een dialoog die verwijderen/versturen bevestigt,
    Ctrl/Alt+Enter, Alt+S, Shift+Delete, Delete in Verkenner, Enter of een nieuwe regel in berichtenapps (WhatsApp,
    Teams, Slack, Outlook, …), en alles waarbij de bot zelf `external` invult.
  - **Wat de bot ziet**: standaard alleen de toegestane apps; de driver schildert in z-volgorde alle andere vensters
    donker vóór het beeld het proces verlaat, en geeft van verborgen vensters geen titels terug. Optie *hele scherm*
    (geblokkeerde vensters blijven donker). Wachtwoordvelden in het actieve venster worden zwart gemaakt.
  - **Vlak voor elke invoer** controleert de driver zelf opnieuw: venster onder het punt (of het actieve venster bij
    toetsen) toegestaan, niet geblokkeerd, en nog hetzelfde venster (handle + proces-id) als bij de controle en de
    goedkeuring; anders "het scherm is veranderd". Klik-door-overlays (zoals de TeamBot-indicator) tellen niet mee.
  - **Zichtbaarheid en controle**: in de desktop-app een altijd-bovenop rand + label op het scherm waarop de bot werkt
    (klik-door, nooit focus, buiten schermopnames gehouden), globale noodstop **Ctrl+Alt+Esc** (terugval
    Ctrl+Alt+Shift+S, Ctrl+Alt+F12), noodstop in het systeemvak, de app en op de telefoon. De noodstop doodt de
    schermhulp midden in een actie, stopt de betrokken runs en pauzeert tot *Hervat*. **Beweegt de eigenaar de muis**
    terwijl de bot bezig is, dan krijgt de eigenaar de bediening en wacht de bot (uit te zetten). *Neem over* / *Geef
    terug*, live beeld (MJPEG, 1 fps, hetzelfde gemaskeerde beeld als de bot ziet) in het Computer-paneel en op de
    telefoon, stappenlog met schermbeeld per actie, max. 60 acties per minuut (instelbaar).
- **Privé-container**: Docker-CLI (`container.ts`), werkmap als enige mount, `--cap-drop ALL`, `no-new-privileges`,
  geheugen/CPU/pids-limiet, netwerk standaard `none`. Alleen als Docker draait; anders weigert de API de modus en
  falen tools gesloten — er is nooit een terugval naar de host.
- **Eigen server (SSH)** (`remote.ts`, `remote-tools.ts`, CMP-07): de bot werkt op een eigen VPS/thuisserver
  (Linux/macOS, POSIX-loginshell) in één map, standaard `teambot/<botId>` in de thuismap van de SSH-gebruiker.
  SSH-client is `ssh2` (MIT, pure JavaScript; de optionele native bouwstappen staan uit). Alleen de eigenaar van de bot
  stelt hem in (`own()` op elke route).
  - *Inloggegevens*: privésleutel (OpenSSH/PEM, zonder wachtwoordzin) of wachtwoord gaat één keer naar
    `PUT .../remote/credential`, wordt gecontroleerd (`utils.parseKey`, publieke/versleutelde sleutels geweigerd) en
    versleuteld opgeslagen als secret `remote-ssh:<botId>` van de eigenaar van de bot. De config bewaart alleen die
    naam; het antwoord bevat alleen naam + `has_secret`. Alleen exact die naam van exact die gebruiker wordt ooit
    gelezen. Bij verwijderen van de bot wordt het secret gewist.
  - *Serversleutel (TOFU, expliciet)*: zonder vastgezette vingerafdruk haalt `POST .../remote/test` alleen de
    host-key op (de handshake stopt na de sleuteluitwisseling; er wordt niet ingelogd, dus geen wachtwoord of
    handtekening naar een onbekende server). De gebruiker vergelijkt de `SHA256:`-vingerafdruk en klikt *Vertrouwen*
    (`PUT .../remote/trust`). Elke latere verbinding controleert de sleutel in `hostVerifier` vóór het inloggen en
    faalt gesloten bij een andere sleutel (melding "mogelijk man-in-the-middle of herinstallatie", audit
    `remote.hostkey_mismatch`, notificatie). Ander adres of andere poort ⇒ vingerafdruk vergeten. Na vertrouwen meldt
    de test `uname -sm` en of Docker bruikbaar is; Windows (cmd/PowerShell) of een niet-POSIX-loginshell (fish, csh)
    wordt geweigerd via een quoting-probe (`echo 'tb-posix' "$((1+1))"` moet `tb-posix 2` geven).
  - *Netwerkbeleid*: beperkte leden (`isRestricted`: servermodus, rol member) mogen alleen openbare adressen:
    localhost/`.local`/privé/loopback/link-local/CGNAT/metadata worden geweigerd (`isPrivateAddress` +
    `isPrivateIp`), bij opslaan én bij elke verbinding. TeamBot verbindt met het IP dat het zelf heeft opgezocht en
    gecontroleerd, nooit opnieuw met de naam (geen DNS-rebinding). Eigenaar/beheerder en desktopmodus mogen privé-
    adressen (thuisserver).
  - *Uitvoeren*: alles via exec-kanalen met een eigen `sh`-script; elke waarde gaat door `shq` (POSIX single-quote) en
    de opdracht van de bot komt als `$1` binnen (`sh -c '<script>' tb '<opdracht>'`), dus wordt nooit opnieuw
    geparsed. Opdrachten draaien met `bash` (anders `sh`) en stdin `/dev/null`. Geen pty, geen env-variabelen, geen
    agent forwarding, geen ssh-agent of `~/.ssh`-bestanden: er gaat niets van TeamBots omgeving naar de server.
    Optioneel in Docker op de server: `docker run --rm -i --name teambot-<bot>-<rnd> --network none --cap-drop ALL
    --security-opt no-new-privileges --memory --cpus --pids-limit 512 --user "$(id -u):$(id -g)" -v <map>:/workspace
    -w /workspace <image>` (bij stoppen ook `docker kill`).
  - *Bestanden*: paden relatief aan de map; absolute paden, `~`, stationsletters en `..` worden in TeamBot geweigerd
    (vóór er verbinding is). Het script loopt de map stap voor stap af en weigert elke symbolische link onderweg en als
    doel, zodat ook een link die in een container is gemaakt niet naar buiten leidt. Lezen/lijst zijn begrensd door de
    uitvoerlimiet, up/download door de bestandslimiet; download schrijft eerst een `.part` en controleert de grootte;
    het lokale pad gaat door `resolveInWorkspace`.
  - *Limieten en stoppen*: per opdracht een tijdslimiet (standaard 120 s, max 3600) en uitvoerlimiet (standaard
    64 kB; begin en eind blijven bewaard). Bij time-out of als de run stopt (abort-signal, noodstop) krijgt de
    procesgroep `SIGKILL` via het SSH-`signal`-verzoek en sluit het kanaal; de tool antwoordt binnen enkele seconden.
  - *Verbindingen*: één SSH-verbinding per bot (pool), hergebruikt tussen tool-aanroepen, gesloten na 60 s zonder
    gebruik, bij een configwijziging, noodstop, verwijderen van de bot en het stoppen van de module. Eén run tegelijk
    per bot bedient de server (lease `remote:<botId>`).
  - *Geheimhouding*: de sleutel/het wachtwoord komt niet in het model, events, logs, audit, exports of botsjablonen
    (staat in `secrets`, niet in `agent.settings`). Foutmeldingen worden vertaald en geschoond (`friendlySshError`,
    `scrub`); toevallig door de server geprinte waarden worden in tool-uitvoer, voortgang en actielog vervangen door
    `[verborgen]`. Uitvoer van de server staat in `<serveruitvoer>` met de waarschuwing dat het data is.
- **Cloud-VM** (`cloudvm/`, CMP-07 deel 2 en 3): binnen *Eigen server (SSH)* kan TeamBot zelf een VM per bot aanmaken
  bij een cloudprovider en de bot daar via de SSH-modus op laten werken — **zonder trust-on-first-use**.
  - *Adapter* (`provider.ts`): `check`, `options` (locaties, servertypes met prijzen per locatie en eventueel een
    GPU-groep, systeemimages, IPv4-prijs, of prijzen incl. btw zijn, voorkeuren), `createServer` (met `user_data`),
    `getServer` (null = weg), `findCreated` (na een weggevallen antwoord), `powerOn`, `shutdown`, `powerOff`,
    `deleteServer`. Alle verzoeken via `cloudRequest`: token alleen in de header, geen redirects, 30 s time-out,
    429 met `Retry-After`/`RateLimit-Reset` — korte wachttijden ≤ 10 s worden zelf afgewacht, anders "probeer het over
    N seconden opnieuw". Pagina's worden op nummer opgevraagd; een `next`-URL uit een antwoord wordt nooit gevolgd (de
    token gaat alleen naar de eigen API-host). Elke adapter vertaalt fouten naar een Nederlandse `CloudApiError` en
    stuurt nooit provider-SSH-sleutels mee (die zouden root-toegang geven).
  - *Providers*:

    | | Hetzner Cloud (`hetzner.ts`) | DigitalOcean (`digitalocean.ts`) |
    |---|---|---|
    | API | REST v1 `api.hetzner.cloud/v1` | v2 `api.digitalocean.com/v2` (droplets) |
    | Token | Console › project › Beveiliging › API-tokens (lezen + schrijven) | API › Tokens: Full Access, of account:read, droplet:create/read/update/delete, image:read, regions:read, sizes:read, tag:create/read |
    | Prijzen | EUR, **incl.** btw, uit `server_types` + IPv4 apart uit `/pricing` | USD, **excl.** btw/belasting (`price_monthly`/`price_hourly` van `/sizes`), IPv4 inbegrepen |
    | Types | standaard (geen GPU), zonder verouderde types | standaard + groep **GPU** (sizes met `gpu_info`): duur, per uur, alleen in sommige regio's, vaak pas na goedkeuring door DigitalOcean; het gewone Ubuntu-image heeft geen NVIDIA-stuurprogramma's |
    | Standaard | `nbg1`/`fsn1`/`hel1`, `cx22`, `ubuntu-24.04` | `ams3`/`fra1`/`lon1`, `s-1vcpu-2gb`, `ubuntu-24-04-x64` (nooit een GPU) |
    | Aan/uit | `actions/poweron`, `shutdown`, `poweroff` | `actions {type: power_on, shutdown, power_off}` |
    | Kwijt antwoord terugvinden | unieke servernaam | unieke tag `teambot-vm-<vmId>` (namen zijn niet uniek) |
    | Zonder SSH-sleutels | API geeft een root-wachtwoord terug (genegeerd) | DigitalOcean mailt een root-wachtwoord |
    | Extra | — | `with_droplet_agent: false` (geen webconsole-agent die inlogsleutels kan plaatsen) |
    | Metadata-dienst | `169.254.169.254/hetzner/v1/userdata` | `169.254.169.254/metadata/v1/user-data` |
    | Bekende foutcodes | 401, 403 (alleen lezen / `resource_limit_exceeded`), 412/`placement_error`, 429, 5xx | 401, 403, 422 (droplet-limiet, GPU niet vrijgegeven, type/regio niet beschikbaar), 429, 5xx |

    In beide gevallen vergrendelt de cloud-init root en zet wachtwoord-inloggen uit, dus een root-wachtwoord van de
    provider werkt niet (ook niet op de console). De cloud-init is voor beide hetzelfde; de keys die we gebruiken
    (`ssh_keys`, `ssh_deletekeys`, `ssh_genkeytypes`, `users`, `write_files`, `runcmd`, `packages`) zijn algemene
    cloud-init-modules die de Ubuntu/Debian-images van beide providers hebben. Onze sshd-drop-in heet
    `10-teambot.conf` en gaat daardoor vóór `50-cloud-init.conf` (bij sshd geldt de eerste waarde).
  - *Token*: per gebruiker per provider als secret `cloud-token:<provider>` (dus Hetzner en DigitalOcean apart), eerst
    gecontroleerd bij de provider; nooit in antwoorden, events, audit, logs of exports. Geldt voor alle bots van die
    gebruiker.
  - *cloud-init* (`cloudinit.ts`): TeamBot maakt twee verse ed25519-sleutelparen (elk sleutelpaar wordt teruggelezen en
    opnieuw gemaakt als de generator van `ssh2` een onleesbare sleutel geeft). De **hostsleutel** gaat via
    `ssh_keys.ed25519_private/ed25519_public` + `ssh_deletekeys: true` + `ssh_genkeytypes: []` naar de VM, dus de VM
    heeft geen andere hostsleutels; TeamBot bewaart alleen de vingerafdruk. Gebruiker `teambot` (geen sudo,
    wachtwoord vergrendeld) met als enige `authorized_key` de nieuwe **clientsleutel**; root vergrendeld,
    `ssh_pwauth: false`, sshd-drop-in `PasswordAuthentication no`, `KbdInteractiveAuthentication no`,
    `PermitRootLogin no`, `AllowUsers teambot`. Optioneel Docker (`docker.io`, `teambot` in de groep `docker`).
    In de user data staat verder niets: geen API-token, geen clientsleutel, geen TeamBot-instellingen.
  - *Hostsleutel in user data*: die moet erin. Ze blijft bij de provider opvraagbaar via de metadata-dienst
    (`169.254.169.254`, alleen vanaf de VM zelf). TeamBot blokkeert die dienst met iptables voor de gebruiker
    `teambot` (dus ook voor de bot) en wist na de eerste start de lokale kopieën (`/var/lib/cloud/instance*/user-data*`,
    `cloud-config.txt`, `obj.pkl`, `/run/cloud-init/instance-data-sensitive.json`), direct en nog eens na 120 s.
  - *Levensloop* (`cloud_vms`): `creating` (provider maakt aan) → `booting` (draait, openbaar IPv4 bekend; wacht op
    SSH mét de vastgezette sleutel en `cloud-init status --wait`) → `running`. Pas dan wordt de remote-config van de bot
    gezet: modus `remote`, adres = VM-IP, gebruiker `teambot`, de clientsleutel als `remote-ssh:<botId>`, vingerafdruk
    al vastgezet. De tools werken direct; er is geen *Vertrouwen*-stap. Geeft de VM een andere sleutel, dan volgt
    `error` (fail closed, audit). Uitzetten = ACPI-shutdown (na 90 s hard uit), aanzetten = power-on + opnieuw de
    SSH-controle, verwijderen = alleen met de getypte VM-naam; daarna wijst de bot niet meer naar dat IP en worden
    sleutel en config opgeruimd. Een VM die buiten TeamBot om verdwijnt, wordt opgemerkt (periodieke controle, ±5 min)
    en gemeld. Valt het antwoord op het aanmaken weg (time-out, 5xx), dan zoekt TeamBot de server op zijn unieke naam
    (Hetzner) of tag (DigitalOcean) op, zodat een VM die toch is gemaakt niet onzichtbaar geld kost. Adres, poort,
    gebruiker, sleutel en vingerafdruk van een beheerde VM zijn niet met de hand te wijzigen (409); limieten wel.
  - *Kosten*: vóór het aanmaken toont de UI de maandprijs uit de API (Hetzner: server + IPv4, incl. btw; DigitalOcean:
    incl. IPv4, excl. btw — dat staat er dan bij) en bij een GPU-type een aparte waarschuwing; de server weigert
    aanmaken tenzij `confirmCost` gelijk is aan de actuele schatting. De kosten zijn van de gebruiker zelf (eigen token,
    eigen factuur) en tellen **niet** mee voor het dagbudget van de LLM-aanroepen. Beide providers rekenen tot
    verwijderen, ook als de VM uit staat; dat staat bij elke knop. De pagina Computers telt per valuta op.
  - *Bot verwijderen*: de VM wordt nooit stil mee verwijderd. De bot-editor vraagt expliciet: behouden of ook
    verwijderen (getypte naam). De server zelf ontkoppelt de VM bij het verwijderen van de bot, bewaart hem en stuurt
    een melding; de pagina Computers toont alle VM's die nog bestaan, ook die van verwijderde bots, met het
    maandtotaal.
  - *Leden*: op een gedeelde server alleen als de eigenaar of een beheerder `allowCloudVm` aanzet in het ledenbeleid
    (standaard uit), en dan met hun eigen token en kosten. Een VM-adres dat niet openbaar is wordt altijd geweigerd
    (alleen `TEAMBOT_CLOUDVM_DEV=1` of de testinjectie staat 127.0.0.1 toe; met die vlag mag ook
    `TEAMBOT_HETZNER_API_URL` naar een nep-API wijzen).
- **Capability-detectie** (`capabilities.ts`, gecachet 10 min): Windows-editie (register), Hyper-V (Home → "niet
  mogelijk", anders `sc query vmms`), Windows Sandbox, WSL (eerst `sc query WslService/LxssManager`; de installatie-stub
  wordt nooit gestart), Docker (`docker version`), browsers, host-bediening, zichtbaar venster. Alles met time-outs;
  fout/time-out = niet beschikbaar. De UI toont de truth table en per modus wat ontbreekt.
- **Repetitie (rehearsal)**: `rehearsal_start` kopieert de werkmap (zonder `node_modules`, `.git`, `dist`, … en
  bestanden > 10 MB; max 500 MB/20.000 bestanden) en zet `agent.workspace` tijdelijk op de kopie, zodat bestands-,
  shell- en CLI-tools daar werken. Diff per bestand (eigen Myers-diff), toepassen per bestand met conflictcontrole
  (heeft de gebruiker het origineel intussen veranderd → overslaan tenzij "toch overschrijven"), verwerpen per bestand,
  afronden. Voor toepassen wordt automatisch een (gedeeltelijke) snapshot gemaakt → undo.
- **Snapshots**: kopie van de echte werkmap (zelfde uitsluitingen), herstel met voorbeeld (overschrijven / terugzetten /
  later gemaakt). Later gemaakte bestanden blijven staan tenzij expliciet gekozen; vóór herstel altijd een automatische
  snapshot. Quota: 20 eigen snapshots per bot, 10 automatische (oudste automatische worden opgeruimd), 2 GB per gebruiker.

## Tools (groep · risico)

| Tool | Groep | Risico |
|---|---|---|
| browser_open, browser_navigate, browser_back, browser_snapshot, browser_screenshot, browser_tabs, browser_wait, browser_close, browser_request_login | browser | read |
| browser_click, browser_type, browser_select, browser_press, browser_scroll, browser_download | browser | write |
| browser_submit, browser_upload | browser | danger |
| desktop_windows, desktop_inspect, desktop_screenshot, desktop_request_access, desktop_request_takeover | desktop | read |
| desktop_computer, desktop_launch, desktop_click, desktop_type, desktop_key | desktop | write (invoer daarbinnen per toegangsniveau; externe gevolgen `danger`) |
| rehearsal_start, workspace_snapshot | rehearsal | write |
| rehearsal_status, rehearsal_finish, workspace_snapshots | rehearsal | read |
| computer_exec | container | exec |
| remote_exec | remote | exec |
| remote_read_file, remote_list | remote | read |
| remote_write_file, remote_upload, remote_download | remote | write |

Toepassen/verwerpen van een repetitie en herstellen van een snapshot kan alleen de mens (API/UI), niet de bot.
`remote_upload` gaat van de lokale werkmap naar de map op de server, `remote_download` andersom (standaard naar
`downloads/<naam>`). Alle `remote_*`-tools falen gesloten zolang de modus niet `remote` is, er geen adres/gebruiker of
inloggegevens zijn, of de serversleutel niet vertrouwd is.

## API (alles onder `/api`, alleen eigen bots/data)

- `GET /computers/capabilities` — truth table + modi (`?refresh=1`); paden alleen voor eigenaar/beheerder.
- `GET /computers` · `GET /computers/:agentId` · `PUT /computers/:agentId/config`
- `GET /computers/:agentId/actions` · `GET /computers/:agentId/actions/:id/frame`
- `GET /computers/:agentId/stream` (MJPEG) · `GET /computers/:agentId/frame.jpg` · `GET /computers/:agentId/element?ref=`
- `POST /computers/:agentId/takeover {visible?, pause?, target?}` · `/release` · `/heartbeat` · `/input` · `/stop` ·
  `/resume-host` · `/browser/close`. `/input {type}`: `click {x,y}` (0..1), `type {text}`, `key {key}`, `scroll {dy}`,
  `navigate {url}`, `back`, `forward`, `reload`, `tab {index}` — alleen met de bediening (409 anders).
- `POST /computers/:agentId/browser/start {url?}` (eigenaar start de browser zelf) ·
  `POST /computers/:agentId/browser/logout-site {site}`
- Kluis (niet voor gekoppelde telefoons): `GET|POST /computers/vault` · `PUT|DELETE /computers/vault/:id` ·
  `DELETE /computers/vault/:id/grants/:agentId?origin=`. Invoer `{label, origins (regels of lijst), username,
  password, totp (base32/otpauth, `null` = weg), agent_ids}`; antwoord zonder wachtwoord en TOTP-sleutel.
  Import: `POST /computers/vault/import/preview {csv}` → `{handle, format {id, label}, expires_at, room, rows}` ·
  `POST /computers/vault/import {handle, rows: [index]}` → `{imported, skipped}`.
- Een gekoppelde telefoon mag het browserblad gebruiken (`MOBILE_BROWSER_ROUTES`: status, stream, frame, takeover,
  release, heartbeat, input), maar geen zichtbaar venster openen (403) en geen kluis of profielen beheren.
- `GET|POST /computers/:agentId/rehearsal` · `GET /computers/:agentId/rehearsal/compare`
- `GET /computers/rehearsals/:id` · `GET .../diff?path=` · `POST .../apply {files?, force?}` · `.../revert {files}` ·
  `.../end {discard?}`
- `GET|POST /computers/:agentId/snapshots` · `GET /computers/snapshots/:id/preview` · `POST .../restore {deleteExtra?}` ·
  `DELETE /computers/snapshots/:id`
- `GET|POST /computers/profiles` · `POST /computers/profiles/:id/wipe` · `DELETE /computers/profiles/:id` ·
  `PUT /computers/profiles/:id/members {agent_ids}` (delen) · `GET /computers/profiles/:id/sites` (sites met cookies;
  start de browser zo nodig headless) · `POST /computers/profiles/:id/logout {site}` ·
  `PUT /computers/profiles/:id/proxy {url, username?, password?, clear_login?}` (`url` '' = geen eigen proxy; lege
  login-velden houden de opgeslagen login) · `POST /computers/profiles/:id/proxy/test {url?, username?, password?}`
  (example.com via de proxy). `GET /computers/profiles` geeft per profiel `proxy: { url, has_login } | null`.
- `GET /computers/:agentId/desktop/windows` · `.../desktop/preview/:sid` · `.../desktop/ref?ref=`
- Computer use (eigenaar): `GET /computers/desktop/state` · `POST /computers/desktop/stop {source?}` ·
  `POST /computers/desktop/resume` · `GET /computers/:agentId/screen` (niveau, opties, controller, taakscope,
  schermen, sneltoets) · `GET .../screen/stream` (MJPEG) · `GET .../screen/frame.jpg` · `GET .../screen/preview/:callId`
  (+ `/image`, voorbeeld bij een goedkeuring) · `POST .../screen/pause` (neem over) · `POST .../screen/resume` (geef
  terug / hervat na noodstop) · `DELETE .../screen/grant`. `PUT /computers/:agentId/config` neemt `host_level` en
  `host_options {screen, pauseOnInput, taskMinutes, blockWords, maxPerMinute, monitor, allApps}` (alleen de eigenaar;
  `allApps` vraagt `confirmAllApps: true`). Een gekoppelde telefoon mag alleen meekijken, stoppen, pauzeren/hervatten,
  een taakscope intrekken en de stappen zien (`MOBILE_SCREEN_ROUTES`), nooit het niveau wijzigen.
- `toolOutputToMcpContent(ctx, out)` (`server/tools/images.ts`): tekst + schermafbeeldingen van een toolresultaat als
  MCP-inhoud (`{type: 'image', data, mimeType}`) voor een MCP-brug naar CLI-engines.
- `PUT /computers/:agentId/config` met `remote: {host, port, username, dir, docker: {enabled, image, memoryMb, cpus},
  limits: {timeoutSec, maxOutputKb, transferMb}}` (inloggegevens en vingerafdruk gaan hier nooit mee)
- `PUT /computers/:agentId/remote/credential {kind: 'key'|'password', value}` → `{secret_name, has_secret, auth}` ·
  `DELETE /computers/:agentId/remote/credential`
- `POST /computers/:agentId/remote/test` → `{ok, fingerprint, trusted, mismatch?, expected?, windows?, os?, docker?:
  {installed, usable, version}, message?, error?}` (403 als een beperkt lid een privé-adres gebruikt)
- `PUT /computers/:agentId/remote/trust {fingerprint: 'SHA256:…' | null}`
- Cloud-VM: `GET /computers/cloud/providers` → `[{id, label, has_token, allowed, reason?}]` ·
  `PUT|DELETE /computers/cloud/:provider/token {token}` → `{has_token}` · `GET /computers/cloud/:provider/options`
  (`?refresh=1`, plus `defaults`) · `GET /computers/cloud/:provider/estimate?type=&location=` ·
  `GET /computers/:agentId/cloud` → `{vm, allowed, reason?}` · `POST /computers/:agentId/cloud {provider, server_type,
  location, image, docker, confirmCost}` · `GET /computers/cloud/vms` · `POST /computers/cloud/vms/:id/poweroff` ·
  `/poweron` · `/refresh` · `/delete {confirm: <VM-naam>}`

## Tabellen

`computer_configs` (per bot: modus, profiel, allow/deny, allow_private, host_control, host_apps, container, limits;
migratie `browser-002`: `remote_host`, `remote_port` (22), `remote_user`, `remote_auth` (`key`/`password`),
`remote_secret` (alleen de *naam* van het secret), `remote_fingerprint` (vastgezette `SHA256:`-vingerafdruk),
`remote_dir` ('' = `teambot/<botId>`), `remote_docker` (JSON), `remote_limits` (JSON)). De API geeft dit als
`config.remote` terug, plus `has_secret` en `workdir`.
`browser_profiles` (eigen of gedeeld, room_id; migratie `browser-006`: `proxy_url`, '' = geen eigen proxy), `computer_actions` (stappenlog, max 1000 per bot, frame-bestand),
`rehearsals`, `workspace_snapshots`, `cloud_vms` (migratie `browser-003`: bot (null na verwijderen van de bot) + naam,
provider + id, type/locatie/image, IP, status + toelichting, vingerafdruk van de door TeamBot gemaakte hostsleutel,
Docker, prijsschatting, tijden; géén geheimen — token en clientsleutel (`cloudvm-key:<vmId>`) staan in `secrets`, de
privé-hostsleutel wordt niet bewaard). `vault_logins` (migratie `browser-005`: eigenaar, naam, `origins` (JSON,
exact), `username_enc`/`password_enc`/`totp_enc` (versleuteld met de hoofdsleutel van de secret store), `agent_ids`
(JSON; leeg = alle bots), tijden) en `vault_grants` (login + bot + origin = "altijd toestaan"). Bestanden onder
`<data>/browser/{profiles,frames,rehearsals,snapshots,host,tmp}`.

## Events

`computer.status`, `computer.action`, `computer.frame`, `computer.config`, `rehearsal.updated`, `snapshot.updated`,
`cloudvm.updated` (VM-rij), plus `agent.updated` (toolgroepen/werkmap) en `notification` (repetitie klaar,
serversleutel klopt niet, cloud-VM klaar, VM van een verwijderde bot bestaat nog, VM buiten TeamBot om verwijderd).
Audit: `cloudvm.token_set/token_deleted/created/create_failed/ready/poweroff/poweron/deleted/orphaned/gone/error`,
`vault.created/updated/deleted/grant_added/grant_revoked/login/login_denied/imported` (nooit gebruikersnaam, wachtwoord
of code; `imported` alleen formaat en aantallen), `browser.logout_site/profile_shared/profile_members`. Event
`vault.updated` (alleen het id, of `{imported: n}`). `statusOf()` geeft
per tabblad `{index, url, title, active}`, `browser.title`, `browser.filling` (de kluis vult in) en `profileName`.
`statusOf()` bevat voor modus `remote` een blok `remote` (geconfigureerd, sleutel opgeslagen, vertrouwd, verbonden,
Docker, wie de server bedient).

## Diensten

`ctx.services.computers`: `capabilities()`, `config(agentId)`, `status(agentId)`, `sharedProfilesForRoom(userId, roomId)`,
`lease.{current,acquire,release}` (voor gedeelde room-computers), `exportUser(userId)`.

## UI

Pagina **Computers** (`#/m/browser`, onder Instellingen › Computers en bestanden): apparaat-truth-table, modi, per bot status/thumbnail/live/stop,
de **Kluis** (logins toevoegen/bewerken/verwijderen, 2FA-sleutel, welke bots, "altijd toegestaan" intrekken,
**Importeren**: CSV kiezen of slepen → herkende app + lijst met vinkjes (dubbele gemarkeerd, Alles/Niets kiezen,
overgeslagen regels met reden) → overzicht per reden + advies het CSV-bestand te wissen; ook als `#/m/browser/kluis`), browserprofielen (delen met gekozen bots, uitloggen bij één site, wissen) en gedeelde computers
maken. Pagina **Live scherm** (`#/m/browser/live/<botId>`). **Browserpaneel** (`BrowserDock.tsx`): een kleine
wereldbol-knop in de chatkop (groene stip als de browser draait) opent de browser van de bot naast de chat
(verstelbare breedte, onthouden per apparaat; onder 1100 px als schuifpaneel) of op de telefoon als volledig scherm.
Nieuwe uitbreidingspunten voor modules: `chatDocks` (paneel naast de chat) en `approvalRenderers` (eigen kaart voor een
goedkeuring). Goedkeuringskaarten: `browser_vault_login` (site, account, uitleg, Inloggen / Altijd / Zelf inloggen /
Weigeren; "Altijd" niet op de telefoon) en `browser_request_login` (Open de browser / Klaar / Niet nu).
Bot-editor-sectie **Computer & bestanden** (eigen opslaan-knop; modus, domeinen, profiel, lokale adressen, "elke klik
vragen", host-opt-in met uitleg en app-kiezer, container, limieten; bij *Eigen server (SSH)* (`RemoteSection.tsx`):
waarschuwing over de volledige rechten van de SSH-gebruiker met het advies een aparte gebruiker of Docker te nemen,
adres/poort/gebruiker/map, sleutel of wachtwoord als alleen-schrijven-veld met "opgeslagen"/"Vergeten", Docker +
image/geheugen/processors, limieten, "Verbinding testen" met vingerafdruk + *Vertrouwen*, een rode waarschuwing met
bevestigingsvinkje als de sleutel veranderd is, en eerlijke staten: niet ingesteld, geen sleutel, niet vertrouwd,
verbonden; daarnaast de keuze *Cloud-VM laten maken (Hetzner, DigitalOcean)* (`CloudVmSection.tsx`): provider kiezen,
token per provider (alleen schrijven), locatie/type/systeem uit de API met maandprijs (GPU-types in een eigen groep met
waarschuwing over prijs, regio's en goedkeuring), Docker, kostenvak (met "excl. btw" waar dat zo is), *VM aanmaken…*
met bevestigingsvinkje voor het bedrag, daarna status, provider, adres, kosten, vastgezette vingerafdruk en
*Uitzetten*/*Aanzetten*/*Vernieuwen*/*Verwijderen…* (getypte naam)). Bij *Bot verwijderen* (`AgentEditor.tsx`) moet je bij een bot met VM kiezen tussen
behouden en ook verwijderen. De pagina **Computers** toont per bot `gebruiker@server · staat` en Docker, en een blok
**Cloud-VM's** met alle VM's die nog bestaan (ook van verwijderde bots), hun kosten en het maandtotaal. Het
ledenbeleid (Instellingen › Gebruikers) heeft de schakelaar *Cloud-VM's toestaan voor leden*. Inspector-tabs **Computer** (live, stappen,
overnemen, noodstop, terugkijken) en **Wijzigingen** (repetitie-diff toepassen/verwerpen, snapshots herstellen).
Toolkaarten voor `browser_*` (screenshots, voorbeeld + Toestaan/Weigeren bij versturen/uploaden, link bij inloggen) en
`desktop_*` (voorbeeld van het venster of het hele scherm met het doel rood gemarkeerd, de reden bij externe gevolgen,
Toestaan/Weigeren in de kaart, schermafbeelding na de stap). De tab **Computer** en het live scherm hebben bij bots met
bureaubladbediening *Bureaublad | Browser*; het bureaubladpaneel (`DesktopPanel.tsx`) toont niveau, controller,
taakscope (intrekken), live beeld, *Neem over*/*Geef terug*, *Noodstop bureaublad*, *Hervat*, beeld-in-beeld en de
stappen, en werkt ook op de telefoon. In de bot-instellingen staan toegangsniveau, taakduur, hele scherm, pauze bij
muisbeweging, beeldscherm, extra geblokkeerde woorden en *Alle apps toestaan…* (met bevestiging). Het live
browserscherm neemt na een klik ook toetsenbord en scrollwiel over, en opent als beeld-in-beeld (desktop-app: klein
altijd-bovenop venster; browser: pop-up) via `#/m/browser/live/<bot>/pip` of `/pip-desktop`.

## Ontwerpkeuzes (mini-ADR's)

1. **Policy-proxy i.p.v. request-routing.** Een spike liet zien dat Playwright-`route` redirect-hops niet onderschept
   (public → 302 → localhost kwam erdoor). De proxy ziet elke hop en verbindt met het zelf gecontroleerde IP.
2. **Eigen snapshot-script i.p.v. `ariaSnapshot`.** Playwright's aria-snapshot toont wachtwoordwaarden; ons script
   verbergt gevoelige velden en geeft stabiele referenties.
3. **Klik-risico in de tool, niet in de broker.** Het risico van een tool is statisch; daarom weigert `browser_click`
   verstuur-achtige elementen en verwijst naar `browser_submit` (danger). Heuristisch: JS-knoppen zonder herkenbare naam
   kunnen erdoorheen glippen — wie dat niet wil zet "elke klik eerst vragen" aan.
4. **Repetitie via tijdelijke `agent.workspace`.** Zo werken alle bestaande bestands/shell/CLI-tools zonder
   kernwijziging in de kopie. Het runner-agentobject van de lopende run wordt ook bijgewerkt. Afronden kan niet terwijl
   de bot nog draait (409), zodat er niets in een verwijderde kopie belandt.
5. **Gevoelige instellingen in een eigen tabel**, niet in `agent.settings`: botsjablonen (export/import) nemen
   `settings` mee, dus een geïmporteerde bot kan nooit stilletjes bureaubladbediening of lokale adressen meekrijgen.
6. **Bureaublad via UI Automation-tekst**: de modellen zien geen afbeeldingen in tool-resultaten (kern geeft alleen tekst
   door), dus de bot werkt met elementreferenties; de screenshot is voor de mens (goedkeuring/voorbeeld).
7. **Alleen Docker als geïsoleerde runtime.** Hyper-V/Windows Sandbox worden gedetecteerd maar niet aangestuurd; WSL
   wordt expliciet niet als isolatie gepresenteerd (kan bij Windows-schijven).
8. **Eigen server: alleen exec, geen SFTP.** Bestanden gaan via `cat`/`head -c`/`ls -la`/`mkdir` in ons eigen
   script. Eén mechanisme (en één paden- en symlinkcontrole) voor alles, ook als de server SFTP uitzet, en de testserver
   blijft simpel. Nadeel: geen hervatbare transfers, en `head -c`/`wc`/`tr` moeten bestaan (GNU, BusyBox en macOS
   hebben ze).
9. **TOFU zonder inloggen.** Zonder vertrouwde vingerafdruk wordt de handshake na de sleuteluitwisseling afgebroken,
   zodat een wachtwoord nooit naar een niet-gecontroleerde server gaat. Vertrouwen is altijd een expliciete klik; bij
   een andere sleutel stopt alles (geen automatisch bijwerken). Een vingerafdruk die je zelf van de server haalt kun je
   ook direct via `PUT .../trust` vastzetten.
10. **IP vastzetten tegen DNS-rebinding.** We zoeken de naam zelf op, controleren álle adressen (voor beperkte leden)
    en verbinden met dat ene IP; de pool-sleutel bevat het IP, dus een nieuw DNS-antwoord geeft een nieuwe,
    opnieuw gecontroleerde verbinding.
11. **Kill via SSH-signaal, kanaal open houden.** `ssh2` stuurt het `signal`-verzoek alleen op een schrijfbaar kanaal;
    daarom krijgt de opdracht stdin `/dev/null` in het script en blijft het kanaal zelf open. OpenSSH (≥ 7.9) doet dan
    `killpg` op de sessie. In Docker-modus volgt ook `docker kill <naam>`.
12. **Pure-JS `ssh2`.** `allowScripts` weigert de bouwstappen van `ssh2` en `cpu-features`, en electron-builder bouwt
    geen native modules opnieuw (`"npmRebuild": false`; TeamBot heeft geen native modules). `ssh2` laadt de optionele
    binaries met try/catch en gebruikt anders `node:crypto`, dus het werkt ongewijzigd in Node, de bundel en Electron
    (asar, zonder `asarUnpack`).

13. **Cloud-VM: hostsleutel door TeamBot gemaakt in plaats van TOFU.** Bij een VM die TeamBot zelf aanmaakt, hoeft
    niemand een vingerafdruk te vergelijken: TeamBot maakt de hostsleutel, geeft die via cloud-init mee
    (`ssh_deletekeys`, geen andere sleuteltypes) en zet de vingerafdruk vast vóór de VM bestaat. De eerste verbinding is
    daardoor al gecontroleerd; een andere sleutel = fout, nooit "toch vertrouwen". Prijs: de privé-hostsleutel staat in
    de user data bij de provider. Afgewogen: alleen de provider en processen op de VM zelf kunnen die lezen; met de
    sleutel kan iemand zich alleen als déze VM voordoen, wat een netwerkpositie vereist; TeamBot blokkeert de
    metadata-dienst voor `teambot` en wist de lokale kopieën. Alternatief (TOFU via de API-console-uitvoer of
    `ssh-keyscan` na het opstarten) zou de eerste verbinding ongecontroleerd laten.
14. **Kosten bevestigen met het bedrag zelf.** `confirmCost` moet gelijk zijn aan de schatting die de server op dat
    moment uit de API berekent, zodat een bevestiging nooit geldt voor een andere (nieuwe) prijs of ander type.
15. **VM nooit stil weg.** Het verwijderen van een bot ontkoppelt de VM alleen; de gebruiker kiest zelf (dialoog of de
    pagina Computers). Liever een VM die zichtbaar doorloopt dan data die onverwacht verdwijnt.
16. **Toegangsniveau in de tool, niet in de broker.** Bureaubladinvoer heeft registerrisico `write`; het niveau
    (`every`/`task`/`auto`) en de `danger`-vraag voor externe gevolgen beslist `gate()` in de tool, omdat alleen de tool
    weet wat er onder het punt staat (UIA-element, dialoog, app). Zo werkt hetzelfde voor API-bots, CLI-bots via de
    MCP-brug en routines. Zie ADR 0008.
17. **Beleid ook in de driver.** De PowerShell/C#-hulp krijgt bij elk verzoek het beleid mee en controleert zelf, vlak
    voor `SendInput`, venster, proces, blokkering en het verwachte venster; Node alleen vertrouwen zou een race laten
    tussen controle, goedkeuring en invoer. Maskeren gebeurt in de driver, zodat verborgen inhoud het proces nooit
    verlaat.
18. **Coördinaten zonder verborgen toestand.** De schermafbeeldingsgrootte volgt deterministisch uit het beeldscherm
    (`planShot`), dus een klik op (x, y) betekent altijd hetzelfde, ook na een zoom of een herstart.
19. **Kluis in een eigen tabel, versleuteld met dezelfde hoofdsleutel.** Rijen in `secrets` zijn op naam bruikbaar
    (MCP-omgevingsvariabelen, `/secrets`); een bot die een MCP-server kan instellen zou zo een wachtwoord kunnen
    doorsturen. Eigen kolommen met `ctx.secrets.encrypt` hebben dezelfde bescherming in rust zonder die route.
20. **TeamBot vult in, niet de bot, en alleen op een exacte origin.** Het model krijgt nooit een waarde, dus ook geen
    prompt-injectie die "typ het wachtwoord hier" kan uitlokken. Exacte origin in plaats van een domeinpatroon: een
    lookalike, een ander subdomein (gebruikerscontent) of http in plaats van https krijgt niets. Google-achtige
    logins op een ander domein vul je aan met een tweede origin per login.
21. **Kluis-import parseert op de server, in het geheugen, met een voorvertoning.** Parseren in de browser zou de
    wachtwoorden als JS-objecten in de pagina houden; nu gaat de tekst één keer naar de server (zoals bij "Login
    toevoegen"), worden de waarden meteen versleuteld en krijgt de UI alleen namen, adressen en gebruikersnamen terug.
    De eigenaar kiest de rijen, zodat een export met honderden oude logins niet blind de kluis vult. Dubbele logins
    worden overgeslagen (niet overschreven): een import mag nooit stilletjes een werkend wachtwoord vervangen.

## Beperkingen

- Deze pc (Windows 11 Home): geen Hyper-V/Windows Sandbox (kan niet op Home), WSL niet geïnstalleerd, geen Docker →
  modus "Privé-container" is niet beschikbaar en wordt zo getoond. De Docker-runtime is daarom **niet** op dit apparaat
  getest (alleen argumentopbouw en fail-closed-gedrag zijn getest).
- Bureaublad: lijst/inspectie/schermafbeelding en voor computer use compileren, schermen, gemaskeerde
  schermafbeelding, probe en de weigeringen (klik/toets/start/elementen buiten de allowlist) zijn op deze pc gedraaid;
  echte klik/typ/sleep/scroll-acties alleen via `npm run desktop:live` (eigen testvenster) en een nep-driver in tests.
  Invoer gaat via `SendInput` op de voorgrond (geen achtergrondinvoer zoals cua-driver, geen eigen botcursor): de bot
  en de eigenaar delen muis en toetsenbord, daarom de pauze bij muisbeweging. Herkenning van externe gevolgen is een
  heuristiek (namen, sneltoetsen, berichtenapps, `external`); apps die zonder herkenbare knop of toets iets versturen
  vallen erbuiten. Titelblokkering ziet alleen de venstertitel (bijv. het actieve tabblad van een browser).
  Geen virtueel/apart bureaublad per bot. macOS/Linux: niet ondersteund (fail closed).
- Browser in een container/VM, cloud-VM, egress via thuis-desktop, VM-images: niet gebouwd. Op een eigen server
  (SSH) is er geen browser en geen bureaublad, alleen opdrachten en bestanden.
- Eigen server (SSH): alleen getest tegen een `ssh2`-testserver in het proces die opdrachten met Git Bash uitvoert
  (Windows), niet tegen een echte OpenSSH-server; de Docker-modus is getest met een nep-`docker` (argumenten en
  routering), niet met echte Docker op een server. De eerste opdracht in Docker-modus downloadt zo nodig het image;
  dat telt mee voor de tijdslimiet. Niet ondersteund: sleutels met wachtwoordzin, ssh-agent,
  jump hosts/proxy, keyboard-interactive/2FA, Windows-servers en niet-POSIX-loginshells (fish, csh, cmd, PowerShell).
  Op servers zonder het SSH-`signal`-verzoek (OpenSSH < 7.9, sommige Dropbear-versies) kan een gestopte opdracht
  doorlopen tot hij iets wil schrijven. De symlinkcontrole van de bestandstools is een controle-dan-actie: een proces
  dat tegelijk in de map draait (bijv. iets dat de bot zelf op de achtergrond start) zou ertussen kunnen komen.
  Leden op een gedeelde server krijgen `remote_exec` ook als de terminal (`shell`) voor leden uit staat: die regel
  beschermt de TeamBot-server, `remote_exec` draait op hun eigen server.
- Cloud-VM: alleen getest tegen een nep-Hetzner-API en een nep-DigitalOcean-API (`node:http`) en de `ssh2`-testserver
  met de gegenereerde hostsleutel; **niet** tegen de echte API's of echte VM's (daarvoor is een token met kosten
  nodig). Niet geverifieerd: dat de Ubuntu/Debian-images van beide providers de cloud-init precies zo uitvoeren
  (volgorde van de ssh-module vóór sshd, de vendor-data van DigitalOcean, de iptables-regel tegen de metadata-dienst,
  het wissen van de cache), de echte prijsvelden, de vorm van `gpu_info`, of DigitalOcean `with_droplet_agent`
  respecteert, en de echte foutcodes (bijv. de tekst bij een niet-vrijgegeven GPU-account). Geen snapshots/back-ups,
  firewalls, volumes, IPv6-only of eigen netwerken; geen GPU-images met stuurprogramma's (het gewone Ubuntu-image).
  Het root-wachtwoord dat de provider zonder SSH-sleutels aanmaakt (Hetzner: in het antwoord, DigitalOcean: per mail),
  werkt niet doordat cloud-init root vergrendelt (de console van de provider kan root nog steeds een nieuw wachtwoord
  geven). Wordt de token verwijderd, dan kan TeamBot de VM's van die provider niet meer volgen of verwijderen (dat
  staat erbij); verwijder ze dan in de console van de provider.
- Wie Docker op de server mag gebruiken (groep `docker`) is daar in de praktijk root; de bot zelf zit in de container,
  maar de opgeslagen sleutel geeft die rechten. Een aparte gebruiker zonder sudo en zonder Docker is het veiligst.
- Kluis: alleen inlogformulieren in het hoofdframe (niet in een iframe of shadow DOM), één code-veld (geen zes losse
  vakjes), alleen TOTP (geen sms/push/passkeys: dan vult de gebruiker de code zelf in), geen captcha's. "Ingelogd" is
  een heuristiek (pagina veranderd en geen inlogvelden meer); bij twijfel zegt het resultaat dat de bot moet
  controleren. De gebruikersnaam kan op de site zelf in beeld staan (veel sites tonen het account); de bot ziet die
  paginatekst wel. Het live beeld voor de eigenaar is niet gemaskeerd (wachtwoordvelden tonen alleen puntjes).
  Import alleen uit CSV (geen 1Password `.1pux`, versleutelde Bitwarden-JSON of KeePass `.kdbx`); een dubbele login
  wordt overgeslagen, niet bijgewerkt (een nieuwer wachtwoord pas je aan met Bewerken). Een CSV in een andere
  tekenset dan UTF-8 (oude Excel) kan accenten verkeerd tonen.
- Iframes worden niet uitgelezen (wel gemeld). Sessie-opslag gaat verloren bij overschakelen headless ↔ venster
  (cookies blijven). Zichtbaar venster alleen in de desktop-app voor de eigenaar.
- Schermafbeeldingen (browser, venster, bureaublad) gaan als afbeelding naar modellen met beeld (de nieuwste 3 in de
  geschiedenis); CLI-engines krijgen ze pas via de MCP-brug (`toolOutputToMcpContent`).
- Bij verwijderen van een bot met lopende repetitie blijft de oorspronkelijke werkmap staan (geen dataverlies).

## Handmatige voorwaarden

- Live test bureaublad: `npm run desktop:live` (Windows, ±1-2 min, alleen als niemand de pc gebruikt: muis en
  toetsenbord niet aanraken). De test compileert een eigen testvenster `tbtestwin.exe`, zet alleen dat op de allowlist
  en bedient alleen dat venster. `TB_DEBUG=1` toont de tooluitvoer, `TB_LIVE_SKIP_UIA=1` slaat het UIA-deel over.

- Edge of Chrome geïnstalleerd (of `TEAMBOT_BROWSER_PATH`). Op Linux-servers zonder display draait headless gewoon.
- Voor "Privé-container": Docker Desktop (Windows, via WSL2) of Docker Engine (Linux), en het image (standaard
  `debian:stable-slim`) moet gedownload kunnen worden.
- `TEAMBOT_MAX_BROWSERS` (standaard 6 per server, 3 per gebruiker), `TEAMBOT_BROWSER_HEADLESS_ONLY=1` (nooit vensters).
- Voor "Cloud-VM": een Hetzner Cloud-project of DigitalOcean-account met een API-token met lees- en schrijfrechten
  (zie de tabel bij *Providers*) en voldoende limiet voor een extra server. Voor GPU-droplets: GPU-toegang bij
  DigitalOcean (vaak na een aanvraag). Kosten volgens de prijs die vooraf wordt getoond.
- Voor "Eigen server (SSH)": een Linux- of macOS-server met sshd, bij voorkeur een aparte gebruiker
  (`sudo adduser teambot`), een sleutelpaar zonder wachtwoordzin (`ssh-keygen -t ed25519 -N "" -f teambot_key`) met de
  publieke sleutel in `~teambot/.ssh/authorized_keys`, en de vingerafdruk van de server om te vergelijken
  (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`). Voor de Docker-optie: Docker op de server en de gebruiker in de
  groep `docker`. De tests draaien alleen als er een bruikbare `bash` is (Windows: Git Bash; of `TEAMBOT_TEST_BASH`).
