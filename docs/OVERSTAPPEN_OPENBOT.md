# Overstappen van OpenBot naar TeamBot

Dit is het plan om je team van OpenBot naar TeamBot te verhuizen, zonder dat er een moment is waarop niets werkt en
zonder dat iets dubbel draait. Je doet het in zes stappen. In TeamBot staan dezelfde stappen, met de stand per stap:
**Instellingen › Algemeen › Overstappen**.

De hoofdregel: **eerst uit in OpenBot, dan aan in TeamBot.** Nooit allebei tegelijk aan. Een kanaal of routine die in
beide apps aanstaat, antwoordt of mailt twee keer.

TeamBot verandert OpenBot nooit. Het leest je OpenBot-gegevens alleen, via een eigen kopie, en neemt geen sleutels,
tokens of wachtwoorden over.

---

## Stap 1. Maak een back-up van beide apps

Dan kun je altijd terug naar precies hoe het was.

**TeamBot**: Instellingen › Gegevens en privacy › Back-ups › *Nu een back-up maken*. Het Overstappen-scherm ziet zelf
wanneer je laatste TeamBot-back-up was.

**OpenBot**: sluit OpenBot af (zodat de database niet halverwege een schrijfactie wordt gekopieerd) en kopieer deze
mappen naar een veilige plek, bijvoorbeeld een externe schijf:

- `%APPDATA%\OpenBot` (de database `openbot.db` met `openbot.db-wal`, de instellingen `openbot-*.json` en `local-skills`;
  de mappen met `Cache` erin hoeven niet mee);
- `%USERPROFILE%\OpenBot` (de werkmappen van je bots in `Agents` en de teammap `Shared`);
- `%USERPROFILE%\.agents\skills` (je eigen skills).

Start OpenBot daarna weer. Vink in het Overstappen-scherm *Ik heb OpenBot geback-upt* aan; dat kan TeamBot zelf niet zien.

## Stap 2. Importeer, met kanalen en routines op pauze

Overstappen › *Importeer je OpenBot-team*. Je ziet eerst precies wat er overkomt; er wordt dan nog niets geschreven.
Druk op *Importeren* als het klopt.

Wat er meekomt:

| Wat | Hoe het in TeamBot staat |
|---|---|
| Bots | Alle bots, in één team, met naam, beschrijving, kleur en gezicht. De Baas wordt je hoofdbot. |
| Instructies | Uit `AGENTS.md` van elke bot. |
| Modellen | Hetzelfde model en dezelfde denkstand; Claude Code en Codex worden gekoppeld zonder sleutel. Reserves die een sleutel nodig hebben (DeepSeek) vul je zelf in bij AI-diensten. |
| Herinneringen | Per bot, direct actief; de vaste herinneringen vastgezet. Wat op een sleutel lijkt, wordt nooit overgenomen. |
| Skills | Je eigen skills. Skills van OpenBot zelf niet (andere licentie); zoek daarvoor een alternatief in de Marktplaats. |
| Routines | Allemaal, met hetzelfde schema, maar **uit**. |
| Kanalen | Telegram, Discord en Slack komen **uit en zonder token** binnen, met de bot die antwoordt en wie er mag schrijven. WhatsApp koppel je opnieuw (zie stap 4). |
| Teammap en teamtabellen | De teammap `~/OpenBot/Shared` wordt de map van het team (verwezen, niet gekopieerd); de teamtabellen (taken, beslissingen, logboek …) worden gekopieerd. |
| Werkmappen | TeamBot verwijst naar dezelfde werkmappen; er wordt niets gekopieerd of verplaatst. |

Wat niet meekomt: gesprekken en bijlagen (die blijven in OpenBot), sleutels en tokens, skills van OpenBot zelf,
workflows, de takenlijst en browserprofielen van OpenBot, je telefoonkoppeling en de instellingen van de OpenBot-app zelf.

Na de import draait er in TeamBot nog niets vanzelf: geen routine, geen kanaal. OpenBot werkt gewoon door.

## Stap 3. Controleer je bots, een paar dagen naast elkaar

OpenBot blijft in deze tijd je echte team. TeamBot heeft geen kanalen aan, dus berichten van buiten komen alleen bij
OpenBot binnen.

Praat in TeamBot met elke bot. Laat ze een klus doen die je kent, en vergelijk met OpenBot: kennen ze hun instructies,
hun herinneringen, de teammap en de teamtabellen? Werkt de Baas als hoofdbot? Doe een routine één keer met de hand
(*Nu testen* bij Routines) en kijk of het resultaat klopt. Bij de klantenservice: kijk alleen naar de concepten; versturen
vraagt in TeamBot altijd eerst jouw toestemming.

Neem hier een paar dagen voor. Werkt alles, vink dan *Mijn bots werken goed in TeamBot* aan.

## Stap 4. Zet je kanalen over, één voor één

Per kanaal is er één overstapmoment. Doe ze na elkaar, niet allemaal tegelijk.

**Telegram** (een Telegram-token kan maar door één app tegelijk gelezen worden):

1. Zet in OpenBot de Telegram-koppeling uit.
2. Open in TeamBot het kanaal (Overstappen › *Kanaal openen*), vul dezelfde token in en druk op *Verbinden*.
3. Stuur je bot een bericht en kijk of het antwoord uit TeamBot komt (*Test ontvangen en versturen*).

**WhatsApp** (de koppeling van OpenBot kan niet mee; TeamBot is een nieuw gekoppeld apparaat):

1. Zet in OpenBot de WhatsApp-koppeling uit en haal OpenBot op je telefoon weg bij *Gekoppelde apparaten*.
2. Kies in TeamBot Kanalen › *Kanaal toevoegen* › WhatsApp, lees de waarschuwing en scan de nieuwe QR-code.
3. Stuur een testbericht.

**Discord en Slack**: zoals Telegram; zet het eerst uit in OpenBot, vul dan de token in TeamBot in.

**Je telefoon**: gebruikte je de OpenBot-app op je telefoon? Koppel je telefoon in TeamBot via Instellingen › Telefoon.

Het Overstappen-scherm toont per kanaal waar het nu staat: *Nog in OpenBot*, *Uit in OpenBot: nu overzetten*,
*In TeamBot*, of in rood *Aan in beide apps*. Druk op *OpenBot bekijken* om de stand van OpenBot opnieuw te lezen.

Had je in OpenBot geen kanalen, dan sla je deze stap over.

## Stap 5. Zet de routines aan

1. Zet in OpenBot de routines uit, of sluit OpenBot af en start het niet meer.
2. Druk in TeamBot op *Zet de routines aan*.

Dan gaan precies de routines aan die in OpenBot aanstonden. Wat in OpenBot uit stond, blijft uit. TeamBot weigert een
routine aan te zetten die in een draaiende OpenBot nog aanstaat, en zegt welke. Een eenmalige routine waarvan het tijdstip
al voorbij is, blijft ook uit; kies een nieuw tijdstip bij Routines.

De **klantenservice-routines** (inbox, mail, WhatsApp) gaan nooit in één keer mee aan. Draai ze eerst één keer met de
hand, bekijk de concepten, en zet ze dan zelf aan bij Routines.

Daarna draait je team in TeamBot. Laat OpenBot uit, of verwijder het pas als alles een week goed loopt (je back-up uit
stap 1 heb je dan nog).

## Stap 6. Terug, als het nodig is

Gaat er iets mis met één kanaal of routine: zet het in TeamBot uit en in OpenBot weer aan. Dat kan per kanaal en per
routine; de rest blijft in TeamBot.

Wil je helemaal terug: zet in TeamBot alle kanalen en routines uit, zet ze in OpenBot weer aan en start OpenBot. Wil je
TeamBot ook leeg hebben: Overstappen › *Import ongedaan maken*. Dat verwijdert alles wat de import maakte (bots,
routines, kanalen, skills, de teamtabelrijen). OpenBot is nooit veranderd, dus daar staat alles nog. Was er toch iets
mis met OpenBot zelf: zet de mappen uit stap 1 terug, met OpenBot afgesloten.

---

## Wat de proefimport liet zien (9 november 2026)

Een proefimport op een kopie van jouw OpenBot-gegevens, in een tijdelijke TeamBot zonder kanalen:

- 10 bots met hun instructies en modellen; de Baas als hoofdbot, Kennis & Kansen als specialist.
- 36 routines, allemaal uit (30 stonden in OpenBot aan).
- 327 van de 328 herinneringen (1 leek op een sleutel), 24 vastgezet.
- 4 eigen skills; 27 skills van OpenBot zelf niet.
- De teammap en 903 rijen uit de teamtabellen.
- Geen kanalen: in OpenBot was geen Telegram of WhatsApp gekoppeld. Je telefoonkoppeling koppel je opnieuw.
- Zelf doen: de DeepSeek-sleutel (reserve) bij AI-diensten, en OpenCode installeren als je die reserve wilt houden.
- Geen enkele sleutel of token uit OpenBot kwam in TeamBot terecht; er draaide niets.
