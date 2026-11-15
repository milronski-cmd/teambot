// npm run e2e [-- <naam> …]  — the browser checks (tests/e2e/<naam>.mjs), several at the same time.
// Every check starts its own TeamBot on a free port with its own temporary folder, so they can run side by side.
// Without names: all of them (the list below). With names: only those (`npm run e2e -- layout shared-bot`).
// A check that fails while others run is tried once more on its own (a busy machine makes some checks slow), so a
// red line is a real failure. Parallel: E2E_JOBS (default: a quarter of the processor cores, at least 2, at most 6).
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const ALL = [
  'smoke', 'extensions-ui', 'c2-chat', 'c2-proposals-restart', 'c2-routines-memory', 'c2-security-phone', 'files-chat',
  'language-switch', 'c4-core', 'c4-groups', 'c4-models-cli-review', 'shared-bot', 'history-pages', 'newcomer', 'layout',
  'phone-owner', 'accent', 'web-notes', 'skill-pin-updates', 'market-clear', 'chat-folders', 'hermes-import',
  'iroh-pairing', 'own-rules', 'backups-offsite', 'openbot-cutover', 'app-update', 'dialogs-math',
];
const asked = process.argv.slice(2).map((n) => n.replace(/^tests\/e2e\//, '').replace(/\.mjs$/, ''));
const unknown = asked.filter((n) => !fs.existsSync(path.join('tests/e2e', `${n}.mjs`)));
if (unknown.length) {
  console.error(`✖ Onbekende check: ${unknown.join(', ')} (bestanden staan in tests/e2e)`);
  process.exit(1);
}
const list = asked.length ? asked : ALL;
const jobs = Math.max(1, Math.min(list.length, Number(process.env.E2E_JOBS) || Math.min(6, Math.max(2, Math.floor(os.availableParallelism() / 4)))));
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-e2e-logs-'));

function run(name) {
  const t0 = Date.now();
  const log = path.join(logDir, `${name}.log`);
  const out = fs.openSync(log, 'w');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', `tests/e2e/${name}.mjs`], { stdio: ['ignore', out, out], env: process.env });
    child.on('close', (code) => {
      fs.closeSync(out);
      resolve({ name, ok: code === 0, s: Math.round((Date.now() - t0) / 1000), log });
    });
  });
}

const started = Date.now();
const queue = [...list];
const done = [];
await Promise.all(
  Array.from({ length: jobs }, async () => {
    for (let name; (name = queue.shift()); ) {
      const r = await run(name);
      done.push(r);
      console.log(`${r.ok ? '✔' : '…'} ${r.name} (${r.s} s)${r.ok ? '' : ' — mislukt naast andere checks, straks nog eens alleen'}`);
    }
  }),
);
// Failed while others ran: once more on its own.
const failed = [];
for (const r of done.filter((x) => !x.ok)) {
  const again = await run(r.name);
  console.log(`${again.ok ? '✔' : '✖'} ${r.name} alleen (${again.s} s)`);
  if (!again.ok) failed.push(again);
}
const min = ((Date.now() - started) / 60_000).toFixed(1);
if (failed.length) {
  for (const f of failed) {
    const lines = fs.readFileSync(f.log, 'utf8').split('\n').filter((l) => /✖|✗|MISLUKT|Error|Timeout/.test(l));
    console.log(`\n✖ ${f.name}:\n  ${lines.slice(0, 8).join('\n  ')}\n  (volledige uitvoer: ${f.log})`);
  }
  console.log(`\n${list.length - failed.length} van ${list.length} geslaagd in ${min} min (${jobs} tegelijk)`);
  process.exit(1);
}
fs.rmSync(logDir, { recursive: true, force: true });
console.log(`\nAlle ${list.length} geslaagd in ${min} min (${jobs} tegelijk)`);
