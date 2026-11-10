import path from 'node:path';
import type { Ctx } from '../../core/types.js';
import { HttpError } from '../../core/http.js';
import { type FileMap, LIMITS, filesFromZip, findSkillRoots, safeRelPath, subset, zipInfo } from './files.js';
import { analyze } from './library.js';
import { MANIFEST_FILE } from '../../../packages/teambot-sdk/src/index.js';
import { type LicenseInfo, categorize, classifyId, licenseFilesIn, licenseReason, resolveSkillLicense } from './licenses.js';
import { WebCache, WebError, isOffline } from './webcache.js';

/**
 * Skills from the internet. Two public sources:
 *  - curated GitHub collections (repositories with SKILL.md folders), indexed from GitHub's archive downloads
 *    (codeload, not the rate-limited REST API). Which commit HEAD points to is read from the archive redirect,
 *    so an unchanged repository is never downloaded twice;
 *  - the skills.sh directory search (public, rate-limited per IP; results cached), which points into GitHub repos.
 * Repositories too large for an archive download fall back to the GitHub tree API plus raw files.
 * Nothing downloaded here is ever executed: it is parsed, scanned and shown; installing goes through the importer.
 */

export const GITHUB_TOKEN_SECRET = 'market:github-token';
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_ROOTS = 400;
const HOUR = 3600_000;
/** Per-source time limits: a slow source never holds up the others (the marketplace keeps showing the cache). */
export const SOURCE_TIMEOUTS = { head: 10_000, archive: 60_000, api: 10_000, raw: 20_000, search: 10_000 };
/** A check that ended (success or failure) is not repeated in the background for this long. */
export const RETRY_CHECK_MS = 5 * 60_000;

export interface Collection {
  repo: string;
  /** TeamBot's own one-line description. */
  note: string;
}

/**
 * Open skill collections, followed live at HEAD (checked 2026-11-07). Since 0.4 they are not used by default: the
 * marketplace shows TeamBot's own catalogue on pinned commits instead (curated.ts; research 2026-11-09: open stores
 * and moving HEADs were the route for trojanised skills). Set TEAMBOT_SKILL_COLLECTIONS=owner/repo,… to browse open
 * collections anyway (developer use); skills.sh search only runs when open collections are configured.
 */
export const DEFAULT_COLLECTIONS: Collection[] = [];

export const OPEN_COLLECTIONS: Collection[] = [
  { repo: 'anthropics/skills', note: 'Voorbeeldskills van Anthropic (documenten, ontwerp, ontwikkeling).' },
  { repo: 'openai/skills', note: 'Skills van OpenAI voor Codex; licentie verschilt per skill.' },
  { repo: 'vercel-labs/agent-skills', note: 'Skills van Vercel voor React, Next.js en deploys.' },
  { repo: 'anthropics/knowledge-work-plugins', note: 'Skills voor kenniswerk per vakgebied van Anthropic.' },
  { repo: 'huggingface/skills', note: 'Skills van Hugging Face voor modellen, datasets en training.' },
  { repo: 'cloudflare/skills', note: 'Skills van Cloudflare voor Workers en het Cloudflare-platform.' },
  { repo: 'supabase/agent-skills', note: 'Skills van Supabase voor Postgres en Supabase.' },
  { repo: 'expo/skills', note: 'Skills van Expo voor React Native-apps.' },
  { repo: 'microsoft/azure-skills', note: 'Skills van Microsoft voor Azure.' },
  { repo: 'mattpocock/skills', note: 'Ontwikkel- en schrijfskills van Matt Pocock.' },
  { repo: 'obra/superpowers', note: 'Werkwijzen voor programmeeragenten (plannen, testen, debuggen).' },
  { repo: 'trailofbits/skills', note: 'Beveiligingsskills van Trail of Bits.' },
  { repo: 'remotion-dev/skills', note: 'Skills van Remotion voor video in React.' },
];

export interface IndexedSkill {
  /** Folder inside the repository ('' = the repository root). */
  path: string;
  name: string;
  description: string;
  version: string;
  author: string;
  license: LicenseInfo;
  checksum: string;
  fileCount: number;
  size: number;
  kind: 'prompt' | 'scripts';
  scanLevel: string;
  labels: string[];
  category: string;
  errors: string[];
  /** Tree mode: only the path is known until the skill is opened. */
  partial?: boolean;
}

export interface RepoIndex {
  repo: string;
  mode: 'zip' | 'tree';
  commit: string | null;
  commitDate: string | null;
  fetchedAt: string;
  skills: IndexedSkill[];
  rootLicense: LicenseInfo | null;
  skipped: number;
  truncated: boolean;
  stale?: boolean;
  error?: string | null;
}

export interface RepoMeta {
  stars: number;
  license: string | null;
  pushedAt: string | null;
  description: string;
  archived: boolean;
  htmlUrl: string;
}

export interface SkillsShHit {
  id: string;
  source: string;
  skillId: string;
  name: string;
  installs: number;
}

export function assertRepo(r: any): string {
  const s = String(r || '').trim();
  if (!REPO_RE.test(s) || s.split('/').some((p) => p === '.' || p === '..')) throw new HttpError(400, 'Ongeldige repository (verwacht eigenaar/naam).');
  return s;
}

export function assertSkillPath(p: any): string {
  const s = String(p ?? '').trim();
  if (!s) return '';
  const rel = safeRelPath(s);
  if (!rel) throw new HttpError(400, 'Ongeldig pad.');
  return rel;
}

/** catalog_ref of a skill installed from GitHub: `github/<owner>/<repo>[/<path>]`. */
export function webRef(repo: string, p: string) {
  return `github/${repo}${p ? '/' + p : ''}`;
}
export function parseWebRef(ref: string | null | undefined): { repo: string; path: string } | null {
  if (!ref || !ref.startsWith('github/')) return null;
  const parts = ref.split('/');
  if (parts.length < 3) return null;
  const repo = `${parts[1]}/${parts[2]}`;
  if (!REPO_RE.test(repo)) return null;
  return { repo, path: parts.slice(3).join('/') };
}

function envCollections(): Collection[] | null {
  const raw = process.env.TEAMBOT_SKILL_COLLECTIONS;
  if (raw === undefined) return null;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => REPO_RE.test(s))
    .map((repo) => ({ repo, note: '' }));
}

const EMPTY = Buffer.alloc(0);

export class WebSkills {
  private mem = new Map<string, RepoIndex>();
  /** Index runs in progress per repository (a browse, a poll and an install share one download and one parse). */
  private running = new Map<string, Promise<RepoIndex>>();
  /** When the last index run of a repository ended, and its error when it fell back to the cache or failed. */
  private tried = new Map<string, { at: number; error: string | null }>();
  collections: Collection[];

  constructor(
    private ctx: Ctx,
    readonly cache: WebCache,
  ) {
    this.collections = envCollections() ?? DEFAULT_COLLECTIONS;
  }

  // ---------- GitHub access ----------
  token(userId?: string | null): string | null {
    if (userId) {
      const t = this.ctx.secrets.getByName(userId, GITHUB_TOKEN_SECRET);
      if (t) return t;
    }
    return process.env.TEAMBOT_GITHUB_TOKEN || null;
  }

  private apiHeaders(userId?: string | null): Record<string, string> {
    const t = this.token(userId);
    return { 'x-github-api-version': '2022-11-28', ...(t ? { authorization: `Bearer ${t}` } : {}) };
  }

  /** Which commit HEAD points to, from the archive redirect (no API call, no download). */
  async headCommit(repo: string, o: { force?: boolean } = {}): Promise<{ commit: string | null; error: string | null }> {
    try {
      const hit = await this.cache.redirect(`head:${repo}`, `https://github.com/${repo}/archive/HEAD.zip`, { ttlMs: HOUR, force: o.force, timeoutMs: SOURCE_TIMEOUTS.head });
      const m = /\/zip\/(?:refs\/heads\/)?([0-9a-f]{40})$/.exec(hit.data);
      return { commit: m ? m[1] : null, error: hit.error };
    } catch (e: any) {
      return { commit: null, error: e?.message || String(e) };
    }
  }

  /** Repository facts from the GitHub API (stars, licence). Optional: null when rate limited or offline. */
  async repoMeta(repo: string, userId?: string | null, o: { force?: boolean } = {}): Promise<RepoMeta | null> {
    try {
      const hit = await this.cache.json<any>(`ghrepo:${repo}`, `https://api.github.com/repos/${repo}`, { ttlMs: 24 * HOUR, headers: this.apiHeaders(userId), accept: 'application/vnd.github+json', force: o.force, timeoutMs: SOURCE_TIMEOUTS.api });
      return metaOf(hit.data);
    } catch {
      return this.peekRepoMeta(repo);
    }
  }
  peekRepoMeta(repo: string): RepoMeta | null {
    const hit = this.cache.peek<any>(`ghrepo:${repo}`);
    return hit ? metaOf(hit.data) : null;
  }

  // ---------- index ----------
  /** Cached index without network access. */
  peekIndex(repo: string): RepoIndex | null {
    const m = this.mem.get(repo);
    if (m) return m;
    const hit = this.cache.peek<RepoIndex>(`index:${repo}`);
    if (hit?.data?.repo === repo && Array.isArray(hit.data.skills)) {
      this.mem.set(repo, hit.data);
      return hit.data;
    }
    return null;
  }

  /**
   * Asking for this repository's index would go to the network: it is not indexed yet, or the last check of its HEAD
   * is older than an hour (then the cached index is still shown while it is checked: stale-while-revalidate).
   */
  needsRefresh(repo: string): boolean {
    if (this.running.has(repo)) return true;
    if (isOffline()) return false;
    if (!this.peekIndex(repo)) return true;
    // A check that just ended (also one that failed: GitHub unreachable) counts as checked for a few minutes, so a
    // page that asks again does not keep the "bijwerken" state, and GitHub is not asked on every poll.
    if (Date.now() - (this.tried.get(repo)?.at || 0) < RETRY_CHECK_MS) return false;
    return !this.cache.fresh(`head:${repo}`, HOUR);
  }

  /** The cached index as the marketplace shows it: marked stale when the last check of the source failed. */
  snapshot(repo: string): RepoIndex | null {
    const idx = this.peekIndex(repo);
    const err = this.tried.get(repo)?.error;
    return idx && err ? { ...idx, stale: true, error: err } : idx;
  }

  /** The index of a repository; concurrent calls share one run (one download, one parse). */
  index(repo: string, o: { force?: boolean; userId?: string | null } = {}): Promise<RepoIndex> {
    assertRepo(repo);
    const cur = this.running.get(repo);
    if (cur && !o.force) return cur;
    const p = this.buildOrReuse(repo, o).then(
      (r) => (this.tried.set(repo, { at: Date.now(), error: r.stale ? r.error || 'bron niet bereikbaar' : null }), r),
      (e) => {
        this.tried.set(repo, { at: Date.now(), error: String(e?.message || e).slice(0, 300) });
        throw e;
      },
    );
    p.finally(() => {
      if (this.running.get(repo) === p) this.running.delete(repo);
    }).catch(() => {});
    this.running.set(repo, p);
    return p;
  }

  private async buildOrReuse(repo: string, o: { force?: boolean; userId?: string | null }): Promise<RepoIndex> {
    const prev = this.peekIndex(repo);
    const head = await this.headCommit(repo, { force: o.force });
    // Same commit as the index. The check itself may have failed (the commit then comes from the cache): say so,
    // except offline, where only the cache is used on purpose.
    const failed = head.error && !isOffline() ? head.error : null;
    if (prev && head.commit && prev.commit === head.commit) return { ...prev, stale: !!failed, error: failed };
    if (prev && !head.commit && head.error) return { ...prev, stale: true, error: head.error };
    const ref = head.commit || 'HEAD';
    let hit;
    try {
      hit = await this.cache.buffer(`zip:${repo}@${ref}`, `https://codeload.github.com/${repo}/zip/${ref}`, { ttlMs: head.commit ? 30 * 24 * HOUR : 12 * HOUR, maxBytes: LIMITS.maxZipBytes, force: !head.commit && o.force, timeoutMs: SOURCE_TIMEOUTS.archive });
    } catch (e: any) {
      if (e instanceof WebError && e.code === 'too-large') return this.treeIndex(repo, head.commit, o.userId);
      if (prev) return { ...prev, stale: true, error: e?.message || String(e) };
      throw e;
    }
    const idx = this.buildIndex(repo, hit.data, head.commit);
    if (prev?.commit && prev.commit !== idx.commit) this.cache.drop(`zip:${repo}@${prev.commit}`);
    this.mem.set(repo, idx);
    this.cache.put(`index:${repo}`, idx);
    return idx;
  }

  private buildIndex(repo: string, buf: Buffer, commit: string | null): RepoIndex {
    const info = zipInfo(buf);
    const top = commonTop(info.names);
    const strip = (p: string) => (top && p.startsWith(top + '/') ? p.slice(top.length + 1) : p);
    const names = info.names.map(strip).filter(Boolean);
    const roots = findSkillRoots(new Map(names.map((n) => [n, EMPTY]))).slice(0, MAX_ROOTS);
    const rootLic = licenseFilesIn(new Map(names.map((n) => [n, EMPTY])), '');
    const want = new Set(rootLic);
    const include = (rel: string) => {
      const s = strip(rel);
      return want.has(s) || roots.some((r) => r === '' || s.startsWith(r + '/'));
    };
    const skipped: string[] = [];
    const raw = filesFromZip(buf, { lenient: true, include, skipped });
    const files: FileMap = new Map();
    for (const [p, b] of raw) files.set(strip(p), b);
    const repoFiles = rootLic.filter((f) => files.has(f)).map((f) => ({ path: f, text: files.get(f)!.toString('utf8') }));
    const skills: IndexedSkill[] = [];
    for (const r of roots) {
      const own = subset(files, r, roots);
      own.delete(MANIFEST_FILE);
      if (!own.has('SKILL.md')) continue;
      skills.push(this.describe(r, own, repo, repoFiles));
    }
    const rootLicense = repoFiles.length ? resolveSkillLicense({ skillFiles: new Map(), repoFiles }) : null;
    const realCommit = commit || (SHA_RE.test(info.comment) ? info.comment : null);
    return { repo, mode: 'zip', commit: realCommit, commitDate: info.newest, fetchedAt: new Date().toISOString(), skills, rootLicense, skipped: skipped.length, truncated: roots.length >= MAX_ROOTS };
  }

  private describe(root: string, own: FileMap, repo: string, repoFiles: { path: string; text: string }[], githubSpdx?: string | null): IndexedSkill {
    const a = analyze(own, path.posix.basename(root) || repo.split('/')[1]);
    const m = a.parsed.meta;
    return {
      path: root,
      name: m.name,
      description: m.description,
      version: m.version,
      author: m.author || m.metadata?.author || '',
      license: resolveSkillLicense({ skillFiles: own, frontmatter: m.license, repoFiles, githubSpdx }),
      checksum: a.checksum,
      fileCount: a.fileCount,
      size: a.size,
      kind: a.scan.kind,
      scanLevel: a.scan.level,
      labels: a.scan.labels,
      category: categorize(m.name, m.description),
      errors: a.errors.slice(0, 3),
    };
  }

  /** Large repositories: list SKILL.md folders through the tree API; files come from raw.githubusercontent.com. */
  private async treeIndex(repo: string, commit: string | null, userId?: string | null): Promise<RepoIndex> {
    const ref = commit || 'HEAD';
    const hit = await this.cache.json<any>(`tree:${repo}@${ref}`, `https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`, { ttlMs: commit ? 30 * 24 * HOUR : 12 * HOUR, headers: this.apiHeaders(userId), accept: 'application/vnd.github+json', timeoutMs: SOURCE_TIMEOUTS.raw });
    const blobs: string[] = (Array.isArray(hit.data?.tree) ? hit.data.tree : []).filter((t: any) => t?.type === 'blob' && typeof t.path === 'string').map((t: any) => safeRelPath(t.path)).filter(Boolean);
    const roots = findSkillRoots(new Map(blobs.map((n) => [n, EMPTY]))).slice(0, MAX_ROOTS);
    const prev = this.peekIndex(repo);
    const skills: IndexedSkill[] = roots.map((r) => {
      const known = prev?.commit === commit ? prev?.skills.find((s) => s.path === r && !s.partial) : null;
      if (known) return known;
      const name = path.posix.basename(r) || repo.split('/')[1];
      return { path: r, name, description: '', version: '', author: '', license: { spdx: null, label: 'Nog niet bekeken', status: 'unknown', source: 'none' }, checksum: '', fileCount: 0, size: 0, kind: 'prompt', scanLevel: 'ok', labels: [], category: categorize(name), errors: [], partial: true };
    });
    const meta = await this.repoMeta(repo, userId);
    const idx: RepoIndex = { repo, mode: 'tree', commit, commitDate: meta?.pushedAt || null, fetchedAt: new Date().toISOString(), skills, rootLicense: meta?.license ? { ...(classifyId(meta.license) || { spdx: null, label: meta.license, status: 'unknown' }), source: 'github' } : null, skipped: 0, truncated: !!hit.data?.truncated || roots.length >= MAX_ROOTS };
    (idx as any).blobs = blobs.filter((b) => roots.some((r) => r === '' || b.startsWith(r + '/')) || !b.includes('/')).slice(0, 20_000);
    this.mem.set(repo, idx);
    this.cache.put(`index:${repo}`, idx);
    return idx;
  }

  /** The files of one skill (from the cached archive, or raw files in tree mode). Never executed. */
  async skillFiles(repo: string, skillPath: string, userId?: string | null): Promise<{ files: FileMap; index: RepoIndex; skill: IndexedSkill }> {
    const idx = await this.index(repo, { userId });
    const skill = idx.skills.find((s) => s.path === skillPath);
    if (!skill) throw new HttpError(404, `Skill ${skillPath || '(hoofdmap)'} niet gevonden in ${repo}.`);
    const roots = idx.skills.map((s) => s.path);
    let files: FileMap;
    if (idx.mode === 'zip') {
      const zip = this.cache.peek<Buffer>(`zip:${repo}@${idx.commit || 'HEAD'}`);
      let buf = zip?.data;
      if (!buf) buf = (await this.cache.buffer(`zip:${repo}@${idx.commit || 'HEAD'}`, `https://codeload.github.com/${repo}/zip/${idx.commit || 'HEAD'}`, { ttlMs: 30 * 24 * HOUR, maxBytes: LIMITS.maxZipBytes, timeoutMs: SOURCE_TIMEOUTS.archive })).data;
      const info = zipInfo(buf);
      const top = commonTop(info.names);
      const strip = (p: string) => (top && p.startsWith(top + '/') ? p.slice(top.length + 1) : p);
      const pre = skillPath ? skillPath + '/' : '';
      const raw = filesFromZip(buf, { lenient: true, include: (rel) => strip(rel).startsWith(pre) });
      const all: FileMap = new Map();
      for (const [p, b] of raw) all.set(strip(p), b);
      files = subset(all, skillPath, roots);
    } else {
      const blobs: string[] = ((idx as any).blobs || []).filter((b: string) => (skillPath ? b.startsWith(skillPath + '/') : true));
      const nested = roots.filter((r) => r !== skillPath && (skillPath === '' || r.startsWith(skillPath + '/')));
      const mine = blobs.filter((b) => !nested.some((n) => b.startsWith(n + '/')));
      if (mine.length > LIMITS.maxFiles) throw new HttpError(422, `Deze skill heeft te veel bestanden (${mine.length}, maximaal ${LIMITS.maxFiles}).`);
      files = new Map();
      let total = 0;
      for (const b of mine) {
        const url = `https://raw.githubusercontent.com/${repo}/${idx.commit || 'HEAD'}/${b.split('/').map(encodeURIComponent).join('/')}`;
        const r = await this.cache.buffer(`raw:${repo}@${idx.commit || 'HEAD'}:${b}`, url, { ttlMs: idx.commit ? 30 * 24 * HOUR : 12 * HOUR, maxBytes: LIMITS.maxFileBytes, timeoutMs: SOURCE_TIMEOUTS.raw });
        total += r.data.length;
        if (total > LIMITS.maxSkillBytes) throw new HttpError(422, 'Deze skill is te groot.');
        const rel = skillPath ? b.slice(skillPath.length + 1) : b;
        files.set(path.posix.basename(rel).toLowerCase() === 'skill.md' && !rel.includes('/') ? 'SKILL.md' : rel, r.data);
      }
      if (skill.partial) {
        const filled = this.describe(skillPath, files, repo, [], idx.rootLicense?.spdx || null);
        Object.assign(skill, filled, { partial: false });
        this.cache.put(`index:${repo}`, idx);
      }
    }
    files.delete(MANIFEST_FILE);
    return { files, index: idx, skill };
  }

  // ---------- skills.sh ----------
  async searchSkillsSh(q: string): Promise<{ hits: SkillsShHit[]; stale: boolean; error: string | null }> {
    const query = q.trim().slice(0, 100);
    if (query.length < 2) return { hits: [], stale: false, error: null };
    const hit = await this.cache.json<any>(`skillssh:${query.toLowerCase()}`, `https://skills.sh/api/search?q=${encodeURIComponent(query)}&limit=60`, { ttlMs: HOUR, timeoutMs: SOURCE_TIMEOUTS.search });
    const hits: SkillsShHit[] = (Array.isArray(hit.data?.skills) ? hit.data.skills : [])
      .slice(0, 100)
      .map((s: any) => ({ id: String(s?.id || ''), source: String(s?.source || ''), skillId: String(s?.skillId || s?.slug || ''), name: String(s?.name || s?.skillId || '').slice(0, 120), installs: Math.max(0, Math.floor(Number(s?.installs) || 0)) }))
      .filter((s: SkillsShHit) => s.id && s.skillId && s.source);
    return { hits, stale: hit.stale, error: hit.error };
  }

  /** Install counts we already know for a repository's skills (from cached skills.sh searches). */
  installsFrom(hits: SkillsShHit[]) {
    const m = new Map<string, number>();
    for (const h of hits) m.set(`${h.source.toLowerCase()}|${h.skillId.toLowerCase()}`, Math.max(h.installs, m.get(`${h.source.toLowerCase()}|${h.skillId.toLowerCase()}`) || 0));
    return m;
  }

  /** Find the folder of a skills.sh result inside its repository (by SKILL.md name, then folder name). */
  async resolve(source: string, skillId: string, userId?: string | null): Promise<{ repo: string; path: string }> {
    if (!REPO_RE.test(source)) throw new HttpError(422, `Deze skill komt niet uit een GitHub-repository (${source.slice(0, 80)}); TeamBot kan hem niet ophalen.`);
    const idx = await this.index(source, { userId });
    const id = skillId.toLowerCase();
    const s = idx.skills.find((x) => x.name.toLowerCase() === id) || idx.skills.find((x) => path.posix.basename(x.path).toLowerCase() === id);
    if (!s) throw new HttpError(404, `Skill ${skillId} niet (meer) gevonden in ${source}.`);
    return { repo: source, path: s.path };
  }

  // ---------- updates ----------
  /** Update available for an installed skill (cached index only, no network). */
  /**
   * Newer source version of an installed internet skill, or null. `known` says whether a checksum is already one of the
   * skill's stored revisions: after a local edit (or a rollback) the active checksum differs from the source, but the
   * source version is not new, so it is no update.
   */
  updateFor(ref: string | null | undefined, checksum: string, known?: (checksum: string) => boolean): { version: string; commit: string | null; repo: string; path: string } | null {
    const r = parseWebRef(ref);
    if (!r) return null;
    const idx = this.peekIndex(r.repo);
    const s = idx?.skills.find((x) => x.path === r.path);
    if (!s || s.partial || !s.checksum || s.checksum === checksum || known?.(s.checksum)) return null;
    return { version: s.version || (idx!.commit ? idx!.commit.slice(0, 7) : 'nieuw'), commit: idx!.commit, repo: r.repo, path: r.path };
  }
}

function metaOf(j: any): RepoMeta | null {
  if (!j || typeof j !== 'object' || typeof j.full_name !== 'string') return null;
  const spdx = j.license?.spdx_id && j.license.spdx_id !== 'NOASSERTION' ? String(j.license.spdx_id) : null;
  return { stars: Number(j.stargazers_count) || 0, license: spdx, pushedAt: j.pushed_at ? String(j.pushed_at) : null, description: String(j.description || '').slice(0, 300), archived: !!j.archived, htmlUrl: String(j.html_url || '') };
}

function commonTop(names: string[]): string {
  if (!names.length) return '';
  const first = names[0].split('/')[0];
  return names.every((n) => n.includes('/') && n.split('/')[0] === first) ? first : '';
}

export { licenseReason };
