// Automatic updates end to end (parity 16.2), with the real electron-updater (MIT) against a LOCAL static feed on this
// computer (port 4804, else any free port): `npm run release:feed` makes latest.yml + blockmap for a fake newer
// version, electron-updater's NsisUpdater finds it on the daily look, downloads it in the background and checks the
// sha512, and the update waits until nothing runs and the owner is away; then the backup comes first and the install
// is a stub. Nothing is installed or started: quitAndInstall and the NSIS install itself are replaced, the "installers"
// are random bytes behind "MZ", and every folder is a temporary one (never the owner's TeamBot or AppData).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import YAML from 'yaml';
import { startTestApp } from './helpers.js';
import backups from '../server/modules/backups/index.js';
import { updateBlockers } from '../server/modules/backups/app-update.js';
import { keptInstaller, readUpdateState } from '../server/modules/backups/updates.js';
import { UpdateFlow } from '../desktop/update-flow.js';
import { checkFeed, makeFeed } from '../scripts/release-feed.mjs';

const require = createRequire(import.meta.url);
const { NsisUpdater } = require('electron-updater');
const { HttpExecutor, configureRequestOptions, configureRequestUrl } = require('builder-util-runtime');

/** electron-updater talks through Electron's net module; outside Electron the same requests go through node:http. */
class NodeExecutor extends HttpExecutor {
  createRequest(options: any, callback: any) {
    return (options.protocol === 'https:' ? https : http).request(options, callback);
  }
  async download(url: URL, destination: string, options: any) {
    return options.cancellationToken.createPromise((resolve: any, reject: any, onCancel: any) => {
      const requestOptions: any = { headers: options.headers || undefined, redirect: 'manual' };
      configureRequestUrl(url, requestOptions);
      configureRequestOptions(requestOptions);
      (this as any).doDownload(requestOptions, { destination, options, onCancel, callback: (e: any) => (e == null ? resolve(destination) : reject(e)), responseHandler: null }, 0);
    });
  }
}

const fakeExe = (file: string, tag: string) => fs.writeFileSync(file, Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(256 * 1024), Buffer.from(tag)]));

async function listen(server: http.Server, port: number) {
  return new Promise<number>((resolve, reject) => {
    const onErr = (e: any) => {
      server.off('error', onErr);
      if (port && e?.code === 'EADDRINUSE') resolve(listen(server, 0));
      else reject(e);
    };
    server.once('error', onErr);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onErr);
      resolve((server.address() as any).port);
    });
  });
}

const until = async (fn: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`time-out: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

test('automatic update end to end: release:feed → local feed → daily look → background download → waits for idle → backup → install (stub)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-feed-'));
  const t = await startTestApp({ modules: [backups] });
  const cur = t.app.ctx.config.version;
  const next = '99.0.0';
  // ------------------------------------------------ the release: two fake installers, and the feed made from them
  const rel = path.join(tmp, 'release');
  fs.mkdirSync(rel, { recursive: true });
  fakeExe(path.join(rel, `TeamBot-Setup-${cur}.exe`), 'huidig');
  fakeExe(path.join(rel, `TeamBot-Setup-${next}.exe`), 'nieuw');
  const feedDir = path.join(tmp, 'feed');
  const made = await makeFeed({ dir: rel, out: feedDir, version: next, notes: false });
  assert.deepEqual(made.files.sort(), ['latest.yml', `TeamBot-Setup-${cur}.exe`, `TeamBot-Setup-${next}.exe`, `TeamBot-Setup-${next}.exe.blockmap`].sort());
  assert.equal(made.previous, cur, 'the installer of the running version goes along (the way back)');
  const yml = YAML.parse(fs.readFileSync(path.join(feedDir, 'latest.yml'), 'utf8'));
  assert.equal(yml.version, next);
  assert.equal(yml.path, `TeamBot-Setup-${next}.exe`);
  assert.equal(yml.files[0].sha512, crypto.createHash('sha512').update(fs.readFileSync(path.join(feedDir, yml.path))).digest('base64'));
  assert.equal(yml.files[0].size, fs.statSync(path.join(feedDir, yml.path)).size);
  assert.ok(fs.statSync(path.join(feedDir, `${yml.path}.blockmap`)).size > 0);
  assert.match(fs.readFileSync(path.join(feedDir, 'latest.yml'), 'utf8'), /^releaseDate: '\d{4}-\d\d-\d\dT[\d:.]+Z'$/m, 'quoted, as electron-builder writes it');
  assert.deepEqual(await checkFeed(feedDir), { ok: true, version: next, name: yml.path });
  // Signed afterwards (SignPath): the file changes, latest.yml no longer matches until release:feed runs again.
  fs.appendFileSync(path.join(rel, `TeamBot-Setup-${next}.exe`), 'handtekening');
  fs.copyFileSync(path.join(feedDir, 'latest.yml'), path.join(rel, 'latest.yml'));
  const stale = await checkFeed(rel);
  assert.equal(stale.ok, false);
  assert.match((stale as any).reason, /release:feed/);

  // ------------------------------------------------ a static web server on this computer that serves the folder
  const served: string[] = [];
  const feed = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname.slice(1));
    served.push(name);
    const f = path.join(feedDir, name);
    if (!name || name.includes('/') || name.includes('\\') || !fs.existsSync(f)) {
      res.statusCode = 404;
      return void res.end();
    }
    res.setHeader('content-length', fs.statSync(f).size);
    fs.createReadStream(f).pipe(res);
  });
  const port = await listen(feed, 4804);
  const channelUrl = `http://127.0.0.1:${port}/`;

  // ------------------------------------------------ the real electron-updater, outside Electron
  const appDir = path.join(tmp, 'app');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'app-update.yml'), `provider: generic\nurl: ${channelUrl}\nupdaterCacheDirName: teambot-updater-test\n`);
  const adapter = {
    version: cur,
    name: 'TeamBot',
    isPackaged: true,
    appUpdateConfigPath: path.join(appDir, 'app-update.yml'),
    userDataPath: path.join(tmp, 'userData'),
    baseCachePath: path.join(tmp, 'cache'),
    whenReady: () => Promise.resolve(),
    relaunch() {},
    quit() {},
    onQuit() {},
  };
  const nsis = new NsisUpdater(null, adapter);
  nsis.httpExecutor = new NodeExecutor();
  const installs: unknown[][] = [];
  // Never anything for real: the install of electron-updater and the NSIS start are both replaced.
  nsis.quitAndInstall = (...a: unknown[]) => void installs.push(a);
  nsis.doInstall = () => {
    throw new Error('never in a test');
  };

  let userIdle = 20; // the owner is at the computer
  let quitAsked = 0;
  const notes: string[] = [];
  const ctx = t.app.ctx;
  const flow = new UpdateFlow({
    updater: nsis,
    version: cur,
    packaged: true,
    configDir: path.join(tmp, 'electron'),
    dataDir: t.dir,
    platform: 'win32',
    env: {},
    // The channel built into the release (what builtInChannel reads from app-update.yml; http only for this computer).
    builtIn: { provider: 'generic', url: channelUrl },
    notify: (title) => notes.push(title),
    idleFacts: () => ({ busy: updateBlockers(ctx), userIdleSeconds: userIdle }),
    timing: { firstCheckMs: 10, tickMs: 60_000, idlePollMs: 40 },
    onChange: () => ctx.events.emit(ctx.auth.owner()!.id, 'app-update.changed', {}),
  });
  // As desktop/main.ts: an automatic install quits the app; will-quit makes the backup, then installs.
  flow.requestQuit = () => {
    quitAsked++;
    void flow.prepareInstall((o) => ctx.services.backups.beforeUpdate(o)).then((r) => r.ok && flow.install());
  };
  ctx.services.appUpdate = { info: () => flow.info(), check: () => flow.check(), download: () => flow.download(), installNow: () => flow.installNow(), save: (p: any) => flow.save(p) };

  try {
    // A bot at work when the update arrives: it waits for that too.
    const a = await t.agent({ name: 'Werker' });
    ctx.store.exec("INSERT INTO runs (id, thread_id, agent_id, user_id, status, created_at) VALUES ('run_busy', 'th_x', ?, ?, 'running', ?)", a.id, ctx.auth.owner()!.id, new Date().toISOString());

    flow.start();
    assert.equal((await t.api('GET', '/app-update')).auto, 'on', 'Automatisch bijwerken is on by default');
    // The daily look finds 99.0.0 and downloads it in the background (no click).
    await until(() => flow.state.phase === 'ready', 20_000, 'downloaded');
    assert.ok(served.includes('latest.yml') && served.includes(`TeamBot-Setup-${next}.exe`), served.join(', '));
    // Kept for the way back: the new installer (checked against latest.yml) and the running one, from the channel.
    await until(() => !!keptInstaller(t.dir, cur), 5000, 'current installer kept');
    assert.equal(keptInstaller(t.dir, next)!.sha512, yml.files[0].sha512);
    assert.equal(keptInstaller(t.dir, cur)!.source, 'feed');

    // Waits: a task runs and the owner is at the computer. The page (computer and phone) says so.
    await until(() => flow.waitingFor.length === 2, 5000, 'waiting reasons');
    const v1 = await t.api('GET', '/app-update');
    assert.equal(v1.state.phase, 'ready');
    assert.deepEqual(v1.waitingFor, [{ kind: 'runs', count: 1 }, { kind: 'user' }]);
    assert.equal(quitAsked, 0);
    assert.deepEqual(installs, []);
    assert.ok(notes.includes(`TeamBot ${next} staat klaar`));

    // The task is done; the owner is still there.
    ctx.store.exec("UPDATE runs SET status = 'done' WHERE id = 'run_busy'");
    await until(() => flow.waitingFor.length === 1, 5000, 'only the owner left');
    assert.deepEqual((await t.api('GET', '/app-update')).waitingFor, [{ kind: 'user' }]);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(quitAsked, 0, 'never while the owner works at the computer');

    // Away for a quarter of an hour: the backup first, then the (stubbed) install.
    userIdle = 16 * 60;
    await until(() => installs.length === 1, 5000, 'installed');
    assert.equal(quitAsked, 1);
    assert.deepEqual(installs[0], [true, true], 'silently, and TeamBot starts again');
    const pending = readUpdateState(t.dir).pending!;
    assert.equal(pending.kind, 'update');
    assert.equal(pending.to, next);
    const b = ctx.services.backups.list().find((x: any) => x.name === pending.backup);
    assert.equal(b?.kind, 'update', 'a backup made right before');
    assert.deepEqual(b.update, { from: cur, to: next });
    assert.ok(fs.existsSync(path.join(tmp, 'electron', 'update.json')), 'the check times are remembered');
    assert.ok(JSON.parse(fs.readFileSync(path.join(tmp, 'electron', 'update.json'), 'utf8')).lastCheckAt);
  } finally {
    flow.stop();
    delete ctx.services.appUpdate;
    await new Promise((r) => feed.close(() => r(null)));
    await t.close();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
