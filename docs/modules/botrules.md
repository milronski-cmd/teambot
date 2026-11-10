# Module: Eigen regels in gewone woorden (`botrules`)

De eigenaar schrijft per bot of per team regels in gewone woorden, naast de vijf niveaus van *Wat mag de bot?*:
"Mail nooit naar klanten zonder mij te vragen", "Vraag altijd voordat je iets in de webshop verandert", "Mag altijd
bestanden maken in de map Offertes". TeamBot zet elke zin om in een vaste regel, laat vóór het opslaan zien wat hij
ervan maakt, en **handhaaft hem in code** (de Broker), niet alleen in de prompt. Het idee komt van gesloten diensten
(Grok Bot Custom Rules, OpenAI Dots); de uitvoering is eigen.

## Van zin naar regel (`parse.ts`)

Deterministisch (dezelfde zin geeft altijd dezelfde regel), Nederlands en Engels:

- **Effect**: `deny` (*nooit*, *niet*, *never*), `ask` (*vraag eerst*, *nooit … zonder mij te vragen*, *without asking*),
  `allow` (*mag altijd*, *mag zonder te vragen*, *hoeft niet te vragen*).
- **Waar het over gaat** (`match`): een handeling (`verb`: alles, lezen, veranderen, verwijderen, opdrachten uitvoeren,
  versturen, publiceren, betalen), een **app** (bekende namen zoals Shopify, Gmail/e-mail, WhatsApp, GitHub, "webshop"
  voor de gangbare winkelsystemen, plus de eigen apps/MCP-servers van de eigenaar als `mcp:<slug>`), een **map**
  (hele padsegmenten: "Offertes" past op `…/Offertes/a.docx`, niet op `Offertes-oud`), een **website** (met
  subdomeinen), een **tool** (exacte naam) en **anderen** (*klanten*, *anderen*, *customers*: alleen als het naar
  iemand anders dan de eigenaar gaat).
- Wat code niet kan vastleggen ("Noem nooit prijzen zonder overleg") wordt een **review-regel**: Auto Review
  (`agent/autoreview.ts`) krijgt de zin mee en vraagt bij elke actie die iets verandert de eigenaar als die ertegen
  ingaat of als hij twijfelt — ook buiten het niveau Automatisch. Kan de controle niet (geen model, CLI-engine zonder
  chat), dan vraagt de bot het jou. Een review-regel staat nooit iets toe.
- Een `allow`-regel moet een plek noemen (map, website, app of tool) en kan versturen, publiceren, betalen, verwijderen
  en iets voor anderen **nooit** vrijgeven; de API weigert zo'n zin met een uitleg.

## Handhaving (`match.ts`, Broker)

`Broker.decide` (de enige permissiepoort, ook voor CLI-bots via `cli-agents/permissions.ts` en de MCP-brug) rekent
eerst het niveau en de keuzes per tool uit, en geeft dat aan `ctx.services.botRules.decide`:

- **Strengste wint**: nooit > eerst vragen > toestaan. Een regel mag elk niveau strenger maken, ook *Volledige toegang*
  met "ook versturen naar anderen".
- **"Mag altijd" alleen binnen het niveau**: alleen een vraag die het niveau *Vraagt toestemming* stelt voor wijzigen of
  uitvoeren (`write`/`exec`) wordt "toestaan". Nooit bij `danger` (versturen, betalen, publiceren, wat niet terug kan),
  nooit tegen een keuze per tool van de eigenaar in, nooit bij *Alleen chat* of *Alleen lezen*. Bij een map moeten alle
  paden van de actie in die map liggen. Harde blokkades (buiten de werkmap, sleutelmappen, blokkeerlijst) blijven.
- Zonder concrete aanroep (welke tools een bot krijgt) tellen alleen regels die niets van de aanroep nodig hebben; een
  regel over een map, website of "anderen" haalt dus geen tool weg.
- Fout in de regels: "toestaan" wordt "vragen" (fail-safe). Een onbekend chatkanaal bij `channel_send` telt voor een
  strenge regel als geraakt.
- De goedkeuringskaart begint met **Jouw regel: “…”**; een weigering zegt de bot "Geweigerd door een regel van je
  eigenaar: “…”" (`ownRule` in `tools/execute.ts`).
- Systeemprompt (stabiel): `## Regels van je eigenaar` met de zinnen, zodat de bot het niet eerst probeert.

Regels gelden per bot (`agent_id`) en per team (`team_id`: alle bots met dat thuisteam, `services.teams.teamOf`).
Een gedeelde bot volgt de regels van zijn eigenaar.

## Opslag en API

`bot_rules`: `id`, `user_id`, `agent_id` of `team_id`, `text` (de woorden van de eigenaar), `effect`, `match` (JSON),
`review`, `created_at`. Hoogstens 50 per bot of team; dubbele zinnen worden geweigerd. In het logboek:
`botrules.added` / `botrules.removed`. Een verwijderde bot neemt zijn regels mee; de volledige export bevat ze.
**Team dupliceren** kopieert de regels van het team en van elke gekopieerde bot (copier `botrules` van de teams-module),
zodat een kopie nooit losser is. Een bot-sjabloon of marktplaatspakket neemt geen regels mee.

| Route | Wat | Telefoon |
|---|---|---|
| `GET /bot-rules?agentId=` / `?teamId=` | regels (bij een bot ook die van zijn team, alleen-lezen) | ja |
| `POST /bot-rules/preview` `{ text }` | wat TeamBot ervan maakt, zonder op te slaan | ja |
| `POST /bot-rules` `{ text, agentId \| teamId }` | strengere regel (`ask`/`deny`); een `allow`-zin geeft 409 `rule_loosens` | ja |
| `DELETE /bot-rules/:id` | een `allow`-regel weghalen (strenger); een strenge geeft 409 | ja |
| `POST /bot-rules/loosen` | een regel die meer toestaat | **alleen computer** |
| `DELETE /bot-rules/loosen/:id` | elke regel weghalen | **alleen computer** |

Een regel losser maken deelt toegang uit: `/bot-rules/loosen…` staat in `COMPUTER_ONLY`
(`server/modules/mobile/policy.ts`) en de route weigert zelf ook een apparaatsessie (403 `mobile_denied`).

## Scherm

`ui/src/modules/botrules/OwnRules.tsx`: in de bot-editor onder **Wat mag de bot?** (*Eigen regels*, met de teamregels
alleen-lezen eronder) en op de teampagina (*Regels voor alle bots van dit team*). Typen toont meteen *Zo legt TeamBot
het vast*: het effect, waar het voor geldt (handeling · app · map · website · anderen) en bij "mag altijd" of het bij
het huidige niveau iets doet. Zonder regels staan er drie voorbeelden om aan te tikken. Op de telefoon staat
*Toevoegen* uit voor een regel die meer toestaat, en zegt een strenge regel "Weghalen doe je op je computer".

Tests: `tests/botrules.test.ts` (zinnen, beslissingen per niveau, echte gate met kaart en weigering, teams, CLI-poort,
Auto Review, telefoon), `tests/mobile.test.ts` (computer-only), e2e `tests/e2e/own-rules.mjs` en een stap in
`tests/e2e/phone-owner.mjs`.
