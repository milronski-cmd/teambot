/**
 * TeamBot desktop shell (Windows first; also runs on macOS/Linux).
 *
 * The full TeamBot server runs inside this process, bound to 127.0.0.1 only, in "desktop" mode
 * (single local owner, no password). The window loads the same web UI the phone/PWA uses.
 * The window opens at once on a calm start page (desktop/start-page.ts; the first start after installing says
 * "TeamBot is geïnstalleerd") and loads the interface in place as soon as the server runs.
 * Closing the window keeps TeamBot running in the tray so routines and channels keep working; the first time, one
 * message says so and offers to quit instead. "Afsluiten" in the tray menu stops everything.
 *
 * Loaded by desktop/boot.ts (the entry of the app), which catches a start that fails: this file tells it how the
 * start went with `app.emit('teambot:started')` and `app.emit('teambot:start-failed', error)`.
 */
import { app, BrowserWindow, Menu, Notification, Tray, clipboard, dialog, ipcMain, nativeImage, nativeTheme, safeStorage, screen, session, shell } from 'electron';
import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createApp, type AppHandle } from '../server/app.js';
import { loadConfig } from '../server/core/config.js';
import { applyPendingRestore } from '../server/modules/backups/restore.js';
import { Updater } from './updater.js';
import { updateBlockers } from '../server/modules/backups/app-update.js';
import { linuxBackendIsSecure, loadProtectedKey, type KeyProtector } from './keystore.js';
import { DesktopIndicator } from './indicator.js';
import { RemoteIndicator } from './remote-indicator.js';
import { DesktopStatus } from './status.js';
import { DesktopBadge } from './badge.js';
import { accentIconImage, overlayImage, trayImage, trayImageWithDot } from './badge-images.js';
import { accentOfSettings, cleanAccent } from '../shared/accent.js';
import { attachPowerBlocker } from './power.js';
import { attachPresence } from './presence.js';
import { startDictationHotkey, type DictationHotkey } from './dictation.js';
import { MIN_SIZE, readShellState, windowBounds, writeShellState } from './shell-state.js';
import { CANVAS, startPageUrl } from './start-page.js';
import { contextMenuEntries, type MenuAction } from './context-menu.js';
import { tr } from '../server/core/i18n.js';
import { isLanguage, matchLanguage } from '../shared/languages.js';
import { setInAppBrowserHost } from '../server/modules/browser/inapp.js';
import { createInAppBrowserHost } from './inapp-browser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PREFERRED_PORT = Number(process.env.TEAMBOT_PORT || 4747);

let handle: AppHandle | null = null;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let baseUrl = '';
let token = '';
let updater: Updater | null = null;
let installing = false;
/** "Terug naar versie x" was chosen: will-quit puts the pre-update backup back and runs the kept older installer. */
let rollingBack = false;
/** "Nu opnieuw starten" (a staged restore): a plain restart, never an update install on the way. */
let restarting = false;
/** An installer asked TeamBot to close ("TeamBot.exe --quit"): quit without installing a downloaded update. */
let forInstaller = false;
let refreshTray: () => void = () => {};
/** Keeps the computer awake while routines or tasks run (when the owner turned it on). */
let power: { reason(): string | null; dispose(): void } | null = null;
let indicator: DesktopIndicator | null = null;
let remoteIndicator: RemoteIndicator | null = null;
let status: DesktopStatus | null = null;
/** Stops telling the server whether the owner sits at this pc (desktop/presence.ts). */
let presenceOff: (() => void) | null = null;
let dictation: DictationHotkey | null = null;
let badge: DesktopBadge | null = null;
let badgeOff: (() => void) | null = null;
const pips = new Map<string, BrowserWindow>();

// Keep Chromium's own cache/state out of the TeamBot data folder (it lives in <data>/electron).
app.setPath('userData', path.join(loadConfig({ mode: 'desktop' }).dataDir, 'electron'));

// Started from a shortcut, the working folder is the install folder, and every helper TeamBot starts (dictation,
// browsers, MCP servers, engines) inherits it: a leftover helper then keeps the install folder in use while an
// installer replaces it (0.4.4, build/teambot-close.ps1). The installed app works from the home folder instead.
if (app.isPackaged) {
  try {
    process.chdir(app.getPath('home'));
  } catch {
    /* stays where it was */
  }
}

// "TeamBot.exe --quit" (build/teambot-close.ps1, before installing or uninstalling): the running TeamBot gets it as a
// second instance and quits cleanly; without a running TeamBot this one simply stops.
const quitRequest = process.argv.includes('--quit');
if (!app.requestSingleInstanceLock() || quitRequest) {
  app.quit();
  process.exit(0);
}

app.setAppUserModelId('app.teambot.desktop');

function iconPath(): string {
  const candidates = [path.join(process.resourcesPath || '', 'icon.png'), path.resolve(here, '../../build/icon.png'), path.resolve(here, '../ui/icon-512.png')];
  return candidates.find((p) => p && fs.existsSync(p)) || '';
}

// ---- the app icon in the owner's accent colour (window, taskbar, tray; Instellingen › Uiterlijk › Kleur) ----

/** The accent the icons show: the owner's choice (any device), remembered for the next start (before the server). */
let iconAccent = cleanAccent(readShellState(app.getPath('userData')).accent);
let iconImg: Electron.NativeImage | null = null;

function ownerAccent(): string {
  try {
    const o = handle?.ctx.auth.owner();
    if (o) return accentOfSettings({ ui: handle!.ctx.store.getSetting<any>(o.id, 'ui', {}) });
  } catch {
    /* no server yet */
  }
  return iconAccent;
}

/** The app icon in the current accent (cached; "Standaard" = the icon file). */
function appIcon(): Electron.NativeImage {
  return (iconImg ??= accentIconImage(iconPath(), iconAccent));
}

/** The owner picked another accent: window, taskbar and tray (with or without the badge dot) follow at once. */
function applyAccentIcon() {
  const next = ownerAccent();
  if (next === iconAccent && iconImg) return;
  iconAccent = next;
  iconImg = null;
  trayDotImg = null;
  const img = appIcon();
  if (readShellState(app.getPath('userData')).accent !== next) writeShellState(app.getPath('userData'), { accent: next });
  if (img.isEmpty()) return;
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.setIcon(img);
  trayImg = trayImage(img);
  if (tray && !tray.isDestroyed()) tray.setImage(badgeDot && trayWithDot() ? trayWithDot()! : trayImg);
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

/**
 * SEC-07: on Windows the master key that encrypts all stored API keys is protected with DPAPI (bound to the Windows
 * user) instead of a plain file. We call DPAPI directly through PowerShell/.NET rather than Electron's safeStorage,
 * because safeStorage keeps its own key in Chromium's "Local State" file, which can be lost on a hard shutdown and
 * would then lock the user out. An existing plain `master.key` is migrated once, and only deleted after a verified
 * round-trip. macOS and Linux use Electron safeStorage (Keychain / secret service), see keyProtector(); the shared
 * migration and never-lock-out logic lives in keystore.ts.
 */
function dpapi(op: 'Protect' | 'Unprotect', data: Buffer): Promise<Buffer> {
  const script =
    'Add-Type -AssemblyName System.Security; $in=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ' +
    `$out=[Security.Cryptography.ProtectedData]::${op}($in,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
    '[Console]::Out.Write([Convert]::ToBase64String($out))';
  // Asynchronous: PowerShell takes a second or two (longer with a virus scanner), and the start window must keep
  // drawing meanwhile (a window that does not answer for 5 s is marked "Not responding" by Windows).
  return new Promise((resolve, reject) => {
    const p = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 }, (err, out) =>
      err ? reject(err) : resolve(Buffer.from(String(out).trim(), 'base64')),
    );
    p.stdin?.end(data.toString('base64'));
  });
}

let keyWarning = '';

/**
 * The owner's interface language for the tray, notifications and dialogs of the desktop shell: their choice in
 * TeamBot (any device), else the system language (fallback English), as the interface does on a first run.
 */
function ownerLang(): string {
  try {
    const o = handle?.ctx.auth.owner();
    const v = o ? handle!.ctx.store.getSetting<string>(o.id, 'language', '') : '';
    if (isLanguage(v)) return v;
  } catch {
    /* no server yet */
  }
  return matchLanguage([app.getLocale?.() || '', ...(app.getPreferredSystemLanguages?.() || [])]);
}
/** A Dutch shell text in the owner's language (server/core/i18n.ts dictionaries). */
const L = (text: string, ...values: (string | number)[]) => tr(ownerLang(), text, ...values);

/** The OS protector for the master key on this platform, or null when there is no real OS secret store. */
function keyProtector(): KeyProtector | null {
  if (process.platform === 'win32') return { name: 'dpapi', protect: (d) => dpapi('Protect', d), unprotect: (d) => dpapi('Unprotect', d) };
  try {
    // macOS: Keychain; Linux: libsecret/KWallet. On Linux without a secret service safeStorage silently falls back to a
    // hard-coded key ("basic_text"), which protects nothing; then we keep the 0600 file and say so in diagnostics.
    if (!safeStorage.isEncryptionAvailable()) return null;
    if (process.platform === 'linux' && !linuxBackendIsSecure((safeStorage as any).getSelectedStorageBackend?.())) return null;
    return {
      name: process.platform === 'darwin' ? 'keychain' : 'secret-service',
      protect: (d) => safeStorage.encryptString(d.toString('base64')),
      unprotect: (b) => Buffer.from(safeStorage.decryptString(b), 'base64'),
    };
  } catch {
    return null;
  }
}

async function protectedMasterKey(dataDir: string): Promise<Buffer | undefined> {
  const r = await loadProtectedKey(dataDir, keyProtector());
  if (r.warning) keyWarning = r.warning;
  return r.key;
}

async function startServer() {
  const port = (await portFree(PREFERRED_PORT)) ? PREFERRED_PORT : 0;
  const dataDir = loadConfig({ mode: 'desktop' }).dataDir;
  // A staged backup restore goes in place before the key is read: the restored key file belongs to the restored
  // database (createApp would do it too, but only after the key of the replaced data was loaded).
  try {
    applyPendingRestore(dataDir);
  } catch (e: any) {
    console.error('[backup] terugzetten bij het starten mislukt', e?.message || e);
  }
  const masterKey = await protectedMasterKey(dataDir);
  // The bots' own browsers live inside this app (invisible tabs, desktop/inapp-browser.ts): nothing to install, nothing
  // on screen. An installed Edge/Chrome stays the owner's alternative (Computers › Browser van de bots).
  setInAppBrowserHost(createInAppBrowserHost({ icon: () => iconPath() || undefined }));
  handle = await createApp({ mode: 'desktop', host: '127.0.0.1', port, masterKey });
  if (keyWarning) {
    handle.ctx.log.warn(keyWarning);
    const owner = handle.ctx.auth.owner();
    if (owner) handle.ctx.audit(owner.id, 'secrets.key_reset', { reason: keyWarning });
    app.whenReady().then(() => new Notification({ title: L('TeamBot: sleutels opnieuw invoeren'), body: L(keyWarning) }).show());
  }
  token = handle.ctx.auth.ensureLocalOwner();
  baseUrl = handle.url;
}

function isAppUrl(u: string) {
  try {
    return new URL(u).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/**
 * The main window, on its last place (made to fit the screens of now) or in the middle of the screen, never larger than
 * it. Before the server runs it shows `startPage`; once it runs, the interface (loadApp).
 */
function createWindow(startPage?: string) {
  const place = windowBounds(
    readShellState(app.getPath('userData')).window,
    screen.getAllDisplays().map((d) => d.workArea),
    screen.getPrimaryDisplay().workArea,
  );
  win = new BrowserWindow({
    ...place.bounds,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    title: 'TeamBot',
    icon: appIcon().isEmpty() ? iconPath() || undefined : appIcon(),
    // The interface's canvas colour (it follows the system theme by default): no white flash in dark mode.
    backgroundColor: nativeTheme.shouldUseDarkColors ? CANVAS.dark.bg : CANVAS.light.bg,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
      // A live call keeps running while the window is hidden (tray, closed window): no timer throttling that would
      // stall its polling and audio scheduling (0.4.4, owner: "blijft lopen als het venster verborgen is").
      backgroundThrottling: false,
    },
  });
  const self = win;
  win.once('ready-to-show', () => {
    if (place.maximized) win?.maximize();
    win?.show();
  });
  // Windows signs off or shuts down: let every window close, never a tip or a hidden window in the way.
  win.on('session-end', () => {
    // The watchdog outside the app (0.4.4, P14) must not call this a crash.
    handle?.ctx.services.health?.markStopped?.('shutdown');
    saveWindowPlace();
    quitting = true;
  });
  // Gone anyway (the page closed itself, a crash): "TeamBot openen" makes a new one instead of using a dead one.
  self.on('closed', () => {
    if (win === self) win = null;
  });
  // Right click: spelling suggestions, "Toevoegen aan woordenboek" and cut/copy/paste (Electron shows nothing itself).
  win.webContents.on('context-menu', (_e, params) => {
    const wc = win?.webContents;
    if (!wc) return;
    const entries = contextMenuEntries(params, L);
    if (!entries.length) return;
    const run: Record<MenuAction, (word?: string) => void> = {
      replace: (w) => w && wc.replaceMisspelling(w),
      learn: (w) => w && wc.session.addWordToSpellCheckerDictionary(w),
      cut: () => wc.cut(),
      copy: () => wc.copy(),
      paste: () => wc.paste(),
      selectAll: () => wc.selectAll(),
      copyLink: () => clipboard.writeText(params.linkURL),
    };
    Menu.buildFromTemplate(entries.map((m) => (m.kind === 'separator' ? { type: 'separator' as const } : { label: m.label, enabled: m.enabled, click: () => run[m.action](m.word) }))).popup({ window: win! });
  });
  // Windows drops the overlay icon together with the taskbar button when the window hides; put it back on show.
  win.on('show', () => badge?.refresh());
  // The interface crashed or did not load: it comes back by itself (at most 3 times a minute), and the log says why.
  win.webContents.on('render-process-gone', (_e, d) => {
    badge?.report(null);
    // With the exit code: "crashed" alone did not say why (three times on 9/10 November, no dump to look at).
    if (d.reason !== 'clean-exit') recoverWindow(self, `het venster is gestopt (${d.reason}, exitcode ${d.exitCode})`);
  });
  win.webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    // -3: a navigation that was replaced by the next one, not a failure.
    if (isMainFrame && code !== -3 && isAppUrl(url)) recoverWindow(self, `de interface laadde niet (${description || code})`);
  });
  // Links to the outside world open in the user's own browser; the app window never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) return { action: 'allow' };
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-create-window', (child) => {
    child.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url) && !isAppUrl(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    child.webContents.on('will-navigate', (e, url) => {
      if (!isAppUrl(url)) {
        e.preventDefault();
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      }
    });
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAppUrl(url)) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  win.on('close', onClose);
  if (baseUrl) loadApp();
  else if (startPage) win.loadURL(startPage).catch(() => {});
}

/** The interface, in the main window (in place of the start page). */
function loadApp() {
  if (!win || win.isDestroyed() || !baseUrl) return;
  win.loadURL(`${baseUrl}/#token=${encodeURIComponent(token)}`).catch(() => {});
}

let reloads: number[] = [];
function recoverWindow(w: BrowserWindow, why: string) {
  handle?.ctx.log.error(`[desktop] ${why}`);
  const t = Date.now();
  reloads = reloads.filter((x) => t - x < 60_000);
  if (quitting || w !== win || reloads.length >= 3) return;
  reloads.push(t);
  setTimeout(() => w === win && loadApp(), 500);
}

function saveWindowPlace() {
  if (!win || win.isDestroyed()) return;
  writeShellState(app.getPath('userData'), { window: { bounds: win.getNormalBounds(), maximized: win.isMaximized() } });
}

/**
 * Closing the window hides it: TeamBot keeps running in the tray, so routines, channels and the phone keep working.
 * The first time (ever, not per start) one message says so, with "Op de achtergrond verder" as the default and the
 * choice to quit instead. After that a close just hides the window.
 */
let closeTipOpen = false;
function onClose(e: Electron.Event) {
  saveWindowPlace();
  if (quitting) return;
  e.preventDefault();
  if (closeTipOpen || !win) return;
  const dir = app.getPath('userData');
  if (readShellState(dir).closeTipAt) {
    win.hide();
    return;
  }
  closeTipOpen = true;
  dialog
    .showMessageBox(win, {
      type: 'info',
      title: 'TeamBot',
      message: L('TeamBot draait op de achtergrond'),
      detail: L('Je bots, routines en kanalen blijven werken. Afsluiten kan via het TeamBot-icoon in het systeemvak.'),
      buttons: [L('Op de achtergrond verder'), L('TeamBot afsluiten')],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    .then(({ response }) => {
      writeShellState(dir, { closeTipAt: new Date().toISOString() });
      if (response === 1) {
        quitting = true;
        app.quit();
      } else win?.hide();
    })
    .catch(() => win?.hide())
    .finally(() => {
      closeTipOpen = false;
    });
}

/** The TeamBot icon for the start page (twice its size there, for high-dpi screens). */
function iconDataUrl(): string | undefined {
  const img = appIcon();
  if (img.isEmpty()) return undefined;
  try {
    return img.resize({ width: 176, height: 176, quality: 'best' }).toDataURL();
  } catch {
    return undefined;
  }
}

/**
 * The first start after the installer: no database yet, and this is an installed copy (the uninstaller the installer
 * writes is next to TeamBot.exe; not in a development build or an unpacked folder).
 */
function firstStartAfterInstall(): boolean {
  if (!app.isPackaged || process.platform !== 'win32') return false;
  try {
    const dataDir = loadConfig({ mode: 'desktop' }).dataDir;
    return !fs.existsSync(path.join(dataDir, 'teambot.db')) && fs.existsSync(path.join(path.dirname(process.execPath), 'Uninstall TeamBot.exe'));
  } catch {
    return false;
  }
}

/**
 * Open the window right away on the start page, and wait until it is on screen: starting the server keeps this
 * process busy for a moment (the key through DPAPI, the database), and the page should be visible by then.
 */
async function openStartWindow(installed: boolean) {
  // The language the owner chose in TeamBot (remembered from the last run), else the one of the system.
  const saved = readShellState(app.getPath('userData')).lang;
  const lang = saved && isLanguage(saved) ? saved : ownerLang();
  const T = (text: string) => tr(lang, text);
  createWindow(
    startPageUrl({
      lang,
      dark: nativeTheme.shouldUseDarkColors,
      icon: iconDataUrl(),
      title: installed ? T('TeamBot is geïnstalleerd') : 'TeamBot',
      lines: installed ? [T('Je vindt TeamBot voortaan in het Startmenu en op je bureaublad.')] : [],
      wait: T('Even geduld…'),
    }),
  );
  await new Promise<void>((resolve) => {
    win?.once('ready-to-show', () => setTimeout(resolve, 60));
    setTimeout(resolve, 2000);
  });
}

function show(hash?: string) {
  if (!win) createWindow();
  if (hash) win!.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => {});
  win!.show();
  win!.focus();
}

let trayImg: Electron.NativeImage | null = null;
let trayDotImg: Electron.NativeImage | null = null;
/** The tray shows the badge dot now (something waits for the owner). */
let badgeDot = false;

/** The tray icon (in the accent colour) with a small badge dot (something waits for the owner). */
function trayWithDot(): Electron.NativeImage | null {
  return (trayDotImg ??= trayImageWithDot(appIcon()));
}

/** Started at login: only the tray, no window. */
const LOGIN_ARGS = ['--hidden'];

/**
 * "Het werkt gewoon": the installed TeamBot starts with the computer from its first run on (once; shell-state
 * `loginItemAt`), so bots, routines and the phone are back after a restart or a crash of the pc. Switching it off in
 * the tray menu stays off. Not for a development run (that would register electron.exe).
 */
function startAtLoginByDefault() {
  if (!app.isPackaged || process.platform === 'linux') return;
  const dir = app.getPath('userData');
  if (readShellState(dir).loginItemAt) return;
  try {
    if (!app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin) app.setLoginItemSettings({ openAtLogin: true, args: LOGIN_ARGS });
    writeShellState(dir, { loginItemAt: new Date().toISOString() });
  } catch {
    /* next start tries again */
  }
}

function buildTray() {
  const icon = appIcon();
  const img = icon.isEmpty() ? nativeImage.createEmpty() : trayImage(icon);
  trayImg = img;
  tray = new Tray(img);
  tray.setToolTip('TeamBot');
  const refresh = () => {
    const login = app.getLoginItemSettings({ args: LOGIN_ARGS });
    const u = updater?.state;
    const updateItem: Electron.MenuItemConstructorOptions[] =
      !u || u.phase === 'off'
        ? []
        : u.phase === 'available'
          ? [{ label: L('Update downloaden (versie {0})', u.version || ''), click: () => void updater!.download() }]
          : u.phase === 'downloading'
            ? [{ label: L('Update downloaden… {0}%', u.percent ?? 0), enabled: false }]
            : u.phase === 'ready'
              ? [{ label: L('Opnieuw starten en bijwerken naar {0}', u.version || ''), click: () => installUpdate() }]
              : [{ label: u.phase === 'checking' ? L('Zoeken naar updates…') : L('Zoeken naar updates'), enabled: u.phase !== 'checking', click: () => void updater!.check() }];
    tray!.setContextMenu(
      Menu.buildFromTemplate([
        { label: L('TeamBot openen'), click: () => show() },
        ...(power?.reason() ? [{ label: L('Pc blijft wakker: {0}', power.reason() || ''), enabled: false }] : []),
        { label: badge?.state.waiting ? L('Wacht op jou ({0})', badge.state.waiting) : L('Wacht op jou'), click: () => show('#/inbox') },
        { label: L('Gebruik en limieten'), click: () => show('#/settings/usage-limits') },
        {
          label: L('Zwevend statusvenster'),
          type: 'checkbox',
          checked: (status?.mode() || 'off') !== 'off',
          click: (item) => status?.setMode(item.checked ? 'auto' : 'off'),
        },
        { type: 'separator' },
        {
          label: L('Alle bots stoppen'),
          click: () => {
            const owner = handle?.ctx.auth.owner();
            const n = owner ? handle!.ctx.runs.stopAll(owner.id) : 0;
            new Notification({ title: 'TeamBot', body: n === 1 ? L('1 taak gestopt') : L('{0} taken gestopt', n) }).show();
          },
        },
        {
          label: indicator?.hotkey ? L('Noodstop bureaublad ({0})', indicator.hotkey) : L('Noodstop bureaublad'),
          click: () => indicator?.emergencyStop('systeemvak'),
        },
        ...(remoteIndicator?.count ? [{ label: L('Stop bureaublad op afstand'), click: () => remoteIndicator?.stopNow('systeemvak') }] : []),
        ...(indicator?.state?.paused && indicator.state.agentName
          ? [{ label: L('Geef bediening terug aan {0}', indicator.state.agentName), click: () => indicator?.giveBack() }]
          : []),
        {
          label: process.platform === 'win32' ? L('Starten bij inloggen op Windows') : L('Starten bij inloggen'),
          type: 'checkbox',
          checked: login.openAtLogin,
          click: (item) => {
            app.setLoginItemSettings({ openAtLogin: item.checked, args: LOGIN_ARGS });
            refresh();
          },
        },
        { label: L('Datamap openen'), click: () => handle && shell.openPath(handle.ctx.config.dataDir) },
        ...updateItem,
        { type: 'separator' },
        {
          label: L('Afsluiten'),
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ]),
    );
  };
  refreshTray = refresh;
  refresh();
  tray.on('click', () => show());
}

/** Close the server cleanly, then let electron-updater run the downloaded installer (it restarts TeamBot). */
function installUpdate() {
  if (!updater || updater.state.phase !== 'ready' || installing) return false;
  installing = true;
  quitting = true;
  app.quit(); // will-quit closes the server and then hands over to the installer
  return true;
}

let updateNote: NodeJS.Timeout | null = null;

/** The update page (computer and phone) reloads its status: at most twice a second (download progress). */
function sendUpdateState() {
  if (updateNote) return;
  updateNote = setTimeout(() => {
    updateNote = null;
    const o = handle?.ctx.auth.owner();
    if (o) handle!.ctx.events.emit(o.id, 'app-update.changed', { phase: updater?.state.phase || 'off' });
  }, 500);
  updateNote.unref?.();
}

/**
 * The updater for the server (ctx.services.appUpdate → /api/app-update): the status on the computer and the phone,
 * "Nu controleren", "Nu bijwerken", Automatisch bijwerken and the channel (the route keeps that one computer-only).
 */
function startAppUpdate(u: Updater) {
  const h = handle;
  if (!h) return;
  h.ctx.services.appUpdate = {
    info: () => u.info(),
    check: () => u.check(),
    download: () => u.download(),
    installNow: () => u.installNow(),
    save: (patch: { channel?: string; auto?: 'on' | 'notify' | 'off' }) => u.save(patch),
  };
}

function fromApp(e: Electron.IpcMainInvokeEvent) {
  const url = e.senderFrame?.url || '';
  if (!isAppUrl(url)) throw new Error('Niet toegestaan');
}

function lockDownSession() {
  const ses = session.defaultSession;
  // Only the TeamBot UI itself may use the microphone (push-to-talk / live voice) and notifications.
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const origin = details.requestingUrl || wc.getURL();
    const allowed = ['media', 'notifications', 'clipboard-sanitized-write', 'fullscreen'].includes(permission);
    cb(allowed && isAppUrl(origin));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => ['media', 'notifications', 'clipboard-sanitized-write'].includes(permission) && isAppUrl(origin));
}

ipcMain.handle('teambot:info', () => ({ version: app.getVersion(), platform: process.platform, url: baseUrl, dataDir: handle?.ctx.config.dataDir }));
// The update status, "Nu bijwerken", Automatisch bijwerken and the channel go through the server (/api/app-update,
// server/modules/backups/app-update.ts), so the phone sees them too; see startAppUpdate below.
/**
 * "Terug naar versie x" (Instellingen › Back-ups, owner, only from this window): stage the backup made right before
 * the update, then quit. will-quit puts it in place once the server is closed and runs the kept, re-verified
 * installer of the older version (electron-updater never downgrades by itself).
 */
ipcMain.handle('teambot:update:rollback', async (e) => {
  fromApp(e);
  const h = handle;
  if (!updater || !h || rollingBack || installing) throw new Error(L('Terug naar de vorige versie kan nu niet.'));
  const svc = h.ctx.services.backups;
  if (!svc?.stageRestore) throw new Error(L('Back-ups zijn niet beschikbaar.'));
  const owner = h.ctx.auth.owner();
  const plan = await updater.startRollback(
    (name) => svc.service.exists(name.endsWith('.db') ? name : `${name}.db`),
    (name) => svc.stageRestore(name.endsWith('.db') ? name : `${name}.db`, { by: owner?.id, reason: 'rollback' }),
  );
  if (owner) h.ctx.audit(owner.id, 'backup.rollback_started', { from: app.getVersion(), to: plan.to, backup: plan.backup });
  rollingBack = true;
  quitting = true;
  setTimeout(() => app.quit(), 300);
  return { ok: true, to: plan.to };
});
/** Start TeamBot again (after staging a restore: it is put in place at the next start). */
ipcMain.handle('teambot:restart', (e) => {
  fromApp(e);
  if (installing || rollingBack) return false;
  app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--hidden') });
  restarting = true;
  quitting = true;
  app.quit();
  return true;
});
/** Picture-in-picture: a small always-on-top window with a bot's live screen (browser or desktop). */
function openPip(agentId: string, kind: 'browser' | 'desktop') {
  const key = `${agentId}:${kind}`;
  const cur = pips.get(key);
  if (cur && !cur.isDestroyed()) {
    cur.show();
    cur.focus();
    return true;
  }
  const w = new BrowserWindow({
    width: 480,
    height: 360,
    minWidth: 320,
    minHeight: 240,
    title: 'TeamBot — live',
    icon: appIcon().isEmpty() ? iconPath() || undefined : appIcon(),
    alwaysOnTop: true,
    autoHideMenuBar: true,
    backgroundColor: '#111114',
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
  });
  w.setAlwaysOnTop(true, 'floating');
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !isAppUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, url) => {
    if (!isAppUrl(url)) e.preventDefault();
  });
  w.on('closed', () => pips.delete(key));
  w.loadURL(`${baseUrl}/#/m/browser/live/${encodeURIComponent(agentId)}/${kind === 'desktop' ? 'pip-desktop' : 'pip'}`);
  pips.set(key, w);
  return true;
}

ipcMain.handle('teambot:pip', (e, agentId: string, kind: string) => {
  fromApp(e);
  if (typeof agentId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(agentId)) throw new Error('Ongeldige bot');
  return openPip(agentId, kind === 'desktop' ? 'desktop' : 'browser');
});
/** Bring the main window to the front at a route (used by the floating status window). */
ipcMain.handle('teambot:show', (e, hash?: string) => {
  fromApp(e);
  show(typeof hash === 'string' && /^#\/[\w\-/.?=&%]{0,200}$/.test(hash) ? hash : undefined);
  return true;
});
ipcMain.handle('teambot:status:get', (e) => {
  fromApp(e);
  return { mode: status?.mode() || 'off' };
});
ipcMain.handle('teambot:status:set', (e, mode: string) => {
  fromApp(e);
  return { mode: status?.setMode(mode) || 'off' };
});
ipcMain.handle('teambot:status:hide', (e) => {
  fromApp(e);
  status?.hide();
  return true;
});
/** The main window's count of what waits for the owner (unread chats + approvals); fire-and-forget, debounced there. */
ipcMain.on('teambot:badge', (e, counts: unknown) => {
  // Only the main window counts (the status window and picture-in-picture windows run the same UI).
  if (!win || win.isDestroyed() || e.sender !== win.webContents || !isAppUrl(e.senderFrame?.url || '')) return;
  badge?.report(counts && typeof counts === 'object' ? (counts as { waiting?: number; unread?: number }) : null);
});

/** Taskbar overlay (Windows), dock/launcher count (macOS/Linux) and tray tooltip, icon dot and menu item. */
function startBadge() {
  badge = new DesktopBadge({
    platform: process.platform,
    lang: ownerLang,
    setOverlay: (imgs, description) => {
      if (!win || win.isDestroyed()) return;
      win.setOverlayIcon(imgs ? overlayImage(imgs) : null, imgs ? description : '');
    },
    setBadgeCount: (n) => {
      try {
        app.setBadgeCount(n);
      } catch {
        /* not supported here (e.g. a Linux desktop without a launcher API) */
      }
    },
    setTray: (s) => {
      if (!tray || tray.isDestroyed()) return;
      tray.setToolTip(s.count ? `TeamBot — ${s.text}` : 'TeamBot');
      badgeDot = !!s.count;
      const img = s.count ? trayWithDot() : trayImg;
      if (img) tray.setImage(img);
      refreshTray();
    },
  });
  // Without a window (started hidden at login) the pending approvals are counted here.
  const h = handle;
  if (!h) return;
  const pendingApprovals = () => {
    const o = h.ctx.auth.owner();
    return o ? Number(h.ctx.store.one<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE user_id = ? AND status = 'pending'", o.id)?.n || 0) : 0;
  };
  badge.setFallbackWaiting(pendingApprovals());
  badgeOff = h.ctx.events.subscribe((e) => {
    if (e.type === 'approval.created' || e.type === 'approval.updated') badge?.setFallbackWaiting(pendingApprovals());
  });
}

ipcMain.handle('teambot:openExternal', (_e, url: string) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) return shell.openExternal(url);
});
/** "Werkplek: … Openen" on the bot page: the owner's own bot's folder in Explorer (only from the TeamBot window). */
ipcMain.handle('teambot:openWerkplek', async (e, agentId: string) => {
  fromApp(e);
  const owner = handle?.ctx.auth.owner();
  const a = typeof agentId === 'string' ? handle?.ctx.store.agent(agentId) : null;
  if (!owner || !a || a.user_id !== owner.id || !a.workspace) throw new Error(L('Deze werkplek bestaat niet (meer).'));
  fs.mkdirSync(a.workspace, { recursive: true });
  const err = await shell.openPath(a.workspace);
  if (err) throw new Error(err);
  return true;
});

// macOS: a click on the Dock icon brings the window back (closing it leaves TeamBot running in the menu bar).
app.on('activate', () => {
  if (app.isReady() && handle) show();
});
app.on('second-instance', (_e, argv) => {
  // An installer or uninstaller asks TeamBot to close (build/teambot-close.ps1): close cleanly, helpers included, and
  // never start a downloaded update on the way out (another installer is about to run).
  if (argv.includes('--quit')) {
    forInstaller = true;
    quitting = true;
    app.quit();
    return;
  }
  show();
});
app.on('before-quit', () => {
  quitting = true;
  // "Bewust gestopt" for the watchdog outside the app (0.4.4, P14): Afsluiten, an update, Terug naar versie, a restart.
  // On disk before anything else closes; the next start removes it.
  handle?.ctx.services.health?.markStopped?.(restarting ? 'restart' : rollingBack || updater?.state.phase === 'ready' ? 'update' : 'quit');
});
app.on('window-all-closed', () => {
  /* keep running in the tray */
});
app.on('will-quit', async (e) => {
  badgeOff?.();
  badgeOff = null;
  badge?.stop();
  badge = null;
  dictation?.stop();
  dictation = null;
  power?.dispose();
  presenceOff?.();
  presenceOff = null;
  power = null;
  indicator?.stop();
  indicator = null;
  remoteIndicator?.stop();
  remoteIndicator = null;
  status?.stop();
  status = null;
  if (!handle) return;
  e.preventDefault();
  const h = handle;
  handle = null;
  // A downloaded update is installed on quit (explicit "Opnieuw starten" or a normal quit), but only after a backup:
  // made here, while the database is still open (VACUUM INTO is safe while it runs). No backup, no install.
  let update = !rollingBack && !restarting && !forInstaller && updater?.state.phase === 'ready';
  if (update) {
    const r = await updater!.prepareInstall((o) => h.ctx.services.backups.beforeUpdate(o));
    update = r.ok;
  }
  try {
    await h.close();
  } finally {
    if (rollingBack) {
      // The way back: the pre-update backup goes in place with this version's code (also the data files), then the
      // kept installer of the older version runs; it waits until TeamBot has closed and starts it again.
      try {
        applyPendingRestore(h.ctx.config.dataDir);
      } catch (err: any) {
        h.ctx.log.error('[update] terugzetten vóór het herinstalleren mislukt', err?.message || err);
      }
      const started = await updater!.finishRollback().catch(() => false);
      if (started) installing = true;
      // The installer did not start: TeamBot comes back on this version (it says so at the start), never gone.
      else app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--hidden') });
      app.exit(0);
    } else if (update && updater!.install()) installing = true;
    else {
      // "Opnieuw starten en bijwerken" or an automatic install whose backup failed: TeamBot comes back on this
      // version (it says why), never gone while the owner is away.
      if (installing) app.relaunch({ args: process.argv.slice(1) });
      app.exit(0);
    }
  }
});

app.whenReady().then(async () => {
  // Started at login (--hidden): only the tray. Otherwise the window is there at once, on the start page.
  const hidden = process.argv.includes('--hidden');
  const installed = !hidden && firstStartAfterInstall();
  const opened = Date.now();
  try {
    if (!hidden) await openStartWindow(installed);
    await startServer();
    lockDownSession();
    startAtLoginByDefault();
  } catch (e: any) {
    // desktop/boot.ts writes the log and says it in plain words (with "Opnieuw proberen"); without it, the bare error.
    if (!(app as NodeJS.EventEmitter).emit('teambot:start-failed', e)) {
      dialog.showErrorBox(L('TeamBot kon niet starten'), String(e?.stack || e?.message || e));
      app.exit(1);
    }
    return;
  }
  startShell();
  (app as NodeJS.EventEmitter).emit('teambot:started');
  if (hidden) return;
  // Right after installing, "TeamBot is geïnstalleerd" stays long enough to read (the server is usually faster).
  if (installed) await new Promise((r) => setTimeout(r, Math.max(0, 1800 - (Date.now() - opened))));
  if (win && !win.isDestroyed()) loadApp();
  else createWindow();
});

/**
 * Everything of the shell around the window, once the server runs. Nothing here may keep the owner from the interface:
 * a part that fails (updates, tray, status window, dictation …) is logged and the rest goes on.
 */
function startShell() {
  const part = (name: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      handle?.ctx.log.error(`[desktop] onderdeel "${name}" kon niet starten`, e);
    }
  };
  part('updates', () => {
    updater = new Updater(
      () => {
        refreshTray();
        sendUpdateState();
      },
      L,
      // What runs on the server holds an automatic install back (never in the middle of a task).
      { dataDir: handle?.ctx.config.dataDir, busy: () => (handle ? updateBlockers(handle.ctx) : null) },
    );
    // An automatic install (nothing runs, owner away, or "Nu bijwerken") and the test mode (TEAMBOT_UPDATE_TEST=1) go
    // through quit, so the backup comes first.
    updater.requestQuit = () => void installUpdate();
    startAppUpdate(updater);
  });
  part('systeemvak', buildTray);
  part('teller', startBadge);
  part('taal en kleur', () => {
    // The owner switched the interface language (on any device): tray menu and badge text follow at once.
    const rememberLang = () => {
      if (readShellState(app.getPath('userData')).lang !== ownerLang()) writeShellState(app.getPath('userData'), { lang: ownerLang() });
    };
    rememberLang();
    // The owner's accent colour (on any device): window, taskbar and tray icon follow at once, and at the next start.
    applyAccentIcon();
    handle?.ctx.events.on('settings.updated', () => {
      refreshTray();
      badge?.refresh();
      rememberLang();
      applyAccentIcon();
    });
  });
  // "Houd de pc wakker terwijl routines of taken lopen" (Instellingen › Algemeen; off until turned on).
  part('wakker houden', () => {
    if (handle) power = attachPowerBlocker(handle, () => refreshTray());
  });
  part('aanwijzers en statusvenster', startIndicators);
  part('systeemvak', () => refreshTray());
  part('updates', () => updater?.start());
}

function startIndicators() {
  // computer use on this desktop: on-screen indicator, global emergency-stop hotkey, tray items
  let trayKey = '';
  indicator = new DesktopIndicator(
    () => {
      // the emergency stop (hotkey, tray) also ends remote desktop while someone watches, and switches it off
      const d = handle?.ctx.services.computers?.desktop;
      return d ? { ...d, stop: (source?: string) => (remoteIndicator?.count && remoteIndicator.stopNow(source || 'sneltoets'), d.stop(source)) } : null;
    },
    () => {
      const s = indicator?.state;
      const k = `${!!s?.active}|${!!s?.paused}|${s?.agentName || ''}|${indicator?.hotkey || ''}`;
      if (k !== trayKey) {
        trayKey = k;
        refreshTray();
      }
    },
  );
  indicator.start();
  // remote desktop from the phone: the bar with "Stop" while anyone watches; without it the server refuses sessions
  remoteIndicator = new RemoteIndicator(() => handle?.ctx.services.remoteDesktop || null, ownerLang, () => refreshTray(), L);
  remoteIndicator.start();
  // Windows notifications with buttons + the optional floating status window.
  status = new DesktopStatus({
    handle: () => handle,
    baseUrl: () => baseUrl,
    icon: iconPath,
    preload: path.join(here, 'preload.cjs'),
    show,
    isAppUrl,
    mainFocused: () => !!win && !win.isDestroyed() && win.isVisible() && win.isFocused(),
    onModeChange: () => refreshTray(),
  });
  status.start();
  // At the pc only Windows notifications; the phone gets them once you are away (0.4.4, P8).
  if (handle) presenceOff = attachPresence(handle);
  // Dictate into any program with a global key combination (Instellingen › Spraak; off until turned on).
  dictation = startDictationHotkey({ ctx: () => handle?.ctx || null, preload: path.join(here, 'dictation-preload.cjs'), userData: app.getPath('userData') });
}
