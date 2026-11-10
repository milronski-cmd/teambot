# Module `mobile` — Telefoon & meldingen

Koppelt telefoons aan TeamBot (QR of code), geeft elk apparaat een eigen intrekbare sleutel met **beperkte
rechten**, maakt TeamBot bereikbaar voor de telefoon (wifi, Tailscale, tunnel), verstuurt **pushmeldingen**
(Web Push en, voor de native iPhone-app, APNs), maakt de webapp installeerbaar als **PWA** met offline-schil, en
bewaart berichten die niet aankwamen als **concept**. De native iPhone-app staat in `mobile/ios/` (zie de README daar).

Catalogus §21.10: QR/apparaat-koppeling, per-apparaat-sleutel (Keychain in de iOS-app), lijst/geschiedenis/live/
sturen/bijlagen/taakstatus/stoppen/vragen/goedkeuringen/zoeken via de bestaande app, meldingen, intrekken;
P1 offline-concepten en deep links (melding → juiste gesprek); acceptatie: default-deny mobiele routes, telefoon
kan geen sleutels/admin/secrets ophalen, intrekken direct, eerlijke offline-staat.

## Hoe het werkt

1. **Koppelen** (computer, Instellingen → Telefoon, sinds 0.4.5 **één kaart** *Telefoon koppelen*, zie hieronder):
   `POST /api/mobile/pair` maakt een ticket: een QR met link `…/api/public/mobile/pair#t=<256-bit geheim>` (of
   `teambot://pair#t=…` voor alleen de TeamBot-verbinding) en een code van 8 tekens. Beide **5 minuten geldig, één
   keer bruikbaar**; een nieuw ticket maakt het vorige ongeldig.
   - QR → koppelpagina (server-HTML, werkt zonder login, CSP met nonce). Het geheim staat in het URL-fragment,
     wordt dus nooit in een GET naar de server gestuurd of gelogd; de pagina haalt het uit de adresbalk weg en
     POST het naar `/api/public/mobile/claim`.
   - Code → werkt in het inlogscherm van de app (tab *Koppelen*, core `POST /api/public/pair`) én op de koppelpagina.
     De code staat ook in de core-tabel `pair_codes`; wie het eerst inwisselt verbruikt beide vormen (atomair), dus
     één ticket = hooguit één apparaat.
2. **Apparaat** = sessie van soort `device` (eigen token, 365 dagen) + metadata in `mobile_devices`
   (naam, platform, client `pwa|browser|ios-app`). Laatst gezien = `sessions.last_seen`.
3. **Toegang**: elke API-aanvraag met een apparaat-token gaat langs het telefoonbeleid (`policy.ts`): sinds 0.4.1
   mag de telefoon van de eigenaar alles behalve een korte lijst **alleen op de computer** (403 `mobile_denied`).
4. **Intrekken** (`POST /api/mobile/devices/:id/revoke`, of core `DELETE /api/sessions/:id`, of uitloggen op de
   telefoon): sessie ingetrokken → open WebSockets van díe sessie worden direct gesloten (code 4401), pushabonnementen
   verwijderd, REST geeft 401 (ook via de telefoon-toegang, zodat de app uitlogt).

### Telefoon koppelen in één kaart (0.4.5)

De eigenaar: "app gedownload, gekoppeld met de QR-code, klaar", zoals bij OpenBot. Instellingen › Telefoon op de
computer is daarom één kaart met drie stappen (`PhoneSettings.tsx`, `PairCard`):

1. **Haal de app**: een link naar de iPhone-app (`TEAMBOT_IOS_APP_URL`, alleen https, bijvoorbeeld een openbare
   TestFlight-link; zonder die variabele de app TestFlight in de App Store met de uitleg dat de app via een
   TestFlight-uitnodiging komt) en één regel over de web-app.
2. **Scan de QR-code**: een grote QR-code staat er **meteen**, zonder eerst te kiezen. De kaart vraagt
   `POST /api/mobile/pair { baseUrl: "auto" }` (`Mobile.autoTicket`): kan deze computer de TeamBot-verbinding draaien,
   dan zet TeamBot die aan (beheerder; audit `mobile.iroh.enabled`, hooguit 4 s wachten op de relay). Is er een
   **werkend https-adres** (Tailscale Serve, het publieke adres), dan komt dat in de code mét de sleutel (`via: both`):
   de app probeert dat eerst en de camera opent de web-app; anders is het een `teambot://pair`-code voor de iPhone-app
   (`via: iroh`). Zonder TeamBot-verbinding: het beste adres dat nu werkt; is er geen, dan een gewone zin die naar
   *Meer opties* wijst. Het antwoord heeft `auto: { kind, label }`. Heeft de beheerder de verbinding zelf uitgezet
   (*Meer opties › Bereikbaarheid*, instelling `mobileIrohOff`, `reachability.iroh.offOnPurpose`), dan zet de kaart
   hem niet stilletjes weer aan; kiezen bij *QR-code met een ander adres* of de schakelaar wel. Een verlopen code vernieuwt zich zolang de pagina
   in beeld is (hooguit 6 keer), en wie de pagina binnen de geldigheid opnieuw opent, ziet dezelfde code.
3. **Verbonden**: live (`mobile.paired`, met een poll van 4 s als vangnet) *Verbonden: iPhone van Sanne*.

Is er al een telefoon gekoppeld, dan maakt de kaart niet vanzelf een code: stap 3 zegt *Verbonden: …* en stap 2 heeft
**Nog een telefoon koppelen** (één klik, geen keuze). Onder de kaart: **Gekoppelde telefoons** (kort: de actieve
telefoons, hernoemen, intrekken) en **Meldingen op je telefoon** met de schakelaar *Altijd ook op de telefoon*. Alles
daarnaast staat in één **Meer opties** en blijft werken: *QR-code met een ander adres* (Tailscale, wifi, een eigen
tunnel of server, de TeamBot-verbinding), *Tailscale* (*Telefoon via Tailscale instellen*), *Bereikbaarheid*
(TeamBot-verbinding aan/uit en eigen relay, telefoon-toegang, poort), de details van de pushmeldingen en de web-app.
Koppelen blijft alleen op de computer (`/mobile/pair` staat in `COMPUTER_ONLY`). De iPhone-app zegt op het eerste
scherm alleen **Scan de QR-code op je computer** (`RootView.swift`); de code met een adres verschijnt daar alleen als
de camera niet mag.

### Openen op "Wacht op jou" (0.4.5)

De telefoon opent op **Wacht op jou** als er iets wacht, anders op Chats. De iPhone-app krijgt dat als `home: "#/inbox"`
uit `GET /api/mobile/status` zolang er een vraag of goedkeuring openstaat (`waitsFor` in `status.ts`; anders blijft
`ctx.services.mobileHome` gelden). De web-app doet het zelf (`ui/src/modules/mobile/start.ts`, `usePhoneStart` in
`App.tsx`): op een telefoonscherm, alleen vanaf de chatlijst, in de eerste 4 s na de start (dan zijn ook de andere
onderdelen van Wacht op jou geladen) en als je na 3 minuten weg terugkomt in de app. Een gesprek, pagina of
meldingslink die je zelf opende, blijft staan.

### Wat een telefoon mag (sinds 0.4.1)

De eigenaar is vaak niet bij zijn computer ("ik kan niet eens wat bedienen via de app"): zijn telefoon kan alles wat
de computer kan — bots maken en wijzigen, AI koppelen, instellingen, routines, teams, geheugen, taken, goedkeuren —
behalve een korte lijst die **toegang uitdeelt of geheimen toont** als de telefoon kwijtraakt (`COMPUTER_ONLY` in
`policy.ts`; prefix op het pad onder `/api`, hoofdletterongevoelig; 403 `mobile_denied` met de reden in gewone woorden):

| Pad | Blijft op de computer |
|---|---|
| `/admin/…` | beheer: gebruikers, uitnodigingen, netwerk, SSO, back-ups terugzetten of downloaden, diagnose |
| `/export`, `/memory/export` | alles exporteren |
| `/secrets` | opgeslagen sleutels bekijken of wijzigen |
| `/computers/vault` | de kluis met wachtwoorden |
| `/routines/triggers/:id/secret` | het geheim van een webhook |
| `/realtime/client_secrets` | een tijdelijke sleutel voor OpenAI Realtime |
| `/pair`, `/pairing`, `/mobile/pair` | een nieuw apparaat koppelen |
| `/mobile/devices` (behalve `…/self`) | andere gekoppelde apparaten |
| `/sessions` | inlogsessies |
| `/mobile/gateway` | telefoontoegang aan- of uitzetten |
| `/remote-desktop/switch` | bureaublad op afstand aanzetten of instellen (0.4.4; uitzetten via `/remote-desktop/off` en het gebruiken mogen wel — `docs/modules/remote-desktop.md`) |

| `/bot-rules/loosen…` | een eigen regel die een bot meer laat doen, of een regel weghalen (module `botrules`); strengere regels kunnen wel |

Per route blijven een paar regels: `PATCH /me` niet e-mail/wachtwoord; `POST /approvals/:id` niet `always` (op de
telefoon één keer goedkeuren of weigeren); `GET /providers` en `GET /system` afgeslankt (geen base_url, config,
sleutelstatus, datamap of adressen — config kan eigen auth-headers bevatten). De live-events `provider.updated|deleted`
gaan niet naar een telefoon. Een paar modules houden zelf iets op de computer: een venster op de pc openen (browser,
op de telefoon neem je over in het live beeld) en de sneltoets voor dicteren.

`DevicePolicy.allows(method, path)` geeft dezelfde beslissing zonder verzoek; zoeken op de telefoon gebruikt het om
alleen bronnen te tonen die de telefoon mag openen (sinds 0.4.2 dus ook geheugen en routines). `ctx.services.mobileRoutes`
en `ctx.services.mobile.allowRoute(...)` (de oude allowlist) bestaan nog, maar zijn met de denylist niet meer nodig.

**In de app (0.4.2).** De UI weet dat ze op een gekoppelde telefoon draait (`/me` → `session.kind === 'device'`;
`useApp().device`, `useIsPhoneSession()` in `ui/src/shell/computerOnly.tsx`). Plekken uit de lijst tonen dan rustig de
reden (`<ComputerOnly>`, een computer-icoon met één zin) in plaats van een draaiend rondje, een rode fout of een knop die
alleen kan mislukken: Instellingen › Beveiliging (sessies, geheimen), Back-ups (exporteren, terugzetten, database
downloaden), Gegevens (diagnose), Geheugen › export, de Kluis, de sleutel van de zoekdienst, en "Altijd toestaan" op een
goedkeuringskaart ("Altijd toestaan kies je op je computer."). Instellingen › Telefoon zegt wat de telefoon wél kan.
Wordt een 403 `mobile_denied` toch een melding, dan is die grijs, niet rood (`toastError`). Spraakmodellen downloaden
naar de pc mag sinds 0.4.2 ook vanaf de telefoon van de eigenaar (eerst stond er "vraag de eigenaar van de TeamBot-pc").

## Bereikbaarheid (eerlijk)

| Manier | Versleuteld | Push/installeren | Wat nodig |
|---|---|---|---|
| Zelfde wifi | **Nee** (http) | Nee (browser eist https) | Telefoon-toegang aan (opt-in, waarschuwing) |
| Tailscale direct (`http://100.x…`) | Ja (WireGuard) | Nee (browser ziet http) | Tailscale op beide apparaten |
| Tailscale Serve (`https://naam.ts.net`) | Ja | Ja | `tailscale serve --bg http://127.0.0.1:<poort>` (UI toont het commando) |
| Eigen tunnel/server (https) | Ja | Ja | bijv. `cloudflared tunnel --url http://127.0.0.1:<poort>`, of `TEAMBOT_PUBLIC_URL` |
| **TeamBot-verbinding** (iroh, sinds 0.4.4) | Ja (QUIC/TLS 1.3, end-to-end) | Push via APNs; geen browser/PWA | Alleen de iPhone-app; gaat aan bij de eerste QR-code (zie *TeamBot-verbinding*) |

**Telefoon-toegang** (`PUT /api/mobile/gateway`, alleen beheerder, `acknowledge: true` verplicht bij aanzetten):
in desktopmodus luistert TeamBot alleen op 127.0.0.1. In plaats van de hele server op 0.0.0.0 te zetten opent deze
module een **tweede poort** (standaard poort+1) die alleen doorlaat: de app-schil (GET), `/api/public/status`,
`/api/public/pair`, `/api/public/mobile/*`, en `/api/*` + `/ws` **met een apparaat-token**. Het eigenaar-token
(wachtwoordloos op de desktop), wachtwoord-login/setup en webhooks werken er niet. Paden worden genormaliseerd
(geen `..`/hoofdletter-trucs), `X-Forwarded-For` van de client wordt vervangen door het echte adres.
Bind: alle netwerken (wifi + Tailscale), alleen het Tailscale-adres, of alleen 127.0.0.1 (voor Serve/tunnel).
Tailscale-detectie: interfaces in 100.64.0.0/10 + `tailscale status --json` (alleen lezen, 4 s time-out, opgeschoonde env).

Host uit/slaapt → PWA toont een offline-pagina (service worker), de iOS-app een eerlijk scherm per schakel (zie
*iPhone-app* hieronder), mislukte berichten worden concept (zie onder). Niets wordt stilletjes later verstuurd.

## iPhone-app: status per schakel en toestemming (`status.ts`)

Doel (plan 0.4 §I, onderzoek *Knelpunten*): nooit één vaag "offline", maar zeggen wélke schakel stuk is — *pc slaapt*,
*TeamBot is dicht*, *netwerk weg*, *telefoon offline*, *koppeling ingetrokken* — met herstel in één tik; een koppeling
die app-updates en wissels tussen wifi en Tailscale overleeft; opnieuw koppelen dat nooit gesprekken wist; en
toestemming vóór het eerste gebruik volgens App Review-richtlijn 5.1.2(i).

- **`POST /api/public/mobile/hello`** `{device, nonce}` (zonder token, 60 per minuut per adres): `{teambot: 1, app,
  version, instance, device: active|revoked|unknown, proof}`. `proof` = HMAC-SHA256 met als sleutel de SHA-256 van
  het apparaat-token (die de server toch al bewaart) over `teambot-hello/1|instance|device|nonce|state`. De app stuurt
  zijn token alleen naar een adres dat zo bewijst dat het zijn eigen TeamBot is; een vreemd apparaat op hetzelfde
  192.168.x-adres in een ander wifi, of een provideradres in 100.64/10, krijgt niets. Onbekend apparaat → geen proof,
  dus een vreemde kan de app nooit laten vergeten. `instance` is een vaste, willekeurige id per TeamBot (instelling
  `mobileInstance`).
- **`GET /api/mobile/status`** (telefoon-token): `{instance, device, addresses[{url, kind, secure}], power{available,
  keepAwake}, privacy{version}, home}`. Adressen: Tailscale https (als Tailscale Serve deze TeamBot echt doorgeeft;
  op de achtergrond opgezocht, nooit tijdens het verzoek), het publieke adres, en voor eigenaar/beheerder de wifi- en
  Tailscale-adressen van de telefoon-toegang (of van de hoofdpoort als die op alle netwerken luistert). Geen
  subprocessen op het verzoekpad. `power` komt van de module *Pc wakker houden*.
- **`GET /api/mobile/privacy`** (telefoon-token): elke **ingeschakelde** AI-dienst van de gebruiker (eigen en gedeeld)
  met `vendor` (bedrijf, per soort; anders het label), `service`, `local` (pc of eigen netwerk), `host` (alleen de
  hostnaam van een eigen endpoint, nooit pad of sleutel), `forwards` (OpenRouter, OpenCode, eigen endpoint …), `free`
  (gratis laag), `data` (`chat`; `voice` als spraakherkenning of Realtime die dienst gebruikt; `readaloud` voor
  voorlezen) en `bots` (hoofd- en reserve-engine). Elke ingeschakelde dienst telt mee, want een reserve of de gratis
  keten kan erheen schakelen: liever te veel melden dan te weinig. `version` verandert alleen als er een andere
  partij of soort gegevens bijkomt (niet bij een nieuwe naam of een lokale dienst); dan vraagt de app opnieuw.
- **Startpagina (golf 2)**: zet een module `ctx.services.mobileHome = (userId) => '#/t/<thread>'` (bijv. de hoofdbot),
  dan geeft `status` dat als `home` en opent de iPhone-app daar. Alleen in-app-routes (`#/…`) worden doorgegeven.

Opnieuw koppelen raakt geen gesprekken: die horen bij de gebruiker, niet bij het apparaat (test
*re-pairing never touches conversations*). De iPhone-app bewaart bij ontkoppelen ook de lokale concepten.

De app zelf (zie `mobile/ios/README.md`): probeert alle bekende adressen tegelijk (`LinkDiagnosis`, met unit tests),
volgt de eigen verbinding van de iPhone (`NWPathMonitor`), toont per probleem één scherm met de oplossing als eerste
knop (`ProblemCopy`), en laadt de webapp pas na toestemming (`ConsentView`; intrekken in de app, in TeamBot ›
Instellingen › Telefoon › *Toestemming en verbinding*, of in iOS-Instellingen › TeamBot). Via Tailscale https kan de
app een slapende pc (geen antwoord) onderscheiden van een gesloten TeamBot (Tailscale antwoordt 502); via wifi niet
altijd (Windows antwoordt op een gesloten poort vaak niet), dan zegt het scherm beide.

## Pushmeldingen

- **Web Push** volgens RFC 8291 (aes128gcm, end-to-end versleuteld naar de browser: de pushdienst ziet alleen
  ciphertext) en RFC 8292 (VAPID, ES256). Eigen implementatie op `node:crypto`; getest tegen het RFC 8291-voorbeeld.
  Het voorgeïnstalleerde npm-pakket `web-push` is **MPL-2.0** (buiten het licentiebeleid) en wordt niet gebruikt.
- VAPID-sleutels: één paar per server, versleuteld in `ctx.secrets` (gebruiker `''`, naam `mobile:vapid`). Alleen de
  publieke sleutel komt in API-antwoorden. `TEAMBOT_VAPID_SUBJECT` (bijv. `mailto:jij@domein.nl`) aanbevolen;
  anders e-mail van de eigenaar, anders `mailto:teambot@example.com` (Apple kan dat weigeren → foutmelding in UI).
- Abonnement per **sessie** (dus per apparaat/browser), eindpunt + sleutels versleuteld opgeslagen. Eindpunten
  alleen naar bekende pushdiensten (Apple, FCM, Mozilla, Microsoft WNS; extra via `TEAMBOT_PUSH_HOSTS`) — SSRF-bescherming,
  geen redirects. 404/410 → abonnement verwijderd. Max. 30 pushes/min per gebruiker.
- Wanneer: `notification`-events met `kind: approval` (vragen/goedkeuringen) **altijd**; andere meldingen en
  "taak klaar/mislukt" (`run.updated` → done/error, niet voor delegatie-threads) alleen als de gebruiker geen open
  verbinding heeft (`ctx.services.onlineUsers`). Per gebruiker instelbaar, incl. "inhoud tonen op vergrendelscherm".
- **Achter de pc of weg (0.4.4, P8, `presence.ts`).** De desktop-app meldt elke 5 s (en meteen bij scherm op slot,
  ontgrendelen, slaapstand) `powerMonitor.getSystemIdleTime()` en of het scherm op slot is
  (`desktop/presence.ts` → `ctx.services.mobile.reportPresence`). `whereIs`: `pc` (invoer in de laatste 3 minuten,
  niet op slot), `away` (3 minuten niets of op slot) of `unknown` (geen melding in de laatste 60 s: servermodus, app
  dicht). Sinds 0.4.5 is dat 3 minuten (`AWAY_AFTER_S = 180`, was 30 s): een lang antwoord lezen telt nog als achter
  de pc, de telefoon gaat pas als je echt weg bent of meteen met het scherm op slot.
  `phoneGets`: bij `pc` geen push (ook geen goedkeuring), bij `away` alles volgens de voorkeuren (ook als de app open
  staat), bij `unknown` of met **Altijd ook op de telefoon** (`prefs.alwaysPhone`, standaard uit) de oude regel
  hierboven. Een goedkeuring die bij `pc` niet gepusht werd, wordt bewaard (30 min, max. 50) en alsnog gepusht bij de
  overgang naar `away` als hij nog `pending` is. `GET /mobile/push` geeft `presence { where, locked, awayAfterSeconds }`.
  Alleen "achter de pc / weg" wordt gebruikt, nooit wat je typt. Idee van OpenBot (niet-commercieel): alleen het idee.
- Een melding opent alleen de app op het juiste gesprek (alleen `#/…`-links); er zijn geen actieknoppen —
  **een melding keurt nooit iets goed**.
- **Afgehandeld = weg** (0.4.4, PARITEIT 15.1 voor web): een goedkeuring of vraag die elders beslist is (ander venster,
  desktop-app, de telefoon zelf) krijgt een **sluit-push** met dezelfde tag (`apr-<id>`, `kind: close`), alleen als
  er eerder een push voor die goedkeuring uitging en één keer. `sw.js` sluit dan de melding en toont niets (alleen
  `apr-`-tags; een push kan nooit andere meldingen sluiten). Een oudere service worker vervangt hem door een stille
  "Al afgehandeld" (zelfde tag). **Niet naar Apple** (`*.push.apple.com`): Safari trekt pushrechten in bij een push
  die niets toont; daar sluit de app zelf de meldingen van afgehandelde goedkeuringen bij openen of terugkomen
  (`ui/src/modules/notifications/handled.ts`, vergelijkt met `GET /api/approvals`). Een open pagina sluit ze direct
  bij `approval.updated`, ook de eigen webmeldingen van de pagina. Geen APNs-sluitbericht (native app). Chrome kan
  bij veel stille pushes zelf een algemene melding tonen; in de praktijk komt een sluit-push alleen na een echte
  goedkeuring. Tests: `tests/web-notes.test.ts`, `tests/e2e/web-notes.mjs` (echte service worker, pushes via CDP).
- iPhone: Web Push werkt alleen in een **op het beginscherm gezette** PWA (iOS 16.4+) en via https. De beginscherm-app
  heeft eigen opslag (los van Safari): daar opnieuw koppelen met de code. De UI zegt dit.
- **APNs** (native app): token-auth (ES256-JWT), HTTP/2; aan zodra `TEAMBOT_APNS_KEY_FILE`, `…_KEY_ID`, `…_TEAM_ID`
  (en `…_TOPIC`) gezet zijn. Getest tegen een lokale HTTP/2-nep-server, niet tegen Apple.

## PWA

`ui/public/manifest.webmanifest` (id/scope, maskable + apple-touch-iconen, kleuren, snelkoppelingen Inbox / Nieuwe bot /
Zoeken, deeldoel), `ui/public/sw.js`: offline-schil (index + gehashte assets + iconen; navigatie network-first),
**cachet nooit `/api`, bijlagen of `/ws`**, toont pushmeldingen. Iconen gemaakt met `mobile/ios/tools/gen-icons.mjs`.

### Delen vanuit andere apps (Android, geïnstalleerde desktop-PWA)

- `share_target` in de manifest: `POST /share-target` (multipart: `title`, `text`, `url`, `files`).
- De service worker vangt die POST op, bewaart tekst en bestanden in de cache `tb-share` **op het apparaat**
  (max. 10 bestanden / 50 MB, max. 24 uur) en stuurt door naar `#/m/mobile/delen/<id>`.
- Pagina **Delen**: kies een recent gesprek of een bot (nieuw gesprek), pas de tekst aan, *Versturen* uploadt de
  bestanden als bijlage en verstuurt het bericht; daarna (of bij *Weggooien*) wordt alles van het apparaat gewist.
  Er gaat niets naar de server voordat je op Versturen tikt.
- Zonder service worker (app nog nooit geopend) beantwoordt de server `POST /share-target` met een doorverwijzing
  naar een uitleg; hij neemt zelf niets aan (zonder sessie kan hij niet weten van wie het is).
- iPhone/iPad (Safari) ondersteunen geen deeldoel voor web-apps; daar blijft kopiëren/plakken of de native app.

### Telefoon en tablet

- **Viewport** `width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content`. Zoomen met
  twee vingers blijft mogelijk (toegankelijkheid); er staat geen `maximum-scale` of `user-scalable=no`.
- **Geen inzoomen bij een tekstveld.** iOS (Safari en de web view van de iPhone-app) zoomt de hele pagina in als een veld
  onder 16 px de focus krijgt, en zoomt niet terug ("dan wordt de app helemaal uitvergroot"). Op een aanraakscherm
  (`pointer: coarse`) is elk invoerveld, tekstvak en keuzemenu daarom minstens 16 px (`styles.css`); een bewust groter
  veld (de pincode van de app-vergrendeling) houdt zijn maat, de computer houdt al zijn maten.
- **Donker als standaard op de telefoon** (eigenaar, 9 november 2026: "de layout mag wel wat donker op de telefoon").
  Zonder eigen keuze op dit apparaat start de iPhone-app (user agent `TeamBotiOS/…`) of een apparaat met een
  aanraakscherm als hoofdaanwijzer donker; de computer volgt het systeem zoals altijd. Een keuze in Instellingen ›
  Uiterlijk › Thema (ook *Systeem*) wint altijd (`shell/theme.ts`, per apparaat in `tb_theme`). De kleur (Uiterlijk ›
  Kleur) hoort bij de gebruiker (`settings.ui.accent`): de telefoon toont de kleur van de computer, ook in donker.
- **Toetsenbord.** iOS verkleint de pagina niet als het toetsenbord opent. De app volgt de zichtbare hoogte
  (`useVisualViewportHeight` in `lib/media.ts`): de app krijgt die hoogte (`--app-h`), zodat het invoerveld direct boven
  het toetsenbord staat, en vensters en bladen (`.tb-overlay`) eindigen boven het toetsenbord (`--vv-h`, klasse
  `tb-keyboard` op `<html>`). Een pinch-zoom telt niet als toetsenbord. Android verkleint zelf (`interactive-widget`).
- **Veilige marges** (notch, home-indicator, afgeronde hoeken): `--safe-top` / `--safe-bottom` (met open toetsenbord
  0: dat bedekt de home-indicator al). De klassen `.safe-top/.safe-bottom/.safe-x` vervangen de eigen padding aan die
  kant; een element met eigen padding gebruikt `pb-[max(0.75rem,var(--safe-bottom))]` (invoerveld, kop van
  Instellingen, Zoeken, belscherm, bladen en bevestigingen). Eerder wiste `safe-bottom` de `pb-3` van het invoerveld.
- **Onderbalk** met de tabs uit `PHONE_TABS` (nu 3: Chats, Wacht op jou met teller, Meer); een nieuwe bot en de
  instellingen van een bot horen bij Chats. Knoppen in de onderbalk, de chatkop, naast het invoerveld, de rijen van Meer,
  de teamkiezer en goedkeuren zijn minstens 44 × 44 px (`coarse:`-variant).
- Vanaf 760 px (iPad staand) staat de zijbalk vast; daaronder de onderbalk. Ctrl+K én Cmd+K (iPad-toetsenbord).
- `npm run mobile:check` (Pixel 7, iPad Pro 11 staand/liggend): deeldoel via een echte multipart-POST-navigatie door
  de service worker, deelpagina → gesprek met bijlage, apparaat daarna leeg; geen horizontaal scrollen, zijbalk en
  invoerveld in beeld.
- `npm run phone:check` (`tests/e2e/phone-owner.mjs`, ook in `npm run e2e`): de iPhone van de eigenaar op een verse
  installatie. Koppelt via de echte QR-koppeling (de computer maakt het ticket, de "app" claimt het met `client:
  ios-app`) en laadt de webapp met de apparaat-sleutel zoals `WebShellView` dat doet (token vóór de start in
  `localStorage`, de user agent van de app, aanraken, 402 × 874). Daarna alleen tikken en typen: het lege eerste scherm
  en lege pagina's, de eerste bot met de drie vragen (de gevonden AI wordt gekoppeld), een bericht en het antwoord, een
  goedkeuring via *Wacht op jou*, Taken (taak toevoegen), Routines (routine maken), Geheugen (iets onthouden),
  Marktplaats, Instellingen (naam wijzigen, thema), het belscherm, de gebruiksbalk, een tweede team en wisselen, en de
  plekken die op de computer blijven. Op elk scherm: donker, geen veld onder 16 px, niet opzij schuiven (ook op 390 en
  430 px), geen mislukte verzoeken of consolefouten, axe-core WCAG 2.2 A/AA in donker. Het toetsenbord wordt nagebootst
  door de zichtbare hoogte te verkleinen. Ten slotte: de computer blijft licht/systeem en houdt zijn lettergroottes.

## Concepten (offline)

De module kijkt mee met `POST /api/threads/:id/messages` (wijzigt niets aan verzoek of antwoord). Mislukt dat door een
netwerkfout of 502/503/504, dan bewaart de telefoon het bericht in `localStorage` (per gebruiker) en toont een melding.
Pagina `#/m/mobile/concepten` toont ze met **"Nog niet afgeleverd"**; versturen gebeurt alleen na een tik.
In de composer staat een knop "N niet afgeleverd" zolang een gesprek concepten heeft.

## API

| Methode + pad | Wie | Wat |
|---|---|---|
| `GET /api/public/mobile/pair` | iedereen | koppelpagina (HTML, CSP-nonce, `no-store`) |
| `POST /api/public/mobile/claim` | iedereen | `{secret}` of `{code}`, `name`, `platform`, `client` → `{token, device, user}`; rate limit |
| `POST /api/mobile/pair` | computer | `{baseUrl}` (`"auto"`: TeamBot kiest, zet de TeamBot-verbinding aan, zie *Telefoon koppelen in één kaart*; `"iroh"`: alleen de TeamBot-verbinding, zet hem aan) → `{id, url, code, qr (data-URL SVG), expires_at, ttl, via, auto?}` |
| `GET/DELETE /api/mobile/pair/:id` | computer | status (`waiting/used/expired/cancelled`) / annuleren |
| `GET /api/mobile/devices` | computer | apparatenlijst (actief + 30 dagen ingetrokken) |
| `POST /api/mobile/devices/:id/revoke`, `PATCH /api/mobile/devices/:id` | computer | intrekken / hernoemen |
| `GET/DELETE /api/mobile/devices/self` | iedereen | dit apparaat / jezelf ontkoppelen |
| `POST /api/mobile/devices/self/apns` | iOS-app | `{token, environment}` |
| `POST /api/public/mobile/hello` | iedereen | `{device, nonce}` → `{instance, device, proof}`; rate limit (zie *iPhone-app*) |
| `GET /api/mobile/status` | iedereen (eigen data) | adressen van deze TeamBot, wakker houden, privacyversie, `home` (`#/inbox` als er iets wacht), `iroh` (`{id, relay}` of `null`) |
| `GET /api/mobile/privacy` | iedereen (eigen data) | AI-diensten, wat ze krijgen, welke bots ze gebruiken |
| `GET /api/mobile/reachability` | computer | adressen, Tailscale, telefoon-toegang (details alleen voor beheerders), `app.ios` (link naar de iPhone-app of `null`) |
| `PUT /api/mobile/gateway` | beheerder | `{enabled, bind, port, acknowledge}` |
| `PUT /api/mobile/iroh` | beheerder, computer | `{enabled?, relay?}` (relay: https-adres, leeg = n0) → bereikbaarheid |
| `GET /api/mobile/push`, `PUT …/prefs`, `POST …/subscribe`, `…/unsubscribe`, `…/test` | iedereen (eigen data) | push |

"computer" = elke niet-apparaat-sessie; een telefoon krijgt 403.

Tools: geen (bots hebben al `notify_user`; die meldingen gaan als push mee).

## Tabellen

- `mobile_pair_tickets(id, user_id, secret_hash, code, base_url, expires_at, used_at, cancelled, session_id, created_at)` — geheim alleen als SHA-256; tickets > 1 dag worden opgeruimd.
- `mobile_devices(session_id PK, user_id, name, platform, client, user_agent, apns_enc, apns_env, created_at, revoked_at)`
- `mobile_push_subs(id, user_id, session_id, endpoint_hash UNIQUE, data_enc, label, created_at, last_ok, last_error, failures)`
- Instellingen: `mobilePush` (per gebruiker), `mobileGateway` (server, gebruiker `''`).

## Events

`mobile.paired` `{ticket, device}`, `mobile.devices.updated`. Luistert naar `notification`, `run.updated`.
Audit: `mobile.pair.created`, `mobile.device.paired`, `mobile.device.revoked`, `mobile.gateway.enabled|disabled`, `mobile.push.subscribed`.

## Kernwijzigingen (klein, additief)

- `server/core/auth.ts`: `Auth.policies` (per-aanvraag-beleid na tokencontrole; hier de apparaat-allowlist) en
  `Auth.onRevoke()`; `revokeSession`, `DELETE /sessions/:id` en "gebruiker blokkeren" melden ingetrokken sessies.
  Core `/pair` normaliseert de code (`ABCD-EFGH` = `ABCDEFGH`, zoals de placeholder in het inlogscherm).
- `server/app.ts`: WebSocket-clients onthouden hun sessie-id; bij intrekken wordt die verbinding direct gesloten.
- 0.4.5: `ui/src/lib/palette.ts` — *Nu bezig* (`usage/status`) staat niet meer op de pagina Geavanceerd: het heeft
  een eigen plek in de zijbalk (`ui/src/shell/nav.tsx`, bestemming `now`) en op de telefoon in Meer. `ui/src/App.tsx`
  roept `usePhoneStart` aan (openen op Wacht op jou).
- 0.4.2 (telefoon): `ui/src/lib/store.ts` veld `device` (deze app draait op een gekoppelde telefoon, uit `/me`);
  `ui/src/lib/media.ts` zet bij een open toetsenbord `tb-keyboard` en `--vv-h` op `<html>` (en negeert pinch-zoom);
  `ui/src/components/ui.tsx`: klasse `tb-overlay` op de achtergrond van `Modal` en de bevestiging, de bevestiging
  houdt zijn eigen marge onderaan, en `toastError` toont `mobile_denied` grijs in plaats van rood.

## Ontwerpkeuzes (mini-ADR's)

1. **Beleid in de kern-authlaag i.p.v. router-middleware.** Modules initialiseren vóór deze module; een
   middleware in `init` zou hun routes niet afschermen. Met `Auth.policies` geldt het beleid voor elke `/api`-route,
   ook routes die later worden toegevoegd. Tot 0.4.1 was dat een allowlist (default deny); sinds 0.4.1 een korte
   denylist, omdat de eigenaar alles vanaf zijn telefoon moet kunnen bedienen. Faalt de policy-registratie, dan wordt
   koppelen uitgeschakeld.
2. **Apparaat = sessie.** Hergebruikt token-hashing, verloop en intrekken van de kern; geen tweede tokensysteem.
3. **Telefoon-toegang als aparte poort** i.p.v. de server op 0.0.0.0: het wachtwoordloze desktop-eigenaarstoken
   blijft lokaal; via het netwerk komt alleen apparaatverkeer binnen (plan §26: "relay only the minimal mobile routes").
4. **Geheim in URL-fragment + korte code.** QR = 256 bit; de code (≈40 bit) bestaat omdat de iOS-beginscherm-app
   een eigen opslag heeft en geen QR kan scannen. Compensatie: 5 minuten, één keer, per IP 5 fouten/5 min,
   globaal 30 foute codes/5 min (daarna alleen QR). Sinds 0.4 geldt hetzelfde voor de core-route
   `POST /api/public/pair` (per IP 5 fouten/min, globaal 30 foute codes/5 min, de code atomair verbruikt zodat twee
   gelijktijdige verzoeken nooit allebei koppelen) en is een code van `POST /api/pairing` ook 5 minuten geldig
   (`Auth.PAIR_CODE_TTL`; was 10). Tests: `tests/security-defaults.test.ts`.
5. **Eigen Web Push-implementatie** (licentiebeleid; ~150 regels, RFC-testvector).
6. **Concepten alleen lokaal en nooit automatisch versturen.** Voorkomt verrassende acties uren later.
7. **iroh in plaats van een eigen relay met Noise** (0.4.4). Het oude ontwerp (eigen WebSocket-relay, Noise IK, eigen
   frames) vroeg een gereviewde cryptolaag en een eigen dienst. iroh (MIT OR Apache-2.0) levert dat kant-en-klaar: QUIC
   met TLS 1.3 op de sleutels van beide kanten, eerst direct (ook hole punching), anders via een relay die alleen
   versleutelde gegevens ziet. OpenClaw gaat dezelfde kant op. WebRTC (OpenBot) viel af: veel eigen lijm (signalering,
   TURN) en bij OpenBot 144 mislukte verbindingen.
8. **Ruwe bytes per stream, geen eigen protocol.** De iroh-kant kent geen HTTP: elke stream is één TCP-verbinding naar
   de private telefoon-ingang. Keep-alive, uploads en de WebSocket werken zo vanzelf, en de telefoon-ingang blijft de
   enige plek die beslist wat binnenkomt.

## TeamBot-verbinding (iroh, sinds 0.4.4)

Doel: iemand installeert TeamBot op de pc en de iPhone-app, scant de QR-code en is verbonden, thuis én onderweg,
zonder Tailscale, account of instellingen in de router. Wie Tailscale gebruikt (de eigenaar), merkt niets: de app
probeert altijd eerst wifi en Tailscale.

**Hoe het werkt** (`iroh.ts`, `@number0/iroh` 1.2.0, MIT OR Apache-2.0, kant-en-klare napi-binary):
- De pc draait een iroh-endpoint met een vaste sleutel (32 bytes in Secrets, naam `mobile.iroh.key`, gebruiker `''`).
  De publieke sleutel (*endpoint-id*) gaat in elke QR-code: `n=<id>` in het fragment, plus `r=<relay>` bij een eigen
  relay. De telefoon belt precies die sleutel; geen relay of opzoekdienst kan zich voor de pc uitgeven.
- iroh verbindt direct waar het kan (thuis op wifi, of met hole punching) en anders via een relay. Altijd versleuteld
  van telefoon tot pc (QUIC, TLS 1.3, op de sleutels van beide kanten); de relay ziet alleen versleutelde gegevens.
- ALPN `teambot/http/1`. Elke bidirectionele stream is één TCP-verbinding naar een **private telefoon-ingang** op
  `127.0.0.1:<willekeurig>` (dezelfde `Gateway` als bij wifi). Daar gelden exact dezelfde regels: alleen de app-schil,
  de openbare koppelroutes en `/api` + `/ws` met een **apparaat-token**; het eigenaar-token werkt nooit; daarna het
  telefoonbeleid (`policy.ts`). Elke telefoon krijgt een eigen vast adres in `fd7e::/16` (afgeleid van zijn sleutel)
  als `X-Forwarded-For`, zodat rate limits en het audit-log telefoons uit elkaar houden.
- Hooguit 32 telefoonverbindingen tegelijk. Aan/uit: `PUT /api/mobile/iroh` (beheerder, alleen op de computer;
  `policy.ts` weigert een telefoon). Audit: `mobile.iroh.enabled` / `mobile.iroh.disabled`.
- **Aan bij het koppelen.** Sinds 0.4.5 zet de kaart *Telefoon koppelen* hem vanzelf aan (`baseUrl: "auto"`, zie
  *Telefoon koppelen in één kaart*); onder *Meer opties › QR-code met een ander adres* doet de keuze
  *TeamBot-verbinding* hetzelfde (`baseUrl: "iroh"`). Zo'n code is `teambot://pair#t=…&n=…` en werkt alleen met de
  iPhone-app; een code voor wifi of Tailscale krijgt `&n=…` erbij zodra de verbinding aan staat (oudere apps en de
  koppelpagina lezen alleen `t`). Uitzetten: de schakelaar onder *Meer opties › Bereikbaarheid › TeamBot-verbinding*.
- Eerlijke status (`GET /api/mobile/reachability` › `iroh`): aan/uit, of de relay bereikt is, de laatste telefoon
  (direct of via de relay, rtt) en een foutmelding als de binary niet laadt.

**iPhone** (`mobile/ios/TeamBot/Connection/IrohTunnel.swift`, IrohLib 1.2.0 via SwiftPM, iOS 17.5+): een iroh-endpoint
plus een lokale proxy (`NWListener` op `127.0.0.1:<vaste poort>`); elke TCP-verbinding van de `WKWebView` wordt één
iroh-stream. Volgorde: wifi/LAN → Tailscale/https → TeamBot-verbinding. De verbinding wordt tegelijk gebeld en weer
gestopt zodra een adres antwoordt. De app zegt in het instellingenblad en kort bovenin hoe hij verbonden is: *Thuis, via
wifi*, *Via Tailscale*, *Via TeamBot-verbinding, direct* of *Onderweg via TeamBot-verbinding*.

**Gemeten** (`npm run iroh:live`, 9 november 2026, deze pc, relay `euc1-1.relay.n0.iroh.link`, 3 rondes):

| | Verbinden | Eerste antwoord | Daarna per verzoek | Pad |
|---|---|---|---|---|
| pc online bij de relay | 458 ms | | | |
| Normaal (alleen de sleutel, n0-opzoekdienst) | 229 ms | 299 ms | 2 ms | direct |
| Geforceerde relay | 224 ms | 325 ms | 69 ms (rtt 86 ms) | relay |

Geforceerd = de sockets van pc en "telefoon" zo gebonden dat er geen direct pad bestaat (`TEAMBOT_IROH_BIND`, alleen
voor deze test). Per test: koppelen, `GET /api/mobile/status`, het eigenaar-token geweigerd, de WebSocket.

**Testen:** `tests/mobile-iroh.test.ts` (zonder netwerk: `TEAMBOT_IROH_PRESET=offline`, de telefoon belt de directe
adressen; `tests/iroh-phone.ts` is de Node-versie van de iPhone-tunnel), `tests/mobile-pair-auto.test.ts` (0.4.5:
`baseUrl: "auto"` zet de verbinding aan, met Tailscale https het adres plus de sleutel, de startpagina
`#/inbox`), `npm run iroh:check` (de kaart *Telefoon koppelen* in Edge headless: QR-code meteen, een Node-telefoon
koppelt vanaf de kaart, stap 3 *Verbonden*, *Meer opties*, axe licht en donker en op 360 px), `npm run iroh:live`
(echte relays, met internet).

### Relays

- **Standaard:** de openbare relays van n0 (gratis, met snelheidslimiet, *"suitable for development and testing"*,
  geen garantie). Prima om te beginnen; voor iedereen standaard hoort er een eigen relay te staan.
- **Eigen relay-server** (*Instellingen › Geavanceerd tonen*, dan *Telefoon › Bereikbaarheid › Eigen relay-server*):
  een https-adres. De pc gebruikt dan alleen die relay; de QR-code geeft hem mee (`r=`), zodat de iPhone hem ook
  gebruikt. Leeg = terug naar n0.

### Eigen relay-server op een kleine VPS

Voor de eigenaar, later. Eén kleine server is genoeg voor veel gebruikers (chatverkeer is klein); n0 raadt twee regio's
aan voor uitval. Bijvoorbeeld een kleine VPS bij Hetzner (vanaf € 6,49 per maand excl. btw, prijs van 9 november 2026) met Debian of Ubuntu.

1. Een DNS-naam naar de server, bijvoorbeeld `relay.jouwdomein.nl` (A- en AAAA-record).
2. Open in de firewall van de VPS: **80/tcp** (Let's Encrypt), **443/tcp** (de relay) en **7842/udp** (QUIC-adresdetectie).
3. Download `iroh-relay` van de releases van n0-computer/iroh (bijv. `iroh-relay-v1.4.1-x86_64-unknown-linux-musl.tar.gz`),
   pak uit naar `/usr/local/bin/iroh-relay`. Licentie MIT OR Apache-2.0.
4. `/etc/iroh-relay.toml`:
   ```toml
   enable_relay = true
   http_bind_addr = "[::]:80"
   enable_quic_addr_discovery = true

   [tls]
   cert_mode = "LetsEncrypt"
   hostname = "relay.jouwdomein.nl"
   contact = "jij@jouwdomein.nl"
   cert_dir = "/var/lib/iroh-relay"
   prod_tls = true
   ```
   Wil je alleen je eigen TeamBots toelaten: `access.allowlist = ["<endpoint-id van je pc>", …]` (de id staat in de
   QR-link als `n=`). Let op: telefoons gebruiken dezelfde relay; met een allowlist moeten hun sleutels er ook in, dus
   standaard `access = "everyone"` (de relay ziet toch alleen versleutelde gegevens).
5. Een systemd-dienst `/etc/systemd/system/iroh-relay.service`:
   ```ini
   [Unit]
   Description=iroh-relay voor TeamBot
   After=network-online.target
   [Service]
   ExecStart=/usr/local/bin/iroh-relay --config-path /etc/iroh-relay.toml
   Restart=always
   DynamicUser=yes
   StateDirectory=iroh-relay
   AmbientCapabilities=CAP_NET_BIND_SERVICE
   [Install]
   WantedBy=multi-user.target
   ```
   `systemctl enable --now iroh-relay`, daarna `curl https://relay.jouwdomein.nl/` (antwoordt met een korte pagina).
6. In TeamBot: *Eigen relay-server* = `https://relay.jouwdomein.nl`, opslaan, en een nieuwe QR-code maken (al
   gekoppelde iPhones krijgen het adres vanzelf bij de volgende verbinding via `GET /api/mobile/status`).

Alternatief zonder eigen server: n0 Pro ($19 per maand incl. 100 GB). Lokaal proberen: `iroh-relay --dev` (http op
poort 3340) en `http://127.0.0.1:3340` als eigen relay (http mag alleen op loopback).

## Beperkingen en handmatige voorwaarden

- **Native iOS-app nog niet gecompileerd** (geen Mac hier). De bouwstraat staat klaar in de app-map zelf:
  `mobile/ios/.github/workflows/testflight.yml` (GitHub Actions, `macos-26`, Xcode 26+, automatisch ondertekenen via
  de App Store Connect API-sleutel, upload naar TestFlight voor interne testers). Die map wordt een eigen privé-
  repository; stappen voor de eigenaar in `docs/IOS_WINDOWS_RELEASE.md`. De oude workflow in de TeamBot-root
  (`.github/workflows/ios-companion.yml`) draait nergens meer (TeamBot zelf wordt niet gepusht).
- Wisselt het wifi-adres van de pc (DHCP) en is er geen Tailscale, dan vindt de app de pc niet terug (geen Bonjour);
  het scherm zegt dan *pc reageert niet* met de tip om Tailscale in te stellen.
- APNs pas actief met een Apple Developer-account en `.p8`-sleutel (env-variabelen, zie `mobile/ios/README.md`).
- Pushmeldingen in de browser vereisen https (Tailscale Serve, tunnel of eigen domein); via http (wifi) niet.
- Windows-firewall kan bij het aanzetten van telefoon-toegang om toestemming vragen.
- Splash-afbeeldingen per iPhone-model zijn niet gemaakt; iOS toont dan de achtergrondkleur.
- Wifi-verkeer is onversleuteld; dat staat in de UI en in de waarschuwing. De TeamBot-verbinding is ook thuis versleuteld.
- TeamBot-verbinding: alleen de iPhone-app (de browser/PWA en Android blijven op wifi, Tailscale of een eigen https-
  adres; de iroh-browserversie kan geen direct pad). `@number0/iroh` haalt ongeveer 8 MB/s (gemeten door OpenClaw):
  ruim voor chat, trager voor grote bestanden. De openbare n0-relays zijn bedoeld om te testen; zie *Eigen relay-server*.
- De Swift-kant van de TeamBot-verbinding is nog niet gecompileerd; de CI-build op GitHub bevestigt hem.
- Wat op de computer blijft (sessies, geheimen, export, beheer, kluis, koppelen) geeft op een telefoon 403; de app
  zegt dat op die plekken rustig (zie *In de app (0.4.2)*).
