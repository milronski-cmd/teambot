# Plan — TeamBot 0.4

Opgesteld: 9 november 2026 · Basis: TeamBot 0.3.0 (git `17d548d`, geïnstalleerd bij de eigenaar sinds 8 november)

Bronnen voor dit plan:
- de wensen van de eigenaar uit het gesprek van 9 november (hieronder volledig);
- het onderzoek *Knelpunten gebruikers alle AI bots* (9 november 2026, 10 deelonderzoeken, ±210 bronnen):
  `%USERPROFILE%\Documents\TeamBot\reports\Knelpunten gebruikers alle AI bots.md`, notities in
  `%USERPROFILE%\Documents\TeamBot\research_notes\Knelpunten gebruikers alle AI bots\`;
- de stand van 0.3.0 in `docs/STATUS.md` en de code zelf.

## Doel in één zin

TeamBot 0.4 is de app waarin één eigenaar een hoofdbot en meerdere, strikt gescheiden teams van bots laat
samenwerken, voor wat hij maar wil (bedrijven runnen, zijn privéleven, of iets heel anders), met specialisten die
zelf kennis opdoen in hun vakgebied. Het blijft gratis doordraaien als een model op is, faalt nooit stil, verandert
nooit stil iets, bewijst dat werk af is, en ziet er voor een gewoon mens simpel en rustig uit: op de pc, op de iPhone
(TestFlight) en op een mooie website.

## Wat de eigenaar vroeg (9 november)

1. Nieuw onderzoek naar wat mensen bij álle botprogramma's tegenkomen. *(gedaan, zie bronnen)*
2. Meerdere teams, zodat hij met verschillende teams (bijvoorbeeld per bedrijf) kan werken. Eerst is één team genoeg,
   maar de optie moet er zijn. Sleutels moeten voor elk team bruikbaar kunnen zijn, en per bot moet hij kunnen kiezen
   tot welke teams die toegang heeft, zodat een echt goede leider ook de teamleiders kan aansturen.
3. Eén hoofdbot kunnen aanmaken; de bot moet echt goed zijn werk doen.
4. Na installatie leeg beginnen, zonder vooraf ingerichte bots, en dan alles makkelijk zelf aanmaken, net als bij
   andere botprogramma's.
5. Een betere, overzichtelijkere indeling. De UI moet simpel blijven voor de normale mens, niet zo uitgebreid dat
   mensen het niet snappen.
6. Het geheugen moet standaard al goed zijn.
7. Raakt een gratis model op, dan automatisch over naar een ander gratis model; belangrijke taken moeten dan worden
   stilgezet.
8. Een mooie gebruiksbalk voor de (week)limiet van Claude, zoals in OpenBot.
9. Gratis modelrouting en gratis skills van GitHub gebruiken waar dat kan.
10. Meer functies, en het systeem slimmer, beter en efficiënter maken.
11. Een mooie website en een iPhone-app die goed werkt, via TestFlight.
12. Het doel: teams maken die bedrijven runnen, het privéleven, of iets anders, en die samenwerken; met nog veel meer
    doeleinden en functies.
13. Echte specialisten kunnen trainen die slim zijn en zelf kennis opdoen voor hun vakgebied.

## Wat het onderzoek ons leert (kort)

Mensen haken bij AI-bots niet af omdat de bots te dom zijn, maar door **stille verrassingen**: limieten die
ongemerkt krimpen, een model dat zonder vragen wordt vervangen, routines die stil niet draaien, "klaar" zonder
bewijs, een bot die te veel wist, gegevens die tussen klanten door elkaar lopen, en platforms die een kanaal of
abonnement dichtzetten. De winst voor 0.4 zit daarom vooral in **eerlijkheid en voorspelbaarheid**. Drie dingen
heeft geen enkel onderzocht product, en TeamBot krijgt ze wel: een belangrijke taak pauzeren in plaats van op een
zwakker model door te gaan, zien welke van meerdere bots luistert in spraak, en harde scheiding per bedrijf zonder
Enterprise-prijs.

Regels die uit het onderzoek volgen en in heel 0.4 gelden:
- **Nooit stil iets veranderen.** Elk antwoord zegt welk model het gaf; bij uitwijken ook waarom.
- **Veiligheid in de code, niet in de instructie.** Een regel als "vraag eerst" mag niet kunnen wegvallen als een
  gesprek wordt samengevat.
- **Bewijs bij elke "klaar"**, en een melding als iets níet gebeurde.
- **Alles wat de pc verlaat, staat standaard uit** en heeft een zichtbaar label (blijft op je pc / bewaart niets /
  kan trainen).
- **Elke externe afhankelijkheid kan wegvallen**: dan een melding, een alternatief en een pauze, nooit een stille
  noodgreep.

## Wat al werkt en blijft (niet opnieuw bouwen)

Reserve-engines per bot (tot 5, met terugkeer na de reset), keuze bij een limiet (overschakelen, wachten, stoppen),
limieten van Claude (5 uur, week) en Codex uitlezen, het model en de kosten onder elk antwoord, dagbudget per stap,
het geheugen (zelf leren uit je eigen woorden, nachtelijk onderhoud, bronnen, vergeten, per bot privé), dossiers,
groepen met delegeren, organisatie met teamleider en leden, takenbord, routines met keuze voor gemiste runs,
oefenmodus en terugdraaien, kanalen (Telegram, WhatsApp officieel en via QR, Discord, Slack, e-mail), lokale spraak
en dicteren, de eerste start met één knop, de iPhone-broncode (SwiftUI, QR-koppelen, Keychain, APNs) en de website-
broncode (14 pagina's). 0.4 bouwt hierop voort.

## Werkpakketten

Elk pakket heeft een **klaar als**: een acceptatietest in de echte app, met echte gratis AI, die moet slagen.

### A. Indeling en eenvoud

Nu verwarrend: twee takenborden (Teamwerk en Groepen), groepen én teams, ±18 pagina's onder **Meer**, gebruik en
limieten verstopt, Teamwerk met zes ontwikkelaarstabbladen.

- **Teamkiezer bovenaan** de zijbalk (zoals werkruimtes in Slack): *Alle teams* of één team. Naam en kleur van het
  actieve team altijd in beeld.
- In de zijbalk: de **hoofdbot** bovenaan, daaronder het **teamgesprek** en de bots van het team.
- **Vijf vaste knoppen**: *Taken* (één bord), *Routines*, *Geheugen*, *Marktplaats*, *Instellingen*; daarboven
  *Wacht op jou* met teller. **Meer verdwijnt**: kanalen, apps, spraak, computers, meldingen, sites en mappen komen
  ingedeeld onder Instellingen (per team waar dat hoort).
- **De gebruiksbalk staat altijd onderin** (pakket E).
- **Eenvoudig is de standaard.** Beslissingen, gebeurtenissen, experimenten, tabellen en de inspector staan achter
  *Instellingen › Geavanceerd tonen*.
- **Bot aanmaken = drie vragen**: naam, wat hij doet, welk model (automatisch voorgesteld). De rest onder *Meer
  opties*, dichtgeklapt.
- **De chat blokkeert nooit** tijdens een run; meldingen van routines en het overleg tussen bots krijgen een eigen
  plek en overspoelen het gesprek met de eigenaar niet (drie stromen: jouw gesprekken, overleg tussen bots,
  automatische runs).

**Klaar als:** iemand die TeamBot nooit zag maakt binnen 2 minuten een bot en krijgt antwoord, zonder handleiding;
elke pagina is in hoogstens 2 klikken vanuit de zijbalk te bereiken; `a11y`, `mobile:check` en `i18n:check` groen.

### B. Meerdere teams (harde muren, met toegang per bot)

Teams bestaan nu alleen als organigram (`room_teams`: teamleider, leden, afdelingen). In 0.4 wordt een team een
**afgeschermde werkruimte**. De eigenaar begint met één team; meer teams is een optie die er altijd is.

- elk team heeft een eigen **map**, **geheugen en dossiers**, **kanalen**, **skills**, **routines**, **budget** en
  **logboek**;
- **sleutels en logins** staan in één kluis en zijn **standaard voor alle teams**; per sleutel kan de eigenaar kiezen
  voor *alleen dit team* (bijvoorbeeld de webshopsleutel van één bedrijf);
- elke bot heeft een **thuisteam**, en per bot kiest de eigenaar **tot welke andere teams hij toegang heeft**: *geen*
  (standaard), *meekijken* (gedeelde teamkennis en de teammap lezen) of *aansturen* (taken geven aan de teamleider
  en de bots van dat team). Zo kan één sterke leider meerdere teams en hun teamleiders aansturen;
- zolang er één team is, is er **geen teamkiezer** in beeld (simpel); die verschijnt vanaf het tweede team;
- **groep en team worden één begrip**: een team heeft een teamgesprek; extra groepen binnen een team kan, onder
  Geavanceerd;
- delen tussen teams gebeurt alleen als zichtbare, bewuste handeling (toegang per bot, een gedeelde sleutel), en
  **kopiëren gaat boven koppelen**;
- een team **dupliceren** of **exporteren als sjabloon** neemt bots, instructies en routines mee, maar nooit
  geheugen, sleutels, kanalen of gesprekken (zoals nu al bij teampakketten);
- *Alle teams* toont één overzicht: resultaten, fouten, gemiste runs, wat op jou wacht en verbruik per team;
- een **bedrijfsprofiel per team** (naam, wat het bedrijf doet, toon, regels) dat elke bot in dat team meekrijgt;
- meldingen voor alle teams in één keer in te stellen;
- **migratie**: bij een update komt alles wat er al is in één team *Mijn team*; een nieuwe installatie begint leeg.

**Klaar als:** twee teams met elk een bot, map en geheugen, plus een sleutel *alleen voor team A*; een bot van team
A zonder toegang kan op geen enkele manier (tools, zoeken, geheugen, bestanden, kanalen, sleutels) iets van team B
lezen of schrijven, bewezen met een test die het actief probeert; een bot met *meekijken* leest de teamkennis van B
maar schrijft niets; een bot met *aansturen* geeft de teamleider van B een taak; een gedeelde sleutel werkt in beide
teams; overzicht *Alle teams* klopt.

### C. Hoofdbot, leiders, teamleiders en werk dat echt af is

- **De eigenaar maakt de hoofdbot zelf aan** (een keuze bij *Nieuwe bot*: hoofdbot of gewone bot). Er is er
  hoogstens één. Hij is de vaste voordeur, ook op de telefoon: je praat met hem, hij zet werk door naar het juiste
  team en meldt terug. De hoofdbot heeft standaard *aansturen* op alle teams.
- **Leiders**: elke andere bot kan met toegang *aansturen* (pakket B) de leider worden van meerdere teams en hun
  teamleiders aansturen. Zo organiseert de eigenaar zijn bedrijf zoals hij wil: hoofdbot → leider → teamleiders →
  bots.
- Een bot met toegang tot meerdere teams neemt **geen geheugen van het ene team mee naar het andere**; hij krijgt van
  een team alleen wat zijn toegang toestaat en wat de teamleider rapporteert.
- Elk team heeft **één teamleider met het laatste woord**; helpers lezen en zoeken vooral. Begrensd aantal stappen en
  een begrensde diepte van doorgeven (geen eindeloze ketens van bots die elkaar opdrachten geven).
- **"Klaar als…"** bij elke taak (de bot stelt het voor, de eigenaar kan het aanpassen).
- **Controlestap vóór elke "klaar"**: een tweede blik met een schone context controleert het werk tegen het
  "klaar als" en hangt het **bewijs** aan de taak (bestand, link, verstuurd bericht, schermafbeelding). Zonder bewijs
  geen "klaar" maar "te controleren". (Onderzoek: één controlestap gaf +15,6% slagingskans.)
- **Eerlijk bij onmacht**: kan iets niet, dan zegt de bot dat en waarom; hij verzint geen resultaat.
- **Leren van correcties**: zegt de eigenaar "nee, zo doen we dat niet", dan wordt dat een vaste les van het team
  (zichtbaar in Geheugen, met ongedaan maken). Doet een bot een terugkerende klus goed, dan stelt hij voor er een
  skill van te maken.
- **Geen dubbel werk**: een taak op het bord wordt geclaimd door één bot.
- **Lussen stoppen**: drie keer dezelfde stap zonder vooruitgang → de bot stopt en vraagt hulp.

**Klaar als:** de hoofdbot verdeelt een opdracht over twee teams en meldt terug met bewijs; een taak met een
opzettelijk fout resultaat komt op "te controleren" en niet op "klaar"; een bot in een lus stopt zelf.

### D. Gratis modellen: automatisch doorschakelen en belangrijke taken pauzeren

Feiten uit het onderzoek (stand 9 november 2026): GitHub Models is gestopt (30 juli 2026), Ollama Cloud heeft geen
gratis plan meer, Cerebras/Hugging Face/SambaNova/Together zijn proef of betaald. Elke dag gratis bruikbaar:
OpenCode Zen (alleen via OpenCode zelf), OpenRouter `:free` (50 per dag, 1.000 na eenmalig $10), Groq (±1.000 per
dag per model), Cloudflare Workers AI (10.000 neurons per dag), Kilo (200 per uur, zonder sleutel), Z.ai GLM Flash,
en lokaal Ollama. Tegoed telt **per account of project, niet per model**: wisselen naar een ander model bij dezelfde
aanbieder helpt niet, naar een andere aanbieder wel.

- **Standaard aan, voor het hele team** (niet per bot invullen): hoofdmodel → ander abonnement → gratis aanbieders
  (eerst een *andere* aanbieder, eerst hetzelfde soort model) → lokaal Ollama. Per team aan te passen.
- **Tegoed per account bijhouden**, met de bekende resetmomenten; waar het kan rechtstreeks uitgelezen (OpenRouter
  `/api/v1/key`, Groq `x-ratelimit`-headers). Een 429 = wachten tot de reset; 404/410 = model weg.
- **Catalogus met echte proef**: elk gratis model krijgt een kleine proefaanvraag met een tool en een label *tools
  werken* of *alleen tekst*, plus een privacylabel. Proeven zijn begrensd (hoogstens één per model per dag) zodat ze
  het gratis tegoed niet opmaken.
- **Antwoorden zelf controleren**: "gelukt" met een fout in de tekst, of een afgekapt antwoord, telt als mislukt.
- **Belangrijk-schakelaar** op taken en routines: een belangrijke taak heeft een minimumniveau (bijvoorbeeld *alleen
  Claude of Codex*). Is daarbinnen niets beschikbaar, dan **pauzeert** de taak met reden en verwachte hervattijd, de
  eigenaar krijgt een melding (ook op de telefoon), en de taak gaat vanzelf verder na de reset. Gewoon werk schakelt
  door.
- **Privéwerk** (persoonlijke gegevens, gevoelige dossiers) gaat alleen naar lokaal Ollama of naar bronnen die niets
  bewaren.
- **Ideeën overnemen, geen code inbedden**: van LiteLLM (MIT) afkoelen na een 429 en de volgorde van reserves; van
  free-coding-models (MIT) eerst dezelfde modelfamilie bij een andere aanbieder en de toolproef.
- Gratis sleutels (Groq, OpenRouter, Cloudflare) vult de gebruiker zelf in, met één klik naar de aanmeldpagina;
  TeamBot werkt ook zonder.

**Klaar als:** met een gesimuleerde limiet op OpenCode schakelt een gewone taak zichtbaar door naar een andere
gratis aanbieder en daarna naar Ollama; een belangrijke taak pauzeert met hervattijd, de melding komt binnen, en de
taak gaat na de (gesimuleerde) reset zelf verder; een verdwenen model valt uit de keten zonder fout voor de
gebruiker.

### E. Gebruiksbalk en zuinig met limieten

De gegevens zijn er al (`server/modules/usage`), alleen niet in beeld.

- **Vaste balk onderin de zijbalk**, zoals OpenBot: Claude 5 uur en week (en Opus-week als die er is), Codex 5 uur en
  week, en per gratis bron een bolletje (beschikbaar / op tot …). Groen, oranje vanaf 80%, rood bij de limiet, met
  de resettijd.
- Label **schatting** waar de aanbieder geen exacte getallen geeft, en de uitleg dat de pot **gedeeld** is met je
  eigen gebruik van Claude en ChatGPT buiten TeamBot.
- Klik op de balk: verbruik per team en per bot, vandaag en deze week.
- **Weekreserve**: boven een in te stellen grens (standaard 85% van de Claude-week) gaat gewoon werk alvast naar
  gratis modellen, zodat Claude overblijft voor belangrijk werk.
- **Zwaar werk slim plannen**: routines die niet haastig zijn, verdelen zich over de vijfuursvensters en de nacht.
- Melding op pc en telefoon vóór de grens (80%) en bij de grens.

**Klaar als:** de balk toont de echte cijfers van Claude en Codex van de eigenaar en verspringt binnen een minuut na
nieuw gebruik; boven de weekreserve gaat een gewone taak naar een gratis model en een belangrijke niet.

### F. Geheugen: standaard goed

Werkt al standaard (zelf leren, nachtelijk onderhoud, bronnen, vergeten). Het geheugen moet voor **iedereen** goed
werken, ook zonder lokaal model, en zichzelf slim bijhouden zonder oneindig te groeien. Wat beter moet:

- **Zoeken op betekenis voor iedereen** naast zoeken op woorden ("wagen" vindt "auto"): een klein, meertalig
  zoekmodel dat TeamBot zelf meebrengt (eenmalige download, draait op de processor, blijft op de pc), Ollama alleen
  als extra; daarnaast bij het leren meteen trefwoorden en synoniemen bij elk feit, zodat ook woordzoeken op
  betekenis vindt. Moet ook mee in vergeten en herindexeren.
- **Zelf bijwerken**: feiten die met de tijd veranderen (prijzen, versies, regels, afspraken) krijgen een
  *herzien op*-datum; het onderhoud en de leerronde van specialisten controleren ze opnieuw en vernieuwen ze (de oude
  versie blijft in de geschiedenis) of markeren ze als *te controleren*.
- **Nooit oneindig groot**: veel kleine feiten over hetzelfde worden samengevat (met bronnen); wat lang niet gebruikt
  of bevestigd is en weinig waarde heeft, gaat naar het archief (niet weg, wel uit de context); een vaste
  doelomvang per team en per bot; vastgezette en door de eigenaar bevestigde dingen blijven altijd. Elke maand een
  kort opruimverslag met ongedaan maken.
- **Lessen voor het hele team**, niet alleen per bot.
- **Meten**: een geheugentest (feiten terugvinden na lange gesprekken, oude feiten die vernieuwd moeten worden,
  tegenspraak) die laat zien hoe goed het werkt, met en zonder lokaal model.
- **PDF en Word** in dossierbronnen doorzoekbaar.
- **"Ja, doe maar" op een voorstel van een bot** telt als bevestiging (met ongedaan maken onder het bericht).
- **Geheugen per team** (pakket B) en lessen van het team (pakket C).
- **Back-up en terugzetten** van het geheugen, als onderdeel van een back-up van de hele app.
- **Veiligheidsregels blijven altijd geladen** en vallen nooit weg bij samenvatten.
- Opnieuw testen wat na 0.3.0 is gerepareerd maar nog niet getest: bronnen bij lokale modellen en de melding bij een
  vol geheugen.

**Klaar als:** een feit dat in andere woorden is opgeslagen wordt gevonden, ook op een pc zonder Ollama; een
PDF-bron wordt geciteerd; "ja, doe maar" levert een herinnering op; een verouderd feit wordt vernieuwd of als *te
controleren* gemarkeerd; het geheugen blijft na een jaar gesimuleerd gebruik binnen de doelomvang zonder dat iets
belangrijks verdwijnt; een back-up terugzetten brengt het geheugen terug zonder vergeten dingen terug te halen; de
geheugentest staat met cijfers in de repo.

### G. Betrouwbaarheid: nooit stil falen, nooit stil te veel doen

- **Routines met bewijs**: geslaagd is pas geslaagd met een resultaat (bericht, bestand). Het overzicht meldt ook wat
  níet gebeurde ("verwacht om 08:00, niet gedraaid"), met een melding.
- **Lijst "gemist terwijl je pc uit stond"**, bovenop de bestaande keuze per routine.
- **Prullenbak** voor bestanden die bots wissen of overschrijven, en een **momentopname** van de teammap vóór een
  run die schrijft; terughalen met één klik.
- **Stopknop die echt stopt**: ook de onderliggende processen van Claude Code, Codex en OpenCode.
- **Toestemming alleen waar het telt**: bij onomkeerbare of naar buiten gerichte acties, met een exacte preview. Geen
  vragenregen (onderzoek: mensen keuren 93% blind goed).
- **Webpagina's, mails en berichten van andere bots zijn nooit een opdracht.**
- **Motorversies vastzetten**: een nieuwe versie van Claude Code, Codex of OpenCode pas na een korte eigen test of
  na akkoord; terug naar de vorige met één klik.
- **Updates van TeamBot zelf**: back-up vooraf, terugzetten met één klik, wijzigingslog in gewone taal.

**Klaar als:** een opzettelijk mislukte routine levert binnen 5 minuten een melding op; een door een bot gewist
bestand komt terug uit de prullenbak; *Alles stoppen* laat geen proces achter.

### H. Skills: een eigen, veilige catalogus

Onderzoek: besmette skills haalden in 2026 samen meer dan 1,7 miljoen downloads, en scanners zijn te omzeilen. Dus:

- **Alleen een eigen catalogus**, door ons samengesteld, op **vastgezette versies** (commit), lokaal opgeslagen, met
  licentie en versie zichtbaar. Een update is een **zichtbaar verschil** dat de eigenaar goedkeurt.
- Alleen leesbare bestanden; skills met scripts draaien pas na akkoord, afgeschermd in de map van het team.
- Uitgevers worden vergeleken met bekende namen (namaak valt op). Installatie **per team**.
- Niets wordt vooraf geïnstalleerd (leeg beginnen); de Marktplaats stelt voor.
- **Startset voor de catalogus** (licenties gecontroleerd op 9 november 2026):
  - `anthropics/knowledge-work-plugins` (Apache-2.0): pakketten voor klein bedrijf, klantenservice, marketing,
    operations en data;
  - `anthropics/skills` documentskills docx/pdf/pptx/xlsx (Apache-2.0 vanaf commit `2c5958ec`); eerst testen op
    Windows (de docx-skill gebruikt LibreOffice met een Linux-truc);
  - `obra/superpowers` (MIT): o.a. *controleren vóór klaar*, plannen, fouten zoeken;
  - `coreyhaines31/marketingskills`, `AgriciDaniel/claude-seo`, `blader/humanizer`,
    `OthmanAdi/planning-with-files` (alle MIT).
- **Apps (MCP)**: Playwright MCP (Apache-2.0), DuckDuckGo-zoeken zonder sleutel (MIT), Jina-lezen, GitHub MCP
  alleen-lezen, Google Workspace. Minimale rechten (bestanden alleen in de map van het team).
- **Niet meeleveren**: CC BY-NC-ND (`awesome-claude-code`), CC-BY-SA (`trailofbits/skills`), Figma-skills, repo's
  zonder licentiebestand, AGPL.

**Klaar als:** een skill uit de catalogus installeren in één team werkt en is in het andere team onzichtbaar; een
gewijzigde bron toont eerst het verschil; een skill met een script draait niet zonder akkoord.

### I. iPhone-app en TestFlight

De broncode staat in `mobile/ios/` (SwiftUI rond de webapp, QR-koppelen, Keychain, APNs) maar is nooit gebouwd.

- **Bouwen zonder eigen Mac** via een cloud-Mac (Codemagic gratis minuten, of GitHub Actions macOS) en automatisch
  uploaden naar **TestFlight, interne testers** (tot 100 mensen, zonder keuring door Apple).
- **Verbinding eerlijk tonen per schakel**: pc slaapt / app dicht / netwerk weg / telefoon offline, met herstel in één
  tik. De koppeling overleeft updates en netwerkwissels; opnieuw koppelen wist nooit gesprekken.
- **Toestemmingsscherm** (Apple-richtlijn 5.1.2(i), sinds 13 november 2025): welke gegevens naar welke AI-aanbieder
  gaan, vóór het eerste gebruik. Geen code downloaden of uitvoeren in de app (richtlijn 2.5.2).
- De telefoon opent op de **hoofdbot**; *Wacht op jou* met goedkeuren; meldingen bij pauzes, fouten en gemiste runs.
- Echt testen op de iPhone van de eigenaar: chat, spraak (microfoon), pushmeldingen, goedkeuren.
- Tot TestFlight er is blijft de PWA werken.

**Klaar als:** de app staat in TestFlight, koppelt via de QR-code met de pc van de eigenaar en doorstaat de test
chat-spraak-melding-goedkeuren op zijn iPhone.

### J. Website

De broncode staat in `website/` (14 pagina's, nl/en), maar is niet online.

- **Nieuw, rustig ontwerp** met echte schermafbeeldingen van 0.4, één duidelijke downloadknop, uitleg in gewone
  woorden.
- **Eerlijke prijzen**: gratis en open source; wat je eventueel zelf betaalt (je eigen abonnementen). Nooit
  "unlimited", geen "beter dan"-claims zonder gepubliceerde meting.
- **Veiligheidspagina**: wat op je pc blijft, wat naar welke AI-aanbieder gaat (dezelfde uitleg als in de app).
- Gratis hosting (Cloudflare Pages of GitHub Pages); de domeinnaam regelt de eigenaar.

**Klaar als:** `website:check` groen (alle breedtes, licht/donker, axe), schermafbeeldingen van 0.4, en de site
staat online op het gekozen adres.

### K. Kanalen

- **Telegram als makkelijke standaard** (eigen bot, geen open poort nodig).
- **WhatsApp voor bedrijven via de officiële Cloud API**; de koppeling via QR blijft, maar achter een duidelijke
  waarschuwing dat het nummer geblokkeerd kan worden.
- Kanalen horen bij één team. Bots die met klanten praten **zeggen dat ze AI zijn**, zetten bij twijfel door naar de
  eigenaar, **verzinnen nooit beleid**, en alles over geld, prijzen, terugbetalingen en beloftes gaat eerst langs de
  eigenaar. Elk antwoord staat in het logboek.

**Klaar als:** een klantvraag die niet in de kennis staat wordt doorgezet naar de eigenaar in plaats van beantwoord;
een antwoord met een prijs wacht op goedkeuring.

### L. Spraak

- **Indrukken-om-te-praten** standaard op de pc; echo-onderdrukking; zichtbaar wélke bot luistert en welke spreekt.
- In spraak hetzelfde model als in tekst; Nederlands als volwaardige taal per bot.

**Klaar als:** `voice:live` groen, en in een groepsgesprek met spraak is steeds te zien welke bot aan de beurt is.

### S. Specialisten die zelf leren

Een bot kan een **specialist** worden in een vakgebied (SEO, belastingen, fitness, een programmeertaal, wat de
eigenaar wil) en wordt daar vanzelf beter in.

- Per bot een **vakgebied** (één zin) en **bronnen**: websites, RSS-feeds, documentatie, eigen bestanden.
- Een **leerronde** (dagelijks of wekelijks; staat uit tot de eigenaar hem aanzet; draait standaard op gratis modellen
  met een begrensd budget): nieuwe inhoud ophalen, de kern eruit halen **met bron en datum**, vergelijken met wat hij
  al weet (dubbel overslaan, tegenspraak markeren als *te controleren*), en opslaan in **zijn kennisbank** (een
  dossier van de bot, later van zijn team).
- Bronnen zijn **gegevens, nooit opdrachten**: een "instructie" in een webpagina wordt niet uitgevoerd en niet als
  regel opgeslagen.
- **Kennisgaten**: waar de bot in gesprekken "weet ik niet" zei, of waar hij een zelftest over zijn vakgebied niet
  haalt, worden **leerdoelen** die de volgende leerronde oppakt.
- Een **leerverslag** voor de eigenaar: wat de specialist deze week leerde, met bronnen; alles is in Geheugen te zien
  en terug te draaien.
- Lessen uit correcties van de eigenaar (pakket C) en werkwijzen die vaak goed gaan worden voorstellen voor een
  **skill** van de specialist; installeren alleen na akkoord.

**Klaar als:** met testbronnen slaat een leerronde feiten met bron op in de kennisbank, slaat een tweede ronde
dubbele over, markeert hij tegenspraak, negeert hij een verborgen instructie in een bron, ontstaat er een
leerverslag, en citeert de bot het geleerde daarna in een antwoord.

### M. Kwaliteit meten

- **Vaste testset van ±30 echte taken** voor de soorten teams van de eigenaar (webshop, SEO en content, advertenties,
  klantenservice, operations, bouwen), elk met een "klaar als". Draait bij elke versie en per model, met een score.
- De scores gaan naar de router (pakket D): die kiest op echte cijfers.
- Plus de bestaande poorten (typecheck, test, e2e, a11y, i18n, mobile, perf, licenses, website, status, secrets) en
  een acceptatieronde 7 voor alles wat nieuw is.

**Klaar als:** de testset draait met Ollama en OpenCode gratis, het verslag staat in de repo, en 0.4 scoort op geen
taak lager dan 0.3.0.

## Volgorde (zo snel mogelijk, met veel subagents tegelijk)

1. **Golf 1, parallel**: B-kern (teams als werkruimte, toegang per bot, kluis met gedeelde en teamsleutels,
   migratie), A (nieuwe indeling), D (gratis keten en pauze), E (gebruiksbalk), F (geheugen), G (betrouwbaarheid),
   H (skills-catalogus), I (iPhone-app en bouwstraat), J (website), K (kanalen), L (spraak), M (testset), S
   (specialisten die leren), plus het kwaliteitsdeel van C (controle vóór klaar, lussen stoppen, lessen),
   veiligheid en privacy standaard dicht, lokale modellen slim kiezen, teamsjablonen (bedrijf én privé), zuiniger
   met tokens, en back-ups/veilig updaten. Elk pakket in een eigen worktree, met afspraken over welke bestanden van
   wie zijn.
2. **Golf 2, op de samengevoegde golf 1**: C (hoofdbot, leiders, controlestap, lessen, lussen stoppen), B afmaken in
   alle modules (kanalen, skills, routines, budget per team), de teamkiezer en de instellingen voor toegang per bot in
   de nieuwe indeling.
3. **Afronden**: vertalingen van alle nieuwe teksten in één keer, M (testset en acceptatieronde 7), alle poorten,
   handleiding en wijzigingslog herschreven, installer `TeamBot-Setup-0.4.0.exe`, TestFlight-build.

## Wat de eigenaar zelf moet doen of kiezen

- **Apple Developer-account**: is er al. Nog nodig: in App Store Connect de app (bundle-id) aanmaken en een **App
  Store Connect API-sleutel** voor het automatisch uploaden naar TestFlight.
- **Cloud-Mac kiezen**: Codemagic (gratis minuten) of GitHub Actions. Beide halen de code uit een git-dienst, dus de
  iOS-code moet naar een **privé-repository** (alleen `mobile/ios` kan ook). Tot nu toe wordt er niets gepusht; dit
  vraagt het akkoord van de eigenaar.
- **Domeinnaam** voor de website.
- **Gratis sleutels** (optioneel): Groq, OpenRouter, Cloudflare.
- **Keuzes**: goedkeuren vanuit een melding op de telefoon (met Face ID) ja of nee; `tailscale serve` omzetten naar
  de echte app (poort 4747) ja of nee; aantal tabbladen op de telefoon.
- **0.4 installeren pas als de eigenaar dat zegt**, met vooraf een extra back-up van `%APPDATA%\TeamBot`.

## Na 0.4 (afgesproken met de eigenaar)

- **Overal bereikbaar zonder gedoe, standaard voor iedereen**: de telefoon-app vindt de pc ook buitenshuis zonder
  Tailscale en zonder account, zoals OpenBot (versleutelde WebRTC na een kort "voorstellen" via een klein
  signaling-dienstje, rechtstreeks tussen telefoon en pc, en alleen als dat niet lukt versleuteld via een
  doorgeefserver), maar betrouwbaarder (bij de eigenaar mislukte OpenBot's verbinding 144 keer) en met eerlijke
  status. Gratis op te zetten op Cloudflare; Tailscale blijft een optie. In 0.4: thuis via wifi, onderweg via
  Tailscale, en Telegram werkt overal.
- Mac en Linux, doorwerken als de pc uit staat, workflows tekenen (achter *Geavanceerd*), voorlezen in meer talen.

## Wat we bewust níet doen

- Abonnementslogins verpakken als algemene API (zoals CLIProxyAPI) of inlogtokens opslaan of doorsturen: TeamBot
  stuurt de officiële Claude Code en Codex ongewijzigd aan en de eigenaar logt daar zelf in. "Claude Code" komt niet
  in de productnaam.
- Meerdere accounts gebruiken om gratis limieten op te stapelen.
- De gratis Gemini-API in de standaardketen (de voorwaarden staan dat niet toe in apps voor gebruikers in de EER).
- De onofficiële WhatsApp-koppeling standaard aanzetten.
- Skills uit open winkels installeren zonder onze catalogus.
- "Unlimited" of "beter dan" op de website.

## Hoe we bouwen

- Grote pakketten parallel met subagents in eigen git-worktrees; samenvoegen op `main` (alleen lokale commits, niet
  pushen), na elke merge typecheck, build, test en e2e.
- Testen altijd met een tijdelijke `TEAMBOT_DATA` en `APPDATA`; nooit de installer draaien op de pc van de eigenaar
  (dat sluit zijn TeamBot).
- Elk pakket is pas af als zijn **klaar als** in de echte app is gehaald; dat staat met bewijs in de acceptatielijst.
- Dit plan wordt bij elke wijziging als geheel herschreven, niet aangevuld.
