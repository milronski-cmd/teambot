// Bundles the server (and the Electron shell) with esbuild. Dependencies stay external
// (they are installed in node_modules / packaged by electron-builder).
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const external = [...Object.keys(pkg.dependencies || {}), 'electron', '@anthropic-ai/sdk'];

/**
 * TeamBot's own login apps (server/modules/mcp/teambot-apps.ts), never in the source: TEAMBOT_<NAME>_CLIENT_FILE (the
 * downloaded JSON, or {client_id, client_secret}) or TEAMBOT_<NAME>_CLIENT_ID and _SECRET.
 */
const APP_ID = { google: /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/, github: /^(Ov23|Iv1\.)[A-Za-z0-9]{8,}$/ };
function teambotApps() {
  const apps = {};
  for (const [name, idPattern] of Object.entries(APP_ID)) {
    const env = `TEAMBOT_${name.toUpperCase()}_CLIENT`;
    let clientId = process.env[`${env}_ID`] || '';
    let clientSecret = process.env[`${env}_SECRET`] || '';
    // Without a variable: the publisher's own copy on this computer, outside the source (%APPDATA%TeamBot-build-keys).
    // 24 Nov 2026: a build without them shipped without Google and GitHub, and every existing login stopped working.
    const keep = process.env.APPDATA ? path.join(process.env.APPDATA, 'TeamBot-build-keys', `${name}-client.json`) : '';
    const file = process.env[`${env}_FILE`] || (!clientId && keep && fs.existsSync(keep) ? keep : '');
    if (file) {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      const c = j.installed || j.web || j;
      clientId = c.client_id || clientId;
      clientSecret = c.client_secret || clientSecret;
    }
    if (clientId && !idPattern.test(clientId)) throw new Error(`${env}: geen geldige client-ID voor ${name}`);
    if (clientId) apps[name] = { clientId, clientSecret };
    console.log(`Inloggen met ${name}: ${clientId ? 'TeamBot-app ingebouwd' : 'geen TeamBot-app (gebruikers maken zelf een app)'}`);
  }
  return apps;
}
const apps = teambotApps();

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
  define: { __TEAMBOT_APPS__: JSON.stringify(apps) },
};
await build({ ...common, entryPoints: ['server/main.ts'], outfile: 'dist/server/main.js' });
// Dictionaries for texts the server translates itself (phone pushes, desktop notifications, chat apps): server/core/i18n.ts.
fs.mkdirSync('dist/i18n', { recursive: true });
for (const f of fs.readdirSync('ui/src/i18n')) if (f.endsWith('.json')) fs.copyFileSync(`ui/src/i18n/${f}`, `dist/i18n/${f}`);
// "Wat is er nieuw" after an update (server/modules/backups/changelog.ts reads dist/CHANGELOG.md).
fs.copyFileSync('CHANGELOG.md', 'dist/CHANGELOG.md');
if (fs.existsSync('desktop/main.ts')) {
  // The app starts in the small boot file (it catches a start that fails); the shell itself is loaded by it.
  await build({ ...common, entryPoints: ['desktop/boot.ts'], outfile: 'dist/desktop/main.js' });
  await build({ ...common, entryPoints: ['desktop/main.ts'], outfile: 'dist/desktop/shell.js' });
  await build({ ...common, format: 'cjs', banner: undefined, entryPoints: ['desktop/preload.ts'], outfile: 'dist/desktop/preload.cjs' });
  await build({ ...common, format: 'cjs', banner: undefined, entryPoints: ['desktop/dictation-preload.ts'], outfile: 'dist/desktop/dictation-preload.cjs' });
}
