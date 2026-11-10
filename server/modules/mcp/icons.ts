/**
 * App icons from the MCP Registry, served by TeamBot itself: the viewer's browser never contacts the publisher's
 * website (that would reveal the viewer's IP address and that they browse the marketplace). The server fetches the
 * icon URL from the registry record through the marketplace downloader (SSRF check on every redirect hop, byte cap,
 * time-out), caches it on disk, and only passes on what is really a small PNG, JPEG or WebP image. Anything else
 * gets a neutral fallback icon.
 */

export const ICON_MAX_BYTES = 256 * 1024;
export const ICON_MAX_SIDE = 2048;

export type IconType = 'image/png' | 'image/jpeg' | 'image/webp';

/** Type and size from the file header (the publisher's content-type is never trusted). */
export function imageInfo(b: Buffer): { type: IconType; width: number; height: number } | null {
  if (!Buffer.isBuffer(b) || b.length < 24) return null;
  // PNG: signature + IHDR (width/height big-endian at 16/20)
  if (b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a && b.toString('latin1', 12, 16) === 'IHDR') return { type: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  // WebP: RIFF....WEBP + VP8 / VP8L / VP8X chunk
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' && b.length >= 30) {
    const chunk = b.toString('latin1', 12, 16);
    if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { type: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L' && b[20] === 0x2f) {
      const bits = b.readUInt32LE(21);
      return { type: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { type: 'image/webp', width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
    return null;
  }
  // JPEG: SOI, then walk the markers to the first SOFn frame header
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m === 0xff) {
        i++;
        continue;
      }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = b.readUInt16BE(i + 2);
      if (len < 2) return null;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { type: 'image/jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + len;
    }
    return null;
  }
  return null;
}

/** A small, acceptable icon: one of the three raster types, within the byte and pixel limits. */
export function acceptableIcon(b: Buffer): IconType | null {
  if (!Buffer.isBuffer(b) || !b.length || b.length > ICON_MAX_BYTES) return null;
  const info = imageInfo(b);
  if (!info || info.width < 1 || info.height < 1 || info.width > ICON_MAX_SIDE || info.height > ICON_MAX_SIDE) return null;
  return info.type;
}

/**
 * "No icon", as an image that loads: a 1x1 transparent PNG (68 bytes). The marketplace asks for this (`miss=none`)
 * instead of a 404, sees the 1x1 size and draws the app's monogram: a missing icon is no failed request in the console.
 */
export const NO_ICON_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64');

/** Neutral fallback (a plug), drawn here; served when an app has no usable icon. */
export const FALLBACK_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#8C97AB" fill-opacity="0.18"/><g fill="none" stroke="#8C97AB" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M26 16v10M38 16v10"/><path d="M20 26h24v6a12 12 0 0 1-24 0z"/><path d="M32 44v6"/></g></svg>';
