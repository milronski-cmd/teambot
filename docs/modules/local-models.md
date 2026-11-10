# Module `local-models` — Lokale modellen op deze pc

Plan 0.4: pakket Q (lokale modellen slim gekozen), aansluitend op D (Ollama als laatste reserve) en F (lokaal zoeken op
betekenis). Onderzoek: `research_notes/Knelpunten gebruikers alle AI bots/lokaal-gratis-en-privacy.md` §1 — stil
afkappen van het contextvenster, toolopdrachten die als tekst terugkomen, kleine modellen en meerdere tools, Ollama dat
zonder goed stuurprogramma stil op de processor draait, en LM Studio dat vóór het downloaden "past / te groot" zegt.

## Wat de module doet

- **Hardware** (`hardware.ts`), zonder nieuwe afhankelijkheden: werkgeheugen en processor uit Node `os`; videokaarten
  uit `nvidia-smi` (als die er is) en op Windows één PowerShell-aanroep: `Win32_VideoController` plus de 64-bits
  geheugenwaarde van het stuurprogramma (`HardwareInformation.qwMemorySize` in de register-sleutel van de
  beeldschermklasse), omdat `AdapterRAM` een 32-bits veld is dat bij 4 GB stopt. De ingebouwde graphics van een
  processor (AMD "Radeon(TM) Graphics", Intel UHD/Iris/"Arc(TM) Graphics") tellen niet mee. Linux: `nvidia-smi` en
  `/sys/class/drm/*/device/mem_info_vram_total` (AMD). macOS op Apple silicon: gedeeld geheugen. 10 minuten bewaard;
  "Opnieuw kijken" kijkt direct opnieuw.
- **Advies per model** (`advice.ts`, puur): nodig = gewichten (≈ download) + KV-cache voor het venster
  (gekozen venster, anders het geladen venster, anders 16.384 tokens) + kleine buffer. **Past goed** = past in het
  videogeheugen (min 0,5 GB voor scherm en stuurprogramma); **werkt traag** = alleen met een deel op de processor
  (of: geen geschikte videokaart); **te groot** = meer dan videogeheugen plus 75% van het werkgeheugen min 2 GB. Een
  model dat Ollama nu geladen heeft, krijgt het oordeel uit `/api/ps` (`size_vram` tegen `size`), niet de schatting.
  Hybride modellen (Qwen3.5/3.6, `full_attention_interval`) tellen alleen de lagen met attention.
- **Aanrader voor een eerste bot** (`recommend`): eerst wat al op de pc staat (het grootste model dat past en tools
  kan; bij twee kopieën van hetzelfde model het geladen exemplaar), anders de beste download die past (de grootste
  Qwen3 uit de lijst), anders een geïnstalleerd model dat traag werkt, anders de kleinste download. Nooit een model dat
  te groot is of geen tools kan. `ctx.services.localModels.pickChatModel` geeft dit advies aan `localChatModel`
  (`server/agent/alternatives.ts`), zodat een eerste bot op Ollama dat model krijgt — alleen met echte gegevens
  (hardware bekend, elke modelgrootte bekend); anders beslist de oude regel.
- **Downloadlijst** (`catalog.ts`): 8 Ollama-modellen die volgens de Ollama-bibliotheek tools kunnen, met de
  downloadgrootte uit de registry-manifesten (`registry.ollama.ai/v2/library/<naam>/manifests/<tag>`, nagekeken op
  2026-11-09) en de KV-cache per token uit de opbouw van het model. De teksten per model staan in de UI.
- **Downloaden** (`ollama.ts`, `Pulls`): alleen op een klik van de eigenaar, alleen modellen uit de lijst, nooit een
  model dat te groot is, en niet als de schijf te vol is. `POST /api/pull` van Ollama met voortgang (opgeteld over de
  lagen) als event `localmodels.pull`; stoppen kan (Ollama gaat later verder waar het bleef). Na een gelukte download
  volgt vanzelf de tooltest.
- **Tooltest** (`probe.ts`): één korte vraag ("Hoe laat is het nu in Amsterdam?") met drie tools; het model moet
  `get_time` voor Amsterdam aanroepen. Uitslag: *tools werken*, *alleen tekst* (antwoord zonder tool, het model heeft
  geen tools, of llama-server zonder `--jinja`), *tools onbetrouwbaar* (verkeerde tool) of *test mislukt*. Een
  toolopdracht als tekst die TeamBot omzet telt als *tools werken* (detail "als tekst"). Ollama: native `/api/chat`,
  denken uit, maximaal 400 tokens. Een geladen model wordt getest zoals het geladen is (zelfde `num_ctx`, geen herlading);
  een model dat een geladen model van de videokaart zou duwen draait op de processor (`num_gpu: 0`) en wordt na 30
  seconden weer uitgeladen. LM Studio, llama.cpp en andere lokale servers: via TeamBots eigen adapter, zoals een bot.
  Bewaard in `local_model_probes` per server, model en Ollama-digest (een nieuwe download wordt opnieuw getest);
  een mislukte test wordt niet bewaard.
- **Waarschuwing "Ollama gebruikt je videokaart niet"**: een model staat in `/api/ps` 100% op de processor
  (`size_vram` 0), de pc heeft een geschikte videokaart, en geen enkel geladen model gebruikt die kaart. Dan: welk
  model, welke kaart, het nieuwste stuurprogramma (link per merk) en Ollama opnieuw starten. Geen waarschuwing bij een
  model dat deels op de kaart staat (te groot, geen stuurprogrammaprobleem), naast een model op de kaart, of op Apple
  silicon. Modellen die de tooltest zelf op de processor zette tellen niet mee.

## Contextvenster voor LM Studio en llama.cpp (in `server/providers/localmodels.ts`)

Alle drie (Ollama, LM Studio, llama.cpp) gebruiken nu `fitChat`: elk verzoek past in het venster waarmee het model
draait vóór het vertrekt (oude tool-uitvoer inkorten, ongebruikte apps weglaten, oudere beurten weglaten, de vraag
blijft; de gebruiker leest wat er gebeurde). Venster: Ollama het gekozen venster of `/api/ps`/Modelfile; LM Studio het
gekozen venster (waarmee TeamBot het model laadt) of het geladen venster (`/api/v0/models`, of `/api/v1/models` van
LM Studio 0.4); llama.cpp `/props` (`n_ctx` per slot). Is het venster vóór de eerste aanroep onbekend (LM Studio laadt
het model pas voor dit verzoek), dan kijkt TeamBot erna: paste het niet, dan staat er een melding bij het antwoord en
passen de volgende aanroepen van de run. Weigert de server toch (strengere telling), dan één keer opnieuw met een
strenge telling. llama-server zonder `--jinja` (HTTP 500 "tools param requires --jinja flag") antwoordt zonder tools,
met de melding hoe het wel kan.

## Toolaanroepen als tekst (`server/providers/toolcall-text.ts`, 0.4.4)

Schrijft een model een toolaanroep als tekst in plaats van als echte aanroep, dan maakt TeamBot er een echte van. Dat
gebeurt in `fitChat` (alle lokale servers) en in de OpenAI-compatibele adapter (ook gratis cloudmodellen). Drie vormen:

- JSON (`{"name", "arguments"}`, ook `parameters`/`args`, een OpenAI-`{type, function}`, een lijst of `{tool_calls}`),
  kaal of binnen `<tool_call>`, `<|tool_call_start|>` of `<function_calls>`;
- de Qwen3-Coder-vorm `<function=naam><parameter=sleutel>waarde</parameter></function>`, met of zonder `<tool_call>`
  eromheen. Ollama eet soms de openingstag op en laat alleen `</tool_call>` staan; zo bleef de taak
  *ads-roas-campagnes* (docs/quality) twee keer als tekst hangen. De lezer is een TypeScript-port van Ollama's
  `model/parsers/qwen3coder.go` (MIT; `server/providers/qwen3coder.ts`, licentie in `third_party/ollama`). Een waarde
  krijgt het type uit het JSON-schema van de tool (boolean, integer, number, array, object, anders tekst);
- licht kapotte argument-JSON (komma te veel, enkele aanhalingstekens, commentaar, Python `True`) wordt hersteld met
  `jsonrepair` (ISC; `server/providers/tool-args.ts`), ook bij echte toolaanroepen van de OpenAI-, Responses- en
  Bedrock-adapters. Afgekapte JSON wordt nooit aangevuld: een herstel telt alleen als de tekst eindigt zoals JSON
  eindigt (`}` of `]`) en het antwoord niet op de tokenlimiet stopte.

Regels: alleen aanroepen van tools die zijn aangeboden. Kale JSON alleen als het hele antwoord de aanroep is. Een
aanroep in opmaak (`<tool_call>`, `<function=`) mag na een korte zin komen ("Ik lees het bestand."), nooit vóór meer
tekst. Is zo'n aanroep niet met zekerheid te lezen (onbekende tool, open tag, kapotte JSON, afgekapt), dan draait er
niets: het model krijgt één aanroep terug die de toolpoort weigert met een correctie (`__invalid_call`,
"INVALID_TOOL_CALL: … Er is niets uitgevoerd"), zodat het opnieuw kan proberen in plaats van dat de ruwe opmaak het
antwoord wordt.

Daarna controleert de toolpoort (`server/tools/schema.ts`, `@cfworker/json-schema`, MIT) de argumenten van élke
aanroep tegen het volledige JSON-schema van de tool: geneste objecten, items van lijsten, `enum`, grenzen,
`required` op elke diepte, `$ref`/`$defs`, onbekende argumenten bij `additionalProperties: false`. Vooraf twee milde
stappen: `"5"` → 5, `"true"` → true en `'["a"]'` → `["a"]` waar het schema dat type vraagt, en een optioneel argument
dat `null` is valt weg. `format` wordt niet afgedwongen. De fout noemt de plek (`items/0/qty moet type integer
hebben, maar is string`) en vraagt de tool opnieuw aan te roepen. De Broker vraagt nog steeds toestemming voor alles
wat wel draait.

Ollama blijft standaard op de OpenAI-laag `/v1` als niets de native API nodig heeft (geen gekozen venster, geen
denkniveau): live gecontroleerd op Ollama 0.40.15 (9 november 2026) met qwen3.6 35B-A3B gaven `/v1` en `/api/chat`
twee keer dezelfde echte toolaanroep. De native chat splitst nu ook `<think>` uit het antwoord en kent `num_gpu` en
`keep_alive` (voor de tooltest).

## API (`/api/local-models`, alleen eigenaar en beheerders; leden op een server krijgen `{ allowed: false }`)

| Route | Wat |
|---|---|
| `GET /local-models[?refresh=1]` | Hardware, advies per geïnstalleerd model en voor de lijst, aanrader, waarschuwing, downloads, andere lokale servers, vrije schijfruimte |
| `POST /local-models/pull {model}` | Download uit de lijst starten (voortgang via event `localmodels.pull`) |
| `POST /local-models/pull/cancel {model}` | Download stoppen |
| `POST /local-models/probe {model, providerId?}` | Tooltest (Ollama, of een andere lokale provider); event `localmodels.probe` |
| `POST /local-models/use {model}` | Standaardmodel van Ollama voor nieuwe bots (koppelt Ollama als dat nog niet is gebeurd) |

## UI

`ui/src/modules/local-models`: `<LocalModelsCard />` staat op Instellingen › AI-providers. Het startscherm kan
`<LocalModelsCard compact />` tonen (de pc in één zin, de waarschuwing en de aanrader met één knop):
`import { LocalModelsCard } from '../modules/local-models';`. Technische details (vensters, geschatte geheugen,
waar de test draaide, bronnen) staan dichtgeklapt onder *Meer opties*.

## Tests

`tests/local-models.test.ts`: hardware uit de echte Windows-gegevens van een pc met RX 7800 XT, het advies voor vier
soorten pc's, de aanrader, de waarschuwing uit `/api/ps`-fixtures, de tooltest en hoe die draait, toolopdrachten als
tekst, het inpassen voor llama.cpp en LM Studio (nepserver, ook JIT-laden en zonder `--jinja`), LM Studio 0.4's
`/api/v1/models`, en de routes tegen een nep-Ollama (download met voortgang, tooltest erna, cache per digest,
"gebruik voor nieuwe bots"). `tests/toolcall-robust.test.ts`: de Qwen3-Coder-vorm (Ollama's eigen testgevallen plus
strengere weigeringen), het echte antwoord van *ads-roas-campagnes* en andere fixtures in `tests/fixtures/toolcalls`,
JSON-herstel zonder afgekapte JSON aan te vullen, de volledige schemacontrole, de OpenAI-compatibele adapter tegen een
nepserver en de toolpoort die niets kapots laat draaien.
