// npm run icons — renders the TeamBot app icon (all sizes) from the in-app face generator (shared/botface.ts).
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
const repo = process.cwd();
const require = createRequire(path.join(repo, 'package.json'));
const { chromium } = require('playwright-core');
const { botSvg } = await import(new URL('file:///' + path.join(repo, 'shared/botface.ts').split(path.sep).join('/')).href);
const { appIconSvg } = await import(new URL('file:///' + path.join(repo, 'shared/appicon.ts').split(path.sep).join('/')).href);
const out = process.argv[2] || '.';
const inner = (seed, traits, uid) => botSvg(seed, { traits, uid }).replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
// The icon: the figure on TeamBot's background (shared/appicon.ts, one recipe with the website's favicon).
// pad = share of the canvas left around the figure; round = corner radius (0: full bleed).
const icon = (traits, { pad, round = 0, id = 'tb' } = {}) => appIconSvg(inner('TeamBot', traits, id), { pad, round, id });
const variants = {
  a: { shape: 'squircle', color: 'tangerine', eyes: 'bean', mouth: 'smile', extra: 'antenna', cheeks: true },
  b: { shape: 'squircle', color: 'mint', eyes: 'bean', mouth: 'smile', extra: 'antenna', cheeks: true },
  c: { shape: 'squircle', color: 'sun', eyes: 'bean', mouth: 'smile', extra: 'antenna', cheeks: true },
  d: { shape: 'squircle', color: 'coral', eyes: 'bean', mouth: 'smile', extra: 'antenna', cheeks: true },
  e: { shape: 'pill', color: 'tangerine', eyes: 'happy', mouth: 'smile', extra: 'sprout', cheeks: true },
  f: { shape: 'bun', color: 'tangerine', eyes: 'visor', mouth: 'none', extra: 'antenna', cheeks: false },
  g: { shape: 'cloud', color: 'tangerine', eyes: 'look', mouth: 'cat', extra: 'none', cheeks: true },
  h: { shape: 'egg', color: 'tangerine', eyes: 'bean', mouth: 'o', extra: 'ears', cheeks: true },
  i: { shape: 'bell', color: 'tangerine', eyes: 'dot', mouth: 'smile', extra: 'crown', cheeks: true },
  j: { shape: 'flower', color: 'tangerine', eyes: 'happy', mouth: 'smile', extra: 'none', cheeks: true },
};
const pick = process.argv[3] ?? 'a';
const b = await chromium.launch({ channel: 'msedge', headless: true });
const p = await b.newPage({ viewport: { width: 1024, height: 1024 } });
async function png(svg, size, file) {
  await p.setViewportSize({ width: size, height: size });
  await p.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await p.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
if (!pick || pick === 'sheet') {
  // contact sheet: each variant at home-screen size (60px, 120px) and large
  let html = '<html><body style="margin:0;padding:24px;background:#f2f2f5;font:14px system-ui;display:flex;gap:28px;flex-wrap:wrap">';
  for (const [k, t] of Object.entries(variants)) {
    const svg = icon(t, { round: 230, id: 'v' + k });
    html += `<div style="display:flex;flex-direction:column;gap:10px;align-items:center"><b>${k}</b><div style="width:180px;height:180px">${svg}</div><div style="display:flex;gap:10px;align-items:end"><div style="width:60px;height:60px">${svg}</div><div style="width:40px;height:40px">${svg}</div></div></div>`;
  }
  html += '</body></html>';
  await p.setViewportSize({ width: 2100, height: 330 });
  await p.setContent(html); await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(out, 'sheet.png') });
} else {
  const t = variants[pick];
  const pub = path.join(repo, 'ui/public');
  const full = icon(t);                         // square, full bleed (iOS/Android round it themselves)
  const rounded = icon(t, { round: 230 });       // favicon / svg icon / desktop
  const maskable = icon(t, { pad: 0.24 });       // keeps the figure inside the maskable safe zone
  fs.writeFileSync(path.join(pub, 'icon.svg'), rounded);
  await png(rounded, 192, path.join(pub, 'icon-192.png'));
  await png(rounded, 512, path.join(pub, 'icon-512.png'));
  await png(maskable, 512, path.join(pub, 'icon-maskable-512.png'));
  await png(full, 180, path.join(pub, 'apple-touch-icon.png'));
  await png(rounded, 512, path.join(repo, 'build/icon.png'));
  console.log('written', pick);
}
await b.close();
