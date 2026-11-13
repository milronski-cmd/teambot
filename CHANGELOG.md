# Changelog

## [2.2.0] — 2026-11-13

Het team wacht niet meer op jou, en een bot werkt door terwijl een vraag bij je openstaat.

### Doorwerken
- **Een bot staat niet stil voor een vraag aan jou.** Geef je binnen twee minuten geen antwoord op een vraag om
  toestemming of een vraag van een bot, dan gaat hij door met zijn andere werk. De vraag blijft staan onder
  "Wacht op jou"; zodra je beslist krijgt de bot bericht en maakt hij het af. Dezelfde vraag komt geen tweede keer.
- **Een taak op "te controleren" is werk voor de bot, niet alleen voor jou.** De hoofdbot pakt zijn eigen taken
  die de controle niet goedkeurde zelf weer op, maximaal drie keer; pas daarna wacht het op jou.
- **Een controle die geen oordeel gaf doet TeamBot zelf opnieuw**, meteen en daarna later nog eens. Taken die nog op
  "De controle gaf geen duidelijk antwoord" stonden worden bij de eerste start opnieuw gecontroleerd.

### Toestemming en controle
- **Volledige toegang vraagt niet meer bij het woord "mail" in een opdracht.** Alleen een opdracht die echt iemand
  mailt telt als bericht naar anderen.
- **De controle via Claude Code geeft weer een oordeel**, en ziet wat een opdracht van de bot heeft uitgevoerd.
- **Een open vraag vervalt als het werk eromheen klaar is**, behalve als de bot er intussen op doorwerkt.
- Een routine krijgt geen "zonder resultaat" meer omdat het antwoord zegt wat er niet is gedaan.
- Meldingen over dezelfde taak zijn één regel met een teller.

### Scherm
- De gezichtjes van bots in de zijbalk zijn groter.

## [0.4.4] — 2026-11-09

De final: simpel en overzichtelijk, en direct na de installer werkend, zoals OpenBot maar beter. De controles staan in
`docs/RELEASE_0.4.4_GATES.md`.

### Eindcontrole (12 nov, nacht)
- **Beelden en audio ook als de gegevens onder een map met een punt staan** (Linux: `~/.local/share/teambot`).
  Daar gaf elk beeld van de browser van een bot, elk voorbeeld en alle spraakaudio "niet gevonden".
- **De check-in verdwijnt niet als je hem aanzet voordat er een bot is.** Hij blijft in "Wat start vanzelf" staan
  ("begint zodra er een hoofdbot met AI is"), met Uitzetten.
- **Routines uit een kant-en-klaar team hebben geen eigen limiet meer** (was 1 run per dag en 20 minuten per run).
- **Kaarten en stappen van de browser van een bot zijn hele zinnen**, zodat elke taal ze kan vertalen; lijsten in
  toestemmingsvragen lezen als "A, B en C".
- Het voorbeeld bij "Antwoord van de andere assistent" noemt geen stad meer.

### Afbeeldingen en hulpmiddelen bij kleine modellen (12 nov, avond)
- **Een afbeelding bij een model dat geen beeld kan lezen loopt niet meer vast.** Zo'n model (bijvoorbeeld een klein
  lokaal model in Ollama) weigerde de hele vraag. Nu krijgt het de tekst op de afbeelding, gelezen met de
  tekstherkenning van TeamBot, of de melding dat er een afbeelding is die het niet kan zien. Een model dat wel beeld
  leest krijgt de afbeelding zoals voorheen. Wat een model kan, haalt TeamBot van dezelfde plek als de botpagina.
- **Een bot heeft bij de hand waarvoor hij is ingericht.** Noemen zijn instructies de browser, dan staan alle
  browserhulpmiddelen in zijn lijst; noemt een bericht een hulpmiddel bij naam, dan staat dat er voor die beurt bij.
  Een bot zonder eigen instructies houdt dezelfde korte lijst.

### Eerste scherm en eerste bot (12 nov, avond)
- **Eén hoofdknop op het eerste scherm, wat er ook op de pc staat.** Een OpenBot-installatie gaat voor
  ("Bekijken wat er overkomt": het hele team gaat mee, met zijn AI); "Niet nu" geeft de hoofdknop aan de beste AI.
  Daarna een abonnement, OpenCode, een lokaal model, een sleutel; is er niets, dan "Gratis starten". Alle andere
  manieren blijven als rustige keuze met hun eigen knop, ook "Gebruik voor nieuwe bots" bij de lokale modellen.
- **Geen doodlopende keuze.** Staat Ollama niet op de pc, dan staat het onder "Gratis beginnen" met "Installeren":
  TeamBot installeert Ollama zelf, stil en met voortgang ter plekke (het controleert de handtekening van Ollama),
  koppelt het en haalt een model dat bij de pc past; daarna wordt de keuze vanzelf "Ollama gebruiken".
- **Op het eerste scherm** zegt "Meer informatie" niet meer dat bots altijd toestemming vragen: ze doen het werk zelf
  en vragen het je bij geld en belangrijke berichten naar anderen, zoals de eerste bot begint.
- **De eerste bot begint leeg.** Alleen de naam Assistent, zodat één klik een werkende bot geeft; geen vaste rol,
  taak of instructies. Naam en rol staan meteen in beeld en worden bewaard zodra je verder gaat, zonder extra stap.
  Instructies zijn de eigen tekst van de eigenaar, ook bij een nieuwe bot zonder voorbeeld. Hoe elke bot werkt
  (eerlijk, geen verzonnen resultaat, doorvragen bij een onduidelijke opdracht) staat in de basis van TeamBot.
- **De regel bij de werkplek volgt het niveau.** Op Volledige toegang staat er dat de bot ook daarbuiten werkt, op
  de hele computer, zonder te vragen; op Automatisch dat hij daarbuiten eerst vraagt; op Vraagt toestemming, Alleen
  lezen en Alleen chat wat daar geldt. Op de botpagina volgt hij het niveau dat je kiest.
- **Alles wat een bot moet doen op één plek:** onder Instructies op de botpagina staan nu ook de opdrachten die je
  hem in een gesprek gaf (uit zijn Werknotities), om te lezen, met "Aanpassen in Geheugen".
- **Geheugen:** het tabblad Notities van een dossier toont alle notities van dat dossier, ook de lessen in "Lessen",
  zoveel als het dossier telt.

### Marktplaats: alles wat openbaar is, met sorteren (12 nov)
- **Naast "Gecontroleerd" staat nu "Open":** zoeken in alle openbare skills op GitHub en in de open bibliotheken
  skills.sh en ClawHub, voor iedereen aan. Onder de schakelaar staat wat open betekent: niet door TeamBot
  gecontroleerd, de controle gebeurt op het moment dat je iets toevoegt. Sorteren op meeste sterren, trending,
  nieuwste en laatst bijgewerkt. Het scherm zegt wat een volgorde betekent: trending is de meeste sterren onder
  repositories van de laatste 30 dagen (GitHub geeft geen sterren per dag), met daarbij de skills die de laatste
  24 uur het meest geïnstalleerd zijn.
- **Elke kaart zegt waar hij vandaan komt.** Sterren en downloads van ClawHub telt ClawHub zelf, en dat staat erbij;
  ze staan in een eigen lijst. Op datum (nieuwste, laatst bijgewerkt) staan GitHub en ClawHub door elkaar.
- **Een skill van ClawHub wordt vastgelegd op zijn versie,** zoals een skill van GitHub op zijn commit: een nieuwere
  versie zie je als verschil en beslis jij. Waarschuwt ClawHub zelf voor een skill, dan vraagt TeamBot eerst.
- **"Wat verlaat je pc?" noemt het nu:** als jij of een bot onder Open zoekt, gaan alleen de zoekwoorden naar GitHub,
  skills.sh en ClawHub.
- **Per resultaat:** naam, één regel uitleg, repository, sterren of installaties, licentie als die bekend is, wanneer
  het laatst is bijgewerkt, en of TeamBot het gecontroleerd heeft. Zoek je op woorden, dan staan de gecontroleerde
  skills en die uit je eigen catalogi er ook bij.
- **Toevoegen is één klik en werkt meteen voor het hele team,** langs dezelfde weg als de gecontroleerde catalogus:
  importregels en veiligheidsscan op dat moment, scripts uit tot jij de skill vertrouwt. Je krijgt de versie van dat
  moment; verandert de bron later, dan zie je dat als verschil en beslis jij.
- **Vindt de scan iets ernstigs,** of lijkt de naam van de uitgever op een bekende, dan wordt de klik een bevestiging
  die laat zien wat er gevonden is. De scan leest de skill nu zoals de bron hem schreef (een opdracht in de
  beschrijving telde na het importeren als citaat en dus lichter).
- **Zonder GitHub-token** mag je 10 keer per minuut zoeken. Resultaten worden een uur bewaard; bij de limiet zegt
  TeamBot rustig wanneer het weer kan, en blijft alles wat je al zag, de gecontroleerde skills en toevoegen werken.
- **Bots zoeken mee:** `skill_find` noemt na de skills van het team en de gecontroleerde catalogus ook wat openbaar
  is (gemarkeerd als niet gecontroleerd), en `skill_install` voegt daaruit toe met dezelfde controles.
- De schakelaar `TEAMBOT_SKILL_COLLECTIONS` en de open collecties die daarbij hoorden zijn weg.

### Skills staan waar de AI ze zelf zoekt (12 nov)
- **Een skill die je installeert staat meteen in de werkmap van elke bot van het team,** als gewone skillmap
  (`.claude/skills` en `.agents/skills`). Claude Code pakt een skill er zelf bij: eerst alleen naam en beschrijving,
  de tekst pas als een taak erom vraagt. Zo'n bot krijgt geen lijst met skills meer in zijn instructies en hoeft de
  tekst niet meer via TeamBot op te halen. Bots op een model met een sleutel, een lokaal model, Codex of OpenCode
  werken als voorheen, met de lijst.
- **Een skill weghalen bij één bot werkt nu echt,** ook als het zijn laatste is: hij staat dan niet meer in zijn
  instructies, zijn menu of zijn werkmap, en zijn collega's houden hem. Een lege lijst betekende eerst "alles".
- **TeamBot schrijft alleen in een werkmap die het zelf voor de bot maakte.** Werkt een bot in jouw eigen projectmap
  of in de map van een ander programma, dan komt daar niets bij; de bot heeft zijn skills dan nog steeds.
- **Wat je zelf in een skillmap zet of aanpast, blijft staan.** TeamBot schrijft er niet overheen en zegt het je één keer.
- **Scripts van een skill die je niet vertrouwt staan niet in de werkmap.** Een script draait altijd de versie die jij
  vertrouwt, ook als iemand het bestand in de werkmap heeft aangepast.

### Elke bot kan wat jij in de schermen kunt (12 nov)
- **Elke bot bedient TeamBot voor je.** Een routine maken of pauzeren, een collega een andere naam geven, een kanaal
  uitzetten, een instelling aanpassen: tot nu toe kon alleen de hoofdbot dat (`teambot_find` en `teambot_do`). De
  hoofdbot heeft die twee in zijn lijst; elke andere bot vindt ze op afroep, dus ze kosten zijn stappen niets.
- **Op jouw woord meteen, anders één kaart.** Vraag je het zelf in het gesprek, dan gebeurt het direct, ook als je bot
  het werk doorgeeft aan een collega en die het weer doorgeeft, en ook in de beurt waarin het antwoord van een collega
  terugkomt: het begon met jouw bericht. Begon het werk met iets anders (een routine, een webhook, een bericht van
  iemand anders, een beurt die TeamBot zelf startte), dan komt een wijziging eerst als één kaart bij jou. Dat geldt
  voor elke bot, ook voor de hoofdbot: tekst die een bot leest in werk dat jij niet begon, kan niets aan TeamBot
  veranderen zonder dat jij het ziet. Kijken kan altijd.
- **Met het bereik van de bot zelf, niet met het jouwe.** Een bot ziet en verandert alleen wat bij zijn eigen team
  hoort, en bij een team waar hij mag meekijken (alleen kijken) of dat hij mag aansturen. Een sleutel die alleen voor
  een ander team is, ziet en gebruikt hij niet. In een gesprek met iemand anders dan jij (een klant via een kanaal)
  bestaan de schermen voor een bot niet, ook niet voor de hoofdbot en ook niet om iets op te zoeken.
- **Wat het ene team weet, weet een ander team niet.** Zodra je twee teams hebt, geldt dat voor elke bot behalve de
  hoofdbot, ook voor een bot die alle teams mag aansturen. Het geheugen van een team (dossiers, kennis) schrijft alleen
  een bot van dat team, net als met zijn eigen geheugentools. Een bot die een bot maakt, zet hem in zijn eigen team.
  Noemt een bot geen team, dan is het zijn eigen team en niet het standaardteam. Totalen over alle teams (verbruik,
  aantallen, het overzicht van de hoofdbot) krijgt een bot alleen over de teams waar hij in mag kijken. Een bot bij
  zijn naam of rol noemen helpt niet om langs een muur te komen. Een lijst met wie een app, vaardigheid of gedeeld
  browserprofiel mag gebruiken, haalt een bot niet leeg voor teams die hij niet ziet. Het hele geheugen in één keer
  (alles wissen, prullenbak legen, opruimen) doe je zelf.
- **Jouw bericht in een groep met alleen jou telt als jouw woord**, zoals in je eigen chat. Een routine die opnieuw
  probeert (na een limiet of met Opnieuw) is nog steeds de routine: een wijziging is dan een kaart.
- **Meer toegang gaat altijd naar jou.** Een hoger toegangsniveau (ook van *Vraagt toestemming* naar *Automatisch*),
  een onderdeel erbij of versturen zonder vragen komt als kaart, via welke tool een bot het ook probeert. Minder kan
  een bot altijd zelf.
- **Eén weg naar de bot zelf.** Wat een bot aan zichzelf of aan een collega verandert, gaat langs het opslaan van de
  botpagina: dezelfde controles, en de bot zoals hij was staat onder Geschiedenis. Een onderdeel dat een bot aanvroeg
  bewaarde die versie eerst niet.
- **Een bot komt in het team waarvoor hij is gemaakt**, ook als een ander onderdeel van TeamBot er eerder naar vraagt,
  en een bot die wordt verwijderd blijft niet in zijn team achter (een leeg team kon daardoor niet weg).

### Instellingen en de botpagina: eerst wat je nodig hebt, de rest op één plek (12 nov)
- **Instellingen is één lijst waarin elke regel één ding opent.** Eerst wat je zelf kiest: AI-diensten, Telefoon, Taal
  en uiterlijk, Regels, Back-ups en Vergrendeling. Dan, onder *Van je bots*: Bots, Teams, Geheugen, Kanalen, Apps en
  Bestanden. De tussenpagina's *Bots en teams* en *Apps en bestanden* zijn weg.
- **Alles wat je erbij kunt aanzetten staat op één plek: Meer mogelijkheden.** Elke functie is één regel met één zin
  die zegt wat het is. Er is niets weggehaald: ook de extra AI-programma's, gratis modellen, Computers, Websites,
  Organisatie, Kant-en-klare teams en Overstappen staan erin. *Geavanceerd* heette het eerst.
- **Je eigen regels hebben een eigen pagina.** Per team, met de regels die voor één bot gelden erbij.
- **Taal en uiterlijk is één pagina:** je naam, de taal, het thema, de kleur en de stijl van de figuurtjes. Het thema
  stond op twee pagina's.
- **De botpagina begint met wat een bot is:** gezicht en naam, rol, AI en model, instructies en één keuze *Wat mag de
  bot?*. Bij AI en model staat *Als deze AI op is, ga verder op*, voor elke soort AI hetzelfde. Al het andere staat
  onder *Meer mogelijkheden*, elk als één regel met één zin.
- **AI toevoegen heeft een regel voor elke soort AI:** een abonnement, een sleutel, gratis, of een model op deze
  computer.
- **Wat start vanzelf.** Eén lijst van alles wat uit zichzelf begint, met wanneer en of het AI gebruikt, en per regel
  één actie. Eronder wat uit staat, met *Aanzetten*. Te vinden onder Taken › Automatisch › Werk en onder Meer
  mogelijkheden.
- Oude links naar pagina's die zijn samengevoegd of hernoemd openen de pagina die het nu heeft.

### Model wisselen bovenin de chat (12 nov)
- **Bovenin een gesprek met een bot staat op welke AI en welk model hij draait.** Bijvoorbeeld *Claude Code · Sonnet*,
  of *Automatisch* als de AI zelf kiest. Eén klik opent de lijst met alle modellen van alle AI's die je hebt
  gekoppeld: Claude Code, Codex, OpenCode, diensten met een sleutel en lokale modellen (Ollama, LM Studio). Per AI
  gegroepeerd, met erbij wat het kost (abonnement, gratis, lokaal, betaald) en een zoekveld als de lijst lang is. Een
  AI die uit staat, niet geïnstalleerd of niet ingelogd is, staat er niet in.
- **Kiezen is meteen bewaard.** De AI en het model samen, op de bot zelf. Het geldt vanaf je volgende bericht; een
  antwoord dat nog loopt, maakt de bot af op het oude model. Kent het nieuwe model het denkniveau van de bot niet,
  dan kiest TeamBot het dichtstbijzijnde.
- **De bot weet nog waar het gesprek over ging.** Op een andere AI krijgt hij het gesprek tot dan toe mee. Zet je hem
  terug op Claude Code, Codex of OpenCode nadat hij op een andere AI heeft geantwoord, dan begint die met een nieuwe
  sessie en het gesprek erbij. Eerder ging hij verder in zijn oude sessie en miste hij wat er tussendoor was gezegd.
- **Ook op je telefoon.** Daar opent de lijst als blad van onderaf. In een groepschat staat de knop niet: daar noemt
  de kop de bots niet bij naam, en het model stel je per bot in.

### Eén poort voor toestemming (12 nov)
- **Dezelfde stap krijgt overal hetzelfde antwoord.** Of een bot iets mag, werd op twee plekken beslist: één keer voor
  de hulpmiddelen van TeamBot en nog een keer voor de eigen hulpmiddelen van Claude Code, Codex en OpenCode. Die twee
  waren uit elkaar gegroeid. Nu is er één poort, voor elke soort AI: uitvoeren, weigeren, jou vragen op een kaart, of
  eerst laten nalezen.
- **Wat jij per hulpmiddel kiest, geldt voor alles wat dat hulpmiddel doet.** *Nooit* of *eerst vragen* voor de
  terminal van Claude Code gold niet voor een opdracht die iets wist of naar buiten gaat. Nu wel.
- **Automatische controle doet wat de schakelaar zegt.** Ze leest nu ook de eigen stappen van Claude Code, Codex en
  OpenCode na, en alleen op het niveau *Automatisch*, waar je de schakelaar ziet. Stond ze nog aan op een bot die je
  daarna *Volledige toegang* gaf, dan las ze ongemerkt elke stap na; dat is voorbij.
- **Geen kaart meer voor iets wat toch geweigerd wordt.** Een opdracht die de hele schijf wist, wordt meteen geweigerd.
  Een bot die bij zijn eigen mappen moet blijven, vraagt het je als een opdracht daarbuiten komt, ook als hij zonder
  vragen berichten mag versturen.
- **Een sleutelbestand, de gegevens van TeamBot of een map die je dicht zette lezen, wordt meteen geweigerd,** ook als
  je de regel "vraag eerst voordat je iets leest" hebt: geen kaart meer voor iets wat toch niet mag.
- **Een hulpmiddel dat een regel van jou verbiedt, geeft bij elke soort AI dezelfde weigering,** met jouw regel erin,
  ook als Claude Code, Codex of OpenCode het bij naam aanroept. Op *Alleen lezen* ook: wat dat niveau niet toestaat,
  wordt meteen geweigerd met de reden, in plaats van "onbekend hulpmiddel" na een kaart voor iets wat toch niet mocht.
- **Een app die OpenCode of een andere ACP-engine zelf gekoppeld heeft** (bijvoorbeeld Gmail) gaat als app naar de
  poort: versturen en betalen vraagt het je, en jouw regels kennen hem bij naam. Een eigen hulpmiddel van een engine
  dat TeamBot nog niet kent, is bij elke engine een gewone stap op deze pc: het vraagt op *Vragen*, en loopt vanaf
  *Automatisch*.
- **Codex houdt sleutelbestanden, de mappen die je dicht zette en de gegevens van TeamBot dicht op elk niveau, of de
  pagina van de bot zegt dat het niet zo is.** Wat de sandbox van Codex dichthoudt, komt nu uit dezelfde lijst als wat
  de poort weigert. Je dichte mappen gaan nu mee (dat deden ze niet), en ook de werkmappen van andere bots. Met
  *Volledige toegang* draait Codex in zijn sandbox met de hele schijf schrijfbaar, als TeamBot op deze pc heeft gezien
  dat dat houdt; anders draait hij zonder sandbox, zoals voorheen, en dan staat dat op de pagina en in de instructies
  van de bot. Dat geldt voor elke soort AI: per niveau zegt TeamBot "bewaakt" of "niet bewaakt", met wat niet
  (`GET /api/cli-agents/hard-blocks/:provider`). Een andere ACP-engine dan OpenCode vraagt niet voor elke stap; daar
  staat "niet bewaakt" en gaan de blokkades mee in zijn instructies. Niet bewezen met Codex zelf.
- **Meer sleutelbestanden dicht voor elke bot:** `~/.terraform.d`, `.vault-token`, `.pgpass`, Bitwarden en 1Password,
  en de opgeslagen logins van Chrome-profielen en Firefox (`Login Data For Account`, `signons.sqlite`).
- **Een opdracht die een pad buiten de mappen van de bot noemt, krijgt bij elke soort AI een kaart zonder "Altijd
  toestaan".** Bij Claude Code, Codex en OpenCode stond die knop er wel, maar de volgende opdracht daarbuiten vroeg het
  toch opnieuw. De terminal van TeamBot controleert een opdracht niet meer een tweede keer als hij draait: de poort
  weigert of vraagt het daarvoor al.
- **Schrijft OpenCode of een andere ACP-engine zelf een bestand via TeamBot, dan gaat dat op elk niveau langs de
  poort.** Op *Automatisch* en *Volledige toegang* gold jouw regel over een map daar niet voor; nu wel.
- **Een document lezen, een bestand uploaden, importeren of meesturen** (`read_document`, `browser_upload`,
  `team_import_file`, `remote_upload`, de bestanden van `channel_send`): een sleutelbestand, de gegevens van TeamBot of
  een dichte map wordt meteen geweigerd, zonder eerst een kaart.
- **Een script van een skill die je vertrouwt, is een opdracht als elke andere.** Het vraagt op *Vragen* en loopt vanaf
  *Automatisch*; noemt een regel van jou opdrachten of scripts, dan vraagt het. Eerder vroeg het altijd, behalve op
  *Volledige toegang*. De kaart zegt welke sleutels voor scripts het script krijgt.

### Eén planner, en niets start vanzelf (12 nov)
- **Een nieuwe installatie doet niets uit zichzelf.** De dagelijkse check-in van de hoofdbot en zijn overzicht stonden
  aan zonder dat je erom vroeg. Ze staan nu uit tot jij ze aanzet: zeg het tegen je hoofdbot ("meld je elke werkdag om
  9 uur"), of kies bij Werk hoe vaak je het overzicht wilt. Had je TeamBot al, dan blijft alles zoals het was.
- **Eén klok in plaats van zeven.** Routines, herinneringen, wachtpunten, vaste taken, workflows op een schema, werk dat
  klaarligt, de check-in, het overzicht en de leerrondes van specialisten lopen via één planner. Wat er vanzelf start
  en wanneer staat in één lijst (`GET /api/routines/planned`), met per regel of het AI kost.
- **Alles stoppen is ook echt stoppen.** Na *Alles stoppen* begint er geen werk meer vanzelf, ook niet bij een bot die
  op dat moment niet bezig was. Het gaat verder zodra jij weer iets vraagt of *Hervatten* kiest, of wanneer iets wat je
  zelf hebt ingepland op zijn tijd komt.
- **Eén tijdstip voor je hoofdbot.** Het overzicht had een eigen tijdstip dat je nergens kon instellen; het komt nu op
  hetzelfde uur als waarop je hoofdbot zich meldt.

### Lichter per stap (12 nov)
- **Elke stap van een bot sleept veel minder mee.** TeamBot stuurde bij elke stap van elke bot de beschrijving van al
  zijn ruim honderd hulpmiddelen mee (ongeveer 18.600 tokens) en een lange vaste uitleg. Nu krijgt een bot een korte
  lijst met wat hij dagelijks gebruikt (16 hulpmiddelen, ongeveer 3.400 tokens). Alle andere staan er bij naam in en
  pakt hij erbij wanneer hij ze nodig heeft, in dezelfde beurt. Er is niets weggehaald: elk hulpmiddel werkt nog, met
  dezelfde toestemming en hetzelfde logboek. Dit geldt voor Claude Code, Codex, OpenCode en API-modellen. Je hoeft
  niets in te stellen.
- **Eén keer zoeken is genoeg.** Gebruikt een bot één hulpmiddel van de browser, het bureaublad, de teamdatabase of
  een gekoppelde app, dan krijgt hij de rest van dat onderdeel er meteen bij.
- **Kortere vaste uitleg.** De lijst met skills stond twee keer in de instructies van elke bot; dat is één keer. Uitleg
  over de browser, het bureaublad en de teamdatabase krijgt een bot pas als hij die gebruikt. Op een verse installatie
  gaat de vaste uitleg van een gewone bot van ongeveer 4.600 naar 2.500 tokens. Je eigen instructies en de dossiers
  blijven zoals ze zijn.

### Vanzelf het goede werk (12 nov)
- **Geen automatische routines per bot meer.** TeamBot gaf elke bot vaste taken op grond van woorden in zijn rol en
  liet bots zelf vaste taken verzinnen: 49 routines in één nacht, 64 runs die allemaal *niets nieuws* meldden. Dat is
  weg. Een bot houdt alleen iets in de gaten als jij erom vraagt (bij Werk of in de chat).
- **Opgeruimd, niets weg.** Bij de eerste start na de update archiveert TeamBot de routines die het zelf aanmaakte en
  die nooit iets opleverden. Je krijgt één melding en vindt ze bij Werk onder *Opgeruimd*, met *Terugzetten*. Wat jij
  maakte of aanpaste, wat een bot in een gesprek instelde en alles wat ooit iets vond, blijft staan.
- **Werk dat er ligt, wordt nu gedaan.** Een taak op het takenbord of in de teamdatabase, of de volgende stap van een
  project, wordt meteen opgepakt door de bot van wie het is, op zijn eigen model met al zijn tools. De hoofdbot geeft
  taken zonder eigenaar aan de juiste bot en kijkt na wat terugkomt. Voor dezelfde lijst start geen tweede beurt, en
  zonder werk start er niets.
- **Toestemming één keer.** Voor geld, een eerste bericht aan een nieuw contact en mail aan klanten vraagt een bot het
  één keer met een concreet voorstel en gaat hij door met de rest. De hoofdbot wacht niet meer op je antwoord voor werk
  dat hij zelf kan doen of uitzetten, en zet geen wachtpunt om werk uit te stellen.
- **Een vaste taak zonder bron draait niet voor niets.** Is de app of website er niet, dan staat erbij wat er nodig is
  en wacht hij; zodra het er is, gaat hij vanzelf aan.
- **Specialisten leren alleen over hun eigen vak.** Een bot wordt alleen specialist om wat hij is, niet om een woord
  ergens in zijn rol. Een bron die een bot zelf vindt, moet over zijn vak gaan; een officiële pagina over iets anders
  telt niet. Bronnen die daar niet aan voldoen zijn uitgezet (niet weggehaald).
### Geheugen: dossiers die je bots zelf bijhouden (12 nov)
- **Eén gedeeld geheugen, zonder instellen.** Je bots houden samen dossiers bij: *Eigenaar* (wie je bent en hoe je het
  wilt), *Overzicht* (waar je mee bezig bent), *Lessen* en per bot eigen *Werknotities*. Die staan in elke beurt bij
  elke bot in beeld, ook bij Claude Code en Codex. Wat de ene bot opschrijft, weet de andere meteen. Over één project,
  klant of onderwerp maakt een bot zelf een dossier; dat leest een bot zodra het ter sprake komt. De dossiers beginnen
  leeg en vullen zich door wat je vertelt.
- **Bijwerken in plaats van stapelen.** Een bot vervangt wat veranderd is en haalt weg wat niet meer geldt
  (`dossier_write`). Elk dossier heeft een maximum; is het vol, dan schrijft de bot het korter. Wat eruit gaat, staat
  in het archief van het dossier en blijft vindbaar. Elke vorige versie kun je terugzetten in Geheugen › Geschiedenis.
- **Geen stortvloed van losse zinnen meer.** Wat een bot onthoudt, is voor zijn hele team en geldt meteen (geen
  voorstel dat op jou wacht, tenzij je dat zo hebt ingesteld). TeamBot zelf vangt alleen nog op wat duidelijk blijvend
  is; zo'n losse notitie blijft in beeld tot een bot haar in een dossier zet.
- **Ook via WhatsApp en andere kanalen.** Schrijf je zelf met je bot via een kanaal, dan weet hij daar wat hij in de
  app weet, en houdt hij de dossiers ook daar bij.
- **Specialisten leren alleen over hun vak.** Een pagina die een zoekopdracht oplevert, wordt alleen een bron als de
  titel over het werk van de bot gaat, ook als de site officieel is. Gaat een bron toch ergens anders over, dan leert
  de bot er niets van, en zet TeamBot een zelf gevonden bron uit. Per stuk tekst hoogstens 5 feiten.
- **Minder tools.** Dagelijks zes: zoeken, onthouden, bijwerken, vergeten, dossier lezen en dossier schrijven.
  `dossier_search` en `dossier_create` zijn weg (`dossier_get` zonder naam geeft de lijst, `dossier_write` maakt een
  dossier aan).
- **Bij de update**, één keer en zonder AI: losse notities van vroeger gaan onder een paar kopjes in de dossiers, en
  een bron die TeamBot ooit zelf vond en die niet over het vak van de bot gaat, wordt uitgezet (de feiten eruit gaan
  naar het archief). Er wordt niets gewist; in Geheugen › Geschiedenis zet je het met één klik terug. Bij twijfel
  blijft alles zoals het was.
- **In Geheugen › Dossiers** zie en bewerk je de tekst van elk dossier.

### Minder vragen, hele computer (10 nov)
- **Volledige toegang = je hele computer.** Een bot op *Volledige toegang* leest, schrijft en draait opdrachten overal,
  niet alleen in zijn eigen mappen, en vraagt daar niet meer voor. Dicht blijven: bestanden met sleutels en
  wachtwoorden, de gegevens van TeamBot zelf en de mappen die jij dichtzet (instelling `closedFolders`). Een bot die je
  toch in zijn mappen wilt houden: `settings.ownFoldersOnly`.
- **Je eigen regels houden het werk niet meer op.** Een regel die TeamBot niet vooraf kan vastpinnen (bijvoorbeeld over
  geld) liet de automatische controle bij elke stap meekijken of die wel bij je laatste bericht paste. Nu kijkt de
  controle alleen of de stap doet wat de regel noemt. De controle gaf bij denkende modellen vaak geen antwoord
  ("Twijfel"); dat is gerepareerd.

### Design en eenvoud
- **Rustiger en ronder**: vaste ronde hoeken, grotere iconen, randen in plaats van schaduwen. De verzendknop in donker
  is rustig, en het witte vak in de chatbalk is weg.
- **Gebruik als meters** linksonder: per abonnement één ring (week en 5 uur). Klik je erop, dan zie je per dienst
  "Nog 62%, weer vol om do 09:00".
- **Zijbalk**: *Wacht op jou*, Taken, Marktplaats en Instellingen, en elke bot met een statusbolletje. *Nu bezig*
  (alle bots die nu werken, live, met *Bekijken*, *Stoppen* en *Overnemen*) staat op Taken.
- **Instellingen**: schakelaars, keuzeknoppen en dropdowns die meteen opslaan, met *Standaard terugzetten*. Het model
  staat standaard op "Automatisch", en het privacyblok bij een bot is één regel.
- **Goedkeuren**: *Eén keer*, *Overslaan* en *Altijd*.
- **Minder tekst** op Kanalen, Skills, Geheugen, *Wacht op jou* en het welkomstscherm.

### Direct werkend na de installer
- **Een eerste bot staat meteen klaar** na het koppelen van je AI. De laatste stap is "Koppel je telefoon".
- **Telefoon koppelen** in één kaart: de app installeren, de QR-code scannen, en klaar. Onderweg werkt het zonder
  Tailscale. De telefoon opent op *Wacht op jou*, en meldingen komen pas als je 3 minuten weg bent.
- **Een eigen werkplek per bot**: een eigen map, en de browser van de bot draait onzichtbaar binnen TeamBot (live
  meekijken en *Overnemen* blijven werken). Geen Docker of WSL nodig.
- **Beter zoeken zonder sleutel**: Keenable en Parallel. Tavily en Exa met een gratis sleutel; DuckDuckGo en Wikipedia
  als reserve.

### Geheugen
- **Leert zoals OpenBot, maar netter**: uit het hele gesprek (ook de antwoorden van de bot en wat tools vinden), met het
  model van de bot zelf. Veranderingen gaan direct door, met geschiedenis en ongedaan maken.
- **Een geheugen per klant**: elke klant op een kanaal krijgt een eigen dossier, en de bot ziet alleen díe klant. In de
  test lekte er bij 100 klanten niets naar een andere klant.
- **Snel bij veel klanten**: 500 klanten in 33 s (was meer dan 10 minuten). "Ahmed is weg" sluit ook zijn taken.

### Marktplaats
- **Duidelijk**: *Aanbevolen voor je bots*, tegels per onderwerp, zoeken, één knop *Toevoegen* en een badge
  *Gecontroleerd*.
- **76 nieuwe gratis skills en 28 apps**, met gecontroleerde licenties, voor:
  - Marketing en SEO;
  - Klantenservice en verkoop: Shopify, WooCommerce, Mollie, Stripe, Moneybird, mail;
  - Bouwen en data;
  - Kantoor en ontwerp;
  - Onderzoek;
  - Zoeken.

### Gerepareerd
- Ctrl+K vindt ook taken.
- Een controle die op de daglimiet vastloopt, wordt opnieuw geprobeerd.
- Een nieuwe bot zegt in welk team hij komt.
- Een routine toont "elke maandag", niet meer "elke MO".
- Een gebruikslimiet per bot.
- De handleiding is bijgewerkt.

### Eerder in 0.4.4 (eerste uitgave, dezelfde dag)

De versie om echt mee te werken: simpeler, slimmer geheugen, live bellen en de overstap van OpenBot. De controles
staan in `docs/RELEASE_0.4.4_GATES.md`; de praktijktests in `docs/PRAKTIJKTEST_0.4.4_KERN.md` en `…_RANDEN.md`.

### Eenvoudiger
- **Instellingen**: vier groepen met tien regels (Account en uiterlijk, AI, Telefoon en meldingen, Gegevens en
  privacy). De rest staat op één pagina *Geavanceerd*, en Ctrl+K vindt alles. Pagina's tonen bovenaan wat je echt
  verandert; de rest zit onder *Meer opties*.
- **Minder tekst**: elk vak een korte titel en hoogstens één zin. Uitleg staat achter (i) *Meer informatie* (bot,
  team, chat, Taken).
- **De +** maakt een nieuwe bot, een nieuw team of een team uit een sjabloon, ook op de telefoon.
- **Gratis modellen**: OpenCode en Ollama staan er altijd, met *Aanzetten*, *Uitzetten* of *Installeren*.

### Toegevoegd
- **Live bellen met je bot**, zoals bij ChatGPT: gratis op je eigen pc (eerste klank ±1 s), of via OpenAI of Gemini.
  Je kunt de bot onderbreken door te praten, en hij werkt tijdens het gesprek door (hij vraagt het zijn team en
  vertelt het resultaat). Toestemming geef je met een duidelijk "ja". De bot hangt zelf op na een afscheid, en
  daarna staat er een verslag in de chat.
- **Geheugen dat zichzelf bijhoudt**:
  - een nieuw feit herhaalt, verandert of beëindigt oudere notities, ook als dat impliciet is, en nooit stil;
  - wat niet meer geldt, krijgt "geldt niet meer sinds …";
  - taken sluiten zichzelf ("SEO bijwerken" verdwijnt als het gedaan is);
  - een gewijzigd dossier wordt opnieuw gelezen;
  - klantdossiers hebben een eigen omvang, met een archief;
  - een nieuw ingebouwd zoekmodel. Op de geheugentest staat het juiste feit nu in 61% van de gevallen op plek 1 (was
    40%) en in 86% bij de eerste vijf (was 79%).
- **Overstappen van OpenBot**, stap voor stap: back-up, importeren met kanalen en routines op pauze, naast elkaar,
  kanalen één voor één, routines aan, en terug als dat nodig is. Ook overstappen uit Hermes en OpenClaw, en je
  geheugen meenemen uit ChatGPT, Claude of Gemini.
- **Bureaublad op afstand** vanaf je telefoon. Het staat standaard uit en zet je alleen op de computer aan; je pc
  toont een balk met Stop.
- **Telefoon zonder Tailscale** (TeamBot-verbinding): thuis en onderweg verbonden, versleuteld tot op je pc. Dit
  vraagt de nieuwe iPhone-app uit TestFlight.
- **Automatisch bijwerken**: TeamBot kijkt dagelijks en installeert pas als er niets loopt, met een back-up vooraf.
  Het gaat aan zodra er een updatekanaal is.
- **Eigen regels in gewone taal**, per bot of team ("Mail nooit naar klanten zonder mij te vragen"). TeamBot houdt
  zich er zelf aan.
- **Kosten vooraf**: een schatting vóór een grote taak, en *Start na de reset om …*.
- **Documenten**: scans en foto's lezen (OCR), Word, Excel en PowerPoint, CSV of Excel in de teamdatabase, schone
  webartikelen, en versleutelde back-ups naar een tweede plek.
- **Niets blijft stil hangen**: de hoofdbot meldt vastgelopen werk één keer. Routines controleren eerst hun
  koppelingen. Meldingen gaan naar je telefoon als je niet achter de pc zit. Een wachter buiten de app vraagt na een
  crash of TeamBot opnieuw moet starten.
- Kleinere dingen:
  - mappen voor chats;
  - een melding als er een nieuwe versie van een skill is;
  - skills testen met testvragen, en een skill maken van een document;
  - een e-mailadres per bot;
  - statusreacties in chat-apps (👀, ✅);
  - een proxy per browserprofiel, en SOCKS voor de netwerkproxy van TeamBot;
  - formules in de chat;
  - sleutels voor scripts ook in de container en via SSH;
  - het pictogram in je accentkleur.

### Beter onder de motorkap
- Toolaanroepen van lokale en gratis modellen worden hersteld (Qwen) en volledig gecontroleerd. OpenCode met gratis
  modellen stopt niet meer na drie stappen.
- Officiële MCP-SDK v2 en ACP-SDK.
- De modellenlijst, prijzen en contextvensters komen uit models.dev.
- CLI-bots krijgen ±40% minder tokens voor tools.
- De installer sluit een draaiende TeamBot netjes af en start hem daarna altijd.
- Terugzetten bewaart ook de laatste wijzigingen.
- Dialogen houden de focus vast. De maillibraries zijn bijgewerkt en Electron is beter afgeschermd.
- Een nieuwe website met Functies, Vergelijken, Overstappen en Vragen.

## [0.4.3] — 2026-11-09

Gaten naast OpenBot dichtgemaakt en telefoonfoutjes gerepareerd. Elke controle is groen gedraaid op deze versie
(`docs/archief/RELEASE_0.4.3_GATES.md`).

### Toegevoegd
- **Kleur kiezen**: Instellingen › Uiterlijk met Standaard en tien kleuren (o.a. Lavendel), met een voorbeeld in licht
  en donker. De kleur geldt op de computer, in de browser en op de telefoon, en elke kleur haalt WCAG AA.
- **Sleutels voor scripts**: geef een bot (of een heel team) een opgeslagen sleutel als omgevingsvariabele met een
  eigen naam. De bot ziet alleen de naam, en TeamBot verbergt de waarde overal. Dit stel je alleen op de computer in.
- **Hoe gaat het met TeamBot?** (Instellingen): een stilstandmeter met een groene, oranje of rode lijn. Met
  `npm run soak` draai je een duurtest, ook naast OpenBot (alleen meekijken).
- **Kopieer tabel**: een tabel uit een antwoord gaat in één klik naar het klembord. In Excel of Google Sheets plak je
  gewone cellen.
- **Bewaar als skill**: in het chatmenu maakt de bot een concept uit het gesprek. Jij past het aan en bewaart het voor
  die bot of voor het hele team.
- Routines: een nieuw webhooktype *Standard Webhooks* (Svix, Clerk, Resend …), met een controle van de handtekening,
  bescherming tegen herhalen en het negeren van dubbele leveringen.

### Veranderd
- **Telefoon**: de invoerbalk blijft vlak boven het toetsenbord in de iPhone-app, in plaats van naar het midden te
  springen. Elke pagina is getest als gekoppelde telefoon: wat alleen op de computer kan, zegt dat rustig, in plaats van
  een foutmelding of een knop die niet werkt.
- **Windows-meldingen**: een melding voor een goedkeuring of vraag verdwijnt zodra je het elders hebt afgehandeld.
- **Gratis keten**: zit één OpenCode-verbinding aan zijn limiet, dan slaat TeamBot de andere verbinding op hetzelfde
  account over en gaat hij door naar de volgende echte keuze.
- De basis voor automatisch bijwerken staat klaar: een eigen map of GitHub Releases als kanaal, en bijwerken als de pc
  rust. Dit is nog niet aangezet.

## [0.4.2] — 2026-11-09

Alles wat bij het eerste gebruik van 0.4 niet goed genoeg was, plus de laatste stukken van 0.4. Elke controle is
groen gedraaid op deze versie, ook als gekoppelde iPhone (`docs/archief/RELEASE_0.4.2_GATES.md`).

### Toegevoegd
- **Geheugen voor iedereen**: zoeken op betekenis zonder Ollama, met een klein ingebouwd zoekmodel (± 135 MB, pas na
  jouw ja, blijft op je pc); synoniemen bij elk feit; feiten die met de tijd veranderen worden opnieuw gecontroleerd
  en vernieuwd; een vaste omvang met samenvatten en archiveren, en een maandelijks opruimverslag met ongedaan maken.
  In de geheugentest vindt het juiste feit nu in 79% van de gevallen in de top 5 (0.3: 19%).
- **Dossiers zonder moeite**: een gesprek over een klant of project koppelt zich vanzelf aan het dossier, en een bot
  noteert iets met één zin.
- **Lessen gelden voor het hele team**, niet alleen voor één bot.
- **Teams overal**: ook kanalen, skills, routines en de gratis keten horen bij een team. Een team **dupliceren** kan.
- **Starten in twee klikken**: *Ik heb Claude of ChatGPT* (inloggen via hun eigen scherm), *Ik heb een API-sleutel*
  (plakken; TeamBot herkent en controleert hem) of *Gratis beginnen*.
- Een nette **installer**: één klik, geen vragen, TeamBot start daarna vanzelf, snelkoppelingen, en bij verwijderen
  blijven je gegevens standaard staan.
- Rechtsklikmenu met spelling en kopiëren/plakken in de app; gearchiveerde bots terughalen; teamsjablonen ook na de
  eerste bot.

### Veranderd
- **De telefoon**: geen inzoomen meer bij tekstvakken, standaard donker, het toetsenbord valt niet meer over vensters,
  en wat alleen op de computer kan zegt dat rustig. Iemand eigenaar van een kanaal maken blijft op de computer.
- **Simpeler**: de zijbalk heeft zes links, Instellingen acht groepen en 25 rijen, met gewone namen (AI-diensten,
  Abonnementen, Apps). Routines staan onder Taken, Geheugen en Marktplaats onder Instellingen.
- Wat echt niet kan op deze pc legt TeamBot nu rustig uit, zonder rode foutmeldingen (`docs/NOG_NIET_0.4.md`).
- Alle nieuwe teksten in de 10 andere talen.

### Gerepareerd
- Het startscherm trok je soms terug naar de laatste chat; de chatkop paste niet met het paginapaneel open; teksten
  die in elke taal Nederlands bleven; de weekreserve-streep op de gebruiksbalk verscheen niet; een bron uit een
  document stond niet onder het antwoord; e-mailtriggers per mailbox gingen nooit af.

## [0.4.1] — 2026-11-09

### Veranderd
- Je telefoon kan nu alles wat de computer kan: bots maken, AI koppelen, instellingen, routines en teams. Alleen dingen
  die toegang uitdelen of geheimen laten zien blijven op de computer: beheer en gebruikers, een nieuw apparaat of
  andere apparaten koppelen, opgeslagen sleutels en de kluis bekijken, alles exporteren, telefoontoegang zelf aan- of
  uitzetten, en je e-mailadres of wachtwoord wijzigen. Een geweigerde actie zegt nu waarom.

## [0.4.0] — 2026-11-09

Teams voor alles wat je wilt (een bedrijf, je privéleven of iets anders), een hoofdbot die het werk verdeelt,
specialisten die zelf leren, en een rustigere, simpelere app. Gebouwd op het onderzoek *Knelpunten gebruikers alle AI
bots* (9 november 2026): geen stille verrassingen, bewijs bij elke "klaar", en gratis blijven doorwerken. Je data in
`%APPDATA%\TeamBot` blijft bij het bijwerken staan; vóór elke update maakt TeamBot nu zelf een back-up. De installer is
nog niet ondertekend.

### Toegevoegd

**Teams en de hoofdbot**
- Teams als afgeschermde werkruimtes: elk team heeft een eigen map, geheugen, dossiers, teamdatabase, groepen en
  budget. Met één team zie je er niets van; de teamkiezer verschijnt pas vanaf het tweede team.
- Per bot een thuisteam en per ander team *geen toegang*, *meekijken* of *aansturen*. Sleutels gelden standaard voor
  alle teams, of voor één team.
- Eén **hoofdbot** die je zelf aanmaakt: je vaste gesprek, hij geeft werk aan het juiste team of de juiste specialist,
  controleert het bewijs en meldt terug. Leiders kunnen meerdere teams aansturen; een teamleider is optioneel.
- Overzicht **Alle teams**: open taken, wat op jou wacht, fouten, gemiste routines en verbruik per team.
- 15 optionele teamsjablonen (webshop, SEO en content, advertenties, klantcontact, operations, software, privé
  huishouden, geld, gezondheid, reizen, leren, leeg team). Je begint altijd leeg.
- Je OpenBot-team overzetten in één team, met eerst een voorbeeld, Baas als hoofdbot, alle routines uit, en een knop om
  het ongedaan te maken.

**Werk dat echt af is**
- Elke taak een *klaar als*. Een bot zet nooit zelf "klaar": er is bewijs nodig en een tweede blik met een frisse
  context; anders komt de taak op *te controleren*. Eerlijk *kon niet* met een reden.
- Eén takenbord (**Taken**), taken worden door één bot geclaimd, een bot die rondjes draait stopt zelf.
- Correcties van de eigenaar worden lessen; werkwijzen die vaak goed gaan worden een voorstel voor een skill.
- **Specialisten die zelf leren**: per bot een vakgebied en bronnen, een leerronde (staat uit tot jij hem aanzet), een
  kennisbank met bron en datum, *te controleren* bij tegenspraak, leerdoelen uit "weet ik niet", en een leerverslag.

**Gratis en zuinig**
- Een gratis reserveketen die standaard aanstaat: ander abonnement, gratis bronnen bij een andere aanbieder, en als
  laatste een lokaal model. Elke overstap staat in de chat.
- **Belangrijk** op taken en routines: zo'n taak gaat niet door op een zwakker model maar pauzeert met reden en
  hervattijd, en gaat vanzelf verder.
- Weekreserve: boven 85% van de Claude- of Codex-week gaat gewoon werk alvast naar gratis modellen.
- Gratis bronnen met een geteste catalogus (Kilo, Groq, OpenRouter, Cloudflare, Z.ai), labels *tools werken* en
  privacy, en eerlijke controle van antwoorden. Gemini CLI wordt niet meer aangeboden (gestopt op 18 juni 2026).
- Ongeveer 40% minder tokens per gesprek zonder dat de vraag of je vaste regels wegvallen.
- Lokale modellen gekozen voor jouw pc (past goed / werkt traag / te groot), met een toolproef en een waarschuwing als
  Ollama op de processor draait.

**In beeld**
- Een vaste **gebruiksbalk** onderin: Claude 5 uur en week, Codex, en per gratis bron of hij beschikbaar is.
- Een simpelere indeling: vijf vaste plekken, **Meer** is opgegaan in een overzichtelijke **Instellingen**, en
  expertpanelen staan achter **Geavanceerd tonen**. Een bot maken vraagt drie dingen.

**Geheugen**
- Zoeken op betekenis (met een lokaal zoekmodel via Ollama), PDF en Word in dossiers, "ja, doe maar" onthoudt het
  voorstel, en vaste veiligheidsregels blijven altijd geladen.

**Veilig en betrouwbaar**
- Standaard dicht: alleen bereikbaar op je eigen pc, sterkere wachtwoorden, privacylabel per bot, en **Wat verlaat je
  pc?** in gewone woorden. Sleutels komen nergens meer in logs of foutmeldingen.
- Routines tellen pas als geslaagd met bewijs; *verwacht om …, niet gedraaid* en een lijst *gemist terwijl je pc uit
  stond*.
- Een **Prullenbak** voor wat bots wissen of overschrijven, en een momentopname per run. **Alles stoppen** stopt echt
  alles wat TeamBot startte.
- Back-ups met één klik terugzetten, een back-up vóór elke update met een weg terug, en vaste motorversies met een
  zelftest die geen tegoed kost.
- Een veilige eigen skills-catalogus (69 skills, vastgezette versies, licentie per map, updates alleen als zichtbaar
  verschil, scripts uit tot jij ze vertrouwt) en vastgezette apps.

**Kanalen en spraak**
- Telegram als makkelijkste kanaal; WhatsApp voor bedrijven officieel, de QR-koppeling alleen na een waarschuwing.
  Een kanaal heet pas *verbonden* na een echte test van ontvangen en versturen.
- Klantmodus: de bot zegt dat hij AI is, zet een vraag door naar jou als hij het niet weet, verzint geen beleid, en
  alles over geld of beloftes wacht op jouw goedkeuring.
- Indrukken-om-te-praten op de pc, zien welke bot luistert en spreekt (ook in groepen), en geen echo meer.

**Telefoon en website**
- De iPhone-app via TestFlight: een toestemmingsscherm, eerlijke status per verbindingsstap en een koppeling die
  updates en netwerkwissels overleeft.
- Een nieuwe website met eerlijke prijzen (€ 0) en een pagina over veiligheid en privacy.

### Bekend en daarna
- Nog in aanbouw voor 0.4.1: zoeken op betekenis zonder Ollama (ingebouwd zoekmodel), feiten die zichzelf vernieuwen en
  een vaste omvang van het geheugen, lessen voor het hele team, en teamscheiding voor kanalen, skills en routines.
- Na 0.4: de telefoon overal bereikbaar zonder Tailscale of account, Mac en Linux, doorwerken als de pc uit staat.

## [0.3.0] — 2026-11-08

Alles sinds 0.2.0: drie fixrondes, acceptatierondes 4, 5 en 6 in de echte app met echte gratis AI, en de
pariteitspunten uit de vergelijking met OpenBot 0.65. Je data in `%APPDATA%\TeamBot` blijft bij het bijwerken staan. De
installer is nog niet ondertekend; zie `docs/RELEASE_CHECKLIST.md`.

### Toegevoegd

**Chat en bots**
- Geschiedenis wissen van een bot of een groep: de gesprekken en hun bijlagen gaan weg; de bot of groep,
  herinneringen, dossiers, routines, taken en werkmappen blijven. Vooraf staat precies wat weggaat en wat blijft.
- Pagina's die een bot maakte als tabbladen naast de chat, met **Groot openen** en **Citeren** (een stuk terug in je
  bericht).
- Antwoordstijl *Natuurlijk* of *Zakelijk* per bot, voor elke engine.
- Bijsturen van een API-engine binnen de lopende beurt; opnieuw proberen zonder dubbele bijwerkingen.
- Onder elk antwoord de naam van de verbinding; **Bronnen** uit het geheugen ook als het model ze zelf niet noemt.
- In de servermodus een gedeelde bot voor het team, met een pagina die alleen de eigenaar ziet.

**Gratis werken**
- Ollama als reserve, met één klik verder op een ander model als een limiet op is en één melding.
- TeamBot's eigen OpenCode 2.2.6 van GitHub met vastgezette SHA-256.
- *Probeer met Ollama* als het profiel maken op een limiet stuit; een eerste bot op een losse Ollama krijgt meteen een
  chatmodel.
- Elk verzoek aan Ollama past in het contextvenster: lange tool-uitvoer wordt ingekort, apps die de beurt niet nodig
  heeft vallen weg, en de vraag blijft altijd staan. Een melding onder het antwoord zegt het.

**Bestanden en oefenen**
- Een verplaatst of hernoemd bestand in de repetitie is één wijziging **verplaatst** (oud → nieuw), toe te passen of
  te verwerpen als geheel. Een verwijdering waarvan de inhoud alleen in een niet-toegepast nieuw bestand staat, wordt
  nooit alleen toegepast.
- Twee repetities naast elkaar vergelijken; versies van meerdere bots per bestand.
- Eén goedkeuring per schrijfactie in de teammap.

**Spraak**
- Lokale voorleesstemmen voor Portugees, Pools en Turks (permissieve licenties, vastgezet); Arabisch leest de
  systeemstem.
- Dicteren kiest het spraakmodel van de dicteertaal en zegt welk.
- Gedicteerde tekst en het teruggezette klembord komen niet in de klembordgeschiedenis (Win+V) of het cloudklembord.

**Geld, limieten en modellen**
- Bedragen in de notatie van de lezer, ook in opgeslagen berichten; een eigen prijs in **Modelgegevens**;
  modelgegevens voor de standaard van Claude Code en voor OpenAI-modellen.
- Het dagbudget wordt vóór elke modelaanroep bekeken; een beurt die de grens bereikt, stopt tussen twee stappen. De
  bot zegt **daglimiet bereikt**, wanneer hij weer werkt en waar je de limiet verhoogt; **Kosten** toont het gebruik
  van vandaag.
- Google Sheets in de catalogus (beperkt beschikbaar, zoals Gmail, Drive en Agenda).

**Installer en beveiliging**
- Bij het verwijderen vraagt de installer of je gegevens ook weg moeten: standaard *Nee*, nooit bij een update of
  stil verwijderen.
- De geheimenscan kijkt ook in `app.asar`.

**Documentatie**
- De handleiding is herschreven (20 hoofdstukken, gecontroleerd in de echte app, niet-geteste delen gemarkeerd), met
  een handleidingpagina op de website.

### Gewijzigd

- **Talen:** geen Nederlands meer in de andere talen (strengere controle over 77 pagina's); 157 gemiste en 323 nieuwe
  teksten vertaald in alle 10 talen; echte enkelvoud- en meervoudsvormen op ongeveer 140 plekken ("1 tool", "1 run",
  "elk uur"); maten, procenten, datums en tijden in de taal van de app. Een test bewaakt kale "{n} meervoud" en
  handgemaakte maten.
- **Stappen in gewone woorden:** geen interne id's of werkmappaden meer; "Voerde uit: …" voor opdrachten; één stap per
  TeamBot-tool bij Claude Code, Codex en OpenCode; tegenwoordige tijd zolang een kaart wacht.
- **Foutmeldingen:** een sjabloonfout van een lokaal model ("Dit model kan dit gesprek niet verwerken") en te veel
  tools voor het contextvenster worden eerlijk benoemd, niet meer als "overbelast" of "gesprek te lang".

### Opgelost

- OpenCode: na een weigering door TeamBot's eigen grenzen maakt de bot de rest af in een vervolgbeurt; een kaart
  voor een actie die OpenCode al had opgegeven wordt ingetrokken; de gratis limiet stopt de beurt in seconden.
- Schrijven in een alleen-lezen map of buiten de mappen wordt geweigerd vóór de goedkeuringskaart, met het volledige
  pad als hulp.
- Een groepsgesprek (spraak) in een groep zonder leider komt weer in de geschiedenis; het `/`- en `$`-menu werkt in
  groepschats; een nieuw webhook-kanaal volgt de naam van wie antwoordt.
- Een externe afzender zonder tools krijgt een eerlijk "dat kan ik hier niet" in plaats van een verzonnen antwoord; een
  spraakmemo komt bij het model aan als wat jij zei.
- Geen valse belofte van opnieuw proberen na een wissel; Claude-inlogcodes; samenvatten met een denkend model;
  kopiëren zonder klembordtoestemming; geen console-404 na het verwijderen van een kanaal of voor ontbrekende
  app-iconen.
- Poorten: `market-speed` hangt niet meer van de drukte op de pc af; `status:check` probeert een schermafdruk opnieuw
  bij een GPU-hapering.

### Beveiliging

- Dreigingsmodel: rijen voor het paginapaneel en Citeren, de geheimenscan in `app.asar`, dicteren buiten de
  klembordgeschiedenis en het importeren van teams.

## [0.2.0] — 2026-11-07

Alles sinds 0.1.0, de serverkern van 6 november. De Windows-installer is nog niet ondertekend en er is nog geen
openbare releasepagina; zie `docs/RELEASE_CHECKLIST.md` voor wat getest is en wat nog openstaat.

### Toegevoegd

**Uiterlijk en eerste start**
- Eigen botfiguren met stemmingen (rustig, aan het werk, wacht op jou, klaar, pauze, probleem), altijd met een korte
  tekst erbij; gezicht-editor; stijl *Glad* of *Vilt*.
- Monochroom ontwerp in licht en donker, bots centraal in de zijbalk, telefoonweergave zoals een chat-app, oranje
  app-icoon, link *Naar de inhoud*.
- Welkomstscherm met één knop: TeamBot laat zien welke AI er al op de pc staat en maakt de eerste bot. *Gratis
  starten* zet OpenCode met een gratis model klaar als er nog niets is.
- OpenBot-team overzetten: bots, skills, herinneringen, teammap en routines (die komen uitgeschakeld binnen); OpenBot
  zelf wordt niet aangeraakt.

**AI en engines**
- Claude Code, Codex en OpenCode krijgen alle TeamBot-tools via MCP per run: geheugen, samenwerken, eigen browser,
  bureaublad, skills, routines, bestanden en kanalen.
- TeamBot installeert zijn eigen kopie van Claude Code, Codex en OpenCode: per gebruiker, zonder installatiescripts,
  met controle van de npm-handtekening en de SHA-512 en een vastgezette versie. Inloggen start vanuit de app (Codex
  via een apparaatcode).
- Reservelijst tot 5 engines (ook CLI's), met één melding bij een wissel en de reserve in de kop van de chat.
- Per model: tools, afbeeldingen, contextvenster en prijs (of "onbekend"); denkniveaus per engine en model; het
  contextvenster van lokale modellen (Ollama, LM Studio, llama.cpp) is in te stellen.
- 35 API-aanbieders (24 clouddiensten, een eigen OpenAI-compatibel adres en 10 lokale servers) en 18 agent-CLI's naast
  Claude Code, Codex en OpenCode, plus een eigen ACP-agent.
- Toegangsniveaus *Alleen chat* en *Volledige toegang* naast alleen lezen, vraagt toestemming en automatisch.
- Engine-fouten in gewone taal: inloggen, limiet, netwerk, niet geïnstalleerd, onbekend model, overbelast.

**Bots en chat**
- Wachtrij en bijsturen terwijl een bot werkt; vertakken vanaf elk bericht; contextcompactie.
- Codeblokken en codebestanden met syntaxkleuren; een pdf of Word-bestand lezen is één stap (`read_document`).
- Zijpaneel met de bestanden die de bot in dit gesprek maakte of wijzigde; *Wat … zag en deed* per bot (bestanden,
  webpagina's, opdrachten, goedkeuringen).
- Formulieren en interactieve HTML-previews in de chat, linkvoorbeelden, schermafbeeldingen voor vision-modellen,
  bestandsvoorbeelden, downloads, slash-menu.

**Samenwerken en organisatie**
- Groepen met vier werkwijzen (lead, om de beurt, iedereen, vermelding), delegeren, broadcast, handoff, menselijke
  leden en een kostenledger.
- Bots vragen elkaar asynchroon dingen en worden gewekt met het antwoord, met grenzen per uur en per keten.
- Organisatie: teams en afdelingen met een chief of staff, functies en rapportagelijnen; een groep hoort bij een team
  en kent het organigram.
- Teams uit een sjabloon (Onderzoek en schrijven, Klantenservice, Softwareteam) en hele teams als pakket
  (`teambot.team/v1`): exporteren zonder gesprekken, geheugen of sleutels, met een voorbeeld vóór het importeren.
- Per groep een takenbord en gedeelde groepsbestanden; een chat-app kan aan een groep gekoppeld worden.

**Routines**
- Schema's (ook maandelijks: laatste werkdag, eerste maandag …), webhooks, feeds, mappen en chatberichten als trigger,
  ketens, wachten op de reset van een limiet, resultaat naar een kanaal, routines in de hoofdchat.
- Kalender per week en maand met geplande runs en de geschiedenis.
- `wait_for` ("laat me weten als …"): een bot wacht op een bestand, een bericht, een webhook of een tijdstip en gaat
  verder in hetzelfde gesprek.
- *Houd de pc wakker terwijl routines of taken lopen* (standaard uit, met een zichtbare melding).

**Geheugen**
- Geheugen dat zichzelf bijwerkt, met bron, versies, ongedaan maken en dossiers per project.
- Vergeten wist ook fysiek: `secure_delete`, de zoekindex en de WAL worden opgeschoond.

**Marktplaats, apps en pakketten**
- Skills uit 13 openbare GitHub-verzamelingen en skills.sh, apps uit het officiële MCP-register, met licentiecontrole.
- Icoontjes van apps komen via TeamBot zelf, niet rechtstreeks van de website van de maker.
- Delen op een gedeelde server gaat via een beoordeling door de eigenaar of een beheerder.
- Ondertekende pakketten met de SDK (`npm run pack:package`); beheerders kiezen alles, alleen ondertekend of alleen
  vertrouwde uitgevers.

**Computer en browser**
- Computer use op het eigen bureaublad (standaard uit) met niveaus per actie, per taak of volledig, harde blokkades,
  noodstop Ctrl+Alt+Esc, pauze bij muisbeweging, overnemen en live beeld.
- Eigen browser per bot met profielen, proxy en beeld-in-beeld; kluis voor bots met import uit Bitwarden en Chrome.
- Oefenronde naast de echte map: per bestand beide versies naast elkaar, toepassen of verwerpen.
- Eigen server via SSH en cloud-VM's bij Hetzner of DigitalOcean (ook GPU), met de kosten vooraf.

**Spraak**
- Lokaal en gratis: dicteren (ook in elk ander programma met een sneltoets, standaard uit), voorlezen in 7 talen dat
  na de eerste zin begint, en een live gesprek met onderbreken.
- Spraakberichten uit WhatsApp en Telegram (Ogg/Opus) worden lokaal omgezet in tekst.
- Groepsgesprek met spraak, vergadernotities, gespreksgeschiedenis; OpenAI Realtime als betaalde optie.

**Kanalen en telefoon**
- WhatsApp via een QR-code (praten vanuit "Bericht aan jezelf"), Telegram, Discord, Slack, e-mail, WhatsApp Cloud en
  webhooks; bots versturen bestanden op alle kanalen.
- Telefoon via Tailscale met één knop (https, alleen eigen apparaten), koppelen met een QR-code, push, concepten
  offline, app-vergrendeling, delen vanuit andere apps.

**Talen**
- De interface in 11 talen (Nederlands, Engels, Duits, Frans, Spaans, Italiaans, Portugees, Pools, Turks, Oekraïens
  en Arabisch van rechts naar links), met datums, getallen en meervouden per taal. Bots antwoorden in de taal van de
  gebruiker; server-, desktop- en telefoonteksten volgen de taal van de eigenaar.

**Eigen server, cloud en beheer**
- Docker self-host met uitnodigingen, rollen, ledenbeleid en budgetten; SSO (OpenID Connect) en SCIM.
- TeamBot Cloud (`cloud/`) en dedicated installaties (`deploy/dedicated/`) als gebouwde, maar nog niet in productie
  geteste onderdelen; SLA als concept (`docs/SLA.md`).

**Desktop, release en documentatie**
- Desktop-app (Electron) met ingebouwde server, systeemvak, badge op de taakbalk, zwevend statusvenster en
  automatisch bijwerken (melding, downloaden na een klik, installeren bij opnieuw starten).
- Hoofdsleutel in de sleutelkluis van het systeem: DPAPI op Windows, Keychain op macOS, libsecret/KWallet op Linux.
- Windows-installer (NSIS) met LICENSE, NOTICE, THIRD_PARTY_NOTICES.txt en de SBOM (`sbom.cdx.json`); licentiecheck,
  secret scan (`npm run secrets:check`) en build-provenance in de release-workflow.
- Productwebsite (`website/`) in het Nederlands en Engels, met echte schermafbeeldingen.

### Opgelost
- Prestaties: elk nieuw of bewerkt bericht doorzocht de hele zoekindex. Bij 50.000 berichten kostte één bericht
  ±11 ms en dat liep steeds verder op; een koppeltabel maakt het constant (±0,1 ms).
- De server meldde altijd versie 0.1.0; de versie komt nu uit `package.json`.
- Bureaubladbediening: het naar voren halen van een venster liet de eerste toets verdwijnen; klassieke
  Windows-knoppen en -tekstvakken verschenen als naamloze "Pane"; hun wachtwoordvelden werden niet herkend.
- Codex in *Vraagt toestemming* schrijft via een goedkeuringskaart in plaats van stil te mislukken; Claude Code in
  *Alleen chat* weet dat hij geen tools heeft; een stille routine laat geen technische tekst meer achter.
- CLI-fouten zonder terminalkleurcodes; modellen in woorden ("Opus 5.5" in plaats van de technische naam).

### Beveiliging
- Acties met impact vragen altijd om akkoord, ook bij een per-tool *Toestaan*.
- Claude Code-bots krijgen nooit de eigen plannings-, cloud-, berichten- en workflowtools van Claude Code.
- OpenCode (ACP) keurde in vraag-modus zelf bewerkingen goed (live gevonden); TeamBot laat elke bewerking, opdracht
  en webactie nu vragen, en een ACP-agent die iets wijzigt zonder te vragen wordt gestopt en geblokkeerd.
- Scripts van een niet-vertrouwde skill worden geweigerd voordat er een goedkeuringskaart komt.
- `web_fetch`, linkvoorbeelden, providers, spraak en SearXNG controleren elke redirect op privé-adressen (SSRF, met
  `net.BlockList`, ook IPv4-in-IPv6/NAT64).
- Klassieke Windows-wachtwoordvelden (`ES_PASSWORD`) worden herkend: een bot typt er nooit in.
- `web-push` (MPL-2.0) vervangen door een eigen implementatie.
- Beveiligingsreview (2026-11-06) verwerkt: een bot draait alleen in gesprekken van zijn eigen eigenaar; bijlagen
  alleen inline als ze veilig zijn; externe afbeeldingen en linkvoorbeelden pas na een klik; ledenbeleid op alle
  paden; berichten verwijderen alleen door de schrijver of de eigenaar; beperkte rechten voor telefoons.
- Geen sessietoken in URL's: links naar bestanden en streams zijn gesigneerd en kort geldig.

## [0.1.0] — 2026-11-06 (kern)
- Server-kern: auth, secrets, audit, runs, Broker, 20 API-providers, basistools, REST + WebSocket, tests.
