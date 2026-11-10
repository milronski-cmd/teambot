import type { CuratedSource } from './curated.js';

/**
 * Package 0.4.5, marketing area: skills for SEO, marketing, content, social media and ads. Checked by hand on
 * 2026-11-09 like the rest of the catalogue (GitHub API via `gh`: licence file that applies to each skill folder,
 * latest commit, the files in each folder). Every source is pinned to one commit; installing fetches exactly those
 * files and applies the import rules.
 *
 * Deliberately left out (2026-11-09): alirezarezvani/claude-skills `brand-guidelines` (contains Anthropic's own brand
 * identity) and `content-creator` (only a pointer to another skill); most other marketing skills in that repository
 * are copies of Corey Haines' originals, which we take from the source. claude-seo's audit, technical and sitemap
 * skills need their own helper program. geo-seo-claude's `geo-brand-mentions` needs its Python scripts outside the
 * skill folder. Postiz (social scheduler) is AGPL-3.0; OpenSEO (MIT) is an app with an MCP server, not a skill, and
 * only works with a paid DataForSEO account (see catalog-marketing.ts).
 */

const VERIFIED = '2026-11-09';
const PACK = 'Marketing en SEO';
const KWP_COMMIT = 'e050c2ec856373787143d7057663a6ebd1277df3';

/** Owners of the sources below: the publisher check compares look-alike names with these (import-rules.ts). */
export const MARKETING_PUBLISHERS = ['zubair-trabzada', 'alirezarezvani'];
/** Distinctive repository names: the same name under another owner is a copy or a fake. */
export const MARKETING_REPOS: Record<string, string> = {
  'geo-seo-claude': 'zubair-trabzada',
  'web-quality-skills': 'addyosmani',
};

export const MARKETING_SOURCES: CuratedSource[] = [
  {
    id: 'web-quality-skills',
    repo: 'addyosmani/web-quality-skills',
    commit: 'afa8da942115f2961fdbfa80807ea0b232ff6c00',
    commitDate: '2026-08-24',
    owner: 'addyosmani',
    publisher: 'Addy Osmani',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'Skills van Addy Osmani (Google Chrome) voor de kwaliteit van een website: vindbaarheid, snelheid en Core Web Vitals.',
    skills: [
      { path: 'skills/seo', pack: PACK, category: 'SEO', note: 'Controleert de technische vindbaarheid van een pagina: titels, meta-tags, links en gestructureerde gegevens.' },
      { path: 'skills/core-web-vitals', pack: PACK, category: 'SEO', note: 'Verbetert de drie Google-meetpunten voor laadsnelheid, reactiesnelheid en verspringende inhoud (LCP, INP en CLS).' },
      {
        path: 'skills/web-quality-audit', scripts: true,
        pack: PACK,
        category: 'SEO',
        note: 'Doet een volledige kwaliteitscontrole van een site: snelheid, toegankelijkheid, vindbaarheid en goede gewoonten.',
        windows: { status: 'niet-getest', note: 'Het hulpscript (scripts/analyze.sh) is een bash-script; op Windows alleen met Git Bash. De controle zelf werkt ook zonder script.' },
        needs: 'Optioneel Lighthouse (npx lighthouse) of PageSpeed Insights voor echte meetcijfers.',
      },
    ],
  },
  {
    // Same repository and commit as the source 'marketingskills' in curated.ts; these are the SEO, analytics and
    // content skills that were not in the catalogue yet.
    id: 'marketingskills-seo',
    repo: 'coreyhaines31/marketingskills',
    commit: '96798cf38736ecdba015a1d2b0521b0c8f8f41dd',
    commitDate: '2026-11-06',
    owner: 'coreyhaines31',
    publisher: 'Corey Haines',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'Meer skills van Corey Haines: SEO op schaal, sitestructuur, metingen, PR en beeld en video.',
    skills: [
      { path: 'skills/programmatic-seo', pack: PACK, category: 'SEO', note: 'Plant veel pagina’s volgens één sjabloon, zoals per plaats of per vergelijking, zonder dunne inhoud.' },
      { path: 'skills/schema', pack: PACK, category: 'SEO', note: 'Schrijft gestructureerde gegevens (JSON-LD) voor producten, artikelen, veelgestelde vragen en je bedrijf.' },
      { path: 'skills/site-architecture', pack: PACK, category: 'SEO', note: 'Ontwerpt de opbouw van een site: menu, adressen en interne links.' },
      { path: 'skills/link-building', pack: PACK, category: 'SEO', note: 'Zoekt veilige manieren om verwijzingen van andere sites te krijgen en schrijft de benaderingsmails.' },
      { path: 'skills/analytics', pack: PACK, category: 'Data & analyse', note: 'Zet metingen op in GA4 en Google Tag Manager: welke gebeurtenissen, met welke namen.' },
      {
        path: 'skills/conversion-tracking', scripts: true,
        pack: PACK,
        category: 'Advertenties',
        note: 'Meet aanvragen en aankopen goed voor Google Ads, Meta en LinkedIn, met kant-en-klare Tag Manager-recepten.',
        windows: { status: 'niet-getest', note: 'Twee Python-hulpscripts (recepten bouwen en controleren); de werkwijze en de recepten werken zonder.' },
      },
      { path: 'skills/marketing-plan', pack: PACK, category: 'Marketing', note: 'Maakt een volledig marketingplan met doelen, budget, kanalen en hoe je het meet.' },
      { path: 'skills/marketing-psychology', pack: PACK, category: 'Marketing', note: 'Past bekende psychologische principes toe op teksten en pagina’s, zonder te misleiden.' },
      { path: 'skills/competitor-profiling', pack: PACK, category: 'Marketing', note: 'Maakt een profiel van een concurrent: aanbod, prijzen, boodschap en waar die zwak is.' },
      { path: 'skills/public-relations', pack: PACK, category: 'Marketing', note: 'Schrijft persberichten en pitches voor journalisten en helpt bij lastige publiciteit.' },
      { path: 'skills/image', pack: PACK, category: 'Content', note: 'Bedenkt beelden voor social, advertenties en de site en schrijft de opdracht voor een beeldgenerator.' },
      { path: 'skills/video', pack: PACK, category: 'Content', note: 'Plant korte video’s en productdemo’s: script, opbouw en opdrachten voor videogeneratoren.' },
    ],
  },
  {
    id: 'geo-seo-claude',
    repo: 'zubair-trabzada/geo-seo-claude',
    commit: '989cae01e8ebbc42a9ec798eb9e7cb423f5ec89c',
    commitDate: '2026-10-05',
    owner: 'zubair-trabzada',
    publisher: 'Zubair Trabzada',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'Skills om gevonden en geciteerd te worden door AI-zoekmachines (GEO); gekozen zijn de delen die alleen pagina’s lezen.',
    skills: [
      { path: 'skills/geo-citability', pack: PACK, category: 'SEO', note: 'Geeft een pagina een score voor hoe graag AI-assistenten eruit citeren, met herschrijfvoorstellen.' },
      { path: 'skills/geo-llmstxt', pack: PACK, category: 'SEO', note: 'Controleert of maakt een llms.txt-bestand, zodat AI-systemen je site beter begrijpen.' },
      { path: 'skills/geo-crawlers', pack: PACK, category: 'SEO', note: 'Kijkt in robots.txt en headers welke AI-crawlers je site mogen lezen, met advies.' },
      { path: 'skills/geo-platform-optimizer', pack: PACK, category: 'SEO', note: 'Verbetert je zichtbaarheid per AI-zoekdienst: Google AI-overzichten, ChatGPT, Perplexity, Gemini en Copilot.' },
    ],
  },
  {
    // partner-built/brand-voice has its own LICENSE: MIT, Copyright (c) 2025 Tribe AI.
    id: 'brand-voice',
    repo: 'anthropics/knowledge-work-plugins',
    commit: KWP_COMMIT,
    commitDate: '2026-11-07',
    owner: 'anthropics',
    publisher: 'Tribe AI (in de plugins van Anthropic)',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'Legt je merkstem vast in richtlijnen en laat elke tekst daaraan voldoen.',
    skills: [
      { path: 'partner-built/brand-voice/skills/guideline-generation', root: 'partner-built/brand-voice', pack: PACK, category: 'Content', note: 'Maakt van je bestaande teksten en documenten heldere richtlijnen voor je merkstem.' },
      { path: 'partner-built/brand-voice/skills/brand-voice-enforcement', root: 'partner-built/brand-voice', pack: PACK, category: 'Content', note: 'Schrijft of herschrijft teksten precies in je merkstem, volgens je eigen richtlijnen.' },
      {
        path: 'partner-built/brand-voice/skills/discover-brand', root: 'partner-built/brand-voice',
        pack: PACK,
        category: 'Content',
        note: 'Zoekt in je gekoppelde bronnen naar bestaand merkmateriaal, zoals stijlgidsen en presentaties.',
        needs: 'Werkt het best met gekoppelde bronnen (bijvoorbeeld Google Drive of Notion).',
      },
    ],
  },
  {
    // small-business has no own licence file: the repository's LICENSE (Apache-2.0) applies.
    id: 'anthropic-kwp-brand-style',
    repo: 'anthropics/knowledge-work-plugins',
    commit: KWP_COMMIT,
    commitDate: '2026-11-07',
    owner: 'anthropics',
    publisher: 'Anthropic',
    license: 'Apache-2.0',
    verifiedAt: VERIFIED,
    note: 'Legt de huisstijl van je bedrijf vast, zodat alles wat de bot maakt er hetzelfde uitziet.',
    skills: [
      { path: 'small-business/skills/brand-style', root: 'small-business', pack: PACK, category: 'Content', note: 'Legt je huisstijl en voorkeuren vast (kleuren, lettertype, toon), zodat elk stuk er hetzelfde uitziet.' },
    ],
  },
  {
    // No licence file in the marketing folders: the repository's LICENSE (MIT) applies.
    id: 'alirezarezvani-social',
    repo: 'alirezarezvani/claude-skills',
    commit: '8f082544116fc0d014188e521ca40304cdfc86b0',
    commitDate: '2026-11-05',
    owner: 'alirezarezvani',
    publisher: 'Alireza Rezvani',
    license: 'MIT',
    verifiedAt: VERIFIED,
    note: 'Social-mediaskills van Alireza Rezvani: een contentplanning en sterke LinkedIn-berichten.',
    skills: [
      {
        path: 'marketing-skill/skills/social-media-manager', root: 'marketing-skill', scripts: true,
        pack: PACK,
        category: 'Social media',
        note: 'Maakt een social-mediaplanning per kanaal en week en houdt de toon per platform bij.',
        windows: { status: 'niet-getest', note: 'Eén Python-hulpscript maakt de planning; op Windows niet uitgevoerd door TeamBot. De werkwijze werkt zonder.' },
        needs: 'Optioneel Python 3 voor het planningsscript.',
      },
      {
        path: 'marketing/linkedin/skills/linkedin-content', root: 'marketing/linkedin', scripts: true,
        pack: PACK,
        category: 'Social media',
        note: 'Schrijft LinkedIn-berichten met een sterke opening en zet een lang stuk om in meerdere berichten.',
        windows: { status: 'niet-getest', note: 'Drie Python-hulpscripts (vorm kiezen, controleren, opsplitsen); op Windows niet uitgevoerd door TeamBot. De werkwijze werkt zonder.' },
        needs: 'Optioneel Python 3 voor de hulpscripts.',
      },
    ],
  },
];
