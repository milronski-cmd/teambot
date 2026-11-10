import path from 'node:path';
import type { BrowserContext } from 'playwright-core';

/**
 * The bot browser inside TeamBot itself (desktop app, 0.4.5): every bot browser is a set of invisible tabs in the
 * TeamBot app (desktop/inapp-browser.ts), one Electron session per browser profile, driven by Playwright over CDP the
 * same way as an installed Edge or Chrome. Nothing appears on the owner's screen unless he opens the live view or
 * takes over in a visible window. No browser to install, no Docker or WSL.
 *
 * The server has no Electron: the desktop shell registers the host before the server starts (setInAppBrowserHost).
 * Without a host (server mode, `npm start`, Docker, tests) the bots use an installed Edge or Chrome as before.
 */

/** What the in-app host needs to open one bot browser. */
export interface InAppLaunchOptions {
  /** Absolute folder for the Electron session of this profile (cookies, storage, cache): the profile's own folder. */
  storageDir: string;
  /** The PolicyProxy every request of this browser goes through (with this session's own login). */
  proxy: { server: string; bypass?: string; username: string; password: string } | null;
  /** A visible window (takeover, logging in) instead of invisible tabs. */
  headed: boolean;
  viewport: { width: number; height: number };
  /** Accept-Language of the bot's browser, e.g. "nl-NL". */
  locale?: string;
  /** Title of a visible window. */
  title?: string;
}

/**
 * The Chrome DevTools Protocol endpoint of one in-app browser, as Playwright's `connectOverCDP(transport)` takes it
 * (playwright-core ConnectOverCDPTransport), plus what TeamBot reads about it.
 */
export interface InAppTransport {
  open?(): void;
  send(message: object): void;
  close(): void;
  onmessage?: (message: object) => void;
  onclose?: (reason?: string) => void;
  /** Memory of this browser's own processes (its tabs' renderers), in KB; 0 when none run. */
  memoryKb(): number;
  /** Is any tab of this browser on the screen right now (a visible window)? */
  visible(): boolean;
}

export interface InAppHost {
  open(o: InAppLaunchOptions): Promise<InAppTransport>;
  /** Empty a profile's in-app session (cookies, storage, cache) before its folder is removed; the app may hold it open. */
  forget?(storageDir: string): Promise<void>;
}

let host: InAppHost | null = null;

/** The desktop shell registers the in-app browser (before createApp); null switches it off again. */
export function setInAppBrowserHost(h: InAppHost | null) {
  host = h;
}

export function inAppBrowserHost(): InAppHost | null {
  return host;
}

/** The engine of the bot browsers: "app" = inside TeamBot (desktop app), "external" = an installed Edge or Chrome. */
export type BrowserEngine = 'app' | 'external';

/** The user setting that picks the engine (Computers › Browser van de bots); default: inside TeamBot when possible. */
export const ENGINE_SETTING = 'browserEngine';

/**
 * Where an in-app browser keeps its Electron session: a subfolder of the profile's folder, apart from Edge's or
 * Chrome's own files there, so wiping, deleting, sizing and backing up a profile cover both engines.
 */
export function inAppStorageDir(profileDir: string): string {
  return path.join(profileDir, 'app');
}

/** Open an in-app browser and connect Playwright to it: the same BrowserContext the tools already drive. */
export async function connectInApp(h: InAppHost, o: InAppLaunchOptions): Promise<{ context: BrowserContext; transport: InAppTransport }> {
  const transport = await h.open(o);
  try {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.connectOverCDP(transport as any, { timeout: 30_000 });
    const context = browser.contexts()[0];
    if (!context) throw new Error('Geen browsercontext');
    return { context, transport };
  } catch (e) {
    try {
      transport.close();
    } catch {
      /* already gone */
    }
    throw e;
  }
}
