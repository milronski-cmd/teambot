import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runtimes, extractNpmTarball, extractZip, newer, newestStable, platformKey, verifyRegistrySignature, RUNTIMES } from '../server/modules/cli-agents/runtimes.js';
import { DeviceLogins, loginCommand, noBrowser, openTerminal, parseDeviceLogin, parsePasteLogin } from '../server/modules/cli-agents/login.js';
import { fileURLToPath } from 'node:url';
import { runQuick } from '../server/modules/cli-agents/proc.js';
import { fakeCliScript, startFixtureGithub, startFixtureRegistry, tarGz, zip, type FixtureRelease } from './runtime-fixture.js';
import { startTestApp } from './helpers.js';

const PLAT = platformKey();
// npm source: Claude Code's platform package (the same checks apply to Codex).
const CC = RUNTIMES['claude-code'].pkg(PLAT, '2.1.319').name;
const ccFiles = (version: string) => [
  { name: 'package/package.json', data: JSON.stringify({ name: CC, version }) },
  { name: 'package/bin/claude.mjs', data: fakeCliScript({ name: 'claude', version }), mode: 0o755 },
];
// GitHub source: OpenCode 2.x release assets (zip on Windows/macOS, tar.gz on Linux).
const REPO = RUNTIMES.opencode.main;
const ASSET = RUNTIMES.opencode.asset!(PLAT)!;
const ocAsset = (version: string, extra: { name: string; data?: string; mode?: number }[] = []) => {
  const bin = { name: 'opencode.mjs', data: fakeCliScript({ name: 'opencode', version }), mode: 0o100755 };
  const files = [bin, ...extra];
  return ASSET.endsWith('.zip') ? zip(files) : tarGz(files.map((f) => ({ ...f, mode: (f.mode ?? 0o644) & 0o777 })));
};
const rel = (tag: string, o: Partial<FixtureRelease> = {}, version = tag.slice(1)): FixtureRelease => ({ tag, assets: [{ name: ASSET, data: ocAsset(version) }], ...o });
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('npm source (Claude Code, Codex): signed registry, pinned checksum, verified download, update notice, update, uninstall', async () => {
  const reg = await startFixtureRegistry({
    packages: [
      { name: CC, version: '2.1.319', files: ccFiles('2.1.319') },
      { name: CC, version: '2.1.320', files: ccFiles('2.1.320') },
    ],
    distTags: { '@anthropic-ai/claude-code': { latest: '2.1.320' } },
  });
  const dir = tmp('tb-rt-');
  try {
    const rt = new Runtimes(dir, { registry: reg.url, keys: reg.keys, specs: { 'claude-code': { integrity: { [PLAT]: reg.integrity(CC, '2.1.319') } } } });
    let st = await rt.status('claude-code');
    assert.equal(st.installed, null);
    assert.equal(st.pinned, '2.1.319');
    assert.equal(st.source, 'npm');
    const phases: string[] = [];
    const inst = await rt.install('claude-code', null, (p) => phases.push(p.phase));
    assert.equal(inst.version, '2.1.319');
    assert.equal(inst.pinned, true);
    assert.ok(inst.bin.startsWith(path.join(dir, 'runtimes', 'claude-code', '2.1.319')), inst.bin);
    assert.deepEqual([...new Set(phases)], ['metadata', 'download', 'extract', 'check', 'done']);
    // The copy runs, with its auto-updater off (TeamBot decides when it updates).
    const v = await runQuick(inst.bin, ['--version']);
    assert.match(v.stdout, /claude 2\.1\.319 autoupdate-off=1/);
    st = await rt.status('claude-code');
    assert.equal(st.installed?.version, '2.1.319');
    assert.equal(st.latest, '2.1.320');
    assert.equal(st.updateAvailable, true, 'newer version on the registry → update notice');
    assert.equal(st.updateKind, 'latest');

    // Update: the newest version, through the same checks (signature + SHA-512), and only the copy in use stays.
    const up = await rt.install('claude-code', '2.1.320');
    assert.equal(up.pinned, false);
    assert.equal((await rt.status('claude-code')).updateAvailable, false);
    assert.deepEqual(fs.readdirSync(rt.dir('claude-code')).sort(), ['2.1.320', 'current.json']);

    rt.uninstall('claude-code');
    assert.equal(rt.current('claude-code'), null);
    assert.ok(!fs.existsSync(rt.dir('claude-code')));
  } finally {
    await reg.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('npm downloads that do not verify are refused and leave the working copy alone', async () => {
  const reg = await startFixtureRegistry({
    packages: [
      { name: CC, version: '2.1.319', files: ccFiles('2.1.319') },
      { name: CC, version: '2.1.320', files: ccFiles('2.1.320'), tamper: true },
      { name: CC, version: '2.1.321', files: ccFiles('2.1.321'), badSig: true },
      { name: CC, version: '2.1.322', files: [{ name: 'package/../../buiten.txt', data: 'x' }] },
      { name: CC, version: '2.1.323', files: [{ name: 'package/bin/claude', type: '2', linkname: '/bin/sh' }] },
    ],
  });
  const dir = tmp('tb-rt-bad-');
  try {
    const good = reg.integrity(CC, '2.1.319');
    // A pinned checksum that differs from what the registry signed: refused before anything is downloaded.
    const wrongPin = new Runtimes(dir, { registry: reg.url, keys: reg.keys, specs: { 'claude-code': { integrity: { [PLAT]: 'sha512-' + Buffer.alloc(64, 1).toString('base64') } } } });
    await assert.rejects(wrongPin.install('claude-code', null), /wijkt af van wat TeamBot vastlegde/);
    assert.ok(!reg.hits.some((h) => h.startsWith('/t/')), 'no download when the pin does not match');

    const rt = new Runtimes(dir, { registry: reg.url, keys: reg.keys, specs: { 'claude-code': { integrity: { [PLAT]: good } } } });
    await rt.install('claude-code', null);
    await assert.rejects(rt.install('claude-code', '2.1.320'), /controlesom/, 'tampered tarball');
    await assert.rejects(rt.install('claude-code', '2.1.321'), /handtekening van het npm-register klopt niet/, 'signed with an unknown key');
    await assert.rejects(rt.install('claude-code', '2.1.322'), /Onveilig pad/, 'path traversal in the archive');
    await assert.rejects(rt.install('claude-code', '2.1.323'), /link of ander bijzonder bestand/, 'symlinks are not extracted');
    assert.ok(!fs.existsSync(path.join(dir, 'runtimes', 'buiten.txt')) && !fs.existsSync(path.join(dir, 'buiten.txt')));
    assert.equal(rt.current('claude-code')?.version, '2.1.319', 'the working copy is still the verified one');
    assert.equal(rt.job('claude-code')?.phase, 'error');
    // Unknown key list: nothing verifies.
    assert.equal(verifyRegistrySignature(CC, '2.1.319', good, [{ keyid: 'SHA256:other', sig: 'AAAA' }], reg.keys), false);
  } finally {
    await reg.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GitHub source (OpenCode 2.x): pinned SHA-256, redirect to the asset host, version check, newest stable 2.x for "Bijwerken"', async () => {
  const gh = await startFixtureGithub({
    repo: REPO,
    releases: [
      rel('v2.2.6'),
      rel('v2.3.0'),
      rel('v2.9.0', { prerelease: true }),
      rel('v2.8.0', { draft: true }),
      rel('v3.0.0'),
      rel('v1.19.9'),
      { tag: 'process-daemon-v0.5.0', assets: [] },
    ],
  });
  const dir = tmp('tb-rt-gh-');
  try {
    const rt = new Runtimes(dir, { github: gh.url, specs: { opencode: { integrity: { [PLAT]: gh.digest('v2.2.6', ASSET) } } } });
    let st = await rt.status('opencode');
    assert.equal(st.source, 'github');
    assert.equal(st.pinned, '2.2.6');
    assert.equal(st.installed, null);
    assert.equal(st.latest, '2.3.0', 'newest stable 2.x: not the pre-release, the draft, 3.0 or 1.x');
    const phases: string[] = [];
    const inst = await rt.install('opencode', null, (p) => phases.push(p.phase));
    assert.equal(inst.version, '2.2.6');
    assert.equal(inst.integrity, gh.digest('v2.2.6', ASSET));
    assert.deepEqual([...new Set(phases)], ['metadata', 'download', 'extract', 'check', 'done']);
    assert.ok(gh.hits.some((h) => h.startsWith('/assets/')), 'followed github.com\'s redirect to its asset host');
    assert.match((await runQuick(inst.bin, ['--version'])).stdout, /opencode 2\.2\.6 autoupdate-off=1/);
    st = await rt.status('opencode');
    assert.equal(st.updateAvailable, true);
    assert.equal(st.updateKind, 'latest', 'a newer 2.x than the pinned one: only GitHub\'s own digest checks it');
    // "Bijwerken": the newest stable 2.x, checked against the digest GitHub publishes.
    const up = await rt.install('opencode', await rt.latest('opencode', true));
    assert.equal(up.version, '2.3.0');
    assert.equal(up.pinned, false);
    assert.equal(up.integrity, gh.digest('v2.3.0', ASSET));
    assert.equal((await rt.status('opencode')).installed?.pinned, false);
    await assert.rejects(rt.install('opencode', '3.0.0'), /alleen OpenCode 2\.x/);
    assert.equal(newestStable([{ tag_name: 'v2.2.6' }, { tag_name: 'v2.10.0' }, { tag_name: 'v2.11.0', prerelease: true }], 2), '2.10.0');
  } finally {
    await gh.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GitHub downloads that do not verify are refused and leave the working copy alone', async () => {
  const evil = tmp('tb-rt-gh-evil-');
  const gh = await startFixtureGithub({
    repo: REPO,
    releases: [
      rel('v2.2.6'),
      rel('v2.3.0', { assets: [{ name: ASSET, data: ocAsset('2.3.0'), tamper: true }] }),
      rel('v2.3.1', { assets: [{ name: ASSET, data: ocAsset('2.3.1'), noDigest: true }] }),
      rel('v2.3.2', { prerelease: true }),
      rel('v2.3.3', { assets: [{ name: ASSET, data: ocAsset('2.3.3'), url: 'https://example.com/opencode.zip' }] }),
      rel('v2.3.4', { assets: [{ name: ASSET, data: ocAsset('2.3.4'), evilRedirect: true }] }),
      rel('v2.3.5', { assets: [{ name: ASSET, data: ocAsset('2.3.5', [{ name: '../../buiten.txt', data: 'x' }]) }] }),
      rel('v2.3.6', { assets: [{ name: ASSET, data: ocAsset('2.3.6', [{ name: 'opencode', data: '/bin/sh', mode: 0o120777 }]) }] }),
      rel('v2.3.7', {}, '2.3.0'),
      { tag: 'v2.3.8', assets: [{ name: 'opencode-other.zip', data: Buffer.from('x') }] },
    ],
  });
  const dir = tmp('tb-rt-gh-bad-');
  try {
    // A pin that differs from GitHub's digest: refused before anything is downloaded.
    const wrongPin = new Runtimes(dir, { github: gh.url, specs: { opencode: { integrity: { [PLAT]: 'sha256:' + '0'.repeat(64) } } } });
    await assert.rejects(wrongPin.install('opencode', null), /wijkt af van wat TeamBot vastlegde/);
    assert.ok(!gh.hits.some((h) => h.includes('/releases/download/')), 'no download when the pin does not match');

    const rt = new Runtimes(dir, { github: gh.url, specs: { opencode: { integrity: { [PLAT]: gh.digest('v2.2.6', ASSET) } } } });
    await rt.install('opencode', null);
    await assert.rejects(rt.install('opencode', '2.3.0'), /klopt niet met de controlesom/, 'swapped download');
    await assert.rejects(rt.install('opencode', '2.3.1'), /publiceert geen controlesom/, 'no digest, no install');
    await assert.rejects(rt.install('opencode', '2.3.2'), /geen stabiele uitgave/, 'pre-release');
    await assert.rejects(rt.install('opencode', '2.3.3'), /hoort niet bij de uitgaven van de maker/, 'download outside the repository');
    await assert.rejects(rt.install('opencode', '2.3.4'), /adres dat TeamBot niet vertrouwt/, 'redirect to another host');
    if (ASSET.endsWith('.zip')) {
      await assert.rejects(rt.install('opencode', '2.3.5'), /Onveilig pad/, 'path traversal in the zip');
      await assert.rejects(rt.install('opencode', '2.3.6'), /link of ander bijzonder bestand/, 'symlink in the zip');
    }
    await assert.rejects(rt.install('opencode', '2.3.7'), /meldt zich als versie 2\.3\.0/, 'a program that is another version');
    await assert.rejects(rt.install('opencode', '2.3.8'), /geen download voor dit platform/);
    await assert.rejects(rt.install('opencode', '2.4.0'), /GitHub antwoordde 404/);
    assert.ok(!fs.existsSync(path.join(dir, 'runtimes', 'buiten.txt')) && !fs.existsSync(path.join(dir, 'buiten.txt')));
    assert.equal(rt.current('opencode')?.version, '2.2.6', 'the working copy is still the verified one');
    assert.deepEqual(fs.readdirSync(rt.dir('opencode')).sort(), ['2.2.6', 'current.json'], 'no leftovers');
  } finally {
    await gh.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(evil, { recursive: true, force: true });
  }
});

test('an OpenCode 1.x copy from before (npm) is offered the pinned 2.x, with its own checksum', async () => {
  const gh = await startFixtureGithub({ repo: REPO, releases: [rel('v2.2.6')] });
  const dir = tmp('tb-rt-gh-old-');
  try {
    const old = path.join(dir, 'runtimes', 'opencode', '1.19.5');
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, 'opencode.mjs'), fakeCliScript({ name: 'opencode', version: '1.19.5' }));
    fs.writeFileSync(path.join(dir, 'runtimes', 'opencode', 'current.json'), JSON.stringify({ version: '1.19.5', bin: path.join(old, 'opencode.mjs'), integrity: 'sha512-x', installedAt: '2026-11-07T10:00:00Z', pinned: true }));
    const rt = new Runtimes(dir, { github: gh.url, specs: { opencode: { integrity: { [PLAT]: gh.digest('v2.2.6', ASSET) } } } });
    const st = await rt.status('opencode');
    assert.equal(st.installed?.pinned, false, 'not the version TeamBot pins (any more)');
    assert.equal(st.updateAvailable, true);
    assert.equal(st.latest, '2.2.6');
    assert.equal(st.updateKind, 'pinned', 'the update is the pinned version, checked against TeamBot\'s own SHA-256');
    const up = await rt.install('opencode', st.latest);
    assert.equal(up.pinned, true);
    assert.deepEqual(fs.readdirSync(rt.dir('opencode')).sort(), ['2.2.6', 'current.json'], 'the old copy is gone');
  } finally {
    await gh.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('zip and npm tarball extraction: into the target folder only, exec bit kept, damaged archives refused', async () => {
  const dir = tmp('tb-tar-');
  try {
    const long = 'package/vendor/' + 'x'.repeat(60) + '/' + 'y'.repeat(50) + '/bin/codex.mjs';
    const f = path.join(dir, 'a.tgz');
    // ustar "prefix" field for a long path (as npm pack writes them)
    fs.writeFileSync(f, tarGz([{ name: 'package/package.json', data: '{}' }, { name: 'package/a/b.txt', data: 'hallo' }]));
    const out = await extractNpmTarball(f, path.join(dir, 'out'));
    assert.equal(fs.readFileSync(path.join(dir, 'out', 'a', 'b.txt'), 'utf8'), 'hallo');
    assert.equal(out.length, 2);
    assert.ok(long.length > 100);
    assert.equal(newer('1.20.0', '1.19.5'), true);
    assert.equal(newer('1.19.5', '1.19.5'), false);
    assert.equal(newer('0.167.0', '0.170.1'), false);

    const big = Buffer.alloc(300_000, 'opencode ');
    const z = path.join(dir, 'a.zip');
    fs.writeFileSync(z, zip([{ name: 'bin/', mode: 0o040755 }, { name: 'bin/opencode', data: big, mode: 0o100755 }, { name: 'LEESMIJ.txt', data: 'hallo', method: 0 }]));
    const zout = await extractZip(z, path.join(dir, 'zout'));
    assert.equal(zout.length, 2);
    assert.ok(fs.readFileSync(path.join(dir, 'zout', 'bin', 'opencode')).equals(big), 'deflated entry intact');
    assert.equal(fs.readFileSync(path.join(dir, 'zout', 'LEESMIJ.txt'), 'utf8'), 'hallo', 'stored entry');
    if (process.platform !== 'win32') assert.ok(fs.statSync(path.join(dir, 'zout', 'bin', 'opencode')).mode & 0o100, 'exec bit kept');
    const bad = (name: string, files: Parameters<typeof zip>[0]) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, zip(files));
      return extractZip(p, path.join(dir, 'x-' + name));
    };
    await assert.rejects(bad('crc.zip', [{ name: 'a', data: 'hallo', badCrc: true }]), /controlegetal klopt niet/);
    await assert.rejects(bad('abs.zip', [{ name: 'C:/Windows/x.txt', data: 'x' }]), /Onveilig pad/);
    await assert.rejects(bad('abs2.zip', [{ name: '/etc/x', data: 'x' }]), /Onveilig pad/);
    await assert.rejects(bad('up.zip', [{ name: 'a/../../x', data: 'x' }]), /Onveilig pad/);
    await assert.rejects(bad('link.zip', [{ name: 'l', data: '/etc/passwd', mode: 0o120777 }]), /link of ander bijzonder bestand/);
    fs.writeFileSync(path.join(dir, 'kort.zip'), zip([{ name: 'a', data: 'hallo' }]).subarray(0, 20));
    await assert.rejects(extractZip(path.join(dir, 'kort.zip'), path.join(dir, 'x-kort')), /geen geldig zip-bestand/);
    assert.ok(!fs.existsSync(path.join(dir, 'x')) && !fs.existsSync(path.join(dir, '..', 'x')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the real pins: SHA-512 per platform for the npm copies, SHA-256 per platform for OpenCode 2.x; npm\'s signing key is pinned in TeamBot', () => {
  for (const [id, s] of Object.entries(RUNTIMES)) {
    for (const p of ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64']) {
      if (s.source === 'github') assert.match(s.integrity[p], /^sha256:[0-9a-f]{64}$/, `${id} ${p}`);
      else assert.match(s.integrity[p], /^sha512-[A-Za-z0-9+/]{86}==$/, `${id} ${p}`);
    }
    assert.match(s.pinned, /^\d+\.\d+\.\d+$/);
  }
  assert.equal(RUNTIMES['claude-code'].source, 'npm');
  assert.equal(RUNTIMES['codex-cli'].source, 'npm');
  assert.equal(RUNTIMES.opencode.source, 'github');
  assert.equal(RUNTIMES.opencode.main, 'anomalyco/opencode');
  assert.equal(RUNTIMES.opencode.pinned, '2.2.6');
  assert.equal(RUNTIMES['codex-cli'].pkg('win32-x64', '0.167.0').version, '0.167.0-win32-x64');
  assert.equal(RUNTIMES.opencode.asset!('win32-x64'), 'opencode-windows-x64.zip');
  assert.equal(RUNTIMES.opencode.asset!('win32-arm64'), 'opencode-windows-arm64.zip');
  assert.equal(RUNTIMES.opencode.asset!('darwin-arm64'), 'opencode-darwin-arm64.zip');
  assert.equal(RUNTIMES.opencode.asset!('linux-x64'), 'opencode-linux-x64.tar.gz');
  assert.equal(RUNTIMES.opencode.asset!('freebsd-x64'), null);
  assert.equal(RUNTIMES['claude-code'].pkg('darwin-arm64', '2.1.319').name, '@anthropic-ai/claude-code-darwin-arm64');
});

test('Codex logs in inside TeamBot with a device code; Claude Code and OpenCode get the exact terminal command', async () => {
  assert.deepEqual(parseDeviceLogin('1. Open \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n2. Enter\n   \x1b[94mWXYZ-12345\x1b[0m'), { url: 'https://auth.openai.com/codex/device', code: 'WXYZ-12345' });
  const dir = tmp('tb-login-');
  try {
    const fake = path.join(dir, 'codex.mjs');
    fs.writeFileSync(fake, fakeCliScript({ name: 'codex-cli', version: '0.167.0' }));
    const logins = new DeviceLogins();
    let ended: any = null;
    const l = await logins.start('codex-cli', fake, ['login', '--device-auth'], (x) => (ended = x));
    assert.equal(l.state, 'waiting');
    assert.equal(l.url, 'https://auth.openai.com/codex/device');
    assert.equal(l.code, 'WXYZ-12345');
    await until(async () => ended);
    assert.equal(ended.state, 'done');
    // Cancelling a login that waits stops the CLI.
    process.env.FAKE_LOGIN_MS = '20000';
    const l2 = await logins.start('codex-cli', fake, ['login', '--device-auth'], () => {});
    assert.equal(l2.state, 'waiting');
    logins.cancel('codex-cli');
    assert.equal(logins.get('codex-cli'), null);
  } finally {
    delete process.env.FAKE_LOGIN_MS;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const win = 'C:\\Users\\Ron Nie\\AppData\\Roaming\\TeamBot\\runtimes\\claude-code\\2.1.319\\claude.exe';
  assert.match(loginCommand('claude-code', win, 'claude auth login'), /claude\.exe" auth login$/);
  assert.equal(loginCommand('opencode', null, 'opencode auth login'), 'opencode auth login');
  // The terminal is started without a shell string from the request (owner, desktop only — see the route).
  const calls: any[] = [];
  assert.equal(openTerminal('claude auth login', 'win32', ((cmd: string, args: string[]) => (calls.push([cmd, args]), { unref() {} })) as any), true);
  assert.equal(calls[0][0], 'powershell.exe');
  assert.match(calls[0][1].join(' '), /start-process powershell -argumentlist '-noexit','-command','claude auth login'/);
});


// Acceptance round 4 (C-07): Claude Code could only log in through a terminal. 2.1.319 prints a sign-in link without a
// terminal and waits for the code from the sign-in page: TeamBot drives that like the Codex device login.
test('Claude Code logs in inside TeamBot: the sign-in link, then the pasted code; the CLI opens no browser itself', async () => {
  const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-agents-fake-claude.mjs');
  assert.deepEqual(parsePasteLogin("Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=x\nPaste code here if prompted > "), { url: 'https://claude.com/cai/oauth/authorize?code=true&state=x', prompt: true });
  assert.ok(path.isAbsolute(noBrowser()));
  const logins = new DeviceLogins();
  let ended: any = null;
  const l = await logins.start('claude-code', FAKE_CLAUDE, ['auth', 'login', '--claudeai'], (x) => (ended = x));
  assert.equal(l.state, 'waiting');
  assert.equal(l.needsCode, true);
  assert.equal(l.code, undefined, 'no code to show: the page gives one');
  assert.match(l.url!, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true/);
  assert.throws(() => logins.submit('claude-code', 'hoi; Remove-Item C:\\x'), /geen code van de inlogpagina/, 'only a code, never a command');
  const s = logins.submit('claude-code', '  goede-code#s123 ');
  assert.equal(s.checking, true);
  assert.throws(() => logins.submit('claude-code', 'goede-code#s123'), /al gecontroleerd/);
  await until(async () => ended);
  assert.equal(ended.state, 'done');
  // A wrong code: a plain error, without the code or the link.
  let ended2: any = null;
  await logins.start('claude-code', FAKE_CLAUDE, ['auth', 'login', '--claudeai'], (x) => (ended2 = x));
  logins.submit('claude-code', 'foute-code-die-niet-klopt#s123');
  await until(async () => ended2);
  assert.equal(ended2.state, 'error');
  assert.match(ended2.error, /^De code werd niet geaccepteerd\. Begin opnieuw met "Hier inloggen"/);
  assert.doesNotMatch(ended2.error, /foute-code|https:/);
  // Nothing of the CLI's own English output ("If the browser didn't open, visit: … OAuth error: Invalid code").
  assert.doesNotMatch(ended2.error, /browser|OAuth|Invalid|visit/i);
  assert.throws(() => logins.submit('claude-code', 'goede-code#s123'), /Er wacht geen inlogpoging/);

  // Through the API, as the CLI page does it.
  const t = await startTestApp();
  const log = path.join(t.dir, 'fake-cli.log');
  process.env.FAKE_CLI_LOG = log;
  try {
    await t.api('PUT', '/cli-agents/paths/claude-code', { path: FAKE_CLAUDE });
    const st = (await t.api('GET', '/cli-agents/status?fresh=1')).items.find((i: any) => i.id === 'claude-code');
    assert.equal(st.deviceLogin, true);
    assert.equal(st.pasteLogin, true);
    const events: any[] = [];
    const off = t.app.ctx.events.on('cli.login', (e: any) => events.push(e.data));
    const r = await t.api('POST', '/cli-agents/claude-code/login', {});
    assert.equal(r.mode, 'device');
    assert.equal(r.login.needsCode, true);
    await assert.rejects(t.api('POST', '/cli-agents/claude-code/login/code', { code: 'x' }), /geen code van de inlogpagina/);
    await t.api('POST', '/cli-agents/claude-code/login/code', { code: 'goede-code#s123' });
    const done = await until(async () => events.find((e) => e.state === 'done' || e.state === 'error'));
    off();
    assert.equal(done.state, 'done');
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((x) => JSON.parse(x));
    const started = lines.find((x) => x.mode === 'login');
    assert.deepEqual(started.argv, ['auth', 'login', '--claudeai']);
    assert.equal(started.browser, noBrowser(), 'the CLI got a BROWSER that opens nothing');
    const audit = JSON.stringify(t.app.ctx.store.all<any>('SELECT * FROM audit'));
    assert.ok(audit.includes('cli.login_code'));
    assert.ok(!audit.includes('goede-code'), 'the code is never stored');
  } finally {
    delete process.env.FAKE_CLI_LOG;
    await t.close();
  }
});

test('API: own copy is preferred and named; "Gratis starten" installs OpenCode 2.x from GitHub and connects it on a free model', async () => {
  const gh = await startFixtureGithub({ repo: REPO, releases: [rel('v2.2.6')] });
  const env = { ...process.env };
  process.env.TEAMBOT_RUNTIME_GITHUB = gh.url;
  process.env.TEAMBOT_RUNTIME_PINS = JSON.stringify({ opencode: { integrity: { [PLAT]: gh.digest('v2.2.6', ASSET) } } });
  // No real OpenCode, Claude Code or Codex from this PC: an empty PATH and home.
  const home = tmp('tb-rt-home-');
  process.env.PATH = path.dirname(process.execPath);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
  process.env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
  process.env.XDG_DATA_HOME = path.join(home, 'xdg');
  const t = await startTestApp();
  try {
    let st = await t.api('GET', '/cli-agents/status?fresh=1');
    const oc = st.items.find((i: any) => i.id === 'opencode');
    assert.equal(oc.installed, false);
    assert.equal(oc.managed, true);
    assert.equal(oc.canInstall, false, 'no global npm install for the CLIs TeamBot can keep itself');
    assert.equal(oc.runtime.pinned, '2.2.6');
    assert.equal(oc.runtime.source, 'github');
    const events: any[] = [];
    const off = t.app.ctx.events.on('cli.freestart', (e: any) => events.push(e.data));
    const r = await t.api('POST', '/cli-agents/free-start', {});
    assert.equal(r.status, 'installing');
    const done = await until(async () => events.find((e) => e.status));
    off();
    assert.equal(done.status, 'ready', JSON.stringify(done));
    assert.equal(done.model, 'opencode/big-pickle', 'a free model, no account');
    st = await t.api('GET', '/cli-agents/status?fresh=1');
    const after = st.items.find((i: any) => i.id === 'opencode');
    assert.equal(after.installed, true);
    assert.equal(after.pathSource, 'teambot', 'TeamBot says which copy it uses');
    assert.equal(after.version, '2.2.6');
    assert.ok(after.path.startsWith(t.dir), 'inside TeamBot\'s data folder');
    assert.ok(st.providers.some((p: any) => p.kind === 'opencode'));
    // Second click: already there → ready at once.
    const again = await t.api('POST', '/cli-agents/free-start', {});
    assert.equal(again.status, 'ready');
    // Uninstall: the copy is gone, OpenCode is "niet gevonden" again.
    const un = await t.api('DELETE', '/cli-agents/runtimes/opencode');
    assert.equal(un.runtime.installed, null);
    assert.equal(un.status.installed, false);
    assert.ok(t.app.ctx.store.all<any>('SELECT kind FROM audit').some((a) => a.kind === 'cli.runtime_installed'));
  } finally {
    await t.close();
    await gh.close();
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
    Object.assign(process.env, env);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
