# TeamBot — handleiding

Voor iedereen die TeamBot 0.4.4 gebruikt. Elk hoofdstuk gaat over iets wat je wilt doen; elke pagina in de app legt
zelf ook uit wat ze doet.

**Instellingen › Telefoon** betekent "klik op Instellingen en dan op Telefoon". Staat iets onder **Geavanceerd**, dan
schrijven we **Instellingen › Geavanceerd › Kanalen**. Knoppen en keuzes van TeamBot staan vet en heten precies zo als
in de app; knoppen van Windows of je telefoon staan schuin. Kwijt? Typ een woord in **Zoek een instelling** (bovenaan
Instellingen) of druk op **Ctrl+K** om overal te zoeken, ook in je taken.

> **Nog niet live getest** staat bij onderdelen die gebouwd en automatisch getest zijn, maar nog niet met een echt
> account of apparaat zijn geprobeerd. Hoofdstuk 26 zet ze op een rij.

<!-- inhoud -->
**Inhoud**

1. [Eerste start](#1-eerste-start)
2. [De indeling van de app](#2-de-indeling-van-de-app)
3. [De gebruiksbalk](#3-de-gebruiksbalk)
4. [De AI achter je bots](#4-de-ai-achter-je-bots)
5. [Gratis modellen](#5-gratis-modellen)
6. [Bots](#6-bots)
7. [Chatten](#7-chatten)
8. [Goedkeuringen en toegangsniveaus](#8-goedkeuringen-en-toegangsniveaus)
9. [Teams](#9-teams)
10. [Taken](#10-taken)
11. [Groepen en organisatie](#11-groepen-en-organisatie)
12. [Geheugen en dossiers](#12-geheugen-en-dossiers)
13. [Specialisten](#13-specialisten)
14. [Routines](#14-routines)
15. [Skills en apps](#15-skills-en-apps)
16. [Browser en computer use](#16-browser-en-computer-use)
17. [Bestanden, teammap en websites](#17-bestanden-teammap-en-websites)
18. [Spraak](#18-spraak)
19. [Kanalen: WhatsApp, Telegram en meer](#19-kanalen-whatsapp-telegram-en-meer)
20. [Je telefoon](#20-je-telefoon)
21. [Meldingen en statusvenster](#21-meldingen-en-statusvenster)
22. [Back-ups en updates](#22-back-ups-en-updates)
23. [Taal en overige instellingen](#23-taal-en-overige-instellingen)
24. [Servermodus: TeamBot voor vrienden of een team](#24-servermodus-teambot-voor-vrienden-of-een-team)
25. [Waar staat mijn data?](#25-waar-staat-mijn-data)
26. [Wat nog niet kan](#26-wat-nog-niet-kan)
27. [Problemen en oplossingen](#27-problemen-en-oplossingen)
<!-- /inhoud -->

## 1. Eerste start

### Installeren

Je hebt Windows 11 (64-bit) nodig, of Windows 10 met ESU- of LTSC-ondersteuning. Een account bij de makers is niet
nodig: op je eigen computer ben jij de eigenaar. Start `TeamBot-Setup-0.4.4.exe`. Zegt Windows "onbekende uitgever",
kies dan *Meer informatie* en *Toch uitvoeren*: de installer is nog niet ondertekend. Download TeamBot alleen van de
officiële releasepagina.

Had je al TeamBot 0.3? Dan blijft alles staan, samen in één team: **Mijn team** (hoofdstuk 9).

### Het welkomstscherm

Een nieuwe TeamBot begint leeg: geen bots, teams, skills of routines. Rechtsboven kies je je taal. Onder **Welkom bij
TeamBot** kies je één van drie manieren:

- **Ik heb Claude of ChatGPT**: bij **Claude (Pro of Max)** of **ChatGPT (Plus of Pro)** staat **Gebruiken** (klaar),
  **Inloggen** (het inlogvenster van de maker; TeamBot gaat daarna vanzelf verder) of **Installeren** (TeamBot zet een
  eigen kopie neer).
- **Ik heb een API-sleutel**: plak hem bij **Plak hier je sleutel** en klik op **Koppelen**. TeamBot herkent de
  dienst, test de sleutel gratis en bewaart hem versleuteld.
- **Gratis beginnen**, zonder account of sleutel: een lokaal model dat TeamBot vond (**Gebruiken**), of OpenCode met
  **Gratis starten** (±125 MB). De gratis modellen van OpenCode hebben een daglimiet; een lokaal model niet.

Daarna komen meteen de vragen voor je eerste bot. Staat OpenBot op deze pc, dan zie je bovenaan ook een balk om over
te stappen. Onder de drie kaarten staan **Of begin met een kant-en-klaar team** (hoofdstuk 9) en **Andere AI koppelen**
(hoofdstuk 4).

### Drie vragen

De pagina **Je eerste bot** (later **Nieuwe bot**) vraagt:

1. **Hoe heet je bot?**
2. **Wat doet hij?** Eén zin is genoeg. Of kies bij **Of kies een voorbeeld:** **Assistent**, **Onderzoeker**,
   **Schrijver** of **Codeerhulp**.
3. **Welk model gebruikt hij?** TeamBot stelt voor uit wat je hebt: eerst je eigen abonnement, dan gratis modellen,
   dan een model op deze pc. De beste keuze heet **Aanbevolen**. Je kunt het later altijd wijzigen.

Klik op **Bot aanmaken**; het gesprek met je bot gaat meteen open. De rest heeft goede standaardwaarden en staat onder
**Meer opties**: gezicht, rol, instructies (met **Laat AI de instructies schrijven**), taal, stijl en wat de bot mag.
Een nieuwe bot begint op **Vraagt toestemming** (hoofdstuk 8).

Vanaf je tweede bot is er een vierde vraag, **Soort bot**: **Gewone bot** of **Hoofdbot** (hoofdstuk 6). Je eerste bot
maak je later hoofdbot onder **⋮ › Bot-instellingen › Geavanceerd › Hoofdbot**. Heb je twee of meer teams, dan staat
onder de vragen in welk team de bot komt (**Komt in team …**); met **Ander team** kies je een ander.

### Overstappen van een andere app

Alles over overstappen staat op één plek: **Instellingen › Geavanceerd › Overig › Overstappen**. TeamBot leest de
andere app alleen; die blijft zoals hij is. Spijt? **Import ongedaan maken** haalt alles weer weg.

- **OpenBot**: staat OpenBot op deze pc, dan zie je ook op het welkomstscherm een balk. Volg **Overstappen van OpenBot,
  stap voor stap** (begin met een back-up van beide apps). Klik op **OpenBot inlezen**, vink aan wat mee moet, kies per
  bot een **Werkmap** (**Bestaande map gebruiken (aanbevolen)**, **Kopiëren naar TeamBot** of **Nieuwe lege
  werkmap**), bij **In welk team** het team en wie **Hoofdbot**, **Teamleider** en **Specialisten** worden, en klik op
  **Importeren**. Vooraf zie je **Wat niet meekomt**.
- **Hermes Agent**: tabblad **Hermes Agent** bij **Waar kom je vandaan?**, dan **Hermes inlezen** en **Importeren**.
  Elk Hermes-profiel wordt een bot met de instructies uit SOUL.md; je sleutels (.env, auth.json) worden niet geopend.
- **OpenClaw**: onder **Uit een andere app** het deel **Overstappen uit OpenClaw**, met **OpenClaw inlezen** en
  **Importeren**. Herinneringen komen als voorstel bij **Geheugen › Te beoordelen**.
- **Grok Bot** kan niet: het heeft geen export en bewaart niets op je pc. Maak een nieuwe bot, plak je instructies erin
  en kies xAI als engine.

> **Goed om te weten:** routines en geplande taken komen uitgeschakeld binnen, zodat niets dubbel draait; zet ze aan
> zodra je met de oude app stopt. Sleutels, kanalen, apps en je telefoon koppel je opnieuw. Gesprekken gaan niet mee.

### Geheugen uit ChatGPT, Claude of Gemini

Ga naar **Geheugen** (hoofdstuk 12) **› Opslag › Geheugen overnemen uit ChatGPT, Claude of Gemini**. Klik op
**Kopieer de vraag** en stel die vraag in de andere assistent. Plak het antwoord en klik op **Voorbeeld bekijken**: je
ziet per regel wat nieuw is en wat er al staat. Klik op **… voorstellen klaarzetten**. Je keurt ze daarna goed bij **Geheugen › Te beoordelen**.
Wachtwoorden en codes worden overgeslagen. Spijt? Klik op **Ongedaan maken**.

## 2. De indeling van de app

### De zijbalk

- Bovenaan: **TeamBot**, de bel (**Meldingen**) en **+**, een menu met **Nieuwe bot**, **Nieuw team** en **Team uit
  een sjabloon**. **Zoeken** zoekt in je bots; met Enter of **Ctrl+K** zoek je overal: gesprekken, taken, routines,
  geheugen, bestanden, instellingen.
- Daaronder je vastgezette bots als grote tegels (hoogstens drie), en je bots en groepen met wat ze het laatst zeiden.
  Hun gezicht laat zien wat ze doen. Met **Volgorde** kies je **Laatste activiteit** of **Eigen volgorde**.
- Onderaan: **Alles stoppen** (alleen als er iets loopt), **Wacht op jou** met het aantal vragen, **Taken**,
  **Marktplaats** en **Instellingen**, met daaronder de gebruiksmeters: een ring per abonnement of aanbieder
  (hoofdstuk 3). **Waar staat mijn data?** staat onder **Instellingen › Privacy en beveiliging**. **Routines** en **Nu bezig** staan bovenaan **Taken**; **Geheugen** vind je onder
  **Instellingen › Geavanceerd › Bots en teams** (of met **Ctrl+K**).
- Elke bot in de lijst heeft een gekleurd stipje: aan het werk, wacht op jou, klaar of er ging iets mis.

Heb je twee of meer teams, dan staat bovenaan de teamkiezer: **Alle teams** of één team, met de naam en kleur van het
actieve team altijd in beeld. Met één team zie je hem niet.

Je hoofdbot staat bovenaan als eerste tegel, ook op je telefoon; daaronder de bots en groepen van het gekozen team.

### Mappen voor chats

Houd een lange lijst overzichtelijk met eigen mappen, per team. Maak een map met **Volgorde › Nieuwe map…**, of kies
in een chat **⋮ › Meer acties › Verplaats naar map…** en typ onder **Nieuwe map** een naam: de chat gaat er meteen in. Op de computer
kun je een chat ook naar een map slepen, en weer terug naar de lijst. Klik op de naam van een map om hem dicht- of
open te klappen; dat onthoudt TeamBot, ook op je telefoon. Onder **⋯** naast een map staan **Naam wijzigen…** en
**Map verwijderen…**: de chats gaan dan terug naar de lijst, er wordt niets gewist.

Een map hoort bij één team. Een bot past alleen in een map van zijn eigen team, een groep in een map van het team van
de groep. Kies je in de teamkiezer een ander team, dan zie je de mappen van dat team. Op je telefoon gaat het via
**⋮ › Meer acties › Verplaats naar map…** (slepen is daar niet nodig). Tijdens het zoeken staat alles weer in één lijst.
Vastgezette bots en de hoofdbot staan als tegel bovenaan en gaan niet in een map.

### Instellingen

**Instellingen** heeft vier groepen met wat je echt gebruikt, en één regel **Geavanceerd** voor de rest:

| Groep | Regels |
|---|---|
| **Account en uiterlijk** | **Algemeen** · **Uiterlijk** |
| **AI** | **AI-diensten** · **Gebruik en limieten** |
| **Telefoon en meldingen** | **Telefoon** · **Meldingen** |
| **Gegevens en privacy** | **Waar staat mijn data?** · **Back-ups** · **Beveiliging** |
| **Geavanceerd** | één pagina met alles wat hierboven niet staat |

De pagina **Geavanceerd** heeft deze delen (met * alleen als **Geavanceerd tonen** aan staat):

| Deel | Onderdelen |
|---|---|
| **Bots en teams** | **Alle bots** · **Geheugen** · **Teams** · **Groepen** · **Gebruikers** (servermodus) · Kennisbanken* · Alle teams* · Organisatie* · Nu bezig* · Routines* |
| **Meer over AI** | **Abonnementen** · **Gratis modellen** · **Zoeken** · **Kosten** · Gratis doorschakelen* |
| **Kanalen en apps** | **Kanalen** · **Apps** · **Websites** |
| **Spraak** | **Spraak** · **Vergadernotities** · Spraakgesprekken* |
| **Bestanden en computers** | **Bestanden** · **Computers** · Bureaublad op afstand* · Kluis* · Prullenbak* · Teammap* |
| **Overig** | **Overstappen** · Hoe gaat het met TeamBot?* · Netwerk en proxy* · Uitgevers en beleid* · Alle meldingen* · Concepten* |

Wat met * staat, vind je ook via de pagina waar het bij hoort (bijvoorbeeld **Bestanden › Prullenbak** of **Telefoon ›
Bureaublad op afstand**), en **Ctrl+K** vindt alles.

**Zo werken de instellingen.** Elke instelling heeft één knop: een schakelaar (aan of uit), een rij keuzeknoppen of een
keuzelijst. Wat je kiest, is meteen bewaard; je ziet kort **Opgeslagen**. Met **Standaard terugzetten** zet je een blok
terug zoals het was. Bij een model kies je **Automatisch** (de engine kiest) of **Zelf kiezen** (dan zie je de lijst).
Meer uitleg staat achter het **(i)**-teken.

### Geavanceerd tonen

TeamBot is standaard eenvoudig. De schakelaar **Geavanceerd tonen** staat onderaan **Instellingen › Geavanceerd** (en
in **Ctrl+K**). Aan geeft hij de onderdelen voor gevorderden: de delen met * hierboven; beslissingen, gebeurtenissen,
experimenten en tabellen bij **Teamwerk**; **Activiteit**, **Team**, **CLI** en **Details** in het **Zijpaneel**; de
technische naam van elke stap; en **Grenzen** bij **Groepen**. Er verdwijnt niets als hij uit staat.

### Telefoon en systeemvak

Op je telefoon zijn er drie tabbladen: **Chats**, **Wacht op jou** en **Meer**. Onder **Chats** staat hetzelfde **+**-menu
als op de pc. **Meer** toont de teamkiezer (vanaf twee teams), de gebruiksbalk, **Alles stoppen**, en dan **Nu bezig**, **Taken**,
**Routines**, **Geheugen**, **Marktplaats**, **Instellingen**, **Zoeken** en **Waar staat mijn data?**.

Sluit je het venster van de desktop-app, dan blijft TeamBot draaien in het systeemvak (het oranje figuurtje
rechtsonder), zodat routines, kanalen en je telefoon blijven werken. Met rechts klikken krijg je onder meer **TeamBot
openen**, **Wacht op jou**, **Gebruik en limieten**, **Zwevend statusvenster**, **Alle bots stoppen**, **Noodstop
bureaublad (Ctrl+Alt+Esc)**, **Starten bij inloggen op Windows**, **Datamap openen** en **Afsluiten**. Pas na
**Afsluiten** stopt TeamBot echt.

## 3. De gebruiksbalk

Onderin de zijbalk staat per abonnement of aanbieder een **ring** met het eigen teken van die aanbieder (of zijn
beginletter): de buitenste ring is de week, de binnenste de 5 uur. Grijs is rustig, oranje vanaf 75%, rood vanaf 90%.
Klik op een ring en je ziet alleen die aanbieder: per periode een balkje, wat er nog over is, wanneer het weer vol is,
en **Vernieuwen**. Passen niet alle ringen, dan opent **+1** de rest. Het metertje ernaast opent **Gebruik en
limieten** met alles bij elkaar. Op je telefoon staat het blok **Gebruik** bovenaan **Meer**, en daar geldt:

- **Per abonnement een balkje per periode:** bij Claude **5 uur** en **Week** (en een modelweek, zoals voor Opus, als
  Claude die meldt), bij Codex **5 uur** en **Week**, met het percentage en wanneer de limiet weer vrij is.
- **Kleuren:** groen, oranje vanaf 80% (**bijna op**), rood bij de limiet (**limiet bereikt**).
- **Gratis:** per gratis bron een bolletje: **beschikbaar**, **bijna op**, **op tot …** of **niet bereikbaar**.
- **≈** is een **schatting**: de aanbieder geeft geen exact cijfer. Wat een engine niet meldt, heet "nog niet gemeld".

Het pijltje (**Meer over het gebruik tonen**) geeft de resettijden voluit, uitleg per bron, **Verbruik per bot** en
**Vernieuwen**. Daar staat ook dat de pot **gedeeld** is: wat je buiten TeamBot met Claude of ChatGPT doet, telt mee.
Een klik op de balk opent **Gebruik en limieten** (ook **Instellingen › Gebruik en limieten**): **Limieten nu**,
**Verbruik per bot** (vandaag en deze week), **Alle accounts in detail** en **Meldingen**, met **Waarschuwen vanaf**
(standaard 80%) voor een melding op je pc en telefoon.

> **Goed om te weten:** tijdens een beurt verspringt de balk meteen, erna binnen een minuut. Gebruik buiten TeamBot
> ziet TeamBot bij het openen van de app en elke 10 minuten. Een API-sleutel heeft geen abonnementslimiet; de kosten
> staan bij **Kosten**.

**Weekreserve:** boven een grens die je kiest bij **Gratis doorschakelen › Weekreserve (% van de week)** (hoofdstuk 5)
(standaard 85% van de week van Claude of Codex) gaat gewoon werk al naar een ander model uit de keten, zodat je
abonnement overblijft voor belangrijk werk. Op de weekbalk staat een streepje bij die grens, met **Nu actief.** zodra je
erboven zit.

Heb je twee of meer teams, dan toont **Gebruik en limieten** het verbruik ook per team.

## 4. De AI achter je bots

| Wat je hebt | Kies | Kosten |
|---|---|---|
| Claude Pro of Max | **Claude Code** | Valt onder je abonnement |
| ChatGPT Plus of Pro | **OpenAI Codex CLI** | Valt onder je abonnement |
| Niets | **OpenCode** (**Gratis starten**) of een gratis bron (hoofdstuk 5) | Gratis, met een daglimiet |
| Een snelle pc | **Ollama (lokaal)** of **LM Studio (lokaal)** | Gratis, alles blijft op je pc |
| Een API-sleutel | Bijvoorbeeld **OpenAI (API)**, **Anthropic Claude (API)**, **Google Gemini**, **OpenRouter** | Per gebruik |

Onder **Instellingen › AI-diensten** staan je **Gekoppelde providers** (met **Test verbinding**), **Lokaal zoeken
(Ollama, LM Studio, CLI's)** en **Provider toevoegen**, in de groepen **Gratis**, **Via je abonnement**, **Lokaal** en
**Met API-sleutel**. Sleutels worden versleuteld bewaard.

### Claude Code, Codex en OpenCode

Onder **Instellingen › Geavanceerd › Abonnementen** heeft elke CLI een kaart: **gevonden** (met versie), **ingelogd**, via abonnement
of sleutel, en welk programma TeamBot start. Met **Installeren (versie …)** bij **Kopie die TeamBot beheert** zet
TeamBot een eigen, gecontroleerde kopie neer, zodat je niet afhangt van een andere app. Niet ingelogd? Klik op **Hier
inloggen** (Claude Code: plak daarna de code in **Code van de inlogpagina** en klik op **Inloggen**), of klik bij
OpenCode op **Terminal openen**, log in en klik op **Opnieuw zoeken**.

Bots op deze CLI's krijgen het gereedschap van TeamBot mee (geheugen, samenwerken, browser, skills, routines,
bestanden, kanalen); elk gebruik zie je als één stap. TeamBot leest, kopieert of deelt je login niet. Gebruik je
Claude-abonnement alleen voor jezelf.

### Model, reserves en kosten

- **Model:** in **Bot-instellingen › AI-engine** kies je **Engine** en **Model**, met wat het model kan (**Tools**,
  **Afbeeldingen**, **Context**, **Denkniveaus**, **Prijs**). Het **Denkniveau** staat onder **Geavanceerd › Denken,
  drukte en reserve-engines**. Bij Ollama en LM Studio kies je het **Contextvenster**; **16K tokens (aanbevolen)** is
  een goed begin.
- **Reserve-engines:** op dezelfde plek geef je een bot tot 5 reserves. Is de limiet op of de dienst overbelast, dan
  gaat de bot verder op de volgende en zegt de chat dat. Na de reset gaat hij terug. **Bij een gebruikslimiet** kies je
  wisselen, wachten of **Stoppen en het melden**.
- **Limiet op zonder reserve?** Onder het antwoord staat een knop als **Verder met Ollama (lokaal) · qwen3.6**. De bot
  antwoordt meteen opnieuw en houdt die engine als reserve. TeamBot biedt hier alleen aan wat niets extra kost.
- **Kosten:** **Instellingen › Geavanceerd › Kosten** toont de geschatte kosten per dag, bot en model. Het
  **Dagbudget (USD)** voor betaalde engines staat onder **Instellingen › Algemeen › Meer opties**. Is het op, dan zegt
  de bot **daglimiet bereikt**, met **Dagbudget aanpassen**.
- **Gebruikslimiet per bot:** onder **Bot-instellingen › Geavanceerd › Gebruikslimiet** geef je één bot een maximum:
  **Kosten (US$)** of **Tokens**, per **Dag** of **Week (vanaf maandag)**. Het telt op elke engine, ook een abonnement.
  Is het op, dan pauzeert de bot met één bericht ("… heeft zijn eigen limiet bereikt …") tot de volgende dag of week,
  met **Gebruikslimiet aanpassen**.
- **Kosten vooraf:** bij een taak op het bord (hoofdstuk 10) en in een routine staat **Kosten vooraf** (een
  **schatting**) als het werk geld kost, belangrijk is of een flink deel van je limiet gebruikt: wat het ongeveer kost
  en welk deel van je 5-uur- of weeklimiet. Past het niet meer, dan zet **Start na de reset om …** het klaar voor na de
  reset (daarna staat er **Ingepland: start …**).

TeamBot is zuinig met tokens: een bot krijgt alleen de tools mee die nodig lijken, oudere tool-uitvoer wordt ingekort
en dezelfde uitvoer gaat niet twee keer mee. Wat er meeging, zie je in het **Zijpaneel** onder **Details › Context van de
laatste stap** (met **Geavanceerd tonen**), bij een API-sleutel ook met de schakelaar **Zuinig met context**.

## 5. Gratis modellen

Ga naar **Instellingen › Geavanceerd › Gratis modellen**. De kaart **Gratis bronnen** heeft twee delen; alles wat je pc
verlaat, staat uit tot je het aanzet.

- **Op deze computer** (OpenCode, Ollama): klik op **Aanzetten** (of **Installeren** als hij er nog niet is);
  **Uitzetten** zet hem weer uit.
- **Online, met een gratis account** (**Groq**, **OpenRouter**, **Cloudflare Workers AI**, **Z.ai GLM**, **Kilo
  Gateway**): zet **Gebruiken** aan. Vraagt hij een sleutel, maak die aan met **Gratis sleutel aanmaken** (bij
  Cloudflare ook het **Account-ID**) en klik op **Opslaan en aanzetten**. Kilo werkt zonder sleutel.

Een bron die aan staat, is te kiezen bij **Welk model gebruikt hij?** en als reserve-engine.

Per bron zie je een privacylabel (**blijft op je pc**, **bewaart niets** of **kan trainen**), de stand (**Beschikbaar**,
**Op tot …**, **Limiet bereikt**, **Sleutel ongeldig**, **Niet bereikbaar** …), hoeveel gratis modellen er zijn en of
tools werken (**tools werken**, **alleen tekst**, **nog niet getest**), en de links **Limieten** en **Voorwaarden**.

- Elke dag haalt TeamBot de modellenlijsten op (gratis); een verdwenen model wordt niet meer aangeboden. Elk model
  krijgt hoogstens één keer per dag een kleine proef met één tool. **Meer opties › Lijsten nu verversen** doet het
  meteen.
- Een antwoord dat "gelukt" lijkt maar een foutmelding is of afbreekt, telt als mislukt en komt niet in je chat.
- Tegoed telt per account: een ander model bij dezelfde aanbieder helpt niet. Eén account per aanbieder; accounts
  combineren mag niet. Google Gemini gratis staat er niet bij: in Europa mag een app alleen de betaalde laag gebruiken.

> **Nog niet live getest:** chatten en de proeven bij deze bronnen met een echte sleutel.

**Automatisch doorschakelen:** is het model van een bot op, dan schakelt TeamBot vanzelf door, voor al je bots: eerst
naar de eigen reserves van de bot, dan naar je andere abonnement, dan naar een gratis aanbieder (eerst een *andere*
aanbieder, met hetzelfde soort model) en ten slotte naar een lokaal model. Elk antwoord zegt welk model het gaf, en bij
uitwijken waarom. Het staat standaard aan. Aanpassen doe je op de pagina **Gratis doorschakelen** (link **Doorschakelen
instellen** op de kaart **Gratis bronnen**; in de lijst van Geavanceerd met **Geavanceerd tonen**): **Automatisch
doorschakelen naar een ander model**, **Belangrijk werk draait alleen op** en **Weekreserve (% van de week)**. Per bot:
**Privé en doorschakelen** (**Automatisch doorschakelen als het model op is**).

**Belangrijk:** een taak of routine met deze schakelaar gaat niet door op een zwakker model. Is binnen het niveau van
**Belangrijk werk draait alleen op** (standaard Claude of Codex) niets vrij, dan
pauzeert hij met de reden en de verwachte hervattijd, krijg je een melding (ook op je telefoon, als TeamBot daar niet
open staat) en gaat hij na de reset vanzelf verder. Zet je bij een bot **Privé: alleen een lokaal model of een bron die
niets bewaart** aan, dan gaat zijn werk alleen naar een lokaal model of naar een bron die niets bewaart.

TeamBot kiest lokale modellen slim: op de kaart **Lokale modellen op deze pc** (onder **Instellingen › AI-diensten**)
zie je per model **Past goed**, **Werkt traag** of **Te groot**, en met **Tools testen** of het tools kan gebruiken.

## 6. Bots

### Een bot maken en instellen

Klik op **+ › Nieuwe bot** en beantwoord de vragen (hoofdstuk 1). Kant-en-klare bots staan in **Marktplaats › Bots**;
een bot uit een bestand haal je binnen met **Alle bots › Importeren** (**Instellingen › Geavanceerd › Alle bots**).

Instellen: klik in een gesprek rechtsboven op **⋮** (**Meer opties**) en kies **Bot-instellingen**, of klik onder
**Alle bots** bij de bot op **Instellingen**. Er zijn vier blokken:

1. **Wie is de bot?**: **Gezicht**, **Naam**, **Rol**, **Korte beschrijving**, **Instructies**, **Taal van de
   antwoorden** (standaard de taal waarin je schrijft) en **Antwoordstijl** (**Natuurlijk** of **Zakelijk**).
2. **AI-engine**: **Engine** en **Model**: **Automatisch** of **Zelf kiezen** (hoofdstuk 4). Eronder staat in één
   regel wat er met je gegevens gebeurt, met een knop om het uit te zetten.
3. **Wat mag de bot?** (hoofdstuk 8).
4. **Geavanceerd**: onder meer **Tools**, **Computer & bestanden**, **Werkmap en mappen**, **Skills**, **Apps**,
   **Kanalen**, **Geheugen**, **Routines**, **Spraak**, **Meldingen**, **Gebruikslimiet**, **Sjabloon en delen** en
   **Geschiedenis**.

Klik op **Opslaan**. Het gezicht laat altijd zien wat de bot doet: rustig, aan het werk, wacht op jou, klaar, pauze,
daglimiet bereikt of er ging iets mis.

### Het chatmenu

Het menu onder **⋮** is kort en heeft twee kopjes. Onder **Dit gesprek**: **Nieuw gesprek**, **Zoeken in dit
gesprek**, **Exporteren** en **Meer acties**. Onder **Deze bot**: **Bot-instellingen**, **Wat … zag en deed**
(bestanden, webpagina's, apps en opdrachten) en **Bot beheren**. Helemaal onderaan, in het rood: **Gesprek
verwijderen**. Een regel met een pijltje opent een vervolgmenu; de bovenste regel daarvan brengt je terug.

Onder **Bot beheren** staan **Bot vastzetten (bovenaan)**, **Bot dupliceren** (zonder gesprekken en geheugen), **Bot
archiveren** (terughalen via **Alle bots › Archief**), **Geschiedenis wissen…** en **Bot verwijderen…**. Bij wissen
en verwijderen zie je eerst wat weggaat en wat blijft. Onder **Meer acties** staat onder meer **Verplaats naar map…**:
dat zet de chat in een map in je lijst (zie *Mappen voor chats* in hoofdstuk 2).

**Geavanceerd › Geschiedenis** toont elke opgeslagen wijziging, met **Vergelijken met nu** en **Terugzetten**.
**Geavanceerd › Sjabloon en delen** heeft **Exporteren als bestand** en **Delen op deze server**; een sjabloon neemt
nooit gesprekken, geheugen, bestanden, sleutels of je AI-keuze mee.

### De hoofdbot en leiders

Bij **Nieuwe bot** kies je bij **Soort bot** **Gewone bot** of **Hoofdbot** (niet bij je eerste bot); je hebt er
hoogstens één. De hoofdbot is je
vaste voordeur, ook op je telefoon: je praat met hem, hij zet werk door naar het juiste team en meldt terug, met bewijs.
Hij mag standaard alle teams aansturen. In de bot-instellingen staat onder **Geavanceerd** het onderdeel **Hoofdbot**.

**Vastgelopen werk.** Ligt er ergens werk stil, dan zegt de hoofdbot dat één keer in zijn eigen gesprek, in een of
twee zinnen: wat er wacht, in welk team en waar je antwoordt. Dat gebeurt bij een goedkeuring of vraag die al 30 minuten
in **Wacht op jou** staat, bij een taak die vastliep of werd afgebroken en die na 5 minuten nog niemand opnieuw heeft
gestart, en bij een mislukte routine. Onder het bericht staan **Naar Wacht op jou**, **Gesprek openen** of **Bonnetje
bekijken**, en bij een kapotte taak of routine **Opnieuw proberen**. De hoofdbot beslist nooit zelf: hij keurt niets
goed en start niets opnieuw, dat doe jij. Zo'n bericht kost geen tokens. Heb je geen hoofdbot, dan krijg je alleen de
gewone meldingen.

Elke andere bot wordt leider als hij naast zijn thuisteam **Aansturen** heeft op een ander team (hoofdstuk 9); je ziet
ze onder **Leiders** op **Alle teams**. Zo bouw je je eigen organisatie: hoofdbot, leider, teamleiders, bots. Een bot
neemt geen geheugen van het ene team mee naar het andere, en ketens van bots die elkaar opdrachten geven zijn altijd
begrensd.

## 7. Chatten

Klik op een bot, typ je bericht en druk op Enter. Met **+** (**Bestand toevoegen**), slepen of plakken stuur je een
bestand of foto mee; bots lezen ook pdf's, Word-, Excel- en PowerPoint-bestanden, en na één download ook scans en
foto's van een brief (zie [17](#17-bestanden-teammap-en-websites)). Leest een bot een webpagina, dan krijgt hij alleen
het artikel, zonder menu's, cookiemeldingen en reclame. Je ziet live wat de bot doet, in korte regels. Onder elk
antwoord staan de tijd, de engine, het model, de tokens en de geschatte kosten. De chat blokkeert nooit.

Typ je terwijl de bot werkt, dan kies je **Wachtrij** (volgende beurt), **Bijsturen** (hij leest het al tijdens zijn
beurt) of **Onderbreken** (hij stopt en gaat verder met jouw bericht).

### Jouw gesprekken, overleg en automatische runs

Een bot in de zijbalk opent altijd jouw eigen gesprek. Overleg tussen bots en routines overspoelen dat niet. Klik
bovenaan op de naam van de bot voor **Nieuw gesprek met …** en de blokken **Jouw gesprekken**, **Via kanalen**,
**Overleg tussen bots** en **Automatische runs**.

### Knoppen in het gesprek

- De engine-knop (bijvoorbeeld **Claude Code · abonnement**) en het rondje ernaast: hoe vol het gesprek is, en je
  limieten. Bij 75% vat TeamBot het oudere deel samen; **Nu samenvatten** doet het meteen. Hier zit ook **Model
  wijzigen**.
- Het telefoontje **Live praten** (bellen met de bot, hoofdstuk 18) en **Computer van de bot** (hoofdstuk 16).
- **Zijpaneel**: **Bestanden** (wat de bot maakte of wijzigde), **Geheugen** (wat de bot over dit gesprek weet),
  **Computer** en **Wijzigingen** (hoofdstuk 17). Op je telefoon: **⋮** › **Bestanden en wijzigingen**.
- **/** in het invoerveld: opdrachten en de skills van de bot.
- Onder een tabel in een antwoord: **Kopieer tabel**. De tabel gaat als CSV naar het klembord; plak je hem in Excel
  of Google Sheets, dan krijg je gewone cellen; in een tekstbestand of mail plak je de CSV.
- Onder een antwoord: **Reageren**, **Beantwoorden**, **Kopiëren**, **Voorlezen** en **Meer** (**Vastpinnen**, **Vanaf
  hier vertakken**, **Doorsturen**, **Verwijderen**). Ging er iets mis, dan staat er **Opnieuw proberen**; wat al
  lukte, doet de bot niet nog een keer.
- In het chatmenu **⋮** ook: **Zoeken in dit gesprek** (Ctrl+F), **Exporteren** (**als Markdown** of **als JSON**),
  **Gesprek verwijderen**, en onder **Meer acties**: **Naam van gesprek wijzigen**, **Gesprek vastpinnen**, **Gesprek
  samenvatten** en **Archiveren**.
- **⋮ › Meer acties › Bewaar als skill…**: lukte iets in dit gesprek, dan schrijft de bot er een skill van (een werkwijze die hij
  later opnieuw volgt). Je leest en past naam, beschrijving en werkwijze aan, kiest **Alleen** die bot of **Alle bots van
  het team**, en pas **Opslaan als skill** bewaart hem (met de gewone veiligheidscontrole). Kan de AI geen concept
  schrijven, dan krijg je een opzet uit het gesprek zelf en staat erbij waarom.

Maakt de bot een pagina (een voorbeeld, rapport of mini-app), dan opent **Naast de chat** die als tabblad naast het
gesprek (op de telefoon: **Groot openen**). Selecteer tekst en klik op **Citeren** om hem in je bericht te zetten. Zo'n
pagina draait afgeschermd, zonder internet en zonder toegang tot TeamBot.

## 8. Goedkeuringen en toegangsniveaus

Per bot kies je in **Bot-instellingen › Wat mag de bot?** een niveau:

| Niveau | Wat het betekent |
|---|---|
| **Alleen chat** | Geen tools. De bot praat alleen. |
| **Alleen lezen** | Lezen en zoeken, niets wijzigen. |
| **Vraagt toestemming** | Lezen mag; wijzigen en uitvoeren pas na jouw akkoord. De standaard. |
| **Automatisch** | Wijzigt zonder te vragen. Verzenden, betalen, publiceren en verwijderen wat niet terug kan, vragen nog wel. |
| **Volledige toegang** | Doet zijn werk zonder te vragen en kan bij je hele computer, niet alleen bij zijn eigen mappen. Versturen naar anderen en betalen vragen nog wel. Mappen met sleutels en wachtwoorden en de gegevens van TeamBot blijven dicht. Alleen voor bots die je vertrouwt. |

Welke tools hij heeft, kies je onder **Geavanceerd › Tools**. Wachtwoordvelden, mappen met sleutels en betaalpagina's
blijven altijd dicht.

Wil de bot iets wijzigen, dan verschijnt een kaart met **Eenmalig toestaan**, **Altijd toestaan voor deze bot** of
**Weigeren**; **Exacte invoer bekijken** laat precies zien wat hij wil doen. Bij verzenden, betalen, publiceren en
verwijderen wat niet terug kan, is er geen **Altijd toestaan**. Alles wat op je wacht, staat ook onder **Wacht op jou**, met het tabblad
**Geschiedenis**. Een melding keurt nooit vanzelf iets goed.

Op **Automatisch** en **Volledige toegang** vraagt TeamBot alleen toestemming waar het telt: bij acties die je niet
kunt terugdraaien of die naar buiten gaan, met een exacte voorvertoning. Een bestand dat een bot wist, gaat naar de
**Prullenbak** (hoofdstuk 17), dus dat is terug te draaien. Webpagina's, mails en berichten van andere bots behandelt een
bot als gegevens, niet als opdracht.

### Eigen regels

Onder **Wat mag de bot?** staat ook **Eigen regels** (bij een bot die al bestaat; bij een nieuwe bot na het aanmaken).
Daar schrijf je in gewone woorden wat de bot nooit mag, eerst moet vragen of altijd mag, bijvoorbeeld:

- *Mail nooit naar klanten zonder mij te vragen*
- *Vraag altijd voordat je iets in de webshop verandert*
- *Verwijder nooit bestanden*
- *Mag altijd bestanden maken in de map Offertes*

Terwijl je typt, zie je onder **Zo legt TeamBot het vast** wat TeamBot ervan maakt: nooit, eerst vragen of mag zonder
vragen, en waarvoor het geldt (een handeling, een app, een map, een website, of alleen naar anderen dan jou). Klopt het,
dan klik je **Toevoegen**. TeamBot houdt zich er zelf aan, ook als de bot het vergeet: hij weigert of vraagt jou, en de
kaart begint met **Jouw regel**. Een regel weghalen doe je met **Weghalen**. Regels voor alle bots van een team zet je op
de teampagina, bij **Regels voor alle bots van dit team** (**Instellingen › Geavanceerd › Teams**).

Een regel kan een bot altijd strenger maken. **Mag altijd** werkt alleen binnen het niveau van de bot (bij **Vraagt
toestemming**) en alleen voor een map, website, app of tool. Versturen, betalen, publiceren en verwijderen vragen altijd.
Een regel die TeamBot niet precies kan vastleggen, zoals *Noem nooit prijzen zonder overleg*, gaat naar een tweede
controle die jou bij twijfel vraagt. Een regel die de bot meer laat doen, en een regel weghalen, doe je op je computer.

## 9. Teams

Een team is een afgeschermde werkruimte met eigen bots, een eigen teammap, een eigen bedrijfsprofiel en, als je wilt,
eigen sleutels. Je begint met één team; meer teams kan altijd, bijvoorbeeld één per bedrijf.

### Eén team om te beginnen

Je eerste team ontstaat vanzelf met je eerste bot en heet **Mijn team**. Zolang er één team is, zie je nergens iets
over teams. Onder **Instellingen › Geavanceerd › Teams** staan:

- **Team**: **Naam**, **Teamleider** (de bot met het laatste woord) en **Kleur**;
- **Bedrijfsprofiel**: **Naam van het bedrijf**, **Wat het bedrijf doet**, **Toon** en **Regels**. Elke bot van het
  team krijgt dit mee bij zijn werk. Klik op **Opslaan**;
- **Bots van dit team** en de teammap (hoofdstuk 17).

### Een tweede team

1. Klik op **+ › Nieuw team** (of onder **Instellingen › Geavanceerd › Teams** op **Nieuw team**), vul een **Naam**
   in en klik op **Team maken**. Een nieuw team begint leeg.
2. Het nieuwe team staat meteen open. Bovenaan staat nu een knop per team, met kleur en aantal bots.
3. Kies onder **Bots van dit team** een bot bij **Bot van een ander team kiezen…** en klik op **Naar dit team
   verplaatsen**.

Een bot hoort bij één team, zijn thuisteam: daar werkt hij, met de map, het profiel en de sleutels van dat team. Een
nieuwe bot komt in het team dat je in de teamkiezer koos, en bij **Alle teams** in je eerste team. Dat staat onder de
vragen (**Komt in team …**); met **Ander team** kies je meteen een ander. **Alle teams** toont één overzicht: resultaten,
fouten, gemiste runs, wat op jou wacht en het verbruik per team.

### Toegang per bot

Open het team waartoe een bot toegang moet krijgen en kies bij die bot onder **Toegang voor bots van andere teams**:

| Toegang | Wat de bot mag in dit team |
|---|---|
| **Geen toegang** | Niets; hij ziet het team niet. De standaard. |
| **Meekijken** | De teammap lezen, niets veranderen. |
| **Aansturen** | De teamleider en de bots van dit team taken geven, en meekijken. |

Zo kan één sterke bot meerdere teams en hun teamleiders aansturen. De muren zitten in de code, niet alleen in de
instructies: zonder toegang komt een bot niet bij de teammap, de sleutels of de bots van dat team, ook niet via een
bestandspad of door het werk door een andere bot te laten doen.

### Sleutels voor alle teams of één team

Sleutels en logins staan in één kluis en werken standaard **voor alle teams**. Vanaf het tweede team kies je per
AI-sleutel, app en login onder **Sleutels en logins** **Alle teams** of **Alleen …** (een team); zo'n sleutel krijgt
het label **alleen dit team**. Bots van andere teams kunnen hem dan niet gebruiken, ook niet met **Aansturen**; ze
laten het werk doen door een bot van dat team. Nieuwe sleutels voeg je toe bij **AI-diensten**, **Apps** of in de
**Kluis**.

**Team verwijderen** kan alleen als er geen bots meer in zitten en geen sleutels alleen voor dat team.

> **Goed om te weten:** een werkmap is geen afgeschermde omgeving. Zet de teammap van een team niet binnen de werkmap
> van een bot van een ander team.

Elk team heeft ook een eigen geheugen en dossiers, teamtabellen en logboek, en vanaf het tweede team een eigen
**Dagbudget van dit team**. Bots zoeken alleen binnen hun team (en teams waar ze mogen meekijken). Een groep hoort bij één
team. Delen tussen teams gaat alleen bewust, en kopiëren gaat boven koppelen. Ook kanalen, skills en routines horen bij
een team: een kanaal en een routine horen bij het team van hun bot, en een skill installeer je voor één team of kies je
**Alle teams**.

**Team dupliceren** (onderaan bij het team) maakt een nieuw team met een kopie van elke bot: instructies, skills en
routines (die uit staan), plus hetzelfde bedrijfsprofiel, dezelfde teamleider en hetzelfde dagbudget. Geheugen,
gesprekken, sleutels, kanalen, de teammap en toegang van bots van andere teams gaan nooit mee; de hoofdbot blijft er één.
Een groep met haar bots bewaar je als bestand met **Groepsinstellingen › Exporteren als team** (hoofdstuk 11).

Je eerste team kan op het welkomstscherm beginnen uit een sjabloon (**Of begin met een kant-en-klaar team**), voor een
soort bedrijf of voor privé: een paar vragen voor het bedrijfsprofiel, bots, voorgestelde skills en routines die eerst
uit staan. Geheugen en sleutels komen nooit mee. Later staan dezelfde sjablonen onder **Groepen › Nieuwe groep › Uit een
sjabloon**, zonder de vragen en de skills; **Nieuw team** begint altijd leeg.

## 10. Taken

**Taken** in de zijbalk is één bord met al het werk van jou en je bots. Het werkt live bij. Bovenaan staan de links
**Routines** (hoofdstuk 14) en **Logboek**, en de knop **Nu bezig**.

**Nu bezig** toont elke bot die nu werkt, met wat hij op dit moment doet. Gebruikt een bot zijn browser, dan zie je er
een klein live beeld van. Met **Bekijken** open je het gesprek met de browser ernaast, met **Overnemen** bedien je de
browser zelf en met **Stoppen** stop je de bot. Op je telefoon staat **Nu bezig** bovenaan **Meer**.

| Kolom | Wat erin staat |
|---|---|
| **Te doen** | Nog niet opgepakt |
| **Bezig** | Een bot werkt eraan |
| **Te controleren** | Klaar volgens de bot, of er is iets van jou nodig |
| **Klaar** | Met resultaat en bewijs |
| **Geblokkeerd** | Kan nu niet verder |

- **Toevoegen:** typ bij **Nieuwe taak…** wat er moet gebeuren en klik op **Toevoegen**. Heb je groepen, kies dan
  **Voor mezelf** of een groep; de bots van die groep pakken hem op.
- **Een kaart** toont wie het doet, **Wacht op jou** als jij aan zet bent, de groep, de deadline, en een icoontje bij
  een "klaar als" of bewijs. Verplaats een taak met de keuzelijst eronder.
- **Klik op een taak** voor **Status**, **Wie doet het**, **Klaar als**, **Beschrijving**, **Resultaat**, **Bewijs** en
  **Controle**, met **Naar het gesprek** en **Verwijderen**. Staat een taak op **Klaar** zonder bewijs, dan zegt
  TeamBot dat: vraag de bot om een link, bestand of schermafbeelding.
- **Toon gestopte** toont geannuleerde en vervallen taken. Op je telefoon zie je één kolom tegelijk.
- **Zoeken:** **Ctrl+K** (op je telefoon **Meer › Zoeken**) vindt taken op hun woorden ("offerte jansen" vindt
  "Offerte voor Jansen afmaken"); een klik opent de taak op het bord.
- **Kosten vooraf** staat bij een taak van je eigen bot als het werk geld kost of veel van je limiet vraagt
  (hoofdstuk 4), met **Start na de reset om …**.

De bot ziet een wijziging de volgende keer dat hij de taken bekijkt; moet het meteen, zeg het dan in zijn chat.

Onder de titel van **Taken** staat een rij links naar **Teamwerk**: altijd het **Logboek** van de wijzigingen van je
bots, en met **Geavanceerd tonen** ook **Beslissingen**, **Gebeurtenissen**, **Experimenten** en **Tabellen**. Bij
**Tabellen** zet **CSV of Excel importeren** een spreadsheet in een tabel van de teamdatabase (de eerste rij geeft de
kolomnamen); **Ongedaan maken** haalt precies die rijen weer weg. Een bot kan dat ook met een bestand uit zijn map.

**Werk dat echt af is:** elke taak krijgt een **Klaar als**; de bot stelt het voor, jij kunt het aanpassen. Vóór elke
"klaar" kijkt een tweede, frisse blik het werk na en hangt het bewijs aan de taak (bestand, link, verstuurd bericht of
schermafbeelding). Zonder bewijs komt een taak op **Te controleren**, niet op **Klaar**.

Is het model voor die controle aan zijn limiet (bijvoorbeeld de gratis daglimiet van OpenCode), dan controleert het
volgende model uit de keten het meteen, en staat erbij welk. Is er niets vrij, dan blijft de taak op **Te controleren**
met "Nog niet gecontroleerd: … TeamBot controleert het vanzelf opnieuw rond 01:00." Na de reset gebeurt dat ook, en gaat
de taak vanzelf naar **Klaar** als het klopt. Keur je hem eerder zelf goed, dan telt dat.

Eén bot claimt een taak, dus er is geen dubbel werk. Doet een bot drie keer dezelfde stap zonder vooruitgang, dan
stopt hij en vraagt hij hulp. Kan iets niet, dan zegt hij dat; hij verzint geen resultaat. Zeg je "nee, zo doen we dat
niet", dan onthoudt die bot dat als les, zichtbaar in **Geheugen**, met ongedaan maken.

Zet je in het venster van een taak op het bord **Belangrijk** aan, dan pauzeert de bot die eraan werkt liever dan op
een zwakker model door te gaan (hoofdstuk 5).

## 11. Groepen en organisatie

In een groep praten meerdere bots samen. Groepen staan onder **Instellingen › Geavanceerd › Groepen**, met **Takenbord**,
**Organisatie** en **Nieuwe groep** (en **Grenzen** met **Geavanceerd tonen**). Klik op **Nieuwe groep** en kies:

- **Zelf samenstellen**: een **Naam**, de **Bots in deze groep** en **Hoe werken ze samen?** (**Lead**, **Om de
  beurt**, **Iedereen** of **Alleen op vermelding**). Klik op **Groep maken**.
- **Uit een sjabloon**: een groep met nieuwe bots, zoals **Klantenservice**. Klik op **Team maken**.
- **Team importeren**: een `.teambot-team.json` met **Teampakket kiezen**; je ziet eerst wat er binnenkomt.

Een sjabloon of pakket neemt nooit gesprekken, geheugen, sleutels of werkmappen mee; bots beginnen op **Vraagt
toestemming** en routines staan uit.

In een groep spreek je een bot aan met **@**. **Groepsinstellingen** heeft **Algemeen** (werkwijze, **Lead-bot**,
**Groepsinstructies**, **Kostenplafond (USD)**), **Bots**, **Bestanden**, **Mensen** (servermodus) en **Kosten**, plus
**Exporteren als team** en **Hele groep stoppen**.

**Organisatie** zet je bots in afdelingen, met een **Chief of staff**, functies en wie aan wie rapporteert. Klik op
**Eerste afdeling maken** (later **Nieuwe afdeling**), vul **Naam** en **Waar deze afdeling voor is** in (met **Valt
onder** zet je hem onder een andere afdeling), kies de leden en klik op **Afdeling maken**. In de groepsinstellingen
kies je bij **Hoort bij afdeling** welk organigram de bots van een groep meekrijgen.

Een bot kan een andere bot iets vragen zonder te wachten; dat zie je onder **Overleg tussen bots**. Onder **Grenzen**
stel je in hoe lang zo'n keten mag zijn en wat hij mag kosten. Bots praten nooit eindeloos door.

Een groep hoort bij één team: de bots van een ander team kun je er niet zomaar bij zetten.

## 12. Geheugen en dossiers

**Geheugen** staat onder **Instellingen › Geavanceerd › Bots en teams** (op je telefoon onder **Meer**), en in een
gesprek in het **Zijpaneel** onder **Geheugen**.

- **Onthouden:** zeg "onthoud dat …", of typ het op **Geheugen** bij **Snel vastleggen** (kies **Over jou** of
  **Gedeeld met al je bots**) en klik op **Onthouden**.
- **Vanzelf leren:** wat je zelf zegt ("ik woon in …") onthoudt TeamBot zodra het gesprek even stil is. Je ziet het
  onder **Recent geleerd**, met een knop om het terug te draaien.
- **"Ja, doe maar":** vraagt een bot "Zal ik onthouden dat je hond Bram heet?" en zeg je "ja", dan onthoudt TeamBot
  het in jouw woorden, met **Ongedaan maken** onder je antwoord. Een vaag voorstel slaat niets op.
- **Bekijken:** de tabbladen **Overzicht**, **Over jou**, **Bots**, **Dossiers**, **Gedeeld**, **Te beoordelen**,
  **Geschiedenis** en **Opslag**. Voorstellen van bots, en wat botst met wat er al staat, komen bij **Te beoordelen**.
- **Zoeken:** typ bij **Wat weet je over…** een onderwerp. Een antwoord uit het geheugen heeft **Bronnen** eronder.
- **Vergeten** wist echt, ook uit de zoekindex, en blijft gelden als je later een back-up terugzet. Elke nacht ruimt
  TeamBot dubbele en verlopen dingen op (terug te draaien); **Nu onderhoud uitvoeren** doet het meteen.

**Zoeken op betekenis:** TeamBot vindt ook wat in andere woorden staat ("wagen" vindt "auto"), met een klein model in
Ollama op je eigen pc. Ga naar **Geheugen › Opslag › Zoeken op betekenis** en klik zo nodig op **bge-m3 downloaden**
(ongeveer 1,2 GB, één keer). Daarna blijft alles op je pc. Zonder Ollama zoekt TeamBot op woorden.

**Vaste regels:** klik bij een instructie op **Vastzetten (altijd laden)**; hij krijgt het label **Vaste regel**,
bijvoorbeeld "Vraag altijd eerst voordat je iets verwijdert". Zo'n regel gaat elke beurt mee en valt nooit weg, ook
niet als een lang gesprek wordt samengevat. Is het geheugen vol, dan krijg je **Geheugen vol** en zegt een bot eerlijk
dat hij niets meer kan onthouden; ruim op onder **Opslag**.

### Dossiers

Een dossier bundelt alles over een project, klant of onderwerp: samenvatting, tijdlijn, besluiten, acties, personen
en bronnen. Ga naar **Geheugen › Dossiers**, klik op **Nieuw dossier** en kies bij **Welke bots mogen dit dossier
gebruiken?** de bots. Voeg bij **Bronnen** iets toe met **Bestand toevoegen (pdf, Office, foto of tekst)** of **Link
toevoegen**: pdf's, Word-, Excel- en PowerPoint-bestanden worden doorzoekbaar en een bot citeert eruit, met het
paginanummer erbij. Een scan of foto van een brief wordt doorzoekbaar zodra **Scans en foto's lezen** aanstaat
(hoofdstuk 17). Met **Geavanceerd tonen** koppel je
een dossier aan een gesprek via **Zijpaneel › Geheugen › Gekoppeld dossier**.

Per bot kies je onder **Geavanceerd › Geheugen** bij **Leren** **Standaard**, **Automatisch leren**, **Alleen op
verzoek (“onthoud dit”)** of **Uit**.

Het geheugen is per team: bots lezen wat bij hun thuisteam hoort (en bij teams waar ze mogen meekijken) en schrijven
alleen in hun thuisteam. Vergeten geldt voor alle teams.

### Geheugen per klant

Praat een bot met klanten op een kanaal (WhatsApp, Telegram, e-mail en meer, hoofdstuk 19), dan krijgt elke klant een
eigen dossier, bijvoorbeeld **Klant Kim**. TeamBot herkent de klant aan zijn afzender, alleen in een privégesprek, en
bij e-mail alleen als de afzender echt klopt. In een gesprek met Kim kent de bot alleen Kim: zijn gegevens, zijn open
acties en zijn vorige gesprekken. Een andere klant, jouw eigen notities of gedeelde kennis ziet hij daar nooit.

- De bot onthoudt wat de klant over zichzelf zegt (naam, adres, bestelling, hoe hij bereikt wil worden), met het
  citaat erbij. Nooit prijzen, beloftes of beleid: dat moet in je goedgekeurde kennis staan, en geld wacht op jou.
- Een nieuw adres vervangt het oude (het oude blijft in de geschiedenis). Zegt de klant iets wat botst met wat jij
  vastlegde, dan komt het bij **Te beoordelen**.
- Je ziet het dossier onder **Geheugen › Dossiers**, met wat de bot over de klant weet en hoe hij herkend is.
  Dezelfde klant op WhatsApp en per e-mail koppel je zelf aan één dossier. **Vergeten** wist de klant helemaal.
- Gesprekken met een klant gaan na 45 dagen zonder contact naar het archief; ze blijven bewaard.

## 13. Specialisten

Een bot kan specialist worden in een vakgebied, zoals SEO, belastingen of een programmeertaal, en wordt daar vanzelf
beter in. Zet in de bot-instellingen onder **Geavanceerd › Specialisme** **Specialist in een vakgebied** aan en vul het
**Vakgebied** (één zin) en de **Bronnen** in: een website, feed, documentatie of eigen bestand.

Met **Leerronde aan** (**Elke ochtend** of **Elke maandagochtend**) haalt de bot nieuwe inhoud op en slaat hij de kern op
in zijn kennisbank (**Kennisbank openen**; alle staan onder **Kennisbanken**, met **Geavanceerd tonen**), met bron en datum. Dubbele
dingen slaat hij over; wat tegenspreekt wat hij al weet, komt bij **Te controleren**. De leerronde staat uit tot jij hem
aanzet, en draait op een gratis model als dat er is, anders op de eigen engine van de bot binnen je dagbudget; bij
**Leert met:** zie je welke.

Bronnen zijn gegevens, nooit opdrachten: een "instructie" in een webpagina wordt niet uitgevoerd. Waar de bot "weet
ik niet" zei, ontstaat een leerdoel. Je krijgt een leerverslag met bronnen, en alles is terug te draaien. Werkt iets
vaak goed, dan stelt de specialist een skill voor; die komt er pas na jouw akkoord.

## 14. Routines

1. Ga naar **Taken › Routines** en klik op **Nieuwe routine**.
2. Vul **Naam**, **Bot** en **Opdracht** in. Een routine heeft hooguit de rechten van de bot.
3. Kies bij **Wanneer** bijvoorbeeld **Op vaste dagen en tijden**, **Steeds na een vaste tijd (interval)**,
   **Eenmalig** of **Geen schema (alleen handmatig of via trigger)**. Je ziet meteen de eerstvolgende runs.
4. Klik op **Routine aanmaken**. Kost een run geld of veel van je limiet, dan zie je eerst **Kosten vooraf**.

Verder kies je onder meer: **Gemiste runs** (**Eén keer inhalen bij opstarten** of **Overslaan (wel zichtbaar in de
historie)**), of hij **In een eigen routinegesprek** draait (bij de bot onder **Automatische runs**) of **In de
hoofdchat van de bot**, wat hij doet **Als de limiet van de AI-engine is bereikt**, **Daarna starten** (een keten),
**Melding sturen** en **Resultaat ook sturen naar** (bijvoorbeeld WhatsApp).

Een routine heeft **Nu testen**, **Pauzeren**, **Dupliceren** en de tabbladen **Historie** (met een bonnetje per run),
**Triggers** en **Instellingen**. Met **Triggers › Trigger toevoegen** start hij bij een **Webhook**, een
**RSS/Atom-feed**, een **Webpagina-wijziging**, een **Map in de werkmap**, een **E-mail** of een **Chat-bericht**. Wat
binnenkomt, is voor de bot gegevens, nooit een opdracht.

Vanuit een chat kan het ook: "Herinner me elke maandag om 9 uur aan de container" geeft een voorstel dat jij goedkeurt.
"Laat me weten als er een pdf binnenkomt" zet een **Wachtpunt**; met **Niet meer wachten** stop je het. **Kalender**
toont per week of maand wat gepland staat en wat er gebeurde. **Limieten** heeft de noodrem **Alle routines
pauzeren**.

> **Goed om te weten:** routines draaien alleen als TeamBot draait en de pc wakker is. Zet daarvoor onder
> **Instellingen › Algemeen › Pc en routines** **Houd de pc wakker terwijl routines of taken lopen** aan.

**Controle vooraf.** Vlak voordat een routine start, kijkt TeamBot of de koppelingen die hij nodig heeft nog werken:
het kanaal waar het resultaat heen gaat, en de apps van de bot (een login die verlopen is). Werkt er iets niet, dan
start de bot niet. De run krijgt **Kon niet: koppeling verlopen**, op het bonnetje staat wat er mis is met **Repareren**
erbij, en je krijgt meteen één melding. Zo kost een kapotte koppeling geen tokens. Een wachtwoord in de kluis verloopt
niet, dus dat wordt niet gecontroleerd.

Een run is pas geslaagd met een resultaat, zoals een bericht of bestand; het bewijs staat op het bonnetje. TeamBot
meldt ook wat níet gebeurde ("verwacht om 08:00, niet gedraaid"), en toont wat er niet kon draaien onder **Gemist
terwijl je pc uit stond**.

Ook een routine kan de schakelaar **Belangrijk** krijgen (hoofdstuk 5).

## 15. Skills en apps

**Marktplaats** staat in de zijbalk. Hij opent op **Aanbevolen voor je bots**: per bot een paar skills en apps die
passen bij wat hij doet. Daaronder staan de onderwerpen als tegels (zoals **Marketing en SEO** en **Klantenservice en
verkoop**) en één zoekvak. Elke kaart heeft één knop **Toevoegen**; daarna kies je **Voor wie?**: het hele team of één
bot. **Gecontroleerd** betekent dat licentie, inhoud en maker zijn nagekeken (details achter het **(i)**-teken).

De tabbladen zijn **Skills** (werkwijzen voor je bots), **Apps** en **Bots** (sjablonen); **Bronnen** en **Meldingen**
zie je met **Geavanceerd tonen**. Je ziet maker, licentie en datum, en leest een skill voordat je hem installeert. Per bot zet je skills
aan onder **Geavanceerd › Skills**; een bot laadt een skill pas als een taak erom vraagt. Een eigen skill voeg je toe
via **Marktplaats › Mijn skills › Importeren** (**Plakken**, **Zip-bestand**, **URL / GitHub** of **Op deze
computer**); **Voorvertoning** toont eerst wat erin zit, met een veiligheidscontrole.

Skills komen uit een eigen catalogus van TeamBot (**Marktplaats › Skills**, tabblad **Catalogus**), op vastgezette
versies, met licentie en versie in beeld. Niets is vooraf geïnstalleerd. Met **Controleer op nieuwe versies** en
**Nieuwe versie: bekijk verschil** zie je een update eerst als verschil; er verandert niets tot jij op **Bijwerken**
klikt. Komt er met een TeamBot-update een nieuwere versie van een skill die je hebt, dan zie je dat vanzelf bovenaan
**Mijn skills** en op de skill zelf: de datum, wat er veranderde en welke bestanden anders zijn. Klik op **Bekijk wat
er verandert** en daarna op **Bijwerken** als je hem wilt. Een skill met scripts draait pas als jij hem vertrouwt (**Scripts vertrouwen**) en elke run goedkeurt; het script
draait in de werkmap van de bot, zonder je sleutels (dat is geen volledige afscherming). Een skill geldt voor al je
teams; per bot zet je hem aan.

**Skills testen.** Open een skill onder **Marktplaats › Mijn skills** en kies het tabblad **Testen**. Zet er 3 tot 5
vragen in die de skill goed moet kunnen, elk met **Klaar als** (wanneer het antwoord goed is), en klik op
**Testvragen bewaren**. Kies bij **Test draaien** de versie en de bot, en klik op **Testvragen draaien**. Vooraf zie je
wat het ongeveer kost (een schatting). Per vraag zie je **Goed**, **Twijfel** of **Fout**, met de reden en het antwoord
van de bot. In **Nieuwe versie: bekijk verschil** staat ook **Test eerst deze versie**; bijwerken blijft je eigen klik.

**Een skill van een document.** Heb je een werkinstructie of handleiding als bron in een dossier, klik dan bij die bron
op **Maak een skill**. De bot schrijft een concept; jij leest het na, kiest de bot en klikt op **Opslaan als skill**.

### Apps koppelen

1. Ga naar **Instellingen › Geavanceerd › Apps**.
2. Kies **Kies uit de catalogus**, een **Eigen server**, of **Overnemen uit Claude, Codex of Cursor**.
3. Doorloop **Bekijken**, **Instellen**, een **Leestest** (de app leest alleen) en **Acties**.
4. Kies per bot welke apps hij mag gebruiken (**Geavanceerd › Apps**).

Voor Gmail, Google Drive, Agenda en Sheets maak je zelf een Google-OAuth-client; de wizard legt uit hoe. Onder
**TeamBot als server** geef je een ander programma, zoals Claude Desktop, toegang tot je bots. Wat geïnstalleerd mag
worden, bepaal je onder **Instellingen › Geavanceerd › Uitgevers en beleid** (met **Geavanceerd tonen**).

## 16. Browser en computer use

Kies per bot onder **Geavanceerd › Computer & bestanden** het minste dat nodig is: **Geen computer**, **Alleen
werkmap**, **Eigen browser** (een eigen profiel per bot, nooit het jouwe), **Mijn bureaublad**, **Privé-container /
VM** (met Docker Desktop) of **Eigen server (SSH)**. **Instellingen › Geavanceerd › Computers** toont wat je pc kan en waar
elke bot werkt; TeamBot valt nooit stilletjes terug op je eigen pc.

**De browser van een bot** draait onzichtbaar in TeamBot zelf: elke bot heeft eigen tabbladen, je hebt geen Edge of
Chrome nodig en er springt niets in beeld. Wil je toch Edge of Chrome, kies dat dan onder **Instellingen › Geavanceerd ›
Computers › Browser van de bots**.

Kijk mee met **Live** (bij de bot op **Computers**), met **Nu bezig** of met **Computer van de bot** in het gesprek. Met **Neem over** doe je het zelf (bijvoorbeeld
inloggen); met **Geef terug aan bot** gaat hij verder.

**Je eigen bureaublad** staat standaard uit. Kies **Mijn bureaublad**, vul bij **Toegestane apps** de programma's in
(bijvoorbeeld `notepad, excel`), klik op **Bureaubladbediening aanzetten…**, vink **Ik begrijp wat dit betekent** aan,
kies het **Toegangsniveau** (standaard **Vraag bij elke actie**) en klik op **Opslaan**. Wachtwoordvelden,
inlogvensters, wachtwoordmanagers, bank- en betaalpagina's en TeamBot zelf blijven altijd geblokkeerd. Beweeg je de
muis, dan pauzeert de bot.

> **Noodstop: Ctrl+Alt+Esc.** Of **Noodstop bureaublad** in het systeemvak, **Alles stoppen** in de app, of je
> telefoon.

**Kluis:** onder **Computers › Kluis** bewaar je logins voor sites waar bots moeten inloggen. Een bot ziet het
wachtwoord nooit; TeamBot vraagt jou eerst en vult het alleen in op het adres dat je opgaf. Klik op **Login
toevoegen** of **Importeren uit een wachtwoordbeheerder**. Een login kan voor alle teams zijn of voor één team.

**Eigen server en cloud-VM:** met **Eigen server (SSH)** werkt een bot op je eigen Linux- of macOS-server. Een
cloud-VM (Hetzner of DigitalOcean) maak je via **Eigen server (SSH) › Cloud-VM**; je ziet de prijs vooraf, en hij kost
geld tot je hem verwijdert.

> **Nog niet live getest:** de echte proef met muis en toetsenbord op een bureaublad, en een eigen server of cloud-VM
> met een echt account.

## 17. Bestanden, teammap en websites

Elke bot heeft een eigen **werkplek**: een eigen map in de teammap van zijn team (bijvoorbeeld *Teammap\Mila*), of
zonder teammap in de datamap van TeamBot. Op de pagina van de bot staat **Werkplek:** met de map en **Openen**. Daar
staan zijn bestanden, zijn terminal en zijn downloads. Wil de bot iets buiten zijn mappen doen, ook met een
terminalopdracht, dan vraagt hij eerst. De werkplek van een collega-bot mag hij alleen lezen. Een andere map kies je
onder **Geavanceerd › Werkmap en mappen**. Met **Map toevoegen** geef je extra mappen, **Alleen lezen** of **Lezen en schrijven**. Een werkmap is geen
afgeschermde omgeving: kies een map zonder gevoelige bestanden. Mappen met sleutels blijven altijd dicht.

De **teammap** is de map die de bots van een team samen gebruiken. Ga naar **Instellingen › Geavanceerd › Bestanden ›
Teammap** (heb je meer
teams, kies dan eerst het **Team**), vul de **Map** en een **Naam voor de bots** in, kies de **Rechten** en of **Alle
bots (ook nieuwe)** erbij mogen, en klik op **Opslaan**. Bots van andere teams lezen hem alleen als ze mogen
meekijken of aansturen. **Instellingen › Geavanceerd › Bestanden** toont de teammappen en werkmappen, zodat je meekijkt.

**Scans en foto's lezen.** Bots lezen een gescande pdf of een foto van een brief met tekstherkenning (OCR), op je eigen
computer. Daarvoor is eenmalig taaldata nodig voor Nederlands en Engels (± 10 MB): klik onder **Bestanden** bij **Scans en foto's lezen** op **Taaldata downloaden**. TeamBot downloadt pas als jij klikt en
controleert elk bestand. Daarna leest een bot tot 20 gescande pagina's per keer; hij zegt erbij dat de tekst van een
scan komt, dus controleer namen en getallen. **Verwijderen** haalt de taaldata weer weg.

**Zoeken in bestanden** gaat met ripgrep, in een eigen proces: ook een grote map houdt TeamBot niet op, en na 15
seconden stopt het zoeken met wat er tot dan gevonden is.

### Eerst oefenen: de repetitie

1. Open het **Zijpaneel**, kies **Wijzigingen** en klik bij **Repetitie** op **Start**. De bot werkt nu in een kopie.
2. Geef je opdracht en klik op een gewijzigd bestand: je ziet **Je echte map** en **Wat de bot maakte** naast elkaar.
3. Kies per bestand **Dit bestand toepassen** of **Verwerpen** (of **Alles toepassen**) en klik op **Afronden**.

Vóór het toepassen maakt TeamBot vanzelf een snapshot; met **Maak snapshot** maak je er zelf een. Een verplaatst
bestand is één wijziging (oud → nieuw), dus je raakt nooit een bestand kwijt.

Wist of overschrijft een bot met de bestandstools van TeamBot een bestand, dan gaat de oude versie naar de
**Prullenbak** (de knop op **Bestanden**), 30 dagen lang. Terughalen gaat met
**Terugzetten**; op het **Run-bonnetje** van een routine zet **Alles terugzetten** alles van die run terug. Wat een
CLI-engine als Claude Code of Codex zelf in een map schrijft, gaat buiten de prullenbak om: gebruik daarvoor de
repetitie.

**Websites:** vraag een bot om een kleine website ("publiceer ons weekmenu op mijn netwerk"); je geeft eerst
toestemming. **Instellingen › Geavanceerd › Websites** toont de sites. Ze zijn alleen te openen op deze computer, je eigen netwerk of
via Tailscale, en alleen met de link.

## 18. Spraak

Spraak werkt gratis op je eigen computer. Download de eerste keer onder **Instellingen › Geavanceerd › Spraak** de
spraakherkenning (670 MB) en een voorleesstem (ongeveer 90 MB). Je stem gaat dan niet naar internet.

- **Dicteren:** klik op de microfoon in het invoerveld of houd **Ctrl+Spatie** ingedrukt.
- **Dicteren in elk programma** (desktop-app): zet **Sneltoets aan** onder **Dicteren in elk programma (sneltoets)** en
  houd in elk programma **Ctrl+Alt+Spatie** ingedrukt. De tekst komt niet in je klembordgeschiedenis.
- **Voorlezen:** **Voorlezen** onder een antwoord. Een eigen stem per bot kies je onder **Geavanceerd › Spraak**.
- **Spraakberichten** uit WhatsApp en Telegram worden op je pc tekst.

**Bellen met een bot:** klik in een gesprek met één bot op het telefoontje (**Live praten**). In het venster **Praten
met …** kies je het **Soort gesprek**:

- **Live met OpenAI** (je eigen API-sleutel, betaald) of **Live met Gemini (Google)** (een Google AI Studio-sleutel,
  gratis aan te maken). Hier kies je ook de **Modus**: **Bot bedienen** (de stem praat, je bot doet het werk erachter)
  of **Direct praten**, en of het **Transcript bewaren in dit gesprek** gebeurt.
- **Live gesprek, gratis (op je eigen pc)**: je praat door elkaar heen, zoals aan de telefoon.
- **Gratis gesprek, om de beurt (op je eigen pc)**: eerst jij, dan de bot (alleen als het werkt).

Klik op **Start live gesprek**, of op **Klaarmaken en bellen** als er nog iets nodig is (je sleutel plakken, of de
spraak en de **gesprekshulp** van 35 MB downloaden, gratis, met grootte en licentie in beeld). Ophangen doe je met
**Ophangen**; de bot hangt ook zelf op als je gedag zegt (nooit vlak na "wacht", en niet terwijl hij nog iets voor je
doet). Welke soort standaard is, kies je onder **Spraak › Gesprekken (telefoonknop in een chat) › Standaard**. Alles van
het gratis gesprek blijft op je computer. In een groep klik je op **Groepsgesprek (spraak)**. **Spraakgesprekken**
(met **Geavanceerd tonen**) toont eerdere gesprekken met transcript; **Vergadernotities** schrijft een vergadering uit
en laat een bot de notulen maken.

Op de pc houd je standaard een knop of de spatiebalk ingedrukt om te praten (**Automatisch (pc: ingedrukt houden,
telefoon: handsfree)**; of kies **Ingedrukt houden om te praten**), met echo-onderdrukking. Je ziet steeds welke bot
luistert en welke spreekt, ook in een groepsgesprek. In een **Gratis gesprek** gebruikt een bot hetzelfde model als in
tekst. Bij **Live** praat een spraakmodel van OpenAI of Google, en je bot doet het werk erachter: je kunt gewoon
doorpraten terwijl hij bezig is, en de stem vertelt het resultaat zodra het er is. Vraagt de bot toestemming, zeg dan
duidelijk **ja** of **nee** (een ja geldt één keer). In de chat staat daarna een verslag: wie ophing, een korte
samenvatting en wat de bot deed. Op de pc loopt een gesprek door als je het venster verbergt; op de telefoon zolang de
app open is.

## 19. Kanalen: WhatsApp, Telegram en meer

1. Ga naar **Instellingen › Geavanceerd › Kanalen** en klik op **Kanaal toevoegen**.
2. Kies **WhatsApp (QR-code)**, **Telegram**, **Discord**, **Slack**, **E-mail**, **WhatsApp Business (Cloud API)** of
   **Webhook**. TeamBot legt de stappen uit.
3. Kies bij **Wie antwoordt?** een bot of een groep.

Alleen afzenders die jij toestaat, komen binnen. Andere afzenders krijgen geen tools en een eerlijk antwoord. Voor
elk bericht aan iemand anders vraagt de bot eerst jouw toestemming.

**WhatsApp:** kies **WhatsApp (QR-code)** en klik op **Opslaan en verbinden**. Ga op je telefoon in WhatsApp naar
*Gekoppelde apparaten* › *Apparaat koppelen* en scan de code. Stuur daarna in *Bericht aan jezelf* een bericht; begin
met `@Baas` om een andere bot te kiezen. In elke chat-app werken `/nieuw`, `/stop`, `/bots` en `/help`. Met
**Geavanceerd › Kanalen › Mag zelf berichten en bestanden sturen** mag een bot je zelf iets sturen, zoals een
pdf-rapport.

> **Goed om te weten:** WhatsApp via QR is onofficieel, met een kleine kans op een blokkade. Gebruik voor je bedrijf
> liefst **WhatsApp Business (Cloud API)**.

> **Nog niet live getest:** WhatsApp, Telegram, Discord, Slack, e-mail en WhatsApp Business met een echt account.

**Telegram** is de makkelijke standaard: een eigen bot, zonder open poort. Bij WhatsApp via QR bevestig je eerst de
waarschuwing. Een kanaal heet pas **Verbonden** als TeamBot echt een bericht heeft ontvangen en verstuurd.

Praat een bot via een kanaal met klanten, zet dan bij dat kanaal **Klantenservice: deze bot praat met klanten** aan.
Dan zegt hij dat hij AI is (**AI-label**), zet hij bij twijfel door naar jou (**Doorzetten naar mij**) en verzint hij
nooit beleid. Alles over geld, prijzen, terugbetalingen en beloftes wacht op jouw goedkeuring (**Goedkeuren bij geld en
beloftes**), en elk antwoord staat bij **Verstuurd aan klanten**.

## 20. Je telefoon

**Koppelen met de iPhone-app.** Je hebt geen Tailscale, account of instellingen in je router nodig.

1. Zet de app **TeamBot** op je iPhone. Staat bij stap 1 van **Telefoon koppelen** de knop **iPhone-app downloaden**,
   gebruik die. Staat er dat de app nog niet openbaar is, dan krijg je hem alleen met een uitnodiging voor TestFlight;
   zonder app gebruik je de browser (zie **Andere manieren** hieronder).
2. Ga op je computer naar **Instellingen › Telefoon**. Bij **Telefoon koppelen** staat de QR-code er meteen.
3. Open de app op je iPhone, tik op **Scan de QR-code op je computer** en richt de camera op de code. Bij stap 3 staat
   meteen **Verbonden**. Klaar.

De code is 5 minuten geldig en vernieuwt zichzelf zolang de pagina openstaat. Heb je al een telefoon gekoppeld, klik
dan op **Nog een telefoon koppelen**. Je telefoon opent op **Wacht op jou** als er iets op je wacht, anders op je
chats.

Je iPhone verbindt nu thuis en onderweg. Alles is versleuteld van je iPhone tot je computer. Lukt een directe
verbinding niet, dan loopt het verkeer via een relay-server, die alleen versleutelde gegevens ziet. De app zegt hoe hij
verbonden is (tandwiel › **Verbinding**). Uitzetten doe je op je computer: **Instellingen › Meer mogelijkheden ›
Telefoonverbinding › Meer opties › Bereikbaarheid › TeamBot-verbinding**. Standaard gebruikt TeamBot de gratis relay-servers van n0, bedoeld om te testen; een **Eigen
relay-server** stel je daar in met **Geavanceerd tonen** (uitleg in `docs/modules/mobile.md`).

**Andere manieren** (voor de browser en Android; er is nog geen Android-app) staan onder **Instellingen › Meer
mogelijkheden › Telefoonverbinding › Meer opties**. Met **Tailscale** werkt het ook
onderweg: zet Tailscale (gratis) op je computer en je telefoon met hetzelfde account en klik op **Telefoon via
Tailscale instellen**; de QR-code bevat je Tailscale-adres dan vanzelf (klik op **Nieuwe QR-code** als hij er al
stond). **Zelfde wifi** werkt alleen thuis, is
niet versleuteld en geeft geen pushmeldingen in de browser. Scan de code met de camera, open TeamBot, kies **Koppelen**
en zet hem op je beginscherm (iPhone: Safari *Deel* › *Zet op beginscherm*; Android: Chrome *⋮* › *App installeren*).

**Bureaublad op afstand.** Op **Instellingen › Meer mogelijkheden › Telefoonverbinding** staat **Bureaublad op afstand** (alleen Windows): je
kijkt vanaf je telefoon mee op je computer, en als je dat toestaat bedien je hem ook. Aanzetten kan alleen op de computer
zelf: **Bureaublad op afstand toestaan** (bevestigen met **Aanzetten**), eventueel **Ook bedienen met muis en
toetsenbord (anders alleen meekijken)**, en **Stopt vanzelf** na een tijd die je kiest. Op je telefoon tik je op
**Bureaublad openen**; **Uitzetten** kan op beide. Onder **Wie kijkt er mee** zie je wie er verbonden is.

Op je telefoon kun je bijna alles wat op je computer kan: chatten, bellen, goedkeuren, bots maken, AI koppelen, taken,
routines, teams en instellingen. Alleen beheer, opgeslagen sleutels bekijken, alles exporteren, de kluis, nieuwe
apparaten koppelen, inlogsessies, de TeamBot-verbinding of het bureaublad op afstand aanzetten, iemand eigenaar van een
kanaal maken, een eigen regel die een bot meer laat doen en **Altijd toestaan** doe je op je computer; de telefoon zegt
dat dan rustig. Je telefoon krijgt geen sleutels; je trekt hem in onder **Gekoppelde telefoons**. Is je computer niet
bereikbaar, dan bewaart je telefoon wat je typt (**Telefoon › Concepten**). Een pincode of vingerafdruk zet je onder
**Instellingen › Beveiliging › Vergrendeling instellen**.

> **Nog niet live getest:** de TeamBot-verbinding op een echte iPhone (op de computer getest met een testtelefoon,
> ook via een relay), bureaublad op afstand met een echte muis en toetsenbord, en de microfoon en pushmeldingen op een
> echte iPhone.

## 21. Meldingen en statusvenster

- **De bel** toont je laatste meldingen (**Alles**, **Ongelezen**, **Belangrijk**), met **Alle meldingen** en **Per bot
  instellen**.
- **Instellingen › Meldingen**: **Geluid bij een melding**, **Meldingen zonder bot** (limieten, apps, kanalen) en per
  bot **Alles**, **Alleen belangrijk** of **Niets**. Vragen blijven altijd in **Wacht op jou**.
- **Pushmeldingen** op je telefoon: op je telefoon **Instellingen › Telefoon › Pushmeldingen**, **Meldingen op dit
  apparaat** en **Testmelding**.
- **Waar komt een melding?** Zit je achter de pc, dan krijg je alleen een Windows-melding. Doe je 3 minuten niets, of
  zet je het scherm op slot, dan gaat hij naar je telefoon. Een goedkeuring die binnenkwam terwijl je achter de pc zat
  en die nog wacht, gaat naar je telefoon zodra je wegloopt. Wil je alles op beide, zet dan onder **Instellingen ›
  Telefoon › Meldingen op je telefoon** **Altijd ook op de telefoon** aan. Dit werkt als de TeamBot-app op de pc draait; zonder de app gaat het zoals
  vroeger (vragen en goedkeuringen altijd naar je telefoon, de rest als TeamBot niet open staat).

Een melding keurt nooit iets goed. Bij een Windows-melding over een actie met gevolgen staan alleen **Bekijken** en
**Weigeren**.

Heb je een vraag of goedkeuring al ergens anders afgehandeld, bijvoorbeeld op je computer, dan verdwijnt de melding
ervan vanzelf: in Windows, in je browser en op je telefoon. Op een iPhone of iPad gebeurt dat zodra je TeamBot opent.

Het **zwevende statusvenster** (desktop-app) blijft boven alles en toont welke bots werken en wat op jou wacht, met
**Goedkeuren**, **Weigeren** en een stopknop. Zet het aan via het systeemvak of onder **Instellingen › Gebruik en
limieten › Zwevend statusvenster**. In de browser en op je telefoon toont **Nu bezig** (bovenaan **Taken**) hetzelfde (hoofdstuk 10). **Alles
stoppen** staat in de zijbalk zodra er iets loopt, en op je telefoon bovenaan **Meer**.

## 22. Back-ups en updates

### Back-ups

Ga naar **Instellingen › Back-ups** (groep **Gegevens en privacy**):

- **Back-up maken:** bots, gesprekken, geheugen, routines, instellingen, de teamdatabase, bijlagen, skills en
  websites. Zet **Ook de werkmappen van bots en de bestanden van groepen** aan als die mee moeten, en klik op **Nu een
  back-up maken**. Je ziet vooraf hoe groot hij wordt.
- **Automatisch:** **Elke dag automatisch een back-up maken** staat aan; bij **Bewaar de laatste** kies je hoeveel
  (standaard 7). Zelf gemaakte back-ups ruimt TeamBot nooit op.
- **Je back-ups:** per back-up **Terugzetten**, downloaden en verwijderen.
- **Wat zit erin, en wat niet:** programma's, spraakmodellen, browserprofielen en mappen buiten TeamBot (zoals een
  eigen projectmap) zitten er niet in.

- **Kopie op een tweede plek:** zodat een kapotte schijf je back-ups niet meeneemt. Vul bij **Map voor de kopieën**
  een map op een USB-schijf, NAS of andere schijf in (bijvoorbeeld `E:\Back-ups`), kies een **Wachtwoord** van
  minstens 12 tekens, herhaal het en klik op **Opslaan**. Daarna zet TeamBot na elke back-up een versleutelde kopie in
  die map (**Na elke back-up ook een versleutelde kopie maken**), of klik je op **Nu een kopie maken**. Zonder je
  wachtwoord kan niemand de kopie openen, ook TeamBot niet: bewaar het goed. Is de schijf niet aangesloten, dan zegt
  de kaart dat; de gewone back-up gaat gewoon door.

**Terugzetten:** klik op **Terugzetten** en bevestig; TeamBot start opnieuw. De huidige stand wordt eerst als
veiligheidskopie bewaard, dus er gaat niets verloren. Wat je hebt vergeten of gewist, blijft vergeten. Van een kopie
op de tweede plek: klik bij **Kopieën op de tweede plek** op **Terugzetten**, typ het wachtwoord en klik op
**Openen**; daarna gaat het als hierboven.

> **Goed om te weten:** sleutels werken na terugzetten alleen op deze computer met hetzelfde Windows-account. Elders
> vul je ze opnieuw in.

Op dezelfde pagina staat **Alles exporteren**: alles als één bestand, zonder sleutels. **Diagnosebestand downloaden**
(voor wie je helpt, zonder berichten of sleutels) staat onder **Instellingen › Waar staat mijn data?**.

### Updates van TeamBot

Onder **Instellingen › Back-ups › Updates van TeamBot** (desktop-app): **Nu controleren** en **Nu bijwerken**; bij
**Automatisch bijwerken** kies je **Aan: bijwerken als je even niet bezig bent**, **Alleen melden** of **Uit**. TeamBot
werkt nooit bij tijdens een taak.

- Vóór elke update maakt TeamBot een back-up; lukt die niet, dan installeert het niets.
- Na de update krijg je een melding met **Wat is er nieuw**, in gewone woorden.
- Gaat er iets mis, klik dan op dezelfde plek op **Terug naar versie …**:
  TeamBot zet de back-up van vlak voor de update terug en installeert de vorige versie, die het bewaard heeft.

> **Goed om te weten:** er is nog geen openbare releasepagina. Tot die er is, vindt TeamBot zelf geen updates en
> installeer je een nieuwe versie met de installer. Je data blijft staan.

### Versies van de engines

Claude Code, Codex en OpenCode werken zichzelf soms bij. Bovenaan **Instellingen › Geavanceerd › Abonnementen** staat **Versies van de
engines**: TeamBot meldt een nieuwe versie, test hem kort zelf (zonder prompt, kost geen tegoed; **Nu testen** doet het
meteen) en zegt hoe je terug kunt. Voor de kopie die TeamBot beheert is dat één klik op **Terug naar …**; voor je eigen
CLI krijg je de opdracht om te kopiëren. **Toch blijven gebruiken** zet de waarschuwing stil. TeamBot verandert je
eigen CLI nooit.

## 23. Taal en overige instellingen

- **De app** werkt in 11 talen, ook Arabisch (van rechts naar links): **Instellingen › Algemeen › Taal van de app**.
  Datums, getallen, meldingen en je telefoon volgen die taal.
- **Bots** antwoorden in de taal waarin je schrijft (**Bots antwoorden in**); een vaste taal per bot kies je bij
  **Taal van de antwoorden**.
- **Spraak** kent 25 Europese talen plus Turks en Arabisch. Er is een lokale voorleesstem voor elke app-taal behalve
  Arabisch. Deze handleiding is er alleen in het Nederlands.
- **Instellingen › Uiterlijk**: het thema (**Systeem**, **Licht**, **Donker**; per apparaat), de **Kleur** (Standaard
  of een van tien kleuren, zoals **Lavendel**: voor knoppen, links, de focusrand en het TeamBot-figuurtje; geldt op al
  je apparaten, met een voorbeeld in licht en donker naast elkaar) en de stijl van de figuurtjes (**Glad** of **Vilt**).
- **Instellingen › Algemeen** heeft ook **Standaarden voor nieuwe bots** en **Pc en routines**.
- **Instellingen › Geavanceerd › Zoeken**: bots zoeken op internet direct na de installatie, zonder sleutel.
  **Automatisch** probeert Keenable, dan Parallel, dan je eigen gratis sleutels (**Tavily**, **Exa**, ook **Brave
  Search**), dan DuckDuckGo en als laatste Wikipedia; lukt het ergens niet, dan gaat TeamBot stil door naar de
  volgende. Je kunt ook een dienst als eerste kiezen, of **Alleen mijn eigen SearXNG**. **Pagina’s lezen via Jina als
  het zelf niet lukt** (standaard uit) leest pagina’s die JavaScript opbouwt en gescande pdf’s via Jina Reader; het
  adres gaat dan naar Jina AI. Een gewone pdf leest TeamBot zelf.
- **Netwerk en proxy** (met **Geavanceerd tonen**): **Proxy gebruiken**, het **Adres van de proxy** en **Verbinding
  testen**.
- **Beveiliging:** het **Logboek**, **Ingelogde apparaten en sessies** (met **Intrekken**), **Opgeslagen geheimen**
  (alleen de namen) en de app-vergrendeling.

## 24. Servermodus: TeamBot voor vrienden of een team

Op een eigen server krijgt iedereen een eigen account met eigen bots, gesprekken en sleutels.

1. Start TeamBot met Docker: `docker compose up -d`.
2. Open `http://<server>:4747` en maak bij **Eigenaar-account aanmaken** je account.
3. Zet de server achter https (bijvoorbeeld Caddy, Cloudflare Tunnel of Tailscale) voordat hij op internet komt, en
   vul dat adres in bij `TEAMBOT_PUBLIC_URL` in `docker-compose.yml`.

Onder **Instellingen › Geavanceerd › Gebruikers** nodig je mensen uit (**Uitnodiging maken**, met **Rol** **Lid** of
**Beheerder**), stel je **Regels voor leden** in (dagbudget, aantal bots, terminal en cloud-VM's standaard niet) en zie
je het **Gebruik per persoon**. SSO en SCIM staan in `docs/modules/sso.md`. Leden zien een gedeelde sleutel nooit.

Zet bij een bot **Geavanceerd › Delen met het team › Gedeeld met het team** aan om hem te delen. Leden praten ermee in
hun eigen gesprekken, die jij niet kunt lezen, en de bot onthoudt alleen per persoon.

> **Nog niet live getest:** de Docker-image, SSO met een echte provider en TeamBot Cloud op een echte server.

## 25. Waar staat mijn data?

Open **Instellingen › Privacy en beveiliging** en kies **Waar staat mijn data?**.

- **Op je computer:** bots, gesprekken, geheugen, routines, back-ups en bestanden staan in de datamap, in de
  desktop-app `%APPDATA%\TeamBot` (**Datamap openen** in het systeemvak).
- **Naar een AI-dienst** gaat alleen wat een bot nodig heeft, en alleen naar de dienst die je bij die bot koos. Met
  Ollama blijft alles op je computer. Gratis bronnen hebben een privacylabel (hoofdstuk 5).
- **Sleutels** staan versleuteld en komen nooit in gesprekken, logboeken of exports. Je telefoon krijgt ze niet.
- **Teams** zijn gescheiden: een bot ziet niets van een ander team, tenzij jij hem toegang geeft.
- **Spraak** blijft op je computer, behalve bij **Live (OpenAI Realtime)**.
- **TeamBot stuurt niets naar de makers**: geen statistieken, geen foutrapporten. Afbeeldingen en linkvoorbeelden van
  bots laden pas als je erop klikt.
- Alles met gevolgen staat in het **Logboek** onder **Instellingen › Beveiliging**.

Kanalen, apps, gratis bronnen en telefoontoegang staan uit tot je ze aanzet. Onder **Instellingen › Waar staat mijn data? › Wat
verlaat je pc?** zie je per bot naar welke AI-dienst zijn gesprekken gaan, met een label als **Blijft op je pc**,
**Bewaart niets** of **Kan trainen**, en wat er verder aan staat (zoeken op internet staat standaard aan). Bij **Wie
kan TeamBot bereiken?** waarschuwt TeamBot als iets openstaat wat niet hoeft, zoals telefoontoegang op elk netwerk via
gewone http.

> **Goed om te weten:** verwijder je TeamBot, dan vraagt de installer of je gegevens ook weg moeten. Standaard is het
> antwoord **Nee**. Bij een update vraagt hij het nooit.

## 26. Wat nog niet kan

- De installer is niet ondertekend en er is nog geen openbaar updatekanaal.
- Een bot op je bureaublad deelt je muis en toetsenbord; een eigen bureaublad per bot kan niet op Windows Home.
- WhatsApp via QR is onofficieel en kan even niet werken als WhatsApp Web verandert.
- Gratis modellen hebben een daglimiet; een lokaal model als reserve vangt dat op. Is de tweede controle van een taak
  daardoor uitgesteld, dan doet TeamBot hem na de reset (hoofdstuk 10).
- Kleine lokale modellen verzinnen soms iets of gebruiken een tool verkeerd. Voor echt werk zijn Claude Code, Codex of
  OpenCode betrouwbaarder.
- Er is geen iPhone-app in de App Store, en geen lokale voorleesstem voor Arabisch.
- Routines draaien alleen als TeamBot draait en de pc wakker is.

**Gebouwd, maar nog niet live getest:** WhatsApp, Telegram, Discord, Slack, e-mail en WhatsApp Business; de gratis
bronnen met een echte sleutel; een echte telefoon, en op een iPhone de microfoon en pushmeldingen; muis en toetsenbord
bij **Mijn bureaublad** en bij **Bureaublad op afstand**; een eigen server via SSH en een cloud-VM; SSO, de Docker-image en TeamBot Cloud; installeren,
bijwerken, **Terug naar versie …** en verwijderen op een schone pc; werken met een schermlezer.

## 27. Problemen en oplossingen

- *TeamBot liep vast of is gecrasht.* De geïnstalleerde TeamBot zet een **wachter** in Windows: een kleine taak die
  elke 10 minuten kijkt of TeamBot draait en antwoordt, ook na een crash, zonder AI en zonder je gesprekken of sleutels
  te lezen. Draait TeamBot niet of reageert hij niet, dan vraagt een Windows-venster één keer "TeamBot draait niet sinds
  09:12. Wil je TeamBot opnieuw starten?". Kies je **Nee**, dan vraagt hij het niet nog eens tot TeamBot weer gewoon
  draait. Sluit je TeamBot zelf af, wordt hij bijgewerkt of sluit je Windows af, dan zegt de wachter niets. Speel je een
  game of staat er iets op volledig scherm, dan wacht hij met vragen. Wat hij het laatst
  zag, en de schakelaar **Meld het als TeamBot niet draait of vastloopt**, staan onder **Instellingen › Geavanceerd ›
  Hoe gaat het met TeamBot?** (met **Geavanceerd tonen**, of via **Ctrl+K**) bij **Wachter buiten de app**. Bij verwijderen gaat de taak mee.
- *Een pagina die ik zocht, is weg.* Die staat nu onder **Instellingen** of **Instellingen › Geavanceerd**. Typ de
  naam in **Zoek een instelling** of druk op **Ctrl+K**.
- *Ik zie iets uit deze handleiding niet.* Misschien is het voor gevorderden: zet **Geavanceerd tonen** aan.
- *Mijn bot antwoordt niet.* Kijk op **Instellingen › Geavanceerd › Abonnementen** of de CLI **ingelogd** is en klik op **Opnieuw
  zoeken**; bij een API-sleutel: **Test verbinding**. Werkt hij niet meer na een update van de CLI, kijk dan bij
  **Versies van de engines**.
- *Mijn bot zegt "Kies een model voor deze bot".* Kies in **Bot-instellingen › AI-engine** een **Model** en sla op.
- *Mijn limiet is op.* Kijk op de gebruiksbalk wanneer hij vrij is. Klik op **Verder met …**, geef de bot
  reserve-engines of zet een gratis bron aan.
- *Een gratis bron zegt **Sleutel ongeldig**.* Klik bij die bron op **Andere sleutel**.
- *Een lokale bot zegt dat de tools niet in het contextvenster passen.* Zet minder apps aan of kies een groter
  **Contextvenster**.
- *Een bot kan niet bij iets van een ander team.* Dat is de bedoeling. Geef hem **Meekijken** of **Aansturen**, of zet
  de sleutel op **Alle teams** (hoofdstuk 9).
- *Een bot blijft bezig.* Kijk bij **Wacht op jou** of hij op je wacht; anders **Alles stoppen**.
- *Een routine draaide niet.* Draaide TeamBot, was de pc wakker, en staat **Alle routines pauzeren** uit? Kijk bij
  **Historie**.
- *Mijn telefoon zegt "niet bereikbaar".* Staat je computer aan en draait TeamBot? Staat **TeamBot-verbinding** aan
  onder **Instellingen › Telefoon › Bereikbaarheid**, of (met Tailscale) is Tailscale op beide verbonden?
- *Ik wil iets terugdraaien.* Een bot: **Geschiedenis**. Geheugen: **Ongedaan maken**. Bestanden: een snapshot onder
  **Wijzigingen**. Alles: **Instellingen › Back-ups**. Een update: **Terug naar versie …**.
- *Ik wil hulp vragen.* Klik onder **Instellingen › Waar staat mijn data?** op **Diagnosebestand downloaden** en deel het bestand
  zelf.
