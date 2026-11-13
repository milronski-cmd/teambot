import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Ctx } from '../../core/types.js';
import { HttpError } from '../../core/http.js';
import { type FileMap, filesFromDir, findSkillRoots, subset } from './files.js';
import { ALL_TEAMS, type Analysis, type Placement, type SkillLibrary, type SkillRow, type SourceInfo, analyze } from './library.js';
import { diffPermissions, ownerLooksFirst } from './scan.js';
import { skillSubstance } from './substance.js';
import { MANIFEST_FILE, type PackageVerification } from '../../../packages/teambot-sdk/src/index.js';
import type { SignatureView } from '../../../shared/skills.js';
import { auditOverride, builtinView, decide, infoOf, publisherChange, verifyFiles, viewOf } from './publishers.js';
import { type PublisherCheck, checkPublisher, githubOwnerOf } from './import-rules.js';

/** Publisher check of a GitHub source: a look-alike of a known organisation is flagged and must be acknowledged. */
export function publisherCheckOf(source: SourceInfo): PublisherCheck | null {
  const gh = githubOwnerOf(source);
  return gh ? checkPublisher(gh.owner, gh.repo) : null;
}

export interface Candidate {
  key: string;
  root: string;
  /** Skill files without teambot-package.json (that is verified and stored separately). */
  files: FileMap;
  analysis: Analysis;
  source: SourceInfo;
  catalogRef?: string | null;
  /** Signature verification at staging time; the trust list is applied whenever it is viewed or committed. */
  verified: PackageVerification | 'builtin';
}

export interface Staging {
  id: string;
  userId: string;
  createdAt: number;
  label: string;
  candidates: Candidate[];
  /** Where the owner installs these (one team or all teams; package B4). Unset = all teams (callers from before teams). */
  placement?: Placement;
}

const TTL = 30 * 60_000;
const MAX_PER_USER = 6;

/** Standard skill folders of other agent tools (owner only; read for preview, never modified). */
export function discoverDirs(): { tool: string; dir: string }[] {
  const home = os.homedir();
  const out = [
    { tool: 'Claude Code', dir: path.join(home, '.claude', 'skills') },
    { tool: 'Agents', dir: path.join(home, '.agents', 'skills') },
    { tool: 'Codex', dir: path.join(home, '.codex', 'skills') },
  ];
  const extra = process.env.TEAMBOT_SKILLS_DISCOVER;
  if (extra)
    for (const d of extra.split(path.delimiter).filter(Boolean)) {
      out.push({ tool: 'Extra map', dir: path.resolve(d) });
      // a project folder in which `npx skills add` ran: its skills live in .agents/skills
      if (fs.existsSync(path.join(d, PROJECT_LOCK))) out.push({ tool: 'Extra map', dir: path.resolve(d, '.agents', 'skills') });
    }
  if (process.env.TEAMBOT_SKILLS_DISCOVER_ONLY === '1') return out.filter((o) => o.tool === 'Extra map');
  return out;
}

// ---- skills installed with `npx skills` (vercel-labs/skills, MIT: only its lock-file format is read) ----

const PROJECT_LOCK = 'skills-lock.json';
const GLOBAL_LOCK = '.skill-lock.json';

export interface LockedSkill {
  name: string;
  /** "owner/repo" (GitHub), a URL or a local path, as the skills CLI wrote it. */
  source: string;
  sourceType: string;
  sourceUrl: string;
}

const lockText = (v: unknown, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** One lock file: the project `skills-lock.json` or the global `~/.agents/.skill-lock.json` ({ version, skills: { name: {…} } }). */
export function readSkillsLock(file: string): LockedSkill[] {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 2_000_000) return [];
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const skills = j && typeof j === 'object' && j.skills && typeof j.skills === 'object' && !Array.isArray(j.skills) ? j.skills : {};
    return Object.entries(skills)
      .filter(([name, v]) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) && v && typeof v === 'object')
      .slice(0, 500)
      .map(([name, v]: [string, any]) => ({ name, source: lockText(v.source), sourceType: lockText(v.sourceType, 40), sourceUrl: lockText(v.sourceUrl, 1000) }));
  } catch {
    return [];
  }
}

/**
 * Lock entries for the skills in a skill folder: `<x>/.agents/.skill-lock.json` next to `<x>/.agents/skills` (global) and
 * `<project>/skills-lock.json` above `<project>/.agents/skills` (project). Other tools' folders (.claude/skills) often
 * hold links to the same skills; those are matched by name.
 */
export function locksFor(dir: string): Map<string, LockedSkill> {
  const out = new Map<string, LockedSkill>();
  const parent = path.dirname(dir);
  const files = [path.join(parent, GLOBAL_LOCK), path.join(path.dirname(parent), PROJECT_LOCK)];
  // links in another tool's folder (~/.claude/skills) to globally installed skills
  if (process.env.TEAMBOT_SKILLS_DISCOVER_ONLY !== '1') files.push(path.join(os.homedir(), '.agents', GLOBAL_LOCK));
  for (const f of files) for (const s of readSkillsLock(f)) if (!out.has(s.name)) out.set(s.name, s);
  return out;
}

/** Where a locked skill came from, as a source TeamBot knows (a GitHub repo gets the publisher check). */
export function lockedSource(lock: LockedSkill, name: string, full: string): SourceInfo {
  const gh = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(lock.source);
  const url = /^https:\/\//i.test(lock.sourceUrl) ? lock.sourceUrl.replace(/\.git$/, '') : gh && (!lock.sourceType || lock.sourceType === 'github') ? `https://github.com/${gh[1]}/${gh[2]}` : undefined;
  return { type: 'discover', label: `npx skills: ${name}${lock.source ? ` (${lock.source})` : ''}`, path: full, ...(url ? { url } : {}) };
}

export interface CommitOptions {
  keys?: string[];
  acknowledge?: boolean;
  confirmPermissions?: boolean;
  enableFor?: string[];
  createdBy?: string;
  overridePolicy?: boolean;
  confirmPublisherChange?: boolean;
  placement?: Placement;
}

export class Importer {
  private stagings = new Map<string, Staging>();
  constructor(private ctx: Ctx, private lib: SkillLibrary) {}

  private sweep() {
    const t = Date.now();
    for (const [id, s] of this.stagings) if (t - s.createdAt > TTL) this.stagings.delete(id);
  }

  /**
   * Stage skills for review. A `teambot-package.json` next to SKILL.md is verified here (signature, file
   * hashes, compatibility) and then removed from the skill's own files; `builtin` is only ever set by the
   * server for items of the built-in catalog.
   */
  stage(userId: string, label: string, items: { files: FileMap; root: string; source: SourceInfo; fallbackName?: string; catalogRef?: string | null; builtin?: boolean }[]): Staging {
    this.sweep();
    const mine = [...this.stagings.values()].filter((s) => s.userId === userId).sort((a, b) => a.createdAt - b.createdAt);
    while (mine.length >= MAX_PER_USER) this.stagings.delete(mine.shift()!.id);
    if (!items.length) throw new HttpError(400, 'Geen skill gevonden: er staat geen SKILL.md in.');
    const st: Staging = {
      id: 'stg_' + crypto.randomBytes(12).toString('hex'),
      userId,
      createdAt: Date.now(),
      label,
      candidates: items.slice(0, 100).map((it, i) => {
        const verified: Candidate['verified'] = it.builtin ? 'builtin' : verifyFiles(this.ctx, it.files, 'skill');
        const files: FileMap = new Map([...it.files].filter(([p]) => p !== MANIFEST_FILE));
        const analysis = analyze(files, it.fallbackName || path.posix.basename(it.root || '') || '');
        analysis.package = verified === 'builtin' || verified.manifest ? infoOf(verified, { keepManifest: true }) : null;
        if (verified !== 'builtin' && verified.manifest && verified.manifest.name !== analysis.parsed.meta.name) analysis.warnings = [...analysis.warnings, `De pakketnaam (${verified.manifest.name}) verschilt van de skillnaam (${analysis.parsed.meta.name}).`];
        return { key: String(i), root: it.root, files, analysis, source: it.source, catalogRef: it.catalogRef, verified };
      }),
    };
    this.stagings.set(st.id, st);
    return st;
  }

  signatureOf(c: Candidate): SignatureView {
    return c.verified === 'builtin' ? builtinView() : viewOf(this.ctx, c.verified);
  }

  /** Find every SKILL.md in a file collection (optionally inside `subdir`) and stage each as a candidate. */
  stageFiles(userId: string, files: FileMap, source: SourceInfo, opts: { subdir?: string; fallbackName?: string } = {}): Staging {
    let fm = files;
    if (opts.subdir) {
      const pre = opts.subdir.replace(/^\/+|\/+$/g, '') + '/';
      fm = new Map([...files].filter(([p]) => p.startsWith(pre)).map(([p, b]) => [p.slice(pre.length), b]));
      if (!fm.size) throw new HttpError(400, `Map ${opts.subdir} niet gevonden.`);
    }
    const roots = findSkillRoots(fm);
    if (!roots.length) throw new HttpError(400, 'Geen SKILL.md gevonden. Een skill is een map met een SKILL.md-bestand.');
    return this.stage(
      userId,
      source.label || source.type,
      roots.map((r) => ({ files: subset(fm, r, roots), root: r, source: { ...source, path: source.path && r ? `${source.path}/${r}` : source.path }, fallbackName: r ? path.posix.basename(r) : opts.fallbackName })),
    );
  }

  /**
   * Scan the standard skill folders of other tools. Skills installed with `npx skills` are recognised by its lock file
   * (their origin is shown and a GitHub source gets the publisher check); like every import they go through the
   * safety scan and are switched on for no bot. The same skill linked into several folders is offered once.
   */
  stageDiscover(userId: string): Staging {
    const items: { files: FileMap; root: string; source: SourceInfo; fallbackName: string }[] = [];
    const seen = new Set<string>();
    for (const { tool, dir } of discoverDirs()) {
      if (!fs.existsSync(dir)) continue;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      const locks = locksFor(dir);
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        let full = path.join(dir, e.name);
        if (e.isSymbolicLink()) {
          // `npx skills` links a skill into each tool's folder (a junction on Windows): read the real folder
          try {
            full = fs.realpathSync(full);
            if (!fs.statSync(full).isDirectory()) continue;
          } catch {
            continue;
          }
        } else if (!e.isDirectory()) continue;
        if (!fs.existsSync(path.join(full, 'SKILL.md')) && !fs.existsSync(path.join(full, 'skill.md'))) continue;
        let real = full;
        try {
          real = fs.realpathSync(full);
        } catch {
          /* keep */
        }
        const key = process.platform === 'win32' ? real.toLowerCase() : real;
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          const files = filesFromDir(full);
          const roots = findSkillRoots(files);
          const own = subset(files, '', roots);
          const lock = locks.get(e.name);
          const source: SourceInfo = lock ? lockedSource(lock, e.name, full) : { type: 'discover', label: `${tool}: ${e.name}`, path: full };
          items.push({ files: own, root: e.name, source, fallbackName: e.name });
        } catch (err: any) {
          this.ctx.log.warn('[skills] discover skip', full, err?.message);
        }
        if (items.length >= 100) break;
      }
    }
    if (!items.length) throw new HttpError(404, `Geen skills gevonden in ${discoverDirs().map((d) => d.dir).join(', ')}.`);
    return this.stage(userId, 'Gevonden op deze computer', items);
  }

  get(userId: string, id: string): Staging {
    this.sweep();
    const s = this.stagings.get(String(id));
    if (!s || s.userId !== userId) throw new HttpError(404, 'Deze voorvertoning is verlopen. Begin de import opnieuw.');
    return s;
  }

  /** Set where these candidates go (the owner's team choice); returns the staging for chaining. */
  place(st: Staging, p: Placement): Staging {
    st.placement = p;
    return st;
  }

  candidateView(userId: string, c: Candidate, p: Placement = ALL_TEAMS) {
    const a = c.analysis;
    const m = a.parsed.meta;
    // Per team (package B4): what this install updates is the skill with this name in the chosen team (or for all).
    const existing = m.name ? this.lib.existingFor(userId, m.name, p) : null;
    const clash = m.name && !existing ? this.lib.nameConflict(userId, m.name, p) : null;
    const activeV = existing ? this.lib.version(existing) : null;
    const diff = diffPermissions(activeV?.permissions, a.permissions);
    let action: 'create' | 'update' | 'unchanged' | 'add-version' = 'create';
    if (existing) action = activeV?.checksum === a.checksum ? 'unchanged' : existing.pinned ? 'add-version' : 'update';
    const md = c.files.get('SKILL.md')?.toString('utf8') || '';
    const signature = this.signatureOf(c);
    const policy = decide(this.ctx, this.ctx.store.user(userId), signature);
    const change = existing && action !== 'unchanged' ? publisherChange(existing.package, signature) : null;
    const pub = publisherCheckOf(c.source);
    const lookalike = pub?.status === 'lookalike';
    return {
      key: c.key,
      root: c.root,
      name: m.name,
      description: m.description,
      version: m.version,
      license: m.license,
      author: m.author,
      homepage: m.homepage,
      dependencies: m.dependencies,
      platforms: m.platforms,
      compatibility: m.compatibility,
      allowedTools: m.allowedTools,
      errors: a.errors,
      warnings: lookalike && pub?.reason ? [pub.reason, ...a.warnings] : a.warnings,
      publisherCheck: pub,
      scan: { level: a.scan.level, kind: a.scan.kind, labels: a.scan.labels, findings: a.scan.findings, files: a.scan.files.map((f) => ({ path: f.path, size: f.size, type: f.type })), domains: a.scan.domains },
      permissions: a.permissions,
      checksum: a.checksum,
      size: a.size,
      fileCount: a.fileCount,
      skillMd: md.length > 200_000 ? md.slice(0, 200_000) : md,
      source: c.source,
      existing: existing ? { id: existing.id, version: existing.version, rev: existing.active_rev, pinned: existing.pinned } : null,
      /** A same-named skill elsewhere that this install would clash with (installing for all teams while a team has one). */
      nameClash: clash ? `Je hebt al een skill met de naam "${m.name}"${this.lib.whereText(clash)}.` : null,
      action,
      diff,
      needsConfirmation: action === 'update' && diff.elevated,
      needsAcknowledge: ownerLooksFirst(a.scan) || lookalike,
      substance: skillSubstance(md, [...c.files.keys()], m.name),
      signature,
      policy,
      publisherChange: change,
      needsPublisherConfirmation: !!change,
    };
  }

  /** The preview. `placement` (the owner's team choice) is kept on the staging for the commit. */
  view(userId: string, st: Staging, placement?: Placement) {
    if (placement) st.placement = placement;
    const p = st.placement || ALL_TEAMS;
    const team = p.scope === 'team' ? this.lib.placementFor(userId, p.teamId || '', 'default') : ALL_TEAMS;
    return {
      stagingId: st.id,
      label: st.label,
      expiresAt: new Date(st.createdAt + TTL).toISOString(),
      /** Where these go: a team id, or '*' for all teams (package B4). */
      teamId: team.scope === 'team' ? team.teamId : '*',
      candidates: st.candidates.map((c) => this.candidateView(userId, c, p)),
    };
  }

  /** Install what was staged. A pack of skills is one change: the bots' work folders follow once, at the end. */
  commit(userId: string, stagingId: string, o: CommitOptions) {
    return this.lib.batch(() => this.commitEach(userId, stagingId, o));
  }

  private commitEach(userId: string, stagingId: string, o: CommitOptions) {
    const st = this.get(userId, stagingId);
    // One team or all teams (package B4); without a choice, as before teams: all teams.
    const placement = o.placement || st.placement || ALL_TEAMS;
    const selected = o.keys?.length ? st.candidates.filter((c) => o.keys!.includes(c.key)) : st.candidates;
    if (!selected.length) throw new HttpError(400, 'Kies minstens één skill.');
    const agents = (o.enableFor || []).map((id) => this.ctx.store.agent(id)).filter((a) => a && a.user_id === userId) as NonNullable<ReturnType<Ctx['store']['agent']>>[];
    const me = this.ctx.store.user(userId);
    const results: any[] = [];
    const touched: SkillRow[] = [];
    for (const c of selected) {
      const a = c.analysis;
      const name = a.parsed.meta.name;
      if (a.errors.length) {
        results.push({ key: c.key, name, status: 'error', error: a.errors[0] });
        continue;
      }
      // Publisher policy (server-side, on top of the scan/checksum/trust/permission rules below).
      const sig = this.signatureOf(c);
      const decision = decide(this.ctx, me, sig);
      if (decision.blocked) {
        results.push({ key: c.key, name, status: 'blocked', error: decision.reason });
        continue;
      }
      if (decision.needsOverride && !o.overridePolicy) {
        results.push({ key: c.key, name, status: 'needs-policy-override', error: decision.reason });
        continue;
      }
      const pub = publisherCheckOf(c.source);
      if (pub?.status === 'lookalike' && !o.acknowledge) {
        results.push({ key: c.key, name, status: 'needs-acknowledge', error: `${pub.reason} Bevestig dat je deze bron vertrouwt.`, publisherCheck: pub });
        continue;
      }
      // A dangerous script is information (it is in the scan the owner and the bot see); what a bot reads waits for him.
      if (ownerLooksFirst(a.scan) && !o.acknowledge) {
        results.push({ key: c.key, name, status: 'needs-acknowledge', error: 'Deze skill heeft ernstige waarschuwingen. Bevestig dat je ze gelezen hebt.' });
        continue;
      }
      const sigAudit = { signature: sig.state, publisher: sig.declaredPublisher || undefined, fingerprint: sig.fingerprint || undefined };
      try {
        const existing = this.lib.existingFor(userId, name, placement);
        const change = existing && this.lib.version(existing)?.checksum !== a.checksum ? publisherChange(existing.package, sig) : null;
        if (change && !o.confirmPublisherChange) {
          results.push({ key: c.key, name, status: 'needs-publisher-confirmation', error: change.reason, publisherChange: change });
          continue;
        }
        if (existing) {
          const r = this.lib.addRevision(existing, c.files, a, { source: c.source, createdBy: o.createdBy || 'import', activate: !existing.pinned, confirmPermissions: o.confirmPermissions, catalogRef: c.catalogRef });
          const status = r.status === 'activated' ? 'updated' : r.status === 'added' ? 'version-added' : r.status;
          results.push({ key: c.key, name, status, skillId: existing.id, rev: r.rev, diff: r.diff, ...(status === 'needs-confirmation' ? { error: 'Deze versie vraagt meer rechten. Bekijk de wijzigingen en bevestig.' } : {}) });
          if (status !== 'needs-confirmation') {
            // A new version keeps what the owner chose: scripts that were on are on for the new scripts too.
            if (status === 'updated' && existing.trusted_scripts) this.lib.installed(r.skill);
            touched.push(r.skill);
            this.ctx.audit(userId, 'skill.updated', { skill: name, rev: r.rev, status, source: c.source.type, elevated: r.diff.elevated, ...sigAudit });
            if (change && status !== 'unchanged') this.ctx.audit(userId, 'package.publisher_changed', { what: 'skill', item: name, from: change.from, to: change.to });
            if (decision.needsOverride && status !== 'unchanged') auditOverride(this.ctx, userId, sig, decision, 'skill', name);
          }
        } else {
          const s = this.lib.create(userId, c.files, a, { source: c.source, createdBy: o.createdBy || 'import', catalogRef: c.catalogRef, placement });
          this.lib.installed(s);
          results.push({ key: c.key, name, status: 'created', skillId: s.id, rev: 1 });
          touched.push(s);
          this.ctx.audit(userId, 'skill.imported', { skill: name, source: c.source.type, label: c.source.label, checksum: a.checksum, scan: a.scan.level, kind: a.scan.kind, ...sigAudit });
          if (decision.needsOverride) auditOverride(this.ctx, userId, sig, decision, 'skill', name);
        }
      } catch (e: any) {
        results.push({ key: c.key, name, status: 'error', error: e?.message || String(e) });
      }
    }
    // A bot of another team (without access) does not get a team's skill: said in the answer, never silently.
    const notEnabled: { agentId: string; name: string; skill: string }[] = [];
    for (const ag of agents) {
      const fresh = this.ctx.store.agent(ag.id)!;
      const give: string[] = [];
      for (const s of touched) {
        if (s.status !== 'active') continue;
        if (this.lib.reach(fresh, s) === 'none') notEnabled.push({ agentId: fresh.id, name: fresh.name, skill: s.name });
        else give.push(s.id);
      }
      // A new skill is the bot's without this; what was taken away from it before is given back here.
      const off = this.lib.takenAway(fresh);
      if (give.some((id) => off.has(id))) this.lib.giveSkills(fresh, give);
    }
    if (results.every((r) => !['needs-confirmation', 'needs-acknowledge', 'needs-policy-override', 'needs-publisher-confirmation', 'error'].includes(r.status))) this.stagings.delete(st.id);
    if (touched.length) this.ctx.events.emit(userId, 'skills.updated', { ids: touched.map((s) => s.id) });
    return notEnabled.length ? { results, notEnabled } : { results };
  }
}
