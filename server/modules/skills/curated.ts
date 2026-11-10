/**
 * TeamBot's own skill catalogue: a fixed list of sources, each pinned to one commit, checked by hand on 2026-11-09
 * (repository, licence file that applies to each skill folder, latest commit; GitHub API via `gh`). Nothing is
 * bundled with TeamBot: installing fetches exactly the pinned files from GitHub, applies the import rules
 * (`import-rules.ts`) and stores the skill with its licence text. A newer upstream version is shown as a diff that the
 * owner approves; it is never applied by itself.
 *
 * Deliberately not in the catalogue (licence check 2026-11-09): CC BY-NC-ND (hesreallyhim/awesome-claude-code),
 * CC-BY-SA (trailofbits/skills), Figma skills (Figma Developer Terms), repositories without a licence file
 * (vercel-labs/agent-skills, ComposioHQ/awesome-claude-skills) and AGPL (basic-memory, Smithery CLI). Anthropic's
 * Office skills are only Apache-2.0 from commit 2c5958ec (2026-11-06) on, so that is the earliest commit we pin.
 */
import { MARKETING_SOURCES } from './curated-marketing.js';

import { CURATED_SERVICE_SOURCES } from './curated-service.js';

import { CURATED_WORK } from './curated-work.js';

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
  /** SPDX licence as checked in the licence file of every listed skill folder (or its nearest parent). */
  license: string;
  verifiedAt: string;
  /** One Dutch sentence about the source. */
  note: string;
  skills: CuratedSkill[];
}

const VERIFIED = '2026-11-09';

const DOCS_WINDOWS: WindowsNote = {
  status: 'deels',
  note: 'Maken en lezen werkt op Windows met de genoemde programma’s. Omzetten naar pdf en alles via scripts/office/soffice.py werkt niet: dat hulpscript gebruikt een Linux-truc (socket.AF_UNIX en LD_PRELOAD); Python op Windows heeft geen AF_UNIX (gecontroleerd met Python 3.12.10 op Windows 11) en LibreOffice staat daar meestal niet in het pad.',
};

export const CURATED_SOURCES: CuratedSource[] = [
  {
    id: 'anthropic-kwp',
    repo: 'anthropics/knowledge-work-plugins',
    commit: 'e050c2ec856373787143d7057663a6ebd1277df3',
    commitDate: '2026-11-07',
    owner: 'anthropics',
    publisher: 'Anthropic',
    license: 'Apache-2.0',
    verifiedAt: VERIFIED,
    note: 'Werkwijzen van Anthropic voor kenniswerk: klantenservice, marketing, operations, data en klein bedrijf.',
    skills: [
      // Customer support (licence: customer-support/LICENSE, Apache-2.0)
      { path: 'customer-support/skills/ticket-triage', root: 'customer-support', pack: 'Klantenservice', category: 'Klantenservice', note: 'Zet een binnengekomen klantvraag op prioriteit en bepaalt wie hem oppakt.' },
      { path: 'customer-support/skills/draft-response', root: 'customer-support', pack: 'Klantenservice', category: 'Klantenservice', note: 'Schrijft een nette reactie aan een klant, ook bij slecht nieuws of een klacht.' },
      { path: 'customer-support/skills/kb-article', root: 'customer-support', pack: 'Klantenservice', category: 'Klantenservice', note: 'Maakt van een opgeloste vraag een artikel voor de kennisbank.' },
      { path: 'customer-support/skills/customer-escalation', root: 'customer-support', pack: 'Klantenservice', category: 'Klantenservice', note: 'Zet een lastig klantprobleem met alle context klaar voor techniek of leiding.' },
      { path: 'customer-support/skills/customer-research', root: 'customer-support', pack: 'Klantenservice', category: 'Klantenservice', note: 'Zoekt een klantvraag uit in meerdere bronnen en noemt waar elk antwoord vandaan komt.' },
      // Marketing (marketing/LICENSE, Apache-2.0)
      { path: 'marketing/skills/campaign-plan', root: 'marketing', pack: 'Marketing', category: 'Marketing', note: 'Maakt een campagneplan met doelen, doelgroep, kanalen, planning en meetpunten.' },
      { path: 'marketing/skills/content-creation', root: 'marketing', pack: 'Marketing', category: 'Marketing', note: 'Schrijft marketingteksten per kanaal: blog, social, nieuwsbrief, landingspagina.' },
      { path: 'marketing/skills/draft-content', root: 'marketing', pack: 'Marketing', category: 'Marketing', note: 'Zet snel een eerste versie van een blog, persbericht of casestudy op papier.' },
      { path: 'marketing/skills/email-sequence', root: 'marketing', pack: 'Marketing', category: 'Marketing', note: 'Ontwerpt een reeks e-mails met teksten, timing en wanneer iemand eruit gaat.' },
      { path: 'marketing/skills/seo-audit', root: 'marketing', pack: 'Marketing', category: 'Marketing', note: 'Controleert de vindbaarheid van een site: zoekwoorden, pagina’s, techniek en concurrenten.' },
      { path: 'marketing/skills/brand-review', root: 'marketing', pack: 'Marketing', category: 'Marketing', note: 'Toetst een tekst aan je merkstem en stijl, met concrete verbeteringen.' },
      { path: 'marketing/skills/competitive-brief', root: 'marketing', pack: 'Marketing', category: 'Marketing', note: 'Vergelijkt concurrenten en laat zien waar jouw boodschap kan opvallen.' },
      { path: 'marketing/skills/performance-report', root: 'marketing', pack: 'Marketing', category: 'Marketing', note: 'Maakt een rapport over marketingresultaten met trends en wat beter kan.' },
      // Operations (no own licence file: the repository's LICENSE, Apache-2.0, applies)
      { path: 'operations/skills/process-doc', root: 'operations', pack: 'Operations', category: 'Operations', note: 'Legt een werkproces vast met stappen, wie wat doet en de uitzonderingen.' },
      { path: 'operations/skills/runbook', root: 'operations', pack: 'Operations', category: 'Operations', note: 'Schrijft een draaiboek voor een terugkerende taak, stap voor stap.' },
      { path: 'operations/skills/risk-assessment', root: 'operations', pack: 'Operations', category: 'Operations', note: 'Brengt de risico’s van een project, leverancier of besluit in kaart, met maatregelen.' },
      { path: 'operations/skills/vendor-review', root: 'operations', pack: 'Operations', category: 'Operations', note: 'Beoordeelt een leverancier op kosten en risico en geeft een advies.' },
      { path: 'operations/skills/capacity-plan', root: 'operations', pack: 'Operations', category: 'Operations', note: 'Rekent uit of het team het werk aankan en waar het knelt.' },
      { path: 'operations/skills/status-report', root: 'operations', pack: 'Operations', category: 'Operations', note: 'Maakt een statusrapport met cijfers, risico’s en actiepunten.' },
      { path: 'operations/skills/change-request', root: 'operations', pack: 'Operations', category: 'Operations', note: 'Zet een wijzigingsvoorstel op met gevolgen en een plan om terug te draaien.' },
      { path: 'operations/skills/compliance-tracking', root: 'operations', pack: 'Operations', category: 'Operations', note: 'Houdt bij aan welke regels en audits je moet voldoen en wat nog openstaat.' },
      { path: 'operations/skills/process-optimization', root: 'operations', pack: 'Operations', category: 'Operations', note: 'Zoekt waar een traag of omslachtig proces sneller en eenvoudiger kan.' },
      // Data (data/LICENSE, Apache-2.0)
      { path: 'data/skills/analyze', root: 'data', pack: 'Data', category: 'Data & analyse', note: 'Beantwoordt vragen over je cijfers, van één getal tot een volledige analyse.' },
      { path: 'data/skills/explore-data', root: 'data', pack: 'Data', category: 'Data & analyse', note: 'Verkent een nieuwe tabel of een nieuw bestand: vorm, kwaliteit en opvallende dingen.' },
      { path: 'data/skills/sql-queries', root: 'data', pack: 'Data', category: 'Data & analyse', note: 'Schrijft correcte en snelle SQL voor de gangbare databases.' },
      { path: 'data/skills/statistical-analysis', root: 'data', pack: 'Data', category: 'Data & analyse', note: 'Past statistiek toe: trends, uitschieters en of een verschil echt is.' },
      { path: 'data/skills/validate-data', root: 'data', pack: 'Data', category: 'Data & analyse', note: 'Controleert een analyse op fouten en vertekening voordat je hem deelt.' },
      { path: 'data/skills/build-dashboard', root: 'data', pack: 'Data', category: 'Data & analyse', note: 'Bouwt een dashboard als één HTML-bestand met grafieken, filters en tabellen.' },
      { path: 'data/skills/data-visualization', root: 'data', pack: 'Data', category: 'Data & analyse', note: 'Kiest en maakt de juiste grafiek voor je gegevens.', needs: 'Python met matplotlib, seaborn of plotly om grafieken te tekenen.' },
      // Small business (no own licence file: the repository's LICENSE, Apache-2.0). Many of these use paid services
      // (QuickBooks, PayPal, Shopify …) through apps; the working method itself works without them.
      { path: 'small-business/skills/invoice-chase', root: 'small-business', pack: 'Klein bedrijf', category: 'Financiën', note: 'Schrijft herinneringen voor openstaande facturen, vriendelijk of strenger per klant; versturen pas na jouw akkoord.', needs: 'Werkt het best met een gekoppelde boekhouding of betaaldienst (bijvoorbeeld QuickBooks, Xero, PayPal of Stripe).' },
      { path: 'small-business/skills/inbox-manager', root: 'small-business', pack: 'Klein bedrijf', category: 'Communicatie', note: 'Maakt van een volle inbox een korte lijst van wat jou nodig heeft, met conceptantwoorden.', needs: 'Een gekoppelde mailbox (Gmail of Microsoft 365).' },
      { path: 'small-business/skills/review-reputation', root: 'small-business', pack: 'Klein bedrijf', category: 'Marketing', note: 'Verzamelt wat klanten over je zeggen in reviews en mail, en stelt antwoorden voor.' },
      { path: 'small-business/skills/social-content-engine', root: 'small-business', pack: 'Klein bedrijf', category: 'Marketing', note: 'Houdt een planning voor social media bij en schrijft berichten in jouw toon.' },
      { path: 'small-business/skills/speed-to-lead', root: 'small-business', pack: 'Klein bedrijf', category: 'Verkoop', note: 'Zorgt dat geen nieuwe aanvraag blijft liggen: beoordeelt hem en zet een antwoord klaar.' },
      { path: 'small-business/skills/content-strategy', root: 'small-business', pack: 'Klein bedrijf', category: 'Marketing', note: 'Kijkt wat goed en slecht verkoopt en maakt daar een contentplan voor 30 dagen van.' },
      { path: 'small-business/skills/proposal-builder', root: 'small-business', pack: 'Klein bedrijf', category: 'Verkoop', note: 'Maakt van gespreksnotities een offerte of voorstel met prijzen.' },
      { path: 'small-business/skills/seo-ai-visibility', root: 'small-business', pack: 'Klein bedrijf', category: 'Marketing', note: 'Controleert of je gevonden wordt in Google én in de antwoorden van AI-assistenten.' },
      { path: 'small-business/skills/ticket-deflector', root: 'small-business', pack: 'Klein bedrijf', category: 'Klantenservice', note: 'Leest een klantmail, zoekt de bestelling op en zet een antwoord klaar.' },
      { path: 'small-business/skills/cash-flow-snapshot', root: 'small-business', pack: 'Klein bedrijf', category: 'Financiën', note: 'Voorspelt je geld voor de komende 30, 60 en 90 dagen.' },
      { path: 'small-business/skills/inventory-planner', root: 'small-business', pack: 'Klein bedrijf', category: 'Webshop', note: 'Rekent uit wat je wanneer moet bijbestellen op basis van wat echt verkoopt.' },
      { path: 'small-business/skills/contract-review', root: 'small-business', pack: 'Klein bedrijf', category: 'Juridisch', note: 'Leest een contract of geheimhoudingsverklaring door en wijst op ongebruikelijke punten (geen juridisch advies).' },
    ],
  },
  {
    id: 'anthropic-skills',
    repo: 'anthropics/skills',
    // The commit that moved the Office skills to Apache-2.0 (PR #2146); earlier commits must not be used.
    commit: '2c5958ecac7cee2b583967a2c4981d0f4a75c579',
    commitDate: '2026-11-06',
    owner: 'anthropics',
    publisher: 'Anthropic',
    license: 'Apache-2.0',
    verifiedAt: VERIFIED,
    note: 'De documentskills van Anthropic voor Word, pdf, PowerPoint en Excel (Apache-2.0 sinds 6 november 2026).',
    skills: [
      { path: 'skills/docx', scripts: true, pack: 'Documenten', category: 'Documenten', note: 'Maakt, leest en bewerkt Word-documenten.', windows: DOCS_WINDOWS, needs: 'Node.js met het npm-pakket docx om te maken, pandoc om te lezen; LibreOffice voor omzetten (werkt niet op Windows, zie hierboven).' },
      {
        path: 'skills/pdf', scripts: true,
        pack: 'Documenten',
        category: 'Documenten',
        note: 'Leest, splitst, voegt samen en vult pdf-bestanden in.',
        windows: { status: 'niet-getest', note: 'Gebruikt alleen Python-scripts (pypdf, pdfplumber, reportlab) en geen Linux-truc; op Windows niet uitgevoerd door TeamBot.' },
        needs: 'Python met pypdf, pdfplumber en reportlab; optioneel qpdf en poppler.',
      },
      { path: 'skills/pptx', scripts: true, pack: 'Documenten', category: 'Documenten', note: 'Maakt, leest en bewerkt PowerPoint-presentaties.', windows: DOCS_WINDOWS, needs: 'Node.js met pptxgenjs om te maken, markitdown om te lezen; LibreOffice en poppler voor voorbeeldafbeeldingen (werkt niet op Windows).' },
      { path: 'skills/xlsx', scripts: true, pack: 'Documenten', category: 'Documenten', note: 'Maakt, leest en bewerkt Excel-bestanden met formules.', windows: { ...DOCS_WINDOWS, note: 'Lezen en schrijven met openpyxl en pandas werkt op Windows. Formules laten doorrekenen (scripts/recalc.py) gebruikt LibreOffice via hetzelfde Linux-hulpscript en werkt op Windows niet.' }, needs: 'Python met openpyxl, pandas en markitdown; LibreOffice om formules door te rekenen (werkt niet op Windows).' },
    ],
  },
  {
    id: 'superpowers',
    repo: 'obra/superpowers',
    commit: '22f0b463e7a5e579904dd6211a520321035526f7',
    commitDate: '2026-11-03',
    owner: 'obra',
    publisher: 'Jesse Vincent (obra)',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'Werkwijzen van Jesse Vincent: eerst bewijzen, dan pas “klaar”; plannen; fouten systematisch zoeken.',
    skills: [
      { path: 'skills/verification-before-completion', pack: 'Werkwijze', category: 'Werkwijze', note: 'Zegt pas “klaar” als een controle het net heeft bewezen: eerst bewijs, dan de bewering.' },
      { path: 'skills/writing-plans', pack: 'Werkwijze', category: 'Werkwijze', note: 'Schrijft eerst een plan in kleine, controleerbare stappen voordat het werk begint.' },
      {
        path: 'skills/executing-plans', scripts: true,
        pack: 'Werkwijze',
        category: 'Werkwijze',
        note: 'Voert een plan stap voor stap uit en controleert elke stap.',
        windows: { status: 'niet-getest', note: 'De hulpscripts zijn bash-scripts; op Windows alleen met Git Bash. De werkwijze zelf werkt zonder scripts.' },
      },
      {
        path: 'skills/systematic-debugging', scripts: true,
        pack: 'Werkwijze',
        category: 'Werkwijze',
        note: 'Zoekt bij een fout eerst de oorzaak, met een vaste aanpak, voordat er iets wordt aangepast.',
        windows: { status: 'niet-getest', note: 'Eén hulpscript (find-polluter.sh) is een bash-script; de werkwijze zelf werkt zonder.' },
      },
      { path: 'skills/test-driven-development', pack: 'Werkwijze', category: 'Ontwikkeling', note: 'Schrijft eerst een test die faalt, dan pas de code die hem laat slagen.' },
      { path: 'skills/receiving-code-review', pack: 'Werkwijze', category: 'Ontwikkeling', note: 'Gaat kritisch om met feedback op code: eerst controleren, niet blind overnemen.' },
    ],
  },
  {
    id: 'marketingskills',
    repo: 'coreyhaines31/marketingskills',
    commit: '96798cf38736ecdba015a1d2b0521b0c8f8f41dd',
    commitDate: '2026-11-06',
    owner: 'coreyhaines31',
    publisher: 'Corey Haines',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'Marketingskills van Corey Haines: teksten, advertenties, e-mail, social, conversie en prijzen.',
    skills: [
      { path: 'skills/copywriting', pack: 'Marketing (Corey Haines)', category: 'Marketing', note: 'Schrijft of herschrijft de teksten van een homepage, landings- of productpagina.' },
      { path: 'skills/copy-editing', pack: 'Marketing (Corey Haines)', category: 'Marketing', note: 'Redigeert bestaande marketingtekst: helderder, korter en overtuigender.' },
      { path: 'skills/ads', pack: 'Marketing (Corey Haines)', category: 'Advertenties', note: 'Helpt met advertentiecampagnes op Google, Meta, LinkedIn en andere platforms.' },
      { path: 'skills/ad-creative', pack: 'Marketing (Corey Haines)', category: 'Advertenties', note: 'Bedenkt en test varianten van advertentieteksten en koppen.' },
      { path: 'skills/emails', pack: 'Marketing (Corey Haines)', category: 'Marketing', note: 'Zet e-mailreeksen op, zoals welkom, nurture en win-back.' },
      { path: 'skills/social', pack: 'Marketing (Corey Haines)', category: 'Marketing', note: 'Maakt en plant berichten voor LinkedIn, Instagram, TikTok en andere kanalen.' },
      { path: 'skills/cro', pack: 'Marketing (Corey Haines)', category: 'Webshop', note: 'Zoekt waarom bezoekers een pagina of formulier verlaten en hoe meer mensen converteren.' },
      { path: 'skills/pricing', pack: 'Marketing (Corey Haines)', category: 'Verkoop', note: 'Denkt mee over prijzen, pakketten en een proefperiode.' },
      { path: 'skills/launch', pack: 'Marketing (Corey Haines)', category: 'Marketing', note: 'Plant de lancering van een product of nieuwe functie.' },
      { path: 'skills/ai-seo', pack: 'Marketing (Corey Haines)', category: 'SEO', note: 'Maakt content die AI-zoekmachines en chatbots als bron noemen.' },
    ],
  },
  {
    id: 'claude-seo',
    repo: 'AgriciDaniel/claude-seo',
    commit: '6be93f45064ffbadced572b5d5c95f55fd263af0',
    commitDate: '2026-10-22',
    owner: 'AgriciDaniel',
    publisher: 'AgriciDaniel',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'SEO-skills van AgriciDaniel; gekozen zijn de onderdelen die (vrijwel) zonder hun eigen hulpprogramma werken.',
    skills: [
      { path: 'skills/seo-local', pack: 'SEO', category: 'SEO', note: 'Controleert lokale vindbaarheid: Google Bedrijfsprofiel, reviews en vestigingspagina’s.' },
      { path: 'skills/seo-plan', pack: 'SEO', category: 'SEO', note: 'Maakt een SEO-plan voor een nieuwe of bestaande site, met stappen en volgorde.' },
      { path: 'skills/seo-content-brief', pack: 'SEO', category: 'SEO', note: 'Schrijft een opdracht voor een nieuwe pagina: onderwerpen, lengte en zoekwoorden.' },
      { path: 'skills/seo-geo', pack: 'SEO', category: 'SEO', note: 'Verbetert content zodat AI-overzichten en antwoordmachines hem gebruiken.' },
      { path: 'skills/seo-schema', pack: 'SEO', category: 'SEO', note: 'Controleert of maakt gestructureerde gegevens (Schema.org) voor een pagina.' },
      { path: 'skills/seo-hreflang', pack: 'SEO', category: 'SEO', note: 'Controleert en maakt taal- en landverwijzingen voor een meertalige site.' },
    ],
  },
  {
    id: 'humanizer',
    repo: 'blader/humanizer',
    commit: '0ef9fe5bc3572734fd3ae6c448fe00a30cd5dcf0',
    commitDate: '2026-10-28',
    owner: 'blader',
    publisher: 'Siqi Chen (blader)',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'Haalt typische AI-sporen uit een tekst, zodat hij natuurlijker leest.',
    skills: [{ path: '', scripts: true, pack: 'Schrijven', category: 'Schrijven', note: 'Haalt typische AI-sporen uit een tekst, zodat hij natuurlijker leest.' }],
  },
  {
    id: 'planning-with-files',
    repo: 'OthmanAdi/planning-with-files',
    commit: '2362ca385ad74f061aa0e7b73f56543a4b7e6df2',
    commitDate: '2026-11-07',
    owner: 'OthmanAdi',
    publisher: 'Ahmad Adi (OthmanAdi)',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'Houdt een plan, bevindingen en voortgang bij in bestanden, zodat werk een herstart of overdracht overleeft.',
    skills: [
      {
        path: 'skills/planning-with-files', scripts: true,
        pack: 'Plannen',
        category: 'Werkwijze',
        note: 'Houdt een plan, bevindingen en voortgang bij in bestanden, zodat werk een herstart of overdracht overleeft.',
        windows: { status: 'niet-getest', note: 'Heeft naast bash- ook PowerShell-scripts; die zijn in TeamBot niet uitgevoerd. De werkwijze met de drie bestanden werkt zonder scripts.' },
      },
    ],
  },
  ...MARKETING_SOURCES,

  ...CURATED_SERVICE_SOURCES,

  ...CURATED_WORK,
];

/** Catalogue id of one skill: `<source id>/<path>` (root skill: the source id alone). */
export const curatedId = (s: CuratedSource, k: CuratedSkill) => (k.path ? `${s.id}/${k.path}` : s.id);
/** catalog_ref of an installed catalogue skill. */
export const curatedRef = (id: string) => `curated/${id}`;
export const parseCuratedRef = (ref: string | null | undefined) => (ref && ref.startsWith('curated/') ? ref.slice('curated/'.length) : null);
