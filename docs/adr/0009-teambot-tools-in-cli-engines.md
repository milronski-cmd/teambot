# ADR 0009 — TeamBot-tools in CLI-engines, reserves en volledige toegang

**Status:** aangenomen (2026-11-07)

**Context.** Bots op de gratis of abonnementsroute (Claude Code met een Max-login, Codex met ChatGPT, OpenCode met
gratis modellen) kregen alleen een toestemmingsbrug, geen TeamBot-tools. De systeemprompt noemde wel
`memory_search` en `skill_load`. OpenBot geeft CLI-bots zijn eigen tools, en de eigenaar draait al zijn bots daar
op, met reserve-engines en volledige toegang.

## Besluit 1 — één MCP-server per run, via de bestaande lokale brug

- De gegenereerde stdio-server (`cli-agents/bridge.ts`) bedient naast `permission_prompt` ook `tools/list` en
  `tools/call`. Hij bevat zelf geen logica of geheimen en praat via een named pipe / unix-socket (geen TCP) met
  TeamBot.
- **Token per run.** Het token staat in een tijdelijk bestand (0600) in de runmap, nooit in argv of env. Het
  vervalt zodra de run stopt. Een onbekend token krijgt niets, en een run met alleen tools kan de
  toestemmingspoort niet gebruiken.
- **Waarom stdio en geen HTTP.** Elke ACP-agent moet stdio-MCP ondersteunen; HTTP is optioneel. Ook Claude Code en
  Codex starten stdio-servers zonder extra poort. De server luistert dus nergens op het netwerk.
- **Scope.** `toolhost.ts` gebruikt `ToolRegistry.forAgent` voor exact die gebruiker, bot, thread en run, met de
  run-override (routines kunnen beperken) en de filters (ledenbeleid, kanalen). Elke aanroep gaat door
  `tools/execute.ts`. Daar zitten dezelfde regels als voor API-bots: argumentcontrole, Broker, toolbeleid, Auto
  Review, goedkeuring (in de UI en op de telefoon) en audit. Weigeren betekent dat de tool niet draait. Tools die
  de Broker in de modus van de bot zou weigeren, staan niet in de lijst.
- **Wat niet wordt aangeboden.** De bestandstools en `run_command` van TeamBot vallen weg: de CLI heeft die zelf,
  en ze lopen al via de toestemmingsbrug. Bij Claude Code vallen ook `web_search` en `web_fetch` weg, behalve
  `web_fetch` in alleen-lezen (daar haalt `--restricted` WebFetch weg). Wel aangeboden: `share_file`, `ask_user`,
  geheugen, team, browser, desktop, skills, routines, kanalen en gekoppelde apps.
- **Gekoppelde apps (MCP-connectors).** Die worden geproxied in plaats van doorgegeven. Zo bereiken de
  OAuth-tokens de CLI nooit, en gelden toestemming en risico per tool net als bij API-bots.

### Inhaken per engine

| Engine | Hoe |
|---|---|
| Claude Code | Gebruikt `--mcp-config` in elke toolmodus (in alleen-lezen alleen leestools en zonder poort). De TeamBot-tools staan expliciet in `--allowedTools`; de toestemmingsbrug laat `mcp__teambot__*` door, omdat TeamBot zelf beslist. |
| Codex (0.167) | Gebruikt `-c mcp_servers.teambot.*` met `default_tools_approval_mode="approve"` en `tool_timeout_sec=86400`, in exec en app-server. Vraagt Codex via elicitation alsnog toestemming voor een TeamBot-tool, dan accepteert TeamBot die. |
| ACP (OpenCode e.a.) | Zet `mcpServers` in `session/new`, `session/load` en `session/resume`. Een permissievraag voor een TeamBot-tool gaat door, maar alleen bij soort "other" zonder commando of paden, zodat een eigen actie niet kan doen alsof hij een TeamBot-tool is. |

- **Wachttijd.** Zolang een TeamBot-tool draait of op een mens wacht, staat de idle-timer van de CLI stil. Breekt de
  CLI een aanroep af (`notifications/cancelled`), dan stopt de tool en vervalt de goedkeuring.
- **Bestanden.** Bijlagen van tools, zoals `share_file` en schermafbeeldingen, verschijnen bij het CLI-antwoord.
  Afbeeldingen gaan terug naar de CLI.

## Besluit 2 — geordende reserves, ook voor CLI-engines

- Een bot heeft `settings.fallbacks`: tot 5 reserves op volgorde. Het oude enkele `fallback` blijft werken.
- De runner schakelt bij een gebruikslimiet, uitgelogd zijn, overbelasting of een engine die niet start, ongeacht
  of het om een API of een CLI gaat. Hij schakelt nooit stil: er komt een melding in de chat, de mislukte poging
  blijft zichtbaar als geannuleerd en er is een audit.
- **Limiet onthouden.** TeamBot onthoudt een limiet tot de reset (die wordt uit de melding gelezen). Volgende beurten
  starten dan op de eerste vrije reserve, en na de reset gaat de bot vanzelf terug naar zijn hoofdengine.
- **`settings.onLimit`:**
  - `fallback` (standaard): wissel naar de reserves; zijn die op, wacht dan op de reset en probeer opnieuw;
  - `wait`: wissel niet en probeer na de reset hetzelfde bericht opnieuw, maximaal 3×, ook na een herstart;
  - `stop`: stop.

## Besluit 3 — toegangsniveau "Volledige toegang" (`full`)

- Alleen de eigenaar kan dit aanzetten, en dat wordt gelogd. Binnen de Broker draait het normale werk zonder te
  vragen.
- Danger-tools geven hun **impact** op:
  - `local` (verwijderen in de werkmap, eigen bureaublad, berichten naar de eigen chat van de eigenaar): draait;
  - `external` (naar anderen of naar gekoppelde apps, en alles wat onbekend is): vraagt, tenzij
    `fullAccessExternal` aan staat;
  - `payment`: vraagt altijd. `browser_submit` kijkt daarvoor naar de echte knop.
- CLI-commando's volgen dezelfde regels. Lokaal vernietigen (`rm -r`, `git reset --hard`) draait. Pushen,
  publiceren, POST, ssh en mail vragen.
- **Harde blokkades blijven:** buiten de werkmap, wachtwoord- en betaalvelden, de blokkeerlijst en privé-URL's.

## Besluit 4 — de gratis route

- **Gratis modellen van OpenCode.** OpenCode Zen-modellen op `-free` en `big-pickle` werken zonder account of
  sleutel (live getest met 2.2.5). Ze krijgen het label "gratis", lokale modellen het label "lokaal".
- **Factuurlabels.** Modellen, providersoorten en providers hebben `billing`: free, subscription, paid of local.
- **Standaard-engine voor nieuwe bots.** Zolang de gebruiker niet zelf kiest, geldt deze volgorde:
  1. Claude Code (abonnement);
  2. Codex (abonnement);
  3. OpenCode (gratis model);
  4. Ollama of LM Studio;
  5. gratis API-tier;
  6. betaalde sleutel.

## Gevolgen

- Een CLI-bot is functioneel gelijk aan een API-bot, met dezelfde poort. De Broker en `executeTool` zijn de enige
  plek waar beslist wordt.
- Live gecontroleerd met `npm run cli-tools:live`, met een tijdelijke data-map en voor OpenCode een geïsoleerde
  XDG. De kosten zijn 0 extra.
- OpenCode 2.2.5 start bij `opencode acp` een eigen privéserver (`serve --stdio`) en niet de achtergrondservice.
  De inline config (permissies, model) komt dus aan. Het ACP-vangnet blijft de borg als een latere versie dat
  verandert.
