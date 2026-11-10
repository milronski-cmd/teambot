// Builds the bundled models.dev snapshot (server/providers/models-dev-snapshot.json): context windows, prices and
// capabilities for the providers TeamBot connects to, trimmed with the same code the daily refresh uses.
// models.dev data is MIT (third_party/models.dev/LICENSE).
// Usage: npm run models:snapshot                      (downloads https://models.dev/api.json)
//        npm run models:snapshot -- --from api.json   (an api.json you downloaded yourself)
//        npm run models:snapshot -- --date 2026-11-09 (the day the data was read; default today)
import fs from 'node:fs';
import { MODELS_DEV_URL, trimCatalog } from '../server/providers/models-dev.ts';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const from = arg('--from');
const date = arg('--date') || new Date().toISOString().slice(0, 10);
const text = from ? fs.readFileSync(from, 'utf8') : await (await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(120_000) })).text();
const c = trimCatalog(JSON.parse(text), date);
const out = 'server/providers/models-dev-snapshot.json';
fs.writeFileSync(out, JSON.stringify(c) + '\n');
const n = Object.values(c.providers).reduce((s, p) => s + Object.keys(p).length, 0);
console.log(`${out}: ${Object.keys(c.providers).length} providers, ${n} modellen, stand ${c.fetched} (${Math.round(fs.statSync(out).size / 1024)} KB).`);
