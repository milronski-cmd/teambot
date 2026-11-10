# Controles TeamBot 0.4.3 (9 november 2026)

Gedraaid op de samengevoegde code van `main`, elk met een eigen tijdelijke `TEAMBOT_DATA` en `APPDATA`. Er liepen
twee rijen naast elkaar. Daarom staat bij een fout eerst of hij ook los, op een rustige pc, terugkwam.

| Controle | Uitslag |
|---|---|
| `npm run typecheck` | schoon |
| `npm test` | groen (93 s), na de laatste reparaties opnieuw gedraaid |
| `npm run e2e` | alle 16 suites groen. `extensions-ui` en `language-switch` faalden één keer onder belasting en waren los groen (18/18). `newcomer` vond een echte fout: Instellingen had 27 regels. Gerepareerd, zie hieronder, daarna groen |
| `npm run accept:04` | 73/73 + 49/49 |
| `npm run parity:04` | 182/182 |
| nieuwe suites | `accent:check` 16/16, `health-ui`, `script-keys`, `parity-small` groen |
| `npm run mobile:check` | groen |
| `npm run a11y` | 0 bevindingen |
| `npm run i18n:check` | 10 talen × 15.850 teksten, 0 fouten. Pagina's: na de reparaties hieronder 0 zichtbaar onvertaald (Engels opnieuw gedraaid op alle 98 pagina's; de andere talen waren al schoon) |
| `npm run perf` | groen |
| `npm run licenses:check` | 395 productie-dependencies, permissief |
| `npm run secrets:check` | 0 |
| `npm run website:check` | 0 |
| `npm run status:check` | groen |

## Gevonden en gerepareerd

- **Instellingen had 27 regels** (doel: hoogstens 25). *Uiterlijk* en *Hoe gaat het met TeamBot?* zijn nu bereikbaar
  via een link in Algemeen, en tonen zich bij *Geavanceerd tonen*.
- **`{1}` zichtbaar** in de stilstandtekst in andere talen: een invulveld binnen een meervoudsvorm werd niet gevuld.
  Opgelost in `ui/src/lib/i18n-core.ts`, dus voor alle teksten.
- **Lokaal model op het welkomstscherm**: vier teksten bleven Nederlands in het Engels; ze gaan nu door `t()`.
- **De extractor** pikte een stuk programmacode op als tekst (velden van een klasse); dat slaat hij nu over.
- **Taalcontrole**: een vaste uitvoermarkering (`[verborgen: $NAAM]`) en woorden binnen meervoudsvormen ("Ding")
  tellen niet meer als Nederlands.
