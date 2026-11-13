# Pariteit — TeamBot 0.4 naast OpenBot, MausBot en Grok Bot

Stand: 9 november 2026, TeamBot 0.4.1 plus de reparaties van 0.4.2 (deze branch). Basis: de pariteitsaudit van 7 november
(`%USERPROFILE%\Documents\TeamBot\vergelijking-openbot-2026-11-07.md`). Die telt **104 rijen** in 18 hoofdstukken (de
"38 punten" in `docs/STATUS.md` zijn daar een samenvatting van) plus de lijst *Wat de eigenaar echt gebruikt in OpenBot*.
Alle 104 rijen en die hele lijst staan hieronder.

**Hoe getest.** Zoals de eigenaar het doet, in de echte gebouwde app (`dist/ui`), Edge zonder venster, met een lege tijdelijke
datamap en een lege `HOME`/`APPDATA` (niets van deze pc gevonden of veranderd). De AI is een testmodel dat per bot een vast
antwoord geeft. Voor de engines draaien nep-programma's van Claude Code, Codex en OpenCode met opgenomen uitvoer; OpenBot is
een nagemaakte kopie van de opzet van de eigenaar (Baas, Baas Live, Kennis & Kansen …, routines, herinneringen, teamtabellen); "LM
Studio" is een kleine lokale nabootsing. Een deel draait als **gekoppelde telefoon**: koppelen via de echte koppelpagina,
daarna een apparaatsessie.

```bash
npm run build:ui && npm run parity:04          # ±4 minuten, stopt met code 1 als iets faalt
TEAMBOT_ACCEPT_ONLY=2,4 npm run parity:04      # alleen die hoofdstukken
TEAMBOT_PARITY_OLLAMA=1 npm run parity:04      # plus één vraag aan de echte Ollama, alleen als qwen3.6-uncensored-snel al geladen is
```

Elke uitvoerregel begint met het rijnummer hieronder, bijvoorbeeld `✔ [2.4] …`. Een `◦`-regel is een bekende achterstand
(geen fout). **Bewijs** noemt de stap in `tests/e2e/parity-04.mjs` (`[2.4]`) en/of een bestaande test.

**Statussen:** *werkt* (zo goed als OpenBot) · *beter* (TeamBot doet meer of veiliger) · *achter* (bouwnotitie onderaan)
· *later afgesproken* (in `docs/PLAN_0.4.md` › *Na 0.4*).

## Samenvatting

| Status | Rijen van de audit |
|---|---|
| werkt | 73 |
| beter | 23 |
| achter | 5 |
| later afgesproken | 3 |
| **totaal** | **104** |

Achter: 8.2 connectors met één klik (Google), 11.7 bureaublad op afstand, 13.1 telefoon-app in de stores, 16.2
automatisch bijwerken, 17.1 vergelijkende duurtest. In 0.4.3 bijgewerkt: 8.3, 18.2 (werkt), 7.5 (beter), 4.6, 9.5, 15.1. Later afgesproken:
9.8 workflows tekenen, 12.2 voorlezen in meer talen, 13.2 bereikbaar zonder Tailscale.

## 1. Eerste start en onboarding

| # | Functie | OpenBot | TeamBot 0.4 | Status | Bewijs |
|---|---|---|---|---|---|
| 1.1 | Installer Windows | per gebruiker, niet ondertekend | NSIS per gebruiker, installmap kiezen, data blijft bij verwijderen; niet ondertekend | werkt | [1.1], `tests/installer-nsh.test.ts` |
| 1.2 | Provider kiezen en installeren | CLI downloaden, versie vast | eigen gecontroleerde kopie van Claude Code, Codex, OpenCode; inloggen in de app (Codex apparaatcode, Claude Code code) | werkt | [1.2], `tests/cli-runtimes.test.ts`, `tests/e2e/c4-models-cli-review.mjs` |
| 1.3 | Gratis start zonder account | OpenCode gratis | *Gratis starten*: OpenCode met gratis model, Ollama als reserve | werkt | [1.3], `tests/free-path.test.ts` |
| 1.4 | Account nodig | ja voor telefoon/op afstand | nee, ook niet voor de telefoon | beter | [1.4], [13.4] |
| 1.5 | Toestemming bij eerste start | één keer, daarna volledig | veilig standaard; *Volledige toegang* per bot in één klik; de OpenBot-import neemt "full" over | werkt | [1.5], [5.1], [R.1] |
| 1.6 | Eerste bot en rondleiding | bot uit één prompt | drie vragen, hoofdbot of gewone bot, *Laat AI de instructies schrijven*, 15 teamsjablonen | werkt | [1.6], `tests/new-bot.test.ts` |
| 1.7 | Overstappen uit andere apps | import uit Grok Bot/Hermes | OpenBot-import: voorbeeld, import, ongedaan maken, OpenBot onaangeroerd. Import uit Grok Bot/Hermes: niet (de eigenaar gebruikt OpenBot) | werkt | [1.7], [R.1], `tests/openbot-import.test.ts` |

## 2. Bots

| # | Functie | OpenBot | TeamBot 0.4 | Status | Bewijs |
|---|---|---|---|---|---|
| 2.1 | Maken en bewerken | naam, avatar, rol, instructies | plus taal, antwoordstijl, engine, model, toegang, mappen, tools | werkt | [2.1] |
| 2.2 | Avatar en persona | pluche/plat, ogen | eigen figuurtjes per stemming, onderdelen, eigen foto, glad/vilt | werkt | [2.2], `tests/botface.test.ts` |
| 2.3 | Model, engine, denkniveau | per bot | per bot met feiten (tools, beeld, context, denkniveaus, prijs) | werkt | [2.3], `tests/model-capabilities.test.ts` |
| 2.4 | Reserve-engine | geordende lijst, ook bij limiet | tot 5 op volgorde, ook voor CLI's, melding in de chat, terug na reset. **Gerepareerd:** de editor hield er maar 3 | werkt | [2.4], `tests/agent-reserves.test.ts`, `tests/fallback.test.ts` |
| 2.5 | Werkmap en gedeelde map | `Agents/<id>` + `Shared` | werkmap, extra mappen alleen-lezen of lezen/schrijven, teammap | werkt | [2.5], `tests/folders.test.ts` |
| 2.6 | Lokale scripts | per agent | toolgroep Terminal (`run_command`) | werkt | [2.6] |
| 2.7 | Dupliceren, verbergen, archiveren | ja | dupliceren, archiveren, terughalen. **Gerepareerd:** terughalen kan nu ook vanaf de kaart in *Archief* | werkt | [2.7] |
| 2.8 | Export en sjablonen | link, 27 agents | export als bestand, 28 bot- en 15 teamsjablonen. **Gerepareerd:** teamsjablonen ook na de eerste bot (Instellingen › Teams) | werkt | [2.8], `tests/templates.test.ts` |
| 2.9 | Versiegeschiedenis | — | versies, verschil, terugzetten | beter | [2.9], `tests/agent-versions.test.ts` |
| 2.10 | Kosten en budget per bot | schatting per beurt | kosten per bot en model, dagbudget per eigenaar en team | werkt | [2.10], `tests/budget.test.ts` |

## 3. Engines en providers

| # | Functie | OpenBot | TeamBot 0.4 | Status | Bewijs |
|---|---|---|---|---|---|
| 3.1 | CLI-engines | ±13 | 21 ondersteund plus eigen ACP-agent | werkt | [3.1] |
| 3.2 | TeamBot-tools in CLI-engines | ja | MCP-brug per run: geheugen, samenwerken, vragen, delen, browser, routines | werkt | [3.2], `tests/cli-tools.test.ts` |
| 3.3 | API-providers | eigen endpoints | 35, met eigen OpenAI-compatibel adres | beter | [3.3], `tests/providers-conformance.test.ts` |
| 3.4 | Lokale modellen | via OpenCode | Ollama, LM Studio, llama.cpp rechtstreeks, contextvenster per model | werkt | [3.4], `tests/local-window.test.ts` |
| 3.5 | Inloggen met abonnement | CLI-login | CLI-login, inloggen vanuit de app | werkt | [3.5], `tests/cli-runtimes.test.ts` |
| 3.6 | Gebruik en limieten | popover, ringen | balk onderin: Claude 5 uur/week, Codex, gratis bronnen, reset, schatting | werkt | [3.6], `tests/e2e/accept-04-core.mjs` E-01…E-07 |
| 3.7 | Contextbeheer | ring, compact | contextring, *Nu samenvatten* | werkt | [3.7], `tests/compaction.test.ts` |

## 4. Chat

| # | Functie | OpenBot | TeamBot 0.4 | Status | Bewijs |
|---|---|---|---|---|---|
| 4.1 | Streaming, markdown, tool-kaarten | ja | plus denkproces en CLI-stappen | werkt | [4.1] |
| 4.2 | Threads | zijthreads, tabs | parallel, vertakken, archief (geen threadmappen) | werkt | [4.2] |
| 4.3 | Wachtrij | bewerken, herordenen | zichtbaar, bewerken, omhoog/omlaag, eruit halen | werkt | [4.3], `tests/chat-queue.test.ts` |
| 4.4 | Bijsturen / onderbreken | ja | bijsturen, onderbreken; getypt bericht = antwoord op open vraag | werkt | [4.4], `tests/question-answer.test.ts` |
| 4.5 | Bijlagen | tot 100 MB | tot 200 MB, eerlijke melding per soort. **Gerepareerd:** te veel of te grote bestanden worden gemeld, niet stil weggelaten | werkt | [4.5], `tests/attachment-notice.test.ts` |
| 4.6 | Previews en artefacten | HTML, Mermaid | HTML afgeschermd naast de chat, Mermaid, pdf-voorbeeld, syntaxkleuring, *Kopieer tabel* (CSV + cellen voor Excel/Sheets) | werkt | [4.6], `tests/e2e/files-chat.mjs`, `tests/table-copy.test.ts`, `tests/e2e/parity-small.mjs` |
| 4.7 | Zoeken | Ctrl+K, Ctrl+F | Ctrl+K, Ctrl+F, zoeken in instellingen | werkt | [4.7] |
| 4.8 | Vraag- en plankaarten | ja | vraag, formulier, plankaart | werkt | [4.8], `tests/plan-card.test.ts` |
| 4.9 | Exporteren | ja | Markdown en JSON | werkt | [4.9] |

## 5. Goedkeuringen en toegangsniveaus

| # | Functie | OpenBot | TeamBot 0.4 | Status | Bewijs |
|---|---|---|---|---|---|
| 5.1 | Niveaus | tot volledige toegang | 5 niveaus tot *Volledige toegang* (alleen eigenaar); versturen naar anderen en betalen vragen nog | werkt | [5.1], `tests/full-access.test.ts` |
| 5.2 | Op afstand goedkeuren | telefoon, chat-apps | gekoppelde telefoon (*Wacht op jou*), knoppen in Telegram/Slack/Discord/WhatsApp | werkt | [5.2], `tests/channels.test.ts` |
| 5.3 | Veiligheidsnet | — | Broker, prullenbak, oefenen op een kopie, undo | beter | [5.3], `tests/trash.test.ts`, `tests/rehearsal-moves.test.ts` |

## 6. Geheugen en dossiers

| # | Functie | OpenBot | TeamBot 0.4 | Status | Bewijs |
|---|---|---|---|---|---|
| 6.1 | Automatisch leren | elke N beurten | na een stille periode of *Nu leren*; automatisch, op verzoek of uit | werkt | [6.1], `tests/memory.test.ts` |
| 6.2 | Insluitmodi | altijd/gezocht | scopes, quota, vastzetten (= "essential") | beter | [6.2], `tests/memory-eval.test.ts` |
| 6.3 | Zichtbaar in de chat | stappen | *Onthouden …* met ongedaan maken, bronnen | beter | [6.3], `tests/e2e/accept-04-data.mjs` F-04 |
| 6.4 | Dossiers en kennisbank | — | dossiers, markdown importeren, pdf/Word | beter | [6.4], `tests/memory-md-import.test.ts` |
| 6.5 | Werkt met CLI-engines | ja | geheugentools via de MCP-brug | werkt | [6.5] |
| 6.6 | Gedeelde tabellen | ja | teamtabellen (ook uit OpenBot overgenomen) | werkt | [6.6], `tests/teamdata.test.ts` |

## 7. Skills en marktplaats

| # | Functie | OpenBot | TeamBot 0.4 | Status | Bewijs |
|---|---|---|---|---|---|
| 7.1 | Catalogus | 41 skills, 27 agents | 69 skills op vaste versies + 31 ingebouwd, 28 bots, licentie zichtbaar | werkt | [7.1], `tests/skills-catalog.test.ts` |
| 7.2 | Installeren | op alle agents | per bot of op alle bots in één stap | werkt | [7.2], `tests/e2e/extensions-ui.mjs` |
| 7.3 | Bijwerken en verwijderen | updates | versies, verschil, rechten-diff, terugzetten | beter | [7.3], `tests/skills.test.ts` |
| 7.4 | Veiligheid | hashcontrole | scan, handtekening, uitgeversbeleid | beter | [7.4], `tests/publisher-sdk.test.ts` |
| 7.5 | Skills maken | skill-creator | `skill_save` uit een gesprek; knop *Bewaar als skill* in het chatmenu: concept van de bot, bewerken, voor de bot of het team | beter | [7.5], `tests/skill-from-chat.test.ts`, `tests/e2e/parity-small.mjs` |
| 7.6 | In de composer | `$`-tag | `/`- en `$`-menu | werkt | [7.6], `tests/slash-menu.test.ts` |

## 8. Apps, MCP, connectors en kluis

| # | Functie | OpenBot | TeamBot 0.4 | Status | Bewijs |
|---|---|---|---|---|---|
| 8.1 | Eigen MCP | stdio/HTTP, OAuth | stdio/HTTP/SSE, OAuth, `claude mcp add`-regel plakken, overnemen uit Claude/Codex/Cursor | werkt | [8.1], `tests/mcp-import.test.ts` |
| 8.2 | Connectors met één klik | aanmelden via relay | Gmail/Drive/Agenda/Sheets/Slack vragen een eigen OAuth-app (Notion, Linear, Sentry wel één klik) | achter | [8.2], bouwnotitie |
| 8.3 | Kluis en wachtwoordmanagers | kluis, 1Password, Bitwarden | logins voor de browser, import uit Bitwarden/1Password/Chrome-CSV; sleutels voor scripts als omgevingsvariabele per bot of team (waarde nooit naar het model, overal verborgen, alleen op de computer) | werkt | [8.3], `tests/vault-import.test.ts`, `tests/script-keys.test.ts`, `tests/e2e/script-keys.mjs` |
| 8.4 | TeamBot als MCP-server | automatiserings-API | `list_bots`/`ask_bot` met eigen token, `teambot send` | werkt | [8.4], [9.12] |

## 9. Routines, triggers en automatisering

| # | Functie | OpenBot | TeamBot 0.4 | Status | Bewijs |
|---|---|---|---|---|---|
| 9.1 | Schema's | 6 soorten | vaste dagen, maandelijks (laatste werkdag …), interval met begin, eenmalig, cron | werkt | [9.1], `tests/routines-parity.test.ts` |
| 9.2 | Gemiste runs en limieten | wachten/overslaan | inhalen/overslaan; wachten tot de reset, overslaan, fout | werkt | [9.2], `tests/routines-parity.test.ts` |
| 9.3 | Waar de run draait | thread of hoofdchat | eigen gesprek of hoofdchat. **Gerepareerd:** de OpenBot-import zette hoofdchat-routines in een eigen gesprek | werkt | [9.3], [R.2] |
| 9.4 | Stille runs | ja | `routine_no_update`, verborgen | werkt | [9.4] |
| 9.5 | Webhooks | HMAC, Standard Webhooks | GitHub/Slack/Linear/Sentry/Stripe-stijl en Standard Webhooks (v1 en v1a, ook svix-headers), dubbel genegeerd | werkt | [9.5], `tests/routines.test.ts`, `tests/standard-webhooks.test.ts` |
| 9.6 | Feeds, mappen, e-mail, pagina's | chat-apps als trigger | feed, pagina, map, e-mail, chatbericht. **Gerepareerd:** e-mailtrigger met accountfilter vuurde nooit | beter | [9.6], `tests/routines-email-trigger.test.ts` |
| 9.7 | Resultaat naar een chat-app | ja | *Resultaat ook sturen naar*, met pdf | werkt | `tests/routines-parity.test.ts`, `tests/whatsapp-web.test.ts` |
| 9.8 | Workflows-canvas | ja (eigenaar: 1 lege) | workflows als lijst van stappen: bot, controle (met terug naar een eerdere stap), jouw akkoord, melding; starten zelf, door een bot, op schema of via een webhook; versies, runs met het resultaat per stap, vier voorbeelden voor een webshop. Geen tekenvel en geen parallelle takken | werkt | `tests/workflows.test.ts`, `tests/e2e/workflows.mjs`, `docs/modules/workflows.md` |
| 9.9 | Routineflows A → B | ja | *Daarna starten*, kringen geweigerd | werkt | [9.9], `tests/routine-chain.test.ts` |
| 9.10 | Wachten op een gebeurtenis | ja | `wait_for` | werkt | [9.10], `tests/wait-for.test.ts` |
| 9.11 | Kalender | maand | week en maand | werkt | [9.11] |
| 9.12 | Lokale automatiserings-API | ja | REST met token, `teambot send` | werkt | [9.12], `tests/cli-send.test.ts` |

## 10. Groepen, teams en delegatie

| # | Functie | OpenBot | TeamBot 0.4 | Status | Bewijs |
|---|---|---|---|---|---|
| 10.1 | Bot naar bot | 654 berichten | `ask_bot` (wekt met het antwoord), `delegate_task`, `handoff`, `broadcast`; ook CLI-bots | werkt | [10.1], `tests/bot-mailbox.test.ts` |
| 10.2 | Groepen en kanalen | kanalen met eigenaar | 4 werkwijzen, takenbord, kostenplafond, teamleider, hoofdbot | beter | [10.2], `tests/rooms.test.ts` |
| 10.3 | Grenzen | — | diepte, beurten, per uur, budget per keten | beter | [10.3] |
| 10.4 | Teamserver, SSO, SCIM | ja | OIDC, SCIM (servermodus) | werkt | `tests/sso-scim.test.ts` |
| 10.5 | Subagents | ja | stappen *Deeltaak · …* | werkt | `tests/cli-activity.test.ts` |

## 11. Computers

| # | Functie | OpenBot | TeamBot 0.4 | Status | Bewijs |
|---|---|---|---|---|---|
| 11.1 | Ingebouwde browser | in de app, PiP | eigen browser per bot, paneel naast de chat, beeld-in-beeld, overnemen, profielen; ook voor CLI-bots (MCP); proxy alleen voor de hele app | werkt | [11.1], `tests/e2e/browser-dock.mjs` |
| 11.2 | Computer Use op de eigen pc | cua-driver | schermafbeelding naar het model, per actie / per taak / volledige toegang, harde blokkades, noodstop (Windows) | werkt | [11.2], `tests/computer-use.test.ts` |
| 11.3 | Oefenen en undo | — | repetitie, snapshots | beter | `tests/rehearsal-compare.test.ts` |
| 11.4 | VM, container | Xvfb-server | Docker; Windows Home eerlijk "niet beschikbaar" | werkt | [11.4], `tests/browser.test.ts` |
| 11.5 | Cloud | gehoste VM's | Hetzner, DigitalOcean, kosten vooraf | werkt | [11.5], `tests/cloud-vm.test.ts` |
| 11.6 | SSH / eigen VPS | — | SSH met vastgezette vingerafdruk | beter | [11.6], `tests/remote-computer.test.ts` |
| 11.7 | Bureaublad op afstand | Sunshine/Moonlight | niet (wel live beeld van de bot-browser) | achter | `◦ [11.7]`, bouwnotitie |

## 12. Spraak

| # | Functie | OpenBot | TeamBot 0.4 | Status | Bewijs |
|---|---|---|---|---|---|
| 12.1 | Dicteren | lokaal (Parakeet) | lokaal Parakeet/Whisper (sherpa-onnx), sneltoets in elk programma, eerlijke melding zonder model | werkt | [12.1], `tests/voice-local.test.ts`, `npm run dictation:live` |
| 12.2 | Voorlezen | 31 talen | lokaal in 10 talen, snelheid | later afgesproken | [12.2], `docs/PLAN_0.4.md` |
| 12.3 | Live gesprek | voicepaneel | gratis om de beurt met onderbreken, groepsgesprek, Realtime optioneel | beter | [12.3], `tests/voice-call-bargein.test.ts` |
| 12.4 | Vergadernotities | — | ja | beter | [12.4] |

## 13. Telefoon en toegang op afstand

| # | Functie | OpenBot | TeamBot 0.4 | Status | Bewijs |
|---|---|---|---|---|---|
| 13.1 | App | App Store, Google Play | PWA; iPhone-app via TestFlight in aanbouw (pakket I); geen Android-app | achter | [13.1], bouwnotitie |
| 13.2 | Bereikbaar zonder netwerkgedoe | WebRTC (bij de eigenaar 144× mislukt) | thuis via wifi, onderweg Tailscale met één knop | later afgesproken | [13.2] |
| 13.3 | Push | iOS/Android, Live Activity | Web Push (https/Tailscale), APNs voor de iPhone-app | werkt | [13.3], `tests/mobile.test.ts` |
| 13.4 | Koppelen en intrekken | QR, Face ID | eenmalige QR, apparaatlijst, direct intrekken, app-vergrendeling, alles bedienen behalve toegang/geheimen | beter | [13.4], [13.6], `tests/mobile.test.ts` |
| 13.5 | Delen vanuit andere apps | ja | Android-deelmenu | werkt | [13.5], `tests/e2e/mobile.mjs` |

## 14. Chat-apps als kanaal

| # | Functie | OpenBot | TeamBot 0.4 | Status | Bewijs |
|---|---|---|---|---|---|
| 14.1 | WhatsApp | QR | QR (met waarschuwing) en officiële Business-API | werkt | [14.1], `tests/whatsapp-web.test.ts` (live koppelen: eigenaar) |
| 14.2 | Bestanden sturen | ja | `channel_send` met bestanden; naar de eigenaar zonder vragen als per bot aangezet | werkt | [14.2], `tests/whatsapp-web.test.ts` |
| 14.3 | Telegram, Discord, Slack | ja | ja, goedkeuren via knoppen | werkt | [14.3], `tests/channels.test.ts` |
| 14.4 | E-mail als kanaal | — | IMAP en SMTP | beter | [14.4] |
| 14.5 | Veiligheid | alleen de aanvrager | allowlist, koppelcode, anderen zonder tools, klantmodus | beter | [14.5], `tests/channels-customer.test.ts` |
| 14.6 | Orchestrator | beste agent | kanaal aan bot, hoofdbot of groep | werkt | [14.6] |

## 15. Meldingen

| # | Functie | OpenBot | TeamBot 0.4 | Status | Bewijs |
|---|---|---|---|---|---|
| 15.1 | Desktop | niveaus, geluid | per bot alles/belangrijk/niets, geluid, knoppen in Windows-meldingen; een Windows-melding verdwijnt als je elders hebt beslist | werkt | [15.1], `tests/notifications.test.ts`, `tests/desktop-notes.test.ts` |
| 15.2 | Zwevende status | Dynamic Island | zwevend statusvenster (desktop-app) | werkt | [15.2], `npm run status:check` |
| 15.3 | Telefoon | push | push | werkt | [13.3] |

## 16. Instellingen, back-ups en updates

| # | Functie | OpenBot | TeamBot 0.4 | Status | Bewijs |
|---|---|---|---|---|---|
| 16.1 | Back-ups in de app | — | dagelijks, nu, terugzetten, vóór elke update | beter | [16.1], `tests/app-backup.test.ts` |
| 16.2 | Automatisch bijwerken | GitHub Releases, bij inactiviteit | back-up vooraf, terug naar vorige versie; nog geen openbaar kanaal | achter | [16.2], bouwnotitie |
| 16.3 | Achtergrond en wakker houden | ja, ook op batterij | systeemvak, wakker zolang er iets loopt (ook op batterij) | werkt | [16.3], `npm run power:check` |
| 16.4 | Privacy en analytics | analytics standaard aan | geen telemetrie, *Wat verlaat je pc?* | beter | [16.4] |
| 16.5 | Taal | 5–14 | 11 talen, ook Arabisch | beter | [16.5] |

## 17. Prestaties en stabiliteit

| # | Functie | OpenBot | TeamBot 0.4 | Status | Bewijs |
|---|---|---|---|---|---|
| 17.1 | Gemeten | 18,5 s stilstand, ±2,2 GB | `npm run perf` 14/14; stilstandmeter en *Hoe gaat het met TeamBot?*; `npm run soak` (rookproef 5 min); de duurtest van 48 uur naast OpenBot volgt | achter | [17.1], `tests/health.test.ts`, `docs/quality/soak-2026-11-09.md` |
| 17.2 | Herstel na herstart | ja | onderbroken, nooit stil herhaald, *Hervatten* | werkt | [17.2], `tests/approvals-restart.test.ts` |

## 18. Uiterlijk en eenvoud

| # | Functie | OpenBot | TeamBot 0.4 | Status | Bewijs |
|---|---|---|---|---|---|
| 18.1 | Zijbalk | bots, pins, "Needs you" | bots met gezicht en status, vastzetten, eigen volgorde, *Wacht op jou*, vijf vaste plekken | werkt | [18.1], `tests/e2e/layout.mjs` |
| 18.2 | Thema en look | 10 logokleuren | licht/donker/systeem, glad/vilt, Standaard + 10 kleuren (o.a. Lavendel) per gebruiker, ook op de telefoon; elke kleur WCAG AA | werkt | [18.2], `tests/accent.test.ts`, `tests/e2e/accent.mjs` |
| 18.3 | Eenvoud | weinig vragen | eenvoudig standaard, *Geavanceerd tonen* | werkt | [18.3] |

## Wat de eigenaar echt gebruikt in OpenBot

| # | Gebruik in OpenBot | TeamBot 0.4 | Status | Bewijs |
|---|---|---|---|---|
| R.1 | 10 bots, alle `full`, Computer Use alleen Baas, Opus/Sonnet/Haiku/Codex, 1–3 reserves, avatar | import: alles over, Volledige toegang, *Mijn bureaublad* alleen Baas, modellen en denkniveau, alle reserves op volgorde, eigen gezicht | werkt | [R.1], [1.7] |
| R.2 | 34 routines, zes soorten schema, `wait`, skip/run-once, thread of hoofdchat, stille runs | alles over (uit, tot je ze aanzet), hoofdchat blijft hoofdchat | werkt | [R.2], [9.1]–[9.4] |
| R.3 | 654 berichten tussen bots, mailbox, subagents, vraag- en plankaarten, context wissen, bijsturen | [10.1], [4.8], [3.7], [4.4], [10.5] | werkt | idem |
| R.4 | 251 herinneringen (essential/searchable), review elke 40 beurten | essential = vastgezet, rest doorzoekbaar; leren na stilte i.p.v. per beurten | werkt | [R.4], [6.1], [6.2] |
| R.5 | 52 bijlagen (pdf, png, html), deels door bots gemaakt | bijlagen van jou; bots maken bestanden en delen ze (`share_file`) | werkt | [R.5], [3.2] |
| R.6 | kosten per beurt tegen lijstprijs | per bot en model, "waarde via abonnement" | werkt | [3.6], [2.10] |
| R.7 | Claude, OpenCode (beheerd), Codex, LM Studio lokaal, DeepSeek-sleutel | allemaal, LM Studio antwoordt in de chat | werkt | [R.7], [3.4] |
| R.8 | dicteren 1.395×, Dynamic Island, browser zichtbaar/PiP, bijsturen, onderbreken, browser-overname, verbinden op afstand | [12.1], [15.2], [11.1], [4.4]; verbinden zonder Tailscale: later afgesproken | werkt | idem |
| R.9 | push met Live Activity, teamserver via WebRTC | push werkt; Live Activity komt met de iPhone-app (pakket I); WebRTC later afgesproken | achter | [13.3], [13.2] |
| R.10 | nog niet in gebruik: MCP, WhatsApp (gepland), workflows | MCP [8.1], WhatsApp [14.1], workflows later afgesproken | werkt | idem |
| R.11 | achtergrond, wakker houden (ook batterij), analytics uit, logokleur, spellingcontrole NL | achtergrond, wakker houden, geen telemetrie; spellingcontrole met suggesties in het rechtsklikmenu (nieuw); logokleur: 18.2 | werkt | [R.11], `tests/desktop-context-menu.test.ts` |

## Gerepareerd in 0.4.2 (klein, met test)

1. **Reserve-engines:** de bot-editor toonde 5 plekken maar bewaarde er 3; een 4e en 5e verdween stil. `ui/src/pages/agentReserves.ts`, `tests/agent-reserves.test.ts`, [2.4].
2. **Teamsjablonen** waren alleen bereikbaar vóór de eerste bot; nu ook in Instellingen › Teams › *Team uit een sjabloon*. [2.8].
3. **Gearchiveerde bot** terughalen kon alleen via het chatmenu; nu ook op de kaart in *Alle bots › Archief*. [2.7].
4. **OpenBot-import, voorbeeld:** zei dat maar één reserve werkt en dat elke klik bij Computer Use vraagt; beide verouderd. `tests/openbot-import.test.ts`, [R.1].
5. **OpenBot-import, routines in de hoofdchat** kwamen in een eigen gesprek; nu in de hoofdchat (`runIn: 'main'`). `tests/openbot-import.test.ts`, [R.2].
6. **E-mailtrigger:** met een account ingevuld vuurde hij nooit, en de afzender werd "[object Object]". `tests/routines-email-trigger.test.ts`.
7. **Bijlagen:** meer dan 10 bestanden of groter dan 200 MB werd stil weggelaten; nu een melding. [4.5].
8. **Spellingcontrole:** rechtsklik in de desktop-app deed niets; nu suggesties, *Toevoegen aan woordenboek*, knippen/kopiëren/plakken. `desktop/context-menu.ts`, `tests/desktop-context-menu.test.ts`.
9. **Test die niet meer klopte** sinds 0.4.1 (telefoon mag kanalen beheren): `tests/whatsapp-web.test.ts`.

## Bouwnotities (grote gaten, niet in *Na 0.4*)

Voorkeur: een bestaand, goed onderhouden open-sourceproject met een toegestane licentie (MIT, Apache-2.0, BSD) inbouwen.

| # | Wat | Waarom | Hergebruik | Grootte |
|---|---|---|---|---|
| 8.2 | Google (Gmail, Agenda, Drive, Sheets) en Slack met één klik | Klantenservice draait op Gmail; nu een eigen OAuth-app in Google Cloud nodig | bestaande MCP-servers uit de catalogus houden; nodig is een geverifieerde OAuth-app van de eigenaar plus een kleine doorgeef-dienst voor het inloggen (geen open-source vervangt de Google-verificatie) | L, plus een Google-verificatie door de eigenaar |
| 11.7 | Bureaublad op afstand vanaf de telefoon | OpenBot heeft het; P2 | eigen live scherm (`server/modules/browser/screen.ts`, MJPEG) en de bestaande invoer-driver; Sunshine/Moonlight/RustDesk zijn GPL/AGPL en vallen af | M (2–3 dagen) |
| 13.1 | Android-app | OpenBot staat in Google Play | de bestaande PWA verpakken als TWA met **Bubblewrap** (GoogleChromeLabs, Apache-2.0); iPhone: pakket I (TestFlight) | S–M (1 dag + ondertekensleutel) |
| 16.2 | Standaard updatekanaal en bijwerken bij inactiviteit | de updater staat uit zonder kanaal | **electron-updater** (MIT, zit er al in) met GitHub Releases; vraagt een openbare release-repository (keuze eigenaar; er wordt niets gepusht) | S |
| 17.1 | Duurtest 48 uur naast OpenBot en een stilstandmeter | pas dan "beter" claimen | `perf_hooks.monitorEventLoopDelay` (Node zelf) en `tests/e2e/perf.mjs` | S (meter), M (duurtest) |

**Kleine punten, niet gerepareerd (te veel buiten de afspraak of van een ander pakket):** updatemelding van skills in de zijbalk (7.3), threadmappen (4.2), statusreacties in chat-apps (14.3), een browsermelding die
blijft staan nadat je elders hebt goedgekeurd (15.1; de Windows-melding is in 0.4.3 gerepareerd), proxy per browserprofiel (11.1), import uit Grok Bot/Hermes (1.7).

**Telefoonpunten:** gerepareerd in 0.4.2 en 0.4.3 (elke pagina geopend als gekoppelde telefoon in
`tests/e2e/phone-owner.mjs`; wat alleen op de computer kan, zegt dat rustig).

## Uitslag

Laatste run, 9 november 2026 (Windows 11, Node 26, Edge zonder venster, andere agents op dezelfde pc): `npm run parity:04`
**182/182 geslaagd** in 3 min 53 s, geen paginafouten; één bekende achterstand als `◦`-regel (11.7). Daarnaast
`npm run typecheck` schoon en `npm test` **1229/1229**. De live proef met Ollama (`TEAMBOT_PARITY_OLLAMA=1`) is niet
gedraaid: niet nodig voor deze rijen, en zo bleef de grafische kaart vrij.
