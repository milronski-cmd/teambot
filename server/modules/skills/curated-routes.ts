import { webErr } from './web-routes.js';
import path from 'node:path';
import type { Ctx } from '../../core/types.js';
import { HttpError, ah, bad, str, user } from '../../core/http.js';
import { type Placement, type SkillLibrary, type SkillRow, type SourceInfo, analyze } from './library.js';
import type { Importer } from './importer.js';
import { diffPermissions } from './scan.js';
import { skillSubstance } from './substance.js';
import { type CuratedSkill, type CuratedSource, CURATED_SOURCES, curatedId, curatedRef, parseCuratedRef } from './curated.js';
import { type RepoAccess, type Resolved, SOURCE_DIR, diffFiles, resolveSkill, upstreamChanges } from './curated-source.js';
import { checkPublisher } from './import-rules.js';
import { isOffline } from './webcache.js';
import type { WebCache } from './webcache.js';

/**
 * TeamBot's own skill catalogue (see curated.ts). Routes under /api/skills/curated:
 *   GET  /skills/curated                 the catalogue (no network): sources, items, install and update state
 *   GET  /skills/curated/item?id=        one skill at its pinned commit: files, licence, scan, what was left out
 *   POST /skills/curated/install         { id, teamId?, enableFor?, acknowledge? } install the pinned version for one
 *                                        team (default: the default team) or for all teams (teamId '*')
 *   POST /skills/curated/check-updates   { force?, teamId? } compare installed skills with the catalogue and the source
 *   GET  /skills/curated/diff?skillId=&commit=   what an update changes, file by file
 *   POST /skills/curated/update          { skillId, commit, acknowledge?, confirmPermissions? } apply after approval
 * Nothing is ever updated by itself.
 */

export interface CuratedItem {
  id: string;
  source: CuratedSource;
  skill: CuratedSkill;
}

/**
 * PARITEIT 7.3: TeamBot's catalogue pins a newer commit than the installed version (it came with a TeamBot update).
 * Known without any network; `changes` (the skill's files that differ) once the tree of the new pin was read.
 */
export interface PinUpdate {
  skillId: string;
  id: string;
  name: string;
  teamName: string;
  from: string;
  to: string;
  toDate: string;
  /** The catalogue's own sentence about this pin (curated.ts `pinNote`). */
  note: string;
  changes: string[];
  changesKnown: boolean;
}

interface UpdateNote {
  skillId: string;
  id: string;
  name: string;
  from: string;
  to: string;
  /** 'catalogus': a newer TeamBot catalogue pins a newer commit; 'bron': the source moved on. */
  origin: 'catalogus' | 'bron';
  changes: string[];
  checkedAt: string;
}

const short = (c: string | null | undefined) => (c ? c.slice(0, 7) : '');

export function githubTreeUrl(repo: string, commit: string, p: string) {
  return `https://github.com/${repo}/tree/${commit}${p ? '/' + p.split('/').map(encodeURIComponent).join('/') : ''}`;
}

export class CuratedCatalog {
  sources: CuratedSource[] = CURATED_SOURCES;

  constructor(
    private ctx: Ctx,
    private lib: SkillLibrary,
    private importer: Importer,
    private access: (userId: string) => RepoAccess,
    private cache: WebCache,
  ) {}

  items(): CuratedItem[] {
    return this.sources.flatMap((source) => source.skills.map((skill) => ({ id: curatedId(source, skill), source, skill })));
  }
  item(id: string): CuratedItem | null {
    return this.items().find((i) => i.id === id) || null;
  }

  /**
   * Installed catalogue skills of a user by catalogue id. With `teamId`: what that team has (its own install first,
   * then one for all teams); without: any install (one for all teams first).
   */
  installed(userId: string, teamId?: string | null): Map<string, SkillRow> {
    const m = new Map<string, SkillRow>();
    for (const s of this.lib.list(userId, { teamId: teamId || undefined })) {
      const id = parseCuratedRef(s.catalog_ref);
      if (!id || s.status === 'draft') continue;
      const prev = m.get(id);
      if (!prev || (teamId ? this.lib.teamOf(s) === teamId : this.lib.teamOf(s) === null)) m.set(id, s);
    }
    return m;
  }

  /** Per catalogue id, every install with its team (null = for all teams): the owner's view of all teams. */
  installs(userId: string): Map<string, { skillId: string; teamId: string | null; teamName: string }[]> {
    const m = new Map<string, { skillId: string; teamId: string | null; teamName: string }[]>();
    for (const s of this.lib.list(userId)) {
      const id = parseCuratedRef(s.catalog_ref);
      if (!id || s.status === 'draft') continue;
      const team = this.lib.teamOf(s);
      m.set(id, [...(m.get(id) || []), { skillId: s.id, teamId: team, teamName: this.lib.teamName(team) }]);
    }
    return m;
  }

  private updatesKey = (userId: string) => `curated-updates:${userId}`;
  updateNotes(userId: string): UpdateNote[] {
    const hit = this.cache.peek<UpdateNote[]>(this.updatesKey(userId));
    return Array.isArray(hit?.data) ? hit!.data : [];
  }
  /** Per team (package B4): a check of one team's skills replaces only their notes; another team's notes stay. */
  private saveNotes(userId: string, notes: UpdateNote[], checked?: Set<string>) {
    const keep = checked ? this.updateNotes(userId).filter((n) => !checked.has(n.skillId)) : [];
    this.cache.put(this.updatesKey(userId), [...keep, ...notes]);
  }

  /**
   * Update state of one installed skill: as the last check found it (a check is always started by the owner), else a
   * newer pin in TeamBot's own catalogue, which needs no check (and no network) at all.
   */
  updateFor(row: SkillRow, notes = this.updateNotes(row.user_id)): { to: string; origin: 'catalogus' | 'bron'; changes: string[]; checkedAt: string; pin?: { toDate: string; note: string; changesKnown: boolean } } | null {
    const note = notes.find((n) => n.skillId === row.id && n.from === (row.source?.commit || ''));
    if (note) return { to: note.to, origin: note.origin, changes: note.changes, checkedAt: note.checkedAt };
    const p = this.pinUpdate(row);
    return p ? { to: p.to, origin: 'catalogus', changes: p.changes, checkedAt: '', pin: { toDate: p.toDate, note: p.note, changesKnown: p.changesKnown } } : null;
  }

  /**
   * Changed files per install and pin, once the new pin's tree was read ([] = nothing of this skill changed). Kept in
   * the web cache (a commit never changes), so a restart does not bring back a notice that was already ruled out.
   */
  private pinChanges = {
    key: (k: string) => `curated-pin:${k}`,
    get: (k: string): string[] | undefined => {
      const hit = this.cache.peek<string[]>(this.pinChanges.key(k));
      return Array.isArray(hit?.data) ? hit!.data : undefined;
    },
    set: (k: string, changes: string[]) => this.cache.put(this.pinChanges.key(k), changes),
  };

  /** A newer catalogue pin for this install, or null (also when the new pin is known to change none of its files). */
  pinUpdate(row: SkillRow): PinUpdate | null {
    const id = parseCuratedRef(row.catalog_ref);
    const it = id ? this.item(id) : null;
    if (!it || row.status === 'draft') return null;
    const cur = this.lib.version(row)?.source || row.source;
    const from = cur?.commit || '';
    const src = it.source;
    // Only a pin TeamBot shipped after this version was installed (as in checkUpdates).
    if (!from || src.commit === from || src.commit === cur?.catalogCommit) return null;
    const known = this.pinChanges.get(`${row.id}:${src.commit}`);
    if (known && !known.length) return null;
    const team = this.lib.teamOf(row);
    return {
      skillId: row.id,
      id: it.id,
      name: row.name,
      teamName: this.lib.teamName(team),
      from,
      to: src.commit,
      toDate: src.commitDate,
      note: src.pinNote || '',
      changes: known || [],
      changesKnown: !!known,
    };
  }

  /**
   * Every newer catalogue pin of a user's installs, with what changed in each skill: the tree of the new pin is read
   * once (kept for a year: a commit never changes) when the owner opens Mijn skills. Offline: the notice without files.
   */
  async pinUpdates(userId: string): Promise<PinUpdate[]> {
    const out: PinUpdate[] = [];
    for (const row of this.lib.list(userId)) {
      if (!parseCuratedRef(row.catalog_ref)) continue;
      let p = this.pinUpdate(row);
      if (!p) continue;
      if (!p.changesKnown && !isOffline()) {
        const it = this.item(p.id)!;
        try {
          const tree = await this.access(userId).tree(it.source.repo, p.to);
          const cur = this.lib.version(row)?.source || row.source;
          this.pinChanges.set(`${row.id}:${p.to}`, upstreamChanges(cur?.seen || {}, it.skill, tree).slice(0, 30));
          p = this.pinUpdate(row);
        } catch {
          /* not reachable now: the notice stays, without the list of files */
        }
      }
      if (p) out.push(p);
    }
    return out;
  }

  /** Short view for Mijn skills. */
  badge(row: SkillRow) {
    const id = parseCuratedRef(row.catalog_ref);
    if (!id) return null;
    const it = this.item(id);
    return {
      id,
      repo: row.source?.repo || it?.source.repo || '',
      commit: row.source?.commit || null,
      license: row.source?.license || null,
      publisher: row.source?.publisher || it?.source.publisher || '',
      inCatalog: !!it,
      update: this.updateFor(row),
    };
  }

  card(it: CuratedItem, inst?: SkillRow, notes?: UpdateNote[], installs?: { skillId: string; teamId: string | null; teamName: string }[]) {
    const { source, skill } = it;
    const pub = checkPublisher(source.owner, source.repo.split('/')[1]);
    return {
      id: it.id,
      name: path.posix.basename(skill.path) || source.id,
      note: skill.note,
      pack: skill.pack,
      category: skill.category,
      sourceId: source.id,
      repo: source.repo,
      path: skill.path,
      publisher: source.publisher,
      owner: source.owner,
      publisherStatus: pub.status,
      license: source.license,
      commit: source.commit,
      commitDate: source.commitDate,
      verifiedAt: source.verifiedAt,
      url: githubTreeUrl(source.repo, source.commit, skill.path),
      scripts: !!skill.scripts,
      windows: skill.windows || null,
      needs: skill.needs || '',
      installed: inst ? { skillId: inst.id, status: inst.status, commit: inst.source?.commit || null, version: inst.version, trusted: this.lib.isTrusted(inst), update: this.updateFor(inst, notes), teamId: this.lib.teamOf(inst), teamName: this.lib.teamName(this.lib.teamOf(inst)) } : null,
      /** Every install of this skill with its team (package B4; on the owner's view of all teams). */
      ...(installs ? { installs } : {}),
    };
  }

  sourceInfo(it: CuratedItem, r: Resolved, version: string): SourceInfo {
    const { source, skill } = it;
    return {
      type: 'curated',
      label: `${source.repo}${skill.path ? '/' + skill.path : ''}`,
      url: githubTreeUrl(source.repo, r.commit, skill.path),
      catalogId: 'curated',
      itemId: it.id,
      version: version || short(r.commit),
      // Source, licence and version checked by TeamBot (not the content line by line).
      verified: true,
      publisher: source.publisher,
      repo: source.repo,
      commit: r.commit,
      commitDate: r.commit === source.commit ? source.commitDate : undefined,
      // The catalogue's own pin at this moment: only a pin TeamBot ships later counts as a catalogue update.
      catalogCommit: source.commit,
      license: r.license.spdx || undefined,
      licenseFile: r.license.file || undefined,
      root: skill.root ?? '',
      seen: r.seen,
      dropped: r.dropped.slice(0, 50),
    };
  }

  async resolve(userId: string, it: CuratedItem, commit: string): Promise<Resolved> {
    try {
      return await resolveSkill(this.access(userId), it.source, it.skill, commit);
    } catch (e) {
      webErr(e);
    }
  }

  /** Stage a resolved version for the regular review rules (scan, permissions, policy). */
  stage(userId: string, it: CuratedItem, r: Resolved, placement: Placement) {
    const meta = analyze(r.files, path.posix.basename(it.skill.path) || it.source.id).parsed.meta;
    // Per team (package B4): a same-named skill from another source in this team (or for all teams) is never
    // overwritten, and installing for all teams while a team has its own copy is refused (one name per team).
    const existing = meta.name ? this.lib.existingFor(userId, meta.name, placement) : null;
    const clash = meta.name ? existing || this.lib.nameConflict(userId, meta.name, placement) : null;
    if (clash && (clash.catalog_ref !== curatedRef(it.id) || !existing)) {
      throw new HttpError(409, `Je hebt al een skill met de naam "${meta.name}"${this.lib.whereText(clash)}${clash.source?.label ? ` (uit ${clash.source.label})` : ''}. Verwijder of hernoem die eerst; TeamBot overschrijft hem niet.`);
    }
    const st = this.importer.stage(userId, `${it.source.repo}${it.skill.path ? '/' + it.skill.path : ''}`, [
      { files: r.files, root: '', source: this.sourceInfo(it, r, meta.version), fallbackName: meta.name || it.source.id, catalogRef: curatedRef(it.id) },
    ]);
    return this.importer.place(st, placement);
  }

  /** Compare installed catalogue skills with newer versions; with `teamId` only what that team has (other notes stay). */
  async checkUpdates(userId: string, force: boolean, teamId?: string | null) {
    const inst: [string, SkillRow][] = [];
    for (const s of this.lib.list(userId, { teamId: teamId || undefined })) {
      const id = parseCuratedRef(s.catalog_ref);
      if (id && s.status !== 'draft') inst.push([id, s]);
    }
    const notes: UpdateNote[] = [];
    const errors: { repo: string; error: string }[] = [];
    const checkedAt = new Date().toISOString();
    const bySource = new Map<string, { it: CuratedItem; row: SkillRow }[]>();
    for (const [id, row] of inst) {
      const it = this.item(id);
      if (!it) continue;
      bySource.set(it.source.id, [...(bySource.get(it.source.id) || []), { it, row }]);
    }
    let checked = 0;
    for (const list of bySource.values()) {
      const src = list[0].it.source;
      const access = this.access(userId);
      let latest: string | null = null;
      try {
        const h = await access.head(src.repo, force);
        latest = h.commit;
        if (!latest && h.error) errors.push({ repo: src.repo, error: h.error });
      } catch (e: any) {
        errors.push({ repo: src.repo, error: String(e?.message || e).slice(0, 300) });
      }
      for (const { it, row } of list) {
        checked++;
        const cur = this.lib.version(row)?.source || row.source;
        const from = cur?.commit || '';
        const seen = cur?.seen || {};
        // A newer pin in TeamBot's catalogue first (checked by TeamBot), else the source itself. A pin counts only when
        // TeamBot shipped it after this version was installed: after taking the source's newer commit, the older pin is
        // no update.
        const candidates: { commit: string; origin: UpdateNote['origin'] }[] = [];
        if (src.commit !== from && src.commit !== cur?.catalogCommit) candidates.push({ commit: src.commit, origin: 'catalogus' });
        if (latest && latest !== from && latest !== src.commit) candidates.push({ commit: latest, origin: 'bron' });
        for (const c of candidates) {
          try {
            const tree = await access.tree(src.repo, c.commit);
            const changes = upstreamChanges(seen, it.skill, tree);
            if (c.origin === 'catalogus') this.pinChanges.set(`${row.id}:${c.commit}`, changes.slice(0, 30));
            if (changes.length) {
              notes.push({ skillId: row.id, id: it.id, name: row.name, from, to: c.commit, origin: c.origin, changes: changes.slice(0, 30), checkedAt });
              break;
            }
          } catch (e: any) {
            errors.push({ repo: src.repo, error: String(e?.message || e).slice(0, 300) });
            break;
          }
        }
      }
    }
    this.saveNotes(userId, notes, teamId ? new Set(inst.map(([, r]) => r.id)) : undefined);
    return { checked, updates: notes, errors, offline: isOffline() };
  }
}

export function curatedRoutes(d: { ctx: Ctx; lib: SkillLibrary; importer: Importer; catalog: CuratedCatalog; isBlocked?: (type: string, catalogId: string, itemId: string) => boolean }) {
  const { ctx, lib, importer, catalog } = d;
  const api = ctx.api;
  const blocked = (id: string) => !!d.isBlocked?.('skill', 'curated', id);
  const itemOr404 = (id: unknown) => {
    const it = catalog.item(str(id, 300));
    if (!it) throw new HttpError(404, 'Deze skill staat niet in de TeamBot-catalogus.');
    if (blocked(it.id)) throw new HttpError(403, 'Dit item is door de beheerder geblokkeerd.');
    return it;
  };
  const ownCurated = (userId: string, skillId: unknown) => {
    const row = lib.get(userId, str(skillId, 100));
    if (!row) throw new HttpError(404, 'Skill niet gevonden');
    const id = parseCuratedRef(row.catalog_ref);
    const it = id ? catalog.item(id) : null;
    if (!it) throw new HttpError(400, 'Deze skill komt niet uit de TeamBot-catalogus.');
    return { row, it };
  };
  const assertCommit = (c: unknown) => {
    const s = str(c, 60).trim();
    if (!/^[0-9a-f]{40}$/.test(s)) throw bad('Ongeldige commit.');
    return s;
  };
  const stagingView = (userId: string, id: string) => {
    try {
      return importer.view(userId, importer.get(userId, id));
    } catch {
      return null;
    }
  };

  api.get(
    '/skills/curated',
    ah(async (req) => {
      const u = user(req);
      // Per team (package B4): ?teamId= shows what that team has; without it, every install with its team.
      const teamId = req.query.teamId ? lib.placementFor(u.id, str(req.query.teamId, 60)) : null;
      const team = teamId && teamId.scope === 'team' ? teamId.teamId : null;
      const inst = catalog.installed(u.id, team);
      const all = team ? null : catalog.installs(u.id);
      const notes = catalog.updateNotes(u.id);
      const items = catalog.items().filter((i) => !blocked(i.id)).map((i) => catalog.card(i, inst.get(i.id), notes, all?.get(i.id)));
      return {
        sources: catalog.sources.map((s) => ({ id: s.id, repo: s.repo, publisher: s.publisher, owner: s.owner, license: s.license, commit: s.commit, commitDate: s.commitDate, verifiedAt: s.verifiedAt, note: s.note, url: githubTreeUrl(s.repo, s.commit, ''), skills: s.skills.length })),
        packs: [...new Set(items.map((i) => i.pack))],
        items,
        offline: isOffline(),
      };
    }),
  );

  api.get(
    '/skills/curated/item',
    ah(async (req) => {
      const u = user(req);
      const it = itemOr404(req.query.id);
      const inst = catalog.installed(u.id).get(it.id);
      const commit = req.query.commit ? assertCommit(req.query.commit) : it.source.commit;
      const r = await catalog.resolve(u.id, it, commit);
      const a = analyze(r.files, path.posix.basename(it.skill.path) || it.source.id);
      const md = r.files.get('SKILL.md')?.toString('utf8') || '';
      return {
        ...catalog.card(it, inst),
        commitShown: r.commit,
        meta: a.parsed.meta,
        errors: a.errors,
        warnings: a.warnings,
        skillMd: md.length > 200_000 ? md.slice(0, 200_000) : md,
        scan: { level: a.scan.level, kind: a.scan.kind, labels: a.scan.labels, findings: a.scan.findings, files: a.scan.files.map((f) => ({ path: f.path, size: f.size, type: f.type })), domains: a.scan.domains },
        permissions: a.permissions,
        files: a.scan.files.map((f) => ({ path: f.path, size: f.size, type: f.type })),
        size: a.size,
        checksum: r.checksum,
        licenseFound: r.license,
        dropped: r.dropped,
        refused: r.refused,
        sourceFiles: r.sourceFiles,
        sourceDir: SOURCE_DIR,
        description: r.description,
        problems: r.problems,
        installable: !r.problems.length && !a.errors.length,
        substance: skillSubstance(md, [...r.files.keys()], a.parsed.meta.name),
      };
    }),
  );

  api.post(
    '/skills/curated/install',
    ah(async (req) => {
      const u = user(req);
      const b = req.body || {};
      const it = itemOr404(b.id);
      // For one team (the chosen one; default the default team) or for all teams (teamId '*'): package B4.
      const placement = lib.placementFor(u.id, b.teamId);
      const team = placement.scope === 'team' ? placement.teamId : null;
      const already = catalog.installed(u.id, team ?? undefined).get(it.id);
      if (already && (placement.scope === 'team' || lib.teamOf(already) === null)) return { status: 'installed', skillId: already.id, name: already.name, teamId: lib.teamOf(already) };
      const r = await catalog.resolve(u.id, it, it.source.commit);
      if (r.problems.length) throw new HttpError(422, `Deze skill voldoet niet aan de importregels van TeamBot: ${r.problems.slice(0, 5).join(' · ')}`, 'import-rules');
      const st = catalog.stage(u.id, it, r, placement);
      const res = importer.commit(u.id, st.id, {
        acknowledge: b.acknowledge === true,
        enableFor: Array.isArray(b.enableFor) ? b.enableFor.map(String) : [],
        overridePolicy: b.overridePolicy === true,
        createdBy: 'catalogus',
        placement,
      });
      const first = res.results[0] || { status: 'error', error: 'Niets geïnstalleerd.' };
      if (first.status === 'created') {
        ctx.audit(u.id, 'skill.curated_installed', { id: it.id, repo: it.source.repo, commit: r.commit, license: r.license.spdx, dropped: r.dropped.length, teamId: team ?? '*' });
        return { status: 'created', skillId: first.skillId, name: first.name, commit: r.commit, license: r.license.spdx, dropped: r.dropped, teamId: team ?? '*', ...(res.notEnabled ? { notEnabled: res.notEnabled } : {}) };
      }
      // Something to confirm (warnings, policy) or an error: the regular review shows it.
      return { status: first.status, error: first.error || null, staging: stagingView(u.id, st.id) };
    }),
  );

  // PARITEIT 7.3: newer pins in TeamBot's catalogue for what you installed, with what changed. Updating stays a click.
  api.get(
    '/skills/curated/pin-updates',
    ah(async (req) => {
      const u = user(req);
      return { updates: await catalog.pinUpdates(u.id), offline: isOffline() };
    }),
  );

  api.post(
    '/skills/curated/check-updates',
    ah(async (req) => {
      const u = user(req);
      const p = req.body?.teamId ? lib.placementFor(u.id, req.body.teamId) : null;
      return catalog.checkUpdates(u.id, req.body?.force === true, p?.scope === 'team' ? p.teamId : null);
    }),
  );

  api.get(
    '/skills/curated/diff',
    ah(async (req) => {
      const u = user(req);
      const { row, it } = ownCurated(u.id, req.query.skillId);
      const commit = assertCommit(req.query.commit);
      const r = await catalog.resolve(u.id, it, commit);
      const next = analyze(r.files, row.name);
      const cur = lib.version(row);
      const perms = diffPermissions(cur?.permissions, next.permissions);
      const files = diffFiles(lib.readFiles(row), r.files);
      return {
        skillId: row.id,
        name: row.name,
        id: it.id,
        repo: it.source.repo,
        from: { commit: row.source?.commit || null, version: row.version, url: row.source?.commit ? githubTreeUrl(it.source.repo, row.source.commit, it.skill.path) : null },
        to: { commit, version: next.parsed.meta.version, url: githubTreeUrl(it.source.repo, commit, it.skill.path), inCatalog: commit === it.source.commit },
        compare: row.source?.commit ? `https://github.com/${it.source.repo}/compare/${row.source.commit}...${commit}` : null,
        files,
        permissions: perms,
        scan: { level: next.scan.level, kind: next.scan.kind, labels: next.scan.labels, findings: next.scan.findings.filter((f) => f.severity !== 'info').slice(0, 30) },
        trustReset: lib.isTrusted(row) && !!next.scriptsChecksum && next.scriptsChecksum !== cur?.scripts_checksum,
        license: r.license,
        dropped: r.dropped,
        problems: r.problems,
        identical: !files.files.length,
      };
    }),
  );

  api.post(
    '/skills/curated/update',
    ah(async (req) => {
      const u = user(req);
      const b = req.body || {};
      const { row, it } = ownCurated(u.id, b.skillId);
      const commit = assertCommit(b.commit);
      const r = await catalog.resolve(u.id, it, commit);
      if (r.problems.length) throw new HttpError(422, `Deze versie voldoet niet aan de importregels van TeamBot: ${r.problems.slice(0, 5).join(' · ')}`, 'import-rules');
      const newName = analyze(r.files, row.name).parsed.meta.name;
      if (newName !== row.name) throw new HttpError(409, `De skill heet in deze versie anders (${newName}); TeamBot werkt hem daarom niet bij. Installeer de nieuwe versie apart als je hem wilt.`);
      // The update goes to this install, in its own team (another team's copy of the skill is not touched).
      const placement = lib.placementOf(row);
      const st = catalog.stage(u.id, it, r, placement);
      const res = importer.commit(u.id, st.id, {
        acknowledge: b.acknowledge === true,
        confirmPermissions: b.confirmPermissions === true,
        overridePolicy: b.overridePolicy === true,
        createdBy: 'catalogus-update',
        placement,
      });
      const first = res.results[0] || { status: 'error', error: 'Niets bijgewerkt.' };
      if (['updated', 'version-added', 'unchanged'].includes(first.status)) {
        ctx.audit(u.id, 'skill.curated_updated', { id: it.id, from: row.source?.commit || null, to: commit, status: first.status });
        return { ...first, commit };
      }
      return { ...first, staging: stagingView(u.id, st.id) };
    }),
  );
}
