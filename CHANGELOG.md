# Changelog

## [0.4.4] — 2026-11-09

De final: simpel en overzichtelijk, en direct na de installer werkend, zoals OpenBot maar beter. De controles staan in
`docs/RELEASE_0.4.4_GATES.md`.

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
