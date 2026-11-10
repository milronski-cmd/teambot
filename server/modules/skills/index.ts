import path from 'node:path';
import type { Agent, Ctx, Module } from '../../core/types.js';
import { SkillLibrary, skillMigrations } from './library.js';
import { WebCache } from './webcache.js';
import { WebSkills, type Collection } from './websource.js';
import { webRoutes } from './web-routes.js';
import { Importer } from './importer.js';
import { Catalogs, mapToFiles } from './catalog.js';
import { type Fetcher, defaultFetcher } from './fetch.js';
import { skillRoutes } from './routes.js';
import { skillTools, systemPromptFor } from './tools.js';
import { skillChoiceContext, skillMenuRoutes } from './menu.js';
import { exportTemplate, installTemplate, normalizeTemplate, previewTemplate } from './templates.js';
import { enforcePolicy, publisherRoutes, publisherSettings, unsignedView } from './publishers.js';
import { CuratedCatalog, curatedRoutes } from './curated-routes.js';
import { githubAccess } from './curated-source.js';
import { fromChatRoutes } from './from-chat.js';
import { fromDocumentRoutes } from './from-document.js';
import { skillTestMigrations, skillTestRoutes } from './tests.js';
import type { CuratedSource } from './curated.js';

/**
 * Skills & marketplace: a per-user skill library in the open SKILL.md format (import, scan, versions,
 * trust), progressive disclosure for bots (system prompt lists name + description, `skill_load`
 * loads the instructions), bot-proposed drafts, and a marketplace with bot templates, skills and apps.
 */
const mod: Module = {
  id: 'skills',
  label: 'Skills & marktplaats',
  migrations: [...skillMigrations, ...skillTestMigrations],
  init(ctx) {
    let fetcher: Fetcher = defaultFetcher;
    const getFetcher = () => fetcher;
    const lib = new SkillLibrary(ctx);
    const importer = new Importer(ctx, lib);
    const catalogs = new Catalogs(ctx, getFetcher);
    // Internet sources (GitHub collections, skills.sh), cached on disk so the marketplace also works offline.
    const web = new WebSkills(ctx, new WebCache(path.join(ctx.config.dataDir, 'cache', 'market-skills'), getFetcher, ctx.log));
    // TeamBot's own catalogue on pinned commits (fetched on install, never bundled; updates only after approval).
    const curated = new CuratedCatalog(
      ctx,
      lib,
      importer,
      (userId) =>
        githubAccess(web.cache, {
          headers: () => {
            const t = web.token(userId);
            return { 'x-github-api-version': '2022-11-28', ...(t ? { authorization: `Bearer ${t}` } : {}) };
          },
          head: (repo, force) => web.headCommit(repo, { force }),
        }),
      web.cache,
    );

    ctx.tools.registerGroup({ id: 'skills', label: 'Skills', description: 'Ingeschakelde skills laden en nieuwe skills als concept voorstellen', defaultOn: true });
    for (const t of skillTools(lib)) ctx.tools.register(t);

    ctx.hooks.systemPrompt.push(({ agent }) => systemPromptFor(ctx, lib, agent));
    // A skill picked in the composer ("/name" or "$name"): this turn the bot loads and follows it.
    ctx.hooks.turnContext.push(({ agent, input }) => skillChoiceContext(ctx, lib, agent, input));

    ctx.hooks.agentDeleted.push(({ agentId }) => {
      for (const m of ctx.store.find<any>('skill_materializations', { agent_id: agentId })) lib.cleanupMaterialization(m);
      ctx.store.exec("UPDATE skills SET draft_agent_id = NULL WHERE draft_agent_id = ? AND status != 'draft'", agentId);
    });

    // Before skillRoutes: /skills/:id would otherwise swallow /skills/menu and /skills/publishers.
    skillMenuRoutes(ctx, lib);
    publisherRoutes(ctx);
    // Also before skillRoutes: /skills/:id/file would otherwise match /skills/web/file.
    webRoutes({
      ctx,
      lib,
      importer,
      web,
      isBlocked: (type, catalogId, itemId) => catalogs.isBlocked(type, catalogId, itemId),
      // While the internet collections are fetched for the first time: TeamBot's own skills, one per category first.
      starter: (userId) => {
        const own = catalogs.skills(userId).filter((s) => s.sourceKind === 'builtin');
        const seen = new Set<string>();
        const first = own.filter((s) => !seen.has(s.category) && seen.add(s.category));
        return [...first, ...own.filter((s) => !first.includes(s))].map((s) => ({ catalogId: s.catalogId, id: s.id, title: s.title, description: s.description, category: s.category, version: s.version }));
      },
    });
    // Before skillRoutes too (/skills/:id would match /skills/curated).
    curatedRoutes({ ctx, lib, importer, catalog: curated, isBlocked: (type, catalogId, itemId) => catalogs.isBlocked(type, catalogId, itemId) });
    // "Bewaar als skill" from a conversation (also before skillRoutes: /skills/:id would match /skills/from-chat).
    fromChatRoutes({ ctx, lib, importer });
    // "Maak een skill van dit document" (a dossier source) and testing a skill with saved test questions (0.4.4).
    fromDocumentRoutes({ ctx, lib, importer });
    skillTestRoutes({ ctx, lib, curated });
    skillRoutes({ ctx, lib, importer, catalogs, fetcher: getFetcher, web, curated });

    ctx.services.skills = {
      library: lib,
      /** Stage/commit skills with the regular review rules (used by the OpenBot import). */
      importer,
      catalogs,
      /** Internet skill sources (open GitHub collections + skills.sh search; off unless configured). */
      web,
      /** TeamBot's own catalogue (pinned sources). */
      curated,
      /** Skills (summaries) of a user; `teamId` = what one team has. `teamId` per skill: null = for all teams. */
      list: (userId: string, teamId?: string) => lib.list(userId, { teamId }).map((s) => ({ id: s.id, name: s.name, description: s.description, status: s.status, version: s.version, kind: s.kind, teamId: lib.teamOf(s) })),
      /** Active skills enabled for a bot (owner-checked). */
      enabledFor: (agent: Agent) => lib.enabledFor(agent).map((s) => ({ id: s.id, name: s.name, description: s.description })),
      exportTemplate: (agent: Agent) => exportTemplate(ctx, lib, agent),
      previewTemplate: (userId: string, raw: any) => {
        const n = normalizeTemplate(raw);
        return previewTemplate(ctx, lib, userId, n.template, n.warnings);
      },
      /** Install a plain (unsigned) template on behalf of a user; the publisher policy applies here too. */
      installTemplate: (userId: string, raw: any, o: { provider_id?: string; model?: string; name?: string; acknowledge?: boolean; overridePolicy?: boolean; teamId?: string | null } = {}) => {
        const u = ctx.store.user(userId);
        if (!u) throw new Error('Onbekende gebruiker');
        const t = normalizeTemplate(raw).template;
        enforcePolicy(ctx, u, unsignedView(), { override: o.overridePolicy === true, what: 'bot', item: t.name });
        return installTemplate(ctx, lib, userId, t, { ...o, source: { type: 'template' } });
      },
      /** Current publisher policy and trusted keys (read-only). */
      publisherSettings: () => publisherSettings(ctx),
      /** Included in the user's full data export. */
      exportUser: (userId: string) => ({
        skills: {
          library: lib.list(userId).map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            status: s.status,
            version: s.version,
            license: s.license,
            author: s.author,
            source: s.source,
            checksum: s.checksum,
            activeRev: s.active_rev,
            teamId: lib.teamOf(s),
            files: mapToFiles(lib.readFiles(s)),
          })),
          catalogs: catalogs.externalRows(userId).map((r) => ({ url: r.url, name: r.name, expected_sha256: r.expected_sha256 })),
          shares: ctx.store.all('SELECT item_type, slug, title, version, created_at FROM skill_shares WHERE user_id = ?', userId),
        },
      }),
      /** Test seam: replace the downloader (tests never reach the network). */
      setFetcher(f: Fetcher) {
        fetcher = f;
      },
      /** Test seam: replace the open internet collections. */
      setCollections(list: Collection[]) {
        web.collections = list;
      },
      /** Test seam: replace TeamBot's catalogue (local fixture repositories in tests). */
      setCuratedSources(list: CuratedSource[]) {
        curated.sources = list;
      },
    };
  },

  start(ctx: Ctx) {
    // Teams (0.4, package B4): skills installed before teams get their team (the default team, or all teams when bots
    // of several teams already use them). After every module's init, so the teams module made "Mijn team" first.
    try {
      const n = (ctx.services.skills?.library as SkillLibrary | undefined)?.upgradeTeams() ?? 0;
      if (n) ctx.log.info?.('[skills] skills filed under their team:', n);
    } catch (e) {
      ctx.log.error('[skills] team upgrade failed', e);
    }
  },
};

export default mod;
