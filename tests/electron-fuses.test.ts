import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FuseV1Options } from '@electron/fuses';
// @ts-ignore — plain .mjs build script without types
import { FUSES, executablePath } from '../scripts/after-pack.mjs';

const root = path.resolve(import.meta.dirname, '..');

test('electron fuses: the afterPack hook is wired up and switches off what TeamBot does not use', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.build.afterPack, './scripts/after-pack.mjs');
  assert.ok(pkg.devDependencies['@electron/fuses'], '@electron/fuses is a pinned devDependency');
  assert.equal(FUSES[FuseV1Options.EnableNodeOptionsEnvironmentVariable], false);
  assert.equal(FUSES[FuseV1Options.EnableNodeCliInspectArguments], false);
  assert.equal(FUSES[FuseV1Options.EnableCookieEncryption], true);
  assert.equal(FUSES[FuseV1Options.EnableEmbeddedAsarIntegrityValidation], true);
  assert.equal(FUSES[FuseV1Options.OnlyLoadAppFromAsar], true);
  assert.equal(pkg.build.asar, true, 'OnlyLoadAppFromAsar and the integrity check need an asar archive');
  const exe = executablePath({ appOutDir: 'out', electronPlatformName: 'win32', packager: { appInfo: { productFilename: 'TeamBot' } } });
  assert.equal(exe, path.join('out', 'TeamBot.exe'));
});

test('electron fuses: RunAsNode stays on while the CLI bridge runs TeamBot.exe as Node', () => {
  const proc = fs.readFileSync(path.join(root, 'server/modules/cli-agents/proc.ts'), 'utf8');
  if (/ELECTRON_RUN_AS_NODE/.test(proc)) assert.equal(FUSES[FuseV1Options.RunAsNode], true, 'switching RunAsNode off breaks the MCP bridge of Claude Code, Codex and OpenCode');
});
