# Module: Routines & triggers (`routines`)

Bots voeren zelf taken uit: op een **schema** (eenmalig, interval, vaste dagen/tijden, cron) of bij een **gebeurtenis**
(webhook, RSS/Atom-feed, gewijzigde webpagina, nieuw bestand in de werkmap, e-mail of een chatbericht via de kanalenmodule). Elke run krijgt
een **bonnetje** (status, tijden, duur, tokens, kosten, samenvatting, link naar het gesprek). Dekt plan §21.8 (P0 + P1),
§20 (routines bij Grok/MausBot/Bloks), §26 (always-on alleen als de host wakker is) en §25 checklistpunt 8.

## Eerlijk over uptime

Routines draaien **alleen zolang dit TeamBot-proces draait**: op de desktop zolang de app open is en de pc wakker is,
op een server zolang de service draait. De UI zegt dat op de Routines-pagina, in de editor en bij instellingen, en toont
sinds wanneer TeamBot draait en wanneer de planner laatst actief was. Een geplande run die meer dan 10 minuten te laat is
(pc sliep/stond uit) is **gemist** en volgt het beleid van de routine:

- **Eén keer inhalen bij opstarten** (standaard): één inhaalrun voor de meest recente gemiste keer; het aantal gemiste
  keren staat op het bonnetje en in de opdracht aan de bot.
- **Overslaan**: één bonnetje met status *Gemist* (aantal + sinds wanneer), geen modelaanroep.

**Gemist terwijl je pc uit stond** (`watch.ts`). De planner houdt elke minuut een hartslag bij (instelling
`routines.heartbeat`). Bij het starten is de tijd sinds de laatste hartslag een **periode zonder TeamBot** (pc uit, app
dicht); een sprong tussen twee tikken van meer dan 2 minuten terwijl TeamBot draait is een periode **in slaapstand**.
Elke periode krijgt een id (`routines.downtime`, de laatste 60). De bonnetjes die de planner voor zo'n periode maakt
(inhalen of overslaan) dragen dat id plus het eerste en laatste gemiste tijdstip (`meta.gap`, `missedFrom`, `missedTo`).
Daaruit komt de lijst *Gemist terwijl je pc uit stond*: per periode elke routine met het precieze aantal gemiste runs
(ook na dagen uit), eerste en laatste, en wat er gebeurde (één keer ingehaald, met de uitkomst van die run, of
overgeslagen). Per periode **één melding** (“3 routines: 81 geplande runs gemist sinds ma 9 nov, 06:00 (TeamBot draaide
niet). 2 worden nu ingehaald, 1 overgeslagen.”), niet één per routine. De eigenaar kan de lijst op *Gezien* zetten.

Een cloud-worker die altijd aan staat valt buiten deze module (plan §26: opt-in managed worker).

## Uitvoering (zo werkt een run)

1. De planner (timer, standaard elke ≤ 15 s en precies op het eerstvolgende tijdstip) zoekt routines met `next_run_at <= nu`.
2. **Claim** in één transactie: `INSERT OR IGNORE` in `routine_runs` met een **unieke `run_key`**
   (`<routine>@<geplande tijd>`; triggers: `<routine>@trg:<trigger>:<delivery-id of sha256>`), daarna `next_run_at` vooruit.
   Herstart, dubbele timer, gelijktijdige tick of een opnieuw afgeleverde webhook kan dus nooit een tweede run maken.
3. Per routine draait er één run tegelijk (wachtrij max. 20). Een geplande run terwijl de vorige nog loopt → *Overgeslagen*.
4. Limieten worden gecontroleerd (per routine en globaal, per kalenderdag in de tijdzone): max. runs en max. geschatte
   kosten. Bereikt → bonnetje *Limiet bereikt* + één melding per dag.
5. De opdracht gaat als bericht in het **eigen routinegesprek** (thread `kind: 'routine'`, één per routine) en start de bot
   via `ctx.chat.startAgent` met `run.meta.override` (zie kernwijzigingen). Elke run begint met een **schone context**
   (`thread.meta.contextFromSeq`, nieuwe CLI-sessie); optioneel wordt de **uitkomst van de vorige run** begrensd (200–4000
   tekens) meegestuurd.
6. `ctx.runs.waitFor` → bonnetje. Uitkomsten:
   - Klaar **met bewijs** → *Geslaagd* + melding (`notification`, link naar `#/t/<thread>`), tenzij de routine “alleen
     fouten”/“nooit” meldt. Klaar **zonder resultaat** → *Zonder resultaat* + een belangrijke melding (ook bij “alleen
     fouten”), zie *Bewijs bij elke klaar*.
   - **Stil pad**: de bot roept `routine_no_update` aan of antwoordt met `ROUTINE_NO_UPDATE` → status *Niets nieuws*,
     **geen melding**, wel in de historie. Standaard verdwijnt die uitwisseling uit het gesprek (soft-delete, instelbaar).
   - Fout door providerstoring/429/5xx/netwerk → **nieuwe poging** met backoff (1, 4, 16 … min, max. 60, ±10 %), zelfde
     opdrachtbericht (geen dubbele prompt). Annuleren kan tijdens wachten of lopen. **Bij de eerste fout al een melding**
     (“Routine X mislukt … Nieuwe poging 2 van 3 om 08:01”), niet pas na de laatste poging.
   - 401/402/403, ongeldige sleutel, tegoed/abonnement op, geen provider → routine **pauzeert zichzelf direct** + melding.
   - Andere fouten → na *N* fouten op rij (standaard 3) automatische pauze + melding.
   - Kon de bot niet eens starten (bot verwijderd, interne fout) → *Mislukt* + melding; nooit stil.
   - Herstart tijdens een run → *Onderbroken* (nooit automatisch herhaald i.v.m. bijwerkingen; “Hervatten” in het gesprek).
   - Time-out per run (standaard 30 min, ook als hij op goedkeuring wacht) → geannuleerd.
   - **Belangrijk** (`options.important`): de run draait nooit onder het minimumniveau van Instellingen › Gratis
     doorschakelen (standaard Claude of Codex; zie [engine-chain](engine-chain.md)). Pauzeert de runner hem omdat
     daarbinnen niets beschikbaar is, dan wacht de routine tot de hervattijd van de runner (status *Wacht*,
     `meta.limitWait.important`, hoogstens 6× op rij), wat de routine ook kiest bij een limiet, en gaat dan vanzelf
     verder. De melding komt van de runner (één, ook op de telefoon).
   - **Alles stoppen** (`POST /api/stop-all`): lopende runs stoppen via hun taak; runs die in de wachtrij of op een
     nieuwe poging wachten worden ook geannuleerd (“Alles gestopt”), zodat er niets een paar minuten later opnieuw
     begint. De schema's zelf lopen door (daarvoor is de noodrem).
7. **Goedkeuringen en vragen** gaan via de bestaande Broker naar `thread.user_id` = eigenaar van de routine, met link naar
   het routinegesprek (gecontroleerd + getest). Een routine kan de toegangsmodus/tools van de bot alleen **beperken**.

## Controle vooraf (`preflight.ts`, 0.4.4 P2)

Vlak voor de eerste poging van een run (nog geen bericht geplaatst) kijkt `preflight(ctx, routine, bot)` of de
koppelingen die de run nodig heeft nog werken, alleen uit TeamBots eigen gegevens (er wordt niets aangeroepen):
- het kanaal van `options.deliver`: bestaat nog, staat aan, niet in fout of `send_failed` (`channels/health.ts`);
- de apps (MCP) van de bot, tenzij `override.tool_groups` de groep `mcp` uitsluit: `status = auth_required`, OAuth
  `expired`, of een token voorbij `expires_at` zonder refresh-token (`mcp/oauth.ts`).
Kluis-logins hebben geen vervaldatum en worden niet gecontroleerd. Is er iets mis, dan start de bot niet: de run krijgt
`error` met *Kon niet: koppeling verlopen. …*, `summary` *Kon niet: koppeling verlopen* en `meta.preflight = { at,
blockers: [{ kind: 'channel'|'app', id, name, text, link }] }` (het bonnetje toont ze met **Repareren**), en de eigenaar
krijgt één melding met `ref: preflight:<routine>:<ids>` (herhalingen worden één regel met een teller). Geen
modelaanroep, dus geen kosten. De hoofdbot meldt de mislukte run daarna één keer (`teams/stuck.ts`).

## Bewijs bij elke klaar (`proof.ts`)

Een run die zonder fout eindigt, telt pas als **geslaagd** met een resultaat dat TeamBot zelf zag. Er wordt niets aan
het model gevraagd; het bewijs komt uit:

- de auditregels van deze bot tijdens de run (vanaf het echte begin van de run): een geschreven, bewerkt of naar de
  prullenbak verplaatst bestand (`file.*`, ook `cli.fs_write` en goedgekeurde schrijfacties van een CLI), een verstuurd
  bericht (`channel_send`, `notify_user`, publiceren, mailtools), een taak op het takenbord (`task_create`) of een
  andere geslaagde actie met effect (risico *write* of *danger*, zoals een pagina in een gekoppelde app of een
  verstuurd formulier). Lezen, zoeken, geheugen, delegeren en opdrachten in de terminal tellen niet;
- de schrijfbare mappen van de bot: bestanden die tijdens de run veranderden (begrensd; ook als een CLI-engine zelf
  schreef zonder het TeamBot te melden);
- het antwoord: een inhoudelijk antwoord (een herinnering, samenvatting, uitkomst) is het resultaat van zo'n routine.
  Een kaal “Klaar.”, “Gedaan ✅”, “OK” of een leeg antwoord is dat niet.

Uitkomst in `meta.proof`: `proven` (met de lijst), `answer` of `none` (met een zin waarom). Zegt het antwoord dat er iets
gedaan is (“ik heb het rapport opgeslagen als rapport.md”, “bericht verstuurd”) terwijl TeamBot dat niet zag, dan staat
dat als `claims` op het bonnetje en is een run zonder ander bewijs *zonder resultaat*. De status in de database blijft
`done` (de motor faalde niet); de routine krijgt `last_status = 'no_result'`, een keten met “alleen na een echt
resultaat” start dan niet, de historie filtert op *Geslaagd* of *Zonder resultaat* en het overzicht telt ze apart.

## Wat níet gebeurde (watchdog, `watch.ts`)

Eens per minuut vergelijkt de planner elk actief schema met wat er echt gebeurde (sinds TeamBot startte of de routine
werd gewijzigd). Een geplande keer die **meer dan 5 minuten** voorbij is zonder enig bonnetje (geen run, geen
overgeslagen, geen gemist- of inhaalbonnetje dat die tijd dekt) krijgt een bonnetje *Niet gedraaid* (“Verwacht om 08:00
(ma 9 nov), niet gedraaid. De planner sloeg deze run over.” of “… bleef op deze run hangen.”) en een melding. De
watchdog start de run zelf nooit (dat kan bijwerkingen herhalen); komt de run alsnog, dan zegt het bonnetje “Later toch
gestart”. Gepauzeerde routines, de noodrem en wachtpunten doen niet mee. `GET /routines/attention` bundelt de runs van
de laatste dagen die niets opleverden (niet gedraaid, gemist, mislukt, zonder resultaat, limiet, overgeslagen,
onderbroken) voor de kaart *Wat niet gebeurde*.

## Per team (0.4, pakket B4)

Een routine hoort bij het **team van zijn bot** (geen eigen veld: verhuist de bot, dan gaat de routine mee) en werkt
alleen binnen dat team. Met één team verandert er niets.

- **Bezorgen** (*Resultaat ook sturen naar*): alleen een kanaal van dat team; anders 400 bij het opslaan ("Kanaal … hoort
  bij team …, en deze routine van … bij team …"), en tijdens het draaien weigert de kanalenmodule nog eens
  (`deliver` met `agentId`; het bonnetje zegt waarom). De editor biedt alleen kanalen van het team van de bot
  (`GET /routines/channel-targets?agentId=`).
- **Triggers**: een chattrigger of e-mailtrigger op een kanaal of mailbox van een ander team wordt geweigerd; een
  trigger op *alle chatkanalen* of *elke mailbox* reageert alleen op die van zijn eigen team (`teamId` in de events van
  de kanalenmodule).
- **Daarna starten**: alleen een routine van hetzelfde team (bij het instellen en bij het starten gecontroleerd).
- **Wat een bot ziet**: `routine_list` toont de routines van zijn eigen team en, met *(alleen meekijken)* erbij, die van
  teams waar hij mag meekijken of die hij aanstuurt; zonder toegang niets. Een bot kan geen routine van een ander team
  maken of wijzigen (`routine_create` is altijd voor de bot zelf).
- **De eigenaar** ziet alles; `?teamId=` op `GET /routines`, `/routines/runs`, `/routines/runs/summary`,
  `/routines/attention`, `/routines/missed` en `/routines/calendar` toont één team. Elke routine heeft `teamId` en
  `teamName`. De pagina Routines (overzicht, *Wat niet gebeurde*, *Gemist terwijl je pc uit stond*, laatste 24 uur)
  volgt vanaf twee teams de teamkiezer.

## Schema's en tijdzones

| Soort | Opslag | Gedrag |
|---|---|---|
| Eenmalig | `{kind:'once', at:'JJJJ-MM-DDTUU:MM'}` (lokale tijd) | Daarna status *Afgerond*. Niet-bestaande tijd (zomertijdgat) schuift vooruit (02:30 → 03:30); dubbele tijd (wintertijd) = eerste keer. |
| Interval | `{kind:'interval', everyMinutes, anchor}` | Absolute tijd vanaf het anker, ongevoelig voor zomertijd. |
| Vaste dagen/tijden | `{kind:'weekly', days:[0-6], times:['UU:MM']}` | Via croner per tijd, in de tijdzone. |
| Cron | `{kind:'cron', expr}` (5 velden, ook `@daily` e.d.) | croner, `mode: '5-part'`. 02:30 op de zomertijddag draait één keer (03:00), op de wintertijddag één keer. |
| Geen | `{kind:'none'}` | Alleen “Nu testen” of triggers. |

Tijdzone per routine (IANA), standaard de gebruikersinstelling `timezone`, anders systeem, anders `Europe/Amsterdam`.
Mensvriendelijke weergave (NL) en de eerstvolgende 5 runs via `POST /api/routines/preview`.

## Triggers

Alle triggers: eigen filters, **dedupe** (uniek per trigger in `routine_events`), eigen gebeurtenissenhistorie, aan/uit.
Inkomende data gaat **als geciteerde, onbetrouwbare data** naar de bot: een blok `<extern_data bron=… code=<random>>`
met een waarschuwing vooraf; tag-lookalikes in de data worden onschadelijk gemaakt (`‹/extern_data›`), de opdracht staat
altijd vóór de data. Filters: veldfilters met JSONPath-achtige paden (`a.b`, `items[0].x`, `labels[*].name`, `$event`,
`$header.<naam>`), operatoren eq/neq/contains/not_contains/starts_with/in/exists/not_exists/gt/lt, plus trefwoorden
(moet één bevatten / mag geen bevatten). Bewust **geen regex** (webhook-payloads zijn vijandig → ReDoS).

### Webhook — `POST /api/public/hooks/<trg_…>` (raw body, JSON-parser staat daar uit)

| Preset | Controle | Replay | Delivery-id (dedupe) |
|---|---|---|---|
| Geheim token | `Authorization: Bearer` of `X-TeamBot-Token` (of `?token=`) | dedupe | `X-TeamBot-Delivery`/`Idempotency-Key`/`X-Request-Id`, anders sha256(body) |
| HMAC (TeamBot) | `X-TeamBot-Signature: sha256=HMAC(geheim, "<ts>.<body>")` | `X-TeamBot-Timestamp` ±5 min | idem |
| GitHub | `X-Hub-Signature-256` | dedupe | `X-GitHub-Delivery`; `ping` wordt beantwoord zonder run |
| Slack | `X-Slack-Signature` v0 over `v0:<ts>:<body>` | `X-Slack-Request-Timestamp` ±5 min | `event_id`; `url_verification` → challenge |
| Linear | `Linear-Signature` (hex HMAC) | `webhookTimestamp` ±5 min | `Linear-Delivery` |
| Sentry | `Sentry-Hook-Signature` (hex HMAC) | `Sentry-Hook-Timestamp` ±5 min | `Request-ID` |
| Stripe-stijl | `Stripe-Signature: t=…,v1=…` over `<t>.<body>` | `t` ±5 min | event-`id` |
| Standard Webhooks | `webhook-signature: v1,<base64 HMAC-SHA256>` over `<webhook-id>.<webhook-timestamp>.<body>` (sleutel = base64 na `whsec_`, of het hele geheim als tekst); ook `v1a,` (ed25519) met een publieke sleutel `whpk_…`; 1–10 handtekeningen, één moet kloppen; ook de `svix-`-namen | `webhook-timestamp` ±5 min | `webhook-id`; type uit `type` in de body |

Verder: groottelimiet per trigger (standaard 256 kB, max 1 MB; `Content-Length` vooraf gecontroleerd), rate limit per
trigger (standaard 30/min, token bucket), constant-time vergelijking, onbekende/uitgeschakelde id → 404, foute handtekening
→ 401 (reden alleen in de eigen historie). Antwoord 202 direct; de run loopt asynchroon.
**Geheimen** staan alleen in `ctx.secrets` (`routine-trigger:<id>`). TeamBot genereert ze voor token/HMAC/GitHub en toont
ze **één keer** (bij aanmaken/roteren); voor Slack/Linear/Sentry/Stripe/Standard Webhooks plakt de gebruiker het geheim van de dienst.
Standard Webhooks (Svix, Clerk, Resend …) is een eigen implementatie van de open specificatie met `node:crypto`, getoetst aan
het voorbeeld uit de specificatie (`tests/standard-webhooks.test.ts`) en eenmalig aan de referentiebibliotheek
`standardwebhooks` 1.1.1 (geen afhankelijkheid: die trekt `fast-sha256` (Unlicense) mee voor iets dat `node:crypto` al kan).
Een geheime sleutel van de afzender (`whsk_…`) wordt geweigerd; met een publieke sleutel kan *Testpayload sturen* niet.
**Roteren** met overgangstijd (0/15/60/1440 min): het vorige geheim blijft zo lang geldig (`…:prev`) en wordt daarna gewist.
**Testpayload sturen** ondertekent een body met het opgeslagen geheim en stuurt die door exact dezelfde controle.
In desktopmodus waarschuwt de UI dat `127.0.0.1` niet bereikbaar is voor GitHub/Slack (`TEAMBOT_PUBLIC_URL` of server nodig).

### RSS/Atom-feed, webpagina, map, e-mail

- **Feed**: pollt (min. 5 min, standaard 15), ETag/Last-Modified, eigen tolerante RSS 2.0/Atom-parser. Eerste controle
  legt een **startpunt** vast (bestaande items worden niet gemeld). Nieuwe items (gefilterd per item) → één run per batch
  (max. 10, instelbaar).
- **Webpagina**: leesbare tekst (turndown), sha256-hash; bij wijziging een regeldiff (toegevoegd/verwijderd) als data.
- **SSRF**: `assertPublicUrl` bij aanmaken én bij elke redirect-hop (handmatige redirects, max. 5), 3 MB limiet, time-out.
  Privé-adressen alleen als de bot `settings.allowPrivateNetwork` heeft (zelfde regel als `web_fetch`).
- **Map**: alleen binnen de werkmap van de bot (`resolveInWorkspace` bij aanmaken én elke controle), symlinks worden niet
  gevolgd, patroon (`*.pdf, *.csv`), nieuw/gewijzigd/verwijderd, bestanden < 3 s oud worden pas de volgende keer gemeld
  (nog aan het schrijven). **Lusbeveiliging**: tijdens een run van de routine zelf wordt niet gemeld en daarna opnieuw een
  startpunt gezet, zodat eigen uitvoer geen nieuwe run start.
- **E-mail**: alleen als `ctx.services.channels.onEmail(handler)` bestaat (aangeroepen in `start()`); anders is het type
  uitgeschakeld in de UI en weigert de API het netjes. Verwacht contract: `onEmail((mail) => void) => unsubscribe?` met
  `mail = { userId, accountId?, messageId?, from, to, subject, date, text }`. Mails zonder `userId` worden genegeerd.

### Chatbericht (WhatsApp, Telegram, Discord, Slack, webhook-kanaal)

Alleen als `ctx.services.channels.onChatMessage(handler)` bestaat (in `start()`; `meta.chatAvailable`). Config
(`ChatTriggerConfig`): `bindingId` (leeg = alle chatkanalen, nooit e-mail), `senders` (`allowlist` standaard, `owner` =
geverifieerde eigenaar in een privégesprek, `anyone` = ook onbekende afzenders — alleen expliciet), `match`
(`contains`/`starts_with`/`regex`/`any`, hoofdletterongevoelig) + `text`, `botReplies` (uit = de bot antwoordt niet op dat
bericht; het staat wel in de thread met een event) en `ratePerMinute` (1–60, standaard 5; daarboven event *Limiet*).
- **Dedupe** op `msg:<binding>:<platform-berichtid>` (bovenop de dedupe van de kanalenmodule): een replay of
  herlevering start nooit een tweede run.
- **Regex met veilige grenzen**: max. 200 tekens, geldige syntax, geen terugverwijzingen, geen herhaalde groep met zelf
  een herhaling of keuze (`(a+)+`, `(a|aa)*`); bij uitvoeren alleen de eerste 2000 tekens en een tijdslimiet van 25 ms
  (`vm`), daarna telt het als geen match + event *Fout*. Filters op JSON-velden gelden niet voor deze soort.
- Niet-passende berichten laten geen spoor na in de historie. Het bericht gaat als `<extern_data>` naar de bot; vóór het
  blok staat alleen TeamBots eigen oordeel (eigenaar / allowlist / onbekend), de naam en tekst staan in het blok.
- Bonnetje: `trigger: 'chat'`, `meta.startedBy = { name, channel, binding, status }` → “Gestart door bericht van Jan via
  Telegram”. `POST /routines/chat-match { match, text, sample }` probeert een zin met dezelfde regels (UI: “Probeer een
  bericht”).

## API (`/api/routines…`, ingelogd; alles alleen voor de eigen gebruiker)

| Methode + pad | Doel |
|---|---|
| `GET /routines/meta` | modus, uptime (startedAt/lastTickAt), tijdzones, webhook-basis-URL + bereikbaarheid, presets, standaarden, globale limieten, `emailAvailable`/`chatAvailable` |
| `POST /routines/chat-match` | chatbericht-trigger uitproberen (`{ ok, matches }` of `{ ok: false, error }`) |
| `GET/PUT /routines/settings` | globale limieten + noodrem (`paused`, `maxRunsPerDay`, `maxCostPerDayUsd`) |
| `POST /routines/preview` | schema valideren → tekst, volgende 5 runs, runs/dag |
| `GET /routines?agentId=&teamId=` · `POST /routines` | lijst (per bot of per team) / aanmaken |
| `GET/PATCH/DELETE /routines/:id` (`?deleteThread=1`) | detail (incl. triggers) / bewerken / verwijderen |
| `POST /routines/:id/{pause,resume,confirm,duplicate,run}` | pauzeren, hervatten, concept bevestigen, dupliceren (gepauzeerd, zonder webhooks), Nu testen |
| `POST /routines/:id/run-after` `{ at }` | *Start na de reset om …* (0.4.4, P3, uit de kostenschatting): één run zoals *Nu uitvoeren* die tot `at` wacht (status `retrying`, `meta.startAfter`; overleeft een herstart, te annuleren als elke wachtende run). Hooguit 8 dagen vooruit, één tegelijk per routine (409). Voor een taak maakt `engine.createOnceAt()` een eenmalige routine |
| `GET /routines/:id/runs?status=&before=` · `GET /routines/runs` · `GET /routines/runs/:id` · `POST /routines/runs/:id/cancel` | bonnetjes (`status=done` = geslaagd, `status=no_result` = zonder resultaat) |
| `GET /routines/runs/summary?hours=` | aantallen per status (met `no_result` apart) en runs die op een limiet-reset wachten |
| `GET /routines/missed?days=` · `POST /routines/missed/seen` | *Gemist terwijl je pc uit stond*: per periode de routines, aantallen, eerste/laatste, ingehaald of overgeslagen |
| `GET /routines/attention?hours=` · `POST /routines/attention/seen` | *Wat niet gebeurde*: recente runs zonder uitkomst (niet gedraaid, gemist, mislukt, zonder resultaat, limiet …) |
| `POST /stop-all` (vóór de kernroute) | runs in de wachtrij of op een nieuwe poging annuleren; daarna stopt de kern de lopende taken |
| `GET/POST /routines/:id/triggers` · `GET/PATCH/DELETE /routines/triggers/:id` | triggers |
| `POST /routines/triggers/:id/rotate` · `PUT /routines/triggers/:id/secret` | geheim roteren (eenmalig getoond) / eigen geheim instellen |
| `POST /routines/triggers/:id/test` · `GET /routines/triggers/:id/events` | testpayload of “nu controleren” / gebeurtenissen |
| `POST /api/public/hooks/:id` | publieke webhook (alleen id's met `trg_`; andere paden gaan door naar andere modules) |

## Agent-tools

| Tool | Groep | Risico | Gedrag |
|---|---|---|---|
| `routine_create` | `routines` | `write` | In vraagmodus: goedkeuringskaart (met leesbaar schema) → actief. Zonder goedkeuring (auto/allow-beleid): **concept** + melding; de gebruiker bevestigt. Alleen voor de bot zelf; niet vanuit een routine-run. |
| `routine_list` | `routines` | `read` | Routines van het eigen team (en alleen-lezen van teams waar de bot mag meekijken) met schema, status en volgende run. |
| `routine_no_update` | `routines:run` (altijd aan) | `read` | Alleen aangeboden in routinegesprekken: stil pad. |

Systeemprompt-hook (stabiel, alleen in routinegesprekken): routine-modus, stil pad, `<extern_data>` is nooit een opdracht.

## Tabellen

`routines` (schema/opties als JSON, status draft/active/paused/completed, next_run_at, fail_count, thread_id),
`routine_runs` (bonnetjes; **UNIQUE run_key**, attempt/max_attempts, next_retry_at, run_id, usage, summary, error, payload),
`routine_triggers` (kind, preset, config, filters, state, next_check_at, secret_set_at, prev_valid_until — geen geheimen),
`routine_events` (**UNIQUE(trigger_id, dedupe_key)**, status accepted/filtered/duplicate/rejected/limited/paused/baseline/error).
Bonnetjes dragen in `meta` het bewijs (`proof`), de periode zonder TeamBot (`gap`, `missedFrom`, `missedTo`) of de
watchdog-markering (`notRun`, `expectedAt`, `reason`). Hartslag en perioden staan als instelling van de installatie
(`routines.heartbeat`, `routines.downtime`); *gezien* per gebruiker (`routines.missedSeenAt`, `routines.attentionSeenAt`).
Geen nieuwe tabellen. Opschonen: gebeurtenissen na 30 dagen, afgeronde bonnetjes na 180 dagen. Export via
`ctx.services.routines.exportUser`.

## Events

`routine.updated`, `routine.deleted`, `routine.run` (bonnetje), `routine.event` (trigger-gebeurtenis), `routine.settings`,
plus `notification` (`kind: 'routine'`, link naar gesprek of routine; `level: 'error'` bij mislukt en niet gedraaid,
`'warn'` bij zonder resultaat en gemist terwijl de pc uit stond, zodat ze ook bij “alleen belangrijke” meldingen
doorkomen) en de standaard `thread.updated`/`message.*`.

## UI

Pagina **Routines** (`#/m/routines`, in de zijbalk): uptime-uitleg, de kaart **Wat niet gebeurde** (laatste 3 dagen,
*Gezien*), de kaart **Gemist terwijl je pc uit stond** (per periode, open via de link in de melding,
`#/m/routines?gemist=1`), de telling van de laatste 24 uur (*Geslaagd* en *Zonder resultaat* apart), noodrem-banner,
kaarten met status, schema, volgende run, laatste resultaat, Nu testen/Pauzeren/Hervatten/Bevestigen. Detail
`#/m/routines/r/<id>` met tabs **Historie** (bonnetjes met een regel *Bewijs: …* of waarom er geen resultaat is,
filter, annuleren, bonnetje-modal met het resultaat, de bestanden die de run veranderde met **Alles terugzetten**
(prullenbak van de mappenmodule) en ontvangen data), **Triggers** (URL + kopiëren, geheim eenmalig tonen,
roteren met overgangstijd, eigen geheim, testpayload, nu controleren, filters, gebeurtenissen) en **Instellingen**
(editor met schemakiezer, live voorbeeld + waarschuwing als het schema de daglimiet overschrijdt, tijdzone,
gemiste-run-beleid, meldingen, vorige-run-context, limieten, provider/model, toegangsmodus ≤ bot, toolgroepen, max. stappen).
`#/m/routines/r/new?agent=<id>` maakt een nieuwe. Verder: bot-editorsectie (routines van die bot + schakelaar “mag
routines voorstellen”), instellingentab **Routines** (globale limieten), toolkaart voor `routine_create`, en een link
“Routine-run · bonnetje” onder het opdrachtbericht. Getest op 360 px en in licht/donker (headless Edge, geen overflow).

## Kernwijzigingen (klein, additief)

- `server/agent/runner.ts`: `applyRunOverride(agent, run.meta.override)` — per run andere provider/model, en alleen
  **beperken**: toegangsmodus (alleen strenger), toolgroepen (doorsnede), max. stappen (≤), extra `deny`-tools. Zonder
  `override` verandert er niets.
- `server/agent/history.ts`: `thread.meta.contextFromSeq` — berichten vóór dat volgnummer tellen niet mee in de
  modelgeschiedenis (schone context per routine-run, voorkomt groeiende kosten). Zonder die sleutel verandert er niets.

## Ontwerpkeuzes (mini-ADR's)

1. **Idempotentie in de database, niet in het geheugen**: unieke `run_key` + `INSERT OR IGNORE` in dezelfde transactie als
   het vooruitzetten van `next_run_at`. Ook triggers krijgen een run_key per delivery; dubbele levering kan geen dubbele
   bijwerking veroorzaken.
2. **Eén gesprek per routine, schone context per run** (kernwijziging 2) i.p.v. een nieuw gesprek per run: geen vervuilde
   zijbalk, wel geïsoleerde en voorspelbare kosten.
3. **Retries hergebruiken het opdrachtbericht**; onderbroken runs worden nooit automatisch herhaald.
4. **Geheim één keer tonen** (zoals persoonlijke tokens): daarna alleen “ingesteld op …”; roteren met overgangstijd.
5. **Geen regex in filters** (ReDoS op vijandige payloads); veldfilters + trefwoorden zijn genoeg voor smalle filters.
   Uitzondering: de tekst van een chatbericht-trigger mag een patroon zijn (eigenaar kiest het; vorm-check + 2000 tekens
   + 25 ms-tijdslimiet in `vm`), omdat “begint met/bevat” voor chatcommando's soms te grof is.
6. **Bot-voorstellen zonder goedkeuring worden concept**: een bot in automatische modus kan zichzelf niet ongemerkt
   onbewaakt laten draaien.
7. **Gemist = > 10 min te laat**: korte vertraging (slaapstand van een paar minuten) telt als gewone run.
8. Geen nieuwe dependencies (croner was al aanwezig; feed-parser en diff zijn eigen code).
9. **Bewijs uit wat TeamBot zelf zag**, niet uit een tweede modelvraag: de auditlog van de bot en de gewijzigde
   bestanden zijn controleerbaar en kosten niets. Een kale “klaar” is geen resultaat; een inhoudelijk antwoord wel (de
   meeste herinner- en samenvatroutines leveren alleen een antwoord). De status blijft `done` zodat de motor-uitkomst en
   de bewijs-uitkomst gescheiden blijven.
10. **De watchdog meldt, maar start niets**: een run die niet startte alsnog uitvoeren kan bijwerkingen herhalen; de
    eigenaar ziet het binnen 5 minuten en kiest zelf (Nu testen).
11. **Eén melding per periode zonder TeamBot**, niet per routine: na een week uit geen muur van meldingen, wel een
    volledige lijst.

## Beperkingen en handmatige voorwaarden

- Webhooks van GitHub/Slack/Linear/Sentry/Stripe bereiken een desktop op `127.0.0.1` niet: draai TeamBot als server
  met een publiek adres (`TEAMBOT_PUBLIC_URL`) of gebruik zelf een tunnel. De module beheert geen tunnel.
- E-mailtriggers verschijnen pas als de kanalenmodule `ctx.services.channels.onEmail` aanbiedt (contract hierboven).
- Kostenlimieten gebruiken de geschatte kosten uit de kern (`estimateCost`); bij modellen zonder prijsinfo zijn die 0 en
  geldt alleen de runlimiet. Limieten worden vóór een run gecontroleerd (een lopende run wordt niet halverwege gestopt).
- Pagina-watcher vergelijkt leesbare tekst; pagina's die volledig via JavaScript renderen ziet hij niet (gebruik dan de
  browsermodule in de opdracht).
- Mapwijzigingen terwijl de routine zelf draait worden bewust niet gemeld (lusbeveiliging).
- Bewijs is een vaststelling, geen keuring: een bestand dat een bot schreef kan nog steeds onzin bevatten, en een
  bestand dat iemand anders tijdens de run in de map zette telt mee. Herkennen van “ik heb … opgeslagen” in het antwoord
  is een vaste lijst Nederlandse en Engelse zinsdelen. Lopen twee runs van dezelfde bot tegelijk (in verschillende
  gesprekken), dan kan de actie van de ene als bewijs bij de andere tellen.
- Onderscheid pc uit / app dicht kan TeamBot niet maken (beide: geen hartslag); de melding zegt daarom “TeamBot draaide
  niet”. Een sprong in de tijd van de klok zelf ziet eruit als slaapstand.
- Tests: `tests/routine-proof.test.ts` (kale klaar → zonder resultaat met melding, een bestand/bericht/taak of een
  bestand dat een CLI zelf schreef is bewijs, een bewering zonder bewijs, mislukte routine meldt bij de eerste fout
  binnen 5 minuten, watchdog “verwacht om 08:00, niet gedraaid” één keer, stil bij pauze en bij gemiste runs, Alles
  stoppen annuleert wachtende pogingen), `tests/routine-missed.test.ts` (echte herstart na 3 dagen uit: één periode,
  exacte aantallen per routine, ingehaald of overgeslagen, één melding; slaapstand tussen twee tikken).
  `node --import tsx --test tests/routines.test.ts` (25 tests: DST maart/oktober, idempotentie bij gelijktijdige
  tick en echte herstart, gemiste-run-beleid, retry/annuleren, auto-pauze, dag-/kosten-/globale limiet, stil pad, schone
  context, override, routine_create-goedkeuring/concept, webhooks per preset incl. replay/dedupe/rotatie/limieten,
  payload-citaat, feed/map-watchers, SSRF/werkmap, isolatie tussen gebruikers).
  `tests/routines-chat-trigger.test.ts` (via het echte webhook-kanaal): match → één run met de tekst als data, geen
  match → niets, replay/herlevering → geen tweede run, onbekende afzender → niets (alleen met “Ook onbekende
  afzenders”), alleen-eigenaar, rate limit, bot antwoordt wel/niet, onveilige regex geweigerd, tijdslimiet.
  Per team: `tests/teams-isolation.test.ts` (`routine_list`, een chattrigger op elk kanaal, bezorgen via en *Daarna
  starten* naar een ander team, de teamfilters van de eigenaar).
- Een e-mailtrigger voor één mailbox vergelijkt nu ook met `bindingId` van het e-mailevent (de kanalenmodule geeft
  geen `accountId` mee); daarvoor reageerde zo'n trigger op geen enkele mail.
