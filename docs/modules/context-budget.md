# Contextbudget — zuinig met tokens (TeamBot 0.4, pakket Y)

**Kort:** elke modelaanroep stuurt alles opnieuw mee: systeemprompt, alle tooldefinities, het geheugenblok van elke
beurt, het hele gesprek en alle tool-uitvoer tot nu toe. TeamBot meet dat nu per deel, kort het veilig in voor álle
aanbieders (0.3.0 deed dat alleen bij Ollama, en pas als het venster vol was), stuurt alleen de tools mee die nodig
lijken, houdt de prompt stabiel zodat prompt caching blijft werken, en geeft gedelegeerd werk een kleine, schone
context. Standaard aan; per bot uit te zetten. Niets gebeurt stil: wat is ingekort zegt dat, tegen de bot én in het
zijpaneel.

Code: `server/agent/context-budget.ts` (meten, inkorten, de haak voor de runner), `server/agent/history.ts`
(`buildHistory` met de saver), `server/tools/selection.ts` (toolselectie en `tools_load`),
`server/providers/anthropic.ts` (`cacheParams`), `ui/src/shell/ContextUse.tsx` (zijpaneel).

## Meten

Per modelaanroep een schatting per deel (±3,5 tekens per token, een afbeelding ±1.600 tokens):

| Deel | Wat |
|---|---|
| Systeemprompt | instructies, veiligheidsregels, uitleg van modules |
| Tooldefinities | de tools die deze stap meegingen (met "x van y") |
| Geheugen en beurtcontext | de bevroren `<context>`-blokken in de berichten: geheugenblok, datum, team- en skillnotities |
| Gesprek | berichten, antwoorden, tool-aanroepen, samenvatting en vaste regels vooraan |
| Tool-uitvoer | resultaten van tools, ook schermafbeeldingen |
| Bijlagen | `<bijlage>`-teksten en afbeeldingen van de gebruiker |

Opgeslagen op elk antwoord (`message.parts.contextStats`), samen met wat de engine na de aanroep zelf telde
(`reported.input`, waarvan uit de cache `reported.cacheRead`). Eén regel per aanroep in het log (`[context] …`). In de
app: **Zijpaneel › Details › Context van de laatste stap** (dichtgeklapt): de delen met een balk, het totaal, de telling
van de engine, wat er is ingekort en de schakelaar *Zuinig met context* voor deze bot.

**CLI-engines** (Claude Code, Codex, OpenCode …) houden hun eigen context in een sessie. TeamBot schat wat het zelf
meegeeft (systeemprompt, de prompt met nieuwe berichten en beurtcontext, bijlagen, de TeamBot-tools via MCP, zonder de
eigen bestands- en terminaltools van de engine) en zet de telling van de engine ernaast; het verschil is wat de engine
zelf toevoegde (`engineOwn`: eigen instructies, tools, sessie).

## Veilig inkorten (alle aanbieders)

- **Oudere tool-uitvoer** (van beurten vóór de laatste 2) boven 2.000 tekens: begin en eind blijven (±1.200 tekens),
  ertussen staat *[Ingekort door TeamBot om ruimte te sparen: oudere uitvoer van read_file, 23.542 van 24.742 tekens
  weggelaten. Roep de tool opnieuw aan als je de volledige inhoud nodig hebt.]*
- **Lange runs**: uitvoer boven 6.000 tekens van meer dan 10 stappen geleden, mild (±2.500 tekens), met een eigen
  melding.
- **Dezelfde aanroep met dezelfde uitvoer** (bijv. twee keer hetzelfde bestand lezen zonder wijziging): de tweede gaat
  als *[Zelfde uitvoer als de eerdere aanroep … hierboven]* zolang de eerste nog volledig is.
- **Bijlagen en afbeeldingen van oudere beurten**: een kort begin en een notitie; het bestand staat in de werkmap.
- **Schermafbeeldingen in tool-uitvoer**: de nieuwste 2–4 houden hun afbeelding (0.3.0: de nieuwste 3, maar dat
  veranderde de geschiedenis bij elke nieuwe schermafbeelding).
- **Een te lang gesprek** wordt afgesneden op het begin van een blok beurten (stabiel), nooit voorbij de huidige vraag
  (0.3.0 kon in een lange run de vraag zelf laten vallen). Vooraan staat dan *[TeamBot heeft N oudere berichten …
  weggelaten …]*, de samenvatting (compaction of de doorlopende samenvatting van het geheugen) en een blok met wat nooit
  mag wegvallen:
  - de **vastgezette geheugenregels** uit het weggevallen deel (het geheugenblok herhaalt een item pas na 10 beurten;
    zonder dit blok was "vraag eerst" na het afsnijden weg);
  - de **eigen afspraken van de eigenaar** in zijn eigen woorden ("Voortaan: noem nooit prijzen zonder btw."), alleen
    uit berichten van de eigenaar zelf, nooit van externe afzenders of andere bots.
  Hetzelfde blok staat vooraan als compaction het oudere deel samenvatte.

**Nooit ingekort:** de systeemprompt (instructies en veiligheidsregels), de huidige vraag met zijn context, de eigen
woorden van de eigenaar, de uitvoer van de huidige beurt, en de uitvoer van tools die het antwoord van de eigenaar of
geladen instructies bevatten (`ask_user`, `ask_form`, `memory_get`, `memory_search`, `dossier_get`, `dossier_search`,
`skill_load`, `skill_read_file`, `plan_update`, `notify_user`, `tools_load`). De originele berichten blijven altijd in
de database.

## Minder tooldefinities

Een standaardbot stuurde 49 tools (±8–10k tokens) bij elke aanroep mee, met alle groepen aan 89 (±13k), plus de tools
van gekoppelde apps. Zijn de definities samen groter dan het budget (standaard 6.000 tokens), dan gaan mee:

- altijd: basis, bestanden, internet, geheugen, terminal, container;
- een onderdeel waarvan de systeemprompt of de eigen instructies een tool noemen (de prompt belooft hem:
  `routine_no_update`, de teamdatabase, de browser van een browserbot);
- wat de vraag of de instructies noemen: woorden ("elke ochtend" → routines, "website invullen" → browser), de naam
  van een gekoppelde app, de naam van een andere bot (→ team); in een groepsgesprek altijd de teamtools;
- wat eerder in dit gesprek is gebruikt of geladen (blijft voor de rest van het gesprek);
- daarna de kleinste overige onderdelen zolang alles in het budget past.

De rest staat in de beschrijving van **`tools_load`** ("deze onderdelen kun je laden: …"); de bot laadt ze in één stap,
vanaf de volgende stap zijn ze er. Nooit meer dan de bot al heeft (altijd een deel van `ToolRegistry.forAgent`). Een
tool die de bot toch rechtstreeks aanroept, werkt gewoon en hoort daarna bij de selectie. In het zijpaneel: "Niet
meegestuurd (de bot kan ze zelf erbij halen): …".

**CLI-bots (0.4.4).** Dezelfde selectie geldt voor de TeamBot-tools die een CLI-engine via MCP krijgt
(`server/modules/cli-agents/toolhost.ts`), met `tools_load` als MCP-tool. Laadt de bot een onderdeel, dan stuurt de
MCP-brug `notifications/tools/list_changed` en houdt het antwoord vast tot de engine de lijst opnieuw heeft gelezen
(hooguit 1,5 s), zodat de volgende stap de tools al heeft. Wat een sessie kreeg, blijft voor die sessie
(`provider_state[<engine>].teambotParts`), dus de lijst groeit alleen. Alleen voor engines die de lijst opnieuw lezen
(`RELISTS`): Claude Code ja (bij `capabilities.tools.listChanged`, nagekeken in 2.1.319; `tools_load` heeft
`_meta["anthropic/alwaysLoad"]`, zodat Claude Codes eigen tool search hem nooit uitstelt). Codex alleen achter zijn
feature-vlag `mcp_tool_list_changed` en OpenCode niet nagekeken: die krijgen de volledige set, zoals voorheen. Een
standaard hoofdbot op Claude Code: 46 tools, ±8.700 tokens (±10.100 als JSON over MCP) → 30 tools plus `tools_load`,
±5.200 tokens bij een gewone vraag.

## Prompt caching blijft werken

- **Systeemprompt en toollijst byte-gelijk tussen beurten** (getest over alle fixtures). De toollijst verandert alleen
  als er een onderdeel bijkomt, nooit terug, in de volgorde van de bot zelf met `tools_load` achteraan.
- **Inkorten gebeurt in blokken**: oudere beurten per 3 beurten, lange runs per 5 stappen. Tussen die momenten is elke
  aanroep de vorige plus wat erbij kwam (alleen aanvullen), dus de prefix blijft in de cache. Gemeten: 0–2
  geschiedeniswijzigingen per fixturegesprek van 14–25 aanroepen.
- **Een afgesneden geschiedenis** begint steeds op dezelfde plek tot het volgende blok; de doorlopende samenvatting van
  het geheugen (die na elke run wordt herschreven) blijft vooraan gelijk zolang die plek gelijk blijft.
- **Anthropic**: een vast cachepunt na tools + systeemprompt (blijft raak, wat er later ook verandert) plus automatisch
  cachen van het gesprek. Een Anthropic-compatibel adres (eigen base URL: proxy, LiteLLM, andere aanbieder) kent het
  automatische veld vaak niet; daar krijgt het laatste blok een expliciet cachepunt.
- **Denkstappen van Claude** (Opus 5.5, Sonnet 5.5, Fable 5.1, Haiku 5.5) zijn gebonden aan alles wat ervoor stond.
  Elk antwoord bewaart de sleutel waaronder het is geschreven (`contextStats.key`: toollijst, wat vooraan staat, elke
  inkorting ervoor); is er sindsdien iets vóór een denkstap veranderd, dan gaat die denkstap niet meer mee (de tekst en
  tool-aanroepen van het antwoord wel). Zo weigert de API de geschiedenis nooit; de bestaande terugval (opnieuw zonder
  denkstappen bij een 400) blijft als vangnet.

## Delegeren blijft klein

Een gedelegeerde taak (`delegate_task`, subgesprek) begint al schoon: de taak, de verwachte uitvoer (het "klaar als")
en de kop met de naam van het gesprek, niet het gesprek zelf (getest). Voor een bot-tot-botgesprek dat steeds langer
wordt en voor `ask_bot` in de eigen chat van de andere bot geldt nu een eigen geschiedenisbudget van 12.000 tokens
(`delegationTokens`), met dezelfde vaste regels vooraan; het zijpaneel meldt het.

## Instellingen

Per bot `settings.contextSaver` (`false`, `true` of een object), per eigenaar de instelling `contextSaver` (geldt voor
al zijn bots; een bot kan het weer aanzetten). Standaardwaarden:

| Sleutel | Standaard | Wat |
|---|---|---|
| `on` | `true` | hoofdschakelaar; uit = precies de geschiedenis en toollijst van 0.3.0 |
| `keepTurns` | 2 | de nieuwste beurten waarvan de tool-uitvoer heel blijft (behalve zeer grote uitvoer van meer dan `keepSteps` stappen geleden) |
| `step` | 3 | oudere beurten in blokken van zoveel beurten (cache) |
| `oldToolChars` | 1.200 | oudere uitvoer wordt ingekort tot ±zoveel tekens |
| `keepSteps` / `stepChunk` / `runToolChars` | 10 / 5 / 2.500 | lange runs |
| `duplicates` | `true` | dezelfde uitvoer niet twee keer |
| `selectTools` | `true` | alleen de tools die nodig lijken, met `tools_load` |
| `toolTokens` | 6.000 | tooldefinities tot zoveel tokens gaan altijd volledig mee |
| `delegationTokens` | 12.000 | geschiedenisbudget voor gedelegeerd werk en botberichten |

In het zijpaneel staat de schakelaar *Zuinig met context* per bot (zet `settings.contextSaver.on`).

## Meting (fixtures, `tests/fixtures/context-conversations.ts`)

Vier echte soorten gesprekken met tool-uitvoer op ware grootte (productlijst ±25k tekens, bestellingen in JSON,
broncode, webpagina's van 20–25k tekens, testuitvoer). Invoertokens opgeteld over alle aanroepen, 0.3.0 → 0.4:

| Gesprek | Aanroepen | 0.3.0 | Met contextbudget | Verschil |
|---|---|---|---|---|
| Webshop met Shopify, Google Sheets en Gmail | 14 | 360.485 | 231.864 | −36% |
| Kortingsfout herstellen (lange run) | 25 | 904.962 | 518.170 | −43% |
| SEO-artikel (lange webpagina's) | 14 | 391.806 | 240.674 | −39% |
| Klantenservice (lang, weinig tools) | 14 | 184.967 | 121.365 | −34% |
| **Samen** | 67 | 1.842.220 | 1.112.073 | **−40%** |

Per deel (alle vier samen): tooldefinities 705.292 → 408.073, tool-uitvoer 1.007.758 → 574.830; systeemprompt,
geheugen en gesprek gelijk. De test controleert per aanroep dat de vraag letterlijk meegaat, dat de vastgezette regel
er staat, dat de uitvoer van de huidige beurt heel is, en aan het eind dat de feiten uit het gesprek er nog zijn.

## Beperkingen

- Schattingen (tekens/3,5); de echte telling van de engine staat ernaast.
- Compaction (`agent/compaction.ts`) start nog op dezelfde ruwe grootte als in 0.3.0 (75% van `historyTokens`) en
  telt het inkorten niet mee; daardoor wordt soms eerder samengevat dan nodig.
- CLI-engines: TeamBot kort hun sessie niet in en kiest hun tools niet (Claude Code heeft eigen tool search voor
  MCP-tools); alleen de schatting en de telling.
- Voor Anthropic zijn oudere delen in de cache al goedkoop (lezen uit de cache ±5–10% van de prijs): daar levert
  inkorten vooral een kleinere context op, en kost een verschuiving van het afsnijpunt eens per paar beurten een
  nieuwe cache-schrijfactie. Bij aanbieders zonder cache en bij gratis tegoed per token is de winst het grootst.
- `tools_load` vraagt één extra stap als de bot een niet-meegestuurd onderdeel nodig heeft.

## Tests

`tests/context-budget.test.ts`: −30% of meer op elke fixture met vraag, vaste regel en feiten behouden; systeemprompt
en toollijst byte-gelijk en weinig geschiedeniswijzigingen; vaste regels en eigen afspraken na afsnijden (0.3.0 verloor
de vaste regel) en na compaction; de vraag valt nooit weg; `tools_load` laadt, blijft en laadt nooit iets wat de bot
niet heeft; gedelegeerde taak schoon en klein, `ask_bot` in een lange chat begrensd; denkstappen van Claude alleen waar
alles ervoor gelijk is (de controle van de API nagebootst over een hele run); Anthropic-cachepunten; instellingen;
meten; toolselectie; het blok vooraan; CLI-schatting.
