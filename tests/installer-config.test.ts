// The Windows installer for a normal person (release 0.4.2, docs/IOS_WINDOWS_RELEASE.md): one click, per user, no admin
// prompt, TeamBot starts afterwards, Start menu and desktop shortcut with the TeamBot icon, data kept on uninstall unless
// the person says Yes (tests/installer-nsh.test.ts plays that question). Signing is one block away, the update channel
// one address away, and the website says what to click in SmartScreen until the installer is signed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
const pkg = JSON.parse(read('package.json'));
const win = pkg.build.win;
const nsis = pkg.build.nsis;
const require = createRequire(import.meta.url);
const schema = require('app-builder-lib/scheme.json');

test('installer: one click, per user, starts TeamBot, Start menu and desktop shortcut', () => {
  assert.equal(nsis.oneClick, true, 'no wizard: double-click = install');
  assert.equal(nsis.perMachine, false, 'per user: no admin prompt, silent updates without UAC');
  assert.notEqual(nsis.runAfterFinish, false, 'TeamBot starts when the installer is done');
  assert.equal(nsis.createStartMenuShortcut, true);
  assert.equal(nsis.createDesktopShortcut, true, 'true, not "always": a deleted desktop shortcut stays deleted after an update');
  assert.equal(nsis.shortcutName, 'TeamBot');
  assert.equal(nsis.deleteAppDataOnUninstall, false);
  assert.ok(!('allowToChangeInstallationDirectory' in nsis), 'electron-builder refuses it with one-click');
  assert.ok(!('license' in nsis), 'one-click would show an extra English licence page; the texts ship in resources/');
  assert.ok(pkg.build.extraResources.some((r: { to: string }) => r.to === 'LICENSE.txt') && pkg.build.extraResources.some((r: { to: string }) => r.to === 'THIRD_PARTY_NOTICES.txt'));
  assert.notEqual(nsis.multiLanguageInstaller, false, 'the language of Windows (Dutch, English, …), not English only');
  assert.ok(!nsis.installerLanguages || (nsis.installerLanguages.includes('nl_NL') && nsis.installerLanguages.includes('en_US')));
  assert.deepEqual(win.target, [{ target: 'nsis', arch: ['x64'] }]);
  assert.equal(win.artifactName, 'TeamBot-Setup-${version}.${ext}', 'the name the website, SHA256SUMS and the way back use');
  assert.equal(pkg.build.appId, 'app.teambot.desktop', 'the same app id: an update finds the installed TeamBot');
  assert.match(read('desktop/main.ts'), /app\.setAppUserModelId\('app\.teambot\.desktop'\)/, 'the shortcut and the running app share the id (notifications, taskbar)');
  // Every option is one electron-builder knows (a typo would be a silent no-op or a failed release build).
  for (const k of Object.keys(nsis)) assert.ok(k in schema.definitions.NsisOptions.properties, `nsis.${k}`);
  for (const k of Object.keys(win)) assert.ok(k in schema.definitions.WindowsConfiguration.properties, `win.${k}`);
});

test('installer: the TeamBot icon, also in the installer window (an .ico made from build/icon.png)', () => {
  const png = fs.readFileSync(path.join(root, win.icon));
  assert.ok(png.readUInt32BE(16) >= 256 && png.readUInt32BE(20) >= 256, 'electron-builder needs at least 256×256');
  assert.equal(nsis.installerHeaderIcon, 'build/icon.ico');
  const ico = fs.readFileSync(path.join(root, nsis.installerHeaderIcon));
  assert.deepEqual([...ico.subarray(0, 4)], [0, 0, 1, 0], 'an ICO file');
  const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico[6 + i * 16] || 256);
  for (const s of [16, 32, 48, 256]) assert.ok(sizes.includes(s), `contains ${s}×${s}`);
  assert.match(pkg.scripts.icons, /make-ico\.mjs/, 'npm run icons keeps the .ico in step with the .png');
});

test('signing: unsigned today, one block away (documented, and the release workflow passes the secrets)', async () => {
  assert.notEqual(win.verifyUpdateCodeSignature, false, 'once signed, updates are checked against the publisher');
  const required: string[] = schema.definitions.WindowsAzureSigningConfiguration.required;
  assert.deepEqual([...required].sort(), ['certificateProfileName', 'codeSigningAccountName', 'endpoint', 'publisherName']);
  // When the block is there, it is complete and not the example from the docs.
  if (win.azureSignOptions) {
    for (const k of required) assert.ok(typeof win.azureSignOptions[k] === 'string' && win.azureSignOptions[k].trim(), `win.azureSignOptions.${k}`);
    assert.match(win.azureSignOptions.endpoint, /^https:\/\/[a-z]+\.codesigning\.azure\.net\/?$/);
    assert.notEqual(win.azureSignOptions.publisherName, 'Voornaam Achternaam', 'the real name from the certificate');
  }
  // The block in the docs is valid JSON with exactly the fields electron-builder requires.
  const doc = read('docs/IOS_WINDOWS_RELEASE.md');
  const m = /```json\s*\n\s*"azureSignOptions":\s*(\{[\s\S]*?\})\s*```/.exec(doc);
  assert.ok(m, 'docs/IOS_WINDOWS_RELEASE.md has the azureSignOptions block');
  const block = JSON.parse(m[1]);
  assert.deepEqual(Object.keys(block).sort(), [...required].sort());
  for (const k of Object.keys(block)) assert.ok(k in schema.definitions.WindowsAzureSigningConfiguration.properties);
  // electron-builder's own validation (what `npm run dist:win` runs first): today's config, and today's config plus
  // that block, are both accepted; nothing is built or signed here.
  const { validateConfiguration } = require('app-builder-lib/out/util/config/config');
  const { DebugLogger } = require('builder-util/out/DebugLogger');
  const copy = () => JSON.parse(JSON.stringify(pkg.build));
  await validateConfiguration(copy(), new DebugLogger(false));
  const signed = copy();
  signed.win.azureSignOptions = block;
  await validateConfiguration(signed, new DebugLogger(false));
  const half = copy();
  half.win.azureSignOptions = { publisherName: block.publisherName };
  await assert.rejects(validateConfiguration(half, new DebugLogger(false)), /Invalid configuration/);
  // The release workflow hands both kinds of credentials to the build.
  const wf = read('.github/workflows/release.yml');
  for (const s of ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET']) assert.match(wf, new RegExp(`${s}: \\$\\{\\{ secrets\\.${s} \\}\\}`), s);
  assert.match(wf, /CSC_LINK: \$\{\{ secrets\.WIN_CSC_LINK \}\}/);
  assert.match(wf, /CSC_KEY_PASSWORD: \$\{\{ secrets\.WIN_CSC_KEY_PASSWORD \}\}/);
});

test('updates: one channel in build.publish (a folder or GitHub Releases); the placeholder is never used', async () => {
  const pub = pkg.build.publish;
  assert.equal(pub.length, 1);
  assert.ok(['generic', 'github'].includes(pub[0].provider), 'desktop/update-channel.ts speaks a folder (generic) or GitHub Releases');
  const { builtInChannel } = await import('../desktop/update-channel.js');
  const yml = Object.entries(pub[0]).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n';
  const built = builtInChannel(yml);
  if (pub[0].provider === 'generic') {
    assert.match(pub[0].url, /^https:\/\//);
    if (/\.invalid\//.test(pub[0].url)) assert.equal(built, null, 'no hosting yet: no channel, the page says new versions come with the next installer');
    else assert.deepEqual(built, { provider: 'generic', url: pub[0].url }, 'real hosting: every installed TeamBot uses it by default');
  } else {
    assert.ok(built, 'a real public repository (owner/repo), not a placeholder');
    assert.notEqual(pub[0].private, true, 'a private repository would need a token in the app');
  }
  // The documented switch: the exact entries in docs/RELEASE_CHECKLIST.md are valid channels.
  const doc = read('docs/RELEASE_CHECKLIST.md');
  const blocks = [...doc.matchAll(/```json\s*\n\s*"publish":\s*(\[[\s\S]*?\])\s*```/g)].map((m) => JSON.parse(m[1]));
  assert.equal(blocks.length, 2, 'two ways: GitHub Releases and a folder on a web server');
  assert.deepEqual(blocks.map((b) => b[0].provider).sort(), ['generic', 'github']);
  assert.ok(blocks.some((b) => b[0].provider === 'github' && b[0].releaseType === 'release'));
  const { validateConfiguration } = require('app-builder-lib/out/util/config/config');
  const { DebugLogger } = require('builder-util/out/DebugLogger');
  for (const b of blocks) await validateConfiguration({ ...JSON.parse(JSON.stringify(pkg.build)), publish: b }, new DebugLogger(false));
  assert.match(pkg.scripts['release:feed'], /scripts\/release-feed\.mjs/);
});

test('signing route SignPath (free for open source): one block in build.win, the workflow signs and remakes latest.yml', async () => {
  const doc = read('docs/IOS_WINDOWS_RELEASE.md');
  const m = /```json\s*\n\s*"signtoolOptions":\s*(\{[\s\S]*?\})\s*```/.exec(doc);
  assert.ok(m, 'docs/IOS_WINDOWS_RELEASE.md has the signtoolOptions block for SignPath');
  const block = JSON.parse(m[1]);
  assert.deepEqual(Object.keys(block), ['publisherName'], 'electron-builder writes the publisher into app-update.yml; SignPath signs');
  const { validateConfiguration } = require('app-builder-lib/out/util/config/config');
  const { DebugLogger } = require('builder-util/out/DebugLogger');
  const signed = JSON.parse(JSON.stringify(pkg.build));
  signed.win.signtoolOptions = block;
  await validateConfiguration(signed, new DebugLogger(false));
  if (win.signtoolOptions?.publisherName) assert.notEqual(win.signtoolOptions.publisherName, 'Naam op het certificaat', 'the real name');
  const wf = read('.github/workflows/release.yml');
  assert.match(wf, /if: \$\{\{ vars\.SIGNPATH_ORGANIZATION_ID != '' \}\}/, 'off until the owner sets the variable');
  assert.match(wf, /api-token: \$\{\{ secrets\.SIGNPATH_API_TOKEN \}\}/);
  assert.match(wf, /npm run release:feed -- --out release --only-new/, 'a signed installer changes: latest.yml and blockmap again');
  assert.match(wf, /npm run release:feed -- --check/);
  assert.match(wf, /release\/\*\.blockmap/, 'the blockmap goes along to the release (smaller updates)');
});

test('website: until the installer is signed, two plain sentences say what to click in SmartScreen', () => {
  const release = JSON.parse(read('website/src/release.json'));
  assert.equal(typeof release.features.signed?.on, 'boolean', 'a "signed" switch');
  for (const [lang, more, run] of [
    ['nl', 'Meer informatie', 'Toch uitvoeren'],
    ['en', 'More info', 'Run anyway'],
  ]) {
    const d = JSON.parse(read(`website/src/${lang}.json`)).download;
    assert.equal(d.smart.length, 2, `${lang}: two sentences`);
    for (const s of d.smart) {
      assert.equal(s.if, '!signed', `${lang}: gone once signed`);
      assert.equal((s.text.match(/[.!?](\s|$)/g) || []).length, 1, `${lang}: one sentence each: ${s.text}`);
    }
    const all = d.smart.map((s: { text: string }) => s.text).join(' ');
    assert.ok(all.includes(`**${more}**`) && all.includes(`**${run}**`), `${lang}: the two buttons, as Windows names them`);
    assert.ok(all.indexOf(more) < all.indexOf(run), `${lang}: in the order you click them`);
  }
  assert.match(read('website/build.mjs'), /d\.smart\.length \?/, 'the section disappears when the texts are switched off');
});
