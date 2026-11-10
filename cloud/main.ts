import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createCloud } from './server.js';
import { loadCloudConfig, ROOT } from './config.js';
import { migrate, openDb } from './db.js';
import { Accounts } from './accounts.js';
import { makeLog, systemClock } from './util.js';

/**
 * TeamBot Cloud: control plane + router for the managed cloud (docs/CLOUD.md).
 *   npm run cloud:dev                      start locally (PGlite + process provisioner)
 *   npm run cloud:operator -- you@x.nl     give an existing account the operator role (run while the cloud is stopped
 *                                          when using PGlite; with Postgres it can run any time)
 */
const [cmd, arg] = process.argv.slice(2);

if (cmd === 'operator' || cmd === 'user') {
  if (!arg) {
    console.error('Gebruik: npm run cloud:operator -- <e-mailadres>');
    process.exit(2);
  }
  const cfg = loadCloudConfig();
  const db = await openDb(cfg.databaseUrl, path.join(cfg.dataDir, 'pglite'));
  await migrate(db);
  const accounts = new Accounts({ db, cfg, clock: systemClock, log: makeLog(false) });
  const ok = await accounts.setRole(arg, cmd === 'operator' ? 'operator' : 'user');
  await db.close();
  console.log(ok ? `${arg} is nu ${cmd === 'operator' ? 'beheerder' : 'gewone gebruiker'}.` : `Geen account gevonden voor ${arg}. Maak het eerst aan via de website.`);
  process.exit(ok ? 0 : 1);
}

const pre = loadCloudConfig();
if (pre.provisioner === 'process' && !fs.existsSync(pre.process.entry) && process.env.NODE_ENV !== 'production') {
  // Development: the process provisioner runs the built TeamBot server; build it once.
  console.log('TeamBot-server is nog niet gebouwd; bouwen met "npm run build"…');
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
}

const cloud = await createCloud();
const c = cloud.cfg;
console.log(`
  TeamBot Cloud draait.
  Dashboard: ${c.url}   (luistert op ${cloud.listenUrl})
  Workspaces: ${c.scheme}://<naam>.${c.domain}${c.portSuffix}
  Database: ${c.databaseUrl ? 'Postgres' : 'PGlite (alleen voor ontwikkeling)'} · Instanties: ${c.provisioner} · Betalen: ${cloud.billing.mode === 'stripe' ? 'Stripe' : 'handmatig'}
`);

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  console.log('TeamBot Cloud stopt…');
  await cloud.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
