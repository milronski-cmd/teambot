# Service Level Agreement — TeamBot Cloud

> **CONCEPT — NIET BINDEND.** Dit is een voorstel om juridisch te laten toetsen door de eigenaar vóór gebruik in
> contracten of op de website. Bedragen, percentages, termijnen en alles tussen `[vierkante haken]` zijn
> bedrijfsbeslissingen die nog genomen moeten worden. Tot die toets geldt deze tekst nergens als toezegging.

Versie: concept 0.2 · 2026-11-06 · hoort bij [CLOUD.md](CLOUD.md) (techniek), [Dreigingsmodel](THREAT_MODEL.md) en de
[deployment-kit voor Dedicated](../deploy/dedicated/README.md).

## 1. Toepassing en begrippen

- **Dienst**: TeamBot Cloud: de beheerde hosting van TeamBot (abonnementen *Starter* en *Team*, "gedeeld") en de
  bewaking, support en updates van TeamBot op de eigen server van de klant (*Dedicated*).
- **Workspace**: één TeamBot-installatie van een klant.
- **Beschikbaar**: de gezondheidscontrole van de workspace slaagt (zie §3).
- **Maand**: kalendermaand, tijdzone Europe/Amsterdam.
- **Gepland onderhoud**: onderhoud dat minstens 48 uur van tevoren is aangekondigd op de statuspagina (of, voor één
  workspace, in het dashboard van die klant).
- De proefperiode valt **niet** onder deze SLA.

## 2. Beschikbaarheidsdoelen

| Abonnement | Wie draait de server | Doel per maand | Toelichting |
|---|---|---|---|
| Proef | TeamBot Cloud | geen | Zonder garantie |
| Starter | TeamBot Cloud (gedeelde host, eigen container) | **[99,5]%** | ≈ 3 u 39 min uitval per maand toegestaan |
| Team | TeamBot Cloud (gedeelde host, eigen container) | **[99,9]%** | ≈ 44 min per maand |
| Dedicated | De klant (eigen server/VPC) | **geen beschikbaarheidsgarantie op de server**; wél responstijden (§5) en updates (§6) | Wij meten en rapporteren de beschikbaarheid ter informatie en om storingen snel te zien. Uitval door de infrastructuur van de klant valt buiten deze SLA. |

[Optie voor later: "Dedicated beheerd", waarbij wij beheerrechten op de omgeving van de klant krijgen en een
beschikbaarheidsdoel van [99,9]% geldt. Niet gebouwd en niet aangeboden.]

## 3. Zo meten we

- TeamBot Cloud vraagt elke **[30] seconden** het adres `/healthz` van elke actieve workspace op: bij gedeelde hosting
  via het interne netwerk, bij Dedicated van buitenaf via `https://<adres-van-de-klant>/healthz`.
- Een controle **mislukt** bij: geen antwoord binnen **5 seconden** (gedeelde hosting: 2 seconden), een andere status dan 200, een antwoord dat geen
  TeamBot-gezondheidscontrole is, een doorverwijzing naar een ander adres, of een adres dat naar een privé-netwerk wijst.
- **Beschikbaarheid** = geslaagde controles ÷ getelde controles in de maand × 100%. Controles tellen per kalenderdag
  in Europe/Amsterdam; een maand loopt van 1 00:00 tot de 1e van de volgende maand 00:00 lokale tijd (ook rond de
  overgang naar zomer- en wintertijd exact). Controles terwijl een workspace gepauzeerd is, worden niet gedaan en dus
  niet geteld.
- **Niet geteld** worden controles tijdens **gepland onderhoud** (minstens 48 uur van tevoren aangekondigd). Onderhoud
  dat korter van tevoren is aangekondigd, wordt wel getoond maar **telt mee** als uitval.
- Na **3** mislukte controles op rij opent het systeem automatisch een storing voor die workspace (zichtbaar voor de
  klant en ons); die sluit vanzelf zodra de workspace weer antwoordt.
- De klant ziet de beschikbaarheid van de laatste 30 en 90 dagen in het dashboard; de openbare statuspagina toont alleen
  aantallen en platformstoringen, nooit namen van klanten.
- **Maandrapport**: na afloop van elke maand maakt het systeem automatisch per workspace een rapport: getelde,
  geslaagde en mislukte controles, de beschikbaarheid, het aantal niet-getelde controles tijdens gepland onderhoud, alle
  onderhoudsvensters (met "telt wel/niet mee"), alle storingen met begin, einde en duur binnen de maand, het doel van
  het abonnement, "gehaald / niet gehaald" en een eventuele servicecredit. De klant ziet het in het dashboard
  (afdrukbaar, en als CSV en JSON te downloaden).
- Een rapport is **onveranderlijk**. Alleen beheer kan bij een aantoonbare meetfout een nieuwe versie maken, met een
  reden; de oude versie blijft bewaard en beide staan in de audit. Is voor die maand al een credit goedgekeurd, dan
  kan dat niet meer.
- Onze meting is leidend. Denkt de klant dat die niet klopt, dan meldt de klant dat binnen 30 dagen na het einde van
  de maand; we leggen dan de onderliggende controles naast de gegevens van de klant.
- **Meldingen**: de klant kan zich laten waarschuwen bij een storing, bij herstel en wanneer een maandrapport klaar is,
  per e-mail en/of met een ondertekende webhook (HMAC-SHA256), met een maximum aantal meldingen per uur.

## 4. Onderhoud

- Gepland onderhoud kondigen we minstens **48 uur** van tevoren aan, bij voorkeur tussen **[22:00 en 06:00]**.
- Per maand tellen we hooguit **[8] uur** gepland onderhoud niet mee; daarboven telt het als uitval. [Dit maximum wordt
  nog niet automatisch afgedwongen: de duur van elk venster staat in het maandrapport en beheer controleert het.]
- Een onderhoudsvenster duurt hoogstens 24 uur en kan nooit achteraf worden ingevoerd (het systeem weigert dat).
- **Spoedonderhoud** (bijvoorbeeld een kritiek beveiligingslek) kan zonder 48 uur aankondiging; dat telt als uitval,
  tenzij het lek wordt veroorzaakt door de klant.

## 5. Support en responstijden

Kanaal: [support@…] en het dashboard. Werkdagen: maandag t/m vrijdag 09:00–17:00 (Nederlandse feestdagen uitgezonderd).

| Ernst | Voorbeeld | Starter | Team | Dedicated |
|---|---|---|---|---|
| P1 Kritiek | TeamBot onbereikbaar of datalek vermoed | [8] werkuren | [4] uur, ook buiten werkdagen | [1] uur, 24/7 |
| P2 Hoog | Belangrijke functie werkt niet, geen omweg | [2] werkdagen | [1] werkdag | [4] uur |
| P3 Normaal | Fout met omweg | [5] werkdagen | [3] werkdagen | [1] werkdag |
| P4 Vraag | Hoe werkt…? | Beste inspanning | [5] werkdagen | [2] werkdagen |

"Responstijd" is de tijd tot een eerste inhoudelijke reactie van een mens, niet tot de oplossing.

## 6. Updates

- Gedeelde hosting: wij werken TeamBot bij. Beveiligingsupdates voor kritieke lekken binnen **[72 uur]** na
  beschikbaarheid, andere updates in gepland onderhoud.
- Dedicated: wij leveren nieuwe versies en releasenotes; de klant installeert ze (zie de deployment-kit). Een kritieke
  beveiligingsupdate melden we binnen **[24 uur]** na beschikbaarheid. Support geldt voor de laatste **[twee]**
  versies.

## 7. Servicecredits

Haalt een gedeeld abonnement het beschikbaarheidsdoel in een maand niet, dan krijgt de klant een credit op de
**hostingprijs** van die maand voor die workspace. Voorbeeldtabel (de percentages en grenzen zijn een beslissing van de
eigenaar; ze staan per abonnement in de configuratie):

| Beschikbaarheid in de maand | Starter (doel [99,5]%) | Team (doel [99,9]%) |
|---|---|---|
| Onder het doel, maar ≥ 99,0% | [10]% | [10]% |
| < 99,0% en ≥ 95,0% | [25]% | [25]% |
| < 95,0% | [50]% | [50]% |

Zo werkt het:

- Het maandrapport berekent de credit automatisch: een regel geldt als de beschikbaarheid **strikt onder** de grens
  ligt (precies 99,0% is dus niet "onder 99,0%"); de zwaarste regel die geldt, telt. Er is alleen een credit als het
  doel niet is gehaald. Bedrag = maandprijs van het abonnement × percentage, afgerond op hele centen.
- Een berekende credit **wacht op beoordeling** door ons; er wordt nooit automatisch iets verrekend. Wij keuren goed of
  wijzen af (met reden; bijvoorbeeld een uitsluiting uit §8). Alles staat in de audit.
- Na goedkeuring: betaalt de klant via Stripe, dan zetten we de credit als tegoed op het Stripe-klantsaldo; Stripe trekt
  het af van de volgende factuur(en). Betaalt de klant op factuur, dan staat de credit op "te verrekenen" en verrekenen
  we hem op de volgende factuur (daarna "verrekend").
- [Bedrijfsbeslissing: moet de klant een credit eerst aanvragen, of is het rapport genoeg? Het systeem berekent hem nu
  altijd en laat beheer beslissen.]
- Credits worden verrekend met een volgende factuur; geen uitbetaling. Maximaal [50]% van de maandprijs.
- Modelkosten (AI-providers) vallen er nooit onder: die betaalt de klant rechtstreeks aan de provider (BYOK).
- [Juridisch te toetsen: of credits de enige vergoeding zijn bij het niet halen van het doel, en de verhouding tot
  aansprakelijkheid in de algemene voorwaarden.]
- Dedicated: geen credits op beschikbaarheid; bij het herhaald niet halen van de responstijden P1/P2
  [regeling invullen].

## 8. Uitsluitingen

Niet als uitval geteld en niet onder deze SLA:

- gepland onderhoud (§4) en storingen tijdens de proefperiode;
- oorzaken bij de klant: configuratie, eigen code/skills/MCP-servers, overschreden limieten, misbruik, of een
  workspace die gepauzeerd is wegens betaling of op verzoek;
- storingen bij **AI-providers** of andere externe diensten die de klant koppelt (OpenAI, Anthropic, Google, kanalen,
  …), ook als bots daardoor niet antwoorden terwijl TeamBot zelf bereikbaar is;
- internet- of DNS-storingen buiten ons netwerk, en overmacht;
- bij **Dedicated**: alles aan de kant van de klant: server, VPC, netwerk, firewall, DNS, TLS-certificaat, opslag,
  back-ups, besturingssysteem, en het niet (tijdig) installeren van updates;
- functies die als "beta" of "experimenteel" zijn gemarkeerd.

## 9. Gegevens

- **Locatie**: gedeelde hosting draait in [datacenter en land invullen, bij voorkeur binnen de EU/EER]. Dedicated:
  waar de klant zijn server plaatst; wij bewaren dan geen inhoud van de workspace, alleen gegevens van de control plane
  (account, abonnement, adres, metingen, storingen).
- **Back-ups (gedeeld)**: TeamBot maakt dagelijks een databaseback-up in de workspace (laatste 7 bewaard);
  daarnaast [volumeback-ups invullen: frequentie, bewaartermijn, locatie].
- **Export**: de klant kan op elk moment een volledige export maken vanuit het dashboard (database, bestanden en de
  hoofdsleutel van opgeslagen API-sleutels), ook na opzegging tot de verwijderdatum.
- **Verwijderen**: na opzegging bewaren we de workspace **30 dagen** (gepauzeerd, exporteerbaar), daarna verwijderen we
  instantie, opslag, exports en sleutel; back-ups verlopen binnen [termijn invullen]. Een klant kan ook direct
  verwijderen in het dashboard. Van een verwijderde workspace houden we alleen een minimale registratie bij (naam,
  data, status) en de audit.
- Beheer (wij) kan de inhoud van workspaces niet inzien via de beheeromgeving; technische toegang tot de host is
  beperkt tot [rollen invullen] en wordt gelogd.
- Een **verwerkersovereenkomst** (AVG) maakt deel uit van het contract [document invullen].

## 10. Beveiligingsincidenten

- Bij een (vermoed) beveiligingsincident dat gegevens van de klant raakt, informeren we de klant **zonder onredelijke
  vertraging en uiterlijk binnen [24] uur** na ontdekking, zodat de klant zelf binnen 72 uur kan melden bij de
  Autoriteit Persoonsgegevens als dat nodig is.
- De melding bevat: wat er gebeurde, welke gegevens en workspaces geraakt zijn (voor zover bekend), wat we hebben
  gedaan, wat de klant moet doen (bijv. API-sleutels vervangen) en een contactpersoon. Updates volgen tot het incident
  gesloten is, met een kort verslag achteraf.
- Platformbrede storingen en incidenten staan ook op de statuspagina (zonder namen van klanten).
- Dedicated: incidenten in de omgeving van de klant meldt de klant aan ons als support nodig is; wij melden lekken in
  TeamBot zelf en leveren een update (§6).

## 11. Overig

- Deze SLA geldt zolang het abonnement loopt en betaald is. Bij pauze wegens betaling of opzegging vervalt de SLA voor
  die workspace.
- Wijzigingen kondigen we minstens [30] dagen van tevoren aan; ze gelden niet met terugwerkende kracht.
- Bij strijd tussen deze SLA en het contract of de algemene voorwaarden gaat [volgorde invullen] voor.
