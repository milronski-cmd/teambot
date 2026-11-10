// Bundles the server (and the Electron shell) with esbuild. Dependencies stay external
// (they are installed in node_modules / packaged by electron-builder).
import { build } from 'esbuild';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const external = [...Object.keys(pkg.dependencies || {}), 'electron', '@anthropic-ai/sdk'];
const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
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
