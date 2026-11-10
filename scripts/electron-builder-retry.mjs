// Runs electron-builder with the given arguments and retries up to 3 times when NSIS fails with
// ERR_ELECTRON_BUILDER_CANNOT_EXECUTE. On Windows this happens now and then when a virus scanner still holds the freshly
// written uninstaller while makensis tries to run it; a second attempt succeeds. Other errors fail immediately.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const args = process.argv.slice(2);
// The output folder: package.json build.directories.output, or -c.directories.output=<folder> (a test build elsewhere).
const outArg = args.map((a) => /^-c\.directories\.output=(.+)$/.exec(a)?.[1]).find(Boolean);
const outDir = outArg || 'release';
for (let attempt = 1; attempt <= 3; attempt++) {
  const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['electron-builder', ...args], { encoding: 'utf8', shell: process.platform === 'win32' });
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  if (r.status === 0) process.exit(0);
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (!/ERR_ELECTRON_BUILDER_CANNOT_EXECUTE/.test(out) || attempt === 3) process.exit(r.status || 1);
  console.warn(`\nmakensis kon niet uitvoeren (poging ${attempt}); opnieuw over 5 s…`);
  for (const f of fs.existsSync(outDir) ? fs.readdirSync(outDir) : []) if (f.endsWith('__uninstaller.exe')) fs.rmSync(`${outDir}/${f}`, { force: true });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
}
