import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, CDPSession, Page } from 'playwright-core';
import { hostMatches, type UrlPolicy } from './policy.js';
import { PolicyProxy } from './proxy.js';
import type { UpstreamProxy } from '../network/proxy.js';
import type { BrowserInfo } from './capabilities.js';
import { SENSITIVE_SELECTOR } from './pagescripts.js';
import { connectInApp, inAppStorageDir, type BrowserEngine, type InAppHost, type InAppTransport } from './inapp.js';

/**
 * One browser per browser profile, never the user's own browser profile. In the desktop app it lives inside TeamBot
 * itself (invisible tabs, inapp.ts); otherwise an installed Edge/Chrome is launched with Playwright's persistent
 * context in TeamBot's data folder. All traffic goes through the PolicyProxy. Invisible (headless) by default; can be
 * relaunched as a visible window for takeover/login.
 */

export const VIEWPORT = { width: 1280, height: 800 };

export interface BrowserLimits {
  maxTabs: number;
  navTimeoutMs: number;
  actionTimeoutMs: number;
  idleMs: number;
  maxPerUser: number;
  maxTotal: number;
}

export const DEFAULT_BROWSER_LIMITS: BrowserLimits = {
  maxTabs: 8,
  navTimeoutMs: 30_000,
  actionTimeoutMs: 10_000,
  idleMs: 10 * 60_000,
  maxPerUser: 3,
  maxTotal: Number(process.env.TEAMBOT_MAX_BROWSERS) || 6,
};

export type Launcher = (userDataDir: string, options: any) => Promise<BrowserContext>;

export const playwrightLauncher: Launcher = async (dir, options) => {
  const { chromium } = await import('playwright-core');
  return chromium.launchPersistentContext(dir, options);
};

export interface SessionOpts {
  key: string;
  userId: string;
  profileId: string;
  profileDir: string;
  policy: () => UrlPolicy;
  /** This profile's own proxy (asked per request, so a change applies to new connections at once); null = none. */
  upstream?: () => UpstreamProxy | null;
  headed?: boolean;
  /** the active tab, its address or the tab list changed (address bar / tab list in the UI) */
  onChange?: () => void;
  /** title of a visible window of an in-app browser (takeover) */
  title?: string;
}

/**
 * Throttles live frames to viewers without ever losing the last one. Chromium's screencast only sends a frame when the
 * page repaints, so a plain "drop if too soon" throttle can drop the final frame of a navigation and leave the live view
 * on the previous page until something repaints again. Here a frame that comes too soon is kept and delivered at the
 * end of the gap (newer frames replace it), so viewers always end on the latest picture.
 */
export class FramePacer {
  private last = 0;
  private pending: Buffer | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private gapMs: number,
    private deliver: (buf: Buffer) => void,
  ) {}

  push(buf: Buffer) {
    const wait = this.last + this.gapMs - Date.now();
    if (wait <= 0 && !this.timer) {
      this.last = Date.now();
      this.deliver(buf);
      return;
    }
    this.pending = buf;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), Math.max(0, wait));
    this.timer.unref?.();
  }

  private flush() {
    this.timer = null;
    const b = this.pending;
    this.pending = null;
    if (!b) return;
    this.last = Date.now();
    this.deliver(b);
  }

  clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }
}

export class BrowserSession {
  context!: BrowserContext;
  active!: Page;
  headed = false;
  /** inside TeamBot ("app") or an installed Edge/Chrome ("external") */
  engine: BrowserEngine = 'external';
  /** the in-app browser behind this session (engine "app") */
  inApp: InAppTransport | null = null;
  createdAt = Date.now();
  lastUsed = Date.now();
  closed = false;
  closing = false;
  dialogs: string[] = [];
  blocked: { url: string; reason: string; at: number }[] = [];
  expectDownload = 0;
  proxyUser = '';
  viewers = new Set<(jpeg: Buffer) => void>();
  latestFrame: Buffer | null = null;
  /** > 0 while TeamBot fills a vault login: no live frames, no screenshots (the fields are masked as well) */
  privacy = 0;
  /** vault values used in this browser: scrubbed from every tool result and logged URL (in memory only) */
  readonly scrub = new Set<string>();
  /** last known title per tab (Playwright's page.title() is async; the status is not) */
  readonly titles = new WeakMap<Page, string>();
  private cdp: CDPSession | null = null;
  private cdpPage: Page | null = null;
  /** max ~5 fps to the viewers, but the last frame of a burst is always delivered (see FramePacer) */
  private pacer = new FramePacer(200, (buf) => {
    if (this.privacy || this.closed) return;
    this.latestFrame = buf;
    for (const v of this.viewers) v(buf);
  });
  /** called once when the session ends (streams, waiters) */
  closeHandlers = new Set<() => void>();

  fireClosed() {
    for (const h of [...this.closeHandlers]) {
      try {
        h();
      } catch {
        /* ignore */
      }
    }
    this.closeHandlers.clear();
  }

  constructor(public opts: SessionOpts, public limits: BrowserLimits) {}

  get key() {
    return this.opts.key;
  }

  /** Memory of this browser's own processes in MB (in-app browsers; null when TeamBot cannot tell). */
  memoryMb(): number | null {
    if (!this.inApp || this.closed) return null;
    try {
      return Math.round(this.inApp.memoryKb() / 1024);
    } catch {
      return null;
    }
  }

  pages(): Page[] {
    return this.context.pages().filter((p) => !p.isClosed());
  }

  touch() {
    this.lastUsed = Date.now();
  }

  attach(page: Page) {
    page.setDefaultTimeout(this.limits.actionTimeoutMs);
    page.setDefaultNavigationTimeout(this.limits.navTimeoutMs);
    page.on('dialog', (d) => {
      this.dialogs.push(`${d.type()}: ${d.message().slice(0, 300)}`);
      if (this.dialogs.length > 20) this.dialogs.shift();
      d.dismiss().catch(() => {});
    });
    page.on('download', (d) => {
      if (this.expectDownload > 0) return;
      this.blocked.push({ url: d.url(), reason: 'Download zonder browser_download geblokkeerd', at: Date.now() });
      d.cancel().catch(() => {});
    });
    page.on('framenavigated', (f) => {
      if (f !== page.mainFrame()) return;
      const url = f.url();
      const bad = navigationViolation(url, this.opts.policy());
      if (bad) {
        this.blocked.push({ url, reason: bad, at: Date.now() });
        page.goto('about:blank').catch(() => {});
      }
      this.changed();
    });
    const title = () => {
      page
        .title()
        .then((t) => {
          if (this.titles.get(page) === t) return;
          this.titles.set(page, t);
          this.changed();
        })
        .catch(() => {});
    };
    page.on('domcontentloaded', title);
    page.on('load', title);
    page.on('close', () => {
      if (this.active === page && !this.closed) {
        const rest = this.pages();
        if (rest.length) this.setActive(rest[rest.length - 1]);
      }
      this.changed();
    });
  }

  setActive(p: Page) {
    const was = this.active;
    this.active = p;
    if (this.viewers.size) this.startScreencast().catch(() => {});
    if (was && was !== p) this.changed();
  }

  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Debounced: navigation events come in bursts (redirects, iframes, title). */
  changed() {
    if (this.closed || !this.opts.onChange || this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      if (!this.closed) this.opts.onChange?.();
    }, 250);
    this.changeTimer.unref?.();
  }

  /** Replace vault values that may have ended up in a URL or page text. */
  clean(text: string): string {
    if (!this.scrub.size) return text;
    let t = String(text ?? '');
    for (const v of [...this.scrub].sort((a, b) => b.length - a.length)) if (v.length >= 4) t = t.split(v).join('[verborgen]');
    return t;
  }

  /** Tabs with their last known titles, for the browser panel. */
  tabs(): { index: number; url: string; title: string; active: boolean }[] {
    return this.pages().map((p, index) => ({ index, url: this.clean(p.url()), title: this.clean(this.titles.get(p) || ''), active: p === this.active }));
  }

  /** Drain blocked-request and dialog notes for the next tool result. */
  takeNotes(): string[] {
    const out: string[] = [];
    for (const b of this.blocked.splice(0)) out.push(`Geblokkeerd: ${b.url.slice(0, 160)} — ${b.reason}`);
    for (const d of this.dialogs.splice(0)) out.push(`Dialoogvenster automatisch gesloten (${d})`);
    return out;
  }

  // ---------- live preview ----------

  subscribe(fn: (jpeg: Buffer) => void): () => void {
    this.viewers.add(fn);
    // the last known frame right away (fast first paint), then a fresh one: the page may have changed while nobody
    // watched (no screencast then), and a static page sends no new screencast frames by itself
    if (this.latestFrame) fn(this.latestFrame);
    this.frame()
      .then((b) => b && this.viewers.has(fn) && fn(b))
      .catch(() => {});
    this.startScreencast().catch(() => {});
    return () => {
      this.viewers.delete(fn);
      if (!this.viewers.size) this.stopScreencast().catch(() => {});
    };
  }

  async startScreencast() {
    if (this.closed || !this.active) return;
    if (this.cdp && this.cdpPage === this.active) return;
    await this.stopScreencast();
    const page = this.active;
    const cdp = await this.context.newCDPSession(page);
    this.cdp = cdp;
    this.cdpPage = page;
    cdp.on('Page.screencastFrame', (f: any) => {
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      if (this.privacy) return; // TeamBot is filling a vault login right now
      if (this.cdp !== cdp) return; // a frame of a tab we no longer show
      this.pacer.push(Buffer.from(f.data, 'base64'));
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 1 });
  }

  async stopScreencast() {
    const cdp = this.cdp;
    this.cdp = null;
    this.cdpPage = null;
    this.pacer.clear();
    if (!cdp) return;
    await cdp.send('Page.stopScreencast').catch(() => {});
    await cdp.detach().catch(() => {});
  }

  /** Send viewers a fresh (masked) frame, e.g. after a vault fill: a static page sends no new screencast frames. */
  async pushFrame() {
    if (!this.viewers.size) return;
    const b = await this.frame(55);
    if (b) this.pacer.push(b);
  }

  /** A fresh JPEG of the active tab (password fields masked). */
  async frame(quality = 50): Promise<Buffer | null> {
    if (this.closed || !this.active || this.active.isClosed() || this.privacy) return null;
    try {
      const buf = await this.active.screenshot({ type: 'jpeg', quality, mask: [this.active.locator(SENSITIVE_SELECTOR)], maskColor: '#000000', timeout: 5000 });
      this.latestFrame = buf;
      return buf;
    } catch {
      return null;
    }
  }
}

/** Allowlist check for the top-level page (redirect hops are not visible to request routing). */
export function navigationViolation(url: string, policy: UrlPolicy): string | null {
  if (!url || url === 'about:blank') return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'Ongeldige URL';
  }
  if (u.protocol === 'chrome-error:') return null;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `Protocol ${u.protocol} is niet toegestaan`;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (policy.deny.some((r) => hostMatches(host, r))) return `${host} staat op de blokkeerlijst van deze bot`;
  if (policy.allow.length && !policy.allow.some((r) => hostMatches(host, r))) return `${host} staat niet op de lijst met toegestane domeinen`;
  return null;
}

export class BrowserManager {
  sessions = new Map<string, BrowserSession>();
  private launching = new Map<string, Promise<BrowserSession>>();
  readonly proxy: PolicyProxy;
  launches = 0;

  constructor(
    private o: {
      findBrowser: () => Promise<BrowserInfo | null>;
      launcher?: Launcher;
      limits?: Partial<BrowserLimits>;
      sandbox?: boolean;
      proxy?: PolicyProxy;
      /** the browser inside TeamBot (desktop app), when there is one */
      inApp?: () => InAppHost | null;
      /** which engine a profile's browser uses ("app" when possible, unless the owner chose Edge/Chrome) */
      engine?: (opts: SessionOpts) => BrowserEngine;
      onClosed?: (s: BrowserSession, unexpected: boolean) => void;
    },
  ) {
    this.proxy = o.proxy || new PolicyProxy();
  }

  get limits(): BrowserLimits {
    return { ...DEFAULT_BROWSER_LIMITS, ...(this.o.limits || {}) };
  }

  get(key: string): BrowserSession | null {
    const s = this.sessions.get(key);
    return s && !s.closed ? s : null;
  }

  forUser(userId: string): BrowserSession[] {
    return [...this.sessions.values()].filter((s) => !s.closed && s.opts.userId === userId);
  }

  async ensure(opts: SessionOpts): Promise<BrowserSession> {
    const cur = this.get(opts.key);
    if (cur && !cur.closing) {
      cur.touch();
      return cur;
    }
    const pending = this.launching.get(opts.key);
    if (pending) return pending;
    const p = this.launch(opts).finally(() => this.launching.delete(opts.key));
    this.launching.set(opts.key, p);
    return p;
  }

  private async launch(opts: SessionOpts, restoreUrls: string[] = []): Promise<BrowserSession> {
    const limits = this.limits;
    const mine = this.forUser(opts.userId).length;
    if (mine >= limits.maxPerUser) throw new Error(`Je hebt al ${mine} bot-browsers open (maximum ${limits.maxPerUser}). Sluit er een op de pagina Computers.`);
    const open = [...this.sessions.values()].filter((s) => !s.closed).length;
    if (open >= limits.maxTotal) throw new Error(`Deze server heeft het maximum van ${limits.maxTotal} bot-browsers bereikt. Probeer het later opnieuw.`);
    // Inside TeamBot, unless the owner chose Edge/Chrome and one is installed; a test launcher always goes its own way.
    const host = this.o.launcher ? null : this.o.inApp?.() || null;
    const want: BrowserEngine = host ? (this.o.engine?.(opts) ?? 'app') : 'external';
    const browser = want === 'external' ? await this.o.findBrowser() : null;
    const engine: BrowserEngine = host && (want === 'app' || !browser) ? 'app' : 'external';
    if (engine === 'external' && !browser) throw new Error('Geen browser gevonden: installeer Microsoft Edge of Google Chrome (of zet TEAMBOT_BROWSER_PATH).');
    await this.proxy.start();
    const s = new BrowserSession(opts, limits);
    const creds = this.proxy.register({
      policy: opts.policy,
      upstream: opts.upstream,
      onBlock: (url, reason) => {
        s.blocked.push({ url, reason, at: Date.now() });
        if (s.blocked.length > 30) s.blocked.shift();
      },
    });
    s.proxyUser = creds.username;
    fs.mkdirSync(opts.profileDir, { recursive: true });
    this.launches++;
    let context: BrowserContext;
    try {
      if (engine === 'app') {
        const r = await connectInApp(host!, {
          storageDir: inAppStorageDir(opts.profileDir),
          proxy: { server: `http://127.0.0.1:${this.proxy.port}`, bypass: '<-loopback>', username: creds.username, password: creds.password },
          headed: !!opts.headed,
          viewport: VIEWPORT,
          locale: 'nl-NL',
          title: opts.title,
        });
        context = r.context;
        s.inApp = r.transport;
      } else {
        context = await (this.o.launcher || playwrightLauncher)(opts.profileDir, {
          executablePath: browser!.path,
          headless: !opts.headed,
          chromiumSandbox: this.o.sandbox !== false,
          viewport: VIEWPORT,
          acceptDownloads: true,
          serviceWorkers: 'block',
          locale: 'nl-NL',
          timeout: 30_000,
          proxy: { server: `http://127.0.0.1:${this.proxy.port}`, bypass: '<-loopback>', username: creds.username, password: creds.password },
          args: ['--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions', '--disable-background-networking', '--disable-features=Translate,MediaRouter'],
        });
      }
    } catch (e: any) {
      this.proxy.unregister(creds.username);
      const msg = String(e?.message || e);
      if (/ProcessSingleton|profile.*in use|already in use|lock/i.test(msg)) throw new Error('Dit browserprofiel is al geopend door een ander proces. Sluit dat venster en probeer opnieuw.');
      throw new Error(`Browser starten mislukt: ${msg.split('\n')[0].slice(0, 300)}`);
    }
    s.context = context;
    s.headed = !!opts.headed;
    s.engine = engine;
    context.on('page', (p) => {
      s.attach(p);
      if (s.pages().length > limits.maxTabs) {
        p.close().catch(() => {});
        s.blocked.push({ url: p.url(), reason: `Maximum van ${limits.maxTabs} tabbladen bereikt; nieuw tabblad gesloten`, at: Date.now() });
        return;
      }
      s.setActive(p);
      s.changed();
    });
    context.on('close', () => {
      const unexpected = !s.closing;
      s.closed = true;
      this.proxy.unregister(s.proxyUser);
      if (this.sessions.get(s.key) === s) this.sessions.delete(s.key);
      s.fireClosed();
      this.o.onClosed?.(s, unexpected);
    });
    for (const p of context.pages()) s.attach(p);
    s.active = context.pages()[0] || (await context.newPage());
    for (const [i, url] of restoreUrls.entries()) {
      const page = i === 0 ? s.active : await context.newPage();
      await page.goto(url, { timeout: limits.navTimeoutMs }).catch(() => {});
    }
    if (restoreUrls.length) s.active = s.pages()[0];
    this.sessions.set(opts.key, s);
    return s;
  }

  /** Relaunch with the same profile as visible window (takeover) or back to headless. Tabs are reopened by URL. */
  async relaunch(key: string, headed: boolean): Promise<BrowserSession> {
    const cur = this.get(key);
    if (!cur) throw new Error('Deze browser draait niet');
    if (cur.headed === headed) return cur;
    const urls = cur
      .pages()
      .map((p) => p.url())
      .filter((u) => /^https?:/.test(u))
      .slice(0, this.limits.maxTabs);
    const viewers = [...cur.viewers];
    const handlers = [...cur.closeHandlers];
    cur.closeHandlers.clear();
    await this.close(key);
    const s = await this.launch({ ...cur.opts, headed }, urls);
    for (const v of cur.scrub) s.scrub.add(v);
    for (const h of handlers) s.closeHandlers.add(h);
    for (const v of viewers) s.subscribe(v);
    return s;
  }

  async close(key: string) {
    const s = this.sessions.get(key);
    if (!s) return false;
    s.closing = true;
    await s.stopScreencast().catch(() => {});
    await s.context.close().catch(() => {});
    s.closed = true;
    this.sessions.delete(key);
    this.proxy.unregister(s.proxyUser);
    s.fireClosed();
    return true;
  }

  async closeAll() {
    await Promise.all([...this.sessions.keys()].map((k) => this.close(k)));
    await this.proxy.stop();
  }

  /** Remove a profile's folder; its in-app session is emptied first (the app may still hold it open). */
  async removeProfile(dir: string) {
    await this.o
      .inApp?.()
      ?.forget?.(inAppStorageDir(dir))
      .catch(() => {});
    removeProfileDir(dir);
  }

  /** Close sessions that have been idle (and are not watched or controlled). */
  async closeIdle(isBusy: (s: BrowserSession) => boolean): Promise<string[]> {
    const out: string[] = [];
    for (const s of [...this.sessions.values()]) {
      if (s.closed || s.viewers.size || isBusy(s)) continue;
      if (Date.now() - s.lastUsed > s.limits.idleMs) {
        await this.close(s.key);
        out.push(s.key);
      }
    }
    return out;
  }
}

export function removeProfileDir(dir: string) {
  if (!fs.existsSync(dir)) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (e) {
    // An in-app session the app still holds open (emptied first by BrowserManager.removeProfile): everything else
    // goes, the few files the app keeps locked stay until it restarts.
    const app = inAppStorageDir(dir);
    if (!fs.existsSync(app)) throw e;
    for (const n of fs.readdirSync(dir)) if (path.join(dir, n) !== app) fs.rmSync(path.join(dir, n), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    const walk = (d: string) => {
      for (const x of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, x.name);
        try {
          if (x.isDirectory()) walk(f);
          fs.rmSync(f, { recursive: true, force: true });
        } catch {
          /* held open by the app */
        }
      }
    };
    walk(app);
  }
}

export function profileSize(dir: string): number {
  let n = 0;
  const walk = (d: string, depth: number) => {
    if (depth > 12) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f, depth + 1);
      else if (e.isFile()) n += fs.statSync(f, { throwIfNoEntry: false })?.size || 0;
    }
  };
  walk(dir, 0);
  return n;
}
