# Contextbudget — zuinig met tokens (TeamBot 0.4, pakket Y)

**Kort:** elke modelaanroep stuurt alles opnieuw mee: systeemprompt, alle tooldefinities, het geheugenblok van elke
beurt, het hele gesprek en alle tool-uitvoer tot nu toe. TeamBot meet dat nu per deel, kort het veilig in voor álle
aanbieders (0.3.0 deed dat alleen bij Ollama, en pas als het venster vol was), stuurt alleen de tools mee die nodig
lijken, houdt de prompt stabiel zodat prompt caching blijft werken, en geeft gedelegeerd werk een kleine, schone
context. Standaard aan; per bot uit te zetten. Niets gebeurt stil: wat is ingekort zegt dat, tegen de bot én in het
zijpaneel.

Code: `server/agent/context-budget.ts` (meten, inkorten, de haak voor de runner), `server/agent/history.ts`
(`buildHistory` met de saver), `server/tools/selection.ts` (de toollijst: kern plus `tools_find` en `tools_call`),
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
geladen instructies bevatten (`ask_user`, `ask_form`, `memory_get`, `memory_search`, `dossier_get`,
`skill_load`, `skill_read_file`, `plan_update`, `notify_user`, `tools_find`). De originele berichten blijven altijd in
de database.

## Minder tooldefinities

Een bot met alle onderdelen aan heeft ruim honderd tools (110, de hoofdbot 118: `tests/dup-guard.test.ts`). Elke
definitie ging bij elke stap mee: ±18.600 tokens voor een gewone bot op Claude Code, ±21.400 voor de hoofdbot, en
evenveel bij een API-model. Een eerdere selectie (`tools_load`, onderdelen achter een label) is daarna weer
uitgeschakeld omdat bots niet vonden wat ze nodig hadden. Sinds 12 november 2026 krijgt een model op elke engine (API,
Claude Code, Codex, ACP) dezelfde korte lijst (`server/tools/selection.ts`):

- **de kern**: wat bots dagelijks gebruiken (`ask_user`, `notify_user`, `plan_update`, `share_file`, `read_document`,
  `memory_search`, `dossier_get`, `dossier_write`, `skill_load`, `delegate_task`, `ask_bot`), de ingang van de eigen
  browser (`browser_open`, `browser_snapshot`), voor een API-model ook de bestands-, terminal- en webtools (een CLI
  heeft die zelf), voor de hoofdbot `teambot_find` en `teambot_do`, en hele onderdelen die alleen in één soort run
  bestaan of de computer van de bot zijn (routine-afronding, live gesprek, container, eigen server);
- **waar de bot voor is ingericht en wat het bericht noemt** (`wanted`): een hulpmiddel dat zijn rol, beschrijving of
  instructies bij naam noemen, en een onderdeel waarvan de tools bij elkaar horen in zijn geheel als die tekst het
  onderdeel noemt ("Je werkt in je browser" geeft de hele browser). Een hulpmiddel dat het bericht bij naam noemt staat
  er voor die run bij, bij zo'n onderdeel het hele onderdeel. Een licht model kwam van `tools_find` niet bij
  `browser_click` en gaf twee keer geen antwoord (12 nov). Een bot zonder eigen tekst houdt de kern;
- **`tools_find`**: geeft de uitleg en de velden van elk ander hulpmiddel van de bot. **In zijn beschrijving staat elke
  naam**, per onderdeel ("je eigen browser: browser_navigate, browser_click, …"): een model hoeft nooit te raden of iets
  bestaat;
- **`tools_call`**: gebruikt zo'n hulpmiddel, met naam en velden.

Een `tools_call` wordt vóór alles omgezet in de aanroep die hij noemt (`OnDemand.resolve`). Daarna is het die tool:
dezelfde poort (`tools/execute.ts`: argumentcontrole, Broker, toolbeleid, Auto Review, goedkeuring, audit), dezelfde
regel in de chat, dezelfde naam in het logboek en in de geschiedenis (`ToolCall.via` onthoudt alleen dat het model hem
via `tools_call` schreef, zodat het zijn eigen stap terugleest zoals het hem schreef). Een tool die een model toch
rechtstreeks bij zijn naam aanroept, werkt ook. Kloppen de velden niet, dan staat het schema bij de foutmelding.

**Eén tool van een onderdeel gebruikt, en het hele onderdeel is bekend.** Bij het eerste gebruik van een onderdeel
waarvan de tools bij elkaar horen (browser, bureaublad, teamdatabase, projecten, repetitie, workflows, kanalen, een
gekoppelde app) komen de velden van de andere tools van dat onderdeel mee met het resultaat, plus wat de bot over dat
onderdeel moet weten (de *gids*, `ctx.tools.addGuide`, `PartGuide`: hoe zijn browser werkt, de regels voor het
bureaublad, de tabellen van de teamdatabase, welke apps gekoppeld zijn). Geen zoekstap per tool dus: een licht model
dat eerst voor elke browseractie moet zoeken, verliest daar een hele beurt aan. Dezelfde gids komt mee met wat
`tools_find` vindt. Staan de tools van een onderdeel allemaal in de lijst ("zuinig" uit, of de bot is ervoor
ingericht), dan staat de gids in de systeemprompt, zoals altijd; staat het onderdeel er alleen voor één bericht bij,
dan komt de gids mee met het eerste gebruik. Wat al is meegegeven wordt onthouden zolang het model het nog weet: één run bij een
API-model (oudere tool-uitvoer wordt ingekort), de sessie bij een CLI-engine (`provider_state[<engine>].teambotTold`).

De lijst is voor een bot in elke stap van elk gesprek byte-gelijk, behalve in een run waarvan het bericht een
hulpmiddel bij naam noemt; niets hangt af van een engine die zijn tools opnieuw opvraagt. Nooit meer dan de bot al heeft (altijd een deel van `ToolRegistry.forAgent`, bij CLI-bots na het filter van
de Broker). In het zijpaneel: "Niet meegestuurd (de bot kan ze zelf erbij halen): …". Gemeten op een verse installatie
(schatting van `core/tokens.ts`): gewone bot op Claude Code 16 tools, ±3.420 tokens (waarvan ±580 de namen van de 88
tools op afroep); hoofdbot 18 tools, ±3.960; API-bot 24 tools, ±4.300. `tests/light-step.test.ts` bewaakt die groottes
met een plafond, `tests/dup-guard.test.ts` het aantal.

**CLI-bots.** De toolhost (`server/modules/cli-agents/toolhost.ts`) biedt dezelfde lijst aan over MCP; alle tools in de
lijst hebben `_meta["anthropic/alwaysLoad"]`, zodat Claude Codes eigen tool search de korte lijst nooit uitstelt. De
MCP-server stuurt geen eigen instructies meer mee (die stonden ook al in de instructies die elke engine krijgt).
Claude Code hield de definities van TeamBots tools eerder zelf al grotendeels achter zijn eigen tool search (alleen de
namen stonden in de prompt): daar is de winst per stap dus kleiner dan bij Codex, ACP en API-modellen, die elke
definitie echt meekregen.

## Prompt caching blijft werken

- **Systeemprompt en toollijst byte-gelijk tussen beurten** (getest over alle fixtures). De toollijst is de kern plus
  waar de bot voor is ingericht, in de volgorde van de bot zelf, met `tools_find` en `tools_call` achteraan; alleen een
  bericht dat een hulpmiddel bij naam noemt verandert hem, voor die ene run.
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
| `selectTools` | `true` | alleen de kern in de toollijst, de rest op afroep (`tools_find`, `tools_call`); uit = elke definitie |
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
- CLI-engines: TeamBot kort hun sessie niet in en kiest hun eigen tools niet; van zijn eigen tools geeft het de korte
  lijst (zie boven), en verder alleen de schatting en de telling.
- Voor Anthropic zijn oudere delen in de cache al goedkoop (lezen uit de cache ±5–10% van de prijs): daar levert
  inkorten vooral een kleinere context op, en kost een verschuiving van het afsnijpunt eens per paar beurten een
  nieuwe cache-schrijfactie. Bij aanbieders zonder cache en bij gratis tegoed per token is de winst het grootst.
- Een hulpmiddel buiten de lijst kost één zoekstap (`tools_find`) voordat de bot het de eerste keer gebruikt.

## Tests

`tests/context-budget.test.ts`: −30% of meer op elke fixture met vraag, vaste regel en feiten behouden; systeemprompt
en toollijst byte-gelijk en weinig geschiedeniswijzigingen; vaste regels en eigen afspraken na afsnijden (0.3.0 verloor
de vaste regel) en na compaction; de vraag valt nooit weg; `tools_find` vindt en `tools_call` gebruikt nooit iets wat de bot
niet heeft; gedelegeerde taak schoon en klein, `ask_bot` in een lange chat begrensd; denkstappen van Claude alleen waar
alles ervoor gelijk is (de controle van de API nagebootst over een hele run); Anthropic-cachepunten; instellingen;
meten; toolselectie; het blok vooraan; CLI-schatting.
