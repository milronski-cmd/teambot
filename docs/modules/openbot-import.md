# Module: Overstappen uit OpenBot, Hermes Agent en OpenClaw (`openbot-import`)

"Importeer je OpenBot-team": de eigenaar neemt zijn eigen OpenBot-team op deze computer in één keer mee naar TeamBot,
in het model van 0.4: **één team** (met de gedeelde map als teammap en de teamtabellen erbij), de baas als **hoofdbot**
(of als **teamleider**), een kennisbot als **specialist**, en **alle routines uit**. Eerst een voorvertoning die niets
schrijft, dan één knop Importeren, en daarna kan alles in één keer **ongedaan** worden gemaakt. Dit is een import van
**eigen gegevens**: er wordt geen code, tekst of beeldmateriaal van OpenBot overgenomen (OpenBot valt onder PolyForm
Noncommercial). OpenBot zelf wordt nooit veranderd.

Hetzelfde scherm neemt sinds 0.4.4 ook **Hermes Agent** (Nous Research, MIT) mee; zie *Uit Hermes Agent* hieronder.
En **OpenClaw** (MIT); zie *Overstappen uit OpenClaw* onderaan.
**Grok Bot** kan niet: het heeft geen export en bewaart niets op de computer, en dat zegt het scherm ook zo.

Server `server/modules/openbot-import/` (`reader.ts` lezen, `roles.ts` voorstellen, `bridges.ts` herkennen van andere
0.4-onderdelen, `service.ts` voorvertoning en import, `undo.ts` ongedaan maken; `hermes.ts` en `hermes-service.ts` voor
Hermes Agent). UI `ui/src/modules/openbot-import/` (`HermesImport.tsx` voor Hermes, `GrokNote` in `ImportPage.tsx`).

## Waar

- **Startscherm**: een balk "Je OpenBot-team overzetten" zodra een OpenBot-installatie gevonden is (alleen voor de
  eigenaar; verdwijnt na import of "niet nu").
- **Instellingen → Overstappen**: altijd bereikbaar, ook om later opnieuw in te lezen of de import ongedaan te maken.
- Pagina `#/m/openbot-import`: bovenaan *Waar kom je vandaan?* met de tabbladen **OpenBot** (standaard), **Hermes
  Agent** en **Grok Bot** (`?bron=hermes` / `?bron=grok` opent er direct een). Daarna voorvertoning → importeren →
  overzicht (met *Import ongedaan maken*). Instellingen → Overstappen heeft er een knop *Overstappen uit Hermes Agent*
  bij en, daaronder, het deel *Overstappen uit OpenClaw* (geen extra rij in Instellingen).

## Zo gaat het

1. **Voorvertoning (droog)**: `POST /preview` leest OpenBot in en laat precies zien wat er gemaakt wordt. In TeamBot
   en in OpenBot wordt dan nog niets geschreven (getest). Onderaan staat *Wat er gebeurt*: het team, de hoofdbot of
   teamleider, de bots, de specialisten, het aantal routines (uit), de teammap, de teamtabellen, skills en
   herinneringen, plus *Wat niet meekomt* (gesprekken: bewuste keuze; sleutels: nooit; kanalen, apps, OpenBot-skills,
   workflows, takenlijst, telefoonkoppeling).
2. **Importeren**: één knop. Een teamnaam die al bestaat wordt geweigerd vóór er iets is geschreven.
3. **Ongedaan maken**: eerst de lijst van wat weggaat (`GET /undo`, verandert niets), dan één knop (`POST /undo`).

## Het team (0.4)

| Wat | Hoe |
|---|---|
| Team | Eén team voor alle overgenomen bots. Naam: de naam van de OpenBot-werkruimte (`serverName` in `openbot-team-server-v2.json`, of de enige zijbalksectie), anders **Mijn team**; is die naam al bezet, dan **Team uit OpenBot**. Aan te passen in de voorvertoning; of kies een bestaand team. Standaard een bestaand team alleen als het het team van een eerdere import is, of het enige team en nog leeg. |
| Thuisteam | Elke bot krijgt `settings.homeTeam` bij het aanmaken (de teams-module leest dat) en wordt zo nodig nog verplaatst (`setHome`). |
| Teammap | `~/OpenBot/Shared` wordt de map van het team: **verwezen, nooit gekopieerd**, en de import schrijft er niets in. Nieuw team: voor alle bots van het team; bestaand team: alleen voor de overgenomen bots. Heeft het team al een andere map, dan blijft die (melding). |
| Teamtabellen | `~/OpenBot/Shared/Data/agent-data.db` (taken, beslissingen, gebeurtenissen, experimenten, logboek, eigen tabellen) wordt gekopieerd naar de teamdatabase. Per OpenBot-rij één keer; opnieuw importeren voegt alleen nieuwe rijen toe. Zodra de teamdatabase per team werkt (B2), krijgt de import de team-id mee (zie Afhankelijkheden). |

## Rollen

- **De baas** wordt herkend aan: een leider-markering in OpenBot (`role`/`kind` lead, orchestrator, main … of
  `orchestrator: true` in de agent-instellingen, of de agent die een chatkoppeling leidt via `orchestrator_agent_id`),
  de naam (precies "Baas", "Hoofdbot", "Teamleider" …; "Baas Live" niet: een variant zoals live/voice/stem/test is nooit
  de baas), en woorden in beschrijving of instructies ("hoofd-agent", "teamleider", "bewaakt het geheel" …). Lijken
  twee bots even veel op de baas, dan wordt er niets voorgesteld.
- **Hoofdbot**: heeft deze TeamBot de hoofdbot-rol (pakket C) en nog geen hoofdbot, dan wordt de baas voorgesteld als
  hoofdbot. De hoofdbot staat boven de teams, dus het team krijgt dan geen aparte teamleider (zelf te kiezen).
- **Nooit een tweede hoofdbot**: is er al een hoofdbot (via de teams-module of `settings.role === 'main'`), dan wordt
  de baas **teamleider**; ook als de aanvraag toch om een hoofdbot vraagt. Zonder hoofdbot-rol: teamleider, met die
  uitleg in de voorvertoning en het overzicht.
- **Teamleider** van een bestaand team dat al een teamleider heeft: die blijft.
- **Specialist**: een bot met een leerronde (een routine met kennis, kennisronde, kansenronde, research, nieuwsronde …
  in de naam) en een naam of beschrijving die daarbij past. **Vakgebied**: een regel "Vakgebied:" in de instructies,
  anders de eerste gewone zin ervan, anders de beschrijving (aan te passen in de voorvertoning). **Bronnen**: de regel
  "Bronnen:" in de instructies, links en subreddits uit de instructies, zijn routines en zijn eigen skills (logins,
  tokens, API's en localhost tellen niet). Met de specialisten-module (pakket S): `importForAgent` met het vakgebied en de bronnen met een link
  (als *voorgesteld*); de leerronde blijft uit. Zonder: een
  gewone bot, met vakgebied en bronnen bewaard in `settings.importedFrom.specialist`.

## Routines

**Altijd uit** (gepauzeerd, met de reden "zet aan wanneer je OpenBot stopt"), ook routines die in OpenBot aanstonden;
het overzicht toont de lijst *Staan uit tot jij ze aanzet*. Routines van de klantenservice-bot die klantberichten lezen
of beantwoorden (inbox, mail, WhatsApp, berichten …) krijgen een extra reden en melding: pas aanzetten nadat de
eigenaar een testrun heeft bekeken en goedgekeurd (versturen vraagt in TeamBot altijd toestemming).

## Kanalen

**Altijd uit en zonder token**, net als routines: niets pollt, logt in of scant een QR-code naast een draaiende OpenBot
(een Telegram-token kan maar door één app tegelijk gelezen worden). Telegram, Discord en Slack worden een kanaal in
TeamBot (via `ctx.services.channels.importPaused`): uit (`enabled: false`, `status: stopped`), zonder secrets, met de
bot die in OpenBot antwoordde (`orchestrator_agent_id`) en de toegestane afzenders (`projection_messaging_allowed_senders`,
bron `import`). WhatsApp (en een onbekend platform) komt niet als kanaal: dat koppel je op het overstapmoment opnieuw met
een nieuwe QR-scan (de waarschuwing vooraf blijft verplicht). Opnieuw importeren maakt een kanaal niet twee keer
(`config.importedFrom.id`); ongedaan maken verwijdert de kanalen van de import.

## Overstappen, stap voor stap

*Instellingen › Algemeen › Overstappen* toont het plan uit `docs/OVERSTAPPEN_OPENBOT.md` met de stand per stap:
back-up van beide apps (de TeamBot-back-up ziet TeamBot zelf, de OpenBot-back-up vinkt de eigenaar af), importeren,
een paar dagen naast elkaar (afvinken), de kanalen één voor één (per kanaal *Nog in OpenBot*, *Uit in OpenBot: nu
overzetten*, *In TeamBot* of *Aan in beide apps*), de routines aan, en terug. *OpenBot bekijken* leest een kopie van
OpenBots database (welke routines en kanalen aanstaan) en zijn run-marker (`openbot-run-marker-v1.json`: draait het?).
*Zet de routines aan* zet alleen de routines aan die in OpenBot aanstonden (de import onthoudt per routine `on`,
`customer` en het OpenBot-id), nooit klantenservice-routines, en niet zolang een draaiende OpenBot dezelfde routine nog
aan heeft.

## Wat wordt gelezen (alleen lezen)

| Bron | Gebruikt voor |
|---|---|
| `%APPDATA%\OpenBot\openbot.db` (+ `-wal`) | agents (+ leider-markering), routines + schema's, herinneringen (+ essential/searchable), kanalen (platform, naam, aan/uit, `orchestrator_agent_id`, toegestane afzenders; nooit tokens, `bot_user_id` of `app_id`), namen van MCP-servers |
| `openbot-run-marker-v1.json` | alleen `state`, `heartbeatAt` en `appVersion`: draait OpenBot nu? (Overstappen) |
| `~/OpenBot/Agents/<id>/AGENTS.md` (of `CLAUDE.md`) | instructies per bot (ook vakgebied en bronnen) |
| `~/OpenBot/Agents/<id>/{.agents,.claude,.codex,.opencode}/skills/*`, `~/.agents/skills/*`, `%APPDATA%\OpenBot\local-skills/*` | skills (teamversie wint) |
| `~/OpenBot/Shared` | teammap (alleen verwezen, nooit gekopieerd) |
| `~/OpenBot/Shared/Data/agent-data.db` | teamtabellen (privékopie) |
| `openbot-team-server-v2.json` | alleen `serverName` (teamnaam); sleutels, leden en sessies worden nooit overgenomen |
| `openbot-sidebar-layout-v1.json` | naam van de enige zijbalksectie (teamnaam) |
| `openbot-custom-providers-v1.json` | naam en adres van eigen providers (bijv. LM Studio); het `secret`-veld wordt nooit overgenomen |
| `openbot-sidebar-pins-v1.json` | welke bots vastgepind zijn |

**Nooit**: provider-sleutels, tokens, MCP `env`/`headers`, inloggegevens van servers, sleutels van de teamserver.
Databases worden naar een eigen tijdelijke map gekopieerd en die kopie wordt gelezen (ook met een draaiende OpenBot;
een onleesbare kopie wordt één keer opnieuw gemaakt). OpenBot-bestanden worden nooit voor schrijven geopend; de tests
controleren dat alle OpenBot-bestanden na voorvertoning, import en ongedaan maken byte-identiek zijn. Paden overschrijven
(tests/ontwikkeling, of een proefimport op een kopie): `TEAMBOT_OPENBOT_DIR` en `TEAMBOT_OPENBOT_HOME`. OpenBot bewaart
absolute werkmappen; staat de map van een bot ook onder de opgegeven home (`<home>/OpenBot/Agents/<id>`), dan wordt die
gelezen, zodat een kopie (of een verplaatste gebruikersmap) nooit de originele mappen leest.

## Vertaling per bot

| OpenBot | TeamBot |
|---|---|
| naam, beschrijving, `AGENTS.md` | `name`, `description`, `instructions` |
| provider `claude` / `codex` / `opencode` / `gemini` / … | CLI-provider `claude-code` / `codex-cli` / `opencode` / `gemini-cli` / …; wordt gekoppeld als de CLI hier staat en ingelogd is (geen sleutels nodig) |
| provider `deepseek`, `openai`, … (sleutel nodig) | "opnieuw verbinden": sleutel zelf invullen bij AI-providers |
| eigen provider (bijv. LM Studio op :1234) | `lmstudio` / `ollama` / `openai-compatible` |
| `model`, `reasoningEffort` | `model` (ongewijzigd), `reasoning` |
| `backupModels.order` (1–3 reserves) | gekoppelde reserves → `settings.fallbacks` (op volgorde), de eerste ook als `fallback`; de volledige lijst staat in `settings.importedFrom.backups` |
| `access: full` | Volledige toegang (versturen en betalen vragen nog wel toestemming) |
| `access: ask` | `ask` |
| `computerUse: true` | toolgroep `desktop` (toegestane apps, elke klik vraagt toestemming) |
| `avatarHue` / `avatarSeed` | kleur en gezicht; seed bewaard in `settings.importedFrom` |
| vastgepind | `pinned` |
| werkmap | standaard **verwijzen** naar de bestaande map; of kopiëren (≤ 1 GB, ≤ 10.000 bestanden) of een nieuwe lege map |
| skills van de eigenaar (geen licentie of MIT/Apache/BSD/ISC) | via de gewone skills-importer (scan, beleid, versies), ingeschakeld bij dezelfde bots |
| skills van OpenBot zelf (`.openbot-managed.json`, PolyForm-licentie, "made/modified by OpenBot") | **niet** overgenomen; gemeld met alternatief zoeken in de marktplaats |
| herinneringen | per bot (scope `agent`); standaard direct actief met essential = vastgezet; of als voorstel ter controle |
| routine `daily` / `weekly` / `monthly` / `once` / `interval` / `custom` | `weekly` (alle dagen) / `weekly` / `cron` (`m h dag * *`) / `once` / `interval` (+ anker) / `cron` |
| `missed_policy` `skip` / `run-once` | `missedPolicy` `skip` / `catchup` |
| `active` | **altijd uit** |

## Wat niet meekomt (in de voorvertoning)

- Gesprekken en bijlagen: bewuste keuze (schone start; ze blijven in OpenBot).
- Sleutels, tokens en wachtwoorden: nooit; opnieuw verbinden.
- WhatsApp en onbekende kanalen: opnieuw koppelen op het overstapmoment. Apps (MCP): opnieuw toevoegen.
- Eigen AI-diensten die geen bot gebruikt (bijv. LM Studio) en de instellingen van de OpenBot-app zelf.
- Skills van OpenBot zelf, workflows, de takenlijst en browserprofielen van OpenBot, de telefoonkoppeling.
- `run_in: chat`: TeamBot draait een routine in een eigen routinegesprek. "Volledige toegang" vraagt bij versturen en
  betalen nog wel toestemming.

## Opnieuw importeren

Idempotent: een bot met `settings.importedFrom.id` gelijk aan het OpenBot-agent-id wordt niet opnieuw gemaakt; een
routine met dezelfde bot en naam ook niet; teamtabelrijen staan per bronrij in de boekhouding van de teamdatabase;
herinneringen hebben een vaste sleutel per import-generatie. Opnieuw inlezen stelt het team van de eerdere import voor.

## Ongedaan maken

De import houdt bij wat hij maakte (instelling `openbotImport.ledger`, opgeteld over alle imports). *Ongedaan maken*
verwijdert: de bots (met hun routines en gesprekken; hun herinneringen gaan naar de prullenbak), de routines die de
import maakte, het team dat de import maakte (als het weer leeg is; anders blijft het met een melding), de hoofdbot- en
teamleiderrol die hij zette, de teammap die hij zette (een bestaand team krijgt zijn oude map terug), skills die hij
maakte en engine-koppelingen die hij legde (als geen andere bot ze gebruikt), de gekopieerde teamtabelrijen en tabellen
die hij maakte (als ze weer leeg zijn). Een werkmap die naar OpenBot verwijst blijft altijd staan; een gekopieerde of
nieuwe werkmap in TeamBot wordt verwijderd. Na ongedaan maken begint een nieuwe import-generatie, zodat opnieuw
importeren alles (ook herinneringen en tabelrijen) terugbrengt.

## Uit Hermes Agent

Hermes bewaart alles in zijn datamap (`HERMES_HOME`, standaard `~/.hermes`; TeamBot kijkt ook naar
`TEAMBOT_HERMES_HOME`). Staat Hermes ergens anders, bijvoorbeeld in WSL, dan typt de eigenaar de map in (een volledig
pad). De indeling is nagekeken in de broncode van Hermes (`tools/memory_tool_store.py`, `cron/jobs.py`,
`hermes_cli/profiles.py`, `tools/skills_sync.py`, `website/docs/user-guide/configuration.md`); er is geen code van Hermes
overgenomen, alleen de bestandsindeling gelezen.

| Hermes | TeamBot |
|---|---|
| Het standaardprofiel (de map zelf) en elk profiel in `profiles/<naam>/` | Eén bot per profiel: *Hermes*, en de profielnaam met een hoofdletter. Mappen met een punt of een ongeldige naam zijn geen profiel |
| `SOUL.md` | De instructies van de bot |
| `config.yaml` → `model.default`, `model.provider`, `timezone` | Model en engine (openrouter, anthropic, openai, `openai-codex` → Codex, `gemini` → Google Gemini-API, `x-ai` → xAI, deepseek, groq, mistral, ollama, lmstudio, `custom` met een adres → LM Studio/Ollama/eigen provider). Een engine die op deze computer draait wordt gekoppeld; een sleutel vul je opnieuw in. Verder wordt uit `config.yaml` niets bewaard |
| `memories/MEMORY.md` (stukken gescheiden door `
§
`) | Herinneringen van die bot, vastgezet (in Hermes staan ze altijd in de prompt) |
| `memories/USER.md` | Herinneringen onder *Over jou* (hetzelfde feit uit twee profielen één keer) |
| `skills/<categorie>/<naam>/SKILL.md` | Skills via de gewone skills-import (scan, versies). Wat in `skills/.bundled_manifest` staat komt met Hermes zelf mee (MIT) en staat standaard uit; `.archive` wordt overgeslagen. Elke bot krijgt de gekozen skills uit zijn eigen profiel |
| `cron/jobs.json` (`{ jobs: [...] }` of een losse lijst) | Routines die **uit** staan. Schema `interval` (minuten), `cron` (expressie) en `once` (`run_at`, met tijdzone omgerekend) en de tekstvorm (`every 2h`, `30m`, een cron-regel, een ISO-tijd). Een schema in woorden (`every monday 9am`) wordt niet geraden maar gemeld. Een script-taak zonder opdracht komt niet mee; bezorgen via een chat-app en een eigen model per taak worden gemeld |

**Nooit gelezen**: `.env` en `auth.json` (sleutels, tokens, logins) en de gesprekken (`sessions/`, `state.db`). Apps
(MCP) uit `config.yaml` worden alleen bij naam genoemd onder *Komt niet mee*. Hermes wordt alleen gelezen (getest: alle
bestanden en tijden gelijk). Ongedaan maken heeft een eigen boekhouding (instelling `hermesImport`): de bots (met hun
routines, gesprekken en herinneringen), skills en engine-koppelingen die de import maakte, en de herinneringen onder
*Over jou* (naar de prullenbak). Opnieuw importeren maakt geen dubbele bots of routines; na ongedaan maken brengt het
alles terug.

## API (alleen eigenaar)

- `GET /api/openbot-import/detect` — gevonden?, al geïmporteerd?, `undoable`, weggeklikt?
- `POST /api/openbot-import/preview` — leest in en geeft het plan (`stagingId`, 30 min geldig): `team`, `roles`,
  `bots`, `routines` (`off`, `customer`), `skills`, `shared`, `teamData`, `notImported`, `attention`, `undo`.
- `POST /api/openbot-import/commit` — `{ stagingId, team: { mode: 'new', name } | { mode: 'existing', id }, mainBot,
  lead, specialists: { <id>: { selected, field, sources } }, bots: { <id>: { selected, workspace } }, routines: [...],
  skills: [...], memories: 'active'|'review'|'off', shared, teamData, acknowledgeSkills }`. Weggelaten velden volgen
  het voorstel uit de voorvertoning.
- `GET /api/openbot-import/undo` — wat ongedaan maken zou verwijderen; `POST /api/openbot-import/undo` — doet het.
- `GET /api/openbot-import/cutover` — de stappen met hun stand; `POST /api/openbot-import/cutover/check` — OpenBot
  bekijken (kopie, alleen lezen); `POST /api/openbot-import/cutover/mark` `{ step: 'backup' | 'check', done }`;
  `POST /api/openbot-import/cutover/routines` — de routines aan die in OpenBot aanstonden (`{ started, skipped, status }`).
- `POST /commit` neemt ook `channels: [<OpenBot-connection-id>]` (weggelaten: het voorstel).
- `GET /api/openbot-import/last`, `POST /api/openbot-import/dismiss`.
- Hermes Agent: `GET /api/openbot-import/hermes/detect`, `POST /api/openbot-import/hermes/preview` (`{ path? }`),
  `POST /api/openbot-import/hermes/commit` (`{ stagingId, bots: [profiel], routines: [sleutel], skills: [naam],
  memories: 'active'|'review'|'off', acknowledgeSkills }`), `GET`/`POST /api/openbot-import/hermes/undo`.

## Afhankelijkheden (herkend, niet vereist)

`bridges.ts` gebruikt alleen de publieke diensten van de andere modules:

| Onderdeel | Gezocht | Zonder |
|---|---|---|
| Teams (pakket B) | `ctx.services.teams`: `list`, `team`, `botsOf`, `teamOf`, `create`, `update` (`leadAgentId`), `setHome`, `remove`, `teamFolder`, `setFolder` | geen team; de oude ene teammap (`teamFolder`-instelling) |
| Hoofdbot (pakket C) | `setMain` (+ `mainOf`, `clearMain` voor ongedaan maken) op `ctx.services.teams`; een bestaande hoofdbot ook via `settings.role === 'main'` | de baas wordt teamleider |
| Specialisten (pakket S) | `ctx.services.specialists.importForAgent(userId, agentId, { field, suggestedSources })` (de bronnen met een link, als *voorgesteld*; de leerronde blijft uit) | gewone bot, vakgebied en bronnen in `settings.importedFrom.specialist` |
| Teamdatabase per team (B2) | `ctx.services.teamdata` met `perTeam`/`teams === true`/`forTeam()` of `importTables` met een 5e argument; dan `importTables(…, { teamId })` en `importedCounts(…, { teamId })`. Ongedaan maken gebruikt `undoImport(userId, 'openbot', { teamId })` per team van de import: B2 weet welke rijen er kwamen, ook in tabellen die al bestonden (zoals `taken`) | één teamdatabase per eigenaar; ongedaan maken verwijdert de rijen via de boekhouding `teamdata_imports` |

## Tests

- `tests/openbot-team-import.test.ts` met een synthetisch OpenBot-team zoals dat van de eigenaar
  (`tests/fixtures/openbot-team-fixture.ts`: Baas, Baas Live, Kennis & Kansen, SEO & Content, Ads & Shopping,
  Operations, Klantenservice met een inbox-routine die uit staat, Bouwer; `~/OpenBot/Shared` met taken, beslissingen,
  gebeurtenissen, experimenten en een eigen tabel): de voorstellen (baas, specialist met vakgebied en bronnen,
  klantroutines, teamnaam), een voorvertoning die niets schrijft, import = precies het plan, ongedaan maken haalt alles
  weg en opnieuw importeren werkt, met nagebootste hoofdbot- en specialistenmodules (hoofdbot gezet, nooit een tweede),
  een bezette teamnaam wordt geweigerd zonder iets te schrijven, importeren in een bestaand team. OpenBot blijft
  byte-identiek; lokzinnen als geheimen komen nergens terecht. Ook met **alle echte modules** (hoofdbot van C2,
  specialisten van S, teamdatabase per team van B2): Baas wordt de echte hoofdbot, Kennis & Kansen een specialist met de
  leerronde uit, de tabellen staan in de teamdatabase van het team, en ongedaan maken haalt alle 8 overgenomen rijen weg.
- `tests/openbot-import.test.ts` (lezen, WAL van een draaiende OpenBot, vertaling per bot, werkmappen, alleen de
  eigenaar) en `tests/teamdata-import.test.ts` (teamtabellen).
- `tests/openbot-cutover.test.ts`: kanalen uit en zonder token (afzenders mee, WhatsApp opnieuw koppelen, niets verbindt,
  ongedaan maken haalt ze weg), een kopie leest alleen zijn eigen werkmappen, de stappen met hun stand, routines aan pas
  als OpenBot ze niet meer draait en nooit klantenservice. `npm run cutover:check`: het Overstappen-scherm in Edge
  (headless), met axe in licht en donker en 360 px.
- `tests/hermes-import.test.ts` met een nep-Hermes-map (`tests/fixtures/hermes/fixture.ts`: twee profielen, SOUL.md,
  MEMORY.md met Windows-regeleinden en een leeg stuk, USER.md, een eigen en een meegeleverde skill, een gearchiveerde,
  vier geplande taken waaronder een script-taak, de oude lijstvorm, lokzinnen als sleutels in `config.yaml`, `.env` en
  `auth.json`): vertaling van engines en schema's, lezen zonder te schrijven, voorvertoning → import → opnieuw →
  ongedaan maken → opnieuw, een andere map, een verkeerde map, controleren-modus.
- `tests/e2e/hermes-import.mjs` (Edge headless, op de computer en op 360 px, met axe) en stap 9b van
  `tests/e2e/phone-owner.mjs` (de gekoppelde telefoon): Instellingen → Overstappen, Hermes inlezen, importeren,
  ongedaan maken, Grok Bot.

## Overstappen uit OpenClaw (0.4.4)

**Overstappen uit OpenClaw** staat onder **Instellingen › Overstappen › Uit een andere app**, tussen Hermes Agent en
de zin over Grok Bot (`OpenClawCard embedded` uit `ui/src/modules/openbot-import/OpenClaw.tsx`, met een eigen
voorvertoning en eigen ongedaan maken). Server: eigen bestanden naast de OpenBot-import, zodat die los blijven: `openclaw-reader.ts` (lezen) en `openclaw.ts`
(voorvertoning, import, ongedaan maken, routes). OpenClaw is MIT: we lezen het bestandsformaat, er is geen code
overgenomen. OpenClaw zelf wordt nooit veranderd (getest: alle bestanden byte-identiek).

**Wat wordt gelezen** (alleen lezen):

| Bron | Gebruikt voor |
|---|---|
| `~/.openclaw` (`OPENCLAW_STATE_DIR`; oud: `~/.clawdbot`, `~/.moltbot`) | de map van OpenClaw |
| `openclaw.json` (JSON5; `OPENCLAW_CONFIG_PATH`) | alleen `agents.entries` of `agents.list[]` (id, naam, `identity`, werkmap, model) en de namen van de kanalen |
| werkmap per agent (`~/.openclaw/workspace`, anders `workspace-<id>` of `<agents.defaults.workspace>/<id>`) | `AGENTS.md` + `SOUL.md` → instructies (persoonlijkheid als eigen kopje), `IDENTITY.md` → naam en emoji, `USER.md` → voorstellen voor *Over jou*, `MEMORY.md` → voorstellen in het geheugen van de bot; `memory/*.md` (dagboek) wordt alleen geteld |
| `<werkmap>/skills/*`, `<werkmap>/.agents/skills/*`, `~/.openclaw/skills/*` | skills |
| `cron/jobs.json` (`{ version: 1, jobs }`); nieuwere installaties: tabellen over cron/jobs in `state/openclaw.sqlite` (een eigen kopie, met een JSON-kolom met `schedule`) | routines |

**Nooit**: `credentials/`, `.env`, `agents/<id>/agent/` (inlogprofielen, de eigen database), sleutels, tokens en
accounts in `openclaw.json` (`env`, `models.providers.*.apiKey`, kanaalaccounts, `gateway.auth`). Gesprekken
(`agents/<id>/sessions`) gaan niet mee. De test zet lokzinnen op al die plekken en controleert dat ze nergens in
TeamBot staan.

**Vertaling**:

| OpenClaw | TeamBot |
|---|---|
| agent | bot (toegang *Vragen*), `settings.importedFrom = { app: 'openclaw', id, model }`, werkmap verwezen (nooit gekopieerd of verwijderd) |
| model `anthropic/…`, `openai/…`, `google/…`, `openrouter/…`, `ollama/…` … | de engine van die familie als de eigenaar die al gekoppeld heeft (nooit een sleutel); anders "kies een engine" |
| skill | via de gewone skills-importer (scan, uitgeversbeleid), daarna **uitgeschakeld**; bij de bot die hem had wel gekoppeld |
| job `cron` (5 of 6 velden, `tz`) / `every` (`everyMs`, `anchorMs`) / `at` | routine `cron` (seconden vallen weg) / `interval` / `once`, **altijd uit** |
| payload `agentTurn.message`, `systemEvent.text` | de opdracht van de routine |
| payload `command` / `script`, schema `on-exit` / `stream` | niet overgenomen, met de reden |
| `USER.md`, `MEMORY.md` | voorstellen (Geheugen › Te beoordelen), nooit direct actief; geheimen geweigerd |

**API** (alleen eigenaar): `GET /api/openbot-import/openclaw/detect`, `POST …/preview` (plan met `stagingId`, 30 min),
`POST …/commit { stagingId, bots?, skills?, routines?, memories?: 'review'|'off', acknowledgeSkills? }` (weggelaten
lijsten volgen het voorstel), `GET …/undo` (wat weggaat) en `POST …/undo`. Een bot die al uit OpenClaw kwam wordt niet
opnieuw gemaakt; na ongedaan maken begint een nieuwe generatie, zodat opnieuw importeren alles terugbrengt.
Ongedaan maken haalt de bots (met hun gesprekken in TeamBot), routines, skills (als geen andere bot ze gebruikt) en
herinneringen van de import weg. Instelling `openclawImport` (laatste import en boekhouding). Paden overschrijven
(tests): `TEAMBOT_OPENCLAW_DIR`, `TEAMBOT_OPENCLAW_HOME`.

Tests: `tests/openclaw-import.test.ts` met `tests/fixtures/openclaw-fixture.ts`; UI in `tests/e2e/switch-skills.mjs`.
