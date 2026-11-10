# Module `network` — Netwerk, proxy en "standaard dicht"

Server `server/modules/network/`:
- `proxy.ts` + `index.ts`: één proxy voor uitgaand verkeer (hieronder);
- `exposure.ts`: de controle bij het starten wie TeamBot kan bereiken (§ Standaard dicht);
- `privacy.ts`: het privacylabel per engine, `privacyLabel()` (§ Privacylabel);
- `report.ts`: de gegevens voor **Wat verlaat je pc?** op de pagina Gegevens.

UI `ui/src/modules/network/`: Instellingen › Geavanceerd › **Netwerk en proxy** (alleen eigenaar/beheerder),
`Privacy.tsx` (label in de kop van een chat en de sectie *Privacy* in de bot-editor) en `DataPrivacy.tsx` (de kaart
**Wat verlaat je pc?** op `#/settings/data`). Tests: `tests/network-proxy.test.ts` (eigen testproxy die verzoeken telt
en Basic-login controleert) en `tests/security-defaults.test.ts`.

## Standaard dicht (0.4, pakket P)

Regel uit het plan: alles wat de pc verlaat, staat standaard uit en heeft een zichtbaar label.

- **Luisteren**: elke modus luistert standaard alleen op `127.0.0.1` (`server/core/config.ts`). Bereikbaar maken
  vanaf andere apparaten is een bewuste keuze: `TEAMBOT_HOST`/`--host`, de telefoon-toegang (module `mobile`, aparte
  poort, alleen apparaat-tokens, met waarschuwing) of Tailscale Serve. De Docker-image zet `TEAMBOT_HOST=0.0.0.0`
  binnen zijn eigen netwerk; `docker-compose.yml` publiceert de poort alleen op `127.0.0.1` van de host.
- **Controle bij het starten** (`checkExposure` in `exposure.ts`, aangeroepen door `createApp` vóór er iets
  luistert):

  | Combinatie | Wat TeamBot doet |
  |---|---|
  | Desktopmodus (eigenaar zonder wachtwoord) op een netwerkadres | **weigert te starten**; met `TEAMBOT_UNSAFE_EXPOSE=1` alleen een waarschuwing |
  | Servermodus via het netwerk zonder https (`TEAMBOT_PUBLIC_URL` niet `https://`) | luide waarschuwing in het logboek en op de pagina Gegevens |
  | `TEAMBOT_ALLOW_SIGNUP=1` | waarschuwing: iedereen die de server bereikt, kan een account maken |
  | `TEAMBOT_TRUST_PROXY=true`/`*` via het netwerk | waarschuwing: doorstuuradressen te vervalsen, limieten per adres omzeilbaar |
  | Verse server (nog geen eigenaar) | het eigenaar-account kan vanaf een ander apparaat alleen met een **eenmalige code** |

- **Eenmalige code bij de eerste start** (kern `Auth.setupCode`): een verse server in servermodus zonder
  `TEAMBOT_SETUP_TOKEN` maakt bij het starten een code `tbsetup_…` en zet de link alleen in de console (bij Docker
  `docker compose logs teambot`), nooit in `server.log` of een diagnosebestand. `POST /api/public/setup` vraagt de code
  van elk verzoek dat niet rechtstreeks van deze computer komt: geen loopback-verbinding, of een verzoek met
  `X-Forwarded-*`/`Forwarded`/`Via` (Tailscale Serve, een tunnel of een proxy op dezelfde machine), of een `Host` die
  geen loopback-naam is. `GET /api/public/status` zegt `setupCode: 'console'`, en het inlogscherm toont dan een veld
  *Eenmalige code*. Na de setup vervalt de code.
- **TeamBot stelt nooit Ollama of een andere lokale dienst bloot.** De enige luisteraars zijn de app zelf, de
  telefoon-toegang (stuurt alleen door naar TeamBot zelf, weigert absolute-form- en `CONNECT`-verzoeken) en websites
  van bots (alleen statische bestanden, alleen voor bezoekers uit het gekozen bereik). Ollama, LM Studio en andere
  lokale modelservers worden alleen door TeamBot zelf aangesproken (getest in `security-defaults.test.ts`).

## Privacylabel per bot

`privacyLabel(providerKind, model, context?)` uit `server/modules/network/privacy.ts` geeft per engine:

```ts
{ level: 'local' | 'lan' | 'no-store' | 'no-train' | 'unknown' | 'may-train',
  label: 'Blijft op je pc' | 'Blijft in je netwerk' | 'Bewaart niets' | 'Traint niet' | 'Privacy onbekend' | 'Kan trainen',
  detail: string,          // wie krijgt wat, wat doet die ermee, in gewone woorden
  receiver: string | null, // null = blijft op deze computer
  optOutUrl?: string,      // waar de eigenaar training uitzet
  policyUrl?: string,      // de eigen pagina van de aanbieder
  checkedAt: 'YYYY-MM-DD' }
```

- `context.baseUrl`: een "lokale" server op een ander apparaat is `lan` (privé-reeksen, Tailscale 100.64/10,
  `.local`, `.ts.net`), op internet `unknown`. Cloudmodellen van Ollama (`…-cloud`) zijn nooit `local`.
- `context.billing` voor abonnement-CLI's: `api` = traint niet; onbekend of `subscription` = het slechtste geval.
- **Uitbreiden** (bijvoorbeeld gratis aanbieders van pakket D):
  `registerPrivacyRule(kind, rule)` met een vast label of `(model, context) => label | null` (null = de ingebouwde
  regel). Geregistreerde regels gaan vóór de ingebouwde tabel, de laatste eerst; de functie geeft een functie terug die
  de regel weer weghaalt. Claim `no-store`/`no-train` alleen met de eigen pagina van de aanbieder (`policyUrl`) en de
  datum waarop je die las; anders `unknown`.
- Ingebouwd, nagekeken op 9 november 2026: Claude Code met claude.ai-abonnement *kan trainen* ("Help Claude
  verbeteren", 5 jaar of 30 dagen, uitzetten op `claude.ai/settings/data-privacy-controls`), Anthropic-API *traint
  niet* (30 dagen); Codex met ChatGPT Free/Plus/Pro *kan trainen* ("Het model voor iedereen verbeteren", standaard aan,
  `chatgpt.com/#settings/DataControls`), OpenAI-API *traint niet*; Gemini met gratis sleutel *kan trainen*; Groq
  *bewaart niets* (standaard; ZDR mogelijk); Mistral Experiment *kan trainen*; OpenRouter `:free` *kan trainen*,
  anders *onbekend*; Cloudflare, xAI, Azure, Bedrock, Vertex *traint niet*; NVIDIA-proef *kan trainen*; OpenCode per
  model (Big Pickle en de meeste gratis modellen *kan trainen*, GLM-5.3-Flash Free en DeepSeek V4.1 Flash Free
  *bewaart niets*). Alles wat niet is nagekeken: *privacy onbekend*.
- **Waar te zien**: in de kop van elke chat (klik = uitleg per engine en reserve), in de bot-editor (sectie
  *Privacy*, ook vóór opslaan) en op de pagina Gegevens (**Wat verlaat je pc?**).

## Wat verlaat je pc? (pagina Gegevens)

`GET /api/privacy/overview` (ook op een gekoppelde telefoon, zonder serverdetails) geeft: per bot de engines met hun
label, ander verkeer naar buiten (zoekdienst, kanalen, apps op internet en lokaal, pushmeldingen, websites, proxy;
telemetrie en openbare links altijd *uit*), waar de sleutels staan (AES-256-GCM; hoofdsleutel via Windows DPAPI,
macOS-sleutelhanger, Linux-kluis, `master.key` of `TEAMBOT_MASTER_KEY`), en voor eigenaar/beheerder wie TeamBot kan
bereiken (de controle van het starten, telefoon-toegang aan/uit). De kaart legt ook uit hoe je alles meeneemt
(Exporteren) en wist (verwijderen met de vraag om de gegevens mee te wissen, of de datamap; bij Docker het volume), en
dat wat al naar een AI-dienst ging daar volgens hun eigen termijn blijft.

## Proxy: wat het doet

- **Eén HTTP(S)-proxy voor het uitgaande verkeer van TeamBot**, serverbreed: adres (`http://` of `https://` met poort;
  SOCKS niet), een lijst **"Niet via de proxy"** en een optionele **login** (gebruikersnaam + wachtwoord).
- **Lijst "Niet via de proxy"**: namen (`intranet.bedrijf.nl`, ook alles eronder), domeinen (`.bedrijf.nl` of
  `*.bedrijf.nl`), IP-adressen en **IP-bereiken in CIDR** (`10.0.0.0/8`, `fd00::/8`), optioneel met poort
  (`192.168.1.7:8080`), of `*`. Standaard staan de privé-netwerken, `100.64.0.0/10` (Tailscale) en `.local` erop.
  **Loopback gaat altijd direct** (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`), wat er ook in de lijst staat —
  Ollama, LM Studio, lokale MCP-servers en TeamBot zelf blijven werken.
- **"Verbinding testen"**: haalt een testadres op *via* de proxy (ook als het op de lijst staat), met de ingevulde of
  opgeslagen login, zonder op te slaan. Resultaat in gewone taal: "Gelukt: … in 312 ms (HTTP 200)", "De proxy weigert
  de gebruikersnaam of het wachtwoord (407)", "… vraagt om een gebruikersnaam en wachtwoord", "… weigert de
  verbinding", "naam niet te vinden", "geen antwoord op tijd", "kon … niet bereiken (502)", "certificaat niet
  vertrouwd (eigen certificaat van de proxy wordt niet ondersteund)".
- **Direct actief, zonder herstart.** Nieuwe verbindingen volgen meteen de nieuwe instelling; verbindingen die al
  openstaan (een live kanaal) houden hun route tot ze opnieuw verbinden.

## Hoe het werkt (`proxy.ts`)

- **Global `fetch`** (Node's undici): TeamBot zet een kleine *router* in undici's globale dispatcher-slot
  (`Symbol.for('undici.globalDispatcher.2')` in Node 26 / undici 8, `.1` in Node 24 / undici 7 = Electron 45). Per
  verzoek kiest de router "direct" (de oorspronkelijke dispatcher) of "via de proxy" (Node's eigen
  `EnvHttpProxyAgent`, gemaakt met de publieke API `http.setGlobalProxyFromEnv`). De keuze maakt TeamBot zelf met de
  eigen regels (CIDR, loopback), want Node's NO_PROXY kent geen CIDR en fetch ook geen IP-bereiken. Geen extra
  afhankelijkheid.
- **`http.request` / `https.request` zonder eigen agent** (bijv. het downloaden van spraakmodellen): Node's
  proxybewuste globale agents uit dezelfde `setGlobalProxyFromEnv`-aanroep, met de lijst vertaald naar Node's NO_PROXY
  (CIDR → `a-b`-bereik; loopback altijd).
- **Vereist** `http.setGlobalProxyFromEnv` (Node 24.14+/25.4+; Node 26 lokaal, Electron 45 = Node 24.22). Ontbreekt
  dat, dan zegt de pagina dat eerlijk en wordt niets toegepast.
- **Login**: één versleuteld geheim `proxy_login` (`{ username, password }`, AES-256-GCM in `secrets`) van de beheerder
  die opsloeg. De API zegt alleen `hasAuth`; gebruikersnaam en wachtwoord komen nooit terug, ook niet in de audit
  (`network.proxy.update`: aan/uit, host:poort, aantal regels, wel/geen login) of de logs. "Laat leeg om te houden";
  "Wissen" verwijdert het geheim.

## De browser van de bots

De eigen **policy-proxy** van de bot-browser (`server/modules/browser/proxy.ts`) blijft altijd de eerste hop en doet
alle controles: alleen http(s), domeinlijsten van de bot, SSRF (geen loopback/LAN/metadata). Daarna:

- staat "Ook de browser van de bots" aan en valt de host niet onder "Niet via de proxy", dan **ketent** hij naar de
  proxy van de eigenaar: `CONNECT host:poort` voor https en WebSockets, een absolute-form verzoek voor gewone http. De
  login zet TeamBot erbij; Chromium ziet hem nooit. Een 407 van de proxy wordt geen inlogvenster maar een duidelijke
  melding voor de bot ("De proxy van de eigenaar weigert de inloggegevens").
- heeft het browserprofiel een **eigen proxy** (Computers › Browserprofielen › *Proxy…*, 0.4.4; zie
  `docs/modules/browser.md`), dan ketent hij voor die sessie naar die proxy in plaats van naar die van de eigenaar, op
  dezelfde manier (alleen loopback blijft direct). Andere profielen merken er niets van.
- anders gaat hij direct, zoals voorheen, naar het adres dat hij zelf opzocht en controleerde.
- De directe route gebruikt `agent: false`, zodat Node's (proxybewuste) globale agent nooit een omweg maakt.

## SSRF en namen die alleen de proxy kent

In bedrijfsnetwerken kan vaak alleen de proxy internetnamen opzoeken. Daarom: **lukt het opzoeken van een naam
lokaal niet** én gaat het verzoek via de proxy én lijkt de naam publiek (heeft een punt, geen `.local`, `.internal`,
`.lan`, `.home`, `.corp`, …), dan laat TeamBot het opzoeken aan de proxy over (`assertPublicUrl` via
`setProxyResolver`, en de policy-proxy van de browser). Wat lokaal **wel** opgezocht kan worden, wordt zoals altijd
gecontroleerd: een naam die naar een privé-adres wijst, blijft geblokkeerd; IP-adressen in privé-reeksen ook.
Restrisico: de proxy zoekt de naam zelf nog eens op (DNS-rebinding tussen beide opzoekingen); de proxy kan alleen
bereiken wat de beheerder hem laat bereiken.

## Wat gaat er niet via de proxy (eerlijk in de UI)

CLI-bots (Claude Code, Codex, OpenCode …) en de terminal (eigen processen: hun eigen instellingen, bijv.
`HTTPS_PROXY` in Windows), MCP-apps die als programma lokaal draaien, live WebSocket-verbindingen (Discord, Slack
Socket Mode, WhatsApp via QR, de OpenAI Realtime-stem), e-mail (IMAP/SMTP), SSH, app-updates (Electron volgt de
proxy van Windows) en alles op deze computer zelf.

## API

| Route | Wie | Wat |
|---|---|---|
| `GET /api/admin/network/proxy` | eigenaar/beheerder | instelling, `hasAuth`, `active`, `activeLabel`, `support`, `applyError`, standaardlijst |
| `PUT /api/admin/network/proxy` | eigenaar/beheerder | `{ enabled, url, noProxy (tekst of lijst), browser, username?, password?, clearAuth? }` → opslaan + direct toepassen |
| `POST /api/admin/network/proxy/test` | eigenaar/beheerder | `{ url?, username?, password?, target? }` → `{ ok, message, status?, ms }` (audit `network.proxy.test`) |
| `GET /api/admin/network/exposure` | eigenaar/beheerder | de controle van het starten: `{ host, loopbackOnly, https, findings[], gateway }` |
| `GET /api/privacy/agents/:id` | eigen bot (of gedeelde bot in servermodus), ook telefoon | `{ engines[{ role, provider, kind, model, privacy }], main, worst }` |
| `POST /api/privacy/engines` | iedereen | `{ engines: [{ provider_id, model }] }` → label per engine (bot-editor, vóór opslaan) |
| `GET /api/privacy/overview` | iedereen, ook telefoon | gegevens voor **Wat verlaat je pc?** (serverdetails alleen voor eigenaar/beheerder op een computer) |
