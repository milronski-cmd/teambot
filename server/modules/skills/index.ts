import path from 'node:path';
import type { Agent, Ctx, Module } from '../../core/types.js';
import { SkillLibrary, skillMigrations } from './library.js';
import { WebCache } from './webcache.js';
import { WebSkills } from './websource.js';
import { webRoutes } from './web-routes.js';
import { Importer } from './importer.js';
import { Catalogs, mapToFiles } from './catalog.js';
import { type Fetcher, defaultFetcher } from './fetch.js';
import { skillRoutes } from './routes.js';
import { nativeSkillsPrompt, skillTools, systemPromptFor } from './tools.js';
import { skillChoiceContext, skillFitContext, skillMenuRoutes } from './menu.js';
import { exportTemplate, installTemplate, normalizeTemplate, previewTemplate } from './templates.js';
import { enforcePolicy, publisherRoutes, publisherSettings, unsignedView } from './publishers.js';
import { CuratedCatalog, curatedRoutes } from './curated-routes.js';
import { githubAccess } from './curated-source.js';
import { fromChatRoutes } from './from-chat.js';
import { fromDocumentRoutes } from './from-document.js';
import { skillTestMigrations, skillTestRoutes } from './tests.js';
import { SkillDefaults, skillOfferMigrations } from './defaults.js';
import { SkillWorkspace, ownSkillPaths } from './workspace.js';
import type { CuratedSource } from './curated.js';

/**
 * Skills & marketplace: a per-user skill library in the open SKILL.md format (import, scan, versions,
 * trust), the skills of a bot as folders in its work folder for engines that load those themselves and as a list plus
 * `skill_load` for every other engine, bot-proposed drafts, and a marketplace with bot templates, skills and apps.
 */
const mod: Module = {
  id: 'skills',
  label: 'Skills & marktplaats',
  migrations: [...skillMigrations, ...skillTestMigrations, ...skillOfferMigrations],
  init(ctx) {
    let fetcher: Fetcher = defaultFetcher;
    const getFetcher = () => fetcher;
    const lib = new SkillLibrary(ctx);
    const importer = new Importer(ctx, lib);
    const catalogs = new Catalogs(ctx, getFetcher);
    // The open sources (GitHub search, the skills.sh directory), cached on disk so the marketplace also works offline.
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
      web,
    );

    ctx.tools.registerGroup({ id: 'skills', label: 'Skills', description: 'Skills van het team laden, zoeken, toevoegen en zelf vastleggen', defaultOn: true });
    const workspace = new SkillWorkspace(ctx, lib);
    for (const t of skillTools(lib, { curated, importer, fetcher: getFetcher, workspace })) ctx.tools.register(t);

    ctx.hooks.systemPrompt.push(({ agent }) => systemPromptFor(ctx, lib, agent));
    // A skill picked in the composer ("/name" or "$name"): this turn the bot loads and follows it.
    ctx.hooks.turnContext.push(({ agent, input }) => skillChoiceContext(ctx, lib, agent, input));
    ctx.hooks.turnContext.push(({ agent, input }) => skillFitContext(ctx, lib, agent, input));

    // Every bot has its team's active skills without anyone switching them on: they are on its list (defaults.ts) and
    // stand as folders in its work folder (workspace.ts). Brought up to date where that answer changes: a skill
    // installed, changed, trusted, switched or removed (every write of the library), a bot made, changed or moved.
    const defaults = new SkillDefaults(ctx, lib);
    lib.offer = (agent) => defaults.offer(agent);
    const busy = new Set<string>();
    // Bots that are being removed (the hook below runs right before their row goes): nothing is done for them.
    const leaving = new Set<string>();
    /** The bot's list complete (a few rows, done on the spot). Returns the bot as stored now, null when it is left alone. */
    const listed = (agent: Pick<Agent, 'id' | 'user_id'>): Agent | null => {
      // Putting a skill on the list tells "agent.updated" itself: not a second round for the same bot.
      if (busy.has(agent.id) || leaving.has(agent.id)) return null;
      busy.add(agent.id);
      try {
        // Only reads which team and folder the bot has: an archived bot, and one without a team yet, is left alone.
        const stored = ctx.store.agent(agent.id);
        if (!stored || stored.archived || stored.user_id !== agent.user_id || !lib.placed(stored)) return null;
        return defaults.offer(stored);
      } catch (e) {
        ctx.log.error('[skills] skills of a bot not brought up to date', e);
        return null;
      } finally {
        busy.delete(agent.id);
      }
    };
    /** The list and the folders. With `until` the folders are written until then; true when there is more to write. */
    const upToDate = (agent: Pick<Agent, 'id' | 'user_id'>, until?: number): boolean => {
      const cur = listed(agent);
      return cur ? workspace.sync(cur, until) : false;
    };
    // Writing the folders is disk work per bot (every file of a skill, in two places). It is done bot by bot between
    // the server's other work (a short piece, then a pause in which requests are answered), so TeamBot keeps answering
    // while a row of skills is installed for a large team; a bot that is asked for again while it waits is done once.
    // A CLI engine never starts on old folders: `sync` (below) brings its bot up to date on the spot.
    const waiting = new Set<string>();
    let turn: NodeJS.Timeout | null = null;
    const PIECE_MS = 15;
    const PAUSE_MS = 20;
    let stopped = false;
    const settled: (() => void)[] = [];
    const work = () => {
      turn = null;
      const until = Date.now() + PIECE_MS;
      for (const id of waiting) {
        waiting.delete(id);
        const a = ctx.store.agent(id);
        // A bot with a lot to write is done in parts: back in the row for what is left.
        if (a && upToDate(a, until)) waiting.add(id);
        if (Date.now() > until) break;
      }
      // Bringing a bot up to date can put a bot in the row itself (its list changed): one clock at a time.
      if (waiting.size) turn ??= setTimeout(work, PAUSE_MS);
      else if (!turn) for (const done of settled.splice(0)) done();
    };
    const later = (agent: Pick<Agent, 'id' | 'user_id'>) => {
      // The list is complete at once (the screens show it); only the folders wait.
      if (stopped || !listed(agent)) return;
      waiting.add(agent.id);
      turn ??= setTimeout(work, PAUSE_MS);
    };
    const allUpToDate = (userId: string) => {
      for (const a of ctx.store.agents(userId)) later(a);
    };
    lib.onChange = allUpToDate;
    ctx.events.on('agent.updated', (e) => e.data?.id && e.data?.user_id && later(e.data));
    ctx.events.on('teams.changed', (e) => e.userId && e.userId !== '*' && allUpToDate(e.userId));

    ctx.hooks.agentDeleted.push(({ agentId }) => {
      leaving.add(agentId);
      setImmediate(() => leaving.delete(agentId));
      defaults.forget({ agentId });
      workspace.forget(agentId);
      ctx.store.exec("UPDATE skills SET draft_agent_id = NULL WHERE draft_agent_id = ? AND status != 'draft'", agentId);
    });

    // Before skillRoutes: /skills/:id would otherwise swallow /skills/menu and /skills/publishers.
    skillMenuRoutes(ctx, lib);
    publisherRoutes(ctx);
    // Also before skillRoutes: /skills/:id/file would otherwise match /skills/web/file.
    webRoutes({ ctx, lib, web, curated, isBlocked: (type, catalogId, itemId) => catalogs.isBlocked(type, catalogId, itemId) });
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
      /** The open sources of the marketplace (GitHub search, the skills.sh directory). */
      web,
      /** TeamBot's own catalogue (pinned sources). */
      curated,
      /** Skills (summaries) of a user; `teamId` = what one team has. `teamId` per skill: null = for all teams. */
      list: (userId: string, teamId?: string) => lib.list(userId, { teamId }).map((s) => ({ id: s.id, name: s.name, description: s.description, status: s.status, version: s.version, kind: s.kind, teamId: lib.teamOf(s) })),
      /** The skills a bot has: the active skills of its team, minus what was taken away from it (library `enabledFor`). */
      enabledFor: (agent: Agent) => lib.enabledFor(agent).map((s) => ({ id: s.id, name: s.name, description: s.description })),
      /** The skill folders in a bot's work folder up to date, right before a CLI engine starts there. */
      sync: (agent: Pick<Agent, 'id' | 'user_id'>) => void upToDate(agent),
      /** Which paths in a work folder TeamBot wrote itself (the skill folders): a snapshot leaves them alone. */
      ownPaths: (root: string) => ownSkillPaths(root),
      /** Resolves once the folders of every bot that waited are written (a script or test that reads them right after a change). */
      settled: () => (waiting.size || turn ? new Promise<void>((done) => settled.push(done)) : Promise.resolve()),
      /** The server closes: nothing is written any more. */
      halt: () => {
        stopped = true;
        waiting.clear();
        if (turn) clearTimeout(turn);
        turn = null;
        for (const done of settled.splice(0)) done();
      },
      /**
       * For an engine that loads those folders itself: the bot's instructions with TeamBot's list of skills replaced by
       * one short rule. Null when the list in them is not the one of now (then nothing is left out).
       */
      nativeSystem: (agent: Agent, system: string): string | null => {
        const list = systemPromptFor(ctx, lib, agent);
        if (!list) return system;
        return system.includes(list) ? system.replace(list, () => nativeSkillsPrompt(agent)) : null;
      },
      /** Do the bot's skills stand in its work folder? Only in a folder TeamBot made for it (workspace.ts). */
      inWorkFolder: (agent: Agent) => workspace.owns(agent),
      /** The bot's skills as a plugin folder for one run of Claude Code, where the work folder cannot serve (workspace.ts). */
      plugin: (agent: Agent, dir: string) => workspace.plugin(agent, dir),
      /** An engine loaded a skill itself (its own skill tool, seen in its stream): counted like a `skill_load`. */
      used: (agent: Agent, name: string) => {
        const skill = lib.enabledFor(agent).find((s) => s.name === String(name || '').split(':').pop());
        if (skill) lib.used(agent, skill);
      },
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
      /** Test seam: replace TeamBot's catalogue (local fixture repositories in tests). */
      setCuratedSources(list: CuratedSource[]) {
        curated.sources = list;
      },
      /** Every bot has its team's active skills (defaults.ts): `offerAll(userId)` after a change, `upgrade()` at start. */
      defaults,
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
    // Bots that exist get the active skills of their team once (and new skills from then on): nothing to switch on.
    try {
      const n = ctx.services.skills?.defaults?.upgrade() ?? 0;
      if (n) ctx.log.info?.('[skills] bots that got the skills of their team:', n);
    } catch (e) {
      ctx.log.error('[skills] default skills failed', e);
    }
  },

  stop(ctx: Ctx) {
    ctx.services.skills?.halt?.();
  },
};

export default mod;
