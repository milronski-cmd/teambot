# Workflows

Een workflow is een vaste reeks stappen die je bots na elkaar doen, met een controle die het werk kan terugsturen en
jouw akkoord vóór er iets naar buiten gaat (PARITEIT 9.8). Server: `server/modules/workflows/`, pagina's:
`ui/src/modules/workflows/` (`#/m/workflows`, `#/m/workflows/w/<id>`, `#/m/workflows/run/<id>`).

## Stappen

| Soort | Wat het doet |
|---|---|
| **Bot** | Een bot doet een opdracht. `{{invoer}}`, `{{vorige}}` en `{{stap N}}` in de opdracht worden ingevuld; wat de opdracht niet zelf noemt, komt eronder. Elke stap begint met een schone context in een eigen gesprek ("Workflow · naam", onder *Automatische runs*). |
| **Controle** | Kijkt of het vorige resultaat met een tekst begint, die bevat of juist niet bevat. Zo niet: stoppen, of terug naar een eerdere stap (hoogstens 4 keer per stap, daarna stopt de run met een melding). |
| **Jouw akkoord** | De run wacht op de eigenaar: een kaart in *Wacht op jou*, op de runpagina en op de telefoon, met het resultaat tot dan toe. Nooit "altijd toestaan". Nee = de run stopt. |
| **Melding** | Stuurt het resultaat tot hier als melding. |

## Starten

- zelf (knop *Starten*, met een invoer);
- een bot met de tool `workflow_run` (elke bot met de toolgroep *Routines* heeft hem; niet vanuit een stap van een workflow);
- volgens een schema: elke dag of op vaste dagen, alleen als TeamBot dan aanstaat (een gemiste run wordt niet ingehaald);
- een andere dienst via `POST /api/public/hooks/<workflow-id>` met `Authorization: Bearer <sleutel>`. De sleutel wordt
  één keer getoond en alleen als hash bewaard, en is alleen op de computer aan te maken. Wat de dienst meestuurt
  (hoogstens 64 kB) krijgen de bots als afgeschermde gegevens, nooit als opdracht.

Er loopt één run per workflow tegelijk. Bots kunnen met `workflow_save` zelf een workflow maken of de stappen van een
bestaande vervangen; die start nooit vanzelf.

## Bewaren en herstellen

- Elke wijziging van de stappen is een nieuwe versie; de laatste 30 blijven staan en zijn terug te zetten.
- Een run bewaart de stappen zoals ze bij de start waren en wat elke stap opleverde (de laatste 200 runs per workflow).
- Na een herstart wordt een open akkoord opnieuw gevraagd. Een bot-stap die halverwege was, wordt nooit stil herhaald:
  de run staat op *Onderbroken* met de knop *Hervatten*.
- Vier voorbeelden staan klaar (productpagina, blogartikel, wekelijkse controle Ads en Shopping, klantvraag); *Gebruiken*
  vult per stap je eigen bot in op naam en rol.

## Nog niet

Een tekenvel met lijnen (de stappen staan onder elkaar), parallelle takken die weer samenkomen, en het resultaat
rechtstreeks naar een chat-app sturen (dat kan nu via een bot-stap met `channel_send`).

Tests: `tests/workflows.test.ts`, `tests/e2e/workflows.mjs`.
