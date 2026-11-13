# Module: CLI-agents (`cli-agents`)

Bots kunnen draaien op de **officiële agent-CLI's die de gebruiker zelf heeft geïnstalleerd en waarmee hij zelf is
ingelogd** (eigen abonnement of eigen API-sleutel), naast de API-providers van de kern. TeamBot start de ongewijzigde
CLI als subproces in de werkmap van de bot, streamt tekst/redeneren/tool-activiteit live naar de chat, bewaart de
sessie per gesprek en stuurt elke goedkeuring van de CLI via de centrale Broker naar de gebruiker (UI en telefoon).
TeamBot installeert alleen iets als jij daar uitdrukkelijk om vraagt (een knop met bevestiging, via het officiële
npm-pakket). Het logt nergens voor je in, leest of kopieert geen tokens en verkoopt of deelt geen toegang.

**TeamBot-tools in de CLI.** Per run krijgt de CLI een eigen MCP-server, `teambot`, met de tools van de bot:
geheugen, delegeren, de eigen browser, desktop, skills, routines, kanalen, `share_file` en gekoppelde apps. Die
werkt met hetzelfde beleid en dezelfde goedkeuringen als bij API-bots. Ook staan hier de reserve-engines en
"Volledige toegang"; zie [ADR 0008](../adr/0009-teambot-tools-in-cli-engines.md).

Catalogusregels (plan §21.4): P0 *Anthropic/Claude Code flow*, *officiële Codex CLI/App Server-flow*, *custom ACP
runner*, *install/auth-state*, *timeout/cancel*, *model availability*; P1 *Gemini, OpenCode, Cursor, Cline, Kimi,
Copilot, Hermes, Grok (CLI), Qwen* (alleen waar officieel ondersteund), *usage/budget*; acceptatie *no subscription
resale or login circumvention*, *CLI plan terms surfaced*, *test connect without surprise billable prompt*.

## Ondersteunde CLI's

| Provider-kind | CLI | Motor | Opstart | Bron |
|---|---|---|---|---|
| `claude-code` | Claude Code | stream-json | `claude -p --output-format stream-json --verbose …` (prompt via stdin) | `claude --help` (2.1.319), code.claude.com/docs |
| `codex-cli` | OpenAI Codex CLI | `exec --json` + app-server | `codex exec --json … -` / `codex app-server` | `codex exec --help`, `codex app-server generate-ts` (0.166.0), learn.chatgpt.com/docs |
| `gemini-cli` | Gemini CLI | ACP | `gemini --acp` (val terug op `--experimental-acp` als `--help` dat zegt) | gemini-cli docs/cli/acp-mode.md |
| `qwen-code` | Qwen Code | ACP | `qwen --acp` (idem) | QwenLM/qwen-code |
| `opencode` | OpenCode | ACP | `opencode acp` | opencode.ai/docs/acp |
| `copilot-cli` | GitHub Copilot CLI | ACP | `copilot --acp` | docs.github.com … acp-server |
| `cursor-cli` | Cursor CLI | ACP | `agent acp` (binary `cursor-agent` of `agent`, gecontroleerd via `--help`) | cursor.com/docs/cli/acp |
| `kimi-code` | Kimi Code CLI | ACP | `kimi acp` | MoonshotAI/kimi-code |
| `hermes-agent` | Hermes Agent | ACP | `hermes acp` | NousResearch/hermes-agent |
| `grok-build` | Grok Build (xAI) | ACP | `grok agent stdio` | docs.x.ai/build |
| `cline-cli` | Cline CLI | ACP | `cline --acp` | docs.cline.bot/usage/acp |
| `antigravity` | Google Antigravity CLI (experimenteel) | ACP | `agy acp`; opvolger van de Gemini CLI voor gratis en AI Pro/Ultra-accounts (sinds 18-06-2026) | antigravity.google/docs |
| `goose` | Goose | ACP | `goose acp` met `GOOSE_MODE=approve` (standaard "auto" vraagt niets) | goose-docs.ai/docs |
| `devin-cli` | Devin CLI | ACP | `devin acp` | docs.devin.ai/cli |
| `auggie` | Augment Auggie | ACP | `auggie --acp` (`AUGMENT_DISABLE_AUTO_UPDATE=1`) | docs.augmentcode.com/cli/acp |
| `factory-droid` | Factory Droid (experimenteel) | ACP | `droid exec --output-format acp` (de ACP-registry noemt `acp-daemon`; niet in Factory's docs) | docs.factory.ai |
| `mistral-vibe` | Mistral Vibe (experimenteel) | ACP | apart programma `vibe-acp` | docs.mistral.ai/vibe |
| `junie-cli` | JetBrains Junie | ACP | `junie --acp=true` | junie.jetbrains.com/docs/junie-cli-acp.html |
| `kiro-cli` | Kiro CLI (AWS) | ACP | `kiro-cli acp` (v3-engine; model via ACP, niet via `--model`) | kiro.dev/docs/cli/acp |
| `kilo-code` | Kilo Code CLI | ACP | `kilo acp`; gratis `:free`-modellen | kilo.ai/docs |
| `amp-acp` | Amp via amp-acp (experimenteel) | ACP | community-adapter `amp-acp` (Amp zelf heeft geen ACP), hergebruikt `amp login` | ampcode.com/docs |
| `acp-custom` | Eigen ACP-agent | ACP | zelf ingesteld programma + argumenten | agentclientprotocol.com |
| — | Pi coding agent | — | **niet ondersteund**: geen eigen ACP en vraagt volgens eigen docs nooit toestemming; ook de community-adapter `pi-acp` vraagt niets voor tool-aanroepen → toegangsmodus niet af te dwingen. Wordt eerlijk zo getoond. | earendil-works/pi |

Alle opdrachten, pakketnamen en loginstappen zijn op 2026-11-07 nagelopen tegen de documentatie van de makers en de
ACP-registry (`cdn.agentclientprotocol.com/registry/v1/latest/registry.json`). Wat niet eenduidig te controleren was,
staat in de app als **experimenteel**. Niet opgenomen: OpenHands CLI (niet meer onderhouden), Charm Crush (geen ACP),
Docker Agent (vraagt een eigen agent.yaml; kan via "Eigen ACP-agent"). Live getest op deze pc (2026-11-07,
`npm run providers:live -- --only-cli`): Claude Code 2.1.319 (Max-abonnement), Codex 0.167 (ChatGPT) en OpenCode 2.2.5
(gratis model, afgeschermde HOME/XDG).

Installatie- en loginopdrachten (officieel, voor de gebruiker om zelf te draaien) staan in `catalog.ts` en worden in
de UI getoond met kopieerknop.

## Toegangsmodus → CLI (nooit ruimer)

| Modus | Claude Code | Codex | ACP-agents |
|---|---|---|---|
| chat | `--tools ""`, `--strict-mcp-config`, `--permission-prompts none` | geweigerd (kan niet zonder tools) | geweigerd (kan niet zonder tools) |
| readonly | `--permission-mode plan`, `--permission-prompts none`, `--disallowedTools Bash,PowerShell,Edit,Write,…`, `--restricted` | `exec -s read-only -c approval_policy="never"` | plan/read-only-modus kiezen als die bestaat; alleen `read/search/fetch/think` toegestaan; `fs/write` geweigerd |
| ask | `--permission-mode default` + `--permission-prompt-tool mcp__teambot__permission_prompt` (MCP-brug → Broker), `--restricted --tools default` | `app-server`, sandbox `read-only` + `approvalPolicy on-request`: elke escalatie (schrijven/netwerk/buiten werkmap) → Broker | `session/request_permission` → Broker; altijd `allow_once`/`reject_once`, nooit `allow_always` |
| auto | `--permission-mode acceptEdits` + zelfde brug: Broker keurt write/exec automatisch goed, `danger` vraagt de mens | `exec -s workspace-write` (geen netwerk; extra rechten kunnen niet worden gevraagd en falen) | Broker: read/write/exec automatisch, `danger` vraagt; een `yolo`/bypass-startmodus wordt teruggezet of de run geweigerd |

ACP-agents die standaard zelf alles goedkeuren, krijgen bij het starten een configuratie die ze laat vragen
(`CliDef.acpEnv`). OpenCode: `OPENCODE_CONFIG_CONTENT` met `permission: { edit, bash, webfetch: "ask" }` — live
gevonden met OpenCode 1.19.5: zonder deze instelling schreef een bot in vraag-modus een bestand zonder te vragen. Paden
die zo'n agent op Windows zonder stationsletter stuurt (`Users/x/werkmap/bestand`), worden teruggezet naar de werkmap
(`acpPath`). Live-test: `npm run acp:live` (OpenCode met eigen tijdelijke map, goedkeuren én weigeren).

**Vangnet voor alle ACP-agents:** meldt een agent in vraag- of alleen-lezen-modus een wijzigende actie (`edit`,
`delete`, `move`, `execute`) als voltooid zonder daar eerst `session/request_permission` voor te hebben gevraagd (en
zonder schrijven via TeamBot's eigen `fs/write_text_file`), dan stopt TeamBot de run direct, met een duidelijke melding
en een auditregel (`cli.unapproved_action`). Die CLI draait daarna niet meer in vraag- of alleen-lezen-modus tot de
eigenaar hem in Instellingen › CLI-agents na controle opnieuw toestaat (`cli.safety_reset`). Automatische modus blijft
werken. Zo is ook een nog niet live geteste agent nooit stilletjes ruimer dan de bot mag.

Extra regels die in elke modus gelden (`permissions.ts` schrijft het verzoek op als stap; de ene poort `tools/gate.ts` beslist, dezelfde als voor de tools van TeamBot):
- Paden van tool-aanroepen moeten binnen de werkmap(pen) van de bot vallen (`resolveInWorkspace`, incl. symlinks en
  beschermde bestanden zoals `.env`/`.ssh`); anders geweigerd zonder te vragen.
- URL's van WebFetch e.d. gaan door `assertPublicUrl` (SSRF-blokkade).
- Vaste blokkeerlijst (format, `rm -rf /`, shutdown, …) → altijd geweigerd.
- Shell-opdrachten met impact (`git push`, `gh pr create`, `npm publish`, `curl -X POST`, `rm -r`, `ssh user@host`, deploys,
  …) krijgen risico `danger` → altijd een menselijke goedkeuring, ook in auto. Een tool heeft één beleidsnaam
  (`<cli>:<tool>`): *nooit* of *eerst vragen* van de eigenaar geldt voor elke opdracht; een eerdere “altijd toestaan”
  dekt een `danger`-opdracht nooit (dat regelt de Broker).
- Onbekende tools (bijv. MCP-tools van derden in Claude Code) → `danger`.
- Claude Code draait standaard met `--restricted` (negeert eigen `settings.json` met toestaan-regels) en
  `--strict-mcp-config` (geen eigen MCP-servers). Codex draait standaard met de eigen MCP-servers uit
  `config.toml` uit (`-c mcp_servers.<naam>.enabled=false`) en zonder de features `computer_use`, `browser_use`,
  `apps`, `plugins` e.d. (`--disable`, alleen die `codex features list` als actief meldt). Beide zijn per bot
  bewust aan te zetten (met waarschuwing in de UI).

## Streaming, sessies, stoppen

- Events → `AgentEvent`: `text`, `reasoning`, `status`, `activity` (titel/detail per tool, resultaat, plan,
  toestemming, sessie) en `session`.
- Sessies per **(gesprek, bot, provider)** in tabel `cli_sessions` — twee bots op dezelfde CLI in een groepschat delen
  nooit een sessie. Hervatten: Claude `--resume`, Codex `exec resume <id>` / `thread/resume`, ACP
  `session/resume` of `session/load` (gereplayde geschiedenis wordt niet opnieuw getoond).
- Nieuwe sessie terwijl er al geschiedenis is (eerste gebruik, providerwissel, verloren sessie, handmatige reset):
  de laatste 30 berichten gaan als `<eerder_gesprek>`-context mee; activiteit + (bij providerwissel/reset) een
  zichtbaar systeembericht in de chat. Verloren sessie (`No conversation found…` / `no rollout found…` /
  laadfout) → automatisch één nieuwe poging zonder hervatten.
- Gewijzigde instructies in een lopende sessie: Claude Code krijgt de systeemprompt elke beurt
  (`--append-system-prompt-file`). Codex en ACP-agents krijgen instructies alleen bij de start van een sessie
  (Codex: eerste prompt of app-server `developerInstructions`, die bij `thread/resume` niet worden vervangen; ACP
  kent geen systeemprompt). Een sessie herstarten zou de eigen context van de CLI kwijtraken, dus TeamBot bewaart per
  sessie een korte hash per `## `-onderdeel van wat is afgeleverd (`cli_sessions.context_state`). Is er sinds de
  vorige beurt iets veranderd (instructies, antwoordstijl, skills, geheugenuitleg, gekoppelde apps, tools-notitie, toegangsmodus),
  dan begint de volgende beurt in dezelfde sessie met `<teambot_instructies_update>`: alleen de gewijzigde onderdelen
  plus de koppen van vervallen onderdelen, of de volledige tekst als de stand onbekend is (sessies van vóór deze
  versie) of het grootste deel veranderde. De stand wordt pas na een geslaagde beurt opgeslagen (mislukt → volgende
  beurt opnieuw); een nieuwe sessie-id wist hem. Zichtbaar als activiteit “Bijgewerkte instructies meegegeven”.
- **Stoppen dat echt stopt** (Stoppen, *Alles stoppen*, time-outs, einde van een ACP-beurt): AbortSignal → ACP
  `session/cancel` / Codex `turn/interrupt` met 3 s respijt, daarna (en bij Claude/Codex exec direct) gaat de hele
  procesboom weg, ook processen waarvan de ouder al weg is (een server die via een shell werd gestart, een agent die bij
  “cancel” zelf stopte en iets liet draaien):
  - **Windows**: elk CLI-proces dat TeamBot start (`startProc`) komt in een eigen **Job Object** (`jobs.ts`). Windows
    houdt alles wat dat proces start in dezelfde job, ook als de ouder al weg is. Stoppen = `taskkill /T /F /PID` op de
    nog levende boom én de hele job beëindigen. Eén klein `powershell.exe`-hulpje (kale omgeving, gestart bij de eerste
    CLI-run; die eerste run wacht daar hooguit 8 s op) houdt de jobs vast met *kill on close*: valt TeamBot zelf weg,
    dan gaan zijn CLI-processen mee. Programma's die zelf uit een job willen breken mogen dat (`BREAKAWAY_OK`), zodat er
    niets stukgaat; zolang hun ouder leeft, vangt `taskkill /T` ze nog.
  - **Linux/macOS**: de CLI draait in een eigen procesgroep (`detached`); de hele groep krijgt SIGTERM en na 2 s SIGKILL,
    ook als het eerste proces al weg is.
  - Alleen processen die TeamBot zelf startte (en wat die starten) zitten in een job of groep; andere processen, ook
    CLI's die de eigenaar zelf draait, worden nooit geraakt. Een login (`claude auth login` e.d.) krijgt geen job, omdat
    die de eigen browser van de eigenaar kan openen.
  - Stopt een CLI vanzelf (geen stop), dan blijft wat hij liet draaien staan zoals voorheen; zijn job wordt alleen
    losgelaten.
- Time-outs per bot: maximale duur (standaard 60 min) en stilte (10 min; telt niet terwijl op een goedkeuring wordt
  gewacht). Crash/exitcode ≠ 0 → nette fout in de chat met de laatste (geredigeerde) stderr-regels; “niet
  ingelogd”-patronen → melding met de exacte loginopdracht.

## Veiligheid

- Werkmap = cwd. Subprocess-env via `safeEnv` (geen `TEAMBOT_*` of variabelen met KEY/TOKEN/SECRET/… — dus ook geen
  API-sleutels uit de omgeving; de CLI gebruikt zijn eigen opgeslagen login).
- Prompt via stdin; systeemprompt via tijdelijk bestand (`--append-system-prompt-file`) of in de eerste prompt;
  nooit in argv. Tijdelijke bestanden in `<data>/cli-agents/runs/<runId>/` (rechten 0600), na de run verwijderd.
- Bijlagen alleen als paden binnen de werkmap (Codex `-i`/`localImage`, ACP `image`/`resource_link`).
- Extra CLI-argumenten alleen uit een allowlist per CLI met waardevalidatie (`checkExtraArgs`); `.cmd`-shims worden
  naar hun echte doel opgelost, cmd.exe alleen als laatste redmiddel met strikte quoting (weigert `& | % ! ^ < > "`).
- **Alleen de eigenaar** van de installatie kan CLI-providers aanmaken/gebruiken en ze kunnen **nooit gedeeld**
  worden: guards vóór de kernroutes `POST/PATCH /api/providers` + controle in de adapter bij elke run. Reden:
  Anthropic staat toe dat een eindgebruiker de ongewijzigde Claude Code met zijn *eigen* abonnement gebruikt, maar
  niet dat credentials voor anderen worden gebruikt (code.claude.com/docs/en/legal-and-compliance); hetzelfde geldt
  voor de andere abonnementen. Vrienden op een server gebruiken hun eigen API-provider.
- Statusroutes geven nooit e-mail, organisatie of tokens terug (alleen ingelogd ja/nee, methode, abonnementstype).

## Kosten

`claude auth status --json` (authMethod/subscriptionType) en `codex login status` bepalen het actieve pad:
abonnement → kosten 0 (valt onder het plan), API-sleutel/Console → door de CLI gemelde kosten tellen mee voor de
daglimiet. Bij andere CLI's is het pad zo goed mogelijk afgeleid (instellingenbestand) of “onbekend”. De UI toont per
CLI de facturatienotitie en het actieve pad. Testen/detectie doen nooit een betaalde prompt.

## API-routes (`/api/cli-agents/...`, ingelogd)

| Methode | Pad | Wie | Doel |
|---|---|---|---|
| GET | `/cli-agents/status[?fresh=1]` | eigenaar (anderen: `canUse:false` + uitleg) | status per CLI (gevonden, versie, pad+bron, ingelogd, methode, facturatiepad, install/login, docs) |
| PUT | `/cli-agents/paths/:id` `{path\|null}` | eigenaar | eigen pad instellen/wissen (volledig pad, moet bestaan) |
| POST | `/cli-agents/:id/connect` | eigenaar | provider aanmaken voor een gevonden CLI (idempotent) |
| GET | `/cli-agents/threads/:id/sessions` | eigenaar gesprek | CLI-sessies in een gesprek |
| POST | `/cli-agents/threads/:id/sessions/reset` `{agentId}` | eigenaar gesprek | volgende beurt start een nieuwe sessie |

Daarnaast guards op de kernroutes `POST /providers` en `PATCH /providers/:id` voor CLI-kinds (eigenaar, niet
gedeeld, config gevalideerd: `path`, of `command`/`args`/`authMethod` voor `acp-custom`).

## Tools, goedkeuringen, events, audit

- Geen eigen `ToolDef`s: de CLI's gebruiken hun eigen tools. Goedkeuringen verschijnen als gewone Broker-verzoeken met
  tool `<cli>:<tool>` (bijv. `claude-code:Write`, `claude-code:Bash`, `codex-cli:bestanden`, `gemini-cli:execute`)
  en het eerlijke risico (`read/write/exec/danger`).
- Events: kern-events (`message.*`, `approval.*`, `run.updated`, `provider.updated`); chatbericht `role=event`
  met `parts.kind = 'cli_session'` bij providerwissel/reset.
- Audit: `cli.run`, `cli.permission` (toegestaan/geweigerd, automatisch/gevraagd, reden), `cli.fs_write`,
  `cli.path_set`, `cli.session_reset`.

## Tabel

`cli_sessions(thread_id, agent_id, provider_id, user_id, cli, session_id, created_at, updated_at, context_state)`, PK
`(thread_id, agent_id, provider_id)`; opgeruimd bij `agentDeleted`. Instelling `cliAgents.paths` bij de eigenaar.

## UI

- Instellingen › **CLI-agents**: kaart per CLI (gevonden/versie, ingelogd ja/nee/onbekend, programma + bron, pad
  instellen, opnieuw zoeken, officiële install- en loginopdracht met kopieerknop, facturatienotitie + actief pad,
  koppelen als provider, documentatie), plus formulier voor een eigen ACP-agent.
- Bot-editor › **CLI-agent**: uitleg wat de toegangsmodus bij deze CLI betekent, max. stappen, max. duur, stilte-
  time-out, eigen MCP/plugins (met waarschuwing), eigen Claude-instellingen laden (met waarschuwing), altijd
  toegestane/geweigerde Claude-tools, extra argumenten (allowlist getoond).
- Zijpaneel › **CLI**: sessies in dit gesprek met knop “Nieuwe sessie”.

## Motorversies vastzetten

`versions.ts` (plan 0.4, pakket N). Claude Code, Codex en OpenCode werken zichzelf soms bij, en een nieuwe versie kan
een optie laten vallen waar TeamBot op leunt. Daarom, voor deze drie:

- **Bekende goede versies**: de versie waarmee TeamBot getest is (de vastgezette versie van TeamBot's eigen kopie,
  `RUNTIMES[id].pinned` in `runtimes.ts`) en elke versie die op deze computer de eigen test haalde.
- **Wijziging zien**: elke statusmeting van het standaardprogramma (niet een eigen pad van een provider) gaat langs
  `observe`; daarnaast kijkt TeamBot 90 s na de start en daarna elke 6 uur. De eerste keer wordt alleen genoteerd.
  Een andere versie van hetzelfde programma geeft de melding *"Claude Code is bijgewerkt naar x"* met *"Nog niet getest
  met TeamBot"* (of *"de versie waarmee TeamBot getest is"*), een auditregel `cli.version_changed`, en 30 s later de
  eigen test. Een wissel naar een ander programma (bijv. TeamBot's eigen kopie) is geen "bijgewerkt".
- **Eigen test zonder tegoed** (`selfCheck`): `--version`; de opties die TeamBot gebruikt uit `--help` (Claude:
  `--output-format`, `stream-json`, `--resume`, `--permission-mode`, `--mcp-config`, `--permission-prompt-tool`,
  `--allowedTools`, `--disallowedTools`; Codex `exec --help`: `--json`, `--sandbox`, `--skip-git-repo-check`); extra's
  waar TeamBot omheen werkt worden genoemd maar laten de test niet mislukken; de inlogstatus (Claude `auth status
  --json`); en de opstart-handdruk van het protocol (Codex `app-server` → `initialize`, OpenCode `acp` → ACP
  `initialize`), daarna stopt TeamBot het proces. Geen sessie, geen prompt, geen modelaanroep.
- **Terug naar een goede versie** (`rollback`): de nieuwste versie die hier slaagde, anders de geteste versie. Voor de
  eigen CLI van de eigenaar alleen de exacte opdracht om zelf te draaien (met kopieerknop): Claude Code
  `claude install <v>` (eigen installer), `npm install -g @anthropic-ai/claude-code@<v>` (npm) of
  `winget install --id Anthropic.ClaudeCode --version <v> --force`, plus de tip `DISABLE_AUTOUPDATER=1`; Codex
  `npm install -g @openai/codex@<v>`; OpenCode `opencode upgrade v<v>`. TeamBot werkt de eigen CLI van de eigenaar
  **nooit** zelf bij en zet hem nooit terug. Eén klik alleen waar het veilig is: TeamBot's eigen kopie (gecontroleerde
  installatie van de geteste versie via `/cli-agents/runtimes/:id/install`), die bots daarna gebruiken.
- Mislukt de test na een wijziging, dan een melding (soort `warning`) met de opdracht terug. *Toch blijven gebruiken*
  (`cli.version_accepted`) zet de waarschuwing voor die versie stil. Bots blijven draaien; TeamBot blokkeert niets
  (een CLI die echt kapot is, faalt bij de run met een nette fout).
- Stand per computer in `<data>/cli-agents/engine-versions.json` (niet in een back-up: het gaat over deze machine).

Routes (eigenaar): `GET /cli-agents/versions[?fresh=1]`, `POST /cli-agents/versions/:id/check`,
`POST /cli-agents/versions/:id/accept`. Live naar de UI: `cli.versions`. UI: kaart *Versies van de engines* bovenaan
Instellingen › CLI-agents (`ui/src/modules/cli-agents/versions.tsx`). Test: `tests/engine-versions.test.ts` met
`tests/fixtures/engine-fake-cli.mjs` (nep-Claude, -Codex en -OpenCode die zich laten "bijwerken" en breken).

## Ontwerpkeuzes (mini-ADR's)

1. **Claude Code-goedkeuringen via `--permission-prompt-tool` + eigen MCP-stdio-script** (officieel gedocumenteerd),
   niet via het ongedocumenteerde SDK-controleprotocol en niet via de Agent SDK (geen MIT/Apache-licentie). Het script
   wordt bij start in `<data>/cli-agents/` geschreven en praat via een lokale named pipe/unix-socket met een token per
   run; onbereikbaar of onbekend token → weigeren (fail-closed). `MCP_TOOL_TIMEOUT` wordt op 24 u gezet zodat een mens
   rustig kan beslissen. Het script blijft zonder afhankelijkheden (de CLI start het buiten TeamBot's pakketten) en
   beantwoordt de MCP-handshake met de revisies van de officiële MCP SDK v2 (`SUPPORTED_PROTOCOL_VERSIONS`).
2. **Eén poort**: elke CLI-toestemming gaat door `Broker.decide` + `Broker.request` — dezelfde regels, per-bot
   overrides, inbox en telefoonmeldingen als API-bots.
3. **Codex: `exec --json` voor alleen lezen/automatisch, app-server voor vraag-modus.** `exec` is het stabiele,
   gedocumenteerde automatiseringspad maar kan niets vragen; de app-server (door Codex “experimental” genoemd) is de
   enige manier om per actie goed te keuren. Start die niet, dan valt de beurt terug op een alleen-lezen sandbox
   (zichtbaar gemeld) — nooit ruimer.
4. **Chatmodus wordt geweigerd bij CLI's zonder “geen tools”-schakelaar** (Codex, ACP): eerlijker dan “zo goed
   mogelijk”.
5. **ACP-proces per beurt** met `session/resume`/`load`; eenvoudiger en robuuster dan langlevende processen; geen
   `terminal`-capability aangeboden, `fs/*` alleen binnen de werkmap.
6. **Sessies in eigen tabel** i.p.v. alleen `thread.provider_state` (die is per provider, niet per bot).
7. **Detectie zonder prompt**: `--version`, `--help` (features), `claude auth status --json`, `codex login status`,
   `agent status`, of het bestaan van het inlogbestand. Cache 30 s; “Opnieuw zoeken” wist hem.
8. **ACP-verbinding op de officiële SDK** (0.4.4, `@agentclientprotocol/sdk` 2.4.0, Apache-2.0, vaste versie,
   stabiel v1-ingangspunt; `acp-wire.ts`). De SDK doet de JSON-RPC-laag: regels met JSON, id's, antwoorden, fouten,
   `$/cancel_request` en de protocolversie (`PROTOCOL_VERSION`). TeamBot houdt alles erboven (`acp.ts`,
   `permissions.ts`): de Broker-poort, `fs/*` alleen in de werkmap, het vangnet, modi, `acpPath` voor OpenCode-paden
   zonder stationsletter en de waakhond op stderr-fouten. Wat de agent aan TeamBot vraagt (`session/request_permission`,
   `fs/read_text_file`, `fs/write_text_file`) controleert de SDK eerst tegen het ACP-schema; een misvormd verzoek krijgt
   "invalid params" en komt nooit bij de toestemmingspoort (weigeren als standaard). `session/update` behandelt
   TeamBot zelf, in volgorde van binnenkomst: de SDK verwerkt berichten gelijktijdig, en OpenCode stuurt een
   tool-aanroep en het toestemmingsverzoek ervoor direct na elkaar (anders weet de kaart niet wat de actie is). Updates
   zijn alleen weergave en worden aangenomen zoals ze komen, ook een soort die het schema nog niet kent. Regels op
   stdout die geen JSON zijn (logregels van een agent) worden overgeslagen, zoals altijd. Een eigen fouttekst van
   TeamBot gaat ongewijzigd naar de agent. `session/cancel` na een fatale logfout wordt eerst echt geschreven en de
   agent krijgt 0,5 s om hem te verwerken. Voor één release terug naar de eigen JSON-RPC-laag: `TEAMBOT_ACP_WIRE=legacy`.
   Codex (app-server) blijft op de eigen `RpcPeer` (`rpc.ts`): geen ACP.

## Kernwijziging

- `server/agent/budget.ts` (`recordUsage`): voor providers met `type: 'cli'` wordt de door de adapter gemelde
  `usage.cost` gebruikt i.p.v. de API-prijstabel (anders zou een abonnementsrun met modelnaam `claude-opus-…` als
  API-kosten tellen voor de daglimiet). Eén regel, achterwaarts compatibel.

## Beperkingen en handmatige voorwaarden

- De gebruiker moet de CLI zelf installeren en zelf inloggen (opdrachten staan in de UI). API-sleutels in
  omgevingsvariabelen worden bewust níet doorgegeven; zet ze in de configuratie van de CLI zelf.
- ACP-agents met eigen MCP-servers/instellingen volgen hun eigen beleid voor tools die zonder
  `request_permission` draaien; TeamBot kan dat niet generiek uitschakelen (wel: toestemmingsverzoeken, fs en modus).
- Codex in automatisch-modus heeft geen netwerk en kan niets vragen (strikt, soms beperkend).
- Modelkeuze: Claude-aliassen (`opus/sonnet/haiku/fable`) of volledige naam; Codex-modellen live via app-server
  `model/list`; Gemini/Qwen via `-m`; overige ACP-agents gebruiken het model dat in de CLI is ingesteld.
- Inlogstatus van Gemini/Qwen/Hermes/OpenCode/Copilot/Grok is niet altijd zonder prompt te bepalen → “onbekend”.
- Getest met nep-CLI's (alle protocollen) en echt met Claude Code 2.1.319 en Codex 0.166.0 op Windows 11; de andere
  CLI's zijn op basis van hun officiële documentatie geïmplementeerd maar niet live getest (niet geïnstalleerd).

## Tests

`tests/proc-tree.test.ts` met een nep-procesboom (`tests/fixtures/proc-tree.mjs`, nooit de echte CLI's): stoppen beëindigt
ook een kind waarvan de ouder al weg is, een agent die bij “cancel” zelf stopt neemt zijn kinderen mee, een CLI die
vanzelf stopt laat zijn werk staan, een proces dat TeamBot niet startte blijft draaien, en `POST /api/stop-all` laat met
de nep-CLI's van Claude Code, Codex en een ACP-agent (OpenCode-stijl) geen enkel proces achter. Zonder Job Objects
falen 5 van de 6 (gecontroleerd).
`tests/cli-agents.test.ts` met nep-CLI's in `tests/fixtures/cli-agents-fake-{claude,acp,codex}.mjs`: modusvertaling,
risico/allowlists, streaming + reasoning + sessie + hervatten, prompt/systeemprompt niet in argv, geen env-lekken,
Claude-toestemming via MCP-brug → Broker → toestaan/weigeren, auto vs. danger, pad buiten werkmap, procesboom-kill,
crash/stilte-time-out/loginfout, verloren sessie, sessies per bot in een groepschat + reset + providerwissel, ACP
streaming/load/permission/fs/readonly/yolo/crash/auth/cancel, Codex exec + app-server-goedkeuring + isolatie,
eigenaar-only/niet-delen/geen e-maillek.
`tests/acp-wire.test.ts`: de ACP-laag op de SDK met een nep-proces: verzoeken en antwoorden, TeamBot's eigen
foutteksten en codes, time-out in het Nederlands, sluiten met TeamBot's reden; een misvormd toestemmingsverzoek komt
niet bij de poort; logregels op stdout krijgen geen antwoord; tool-aanroep vóór zijn toestemmingsverzoek; een onbekend
soort update komt toch in de chat; `TEAMBOT_ACP_WIRE=legacy`. `tests/cli-tools.test.ts` verbindt ook de officiële
MCP-client (v2) met de MCP-brug: handshake met de revisies van de SDK, tools, toestemmingspoort, en een client die eerst
naar 2026-07-28 vraagt valt terug.
