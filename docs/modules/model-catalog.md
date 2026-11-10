# Modelgegevens (models.dev) — `server/modules/model-catalog`, `server/providers/models-dev.ts`

Contextvenster, prijs en mogelijkheden (tools, afbeeldingen, denken, denkniveaus) van modellen komen sinds 0.4.4 uit
de catalogus van [models.dev](https://models.dev) (MIT-data, bijgehouden door het OpenCode-team; licentie in
`third_party/models.dev/LICENSE`, vermeld in THIRD_PARTY_NOTICES.txt). Niet meer uit grote tabellen met de hand.

## Volgorde van vertrouwen ("nooit een gok, altijd een datum")

- **Prijs** (`server/providers/pricing.ts`): eigen prijs → gratis (eigen hardware, `:free`, de gratis modellen van
  Z.ai) → de live modellenlijst van de provider → de **overrides** in `BUILTIN` → models.dev → *onbekend*.
  - `BUILTIN` houdt alleen nog wat models.dev mist of anders zegt dan de prijspagina van de maker: `claude-mythos-5-1`,
    `chat-latest` en de cacheprijs van `claude-sonnet-5-5`. De andere 49 regels kwamen op 9 november 2026 overeen
    met models.dev en zijn weg.
  - Een model zonder eigen regel bij de provider krijgt de prijs van de maker (Claude → Anthropic, GPT/o → OpenAI,
    Grok → xAI, Gemini → Google, GLM → Z.ai), zoals de oude tabel deed voor Bedrock, Vertex en OpenRouter.
  - Geen cacheprijs in models.dev betekent: gecachte invoer is niet goedkoper.
  - 0/0 in models.dev telt niet als gratis. Gratis blijft wat TeamBot zelf zo labelt.
  - Groq krijgt geen catalogusprijs: het gratis plan kost niets, en de prijs van het betaalde plan zou als uitgave
    tellen tegen een daglimiet.
  - Bron in de UI: *models.dev, stand <datum>* (`priceSource: 'catalogus'`).
- **Mogelijkheden** (`server/providers/capabilities.ts`): wat de engine zelf meldt → de tabellen voor Claude en
  OpenAI → models.dev → *onbekend*.
  - De tabellen voor Claude en OpenAI blijven: ze dragen ook het standaard-denkniveau en de aliassen van Claude Code,
    en die heeft models.dev niet. Een denkniveaulijst die de OpenAI-pagina niet noemt (gpt-5-mini, o3, …) komt uit
    models.dev.
  - Voor andere providers vult models.dev in wat nog onbekend is: context, tools, afbeeldingen en denken. Met de
    effort-waarden van models.dev, beperkt tot wat het verzoekformaat van de provider kan dragen.
  - Bron: *Gegevens: models.dev, gecontroleerd <datum>*.

Koppeling providersoort → models.dev: `MODELS_DEV_IDS` in `models-dev.ts`. Lokale servers staan er niet in (gratis,
en ze melden zelf wat ze kunnen).

## Momentopname en dagelijkse vernieuwing

- **Momentopname**: `server/providers/models-dev-snapshot.json` (25 providers, ±1.700 modellen, ±190 KB, gedateerd),
  gebouwd met `npm run models:snapshot` (`-- --from api.json` voor een zelf gedownload bestand). Werkt offline en
  vanaf de eerste seconde.
- **Vernieuwing** (`modelCatalog.refresh`, globale instelling, **standaard uit**: wat de pc verlaat staat uit tot de
  eigenaar het aanzet, PROVIDER_POLICY regel 8). Staat hij aan, dan downloadt TeamBot `https://models.dev/api.json`
  één keer per dag op de achtergrond, kort het in op dezelfde manier en bewaart het in
  `<data>/cache/models-dev.json`.
  - Bij de start neemt TeamBot die kopie over als ze nieuwer is dan de momentopname. Dat gebeurt asynchroon, de
    start wacht er nooit op.
  - Mislukt het (offline, fout antwoord, te groot, te weinig erin), dan blijft wat er was. De fout staat in de status.

## API

| Route | Wie | Wat |
|---|---|---|
| `GET /api/model-catalog` | iedereen | `{ source, fetched, origin: 'snapshot' \| 'refresh', snapshot, providers, models, error, refresh, canEdit }` |
| `PUT /api/model-catalog { refresh }` | eigenaar/beheerder | Vernieuwing aan/uit. Aan en ouder dan een dag: meteen vernieuwen, op de achtergrond. |
| `POST /api/model-catalog/refresh` | eigenaar/beheerder | Nu vernieuwen. Geeft de status terug. |

`ctx.services.modelCatalog = { refresh(), status() }`.

## UI

Instellingen › AI-providers, met *Geavanceerd tonen* aan: de kaart **Modelgegevens** toont de stand van de gegevens
en de schakelaar *Elke dag bijwerken via models.dev* (alleen voor eigenaar en beheerder). Bij een model staat de bron
in de modelgegevens (`ModelFacts`) en in de modellenlijst (*stand <datum>*).

## Tests

`tests/model-catalog.test.ts`:

- inkorten, met 0/0 dat niet als gratis telt;
- de meegeleverde momentopname;
- de prijsvolgorde, met overrides, Bedrock, Groq en de gratis labels;
- de mogelijkheden zonder dat de lijst van de engine wordt overschreven;
- vernieuwen met een nep-fetch: lukt, offline, kapotte kopie;
- de module: standaard uit, alleen eigenaar/beheerder, offline blijft de momentopname.

Geen test bereikt models.dev.
