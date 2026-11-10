# Module `quality` — Werk dat echt af is

Server `server/modules/quality/`, lussen stoppen in `server/agent/loops.ts`, UI `ui/src/modules/quality/`.
Tests: `tests/quality.test.ts`. Plan 0.4, pakket C (kwaliteitshelft).

## Wat het doet

- **"Klaar als" per taak**: één korte, controleerbare zin. De bot stelt hem voor (`task_create` / `task_update`
  `done_when`, in de teamdatabase de kolom `klaar_als`); de eigenaar kan hem aanpassen, en dan kan een bot hem niet
  meer veranderen.
- **Tweede blik vóór "klaar"**: meldt een bot een taak af (`task_done`, of `task_update` met status done, of
  `UPDATE taken SET status = 'klaar'`), dan:
  1. kijkt TeamBot eerst zelf naar het bewijs: bestaat het bestand (in de groepsmap of de mappen van de bot) en wat
     staat erin, bestaat het bericht (`msg_…`) of de bijlage (`att_…`), staat de uitvoer in een stap die de bot echt
     zette. Links worden niet geopend (er gaat niets van de pc af);
  2. **geen bewijs** → *te controleren*, zonder modelaanroep; **fout bewijs** (bestand ontbreekt of is leeg, bericht
     niet gevonden) → *te controleren*, zonder modelaanroep;
  3. anders één korte modelaanroep met een **schone context**: alleen de taak, "klaar als", wat de bot meldt, het
     bewijs zoals TeamBot het vond en de stappen die de bot echt zette; nooit het gesprek. Antwoord: *klaar*,
     *te controleren* of *kon niet*, met één zin waarom. Faalt de aanroep of is het antwoord onduidelijk: *te
     controleren*.
  - Engine: die van de bot, of een goedkopere die de eigenaar kiest (Bot › Werk dat af is › Controle-engine). API:
    max. 220 tokens, 60 s; CLI (Claude Code, Codex, OpenCode) via `complete`, zonder tools. Max. 300 per eigenaar per
    dag, en het dagbudget geldt voor betaalde engines. Lokale modellen (Ollama) controleren zonder "denken"; anders
    gaat het hele tokenbudget op aan denken (live gezien met qwen3).
  - **Engine aan zijn limiet** (0.4.5; bijv. de gratis daglimiet van OpenCode): de controle gaat meteen naar de
    volgende engine van de standaardketen (ander abonnement, gratis bron, lokaal model; dezelfde regels als de runner,
    privé alleen lokaal of "bewaart niets") en zegt dat achter de reden. Is er niets, dan blijft de taak *te
    controleren* met "Nog niet gecontroleerd: … TeamBot controleert het vanzelf opnieuw rond 01:00." De module probeert
    het elke minuut als de tijd daar is (`recheck_at`; na de reset +1 min, anders 30 min en steeds dubbel, max. 8 uur;
    hoogstens 6 keer). Goed → de taak gaat zelf naar *klaar* (bord: `klaar`, teamdatabase: van `wacht_op_controle`
    naar `klaar`) en de eigenaar krijgt een melding. Besliste de eigenaar intussen, dan gebeurt er niets.
  - Per taak kan de eigenaar de controle **overslaan**: dan geen modelaanroep, maar bewijs blijft nodig.
  - Per bot kan de tweede blik uit (`settings.quality.check = false`); ook dan geen "klaar" zonder bewijs.
- **Eerlijk bij onmacht**: `task_done` met `outcome: "cannot"` en `reason` → taak *geblokkeerd*, "Kon niet: …",
  onder Wacht op jou. In de teamdatabase: status `kon_niet` met de reden in `resultaat`. Een gedelegeerde bot begint
  zijn antwoord met "Kon niet:"; dat gaat zo terug, zonder controle-aanroep.
- **Gedelegeerd werk** (`delegate_task`): komt het terug als klaar, dan dezelfde tweede blik op de engine van de
  uitvoerende bot, met `expected_output` als "klaar als" en de stappen van zijn beurt als bewijs. Het oordeel gaat
  mee naar de opdrachtgever ("Controle met een frisse blik: TE CONTROLEREN — …").
- **Geen dubbel werk**: `task_claim` claimt een bordtaak atomair (één `UPDATE … WHERE claimed_by IS NULL`). Een
  tweede bot krijgt "X werkt al aan …" en kan hem niet claimen, op bezig zetten of afmelden. `task_update` status
  doing claimt ook, status todo geeft vrij. Klaar of kon niet → claim weg; *te controleren* → de bot houdt hem.
  De eigenaar kan vrijgeven (dan is ook de bot niet meer de eigenaar van de taak). Wie hem heeft staat op het bord, in
  `task_list` en `team_status`.
- **Lussen stoppen** (`agent/loops.ts`, standaard aan, per bot instelbaar en begrensd):
  - API-engines: dezelfde tool met dezelfde argumenten voor de 3e keer (`repeat`, 2–10) terwijl de vorige keren
    hetzelfde resultaat gaven → niet uitgevoerd; of 6 stappen (`idle`, 3–30) achter elkaar zonder iets nieuws. Een
    aanroep met een ander resultaat (status opvragen) telt als vooruitgang. De bot krijgt één laatste stap zonder
    tools om te zeggen wat hij probeerde en om hulp te vragen.
  - CLI-engines: dezelfde stap (soort, titel, detail) 3× achter elkaar → de run stopt; wat hij deed blijft staan.
  - In de chat een kaart (event `loop_stop`) met wat hij probeerde, een melding, `run.meta.loopStop`; een
    gedelegeerde beurt die zo stopt is "niet gelukt".
- **Leren van correcties**: zegt de eigenaar direct na een antwoord iets als "nee, zo doen we dat niet", "dat klopt
  niet", "doe dit voortaan anders", "volgende keer …", dan maakt één korte aanroep er één vaste les van (of geen,
  als het alleen over dit ene geval ging). Opgeslagen via `ctx.services.memory.remember` als gedeelde kennis van het
  thuisteam van de bot (0.4 F2: scope `shared` in dat team, type `lesson`, de bot als auteur, bron = het bericht van de
  eigenaar), zodat het hele team het zo doet; een bot die geen gedeelde kennis leest houdt de les zelf (scope `agent`).
  Zichtbaar onder zijn bericht en in Geheugen, met ongedaan maken en *Alleen voor <bot>*.
  Zonder engine blijven zijn eigen woorden de les. Max. 10 per bot per dag; per bot uit te zetten.
- **Skill voorstellen**: deed een bot dezelfde soort taak 3× gecontroleerd goed (90 dagen), dan een kaart onder
  Wacht op jou. "Ja" vraagt de bot in zijn eigen chat een concept te maken met `skill_draft`; dat gaat door de
  gewone beoordeling in Mijn skills. Er wordt nooit iets vanzelf geïnstalleerd.
- **Ingebouwde werkregel** in de systeemprompt van elke bot die meer mag dan chatten: "Controleer vóór je klaar zegt"
  (eigen tekst; idee: verification-before-completion uit obra/superpowers, MIT).

## API (onder `/api`)

| Route | Wat |
|---|---|
| `GET /quality/inbox` | Te controleren / kon niet (bord en teamdatabase) en skillvoorstellen |
| `GET /quality/task/:kind/:ref` | Kwaliteitsrecord van één taak (`room`, `teamdata`, `delegation`) |
| `PATCH /quality/task/teamdata/:ref` | `doneWhen`, `skipCheck` (eigen teamdatabase) |
| `GET /quality/suggestions`, `POST /quality/suggestions/:id` | `{decision: accept\|dismiss}` |
| `GET /quality/lessons?agentId=` | Geleerde lessen |
| rooms: `PATCH /rooms/tasks/:id` | ook `doneWhen`, `skipCheck` |
| rooms: `POST /rooms/tasks/:id/approve`, `/reopen` (`{note}`), `/release` | Goedkeuren, terugsturen (bericht aan de bot), vrijgeven |
| teamdata: `PATCH /teamdata/tasks/:id` | ook `klaar_als`; `POST /teamdata/tasks/:id/reopen` |

Event `quality.changed`. Tabellen: `quality_tasks` (één rij per taak: klaar als, claim, melding, bewijs, stappen,
oordeel, wacht op eigenaar), `quality_lessons`, `quality_suggestions`. Taakstatus zelf blijft in `room_tasks` /
`taken`. Volledige export en account verwijderen nemen ze mee.

Dienst voor andere modules: `ctx.services.quality` — `view`, `setDoneWhen`, `setSkip`, `claim`, `release`, `holder`,
`report` (afmelden: done met bewijs of cant met reden → oordeel), `checkDelegation`, `ownerDecided`, `reopen`,
`workerOf`, `tellBot`.

## UI

Herbruikbare stukken in `ui/src/modules/quality/parts.tsx`: `CheckBadge`, `ClaimBadge`, `EvidenceList`,
`DoneWhenField`, `TaskQualityLine` (regel op een kaart) en `TaskQuality` (alles van één taak, met goedkeuren,
terugsturen, vrijgeven en controle overslaan). Gebruikt door het takenbord (`#/m/rooms/taken`), het taakvenster van
Teamwerk en Wacht op jou (`ReviewInbox`). In de chat: `LoopStopEvent`. Bot-editor: sectie *Werk dat af is*.

## Beperkingen

- Een les geldt voor het team van de bot waar de correctie over ging (en daarmee ook in groepsgesprekken, waar het
  geheugen gedeelde kennis laadt); de eigenaar kan haar terugbrengen naar die ene bot.
- Links in bewijs worden niet geopend; de controle ziet alleen de link.
- In de teamdatabase is de claim een SQL-patroon (`… WHERE id = ? AND status = 'open'`), geen aparte claim.
