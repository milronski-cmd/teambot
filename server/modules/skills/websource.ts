import path from 'node:path';
import type { Ctx } from '../../core/types.js';
import { HttpError } from '../../core/http.js';
import { type FileMap, LIMITS, filesFromZip, findSkillRoots, safeRelPath, subset, zipInfo } from './files.js';
import { analyze } from './library.js';
import { MANIFEST_FILE } from '../../../packages/teambot-sdk/src/index.js';
import { type LicenseInfo, categorize, classifyId, licenseFilesIn, resolveSkillLicense } from './licenses.js';
import { WebCache, WebError, isOffline } from './webcache.js';
import type { OpenHit, OpenSort } from '../../../shared/skills.js';

/**
 * Everything public: the open side of the marketplace. Three sources that answer without an account:
 *  - GitHub's repository search (repositories with skills in the open SKILL.md format), in the orders GitHub knows:
 *    most stars, recently updated, and by creation date (for "trending" and "newest", see `searchGithub`);
 *  - the open skill directory skills.sh: single skills that live in GitHub repositories, with their install counts
 *    (search by words, most installed, most installed in the last 24 hours);
 *  - the skill library ClawHub: single skills it hosts itself (not on GitHub), each with versions, its own stars and
 *    download counts (search by words; lists by its stars, its own trending order, newest, recently updated).
 * A repository is read from GitHub's archive download (codeload, not the rate-limited REST API); which commit HEAD
 * points to comes from the archive redirect, so an unchanged repository is never downloaded twice. Repositories too
 * large for an archive fall back to the tree API. Nothing downloaded here is ever executed: it is parsed and shown;
 * installing goes through the catalogue's install path (curated-routes.ts: import rules, scan, a pinned commit).
 */

export const GITHUB_TOKEN_SECRET = 'market:github-token';
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_ROOTS = 400;
const HOUR = 3600_000;
/** Per-source time limits: a slow source never holds up the others. */
export const SOURCE_TIMEOUTS = { head: 10_000, archive: 60_000, api: 10_000, raw: 20_000, search: 10_000 };

/** Searching GitHub has a limit of its own (per minute), next to the hourly limit of the rest of its API. */
export const GITHUB_SEARCH_LIMIT = 'api.github.com#search';
/** Results per page of the open search. */
export const OPEN_PAGE = 30;
/** "Trending": repositories created within this many days, most stars first. */
export const TRENDING_DAYS = 30;
/** "Nieuwste": repositories created within this many days, newest first. */
export const NEW_DAYS = 7;
/** GitHub search gives at most this many results of one query. */
const GITHUB_MAX_RESULTS = 1000;
const DIRECTORY_CHUNK = 200;

export const OPEN_SORTS: OpenSort[] = ['stars', 'trending', 'new', 'updated'];

/** ClawHub: a skill is `<owner>/<slug>`; its pin is a version (as the publisher named it), not a commit. */
export const CLAWHUB = 'https://clawhub.ai';
const CLAW_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
export const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const CLAW_SORT: Record<OpenSort, string> = { stars: 'stars', trending: 'trending', new: 'newest', updated: 'updated' };

export interface OpenPage {
  hits: OpenHit[];
  /** How many results the source has in all (null: it does not say). */
  total: number | null;
  more: boolean;
  /** Shown from the cache because the source could not be asked now. */
  stale: boolean;
  error: string | null;
  /** The source's limit was reached: when it may be asked again (ms since 1970). */
  limitedUntil: number | null;
}

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
  /** Tree mode: only the path is known. */
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
  createdAt: string | null;
  description: string;
  archived: boolean;
  htmlUrl: string;
}

/** An error of an internet source as an HTTP answer (its own status where that says something). */
export function webErr(e: any): never {
  if (e instanceof HttpError) throw e;
  if (e instanceof WebError) throw new HttpError(e.status === 404 ? 404 : e.status === 429 ? 429 : e.status === 503 ? 503 : 502, e.message);
  throw new HttpError(502, String(e?.message || e).slice(0, 300));
}

export function assertRepo(r: any): string {
  const s = String(r || '').trim();
  if (!REPO_RE.test(s) || s.split('/').some((p) => p === '.' || p === '..')) throw new HttpError(400, 'Ongeldige repository (verwacht eigenaar/naam).');
  return s;
}

/**
 * The open id of a skill on GitHub: `github/<owner>/<repo>[/<folder>]` (also the catalog_ref of skills installed from
 * the internet before 0.4).
 */
export function webRef(repo: string, p: string) {
  return `github/${repo}${p ? '/' + p : ''}`;
}
/** The open id of a skill on ClawHub: `clawhub/<owner>/<slug>`. */
export function clawRef(owner: string, slug: string) {
  return `clawhub/${owner}/${slug}`;
}
export function parseClawRef(ref: string | null | undefined): { owner: string; slug: string } | null {
  const parts = String(ref || '').split('/');
  if (parts.length !== 3 || parts[0] !== 'clawhub' || !CLAW_NAME.test(parts[1]) || !CLAW_NAME.test(parts[2])) return null;
  return { owner: parts[1], slug: parts[2] };
}
export function parseWebRef(ref: string | null | undefined): { repo: string; path: string } | null {
  if (!ref || !ref.startsWith('github/')) return null;
  const parts = ref.split('/');
  if (parts.length < 3) return null;
  const repo = `${parts[1]}/${parts[2]}`;
  if (!REPO_RE.test(repo) || repo.split('/').some((p) => p === '.' || p === '..')) return null;
  return { repo, path: parts.slice(3).join('/') };
}

/** The words of a search as they go to a source: one line, no control characters, capped. */
export function searchWords(q: unknown): string {
  return String(q ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

const EMPTY = Buffer.alloc(0);
const noPage = (o: Partial<OpenPage> = {}): OpenPage => ({ hits: [], total: null, more: false, stale: false, error: null, limitedUntil: null, ...o });
const base = (p: string) => path.posix.basename(p);

export class WebSkills {
  private mem = new Map<string, RepoIndex>();
  /** Repositories known to have no index in the cache (so a list of results does not look on disk again and again). */
  private noIndex = new Set<string>();
  /** Index runs in progress per repository (a view and an install share one download and one parse). */
  private running = new Map<string, Promise<RepoIndex>>();
  /** Facts of repositories seen in search results (stars, licence, last push), by lower-case name. */
  private metas = new Map<string, RepoMeta>();

  constructor(
    private ctx: Ctx,
    readonly cache: WebCache,
  ) {}

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

  private remember(meta: RepoMeta | null, repo: string) {
    if (!meta) return;
    if (this.metas.size > 5000) this.metas.delete(this.metas.keys().next().value!);
    this.metas.set(repo.toLowerCase(), meta);
  }

  /** Repository facts from the GitHub API (stars, licence). Optional: what is known when rate limited or offline. */
  async repoMeta(repo: string, userId?: string | null, o: { force?: boolean } = {}): Promise<RepoMeta | null> {
    try {
      const hit = await this.cache.json<any>(`ghrepo:${repo}`, `https://api.github.com/repos/${repo}`, { ttlMs: 24 * HOUR, headers: this.apiHeaders(userId), accept: 'application/vnd.github+json', force: o.force, timeoutMs: SOURCE_TIMEOUTS.api });
      const meta = metaOf(hit.data);
      this.remember(meta, repo);
      return meta;
    } catch {
      return this.peekRepoMeta(repo);
    }
  }
  /** What is already known about a repository (a search result, or an earlier API answer); no network. */
  peekRepoMeta(repo: string): RepoMeta | null {
    const seen = this.metas.get(repo.toLowerCase());
    if (seen) return seen;
    const hit = this.cache.peek<any>(`ghrepo:${repo}`);
    const meta = hit ? metaOf(hit.data) : null;
    this.remember(meta, repo);
    return meta;
  }

  // ---------- search: GitHub ----------
  /**
   * Repositories with skills on GitHub. Without words: everything with the topic `agent-skills`; with words: the words
   * plus "skill" in the name, description or topics. The orders:
   *  - `stars`: most stars first;
   *  - `updated`: most recently pushed first;
   *  - `trending`: GitHub has no public list of stars gained, so: created in the last TRENDING_DAYS days, most stars first;
   *  - `new`: GitHub cannot order repositories by creation date, so: of those created in the last NEW_DAYS days the 100
   *    with the most stars, newest first.
   * One request per page, kept for an hour (searching is limited to 10 a minute without a token).
   */
  async searchGithub(o: { q: string; sort: OpenSort; page: number; userId?: string | null }): Promise<OpenPage> {
    const words = searchWords(o.q);
    const page = Math.max(1, Math.floor(o.page) || 1);
    const scope = words ? `${words} skill in:name,description,topics` : 'topic:agent-skills';
    const since = (days: number) => new Date(Date.now() - days * 24 * HOUR).toISOString().slice(0, 10);
    const window = o.sort === 'trending' ? ` created:>=${since(TRENDING_DAYS)}` : o.sort === 'new' ? ` created:>=${since(NEW_DAYS)}` : '';
    const local = o.sort === 'new';
    const perPage = local ? 100 : OPEN_PAGE;
    const ghPage = local ? 1 : page;
    if (ghPage * perPage > GITHUB_MAX_RESULTS) return noPage();
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(scope + window)}&sort=${o.sort === 'updated' ? 'updated' : 'stars'}&order=desc&per_page=${perPage}&page=${ghPage}`;
    let hit;
    try {
      // The key leaves the date out: when GitHub cannot be asked, yesterday's answer is still shown.
      hit = await this.cache.json<any>(`ghsearch:${o.sort}:${words.toLowerCase()}:${ghPage}`, url, {
        ttlMs: o.sort === 'updated' ? 10 * 60_000 : HOUR,
        headers: this.apiHeaders(o.userId),
        accept: 'application/vnd.github+json',
        timeoutMs: SOURCE_TIMEOUTS.search,
        limitKey: GITHUB_SEARCH_LIMIT,
      });
    } catch (e: any) {
      const limited = e instanceof WebError && e.code === 'rate-limited';
      return noPage({ error: String(e?.message || e).slice(0, 300), limitedUntil: limited ? (e.until ?? this.cache.blockedHost(GITHUB_SEARCH_LIMIT) ?? Date.now() + 60_000) : null });
    }
    const all: OpenHit[] = [];
    for (const r of Array.isArray(hit.data?.items) ? hit.data.items : []) {
      const meta = metaOf(r);
      if (!meta || !REPO_RE.test(String(r.full_name))) continue;
      this.remember(meta, r.full_name);
      all.push({ kind: 'repo', from: 'github', repo: r.full_name, skill: null, name: String(r.name || r.full_name.split('/')[1]), description: meta.description, stars: meta.stars, downloads: null, flagged: false, installs: null, recent: null, license: meta.license, updatedAt: meta.pushedAt, createdAt: meta.createdAt, archived: meta.archived });
    }
    const found = Math.max(0, Math.floor(Number(hit.data?.total_count) || 0));
    // Only a stale answer says why (a limit that is running does not make a fresh answer from the cache a problem).
    const limitedUntil = hit.stale ? this.cache.blockedHost(GITHUB_SEARCH_LIMIT) : null;
    if (local) {
      all.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      return { hits: all.slice((page - 1) * OPEN_PAGE, page * OPEN_PAGE), total: Math.min(found, all.length), more: page * OPEN_PAGE < all.length, stale: hit.stale, error: hit.error, limitedUntil };
    }
    return { hits: all, total: found, more: all.length > 0 && page * OPEN_PAGE < Math.min(found, GITHUB_MAX_RESULTS), stale: hit.stale, error: hit.error, limitedUntil };
  }

  // ---------- search: the open skill directory (skills.sh) ----------
  /**
   * Single skills from skills.sh, each in a GitHub repository. It knows two orders: most installed (also for a search
   * by words) and most installed in the last 24 hours (without words); for the other orders it has nothing (null).
   */
  async searchDirectory(o: { q: string; sort: OpenSort; page: number }): Promise<OpenPage | null> {
    const words = searchWords(o.q);
    const page = Math.max(1, Math.floor(o.page) || 1);
    const from = (page - 1) * OPEN_PAGE;
    const hitOf = (s: any, recent: boolean): OpenHit | null => {
      const repo = String(s?.source || '');
      const skill = String(s?.skillId || s?.slug || '').slice(0, 120);
      // The directory also lists skills that are not in a GitHub repository; those cannot be fetched and pinned.
      if (!REPO_RE.test(repo) || !skill || s?.isDuplicate) return null;
      const n = Math.max(0, Math.floor(Number(s?.installs) || 0));
      return { kind: 'skill', from: 'skills.sh', repo, skill, name: String(s?.name || skill).slice(0, 120), description: '', stars: null, downloads: null, flagged: false, installs: recent ? null : n, recent: recent ? n : null, license: null, updatedAt: null, createdAt: null, archived: false };
    };
    try {
      if (words) {
        if (o.sort !== 'stars' || words.length < 2) return null;
        const hit = await this.cache.json<any>(`skillssh:${words.toLowerCase()}`, `https://skills.sh/api/search?q=${encodeURIComponent(words)}&limit=${DIRECTORY_CHUNK}`, { ttlMs: HOUR, timeoutMs: SOURCE_TIMEOUTS.search });
        const all = (Array.isArray(hit.data?.skills) ? hit.data.skills : []).map((s: any) => hitOf(s, false)).filter(Boolean) as OpenHit[];
        all.sort((a, b) => (b.installs || 0) - (a.installs || 0));
        return { hits: all.slice(from, from + OPEN_PAGE), total: all.length, more: from + OPEN_PAGE < all.length, stale: hit.stale, error: hit.error, limitedUntil: null };
      }
      const board = o.sort === 'stars' ? 'all-time' : o.sort === 'trending' ? 'trending' : null;
      if (!board) return null;
      // The directory gives 200 at a time; a page of ours can lie across two of them.
      const hits: OpenHit[] = [];
      let total: number | null = null;
      let more = false;
      let stale = false;
      let error: string | null = null;
      for (let chunk = Math.floor(from / DIRECTORY_CHUNK); chunk <= Math.floor((from + OPEN_PAGE - 1) / DIRECTORY_CHUNK); chunk++) {
        const hit = await this.cache.json<any>(`skillssh-list:${board}:${chunk}`, `https://skills.sh/api/skills/${board}/${chunk}`, { ttlMs: board === 'trending' ? HOUR / 2 : HOUR, timeoutMs: SOURCE_TIMEOUTS.search });
        const list: any[] = Array.isArray(hit.data?.skills) ? hit.data.skills : [];
        const start = Math.max(0, from - chunk * DIRECTORY_CHUNK);
        const end = Math.min(list.length, from + OPEN_PAGE - chunk * DIRECTORY_CHUNK);
        for (const s of list.slice(start, end)) {
          const h = hitOf(s, board === 'trending');
          if (h) hits.push(h);
        }
        total = Number.isFinite(Number(hit.data?.total)) ? Number(hit.data.total) : total;
        more = end < list.length || !!hit.data?.hasMore;
        stale = stale || hit.stale;
        error = error || hit.error;
        if (!hit.data?.hasMore) break;
      }
      return { hits, total, more, stale, error, limitedUntil: null };
    } catch (e: any) {
      const limited = e instanceof WebError && e.code === 'rate-limited';
      return noPage({ error: String(e?.message || e).slice(0, 300), limitedUntil: limited ? (e.until ?? Date.now() + 60_000) : null });
    }
  }

  // ---------- search: the skill library ClawHub ----------
  /**
   * Single skills from ClawHub. Without words its own lists (most stars there, its trending order, newest, recently
   * updated), 30 at a time with the cursor it gives; with words its search, put in the chosen order here (trending:
   * most installs in the last 60 days, the number its search gives).
   */
  async searchClawhub(o: { q: string; sort: OpenSort; page: number }): Promise<OpenPage> {
    const words = searchWords(o.q);
    const page = Math.max(1, Math.floor(o.page) || 1);
    const iso = (ms: unknown) => (Number(ms) > 0 ? new Date(Number(ms)).toISOString() : null);
    const count = (n: unknown) => Math.max(0, Math.floor(Number(n) || 0));
    const text = (v: unknown, max: number) => String(v || '').split(/\s+/).join(' ').trim().slice(0, max);
    type Hit = OpenHit & { recent60: number };
    const hitOf = (owner: unknown, k: any, extra: { license?: unknown; name?: unknown } = {}): Hit | null => {
      const slug = String(k?.slug || '');
      if (!CLAW_NAME.test(String(owner || '')) || !CLAW_NAME.test(slug)) return null;
      return {
        kind: 'skill',
        from: 'clawhub',
        repo: `${owner}/${slug}`,
        skill: slug,
        name: text(extra.name || k.displayName, 120) || slug,
        description: text(k.summary, 300),
        stars: count(k.stats?.stars),
        downloads: count(k.stats?.downloads),
        flagged: !!k.isSuspicious,
        installs: null,
        recent: null,
        license: text(extra.license, 40) || null,
        updatedAt: iso(k.updatedAt),
        createdAt: iso(k.createdAt),
        archived: false,
        recent60: 0,
      };
    };
    const plain = (list: Hit[]): OpenHit[] => list.map(({ recent60: _recent, ...h }) => h);
    try {
      if (words) {
        if (words.length < 2) return noPage();
        const hit = await this.cache.json<any>(`clawhub-search:${words.toLowerCase()}`, `${CLAWHUB}/api/v1/search?q=${encodeURIComponent(words)}&limit=100`, { ttlMs: HOUR, timeoutMs: SOURCE_TIMEOUTS.search });
        const all: Hit[] = [];
        for (const r of Array.isArray(hit.data?.results) ? hit.data.results : []) {
          const h = hitOf(r?.native?.ownerHandle, r?.native?.skill, { name: r?.displayName });
          if (!h) continue;
          h.recent60 = count(r?.metrics?.rolling60DayInstalls);
          all.push(h);
        }
        const newer = (a: string | null, b: string | null) => String(b || '').localeCompare(String(a || ''));
        all.sort((a, b) => (o.sort === 'new' ? newer(a.createdAt, b.createdAt) : o.sort === 'updated' ? newer(a.updatedAt, b.updatedAt) : o.sort === 'trending' ? b.recent60 - a.recent60 : (b.stars || 0) - (a.stars || 0)) || (b.downloads || 0) - (a.downloads || 0));
        const from = (page - 1) * OPEN_PAGE;
        return { hits: plain(all.slice(from, from + OPEN_PAGE)), total: all.length, more: from + OPEN_PAGE < all.length, stale: hit.stale, error: hit.error, limitedUntil: null };
      }
      // A list goes by cursor: page n needs the cursor page n-1 gave (each page is kept, so "Meer laden" is one request).
      let cursor = '';
      let last: any = null;
      let stale = false;
      let error: string | null = null;
      for (let p = 1; p <= page; p++) {
        const hit = await this.cache.json<any>(`clawhub-list:${o.sort}:${p}`, `${CLAWHUB}/api/v1/skills?limit=${OPEN_PAGE}&sort=${CLAW_SORT[o.sort]}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { ttlMs: o.sort === 'updated' || o.sort === 'new' ? 10 * 60_000 : HOUR, timeoutMs: SOURCE_TIMEOUTS.search });
        last = hit.data;
        stale = stale || hit.stale;
        error = error || hit.error;
        cursor = typeof last?.nextCursor === 'string' ? last.nextCursor : '';
        if (!cursor && p < page) return noPage({ stale, error });
      }
      const hits: Hit[] = [];
      for (const k of Array.isArray(last?.items) ? last.items : []) {
        const h = hitOf(k?.ownerHandle, k, { license: k?.latestVersion?.license });
        if (h) hits.push(h);
      }
      return { hits: plain(hits), total: null, more: !!cursor, stale, error, limitedUntil: null };
    } catch (e: any) {
      const limited = e instanceof WebError && e.code === 'rate-limited';
      return noPage({ error: String(e?.message || e).slice(0, 300), limitedUntil: limited ? (e.until ?? Date.now() + 60_000) : null });
    }
  }

  /**
   * What ClawHub says about one skill now: its latest version (what an install pins, and what an update check
   * compares with), the licence it names, and the words of its own moderation when it has any.
   */
  async clawhubSkill(name: string, o: { force?: boolean } = {}): Promise<{ version: string | null; license: string | null; warning: string; error: string | null }> {
    const [owner, slug] = name.split('/');
    try {
      const hit = await this.cache.json<any>(`clawhub-skill:${name}`, `${CLAWHUB}/api/v1/skills/${encodeURIComponent(slug)}?ownerHandle=${encodeURIComponent(owner)}`, { ttlMs: HOUR, force: o.force, timeoutMs: SOURCE_TIMEOUTS.api });
      const version = String(hit.data?.latestVersion?.version || '');
      const m = hit.data?.moderation;
      // Its moderation is empty for an ordinary skill; what it does say is passed on in its own words.
      const said = m && typeof m === 'object' ? [m.verdict, m.status, m.reason, m.summary].filter((x) => typeof x === 'string' && x).join(': ') || (m.isSuspicious || m.isMalwareBlocked || m.isHidden ? 'gemarkeerd' : '') : '';
      const fine = ['clean', 'ok', 'approved', 'safe', 'benign', 'none'].includes(said.split(':')[0].trim().toLowerCase());
      return { version: VERSION_RE.test(version) ? version : null, license: hit.data?.latestVersion?.license ? String(hit.data.latestVersion.license).slice(0, 40) : null, warning: fine ? '' : said.slice(0, 200), error: hit.error };
    } catch (e: any) {
      return { version: null, license: null, warning: '', error: String(e?.message || e).slice(0, 300) };
    }
  }

  // ---------- the skills in one repository ----------
  /** Cached index without network access. */
  peekIndex(repo: string): RepoIndex | null {
    const m = this.mem.get(repo);
    if (m) return m;
    if (this.noIndex.has(repo)) return null;
    const hit = this.cache.peek<RepoIndex>(`index:${repo}`);
    if (hit?.data?.repo === repo && Array.isArray(hit.data.skills)) {
      this.mem.set(repo, hit.data);
      return hit.data;
    }
    if (this.noIndex.size > 5000) this.noIndex.clear();
    this.noIndex.add(repo);
    return null;
  }

  private keep(idx: RepoIndex) {
    this.noIndex.delete(idx.repo);
    this.mem.set(idx.repo, idx);
    this.cache.put(`index:${idx.repo}`, idx);
  }

  /** The skills of a repository at the commit HEAD points to; concurrent calls share one run (one download, one parse). */
  index(repo: string, o: { force?: boolean; userId?: string | null } = {}): Promise<RepoIndex> {
    assertRepo(repo);
    const cur = this.running.get(repo);
    if (cur && !o.force) return cur;
    const p = this.buildOrReuse(repo, o);
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
    this.keep(idx);
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

  private describe(root: string, own: FileMap, repo: string, repoFiles: { path: string; text: string }[]): IndexedSkill {
    const a = analyze(own, base(root) || repo.split('/')[1]);
    const m = a.parsed.meta;
    return {
      path: root,
      name: m.name,
      description: m.description,
      version: m.version,
      author: m.author || m.metadata?.author || '',
      license: resolveSkillLicense({ skillFiles: own, frontmatter: m.license, repoFiles }),
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

  /** Large repositories: the folders with a SKILL.md through the tree API (their names only). */
  private async treeIndex(repo: string, commit: string | null, userId?: string | null): Promise<RepoIndex> {
    const ref = commit || 'HEAD';
    const hit = await this.cache.json<any>(`tree:${repo}@${ref}`, `https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`, { ttlMs: commit ? 30 * 24 * HOUR : 12 * HOUR, headers: this.apiHeaders(userId), accept: 'application/vnd.github+json', timeoutMs: SOURCE_TIMEOUTS.raw });
    const blobs: string[] = (Array.isArray(hit.data?.tree) ? hit.data.tree : []).filter((t: any) => t?.type === 'blob' && typeof t.path === 'string').map((t: any) => safeRelPath(t.path)).filter(Boolean);
    const roots = findSkillRoots(new Map(blobs.map((n) => [n, EMPTY]))).slice(0, MAX_ROOTS);
    const skills: IndexedSkill[] = roots.map((r) => {
      const name = base(r) || repo.split('/')[1];
      return { path: r, name, description: '', version: '', author: '', license: { spdx: null, label: 'Nog niet bekeken', status: 'unknown', source: 'none' }, checksum: '', fileCount: 0, size: 0, kind: 'prompt', scanLevel: 'ok', labels: [], category: categorize(name), errors: [], partial: true };
    });
    const meta = await this.repoMeta(repo, userId);
    const idx: RepoIndex = { repo, mode: 'tree', commit, commitDate: meta?.pushedAt || null, fetchedAt: new Date().toISOString(), skills, rootLicense: meta?.license ? { ...(classifyId(meta.license) || { spdx: null, label: meta.license, status: 'unknown' }), source: 'github' } : null, skipped: 0, truncated: !!hit.data?.truncated || roots.length >= MAX_ROOTS };
    this.keep(idx);
    return idx;
  }

  /** A skill of an index by what an open result calls it: its folder, the name in its SKILL.md, or its folder name. */
  find(idx: RepoIndex, what: string): IndexedSkill | null {
    const w = what.toLowerCase();
    return idx.skills.find((x) => x.path === what) || idx.skills.find((x) => x.name.toLowerCase() === w) || idx.skills.find((x) => base(x.path).toLowerCase() === w) || null;
  }

  /**
   * The folder of an open result in its repository, at the commit HEAD points to now. `what` is a folder, a skill name
   * (as the directory gives it), or empty for a repository that holds one skill.
   */
  async resolveOpen(repo: string, what: string, userId?: string | null): Promise<{ repo: string; path: string; index: RepoIndex; skill: IndexedSkill }> {
    const idx = await this.index(assertRepo(repo), { userId });
    if (!idx.skills.length) throw new HttpError(404, `In ${repo} staat geen skill (geen map met een SKILL.md).`);
    const list = (n = 30) => idx.skills.slice(0, n).map((s) => webRef(repo, s.path || s.name)).join(', ') + (idx.skills.length > n ? ` en nog ${idx.skills.length - n}` : '');
    if (!what) {
      if (idx.skills.length === 1) return { repo, path: idx.skills[0].path, index: idx, skill: idx.skills[0] };
      throw new HttpError(409, `${repo} heeft ${idx.skills.length} skills; kies er een: ${list()}.`, 'choose');
    }
    const s = this.find(idx, what);
    if (!s) throw new HttpError(404, `Skill ${what} niet (meer) gevonden in ${repo}. Wel: ${list(15)}.`);
    return { repo, path: s.path, index: idx, skill: s };
  }

  // ---------- updates of skills installed from the internet before 0.4 (catalog_ref `github/…`) ----------
  /**
   * Newer source version of such a skill, or null (cached index only, no network). `known` says whether a checksum is
   * already one of the skill's stored revisions: after a local edit (or a rollback) the active checksum differs from
   * the source, but the source version is not new, so it is no update.
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
  return {
    stars: Number(j.stargazers_count) || 0,
    license: spdx,
    pushedAt: j.pushed_at ? String(j.pushed_at) : null,
    createdAt: j.created_at ? String(j.created_at) : null,
    description: String(j.description || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    archived: !!j.archived,
    htmlUrl: String(j.html_url || ''),
  };
}

function commonTop(names: string[]): string {
  if (!names.length) return '';
  const first = names[0].split('/')[0];
  return names.every((n) => n.includes('/') && n.split('/')[0] === first) ? first : '';
}
