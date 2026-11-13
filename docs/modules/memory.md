# Module `memory` — Geheugen & dossiers

Zichtbaar, begrensd geheugen met bronnen, review, versies/undo en betrouwbaar vergeten; plus projectdossiers
(tijdlijn, besluiten, acties, personen/organisaties, bronnen) en compacte gesprekssamenvattingen. Uitwerking van
plan §13, §21.5, §20 F (memory tradeoff), checklist §25 punt 4 en plan 0.4 pakket F ("geheugen: standaard goed").

**Kort:** bots krijgen per beurt een klein, geciteerd geheugenblok, gevonden **op woorden én op betekenis** ("wagen"
vindt "auto"), en alleen als het bericht over het geheugen gaat (een "Leuk, dankjewel!" krijgt geen geheugenregels). Dat
werkt voor iedereen: met het **ingebouwde zoekmodel** (granite-embedding-97m-multilingual-r2 van IBM, Apache-2.0) dat
TeamBot na één ja eenmalig downloadt (±125 MB, draait op de processor, blijft op de pc), met een embedmodel in de eigen
Ollama als extra, en zelfs zonder model, want bij het leren komen er **trefwoorden en synoniemen** bij elk feit en de
woordindex kent een eigen lijst synoniemen (ook voor de kop van Nederlandse samenstellingen: "teamoverleg" → overleg).
Het geheugen **voegt niet alleen toe**: elk nieuw feit wordt vergeleken met wat er al staat (sinds 0.4.4, naar de
consolidatiestap van Hindsight): wat het herhaalt gaat erin op, wat het verandert krijgt een nieuwe versie, wat erdoor
niet meer klopt — ook zonder gedeelde sleutel, en ook wat daar alleen van afhing — gaat uit het actieve geheugen met
*sinds wanneer* en *waarom* (geschiedenis blijft vindbaar als erom gevraagd wordt). **Een taak die af is sluit zichzelf**
("de SEO is bijgewerkt", een kaal "gedaan" na de herinnering van de bot, een bot die het met een tool deed, een routine).
**Een dossier dat verandert** (een nieuwe versie van een document, een notitie, een afgeronde actie) wordt opnieuw gelezen
en zijn NU blijft actueel. **Klantenservice met veel klanten**: elke klant een dossier met een eigen kleine doelomvang;
klanten waar een half jaar niets mee gebeurt gaan naar het archief (wel vindbaar, weer actief als ze terugkomen).
**Vastgezette instructies zijn vaste regels** ("vraag eerst voordat je iets verwijdert"): die staan in de systeemprompt en
vallen nooit weg door het budget, het inpassen in een klein contextvenster of het samenvatten van een gesprek. Het
geheugen **werkt zichzelf bij**, sinds 0.4.5 **uit het hele gesprek**: elke 20 beurten of na een kwartier stilte leest
het model van de bot zelf (Claude Code/Codex op je abonnement met het model van de bot, een lokaal of gratis model; een
ander gratis model als terugval) in één aanroep wat je zelf zei, wat de bot antwoordde en wat zijn tools teruggaven, en
onthoudt feiten, voorkeuren, besluiten, afspraken en mensen, elk met zijn bron (*jij*, *bot* of *tool*). Wat jij zegt
gaat voor; een veranderd feit wordt direct bijgewerkt (nieuwe versie, ongedaan maken) in plaats van een
beoordelingskaart — een kaart komt alleen als een bot of tool tegenspreekt wat jij zelf zei, of bij iets vastgezets;
**"ja, doe maar" op een voorstel van de bot** ("Zal ik onthouden dat …?") telt als jouw
bevestiging. Feiten die met de tijd veranderen (prijzen, versies, regels, afspraken, openingstijden) krijgen een
**herzien op**-datum en worden vernieuwd uit hun bron, door jouw volgende bericht bevestigd, of *te controleren*. Het
geheugen wordt **nooit oneindig groot**: elk deel heeft een doelomvang; kleine dingen over hetzelfde worden samengevat
en wat lang niet gebruikt is en weinig waard gaat naar het archief (niet weg, wel uit de context), nooit wat vastgezet,
door jou bevestigd of vaak gebruikt is; elke maand een kort **opruimverslag** met ongedaan maken. **Dossiers zonder
moeite**: een gesprek over een klant of project wordt vanzelf aan zijn dossier gekoppeld (stand, open acties en besluiten
in elke beurt), een bot zet iets erin met één zin (`dossier_note`), en een klant die terugkomt zonder dossier wordt
voorgesteld. Lessen uit jouw correcties gelden voor **het hele team** van de bot. Elke nacht ruimt onderhoud op, met
een verslag. Dossierbronnen mogen **pdf en Word** zijn. Alles is zichtbaar, heeft een bron, een versiegeschiedenis en
een ongedaan-maakknop; wat uit externe inhoud komt blijft een voorstel; "vergeten" wist ook alle afgeleide kopieën
(index, vectoren, synoniemen, samenvattingen …) en blokkeert opnieuw opslaan. Met meerdere teams heeft elk team zijn
eigen geheugen en dossiers: een bot leest zijn eigen team (en teams waar hij mag meekijken) en schrijft alleen in zijn
eigen team; "Over jou" blijft persoonlijk. De geheugentest (`npm run memory:bench`) meet het, met cijfers in
`docs/quality/memory-bench.md`.

## Wat werkt (per catalogusregel §21.5)

| Regel | Status | Waar |
|---|---|---|
| P0 profielen / altijd-geladen profiel met cap (±4k tokens) | ✔ vastgezette items, `profileCap` per gebruiker/bot; vastgezette instructies als vaste regels buiten elke cap | `context.ts` |
| Vaste regels altijd geladen (0.4 F) | ✔ in de systeemprompt: niet gebudgetteerd, niet weggekort bij een klein venster, niet weg na samenvatten; bij engines met een eigen sessie ook elke beurt | `context.standingRules` |
| P0 gespreksarchief + episode-samenvattingen met citaties | ✔ archief = core-berichten; episodes met bron-id's | `episodes.ts` |
| P0 scopes gebruiker/bot/project | ✔ `about_you`, `agent`, `dossier`, `shared` (+ episodes) | `types.ts`, `service.ts` |
| P0 reviewbare voorstellen | ✔ reviewqueue (goedkeuren/aanpassen/weigeren, bulk) | `pipeline.ts`, UI *Te beoordelen* |
| P0 per-bot / gedeeld geheugen | ✔ botgeheugen standaard privé; delen alleen expliciet | `aclSql` |
| Geheugen per team (0.4 B) | ✔ botnotities, gedeelde kennis, dossiers en samenvattingen per team; lezen in het thuisteam + meekijken, schrijven alleen thuis; regels per team; dubbel en quota per team, vergeten globaal; vakkennis kopiëren | `service.ts` (teams), `teams.ts` |
| P0 lezen/bewerken/vastzetten/vergeten/undo | ✔ | API + UI |
| P0 bronverwijzingen | ✔ `[m:abc123]`-id's in context en tool-output; bronchips onder antwoorden | `context.ts`, `chat.tsx` |
| P0 opslag-/tokenquota | ✔ per scope (aantal/bytes), voorstellen-cap, budget per beurt | `service.ts`, `lifecycle.ts` |
| P0 stale/conflict-queue | ✔ conflictkaarten, controledatum (“klopt dit nog?”) | `pipeline.ts`, `review.tsx` |
| P0 dedup | ✔ exact (HMAC-hash), FTS + token-Jaccard, canonieke sleutel | `service.ts` |
| P0 export/delete over afgeleide stores | ✔ JSON + Markdown; vergeten wist FTS/vectoren/episodes/contexten/tool-output/goedkeuringen/audit | `forget.ts`, `io.ts` |
| P0 zoeken | ✔ FTS5 (prefix, lichte NL/EN-stemming, sterkte per treffer met bm25 en dekking van de zoekwoorden) + **synoniemen** (van de leerder, een eigen NL/EN-lijst en koppen van samenstellingen) + versleutelde items via decrypt-scan + **op betekenis** (ingebouwd model of Ollama, cosinus in TS, opgeteld bij de woordrang in een zachte band) | `service.searchItems`, `synonyms.ts`, `semantic.ts`, `builtin-embed.ts` |
| Zoeken op betekenis voor iedereen (0.4 F2, 0.4.4) | ✔ ingebouwd meertalig model (granite-embedding-97m-multilingual-r2, Apache-2.0, ±125 MB; daarvoor multilingual-e5-small) na één ja, gecontroleerd met SHA-256, op de processor; wie het oude model had krijgt het nieuwe vanzelf; Ollama als extra | `builtin-embed.ts`, `semantic.ts` |
| Alleen relevante regels per beurt (0.4.4) | ✔ een gemeten drempel (gaat dit bericht over het geheugen?) en daarna 40 % van de sterkste treffer, max. 4 | `context.aboutMemory` |
| Bijwerken bij schrijven (0.4.4) | ✔ elk nieuw feit tegen wat lijkt: herhaalt / verandert / beëindigt (ook impliciet en wat ervan afhing), met reden en undo; vaste patronen zonder model, één modelaanroep per leerbatch, 's nachts de rest | `consolidate.ts` |
| Geldigheid in de tijd (0.4.4) | ✔ `valid_from`/`valid_to` + `invalid_reason`; vragen over nu zien alleen wat geldt, `memory_search {history:true}` ook wat gold | `service.aclSql`, `context.itemLine` |
| Taken sluiten zichzelf (0.4.4) | ✔ eigen taaknotities en dossieracties: de eigenaar zegt het, "gedaan" na de herinnering van de bot, een bot met bewijs, een routine | `consolidate.ts` (`captureDone`, `closeFromRun`) |
| Een dossier dat verandert (0.4.4) | ✔ nieuwe versie van een document vervangt de oude; alleen wat niet meer in de nieuwe tekst staat wordt opnieuw gelezen; NU actueel | `reread.ts` |
| Klantenservice op schaal (0.4.4) | ✔ doelomvang per klantdossier, inactieve klanten naar het archief (vindbaar, weer actief bij terugkomst), werkset- en totaallimiet voor dossiers | `cleanup.ts`, `dossier-auto.ts`, `dossiers.ts` |
| Zelf bijwerken (0.4 F2) | ✔ *herzien op* voor prijzen, versies, regels, afspraken, openingstijden, contact; vernieuwd uit dezelfde bron, bevestigd door de eigenaar, opnieuw gelezen uit een dossierdocument, of *te controleren* | `refresh.ts`, `pipeline.ts` |
| Nooit oneindig groot (0.4 F2) | ✔ doelomvang per deel, samenvatten met bronnen, archief (vindbaar, terug te zetten), begrensd archief, maandelijks opruimverslag met undo | `cleanup.ts` |
| Dossiers zonder moeite (0.4 F2) | ✔ vanzelf koppelen op naam, stand in elke beurt, `dossier_note` (één zin), voorstel voor een terugkerend onderwerp | `dossier-auto.ts` |
| Lessen voor het team (0.4 F2) | ✔ een les uit een correctie is gedeelde kennis van het team van de bot; terug te brengen naar één bot | `quality/lessons.ts`, UI |
| P0 auto-leren aan/uit | ✔ uit / alleen expliciet / automatisch leren + pauze; per bot te overschrijven | Opslag, bot-editor |
| Slim leren (zelf bijwerkend) | ✔ één aanroep per batch (elke 20 beurten of na 15 min stilte) met het model van de bot, een gratis model als terugval, strikte JSON, bewijs + verankering, veranderd feit = supersede met undo, vaste patronen als laatste terugval | `learn.ts`, `engine.ts` |
| Leren uit het hele gesprek (0.4.5) | ✔ ook antwoorden van de bot en tool-uitvoer, bron per feit (eigenaar / bot / tool), de eigenaar wint, een feit van een bot alleen met werk (een tool), niets van een pagina die een AI iets opdraagt, geen sleutels, teammuren | `learn.ts`, `pipeline.ts` |
| "Ja, doe maar" op een voorstel van de bot (0.4 F) | ✔ alleen een kaal "ja" direct na een concreet voorstel; feit in jouw woorden, undo onder je antwoord; voorstel van `memory_remember` wordt goedgekeurd | `confirm.ts` |
| Onderhoud (nacht + op verzoek) | ✔ samenvoegen, tegenspraak, verlopen, feiten herzien, dossiers bijwerken (tijdlijn/besluiten/acties/NU, kort gehouden), kernprofiel binnen budget, doelomvang, verslag met undo; elke maand een opruimverslag | `maintenance.ts`, `refresh.ts`, `cleanup.ts` |
| “Wat ik over je weet” | ✔ profielweergave (gegroepeerd, inline bewerken, altijd-bekend), recent geleerd met bron/tijd/hoe | `learned.tsx` |
| P1 dossierobjecten (personen, organisaties, events, besluiten, acties, eigenaren, datums, bronnen) | ✔ | `dossiers.ts` |
| P1 tijdlijn/relaties | ✔ tijdlijn; entity-resolutie op naam/alias (relaties = koppeling aan dossier) | |
| P1 documenten indexeren met ACL | ✔ tekst, **pdf** (pdf.js) en **Word** (.docx via adm-zip) worden in stukken geïndexeerd (woorden + betekenis), geciteerd als `[s:…]`, alleen via dossiertoegang | `addSourceAsync`, `addSource` |
| P1 topic-bestanden | ✔ als dossiers (on-demand via `dossier_get`), niet altijd geladen | |
| P1 import uit andere assistent | ✔ Markdown/JSON/tekst plakken → voorstellen; sinds 0.4.4 met de vraag voor ChatGPT, Claude of Gemini, een voorbeeld vooraf en ongedaan maken (zie *Geheugen overnemen uit een andere assistent*) | `io.ts`, `assistant-import.ts` |
| P1 automatische entity-resolutie en consolidatie | ✔ entity-merge; samenvatten binnen de doelomvang door het onderhoud (met bronnen, undo); "Samenvoegen" op verzoek blijft een voorstel | `cleanup.ts`, `lifecycle.consolidate` |
| P1 back-ups/restore met tombstone-bescherming | ✔ bij terugzetten gaan de vergeet-blokkades van nu mee (`restore-tombstones.json`), wat ze raken wordt opnieuw vergeten, daarna wordt de FTS herbouwd en worden de vectoren tegen hun records gecontroleerd | `index.ts` |

## Levende dossiers (0.4.4, `living.ts`)

Het geheugen dat een bot altijd ziet, is een kleine set dossiers met een lopende tekst (`memory_dossiers.body`) die
de bots zelf bijhouden. Geen instelling: het werkt op een lege installatie vanaf het eerste bericht.

- **Kerndossiers** (`memory_dossiers.core`), leeg aangemaakt zodra ze nodig zijn, met neutrale namen:
  `owner` *Eigenaar* (één, voor alle teams), `overview` *Overzicht* en `lessons` *Lessen* (per team), `notes`
  *Werknotities van <bot>* (per bot, het enige dat privé is). Ze staan in de **systeemprompt** van elke beurt
  (`systemPromptText` → `coreContext`), dus bij elke engine; een engine met een eigen sessie (Codex, ACP) krijgt ze
  ook in de beurt waarin ze veranderden. Niet in een gesprek waar anderen meelezen of met een klant.
- **Andere dossiers** (een project, klant, persoon, onderwerp) staan er op titel bij; de tekst komt mee zodra het
  gesprek het dossier noemt (bestaande koppeling) of via `dossier_get`.
- **Schrijven**: `dossier_write` met `add` (standaard; wat er al staat komt er niet nog eens bij), `replace`
  (`old_text` precies één keer) of `rewrite`. Een onbekende naam maakt een nieuw dossier voor het hele team.
  Geweigerd: geheimen, iets dat op verzoek is vergeten, een geplante instructie na inhoud van buiten, en een tekst
  boven het maximum (`BODY_LIMITS`: 5000 / 6000 / 3000 / 3000 tekens voor de kerndossiers, 8000 voor een onderwerp).
  De bot krijgt de getallen terug en schrijft het dossier eerst korter.
- **Archief en geschiedenis**: regels die uit een dossier verdwijnen, worden een tijdlijnregel van dat dossier
  (`memory_records`, `data.archive`), vindbaar met `memory_search`; elke schrijfactie bewaart de vorige tekst in
  `memory_changes` (ongedaan maken).
- **Losse notities** (`memory_remember`, en wat de leerstap opvangt) zijn standaard gedeeld met het team en staan
  onder de dossiers in beeld tot een bot ze in een dossier zet (`processed`, of vanzelf als de woorden erin staan);
  dan gaan ze naar het archief.
- **Update van een oudere installatie**: `foldOnce` zet één keer, zonder model, de losse notities onder een paar
  kopjes in de kerndossiers (dubbele regels één keer), archiveert ze in één batch (één keer ongedaan maken zet alles
  terug) en laat alles wat niet duidelijk past staan. De hoofdbot krijgt één regel in zijn werknotities om de
  dossiers na te lopen; er wordt geen routine of taak aangemaakt.

Tests: `tests/memory-living.test.ts` (de eerste test is een lege installatie).

## Geheugen overnemen uit een andere assistent (0.4.4)

**Geheugen › Opslag › Geheugen overnemen uit ChatGPT, Claude of Gemini** (`ui/src/modules/memory/assistant-import.tsx`,
server `assistant-import.ts`):

1. De pagina toont de vraag die de eigenaar in de andere assistent stelt (één feit per regel, onder kopjes, zonder
   geheimen), met **Kopieer de vraag**.
2. Hij plakt het antwoord. `normalizeAssistantExport` haalt het praten van de assistent eromheen weg ("Hier is wat ik
   over je weet:", "Laat me weten …"), houdt kopjes (vet of `#`) als hint voor het soort, haalt opmaak uit een feit
   (`**Taal:** Nederlands`) en splitst lopende tekst in zinnen. De data-export van Claude (`conversations_memory` en
   `project_memories`) wordt ook gelezen; andere JSON gaat naar de bestaande parser (`memories`, `items`, `facts` …).
3. `POST /memory/import/preview` schrijft niets en zegt per regel: **Nieuw**, **Staat er al** (exact of bijna gelijk,
   ≥ 0,9), **Dubbel in de tekst**, **Geheim: overgeslagen** (de inhoud wordt niet teruggegeven), **Eerder vergeten** of
   **Eerder afgewezen**; een regel die als opdracht leest krijgt een melding (hij blijft gewone tekst).
4. `POST /memory/import/assistant { text, source: chatgpt|claude|gemini|other, scope: about_you|shared, teamId? }`
   gaat door `importText`: elke regel een **voorstel** (Te beoordelen), nooit direct actief; de pijplijn weigert
   geheimen en maakt van een botsing een beoordelingskaart. Bron `import`, `source_ref` = `<batch>:uit ChatGPT`.
5. `POST /memory/import/:batch/undo` maakt de hele import ongedaan: per item de eigen wijzigingen, nieuwste eerst (ook
   wat al was goedgekeurd); het item gaat naar de prullenbak en zijn importsleutel vervalt, zodat dezelfde tekst later
   opnieuw kan. `GET /memory/import/recent` geeft de laatste 10 imports met wat er nog van staat.

Audit: `memory.assistant_imported`, `memory.import_undone`. Tests: `tests/memory-assistant-import.test.ts`, UI in
`tests/e2e/switch-skills.mjs` (computer en gekoppelde telefoon).

## Datamodel (migraties `memory-001` … `memory-009`)

`memory-009` (0.4.5): de tabel `memory_fts_rows` (`kind`, `rid`, `row`, `user_id`): waar elk record in `memory_fts`
staat, zodat een schrijfactie zijn oude rij op rowid verwijdert in plaats van de hele FTS-tabel te lezen (gevuld uit wat
er stond; van een dubbele rij blijft de nieuwste).

`memory-008` (0.4.5): de tabel `memory_customer_ids` (wie er schrijft → welk klantdossier: `user_id`, `team_id`
(`''` = standaardteam), `dossier_id`, `adapter`, `binding_id`, `ext_hash` = HMAC van de genormaliseerde afzender,
`label`, `strength` `channel`/`email-auth`/`owner`, `created_at`, `last_seen_at`; uniek op koppeling + team + hash),
`memory_episodes.archived_at` (samenvatting van een klantgesprek in het archief) en een index op
`memory_items(dossier_id, status)`. Zie "Geheugen per klant".

`memory-007` (0.4.4): op `memory_items` `invalid_reason` (waarom het niet meer geldt: het nieuwere feit, "afgerond",
een veranderd document; `valid_to` = sinds wanneer) en `consolidated_at` (wanneer een model het tegen het bestaande
controleerde); op `memory_dossiers` `changed_at` / `reread_at` (de inhoud veranderde / wanneer het dossier opnieuw
gelezen is); op `memory_sources` `replaces_id` (een nieuwe versie van hetzelfde document).

`memory-005` (0.4 B): `team_id` op `memory_items`, `memory_dossiers` en `memory_episodes`, `copy_of` op items,
dossiers, records en bronnen (zie "Geheugen per team").
`memory-006` (0.4 F2): op `memory_items` `terms` (trefwoorden en synoniemen, alleen voor de woordindex), `review_kind`
(soort veranderend feit) en `review_note` (waarom *te controleren*); de tabel `memory_subjects` (terugkerende klanten,
projecten en onderwerpen per team, met de gesprekken, wachtende notities en status gezien/voorgesteld/gemaakt/niet
nodig); `memory_meta.last_cleanup_month`.

| Tabel | Doel (plan-object) |
|---|---|
| `memory_items` | **MemoryItem**: scope, `agent_id`, `dossier_id`, type, `canonical_key`/`key_norm`, `content` (of `content_enc` bij *gevoelig*), `hash` (HMAC), bron (`source_kind/ref/thread_id/excerpt/trust` = SourceRef), confidence, sensitivity, status (active/proposed/archived/superseded/trashed/rejected/forgotten), `proposal_reason`, `conflict_with`, `merge_of`, flags (external/tainted/instruction/injection), pinned, `observed_at`, `valid_from/to`, `expires_at`, `review_at`, `last_confirmed_at`, `version`, `supersedes_id`/`superseded_by`, attributie (`created_by`, `created_by_agent`, `origin_run_id`, `origin_call_id`), `idem_key`, gebruik (`use_count`, `last_used_at`), `bytes`, `ref` (kort citeer-id) |
| `memory_changes` | **MemoryChange**: elke create/propose/approve/reject/update/supersede/merge/archive/trash/restore/expire/forget/undo met before/after-snapshot, actor, reden, batch (één undo voor samenhangende wijzigingen), `undo_until`, `redacted` |
| `memory_tombstones` | Vergeet-blokkades (`kind=forget`, geen verval) en afwijs-vingerafdrukken (`kind=reject`, 90 dagen). Alleen HMAC's van inhoud, sleutel en tokens + een neutraal label — **geen inhoud** |
| `memory_dossiers` | **Dossier**: titel, soort, samenvatting, status, `agent_ids` (null = alle bots van de eigenaar), tags, pinned, versie |
| `memory_dossier_acl` | Delen met andere gebruikers op de server (lezen/bewerken) |
| `memory_records` | **Event / Decision / ActionItem / entiteit** in één tabel (`kind`): titel, body, `occurred_at`, `owner`, `due_at`, status, `data` (vraag, aliassen, feiten, conflict, afgerond-bron), `sources`, `supersedes_id` |
| `memory_sources`, `memory_chunks` | Dossierbronnen (url/bestand/bijlage/notitie) en geïndexeerde tekststukken (afgeleid, herbouwbaar) |
| `memory_episodes` | Gesprekssamenvatting per thread: samenvatting, besluiten, acties, open vragen (elk met bericht-id), `agent_ids`, `upto_seq` |
| `memory_usage` | Wat een bot per beurt (context) of via tools gebruikte — voor de inspector en om herhaling te voorkomen |
| `memory_msg_flags` | Per gebruikersbericht: “niet onthouden”, “vergeet”, uitkomst van “onthoud dit” |
| `memory_links` | Gesprek ↔ dossier-koppeling (inspector) |
| `memory_meta` | Tellers voor consolidatie, quota-meldingen, model-aanroepen per dag, leerstatistiek van vandaag (`learn_stats`: aanroepen, ms, kosten, tokens, laatste engine), laatste onderhoud/nacht |
| `memory_learn` | Leerwachtrij: één rij per gesprek met `upto_seq` (tot waar geleerd), `due_at` (na stilte), status, laatste engine/fout/resultaat. Persistent, dus een herstart verliest niets |
| `memory_reports` | Onderhoudsverslagen: trigger (nacht/handmatig), engine, aanroepen, latentie, kosten, tellingen, regels met eigen `changeIds` (undo per regel) |
| `memory_rollups` | Per dossier ↔ gesprek tot welke episode-versie al in het dossier is verwerkt (+ de tijdlijnregel) |
| `memory_fts` | FTS5-index (`unicode61 remove_diacritics`), **afgeleid en herbouwbaar** (`POST /api/memory/reindex`) |
| `memory_vectors` | Zoeken op betekenis (`memory-004`): per actief/voorgesteld item en per documentdeel één vector (float32, lengte 1) met model (`builtin:granite-embedding-97m-multilingual-r2` of de naam in Ollama), dimensie en `text_hash` (HMAC van de tekst, geen inhoud). **Afgeleid** zoals `memory_fts`: nooit voor gevoelige items, weg met het record (ook bij archiveren), herbouwd door reindex, niet geëxporteerd |
| `memory_subjects` | Terugkerende onderwerpen (`memory-006`): naam, soort, team, gesprekken, wachtende notities, status, gemaakt dossier |

Instellingen: per gebruiker in `settings` (key `memory`), per bot in `agent.settings.memory`, serverlimieten in
`settings('', 'memory.limits')`. Sinds 0.4.5: `extractor` `own` (standaard: het model van de bot) / `free` (zuinig
gratis model) / `heuristic` / `model` (ook als het geld kost), `learnEvery` (beurten, standaard 20; 0 = alleen na stilte)
en `quietMin` standaard 15 (was 5); wie een eigen waarde had opgeslagen houdt die. HMAC-sleutel: `ctx.secrets` (systeemgebruiker `''`, nooit zichtbaar in de API).
Nieuw in 0.4: `semantic` (`auto` standaard / `off`) en `semanticModel` (null = automatisch; `builtin:…` = het ingebouwde
model, ook de oude waarde `builtin:multilingual-e5-small`); F2: `targets` (doelomvang per deel: Over jou 200, per bot per
team 250, gedeeld per team 400, per dossier 600, en sinds 0.4.4 per klantdossier 40; altijd onder het quotum),
`archiveAfterDays` (180, ook voor klanten), `dossierAuto` (`propose` standaard / `create` / `off`). Serverlimieten (0.4.4):
`dossiers` (actieve dossiers per eigenaar, standaard 1000) en `dossiersTotal` (met het archief, standaard 10.000); vóór
0.4.4 was het één grens van 500 die ook het archief meetelde.
Het ja voor het ingebouwde model geldt voor de hele installatie (`settings('', 'memory.builtin')`; het is één download);
"Niet nu" op de kaart per gebruiker (`memory.builtinOffer`).

## Leesroute (per beurt)

- **systemPrompt-hook**: vaste, korte uitleg (geen variabele inhoud → prompt caching blijft geldig): geheugen is data,
  citeer `[id]`, zeg het als je geen bron hebt, wanneer tools te gebruiken, en "vraag het met het feit erbij: Zal ik
  onthouden dat …?". Daaronder de sectie **`## Vaste regels van de eigenaar`** (zie hieronder): stabiele volgorde, geen
  datums, verandert alleen als de eigenaar een regel vastzet, aanpast of losmaakt.
- **turnContext-hook** (async) levert een begrensd blok `<geheugen …>`:
  1. *Vastgezet* (profiel) tot `profileCap` tokens — zonder de vaste regels, die staan al in de systeemprompt;
  2. *Dossier van dit gesprek* (0.4 F2): het gekoppelde dossier eerst (samenvatting, laatste 3 besluiten, tot 6 open
     acties met eigenaar en deadline). Noemt het bericht van de eigenaar (of de taak, of de opdracht van een andere bot)
     een dossier van het eigen team bij naam of tag, dan koppelt TeamBot het gesprek er eerst aan (`autoLinkThread`) en
     hoort de bot dat;
  3. *Relevant*: woorden (FTS-prefix, met synoniemen) + decrypt-scan van gevoelige items + **betekenis** (vector van de
     vraag, max. 2,5 s; een koud model geeft die beurt alleen woorden). Elke treffer heeft een sterkte (`match` = woorden
     naar bm25 tegenover de beste treffer, gewogen naar hoeveel zoekwoorden hij dekt, plus betekenis in een zachte band
     rond de beste treffer). Eerst de vraag of het bericht **over het geheugen gaat** (0.4.4, `aboutMemory`): bij een
     gemeten model (het ingebouwde) moet de beste gelijkenis minstens 0,77 zijn of moet een notitie de zoekwoorden goed
     dekken; anders komt er geen enkele regel (een praatje als "Leuk, dankjewel!" kreeg vóór 0.4.4 gemiddeld 4,9
     geheugenregels). Dan alleen treffers met minstens 40 % van de beste, max. 4; zonder model (alleen woorden) 65 %,
     max. 6. Daarna kleine tiebreakers (vastgezet, recent, zeker, vaak gebruikt); tot `budgetTokens` (standaard 1200;
     per bot instelbaar, 0 = alleen tools). Niets gevonden bij een vraag die wel over het geheugen gaat: de 2 laatste
     notities van de bot onder een eigen kopje ("niet gevonden bij deze vraag");
  4. *Dossiers*: max. 2 andere passende (samenvatting, laatste besluiten, open acties met eigenaar/deadline);
  5. *Documenten*: max. 2 passende stukken uit dossierbronnen (woorden + betekenis; ook uit pdf en Word);
  6. *Eerdere gesprekken*: max. 2 episodes van dezelfde bot (alleen privégesprekken); niet een samenvatting die alleen
     herhaalt wat inmiddels niet meer geldt (een afgeronde taak).
  Een notitie in een **gearchiveerd klantdossier** staat nooit in het blok; `memory_search` en `dossier_get` vinden
  haar wel, en een gesprek dat de klant noemt maakt het dossier weer actief.
  Een feit waarvan de herzien-datum voorbij is staat er met "kan veranderd zijn", een feit dat het onderhoud niet kon
  bevestigen met "te controleren"; de systeemprompt zegt de bot dat hij dat dan eerlijk zegt en het vraagt als het
  ertoe doet.
  Items die in de laatste 10 beurten van dit gesprek al gegeven zijn (zelfde versie) worden niet herhaald
  (“Al eerder in dit gesprek gegeven: m:…”). Bij budgetoverschrijding staat er hoeveel er is weggelaten en dat
  `memory_search` meer kan vinden — nooit stil. De vaste regels tellen als gebruikt (inspector, bronnen onder
  antwoorden), zonder tokens in dit blok.
- **Publiek per gesprekstype** (`audience`): *privé* = alles wat de bot mag lezen; *room* (meerdere bots) = in het
  bevroren blok alleen expliciet gedeelde kennis en dossiers voor alle bots (privénotities via tools, die andere bots
  niet zien); *publiek* (andere mensen/kanalen) = geen “Over jou”, geen persoonlijke/gevoelige items, geen dossiers of
  episodes; *klant* (0.4.5, een herkende klant in een privégesprek op een kanaal met klantenservice) = alleen het
  dossier van die klant (zie "Geheugen per klant").
- Gebruik wordt vastgelegd in `memory_usage` (inspector-tab “Geheugen”: *Deze beurt gebruikt*).

## Vaste regels: altijd geladen (0.4 F)

Aanleiding (onderzoek, plan 0.4 "veiligheid in de code, niet in de instructie"): een agent wiste een inbox nadat zijn
instructie "eerst bevestigen" bij het samenvatten van de context was weggevallen. Vóór 0.4 ging een vastgezette
instructie per beurt in het bevroren `<geheugen>`-blok, werd daarna 10 beurten niet herhaald ("al eerder gegeven") en
kon dus verdwijnen zodra die oude beurt werd weggekort (geschiedenisbudget, inpassen in het venster van een lokaal
model) of samengevat. Ook viel een vastgezette instructie boven `profileCap` weg, en bij `budgetTokens = 0` en
`profileCap = 0` ging er helemaal niets mee.

Nu (`context.standingRules`):
- **Wat**: actieve, vastgezette items van type *instructie* die de bot mag lezen: zijn eigen botnotities, "Over jou"
  (als `readAboutYou`) en gedeelde (als `readShared`). Nooit met externe herkomst (`source_trust = external`, vlag
  external/tainted/injection). Met anderen in het gesprek (kanaal, gedeeld gesprek) alleen *normale* regels (geen
  persoonlijke); in een groep geen gevoelige. Instructies in een dossier blijven gewone profielregels.
- **Waar**: in de systeemprompt, sectie `## Vaste regels van de eigenaar`. Die wordt bij elke modelaanroep volledig
  meegestuurd: `buildHistory` kort alleen berichten in, `fitToWindow` (lokale modellen) laat de systeemprompt altijd
  staan en de samenvatting (`compaction.ts`) vervangt alleen oude berichten. Claude Code krijgt de systeemprompt elke
  beurt; Codex en ACP-agents (OpenCode …) krijgen hem bij de start van hun sessie en daarna als bijgewerkte sectie,
  en omdat die engines hun sessie ook zelf kunnen samenvatten, krijgen zij de regels **ook elke beurt** bovenaan de
  per-beurt-context.
- **Grenzen**: geen budget en geen profielcap; een veiligheidsgrens van 100 regels (daarboven een eerlijke regel in de
  prompt). In de UI heten ze "Vaste regel" (badge) en Opslag legt het uit.
- Dit is een aanvulling op, geen vervanging van, de Broker: verwijderen, verzenden en betalen vragen in de code al om
  toestemming.

## Zoeken op betekenis voor iedereen (0.4 F, F2)

`semantic.ts`, `builtin-embed.ts`. Naast woorden vindt het geheugen ook wat in andere woorden staat ("wagen" ↔ "auto",
"zonnestroom" ↔ "zonnepanelen", "wie doet mijn administratie?" ↔ "Mijn boekhouder is Karin").
- **Engine**, in deze volgorde: het model dat de eigenaar in Opslag koos; een ingeschakelde Ollama-provider op een
  **loopback-adres** (127.0.0.1, localhost, ::1) met een geïnstalleerd embedmodel (voorkeurslijst, meertalig eerst:
  bge-m3, qwen3-embedding, embeddinggemma, …, anders elk model dat Ollama als "embedding" meldt); anders het
  **ingebouwde model** als het gedownload is. Zo verandert er niets voor wie al een embedmodel in Ollama had, en werkt
  het voor iedereen anders ook. Een Ollama op een ander adres wordt nooit gebruikt (het geheugen blijft op deze pc).
- **Het ingebouwde model** (sinds 0.4.4): granite-embedding-97m-multilingual-r2 (IBM, **Apache-2.0**, 200+ talen met
  extra training voor 52 waaronder Nederlands, 384 dimensies), getraind op data met vrije, zakelijk bruikbare licenties.
  IBM's eigen uint8-ONNX (`onnx/model_quint8_avx2.onnx`, draait op elke x64/ARM-cpu). Drie bestanden, samen 123.562.410
  bytes: `model.onnx` (98.247.878 bytes, SHA-256 `a6022dd8…78772e`), `tokenizer.json` (25.301.672, `4f2842d5…1582f`) en
  `tokenizer_config.json` (12.860, `6ed69389…57d5`), van
  `huggingface.co/ibm-granite/granite-embedding-97m-multilingual-r2/resolve/835ad140…/…`. Draait met **ONNX Runtime**
  (`onnxruntime-node`, MIT, Microsoft) en de tokenizer van Hugging Face (`@huggingface/tokenizers`, Apache-2.0, puur
  JS), geladen met `require` bij het eerste gebruik; een build zonder die pakketten zegt eerlijk dat het hier niet kan
  (status `no-runtime`) en zoekt op woorden. CLS-pooling (het eerste token), lengte 1, geen voorvoegsels, max. 1024
  tokens (het model kan 32k; notities en documentdelen zijn kort), 1–4 threads van ONNX Runtime zelf (de event loop
  blijft vrij), sessie na 10 min zonder gebruik vrijgegeven. Gemeten op een Ryzen 7 7800X3D: ±6 ms per zoekvraag.
  Gekozen op de geheugentest: op betekenis alleen recall@1 60 % / @5 81 %, tegen multilingual-e5-small (het model tot
  0.4.4, MIT) 44 % / 76 %; e5 zette ook een praatje even dicht bij een notitie als een echte vraag, granite niet.
- **Downloaden alleen na ja**: een rustige kaart in het Overzicht, één keer: "Slim zoeken aanzetten? (± 125 MB, blijft op
  je pc)" met *Aanzetten* / *Niet nu*; ook in Opslag. Op een server alleen de eigenaar of een beheerder. Eén keer per
  installatie, naar `<data>/models/embed/granite-embedding-97m-multilingual-r2`; elk bestand wordt tijdens het downloaden
  gehasht en pas gebruikt als grootte en SHA-256 kloppen (anders weggegooid, met de fout in Opslag); daarna een
  `verified.json`, zodat het bij het starten niet opnieuw hasht. *Ingebouwd zoekmodel verwijderen* in Opslag haalt
  bestanden en vectoren weg. Er gaat nooit iets van het geheugen naar buiten.
- **Van e5 naar granite** (0.4.4): het ja gold voor "het ingebouwde zoekmodel" (installatiebreed). Een installatie die ja
  zei tegen e5 haalt bij de start granite op de achtergrond (kleiner dan e5); tot het klaar is zoekt TeamBot op woorden,
  daarna worden de vectoren opnieuw gemaakt en gaat de map van e5 weg. Een opgeslagen keuze `builtin:multilingual-e5-small`
  betekent "het ingebouwde model".
- **Opslag**: `memory_vectors` (zie datamodel). `syncIndex`/`unindex` laten een vector in **dezelfde transactie** als de
  wijziging vallen (vergeten, prullenbak, archief, gevoelig, nieuwe tekst); de indexer op de achtergrond (1×/min en
  direct na een wijziging, single-flight, batches) maakt wat ontbreekt en schrijft alleen als het record nog dezelfde
  tekst heeft. Ander model → oude vectoren weg en opnieuw.
- **Zoeken**: de vraag wordt één keer ingebed (cache van 200); cosinus in TS over de vectoren die de lezer mag zien (de
  query joint de brontabel met dezelfde ACL als woordzoeken). Per model een ondergrens en, voor het ingebouwde model, een
  **zachte band rond de beste treffer** (score `exp((sim − beste) / 0,02)`: de beste 1, een treffer 0,06 lager telt niet
  meer) en een gemeten **drempel** voor het per-beurtblok (0,77: het juiste feit scoort 0,74–0,86, de beste notitie bij
  een praatje 0,72–0,79). Daarna `woorden · dekking + betekenis` (bij granite tellen woorden even zwaar; bij een ander
  model 0,8; zonder model alleen woorden), max. 20 betekenistreffers, en kleine tiebreakers. Gemeten (geheugentest,
  0.4.4): recall@1 60 % en recall@5 86 % tegen 40 % en 79 % met e5 en de oude menging `max + 0,25·min`. Een
  herrangschikker (cross-encoder) gaf op deze set nog +7 punten recall@1, maar de enige kleine meertalige
  (mmarco-mMiniLMv2) is getraind op MS MARCO, dat alleen niet-commercieel gebruikt mag worden; daarom niet meegenomen.
  Gebruikt in de per-beurt-context, `memory_search`, `dossier_get` (query), `GET /memory/search` en
  `GET /memory/items?q=`; resultaten krijgen `meaning: true` ("Ook gevonden op betekenis").
- **Zonder model** (of uit): woorden met synoniemen (zie hieronder). Valt Ollama weg, dan wacht een beurt hooguit 2,5 s
  en zegt Opslag "Ollama reageert niet"; een fout van het ingebouwde model komt hooguit één keer per uur in het log en
  die beurt zoekt op woorden.
- **Opslag › Zoeken op betekenis**: aan/uit, status, welk model (ingebouwd of Ollama), hoeveel herinneringen en
  documentdelen al op betekenis doorzoekbaar zijn, de knop voor het ingebouwde model met voortgang, en voor wie Ollama
  heeft nog steeds **"bge-m3 downloaden"** (±1,2 GB via Ollama `/api/pull`).

## Synoniemen bij het leren (0.4 F2)

`synonyms.ts`. Zodat ook zoeken op woorden op betekenis vindt, zonder enig model:
- **Van de leerder, in dezelfde aanroep**: bij elk item geeft het gratis model 3–8 trefwoorden en synoniemen in het
  Nederlands én Engels (`terms`: bij "Mijn auto is een blauwe Volvo" bijv. wagen, car, voertuig). Geen extra aanroep per
  feit. Opgeschoond (`cleanTerms`): korte woorden of woordparen, geen geheimen, niets dat op een opdracht lijkt, wat al in
  de tekst staat eruit, max. 10. Ze staan in `memory_items.terms` en **alleen** in de woordindex, nooit als inhoud; nooit
  bij gevoelige items; weg bij vergeten (en met de rest van de snapshot uit de geschiedenis). Een duplicaat van een
  bestaand feit voegt zijn nieuwe termen toe.
- **Een eigen lijst**: ±200 groepen gewone woorden over thuis, gezin, huisdieren, gezondheid, eten, geld, werk, winkel,
  software en tijd (Nederlands en Engels), bewust krap (echte synoniemen en vertalingen), zelf samengesteld. Bij het
  indexeren komen de synoniemen van de woorden in een item, dossiertitel of dossierregel mee. In 0.4.4 strakker: een
  afspraak is geen vergadering meer, en "training" hoort alleen bij sport (niet ook bij cursus).
- **Samenstellingen** (0.4.4, `compoundHead`): het laatste deel van een Nederlands samengesteld woord draagt de betekenis
  ("teamoverleg" is een overleg, "webwinkel" een winkel, "schoonvader" een vader). Is dat deel een bekend woord van de
  lijst (minstens 5 letters, na minstens 3), dan komt het met zijn synoniemen in de index en in de zoekvraag. Te
  dubbelzinnige koppen tellen niet ("spaarrekening" is geen factuur, "e-mailadres" geen woonadres, "zakenpartner" geen
  echtgenoot).
- In de geheugentest verdubbelt dit recall@5 van zoeken op woorden (19 % → 42 %) en de precisie van het blok
  (12 % → 25 %).

## "Ja, doe maar" op een voorstel van de bot (0.4 F)

`confirm.ts`, vóór `captureExplicit` in de hook `messageCreated` (dus vóór het antwoord van de bot). Precisie eerst:
- Het bericht van de eigenaar is alleen een "ja" (ja, ja graag, doe maar, klopt, prima, oké, yes please, 👍 …; max. 8
  woorden, geen vraag, geen "maar …", geen "niet"), in een privégesprek.
- Het bericht direct daarvoor is een afgerond antwoord van de bot van dit gesprek dat **eindigt** (laatste 3 zinnen)
  met een concreet voorstel: "Zal ik onthouden dat je hond Bram heet?", "Wil je dat ik onthoud: …?", "Shall I remember
  that …?" (opslaan/bewaren alleen met "geheugen" erbij). Het feit wordt naar jouw woorden gezet ("je hond Bram heet" →
  "Mijn hond heet Bram", "je in Utrecht woont" → "Ik woon in Utrecht"); lukt dat niet zeker (bijv. "jullie", een
  onbekende werkwoordsvorm), dan wordt niets opgeslagen en hoort de bot dat.
- Opslaan gaat door de gewone pijplijn als jouw expliciete wens (`origin explicit`, bron = jouw "ja", fragment = de
  vraag van de bot), met "Onthouden · Ongedaan maken" onder je antwoord en een melding in de context van de bot. Las de
  bot in die beurt externe inhoud (web, mail, bestanden), dan blijft het een voorstel (`tainted`); iets dat op een
  instructie lijkt wordt door de pijplijn geweigerd of een voorstel.
- Had de bot in die beurt al een voorstel gedaan met `memory_remember` (bijv. iets "over jou") en noemt zijn antwoord
  dat en vraagt hij erom, dan keurt "ja" dat voorstel goed (max. 3); ongedaan maken zet het terug naar voorstel.
- Een vaag voorstel ("Zal ik dat voor je onthouden?") slaat niets op; de bot hoort dat hij het feit moet noemen of
  `memory_remember` moet gebruiken.

## Schrijfpijplijn (plan §13 stap 1–10)

Bronnen van kandidaten: expliciet “onthoud dat …” en "ja, doe maar" op een voorstel van de bot (hook
`messageCreated`, vóór het antwoord), `memory_remember`, slim leren na een stil gesprek (zie hieronder; zonder gratis
model direct de vaste patronen na elke run), handmatige invoer, import, onderhoud/consolidatie, andere modules
(`ctx.services.memory.remember`).

1. **Capture** — alleen de eigen woorden van de eigenaar tellen als intentie: citaten (`>`), codeblokken,
   doorgestuurde berichten, externe auteurs (kanaal/webhook), andere leden en routines niet. Sinds 0.4.5 leest het
   slim leren ook het werk van de bot (zijn antwoord na een tool en de tool-uitvoer): dat zijn feiten van de bot
   (`learned: bot|tool`, vertrouwen `agent`), nooit intenties van de eigenaar (zie *Slim leren*).
2. **Classificeer** — type, canonieke sleutel (woonplaats, naam, …), gevoeligheid (detectie + max met opgegeven),
   flags (instructie, injectie, extern, tainted), zekerheid naar bronbetrouwbaarheid.
3. **Intent/blokkades** — geheimen (API-sleutels, tokens, wachtwoorden/pincodes, betaalkaarten via Luhn, BSN) →
   geweigerd, nergens opgeslagen (ook niet in history/audit). Externe tekst die op een opdracht lijkt
   (doorsturen/betalen/negeer-instructies/commando's) → geweigerd, net als zulke tekst die de leerder uit een
   botantwoord of tool-uitvoer haalde (0.4.5). Vergeet-tombstone → geblokkeerd. Eerder afgewezen
   → niet opnieuw voorgesteld (90 dagen). “Niet onthouden” in het bericht → niets uit deze beurt.
4. **Dedup** — exacte HMAC-hash per bucket; FTS-kandidaten + token-Jaccard ≥ 0,9 = (bijna) duplicaat → alleen
   `last_confirmed_at` bijwerken (en, als het feit aan zijn herzien-datum toe was, de volgende datum en de nieuwe
   synoniemen erbij).
5. **Conflict** — zelfde sleutel, het item dat de leerder als verouderd aanwijst (`replacesId`, zelfde bucket), of
   Jaccard ≥ 0,5 met een actief item (alleen bij expliciet/tools; automatisch leren laat een alleen-gelijkend item
   staan, het onderhoud lost dat later op): correctie van de gebruiker wint (supersede met geldigheidsinterval, oude
   versie blijft in de geschiedenis); anders een **reviewkaart** (nooit stil overschrijven). **Vernieuwen uit dezelfde
   bron** (0.4 F2): is het bestaande feit aan zijn herzien-datum toe en komt de nieuwe uitspraak van precies dezelfde
   bron (pagina, bestand, document; niet extern), dan een nieuwe versie met de oude in de geschiedenis (undo 62 dagen);
   nooit bij een vastgezet feit of iets dat de eigenaar zelf bevestigde (dan de kaart). **Wat uit een gesprek geleerd
   is** (0.4.5, `learned`): een veranderd feit wordt direct de nieuwe versie (ook zonder correctiewoorden, met undo) —
   behalve als het oude vastgezet is, of als een bot of tool tegenspreekt wat de eigenaar zelf zei (`ownerSaid`: zijn
   woorden, ook geleerd; zijn import; alles wat hij schreef, goedkeurde, bevestigde, wijzigde of vastzette): dan de kaart.
6. **Beslis** — direct opslaan voor: jouw eigen invoer, jouw “onthoud dit” (niet gevoelig), goedgekeurde
   approval-kaart, de eigen notitie van een bot met schone herkomst (`botWrites=direct`), en **wat automatisch uit
   jouw eigen woorden is herkend** (`ownStatement`, instelling `autoApply = own`, standaard aan) — met een
   ongedaan-maakregel onder je bericht — en (0.4.5) wat de leerder uit het werk van de bot haalde, als notitie van de
   bot of van het dossier van het gesprek (geen instructie, geen externe of injectie-vlag; undo onder het antwoord van
   de bot). Voorstel bij: gevoelig, extern/tainted (er is in de run externe inhoud
   gelezen), lijkt op een injectie (doorsturen/betalen/…, óók als je het zelf typte), instructie van een bot, “over
   jou” of “gedeeld” door een bot, `autoApply = never`, import, consolidatie.
7. **Quota** — per scope (aantal + bytes) en max. open voorstellen; vol = duidelijke melding, er wordt niets stil
   verwijderd.
8. **Transactioneel schrijven** + versie/diff in `memory_changes`, FTS in dezelfde transactie; met `review_kind` en de
   herzien-datum van die soort (prijs 90 dagen, versie 60, regel 180, afspraak 90, openingstijden 180, contact 365; het
   model zegt het in `changes`, anders herkent `detectReviewKind` het in de tekst); idempotency-key
   (`x:<bericht>`, `t:<toolcall>`, `h:` patronen / `ml:` model voor automatisch, `imp:` voor import).
9. **Verify** (read-after-write) + event `memory.updated`, melding bij nieuwe voorstellen, undo-knop onder het bericht,
   in de tool-kaart en in Geschiedenis.
10. **Reconcile op de achtergrond** (elke 10 min, single-flight, tijdslimiet, pauze-schakelaar): TTL → archief,
    afgewezen voorstellen na 1 dag weg, prullenbak na 30 dagen leeg, wezen (bot verwijderd) → prullenbak, oude
    snapshots inkorten (180 d), episodes boven quotum snoeien, quota-melding (1×/dag). Sinds 0.4 F2 geen automatische
    samenvoegvoorstellen meer (die stapelden zich op tegen de voorstellen-cap en het quotum): het nachtelijke onderhoud
    vat zelf samen binnen de doelomvang, met verslag en undo.

## Slim leren (zelf bijwerkend geheugen)

Doel: wat er in een gesprek gezegd en gevonden is, staat daarna in het geheugen — zonder “onthoud dat”, zonder extra
kosten, en zonder dat externe tekst iets kan inplanten. Sinds 0.4.5 leest het **het hele gesprek**, zoals OpenBot
(gezien in de geïnstalleerde app: één review-aanroep met het model van de bot, elke 20 beurten, met de antwoorden van de
bot erbij), maar met de structuur van TeamBot: versies, supersede, controle tegen het bestaande, geldigheid in de tijd,
taken die zichzelf sluiten en dossiers. Dit vervangt de handmatige skills `dossier-bijwerken` en `kennisloop` uit het
OpenBot-team voor het geheugengedeelte.

- **Wanneer** (0.4.5): per gesprek, nooit per bericht: **elke `learnEvery` beurten** (standaard 20; één beurt = één
  antwoord van de bot, een run) meteen, en anders **na `quietMin` minuten stilte** (standaard 15; elke nieuwe beurt
  schuift het op). `learnEvery = 0`: alleen na stilte. Eén aanroep voor alles wat nieuw is (een heel lang gesprek wordt
  in delen gelezen: max. 6000 tekens van de eigenaar en 16.000 in totaal per aanroep). Wachtrij `memory_learn`
  (persistent), elke 15 s gecontroleerd, één tegelijk per gebruiker. In de inspector kan het ook meteen (**Nu leren**).
  Vóór 0.4.5: na 5 minuten stilte, of meteen bij ≥ 10 wachtende berichten van de eigenaar.
- **Wat het leest** (0.4.5): de berichten van de eigenaar (alleen zijn eigen woorden: citaten, codeblokken en
  doorgestuurde tekst eruit), de antwoorden van de bot van dit gesprek (`<bot id="b1" werk="ja|nee">`; `werk="ja"` als
  hij in die beurt een tool gebruikte buiten het geheugen, of bij een CLI-bot een toolstap had) en de uitvoer van zijn
  tools (`<tool id="t1" naam="…">`; niet de geheugentools, `ask_user`, `notify_user` of `plan_update`, niet een fout).
  Bot- en tooltekst is data: ingekort (1500 tekens, een antwoord zonder werk 400), zonder tags die zich als eigenaar
  kunnen voordoen, en met **sleutels en tokens verborgen** (`redact`) vóór het model ze ziet. Een beurt waarvan de
  eigenaar zei "niet onthouden" valt er helemaal uit.
- **Engine** (`engine.ts`, instelling *Herkennen met*): `own` (standaard sinds 0.4.5) = **het model van de bot zelf**
  als dat niets extra kost — Claude Code of Codex op een abonnement met het model waarmee de bot antwoordt (zonder
  ingesteld model het standaardmodel van de CLI, niet meer `haiku`), een lokaal model, OpenCode met een gratis model of
  een gratis API-tier —, anders een ander gratis model van de eigenaar (**de terugval**, met een licht model), anders de
  vaste patronen. `free` = hetzelfde maar zuinig (Claude Code `haiku`). `model` = het model van de bot, ook als dat geld
  kost (expliciet). Een vaste engine kiezen kan in Opslag. Een lokaal model antwoordt zonder "denken" (`reasoning:
  'none'`; bij Ollama altijd onder de volle naam `naam:latest`, alleen dan kan dat uit). Loopt de engine tijdens het
  leren tegen een gebruikslimiet of is hij niet ingelogd, dan krijgt hij een back-off tot `retryAfter` en **leest de
  volgende gratis engine dezelfde batch** (één keer); lukt ook dat niet, dan de patronen.
- **Welke engine in de praktijk** (gecontroleerd in 0.4.4): een bot op een abonnement (Claude Code, Codex) leert met
  die CLI, zonder extra kosten (sinds 0.4.5 met zijn eigen model); een bot op een betaalde API-sleutel leert met een andere
  gratis engine van de eigenaar of met de patronen; een bot die via de gratis keten doorschakelt leert met zijn eigen
  engine of de eerste gratis engine die past. Een **gratis bron** (Groq, Cloudflare, OpenRouter, Kilo, Z.ai …) heeft ook
  modellen die geld kosten en bronnen die bewaren of trainen; het geheugen leest de eigen berichten van de eigenaar, dus
  sinds 0.4.4 alleen een model dat de catalogus "Gratis modellen" als gratis en beschikbaar kent, en standaard alleen een
  bron die niets bewaart (Groq, Cloudflare) — een bron die mag trainen (OpenRouter, Kilo) alleen als de eigenaar die
  engine zelf koos in Opslag. Zonder catalogus alleen modellen op `:free` bij OpenRouter en Kilo. Daarvoor kon het
  standaardmodel van zo'n bron een betaald model zijn.
- **CLI zonder tools**: Claude Code `-p --output-format json --max-turns 1 --tools "" --safe-mode
  --no-session-persistence --strict-mcp-config --permission-mode dontAsk --system-prompt-file` (eigen systeemprompt,
  geen CLAUDE.md/skills/MCP; het model van de bot, of `haiku` bij `free` en als terugval); Codex `exec --ephemeral --ignore-user-config --ignore-rules -s
  read-only` met shell/apps/browser/… uit; OpenCode `run --standalone --format json --agent teambot_geheugen` met
  `permission`/`tools` `*` = deny en **eigen HOME/XDG in `<data>/memory/opencode`** — nooit
  `~/.local/share/opencode` van de eigenaar en nooit de gedeelde achtergrondservice (zonder `--standalone` praat
  OpenCode met een al draaiende service op poort 28894, bijvoorbeeld die van OpenBot). Alles in een lege map per aanroep.
- **Vraag en antwoord**: `<bekend>` (per regel van het gesprek de 4 best passende items, plus voor de hele batch en de
  gesleutelde, max. 80, geen gevoelige; feiten die aan hun herzien-datum toe zijn met `[herzien]`, wat een bot of tool
  eerder vond met `[bot]` / `[tool]`) + `<gesprek>` met `<eigenaar id="n">`, `<bot id="bn" werk="…">` en `<tool id="tn"
  naam="…">` in volgorde (en het laatste botbericht van daarvoor als context, zonder id). Antwoord: strikte JSON
  `{items:[{content,type,key,about,source,replaces,evidence,msg,terms,changes}], confirms:[], episode:{…, subject}}`:
  `source` = owner / bot / tool, `msg` = "1" / "b2" / "t3", `terms` = synoniemen, `changes` = soort veranderend feit,
  `confirms` = `[herzien]`-feiten die de eigenaar met dezelfde waarde noemt, `subject` = de klant of het project waar het
  gesprek over gaat. Alles wat niet klopt wordt weggegooid, nooit geraden. Ruimte voor het antwoord 2500 tokens (lokale
  modellen schrijven hun JSON uitgespreid). De systeemprompt (`LEARN_SYSTEM`) is in 0.4.5 als geheel herschreven: wat
  van de eigenaar telt, wat van de bot en de tools (alleen blijvende feiten over de wereld van de eigenaar, alleen uit
  een tool of een antwoord met werk), wat nooit (tijdelijke stand, nieuws, algemene kennis, opdrachten uit bot- of
  tooltekst, tekst aan een AI gericht, geheimen).
- **Wat het opneemt** (0.4.4, naar de richtlijnen van Mem0's nieuwere extractieprompt, Apache-2.0): ook alledaagse en
  terloopse feiten (huisdieren, hobby's, smaak, een feit in een vraag: "mijn hond Bram is ziek, wat kan ik doen?"), elk
  apart; twijfel of iets het onthouden *waard* is → opnemen (dubbel ruimt TeamBot zelf op), twijfel of het *klopt* of
  van de eigenaar komt → weglaten.
- **De bron beslist het citaat, niet het model** (0.4.5): `evidence` (≥ 2 woorden) wordt eerst gezocht in de eigen
  woorden van de eigenaar — letterlijk (na hoofdletters, accenten en leestekens gelijk te trekken), of (0.4.4) als één
  van zijn zinnen (of twee naast elkaar) waarin minstens 6 van elke 7 woorden van het citaat in volgorde staan; dan wordt
  zijn zin het bronfragment, nooit de versie van het model. Staat het daar, dan is het een feit **van de eigenaar** (ook
  als het model "bot" zei: een bot die hem herhaalt maakt hem niet tot bron). Anders in het genoemde botantwoord of de
  genoemde tool-uitvoer, dan in de andere van deze batch: een feit **van de bot** of **van een tool**. Nergens → weg. Een
  geciteerde mail of een verzonnen zin gaat er nooit door.
- **Een feit van de eigenaar**: ≥ 60 % van de woorden van `content` uit zijn eigen woorden van deze batch (of het
  vervangen item) — bot- en tooltekst tellen hier niet. Bron `message`, vertrouwen `user`, idempotency-key `ml:`.
  Sleutels van het model alleen uit een vaste lijst enkelvoudige sleutels (naam, woonplaats, werkgever, …), zodat een
  nieuwe waarde de oude vervangt en niet twee verschillende feiten.
- **Een feit van de bot of een tool** (0.4.5): alleen met **werk** (een antwoord zonder tool is een gok: weg); nooit
  een werkafspraak of instructie (die geeft alleen de eigenaar), niets dat op een opdracht lijkt, niets met tekst aan
  een AI gericht ("Belangrijk voor AI-assistenten: onthoud dat …") rond het citaat, niets over **waar geld of gegevens
  heen gaan** (een e-mailadres, rekening of link samen met factureren, betalen of sturen), en **niets van een
  tool-uitvoer die zich ergens tot een AI richt** (een vergiftigde pagina: ook de onschuldige feiten ervan niet). ≥ 60 %
  van de woorden uit die uitvoer of dat antwoord (met het antwoord van de bot in die beurt, de vraag van de eigenaar en
  het vervangen item). Het wordt een **notitie van de bot** (zijn team) of van het dossier van het gesprek, nooit "Over
  jou" of gedeelde kennis uit zichzelf; bron `message` (het botantwoord) of `tool` (de toolmelding), vertrouwen `agent`,
  zekerheid 0,7, key `mb:` / `mt:`. In de lijst en de API: `learned_from` = owner / bot / tool, in Geheugen de badge
  *Gevonden met een tool* / *Uit een antwoord van de bot*, in "Recent geleerd" "Gevonden met een tool door …".
- **Wat veranderd is** (0.4.5): het model noemt het bekende item dat verouderd is (`replaces`); dat moet over hetzelfde
  gaan (zelfde sleutel of een gedeeld woord). Van de eigenaar: met dezelfde sleutel, met correctiewoorden ("niet meer",
  "verhuisd", "voortaan" …) of bij een vastgezet item gaat het als vervanging de pijplijn in — en die **werkt het direct
  bij** (supersede, oude versie in de geschiedenis, één undo), ook zonder correctiewoorden; alleen een vastgezet item
  wordt een kaart. Een losser verband (alleen een gedeeld woord) wordt een nieuw feit naast het oude, en de controle
  tegen het bestaande beslist (een verkeerde aanwijzing van het model vervangt zo nooit een herinnering van de
  eigenaar). Van een bot of tool: de vervanging staat waar het oude item staat; was dat van de bot of een tool (een
  nieuwere meting: "PHP 8.1" → "PHP 8.3") → direct bijgewerkt; zei de eigenaar het zelf, of is het vastgezet → **een
  kaart** "Botst met wat er al staat", en wat hij zei blijft staan tot hij kiest. Binnen één batch gaan de feiten van
  de eigenaar eerst. Voor vaste patronen werkt bijwerken via de sleutel (“ik woon niet meer in Utrecht maar in
  Amersfoort”, “werk ik bij X, niet meer bij Y”), sinds 0.4.5 ook zonder correctiewoorden.
- **Toepassen**: wat de eigenaar zelf zei → direct, met onder zijn bericht “Onthouden / Bijgewerkt (was: …) ·
  Ongedaan maken”; wat uit het werk van de bot komt → direct, met dezelfde regel onder het antwoord van de bot (een
  feit uit een tool onder het antwoord van die beurt); één melding per batch, alleen als er een kaart is. Gevoelig of
  injectie-achtig → voorstel (injectie uit bot- of tooltekst → geweigerd). `autoApply = never` → alles als voorstel. Het
  model werkt ook de gesprekssamenvatting bij (besluiten/acties dubbelvrij met de patroonregels).
- **Daarna: klopt alles nog?** (0.4.4) De nieuwe feiten van de batch gaan door de controle tegen wat er al staat (zie
  "Bijwerken bij schrijven"): eerst de vaste patronen, dan — alleen voor feiten die iets hebben om mee te vergelijken —
  één aanroep van dezelfde engine. Een feit van een bot of tool telt daar als bewering van een bot: wat de eigenaar zelf
  zei (ook wat de leerder uit zijn woorden haalde, `source_trust = user`) wordt dan *te controleren*, nooit beëindigd.
- **Kosten en limieten**: één aanroep per batch om te leren (plus hooguit één om te controleren), binnen
  `modelDailyCap` (standaard 100 aanroepen/dag); gratis engines tellen niet mee voor de daglimiet in geld. Elke aanroep
  staat in `usage_log` (tokens; kosten 0 op een abonnement, met bij Claude Code de waarde tegen lijstprijs in `value`;
  betaald alleen bij `extractor = model`) en in `memory_meta.learn_stats`; het resultaat per batch (`calls`, `fromBot`,
  `fromTool`, …) in `memory_learn.last_result`. Latentie en aantallen van vandaag: `GET /api/memory/engine`.

## Onderhoud (nacht en op verzoek)

`maintenance.ts`, elke nacht na 03:00 (één keer per dag; stond de pc 's nachts uit, dan bij de eerste controle daarna,
die 10 min na de start komt) en via **Nu onderhoud uitvoeren**. Stappen, elk met een eigen versie en undo:

1. gewone reconcile (TTL, prullenbak, wezen);
2. (bijna) dubbele items in dezelfde bucket samenvoegen (Jaccard ≥ 0,85 of gelijke tekst), het meest complete blijft;
3. tegenspraak op dezelfde sleutel: de nieuwste uitspraak van de eigenaar wint; anders “ter controle” bij Te beoordelen;
4. met een gratis model: dubbelingen, tegenspraak en verlopen afspraken die de patronen niet zien (alleen ids in het
   antwoord; paren moeten over hetzelfde gaan en de oudste wint nooit). Noemt het model iets "voorbij" dat de eigenaar
   zelf schreef, goedkeurde of bevestigde, dan wordt het niet gearchiveerd maar *ter controle* aan hem voorgelegd
   (0.4.4: in de geheugentest noemde het lokale model eens vijf kentekens die de eigenaar intypte "voorbij"; dezelfde
   bescherming als bij de doelomvang); en (0.4.4) de feiten van de afgelopen week die
   nog geen model tegen het bestaande controleerde (expliciet, de geheugenpagina, notities van bots, dossiernotities):
   één aanroep voor max. 12 feiten (zie "Bijwerken bij schrijven");
5. automatisch geleerde afspraken die 60 dagen niet gebruikt zijn (en al het automatisch geleerde na een jaar) archiveren;
6. (F2) feiten waarvan de herzien-datum kwam opnieuw bekijken (zie "Zelf bijwerken");
7. gesprekken die een dossier bij naam noemen koppelen (meestal al bij hun eerste beurt gebeurd), en de samenvattingen
   van gekoppelde gesprekken in het dossier zetten: één tijdlijnregel per gesprek (het LOG), besluiten en open acties
   (dubbelvrij, ook tegen wat er al staat), en de samenvatting “NU” laten herschrijven (alleen over het
   dossieronderwerp); een samenvatting boven 1500 tekens wordt ingekort (model, anders op een regelgrens); (0.4.4)
   dossiers die veranderden en nog niet opnieuw gelezen zijn, worden nu gelezen (zie "Een dossier dat verandert");
8. kernprofiel: kernfeiten over de eigenaar (naam, woonplaats, werk, dieet, vaste voorkeuren) altijd laden, binnen
   `briefTokens` (standaard 300). Eigen vastzettingen van de eigenaar blijven onaangeroerd; wat hij losmaakt of terugdraait
   wordt niet opnieuw vastgezet;
9. (F2) elk deel binnen zijn doelomvang, en (0.4.4) klanten waar niets meer mee gebeurt naar het archief (zie "Nooit
   oneindig groot");
10. (F2) het eerste onderhoud van een nieuwe maand maakt het opruimverslag van de maand ervoor.

Het verslag (`memory_reports`) staat in het Overzicht als “Wat ik vannacht heb bijgewerkt”, met per regel
*Ongedaan maken* en *Alles ongedaan maken*; ’s nachts komt er een melding als er iets veranderde.

## Zelf bijwerken (0.4 F2)

`refresh.ts`. Feiten die met de tijd veranderen krijgen een **herzien op**-datum (`review_at`) voor hun soort: prijs
(ook tarieven en "procent", in samenstellingen als "transactiekosten") elke 3 maanden, versie elke 2, regel en
openingstijden elke 6, afspraak/contract elke 3, contactgegevens elk jaar. Werkafspraken, voorkeuren en lessen niet: dat
zijn geen feiten die verouderen. Komt de datum, dan:
1. **dezelfde bron zegt iets nieuws** (een specialist leest zijn pagina opnieuw; zie de pijplijn): nieuwe versie, oude in
   de geschiedenis;
2. **de bron is ongewijzigd**: de leerronde van een specialist meldt `ctx.services.memory.sourceUnchanged(…)` en de
   feiten van die bron zijn bevestigd (volgende datum);
3. **de eigenaar zegt het opnieuw**: de leerder ziet `[herzien]` en noemt het in `confirms` (zonder model: zijn woorden
   herhalen het bijna letterlijk) → bevestigd; noemt hij een nieuwe waarde, dan is het een correctie zoals altijd;
4. **'s nachts uit een dossierdocument**: staat het feit in een dossier met een bron, dan leest het gratis model het
   document opnieuw (alleen de passende alinea's) en antwoordt `same` / `changed` / `unknown` met een **letterlijk citaat**
   uit de bron; `changed` alleen als de nieuwe tekst voor ≥ 60 % uit de bron komt → vernieuwd (vastgezet of door de
   eigenaar bevestigd: alleen de notitie, nooit stil een nieuwe versie); `same` → bevestigd; anders *te controleren*;
5. **niets daarvan binnen twee weken** → *te controleren*: het feit blijft, met een notitie waarom (`review_note`, vlag
   `check`); de eigenaar ziet het bij Te beoordelen › Klopt dit nog? (met *Klopt nog*, *Aanpassen*, *Vergeten*), de bot
   leest het als "te controleren". Een feit dat op zijn controle wacht gaat niet eerst stil naar het archief.
In de geheugentest: van 12 verouderende feiten 12 zoals verwacht afgehandeld, 0 stil verouderd (zonder model worden de
documentfeiten *te controleren*, met een model vernieuwd of bevestigd).

## Bijwerken bij schrijven: klopt alles nog? (0.4.4)

`consolidate.ts`. Het geheugen voegt niet alleen toe: een nieuw feit kan maken dat oudere niet meer kloppen. Voor elk
nieuw feit haalt TeamBot de notities op die erop lijken (dezelfde zoekfunctie als de bot: woorden + betekenis, binnen de
muren van het team), plus de open taken en open dossieracties, en beslist per paar:
- **unrelated** → niets; **repeats** → het nieuwe feit gaat op in het oude (samengevoegd, het oude bevestigd);
- **changes** → het nieuwe feit is de volgende versie van het oude (vervangen, geschiedenis blijft);
- **ends** → het oude geldt niet meer: uit het actieve geheugen met `valid_to` (sinds wanneer) en `invalid_reason`
  (waarom: het nieuwe feit), status *vervangen*; een open dossieractie wordt *afgerond* met de bron. Ook impliciet ("we
  sponsoren De Spurt niet meer" na "we sponsoren het wielerteam De Spurt") en ook wat er alleen van afhing ("Ahmed werkt
  hier niet meer" beëindigt ook "Ahmed restaureert de frames").
- **Ketting van beëindigingen** (0.4.5): zegt de eigenaar dat iemand weg is ("Ahmed is weg", "werkt niet meer bij
  ons", "is met pensioen"; `departedNames`), dan komen alles wat open is en die naam noemt als kandidaat mee, ook als
  het zoeken het laag rangschikt: zijn open taken, de dossieracties die hij heeft (`owner`) of die hem noemen, en de
  notities over zijn werk hier (een werkwoord als "restaureert", "maakt", "doet", "is onze …"). Het patroon beëindigt
  die (acties: *geannuleerd*, "Vervallen", met de reden); wie hij is (familie, waar hij woont), vastgezette notities en
  vaste regels blijven. Alleen op het woord van de eigenaar; een notitie van een bot start geen ketting.
- Een notitie in een dossier wordt vergeleken met de notities, open taken en acties van dat dossier (en de eigen en
  gedeelde taken van de eigenaar), via de index; niet met het hele geheugen (0.4.5: dat maakte elke klantnotitie
  duurder dan de vorige).
Nooit stil: elke stap is een gewone wijziging met reden en ongedaan maken (62 dagen). Vastgezette notities en vaste
regels worden nooit beëindigd door een patroon of model: die worden *te controleren*. Wat een bot zelf beweert over een
notitie die de eigenaar maakte, wordt ook *te controleren*. Gevoelige notities worden niet vergeleken.

Twee manieren om te beslissen:
1. **Vaste patronen**, altijd en zonder model: een *open-loop*-controle. Een woord dat zegt dat iets af is
   ("bijgewerkt", "afgerond", "betaald", "gekregen", een voltooid deelwoord na is/heeft) sluit de open taak met hetzelfde
   onderwerp (de meeste woorden van de taak, minstens twee); een woord dat zegt dat iets stopt ("niet meer", "gestopt",
   "opgezegd", "laten varen", "weer terug") beëindigt de notitie waar de woorden van het feit in staan. Nederlandse
   werkwoordsvormen tellen mee ("bijwerken" ~ "bijgewerkt", "versturen" ~ "verstuurd"), net als de kop van een
   samenstelling ("lascursus" ~ "cursus"). Niet: een terugkerende plicht ("moet elk jaar verlengd"), iets dat als regel
   geformuleerd is ("gebruik nooit …"), "nog niet gedaan", een vraag. Twee even goede kandidaten die niet dezelfde taak
   zijn → niets (bij twijfel niets). Draait direct bij elk schrijven (`writeCandidate`) en na elke leerbatch.
   **Ook wat de leerder oversloeg**: een zin van de eigenaar die iets afrondt of beëindigt maar die het model (of de
   patroonleerder) niet tot feit maakte, wordt door de patronen bekeken (`patternTarget`, met een proef-notitie die niet
   wordt opgeslagen). Alleen als ze vinden wat de zin beëindigt, wordt de zin opgeslagen — in de eigen woorden van de
   eigenaar, in het deel van wat hij beëindigt — en daarna gecontroleerd als elk nieuw feit; anders niets (er wordt dus
   niets verzonnen). Zonder model gebeurt dit per bericht (`Learner.afterRun`), met model na de batch. Aanleiding: het
   lokale model schreef in de geheugentest één feit voor een beurt met twaalf updates, waardoor 0 van de 4 gevallen
   eindigden. Een vervanging die het model noemt (`replaces`) en die de eigenaar niet als correctie maar als "af" of
   "gestopt" verwoordde ("Klant Bakker heeft zijn terugbetaling gekregen"), gaat door deze controle in plaats van naar
   een beoordelingskaart.
2. **Een gratis model** (de engine van de leerder): één aanroep per leerbatch, alleen voor feiten die iets hebben om mee
   te vergelijken, max. 12 per aanroep; 's nachts hetzelfde voor wat op een andere manier binnenkwam. Het oordeel-schema
   is overgenomen van de consolidatiestap van **Hindsight** (vectorize-io/hindsight,
   `hindsight-api-slim/hindsight_api/engine/consolidation/prompts.py`, MIT, © 2025 Vectorize AI, Inc.): per feit de
   dichtstbijzijnde notities, elk beoordeeld met wat het feit en de notitie *over* gaan; een naam die één letter
   verschilt is een ander onderwerp; aantallen nooit uitrekenen; een einde beëindigt ook wat ervan afhing; de code — niet
   het model — vergelijkt de data en markeert notities die later gezegd zijn ("(later gezegd)": die worden nooit
   veranderd of beëindigd door een ouder feit). Van **Graphiti** (getzep/graphiti, `graphiti_core/prompts/dedupe_edges.py`,
   Apache-2.0) de regel dat tegenspraak expliciet bewijs vraagt en dat iets *doen* met hetzelfde onderwerp (bellen,
   sporten, iets maken) geen rol of gewoonte beëindigt; van **Mem0** (mem0ai/mem0, `mem0/configs/prompts.py`, Apache-2.0)
   de korte tijdelijke ids in plaats van echte ids. Eigen Nederlandse tekst en voorbeelden. De code past alleen oordelen
   toe over notities die voor dat feit zijn aangeboden en die er duidelijk over gaan (gedeeld woord of dezelfde sleutel).

**Geldigheid in de tijd** (naar het tijdmodel van Graphiti): `valid_from` = sinds wanneer het geldt, `valid_to` = tot
wanneer, `invalid_reason` = waarom niet meer; de wijziging zelf zegt wanneer TeamBot het hoorde. Vragen over nu zien
alleen wat geldt; `memory_search` met `history: true` vindt ook wat gold, met "geldt niet meer sinds … (reden)".

**Taken die af zijn sluiten zichzelf** — eigen taaknotities ("We moeten de SEO van de website nog bijwerken") én open
dossieracties ("SEO van de website bijwerken"):
- de eigenaar zegt het ("De SEO van de website is bijgewerkt"): patronen direct, of de leerder met het model;
- een kaal "gedaan" / "klaar" / "done" direct nadat de bot precies één open taak noemde (`captureDone`, vóór het
  antwoord, net als "ja, doe maar"); staat dezelfde taak op twee plekken (notitie en dossieractie), dan beide;
- een bot meldt het af ("Ik heb de productfoto's geüpload") **met bewijs**: hij gebruikte in die run een tool buiten het
  geheugen, of het is een routine-run (`closeFromRun`, na de run); zonder bewijs niets;
- de afgeronde taak staat daarna niet meer in het blok, ook niet via een eerdere gesprekssamenvatting die haar alleen
  herhaalt of een eerder gesprek dat met die taak begon (een afgesloten dossieractie telt mee), tenzij dat gesprek zelf
  meldt dat het af is.

## Een dossier dat verandert (0.4.4)

`reread.ts`. Verandert de inhoud van een dossier — een nieuwe versie van een document (iemand uploadt het opnieuw, een
bot voegt het toe), een nieuwe notitie, besluit of gebeurtenis, een actie die af is — dan wordt het dossier opnieuw
gelezen (20 s na de laatste wijziging, zodat een reeks wijzigingen één keer gelezen wordt; persistent via `changed_at` /
`reread_at`; ook in het nachtelijke onderhoud):
- **Een nieuwe versie van een document** (dezelfde titel, link of bestand; dezelfde tekst opnieuw verandert niets)
  vervangt de oude: die blijft in de geschiedenis maar wordt niet meer doorzocht. Daarna, naar Hindsight's *delta
  retain* en Cognee's *chunk-level diff*: een feit dat de nieuwe tekst nog noemt (zijn woorden en elk getal) is
  *bevestigd* en wijst naar de nieuwe versie; de rest wordt met het gratis model opnieuw gelezen (*zelfde* / *veranderd* /
  *weg*, met een letterlijk citaat uit de nieuwe tekst): veranderd → een nieuwe versie van het feit, weg → geldt niet
  meer ("staat niet meer in …"). Zonder model worden die *te controleren* — nooit stil.
- **Nieuwe notities** van het dossier gaan met het model door de controle tegen wat er al staat.
- **NU** blijft actueel: het model schrijft het opnieuw uit de stand van nu (alleen open acties, wat niet meer geldt
  genoemd als niet meer geldig); zonder model gaan de zinnen eruit die herhalen wat beëindigd, afgerond of *te
  controleren* werd.

## Nooit oneindig groot (0.4 F2)

`cleanup.ts`. Elk deel van het geheugen — "Over jou", de notities van één bot in één team, de gedeelde kennis van één
team, één dossier — heeft een **doelomvang** (actieve herinneringen; `targets`, standaard 200/250/400/600, altijd onder
het quotum). Het nachtelijke onderhoud houdt elk deel eronder, elke stap een gewone wijziging met undo (62 dagen):
1. **lang niet gebruikt, weinig waard → archief**: niet gebruikt, bevestigd of gewijzigd in `archiveAfterDays` (180) en
   een waarde onder 2,5. De waarde telt soort (regel 4, voorkeur 3,5, persoon 2,5, feit 2, notitie 1), "Over jou" +1,5,
   een vaste sleutel (woonplaats, werkgever …) +1, gebruik, recent gebruik, bevestiging, zekerheid, min ouderdom. Zo
   blijft waar je woont, maar gaat een losse notitie van een jaar geleden;
2. **een deel boven zijn doel: samenvatten**: kleine herinneringen (≤ 240 tekens) over hetzelfde onderwerp (een gedeeld
   betekenisvol woord) worden één herinnering met de originelen als bronnen (`merge_of`, `source_kind = consolidation`);
   de originelen gaan naar het archief. Het gratis model schrijft de samenvatting, die wordt gecontroleerd (alleen woorden
   uit de originelen, en ze komen er allemaal in terug); anders worden de feiten zelf achter elkaar gezet;
3. **nog steeds erboven: het minst waardevolle naar het archief** tot het past;
4. **een begrensd archief**: zit een deel (actief + archief + oude versies) boven 90 % van het quotum, dan gaan de oudste
   gearchiveerde herinneringen en oude versies (> 90 dagen) naar de prullenbak (30 dagen terug te zetten) tot 80 %.
**Nooit aangeraakt**: vastgezet, wat de eigenaar zelf maakte, goedkeurde, bevestigde, vastzette of aanpaste, wat vaak
(≥ 5×) of de laatste 30 dagen gebruikt is, het kernprofiel en gevoelige herinneringen. Kan een deel niet onder zijn doel
zonder die aan te raken, dan zegt het verslag dat eerlijk.
**Archief** = uit de context van elke bot, maar de eigenaar vindt het (zoeken in Geheugen toont het met status
*Gearchiveerd*, op woorden) en zet het met één klik terug.
**Opruimverslag**: het eerste onderhoud van een maand maakt een kort verslag van de maand ervoor (`memory_reports.trigger
= monthly`): wat samengevat, gearchiveerd, opgeruimd, vernieuwd, bevestigd en *te controleren* is, met per regel undo
en *Alles ongedaan maken*, plus de omvang van elk deel tegenover zijn doel, en een melding "Opruimverslag van oktober:
12 samengevat · 30 gearchiveerd · …". In het Overzicht tot je *Gelezen* klikt (of een maand).
**Klantenservice met veel klanten** (0.4.4): elke klant een dossier (soort *klant*) met een eigen, kleine doelomvang
(`targets.client`, standaard 40; daarboven samenvatten en archiveren zoals bij elk deel). Een klant waar in
`archiveAfterDays` (180) niets mee gebeurde (geen wijziging, notitie, gesprek of gebruik) gaat met zijn dossier naar het
archief: buiten het blok van elke beurt, wel gevonden door `memory_search` en `dossier_get`, en weer actief zodra een
gesprek de klant noemt (of het dossier opnieuw wordt aangemaakt). Een gearchiveerde klant houdt een kwart van de
doelomvang (min. 5). Grenzen per eigenaar: 1000 actieve dossiers en 10.000 met het archief (serverlimieten
`dossiers`/`dossiersTotal`); vóór 0.4.4 was het 500 in totaal, ook het archief, zodat een klantenservice met 500 klanten
niet eens kon beginnen. Het blok per beurt blijft klein, hoe groot het geheugen ook is.
In de geheugentest: na een gesimuleerd jaar (615 herinneringen erbij voor één bot) 247 actief bij een doel van 250, 403
in totaal bij een quotum van 500, 0 van de 15 belangrijke kwijt, 12 opruimverslagen, terugzetten uit het verslag werkt.

## Dossiers zonder moeite (0.4 F2)

`dossier-auto.ts`. Voor bots moet werken met dossiers vanzelf gaan:
- **Vanzelf gevonden en gekoppeld**: noemt een gesprek, taak of opdracht van een andere bot een dossier van het eigen team
  bij naam (alle onderscheidende woorden van de titel; "klant", "project" e.d. tellen niet) of bij een tag, dan wordt
  het gesprek bij de eerste beurt gekoppeld. Bij twee kandidaten niets (nooit raden). Muren (B3): alleen dossiers die de
  bot mag lezen én schrijven (zijn thuisteam); een gelijknamig dossier van een ander team nooit.
- **De stand in elke beurt**: het gekoppelde dossier staat bovenaan het geheugenblok (samenvatting, laatste besluiten, open
  acties met wie en wanneer), zonder dat de bot erom vraagt.
- **Eén tool om te schrijven**: `dossier_note` met één zin (en optioneel wie/wanneer). TeamBot zet het zelf op de goede
  plek: besluit ("besloten", "we kiezen voor"), actie ("moet", "voor vrijdag", wie + wanneer, of `owner`/`due`), afgerond
  ("de offerte is verstuurd" sluit de open actie waar het over gaat), gebeurtenis ("vanochtend gebeld"), persoon of
  organisatie ("Piet is de contactpersoon"), bron (een link) of notitie. Zonder dossier: dat van het gesprek, anders het
  dossier dat de zin noemt. De uitgebreide tools (`dossier_note`, `dossier_add`, `dossier_update`, `memory_get`) staan in een eigen
  deel van de toollijst (`memory:dossiers`, aan met "Geheugen"): ze werken nog, maar gaan bij een volle toollijst niet
  standaard mee (pakket Y).
- **Een terugkerend onderwerp zonder dossier**: de klant of het project van een gesprek (het `subject` van de leerder,
  zonder model patronen als "klant Jansen") wordt per team geteld; in het tweede gesprek zonder dossier krijgt de
  eigenaar een **voorstel** (melding, en in Dossiers *Aanmaken* / *Niet nodig*), of — als hij dat toestond
  (`dossierAuto = create`) — maakt de bot het dossier voor zijn team. Een bot die `dossier_note` gebruikt voor een
  dossier dat nog niet bestaat, zet zijn notitie klaar bij het voorstel; bij *Aanmaken* gaan de notities erin en worden
  de gesprekken gekoppeld. Zo'n dossier is voor alle bots van dat team. *Niet nodig* is definitief.
- **Kort en actueel**: het onderhoud werkt de stand bij en houdt de samenvatting onder 1500 tekens.

## Lessen voor het hele team (0.4 F2)

Een les uit een correctie van de eigenaar (pakket C1, `quality/lessons.ts`) wordt **gedeelde kennis van het thuisteam
van die bot** (type `lesson`, de bot als auteur): elke bot van dat team werkt daarna zo, een bot van een ander team ziet
haar niet. Een bot die geen gedeelde kennis leest, houdt de les voor zichzelf. De eigenaar maakt een les in Geheugen
met *Alleen voor <bot>* weer een notitie van die ene bot.

## Actueel, begrensd, zonder tegenspraak

Tests: `tests/memory-current.test.ts` (één test per gedrag). Bestanden: `pipeline.ts` (wie wint), `retire.ts`,
`lessons.ts`, `crosschannel.ts`, `learn.ts` (direct leren op kanalen), `cleanup.ts` (`overTarget`).

- **Vervangen in plaats van erbij zetten.** Gaat een nieuwe notitie over hetzelfde onderwerp (dezelfde sleutel, of de
  notitie die de schrijver aanwijst met `replacesId`), dan vervangt ze de oude als ze **minstens zo goed onderbouwd**
  is: eigenaar (4) > bron of import (3) > bot of klant (2) > extern (1). De oude versie gaat naar de geschiedenis, met
  ongedaan maken (62 dagen). Dat geldt voor `memory_remember`, voor andere modules (`services.memory.remember`, nu met
  `replacesId`, `compared`, `reviewKind`) en voor de leerronde van een specialist. **Eén korte vraag** (een kaart in
  Te beoordelen én onder *Wacht op jou*: "Wat klopt? Het nieuwe / het oude") alleen als de oude notitie vastgezet is of
  de eigen woorden van de eigenaar zijn, de nieuwe gevoelig of van buiten is, of de eigenaar alles van bots eerst wil
  zien. Een notitie die alleen *lijkt* op een andere (zonder sleutel of aanwijzing) blijft een vraag, of — als de
  schrijver zelf al vergeleek (`compared`) — een eigen feit.
- **De veegronde** ('s nachts) gebruikt dezelfde regel voor wat er al dubbel staat: de nieuwste wint als ze minstens zo
  goed onderbouwd is; anders *ter controle*.
- **Begrensd.** De doelomvang per deel bestond al; nieuw is dat het onderhoud niet op de nacht wacht als een deel meer
  dan 10 % boven zijn doel zit (elke tien minuten gecontroleerd, hoogstens één keer per zes uur), en dat een
  kennisbank haar gebruik toont ("312 van 600 feiten", `services.memory.dossierSize`).
- **Vervallen (`retire.ts`).** Iets dat vroeger klopte en nu niet meer, zonder opvolger: uit het actieve geheugen met
  reden en datum (status *vervangen*, `valid_to`, `invalid_reason`, vlag `retired`; ongedaan maken 62 dagen). De bots
  die het mochten lezen krijgen het per beurt terug als `<niet_meer>`: "… niet meer sinds 9 nov 2026, omdat: …" —
  hoogstens 5 regels (wat bij het bericht past eerst, dan de nieuwste), een jaar lang. Route:
  `POST /memory/items/:id/retire { reason }`; dienst: `services.memory.retire / retired`.
- **Soort `practice`** (werkwijze, richtlijn van een platform): herzien na 120 dagen.
- **Lessen in elke beurt (`lessons.ts`).** Een les (`type = lesson`) kwam alleen mee als de zoekfunctie haar toevallig
  vond. Nu staan de lessen die een bot mag lezen (eigen en van zijn team) in elke beurt, ook in een klantgesprek
  (`<lessen>`, intern): hoogstens 8 korte regels, wat bij het bericht past eerst. Nieuwe bronnen van lessen: een taak
  die de eigenaar terugstuurt met een reden (`task_reopened`), en een dubbel antwoord (hieronder). Hoogstens 5
  automatische lessen per bot per dag; een (bijna) gelijke les bevestigt alleen de bestaande.
- **Eén klant, meer kanalen (`crosschannel.ts`).** Vóór een bot op een kanaal antwoordt, staat in zijn beurt
  `<al_verstuurd>`: wat deze klant de laatste drie dagen op een ander kanaal kreeg, en of dezelfde vraag daar eerder
  binnenkwam (dan: "geef hier niet nog eens hetzelfde antwoord"). Dezelfde klant = hetzelfde klantdossier (door de
  eigenaar gekoppeld), of dezelfde afzendernaam met dezelfde vraag; in dat tweede geval hoort de bot alleen dát er
  geantwoord is, nooit wat. Kreeg de klant toch twee keer (bijna) hetzelfde antwoord, dan maakt TeamBot er een les
  voor het team van (één per paar gesprekken per dag) en krijgt de eigenaar één melding, met de vraag de twee te
  koppelen. Identiteiten worden nooit vanzelf samengevoegd: wie op WhatsApp andermans e-mailadres noemt, zou anders
  diens dossier kunnen lezen.
- **Direct leren op een kanaal.** Een kanaalgesprek kent geen "15 minuten stilte": na elk bericht staat de leerbeurt
  meteen klaar en draait ze binnen een seconde (binnen `modelDailyCap`). De eigenaar die via zijn eigen, door het
  kanaal bevestigde nummer of adres met zijn bot praat (`parts.channel.isOwner`, alleen één-op-één), telt als de
  eigenaar: "onthoud dat …" werkt en zijn woorden worden geleerd. Het lezen in zo'n gesprek blijft als op elk kanaal
  (geen persoonlijk geheugen in de context). Gesprekken in de app: ongewijzigd (elke 20 beurten of na 15 minuten).

Echt model (9 november 2026, lokaal Ollama `qwen3.6-uncensored-snel`, tijdelijke datamap): een specialist leerde drie
feiten van een pagina; nadat de pagina veranderde werd in de volgende ronde één feit *bevestigd*, één *bijgewerkt*
(60 → 70 tekens) en één *vervallen* (stond niet meer in de bron), en het vervallen feit stond in `<niet_meer>`. Drie
fouten van het model werden daarbij gevonden en afgevangen: een feit dat een ander "tegenspreekt" terwijl het over iets
anders gaat (nu: minstens 30 % gedeelde woorden), "hetzelfde" bij een ander getal, en "klopt nog" met een citaat over
iets anders. Alleen met het nepmodel bewezen: wie wint bij schrijven, de veegronde, begrensd, direct leren op kanalen,
lessen en het dubbele antwoord.

## Actueel als standaardgedrag

Voor elke bot, welke rol ook, met of zonder geheugen (`context.ts` › `currentRule`, test `6b` in
`tests/memory-current2.test.ts`):
- **Vaste regel in de systeemprompt** (`## Actueel`): wat met de tijd verandert (prijzen, regels, versies, voorwaarden
  van een platform, "wat nu werkt", nieuws, beschikbaarheid) eerst nakijken bij een actuele bron en de bron met haar
  datum noemen; zonder zoek- of browsertool eerlijk zeggen dat nakijken niet kon. De datum van vandaag staat al in elke
  beurt (`agent/prompt.ts`).
- **Leeftijd bij wat het geheugen aanreikt**: een herinnering of kennisbankfeit voorbij zijn herzien-datum staat er als
  "mogelijk verouderd (sinds <datum>)". De bot kijkt het na en werkt het in dezelfde beurt bij met `memory_update` (de
  vervangregel; oude versie in de geschiedenis) of bevestigt het (`still_valid`).
- **Bij het schrijven**: elke tijdgevoelige notitie krijgt haar soort en herzien-datum (prijs, versie, regel, afspraak,
  openingstijden, contact, werkwijze), ook in gewoon botgeheugen.
- **Ingebouwde lijsten**: gratis modellen worden per aangezette bron dagelijks ververst (`free-models`); de
  modelcatalogus heeft een dagelijkse verversing die standaard **uit** staat (instelling van de beheerder); de
  voorinstellingen van bronnen per vak (`specialists/defaults.ts`) zijn vast, maar een voorgestelde bron die drie
  rondes niet antwoordt wordt uitgezet en vervangen door een bron die de specialist zelf vindt.

## Vergeten (hard) vs. verwijderen

- **Prullenbak/archief**: omkeerbaar (undo, terugzetten), 30 dagen bewaard.
- **Vergeten** (`POST /api/memory/items/:id/forget`, ook voor records/bronnen/episodes/hele dossiers): alle versies
  (supersede-keten en samenvoegingen) gewist, snapshots in de geschiedenis geredigeerd, FTS-regels en vectoren (ook van
  de documentdelen van een bron) weg, tombstone (HMAC's) blokkeert opnieuw opslaan (exact, zelfde sleutel+overlap, of
  token-overlap) en dus ook opnieuw inbedden. Afgeleide kopieën worden
  opgeschoond: episodes en thread-samenvattingen, bevroren contextblokken, output van geheugentools, toolcall-argumenten,
  goedkeuringskaarten en audit-samenvattingen. Met *ook bronbericht* (standaard in de UI) worden ook het
  oorspronkelijke chatbericht en echo's van bots in de bron- en gebruiksgesprekken gewist. Er komt een bon (receipt)
  in Geschiedenis. Niet ongedaan te maken; de blokkade is wel op te heffen (Geschiedenis › Blokkades).
- Een bot mag zijn eigen notities vergeten; voor “Over jou”, gedeelde data, dossiers of notities van andere bots vraagt
  `memory_forget` een **danger**-bevestiging (behalve als jouw eigen bericht om dat vergeten vroeg).
- **Over teams heen** (0.4 B): vergeten is globaal. Hetzelfde feit in een ander team, bij een andere bot of in "Over
  jou" en elke kopie van "vakkennis meenemen" gaan mee, en de blokkade geldt voor elk team. Kennis van een team waar
  een bot alleen mag meekijken kan die bot niet vergeten (geweigerd, zonder bevestigingsvraag).

## Tools (groep `memory`, standaard aan)

| Tool | Risico | Wat |
|---|---|---|
| `memory_search` | read | Zoeken in items, dossiers/regels, documenten, eerdere gesprekken (items en documenten ook op betekenis); ook in gearchiveerde klantdossiers; `history: true` (0.4.4) ook wat niet meer geldt, met sinds wanneer en waarom; resultaten met citeer-id |
| `memory_get` | read | Eén item/regel/bron/episode volledig met bron, datums, zekerheid, versies |
| `memory_remember` | write | Opslaan via de pijplijn (direct of voorstel, zie boven) |
| `memory_update` | write | Nieuwe versie (eigen botnotitie) of wijzigingsvoorstel (andermans data); `still_valid` = bevestigen |
| `memory_forget` | write + danger-bevestiging voor andermans/gedeelde data | Hard vergeten met bon |
| `dossier_write` | write | De tekst van een dossier bijwerken (add / replace / rewrite), met een maximum per dossier; maakt het dossier aan als het er nog niet is (voor het hele team). Zie "Levende dossiers" |
| `dossier_get` | read | Samenvatting, besluiten, acties, tijdlijn, personen, bronnen, notities; `query` zoekt in documenten (woorden + betekenis) |
| `dossier_note` | write | Eén zin in het dossier (van het gesprek, of het genoemde): TeamBot kiest besluit / actie / afgerond / gebeurtenis / persoon / organisatie / bron / notitie; bestaat het dossier nog niet, dan een voorstel (of aangemaakt, als de eigenaar dat toestond) |
| `dossier_add` | write | event / decision / action / person / organization / note / source (URL, tekst of een tekst-, pdf- of Word-bestand uit de werkmap) — deel `memory:dossiers` |
| `dossier_update` | write | Samenvatting/status van een dossier of status/eigenaar/deadline van een regel — deel `memory:dossiers` |

In ask-modus toont de approval-kaart de exacte inhoud; goedkeuren daarvan telt als review. Tools worden per bot/thread
opnieuw opgebouwd (`ctx.tools.addProvider`) zodat kaarten de echte inhoud tonen; statische versies staan in de catalogus.

## API (`/api/memory/...`)

Teams (0.4 B): `GET teams` (`{multi, teams: [{id, name, color, isDefault, bots}]}`), `POST teams/copy`
(`{fromTeamId, toTeamId}` → wat er gekopieerd en overgeslagen is). Het teamfilter `teamId` (een team of `*`) werkt op
`GET items`, `GET search`, `GET dossiers`, `GET episodes` en `GET changes`; `teamId` kiezen kan bij `POST items` en
`POST import` (gedeelde kennis), `PATCH items/:id` (gedeelde kennis naar een ander team of alle teams; een botnotitie
naar een ander team), `POST items/:id/approve`, `POST dossiers` en `PATCH dossiers/:id` (alleen de eigenaar).
Antwoorden hebben `team: {id, name}` (alleen met twee of meer teams; `*` = Alle teams); `GET storage` heeft
`sharedByTeam`.
Overzicht/lijsten: `GET overview`, `GET items` (filters `scope, agentId, dossierId, status, type, sensitivity, source,
pinned, from, to, threadId, q, teamId, limit, offset`), `GET items/:id`, `POST items`, `PATCH items/:id`,
`POST items/:id/{approve|reject|archive|restore|trash|confirm|pin|unpin}`, `POST items/:id/forget`, `POST items/bulk`,
`GET search?q=` (gemengd: items, dossiers, regels, episodes, documenten).
Review/geschiedenis: `GET review`, `GET changes`, `POST changes/:id/undo`, `GET blocks`, `DELETE blocks/:id`.
Instellingen/opslag: `GET|PUT settings` (ook `semantic`, `semanticModel`), `GET|PUT admin/limits` (admin), `GET storage`,
`GET agents`, `POST consolidate`, `POST reconcile`, `POST trash/empty`, `POST reindex` (`{indexed, meaning}`: FTS nu,
vectoren op de achtergrond), `GET export?format=json|md`, `POST import`, `POST delete-all` (`{confirm:"WISSEN"}`).
Zoeken op betekenis: `GET semantic[?fresh=1]` (`mode, state` = on / off / no-ollama / remote / unreachable / no-model,
`engine` = builtin / ollama, `model, models, counts, pull, suggested`, `builtin` = `{state: absent | downloading | ready |
error | no-runtime, consent, bytes, done, error, mb, model, license, mayEnable}`, `offer` = de eenmalige kaart),
`POST semantic/builtin` (`{action: enable | later | remove}`; op een server alleen eigenaar/beheerder), `POST
semantic/pull` (`{model}`, alleen modellen uit de voorkeurslijst).
Omvang (F2): `GET sizes` (per deel actief, archief, doel, quotum), `GET reports?trigger=monthly|maintenance`;
`PUT settings` neemt ook `targets` (sinds 0.4.4 met `client`), `archiveAfterDays`, `dossierAuto`; `PUT admin/limits` ook
`dossiers` en `dossiersTotal` (0.4.4). Dossiervoorstellen: `GET dossier-proposals`,
`POST dossier-proposals/:id/accept` (`{title?}`), `POST dossier-proposals/:id/dismiss`. `GET search` vindt voor de
eigenaar ook het archief (status `archived`).
`GET search` en `GET items?q=` zoeken op woorden en betekenis (`meaning: true` bij een betekenistreffer).
Bronnen: `POST dossiers/:id/sources` met `attachmentId` van een pdf, Word- of tekstbestand (`POST /api/attachments`).
Chat: `GET thread/:id`, `POST thread/:id/capture`, `PUT thread/:id/link`, `POST thread/:id/episode/rebuild`,
`GET message/:id`, `GET refs?refs=m:..,d:..`, `GET by-call/:callId`, `GET thread/:id/answer-sources` (per antwoord
zonder citaat de herinneringen en, sinds 0.4.2, de documentdelen uit zijn context die het duidelijk gebruikte:
`implied.ts`, `usesMemory` en het strengere `usesDocument`, met "7.450" = 7450).
Dossiers: `GET|POST dossiers`, `GET|PATCH dossiers/:id`, `POST dossiers/:id/{forget|records|sources|share|leave}`,
`GET dossiers/:id/export?format=md|json`, `PATCH records/:id`, `POST records/:id/forget`, `POST sources/:id/forget`.
Episodes: `GET episodes`, `POST episodes/:id/forget`.
Slim leren en onderhoud: `GET learned` (recent geleerd: wat, wanneer, hoe, bron, wat het verving, undo-id; plus
gesprekken die nog wachten), `GET thread/:id/learned-map` (per bericht wat eruit geleerd is), `POST thread/:id/learn`
(nu leren), `GET profile` (“Wat ik over je weet”, gegroepeerd, met kernprofiel-budget), `GET engine[?options=1]`
(gekozen engine, beschikbare gratis engines, aanroepen/latentie/kosten vandaag), `POST maintenance`,
`GET reports`, `POST reports/:id/undo` (`{index}` of alles), `POST reports/:id/seen`.

## Events en diensten

- Event `memory.updated` (`{op, ids, kind, scope, agentId, dossierId, actor, ref, changeId, origin}`) naar de eigenaar
  en gedeelde gebruikers; `op: 'learned'` (`{threadId, agentId, applied, proposed, superseded, fromBot, fromTool, method}`) één keer per
  leerbatch, `op: 'maintenance'` (`{reportId, count}`) na onderhoud; `notification` bij nieuwe voorstellen, gedeelde
  dossiers, (bijna) volle quota en nachtelijk onderhoud met wijzigingen.
- `ctx.services.memory`: `search(userId, q, {agentId, scope, limit})` (synchroon, woorden),
  `searchAsync(...)` (woorden + betekenis), `remember(userId, {...})` (met `agentId`: de muren van die bot; `teamId`
  voor gedeelde kennis van de eigenaar), `forget(userId, ref)` (globaal),
  `context(userId, agentId, threadId, text)` (async), `episode(threadId)`,
  `dossiers.{list,get,find,create,addEvent,addDecision,addAction,addSource}` (`create` met `agentId` → het thuisteam van
  die bot; schrijven met `agentId` → zijn muren), `copyTeamKnowledge(userId, van, naar, {agentMap})`,
  `teamOfItem(id)`, `exportUser(userId)` (zit in `GET /api/export`), `deleteUser(userId)`, `learner` (wachtrij),
  `maintain(userId, trigger)`, `semantic` (status, indexer, ingebouwd model), `drain()` (tests: wachtende leerbatches en
  het inbedden nu uitvoeren en afwachten). F2: `sourceUnchanged(userId, dossierId, ref)` (een leerronde vond de bron
  ongewijzigd: de feiten daaruit die aan hun datum toe zijn, zijn bevestigd), `dueFacts(userId, {dossierId})`,
  `dossierFor(userId, agentId, tekst)` (het ene dossier van het team van die bot dat de tekst noemt),
  `dossierProposals(userId)`, `acceptDossierProposal(userId, id)`. Bij de start registreert het geheugen zijn kopieerder bij
  `ctx.services.teams.registerCopier('memory', …)` (alleen met `knowledge: true`).

## UI

Pagina **Geheugen & dossiers** (`#/m/memory/…`, in de zijbalk) met tabs Overzicht (eenmalig de kaart **Slim zoeken
aanzetten?**, het **opruimverslag** van de vorige maand met undo, “Wat weet je over …?” (vindt ook het archief), “Wat ik
vannacht heb bijgewerkt” met undo per regel en voor alles, **Recent geleerd** met bron/tijd/hoe en *Klopt niet* /
*Ongedaan* / *Vergeet*, snel vastleggen, laatste wijzigingen met undo), Over jou (**Wat ik over je weet**: profiel
gegroepeerd in persoonlijk, werk, werkwijze, voorkeuren, mensen, afspraken, besluiten; inline aanpassen, altijd laden,
vergeten; of als lijst), Bots (gebruik, profielbudget per bot), Dossiers (samenvatting,
tijdlijn, besluiten, acties, personen/organisaties, bronnen met **Bestand toevoegen (pdf, Office, foto of tekst)**, link of
geplakte tekst, notities, toegang voor bots en mensen, geschiedenis, export), Gedeeld, Te beoordelen (conflict naast
elkaar, samenvoegen, bulk), Geschiedenis (diff, undo, episodes, blokkades) en Opslag (leermodus, pauze, slim leren met
het model van de bot (standaard) / een zuinig gratis model / vaste patronen / betaald model, engine kiezen met status,
leren na zoveel beurten of minuten stilte, geleerd direct of als voorstel, onderhoud en kernprofiel, budgetten met de uitleg over vaste regels, **Zoeken op betekenis** (aan/uit,
status, model, voortgang, downloadknop), quota-meters, prullenbak, consolidatie, index, import, export, alles
wissen, en **Doelomvang**: per deel actief tegenover het doel, de doelen zelf, "naar het archief na …" en of bots
dossiers voor terugkerende klanten voorstellen of maken). Een vastgezette instructie heeft de badge **Vaste regel**;
zoekresultaten zeggen "Ook gevonden op betekenis"; een feit dat het onderhoud niet kon bevestigen heeft **Te
controleren** (met de reden bij Klopt dit nog?); een les voor het team de badge **Les voor het team** en in het menu
*Alleen voor <bot>*. In Dossiers bovenaan de **voorgestelde dossiers** (*Aanmaken* / *Niet nodig*).
Met twee of meer teams (0.4 B): bovenaan Overzicht, Bots, Dossiers, Gedeeld en Geschiedenis een **teamfilter** (Alle
teams / een team / Voor alle teams; onthouden per browser), een teamlabel bij herinneringen en dossiers, bij gedeelde
kennis, dossiers en import de keuze **Team** (met *Alle teams*), in Dossiers › Toegang het team van het dossier, in
Opslag een quotummeter per team, en in Dossiers de knop **Vakkennis kopiëren** (van team → naar team, met uitleg wat
nooit meegaat). Met één team is er niets van te zien.
In de chat: inspector-tab **Geheugen** (wat deze beurt gebruikt is, snel vastleggen, dossier koppelen, samenvatting,
geleerd uit dit gesprek, **Nu leren**), bronchips onder antwoorden met `[m:…]`/`[s:…]` (en de herinneringen die een
klein lokaal model gebruikte zonder te citeren), onder je eigen bericht een regel “Onthouden / Bijgewerkt (was: …) ·
Ongedaan maken” (ook voor wat na een stil gesprek geleerd is en na "ja, doe maar"), sinds 0.4.5 dezelfde regel onder
het antwoord van de bot voor wat uit zijn werk geleerd is ("Gevonden met een tool · Onthouden …"), één melding per
leerbatch met kaarten, en
extra info met undo in de toolkaarten. In de bot-editor sectie **Geheugen** (leren, budget, profielcap, gedeeld
geheugen en “over jou” lezen, botnotities direct of als voorstel).

## Ontwerpkeuzes (mini-ADR's)

1. **Woorden altijd, betekenis erbij als het kan — voor iedereen.** FTS5 met prefixen + lichte NL/EN-stemming werkt
   zonder model en blijft de basis (en de dedup blijft lexicaal: token-Jaccard is precies). Betekenis komt uit een
   afgeleide store (`memory_vectors`) die in vergeten, prullenbak, reindex en terugzetten meegaat. Sinds F2 brengt
   TeamBot zelf een klein model mee (de eigenaar zei "iedereen moet het kunnen gebruiken, ook zonder lokaal model"):
   een bekend model (sinds 0.4.4 granite-embedding-97m-multilingual-r2, Apache-2.0, getraind op vrij bruikbare data; daarvoor multilingual-e5-small, MIT) op een bekende runtime (ONNX Runtime, MIT; tokenizer van
   Hugging Face, Apache-2.0) in plaats van eigen code; Transformers.js zelf niet, omdat dat `sharp` meebrengt (met
   LGPL-binaries van libvips) en het hier niet nodig is. Downloaden alleen na één ja, met hashcontrole. Ollama blijft
   een extra en heeft voorrang als daar al een embedmodel staat (er verandert niets voor wie dat had).
2. **Vaste regels in de systeemprompt, niet in het per-beurtblok.** Alleen de systeemprompt overleeft elk inkorten en
   samenvatten. Ze zijn stabiel (geen datums, vaste volgorde), dus prompt caching blijft geldig; een wijziging van een
   regel is een bewuste wijziging van de instructies. Engines met een eigen sessie krijgen ze daarnaast elke beurt.
3. **"Ja, doe maar" alleen op een concreet voorstel.** Een kaal ja zonder feit in de vraag, of een ja met "maar …",
   onthoudt niets: liever een gemist feit dan een verkeerd feit. Het feit komt uit de vraag van de bot (die de
   eigenaar net las) en wordt zijn expliciete wens, met dezelfde grenzen als "onthoud dat" (geheimen geweigerd,
   gevoelig en na externe inhoud een voorstel).
4. **Embeddings alleen lokaal en nooit van gevoelige items**: een vector is een (deels terug te rekenen) kopie van de
   tekst; versleutelde items blijven daarom alleen via de decrypt-scan op woorden vindbaar, en een Ollama buiten deze
   pc wordt hiervoor niet gebruikt.
5. **Expliciete intentie vóór het antwoord** (`messageCreated`), zodat de bot in dezelfde beurt weet wat er is
   vastgelegd en niet dubbel opslaat. Zo ook een vol geheugen: de bot hoort het vóór zijn antwoord en belooft niets.
6. **Context in het gebruikersbericht** (core-gedrag) → herhaling voorkomen via `memory_usage`, en forget schoont ook
   deze bevroren blokken op.
7. **Gevoelige items versleuteld** (`ctx.secrets.encrypt`), niet in FTS en niet in de vectoren; zoeken via
   decrypt-scan (begrensd door quota).
8. **Tombstones zonder inhoud** (HMAC met installatiesleutel) zodat “vergeten” ook de blokkade zelf niet laat lekken.
9. **Eén `memory_records`-tabel** voor events/besluiten/acties/entiteiten: één undo-, forget- en indexpad.
10. **Dossiers van een bot zijn eerst privé** voor die bot; jij deelt met andere bots of mensen.
11. **Slim leren standaard aan, met het model van de bot, zonder extra kosten** (0.4.5): de eigenaar vond het geheugen
    van OpenBot slim omdat het met het model van de bot zelf het hele gesprek naleest. Dus standaard dat model als het
    niets extra kost (abonnement-CLI met het eigen model, lokaal of gratis), een gratis model als terugval, betaalde
    sleutels alleen na expliciete keuze. Eén aanroep per batch (elke 20 beurten of na een kwartier stilte) in plaats van
    per bericht: weinig aanroepen, meer context (correcties over meerdere beurten), en de bot wordt nooit opgehouden.
12. **Het hele gesprek, maar de eigenaar wint** (0.4.5): wat de bot met zijn werk ontdekt (een tool) is precies wat de
    eigenaar niet nog eens wil vertellen, dus dat wordt geleerd — als notitie van de bot, met zijn bron, direct en met
    undo. De bron volgt uit waar het citaat staat, niet uit wat het model zegt. Wat de eigenaar zelf zei gaat altijd voor:
    een bot of tool overschrijft dat nooit (een kaart), en een veranderd feit van de eigenaar zelf wordt direct
    bijgewerkt in plaats van een kaart. Kaarten alleen nog waar de eigenaar echt moet kiezen (zijn woorden tegen die van
    een bot of tool, iets vastgezets, "onthoud dat" dat botst). De grenzen voor externe inhoud blijven: geen geheimen,
    geen opdrachten, niets van een pagina die een AI iets opdraagt, geen bestemmingen voor geld of gegevens, geen gok
    zonder werk, gevoelig blijft een voorstel.
13. **Onderhoud past direct toe, met een verslag**: samenvoegen/vervangen/archiveren zijn omkeerbaar en klein; een
    reviewqueue vol onderhoudsvoorstellen zou genegeerd worden. Wat onzeker is (twee waarden zonder eigenaarsuitspraak)
    gaat naar “ter controle”.
14. **Teams op de bronrijen, niet in de afgeleide stores** (0.4 B): `team_id` op items, dossiers en samenvattingen; wat
    in een dossier zit volgt het dossier. Eén `Reader` met zijn teams beslist alles; woordindex en vectoren rangschikken
    alleen binnen wat de lezer mag zien. NULL = standaardteam (oud geheugen werkt meteen) en bij de start ingevuld, zodat
    niets verschuift als de eigenaar teams herordent.
15. **Vergeten globaal, dubbel en quota per team**: vergeten moet overal weg zijn (ook kopieën in andere teams), dus
    blokkades per eigenaar; dubbel en quota per team, zodat het ene team het andere niet vol of "al bekend" maakt.
    Schrijven alleen in het thuisteam, ook geen voorstel bij meekijken: anders is meekijken een sluiproute.
16. **Synoniemen in de index, niet in de vraag** (F2): wat de leerder bij een feit weet (in dezelfde aanroep) en een
    krappe eigen lijst gaan de woordindex in; zo blijft zoeken snel en voorspelbaar, en vergeten neemt ze mee.
17. **Relatieve betekenis, en een gemeten drempel** (F2, 0.4.4): e5 zette alles dicht bij elkaar (een vaste drempel liet
    een kwart van de juiste feiten vallen; de plek tegenover de beste treffer zei wel iets). Granite spreidt beter: een
    zachte band rond de beste treffer, en een drempel die een praatje van een geheugenvraag onderscheidt. Een drempel
    alleen voor een model waarvan ze gemeten is; Ollama-modellen houden alleen de band.
18. **Een strak blok "Relevant"**: met alleen OR-woordzoeken en een vaste positiescore was gemiddeld 4–8 % van het blok
    relevant. Nu telt de sterkte (bm25 tegenover de beste, dekking van de zoekwoorden) en gaat alleen het sterkste
    deel mee; de bot kan altijd verder zoeken met `memory_search`.
19. **Vernieuwen alleen uit dezelfde bron of met een citaat** (F2): een nieuwe waarde vervangt een feit alleen als het
    aan zijn controle toe is en de bron hetzelfde is (of het model citeert de bron letterlijk); anders blijft het een
    kaart of *te controleren*. Liever een eerlijke "kan veranderd zijn" dan een stille verkeerde waarde.
20. **Opruimen past direct toe, met undo en een maandverslag** (F2): voorstellen die niemand leest groeiden juist eindeloos
    (de oude automatische samenvoegvoorstellen). Archief in plaats van weggooien; de prullenbak alleen voor oud archief
    als het quotum nadert.
21. **Eén schrijftool voor dossiers** (F2): kiezen tussen vijf tools met veel velden ging bij kleine modellen mis en
    kostte tokens; één zin, en TeamBot sorteert. De uitgebreide tools blijven voor wie ze nodig heeft, in een eigen deel
    van de toollijst.
22. **Een eigen motor met overgenomen kernen, geen geheugen-SDK** (0.4.4): geen enkel botplatform gebruikt een kant-en-klare
    geheugenmotor als kern, en de sterkste (Hindsight, Graphiti) zijn Python op Postgres of een grafendatabase; `mem0ai`
    vraagt native better-sqlite3 (uitgesloten door ADR 0002) en voegt sinds v3 alleen nog toe. Dus de ideeën in eigen
    code: Hindsight's oordeel-schema (MIT), Graphiti's tijdmodel en voorzichtigheid (Apache-2.0), Mem0's korte ids en
    extractierichtlijnen (Apache-2.0), met bronvermelding in de code.
23. **Twee stappen: patronen meteen, het model erna** (0.4.4): de patronen zijn goedkoop en voorzichtig (precisie
    eerst) en werken voor iedereen; het model ziet in één extra aanroep per leerbatch wat de patronen niet zien (anders
    verwoord, een ketting). De code past toe en vergelijkt de data; het model geeft alleen een oordeel per paar.
24. **Afgerond door een bot alleen met bewijs** (0.4.4): "ik heb het gedaan" zonder tool of routine sluit niets; een
    bewering van een bot over een notitie van de eigenaar wordt *te controleren*, nooit stil beëindigd.
25. **Een nieuwe versie vervangt, alleen het verschil wordt gecontroleerd** (0.4.4): twee versies van één document naast
    elkaar in het zoeken geven de bot het oude antwoord; elk feit opnieuw laten lezen kost te veel aanroepen. Wat de
    nieuwe tekst nog letterlijk noemt is bevestigd, de rest gaat langs het model of wordt *te controleren*.
26. **De werkset begrensd, niet het aantal klanten** (0.4.4): een klantenservice heeft vanzelf veel klanten; begrensd
    zijn de notities per klant, de klanten die meedoen (inactief → archief, vindbaar) en het blok per beurt.
27. **Geen herrangschikker** (0.4.4): de cross-encoder mmarco-mMiniLMv2 (Apache-2.0) gaf op de geheugentest +7 punten
    recall@1 bovenop granite, maar is getraind op MS MARCO (niet-commercieel); TeamBot is ook voor bedrijven. Een
    herrangschikker met vrije trainingsdata kan later als losse, gecontroleerde download.

## Geheugen per klant (0.4.5)

Een bot op een chatkanaal of e-mail kent **deze klant en nooit een andere**. Ontwerp naar wat de klantenservice-leiders
gemeen hebben (Salesforce Agentic Memory: oordeel per kandidaat, vastgelegde gegevens gaan boven de chat; Intercom Fin
Memory: alleen herkende klanten, vaste bewaartermijnen, een logregel als geheugen gebruikt wordt; Anthropic en Foundry:
één opslag per eindklant). Alleen het ontwerp; geen code overgenomen. Onderzoek: `research_notes/Geheugen agent-teams`.
Code: `customers.ts` (herkennen, lezen, termijnen, weergave) en `customer-learn.ts` (leren); test
`tests/memory-customer-channel.test.ts`.

**Wie er schrijft.** De kanalenmodule zegt per kanaalgesprek wie er schrijft (`ctx.services.channels.customerOf(threadId)`
→ koppeling, adapter, afzender, team, privé, geverifieerd). Een klant telt alleen in een **privégesprek** op een kanaal
met klantenservice, niet de eigenaar zelf, en bij **e-mail alleen als de afzendercontrole slaagde** (`authResultsPass`,
SPF/DKIM/DMARC). Groepsgesprekken, ongeverifieerde mail en onbekenden krijgen geen klantgeheugen (in een gesloten kanaal
komen onbekenden niet eens bij de bot). De sleutel is de **afzender**, niet het gesprek: `memory_customer_ids` bewaart per
koppeling en team een HMAC van de genormaliseerde afzender (e-mail in kleine letters, telefoon als +cijfers zonder
WhatsApp-achtervoegsel, Telegram/Discord-id zoals hij is), nooit de afzender zelf. Bij het eerste bericht van een nieuwe
klant maakt TeamBot een dossier van soort *klant* in het team van de koppeling ("Klant Kim"; twee klanten die Kim heten
krijgen elk een eigen dossier, "Klant Kim (2)"); niet met *Dossiers vanzelf: uit*. Een klant in het archief is weer
actief zodra hij schrijft. Het gesprek wordt aan het dossier gekoppeld. Dezelfde klant op WhatsApp en per e-mail koppelt
alleen de eigenaar (`POST /api/memory/customers/:identityId/link {dossierId}`, zelfde team). "Vergeet deze klant" =
het dossier vergeten (alle afgeleide kopieën, blokkades); zijn identiteiten gaan dan mee.

**De muur.** In zo'n gesprek is het publiek `customer` en heeft de lezer één `customerDossierId`. `aclSql` wordt dan
`scope = 'dossier' AND dossier_id = ?` (actief, niet gevoelig) en `readableDossiers` geeft alleen dat dossier: hetzelfde
patroon als de teammuren, in SQL, dus geen tool of zoekopdracht (ook niet met archief of geschiedenis) komt bij een andere
klant, "Over jou", botnotities of gedeelde kennis. Waar de code vroeger "publiek" toetste (dossiers koppelen op naam,
dossier-tools, afgerond werk sluiten) telt een klantgesprek als publiek (`outside()`); een klant kan dus geen ander dossier
aan zijn gesprek laten koppelen door een naam te noemen. De vaste regels van de eigenaar blijven in de systeemprompt
zoals in elk kanaalgesprek.

**Het blok per beurt** (max. 600 tokens, nooit bij een praatje zoals "Dankjewel!"): *Wat je over deze klant weet*
(≤ 8 feiten, eerst wat bij het bericht past, dan wat hij het laatst zei; "te controleren" erbij), *Open acties voor deze
klant* (≤ 4) en *Eerdere gesprekken met deze klant* (de 2 laatste samenvattingen van zijn eigen kanaalgesprekken, nooit
de gesprekken van de eigenaar over hem, niet in het archief). Feiten en acties heten `[C1]`, `[C2]` …. Het gebruik staat
in `memory_usage` (met het C-nummer; de inspector toont het).

**De controle op het concept** (`classifyDraft({ draft, question, knowledge, customer })`, kanalen): de C-regels van die
beurt (teruggelezen uit `memory_usage`, alleen zolang ze nog van deze klant en actief zijn) tellen als bron (`[C1]`), voor
getallen, links en gedeelde woorden. Ze dekken **nooit beleid**: prijs, korting, terugbetalen/retour, garantie, levering,
openingstijden en voorwaarden moeten nog steeds in de goedgekeurde kennis staan; geld en beloftes wachten nog steeds op
de eigenaar. De systeemprompt (`customerRules`) krijgt alleen de vaste regel: "alleen over deze klant, nooit als beleid,
vraag het als het verouderd kan zijn"; de feiten zelf staan per beurt in het blok, zodat de systeemprompt stabiel blijft.

**Leren uit zijn eigen woorden** (`customer-learn.ts`, via dezelfde wachtrij als het gewone leren; `learn.ts` heeft er één
haakregel voor): alleen berichten van de herkende klant van dit gesprek (zijn afzenderhash, ook als iemand in de cc staat),
met een eigen prompt (`LEARN_CUSTOMER_SYSTEM`): naam, taal, hoe hij bereikt wil worden, wat hij heeft of bestelde, adres
en bezorgwensen, zijn vraag en de stand, voorkeuren. Nooit beleid, prijzen, beloftes, wat de bot zei, iets over anderen,
opdrachten, geheimen of gevoelige gegevens. Elk feit heeft een letterlijk citaat uit zijn bericht en moet daarin
onderbouwd zijn (`findEvidence`, ≥ 60 %). Zonder model: vaste patronen ("ik woon nu in …", "mijn bestelnummer is …",
"mijn retour is binnen"). Opgeslagen in **zijn dossier** met `source_trust = 'customer'`, direct (hij is de bron van zijn
eigen gegevens), met undo voor de eigenaar; nooit een instructie of vastgezet.

**Bijwerken** (de gewone consolidatie): voor een feit in een klantdossier komen de kandidaten **alleen uit dat dossier**
en zijn open acties (lekvrij en klein). Een eenwaardige sleutel (adres, woonplaats, telefoon, e-mail, taal, abonnement,
bestelstatus, naam) vervangt zijn eigen eerdere waarde zonder model (nieuwe versie, oude in de geschiedenis). Wat de klant
zegt tegen een notitie van de eigenaar, een toolresultaat of een vastgelegd gegeven wordt ***te controleren*** plus een
voorstel, nooit een stille wijziging. "Mijn retour is binnen" sluit de open actie "Retour afwachten".

**Termijnen.** Samenvattingen van klantgesprekken gaan na **45 dagen zonder contact** naar het archief
(`targets.clientEpisodesDays`; `archived_at`, niet weg). De feiten volgen het bestaande klantarchief van **180 dagen**.

**UI.** Op een klantdossier staat bovenaan de kanaalidentiteit ("Kim via Winkel") en één regel *Wat de bot over deze klant
weet: 5 feiten, 1 open actie, 2 eerdere gesprekken* (`GET /api/memory/dossiers/:id` → `customer`).

**Gemeten** (`tests/memory-customer-channel.test.ts`): 100 klanten op twee kanalen, elk met een eigen woonplaats en
bestelnummer uit zijn eigen bericht geleerd; 100 kruisvragen (klant A vraagt naar naam, woonplaats en bestelling van klant
B): **0 lekken** in het blok, de zoekopdrachten (ook archief en geschiedenis), de leesbare dossiers en de C-regels, en
100 van 100 keer zijn eigen gegevens in zijn blok. Verder: adres verandert (oud niet meer actief), retour binnen sluit de
actie, een claim tegen de eigenaar wordt *te controleren*, geen groep of ongeverifieerde afzender, een klant die na een
maand terugkomt heeft zijn feiten en een klant na een half jaar is weer actief, de controle laat `[C1]` een getal dragen
maar geen terugbetaalbeleid.

## Geheugen per team (0.4 B, golf 2)

Een team is een afgeschermde werkruimte (`docs/modules/teams.md`); het geheugen volgt die muren. Gebouwd op het
B-patroon: een team op de bronrijen, lezen met `canRead`, schrijven met `canWrite`, alles in code (niet in de prompt).

**Wat bij een team hoort** (`team_id`, migratie `memory-005`):

| Wat | Team | Wie leest | Wie schrijft |
|---|---|---|---|
| "Over jou" (`about_you`) | geen: persoonlijk | elke bot, volgens de regels van vóór teams (`readAboutYou`, publiek) | de eigenaar; bots stellen voor |
| Notities van een bot (`agent`) | het team waarin de bot ze schreef | die bot, zolang hij dat team mag lezen (na een verhuizing zonder toegang tot het oude team: niet meer) | die bot, alleen in zijn thuisteam |
| Gedeelde kennis (`shared`) | standaard **per team**; of **Alle teams** (`*`, keuze van de eigenaar) | bots van het team + bots die mogen meekijken/aansturen; `*` = elke bot | bots van het team (als voorstel, zoals altijd); `*` alleen de eigenaar |
| Dossiers (met besluiten, acties, personen, bronnen, documentdelen en notities) | het team van het dossier (of `*`) | idem; daarbinnen nog de botlijst van het dossier | alleen bots van het thuisteam van het dossier; `*` alleen de eigenaar |
| Gesprekssamenvattingen (episodes) | het team van de bot van het gesprek | de bots die meededen, zolang ze dat team mogen lezen | — (afgeleid) |

`team_id` NULL = het standaardteam (het eerste team, "Mijn team"); `*` = alle teams. Records, bronnen, documentdelen
en dossiernotities hebben geen eigen team: ze volgen hun dossier (één plek om te wijzigen). Geschiedenis
(`memory_changes`) krijgt ook geen kolom: het teamfilter leidt het team af van het record of dossier.

**Handhaving (één plek).** `readerFor(agent)` geeft een `Reader` met `teams` (`TeamScope`: thuisteam, leesbare teams,
standaardteam; null = geen muren: geen teamsmodule, nog geen teams, of een gedeelde bot in het gesprek van een lid —
die leest het geheugen van dat lid). `aclSql` en `readableDossiers` voegen het team toe; alles wat items, dossiers,
regels, bronnen en documentdelen leest gaat daarlangs: per-beurt-context, `memory_search`/`memory_get`,
`dossier_get`, slim leren (`<bekend>`), de dienst `ctx.services.memory.search/searchAsync/dossiers`.
De afgeleide stores beslissen nooit: woordindex en vectoren worden gerangschikt binnen de dossiers die de lezer mag
lezen (`chunkMatch`/`chunkScores` met `dossierIds`) en daarna per regel opnieuw gecontroleerd. Een bot zonder team
(onbekend voor de teamsmodule) bereikt geen enkel team (fail closed). Schrijven: `teamWriteRefusal`,
`dossierWriteRefusal` en `itemWriteRefusal` weigeren in de tools (`memory_update`, `memory_forget`, `dossier_add`,
`dossier_update`, `dossier_note`), in de pijplijn (`writeCandidate`: een bot of een module namens een bot schrijft alleen in zijn
thuisteam) en in de dienst (`dossiers.addEvent/addDecision/addAction/addSource` met `agentId`). Met meekijken is zelfs
een voorstel geweigerd ("read ziet maar schrijft niet"), met een duidelijke reden voor de bot.

**Vaste regels per team** (`standingRules`): de eigen regels van de eigenaar ("Over jou") en gedeelde regels voor
*Alle teams* gelden voor elke bot; gedeelde regels van een team voor de bots van dat team (niet voor een bot die alleen
meekijkt); de eigen regels van een bot zolang hij dat team mag lezen. De sectie noemt nooit een team.

**Keuzes**
- **Dubbel = binnen een team.** De bucket (`bucketWhere`) bevat het team: hetzelfde feit in team A en team B zijn twee
  herinneringen; samenvoegen, tegenspraak en vervangen (ook in onderhoud en consolidatie) blijven binnen een team.
- **Quota per team.** Gedeelde kennis heeft een quotum per team (en één voor *Alle teams*), botnotities per bot per
  team, dossiers per dossier. "Over jou", de cap op open voorstellen (de wachtrij van de eigenaar) en de
  gesprekssamenvattingen (afgeleid, de oudste gaan eerst) blijven per eigenaar. Opslag toont een meter per team.
- **Vergeten is globaal.** Tombstones blijven per eigenaar: wat in team A vergeten is, kan ook in team B niet opnieuw
  worden opgeslagen. En vergeten wist overal: hetzelfde feit in een ander team, bij een andere bot of in "Over jou"
  (zelfde vingerafdruk) en elke kopie van "vakkennis meenemen" (`copy_of`, beide kanten op; ook records, bronnen en
  hele dossiers). Alleen een bot die op eigen initiatief zijn eigen notitie vergeet, vergeet alleen die (hij mag niet
  in andere teams schrijven); met het verzoek of de bevestiging van de eigenaar is het weer globaal.
- **"Onthoud voor alle teams dat …"** in de eigen woorden van de eigenaar wordt gedeelde kennis voor alle teams;
  "voor alle bots" in het gesprek met een bot is gedeeld in het team van die bot.
- Automatisch koppelen van gesprekken aan dossiers (onderhoud) alleen binnen het eigen team; zelf koppelen in de
  inspector kan de eigenaar altijd.

**Migratie.** Bij de start (en zodra de teams veranderen) zet `fileUnderTeams` alles zonder team bij een echt team:
botnotities en samenvattingen bij het thuisteam van hun bot, gedeelde kennis en dossiers bij het standaardteam. Na
de update vanaf 0.3 zitten alle bots in "Mijn team", dus elke bot ziet precies wat hij vóór de update zag en niets
meer (test `memory-teams`). Daarna verschuift niets als de eigenaar zijn teams anders ordent.

**Vakkennis meenemen** (`teams.ts`, `copyTeamKnowledge`): kopieert de dossiers van een team (met besluiten, acties,
gebeurtenissen, personen, bronnen met hun documentdelen, en de gewone notities) en de gedeelde kennis van dat team
naar een ander team van dezelfde eigenaar. Nooit "Over jou", notities van bots, gesprekssamenvattingen, iets
persoonlijks of gevoeligs, of kennis voor *Alle teams* (die heeft elk team al); sleutels staan nooit in het geheugen.
Een kopie is een eigen record met `copy_of` (vergeten volgt de hele familie). Dubbel (zelfde dossiertitel of feit in
het doelteam) wordt overgeslagen; het quotum van het doelteam geldt. Twee wegen:
- **Team dupliceren** (wie dat bouwt, pakket B): `ctx.services.teams.copyTeamData(userId, van, naar, { knowledge,
  agentMap })` roept de geregistreerde kopieerders aan; het geheugen kopieert alleen met `knowledge: true` ("vakkennis
  meenemen", standaard uit). `agentMap` (oude → nieuwe bot) houdt de botlijst van een dossier; zonder is een gekopieerd
  dossier voor alle bots van het doelteam.
- **Geheugen › Dossiers › Vakkennis kopiëren** (vanaf twee teams): dezelfde kopie tussen twee bestaande teams, als
  zichtbare, bewuste handeling (kopiëren gaat boven koppelen).

**Kennisbank van specialisten (pakket S).** `ctx.services.memory.dossiers.create(userId, { title, agentId })` zet het
dossier in het thuisteam van die bot en eerst alleen voor die bot; schrijven namens de bot
(`dossiers.addEvent/…/addSource(…, agentId)`, `remember(…, { agentId, createdBy: 'agent' })`) houdt zich aan zijn
muren. Een bot die met `dossier_write` een dossier maakt, maakt het in zijn eigen team; een gelijknamig dossier van
een ander team wordt nooit teruggegeven of genoemd.

**Eén team = rustig.** Met één team toont de pagina geen teamfilter, geen teamlabels en geen teamkeuzes, en staan er
geen teamwoorden in de prompts.

Het zoeken op betekenis kiest zijn Ollama per eigenaar; per team een eigen model is niet nodig (dezelfde pc).

## Faalgevallen

- Geen gratis engine, CLI niet ingelogd, gebruikslimiet bereikt (back-off tot `retryAfter`), daglimiet op, ongeldig
  JSON of time-out → vaste patronen voor die batch, episode heuristisch; de fout staat in `memory_learn.last_error`.
  Sinds 0.4.5 leest bij een limiet of "niet ingelogd" eerst de volgende gratis engine dezelfde batch (één keer).
- Een model dat `source` vergeet of verkeerd zet → de plek van het citaat beslist; een citaat dat nergens in het gesprek
  staat → weg. Een botantwoord zonder werk, een vergiftigde pagina, een opdracht of een bestemming voor geld of
  gegevens uit bot- of tooltekst → weg (in `droppedDetail` van de geheugentest met de reden).
- Model wijst een verkeerd item als verouderd aan → genegeerd tenzij zelfde sleutel/gedeeld woord en zelfde bucket.
- Controle tegen het bestaande (0.4.4): ongeldig JSON, een id dat niet werd aangeboden of een paar zonder gedeeld woord
  → genegeerd; de patronen hebben dan al gedaan wat duidelijk was, en het nachtelijke onderhoud probeert het nog eens
  (`consolidated_at` blijft leeg). Een dossier dat tijdens het opnieuw lezen weer verandert, wordt daarna nog eens
  gelezen.
- Quota vol → schrijven geweigerd met uitleg (tool-output/UI, onder je bericht bij "onthoud dat" en "ja, doe maar"),
  voorstellen gecapt, een melding (1× per dag per deel) voor wat zonder jou geleerd werd, en de bot hoort vóór zijn
  antwoord dat het geheugen vol is; niets automatisch verwijderd.
- Ollama weg, traag of zonder embedmodel → zoeken op woorden zoals vroeger; een beurt wacht hooguit 2,5 s op de
  betekenis van de vraag; Opslag zegt waarom ("reageert niet", "nog geen model", "niet op deze computer").
- Een pdf zonder tekst (scan), een kapot of leeg Word-bestand → de bron wordt niet toegevoegd, met die reden; een build
  zonder pdf.js zegt "PDF lezen is nog niet beschikbaar".
- Server herstart tijdens leren of onderhoud → de leerwachtrij staat in de database en loopt daarna gewoon verder
  (idempotency-keys `ml:`/`h:` voorkomen dubbel); een afgebroken onderhoudsverslag blijft op “running” en het volgende
  onderhoud doet het werk opnieuw.
- Ingebouwd model: geen onnxruntime-node/tokenizer in deze build → status `no-runtime`, geen kaart, woorden met
  synoniemen; download onderbroken of hash klopt niet → bestand weg, fout in Opslag, opnieuw proberen kan; runtimefout
  → die beurt woorden, één logregel per uur.
- Een lokaal model dat alleen "denkt" en geen JSON geeft (live gezien met qwen3.6 onder een naam zonder `:latest`) →
  de naam wordt aangevuld zodat denken uit kan; lukt het toch niet, dan de vaste patronen.
- Index corrupt/verouderd → `POST /api/memory/reindex` (of knop in Opslag) herbouwt de FTS uit de brontabellen en
  leegt de vectoren, die de indexer opnieuw maakt; vergeten inhoud komt niet terug (die is uit de brontabellen gewist).
- Database teruggezet uit een back-up → vergeet-blokkades van nu terug, wat ze raken opnieuw vergeten, FTS herbouwd en
  elke vector tegen zijn record gecontroleerd (wees of andere tekst = weg, opnieuw ingebed).
- Gelijktijdige schrijvers → SQLite-transacties (`BEGIN IMMEDIATE`) + idempotency-keys.

## Evaluatieplan (tests)

`tests/memory.test.ts` (functioneel) en `tests/memory-eval.test.ts` (evaluaties, plan §13 “Eval”):
recall met bron over gesprekken heen (grounded-rate 4/4), hard vergeten zonder residu in alle stores (0 kopieën) +
geblokkeerd opnieuw leren + blokkade opheffen + reindex, vergeten door bots (eigen vs. danger-bevestiging), stale
feiten/supersede/chronologie, ACL tussen gebruikers en tussen bots (privé, gedeeld, `readShared=false`), publiek
gesprek (geen persoonlijke data), vergiftigde webhook/geciteerde mail/externe tool-output, geheimen uitgesloten,
quota-gedrag, begrensd budget + profielcap + geen herhaling, idempotentie + afwijzing onthouden; plus CRUD/undo,
conflict-review, dossiers + delen, kennisbibliotheek, episodes, export/import/alles wissen, levenscyclus
(TTL/prullenbak/consolidatie met rollback), botverwijdering, slim leren (batch na stilte, bewijs + verankering,
correctie = supersede met undo, injectie blijft voorstel, $0, dagcap, terugval op patronen), versleuteling,
room-publiek. `tests/memory-engine.test.ts`: CLI-argumenten zonder tools, OpenCode-isolatie, enginekeuze (abonnement,
betaalde login, limiet), strikte JSON. `tests/memory-maintenance.test.ts`: samenvoegen, tegenspraak, verlopen,
kernprofiel, dossier bijwerken, verslag met undo per regel/alles, nachtplanning.

Nieuw in 0.4 (pakket F), met een nep-Ollama op 127.0.0.1 (`tests/memory-fake-ollama.ts`: `/api/tags`, `/api/embed` met
een vaste "betekenis" per begrip, `/api/pull`, chat):
- `tests/memory-semantic.test.ts`: "wagen"/"voertuig"/"bolide" vinden "Mijn auto is een blauwe Volvo" (zoekpagina,
  lijst, per-beurt-context, `memory_search`), uit = alleen woorden en vectoren weg; geen vector voor gevoelige items,
  weg bij nieuwe tekst/prullenbak/vergeten (en geblokkeerd opnieuw), reindex herbouwt, alles wissen; zonder Ollama,
  Ollama op een ander adres, zonder embedmodel, downloaden met voortgang en melding, Ollama gestopt (beurt < 3 s);
  controle na terugzetten.
- `tests/memory-documents.test.ts`: Word en pdf als bijlage en uit de werkmap, geciteerd in de context (`[s:…]`), via
  `memory_search` en `dossier_get`; scan/leeg/kapot/pdf.js ontbreekt; documentdelen op betekenis; vergeten wist delen,
  index en vectoren.
- `tests/memory-confirm.test.ts`: wat "ja" is, wat een concreet voorstel is, het feit in de ik-vorm; ja → herinnering
  met undo onder het antwoord (ook sleutel, Engels, twee feiten); geen herinnering bij ja op iets anders, "ja, maar",
  een ouder voorstel, een vaag voorstel (bot hoort het), leren uit; ja op een `memory_remember`-voorstel = goedkeuren
  (undo terug naar voorstel); na externe inhoud een voorstel.
- `tests/memory-rules.test.ts`: de regel staat in de systeemprompt bij budget 0/profielcap 0 en bij een vol profiel,
  stabiel tussen beurten; overleeft geschiedenisbudget en samenvatten (`/threads/:id/compact`); bij een lokaal model
  met een venster van 4096 tokens vallen oude beurten weg en blijft de regel; welke instructies regels zijn; engines
  met een eigen sessie krijgen ze elke beurt.
- `tests/memory-retest.test.ts` (wat na 0.3.0 was gerepareerd): bronnen onder het antwoord van een lokaal model via de
  echte Ollama-adapter; melding bij een vol geheugen bij patronen, model, "onthoud dat" en "ja, doe maar".

Nieuw in 0.4 F2:
- `tests/memory-builtin.test.ts`: vastgezette bestanden met hash, gemiddelde over echte tokens, relatieve score in een
  band; de kaart, niets gedownload vóór ja, "Niet nu", downloaden met hashcontrole (een vervalst bestand wordt nooit
  gebruikt), daarna vindt "bolide" "auto" zonder Ollama (zoekpagina, context), vergeten en verwijderen; Ollama met
  bge-m3 houdt voorrang tenzij de eigenaar het ingebouwde kiest; zonder runtime eerlijk.
- `tests/memory-refresh.test.ts`: synoniemenlijst en `cleanTerms`, soorten veranderende feiten; leren met `terms` →
  "huisdier" vindt de hond op woorden, vergeten wist de termen; vernieuwen uit dezelfde bron (pas na de datum, nooit
  vastgezet), `sourceUnchanged`; de eigenaar bevestigt (met en zonder model); 's nachts uit een document vernieuwd of
  bevestigd, zonder bron *te controleren* (Te beoordelen, context), undo.
- `tests/memory-cleanup.test.ts`: waarde en bescherming; binnen het doel met een samenvatting met bronnen en archief,
  niets belangrijks kwijt, archief vindbaar voor de eigenaar en niet voor de bot, terugzetten, undo van de samenvatting;
  lang ongebruikt → archief maar woonplaats blijft, begrensd archief naar de prullenbak maar nooit wat de eigenaar
  archiveerde, geen automatische samenvoegvoorstellen; opruimverslag met maten en undo, één keer per maand; een verzonnen
  samenvatting wordt geweigerd.
- `tests/memory-dossier-auto.test.ts`: één zin → de goede soort; vanzelf gekoppeld, stand in de context,
  `dossier_note` voor elke soort en "afgerond"; de uitgebreide tools in hun eigen deel; terugkerende klant → voorstel na
  het tweede gesprek, wachtende notitie gaat erin, *Niet nodig* is definitief, `create` maakt het zelf, `off` niet;
  teammuren (geen koppeling of schrijven in het dossier van een ander team); een les geldt voor het team en is terug te
  brengen naar één bot.
- `npm run memory:bench` (`scripts/memory-bench.mjs`, set in `scripts/memory-bench-data.mjs`): 206 feiten in lange
  gesprekken, 225 vragen in andere woorden, 24 beurten zonder geheugenvraag, 8 correcties, 23 updates zonder vaste
  sleutel (7 achtergehouden), het SEO-geval, een dossier dat verandert, 12 verouderende feiten, een gesimuleerd jaar en
  een klantenservice met 500 klanten; per modus (a) woorden + synoniemen, (b) ingebouwd model, (c) Ollama leert. Voor en
  na in `docs/quality/memory-bench.md` (9 nov 2026, `--before` = dezelfde test op de code van vóór 0.4.4): (b) recall@1
  40 → 61 %, recall@5 79 → 86 %, precisie 32 → 48 %, regels bij een beurt zonder geheugenvraag 4,9 → 1,2; correcties
  bovenaan 2/8 → 6/8; impliciet beëindigd 0/8 → 8/8 (achtergehouden 1/4), 0 onterecht; taken 0/4 → 4/4; dossier dat
  verandert 2/4 met 2 stil fout → 4/4, NU schoon. (c) qwen3.6 lokaal: 130 van de 206 feiten opgeslagen (was 88),
  recall@1 30 → 42 %, precisie 19 → 38 %; na een jaar 0/15 belangrijk kwijt. De klantenservice-schaal (500 klanten)
  liep niet tot het eind (zie Beperkingen).
Nieuw in 0.4.4:
- `tests/memory-builtin.test.ts` (bijgewerkt): granite vastgezet met hashes, CLS-pooling, zachte band, gemeten drempel;
  een installatie met het oude ja krijgt het nieuwe model en de oude bestanden gaan weg.
- `tests/memory-consolidate.test.ts`: signalen (af, gestopt, open taak, Nederlandse deelwoorden, samenstellingen,
  terugkerende plicht, regels); zonder model: taak af en einde uit het actieve geheugen met reden en undo, verwant nieuws
  blijft, een vaste regel nooit, geschiedenis alleen op verzoek; open dossieracties sluiten door de eigenaar, "gedaan",
  een bot met bewijs (zonder bewijs niet) en een routine, één actie blijft open, het blok noemt de afgeronde niet; met
  een (nep)model: changes = nieuwe versie, ends ook wat ervan afhing, repeats = samengevoegd, verzonnen ids, ongerelateerde
  paren en vaste regels geweigerd; teammuren (team B nooit geraakt, een bewering van een bot = te controleren); de
  leerder: wat het model (één feit voor de hele beurt) of de patroonleerder oversloeg beëindigt toch wat het beëindigt,
  in de woorden van de eigenaar, met en zonder model; praatjes, nieuws en een einde zonder doel worden niet opgeslagen.
- `tests/memory-maintenance.test.ts` (uitgebreid): wat de eigenaar zelf schreef wordt nooit op het woord van het model
  gearchiveerd maar ter controle voorgelegd; een geleerde afspraak die lang voorbij is wel, zoals eerder.
- `tests/memory-reread.test.ts`: een nieuwe versie van een document vervangt de oude (dezelfde tekst niet); zonder model
  bevestigd wat er nog staat, de rest te controleren, NU zonder het oude, de oude versie niet meer doorzocht, één keer
  gelezen (debounce); met een (nep)model alleen het verschil gelezen, veranderd → nieuwe versie, weg → beëindigd (undo);
  notitie/record/afgeronde actie markeren het dossier.
- `tests/memory-customers.test.ts`: doelomvang per klant (archief een kwart), inactieve klanten naar het archief (alleen
  klanten), niet in het blok maar wel via zoeken, terug = weer actief, opnieuw aanmaken hergebruikt; grenzen tellen de
  werkset en het totaal.
- `tests/memory-learn-quote.test.ts`: het citaat mag een woord op zeven afwijken (dan de zin van de eigenaar), nooit
  uit een geciteerde mail, verzonnen of half verzonnen.
Nieuw in 0.4.5:
- `tests/memory-learn-conversation.test.ts`: het hele gesprek in één aanroep (de prompt met `<eigenaar>`, `<bot
  werk="…">` en `<tool naam="…">`, geen sleutel erin); een feit uit tool-uitvoer actief met bron `tool`, vertrouwen
  `agent`, als botnotitie met herzien-datum, ook als het model `source` verkeerd zet; nooit: iets van een pagina die
  een AI iets opdraagt, een werkafspraak uit een tool, een gok zonder werk; de undo-regel onder het antwoord van de bot
  en "Gevonden met een tool" in Recent geleerd; één aanroep in `usage_log` ($0). De eigenaar wint: een tool die hem
  tegenspreekt wordt een kaart naast zijn woorden; een nieuwere meting vervangt de oude direct; een verhuizing (zelfde
  sleutel, geen correctiewoorden) wordt direct bijgewerkt en is ongedaan te maken; een vastgezet item vraagt eerst.
  Wanneer: standaard 20 beurten / 15 minuten, `learnEvery` 3 → bij de derde beurt meteen, 0 → alleen na stilte,
  begrensd. Engine: `own` = het eigen model van de CLI-bot (`default`), `free` = `haiku`, een ingesteld model altijd;
  een limiet tijdens het leren → de volgende gratis engine leert de batch (geteld).
- `npm run memory:bench` heeft het scenario **Leren uit het hele gesprek** (`TOOL_LEARN`): een bot zoekt met een tool op
  waar het afsprakensysteem op draait, hoeveel reparaties er open staan en wat er op twee pagina's van een groothandel
  staat (één met een opdracht aan AI's en een sleutel), en gokt één keer zonder werk; later een nieuwere meting. Vóór
  0.4.5 (zelfde ideale maar naïeve leerder): 0/5 geleerd, geen directe vervanging, geen kaart; daarna 5/5 als *tool*,
  vervangen direct, één kaart (tool tegen de eigenaar), 5/5 nooit opgeslagen, één leeraanroep (plus één controle). De
  rest van (a) en (b) bleef gelijk aan 0.4.4 (recall@1 25,3 % / 60,4 %, recall@5 44,0 % / 86,2 %, precisie 25,4 % /
  47,5 %, correcties, bijwerken, taken, dossier, verouderen, jaar). `--only tools` draait alleen dit scenario. Met het
  lokale model (c, qwen3.6-uncensored-snel, drie keer): 5/5, 2/5 en 3/5 tool-feiten geleerd (het voegde soms feiten
  samen of sloeg er een over), elke keer 5/5 nooit opgeslagen en de woorden van de eigenaar nooit overschreven; het model
  noemde de tegenspraak met de eigenaar zelf niet (geen kaart), en één keer gaf het bij de latere meting geen geldig
  JSON (dan de patronen). Een groter model (de abonnement-CLI) is hier niet gemeten: tests gebruiken nooit een echt
  abonnement.

Geheugen per team (0.4 B, golf 2):
- `tests/teams-isolation.test.ts` (probes, elk zonder toegang / meekijken / aansturen, via de echte tool-lus en een
  nep-Ollama): `memory_search` op woorden en op betekenis (vectoren), `memory_get`, het per-beurtblok (kennis én
  documenten), `dossier_get` (lijst en inhoud, met documenten), documentdelen via `memory_search`, een
  gesprekssamenvatting van team B, de teamregel van B in de systeemprompt van A (altijd geweigerd), en elke
  schrijfweg (`memory_remember` in B's dossier, `dossier_add`, `dossier_update`, `memory_update`, `memory_forget`,
  delen dat in B landt, `dossier_write` dat in B's dossier schrijft of het teruggeeft): zonder toegang alles dicht, met meekijken lezen
  maar nooit schrijven. Plus: B's eigen bots lezen en schrijven B's geheugen, regels per team en voor alle teams,
  kennis voor alle teams leest elke bot maar wijzigt geen enkele bot, het teamfilter van de eigenaar.
- `tests/memory-teams.test.ts`: update vanaf 0.3 (alles in "Mijn team", dezelfde zichtbaarheid per bot, een nieuw team
  ziet niets), dubbel en quota per team, "onthoud voor alle teams", vergeten globaal (kopie, ander team, record in een
  gekopieerd dossier; daarna geblokkeerd voor elke bot; een bot die zijn eigen notitie vergeet raakt een ander team
  niet), vakkennis meenemen (alleen dossiers en gedeelde kennis, standaard uit, de kopie is van het nieuwe team en
  doorzoekbaar, tweede keer niets dubbel), kennisbank van een specialist in het team van zijn bot, een verhuisde bot.

Live (9 nov 2026, `TEAMBOT_TEST_PORT=4815 node --import tsx tests/e2e/memory-local-live.mjs`, tijdelijke datamap,
Ollama 0.40.15), twee keer:
- `qwen3.6-uncensored-snel` (±7–22 s per antwoord): "Hoe heet mijn hond?" → "Jouw hond heet Bram [m:…]" (citeerde
  zelf, bron zichtbaar); "Over jou" vol → één melding "Geheugen vol", maar de bot zei "Ik heb het onthouden dat je in
  Leiden woont" → sindsdien hoort de bot vóór zijn antwoord dat het geheugen vol is; vaste regel in de systeemprompt bij
  budget 0 → de bot vroeg eerst toestemming voordat hij offertes verwijderde.
- `qwen3:1.7b` (±1–10 s): "Mijn hond heet Bram." zonder citaat → de bron stond toch onder het antwoord (A-42 live);
  melding bij vol geheugen ✔ en geen valse belofte; dit kleine model vroeg "Zal ik onthouden dat ik de oude offertes
  verwijdert?" → sindsdien telt een voorstel met "ik" (de bot zelf) nooit als feit van de eigenaar.
- Zoeken op betekenis: Ollama had geen embedmodel → status "no-model", woordzoeken werkte ("wagen" 0, "auto" 1). De
  echte kwaliteit van een embedmodel (drempels) is nog niet live gemeten (zie beperkingen).

**Leer-eval** (`tests/memory-eval-set.ts`, 34 Nederlandse gesprekken: feiten, voorkeuren, instructies, besluiten,
afspraken, mensen/bedrijven, 4 correcties, ruis en 6 injectiepogingen; `tests/memory-learn-eval.test.ts`; live:
`node --import tsx tests/e2e/memory-live.mjs`, `MEMORY_LIVE_ENGINE=claude|codex|opencode`):

| Herkenning | Precisie | Recall | Correcties | Injectie/ruis actief |
|---|---|---|---|---|
| Oude vaste patronen (vóór deze versie; alles als voorstel) | 1,00 | 0,33 (8/24) | 0/4 | 0 |
| Nieuwe vaste patronen (terugval zonder model) | 1,00 | 0,92 (22/24) | 2/4 | 0 |
| **Model, live: Claude Code `haiku` op abonnement** (7 nov 2026) | 0,96 (1 extra, wel juist feit) | **1,00 (24/24)** | **4/4** | 0 |
| Model, nep: ideaal / misdragend (hallucinaties, valse citaten, injectietekst, verkeerde `replaces`) | 1,00 / 1,00 | 1,00 / 1,00 | 4/4 / 4/4 | 0 / 0 |

Live (Claude Code, `haiku`): leerbatch gemiddeld 4,4 s (max 7,1 s, 33 aanroepen, ±2k tokens in), onderhoud 2 aanroepen
in 9,3 s, extra kosten $0 (abonnement). Scenario: kort gesprek → 6 items met undo-regel; “ik woon niet meer in Utrecht
maar in Amersfoort” → Utrecht `superseded`, Amersfoort actief; onderhoud → 1 dubbel samengevoegd, 1 tegenspraak
opgelost, gesprek aan dossier gekoppeld, tijdlijn + besluit + acties + NU-samenvatting bijgewerkt, kernprofiel gevuld,
verslag zichtbaar in het Overzicht.

Metrics om later te volgen (data aanwezig): grounded-answer rate (citaties in antwoorden vs. `memory_usage`),
duplicate rate (dedup-uitkomsten), residu na vergeten (eval), prompt-tokens (`memory_usage.tokens`), undo- en
afwijspercentage (`memory_changes`).

## Beperkingen

- **Klantenservice op schaal is nog niet gemeten** (0.4.4): in de geheugentest wordt elk volgend klantdossier met 20
  notities trager om aan te maken (100 klanten 18 s, 300 klanten 138 s), tot een verzoek het opgeeft. De groei zit in
  het schrijven naar dossiers bij duizenden notities; de oorzaak is nog niet gevonden. De regels zelf (doelomvang per
  klant, archief, terugkomen, grenzen) zijn getest in `tests/memory-customers.test.ts`.
- **Geheugen per klant** (0.4.5): een kanaal-id is zo goed als het kanaal (een gezin kan één WhatsApp-nummer delen; een
  e-mail telt alleen met geslaagde SPF/DKIM/DMARC); er is nog geen extra controle met een code (OTP). Dezelfde klant op
  twee kanalen samenvoegen doet de eigenaar (API; nog geen knop). Klanttekst is onbetrouwbare data: feiten eruit zijn
  nooit instructies, maar een klant kan over zichzelf iets onjuists zeggen (dat is dan zijn eigen dossier; tegen wat de
  eigenaar vastlegde wordt het *te controleren*). Zonder gratis model leren alleen de vaste patronen (Nederlands).
  Noem klantgeheugen in je privacyverklaring; een klant vergeten = zijn dossier vergeten, exporteren = de JSON-export van
  het dossier. Nieuwe teksten moeten nog vertaald worden (`npm run i18n:translate`).

- Zonder gratis model gebruikt automatisch herkennen vaste NL/EN-patronen (hoge precisie, kleinere dekking:
  correcties zonder sleutel, zoals “geen melk meer in mijn koffie”, ziet alleen het model). Uit het werk van de bot
  leert alleen het model (geen patronen voor tool-uitvoer).
- Leren uit het hele gesprek (0.4.5): van een CLI-bot (Claude Code, Codex …) ziet de leerder het antwoord en dat er een
  toolstap was, niet de volledige tool-uitvoer (die bewaart TeamBot niet); wat de bot vond moet dus in zijn antwoord
  staan. Een vergiftigde pagina wordt herkend aan tekst die een AI aanspreekt of op een opdracht lijkt; een slimmere
  aanval zonder zulke woorden kan een onschuldig ogend feit planten — dat blijft een notitie van de bot (nooit "Over
  jou", nooit een instructie, nooit boven wat de eigenaar zei) met de bron erbij en undo. Een tijdelijke stand ("er
  staan nu 3 reparaties open") laten liggen is aan het model (de prompt zegt het); de code herkent dat niet.
  Gemeten met een ideale leerder (a, b) en drie keer met het lokale model (c): dat leerde 2–5 van de 5 tool-feiten en
  liet de tegenspraak met de eigenaar liggen (zijn woorden bleven staan, maar zonder kaart). Een feit van een bot of
  tool in de ik-vorm ("Ik host mijn site bij …") wordt niet opgeslagen: het zou als de woorden van de eigenaar lezen.
- "Ja, doe maar" werkt alleen op een voorstel dat het feit noemt, in het Nederlands of Engels, in een privégesprek. De
  omzetting naar de ik-vorm is een heuristiek (zelfde woordvolgorde-regels als "onthoud dat"): scheidbare werkwoorden
  ("thuiswerkt") en zinnen met "jullie" lukken niet of niet mooi; bij twijfel wordt niets opgeslagen en hoort de bot dat.
- Zoeken op betekenis: met het ingebouwde model of Ollama op deze pc (geen LM Studio of llama.cpp als embedder). Het
  ingebouwde model (granite, 97M) vindt in de geheugentest ruim 85 % van de vragen in de top 5 en ±60 % op 1; vragen in
  heel andere woorden ("Wie doet mijn administratie?" → boekhouder) missen nog, en daarom ook een deel van de correcties
  (het nieuwe feit komt niet bovenaan als de vraag het oude feit ook al niet bovenaan vond). De drempels van Ollama-modellen (bge-m3 e.d.) zijn gekozen, niet gemeten. Alleen items en
  documentdelen; dossiers, besluiten/acties en eerdere gesprekken alleen op woorden; gevoelige, gearchiveerde en
  vervangen versies alleen op woorden. De synoniemenlijst is klein en Nederlands/Engels.
- Zelf bijwerken: een feit van een webpagina wordt alleen vernieuwd als een specialist die pagina opnieuw leest (het
  geheugen haalt zelf niets van internet); een feit uit een gesprek wacht op de eigenaar en wordt na twee weken *te
  controleren*. Het opnieuw lezen van een dossierdocument vraagt een gratis model.
- Bijwerken bij schrijven (0.4.4): de vaste patronen zijn voorzichtig en vinden zonder model maar een deel van de
  anders verwoorde gevallen (in de geheugentest 1 van de 4 achtergehouden gevallen); het model doet de rest. De ketting
  van beëindigingen werkt met vaste patronen alleen als iemand vertrekt. Gevoelige notities worden niet vergeleken (ze zijn versleuteld en hebben geen vector). Een lange keten van
  afhankelijkheden wordt per leerbatch één stap diep bekeken.
- Nieuwe teksten in Opslag (doelomvang per klantdossier) moeten nog vertaald worden (`npm run i18n:extract` en
  `i18n:translate`).
- Dossiers: vanzelf koppelen gaat op naam en tag (niet op betekenis); "één zin → soort" is een regelset in het
  Nederlands en Engels (bij twijfel een notitie).
- Teams: een verwijderd team neemt zijn geheugen niet mee; het blijft voor de eigenaar zichtbaar ("Team verwijderd") en
  is op te nemen in een ander team, maar geen bot leest het. Markdown-import van dossiers gaat naar het standaardteam
  (verplaatsen kan per dossier). Groepen horen nog niet bij een team: in een groep met bots van twee teams leest elke
  bot alleen zijn eigen muren, en de samenvatting hoort bij het team van de bot van het gesprek. Exporteren als
  sjabloon met vakkennis is nog niet gebouwd (alleen kopiëren binnen deze installatie).
- Vaste regels: max. 100; instructies die in een dossier staan zijn gewone profielregels (budget en cap gelden).
  Een regel is een instructie aan het model; wat echt niet mag (verwijderen, verzenden, betalen zonder akkoord)
  houdt de Broker in de code tegen.
- OpenCode-gratis modellen hebben een gebruikslimiet per dag (gezien: “Free usage limit reached”, ±22 uur wachten);
  TeamBot valt dan terug op een andere gratis engine of de patronen.
- Parafrases van vergeten inhoud in *andere* antwoorden van bots buiten bron-/gebruiksgesprekken, en ondertekende
  “thinking”-blokken van providers, worden niet herschreven (ondertekening). Je eigen berichten blijven staan tenzij je
  “ook bronbericht” kiest.
- Links worden niet opgehaald bij het toevoegen als bron (geen netwerk vanuit deze module); plak de tekst of laat een
  bot `web_fetch` gebruiken. Pdf's zonder tekstlaag (scans) worden niet gelezen (geen OCR); max. 60 MB per document.
- Een oudere back-up van vóór een vergeten bevat de inhoud nog; bij terugzetten wordt die opnieuw vergeten (de
  blokkades van nu gaan mee), maar wie het back-upbestand zelf opent, ziet hem.
- Een gebruiker verwijderen bestaat nog niet in de kern; `ctx.services.memory.deleteUser` staat klaar.
- `className="w-auto"` op `Select`/`Input` uit `ui.tsx` wint niet van hun ingebouwde `w-full` (CSS-volgorde); deze
  module gebruikt daarom inline `style` voor breedtes. (Geldt ook voor andere modules — melding voor de hoofdsessie.)

## Handmatige voorwaarden

Het ingebouwde zoekmodel (granite-embedding-97m-multilingual-r2, ±125 MB) wordt na het ja van de eigenaar van Hugging
Face gehaald; wie al ja zei tegen het oude model krijgt het bij de eerste start van 0.4.4 vanzelf (één download op de
achtergrond, daarna worden de vectoren opnieuw gemaakt). Voor het ingebouwde zoekmodel moeten twee npm-pakketten in de build zitten: `onnxruntime-node` (MIT) en
`@huggingface/tokenizers` (Apache-2.0); zonder werkt alles behalve dat model (status "kan in deze versie niet draaien").
In het Electron-pakket moet `node_modules/onnxruntime-node/**` uitgepakt blijven (asarUnpack, zoals sherpa-onnx). Verder
geen. Slim leren werkt zodra er een gratis engine gekoppeld is (Claude Code of Codex ingelogd met een abonnement,
OpenCode, of een lokaal model). Zoeken op betekenis werkt zodra Ollama op deze pc gekoppeld is en een embedmodel heeft
(knop in Opslag of `ollama pull bge-m3`). Optioneel: in Opslag een vaste engine of “Model van de bot, ook als dat geld
kost” kiezen, en serverlimieten instellen via `PUT /api/memory/admin/limits` (admin).
