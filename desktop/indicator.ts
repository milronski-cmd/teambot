/**
 * On-screen indicator + global emergency stop for computer use on this desktop.
 *
 * While a bot controls the PC (or waits because the owner took over) a click-through, always-on-top overlay draws a
 * coloured rim around the monitor the bot works on plus a small pill with the bot's name and the stop hotkey. The
 * overlay never takes focus, lets every click through and is excluded from screen capture (setContentProtection),
 * so the bot's own screenshots never contain it. The global hotkey stops all desktop control immediately (the
 * screen helper is killed mid-action) and pauses it until the owner resumes in TeamBot.
 */
import { BrowserWindow, Notification, globalShortcut, screen } from 'electron';

export interface DesktopApi {
  state(): any;
  onState(fn: (s: any) => void): () => void;
  stop(source?: string): { cancelled: number; agents: number };
  giveBack(agentId: string): boolean;
  setHotkey(label: string | null): void;
}

const HOTKEYS = [
  { accel: 'Control+Alt+Escape', label: 'Ctrl+Alt+Esc' },
  { accel: 'Control+Alt+Shift+S', label: 'Ctrl+Alt+Shift+S' },
  { accel: 'Control+Alt+F12', label: 'Ctrl+Alt+F12' },
];

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;font-family:"Segoe UI",system-ui,sans-serif;user-select:none}
#rim{position:fixed;inset:0;border:4px solid #f97316;border-radius:4px;box-shadow:inset 0 0 22px rgba(249,115,22,.45)}
#pill{position:fixed;top:12px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px;max-width:90vw;
  background:rgba(18,18,22,.9);color:#fff;padding:7px 16px;border-radius:999px;font-size:13px;line-height:18px;
  box-shadow:0 6px 24px rgba(0,0,0,.35);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#dot{flex:none;width:9px;height:9px;border-radius:50%;background:#f97316;animation:pulse 1.2s ease-in-out infinite}
#what{opacity:.85;overflow:hidden;text-overflow:ellipsis}
#hint{opacity:.65}
body.paused #rim{border-color:#3b82f6;box-shadow:inset 0 0 22px rgba(59,130,246,.4)}
body.paused #dot{background:#3b82f6;animation:none}
@keyframes pulse{50%{opacity:.3}}
@media (prefers-reduced-motion:reduce){#dot{animation:none}}
</style></head><body><div id="rim"></div><div id="pill" role="status" aria-live="polite"><span id="dot"></span><b id="who"></b><span id="what"></span><span id="hint"></span></div>
<script>
window.tbState = function (s) {
  document.body.className = s.paused ? 'paused' : '';
  document.getElementById('who').textContent = s.title || '';
  document.getElementById('what').textContent = s.detail || '';
  document.getElementById('hint').textContent = s.hint || '';
};
</script></body></html>`;

export class DesktopIndicator {
  private win: BrowserWindow | null = null;
  private off: (() => void) | null = null;
  private ready: Promise<void> | null = null;
  state: any = null;
  hotkey: string | null = null;

  constructor(
    private api: () => DesktopApi | null,
    private onChange: () => void = () => {},
  ) {}

  start() {
    const d = this.api();
    if (!d) return;
    for (const k of HOTKEYS) {
      try {
        if (globalShortcut.register(k.accel, () => this.emergencyStop('sneltoets'))) {
          this.hotkey = k.label;
          break;
        }
      } catch {
        /* taken by another app: try the next one */
      }
    }
    d.setHotkey(this.hotkey);
    this.off = d.onState((s) => this.update(s));
  }

  stop() {
    this.off?.();
    this.off = null;
    globalShortcut.unregisterAll();
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  emergencyStop(source: string) {
    const d = this.api();
    if (!d) return;
    const r = d.stop(source);
    if (Notification.isSupported())
      new Notification({
        title: 'TeamBot: noodstop',
        body: r.agents ? 'Bureaubladbediening is direct gestopt en gepauzeerd. Hervat in TeamBot › Computer als een bot verder mag.' : 'Er was geen bot op je bureaublad bezig.',
      }).show();
  }

  giveBack() {
    const s = this.state;
    const d = this.api();
    if (d && s?.agentId) d.giveBack(s.agentId);
  }

  private ensure(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const w = new BrowserWindow({
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
      title: 'TeamBot-indicator',
      backgroundColor: '#00000000',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true, spellcheck: false },
    });
    w.setIgnoreMouseEvents(true);
    w.setAlwaysOnTop(true, 'screen-saver');
    // never part of a screenshot: the bot must see the real screen, not the indicator
    w.setContentProtection(true);
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    this.ready = w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML)).catch(() => {});
    this.win = w;
    return w;
  }

  private bounds(m: { x: number; y: number; w: number; h: number } | null) {
    if (m && process.platform === 'win32' && typeof (screen as any).screenToDipRect === 'function') {
      try {
        return (screen as any).screenToDipRect(null, { x: m.x, y: m.y, width: m.w, height: m.h });
      } catch {
        /* fall back to the primary display */
      }
    }
    if (m) {
      const d = screen.getDisplayNearestPoint({ x: m.x + Math.round(m.w / 2), y: m.y + Math.round(m.h / 2) });
      return d.bounds;
    }
    return screen.getPrimaryDisplay().bounds;
  }

  private async update(s: any) {
    this.state = s;
    this.onChange();
    const show = !!(s && (s.active || s.paused));
    if (!show) {
      if (this.win && !this.win.isDestroyed()) this.win.hide();
      return;
    }
    const w = this.ensure();
    w.setBounds(this.bounds(s.monitor));
    await this.ready;
    const view = s.paused
      ? { paused: true, title: `${s.agentName || 'Bot'} wacht`, detail: 'jij hebt de bediening', hint: '· geef terug in TeamBot' }
      : { paused: false, title: `${s.agentName || 'Een bot'} bedient je computer`, detail: s.lastAction ? `· ${String(s.lastAction).slice(0, 70)}` : '', hint: `· muis bewegen = pauze${s.hotkey ? ` · noodstop ${s.hotkey}` : ''}` };
    if (w.isDestroyed()) return;
    await w.webContents.executeJavaScript(`window.tbState(${JSON.stringify(view)})`).catch(() => {});
    if (!w.isVisible()) w.showInactive();
  }
}
