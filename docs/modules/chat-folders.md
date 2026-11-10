# Module: Mappen voor chats (`chat-folders`)

De eigenaar zet de rijen van zijn chatlijst (het gesprek met een bot, of een groep) in mappen met een eigen naam, per
team (PARITEIT 4.2). Server: `server/modules/chat-folders/index.ts`; UI: `ui/src/modules/chat-folders/` (gebruikt door
`shell/ChatList.tsx` en `shell/ChatView.tsx`).

## Wat er in een map gaat

- Een rij in de lijst is één bot (zijn eigen gesprek, welk gesprek ook het laatste is) of één groep. Een map bevat dus
  bots en groepen (`kind` = `agent` | `room`), geen losse gesprekken: een nieuw gesprek met een bot blijft in de map.
- Alleen je eigen bots en groepen. Een gedeelde bot van iemand anders zet je niet in een map. Vastgezette bots en de
  hoofdbot staan als tegel boven de lijst; het chatmenu biedt voor hen geen **Verplaats naar map…**.
- Een chat staat in hoogstens één map.

## Teams

- Een map hoort bij één team (`team_id`). Een nieuwe map voor een chat krijgt het team van die chat; zonder chat het
  gekozen team, anders het standaardteam.
- Een bot past alleen in een map van zijn thuisteam; een groep in een map van zijn eigen team (`rooms.workspace_id`),
  anders van het thuisteam van een van zijn bots. Een chat zonder bekend team past overal (hij staat ook in elk team).
- Verhuist een bot naar een ander thuisteam, dan valt hij bij het ophalen stil uit de map van het oude team. Wordt een
  team verwijderd, dan verdwijnen zijn mappen; de chats blijven.
- De lijst toont bij **Alle teams** alle mappen, bij één team alleen de mappen van dat team.

## Opslag

- `chat_folders`: `id`, `user_id`, `team_id`, `name` (max. 60 tekens, uniek per team), `sort`, `collapsed`, tijden.
  `collapsed` staat op de server, dus dichtgeklapt blijft dichtgeklapt op elk apparaat en na herladen.
- `chat_folder_items`: (`user_id`, `kind`, `ref_id`) → `folder_id`. Een verwijderde bot gaat eruit (`agentDeleted`);
  een verdwenen groep valt bij het ophalen weg.
- Map verwijderen haalt alleen de map en de koppelingen weg, nooit een chat.

## API (alles van de ingelogde gebruiker)

| Route | Doet |
| --- | --- |
| `GET /api/chat-folders` | `{ folders: [{ id, teamId, name, sort, collapsed, items: [{ kind, id }] }] }` |
| `POST /api/chat-folders` | `{ name, teamId?, item? }`: nieuwe map; met `item` gaat die chat er meteen in |
| `PATCH /api/chat-folders/:id` | `{ name?, collapsed?, sort? }` |
| `DELETE /api/chat-folders/:id` | map weg, chats terug in de lijst |
| `PUT /api/chat-folders/items` | `{ kind, id, folderId }`: in een map, of eruit met `folderId: null` |

Elke wijziging stuurt `chatFolders.changed` naar alle vensters en de gekoppelde telefoon (de UI laadt dan opnieuw,
ook na `teams.changed` en een nieuwe verbinding). De telefoon mag alles (geen computer-only route). Logboek:
`chatFolder.created`, `chatFolder.deleted`. `ctx.services.chatFolders` biedt `list`, `move` en `exportUser`.

## UI

- **Lijst**: de mappen van het team in beeld bovenaan de lijst, elk met een knop om open/dicht te klappen
  (`aria-expanded`), het aantal chats en **⋯** (**Naam wijzigen…**, **Map verwijderen…**). Lege map: een korte uitleg.
  Tijdens zoeken is de lijst plat.
- **Slepen** (computer): een rij naar een map (de map licht op), of uit een map naar de lijst. Native HTML5-slepen,
  geen bibliotheek. Op een telefoon en met het toetsenbord doet het chatmenu hetzelfde.
- **Chatmenu ⋮ › Verplaats naar map…**: de mappen waar deze chat in past, **Uit map halen**, en **Nieuwe map** (naam
  typen, **Maken**). Met laad- en foutstaat.
- **Volgorde › Nieuwe map…**: een lege map in het team in beeld.

## Tests

- `tests/chat-folders.test.ts`: maken, hernoemen, verplaatsen, dichtklappen, verwijderen (chats blijven), teams (alleen
  het eigen team, verhuizen, team weg), een ander account kan niets zien of wijzigen.
- `tests/e2e/chat-folders.mjs`: als eigenaar op de computer (menu, slepen erin en eruit, dichtgeklapt na herladen,
  hernoemen, teamweergave, verwijderen, axe).
- `tests/e2e/phone-owner.mjs` stap 8b: op de gekoppelde telefoon via het menu, grote knoppen, axe in donker.
