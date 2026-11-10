// node scripts/make-ico.mjs — build/icon.png (512 px) → build/icon.ico (16 … 256 px, PNG-compressed), with the same
// converter electron-builder uses for the app icon. The one-click installer shows this icon next to "Installeren, even
// geduld…" (package.json build.nsis.installerHeaderIcon; NSIS needs an .ico there). `npm run icons` runs it after
// make-icons.mjs, so the two never drift apart. Checked by tests/installer-config.test.ts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const repo = process.cwd();
const require = createRequire(path.join(repo, 'package.json'));
const { convertIcon } = require('app-builder-lib/out/util/iconConverter');

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'teambot-ico-'));
try {
  const r = await convertIcon({ sources: ['icon.png'], fallbackSources: [], roots: [path.join(repo, 'build')], format: 'ico', outDir: out });
  if (r.isFallback || !r.icons?.[0]?.file) throw new Error('build/icon.png kon niet worden omgezet');
  fs.copyFileSync(r.icons[0].file, path.join(repo, 'build', 'icon.ico'));
  console.log('written build/icon.ico');
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
