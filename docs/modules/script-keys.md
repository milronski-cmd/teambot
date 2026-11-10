# Module: Sleutels voor scripts (`script-keys`)

De eigenaar geeft een opgeslagen geheim (API-sleutel, token, wachtwoord) aan de scripts van een bot als
**omgevingsvariabele met een zelfgekozen naam**, bijvoorbeeld `SHOPIFY_TOKEN`. Per bot, of voor alle bots van een team
(de bots met dat thuisteam). De bot weet alleen dat de naam bestaat; de waarde ziet hij nooit.

## Opslag

- `script_keys`: naam (hoofdletters, cijfers, `_`; geen naam die de computer of een programma zelf gebruikt, zoals
  `PATH`, `NODE_OPTIONS`, `TEAMBOT_*`), omschrijving, `secret_id`. De waarde staat versleuteld in de kern-`secrets`
  (AES-256-GCM) als `scriptkey:<id>`; minimaal 8 tekens.
- `script_key_grants`: `target` = `agent` of `team`, `target_id`. Per bot en per team maar één sleutel met dezelfde naam;
  krijgt een bot dezelfde naam via zichzelf én via zijn team, dan gaat de eigen sleutel voor.
- **Teams**: de sleutels staan ook onder Instellingen › Teams › *Sleutels en logins* (soort `script`). Staat een sleutel op
  *Alleen team X*, dan krijgt een bot van een ander team hem niet (`keyAllowed`), ook niet via een eerdere toekenning.
- Een gedeelde bot in het gesprek van een lid krijgt nooit sleutels (`sharedRunOf`).

## Waar de waarde komt (en waar niet)

- In de omgeving van TeamBot's eigen script-tools, via `ctx.services.scriptKeys.envFor(agent, { tool })`. Elk gebruik
  staat in het logboek (`script-keys.used`, alleen namen en de tool):
  - `run_command` (`server/tools/builtin/shell.ts`) en `skill_run_script` (`server/modules/skills/tools.ts`): de
    variabelen van het proces.
  - `computer_exec` (privé-container, `browser/container.ts`): `docker exec -e NAAM …` met alleen de **naam**; Docker
    haalt de waarde uit zijn eigen omgeving, zodat hij nooit op een opdrachtregel staat.
  - `remote_exec` (eigen server via SSH, `browser/remote.ts`): `envBlock` maakt `export NAAM='waarde'` per sleutel en
    stuurt dat over de invoer van het SSH-kanaal (zonder EOF, zodat stoppen met KILL blijft werken); het script leest
    precies zoveel bytes (`dd`) en voert ze uit vóór de opdracht. Met Docker op de server gaat er weer alleen `-e NAAM`
    naar `docker run`. Op de server staat de waarde dus nooit in `ps`, alleen in de omgeving van de opdracht.
- CLI-bots (Claude Code, Codex, OpenCode …): **niet** in de omgeving van de CLI zelf (TeamBot kan de uitvoer van de eigen
  terminal van de CLI niet afschermen vóór het model hem ziet). Heeft zo'n bot sleutels, dan krijgt hij TeamBot's
  `run_command` via de MCP-brug (`cli-agents/toolhost.ts`) en zegt de systeemprompt dat hij die moet gebruiken.
- Systeemprompt (stabiel): de namen met omschrijving, in welke tools ze klaarstaan (`run_command`, `skill_run_script`,
  `computer_exec`, `remote_exec`), hoe je ze gebruikt (`$env:NAAM` / `$NAAM`) en dat de waarde nooit zichtbaar is.
- **Afschermen**: `tools/execute.ts` vervangt in elk tool-resultaat en elke live-uitvoer elke waarde van de sleutels van de
  eigenaar (ook gewone, URL-, JSON- en base64-vorm) door `[verborgen: $NAAM]`. De vier script-tools doen dat ook zelf
  vóór het inkorten, en hun live-uitvoer houdt een half afgedrukte waarde achter (`scrubLive`). `remote_exec` kort lange
  uitvoer in tot begin en eind: beide delen worden apart afgeschermd en een waarde die precies op de knip staat valt weg
  (`scrubPiece`, met `cutPartial` en `cutLeading`). Logboek en logregels: `redact()` (de waarde wordt onthouden).
  Volledige export: de waarden staan in `secrets` en worden er dus uit gefilterd; de module zelf exporteert alleen namen
  en toekenningen.
- **Skills**: een vertrouwd skillscript krijgt de sleutels voor scripts van de bot die het uitvoert. Dat staat bij
  *Mijn skills › Veiligheid*, in het venster *Scripts vertrouwen* en in de catalogus; de goedkeuringskaart noemt de namen.
- Niet af te schermen: een script dat de waarde bewust versleutelt of in stukjes afdrukt, of hem naar buiten stuurt. Daarom
  geeft alleen de eigenaar sleutels, en blijven de gewone goedkeuringen gelden (opdrachten met impact vragen altijd).

## API (computer-only)

`GET/POST /api/script-keys`, `PATCH/DELETE /api/script-keys/:id`, `POST /api/script-keys/:id/grants` (`{ target, id }`),
`DELETE /api/script-keys/:id/grants/:target/:targetId`, `GET /api/script-keys/agents/:agentId` (wat de bot krijgt, de
andere sleutels, en waarom hij ze nu niet zou gebruiken). Waarden zijn alleen-schrijven. Een gekoppelde telefoon krijgt
403 (`COMPUTER_ONLY` in `mobile/policy.ts`): een sleutel geven deelt toegang uit.

## UI

- Bot-editor › *Sleutels voor scripts*: lijst (naam, waarvoor, via bot of team, *klaar* of waarom niet), *Sleutel
  toevoegen* (naam, sleutel, waarvoor, voor deze bot of het hele team), *Een bestaande sleutel geven*, *Weghalen*,
  verwijderen. Een bot met alleen de privé-container of de eigen server gebruikt zijn sleutels ook (geen waarschuwing).
- *Kluis* (`#/m/browser/kluis`, onder de logins; geen eigen rij in Instellingen): alle sleutels in één lijst
  (`ui/src/modules/script-keys/Overview.tsx`) met naam, waarvoor, welke bots en teams hem krijgen (een bot is een link
  naar zijn editor), laatst gebruikt, *Nieuwe waarde* en verwijderen. Toevoegen en geven gebeurt bij de bot.
- Telefoon: in de bot-editor "Sleutels voor scripts beheer je op je computer."; in de Kluis geen overzicht (en geen
  verzoek naar `/api/script-keys`).

## Tests

`tests/script-keys.test.ts` (namen, afschermen, env, prompt, transcript, model, audit, export, team en *Alleen team*,
telefoon), `tests/script-keys-computers.test.ts` (container: alleen `-e NAAM`, uitvoer en live-uitvoer afgeschermd;
server via de SSH-testserver: de waarde komt aan, nooit op de opdrachtregel, ook met Docker op de server; afschermen aan
de knip), `tests/mobile.test.ts` (denylist), `tests/e2e/script-keys.mjs` (bot-editor, chat, Kluis-overzicht, tekst bij
skills vertrouwen, telefoon).
