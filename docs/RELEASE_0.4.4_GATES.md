# Controles TeamBot 0.4.4 (9 november 2026)

Gedraaid op de samengevoegde code van `main`, elk met een eigen tijdelijke `TEAMBOT_DATA` en `APPDATA`, in drie rijen
naast elkaar. Na de laatste reparaties is een slotronde gedraaid op de definitieve code.

| Controle | Uitslag |
|---|---|
| `npm run typecheck` | schoon |
| `npm test` | **1524/1524** (slotronde). In de eerste ronde faalden 8 cloudtests: ze startten een server van de vorige build, met afhankelijkheden die er niet meer waren. Na de build waren ze groen, en los 17/17 |
| `npm run e2e` | alle 24 suites groen (561 s) |
| `npm run accept:04` | 73/73 + 49/49 |
| `npm run parity:04` | groen (183 punten) |
| `npm run a11y` | 0 bevindingen (slotronde) |
| `npm run i18n:check` | 10 talen × 17.080 teksten, 0 fouten; 103 pagina's per taal, 0 zichtbaar onvertaald (slotronde) |
| `npm run mobile:check`, `perf`, `remote:check`, `iroh:check`, `status:check` | groen |
| `npm run voice:duplex` (gratis bellen met echte modellen) | 21/21, eerste klank 0,5–1 s |
| `tests/e2e/live-call.mjs`, `phone-owner.mjs`, `newcomer.mjs`, `layout.mjs` | groen (slotronde) |
| `npm run installer:check` (echte installers op een kopie) | de nieuwe installer is groen in alle vijf de situaties: over een draaiende oude versie, over een draaiende nieuwe versie, met de app dicht, als automatische update, en bij verwijderen. De app sluit netjes en start daarna. Het nabootsen van de óude fout liep twee keer vast op een tijdslimiet bij het starten van de testapp; dat gaat niet over de nieuwe installer |
| `npm run licenses:check` | 447 productie-dependencies, permissief |
| `npm run secrets:check` | 0 |
| `npm run website:check` | 0 |
| iPhone-app (GitHub Actions) | gebouwd en getest in de simulator (ook `TeamBotLinkTests`), ondertekend en naar TestFlight gestuurd (run 42636778274) |

## Gevonden en gerepareerd in deze ronde
- **Het installatiescript** had door twee samenvoegingen twee blokken met dezelfde naam. Nu is het één blok: eerst
  de wachter, dan TeamBot starten. Het staat na het deel over een draaiende TeamBot.
- **Het beldialoog** toonde heel even "OpenAI" als keuze voordat de standaard bekend was. Nu wacht het daarop.
- **Oekraïens**: bij vier teksten ontbraken meervoudsvormen. Ze zijn opnieuw vertaald.
- **Engels**: de knoppen voor spraakmodellen hadden Nederlandse namen voor schermlezers, en één logregel had een
  Nederlands telwoord.
- **Bureaublad op afstand**: de pagina vraagt eerst of het aan staat. Dat gaf eerder een foutmelding op de telefoon.
- **Testcode**: een dubbel label (*Regels*), een paar verouderde regels in de pariteitstest, en het pad naar
  *Bureaublad op afstand* (Instellingen › Telefoon).
