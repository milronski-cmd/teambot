// node --import tsx scripts/make-logo.mjs — writes TeamBot's logo (shared/logo.ts) to every icon file: ui/public
// (svg, 192, 512, maskable, apple-touch) and build/icon.png; then run `node scripts/make-ico.mjs` for build/icon.ico.
// Replaces the robot icon of scripts/make-icons.mjs since 4.18.12.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { logoSvg } from '../shared/logo.ts';

const repo = process.cwd();
const require = createRequire(path.join(repo, 'package.json'));
const { chromium } = require('playwright-core');
const pub = path.join(repo, 'ui/public');

const b = await chromium.launch({ channel: 'msedge', headless: true });
const p = await b.newPage({ viewport: { width: 512, height: 512 } });
async function png(svg, size, file) {
  await p.setViewportSize({ width: size, height: size });
  await p.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await p.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
const rounded = logoSvg();
const full = logoSvg({ round: 0 });
const maskable = logoSvg({ round: 0, pad: 0.12 });
fs.writeFileSync(path.join(pub, 'icon.svg'), rounded);
await png(rounded, 192, path.join(pub, 'icon-192.png'));
await png(rounded, 512, path.join(pub, 'icon-512.png'));
await png(maskable, 512, path.join(pub, 'icon-maskable-512.png'));
await png(full, 180, path.join(pub, 'apple-touch-icon.png'));
await png(rounded, 512, path.join(repo, 'build/icon.png'));
await b.close();
console.log('logo written');
