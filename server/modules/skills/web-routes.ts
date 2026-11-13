import type { Ctx } from '../../core/types.js';
import { HttpError, ah, bad, str, user } from '../../core/http.js';
import type { SkillLibrary, SkillRow } from './library.js';
import type { CuratedCatalog } from './curated-routes.js';
import type { OpenSort } from '../../../shared/skills.js';
import { GITHUB_SEARCH_LIMIT, GITHUB_TOKEN_SECRET, OPEN_SORTS, type WebSkills, assertRepo, parseWebRef, searchWords } from './websource.js';
import { isOffline } from './webcache.js';

export { webErr } from './websource.js';

const TOKEN_RE = /^(gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})$/;

/**
 * The open side of the marketplace, under /api/skills/web:
 *   GET  /skills/web/search?q=&sort=&page=&teamId=&only=   everything public: repositories on GitHub, skills from the open
 *                                                     directory skills.sh and skills hosted by ClawHub, in one of the orders `stars`, `trending`, `new`,
 *                                                     `updated`; plus (a search by words) the matches in the checked
 *                                                     catalogue. Results are cached; a reached limit comes back as
 *                                                     `limit` with what was cached. `only=github|directory|clawhub` asks one
 *                                                     source (the screen asks them apart).
 *   GET  /skills/web/repo?repo=&teamId=               the skills in one repository
 *   GET  /skills/web/sources                          state of the sources (limits, the optional GitHub token)
 *   PUT/DELETE /skills/web/github-token               the optional token (vault)
 *   POST /skills/web/check-updates                    skills installed from the internet before 0.4
 * Adding a result is POST /skills/curated/install with its id: the one install path of the marketplace.
 */
export function webRoutes(d: { ctx: Ctx; lib: SkillLibrary; web: WebSkills; curated: CuratedCatalog; isBlocked?: (type: string, catalogId: string, itemId: string) => boolean }) {
  const { ctx, lib, web, curated } = d;
  const api = ctx.api;
  /** Admin takedown (Marktplaats › Meldingen): an open result is blocked as catalog "curated", item `github/<owner>/<repo>[/<skill>]`. */
  const blocked = (id: string) => !!d.isBlocked?.('skill', 'curated', id);
  const teamOf = (userId: string, v: unknown) => {
    const p = v ? lib.placementFor(userId, str(v, 60)) : null;
    return p && p.scope === 'team' ? p.teamId : null;
  };

  api.get(
    '/skills/web/sources',
    ah(async (req) => {
      const u = user(req);
      return {
        offline: isOffline(),
        github: { tokenSet: !!ctx.secrets.getByName(u.id, GITHUB_TOKEN_SECRET), apiBlockedUntil: web.cache.blockedHost('api.github.com'), searchBlockedUntil: web.cache.blockedHost(GITHUB_SEARCH_LIMIT) },
        skillsSh: { blockedUntil: web.cache.blockedHost('skills.sh') || web.cache.blockedHost('www.skills.sh') },
        clawhub: { blockedUntil: web.cache.blockedHost('clawhub.ai') },
      };
    }),
  );

  api.get(
    '/skills/web/search',
    ah(async (req) => {
      const u = user(req);
      const sort = (OPEN_SORTS as string[]).includes(String(req.query.sort)) ? (String(req.query.sort) as OpenSort) : 'stars';
      const page = Math.min(40, Math.max(1, Math.floor(Number(req.query.page)) || 1));
      const only = req.query.only === 'github' || req.query.only === 'directory' || req.query.only === 'clawhub' ? req.query.only : undefined;
      return curated.search(u.id, { q: searchWords(req.query.q), sort, page, teamId: teamOf(u.id, req.query.teamId), only, blocked });
    }),
  );

  api.get(
    '/skills/web/repo',
    ah(async (req) => {
      const u = user(req);
      const repo = assertRepo(req.query.repo);
      if (blocked(`github/${repo}`)) throw new HttpError(403, 'Dit item is door de beheerder geblokkeerd.');
      const r = await curated.repoSkills(u.id, repo, teamOf(u.id, req.query.teamId));
      return { ...r, skills: r.skills.filter((s) => !blocked(s.id)) };
    }),
  );

  /** Skills installed from the internet before 0.4 (catalog_ref `github/…`): look whether their repository moved on. */
  api.post(
    '/skills/web/check-updates',
    ah(async (req) => {
      const u = user(req);
      const rows: SkillRow[] = lib.list(u.id).filter((s) => s.status !== 'draft' && !!parseWebRef(s.catalog_ref));
      const repos = [...new Set(rows.map((s) => parseWebRef(s.catalog_ref)!.repo))];
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
