# Module: Geschiedenis wissen (`history`)

De gesprekken van één bot of één groep in één keer wissen (gelijk aan OpenBot 0.64), terwijl de opzet blijft: de bot
of groep zelf, herinneringen, routines en taken. Vooraf toont TeamBot precies wat weggaat en wat blijft, met aantallen,
zoals bij het verwijderen van een bot.

## Waar

- **Chatmenu ⋮ van een bot**: **Geschiedenis wissen…** (niet bij een gedeelde bot van iemand anders).
- **Chatmenu ⋮ van een groep**: **Geschiedenis van de groep wissen…** (alleen voor de eigenaar van de groep).
- Op een server alleen voor de eigenaar van de installatie (zij beheert ook de back-ups); anderen zien het niet en de
  server weigert het (403). Op de desktop is de gebruiker die eigenaar.
- De dialoog (`ui/src/shell/HistoryDeleteDialog.tsx`) noemt onder **Dit gaat weg** de gesprekken met hun berichten,
  de bestanden (aantal en grootte), de samenvattingen in Geheugen en lopende taken die stoppen; onder **Dit blijft**
  de bot of groep zelf, herinneringen, gedeeld geheugen en dossiers, routines, taken op het takenbord, groepen,
  kanaalkoppelingen, gesprekken van teamleden met een gedeelde bot en de werkmap (bij een groep: bots, taken, de
  gedeelde groepsbestanden, kosten en activiteitenlog). Bestaan er al back-ups, dan zegt een regel dat die blijven
  zoals ze zijn en dat TeamBot de gesprekken na terugzetten meteen opnieuw wist. In een groep met andere mensen staat
  erbij dat ook zij het groepsgesprek daarna leeg zien. Werkt op 390 px breed (telefoon).
- Daarna opent de bot in een nieuw, leeg gesprek; een groep houdt haar gesprek, nu leeg.

## Wat weggaat en wat blijft

Wat weggaat, per gesprek (`server/modules/history/purge.ts`):

- berichten (met de zoekindex), runs, berichten in de wachtrij, goedkeurings- en vraagkaarten;
- bijlagen: bestanden die je stuurde en bestanden en pagina's die de bot liet zien, op schijf en in de database, ook
  hun kopie in de map `uploads` van de werkmappen; spraakmemo-transcripties, voorgelezen versies van berichten en
  transcripties van live gesprekken;
- sessies van CLI-engines (Claude Code, Codex, ACP), zodat een bot nooit verdergaat in een sessie die het oude gesprek
  nog kent; de contextcijfers van het gesprek;
- afgeronde subtaken en vragen tussen bots (hun opdracht en antwoord horen bij het gesprek);
- de samenvatting van het gesprek in Geheugen (episode), de leerwachtrij en het gebruik: de geheugenmodule ruimt die op
  bij `thread.deleted` en `thread.cleared`.

Wat blijft: de bot of groep, herinneringen (ook als hun bron een van deze berichten was), dossiers en hun bronnen,
routines en hun uitvoerlog, taken, de gedeelde groepsbestanden, de werkmappen, het beveiligingslog, stappenlogs van
computer en apps, en de kosten. Een bijlage die nog elders gebruikt wordt (doorgestuurd naar een gesprek dat blijft, of
een bron van een dossier) blijft ook.

Welke gesprekken:

- **Bot**: zijn eigen gesprekken van de eigenaar (`agent_id` = bot, `room_id` leeg): chats, routine-, kanaal- en
  subtaakgesprekken. Gesprekken in groepen blijven; gesprekken van teamleden met een gedeelde bot ook (die zijn van
  hen). Routines en kanalen maken bij het volgende bericht vanzelf een nieuw gesprek.
- **Groep**: het eigen gesprek van de groep wordt geleegd (de groep heeft het nodig; samenvatting en engine-staat gaan
  ook) en de gesprekken tussen haar bots (`room_id` = groep) gaan weg.

Eerst gaan berichten in de wachtrij weg en stopt lopend werk (maximaal 5 seconden wachten), zodat er geen antwoord meer
in een gewist gesprek terechtkomt. Daarna is de tekst ook fysiek weg, zoals bij vergeten in Geheugen: `secure_delete`,
`optimize` van de zoekindex en een WAL-checkpoint (`purgeDeleted`).

## Back-ups

Bestaande back-ups veranderen niet. Elke wissing staat in `history_purges` (bot of groep, tijdstip). Bij het
terugzetten van een back-up neemt `applyPendingRestore` (`server/api/backups.ts`) die regels mee naar
`restore-history.json`, net als de vergeet-blokkades van Geheugen; bij de start wist de module de gesprekken van vóór dat
tijdstip opnieuw en bewaart de regels voor een volgende keer (beveiligingslog: `history.reapplied`). Een verwijderde bot
heeft geen regel meer nodig.

## API

- `GET /api/agents/:id/history` → `{ name, threads, messages, files, bytes, running, summaries, stays: { memories,
  routines, tasks, groups, channels, others, workspace }, backups }`
- `DELETE /api/agents/:id/history` → `{ ok, threads, messages, files, bytes, … }`
- `GET /api/rooms/:id/history` → dezelfde aantallen plus `stays: { bots, tasks, files, people }`
- `DELETE /api/rooms/:id/history`
- Events: `thread.deleted` per gewist gesprek, `thread.cleared` voor het geleegde groepsgesprek (naar de eigenaar en de
  leden van de groep), `rooms.changed`. Audit: `history.deleted`.

## Tests

- `tests/history-delete.test.ts`: bot (gesprekken, bestanden, sessie en zoekindex weg; bot, herinnering, routine, taak,
  groep, andere bot en een doorgestuurd bestand blijven; daarna gewoon verder), groep (geleegd, subtaakgesprek weg,
  groep, bots en taak blijven), alleen de eigenaar op een server, opnieuw gewist na terugzetten van een back-up.
- `tests/e2e/history-pages.mjs` (deel van `npm run e2e`): menu, dialoog met aantallen, wissen van bot en groep,
  telefoon 390 px, axe.
