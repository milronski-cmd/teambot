import path from 'node:path';
import type { Ctx } from '../../core/types.js';
import { HttpError, ah, bad, str, user } from '../../core/http.js';
import { type Placement, type SkillLibrary, type SkillRow, type SourceInfo, analyze } from './library.js';
import type { Importer } from './importer.js';
import { safeRelPath } from './files.js';
import { diffPermissions } from './scan.js';
import { skillSubstance } from './substance.js';
import { type CuratedSkill, type CuratedSource, CURATED_SOURCES, curatedId, curatedRef, parseCuratedRef } from './curated.js';
import { type RepoAccess, type Resolved, SOURCE_DIR, clawhubAccess, diffFiles, resolveSkill, upstreamChanges } from './curated-source.js';
import { checkPublisher } from './import-rules.js';
import { isOffline } from './webcache.js';
import type { WebCache } from './webcache.js';
import type { OpenCard, OpenHit, OpenSection, OpenSort } from '../../../shared/skills.js';
import { type OpenPage, type WebSkills, CLAWHUB, VERSION_RE, clawRef, parseClawRef, parseWebRef, webErr, webRef } from './websource.js';

/**
 * The marketplace's skills from GitHub: TeamBot's own checked catalogue (see curated.ts) and, through the same install
 * path, everything else that is public (an open result: `github/<owner>/<repo>[/<folder>]`, not checked by TeamBot).
 * Routes under /api/skills/curated:
 *   GET  /skills/curated                 the checked catalogue (no network): sources, items, install and update state
 *   GET  /skills/curated/item?id=        one skill at its pinned commit: files, licence, scan, what was left out
 *   POST /skills/curated/install         { id, teamId?, enableFor?, acknowledge? } install for one team (default: the
 *                                        default team) or for all teams (teamId '*'). A catalogue skill at the commit
 *                                        TeamBot pinned; an open result at the commit HEAD points to now, which is
 *                                        recorded as its pin. The same import rules, scan and review for both.
 *   POST /skills/curated/check-updates   { force?, teamId? } compare installed skills with the catalogue and the source
 *   GET  /skills/curated/diff?skillId=&commit=   what an update changes, file by file
 *   POST /skills/curated/update          { skillId, commit, acknowledge?, confirmPermissions? } apply after approval
 * Nothing is ever updated by itself.
 */

export interface CuratedItem {
  id: string;
  source: CuratedSource;
  skill: CuratedSkill;
  /** Not in TeamBot's catalogue: a public skill that nobody at TeamBot looked at. */
  open?: boolean;
  /** Hosted by ClawHub instead of GitHub: `source.repo` is `<owner>/<slug>` there, and its pin is a version. */
  host?: 'clawhub';
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
const lower = (s: string) => s.toLowerCase();
/** The name of a skill before its SKILL.md is read: its folder, or (a skill in the root) its source. */
const folderName = (it: CuratedItem) => path.posix.basename(it.skill.path) || (it.open ? it.source.repo.split('/')[1] : it.source.id);

/** Where a skill can be looked at with its source: the folder at its commit on GitHub, or its page on ClawHub. */
export function itemUrl(it: CuratedItem, commit: string) {
  return it.host === 'clawhub' ? `${CLAWHUB}/${it.source.repo}` : githubTreeUrl(it.source.repo, commit, it.skill.path);
}

export function githubTreeUrl(repo: string, commit: string, p: string) {
  return `https://github.com/${repo}${commit || p ? `/tree/${commit || 'HEAD'}${p ? '/' + p.split('/').map(encodeURIComponent).join('/') : ''}` : ''}`;
}

const LEVELS = ['ok', 'info', 'warn', 'danger'];
/**
 * The analysis of a resolved skill. The safety scan reads SKILL.md as the source wrote it: the import rules put the
 * description between quotes, and the scan rates a sentence between quotes as a quotation (lower). What the source
 * wrote decides, so "negeer alle eerdere instructies" in a description stays a serious finding.
 */
export function analysisOf(r: Resolved, name: string) {
  const a = analyze(r.files, name);
  if (r.sourceMd) {
    const before = analyze(new Map([...r.files, ['SKILL.md', r.sourceMd]]), name);
    if (LEVELS.indexOf(before.scan.level) > LEVELS.indexOf(a.scan.level)) a.scan = { ...a.scan, level: before.scan.level, findings: before.scan.findings, labels: before.scan.labels };
  }
  // A warning of the library that hosts the skill is a serious finding of its own: adding asks first and shows it.
  if (r.sourceWarning) a.scan = { ...a.scan, level: 'danger', findings: [{ severity: 'danger', kind: 'hidden', file: '', message: `De bibliotheek waar deze skill staat waarschuwt ervoor: ${r.sourceWarning}` }, ...a.scan.findings] };
  return a;
}

/** The calm sentence for a reached search limit: when it works again, and what still works meanwhile. */
export function limitText(until: number) {
  const at = new Date(until).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  return `GitHub laat even geen nieuwe zoekopdrachten toe (zonder token 10 per minuut). Vanaf ${at} kan het weer. Wat je al zag blijft staan; de gecontroleerde skills en toevoegen werken gewoon.`;
}

export class CuratedCatalog {
  sources: CuratedSource[] = CURATED_SOURCES;

  constructor(
    private ctx: Ctx,
    private lib: SkillLibrary,
    private importer: Importer,
    private access: (userId: string) => RepoAccess,
    private cache: WebCache,
    /** The open sources (GitHub search, the skill directory): what is not in the catalogue. */
    private web?: WebSkills,
  ) {}

  private claw?: RepoAccess;
  /** How a skill's source is read: GitHub (a commit), or ClawHub (a version of the skill). */
  private reader(userId: string, it: CuratedItem): RepoAccess {
    if (it.host !== 'clawhub') return this.access(userId);
    return (this.claw ??= clawhubAccess(this.cache, {
      origin: CLAWHUB,
      head: async (name, force) => {
        const k = await this.web?.clawhubSkill(name, { force });
        return { commit: k?.version || null, error: k?.error || (k ? null : 'ClawHub is hier niet beschikbaar.') };
      },
    }));
  }

  /** The checked catalogue. */
  items(): CuratedItem[] {
    return this.sources.flatMap((source) => source.skills.map((skill) => ({ id: curatedId(source, skill), source, skill })));
  }
  /** The catalogue in the order of the marketplace: most-starred source first; within a source as listed. */
  sorted(): CuratedItem[] {
    return this.items()
      .map((it, i) => ({ it, i }))
      .sort((a, b) => (b.it.source.stars || 0) - (a.it.source.stars || 0) || a.i - b.i)
      .map((x) => x.it);
  }
  /**
   * A skill by id: one of the catalogue, or any folder of a public GitHub repository (`github/<owner>/<repo>[/<folder>]`,
   * marked `open`). An open id of a folder that is in the catalogue gives the catalogue's entry (with its pin).
   */
  item(id: string): CuratedItem | null {
    const all = this.items();
    const hit = all.find((i) => i.id === id);
    if (hit) return hit;
    const c = parseClawRef(id);
    if (c) {
      return { id: clawRef(c.owner, c.slug), open: true, host: 'clawhub', source: { id: clawRef(c.owner, c.slug), repo: `${c.owner}/${c.slug}`, commit: '', commitDate: '', owner: c.owner, publisher: c.owner, license: '', verifiedAt: '', note: '', skills: [] }, skill: { path: '', pack: '', note: '', category: '' } };
    }
    const o = parseWebRef(id);
    if (!o || (o.path && safeRelPath(o.path) !== o.path)) return null;
    const listed = all.find((i) => lower(i.source.repo) === lower(o.repo) && i.skill.path === o.path);
    if (listed) return listed;
    const owner = o.repo.split('/')[0];
    return {
      id: webRef(o.repo, o.path),
      open: true,
      source: { id: `github/${o.repo}`, repo: o.repo, commit: '', commitDate: '', owner, publisher: owner, license: '', verifiedAt: '', note: '', skills: [] },
      skill: { path: o.path, pack: '', note: '', category: '' },
    };
  }

  /**
   * What an install reference points to and the commit to take: a catalogue id (the commit TeamBot pinned), or
   * `github/<owner>/<repo>[/<folder or skill name>]` (the commit HEAD points to now; a repository without a folder
   * must hold exactly one skill), or `clawhub/<owner>/<slug>` (the latest version there).
   */
  async target(userId: string, ref: string): Promise<{ it: CuratedItem; commit: string }> {
    const listed = this.items().find((i) => i.id === ref);
    if (listed) return { it: listed, commit: listed.source.commit };
    const claw = parseClawRef(ref) ? this.item(ref) : null;
    if (claw) {
      const head = await this.reader(userId, claw).head(claw.source.repo);
      if (!head.commit) throw new HttpError(/niet gevonden/i.test(head.error || '') ? 404 : 502, `De versie van ${claw.source.repo} op ClawHub is nu niet vast te stellen${head.error ? `: ${head.error}` : '.'}`);
      return { it: claw, commit: head.commit };
    }
    const o = parseWebRef(ref);
    if (!o || !this.web) throw new HttpError(404, 'Deze skill staat niet in de marktplaats.');
    let found;
    try {
      found = await this.web.resolveOpen(o.repo, o.path, userId);
    } catch (e) {
      webErr(e);
    }
    const it = this.item(webRef(o.repo, found.path));
    if (!it) throw new HttpError(404, 'Deze skill staat niet in de marktplaats.');
    if (!it.open) return { it, commit: it.source.commit };
    if (!found.index.commit) throw new HttpError(502, `De versie van ${o.repo} is nu niet vast te stellen. Probeer het later opnieuw.`);
    return { it, commit: found.index.commit };
  }

  /**
   * Installed skills of a user by id (a catalogue id, or the open id of a skill from outside it). With `teamId`: what
   * that team has (its own install first, then one for all teams); without: any install (one for all teams first).
   */
  installed(userId: string, teamId?: string | null): Map<string, SkillRow> {
    const m = new Map<string, SkillRow>();
    for (const s of this.lib.list(userId, { teamId: teamId || undefined })) {
      const ref = parseCuratedRef(s.catalog_ref);
      if (!ref || s.status === 'draft') continue;
      const id = this.item(ref)?.id || ref;
      const prev = m.get(id);
      if (!prev || (teamId ? this.lib.teamOf(s) === teamId : this.lib.teamOf(s) === null)) m.set(id, s);
    }
    return m;
  }

  /** Per id, every install with its team (null = for all teams): the owner's view of all teams. */
  installs(userId: string): Map<string, { skillId: string; teamId: string | null; teamName: string }[]> {
    const m = new Map<string, { skillId: string; teamId: string | null; teamName: string }[]>();
    for (const s of this.lib.list(userId)) {
      const ref = parseCuratedRef(s.catalog_ref);
      if (!ref || s.status === 'draft') continue;
      const id = this.item(ref)?.id || ref;
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
    if (!it || it.open || row.status === 'draft') return null;
    const cur = this.lib.version(row)?.source || row.source;
    const from = cur?.commit || '';
    const src = it.source;
    // Only a pin TeamBot shipped after this version was installed (as in checkUpdates); a version taken from the source
    // before TeamBot listed the skill follows the source, not the catalogue.
    if (!from || cur?.type !== 'curated' || src.commit === from || src.commit === cur?.catalogCommit) return null;
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
      id: it?.id || id,
      repo: row.source?.repo || it?.source.repo || '',
      commit: row.source?.commit || null,
      license: row.source?.license || null,
      publisher: row.source?.publisher || it?.source.publisher || '',
      /** In TeamBot's checked catalogue (false: a skill from the open search, or one that left the catalogue). */
      inCatalog: !!it && !it.open,
      update: this.updateFor(row),
    };
  }

  card(it: CuratedItem, inst?: SkillRow, notes?: UpdateNote[], installs?: { skillId: string; teamId: string | null; teamName: string }[]) {
    const { source, skill } = it;
    const pub = checkPublisher(source.owner, source.repo.split('/')[1]);
    return {
      id: it.id,
      name: folderName(it),
      note: skill.note,
      pack: skill.pack,
      category: skill.category,
      sourceId: source.id,
      repo: source.repo,
      path: skill.path,
      publisher: source.publisher,
      owner: source.owner,
      publisherStatus: pub.status,
      publisherNote: pub.reason || '',
      /** Checked by TeamBot (source, licence, pinned version); false for an open result. */
      checked: !it.open,
      stars: source.stars || (it.open ? this.web?.peekRepoMeta(source.repo)?.stars : 0) || 0,
      license: source.license,
      commit: source.commit,
      commitDate: source.commitDate,
      verifiedAt: source.verifiedAt,
      url: itemUrl(it, source.commit),
      /** Where it comes from, for the page of the skill. */
      host: it.host || 'github',
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
      // An open result is recorded as what it is: from GitHub or ClawHub, not from TeamBot's catalogue, checked by nobody.
      type: it.host === 'clawhub' ? 'url' : it.open ? 'github' : 'curated',
      label: it.host === 'clawhub' ? `ClawHub: ${source.repo}` : `${source.repo}${skill.path ? '/' + skill.path : ''}`,
      url: itemUrl(it, r.commit),
      catalogId: 'curated',
      itemId: it.id,
      version: version || short(r.commit),
      // Source, licence and version checked by TeamBot (not the content line by line).
      verified: !it.open,
      publisher: source.publisher,
      repo: source.repo,
      // The pin: exactly this commit (ClawHub: this version) was installed; a later one is only ever shown as an update
      // to approve.
      commit: r.commit,
      commitDate: r.commit === source.commit ? source.commitDate : undefined,
      // The catalogue's own pin at this moment: only a pin TeamBot ships later counts as a catalogue update.
      catalogCommit: it.open ? undefined : source.commit,
      license: r.license.spdx || undefined,
      licenseFile: r.license.file || undefined,
      root: skill.root ?? '',
      seen: r.seen,
      dropped: r.dropped.slice(0, 50),
    };
  }

  async resolve(userId: string, it: CuratedItem, commit: string): Promise<Resolved> {
    try {
      const r = await resolveSkill(this.reader(userId, it), it.source, it.skill, commit, { archiveFirst: !!it.open });
      const warning = it.host === 'clawhub' ? (await this.web?.clawhubSkill(it.source.repo))?.warning : '';
      return warning ? { ...r, sourceWarning: warning } : r;
    } catch (e) {
      webErr(e);
    }
  }

  /** Stage a resolved version for the regular review rules (scan, permissions, policy). */
  stage(userId: string, it: CuratedItem, r: Resolved, placement: Placement) {
    const meta = analyze(r.files, folderName(it)).parsed.meta;
    // Per team (package B4): a same-named skill from another source in this team (or for all teams) is never
    // overwritten, and installing for all teams while a team has its own copy is refused (one name per team).
    const existing = meta.name ? this.lib.existingFor(userId, meta.name, placement) : null;
    const clash = meta.name ? existing || this.lib.nameConflict(userId, meta.name, placement) : null;
    if (clash && (!this.sameOrigin(clash, it) || !existing)) {
      throw new HttpError(409, `Je hebt al een skill met de naam "${meta.name}"${this.lib.whereText(clash)}${clash.source?.label ? ` (uit ${clash.source.label})` : ''}. Verwijder of hernoem die eerst; TeamBot overschrijft hem niet.`);
    }
    const st = this.importer.stage(userId, `${it.host === 'clawhub' ? 'ClawHub: ' : ''}${it.source.repo}${it.skill.path ? '/' + it.skill.path : ''}`, [
      { files: r.files, root: '', source: this.sourceInfo(it, r, meta.version), fallbackName: meta.name || folderName(it), catalogRef: curatedRef(it.id) },
    ]);
    // The review and the stored scan are those of the text as the source wrote it (see analysisOf).
    const seen = analysisOf(r, folderName(it));
    if (st.candidates[0] && seen.scan.level !== st.candidates[0].analysis.scan.level) st.candidates[0].analysis.scan = seen.scan;
    return this.importer.place(st, placement);
  }

  /** An installed skill is this same skill: the same id, or (installed from the internet before 0.4) the same folder. */
  private sameOrigin(row: SkillRow, it: CuratedItem) {
    const ref = parseCuratedRef(row.catalog_ref);
    if (ref) return (this.item(ref)?.id || ref) === it.id;
    const old = parseWebRef(row.catalog_ref);
    return !!old && lower(old.repo) === lower(it.source.repo) && old.path === it.skill.path;
  }

  /**
   * Install one skill at one commit: the one install path of the marketplace (import rules, scan, review rules of the
   * importer). 'created' = works at once for the team; anything to confirm comes back as `staging` for the review.
   */
  async install(userId: string, it: CuratedItem, commit: string, o: { placement: Placement; acknowledge?: boolean; enableFor?: string[]; overridePolicy?: boolean; createdBy: string }) {
    const { placement } = o;
    const team = placement.scope === 'team' ? placement.teamId : null;
    const already = this.installed(userId, team ?? undefined).get(it.id);
    if (already && (placement.scope === 'team' || this.lib.teamOf(already) === null)) return { status: 'installed' as const, skillId: already.id, name: already.name, teamId: this.lib.teamOf(already) };
    const r = await this.resolve(userId, it, commit);
    if (r.problems.length) throw new HttpError(422, `Deze skill voldoet niet aan de importregels van TeamBot: ${r.problems.slice(0, 5).join(' · ')}`, 'import-rules');
    const st = this.stage(userId, it, r, placement);
    const res = this.importer.commit(userId, st.id, { acknowledge: o.acknowledge === true, enableFor: o.enableFor || [], overridePolicy: o.overridePolicy === true, createdBy: o.createdBy, placement });
    const first = res.results[0] || { status: 'error', error: 'Niets geïnstalleerd.' };
    // 'updated': the same skill was installed from the internet before 0.4; it now follows its pinned commit.
    if (['created', 'updated', 'unchanged'].includes(first.status)) {
      this.ctx.audit(userId, 'skill.curated_installed', { id: it.id, repo: it.source.repo, commit: r.commit, license: r.license.spdx, dropped: r.dropped.length, teamId: team ?? '*', checked: !it.open });
      return { status: first.status === 'created' ? ('created' as const) : ('installed' as const), skillId: first.skillId as string, name: first.name as string, commit: r.commit, license: r.license.spdx, dropped: r.dropped, checked: !it.open, teamId: team ?? '*', ...(res.notEnabled ? { notEnabled: res.notEnabled } : {}) };
    }
    // Something to confirm (serious scan findings, a look-alike publisher, policy) or an error: the regular review shows it.
    let staging = null;
    try {
      staging = this.importer.view(userId, this.importer.get(userId, st.id));
    } catch {
      /* the staging is gone: only the status and the error are reported */
    }
    return { status: first.status as string, error: (first.error as string) || null, staging };
  }

  // ------------------------------------------------------------------ everything public (the open search)

  /**
   * One page of the open search: matches in the checked catalogue (first page of a search by words), skills from the
   * open directory, and repositories on GitHub, each marked with whether TeamBot checked it and whether the team has it.
   * `only`: ask one of the two sources (the screen asks them apart, so a slow one never holds up the other).
   */
  async search(userId: string, o: { q: string; sort: OpenSort; page: number; teamId?: string | null; only?: 'github' | 'directory' | 'clawhub'; blocked?: (id: string) => boolean }) {
    const web = this.web;
    const words = lower(o.q).split(/\s+/).filter(Boolean);
    const inst = this.installed(userId, o.teamId);
    const notes = this.updateNotes(userId);
    const all = this.sorted().filter((i) => !o.blocked?.(i.id));
    const checked = words.length && o.page <= 1 ? all.filter((i) => words.every((w) => lower(`${folderName(i)} ${i.skill.note} ${i.skill.category} ${i.skill.pack} ${i.source.repo} ${i.source.publisher}`).includes(w))).map((i) => this.card(i, inst.get(i.id), notes)) : [];
    const none: OpenPage = { hits: [], total: null, more: false, stale: false, error: null, limitedUntil: null };
    const want = (s: NonNullable<typeof o.only>) => !!web && (!o.only || o.only === s);
    const [gh, dir, claw] = await Promise.all([want('github') ? web!.searchGithub({ ...o, userId }) : none, want('directory') ? web!.searchDirectory(o) : null, want('clawhub') ? web!.searchClawhub(o) : null]);

    // What the team has, by repository and skill name (the folder name and the name in SKILL.md).
    const have = new Map<string, SkillRow>();
    const perRepo = new Map<string, number>();
    for (const [id, row] of inst) {
      const it = this.item(id);
      if (!it) continue;
      const repo = lower(it.source.repo);
      perRepo.set(repo, (perRepo.get(repo) || 0) + 1);
      for (const n of [path.posix.basename(it.skill.path), row.name]) if (n) have.set(`${repo}|${lower(n)}`, row);
    }
    const cardOf = (h: OpenHit): OpenCard => {
      if (h.from === 'clawhub') {
        const [owner, slug] = h.repo.split('/');
        const id = clawRef(owner, slug);
        const pub = checkPublisher(owner, slug);
        const row = inst.get(id);
        return { ...h, id, url: `${CLAWHUB}/${h.repo}`, checked: false, checkedCount: 0, skillCount: null, publisherStatus: pub.status, publisherNote: pub.reason || '', installed: row ? { skillId: row.id } : null, installedCount: row ? 1 : 0 };
      }
      const repo = lower(h.repo);
      const listed = all.filter((i) => lower(i.source.repo) === repo);
      const idx = web?.peekIndex(h.repo) || null;
      const meta = web?.peekRepoMeta(h.repo) || null;
      const pub = checkPublisher(h.repo.split('/')[0], h.repo.split('/')[1]);
      const known = h.skill && idx ? web!.find(idx, h.skill) : null;
      const mine = h.skill ? listed.find((i) => (known ? i.skill.path === known.path : lower(path.posix.basename(i.skill.path)) === lower(h.skill!))) : null;
      const row = h.skill ? have.get(`${repo}|${lower(h.skill)}`) || (known ? have.get(`${repo}|${lower(known.name)}`) : undefined) : undefined;
      return {
        kind: h.kind,
        id: mine ? mine.id : webRef(h.repo, h.skill || ''),
        from: h.from,
        repo: h.repo,
        skill: h.skill,
        name: h.name,
        description: (known && !known.partial ? known.description : '') || h.description || (h.skill ? '' : meta?.description || ''),
        stars: h.stars ?? meta?.stars ?? null,
        downloads: null,
        flagged: false,
        installs: h.installs,
        recent: h.recent,
        license: h.license ?? (known && known.license.spdx) ?? meta?.license ?? null,
        updatedAt: h.updatedAt ?? meta?.pushedAt ?? null,
        createdAt: h.createdAt ?? meta?.createdAt ?? null,
        archived: h.archived || !!meta?.archived,
        url: githubTreeUrl(h.repo, '', known ? known.path : ''),
        checked: h.skill ? !!mine : listed.length > 0,
        checkedCount: h.skill ? (mine ? 1 : 0) : listed.length,
        skillCount: idx ? idx.skills.length : null,
        publisherStatus: pub.status,
        publisherNote: pub.reason || '',
        installed: row ? { skillId: row.id } : null,
        installedCount: h.skill ? (row ? 1 : 0) : perRepo.get(repo) || 0,
      };
    };
    const section = (p: OpenPage): OpenSection => ({ items: p.hits.map(cardOf).filter((c) => !o.blocked?.(c.id) && !o.blocked?.(`github/${c.repo}`)), total: p.total, more: p.more, stale: p.stale, error: p.error });
    const until = gh.limitedUntil && gh.limitedUntil > Date.now() ? gh.limitedUntil : null;
    return {
      q: o.q,
      sort: o.sort,
      page: o.page,
      checked,
      /** Single skills from the open directory, or null when it has nothing in this order. */
      directory: dir ? { source: 'skills.sh', order: o.sort === 'trending' ? ('recent' as const) : ('installs' as const), ...section(dir) } : null,
      github: section(gh),
      /** Single skills hosted by ClawHub (its own stars and downloads), or null when it was not asked. */
      clawhub: claw ? section(claw) : null,
      /** GitHub's search limit was reached: when it works again, said calmly. */
      limit: until ? { source: 'github', until, text: limitText(until) } : null,
      offline: isOffline(),
    };
  }

  /** The skills in one repository on GitHub (read from its archive on demand), each ready to add with its id. */
  async repoSkills(userId: string, repo: string, teamId?: string | null) {
    if (!this.web) throw new HttpError(404, 'Niet beschikbaar.');
    let idx;
    try {
      idx = await this.web.index(repo, { userId });
    } catch (e) {
      webErr(e);
    }
    const meta = this.web.peekRepoMeta(repo);
    const inst = this.installed(userId, teamId);
    const pub = checkPublisher(repo.split('/')[0], repo.split('/')[1]);
    return {
      repo,
      url: `https://github.com/${repo}`,
      commit: idx.commit,
      updatedAt: meta?.pushedAt || idx.commitDate,
      stars: meta?.stars ?? null,
      license: idx.rootLicense?.spdx || meta?.license || null,
      description: meta?.description || '',
      publisherStatus: pub.status,
      publisherNote: pub.reason || '',
      /** A very large repository: only the names of its skills are known until one is opened. */
      namesOnly: idx.mode === 'tree',
      truncated: idx.truncated,
      stale: !!idx.stale,
      skills: idx.skills.map((s) => {
        const it = this.item(webRef(repo, s.path));
        const row = it ? inst.get(it.id) : undefined;
        return {
          id: it?.id || webRef(repo, s.path),
          path: s.path,
          name: s.name,
          description: it && !it.open ? it.skill.note : s.description,
          checked: !!it && !it.open,
          license: s.license.spdx,
          scripts: s.kind === 'scripts',
          scanLevel: s.scanLevel,
          problem: s.errors[0] || '',
          installed: row ? { skillId: row.id } : null,
        };
      }),
    };
  }

  /** Compare installed skills with newer versions; with `teamId` only what that team has (other notes stay). */
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
      const access = this.reader(userId, list[0].it);
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
        // no update. A skill from outside the catalogue has only its source.
        const candidates: { commit: string; origin: UpdateNote['origin'] }[] = [];
        if (!it.open && cur?.type === 'curated' && src.commit !== from && src.commit !== cur?.catalogCommit) candidates.push({ commit: src.commit, origin: 'catalogus' });
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
  /** A skill by its reference (a catalogue id or an open id), with the commit to show or install. */
  const targetOr404 = async (userId: string, ref: unknown) => {
    const t = await catalog.target(userId, str(ref, 400));
    // An admin's takedown of an open result can name the skill or its whole repository.
    if (blocked(t.it.id) || (t.it.open && blocked(t.it.source.id))) throw new HttpError(403, 'Dit item is door de beheerder geblokkeerd.');
    return t;
  };
  const ownCurated = (userId: string, skillId: unknown) => {
    const row = lib.get(userId, str(skillId, 100));
    if (!row) throw new HttpError(404, 'Skill niet gevonden');
    const id = parseCuratedRef(row.catalog_ref);
    const it = id ? catalog.item(id) : null;
    if (!it) throw new HttpError(400, 'Deze skill komt niet uit de marktplaats.');
    return { row, it };
  };
  /** The pin asked for: a commit of a GitHub repository, or a version of a ClawHub skill. */
  const assertCommit = (c: unknown, it?: CuratedItem) => {
    const s = str(c, 70).trim();
    if (it?.host === 'clawhub' ? !VERSION_RE.test(s) : !/^[0-9a-f]{40}$/.test(s)) throw bad(it?.host === 'clawhub' ? 'Ongeldige versie.' : 'Ongeldige commit.');
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
      const items = catalog.sorted().filter((i) => !blocked(i.id)).map((i) => catalog.card(i, inst.get(i.id), notes, all?.get(i.id)));
      return {
        sources: catalog.sources.map((s) => ({ id: s.id, repo: s.repo, publisher: s.publisher, owner: s.owner, license: s.license, commit: s.commit, commitDate: s.commitDate, verifiedAt: s.verifiedAt, note: s.note, stars: s.stars || 0, url: githubTreeUrl(s.repo, s.commit, ''), skills: s.skills.length })),
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
      const { it, commit: pin } = await targetOr404(u.id, req.query.id);
      const inst = catalog.installed(u.id).get(it.id);
      const commit = req.query.commit ? assertCommit(req.query.commit, it) : pin;
      const r = await catalog.resolve(u.id, it, commit);
      const a = analysisOf(r, folderName(it));
      const md = r.files.get('SKILL.md')?.toString('utf8') || '';
      return {
        ...catalog.card(it, inst),
        // An open result has no commit of its own until it is shown: the one HEAD points to now.
        ...(it.open ? { commit: r.commit, url: itemUrl(it, r.commit), scripts: a.scan.kind === 'scripts', note: a.parsed.meta.description } : {}),
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
      const { it, commit } = await targetOr404(u.id, b.id);
      // For one team (the chosen one; default the default team) or for all teams (teamId '*'): package B4.
      return catalog.install(u.id, it, commit, {
        placement: lib.placementFor(u.id, b.teamId),
        acknowledge: b.acknowledge === true,
        enableFor: Array.isArray(b.enableFor) ? b.enableFor.map(String) : [],
        overridePolicy: b.overridePolicy === true,
        createdBy: it.open ? 'marktplaats' : 'catalogus',
      });
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
      const commit = assertCommit(req.query.commit, it);
      const r = await catalog.resolve(u.id, it, commit);
      const next = analysisOf(r, row.name);
      const cur = lib.version(row);
      const perms = diffPermissions(cur?.permissions, next.permissions);
      const files = diffFiles(lib.readFiles(row), r.files);
      return {
        skillId: row.id,
        name: row.name,
        id: it.id,
        repo: it.source.repo,
        from: { commit: row.source?.commit || null, version: row.version, url: row.source?.commit ? itemUrl(it, row.source.commit) : null },
        to: { commit, version: next.parsed.meta.version, url: itemUrl(it, commit), inCatalog: !it.open && commit === it.source.commit },
        compare: row.source?.commit && it.host !== 'clawhub' ? `https://github.com/${it.source.repo}/compare/${row.source.commit}...${commit}` : null,
        files,
        permissions: perms,
        scan: { level: next.scan.level, kind: next.scan.kind, labels: next.scan.labels, findings: next.scan.findings.filter((f) => f.severity !== 'info').slice(0, 30) },
        // The scripts change while they are on: after the update the bots run the new ones (SkillLibrary.installed).
        scriptsChange: lib.isTrusted(row) && !!next.scriptsChecksum && next.scriptsChecksum !== cur?.scripts_checksum,
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
      const commit = assertCommit(b.commit, it);
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
