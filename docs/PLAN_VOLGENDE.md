# Volgend plan (na 0.4.4)

Verzameld op 9 november 2026. Dit zijn de ideeën en open punten die de eigenaar bewust naar het volgende plan heeft
geschoven ("we gaan hem nu eerst afmaken en gebruiken"). Het volgende plan begint hier.

## Eenvoud
- **Design:** neem de duidelijkheid van OpenBot en Grok Bot over, maar dan iets beter, geen kopie. Gebruik per
  abonnement als ronde meters met grote logo's, ronde hoeken, grotere iconen, keuzemenu's en dropdowns in plaats van
  tekst, en de Marktplaats standaard in de zijbalk. Opzetten moet overal soepel gaan. Onderzoek:
  `Documents\TeamBot\research_notes\Design OpenBot en Grok`.
- **Fout: een wit vlak in de chatbalk** (eigenaar, 0.4.4).
- **Eigen computer per bot**, naast het besturen van de muis van de eigenaar. Onderzoek:
  `research_notes\Eigen computer per bot`.
- **Beter en gratis zoeken** in plaats van alleen DuckDuckGo, en gratis plugins in de Marktplaats. Onderzoek:
  `research_notes\Zoeken voor bots`.
- **Eén live overzicht** van wat alle bots nu doen.
- **Privacyblok bij de bot** ("Wat gebeurt er met je gesprekken?", ui/src/modules/network/Privacy.tsx): veel te
  veel tekst (eigenaar: "waar is dit soort onzin allemaal voor nodig?"). Op de botpagina hoogstens één regel
  ("Claude Code · kan trainen · Uitzetten"); de uitleg en de voorwaarden alleen bij Gegevens en privacy › Wat verlaat je
  pc?.
- **Telefoon koppelen in één kaart.** Drie stappen: de app installeren, de QR-code scannen, klaar. Daarbij:
  - de TeamBot-verbinding wordt vanzelf gekozen;
  - Tailscale en netwerkopties staan onder *Meer opties*;
  - het eerste scherm van de iPhone-app zegt alleen "Scan de QR-code op je computer".
- **Minder tekst op de rest van de app**: Kanalen, Skills, Geheugen, Wacht op jou en het welkomstscherm. 0.4.4 deed
  de bot-editor, de teampagina, de chat en Taken.
- **Een nieuwe bot bij twee of meer teams** zegt in welk team hij komt.
- Een routinekaart toont "elke MO" als een model Engelse dagcodes gebruikt.
- *Alles exporteren* is een knop binnen een link.

## Telefoon en bereikbaarheid
- **Een eigen relay-server** (iroh-relay) op een kleine VPS van ongeveer €6,50 per maand, en een echte 4G-test. De
  publieke n0-relays zijn bedoeld om te testen.
- **Bellen met het scherm op slot** (CallKit en achtergrondaudio), en een statusregel op het vergrendelscherm.
- De Android-app en de App Store.

## Bellen en spraak
- GPT-Live met Nederlands, zodra OpenAI dat ondersteunt. Gemini opnieuw verbinden na 10–15 minuten.
- Bellen met je ChatGPT-abonnement (geen officiële route) en een natuurlijkere Nederlandse stem.
- Een echt telefoonnummer (kost geld).

## Geheugen
- Bij 500 klanten wordt het aanmaken van dossiers trager (100 klanten: 18 s, 300 klanten: 138 s). De oorzaak is
  nog niet gevonden.
- Doorwerkende beëindigingen: "Ahmed is weg" sluit nog niet vanzelf zijn taken.

## Werk en taken
- Ctrl+K vindt nog geen taken.
- De tweede controle op een gratis model bij de daglimiet van OpenCode wordt nu niet opnieuw geprobeerd.
- Een bot iets leren door het één keer voor te doen. Matrix en Microsoft Teams als kanaal.
- Gmail, Drive en Agenda met één klik (vraagt een Google-verificatie op naam van de eigenaar).

## Kwaliteit en vrijgeven
- Een duurtest van 48 uur naast OpenBot: `npm run soak -- --hours 48 --compare OpenBot`.
- De handleiding helemaal gelijktrekken met 0.4.4.
- Online zetten, met deze keuzes van de eigenaar (`docs/RELEASE_CHECKLIST.md` › *De live versie online zetten*):
  - een domein;
  - waar de website staat;
  - het updatekanaal (`build.publish`);
  - het ondertekenen (Azure of SignPath);
  - of de repository openbaar wordt.
- Live testen met de eigenaar: computer use en bureaublad op afstand met echte muis en toetsenbord, kanalen met echte
  accounts, en bellen met een echte stem.
