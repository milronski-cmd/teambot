// Automatic updates, ready to switch on (parity 16.2): where updates come from (a folder on a web server or GitHub
// Releases, built in or typed by the owner) and when a downloaded update may install by itself (never in the middle of
// a task: no bot at work, no routine running or about to start, no backup, and the owner away). Pure modules, no
// Electron, nothing downloaded or installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { builtInChannel, channelInput, channelText, feedOptions, installerUrl, parseChannel, publishEntry } from '../desktop/update-channel.js';
import { CHECK_EVERY_MS, USER_IDLE_SECONDS, checkDue, installDecision, reasonText, sameReasons } from '../desktop/update-idle.js';
import { CHAT_RECENT_MS, updateBlockers } from '../server/modules/backups/app-update.js';

test('update channel: a folder on a web server or a GitHub repository, in every form the owner may type', () => {
  assert.deepEqual(parseChannel(''), { channel: null });
  assert.deepEqual(parseChannel('   '), { channel: null });
  assert.deepEqual(parseChannel('https://downloads.voorbeeld.nl/teambot'), { channel: { provider: 'generic', url: 'https://downloads.voorbeeld.nl/teambot/' } }, 'a trailing slash is added');
  assert.deepEqual(parseChannel('http://127.0.0.1:4767/'), { channel: { provider: 'generic', url: 'http://127.0.0.1:4767/' } }, 'http only for this computer (tests)');
  for (const s of ['github:teambot-app/teambot', 'gh:teambot-app/teambot', 'teambot-app/teambot', 'https://github.com/teambot-app/teambot', 'https://github.com/teambot-app/teambot/releases', 'https://github.com/teambot-app/teambot.git']) {
    assert.deepEqual(parseChannel(s), { channel: { provider: 'github', owner: 'teambot-app', repo: 'teambot' } }, s);
  }
  assert.match(parseChannel('http://downloads.voorbeeld.nl/teambot/').error!, /https/);
  assert.match(parseChannel('http://github.com/a/b').error!, /https/);
  assert.match(parseChannel('https://user:pw@downloads.voorbeeld.nl/').error!, /inloggegevens/);
  assert.match(parseChannel('downloads.voorbeeld.nl/teambot').error!, /https:\/\//, 'an address without https:// is not a repository');
  assert.match(parseChannel('github:a b/c').error!, /eigenaar\/naam/);
  assert.match(parseChannel('https://github.com/alleen-eigenaar').error!, /eigenaar\/naam/);
  assert.match(parseChannel('geen adres').error!, /Ongeldig/);

  const gh = parseChannel('teambot-app/teambot').channel!;
  assert.equal(channelText(gh), 'github.com/teambot-app/teambot');
  assert.equal(channelInput(gh), 'github:teambot-app/teambot');
  assert.deepEqual(parseChannel(channelInput(gh)).channel, gh, 'what is stored reads back the same');
  const folder = parseChannel('https://downloads.voorbeeld.nl/teambot/').channel!;
  assert.equal(channelText(folder), 'https://downloads.voorbeeld.nl/teambot/');
  assert.equal(channelText(null), '');
});

test('update channel: what electron-updater gets, and where the installer of a version lives (the way back)', () => {
  const gh = { provider: 'github', owner: 'teambot-app', repo: 'teambot' } as const;
  const folder = { provider: 'generic', url: 'https://downloads.voorbeeld.nl/teambot/' } as const;
  assert.deepEqual(feedOptions(folder), { provider: 'generic', url: folder.url });
  assert.deepEqual(feedOptions(gh), { provider: 'github', owner: 'teambot-app', repo: 'teambot' }, 'always github.com over https in the app');
  assert.deepEqual(feedOptions(gh, { githubHost: '127.0.0.1:4767' }), { provider: 'github', owner: 'teambot-app', repo: 'teambot', host: '127.0.0.1:4767', protocol: 'http' });
  assert.equal(installerUrl(folder, '0.4.3', 'TeamBot-Setup-0.4.3.exe').href, 'https://downloads.voorbeeld.nl/teambot/TeamBot-Setup-0.4.3.exe');
  assert.equal(installerUrl(gh, '0.4.3', 'TeamBot-Setup-0.4.3.exe').href, 'https://github.com/teambot-app/teambot/releases/download/v0.4.3/TeamBot-Setup-0.4.3.exe', 'the asset of release v<version>');
  assert.equal(installerUrl(gh, '0.4.3', 'TeamBot-Setup-0.4.3.exe', { githubHost: '127.0.0.1:4767' }).origin, 'http://127.0.0.1:4767');
  assert.deepEqual(publishEntry(folder), { provider: 'generic', url: folder.url });
  assert.deepEqual(publishEntry(gh), { provider: 'github', owner: 'teambot-app', repo: 'teambot', releaseType: 'release' }, 'package.json build.publish for GitHub Releases');
});

test('update channel built into a release: only a real place counts; placeholders stay silent', () => {
  assert.equal(builtInChannel(null), null);
  assert.equal(builtInChannel('provider: generic\nurl: https://updates.example.invalid/teambot/\n'), null, 'the placeholder of package.json');
  assert.equal(builtInChannel('provider: generic\nurl: https://example.com/teambot/\n'), null);
  assert.equal(builtInChannel('provider: generic\nurl: http://downloads.teambot.app/\n'), null, 'never plain http');
  assert.deepEqual(builtInChannel("provider: generic\nurl: 'https://downloads.teambot.app/windows/'\nupdaterCacheDirName: teambot-updater\n"), { provider: 'generic', url: 'https://downloads.teambot.app/windows/' });
  // What electron-builder writes for build.publish { provider: github, owner, repo }.
  assert.deepEqual(builtInChannel('owner: teambot-app\nrepo: teambot\nprovider: github\nreleaseType: release\nupdaterCacheDirName: teambot-updater\n'), { provider: 'github', owner: 'teambot-app', repo: 'teambot' });
  assert.equal(builtInChannel('owner: OWNER\nrepo: teambot\nprovider: github\n'), null, 'a placeholder owner');
  assert.equal(builtInChannel('owner: your-name\nrepo: teambot\nprovider: github\n'), null);
  assert.equal(builtInChannel('owner: teambot-app\nrepo: teambot\nprovider: github\nprivate: true\n'), null, 'a private repository would need a token in the app');
  assert.equal(builtInChannel('owner: teambot-app\nrepo: teambot\nprovider: github\nhost: git.bedrijf.nl\n'), null, 'GitHub Enterprise: not this flow');
  assert.equal(builtInChannel('provider: s3\nbucket: x\n'), null);
});

const quiet = { busy: [], userIdleSeconds: USER_IDLE_SECONDS + 1 };

test('install by itself: only when nothing runs and the owner is away; otherwise it says what it waits for', () => {
  // Not ready, or not allowed to install by itself: never, and nothing to wait for (it installs at quit).
  assert.deepEqual(installDecision({ mode: 'on', ready: false, facts: quiet }), { install: false, waitingFor: [] });
  assert.deepEqual(installDecision({ mode: 'notify', ready: true, facts: quiet }), { install: false, waitingFor: [] });
  assert.deepEqual(installDecision({ mode: 'off', ready: true, facts: quiet }), { install: false, waitingFor: [] });
  // Everything quiet and the owner away: now.
  assert.deepEqual(installDecision({ mode: 'on', ready: true, facts: quiet }), { install: true, waitingFor: [] });
  assert.equal(installDecision({ mode: 'on', ready: true, facts: { busy: [], userIdleSeconds: 3, locked: true } }).install, true, 'a locked screen: the owner is away');
  // The owner is at the computer.
  assert.deepEqual(installDecision({ mode: 'on', ready: true, facts: { busy: [], userIdleSeconds: 30 } }), { install: false, waitingFor: [{ kind: 'user' }] });
  // A bot at work, a routine about to start: never in the middle of a task, also with the screen locked.
  const busy = { busy: [{ kind: 'runs', count: 2 } as const, { kind: 'routine-soon', name: 'Ochtendnieuws', at: '2026-11-09T07:00:00.000Z' } as const], userIdleSeconds: 99_999, locked: true };
  assert.deepEqual(installDecision({ mode: 'on', ready: true, facts: busy }), { install: false, waitingFor: busy.busy });
  // Cannot tell (no facts): wait.
  assert.deepEqual(installDecision({ mode: 'on', ready: true, facts: null }), { install: false, waitingFor: [{ kind: 'unknown' }] });

  // "Nu bijwerken" (the owner asked): their own presence and their last message do not matter, a running task does.
  const chatting = { busy: [{ kind: 'chatting', at: '2026-11-09T10:00:00.000Z' } as const], userIdleSeconds: 2 };
  assert.deepEqual(installDecision({ mode: 'notify', ready: true, soon: true, facts: chatting }), { install: true, waitingFor: [] });
  assert.deepEqual(installDecision({ mode: 'on', ready: true, facts: { ...chatting, userIdleSeconds: 99_999 } }).waitingFor, chatting.busy, 'by itself it does wait for that');
  assert.deepEqual(installDecision({ mode: 'off', ready: true, soon: true, facts: { busy: [{ kind: 'runs', count: 1 }], userIdleSeconds: 2 } }), { install: false, waitingFor: [{ kind: 'runs', count: 1 }] });
  assert.equal(installDecision({ mode: 'on', ready: true, facts: { busy: [], userIdleSeconds: 60 }, idleSeconds: 30 }).install, true, 'the idle time can be set');

  assert.equal(sameReasons([{ kind: 'user' }], [{ kind: 'user' }]), true);
  assert.equal(sameReasons(undefined, []), true);
  assert.equal(sameReasons([{ kind: 'runs', count: 1 }], [{ kind: 'runs', count: 2 }]), false);
  const t = (s: string, ...v: (string | number)[]) => s.replace(/\{(\d+)\}/g, (_, n) => String(v[Number(n)]));
  assert.equal(reasonText({ kind: 'runs', count: 1 }, t), '1 taak loopt');
  assert.equal(reasonText({ kind: 'runs', count: 3 }, t), '3 taken lopen');
  assert.equal(reasonText({ kind: 'routine-soon', name: 'Ochtendnieuws', at: '' }, t), 'routine “Ochtendnieuws” start zo');
  assert.equal(reasonText({ kind: 'user' }, t), 'je gebruikt de computer');
});

test('look for updates once a day; after a failed try an hour later; a pc that slept looks at once', () => {
  const now = Date.parse('2026-11-09T12:00:00.000Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  assert.equal(checkDue({ now }), true, 'never looked');
  assert.equal(checkDue({ now, lastCheckAt: ago(3600_000), lastTryAt: ago(3600_000) }), false);
  assert.equal(checkDue({ now, lastCheckAt: ago(CHECK_EVERY_MS - 30_000), lastTryAt: ago(CHECK_EVERY_MS - 30_000) }), true, 'the hourly tick just before the day is full');
  assert.equal(checkDue({ now, lastCheckAt: ago(3 * CHECK_EVERY_MS), lastTryAt: ago(3 * CHECK_EVERY_MS) }), true, 'after three days asleep');
  assert.equal(checkDue({ now, lastCheckAt: ago(2 * CHECK_EVERY_MS), lastTryAt: ago(20 * 60_000) }), false, 'tried (and failed) 20 minutes ago');
  assert.equal(checkDue({ now, lastCheckAt: ago(2 * CHECK_EVERY_MS), lastTryAt: ago(61 * 60_000) }), true, 'an hour later again');
  assert.equal(checkDue({ now, lastCheckAt: 'nonsense' }), true);
});

test('what an update waits for on the server: bots at work, routines, a backup, a message a moment ago', async () => {
  const t = await startTestApp();
  try {
    const ctx = t.app.ctx;
    const owner = ctx.auth.owner()!.id;
    assert.deepEqual(updateBlockers(ctx), [], 'a fresh TeamBot: nothing holds an update back');

    const a = await t.agent({ name: 'Werker' });
    const now = Date.now();
    const iso = (ms: number) => new Date(now + ms).toISOString();
    // A routine that starts in five minutes holds it back; one in an hour does not.
    ctx.store.exec("INSERT INTO routines (id, user_id, agent_id, name, status, next_run_at, created_at, updated_at) VALUES ('rt_later', ?, ?, 'Later', 'active', ?, ?, ?)", owner, a.id, iso(3600_000), iso(0), iso(0));
    assert.deepEqual(updateBlockers(ctx, now), []);
    ctx.store.exec("INSERT INTO routines (id, user_id, agent_id, name, status, next_run_at, created_at, updated_at) VALUES ('rt_soon', ?, ?, 'Ochtendnieuws', 'active', ?, ?, ?)", owner, a.id, iso(5 * 60_000), iso(0), iso(0));
    assert.deepEqual(updateBlockers(ctx, now), [{ kind: 'routine-soon', name: 'Ochtendnieuws', at: iso(5 * 60_000) }]);
    ctx.store.exec("UPDATE routines SET status = 'paused' WHERE id = 'rt_soon'");

    // A run at work (as RunManager stores it).
    ctx.store.exec("INSERT INTO runs (id, thread_id, agent_id, user_id, status, created_at) VALUES ('run_x', 'th_x', ?, ?, 'running', ?)", a.id, owner, iso(0));
    assert.deepEqual(updateBlockers(ctx, now), [{ kind: 'runs', count: 1 }]);
    ctx.store.exec("UPDATE runs SET status = 'waiting' WHERE id = 'run_x'");
    assert.deepEqual(updateBlockers(ctx, now), [], 'a run that waits for an approval survives a restart (it resumes): no hold');
    ctx.store.exec("UPDATE runs SET status = 'done' WHERE id = 'run_x'");

    // A person wrote to a bot (here, or from the phone): they may still be at it.
    const th = await t.api('POST', '/threads', { agent_id: a.id });
    t.script.push({ text: 'Hallo!' });
    await t.say(th.id, 'Hoi');
    const recent = updateBlockers(ctx, Date.now());
    assert.equal(recent.length, 1);
    assert.equal(recent[0].kind, 'chatting');
    assert.deepEqual(updateBlockers(ctx, Date.now() + CHAT_RECENT_MS + 1000), [], 'a quarter of an hour later no more');

    // A backup being made.
    ctx.services.backups = { ...(ctx.services.backups || {}), service: { job: { phase: 'files' } } };
    assert.deepEqual(updateBlockers(ctx, Date.now() + CHAT_RECENT_MS + 1000), [{ kind: 'backup' }]);
    ctx.services.backups.service.job = { phase: 'done' };
    assert.deepEqual(updateBlockers(ctx, Date.now() + CHAT_RECENT_MS + 1000), []);
  } finally {
    await t.close();
  }
});
