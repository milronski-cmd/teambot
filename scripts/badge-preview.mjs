// Renders the desktop taskbar badge (desktop/badge.ts) to PNG files plus a preview sheet (how it looks on the
// taskbar icon and in the tray, light and dark), without starting Electron or touching the real taskbar.
//   node --import tsx scripts/badge-preview.mjs <folder>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const { renderBadgePng, withTrayDot, encodePng, badgeState } = await import('../desktop/badge.ts');

const out = process.argv[2] || 'badge-preview';
fs.mkdirSync(out, { recursive: true });
const labels = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '9+'];
for (const l of labels) for (const size of [16, 32]) fs.writeFileSync(path.join(out, `badge-${l === '9+' ? '9plus' : l}-${size}.png`), renderBadgePng(l, size));

// Tray dot on a stand-in tray icon (a dark rounded square, BGRA like nativeImage.toBitmap).
const W = 32;
const base = Buffer.alloc(W * W * 4);
for (let y = 0; y < W; y++)
  for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    if (!(x >= 2 && x < 30 && y >= 2 && y < 30)) continue; // outside: fully transparent (premultiplied zeros)
    base[o] = 0x21; base[o + 1] = 0x1b; base[o + 2] = 0x1b; base[o + 3] = 255;
  }
const dot = withTrayDot(base, W, W);
// premultiplied BGRA → straight RGBA for the PNG file
const rgba = Buffer.alloc(dot.length);
for (let i = 0; i < dot.length; i += 4) {
  const a = dot[i + 3] / 255;
  rgba[i] = a ? Math.round(dot[i + 2] / a) : 0;
  rgba[i + 1] = a ? Math.round(dot[i + 1] / a) : 0;
  rgba[i + 2] = a ? Math.round(dot[i] / a) : 0;
  rgba[i + 3] = dot[i + 3];
}
fs.writeFileSync(path.join(out, 'badge-tray-dot-32.png'), encodePng(rgba, W, W));

// Preview sheet: the real app icon with the overlay at the taskbar corner, light and dark, plus the texts.
const require = createRequire(path.resolve('package.json'));
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.log('playwright-core ontbreekt: alleen de losse PNG-bestanden geschreven');
  process.exit(0);
}
const icon = fs.readFileSync(path.resolve('build/icon.png')).toString('base64');
const b64 = (l, s) => renderBadgePng(l, s).toString('base64');
const tile = (l, theme) => `<div class="tile ${theme}"><div class="btn"><img class="app" src="data:image/png;base64,${icon}"><img class="ov" src="data:image/png;base64,${b64(l, 32)}"></div><span>${l}</span></div>`;
const html = `<html><head><style>
body{margin:0;padding:20px;font:13px "Segoe UI",system-ui;background:#fff;color:#111}
h2{font-size:14px;margin:14px 0 8px}
.row{display:flex;gap:10px;flex-wrap:wrap}
.tile{display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 12px;border-radius:8px}
.tile.dark{background:#202020;color:#ddd}.tile.light{background:#f3f3f3}
.btn{position:relative;width:48px;height:48px;display:flex;align-items:center;justify-content:center}
.app{width:32px;height:32px}.ov{position:absolute;right:4px;bottom:4px;width:16px;height:16px}
.big img{width:128px;height:128px;image-rendering:pixelated;margin-right:8px;border:1px dashed #ccc}
.texts td{padding:2px 12px 2px 0}
</style></head><body>
<h2>Taakbalk (Windows-overlay, 16 px op het pictogram), donker en licht</h2>
<div class="row">${['1', '3', '9', '9+'].map((l) => tile(l, 'dark')).join('')}${['1', '3', '9', '9+'].map((l) => tile(l, 'light')).join('')}</div>
<h2>Vergroot (32 px-bestand, pixel voor pixel) en het systeemvak-pictogram met stip</h2>
<div class="big">${['1', '4', '8', '9+'].map((l) => `<img src="data:image/png;base64,${b64(l, 32)}">`).join('')}<img src="data:image/png;base64,${encodePng(rgba, W, W).toString('base64')}"></div>
${(() => {
  // Written by tests/e2e/badge-check.mjs from real Electron images (hidden window): show them when present.
  const real = ['badge-electron-overlay-16.png', 'badge-electron-overlay-32.png', 'badge-electron-tray-16.png', 'badge-electron-tray-32.png'].filter((f) => fs.existsSync(path.join(out, f)));
  if (!real.length) return '';
  return `<h2>Uit Electron zelf (overlay en systeemvak, 16 en 32 px, vergroot)</h2><div class="big">${real.map((f) => `<img title="${f}" src="data:image/png;base64,${fs.readFileSync(path.join(out, f)).toString('base64')}">`).join('')}</div>`;
})()}
<h2>Tekst voor schermlezers en de tooltip</h2>
<table class="texts">${[{ waiting: 3, unread: 0 }, { waiting: 1, unread: 0 }, { waiting: 2, unread: 1 }, { waiting: 0, unread: 4 }, { waiting: 0, unread: 0 }]
  .map((c) => `<tr><td>wacht ${c.waiting}, ongelezen ${c.unread}</td><td><b>${badgeState(c).text || '(geen badge)'}</b></td><td>badge: ${badgeState(c).label || '—'}</td></tr>`)
  .join('')}</table>
</body></html>`;
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 520 } });
await page.setContent(html);
await page.screenshot({ path: path.join(out, 'badge-preview.png'), fullPage: true });
await browser.close();
console.log('geschreven naar', out);
