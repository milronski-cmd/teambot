/**
 * The app icon in the owner's accent colour (Instellingen › Uiterlijk › Kleur, `settings.ui.accent`): window, taskbar
 * and tray show the TeamBot figure in the accent's logo colour (ui/src/shell/accent.ts `logo`), the same figure the
 * sidebar draws. Pure (no Electron), so tests/desktop-accent-icon.test.ts checks it on plain bitmaps.
 *
 * How: the icon is the figure rendered from one body colour A (tangerine, STANDARD_LOGO) with white highlights, black
 * shading and a dark, almost neutral background. Every pixel is projected on the plane of A and white
 * (p ≈ s·A + w·White + rest); its A-share s is moved to the new colour B (p + s·(B − A)). The body, its light and dark
 * tints, the antenna and the cheeks (pink over the body) follow; neutral pixels (background, eyes, highlights) have
 * s ≈ 0 and stay as they are. Linear, so it works on premultiplied alpha as Electron's `toBitmap` gives it (BGRA).
 */

export type Rgb = [number, number, number];

export function hexRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) throw new Error(`Geen kleur: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** A recoloured copy of a BGRA bitmap (premultiplied alpha): the share of `from` in every pixel becomes `to`. */
export function recolorBitmap(bgra: Buffer, from: string, to: string): Buffer {
  const a = hexRgb(from);
  const b = hexRgb(to);
  const out = Buffer.from(bgra);
  if (a.every((v, i) => v === b[i])) return out;
  // normal equations of p = s·A + w·W with W = (255, 255, 255)
  const aa = a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
  const aw = 255 * (a[0] + a[1] + a[2]);
  const ww = 3 * 255 * 255;
  const det = aa * ww - aw * aw;
  if (!det) return out;
  const d: Rgb = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  for (let i = 0; i + 3 < out.length; i += 4) {
    const alpha = out[i + 3];
    if (!alpha) continue;
    const r = out[i + 2];
    const g = out[i + 1];
    const bl = out[i];
    const ap = a[0] * r + a[1] * g + a[2] * bl;
    const wp = 255 * (r + g + bl);
    let s = (ww * ap - aw * wp) / det;
    if (s <= 0.004) continue;
    s = Math.min(s, alpha / 255);
    const max = alpha;
    out[i + 2] = clamp(Math.round(r + s * d[0]), max);
    out[i + 1] = clamp(Math.round(g + s * d[1]), max);
    out[i] = clamp(Math.round(bl + s * d[2]), max);
  }
  return out;
}

const clamp = (v: number, max: number) => (v < 0 ? 0 : v > max ? max : v);

/** The average colour of the strongly coloured pixels (for checks: "is the figure blue now?"). */
export function dominantColor(bgra: Buffer): Rgb | null {
  let n = 0;
  const sum: Rgb = [0, 0, 0];
  for (let i = 0; i + 3 < bgra.length; i += 4) {
    const alpha = bgra[i + 3];
    if (alpha < 200) continue;
    const r = bgra[i + 2];
    const g = bgra[i + 1];
    const b = bgra[i];
    const hi = Math.max(r, g, b);
    const lo = Math.min(r, g, b);
    if (hi < 90 || hi - lo < 60) continue;
    sum[0] += r;
    sum[1] += g;
    sum[2] += b;
    n++;
  }
  return n ? [Math.round(sum[0] / n), Math.round(sum[1] / n), Math.round(sum[2] / n)] : null;
}
