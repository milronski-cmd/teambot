# Module `usage` — Gebruik en limieten

Hoeveel de abonnementen van de eigenaar nog kunnen (Claude Code, Codex), welke gratis bronnen beschikbaar zijn, wat
elke bot verbruikt, de context van een gesprek, meldingen bij een limiet, en wat er nu loopt of wacht (statusvenster,
telefoon). Pakket E van `docs/PLAN_0.4.md`.

**Kort:** onderin de zijbalk staat altijd een rustige **gebruiksbalk**: een balkje per venster (Claude 5 uur, week en
een modelweek zoals Opus als Claude die meldt; Codex 5 uur en week), groen, oranje vanaf 80% en rood bij de limiet,
met de resettijd; daaronder per gratis bron een bolletje (*beschikbaar*, *op tot …*, *niet bereikbaar*). Een klik
opent *Gebruik en limieten* met het verbruik per bot (vandaag en deze week). TeamBot toont alleen wat een engine zelf
meldt; wat TeamBot afleidt heet **schatting**, en wat niet gemeld is staat er als *nog niet gemeld*.

## Waar de cijfers vandaan komen

| Engine | Bron | Wat | Kost quota? |
|---|---|---|---|
| Claude Code | `rate_limit_event` in de stream van een beurt | het venster dat bij dat verzoek telt (5 uur, week, modelweek), percentage en reset | nee (onderdeel van de beurt) |
| Claude Code | het lokale `/usage`-commando in printmodus | alle vensters als tekst | nee, geen modelaanroep (`local_command: usage`) |
| Codex | app-server `account/rateLimits/read` en `account/rateLimits/updated` | 5 uur en week (of 30 dagen bij ChatGPT Go), plan | nee |
| OpenCode | — | geen tegoed; een gratis limiet ziet TeamBot pas als een beurt hem raakt (reset uit de foutmelding = schatting) | — |
| Ollama en andere lokale servers | eigen herkenningsadres (`providers/local.ts`), hoogstens één keer per minuut | bereikbaar of niet | — |
| Andere gratis bronnen | `reportSource()` door een andere module (de gratis keten) | status, reset, eventueel percentage | — |

Ontleden staat in `parse.ts` (getest met opgenomen uitvoer in `tests/fixtures/usage/`), de staat per account in
`service.ts`, de pure helpers van de balk in `bar.ts` (server) en `ui/src/modules/usage/bar.ts` (woorden en kleuren).

## Live houden zonder de CLI's lastig te vallen

- **Tijdens een beurt** melden Claude en Codex zelf hun venster: de balk verspringt meteen (WebSocket `usage.updated`).
- **Na een beurt** op Claude Code of Codex vraagt TeamBot de CLI één keer opnieuw (na 15 s, hoogstens één keer per
  minuut per account), tenzij de beurt zelf al elk venster meldde dat de balk toont. Zo klopt de balk binnen een
  minuut na nieuw gebruik via TeamBot (`runEnded` → `readSoon`).
- **Gebruik buiten TeamBot** (de Claude-app, een terminal) ziet TeamBot alleen door te vragen: bij het openen van de
  app, als het venster terug in beeld komt (na 2 minuten) en elke 10 minuten zolang TeamBot in beeld is
  (`useLiveUsageBar`). Twee open vensters of de telefoon vragen niet dubbel: de server bewaart elke uitlezing 2
  minuten.
- Zonder WebSocket laadt de balk elke minuut de opgeslagen cijfers opnieuw (alleen de database, geen CLI).
- Er is **geen** achtergrondpoller op de server: zonder open venster leest TeamBot alleen na eigen beurten.

## Meldingen

Op de pc (meldingencentrum, bureaubladmelding) en op de telefoon (push als je niet online bent), via de
`notification`-events van de bestaande meldingenmodule:
- **bijna op**: één keer per venster per periode bij de ingestelde grens (standaard 80%; 70–95% in te stellen);
- **limiet bereikt**: één keer per blokkade (ook als daarna nog een venster vol raakt);
- **weer beschikbaar**: alleen na een gemelde "bereikt", bij de reset of als de engine zegt dat hij weer werkt.

Een nieuwe periode (de reset schuift meer dan 10 minuten op) begint opnieuw. Een volle 5-uursvenster blijft
geblokkeerd als Claude in een volgende beurt alleen de week meldt; zijn er meerdere vensters vol, dan geldt de laatste
reset. Melding opent `#/m/usage/`.

## API

| Route | Wat |
|---|---|
| `GET /api/usage/bar` | de balk: `{ engines, sources, now }`; `?refresh=1` vraagt Claude Code en Codex in de achtergrond opnieuw als hun cijfers ouder zijn dan 2 minuten |
| `GET /api/usage/breakdown?by=bot` | verbruik per bot vandaag (sinds middernacht) en deze week (sinds maandag 00:00): aanroepen, tokens, kosten, geschatte waarde van abonnementswerk, per engine wie betaalt |
| `GET /api/usage/breakdown?by=team` | hetzelfde per team (module `teams`): een rij per team (`kind: 'team'`, in de volgorde van de teams, ook zonder verbruik) met zijn bots in `children`; werk zonder team (geen bot, een verwijderde bot) als laatste rij `kind: 'none'` |
| `GET /api/usage/limits` (`/:id`, `POST /:id/refresh`) | alle accounts in detail (bestond al) |
| `PUT /api/usage/alerts` | meldingen aan/uit en de grens |
| `GET /api/usage/context/:threadId` | de contextring van een gesprek |
| `GET /api/usage/status` | wat er loopt en wacht; per run ook de huidige stap (`doing`) en de browser van de bot (`browser`, 0.4.5) |
| `GET /api/usage/estimate?routineId=` of `?agentId=` (`&important=1`) | *Kosten vooraf* (0.4.4, P3): wat één run ongeveer kost en welk deel van de vensters, zie hieronder |

Events: `usage.updated` (cijfers van een account, een bron of de reserve veranderd), `usage.spend` (een beurt is
klaar: het verbruik per bot is veranderd), `usage.context`.

**Per team (pakket B2):** `breakdown` heeft een `by`-parameter (`bot` of `team`) en geeft in `groupings` wat er kan
(`['bot', 'team']` met de module `teams`, anders `['bot']`; dan geeft `by=team` een nette 400). Per team is een rij een
team met zijn bots in `children` (dezelfde vorm als per bot); `today`, `week`, `engines` (opgeteld per engine) en
`total` houden dezelfde vorm. Een bot telt bij zijn huidige thuisteam. Het dagbudget van een team staat bij de teams
(`docs/modules/teams.md`).

## Kosten vooraf (0.4.4, pakket P3)

Vóór een grote taak of routine zegt TeamBot wat het ongeveer kost (`server/modules/usage/estimate.ts`, altijd met het
label *schatting*):

- **Basis:** de mediaan (middelste waarde) van de laatste 10 afgeronde runs van dezelfde routine (`routine_runs.usage`),
  anders van dezelfde bot (`runs.usage`). Geen runs: *nog geen eerdere runs om op te schatten*.
- **Geld:** die tokens maal de prijs van het model van de engine waarop het werk start (eigen engine van de routine, anders
  de bot, anders de standaard). De prijs komt uit één functie, `modelPrice()` in `usage/prices.ts` (nu `priceInfo` uit
  `providers/pricing.ts`: eigen prijzen → de live lijst van de aanbieder → de gedateerde tabel); een grotere catalogus
  (models.dev) gaat daar in. Geen prijs, maar wel gemeten kosten: de mediaan daarvan. Anders *onbekend*, nooit gegokt.
  Abonnement, gratis model of eigen computer: *kost geen geld*.
- **Deel van een venster** (5 uur, week, Codex-vensters): het venster zegt hoe vol het is (`usedPercent`), het eigen
  logboek (`usage_log`) hoeveel tokens er sinds het begin van dat venster door dit account gingen; één run is dan
  `tokens × usedPercent / tokens in het venster`. Werk buiten TeamBot op hetzelfde account vult het venster ook, dus de
  schatting valt eerder te hoog dan te laag uit. Een venster waarvan de reset voorbij is, telt als onbekend.
- **Past het niet** (groter dan wat er over is, of het venster is al vol, of de engine weigert tot een bekende tijd), dan
  staat er `startAfter`: de reset + 1 minuut (hetzelfde als gepauzeerd belangrijk werk, `pauseUntil`). Zijn er meer
  vensters vol, dan de laatste reset.
- **Wanneer getoond** (`show`, `reason`): het past niet (`nofit`), *Belangrijk* (`important`), vanaf $0,50 per keer
  (`cost`) of vanaf 10% van een venster (`window`). Kleiner werk krijgt geen kaart.

Op het scherm (`ui/src/modules/usage/Estimate.tsx`, `CostEstimate`): in de routine-editor (*Uitvoering en resultaat*,
onder *Belangrijk*) en in het taakvenster van een taak van een eigen bot. *Start na de reset om …* plant bij een routine
één run die tot dan wacht (`POST /routines/:id/run-after`, zie [routines](routines.md)); bij een taak krijgt de bot de
taak op dat moment in zijn eigen chat, als eenmalige routine (`POST /rooms/tasks/:id/start-after`, zie
[rooms](rooms.md)). Getest in `tests/usage-estimate.test.ts` en `tests/e2e/cost-estimate.mjs` (ook de gekoppelde
telefoon) en een stap in `tests/e2e/phone-owner.mjs`.

## Gebruikslimiet per bot (0.4.5)

*Bot-instellingen › Gebruikslimiet*: hoogstens zoveel kosten (US$, schatting uit `usage_log`) of zoveel tokens (in +
uit) per dag of per week (vanaf maandag 00:00, klok van de server). Opgeslagen als `settings.usageCap = { kind:
'usd' | 'tokens', amount, period: 'day' | 'week' }`; `cap.ts`. De runner vraagt het vóór elke modelaanroep, op elke
engine (ook abonnement en gratis), via de haak `beforeAnyModelCall`. Bereikt: de bot pauzeert met één bericht
("Zuinig heeft zijn eigen limiet bereikt: vandaag zijn 30 van 20 tokens gebruikt. Om 00:00 …"), dezelfde stop als het
dagbudget (`BudgetError`, `meta.budget` met `cap`), met de link *Gebruikslimiet aanpassen*. Alles wat onder de bot in
`usage_log` staat telt mee (ook geheugen en controles). `GET /usage/bots/:id/cap` → `{ cap, used: { usd, tokens },
resetAt, reached }`. Index `usage_agent (agent_id, created_at)`.

## Dienst voor andere modules (`ctx.services.usage`)

### Een gratis bron melden: `reportSource`

```ts
ctx.services.usage?.reportSource?.({
  id: 'groq',                 // vast, [\w.:-]{1,60}
  label: 'Groq',              // naam in de balk (productnaam, niet vertaald), max 40
  status: 'limited',          // 'available' | 'low' | 'limited' | 'offline' | 'unknown'
  resetsAt: 1794546000000,    // epoch ms, epoch s of ISO; null = onbekend
  usedPercent: 100,           // optioneel, 0–100
  estimated: true,            // TeamBot telde het zelf / leidde het af → "schatting"
  note: '1.000 verzoeken per dag per model; telt TeamBot zelf.', // één korte Nederlandse zin
  userId: owner.id,           // weglaten = voor iedereen op deze server
  providerId: cfg.id,         // optioneel: vervangt het bolletje dat TeamBot zelf van die provider afleidt
  kind: 'free',               // 'free' (online gratis tegoed) of 'local'
});
```

- Geeft terug wat de balk toont, of `null` als `id` of `label` onbruikbaar is.
- Mag vaak worden aangeroepen: de database en de UI worden alleen bijgewerkt als er iets veranderde.
- Wordt onthouden na een herstart (tabel `usage_sources`). Na `resetsAt` toont de balk de bron vanzelf weer als
  *beschikbaar*, tot er iets anders gemeld wordt.
- `providerId`: hoort de bron bij een provider van TeamBot, dan is er één bolletje voor die provider. Een limiet die
  TeamBot zelf later zag (een beurt raakte hem) gaat voor een ouder bericht. Een bron van een verwijderde of
  uitgeschakelde provider verdwijnt.
- `clearSource(id, userId?)` haalt een bron weg.

Zonder melding leidt TeamBot zelf een bolletje af van elke ingeschakelde gratis of lokale provider (OpenCode, Groq,
OpenRouter …, Ollama, LM Studio …): *op* zolang een bekende limiet loopt, lokaal *niet bereikbaar* als de server niet
antwoordt, een gestopte dienst (GitHub Models) *niet bereikbaar* met de datum, anders *beschikbaar*.

### De weekreserve tonen: `reportReserve`

```ts
ctx.services.usage?.reportReserve?.({ atPercent: 85, active: true, userId?, providerId?, windowId: 'seven_day' });
```

Een streepje op de weekbalk van Claude bij `atPercent`, en in de uitgebreide weergave "Weekreserve vanaf 85%:
daarboven gaat gewoon werk naar gratis modellen. Nu actief." De routering zelf doet de gratis keten (pakket D2); deze
module toont alleen. Alleen in het geheugen: meld hem opnieuw na een herstart en bij elke wijziging (alleen een
wijziging bereikt de UI). `clearReserve({ userId?, providerId?, windowId? })` haalt hem weg.

### Al bestaand

`report(cfg, LimitReport)` (engines tijdens een beurt), `limitHit(...)` (de runner bij een limiet), `refresh(cfg)`,
`state(providerId)` (vensters, blokkade), `engines(userId)`, `setContext/getContext`, `limitNotified(providerId)`,
`bar(userId)`, `breakdown(userId, by?)`.

## Interface

- `UsageMeter.tsx` (0.4.5): `<UsageMeter />` onderin de zijbalk. Eén ring per abonnement of aanbieder: buiten de week,
  binnen het 5-uursvenster (als de aanbieder er een heeft), de beginletter in het midden; grijs tot 75%, oranje vanaf
  75%, rood vanaf 90%. Een klik opent een popover met per regel een dun balkje en één gewone zin ("Nog 62%, weer vol om
  do 09:00."), *Vernieuwen* en *Verbruik per bot en alle limieten*. De pure helpers (`meter.ts`) test
  `tests/usage-meter.test.ts`.
- `UsageBar.tsx`: `<UsageBar where="phone" />` bovenaan *Meer* op de telefoon (toont niets op een breed scherm; tot
  0.4.4 stond hij ook onderin de zijbalk). Een tabel (account, periode, gebruikt, reset) met
  een link over de samenvatting naar `#/m/usage/`; het pijltje toont de resettijden voluit, de gratis bronnen met
  uitleg, de gedeelde pot, wat een schatting is, *Verbruik per bot* en *Vernieuwen*. Open/dicht onthoudt het apparaat
  zelf (`localStorage`, mag ontbreken).
- Nooit alleen kleur: het percentage staat er als tekst, *bijna op* / *limiet bereikt* / *schatting* voor
  schermlezers, en elk bolletje dat niet *beschikbaar* is heeft woorden ernaast (en een andere vorm). Logische
  klassen en `inset-inline-start` voor de reservemarkering, dus goed van rechts naar links.
- `UsagePage.tsx` (*Gebruik en limieten*, ook *Instellingen › Limieten*): *Limieten nu* (grote balken, reset voluit,
  gratis bronnen, gedeelde pot), *Verbruik per bot* (vandaag / deze week; vanaf twee teams ook *Per team*, met de bots
  van elk team), *Alle accounts in detail* (laadt pas als je
  het openklapt, zodat OpenCode niet bij elk bezoek wordt gevraagd) en *Meldingen*.
- `UsagePopover.tsx`: de contextring en het modelchipje in de chatkop (bestond al).
- `StatusPage.tsx`, **Nu bezig** (`#/m/usage/status`, 0.4.5: een eigen plek in de zijbalk, bestemming `now` in
  `shell/nav.tsx`, en op de telefoon in Meer; niet meer op de pagina Geavanceerd): wat op jou wacht, nieuwe antwoorden en
  elke bot die nu werkt met **zijn huidige stap** (de regel van de server, overschreven door de live events
  `message.status` en `tool.progress` zodra die nieuwer zijn), een **klein live beeld** van zijn browser als hij die
  gebruikt (`GET /api/computers/:id/frame.jpg`, elke 3 s zolang de pagina in beeld is) en **Bekijken** (het gesprek met
  de browser ernaast, op de telefoon als blad), **Stoppen** (`POST /api/runs/:id/cancel`) en **Overnemen**
  (`POST /api/computers/:id/takeover`, daarna het live beeld; niet als jij de bediening al hebt). `GET /api/usage/status`
  geeft per run `browser: { url, title, controller: { kind, name } | null, filling } | null` uit
  `ctx.services.computers.status` (module `browser`). Het zwevende statusvenster (`#/m/usage/eiland`) houdt zijn
  compacte rijen. Test: `tests/usage.test.ts` (*Nu bezig*), `tests/e2e/now-busy.mjs` (twee bots echt aan het werk, een
  echte botbrowser, computer en telefoon).

## Beperkingen

- Gebruik buiten TeamBot verschijnt pas bij de volgende uitlezing (zie boven), niet binnen een minuut.
- Claude Code meldt het 5-uursvenster in `/usage` alleen als er in die sessie gebruik is; tot dan staat het er niet.
- OpenCode en de meeste gratis aanbieders melden geen tegoed: hun bolletje is *beschikbaar* tot een limiet geraakt
  wordt, tenzij de gratis keten meer meldt via `reportSource`.
- "Deze week" begint op maandag 00:00 volgens de klok van de server (dezelfde klok als het dagbudget).
