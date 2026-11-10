// Generates the PWA and iOS app icons from ui/public/icon.svg.
// Usage (from the repo root): node mobile/ios/tools/gen-icons.mjs [path-to-chromium-or-edge]
// Renders with a local Chromium/Edge (headless, via playwright-core) and encodes PNGs with node:zlib.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { chromium } from 'playwright-core';

const root = process.cwd();
const svg = fs.readFileSync(path.join(root, 'ui/public/icon.svg'), 'utf8');
const exe =
  process.argv[2] ||
  ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
if (!exe) throw new Error('Geen Chromium/Edge gevonden; geef het pad als argument');

const BG = '#4f46e5';
const targets = [
  { file: 'ui/public/icon-192.png', size: 192, mode: 'any' },
  { file: 'ui/public/icon-512.png', size: 512, mode: 'any' },
  { file: 'ui/public/apple-touch-icon.png', size: 180, mode: 'full', opaque: true },
  { file: 'ui/public/icon-maskable-512.png', size: 512, mode: 'maskable', opaque: true },
  { file: 'mobile/ios/TeamBot/Resources/Assets.xcassets/AppIcon.appiconset/icon-1024.png', size: 1024, mode: 'full', opaque: true },
];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(rgba, size, opaque) {
  const ch = opaque ? 3 : 4;
  const raw = Buffer.alloc((size * ch + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * ch + 1)] = 0;
    for (let x = 0; x < size; x++) for (let c = 0; c < ch; c++) raw[y * (size * ch + 1) + 1 + x * ch + c] = rgba[(y * size + x) * 4 + c];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = opaque ? 2 : 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const browser = await chromium.launch({ executablePath: exe, headless: true });
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><canvas id="c"></canvas>');
  for (const t of targets) {
    const b64 = await page.evaluate(
      async ({ svg, size, mode, bg }) => {
        const img = new Image();
        img.src = 'data:image/svg+xml;base64,' + btoa(svg);
        await img.decode();
        const c = document.getElementById('c');
        c.width = c.height = size;
        const g = c.getContext('2d');
        g.clearRect(0, 0, size, size);
        if (mode !== 'any') {
          g.fillStyle = bg;
          g.fillRect(0, 0, size, size);
        }
        const s = mode === 'maskable' ? size * 0.8 : size;
        g.drawImage(img, (size - s) / 2, (size - s) / 2, s, s);
        const d = g.getImageData(0, 0, size, size).data;
        let bin = '';
        for (let i = 0; i < d.length; i += 0x8000) bin += String.fromCharCode.apply(null, d.subarray(i, i + 0x8000));
        return btoa(bin);
      },
      { svg, size: t.size, mode: t.mode, bg: BG },
    );
    const out = path.join(root, t.file);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, png(Buffer.from(b64, 'base64'), t.size, !!t.opaque));
    console.log('geschreven:', t.file);
  }
} finally {
  await browser.close();
}
