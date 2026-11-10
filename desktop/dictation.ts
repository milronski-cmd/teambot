/**
 * Dictate into any program: a global key combination (Instellingen › Spraak, off until the owner turns it on).
 * Hold it and talk (letting go = the text goes where you were typing), or tap it for hands-free and tap again when
 * done; Esc throws the recording away. Works while the TeamBot window is hidden in the tray.
 *
 * The microphone is only open while you dictate (a small pill shows it, with the live text). Recognition is the
 * normal voice engine (free and local by default). The text is pasted with the clipboard + Ctrl+V and the previous
 * clipboard is put back, both kept out of Windows clipboard history and the cloud clipboard; never into a password
 * field (Win32 ES_PASSWORD / UI Automation), never into Windows security prompts. The shell only needs
 * `startDictationHotkey()`; everything else lives here.
 */
import { BrowserWindow, ClipboardItem, clipboard as electronClipboardApi, globalShortcut, ipcMain, screen, session, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../server/core/types.js';
import { DEFAULT_HOTKEY, parseHotkey, type ParsedHotkey } from '../server/modules/voice/hotkey.js';
import { DictationMachine, type InsertResult, type OverlayView, type Recorder, type Target } from './dictation-machine.js';
import { insertText, type InsertDeps } from './dictation-insert.js';
import { dictationClipboard } from './dictation-clipboard.js';
import { DictationHelper } from './dictation-helper.js';
import { OVERLAY_HEIGHT, OVERLAY_HTML, OVERLAY_WIDTH } from './dictation-overlay.js';

export interface DictationOptions {
  ctx: () => Ctx | null;
  /** Built preload for the pill (dist/desktop/dictation-preload.cjs). */
  preload: string;
  /** Folder for the Windows helper script + compiled DLL. */
  helperDir: string;
  /** Tests: only send keys to this process (a dedicated test window). */
  expectPid?: number;
  /** Tests: do not register the global key (drive press()/escape() directly). */
  noGlobalKey?: boolean;
}

export interface DictationStatus {
  enabled: boolean;
  accelerator: string;
  label: string;
  registered: boolean;
  error: string | null;
  /** Hold-to-talk (needs the Windows helper); otherwise tap to start and tap again to finish. */
  hold: boolean;
  /** Can paste into other programs (Windows); elsewhere the text is left on the clipboard. */
  paste: boolean;
  phase: string;
  last: { at: string; chars: number; how: string; seconds: number } | null;
}

const PARTITION = 'teambot-dictation';

export class DictationHotkey {
  private overlay: BrowserWindow | null = null;
  private loaded: Promise<void> | null = null;
  private helper: DictationHelper | null = null;
  private machine: DictationMachine;
  private key: ParsedHotkey = parseHotkey(DEFAULT_HOTKEY)!;
  private enabled = false;
  private registered = false;
  private error: string | null = null;
  private escArmed = false;
  private offSettings: (() => void) | null = null;
  private last: DictationStatus['last'] = null;
  private session: { push(b: Buffer): { text: string }; end(): Promise<{ text: string }>; cancel(): void } | null = null;
  private waiters: { started?: (e?: string) => void; stopped?: () => void } = {};
  private onText: ((t: string) => void) | null = null;
  private onLevel: ((l: number) => void) | null = null;
  private ownerId: string | null = null;

  constructor(private o: DictationOptions) {
    if (DictationHelper.supported()) this.helper = new DictationHelper(o.helperDir);
    this.machine = new DictationMachine({
      recorder: this.recorder(),
      target: this.target(),
      keyWatch: this.helper ? (onRelease) => this.watchRelease(onRelease) : null,
      view: { show: (v) => this.show(v), hide: () => this.hide() },
      armEscape: (on) => this.armEscape(on),
      label: () => this.key.label,
      onDone: (r) => {
        this.last = { at: new Date().toISOString(), chars: r.text.length, how: r.result?.how || 'leeg', seconds: Math.round(r.seconds * 10) / 10 };
      },
    });
  }

  // ---------------- lifecycle ----------------

  start() {
    const ctx = this.o.ctx();
    if (!ctx) return;
    ctx.services.voiceHotkey = { status: () => this.status() };
    this.ownerId = ctx.auth.owner()?.id || null;
    ipcMain.on('dictation:started', this.ipcStarted);
    ipcMain.on('dictation:stopped', this.ipcStopped);
    ipcMain.on('dictation:error', this.ipcError);
    ipcMain.on('dictation:pcm', this.ipcPcm);
    this.offSettings = ctx.events.on('voice.settings.updated', (e) => {
      if (e.userId === this.ownerId) this.apply(e.data?.hotkey);
    });
    const s = this.ownerId ? ctx.services.voice?.settings?.(this.ownerId) : null;
    this.apply(s?.hotkey);
  }

  stop() {
    this.machine.shutdown();
    this.unregister();
    this.offSettings?.();
    this.offSettings = null;
    ipcMain.removeListener('dictation:started', this.ipcStarted);
    ipcMain.removeListener('dictation:stopped', this.ipcStopped);
    ipcMain.removeListener('dictation:error', this.ipcError);
    ipcMain.removeListener('dictation:pcm', this.ipcPcm);
    this.helper?.kill();
    if (this.overlay && !this.overlay.isDestroyed()) this.overlay.destroy();
    this.overlay = null;
    const ctx = this.o.ctx();
    if (ctx?.services.voiceHotkey?.status) delete ctx.services.voiceHotkey;
  }

  status(): DictationStatus {
    return {
      enabled: this.enabled,
      accelerator: this.key.accel,
      label: this.key.label,
      registered: this.registered,
      error: this.error,
      hold: !!this.helper,
      paste: !!this.helper,
      phase: this.machine.phase,
      last: this.last,
    };
  }

  /** Settings changed (or at start): (re)register the key, warm up the helper and the pill. */
  apply(h: { enabled?: boolean; accelerator?: string } | null | undefined) {
    const next = parseHotkey(h?.accelerator) || parseHotkey(DEFAULT_HOTKEY)!;
    const on = !!h?.enabled;
    if (on === this.enabled && next.accel === this.key.accel && (this.registered || !on)) return;
    this.machine.shutdown();
    this.unregister();
    this.enabled = on;
    this.key = next;
    this.error = null;
    if (!on) return;
    if (!this.o.noGlobalKey) {
      try {
        this.registered = globalShortcut.register(next.accel, () => this.machine.press());
      } catch {
        this.registered = false;
      }
      if (!this.registered) this.error = `${next.label} is al in gebruik door een ander programma (of Windows). Kies een andere sneltoets.`;
    } else this.registered = true;
    if (this.registered) {
      this.ensureOverlay();
      void this.helper?.start().catch(() => {});
    }
  }

  private unregister() {
    this.armEscape(false);
    if (this.registered && !this.o.noGlobalKey) {
      try {
        globalShortcut.unregister(this.key.accel);
      } catch {
        /* already gone */
      }
    }
    this.registered = false;
  }

  /** Tests and the settings page: as if the key combination was pressed / Esc. */
  press() {
    this.machine.press();
  }
  escape() {
    this.machine.escape();
  }
  get phase() {
    return this.machine.phase;
  }

  // ---------------- the pill (recording + view) ----------------

  private ensureOverlay(): BrowserWindow {
    if (this.overlay && !this.overlay.isDestroyed()) return this.overlay;
    const ses = session.fromPartition(PARTITION);
    const isPill = (wc: WebContents | null | undefined) => !!wc && !!this.overlay && !this.overlay.isDestroyed() && wc.id === this.overlay.webContents.id;
    // This window may use the microphone (audio only) and nothing else.
    ses.setPermissionRequestHandler((wc, permission, cb, details: any) => cb(permission === 'media' && isPill(wc) && (details?.mediaTypes || ['audio']).every((t: string) => t === 'audio')));
    ses.setPermissionCheckHandler((wc, permission) => permission === 'media' && isPill(wc));
    const w = new BrowserWindow({
      width: OVERLAY_WIDTH,
      height: OVERLAY_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      title: 'TeamBot-dicteren',
      backgroundColor: '#00000000',
      webPreferences: {
        preload: this.o.preload,
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    w.setIgnoreMouseEvents(true);
    w.setAlwaysOnTop(true, 'screen-saver');
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    // A file page, not a data: URL: the microphone API only exists in a secure context (file:// counts, data: not).
    // Written next to the helper script, like the screen helper does; rewritten when the content changed.
    const page = path.join(this.o.helperDir, 'dictation-overlay.html');
    try {
      fs.mkdirSync(this.o.helperDir, { recursive: true });
      if (!fs.existsSync(page) || fs.readFileSync(page, 'utf8') !== OVERLAY_HTML) fs.writeFileSync(page, OVERLAY_HTML, 'utf8');
    } catch {
      /* read-only data folder: the load below reports it */
    }
    this.loaded = w.loadFile(page).catch(() => {});
    w.on('closed', () => {
      if (this.overlay === w) this.overlay = null;
    });
    this.overlay = w;
    return w;
  }

  private send(cmd: string, data?: unknown) {
    const w = this.overlay;
    if (w && !w.isDestroyed()) w.webContents.send('dictation:cmd', cmd, data);
  }

  private show(v: OverlayView) {
    const w = this.ensureOverlay();
    void this.loaded?.then(() => {
      if (w.isDestroyed()) return;
      this.send('view', v);
      if (!w.isVisible()) {
        const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
        w.setBounds({ x: Math.round(d.x + (d.width - OVERLAY_WIDTH) / 2), y: Math.round(d.y + d.height - OVERLAY_HEIGHT - 24), width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT });
        w.showInactive();
      }
    });
  }

  private hide() {
    const w = this.overlay;
    if (w && !w.isDestroyed() && w.isVisible()) w.hide();
  }

  private armEscape(on: boolean) {
    if (on === this.escArmed || this.o.noGlobalKey) return void (this.escArmed = on);
    this.escArmed = on;
    try {
      if (on) globalShortcut.register('Escape', () => this.machine.escape());
      else globalShortcut.unregister('Escape');
    } catch {
      /* Esc taken by another program: the key combination still finishes */
    }
  }

  private fromPill(e: Electron.IpcMainEvent) {
    return !!this.overlay && !this.overlay.isDestroyed() && e.sender.id === this.overlay.webContents.id;
  }
  private ipcStarted = (e: Electron.IpcMainEvent) => {
    if (this.fromPill(e)) this.waiters.started?.();
  };
  private ipcError = (e: Electron.IpcMainEvent, msg: string) => {
    if (this.fromPill(e)) this.waiters.started?.(String(msg || 'Microfoon openen mislukt'));
  };
  private ipcStopped = (e: Electron.IpcMainEvent) => {
    if (this.fromPill(e)) this.waiters.stopped?.();
  };
  private ipcPcm = (e: Electron.IpcMainEvent, buf: ArrayBuffer | Uint8Array, level: number) => {
    if (!this.fromPill(e) || !this.session) return;
    const b = Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
    if (!b.length || b.length > 64_000) return;
    this.onLevel?.(Number(level) || 0);
    try {
      const v = this.session.push(b);
      if (v.text) this.onText?.(v.text);
    } catch {
      /* too long: the machine stops at its own maximum */
    }
  };

  private recorder(): Recorder {
    return {
      start: async (onText, onLevel) => {
        const ctx = this.o.ctx();
        if (!ctx || !this.ownerId) throw new Error('TeamBot is nog niet gestart');
        this.session = ctx.services.voice.openDictation(this.ownerId);
        this.onText = onText;
        this.onLevel = onLevel;
        this.ensureOverlay();
        await this.loaded;
        const err = await new Promise<string | undefined>((resolve) => {
          const t = setTimeout(() => resolve('De microfoon reageerde niet'), 8000);
          this.waiters.started = (e) => {
            clearTimeout(t);
            this.waiters.started = undefined;
            resolve(e);
          };
          this.send('start');
        });
        if (err) {
          this.session?.cancel();
          this.session = null;
          throw new Error(err);
        }
      },
      stop: async () => {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 2000);
          this.waiters.stopped = () => {
            clearTimeout(t);
            this.waiters.stopped = undefined;
            resolve();
          };
          this.send('stop');
        });
        const s = this.session;
        this.session = null;
        this.onText = this.onLevel = null;
        if (!s) return '';
        return (await s.end()).text;
      },
      cancel: () => {
        this.send('cancel');
        this.waiters.started?.('geannuleerd');
        this.session?.cancel();
        this.session = null;
        this.onText = this.onLevel = null;
      },
    };
  }

  // ---------------- where the text goes ----------------

  /** Polls the helper until the main key of the combination is up. */
  private watchRelease(onRelease: () => void): () => void {
    let done = false;
    const vk = this.key.vk;
    const loop = async () => {
      while (!done) {
        let held = false;
        try {
          held = await this.helper!.held(vk);
        } catch {
          held = false; // helper not (yet) running: treat as released (tap = hands-free)
        }
        if (done) return;
        if (!held) {
          done = true;
          return onRelease();
        }
        await new Promise((r) => setTimeout(r, 30));
      }
    };
    void loop();
    return () => {
      done = true;
    };
  }

  /**
   * A TeamBot window of our own has the focus: ask the page itself whether the focused field is a password field
   * (exact, also where accessibility is off). null = not our window.
   */
  private async ownPasswordFocus(): Promise<boolean | null> {
    const w = BrowserWindow.getFocusedWindow();
    if (!w || w.isDestroyed() || w === this.overlay) return null;
    try {
      return !!(await w.webContents.executeJavaScript(
        `(() => { let a = document.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
          return !!a && a.tagName === 'INPUT' && (a.type === 'password' || /password/i.test(a.autocomplete || '')); })()`,
        true,
      ));
    } catch {
      return null;
    }
  }

  private target(): Target {
    return {
      probe: async () => {
        if (!this.helper) return null;
        const p = await this.helper.call('probe', {}, 3000);
        const own = p?.pid === process.pid ? await this.ownPasswordFocus() : null;
        return { password: !!p?.password || !!own, blocked: p?.blocked ? 'Windows-beveiligingsvenster: dicteren staat hier uit.' : null };
      },
      insert: (text: string): Promise<InsertResult> => insertText(text, this.insertDeps()),
    };
  }

  private insertDeps(): InsertDeps {
    const keys = [this.key.vk];
    const guard = async () => ((await this.ownPasswordFocus()) ? { ok: false, code: 'password', error: 'Wachtwoordveld.' } : null);
    return {
      clipboard: electronClipboard(),
      keys: this.helper
        ? {
            paste: async (o) => (await guard()) || this.helper!.call('paste', { keys, expectPid: o.expectPid || this.o.expectPid || 0 }, 8000),
            type: async (text, o) => (await guard()) || this.helper!.call('type', { text, keys, expectPid: o.expectPid || this.o.expectPid || 0 }, 30_000),
          }
        : null,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      expectPid: this.o.expectPid,
    };
  }
}

/** Electron's clipboard as the insert step needs it, kept out of clipboard history (see dictation-clipboard.ts). */
export function electronClipboard(): InsertDeps['clipboard'] {
  return dictationClipboard(electronClipboardApi, ClipboardItem);
}

let instance: DictationHotkey | null = null;

/** The one call the desktop shell makes (after the server started). Returns the instance (stop it on quit). */
export function startDictationHotkey(o: Omit<DictationOptions, 'helperDir'> & { helperDir?: string; userData: string }): DictationHotkey {
  instance?.stop();
  instance = new DictationHotkey({ ...o, helperDir: o.helperDir || path.join(o.userData, 'dictation') });
  instance.start();
  return instance;
}

