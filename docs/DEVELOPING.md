# TeamBot — ontwikkelaarsgids (contract voor alle modules)

TeamBot is een open-source, local-first AI-agentteam. Eén Node/TypeScript-server (`server/`) + één React-UI (`ui/`)
draaien in drie vormen: **Windows-desktop** (Electron, `desktop/`), **server/self-host/cloud** (`npm start`, Docker) en
**telefoon** (dezelfde UI als PWA, gekoppeld via QR). Alles wat hieronder staat is bindend voor modules.

## Snel starten

```bash
npm install
npm run dev:server   # API op http://127.0.0.1:4747  (TEAMBOT_DATA=... voor een aparte datamap, --mode desktop voor lokale eigenaar)
npm run dev:ui       # Vite op http://localhost:5173 (proxy naar 4747)
npm run typecheck    # server + ui (TypeScript 7)
npm test             # node:test, tests/**/*.test.ts
npm run dup:check    # niets dubbel of dood: ongebruikte bestanden/exports (knip) en het aantal tools
```

Desktop-modus print een URL met `#token=...` (lokale eigenaar, geen wachtwoord). Servermodus vraagt bij eerste bezoek een
eigenaar-account aan te maken; vrienden komen erbij met een uitnodigingscode.

**Eigen datamap en poort.** Zonder `TEAMBOT_DATA` gebruikt de server dezelfde map als een geïnstalleerde TeamBot
(`%APPDATA%\TeamBot`, macOS `~/Library/Application Support/TeamBot`, Linux `~/.local/share/teambot`). Geef bij
ontwikkelen daarom altijd een eigen map op, bijvoorbeeld `.data/dev` (staat in `.gitignore`). Draait TeamBot zelf al
op deze pc, dan is poort 4747 bezet: kies een andere poort en wijs de UI-proxy daarheen.

```bash
TEAMBOT_DATA=.data/dev npm run dev:server -- --mode desktop --port 4748
TEAMBOT_DEV_SERVER=http://127.0.0.1:4748 npm run dev:ui
```

PowerShell: `$env:TEAMBOT_DATA='.data\dev'; npm run dev:server -- --mode desktop --port 4748` en in een tweede venster
`$env:TEAMBOT_DEV_SERVER='http://127.0.0.1:4748'; npm run dev:ui`. Ook `npm run desktop:dev` gebruikt zonder
`TEAMBOT_DATA` de map van je geïnstalleerde TeamBot.

Een desktopserver haalt twee minuten na de start vanzelf het zoekmodel op (±124 MB). `npm test` slaat dat altijd over;
een e2e- of proefserver doet hetzelfde met `TEAMBOT_NO_AUTO_DOWNLOAD=1` (`fetchesModelBySelf` in
`server/modules/memory/index.ts`). Slim zoeken met de hand aanzetten downloadt het wel.

## Niets dubbel (`npm run dup:check`)

Per taak één onderdeel. Draai `npm run dup:check` vóór je iets oplevert; het faalt als:

- een bestand of een export door niets in het product gebruikt wordt (knip in productiemodus, instellingen in
  `knip.json`). Haal het weg. Gebruikt alleen een test het (een testhaak zoals `setOcrForTests`), controleer dat en zet
  het dan op de lijst met `node scripts/dup-check.mjs --update` (`scripts/dup-baseline.json`);
- een toolnaam twee keer geregistreerd wordt, of een bot met Volledige toegang meer tools krijgt dan het getal in
  `tests/dup-guard.test.ts`. Een nieuwe taak hoort eerst bij een bestaande tool; komt er echt een tool bij, verhoog dat
  getal dan bewust in dezelfde wijziging (en verlaag het als je tools samenvoegt).

knip is geen afhankelijkheid van TeamBot (het komt dus niet in de installer): het script haalt het op met
`npx --yes knip@5`, daarvoor is internet nodig. Vaste regels die hierbij horen: gevaarlijke opdrachten staan alleen
in `server/tools/builtin/command-risk.ts`, "komt dit van de eigenaar zelf?" alleen in `server/agent/owner-turn.ts`,
"ligt dit pad binnen die map?" alleen in `isInside` (`server/tools/builtin/files.ts`), en getallen die het scherm en
de server allebei tonen in `shared/` (zoals `shared/loopGuard.ts`).

## Architectuur in één scherm

- `server/core/` — config, SQLite (`node:sqlite`, geen native modules), migraties, `Store` (repositories + generieke
  `insert/update/get/find`), `EventBus`, `Secrets` (AES-256-GCM), `Auth` (gebruikers, sessies, uitnodigingen, koppelcodes),
  `types.ts` (alle gedeelde types — lees dit bestand eerst).
- `server/providers/` — `ProviderKind`-catalogus (`kinds.ts`), OpenAI-compatibele streaming-adapter, Anthropic-adapter
  (officiële SDK), `ProviderRegistry` (configuraties per gebruiker, gedeelde providers, sleutels in Secrets).
- `server/tools/` — `ToolRegistry` (statische tools + dynamische tool-providers per agent), `Broker` (de enige
  permissiepoort + goedkeuringen/vragen), ingebouwde tools (bestanden, shell, web, ask_user, notify_user).
- `server/agent/` — `RunManager` (`runs.ts`: persistente wachtrij, 1 run per thread+agent, stop/hervat) en de run zelf,
  elk deel in een eigen bestand: `runner.ts` (welke engine antwoordt, en wat er gebeurt als die niet kan),
  `chat-loop.ts` (een beurt op een API-engine: model → tools → model), `cli-loop.ts` (een beurt op een CLI-engine),
  `prompt.ts` (systeemprompt, per-turn context), `engines.ts` (de engines van een run en hun limieten), `retries.ts`
  (opnieuw proberen na een limiet, pauzeren van belangrijk werk), `budget.ts` (dagbudget en gebruik), `fallback.ts`
  (de regels, als pure functies). Verder `history.ts` (provider-neutrale geschiedenis) en `ChatService` (berichten
  plaatsen + routeren, events).
- `server/api/` — REST-routes van de kern. `server/modules/<id>/` — featuremodules. `server/app.ts` — bootstrap,
  HTTP, WebSocket `/ws` (gesigneerde URL). Een module die niet kan starten houdt de rest niet tegen; hij staat in het
  logboek en in het diagnosebestand (`startupProblems`).
- `desktop/` — de Electron-schil. De app start in `boot.ts` (→ `dist/desktop/main.js`): die vangt een mislukte start op
  (logboek `<data>/logs/desktop.log`, een gewone melding met *Opnieuw proberen*) en laadt dan pas de schil zelf
  (`main.ts` → `dist/desktop/shell.js`). De schil meldt zich met `app.emit('teambot:started')` of
  `app.emit('teambot:start-failed', fout)`.
- **Links naar bestanden, afbeeldingen, streams en de WebSocket**: nooit de sessietoken in een URL. Gebruik `authUrl(path)`
  of `fileUrl(id)` uit `ui/src/lib/api.ts`: die signeren elk pad (HMAC met de URL-sleutel van de sessie, alleen GET/HEAD,
  ~15 min geldig, ingetrokken met de sessie; `Auth.resolveSigned`). Zet extra parameters ín het pad
  (`authUrl('/x/stream?k=1')`), nooit achter de gesigneerde URL; de handtekening staat altijd achteraan.
- `shared/` — code dat de interface, de server en de desktop-schil alle drie gebruiken (talen, opmaak van getallen en
  datums, het woordenboek-mechanisme, toollabels, modelnamen, accentkleur, botgezichten). De server importeert nooit uit
  `ui/src`; de oude paden in `ui/src` zijn één regel die doorverwijst.
- `ui/src/lib/` — `api.ts` (fetch + WebSocket `on(type, cb)`), `store.ts` (zustand, live events), `types.ts`, `router.ts`
  (hash-router). `ui/src/components/ui.tsx` — gedeelde componenten (Button, Input, Card, Modal, Tabs, Toggle, Badge,
  Avatar, PageHeader, Page, toast, useAsync). `ui/src/modules/<id>/index.tsx` — UI-module (contract: `ui/src/modules/types.ts`).

## Servermodule-contract (`server/modules/<id>/index.ts`)

Default export van een `Module` (`server/core/types.ts`):

```ts
const mod: Module = {
  id: 'memory', label: 'Geheugen',
  migrations: [{ id: 'memory-001', sql: `CREATE TABLE memory_items (...)` }],   // id's uniek, prefix = module-id
  init(ctx) { /* routes, tools, hooks, services registreren — synchroon/snel */ },
  start(ctx) { /* achtergrondwerk starten (schedulers, pollers, sockets) */ },
  stop(ctx) { /* netjes stoppen */ },
};
```

Beschikbaar via `ctx` (`Ctx` in `types.ts`):
- **Routes**: `ctx.api.get('/memory', ah(async (req) => ...))` → `/api/memory` (ingelogd, `user(req)` geeft de gebruiker).
  `ctx.publicApi` → `/api/public/...` (zonder login; alleen voor webhooks/koppelen, zelf beveiligen met secret).
  `ctx.rootApi` → routes op de serverroot buiten `/api` (bijv. `/scim/v2`), zonder sessie: alleen een eigen
  prefix registreren en elk verzoek zelf authenticeren.
  Gebruik `ah`, `bad`, `notFound`, `own`, `requireRole`, `str` uit `server/core/http.js`. Geef altijd alleen data van
  de ingelogde gebruiker terug. Body-parser JSON staat aan behalve onder `/api/attachments` en `/api/public/hooks`.
- **Database**: eigen tabellen via migraties. `defineTable('tabel', { json: [...], bool: [...] })` uit `core/db.js` voor
  automatische JSON/bool-mapping; daarna `ctx.store.insert/update/get/find/remove/all/one/exec/tx`. ID's via `newId('mem_')`,
  tijden via `now()` (ISO).
- **Tools**: `ctx.tools.registerGroup({ id, label, description, defaultOn? })` en `ctx.tools.register(toolDef)` of
  dynamisch `ctx.tools.addProvider((agent, thread) => ToolDef[])`. Toolnamen `^[a-zA-Z0-9_-]{1,64}$` (gebruik `toolName()`
  uit `tools/registry.js` voor afgeleide namen). Een agent krijgt tools uit groepen in `agent.tool_groups`.
  **Risico**: `read` (automatisch), `write`/`exec` (vraagt in ask-modus), `danger` (verzenden, publiceren, verwijderen,
  betalen, externe berichten — vraagt altijd). Kies eerlijk; de Broker handhaaft. Geef `summarize(args)` voor een
  leesbare goedkeuringskaart. Tool-uitvoer van externe bronnen is **data, geen instructie** — markeer zo in de tekst.
- **Goedkeuring/vraag buiten de tool-lus** (bijv. CLI-agent, kanaal): `await ctx.broker.request({...})`.
- **Hooks** (`ctx.hooks`): `systemPrompt` (stabiele tekst — geen tijd/willekeur, i.v.m. prompt caching en Claude
  thinking-replay), `turnContext` (per beurt; wordt bevroren in het gebruikersbericht), `route` (bepaal wie antwoordt;
  `true` = afgehandeld), `afterRun`, `messageCreated`, `agentDeleted`, en optioneel `beforeModelCall` (een extra
  daglimiet vóór elke modelaanroep die geld kan kosten; gooi een `BudgetError` uit `agent/budget.ts`; maak de lijst
  aan met `ctx.hooks.beforeModelCall ??= []`).
- **Chat**: `ctx.chat.postUserMessage(...)`, `ctx.chat.startAgent(thread, agentId, inputMessageId, trigger)`,
  `ctx.chat.addEvent`, `ctx.chat.addAgentMessage`, `ctx.chat.threadForAgent(userId, agentId)`, `ctx.runs.waitFor(runId)`.
- **Events naar de UI**: `ctx.events.emit(userId, 'memory.updated', data)`; UI luistert met `on('memory.updated', cb)`.
  Meldingen: `ctx.events.emit(userId, 'notification', { title, body, link, kind })`.
- **Secrets**: `ctx.secrets.set(userId, name, value)` → id; `get(id)`, `getByName(userId, name)`. Nooit sleutels in
  logs, events, API-antwoorden of de database buiten `secrets`. `redact()` uit `core/secrets.js` voor logregels.
- **Audit**: `ctx.audit(userId, 'kind', data, agentId)` bij elke actie met impact.
- **Diensten delen**: `ctx.services.<naam> = {...}` (bijv. `ctx.services.memory.search(...)`) zodat andere modules het
  kunnen gebruiken; controleer altijd op bestaan (`ctx.services.memory?.search`). Biedt een dienst `exportUser(userId)`
  aan, dan neemt de volledige export die mee.
- **Providers toevoegen**: `ctx.providers.registerKind(kind)`; een CLI-agent implementeert `runAgent` i.p.v. `chat`.
- **Eén korte modelaanroep** (zonder tools, buiten de chat: samenvatten, beoordelen, iets uit tekst halen): altijd via
  `server/agent/short-call.ts`. `pickShortEngine` / `judgeEngine` kiezen de engine (eigen keuze → gratis catalogus →
  engine van de bot → andere engines zonder extra kosten; betaald alleen met `allowPaid`), `runShortCall` doet de
  aanroep (dagbudget, time-out, één regel in `usage_log`), `parseJsonObject` leest het antwoord en `estimateTokens`
  (`server/core/tokens.ts`) is de enige tokenschatting. Geen eigen `adapter.chat` met `usage_log`-insert in een module.

## UI-module-contract (`ui/src/modules/<id>/index.tsx`)

Default export `UIModule` (`ui/src/modules/types.ts`): `pages` (onder `#/m/<id>/<path>`),
`agentSections` (secties in de bot-editor, `onChange(patch)`), `composerActions`, `chatHeaderActions`, `inspectorTabs`,
`settingsTabs`, `toolRenderers`, `messageExtras`, `init()`. De zijbalk is vast (Wacht op jou, Taken, Routines, Geheugen,
Marktplaats, Instellingen; `ui/src/shell/nav.tsx`); `nav: true` doet niets meer. Een pagina of instellingstabblad krijgt
zijn plek in Instellingen via `ui/src/lib/palette.ts` (een pagina blijft op zijn eigen adres en verschijnt binnen
Instellingen). Instellingen heeft vier groepen met hoogstens tien regels (`MAIN_GROUPS`) en één regel Geavanceerd;
**nieuwe onderdelen gaan naar `ADVANCED_SECTIONS` (de pagina Geavanceerd), tenzij een normaal mens ze elke week nodig
heeft**; niet ingedeeld = Geavanceerd › Overig, altijd zichtbaar. Op een instellingenpagina staan de 2–4 dingen die
mensen echt aanpassen bovenaan, de rest in één `MoreOptions` ("Meer opties", `components/MoreOptions.tsx`); per vak een
korte titel en hoogstens één korte regel uitleg, langere uitleg achter `MoreInfo` ("Meer informatie",
`components/MoreInfo.tsx`; `block` voor een lijst). Een instelling kies je met één vaste soort knop
(`components/SettingControls.tsx`): aan/uit is een schakelaar (`SwitchRow`), 2–4 keuzes een segmentknop (`Segmented`),
meer keuzes een keuzemenu (`Dropdown`; `Choice` kiest zelf); een wijziging wordt meteen opgeslagen via `useSave()`, dat
in de `SettingsSection` kort "Opgeslagen" toont (geen Opslaan-knop), en `onReset` geeft het vak "Standaard terugzetten".
Een tekstveld alleen voor namen, adressen, sleutels en instructies. Iets voor gevorderden toon je
alleen als `useAdvanced()` (`ui/src/shell/advanced.ts`, *Instellingen › Geavanceerd tonen*) waar is: verbergen, nooit
weghalen; een diepe link en Ctrl+K werken altijd. Gebruik uitsluitend de componenten uit
`components/ui.tsx` en Tailwind-klassen met de tokens (`bg-surface`, `bg-surface-2`, `bg-canvas`, `text-fg`, `text-muted`,
`border-line`, `bg-accent`, `text-accent`, `bg-accent-soft`, `text-ok/warn/danger`, `bg-*-soft`). Iconen: `lucide-react`,
16 px (`size-icon`) in knoppen en regels, 20 px (`size-icon-lg`) voor plekken. Hoeken uit één schaal (`styles.css`):
`rounded-control` 8 (knoppen, velden), `rounded-card` 14 (kaarten), `rounded-group` 16 (groepen, popovers),
`rounded-bubble` 20 (chatballonnen), `rounded-dialog` 24 (dialogen); afstand in stappen van 4 px. Diepte met een rand
en een vlakkleur; een schaduw (`shadow-pop`) alleen op wat zweeft: menu's, popovers, meldingen. Elke pagina heeft lege/laad/fout-staten, werkt op 360 px breed (telefoon) en in licht én donker thema.
Data: `api.get/post/...` uit `lib/api`, live via `on(...)`, gedeelde staat via `useApp` uit `lib/store`.

## Regels

1. **Taal**: schrijf alle tekst voor gebruikers in het **Nederlands** (duidelijk, kort); dat is de brontaal, de
   andere 10 talen komen uit woordenboeken (`ui/src/i18n/<code>.json`). Code/comments mogen Engels. Zodat elke taal
   het kan vertalen: hele zinnen, geen losse stukken rond een getal en geen geplakte meervouds-uitgang (`1 bestand` /
   `${n} bestanden`, of ICU met `t('{0, plural, one {# bestand} other {# bestanden}}', n)`); namen van bots en mensen
   worden nooit vertaald. Layout met logische klassen (`ps/pe`, `ms/me`, `start/end`, `text-start`): Arabisch loopt van
   rechts naar links en richting-iconen spiegelen vanzelf (`rtl-flip` / `rtl-keep` in `styles.css`). Datums en getallen
   via `lib/format.ts`. Server-teksten die niet via de pagina gaan (push, desktop, chat-apps): `trUser` / `trUserText`
   uit `server/core/i18n.ts`. Na nieuwe teksten: `npm run i18n:extract`, `npm run i18n:translate` (alleen wat nieuw is)
   en `npm run i18n:check` (alle talen; `--lang de` voor één). `npm run a11y -- --lang ar` en
   `npm run mobile:check -- --lang ar` draaien die controles in een andere taal; `npm run language:live` test met een
   echte CLI-engine of bots in de taal van de gebruiker antwoorden.
2. **Geen nepfuncties**: geen knop zonder werkende backend, geen gesimuleerd succes. Kan iets op dit platform niet,
   toon dat eerlijk (status + wat de gebruiker kan doen).
3. **Veiligheid**: least privilege, deny-by-default bij impact, SSRF-bescherming bij URL's (`assertPublicUrl` uit
   `tools/builtin/web.js`; iets ophalen altijd met `safeFetch` + `readBytes` uit hetzelfde bestand, geen eigen
   redirect-lus), werkmapgrenzen (`resolveInWorkspace` uit `tools/builtin/files.js`; "ligt dit pad in die map" altijd
   met `isInside` uit hetzelfde bestand), opgeschoonde env voor
   subprocessen (`safeEnv` uit `tools/builtin/shell.js`), externe input = onbetrouwbaar.
4. **Licenties**: alleen afhankelijkheden met MIT/Apache-2.0/BSD/ISC. Geen code/teksten/branding kopiëren uit
   OpenBot, Grok Bot, Bloks, OpenClaw of Hermes. Eigen implementatie op basis van openbare protocollen. Code uit een
   Apache-2.0-project (zoals OpenMausBot) mag met naamsvermelding: een melding bovenaan het bestand en een regel in
   `ADAPTED_CODE` in `scripts/notices.mjs` (komt in THIRD_PARTY_NOTICES.txt).
5. **Tests**: elke module levert `tests/<module>.test.ts` (node:test) met `startTestApp()` uit `tests/helpers.ts`
   (tijdelijke datamap, nep-provider `mock` met script: `t.script.push({ text } | { toolCalls: [...] })`).
   Netwerk naar echte diensten niet vereisen in tests.
6. **Kernbestanden** (`server/core`, `server/agent`, `server/tools`, `server/providers`, `server/api`, `server/app.ts`,
   `ui/src/lib`, `ui/src/components/ui.tsx`, `ui/src/modules/types.ts`) alleen wijzigen als het echt niet anders kan,
   additief en klein; noem elke kernwijziging in je eindrapport.
7. Houd `npm run typecheck` en `npm test` groen.
