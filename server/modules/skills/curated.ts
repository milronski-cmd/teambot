/**
 * TeamBot's skill catalogue: what the community really uses. The list was made on 2026-11-12 by searching GitHub for
 * repositories with skills in the open SKILL.md format, sorted by stars, and reading a sample of each candidate.
 * A skill is listed only when:
 *  - its repository has an open licence in a licence file (MIT, Apache-2.0, BSD, ISC), checked per skill folder;
 *  - it is not a company's default bundle: the owner wants what people chose themselves, so Anthropic's, Google's,
 *    OpenAI's and Vercel's own packs are not listed (anyone can still add them with "Toevoegen via link");
 *  - the pinned version passed TeamBot's import rules, installed with one click in a test app, and a bot that was
 *    never configured loaded it with skill_load (checked for every entry below on 2026-11-12).
 * `stars` is the repository's star count on that day: shown on every card, and the order of the marketplace.
 *
 * Nothing is bundled with TeamBot: installing fetches exactly the pinned files from GitHub, applies the import rules
 * (`import-rules.ts`) and stores the skill with its licence text. A newer upstream version is shown as a diff that the
 * owner approves; it is never applied by itself. Scripts of a skill stay off until the owner trusts the skill.
 *
 * Looked at and left out (2026-11-12):
 *  - refused by the import rules (too many or too large files, archives): Leonxlnx/taste-skill, tt-a1i/archify,
 *    mvanhorn/last30days-skill, nicobailon/visual-explainer, Agents365-ai/drawio-skill, mikehasa/golive-skill;
 *  - serious findings in the safety scan (they would need a confirmation, so no one-click): OthmanAdi/planning-with-files,
 *    nidhinjs/prompt-master, czlonkowski/n8n-skills n8n-workflow-patterns;
 *  - AgriciDaniel/claude-ads: its main skill is called "ads" like the one of coreyhaines31/marketingskills (one name per
 *    team), and its other skills lean on that main skill;
 *  - no licence file or a restrictive one: vercel-labs/agent-skills, ComposioHQ/awesome-claude-skills,
 *    sickn33/agentic-awesome-skills (CC BY 4.0 texts), trailofbits/skills (CC-BY-SA), hesreallyhim/awesome-claude-code
 *    (CC BY-NC-ND);
 *  - do not work as a loose skill folder: garrytan/gstack, Panniantong/Agent-Reach, nowork-studio/notfair-plugin.
 */

export interface WindowsNote {
  /** 'ja': works on Windows; 'deels': part of it does not; 'niet-getest': has scripts that were not run on Windows. */
  status: 'ja' | 'deels' | 'niet-getest';
  note: string;
}

export interface CuratedSkill {
  /** Folder of the skill inside the repository ('' = the repository root). */
  path: string;
  /** Group shown in the marketplace (e.g. "Klantenservice"). */
  pack: string;
  /** TeamBot's own one-sentence description, in Dutch. */
  note: string;
  category: string;
  /**
   * Folder that relative links of the skill may point into (`../../shared/x.md`); those files are taken along under
   * `_bron/`. Default: the repository root.
   */
  root?: string;
  /** The skill folder contains scripts (installed with scripts off). */
  scripts?: boolean;
  windows?: WindowsNote;
  /** What the skill needs besides TeamBot (programs, accounts), in Dutch. */
  needs?: string;
}

export interface CuratedSource {
  id: string;
  repo: string;
  /** Full commit SHA that installs use. */
  commit: string;
  commitDate: string;
  /**
   * When a TeamBot release moves this pin to a newer commit: one plain Dutch sentence about what changed since the
   * previous pin (shown with the update notice of an installed skill; PARITEIT 7.3).
   */
  pinNote?: string;
  /** GitHub owner (compared with known publishers). */
  owner: string;
  /** Display name of the publisher. */
  publisher: string;
  /**
   * SPDX licence as checked in the licence file of every listed skill folder (or its nearest parent). Empty for a skill
   * outside the catalogue (an open result): TeamBot checked nothing, so there is nothing to compare with.
   */
  license: string;
  verifiedAt: string;
  /** One Dutch sentence about the source. */
  note: string;
  /**
   * GitHub stars of the repository when it was checked (`verifiedAt`): why it is in the catalogue, shown on every card,
   * and the order of the marketplace (most stars first).
   */
  stars?: number;
  skills: CuratedSkill[];
}

export { starsText } from '../../../shared/skills.js';

const VERIFIED = '2026-11-12';

/** A skill with scripts: they are installed switched off, and TeamBot did not run them on Windows. */
const SCRIPTS_OFF: WindowsNote = {
  status: 'niet-getest',
  note: 'De hulpscripts zijn op Windows niet uitgevoerd door TeamBot. De werkwijze zelf werkt zonder; de scripts staan uit tot je de skill vertrouwt.',
};

/** Most stars first (the order of the marketplace). */
export const CURATED_SOURCES: CuratedSource[] = [
  {
    id: 'mattpocock-skills',
    repo: 'mattpocock/skills',
    stars: 321994,
    commit: '4ae2317ddb22b046e26455e4f9c9b3aaaf62212d',
    commitDate: '2026-10-31',
    owner: 'mattpocock',
    publisher: 'Matt Pocock',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'Werkwijze voor programmeerwerk van Matt Pocock; kort en scherp, bedoeld voor ontwikkelaars.',
    skills: [
      { path: 'skills/engineering/to-spec', pack: 'Ontwikkeling', category: 'Ontwikkeling', note: 'Zet het gesprek om in een heldere specificatie van wat er gebouwd moet worden.', needs: 'Schrijft standaard naar een issue-tracker; kan ook naar een bestand.' },
      { path: 'skills/engineering/tdd', pack: 'Ontwikkeling', category: 'Ontwikkeling', note: 'Laat de bot eerst een test schrijven en dan pas de code, stap voor stap.' },
      { path: 'skills/productivity/grilling', pack: 'Werkwijze', category: 'Werkwijze', note: 'Bevraagt je plan of idee grondig, ronde na ronde, tot alle beslissingen genomen zijn.' },
      { path: 'skills/productivity/handoff', pack: 'Productiviteit', category: 'Productiviteit', note: 'Vat een lang gesprek samen in een overdrachtsdocument, zodat een ander verder kan.' },
    ],
  },
  {
    id: 'superpowers',
    repo: 'obra/superpowers',
    stars: 316285,
    commit: '22f0b463e7a5e579904dd6211a520321035526f7',
    commitDate: '2026-11-03',
    owner: 'obra',
    publisher: 'Jesse Vincent',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'De bekendste werkwijze-set: eerst doordenken, plannen, dan bouwen en controleren.',
    skills: [
      { path: 'skills/brainstorming', pack: 'Werkwijze', category: 'Werkwijze', note: 'Vraagt eerst door en werkt een idee uit tot een ontwerp voordat er iets gebouwd wordt.', scripts: true, windows: SCRIPTS_OFF },
      { path: 'skills/writing-plans', pack: 'Werkwijze', category: 'Werkwijze', note: 'Maakt van een wens een stappenplan dat een bot zelfstandig kan uitvoeren.' },
      { path: 'skills/systematic-debugging', pack: 'Ontwikkeling', category: 'Ontwikkeling', note: 'Zoekt stap voor stap de echte oorzaak van een fout in plaats van te gokken.', scripts: true, windows: SCRIPTS_OFF },
      { path: 'skills/verification-before-completion', pack: 'Werkwijze', category: 'Werkwijze', note: 'Dwingt de bot om te bewijzen dat iets werkt voordat hij zegt dat het klaar is.' },
      { path: 'skills/executing-plans', pack: 'Werkwijze', category: 'Werkwijze', note: 'Voert een plan stap voor stap uit en controleert elke stap.', scripts: true, windows: SCRIPTS_OFF },
    ],
  },
  {
    id: 'agent-skills',
    repo: 'addyosmani/agent-skills',
    stars: 115896,
    commit: '301b02b12bff98e4688e6984af6556802322bbde',
    commitDate: '2026-11-01',
    owner: 'addyosmani',
    publisher: 'Addy Osmani',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'Degelijke werkwijzen voor het bouwen van software, van idee tot livegang.',
    skills: [
      { path: 'skills/spec-driven-development', pack: 'Ontwikkeling', category: 'Ontwikkeling', note: 'Schrijft eerst op wat er gebouwd moet worden en waarom, daarna pas code.' },
      { path: 'skills/planning-and-task-breakdown', pack: 'Werkwijze', category: 'Werkwijze', note: 'Knipt een groot project op in kleine, controleerbare taken.' },
      { path: 'skills/shipping-and-launch', pack: 'Ontwikkeling', category: 'Ontwikkeling', note: 'Loopt een controlelijst af voordat een site of app live gaat.' },
      { path: 'skills/security-and-hardening', pack: 'Ontwikkeling', category: 'Ontwikkeling', note: 'Controleert en verbetert code op beveiliging: invoer, toegang en geheimen.' },
      { path: 'skills/performance-optimization', pack: 'Ontwikkeling', category: 'Ontwikkeling', note: 'Zoekt waarom een app of site traag is en maakt hem sneller.' },
    ],
  },
  {
    id: 'humanizer',
    repo: 'blader/humanizer',
    stars: 67965,
    commit: 'b48c832f0f809c1b5658edbb838c2521b72f2413',
    commitDate: '2026-11-10',
    owner: 'blader',
    publisher: 'Siqi Chen',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'Haalt de typische AI-toon uit een tekst.',
    skills: [
      { path: '', pack: 'Schrijven', category: 'Schrijven', note: 'Herschrijft een tekst zodat hij menselijk klinkt, zonder de inhoud te veranderen.', scripts: true, windows: SCRIPTS_OFF },
    ],
  },
  {
    id: 'marketingskills',
    repo: 'coreyhaines31/marketingskills',
    stars: 59778,
    commit: '1f837447b20bb6f0e72d87b80ece1c221c362c7d',
    commitDate: '2026-11-11',
    owner: 'coreyhaines31',
    publisher: 'Corey Haines',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'De meest gebruikte marketing-set: teksten, SEO, advertenties, e-mail en conversie.',
    skills: [
      { path: 'skills/copywriting', pack: 'Schrijven', category: 'Schrijven', note: 'Schrijft of verbetert de tekst van een homepage, landingspagina of prijspagina.' },
      { path: 'skills/seo-audit', pack: 'SEO', category: 'SEO', note: 'Controleert een website op SEO-problemen en zegt wat eerst moet.' },
      { path: 'skills/ai-seo', pack: 'SEO', category: 'SEO', note: 'Zorgt dat de site genoemd wordt in antwoorden van ChatGPT, Perplexity en Google AI.' },
      { path: 'skills/ads', pack: 'Advertenties', category: 'Advertenties', note: 'Helpt advertenties op Google, Meta en LinkedIn opzetten, beoordelen en bijsturen.' },
      { path: 'skills/cold-email', pack: 'Verkoop', category: 'Verkoop', note: 'Schrijft koude e-mails en opvolgmails die niet als spam lezen.' },
      { path: 'skills/emails', pack: 'Marketing', category: 'Marketing', note: 'Bouwt e-mailreeksen, zoals welkomstmails en mails voor verlaten winkelwagens.' },
      { path: 'skills/content-strategy', pack: 'Content', category: 'Content', note: 'Bepaalt waarover je moet schrijven en in welke volgorde.' },
      { path: 'skills/cro', pack: 'Marketing', category: 'Marketing', note: 'Zoekt uit waarom bezoekers niet kopen of aanvragen en hoe dat beter kan.' },
      { path: 'skills/ad-creative', pack: 'Advertenties', category: 'Advertenties', note: 'Bedenkt en test varianten van advertentieteksten en koppen.' },
      { path: 'skills/programmatic-seo', pack: 'SEO', category: 'SEO', note: 'Plant veel pagina’s volgens één sjabloon, zoals per plaats of per vergelijking.' },
      { path: 'skills/schema', pack: 'SEO', category: 'SEO', note: 'Schrijft gestructureerde gegevens (JSON-LD) voor producten, artikelen en veelgestelde vragen.' },
      { path: 'skills/site-architecture', pack: 'SEO', category: 'SEO', note: 'Ontwerpt de opbouw van een site: menu, adressen en interne links.' },
      { path: 'skills/link-building', pack: 'SEO', category: 'SEO', note: 'Zoekt veilige manieren om verwijzingen van andere sites te krijgen en schrijft de mails daarvoor.' },
      { path: 'skills/analytics', pack: 'Data & analyse', category: 'Data & analyse', note: 'Zet metingen op in GA4 en Google Tag Manager: welke gebeurtenissen, met welke namen.' },
      { path: 'skills/social', pack: 'Marketing', category: 'Marketing', note: 'Maakt en plant berichten voor LinkedIn, Instagram, TikTok en andere kanalen.' },
      { path: 'skills/copy-editing', pack: 'Schrijven', category: 'Schrijven', note: 'Redigeert bestaande marketingtekst: helderder, korter en overtuigender.' },
      { path: 'skills/pricing', pack: 'Verkoop', category: 'Verkoop', note: 'Denkt mee over prijzen, pakketten en een proefperiode.' },
    ],
  },
  {
    id: 'scientific-agent-skills',
    repo: 'K-Dense-AI/scientific-agent-skills',
    stars: 56845,
    commit: '2d2065fb4520fa3f3f2bcf61cff26ec8b7eba4b5',
    commitDate: '2026-11-09',
    owner: 'K-Dense-AI',
    publisher: 'K-Dense',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'Grote set voor wetenschappelijk werk; een paar skills zijn ook zakelijk bruikbaar.',
    skills: [
      { path: 'skills/market-research-reports', pack: 'Onderzoek', category: 'Onderzoek', note: 'Maakt een marktonderzoek met marktomvang, concurrenten en controleerbare bronnen.', scripts: true, windows: SCRIPTS_OFF, needs: 'Python 3.11 of nieuwer voor de hulpscripts (optioneel).' },
      { path: 'skills/statistical-analysis', pack: 'Data & analyse', category: 'Data & analyse', note: 'Kiest de juiste statistische toets en rekent cijfers netjes door.', scripts: true, windows: SCRIPTS_OFF, needs: 'Python 3.12 met de rekenpakketten die de skill noemt.' },
    ],
  },
  {
    id: 'obsidian-skills',
    repo: 'obsidianmd/obsidian-skills',
    stars: 51710,
    commit: '398127736bd4ba42d767b1419fee1a927508370b',
    commitDate: '2026-11-11',
    owner: 'obsidianmd',
    publisher: 'Obsidian',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'Leert de bot werken met Obsidian-notities en schone tekst van webpagina’s halen.',
    skills: [
      { path: 'plugins/obsidian/skills/obsidian-markdown', pack: 'Productiviteit', category: 'Productiviteit', note: 'Schrijft notities in de juiste Obsidian-opmaak, met links en eigenschappen.', needs: 'Alleen nuttig als je Obsidian gebruikt.' },
      { path: 'plugins/obsidian/skills/defuddle', pack: 'Onderzoek', category: 'Onderzoek', note: 'Haalt de schone tekst uit een webpagina, zonder menu’s en reclame.', needs: 'Het gratis programma defuddle (npm install -g defuddle).' },
    ],
  },
  {
    id: 'alirezarezvani-claude-skills',
    repo: 'alirezarezvani/claude-skills',
    stars: 29654,
    commit: '9ca476d8401f8750f92f4a7b31ec68efaa61ab02',
    commitDate: '2026-11-11',
    owner: 'alirezarezvani',
    publisher: 'Alireza Rezvani',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'Zeer grote verzameling; de onderdelen financiën en klantbeheer zijn het bruikbaarst.',
    skills: [
      { path: 'finance/skills/financial-analyst', pack: 'Financiën', category: 'Financiën', note: 'Rekent kengetallen, begroting en prognose door op basis van je cijfers.', scripts: true, windows: SCRIPTS_OFF, needs: 'Python op de pc voor de rekenscripts.' },
      { path: 'finance/skills/month-end-close', pack: 'Financiën', category: 'Financiën', note: 'Loopt de maandafsluiting na met een vaste controlelijst.', scripts: true, windows: SCRIPTS_OFF, needs: 'Python op de pc voor de hulpscripts. Niet afgestemd op Nederlandse regels.' },
      { path: 'business-growth/skills/customer-success-manager', pack: 'Klantenservice', category: 'Klantenservice', note: 'Schat per klant in hoe tevreden hij is en of hij dreigt weg te gaan.', scripts: true, windows: SCRIPTS_OFF, needs: 'Python op de pc voor de rekenscripts.' },
    ],
  },
  {
    id: 'claude-seo',
    repo: 'AgriciDaniel/claude-seo',
    stars: 28240,
    commit: 'cca7e4a267991aca880efade1fd12e8498caf2ce',
    commitDate: '2026-11-11',
    owner: 'AgriciDaniel',
    publisher: 'Agrici Daniel',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'Zeer uitgebreide SEO-set: techniek, inhoud, lokaal, webwinkel, schema en AI-zoekmachines.',
    skills: [
      { path: 'skills/seo-technical', pack: 'SEO', category: 'SEO', note: 'Controleert de technische kant van een site: vindbaarheid, snelheid, indexering.', needs: 'De hulpscripts staan buiten de map van de skill; de kennis werkt ook zonder.' },
      { path: 'skills/seo-ecommerce', pack: 'SEO', category: 'SEO', note: 'Beoordeelt productpagina’s en productgegevens van een webwinkel voor Google.', needs: 'Vergelijken met Google Shopping vraagt een betaald DataForSEO-account (optioneel).' },
      { path: 'skills/seo-local', pack: 'SEO', category: 'SEO', note: 'Controleert lokale vindbaarheid: Google Bedrijfsprofiel, adresgegevens en reviews.' },
      { path: 'skills/seo-schema', pack: 'SEO', category: 'SEO', note: 'Controleert en maakt de gestructureerde gegevens (schema) voor een pagina.' },
      { path: 'skills/seo-content', pack: 'Content', category: 'Content', note: 'Beoordeelt of een tekst goed genoeg is voor Google: ervaring, deskundigheid, betrouwbaarheid.' },
      { path: 'skills/seo-plan', pack: 'SEO', category: 'SEO', note: 'Maakt een SEO-plan voor een nieuwe of bestaande site, met stappen en volgorde.' },
      { path: 'skills/seo-content-brief', pack: 'SEO', category: 'SEO', note: 'Schrijft een opdracht voor een nieuwe pagina: onderwerpen, lengte en zoekwoorden.' },
      { path: 'skills/seo-geo', pack: 'SEO', category: 'SEO', note: 'Verbetert content zodat AI-overzichten en antwoordmachines hem gebruiken.' },
    ],
  },
  {
    id: 'pm-skills',
    repo: 'phuryn/pm-skills',
    stars: 27892,
    commit: '9af7bfd0bc47fdad43c2eaa7a43cd13918e7aaef',
    commitDate: '2026-11-08',
    owner: 'phuryn',
    publisher: 'Pawel Huryn',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'Korte, duidelijke skills voor marktonderzoek, strategie en productwerk.',
    skills: [
      { path: 'pm-market-research/skills/competitor-analysis', pack: 'Onderzoek', category: 'Onderzoek', note: 'Brengt vijf directe concurrenten in kaart met sterke en zwakke punten.' },
      { path: 'pm-market-research/skills/market-sizing', pack: 'Onderzoek', category: 'Onderzoek', note: 'Schat hoe groot de markt voor een product of dienst is.' },
      { path: 'pm-product-strategy/skills/pricing-strategy', pack: 'Verkoop', category: 'Verkoop', note: 'Helpt een prijs en prijsmodel kiezen.' },
    ],
  },
  {
    id: 'geo-seo-claude',
    repo: 'zubair-trabzada/geo-seo-claude',
    stars: 11628,
    commit: '989cae01e8ebbc42a9ec798eb9e7cb423f5ec89c',
    commitDate: '2026-10-05',
    owner: 'zubair-trabzada',
    publisher: 'Zubair Trabzada',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'Zichtbaarheid in AI-zoekmachines (GEO) controleren en verbeteren.',
    skills: [
      { path: 'skills/geo-audit', pack: 'SEO', category: 'SEO', note: 'Controleert of een site goed gevonden en geciteerd wordt door AI-zoekmachines.', needs: 'Gaat uit van hulp-agents; zonder die werkt het stap voor stap.' },
      { path: 'skills/geo-llmstxt', pack: 'SEO', category: 'SEO', note: 'Maakt of controleert het bestand llms.txt voor AI-zoekmachines.' },
    ],
  },
  {
    id: 'dev-browser',
    repo: 'SawyerHood/dev-browser',
    stars: 6727,
    commit: '520ba5cb4fa2856a501376cd8a62fe54a6576549',
    commitDate: '2026-11-03',
    owner: 'SawyerHood',
    publisher: 'Sawyer Hood',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'Laat de bot een echte Chrome-browser bedienen met korte scripts.',
    skills: [
      { path: 'skills/dev-browser', pack: 'Browser', category: 'Browser', note: 'Bedient websites: klikken, formulieren invullen, inloggen en gegevens ophalen.', needs: 'Het programma dev-browser (npm install -g dev-browser).' },
    ],
  },
  {
    id: 'n8n-skills',
    repo: 'czlonkowski/n8n-skills',
    stars: 6630,
    commit: 'e037563e101749e630e6688d121d04529fe6ee7b',
    commitDate: '2026-10-24',
    owner: 'czlonkowski',
    publisher: 'Romuald Członkowski',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'Kennis om goede automatiseringen in n8n te bouwen.',
    skills: [
      { path: 'skills/n8n-code-javascript', pack: 'Ontwikkeling', category: 'Ontwikkeling', note: 'Schrijft werkende JavaScript voor de Code-stap in n8n.', needs: 'Alleen nuttig als je n8n gebruikt.' },
      { path: 'skills/n8n-error-handling', pack: 'Ontwikkeling', category: 'Ontwikkeling', note: 'Zorgt dat een n8n-automatisering fouten netjes opvangt.', needs: 'Alleen nuttig als je n8n gebruikt.' },
    ],
  },
  {
    id: 'linkedin-skills',
    repo: 'sergebulaev/linkedin-skills',
    stars: 5843,
    commit: '8f8bc4b40a2d5419b2dcf898772b85712cfbdf41',
    commitDate: '2026-10-27',
    owner: 'sergebulaev',
    publisher: 'Serge Bulaev',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'LinkedIn-berichten en -reacties schrijven die niet als AI klinken.',
    skills: [
      { path: 'skills/linkedin-post-writer', pack: 'Content', category: 'Content', note: 'Schrijft een LinkedIn-bericht met een sterke openingszin.' },
      { path: 'skills/linkedin-profile-optimizer', pack: 'Marketing', category: 'Marketing', note: 'Verbetert een LinkedIn-profiel zodat het meer aanvragen oplevert.' },
    ],
  },
  {
    id: 'playwright-skill',
    repo: 'lackeyjb/playwright-skill',
    stars: 3285,
    commit: 'dd47a6a023e249eb1b36e9e943eab89d0900865d',
    commitDate: '2026-08-14',
    owner: 'lackeyjb',
    publisher: 'Bryan Lackey',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'Browser automatiseren en websites testen met Playwright.',
    skills: [
      { path: 'skills/playwright-skill', pack: 'Browser', category: 'Browser', note: 'Schrijft en draait een script dat een website test of bedient en schermafbeeldingen maakt.', scripts: true, windows: SCRIPTS_OFF, needs: 'Node.js 20 of nieuwer; installeert Playwright en Chromium bij eerste gebruik.' },
    ],
  },
  {
    id: 'web-quality-skills',
    repo: 'addyosmani/web-quality-skills',
    stars: 3069,
    commit: 'afa8da942115f2961fdbfa80807ea0b232ff6c00',
    commitDate: '2026-08-24',
    owner: 'addyosmani',
    publisher: 'Addy Osmani',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'De kwaliteit van een website volgens Google Lighthouse: snelheid, SEO en toegankelijkheid.',
    skills: [
      { path: 'skills/seo', pack: 'SEO', category: 'SEO', note: 'Loopt de technische SEO-basis van een site na en lost problemen op.' },
      { path: 'skills/core-web-vitals', pack: 'Ontwikkeling', category: 'Ontwikkeling', note: 'Maakt een site sneller op de punten waar Google op meet.' },
      { path: 'skills/accessibility', pack: 'Ontwikkeling', category: 'Ontwikkeling', note: 'Controleert of een site bruikbaar is voor iedereen, ook met een beperking.' },
    ],
  },
  {
    id: 'wondelai-skills',
    repo: 'wondelai/skills',
    stars: 2669,
    commit: 'd8d5d75f83da9f16d8aad5bab5f5b341a4770a30',
    commitDate: '2026-11-02',
    owner: 'wondelai',
    publisher: 'wondelai',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'Bekende zakenboeken omgezet in werkwijzen: aanbod, marketing, klantgesprekken.',
    skills: [
      { path: 'hundred-million-offers', pack: 'Verkoop', category: 'Verkoop', note: 'Bouwt een aanbod dat moeilijk te weigeren is, volgens de methode van Hormozi.' },
      { path: 'one-page-marketing', pack: 'Marketing', category: 'Marketing', note: 'Maakt een marketingplan op één pagina.' },
      { path: 'mom-test', pack: 'Onderzoek', category: 'Onderzoek', note: 'Helpt klantgesprekken voeren die eerlijke antwoorden opleveren.' },
    ],
  },
  {
    id: 'codex-first-customer-finder-skill',
    repo: 'Kappaemme-git/codex-first-customer-finder-skill',
    stars: 1249,
    commit: 'd3f6964bd989745ac183edbd545c588a68451146',
    commitDate: '2026-09-19',
    owner: 'Kappaemme-git',
    publisher: 'Francesco Mistero',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'Zoekt mogelijke eerste klanten op basis van openbare signalen.',
    skills: [
      { path: 'first-customer-finder', pack: 'Verkoop', category: 'Verkoop', note: 'Maakt een korte lijst van mogelijke klanten met bewijs waarom ze passen, plus een conceptbericht.', scripts: true, windows: SCRIPTS_OFF },
    ],
  },
  {
    id: 'jezweb-claude-skills',
    repo: 'jezweb/claude-skills',
    stars: 1108,
    commit: '1260fa7439b36b18dbf16648ccc7fb44783f6c23',
    commitDate: '2026-10-09',
    owner: 'jezweb',
    publisher: 'Jeremy Dawes',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'Praktische skills van een webbureau: Shopify, WordPress, lokale SEO.',
    skills: [
      { path: 'plugins/shopify/skills/shopify-setup', pack: 'Webshop', category: 'Webshop', note: 'Regelt de koppeling met een Shopify-winkel.', needs: 'Shopify-winkel en een toegangssleutel voor de Admin API.' },
      { path: 'plugins/shopify/skills/shopify-products', pack: 'Webshop', category: 'Webshop', note: 'Maakt en wijzigt producten in Shopify, ook in bulk.', needs: 'Shopify-winkel en een toegangssleutel voor de Admin API.' },
      { path: 'plugins/wordpress/skills/wordpress-setup', pack: 'Webshop', category: 'Webshop', note: 'Regelt de koppeling met een WordPress-site.', needs: 'WordPress-site met WP-CLI via SSH of een applicatiewachtwoord.' },
      { path: 'plugins/wordpress/skills/wordpress-content', pack: 'Content', category: 'Content', note: 'Plaatst en wijzigt berichten, pagina’s en afbeeldingen op een WordPress-site.', needs: 'WordPress-site met WP-CLI via SSH of een applicatiewachtwoord.' },
      { path: 'plugins/web-design/skills/seo-local-business', pack: 'SEO', category: 'SEO', note: 'Zet de SEO-basis neer voor de site van een lokaal bedrijf.' },
    ],
  },
  {
    id: 'coldoutboundskills',
    repo: 'growthenginenowoslawski/coldoutboundskills',
    stars: 813,
    commit: '25c5d85fbb5dd3efec97b0ca457cbbc286547476',
    commitDate: '2026-10-05',
    owner: 'growthenginenowoslawski',
    publisher: 'growthenginenowoslawski',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'Complete werkwijze voor koude e-mail: strategie, teksten en afleverbaarheid.',
    skills: [
      { path: 'skills/campaign-strategy', pack: 'Verkoop', category: 'Verkoop', note: 'Bedenkt campagne-ideeën voor koude acquisitie met doelgroep en invalshoek.' },
      { path: 'skills/campaign-copywriting', pack: 'Verkoop', category: 'Verkoop', note: 'Schrijft koude e-mails in stappen, met jouw akkoord per stap.' },
      { path: 'skills/spam-word-checker', pack: 'Communicatie', category: 'Communicatie', note: 'Controleert een e-mail op woorden en fouten die hem in de spam laten belanden.' },
    ],
  },
  {
    id: 'shopify-admin-skills',
    repo: '40RTY-ai/shopify-admin-skills',
    stars: 204,
    commit: 'e3579f43c84c1342a7b700be43f9da1c2ce1ff5b',
    commitDate: '2026-10-26',
    owner: '40RTY-ai',
    publisher: '40RTY.ai',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'Dagelijks beheer van een Shopify-winkel: bestellingen, voorraad, klanten, cijfers.',
    skills: [
      { path: 'skills/customer-support/shopify-admin-order-lookup-and-summary', pack: 'Klantenservice', category: 'Klantenservice', note: 'Zoekt een bestelling op en vat status en verzending samen.', needs: 'Shopify-winkel en ingelogde Shopify CLI.' },
      { path: 'skills/customer-support/shopify-admin-refund-and-reorder', pack: 'Klantenservice', category: 'Klantenservice', note: 'Regelt een terugbetaling en een nieuwe bestelling.', needs: 'Shopify-winkel en ingelogde Shopify CLI.' },
      { path: 'skills/merchandising/shopify-admin-low-inventory-restock', pack: 'Webshop', category: 'Webshop', note: 'Laat zien welke producten bijna op zijn en bijbesteld moeten worden.', needs: 'Shopify-winkel en ingelogde Shopify CLI.' },
      { path: 'skills/merchandising/shopify-admin-seo-metadata-audit', pack: 'Webshop', category: 'Webshop', note: 'Controleert titels en beschrijvingen van producten voor Google.', needs: 'Shopify-winkel en ingelogde Shopify CLI.' },
      { path: 'skills/finance/shopify-admin-payout-reconciliation', pack: 'Financiën', category: 'Financiën', note: 'Legt uitbetalingen van Shopify naast de bestellingen.', needs: 'Shopify-winkel en ingelogde Shopify CLI.' },
    ],
  },
];

/** Catalogue id of one skill: `<source id>/<path>` (root skill: the source id alone). */
export const curatedId = (s: CuratedSource, k: CuratedSkill) => (k.path ? `${s.id}/${k.path}` : s.id);
/** catalog_ref of an installed catalogue skill. */
export const curatedRef = (id: string) => `curated/${id}`;
export const parseCuratedRef = (ref: string | null | undefined) => (ref && ref.startsWith('curated/') ? ref.slice('curated/'.length) : null);
