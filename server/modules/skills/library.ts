import fs from 'node:fs';
import path from 'node:path';
import type { Agent, Ctx } from '../../core/types.js';
import { defineTable, newId, now } from '../../core/db.js';
import { HttpError } from '../../core/http.js';
import { resolveInWorkspace } from '../../tools/builtin/files.js';
import { type FileMap, checkLimits, checksumOf, safeRelPath, totalSize, writeFilesAtomic } from './files.js';
import { type ParsedSkill, parseSkillMd } from './format.js';
import { type Permissions, type PermissionDiff, type ScanResult, diffPermissions, permissionsOf, scanSkill, scriptsChecksum } from './scan.js';
import { type PackageInfo, infoSummary } from './publishers.js';

defineTable('skills', { json: ['source', 'labels', 'package'], bool: ['pinned'] });
defineTable('skill_versions', { json: ['meta', 'scan', 'permissions', 'source', 'warnings', 'package'] });
defineTable('skill_materializations', { json: ['files'] });

export const MAX_REVISIONS = 50;

export interface SourceInfo {
  type: 'paste' | 'zip' | 'folder' | 'path' | 'discover' | 'url' | 'github' | 'catalog' | 'bot' | 'template' | 'edit' | 'curated' | 'chat' | 'document';
  label?: string;
  url?: string;
  path?: string;
  catalogId?: string;
  itemId?: string;
  version?: string;
  verified?: boolean;
  publisher?: string;
  agentId?: string;
  /** TeamBot catalogue (`curated`): the pinned origin of this revision. */
  repo?: string;
  commit?: string;
  commitDate?: string;
  /** The catalogue's pinned commit when this revision was installed (a later pin is a catalogue update). */
  catalogCommit?: string;
  /** Licence as found in the licence file that applies to the folder (SPDX), and where. */
  license?: string;
  licenseFile?: string;
  /** Folder of the repository that `../` links of the skill may point into; those files are stored under `_bron/`. */
  root?: string;
  /** Upstream files looked at during install (path → git blob hash): what an update is compared with. */
  seen?: Record<string, string>;
  /** Files that were left out (hidden, not text), with the reason. */
  dropped?: { path: string; reason: string }[];
}

/**
 * Where an installed skill applies (0.4, package B4): `team` = one team (`team_id`; NULL = the default team, also for
 * an owner without any team yet), `user` = "voor alle teams" (the owner's choice; and what other modules get when they
 * install without naming a team, as before 0.4).
 */
export type InstallScope = 'user' | 'team';

/** Where an install goes: one team (null = the default team) or all teams. */
export type Placement = { scope: 'user' } | { scope: 'team'; teamId: string | null };
export const ALL_TEAMS: Placement = { scope: 'user' };

/** What a bot may do with a skill: use it (its own team, or all teams), read it (meekijken/aansturen), or nothing. */
export type SkillReach = 'use' | 'read' | 'none';

export interface SkillRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  status: 'active' | 'draft' | 'disabled';
  active_rev: number;
  latest_rev: number;
  pinned: boolean;
  kind: 'prompt' | 'scripts';
  trusted_scripts: string | null;
  source: SourceInfo;
  catalog_ref: string | null;
  version: string;
  license: string;
  author: string;
  checksum: string;
  scan_level: ScanResult['level'];
  labels: string[];
  draft_agent_id: string | null;
  draft_thread_id: string | null;
  /** Publisher snapshot of the active revision (without manifest); null = not signed. */
  package: PackageInfo | null;
  /** Install scope (see InstallScope): one team, or all teams. */
  install_scope: InstallScope;
  team_id: string | null;
  use_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface VersionRow {
  id: string;
  skill_id: string;
  user_id: string;
  rev: number;
  version: string;
  checksum: string;
  scripts_checksum: string;
  meta: ParsedSkill['meta'];
  scan: ScanResult;
  permissions: Permissions;
  source: SourceInfo;
  warnings: string[];
  note: string;
  created_by: string;
  size: number;
  file_count: number;
  /** Publisher snapshot verified at import (with the signed manifest when there was one). */
  package: PackageInfo | null;
  created_at: string;
}

export interface Analysis {
  parsed: ParsedSkill;
  scan: ScanResult;
  permissions: Permissions;
  checksum: string;
  scriptsChecksum: string;
  size: number;
  fileCount: number;
  errors: string[];
  warnings: string[];
  /** Set by the importer after verifying teambot-package.json; absent = not signed. */
  package?: PackageInfo | null;
}

export const skillMigrations = [
  {
    id: 'skills-001',
    sql: `
CREATE TABLE skills (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active', active_rev INTEGER NOT NULL DEFAULT 1, latest_rev INTEGER NOT NULL DEFAULT 1,
  pinned INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'prompt', trusted_scripts TEXT,
  source TEXT NOT NULL DEFAULT '{}', catalog_ref TEXT, version TEXT NOT NULL DEFAULT '', license TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '', checksum TEXT NOT NULL DEFAULT '', scan_level TEXT NOT NULL DEFAULT 'ok',
  labels TEXT NOT NULL DEFAULT '[]', draft_agent_id TEXT, draft_thread_id TEXT,
  use_count INTEGER NOT NULL DEFAULT 0, last_used_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX skills_user ON skills(user_id, status);
CREATE UNIQUE INDEX skills_user_name ON skills(user_id, name) WHERE status != 'draft';
CREATE TABLE skill_versions (
  id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, user_id TEXT NOT NULL, rev INTEGER NOT NULL,
  version TEXT NOT NULL DEFAULT '', checksum TEXT NOT NULL, scripts_checksum TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '{}', scan TEXT NOT NULL DEFAULT '{}', permissions TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT '{}', warnings TEXT NOT NULL DEFAULT '[]', note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT 'user', size INTEGER NOT NULL DEFAULT 0, file_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, UNIQUE (skill_id, rev)
);
CREATE INDEX skill_versions_skill ON skill_versions(skill_id, rev);
CREATE TABLE skill_materializations (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, agent_id TEXT NOT NULL, skill_id TEXT NOT NULL, rev INTEGER NOT NULL,
  path TEXT NOT NULL, files TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, UNIQUE (agent_id, skill_id)
);
CREATE TABLE skill_catalogs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, url TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', publisher TEXT NOT NULL DEFAULT '',
  expected_sha256 TEXT, last_sha256 TEXT, data TEXT, last_error TEXT, fetched_at TEXT, enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, UNIQUE (user_id, url)
);
CREATE TABLE skill_reports (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, item_type TEXT NOT NULL, catalog_id TEXT NOT NULL, item_id TEXT NOT NULL,
  item_name TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL, details TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open',
  resolution TEXT NOT NULL DEFAULT '', resolved_by TEXT, created_at TEXT NOT NULL, resolved_at TEXT
);
CREATE INDEX skill_reports_user ON skill_reports(user_id, created_at);
CREATE TABLE skill_blocks (
  item_type TEXT NOT NULL, catalog_id TEXT NOT NULL, item_id TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
  blocked_by TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (item_type, catalog_id, item_id)
);
CREATE TABLE skill_shares (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, item_type TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '', version TEXT NOT NULL DEFAULT '', data TEXT NOT NULL, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, UNIQUE (user_id, item_type, slug)
);
`,
  },
  {
    id: 'skills-002',
    sql: `
ALTER TABLE skills ADD COLUMN package TEXT;
ALTER TABLE skill_versions ADD COLUMN package TEXT;
`,
  },
  // B-11: a share by a member waits for an owner/admin ("pending"); earlier shares stay visible ("approved").
  {
    id: 'skills-003',
    sql: `
ALTER TABLE skill_shares ADD COLUMN status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE skill_shares ADD COLUMN review TEXT;
`,
  },
  // 0.4 package H: install scope, so wave 2 can install a skill for one team. Existing rows stay 'user' (= today).
  {
    id: 'skills-004',
    sql: `
ALTER TABLE skills ADD COLUMN install_scope TEXT NOT NULL DEFAULT 'user';
ALTER TABLE skills ADD COLUMN team_id TEXT;
CREATE INDEX skills_scope ON skills(user_id, install_scope, team_id);
`,
  },
  // 0.4 package B4: installs per team. Everything installed so far belongs to the default team (team_id NULL until the
  // start fills it in; a skill that bots of several teams use becomes "voor alle teams", see SkillLibrary.upgradeTeams).
  // A name is unique per team; the library also keeps a team's name free of a same-named skill for all teams.
  {
    id: 'skills-005',
    sql: `
UPDATE skills SET install_scope = 'team' WHERE install_scope = 'user' AND team_id IS NULL;
DROP INDEX IF EXISTS skills_user_name;
CREATE UNIQUE INDEX skills_team_name ON skills(user_id, install_scope, COALESCE(team_id, ''), name) WHERE status != 'draft';
`,
  },
];

const ID_SAFE = /^[A-Za-z0-9_-]{1,80}$/;
function safeId(s: string) {
  if (!ID_SAFE.test(s)) throw new Error('Ongeldige id');
  return s;
}

/** Parse + scan + checksum a skill folder. */
export function analyze(files: FileMap, fallbackName = '', execBits?: Set<string>): Analysis {
  const md = files.get('SKILL.md');
  const errors: string[] = [];
  let parsed: ParsedSkill;
  if (!md) {
    parsed = parseSkillMd('', { fallbackName });
    parsed.errors = ['SKILL.md ontbreekt in deze map.'];
  } else parsed = parseSkillMd(md.toString('utf8'), { fallbackName });
  errors.push(...parsed.errors);
  try {
    checkLimits(files);
  } catch (e: any) {
    errors.push(e.message);
  }
  const scan = scanSkill(files, { execBits });
  const permissions = permissionsOf(parsed.meta.allowedTools, scan);
  return { parsed, scan, permissions, checksum: checksumOf(files), scriptsChecksum: scriptsChecksum(scan), size: totalSize(files), fileCount: files.size, errors, warnings: parsed.warnings };
}

export class SkillLibrary {
  constructor(private ctx: Ctx) {}

  /** The app context (for tools that check server rules before an approval card). */
  get context(): Ctx {
    return this.ctx;
  }

  root(userId: string) {
    return path.join(this.ctx.config.dataDir, 'skills', safeId(userId));
  }
  dir(userId: string, skillId: string, rev: number) {
    return path.join(this.root(userId), safeId(skillId), 'r' + Number(rev));
  }

  // ---------- teams (0.4, package B4) ----------
  private get teams(): any {
    return this.ctx.services.teams;
  }

  /** The team a skill is installed for, or null for "voor alle teams" (and for an owner without any team). */
  teamOf(s: Pick<SkillRow, 'user_id' | 'install_scope' | 'team_id'>): string | null {
    if (s.install_scope !== 'team') return null;
    const t = this.teams;
    if (!t) return null;
    if (s.team_id && t.team(s.team_id)?.user_id === s.user_id) return s.team_id;
    return t.defaultTeam(s.user_id)?.id ?? null;
  }

  placementOf(s: SkillRow): Placement {
    return s.install_scope === 'team' ? { scope: 'team', teamId: this.teamOf(s) } : ALL_TEAMS;
  }

  /**
   * Where an install by the owner goes: `'*'` = all teams, a team id of his = that team, nothing = `fallback` (the
   * routes use the default team; other modules that call the importer without a team get all teams, as before 0.4).
   */
  placementFor(userId: string, raw: unknown, fallback: 'default' | 'all' = 'default'): Placement {
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (v === '*') return ALL_TEAMS;
    const t = this.teams;
    if (v) {
      if (!t || t.team(v)?.user_id !== userId) throw new HttpError(404, 'Team niet gevonden');
      return { scope: 'team', teamId: v };
    }
    if (fallback === 'all' || !t) return ALL_TEAMS;
    return { scope: 'team', teamId: t.defaultTeam(userId)?.id ?? null };
  }

  /** A bot's own team as a placement (what it drafts goes there). */
  placementOfAgent(agent: Pick<Agent, 'id' | 'user_id'>): Placement {
    const t = this.teams;
    return { scope: 'team', teamId: (t && t.teamOf(agent.id)) || t?.defaultTeam(agent.user_id)?.id || null };
  }

  /**
   * Where a skill script keeps its own files (home, temp, app data): the bot's home team folder when the bot may write
   * there, so a team's bots share it and it never lands in another team's area; otherwise the bot's work folder.
   */
  scriptHomeBase(agent: Agent, work: string): string {
    try {
      const team = (this.teams?.foldersFor?.(agent) || []).find((r: any) => r?.kind === 'team' && r.mode === 'rw' && r.path);
      if (team && fs.existsSync(team.path)) return path.resolve(team.path);
    } catch {
      /* no teams module, or no team folder */
    }
    return work;
  }

  /** The team id of a placement (null = all teams; a team placement without a team = the default team). */
  private placementTeam(userId: string, p: Placement): string | null {
    return p.scope === 'user' ? null : p.teamId || this.teams?.defaultTeam(userId)?.id || null;
  }

  /** Is this skill there for a team (its own install, or one for all teams)? `null` team = every team (the owner). */
  inTeam(s: SkillRow, teamId: string | null | undefined): boolean {
    if (!teamId) return true;
    const t = this.teamOf(s);
    return t === null || t === teamId;
  }

  /**
   * What a bot may do with a skill: `use` it when it is for all teams or for the bot's home team, `read` it (load the
   * instructions, never run its scripts) with meekijken or aansturen on the skill's team, otherwise nothing. With one
   * team every skill is `use`.
   */
  reach(agent: Pick<Agent, 'id' | 'user_id'>, s: SkillRow): SkillReach {
    const team = this.teamOf(s);
    const t = this.teams;
    if (!team || !t) return 'use';
    try {
      if (!t.multi(s.user_id)) return 'use';
      const r = t.access(agent.id, team);
      return r === 'home' ? 'use' : r === 'read' || r === 'direct' ? 'read' : 'none';
    } catch {
      return 'none';
    }
  }

  /** Why a bot may not run this skill's scripts (another team's skill), or null. */
  scriptRefusal(agent: Pick<Agent, 'id' | 'user_id' | 'name'>, s: SkillRow): string | null {
    if (this.reach(agent, s) === 'use') return null;
    const team = this.teamOf(s);
    return `Geweigerd door TeamBot: skill ${s.name} hoort bij team “${this.teams?.team(team)?.name || 'een ander team'}”. ${agent.name} mag hem lezen (meekijken), maar zijn scripts niet uitvoeren; dat kan alleen een bot van dat team.`;
  }

  teamName(teamId: string | null): string {
    return (teamId && this.teams?.team(teamId)?.name) || '';
  }

  /**
   * Skills installed before teams (team_id NULL) get their team: the default team, or all teams when bots of several
   * teams already use the skill (so every bot keeps exactly the skills it had). Runs at start; changes nothing twice.
   */
  upgradeTeams(): number {
    const t = this.teams;
    if (!t) return 0;
    let n = 0;
    const rows = this.ctx.store.all<any>("SELECT * FROM skills WHERE install_scope = 'team' AND team_id IS NULL").map((r) => this.ctx.store.decode<SkillRow>('skills', r));
    for (const s of rows) {
      const def = t.defaultTeam(s.user_id)?.id ?? null;
      if (!def) continue;
      const users = this.ctx.store.agents(s.user_id, { archived: true }).filter((a) => Array.isArray(a.skills) && a.skills.includes(s.id));
      const homes = new Set(users.map((a) => t.teamOf(a.id)).filter(Boolean));
      try {
        if (homes.size > 1) this.ctx.store.update('skills', s.id, { install_scope: 'user', team_id: null });
        else this.ctx.store.update('skills', s.id, { team_id: [...homes][0] || def });
        n++;
      } catch (e: any) {
        this.ctx.log.warn('[skills] team upgrade skipped', s.name, e?.message || e);
      }
    }
    return n;
  }

  // ---------- queries ----------
  /** The owner's skills; `teamId` = what one team has (its own installs and those for all teams). */
  list(userId: string, f: { status?: string; teamId?: string | null } = {}): SkillRow[] {
    const rows = this.ctx.store.find<SkillRow>('skills', { user_id: userId, status: f.status }, { order: 'name' });
    return f.teamId ? rows.filter((s) => this.inTeam(s, f.teamId)) : rows;
  }
  get(userId: string, id: string | null | undefined): SkillRow | null {
    if (!id) return null;
    const s = this.ctx.store.get<SkillRow>('skills', id);
    return s && s.user_id === userId ? s : null;
  }
  /**
   * An installed (not draft) skill by name. With `team` (a team id): the one that team has, its own first, then one
   * for all teams; `null`: only one for all teams; left out: any (callers from before teams).
   */
  getByName(userId: string, name: string, team?: string | null): SkillRow | null {
    const rows = this.ctx.store.all<any>("SELECT * FROM skills WHERE user_id = ? AND name = ? AND status != 'draft' ORDER BY created_at", userId, name).map((r) => this.ctx.store.decode<SkillRow>('skills', r));
    if (team === undefined) return rows[0] || null;
    if (team === null) return rows.find((s) => this.teamOf(s) === null) || null;
    return rows.find((s) => this.teamOf(s) === team) || rows.find((s) => this.teamOf(s) === null) || null;
  }
  /** The installed skill an install with this placement updates (same name, same place), or null. */
  existingFor(userId: string, name: string, p: Placement): SkillRow | null {
    return this.getByName(userId, name, this.placementTeam(userId, p));
  }
  /**
   * A skill with this name that an install with this placement would clash with: for one team its own and those for
   * all teams; for all teams any team's. Null when the name is free there.
   */
  nameConflict(userId: string, name: string, p: Placement, exceptId?: string): SkillRow | null {
    const team = this.placementTeam(userId, p);
    const rows = this.ctx.store.all<any>("SELECT * FROM skills WHERE user_id = ? AND name = ? AND status != 'draft'", userId, name).map((r) => this.ctx.store.decode<SkillRow>('skills', r));
    return rows.find((s) => s.id !== exceptId && (team === null || this.teamOf(s) === null || this.teamOf(s) === team)) || null;
  }
  /** "… in team X" / "… voor alle teams", for a conflict message (empty with one team). */
  whereText(s: SkillRow): string {
    if (!this.teams?.multi(s.user_id)) return '';
    const team = this.teamOf(s);
    return team ? ` in team “${this.teamName(team)}”` : ' voor alle teams';
  }
  version(skill: SkillRow, rev = skill.active_rev): VersionRow | null {
    const r = this.ctx.store.one('SELECT * FROM skill_versions WHERE skill_id = ? AND rev = ?', skill.id, rev);
    return r ? this.ctx.store.decode<VersionRow>('skill_versions', r) : null;
  }
  /** Whether one of the skill's stored revisions has exactly these files. */
  hasRevision(skillId: string, checksum: string): boolean {
    return !!this.ctx.store.one('SELECT 1 FROM skill_versions WHERE skill_id = ? AND checksum = ? LIMIT 1', skillId, checksum);
  }
  versions(skill: SkillRow): VersionRow[] {
    return this.ctx.store.find<VersionRow>('skill_versions', { skill_id: skill.id }, { order: 'rev DESC' });
  }

  readFiles(skill: SkillRow, rev = skill.active_rev): FileMap {
    const dir = this.dir(skill.user_id, skill.id, rev);
    const out: FileMap = new Map();
    if (!fs.existsSync(dir)) return out;
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) out.set(path.relative(dir, full).split(path.sep).join('/'), fs.readFileSync(full));
      }
    };
    walk(dir);
    return out;
  }

  readSkillMd(skill: SkillRow, rev = skill.active_rev): string {
    const f = path.join(this.dir(skill.user_id, skill.id, rev), 'SKILL.md');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  }

  readFile(skill: SkillRow, rel: string, rev = skill.active_rev): Buffer | null {
    const safe = safeRelPath(rel);
    if (!safe) return null;
    const dir = this.dir(skill.user_id, skill.id, rev);
    const f = path.join(dir, ...safe.split('/'));
    if (!path.resolve(f).startsWith(path.resolve(dir) + path.sep)) return null;
    const st = fs.lstatSync(f, { throwIfNoEntry: false });
    if (!st || !st.isFile()) return null;
    return fs.readFileSync(f);
  }

  isTrusted(skill: SkillRow, v?: VersionRow | null): boolean {
    if (skill.kind !== 'scripts') return false;
    const ver = v ?? this.version(skill);
    return !!skill.trusted_scripts && !!ver && skill.trusted_scripts === ver.scripts_checksum;
  }

  // ---------- writes ----------
  private writeRevision(skill: { id: string; user_id: string }, rev: number, files: FileMap, a: Analysis, o: { source: SourceInfo; createdBy: string; note?: string }) {
    const dir = this.dir(skill.user_id, skill.id, rev);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    writeFilesAtomic(dir, files);
    try {
      this.ctx.store.insert('skill_versions', {
        id: newId('skv_'),
        skill_id: skill.id,
        user_id: skill.user_id,
        rev,
        version: a.parsed.meta.version,
        checksum: a.checksum,
        scripts_checksum: a.scriptsChecksum,
        meta: a.parsed.meta,
        scan: a.scan,
        permissions: a.permissions,
        source: o.source,
        warnings: a.warnings,
        note: String(o.note || '').slice(0, 2000),
        created_by: o.createdBy,
        size: a.size,
        file_count: a.fileCount,
        package: a.package ?? null,
        created_at: now(),
      });
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  }

  private denorm(v: VersionRow | Analysis) {
    const meta = 'parsed' in v ? v.parsed.meta : v.meta;
    const scan = v.scan;
    return {
      name: meta.name,
      description: meta.description,
      version: meta.version,
      license: meta.license,
      author: meta.author,
      checksum: v.checksum,
      kind: scan.kind,
      scan_level: scan.level,
      labels: scan.labels,
      package: infoSummary(v.package ?? null),
    };
  }

  /** Is the name taken where this skill lives (its team and all teams, or everywhere for a skill for all teams)? */
  private nameTaken(userId: string, name: string, exceptId?: string) {
    const self = exceptId ? this.ctx.store.get<SkillRow>('skills', exceptId) : null;
    return !!this.nameConflict(userId, name, self ? this.placementOf(self) : ALL_TEAMS, exceptId);
  }

  create(
    userId: string,
    files: FileMap,
    a: Analysis,
    o: { status?: SkillRow['status']; source: SourceInfo; createdBy: string; note?: string; catalogRef?: string | null; draftAgentId?: string | null; draftThreadId?: string | null; placement?: Placement },
  ): SkillRow {
    if (a.errors.length) throw new HttpError(400, a.errors[0]);
    const status = o.status || 'active';
    // Without a placement (a caller from before teams): for all teams, as every install was until 0.4.
    const placement = o.placement || ALL_TEAMS;
    const clash = status !== 'draft' ? this.nameConflict(userId, a.parsed.meta.name, placement) : null;
    if (clash) throw new HttpError(409, `Je hebt al een skill met de naam "${a.parsed.meta.name}"${this.whereText(clash)}.`);
    const id = newId('skl_');
    this.writeRevision({ id, user_id: userId }, 1, files, a, o);
    const ts = now();
    const row = {
      id,
      user_id: userId,
      ...this.denorm(a),
      status,
      active_rev: 1,
      latest_rev: 1,
      pinned: false,
      trusted_scripts: null,
      source: o.source,
      catalog_ref: o.catalogRef ?? null,
      draft_agent_id: o.draftAgentId ?? null,
      draft_thread_id: o.draftThreadId ?? null,
      install_scope: placement.scope,
      team_id: placement.scope === 'team' ? this.placementTeam(userId, placement) : null,
      use_count: 0,
      last_used_at: null,
      created_at: ts,
      updated_at: ts,
    };
    try {
      this.ctx.store.insert('skills', row);
    } catch (e: any) {
      fs.rmSync(path.join(this.root(userId), id), { recursive: true, force: true });
      this.ctx.store.exec('DELETE FROM skill_versions WHERE skill_id = ?', id);
      if (/UNIQUE/i.test(String(e?.message))) throw new HttpError(409, `Je hebt al een skill met de naam "${a.parsed.meta.name}".`);
      throw e;
    }
    return this.get(userId, id)!;
  }

  /**
   * Store a new revision. Activation of a revision that needs more rights than the active one
   * requires `confirmPermissions` — otherwise nothing is stored and the diff is returned.
   */
  addRevision(
    skill: SkillRow,
    files: FileMap,
    a: Analysis,
    o: { source: SourceInfo; createdBy: string; note?: string; activate: boolean; confirmPermissions?: boolean; catalogRef?: string | null },
  ): { status: 'unchanged' | 'needs-confirmation' | 'added' | 'activated'; rev?: number; diff: PermissionDiff; skill: SkillRow } {
    if (a.errors.length) throw new HttpError(400, a.errors[0]);
    const active = this.version(skill);
    const diff = diffPermissions(active?.permissions, a.permissions);
    if (active && active.checksum === a.checksum) {
      this.upgradePackage(skill, active, a);
      return { status: 'unchanged', rev: active.rev, diff, skill: this.ctx.store.get<SkillRow>('skills', skill.id)! };
    }
    if (o.activate && diff.elevated && !o.confirmPermissions) return { status: 'needs-confirmation', diff, skill };
    if (o.activate && this.nameTaken(skill.user_id, a.parsed.meta.name, skill.id) && skill.status !== 'draft') throw new HttpError(409, `Je hebt al een andere skill met de naam "${a.parsed.meta.name}".`);
    const same = this.ctx.store.one<{ rev: number }>('SELECT rev FROM skill_versions WHERE skill_id = ? AND checksum = ? ORDER BY rev DESC LIMIT 1', skill.id, a.checksum);
    let rev: number;
    if (same) {
      rev = same.rev;
      const sv = this.version(skill, rev);
      if (sv) this.upgradePackage(skill, sv, a);
    } else {
      rev = skill.latest_rev + 1;
      this.writeRevision(skill, rev, files, a, o);
      this.ctx.store.update('skills', skill.id, { latest_rev: rev, updated_at: now(), ...(o.catalogRef !== undefined ? { catalog_ref: o.catalogRef } : {}) });
    }
    let status: 'added' | 'activated' = 'added';
    if (o.activate) {
      this.applyActive(skill.id, rev, o.source);
      status = 'activated';
    }
    this.prune(this.ctx.store.get<SkillRow>('skills', skill.id)!);
    return { status, rev, diff, skill: this.ctx.store.get<SkillRow>('skills', skill.id)! };
  }

  /**
   * Identical content arrives again, now verified as signed (or built-in): record that on the stored revision.
   * Only ever upgrades from "not signed"; never replaces one publisher by another (that goes through a new import).
   */
  private upgradePackage(skill: SkillRow, v: VersionRow, a: Analysis) {
    if (!a.package || a.package.state === 'unsigned' || (v.package && v.package.state !== 'unsigned')) return;
    this.ctx.store.exec('UPDATE skill_versions SET package = ? WHERE id = ?', JSON.stringify(a.package), v.id);
    if (v.rev === skill.active_rev) this.ctx.store.update('skills', skill.id, { package: infoSummary(a.package), updated_at: now() });
  }

  private applyActive(skillId: string, rev: number, source?: SourceInfo) {
    const s = this.ctx.store.get<SkillRow>('skills', skillId)!;
    const v = this.version(s, rev)!;
    const patch: any = { ...this.denorm(v), active_rev: rev, updated_at: now() };
    if (source && source.type !== 'edit') patch.source = source;
    try {
      this.ctx.store.update('skills', skillId, patch);
    } catch (e: any) {
      if (/UNIQUE/i.test(String(e?.message))) throw new HttpError(409, `Je hebt al een andere skill met de naam "${v.meta.name}".`);
      throw e;
    }
  }

  /** Switch to another stored revision (rollback / roll forward). */
  activate(skill: SkillRow, rev: number, confirmPermissions = false): { status: 'activated' | 'needs-confirmation' | 'unchanged'; diff: PermissionDiff } {
    const target = this.version(skill, rev);
    if (!target) throw new HttpError(404, 'Versie niet gevonden');
    const cur = this.version(skill);
    const diff = diffPermissions(cur?.permissions, target.permissions);
    if (rev === skill.active_rev) return { status: 'unchanged', diff };
    if (diff.elevated && !confirmPermissions) return { status: 'needs-confirmation', diff };
    if (skill.status !== 'draft' && this.nameTaken(skill.user_id, target.meta.name, skill.id)) throw new HttpError(409, `Je hebt al een andere skill met de naam "${target.meta.name}".`);
    this.applyActive(skill.id, rev);
    return { status: 'activated', diff };
  }

  setStatus(skill: SkillRow, status: SkillRow['status']) {
    if (status !== 'draft' && skill.status === 'draft' && this.nameTaken(skill.user_id, skill.name, skill.id)) throw new HttpError(409, `Je hebt al een skill met de naam "${skill.name}". Hernoem het concept eerst.`);
    try {
      this.ctx.store.update('skills', skill.id, { status, updated_at: now() });
    } catch (e: any) {
      if (/UNIQUE/i.test(String(e?.message))) throw new HttpError(409, `Je hebt al een skill met de naam "${skill.name}".`);
      throw e;
    }
    if (status !== 'active') this.cleanupSkillMaterializations(skill);
  }

  setPinned(skill: SkillRow, pinned: boolean) {
    this.ctx.store.update('skills', skill.id, { pinned, updated_at: now() });
  }

  /**
   * Install a skill for another team, or for all teams (the owner's choice). Refused when that place already has a
   * skill with this name. Bots that can no longer see it keep it in their list, but it no longer reaches them.
   */
  setPlacement(skill: SkillRow, p: Placement): SkillRow {
    if (skill.status !== 'draft') {
      const clash = this.nameConflict(skill.user_id, skill.name, p, skill.id);
      if (clash) throw new HttpError(409, `Daar is al een skill met de naam "${skill.name}"${this.whereText(clash)}. Verwijder of hernoem die eerst.`);
    }
    const patch = { install_scope: p.scope, team_id: p.scope === 'team' ? this.placementTeam(skill.user_id, p) : null, updated_at: now() };
    try {
      this.ctx.store.update('skills', skill.id, patch);
    } catch (e: any) {
      if (/UNIQUE/i.test(String(e?.message))) throw new HttpError(409, `Daar is al een skill met de naam "${skill.name}".`);
      throw e;
    }
    return this.ctx.store.get<SkillRow>('skills', skill.id)!;
  }

  setTrusted(skill: SkillRow, trusted: boolean) {
    const v = this.version(skill);
    if (skill.kind !== 'scripts' || !v?.scripts_checksum) throw new HttpError(400, 'Deze skill bevat geen scripts; vertrouwen is niet nodig.');
    this.ctx.store.update('skills', skill.id, { trusted_scripts: trusted ? v.scripts_checksum : null, updated_at: now() });
    if (!trusted) this.cleanupSkillMaterializations(skill);
  }

  noteUse(skill: SkillRow) {
    this.ctx.store.exec('UPDATE skills SET use_count = use_count + 1, last_used_at = ? WHERE id = ?', now(), skill.id);
  }

  /** Keep the newest revisions (and always the active one). */
  prune(skill: SkillRow) {
    const rows = this.ctx.store.all<{ rev: number }>('SELECT rev FROM skill_versions WHERE skill_id = ? ORDER BY rev DESC', skill.id);
    for (const r of rows.slice(MAX_REVISIONS)) {
      if (r.rev === skill.active_rev) continue;
      fs.rmSync(this.dir(skill.user_id, skill.id, r.rev), { recursive: true, force: true });
      this.ctx.store.exec('DELETE FROM skill_versions WHERE skill_id = ? AND rev = ?', skill.id, r.rev);
    }
  }

  /** Uninstall: managed storage, managed workspace copies and enablement only. */
  remove(skill: SkillRow) {
    this.cleanupSkillMaterializations(skill);
    for (const a of this.ctx.store.agents(skill.user_id, { archived: true })) {
      if (a.skills?.includes(skill.id)) {
        const upd = this.ctx.store.updateAgent(a.id, { skills: a.skills.filter((x) => x !== skill.id) });
        this.ctx.events.emit(skill.user_id, 'agent.updated', upd);
      }
    }
    const dir = path.join(this.root(skill.user_id), safeId(skill.id));
    if (path.resolve(dir).startsWith(path.resolve(this.root(skill.user_id)) + path.sep)) fs.rmSync(dir, { recursive: true, force: true });
    this.ctx.store.tx(() => {
      this.ctx.store.exec('DELETE FROM skill_versions WHERE skill_id = ?', skill.id);
      this.ctx.store.remove('skills', skill.id);
    });
  }

  // ---------- per-bot enablement ----------
  /**
   * Active skills enabled for this bot that belong to the bot's owner (sorted by name), and that the bot's team may
   * see: its own team's, those for all teams, and (to read) those of teams it may look into. A skill of a team the bot
   * has no access to is left out, also when it is still in its list (it moved, or lost access).
   */
  enabledFor(agent: Agent): SkillRow[] {
    const ids = Array.isArray(agent.skills) ? agent.skills.filter((x) => typeof x === 'string') : [];
    if (!ids.length) return [];
    const rows = this.ctx.store.all<any>(`SELECT * FROM skills WHERE user_id = ? AND status = 'active' AND id IN (${ids.map(() => '?').join(',')}) ORDER BY name`, agent.user_id, ...ids);
    return rows.map((r) => this.ctx.store.decode<SkillRow>('skills', r)).filter((s) => this.reach(agent, s) !== 'none');
  }

  setAgentSkills(agent: Agent, ids: string[]): Agent {
    const valid = [...new Set(ids)].filter((id) => {
      const s = this.get(agent.user_id, id);
      return s && s.status !== 'draft' && this.reach(agent, s) !== 'none';
    });
    const removed = (agent.skills || []).filter((x) => !valid.includes(x));
    const upd = this.ctx.store.updateAgent(agent.id, { skills: valid });
    for (const id of removed) {
      const m = this.ctx.store.one<any>('SELECT * FROM skill_materializations WHERE agent_id = ? AND skill_id = ?', agent.id, id);
      if (m) this.cleanupMaterialization(this.ctx.store.decode('skill_materializations', m));
    }
    this.ctx.events.emit(agent.user_id, 'agent.updated', upd);
    return upd;
  }

  // ---------- scripts in the workspace (only for trusted skills) ----------
  /**
   * Copy the files of a trusted skill into `<workspace>/.skills/<name>/` so the bot can run them with the
   * normal shell tool (and its normal approval). A marker file records exactly which paths we manage.
   */
  materialize(agent: Agent, skill: SkillRow): { dir: string; rel: string; files: string[] } {
    if (!this.isTrusted(skill)) throw new HttpError(403, 'Deze skill is niet vertrouwd; scripts zijn geblokkeerd.');
    const rel = `.skills/${skill.name}`;
    const target = resolveInWorkspace(agent, rel);
    const markerFile = path.join(target, '.teambot-skill.json');
    let previous: string[] = [];
    if (fs.existsSync(target)) {
      if (!fs.existsSync(markerFile)) throw new HttpError(409, `De map ${rel} bestaat al en wordt niet door TeamBot beheerd; hernoem of verwijder die map eerst.`);
      let mk: any = null;
      try {
        mk = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
      } catch {
        /* ignore */
      }
      if (mk?.skillId !== skill.id) throw new HttpError(409, `De map ${rel} hoort bij een andere skill.`);
      previous = Array.isArray(mk.files) ? mk.files : [];
    }
    const files = this.readFiles(skill);
    const list = [...files.keys()].sort();
    // Remove managed files that no longer exist in this revision.
    this.deleteManaged(target, previous.filter((p) => !files.has(p)));
    for (const [p, b] of files) {
      const safe = safeRelPath(p);
      if (!safe) continue;
      const f = path.join(target, ...safe.split('/'));
      if (!path.resolve(f).startsWith(path.resolve(target) + path.sep)) continue;
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, b);
    }
    fs.writeFileSync(markerFile, JSON.stringify({ managedBy: 'TeamBot', skillId: skill.id, rev: skill.active_rev, checksum: skill.checksum, files: list }, null, 2));
    this.ctx.store.exec('DELETE FROM skill_materializations WHERE agent_id = ? AND skill_id = ?', agent.id, skill.id);
    this.ctx.store.insert('skill_materializations', { id: newId('skm_'), user_id: agent.user_id, agent_id: agent.id, skill_id: skill.id, rev: skill.active_rev, path: target, files: list, created_at: now() });
    return { dir: target, rel, files: list };
  }

  private deleteManaged(target: string, rels: string[]) {
    const base = path.resolve(target);
    const dirs = new Set<string>();
    for (const r of rels) {
      const safe = safeRelPath(r);
      if (!safe) continue;
      const f = path.resolve(base, ...safe.split('/'));
      if (!f.startsWith(base + path.sep)) continue;
      const st = fs.lstatSync(f, { throwIfNoEntry: false });
      if (st?.isFile() || st?.isSymbolicLink()) fs.unlinkSync(f);
      let d = path.dirname(f);
      while (d.startsWith(base + path.sep)) {
        dirs.add(d);
        d = path.dirname(d);
      }
    }
    for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
      try {
        fs.rmdirSync(d); // only succeeds when empty
      } catch {
        /* not empty or gone: keep */
      }
    }
  }

  cleanupMaterialization(m: { id: string; path: string; files: string[]; skill_id: string }) {
    const target = m.path;
    const markerFile = path.join(target, '.teambot-skill.json');
    try {
      if (fs.existsSync(markerFile)) {
        const mk = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
        if (mk?.skillId === m.skill_id && path.basename(path.dirname(target)) === '.skills') {
          this.deleteManaged(target, [...new Set([...(m.files || []), ...(Array.isArray(mk.files) ? mk.files : [])])]);
          fs.unlinkSync(markerFile);
          for (const d of [target, path.dirname(target)]) {
            try {
              fs.rmdirSync(d);
            } catch {
              /* user files left: keep */
            }
          }
        }
      }
    } catch (e) {
      this.ctx.log.warn('[skills] cleanup failed', String(e));
    }
    this.ctx.store.remove('skill_materializations', m.id);
  }

  cleanupSkillMaterializations(skill: SkillRow) {
    for (const r of this.ctx.store.find<any>('skill_materializations', { skill_id: skill.id })) this.cleanupMaterialization(r);
  }
}
