// The desktop shell around the first start (release 0.4.2): where the window opens (never larger than the screen,
// the last place when it still fits), the one-time tip on closing, the start page shown while the server starts, and
// the signature check of updates once the installer is signed. Electron-free modules, tested directly; the window
// itself is checked by launching the unpacked app (docs/IOS_WINDOWS_RELEASE.md, "Testen zonder je eigen TeamBot").
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DESIGN_SIZE, MIN_SIZE, readShellState, windowBounds, writeShellState, type Rect } from '../desktop/shell-state.js';
import { CANVAS, startPageHtml, startPageUrl } from '../desktop/start-page.js';
import { defaultFeedUrl, parseDn, signatureScript, UpdateFlow, verifyPublisher, type UpdaterLike } from '../desktop/update-flow.js';

const FULL_HD: Rect = { x: 0, y: 0, width: 1920, height: 1032 };
const LAPTOP: Rect = { x: 0, y: 0, width: 1366, height: 728 };
const RIGHT: Rect = { x: 1920, y: 0, width: 2560, height: 1392 };
const inArea = (b: Rect, a: Rect) => b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height;

// ---------- where the window opens ----------
test('window: the design size in the middle of a large screen; never larger than a small one', () => {
  const big = windowBounds(undefined, [FULL_HD], FULL_HD);
  assert.deepEqual(big.bounds, { x: (1920 - DESIGN_SIZE.width) / 2, y: (1032 - DESIGN_SIZE.height) / 2, width: DESIGN_SIZE.width, height: DESIGN_SIZE.height });
  assert.equal(big.maximized, false);

  const small = windowBounds(undefined, [LAPTOP], LAPTOP);
  assert.ok(inArea(small.bounds, LAPTOP), `fits a 1366×768 laptop: ${JSON.stringify(small.bounds)}`);
  assert.equal(small.bounds.width, Math.round(1366 * 0.9));
  assert.equal(small.bounds.height, Math.round(728 * 0.9));
  assert.ok(small.bounds.width >= MIN_SIZE.width && small.bounds.height >= MIN_SIZE.height);

  // Work areas start where the taskbar ends (taskbar at the top or left).
  const shifted = windowBounds(undefined, [{ x: 0, y: 48, width: 1920, height: 1032 }], { x: 0, y: 48, width: 1920, height: 1032 });
  assert.ok(shifted.bounds.y >= 48);
});

test('window: the last place when it still fits, pulled onto the screen when it does not', () => {
  const saved = { bounds: { x: 2100, y: 100, width: 1400, height: 900 }, maximized: false };
  assert.deepEqual(windowBounds(saved, [FULL_HD, RIGHT], FULL_HD).bounds, saved.bounds, 'on the second screen, as it was');

  // The second screen is gone (laptop without its monitor): the middle of the main screen again.
  const gone = windowBounds(saved, [FULL_HD], FULL_HD);
  assert.ok(inArea(gone.bounds, FULL_HD));
  assert.equal(gone.bounds.width, DESIGN_SIZE.width);

  // Saved on a big screen, now a small one: same corner, made to fit.
  const fit = windowBounds({ bounds: { x: 100, y: 50, width: 1800, height: 1000 } }, [LAPTOP], LAPTOP);
  assert.ok(inArea(fit.bounds, LAPTOP), JSON.stringify(fit.bounds));
  assert.equal(fit.bounds.width, LAPTOP.width);

  // Half off the right edge: pulled back in, size kept.
  const edge = windowBounds({ bounds: { x: 1500, y: 200, width: 1000, height: 700 } }, [FULL_HD], FULL_HD);
  assert.deepEqual(edge.bounds, { x: 920, y: 200, width: 1000, height: 700 });

  // Title bar above the screen (y < work area): not reachable to drag, so the default place.
  const above = windowBounds({ bounds: { x: 100, y: -400, width: 1000, height: 700 } }, [FULL_HD], FULL_HD);
  assert.ok(inArea(above.bounds, FULL_HD));

  assert.equal(windowBounds({ ...saved, maximized: true }, [FULL_HD, RIGHT], FULL_HD).maximized, true, 'maximised stays maximised');
});

test('shell state: saved and read back; a broken or strange file is ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-shell-'));
  try {
    assert.deepEqual(readShellState(dir), {}, 'nothing saved yet');
    writeShellState(dir, { window: { bounds: { x: 1, y: 2, width: 800, height: 600 }, maximized: true } });
    writeShellState(dir, { closeTipAt: '2026-11-09T10:00:00.000Z' });
    writeShellState(dir, { lang: 'en' });
    assert.deepEqual(readShellState(dir), { window: { bounds: { x: 1, y: 2, width: 800, height: 600 }, maximized: true }, closeTipAt: '2026-11-09T10:00:00.000Z', lang: 'en' }, 'merged, not replaced');
    assert.deepEqual(fs.readdirSync(dir), ['shell.json'], 'no temporary file left behind');

    fs.writeFileSync(path.join(dir, 'shell.json'), '{"window":{"bounds":{"x":"a","y":0,"width":-5,"height":0}},"closeTipAt":5,');
    assert.deepEqual(readShellState(dir), {}, 'half a file');
    fs.writeFileSync(path.join(dir, 'shell.json'), '{"window":{"bounds":{"x":"a","y":0,"width":-5,"height":0}},"closeTipAt":5,"lang":"<b>"}');
    assert.deepEqual(readShellState(dir), {}, 'nonsense values are dropped');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- the start page ----------
test('start page: calm, no script, no links, texts escaped, colours of the interface, right to left for Arabic', () => {
  const p = { lang: 'nl', dark: false, title: 'TeamBot is geïnstalleerd', lines: ['Je vindt TeamBot voortaan in het Startmenu en op je bureaublad.'], wait: 'Even geduld…' };
  const html = startPageHtml(p);
  assert.match(html, /<h1>TeamBot is geïnstalleerd<\/h1>/);
  assert.match(html, /<p>Je vindt TeamBot voortaan in het Startmenu en op je bureaublad\.<\/p>/);
  assert.match(html, /role="status"/);
  assert.match(html, /default-src 'none'/, 'a strict Content-Security-Policy');
  assert.doesNotMatch(html, /<script|<a |href=|javascript:/i);
  assert.ok(html.includes(CANVAS.light.bg));
  assert.ok(startPageHtml({ ...p, dark: true }).includes(CANVAS.dark.bg));
  assert.match(html, /prefers-reduced-motion/);

  const evil = startPageHtml({ ...p, title: '<img src=x onerror=alert(1)>', lines: ['"><script>alert(1)</script>'], lang: 'nl" onload="x' });
  assert.doesNotMatch(evil, /<img src=x|<script>/);
  assert.match(evil, /<html lang="nl" dir="ltr">/, 'an odd language code falls back to nl');
  assert.match(startPageHtml({ ...p, lang: 'ar' }), /dir="rtl"/);

  assert.doesNotMatch(startPageHtml({ ...p, icon: 'https://example.com/x.png' }), /<img/, 'only an inline PNG icon');
  assert.match(startPageHtml({ ...p, icon: 'data:image/png;base64,iVBORw0KGgo=' }), /<img src="data:image\/png;base64,iVBORw0KGgo="/);

  const url = startPageUrl(p);
  assert.ok(url.startsWith('data:text/html;charset=utf-8,'));
  assert.equal(decodeURIComponent(url.slice(url.indexOf(',') + 1)), html);
});

// ---------- the signature of an update ----------
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
const FILE = 'C:\\Users\\u\\AppData\\Local\\teambot-updater\\pending\\TeamBot-Setup-0.4.3.exe';
const SUBJECT = 'CN=Jan Jansen, O=Jan Jansen, L=Utrecht, S=Utrecht, C=NL';

test('update signature: the publisher names, as electron-updater compares them', () => {
  assert.deepEqual([...parseDn(SUBJECT)], [['CN', 'Jan Jansen'], ['O', 'Jan Jansen'], ['L', 'Utrecht'], ['S', 'Utrecht'], ['C', 'NL']]);
  assert.equal(parseDn('CN="Jansen, Jan", O=X').get('CN'), 'Jansen, Jan');
  assert.equal(parseDn('').size, 0);
  // The file name goes into a single-quoted PowerShell string: a quote in it cannot end the string.
  const s = signatureScript("C:\\Users\\o'brien\\TeamBot-Setup.exe");
  assert.ok(s.includes("-LiteralPath 'C:\\Users\\o''brien\\TeamBot-Setup.exe'"));
  assert.match(s, /-ErrorAction Stop/);
  assert.match(s, /ToBase64String/, 'output independent of the console code page (names with ë, ö)');
});

test('update signature: only a valid signature of the expected publisher passes; anything unclear is refused', async () => {
  const ok = { Status: 0, Subject: SUBJECT, Path: FILE };
  const run = (o: unknown) => async () => b64(o);
  assert.equal(await verifyPublisher(['Jan Jansen'], FILE, run(ok)), null, 'name = CN');
  assert.equal(await verifyPublisher([SUBJECT], FILE, run(ok)), null, 'full DN');
  assert.equal(await verifyPublisher(['Iemand Anders', 'Jan Jansen'], FILE, run(ok)), null, 'one of several names');
  assert.equal(await verifyPublisher(['Jan Jansen'], FILE, run({ ...ok, Path: FILE.toLowerCase() })), null, 'Windows paths ignore case');

  assert.match((await verifyPublisher(['Iemand Anders'], FILE, run(ok)))!, /ondertekend door "Jan Jansen"/);
  assert.ok(await verifyPublisher(['CN=Jan Jansen, C=BE'], FILE, run(ok)), 'a DN must match on every part');
  assert.match((await verifyPublisher(['Jan Jansen'], FILE, run({ Status: 2, Subject: '', Path: FILE })))!, /geen geldige handtekening/, 'NotSigned');
  assert.ok(await verifyPublisher(['Jan Jansen'], FILE, run({ Status: 1, Subject: SUBJECT, Path: FILE })), 'HashMismatch');
  assert.ok(await verifyPublisher(['Jan Jansen'], FILE, run({ ...ok, Path: 'C:\\other.exe' })), 'the check was about another file');
  assert.ok(await verifyPublisher(['Jan Jansen'], FILE, run({ Status: 0, Subject: SUBJECT })), 'no path in the answer');
  assert.match((await verifyPublisher(['Jan Jansen'], FILE, async () => 'not base64 json'))!, /kon niet worden gecontroleerd/);
  assert.match(
    (await verifyPublisher(['Jan Jansen'], FILE, async () => {
      throw new Error('powershell.exe is blocked');
    }))!,
    /kon niet worden gecontroleerd \(powershell\.exe is blocked\)/,
    'PowerShell fails: refused (electron-updater would let it through)',
  );
});

class FakeNsisUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowDowngrade = true;
  logger: unknown = null;
  verifyUpdateCodeSignature?: (names: string[], file: string) => Promise<string | null> = async () => 'electron-updater default';
  setFeedURL() {}
  async checkForUpdates() {}
  async downloadUpdate() {}
  quitAndInstall() {}
}

test('update signature: the flow puts its own check in place of electron-updater’s, and says a refusal in words', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-sig-'));
  try {
    const scripts: string[] = [];
    const u = new FakeNsisUpdater();
    const flow = new UpdateFlow({
      updater: u,
      version: '0.4.2',
      packaged: true,
      configDir: dir,
      dataDir: dir,
      platform: 'win32',
      env: {},
      powershell: async (s) => {
        scripts.push(s);
        return b64({ Status: 0, Subject: SUBJECT, Path: FILE });
      },
    });
    assert.equal(await u.verifyUpdateCodeSignature!(['Jan Jansen'], FILE), null);
    assert.equal(await u.verifyUpdateCodeSignature!(['Iemand Anders'], FILE) !== null, true);
    assert.equal(scripts.length, 2);
    assert.ok(scripts[0].includes(FILE));
    assert.match(fs.readFileSync(path.join(dir, 'update.log'), 'utf8'), /signature ok: TeamBot-Setup-0\.4\.3\.exe[\s\S]*signature refused/);

    const err = Object.assign(new Error('New version 0.4.3 is not signed by the application owner: publisherNames: Jan Jansen, raw info: {…}'), { code: 'ERR_UPDATER_INVALID_SIGNATURE' });
    u.emit('error', err);
    assert.deepEqual(flow.state, { phase: 'error', message: 'Deze update is niet ondertekend door de maker van TeamBot. TeamBot installeert hem niet.' });
    u.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED\n  at …'));
    assert.deepEqual(flow.state, { phase: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' }, 'other errors stay one line');

    // Without a PowerShell runner (macOS, Linux, tests) electron-updater's own function stays.
    const other = new FakeNsisUpdater();
    new UpdateFlow({ updater: other, version: '0.4.2', packaged: true, configDir: dir, dataDir: dir, env: {} });
    assert.equal(await other.verifyUpdateCodeSignature!([], FILE), 'electron-updater default');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('update channel not set: off and quiet, nothing that looks like a problem', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-off-'));
  try {
    const notes: string[] = [];
    // The app-update.yml of this release: the placeholder from package.json build.publish.
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'));
    const yml = `provider: ${pkg.build.publish[0].provider}\nurl: ${pkg.build.publish[0].url}\nupdaterCacheDirName: teambot-updater\n`;
    const flow = new UpdateFlow({ updater: new FakeNsisUpdater(), version: '0.4.2', packaged: true, configDir: dir, dataDir: dir, env: {}, notify: (t) => notes.push(t), defaultFeed: defaultFeedUrl(yml) });
    flow.start();
    assert.equal(flow.state.phase, 'off');
    assert.equal(flow.config().feedUrl, '', 'the placeholder is never used as a channel');
    assert.equal(notes.length, 0, 'no notification');
    flow.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('update channel built in: once build.publish is a real https address, it is the default (Settings and env win)', () => {
  assert.equal(defaultFeedUrl('provider: generic\nurl: https://updates.example.invalid/teambot/\n'), '');
  assert.equal(defaultFeedUrl('provider: generic\nurl: https://example.com/teambot/\n'), '');
  assert.equal(defaultFeedUrl('provider: generic\nurl: http://downloads.teambot.app/\n'), '', 'never plain http');
  assert.equal(defaultFeedUrl('provider: github\nowner: x\nrepo: y\n'), '', 'only the generic channel this flow speaks');
  assert.equal(defaultFeedUrl(null), '');
  const real = 'https://downloads.teambot.app/windows/';
  assert.equal(defaultFeedUrl(`provider: generic\nurl: '${real}'\nupdaterCacheDirName: teambot-updater\n`), real);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-def-'));
  try {
    const flow = new UpdateFlow({ updater: new FakeNsisUpdater(), version: '0.4.2', packaged: true, configDir: dir, dataDir: dir, env: {}, defaultFeed: real });
    assert.equal(flow.config().feedUrl, real);
    flow.start();
    assert.equal(flow.state.phase, 'idle', 'on, without anyone typing the address');
    flow.save({ feedUrl: 'https://eigen.example.org/tb/' });
    assert.equal(flow.config().feedUrl, 'https://eigen.example.org/tb/', 'a channel set in Settings wins');
    flow.stop();
    const fromEnv = new UpdateFlow({ updater: new FakeNsisUpdater(), version: '0.4.2', packaged: true, configDir: dir, dataDir: dir, env: { TEAMBOT_UPDATE_URL: 'https://env.example.org/' }, defaultFeed: real });
    assert.equal(fromEnv.config().feedUrl, 'https://env.example.org/');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
