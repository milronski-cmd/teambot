// npm run test:changed — only the unit tests that belong to what changed (not committed yet, or since <ref>:
// `npm run test:changed -- main`). A test belongs to a change when it is itself changed, names the changed file (its
// path without extension, as an import does: "server/agent/runner" for server/agent/runner.ts), or reads the source
// tree of a changed part (the checks over all texts and code, such as plural forms). Minutes instead of the whole
// suite; before a release the whole suite (npm test) still runs.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ref = process.argv[2] || 'HEAD';
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean);
const changed = [...new Set([...git('diff', '--name-only', ref), ...git('ls-files', '--others', '--exclude-standard')])].filter((f) => /\.(ts|tsx|mts|mjs)$/.test(f) && fs.existsSync(f));

function testFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'e2e' ? [] : testFiles(path.join(dir, e.name))) : e.name.endsWith('.test.ts') ? [path.join(dir, e.name).replace(/\\/g, '/')] : []));
}
const tests = testFiles('tests');
const source = changed.filter((f) => !f.startsWith('tests/'));
// "server/agent/runner.ts" → "server/agent/runner"; "ui/src/shell/ChatList.tsx" → "ui/src/shell/ChatList".
const keys = source.map((f) => f.replace(/\.(ts|tsx|mts|mjs)$/, ''));
// The part of the code a file is in ("ui/src", "server", …): a test that walks that tree checks every file in it.
const trees = [...new Set(source.map((f) => (f.startsWith('ui/src/') ? 'ui/src' : f.split('/')[0])))];
const walks = (text) => /readdirSync|globSync|walk\(/.test(text) && trees.some((d) => text.includes(`'${d}'`) || text.includes(`"${d}"`) || text.includes(`'${d}/`) || text.includes(`'${d.replace('/', "', '")}'`));
const picked = tests.filter((t) => {
  if (changed.includes(t)) return true;
  const text = fs.readFileSync(t, 'utf8');
  return keys.some((k) => text.includes(k)) || walks(text);
});

if (!picked.length) {
  console.log(changed.length ? `Geen unit tests bij ${changed.length} gewijzigde bestanden.` : 'Niets gewijzigd.');
  process.exit(0);
}
console.log(`${picked.length} unit tests bij ${changed.length} gewijzigde bestanden:\n  ${picked.join('\n  ')}\n`);
const r = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...picked], { stdio: 'inherit' });
process.exit(r.status ?? 1);
