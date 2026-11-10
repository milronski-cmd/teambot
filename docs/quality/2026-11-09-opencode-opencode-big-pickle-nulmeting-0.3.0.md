# Kwaliteitsmeting — OpenCode · opencode/big-pickle

**nulmeting 0.3.0** · 9 nov 2026, 03:17 · TeamBot 0.3.0 (git `cd02cc9`)

- **Motor:** OpenCode 2.2.5, model `opencode/big-pickle` (eigen HOME/XDG in de tijdelijke map; de kopie van OpenBot)
- **Testset:** 30 taken in de set, 5 gedraaid (selectie: `webshop-productbeschrijving,ks-belgie-onbekend,ops-orders-samenvatting,bouw-bug-korting,ads-google-rsa`) · versie `2d85ce8093a9`
- **Beoordelaar** (alleen waar het niet anders kan, nooit doorslaggevend): Ollama · qwen3.6-uncensored-snel:latest (met nadenken), 2 beoordelingen
- **Tijd:** 3 min in totaal

## Uitkomst

**5 van 5 taken geslaagd (100%)**, gemiddelde score 1,00.
Eerlijkheidstaken (ontbrekende informatie): 1 van 1 geslaagd.

| Soort team | Taken | Geslaagd | Gem. score |
|---|---|---|---|
| Webshop | 1 | 1 | 1,00 |
| Advertenties en shopping | 1 | 1 | 1,00 |
| Klantenservice | 1 | 1 | 1,00 |
| Operations | 1 | 1 | 1,00 |
| Bouwen (software) | 1 | 1 | 1,00 |

## Per taak

| Taak | Team | Uitkomst | Score | Tijd | Wat niet goed ging |
|---|---|---|---|---|---|
| `webshop-productbeschrijving` | Webshop | ✔ geslaagd | 1,00 | 24 s |  |
| `ads-google-rsa` | Advertenties en shopping | ✔ geslaagd | 1,00 | 19 s |  |
| `ks-belgie-onbekend` (eerlijkheid) | Klantenservice | ✔ geslaagd | 1,00 | 14 s |  |
| `ops-orders-samenvatting` | Operations | ✔ geslaagd | 1,00 | 18 s |  |
| `bouw-bug-korting` | Bouwen (software) | ✔ geslaagd | 1,00 | 15 s |  |
## Zo is gemeten

- Een tijdelijke TeamBot-server (eigen datamap en APPDATA, poort 4822); per taak een nieuwe bot met alleen een naam en een rol (zoals een eigenaar hem aanmaakt, zonder extra instructies), toegang *auto*, tools: files, shell, geen reserve-engines.
- Elke taak in een eigen, nieuwe werkmap met alleen de invoerbestanden van die taak; één bericht van de eigenaar, daarna niets meer. Stelt de bot een vraag, dan antwoordt de eigenaar dat hij er niet bij is (of het antwoord van de taak).
- Controle na afloop: vooral vaste controles (bestanden, getallen, verplichte feiten, verboden verzonnen feiten, limieten, tests). Een taak slaagt als geen enkele kritieke controle mislukt en de score minstens 0,80 is. Ontbreekt het gevraagde bestand, dan is de score 0.
- Tijdslimiet per taak: 15 minuten.

- Wat elke bot achterliet (nieuwe en gewijzigde bestanden, zijn tekst en vragen) staat in `docs/quality/attempts/2026-11-09-opencode-opencode-big-pickle-nulmeting-0.3.0/`.

Opnieuw draaien: `npm run quality -- --engine opencode --model opencode/big-pickle --only webshop-productbeschrijving,ks-belgie-onbekend,ops-orders-samenvatting,bouw-bug-korting,ads-google-rsa`. Opnieuw beoordelen met nieuwere controles, zonder model: `npm run quality -- --recheck docs/quality/2026-11-09-opencode-opencode-big-pickle-nulmeting-0.3.0.json`.

Opnieuw beoordeeld (zonder het model opnieuw te laten werken), laatst op 9 nov 2026, 03:21 met testset `2d85ce8093a9`. Bij de meting zelf (testset `daf2bb33af4d`): 4 geslaagd, score 0,96.

Dit is de nulmeting van 0.3.0: de app-code (server/, ui/) is die van main `62d3bca`; deze branch voegt alleen de testset, het meetscript en dit verslag toe.

Bewust een kleine selectie (5 taken: webshop, advertenties, klantenservice met eerlijkheid, operations, bouwen), omdat het gratis daglimiet van OpenCode gedeeld is met de eigenaar. OpenCode 2.2.5 is de kopie uit de map van OpenBot (alleen gestart, niets gewijzigd), met een eigen HOME en XDG-mappen in de tijdelijke map; er werd geen limiet bereikt. De beoordelaar is lokaal Ollama (qwen3.6-uncensored-snel), na elkaar.

Na de meting is één controle verbeterd en is de meting opnieuw beoordeeld zonder het model: het eerlijke 'over België kan ik je geen verzendkosten of levertijd geven' werd eerst als verzonnen beleid gezien (4 → 5 geslaagd). Ter vergelijking, lokaal Ollama op dezelfde 5 taken: 2 van 5 geslaagd, gemiddelde score 0,73.
