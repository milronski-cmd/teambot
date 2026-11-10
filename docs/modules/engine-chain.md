# Module: Gratis doorschakelen (`engine-chain`)

Pakket **D2** van TeamBot 0.4. De eigenaar vroeg: *"wat als die gratis modellen out of usage gaan moeten we
automatisch over naar ander gratis model, en belangrijke taken moeten dan worden stop gezet"*. Deze module zorgt dat
elke bot zonder eigen instellingen doorschakelt als zijn model op is, dat **belangrijk werk pauzeert** in plaats van op
een zwakker model door te gaan, dat de laatste 15% van de Claude- en Codex-week voor belangrijk werk blijft, en dat
**privéwerk** alleen naar een lokaal model of een bron die niets bewaart gaat. Elke wissel staat in de chat.

Het wisselen zelf doet de runner (`server/agent/runner.ts`, dezelfde plek als de reserve-engines per bot); deze
module kent de instellingen en de regels en wordt door de runner gevonden als `ctx.services.engineChain`
(feature-detectie: zonder deze module werkt de runner zoals in 0.3). De pure regels staan in `server/agent/fallback.ts`.

## De keten

Volgorde voor één beurt:

1. **Hoofdmodel** van de bot.
2. De **reserves die de eigenaar per bot instelde** (tot 5, zoals in 0.3). Die gaan voor.
3. De **standaardketen**, standaard aan, zonder iets per bot in te vullen:
   1. het **andere abonnement**: Claude Code ↔ Codex, daarna andere abonnement-CLI's, alleen als ze geïnstalleerd zijn,
      ingelogd en op het eigen abonnement (nooit een sleutel die per gebruik betaalt);
   2. **gratis bronnen**: uit de catalogus van pakket D1 (`ctx.services.freeModels`, als die er is), plus de gratis
      CLI-engines die de eigenaar koppelde (OpenCode, Kilo). **Eerst een andere aanbieder** (gratis tegoed telt per
      account, niet per model: van OpenCode-model wisselen helpt niet), daarbinnen **eerst dezelfde modelfamilie**.
      Eén plek per aanbieder;
   3. een **lokaal model** (Ollama eerst, daarna LM Studio enz.; hoogstens twee).

Uitzonderingen, zodat er niets verrast:
- een bot op een **gratis** model blijft gratis: zijn keten gaat naar andere gratis bronnen en het lokale model, niet
  naar het abonnement van de eigenaar;
- een bot op een **lokaal** model blijft op deze computer: alleen andere lokale engines;
- een gedeelde bot van een teamlid (servermodus) krijgt geen standaardketen;
- gratis API-tegoeden (Groq, OpenRouter, Cloudflare …) komen alleen via de catalogus van D1, die weet welke modellen
  echt gratis zijn. Zonder D1 schakelt TeamBot nooit naar iets dat geld kan kosten.

Een limiet geldt voor het hele account (provider): `runner.limited` houdt hem vast tot de reset (met `known` als de
engine zelf de resettijd gaf). De keten wordt pas opgebouwd als hij nodig is (de meeste beurten blijven op het
hoofdmodel), en hoogstens één keer per beurt.

Elke wissel in de chat, als event (`parts.kind = 'fallback'`):
- `De gratis limiet van OpenCode is bereikt. Overgeschakeld naar reserve: Groq (Llama 3.3 70b).`
- `OpenCode (Big Pickle) zit nog tot ongeveer 14:05 aan zijn gebruikslimiet; deze beurt draait op Ollama (lokaal) · qwen3:4b. …`
- `Overgeschakeld naar OpenCode (Big Pickle), omdat Claude Code al 87% van de weeklimiet heeft gebruikt (grens 85%); …`
- `Overgeschakeld naar Ollama (lokaal) · qwen3:4b, omdat dit privéwerk is (Bo staat op privé): …`

## Belangrijk werk

Een run is **belangrijk** als:
- het een run is van een **routine met *Belangrijk*** (`routines.options.important`);
- de bot een **belangrijke taak** op het takenbord **aan het doen is** (`room_tasks.important = 1`, status *Bezig*, de
  bot is eigenaar) in de groep van dat gesprek of in het gesprek waar de taak gemaakt is;
- het een **subtaak** is van een belangrijke run (delegeren erft het);
- de run het zelf zegt (`run.meta.important`, bijvoorbeeld een hervatte pauze). `run.meta.important = false` ("Nu
  doorgaan als gewoon werk") zet het uit.

Een belangrijke run gaat nooit onder het **minimumniveau** (Instellingen › Gratis doorschakelen; standaard *Claude of
Codex*). Niveaus (`EngineTier`): `top` = Claude of Codex (abonnement of betaalde Claude/GPT-engine), `paid` = een
ander abonnement of betaalde engine, `free` = gratis tegoed, `local` = lokaal model. Het hoofdmodel van de bot mag
altijd (dat koos de eigenaar zelf). Is binnen het niveau niets beschikbaar bij een **limiet of storing**, dan:

1. verdwijnt de mislukte poging (zoals bij een wissel);
2. komt er een rustige **pauzekaart** in de chat (event `parts.kind = 'work_paused'`, `parts.pause` met reden,
   `until`, `known`, niveau, titel van taak/routine en `state`): *"Belangrijk werk gepauzeerd (“Kwartaalrapport”):
   Claude Code heeft zijn gebruikslimiet bereikt, en een ander model op het niveau Claude of Codex is er nu niet. Bo
   gaat rond 15:01 vanzelf verder."*;
3. krijgt de eigenaar een **melding** (`notification`, `kind: 'pause'`, `level: 'important'`: ook op de telefoon en
   ook bij bots die op *alleen belangrijk* staan);
4. eindigt de run als **gepauzeerd** (`status: error`, `meta.paused`: geen "liep vast", geen rood gezichtje);
5. gaat het werk **vanzelf verder** op het vroegste moment dat een engine binnen het niveau weer vrij is: de reset die
   de engine gaf (+1 min, hoogstens 8 dagen), anders over 30 minuten (dat staat er dan eerlijk bij). De runner
   beantwoordt hetzelfde bericht opnieuw (`armRetry`, `meta.resumeOf`), ook als het gesprek intussen verder ging, en
   het blijft belangrijk. Een **routine** wacht in de routine zelf (status *Wacht*, `meta.limitWait.important`), wat
   de routine ook kiest bij een limiet; zo draait er nooit iets dubbel. Na 6 pauzes op rij stopt het vanzelf hervatten.

Ziet de runner bij de start al dat alles binnen het niveau op zit, dan pauzeert hij meteen, zonder een engine aan te
roepen. Bij *uitgelogd* of *programma ontbreekt* (daar helpt wachten niet) blijft de gewone foutmelding, met de zin
dat belangrijk werk niet naar het lagere niveau ging. Een bot op *Stoppen* bij een limiet stopt zoals voorheen.

De pauzekaart heeft twee knoppen (niet bij een routine: die beheer je bij Routines): **Nu doorgaan als gewoon werk**
(start nu, zonder minimumniveau) en **Niet hervatten**. Wordt het bericht anders opnieuw beantwoord (*Opnieuw
proberen*, een andere engine kiezen), dan vervalt de geplande hervatting en zegt de kaart dat het verder ging.

## Weekreserve

Boven een instelbare grens (standaard **85%** van de week, `seven_day` van Claude of het weekvenster `…:10080` van
Codex, uit de module *Gebruik en limieten*) gaat **gewoon werk** alvast naar een andere engine uit de keten, zodat de
rest van de week voor belangrijk werk blijft. Belangrijk werk blijft op Claude/Codex. Is er niets anders, dan draait
gewoon werk toch op Claude (beter dan niet). Geldt alleen voor bots die bij een limiet mogen overschakelen. 0 = uit.

## Privéwerk

- Een bot **op privé** (bot-editor › *Privé en doorschakelen*, `settings.private`): elke engine, ook het hoofdmodel,
  moet *blijft op je pc* of *bewaart niets* zijn. Is het hoofdmodel een cloudengine, dan gaat de beurt naar het lokale
  model (gezegd in de chat); is er geen, dan antwoordt de bot dat hij niets verstuurt en wat de eigenaar kan doen.
- Een beurt die een **herinnering met *Gevoelig*** gebruikt, of een dossier met zo'n herinnering (of met de tag
  `gevoelig`/`privé`), volgens `memory_usage` van die beurt: het hoofdmodel blijft (de eigenaar koos het), behalve als
  dat kan trainen; er wordt nooit doorgeschakeld naar een bron die gesprekken bewaart of ermee kan trainen.
- Privacylabels (`Privacy`): `local` blijft op je pc · `none` bewaart niets · `stores` bewaart gesprekken (eigen
  abonnement of betaald account) · `train` kan trainen (gratis tegoed, en elke gratis bron die het niet zegt). Een
  label van de catalogus of `provider.config.privacy` gaat voor.
- Wat privéwerk oversloeg staat in één regel in de chat ("Niet overgeschakeld naar …: dit is privéwerk …"); de
  één-klik-alternatieven tonen dan alleen een lokaal model.

## Catalogus van pakket D1 (koppeling)

Feature-detectie op `ctx.services.freeModels` (de echte dienst van [free-models](free-models.md)):
- `candidates({ userId, needTools, privacy, family, exclude, includeLocal: false, limit: 50 })`, synchroon.
  `privacy` is `'no-store'` bij privéwerk (alleen *bewaart niets*), anders `'any'`; `family` is het model van het
  hoofdmodel (D1 bepaalt zelf de familie); `exclude` zijn het hoofdmodel en de eigen reserves van de bot (hele
  aanbieder eruit); lokale modellen voegt de keten zelf toe (stap 3).
- De keten neemt de **volgorde van D1** over (beschikbaar vóór wachtend, dezelfde familie eerst, *tools werken* eerst,
  voorkeur van de bron) en neemt per aanbieder de eerste kandidaat. Gratis CLI-engines die D1 niet noemt komen erna.
- `privacy.level` → het label van de keten: `local` → *blijft op je pc*, `no-store` → *bewaart niets*, `may-train`
  (of onbekend) → *kan trainen*.
- `available: false` met een `availableAt`: de bron staat wel in de keten, maar de runner slaat hem over tot dat moment
  (`wait`), en voor gepauzeerd belangrijk werk telt die tijd mee als hervattijd (de vroegste binnen het niveau wint;
  `known` als `availableAt` gelijk is aan de reset van de bron). Wachtend zonder bekend einde (kapotte sleutel): niet
  in de keten.
- `report(providerId | { providerId, model }, outcome)` na elke poging op een gratis bron (OpenCode inbegrepen), in de
  woorden van D1: `'ok'`, `{ limit: true, resetAt, message }` bij een limiet die de runner zag, anders `{ error }` met
  de fout zelf (D1 herkent daarin een verdwenen model, een kapotte sleutel, netwerk …). Wat de wikkel van D1 rond de
  gratis API-types net zelf zag, telt D1 niet dubbel.

## Instellingen en API (`/api/engine-chain/...`, ingelogd, eigen gegevens)

| Methode | Pad | Doel |
|---|---|---|
| GET | `/engine-chain/settings` | `{ settings, defaults, levels, privacy, teams }` (`teams`: per team alleen wat daar zelf is ingesteld) |
| PUT | `/engine-chain/settings` | `{ enabled?, minLevel?: top/paid/free/local, weeklyReserve?: 0 of 50–99 }` |
| PUT | `/engine-chain/settings/teams/:teamId` | dezelfde velden voor één team; `null` = weer volgen zoals bij alle teams (pakket B4) |
| DELETE | `/engine-chain/settings/teams/:teamId` | de eigen instellingen van het team weghalen |
| GET | `/engine-chain/preview[?agentId=]` | de keten nu: hoofdmodel + volgorde met soort en privacylabel |
| POST | `/engine-chain/paused/:runId` | `{ action: 'continue' \| 'cancel' }` vanaf de pauzekaart |

Opslag: gebruikersinstelling `engineChain` = `{ enabled, minLevel, weeklyReserve, teams? }`. `teams[<teamId>]` is een
gedeeltelijke overschrijving per team (`resolveChainSettings(raw, teamId)`; alleen de velden die de eigenaar voor dat
team koos). Het team van een beurt (`EngineChainService.teamOf`, pakket B4): het team van de groep waarin het gesprek
zit (`rooms.workspace_id`), anders het thuisteam van de bot. (`rooms.team_id` is een afdeling van het organigram, geen
team; dat werd tot B4 gelezen en matchte dus nooit.) De voorvertoning van een bot gebruikt de instellingen van zijn team.
Per bot: `settings.freeChain = false` (alleen de eigen reserves), `settings.private = true`.

Events: `engine-chain.settings` (na opslaan), het pauze-event in de chat en `notification` (`kind: 'pause'`). Audit:
`engine_chain.settings`, `agent.paused`, `agent.pause_continue`, `agent.pause_cancel`, `agent.weekly_reserve`,
plus het bestaande `agent.fallback`.

## UI

- Instellingen › **Gratis doorschakelen** (één kaart): aan/uit, *Belangrijk werk draait alleen op*, weekreserve, en
  de volgorde van nu met per stap het soort bron en het privacylabel.
- Instellingen › Teams › een team (alleen vanaf twee teams): **Gratis doorschakelen voor dit team**, dezelfde drie keuzes,
  elk ook *zoals bij alle teams* (`ui/src/modules/teams/TeamChain.tsx`). Audit `engine_chain.team_settings`.
- Bot-editor › **Privé en doorschakelen**: *Privé* en *Automatisch doorschakelen als het model op is*.
- Routine-editor › Uitvoering en resultaat: schakelaar **Belangrijk**; badge *Belangrijk* in de routinelijst.
- Takenbord: vlagknop **Belangrijk** per taak en een badge.
- Chat: de **pauzekaart** (`eventRenderers.work_paused`), met de tijd in de taal en tijdzone van de lezer.

## Kernwijzigingen (klein, additief)

- `server/agent/runner.ts` met `agent/engines.ts` en `agent/retries.ts` (alleen de paden voor limiet en reserve): `engineChain` geeft elke engine een niveau en
  privacylabel; `extendChain` voegt de standaardketen toe; `startEngine` (nu async) regelt privéwerk, pauze bij de
  start en de weekreserve; `nextEngine` volgt minimumniveau, privé en weekreserve; `pauseWork`, `resumedPause`,
  `hideAttempt` (de bestaande code voor een mislukte poging, nu herbruikt); `armRetry` hervat gepauzeerd werk ook als
  het gesprek verder ging; `resumeLimitRetries` kijkt 9 dagen terug; `limited` kreeg `known`.
- `server/agent/fallback.ts`: niveaus, families, privacylabels, instellingen per gebruiker/team, volgorde van gratis
  bronnen, weekgebruik, pauzetijd.
- `server/modules/index.ts`, `ui/src/modules/index.ts`: module geregistreerd.
- `server/modules/notifications/index.ts`, `server/modules/mobile/push.ts`: een gepauzeerde run is geen "liep vast".
- `ui/src/lib/store.ts`: een gepauzeerde run telt niet als mislukt voor het gezichtje.
- `ui/src/shell/auditText.ts`: zinnen voor de nieuwe logboekregels (`agent.paused`, `agent.pause_continue`,
  `agent.pause_cancel`, `agent.weekly_reserve`, `engine_chain.settings`).
- Routines: optie `important` (schema, validatie, run-meta, `parkPaused` in `finalize`, `hasBackup` kent de keten,
  sjablonen nemen hem mee). Takenbord: kolom `room_tasks.important` (migratie `rooms-task-important`).

## Tests

`tests/engine-chain.test.ts` (nep-provider als abonnement, gratis en lokale engine; de nep-OpenCode via ACP en een
nep-Ollama): de regels; gesimuleerde limiet op OpenCode → andere gratis aanbieder → Ollama, zichtbaar en zonder
reserves per bot, met vragen en meldingen aan de catalogus; belangrijke taak pauzeert met hervattijd en melding, pauzeert
een tweede bericht meteen zonder aanroep en gaat na de (gesimuleerde) reset zelf verder op Claude; weekreserve
(gewoon werk naar gratis, belangrijk op Claude, grens instelbaar); privébot naar lokaal, nooit naar een bron die kan
trainen, en eerlijk weigeren zonder lokaal model; gevoelige herinnering; belangrijke routine pauzeert in de routine
(ook bij *overslaan*) en een gewone routine schakelt door; de knoppen op de pauzekaart; instellingen, volgorde, uitzetten
per gebruiker en per bot; met de **echte** catalogus van D1 (Groq en Z.ai met een nep-adapter): de volgorde en
beschikbaarheid van D1 bepalen de wissel, en de vroegste `availableAt` is de hervattijd van gepauzeerd belangrijk werk.
`tests/free-path.test.ts` zet de keten uit voor de één-klik-test.

## Beperkingen

- Een limiet die de runner zelf zag, geldt per provider (account): `runner.limited` slaat die aanbieder over tot de
  reset. De catalogus van D1 houdt limieten per model fijner bij (Groq); dat ziet de keten pas bij de volgende beurt.
- Een gepauzeerde **subtaak** (delegeren) meldt "gepauzeerd" terug aan de opdrachtgever en gaat na de reset zelf verder
  in zijn subgesprek, maar dat latere resultaat gaat niet vanzelf terug naar de opdrachtgever (golf 2, pakket C).
- `runner.limited` staat in het geheugen: na een herstart probeert een hervatte run het hoofdmodel eerst opnieuw (en
  pauzeert opnieuw als het nog op is).
- Een dossier als geheel *gevoelig* markeren kan nog niet in de UI; nu telt een dossier met een gevoelige herinnering
  of met de tag `gevoelig`/`privé`.
