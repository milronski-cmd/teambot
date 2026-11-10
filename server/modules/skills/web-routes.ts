import type { Ctx } from '../../core/types.js';
import { HttpError, ah, bad, str, user } from '../../core/http.js';
import { isBinary } from './files.js';
import { analyze, type SkillLibrary, type SkillRow } from './library.js';
import type { Importer } from './importer.js';
import { fileType } from './scan.js';
import { classifyId, categorize, CATEGORIES, type LicenseInfo } from './licenses.js';
import { GITHUB_TOKEN_SECRET, type IndexedSkill, type RepoIndex, type RepoMeta, type SkillsShHit, type WebSkills, assertRepo, assertSkillPath, licenseReason, parseWebRef, webRef } from './websource.js';
import { WebError, budgetParam, isOffline, sharedDeadline, withBudget } from './webcache.js';
import { skillSubstance } from './substance.js';

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const TOKEN_RE = /^(gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})$/;

/** An error of the web catalogue as an HTTP answer (its own status where that says something). */
export function webErr(e: any): never {
  if (e instanceof HttpError) throw e;
  if (e instanceof WebError) throw new HttpError(e.status === 404 ? 404 : e.status === 429 ? 429 : e.status === 503 ? 503 : 502, e.message);
  throw new HttpError(502, String(e?.message || e).slice(0, 300));
}

export function githubUrl(repo: string, commit: string | null, p: string) {
  return `https://github.com/${repo}${p || commit ? `/tree/${commit || 'HEAD'}${p ? '/' + p.split('/').map(encodeURIComponent).join('/') : ''}` : ''}`;
}

/** Licence shown for a skill: the index result, upgraded with GitHub's repository licence when the files said nothing. */
export function effectiveLicense(s: IndexedSkill, meta: RepoMeta | null): LicenseInfo {
  if (s.license.status === 'unknown' && s.license.source === 'none' && meta?.license) {
    const c = classifyId(meta.license);
    if (c && c.status !== 'unknown') return { ...c, source: 'github' };
  }
  return s.license;
}

const matches = (q: string, ...fields: string[]) => {
  if (!q) return true;
  const hay = fields.join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
};

/** A skill from TeamBot's own catalogue, shown while the internet collections are fetched for the first time. */
export interface StarterSkill {
  catalogId: string;
  id: string;
  title: string;
  description: string;
  category: string;
  version: string;
}

export function webRoutes(d: { ctx: Ctx; lib: SkillLibrary; importer: Importer; web: WebSkills; isBlocked?: (type: string, catalogId: string, itemId: string) => boolean; starter?: (userId: string) => StarterSkill[] }) {
  const { ctx, lib, importer, web } = d;
  const api = ctx.api;
  /** Admin takedown (Marktplaats › Meldingen) applies to internet items too: catalog "github", item "<owner>/<repo>[/<path>]". */
  const blocked = (repo: string, p: string) => !!d.isBlocked?.('skill', 'github', `${repo}${p ? '/' + p : ''}`);
  const assertNotBlocked = (repo: string, p: string) => {
    if (blocked(repo, p)) throw new HttpError(403, 'Dit item is door de beheerder geblokkeerd.');
  };

  /** skills.sh install counts seen in searches ("owner/repo|name" → count), so the detail shows the same popularity as the card. */
  const seenInstalls = new Map<string, number>();
  const rememberInstalls = (m: Map<string, number>) => {
    for (const [k, v] of m) if (v > (seenInstalls.get(k) || 0)) seenInstalls.set(k, v);
    while (seenInstalls.size > 5000) seenInstalls.delete(seenInstalls.keys().next().value!);
  };
  const installsOf = (repo: string, s: { name: string; path: string }) =>
    seenInstalls.get(`${repo.toLowerCase()}|${s.name.toLowerCase()}`) ?? seenInstalls.get(`${repo.toLowerCase()}|${(s.path.split('/').pop() || '').toLowerCase()}`) ?? null;

  const installedByRef = (userId: string) => {
    const m = new Map<string, SkillRow>();
    for (const s of lib.list(userId)) if (s.catalog_ref?.startsWith('github/') && s.status !== 'draft') m.set(s.catalog_ref, s);
    return m;
  };

  const view = (idx: RepoIndex, s: IndexedSkill, o: { installs?: number | null; installed?: SkillRow; meta?: RepoMeta | null }) => {
    const meta = o.meta ?? web.peekRepoMeta(idx.repo);
    const license = effectiveLicense(s, meta);
    const errors = s.errors || [];
    const inst = o.installed;
    return {
      type: 'skill' as const,
      source: 'github' as const,
      catalogId: 'github',
      id: `${idx.repo}${s.path ? '/' + s.path : ''}`,
      ref: webRef(idx.repo, s.path),
      repo: idx.repo,
      path: s.path,
      name: s.name,
      title: s.name,
      description: s.description,
      category: s.category,
      version: s.version,
      commit: idx.commit,
      updatedAt: idx.commitDate,
      publisher: idx.repo.split('/')[0],
      author: s.author || idx.repo.split('/')[0],
      license,
      installable: !s.partial && license.status === 'open' && !errors.length,
      reason: s.partial ? null : license.status !== 'open' ? licenseReason(license) : errors[0] || null,
      stars: meta?.stars ?? null,
      installs: o.installs ?? null,
      kind: s.kind,
      scanLevel: s.scanLevel,
      labels: s.labels,
      fileCount: s.fileCount,
      size: s.size,
      partial: !!s.partial,
      url: githubUrl(idx.repo, idx.commit, s.path),
      installed: inst ? { skillId: inst.id, version: inst.version, status: inst.status, updateAvailable: !s.partial && !!s.checksum && inst.checksum !== s.checksum && !lib.hasRevision(inst.id, s.checksum) } : null,
    };
  };

  const shView = (h: SkillsShHit) => ({
    type: 'skill' as const,
    source: 'skills.sh' as const,
    catalogId: 'skills.sh',
    id: `skills.sh:${h.id}`,
    repo: REPO_RE.test(h.source) ? h.source : null,
    sourceLabel: h.source,
    skillId: h.skillId,
    path: null,
    name: h.name || h.skillId,
    title: h.name || h.skillId,
    description: '',
    category: categorize(h.name, h.skillId),
    publisher: h.source.split('/')[0],
    installs: h.installs,
    unresolved: true,
    installable: null as boolean | null,
    reason: REPO_RE.test(h.source) ? null : 'Deze skill staat niet op GitHub; TeamBot kan hem niet ophalen.',
    license: { spdx: null, label: 'Bekijk details', status: 'unknown', source: 'none' } as LicenseInfo,
    installed: null,
  });

  /**
   * The curated collections, stale-while-revalidate: a collection in the cache is shown at once (when its last check is
   * over an hour old, the check runs in the background: `refreshing`); a collection that was never fetched gets until
   * the deadline, after which it keeps downloading in the background (`pending`) and the page asks again. All sources
   * run in parallel, each with its own time limit (SOURCE_TIMEOUTS), so one slow source never holds up the rest.
   */
  const gather = async (userId: string, repos: string[], budgetMs: number, early: boolean) => {
    const dl = sharedDeadline(budgetMs, early);
    const ready: RepoIndex[] = [];
    const pending: string[] = [];
    const refreshing: string[] = [];
    const errors: { repo: string; error: string }[] = [];
    await Promise.all(
      repos.map(async (repo) => {
        const cached = web.snapshot(repo);
        // Checked recently: the snapshot, no network at all.
        if (cached && !web.needsRefresh(repo)) {
          ready.push(cached);
          if (cached.error) errors.push({ repo, error: cached.error });
          return;
        }
        const p = web.index(repo, { userId });
        p.catch(() => {});
        try {
          // The first view never waits for a check of a cached collection; a page asking again does (until the
          // check or the deadline ends); a collection that was never fetched gets until the deadline.
          const r = cached && !early ? 'pending' : await dl.wait(p);
          if (r === 'pending') {
            if (cached) (ready.push(cached), refreshing.push(repo));
            else pending.push(repo);
          } else {
            ready.push(r);
            if (r.error) errors.push({ repo, error: r.error });
          }
        } catch (e: any) {
          if (cached) ready.push({ ...cached, stale: true, error: e?.message });
          errors.push({ repo, error: String(e?.message || e).slice(0, 300) });
        }
      }),
    );
    // Star counts: cached for a day; a repository without any is asked within what is left of the deadline.
    await Promise.all(
      ready.map((i) => {
        const p = web.repoMeta(i.repo, userId).catch(() => null);
        return web.peekRepoMeta(i.repo) ? null : withBudget(p, dl.left());
      }),
    );
    dl.done();
    const order = new Map(repos.map((r, i) => [r, i]));
    ready.sort((a, b) => (order.get(a.repo) ?? 99) - (order.get(b.repo) ?? 99));
    return { ready, pending, refreshing, errors };
  };

  api.get(
    '/skills/web/sources',
    ah(async (req) => {
      const u = user(req);
      return {
        offline: isOffline(),
        github: { tokenSet: !!ctx.secrets.getByName(u.id, GITHUB_TOKEN_SECRET), apiBlockedUntil: web.cache.blockedHost('api.github.com') },
        skillsSh: { blockedUntil: web.cache.blockedHost('skills.sh') || web.cache.blockedHost('www.skills.sh') },
        collections: web.collections.map((c) => {
          const idx = web.peekIndex(c.repo);
          const meta = web.peekRepoMeta(c.repo);
          return {
            repo: c.repo,
            note: c.note,
            url: `https://github.com/${c.repo}`,
            indexed: !!idx,
            mode: idx?.mode || null,
            skills: idx?.skills.length ?? null,
            installable: idx ? idx.skills.filter((s) => effectiveLicense(s, meta).status === 'open').length : null,
            commit: idx?.commit || null,
            updatedAt: idx?.commitDate || null,
            fetchedAt: idx?.fetchedAt || null,
            license: idx?.rootLicense?.spdx || meta?.license || null,
            stars: meta?.stars ?? null,
          };
        }),
      };
    }),
  );

  api.post(
    '/skills/web/sources/refresh',
    ah(async (req) => {
      const u = user(req);
      const one = req.body?.repo ? assertRepo(req.body.repo) : null;
      const repos = one ? [one] : web.collections.map((c) => c.repo);
      const out: any[] = [];
      for (const repo of repos) {
        try {
          const idx = await web.index(repo, { force: true, userId: u.id });
          await web.repoMeta(repo, u.id, { force: true });
          out.push({ repo, ok: true, skills: idx.skills.length, commit: idx.commit, stale: !!idx.stale, error: idx.error || null });
        } catch (e: any) {
          out.push({ repo, ok: false, error: String(e?.message || e).slice(0, 300) });
        }
      }
      return { results: out };
    }),
  );

  api.get(
    '/skills/web/skills',
    ah(async (req) => {
      const u = user(req);
      const q = str(req.query.q, 100).trim();
      const category = str(req.query.category, 60);
      const repoFilter = req.query.repo ? assertRepo(req.query.repo) : '';
      const onlyInstallable = req.query.installable === '1';
      const repos = repoFilter ? [repoFilter] : web.collections.map((c) => c.repo);
      const budget = budgetParam(req.query.budget);
      // skills.sh runs alongside the collections (its own time limit), not after them.
      // skills.sh is an open store: only searched when open collections are configured (TEAMBOT_SKILL_COLLECTIONS).
      const useSh = q.length >= 2 && !repoFilter && web.collections.length > 0;
      const shP: Promise<{ hits: SkillsShHit[]; stale: boolean; error: string | null }> = useSh
        ? web.searchSkillsSh(q).catch((e: any) => ({ hits: [], stale: false, error: String(e?.message || e).slice(0, 300) }))
        : Promise.resolve({ hits: [], stale: false, error: null });
      const { ready, pending, refreshing, errors } = await gather(u.id, repos, budget, req.query.early === '1');
      const inst = installedByRef(u.id);
      const sh = await shP;
      const installs = web.installsFrom(sh.hits);
      rememberInstalls(installs);
      const items: any[] = [];
      const seen = new Set<string>();
      const push = (v: any) => {
        if (seen.has(v.id)) return;
        seen.add(v.id);
        items.push(v);
      };
      for (const idx of ready) {
        for (const s of idx.skills) {
          if (!matches(q, s.name, s.description, idx.repo, s.category, s.path)) continue;
          push(view(idx, s, { installs: installs.get(`${idx.repo.toLowerCase()}|${s.name.toLowerCase()}`) ?? installs.get(`${idx.repo.toLowerCase()}|${(s.path.split('/').pop() || '').toLowerCase()}`) ?? null, installed: inst.get(webRef(idx.repo, s.path)) }));
        }
      }
      for (const h of sh.hits) {
        const idx = REPO_RE.test(h.source) ? web.peekIndex(h.source) : null;
        const s = idx?.skills.find((x) => x.name.toLowerCase() === h.skillId.toLowerCase()) || idx?.skills.find((x) => (x.path.split('/').pop() || '').toLowerCase() === h.skillId.toLowerCase());
        if (idx && s) {
          const v = view(idx, s, { installs: h.installs, installed: inst.get(webRef(idx.repo, s.path)) });
          const existing = items.find((x) => x.id === v.id);
          if (existing) existing.installs = Math.max(existing.installs || 0, h.installs);
          else push(v);
        } else push(shView(h));
      }
      let out = items.filter((i) => (!category || i.category === category) && (!onlyInstallable || i.installable !== false) && !(i.repo && i.path !== null && blocked(i.repo, i.path)));
      // Search: names that contain the query first, then popularity. Browsing: installable skills first (stable order).
      const ql = q.toLowerCase();
      const nameHit = (i: any) => (String(i.name).toLowerCase() === ql ? 2 : String(i.name).toLowerCase().includes(ql) ? 1 : 0);
      if (q) out.sort((a, b) => nameHit(b) - nameHit(a) || (b.installs || 0) - (a.installs || 0) || (b.stars || 0) - (a.stars || 0) || a.name.localeCompare(b.name));
      else out.sort((a, b) => (a.installable === false ? 1 : 0) - (b.installable === false ? 1 : 0));
      const total = out.length;
      out = out.slice(0, 300);
      // Nothing from the internet yet (first start, slow or no network): TeamBot's own skills are ready right away.
      const starterAll = !ready.length && !q && !repoFilter && !category && d.starter ? d.starter(u.id) : [];
      const starter = starterAll.slice(0, 6);
      return {
        items: out,
        total,
        categories: [...new Set(items.map((i) => i.category))].sort((a, b) => (CATEGORIES.findIndex((c) => c.label === a) + 1 || 99) - (CATEGORIES.findIndex((c) => c.label === b) + 1 || 99)),
        pending,
        refreshing,
        collections: { total: repos.length, ready: ready.length },
        starter,
        starterTotal: starterAll.length,
        errors,
        stale: ready.some((i) => i.stale) || sh.stale,
        skillsSh: { used: useSh, error: sh.error, stale: sh.stale },
        offline: isOffline(),
      };
    }),
  );

  /** Resolve a skills.sh result to its folder in the repository. */
  const target = async (userId: string, q: any): Promise<{ repo: string; path: string }> => {
    if (q.source && q.skillId) {
      try {
        return await web.resolve(String(q.source).slice(0, 200), String(q.skillId).slice(0, 120), userId);
      } catch (e) {
        webErr(e);
      }
    }
    return { repo: assertRepo(q.repo), path: assertSkillPath(q.path) };
  };

  api.get(
    '/skills/web/item',
    ah(async (req) => {
      const u = user(req);
      const t = await target(u.id, req.query);
      assertNotBlocked(t.repo, t.path);
      let r;
      try {
        r = await web.skillFiles(t.repo, t.path, u.id);
      } catch (e) {
        webErr(e);
      }
      const meta = await web.repoMeta(t.repo, u.id).catch(() => null);
      const a = analyze(r.files, r.skill.name);
      const inst = installedByRef(u.id).get(webRef(t.repo, t.path));
      const base = view(r.index, r.skill, { installed: inst, meta, installs: installsOf(t.repo, r.skill) });
      const md = r.files.get('SKILL.md')?.toString('utf8') || '';
      return {
        ...base,
        skillMd: md.length > 200_000 ? md.slice(0, 200_000) : md,
        meta: a.parsed.meta,
        errors: a.errors,
        warnings: a.warnings,
        scan: { level: a.scan.level, kind: a.scan.kind, labels: a.scan.labels, findings: a.scan.findings, files: a.scan.files.map((f) => ({ path: f.path, size: f.size, type: f.type })), domains: a.scan.domains },
        permissions: a.permissions,
        files: a.scan.files.map((f) => ({ path: f.path, size: f.size, type: f.type })),
        checksum: a.checksum,
        substance: skillSubstance(md, [...r.files.keys()], a.parsed.meta.name),
        repoMeta: meta,
        repoLicense: r.index.rootLicense,
        indexMode: r.index.mode,
        stale: !!r.index.stale,
      };
    }),
  );

  api.get(
    '/skills/web/file',
    ah(async (req) => {
      const u = user(req);
      const t = await target(u.id, req.query);
      const rel = assertSkillPath(req.query.file);
      if (!rel) throw bad('Kies een bestand');
      let r;
      try {
        r = await web.skillFiles(t.repo, t.path, u.id);
      } catch (e) {
        webErr(e);
      }
      const buf = r.files.get(rel);
      if (!buf) throw new HttpError(404, 'Bestand niet gevonden');
      const type = fileType(rel, buf);
      const binary = type === 'executable' || type === 'binary' || isBinary(buf);
      return { path: rel, size: buf.length, type, binary, text: binary ? null : buf.toString('utf8').slice(0, 200_000) };
    }),
  );

  /** Stage a skill from the internet for review; installing goes through /skills/import/commit (scan, permissions, policy). */
  api.post(
    '/skills/web/install',
    ah(async (req) => {
      const u = user(req);
      const t = await target(u.id, req.body || {});
      assertNotBlocked(t.repo, t.path);
      let r;
      try {
        r = await web.skillFiles(t.repo, t.path, u.id);
      } catch (e) {
        webErr(e);
      }
      const meta = await web.repoMeta(t.repo, u.id).catch(() => null);
      const license = effectiveLicense(r.skill, meta);
      if (license.status !== 'open') throw new HttpError(403, licenseReason(license) || 'Niet installeerbaar.', 'license');
      const url = githubUrl(t.repo, r.index.commit, t.path);
      const st = importer.stage(u.id, `${t.repo}${t.path ? '/' + t.path : ''}`, [
        {
          files: r.files,
          root: '',
          source: { type: 'github', label: `${t.repo}${t.path ? '/' + t.path : ''}`, url, catalogId: 'github', itemId: `${t.repo}${t.path ? '/' + t.path : ''}`, version: r.skill.version || (r.index.commit ? r.index.commit.slice(0, 7) : ''), verified: false, publisher: t.repo.split('/')[0] },
          fallbackName: r.skill.name,
          catalogRef: webRef(t.repo, t.path),
        },
      ]);
      ctx.audit(u.id, 'market.web_skill_staged', { repo: t.repo, path: t.path, commit: r.index.commit, license: license.spdx });
      // For the chosen team, '*' = all teams, else the default team (package B4); the commit takes it from here.
      return { ...importer.view(u.id, st, lib.placementFor(u.id, req.body?.teamId ?? req.query.teamId)), license };
    }),
  );

  /** Re-check the repositories of installed internet skills (archive redirect; download only when HEAD moved). */
  api.post(
    '/skills/web/check-updates',
    ah(async (req) => {
      const u = user(req);
      const rows = [...installedByRef(u.id).values()];
      const repos = [...new Set(rows.map((s) => parseWebRef(s.catalog_ref)?.repo).filter(Boolean) as string[])];
      const errors: { repo: string; error: string }[] = [];
      for (const repo of repos) {
        try {
          await web.index(repo, { userId: u.id, force: req.body?.force === true });
        } catch (e: any) {
          errors.push({ repo, error: String(e?.message || e).slice(0, 300) });
        }
      }
      const updates = rows
        .map((s) => ({ s, upd: web.updateFor(s.catalog_ref, s.checksum, (sum) => lib.hasRevision(s.id, sum)) }))
        .filter((x) => x.upd)
        .map((x) => ({ skillId: x.s.id, name: x.s.name, repo: x.upd!.repo, path: x.upd!.path, version: x.upd!.version, commit: x.upd!.commit }));
      return { checked: repos.length, updates, errors };
    }),
  );

  // ---- optional GitHub token (vault) ----
  api.put(
    '/skills/web/github-token',
    ah(async (req) => {
      const u = user(req);
      const token = str(req.body?.token, 300).trim();
      if (!TOKEN_RE.test(token)) throw bad('Dit lijkt geen GitHub-token (verwacht ghp_…, github_pat_… of gho_…).');
      ctx.secrets.set(u.id, GITHUB_TOKEN_SECRET, token);
      ctx.audit(u.id, 'market.github_token_set', {});
      return { ok: true, tokenSet: true };
    }),
  );
  api.delete(
    '/skills/web/github-token',
    ah(async (req) => {
      const u = user(req);
      for (const s of ctx.secrets.list(u.id)) if (s.name === GITHUB_TOKEN_SECRET) ctx.secrets.delete(s.id);
      ctx.audit(u.id, 'market.github_token_removed', {});
      return { ok: true, tokenSet: false };
    }),
  );
}
