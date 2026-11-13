import path from 'node:path';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';
import { HttpError } from '../../core/http.js';
import { type FileMap, LIMITS, checksumOf, isSkillMd, safeRelPath } from './files.js';
import { classifyId, classifyText } from './licenses.js';
import { parseSkillMd } from './format.js';
import { CURATED_LIMITS, type RuleResult, quoteDescription, ruleForContent, ruleForPath } from './import-rules.js';
import type { CuratedSkill, CuratedSource } from './curated.js';
import { type TextDiff, diffText } from './textdiff.js';
import { type WebCache, WebError } from './webcache.js';

/**
 * Reading a pinned catalogue skill from GitHub: the repository tree at the pinned commit (one API call, kept for a
 * year: a commit never changes), then only the files of that skill from raw.githubusercontent.com, each checked
 * against the git blob hash in the tree. Updates compare blob hashes between two trees first, so an unchanged skill
 * costs no downloads. Nothing fetched here is ever executed.
 *
 * Without the API (GitHub allows 60 calls an hour without a token, shared by everything on the same address; a new
 * user has no token): the same tree is read from the archive of that commit (codeload.github.com, no such limit), so
 * installing a skill works right after installing TeamBot. The blob hashes are computed from the archive itself.
 */

export interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

export interface RepoAccess {
  /**
   * The files of a commit. `archiveFirst`: read them from the archive of that commit instead of the API (for skills
   * outside TeamBot's catalogue: the hourly API limit is left for searching; the archive is often in the cache already).
   */
  tree(repo: string, commit: string, archiveFirst?: boolean): Promise<TreeEntry[]>;
  blob(repo: string, commit: string, entry: TreeEntry): Promise<Buffer>;
  /** Latest commit of the default branch (for update checks). */
  head(repo: string, force?: boolean): Promise<{ commit: string | null; error: string | null }>;
}

const YEAR = 365 * 24 * 3600_000;
const SHA_RE = /^[0-9a-f]{40}$/;
/** Git's hash of an empty file. */
const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
/** Where files referenced from outside the skill folder are stored in the installed skill. */
export const SOURCE_DIR = '_bron';

export function gitBlobSha(buf: Buffer) {
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

/** The tree of a commit read from its archive: the same entries the API gives, with the file contents by blob hash. */
export function treeFromZip(buf: Buffer): { tree: TreeEntry[]; blobs: Map<string, Buffer> } {
  const entries = new AdmZip(buf).getEntries();
  const first = entries[0]?.entryName.split('/')[0] || '';
  // A GitHub archive has one top folder (<repo>-<commit>); it is not part of the paths.
  const top = first && entries.every((e) => e.entryName.startsWith(first + '/')) ? first + '/' : '';
  const tree: TreeEntry[] = [];
  const blobs = new Map<string, Buffer>();
  for (const e of entries) {
    const p = e.entryName.slice(top.length).replace(/[/]+$/, '');
    if (!p || e.isDirectory) continue;
    const data = e.getData();
    const unix = (e.header.attr >>> 16) & 0xffff;
    const mode = (unix & 0o170000) === 0o120000 ? '120000' : unix & 0o111 ? '100755' : '100644';
    const sha = gitBlobSha(data);
    blobs.set(sha, data);
    tree.push({ path: p, mode, type: 'blob', sha, size: data.length });
  }
  return { tree, blobs };
}

/** GitHub access through the marketplace cache (SSRF-safe fetcher, ETag, offline fallback). */
export function githubAccess(cache: WebCache, o: { headers: () => Record<string, string>; head: (repo: string, force?: boolean) => Promise<{ commit: string | null; error: string | null }> }): RepoAccess {
  /** Files of the last archives read (by blob hash), so `blob` needs no second download. */
  const fromZip = new Map<string, Buffer>();
  const archive = async (repo: string, commit: string): Promise<TreeEntry[]> => {
    const hit = await cache.buffer(`zip:${repo}@${commit}`, `https://codeload.github.com/${repo}/zip/${commit}`, { ttlMs: 30 * 24 * 3600_000, maxBytes: LIMITS.maxZipBytes, timeoutMs: 60_000 });
    const z = treeFromZip(hit.data);
    if (fromZip.size > 5000) fromZip.clear();
    for (const [sha, b] of z.blobs) if (b.length <= CURATED_LIMITS.maxFileBytes) fromZip.set(sha, b);
    return z.tree;
  };
  return {
    async tree(repo, commit, archiveFirst) {
      if (!SHA_RE.test(commit)) throw new HttpError(400, 'Ongeldige commit.');
      if (archiveFirst) {
        try {
          return await archive(repo, commit);
        } catch (err) {
          // Too large for an archive download: the API after all (only the files of the skill are fetched then).
          if (!(err instanceof WebError) || err.code !== 'too-large') throw err;
        }
      }
      let hit;
      try {
        hit = await apiTree(repo, commit);
      } catch (err) {
        // The API said no (its hourly limit, or it cannot be reached): the archive of the same commit has the same files.
        if (!(err instanceof WebError) || !['rate-limited', 'network', 'bad-response'].includes(err.code)) throw err;
        try {
          return await archive(repo, commit);
        } catch {
          throw err;
        }
      }
      return hit;
    },
    async blob(repo, commit, e) {
      const have = fromZip.get(e.sha);
      if (have) return have;
      return apiBlob(repo, commit, e);
    },
    head: (repo, force) => o.head(repo, force),
  };

  async function apiTree(repo: string, commit: string): Promise<TreeEntry[]> {
    {
      const hit = await cache.json<any>(`ctree:${repo}@${commit}`, `https://api.github.com/repos/${repo}/git/trees/${commit}?recursive=1`, { ttlMs: YEAR, headers: o.headers(), accept: 'application/vnd.github+json', timeoutMs: 15_000 });
      const list: any[] = Array.isArray(hit.data?.tree) ? hit.data.tree : [];
      if (hit.data?.truncated) throw new HttpError(502, `De bestandslijst van ${repo} is te groot om volledig op te halen.`);
      return list
        .filter((t) => t && typeof t.path === 'string' && typeof t.sha === 'string' && ['blob', 'tree', 'commit'].includes(t.type))
        .map((t) => ({ path: String(t.path), mode: String(t.mode || ''), type: t.type, sha: String(t.sha), size: typeof t.size === 'number' ? t.size : undefined }));
    }
  }
  async function apiBlob(repo: string, commit: string, e: TreeEntry): Promise<Buffer> {
    {
      // An empty file needs no download (and raw.githubusercontent.com sometimes answers 501 for one).
      if (e.sha === EMPTY_BLOB) return Buffer.alloc(0);
      const url = `https://raw.githubusercontent.com/${repo}/${commit}/${e.path.split('/').map(encodeURIComponent).join('/')}`;
      const get = () => cache.buffer(`blob:${e.sha}`, url, { ttlMs: YEAR, maxBytes: CURATED_LIMITS.maxFileBytes + 1, timeoutMs: 20_000 });
      try {
        return (await get()).data;
      } catch (err) {
        // One retry for a passing hiccup of the CDN; a second failure is reported.
        if (err instanceof HttpError || (err instanceof WebError && err.code !== 'network' && err.code !== 'bad-response')) throw err;
        await new Promise((r) => setTimeout(r, 400));
        return (await get()).data;
      }
    }
  }
}

/**
 * A skill hosted by ClawHub (`<owner>/<slug>`), read like a repository at a commit: its pin is a version, and the zip
 * of that version gives the same list of files with their hashes (so the import rules, the stored `seen` hashes and
 * the comparison with a newer version are the ones of a GitHub skill). `head` gives the latest version.
 */
export function clawhubAccess(cache: WebCache, o: { origin: string; head: (name: string, force?: boolean) => Promise<{ commit: string | null; error: string | null }> }): RepoAccess {
  const fromZip = new Map<string, Buffer>();
  return {
    async tree(name, version) {
      const [owner, slug] = name.split('/');
      if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(version) || !owner || !slug) throw new HttpError(400, 'Ongeldige versie.');
      const url = `${o.origin}/api/v1/download?slug=${encodeURIComponent(slug)}&ownerHandle=${encodeURIComponent(owner)}&version=${encodeURIComponent(version)}`;
      const hit = await cache.buffer(`clawhub-zip:${name}@${version}`, url, { ttlMs: YEAR, maxBytes: LIMITS.maxZipBytes, timeoutMs: 60_000 });
      const z = treeFromZip(hit.data);
      if (fromZip.size > 5000) fromZip.clear();
      for (const [sha, b] of z.blobs) if (b.length <= CURATED_LIMITS.maxFileBytes) fromZip.set(sha, b);
      return z.tree;
    },
    async blob(_name, _version, e) {
      const have = fromZip.get(e.sha);
      if (!have) throw new HttpError(502, `Bestand ${e.path} staat niet in het archief van deze versie.`);
      return have;
    },
    head: (name, force) => o.head(name, force),
  };
}

export interface FileNote {
  path: string;
  reason: string;
}

export interface ResolvedLicense {
  spdx: string | null;
  status: 'open' | 'restricted' | 'unknown';
  /** Upstream path of the licence file that applies. */
  file: string | null;
  /** Where it is stored in the installed skill. */
  storedAs: string | null;
  matches: boolean;
  problem: string | null;
}

export interface Resolved {
  commit: string;
  files: FileMap;
  /** Installed path → upstream path and blob hash. */
  upstream: Record<string, { p: string; s: string }>;
  /** Every upstream file looked at (path → blob hash): what an update is compared with. */
  seen: Record<string, string>;
  dropped: FileNote[];
  refused: FileNote[];
  license: ResolvedLicense;
  /** Files taken along from outside the skill folder (upstream paths). */
  sourceFiles: string[];
  description: { changed: boolean; repaired: boolean; error?: string };
  /** SKILL.md as the source wrote it, when its description was rewritten (the safety scan reads this one). */
  sourceMd: Buffer | null;
  /** What the source itself warns about this skill (the moderation of a skill library), in its own words. */
  sourceWarning?: string;
  checksum: string;
  /** Everything that blocks installing, in plain Dutch. */
  problems: string[];
}

const LICENSE_FILE = /^(licen[cs]e|copying)(\.(txt|md|markdown|rst))?$/i;
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** Relative links in a Markdown text that leave the file's own folder (`../x.md`, `../../shared/y.md`). */
export function parentLinks(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|[\s(\[`'"<])((?:\.\.\/)+[A-Za-z0-9_\-./]+)/g)) {
    const link = m[1].replace(/[.,;:)\]`'"]+$/, '').split('#')[0];
    if (link && !link.endsWith('/')) out.add(link);
  }
  return [...out];
}

export async function resolveSkill(access: RepoAccess, source: CuratedSource, skill: CuratedSkill, commit: string, o: { archiveFirst?: boolean } = {}): Promise<Resolved> {
  const repo = source.repo;
  const tree = await access.tree(repo, commit, o.archiveFirst);
  const byPath = new Map(tree.map((e) => [e.path, e]));
  const pre = skill.path ? skill.path + '/' : '';
  const mdEntry = tree.find((e) => e.type === 'blob' && e.path.startsWith(pre) && isSkillMd(e.path.slice(pre.length)) && !e.path.slice(pre.length).includes('/'));
  if (!mdEntry) throw new HttpError(404, `Geen SKILL.md gevonden in ${repo}${skill.path ? '/' + skill.path : ''} (commit ${commit.slice(0, 7)}).`);
  // Other skills inside this folder are separate skills: not part of this one.
  const nested = tree
    .filter((e) => e.type === 'blob' && isSkillMd(path.posix.basename(e.path)) && e.path !== mdEntry.path && e.path.startsWith(pre))
    .map((e) => dirOf(e.path) + '/');
  const own = tree.filter((e) => e.type !== 'tree' && e.path.startsWith(pre) && !nested.some((n) => e.path.startsWith(n)));
  const dropped: FileNote[] = [];
  const refused: FileNote[] = [];
  const files: FileMap = new Map();
  const upstream: Resolved['upstream'] = {};
  const seen: Record<string, string> = {};
  /**
   * Path rules first (nothing is downloaded for a hidden file, a link or a program), then the kept files are
   * downloaded a few at a time, each checked against its blob hash and the content rules, in a stable order.
   */
  const takeAll = async (list: { e: TreeEntry; rel: string }[]): Promise<boolean[]> => {
    const kept: number[] = [];
    list.forEach(({ e }, i) => {
      seen[e.path] = e.sha;
      const r: RuleResult = ruleForPath(pre && e.path.startsWith(pre) ? e.path.slice(pre.length) : e.path, { mode: e.mode, type: e.type, size: e.size });
      if (r.action === 'keep') kept.push(i);
      else (r.action === 'drop' ? dropped : refused).push({ path: e.path, reason: r.reason! });
    });
    const bufs = new Map<number, Buffer>();
    let next = 0;
    const worker = async () => {
      while (next < kept.length) {
        const i = kept[next++];
        bufs.set(i, await access.blob(repo, commit, list[i].e));
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, kept.length) }, worker));
    const ok = list.map(() => false);
    for (const i of kept) {
      const { e, rel } = list[i];
      const buf = bufs.get(i)!;
      if (gitBlobSha(buf) !== e.sha) {
        refused.push({ path: e.path, reason: 'De gedownloade inhoud klopt niet met de vastgezette versie.' });
        continue;
      }
      const c = ruleForContent(rel, buf);
      if (c.action !== 'keep') {
        (c.action === 'drop' ? dropped : refused).push({ path: e.path, reason: c.reason! });
        continue;
      }
      files.set(rel, buf);
      upstream[rel] = { p: e.path, s: e.sha };
      ok[i] = true;
    }
    return ok;
  };
  const ownList: { e: TreeEntry; rel: string }[] = [];
  for (const e of own.sort((a, b) => a.path.localeCompare(b.path))) {
    const rel = e === mdEntry ? 'SKILL.md' : e.path.slice(pre.length);
    if (!safeRelPath(rel)) {
      seen[e.path] = e.sha;
      refused.push({ path: e.path, reason: 'Onveilige bestandsnaam.' });
      continue;
    }
    if (ownList.length >= CURATED_LIMITS.maxFiles) {
      refused.push({ path: e.path, reason: `Te veel bestanden (maximaal ${CURATED_LIMITS.maxFiles}).` });
      break;
    }
    ownList.push({ e, rel });
  }
  await takeAll(ownList);

  // Files linked from outside the folder (`../../shared/x.md`), inside the declared root: taken along under _bron/.
  const root = skill.root ?? '';
  const rootPre = root ? root + '/' : '';
  const sourceFiles: string[] = [];
  const wanted = new Set<string>();
  for (const [rel, buf] of [...files]) {
    if (!/\.(md|markdown|txt)$/i.test(rel)) continue;
    const from = dirOf(pre + rel);
    for (const link of parentLinks(buf.toString('utf8'))) {
      const target = path.posix.normalize(path.posix.join(from || '.', link));
      if (target.startsWith('../') || target === '..' || (pre && target.startsWith(pre))) continue;
      if (rootPre && !target.startsWith(rootPre)) continue;
      wanted.add(target);
    }
  }
  const srcList: { e: TreeEntry; rel: string }[] = [];
  for (const target of [...wanted].sort()) {
    const e = byPath.get(target);
    if (!e || e.type !== 'blob') continue;
    // A link to another skill's SKILL.md: that is a separate skill (installable on its own), not a reference file.
    if (isSkillMd(path.posix.basename(target))) continue;
    if (srcList.length >= CURATED_LIMITS.maxSourceFiles) break;
    const rel = `${SOURCE_DIR}/${target.slice(rootPre.length)}`;
    if (!safeRelPath(rel) || files.has(rel)) continue;
    srcList.push({ e, rel });
  }
  (await takeAll(srcList)).forEach((ok, i) => ok && sourceFiles.push(srcList[i].e.path));

  // The licence that applies to this folder: the nearest licence file from the skill folder up to the repository root.
  // A short pointer file ("MIT License - see repository root LICENSE") is not a licence text: keep looking up.
  const license: ResolvedLicense = { spdx: null, status: 'unknown', file: null, storedAs: null, matches: false, problem: null };
  const dirs: string[] = [];
  for (let d = skill.path; ; d = dirOf(d)) {
    dirs.push(d);
    if (!d) break;
  }
  outer: for (const d of dirs) {
    const dp = d ? d + '/' : '';
    const cands = tree.filter((e) => e.type === 'blob' && e.path.startsWith(dp) && !e.path.slice(dp.length).includes('/') && LICENSE_FILE.test(path.posix.basename(e.path))).sort((a, b) => a.path.localeCompare(b.path));
    for (const e of cands) {
      if ((e.size ?? 0) > CURATED_LIMITS.maxFileBytes) continue;
      const inSkill = e.path.startsWith(pre) && upstream[e.path.slice(pre.length)]?.p === e.path;
      const buf = inSkill ? files.get(e.path.slice(pre.length))! : await access.blob(repo, commit, e);
      if (!inSkill && gitBlobSha(buf) !== e.sha) continue;
      seen[e.path] = e.sha;
      const c = classifyText(buf.toString('utf8'));
      if (c.status === 'unknown') continue;
      license.spdx = c.spdx;
      license.status = c.status;
      license.file = e.path;
      if (inSkill) license.storedAs = e.path.slice(pre.length);
      else {
        const name = files.has('LICENSE.txt') ? (files.has('LICENSE-repo.txt') ? null : 'LICENSE-repo.txt') : 'LICENSE.txt';
        if (name) {
          files.set(name, buf);
          upstream[name] = { p: e.path, s: e.sha };
          license.storedAs = name;
        }
      }
      break outer;
    }
  }
  // The catalogue names the licence TeamBot checked; a skill outside the catalogue has none to compare with: what is
  // found is recorded and shown, and is no reason to refuse (as with a skill added by its address).
  const expected = source.license;
  license.matches = license.status === 'open' && (!expected || license.spdx === expected);
  const md = files.get('SKILL.md');
  const fmLicense = md ? classifyId(parseSkillMd(md.toString('utf8')).meta.license) : null;
  if (!expected) {
    if (license.status === 'unknown' && fmLicense && fmLicense.status !== 'unknown') Object.assign(license, { spdx: fmLicense.spdx, status: fmLicense.status, matches: fmLicense.status === 'open' });
  } else if (license.status === 'unknown') license.problem = 'Geen licentiebestand gevonden voor deze map. Zonder licentie installeert TeamBot niets.';
  else if (license.status === 'restricted') license.problem = 'De licentie bij de bron staat hergebruik niet vrij toe.';
  else if (!license.matches) license.problem = `De licentie bij de bron (${license.spdx}) is niet meer die van de catalogus (${source.license}).`;
  else if (fmLicense && fmLicense.status !== 'unknown' && fmLicense.spdx !== source.license) license.problem = `SKILL.md noemt een andere licentie (${fmLicense.label}) dan het licentiebestand (${source.license}).`;
  if (license.problem) license.matches = false;

  // The description as one quoted YAML string.
  let description: Resolved['description'] = { changed: false, repaired: false };
  let sourceMd: Buffer | null = null;
  if (md) {
    const fix = quoteDescription(md.toString('utf8'));
    description = { changed: fix.changed && !fix.error, repaired: fix.repaired && !fix.error, ...(fix.error ? { error: fix.error } : {}) };
    if (fix.changed && !fix.error) {
      files.set('SKILL.md', Buffer.from(fix.text, 'utf8'));
      sourceMd = md;
    }
  }

  let total = 0;
  for (const b of files.values()) total += b.length;
  const problems: string[] = [];
  for (const r of refused) problems.push(`${r.path}: ${r.reason}`);
  if (total > CURATED_LIMITS.maxSkillBytes) problems.push(`De skill is te groot (${total} bytes, maximaal ${CURATED_LIMITS.maxSkillBytes}).`);
  if (license.problem) problems.push(license.problem);
  if (description.error) problems.push(description.error);
  return { commit, files, upstream, seen, dropped, refused, license, sourceFiles, description, sourceMd, checksum: checksumOf(files), problems };
}

/**
 * Did the upstream files of an installed skill change between its commit and `tree` (a newer commit)? Compares blob
 * hashes only: every upstream file looked at during install (kept, left out, licence, files from outside the folder),
 * plus any new file in the skill folder.
 */
export function upstreamChanges(seen: Record<string, string>, skill: CuratedSkill, tree: TreeEntry[]): string[] {
  const byPath = new Map(tree.map((e) => [e.path, e]));
  const changed: string[] = [];
  const known = new Set<string>();
  for (const [p, s] of Object.entries(seen)) {
    known.add(p);
    const e = byPath.get(p);
    if (!e) changed.push(`${p} (verwijderd)`);
    else if (e.sha !== s) changed.push(p);
  }
  const pre = skill.path ? skill.path + '/' : '';
  const nested = tree.filter((e) => e.type === 'blob' && isSkillMd(path.posix.basename(e.path)) && e.path.startsWith(pre) && dirOf(e.path) !== skill.path).map((e) => dirOf(e.path) + '/');
  for (const e of tree) {
    if (e.type === 'tree' || !e.path.startsWith(pre) || known.has(e.path) || nested.some((n) => e.path.startsWith(n))) continue;
    if (ruleForPath(e.path.slice(pre.length), { mode: e.mode, type: e.type }).action === 'drop') continue;
    changed.push(`${e.path} (nieuw)`);
  }
  return changed;
}

export interface FileDiff {
  path: string;
  status: 'added' | 'removed' | 'changed';
  diff: TextDiff;
}

/** Per-file differences between the installed files and a proposed new version (all files are text by the rules). */
export function diffFiles(oldFiles: FileMap, newFiles: FileMap): { files: FileDiff[]; added: number; removed: number; changed: number; unchanged: number } {
  const paths = [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort((a, b) => (a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : a.localeCompare(b)));
  const out: FileDiff[] = [];
  let unchanged = 0;
  for (const p of paths) {
    const a = oldFiles.get(p);
    const b = newFiles.get(p);
    if (a && b && a.equals(b)) {
      unchanged++;
      continue;
    }
    const status: FileDiff['status'] = !a ? 'added' : !b ? 'removed' : 'changed';
    out.push({ path: p, status, diff: diffText(a ? a.toString('utf8') : '', b ? b.toString('utf8') : '', { maxLines: 300 }) });
  }
  return { files: out.slice(0, 200), added: out.filter((f) => f.status === 'added').length, removed: out.filter((f) => f.status === 'removed').length, changed: out.filter((f) => f.status === 'changed').length, unchanged };
}
