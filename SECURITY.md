# Beveiligingsbeleid

## Een kwetsbaarheid melden

Meld beveiligingsproblemen **niet** in een openbare issue. Gebruik GitHub "Report a vulnerability" (private security
advisory) op deze repository. Vermeld: versie, platform, stappen om te reproduceren en de impact. Een tweede
meldroute (een eigen e-mailadres) komt erbij zodra het project een eigen domein heeft.

## Termijnen

| Stap | Termijn |
|---|---|
| Ontvangst bevestigd | binnen 7 dagen |
| Eerste inschatting (ernst volgens CVSS 4.0, wel of geen kwetsbaarheid) | binnen 14 dagen |
| Oplossing in een release — kritiek (CVSS ≥ 9) | binnen 14 dagen na de inschatting |
| Oplossing in een release — hoog (7,0–8,9) | binnen 30 dagen |
| Oplossing in een release — middel (4,0–6,9) | binnen 90 dagen |
| Oplossing in een release — laag (< 4) | in de eerstvolgende gewone release |
| Openbaar maken (advisory, CVE waar van toepassing) | zodra de oplossing uit is, uiterlijk 90 dagen na de melding tenzij we samen anders afspreken |

Lukt een termijn niet, dan horen melders dat vóór het verstrijken, met de reden en een nieuwe datum. Melders worden in
de advisory genoemd als ze dat willen.

## Ondersteunde versies

Alleen de nieuwste release krijgt beveiligingsupdates. Windows 11 x64 is het primaire desktopplatform; Windows 10
alleen met geldige ESU/LTSC-ondersteuning.

## Ontwerpprincipes

- Deny-by-default voor acties met impact; verzenden, betalen, verwijderen en publiceren vragen altijd een mens.
- Een goedkeuring geldt voor één handeling, tenzij de gebruiker expliciet "altijd voor deze bot" kiest (nooit voor
  acties met impact).
- Externe inhoud (webpagina's, e-mails, webhooks, kanaalberichten, MCP-uitvoer, skills) is data, geen instructie.
- Sleutels staan versleuteld (AES-256-GCM) in de database en komen nooit in API-antwoorden, logs, foutmeldingen,
  exports of chats. Elke geheime waarde die TeamBot opslaat of leest, wordt overal gemaskeerd waar tekst naar buiten
  gaat (logboek, audit, foutmeldingen, diagnosebestand, export), ook als hij niet op een bekende sleutel lijkt.
- **Standaard dicht.** TeamBot luistert in elke modus standaard alleen op 127.0.0.1. Bereikbaar maken vanaf andere
  apparaten is een bewuste keuze van de eigenaar, met waarschuwing; Tailscale of https gaat boven gewoon wifi. Bij het
  starten weigert TeamBot de wachtwoordloze desktopmodus op een netwerkadres en waarschuwt het luid bij een server
  zonder https of met open aanmelden. Een verse server kan vanaf het netwerk alleen worden ingericht met de eenmalige
  code die TeamBot bij het starten toont. TeamBot stelt nooit Ollama of andere lokale diensten bloot.
- Wachtwoorden: minstens 12 tekens en geen voor de hand liggende; inlogpogingen worden per adres, per account en
  tegen spraying begrensd; een nieuw wachtwoord vraagt het huidige en meldt alle andere sessies af.
- Telefoons krijgen een eigen, intrekbaar apparaat-token met beperkte rechten; koppelcodes zijn eenmalig, 5 minuten
  geldig en begrensd.
- Alles wat de pc verlaat staat standaard uit of heeft een zichtbaar label: per bot een privacylabel (blijft op je pc,
  bewaart niets, traint niet, kan trainen, onbekend) en op de pagina Gegevens **Wat verlaat je pc?**. Geen telemetrie,
  geen openbare deellinks.
- Een werkmap is geen sandbox; isolatie wordt alleen geclaimd waar die echt bestaat.

Zie [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) voor het volledige dreigingsmodel.
