import path from 'node:path';
import type { FileMap } from './files.js';

/**
 * Licence detection for skills from the internet. Only openly licensed skills can be installed from an internet
 * source; source-available, proprietary, "terms of use" and non-commercial/no-derivatives material is shown but
 * marked as not installable, and so is anything without a licence we can find (no licence = all rights reserved).
 * Detection is deliberately conservative: an unrecognised text is "unknown", never "open".
 */

export type LicenseStatus = 'open' | 'restricted' | 'unknown';

export interface LicenseInfo {
  /** SPDX identifier when recognised. */
  spdx: string | null;
  /** Human-readable name (SPDX id, or what the source says). */
  label: string;
  status: LicenseStatus;
  /** Where the licence was found. */
  source: 'skill-file' | 'frontmatter' | 'repo-file' | 'github' | 'registry' | 'none';
  file?: string;
}

const OPEN = new Set([
  'MIT', 'MIT-0', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'Unlicense', 'CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'CC-BY-3.0',
  'MPL-2.0', 'GPL-2.0', 'GPL-3.0', 'LGPL-2.1', 'LGPL-3.0', 'AGPL-3.0', 'EPL-2.0', 'Zlib', 'BSL-1.0', 'Python-2.0', 'PSF-2.0', 'Artistic-2.0', 'EUPL-1.2', 'WTFPL', 'BlueOak-1.0.0',
]);
const RESTRICTED_IDS = /^(BUSL|Elastic|SSPL|PolyForm|FSL|Commons-Clause|CC-BY-NC|CC-BY-ND|CC-BY-NC-SA|CC-BY-NC-ND|LicenseRef-)/i;
const RESTRICTED_TEXT = /\b(proprietary|all rights reserved|source[- ]available|business source license|elastic license|server side public license|polyform|commons clause|functional source license|non-?commercial|no ?derivatives|developer terms|terms of (use|service)|is governed by|confidential)\b/i;

/** Normalise a licence identifier or short name (frontmatter, package metadata, GitHub API). */
export function normalizeLicenseId(raw: string | null | undefined): string | null {
  const s = String(raw || '').trim();
  if (!s || s.length > 120) return null;
  const k = s.toLowerCase().replace(/[\s_]+/g, '-').replace(/^the-/, '').replace(/-license$/, '');
  const map: Record<string, string> = {
    mit: 'MIT', 'mit-0': 'MIT-0', 'expat': 'MIT',
    apache: 'Apache-2.0', 'apache-2': 'Apache-2.0', 'apache-2.0': 'Apache-2.0', 'apache-v2': 'Apache-2.0', 'apache-license-2.0': 'Apache-2.0', 'apache-license-version-2.0': 'Apache-2.0', 'apache2': 'Apache-2.0', 'asl-2.0': 'Apache-2.0',
    'bsd-2-clause': 'BSD-2-Clause', 'bsd-3-clause': 'BSD-3-Clause', 'bsd': 'BSD-3-Clause', isc: 'ISC', '0bsd': '0BSD', unlicense: 'Unlicense',
    cc0: 'CC0-1.0', 'cc0-1.0': 'CC0-1.0', 'cc-by-4.0': 'CC-BY-4.0', 'cc-by-sa-4.0': 'CC-BY-SA-4.0', 'cc-by-3.0': 'CC-BY-3.0',
    'mpl-2.0': 'MPL-2.0', 'gpl-2.0': 'GPL-2.0', 'gpl-2.0-only': 'GPL-2.0', 'gpl-2.0-or-later': 'GPL-2.0', 'gpl-3.0': 'GPL-3.0', 'gpl-3.0-only': 'GPL-3.0', 'gpl-3.0-or-later': 'GPL-3.0', gplv3: 'GPL-3.0', gplv2: 'GPL-2.0',
    'lgpl-2.1': 'LGPL-2.1', 'lgpl-2.1-only': 'LGPL-2.1', 'lgpl-2.1-or-later': 'LGPL-2.1', 'lgpl-3.0': 'LGPL-3.0', 'lgpl-3.0-only': 'LGPL-3.0', 'lgpl-3.0-or-later': 'LGPL-3.0',
    'agpl-3.0': 'AGPL-3.0', 'agpl-3.0-only': 'AGPL-3.0', 'agpl-3.0-or-later': 'AGPL-3.0', 'epl-2.0': 'EPL-2.0', zlib: 'Zlib', 'bsl-1.0': 'BSL-1.0', 'python-2.0': 'Python-2.0', 'psf-2.0': 'PSF-2.0',
    'artistic-2.0': 'Artistic-2.0', 'eupl-1.2': 'EUPL-1.2', wtfpl: 'WTFPL', 'blueoak-1.0.0': 'BlueOak-1.0.0',
  };
  if (map[k]) return map[k];
  // Already an SPDX-looking id we know (case-insensitive).
  for (const id of OPEN) if (id.toLowerCase() === k) return id;
  if (RESTRICTED_IDS.test(s)) return s.split(/\s/)[0];
  return null;
}

/** Classify a short licence value (frontmatter `license:`, npm/PyPI metadata, GitHub API). null = not a licence statement. */
export function classifyId(raw: string | null | undefined): { spdx: string | null; label: string; status: LicenseStatus } | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (RESTRICTED_TEXT.test(s) && !OPEN.has(normalizeLicenseId(s) || '')) return { spdx: null, label: s.slice(0, 80), status: 'restricted' };
  if (/^(see|complete terms|full terms|terms in|licen[cs]e(d)? in|zie)\b/i.test(s) || /\blicen[cs]e(\.txt|\.md)?\b.*\b(file|has|for)\b/i.test(s)) return null;
  if (/^(noassertion|other|unknown|unlicensed)$/i.test(s)) return { spdx: null, label: s, status: 'unknown' };
  // SPDX expressions: "MIT OR Apache-2.0" is open when one side is.
  const parts = s.split(/\s+(?:or|OR|\/)\s+/);
  if (parts.length > 1) {
    const ids = parts.map(normalizeLicenseId);
    const open = ids.find((x) => x && OPEN.has(x));
    if (open) return { spdx: open, label: s.slice(0, 80), status: 'open' };
  }
  const id = normalizeLicenseId(s);
  if (id && OPEN.has(id)) return { spdx: id, label: id, status: 'open' };
  if ((id && RESTRICTED_IDS.test(id)) || RESTRICTED_TEXT.test(s)) return { spdx: id, label: s.slice(0, 80), status: 'restricted' };
  return { spdx: null, label: s.slice(0, 80), status: 'unknown' };
}

/** Recognise a licence file's text. */
export function classifyText(raw: string): { spdx: string | null; status: LicenseStatus } {
  const t = raw.slice(0, 20_000).replace(/\s+/g, ' ');
  const head = t.slice(0, 400);
  if (/^(.{0,120})(business source license|elastic license|server side public license|polyform|functional source license)/i.test(head)) return { spdx: null, status: 'restricted' };
  if (/attribution-?noncommercial|attribution-?noderivatives|creative commons.{0,40}(noncommercial|no ?derivatives|\bnc\b|\bnd\b)/i.test(head)) return { spdx: null, status: 'restricted' };
  if (/Apache License,? Version 2\.0/i.test(t)) return { spdx: 'Apache-2.0', status: 'open' };
  if (/Permission is hereby granted, free of charge, to any person obtaining a copy/i.test(t)) return { spdx: 'MIT', status: 'open' };
  if (/BSD Zero Clause/i.test(head)) return { spdx: '0BSD', status: 'open' };
  if (/Permission to use, copy, modify, and\/?or distribute this software for any purpose/i.test(t)) return { spdx: 'ISC', status: 'open' };
  if (/Redistribution and use in source and binary forms/i.test(t)) return { spdx: /Neither the name/i.test(t) ? 'BSD-3-Clause' : 'BSD-2-Clause', status: 'open' };
  if (/Mozilla Public License,? (v\. ?|version )?2\.0/i.test(t)) return { spdx: 'MPL-2.0', status: 'open' };
  if (/This is free and unencumbered software released into the public domain/i.test(t)) return { spdx: 'Unlicense', status: 'open' };
  if (/CC0 1\.0 Universal/i.test(t)) return { spdx: 'CC0-1.0', status: 'open' };
  if (/Attribution-ShareAlike 4\.0 International/i.test(t)) return { spdx: 'CC-BY-SA-4.0', status: 'open' };
  if (/Attribution 4\.0 International/i.test(t)) return { spdx: 'CC-BY-4.0', status: 'open' };
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(t)) return { spdx: 'AGPL-3.0', status: 'open' };
  if (/GNU LESSER GENERAL PUBLIC LICENSE/i.test(t)) return { spdx: /Version 2\.1/i.test(t) ? 'LGPL-2.1' : 'LGPL-3.0', status: 'open' };
  if (/GNU GENERAL PUBLIC LICENSE/i.test(t)) return { spdx: /Version 2,/i.test(t) ? 'GPL-2.0' : 'GPL-3.0', status: 'open' };
  if (/Boost Software License/i.test(t)) return { spdx: 'BSL-1.0', status: 'open' };
  if (/Eclipse Public License - v 2\.0/i.test(t)) return { spdx: 'EPL-2.0', status: 'open' };
  if (/European Union Public Licen[cs]e/i.test(t) && /1\.2/.test(t)) return { spdx: 'EUPL-1.2', status: 'open' };
  if (/provided ['‘’]as-is['‘’], without any express or implied warranty/i.test(t) && /Permission is granted to anyone to use this software for any purpose/i.test(t)) return { spdx: 'Zlib', status: 'open' };
  if (RESTRICTED_TEXT.test(t)) return { spdx: null, status: 'restricted' };
  return { spdx: null, status: 'unknown' };
}

const LICENSE_FILE = /^(licen[cs]e|copying)(\.(txt|md|markdown|rst))?$/i;

/** Licence files directly in a folder of a FileMap (root = '' for the top). */
export function licenseFilesIn(files: FileMap | Map<string, Buffer>, dir = ''): string[] {
  const pre = dir ? dir.replace(/\/+$/, '') + '/' : '';
  return [...files.keys()].filter((p) => p.startsWith(pre) && !p.slice(pre.length).includes('/') && LICENSE_FILE.test(path.posix.basename(p)));
}

/**
 * Licence of one skill. Order: a licence file in the skill folder, the SKILL.md `license` field, a licence file at
 * the repository root, the licence GitHub detected for the repository. The first recognised statement wins; a
 * restrictive statement anywhere in the skill itself (file or frontmatter) always wins over an open repository licence.
 */
export function resolveSkillLicense(o: { skillFiles: FileMap; frontmatter?: string; repoFiles?: { path: string; text: string }[]; githubSpdx?: string | null }): LicenseInfo {
  const own = licenseFilesIn(o.skillFiles, '');
  for (const f of own) {
    const c = classifyText(o.skillFiles.get(f)!.toString('utf8'));
    if (c.status !== 'unknown') return { spdx: c.spdx, label: c.spdx || (c.status === 'restricted' ? 'Beperkende licentie' : 'Onbekend'), status: c.status, source: 'skill-file', file: f };
  }
  const fm = classifyId(o.frontmatter);
  if (fm && fm.status !== 'unknown') return { ...fm, source: 'frontmatter' };
  if (own.length) return { spdx: null, label: 'Niet herkend', status: 'unknown', source: 'skill-file', file: own[0] };
  for (const f of o.repoFiles || []) {
    const c = classifyText(f.text);
    if (c.status !== 'unknown') return { spdx: c.spdx, label: c.spdx || 'Beperkende licentie', status: c.status, source: 'repo-file', file: f.path };
  }
  const gh = classifyId(o.githubSpdx);
  if (gh && gh.status !== 'unknown') return { ...gh, source: 'github' };
  if (fm) return { ...fm, source: 'frontmatter' };
  return { spdx: null, label: 'Geen licentie gevonden', status: 'unknown', source: 'none' };
}

export function licenseReason(l: LicenseInfo): string | null {
  if (l.status === 'open') return null;
  if (l.status === 'restricted') return `De licentie (${l.label}) staat hergebruik niet vrij toe; daarom installeert TeamBot deze skill niet vanaf internet. Bekijk de voorwaarden bij de bron.`;
  return 'Geen open licentie gevonden. Zonder licentie houdt de maker alle rechten; daarom installeert TeamBot deze skill niet vanaf internet. Vraag de maker om een licentie.';
}

// ------------------------------------------------------------------ categories

/** Keyword-based categories for internet items (the sources themselves have none). Labels are TeamBot's own. */
export const CATEGORIES: { id: string; label: string; re: RegExp }[] = [
  { id: 'ontwikkeling', label: 'Ontwikkeling', re: /\b(code|coding|git|github|gitlab|repo(sitory)?|pull requests?|typescript|javascript|python|rust|golang|react|next\.?js|vue|svelte|api|sdk|debug(ging)?|tests?|testing|tdd|lint(ing)?|refactor(ing)?|npm|frontend|backend|developers?|programming|cli|codebase|swift|kotlin|android|ios|expo)\b/gi },
  { id: 'cloud', label: 'Cloud & DevOps', re: /\b(aws|azure|gcp|google cloud|cloudflare|vercel|netlify|kubernetes|k8s|aks|docker|terraform|deploy(ment|s)?|ci\/cd|devops|serverless|infrastructure|observability|monitoring|sentry|workers)\b/gi },
  { id: 'data', label: 'Data & analyse', re: /\b(databases?|sql|postgres(ql)?|mysql|sqlite|mongo(db)?|redis|supabase|bigquery|snowflake|analytics|dashboards?|spreadsheets?|excel|xlsx|csv|datasets?|data science|pandas|charts?|jupyter|notebooks?|machine learning|ml|models?)\b/gi },
  { id: 'documenten', label: 'Documenten', re: /\b(pdf|docx|word documents?|pptx|powerpoint|slides?|presentations?|documents?|markdown|notion|confluence|wiki|reports?)\b/gi },
  { id: 'ontwerp', label: 'Ontwerp & media', re: /\b(design|figma|ui|ux|css|tailwind|images?|video|audio|animation|canvas|art|brand(ing)?|fonts?|photos?|music|3d|gif|remotion|theme)\b/gi },
  { id: 'communicatie', label: 'Communicatie', re: /\b(slack|e-?mail|gmail|outlook|discord|telegram|whatsapp|teams|sms|messages?|newsletters?|social media|twitter|linkedin|marketing|comms|writing|copywriting)\b/gi },
  { id: 'productiviteit', label: 'Productiviteit', re: /\b(calendar|agenda|todos?|tasks?|project management|jira|linear|asana|trello|meetings?|notes|planning|crm|hubspot|salesforce|workflows?|tickets?|productivity)\b/gi },
  { id: 'kennis', label: 'Zoeken & kennis', re: /\b(search|web|fetch|scrap(e|ing)|crawl(ing)?|research|arxiv|wikipedia|news|knowledge|documentation|docs|rag|memory|learn)\b/gi },
  { id: 'browser', label: 'Browser & automatisering', re: /\b(browser|playwright|puppeteer|selenium|automation|headless|chrome)\b/gi },
  { id: 'beveiliging', label: 'Beveiliging', re: /\b(security|vulnerabilit(y|ies)|audit(ing)?|pentest(ing)?|secrets?|compliance|threat|cve|malware|smart contracts?)\b/gi },
  { id: 'financien', label: 'Financiën', re: /\b(finance|financial|stocks?|crypto|bitcoin|blockchain|payments?|stripe|invoices?|accounting|trading|bank(ing)?)\b/gi },
];

export function categorize(...texts: string[]): string {
  const hay = texts.filter(Boolean).join(' ').slice(0, 4000);
  let best = 'Overig';
  let score = 0;
  for (const c of CATEGORIES) {
    const n = (hay.match(c.re) || []).length;
    if (n > score) {
      score = n;
      best = c.label;
    }
  }
  return best;
}
