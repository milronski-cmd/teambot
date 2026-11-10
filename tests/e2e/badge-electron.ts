// Electron side of tests/e2e/badge-check.mjs. Runs the real badge code (desktop/badge.ts + badge-images.ts) with real
// Electron images and a HIDDEN window (show: false, never shown or focused, no tray icon), in a temporary data folder.
// Writes the overlay and tray images as PNG files, so they can be looked at instead of the real taskbar.
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { DesktopBadge, type BadgeState } from '../../desktop/badge.js';
import { overlayImage, trayImageWithDot } from '../../desktop/badge-images.js';

const dir = process.env.TB_BADGE_DIR!;
const shots = process.env.TB_BADGE_SHOTS!;
const icon = process.env.TB_BADGE_ICON!;
const out = (o: any) => process.stdout.write('@@' + JSON.stringify(o) + '\n');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
app.setPath('userData', path.join(dir, 'electron'));

app.whenReady().then(async () => {
  let code = 0;
  const check = (name: string, ok: boolean, detail = '') => {
    if (!ok) code = 1;
    out({ check: name, ok, detail });
  };
  try {
    const win = new BrowserWindow({ show: false, focusable: false, width: 320, height: 200, webPreferences: { sandbox: true } });
    const overlays: { desc: string; scales: number[] | null }[] = [];
    const trays: BadgeState[] = [];
    const badge = new DesktopBadge(
      {
        platform: 'win32',
        setOverlay: (imgs, desc) => {
          const img = imgs ? overlayImage(imgs) : null;
          win.setOverlayIcon(img, imgs ? desc : ''); // must not throw, also on a hidden window
          overlays.push({ desc, scales: img ? img.getScaleFactors() : null });
          if (img) for (const s of [1, 2]) fs.writeFileSync(path.join(shots, `badge-electron-overlay-${16 * s}.png`), img.toPNG({ scaleFactor: s }));
        },
        setBadgeCount: () => {},
        setTray: (s) => trays.push(s),
      },
      20,
    );
    badge.report({ waiting: 3, unread: 0 });
    badge.report({ waiting: 3, unread: 0 });
    await sleep(120);
    check('overlay gezet met beschrijving', overlays.length === 1 && overlays[0].desc === '3 wachten op jou', JSON.stringify(overlays));
    check('overlay heeft 16/24/32 px', JSON.stringify(overlays[0]?.scales) === JSON.stringify([1, 1.5, 2]), JSON.stringify(overlays[0]?.scales));
    badge.report({ waiting: 0, unread: 0 });
    await sleep(120);
    check('overlay gewist bij 0', overlays.at(-1)?.scales === null && trays.at(-1)?.count === 0);
    const tray = trayImageWithDot(icon);
    check('systeemvak-icoon met stip', !!tray && tray.getSize().width === 16 && JSON.stringify(tray.getScaleFactors()) === JSON.stringify([1, 2]));
    if (tray) for (const s of [1, 2]) fs.writeFileSync(path.join(shots, `badge-electron-tray-${16 * s}.png`), tray.toPNG({ scaleFactor: s }));
    check('venster is nooit getoond', !win.isVisible());
    badge.stop();
    win.destroy();
  } catch (e: any) {
    check('geen fout', false, String(e?.stack || e));
  }
  out({ done: true });
  app.exit(code);
});
