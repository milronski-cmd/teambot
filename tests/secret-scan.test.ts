// Secret scan (D-15): the files inside app.asar are scanned with the same rules as files on disk. The archive reader
// is checked against @electron/asar (the library electron-builder packs with), on an archive with packed, unpacked and
// skipped files. The planted values are put together at runtime, so this file itself stays clean for the repo scan.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { openAsar, scanAsar, scanText } from '../scripts/secret-scan.mjs';

interface AsarLib {
  createPackageWithOptions(src: string, dest: string, options: { unpack?: string }): Promise<unknown>;
  extractFile(archive: string, filename: string): Buffer;
}
const asar = createRequire(import.meta.url)('@electron/asar') as AsarLib;

const GITHUB = ['gh', 'p_', 'R7k2Lm9Qw4Zt8Yp3Vn6Bc1Xd5Hf0Js2Ga7Ke'].join('');
const AWS = ['AK', 'IA', 'Q3VZ7NWP2RLT5KXM'].join('');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-secret-scan-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(rel: string, data: string | Buffer) {
  const p = path.join(tmp, 'src', ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}
async function pack(): Promise<string> {
  write('dist/server/main.js', 'export const ok = 1;\n');
  write('dist/leak.js', `// build output\nconst a = 1;\nconst token = '${GITHUB}';\n`);
  write('node_modules/pkg/index.js', `module.exports = { key: '${AWS}' };\n`);
  write('node_modules/pkg/docs.js', `// AWS docs: ${['AK', 'IA'].join('')}IOSFODNN7EXAMPLE\n`);
  write('assets/logo.png', Buffer.from(`\x89PNG ${GITHUB}`, 'latin1'));
  write('bin/tool.cmd', `@echo off\r\nset T=${GITHUB}\r\n`);
  const dest = path.join(tmp, 'app.asar');
  await asar.createPackageWithOptions(path.join(tmp, 'src'), dest, { unpack: '*.cmd' });
  return dest;
}
const archiveFile = await pack();

test('asar reader: same files and bytes as @electron/asar, unpacked files from <archive>.unpacked', () => {
  const file = archiveFile;
  assert.ok(fs.existsSync(path.join(`${file}.unpacked`, 'bin', 'tool.cmd')), 'the .cmd file is kept outside the archive');
  const archive = openAsar(file);
  try {
    const paths = archive.entries.map((e) => e.path).sort();
    assert.deepEqual(paths, ['assets/logo.png', 'bin/tool.cmd', 'dist/leak.js', 'dist/server/main.js', 'node_modules/pkg/docs.js', 'node_modules/pkg/index.js']);
    for (const e of archive.entries) {
      assert.equal(e.unpacked, e.path === 'bin/tool.cmd', e.path);
      assert.ok(archive.read(e).equals(asar.extractFile(file, e.path.split('/').join(path.sep))), `same bytes: ${e.path}`);
      assert.equal(archive.read(e).length, e.size);
    }
  } finally {
    archive.close();
  }
});

test('asar scan: finds a key in the app code and in node_modules, with the path inside the archive', () => {
  const file = archiveFile;
  const r = scanAsar(file, 'resources/app.asar');
  assert.equal(r.entries, 6);
  assert.equal(r.scanned, 5, 'the .png is skipped like on disk');
  const got = r.findings.map((f) => `${f.kind} ${f.file}:${f.line}`).sort();
  assert.deepEqual(got, [
    'AWS-sleutel resources/app.asar › node_modules/pkg/index.js:1',
    'GitHub-token resources/app.asar › bin/tool.cmd:2',
    'GitHub-token resources/app.asar › dist/leak.js:3',
  ]);
  assert.ok(r.findings.every((f) => !f.sample.includes(GITHUB) && !f.sample.includes(AWS)), 'never prints the whole value');

  // An unpacked file that was already scanned on disk is not read (or reported) twice.
  const seen = new Set([path.join(`${file}.unpacked`, 'bin', 'tool.cmd')]);
  const again = scanAsar(file, 'resources/app.asar', seen);
  assert.equal(again.scanned, 4);
  assert.equal(again.findings.length, 2);
});

test('asar scan: a broken archive is an error, not a silent skip', () => {
  const bad = path.join(tmp, 'broken.asar');
  fs.writeFileSync(bad, Buffer.from('this is not an asar archive at all'));
  assert.throws(() => openAsar(bad), /geen geldig asar-archief/);
  const truncated = path.join(tmp, 'truncated.asar');
  const good = fs.readFileSync(archiveFile);
  fs.writeFileSync(truncated, good.subarray(0, good.length - 10));
  assert.throws(() => openAsar(truncated), /geen geldig asar-archief/);
});

test('scan rules: obvious fakes pass, real-looking values do not', () => {
  assert.deepEqual(scanText(`aws = ${['AK', 'IA'].join('')}IOSFODNN7EXAMPLE`), []);
  assert.deepEqual(scanText(`const t = '${GITHUB.slice(0, 4)}${'x'.repeat(36)}'`), []);
  assert.deepEqual(
    scanText(`a\nb ${GITHUB}`).map((f) => [f.kind, f.line]),
    [['GitHub-token', 2]],
  );
});
