import fs from 'node:fs';
import path from 'node:path';
import type { Agent, Ctx } from '../../core/types.js';
import { defineTable, newId, now } from '../../core/db.js';
import { HttpError } from '../../core/http.js';
import { fullAccess } from '../../tools/builtin/files.js';
import { type FileMap, checkLimits, checksumOf, safeRelPath, totalSize, writeFilesAtomic } from './files.js';
import { type ParsedSkill, parseSkillMd } from './format.js';
import type { PermissionDiff, Permissions } from '../../../shared/skills.js';
import { type ScanResult, diffPermissions, permissionsOf, scanSkill, scriptsChecksum } from './scan.js';
import { type PackageInfo, infoSummary } from './publishers.js';

defineTable('skills', { json: ['source', 'labels', 'package'], bool: ['pinned'] });
defineTable('skill_versions', { json: ['meta', 'scan', 'permissions', 'source', 'warnings', 'package'] });

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
  // An install makes a skill's scripts usable (SkillLibrary.installed). What was installed before that, with its scripts
  // still off, gets the same once: not a bot's own skill, a draft, or one whose scripts the owner switched off himself.
  {
    id: 'skills-006',
    sql: `
UPDATE skills SET trusted_scripts = (SELECT v.scripts_checksum FROM skill_versions v WHERE v.skill_id = skills.id AND v.rev = skills.active_rev)
WHERE kind = 'scripts' AND status != 'draft' AND COALESCE(json_extract(source, '$.type'), '') != 'bot'
  AND COALESCE((SELECT v.scripts_checksum FROM skill_versions v WHERE v.skill_id = skills.id AND v.rev = skills.active_rev), '') != ''
  AND NOT EXISTS (SELECT 1 FROM audit a WHERE a.user_id = skills.user_id AND a.kind = 'skill.untrusted' AND json_extract(a.data, '$.skill') = skills.name);
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
   * Can the skills of this bot be worked out by only reading? The teams module gives a bot its team at the first
   * question about that bot, so with more than one team, asking about a bot that has no team (a new bot before the
   * teams module's own turn, a bot that is being removed) would decide its team from here. Such a bot waits: when it
   * gets its team, "teams.changed" follows and it is brought up to date then. With one team nothing here asks.
   */
  placed(agent: Pick<Agent, 'id' | 'user_id'>): boolean {
    const t = this.teams;
    if (!t?.multi?.(agent.user_id)) return true;
    return (t.list(agent.user_id) as { id: string }[]).some((team) => t.botsOf(team.id).includes(agent.id));
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
    if (status === 'active') this.changed(userId);
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
    this.changed(s.user_id);
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
    this.changed(skill.user_id);
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
    this.changed(skill.user_id);
    return this.ctx.store.get<SkillRow>('skills', skill.id)!;
  }

  setTrusted(skill: SkillRow, trusted: boolean) {
    const v = this.version(skill);
    if (skill.kind !== 'scripts' || !v?.scripts_checksum) throw new HttpError(400, 'Deze skill bevat geen scripts; vertrouwen is niet nodig.');
    this.ctx.store.update('skills', skill.id, { trusted_scripts: trusted ? v.scripts_checksum : null, updated_at: now() });
    this.changed(skill.user_id);
  }

  /**
   * An install (the owner's click, or a bot on his word: the importer, a template) makes a skill usable at once for the
   * whole team, scripts included: they are trusted, and a script runs like any command at the bot's own level (asked on
   * "Vragen", done from "Automatisch" on, not at all on "Alleen lezen"). The owner switches them off under Veiligheid.
   */
  installed(skill: SkillRow) {
    const cur = this.ctx.store.get<SkillRow>('skills', skill.id);
    const v = cur && this.version(cur);
    if (cur?.kind === 'scripts' && v?.scripts_checksum && cur.trusted_scripts !== v.scripts_checksum) this.setTrusted(cur, true);
  }

  /**
   * A bot used this skill: counted and logged in this one place, whether TeamBot handed the text over (`skill_load`)
   * or the engine loaded the skill folder itself (its own skill tool in the stream TeamBot reads).
   */
  used(agent: Pick<Agent, 'id' | 'user_id'>, skill: SkillRow, userId = agent.user_id) {
    this.ctx.store.exec('UPDATE skills SET use_count = use_count + 1, last_used_at = ? WHERE id = ?', now(), skill.id);
    this.ctx.audit(userId, 'skill.loaded', { skill: skill.name, rev: skill.active_rev, checksum: skill.checksum }, agent.id);
  }

  // ---------- after a change ----------
  /**
   * Set by the module: bring the skill folders in the work folders of this owner's bots up to date (workspace.ts).
   * Every write here that changes which skills a bot has, or what is in them, ends in it, so no install path can
   * forget it.
   */
  onChange: ((userId: string) => void) | null = null;
  private waiting: Set<string> | null = null;

  private changed(userId: string) {
    if (this.waiting) this.waiting.add(userId);
    else this.onChange?.(userId);
  }

  /** Several writes in one go (a pack of skills): the work folders are brought up to date once, at the end. */
  batch<T>(fn: () => T): T {
    if (this.waiting) return fn();
    const users = (this.waiting = new Set<string>());
    try {
      return fn();
    } finally {
      this.waiting = null;
      for (const u of users) this.onChange?.(u);
    }
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

  /** Uninstall: managed storage and enablement; the work folders follow (onChange). */
  remove(skill: SkillRow) {
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
      this.ctx.store.exec('DELETE FROM skill_offers WHERE skill_id = ?', skill.id);
      this.ctx.store.remove('skills', skill.id);
    });
    this.changed(skill.user_id);
  }

  // ---------- which skills a bot has ----------
  /** Set by the module (defaults.ts): put on a bot's list what it has and was not on it yet; the bot as stored now. */
  offer: ((agent: Pick<Agent, 'id' | 'user_id'>) => Agent | null) | null = null;

  /**
   * The one rule for which skills a bot has: the active skills of its team (those for all teams included, and to read
   * those of a team it may look into), minus the ones taken away from this bot. Sorted by name. The prompt, the tools,
   * the "/" menu and the skill folders in the work folder all read this.
   */
  enabledFor(agent: Agent): SkillRow[] {
    const off = this.takenAway(agent);
    return this.ofTeam(agent).filter((s) => !off.has(s.id));
  }

  private ofTeam(agent: Agent): SkillRow[] {
    const rows = this.ctx.store.all<any>("SELECT * FROM skills WHERE user_id = ? AND status = 'active' ORDER BY name", agent.user_id);
    return rows.map((r) => this.ctx.store.decode<SkillRow>('skills', r)).filter((s) => this.reach(agent, s) !== 'none');
  }

  /**
   * The skills taken away from a bot: once on its list (skill_offers keeps that) and no longer on it, also when that
   * was its last one. A skill that never was on its list was not taken away, so a new skill or a new bot needs nobody
   * to switch anything on.
   */
  takenAway(agent: Pick<Agent, 'id' | 'user_id'>): Set<string> {
    const cur = this.ctx.store.agent(agent.id);
    // A shared bot in a member's conversation is a copy with the member's id: nothing was taken away from that copy.
    if (!cur || cur.user_id !== agent.user_id) return new Set();
    const list = new Set(Array.isArray(cur.skills) ? cur.skills : []);
    return new Set(this.ctx.store.all<{ skill_id: string }>('SELECT skill_id FROM skill_offers WHERE agent_id = ?', cur.id).map((r) => r.skill_id).filter((id) => !list.has(id)));
  }

  /**
   * May the scripts of a skill be in this bot's work folder and run there: only a skill of its own team (or for all
   * teams) that the owner trusts. On "Volledige toegang" a script is a command like any other the bot may run.
   */
  scriptsFor(agent: Agent, skill: SkillRow): boolean {
    return skill.kind === 'scripts' && this.reach(agent, skill) === 'use' && (this.isTrusted(skill) || fullAccess(agent));
  }

  /**
   * The owner (or the bot itself) says which skills this bot has: of the skills its team has now, what is left out is
   * taken away from it and what is named is given (back). A skill that is switched off keeps its place on the list.
   */
  setAgentSkills(agent: Agent, ids: string[]): Agent {
    // First on its list what it has, so that leaving a skill out below is kept as "taken away".
    const cur = this.offer?.(agent) || this.ctx.store.agent(agent.id) || agent;
    const now = new Set(this.ofTeam(cur).map((s) => s.id));
    const list = [...new Set([...(cur.skills || []).filter((id) => !now.has(id) || ids.includes(id)), ...ids.filter((id) => now.has(id))])];
    const upd = this.ctx.store.updateAgent(agent.id, { skills: list });
    this.ctx.events.emit(agent.user_id, 'agent.updated', upd);
    return upd;
  }

  /** Give skills (back) to a bot; its other skills stay as they are. */
  giveSkills(agent: Agent, ids: string[]): Agent {
    return this.setAgentSkills(agent, [...this.enabledFor(agent).map((s) => s.id), ...ids]);
  }
}
