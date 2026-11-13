import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensure, find, onPath, status, toolchainOf, type Source } from '../server/core/runtimes.js';
import { sha256, sri, tarGz, zip } from './runtime-fixture.js';
import { bareSystemPath, fakeNpm, serve, withPath } from './toolchain-fixture.js';

/**
 * Node (npm, npx) and uv on demand (server/core/runtimes.ts), on a PC where they are missing: PATH holds only the
 * Windows (or /bin) folders, so `node`, `npx` and `uvx` are not found. Downloads come from a local stand-in.
 */

const isWin = process.platform === 'win32';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tb-runtimes-'));

function run(cmd: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    // Through the shell, like a user's terminal: the command is found on the PATH of `env` (npx.cmd on Windows).
    const p = spawn(cmd, args.map((a) => (isWin && /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)), { env, windowsHide: true, shell: isWin });
    let out = '';
    p.stdout?.on('data', (d: Buffer) => (out += d));
    p.stderr?.on('data', (d: Buffer) => (out += d));
    p.on('close', (code: number | null) => resolve({ code, out }));
    p.on('error', (e: Error) => resolve({ code: -1, out: String(e) }));
  });
}

test('toolchainOf maps commands to what they need', () => {
  assert.equal(toolchainOf('npx'), 'node');
  assert.equal(toolchainOf('npx.cmd'), 'node');
  assert.equal(toolchainOf('/usr/local/bin/node'), 'node');
  assert.equal(toolchainOf('uvx'), 'uv');
  assert.equal(toolchainOf('python'), null);
});

test('node: missing on PATH → one ensure() gets npm, and npx then runs a program with node', async () => {
  const dir = tmp();
  const pkg = fakeNpm();
  const srv = await serve({ '/npm.tgz': pkg });
  const source: Source = { version: '0.0.1-fixture', url: `${srv.url}/npm.tgz`, integrity: sri(pkg), sizeMb: 1 };
  try {
    await withPath(bareSystemPath(), async () => {
      assert.equal(onPath('node'), false, 'test PATH must not have node');
      assert.equal(find('node', dir), null);
      assert.equal(status('node', dir, { source }).source, null);
      const phases: string[] = [];
      // Two callers at once share one download.
      const [t, t2] = await Promise.all([ensure('node', dir, { source, onProgress: (p) => phases.push(p.phase) }), ensure('node', dir, { source })]);
      assert.equal(srv.hits.filter((h) => h === '/npm.tgz').length, 1);
      assert.equal(t.source, 'teambot');
      assert.equal(t2.source, 'teambot');
      assert.ok(phases.includes('download') && phases.at(-1) === 'done', phases.join(','));
      assert.equal(find('node', dir)?.source, 'teambot');
      const env = t.env(process.env);
      // npx found by name on the toolchain's PATH, and it starts a child with `node` (TeamBot's launcher).
      const r = await run('npx', ['-y', 'some-package', '-e', "console.log('child-ran-' + process.version)"], env);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /child-ran-v\d+/);
      const n = await run('npm', ['--version'], env);
      assert.match(n.out, /npm-fixture prefix-set/);
    });
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('node: a download that does not match the pinned checksum is refused and nothing is installed', async () => {
  const dir = tmp();
  const pkg = fakeNpm();
  const srv = await serve({ '/npm.tgz': Buffer.concat([pkg, Buffer.from('x')]) });
  try {
    await withPath(bareSystemPath(), async () => {
      await assert.rejects(ensure('node', dir, { source: { version: '1', url: `${srv.url}/npm.tgz`, integrity: sri(pkg), sizeMb: 1 } }), /controlegetal/);
      assert.equal(find('node', dir), null);
      assert.deepEqual(fs.readdirSync(path.join(dir, 'runtimes', 'node')).filter((f) => f.startsWith('tmp-')), []);
    });
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('uv: missing on PATH → ensure() puts uv and uvx in TeamBot’s folder and on the toolchain PATH', async () => {
  const dir = tmp();
  const names = isWin ? ['uv.exe', 'uvx.exe'] : ['uv', 'uvx'];
  const archive = isWin ? zip(names.map((n) => ({ name: n, data: 'bin', mode: 0o100755 }))) : tarGz(names.map((n) => ({ name: `uv-x86_64-unknown-linux-gnu/${n}`, data: 'bin', mode: 0o755 })));
  const file = isWin ? '/uv.zip' : '/uv.tar.gz';
  const srv = await serve({ [file]: archive });
  try {
    await withPath(bareSystemPath(), async () => {
      assert.equal(find('uv', dir), null);
      const t = await ensure('uv', dir, { source: { version: '9.9.9', url: srv.url + file, integrity: sha256(archive), sizeMb: 1 } });
      assert.equal(t.source, 'teambot');
      const env = t.env(process.env);
      assert.ok(onPath('uvx', env), 'uvx on the toolchain PATH');
      assert.match(env.UV_PYTHON_INSTALL_DIR, /runtimes[\\/]uv[\\/]python$/);
      assert.equal(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH').length, 1, 'one PATH key');
    });
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('found on PATH: the system copy is used as it is, nothing is downloaded', async () => {
  const dir = tmp();
  try {
    const t = find('node', dir);
    // The test machine runs on Node; npx is there when npm is.
    if (onPath('npx')) {
      assert.equal(t?.source, 'system');
      assert.deepEqual(t?.pathDirs, []);
    }
    assert.equal(fs.existsSync(path.join(dir, 'runtimes')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
