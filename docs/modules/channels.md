# Module: Kanalen (`channels`)

Bereik je bots (of een groep) via **Telegram** (de makkelijke en veilige standaard), **WhatsApp Business (officiële
Cloud API)**, **e-mail**, **Discord**, **Slack**, een **generieke webhook** en, voor jezelf en achter een duidelijke
waarschuwing, **WhatsApp via een QR-code** (je eigen nummer, onofficieel). Elk extern gesprek wordt een eigen thread
(`kind: 'channel'`) die je live meeleest in TeamBot; het antwoord van de bot gaat automatisch terug naar **hetzelfde**
gesprek. Plan: §20 A, §21.8, §21.10, §5 en pakket **K** van `docs/PLAN_0.4.md`.

Nieuw in 0.4 (pakket K):
- **Gezondheid zonder valse groene vink**: *Verbonden* pas als TeamBot met deze instellingen echt een bericht heeft
  ontvangen **én** verstuurd. Daarvoor *Verbonden, nog niet getest* met een volgende stap; lukt ontvangen of
  versturen niet, dan staat er precies waarom. Op de kaart: laatst ontvangen, laatst verstuurd, laatste fout en de
  afgelopen 24 uur.
- **Klantenservice** per kanaal voor bots die met mensen buiten het team praten: AI-label, doorzetten naar de
  eigenaar, nooit beleid verzinnen (alleen uit goedgekeurde kennis), en alles over geld, prijzen, terugbetalen,
  kortingen en beloftes eerst in *Wacht op jou*. Afgedwongen in de code op het concept van de bot, niet alleen in
  zijn instructies. Elk bericht aan klanten staat met de volledige tekst in het logboek.
- **Telegram eerst** in *Kanaal toevoegen*, gemarkeerd als makkelijkst en veiligst; eigen Telegram koppelen met één
  tik (of een QR-code voor de telefoon). **WhatsApp via QR** als laatste, met een eerlijke waarschuwing die de eigenaar
  moet bevestigen vóór er iets verbindt (de server weigert een nieuwe QR-koppeling zonder die bevestiging).
- **Per team** (pakket B4): elk kanaal hoort bij het team van zijn bot of groep; alleen bots van dat team antwoorden
  erop en versturen erdoor (zie *Per team* hieronder).

## Wat het doet

| Onderdeel | Wat werkt |
| --- | --- |
| Bereikbaarheid | Telegram (long polling of webhook), WhatsApp Cloud API (webhook), e-mail (IMAP IDLE/polling + SMTP), Discord (DM's + @vermeldingen), Slack (Socket Mode of Events API), generieke webhook in/uit, WhatsApp als gekoppeld apparaat (QR-code of koppelcode). Eén thread per extern gesprek, live meelezen, typindicator, bijlagen in/uit (spraakberichten uitgeschreven als er spraakherkenning is), lange antwoorden gesplitst, opmaak per platform veilig omgezet. |
| Gezondheid | Bewijs per richting (ontvangen / versturen) sinds de laatste wijziging van de verbindingsinstellingen; test met een code; exacte reden bij falen; geschiedenis op de kaart. |
| Klantenservice | AI-label, doorzetten (ook als de klant om een mens vraagt), alleen goedgekeurde kennis, goedkeuring bij geld en beloftes met aanpassen, werktijden in het doorzetbericht, iedereen mag schrijven (optioneel, niet bij QR), volledig uitgaand logboek. |
| §21.8 e-mail/Slack-events | `ctx.services.channels.onEmail(cb)` levert élke nieuwe mail van een e-mailkoppeling aan routines (onbetrouwbare data, met `authenticated`/`allowed`/`automated`). Slack-events via Socket Mode of HTTP (handtekening + replaybescherming). |
| Chatbericht als routinetrigger (B-63) | `ctx.services.channels.onChatMessage(cb)` biedt elk chatbericht (alle adapters behalve e-mail) aan routines aan, ná dedupe/rate limits/koppelen en vóór de bot antwoordt. Een trigger kan de bot laten zwijgen (`quiet`). |
| §5 veiligheid | Allowlist + koppelcodes, toegangsniveau per afzender (tools begrensd), externe berichten gemarkeerd als onbetrouwbaar, antwoorden alleen in hetzelfde gesprek, `channel_send` = `danger` (behalve naar ontvangers die de eigenaar per bot vrijgaf, en nooit bij geld of beloftes aan een klant), bestanden alleen uit de werkmap/gedeelde map, goedkeuringen naar de eigenaar, handtekeningcontrole op alle webhooks, rate limits, groottelimieten, secrets alleen in `ctx.secrets`, audit + logboek. |
| Levenscyclus | Verbinden/verbreken, automatisch opnieuw verbinden met exponentiële backoff (2 s → 5 min, jitter; niet bij ongeldige token), status + laatste fout live in de UI, "Gegevens controleren" (adaptertest: token/inloggen), "Test ontvangen en versturen", logboek (in/uit/systeem), audit. |

## Kanaalkoppeling

`(gebruiker, bot óf groep, adapter, instellingen, secret-referenties, allowlist, gezondheid, team)`. Instellingen die
voor elke adapter gelden:

- `othersAccess` — wat anderen op de allowlist mogen laten doen: `none` (alleen praten, **standaard**), `readonly` (alleen lees-tools), `agent` (alle tools van de bot, met de gewone goedkeuringen). Iemand die niet op de allowlist staat en schrijft omdat het kanaal open staat voor klanten, krijgt altijd `none`.
- `ownerAccess` — idem voor jezelf (afzender gemarkeerd als “Dit ben ik”, alleen in een **privégesprek** en bij e-mail alleen als SPF/DKIM/DMARC geslaagd is). Standaard `agent`.
- `approveViaChannel` — goedkeuringsknoppen ook in het kanaal (alleen Telegram/Discord/Slack/WhatsApp, alleen voor de eigenaar zelf in een privégesprek). Standaard uit.
- `reactions` (statusreacties, standaard aan; zie *Statusreacties*), `errorReply` (korte melding als de bot vastloopt), `transcribeVoice` (spraakberichten uitschrijven, standaard aan), `maxFileMb` (1–50, standaard 20; het platform kan lager zijn), `publicBaseUrl` (https-override van `TEAMBOT_PUBLIC_URL`).
- `customer` — klantenservice (zie hieronder): `{ enabled, open, aiLabel, handoff, approveMoney, hours: { enabled, days, from, to }, knowledge, profile }`. Standaard uit; bij WhatsApp Business staat het in *Kanaal toevoegen* al aan.
- WhatsApp (QR): `riskAcceptedAt` — wanneer de eigenaar de waarschuwing bevestigde (verplicht bij aanmaken; koppelingen van vóór 0.4 hebben het niet en blijven werken).

## Inkomend → antwoord

1. Adapter normaliseert naar `Inbound` (berichtid, gesprek, afzender, tekst, bijlagen).
2. **Dedupe** op extern berichtid (`channel_msg_ids`, idempotent bij retries/replays).
3. **Rate limit**: 10/min per afzender, 60/min per koppeling (publieke webhooks: 300/min per koppeling); klanten die zonder allowlist schrijven daarnaast 50 per dag.
4. **Testcode** (gezondheidstest loopt): `test CODE`, `/test CODE` of Telegrams `/start test_CODE` van wie dan ook → TeamBot antwoordt “✅ Het werkt …”. Geen allowlist, geen gesprek, geen bot. Eenmalig, 10 minuten geldig, alleen de hash bewaard.
5. **Allowlist**: onbekende afzender → genegeerd (logboek “blocked”, max. één melding per dag), behalve `/koppel CODE` (ook `/start CODE`, Telegram-deeplink, of “koppel CODE” in een mail), en behalve een **klant in een privégesprek** op een kanaal met klantenservice en *Iedereen mag de bot een bericht sturen* (niet bij WhatsApp via QR). Zo'n klant wordt niet aan de allowlist toegevoegd.
6. Commando's: `/nieuw` (nieuwe thread), `/stop` (lopende taak stoppen), `/help`, bij WhatsApp (QR) ook `/bots`; `/ja CODE`, `/nee CODE`, `/antwoord CODE tekst` voor goedkeuringen.
7. **Andere bot aanspreken** (adapters met `botRouting`, nu WhatsApp (QR); alleen de geverifieerde eigenaar): `@Baas …` of `Baas: …` → eigen gesprek + thread voor die bot in dezelfde chat (`<chat>#<agentId>`), daarna 30 minuten “plakkerig”; een antwoord (citaat) op een botbericht gaat naar die bot. Langste naam wint (“Baas Live” ≠ “Baas”); alleen een naam zonder @ of leesteken telt niet.
8. Gesprek + thread zoeken/aanmaken, bijlagen opslaan (max. 5 per bericht, groottelimiet), spraakberichten uitschrijven (`setTranscriber`, anders de voice-module als die is ingesteld; lukt het niet, dan krijgt de bot het geluidsbestand + een notitie), bericht plaatsen als `author_type: 'external'`, auteur “Naam (Kanaal)”.
   Daarvoor gaat het bericht (tekst + uitgeschreven spraak) naar `onChatMessage`-luisteraars (routinetriggers). Startte het een routine, dan staat er een event in de thread en een regel `routine` in het logboek; zegt een trigger `quiet`, dan wordt niet gerouteerd. Een afzender die niet op de allowlist staat gaat nooit naar de bot (behalve een klant, zie 5), maar wordt wél aangeboden met `known: false` (alleen triggers met “Ook onbekende afzenders” reageren); WhatsApp (QR) laat onbekende nummers al in de adapter vallen.
9. **Klantenservice, vóór de bot**: vraagt een klant om een mens (“ik wil een medewerker spreken”), dan wordt het gesprek meteen doorgezet en draait de bot niet. Staat het gesprek al bij de eigenaar, dan antwoordt de bot niet en krijgt de eigenaar een melding.
10. Routering via de gewone `ChatService` (bot of groep). Per beurt komt in de context: kanaal, afzender, of het de eigenaar is, en het toegangsniveau.
    Bot op een **CLI-engine** en toegangsniveau ≠ `agent`: bij Claude Code + `none` start de run met `run.meta.override = { access_mode: 'chat', tool_groups: [] }` (Claude Code zonder tools); elke andere combinatie wordt geweigerd: event in de thread, logregel `refused`, melding aan de eigenaar (max. één per afzender per dag) en een kort bericht aan de afzender. `ReceiveResult` krijgt `routines`, `quiet` en `refused`; de webhook-adapter antwoordt dan 202 met `status: 'routine' | 'refused'` (en wacht niet op een antwoord).
11. `afterRun`: het eindantwoord (+ bestanden die de bot deelde) gaat naar hetzelfde gesprek — alleen als de run door een extern bericht kwam. Wat jij zelf in de thread typt gaat **niet** naar buiten. In een klantgesprek gaat het concept eerst door de **controle** (zie Klantenservice). Bezorgstatus komt onder het bericht (“Verstuurd via Telegram”, “Wacht op jouw goedkeuring”, “Niet verstuurd, doorgezet naar jou”, “Niet verstuurd — Opnieuw”).

Overnemen: per gesprek **pauzeren** (bot antwoordt niet, jij krijgt een melding) en **zelf antwoorden** vanuit de chatkop of de Gesprekken-tab.

### Statusreacties (0.4.4)

Gaat een bericht naar een bot, dan zet TeamBot een reactie op dat bericht: 👀 zodra de bot begint, en als hij klaar is
met alles in dat gesprek (geen run meer actief) een reactie voor klaar of fout. Per platform:

| Platform | Begint | Klaar | Fout | Wat nodig is |
|---|---|---|---|---|
| Telegram | 👀 | 👍 | 😢 | niets (`setMessageReaction`; bots mogen alleen emoji uit Telegrams vaste lijst) |
| Slack | `eyes` | `white_check_mark` | `x` | scope `reactions:write` (staat in het manifest; oudere apps: scope toevoegen en opnieuw installeren) |
| Discord | 👀 | ✅ | ❌ | recht *Add Reactions* (staat in de uitnodigingslink, `DISCORD_PERMISSIONS`) |
| WhatsApp (QR) | 👀 | ✅ | ❌ | niets (`client.sendReaction` van whatsapp-web.js op het volledige bericht-id) |
| WhatsApp Business | 👀 | ✅ | ❌ | niets (Cloud API-bericht `type: reaction`) |

E-mail en webhook hebben geen reacties: daar gebeurt niets (en is er geen schakelaar). Slack en Discord halen 👀 weg
voor ze klaar of fout zetten; Telegram en WhatsApp vervangen hem vanzelf. Een geweigerde reactie (scope of recht
ontbreekt, bericht weg) wordt stil overgeslagen: geen fout, geen logregel, het antwoord gaat gewoon. Een run die
onderbroken wordt (herstart) laat 👀 staan. Techniek: de adapter geeft `Inbound.reactTo` mee (eigen formaat) en
implementeert `react(conv, reactTo, status)`; `AdapterDef.reactions` laat de schakelaar zien
(`reactionsSupported` in de koppeling). De manager onthoudt per thread welke berichten nog een eindreactie krijgen
(`reactStart` / `reactEnd`, vanuit `run.updated`). Uitzetten: Kanaal › Toegang › *Reacties als status op berichten*.

## Gezondheid: “verbonden” pas na bewijs

Een verbinding die openstaat (polling loopt, de webhook-URL bestaat, de socket zei hallo) bewijst niet dat berichten
aankomen. Daarom houdt elke koppeling een gezondheidsrecord bij (`channel_bindings.health`, `server/modules/channels/health.ts`):

- **Bewijs uit het logboek**: elke regel “in” (behalve een geweigerd verzoek of een fout) betekent dat het platform iets
  aan TeamBot afleverde, ook een geweigerde onbekende afzender of een ongelezen mail van een niet-geverifieerde
  afzender; elke regel “uit” (bericht of systeemantwoord) dat het platform een bericht van ons aannam.
- **Staat** (`health.state`): `off`, `connecting`, `error` (reden = laatste fout), `untested` (*Verbonden, nog niet
  getest*), `receive_failed`, `send_failed`, `ok` (*Verbonden*). `ok` alleen met bewijs voor ontvangen én versturen
  (een webhook met “geen antwoord terugsturen” hoeft alleen te ontvangen).
- **Exacte redenen**: een kanaal met webhook zonder publiek https-adres kan niets ontvangen (dat staat er meteen); een
  verzoek met een ongeldige handtekening vóór het eerste echte bericht → “controleer het geheim”; een mislukte
  verzending → de fout van het platform; een test zonder bericht → wat het platform zegt (Telegram `getWebhookInfo`)
  of de waarschijnlijke oorzaken per adapter (`AdapterDef.receiveHint`, bijv. bij WhatsApp “Meta heeft de webhook
  bevestigd, maar stuurde geen bericht: vink *messages* aan”).
- **De test** (*Test ontvangen en versturen*): TeamBot toont `test CODE` (Telegram: ook een link en QR-code); wie die
  stuurt krijgt een antwoord, en daarmee zijn beide richtingen bewezen. Komt er binnen 10 minuten niets, dan staat
  ontvangen op *lukt niet* met de reden. Kwamen er wel andere berichten binnen, dan zegt de test dat.
- **Telegram in één stap**: *Koppel mijn Telegram* maakt een eigenaarscode met deeplink (en QR-code voor de
  telefoon); `/start CODE` + het antwoord “Gekoppeld!” bewijzen ook beide richtingen.
- **Platformcontrole**: Meta's verify-token-check en Slacks `url_verification` worden bewaard (`platformAt`), maar
  tellen niet als ontvangen bericht.
- **Nieuwe verbindingsinstellingen** (token, adres, modus; elke nieuwe secret) wissen het bewijs; de foutgeschiedenis
  blijft. Kanalen van vóór 0.4 krijgen hun bewijs bij het opstarten uit het logboek.
- **Geschiedenis** op de kanaalpagina en de kaart: laatst ontvangen, laatst verstuurd, laatste fout, afgelopen 24 uur
  (binnen / verstuurd / fouten), en wanneer het platform de webhook bevestigde.
- De adaptertest (*Gegevens controleren*) zegt nu “Token werkt …” in plaats van “Verbonden als …” en is geen groen vinkje.

## Klantenservice (klantmodus)

Voor kanalen waar een bot met mensen buiten het team praat (`config.customer.enabled`). Vier schakelaars in de UI
(tab **Klanten**) plus goedgekeurde kennis; de server dwingt alles af op het concept van de bot
(`server/modules/channels/customer.ts`, `manager.customerReply`), de instructie aan de bot zegt hetzelfde maar beslist niets.

- **AI-label** (standaard aan): het eerste bericht in een gesprek, en weer na 24 uur stilte, begint met “🤖 Je praat met
  een AI-assistent. Wil je liever een mens? Zeg het gerust.” Antwoorden die de eigenaar zelf typt krijgen geen label.
- **Doorzetten naar mij** (standaard aan): het concept wordt **niet** verstuurd als de bot het niet weet (`[DOORZETTEN]`,
  “weet ik niet”, “ik zet je vraag door”), als het niet op de goedgekeurde kennis steunt (zie hieronder), als de bot
  vastloopt, of als de klant om een mens vraagt. De klant hoort eerlijk dat een medewerker antwoordt (met
  werktijden), de eigenaar krijgt een belangrijke melding met het gesprek en een kaart in *Wacht op jou*, en de bot
  zwijgt in dat gesprek (`paused` + `meta.handoff`) tot de eigenaar antwoordt (*Zelf antwoorden*) of het vrijgeeft.
  Staat de schakelaar uit, dan krijgt de klant alleen “Daar kan ik je helaas geen antwoord op geven.”
- **Nooit beleid verzinnen** (altijd): de kennis is één feit per regel, genummerd `[K1]`, `[K2]` …; elk getal, bedrag,
  percentage, tijdstip, aantal dagen, adres en elke link in het concept moet in de kennis of in het bericht van de
  klant staan; gaat het over prijzen, korting, terugbetalen/retour, garantie, levering/bestelling, openingstijden of
  voorwaarden, dan moet de kennis daarover iets zeggen; een inhoudelijk antwoord moet een bron noemen die er inhoudelijk
  bij past (minstens één woord gemeen). Begroetingen, bedankjes en wedervragen hoeven geen bron. Zonder kennis gaat
  elke inhoudelijke vraag naar de eigenaar. De bronverwijzingen worden uit het verstuurde bericht gehaald.
- **Kennis per team**: de kennis staat op het kanaal, en het kanaal hoort bij één team. Met *Bedrijfsprofiel van het
  team ook gebruiken* (`customer.profile`, standaard uit) komen de regels van het bedrijfsprofiel van **het eigen
  team** van het kanaal (bedrijf, wat het doet, toon, regels) er als goedgekeurde kennis achter (`[K…]` na de eigen
  regels, dus die houden hun nummer). Nooit het profiel van een ander team (`manager.knowledgeFor`).
- **Goedkeuren bij geld en beloftes** (standaard aan): een concept over prijzen, betalen, terugbetalen, kortingen of
  beloftes wacht in *Wacht op jou* met de precieze tekst, de reden(en) en de vraag van de klant. De eigenaar kan de tekst
  aanpassen en versturen (dan gaat precies zijn tekst weg), of tegenhouden (dan wordt het gesprek doorgezet naar hem).
  Eén beslissing per antwoord, ook met twee vensters open.
- **Werktijden**: dagen + van/tot; het doorzetbericht zegt “binnen onze werktijden (ma–vr 09:00–17:00)” of “We zijn nu
  gesloten; je krijgt antwoord vanaf maandag 09:00” (tijdzone van de eigenaar). De bot zelf antwoordt altijd.
- **Iedereen mag de bot een bericht sturen** (standaard aan zodra klantenservice aan staat): klanten in een
  privégesprek hoeven geen koppelcode; ze krijgen nooit tools (`none`, ook als `othersAccess` hoger staat), hooguit 50
  berichten per dag, en komen niet op de allowlist. Groepen blijven op de allowlist. Bij **WhatsApp via QR** kan dit
  nooit (dat is het eigen nummer van de eigenaar en zou zijn gewone contacten laten beantwoorden).
- **Hetzelfde poortje overal**: *Opnieuw* op een antwoord, een routineresultaat naar een klantgesprek
  (`services.channels.deliver`; houdt alles vast wat niet gewoon goed is, met de reden als fout voor de routine) en
  `channel_send` naar een klant (geld, beloftes of iets buiten de kennis = altijd `danger` met de volledige tekst in
  de goedkeuring, ook voor een vrijgegeven contact).
- **Logboek**: elk bericht dat op een kanaal met klantenservice weggaat staat met de volledige tekst in `channel_outbox`
  (antwoord, doorzetbericht, jouw eigen antwoord, systeembericht, `channel_send`, routine), ook concepten die niet
  verstuurd werden (status `handoff`/`rejected`) en aangepaste teksten (`edited`). Te zien in Logboek › *Verstuurd aan
  klanten* en in de volledige export. Het blijft bewaard tot de koppeling wordt verwijderd.
- Het gesprek van de eigenaar zelf op hetzelfde kanaal is geen klantgesprek: daar gelden de regels niet.
- **Geheugen per klant** (0.4.5, `docs/modules/memory.md` › "Geheugen per klant"): `ctx.services.channels.customerOf(threadId)`
  zegt wie er schrijft (koppeling, adapter, afzender, team, privé, geverifieerd; e-mail alleen met geslaagde
  afzendercontrole). Een herkende klant in een privégesprek krijgt per beurt alleen zijn eigen dossier als `[C1]` …; de
  controle (`classifyDraft({ …, customer })`) laat die regels een getal of bron dragen, maar nooit beleid (prijs,
  terugbetalen, levering …: alleen de goedgekeurde kennis), en geld en beloftes wachten nog steeds op de eigenaar.

## Per team (0.4, pakket B4)

`server/modules/channels/teams.ts` (`ChannelTeams`, op `manager.teams`). Met één team verandert er niets (alleen de
sleutelcontrole hieronder); de regels gelden vanaf twee teams.

- **Welk team**: het team van de bot van het kanaal (of van de groep, `rooms.workspace_id`), live; is de bot weg, dan
  het opgeslagen `channel_bindings.team_id`, anders het standaardteam. `team_id` wordt bij het maken en wijzigen
  gezet, bij de start voor kanalen van vóór teams gevuld, en bij `teams.changed` bijgewerkt: verhuist een bot naar een
  ander team, dan gaat zijn kanaal mee.
- **Antwoorden en versturen alleen door bots van dat team**:
  - `channel_send` en `channel_list` zien alleen de eigen kanalen (`bindingsForAgent`); `channel_send` naar een kanaal
    van een ander team wordt geweigerd vóór de toestemmingskaart. Met *meekijken* of *aansturen* zegt de weigering
    waarom; zonder toegang bestaat het kanaal voor de bot niet ("Geen kanaal … dat … mag gebruiken").
  - Het eindantwoord van een bot van een ander team (bijvoorbeeld in een groep die andere teams toelaat) gaat niet naar
    buiten; in het gesprek staat waarom (`onRunDone`).
  - Noemt de eigenaar in WhatsApp (QR) een bot van een ander team (`@Bo …`), dan krijgt hij meteen te horen dat die bot
    bij een ander team hoort; de bot wordt niet aangesproken en de chat blijft niet aan hem "plakken".
  - Een routine bezorgt alleen via een kanaal van zijn eigen team: `services.channels.deliver({ …, agentId })` weigert
    anders met de reden.
- **Zien met meekijken**: `channel_list` toont kanalen van teams waar de bot mag meekijken of die hij aanstuurt, met hun
  gesprekken, gemarkeerd als *alleen meekijken: versturen via dit kanaal kan niet*. Versturen kan nooit.
- **Sleutels**: bovenop het team volgt elk kanaal `keyAllowed(bot, 'channel', bindingId)` van de teams-module.
- **De eigenaar** ziet alle kanalen; `GET /channels/bindings?teamId=` toont één team; elke weergave heeft `team_id`
  en `teamName`; *Wacht op jou* (`/channels/inbox`) blijft van alle teams, met `team_id`/`team_name` per item.
- **Routinetriggers**: `onChatMessage` en `onEmail` geven `teamId` mee; `emailBindings` ook.

## API (ingelogd, alleen eigen data)

| Route | Doel |
| --- | --- |
| `GET /api/channels/adapters` | Catalogus, publieke URL, presets |
| `GET /api/channels/rooms` | Groepen van de gebruiker (via rooms-dienst of -tabel, defensief) |
| `GET/POST /api/channels/bindings` | Lijst (`?agentId=`, `?teamId=`) / aanmaken (`{adapter,name,agent_id|room_id,config,secrets}`; WhatsApp (QR) vereist `config.riskAccepted: true`; het team volgt uit de bot of groep) |
| `GET/PATCH/DELETE /api/channels/bindings/:id` | Detail (incl. allowlist, codes zonder codewaarde, `health`, `team_id`, `teamName`) / wijzigen (een andere bot of groep neemt het kanaal mee naar zijn team) / verwijderen (wist ook secrets en de outbox) |
| `POST /api/channels/bindings/:id/connect` · `/disconnect` · `/test` | Levenscyclus; `/test` = gegevens controleren (geen bewijs van ontvangen) |
| `POST/DELETE /api/channels/bindings/:id/health-test` | Test ontvangen en versturen starten (`{code,text,deepLink,qrSvg,expiresAt}`) / stoppen |
| `GET /api/channels/bindings/:id/log?before=` | Logboek |
| `GET /api/channels/bindings/:id/outbox?before=` | Alles wat naar klanten ging (volledige tekst), nieuwste eerst |
| `GET /api/channels/inbox` | *Wacht op jou*: `{ held, handoffs }` |
| `POST /api/channels/outbox/:id/approve` `{text?}` · `/reject` | Vastgehouden antwoord versturen (eventueel aangepast) / tegenhouden (gesprek naar de eigenaar) |
| `POST /api/channels/conversations/:id/release` | Doorgezet gesprek teruggeven aan de bot |
| `POST/PATCH/DELETE /api/channels/bindings/:id/senders[/:sid]` | Allowlist |
| `POST/DELETE /api/channels/bindings/:id/pair-codes[/:cid]` | Koppelcode (code wordt één keer getoond, opgeslagen als hash; Telegram: ook deeplink + QR) |
| `GET /api/channels/bindings/:id/conversations` | Gesprekken (incl. `handoff`) |
| `PATCH /api/channels/conversations/:id` · `POST …/send` | Pauzeren/hervatten (hervatten geeft een doorgezet gesprek vrij) / zelf antwoorden (geeft het ook vrij) |
| `GET /api/channels/threads/:threadId` | Kanaalinfo voor de chatkop (incl. `handoff`) |
| `POST /api/channels/messages/:id/resend` | Antwoord opnieuw bezorgen (in een klantgesprek opnieuw door de controle) |
| `GET /api/channels/slack-manifest?mode=&name=&bindingId=` | Slack-app-manifest |
| `GET /api/channels/discord-invite?bindingId=` | Uitnodigingslink |
| `GET /api/channels/bindings/:id/whatsapp` | WhatsApp (QR): fase, QR als SVG (alleen voor de eigenaar), gekoppeld nummer |
| `POST /api/channels/bindings/:id/whatsapp/link` · `/pair-phone` `{phone}` · `/logout` | Koppelen starten (nieuwe QR) / koppelcode via telefoonnummer / ontkoppelen + sessie wissen |
| `GET /api/channels/agents/:agentId/send-rules` | “Versturen zonder te vragen” van een bot |
| `PUT …/send-rules/owner` `{enabled}` · `POST …/send-rules` `{binding_id,target,label}` · `DELETE …/send-rules/:id` | Naar de eigenaar zelf / naar een vertrouwd contact |

Telefoon (apparaattoken): sinds 0.4.1 kan de telefoon van de eigenaar alles wat de computer hier kan (kanalen maken,
wijzigen en verwijderen, allowlist, koppelcodes, de gezondheidstest, regels, WhatsApp koppelen en klantenservice
afhandelen); de regels van de kanalen zelf gelden ook daar (bijvoorbeeld de QR-waarschuwing vóór een nieuwe
koppeling). Wat alleen op de computer kan, staat in `server/modules/mobile/policy.ts`.

Publiek (geen login, elke adapter controleert zelf): `GET|POST /api/public/hooks/channels/:bindingId/:kind` met
`kind` = `telegram` (header `X-Telegram-Bot-Api-Secret-Token`), `slack` (`X-Slack-Signature` + tijdstempel ≤ 5 min),
`whatsapp` (GET verify token, POST `X-Hub-Signature-256`), `webhook` (`X-TeamBot-Signature` + `X-TeamBot-Timestamp`).
Ruwe body (de JSON-parser van de kern slaat `/api/public/hooks` over), limiet 5 MB.

## Tools

| Naam | Groep | Risico | Wat |
| --- | --- | --- | --- |
| `channel_list` | `channels` | `read` | Koppelingen van deze bot en bekende gesprekken |
| `channel_send` | `channels` | **`danger`**, per aanroep `write` voor vrijgegeven ontvangers | Nieuw bericht, met `files` (max. 10, alleen uit de werkmap/extra mappen van de bot, geen geheimen, binnen de groottelimiet van het kanaal), naar een ander gesprek/adres/nummer of `to: "eigenaar"`. Vraagt toestemming (ook in `auto`, “altijd toestaan” kan niet), **behalve** als de eigenaar voor deze bot “mag mij zonder vragen sturen” aanzette (geldt voor zijn eigen, geverifieerde gesprekken op elk kanaal) of dat contact vrijgaf (`channel_send_rules`). Op een kanaal met klantenservice: een bericht aan een klant met geld, een belofte of iets buiten de kennis vraagt altijd toestemming, met de volledige tekst; het AI-label gaat mee. Elke verzending staat in de audit (`preApproved`, bestandsnamen + groottes). |

Groep `channels` staat standaard uit; aanzetten in de bot-editor (sectie Kanalen, met daaronder “Versturen zonder te vragen”). Tools verschijnen alleen als de bot koppelingen heeft (`channel_list` ook als hij alleen kanalen van een team ziet waar hij mag meekijken); een WhatsApp (QR)-koppeling delen alle bots van de eigenaar in het team van dat kanaal. Het per-aanroeprisico loopt via `ToolDef.riskFor` + `callRisk` (broker); wie `Broker.decide` voor een concrete aanroep gebruikt (runner, MCP-brug) moet `callRisk` gebruiken.
In kanaalthreads begrenst een **tool-filter** de tools op het toegangsniveau van de afzender.

## Diensten (`ctx.services.channels`)

- `onEmail(cb) → unsubscribe` — e-mailtrigger voor routines. Payload `EmailEvent` (`types.ts`): van/aan/onderwerp/tekst/bijlagenamen, `authenticated`, `allowed`, `automated`. **Onbetrouwbare data.**
- `onChatMessage(cb) → unsubscribe` — chatbericht-trigger voor routines. Payload `ChatMessageEvent` (`types.ts`): koppeling, adapter + label, platform-berichtid (dedupesleutel), gesprek, afzender, `known` (allowlist; `false` voor een klant die zonder allowlist schrijft), `isOwner` (geverifieerde eigenaar in een privégesprek), tekst, bijlagenamen. **Onbetrouwbare data.** De callback antwoordt synchroon `{ routines?: string[]; quiet?: boolean }`.
- `emailBindings(userId)`, `bindings(userId)` — views zonder secrets (met `health` en het team).
- `deliver({userId, bindingId, conversationId|senderId|owner, text, files?, senderName?, agentId?})` — door de gebruiker ingestelde bezorging (bijv. routineresultaat met pdf naar je eigen WhatsApp). Met `agentId` (een routine van die bot) alleen via een kanaal van het team van die bot. Alleen naar de eigenaar zelf, een bestaand gesprek of het privégesprek van iemand op de allowlist, nooit naar nieuwe ontvangers. Naar een klantgesprek gaat het door de controle; wat wordt vastgehouden geeft een fout “Wacht op jouw goedkeuring …”. `runFiles(runId, userId)` geeft de bestanden die de bot in een run deelde.
- `setTranscriber(fn | null)` — spraak-naar-tekst voor binnenkomende spraakberichten (type `Transcriber` in `types.ts`); zonder eigen engine wordt `ctx.services.voice.transcribe` gebruikt als die is ingesteld.
- `setWhatsAppDriverFactory(f | null)` — vervangt het WhatsApp Web-transport (tests).
- `registerAdapter(def)` — extra adapters (ook gebruikt in tests). Optioneel `receiveHint(o)` (waarschijnlijke oorzaken als de test niets ontving) en in de runtime `diagnose()` (wat het platform zelf zegt).
- `exportUser(userId)` — koppelingen (zonder secrets), allowlist, gesprekken, regels en de outbox voor de volledige export.

## Tabellen

`channel_bindings` (config/secret_ids/state/health JSON, `team_id`; `secret_ids` verwijst naar de kern-`secrets`), `channel_senders`,
`channel_pair_codes` (sha-256 van de code), `channel_conversations` (extern id ↔ thread, pauze, laatste afzender; `meta.handoff`, `meta.aiLabelAt`),
`channel_msg_ids` (dedupe + e-mail-Message-ID ↔ gesprek; chatplatforms 30 dagen, e-mail 365 dagen bewaard),
`channel_log` (max. ~1000 regels per koppeling, geredigeerd), `channel_approval_prompts` (7 dagen), `channel_send_rules` (per bot: `target` = `owner` met `binding_id` NULL voor alle kanalen, of een extern id op één kanaal; alleen via de API door de eigenaar),
`channel_outbox` (migratie `channels-003`: per bericht aan een klant `kind`, `status` (`sent`/`failed`/`held`/`sending`/`handoff`/`rejected`), vraag, concept, verstuurde tekst, redenen, bestanden, platform-id's, `edited`, wie/wanneer besliste).

## Events (WebSocket)

`channels.status` `{id,status,last_error,last_ok_at}`, `channels.health` `{id,health}` (bij een andere staat, tijdstempels hooguit elke 5 s),
`channels.log` (logregel), `channels.updated` (view), `channels.deleted` `{id}`, `channels.conversation` (pauze/doorzetten gewijzigd),
`channels.outbox` `{id?,status?,conversationId?,handoff?}` (*Wacht op jou* opnieuw laden), `channels.whatsapp` `{id,phase,…}` (koppelstatus, zonder QR),
plus `notification` (onbekende afzender, nieuw gekoppeld, gepauzeerd gesprek, bezorging mislukt; `important: true` bij een doorgezette klantvraag en een antwoord dat op goedkeuring wacht)
en de gewone `thread.updated`/`message.*`.

## UI

- **Kanalen**: kaarten met de gezondheidsbadge (*Verbonden* alleen met bewijs), laatst ontvangen, laatste fout; QR-kaarten
  met de waarschuwing. Vanaf twee teams volgt de lijst de teamkiezer (met *Alle teams tonen*) en staat het team op de
  kaart en op de kanaalpagina.
- **Kanaal toevoegen**: Telegram eerst en breed, *Makkelijkst en veiligst*; WhatsApp Business *Officieel, voor je
  bedrijf*; WhatsApp (QR) als laatste met *Onofficieel: nummer kan geblokkeerd worden*. Kies je QR, dan komt eerst de
  waarschuwing met “Ik begrijp dat WhatsApp dit nummer kan blokkeren” en een knop naar WhatsApp Business; pas daarna het
  formulier. Een schakelaar *Deze bot praat met klanten* (niet bij QR).
- **Kanaalpagina**: tabs Overzicht (gezondheid met test, Telegram *Koppel mijn Telegram*, geschiedenis), Toegang,
  **Klanten** (de schakelaars, werktijden, goedgekeurde kennis, *Bedrijfsprofiel van het team ook gebruiken*), Gesprekken (*doorgezet naar jou* + *Vrijgeven*),
  Logboek (+ *Verstuurd aan klanten*), Instellingen.
- **Wacht op jou**: sectie *Klanten* met vastgehouden antwoorden (exacte tekst, aanpasbaar) en doorgezette gesprekken
  (*Zelf antwoorden*, *Vrijgeven aan de bot*); telt mee in het badge-getal (`inbox.useCount`).
- **Chat**: de chatkop toont *Doorgezet naar jou*; onder een antwoord staat of het verstuurd, vastgehouden of doorgezet is.

## Setup per adapter

### Telegram (aanbevolen: geen publieke URL, geen open poort, geen risico voor je nummer)
1. Open @BotFather in Telegram, stuur `/newbot` en kies een naam die op `bot` eindigt.
2. Plak de token, sla op. TeamBot doet `getMe` + `deleteWebhook` en long-pollt `getUpdates` (offset wordt bewaard).
3. *Koppel mijn Telegram* → open de `t.me/<bot>?start=CODE`-link (of scan de QR-code met je telefoon) en druk op Start. Daarna sta je op de allowlist als “Dit ben ik” en is het kanaal *Verbonden*.
4. Optioneel (Geavanceerd): groepen aanzetten (privacymodus: alleen commando's, @vermeldingen, antwoorden op de bot); webhookmodus (publieke HTTPS-URL nodig; TeamBot zet `setWebhook` met een eigen geheime token, en de test vraagt bij falen `getWebhookInfo`).
Opmaak: Markdown → MarkdownV2 met volledige escaping; bij een parse-fout valt hij terug op platte tekst. Splitsen op 3500 tekens (limiet 4096). Ontvangen bestanden ≤ 20 MB (limiet van de Bot API), versturen foto ≤ 10 MB / document ≤ 50 MB.
Gebruikt een ander programma dezelfde token (bijv. een andere TeamBot), dan krijgt dat de berichten; de test zegt dat.

### WhatsApp Business — Cloud API (officieel; publieke URL + Meta-bedrijfsaccount vereist)
Voor bots die de klanten van je eigen bedrijf helpen (vragen, afspraken, bestellingen): Meta staat geen algemene
AI-assistent toe. *Klantenservice* staat daarom bij het toevoegen al aan.
1. developers.facebook.com → app type Business → product WhatsApp.
2. Phone number ID (API Setup), permanente systeemgebruiker-token (`whatsapp_business_messaging`, `whatsapp_business_management`), App secret (App-instellingen › Basis).
3. Verify token: door de wizard gegenereerd (kopiëren vóór opslaan).
4. Meta → WhatsApp › Configuratie › Webhook: callback = webhook-URL van de koppeling, verify token, veld `messages`.
Bij het verbinden controleert TeamBot token en nummer (`display_phone_number`, `verified_name`); een ingetrokken token is een duidelijke fout zonder herhaalpogingen.
Controle: `X-Hub-Signature-256` (HMAC app secret), `phone_number_id` moet kloppen, dedupe op `wamid`, berichten ouder dan 24 uur (instelbaar) genegeerd. Leesbevestiging + typindicator via `status: read` + `typing_indicator`. Knoppen (max. 3) voor goedkeuringen. Graph API standaard `v25.0` (instelbaar).

### E-mail (geen publieke URL nodig)
- Presets: **Gmail** (imap.gmail.com:993 / smtp.gmail.com:465, app-wachtwoord vereist 2-stapsverificatie), **TransIP** (imap.transip.email:993 / smtp.transip.email:465, volledig adres + mailboxwachtwoord), **Outlook/Microsoft 365** (outlook.office365.com:993 / smtp.office365.com:587 STARTTLS — zie beperkingen), of eigen servers.
- Alleen **nieuwe, ongelezen** mail in de gekozen map na het starten van de koppeling (UID-markering per UIDVALIDITY); daarna als gelezen gemarkeerd.
- Draad via `Message-ID`/`In-Reply-To`/`References`; antwoorden krijgen `Re:`, correcte `In-Reply-To`/`References` en `Auto-Submitted: auto-replied`. Antwoord gaat altijd naar het **From**-adres dat op de allowlist staat (nooit `Reply-To`).
- Geciteerde tekst en handtekeningen worden weggeknipt; HTML → tekst. Auto-replies, bounces, mailinglijsten en eigen mail krijgen nooit antwoord (lusbescherming).
- “Alleen geverifieerde afzenders” (standaard aan): de bovenste `Authentication-Results` moet DMARC-pass of een uitgelijnde DKIM/SPF-pass tonen.
- Test: mail `test CODE` in het onderwerp naar het adres van de bot.
- **Een eigen adres per bot** (0.4.4, P10; `config.plusAddressing`, standaard uit): op je eigen mailbox krijgt elke bot
  van het team van het kanaal een plusadres, `jij+baas@gmail.com` voor Baas (de naam zonder hoofdletters, accenten en
  spaties: “Mila de Planner” → `mila-de-planner`; een eigen tag per bot in `config.plusTags`, `{ agentId: tag }`; twee
  bots met dezelfde tag: alleen de eerste). Mail aan zo'n adres (To, Cc, of `Delivered-To`/`X-Original-To` bij Bcc) is
  een gesprek met die bot; een mailthread houdt de bot waarmee hij begon. Een onbekende tag of een bot van een ander
  team: de bot van het kanaal (logregel `ignored`). Je eigen mail aan een plusadres telt als bericht (zonder plusadres
  blijft eigen mail genegeerd); de antwoorden van TeamBot dragen `X-TeamBot` en worden nooit gelezen. De allowlist,
  *Alleen geverifieerde afzenders* en de klantmodus blijven gelden.
  Antwoorden komen vanaf het plusadres met de naam van de bot (`replyFromPlus`, standaard aan). Gmail en de meeste
  aanbieders houden dat adres alleen als je het eenmalig instelt als adres om vanaf te versturen (Gmail: *Instellingen ›
  Accounts › Verzenden als*); anders tonen ze je gewone adres en komt de mail gewoon aan. `GET /channels/bindings(/:id)`
  geeft `botAddresses` (`agentId`, `name`, `tag`, `address`, `own`); *Kanalen* en het kanaal zelf tonen het adres van elke
  bot. Een eigen domein per bot kan later (kost geld). Code: `email-util.ts` (`plusTagOf`, `plusAddress`, `botTag(s)`),
  `adapters/email.ts`, `manager.botAddresses`; tests `tests/channels-email-plus.test.ts`, `tests/e2e/email-per-bot.mjs`
  (ook de gekoppelde telefoon).

### Discord (geen publieke URL nodig)
1. Developer Portal → New Application → Bot → Reset Token. **Geen privileged intents nodig** (intents: Guilds, GuildMessages, DirectMessages; Discord levert inhoud van DM's en @vermeldingen ook zonder Message Content).
2. Plak de token, sla op, klik *Gegevens controleren* → uitnodigingslink verschijnt (rechten: kanalen zien, berichten sturen, bestanden, geschiedenis, threads, reacties toevoegen).
3. Koppel jezelf met een code via een DM. In servers reageert de bot alleen als hij @vermeld wordt. Antwoorden pingen niemand (`allowedMentions` leeg).

### Slack (Socket Mode: geen publieke URL nodig)
1. Kopieer het manifest uit de wizard → api.slack.com/apps → Create New App → From a manifest.
2. Install to Workspace → Bot User OAuth Token (`xoxb-`). Het manifest vraagt ook `reactions:write` (statusreacties); een
   app van vóór 0.4.4 krijgt die scope via OAuth & Permissions › Scopes + *Reinstall to Workspace* (zonder: geen reacties).
3. Basic Information → App-Level Tokens → scope `connections:write` → `xapp-`-token.
4. Plak beide tokens. Socket Mode via `apps.connections.open` + WebSocket (`ws`), elke envelope wordt direct ge-ackt; `disconnect`/`refresh_requested` → nieuwe verbinding.
5. Events API (alternatief): signing secret + publieke URL; manifest bevat dan de request-URL; Slacks `url_verification` wordt als platformcontrole bewaard.
Slack heeft geen typindicator voor bots. In kanalen alleen @vermeldingen (scope `channels:history` wordt bewust niet gevraagd). Komt er bij de test niets binnen: events `message.im`/`app_mention` en App Home › Messages controleren.

### Webhook (eigen integraties)
`POST /api/public/hooks/channels/<id>/webhook` met JSON `{"id","sender":{"id","name"},"conversation":{"id","title"},"text","attachments":[{"name","mime","base64"}]}` en
`X-TeamBot-Timestamp` (unix-seconden) + `X-TeamBot-Signature: sha256=HMAC_SHA256(geheim, timestamp + "." + body)`.
Antwoord: `sync` (in de HTTP-response, max. `syncTimeoutSec`), `callback` (POST naar je URL, op dezelfde manier ondertekend; SSRF-check, lokaal netwerk alleen voor eigenaar/beheerder met expliciete schakelaar) of `none` (dan hoeft de gezondheid alleen ontvangen te bewijzen).
Optioneel `Authorization: Bearer <geheim>` (zonder replaybescherming, standaard uit).

### WhatsApp (QR-code) — je eigen nummer als gekoppeld apparaat (onofficieel, alleen voor jezelf)
**Waarschuwing vooraf** (verplicht te bevestigen bij het toevoegen, en zichtbaar op het kanaal): deze koppeling werkt
zoals WhatsApp Web maar via een onofficiële weg; WhatsApp kan het nummer blokkeren, tijdelijk of voorgoed, zonder
bezwaarmogelijkheid, en dan ben je ook je chats op dat nummer kwijt. Voor je bedrijf of klanten: WhatsApp Business
(officieel) of Telegram. Klantenservice kan hier niet open voor iedereen.
1. Kanaal toevoegen → WhatsApp (QR-code) → waarschuwing bevestigen, bot kiezen, optioneel *je eigen nummer* (wordt met een ander nummer gekoppeld, dan ontkoppelt TeamBot meteen weer). Alleen eigenaar/beheerder (elke koppeling start een eigen onzichtbare browser).
2. TeamBot start **whatsapp-web.js** (Apache-2.0) in de Edge/Chrome/Chromium die al op de computer staat (`puppeteer-core`, geen browserdownload; `TEAMBOT_BROWSER_PATH` om te kiezen) en toont de QR (ververst vanzelf). Scannen: WhatsApp › Gekoppelde apparaten › Apparaat koppelen. Op de telefoon zelf: “Koppelen met telefoonnummer” → code van 8 tekens. Na 5 minuten zonder koppeling stopt de browser weer.
3. Na koppelen staat je eigen nummer op de allowlist als “Dit ben ik”. Praat in je chat **“Bericht aan jezelf”**; antwoorden en bestanden van de bots staan daar met `🤖 *Botnaam*`. Berichten die TeamBot zelf stuurde komen niet als vraag terug (id, inhoud en 🤖-markering). De test stuur je ook in die chat.
4. Wat TeamBot leest: alleen die eigen chat, nummers op de allowlist (of met `/koppel CODE`) en — als je groepen aanzet — groepsberichten waarin je account @genoemd wordt. Je chats met anderen en berichten van onbekende nummers worden **genegeerd zonder iets te loggen**. Statusupdates/kanalen nooit. Berichten ouder dan 24 uur (instelbaar) worden na een tijd offline niet alsnog beantwoord.
5. Sessie: werkprofiel in `<data>/channels/<binding>/profile` (alleen zolang de verbinding loopt), daarna alleen `session.enc`: AES-256-GCM-archief van IndexedDB + Local Storage, sleutel als intern geheim (`sessionKey`) in de kluis — niet via de API te lezen of te zetten. Na een crash wordt het nieuwere profiel nog één keer gebruikt en opnieuw versleuteld. Ontkoppelen (TeamBot of telefoon) wist beide, en ook het bewijs van de gezondheid.
6. Verbinding weg → opnieuw verbinden met backoff; ontkoppeld op de telefoon → duidelijke fout zonder herhaalpogingen. Nooit gekoppeld en niet net aangevraagd → bij het opstarten geen browser, wel de melding “Nog niet gekoppeld”.
Transport achter een interface (`whatsapp-web/driver.ts`); tests gebruiken een nep-socket, `npm run whatsapp:live` doet de echte test met een telefoon (zie de kop van `tests/e2e/whatsapp-live.mjs`; `WA_QR_ONLY=1` = voorcontrole zonder telefoon). Docker: bouw met `--build-arg WITH_CHROMIUM=1`.

## Ontwerpkeuzes (mini-ADR's)

1. **Tool-filter in de kern** (`ToolRegistry.addFilter`): de enige manier om per thread tools te begrenzen zonder Broker/Runner te wijzigen. Filters kunnen alleen weghalen en falen dicht (geen tools). Alternatief (monkeypatchen van `forAgent`) afgewezen als fragiel.
2. **Standaard `othersAccess = none`**: een chatkanaal is een open deur; vrienden kunnen praten, niet je computer bedienen. Eigenaarsrechten alleen in een privégesprek met een platform-geauthenticeerde identiteit (bij e-mail: geslaagde SPF/DKIM/DMARC).
3. **CLI-agents** (Claude Code, Codex, OpenCode …) hebben eigen tools die het filter niet ziet. Claude Code kan zonder tools draaien (zijn chatmodus, `--tools ""`, geen MCP), dus “Alleen praten” werkt daar via een run-override die alleen kan beperken. “Alleen lezen” is per afzender bij geen enkele CLI af te dwingen en Codex/ACP-engines weigeren chatmodus: die combinaties worden geweigerd en de eigenaar krijgt een melding (niet alleen een event). De UI (Toegang, Overzicht, Kanaal toevoegen) toont per engine wat kan, via `view.engine = { type, kind, label, levels }`. Een CLI-run met alle tools op een bericht van iemand die dat niet mag (bijv. “Opnieuw” in TeamBot) wordt nooit naar buiten gestuurd.
4. **Antwoorden alleen bij externe trigger**: een run gaat alleen naar buiten als het invoerbericht extern was (of bij hervatten/opnieuw van zo'n bericht). Wat de eigenaar in de thread typt blijft privé.
5. **Goedkeuringen** gaan via de bestaande Broker (TeamBot + telefoonmeldingen). Kanaalknoppen zijn een opt-in extra, gebonden aan code + gesprek + afzender-id, eenmalig, en worden geaudit.
6. **Slack Socket Mode met `ws` + `fetch`** i.p.v. `@slack/bolt`: geen zware extra dependency, protocol is klein (open, ack, reconnect).
7. **`mailparser`** (MIT, zelfde auteur als imapflow/nodemailer) voor robuuste MIME-parsing i.p.v. een eigen parser.
8. **Koppelcodes** als sha-256 opgeslagen, 8 tekens zonder verwarrende letters, max. 5 pogingen per afzender per uur, eigenaarscode alleen in privégesprek.
9. **Secrets**: per veld `channels:<binding>:<veld>` in `ctx.secrets`; de API toont alleen `{veld: true}`. Foutmeldingen worden geschoond van tokenwaarden (Telegram-token zit in de URL) en geredigeerd.
10. **Webhook-geheimen** (WhatsApp verify token, webhook-HMAC) genereert de UI client-side zodat de server ze nooit hoeft terug te geven.
11. **Gezondheid uit het logboek** in plaats van per adapter een eigen “gezond”-signaal: elke adapter logt al wat binnenkomt en weggaat, dus het bewijs is voor alle zeven kanalen gelijk en kan niet “vergeten” worden. De transportstatus (`status`) blijft bestaan voor de levenscyclus; de UI toont alleen nog de gezondheid. Een test met een code (in plaats van alleen de platformcontrole) omdat alleen een echt bericht bewijst dat het platform berichten aflevert; Meta's en Slacks eigen controle worden wel getoond als tussenstap.
12. **Klantenservice in de code, niet in de prompt**: de controle draait op het afgemaakte concept, vlak vóór het versturen, in hetzelfde pad voor antwoorden, *Opnieuw*, routines en `channel_send`. Gekozen voor een vaste, uitlegbare controle (getallen, onderwerpen, bron) in plaats van een tweede modelaanroep: deterministisch, gratis, testbaar met de nep-provider, en bij twijfel naar een mens (de veilige kant). De bot krijgt dezelfde regels in zijn instructie zodat hij ze zelden overtreedt. Afgewezen: alleen een prompt (valt weg bij samenvatten of een zwak model), en de kern-Broker als wachtrij (verloopt bij een herstart en heeft geen bewerkveld).
13. **Eigen wachtrij `channel_outbox`** + sectie in *Wacht op jou* (`UIModule.inbox`): overleeft een herstart, bewaart de exacte en de aangepaste tekst, en is meteen het volledige logboek van wat klanten kregen. Geen kernwijziging nodig.
14. **Open deur alleen met klantenservice, nooit bij QR**: een klant moet zonder koppelcode kunnen schrijven, maar krijgt dan nooit tools en komt niet op de allowlist; bij WhatsApp via QR zou dat de eigen contacten van de eigenaar laten beantwoorden.
15. **QR-waarschuwing ook op de server**: de UI laat de waarschuwing vóór het formulier zien, maar de server weigert een nieuwe QR-koppeling zonder `riskAccepted`, zodat geen ander pad (oude app, script) eromheen kan.

## Beperkingen en handmatige voorwaarden

- Berichten komen alleen binnen zolang TeamBot draait (desktop: computer aan). Webhook-kanalen (WhatsApp Business, Slack Events, Telegram-webhook) hebben een **publieke HTTPS-URL** nodig: `TEAMBOT_PUBLIC_URL` of per koppeling een tunnel-URL (Cloudflare Tunnel, Tailscale Funnel, eigen server).
- **WhatsApp Business** vereist een Meta-bedrijfsaccount, een app, een eigen nummer (of het testnummer) en een permanente token; vrije antwoorden alleen binnen 24 uur na het laatste bericht van iemand (anders sjablonen, niet ingebouwd). Meta kan kosten rekenen en staat alleen bots toe die klanten van het eigen bedrijf helpen.
- **Klantenservice-controle** is bewust streng en lexicaal: een juist antwoord dat anders verwoord is dan de kennis (ander getal-formaat dan herkend, geen enkel woord gemeen met de bron) gaat naar de eigenaar in plaats van naar de klant; een onjuist antwoord dat alle getallen en woorden uit de kennis hergebruikt kan er in theorie doorheen (de bot krijgt dezelfde regels, en geld/beloftes wachten altijd op goedkeuring). Getallen in woorden (“dertig dagen”) worden niet herkend. De berichten aan klanten (AI-label, doorzetten) gaan via `trUser` in de taal van de eigenaar, niet in die van de klant.
- **Outlook.com/Hotmail**: Microsoft heeft wachtwoord-login (basic auth) in september 2024 uitgezet; Microsoft 365 meestal ook. OAuth2 voor IMAP is niet ingebouwd. Werkt alleen als de beheerder basic auth toestaat; alternatief: doorsturen naar Gmail/TransIP.
- Verzonden mail wordt niet in “Verzonden” opgeslagen (Gmail doet dat zelf bij SMTP).
- Slack: geen typindicator; in kanalen alleen bij @vermelding. Discord: in servers alleen bij @vermelding.
- Spraakberichten worden uitgeschreven met de spraakherkenning uit Instellingen › Spraak (of een engine via `setTranscriber`); zonder engine krijgt de bot het audiobestand + een notitie.
- **WhatsApp (QR)** is onofficieel: WhatsApp kan het protocol wijzigen (dan is een update van whatsapp-web.js nodig) en kan een nummer blokkeren, ook voorgoed. TeamBot en een Chromium-browser moeten draaien. Geen knoppen (goedkeuren met `/ja CODE`). Stickers sturen kan niet (`node-webpmux` is bewust vervangen, zie `packages/node-webpmux-stub`). Live getest tot en met de QR-code (`WA_QR_ONLY=1`); koppelen + berichten met een echte telefoon nog niet.
- Groepskoppelingen gebruiken de rooms-module defensief (`ctx.services.rooms.get/list` of tabel `rooms`); wie in een groep antwoordt beslist die module. De CLI-regel (chatmodus/weigeren) werkt alleen voor koppelingen met één bot.
- De native iPhone-app toont vastgehouden klantantwoorden nog niet in zijn eigen *Wacht op jou* (de PWA wel); de melding komt wel.
- Een kanaal heeft geen eigen teamkeuze: het volgt zijn bot of groep. Wil je een kanaal in een ander team, koppel het
  dan aan een bot van dat team.
- Echte diensten zijn niet live getest (geen tokens gebruikt); Telegram, Slack (Events API) en WhatsApp zijn getest tegen lokale nep-API-servers met de officiële berichtformaten, e-mail met echte MIME-berichten en nodemailer.
- Tests: `tests/channels.test.ts` (kader en adapters), `tests/channels-cli.test.ts` (CLI-bots), `tests/whatsapp-web.test.ts`, `tests/channels-health.test.ts` (nooit *Verbonden* zonder bewijs, test met code, exacte redenen, QR-bevestiging, Telegram eerst) en `tests/channels-customer.test.ts` (doorzetten, goedkeuring met aanpassen, AI-label, volledig uitgaand logboek, open deur, de controle zelf). Per team: de probes in `tests/teams-isolation.test.ts` (zie `docs/modules/teams.md` › Tests).
