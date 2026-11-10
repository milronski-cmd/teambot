import type { Ctx } from '../../core/types.js';
import { defineTable, newId, now } from '../../core/db.js';
import { HttpError } from '../../core/http.js';
import { BUILTIN_BOTS, BUILTIN_SKILLS } from './builtin-catalog.js';
import { type FileMap, LIMITS, checksumOf, filesFromZip, findSkillRoots, safeRelPath, sha256, stripTopFolder, subset } from './files.js';
import { buildSkillMd, slugify } from './format.js';
import type { Fetcher } from './fetch.js';
import { MANIFEST_FILE, type InlinePackage, type PackageVerification } from '../../../packages/teambot-sdk/src/index.js';
import { failedVerification, verifyFiles, verifyInline } from './publishers.js';
import { FACE_PREFIX, encodeFace, parseFace } from '../../../shared/botface.js';

defineTable('skill_catalogs', { json: ['data'], bool: ['enabled'] });
defineTable('skill_shares', { json: ['data', 'review'] });

export const CATALOG_FORMAT = 'teambot.catalog/v1';
const ITEM_ID = /^[a-z0-9][a-z0-9._-]{0,80}$/;
const SHA = /^[a-f0-9]{64}$/;

export type FileContent = string | { base64: string };

export interface Changelog {
  version: string;
  date: string;
  notes: string;
}

interface Common {
  catalogId: string;
  catalogName: string;
  sourceKind: 'builtin' | 'external' | 'server';
  id: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  version: string;
  license: string;
  publisher: string;
  homepage: string;
  changelog: Changelog[];
  verified: boolean;
}

export interface MarketSkill extends Common {
  type: 'skill';
  name: string;
  author: string;
  platforms: string[];
  dependencies: string[];
  files?: Record<string, FileContent>;
  download?: { url: string; sha256: string; size?: number; subdir?: string };
  sha256?: string;
  /** teambot-package.json of a signed skill (verified against the files at install). */
  manifest?: any;
}

export interface MarketBot extends Common {
  type: 'bot';
  role: string;
  avatar: string;
  color: string;
  instructions: string;
  tool_groups: string[];
  access_mode: string;
  /** Skill item ids in the same catalog. */
  skills: string[];
  model_hint: string;
  /** Pre-built template (server shares). */
  template?: any;
  /** A bot package: `{ manifest, files: { 'bot.json': … } }`; the template comes from bot.json. */
  package?: InlinePackage;
}

/** A connector template from an external catalog: `{ manifest, files: { 'connector.json': … } }`. */
export interface MarketConnector extends Common {
  type: 'connector';
  package: InlinePackage;
}

const s = (v: any, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : '');
const list = (v: any, max = 20) => (Array.isArray(v) ? v.map((x) => s(x, 60)).filter(Boolean).slice(0, max) : []);

/**
 * Avatar of a bot template from an untrusted file or catalogue: a drawn bot face (`face:{json}`) is re-encoded from
 * the same trait whitelist the UI draws with (unknown keys and values dropped), anything else is an emoji/short text
 * of at most 16 characters. Photos and links (http(s), data:, /path) never travel in a template: they would make
 * every viewer's browser load a stranger's URL.
 */
export function templateAvatar(v: unknown): string {
  const raw = typeof v === 'string' ? v.trim() : '';
  if (raw.startsWith(FACE_PREFIX)) {
    if (raw.length > 500) return '';
    const traits = parseFace(raw);
    return traits && Object.keys(traits).length ? encodeFace(traits) : '';
  }
  if (/^(https?:|data:|\/)/i.test(raw)) return '';
  return raw.slice(0, 16);
}
function changelogOf(v: any): Changelog[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 50).map((c) => ({ version: s(c?.version, 40), date: s(c?.date, 40), notes: s(c?.notes, 2000) })).filter((c) => c.version || c.notes);
}

export function filesToMap(files: Record<string, FileContent>): FileMap {
  const out: FileMap = new Map();
  for (const [p, c] of Object.entries(files || {})) {
    const rel = safeRelPath(p);
    if (!rel) throw new Error(`Onveilig pad in de catalogus: ${p.slice(0, 100)}`);
    const b = typeof c === 'string' ? Buffer.from(c, 'utf8') : c && typeof c.base64 === 'string' ? Buffer.from(c.base64, 'base64') : null;
    if (!b) throw new Error(`Ongeldige bestandsinhoud voor ${rel}`);
    out.set(rel.toLowerCase() === 'skill.md' ? 'SKILL.md' : rel, b);
  }
  return out;
}

export function mapToFiles(files: FileMap): Record<string, FileContent> {
  const out: Record<string, FileContent> = {};
  for (const [p, b] of [...files.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const text = b.toString('utf8');
    out[p] = Buffer.from(text, 'utf8').equals(b) && !b.includes(0) ? text : { base64: b.toString('base64') };
  }
  return out;
}

/** Validate and normalise an external catalog index. Items without a checksum are skipped. */
export function parseIndex(json: any, meta: { catalogId: string; sourceKind: 'external' | 'server' }) {
  if (!json || typeof json !== 'object' || json.format !== CATALOG_FORMAT) throw new Error(`Geen geldige catalogus: het veld "format" moet "${CATALOG_FORMAT}" zijn.`);
  const name = s(json.name, 120);
  if (!name) throw new Error('De catalogus heeft geen naam ("name").');
  const publisher = s(json.publisher, 120) || 'Onbekende uitgever';
  const warnings: string[] = [];
  const skills: MarketSkill[] = [];
  const bots: MarketBot[] = [];
  const base = (x: any): Omit<Common, 'id'> => ({
    catalogId: meta.catalogId,
    catalogName: name,
    sourceKind: meta.sourceKind,
    title: s(x.title, 120) || s(x.name, 120) || s(x.id, 80),
    description: s(x.description, 1024),
    category: s(x.category, 60) || 'Overig',
    tags: list(x.tags),
    version: s(x.version, 40),
    license: s(x.license, 120),
    publisher: s(x.publisher, 120) || publisher,
    homepage: s(x.homepage, 500),
    changelog: changelogOf(x.changelog),
    verified: false,
  });
  for (const x of Array.isArray(json.skills) ? json.skills.slice(0, 500) : []) {
    const id = s(x?.id, 81);
    if (!ITEM_ID.test(id)) {
      warnings.push(`Skill overgeslagen: ongeldige id "${id.slice(0, 40)}".`);
      continue;
    }
    if (!s(x.description)) {
      warnings.push(`Skill ${id} overgeslagen: beschrijving ontbreekt.`);
      continue;
    }
    const item: MarketSkill = { type: 'skill', id, ...base(x), name: slugify(s(x.name, 64) || id), author: s(x.author, 120), platforms: list(x.platforms, 10), dependencies: list(x.dependencies, 50) };
    if (x.download && typeof x.download === 'object') {
      const url = s(x.download.url, 2000);
      const sum = s(x.download.sha256, 64).toLowerCase();
      if (!/^https:\/\//i.test(url) || !SHA.test(sum)) {
        warnings.push(`Skill ${id} overgeslagen: download vereist een https-URL en een sha256-checksum.`);
        continue;
      }
      item.download = { url, sha256: sum, size: Number(x.download.size) || undefined, subdir: s(x.download.subdir, 300) || undefined };
    } else if (x.files && typeof x.files === 'object') {
      const sum = s(x.sha256, 64).toLowerCase();
      if (!SHA.test(sum)) {
        warnings.push(`Skill ${id} overgeslagen: sha256-checksum van de bestanden ontbreekt.`);
        continue;
      }
      item.files = x.files;
      item.sha256 = sum;
    } else {
      warnings.push(`Skill ${id} overgeslagen: geen "files" of "download".`);
      continue;
    }
    if (isObj(x.manifest)) item.manifest = x.manifest;
    skills.push(item);
  }
  for (const x of Array.isArray(json.bots) ? json.bots.slice(0, 200) : []) {
    const id = s(x?.id, 81);
    if (!ITEM_ID.test(id)) {
      warnings.push(`Bot overgeslagen: ongeldige id "${id.slice(0, 40)}".`);
      continue;
    }
    if (isObj(x.files)) {
      // Bot package: display fields come from bot.json (the signed content), not from the index.
      const raw = typeof x.files['bot.json'] === 'string' ? x.files['bot.json'] : null;
      let t: any = null;
      try {
        t = raw ? JSON.parse(raw) : null;
      } catch {
        t = null;
      }
      if (!t || typeof t !== 'object') {
        warnings.push(`Bot ${id} overgeslagen: het pakket bevat geen geldig bot.json.`);
        continue;
      }
      bots.push({
        type: 'bot',
        id,
        ...base({ ...x, title: x.title || t.name, description: x.description || t.description, version: x.version || x.manifest?.version, license: x.license || x.manifest?.license }),
        role: s(t.role, 120),
        avatar: templateAvatar(t.avatar),
        color: /^#[0-9a-fA-F]{6}$/.test(s(t.color, 7)) ? s(t.color, 7) : '#6366f1',
        instructions: s(t.instructions, 60_000),
        tool_groups: list(t.tool_groups, 20),
        access_mode: s(t.access_mode, 20) || 'ask',
        skills: Array.isArray(t.skills) ? t.skills.map((k: any) => s(k?.name, 64)).filter(Boolean).slice(0, 30) : [],
        model_hint: s(t.model_hint, 100),
        package: { manifest: isObj(x.manifest) ? x.manifest : null, files: x.files },
      });
      continue;
    }
    bots.push({
      type: 'bot',
      id,
      ...base(x),
      role: s(x.role, 120),
      avatar: templateAvatar(x.avatar),
      color: /^#[0-9a-fA-F]{6}$/.test(s(x.color, 7)) ? s(x.color, 7) : '#6366f1',
      instructions: s(x.instructions, 60_000),
      tool_groups: list(x.tool_groups, 20),
      access_mode: s(x.access_mode, 20) || 'ask',
      skills: list(x.skills, 30),
      model_hint: s(x.model_hint, 100),
    });
  }
  const connectors: MarketConnector[] = [];
  for (const x of Array.isArray(json.connectors) ? json.connectors.slice(0, 200) : []) {
    const id = s(x?.id, 81);
    if (!ITEM_ID.test(id)) {
      warnings.push(`Connector overgeslagen: ongeldige id "${id.slice(0, 40)}".`);
      continue;
    }
    if (!isObj(x.files) || typeof x.files['connector.json'] !== 'string') {
      warnings.push(`Connector ${id} overgeslagen: het pakket bevat geen connector.json.`);
      continue;
    }
    let t: any = {};
    try {
      t = JSON.parse(x.files['connector.json']) || {};
    } catch {
      warnings.push(`Connector ${id} overgeslagen: connector.json is geen geldige JSON.`);
      continue;
    }
    connectors.push({
      type: 'connector',
      id,
      ...base({ ...x, title: x.title || t.name, description: x.description || t.description, category: x.category || t.category, version: x.version || x.manifest?.version, license: x.license || x.manifest?.license }),
      package: { manifest: isObj(x.manifest) ? x.manifest : null, files: x.files },
    });
  }
  return { name, publisher, homepage: s(json.homepage, 500), updated: s(json.updated, 40), skills, bots, connectors, warnings };
}

const isObj = (v: any): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

export function externalKey(url: string) {
  return 'ext-' + sha256(url.trim()).slice(0, 12);
}

export class Catalogs {
  private builtinSkillItems: MarketSkill[];
  private builtinBotItems: MarketBot[];

  constructor(private ctx: Ctx, private fetcher: () => Fetcher) {
    this.builtinSkillItems = BUILTIN_SKILLS.map((b) => {
      const files: Record<string, string> = { 'SKILL.md': buildSkillMd({ name: b.id, description: b.description, license: 'Apache-2.0', version: b.version, metadata: { author: 'TeamBot', category: b.category } }, b.body), ...(b.extraFiles || {}) };
      return {
        type: 'skill',
        catalogId: 'builtin',
        catalogName: 'TeamBot-startcatalogus',
        sourceKind: 'builtin',
        id: b.id,
        name: b.id,
        title: b.title,
        description: b.description,
        category: b.category,
        tags: b.tags,
        version: b.version,
        license: 'Apache-2.0',
        publisher: 'TeamBot',
        author: 'TeamBot',
        homepage: '',
        changelog: b.changelog,
        verified: true,
        platforms: [],
        dependencies: [],
        files,
        sha256: checksumOf(filesToMap(files)),
      } satisfies MarketSkill;
    });
    this.builtinBotItems = BUILTIN_BOTS.map((b) => ({
      type: 'bot',
      catalogId: 'builtin',
      catalogName: 'TeamBot-startcatalogus',
      sourceKind: 'builtin',
      id: b.id,
      title: b.title,
      description: b.description,
      category: b.category,
      tags: b.tags,
      version: b.version,
      license: 'Apache-2.0',
      publisher: 'TeamBot',
      homepage: '',
      changelog: b.changelog,
      verified: true,
      role: b.role,
      avatar: b.avatar,
      color: b.color,
      instructions: b.instructions,
      tool_groups: b.tool_groups,
      access_mode: b.access_mode,
      skills: b.skills,
      model_hint: b.model_hint || '',
    }));
  }

  // ---------- sources ----------
  externalRows(userId: string) {
    return this.ctx.store.find<any>('skill_catalogs', { user_id: userId }, { order: 'created_at' });
  }

  private externalParsed(row: any) {
    if (!row?.data || !row.enabled) return null;
    try {
      return parseIndex(row.data, { catalogId: externalKey(row.url), sourceKind: 'external' });
    } catch {
      return null;
    }
  }

  private serverItems() {
    const users = new Map(this.ctx.store.users().map((u) => [u.id, u.name]));
    const skills: MarketSkill[] = [];
    const bots: MarketBot[] = [];
    // Only what an owner/admin approved (B-11); a member's share waits for review first.
    for (const r of this.ctx.store.find<any>('skill_shares', { status: 'approved' }, { order: 'updated_at DESC', limit: 1000 })) {
      const who = users.get(r.user_id) || 'Gebruiker';
      const common = {
        catalogId: 'server',
        catalogName: 'Gedeeld op deze server',
        sourceKind: 'server' as const,
        id: r.id,
        title: r.title,
        description: r.description,
        category: 'Gedeeld',
        tags: [],
        version: r.version,
        license: r.data?.license || '',
        publisher: who,
        homepage: '',
        changelog: Array.isArray(r.data?.changelog) ? r.data.changelog : [],
        verified: false,
      };
      if (r.item_type === 'skill') skills.push({ type: 'skill', ...common, name: r.slug, author: who, platforms: [], dependencies: [], files: r.data.files, sha256: r.data.sha256, ...(isObj(r.data.manifest) ? { manifest: r.data.manifest } : {}) });
      else if (r.item_type === 'bot') {
        const t = r.data.template || {};
        bots.push({ type: 'bot', ...common, role: s(t.role, 120), avatar: templateAvatar(t.avatar), color: s(t.color, 7) || '#6366f1', instructions: s(t.instructions, 60_000), tool_groups: list(t.tool_groups), access_mode: s(t.access_mode, 20) || 'ask', skills: [], model_hint: s(t.model_hint, 100), template: t });
      }
    }
    return { skills, bots };
  }

  isBlocked(type: string, catalogId: string, itemId: string) {
    return !!this.ctx.store.one('SELECT 1 AS x FROM skill_blocks WHERE item_type = ? AND catalog_id = ? AND item_id = ?', type, catalogId, itemId);
  }
  private blockedSet() {
    return new Set(this.ctx.store.all<any>('SELECT item_type, catalog_id, item_id FROM skill_blocks').map((b) => `${b.item_type}|${b.catalog_id}|${b.item_id}`));
  }

  sources(userId: string) {
    const out: any[] = [{ id: 'builtin', name: 'TeamBot-startcatalogus', publisher: 'TeamBot', kind: 'builtin', verified: true, skills: this.builtinSkillItems.length, bots: this.builtinBotItems.length }];
    const srv = this.serverItems();
    out.push({ id: 'server', name: 'Gedeeld op deze server', publisher: 'Gebruikers van deze server', kind: 'server', verified: false, skills: srv.skills.length, bots: srv.bots.length });
    for (const r of this.externalRows(userId)) {
      const p = this.externalParsed(r);
      out.push({
        id: externalKey(r.url),
        rowId: r.id,
        name: r.name || p?.name || r.url,
        publisher: r.publisher || p?.publisher || '',
        kind: 'external',
        verified: false,
        url: r.url,
        enabled: r.enabled,
        expectedSha256: r.expected_sha256 || null,
        sha256: r.last_sha256 || null,
        fetchedAt: r.fetched_at,
        error: r.last_error || null,
        warnings: p?.warnings || [],
        skills: p?.skills.length || 0,
        bots: p?.bots.length || 0,
        connectors: p?.connectors.length || 0,
      });
    }
    return out;
  }

  /** Connector templates from external catalogs (the built-in ones live in the mcp module). */
  connectors(userId: string): MarketConnector[] {
    const blocked = this.blockedSet();
    const all: MarketConnector[] = [];
    for (const r of this.externalRows(userId)) all.push(...(this.externalParsed(r)?.connectors || []));
    return all.filter((i) => !blocked.has(`app|${i.catalogId}|${i.id}`));
  }
  findConnector(userId: string, catalogId: string, id: string): MarketConnector {
    const it = this.connectors(userId).find((x) => x.catalogId === catalogId && x.id === id);
    if (!it) throw new HttpError(404, this.isBlocked('app', catalogId, id) ? 'Dit item is door de beheerder geblokkeerd.' : 'Connector niet gevonden in de catalogus');
    return it;
  }

  private vcache = new Map<string, PackageVerification>();
  /**
   * Signature verification of a catalog item, without the trust list (applied at view time) and cached per content.
   * Skills with a download only have their manifest checked here; the files are verified at install.
   */
  verification(item: MarketSkill | MarketBot | MarketConnector): PackageVerification | 'builtin' {
    if (item.sourceKind === 'builtin') return 'builtin';
    // Keyed by a hash of everything that is verified, so a changed manifest or file never reuses an old result.
    const key =
      item.type === 'skill'
        ? `s|${item.catalogId}|${item.id}|${sha256(JSON.stringify([item.files ?? null, item.download?.sha256 ?? null, item.manifest ?? null]))}`
        : item.type === 'bot'
          ? `b|${item.catalogId}|${item.id}|${item.package ? sha256(JSON.stringify(item.package)) : 'none'}`
          : `c|${item.catalogId}|${item.id}|${sha256(JSON.stringify(item.package))}`;
    const hit = this.vcache.get(key);
    if (hit) return hit;
    let v: PackageVerification;
    try {
      if (item.type === 'skill') {
        if (item.files) {
          const files = filesToMap(item.files);
          if (item.manifest && !files.has(MANIFEST_FILE)) files.set(MANIFEST_FILE, Buffer.from(JSON.stringify(item.manifest)));
          v = verifyFiles(this.ctx, files, 'skill');
        } else v = verifyFiles(this.ctx, item.manifest ? new Map([[MANIFEST_FILE, Buffer.from(JSON.stringify(item.manifest))]]) : new Map(), 'skill', { skipFiles: true });
      } else if (item.type === 'bot') {
        v = item.package ? verifyInline(this.ctx, item.package, 'bot').verification : verifyFiles(this.ctx, new Map(), 'bot');
      } else v = verifyInline(this.ctx, item.package, 'connector').verification;
    } catch (e: any) {
      v = failedVerification(e?.message || String(e));
    }
    if (this.vcache.size > 2000) this.vcache.clear();
    this.vcache.set(key, v);
    return v;
  }

  skills(userId: string): MarketSkill[] {
    const blocked = this.blockedSet();
    const all = [...this.builtinSkillItems, ...this.serverItems().skills];
    for (const r of this.externalRows(userId)) all.push(...(this.externalParsed(r)?.skills || []));
    return all.filter((i) => !blocked.has(`skill|${i.catalogId}|${i.id}`));
  }

  bots(userId: string): MarketBot[] {
    const blocked = this.blockedSet();
    const all = [...this.builtinBotItems, ...this.serverItems().bots];
    for (const r of this.externalRows(userId)) all.push(...(this.externalParsed(r)?.bots || []));
    return all.filter((i) => !blocked.has(`bot|${i.catalogId}|${i.id}`));
  }

  findSkill(userId: string, catalogId: string, id: string): MarketSkill {
    const it = this.skills(userId).find((x) => x.catalogId === catalogId && x.id === id);
    if (!it) throw new HttpError(404, this.isBlocked('skill', catalogId, id) ? 'Dit item is door de beheerder geblokkeerd.' : 'Skill niet gevonden in de catalogus');
    return it;
  }
  findBot(userId: string, catalogId: string, id: string): MarketBot {
    const it = this.bots(userId).find((x) => x.catalogId === catalogId && x.id === id);
    if (!it) throw new HttpError(404, this.isBlocked('bot', catalogId, id) ? 'Dit item is door de beheerder geblokkeerd.' : 'Bot-sjabloon niet gevonden in de catalogus');
    return it;
  }

  /** Get the files of a catalog skill, verifying the publisher's checksum. */
  async skillFiles(item: MarketSkill): Promise<FileMap> {
    if (item.files) {
      const files = filesToMap(item.files);
      const sum = checksumOf(files);
      if (item.sha256 && item.sha256 !== sum) throw new HttpError(422, `Checksum klopt niet voor ${item.title}: verwacht ${item.sha256.slice(0, 12)}…, gekregen ${sum.slice(0, 12)}…. Niet geïnstalleerd.`);
      if (item.manifest && !files.has(MANIFEST_FILE)) files.set(MANIFEST_FILE, Buffer.from(JSON.stringify(item.manifest)));
      return files;
    }
    if (item.download) {
      const r = await this.fetcher()(item.download.url, { maxBytes: LIMITS.maxZipBytes });
      const sum = sha256(r.body);
      if (sum !== item.download.sha256) throw new HttpError(422, `Checksum van de download klopt niet (verwacht ${item.download.sha256.slice(0, 12)}…, gekregen ${sum.slice(0, 12)}…). Niet geïnstalleerd.`);
      const isZip = r.body.subarray(0, 2).toString('latin1') === 'PK';
      if (!isZip) return new Map([['SKILL.md', r.body], ...(item.manifest ? ([[MANIFEST_FILE, Buffer.from(JSON.stringify(item.manifest))]] as [string, Buffer][]) : [])]);
      let files = stripTopFolder(filesFromZip(r.body));
      if (item.download.subdir) {
        const pre = item.download.subdir.replace(/^\/+|\/+$/g, '') + '/';
        files = new Map([...files].filter(([p]) => p.startsWith(pre)).map(([p, b]) => [p.slice(pre.length), b]));
      }
      const roots = findSkillRoots(files);
      if (!roots.length) throw new HttpError(422, 'De download bevat geen SKILL.md.');
      const out = subset(files, roots[0], roots);
      if (item.manifest && !out.has(MANIFEST_FILE)) out.set(MANIFEST_FILE, Buffer.from(JSON.stringify(item.manifest)));
      return out;
    }
    throw new HttpError(422, 'Dit catalogusitem heeft geen bestanden.');
  }

  // ---------- external catalogs ----------
  private async fetchIndex(url: string, expected?: string | null) {
    const r = await this.fetcher()(url, { maxBytes: 5 * 1024 * 1024, accept: 'application/json' });
    const sum = sha256(r.body);
    if (expected && expected !== sum) throw new HttpError(422, `Checksum van de catalogus klopt niet (verwacht ${expected.slice(0, 12)}…, gekregen ${sum.slice(0, 12)}…).`);
    let json: any;
    try {
      json = JSON.parse(r.body.toString('utf8'));
    } catch {
      throw new HttpError(422, 'De catalogus is geen geldige JSON.');
    }
    const parsed = parseIndex(json, { catalogId: externalKey(url), sourceKind: 'external' });
    return { json, parsed, sum };
  }

  async addCatalog(userId: string, url: string, expected?: string) {
    const u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) throw new HttpError(400, 'Geef een http(s)-adres van een catalogus (JSON).');
    const exp = expected ? String(expected).trim().toLowerCase() : null;
    if (exp && !SHA.test(exp)) throw new HttpError(400, 'De checksum moet een sha256 (64 hexadecimale tekens) zijn.');
    if (this.externalRows(userId).some((r) => r.url === u)) throw new HttpError(409, 'Deze catalogus is al toegevoegd.');
    if (this.externalRows(userId).length >= 20) throw new HttpError(400, 'Maximaal 20 externe catalogi.');
    let res;
    try {
      res = await this.fetchIndex(u, exp);
    } catch (e: any) {
      throw e instanceof HttpError ? e : new HttpError(422, e?.message || String(e));
    }
    const row = { id: newId('cat_'), user_id: userId, url: u, name: res.parsed.name, publisher: res.parsed.publisher, expected_sha256: exp, last_sha256: res.sum, data: res.json, last_error: null, fetched_at: now(), enabled: true, created_at: now() };
    this.ctx.store.insert('skill_catalogs', row);
    return { ...row, data: undefined, warnings: res.parsed.warnings, skills: res.parsed.skills.length, bots: res.parsed.bots.length };
  }

  async refresh(userId: string, rowId: string) {
    const row = this.ctx.store.get<any>('skill_catalogs', rowId);
    if (!row || row.user_id !== userId) throw new HttpError(404, 'Catalogus niet gevonden');
    try {
      const res = await this.fetchIndex(row.url, row.expected_sha256);
      this.ctx.store.update('skill_catalogs', row.id, { name: res.parsed.name, publisher: res.parsed.publisher, last_sha256: res.sum, data: res.json, last_error: null, fetched_at: now() });
      return { ok: true, warnings: res.parsed.warnings, skills: res.parsed.skills.length, bots: res.parsed.bots.length };
    } catch (e: any) {
      // Keep the last good copy; record the error.
      this.ctx.store.update('skill_catalogs', row.id, { last_error: String(e?.message || e).slice(0, 500), fetched_at: now() });
      throw e instanceof HttpError ? e : new HttpError(422, e?.message || String(e));
    }
  }

  updateCatalog(userId: string, rowId: string, patch: { enabled?: boolean; expected_sha256?: string | null }) {
    const row = this.ctx.store.get<any>('skill_catalogs', rowId);
    if (!row || row.user_id !== userId) throw new HttpError(404, 'Catalogus niet gevonden');
    const p: any = {};
    if (patch.enabled !== undefined) p.enabled = !!patch.enabled;
    if (patch.expected_sha256 !== undefined) {
      const v = patch.expected_sha256 ? String(patch.expected_sha256).toLowerCase() : null;
      if (v && !SHA.test(v)) throw new HttpError(400, 'Ongeldige checksum');
      p.expected_sha256 = v;
    }
    this.ctx.store.update('skill_catalogs', row.id, p);
  }

  removeCatalog(userId: string, rowId: string) {
    const row = this.ctx.store.get<any>('skill_catalogs', rowId);
    if (!row || row.user_id !== userId) throw new HttpError(404, 'Catalogus niet gevonden');
    this.ctx.store.remove('skill_catalogs', row.id);
    return row;
  }
}
