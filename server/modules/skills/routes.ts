import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { Request } from 'express';
import type { Agent, Ctx } from '../../core/types.js';
import { ah, bad, notFound, requireRole, str, user, HttpError } from '../../core/http.js';
import { newId, now } from '../../core/db.js';
import { type FileMap, LIMITS, filesFromDir, filesFromUpload, filesFromZip, isBinary, safeRelPath, stripTopFolder, zipFiles } from './files.js';
import { buildSkillMd, slugify, splitFrontmatter } from './format.js';
import { type SkillLibrary, type SkillRow, type VersionRow, analyze } from './library.js';
import type { Importer } from './importer.js';
import { discoverDirs } from './importer.js';
import { type Catalogs, type MarketBot, type MarketSkill, mapToFiles } from './catalog.js';
import { exportTemplate, installTemplate, normalizeTemplate, previewTemplate, templateFromPackage, type BotTemplate, TEMPLATE_FORMAT } from './templates.js';
import { diffPermissions, fileType } from './scan.js';
import { skillSubstance } from './substance.js';
import { type Fetcher, resolveGithub } from './fetch.js';
import { parseWebRef } from './websource.js';
import type { WebSkills } from './websource.js';
import { checksumOf } from './files.js';
import { type InlinePackage, MAIN_FILE, MANIFEST_FILE, PACKAGE_KINDS, type PackageKind, type PackageVerification, filesToInline, readManifest } from '../../../packages/teambot-sdk/src/index.js';
import { type PackageInfo, type SignatureView, assertMaySelfAuthor, builtinView, decide, enforcePolicy, infoOf, unsignedView, viewOf, viewOfInfo } from './publishers.js';
import type { CuratedCatalog } from './curated-routes.js';

const SIGNED_STATES = new Set(['builtin', 'trusted', 'untrusted']);

const PROTECTED = /([\\/]\.ssh([\\/]|$)|[\\/]\.gnupg([\\/]|$)|[\\/]\.aws([\\/]|$)|master\.key$|local-token$|[\\/]\.env(\.[^\\/]*)?$)/i;
const REPORT_REASONS = new Set(['malware', 'injectie', 'privacy', 'auteursrecht', 'misleidend', 'werkt-niet', 'anders']);

export interface Deps {
  ctx: Ctx;
  lib: SkillLibrary;
  importer: Importer;
  catalogs: Catalogs;
  fetcher: () => Fetcher;
  /** Internet sources: update detection for skills installed from GitHub. */
  web?: WebSkills;
  /** TeamBot's own catalogue: origin (repo, commit, licence) and update state of catalogue skills. */
  curated?: CuratedCatalog;
}

/** Compare dotted versions; >0 when a is newer than b. */
export function cmpVersion(a: string, b: string): number {
  const pa = String(a || '').replace(/^v/i, '').split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = String(b || '').replace(/^v/i, '').split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x).localeCompare(String(y));
  }
  return 0;
}

export function skillRoutes(d: Deps) {
  const { ctx, lib, importer, catalogs } = d;
  const api = ctx.api;
  /** Where an install by the owner goes (package B4): `teamId` in the body or query, '*' = all teams, else the default team. */
  const pl = (req: Request) => lib.placementFor(user(req).id, (req.body as any)?.teamId ?? req.query.teamId);

  const ownSkill = (req: Request) => {
    const s = lib.get(user(req).id, String(req.params.id));
    if (!s) throw notFound('Skill niet gevonden');
    return s;
  };
  const ownAgent = (req: Request, id: string): Agent => {
    const a = ctx.store.agent(id);
    if (!a || a.user_id !== user(req).id) throw notFound('Bot niet gevonden');
    return a;
  };
  const emit = (userId: string, ids: string[]) => ctx.events.emit(userId, 'skills.updated', { ids });
  /** Signature view of a catalog item (trust list applied now). */
  const itemSignature = (it: Parameters<Catalogs['verification']>[0]): SignatureView => {
    const v = catalogs.verification(it);
    return v === 'builtin' ? builtinView() : viewOf(ctx, v);
  };
  const sigView = (v: PackageVerification | 'builtin') => (v === 'builtin' ? builtinView() : viewOf(ctx, v));

  const agentsUsing = (userId: string) => {
    const map = new Map<string, { id: string; name: string }[]>();
    for (const a of ctx.store.agents(userId)) for (const sid of a.skills || []) map.set(sid, [...(map.get(sid) || []), { id: a.id, name: a.name }]);
    return map;
  };

  const summary = (s: SkillRow, using?: Map<string, { id: string; name: string }[]>) => {
    const webUpd = s.catalog_ref?.startsWith('github/') ? (d.web?.updateFor(s.catalog_ref, s.checksum, (sum) => lib.hasRevision(s.id, sum)) ?? null) : null;
    const curated = s.catalog_ref?.startsWith('curated/') ? (d.curated?.badge(s) ?? null) : null;
    const item = s.catalog_ref && !webUpd && !curated ? findCatalogItem(user0(s), s.catalog_ref) : null;
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      status: s.status,
      version: s.version,
      license: s.license,
      author: s.author,
      kind: s.kind,
      labels: s.labels,
      scanLevel: s.scan_level,
      pinned: s.pinned,
      trusted: lib.isTrusted(s),
      source: s.source,
      catalogRef: s.catalog_ref,
      blocked: !!(s.catalog_ref && catalogs.isBlocked('skill', s.catalog_ref.split('/')[0], s.catalog_ref.split('/').slice(1).join('/'))),
      activeRev: s.active_rev,
      latestRev: s.latest_rev,
      newerStoredRevision: s.latest_rev > s.active_rev,
      catalogUpdate: webUpd
        ? { version: webUpd.version, catalogId: 'github', itemId: `${webUpd.repo}${webUpd.path ? '/' + webUpd.path : ''}` }
        : curated?.update
          ? { version: `commit ${curated.update.to.slice(0, 7)}`, catalogId: 'curated', itemId: curated.id, commit: curated.update.to }
          : item && item.version && s.version && cmpVersion(item.version, s.version) > 0
            ? { version: item.version, catalogId: item.catalogId, itemId: item.id }
            : null,
      curated,
      installScope: s.install_scope || 'user',
      /** Per team (package B4): the team it is installed for, or null for "voor alle teams". */
      teamId: lib.teamOf(s),
      teamName: lib.teamName(lib.teamOf(s)),
      allTeams: lib.teamOf(s) === null,
      checksum: s.checksum,
      signature: viewOfInfo(ctx, s.package),
      agents: using?.get(s.id) || [],
      draftAgentId: s.draft_agent_id,
      draftThreadId: s.draft_thread_id,
      useCount: s.use_count,
      lastUsedAt: s.last_used_at,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
    };
  };
  const user0 = (s: SkillRow) => s.user_id;
  const findCatalogItem = (userId: string, ref: string): MarketSkill | null => {
    const [cat, ...rest] = ref.split('/');
    try {
      return catalogs.skills(userId).find((x) => x.catalogId === cat && x.id === rest.join('/')) || null;
    } catch {
      return null;
    }
  };

  const versionView = (s: SkillRow, v: VersionRow, active: VersionRow | null) => ({
    rev: v.rev,
    version: v.version,
    checksum: v.checksum,
    note: v.note,
    createdBy: v.created_by,
    createdAt: v.created_at,
    source: v.source,
    size: v.size,
    fileCount: v.file_count,
    scanLevel: v.scan.level,
    labels: v.scan.labels,
    signature: viewOfInfo(ctx, v.package),
    active: v.rev === s.active_rev,
    diffFromActive: active ? diffPermissions(active.permissions, v.permissions) : null,
  });

  // =================== import ===================
  api.post(
    '/skills/import/preview',
    ah(async (req) => {
      const u = user(req);
      const b = req.body || {};
      const kind = String(b.kind || '');
      if (kind === 'paste') {
        let text = str(b.text, 500_000);
        if (!text.trim()) throw bad('Plak de inhoud van een SKILL.md of schrijf instructies.');
        if (splitFrontmatter(text).fm === null) {
          const name = slugify(str(b.name, 100));
          const description = str(b.description, 1024).trim();
          if (!name || !description) throw bad('Deze tekst heeft geen frontmatter. Vul een naam en een beschrijving in, dan maken we die voor je.');
          text = buildSkillMd({ name, description }, text);
        }
        const st = importer.stage(u.id, 'Geplakte skill', [{ files: new Map([['SKILL.md', Buffer.from(text, 'utf8')]]), root: '', source: { type: 'paste', label: 'Geplakt' }, fallbackName: slugify(str(b.name, 100)) }]);
        return importer.view(u.id, st, pl(req));
      }
      if (kind === 'files') {
        const files = filesFromUploadSafe(b.files);
        const st = importer.stageFiles(u.id, stripTopFolder(files), { type: 'folder', label: str(b.label, 200) || 'Gekozen map' }, { fallbackName: slugify(str(b.label, 100)) });
        return importer.view(u.id, st, pl(req));
      }
      if (kind === 'url') return importer.view(u.id, await stageUrl(u.id, str(b.url, 2000).trim()), pl(req));
      if (kind === 'path') {
        requireRole(req, 'owner');
        const p = path.resolve(str(b.path, 1000).trim());
        if (!p || PROTECTED.test(p)) throw bad('Deze map is beschermd of ongeldig.');
        let files: FileMap;
        try {
          files = filesFromDir(p);
        } catch (e: any) {
          throw bad(e.message);
        }
        return importer.view(u.id, importer.stageFiles(u.id, files, { type: 'path', label: path.basename(p), path: p }, { fallbackName: path.basename(p) }), pl(req));
      }
      if (kind === 'discover') {
        requireRole(req, 'owner');
        return importer.view(u.id, importer.stageDiscover(u.id), pl(req));
      }
      throw bad('Onbekende importsoort');
    }),
  );

  function filesFromUploadSafe(list: any): FileMap {
    try {
      return filesFromUpload(list);
    } catch (e: any) {
      throw bad(e.message);
    }
  }

  async function stageUrl(userId: string, url: string) {
    if (!/^https?:\/\//i.test(url)) throw bad('Geef een http(s)-adres.');
    const gh = resolveGithub(url);
    const fetchIt = async (u: string) => {
      try {
        return await d.fetcher()(u, { maxBytes: LIMITS.maxZipBytes });
      } catch (e: any) {
        throw new HttpError(422, e?.message || String(e));
      }
    };
    if (gh?.kind === 'zip') {
      const r = await fetchIt(gh.url);
      let files: FileMap;
      try {
        files = stripTopFolder(filesFromZip(r.body));
      } catch (e: any) {
        throw new HttpError(422, e.message);
      }
      return importer.stageFiles(userId, files, { type: 'github', label: gh.label, url }, { subdir: gh.subdir || undefined, fallbackName: gh.subdir ? path.posix.basename(gh.subdir) : gh.label.split('/')[1] });
    }
    const r = await fetchIt(gh?.url || url);
    const isZip = r.body.subarray(0, 2).toString('latin1') === 'PK';
    if (isZip) {
      let files: FileMap;
      try {
        files = stripTopFolder(filesFromZip(r.body));
      } catch (e: any) {
        throw new HttpError(422, e.message);
      }
      return importer.stageFiles(userId, files, { type: 'url', label: new URL(url).hostname, url });
    }
    if (isBinary(r.body)) throw new HttpError(422, 'Dit adres geeft geen SKILL.md of zip-bestand terug.');
    const text = r.body.toString('utf8');
    if (/^\s*\{/.test(text)) {
      try {
        const j = JSON.parse(text);
        if (j?.format === 'teambot.catalog/v1') throw new HttpError(422, 'Dit is een catalogus. Voeg hem toe via Marktplaats › Bronnen.');
        if (j?.format === TEMPLATE_FORMAT) throw new HttpError(422, 'Dit is een bot-sjabloon. Installeer het via Marktplaats › Bots › Sjabloon importeren.');
      } catch (e) {
        if (e instanceof HttpError) throw e;
      }
    }
    const base = slugify(decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).slice(-2, -1)[0] || ''));
    return importer.stage(userId, new URL(url).hostname, [{ files: new Map([['SKILL.md', r.body]]), root: '', source: { type: 'url', label: new URL(url).hostname, url }, fallbackName: base }]);
  }

  api.post(
    '/skills/import/zip',
    express.raw({ type: () => true, limit: LIMITS.maxZipBytes }),
    ah(async (req) => {
      const u = user(req);
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || !body.length) throw bad('Leeg bestand');
      let files: FileMap;
      try {
        files = stripTopFolder(filesFromZip(body));
      } catch (e: any) {
        throw bad(e.message);
      }
      const name = str(req.query.name, 200).replace(/\.zip$/i, '');
      return importer.view(u.id, importer.stageFiles(u.id, files, { type: 'zip', label: name || 'zip-bestand' }, { fallbackName: slugify(name) }), pl(req));
    }),
  );

  api.get('/skills/import/:stagingId', ah(async (req) => importer.view(user(req).id, importer.get(user(req).id, String(req.params.stagingId)))));

  api.post(
    '/skills/import/commit',
    ah(async (req) => {
      const u = user(req);
      const b = req.body || {};
      const stagingId = str(b.stagingId, 100);
      // One team (default: the team chosen at the preview, else the default team) or all teams ('*'): package B4.
      const placement = b.teamId !== undefined ? lib.placementFor(u.id, b.teamId) : importer.get(u.id, stagingId).placement || lib.placementFor(u.id, '');
      return importer.commit(u.id, stagingId, {
        placement,
        keys: Array.isArray(b.keys) ? b.keys.map(String) : undefined,
        acknowledge: b.acknowledge === true,
        confirmPermissions: b.confirmPermissions === true,
        enableFor: Array.isArray(b.enableFor) ? b.enableFor.map(String) : [],
        overridePolicy: b.overridePolicy === true,
        confirmPublisherChange: b.confirmPublisherChange === true,
      });
    }),
  );

  api.get(
    '/skills/discover/dirs',
    ah(async (req) => {
      requireRole(req, 'owner');
      return discoverDirs().map((x) => ({ ...x, exists: fs.existsSync(x.dir) }));
    }),
  );

  // =================== per-bot enablement ===================
  api.get(
    '/skills/agents/:agentId',
    ah(async (req) => {
      const u = user(req);
      const a = ownAgent(req, String(req.params.agentId));
      const using = agentsUsing(u.id);
      // Per team (package B4): only skills the bot's team may see; another team's (meekijken) is marked read-only.
      const seen = lib.list(u.id).filter((s) => s.status !== 'draft' && lib.reach(a, s) !== 'none');
      return {
        enabled: (a.skills || []).filter((id) => seen.some((s) => s.id === id)),
        skills: seen.map((s) => ({ ...summary(s, using), readOnly: lib.reach(a, s) === 'read' })),
      };
    }),
  );
  api.put(
    '/skills/agents/:agentId',
    ah(async (req) => {
      const u = user(req);
      const a = ownAgent(req, String(req.params.agentId));
      const ids = Array.isArray(req.body?.skillIds) ? req.body.skillIds.map(String).slice(0, 200) : null;
      if (!ids) throw bad('skillIds moet een lijst zijn');
      const upd = lib.setAgentSkills(a, ids);
      ctx.audit(u.id, 'agent.skills_changed', { skills: upd.skills.length }, a.id);
      return { enabled: upd.skills };
    }),
  );
  /**
   * "Controleer op updates" in Mijn skills: ask every source of my installed skills again, now (GitHub repositories
   * without the hour cache: an archive is only downloaded when HEAD moved; added catalogs are fetched again). Returns
   * the skills that have an update afterwards and the sources that could not be reached.
   */
  api.post(
    '/skills/check-updates',
    ah(async (req) => {
      const u = user(req);
      const installed = lib.list(u.id).filter((s) => s.status !== 'draft' && s.catalog_ref);
      const errors: { source: string; error: string }[] = [];
      const msg = (e: any) => String(e?.message || e).slice(0, 300);
      const repos = d.web ? [...new Set(installed.map((s) => parseWebRef(s.catalog_ref)?.repo).filter(Boolean) as string[])] : [];
      for (const repo of repos) {
        try {
          await d.web!.index(repo, { userId: u.id, force: true });
        } catch (e) {
          errors.push({ source: repo, error: msg(e) });
        }
      }
      // TeamBot's catalogue: compare with a newer pinned commit and with the source itself (only shown, never applied).
      let curatedSources = 0;
      if (d.curated && installed.some((s) => s.catalog_ref?.startsWith('curated/'))) {
        const r = await d.curated.checkUpdates(u.id, true, null);
        curatedSources = new Set(installed.filter((s) => s.catalog_ref?.startsWith('curated/')).map((s) => String(s.catalog_ref).split('/')[1])).size;
        for (const e of r.errors) errors.push({ source: e.repo, error: e.error });
      }
      const used = new Set(installed.map((s) => String(s.catalog_ref).split('/')[0]));
      const cats = catalogs.sources(u.id).filter((c: any) => c.kind === 'external' && c.enabled !== false && used.has(c.id));
      for (const c of cats) {
        try {
          await catalogs.refresh(u.id, c.rowId);
        } catch (e) {
          errors.push({ source: c.name, error: msg(e) });
        }
      }
      const using = agentsUsing(u.id);
      const updates = lib
        .list(u.id)
        .filter((s) => s.status !== 'draft')
        .map((s) => summary(s, using))
        .filter((v) => v.catalogUpdate || v.newerStoredRevision)
        .map((v) => ({ skillId: v.id, name: v.name, version: v.catalogUpdate?.version || null, stored: !v.catalogUpdate }));
      if (updates.length) emit(u.id, updates.map((x) => x.skillId));
      return { checked: installed.length, sources: repos.length + cats.length + curatedSources, updates, errors, checkedAt: now() };
    }),
  );

  /** Which of my bots have this skill ("Alle bots" in one go). Bots not in the list lose it; archived bots keep theirs. */
  api.put(
    '/skills/:id/agents',
    ah(async (req) => {
      const u = user(req);
      const s = lib.get(u.id, String(req.params.id));
      if (!s) throw notFound('Skill niet gevonden');
      if (s.status === 'draft') throw bad('Een concept kun je nog niet bij een bot inschakelen');
      const ids = Array.isArray(req.body?.agentIds) ? new Set<string>(req.body.agentIds.map(String).slice(0, 500)) : null;
      if (!ids) throw bad('agentIds moet een lijst zijn');
      const changed: string[] = [];
      for (const a of ctx.store.agents(u.id)) {
        if (a.archived) continue;
        const has = (a.skills || []).includes(s.id);
        const want = ids.has(a.id);
        if (has === want) continue;
        lib.setAgentSkills(a, want ? [...(a.skills || []), s.id] : (a.skills || []).filter((x) => x !== s.id));
        changed.push(a.id);
      }
      if (changed.length) ctx.audit(u.id, 'skill.agents_changed', { skill: s.id, agents: changed.length });
      return { agentIds: ctx.store.agents(u.id).filter((a) => (a.skills || []).includes(s.id)).map((a) => a.id), changed: changed.length };
    }),
  );

  // =================== templates ===================
  api.get(
    '/skills/templates/export/:agentId',
    ah(async (req, res) => {
      const u = user(req);
      const a = ownAgent(req, String(req.params.agentId));
      const { template, warnings } = await exportTemplate(ctx, lib, a);
      ctx.audit(u.id, 'template.exported', { name: a.name, skills: template.skills.length, routines: template.routines.length, removedSecrets: warnings.length > 0 }, a.id);
      if (req.query.preview === '1') return { template, warnings };
      res.setHeader('content-disposition', `attachment; filename="${(a.name || 'bot').replace(/[^\w-]+/g, '_')}.teambot-bot.json"`);
      res.json(template);
    }),
  );
  /** A template upload: a plain template JSON (`template`, unsigned) or a bot package (`package: { manifest, files }`). */
  const uploadedTemplate = (b: any): { template: BotTemplate; warnings: string[]; verified: PackageVerification | null } => {
    if (b?.package) {
      const r = templateFromPackage(ctx, b.package as InlinePackage);
      return { template: r.template, warnings: r.warnings, verified: r.verification };
    }
    const n = normalizeTemplate(b?.template);
    return { ...n, verified: null };
  };
  api.post(
    '/skills/templates/preview',
    ah(async (req) => {
      const u = user(req);
      const { template, warnings, verified } = uploadedTemplate(req.body);
      const signature = verified ? viewOf(ctx, verified) : unsignedView();
      return { template: { name: template.name, skills: template.skills.length }, ...previewTemplate(ctx, lib, u.id, template, warnings), signature, policy: decide(ctx, u, signature) };
    }),
  );
  api.post(
    '/skills/templates/install',
    ah(async (req) => {
      const u = user(req);
      const b = req.body || {};
      const { template, verified } = uploadedTemplate(b);
      const signature = verified ? viewOf(ctx, verified) : unsignedView();
      enforcePolicy(ctx, u, signature, { override: b.overridePolicy === true, what: 'bot', item: template.name });
      return installTemplate(ctx, lib, u.id, template, {
        provider_id: b.provider_id ? str(b.provider_id, 100) : null,
        model: str(b.model, 200),
        name: str(b.name, 80),
        acknowledge: b.acknowledge === true,
        source: { type: 'template', label: template.name, publisher: signature.declaredPublisher || undefined },
        packageInfo: verified?.manifest ? infoOf(verified) : null,
        teamId: b.teamId ? str(b.teamId, 60) : null,
      });
    }),
  );

  // =================== packages (zip -> inline) ===================
  /**
   * Unpack an uploaded package zip (bot or connector) into its inline form `{ manifest, files }` so the browser
   * can preview and install it; every install route verifies it again. Skill zips go through /skills/import/zip.
   */
  api.post(
    '/skills/packages/unzip',
    express.raw({ type: () => true, limit: LIMITS.maxZipBytes }),
    ah(async (req) => {
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || !body.length) throw bad('Leeg bestand');
      let files: FileMap;
      try {
        files = stripTopFolder(filesFromZip(body));
      } catch (e: any) {
        throw bad(e.message);
      }
      let manifest: any = null;
      try {
        manifest = readManifest(files);
      } catch (e: any) {
        throw bad(e.message);
      }
      const kind: PackageKind | null = PACKAGE_KINDS.includes(manifest?.kind) ? manifest.kind : (PACKAGE_KINDS.find((k) => files.has(MAIN_FILE[k])) ?? null);
      if (!kind) throw bad('Dit zip-bestand is geen TeamBot-pakket (geen teambot-package.json, SKILL.md, bot.json of connector.json).');
      if (files.size > LIMITS.maxFiles) throw bad(`Te veel bestanden in het pakket (${files.size}, maximaal ${LIMITS.maxFiles}).`);
      return { kind, package: filesToInline(files) };
    }),
  );

  // =================== marketplace ===================
  const matches = (q: string, ...fields: (string | string[])[]) => {
    if (!q) return true;
    const hay = fields.flat().join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  };

  const installedSkillsByRef = (userId: string) => {
    const m = new Map<string, SkillRow>();
    for (const s of lib.list(userId)) if (s.catalog_ref && s.status !== 'draft') m.set(s.catalog_ref, s);
    return m;
  };

  const skillItemView = (it: MarketSkill, inst: SkillRow | undefined) => ({
    type: 'skill',
    catalogId: it.catalogId,
    catalogName: it.catalogName,
    sourceKind: it.sourceKind,
    id: it.id,
    name: it.name,
    title: it.title,
    description: it.description,
    category: it.category,
    tags: it.tags,
    version: it.version,
    license: it.license,
    publisher: it.publisher,
    author: it.author,
    verified: it.verified,
    signature: itemSignature(it),
    hasDownload: !!it.download,
    installed: inst ? { skillId: inst.id, version: inst.version, updateAvailable: !!(it.version && inst.version && cmpVersion(it.version, inst.version) > 0) } : null,
  });

  const botItemView = (it: MarketBot, userId: string) => {
    const count = ctx.store.agents(userId, { archived: true }).filter((a) => a.settings?.template?.catalogId === it.catalogId && a.settings?.template?.itemId === it.id).length;
    return {
      type: 'bot',
      catalogId: it.catalogId,
      catalogName: it.catalogName,
      sourceKind: it.sourceKind,
      id: it.id,
      title: it.title,
      role: it.role,
      avatar: it.avatar,
      color: it.color,
      description: it.description,
      category: it.category,
      tags: it.tags,
      version: it.version,
      license: it.license,
      publisher: it.publisher,
      verified: it.verified,
      signature: itemSignature(it),
      skills: it.template ? (it.template.skills || []).map((x: any) => x.name) : it.skills,
      installedCount: count,
    };
  };

  api.get('/skills/market/sources', ah(async (req) => catalogs.sources(user(req).id)));

  api.get(
    '/skills/market/skills',
    ah(async (req) => {
      const u = user(req);
      const q = str(req.query.q, 200);
      const cat = str(req.query.category, 60);
      const src = str(req.query.source, 80);
      const inst = installedSkillsByRef(u.id);
      const all = catalogs.skills(u.id);
      const items = all.filter((i) => (!cat || i.category === cat) && (!src || i.catalogId === src) && matches(q, i.title, i.name, i.description, i.tags, i.category, i.publisher));
      const views = items.map((i) => skillItemView(i, inst.get(`${i.catalogId}/${i.id}`)));
      return { categories: [...new Set(all.map((i) => i.category))].sort(), items: req.query.signed === '1' ? views.filter((v) => SIGNED_STATES.has(v.signature.state)) : views };
    }),
  );

  api.get(
    '/skills/market/bots',
    ah(async (req) => {
      const u = user(req);
      const q = str(req.query.q, 200);
      const cat = str(req.query.category, 60);
      const src = str(req.query.source, 80);
      const all = catalogs.bots(u.id);
      const items = all.filter((i) => (!cat || i.category === cat) && (!src || i.catalogId === src) && matches(q, i.title, i.role, i.description, i.tags, i.category, i.publisher));
      const views = items.map((i) => botItemView(i, u.id));
      return { categories: [...new Set(all.map((i) => i.category))].sort(), items: req.query.signed === '1' ? views.filter((v) => SIGNED_STATES.has(v.signature.state)) : views };
    }),
  );

  const normalizeApp = (x: any) => ({
    type: 'app',
    id: String(x?.id ?? x?.name ?? ''),
    title: String(x?.title ?? x?.name ?? x?.id ?? ''),
    description: String(x?.description ?? ''),
    category: String(x?.category ?? 'Overig'),
    publisher: String(x?.publisher ?? x?.vendor ?? ''),
    verified: !!x?.verified,
    license: String(x?.license ?? ''),
    version: String(x?.version ?? ''),
    transport: String(x?.transport ?? x?.type ?? ''),
    permissions: (Array.isArray(x?.scopes) ? x.scopes : Array.isArray(x?.permissions) ? x.permissions : []).map(String).slice(0, 50),
    externalCalls: (Array.isArray(x?.domains) ? x.domains : []).map(String).slice(0, 50),
    homepage: String(x?.homepage ?? x?.url ?? ''),
    installed: !!x?.installed,
    needsAuth: !!(x?.auth || x?.oauth || x?.needsAuth),
    changelog: Array.isArray(x?.changelog) ? x.changelog.slice(0, 20) : [],
  });

  api.get(
    '/skills/market/apps',
    ah(async (req) => {
      const u = user(req);
      const svc = ctx.services.mcp;
      if (!svc || typeof svc.catalog !== 'function') return { available: false, canInstall: false, categories: [], items: [] };
      let raw: any;
      try {
        raw = await svc.catalog(u.id);
      } catch (e: any) {
        return { available: true, canInstall: false, categories: [], items: [], error: String(e?.message || e) };
      }
      const builtin = (Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : [])
        .slice(0, 1000)
        .map((x: any) => ({ ...normalizeApp(x), catalogId: 'mcp', sourceKind: 'builtin', signature: builtinView() }))
        .filter((a: any) => a.id && !catalogs.isBlocked('app', 'mcp', a.id));
      // Connector packages from external catalogs: installed through the connector module with the package.
      const external = catalogs.connectors(u.id).map((c) => ({
        type: 'app',
        id: c.id,
        catalogId: c.catalogId,
        catalogName: c.catalogName,
        sourceKind: c.sourceKind,
        title: c.title,
        description: c.description,
        category: c.category,
        publisher: c.publisher,
        verified: false,
        license: c.license,
        version: c.version,
        transport: '',
        permissions: [],
        externalCalls: [],
        homepage: c.homepage,
        installed: false,
        needsAuth: false,
        changelog: c.changelog,
        packaged: true,
        signature: itemSignature(c),
      }));
      const all: any[] = [...builtin, ...external];
      const q = str(req.query.q, 200);
      const cat = str(req.query.category, 60);
      return {
        available: true,
        canInstall: typeof svc.install === 'function',
        categories: [...new Set(all.map((a: any) => a.category))].sort(),
        items: all.filter((a: any) => (!cat || a.category === cat) && matches(q, a.title, a.description, a.category, a.publisher) && (req.query.signed !== '1' || SIGNED_STATES.has(a.signature.state))),
      };
    }),
  );

  /** The inline package of an external connector item (the connector module verifies and installs it). */
  api.get(
    '/skills/market/apps/:catalogId/:itemId/package',
    ah(async (req) => {
      const u = user(req);
      const it = catalogs.findConnector(u.id, String(req.params.catalogId), String(req.params.itemId));
      return { kind: 'connector', catalogId: it.catalogId, itemId: it.id, title: it.title, package: it.package, signature: itemSignature(it), policy: decide(ctx, u, itemSignature(it)) };
    }),
  );

  api.post(
    '/skills/market/apps/:appId/install',
    ah(async (req) => {
      const u = user(req);
      const svc = ctx.services.mcp;
      if (!svc || typeof svc.install !== 'function') throw new HttpError(501, 'De connectormodule (MCP) is niet beschikbaar in deze installatie.');
      const appId = String(req.params.appId);
      if (catalogs.isBlocked('app', 'mcp', appId)) throw new HttpError(403, 'Deze app is door de beheerder geblokkeerd.');
      const agentId = req.body?.agentId ? ownAgent(req, String(req.body.agentId)).id : undefined;
      const r = await svc.install(u.id, appId, { agentId });
      ctx.audit(u.id, 'market.app_installed', { app: appId }, agentId ?? null);
      return r ?? { ok: true };
    }),
  );

  api.get(
    '/skills/market/skills/:catalogId/:itemId',
    ah(async (req) => {
      const u = user(req);
      const it = catalogs.findSkill(u.id, String(req.params.catalogId), String(req.params.itemId));
      const inst = installedSkillsByRef(u.id).get(`${it.catalogId}/${it.id}`);
      let analysisView: any = null;
      if (it.files) {
        try {
          const files = await catalogs.skillFiles(it);
          const a = analyze(files, it.name);
          analysisView = {
            skillMd: files.get('SKILL.md')?.toString('utf8') || '',
            meta: a.parsed.meta,
            errors: a.errors,
            warnings: a.warnings,
            scan: { level: a.scan.level, kind: a.scan.kind, labels: a.scan.labels, findings: a.scan.findings, files: a.scan.files.map((f) => ({ path: f.path, size: f.size, type: f.type })), domains: a.scan.domains },
            permissions: a.permissions,
            checksum: a.checksum,
            substance: skillSubstance(files.get('SKILL.md')?.toString('utf8') || '', [...files.keys()], a.parsed.meta.name),
          };
        } catch (e: any) {
          analysisView = { error: e.message };
        }
      }
      const view = skillItemView(it, inst);
      return { ...view, policy: decide(ctx, u, view.signature), homepage: it.homepage, changelog: it.changelog, platforms: it.platforms, dependencies: it.dependencies, sha256: it.sha256 || it.download?.sha256 || null, download: it.download ? { host: safeHost(it.download.url), size: it.download.size || null } : null, analysis: analysisView };
    }),
  );

  const safeHost = (u: string) => {
    try {
      return new URL(u).hostname;
    } catch {
      return '';
    }
  };

  api.post(
    '/skills/market/skills/:catalogId/:itemId/preview',
    ah(async (req) => {
      const u = user(req);
      const it = catalogs.findSkill(u.id, String(req.params.catalogId), String(req.params.itemId));
      const files = await catalogs.skillFiles(it);
      const st = importer.stage(u.id, it.title, [
        { files, root: '', source: { type: 'catalog', label: it.catalogName, catalogId: it.catalogId, itemId: it.id, version: it.version, verified: it.verified, publisher: it.publisher, url: it.download?.url }, fallbackName: it.name, catalogRef: `${it.catalogId}/${it.id}`, builtin: it.sourceKind === 'builtin' },
      ]);
      return importer.view(u.id, st, pl(req));
    }),
  );

  /** Turn a catalog bot into a full template (resolving its skills from the same catalog). */
  async function botTemplate(userId: string, it: MarketBot): Promise<{ template: BotTemplate; warnings: string[]; verified: PackageVerification | 'builtin' | null }> {
    if (it.package) {
      const r = templateFromPackage(ctx, it.package);
      return { template: r.template, warnings: r.warnings, verified: r.verification };
    }
    if (it.template) {
      const n = normalizeTemplate(it.template);
      return { ...n, verified: null };
    }
    const verified = it.sourceKind === 'builtin' ? ('builtin' as const) : null;
    const warnings: string[] = [];
    const skills: BotTemplate['skills'] = [];
    for (const sid of it.skills) {
      const sk = catalogs.skills(userId).find((x) => x.catalogId === it.catalogId && x.id === sid);
      if (!sk) {
        warnings.push(`Skill "${sid}" staat niet (meer) in de catalogus en wordt overgeslagen.`);
        continue;
      }
      try {
        const files = await catalogs.skillFiles(sk);
        skills.push({ name: sk.name, title: sk.title, version: sk.version, checksum: checksumOf(files), license: sk.license, files: mapToFiles(files), catalog: { catalogId: sk.catalogId, itemId: sk.id, verified: sk.verified } });
      } catch (e: any) {
        warnings.push(`Skill "${sid}" overgeslagen: ${e.message}`);
      }
    }
    const raw = {
      format: TEMPLATE_FORMAT,
      name: it.title,
      role: it.role,
      description: it.description,
      instructions: it.instructions,
      avatar: it.avatar,
      color: it.color,
      access_mode: it.access_mode,
      tool_groups: it.tool_groups,
      model_hint: it.model_hint,
      skills,
      routines: [],
      meta: { template_version: it.version, catalog: it.catalogId, item: it.id },
    };
    const n = normalizeTemplate(raw);
    // keep verified flags from our own resolution
    n.template.skills.forEach((s, i) => (s.catalog = skills[i]?.catalog || null));
    return { template: n.template, warnings: [...warnings, ...n.warnings], verified };
  }
  const botSignature = (verified: PackageVerification | 'builtin' | null) => (verified ? sigView(verified) : unsignedView());
  const botPackageInfo = (verified: PackageVerification | 'builtin' | null): PackageInfo | null => (verified === 'builtin' ? infoOf('builtin') : verified?.manifest ? infoOf(verified) : null);

  api.get(
    '/skills/market/bots/:catalogId/:itemId',
    ah(async (req) => {
      const u = user(req);
      const it = catalogs.findBot(u.id, String(req.params.catalogId), String(req.params.itemId));
      const view = botItemView(it, u.id);
      return { ...view, policy: decide(ctx, u, view.signature), instructions: it.instructions, tool_groups: it.tool_groups, access_mode: it.access_mode, model_hint: it.model_hint, changelog: it.changelog, homepage: it.homepage };
    }),
  );

  api.post(
    '/skills/market/bots/:catalogId/:itemId/preview',
    ah(async (req) => {
      const u = user(req);
      const it = catalogs.findBot(u.id, String(req.params.catalogId), String(req.params.itemId));
      const { template, warnings, verified } = await botTemplate(u.id, it);
      const signature = botSignature(verified);
      return { item: botItemView(it, u.id), ...previewTemplate(ctx, lib, u.id, template, warnings), signature, policy: decide(ctx, u, signature) };
    }),
  );

  api.post(
    '/skills/market/bots/:catalogId/:itemId/install',
    ah(async (req) => {
      const u = user(req);
      const b = req.body || {};
      const it = catalogs.findBot(u.id, String(req.params.catalogId), String(req.params.itemId));
      const { template, verified } = await botTemplate(u.id, it);
      const signature = botSignature(verified);
      enforcePolicy(ctx, u, signature, { override: b.overridePolicy === true, what: 'bot', item: `${it.catalogId}/${it.id}` });
      return installTemplate(ctx, lib, u.id, template, {
        provider_id: b.provider_id ? str(b.provider_id, 100) : null,
        model: str(b.model, 200),
        name: str(b.name, 80),
        acknowledge: b.acknowledge === true,
        source: { type: 'catalog', catalogId: it.catalogId, itemId: it.id, verified: it.verified, label: it.catalogName, publisher: signature.declaredPublisher || undefined },
        packageInfo: botPackageInfo(verified),
        teamId: b.teamId ? str(b.teamId, 60) : null,
      });
    }),
  );

  // ---- reports / takedown ----
  api.post(
    '/skills/market/report',
    ah(async (req) => {
      const u = user(req);
      const b = req.body || {};
      const type = String(b.type || '');
      if (!['skill', 'bot', 'app'].includes(type)) throw bad('Ongeldig type');
      const reason = String(b.reason || '');
      if (!REPORT_REASONS.has(reason)) throw bad('Kies een reden');
      const recent = ctx.store.one<{ n: number }>('SELECT COUNT(*) AS n FROM skill_reports WHERE user_id = ? AND created_at > ?', u.id, new Date(Date.now() - 3600_000).toISOString())?.n ?? 0;
      if (recent >= 20) throw new HttpError(429, 'Te veel meldingen in korte tijd. Probeer het later opnieuw.');
      const row = { id: newId('rep_'), user_id: u.id, item_type: type, catalog_id: str(b.catalogId, 80), item_id: str(b.itemId, 120), item_name: str(b.itemName, 200), reason, details: str(b.details, 4000), status: 'open', resolution: '', resolved_by: null, created_at: now(), resolved_at: null };
      if (!row.catalog_id || !row.item_id) throw bad('Onbekend item');
      ctx.store.insert('skill_reports', row);
      ctx.audit(u.id, 'market.reported', { type, catalogId: row.catalog_id, itemId: row.item_id, reason });
      for (const admin of ctx.store.users().filter((x) => x.role !== 'member' && x.id !== u.id)) {
        ctx.events.emit(admin.id, 'notification', { title: 'Marktplaatsmelding', body: `${row.item_name || row.item_id}: ${reason}`, link: '#/m/skills/meldingen', kind: 'report' });
      }
      return { ok: true, id: row.id };
    }),
  );

  api.get(
    '/skills/market/reports',
    ah(async (req) => {
      const u = user(req);
      const all = req.query.all === '1' && u.role !== 'member';
      const rows = all ? ctx.store.all<any>('SELECT r.*, u.name AS reporter FROM skill_reports r LEFT JOIN users u ON u.id = r.user_id ORDER BY r.created_at DESC LIMIT 500') : ctx.store.all<any>('SELECT * FROM skill_reports WHERE user_id = ? ORDER BY created_at DESC LIMIT 200', u.id);
      return rows.map((r) => ({ ...r, blocked: catalogs.isBlocked(r.item_type, r.catalog_id, r.item_id) }));
    }),
  );

  api.post(
    '/skills/market/reports/:id',
    ah(async (req) => {
      const u = requireRole(req, 'admin');
      const r = ctx.store.get<any>('skill_reports', String(req.params.id));
      if (!r) throw notFound('Melding niet gevonden');
      const status = String(req.body?.status || '');
      if (!['open', 'resolved', 'dismissed'].includes(status)) throw bad('Ongeldige status');
      ctx.store.update('skill_reports', r.id, { status, resolution: str(req.body?.resolution, 2000), resolved_by: u.id, resolved_at: now() });
      if (req.body?.block === true) blockItem(u.id, r.item_type, r.catalog_id, r.item_id, str(req.body?.resolution, 500) || r.reason);
      ctx.audit(u.id, 'market.report_resolved', { id: r.id, status, blocked: req.body?.block === true });
      return { ok: true };
    }),
  );

  const blockItem = (by: string, type: string, catalogId: string, itemId: string, reason: string) => {
    ctx.store.exec('INSERT OR REPLACE INTO skill_blocks (item_type, catalog_id, item_id, reason, blocked_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', type, catalogId, itemId, reason, by, now());
    ctx.audit(by, 'market.blocked', { type, catalogId, itemId, reason });
  };

  api.get('/skills/market/blocks', ah(async (req) => (requireRole(req, 'admin'), ctx.store.all('SELECT * FROM skill_blocks ORDER BY created_at DESC'))));
  api.post(
    '/skills/market/blocks',
    ah(async (req) => {
      const u = requireRole(req, 'admin');
      const b = req.body || {};
      if (!['skill', 'bot', 'app'].includes(b.type) || !b.catalogId || !b.itemId) throw bad('Onvolledig');
      blockItem(u.id, b.type, str(b.catalogId, 80), str(b.itemId, 120), str(b.reason, 500));
      return { ok: true };
    }),
  );
  api.delete(
    '/skills/market/blocks/:type/:catalogId/:itemId',
    ah(async (req) => {
      const u = requireRole(req, 'admin');
      ctx.store.exec('DELETE FROM skill_blocks WHERE item_type = ? AND catalog_id = ? AND item_id = ?', String(req.params.type), String(req.params.catalogId), String(req.params.itemId));
      ctx.audit(u.id, 'market.unblocked', { type: req.params.type, catalogId: req.params.catalogId, itemId: req.params.itemId });
      return { ok: true };
    }),
  );

  // ---- external catalogs ----
  api.get('/skills/catalogs', ah(async (req) => catalogs.sources(user(req).id)));
  api.post(
    '/skills/catalogs',
    ah(async (req) => {
      const u = user(req);
      const r = await catalogs.addCatalog(u.id, str(req.body?.url, 2000), req.body?.sha256 ? str(req.body.sha256, 64) : undefined);
      ctx.audit(u.id, 'catalog.added', { url: r.url, sha256: r.last_sha256 });
      return r;
    }),
  );
  api.post('/skills/catalogs/:id/refresh', ah(async (req) => catalogs.refresh(user(req).id, String(req.params.id))));
  api.patch(
    '/skills/catalogs/:id',
    ah(async (req) => {
      catalogs.updateCatalog(user(req).id, String(req.params.id), { enabled: req.body?.enabled, expected_sha256: req.body?.expected_sha256 });
      return { ok: true };
    }),
  );
  api.delete(
    '/skills/catalogs/:id',
    ah(async (req) => {
      const u = user(req);
      const row = catalogs.removeCatalog(u.id, String(req.params.id));
      ctx.audit(u.id, 'catalog.removed', { url: row.url });
      return { ok: true };
    }),
  );

  // ---- sharing with other users on this server ----
  // B-11: what a member shares is "ingediend" and waits for an owner/admin, who sees the scan and the content and
  // approves or rejects it; only approved items reach the others. An owner/admin's own share needs no second look.
  const reviewer = (role: string) => role === 'owner' || role === 'admin';
  const reviewers = () => ctx.store.users().filter((x) => reviewer(x.role) && !x.disabled);
  api.get('/skills/shares', ah(async (req) => ctx.store.all<any>('SELECT id, item_type, slug, title, description, version, status, review, created_at, updated_at FROM skill_shares WHERE user_id = ? ORDER BY updated_at DESC', user(req).id).map((r) => ({ ...r, review: r.review ? JSON.parse(r.review) : null }))));
  api.post(
    '/skills/shares',
    ah(async (req) => {
      const u = user(req);
      const b = req.body || {};
      let row: any;
      let scan: any = null;
      if (b.type === 'skill') {
        const s = lib.get(u.id, String(b.skillId || ''));
        if (!s || s.status === 'draft') throw notFound('Skill niet gevonden of nog een concept');
        const v = lib.version(s)!;
        if (v.scan.findings.some((f) => f.kind === 'secret')) throw bad('Deze skill bevat mogelijk een geheim. Verwijder het eerst; delen is geblokkeerd.');
        const files = lib.readFiles(s);
        // A signed revision is shared with its manifest, so others still see (and verify) the publisher.
        const manifest = v.package?.state === 'signed' ? v.package.manifest : undefined;
        row = { item_type: 'skill', slug: s.name, title: s.name, description: s.description, version: s.version, data: { files: mapToFiles(files), sha256: checksumOf(files), license: s.license, changelog: lib.versions(s).slice(0, 20).map((x) => ({ version: x.version || `r${x.rev}`, date: x.created_at.slice(0, 10), notes: x.note })), ...(manifest ? { manifest } : {}) } };
        scan = { level: v.scan.level, labels: v.scan.labels, findings: v.scan.findings.slice(0, 50), files: v.scan.files, scripts: v.scan.scripts, domains: v.scan.domains };
      } else if (b.type === 'bot') {
        const a = ownAgent(req, String(b.agentId || ''));
        const { template } = await exportTemplate(ctx, lib, a);
        row = { item_type: 'bot', slug: slugify(a.name) || a.id.toLowerCase(), title: a.name, description: a.description || a.role, version: template.meta.template_version, data: { template } };
      } else throw bad('Ongeldig type');
      const direct = reviewer(u.role);
      const review = { scan, submitted_at: now(), ...(direct ? { decided_by: u.id, decided_at: now(), auto: true } : {}) };
      const status = direct ? 'approved' : 'pending';
      const existing = ctx.store.one<any>('SELECT id FROM skill_shares WHERE user_id = ? AND item_type = ? AND slug = ?', u.id, row.item_type, row.slug);
      const id = existing?.id || newId('shr_');
      if (existing) ctx.store.update('skill_shares', id, { ...row, status, review, updated_at: now() });
      else ctx.store.insert('skill_shares', { id, user_id: u.id, ...row, status, review, created_at: now(), updated_at: now() });
      ctx.audit(u.id, direct ? 'market.shared' : 'market.share_submitted', { type: row.item_type, slug: row.slug });
      if (!direct) {
        const what = row.item_type === 'bot' ? 'een bot-sjabloon' : 'een skill';
        for (const r of reviewers()) ctx.events.emit(r.id, 'notification', { title: `Ter beoordeling: ${row.title}`, body: `${u.name} wil ${what} delen met iedereen op deze server. Bekijk de scan en de inhoud voordat anderen het zien.`, link: '#/m/skills/meldingen', kind: 'warning' });
      }
      return { ok: true, id, status };
    }),
  );

  /** Shares waiting for review, with the scan and what is in them (owner/admin). */
  api.get(
    '/skills/shares/review',
    ah(async (req) => {
      const u = user(req);
      if (!reviewer(u.role)) throw notFound('Niet gevonden');
      const names = new Map(ctx.store.users().map((x) => [x.id, x.name]));
      return ctx.store.find<any>('skill_shares', { status: 'pending' }, { order: 'updated_at ASC', limit: 200 }).map((r) => {
        // Shared files: { path: text | { base64 } } (mapToFiles).
        const entries: [string, any][] = r.data?.files && typeof r.data.files === 'object' ? Object.entries(r.data.files) : [];
        const files = entries.map(([p, c]) => ({ path: p, content: typeof c === 'string' ? c : '', size: typeof c === 'string' ? Buffer.byteLength(c) : Math.floor(String(c?.base64 || '').length * 0.75) }));
        const skillMd = files.find((f) => f.path === 'SKILL.md')?.content;
        const t = r.data?.template || {};
        return {
          id: r.id,
          item_type: r.item_type,
          title: r.title,
          description: r.description,
          version: r.version,
          by: names.get(r.user_id) || 'Gebruiker',
          submitted_at: r.review?.submitted_at || r.updated_at,
          scan: r.review?.scan || null,
          license: r.data?.license || '',
          skillMd: typeof skillMd === 'string' ? skillMd.slice(0, 60_000) : undefined,
          files: files.map((f) => ({ path: f.path, size: f.size })).slice(0, 200),
          bot: r.item_type === 'bot' ? { role: String(t.role || ''), instructions: String(t.instructions || '').slice(0, 60_000), access_mode: String(t.access_mode || ''), tool_groups: Array.isArray(t.tool_groups) ? t.tool_groups : [], skills: Array.isArray(t.skills) ? t.skills.map((x: any) => String(x?.name || x)).slice(0, 50) : [] } : undefined,
        };
      });
    }),
  );

  api.post(
    '/skills/shares/:id/review',
    ah(async (req) => {
      const u = user(req);
      if (!reviewer(u.role)) throw notFound('Niet gevonden');
      const r = ctx.store.get<any>('skill_shares', String(req.params.id));
      if (!r) throw notFound('Niet gevonden');
      if (r.status !== 'pending') throw bad('Dit item is al beoordeeld.');
      const approve = req.body?.decision === 'approve';
      if (!approve && req.body?.decision !== 'reject') throw bad('Kies goedkeuren of afwijzen');
      const reason = str(req.body?.reason, 500).trim();
      if (!approve && !reason) throw bad('Geef een korte reden, zodat de indiener weet wat er anders moet.');
      ctx.store.update('skill_shares', r.id, { status: approve ? 'approved' : 'rejected', review: { ...(r.review || {}), decided_by: u.id, decided_at: now(), reason: reason || undefined } });
      ctx.audit(u.id, approve ? 'market.share_approved' : 'market.share_rejected', { id: r.id, type: r.item_type, slug: r.slug, by: r.user_id, reason: reason || undefined });
      ctx.events.emit(r.user_id, 'notification', {
        title: approve ? `Gedeeld: ${r.title}` : `Niet gedeeld: ${r.title}`,
        body: approve ? 'Een beheerder keurde het goed; iedereen op deze server vindt het nu in de marktplaats.' : `Een beheerder keurde het af: ${reason}`,
        link: '#/m/skills/bronnen',
        kind: approve ? 'info' : 'warning',
      });
      return { ok: true, status: approve ? 'approved' : 'rejected' };
    }),
  );
  api.delete(
    '/skills/shares/:id',
    ah(async (req) => {
      const u = user(req);
      const r = ctx.store.get<any>('skill_shares', String(req.params.id));
      if (!r || (r.user_id !== u.id && u.role === 'member')) throw notFound('Niet gevonden');
      ctx.store.remove('skill_shares', r.id);
      ctx.audit(u.id, 'market.unshared', { id: r.id, by: r.user_id === u.id ? 'owner' : 'admin' });
      return { ok: true };
    }),
  );

  // =================== library ===================
  api.get(
    '/skills',
    ah(async (req) => {
      const u = user(req);
      const using = agentsUsing(u.id);
      // The owner sees every team's skills; ?teamId= shows what one team has (its own and those for all teams).
      const p = req.query.teamId ? lib.placementFor(u.id, str(req.query.teamId, 60)) : null;
      return lib.list(u.id, { teamId: p?.scope === 'team' ? p.teamId : undefined }).map((s) => summary(s, using));
    }),
  );

  api.get(
    '/skills/:id',
    ah(async (req) => {
      const u = user(req);
      const s = ownSkill(req);
      const v = lib.version(s)!;
      const using = agentsUsing(u.id);
      const item = s.catalog_ref ? findCatalogItem(u.id, s.catalog_ref) : null;
      return {
        ...summary(s, using),
        skillMd: lib.readSkillMd(s),
        meta: v.meta,
        warnings: v.warnings,
        scan: v.scan,
        permissions: v.permissions,
        files: v.scan.files.map((f) => ({ path: f.path, size: f.size, type: f.type })),
        versions: lib.versions(s).map((x) => versionView(s, x, v)),
        catalogItem: item ? { catalogId: item.catalogId, itemId: item.id, title: item.title, version: item.version, changelog: item.changelog, verified: item.verified, publisher: item.publisher, signature: itemSignature(item) } : null,
        draftAgent: s.draft_agent_id ? (ctx.store.agent(s.draft_agent_id)?.name ?? null) : null,
        nameConflict: s.status === 'draft' ? !!lib.existingFor(u.id, s.name, lib.placementOf(s)) : false,
      };
    }),
  );

  api.get(
    '/skills/:id/file',
    ah(async (req) => {
      const s = ownSkill(req);
      const rev = Number(req.query.rev) || s.active_rev;
      const rel = safeRelPath(str(req.query.path, 400));
      if (!rel) throw bad('Ongeldig pad');
      const buf = lib.readFile(s, rel, rev);
      if (!buf) throw notFound('Bestand niet gevonden');
      const type = fileType(rel, buf);
      const binary = type === 'executable' || type === 'binary' || isBinary(buf);
      return { path: rel, rev, type, size: buf.length, binary, text: binary ? null : buf.toString('utf8').slice(0, 500_000) };
    }),
  );

  api.get(
    '/skills/:id/download',
    ah(async (req, res) => {
      const u = user(req);
      const s = ownSkill(req);
      const rev = Number(req.query.rev) || s.active_rev;
      const ver = lib.version(s, rev);
      if (!ver) throw notFound('Versie niet gevonden');
      const files = lib.readFiles(s, rev);
      // An unchanged signed revision is downloaded as the original package (manifest included).
      if (ver.package?.state === 'signed' && ver.package.manifest) files.set(MANIFEST_FILE, Buffer.from(JSON.stringify(ver.package.manifest, null, 2) + '\n'));
      const buf = zipFiles(files, s.name);
      ctx.audit(u.id, 'skill.downloaded', { skill: s.name, rev });
      res.setHeader('content-type', 'application/zip');
      res.setHeader('content-disposition', `attachment; filename="${s.name}${s.version ? '-' + s.version.replace(/[^\w.-]/g, '') : ''}.zip"`);
      res.end(buf);
    }),
  );

  api.get(
    '/skills/:id/versions/:rev',
    ah(async (req) => {
      const s = ownSkill(req);
      const v = lib.version(s, Number(req.params.rev));
      if (!v) throw notFound('Versie niet gevonden');
      const active = lib.version(s);
      return { ...versionView(s, v, active), skillMd: lib.readSkillMd(s, v.rev), meta: v.meta, scan: v.scan, permissions: v.permissions, warnings: v.warnings };
    }),
  );

  api.post(
    '/skills/:id/versions/:rev/activate',
    ah(async (req) => {
      const u = user(req);
      const s = ownSkill(req);
      const rev = Number(req.params.rev);
      // A restricted member may only switch to a revision that the current publisher policy allows.
      const target = lib.version(s, rev);
      if (target && rev !== s.active_rev) {
        const d = decide(ctx, u, viewOfInfo(ctx, target.package));
        if (!d.allowed && !d.canOverride) throw new HttpError(403, d.reason || 'Niet toegestaan door het uitgeversbeleid.', 'policy-blocked');
      }
      const r = lib.activate(s, rev, req.body?.confirmPermissions === true);
      if (r.status === 'needs-confirmation') throw new HttpError(409, 'Deze versie vraagt meer rechten dan de huidige. Bekijk de wijzigingen en bevestig.', 'needs-confirmation');
      if (r.status === 'activated') {
        ctx.audit(u.id, 'skill.rev_activated', { skill: s.name, from: s.active_rev, to: rev, elevated: r.diff.elevated });
        emit(u.id, [s.id]);
      }
      return { ...r, skill: summary(lib.get(u.id, s.id)!) };
    }),
  );

  api.put(
    '/skills/:id/content',
    ah(async (req) => {
      const u = user(req);
      const s = ownSkill(req);
      assertMaySelfAuthor(ctx, u, 'skills bewerken');
      const b = req.body || {};
      const files = lib.readFiles(s);
      if (typeof b.skillMd === 'string') files.set('SKILL.md', Buffer.from(str(b.skillMd, 500_000), 'utf8'));
      if (b.files && typeof b.files === 'object') {
        for (const [p, c] of Object.entries<any>(b.files)) {
          const rel = safeRelPath(p);
          if (!rel) throw bad(`Ongeldig pad: ${p}`);
          if (rel === 'SKILL.md') continue;
          if (c === null) files.delete(rel);
          else files.set(rel, Buffer.from(str(c, LIMITS.maxFileBytes), 'utf8'));
        }
      }
      const a = analyze(files, s.name);
      if (a.errors.length) throw bad(a.errors[0]);
      // The user edits their own copy: explicit action, so it activates; trust follows the scripts checksum.
      const r = lib.addRevision(s, files, a, { source: { type: 'edit', label: 'Bewerkt' }, createdBy: 'user', note: str(b.note, 2000), activate: true, confirmPermissions: true });
      if (r.status !== 'unchanged') ctx.audit(u.id, 'skill.edited', { skill: a.parsed.meta.name, rev: r.rev, elevated: r.diff.elevated });
      emit(u.id, [s.id]);
      return { status: r.status, rev: r.rev, diff: r.diff, warnings: a.warnings, scan: { level: a.scan.level, labels: a.scan.labels } };
    }),
  );

  api.patch(
    '/skills/:id',
    ah(async (req) => {
      const u = user(req);
      const s = ownSkill(req);
      const b = req.body || {};
      if (b.pinned !== undefined) {
        lib.setPinned(s, !!b.pinned);
        ctx.audit(u.id, b.pinned ? 'skill.pinned' : 'skill.unpinned', { skill: s.name, rev: s.active_rev });
      }
      if (b.status !== undefined) {
        if (!['active', 'disabled'].includes(b.status)) throw bad('Ongeldige status');
        if (s.status === 'draft') throw bad('Publiceer het concept eerst');
        lib.setStatus(s, b.status);
        ctx.audit(u.id, 'skill.status', { skill: s.name, status: b.status });
      }
      // Another team, or "voor alle teams" ('*'): the owner's choice (package B4).
      if (b.teamId !== undefined) {
        const p = lib.placementFor(u.id, b.teamId === null ? '*' : b.teamId);
        const before = lib.teamOf(s);
        const moved = lib.setPlacement(lib.get(u.id, s.id)!, p);
        if (lib.teamOf(moved) !== before) ctx.audit(u.id, 'skill.team', { skill: s.name, from: before ?? '*', to: lib.teamOf(moved) ?? '*' });
      }
      emit(u.id, [s.id]);
      return summary(lib.get(u.id, s.id)!);
    }),
  );

  api.post(
    '/skills/:id/trust',
    ah(async (req) => {
      const u = user(req);
      const s = ownSkill(req);
      const trusted = req.body?.trusted === true;
      if (trusted && s.status === 'draft') throw bad('Publiceer het concept voordat je de scripts vertrouwt.');
      lib.setTrusted(s, trusted);
      ctx.audit(u.id, trusted ? 'skill.trusted' : 'skill.untrusted', { skill: s.name, rev: s.active_rev, scripts: lib.version(s)?.scan.scripts });
      emit(u.id, [s.id]);
      return summary(lib.get(u.id, s.id)!);
    }),
  );

  api.post(
    '/skills/:id/publish',
    ah(async (req) => {
      const u = user(req);
      const s = ownSkill(req);
      if (s.status !== 'draft') throw bad('Deze skill is geen concept.');
      assertMaySelfAuthor(ctx, u, 'eigen skills publiceren');
      const b = req.body || {};
      // A bot's draft lives in that bot's team (package B4); publishing it there meets that team's skill of the name.
      const existing = lib.existingFor(u.id, s.name, lib.placementOf(s));
      let target: SkillRow;
      if (existing) {
        if (b.mode !== 'update') throw new HttpError(409, `Je hebt al een skill "${s.name}". Hernoem het concept, of publiceer het als nieuwe versie van die skill.`, 'name-conflict');
        const files = lib.readFiles(s);
        const a = analyze(files, s.name);
        const r = lib.addRevision(existing, files, a, { source: s.source, createdBy: `draft:${s.id}`, note: `Concept van ${s.source?.label || 'bot'} gepubliceerd`, activate: !existing.pinned, confirmPermissions: b.confirmPermissions === true });
        if (r.status === 'needs-confirmation') throw new HttpError(409, 'Deze versie vraagt meer rechten dan de huidige. Bekijk de wijzigingen en bevestig.', 'needs-confirmation');
        lib.remove(s);
        target = r.skill;
      } else {
        lib.setStatus(s, 'active');
        target = lib.get(u.id, s.id)!;
      }
      const enable = Array.isArray(b.enableFor) ? b.enableFor.map(String) : [];
      for (const id of enable) {
        const a = ctx.store.agent(id);
        if (a && a.user_id === u.id && !(a.skills || []).includes(target.id)) lib.setAgentSkills(a, [...(a.skills || []), target.id]);
      }
      ctx.audit(u.id, 'skill.published', { skill: target.name, fromDraft: s.id, mode: existing ? 'update' : 'new' }, s.draft_agent_id);
      emit(u.id, [target.id, s.id]);
      return summary(lib.get(u.id, target.id)!);
    }),
  );

  api.delete(
    '/skills/:id',
    ah(async (req) => {
      const u = user(req);
      const s = ownSkill(req);
      lib.remove(s);
      ctx.audit(u.id, s.status === 'draft' ? 'skill.draft_discarded' : 'skill.deleted', { skill: s.name, checksum: s.checksum });
      ctx.events.emit(u.id, 'skills.deleted', { id: s.id });
      return { ok: true };
    }),
  );
}
