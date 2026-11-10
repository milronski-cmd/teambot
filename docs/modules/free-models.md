# Module `free-models` — Gratis modellen

Server `server/modules/free-models/` (`sources.ts` = de gratis bronnen met limieten en voorwaarden, `privacy.ts` =
privacylabels, `quota.ts` = limietsignalen als losse functies, `family.ts` = modelfamilie, `service.ts` = catalogus,
tegoed en proeven, `index.ts` = routes en `ctx.services.freeModels`). Antwoordcontrole in
`server/providers/answer-check.ts`. UI `ui/src/modules/free-models/` (Instellingen › **Gratis modellen**). Tests:
`tests/free-models.test.ts` (opgenomen modellenlijsten van Kilo en OpenRouter in `tests/fixtures/free-models/`,
antwoorden volgens de documentatie van elke aanbieder; geen netwerk) en `tests/e2e/free-engines.mjs` (Edge headless, computer
en gekoppelde telefoon: OpenCode en Ollama aanzetten, uitzetten en installeren). Pakket D1 van [PLAN_0.4](../PLAN_0.4.md); de keten
zelf, de pauze bij *Belangrijk* en de weekreserve bouwt D2 bovenop deze dienst. Bronnen en voorwaarden:
[PROVIDER_POLICY.md](../PROVIDER_POLICY.md#gratis-bronnen-instellingen--gratis-modellen).

## Wat het doet

- **Gratis bronnen**: Groq, OpenRouter (`:free`), Cloudflare Workers AI, Z.ai GLM Flash en de **Kilo Gateway** (nieuw
  providertype `kilo`, werkt zonder sleutel: alleen de gratis modellen, 200 verzoeken per uur per IP). Daarnaast tellen
  mee: de gratis modellen van **OpenCode** (alleen via de OpenCode CLI, nooit de Zen-server zelf) en **lokale modellen**
  (Ollama, LM Studio, vLLM, …). **Niet**: de gratis laag van Gemini (EER-regel), automatische routers
  (`openrouter/*`, `kilo-auto/*`).
- **Eén account per aanbieder.** Staan er twee Groq-koppelingen, dan gebruikt TeamBot de oudste eigen (ingeschakelde)
  en zegt de kaart dat de andere niet meetelt. Gedeelde koppelingen van de beheerder komen na de eigen.
- **Standaard uit.** Een bron doet mee als er een ingeschakelde koppeling is en hij in de kaart niet uit staat
  (instelling `freeModels.off` per gebruiker). Kilo krijgt pas een koppeling als je hem aanzet.
- **Alles staat op de kaart, met één knop** (0.4.4). Onder *Op deze computer* staan OpenCode en Ollama altijd (andere
  lokale engines zodra ze gekoppeld zijn), ook als ze niet gekoppeld of uitgezet zijn: **Aanzetten** koppelt OpenCode
  (via `ctx.services['cli-agents'].connect`, op een gratis model, alleen de eigenaar) of Ollama (als die hier draait,
  op het adres dat de detectie vond) en zet de bron aan; **Uitzetten** haalt hem uit de keten. Niet op deze computer:
  **Installeren** (OpenCode: TeamBot's eigen gecontroleerde kopie via `/cli-agents/free-start`, ook als OpenCode alleen
  in een andere app zoals OpenBot staat; Ollama: de stappen en *Opnieuw controleren*). Tot 0.4.3 stonden OpenCode en
  Ollama alleen als regel zonder schakelaar onder de online bronnen, en helemaal niet als ze niet gekoppeld of uit waren.
  Onder *Online, met een gratis account* staan Groq, OpenRouter, Cloudflare, Z.ai en Kilo met *Gebruiken* en de sleutel.
- **Tegoed per account** (`free_sources`): wachten na een 429 tot de bekende reset, een kapotte sleutel, wat er vandaag
  over is (OpenRouter `GET /api/v1/key` → `free_model_daily_requests`, gratis en telt nergens mee; Groq
  `x-ratelimit-*` per model), en bij Kilo zonder sleutel een eigen telling per uur (schatting).
- **Catalogus** (`free_models`): de gratis modellen per bron (hoogstens 25, aanbevolen modellen eerst), **dagelijks**
  opnieuw uit de modellenlijst van de aanbieder (gratis, geen prompt). Een model dat niet meer in de lijst staat, wordt
  niet meer aangeboden.
- **Proef met één tool**: `ping({ text: "ok" })`, `max_tokens` 512, denken laag. Resultaat *tools werken* (een geldige
  aanroep) of *alleen tekst*; tot dan *nog niet getest*. **Hoogstens één proef per model per dag** (ook als het nog
  eens gevraagd wordt), binnen een dagbudget per bron (OpenRouter en Z.ai 3, Kilo 5, Groq en Cloudflare 6), nooit
  terwijl de bron of het model op een reset wacht, en een getest label pas na 7 dagen opnieuw. Echt verkeer telt ook:
  een antwoord met een tool-aanroep maakt het label *tools werken*, "Dit model ondersteunt geen tools" maakt het
  *alleen tekst*. OpenCode en lokale modellen worden nooit geproefd (OpenCode: eigen tools, en het zou het gratis
  tegoed kosten; lokaal: de server zegt zelf of een model tools kan, en elk model laden is zwaar).
- **Privacylabel** per bron (en per model waar de voorwaarden verschillen): *blijft op je pc* / *bewaart niets* /
  *kan trainen*. Onbekend = *kan trainen*.
- **Antwoordcontrole** (catalogusvlag `answerCheck` op groq, openrouter, cloudflare, zai, kilo): een "geslaagd"
  antwoord dat een foutmelding is (JSON-fout, foutpagina van een proxy, "not enough credits … please upgrade"), een leeg
  antwoord, een stream die eindigt zonder `[DONE]` of `finish_reason`, of een stream die stilvalt (120 s tot het eerste
  stuk, daarna 45 s) wordt een `ProviderError` met een categorie die de reserve-logica kent: geen tegoed/limiet →
  `limit`, afgekapt/stil/leeg/onduidelijke gatewayfout → `outage`. De eerste 600 tekens tekst worden vastgehouden tot
  duidelijk is dat het geen foutmelding is, zodat een foutmelding nooit als antwoord in de chat verschijnt.

## Hoe uitkomsten binnenkomen

- **Vanzelf**, zonder de runner aan te passen: de module registreert de vijf gratis API-types opnieuw met een `create`
  die de adapter omwikkelt (`service.wrap`) en een `onResponse` meegeeft (`createFor(def, { onResponse })` uit
  `server/providers/kinds.ts`). Elk chatverzoek via die types meldt zo zijn afloop en zijn rate-limit-headers.
- **Van buiten** via `report()`: voor wat de wikkel niet ziet (OpenCode als CLI-engine, een uitkomst die de keten zelf
  vaststelt). Dezelfde uitkomst binnen 3 s na de wikkel wordt genegeerd (geen dubbele telling).

| Uitkomst | Wat de catalogus doet |
|---|---|
| succes | wachttijd van de bron weg, fouten op 0, model terug als het "weg" was |
| 429 / geen tegoed | wachten tot de reset: Groq-headers (alleen dat model), OpenRouter `X-RateLimit-Reset` in de foutbody, `free-models-per-day` / Cloudflare 4006 → 00:00 UTC, `Retry-After`, tijd in het bericht; anders 1 min die verdubbelt (max 1 uur, nooit voorbij de dagreset); Kilo zonder sleutel 1 uur |
| 404 / 410 / model bestaat niet | model **weg**: uit de catalogus, `ctx.log.info` + audit `free_models.model_gone`, **geen melding**. Staat het de volgende dag weer in de lijst, dan pas terug na een geslaagde proef (spookmodellen) |
| OpenRouter "No endpoints found that support tool use" | geen "weg", maar *alleen tekst* |
| 401 | bron: *Sleutel ongeldig* (tot een nieuwe sleutel of een succes) |
| 403 | dat model 1 dag niet |
| netwerk | bron 2 min niet |
| overbelast / afgekapt / leeg | na 3 keer achter elkaar rust het model 10 min (verdubbelt, max 2 uur) |
| te lang, verzoek geweigerd, inhoudsfilter | niets: dat gaat over het verzoek, niet over de bron |

## Dienst voor de gratis keten (D2): `ctx.services.freeModels`

```ts
candidates(q?: {
  userId?: string;          // standaard de eigenaar
  needTools?: boolean;      // "alleen tekst" valt weg; "tools werken" vóór "nog niet getest"
  privacy?: 'local' | 'no-store' | 'may-train' | 'any';   // het minst private niveau dat mag
  family?: string;          // een model-id of familie ("gpt-oss", "nemotron", …): die familie eerst
  exclude?: (string | { providerId: string; model?: string })[];  // id = hele bron weg; {providerId, model} = dat
                            // model weg en de rest van die bron ná de andere bronnen (tegoed telt per account)
  includeLocal?: boolean;   // standaard true; lokaal altijd achteraan
  limit?: number;
}): Candidate[]

interface Candidate {
  providerId; providerKind; providerLabel; engine: 'api' | 'cli' | 'local';
  model; modelLabel?; family;
  tools: 'tools' | 'text' | 'unknown';
  privacy: { level: 'local' | 'no-store' | 'may-train'; label; note?; source?; checked? };
  available: boolean;
  availableAt: number | null;   // ms; null = nu (beschikbaar) of onbekend (kapotte sleutel)
  resetsAt: number | null;      // de volgende bekende dagreset van de bron
  reason?: string;              // "Daglimiet bereikt", "Sleutel ongeldig of verlopen", …
  remaining?: { requests: number | null; limit: number | null } | null;
}

report(provider: string | { providerId: string; model?: string },
       outcome: 'ok' | { ok: true; usedTools?: boolean; toolCalls?: number; noTools?: boolean }
                     | { error: unknown } | { limit: true; resetAt?: number | null; message?: string }
                     | { gone: true; status?: number; message?: string }): void
familyOf(model: string): string
privacyLabel(kind: string, model?: string): PrivacyLabel
sources(userId): View            // wat de kaart toont (nooit sleutels)
refresh(userId, { force?, probe? }): Promise<void>
service: FreeModelsService      // voor tests en diagnose
```

Volgorde van `candidates()`: beschikbaar vóór wachtend (wachtend op `availableAt`, onbekend achteraan) → online vóór
lokaal → een bron die nog niet geprobeerd is vóór een die in `exclude` staat → dezelfde familie eerst → (met
`needTools`) *tools werken* vóór *nog niet getest* → voorkeur van de bron (OpenCode, Groq, OpenRouter, Cloudflare,
Z.ai, Kilo) → aanbevolen modellen van de aanbieder. Voor de pauze bij *Belangrijk* (D2): de vroegste `availableAt` van
de passende kandidaten is de verwachte hervattijd.

`candidates()` is synchroon (uit de catalogus). Is een bron nog nooit opgehaald, dan komt de ingebouwde modellenlijst
van het providertype erin (*nog niet getest*).

## Gebruiksbalk (pakket E)

Na elke verandering meldt de module elke ingeschakelde online bron aan `ctx.services.usage.reportSource` (als die
bestaat): `{ id: <kind>, label, status: available|low|limited|offline|unknown, resetsAt, usedPercent, estimated,
note, userId, providerId, kind: 'free' }`. `usedPercent` komt van OpenRouter `/key` (exact) of de eigen uurtelling van
Kilo (schatting); *low* vanaf 80%. OpenCode en lokale engines meldt de module niet (die leidt de balk zelf af).

## Privacylabels in de rest van TeamBot (pakket P)

De privacylabels van de module `network` (`server/modules/network/privacy.ts`: het label in de chatkop, de
bot-editor en *Wat verlaat je pc?*) hebben een eigen gecontroleerde tabel. Voor de gratis bronnen die daar **niet** in
staan (nu Kilo en Z.ai, anders *Privacy onbekend*) meldt deze module bij de start haar eigen voorwaarden aan met
`registerPrivacyRule(kind, (model) => label)`: niveau, ontvanger, uitleg, bron en controledatum. Wat de tabel van
`network` zelf al kent (`hasBuiltinPrivacy(kind)`: Groq, OpenRouter, Cloudflare, OpenCode per model, lokale servers
naar waar ze draaien) blijft zoals het is. Bij het stoppen gaan de regels er weer af. De kaart *Gratis modellen* en de
gratis keten gebruiken de eigen tabel van deze module (`privacy.ts`).

## API

| Route | Wat |
|---|---|
| `GET /api/free-models` | De kaart: `sources` (online) en `engines` (OpenCode, Ollama, gekoppelde lokale engines), per bron aan/uit, status, reset, privacylabel, limiet, modellen met labels, verdwenen modellen, resttegoed, bronnen en controledatum; per niet-gekoppelde engine `setup` (`installed`, `canInstall`, `otherApp`, `steps`, `ownerOnly`). Nooit een sleutel. |
| `PUT /api/free-models/sources/:kind` | `{ on?, apiKey?, accountId? }`: koppeling maken of bijwerken (sleutel naar de versleutelde kluis; nooit bij een CLI of lokale engine), aan/uit; `on: true` bij OpenCode of een lokale engine zonder koppeling koppelt die eerst (OpenCode alleen voor de eigenaar). Controleert meteen de modellenlijst (hoogstens 12 s), proeven daarna op de achtergrond. Uitzetten haalt de bron uit de keten; de koppeling zelf blijft. |
| `POST /api/free-models/refresh` | Lijsten nu ophalen; proeven die aan de beurt zijn op de achtergrond (nog steeds hoogstens één per model per dag). |
| `GET /api/free-models/candidates?needTools=1&privacy=no-store&family=…` | De volgorde die de keten nu zou proberen. |

Achtergrond: 20 s na de start en daarna elk half uur: lijsten die een dag oud zijn ophalen en per bron hoogstens één
proef die aan de beurt is.

## Wat nog niet live is getest

Alle tests gebruiken opgenomen lijsten en antwoorden volgens de documentatie; er is geen echte sleutel gebruikt. De
openbare modellenlijsten van Kilo en OpenRouter zijn op 9 november 2026 live opgehaald (GET, zonder sleutel). Niet live:
chatten en proeven bij Groq, OpenRouter, Cloudflare, Z.ai en Kilo, het `/key`-antwoord van OpenRouter met een echte
sleutel, en de echte 429-antwoorden van Kilo en Z.ai.
