import path from 'node:path';
import YAML from 'yaml';
import { splitFrontmatter } from './format.js';
import { MARKETING_PUBLISHERS, MARKETING_REPOS } from './curated-marketing.js';

/**
 * Import rules for skills from TeamBot's own catalogue (research 2026-11-09: scanners can be bypassed, so the rules
 * are about what may come in at all, not about recognising bad content):
 *  - only readable text: programs, compiled code, archives and symbolic links make the whole skill refused; hidden
 *    files and other non-text files (images, fonts, PDFs) are left out and listed;
 *  - hard size limits per file, per skill and on the number of files, plus a check for padding (long runs of empty
 *    lines or whitespace, used to push content past what a reviewer or scanner looks at);
 *  - the SKILL.md `description` is written as one double-quoted YAML string, so every tool that reads the folder
 *    parses it the same way (a description with ": " in it is invalid YAML for strict parsers);
 *  - publisher names are compared with known organisations, so look-alikes (`browser-use-headless`) stand out.
 */

export const CURATED_LIMITS = {
  /** Files in one skill (including licence and source files). */
  maxFiles: 150,
  /** Bytes per file. */
  maxFileBytes: 512 * 1024,
  /** Bytes per skill. */
  maxSkillBytes: 4 * 1024 * 1024,
  /** Files referenced from outside the skill folder (`../shared/x.md`) that are taken along. */
  maxSourceFiles: 40,
  /** Empty lines in a row. */
  maxBlankRun: 300,
  /** Characters on one line. */
  maxLineLength: 50_000,
};

export type RuleAction = 'keep' | 'drop' | 'refuse';

export interface RuleResult {
  action: RuleAction;
  /** Plain Dutch reason (for drop and refuse). */
  reason?: string;
}

/** Archives and containers: never unpacked, never installed (a .docx is a zip too). */
const ARCHIVE_EXT = new Set([
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.tbz', '.xz', '.txz', '.zst', '.7z', '.rar', '.cab', '.iso', '.dmg', '.jar', '.war', '.ear', '.whl', '.egg', '.apk', '.ipa',
  '.msix', '.appx', '.nupkg', '.vsix', '.crx', '.xpi', '.deb', '.rpm', '.pkg', '.docx', '.xlsx', '.xlsm', '.pptx', '.potx', '.dotx', '.odt', '.ods', '.odp', '.epub', '.asar',
]);
/** Programs and compiled code. */
const PROGRAM_EXT = new Set([
  '.exe', '.dll', '.so', '.dylib', '.msi', '.com', '.scr', '.appimage', '.bin', '.elf', '.app', '.node', '.wasm', '.sys', '.cpl', '.ocx', '.drv', '.efi',
  '.pyc', '.pyo', '.pyd', '.class', '.o', '.obj', '.a', '.lib', '.ko', '.beam', '.luac',
]);
const JUNK = /(^|\/)(__MACOSX|node_modules|__pycache__|\.git|Thumbs\.db|desktop\.ini)(\/|$)/i;

/** Rules that need only the path and the git mode (applied to the repository tree before anything is downloaded). */
export function ruleForPath(rel: string, o: { mode?: string; type?: string; size?: number } = {}): RuleResult {
  if (o.type === 'commit') return { action: 'drop', reason: 'Verwijzing naar een andere repository (submodule); niet meegenomen.' };
  if (o.mode === '120000') return { action: 'refuse', reason: 'Symbolische koppeling; die kan naar bestanden buiten de skill wijzen.' };
  if (JUNK.test(rel)) return { action: 'drop', reason: 'Hulpbestand van een ontwikkeltool; niet nodig.' };
  if (rel.split('/').some((seg) => seg.startsWith('.'))) return { action: 'drop', reason: 'Verborgen bestand of map; niet meegenomen.' };
  const ext = path.posix.extname(rel).toLowerCase();
  if (ARCHIVE_EXT.has(ext)) return { action: 'refuse', reason: 'Archief of ingepakt bestand; de inhoud is niet te controleren.' };
  if (PROGRAM_EXT.has(ext)) return { action: 'refuse', reason: 'Programma of gecompileerde code; alleen leesbare tekst is toegestaan.' };
  if (o.size !== undefined && o.size > CURATED_LIMITS.maxFileBytes) return { action: 'refuse', reason: `Bestand te groot (${o.size} bytes, maximaal ${CURATED_LIMITS.maxFileBytes}).` };
  return { action: 'keep' };
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Rules on the content itself (after download). */
export function ruleForContent(rel: string, buf: Buffer): RuleResult {
  if (buf.length > CURATED_LIMITS.maxFileBytes) return { action: 'refuse', reason: `Bestand te groot (${buf.length} bytes, maximaal ${CURATED_LIMITS.maxFileBytes}).` };
  if (buf.length >= 4) {
    const mz = buf[0] === 0x4d && buf[1] === 0x5a;
    const elf = buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
    const macho = [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(buf.readUInt32BE(0));
    const zip = buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5 || buf[2] === 7);
    const gzip = buf[0] === 0x1f && buf[1] === 0x8b;
    const sevenZ = buf.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]));
    const rar = buf.subarray(0, 4).toString('latin1') === 'Rar!';
    if (mz || elf || macho) return { action: 'refuse', reason: 'Programma (uitvoerbaar bestand); alleen leesbare tekst is toegestaan.' };
    if (zip || gzip || sevenZ || rar) return { action: 'refuse', reason: 'Archief of ingepakt bestand; de inhoud is niet te controleren.' };
  }
  let text: string;
  try {
    text = utf8.decode(buf);
  } catch {
    return { action: 'drop', reason: 'Geen leesbare tekst (bijvoorbeeld een afbeelding of lettertype); niet meegenomen.' };
  }
  // Control characters other than tab, newline, carriage return and form feed: not something people read.
  const ctrl = (text.match(/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/g) || []).length;
  if (ctrl > 0) return { action: 'drop', reason: 'Bevat stuurtekens; geen gewone tekst. Niet meegenomen.' };
  const pad = paddingProblem(text);
  if (pad) return { action: 'refuse', reason: pad };
  void rel;
  return { action: 'keep' };
}

/** Long runs of empty lines, giant lines or a file that is almost only whitespace: content pushed out of sight. */
export function paddingProblem(text: string): string | null {
  let run = 0;
  let maxRun = 0;
  let longest = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      run++;
      if (run > maxRun) maxRun = run;
    } else run = 0;
    if (line.length > longest) longest = line.length;
  }
  if (maxRun > CURATED_LIMITS.maxBlankRun) return `Verdachte opvulling: ${maxRun} lege regels achter elkaar (zo kan tekst buiten beeld worden geschoven).`;
  if (longest > CURATED_LIMITS.maxLineLength) return `Verdachte opvulling: een regel van ${longest} tekens.`;
  if (text.length > 20_000) {
    const ws = (text.match(/\s/g) || []).length;
    if (ws / text.length > 0.9) return 'Verdachte opvulling: het bestand bestaat bijna alleen uit witruimte.';
  }
  return null;
}

// ------------------------------------------------------------------ description as quoted YAML

export interface DescriptionFix {
  text: string;
  changed: boolean;
  /** The frontmatter could not be parsed before and was repaired. */
  repaired: boolean;
  error?: string;
}

const NOTE = '# TeamBot: beschrijving als één YAML-tekst tussen aanhalingstekens gezet (verder ongewijzigd).';

/** Collapse whitespace like the SKILL.md parser does (description = one line). */
const oneLine = (s: string) => String(s).replace(/\s+/g, ' ').trim();

/**
 * Write the `description` of a SKILL.md as one double-quoted YAML string, keeping every other byte of the file. A
 * description that is already a single-line quoted string stays as it is. Frontmatter that does not parse because of
 * the description (an unquoted ": " in it) is repaired the same way. The result is parsed again and must give the
 * same description.
 */
export function quoteDescription(md: string): DescriptionFix {
  const bom = md.startsWith('﻿') ? '﻿' : '';
  const src = bom ? md.slice(1) : md;
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { text: md, changed: false, repaired: false, error: 'SKILL.md heeft geen frontmatter.' };
  const fm = m[1];
  const fmStart = m[0].indexOf(fm);
  const rebuild = (newFm: string) => bom + src.slice(0, fmStart) + newFm + src.slice(fmStart + fm.length);
  const eol = fm.includes('\r\n') ? '\r\n' : '\n';
  const doc = YAML.parseDocument(fm, { prettyErrors: false, uniqueKeys: false });
  if (!doc.errors.length) {
    const items: any[] = (doc.contents as any)?.items || [];
    const pair = items.find((p) => p?.key?.value === 'description');
    const v = pair?.value;
    if (!v || !Array.isArray(v.range)) return { text: md, changed: false, repaired: false };
    const raw = fm.slice(v.range[0], v.range[1]);
    const quoted = (v.type === 'QUOTE_DOUBLE' || v.type === 'QUOTE_SINGLE') && !raw.includes('\n');
    if (quoted || typeof v.value !== 'string') return { text: md, changed: false, repaired: false };
    const value = oneLine(v.value);
    const lineStart = fm.lastIndexOf('\n', pair.key.range[0]) + 1;
    const indent = fm.slice(lineStart, pair.key.range[0]);
    // Only top-level keys get the note line (a nested description keeps its layout).
    const note = indent === '' ? NOTE + eol : '';
    const newFm = fm.slice(0, lineStart) + note + fm.slice(lineStart, v.range[0]) + JSON.stringify(value) + (raw.endsWith('\n') ? eol : '') + fm.slice(v.range[1]);
    return verify(rebuild(newFm), value, false);
  }
  // Repair: the description line itself is what breaks the YAML (e.g. "description: Use when: x").
  const lines = fm.split(/\r?\n/);
  const i = lines.findIndex((l) => /^description:\s*\S/.test(l));
  if (i < 0) return { text: md, changed: false, repaired: false, error: `Ongeldige YAML in de frontmatter: ${doc.errors[0].message.split('\n')[0]}` };
  let j = i + 1;
  while (j < lines.length && /^\s+\S/.test(lines[j])) j++;
  const head = lines[i].replace(/^description:\s*/, '');
  if (/^["'>|]/.test(head)) return { text: md, changed: false, repaired: false, error: `Ongeldige YAML in de frontmatter: ${doc.errors[0].message.split('\n')[0]}` };
  const value = oneLine([head, ...lines.slice(i + 1, j)].join(' '));
  const out = [...lines.slice(0, i), NOTE, `description: ${JSON.stringify(value)}`, ...lines.slice(j)].join(eol);
  return verify(rebuild(out), value, true);
}

function verify(text: string, want: string, repaired: boolean): DescriptionFix {
  const { fm } = splitFrontmatter(text);
  const doc = YAML.parseDocument(fm ?? '', { prettyErrors: false, uniqueKeys: false });
  if (doc.errors.length) return { text, changed: true, repaired, error: `Ongeldige YAML in de frontmatter: ${doc.errors[0].message.split('\n')[0]}` };
  const got = (doc.toJS() as any)?.description;
  if (typeof got !== 'string' || oneLine(got) !== want) return { text, changed: true, repaired, error: 'De beschrijving veranderde bij het herschrijven; niet aangepast.' };
  return { text, changed: true, repaired };
}

// ------------------------------------------------------------------ publishers

/**
 * GitHub organisations and people whose skills or MCP servers are widely used (research 2026-11-09), lower case.
 * Not a trust list: it is what look-alike names are compared with.
 */
export const KNOWN_PUBLISHERS = [
  'anthropics', 'openai', 'microsoft', 'google', 'google-gemini', 'googleworkspace', 'googleapis', 'github', 'vercel', 'vercel-labs', 'cloudflare', 'supabase',
  'stripe', 'shopify', 'huggingface', 'getsentry', 'expo', 'upstash', 'modelcontextprotocol', 'agentskills', 'agentsmd', 'obra', 'mattpocock', 'addyosmani',
  'coreyhaines31', 'agricidaniel', 'blader', 'othmanadi', 'kepano', 'wshobson', 'trailofbits', 'browser-use', 'paperclipai', 'jina-ai', 'nickclyde',
  'taylorwilsdon', 'wordpress', 'automattic', 'woocommerce', 'makenotion', 'linear', 'atlassian', 'slackapi', 'posthog', 'resend', 'elevenlabs', 'n8n-io',
  'brave', 'tavily-ai', 'firecrawl', 'exa-labs', 'semgrep', 'bitwarden', 'box', 'wix', 'webflow', 'larksuite', 'heygen-com', 'k-dense-ai', 'remotion-dev',
  'snyk', 'cisco-ai-defense', 'playwright', 'puppeteer', 'docker', 'hashicorp', 'mongodb', 'redis', 'neondatabase', 'prisma', 'figma', 'canva', 'notion',
  ...MARKETING_PUBLISHERS,
];

/** Distinctive repository names: the same name under another owner is a copy or a fake. */
export const KNOWN_REPOS: Record<string, string> = {
  superpowers: 'obra',
  'superpowers-skills': 'obra',
  'knowledge-work-plugins': 'anthropics',
  'claude-plugins-official': 'anthropics',
  marketingskills: 'coreyhaines31',
  'claude-seo': 'agricidaniel',
  humanizer: 'blader',
  'planning-with-files': 'othmanadi',
  'browser-use': 'browser-use',
  'playwright-mcp': 'microsoft',
  'github-mcp-server': 'github',
  'duckduckgo-mcp-server': 'nickclyde',
  'google_workspace_mcp': 'taylorwilsdon',
  'obsidian-skills': 'kepano',
  'agent-browser': 'vercel-labs',
  ...MARKETING_REPOS,
};

export interface PublisherCheck {
  owner: string;
  status: 'known' | 'lookalike' | 'unknown';
  /** The known name it resembles. */
  like?: string;
  /** Plain Dutch explanation (look-alike only). */
  reason?: string;
}

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/** Compare a GitHub owner (and optionally the repository name) with known publishers. */
export function checkPublisher(ownerRaw: string, repoRaw?: string, known: string[] = KNOWN_PUBLISHERS): PublisherCheck {
  const owner = String(ownerRaw || '').trim();
  const o = owner.toLowerCase();
  const repo = String(repoRaw || '').trim().toLowerCase();
  const flat = (s: string) => s.replace(/[-_.]/g, '');
  const look = (like: string, why: string): PublisherCheck => ({ owner, status: 'lookalike', like, reason: `De uitgever “${owner}” lijkt op “${like}”, maar is het niet (${why}). Zo zien nep-kopieën van bekende skills eruit.` });
  if (!o) return { owner, status: 'unknown' };
  const repoOwner = repo ? KNOWN_REPOS[repo] : undefined;
  if (known.includes(o)) {
    if (repoOwner && repoOwner !== o) return look(`${repoOwner}/${repo}`, 'dezelfde repositorynaam onder een andere uitgever');
    return { owner, status: 'known' };
  }
  for (const k of known) {
    if (flat(o) === flat(k)) return look(k, 'alleen streepjes of punten verschillen');
  }
  for (const k of known) {
    if (k.length >= 5 && o.includes(k)) return look(k, 'de bekende naam met iets ervoor of erachter');
  }
  for (const k of known) {
    const max = k.length >= 8 ? 2 : k.length >= 4 ? 1 : 0;
    if (max && Math.abs(k.length - o.length) <= max && editDistance(o, k) <= max) return look(k, 'een of twee letters verschil');
  }
  if (repoOwner) return look(`${repoOwner}/${repo}`, 'dezelfde repositorynaam onder een andere uitgever');
  return { owner, status: 'unknown' };
}

/** The GitHub owner and repository of an import source (github.com URL or "owner/repo…" label), if any. */
export function githubOwnerOf(src: { type?: string; url?: string; label?: string; publisher?: string } | null | undefined): { owner: string; repo: string } | null {
  if (!src) return null;
  const fromUrl = /^https?:\/\/(?:www\.)?(?:github\.com|raw\.githubusercontent\.com)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i.exec(String(src.url || ''));
  if (fromUrl) return { owner: fromUrl[1], repo: fromUrl[2].replace(/\.git$/, '') };
  if (src.type === 'github') {
    const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/.exec(String(src.label || ''));
    if (m) return { owner: m[1], repo: m[2].replace(/@.*$/, '') };
  }
  return null;
}
