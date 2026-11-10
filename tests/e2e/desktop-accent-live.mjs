// LIVE check of the app icon in the accent colour (Windows desktop shell, TeamBot 0.4.4), in a temporary data folder:
// the real Electron app starts (a window and a tray icon appear for a few seconds); the owner picks "Kobalt" in
// Instellingen › Uiterlijk (the same settings API the page uses) → window/taskbar icon and tray icon turn blue, the
// choice is remembered for the next start (shell.json); back to "Standaard" → the tangerine figure again.
// Never the installed TeamBot: own TEAMBOT_DATA and APPDATA, port TEAMBOT_PORT (default 4827, never 4747/4748).
// Usage: npm run build && node tests/e2e/desktop-accent-live.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _electron } = require('playwright-core');
const root = process.cwd();
const port = process.env.TEAMBOT_PORT || '4827';
if (port === '4747' || port === '4748') throw new Error('4747/4748 zijn van de geïnstalleerde TeamBot');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-desktop-accent-'));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(!!ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const until = async (fn, ms = 15_000) => {
  const t = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t > ms) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
};
/** Blue-ish (Kobalt) or orange-ish (Standaard) average of the strongly coloured pixels. */
const hue = (c) => (!c ? 'geen' : c[2] > c[0] + 30 ? 'blauw' : c[0] > c[2] + 60 ? 'oranje' : `anders ${c.join(',')}`);

const app = await _electron.launch({ executablePath: require('electron'), args: [root], cwd: root, env: { ...process.env, TEAMBOT_DATA: dataDir, APPDATA: dataDir, TEAMBOT_PORT: port } });
try {
  await app.firstWindow();
  const main = await until(async () => app.windows().find((w) => /^https?:/.test(w.url())), 60_000);
  if (!main) throw new Error('het hoofdvenster van TeamBot kwam niet');
  await main.waitForFunction(() => !!window.teambotDesktop && !!localStorage.getItem('tb_token'), null, { timeout: 30_000 });
  check('desktop-app start in een tijdelijke datamap', true, dataDir);
  const base = new URL(main.url()).origin;
  const token = await main.evaluate(() => localStorage.getItem('tb_token'));
  const api = async (method, p, body) => (await fetch(base + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })).json();
  // Record the icons the main process sets (the real ones still change on screen), as their dominant colour.
  await app.evaluate(({ BrowserWindow, Tray }) => {
    const dominant = (img) => {
      const bmp = img.toBitmap();
      let n = 0;
      const s = [0, 0, 0];
      for (let i = 0; i + 3 < bmp.length; i += 4) {
        if (bmp[i + 3] < 200) continue;
        const r = bmp[i + 2], g = bmp[i + 1], b = bmp[i];
        if (Math.max(r, g, b) < 90 || Math.max(r, g, b) - Math.min(r, g, b) < 60) continue;
        s[0] += r;
        s[1] += g;
        s[2] += b;
        n++;
      }
      return n ? s.map((v) => Math.round(v / n)) : null;
    };
    globalThis.__icons = { window: [], tray: [] };
    const setIcon = BrowserWindow.prototype.setIcon;
    BrowserWindow.prototype.setIcon = function (img) {
      globalThis.__icons.window.push(dominant(img));
      return setIcon.call(this, img);
    };
    const setImage = Tray.prototype.setImage;
    Tray.prototype.setImage = function (img) {
      globalThis.__icons.tray.push(dominant(img));
      return setImage.call(this, img);
    };
  });
  const settings = await api('GET', '/settings');
  await api('PUT', '/settings', { ui: { ...(settings.ui || {}), accent: 'cobalt' } });
  const blue = await until(() => app.evaluate(() => (globalThis.__icons.window.length && globalThis.__icons.tray.length ? globalThis.__icons : null)));
  check('Kobalt gekozen: het venster- en taakbalkpictogram wordt blauw', blue && hue(blue.window.at(-1)) === 'blauw', JSON.stringify(blue?.window.at(-1)));
  check('Kobalt gekozen: het pictogram in het systeemvak wordt blauw', blue && hue(blue.tray.at(-1)) === 'blauw', JSON.stringify(blue?.tray.at(-1)));
  const shell = path.join(dataDir, 'electron', 'shell.json');
  const remembered = await until(async () => (JSON.parse(fs.readFileSync(shell, 'utf8')).accent === 'cobalt' ? true : null), 5000);
  check('de keuze staat klaar voor de volgende start (shell.json)', !!remembered);

  await app.evaluate(() => (globalThis.__icons = { window: [], tray: [] }));
  await api('PUT', '/settings', { ui: { ...(settings.ui || {}), accent: 'standard' } });
  const orange = await until(() => app.evaluate(() => (globalThis.__icons.window.length && globalThis.__icons.tray.length ? globalThis.__icons : null)));
  check('terug naar Standaard: weer het oranje TeamBot-figuurtje (venster en systeemvak)', orange && hue(orange.window.at(-1)) === 'oranje' && hue(orange.tray.at(-1)) === 'oranje', JSON.stringify(orange));
  // another setting: the window icon is not touched (the tray may be refreshed by the badge, in the same colour)
  await app.evaluate(() => (globalThis.__icons = { window: [], tray: [] }));
  await api('PUT', '/settings', { ui: { ...(settings.ui || {}), accent: 'standard', advanced: true } });
  await new Promise((r) => setTimeout(r, 800));
  const after = await app.evaluate(() => globalThis.__icons);
  check('een andere instelling wijzigen laat het pictogram zoals het is', after.window.length === 0 && after.tray.every((c) => hue(c) === 'oranje'), JSON.stringify(after));
} catch (e) {
  check('onverwachte fout', false, e.message);
} finally {
  await app.close().catch(() => {});
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} geslaagd`);
process.exit(failed ? 1 : 0);
