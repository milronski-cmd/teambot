/** Electron images for the taskbar badge (see badge.ts) and the app icon in the accent colour (accent-icon.ts). */
import { nativeImage, type NativeImage } from 'electron';
import { withTrayDot } from './badge.js';
import { recolorBitmap } from './accent-icon.js';
import { accentById, DEFAULT_ACCENT, STANDARD_LOGO } from '../shared/accent.js';

/** One image with the badge PNGs as representations (16 px = scale 1, 24 px = 1.5, 32 px = 2). */
export function overlayImage(imgs: { size: number; png: Buffer }[]): NativeImage {
  const img = nativeImage.createEmpty();
  for (const i of imgs) img.addRepresentation({ scaleFactor: i.size / 16, buffer: i.png });
  return img;
}

/** The tray icon (the app icon file, or an image of it) with a small badge dot; 16 px plus 32 px for 200 %. */
export function trayImageWithDot(icon: string | NativeImage): NativeImage | null {
  if (!icon) return null;
  const src = typeof icon === 'string' ? nativeImage.createFromPath(icon) : icon;
  if (src.isEmpty()) return null;
  const s16 = src.resize({ width: 16, height: 16, quality: 'best' });
  const s32 = src.resize({ width: 32, height: 32, quality: 'best' });
  const img = nativeImage.createFromBitmap(withTrayDot(s16.toBitmap(), 16, 16), { width: 16, height: 16 });
  img.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: withTrayDot(s32.toBitmap(), 32, 32) });
  return img;
}

/**
 * The app icon in an accent colour: the figure's body in that accent's logo colour ("Standaard" = the icon file as
 * it is). Empty image when the file is missing.
 */
export function accentIconImage(iconFile: string, accentId: string): NativeImage {
  const src = iconFile ? nativeImage.createFromPath(iconFile) : nativeImage.createEmpty();
  if (src.isEmpty() || accentId === DEFAULT_ACCENT) return src;
  const logo = accentById(accentId).logo;
  if (logo.toLowerCase() === STANDARD_LOGO.toLowerCase()) return src;
  const { width, height } = src.getSize();
  return nativeImage.createFromBitmap(recolorBitmap(src.toBitmap(), STANDARD_LOGO, logo), { width, height });
}

/** The tray size of an app icon (16 px plus 32 px for 200 %). */
export function trayImage(icon: NativeImage): NativeImage {
  if (icon.isEmpty()) return icon;
  const img = icon.resize({ width: 16, height: 16, quality: 'best' });
  img.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: icon.resize({ width: 32, height: 32, quality: 'best' }).toPNG() });
  return img;
}
