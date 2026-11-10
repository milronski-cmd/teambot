// npm run website:images — renders the social preview images (og-nl.png, og-en.png, 1200×630) and the
// apple-touch-icon (180×180) into website/src/img with Edge/Chrome via playwright-core. Hard timeout: 90 s.
// The results are committed, so a normal website build never needs a browser.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const killer = setTimeout(() => {
  console.error('website:images: time-out na 90 s');
  process.exit(2);
}, 90_000);
killer.unref();

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const require = createRequire(path.join(repo, 'package.json'));
const { chromium } = require('playwright-core');
const { iconSvg, faceSvg } = await import('./build.mjs');
const out = path.join(here, 'src/img');
fs.mkdirSync(out, { recursive: true });
const fontDir = path.dirname(require.resolve('@fontsource-variable/figtree/package.json'));
const font = fs.readFileSync(path.join(fontDir, 'files/figtree-latin-wght-normal.woff2')).toString('base64');

// Same words as the first screen of the site (home.title in nl.json / en.json).
const TEXT = {
  nl: { title: 'Je eigen team van <span class="nw">AI-bots</span>, op je eigen pc', sub: 'Gratis en open source · met de AI die je al hebt' },
  en: { title: 'Your own team of AI&nbsp;bots, on your own PC', sub: 'Free and open source · with the AI you already have' },
};
const faces = [
  ['og1', { shape: 'egg', color: 'sky', eyes: 'look', mouth: 'smile', extra: 'sprout', cheeks: false }, 'working', 150, 40, 210],
  ['og2', { shape: 'ghost', color: 'violet', eyes: 'bean', mouth: 'cat', extra: 'ears', cheeks: true }, 'waiting', 150, 360, 260],
  ['og3', { shape: 'squircle', color: 'tangerine', eyes: 'bean', mouth: 'smile', extra: 'antenna', cheeks: true }, 'idle', 250, 150, 300],
  ['og4', { shape: 'bell', color: 'mint', eyes: 'dot', mouth: 'smile', extra: 'none', cheeks: true }, 'done', 130, 60, 440],
  ['og5', { shape: 'pill', color: 'sun', eyes: 'visor', mouth: 'flat', extra: 'antenna', cheeks: false }, 'idle', 120, 380, 440],
];
function ogHtml(L) {
  const figs = faces
    .map(([seed, traits, mood, size, x, y]) => `<div style="position:absolute;left:${x}px;top:${y - size / 2}px;width:${size}px;height:${size}px">${faceSvg(seed, traits, mood)}</div>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:F;src:url(data:font/woff2;base64,${font}) format("woff2");font-weight:300 900}
html,body{margin:0;width:1200px;height:630px;overflow:hidden}
body{background:radial-gradient(60% 80% at 75% 45%,#2a1a10 0%,#121216 55%,#0b0b0e 100%);color:#ededf2;font-family:F,sans-serif}
svg{width:100%;height:100%;overflow:visible}
.l{position:absolute;left:72px;top:0;bottom:0;width:640px;display:flex;flex-direction:column;justify-content:center}
.b{display:flex;align-items:center;gap:16px;font-size:40px;font-weight:800;letter-spacing:-.02em;margin-bottom:36px}
.b span{width:64px;height:64px;display:block}
h1{font-size:66px;line-height:1.04;font-weight:800;letter-spacing:-.035em;margin:0 0 28px}
.nw{white-space:nowrap}
p{font-size:28px;line-height:1.35;color:#b4b4c0;margin:0;font-weight:550}
.r{position:absolute;right:20px;top:0;width:520px;height:630px}
</style></head><body><div class="l"><div class="b"><span>${iconSvg(230, 0.12)}</span>TeamBot</div><h1>${TEXT[L].title}</h1><p>${TEXT[L].sub}</p></div><div class="r">${figs}</div></body></html>`;
}

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  for (const L of ['nl', 'en']) {
    await page.setContent(ogHtml(L));
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(out, `og-${L}.png`) });
  }
  await page.setViewportSize({ width: 180, height: 180 });
  await page.setContent(`<html><body style="margin:0">${iconSvg(0).replace('<svg ', '<svg width="180" height="180" ')}</body></html>`);
  await page.screenshot({ path: path.join(out, 'apple-touch-icon.png'), clip: { x: 0, y: 0, width: 180, height: 180 } });
  console.log('website:images: og-nl.png, og-en.png, apple-touch-icon.png →', path.relative(repo, out));
} finally {
  await browser.close();
}
