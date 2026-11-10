import YAML from 'yaml';

/**
 * SKILL.md parsing — compatible with the open Agent Skills layout:
 * a folder with `SKILL.md` (YAML frontmatter + Markdown instructions) and optional extra files.
 * Required frontmatter: `name`, `description`. Optional: `license`, `version`, `allowed-tools`,
 * `metadata` (string map), `compatibility`. Unknown keys are kept (other tools add their own).
 */

export const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_NAME = 64;
export const MAX_DESCRIPTION = 1024;

export interface SkillMeta {
  name: string;
  description: string;
  license: string;
  version: string;
  allowedTools: string[];
  metadata: Record<string, string>;
  compatibility: string;
  author: string;
  homepage: string;
  dependencies: string[];
  platforms: string[];
  /** Frontmatter keys we do not interpret (kept verbatim). */
  extra: Record<string, any>;
}

export interface ParsedSkill {
  meta: SkillMeta;
  body: string;
  /** Raw frontmatter object (as written). */
  frontmatter: Record<string, any>;
  hadFrontmatter: boolean;
  errors: string[];
  warnings: string[];
}

const KNOWN = new Set(['name', 'description', 'license', 'version', 'allowed-tools', 'allowed_tools', 'metadata', 'compatibility', 'author', 'homepage', 'dependencies', 'platforms']);
const PLATFORM_ALIASES: Record<string, string> = { win: 'windows', win32: 'windows', windows: 'windows', mac: 'macos', macos: 'macos', darwin: 'macos', osx: 'macos', linux: 'linux', ios: 'ios', android: 'android' };

/** Lowercase, ascii, hyphen-separated slug (max 64). */
export function slugify(s: string): string {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_NAME)
    .replace(/-+$/g, '');
}

/** Split `allowed-tools`: space- or comma-separated, parentheses kept together (e.g. `Bash(git:*) Read`). */
export function parseAllowedTools(v: any): string[] | null {
  if (v === undefined || v === null || v === '') return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean).slice(0, 100);
  if (typeof v !== 'string') return null;
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  for (const ch of v) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === ',' || /\s/.test(ch))) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.slice(0, 100);
}

function listOf(v: any): string[] {
  if (v === undefined || v === null || v === '') return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v)
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

const FM_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/;

/** Split a SKILL.md text into frontmatter text and body. */
export function splitFrontmatter(text: string): { fm: string | null; body: string } {
  const t = text.replace(/^﻿/, '');
  const m = t.match(FM_RE);
  if (!m) return { fm: null, body: t };
  return { fm: m[1], body: t.slice(m[0].length) };
}

export function parseSkillMd(text: string, opts: { fallbackName?: string } = {}): ParsedSkill {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { fm, body } = splitFrontmatter(String(text ?? ''));
  let data: Record<string, any> = {};
  if (fm === null) {
    errors.push('SKILL.md mist YAML-frontmatter. Begin het bestand met --- en daaronder minstens name: en description:, afgesloten met ---.');
  } else if (fm.trim()) {
    const doc = YAML.parseDocument(fm, { prettyErrors: false, uniqueKeys: false });
    if (doc.errors.length) errors.push(`Ongeldige YAML in de frontmatter: ${doc.errors[0].message.split('\n')[0]}`);
    else {
      const v = doc.toJS({ maxAliasCount: 50 });
      if (v === null || v === undefined) data = {};
      else if (typeof v !== 'object' || Array.isArray(v)) errors.push('De frontmatter moet uit sleutel: waarde-regels bestaan.');
      else data = v;
    }
  }

  // name
  let name = '';
  const rawName = data.name;
  if (rawName === undefined || rawName === null || rawName === '') {
    const fb = slugify(opts.fallbackName || '');
    if (fb) {
      name = fb;
      if (fm !== null && !errors.length) warnings.push(`Veld "name" ontbreekt; afgeleid van de mapnaam: ${fb}.`);
    } else if (fm !== null && !errors.length) errors.push('Veld "name" ontbreekt in de frontmatter.');
  } else {
    const s = String(rawName).trim();
    if (NAME_RE.test(s) && s.length <= MAX_NAME) name = s;
    else {
      name = slugify(s);
      if (!name) errors.push(`Ongeldige naam "${s.slice(0, 80)}": gebruik kleine letters, cijfers en streepjes.`);
      else warnings.push(`Naam "${s.slice(0, 80)}" is aangepast naar "${name}" (alleen kleine letters, cijfers en streepjes, max. ${MAX_NAME}).`);
    }
  }

  // description
  let description = '';
  const rawDesc = data.description;
  if (rawDesc === undefined || rawDesc === null || String(rawDesc).trim() === '') {
    if (fm !== null && !errors.length) errors.push('Veld "description" ontbreekt. Beschrijf in één of twee zinnen wat de skill doet en wanneer de bot hem moet gebruiken.');
  } else {
    if (typeof rawDesc !== 'string') warnings.push('Veld "description" is geen tekst; omgezet naar tekst.');
    description = String(rawDesc).replace(/\s+/g, ' ').trim();
    if (description.length > MAX_DESCRIPTION) {
      description = description.slice(0, MAX_DESCRIPTION);
      warnings.push(`Beschrijving ingekort tot ${MAX_DESCRIPTION} tekens.`);
    }
  }

  // license
  let license = '';
  if (data.license !== undefined && data.license !== null) {
    if (typeof data.license === 'string') license = data.license.trim().slice(0, 200);
    else warnings.push('Veld "license" is geen tekst en is genegeerd.');
  }

  // metadata
  const metadata: Record<string, string> = {};
  if (data.metadata !== undefined && data.metadata !== null) {
    if (typeof data.metadata === 'object' && !Array.isArray(data.metadata)) {
      for (const [k, v] of Object.entries(data.metadata).slice(0, 100)) metadata[String(k).slice(0, 100)] = (typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 2000);
    } else warnings.push('Veld "metadata" moet een lijst van sleutel: waarde zijn en is genegeerd.');
  }

  // version (top-level or metadata.version)
  let version = '';
  const rawVersion = data.version ?? data.metadata?.version;
  if (rawVersion !== undefined && rawVersion !== null && rawVersion !== '') {
    const s = String(rawVersion).trim();
    if (/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}$/.test(s)) version = s;
    else warnings.push(`Versie "${s.slice(0, 40)}" is ongeldig en is genegeerd.`);
  }

  // allowed-tools
  let allowedTools: string[] = [];
  const at = parseAllowedTools(data['allowed-tools'] ?? data.allowed_tools);
  if (at === null) warnings.push('Veld "allowed-tools" moet tekst of een lijst zijn en is genegeerd.');
  else allowedTools = at;

  let compatibility = '';
  if (data.compatibility !== undefined && data.compatibility !== null) {
    compatibility = (typeof data.compatibility === 'string' ? data.compatibility : JSON.stringify(data.compatibility)).slice(0, 500);
  }

  const author = String(data.author ?? metadata.author ?? '').slice(0, 200);
  const homepage = String(data.homepage ?? metadata.homepage ?? metadata.repository ?? metadata.source ?? '').slice(0, 500);
  const dependencies = listOf(data.dependencies ?? metadata.dependencies).slice(0, 50);
  const platforms = [...new Set(listOf(data.platforms ?? metadata.platforms).map((p) => PLATFORM_ALIASES[p.toLowerCase()] || p.toLowerCase()))].slice(0, 10);

  const extra: Record<string, any> = {};
  for (const [k, v] of Object.entries(data)) if (!KNOWN.has(k)) extra[k] = v;

  if (!body.trim() && !errors.length) errors.push('De skill bevat geen instructies (de tekst onder de frontmatter is leeg).');

  return {
    meta: { name, description, license, version, allowedTools, metadata, compatibility, author, homepage, dependencies, platforms, extra },
    body,
    frontmatter: data,
    hadFrontmatter: fm !== null,
    errors,
    warnings,
  };
}

/** Build SKILL.md text from fields (used for paste-without-frontmatter and bot drafts). */
export function buildSkillMd(fm: Record<string, any>, body: string): string {
  const clean: Record<string, any> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    if (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) continue;
    clean[k] = v;
  }
  return `---\n${YAML.stringify(clean, { lineWidth: 0 }).trimEnd()}\n---\n\n${String(body || '').trim()}\n`;
}

/** Replace a single frontmatter key, keeping the rest of the file as-is. */
export function setFrontmatterField(text: string, key: string, value: any): string {
  const { fm, body } = splitFrontmatter(text);
  const doc = YAML.parseDocument(fm ?? '');
  if (doc.errors.length) throw new Error('Ongeldige YAML in de frontmatter');
  if (value === undefined || value === null || value === '') doc.delete(key);
  else doc.set(key, value);
  return `---\n${String(doc).trimEnd()}\n---\n${body.startsWith('\n') ? '' : '\n'}${body}`;
}
