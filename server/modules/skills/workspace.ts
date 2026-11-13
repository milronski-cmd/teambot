import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Agent, Ctx } from '../../core/types.js';
import { safeRelPath } from './files.js';
import { MAX_DESCRIPTION, NAME_RE, buildSkillMd, parseSkillMd } from './format.js';
import type { SkillLibrary, SkillRow } from './library.js';
import { fileType } from './scan.js';
import { SOURCE_DIR } from './curated-source.js';
import { cleanLine } from './tools.js';

/**
 * The skills a bot has, as real skill folders in its work folder: `<werkmap>/.claude/skills/<naam>/` and
 * `<werkmap>/.agents/skills/<naam>/`, the places where Claude Code, Codex and OpenCode look for skills themselves
 * (name and description first, the text when a task asks for it). One function writes them (`sync`): what the bot has
 * by the rule of the library (`enabledFor`) is there, what it no longer has is gone.
 *
 * Only in a work folder TeamBot made for the bot (`owns`: its private folder in TeamBot's data or its werkplek in a
 * team folder, wherever that team folder is). A bot that works in a folder of the owner (his project) or of
 * another program gets nothing written there; an engine that can take skills from a folder of TeamBot (`plugin`
 * below, for Claude Code) gets them that way, every other engine keeps the list in its instructions and `skill_load`.
 *
 * TeamBot only touches what it wrote itself. Per place a small list file (`.teambot-skills.json`) says which folders
 * are TeamBot's and what was written in them; a folder that is not on it (the owner's own skill) or whose files no
 * longer match (the owner changed them) is left alone, and the owner is told once.
 *
 * Safety is the same as with `skill_load`: scripts are only written for a skill of the bot's own team that the owner
 * trusts (library `scriptsFor`), and the copy an engine reads is instructions only: no frontmatter that an engine
 * acts on by itself (rights for tools, hooks, another model) and no line that an engine would run while loading.
 */
export const SKILL_PLACES = ['.claude/skills', '.agents/skills'];
/** The name of the plugin for Claude Code (`plugin` below): it calls those skills `team:<naam>`. */
export const PLUGIN = 'team';
const LIST = '.teambot-skills.json';
/** The form of what is written; a higher number writes every folder again. */
const FORM = 1;

type Scripts = 'on' | 'untrusted' | 'team' | 'none';
interface Want {
  skill: SkillRow;
  scripts: Scripts;
  /** What decides the content of the folder: when it is the same as in the list file, nothing is written. */
  state: string;
}
interface Entry {
  id: string;
  state: string;
  /** Path → hash of what TeamBot wrote. */
  files: Record<string, string>;
}
interface ListFile {
  managedBy: 'TeamBot';
  skills: Record<string, Entry>;
  /** Folders with a skill's name that TeamBot left alone and told the owner about. */
  kept: Record<string, true>;
}

const hash = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 32);
const isScript = (rel: string, b: Buffer) => ['script', 'executable'].includes(fileType(rel, b));
const samePath = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

/**
 * SKILL.md as an engine reads it: the name and description (all an engine needs to find the skill), the instructions,
 * and TeamBot's own remarks about the scripts and files. Everything else in the frontmatter stays in the library.
 * `files`: where the other files of the skill are when they are not next to this file (a folder in the work folder,
 * or `tool`: only through TeamBot's skill_read_file).
 */
export function engineSkillMd(lib: SkillLibrary, skill: SkillRow, o: { scripts: Scripts; files?: string }): string {
  const body = parseSkillMd(lib.readSkillMd(skill), { fallbackName: skill.name })
    .body // "!`opdracht`" and a "```!" block are run by Claude Code while it loads a skill: here they are plain text.
    .replace(/!`/g, '`')
    .replace(/^([ \t]*`{3,})!/gm, '$1')
    .trim();
  const files = (lib.version(skill)?.scan.files || []).filter((f) => f.path !== 'SKILL.md');
  const scripts = files.filter((f) => f.type === 'script' || f.type === 'executable').map((f) => f.path);
  const here = o.files ? 'bij deze skill' : 'in deze map';
  const notes: string[] = [];
  if (o.files === 'tool' && files.length) notes.push(`De andere bestanden van deze skill (${files.slice(0, 20).map((f) => f.path).join(', ')}) lees je met de TeamBot-tool skill_read_file (naam: ${skill.name}).`);
  else if (o.files && files.length) notes.push(`De andere bestanden van deze skill staan in je werkmap, in de map ${o.files}/.`);
  if (files.some((f) => f.path.startsWith(SOURCE_DIR + '/'))) notes.push(`Verwijzingen naar ../ in deze skill staan in de map ${SOURCE_DIR}/ van de skillmap.`);
  if (scripts.length) {
    const named = scripts.slice(0, 10).join(', ');
    if (o.scripts === 'on') notes.push(`De scripts van deze skill staan aan (${named}). Voer een script uit met de TeamBot-tool skill_run_script: die draait het afgeschermd in je werkmap.`);
    else if (o.scripts === 'team') notes.push(`De scripts van deze skill (${named}) staan niet ${here}: de skill hoort bij een ander team. Je mag hem lezen, zijn scripts niet uitvoeren of naschrijven.`);
    else notes.push(`De scripts van deze skill (${named}) staan niet ${here}: ze staan uit (de eigenaar zet ze aan onder Veiligheid). Voer ze niet uit en schrijf ze niet na; doe het werk zonder de scripts.`);
  }
  return buildSkillMd({ name: skill.name, description: cleanLine(skill.description, MAX_DESCRIPTION) }, notes.length ? `${body}\n\n---\n${notes.map((n) => `[TeamBot] ${n}`).join('\n\n')}` : body);
}

function readList(file: string): ListFile | null {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j?.managedBy !== 'TeamBot' || !j.skills || typeof j.skills !== 'object') return null;
    return { managedBy: 'TeamBot', skills: j.skills, kept: j.kept && typeof j.kept === 'object' ? j.kept : {} };
  } catch {
    return null;
  }
}

/** Are the files TeamBot wrote in this folder still as it wrote them? (What the owner added next to them does not count.) */
function untouched(target: string, e: Entry): boolean {
  for (const [rel, h] of Object.entries(e.files || {})) {
    const safe = safeRelPath(rel);
    if (!safe) return false;
    try {
      if (hash(fs.readFileSync(path.join(target, ...safe.split('/')))) !== h) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function writeFiles(target: string, files: Map<string, Buffer>) {
  for (const [rel, buf] of files) {
    const f = path.join(target, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, buf);
  }
}

/** Remove files TeamBot wrote, and the folders that are empty after that; anything else in them stays. */
function removeFiles(target: string, rels: string[]) {
  const base = path.resolve(target);
  const dirs = new Set<string>([base]);
  for (const r of rels) {
    const safe = safeRelPath(r);
    if (!safe) continue;
    const f = path.resolve(base, ...safe.split('/'));
    if (!f.startsWith(base + path.sep)) continue;
    const st = fs.lstatSync(f, { throwIfNoEntry: false });
    if (st?.isFile() || st?.isSymbolicLink()) fs.unlinkSync(f);
    for (let d = path.dirname(f); d.startsWith(base + path.sep); d = path.dirname(d)) dirs.add(d);
  }
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    try {
      fs.rmdirSync(d); // only succeeds when empty
    } catch {
      /* not empty or gone: keep */
    }
  }
}

export class SkillWorkspace {
  constructor(
    private ctx: Ctx,
    private lib: SkillLibrary,
  ) {}

  /**
   * Is the bot's work folder one that TeamBot made for it: its private folder under TeamBot's data, or its own
   * werkplek in a team folder (Teammap\<bot>, what every bot made in the screens or through the API gets)? Only there
   * TeamBot writes skill folders: never in a folder of the owner or of another program that a bot was pointed at.
   */
  owns(agent: Agent): boolean {
    // The bot's own folder as it is stored with the bot, never asked from the modules that add folders (asking the
    // teams module for a bot's folders gives a bot without a team its team); the folders module only compares paths.
    if (!agent.workspace) return false;
    if (samePath(agent.workspace).startsWith(samePath(path.join(this.ctx.config.dataDir, 'workspaces')) + path.sep)) return true;
    return this.ctx.services.folders?.isWerkplek?.(agent) === true;
  }

  /** What a bot's work folder should hold: its skills by name, its own team's first. */
  private wanted(agent: Agent): Map<string, Want> {
    const out = new Map<string, Want>();
    const mine = this.lib.enabledFor(agent);
    const own = (s: SkillRow) => this.lib.reach(agent, s) === 'use';
    // A skill of another team with the same name (meekijken) never takes the place of the bot's own.
    for (const s of [...mine.filter(own), ...mine.filter((x) => !own(x))]) {
      if (!NAME_RE.test(s.name) || out.has(s.name)) continue;
      const scripts: Scripts = s.kind !== 'scripts' ? 'none' : this.lib.scriptsFor(agent, s) ? 'on' : own(s) ? 'untrusted' : 'team';
      out.set(s.name, { skill: s, scripts, state: `${FORM}:${s.checksum}:${scripts}` });
    }
    return out;
  }

  private files(w: Want): Map<string, Buffer> {
    const out = new Map<string, Buffer>();
    for (const [p, b] of this.lib.readFiles(w.skill)) {
      const rel = safeRelPath(p);
      if (!rel || /^skill\.md$/i.test(rel) || (isScript(rel, b) && w.scripts !== 'on')) continue;
      out.set(rel, b);
    }
    out.set('SKILL.md', Buffer.from(engineSkillMd(this.lib, w.skill, { scripts: w.scripts }), 'utf8'));
    return out;
  }

  /** One place (`.claude/skills` or `.agents/skills`). Returns the folders it left alone and did not tell about yet. */
  private syncPlace(dir: string, wanted: Map<string, Want>): string[] {
    const listFile = path.join(dir, LIST);
    const stored = readList(listFile);
    if (!wanted.size && !stored) return [];
    const list: ListFile = stored || { managedBy: 'TeamBot', skills: {}, kept: {} };
    const before = JSON.stringify(list);
    const tell: string[] = [];

    // What the bot no longer has: TeamBot's files go. A folder the owner changed is his from now on.
    for (const [name, e] of Object.entries(list.skills)) {
      if (wanted.get(name)?.skill.id === e.id) continue;
      const target = path.join(dir, name);
      if (untouched(target, e)) removeFiles(target, Object.keys(e.files));
      else if (fs.existsSync(target)) tell.push(name);
      delete list.skills[name];
    }
    for (const name of Object.keys(list.kept)) if (!wanted.has(name)) delete list.kept[name];

    for (const [name, w] of wanted) {
      const target = path.join(dir, name);
      const e = list.skills[name];
      const there = fs.existsSync(target);
      if (e && e.state === w.state && there) continue;
      // Not written by TeamBot, or changed since: never written over.
      if (there && (!e || !untouched(target, e))) {
        if (!list.kept[name]) tell.push(name);
        list.kept[name] = true;
        continue;
      }
      try {
        const files = this.files(w);
        if (e) removeFiles(target, Object.keys(e.files).filter((p) => !files.has(p)));
        writeFiles(target, files);
        list.skills[name] = { id: w.skill.id, state: w.state, files: Object.fromEntries([...files].map(([rel, buf]) => [rel, hash(buf)])) };
        delete list.kept[name];
      } catch (err) {
        this.ctx.log.warn('[skills] skill folder not written', target, String(err));
      }
    }

    if (!Object.keys(list.skills).length && !Object.keys(list.kept).length) {
      fs.rmSync(listFile, { force: true });
      removeFiles(dir, []);
      removeFiles(path.dirname(dir), []);
    } else if (JSON.stringify(list) !== before) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(listFile + '.tmp', JSON.stringify(list, null, 1));
      fs.renameSync(listFile + '.tmp', listFile);
    }
    return tell;
  }

  /** The copies of before this version (`.skills/<naam>/`, only made for trusted skills with scripts): TeamBot's files go. */
  private removeOldCopies(root: string) {
    const old = path.join(root, '.skills');
    let names: string[] = [];
    try {
      names = fs.readdirSync(old);
    } catch {
      return;
    }
    for (const name of names) {
      const marker = path.join(old, name, '.teambot-skill.json');
      try {
        const mk = JSON.parse(fs.readFileSync(marker, 'utf8'));
        if (mk?.managedBy !== 'TeamBot') continue;
        fs.unlinkSync(marker);
        removeFiles(path.join(old, name), Array.isArray(mk.files) ? mk.files : []);
      } catch {
        /* no marker: not TeamBot's */
      }
    }
  }

  /**
   * Bring the skill folders in a bot's work folder up to date with the skills it has now. Called where that answer
   * changes (a skill installed, changed, trusted, switched or removed; a bot made, changed or moved) and right before a
   * CLI engine starts in the folder. Never throws: a folder that cannot be written is logged, the rest goes on.
   */
  sync(agent: Agent) {
    try {
      const root = path.resolve(agent.workspace || '');
      if (!agent.workspace || !fs.existsSync(root)) return;
      // A folder that is no longer one TeamBot made for this bot (the owner gave it a second bot as well): TeamBot
      // takes away what it wrote there itself (its list file says what), and writes nothing new.
      const own = this.owns(agent);
      if (own) this.removeOldCopies(root);
      const wanted = own ? this.wanted(agent) : new Map<string, Want>();
      const kept = SKILL_PLACES.flatMap((place) => this.syncPlace(path.join(root, ...place.split('/')), wanted).map((name) => `${place}/${name}`));
      if (kept.length) {
        this.ctx.events.emit(agent.user_id, 'notification', {
          title: `Skillmap van ${agent.name} niet overschreven`,
          // One whole sentence per form, never "is de map"/"zijn de mappen" as a value.
          body:
            kept.length === 1
              ? `In de werkmap van ${agent.name} is de map ${kept[0]} zelf gemaakt of aangepast. TeamBot laat die staan en schrijft er niet overheen. Wil je de versie van TeamBot, verwijder of hernoem de map dan.`
              : `In de werkmap van ${agent.name} zijn de mappen ${kept.join(', ')} zelf gemaakt of aangepast. TeamBot laat ze staan en schrijft er niet overheen. Wil je de versie van TeamBot, verwijder of hernoem de mappen dan.`,
          link: '#/m/skills/mine',
          kind: 'skill',
        });
      }
    } catch (e) {
      this.ctx.log.error('[skills] work folder not brought up to date', agent.id, e);
    }
  }

  /**
   * The bot's skills as a plugin folder for one run of Claude Code, which loads the skills of such a folder like those
   * of the work folder. For the two cases where the work folder cannot serve: Claude Code's restricted mode (it skips
   * the work folder's skills) and a work folder that is not TeamBot's own. `dir` is a folder of TeamBot that the bot
   * cannot write in; it holds the SKILL.md of every skill, the other files are read from the work folder or with
   * skill_read_file. Returns nothing when the bot has no skills.
   */
  plugin(agent: Agent, dir: string): string | null {
    const wanted = this.wanted(agent);
    if (!wanted.size) return null;
    const own = this.owns(agent);
    writeFiles(dir, new Map([['.claude-plugin/plugin.json', Buffer.from(JSON.stringify({ name: PLUGIN, description: 'De skills van het team', version: '1.0.0' }))]]));
    for (const [name, w] of wanted) writeFiles(path.join(dir, 'skills', name), new Map([['SKILL.md', Buffer.from(engineSkillMd(this.lib, w.skill, { scripts: w.scripts, files: own ? `${SKILL_PLACES[0]}/${name}` : 'tool' }))]]));
    return dir;
  }

  private runs(agentId: string) {
    return path.join(this.ctx.config.dataDir, 'skill-runs', agentId);
  }

  /**
   * The folder a script of a skill runs from: a fresh copy of the skill in TeamBot's own data, so what runs is what
   * the owner trusts, never a file that was changed in a work folder.
   */
  scriptDir(agent: Agent, skill: SkillRow): { dir: string } | { error: string } {
    const w = this.wanted(agent).get(skill.name);
    if (!w || w.skill.id !== skill.id || w.scripts !== 'on' || !/^[A-Za-z0-9_-]{1,80}$/.test(agent.id)) return { error: `De scripts van skill ${skill.name} zijn er voor jou niet.` };
    const dir = path.join(this.runs(agent.id), skill.name);
    fs.rmSync(dir, { recursive: true, force: true });
    writeFiles(dir, this.files(w));
    return { dir };
  }

  /** A bot is gone: so are the copies its scripts ran from. */
  forget(agentId: string) {
    if (/^[A-Za-z0-9_-]{1,80}$/.test(agentId)) fs.rmSync(this.runs(agentId), { recursive: true, force: true });
  }
}
