// Safe updates of TeamBot itself (package N, plan G "Updates van TeamBot zelf"): a backup before every install, the
// installers of the new and the running version kept, after the update "Wat is er nieuw" and a one-click way back
// that reinstalls the previous version and puts the pre-update backup back. With a fake updater and a fake installer:
// no installer ever runs on this pc (desktop/update-flow.ts has no Electron in it for exactly this reason).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startTestApp } from './helpers.js';
import { createApp } from '../server/app.js';
import backups from '../server/modules/backups/index.js';
import { applyPendingRestore } from '../server/modules/backups/restore.js';
import { UpdateFlow, ROLLBACK_ARGS, type UpdaterLike } from '../desktop/update-flow.js';
import { keepInstallerFile, keptInstaller, readUpdateState, recordStart, rollbackInfo, writeUpdateState } from '../server/modules/backups/updates.js';

/** Plays electron-updater: the same events, nothing downloaded or installed for real. */
class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowDowngrade = true;
  logger: unknown = null;
  feed: string | null = null;
  installs: { silent?: boolean; forceRun?: boolean }[] = [];
  constructor(private next: { version: string; file: string; sha512: string } | null) {
    super();
  }
  setFeedURL(o: { url: string }) {
    this.feed = o.url;
  }
  async checkForUpdates() {
    this.emit('checking-for-update');
    if (this.next) this.emit('update-available', { version: this.next.version, releaseNotes: 'Nieuw' });
    else this.emit('update-not-available', {});
  }
  async downloadUpdate() {
    const n = this.next!;
    this.emit('download-progress', { percent: 50 });
    this.emit('update-downloaded', { version: n.version, downloadedFile: n.file, files: [{ url: `TeamBot-Setup-${n.version}.exe`, sha512: n.sha512 }] });
  }
  quitAndInstall(silent?: boolean, forceRun?: boolean) {
    this.installs.push({ silent, forceRun });
  }
}

/** A file that looks like a Windows program ("MZ"), and its SHA-512 as latest.yml has it. */
function fakeExe(file: string, tag: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(4096), Buffer.from(tag)]);
  fs.writeFileSync(file, body);
  return crypto.createHash('sha512').update(body).digest('base64');
}

const tick = () => new Promise((r) => setTimeout(r, 20));

test('update: a backup first, the installers kept, and no install without that backup', async () => {
  const t = await startTestApp({ modules: [backups] });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-upd-'));
  const cur = t.app.ctx.config.version;
  const next = '99.0.1';
  // The update channel also has the installer of the running version (for the way back after the update).
  const served = path.join(tmp, 'feed', `TeamBot-Setup-${cur}.exe`);
  const curSha = fakeExe(served, 'huidig');
  const feed = http.createServer((req, res) => {
    if (req.url === `/TeamBot-Setup-${cur}.exe`) return void fs.createReadStream(served).pipe(res);
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => feed.listen(0, '127.0.0.1', () => r()));
  const feedUrl = `http://127.0.0.1:${(feed.address() as any).port}/`;
  try {
    const dl = path.join(tmp, 'pending', `TeamBot-Setup-${next}.exe`);
    const sha = fakeExe(dl, 'nieuw');
    const fake = new FakeUpdater({ version: next, file: dl, sha512: sha });
    const flow = new UpdateFlow({ updater: fake, version: cur, packaged: true, configDir: path.join(tmp, 'electron'), dataDir: t.dir, platform: 'win32', env: { TEAMBOT_UPDATE_URL: feedUrl } });
    assert.equal(fake.autoInstallOnAppQuit, false, 'electron-updater never installs on quit by itself (no backup then)');
    assert.equal(fake.allowDowngrade, false);
    assert.equal(fake.autoDownload, false);
    // "Alleen melden": found, and downloaded after a click (Automatisch bijwerken "aan" is tests/update-feed.test.ts).
    flow.save({ auto: 'notify' });
    assert.equal(fake.feed, feedUrl);
    await flow.check();
    assert.deepEqual(flow.state, { phase: 'available', version: next, notes: 'Nieuw' });
    await flow.download();
    assert.equal(flow.state.phase, 'ready');

    const r = await flow.prepareInstall((o) => t.app.ctx.services.backups.beforeUpdate(o));
    assert.equal(r.ok, true, r.error || "");
    const b = t.app.ctx.services.backups.list().find((x: any) => x.name === r.backup);
    assert.equal(b.kind, 'update');
    assert.deepEqual(b.update, { from: cur, to: next });
    assert.deepEqual(readUpdateState(t.dir).pending, { ...readUpdateState(t.dir).pending!, kind: 'update', from: cur, to: next, backup: r.backup });
    // Both installers are in the data folder, each with the checksum it was checked against.
    const kn = keptInstaller(t.dir, next)!;
    assert.equal(kn.sha512, sha);
    assert.equal(kn.source, 'update');
    const kc = keptInstaller(t.dir, cur)!;
    assert.equal(kc.sha512, curSha);
    assert.equal(kc.source, 'feed');
    assert.deepEqual(flow.info().safety.current, { version: cur, source: 'feed' });

    assert.equal(flow.install(), true);
    assert.deepEqual(fake.installs, [{ silent: true, forceRun: true }]);
    flow.stop();

    // A failing backup stops the update: nothing is installed and the owner is told.
    const notes: string[] = [];
    const fake2 = new FakeUpdater({ version: next, file: dl, sha512: sha });
    const flow2 = new UpdateFlow({ updater: fake2, version: cur, packaged: true, configDir: path.join(tmp, 'electron2'), dataDir: t.dir, platform: 'win32', env: { TEAMBOT_UPDATE_URL: feedUrl }, notify: (title) => notes.push(title) });
    flow2.start();
    await flow2.check();
    await flow2.download();
    const r2 = await flow2.prepareInstall(() => {
      throw new Error('schijf vol');
    });
    assert.equal(r2.ok, false);
    assert.equal(flow2.state.phase, 'error');
    assert.match((flow2.state as any).message, /back-up vóór het bijwerken lukte niet \(schijf vol\)/);
    assert.equal(flow2.install(), false);
    assert.deepEqual(fake2.installs, []);
    assert.ok(notes.includes('TeamBot is niet bijgewerkt'));
    flow2.stop();

    // A download that does not match latest.yml is never kept.
    const bad = path.join(tmp, 'bad.exe');
    fakeExe(bad, 'x');
    await assert.rejects(keepInstallerFile(t.dir, { version: '99.0.2', from: bad, expectSha512: sha, source: 'update' }), /controlesom/);
    fs.writeFileSync(bad, 'geen programma');
    await assert.rejects(keepInstallerFile(t.dir, { version: '99.0.2', from: bad, source: 'update' }), /geen installatieprogramma/);
  } finally {
    await new Promise((r) => feed.close(() => r(null)));
    await t.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('after the update: noted with its backup, what is new, and the way back restores the data and runs the old installer', async () => {
  const t = await startTestApp({ modules: [backups] });
  const dir = t.dir;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-upd-'));
  const cur = t.app.ctx.config.version;
  const prev = '0.0.9';
  let agentId = '';
  let backupName = '';
  try {
    const a = await t.agent({ name: 'Voor de update' });
    agentId = a.id;
    // What 0.0.9 did right before installing this version: a backup, its installer kept, a note of the update.
    backupName = (await t.app.ctx.services.backups.beforeUpdate({ from: prev, to: cur })).name;
    const exe = path.join(tmp, `TeamBot-Setup-${prev}.exe`);
    fakeExe(exe, 'oud');
    await keepInstallerFile(dir, { version: prev, from: exe, source: 'update' });
    writeUpdateState(dir, { lastVersion: prev, pending: { kind: 'update', from: prev, to: cur, at: new Date().toISOString(), backup: backupName }, history: [] });
    // Work done after the update.
    await t.api('PATCH', `/agents/${a.id}`, { name: 'Na de update' });
    await t.app.close();
  } catch (e) {
    await t.app.close().catch(() => {});
    throw e;
  }

  // TeamBot starts on the new version.
  const app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true, modules: [backups] });
  try {
    const owner = app.ctx.auth.owner()!.id;
    const st = readUpdateState(dir);
    assert.deepEqual({ ...st.history[0], at: undefined }, { kind: 'update', from: prev, to: cur, backup: backupName, at: undefined });
    assert.equal(st.pending, null);
    assert.ok(app.ctx.store.one("SELECT 1 FROM audit WHERE user_id = ? AND kind = 'backup.app_updated'", owner), 'noted in the log');
    const tok = app.ctx.auth.ensureLocalOwner();
    const get = async (p: string, method = 'GET') => (await fetch(`${app.url}/api${p}`, { method, headers: { authorization: `Bearer ${tok}` } })).json();
    const view = await get('/backups/updates');
    assert.equal(view.version, cur);
    assert.equal(view.rollback.available, true, JSON.stringify(view.rollback));
    assert.equal(view.rollback.to, prev);
    assert.equal(view.rollback.backup, backupName);
    assert.ok(Array.isArray(view.whatsNew));
    if (view.whatsNew.length) assert.equal(view.whatsNew[0].version, cur);
    assert.equal(view.seen, false);
    await get('/backups/updates/seen', 'POST');
    assert.equal((await get('/backups/updates')).seen, true);

    // "Terug naar versie 0.0.9": what the desktop shell does (desktop/main.ts), with a fake installer.
    const spawned: { file: string; args: string[] }[] = [];
    const flow = new UpdateFlow({ updater: new FakeUpdater(null), version: cur, packaged: true, configDir: path.join(tmp, 'electron'), dataDir: dir, platform: 'win32', spawnInstaller: (file, args) => spawned.push({ file, args }) });
    const svc = app.ctx.services.backups;
    const exists = (n: string) => svc.service.exists(n);
    const plan = await flow.startRollback(exists, (n) => svc.stageRestore(n, { reason: 'rollback' }));
    assert.equal(plan.to, prev);
    assert.ok(fs.existsSync(path.join(dir, 'restore-pending.db')), 'the pre-update backup is staged');
    assert.equal(readUpdateState(dir).pending?.kind, 'rollback');
    // will-quit: the server closes, the restore goes in place, then the kept installer of the old version runs.
    await app.close();
    applyPendingRestore(dir);
    assert.equal(await flow.finishRollback(), true);
    assert.deepEqual(spawned, [{ file: keptInstaller(dir, prev)!.file, args: ROLLBACK_ARGS }]);
    assert.deepEqual(ROLLBACK_ARGS, ['--updated', '/S', '--force-run']);
    assert.equal(await flow.finishRollback(), false, 'only once');
  } catch (e) {
    await app.close().catch(() => {});
    throw e;
  }

  // The installer started the old version: at its start it notes the way back (with the backup that was put back).
  const back = recordStart(dir, prev);
  assert.equal(back.changed?.kind, 'rollback');
  assert.equal(back.changed?.from, cur);
  assert.equal(back.changed?.backup, backupName);
  // The data is from right before the update; the state after it is kept as a safety copy.
  const db = new DatabaseSync(path.join(dir, 'teambot.db'), { readOnly: true });
  const row = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as any;
  db.close();
  assert.equal(row.name, 'Voor de update');
  const safety = fs.readdirSync(path.join(dir, 'backups')).filter((f) => /-replaced\.db$/.test(f));
  assert.equal(safety.length, 1, 'the state after the update is kept as a safety copy');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the way back is refused when the kept installer changed, and only where it can work', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-upd-'));
  try {
    const exe = path.join(dir, 'oud.exe');
    fakeExe(exe, 'oud');
    const k = await keepInstallerFile(dir, { version: '0.4.0', from: exe, source: 'update' });
    writeUpdateState(dir, { lastVersion: '0.4.1', history: [{ kind: 'update', from: '0.4.0', to: '0.4.1', at: new Date().toISOString(), backup: 'teambot-20261201-120000-update' }] });
    const exists = () => true;
    assert.equal(rollbackInfo(dir, '0.4.1', { desktop: true, platform: 'win32', backupExists: exists }).available, true);
    assert.match(rollbackInfo(dir, '0.4.1', { desktop: false, platform: 'win32', backupExists: exists }).reason!, /Windows-app/);
    assert.match(rollbackInfo(dir, '0.4.1', { desktop: true, platform: 'linux', backupExists: exists }).reason!, /Windows-app/);
    assert.match(rollbackInfo(dir, '0.4.1', { desktop: true, platform: 'win32', backupExists: () => false }).reason!, /back-up/);
    assert.match(rollbackInfo(dir, '0.4.2', { desktop: true, platform: 'win32', backupExists: exists }).reason!, /geen update/);

    const spawned: string[] = [];
    const flow = new UpdateFlow({ updater: new FakeUpdater(null), version: '0.4.1', packaged: true, configDir: path.join(dir, 'electron'), dataDir: dir, platform: 'win32', spawnInstaller: (f) => spawned.push(f) });
    let staged = 0;
    const plan = await flow.startRollback(exists, () => staged++);
    assert.equal(plan.to, '0.4.0');
    assert.equal(staged, 1);
    // The file is changed after it was planned: it does not run.
    fs.appendFileSync(k.file, 'anders');
    assert.equal(await flow.finishRollback(), false);
    assert.deepEqual(spawned, []);
    const again = await flow.planRollback(exists);
    assert.equal(again.ok, false);
    assert.match((again as any).reason, /veranderd/);
    await tick();

    // An update that did not happen is noticed at the next start.
    writeUpdateState(dir, { lastVersion: '0.4.1', pending: { kind: 'update', from: '0.4.1', to: '0.4.2', at: new Date().toISOString() }, history: [] });
    const r = recordStart(dir, '0.4.1');
    assert.equal(r.failed?.to, '0.4.2');
    assert.equal(readUpdateState(dir).failed?.to, '0.4.2');
    // A version installed by hand is noted too, as an update or a step back.
    assert.equal(recordStart(dir, '0.5.0').changed?.kind, 'update');
    assert.equal(recordStart(dir, '0.4.9').changed?.kind, 'rollback');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
