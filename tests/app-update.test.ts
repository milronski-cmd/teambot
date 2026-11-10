// Automatic updates wired up (parity 16.2): /api/app-update for Instellingen › Back-ups (computer and phone), the
// three settings for a normal person (aan / alleen melden / uit), "Nu bijwerken", the calm sentence without a channel,
// the channel computer-only (policy.ts COMPUTER_ONLY), the daily look, and the way back that is not undone by itself.
// A fake electron-updater (same events); nothing is downloaded or installed. The real electron-updater against a local
// feed is tests/update-feed.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestApp, type TestApp } from './helpers.js';
import { UpdateFlow, type UpdaterLike } from '../desktop/update-flow.js';
import { writeUpdateState } from '../server/modules/backups/updates.js';
import { updateBlockers } from '../server/modules/backups/app-update.js';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowDowngrade = true;
  logger: unknown = null;
  feed: any = null;
  checks = 0;
  downloads = 0;
  installs = 0;
  constructor(public next: string | null) {
    super();
  }
  setFeedURL(o: any) {
    this.feed = o;
  }
  async checkForUpdates() {
    this.checks++;
    this.emit('checking-for-update');
    if (this.next) this.emit('update-available', { version: this.next });
    else this.emit('update-not-available', {});
  }
  async downloadUpdate() {
    this.downloads++;
    this.emit('download-progress', { percent: 40 });
    this.emit('update-downloaded', { version: this.next, files: [{ url: `TeamBot-Setup-${this.next}.exe` }] });
  }
  quitAndInstall() {
    this.installs++;
  }
}

/** A flow as desktop/main.ts makes it, registered for the server's routes. */
function wire(t: TestApp, o: { next?: string | null; env?: NodeJS.ProcessEnv; builtIn?: any; userIdle?: () => number } = {}) {
  const ctx = t.app.ctx;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-appupd-'));
  const fake = new FakeUpdater(o.next ?? null);
  const quits: string[] = [];
  const flow = new UpdateFlow({
    updater: fake,
    version: ctx.config.version,
    packaged: true,
    configDir: dir,
    dataDir: t.dir,
    platform: 'win32',
    env: o.env || {},
    builtIn: o.builtIn ?? null,
    idleFacts: () => ({ busy: updateBlockers(ctx), userIdleSeconds: o.userIdle ? o.userIdle() : 0 }),
    timing: { firstCheckMs: 60_000, tickMs: 60_000, idlePollMs: 30 },
  });
  flow.requestQuit = () => void quits.push((flow.state as any).version);
  ctx.services.appUpdate = { info: () => flow.info(), check: () => flow.check(), download: () => flow.download(), installNow: () => flow.installNow(), save: (p: any) => flow.save(p) };
  flow.start();
  return {
    flow,
    fake,
    quits,
    dir,
    done() {
      flow.stop();
      delete ctx.services.appUpdate;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function pairPhone(t: TestApp) {
  const ticket = await t.api('POST', '/mobile/pair', { baseUrl: 'http://192.168.1.5:4761' });
  const secret = new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('t');
  const claim = await fetch(t.app.url + '/api/public/mobile/claim', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': IPHONE_UA }, body: JSON.stringify({ secret, name: 'Telefoon' }) });
  const token = (await claim.json()).token as string;
  return async (method: string, p: string, body?: any) => {
    const r = await fetch(t.app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
  };
}

test('no updater (a server, or a dev server): the page says calmly how new versions come; nothing to click', async () => {
  const t = await startTestApp();
  const s = await startTestApp({ mode: 'server' });
  try {
    const v = await t.api('GET', '/app-update');
    assert.equal(v.managed, false);
    assert.equal(v.off, 'dev');
    assert.equal(v.version, t.app.ctx.config.version);
    await assert.rejects(t.api('POST', '/app-update/check'), /409.*alleen in de TeamBot-app/);
    await assert.rejects(t.api('PUT', '/app-update/settings', { auto: 'on' }), /409/);
    assert.equal((await s.api('GET', '/app-update')).off, 'server');
  } finally {
    await t.close();
    await s.close();
  }
});

test('the installed app without a channel: off, "next installer"; a channel typed on the computer switches it on', async () => {
  const t = await startTestApp();
  const w = wire(t, { next: null });
  try {
    let v = await t.api('GET', '/app-update');
    assert.equal(v.managed, true);
    assert.equal(v.state.phase, 'off');
    assert.equal(v.off, 'no-channel', 'the page: new versions come with the next installer');
    assert.equal(v.auto, 'on', 'Automatisch bijwerken: on by default');
    assert.equal(v.channel.source, 'none');

    await assert.rejects(t.api('PUT', '/app-update/channel', { channel: 'http://downloads.voorbeeld.nl/' }), /400.*https/);
    v = await t.api('PUT', '/app-update/channel', { channel: 'https://github.com/teambot-app/teambot' });
    assert.equal(v.state.phase, 'idle');
    assert.deepEqual(v.channel, { text: 'github.com/teambot-app/teambot', input: 'github:teambot-app/teambot', source: 'saved' });
    assert.deepEqual(w.fake.feed, { provider: 'github', owner: 'teambot-app', repo: 'teambot' }, 'GitHub Releases for electron-updater');
    const audit = t.app.ctx.store.all<any>("SELECT data FROM audit WHERE kind = 'app.update_channel'");
    assert.equal(audit.length, 1);

    // Empty again: the channel built into the release applies (here none).
    v = await t.api('PUT', '/app-update/channel', { channel: '' });
    assert.equal(v.off, 'no-channel');
    await assert.rejects(t.api('PUT', '/app-update/settings', { auto: 'altijd' }), /400/);
    v = await t.api('PUT', '/app-update/settings', { auto: 'notify' });
    assert.equal(v.auto, 'notify');
  } finally {
    w.done();
    await t.close();
  }
});

test('on the phone: the status, Nu bijwerken and Automatisch bijwerken work; the channel is computer-only', async () => {
  const t = await startTestApp();
  const w = wire(t, { next: '99.1.0', builtIn: { provider: 'generic', url: 'https://downloads.voorbeeld.nl/teambot/' } });
  try {
    const phone = await pairPhone(t);
    const v = await phone('GET', '/app-update');
    assert.equal(v.status, 200);
    assert.equal(v.body.channel.source, 'built-in');
    assert.equal(v.body.state.phase, 'idle');
    assert.equal((await phone('PUT', '/app-update/settings', { auto: 'notify' })).body.auto, 'notify');
    const r = await phone('PUT', '/app-update/channel', { channel: 'https://ander.voorbeeld.nl/' });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'mobile_denied');
    assert.match(r.body.error, /computer/);
    assert.equal((await t.api('GET', '/app-update')).channel.source, 'built-in', 'unchanged');
    // "Nu bijwerken" from the phone: found, downloaded, installs once no task runs (the owner may be on the phone).
    assert.equal((await phone('POST', '/app-update/install')).status, 200);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(w.quits, ['99.1.0']);
  } finally {
    w.done();
    await t.close();
  }
});

test('alleen melden: no download by itself; Nu bijwerken waits for a running task, not for the owner', async () => {
  const t = await startTestApp();
  const ctx = t.app.ctx;
  const w = wire(t, { next: '99.2.0', builtIn: { provider: 'generic', url: 'https://downloads.voorbeeld.nl/teambot/' }, userIdle: () => 5 });
  try {
    await t.api('PUT', '/app-update/settings', { auto: 'notify' });
    let v = await t.api('POST', '/app-update/check');
    assert.equal(v.state.phase, 'available');
    assert.equal(w.fake.downloads, 0, 'only told, nothing downloaded');

    const a = await t.agent({ name: 'Werker' });
    ctx.store.exec("INSERT INTO runs (id, thread_id, agent_id, user_id, status, created_at) VALUES ('run_b', 'th_b', ?, ?, 'running', ?)", a.id, ctx.auth.owner()!.id, new Date().toISOString());
    v = await t.api('POST', '/app-update/install');
    await new Promise((r) => setTimeout(r, 80));
    v = await t.api('GET', '/app-update');
    assert.equal(v.state.phase, 'ready');
    assert.equal(v.soon, true);
    assert.deepEqual(v.waitingFor, [{ kind: 'runs', count: 1 }], 'waits for the task, not for the owner at the computer');
    assert.deepEqual(w.quits, []);
    ctx.store.exec("UPDATE runs SET status = 'done' WHERE id = 'run_b'");
    await new Promise((r) => setTimeout(r, 120));
    assert.deepEqual(w.quits, ['99.2.0']);
    assert.equal(ctx.store.all<any>("SELECT id FROM audit WHERE kind = 'app.update_now'").length, 1);
  } finally {
    w.done();
    await t.close();
  }
});

test('once a day: the hourly tick only looks when a day has passed (after a failure an hour later)', async () => {
  const t = await startTestApp();
  const w = wire(t, { next: null, builtIn: { provider: 'generic', url: 'https://downloads.voorbeeld.nl/teambot/' } });
  try {
    await w.flow.tick();
    assert.equal(w.fake.checks, 1, 'never looked: looks');
    await w.flow.tick();
    assert.equal(w.fake.checks, 1, 'looked a moment ago: not again');
    const f = path.join(w.dir, 'update.json');
    const day = new Date(Date.now() - 25 * 3600_000).toISOString();
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), lastCheckAt: day, lastTryAt: day }));
    await w.flow.tick();
    assert.equal(w.fake.checks, 2, 'a day later');
    await t.api('PUT', '/app-update/settings', { auto: 'off' });
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), lastCheckAt: day, lastTryAt: day }));
    await w.flow.tick();
    assert.equal(w.fake.checks, 2, 'uit: never by itself');
    assert.equal((await t.api('POST', '/app-update/check')).state.phase, 'idle', 'Nu controleren still works');
    assert.equal(w.fake.checks, 3);
  } finally {
    w.done();
    await t.close();
  }
});

test('after "Terug naar versie x" the version the owner left is not installed again by itself', async () => {
  const t = await startTestApp();
  const cur = t.app.ctx.config.version;
  writeUpdateState(t.dir, { lastVersion: cur, history: [{ kind: 'rollback', from: '99.3.0', to: cur, at: new Date().toISOString(), backup: 'x' }] });
  const w = wire(t, { next: '99.3.0', builtIn: { provider: 'generic', url: 'https://downloads.voorbeeld.nl/teambot/' }, userIdle: () => 99_999 });
  try {
    let v = await t.api('POST', '/app-update/check');
    assert.equal(v.state.phase, 'available');
    assert.equal(v.skipped, '99.3.0');
    assert.equal(w.fake.downloads, 0, 'Automatisch bijwerken is on, but not for the version the owner left');
    // A newer version than the one left behind is a normal update again.
    w.fake.next = '99.4.0';
    w.flow.state = { phase: 'idle' };
    await t.api('POST', '/app-update/check');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(w.fake.downloads, 1);
    assert.deepEqual(w.quits, ['99.4.0'], 'nothing runs and the owner is away: it installs');
  } finally {
    w.done();
    await t.close();
  }
});
