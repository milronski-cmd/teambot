import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dominantColor, hexRgb, recolorBitmap, type Rgb } from '../desktop/accent-icon.js';
import { readShellState, writeShellState } from '../desktop/shell-state.js';
import { ACCENTS, STANDARD_LOGO, accentById } from '../shared/accent.js';

/** Window, taskbar and tray icon in the accent colour: the figure's body colour moves, the rest stays. */

const A = hexRgb(STANDARD_LOGO);
const mix = (c: Rgb, to: 'w' | 'b', t: number): Rgb => c.map((v) => Math.round(to === 'w' ? v + (255 - v) * t : v * (1 - t))) as Rgb;
/** BGRA premultiplied bitmap from [rgb, alpha] pixels. */
const bitmap = (px: [Rgb, number][]) => Buffer.from(px.flatMap(([[r, g, b], a]) => [Math.round((b * a) / 255), Math.round((g * a) / 255), Math.round((r * a) / 255), a]));
const pixel = (buf: Buffer, i: number): [Rgb, number] => [[buf[i * 4 + 2], buf[i * 4 + 1], buf[i * 4]], buf[i * 4 + 3]];
const near = (a: Rgb, b: Rgb, tol = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

test('recolour: the body and its tints and shades take the new colour; background, eyes, white and transparent stay', () => {
  const B = hexRgb(accentById('cobalt').logo);
  const src = bitmap([
    [A, 255], // body
    [mix(A, 'w', 0.42), 255], // light part of the gradient
    [mix(A, 'b', 0.28), 255], // dark part
    [mix(A, 'b', 0.45), 255], // edge
    [[27, 27, 33], 255], // background (#1b1b21)
    [[11, 11, 14], 255], // background (#0b0b0e)
    [[255, 255, 255], 255], // highlight
    [[29, 27, 34], 255], // eyes
    [A, 128], // half-transparent body (antialiased edge)
    [[0, 0, 0], 0], // transparent
  ]);
  const out = recolorBitmap(src, STANDARD_LOGO, accentById('cobalt').logo);
  assert.ok(near(pixel(out, 0)[0], B), `body ${pixel(out, 0)[0]} ≈ ${B}`);
  assert.ok(near(pixel(out, 1)[0], mix(B, 'w', 0.42)), 'light tint');
  assert.ok(near(pixel(out, 2)[0], mix(B, 'b', 0.28)), 'dark shade');
  assert.ok(near(pixel(out, 3)[0], mix(B, 'b', 0.45)), 'edge');
  for (const i of [4, 5, 6, 7, 9]) assert.deepEqual(pixel(out, i), pixel(src, i), `pixel ${i} unchanged`);
  const half = pixel(out, 8);
  assert.equal(half[1], 128);
  assert.ok(near(half[0], B.map((v) => Math.round((v * 128) / 255)) as Rgb), 'premultiplied alpha handled');
  // the standard accent: an exact copy (not the same buffer)
  const same = recolorBitmap(src, STANDARD_LOGO, STANDARD_LOGO);
  assert.notEqual(same, src);
  assert.deepEqual(same, src);
  assert.throws(() => recolorBitmap(src, 'oranje', '#000000'), /Geen kleur/);
});

test('every accent: the figure in the icon gets (close to) that accent’s logo colour', () => {
  const body = bitmap(Array.from({ length: 50 }, (_, i) => [i % 2 ? A : mix(A, 'w', 0.3), 255] as [Rgb, number]).concat(Array.from({ length: 50 }, () => [[20, 20, 25], 255] as [Rgb, number])));
  for (const a of ACCENTS) {
    const out = recolorBitmap(body, STANDARD_LOGO, a.logo);
    const want = hexRgb(a.logo);
    const got = pixel(out, 1)[0];
    assert.ok(near(got, want), `${a.id}: ${got} ≈ ${want}`);
    if (a.id !== 'standard') assert.ok(dominantColor(out), `${a.id}: still a coloured figure`);
  }
  assert.ok(near(dominantColor(bitmap([[A, 255]]))!, A));
  assert.equal(dominantColor(bitmap([[[20, 20, 25], 255]])), null);
});

test('shell state remembers the accent for the next start (before the server is up)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-accent-shell-'));
  try {
    writeShellState(dir, { lang: 'nl' });
    writeShellState(dir, { accent: 'cobalt' });
    assert.deepEqual(readShellState(dir), { lang: 'nl', accent: 'cobalt' });
    fs.writeFileSync(path.join(dir, 'shell.json'), JSON.stringify({ accent: '<script>' }));
    assert.equal(readShellState(dir).accent, undefined, 'only an id-like value is read back');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
