import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Updates of TeamBot itself: what ran last, which update or rollback is under way, the history, and the installers
 * kept for "Terug naar versie x". Shared by the server (backups module) and the desktop shell (desktop/update-flow.ts),
 * so no Ctx and no Electron here. Everything lives in `<data>/updates/`, which is never part of a backup: it belongs to
 * this computer and must survive a restore.
 *
 *   state.json                       { lastVersion, pending, history, seen }
 *   installers/TeamBot-Setup-<v>.exe the installer of a version (kept after a verified download)
 *   installers/TeamBot-Setup-<v>.json { version, sha512, size, keptAt, source }
 */

export interface UpdateEntry {
  kind: 'update' | 'rollback';
  from: string;
  to: string;
  at: string;
  /** Name of the backup made right before (update) or put back (rollback). */
  backup?: string;
}

export interface UpdatePending extends UpdateEntry {}

export interface UpdateState {
  lastVersion?: string;
  pending?: UpdatePending | null;
  history: UpdateEntry[];
  /** "Wat is er nieuw" of this version was seen. */
  seen?: string;
  /** The last update or rollback that did not happen (TeamBot started on the old version again). */
  failed?: (UpdatePending & { noticedAt: string }) | null;
}

export interface KeptInstaller {
  version: string;
  file: string;
  /** SHA-512, base64 (as in latest.yml). */
  sha512: string;
  size: number;
  keptAt: string;
  /** update: the file electron-updater downloaded and checked; feed: fetched from the update channel for a way back. */
  source: 'update' | 'feed';
}

export const updatesDir = (dataDir: string) => path.join(dataDir, 'updates');
const stateFile = (dataDir: string) => path.join(updatesDir(dataDir), 'state.json');
export const installersDir = (dataDir: string) => path.join(updatesDir(dataDir), 'installers');
const VERSION = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;
export const validVersion = (v: unknown): v is string => typeof v === 'string' && VERSION.test(v);

/** -1, 0 or 1 for x.y.z versions (a pre-release tag counts as lower than the release). */
export function compareVersions(a: string, b: string): number {
  const [ma, pa = ''] = a.split('-', 2);
  const [mb, pb = ''] = b.split('-', 2);
  const x = ma.split('.').map(Number);
  const y = mb.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  if (pa === pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  return pa > pb ? 1 : -1;
}

export function readUpdateState(dataDir: string): UpdateState {
  try {
    const j = JSON.parse(fs.readFileSync(stateFile(dataDir), 'utf8'));
    return { ...j, history: Array.isArray(j?.history) ? j.history : [] };
  } catch {
    return { history: [] };
  }
}

export function writeUpdateState(dataDir: string, s: UpdateState) {
  fs.mkdirSync(updatesDir(dataDir), { recursive: true });
  const f = stateFile(dataDir);
  fs.writeFileSync(f + '.tmp', JSON.stringify({ ...s, history: s.history.slice(0, 30) }, null, 1));
  fs.renameSync(f + '.tmp', f);
}

export function patchUpdateState(dataDir: string, fn: (s: UpdateState) => void): UpdateState {
  const s = readUpdateState(dataDir);
  fn(s);
  writeUpdateState(dataDir, s);
  return s;
}

/**
 * At every server start: did the version change since the last start? An update or rollback that the desktop shell
 * announced (`pending`) is recorded with its backup; a version change without it (installed by hand) as well. A
 * pending change for another version means it did not happen: TeamBot runs the old version again (`failed`).
 */
export function recordStart(dataDir: string, version: string, now = new Date()): { changed?: UpdateEntry; failed?: UpdatePending } {
  if (!validVersion(version)) return {};
  const out: { changed?: UpdateEntry; failed?: UpdatePending } = {};
  patchUpdateState(dataDir, (s) => {
    const pending = s.pending || null;
    if (s.lastVersion && s.lastVersion !== version) {
      const matches = pending && pending.to === version;
      out.changed = {
        kind: matches ? pending!.kind : compareVersions(version, s.lastVersion) > 0 ? 'update' : 'rollback',
        from: s.lastVersion,
        to: version,
        at: now.toISOString(),
        backup: matches ? pending!.backup : undefined,
      };
      s.history.unshift(out.changed);
      s.failed = null;
    } else if (pending && pending.to !== version) {
      out.failed = pending;
      s.failed = { ...pending, noticedAt: now.toISOString() };
    }
    s.pending = null;
    s.lastVersion = version;
  });
  return out;
}

// ---------------------------------------------------------------- kept installers

export const installerName = (version: string) => `TeamBot-Setup-${version}.exe`;

export async function sha512File(file: string): Promise<string> {
  const h = crypto.createHash('sha512');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('base64');
}

/** A Windows program starts with "MZ"; anything else is not an installer. */
export function looksLikeExe(file: string): boolean {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const b = Buffer.alloc(2);
      fs.readSync(fd, b, 0, 2, 0);
      return b.toString('latin1') === 'MZ';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

export function keptInstaller(dataDir: string, version: string): KeptInstaller | null {
  if (!validVersion(version)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(installersDir(dataDir), `TeamBot-Setup-${version}.json`), 'utf8'));
    const file = path.join(installersDir(dataDir), installerName(version));
    if (j?.version !== version || typeof j.sha512 !== 'string' || !fs.existsSync(file)) return null;
    return { ...j, file };
  } catch {
    return null;
  }
}

/**
 * Keep an installer in the data folder. `expectSha512` (from latest.yml) is checked when given; the recorded SHA-512
 * is checked again before the file ever runs. Only the installers of `keepVersions` stay (current and previous).
 */
export async function keepInstallerFile(dataDir: string, o: { version: string; from: string; expectSha512?: string; source: KeptInstaller['source']; keepVersions?: string[] }): Promise<KeptInstaller> {
  if (!validVersion(o.version)) throw new Error('Ongeldige versie');
  if (!looksLikeExe(o.from)) throw new Error('Dit is geen installatieprogramma voor Windows');
  const dir = installersDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, installerName(o.version));
  const part = dest + '.part';
  fs.copyFileSync(o.from, part);
  const sha512 = await sha512File(part);
  if (o.expectSha512 && o.expectSha512 !== sha512) {
    fs.rmSync(part, { force: true });
    throw new Error('Het installatiebestand klopt niet met de controlesom van het updatekanaal');
  }
  fs.renameSync(part, dest);
  const k: KeptInstaller = { version: o.version, file: dest, sha512, size: fs.statSync(dest).size, keptAt: new Date().toISOString(), source: o.source };
  const { file: _f, ...meta } = k;
  fs.writeFileSync(path.join(dir, `TeamBot-Setup-${o.version}.json`), JSON.stringify(meta, null, 1));
  if (o.keepVersions) pruneInstallers(dataDir, [...o.keepVersions, o.version]);
  return k;
}

export function pruneInstallers(dataDir: string, keep: string[]) {
  const dir = installersDir(dataDir);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const v = n.match(/^TeamBot-Setup-(.+?)\.(exe|json|exe\.part)$/)?.[1];
    if (v && !keep.includes(v)) fs.rmSync(path.join(dir, n), { force: true });
  }
}

/** Is the kept installer still the file that was checked when it was kept? */
export async function verifyKept(k: KeptInstaller): Promise<boolean> {
  try {
    return looksLikeExe(k.file) && fs.statSync(k.file).size === k.size && (await sha512File(k.file)) === k.sha512;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- the way back

export interface RollbackInfo {
  available: boolean;
  /** The version to go back to. */
  to?: string;
  /** The backup made right before the update (put back on the way back). */
  backup?: string;
  /** When the update happened. */
  since?: string;
  installer?: { version: string; size: number; source: KeptInstaller['source'] };
  /** Why there is no one-click way back (plain Dutch). */
  reason?: string;
}

/**
 * Can this computer go back to the version before the last update, with one click? Needs: the last change was an
 * update to the running version, the backup from right before it, and the kept installer of the older version.
 * Only the Windows desktop app (NSIS installer).
 */
export function rollbackInfo(dataDir: string, version: string, o: { desktop: boolean; platform?: string; backupExists(name: string): boolean }): RollbackInfo {
  const s = readUpdateState(dataDir);
  const last = s.history[0];
  if (!last || last.kind !== 'update' || last.to !== version) return { available: false, reason: 'Er is geen update om terug te draaien.' };
  const base = { to: last.from, backup: last.backup, since: last.at };
  if (!o.desktop || (o.platform || process.platform) !== 'win32') return { ...base, available: false, reason: 'Terug naar een vorige versie met één klik kan alleen in de Windows-app.' };
  if (!last.backup || !o.backupExists(last.backup)) return { ...base, available: false, reason: `De back-up van vlak voor de update naar ${version} is er niet (meer).` };
  const k = keptInstaller(dataDir, last.from);
  if (!k) return { ...base, available: false, reason: `Het installatiebestand van versie ${last.from} staat niet op deze computer. Installeer versie ${last.from} zelf en zet daarna de back-up van vlak voor de update terug.` };
  return { ...base, available: true, installer: { version: k.version, size: k.size, source: k.source } };
}
