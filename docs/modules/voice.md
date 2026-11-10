# Module `voice` — Spraak

Dicteren, voorlezen per bot, spraakmemo’s met ondertiteling, een **gratis gesprek** met elke bot of een hele groep en
live praten met OpenAI Realtime (WebRTC, betaald) in twee modi. In een gesprek praat je op de pc standaard door de
**spatiebalk of de knop ingedrukt te houden** (handsfree kan ook), zie je altijd **welke bot luistert, nadenkt of
spreekt** (naam en gezicht, ook met meerdere bots), praat je met **dezelfde bot en hetzelfde model als in de chat** en
spreekt een bot **zijn eigen taal** (een Nederlandse bot met een Nederlandse stem). **Standaard is alles gratis en lokaal**: spraakherkenning (Parakeet v3
of Whisper turbo via sherpa-onnx) en voorlezen (Piper-stemmen, en voor Pools en Portugees VITS-stemmen die
sherpa-onnx in TeamBot zelf draait) gebeuren op de pc; de telefoon stuurt zijn microfoonaudio naar de pc en speelt de
stem van de pc af. Modellen worden pas gedownload als je erom vraagt (met voortgang en SHA-256-controle). Een lokale
stem voor 10 van de 11 talen van de app; Arabisch leest de browser-/systeemstem. Plan: §4 (Live spraak), §15
(mic-regels), §20 (MausBot/Bloks/Grok voice), §21.9, §25 punt 7; pariteit OpenBot (dicteren ±1.400× per dag).
Documentatie en prijzen van OpenAI gecontroleerd op **2026-11-06**; `opus-decoder` (MIT, met
`@wasm-audio-decoders/common` MIT, `@eshaz/web-worker` Apache-2.0, `simple-yenc` MIT) op **2026-11-07**; licenties
van de lokale modellen op **2026-11-08**.

## Wat werkt (per catalogusregel §21.9)

| Regel | Status | Waar |
|---|---|---|
| P0 push-to-talk/dicteren (desktop + telefoon) | ✅ ingedrukt houden (loslaten = klaar, naar links schuiven = annuleren), tikken met knoppen Annuleren / Als memo / Klaar, of **Ctrl+Spatie ingedrukt houden**; zichtbare opname-indicator met timer en niveau; met de lokale engine **live tekst tijdens het praten** en leestekens | `Dictate.tsx` (composerAction) |
| P0 gratis lokale spraakherkenning | ✅ standaard; Parakeet TDT 0.6B v3 (25 talen, leestekens) of Whisper large-v3 turbo; **het model volgt de dicteertaal** (Turks of Arabisch dicteren → Whisper, ook in een Nederlandse app) en Instellingen › Spraak zegt welk model die taal dicteert; 16 kHz-PCM via de gewone API (ook vanaf de telefoon); audio wordt niet bewaard en gaat niet naar internet | `local/*`, `settings.ts`, `capture.ts`, `localstt.ts` |
| P0 gratis lokaal voorlezen | ✅ standaard; een lokale stem voor **10 van de 11 talen**: Nederlands (Alex, MLS), Engels (LJ, Norman), Duits en Frans (MLS-sprekers), Spaans (Carl), Italiaans (Riccardo), Portugees (Common Voice), Pools (M-AILABS), Turks (Antalia) en Oekraïens (Lada, Tetiana, Mykyta); Arabisch: browser-/systeemstem (geen vrije stem, zie *Lokale modellen*). De stem volgt de taal van de app en **de taal van de tekst** (een Duits antwoord leest de Duitse stem als die gedownload is). Zin voor zin gestreamd naar Web Audio, daarna gecachet; **automatisch voorlezen begint al na de eerste zin terwijl de bot nog schrijft** | `local/piper.ts`, `local/vits.ts`, `numbers.ts`, `player.ts`, `follow.ts`, `ui/src/modules/voice/language.ts` |
| P0 gratis gesprek met elke bot | ✅ om de beurt: lokale STT → de bot zelf (elke engine, ook Claude Code/Codex/OpenCode; zijn tools, delegatie en goedkeuringen) → lokale stem, **die al praat terwijl de bot nog schrijft**. Op de pc standaard **ingedrukt houden om te praten** (spatiebalk of de grote knop; loslaten = klaar, een pauze om na te denken beëindigt je beurt niet, indrukken terwijl de bot praat onderbreekt hem); op de telefoon standaard **handsfree** (VAD, een pauze beëindigt je beurt, **onderbreken door te praten** zonder je eerste woorden kwijt te raken). Eén schakelaar *Handsfree* in het belscherm (onthouden) en één keuze *Praten* in Instellingen › Spraak. Vertraging zichtbaar (“eerste klank na …”) | `halfduplex-core.ts`, `talk.ts`, `TalkUI.tsx`, `LiveCall.tsx`, `follow.ts`, `preroll.ts` |
| P0 gratis live gesprek (full duplex) | ✅ 0.4.4: tegelijk praten en luisteren op je eigen pc, zonder sleutel: één audio-WebSocket (`/ws/voice`), Silero VAD, Smart Turn v3.2 ("ben je klaar?"), Parakeet, de bot zelf als brein (gewone run), Piper zin voor zin; **onderbreken door te praten** (de bot stopt meteen, in de chat blijft alleen wat je hoorde); de bot kan **zelf ophangen** (`end_call`, eerst afscheid). Eerste klank gemeten ≈ 1,1 s na je zin (zie *Gratis live gesprek*) | `duplex/*`, `DuplexCall.tsx`, `duplex.ts` |
| P0 wie luistert, denkt na, spreekt | ✅ het belscherm zegt het steeds in woorden naast naam en gezicht: “Ada luistert naar je”, “Ada denkt na…”, “Ada spreekt”, “Ada wacht op je goedkeuring”, of “Houd de spatiebalk of de knop ingedrukt om te praten”; het gezicht krijgt een ring en een woord. In een groepsgesprek per bot (“Bo denkt na”, “Ada spreekt”) plus één regel voor de groep (“De groep luistert naar je”, “Bo en Cas denken na…”) | `indicator.ts`, `TalkUI.tsx`, `GroupCall.tsx` |
| P0 echo-onderdrukking | ✅ elke microfoon met `echoCancellation`, `noiseSuppression`, `autoGainControl` (`mic.ts`); zegt de browser dat echo-onderdrukking uit staat, dan staat onderbreken door te praten uit (met uitleg). Plus een **eigen-stemfilter** bij handsfree: de detector kent het niveau van de stem die de pc zelf afspeelt en telt die echo nooit als jou (mini-ADR 16); bij ingedrukt houden telt de microfoon alleen terwijl je de toets vasthoudt | `mic.ts`, `vad.ts`, `player.ts#outputLevel` |
| P0 hetzelfde model als in tekst | ✅ een gesproken beurt is een gewone run van de bot: zelfde model, instructies, tools en denkniveau (getest); het belscherm toont “Model: … , hetzelfde als in de chat” en elk antwoord geeft zijn model terug. Live (Realtime) start standaard in *Bot bedienen* (de echte bot antwoordt); *Direct praten* zegt dat dan een ander model antwoordt | `calls.ts#runResult`, `settings.ts`, `LiveCall.tsx` |
| P0 taal per bot | ✅ heeft een bot een vaste taal (bot-editor › Taal, of jouw keuze voor alle bots), dan leest een stem voor díe taal voor, ook in een andere app-taal (een Nederlandse bot: Alex, een Nederlandse stem) en herkent het gesprek met die bot die taal (Turkse bot → Whisper); de bot-editor zegt welke stem hij krijgt. Arabisch: de systeemstem (geen vrije lokale stem) | `tts.ts#botVoice`, `stt.ts#sttSettingsForBot`, `AgentVoice.tsx` |
| P0 dicteren in elk programma (desktop-app) | ✅ globale sneltoets (standaard **Ctrl+Alt+Spatie**, instelbaar; uit tot je hem aanzet): ingedrukt houden = praten, loslaten = tekst in het programma met de focus; kort tikken = handsfree tot je nogmaals tikt; **Esc** annuleert; werkt ook met TeamBot in het systeemvak. Klein opnamebalkje met live tekst; plakken via klembord + Ctrl+V, oude klembord terug; nooit in wachtwoordvelden | `desktop/dictation*.ts`, `dictation.ts`, `hotkey.ts` |
| P0 spraakberichten uit kanalen | ✅ WhatsApp/Telegram sturen Ogg/Opus: lokaal gedecodeerd naar 16 kHz en gratis uitgeschreven; de bot krijgt de tekst en antwoordt | `local/opus.ts`, kanalen-`voiceTranscriber` |
| P0 modellen beheren | ✅ downloaden bij eerste gebruik (voortgang, hervatten, SHA-256, verwijderen), alleen eigenaar/beheerder; licentie en grootte zichtbaar | `local/models.ts`, `LocalModels.tsx` |
| P0 transcript bewerken vóór verzenden | ✅ transcript komt in het tekstvak; memo: bewerkbaar transcript in voorvertoning | `Dictate.tsx` |
| P0 tekst-naar-spraak per bot | ✅ stem/model/snelheid/stijl per bot, luidspreker onder elk botantwoord, optioneel automatisch voorlezen | `AgentVoice.tsx`, `MessageVoice.tsx` |
| P0 dempen/stoppen, opname-indicator | ✅ dempen, onderbreken, ophangen; “mic aan/uit” altijd zichtbaar | `LiveCall.tsx` |
| P0 spraakbijlagen met transcript/ondertiteling | ✅ memo = audio-bijlage + transcript; “Meelezen” met meelopende zinnen, `.vtt`-download; echte tijden bij `whisper-1`, anders geschat (zo gelabeld) | `MessageVoice.tsx`, `/voice/clips/*` |
| P0 spraakprovider configureren | ✅ Instellingen › Spraak (STT/TTS/Realtime, taal, modellen) | `Settings.tsx` |
| P0 API-kosten vooraf | ✅ schatting per minuut vóór de start, live teller, prijsplafond met waarschuwing bij 80 % en ophangen bij 100 % | `catalog.ts`, `calls.ts` |
| P0 terugval naar tekst | ✅ bij fout: melding + “Verder in tekst” of “Bellen zonder Realtime” | `LiveCall.tsx` |
| P0 AI-identiteit melden | ✅ in instructies (“je bent een AI, stem is AI”), badge “AI” en tekst in het belscherm | `realtime.ts`, `LiveCall.tsx` |
| P1 OpenAI Realtime WebRTC | ✅ kortlevend client-secret (120 s) via server; browser ↔ OpenAI direct | `realtime.ts` (server + UI) |
| P1 onderbreken/VAD | ✅ semantische of stilte-VAD met barge-in; knop Onderbreken (`response.cancel` + `output_audio_buffer.clear`); energie-VAD in de browser voor bellen zonder Realtime | |
| P1 bestaande bot aansturen | ✅ modus “Bot bedienen”: functie `ask_agent` zet het verzoek in de echte thread, normale run/Broker/goedkeuringen, antwoord terug | `calls.ts#askAgent` |
| P1 gesprekshistorie / actielog | ✅ tabel `voice_calls`, verslag in de chat (duur, kosten, aantal verzoeken), geschiedenis in Instellingen en `#/m/voice` | |
| P1 stem per bot, lokale TTS | ✅ elke lokale stem (+ spreker) per bot, ook een stem in een andere taal dan de app; browserstem (gratis) en elke OpenAI-compatibele `/audio/speech`-server | `AgentVoice.tsx` |
| P1 groepsgesprek/beurtwisseling op naam | ✅ microfoonknop in de kop van een groepsgesprek; naam vooraan = die bot (ook half verstaan, met een vraag bij twijfel); elk antwoord met de stem van die bot; per bot zichtbaar wie luistert, nadenkt en spreekt (zie *Groepsgesprek* onderaan) | `GroupCall.tsx`, `names.ts`, `indicator.ts` |
| P1 vergadernotities met systeemrechten | ❌ niet gebouwd (vereist systeemaudio-opname + toestemmingsflow; buiten scope van deze module) |
| Acceptatie: sleutel alleen op server | ✅ test bewijst dat de vaste sleutel nooit in antwoorden staat |
| Acceptatie: mic nooit standaard/achtergrond | ✅ mic pas na tik; dicteren stopt als de app verborgen is. Een **gesprek** (0.4.4, wens eigenaar): op de pc loopt het door als het venster verborgen is (systeemvak, venster dicht; Electron zonder `backgroundThrottling`), de balk bovenin zegt “mic aan”; op een telefoon pauzeert het als de app verborgen is en gaat het vanzelf verder zodra de app weer open is |
| Acceptatie: transcriptretentie, wie ontvangt audio | ✅ instelbaar per gesprek + standaard; elke opname/het belscherm noemt de ontvanger |

## Dataflow

```
Dicteren / memo      browser MediaRecorder ──raw audio──▶ POST /api/voice/transcribe ──multipart──▶ {provider}/audio/transcriptions
                     (of Web Speech API in de browser)            │ memo: bestand in data/attachments + voice_clips
                                                                  └─▶ transcript terug → tekstvak / memo-voorvertoning

Voorlezen            POST /api/voice/speak {messageId} ─▶ cache (data/voice/tts/<user>/) of {provider}/audio/speech
                     (browserstem: server geeft schone tekst terug, speechSynthesis leest lokaal voor)

Live (Realtime)      1. tik → getUserMedia
                     2. POST /api/voice/realtime/session ─▶ server: POST api.openai.com/v1/realtime/client_secrets
                        (vaste sleutel + sessieconfig: model, stem, instructies, VAD, transcriptie, tools)
                        ◀── alleen { clientSecret (ek_…, 120 s), rtcUrl, schatting, plafond }
                     3. browser ──SDP + Bearer ek_…──▶ api.openai.com/v1/realtime/calls ; audio via WebRTC-tracks,
                        events via datakanaal "oai-events"
                     4. browser meldt usage/transcriptregels ─▶ POST /api/voice/calls/:id/events (server prijst zelf)
                     5. modus "Bot bedienen": functie ask_agent ─▶ POST /api/voice/calls/:id/ask
                        ─▶ bericht in echte thread ─▶ RunManager/Runner/Broker (goedkeuringen) ─▶ antwoord ─▶ function_call_output
                     6. ophangen ─▶ POST /api/voice/calls/:id/end (transcript in chat als bewaren aan, verslag, usage_log)

Bellen zonder        energie-VAD ─▶ opname ─▶ /voice/transcribe ─▶ POST /voice/calls/:id/turn (zelfde brug, gewone berichten)
Realtime             ─▶ /voice/speak (stem van de bot) ─▶ weer luisteren

Lokaal dicteren      AudioWorklet (pcm-worklet.js) ─16 kHz PCM, elke 350 ms─▶ POST /voice/stt/stream/:id ─▶ DictationSession
(ook telefoon)          stukken tot een pauze (≥ 6 s open) worden één keer herkend → definitief; de rest af en toe
                        opnieuw → live tekst ◀── { text }        stoppen: POST …/end ─▶ alleen het laatste stuk herkennen

Lokaal voorlezen     POST /voice/speak ─▶ { engine: 'local', stream } ─▶ GET /voice/tts/:id/pcm (16-bit PCM, zin voor zin
                        uit een warm Piper-proces, of uit sherpa-onnx in TeamBot zelf voor de VITS-stemmen; die krijgen
                        getallen eerst in woorden) ─▶ Web Audio; klaar → WAV in de cache (opnieuw afspelen kost niets)

Gratis gesprek       PcmCapture ─┬ ingedrukt houden (pc): spatiebalk/knop omlaag ─▶ opname (200 ms ervoor) ─▶ los + 250 ms
                                 └ handsfree (telefoon): energie-VAD ─▶ opname tot een pauze
                        ─▶ WAV ─▶ /voice/transcribe?callId (lokaal; taal en model volgen een bot met vaste taal)
                        ─▶ /voice/calls/:id/turn {speak: true}
                        ─▶ de bot (gewone run: eigen model, Broker) ─┬▶ message.delta ─▶ zinnensplitser ─▶ Piper per zin ─▶ /voice/tts/:id/pcm
                                                                     └▶ antwoord in de chat (zoals altijd, met het model eronder)
                        terwijl de bot praat: ingedrukt houden → alleen de toets onderbreekt; handsfree → de VAD luistert
                        met een hogere drempel en het eigen-stemfilter (niveau van wat de pc afspeelt): jij praat → afspelen
                        stopt (de stemtaak stopt ook), opname loopt vanaf waar je begon te praten (pre-roll tot 2,5 s)

Lezen terwijl de bot  bericht verschijnt (streaming) ─▶ POST /voice/speak/run {runId} ─▶ zelfde live stemtaak ─▶ Web Audio
schrijft (voorlezen)    (helemaal voorgelezen antwoord komt in de cache: opnieuw afspelen kost niets)

Spraakbericht uit     kanaal (WhatsApp/Telegram, Ogg/Opus) ─▶ services.voice.transcribe ─▶ Ogg-demuxer + opus-decoder (wasm)
kanaal                  ─▶ 16 kHz ─▶ Parakeet/Whisper ─▶ “[Spraakbericht, automatisch uitgeschreven …]” in het bericht aan de bot

Sneltoets (desktop)   Ctrl+Alt+Spatie (globaal) ─▶ hulpprogramma: focus = wachtwoordveld? ─▶ opnamebalkje (eigen venster, neemt
                        nooit de focus) opent de microfoon ─16 kHz PCM via IPC─▶ services.voice.openDictation (dezelfde live
                        dicteersessie) ─▶ loslaten/nogmaals tikken ─▶ tekst ─▶ klembord + Ctrl+V (na loslaten van alle
                        toetsen, opnieuw gecontroleerd) ─▶ oude klembord terug na 0,45 s (beide buiten de
                        klembordgeschiedenis Win+V en het cloudklembord)
```

## API-routes (`/api/...`, allemaal ingelogd, alleen eigen data)

| Methode | Pad | Doel |
|---|---|---|
| GET/PUT | `/voice/settings` | instellingen + status (“wat werkt”) + catalogus met prijzen; PUT valideert providers (Realtime alleen `openai`) |
| POST | `/voice/transcribe?threadId&save=1&durationMs&callId` | ruwe audio (≤ 25 MB, mime + magic bytes gecontroleerd) → transcript; `save=1` bewaart als memo |
| GET | `/voice/clips?ids=` · `/voice/clips/:id` · `/:id/vtt` · `/:id/audio` | memo-info, WebVTT, audio met range-requests (iOS) |
| DELETE | `/voice/clips/:id` | audio van eigen memo verwijderen (transcript blijft) |
| GET | `/voice/local` | lokale modellen: status, voortgang, grootte, licentie, platform, engine van elke stem (`voiceEngine`), of Piper en de VITS-engine hier werken |
| POST/DELETE | `/voice/local/models/:id/install` · `…/cancel` · `/voice/local/models/:id` | downloaden (een Piper-stem haalt Piper mee, een VITS-stem niet), stoppen, verwijderen — alleen desktop-eigenaar of beheerder (sinds 0.4.2 ook vanaf hun gekoppelde telefoon) |
| POST | `/voice/stt/stream` · `/voice/stt/stream/:id` · `…/:id/end` · DELETE `…/:id` | live dicteren met de lokale engine: openen, 16 kHz-PCM toevoegen (→ tekst tot nu toe), afronden, annuleren |
| POST | `/voice/speak` | `{messageId}` of `{text, agentId, override}` (voorbeeld) → cache-id, lokale stream of browsertekst |
| POST | `/voice/speak/run` | `{runId}` → live stemtaak die het antwoord voorleest terwijl de bot schrijft (`stream`), of `stream: null` (andere stem of instelling uit: lees het af antwoord voor) |
| GET | `/voice/tts/:id/pcm` | lokale stem als 16-bit PCM (`x-sample-rate`), gestreamd terwijl Piper bezig is |
| GET | `/voice/tts/:id` | gecachte audio (alleen eigenaar) |
| GET/DELETE | `/voice/tts-cache` | statistiek / leegmaken |
| POST | `/voice/cleanup` | bewaartermijnen nu toepassen |
| POST | `/voice/realtime/session` | client-secret + gespreksrecord (eigen bot; thread moet bij die bot horen) |
| POST | `/voice/gemini/session` | Gemini Live: tijdelijk token (één keer bruikbaar) + WebSocket-adres + setup (instructies, tools) + gespreksrecord; de Google-sleutel blijft op de server |
| POST | `/voice/calls/:id/tool` | `{name, args, heard}`: een tool van de stem in de cloud (`ask_agent`, `ask_team`, `ask_bot`, `task_status`, `approve`, `end_call`); `heard` = jouw laatste zin uit de spraakherkenning |
| GET | `/voice/calls/:id/tasks` | taken die dit gesprek aan bots gaf: status, antwoord, open goedkeuring |
| POST | `/voice/calls` | bellen zonder Realtime starten |
| GET | `/voice/duplex` | gratis live gesprek: klaar of niet (met reden), de twee gespreksonderdelen met licentie, grootte en voortgang |
| POST | `/voice/duplex/install` | de gespreksonderdelen downloaden (alleen na de tik, desktop-eigenaar of beheerder) |
| POST | `/voice/duplex/calls` | gratis live gesprek starten (409 `voice_duplex_missing` met reden als iets ontbreekt) → `{ call, socket: '/ws/voice?call=…' }` |
| WS | `/ws/voice?call=…` (gesigneerd zoals `/ws`) | audio heen (16 kHz PCM) en terug (4 bytes antwoordnummer + 16-bit PCM), plus JSON-berichten (zie *Gratis live gesprek*) |
| GET | `/voice/calls`, `/voice/calls/:id` | geschiedenis / verslag (transcript alleen als bewaard) |
| POST | `/voice/calls/:id/events` · `/ask` · `/turn` · `/end` | usage/transcript, brug naar bot, beurt (`speak: true` = meteen terug met de live stem, `speech`), ophangen (idempotent; ook via `sendBeacon`) |
| GET | `/voice/calls/:id/runs/:runId` | resultaat van een verzoek dat nog liep (bijv. wachtte op goedkeuring) |
| DELETE | `/voice/calls/:id` | verslag verwijderen |

Tools: `end_call` (groep `voice-call`, risico `read`) alleen voor een bot die nú in een gratis live gesprek zit; verder **geen** agent-tools. `ask_agent` is een Realtime-functie die alleen de browser van de gebruiker kan aanroepen;
de uitvoering loopt via een gewoon bericht + run, dus via dezelfde Broker en goedkeuringen als typen.

Dienst voor andere modules: `ctx.services.voice.{settings, transcribe(userId, buf, mime), speak(userId, text, agentId), openDictation(userId), exportUser}`
(kanalen schrijven er spraakberichten mee uit, ook Ogg/Opus met de lokale engine; een onbekend/algemeen bestandstype wordt
uit de inhoud bepaald; de desktop-schil dicteert er met de sneltoets mee). De desktop-schil zet `ctx.services.voiceHotkey.status()`;
`GET /voice/settings` geeft die terug als `hotkey` (alleen in de desktop-app `available: true`). Hook `turnContext`: ingesproken berichten krijgen per beurt de
notitie dat het een transcript is (live: “houd het kort en uitspreekbaar”).

## Tabellen (migraties `voice-001`, `voice-002`: `voice_calls.ended_by`, `end_reason`, `summary`)

- `voice_tts` — cache van voorgelezen audio: user, message, agent, hash (provider/model/stem/snelheid/stijl/tekst), pad, kosten, `last_used_at`.
- `voice_clips` — spraakmemo’s: `attachment_id` (PK), transcript, segmenten, tijdsoort (`real`/`estimated`), model, provider, kosten, `audio_deleted`.
- `voice_calls` — gesprekken: soort (`realtime`/`halfduplex`), modus, model, stem, status, `keep_transcript`, transcript (alleen bij bewaren), usage, kosten, plafond, aantal verzoeken, duur, fout.

Kosten komen ook in de gedeelde `usage_log` (zichtbaar in Instellingen › Kosten) en tellen mee voor de daglimiet.

## Events

`voice.call.updated` (gespreksrecord), `voice.settings.updated`. Audit: `voice.settings.updated`, `voice.call.started`,
`voice.call.ended`, `voice.call.deleted`, `voice.clip.audio_deleted`, `voice.tts_cache.cleared`.

## Kosten (server-side allowlist, `catalog.ts`, gecontroleerd 2026-11-06)

| Onderdeel | Model (standaard vet) | Prijs |
|---|---|---|
| Live praten | **gpt-realtime-2.1-mini** · gpt-realtime-2.1 · gpt-realtime-2 · gpt-realtime-mini · gpt-realtime | mini: audio $10 in / $0,30 cached / $20 uit; tekst $0,60 / $0,06 / $2,40 per 1M tokens. 2.1: audio $32 / $0,40 / $64; tekst $4 / $0,40 / $24 |
| Schatting per minuut | (helft jij, helft AI; laag = cache-hits, hoog = geen cache) | mini ≈ $0,02–0,05; 2.1 ≈ $0,05–0,15 |
| Ondertiteling live | **gpt-4o-mini-transcribe** ($0,003/min) · gpt-live-transcribe ($0,017/min) · gpt-realtime-whisper | |
| Dicteren/memo | **gpt-transcribe** ($0,0045/min) · gpt-4o-mini-transcribe · gpt-4o-transcribe · whisper-1 | |
| Voorlezen | **gpt-4o-mini-tts** (≈ $0,015/min) · gpt-realtime-2.1-mini via Realtime (≈ $0,027/min) · tts-1 ($15/1M tekens) · tts-1-hd ($30/1M) | |

De browser stuurt alleen ruwe tokentellingen; de server rekent met deze lijst (geen prijzen van de client). Modellen
buiten de lijst worden geweigerd. Aangekondigde uitfaseringen staan in de lijst: TTS-modellen stoppen bij OpenAI op
**2027-01-06**, `whisper-1`/`gpt-4o-(mini-)transcribe` op **2027-02-26**; daarna schakelt de server automatisch over
(TTS → `gpt-realtime-2.1-mini` via de Realtime-WebSocket, STT → `gpt-transcribe`, live-ondertiteling → `gpt-live-transcribe`).

## Lokale modellen (gratis; `local/catalog.ts`, licenties gecontroleerd 2026-11-08)

Alles vastgepind op een exacte upstream-revisie met SHA-256 (voor de nieuwe stemmen ook vergeleken met de LFS-sha256
van Hugging Face); opgeslagen in `<dataDir>/voice/models/<id>/`. Niets hiervan zit in de installer en niets wordt
gedownload zonder dat de gebruiker op *Downloaden* klikt. Grootte, licentie en een link naar de modelkaart staan bij
elk onderdeel in Instellingen › Spraak.

| Onderdeel | Licentie (eigen modelkaart) | Download | Gemeten op deze pc (Ryzen 7 7800X3D, 8 threads) |
|---|---|---|---|
| **Parakeet TDT 0.6B v3** int8 (NVIDIA; ONNX van sherpa-onnx) — standaard | CC-BY-4.0 | 670 MB | 10 s spraak → 0,48 s (max 0,86 s), RTF 0,048; laden 1,5 s. FLEURS-nl (80 echte opnamen): WER 11,5 % (strenge normalisatie, cijfers tellen als fout) |
| Whisper large-v3 turbo int8 (OpenAI; ONNX van sherpa-onnx) | MIT | 1,04 GB | 10 s → 2,6 s (RTF 0,26); FLEURS-nl (20 opnamen) WER 8,9 % tegen 11,9 % voor Parakeet op dezelfde 20 |
| Piper 2023.11.14-2 (programma; Windows x64, Linux x64/arm64) | MIT (+ espeak-ng GPL-3.0, apart programma) | 22 MB | eerste zin na 53 ms als Piper warm is, 0,9-1,2 s koud; RTF ≈ 0,035 |
| Stem Alex `nl_NL-alex-medium` — standaard | CC0 (dataset) | 64 MB | stem → Parakeet: WER 6,3 % schoon, 3,6 % met ruis/galm |
| Stem MLS `nl_NL-mls-medium` (5 gekozen sprekers van 52) | CC-BY-4.0 | 77 MB | beste sprekers 2-5 % WER in dezelfde rondgang; slechtste 28 % (niet aangeboden) |
| Stemmen LJ / Norman (Engels, voor Engelstalige antwoorden) | public domain | 64 MB elk | |
| Stem MLS `de_DE-mls-medium` (5 gekozen sprekers van 236) | CC-BY-4.0 | 77 MB | stem → Parakeet, 6 zinnen: gekozen sprekers 2-5 % WER (gemiddeld alle sprekers 9,6 %) |
| Stem MLS `fr_FR-mls-medium` (5 gekozen sprekers van 125) | CC-BY-4.0 | 77 MB | gekozen sprekers 3-7 % WER (gemiddeld 14 %) |
| Stem Carl `es_ES-carlfm-x_low` | public domain | 28 MB | 6 % WER (16 kHz, x-low) |
| Stem Riccardo `it_IT-riccardo-x_low` (M-AILABS: LibriVox, public domain) | public domain | 28 MB | 9 % WER (16 kHz, x-low) |
| Stem Common Voice `pt-cv-vits` (Portugees, man; Coqui-model van NeonGecko, ONNX van sherpa-onnx; [modelkaart](https://huggingface.co/neongeckocom/tts-vits-cv-pt)) | BSD-3-Clause (data: Mozilla Common Voice, CC0) | 71 MB | stem → Parakeet, 8 zinnen: 8-9 % WER (13,8 % met de standaardruis; Whisper 12,6 %). Eerste klank 0,75-0,83 s koud (stem laden ≈ 0,7 s), 0,15-0,18 s warm; RTF ≈ 0,035 |
| Stem M-AILABS `pl_PL-mai_female-vits` (Pools, vrouw; NeonGecko / sherpa-onnx; [modelkaart](https://huggingface.co/neongeckocom/tts-vits-mai-pl)) | BSD-3-Clause (data: M-AILABS, LibriVox) | 71 MB | stem → Parakeet, 8 zinnen: 12-20 % WER (15,2 % met de standaardruis). Eerste klank 0,73-0,81 s koud, 0,12-0,17 s warm |
| Stem Antalia `tr_TR-antalia-medium` (Turks, vrouw; Piper; [modelkaart](https://huggingface.co/ozgurguler/piper-tr-antalia-medium)) | CC-BY-4.0 (data: Antalia-corpus van Patientdesk.ai, CC-BY-4.0, een stemactrice met toestemming; verder getraind op Pipers LJ Speech-checkpoint, public domain) | 64 MB | stem → Whisper, 8-12 zinnen: 10-16 % WER (21 % met de standaardruis). Eerste klank 0,55-0,66 s koud, ≈ 0,1 s warm |
| Stem `uk_UA-ukrainian_tts-medium` (Lada, Tetiana, Mykyta) | CC0 (dataset) | 77 MB | 0 % WER op 3 zinnen per spreker; spreekt cijfers niet uit (tekst-fonemen) |

**Per taal** (`recommendedSttId`/`recommendedVoices`, de instellingen tonen dit bovenaan): spraakherkenning Parakeet
voor alle talen van de app behalve Turks en Arabisch (die kent Parakeet niet) → Whisper turbo. Het automatische model
volgt de **dicteertaal**: een vaste taal, anders de voorkeurstaal van een automatische keuze (`auto-tr`), anders de taal
van de app (`sttModelLanguage`). Tot 2026-11-08 volgde het de taal van de app, zodat Turks dicteren in een
Nederlandse app op Parakeet uitkwam. Instellingen › Spraak zegt welk model de gekozen taal dicteert (“Voor het Turks
gebruikt TeamBot Whisper large-v3 turbo.”), ook vóór het opslaan, en waarschuwt als een zelf gekozen model de taal niet
kent; die keuze blijft staan. Stemmen: één aanbevolen stem per taal (zie de tabel); Arabisch heeft er geen.

**Hoe de nieuwe stemmen gekozen zijn.** Gemeten als rondgang: stem → spraakherkenning voor die taal → WER, op
alledaagse zinnen zonder cijfers. Ter vergelijking haalden de bekende (niet toegestane, lessac-)Piper-stemmen op
dezelfde zinnen: Turks dfki 5,6 %, Pools gosia 7,6 %, Portugees faber 2,3 %. De nieuwe stemmen zijn dus goed te
verstaan maar minder natuurlijk; met minder ruis bij het samplen (`noise` 0,333/0,333 in de catalogus) halveerde hun
foutpercentage. De VITS-stemmen kennen geen cijfers (hun alfabet heeft ze niet): TeamBot schrijft getallen, tijden,
bedragen en percentages eerst uit in woorden (`numbers.ts`, Portugees en Pools; mini-ADR 20).

**Niet gekozen** (alles op de eigen modelkaart gelezen, 2026-11-08):
- Piper-stemmen in `rhasspy/piper-voices` (revisie `e7229f7`, op 2026-11-08 nog de nieuwste): pt_BR cadu, faber, jeff,
  pt_PT tugão, pl_PL darkman, gosia, mc_speech, bass (Apache-2.0, maar ook lessac), tr_TR dfki, ar_JO kareem zijn
  allemaal verder getraind op de “lessac”-stem (Blizzard 2013, alleen voor onderzoek); pt_BR edresson en
  pl_PL mls_6892 op “ryan” (CC-BY-NC-SA); tr_TR dfki heeft bovendien CC-BY-NC-SA-data en kareem alleen “See URL”.
  tr_TR fahrettin en fettah zijn uit piper-voices verwijderd.
- Community-stemmen: OpenVoiceOS miro/dii (pt-BR, pt-PT, ar-SA) CC-BY-NC-ND; Poolse wg_glos-stemmen (WitoldG) en Razo
  (pt-BR) verder getraind op lessac of de piper-voices; Folx `pl_multi`, `piper-tts-tr-ilkiz`, `piper_tts_turkish_*`,
  de Arabische zayd0 en emirati: geen of onduidelijke herkomst van de trainingsdata.
- Supertonic 3 (31 talen, het model achter de lokale stemmen van OpenBot): OpenRAIL-licentie met
  gebruiksbeperkingen, niet in de lijst van ADR 0004.
- Kokoro-82M (Apache-2.0, ook pt-BR) en Nabra-82M (Arabisch, Apache-2.0): hebben espeak-ng-fonemen nodig (Nabra ook een
  diacritiseerder); sherpa-onnx 2.x heeft geen espeak-ng meer en Piper levert geen los espeak-ng-programma, dus dat
  zou een nieuw GPL-hulpprogramma vragen. MMS-TTS: CC-BY-NC. Chatterbox, Qwen3-TTS: te zwaar voor de processor.
- Ook eerder al: Whisper small (WER 24 %; op de processor nauwelijks sneller dan turbo: 2,0 tegen 2,6 s per 10 s), rdh
  en it_IT-serena (fonemen van meer tekens die in die talen wél voorkomen).

**Arabisch** blijft zonder lokale stem: de browser-/systeemstem leest voor en Instellingen › Spraak zegt waarom (op
Windows kun je onder Instellingen › Tijd en taal › Spraak een Arabische systeemstem toevoegen).

Runtime: `sherpa-onnx-node` 2.0.1 (Apache-2.0, 8,8 MB voor win-x64, met onnxruntime MIT) is een gewone
npm-dependency, draait spraakherkenning én de VITS-stemmen en werkt in Electron 45 (getest: laden 1,4 s, 14 s spraak
in 0,55 s; voorlezen alleen met `enableExternalBuffer: false`, anders weigert Electron de buffer).

**Eind-tot-eind gemeten** (headless Edge met nepmicrofoon, echte modellen, `npm run voice:live`): dicteren met
achtergrondruis en galm → tekst bewerkbaar in het tekstvak **63-70 ms na “Klaar”** (het stuk tot de laatste pauze was al
herkend), WER 0 % op die zin; live tekst verscheen tijdens het praten. Stopt iemand midden in een zin, dan moet alleen
het laatste stuk (≤ 6 s) nog: ≈ 0,3 s. Losse opname via `/voice/transcribe`: 10 s → 0,42-0,55 s (koud 2,0 s incl.
laden). Gratis gesprek met een echte Claude Code-bot (haiku): herkenning 0,1 s · bot 3,0-4,0 s · eerste klank 0,1 s
(toen nog ná het hele antwoord); onderbreken door te praten werkte. Alle modellen downloaden (≈ 820 MB): 13 s op deze
verbinding.

**Voorlezen terwijl de bot schrijft** (`npm run voice:live`, echte Piper, een bot die schrijft als een echt model: 0,8 s
tot de eerste tekst, ±150 tekens/s, antwoord van 4 zinnen; bot klaar na 2,77 s): eerste klank **3,33 s → 1,15 s**
(mediaan van 3, vanaf het versturen van de beurt). Het hele antwoord wordt voorgelezen (12-13 s audio), onderbreken werkt.
Met dezelfde bot in het Portugees, Pools en Turks (stemmen van 2026-11-08, bot klaar na 2,2-2,4 s): eerste klank
1,26-1,36 s na het versturen van de beurt, het hele antwoord voorgelezen (9-11 s audio).

**Onderbreken zonder je eerste woorden te verliezen**: met de echte Nederlandse stem is de detector bij “Wacht even, ik heb
een andere vraag.” pas 1,36-1,46 s na “Wacht” zeker (zachte start + 340 ms pauze na de komma); de oude vaste pre-roll van
1 s miste “Wacht even” (ook gemeten in `npm run voice:live`: herkend als “Ik heb een andere vraag.”). Nu herkend als
“Wacht even, ik heb een andere vraag.”

**Spraakbericht uit een kanaal**: Ogg/Opus van 4,4 s decoderen 10-30 ms (eerste keer incl. laden van de decoder),
Parakeet 0,22 s; “Hoi, kun je morgen om tien uur de vergadering met Sanne in plannen? Dankjewel.”

**Sneltoets** (`npm run dictation:live`, echte Electron + pill + lokale herkenning + klembord/Ctrl+V in een eigen
testvenster): microfoon open **0,43 s** na de toets, tekst geplakt **0,38 s** na stoppen, WER 0 %; klembord (tekst +
opmaak) terug; Esc; wachtwoordveld herkend en geweigerd. De Windows-hulp start in 0,3 s (eerste keer ooit ±10-20 s: dan
compileert hij en bewaart de DLL).

## Ontwerpkeuzes (mini-ADR’s)

1. **Ephemeral client-secret i.p.v. “unified interface”.** De server staat dan niet in het mediapad en de vaste sleutel
   blijft op de server; het secret is 120 s geldig en gebonden aan de sessieconfig (model, instructies, tools) die de
   server kiest. `OpenAI-Safety-Identifier` = gehashte gebruikers-id.
2. **Realtime-API, nog niet GPT-Live.** OpenAI raadt sinds kort GPT-Live aan voor nieuwe spraakapps (andere handshake,
   per seconde gefactureerd, “client delegation”). De opdracht vraagt Realtime met client-secrets; de `ask_agent`-brug
   is zo gebouwd dat een GPT-Live-variant later dezelfde server-route kan gebruiken.
3. **Brug via gewone berichten.** `ask_agent` en bellen zonder Realtime plaatsen een gebruikersbericht (`parts.voice`)
   en starten een run met trigger `voice`. Daardoor gelden toegangsmodus, Broker, goedkeuringen, daglimiet en audit
   exact zoals bij typen. Goedkeuren kan alleen met een tik (ook in het belscherm), nooit met spraak.
4. **Transcript bewaren is een keuze per gesprek.** Uit = de server slaat geen transcriptregels op (de browser stuurt ze
   dan ook niet). In “Bot bedienen” staan de verzoeken en antwoorden altijd in de chat — dat is het werk zelf; dat staat
   in de UI.
5. **Providers hergebruiken.** STT/TTS gebruiken de bestaande providerconfiguraties (sleutels in Secrets). Een lokale
   Whisper/TTS-server voeg je toe als “Eigen endpoint (OpenAI-compatibel)”. Een expliciet gekozen provider wordt nooit
   stil vervangen door een andere (privacy: jij kiest wie de audio krijgt).
6. **SSRF.** In servermodus mag een gewone gebruiker met een eigen provider geen privé-adressen gebruiken
   (`assertPublicUrl`); desktopmodus, beheerders en door beheerders gedeelde providers wel. Geen redirects.
7. **Uploadcontrole.** Mime-allowlist + magic bytes (webm/ogg/mp4/mp3/wav/flac) moeten overeenkomen; max 25 MB (limiet
   van OpenAI). Dicteeraudio wordt na omzetten niet bewaard.
8. **TTS-cache per gebruiker** op hash van alle stemparameters + tekst: opnieuw afspelen kost niets. Opruimen na
   N dagen niet gebruikt en bij verwijderde berichten. Memo-audio kan na N dagen verwijderd worden (ook de kopie in de
   werkmap van de bot); het transcript blijft.
9. **Taal volgt de app; het spraakmodel volgt de dicteertaal.** Standaard “Automatisch (voorkeur: <taal van de app>)”
   (`auto-app`): `gpt-transcribe` krijgt `languages: [<taal>, en]` en namen (`TeamBot`, jouw naam, botnaam) als
   `keywords`; modellen met één taalveld en de live-ondertiteling krijgen de taal van de app; browserherkenning krijgt
   die locale. Lokaal: Parakeet herkent de taal zelf, Whisper ook (sherpa-onnx kan Whisper alleen één vaste taal
   opleggen; dat zou Engels tussendoor breken) — een vaste taal kiezen legt hem vast. Voor een Nederlandse app is dit
   precies het oude “Automatisch (Nederlands voorkeur)” (`auto-nl`); die opgeslagen waarde blijft geldig en betekent bij
   een andere app-taal nog steeds “Nederlands voorkeur”. Zonder hint hoorde het live-model in de rooktest Nederlands als
   Fries. Ook leeg = automatisch: `stt.localModel` is het aanbevolen (of een al gedownload passend) model voor de
   **dicteertaal** (`sttModelLanguage`: vaste taal, anders de voorkeurstaal, anders de taal van de app; Turks of
   Arabisch dicteren → Whisper, ook in een Nederlandse app) en `tts.localVoice` de stem voor de taal van de app (geen
   stem → browserstem met uitleg). `GET /voice/settings` geeft de opgeslagen keuzes plus `effective` (wat automatisch
   nu betekent, `stt.modelLanguage`, en wat bij de taal past); de instellingenpagina rekent dezelfde regel na op de nog
   niet opgeslagen keuze, zodat een andere dicteertaal meteen het passende model laat zien. Een zelf gekozen model
   blijft staan, ook als het de taal niet kent (de pagina waarschuwt). **Voorlezen kiest per tekst**: taal raden
   (schrift voor Arabisch en Cyrillisch, veelgebruikte woorden voor de rest; bij twijfel de gewone stem), dan een
   gedownloade stem voor die taal (Engels: de gekozen Engelse stem), anders de ingestelde stem; tekst in een schrift dat
   geen gedownloade stem kan lezen gaat naar de browserstem. Een bot met een eigen stem houdt die (behalve voor een
   ander schrift).
10. **Kostenbeheer.** Prijsplafond per gesprek (nooit boven wat er van de daglimiet over is), maximale duur, rate-limits
    (60 STT/TTS per minuut, 10 Realtime-sessies per minuut), kosten in `usage_log`.
11. **Standaard lokaal en gratis.** Nieuwe installaties gebruiken lokale STT, een lokale stem en het gratis gesprek.
    Zolang een model nog niet is gedownload, leest de gratis browserstem voor; er wordt nooit stil overgestapt op een
    betaalde provider. Bestaande expliciete keuzes blijven staan.
12. **sherpa-onnx 2.x in het serverproces, Piper als apart programma.** sherpa-onnx ≥ 2.0 bevat geen espeak-ng meer
    (Apache-2.0 + onnxruntime MIT) en draait Parakeet/Whisper met `createAsync`/`decodeAsync` buiten de event-loop.
    Piper-stemmen hebben espeak-ng (GPL-3.0) nodig voor de uitspraak; daarom start TeamBot het kant-en-klare Piper-
    programma als apart proces (warm per stem + snelheid + ruis, JSON-regels in, WAV-pad uit) en downloadt de gebruiker
    het bij de bron. TeamBot linkt en verspreidt dus geen GPL-code. Stemmen hebben een `voiceEngine`:
    - `piper` (standaard): het Piper-programma. Stemmen die met een nieuwere Piper zijn gemaakt kunnen fonemen van
      meer tekens in hun config hebben (de Turkse Antalia: de Engelse tweeklanken `aɪ`, `aʊ`, `ɔɪ`, `eɪ`, `oʊ`); Piper
      2023.11.14-2 weigert zo’n config. Omdat die build de uitvoer van espeak-ng toch per teken opzoekt, kan hij die
      fonemen nooit gebruiken: `piperConfig()` geeft Piper een kopie zonder die regels (`voice.piper2023.onnx.json`
      naast het gecontroleerde origineel, dat onaangeroerd blijft). Dat is alleen veilig voor een taal waarin espeak-ng
      ze nooit maakt (gecontroleerd voor Turks); it_IT-serena en rdh blijven daarom uit de catalogus.
    - `vits`: tekengebaseerde VITS-modellen (Coqui, ONNX van sherpa-onnx) draaien met sherpa-onnx in het serverproces
      (`VitsPool`: warm per stem, `generateAsync` buiten de event-loop, één zin tegelijk per stem, na 10 minuten
      ongebruikt weer vrij). Ze hebben geen fonemiseerder nodig, dus ook geen espeak-ng en geen apart programma; ze
      werken daardoor ook waar Piper niet werkt (macOS). Samples komen als JS-buffer terug (`enableExternalBuffer:
      false`): Electron weigert externe buffers (getest in Electron 45.2.3: zonder die vlag mislukt het voorlezen).
      Een VITS-stem downloadt Piper dus ook niet mee.
    Per stem kan de catalogus de ruis bij het samplen zetten (`noise`); voor de drie nieuwe stemmen is 0,333/0,333
    duidelijker dan hun eigen standaard (fouten in de rondgang ongeveer gehalveerd).
13. **PCM over de gewone API.** De browser neemt met een AudioWorklet 16 kHz-PCM op (werkt ook in iOS Safari) en post
    elke 350 ms een stukje naar `/voice/stt/stream/:id`; zo werkt het van de telefoon via de bestaande, geauthenticeerde
    verbinding en de mobiele allowlist, zonder extra WebSocket of codec. Memo’s, vergaderingen en gesprekken nemen in
    WAV op (gesprekken ook met een provider: alleen zo kan een onderbreking audio van vóór de detectie meenemen).
14. **Snel na stoppen.** Open stukken van ≥ 6 s worden bij een pauze afgesloten en één keer herkend; alleen het laatste
    stuk moet na “Klaar” nog. Het model blijft 15 minuten geladen en laadt al op de achtergrond zodra de microfoon opent.
15. **Downloads via `node:https`.** `fetch` haalde hier bij grote bestanden ±4 MB/s, `node:https` en curl 65-70 MB/s van
    dezelfde CDN. Hervatten met `Range`, controle met SHA-256, pas daarna op de plek; alleen eigenaar/beheerder.
16. **Onderbreken zonder echo-ruzie en zonder woorden te verliezen.** Terwijl de bot praat luistert de energie-VAD met
    een ≥ 3× hogere drempel en telt hij in de laatste seconde minstens 350 ms stem (de echo-onderdrukking van de browser
    haalt het meeste van de eigen stem weg, maar zet tijdens het door elkaar praten ook jóuw stem schokkerig zachter:
    gemeten in Edge viel ongeveer elke tweede stap van 50 ms onder de drempel; de oude regel "350 ms bijna aaneen" miste
    daardoor soms een korte "Wacht even, ik heb een andere vraag", B-52). Ook terwijl de bot nog stil is na je beurt
    (een trage engine denkt seconden voor de eerste zin) luistert hij zo mee; niet terwijl hij op jouw goedkeuring wacht.
    Zeg je na het onderbreken iets, dan stopt het onderbroken antwoord (`interrupt` in `/voice/calls/:id/turn`,
    `stopInterruptedAnswer`): wat de bot al schreef blijft in de chat als "Onderbroken: je begon te praten", en je nieuwe
    vraag wacht niet meer in de rij achter het oude antwoord. Alleen een run van dít gesprek die nog bezig is; een run die
    op goedkeuring wacht blijft staan. De beurtwisseling zelf staat zonder browserafhankelijkheden in
    `halfduplex-core.ts` en draait in de test 60 keer met nepmicrofoon, nepbot en nepklok
    (`tests/voice-call-bargein.test.ts`; met de oude detector gingen daar 22 van de 60 onderbrekingen verloren).
    De opname begint niet bij de detectie maar waar je begon te praten: de capture bewaart 3 s met niveaus per
    20 ms; terugzoeken tot het begin van het huidige stuk spraak (pauzes tot 600 ms horen erbij, drempel ≈ ⅓ van de
    onderbreekdrempel) + 300 ms marge, tussen 0,6 en 2,5 s (`preroll.ts`). Bij harde echo zonder echo-onderdrukking
    kan er dus tot 2,5 s bot-echo vóór je zin in de opname komen.
    **Eigen-stemfilter (0.4).** De hogere drempel alleen hield harde echo (luidsprekers zonder goede echo-onderdrukking,
    een laptopmicrofoon naast de speaker) niet tegen: in de test onderbrak de bot zichzelf zo in 12 van 12 gesprekken.
    De speler plant de PCM-samples van de lokale stem zelf, dus hij weet per 20 ms hoe luid de bot op dit moment klinkt
    (`player.ts#outputLevel`, het luidste van de laatste 300 ms voor de nagalm). De detector leert daaruit hoe luid die
    stem in de microfoon terugkomt (het 30e percentiel van microfoon ÷ uitvoer over 2 s: jouw woorden tellen daardoor
    niet als echo) en telt een stap alleen als jou als hij minstens 2× luider is dan die echo; de eerste 300 ms luide
    bot-audio zijn om te leren. Getest met echo 0,4-1,0× de uitvoer: 0 van 12 gesprekken onderbrak zichzelf, 12 van 12
    onderbrekingen door jou kwamen aan (`tests/voice-talk.test.ts`). Zonder referentie (browserstem, audiobestand van
    een provider) gelden de gewone drempels. Meldt de browser dat echo-onderdrukking niet aan staat, dan staat
    onderbreken door te praten uit en zegt het belscherm waarom.
17. **Spraakberichten: Ogg/Opus zelf decoderen.** Eigen Ogg-demuxer (pagina’s, lacing, doorlopende pakketten, eerste
    Opus-stream) + `opus-decoder` 0.7.12 (MIT; libopus BSD-3 als WebAssembly, geen native code, werkt in Electron),
    direct naar 16 kHz, pre-skip en eindopvulling afgeknipt, max 30 min. `ogg-opus-decoder` is níet gekozen: die
    hangt af van `codec-parser` (LGPL-3.0). Kanalen geven `audio/ogg; codecs=opus` door; de parameters worden nu
    weggehaald (eerder werd dat `application/octet-stream` en startte het uitschrijven nooit).
18. **Voorlezen terwijl de bot schrijft (`follow.ts`).** De server volgt de run zelf (`message.delta`-events van de
    eigenaar, `LiveText` houdt de tekst van berichten in wording bij zodat een later gestarte taak zonder gat aansluit).
    Een streaming-zinnensplitser (`sentences.ts`) geeft een zin vrij zodra het volgende teken laat zien dat hij af is;
    codeblokken worden één notitie, lijstnummers en afkortingen (dr., o.a., J. de Vries) breken niet, een lange
    eerste zin wordt bij een komma geknipt. De stem (Piper of VITS) wordt opgewarmd zodra de beurt start. Uitvoer via dezelfde PCM-stream
    als gewoon voorlezen; verbreekt de speler (onderbreken/stop/ophangen), dan stopt de taak. Eén volledig voorgelezen
    antwoord komt in de TTS-cache onder dezelfde sleutel als gewoon voorlezen. Alleen met de lokale stem; anders (en
    met de instelling uit) het oude pad. Tussentekst bij tools (“Even kijken…”) wordt ook uitgesproken.
19. **Dicteren in elk programma (desktop).** Electron `globalShortcut` heeft geen “losgelaten”; een kleine Windows-hulp
    (PowerShell + C#, DLL gecachet, net als de schermhulp) leest de toetsstatus. Korter dan 350 ms ingedrukt = handsfree.
    Opnemen gebeurt in een eigen pill-venster (`focusable: false`, eigen sessie die alleen de microfoon mag, als
    `file://`-pagina omdat de microfoon-API alleen in een veilige context bestaat) zodat de focus bij jouw programma
    blijft. Plakken = klembord + Ctrl+V (standaard bij dicteertools, werkt overal) met het oude klembord terug; typen
    alleen als het klembord iets bevat dat niet terug kan (gekopieerde bestanden). De tekst en het teruggezette
    klembord krijgen in dezelfde `clipboard.write()` de Windows-formaten `ExcludeClipboardContentFromMonitorProcessing`,
    `CanIncludeInClipboardHistory` = 0 en `CanUploadToCloudClipboard` = 0 (`desktop/dictation-clipboard.ts`): niets
    van het dicteren komt in Win+V of het cloudklembord, en iets uit een wachtwoordmanager komt er niet via ons in. Wachtwoordvelden: Win32 `ES_PASSWORD`,
    UI Automation `IsPassword`, MSAA `STATE_SYSTEM_PROTECTED` (Chromium-apps), en in TeamBot-vensters vraagt de schil de
    pagina zelf.
20. **Getallen in woorden voor stemmen zonder cijfers (`numbers.ts`).** De VITS-stemmen (Portugees, Pools) lezen
    tekens, en hun alfabet heeft geen cijfers: “om 10:30” werd stil overgeslagen. Voor zo’n stem (`spellNumbers` in de
    catalogus) schrijft `synthRequest()` per zin eerst getallen uit: hele getallen tot 999 miljard (Pools met de
    juiste vorm van tysiąc/milion), decimalen (“vírgula”, “przecinek”), kloktijden (Portugees vrouwelijk: “uma hora”;
    Pools na o/od/do/po op -ej: “o dziesiątej”), datums als losse getallen, procenten, R$/€/$/zł, en codes met een
    voorloopnul of lange reeksen cijfer voor cijfer. Naamvallen en rangtelwoorden worden verder niet verbogen: het doel
    is dat niets wegvalt en alles te verstaan is. Piper-stemmen lezen cijfers zelf (espeak-ng) en krijgen de tekst
    ongewijzigd. De Oekraïense Piper-stem (tekst-fonemen) slaat cijfers nog steeds over.
21. **Ingedrukt houden standaard op de pc, handsfree op de telefoon (0.4).** Het onderzoek van 9 november 2026 (spraak
    en dicteren) noemt de beurtwisseling als grootste klacht: een ademhaling geldt als einde van je vraag, en ChatGPT op
    de Mac hoort zijn eigen stem uit de luidspreker en onderbreekt zichzelf. Claude en Gemini raden in gedeelde ruimtes
    zelf indrukken-om-te-praten aan. Op de pc (luidsprekers naast een open microfoon) is daarom ingedrukt houden de
    standaard: niets telt zolang je de spatiebalk of de knop niet vasthoudt, een pauze om na te denken beëindigt je
    beurt niet, en de bot kan zichzelf nooit onderbreken. Loslaten = klaar (de opname loopt 250 ms door, want mensen
    laten net te vroeg los; hij begint 200 ms vóór het indrukken). Korter dan 300 ms is een tik: niets verzonden, een
    rustige hint (een tik terwijl de bot praat stopt hem wel). Indrukken kan niet terwijl de bot op je goedkeuring
    wacht (die kaart is voor je handen). Op een aanraakscherm (primaire aanwijzer `coarse`) is handsfree standaard:
    de telefoon houd je tegen je oor of je gebruikt oortjes. De keuze (`call.talk`: `auto`/`hold`/`handsfree`) staat in
    Instellingen › Spraak en als schakelaar *Handsfree* in het belscherm; omschakelen kan midden in een gesprek.
    Spatiebalk zonder Ctrl/Alt/Cmd (Ctrl+Spatie is dicteren, Ctrl+Alt+Spatie de sneltoets) en niet in tekstvelden.
22. **Hetzelfde model in spraak als in tekst (0.4).** Het onderzoek laat zien dat spraak bij ChatGPT en Claude lang een
    kleiner model kreeg (“dommer dan tekst”). Bij TeamBot is een gesproken beurt (gratis gesprek, groepsgesprek, *Bot
    bedienen*) een gewoon bericht + run van dezelfde bot, zonder per-run override: zelfde model, systeemprompt, tools en
    denkniveau; alleen de beurt krijgt de notitie dat het een transcript is (`turnContext`). `runResult` geeft het model
    van het antwoord terug en het belscherm toont het. Live (Realtime) *Direct praten* laat wél het spraakmodel van
    OpenAI antwoorden; dat is daarom niet meer de standaard (`realtime.mode` = `agent`) en de keuze zegt het erbij.
    Opgeslagen instellingen van vóór 0.4 met `direct` blijven staan.
23. **De stem volgt de taal van de bot (0.4).** Heeft een bot een vaste taal (`agent.settings.language`, of de keuze
    *Taal van de antwoorden* voor alle bots), dan is de hoofdstem van die bot een stem voor die taal (de beste
    gedownloade, anders de aanbevolen, die dan wordt aangeboden; tot dan de browserstem in die taal), ook als de app
    in een andere taal staat. Een bot met een eigen stem houdt die. Arabisch heeft geen vrije lokale stem: de systeemstem
    leest voor (bekende beperking). In een gesprek met zo’n bot is de dicteertaal-hint `auto-<taal>` (als jouw instelling
    automatisch is) en het automatische model een gedownload model dat die taal kent (Turks → Whisper); dicteren in de
    chat blijft jouw eigen taal volgen. Een bot zonder vaste taal volgt jou zoals vroeger.

## Live bellen in de cloud: de stem vóór, de bot erachter (0.4.4)

Een spraakmodel in de cloud praat (full duplex, onderbreken door te praten), de echte bot doet het werk erachter
(“client delegation”). Kleine praat kost dus geen botrun; de bot werkt alleen als de stem een tool aanroept.

- **Stap 0 (`LiveCall.tsx`)**: het belscherm noemt drie keuzes in gewone woorden: **Live met OpenAI** (eigen
  API-sleutel), **Live met Gemini (Google)** (AI Studio-sleutel, gratis aan te maken) en **Gratis gesprek (op je eigen
  pc)** met de downloadgrootte. Niets is grijs: wat nog ontbreekt staat erbij, en **Klaarmaken en bellen** doet het:
  sleutel plakken → provider opslaan → bellen, of de download openen (pas na jouw ja) → na afloop **Klaar — nu bellen**.
- **Twee stemmen**: OpenAI Realtime (WebRTC, bestond al) en **Gemini Live** (`gemini.ts`, server + UI): de server maakt
  met jouw sleutel een tijdelijk token (`POST {google}/v1beta/auth_tokens`, `uses: 1`, model vastgezet); de browser
  praat over één WebSocket (`…BidiGenerateContentConstrained?access_token=…`) met Google: 16 kHz PCM omhoog, 24 kHz
  PCM terug via Web Audio. Google’s eigen spraakdetectie hoort je terwijl de bot praat; bij `interrupted` stopt het
  afspelen meteen (barge-in). Kosten uit `usageMetadata`, geprijsd door de server (`GEMINI_LIVE_MODELS`).
- **Tools (`calltools.ts`, server; `cloudcall.ts`, browser)**, voor beide stemmen dezelfde:
  - `ask_agent`, `ask_team`, `ask_bot` (een andere bot op naam): een gewoon bericht + run (Broker, goedkeuringen,
    budget). **Blokkeert niet**: binnen 3,5 s klaar → meteen het antwoord, anders “bezig”; de pagina kijkt elke 2 s
    (`/tasks`) en vertelt het resultaat **als het stil is** (niet terwijl jij of de bot praat). Gemini: functies
    `NON_BLOCKING`, antwoorden met `scheduling: WHEN_IDLE`.
  - `task_status`: wat loopt nog, wat is klaar.
  - `approve`: wacht een taak op goedkeuring, dan stelt de stem de vraag; een **duidelijk “ja”** van jou (uit de
    spraakherkenning, nooit de woorden van de stem; “oké”, “ja maar wacht” of een lange zin telt niet) keurt **één
    keer** goed, “nee” weigert. Nooit “altijd toestaan” (dat kan alleen in de app). Tikken op de kaart kan ook.
  - `end_call`: de bot hangt zelf op. Eerst afscheid, dan pas ophangen als dat **is afgespeeld** (OpenAI:
    `output_audio_buffer.stopped`; Gemini: afspeelrij leeg). Geweigerd vlak na “wacht”, “momentje”, “niet ophangen” of
    een kaal “nee”, en terwijl een taak nog loopt, tenzij jij zelf duidelijk vraagt om op te hangen (“hang maar op”).
    Praat je tijdens het afscheid, dan hangt de bot niet op. Vangnet: na 45 s stilte “ben je er nog?”, daarna ophangen.
    Jij kunt altijd zelf ophangen.
- **Verslag in de chat** (`calls.ts#endCall`): één bericht met duur, kosten, wie ophing (“Ada hing op: …”), de
  samenvatting die de bot bij `end_call` gaf, en **wat er gedaan is** (elke taak met bot, verzoek en status). De
  verzoeken en antwoorden zelf staan als gewone berichten in de chat van die bot.
- **Overgenomen code**: de vorm van `spokenHangUp` en het delegatiebeleid in de instructies komen uit OpenMausBot
  `server/live-call.ts` (Apache-2.0, commit 1de1164), herschreven voor Nederlands en tools; vermeld in `NOTICE` en
  THIRD_PARTY_NOTICES (`ADAPTED_CODE` in `scripts/notices.mjs`).
- **Modi naast elkaar**: `Kind = 'realtime' | 'gemini' | 'halfduplex'` in `LiveCall.tsx`; instelling `call.engine`
  (`local` | `realtime` | `gemini`). Een nieuwe soort gesprek is één keuze erbij in `readiness()` en `start()`.

### Zo test de eigenaar live met zijn eigen sleutel

1. Start TeamBot (of een dev-server met een eigen datamap) en open een chat met een bot.
2. Klik op het telefoonicoon. Kies **Live met Gemini (Google)** of **Live met OpenAI**, plak je sleutel
   (aistudio.google.com/apikey of platform.openai.com/api-keys) en klik **Klaarmaken en bellen**. De sleutel komt
   als AI-dienst in **Instellingen › AI-diensten** (daar ook weer weg te halen).
3. Zeg: “Zoek uit wat het weer morgen in Utrecht is.” → de stem zegt dat hij ermee bezig is, het gesprek gaat door, en
   als de bot klaar is vertelt de stem het resultaat. Praat door de stem heen: hij stopt meteen.
4. Vraag iets waarvoor de bot toestemming nodig heeft (bijvoorbeeld een bestand schrijven met een bot in de stand
   “vragen”) en zeg “ja”. Probeer ook “oké”: dat telt niet.
5. Zeg “wacht even” en daarna “nee dank je, dat was het”: de bot neemt afscheid en hangt op na het afscheid. Kijk in
   de chat naar het verslag.
6. Op de pc: verberg het venster tijdens het gesprek; het gesprek loopt door. Op de iPhone (via https): het loopt
   zolang de app open is.
7. Lukt Gemini niet en zegt de foutmelding iets over het adres of het token, meld dan de tekst: Google noemt de
   token-route (`v1beta/auth_tokens` met `liveConnectConstraints`) nog met twee namen.

## Beperkingen en eerlijke kanttekeningen

- **Microfoon vereist https of localhost.** Op een telefoon via `http://192.168…` blokkeert de browser de microfoon;
  de UI zegt dat en verwijst naar https (Tailscale/relay). iOS Safari: getest is alleen Chromium (headless); op een
  echt iPhone is het niet getest.
- **Browser-spraakherkenning** (Web Speech API) stuurt audio naar Google (Chrome), Apple of Microsoft en werkt niet in
  Electron; staat zo vermeld in de UI.
- Het **prijsplafond** wordt door de browser gehandhaafd (de server kan een WebRTC-sessie die direct browser↔OpenAI
  loopt niet zelf afbreken); de server registreert en meldt `overCap`. Sessies sluiten ook als de pagina sluit.
- Kosten zijn **schattingen** (tokentellingen van OpenAI × prijslijst); de factuur van OpenAI is leidend.
- Twee spelers bij een memo: de app-schil toont de bijlage als `<audio>`, “Meelezen” toont een tweede speler met
  meelopende ondertiteling (`<audio>` kan zelf geen ondertitels tonen).
- Niet gebouwd: vergadernotities met systeemaudio (alleen de microfoon), Azure Realtime.
- **Live in de cloud (0.4.4)** is alleen getest met nagebootste diensten (nep-Google over een echte WebSocket in
  headless Edge, nep-OpenAI voor de sleutels); nog niet met een echte sleutel. Gemini: één verbinding duurt hooguit
  ±10-15 minuten (Google sluit dan; opnieuw verbinden met sessiehervatting is nog niet gebouwd, TeamBot meldt het).
  GPT-Live (`gpt-live-1`, delegatie via een server-sideband) is niet gebouwd: Nederlands staat niet in zijn lijst.
  Bellen met het scherm op slot op de iPhone vraagt CallKit (native, later).
- **Lokaal op de iPhone niet echt getest**: alleen headless Edge (desktopbreedte) met nepmicrofoon. iOS-aandachtspunten:
  Web Audio start pas na een tik (TeamBot ontgrendelt bij elke tik op mic/luidspreker/belknop); met een open microfoon
  kan iOS het geluid via de oorspeaker spelen (zachter) — gebruik oortjes of de luidspreker-knop van iOS.
- **Onderbreken via de luidspreker** (handsfree) is afgesteld zonder echte echo te kunnen meten: het eigen-stemfilter
  is getest met gesimuleerde echo, niet in een echte kamer met echte luidsprekers (voice:live draait met
  `--mute-audio`). Met oortjes of ingedrukt houden is het betrouwbaar. Iets te zacht praten tijdens de bot telt niet
  als onderbreken; zonder echo-onderdrukking moet je duidelijk luider praten dan de echo van de bot.
- Het eigen-stemfilter werkt alleen met de **lokale stem** (die speelt TeamBot zelf af). Bij de browserstem of een
  provider-stem gelden de gewone drempels.
- **Ingedrukt houden** is er voor het gratis gesprek en het groepsgesprek; Live (OpenAI Realtime) houdt zijn eigen
  beurtdetectie. De spatiebalk werkt alleen terwijl het belscherm open is en niet in een tekstveld.
- **Lokale engine en bestandstypen**: WAV en Ogg/Opus. webm/opus (browseropnames), mp3, m4a en Ogg Vorbis krijgen met
  de lokale engine 415 en een duidelijke melding; daarvoor is een provider nodig.
- **Sneltoets**: alleen in de desktop-app. Vasthouden en plakken werken op Windows; op macOS/Linux is het tikken om te
  starten en te stoppen en komt de tekst op het klembord (niet zelf geplakt; niet getest op die systemen). In
  programma’s die als administrator draaien laat Windows het plakken niet toe: de tekst blijft op het klembord (wel
  buiten Win+V). Klembordprogramma’s van anderen die de Windows-markering negeren, kunnen de tekst nog zien. De microfoon gaat ±0,4 s na de toets open (het
  balkje wordt dan rood); wie meteen begint te praten kan de eerste lettergreep missen. Wachtwoordvelden in apps die
  UIA én MSAA niet goed melden worden niet herkend. Live getest in een eigen testvenster, niet in Word/Outlook/browsers
  van de eigenaar (bewust: de test typt nergens anders).
- **Voorlezen terwijl de bot schrijft**: alleen met de lokale stem. Een bot die zijn tekst pas aan het eind in één
  keer geeft, wordt pas dan voorgelezen (zelfde als vroeger). Tussentekst van CLI-bots kan vaker uitgesproken worden
  dan in de chat zichtbaar is als de engine een ander eindantwoord teruggeeft dan hij streamde.
- **Piper op macOS**: de upstream-build van 2023 werkt niet goed; op macOS zijn de Piper-stemmen “niet voor dit
  systeem” (browserstem werkt), spraakherkenning wel. De VITS-stemmen (Pools, Portugees) hebben Piper niet nodig en
  zouden daar moeten werken; niet getest op macOS.
- **De stemmen voor Portugees, Pools en Turks** zijn goed te verstaan maar minder natuurlijk dan de andere stemmen
  (rondgang 8-20 % WER tegen 2-8 % voor de bekende, niet toegestane Piper-stemmen in die talen; zie *Lokale
  modellen*). De Portugese stem is getraind op Common Voice; of hij Braziliaans of Europees klinkt, is niet
  vastgesteld. De Turkse stem is getraind met een nieuwere espeak-ng dan die in Piper 2023.11.14-2: woorden met ö/ü
  klinken soms anders (“ödendi” werd als “adendi” verstaan). Getallen in woorden (Portugees, Pools) worden niet naar
  naamval verbogen.
- **Arabisch** heeft geen lokale stem (geen enkele kandidaat met een duidelijke vrije licentie die in deze pijplijn
  past); de browser-/systeemstem leest voor.
- In **Electron** zijn externe buffers verboden: gebruik van sherpa-onnx alleen met JS-buffers in en JSON uit (staat in
  `engine.ts`); voorlezen met sherpa-onnx alleen met `enableExternalBuffer: false` (staat in `vits.ts`).
- Een model van 670 MB kost ±1 GB werkgeheugen zolang het geladen is (15 min na laatste gebruik weer vrij).

## Tests en verificatie

- `tests/voice.test.ts` (8 tests, nep-OpenAI-server op 127.0.0.1): client-secret vereist login + eigen bot en geeft de
  vaste sleutel nooit terug; modelallowlist; STT met mime/inhoud-controle, 413 boven 25 MB, memo + VTT + range;
  TTS-cache (tweede keer geen providercall), markdown opgeschoond, browserstem zonder providercall, retentie;
  `ask_agent`-brug in de juiste thread met `parts.voice`, kosten server-side, plafond, idempotent ophangen; transcript
  wel/niet bewaard; bellen zonder Realtime wacht op goedkeuring via de Broker; isolatie tussen twee gebruikers.
- **Rooktest met echte OpenAI-sleutel (2026-11-06)**: client-secret aangemaakt (`ek_…`, 122 s geldig);
  `gpt-4o-mini-tts` → mp3 (≈ $0,001); `gpt-transcribe` op die mp3 → correct Nederlands transcript (namen misverstaan →
  daarom keywords toegevoegd); Realtime-TTS via WebSocket werkte; sessieconfig via WebSocket gaf gebruikerstranscript +
  `ask_agent`-functieaanroep. Daarna end-to-end in headless Chrome met nepmicrofoon (TTS-wav) tegen de echte app-schil:
  dicteren, live direct (antwoord na ±7 s, ondertiteling), live “Bot bedienen” (bot gebruikte `list_files`, antwoord
  voorgelezen), bellen zonder Realtime en spraakmemo met meelezen werkten. Totale kosten van alle rooktests < $0,05.

- `tests/voice-local.test.ts` (7 tests, geen echte modellen: lokale testserver + nep-engines): catalogus vastgepind
  (https, revisie, SHA-256, toegestane licenties, platform); modelopslag (voortgang, hervatten met Range, één download
  tegelijk, zip uitpakken, kapot bestand geweigerd, archiefpaden buiten de map geweigerd, verwijderen); PCM-hulpjes
  (WAV, resampling, pauzes, signaal, taal); live dicteersessie (stukken bij pauzes, niets dubbel of kwijt, alleen het
  laatste stuk na stoppen, limieten); standaardinstellingen lokaal; API (409 zolang niet gedownload, browserstem
  ondertussen, 403 voor leden, WAV-only, stilte niet herkend, stream + isolatie, lokale stem streamen en cachen, Engelse
  stem, gratis gesprek via de gewone run, mobiele routes).
- `tests/voice-languages.test.ts` (14 tests): elke stem vastgepind op een exacte revisie (de officiële Piper-stemmen
  op die van piper-voices), vrije licentie (ook BSD-3-Clause), vanaf nul getraind, taal klopt, bestanden per engine
  (Piper: voice.onnx + json; VITS: model.onnx + tokens.txt, geen Piper nodig, getallen in woorden); alleen Arabisch
  zonder stem; aanbevolen model en stem voor elke taal van de app; automatische keuzes per taal (Nederlands precies als
  vroeger, eigen keuzes blijven); **het dicteermodel per dicteertaal** voor alle 11 talen (als app-taal, als vaste
  taal en als voorkeurstaal in een Nederlandse app); dicteerhints; taal van een tekst raden in alle 11 talen
  (+ Russisch); de woorden die TeamBot zelf toevoegt via de woordenboeken in de taal van de gebruiker; stemkeuze per
  tekst (andere taal, Engelse stem, eigen botstem, ander schrift); API eind-tot-eind (Turkse app → Whisper + eerst de
  browserstem met uitleg, na downloaden de Turkse stem via Piper met de eigen ruis; Arabische app → browserstem met
  uitleg; Turks dicteren in een Nederlandse app → Whisper; Duitse app → Duitse stem, Nederlandse tekst → Nederlandse
  stem zodra gedownload, Cyrillisch → browser tot de Oekraïense stem er is); een VITS-stem eind-tot-eind (geen
  Piper-download, engine `vits`, “o 10:30” → “o dziesiątej trzydzieści”, engine niet beschikbaar → browserstem met de
  reden); getallen in woorden (Portugees, Pools); Piper-config zonder fonemen van meer tekens (origineel onaangeroerd).
  Plus in `tests/voice.test.ts`: een Duitse app stuurt `languages: [de, en]` naar de spraakprovider.
- `tests/voice-opus.test.ts` (3 tests, echte libopus-fixtures uit `tests/fixtures/make-voice-notes.ts`): lengte,
  pre-skip en eindopvulling; pakketten over pagina’s en 255-lacing (eigen muxer `tests/ogg.ts`), andere stream ervoor,
  Ogg Vorbis geweigerd, afgebroken bestand; `/voice/transcribe` en `services.voice.transcribe` met `audio/ogg`,
  `audio/opus` en `application/octet-stream`. Plus in `tests/whatsapp-web.test.ts`: een echt spraakbericht via WhatsApp
  wordt zonder plug-in lokaal uitgeschreven en beantwoord.
- `tests/voice-streaming.test.ts` (4 tests, bot die langzaam schrijft, nep-Piper): splitser (zelfde resultaat bij elke
  deltagrootte, code, afkortingen, tabellen, vroege eerste zin); gesprek met `speak: true` → eerste geluid ruim vóór de
  bot klaar is, elke zin één keer, cache bij opnieuw afspelen; onderbreken stopt de synthese, antwoord compleet in de
  chat; `/voice/speak/run` sluit midden in een antwoord aan, volgt toolstappen, respecteert de instelling en isolatie.
- `tests/voice-talk.test.ts` (15 tests, dezelfde code als het belscherm met nepmicrofoon, nepbot met echo uit de
  luidspreker en nepklok): ingedrukt houden (niets opgenomen of verstuurd vóór het indrukken, een pauze tijdens het
  vasthouden beëindigt de beurt niet, loslaten verstuurt; ook met de spraakherkenning van de browser), de eigen stem
  onderbreekt de bot nooit (10 gesprekken met echo zo luid als de uitvoer), indrukken tijdens het praten onderbreekt en stopt dat antwoord, een tik is geen beurt,
  niet indrukken tijdens een goedkeuring, meer dan een minuut vasthouden; handsfree (pauze beëindigt de beurt,
  onderbreken door te praten); het eigen-stemfilter (12 gesprekken met echo 0,4-1,0×: nooit zichzelf onderbroken,
  zonder filter wel; 12 onderbrekingen door jou over die echo: alle aangekomen); omschakelen tijdens het gesprek; de
  detector zelf (leert de echo, hoort jou, de eerste 300 ms, zonder referentie ongewijzigd); standaard per apparaat en
  de spatiebalk; microfoon-instellingen en de echo-controle; de regel “wie luistert/denkt/spreekt” voor één bot en
  voor een groep (wie spreekt, wie denkt, iedereen luistert naar je); de taal van een bot.
- `tests/voice-parity.test.ts` (5 tests): een gesproken beurt gebruikt dezelfde run, hetzelfde model, dezelfde
  systeemprompt, tools en denkniveau als typen, zonder override, en geeft het model terug; in een groepsgesprek antwoordt
  elke bot met zijn eigen model; Live start in *Bot bedienen*; de stem per bottaal (Nederlandse bot in een Engelse app →
  Alex, Duitse bot → Duitse stem ook bij “OK.”, Arabisch → systeemstem met uitleg, Turks → browserstem tot Antalia
  gedownload is, eigen botstem blijft, jouw keuze voor alle bots telt, “auto” volgt jou); de herkenning in een
  gesprek met een Turkse bot gebruikt Whisper, dicteren in de chat blijft Parakeet.
- `tests/voice-preroll.test.ts` (3 tests, dezelfde VAD-code als het belscherm): zachte start (oude pre-roll verloor
  0,82 s), lettergreeppauzes, limieten, het echte niveauverloop van “Wacht even, ik heb een andere vraag.”.
- `tests/dictation-hotkey.test.ts` (9 tests, nep-recorder/toets/klok/klembord): vasthouden, tikken, toetsherhaling,
  Esc, wachtwoordveld, niets verstaan, fout, maximum; plakken met klembord terug (of niet als je iets anders kopieerde),
  wachtwoordveld, administrator, gekopieerde bestanden → typen, geen toetsen → klembord; de tekst en het teruggezette
  klembord met de drie Windows-markeringen (DWORD 0) in één schrijfactie; combinaties en instellingen;
  de dicteerdienst (PCM in, tekst uit, browser-engine → lokaal, status in `/voice/settings`).
- `npm run voice:live` (echte modellen, headless Edge met `--mute-audio`, nepmicrofoon; `TEAMBOT_VOICE_MODELS=<map>`
  hergebruikt gedownloade modellen, `CLAUDE_BIN=<pad>` belt een echte Claude Code-bot, `VOICE_LIVE_LANGS=pt,pl,tr`
  (standaard, leeg = overslaan), `TEAMBOT_TEST_PORT` voor een vaste poort): **47/47** op 2026-11-08. Nederlands: ook in
  iPhone-weergave (aanraken, geen horizontale scroll), eerste klank voor/na, onderbreking compleet verstaan. Per nieuwe
  taal: automatische stem en dicteermodel, eerste klank, echte (niet stille) audio, 8 zinnen terug verstaan door het
  lokale model voor die taal (WER ≤ 25 %: Portugees 8,0 %, Pools 19,7 %, Turks 16,4 %; “10” tegen “dez” telt als
  fout), een kloktijd wordt uitgesproken, voorlezen terwijl de bot schrijft; een eigen stem per bot; en de
  instellingenpagina (Turks dicteren → Whisper staat erbij, Parakeet “Herkent geen Turks.”, een andere dicteertaal
  toont meteen het passende model, de drie stemmen met grootte, licentie en bron, de bot-instellingen bieden ze aan).
  Sinds 0.4 ook: het handsfree gesprek met onderbreken expliciet in handsfree; **ingedrukt houden** (standaard op de
  pc; “Sam luistert naar je” zolang de spatiebalk vastgehouden wordt, daarna “Sam denkt na…” en “Sam spreekt”; de
  zin “Wacht even, …” die de nepmicrofoon tijdens het antwoord afspeelt onderbreekt de bot níet, de toets wel); en een
  **groepsgesprek** met twee bots (“De groep luistert naar je”, “Lotte denkt na…”, “Lotte spreekt”, het gezicht van
  Lotte zegt “spreekt” en dat van Bram niet). **34/34** op 2026-11-09 met `VOICE_LIVE_LANGS=` (alleen Nederlands: de
  Portugese, Poolse en Turkse modellen stonden niet lokaal en zijn bewust niet gedownload).
- `npm run dictation:live` (alleen Windows): 9/9, zie metingen hierboven (sinds 2026-11-08 een tiende controle: het
  teruggezette klembord draagt de drie markeringen; nog niet live gedraaid). Typt alleen in het eigen testvenster
  (toetsen worden geweigerd voor elk ander proces), registreert de echte sneltoets niet, zet je klembord terug en start
  niet als daar iets op staat dat niet exact terug kan.

## Handmatige voorwaarden

- Niets voor gratis spraak: bij het eerste gebruik vraagt TeamBot om de modellen te downloaden (670 MB herkenning, of
  1,04 GB Whisper voor Turks en Arabisch; een stem van 28-77 MB, voor een Piper-stem plus 22 MB Piper; de Poolse en
  Portugese stem 71 MB zonder Piper). Daarna offline.
- Voor de telefoon: TeamBot via https bereikbaar maken (Tailscale), anders werkt de microfoon niet.
- Dicteren in elk programma: in de desktop-app Instellingen › Spraak › “Sneltoets aan” en opslaan (staat standaard uit).
  De eerste keer compileert Windows de kleine hulp (±10-20 s, op de achtergrond).
- Optioneel betaald: OpenAI API-sleutel (Instellingen › Providers › OpenAI) voor Live (Realtime) en OpenAI-stemmen/
  -transcriptie; dit is API-billing, los van ChatGPT Plus/Pro.


## Gratis live gesprek (full duplex, `server/modules/voice/duplex/`, 0.4.4)

Tegelijk praten en luisteren met de bot zelf, op je eigen pc, zonder sleutel of abonnement. Keuze **Live gesprek, gratis
(op je eigen pc)** in het belscherm (een van de drie keuzes naast **Live met OpenAI** en **Live met Gemini**);
standaard zodra alles er is, anders downloadt **Klaarmaken en bellen** wat ontbreekt (pas na die tik) en belt dan.

```
microfoon (echoCancellation) ─16 kHz PCM, 40 ms─▶ /ws/voice ─▶ Silero VAD (200 ms stilte = pauze)
   ─▶ bij een pauze tegelijk: Smart Turn v3.2 (klaar?) + Parakeet (tekst)
        klaar → tekst als gewoon bericht in de chat, gewone run van de bot (engine, tools, goedkeuringen)
        niet klaar ("en…") → verder luisteren; na 1,8 s stilte toch antwoorden; alleen "wacht even" → stil blijven
   ─▶ antwoord zin voor zin (SpeechSplitter) ─▶ Piper ─▶ 4 bytes antwoordnummer + PCM ─▶ pagina speelt af
je praat terwijl de bot praat of denkt ─▶ `interrupt`: run gestopt, pagina gooit de rest weg en meldt hoeveel
   gespeeld is (`played`) ─▶ het antwoord in de chat wordt ingekort tot wat je hoorde (`parts.voiceHeardOnly`)
```

- **Eén contract voor de drie gespreksvormen** (`mode.ts`, `CallModeId`: `realtime` (OpenAI), `gemini`, `duplex`
  (gratis, deze pc)): een *mode* heeft `start()`, `stop()` en `on(event)` met de
  events `phase`, `user`, `bot`, `interrupted`, `latency`, `error`, `ended`. De tools gaan via `CallToolHooks`
  (`endCall({reason, goodbye, summary, runId})`); lopende gesprekken staan in `ctx.services.voiceCallModes` (call-id → mode). Hangt
  een andere tool of de knop het gesprek op (`voice.call.updated` niet meer actief), dan maakt de sessie de zin af en
  hangt op.
- **`end_call`**: één implementatie voor alle gesprekken (`calltools.ts#runCallTool`, via `endCallRules` van de
  sessie): geweigerd vlak na "wacht" of "nee" en terwijl een taak nog loopt (de run die de tool zelf aanroept telt niet),
  altijd goed na je eigen "hang maar op". Het verslag in de chat zegt dan wie ophing en waarom. Eerst het afscheid
  uitspreken, pas ophangen als de pagina meldt dat het gespeeld is (vangnet: na hooguit 30 s).
- **Socket**: `ctx.services.wsRoutes` (pad → handler) in `server/app.ts` (kleine, additieve kernwijziging: dezelfde
  gesigneerde URL en intrekking als `/ws`). De telefoon-toegang (`mobile/gateway.ts`) laat `/ws/voice` door.
- **Twee onnxruntimes**: sherpa-onnx (1.28) en onnxruntime-node (1.30) hebben een bibliotheek met dezelfde naam; een
  proces houdt de eerste. `local/ort.ts` laadt altijd eerst onnxruntime-node (1.30 bedient sherpa-onnx ook; andersom
  niet: "The operating system cannot run %1"). Dat lost hetzelfde op voor het ingebouwde geheugenmodel.
- **Modellen** (`duplex/catalog.ts`, eigen opslag naast de andere, downloaden pas na de tik, grootte en SHA-256 vast):
  Silero VAD v5.1.2 (MIT, 2,3 MB) en Smart Turn v3.2 volledige precisie (BSD-2-Clause, data CC-BY-4.0, 32,4 MB). De
  int8-versie (8,7 MB) gaf op Nederlandse zinnen bijna altijd "klaar" (0,79 voor "Zet het in mijn agenda en", de
  volledige 0,02); ~20 ms trager. De kenmerken (Whisper log-mel, 80 × 800) zijn eigen code (`mel.ts`).
  Herkenning en stem zijn die van het gratis gesprek (Parakeet, Piper Alex CC0). Piper draait als apart programma
  (MIT, 2023-release); sherpa-onnx 2.0 heeft geen espeak meer en kan Piper-stemmen dus niet zelf, en de nieuwe
  Piper-bibliotheek (piper1-gpl) is GPL: niet gebruikt.
- **Gemeten** (`npm run voice:duplex`, Ryzen 7 7800X3D, mock-bot, warme modellen, 5 rondes, vanaf het echte einde van
  de zin tot de eerste audio bij de client): op een rustige pc mediaan **1,15 s**, slechtste 1,28 s; terwijl andere
  testruns op dezelfde pc liepen mediaan 1,2-1,5 s, slechtste 1,8 s, één keer 2,3 s (Piper had 1,6 s voor de eerste zin).
  Opbouw: 200 ms stilte voor de VAD, herkenning 350-500 ms, Smart Turn (tegelijk) 110-360 ms, stem eerste zin
  385-600 ms. Een echte bot komt daar bovenop (Claude Code haiku ≈ 3 s). Onderbreken: de bot stopt 0,37-0,52 s na het
  begin van je zin. De eerste beurt direct na het openen kan trager zijn: Parakeet laden duurt ≈ 4 s.
- **Grenzen**: alleen de lokale stem (geen browserstem); niet getest op een echte iPhone; de iPhone pauzeert een
  verborgen pagina (dan hangt het gesprek op); Smart Turn is gemeten met synthetische stemmen, niet met echte mensen.
  Een synthetische stem pauzeert na een komma even lang als na een punt: is de herkenning klaar vóór je verder praat,
  dan telt "Dank je wel," als beurt (praat je eerder verder, dan blijft het één beurt; alleen "wacht even" wordt altijd
  bewaard tot de rest komt). Praat je door het afscheid heen, dan hangt de bot niet op.

## Vergadernotities (toegevoegd door de hoofdsessie)

Pagina `#/m/voice/vergadering`. Opname start pas na toestemming ("iedereen weet dat dit wordt opgenomen") en een tik.
Er is een zichtbare opname-indicator met timer. Elke 45 seconden gaat een audiostuk via `/api/voice/transcribe` naar
de ingestelde transcriptiedienst. Alleen de tekst komt terug; de audio wordt niet opgeslagen. Het transcript is
bewerkbaar. *Notulen laten maken* maakt een gesprek met de gekozen bot (bijv. de Notulist uit de marktplaats), met
het transcript als bijlage en de vraag om samenvatting, besluiten, actiepunten en open vragen. Alleen de microfoon
wordt opgenomen, niet het systeem- of tabgeluid. Live getest met een nep-microfoon (WAV) in headless Edge en
gpt-5.4-mini.

## Groepsgesprek (toegevoegd door de hoofdsessie)

In een groepsgesprek staat een microfoonknop in de kop: *Groepsgesprek met spraak*. Het werkt halfduplex en om de
beurt. Op de pc houd je de spatiebalk of de knop ingedrukt terwijl je praat (handsfree met de schakelaar eronder);
indrukken terwijl een bot voorleest stopt die stem en geeft jou de beurt (de antwoorden blijven in de chat). Elk
gezicht zegt wat die bot doet (*luistert*, *denkt na*, *spreekt*) en één regel zegt het voor de groep (“De groep
luistert naar je”, “Bo en Cas denken na…”, “Ada spreekt”):
- Je zin gaat als spraakbericht naar de groep. Begin je met een naam ("Schrijver, …"), dan wordt dat `@Schrijver`;
  "iedereen" wordt `@iedereen`. Een groet ervoor ("Hé", "Hoi") mag.
- Verstaat de spraakherkenning een naam net anders (`names.ts`): klinkt het duidelijk als één bot (zelfde klank met een
  eenvoudige Nederlandse klanksleutel, zelfde lange stam met een andere uitgang zoals "Onderzoeken" → Onderzoeker, of
  één letter verschil bij namen van 6+ tekens), dan gaat het naar die bot. Twijfel (twee letters verschil, een gewoon
  woord als "Onderzoek", of twee bots die op elkaar lijken) → eerst de vraag "Ik hoorde “Onderzoek”. Bedoel je
  Onderzoeker?" met knoppen, of zeg "ja" / "nee" / de naam. Er gaat niets weg vóór het antwoord. Korte namen (≤ 3
  tekens) alleen exact. `tests/voice-names.test.ts`, en in `tests/e2e/files-chat.mjs` met een nep-microfoon.
- De groepsrouting bepaalt wie antwoordt.
- Elk nieuw bot-antwoord wordt na elkaar voorgelezen, met de stem die bij die bot is ingesteld (en in de taal van die
  bot), door die bot met zijn eigen model geschreven.
- Pas als de groep klaar is, luistert TeamBot weer (handsfree). Handsfree luistert hij nooit terwijl een bot
  voorleest, dus een stem uit de luidspreker kan geen beurt starten.

Je kunt dempen, onderbreken en ophangen.
