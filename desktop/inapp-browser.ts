/**
 * The bot browsers inside the TeamBot app itself (0.4.5). Each bot browser is a set of tabs; each tab is an offscreen
 * BrowserWindow (rendered off screen, never shown) with the bot profile's own Electron session (cookies, storage and
 * cache in the profile's folder) and the PolicyProxy as its only way out. Playwright drives it over CDP exactly as it
 * drives an installed Edge or Chrome: this file is the browser end of that connection (connectOverCDP with an
 * in-process transport, so no debugging port is opened), built on each tab's own `webContents.debugger`.
 *
 * Nothing appears on the screen: offscreen tabs, no JavaScript or print dialogs, no file pickers (Playwright sets
 * files directly), downloads always saved where TeamBot says (or cancelled), no permissions, muted audio. Only a
 * takeover "in een zichtbaar venster" (headed) opens real windows, with the same session, so logins carry over.
 *
 * What Playwright needs at the browser level (Browser.*, Target.*, Storage.*) is answered here; page commands go to the
 * tab's debugger unchanged. A page target's id is its main frame id (Playwright looks frames up by target id).
 */
import { app, BrowserWindow, session as electronSession, type DownloadItem, type Session, type WebContents } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { InAppHost, InAppLaunchOptions, InAppTransport } from '../server/modules/browser/inapp.js';
import { cleanUserAgent, fromCdpCookie, toCdpCookie } from './inapp-helpers.js';

const sid = () => crypto.randomBytes(16).toString('hex').toUpperCase();

interface Target {
  /** = the main frame id */
  id: string;
  win: BrowserWindow;
  wc: WebContents;
  /** Playwright's session for this page */
  session: string;
  /** sessions of context.newCDPSession(page) (the live view's screencast), sharing the tab's debugger */
  extra: Set<string>;
  openerId?: string;
  gone: boolean;
}

/** Tabs per webContents id, for the session-wide handlers (downloads) that only know the webContents. */
const owners = new Map<number, InAppBrowser>();
/** Sessions that already have TeamBot's handlers (a profile's session lives as long as the app). */
const prepared = new WeakSet<Session>();

function prepareSession(ses: Session) {
  if (prepared.has(ses)) return;
  prepared.add(ses);
  // A bot page never gets the camera, microphone, location, notifications, USB, … and never opens other programs.
  ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.setSpellCheckerEnabled(false);
  // Files of this computer are never opened in a bot tab (the navigation checks block them too).
  ses.webRequest.onBeforeRequest({ urls: ['file://*/*'] }, (_d, cb) => cb({ cancel: true }));
  ses.on('will-download', (_e, item, wc) => {
    const b = wc ? owners.get(wc.id) : undefined;
    if (!b) return item.cancel();
    b.download(item, wc!);
  });
}

class InAppBrowser implements InAppTransport {
  onmessage?: (message: object) => void;
  onclose?: (reason?: string) => void;
  private ses!: Session;
  private ua = '';
  private targets = new Map<string, Target>();
  private sessions = new Map<string, Target>();
  /** child sessions (out-of-process iframes, workers) the tabs' debuggers attached to */
  private children = new Map<string, Target>();
  private browserSessions = new Set<string>();
  private downloads = new Map<string, DownloadItem>();
  private downloadTo: { allow: boolean; dir: string } = { allow: false, dir: '' };
  private outbox: object[] = [];
  private flushing = false;
  private closed = false;
  private hadTarget = false;

  constructor(private o: InAppLaunchOptions, private icon?: string) {}

  async init() {
    fs.mkdirSync(this.o.storageDir, { recursive: true });
    this.ses = electronSession.fromPath(this.o.storageDir);
    prepareSession(this.ses);
    const p = this.o.proxy;
    await this.ses.setProxy(p ? { proxyRules: p.server, proxyBypassRules: p.bypass || '<-loopback>' } : { mode: 'direct' });
    // Connections of an earlier run of this profile (another proxy login) are not reused.
    await this.ses.closeAllConnections().catch(() => {});
    this.ua = cleanUserAgent(this.ses.getUserAgent());
    this.ses.setUserAgent(this.ua, this.o.locale ? `${this.o.locale},${this.o.locale.split('-')[0]}` : undefined);
  }

  // ---------------- transport (Playwright side) ----------------

  send(message: any) {
    if (this.closed) return;
    const { id, method, params = {}, sessionId } = message || {};
    this.dispatch(String(method || ''), params, sessionId).then(
      (result) => this.emit({ id, ...(sessionId ? { sessionId } : {}), result: result ?? {} }),
      (e) => this.emit({ id, ...(sessionId ? { sessionId } : {}), error: { code: -32000, message: String(e?.message || e) } }),
    );
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const d of this.downloads.values()) d.cancel();
    this.downloads.clear();
    for (const t of [...this.targets.values()]) this.destroy(t);
    setImmediate(() => this.onclose?.());
  }

  memoryKb(): number {
    const pids = new Set<number>();
    for (const t of this.targets.values()) {
      try {
        if (!t.wc.isDestroyed()) pids.add(t.wc.getOSProcessId());
      } catch {
        /* gone */
      }
    }
    let kb = 0;
    for (const m of app.getAppMetrics()) if (pids.has(m.pid)) kb += m.memory.workingSetSize || 0;
    return kb;
  }

  visible(): boolean {
    return [...this.targets.values()].some((t) => !t.win.isDestroyed() && t.win.isVisible());
  }

  /** Messages go out in order, never inside send() itself (as over a socket). */
  private emit(m: object) {
    if (this.closed && !('id' in m)) return;
    this.outbox.push(m);
    if (this.flushing) return;
    this.flushing = true;
    setImmediate(() => {
      this.flushing = false;
      const batch = this.outbox.splice(0);
      for (const x of batch) this.onmessage?.(x);
    });
  }

  private async dispatch(method: string, params: any, sessionId?: string): Promise<any> {
    if (!sessionId || this.browserSessions.has(sessionId)) return this.browserCommand(method, params, sessionId);
    const t = this.sessions.get(sessionId);
    if (t) return t.wc.debugger.sendCommand(method, params);
    const c = this.children.get(sessionId);
    if (c) return c.wc.debugger.sendCommand(method, params, sessionId);
    throw new Error(`cdp:no-session ${sessionId}`);
  }

  private info(t: Target) {
    let url = 'about:blank';
    let title = '';
    try {
      url = t.wc.getURL() || 'about:blank';
      title = t.wc.getTitle() || '';
    } catch {
      /* gone */
    }
    return { targetId: t.id, type: 'page', title, url, attached: true, canAccessOpener: false, browserContextId: 'teambot-app', ...(t.openerId ? { openerId: t.openerId } : {}) };
  }

  private async browserCommand(method: string, params: any, sessionId?: string): Promise<any> {
    switch (method) {
      case 'Browser.getVersion':
        return { protocolVersion: '1.3', product: `Chrome/${process.versions.chrome}`, revision: '', userAgent: this.ua, jsVersion: process.versions.v8 };
      case 'Browser.close':
        this.close();
        return {};
      case 'Browser.setDownloadBehavior':
        this.downloadTo = { allow: params.behavior === 'allow' || params.behavior === 'allowAndName', dir: String(params.downloadPath || '') };
        return {};
      case 'Browser.cancelDownload':
        this.downloads.get(String(params.guid))?.cancel();
        return {};
      case 'Browser.grantPermissions':
      case 'Browser.resetPermissions':
      case 'Browser.setPermission':
      case 'Browser.setWindowBounds':
      case 'Target.setDiscoverTargets':
      case 'Target.activateTarget':
        return {};
      case 'Browser.getWindowForTarget':
        return { windowId: 1, bounds: { left: 0, top: 0, width: this.o.viewport.width, height: this.o.viewport.height, windowState: 'normal' } };
      case 'Target.setAutoAttach':
        // Playwright attaches to every tab; tabs that exist already are announced now
        for (const t of this.targets.values()) this.announce(t);
        return {};
      case 'Target.getTargetInfo': {
        const t = params.targetId ? this.targets.get(params.targetId) : null;
        if (t) return { targetInfo: this.info(t) };
        return { targetInfo: { targetId: 'teambot-browser', type: 'browser', title: '', url: '', attached: true, canAccessOpener: false } };
      }
      case 'Target.getTargets':
        return { targetInfos: [...this.targets.values()].map((t) => this.info(t)) };
      case 'Target.getBrowserContexts':
        return { browserContextIds: [] };
      case 'Target.createTarget': {
        const t = await this.openTab(typeof params.url === 'string' ? params.url : 'about:blank');
        return { targetId: t.id };
      }
      case 'Target.closeTarget': {
        const t = this.targets.get(String(params.targetId));
        if (!t) return { success: false };
        this.destroy(t);
        return { success: true };
      }
      case 'Target.attachToTarget': {
        const t = this.targets.get(String(params.targetId));
        if (!t) throw new Error('cdp:no-target');
        const s = sid();
        this.sessions.set(s, t);
        t.extra.add(s);
        return { sessionId: s };
      }
      case 'Target.attachToBrowserTarget': {
        const s = sid();
        this.browserSessions.add(s);
        return { sessionId: s };
      }
      case 'Target.detachFromTarget': {
        const s = String(params.sessionId || '');
        const t = this.sessions.get(s);
        if (t && t.session !== s) {
          t.extra.delete(s);
          this.sessions.delete(s);
        }
        this.browserSessions.delete(s);
        this.emit({ method: 'Target.detachedFromTarget', params: { sessionId: s }, ...(sessionId ? { sessionId } : {}) });
        return {};
      }
      case 'Storage.getCookies':
        return { cookies: (await this.ses.cookies.get({})).map(toCdpCookie) };
      case 'Storage.setCookies':
        for (const c of Array.isArray(params.cookies) ? params.cookies : []) await this.ses.cookies.set(fromCdpCookie(c)).catch(() => {});
        return {};
      case 'Storage.clearCookies':
        await this.ses.clearStorageData({ storages: ['cookies'] });
        return {};
      default:
        throw new Error(`'${method}' wasn't found`);
    }
  }

  // ---------------- tabs ----------------

  private announce(t: Target) {
    this.emit({ method: 'Target.attachedToTarget', params: { sessionId: t.session, targetInfo: this.info(t), waitingForDebugger: false } });
  }

  private async openTab(url: string, openerId?: string): Promise<Target> {
    if (this.closed) throw new Error('cdp:browser-closed');
    const headed = this.o.headed;
    const win = new BrowserWindow({
      show: headed,
      width: this.o.viewport.width,
      height: this.o.viewport.height,
      useContentSize: true,
      title: this.o.title || 'TeamBot',
      ...(this.icon ? { icon: this.icon } : {}),
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      // an invisible tab is never in the taskbar, Alt+Tab or focus
      ...(headed ? {} : { skipTaskbar: true, focusable: false }),
      webPreferences: {
        session: this.ses,
        offscreen: !headed,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
        disableDialogs: true,
        spellcheck: false,
        // never TeamBot's own preload: a bot page has no bridge to TeamBot
      },
    });
    const wc = win.webContents;
    owners.set(wc.id, this);
    if (!headed) {
      wc.setFrameRate(10);
      wc.setAudioMuted(true);
    }
    wc.setWindowOpenHandler(({ url: u }) => {
      // a popup or target=_blank becomes a tab of this browser (Playwright sees it as a new page)
      if (/^(https?:|about:blank)/i.test(u)) void this.openTab(u, t?.id).catch(() => {});
      return { action: 'deny' };
    });
    wc.on('will-prevent-unload', (e) => e.preventDefault());
    wc.on('login', (e, _details, auth, cb) => {
      const p = this.o.proxy;
      if (!auth.isProxy || !p) return; // a site's own login prompt: cancelled (no dialog)
      e.preventDefault();
      cb(p.username, p.password);
    });
    // eslint-disable-next-line prefer-const
    let t: Target | undefined;
    try {
      await wc.loadURL('about:blank');
      wc.debugger.attach('1.3');
      const tree: any = await wc.debugger.sendCommand('Page.getFrameTree');
      await wc.debugger.sendCommand('Page.enable');
      // a file picker would be a window on the owner's screen; Playwright sets files without one
      await wc.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => {});
      await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: 'window.print = function () {};' }).catch(() => {});
      t = { id: String(tree.frameTree.frame.id), win, wc, session: sid(), extra: new Set(), openerId, gone: false };
    } catch (e) {
      owners.delete(wc.id);
      if (!win.isDestroyed()) win.destroy();
      throw e;
    }
    const tab = t;
    this.targets.set(tab.id, tab);
    this.sessions.set(tab.session, tab);
    this.hadTarget = true;
    wc.debugger.on('message', (_e, method, params, child) => this.fromTab(tab, method, params, child));
    wc.debugger.on('detach', () => this.gone(tab));
    win.on('closed', () => this.gone(tab));
    this.announce(tab);
    if (url && url !== 'about:blank') wc.loadURL(url).catch(() => {});
    return tab;
  }

  /** An event of a tab's debugger, to Playwright's session (and the live view's) or to a child session. */
  private fromTab(t: Target, method: string, params: any, child?: string) {
    if (method === 'Target.attachedToTarget' && params?.sessionId) this.children.set(String(params.sessionId), t);
    if (method === 'Target.detachedFromTarget' && params?.sessionId) this.children.delete(String(params.sessionId));
    if (child) return this.emit({ method, params, sessionId: child });
    this.emit({ method, params, sessionId: t.session });
    for (const x of t.extra) this.emit({ method, params, sessionId: x });
  }

  private destroy(t: Target) {
    if (!t.win.isDestroyed()) t.win.destroy();
    this.gone(t);
  }

  /** A tab closed (by Playwright, the page itself, the owner's window or a crash). */
  private gone(t: Target) {
    if (t.gone) return;
    t.gone = true;
    try {
      owners.delete(t.wc.id);
    } catch {
      /* destroyed */
    }
    this.targets.delete(t.id);
    for (const s of [t.session, ...t.extra]) this.sessions.delete(s);
    for (const [s, x] of [...this.children]) if (x === t) this.children.delete(s);
    try {
      if (!t.wc.isDestroyed() && t.wc.debugger.isAttached()) t.wc.debugger.detach();
    } catch {
      /* gone */
    }
    if (!t.win.isDestroyed()) t.win.destroy();
    this.emit({ method: 'Target.detachedFromTarget', params: { sessionId: t.session, targetId: t.id } });
    for (const x of t.extra) this.emit({ method: 'Target.detachedFromTarget', params: { sessionId: x } });
    // Like a browser whose last window closed (the owner closed the visible window): the browser ends.
    if (!this.closed && this.hadTarget && !this.targets.size) setTimeout(() => !this.targets.size && this.close(), 500);
  }

  /** A download of one of the tabs: saved where Playwright said (then TeamBot moves it), or cancelled. Never a dialog. */
  download(item: DownloadItem, wc: WebContents) {
    const t = [...this.targets.values()].find((x) => x.wc === wc);
    if (!t || !this.downloadTo.allow || !this.downloadTo.dir) return item.cancel();
    const guid = crypto.randomUUID();
    fs.mkdirSync(this.downloadTo.dir, { recursive: true });
    item.setSavePath(path.join(this.downloadTo.dir, guid));
    this.downloads.set(guid, item);
    this.emit({ method: 'Browser.downloadWillBegin', params: { frameId: t.id, guid, url: item.getURL(), suggestedFilename: item.getFilename() } });
    item.on('done', (_e, state) => {
      this.downloads.delete(guid);
      this.emit({ method: 'Browser.downloadProgress', params: { guid, state: state === 'completed' ? 'completed' : 'canceled', totalBytes: item.getTotalBytes(), receivedBytes: item.getReceivedBytes() } });
    });
  }
}

/** The in-app browser host for the server (server/modules/browser/inapp.ts). */
export function createInAppBrowserHost(o: { icon?: () => string | undefined } = {}): InAppHost {
  return {
    async open(opts) {
      const b = new InAppBrowser(opts, o.icon?.());
      await b.init();
      return b;
    },
    async forget(storageDir) {
      if (!fs.existsSync(storageDir)) return;
      const ses = electronSession.fromPath(storageDir);
      await ses.clearStorageData().catch(() => {});
      await ses.clearCache().catch(() => {});
    },
  };
}
