// npm run accept:04 — runs both acceptance suites of 0.4 one after the other (also the second when the first fails)
// and exits 1 when one of them failed. Needs the built UI: npm run build:ui first. See docs/ACCEPTANCE_0.4.md.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const failed = [];
for (const suite of ['accept-04-core.mjs', 'accept-04-data.mjs']) {
  console.log(`\n======== ${suite}`);
  const r = spawnSync(process.execPath, ['--import', 'tsx', path.join(here, suite)], { stdio: 'inherit' });
  if (r.status !== 0) failed.push(suite);
}
console.log(failed.length ? `\nACCEPTATIE 0.4: mislukt in ${failed.join(', ')} (zie de regels met ✖ en docs/ACCEPTANCE_0.4.md)` : '\nACCEPTATIE 0.4: alles geslaagd');
process.exit(failed.length ? 1 : 0);
