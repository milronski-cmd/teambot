import type { CuratedSource } from './curated.js';

/**
 * Catalogue pack “Klantenservice en verkoop”: skills for customer service, sales, e-mail, CRM and bookkeeping. Checked
 * by hand on 2026-11-09 with `gh` (repository, licence file that applies to each skill folder, latest commit, files
 * per folder): every folder below holds only Markdown (no scripts), so nothing needs to run on Windows.
 *
 * Licences: anthropics/knowledge-work-plugins has its own Apache-2.0 licence file in sales/, finance/ and legal/;
 * small-business/ has none, so the repository's LICENSE (Apache-2.0) applies. resend/resend-skills is MIT (LICENSE,
 * and `license: MIT` in the SKILL.md front matter).
 *
 * Considered and left out: Shopify/shopify-ai-toolkit (MIT, but the one live skill is a developer skill of 145 files
 * with scripts), stripe/ai skills (MIT, all for developers building on Stripe), the US-only tax and payroll skills of
 * small-business (tax-prep, tax-season-organizer, payroll-prep: 1099 and US rules), resend/resend-skills
 * agent-email-inbox (MIT, but about building an inbound-mail pipeline in code).
 */

const VERIFIED = '2026-11-09';
const PACK = 'Klantenservice en verkoop';

export const CURATED_SERVICE_SOURCES: CuratedSource[] = [
  {
    id: 'anthropic-kwp-service',
    repo: 'anthropics/knowledge-work-plugins',
    // Same pin as the source 'anthropic-kwp' in curated.ts (checked 2026-11-09).
    commit: 'e050c2ec856373787143d7057663a6ebd1277df3',
    commitDate: '2026-11-07',
    owner: 'anthropics',
    publisher: 'Anthropic',
    license: 'Apache-2.0',
    verifiedAt: VERIFIED,
    note: 'Werkwijzen van Anthropic voor verkoop, klantcontact, CRM en de boekhouding van een klein bedrijf.',
    skills: [
      // Sales (sales/LICENSE, Apache-2.0). Written for teams with a CRM; they also work from pasted mail or notes.
      { path: 'sales/skills/inbox-sweep', root: 'sales', pack: PACK, category: 'Klantenservice', note: 'Loopt ongelezen klantmails in één keer door, zet ze op volgorde van urgentie en schrijft conceptantwoorden.', needs: 'Werkt het best met een gekoppelde mailbox (bijvoorbeeld de app “E-mail via IMAP”).' },
      { path: 'sales/skills/call-summary', root: 'sales', pack: PACK, category: 'Verkoop', note: 'Maakt van een gesprek of je aantekeningen een vervolgmail aan de klant, een korte interne samenvatting en voorstellen voor het CRM.' },
      { path: 'sales/skills/draft-outreach', root: 'sales', pack: PACK, category: 'Verkoop', note: 'Schrijft een persoonlijke eerste mail of een korte reeks mails aan een mogelijke klant, als concept dat jij eerst leest.' },
      { path: 'sales/skills/handle-objection', root: 'sales', pack: PACK, category: 'Verkoop', note: 'Helpt een bezwaar van een klant te beantwoorden (“te duur”, “we kijken ook bij een ander”) met wat eerder werkte.' },
      { path: 'sales/skills/customer-voice', root: 'sales', pack: PACK, category: 'Klantenservice', note: 'Zoekt op wat klanten echt zeggen over een onderwerp, met letterlijke citaten uit mails en gesprekken.' },
      { path: 'sales/skills/schedule-meeting', root: 'sales', pack: PACK, category: 'Verkoop', note: 'Zoekt een tijd, schrijft de uitnodiging en zet de afspraak in je agenda en in het CRM.', needs: 'Een gekoppelde agenda (Google Agenda of Outlook); het CRM is optioneel.' },
      { path: 'sales/skills/log-activity', root: 'sales', pack: PACK, category: 'CRM', note: 'Legt een gesprek, afspraak of mailwisseling achteraf vast bij de juiste klant in het CRM, pas als jij dat zegt.', needs: 'Een gekoppeld CRM, bijvoorbeeld HubSpot.' },
      { path: 'sales/skills/crm-hygiene-check', root: 'sales', pack: PACK, category: 'CRM', note: 'Controleert het CRM zonder iets te wijzigen op ontbrekende velden en verouderde datums, en geeft een lijst om op te lossen.', needs: 'Een gekoppeld CRM, bijvoorbeeld HubSpot.' },
      // Small business (no own licence file: the repository's LICENSE, Apache-2.0).
      { path: 'small-business/skills/crm-autopilot', root: 'small-business', pack: PACK, category: 'CRM', note: 'Houdt het CRM bij uit mail, agenda en gesprekken en zet vervolgmails klaar voor klanten die stil zijn gevallen.', needs: 'Een gekoppeld CRM (bijvoorbeeld HubSpot) en een mailbox of agenda.' },
      { path: 'small-business/skills/reactivate', root: 'small-business', pack: PACK, category: 'Webshop', note: 'Vindt klanten die opvallend lang niets meer kochten en schrijft per klant een terugwinbericht; versturen pas na jouw akkoord.' },
      { path: 'small-business/skills/ap-processor', root: 'small-business', pack: PACK, category: 'Financiën', note: 'Leest inkomende facturen (pdf of foto), haalt leverancier, bedrag en vervaldatum eruit en zet de boekingen klaar ter controle.', needs: 'Werkt het best met een gekoppelde boekhouding; de voorbeelden noemen Amerikaanse pakketten en regels (zoals QuickBooks), dus controleer btw en grootboek zelf.' },
      { path: 'small-business/skills/month-end-prep', root: 'small-business', pack: PACK, category: 'Financiën', note: 'Legt de boekhouding naast de uitbetalingen van je betaal- en webshopdiensten, wijst dubbele en ontbrekende posten aan en schrijft een korte toelichting op de cijfers.', needs: 'Een gekoppelde boekhouding en betaaldienst (bijvoorbeeld Xero, Stripe, PayPal of Shopify); voor het xlsx- en pdf-overzicht de documentskills.' },
      // Finance (finance/LICENSE, Apache-2.0)
      { path: 'finance/skills/reconciliation', root: 'finance', pack: PACK, category: 'Financiën', note: 'Sluit de bank of een betaaldienst aan op de boekhouding en zet elk verschil met een verklaring op een rij.' },
      // Legal (legal/LICENSE, Apache-2.0)
      { path: 'legal/skills/legal-response', root: 'legal', pack: PACK, category: 'Juridisch', note: 'Beantwoordt vaste juridische vragen, zoals een AVG-verzoek om inzage of verwijdering, met een sjabloon en zegt wanneer je een jurist nodig hebt (geen juridisch advies).' },
    ],
  },
  {
    id: 'resend-skills',
    repo: 'resend/resend-skills',
    commit: '389de56a2e48903c4b8ac7b8f2b8ee1f2c1bb9df',
    commitDate: '2026-11-06',
    owner: 'resend',
    publisher: 'Resend',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'Skills van Resend over e-mail die aankomt: bezorging, afzenderinstellingen en regels voor zakelijke mail.',
    skills: [
      { path: 'skills/email-best-practices', pack: PACK, category: 'Communicatie', note: 'Zorgt dat mail van je winkel aankomt en niet in de spam belandt: SPF, DKIM en DMARC, bevestigingsmails, afmelden en de AVG.' },
    ],
  },
];
