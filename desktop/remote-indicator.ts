/**
 * On-screen indicator for "Bureaublad op afstand" (server/modules/remote-desktop): while anyone watches or controls
 * this computer from a phone or another PC, a small always-on-top bar at the top of the main screen says who, with
 * one "Stop" button. Stop ends every session and switches remote desktop off (switching it on again is only possible
 * at the computer itself), so a lost phone can be cut off with one click.
 *
 * The bar never takes focus (it shows inactive and does not steal the keyboard from the owner), is not part of any
 * screen capture (setContentProtection) and belongs to TeamBot, whose windows the screen driver never lets remote
 * input reach: from a distance it can be neither clicked away nor hidden. Without this indicator the server refuses
 * remote desktop altogether (attachIndicator).
 */
import { BrowserWindow, Notification, screen } from 'electron';
import { indicatorView, type IndicatorSession } from '../server/modules/remote-desktop/indicator.js';

export interface RemoteDesktopApi {
  attachIndicator(): () => void;
  onState(fn: (s: { sessions: IndicatorSession[]; enabled: boolean }) => void): () => void;
  stopFromComputer(source?: string): { ended: number; wasOn: boolean };
  active(): boolean;
}

const WIDTH = 520;
const HEIGHT = 56;
/** The page sets this title when Stop is clicked (no preload / IPC needed for one button). */
const STOP_TITLE = 'teambot-remote-stop';

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>TeamBot</title><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;font-family:"Segoe UI",system-ui,sans-serif;user-select:none}
#bar{position:fixed;inset:4px;display:flex;align-items:center;gap:12px;padding:0 8px 0 16px;border-radius:999px;
  background:#1b1214;color:#fff;border:2px solid #ef4444;box-shadow:0 6px 24px rgba(0,0,0,.45)}
#dot{flex:none;width:10px;height:10px;border-radius:50%;background:#ef4444;animation:pulse 1.2s ease-in-out infinite}
#txt{flex:1;min-width:0;line-height:17px}
#who{display:block;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#what{display:block;font-size:12px;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#stop{flex:none;height:36px;padding:0 18px;border:0;border-radius:999px;background:#ef4444;color:#fff;font:600 14px "Segoe UI",system-ui,sans-serif;cursor:pointer}
#stop:hover{background:#dc2626}
#stop:focus-visible{outline:2px solid #fff;outline-offset:2px}
@keyframes pulse{50%{opacity:.3}}
@media (prefers-reduced-motion:reduce){#dot{animation:none}}
</style></head><body><div id="bar" role="status" aria-live="polite"><span id="dot" aria-hidden="true"></span><span id="txt"><b id="who"></b><span id="what"></span></span><button id="stop" type="button"></button></div>
<script>
window.tbView = function (v) {
  document.getElementById('who').textContent = v.title || '';
  document.getElementById('what').textContent = v.detail || '';
  var b = document.getElementById('stop');
  b.textContent = v.stop || 'Stop';
  b.setAttribute('aria-label', v.label || v.stop || 'Stop');
};
document.getElementById('stop').addEventListener('click', function () { document.title = '${STOP_TITLE}:' + Date.now(); });
</script></body></html>`;

export class RemoteIndicator {
  private win: BrowserWindow | null = null;
  private ready: Promise<void> | null = null;
  private off: (() => void) | null = null;
  private detach: (() => void) | null = null;
  private last = 0;
  /** Sessions right now (for the tray item). */
  count = 0;

  constructor(
    private api: () => RemoteDesktopApi | null,
    private lang: () => string,
    private onChange: () => void = () => {},
    private say: (text: string, ...v: (string | number)[]) => string = (t) => t,
  ) {}

  start() {
    const d = this.api();
    if (!d) return;
    this.detach = d.attachIndicator();
    this.off = d.onState((s) => void this.update(s.sessions));
  }

  stop() {
    this.off?.();
    this.off = null;
    this.detach?.();
    this.detach = null;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  /** Stop button, tray item and the emergency-stop hotkey all end here. */
  stopNow(source: string) {
    const d = this.api();
    if (!d) return;
    const r = d.stopFromComputer(source);
    if ((r.ended || r.wasOn) && Notification.isSupported())
      new Notification({ title: this.say('Bureaublad op afstand gestopt'), body: this.say('Niemand kijkt nog mee en het staat uit. Aanzetten kan alleen weer op deze computer (Instellingen › Bestanden en computers › Bureaublad op afstand).') }).show();
  }

  private ensure(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const w = new BrowserWindow({
      show: false,
      width: WIDTH,
      height: HEIGHT,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      // clicks still arrive (WS_EX_NOACTIVATE): the owner's typing is never interrupted
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      title: 'TeamBot — bureaublad op afstand',
      backgroundColor: '#00000000',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true, spellcheck: false },
    });
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setContentProtection(true);
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    w.on('page-title-updated', (e, title) => {
      e.preventDefault();
      if (!title.startsWith(STOP_TITLE + ':') || Date.now() - this.last < 800) return;
      this.last = Date.now();
      this.stopNow('stopknop');
    });
    this.ready = w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML)).catch(() => {});
    this.win = w;
    return w;
  }

  private async update(sessions: IndicatorSession[]) {
    const first = sessions.length > 0 && this.count === 0;
    const changed = sessions.length !== this.count;
    this.count = sessions.length;
    if (changed) this.onChange();
    const view = indicatorView(sessions, this.lang());
    if (!view) {
      if (this.win && !this.win.isDestroyed()) this.win.hide();
      return;
    }
    const w = this.ensure();
    const wa = screen.getPrimaryDisplay().workArea;
    w.setBounds({ x: Math.round(wa.x + (wa.width - WIDTH) / 2), y: wa.y + 8, width: WIDTH, height: HEIGHT });
    await this.ready;
    if (w.isDestroyed()) return;
    await w.webContents.executeJavaScript(`window.tbView(${JSON.stringify(view)})`).catch(() => {});
    if (!w.isVisible()) w.showInactive();
    if (first && Notification.isSupported()) new Notification({ title: view.title, body: this.say('Bureaublad op afstand. Klik op Stop bovenaan het scherm om het direct te beëindigen.') }).show();
  }
}
