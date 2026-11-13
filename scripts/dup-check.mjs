// Guard against code growing back double or dead (duplication audit, 12 nov 2026). Usage: npm run dup:check
//
//  1. knip in production mode (config: knip.json): a file or an export that nothing in the product uses fails the check,
//     unless it is in scripts/dup-baseline.json — the list of things only tests use (test hooks such as
//     setOcrForTests). knip is not a dependency of TeamBot: it is fetched with `npx --yes` when this runs.
//  2. tests/dup-guard.test.ts: no tool name registered twice, and a bot on "Volledige toegang" gets no more tools
//     than the number written there.
//
// `node scripts/dup-check.mjs --update` rewrites the baseline: only after you checked that every new entry really is
// used by a test or a script (otherwise remove the code instead).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = path.join(root, 'scripts', 'dup-baseline.json');
const update = process.argv.includes('--update');
const KNIP = 'knip@5';

const run = (cmd, args) => spawnSync(cmd, args, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 });

const k = run('npx', ['--yes', KNIP, '--production', '--no-exit-code', '--reporter', 'json']);
let report;
try {
  report = JSON.parse(k.stdout.slice(k.stdout.indexOf('{')));
} catch {
  console.error('dup:check: knip gaf geen leesbaar resultaat (is er internet voor `npx --yes knip`?).');
  console.error((k.stderr || k.stdout || '').slice(0, 2000));
  process.exit(2);
}

const found = new Set();
for (const f of report.files || []) found.add(`file ${f}`);
for (const i of report.issues || []) {
  for (const e of i.exports || []) found.add(`export ${i.file}:${e.name}`);
  for (const e of i.types || []) found.add(`type ${i.file}:${e.name}`);
  for (const d of i.duplicates || []) found.add(`duplicate ${i.file}:${d.map((x) => x.name).join('=')}`);
}
const sorted = [...found].sort();

if (update) {
  fs.writeFileSync(baselinePath, JSON.stringify({ note: 'Only used by tests or scripts (not by the product). See scripts/dup-check.mjs.', allowed: sorted }, null, 1) + '\n');
  console.log(`dup:check: baseline bijgewerkt (${sorted.length} regels).`);
  process.exit(0);
}

const allowed = new Set(JSON.parse(fs.readFileSync(baselinePath, 'utf8')).allowed);
const fresh = sorted.filter((x) => !allowed.has(x));
const gone = [...allowed].filter((x) => !found.has(x));
if (gone.length) console.log(`dup:check: ${gone.length} regel(s) in scripts/dup-baseline.json bestaan niet meer; haal ze weg met --update:\n  ${gone.join('\n  ')}`);
if (fresh.length) {
  console.error(`dup:check: ${fresh.length} ongebruikt(e) bestand(en) of export(s). Haal ze weg, of gebruik ze:\n  ${fresh.join('\n  ')}`);
  console.error('Wordt het alleen door een test gebruikt? Controleer dat, en draai dan: node scripts/dup-check.mjs --update');
  process.exit(1);
}
console.log(`dup:check: geen ongebruikte bestanden of exports (${allowed.size} bekende uitzonderingen voor tests).`);

const t = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'tests/dup-guard.test.ts'], { cwd: root, stdio: 'inherit' });
process.exit(t.status ?? 1);
